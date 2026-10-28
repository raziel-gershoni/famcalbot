// Smoke test for the one Google retry policy (src/services/google-retry.ts): what it retries,
// how long it waits, what it hands up, and the rules it is built on (retryAfterMs and the
// split rate-limit sets in calendar-read/google-map.ts).
//
// The real getGoogleAuth (calendar.ts), @googleapis/calendar, its google-auth-library and
// gaxios run. Only gaxios's HTTP adapter is replaced, by a fake that answers with a scripted
// status, body and headers (or fails like the network). The policy's sleep and dice are the
// test seam (__useGoogleRetryForTests), so no real time passes except in the checks that
// measure it. Redis, the database and error capture are faked. globalThis.fetch is blocked
// except inside the googleFetch checks, which fake it. No network.
//
// Run under both clocks; the output must not depend on the server's timezone:
//   TZ=UTC npx tsx scripts/smoke-google-retry.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-google-retry.ts

import Module, { createRequire } from 'node:module';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];
/** A promise nobody settles ends the process with no output and code 0; this turns that into a failure. */
let finished = false;
process.on('exit', () => {
  if (!finished) {
    console.error('FAIL  the smoke ended before its checks did (a promise that never settles)');
    process.exitCode = 1;
  }
});

async function check(name: string, fn: () => Promise<void>) {
  try {
    resetSeam();
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  } finally {
    restoreFetch();
  }
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

const show = (v: unknown) => JSON.stringify(v);

function assertEq(got: unknown, want: unknown, what: string) {
  assert(show(got) === show(want), `${what}\n     got  ${show(got)}\n     want ${show(want)}`);
}

// ---- Nothing reaches the network ----

const networkAttempts: string[] = [];
const blockedFetch = (async (input: unknown) => {
  networkAttempts.push(String(input));
  throw new Error('network is blocked in this smoke test');
}) as typeof fetch;
globalThis.fetch = blockedFetch;
function restoreFetch() {
  globalThis.fetch = blockedFetch;
}

// ---- The fake Google: gaxios's HTTP adapter, replaced ----

type GaxiosOpts = Record<string, unknown> & { url?: unknown; method?: unknown; signal?: AbortSignal };

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const calendarRequire = createRequire(require.resolve('@googleapis/calendar'));
const gaxiosModule = calendarRequire('gaxios') as {
  Gaxios: { prototype: { _defaultAdapter: (this: unknown, opts: GaxiosOpts) => Promise<unknown> } };
};
const nodeFetch = createRequire(calendarRequire.resolve('gaxios'))('node-fetch') as {
  FetchError: new (message: string, type: string, systemError?: { code: string }) => Error;
};

type Answer = { status: number; data?: unknown; headers?: Record<string, string> } | { network: string };
type Call = { method: string; url: string; token: boolean };

let calls: Call[] = [];
/** The Calendar API's answers, one per request in order; the last repeats. */
let apiScript: Answer[] = [];
/** The token endpoint's. */
let tokenScript: Answer[] = [];
/** When set, answers a Calendar API request itself (by URL); undefined falls through to the script. */
let apiRoute: ((url: string) => Answer | undefined) | null = null;
let runaway = false;
/** More requests than any policy should send: the fake then answers a 400 nobody retries, and the check fails on `runaway`. */
const RUNAWAY_AT = 30;

const TOKEN_OK: Answer = { status: 200, data: { access_token: 'fake-access-SECRET', expires_in: 3600, token_type: 'Bearer' } };
const OK: Answer = { status: 200, data: { id: 'e1', summary: 'Zebra review', items: [] } };
const apiBody = (code: number, reason: string, message = reason) => ({ error: { code, message, errors: [{ domain: 'global', reason, message }] } });
const fail = (status: number, reason: string, headers: Record<string, string> = {}): Answer => ({ status, data: apiBody(status, reason), headers });
const retryAfter = (status: number, reason: string, value: string): Answer => fail(status, reason, { 'retry-after': value });

function installFakeGoogle(): void {
  const authGaxios = createRequire(calendarRequire.resolve('google-auth-library'))('gaxios');
  const commonGaxios = createRequire(calendarRequire.resolve('googleapis-common'))('gaxios');
  if (authGaxios !== gaxiosModule || commonGaxios !== gaxiosModule) {
    console.error('FAIL  the Google client loads more than one gaxios; refusing to run without the fake');
    process.exit(1);
  }
  gaxiosModule.Gaxios.prototype._defaultAdapter = async function (opts: GaxiosOpts) {
    const url = String(opts.url);
    const token = url === TOKEN_URL;
    if (!token && !url.startsWith('https://www.googleapis.com/calendar/v3/')) throw new Error(`unexpected request ${url}`);
    calls.push({ method: String(opts.method ?? 'GET').toUpperCase(), url, token });
    if (calls.length > RUNAWAY_AT) {
      runaway = true;
      return { config: opts, data: apiBody(400, 'runaway'), headers: {}, status: 400, statusText: '400', request: { responseURL: url } };
    }
    const script = token ? tokenScript : apiScript;
    const nth = calls.filter((c) => c.token === token).length - 1;
    const answer = (!token && apiRoute?.(decodeURIComponent(url))) || script[Math.min(nth, script.length - 1)];
    if ('network' in answer) {
      throw new nodeFetch.FetchError(`request to ${url} failed, reason: ${answer.network}`, 'system', { code: answer.network });
    }
    return { config: opts, data: answer.data ?? {}, headers: answer.headers ?? {}, status: answer.status, statusText: String(answer.status), request: { responseURL: url } };
  };
}

const apiCalls = () => calls.filter((c) => !c.token);
const tokenCalls = () => calls.filter((c) => c.token);

// ---- The policy's seam: no real sleeping, dice that always roll the middle ----

type SeamModule = typeof import('../src/services/google-retry');
let retryMod: SeamModule;
let sleeps: number[] = [];
/** A fixed "now" for HTTP-date and deadline checks. */
const NOW = Date.parse('2026-10-28T12:00:00Z');

function resetSeam() {
  calls = [];
  apiScript = [OK];
  tokenScript = [TOKEN_OK];
  apiRoute = null;
  runaway = false;
  sleeps = [];
  warnings.length = 0;
  retryMod.__useGoogleRetryForTests({
    random: () => 0.5,
    now: () => NOW,
    sleep: async (ms, signal) => {
      if (signal?.aborted) throw Object.assign(new Error('The user aborted a request.'), { name: 'AbortError', type: 'aborted' });
      sleeps.push(ms);
    },
  });
}

/** Full jitter at a roll of 0.5: 250 ms, 500, 1000. */
const JITTER = [250, 500, 1000];

const warnings: string[] = [];
const realWarn = console.warn;
const realError = console.error;
const lineOf = (args: unknown[]) => args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.message : show(a))).join(' ');
console.warn = (...args: unknown[]) => {
  warnings.push(lineOf(args));
};
// The callers' own failure logs (fetchEventsInRange prints Google's error objects) stay out of the output.
console.error = (...args: unknown[]) => {
  warnings.push(`(error) ${lineOf(args)}`);
};

const captured: string[] = [];

// ---- Fixtures ----

type Outcome = { ok: true; value: unknown } | { ok: false; error: Error & { status?: number; code?: unknown; response?: { status?: number; headers?: Record<string, string> } } };
async function outcome(run: () => Promise<unknown>): Promise<Outcome> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, error: error as Extract<Outcome, { ok: false }>['error'] };
  }
}

const pendingTimers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;

async function main() {
  installFakeGoogle();

  const SRC = path.resolve(__dirname, '../src');
  const cache = (Module as unknown as { _cache: Record<string, unknown> })._cache;
  const stub = (file: string, exports: Record<string, unknown>) => {
    const filename = path.join(SRC, file);
    const mod = new Module(filename);
    Object.assign(mod, { filename, loaded: true, exports });
    cache[filename] = mod;
  };
  stub('lib/error-capture.ts', {
    captureError: (error: unknown, context: string, _extra?: unknown, severity = 'error') => {
      captured.push(`${context} ${severity} ${error instanceof Error ? error.message : String(error)}`);
    },
    captureWarning: (message: string, context: string) => {
      captured.push(`${context} warning ${message}`);
    },
    captureInfo: () => {},
  });
  stub('utils/redis.ts', { redis: { get: async () => null, set: async () => 'OK', del: async () => 0, mget: async () => [] } });
  stub('utils/prisma.ts', { prisma: { googleSyncLink: { findMany: async () => [] } } });

  retryMod = await import('../src/services/google-retry');
  const { googleCalendarAuth, calendarModule } = await (async () => {
    const calendarModule = await import('../src/services/calendar');
    const { calendar: googleCalendar } = await import('@googleapis/calendar');
    return {
      calendarModule,
      googleCalendarAuth: (token = 'refresh-1', transport?: { timeout: number; signal: AbortSignal; deadlineAt?: number }) =>
        googleCalendar({ version: 'v3', auth: calendarModule.getGoogleAuth(token, transport) }),
    };
  })();
  const map = await import('../src/services/calendar-read/google-map');
  const errorsModule = await import('../src/utils/errors');
  const { googleAccountOf } = await import('../src/services/google-sync/account');

  const cal = () => googleCalendarAuth();
  const ids = { calendarId: 'family@group.calendar.google.com', eventId: 'e1' };
  const body = { summary: 'Zebra review' };
  /** The Calendar calls by HTTP method: what a retry may repeat, and what it may not. */
  const verbs = {
    GET: () => cal().events.get(ids),
    PUT: () => cal().events.update({ ...ids, requestBody: body }),
    PATCH: () => cal().events.patch({ ...ids, requestBody: body }),
    DELETE: () => cal().events.delete(ids),
    'POST events.insert': () => cal().events.insert({ calendarId: ids.calendarId, requestBody: body }),
    'POST calendars.insert': () => cal().calendars.insert({ requestBody: body }),
    'POST events.move': () => cal().events.move({ ...ids, destination: 'other@group.calendar.google.com' }),
  } as const;
  type Verb = keyof typeof verbs;
  const creates: Verb[] = ['POST events.insert', 'POST calendars.insert', 'POST events.move'];
  const others: Verb[] = ['GET', 'PUT', 'PATCH', 'DELETE'];

  // ---- The rules: retryAfterMs, the split sets ----

  await check('retryAfterMs: delta-seconds and HTTP-dates (counted from now, never below 0), plain headers in any key case or a Headers; garbage and no response are undefined', async () => {
    const withHeader = (value: unknown, key = 'retry-after') => ({ response: { status: 429, headers: { [key]: value } } });
    assertEq(map.retryAfterMs(withHeader('3'), NOW), 3000, 'delta-seconds');
    assertEq(map.retryAfterMs(withHeader('0'), NOW), 0, 'zero');
    assertEq(map.retryAfterMs(withHeader(' 120 '), NOW), 120_000, 'padded');
    assertEq(map.retryAfterMs(withHeader('Wed, 28 Oct 2026 12:00:02 GMT'), NOW), 2000, 'IMF-fixdate');
    assertEq(map.retryAfterMs(withHeader('Wednesday, 28-Oct-26 12:00:05 GMT'), NOW), 5000, 'RFC 850');
    assertEq(map.retryAfterMs(withHeader('Wed, 28 Oct 2026 11:59:00 GMT'), NOW), 0, 'a date in the past');
    assertEq(map.retryAfterMs(withHeader('7', 'Retry-After'), NOW), 7000, 'key case');
    assertEq(map.retryAfterMs({ response: { headers: new Headers({ 'Retry-After': '4' }) } }, NOW), 4000, 'a Headers');
    assertEq(map.retryAfterMs(withHeader(['6', '9']), NOW), 6000, 'an array takes the first');
    for (const garbage of ['soon', '-5', '1.5', '', '5 seconds', 'Wed Oct 28 12:00:02 2026', 'Wed, 99 Zzz 2026 12:00:02 GMT', 'foo, bar GMT']) {
      assertEq(map.retryAfterMs(withHeader(garbage), NOW), undefined, `garbage ${show(garbage)}`);
    }
    assertEq([map.retryAfterMs(null), map.retryAfterMs('x'), map.retryAfterMs(new Error('boom')), map.retryAfterMs({ response: {} }), map.retryAfterMs({ response: { headers: null } })], [undefined, undefined, undefined, undefined, undefined], 'no headers');
  });

  await check('the split sets: rateLimitExceeded and userRateLimitExceeded are brief, quotaExceeded and dailyLimitExceeded are quota (also on a 429); isGoogleRateLimit still covers all four; classifyGoogleError still says transient', async () => {
    const e = (status: number, reason?: string) => ({ response: { status, data: reason ? apiBody(status, reason) : {} } });
    assertEq([...map.BRIEF_RATE_LIMIT_REASONS], ['rateLimitExceeded', 'userRateLimitExceeded'], 'brief set');
    assertEq([...map.LONG_QUOTA_REASONS], ['quotaExceeded', 'dailyLimitExceeded'], 'quota set');
    assertEq(
      [e(429), e(429, 'rateLimitExceeded'), e(403, 'rateLimitExceeded'), e(403, 'userRateLimitExceeded'), e(403, 'quotaExceeded'), e(403, 'dailyLimitExceeded'), e(429, 'dailyLimitExceeded'), e(403, 'forbidden'), e(503), e(404)].map((x) => map.googleRateLimitKind(x)),
      ['brief', 'brief', 'brief', 'brief', 'quota', 'quota', 'quota', null, null, null],
      'kind',
    );
    for (const reason of ['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded', 'dailyLimitExceeded']) {
      assert(map.isGoogleRateLimit(e(403, reason)) && map.classifyGoogleError(e(403, reason)) === 'transient', `${reason}`);
    }
  });

  await check('isTokenError is gone; a 403 rate limit is transient while a 401 and invalid_grant are token (the one table)', async () => {
    assert(!('isTokenError' in errorsModule), 'utils/errors.ts still exports isTokenError');
    const rate = { response: { status: 403, data: apiBody(403, 'rateLimitExceeded') } };
    assertEq([map.classifyGoogleError(rate), map.classifyGoogleError({ response: { status: 401, data: {} } }), map.classifyGoogleError({ response: { status: 400, data: { error: 'invalid_grant' } } })], ['transient', 'token', 'token'], 'classes');
  });

  // ---- The transport: GET ----

  await check('GET 429 is retried 3 times, then thrown: 4 requests, each wait the larger of Retry-After and the jitter (250, 500, 1000 ms without one)', async () => {
    apiScript = [fail(429, 'rateLimitExceeded')];
    const r = await outcome(verbs.GET);
    assert(!r.ok && r.error.response?.status === 429, `outcome ${show(r.ok)}`);
    assertEq([apiCalls().length, sleeps, runaway], [4, JITTER, false], 'requests, waits, runaway');
    resetSeam();
    apiScript = [retryAfter(429, 'rateLimitExceeded', '1')];
    await outcome(verbs.GET);
    assertEq([apiCalls().length, sleeps], [4, [1000, 1000, 1000]], 'Retry-After 1 against the jitter');
    resetSeam();
    apiScript = [retryAfter(429, 'rateLimitExceeded', '1'), retryAfter(429, 'rateLimitExceeded', '0'), OK];
    const third = await outcome(verbs.GET);
    assertEq([third.ok, apiCalls().length, sleeps], [true, 3, [1000, 500]], 'the second wait is the jitter when Retry-After is smaller');
  });

  await check('Retry-After as an HTTP-date is waited for; garbage is ignored (the jitter is used)', async () => {
    apiScript = [retryAfter(429, 'rateLimitExceeded', 'Wed, 28 Oct 2026 12:00:03 GMT'), OK];
    await outcome(verbs.GET);
    assertEq(sleeps, [3000], 'HTTP-date');
    resetSeam();
    apiScript = [retryAfter(429, 'rateLimitExceeded', 'soon'), OK];
    await outcome(verbs.GET);
    assertEq(sleeps, [250], 'garbage');
  });

  await check('a real GET 429 with Retry-After 2 waits about 2 s (the real sleep, measured), then succeeds', async () => {
    retryMod.__useGoogleRetryForTests({ random: () => 0.5 });
    apiScript = [retryAfter(429, 'rateLimitExceeded', '2'), OK];
    const before = performance.now();
    const r = await outcome(verbs.GET);
    const took = performance.now() - before;
    assert(r.ok && apiCalls().length === 2, `outcome ${show(r.ok)} requests ${apiCalls().length}`);
    assert(took >= 1900 && took < 3200, `waited ${Math.round(took)} ms`);
  });

  // ---- The transport: which answers are retried, for which verbs ----

  await check('403 userRateLimitExceeded and rateLimitExceeded are retried for GET, PUT, PATCH, DELETE and every create: 4 requests each', async () => {
    for (const verb of [...others, ...creates]) {
      for (const reason of ['userRateLimitExceeded', 'rateLimitExceeded']) {
        resetSeam();
        apiScript = [fail(403, reason)];
        const r = await outcome(verbs[verb]);
        assert(!r.ok && r.error.response?.status === 403, `${verb} ${reason}: ${show(r.ok)}`);
        assertEq([apiCalls().length, sleeps.length], [4, 3], `${verb} ${reason}`);
      }
    }
  });

  await check('403 dailyLimitExceeded, quotaExceeded, insufficientPermissions and a plain forbidden make exactly 1 request and no sleep; 401, 404 and 400 as well', async () => {
    for (const answer of [fail(403, 'dailyLimitExceeded'), fail(403, 'quotaExceeded'), fail(429, 'dailyLimitExceeded'), fail(403, 'insufficientPermissions'), fail(403, 'forbidden'), fail(401, 'authError'), fail(404, 'notFound'), fail(400, 'badRequest')]) {
      for (const verb of ['GET', 'PATCH', 'POST events.insert'] as Verb[]) {
        resetSeam();
        apiScript = [answer];
        const r = await outcome(verbs[verb]);
        assert(!r.ok, `${verb} ${show(answer)} did not fail`);
        assertEq([apiCalls().length, sleeps.length], [1, 0], `${verb} ${show((answer as { data: unknown }).data)}`);
      }
    }
  });

  await check('a create (events.insert, calendars.insert, events.move) on 503 or 500 makes 1 request, but on 429 it is retried; 408 on a create is not', async () => {
    for (const verb of creates) {
      for (const status of [500, 503, 408]) {
        resetSeam();
        apiScript = [fail(status, 'backendError')];
        await outcome(verbs[verb]);
        assertEq([apiCalls().length, sleeps.length], [1, 0], `${verb} ${status}`);
      }
      resetSeam();
      apiScript = [fail(429, 'rateLimitExceeded'), OK];
      const r = await outcome(verbs[verb]);
      assertEq([r.ok, apiCalls().length], [true, 2], `${verb} 429 then ok`);
    }
  });

  await check('GET, PUT, PATCH and DELETE on 5xx and 408 are retried (4 requests); one failure then success returns the success', async () => {
    for (const verb of others) {
      for (const status of [500, 502, 503, 504, 408]) {
        resetSeam();
        apiScript = [fail(status, 'backendError')];
        await outcome(verbs[verb]);
        assertEq([apiCalls().length, sleeps.length], [4, 3], `${verb} ${status}`);
      }
      resetSeam();
      apiScript = [fail(503, 'backendError'), OK];
      const r = await outcome(verbs[verb]);
      assertEq([r.ok, apiCalls().length, sleeps], [true, 2, [250]], `${verb} 503 then ok`);
    }
  });

  await check('a request that gets no answer (ECONNRESET) is retried twice for GET and PATCH, never for a create; the reader\'s noResponseRetries 0 turns it off', async () => {
    apiScript = [{ network: 'ECONNRESET' }];
    await outcome(verbs.GET);
    assertEq([apiCalls().length, sleeps.length], [3, 2], 'GET');
    resetSeam();
    apiScript = [{ network: 'ECONNRESET' }];
    await outcome(verbs.PATCH);
    assertEq([apiCalls().length, sleeps.length], [3, 2], 'PATCH');
    for (const verb of creates) {
      resetSeam();
      apiScript = [{ network: 'ECONNRESET' }];
      await outcome(verbs[verb]);
      assertEq([apiCalls().length, sleeps.length], [1, 0], verb);
    }
    resetSeam();
    apiScript = [{ network: 'ETIMEDOUT' }];
    await outcome(() => cal().events.list({ calendarId: ids.calendarId }, { retryConfig: { retry: 1, noResponseRetries: 0 } }));
    assertEq([apiCalls().length, sleeps.length], [1, 0], 'noResponseRetries 0');
  });

  // ---- The caps ----

  await check('Retry-After above the 10 s cap: 1 request, no sleep, the thrown error is the original and retryAfterMs reads the header; exactly 10 s is waited for', async () => {
    apiScript = [retryAfter(429, 'rateLimitExceeded', '120')];
    const r = await outcome(verbs.GET);
    assert(!r.ok && r.error.response?.status === 429, `outcome ${show(r.ok)}`);
    assertEq([apiCalls().length, sleeps.length, map.retryAfterMs(r.ok ? null : r.error)], [1, 0, 120_000], 'requests, sleeps, retryAfterMs');
    assert(!r.ok && r.error.constructor.name === 'GaxiosError' && map.classifyGoogleError(r.error) === 'transient', 'the original GaxiosError, transient');
    assert(warnings.some((w) => w.includes('[google-retry]') && w.includes('retry-after over the cap') && w.includes('Retry-After 120000 ms')), `log ${show(warnings)}`);
    resetSeam();
    apiScript = [retryAfter(503, 'backendError', '10'), OK];
    const edge = await outcome(verbs.GET);
    assertEq([edge.ok, sleeps], [true, [10_000]], 'exactly 10 s');
    resetSeam();
    apiScript = [retryAfter(503, 'backendError', '11')];
    await outcome(verbs.PATCH);
    assertEq([apiCalls().length, sleeps.length], [1, 0], '11 s on a 503');
  });

  await check('the attempt cap holds inside shouldRetry: an always-failing GET makes 4 requests (not 30), also with a caller\'s retry of 10; a caller\'s retry of 1 makes 2', async () => {
    apiScript = [fail(503, 'backendError')];
    await outcome(verbs.GET);
    assertEq([apiCalls().length, runaway], [4, false], 'default');
    resetSeam();
    apiScript = [fail(503, 'backendError')];
    await outcome(() => cal().events.list({ calendarId: ids.calendarId }, { retryConfig: { retry: 10 } }));
    assertEq([apiCalls().length, runaway], [4, false], 'retry 10');
    resetSeam();
    apiScript = [fail(429, 'rateLimitExceeded')];
    await outcome(() => cal().events.list({ calendarId: ids.calendarId }, { retryConfig: { retry: 1, noResponseRetries: 0 } }));
    assertEq([apiCalls().length, sleeps], [2, [250]], 'the reader\'s retry 1 (the pin of smoke-calendar-read-google.ts)');
    resetSeam();
    apiScript = [fail(429, 'rateLimitExceeded')];
    await outcome(() => cal().events.list({ calendarId: ids.calendarId }, { retryConfig: { retry: 0 } }));
    assertEq(apiCalls().length, 1, 'retry 0');
  });

  await check('a read\'s deadline: no wait runs past deadlineAt (the answer is thrown at once); a wait that fits is slept', async () => {
    const controller = new AbortController();
    const read = (deadlineIn: number) => googleCalendarAuth('refresh-1', { timeout: 5000, signal: controller.signal, deadlineAt: NOW + deadlineIn });
    apiScript = [retryAfter(429, 'rateLimitExceeded', '5'), OK];
    const tooLate = await outcome(() => read(1000).events.get(ids));
    assert(!tooLate.ok, 'a 5 s wait with 1 s left was slept');
    assertEq([apiCalls().length, sleeps.length], [1, 0], 'a 5 s Retry-After with 1 s left');
    assert(warnings.some((w) => w.includes('deadline')), `log ${show(warnings)}`);
    resetSeam();
    apiScript = [fail(429, 'rateLimitExceeded'), OK];
    const fits = await outcome(() => read(1000).events.get(ids));
    assertEq([fits.ok, sleeps], [true, [250]], 'a 250 ms wait with 1 s left');
    resetSeam();
    apiScript = [fail(429, 'rateLimitExceeded')];
    const exactly = await outcome(() => read(250).events.get(ids));
    assertEq([exactly.ok, apiCalls().length], [false, 1], 'a wait that ends at the deadline');
    resetSeam();
    tokenScript = [fail(503, 'backendError'), TOKEN_OK];
    const token = await outcome(() => read(1000).events.get(ids));
    assertEq([token.ok, tokenCalls().length], [true, 2], 'the token step carries the deadline too and retries inside it');
  });

  // ---- The sleep ----

  await check('an aborted signal stops the sleep at once (the real sleep), rejects with an AbortError, and leaves no timer', async () => {
    retryMod.__useGoogleRetryForTests({ random: () => 0.5 });
    apiScript = [retryAfter(429, 'rateLimitExceeded', '5')];
    const controller = new AbortController();
    const client = googleCalendarAuth('refresh-1', { timeout: 30_000, signal: controller.signal });
    const timersBefore = pendingTimers();
    const before = performance.now();
    const pending = outcome(() => client.events.get(ids));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert(pendingTimers() > timersBefore, 'the retry is not sleeping');
    controller.abort();
    const r = await pending;
    const took = performance.now() - before;
    assert(!r.ok && r.error.name === 'AbortError', `outcome ${show(r.ok)} ${r.ok ? '' : r.error.name}`);
    assert(took < 1000, `rejected after ${Math.round(took)} ms (the wait was 5000 ms)`);
    await new Promise((resolve) => setImmediate(resolve));
    assertEq([apiCalls().length, pendingTimers() - timersBefore], [1, 0], 'requests, timers left');
    // Already aborted: the retry does not start a sleep.
    const aborted = AbortSignal.abort();
    const again = await outcome(() => googleCalendarAuth('refresh-1', { timeout: 30_000, signal: aborted }).events.get(ids));
    assert(!again.ok && pendingTimers() - timersBefore === 0, 'an aborted signal left a timer');
  });

  // ---- The token refresh ----

  await check('token refresh: 429 and 503 are retried (a POST to the token endpoint repeats safely); 400 invalid_grant and 401 make 1 request', async () => {
    tokenScript = [retryAfter(429, 'rateLimitExceeded', '2'), TOKEN_OK];
    const a = await outcome(() => googleCalendarAuth().events.get(ids));
    assertEq([a.ok, tokenCalls().length, sleeps], [true, 2, [2000]], '429 with Retry-After');
    resetSeam();
    tokenScript = [fail(503, 'backendError'), fail(503, 'backendError'), TOKEN_OK];
    const b = await outcome(() => googleCalendarAuth().events.get(ids));
    assertEq([b.ok, tokenCalls().length, sleeps], [true, 3, [250, 500]], '503 twice');
    resetSeam();
    tokenScript = [{ status: 400, data: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } }];
    const c = await outcome(() => googleCalendarAuth().events.get(ids));
    assert(!c.ok && map.classifyGoogleError(c.error) === 'token', 'invalid_grant is a dead token');
    assertEq([tokenCalls().length, sleeps.length, apiCalls().length], [1, 0, 0], 'invalid_grant: one request');
    resetSeam();
    tokenScript = [{ status: 401, data: { error: 'invalid_client' } }];
    const d = await outcome(() => googleCalendarAuth().events.get(ids));
    assert(!d.ok, 'a 401 passed');
    assertEq([tokenCalls().length, sleeps.length], [1, 0], '401: one request');
    resetSeam();
    tokenScript = [fail(503, 'backendError')];
    const e = await outcome(() => googleCalendarAuth().events.get(ids));
    assertEq([e.ok, tokenCalls().length], [false, 4], 'the cap holds on the token step');
  });

  // ---- The log line ----

  await check('the retry log line names the request (no query, no ids), the status, the reasons, the attempt, the wait and Retry-After, and never a body, a header or a token', async () => {
    apiScript = [{ status: 429, data: { ...apiBody(429, 'rateLimitExceeded', 'Zebra review quota'), secret: 'BODY-SECRET' }, headers: { 'retry-after': '2', 'set-cookie': 'COOKIE-SECRET', authorization: 'Bearer HEADER-SECRET' } }, OK];
    await outcome(() => cal().events.list({ calendarId: 'someone@example.com', q: 'Zebra review' }));
    const lines = warnings.filter((w) => w.startsWith('[google-retry]'));
    assertEq(lines, ['[google-retry] GET www.googleapis.com/calendar/v3/calendars/:id/events answered 429 (rateLimitExceeded); retry 1 of 3 in 2000 ms (Retry-After 2000 ms)'], 'the line');
    const all = warnings.join('\n');
    for (const secret of ['BODY-SECRET', 'COOKIE-SECRET', 'HEADER-SECRET', 'Zebra', 'someone@example.com', 'fake-access', 'refresh-1']) assert(!all.includes(secret), `the log carries ${secret}`);
    resetSeam();
    apiScript = [{ network: 'ECONNRESET' }, OK];
    await outcome(verbs.GET);
    assert(warnings.some((w) => w.includes('GET www.googleapis.com/calendar/v3/calendars/:id/events/:id got no answer; retry 1 of 3 in 250 ms')), `no-answer line ${show(warnings)}`);
    resetSeam();
    apiScript = [fail(503, 'backendError')];
    await outcome(verbs.GET);
    assert(warnings.some((w) => w.includes('not retried (attempts used) after 3 retries')), `gave-up line ${show(warnings)}`);
  });

  // ---- The callers of the one factory ----

  await check('listUserCalendars uses the one factory: a 429 on calendarList is retried; a 403 rate limit is thrown as it is (transient), never as GOOGLE_TOKEN_EXPIRED; a 401 and invalid_grant are GOOGLE_TOKEN_EXPIRED with the cause', async () => {
    apiScript = [fail(429, 'rateLimitExceeded'), { status: 200, data: { items: [{ id: 'a@example.com', summary: 'A', primary: true, accessRole: 'owner' }] } }];
    const ok = await outcome(() => calendarModule.listUserCalendars('refresh-1', 7));
    assert(ok.ok && (ok.value as { id: string }[])[0]?.id === 'a@example.com' && apiCalls().length === 2, `outcome ${show(ok)}`);
    resetSeam();
    apiScript = [fail(403, 'userRateLimitExceeded')];
    const limit = await outcome(() => calendarModule.listUserCalendars('refresh-1', 7));
    assert(!limit.ok && limit.error.message !== 'GOOGLE_TOKEN_EXPIRED' && map.classifyGoogleError(limit.error) === 'transient', `403 rate limit: ${limit.ok ? 'ok' : limit.error.message}`);
    assertEq(apiCalls().length, 4, '403 rate limit: requests');
    resetSeam();
    apiScript = [fail(401, 'authError')];
    const dead = await outcome(() => calendarModule.listUserCalendars('refresh-1', 7));
    assert(!dead.ok && dead.error.message === 'GOOGLE_TOKEN_EXPIRED' && (dead.error as { cause?: unknown }).cause !== undefined, `401: ${dead.ok ? 'ok' : dead.error.message}`);
    resetSeam();
    tokenScript = [{ status: 400, data: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } }];
    const revoked = await outcome(() => calendarModule.listUserCalendars('refresh-1', 7));
    assert(!revoked.ok && revoked.error.message === 'GOOGLE_TOKEN_EXPIRED', `invalid_grant: ${revoked.ok ? 'ok' : revoked.error.message}`);
    resetSeam();
    apiScript = [fail(403, 'insufficientPermissions')];
    const scopes = await outcome(() => calendarModule.listUserCalendars('refresh-1', 7));
    assert(!scopes.ok && scopes.error.message === 'GOOGLE_INSUFFICIENT_SCOPES', `scopes: ${scopes.ok ? 'ok' : scopes.error.message}`);
  });

  await check('fetchEventsInRange: a 403 rate limit on every calendar is GOOGLE_FETCH_FAILED (not GOOGLE_TOKEN_EXPIRED); a 401 is GOOGLE_TOKEN_EXPIRED; one calendar failing keeps the other\'s events; the failures are captured as warnings', async () => {
    const range = () => calendarModule.fetchEventsInRange('refresh-1', ['c1@example.com', 'c2@example.com'], new Date(NOW), new Date(NOW + 86_400_000));
    apiScript = [fail(403, 'rateLimitExceeded')];
    const limit = await outcome(range);
    assert(!limit.ok && limit.error.message === 'GOOGLE_FETCH_FAILED', `403 rate limit: ${limit.ok ? 'ok' : limit.error.message}`);
    assert(captured.some((c) => c.startsWith('calendar-fetch-range warning')), `captured ${show(captured)}`);
    resetSeam();
    apiScript = [fail(401, 'authError')];
    const dead = await outcome(range);
    assert(!dead.ok && dead.error.message === 'GOOGLE_TOKEN_EXPIRED', `401: ${dead.ok ? 'ok' : dead.error.message}`);
    resetSeam();
    apiScript = [fail(403, 'forbidden')];
    const forbidden = await outcome(range);
    assert(!forbidden.ok && forbidden.error.message === 'GOOGLE_FETCH_FAILED', `a plain 403: ${forbidden.ok ? 'ok' : forbidden.error.message}`);
    resetSeam();
    apiRoute = (url) => {
      if (url.includes('c2@example.com')) return fail(403, 'rateLimitExceeded');
      if (url.includes('/events')) return { status: 200, data: { summary: 'One', items: [{ id: 'x1', summary: 'Kept', start: { dateTime: '2026-10-28T13:00:00Z' }, end: { dateTime: '2026-10-28T14:00:00Z' } }] } };
      return { status: 200, data: { summary: 'One' } };
    };
    const partial = await outcome(range);
    assert(partial.ok && (partial.value as { summary: string }[]).map((e) => e.summary).join() === 'Kept', `partial: ${partial.ok ? show(partial.value) : partial.error.message}`);
  });

  // ---- googleFetch (the raw fetch calls) ----

  const fetches: { url: string; method: string }[] = [];
  /** An answer to build a fresh Response from at each fetch (a Response can be read once). */
  type Spec = { status: number; text: string; headers: Record<string, string> };
  /** Fakes globalThis.fetch with a script of answers (a Spec, or an Error to reject with); the last repeats. */
  const fakeFetch = (script: (Spec | Error)[]) => {
    fetches.length = 0;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      fetches.push({ url: String(input), method: init?.method ?? 'GET' });
      if (fetches.length > RUNAWAY_AT) {
        runaway = true;
        return new Response('{}', { status: 400 });
      }
      const answer = script[Math.min(fetches.length - 1, script.length - 1)];
      if (answer instanceof Error) throw answer;
      return new Response(answer.text, { status: answer.status, headers: answer.headers });
    }) as typeof fetch;
  };
  const respond = (status: number, data: unknown, headers: Record<string, string> = {}): Spec => ({
    status,
    text: typeof data === 'string' ? data : JSON.stringify(data),
    headers: { 'content-type': 'application/json', ...headers },
  });
  const PRIMARY = 'https://www.googleapis.com/calendar/v3/calendars/primary?fields=id';
  const REVOKE = 'https://oauth2.googleapis.com/revoke';

  await check('googleFetch: 429 then 200 succeeds after the wait; the refused answer\'s body is dropped; a 403 rate limit is retried by its reason, quota and a plain forbidden are not', async () => {
    fakeFetch([respond(429, apiBody(429, 'rateLimitExceeded'), { 'retry-after': '1' }), respond(200, { id: 'me@example.com' })]);
    const res = await retryMod.googleFetch(PRIMARY, { headers: { Authorization: 'Bearer secret-access' } });
    assertEq([res.status, (await res.json()).id, fetches.length, sleeps], [200, 'me@example.com', 2, [1000]], 'success after 429');
    for (const [reason, want] of [['rateLimitExceeded', 4], ['userRateLimitExceeded', 4], ['quotaExceeded', 1], ['dailyLimitExceeded', 1], ['forbidden', 1], ['insufficientPermissions', 1]] as const) {
      resetSeam();
      fakeFetch([respond(403, apiBody(403, reason))]);
      const r = await retryMod.googleFetch(PRIMARY);
      assertEq([r.status, fetches.length], [403, want], `403 ${reason}`);
      assertEq((await r.json()).error.errors[0].reason, reason, `${reason}: the returned answer is still readable`);
    }
    resetSeam();
    fakeFetch([respond(403, '<html>not json</html>')]);
    const html = await retryMod.googleFetch(PRIMARY);
    assertEq([html.status, fetches.length], [403, 1], 'a 403 that is not JSON');
    assert(warnings.some((w) => w.includes('with a body that is not JSON')), `logged ${show(warnings)}`);
  });

  await check('googleFetch: GET on 5xx and a lost connection is retried and, when it still fails, returns the last answer or rethrows the same error; Retry-After over the cap is not slept on', async () => {
    fakeFetch([respond(503, 'Service Unavailable')]);
    const res = await retryMod.googleFetch(PRIMARY);
    assertEq([res.status, fetches.length, sleeps], [503, 4, JITTER], '503');
    resetSeam();
    const reset = new TypeError('fetch failed');
    fakeFetch([reset]);
    const thrown = await outcome(() => retryMod.googleFetch(PRIMARY));
    assert(!thrown.ok && thrown.error === reset, 'the same error is rethrown');
    assertEq([fetches.length, sleeps.length], [3, 2], 'a lost connection: 1 + 2 retries');
    resetSeam();
    fakeFetch([respond(429, apiBody(429, 'rateLimitExceeded'), { 'retry-after': '120' })]);
    const long = await retryMod.googleFetch(PRIMARY);
    assertEq([long.status, fetches.length, sleeps.length, map.retryAfterMs({ response: { headers: long.headers } })], [429, 1, 0, 120_000], 'Retry-After 120');
  });

  await check('googleFetch: a POST to the token endpoint (revoke, the code exchange) is retried on 5xx; a POST to the Calendar API only on 429 and the rate-limit 403s', async () => {
    fakeFetch([respond(503, 'down'), respond(200, {})]);
    const revoke = await retryMod.googleFetch(REVOKE, { method: 'POST', body: 'token=x' });
    assertEq([revoke.status, fetches.length, fetches[0].method], [200, 2, 'POST'], 'revoke 503 then ok');
    resetSeam();
    fakeFetch([respond(500, 'down')]);
    const exchange = await retryMod.googleFetch(TOKEN_URL, { method: 'POST', body: '{}' });
    assertEq([exchange.status, fetches.length], [500, 4], 'code exchange stays failed after 3 retries');
    resetSeam();
    fakeFetch([respond(503, 'down')]);
    const create = await retryMod.googleFetch('https://www.googleapis.com/calendar/v3/calendars/c/events', { method: 'POST', body: '{}' });
    assertEq([create.status, fetches.length], [503, 1], 'a Calendar POST on 503');
    resetSeam();
    fakeFetch([respond(429, apiBody(429, 'rateLimitExceeded')), respond(200, {})]);
    const limited = await retryMod.googleFetch('https://www.googleapis.com/calendar/v3/calendars/c/events', { method: 'POST', body: '{}' });
    assertEq([limited.status, fetches.length], [200, 2], 'a Calendar POST on 429');
  });

  await check('googleFetch: the signal ends the sleep at once and leaves no timer', async () => {
    retryMod.__useGoogleRetryForTests({ random: () => 0.5 });
    fakeFetch([respond(429, apiBody(429, 'rateLimitExceeded'), { 'retry-after': '5' })]);
    const controller = new AbortController();
    const timersBefore = pendingTimers();
    const before = performance.now();
    const pending = outcome(() => retryMod.googleFetch(PRIMARY, { signal: controller.signal }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort();
    const r = await pending;
    assert(!r.ok && r.error.name === 'AbortError' && performance.now() - before < 1000, `outcome ${show(r.ok)}`);
    await new Promise((resolve) => setImmediate(resolve));
    assertEq([fetches.length, pendingTimers() - timersBefore], [1, 0], 'requests, timers left');
  });

  await check('googleAccountOf: it goes through googleFetch (a rate limit is retried), and what still fails is thrown with Google\'s headers, so retryAfterMs reads the wait', async () => {
    fakeFetch([respond(429, apiBody(429, 'rateLimitExceeded'), { 'retry-after': '1' }), respond(200, { id: 'me@example.com' })]);
    assertEq(await googleAccountOf('access'), 'me@example.com', 'account after a 429');
    assertEq(fetches.length, 2, 'fetches');
    resetSeam();
    fakeFetch([respond(429, apiBody(429, 'rateLimitExceeded'), { 'retry-after': '300' })]);
    const long = await outcome(() => googleAccountOf('access'));
    assert(!long.ok && long.error.status === 429 && long.error.response?.status === 429, `outcome ${show(long.ok)}`);
    assertEq([fetches.length, map.retryAfterMs(long.ok ? null : long.error), map.googleRateLimitKind(long.ok ? null : long.error)], [1, 300_000, 'brief'], 'one fetch, retryAfterMs, kind');
    resetSeam();
    fakeFetch([respond(403, apiBody(403, 'dailyLimitExceeded'), { 'retry-after': '40' })]);
    const quota = await outcome(() => googleAccountOf('access'));
    assertEq([fetches.length, map.googleRateLimitKind(quota.ok ? null : quota.error), map.retryAfterMs(quota.ok ? null : quota.error)], [1, 'quota', 40_000], 'a quota is not retried');
  });

  await check('nothing reached the network', async () => {
    assertEq(networkAttempts, [], 'network attempts');
  });

  console.warn = realWarn;
  console.error = realError;
  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  finished = true;
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.warn = realWarn;
  console.error = realError;
  console.error(err);
  finished = true;
  process.exit(1);
});

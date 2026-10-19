// Smoke test for what the reader's Google half leaves running (calendar home spec §2.5
// "Deadline"; Plan C Task C1): src/services/calendar-read/google.ts on the real Google
// client.
//
// A summary reads Google with a deadline of 8 to 30 s. When the deadline fires, the read
// answers at once. The requests it gave up on are cancelled then: a token request that a
// stuck token server never answers, and lists still waiting. So nothing keeps running,
// retries or holds a timer after the answer, also in a scheduled batch during a stall. The
// token request also gets a timeout no longer than the deadline, and every list request a
// timeout of at least 1 s. The range route's reads also ask calendarList for the
// calendars' colours (spec 2026-10-19 §3.1): that request is cancelled the same way.
//
// The real google.ts, calendar.ts (getGoogleAuth), @googleapis/calendar, its
// google-auth-library and gaxios run, retries included. Only gaxios's HTTP adapter is
// replaced (as in smoke-google-map.ts), by a fake that answers as Google does, or hangs
// as node-fetch does: until the request is aborted (an AbortError) or its own timeout
// passes (a request-timeout FetchError). Redis and error capture are faked. Timers are
// real, with short deadlines. No network.
//
// Run under both clocks; the output must not depend on the server's timezone:
//   TZ=UTC npx tsx scripts/smoke-calendar-read-google-cancel.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-calendar-read-google-cancel.ts

import Module, { createRequire } from 'node:module';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { UserConfig } from '../src/types';
import type { GoogleReadOptions, GoogleReadResult } from '../src/services/calendar-read/google';

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

const show = (v: unknown) => JSON.stringify(v);

function assertEq(got: unknown, want: unknown, what: string) {
  assert(show(got) === show(want), `${what}\n     got  ${show(got)}\n     want ${show(want)}`);
}

/** Anything that slips past the fake adapter is refused and counted. */
const networkAttempts: string[] = [];
globalThis.fetch = (async (input: unknown) => {
  networkAttempts.push(String(input));
  throw new Error('network is blocked in this smoke test');
}) as typeof fetch;

// ---- The fake Google: gaxios's HTTP adapter, replaced ----

type GaxiosOpts = Record<string, unknown> & { url?: unknown; timeout?: number; signal?: AbortSignal };

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const calendarRequire = createRequire(require.resolve('@googleapis/calendar'));
const gaxiosModule = calendarRequire('gaxios') as {
  Gaxios: { prototype: { _defaultAdapter: (this: unknown, opts: GaxiosOpts) => Promise<unknown> } };
};
const nodeFetch = createRequire(calendarRequire.resolve('gaxios'))('node-fetch') as {
  FetchError: new (message: string, type: string) => Error;
};

/** How the fake answers a request: at once, or never (until aborted or timed out). */
type Behaviour = 'answer' | 'hang';
let tokenBehaviour: Behaviour = 'answer';
let listBehaviour: Behaviour = 'answer';
/** calendarList's, when it differs from the lists'. */
let colourBehaviour: Behaviour | null = null;

/** Every request the client made: what it was, its timeout, whether it carried a signal, and how it ended. */
type Request = { what: string; timeout: number | null; signal: boolean; ended: string };
let requests: Request[] = [];
/** Requests still waiting for an answer. */
let waiting = 0;

function abortError(): Error {
  // What node-fetch rejects with when the request's signal is aborted.
  return Object.assign(new Error('The user aborted a request.'), { name: 'AbortError', type: 'aborted' });
}

function installFakeGoogle(): void {
  // The calendar client and its auth library must share the one gaxios whose adapter is
  // replaced; otherwise a request could reach the network.
  const authGaxios = createRequire(calendarRequire.resolve('google-auth-library'))('gaxios');
  const commonGaxios = createRequire(calendarRequire.resolve('googleapis-common'))('gaxios');
  if (authGaxios !== gaxiosModule || commonGaxios !== gaxiosModule) {
    console.error('FAIL  the Google client loads more than one gaxios; refusing to run without the fake');
    process.exit(1);
  }
  gaxiosModule.Gaxios.prototype._defaultAdapter = async function (opts: GaxiosOpts) {
    const url = String(opts.url);
    const isToken = url === TOKEN_URL;
    const isColours = url.startsWith('https://www.googleapis.com/calendar/v3/users/me/calendarList');
    const request: Request = {
      what: isToken ? 'token' : isColours ? 'colours' : `list ${decodeURIComponent(new URL(url).pathname.split('/')[4] ?? '?')}`,
      timeout: typeof opts.timeout === 'number' && opts.timeout > 0 ? opts.timeout : null,
      signal: opts.signal !== undefined,
      ended: 'waiting',
    };
    requests.push(request);
    if (!isToken && !url.startsWith('https://www.googleapis.com/calendar/v3/')) throw new Error(`unexpected request ${url}`);
    const respond = (status: number, data: unknown) => {
      request.ended = 'answered';
      return { config: opts, data, headers: {}, status, statusText: String(status), request: { responseURL: url } };
    };
    if ((isToken ? tokenBehaviour : isColours ? (colourBehaviour ?? listBehaviour) : listBehaviour) === 'answer') {
      return isToken
        ? respond(200, { access_token: 'fake-access', expires_in: 3600, token_type: 'Bearer' })
        : isColours
          ? respond(200, { items: [{ id: 'gali@example.com', backgroundColor: '#7bd148' }] })
          : respond(200, { summary: 'Family', items: [] });
    }
    waiting++;
    try {
      return await new Promise<never>((_resolve, reject) => {
        const signal = opts.signal;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const onAbort = () => {
          clearTimeout(timer);
          request.ended = 'aborted';
          reject(abortError());
        };
        if (signal?.aborted) return onAbort();
        signal?.addEventListener('abort', onAbort, { once: true });
        if (request.timeout !== null) {
          timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            request.ended = 'timed out';
            reject(new nodeFetch.FetchError(`network timeout at: ${url}`, 'request-timeout'));
          }, request.timeout);
        }
      });
    } finally {
      waiting--;
    }
  };
}

// ---- Fixtures ----

const NY = 'America/New_York';
const WINDOW = { from: new Date('2026-10-22T04:00:00.000Z'), to: new Date('2026-10-23T04:00:00.000Z') };
const user = {
  id: 7, telegramId: 1007, name: 'Gali', calendarSource: 'GOOGLE', googleRefreshToken: 'refresh-gali',
  calendarAssignments: [
    { calendarId: 'gali@example.com', labels: ['yours'], name: 'Gali', color: '#039BE5' },
    { calendarId: 'family@group.calendar.google.com', labels: [], name: 'Family', color: '#33b679' },
  ],
} as unknown as UserConfig;

/** Timers still pending in this process: the reader's deadline, a request timeout, a retry's backoff. */
const pendingTimers = () => process.getActiveResourcesInfo().filter(r => r === 'Timeout').length;
/** Let rejections and their handlers run out. */
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
};

const captured: string[] = [];

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

  const { readGoogleUncached } = (await import('../src/services/calendar-read/google')) as {
    readGoogleUncached: (u: UserConfig, w: { from: Date; to: Date }, o: GoogleReadOptions) => Promise<GoogleReadResult>;
  };

  /** One read, timed, with what it left behind once its rejections have run out. */
  async function read(deadlineMs: number, colours = false) {
    requests = [];
    captured.length = 0;
    const timersBefore = pendingTimers();
    const started = performance.now();
    const result = await readGoogleUncached(user, WINDOW, { tz: NY, deadlineMs, colours });
    const ms = performance.now() - started;
    await settle();
    return { status: { ...result.read, cause: undefined }, colours: result.colours, ms, waiting, timersLeft: pendingTimers() - timersBefore };
  }

  await check('a token server that never answers: error timeout at the deadline; the token request is cancelled then, with no retry, no request and no timer left', async () => {
    tokenBehaviour = 'hang';
    listBehaviour = 'answer';
    const r = await read(1500);
    assertEq(r.status, { status: 'error', reason: 'timeout' }, 'the read');
    assert(r.ms >= 1450 && r.ms < 2000, `answered after ${r.ms.toFixed(0)} ms`);
    assertEq(requests, [{ what: 'token', timeout: 1500, signal: true, ended: 'aborted' }], 'the requests');
    assertEq([r.waiting, r.timersLeft], [0, 0], 'requests still waiting, timers still pending');
    assertEq(captured, ['calendar-read-google warning Google read passed its 1500 ms deadline in the token step'], 'what was reported');
  });

  await check('lists still waiting at the deadline are cancelled too: error timeout, both requests aborted, nothing left', async () => {
    tokenBehaviour = 'answer';
    listBehaviour = 'hang';
    const r = await read(900);
    assertEq(r.status, { status: 'error', reason: 'timeout' }, 'the read');
    assert(r.ms >= 850 && r.ms < 1400, `answered after ${r.ms.toFixed(0)} ms`);
    assertEq(requests.map(q => `${q.what} ${q.ended}`), [
      'token answered',
      'list gali@example.com aborted',
      'list family@group.calendar.google.com aborted',
    ], 'the requests');
    assertEq([r.waiting, r.timersLeft], [0, 0], 'requests still waiting, timers still pending');
  });

  await check('the request timeouts: the token request gets the deadline, each list min(10 s, deadline - 0.5 s), never under 1 s', async () => {
    tokenBehaviour = 'answer';
    listBehaviour = 'answer';
    const got: string[] = [];
    for (const deadlineMs of [30000, 15000, 10000, 8000, 6000, 1200, 900]) {
      const r = await read(deadlineMs);
      assert(r.status.status === 'ok', `${deadlineMs}: ${show(r.status)}`);
      got.push(`${deadlineMs}: ${requests.map(q => `${q.what.split(' ')[0]} ${q.timeout}`).join(', ')}`);
    }
    assertEq(got, [
      '30000: token 30000, list 10000, list 10000',
      '15000: token 15000, list 10000, list 10000',
      '10000: token 10000, list 9500, list 9500',
      '8000: token 8000, list 7500, list 7500',
      '6000: token 6000, list 5500, list 5500',
      '1200: token 1200, list 1000, list 1000',
      '900: token 900, list 1000, list 1000',
    ], 'timeouts by deadline');
  });

  await check('a read that answers in time leaves nothing running either, and every request carried the cancel signal', async () => {
    tokenBehaviour = 'answer';
    listBehaviour = 'answer';
    const r = await read(10000);
    assert(r.status.status === 'ok', show(r.status));
    assertEq(requests.map(q => `${q.what} ${q.ended}${q.signal ? '' : ' (no signal)'}`), [
      'token answered',
      'list gali@example.com answered',
      'list family@group.calendar.google.com answered',
    ], 'the requests');
    assertEq([r.waiting, r.timersLeft], [0, 0], 'requests still waiting, timers still pending');
  });

  await check('the range route\'s reads ask calendarList too, on the same client: with the cancel signal and the lists\' timeout; one still waiting when the read answers at the deadline is cancelled then, the read ok with no colours; without colours asked, no calendarList', async () => {
    tokenBehaviour = 'answer';
    listBehaviour = 'answer';
    colourBehaviour = null;
    const r = await read(6000, true);
    assert(r.status.status === 'ok' && show(r.colours) === show({ 'gali@example.com': '#7bd148' }), `${show(r.status)} ${show(r.colours)}`);
    assertEq(requests.map(q => `${q.what} ${q.timeout} ${q.ended}${q.signal ? '' : ' (no signal)'}`), [
      'token 6000 answered',
      'colours 5500 answered',
      'list gali@example.com 5500 answered',
      'list family@group.calendar.google.com 5500 answered',
    ], 'the requests');
    colourBehaviour = 'hang';
    const late = await read(900, true);
    colourBehaviour = null;
    assert(late.status.status === 'ok' && late.colours === undefined, `${show(late.status)} ${show(late.colours)}`);
    assert(late.ms >= 850 && late.ms < 1400, `answered after ${late.ms.toFixed(0)} ms`);
    assertEq(requests.map(q => `${q.what} ${q.ended}`), ['token answered', 'colours aborted', 'list gali@example.com answered', 'list family@group.calendar.google.com answered'], 'the requests');
    assertEq([late.waiting, late.timersLeft], [0, 0], 'requests still waiting, timers still pending');
    const summary = await read(6000);
    assert(!requests.some(q => q.what === 'colours') && summary.colours === undefined, `a summary asked: ${show(requests)}`);
  });

  await check('nothing reached the network', async () => {
    assertEq(networkAttempts, [], 'network attempts');
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  // A request the read left waiting (the failure this smoke catches) would hold the process open.
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

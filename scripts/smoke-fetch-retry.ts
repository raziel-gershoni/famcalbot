// Smoke test for the shared retry loop (src/utils/fetch-retry.ts; spec docs/superpowers/specs/2026-10-31-open-meteo-replacement-design.md,
// one code path for non-Google retries): the one place that retries a call to a third party (MET Norway's forecast, Copernicus's dust files)
// with backoff. Checked here: the loop (counts, waits, the server's ask, the give-up, the hooks), and fetch on top of it
// (429, 5xx and no answer retried; Retry-After in seconds and as a date; one over the cap, 403 and 404 not retried; the
// accepted extra statuses; no signal of our own on the request), and the body read inside the attempt (a read that throws
// is retried like no answer). Faked: fetch, the waits, the jitter and the clock (the
// module's test seam). No network.
//
// Run under both clocks:
//   TZ=UTC npx tsx scripts/smoke-fetch-retry.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-fetch-retry.ts

import path from 'node:path';
import { createRequire } from 'node:module';

const ROOT = path.resolve(__dirname, '..');
const nodeRequire = createRequire(__filename);
const results: { name: string; ok: boolean; reason?: string }[] = [];
async function check(name: string, fn: () => void | Promise<void>) {
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

// A check that never settles would let Node drain its event loop and exit 0 in silence: that must read as a failure.
let reported = false;
process.on('exit', () => {
  if (!reported) {
    console.error('FAIL  the smoke ended before its checks did (a promise that never settled)');
    process.exitCode = 1;
  }
});

const waits: number[] = [];
let clock = Date.parse('2026-10-31T17:30:00Z');
let answer: (n: number) => Response | Error = () => new Error('no scenario');
const requests: { url: string; init: RequestInit | undefined }[] = [];
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  requests.push({ url: String(input), init });
  const a = answer(requests.length);
  if (a instanceof Error) throw a;
  return a;
}) as typeof fetch;

// Read through functions: TypeScript narrows a `.length` an earlier assert compared, and a later comparison would not compile.
const nRequests = () => requests.length;
const nWaits = () => waits.length;

const status = (s: number, headers: Record<string, string> = {}) => new Response('busy', { status: s, headers });
const ok = () => new Response('{}', { status: 200 });

function reset(): void {
  waits.length = 0;
  requests.length = 0;
  clock = Date.parse('2026-10-31T17:30:00Z');
}

async function main(): Promise<void> {
  const retry = nodeRequire(path.join(ROOT, 'src/utils/fetch-retry.ts')) as typeof import('../src/utils/fetch-retry');
  retry.__useRetryForTests({ now: () => clock, sleep: async (ms: number) => { waits.push(ms); }, random: () => 0.5 });
  const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
    const { warn } = console;
    console.warn = () => undefined;
    try {
      return await fn();
    } finally {
      console.warn = warn;
    }
  };

  await check('the loop: a first success waits for nothing; two failures then a success wait the full-jitter backoff (random 0.5 of 500, then 1000 ms) and return the value; onRetry runs before each wait', async () => {
    reset();
    assert(await retry.retryWithBackoff(async () => 'first') === 'first' && nWaits() === 0, `first try: waits ${show(waits)}`);
    let calls = 0;
    const seen: string[] = [];
    const value = await quiet(() => retry.retryWithBackoff(async () => {
      if (++calls < 3) throw new Error(`fail ${calls}`);
      return 'third';
    }, { onRetry: info => { seen.push(`${info.retry}/${info.maxRetries}@${info.waitMs}`); } }));
    assert(value === 'third' && calls === 3, `value ${value}, calls ${calls}`);
    assert(show(waits) === show([250, 500]) && show(seen) === show(['1/3@250', '2/3@500']), `waits ${show(waits)}, onRetry ${show(seen)}`);
  });

  await check('the loop: every attempt failing makes 4 attempts (3 retries) with waits 250, 500, 1000, rethrows the LAST error itself (same object), and calls onGiveUp once with the count', async () => {
    reset();
    let calls = 0;
    const errors: Error[] = [];
    const gaveUp: { error: unknown; retried: number; why: string }[] = [];
    let thrown: unknown;
    try {
      await quiet(() => retry.retryWithBackoff(async () => { const e = new Error(`fail ${++calls}`); errors.push(e); throw e; }, { onGiveUp: (error, info) => gaveUp.push({ error, ...info }) }));
    } catch (error) {
      thrown = error;
    }
    assert(calls === 4 && thrown === errors[3], `calls ${calls}, thrown the last error: ${thrown === errors[3]}`);
    assert(show(waits) === show([250, 500, 1000]), `waits ${show(waits)}`);
    assert(gaveUp.length === 1 && gaveUp[0].error === thrown && gaveUp[0].retried === 3 && gaveUp[0].why.includes('3 retries'), `onGiveUp ${show(gaveUp.map(g => [g.retried, g.why]))}`);
  });

  await check('the loop: maxRetries and baseMs are the caller\'s; an error the caller calls not retryable is thrown at once (onGiveUp says why, no wait); the server\'s ask is a floor under the backoff, and an ask over the cap gives up at once', async () => {
    reset();
    let calls = 0;
    const why: string[] = [];
    const onGiveUp = (_: unknown, info: { why: string }) => why.push(info.why);
    await quiet(() => retry.retryWithBackoff(async () => { calls++; throw new Error('x'); }, { maxRetries: 1, baseMs: 100, onGiveUp })).catch(() => undefined);
    assert(calls === 2 && show(waits) === show([50]), `maxRetries 1: calls ${calls}, waits ${show(waits)}`);
    reset();
    calls = 0;
    why.length = 0;
    await retry.retryWithBackoff(async () => { calls++; throw new Error('refused'); }, { retryable: () => ({ retry: false }), onGiveUp }).catch(() => undefined);
    assert(calls === 1 && nWaits() === 0 && why.length === 1 && why[0].includes('not retryable'), `not retryable: calls ${calls}, waits ${show(waits)}, why ${show(why)}`);
    reset();
    calls = 0;
    await quiet(() => retry.retryWithBackoff(async () => { if (++calls < 3) throw new Error('slow down'); return 1; }, { retryable: () => ({ retry: true, askedMs: calls === 1 ? 2000 : 100 }) }));
    assert(show(waits) === show([2000, 500]), `the ask is a floor: waits ${show(waits)}`);
    reset();
    calls = 0;
    why.length = 0;
    await quiet(() => retry.retryWithBackoff(async () => { calls++; throw new Error('come back later'); }, { retryable: () => ({ retry: true, askedMs: 10_001 }), onGiveUp })).catch(() => undefined);
    assert(calls === 1 && nWaits() === 0 && why[0].includes('10001'), `ask over the cap: calls ${calls}, waits ${show(waits)}, why ${show(why)}`);
    reset();
    calls = 0;
    await quiet(() => retry.retryWithBackoff(async () => { if (++calls < 2) throw new Error('ok to wait'); return 1; }, { retryable: () => ({ retry: true, askedMs: 10_000 }) }));
    assert(show(waits) === show([10_000]), `an ask of exactly the cap is waited: ${show(waits)}`);
  });

  await check('the real wait: with no seam the loop sleeps for real (a few ms here) and still ends', async () => {
    reset();
    retry.__useRetryForTests(null);
    let calls = 0;
    const started = Date.now();
    try {
      await quiet(() => retry.retryWithBackoff(async () => { if (++calls < 3) throw new Error('again'); return 1; }, { baseMs: 4 }));
    } finally {
      retry.__useRetryForTests({ now: () => clock, sleep: async (ms: number) => { waits.push(ms); }, random: () => 0.5 });
    }
    assert(calls === 3 && Date.now() - started < 1000, `calls ${calls} in ${Date.now() - started} ms`);
  });

  await check('fetch: a 503 then a 200 waits once and answers; the request is the caller\'s url and init untouched, with no signal of our own (no timeout)', async () => {
    reset();
    answer = n => (n === 1 ? status(503) : ok());
    const response = await quiet(() => retry.fetchWithRetry('https://example.test/a?x=1', { headers: { 'User-Agent': 'T/1' } }));
    assert(response.status === 200 && nRequests() === 2 && show(waits) === show([250]), `status ${response.status}, requests ${nRequests()}, waits ${show(waits)}`);
    assert(requests.every(r => r.url === 'https://example.test/a?x=1' && r.init?.signal === undefined && show(r.init?.headers) === show({ 'User-Agent': 'T/1' })), `requests ${show(requests)}`);
  });

  await check('fetch: 429 and 5xx and no answer are retried; Retry-After in seconds or as a date is the floor of the wait; 4 x 503 throw an HttpStatusError(503) after 3 retries', async () => {
    reset();
    answer = n => (n === 1 ? status(429, { 'retry-after': '2' }) : ok());
    await quiet(() => retry.fetchWithRetry('https://example.test/'));
    assert(show(waits) === show([2000]), `Retry-After 2: waits ${show(waits)}`);
    reset();
    answer = n => (n === 1 ? status(503, { 'retry-after': 'Sat, 31 Oct 2026 17:30:05 GMT' }) : ok());
    await quiet(() => retry.fetchWithRetry('https://example.test/'));
    assert(show(waits) === show([5000]), `Retry-After as a date: waits ${show(waits)}`);
    reset();
    answer = n => (n === 1 ? new TypeError('fetch failed') : ok());
    await quiet(() => retry.fetchWithRetry('https://example.test/'));
    assert(nRequests() === 2 && nWaits() === 1, `no answer: ${nRequests()} requests`);
    reset();
    answer = () => status(503);
    let thrown: unknown;
    await quiet(() => retry.fetchWithRetry('https://example.test/')).catch(error => { thrown = error; });
    assert(thrown instanceof retry.HttpStatusError && thrown.status === 503 && nRequests() === 4 && show(waits) === show([250, 500, 1000]), `4 x 503: ${show(thrown)}, ${nRequests()} requests, waits ${show(waits)}`);
    reset();
    answer = () => new TypeError('fetch failed');
    thrown = undefined;
    await quiet(() => retry.fetchWithRetry('https://example.test/')).catch(error => { thrown = error; });
    assert(thrown instanceof TypeError && nRequests() === 4, `4 x no answer: ${String(thrown)}, ${nRequests()} requests`);
  });

  await check('fetch: a Retry-After over 10 s, a 403 and a 404 are not retried (one request, no wait, an HttpStatusError carrying the status); an extra accepted status (a 304) is an answer, not a failure', async () => {
    reset();
    answer = () => status(429, { 'retry-after': '60' });
    let thrown: unknown;
    await quiet(() => retry.fetchWithRetry('https://example.test/')).catch(error => { thrown = error; });
    assert(thrown instanceof retry.HttpStatusError && thrown.status === 429 && thrown.retryAfterMs === 60_000 && nRequests() === 1 && nWaits() === 0, `Retry-After 60: ${show(thrown)}, ${nRequests()} requests, waits ${show(waits)}`);
    for (const code of [403, 404]) {
      reset();
      answer = () => status(code);
      thrown = undefined;
      await quiet(() => retry.fetchWithRetry('https://example.test/')).catch(error => { thrown = error; });
      assert(thrown instanceof retry.HttpStatusError && thrown.status === code && nRequests() === 1 && nWaits() === 0, `${code}: ${show(thrown)}, ${nRequests()} requests`);
    }
    reset();
    answer = () => new Response(null, { status: 304 });
    const again = await retry.fetchWithRetry('https://example.test/', {}, { okStatuses: [304] });
    assert(again.status === 304 && nRequests() === 1, `304 accepted: ${again.status}`);
    answer = () => new Response(null, { status: 304 });
    thrown = undefined;
    await quiet(() => retry.fetchWithRetry('https://example.test/')).catch(error => { thrown = error; });
    assert(thrown instanceof retry.HttpStatusError && thrown.status === 304, 'a 304 nobody accepted is a failure');
  });

  await check('fetch: the caller\'s hooks run on it: onGiveUp is called once for a refusal and once for exhausted retries, never for an answer', async () => {
    reset();
    const gaveUp: string[] = [];
    const options = { onGiveUp: (_: unknown, info: { retried: number; why: string }) => gaveUp.push(`${info.retried}:${info.why}`) };
    answer = () => ok();
    await retry.fetchWithRetry('https://example.test/', {}, options);
    answer = () => status(403);
    await quiet(() => retry.fetchWithRetry('https://example.test/', {}, options)).catch(() => undefined);
    answer = () => status(500);
    await quiet(() => retry.fetchWithRetry('https://example.test/', {}, options)).catch(() => undefined);
    assert(gaveUp.length === 2 && gaveUp[0].startsWith('0:') && gaveUp[1].startsWith('3:'), `onGiveUp ${show(gaveUp)}`);
  });

  await check('wholeJson: a JSON answer comes back whole as a fresh Response with its status, status text and headers, minus the wire\'s encoding and length; a byte-order mark is fine; a 204 has no body; cut-off or broken JSON throws with its size and encoding, never the body', async () => {
    const { wholeJson } = nodeRequire(path.join(ROOT, 'src/utils/whole-json.ts')) as typeof import('../src/utils/whole-json');
    const headers = { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': '31', expires: 'Sat, 31 Oct 2026 18:00:00 GMT' };
    const whole = await wholeJson(new Response('﻿{"a":[1,2]}', { status: 203, statusText: 'Non-Authoritative', headers }));
    assert(whole.status === 203 && whole.statusText === 'Non-Authoritative' && whole.headers.get('expires') === headers.expires && whole.headers.get('content-encoding') === null && whole.headers.get('content-length') === null, `status and headers: ${whole.status} ${show([...whole.headers.entries()])}`);
    assert(show(await whole.json()) === show({ a: [1, 2] }), 'the body reads');
    const empty = await wholeJson(new Response(null, { status: 204 }));
    assert(empty.status === 204 && empty.body === null, `204: ${empty.status}`);
    let thrown: unknown;
    await wholeJson(new Response('{"lat":32.08,"lon', { status: 200, headers })).catch(error => { thrown = error; });
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    assert(message === 'the 200 answer\'s JSON is cut off or broken: 17 bytes (gzip, 31 bytes sent)', `cut: ${message}`);
  });

  await check('fetch and read: the body is read in the attempt, so a read that throws (a body cut off on the way) is retried like no answer and the next read is the value; a refusal is never read; a read failing every time gives up after 3 retries with its own error, onGiveUp once', async () => {
    reset();
    const reads: number[] = [];
    const read = async (response: Response) => {
      reads.push(response.status);
      return JSON.parse(await response.text()) as unknown;
    };
    answer = n => (n === 1 ? new Response('{"properties":{"timeseries"', { status: 200 }) : new Response('{"a":1}', { status: 200 }));
    const value = await quiet(() => retry.fetchAndReadWithRetry('https://example.test/', {}, read));
    assert(show(value) === show({ a: 1 }) && nRequests() === 2 && show(waits) === show([250]) && show(reads) === show([200, 200]), `cut then whole: ${show(value)}, ${nRequests()} requests, waits ${show(waits)}, reads ${show(reads)}`);
    reset();
    reads.length = 0;
    answer = () => status(403);
    let thrown: unknown;
    await quiet(() => retry.fetchAndReadWithRetry('https://example.test/', {}, read)).catch(error => { thrown = error; });
    assert(thrown instanceof retry.HttpStatusError && thrown.status === 403 && nRequests() === 1 && reads.length === 0, `403: ${show(thrown)}, ${nRequests()} requests, reads ${show(reads)}`);
    reset();
    reads.length = 0;
    const gaveUp: string[] = [];
    answer = () => new Response('{"cut', { status: 200 });
    thrown = undefined;
    await quiet(() => retry.fetchAndReadWithRetry('https://example.test/', {}, read, { onGiveUp: (_, info) => gaveUp.push(`${info.retried}:${info.why}`) })).catch(error => { thrown = error; });
    assert(thrown instanceof SyntaxError && nRequests() === 4 && reads.length === 4 && show(waits) === show([250, 500, 1000]) && gaveUp.length === 1 && gaveUp[0].startsWith('3:'), `cut every time: ${String(thrown)}, ${nRequests()} requests, onGiveUp ${show(gaveUp)}`);
  });

  reported = true;
  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

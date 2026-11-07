// Smoke test for WhatsApp's calls on the one third-party retry loop (src/services/messaging/whatsapp-adapter.ts over
// src/utils/fetch-retry.ts; CLAUDE.md: every third party other than Google's APIs; plan 2026-11-07-b-features Task 8).
//  - W1 a send that meets a 5xx is sent again and goes through (one wait)
//  - W2 a 429's Retry-After is honoured (the wait is the server's ask)
//  - W3 a Retry-After over 10 s fails at once
//  - W4 a refusal (400 with Graph's code, 401, 403, 404) is never sent again; the send throws with Graph's error, as before
//  - W5 no answer is tried 4 times, then the send throws, and the give-up is logged once
//  - W6 a voice note: the upload is retried with the same form, then the message goes with the media id
//  - W7 a media download: the metadata GET and the file GET are retried, a file body cut off on the way included
//  - W8 a refused metadata GET fails at once with its status
//  - W9 the typing indicator goes through the loop and never throws
//  - W10 the code: no fetch of its own, no sleep, no attempt counter; WHATSAPP_REFUSALS is every 4xx but 429
//  - W11 no console line holds the access token
// Real: whatsapp-adapter.ts, fetch-retry.ts (its waits recorded, not slept), whole-json.ts. Faked: fetch, error capture. No network.
//
// Run: $RUN smoke-whatsapp-retry

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';

const ROOT = path.resolve(__dirname, '..');

// Error capture reaches Sentry: a recorder, served to require() from its cache before the adapter loads
const captured: string[] = [];
{
  const filename = path.join(ROOT, 'src/lib/error-capture.ts');
  const ModuleClass = Module as unknown as new (id: string) => Record<string, unknown>;
  const mod = new ModuleClass(filename);
  Object.assign(mod, { filename, loaded: true, exports: { captureError: (_e: unknown, context: string) => void captured.push(context), captureWarning: () => undefined, captureInfo: () => undefined } });
  (Module as unknown as { _cache: Record<string, unknown> })._cache[filename] = mod;
}
/* eslint-disable @typescript-eslint/no-require-imports */
const retry = require('../src/utils/fetch-retry') as typeof import('../src/utils/fetch-retry');
const { WhatsAppAdapter, WHATSAPP_REFUSALS } = require('../src/services/messaging/whatsapp-adapter') as typeof import('../src/services/messaging/whatsapp-adapter');
/* eslint-enable @typescript-eslint/no-require-imports */

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

type Answer = Response | Error;
let script: Answer[] = [];
const requests: { url: string; init?: RequestInit }[] = [];
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  requests.push({ url: String(input), init });
  const next = script.shift();
  if (!next) throw new Error('the smoke scripted no answer');
  if (next instanceof Error) throw next;
  return next;
}) as typeof fetch;
const waits: number[] = [];
retry.__useRetryForTests({ sleep: async (ms: number) => void waits.push(ms), random: () => 0.5, now: () => Date.parse('2026-11-07T10:00:00Z') });

/** The lines since the last reset, and every line of the run (W11). */
const lines: string[] = [];
const allLines: string[] = [];
for (const level of ['log', 'info', 'warn', 'error'] as const) {
  console[level] = (...args: unknown[]) => {
    const line = args.map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : show(a))).join(' ');
    lines.push(line);
    allLines.push(line);
  };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const SENT = () => json(200, { messages: [{ id: 'wamid.SMOKE' }] });
const TOKEN = 'wa-access-token-smoke-77';
const PHONE = '972500000077';
const wa = new WhatsAppAdapter(TOKEN, '1234567890');
function reset(answers: Answer[]): void {
  script = answers;
  requests.length = 0;
  waits.length = 0;
  lines.length = 0;
}
async function thrown(run: () => Promise<unknown>): Promise<Error | null> {
  try {
    await run();
    return null;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

async function main() {
  await check('W1 a send that meets a 5xx is sent again and goes through, with one wait and the same request', async () => {
    reset([json(503, { error: { code: 131016 } }), SENT()]);
    const id = await wa.sendMessage(PHONE, 'hello');
    assert(id === 'wamid.SMOKE' && requests.length === 2 && waits.length === 1, `id ${id}, requests ${requests.length}, waits ${show(waits)}`);
    assert(requests[0].url === requests[1].url && requests[0].init?.body === requests[1].init?.body && requests[0].init?.method === 'POST', 'the second request differs');
  });

  await check('W2 a 429\'s Retry-After is honoured: the wait is the server\'s 2 s', async () => {
    reset([json(429, { error: { code: 130429 } }, { 'retry-after': '2' }), SENT()]);
    await wa.sendMessage(PHONE, 'hello');
    assert(requests.length === 2 && show(waits) === show([2000]), `waits ${show(waits)}`);
  });

  await check('W3 a Retry-After over 10 s fails at once', async () => {
    reset([json(429, { error: { code: 131056 } }, { 'retry-after': '30' })]);
    const error = await thrown(() => wa.sendMessage(PHONE, 'hello'));
    assert(error && requests.length === 1 && waits.length === 0, `requests ${requests.length}, waits ${show(waits)}, error ${error?.message}`);
  });

  await check('W4 a refusal (400 with Graph\'s code, 401, 403, 404) is never sent again; the send throws with Graph\'s error as before', async () => {
    for (const [status, code] of [[400, 131047], [401, 190], [403, 200], [404, 100]] as const) {
      reset([json(status, { error: { code, message: 'refused (smoke)' } })]);
      const error = await thrown(() => wa.sendMessage(PHONE, 'hello'));
      assert(error && requests.length === 1 && waits.length === 0 && error.message.includes(`"code":${code}`) && error.message.startsWith('WhatsApp API error'), `${status}: requests ${requests.length}, ${error?.message}`);
    }
  });

  await check('W5 no answer is tried 4 times, then the send throws, and the give-up is logged once', async () => {
    reset([new TypeError('fetch failed'), new TypeError('fetch failed'), new TypeError('fetch failed'), new TypeError('fetch failed')]);
    const error = await thrown(() => wa.sendMessage(PHONE, 'hello'));
    assert(error && requests.length === 4 && waits.length === 3, `requests ${requests.length}, waits ${show(waits)}`);
    assert(lines.filter((l) => l.startsWith('[WhatsApp] send not delivered (gave up after 3 retries)')).length === 1, `lines ${show(lines)}`);
  });

  await check('W6 a voice note: the upload is retried with the same form, then the message goes with the media id', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wa-smoke-')), 'note.ogg');
    fs.writeFileSync(file, Buffer.from('OggS-smoke'));
    try {
      reset([json(500, { error: { code: 131000 } }), json(200, { id: 'media-1' }), SENT()]);
      await wa.sendVoice(PHONE, file);
      assert(requests.length === 3 && requests[0].url.endsWith('/media') && requests[1].url.endsWith('/media') && requests[2].url.endsWith('/messages'), `urls ${show(requests.map((r) => r.url))}`);
      assert(requests[0].init?.body instanceof FormData && requests[0].init?.body === requests[1].init?.body, 'the upload\'s form differs');
      assert(JSON.parse(String(requests[2].init?.body)).audio.id === 'media-1', 'the message has no media id');
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });

  await check('W7 a media download: the metadata GET and the file GET are retried, a file body cut off on the way included', async () => {
    const cutOff = new Response(new ReadableStream({ start(controller) { controller.error(new Error('terminated')); } }), { status: 200 });
    reset([json(502, {}), json(200, { url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=smoke' }), cutOff, new Response(Buffer.from('audio-bytes'), { status: 200 })]);
    const bytes = await wa.downloadMedia('media-9');
    assert(bytes.toString() === 'audio-bytes' && requests.length === 4 && waits.length === 2, `bytes ${bytes.toString()}, requests ${requests.length}, waits ${show(waits)}`);
    assert(requests.every((r) => (r.init?.headers as Record<string, string>).Authorization === `Bearer ${TOKEN}`), 'a request without the token');
  });

  await check('W8 a refused metadata GET fails at once with its status', async () => {
    reset([json(404, { error: { code: 100 } })]);
    const error = await thrown(() => wa.downloadMedia('media-gone'));
    assert(error?.message === 'WhatsApp media metadata error: HTTP 404' && requests.length === 1, `${error?.message}, requests ${requests.length}`);
  });

  await check('W9 the typing indicator goes through the loop and never throws', async () => {
    reset([json(503, {}), json(200, { success: true })]);
    await wa.sendTypingIndicator(PHONE, 'wamid.IN');
    assert(requests.length === 2, `requests ${requests.length}`);
    reset([new TypeError('fetch failed'), new TypeError('fetch failed'), new TypeError('fetch failed'), new TypeError('fetch failed')]);
    assert((await thrown(() => wa.sendTypingIndicator(PHONE, 'wamid.IN'))) === null, 'it threw');
  });

  await check('W10 the code: no fetch of its own, no sleep, no attempt counter, the loop imported; WHATSAPP_REFUSALS is every 4xx but 429', () => {
    const source = fs.readFileSync(path.join(ROOT, 'src/services/messaging/whatsapp-adapter.ts'), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert(!/(?<![\w.])fetch\(/.test(source), 'a fetch of its own');
    assert(!/setTimeout|retries\s*=|attempt\s*<=|Max retries/.test(source), 'a retry loop or sleep of its own');
    assert(/from '\.\.\/\.\.\/utils\/fetch-retry'/.test(source), 'fetch-retry is not imported');
    assert(WHATSAPP_REFUSALS.length === 99 && !WHATSAPP_REFUSALS.includes(429) && WHATSAPP_REFUSALS[0] === 400 && WHATSAPP_REFUSALS.at(-1) === 499, `refusals ${WHATSAPP_REFUSALS.length}`);
  });

  await check('W11 no console line holds the access token', () => {
    assert(allLines.length > 0 && !allLines.some((l) => l.includes(TOKEN)), 'the token was logged');
  });

  const failed = results.filter((r) => !r.ok);
  for (const r of results) process.stdout.write(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}\n`);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} passed\n`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});

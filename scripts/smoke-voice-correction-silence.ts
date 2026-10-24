// Smoke test for src/services/voice/correction-handler.ts: a voice correction goes through
// the same acoustic gate as a new voice note (isSilent). A near-silent clip never reaches
// the model and the user gets the same "I didn't hear anything" answer as for a silent new
// voice note; the pending confirmation is kept, so they can reply again. A loud clip still
// reaches the model.
//
// Faked: the model, messaging, the pending store, Redis, analytics, Sentry. No network, no DB.
//
// Run: npx tsx scripts/smoke-voice-correction-silence.ts

import Module from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { encodePcmToOggOpus } from '../src/utils/pcm-to-ogg-opus';

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];
function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

process.env.NEXT_PUBLIC_APP_URL = 'https://famcal.test';
globalThis.fetch = (async () => {
  throw new Error('network is blocked in this smoke test');
}) as typeof fetch;

const SRC = path.resolve(__dirname, '../src');
const geminiCalls: unknown[] = [];
const sent: string[] = [];
const removed: string[] = [];
const captured: string[] = [];
const USER = { id: 7, language: 'he', isAdmin: false };
const EVENT = { title: 'Dentist', startTime: new Date('2026-10-20T08:00:00Z'), endTime: new Date('2026-10-20T09:00:00Z'), allDay: false };

const stubs: Record<string, object> = {
  [`${SRC}/services/ai-provider.ts`]: {
    getGemini: () => ({ models: { generateContent: async (req: unknown) => { geminiCalls.push(req); throw new Error('model stopped (smoke)'); } } }),
    extractionConfig: () => ({}),
  },
  [`${SRC}/services/telegram/index.ts`]: {
    getMessagingService: () => ({ sendMessage: async (_chat: number, text: string) => { sent.push(text); } }),
  },
  [`${SRC}/services/voice/confirmations.ts`]: {
    getPendingEvent: async () => ({ event: EVENT, user: USER, transcription: 'x' }),
    removePendingEvent: async (id: string) => { removed.push(id); },
    showEventConfirmation: async () => {},
  },
  [`${SRC}/lib/timezone.ts`]: { resolveUserTimezone: async () => 'Asia/Jerusalem' },
  [`${SRC}/services/calendar-provider/index.ts`]: { getCalendarAssignmentsForUser: async () => [] },
  [`${SRC}/services/analytics-service.ts`]: { trackActivityAsync: () => {}, addBreadcrumb: () => {} },
  [`${SRC}/lib/error-capture.ts`]: { captureError: (e: unknown, where: string) => { captured.push(`${where} ${e instanceof Error ? e.message : e}`); } },
  [`${SRC}/utils/redis.ts`]: { redis: { del: async () => 0 } },
  [`${SRC}/services/telegram/command-pipeline.ts`]: { startTypingInterval: () => () => {} },
  [`${SRC}/services/claude.ts`]: {},
  [`${SRC}/services/voice/gemini-voice.ts`]: { buildEventTimes: () => ({}), readRepeat: () => null },
};

const M = Module as unknown as { _load: (...a: unknown[]) => unknown; _resolveFilename: (...a: unknown[]) => string };
const realLoad = M._load;
M._load = function (request: unknown, parent: unknown, isMain: unknown) {
  let resolved = String(request);
  try { resolved = M._resolveFilename(request, parent, isMain); } catch { /* not resolvable here: load it as it is */ }
  if (resolved in stubs) return stubs[resolved];
  return realLoad.call(this, request, parent, isMain);
};

// correction-handler loads the calendar provider with import(), which goes through the ES
// module loader; it gets the same fake, as an ES module.
(globalThis as { corrSmokeFake?: (file: string) => object }).corrSmokeFake = file => stubs[file];
if (typeof Module.registerHooks !== 'function') throw new Error('This smoke needs Node 22.15+ (module.registerHooks)');
Module.registerHooks({
  load(url, context, nextLoad) {
    const file = url.startsWith('file:') ? fileURLToPath(url.split('?')[0]) : '';
    if (!(file in stubs)) return nextLoad(url, context);
    const names = Object.keys(stubs[file]).map(name => `export const ${name} = fake.${name};`).join('\n');
    return { format: 'module', shortCircuit: true, source: `const fake = globalThis.corrSmokeFake(${JSON.stringify(file)});\n${names}\n` };
  },
});

const RATE = 24000;
function pcm(seconds: number, sample: (i: number) => number): Buffer {
  const n = Math.round(seconds * RATE);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(sample(i) * 32767), i * 2);
  return buf;
}
const silentOgg = encodePcmToOggOpus(pcm(2, () => 0));
let seed = 1;
const loudOgg = encodePcmToOggOpus(pcm(2, () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return ((seed / 0x7fffffff) * 2 - 1) * 0.3; }));

const he = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../messages/he.json'), 'utf8')).bot;

async function check(name: string, fn: () => Promise<void>) {
  geminiCalls.length = 0; sent.length = 0; removed.length = 0; captured.length = 0;
  try { await fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) }); }
}

async function main() {
  const quiet = () => {};
  const keep = { log: console.log, error: console.error };
  console.log = quiet; console.error = quiet;
  const { handleEventCorrection } = await import('../src/services/voice/correction-handler');

  await check('a silent voice correction: no model call, the silent-note answer, the pending kept', async () => {
    await handleEventCorrection(1, 1, 'p1', 10, { audioBuffer: silentOgg, language: 'he' });
    assert(geminiCalls.length === 0, `the model was called ${geminiCalls.length} time(s) for silence`);
    assert(sent.length === 1 && sent[0] === he.voice.noSpeech, `sent ${JSON.stringify(sent)}`);
    assert(removed.length === 0, 'the pending confirmation was removed');
    assert(captured.length === 0, `an error was captured: ${captured.join('; ')}`);
  });

  await check('a loud voice correction still reaches the model', async () => {
    await handleEventCorrection(1, 1, 'p1', 10, { audioBuffer: loudOgg, language: 'he' });
    assert(geminiCalls.length === 1, `the model was called ${geminiCalls.length} time(s); ${captured.join("; ")}`);
  });

  await check('a text correction is not gated', async () => {
    await handleEventCorrection(1, 1, 'p1', 10, { text: 'make it 5pm' });
    assert(geminiCalls.length === 1, `the model was called ${geminiCalls.length} time(s); ${captured.join("; ")}`);
  });

  console.log = keep.log; console.error = keep.error;
  for (const r of results) console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
  const passed = results.filter(r => r.ok).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
}
main();

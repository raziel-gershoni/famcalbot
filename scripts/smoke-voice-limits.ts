// Smoke test for the voice limit: src/services/telegram/voice.ts. The weekly show
// (/lookahead and /nextweek) is a voice summary like the daily one, so it is checked against the
// same limit (checkFeatureAccess 'voice_summary': out of voice summaries it is not made) and
// counts toward it (incrementUsage 'voiceSummaries', once, only when the voice reached the user).
// The daily voice keeps counting once. The real voice.ts runs; the show, the TTS, the messaging
// services, the plan checks and analytics are faked. No network, no DB.
//
// Run: TZ=Asia/Jerusalem npx tsx scripts/smoke-voice-limits.ts

import Module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MessagingPlatform } from '../src/services/messaging/types';
import type { UserConfig } from '../src/types';

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
}
function assert(cond: boolean, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

globalThis.fetch = (async (input: unknown) => {
  throw new Error(`network is blocked in this smoke test: ${String(input)}`);
}) as typeof fetch;

// ---- Fakes ----

let voiceAllowed = true;
let produceFails = false;
const featureChecks: string[] = [];
const usage: string[] = [];
const produced: string[] = [];
const voicesSent: string[] = [];
const rows: string[] = [];
const cleaned: string[] = [];

const service = {
  sendMessage: async () => 1,
  sendVoice: async (chatId: number | string, file: string) => { voicesSent.push(`${chatId} ${file}`); },
  sendTypingIndicator: async () => undefined,
};

const SRC = path.resolve(__dirname, '../src');
const stubs: Record<string, Record<string, unknown>> = {
  [`${SRC}/services/subscription-service.ts`]: {
    checkFeatureAccess: async (userId: number, feature: string) => { featureChecks.push(`${userId}:${feature}`); return { allowed: voiceAllowed }; },
    incrementUsage: async (userId: number, kind: string) => { usage.push(`${userId}:${kind}`); },
  },
  [`${SRC}/services/analytics-service.ts`]: {
    trackActivityAsync: (_u: number, action: string) => { rows.push(action); },
    addBreadcrumb: () => undefined,
  },
  [`${SRC}/lib/error-capture.ts`]: { captureError: () => undefined, captureWarning: () => undefined, captureInfo: () => undefined },
  [`${SRC}/services/telegram/bot.ts`]: { getMessagingService: () => service },
  [`${SRC}/services/messaging/index.ts`]: { MessagingPlatform, MessageFormat: { HTML: 'html' }, getMessagingService: () => service },
  [`${SRC}/services/voice-show/produce.ts`]: {
    isShowLanguage: () => true,
    produceShowVoice: async (_s: string, _u: unknown, kind: string) => {
      produced.push(kind);
      if (produceFails) throw new Error('TTS failed');
      return { filePath: `/tmp/${kind}.ogg`, caption: '', durationSeconds: 30 };
    },
  },
  [`${SRC}/services/voice-generator.ts`]: { cleanupVoiceFile: async (file: string) => { cleaned.push(file); } },
  [`${SRC}/utils/error-notifier.ts`]: { notifyAdminWarning: async () => undefined, notifyAdminError: async () => undefined },
  [`${SRC}/utils/redis.ts`]: { redis: { get: async () => null } },
};
const ModuleInternals = Module as unknown as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  _resolveFilename: (request: string, parent: unknown, isMain: boolean) => string;
};
const realLoad = ModuleInternals._load;
ModuleInternals._load = function (request, parent, isMain) {
  let resolved = request;
  try {
    resolved = ModuleInternals._resolveFilename(request, parent, isMain);
  } catch {}
  return stubs[resolved] ?? realLoad.call(this, request, parent, isMain);
};
(globalThis as { voiceSmokeStubs?: typeof stubs }).voiceSmokeStubs = stubs;
Module.registerHooks({
  load(url, context, nextLoad) {
    const file = url.startsWith('file:') ? fileURLToPath(url.split('?')[0]) : '';
    const stub = stubs[file];
    if (!stub) return nextLoad(url, context);
    const names = Object.keys(stub).map((n) => `export const ${n} = fake[${JSON.stringify(n)}];`).join('\n');
    return { format: 'module', shortCircuit: true, source: `const fake = globalThis.voiceSmokeStubs[${JSON.stringify(file)}];\n${names}\n` };
  },
});

const user = { id: 31, telegramId: 7031, name: 'Dana', language: 'he', isAdmin: false } as unknown as UserConfig;

function reset() {
  voiceAllowed = true;
  produceFails = false;
  for (const list of [featureChecks, usage, produced, voicesSent, rows, cleaned]) list.length = 0;
}

async function main() {
  const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
    const { log, error, warn } = console;
    console.log = console.error = console.warn = () => undefined;
    try {
      return await fn();
    } finally {
      Object.assign(console, { log, error, warn });
    }
  };
  const { sendVoiceMessage, sendWeeklyVoiceMessage } = await import('../src/services/telegram/voice');
  const settle = () => new Promise((r) => setTimeout(r, 10));

  for (const [label, isNextWeek] of [['/lookahead', false], ['/nextweek', true]] as const) {
    await check(`${label}: the weekly voice is checked against the voice limit, made when allowed, and counted once`, async () => {
      reset();
      await quiet(() => sendWeeklyVoiceMessage(7031, 'the week', user, isNextWeek));
      await settle();
      assert(featureChecks.join() === '31:voice_summary', `checks ${featureChecks.join()}`);
      assert(produced.join() === 'weekly' && voicesSent.length === 1, `produced ${produced.join()} sent ${voicesSent.join()}`);
      assert(usage.join() === '31:voiceSummaries', `usage ${usage.join() || '(none)'}`);
      assert(rows.join() === 'voice_summary_generated' && cleaned.length === 1, `rows ${rows.join()} cleaned ${cleaned.join()}`);
    });
  }

  await check('the weekly voice, out of voice summaries: not made, not sent, not counted', async () => {
    reset();
    voiceAllowed = false;
    await quiet(() => sendWeeklyVoiceMessage(7031, 'the week', user, false));
    await settle();
    assert(featureChecks.join() === '31:voice_summary' && produced.length === 0 && voicesSent.length === 0 && usage.length === 0, `checks ${featureChecks.join()} produced ${produced.length} sent ${voicesSent.length} usage ${usage.length}`);
  });

  await check('a weekly voice that failed to make is not counted', async () => {
    reset();
    produceFails = true;
    await quiet(() => sendWeeklyVoiceMessage(7031, 'the week', user, false));
    await settle();
    assert(produced.length === 1 && voicesSent.length === 0 && usage.length === 0, `produced ${produced.length} sent ${voicesSent.length} usage ${usage.length}`);
  });

  await check('the daily voice still counts once (its limit check is the caller\'s, in summary.ts)', async () => {
    reset();
    await quiet(() => sendVoiceMessage(7031, 'the day', user, undefined, false));
    await settle();
    assert(voicesSent.length === 1 && usage.join() === '31:voiceSummaries' && featureChecks.length === 0, `sent ${voicesSent.length} usage ${usage.join()} checks ${featureChecks.join()}`);
  });
}

main().then(() => {
  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? 'OK  ' : 'FAIL'}  ${r.name}${r.reason ? ` — ${r.reason}` : ''}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  process.exit(failed.length ? 1 : 0);
}, (err) => {
  console.error(err);
  process.exit(1);
});

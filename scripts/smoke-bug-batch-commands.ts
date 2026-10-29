// Smoke test for the bug batch of 2026-10-28, Task 1 (docs/superpowers/plans/2026-10-28-bug-batch.md): the Telegram
// payment commands and WhatsApp. One check family per fix:
//
//   1. /terms, /support and /paysupport on Telegram (Stars' rules for a bot that takes payments): the three answer in the
//      person's language, and in English for someone the bot does not know yet; /paysupport with words is saved as
//      feedback with source "paysupport", under feedback's own rules, and tells the admins with the person's
//      subscription facts so a refund can be made by hand.
//   2. WhatsApp "feedback <text>" is saved (source "whatsapp") and answered on WhatsApp; it used to look the phone up as a
//      Telegram id and do nothing.
//   3. A first WhatsApp message in Hebrew or Russian makes the person in that language, so the welcome is not English.
//   4. A WhatsApp card for a reminder by zman with three or more opinions is sent as a list (it used to throw and answer
//      "could not process your voice message"); a tap on a row reaches the same handler as a reply button.
//   5. A scheduled summary that goes only to WhatsApp sends just the tap-to-open template: it is not generated or counted
//      (the tap does both), but it is marked sent; a person on Telegram and WhatsApp is unchanged.
//   6. The WhatsApp "not understood" reply says "I heard" in the person's language.
//   7. The legal review of 2026-10-29 (issues 3, 5 and 20): /terms and /paysupport follow the new Terms (18+, one month
//      that never renews, the 14-day full refund and the ways to cancel, "give your name and the payment date"), and
//      /terms, every /start welcome and the WhatsApp welcome link the Privacy Policy and the Terms in the person's
//      language (Telegram's anchors with no link preview; plain "label: url" lines on WhatsApp).
//
// The real webhook handlers, command handlers, user-service, summary delivery, confirmations, the admin notifier and the
// zman card run. Faked: Prisma (in memory), Redis (in memory), both messaging services and the bot (every send is
// recorded), the AI, the calendar lookups, analytics, error capture and the pause. No network, no database.
//
// Run with the fake env (never the real one), from the repo root:
//   bash <scratchpad>/run-smoke.sh scripts/smoke-bug-batch-commands.ts

import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MessagingPlatform, MessageFormat } from '../src/services/messaging/types';
import type { MessageOptions } from '../src/services/messaging/types';
import type { ParsedEvent } from '../src/services/event-parser';
import type { ZmanSpecValue } from '../src/lib/calendar-view/zman-spec';
import type { PolicyWords } from '../src/lib/plan-disclosure';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');

// Test values, used only when the fake env left them unset. Empty, not deleted: @prisma/client loads a .env into unset names.
process.env.TELEGRAM_BOT_TOKEN ||= 'test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.ENCRYPTION_KEY_PREVIOUS = '';
process.env.TELEGRAM_BOT_USERNAME = 'famcal_test_bot';
process.env.WHATSAPP_PHONE_NUMBER_ID = '';
process.env.WHATSAPP_APP_SECRET = '';
process.env.NEXT_PUBLIC_APP_URL = 'https://famcal.test';

// ---- Checks ----

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  reset();
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

const show = (value: unknown): string => JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v));

function assertSame(got: unknown, want: unknown, label: string): void {
  assert(show(got) === show(want), `${label}\n     got  ${show(got)}\n     want ${show(want)}`);
}

/** Waits (real time) until a fire-and-forget command has done what the check looks for. */
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 600; i++) {
    if (cond()) return;
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

// ---- The bot's texts, read from the files ----

type Lang = 'en' | 'he' | 'ru';
const LANGS: Lang[] = ['en', 'he', 'ru'];
const MSG: Record<Lang, Row> = Object.fromEntries(
  LANGS.map(l => [l, JSON.parse(fs.readFileSync(path.join(ROOT, `messages/${l}.json`), 'utf8')).bot])
) as Record<Lang, Row>;

/** The disclosure's pieces (src/lib/plan-disclosure.ts, pure: loaded as it is), set in main(). */
let disclosure: typeof import('../src/lib/plan-disclosure');
const policyWords = (lang: Lang) => MSG[lang].policy as PolicyWords;
/** /terms and /paysupport as the person reads them: the template with the ways to cancel and the links filled in. */
const supportText = (lang: Lang, key: 'terms' | 'payPrompt') => disclosure.withPolicy(botText(lang, `support.${key}`), policyWords(lang), lang);

/** A bot text by path in a language, failing the check by name when the key is missing. */
function botText(lang: Lang, keyPath: string): string {
  let cur: unknown = MSG[lang];
  for (const key of keyPath.split('.')) cur = (cur as Row | undefined)?.[key];
  assert(typeof cur === 'string' && cur !== '', `bot.${keyPath} is missing in messages/${lang}.json`);
  return cur as string;
}

// ---- Fake Prisma: in-memory tables ----

const DB: Record<string, Row[]> = {};
let seq = 0;
const num = (x: unknown) => (x instanceof Date ? x.getTime() : Number(x));
const same = (a: unknown, b: unknown): boolean =>
  typeof a === 'bigint' || typeof b === 'bigint' ? a != null && b != null && String(a) === String(b) : a instanceof Date || b instanceof Date ? num(a) === num(b) : a === b;
const isPlain = (v: unknown): v is Row => v !== null && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v) && typeof v !== 'bigint';

function matches(row: Row, where?: Row): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, cond]) => {
    if (cond === undefined) return true;
    const v = row[k];
    if (isPlain(cond)) {
      if ('equals' in cond && !same(v ?? null, cond.equals)) return false;
      if ('not' in cond && same(v ?? null, cond.not)) return false;
      if ('in' in cond && !(cond.in as unknown[]).some(x => same(v, x))) return false;
      if ('gte' in cond && !(v != null && num(v) >= num(cond.gte))) return false;
      if ('gt' in cond && !(v != null && num(v) > num(cond.gt))) return false;
      return true;
    }
    return same(v ?? null, cond);
  });
}

/** A model call that throws while listed ("subscription.findUnique"): the database failing. */
const failing = new Set<string>();

function model(name: string): Row {
  const table = () => (DB[name] ??= []);
  const guard = (method: string) => {
    if (failing.has(`${name}.${method}`)) throw new Error(`${name}.${method} failed (smoke)`);
  };
  return {
    findUnique: async (a: Row = {}) => { guard('findUnique'); const r = table().find(x => matches(x, a.where)); return r ? { ...r } : null; },
    findFirst: async (a: Row = {}) => { guard('findFirst'); const r = table().find(x => matches(x, a.where)); return r ? { ...r } : null; },
    findMany: async (a: Row = {}) => { guard('findMany'); return table().filter(x => matches(x, a.where)).map(x => ({ ...x })); },
    count: async (a: Row = {}) => { guard('count'); return table().filter(x => matches(x, a.where)).length; },
    create: async (a: Row) => {
      guard('create');
      const now = new Date();
      const id = name === 'user' ? Math.max(0, ...table().map(r => Number(r.id))) + 1 : `${name}-${++seq}`;
      const row: Row = { id, createdAt: now, updatedAt: now, ...a.data };
      table().push(row);
      return { ...row };
    },
    update: async (a: Row) => {
      guard('update');
      const r = table().find(x => matches(x, a.where));
      if (!r) throw Object.assign(new Error(`No ${name} record`), { code: 'P2025' });
      Object.assign(r, a.data);
      return { ...r };
    },
    updateMany: async (a: Row) => { guard('updateMany'); const rows = table().filter(x => matches(x, a.where)); rows.forEach(r => Object.assign(r, a.data)); return { count: rows.length }; },
    deleteMany: async () => ({ count: 0 }),
    upsert: async () => null,
    groupBy: async () => [],
    aggregate: async () => ({}),
  };
}
const models: Record<string, Row> = {};
const fakePrisma: Row = new Proxy({} as Row, {
  get(_t, prop) {
    if (typeof prop !== 'string' || prop === 'then') return undefined;
    if (prop === '$transaction') return async (arg: unknown) => (typeof arg === 'function' ? arg(fakePrisma) : Promise.all(arg as Promise<unknown>[]));
    if (prop.startsWith('$')) return async () => undefined;
    return (models[prop] ??= model(prop));
  },
});

// ---- Fake Redis ----

const redisStore = new Map<string, unknown>();
const redisImpl: Row = {
  get: async (k: string) => (redisStore.has(k) ? JSON.parse(JSON.stringify(redisStore.get(k))) : null),
  set: async (k: string, v: unknown, o?: Row) => {
    if (o?.nx && redisStore.has(k)) return null;
    redisStore.set(k, typeof v === 'string' ? v : JSON.parse(JSON.stringify(v)));
    return 'OK';
  },
  del: async (...ks: unknown[]) => ks.flat().reduce((n: number, k) => n + (redisStore.delete(String(k)) ? 1 : 0), 0),
  exists: async (...ks: string[]) => ks.filter(k => redisStore.has(k)).length,
  getdel: async (k: string) => { const v = redisStore.get(k) ?? null; redisStore.delete(k); return v; },
  incr: async (k: string) => { const n = Number(redisStore.get(k) ?? 0) + 1; redisStore.set(k, n); return n; },
  mget: async (...ks: unknown[]) => ks.flat().map(k => redisStore.get(String(k)) ?? null),
  expire: async () => 1,
  scan: async () => [0, []],
};
const fakeRedis = new Proxy(redisImpl, { get: (t, p) => (typeof p !== 'string' || p === 'then' ? undefined : t[p] ?? (async () => null)) });

// ---- What the fakes saw ----

type Sent = { via: 'telegram' | 'whatsapp' | 'bot'; method: string; chatId: unknown; text: string; options?: MessageOptions & Row };
const sent: Sent[] = [];
const logs: string[] = [];
const captured: string[] = [];
const tracked: { userId: number; action: string; metadata?: Row }[] = [];
const usage: string[] = [];
const generated: string[] = [];
const marks: { userId: number; type: string }[] = [];
const unreachable: number[] = [];
const voiceSent: string[] = [];
const created: Row[] = [];
let templateFails = false;
/** The plan lacks voice summaries. */
let voiceDenied = false;
let pausedIds = new Set<number>();
let scheduled: number[] = [];
let voiceIntents: Row[] = [];
let voiceTranscription = '';

const tgService = {
  sendMessage: async (chatId: unknown, text: string, options?: Row) => { sent.push({ via: 'telegram', method: 'sendMessage', chatId, text, options }); return 500 + sent.length; },
  updateMessage: async (chatId: unknown, _id: unknown, text: string, options?: Row) => { sent.push({ via: 'telegram', method: 'updateMessage', chatId, text, options }); },
  sendTypingIndicator: async () => {},
};
const waService = {
  sendMessage: async (chatId: unknown, text: string, options?: Row) => {
    if (templateFails && options?.whatsappTemplate) throw new Error('WhatsApp template refused (smoke)');
    sent.push({ via: 'whatsapp', method: 'sendMessage', chatId, text, options });
    return `wamid.out${sent.length}`;
  },
  sendTypingIndicator: async () => {},
  downloadMedia: async () => Buffer.from('OggS'),
};
/** The bot's own sendMessage is the admin notifier's (error-notifier.ts calls getBot()). */
const fakeBot = {
  sendMessage: async (chatId: unknown, text: string, options?: Row) => { sent.push({ via: 'bot', method: 'sendMessage', chatId, text, options }); return { message_id: 1 }; },
};

// ---- Fixtures ----

const DAY = 86_400_000;
const HARISH = { location: 'Harish', latitude: 32.46182, longitude: 35.04555, elevationM: 270 };

function baseUser(o: Row): Row {
  return {
    name: 'Someone', englishName: '', gender: 'male', language: 'en', location: 'Tel Aviv', culture: 'default',
    messagingPlatform: 'telegram', googleRefreshToken: '', calendarAssignments: null, calendarSource: 'NATIVE', googleScopes: [],
    pairingId: null, remindersEnabled: false, suspendedAt: null, unreachableSince: null, whatsappPhone: null, whatsappBsuid: null,
    telegramId: null, isAdmin: false, globalRules: [], voiceInputEnabled: true, textSummaryEnabled: true, voiceSummaryEnabled: false,
    weatherEnabled: false, includeLookaheadInTomorrow: false, reminderTime: null, zmanimCommunity: 'sephardi', pauseOnShabbat: true,
    createdAt: new Date(Date.now() - 30 * DAY), updatedAt: new Date(Date.now() - DAY), elevationM: null, latitude: null, longitude: null,
    ...o,
  };
}

const TG_EN = 1001;
const TG_HE = 1002;
const TG_RU = 1003;
const TG_STRANGER = 4242;
const TG_ADMIN = 9001;
const WA_RU = '+972500000004';
const WA_HE = '+972500000005';
const WA_BOTH = '+972500000006';
const WA_NEW = '+972500000099';
const WA_NO_TELEGRAM = '+972500000007';

function reset() {
  for (const k of Object.keys(DB)) delete DB[k];
  redisStore.clear();
  failing.clear();
  for (const list of [sent, logs, captured, tracked, usage, generated, marks, unreachable, voiceSent, created]) list.length = 0;
  templateFails = false;
  voiceDenied = false;
  pausedIds = new Set();
  scheduled = [];
  voiceIntents = [];
  voiceTranscription = '';
  DB.user = [
    baseUser({ id: 1, name: 'Noa', telegramId: BigInt(TG_EN), language: 'en' }),
    baseUser({ id: 2, name: 'Dana', telegramId: BigInt(TG_HE), language: 'he' }),
    baseUser({ id: 3, name: 'Olga', telegramId: BigInt(TG_RU), language: 'ru' }),
    baseUser({ id: 4, name: 'Irina', messagingPlatform: 'whatsapp', whatsappPhone: WA_RU, language: 'ru' }),
    baseUser({ id: 5, name: 'Yael', messagingPlatform: 'whatsapp', whatsappPhone: WA_HE, language: 'he', ...HARISH }),
    baseUser({ id: 6, name: 'Tal', telegramId: BigInt(1006), messagingPlatform: 'all', whatsappPhone: WA_BOTH, language: 'en' }),
    baseUser({ id: 7, name: 'Maya', messagingPlatform: 'all', whatsappPhone: WA_NO_TELEGRAM, language: 'en' }),
    baseUser({ id: 9, name: 'Admin', telegramId: BigInt(TG_ADMIN), isAdmin: true, language: 'en' }),
  ];
  DB.subscription = [
    { id: 'sub-1', userId: 1, plan: 'PRO', status: 'ACTIVE', telegramPaymentChargeId: 'chg_TEST_123', currentPeriodStart: new Date('2026-10-01T08:00:00Z'), currentPeriodEnd: new Date('2026-11-01T08:00:00Z') },
  ];
}

// ---- Boundaries: stubs served to require() and import() alike ----

const stubs: Record<string, object | ((real: Record<string, unknown>) => object)> = {};

const fakeOver = (real: Record<string, unknown>, fakes: Record<string, unknown>) =>
  new Proxy(real, { get: (target, key) => (typeof key === 'string' && key in fakes ? fakes[key] : Reflect.get(target, key)) });

const messagingFake = {
  MessagingPlatform,
  MessageFormat,
  getMessagingService: (platform: unknown) => (platform === MessagingPlatform.WHATSAPP ? waService : tgService),
  getTelegramService: () => tgService,
  getWhatsAppService: () => waService,
};

Object.assign(stubs, {
  [`${SRC}/utils/prisma.ts`]: { prisma: fakePrisma, withRetry: (fn: () => unknown) => fn() },
  [`${SRC}/utils/redis.ts`]: { redis: fakeRedis },
  [`${SRC}/lib/error-capture.ts`]: {
    captureError: (error: unknown, context: string) => { captured.push(`${context}: ${error instanceof Error ? error.message : String(error)}`); },
    captureWarning: (message: string, context: string) => { captured.push(`${context}: ${message}`); },
    captureInfo: () => undefined,
  },
  [`${SRC}/services/telegram/bot.ts`]: {
    getBot: () => fakeBot,
    initBot: () => fakeBot,
    getMessagingService: () => tgService,
    setUserMenuButton: async () => undefined,
  },
  [`${SRC}/services/messaging/index.ts`]: messagingFake,
  [`${SRC}/services/messaging/factory.ts`]: messagingFake,
  [`${SRC}/services/analytics-service.ts`]: {
    trackActivityAsync: (userId: number, action: string, metadata?: Row) => { tracked.push({ userId, action, metadata }); },
    trackActivity: async () => undefined,
    addBreadcrumb: () => undefined,
    setUserContext: () => undefined,
  },
  [`${SRC}/lib/user-moderation.ts`]: (real: Record<string, unknown>) => fakeOver(real, { isIdentifierBlocked: async () => false }),
  [`${SRC}/services/subscription-service.ts`]: {
    checkFeatureAccess: async (_userId: number, feature: string) => ({ allowed: !(feature === 'voice_summary' && voiceDenied) }),
    incrementUsage: async (userId: number, kind: string) => { usage.push(`${userId}:${kind}`); },
    invalidateFeatureAccessCache: async () => undefined,
  },
  [`${SRC}/services/reminder-cache.ts`]: { removeUserFromCache: async () => undefined, getVoiceAutoCreateHighConf: async () => false, getVoiceTtsOutcome: async () => false },
  [`${SRC}/services/magic-link.ts`]: { generateMagicLink: async () => 'https://famcal.test/magic' },
  [`${SRC}/services/native-calendar/onboarding.ts`]: { ensurePrimaryNativeCalendar: async () => undefined, hasGoogleChoices: () => false },
  [`${SRC}/lib/user-reachability.ts`]: {
    clearUserUnreachable: async () => undefined,
    markUnreachableAfterSendFailure: async (user: { id: number }) => { unreachable.push(user.id); },
    markUnreachableAfterWhatsAppFailure: async () => false,
  },
  // The summary pass: the people it is asked about, and what it reads
  [`${SRC}/services/user-service.ts`]: (real: Record<string, unknown>) =>
    fakeOver(real, {
      getAllUsers: async () => {
        const { getUserById } = real as { getUserById: (id: number) => Promise<unknown> };
        return Promise.all(scheduled.map(id => getUserById(id)));
      },
    }),
  [`${SRC}/services/calendar-provider/index.ts`]: {
    getCalendarAssignmentsForUser: async () => [{ calendarId: 'native:home1', labels: ['yours'], name: 'Home', color: '#039BE5' }],
    hasUsableCalendar: async () => true,
    createCalendarFor: async (_user: unknown, event: { calendarId?: string }) => event.calendarId ?? 'native:home1',
    providerForCalendar: () => ({
      name: 'native',
      createEvent: async (_user: unknown, calendarId: string, input: Row) => { created.push({ calendarId, ...input }); return { success: true, eventId: `ev-${created.length}` }; },
    }),
  },
  [`${SRC}/services/calendar-read/digest.ts`]: (real: Record<string, unknown>) => fakeOver(real, { readDigestDay: async () => [] }),
  [`${SRC}/lib/timezone.ts`]: { resolveUserTimezone: async () => 'Asia/Jerusalem', resolveLocation: async () => null, LOOKUP_TIMEOUT_MS: 3000, TIMEZONE_CACHE_TTL: 86_400 },
  [`${SRC}/services/native-reminders/open-reminders.ts`]: { addDigestReminders: async (_u: unknown, events: unknown[]) => ({ events, moreCount: 0 }) },
  [`${SRC}/services/week-lookahead.ts`]: { getWeekLookahead: async () => ({ events: [] }), formatTomorrowLookahead: () => '' },
  [`${SRC}/services/claude.ts`]: {
    generateSummary: async (...args: unknown[]) => { generated.push(String(args[3])); return 'AI summary'; },
    formatDateHeader: () => 'Date header',
  },
  [`${SRC}/services/telegram/voice.ts`]: {
    sendVoiceMessage: async (_chatId: unknown, text: string) => { voiceSent.push(text); },
    sendWeeklyVoiceMessage: async () => undefined,
  },
  [`${SRC}/services/kid-name-detection.ts`]: { sendKidNameFollowUp: async () => undefined },
  [`${SRC}/services/zmanim/pause.ts`]: (real: Record<string, unknown>) => fakeOver(real, { isPaused: async (user: { id: number }) => pausedIds.has(user.id) }),
  [`${SRC}/lib/summary-scheduling.ts`]: {
    filterUsersForSummary: async (users: unknown[]) => ({ eligible: users, skippedHour: 0, skippedDay: 0, skippedDedup: 0 }),
    markSummarySent: async (userId: number, type: string) => { marks.push({ userId, type }); },
  },
  // The voice path
  [`${SRC}/services/native-reminders/support.ts`]: { getReminderSupport: async () => ({ supported: true }) },
  [`${SRC}/services/voice/recent-events-store.ts`]: {
    pushRecentEvent: async () => undefined, removeRecentEvent: async () => undefined, getRecentEvents: async () => [], formatRecentEventsBlock: () => '',
  },
  [`${SRC}/services/voice/audio-retry.ts`]: { isInRetryMode: async () => false, readRetryAudio: async () => null, clearRetryMode: async () => undefined, stashFailedAudio: async () => undefined },
  [`${SRC}/services/voice/gemini-voice.ts`]: (real: Record<string, unknown>) =>
    fakeOver(real, {
      processVoiceWithGemini: async () => ({
        intentResult: voiceIntents[0], intentResults: voiceIntents, transcription: voiceTranscription,
        metrics: { model: 'fake', inputTokens: 0, outputTokens: 0, durationMs: 0 },
      }),
    }),
  [`${SRC}/services/native-reminders/resolve.ts`]: (real: Record<string, unknown>) =>
    fakeOver(real, {
      resolveReminderIntents: async (_user: unknown, intents: unknown[]) => ({ intents, failures: [] }),
      reminderPromptContext: async () => undefined,
    }),
});

const ModuleInternals = Module as unknown as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  _resolveFilename: (request: string, parent: unknown, isMain: boolean) => string;
};
const resolveFilename = ModuleInternals._resolveFilename;
ModuleInternals._resolveFilename = function (request, parent, isMain) {
  // @hebcal/core is ESM-only and tsx loads src/ as CommonJS: point it at its ESM build
  if (request === '@hebcal/core') return path.resolve(ROOT, 'node_modules/@hebcal/core/dist/esm/index.js');
  return resolveFilename.call(this, request, parent, isMain);
};

const built = new Map<string, object>();
const loadingReal = new Set<string>();
function fakeFor(file: string, loadReal: () => unknown): object {
  const stub = stubs[file];
  if (typeof stub !== 'function') return stub;
  if (!built.has(file)) {
    loadingReal.add(file);
    try {
      built.set(file, stub(loadReal() as Record<string, unknown>));
    } finally {
      loadingReal.delete(file);
    }
  }
  return built.get(file)!;
}
const realLoad = ModuleInternals._load;
ModuleInternals._load = function (request, parent, isMain) {
  let resolved = request;
  try {
    resolved = ModuleInternals._resolveFilename(request, parent, isMain);
  } catch {}
  if (!(resolved in stubs) || loadingReal.has(resolved)) return realLoad.call(this, request, parent, isMain);
  return fakeFor(resolved, () => realLoad.call(this, request, parent, isMain));
};
// import() goes through the ES module loader: the same fakes, served as ES modules.
(globalThis as { bugBatchFake?: (file: string) => object }).bugBatchFake = file => fakeFor(file, () => realLoad.call(Module, file, null, false));
if (typeof Module.registerHooks !== 'function') throw new Error('This smoke needs Node 22.15+ (module.registerHooks)');
Module.registerHooks({
  load(url, context, nextLoad) {
    const file = url.startsWith('file:') ? fileURLToPath(url.split('?')[0]) : '';
    if (!(file in stubs) || loadingReal.has(file)) return nextLoad(url, context);
    const fake = (globalThis as unknown as { bugBatchFake: (file: string) => object }).bugBatchFake(file);
    const names = Object.keys(fake).map(name => `export const ${name} = fake.${name};`).join('\n');
    return { format: 'module', shortCircuit: true, source: `const fake = globalThis.bugBatchFake(${JSON.stringify(file)});\n${names}\n` };
  },
});
globalThis.fetch = (async (input: unknown) => { throw new Error(`network blocked in this smoke: ${String(input)}`); }) as typeof fetch;

// ---- Driving the webhooks ----

type Responded = { status: number; body: unknown };
function res(into: Responded[]) {
  return { status: (code: number) => ({ json: (body: unknown) => { into.push({ status: code, body }); } }) };
}

async function telegramText(fromId: number, text: string): Promise<Responded[]> {
  const { handleTelegramWebhook } = await import('../src/services/webhook-handlers');
  const out: Responded[] = [];
  await handleTelegramWebhook(
    { body: { update_id: ++seq, message: { message_id: 10, chat: { id: fromId }, from: { id: fromId, first_name: 'T' }, text } } },
    res(out)
  );
  return out;
}

async function whatsappMessage(from: string, message: Row, profileName = 'Newcomer'): Promise<Responded[]> {
  const { handleWhatsAppWebhook } = await import('../src/services/webhook-handlers');
  const out: Responded[] = [];
  const wa = from.replace('+', '');
  await handleWhatsAppWebhook(
    {
      body: {
        object: 'whatsapp_business_account',
        entry: [{ changes: [{ value: { metadata: { phone_number_id: 'PN' }, contacts: [{ wa_id: wa, profile: { name: profileName } }], messages: [{ from: wa, id: `wamid.in${++seq}`, ...message }] } }] }],
      },
    },
    res(out)
  );
  return out;
}
const waText = (from: string, body: string, profileName?: string) => whatsappMessage(from, { type: 'text', text: { body } }, profileName);
const waList = (from: string, id: string) => whatsappMessage(from, { type: 'interactive', interactive: { type: 'list_reply', list_reply: { id, title: 'row' } } });
const waAudio = (from: string) => whatsappMessage(from, { type: 'audio', audio: { id: `media-${++seq}` } });

const sentTo = (via: Sent['via']) => sent.filter(s => s.via === via);
const adminNotes = () => sent.filter(s => s.via === 'bot' && s.chatId === TG_ADMIN);
const feedbackRows = () => (DB.userFeedback ?? []).map(r => ({ userId: r.userId, source: r.source, text: r.text }));

/** Runs fn with the console lines kept in `logs` (the code under test logs a lot). */
async function withLogs<T>(fn: () => Promise<T>): Promise<T> {
  const kept = { log: console.log, warn: console.warn, error: console.error };
  const take = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  console.log = take; console.warn = take; console.error = take;
  try {
    return await fn();
  } finally {
    Object.assign(console, kept);
  }
}

// ---- Fix 1 ----

async function fix1() {
  await check('1: /terms, /support and /paysupport answer a known person in their language (en, he, ru)', async () => {
    const people: [Lang, number][] = [['en', TG_EN], ['he', TG_HE], ['ru', TG_RU]];
    for (const [lang, id] of people) {
      sent.length = 0;
      await telegramText(id, '/terms');
      await telegramText(id, '/support');
      await telegramText(id, '/paysupport');
      const texts = sentTo('telegram').map(s => s.text);
      assertSame(texts, [supportText(lang, 'terms'), botText(lang, 'support.help'), supportText(lang, 'payPrompt')], `${lang}: the three replies`);
      assert(sentTo('telegram').every(s => s.options?.format === MessageFormat.HTML && s.chatId === id), `${lang}: HTML to the person's chat: ${show(sentTo('telegram').map(s => [s.chatId, s.options?.format]))}`);
    }
  });

  await check('1: the same three answer a person the bot does not know yet, in English, and nothing throws', async () => {
    for (const text of ['/terms', '/support', '/paysupport']) {
      const out = await telegramText(TG_STRANGER, text);
      assertSame(out, [{ status: 200, body: { ok: true } }], `${text}: the webhook answered 200`);
    }
    assertSame(
      sentTo('telegram').map(s => s.text),
      [supportText('en', 'terms'), botText('en', 'support.help'), supportText('en', 'payPrompt')],
      'the three replies for a stranger'
    );
    assertSame(feedbackRows(), [], 'nothing was saved');
  });

  await check('1: /paysupport with words is saved as "paysupport", answered, and the admins are told with the subscription facts', async () => {
    await telegramText(TG_EN, '/paysupport I was charged twice for Pro');
    assertSame(feedbackRows(), [{ userId: 1, source: 'paysupport', text: 'I was charged twice for Pro' }], 'saved feedback');
    assertSame(sentTo('telegram').map(s => s.text), [botText('en', 'support.paySent')], 'the reply (not feedback.success)');
    const notes = adminNotes();
    assert(notes.length === 1, `expected one admin note, got ${notes.length}`);
    const note = notes[0].text;
    for (const part of ['paysupport', 'Noa', 'I was charged twice for Pro', 'PRO', 'ACTIVE', 'chg_TEST_123', '2026-10-01']) {
      assert(note.includes(part), `the admin note lacks "${part}":\n${note}`);
    }
    assert(tracked.some(t => t.action === 'feedback_submitted' && t.metadata?.source === 'paysupport'), `activity: ${show(tracked)}`);
  });

  await check("1: /paysupport keeps feedback's rules: too short, too long, three a day (counted apart from feedback)", async () => {
    await telegramText(TG_HE, '/paysupport קצר');
    await telegramText(TG_HE, `/paysupport ${'x'.repeat(1001)}`);
    assertSame(sentTo('telegram').map(s => s.text), [botText('he', 'feedback.tooShort'), botText('he', 'feedback.tooLong')], 'the length replies');
    assertSame(feedbackRows(), [], 'neither was saved');

    sent.length = 0;
    for (let i = 0; i < 3; i++) await telegramText(TG_HE, `/paysupport question number ${i} about my payment`);
    assertSame(feedbackRows().map(r => r.source), ['paysupport', 'paysupport', 'paysupport'], 'three were saved');
    sent.length = 0;
    await telegramText(TG_HE, '/paysupport a fourth question about my payment');
    assertSame(sentTo('telegram').map(s => s.text), [botText('he', 'feedback.rateLimit')], 'the fourth is refused');
    assert(feedbackRows().length === 3, 'the fourth was saved');

    // Three feedbacks do not use up a payment question
    DB.userFeedback = [];
    for (let i = 0; i < 3; i++) await telegramText(TG_RU, `/feedback general thoughts number ${i}`);
    sent.length = 0;
    await telegramText(TG_RU, '/paysupport a question about my payment');
    assertSame(sentTo('telegram').map(s => s.text), [botText('ru', 'support.paySent')], 'a payment question after three feedbacks');
  });

  await check('1: /paysupport with words from an unknown person gets the help text in English and logs "[paysupport] unknown user"', async () => {
    await withLogs(() => telegramText(TG_STRANGER, '/paysupport I was charged twice for Pro'));
    assertSame(sentTo('telegram').map(s => s.text), [botText('en', 'support.help')], 'the reply');
    assertSame(feedbackRows(), [], 'nothing was saved');
    assert(logs.some(l => l.includes('[paysupport] unknown user')), `no "[paysupport] unknown user" log: ${show(logs)}`);
    assert(adminNotes().length === 0, 'the admins were told about a stranger');
  });

  await check('1: a failed subscription lookup is logged and the admins are still told', async () => {
    failing.add('subscription.findUnique');
    await withLogs(() => telegramText(TG_EN, '/paysupport I was charged twice for Pro'));
    assertSame(sentTo('telegram').map(s => s.text), [botText('en', 'support.paySent')], 'the person is answered');
    assert(adminNotes().length === 1, `expected the admin note, got ${adminNotes().length}`);
    assert(logs.some(l => l.includes('[paysupport]') && l.includes('subscription')), `no log of the failed lookup: ${show(logs)}`);
    assert(captured.some(c => c.includes('subscription.findUnique failed')), `the failure was not captured: ${show(captured)}`);
  });

  await check("1: the admin note shows the person's words as text (a \"<\" or \"&\" does not break the HTML note)", async () => {
    await telegramText(TG_EN, '/feedback refund <b>please</b> & thanks for everything');
    const note = adminNotes()[0]?.text ?? '';
    assert(note.includes('refund &lt;b&gt;please&lt;/b&gt; &amp; thanks'), `the words are not escaped:\n${note}`);
  });

  await check('1: the admin panel labels a payment question by its source, not "In the app"', async () => {
    adminLabels(['paysupport']);
  });
}

/** The admin panel's feedback list names where a message came from; a source it does not know reads "In the app". */
function adminLabels(sources: string[]) {
  const view = fs.readFileSync(path.join(ROOT, 'app/[locale]/(app)/admin-panel/views/FeedbackView.tsx'), 'utf8');
  for (const source of sources) {
    assert(view.includes(`'${source}'`) && view.includes(`feedback.${source}`), `FeedbackView.tsx does not label the "${source}" source`);
    for (const lang of LANGS) {
      const label = JSON.parse(fs.readFileSync(path.join(ROOT, `messages/${lang}.json`), 'utf8')).admin.feedback[source];
      assert(typeof label === 'string' && label !== '', `admin.feedback.${source} is missing in messages/${lang}.json`);
    }
  }
}

// ---- Fix 2 ----

async function fix2() {
  await check("2: WhatsApp \"feedback <text>\" is saved as \"whatsapp\", answered on WhatsApp in the person's language, and the admins are told", async () => {
    await waText(WA_RU, 'feedback Очень удобный бот, спасибо большое');
    await until(() => sentTo('whatsapp').length > 0, 'the WhatsApp reply');
    assertSame(feedbackRows(), [{ userId: 4, source: 'whatsapp', text: 'Очень удобный бот, спасибо большое' }], 'saved feedback');
    assertSame(sentTo('whatsapp').map(s => [s.chatId, s.text]), [[WA_RU, botText('ru', 'feedback.success')]], 'the WhatsApp reply');
    assertSame(sentTo('telegram').map(s => s.text), [], 'nothing went to Telegram');
    const note = adminNotes()[0]?.text ?? '';
    assert(note.includes('Irina') && note.includes('whatsapp') && note.includes('Очень удобный'), `the admin note:\n${note}`);
    assert(tracked.some(t => t.action === 'feedback_submitted' && t.metadata?.source === 'whatsapp'), `activity: ${show(tracked)}`);
  });

  await check('2: the admin panel labels WhatsApp feedback by its source, not "In the app"', async () => {
    adminLabels(['whatsapp']);
  });

  await check('2: WhatsApp feedback keeps the length rule, answered on WhatsApp', async () => {
    await waText(WA_HE, 'feedback קצר');
    await until(() => sentTo('whatsapp').length > 0, 'the WhatsApp reply');
    assertSame(sentTo('whatsapp').map(s => s.text), [botText('he', 'feedback.tooShort')], 'the reply');
    assertSame(feedbackRows(), [], 'nothing was saved');
  });
}

// ---- Fix 3 ----

async function fix3() {
  await check('3: guessLanguageFromText: a Hebrew letter gives he, else a Cyrillic letter gives ru, else en', async () => {
    const { guessLanguageFromText } = await import('../src/utils/locale');
    const cases: [string, string][] = [
      ['שלום', 'he'], ['hello שלום', 'he'], ['Привет', 'ru'], ['hi Привет', 'ru'], ['שלום Привет', 'he'], ['hello', 'en'], ['', 'en'], ['12345 ?!', 'en'],
      ['א', 'he'], ['ת', 'he'], ['xא', 'he'], ['summary tmrw', 'en'],
    ];
    for (const [text, want] of cases) assertSame(guessLanguageFromText(text), want, `guessLanguageFromText(${show(text)})`);
  });

  await check('3: a first WhatsApp message in Hebrew, Russian or English makes the person in that language, and the welcome follows', async () => {
    const cases: [string, string, Lang][] = [[WA_NEW, 'שלום, מה אפשר לעשות כאן?', 'he'], ['+972500000098', 'Здравствуйте, что вы умеете?', 'ru'], ['+972500000097', 'hello there', 'en']];
    for (const [phone, text, lang] of cases) {
      sent.length = 0;
      await waText(phone, text, 'Newcomer');
      const row = DB.user.find(u => u.whatsappPhone === phone);
      assert(row, `no user was created for ${phone}`);
      assertSame(row.language, lang, `the language of ${phone}`);
      const welcome = `${botText(lang, 'whatsapp.welcome').replace('{name}', 'Newcomer')}\n\n${disclosure.policyLinks(policyWords(lang), lang, 'text')}`;
      assertSame(sentTo('whatsapp')[0]?.text, welcome, `${lang}: the first reply is the welcome in the person's language, then the policy links`);
      assert(sentTo('whatsapp').some(s => s.options?.whatsappButtons), `${lang}: the language buttons still follow the welcome`);
    }
  });

  await check('3: a person already known keeps their language when they write in another', async () => {
    await waText(WA_RU, 'שלום');
    assertSame(DB.user.find(u => u.id === 4)?.language, 'ru', 'language of an existing person');
  });
}

// ---- Fix 4 ----

const day = () => new Date().toISOString().slice(0, 10);
const SHEMA_MGA: ZmanSpecValue = { zman: 'SOF_SHMA_MGA', offsetMin: -10 };
const SHEMA_GRA: ZmanSpecValue = { zman: 'SOF_SHMA_GRA', offsetMin: -10 };
const PLAG_HB: ZmanSpecValue = { zman: 'PLAG_HALACHA_BERURA', offsetMin: 0 };
const LONG_RULE: ZmanSpecValue = { halachicHours: 3, offsetMin: -10 };

async function choiceReminder(specs: ZmanSpecValue[]): Promise<ParsedEvent> {
  const { wallTimeToInstant } = await import('../src/utils/wall-time');
  const start = wallTimeToInstant(`${day()}T00:00`, 'Asia/Jerusalem');
  return {
    title: 'Say Shema', startTime: start, endTime: new Date(start.getTime()), allDay: true, confidence: 'high', kind: 'reminder', forPerson: 'self',
    calendarId: 'native:home1', calendarName: 'Home', zmanChoices: specs.map(spec => ({ spec, day: day() })),
  } as ParsedEvent;
}

type ListMessage = { buttonText: string; sections: { title?: string; rows: { id: string; title: string; description?: string }[] }[] };
function listOf(message: Sent | undefined): ListMessage {
  assert(message, 'no message was sent');
  const list = message.options?.whatsappList;
  assert(list, `the card was not sent as a list: ${show(message.options)}`);
  return list as ListMessage;
}

async function fix4() {
  const voiceFor = async (specs: ZmanSpecValue[]) => {
    voiceTranscription = 'remind me at the latest time for Shema';
    voiceIntents = [{ intent: 'create', confidence: 'high', event: await choiceReminder(specs) }];
  };

  await check('4: a zman card with three or more opinions is sent as a list: one row per opinion with event_pick, then Cancel; titles fit 24, descriptions 72', async () => {
    for (const lang of LANGS) {
      DB.user.find(u => u.id === 5)!.language = lang;
      sent.length = 0;
      await voiceFor([SHEMA_MGA, SHEMA_GRA, PLAG_HB, LONG_RULE]);
      await waAudio(WA_HE);
      const cards = sentTo('whatsapp').filter(s => s.options?.whatsappList || s.options?.whatsappButtons);
      assert(cards.length === 1, `${lang}: expected one card, got ${cards.length}; sent ${show(sentTo('whatsapp').map(s => s.text.slice(0, 60)))}`);
      const list = listOf(cards[0]);
      assert(!cards[0].options?.whatsappButtons, `${lang}: the card also carries reply buttons`);
      assert(list.buttonText === botText(lang, 'whatsapp.zmanChoose'), `${lang}: list button "${list.buttonText}"`);
      assert([...list.buttonText].length <= 20, `${lang}: list button is ${[...list.buttonText].length} characters`);
      assert(list.sections.length === 1, `${lang}: expected one section, got ${list.sections.length}`);
      const section = list.sections[0];
      assert(section.title === MSG[lang].nativeReminders.zman.whichOpinion && [...(section.title ?? '')].length <= 24, `${lang}: section title "${section.title}"`);
      const rows = section.rows;
      assert(rows.length === 5, `${lang}: expected 4 opinions and Cancel, got ${rows.length}`);
      const pendingId = rows[4].id.replace('event_cancel:', '');
      assert(rows[4].id.startsWith('event_cancel:wa:') && rows[4].title === botText(lang, 'whatsapp.cancelButton'), `${lang}: the last row ${show(rows[4])}`);
      rows.slice(0, 4).forEach((row, i) => assert(row.id === `event_pick:${i}:${pendingId}`, `${lang}: row ${i} id "${row.id}"`));
      for (const row of rows) {
        assert([...row.title].length <= 24, `${lang}: title "${row.title}" is ${[...row.title].length} characters`);
        assert(!row.description || [...row.description].length <= 72, `${lang}: description "${row.description}" is ${[...(row.description ?? '')].length} characters`);
      }
      for (const row of rows.slice(0, 3)) assert(/\d{2}:\d{2}/.test(row.description ?? ''), `${lang}: row "${row.title}" shows no time: "${row.description}"`);
      assert(sentTo('whatsapp').every(s => !s.text.includes('could not process')), `${lang}: the person got the error reply`);
      assert(!captured.some(c => c.includes('zman-voice')), `${lang}: captured ${show(captured)}`);
    }
  });

  await check('4: two opinions keep the reply buttons (opinion, opinion, Cancel)', async () => {
    await voiceFor([SHEMA_MGA, SHEMA_GRA]);
    await waAudio(WA_HE);
    const card = sentTo('whatsapp').find(s => s.options?.whatsappButtons || s.options?.whatsappList);
    assert(card?.options?.whatsappButtons && !card.options.whatsappList, `not reply buttons: ${show(card?.options)}`);
    const buttons = card.options.whatsappButtons as { id: string; title: string }[];
    assert(
      buttons.length === 3 && buttons[0].id.startsWith('event_pick:0:') && buttons[1].id.startsWith('event_pick:1:') && buttons[2].id.startsWith('event_cancel:'),
      `buttons ${show(buttons)}`
    );
  });

  await check('4: a tap on a list row reaches the same handler as a reply button: the reminder is created with that opinion', async () => {
    await voiceFor([SHEMA_MGA, SHEMA_GRA, PLAG_HB]);
    await waAudio(WA_HE);
    const list = listOf(sentTo('whatsapp').find(s => s.options?.whatsappList));
    const tapped = list.sections[0].rows[2];
    sent.length = 0;
    await waList(WA_HE, tapped.id);
    await until(() => created.length > 0, 'the reminder to be created');
    assertSame(created.map(c => c.zmanSpec), [PLAG_HB], 'the rule the reminder was created with');
    assert(sentTo('whatsapp').some(s => s.text.includes('Say Shema')), `no created reply: ${show(sentTo('whatsapp').map(s => s.text))}`);
  });
}

// ---- Fix 5 ----

async function runBatch(tomorrow: boolean) {
  const summary = await import('../src/services/telegram/summary');
  return withLogs(() => (tomorrow ? summary.sendTomorrowSummaryToAll({ filterByHour: true }) : summary.sendDailySummaryToAll({ filterByHour: true })));
}
const templatesTo = (chatId: string) => sentTo('whatsapp').filter(s => s.options?.whatsappTemplate && s.chatId === chatId);

async function fix5() {
  await check('5: a WhatsApp-only scheduled summary sends just the template: no generation, no usage count, dedup marked, counted as processed', async () => {
    scheduled = [4];
    const result = await runBatch(false);
    assertSame(generated, [], 'the summary was generated');
    assertSame(usage, [], 'a summary was counted');
    assertSame(voiceSent, [], 'a voice summary was made');
    assertSame(templatesTo(WA_RU).map(s => [s.text, (s.options?.whatsappTemplate as Row).name, (s.options?.whatsappTemplate as Row).buttonPayload]), [['', 'famcal_notify_ru', 'summary']], 'the template');
    assertSame(sent.length, 1, 'everything that was sent');
    assertSame(marks, [{ userId: 4, type: 'daily' }], 'the dedup mark');
    assert(result.processed === 1, `processed ${result.processed}`);
  });

  await check('5: the tomorrow summary does the same, with its own button payload', async () => {
    scheduled = [5];
    const result = await runBatch(true);
    assertSame(generated, [], 'the summary was generated');
    assertSame(usage, [], 'a summary was counted');
    assertSame(templatesTo(WA_HE).map(s => (s.options?.whatsappTemplate as Row).buttonPayload), ['summary tmrw'], 'the payload');
    assertSame(marks, [{ userId: 5, type: 'tomorrow' }], 'the dedup mark');
    assert(result.processed === 1, `processed ${result.processed}`);
  });

  await check('5: a person on Telegram and WhatsApp still gets the text once on Telegram (counted once) and the template on WhatsApp', async () => {
    scheduled = [6];
    const result = await runBatch(false);
    assertSame(generated.length, 1, 'summaries generated');
    assertSame(usage, ['6:textSummaries'], 'summaries counted');
    const telegramTexts = sentTo('telegram').filter(s => s.method === 'sendMessage' && s.text === 'AI summary');
    assertSame(telegramTexts.map(s => s.chatId), [1006], 'the Telegram text');
    assertSame(templatesTo(WA_BOTH).length, 1, 'WhatsApp templates');
    assertSame(sentTo('whatsapp').filter(s => !s.options?.whatsappTemplate).length, 0, 'other WhatsApp sends');
    assertSame(marks, [{ userId: 6, type: 'daily' }], 'the dedup mark');
    assert(result.processed === 1, `processed ${result.processed}`);
  });

  await check('5: a person on "both" with no Telegram chat set up is a WhatsApp-only delivery: the template alone', async () => {
    scheduled = [7];
    const result = await runBatch(false);
    assertSame(generated, [], 'the summary was generated');
    assertSame(usage, [], 'a summary was counted');
    assertSame(templatesTo(WA_NO_TELEGRAM).length, 1, 'WhatsApp templates');
    assertSame(sent.length, 1, 'everything that was sent');
    assert(result.processed === 1, `processed ${result.processed}`);
  });

  await check('5: a WhatsApp-only person with the text off and the voice summary on gets the template when the plan has voice, none when it does not', async () => {
    const row = DB.user.find(u => u.id === 4)!;
    row.textSummaryEnabled = false;
    row.voiceSummaryEnabled = true;
    scheduled = [4];
    await runBatch(false);
    assertSame(templatesTo(WA_RU).length, 1, 'WhatsApp templates with voice allowed');
    assertSame([generated.length, usage.length, voiceSent.length], [0, 0, 0], 'generated, counted, voiced');

    sent.length = 0;
    marks.length = 0;
    voiceDenied = true;
    const result = await runBatch(false);
    assertSame(sent.length, 0, 'sends when the plan has no voice summaries');
    assertSame(marks, [{ userId: 4, type: 'daily' }], 'the dedup mark');
    assert(result.processed === 1, `processed ${result.processed}`);
  });

  await check('5: a person on Telegram only is unchanged: generated once, counted once, sent once', async () => {
    scheduled = [1];
    await runBatch(false);
    assertSame(generated.length, 1, 'summaries generated');
    assertSame(usage, ['1:textSummaries'], 'summaries counted');
    assertSame(sentTo('telegram').filter(s => s.method === 'sendMessage').map(s => s.text), ['AI summary'], 'the Telegram text');
    assertSame(sentTo('whatsapp').length, 0, 'WhatsApp sends');
  });

  await check('5: a WhatsApp-only person with text and voice summaries off gets nothing, as before, but is marked', async () => {
    DB.user.find(u => u.id === 4)!.textSummaryEnabled = false;
    DB.user.find(u => u.id === 4)!.voiceSummaryEnabled = false;
    scheduled = [4];
    const result = await runBatch(false);
    assertSame(sent.length, 0, 'sends');
    assertSame(generated, [], 'generated');
    assertSame(marks, [{ userId: 4, type: 'daily' }], 'the dedup mark');
    assert(result.processed === 1, `processed ${result.processed}`);
  });

  await check('5: a failed template send is logged, flags the person unreachable (as before) and the dedup mark is still written', async () => {
    templateFails = true;
    scheduled = [4];
    const result = await runBatch(false);
    assert(captured.some(c => c.startsWith('whatsapp-delivery') && c.includes('refused')), `not captured: ${show(captured)}`);
    assert(logs.some(l => l.startsWith('[Delivery] WA') && l.includes('failed')), `not logged: ${show(logs)}`);
    assertSame(unreachable, [4], 'flagged unreachable');
    assertSame(marks, [{ userId: 4, type: 'daily' }], 'the dedup mark');
    assert(result.processed === 1, `processed ${result.processed}`);
  });

  await check('5: the pause is untouched: a paused WhatsApp-only person gets nothing and is not marked', async () => {
    pausedIds = new Set([4]);
    scheduled = [4];
    const result = await runBatch(false);
    assertSame(sent.length, 0, 'sends');
    assertSame(marks, [], 'the dedup mark');
    assert(result.skippedPause === 1 && result.processed === 0, `result ${show(result)}`);
  });
}

// ---- Fix 6 ----

async function fix6() {
  for (const lang of ['he', 'ru'] as Lang[]) {
    await check(`6: the WhatsApp not-understood reply says "I heard" in ${lang}`, async () => {
      DB.user.find(u => u.id === 5)!.language = lang;
      voiceTranscription = lang === 'he' ? 'משהו שלא מובן' : 'что-то непонятное';
      voiceIntents = [{ intent: 'unknown', confidence: 'low', error: 'not_an_event' }];
      await waAudio(WA_HE);
      const reply = sentTo('whatsapp').map(s => s.text).find(t => t.includes(voiceTranscription));
      assert(reply, `no reply quoting the transcript: ${show(sentTo('whatsapp').map(s => s.text))}`);
      assert(reply.includes(botText(lang, 'voice.iHeard')), `the reply lacks "${botText(lang, 'voice.iHeard')}":\n${reply}`);
      assert(!reply.includes('I heard'), `the reply still says "I heard":\n${reply}`);
    });
  }
}

// ---- Fix 7 ----

const NEVER_RENEWS: Record<Lang, RegExp> = { en: /never renews/i, he: /אף פעם לא מתחדשת/, ru: /никогда не продлевается/ };
const ADULTS: Record<Lang, RegExp> = { en: /18 or older/, he: /מגיל 18/, ru: /с 18 лет/ };

async function fix7() {
  await check('7: /terms follows the new Terms in en, he and ru: 18+, one month that never renews, the 14-day full refund with the ways to cancel and what to give, and the links to the Privacy Policy and the Terms in the person\'s language, with no link preview', async () => {
    for (const [lang, id] of [['en', TG_EN], ['he', TG_HE], ['ru', TG_RU]] as [Lang, number][]) {
      sent.length = 0;
      await telegramText(id, '/terms');
      const [reply] = sentTo('telegram');
      assert(reply, `${lang}: no reply`);
      const w = policyWords(lang);
      assert(ADULTS[lang].test(reply.text) && NEVER_RENEWS[lang].test(reply.text), `${lang}: 18+ or never renews:\n${reply.text}`);
      assert(reply.text.includes(disclosure.cancelBlock(w, lang)), `${lang}: not the ways to cancel:\n${reply.text}`);
      assert(reply.text.includes(`href="${disclosure.policyUrl('privacy', lang)}"`) && reply.text.includes(`href="${disclosure.policyUrl('terms', lang)}"`), `${lang}: the links:\n${reply.text}`);
      assert(!/\{\w+\}|null/.test(reply.text), `${lang}: a hole:\n${reply.text}`);
      assert(reply.options?.format === MessageFormat.HTML && reply.options?.disablePreview === true, `${lang}: the options ${show(reply.options)}`);
    }
  });

  await check('7: /paysupport with no words: one month that never renews, the 14-day full refund with the ways to cancel and what to give', async () => {
    for (const [lang, id] of [['en', TG_EN], ['he', TG_HE], ['ru', TG_RU]] as [Lang, number][]) {
      sent.length = 0;
      await telegramText(id, '/paysupport');
      const [reply] = sentTo('telegram');
      assert(reply && NEVER_RENEWS[lang].test(reply.text) && reply.text.includes(disclosure.cancelBlock(policyWords(lang), lang)), `${lang}:\n${reply?.text}`);
      assert(!/\{\w+\}|null/.test(reply.text), `${lang}: a hole:\n${reply.text}`);
    }
  });

  await check('7: every /start welcome ends with the links to the Privacy Policy and the Terms in the person\'s language, with no link preview: a returning person, one with no place yet, and an admin', async () => {
    DB.user.find(u => u.id === 3)!.location = '';
    const cases: [string, Lang, number, string][] = [
      ['returning', 'en', TG_EN, botText('en', 'start.tapButton')],
      ['returning', 'he', TG_HE, botText('he', 'start.tapButton')],
      ['no place', 'ru', TG_RU, botText('ru', 'onboarding.nativeLocationButton') && botText('ru', 'onboarding.nativeWelcome').split('{')[0]],
      ['admin', 'en', TG_ADMIN, botText('en', 'start.chooseBoard')],
    ];
    for (const [who, lang, id, body] of cases) {
      sent.length = 0;
      await withLogs(() => telegramText(id, '/start'));
      const welcome = sentTo('telegram').find(s => s.options?.replyMarkup);
      assert(welcome, `${who} ${lang}: no welcome in ${show(sentTo('telegram').map(s => s.text.slice(0, 50)))}`);
      assert(welcome.text.includes(body), `${who} ${lang}: not the welcome:\n${welcome.text}`);
      assert(welcome.text.endsWith(`\n\n${disclosure.policyLinks(policyWords(lang), lang, 'html')}`), `${who} ${lang}: the links are not at the end:\n${welcome.text}`);
      assert(welcome.options?.format === MessageFormat.HTML && welcome.options?.disablePreview === true, `${who} ${lang}: the options ${show(welcome.options)}`);
    }
  });

  await check('7: every first contact ends with the links too, with no link preview: the /start deep links feedback, connect (WhatsApp not linked yet) and a partner\'s invite (a bad token and one the pairing refuses), and a typed "accept <token>" (from a stranger, whose account it creates, and from a known person)', async () => {
    const cases: [string, string, Lang, number][] = [
      ['feedback', '/start feedback', 'en', TG_EN],
      ['connect', '/start connect', 'he', TG_HE],
      ['invite, a bad token', '/start invite_abc', 'ru', TG_RU],
      ['invite, refused', `/start invite_${'f'.repeat(32)}`, 'en', TG_STRANGER],
      ['accept, a stranger', `accept ${'e'.repeat(32)}`, 'en', TG_STRANGER],
      ['accept, a known person', `accept ${'a'.repeat(16)}`, 'he', TG_HE],
    ];
    for (const [what, text, lang, id] of cases) {
      if (id === TG_STRANGER) DB.user = DB.user.filter(u => Number(u.telegramId) !== TG_STRANGER);
      sent.length = 0;
      await withLogs(() => telegramText(id, text));
      const replies = sentTo('telegram').filter(s => s.chatId === id);
      assert(replies.length > 0, `${what}: no reply`);
      const last = replies[replies.length - 1];
      const want = id === TG_STRANGER ? 'en' : lang;
      assert(last.text.endsWith(`\n\n${disclosure.policyLinks(policyWords(want), want, 'html')}`), `${what}: the links are not at the end:\n${last.text}`);
      assert(last.options?.format === MessageFormat.HTML && last.options?.disablePreview === true, `${what}: the options ${show(last.options)}`);
    }
  });

  await check('7: the WhatsApp welcome sends the links as plain URLs, with no HTML and no format to convert', async () => {
    await waText(WA_NEW, 'שלום', 'Newcomer');
    const [welcome] = sentTo('whatsapp');
    assert(welcome && welcome.text.includes(`${policyWords('he').privacy}: ${disclosure.policyUrl('privacy', 'he')}`) && welcome.text.includes(`${policyWords('he').terms}: ${disclosure.policyUrl('terms', 'he')}`), `the links:\n${welcome?.text}`);
    assert(!/[<>]/.test(welcome.text) && welcome.options?.format === undefined, `markup or a format: ${show(welcome.options)}`);
  });
}

async function main() {
  disclosure = await import('../src/lib/plan-disclosure');
  const original = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  const keep = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  Object.assign(console, { log: keep, warn: keep, error: keep, info: keep });
  try {
    await fix1();
    await fix2();
    await fix3();
    await fix4();
    await fix5();
    await fix6();
    await fix7();
  } finally {
    Object.assign(console, original);
  }

  const width = Math.max(...results.map(r => r.name.length));
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(width)}${r.ok ? '' : `\n       ${r.reason}`}`);
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

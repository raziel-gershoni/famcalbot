// Smoke test for the bug batch of 2026-10-28, Task 3 (docs/superpowers/plans/2026-10-28-bug-batch.md): errors, safety and
// data. One check family per fix:
//
//   1. A create, edit or delete that fails says so in the person's language on Telegram, on WhatsApp and in the bulk card:
//      never Prisma's or Google's English text, never a bare code. The Google provider names a Hebrew repeat by its code.
//   2. The admin's hard delete of a person revokes their Google token at Google first (Disconnect Google's own call), and
//      goes on when the revoke fails.
//   3. A saved platform that names a channel the person lacks no longer stops their summaries (deliveryPlatformFor narrows it
//      to the channels they have), Settings refuses such a platform, and shows the choice only to a person with both.
//   (the families of fixes 4-7 are added with their fixes)
//
// The real webhook handlers, voice callbacks, the bulk card, summary delivery, the providers and the routes run. Faked: Prisma
// (in memory), Redis (in memory), both messaging services and the bot (every send is recorded), the AI, the calendar
// lookups, analytics, error capture and Google. No network, no database.
//
// Run with the fake env (never the real one), from the repo root:
//   bash <scratchpad>/run-smoke.sh scripts/smoke-bug-batch-safety.ts

import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MessagingPlatform, MessageFormat } from '../src/services/messaging/types';
import type { MessageOptions } from '../src/services/messaging/types';
import type { ParsedEvent } from '../src/services/event-parser';
import { REDIS_KEYS } from '../src/config/redis-keys';

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

// ---- The bot's texts, read from the files ----

type Lang = 'en' | 'he' | 'ru';
const LANGS: Lang[] = ['en', 'he', 'ru'];
const FILES: Record<Lang, Row> = Object.fromEntries(
  LANGS.map(l => [l, JSON.parse(fs.readFileSync(path.join(ROOT, `messages/${l}.json`), 'utf8'))])
) as Record<Lang, Row>;

/** A bot text by path in a language, failing the check by name when the key is missing. */
function botText(lang: Lang, keyPath: string): string {
  let cur: unknown = FILES[lang].bot;
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
    if (k === 'OR') return (cond as Row[]).some(w => matches(row, w));
    if (k === 'AND') return (cond as Row[]).every(w => matches(row, w));
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
    deleteMany: async (a: Row = {}) => {
      guard('deleteMany');
      const keep = table().filter(x => !matches(x, a.where));
      const count = table().length - keep.length;
      DB[name] = keep;
      return { count };
    },
    delete: async (a: Row) => {
      guard('delete');
      const r = table().find(x => matches(x, a.where));
      if (!r) throw Object.assign(new Error(`No ${name} record`), { code: 'P2025' });
      DB[name] = table().filter(x => x !== r);
      return { ...r };
    },
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
/** The bot's card edits and answers on Telegram: what the person's card now says. */
const edits: { chatId: unknown; messageId: unknown; text: string; options?: Row }[] = [];
let voiceIntents: Row[] = [];
let voiceTranscription = '';

/** What the calendar provider answers to a create, edit or delete: `providerAnswer`, or the next of `providerScript` first. */
let providerAnswer: Row = { success: true, eventId: 'ev-1' };
const providerScript: Row[] = [];
const providerCalls: string[] = [];
/** The people whose copies to Google the hard delete carried out (the worker is faked). */
const carried: number[] = [];
/** The summary pass: who it is asked about, and what it did (generated, counted, marked sent, flagged unreachable). */
let scheduled: number[] = [];
const generated: string[] = [];
const usage: string[] = [];
const marks: { userId: number; type: string }[] = [];
const unreachable: number[] = [];
/** The calendar a new card goes to (a FamCal one unless a check says Google). */
let newCalendarId = 'native:home1';

const tgService = {
  sendMessage: async (chatId: unknown, text: string, options?: Row) => { sent.push({ via: 'telegram', method: 'sendMessage', chatId, text, options }); return 500 + sent.length; },
  updateMessage: async (chatId: unknown, _id: unknown, text: string, options?: Row) => { sent.push({ via: 'telegram', method: 'updateMessage', chatId, text, options }); },
  sendTypingIndicator: async () => {},
};
const waService = {
  sendMessage: async (chatId: unknown, text: string, options?: Row) => {
    sent.push({ via: 'whatsapp', method: 'sendMessage', chatId, text, options });
    return `wamid.out${sent.length}`;
  },
  sendTypingIndicator: async () => {},
  downloadMedia: async () => Buffer.from('OggS'),
};
/** The bot itself: the admin notifier's sends, and the card edits of the callbacks. */
const fakeBot = {
  sendMessage: async (chatId: unknown, text: string, options?: Row) => { sent.push({ via: 'bot', method: 'sendMessage', chatId, text, options }); return { message_id: 1 }; },
  answerCallbackQuery: async () => true,
  editMessageText: async (text: string, options: Row) => { edits.push({ chatId: options.chat_id, messageId: options.message_id, text, options }); return true; },
};

// ---- Fixtures ----

const DAY = 86_400_000;

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
const WA_RU = '+972500000004';
const WA_HE = '+972500000005';

function reset() {
  for (const k of Object.keys(DB)) delete DB[k];
  redisStore.clear();
  failing.clear();
  for (const list of [sent, logs, captured, tracked, edits, providerCalls, providerScript]) list.length = 0;
  newCalendarId = 'native:home1';
  fetchHandler = async url => { throw new Error(`network blocked in this smoke: ${url}`); };
  carried.length = 0;
  scheduled = [];
  for (const list of [generated, usage, marks, unreachable]) list.length = 0;
  voiceIntents = [];
  voiceTranscription = '';
  providerAnswer = { success: true, eventId: 'ev-1' };
  DB.user = [
    baseUser({ id: 1, name: 'Noa', telegramId: BigInt(TG_EN), language: 'en' }),
    baseUser({ id: 2, name: 'Dana', telegramId: BigInt(TG_HE), language: 'he' }),
    baseUser({ id: 3, name: 'Olga', telegramId: BigInt(TG_RU), language: 'ru' }),
    baseUser({ id: 4, name: 'Irina', messagingPlatform: 'whatsapp', whatsappPhone: WA_RU, language: 'ru' }),
    baseUser({ id: 5, name: 'Yael', messagingPlatform: 'whatsapp', whatsappPhone: WA_HE, language: 'he' }),
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

const answerNext = (call: string) => { providerCalls.push(call); return { ...(providerScript.shift() ?? providerAnswer) }; };
const provider = {
  name: 'native',
  createEvent: async () => answerNext('create'),
  updateEvent: async () => answerNext('update'),
  deleteEvent: async () => answerNext('delete'),
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
    checkFeatureAccess: async () => ({ allowed: true }),
    incrementUsage: async (userId: number, kind: string) => { usage.push(`${userId}:${kind}`); },
    invalidateFeatureAccessCache: async () => undefined,
    getSubscriptionWithUsage: async () => null,
  },
  [`${SRC}/services/reminder-cache.ts`]: {
    removeUserFromCache: async () => undefined, syncReminderCacheEntry: async () => undefined, getVoiceAutoCreateHighConf: async () => false, getVoiceTtsOutcome: async () => false,
  },
  // The proved user is the one the URL names (the credential check has its own smokes)
  [`${SRC}/lib/rate-limit.ts`]: {
    settingsRateLimiter: {}, commandRateLimiter: {}, generalRateLimiter: {}, tokenPollRateLimiter: {},
    checkRateLimit: async () => ({ success: true, limit: 99, remaining: 99, reset: 0 }),
    getRateLimitHeaders: () => ({}),
  },
  [`${SRC}/lib/api-auth.ts`]: {
    verifyUserAuth: async (_req: unknown, userId: string | null) => {
      const { getUserById } = await import('../src/services/user-service');
      const user = await getUserById(Number(userId));
      return user ? { success: true, user } : { success: false, response: new Response('{}', { status: 404 }) };
    },
  },
  [`${SRC}/services/magic-link.ts`]: { generateMagicLink: async () => 'https://famcal.test/magic' },
  [`${SRC}/services/native-calendar/onboarding.ts`]: { ensurePrimaryNativeCalendar: async () => undefined, hasGoogleChoices: () => false },
  [`${SRC}/lib/user-reachability.ts`]: {
    clearUserUnreachable: async () => undefined,
    markUnreachableAfterSendFailure: async (user: { id: number }) => { unreachable.push(user.id); },
    markUnreachableAfterWhatsAppFailure: async () => false,
  },
  [`${SRC}/services/calendar-provider/index.ts`]: {
    getCalendarAssignmentsForUser: async () => [{ calendarId: 'native:home1', labels: ['yours'], name: 'Home', color: '#039BE5' }],
    hasUsableCalendar: async () => true,
    createCalendarFor: async (_user: unknown, event: { calendarId?: string }) => event.calendarId ?? newCalendarId,
    providerForCalendar: () => provider,
  },
  // The summary pass: the people it is asked about, and what it reads
  [`${SRC}/services/user-service.ts`]: (real: Record<string, unknown>) =>
    fakeOver(real, {
      getAllUsers: async () => {
        const { getUserById } = real as { getUserById: (id: number) => Promise<unknown> };
        return Promise.all(scheduled.map(id => getUserById(id)));
      },
    }),
  [`${SRC}/services/calendar-read/digest.ts`]: (real: Record<string, unknown>) => fakeOver(real, { readDigestDay: async () => [] }),
  [`${SRC}/services/native-reminders/open-reminders.ts`]: { addDigestReminders: async (_u: unknown, events: unknown[]) => ({ events, moreCount: 0 }) },
  [`${SRC}/services/week-lookahead.ts`]: { getWeekLookahead: async () => ({ events: [] }), formatTomorrowLookahead: () => '' },
  [`${SRC}/services/claude.ts`]: {
    generateSummary: async (...args: unknown[]) => { generated.push(String(args[3])); return 'AI summary'; },
    formatDateHeader: () => 'Date header',
  },
  [`${SRC}/services/telegram/voice.ts`]: { sendVoiceMessage: async () => undefined, sendWeeklyVoiceMessage: async () => undefined },
  [`${SRC}/services/kid-name-detection.ts`]: { sendKidNameFollowUp: async () => undefined },
  [`${SRC}/lib/summary-scheduling.ts`]: {
    filterUsersForSummary: async (users: unknown[]) => ({ eligible: users, skippedHour: 0, skippedDay: 0, skippedDedup: 0 }),
    markSummarySent: async (userId: number, type: string) => { marks.push({ userId, type }); },
  },
  // The hard delete carries out the copies in Google before it deletes: faked (it has its own smoke)
  [`${SRC}/services/google-sync/worker.ts`]: (real: Record<string, unknown>) => fakeOver(real, { carryOutCopiesBeforeDelete: async (userId: number) => { carried.push(userId); } }),
  [`${SRC}/lib/timezone.ts`]: { resolveUserTimezone: async () => 'Asia/Jerusalem', resolveLocation: async () => null, LOOKUP_TIMEOUT_MS: 3000, TIMEZONE_CACHE_TTL: 86_400 },
  [`${SRC}/services/zmanim/pause.ts`]: (real: Record<string, unknown>) => fakeOver(real, { isPaused: async () => false }),
  // The voice path
  [`${SRC}/services/native-reminders/support.ts`]: { getReminderSupport: async () => ({ supported: true }), canReceiveReminderPings: async () => false },
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
/** Every request the code under test makes goes here; a check sets its own answer. Never the network. */
let fetchHandler: (url: string, init?: RequestInit) => Promise<Response> = async url => { throw new Error(`network blocked in this smoke: ${url}`); };
globalThis.fetch = (async (input: unknown, init?: RequestInit) => fetchHandler(String(input), init)) as typeof fetch;

// ---- Driving the webhooks ----

type Responded = { status: number; body: unknown };
function res(into: Responded[]) {
  return { status: (code: number) => ({ json: (body: unknown) => { into.push({ status: code, body }); } }) };
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
const waAudio = (from: string) => whatsappMessage(from, { type: 'audio', audio: { id: `media-${++seq}` } });

const sentTo = (via: Sent['via']) => sent.filter(s => s.via === via);

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

/** What the providers say when a write fails, as the real ones say it: Prisma's text, a rule parser's, Google's English. */
const PRISMA_TEXT = 'Invalid `prisma.nativeEvent.create()` invocation: Unique constraint failed on the fields: (`id`)';
const RAW_ID = 'native:cmgx9k1q50003abcd';

function person(id: number, o: Row = {}): Row {
  const row = DB.user.find(u => u.id === id)!;
  return { ...row, telegramId: row.telegramId == null ? null : Number(row.telegramId), ...o };
}

function sampleEvent(): ParsedEvent {
  const start = new Date(Date.now() + DAY);
  return { title: 'Dentist', startTime: start, endTime: new Date(start.getTime() + 3_600_000), allDay: false, confidence: 'high' } as ParsedEvent;
}

function calendarEvent() {
  const start = new Date(Date.now() + DAY);
  return { eventId: 'native:ev1', summary: 'Dentist', start: start.toISOString(), end: new Date(start.getTime() + 3_600_000).toISOString(), calendarId: 'native:home1' };
}

/** A card waiting for its tap, as the voice flow leaves it in Redis. */
async function pending(kind: 'event' | 'edit' | 'delete', userId: number, calendarId = 'native:home1'): Promise<string> {
  const id = `p${++seq}`;
  // A person with a Google token when the card is for a Google calendar (the tap asks them to connect first otherwise)
  const user = person(userId, calendarId.startsWith('native:') ? {} : { googleRefreshToken: 'google-token' });
  const value =
    kind === 'event' ? { event: { ...sampleEvent(), calendarId }, user, transcription: 'x' }
    : kind === 'edit' ? { originalEvent: calendarEvent(), calendarId, updates: { title: 'Dentist 2' }, user, transcription: 'x' }
    : { event: calendarEvent(), calendarId, user, transcription: 'x' };
  const key = kind === 'event' ? REDIS_KEYS.pendingEvent(id) : kind === 'edit' ? REDIS_KEYS.pendingEdit(id) : REDIS_KEYS.pendingDelete(id);
  await redisImpl.set(key, value);
  return id;
}

const lastEdit = () => edits[edits.length - 1]?.text ?? '';

/** The Telegram tap on a card's confirm button, and the card's final text. */
async function tapTelegram(kind: 'event' | 'edit' | 'delete', userId: number, calendarId?: string): Promise<string> {
  const callbacks = await import('../src/services/voice/callbacks');
  const id = await pending(kind, userId, calendarId);
  const chat = Number(DB.user.find(u => u.id === userId)!.telegramId);
  await withLogs(async () => {
    if (kind === 'event') await callbacks.handleEventCallback(chat, 10, 'q', 'create', id);
    else if (kind === 'edit') await callbacks.handleEditCallback(chat, 10, 'q', 'confirm', id);
    else await callbacks.handleDeleteCallback(chat, 10, 'q', 'confirm', id);
  });
  return lastEdit();
}

/** The WhatsApp tap on a card's confirm button, and what the person was sent. */
async function tapWhatsApp(kind: 'event' | 'edit' | 'delete', userId: number): Promise<Sent> {
  const id = await pending(kind, userId);
  const phone = DB.user.find(u => u.id === userId)!.whatsappPhone as string;
  const action = kind === 'event' ? 'event_create' : kind === 'edit' ? 'edit_confirm' : 'delete_confirm';
  sent.length = 0;
  await withLogs(() => waText(phone, `${action}:${id}`));
  const reply = sentTo('whatsapp').find(s => s.chatId === phone);
  assert(reply, `nothing was sent to ${phone}`);
  return reply;
}

/** Text the person must never see after a failed write: the provider's own words and the bare codes. */
const FORBIDDEN = [PRISMA_TEXT, 'Invalid `prisma', 'Unique constraint', 'Not a native calendar id', RAW_ID, 'UNKNOWN_ERROR', 'NOT_FOUND', 'NOT_CONNECTED', 'HEBREW_REPEAT', 'FIXED_DAYS'];
function assertClean(text: string, label: string): void {
  for (const bad of FORBIDDEN) assert(!text.includes(bad), `${label} shows "${bad}":\n${text}`);
}

const ACTIONS = ['create', 'update', 'delete'] as const;
const FAILED_KEY = { create: 'failedToCreate', update: 'failedToUpdate', delete: 'failedToDelete' } as const;

async function fix1() {
  await check('1: writeFailureText gives each failure its sentence in the person\'s language, and never the provider\'s own text', async () => {
    const { writeFailureText } = await import('../src/services/voice/write-failure');
    const { getBotMessages } = await import('../src/lib/bot-messages');
    for (const lang of LANGS) {
      const t = await getBotMessages(lang);
      for (const action of ACTIONS) {
        const text = (error: string | undefined, extra: Row = {}) => writeFailureText({ error: error as never, errorMessage: PRISMA_TEXT, ...extra }, t, action, { userId: 1 });
        assertSame(text('NOT_FOUND'), botText(lang, 'voice.eventNotFound'), `${lang} ${action}: NOT_FOUND`);
        assertSame(text('FIXED_DAYS'), botText(lang, 'voice.fixedDaysMove'), `${lang} ${action}: FIXED_DAYS`);
        assertSame(text('NOT_CONNECTED'), botText(lang, 'voice.googleNotConnected'), `${lang} ${action}: NOT_CONNECTED`);
        assertSame(text('HEBREW_REPEAT'), botText(lang, 'voice.googleNoHebrewRepeat'), `${lang} ${action}: HEBREW_REPEAT`);
        assertSame(text('UNKNOWN_ERROR', { retryable: true }), botText(lang, 'voice.writeRetry'), `${lang} ${action}: a retryable failure`);
        const generic = `${botText(lang, `voice.${FAILED_KEY[action]}`)}\n\n${botText(lang, 'voice.unknownError')}`;
        assertSame(text('UNKNOWN_ERROR'), generic, `${lang} ${action}: UNKNOWN_ERROR`);
        assertSame(text(undefined), generic, `${lang} ${action}: no code`);
        assertSame(text('FORBIDDEN'), generic, `${lang} ${action}: a code with no sentence of its own`);
        for (const error of ['NOT_FOUND', 'FIXED_DAYS', 'NOT_CONNECTED', 'HEBREW_REPEAT', 'UNKNOWN_ERROR', undefined]) assertClean(text(error), `${lang} ${action} ${error}`);
      }
    }
  });

  await check('1: writeFailureText logs "[voice-write] <action> failed code=<code> retryable=<bool>: <message>"', async () => {
    const { writeFailureText } = await import('../src/services/voice/write-failure');
    const { getBotMessages } = await import('../src/lib/bot-messages');
    const t = await getBotMessages('en');
    await withLogs(async () => { writeFailureText({ error: 'UNKNOWN_ERROR', errorMessage: PRISMA_TEXT, retryable: true }, t, 'update', { userId: 7, calendarId: 'native:home1' }); });
    const line = logs.find(l => l.startsWith('[voice-write]'));
    assert(line, `no [voice-write] line: ${show(logs)}`);
    assert(line.includes('update failed code=UNKNOWN_ERROR retryable=true') && line.includes(PRISMA_TEXT), `the line: ${line}`);
  });

  await check('1: Telegram: a failed create, edit or delete shows the translated text, not the provider\'s (he, ru, en)', async () => {
    for (const [lang, id] of [['he', 2], ['ru', 3], ['en', 1]] as [Lang, number][]) {
      for (const kind of ['event', 'edit', 'delete'] as const) {
        const action = kind === 'event' ? 'create' : kind === 'edit' ? 'update' : 'delete';
        providerAnswer = { success: false, error: 'UNKNOWN_ERROR', errorMessage: PRISMA_TEXT };
        const generic = await tapTelegram(kind, id);
        assertSame(generic, `${botText(lang, `voice.${FAILED_KEY[action]}`)}\n\n${botText(lang, 'voice.unknownError')}`, `${lang} ${action}: the card`);
        assertClean(generic, `${lang} ${action}`);
        providerAnswer = { success: false, error: 'NOT_FOUND', errorMessage: `Not a native calendar id: ${RAW_ID}` };
        const notFound = await tapTelegram(kind, id);
        assertSame(notFound, botText(lang, 'voice.eventNotFound'), `${lang} ${action}: NOT_FOUND`);
        providerAnswer = { success: false, error: 'UNKNOWN_ERROR', errorMessage: 'Rate Limit Exceeded', retryable: true };
        const retry = await tapTelegram(kind, id);
        assertSame(retry, botText(lang, 'voice.writeRetry'), `${lang} ${action}: a retryable failure`);
        providerAnswer = { success: false, error: 'NOT_CONNECTED', errorMessage: 'Cannot create event: Google Calendar is not connected.' };
        const gone = await tapTelegram(kind, id);
        assertSame(gone, botText(lang, 'voice.googleNotConnected'), `${lang} ${action}: NOT_CONNECTED`);
        assertClean(gone, `${lang} ${action} NOT_CONNECTED`);
      }
    }
  });

  await check('1: Telegram: the branches that carry a button stay (permission, expired token, refused)', async () => {
    const google = 'google-cal-id';
    providerAnswer = { success: false, error: 'PERMISSION_DENIED', errorMessage: 'insufficient scopes' };
    const card = await tapTelegram('event', 1, google);
    assertSame(card, `${botText('en', 'voice.permissionRequired')}\n\n${botText('en', 'voice.permissionMessage')}`, 'PERMISSION_DENIED on a Google calendar');
    assert(edits[edits.length - 1].options?.reply_markup, 'the grant-access button is gone');
    providerAnswer = { success: false, error: 'TOKEN_EXPIRED', errorMessage: 'invalid_grant' };
    const expired = await tapTelegram('edit', 1, google);
    assertSame(expired, `${botText('en', 'voice.accessExpired')}\n\n${botText('en', 'voice.accessExpiredMessage')}`, 'TOKEN_EXPIRED');
    assert(edits[edits.length - 1].options?.reply_markup, 'the re-authorize button is gone');
    providerAnswer = { success: false, error: 'FORBIDDEN', errorMessage: 'Forbidden' };
    assertSame(await tapTelegram('delete', 1, google), botText('en', 'nativeReminders.permissionDenied'), 'FORBIDDEN');
  });

  await check('1: WhatsApp: a failed create, edit or delete shows the translated text with no code (he, ru, en)', async () => {
    const { MessageFormat: Format } = await import('../src/services/messaging/types');
    for (const [lang, id] of [['he', 5], ['ru', 4]] as [Lang, number][]) {
      for (const kind of ['event', 'edit', 'delete'] as const) {
        const action = kind === 'event' ? 'create' : kind === 'edit' ? 'update' : 'delete';
        providerAnswer = { success: false, error: 'UNKNOWN_ERROR', errorMessage: PRISMA_TEXT };
        const reply = await tapWhatsApp(kind, id);
        assertSame(reply.text, `${botText(lang, `voice.${FAILED_KEY[action]}`)}\n\n${botText(lang, 'voice.unknownError')}`, `${lang} ${action}: the reply`);
        assert(reply.options?.format === Format.HTML, `${lang} ${action}: the reply is not sent as HTML (its <b> would show): ${show(reply.options)}`);
        assertClean(reply.text, `${lang} ${action}`);
        providerAnswer = { success: false, error: 'NOT_FOUND', errorMessage: 'Not a native calendar id' };
        assertSame((await tapWhatsApp(kind, id)).text, botText(lang, 'voice.eventNotFound'), `${lang} ${action}: NOT_FOUND`);
        providerAnswer = { success: false, error: 'UNKNOWN_ERROR', errorMessage: 'x', retryable: true };
        assertSame((await tapWhatsApp(kind, id)).text, botText(lang, 'voice.writeRetry'), `${lang} ${action}: a retryable failure`);
      }
    }
  });

  await check('1: WhatsApp: a high-confidence voice create that fails shows the translated text', async () => {
    providerAnswer = { success: false, error: 'UNKNOWN_ERROR', errorMessage: PRISMA_TEXT };
    voiceTranscription = 'dentist tomorrow';
    voiceIntents = [{ intent: 'create', confidence: 'high', event: sampleEvent() }];
    await withLogs(() => waAudio(WA_HE));
    const failure = sentTo('whatsapp').find(s => s.text.includes(botText('he', 'voice.failedToCreate')));
    assert(failure, `no failure reply: ${show(sentTo('whatsapp').map(s => s.text))}`);
    assertSame(failure.text, `${botText('he', 'voice.failedToCreate')}\n\n${botText('he', 'voice.unknownError')}`, 'the reply');
    assertClean(failure.text, 'the voice create');
  });

  await check('1: WhatsApp: a bulk auto-create where one fails lists that failure with a sentence, not a code', async () => {
    providerScript.push({ success: true, eventId: 'ev-1' }, { success: false, error: 'NOT_FOUND', errorMessage: 'Not a native calendar id' });
    voiceTranscription = 'two things tomorrow';
    voiceIntents = [
      { intent: 'create', confidence: 'high', event: { ...sampleEvent(), title: 'Dentist' } },
      { intent: 'create', confidence: 'high', event: { ...sampleEvent(), title: 'Haircut' } },
    ];
    await withLogs(() => waAudio(WA_HE));
    const summary = sentTo('whatsapp').map(s => s.text).find(text => text.includes('Haircut'));
    assert(summary, `no bulk summary: ${show(sentTo('whatsapp').map(s => s.text))}`);
    assert(summary.includes(botText('he', 'voice.eventNotFound')), `the failure has no sentence of its own:\n${summary}`);
    assertClean(summary, 'the WhatsApp bulk summary');
  });

  await check('1: the Telegram bulk card lists each failure with a sentence, not a code or an English reason', async () => {
    const { setPendingBatch } = await import('../src/services/voice/bulk-confirmations');
    const callbacks = await import('../src/services/voice/callbacks');
    // One create succeeds, one fails: the partial summary names the failure
    providerScript.push({ success: true, eventId: 'ev-1' }, { success: false, error: 'NOT_FOUND', errorMessage: `Not a native calendar id: ${RAW_ID}` });
    await setPendingBatch('b1', {
      user: person(2) as never,
      transcription: 'x',
      intents: [
        { intent: 'create', confidence: 'high', event: { ...sampleEvent(), title: 'Dentist' } },
        { intent: 'create', confidence: 'high', event: { ...sampleEvent(), title: 'Haircut' } },
      ] as never,
    });
    await withLogs(() => callbacks.handleBulkCallback(TG_HE, 10, 'q', 'confirm', 'b1'));
    const card = lastEdit();
    assert(card.includes('Haircut'), `the failed event is not named:\n${card}`);
    assert(card.includes(botText('he', 'voice.eventNotFound')), `the failure has no sentence of its own:\n${card}`);
    assertClean(card, 'the bulk card');
  });

  await check('1: the Google provider answers a Hebrew repeat with HEBREW_REPEAT', async () => {
    const { googleProvider } = await import('../src/services/calendar-provider/google-provider');
    const start = new Date(Date.now() + DAY);
    const result = await withLogs(() => googleProvider.createEvent(
      person(1) as never,
      'primary',
      { title: 'Yahrzeit', startTime: start, endTime: start, hebrewRule: 'anniversary', hebrewAnchor: '2026-10-29' } as never
    ));
    assert(result.success === false && result.error === 'HEBREW_REPEAT', `got ${show(result)}`);
  });

  await check('1: the native provider answers a calendar id that is not native with NOT_FOUND on create, update and delete', async () => {
    const { nativeProvider } = await import('../src/services/calendar-provider/native-provider');
    const start = new Date(Date.now() + DAY);
    const user = person(1) as never;
    const created = await nativeProvider.createEvent(user, 'google-cal-id', { title: 'x', startTime: start, endTime: start });
    const updated = await nativeProvider.updateEvent(user, 'google-cal-id', 'e', { title: 'y' });
    const deleted = await nativeProvider.deleteEvent(user, 'google-cal-id', 'e');
    for (const [name, result] of [['create', created], ['update', updated], ['delete', deleted]] as [string, Row][]) {
      assert(result.success === false && result.error === 'NOT_FOUND', `${name}: got ${show(result)}`);
    }
  });
}

// ---- Fix 2 ----

async function fix2() {
  const { encrypt } = await import('../src/utils/encryption');
  const REVOKE = 'https://oauth2.googleapis.com/revoke';
  const GOOGLE_USER = 6;
  const revokes: { token: string | null; carried: boolean; stillThere: boolean }[] = [];
  /** Google's answer to a revoke: set by the check. */
  let answer: () => Response = () => new Response('{}', { status: 200 });
  const watchGoogle = () => {
    revokes.length = 0;
    fetchHandler = async (url, init) => {
      assert(url === REVOKE, `a request to ${url}`);
      revokes.push({
        token: new URLSearchParams(String(init?.body)).get('token'),
        carried: carried.includes(GOOGLE_USER),
        stillThere: DB.user.some(u => u.id === GOOGLE_USER),
      });
      return answer();
    };
  };
  const addGoogleUser = (token: string) => {
    DB.user.push(baseUser({ id: GOOGLE_USER, name: 'Tal', telegramId: BigInt(1006), language: 'en', googleRefreshToken: token ? encrypt(token) : '' }));
  };

  await check('2: the hard delete revokes the person\'s Google token at Google, after carrying out their copies and before the row goes', async () => {
    addGoogleUser('refresh-token-6');
    answer = () => new Response('{}', { status: 200 });
    watchGoogle();
    const { hardDeleteUser } = await import('../src/lib/user-moderation');
    await withLogs(() => hardDeleteUser(GOOGLE_USER, 1));
    assertSame(revokes, [{ token: 'refresh-token-6', carried: true, stillThere: true }], 'the revoke call (the token, the copies carried out first, the row still there)');
    assert(!DB.user.some(u => u.id === GOOGLE_USER), 'the person was not deleted');
    assertSame(captured, [], 'something was captured');
  });

  await check('2: a revoke Google refuses is logged and captured, and the delete goes on', async () => {
    addGoogleUser('refresh-token-6');
    answer = () => new Response(JSON.stringify({ error: 'invalid_request' }), { status: 400 });
    watchGoogle();
    const { hardDeleteUser } = await import('../src/lib/user-moderation');
    await withLogs(() => hardDeleteUser(GOOGLE_USER, 1));
    assert(revokes.length === 1, `expected one revoke call, got ${revokes.length}`);
    assert(!DB.user.some(u => u.id === GOOGLE_USER), 'the person was not deleted after the revoke failed');
    assert(captured.some(c => c.startsWith('google-disconnect-revoke')), `not captured: ${show(captured)}`);
    assert(logs.some(l => l.includes('revoking a token failed') && l.includes(`user ${GOOGLE_USER}`)), `not logged: ${show(logs)}`);
    assert(logs.some(l => l.includes('[Moderation]') && l.includes('could not be revoked')), `the delete does not say it went on: ${show(logs)}`);
  });

  await check('2: a revoke that gets no answer at all is logged and captured, and the delete goes on', async () => {
    addGoogleUser('refresh-token-6');
    watchGoogle();
    const handler = fetchHandler;
    fetchHandler = async (url, init) => { await handler(url, init); throw new Error('socket hang up'); };
    const { hardDeleteUser } = await import('../src/lib/user-moderation');
    await withLogs(() => hardDeleteUser(GOOGLE_USER, 1));
    assert(!DB.user.some(u => u.id === GOOGLE_USER), 'the person was not deleted');
    assert(captured.some(c => c.startsWith('google-disconnect-revoke')), `not captured: ${show(captured)}`);
  });

  await check('2: a person with no Google token is deleted without any call to Google', async () => {
    addGoogleUser('');
    watchGoogle();
    const { hardDeleteUser } = await import('../src/lib/user-moderation');
    await withLogs(() => hardDeleteUser(GOOGLE_USER, 1));
    assertSame(revokes, [], 'a call to Google');
    assert(!DB.user.some(u => u.id === GOOGLE_USER), 'the person was not deleted');
  });

  await check('2: Disconnect Google uses the same exported call (one revoke path)', async () => {
    const source = fs.readFileSync(path.join(SRC, 'services/google-disconnect.ts'), 'utf8');
    assert(/export async function revokeGoogleToken\(/.test(source), 'revokeGoogleToken is not exported');
    assert(!/\brevokeToken\(/.test(source), 'google-disconnect.ts still has its own revokeToken');
    const moderation = fs.readFileSync(path.join(SRC, 'lib/user-moderation.ts'), 'utf8');
    assert(/revokeGoogleToken/.test(moderation), 'the hard delete does not use revokeGoogleToken');
  });
}

// ---- Fix 3 ----

const WA_PHONE = (id: number) => `+9725000010${String(id).padStart(2, '0')}`;
const TG_OF = (id: number) => 2000 + id;

/** A person with the channels asked for and the platform they saved. */
function addDelivery(id: number, saved: string, channels: { telegram: boolean; whatsapp: boolean }, o: Row = {}): void {
  DB.user.push(baseUser({
    id, name: `Person ${id}`, language: 'en', messagingPlatform: saved,
    telegramId: channels.telegram ? BigInt(TG_OF(id)) : null,
    whatsappPhone: channels.whatsapp ? WA_PHONE(id) : null,
    ...o,
  }));
}

async function runBatch(tomorrow = false) {
  const summary = await import('../src/services/telegram/summary');
  return withLogs(() => (tomorrow ? summary.sendTomorrowSummaryToAll({ filterByHour: true }) : summary.sendDailySummaryToAll({ filterByHour: true })));
}
const templatesTo = (chatId: string) => sentTo('whatsapp').filter(s => s.options?.whatsappTemplate && s.chatId === chatId);

async function fix3() {
  await check('3: deliveryPlatformFor narrows the saved platform to the channels the person has', async () => {
    const { deliveryPlatformFor } = await import('../src/lib/delivery-platform');
    const TG = { telegramId: 1n };
    const WA = { whatsappPhone: '+972500000001' };
    const BSUID = { whatsappBsuid: 'IL.abc' };
    const cases: [string, Row, string | null][] = [
      ['telegram', { ...TG }, 'telegram'], ['telegram', { ...TG, ...WA }, 'telegram'], ['telegram', { ...WA }, 'whatsapp'], ['telegram', { ...BSUID }, 'whatsapp'],
      ['whatsapp', { ...WA }, 'whatsapp'], ['whatsapp', { ...BSUID, ...TG }, 'whatsapp'], ['whatsapp', { ...TG }, 'telegram'], ['whatsapp', { ...TG, ...WA }, 'whatsapp'],
      ['all', { ...TG, ...WA }, 'all'], ['all', { ...TG, ...BSUID }, 'all'], ['all', { ...TG }, 'telegram'], ['all', { ...WA }, 'whatsapp'],
      ['telegram', {}, null], ['whatsapp', {}, null], ['all', {}, null],
      ['', { ...TG }, 'telegram'], ['', { ...WA }, 'whatsapp'], ['', { ...TG, ...WA }, 'telegram'],
      ['whatsapp', { telegramId: 0n, whatsappPhone: '', whatsappBsuid: null }, null],
    ];
    for (const [saved, channels, want] of cases) {
      assertSame(deliveryPlatformFor({ messagingPlatform: saved, ...channels }), want, `saved ${show(saved)} with ${show(channels)}`);
    }
    assertSame(deliveryPlatformFor({ telegramId: 5 }), 'telegram', 'no platform saved at all');
    assertSame(deliveryPlatformFor({ messagingPlatform: null, whatsappPhone: '+1' }), 'whatsapp', 'null platform, WhatsApp only');
  });

  await check('3: platformAvailable accepts only a platform whose every channel the person has', async () => {
    const { platformAvailable } = await import('../src/lib/delivery-platform');
    const both = { telegramId: 1n, whatsappPhone: '+1' };
    const tgOnly = { telegramId: 1n };
    const waOnly = { whatsappBsuid: 'IL.x' };
    const cases: [unknown, Row, boolean][] = [
      ['telegram', both, true], ['whatsapp', both, true], ['all', both, true],
      ['telegram', tgOnly, true], ['whatsapp', tgOnly, false], ['all', tgOnly, false],
      ['telegram', waOnly, false], ['whatsapp', waOnly, true], ['all', waOnly, false],
      ['sms', both, false], ['', both, false], [undefined, both, false], [7, both, false],
    ];
    for (const [platform, user, want] of cases) assertSame(platformAvailable(platform, user), want, `${show(platform)} for ${show(user)}`);
  });

  await check('3: a scheduled summary reaches a Telegram person whose saved platform is whatsapp (generated once, counted once, marked sent)', async () => {
    addDelivery(11, 'whatsapp', { telegram: true, whatsapp: false });
    scheduled = [11];
    const result = await runBatch();
    assertSame(sentTo('telegram').filter(s => s.method === 'sendMessage').map(s => [s.chatId, s.text]), [[TG_OF(11), 'AI summary']], 'the Telegram text');
    assertSame(sentTo('whatsapp'), [], 'a WhatsApp send to a person with no WhatsApp');
    assertSame(generated.length, 1, 'summaries generated');
    assertSame(usage, ['11:textSummaries'], 'usage counted');
    assertSame(marks, [{ userId: 11, type: 'daily' }], 'the dedup mark');
    assert(result.processed === 1, `processed ${result.processed}`);
  });

  await check('3: a scheduled summary reaches a WhatsApp person whose saved platform is telegram, as the tap-to-open template alone (not generated, not counted)', async () => {
    addDelivery(12, 'telegram', { telegram: false, whatsapp: true });
    scheduled = [12];
    const result = await runBatch();
    assertSame(templatesTo(WA_PHONE(12)).map(s => (s.options?.whatsappTemplate as Row).buttonPayload), ['summary'], 'the template');
    assertSame(generated, [], 'the summary was generated');
    assertSame(usage, [], 'a summary was counted');
    assertSame(sentTo('telegram'), [], 'a Telegram send to a person with no Telegram');
    assertSame(marks, [{ userId: 12, type: 'daily' }], 'the dedup mark');
    assert(result.processed === 1, `processed ${result.processed}`);
  });

  await check('3: "all" with one channel delivers on that channel; with both it is unchanged (Telegram text and the WhatsApp template); a saved "telegram" with both stays Telegram only', async () => {
    addDelivery(13, 'all', { telegram: true, whatsapp: false });
    addDelivery(14, 'all', { telegram: false, whatsapp: true });
    addDelivery(15, 'telegram', { telegram: true, whatsapp: true });
    addDelivery(16, 'all', { telegram: true, whatsapp: true });
    scheduled = [13, 14, 15, 16];
    const result = await runBatch();
    const texts = sentTo('telegram').filter(s => s.method === 'sendMessage').map(s => s.chatId).sort();
    assertSame(texts, [TG_OF(13), TG_OF(15), TG_OF(16)].sort(), 'who got a Telegram text');
    const templates = sentTo('whatsapp').filter(s => s.options?.whatsappTemplate).map(s => s.chatId).sort();
    assertSame(templates, [WA_PHONE(14), WA_PHONE(16)].sort(), 'who got the WhatsApp template');
    assertSame(generated.length, 3, 'summaries generated (not for the WhatsApp-only person)');
    assertSame(usage.sort(), ['13:textSummaries', '15:textSummaries', '16:textSummaries'], 'usage counted');
    assert(result.processed === 4, `processed ${result.processed}`);
  });

  await check('3: a person with neither Telegram nor WhatsApp gets nothing, costs no generation, and is skipped with a log line', async () => {
    addDelivery(17, 'whatsapp', { telegram: false, whatsapp: false });
    scheduled = [17];
    const result = await runBatch();
    assertSame(sent.length, 0, 'sends');
    assertSame(generated, [], 'generated');
    assertSame(marks, [], 'marked');
    assert(result.processed === 0, `processed ${result.processed}`);
    assert(logs.some(l => l.includes('Skipping user 17') && l.includes('no Telegram and no WhatsApp')), `no log line: ${show(logs.slice(-6))}`);
  });

  await check('3: routeTextMessage with no platform given follows the narrowed platform (a saved whatsapp with only Telegram still gets the text)', async () => {
    addDelivery(18, 'whatsapp', { telegram: true, whatsapp: false });
    const { routeTextMessage } = await import('../src/services/telegram/summary');
    const { getUserById } = await import('../src/services/user-service');
    const user = (await getUserById(18))!;
    await withLogs(() => routeTextMessage(user.telegramId!, 'hello', user));
    assertSame(sentTo('telegram').filter(s => s.method === 'sendMessage').map(s => [s.chatId, s.text]), [[TG_OF(18), 'hello']], 'the Telegram send');
    addDelivery(19, 'telegram', { telegram: false, whatsapp: true });
    sent.length = 0;
    const waUser = (await getUserById(19))!;
    await withLogs(() => routeTextMessage(WA_PHONE(19), 'hello', waUser));
    assertSame(sentTo('whatsapp').map(s => [s.chatId, s.text]), [[WA_PHONE(19), 'hello']], 'the WhatsApp send');
  });

  await check('3: the inviter is told of an accepted invitation on the channel they have (a saved telegram with only WhatsApp)', async () => {
    addDelivery(20, 'telegram', { telegram: false, whatsapp: true });
    const { notifyInviterOfAccept } = await import('../src/services/telegram/pair-handler');
    await withLogs(() => notifyInviterOfAccept(20, 'Dana'));
    assertSame(templatesTo(WA_PHONE(20)).length, 1, 'the WhatsApp template to the inviter');
    assertSame(sentTo('telegram'), [], 'a Telegram send');
  });

  await check('3: /api/settings refuses a platform the person does not have with 400 platform_unavailable, writes nothing and logs it; a platform they have is saved', async () => {
    const { POST } = await import('../app/api/settings/route');
    const post = async (userId: number, body: Row) => {
      const request = new Request(`https://famcal.test/api/settings?user_id=${userId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const response = await withLogs(() => POST(request as never));
      return { status: response.status, body: (await response.json()) as Row };
    };
    addDelivery(21, 'telegram', { telegram: true, whatsapp: false });
    addDelivery(22, 'whatsapp', { telegram: false, whatsapp: true });
    addDelivery(23, 'all', { telegram: true, whatsapp: true });
    const refused: [number, string][] = [[21, 'whatsapp'], [21, 'all'], [22, 'telegram'], [22, 'all'], [21, 'sms']];
    for (const [id, platform] of refused) {
      logs.length = 0;
      const answer = await post(id, { messagingPlatform: platform, weatherEnabled: true });
      assertSame([answer.status, answer.body], [400, { error: 'platform_unavailable' }], `${id} asking for ${platform}`);
      assert(DB.user.find(u => u.id === id)!.weatherEnabled === false, `${id} asking for ${platform}: the rest of the request was saved`);
      assert(logs.some(l => l.includes(`user ${id} asked for platform`) && l.includes('refused')), `${id} asking for ${platform}: no log line: ${show(logs)}`);
    }
    for (const [id, platform] of [[21, 'telegram'], [22, 'whatsapp'], [23, 'all'], [23, 'whatsapp'], [23, 'telegram']] as [number, string][]) {
      const answer = await post(id, { messagingPlatform: platform });
      assertSame([answer.status, answer.body], [200, { success: true }], `${id} asking for ${platform}`);
      assertSame(DB.user.find(u => u.id === id)!.messagingPlatform, platform, `${id}: the saved platform`);
    }
    // A save that sends no platform leaves the saved one alone, whatever it is
    const quiet = await post(21, { weatherEnabled: true });
    assertSame(quiet.status, 200, 'a save with no platform');
  });

  await check('3: the Settings page gets the platform the summaries really go to, and the choice only for a person with both channels', async () => {
    const { loadPageData } = await import('../src/lib/page-data');
    const open = async (id: number) => {
      const user = (await (await import('../src/services/user-service')).getUserById(id))!;
      const page = await withLogs(() => loadPageData('settings', user, id, 'en'));
      assert(page.kind === 'props', `the page: ${show(page)}`);
      const props = page.props as { currentSettings: { messagingPlatform: string }; bothChannels: boolean };
      return { platform: props.currentSettings.messagingPlatform, both: props.bothChannels };
    };
    addDelivery(24, 'whatsapp', { telegram: true, whatsapp: false });
    addDelivery(25, 'telegram', { telegram: false, whatsapp: true });
    addDelivery(26, 'all', { telegram: true, whatsapp: true });
    addDelivery(27, 'whatsapp', { telegram: true, whatsapp: true });
    assertSame(await open(24), { platform: 'telegram', both: false }, 'saved whatsapp, only Telegram');
    assertSame(await open(25), { platform: 'whatsapp', both: false }, 'saved telegram, only WhatsApp');
    assertSame(await open(26), { platform: 'all', both: true }, 'both channels, saved all');
    assertSame(await open(27), { platform: 'whatsapp', both: true }, 'both channels, saved whatsapp');
  });
}

async function main() {
  const original = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  const keep = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  Object.assign(console, { log: keep, warn: keep, error: keep, info: keep });
  try {
    await fix1();
    await fix2();
    await fix3();
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

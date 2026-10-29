// Smoke test for the bug batch of 2026-10-28, Task 2 (docs/superpowers/plans/2026-10-28-bug-batch.md): the bot's words.
// One check family per fix, each in English, Hebrew and Russian where the language matters:
//
//   1. Two wrong key paths sent English to everyone: the native /start welcome (it read `t.start.nativeWelcome`, the keys
//      are under `onboarding`) and the Pro-only message for voice events (it read the bot's `subscription`, where the key
//      was not): on Telegram's voice, forwarded-text and photo paths and on WhatsApp's voice path.
//   2. An expired card answers in the person's language, not English: the create, edit, delete, bulk and quick-fix
//      cards, a reply correction, and the kid-name question; a person the bot cannot read the language of gets English.
//   3. The renewal reminders name the plan in the person's language.
//   4. Weather words: one table of condition names in the messages (the weather-only message, the infographic and the
//      fallback forecast read it); the fallback forecast is in the person's language and in HTML.
//   5. The delete card's recurring-event line speaks of the events in the plural in Hebrew.
//   6. Russian: the pickup alert, and the day plural of "in N days".
//
// The real handlers, callbacks, summary pass, reminders and the formatter run. Faked: Prisma (in memory), Redis (in
// memory), both messaging services and the bot (every send is recorded), the forecast data (a fixture), the model
// (down), analytics, error capture and the pause. No network, no database.
//
// Run with the fake env (never the real one), from the repo root:
//   bash <scratchpad>/run-smoke.sh scripts/smoke-bug-batch-words.ts

import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MessagingPlatform, MessageFormat } from '../src/services/messaging/types';
import type { MessageOptions } from '../src/services/messaging/types';
import { policyLinks, type PolicyWords } from '../src/lib/plan-disclosure';

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
const MSG: Record<Lang, Row> = Object.fromEntries(
  LANGS.map(l => [l, JSON.parse(fs.readFileSync(path.join(ROOT, `messages/${l}.json`), 'utf8')).bot])
) as Record<Lang, Row>;

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
      if ('lt' in cond && !(v != null && num(v) < num(cond.lt))) return false;
      if ('lte' in cond && !(v != null && num(v) <= num(cond.lte))) return false;
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
    findMany: async (a: Row = {}) => {
      guard('findMany');
      const rows = table().filter(x => matches(x, a.where)).map(x => ({ ...x }));
      if (a.include?.user) for (const r of rows) r.user = { ...(DB.user ?? []).find(u => u.id === r.userId) };
      return rows;
    },
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
/** The features the person's plan lacks. */
const deniedFeatures = new Set<string>();
let pausedIds = new Set<number>();
/** The person has no calendar, so the scheduled pass sends weather alone. */
let noCalendars = false;
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
  answerCallbackQuery: async (_queryId: string, options?: Row) => { sent.push({ via: 'bot', method: 'answerCallbackQuery', chatId: null, text: String(options?.text ?? ''), options }); return true; },
  editMessageText: async (text: string, options?: Row) => { sent.push({ via: 'bot', method: 'editMessageText', chatId: options?.chat_id, text, options }); return true; },
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
const WA_NO_TELEGRAM = '+972500000007';

function reset() {
  for (const k of Object.keys(DB)) delete DB[k];
  redisStore.clear();
  failing.clear();
  for (const list of [sent, logs, captured, tracked, usage, generated, marks, unreachable, voiceSent, created]) list.length = 0;
  templateFails = false;
  deniedFeatures.clear();
  pausedIds = new Set();
  noCalendars = false;
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
    checkFeatureAccess: async (_userId: number, feature: string) => ({ allowed: !deniedFeatures.has(feature), reason: 'plan' }),
    incrementUsage: async (userId: number, kind: string) => { usage.push(`${userId}:${kind}`); },
    invalidateFeatureAccessCache: async () => undefined,
  },
  [`${SRC}/services/reminder-cache.ts`]: { getEarlyAdoptionMode: async () => false, removeUserFromCache: async () => undefined, getVoiceAutoCreateHighConf: async () => false, getVoiceTtsOutcome: async () => false },
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
    getCalendarAssignmentsForUser: async () => (noCalendars ? [] : [{ calendarId: 'native:home1', labels: ['yours'], name: 'Home', color: '#039BE5' }]),
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
  // The weather pass and the forecast: the data comes from a fixture, the model is down (so the fallback text is what is sent)
  [`${SRC}/services/weather/geocoding.ts`]: (real: Record<string, unknown>) => fakeOver(real, { getTimezone: async () => 'Asia/Jerusalem' }),
  [`${SRC}/services/weather/open-meteo.ts`]: (real: Record<string, unknown>) => fakeOver(real, { fetchWeather: async () => forecast() }),
  [`${SRC}/services/weather/air-quality.ts`]: { fetchAirQuality: async () => null },
  [`${SRC}/services/ai-provider.ts`]: (real: Record<string, unknown>) =>
    fakeOver(real, { generateAICompletion: async () => { throw new Error('the model is down (smoke)'); } }),
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
const waAudio = (from: string) => whatsappMessage(from, { type: 'audio', audio: { id: `media-${++seq}` } });

const sentTo = (via: Sent['via']) => sent.filter(s => s.via === via);

// ---- Helpers for this smoke ----

const ALL: Record<Lang, Row> = Object.fromEntries(LANGS.map(l => [l, JSON.parse(fs.readFileSync(path.join(ROOT, `messages/${l}.json`), 'utf8'))])) as Record<Lang, Row>;

/** A text by path anywhere in a language's messages file (the top-level `subscription`, for example). */
function fileText(lang: Lang, keyPath: string): string {
  let cur: unknown = ALL[lang];
  for (const key of keyPath.split('.')) cur = (cur as Row | undefined)?.[key];
  assert(typeof cur === 'string' && cur !== '', `${keyPath} is missing in messages/${lang}.json`);
  return cur as string;
}

/** The person to act as, by language: their Telegram id and their row in the fake database. */
const PEOPLE: Record<Lang, { tg: number; uid: number }> = { en: { tg: TG_EN, uid: 1 }, he: { tg: TG_HE, uid: 2 }, ru: { tg: TG_RU, uid: 3 } };
const userRow = (id: number): Row => DB.user.find(u => u.id === id)!;
const botCalls = (method: string) => sent.filter(s => s.via === 'bot' && s.method === method);

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

/** English phrases the old code wrote into a Hebrew or Russian person's message. */
const ENGLISH_WORDS = /Weather for|Current Conditions|Temperature|feels like|Humidity|Sunrise|Sunset|Rain probability|Rain expected|Next 12 Hours|7-Day|Forecast|Tomorrow|Today|\bHigh\b|\bLow\b|Moderate|Breezy|Strong winds|Sunscreen|\bWind\b|Max UV|UV Index|km\/h/;

/** The forecast of the fixture, with its hours moved to the coming hours so the fallback lists them. */
function forecast(): Row {
  const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/fixtures/weather-en-dust-storm.json'), 'utf8'));
  const weather = fixture.weather as Row;
  const pad = (n: number) => String(n).padStart(2, '0');
  weather.hourly.time = (weather.hourly.time as string[]).map((_t, i) => {
    const d = new Date(Date.now() + (i + 1) * 3_600_000);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00`;
  });
  weather.hourly.windSpeed = (weather.hourly.windSpeed as number[]).map(() => 30);
  return weather;
}

// ---- Fix 1 ----

async function fix1() {
  for (const lang of LANGS) {
    await check(`1: the first /start of a person with no location is the onboarding welcome in ${lang}, then the policy links (the legal review of 2026-10-29), with its button`, async () => {
      const { tg, uid } = PEOPLE[lang];
      userRow(uid).location = '';
      const { handleStartCommand } = await import('../src/services/telegram/commands');
      await withLogs(() => handleStartCommand(tg, tg, MessagingPlatform.TELEGRAM));
      const out = sentTo('telegram');
      assert(out.length === 1, `expected one message, got ${out.length}`);
      const welcome = botText(lang, 'onboarding.nativeWelcome').replace('{platform}', 'Telegram').replace('{name}', String(userRow(uid).name));
      const want = `${welcome}\n\n${policyLinks(MSG[lang].policy as PolicyWords, lang, 'html')}`;
      assertSame(out[0].text, want, `${lang}: the welcome`);
      const buttons = (out[0].options?.replyMarkup as Row | undefined)?.inline_keyboard?.[0];
      assertSame(buttons?.map((b: Row) => b.text), [botText(lang, 'onboarding.nativeLocationButton')], `${lang}: the button`);
    });
  }

  await check('1: the Hebrew welcome is the text the owner approved', () => {
    assertSame(
      botText('he', 'onboarding.nativeWelcome'),
      '👋 היי {name}, היומן שלכם כבר מוכן ב־{platform}. ספרו לי איפה אתם גרים, כדי שמזג האוויר ואזורי הזמן יהיו נכונים.',
      'bot.onboarding.nativeWelcome (he)'
    );
  });

  for (const lang of LANGS) {
    for (const via of ['voice', 'forwarded text', 'photo'] as const) {
      await check(`1: a plan without voice events gets the bot's Pro message in ${lang} (${via})`, async () => {
        const { tg } = PEOPLE[lang];
        deniedFeatures.add('voice_events');
        const from = { id: tg, first_name: 'T' };
        if (via === 'voice') {
          const { handleVoiceMessage } = await import('../src/services/voice/handler');
          await withLogs(() => handleVoiceMessage(tg, tg, { file_id: 'f', duration: 3, file_size: 1000 } as never, from));
        } else if (via === 'forwarded text') {
          const { handleForwardedMessage } = await import('../src/services/forward-event/handler');
          await withLogs(() => handleForwardedMessage(tg, tg, 'Dinner with Sam on Friday at 8', from));
        } else {
          const { handleMediaMessage } = await import('../src/services/image-event/handler');
          await withLogs(() => handleMediaMessage(tg, tg, from, [{ fileId: 'f', mimeType: 'image/jpeg', kind: 'image' }]));
        }
        const out = botCalls('sendMessage').filter(s => s.chatId === tg);
        assert(out.length === 1, `expected one message, got ${out.length}: ${show(out.map(s => s.text))}`);
        assertSame(out[0].text, botText(lang, 'subscription.voiceEventsRequired'), `${lang}: the Pro message`);
        const button = (out[0].options?.reply_markup as Row | undefined)?.inline_keyboard?.[0]?.[0]?.text;
        assertSame(button, botText(lang, 'subscription.upgradeButton'), `${lang}: the upgrade button`);
      });
    }
  }

  const WA_BY_LANG: Record<Lang, string> = { en: WA_NO_TELEGRAM, he: WA_HE, ru: WA_RU };
  for (const lang of LANGS) {
    await check(`1: WhatsApp's voice path says the Pro message in ${lang}`, async () => {
      deniedFeatures.add('voice_events');
      await withLogs(() => waAudio(WA_BY_LANG[lang]));
      const texts = sentTo('whatsapp').map(s => s.text);
      const pro = sentTo('whatsapp').find(s => s.text === botText(lang, 'subscription.voiceEventsRequired'));
      assert(pro, `${lang}: not among the WhatsApp replies: ${show(texts)}`);
      // The message is HTML (<b>): the adapter turns it into WhatsApp's own bold only when told so
      assert(pro.options?.format === 'html', `${lang}: sent without the HTML format, so WhatsApp shows the raw tags: ${show(pro.options)}`);
    });
  }

  await check('1: WhatsApp\'s "voice events are off" reply goes out as HTML, so the bold is WhatsApp\'s and not raw tags', async () => {
    const row = DB.user.find(u => u.whatsappPhone === WA_HE)!;
    const before = row.voiceInputEnabled;
    row.voiceInputEnabled = false;
    try {
      await withLogs(() => waAudio(WA_HE));
      const off = sentTo('whatsapp').find(s => s.text === botText('he', 'voice.featureDisabled'));
      assert(off, `not sent: ${show(sentTo('whatsapp').map(s => s.text.slice(0, 40)))}`);
      assert(off.options?.format === 'html', `sent without the HTML format: ${show(off.options)}`);
    } finally {
      row.voiceInputEnabled = before;
    }
  });

  await check('1: the Hebrew Pro message asks nobody in the masculine', () => {
    const text = botText('he', 'subscription.voiceEventsRequired');
    assert(!/שדרג\b/.test(text), `still "שדרג": ${text}`);
    assert(text.includes('אפשר לשדרג ל־Pro'), `not the approved wording: ${text}`);
  });
}

// ---- Fix 2 ----

async function fix2() {
  const q = 'cbq-1';
  type Case = { name: string; run: (chatId: number) => Promise<void>; answer?: string; edit: string };
  const cases: Case[] = [
    { name: 'a create card that has expired', run: async chatId => { const { handleEventCallback } = await import('../src/services/voice/callbacks'); await handleEventCallback(chatId, 5, q, 'create', 'gone'); }, answer: 'voice.expired', edit: 'voice.expiredMessage' },
    { name: 'an edit card that has expired', run: async chatId => { const { handleEditCallback } = await import('../src/services/voice/callbacks'); await handleEditCallback(chatId, 5, q, 'confirm', 'gone'); }, answer: 'voice.expired', edit: 'voice.expiredMessage' },
    { name: 'a delete card that has expired', run: async chatId => { const { handleDeleteCallback } = await import('../src/services/voice/callbacks'); await handleDeleteCallback(chatId, 5, q, 'confirm', 'gone'); }, answer: 'voice.expired', edit: 'voice.expiredMessage' },
    { name: 'a bulk card that has expired', run: async chatId => { const { handleBulkCallback } = await import('../src/services/voice/callbacks'); await handleBulkCallback(chatId, 5, q, 'confirm', 'gone'); }, edit: 'voice.expiredMessage' },
    { name: 'a bulk card cancelled after it expired', run: async chatId => { const { handleBulkCallback } = await import('../src/services/voice/callbacks'); await handleBulkCallback(chatId, 5, q, 'cancel', 'gone'); }, edit: 'voice.bulkCancelled' },
    { name: 'a quick-fix button that has expired', run: async chatId => { const { handleQuickFixCallback } = await import('../src/services/voice/callbacks'); await handleQuickFixCallback(chatId, 5, q, 'time', 'gone'); }, edit: 'voice.expiredMessage' },
    { name: 'a bulk-edit button that has expired', run: async chatId => { const { handleBulkEditCallback } = await import('../src/services/voice/callbacks'); await handleBulkEditCallback(chatId, 5, q, 0, 'gone'); }, edit: 'voice.batchExpired' },
    { name: 'a kid-name question that has expired', run: async chatId => { const { handleKidNameCallback } = await import('../src/services/kid-name-callbacks'); await handleKidNameCallback(chatId, 5, q, 'kidname_yes', 'gone'); }, answer: 'kidNameDetection.expired', edit: 'kidNameDetection.expired' },
  ];
  for (const lang of LANGS) {
    for (const c of cases) {
      await check(`2: ${c.name} answers in ${lang}`, async () => {
        await withLogs(() => c.run(PEOPLE[lang].tg));
        const edits = botCalls('editMessageText');
        assert(edits.length === 1, `expected one edit, got ${edits.length}`);
        assertSame(edits[0].text, botText(lang, c.edit), `${lang}: the edited card`);
        if (c.answer) {
          const answers = botCalls('answerCallbackQuery');
          assert(answers.length === 1, `expected one answer, got ${answers.length}`);
          assertSame(answers[0].text, botText(lang, c.answer), `${lang}: the answer to the tap`);
        }
      });
    }

    await check(`2: a reply correction to an expired card answers in ${lang}`, async () => {
      const { tg } = PEOPLE[lang];
      const { handleEventCorrection } = await import('../src/services/voice/correction-handler');
      await withLogs(() => handleEventCorrection(tg, tg, 'gone', 5, { text: 'make it 9' }));
      const out = sentTo('telegram').filter(s => s.chatId === tg);
      assertSame(out.map(s => s.text), [botText(lang, 'voice.expiredMessage')], `${lang}: the reply`);
    });
  }

  await check('2: the batch-expired line is the approved text in all three languages', () => {
    assertSame(botText('en', 'voice.batchExpired'), '⏰ This list has expired. Send a new voice message.', 'en');
    assertSame(botText('he', 'voice.batchExpired'), '⏰ פג התוקף של הרשימה הזו. שלחו הודעה קולית חדשה.', 'he');
    assertSame(botText('ru', 'voice.batchExpired'), '⏰ Срок действия этого списка истёк. Отправьте новое голосовое сообщение.', 'ru');
  });

  await check('2: the old English literals are gone from the voice callbacks', () => {
    const code = fs.readFileSync(path.join(SRC, 'services/voice/callbacks.ts'), 'utf8');
    assert(!code.includes('This confirmation has expired.') && !code.includes('This batch has expired.'), 'a literal "has expired" is still there');
  });

  await check('2: getBotMessagesForTelegramUser reads the language; a stranger and a failing lookup get English, the failure is logged', async () => {
    const { getBotMessagesForTelegramUser } = await import('../src/lib/bot-messages');
    assertSame((await getBotMessagesForTelegramUser(TG_HE)).voice.expired, botText('he', 'voice.expired'), 'a Hebrew speaker');
    assertSame((await getBotMessagesForTelegramUser(TG_RU)).voice.expired, botText('ru', 'voice.expired'), 'a Russian speaker');
    assertSame((await getBotMessagesForTelegramUser(TG_STRANGER)).voice.expired, botText('en', 'voice.expired'), 'a stranger');
    failing.add('user.findUnique');
    logs.length = 0;
    const kept = console.error;
    console.error = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    let afterFailure: Row;
    try {
      afterFailure = await getBotMessagesForTelegramUser(TG_HE);
    } finally {
      console.error = kept;
    }
    assertSame(afterFailure.voice.expired, botText('en', 'voice.expired'), 'a failing lookup');
    assert(logs.some(l => l.includes('[bot-messages]') && l.includes(String(TG_HE))), `the failure was not logged: ${show(logs)}`);
  });
}

// ---- Fix 3 ----

async function fix3() {
  for (const lang of LANGS) {
    const { tg, uid } = PEOPLE[lang];
    const planName = () => fileText(lang, 'subscription.plans.basic.name');
    const subscription = (periodEnd: Date): Row => ({
      id: `sub-${uid}`, userId: uid, plan: 'BASIC', status: 'ACTIVE', compedBy: null, telegramPaymentChargeId: 'chg',
      currentPeriodStart: new Date(Date.now() - 27 * DAY), currentPeriodEnd: periodEnd,
    });

    await check(`3: the three-day renewal reminder names the plan in ${lang}`, async () => {
      DB.subscription = [subscription(new Date(Date.now() + 2.5 * DAY))];
      const { processSubscriptionReminders } = await import('../src/services/subscription-reminders');
      await withLogs(() => processSubscriptionReminders());
      const out = sentTo('telegram').filter(s => s.chatId === String(tg));
      assert(out.length === 1, `expected one reminder, got ${out.length}: ${show(sentTo('telegram').map(s => [s.chatId, s.text.slice(0, 40)]))}`);
      assert(out[0].text.includes(planName()), `${lang}: the plan name "${planName()}" is not in:\n${out[0].text}`);
      if (lang !== 'en') assert(!out[0].text.includes('Basic'), `${lang}: "Basic" in:\n${out[0].text}`);
    });

    await check(`3: the reminder before a plan ends says it ends (plans never renew by themselves) and counts in ${lang}'s plural forms`, async () => {
      DB.subscription = [subscription(new Date(Date.now() + 1.5 * DAY))];
      DB.usageCounter = [{ id: `uc-${uid}`, userId: uid, textSummariesUsed: 1, voiceSummariesUsed: 1, voiceEventsCreated: 2 }];
      try {
        const { processSubscriptionReminders } = await import('../src/services/subscription-reminders');
        await withLogs(() => processSubscriptionReminders());
        const out = sentTo('telegram').filter(s => s.chatId === String(tg));
        assert(out.length === 1, `expected one reminder, got ${out.length}`);
        const want = {
          en: ['ends in 2 days', '1 text summary', '1 voice message', '2 voice-created events'],
          he: ['מסתיים בעוד יומיים', 'סיכום טקסט אחד', 'הודעה קולית אחת', 'שני אירועים שנוצרו בקול'],
          ru: ['закончится через 2 дня', '1 текстовую сводку', '1 голосовое сообщение', '2 события, созданных голосом'],
        }[lang];
        for (const w of want) assert(out[0].text.includes(w), `${lang}: "${w}" is not in:\n${out[0].text}`);
        assert(!/renews|מתחדש|продлевается|\{/.test(out[0].text), `${lang}: a renewal claim or a raw placeholder in:\n${out[0].text}`);
      } finally {
        DB.usageCounter = [];
      }
    });

    await check(`3: the subscription-ended notice names the plan on its button in ${lang}`, async () => {
      DB.subscription = [subscription(new Date(Date.now() - 3_600_000))];
      const { processSubscriptionReminders } = await import('../src/services/subscription-reminders');
      await withLogs(() => processSubscriptionReminders());
      const out = sentTo('telegram').filter(s => s.chatId === String(tg));
      assert(out.length === 1, `expected one notice, got ${out.length}`);
      const button = (out[0].options?.replyMarkup as Row | undefined)?.inline_keyboard?.[0]?.[0]?.text as string;
      assert(button.includes(planName()), `${lang}: the plan name "${planName()}" is not on the button: ${button}`);
      if (lang !== 'en') assert(!button.includes('Basic'), `${lang}: "Basic" on the button: ${button}`);
    });
  }
}

// ---- Fix 4 ----

const WMO_CODES = [0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99];

async function fix4() {
  await check('4: describeWeather: English is the old wording, Hebrew and Russian name every code in their own letters, no two codes alike', async () => {
    const { describeWeather, getWeatherDescription } = await import('../src/services/weather/open-meteo');
    const { getBotMessages } = await import('../src/lib/bot-messages');
    const t = { en: await getBotMessages('en'), he: await getBotMessages('he'), ru: await getBotMessages('ru') };
    for (const code of WMO_CODES) assertSame(describeWeather(code, t.en), getWeatherDescription(code), `en, code ${code}`);
    for (const lang of ['he', 'ru'] as const) {
      const names = WMO_CODES.map(code => describeWeather(code, t[lang]));
      const letters = lang === 'he' ? /[\u05D0-\u05EA]/ : /\p{Script=Cyrillic}/u;
      names.forEach((name, i) => assert(letters.test(name) && !/[A-Za-z]{3,}/.test(name), `${lang}, code ${WMO_CODES[i]}: "${name}"`));
      assert(new Set(names).size === names.length, `${lang}: two codes share a name: ${show(names)}`);
    }
    assertSame(describeWeather(1234, t.he), botText('he', 'weatherConditions.unknown'), 'a code nobody knows');
  });

  for (const lang of ['he', 'ru'] as const) {
    await check(`4: the weather-only message names the condition in ${lang}`, async () => {
      const { uid, tg } = PEOPLE[lang];
      Object.assign(userRow(uid), { location: 'Beersheba', weatherEnabled: true });
      noCalendars = true;
      scheduled = [uid];
      const { sendDailySummaryToAll } = await import('../src/services/telegram/summary');
      await withLogs(() => sendDailySummaryToAll());
      const out = sentTo('telegram').filter(s => s.chatId === BigInt(tg) || String(s.chatId) === String(tg));
      assert(out.length === 1, `expected one weather message, got ${out.length}`);
      assert(!out[0].text.includes('Partly cloudy'), `${lang}: the condition is in English:\n${out[0].text}`);
      assert(out[0].text.includes(botText(lang, 'weatherConditions.partlyCloudy')), `${lang}: the condition is not the message's:\n${out[0].text}`);
    });
  }

  for (const lang of LANGS) {
    await check(`4: the forecast sent when the model is down is in ${lang} and in HTML`, async () => {
      const { formatWeatherAI } = await import('../src/services/weather/formatter');
      const result = await withLogs(() => formatWeatherAI(forecast() as never, lang, 'Dana', 'Asia/Jerusalem', 'default', false, false, null, new Date()));
      const text = result.brief;
      assertSame(result.detailed, text, 'the voice text is the same fallback');
      assert(!text.includes('*'), `a markdown asterisk in an HTML message:\n${text}`);
      assert(text.includes('<b>'), `no HTML bold:\n${text}`);
      assert(text.includes(botText(lang, 'weatherFallback.title').replace('{location}', 'Beersheba, Israel')), `${lang}: no title:\n${text}`);
      for (const key of ['weatherOnly.current', 'weatherOnly.today', 'weatherOnly.tomorrow', 'weatherFallback.next12Hours', 'weatherFallback.forecast7Days', 'weatherFallback.sunrise', 'weatherFallback.humidity']) {
        assert(text.includes(botText(lang, key)), `${lang}: "${botText(lang, key)}" (bot.${key}) is not in:\n${text}`);
      }
      assert(text.includes(botText(lang, 'weatherConditions.partlyCloudy')), `${lang}: the condition is not named in ${lang}:\n${text}`);
      if (lang !== 'en') assert(!ENGLISH_WORDS.test(text), `${lang}: English in the fallback (${ENGLISH_WORDS.exec(text)?.[0]}):\n${text}`);
    });
  }

  await check('4: the fallback\'s next 12 hours start at the place\'s next hour, whatever zone the server runs in', async () => {
    // A person in New York at 06:30 their time (10:30 UTC); the smoke's process runs in Jerusalem. Open-Meteo's hours are
    // New York wall times, so the list starts at 07:00. Parsing them in the server's zone would start it hours off.
    const weather = forecast();
    const pad = (n: number) => String(n).padStart(2, '0');
    weather.hourly.time = (weather.hourly.time as string[]).map((_t, i) => `2026-10-${pad(29 + Math.floor(i / 24))}T${pad(i % 24)}:00`);
    const { formatWeatherAI } = await import('../src/services/weather/formatter');
    const result = await withLogs(() => formatWeatherAI(weather as never, 'en', 'Dana', 'America/New_York', 'default', false, false, null, new Date('2026-10-29T10:30:00Z')));
    const after = result.brief.split(botText('en', 'weatherFallback.next12Hours'))[1] ?? '';
    const firstHour = after.split('\n').find((l) => /^\d\d:00/.test(l));
    assert(firstHour?.startsWith('07:00'), `the first hour is not 07:00: ${firstHour}\n${result.brief}`);
  });

  await check('4: the infographic reads the conditions from the messages, not from a table of its own', () => {
    const code = fs.readFileSync(path.join(SRC, 'services/weather/infographic.tsx'), 'utf8');
    assert(!code.includes('getLocalizedWeatherDescription'), 'the infographic still has its own table');
    assert(code.includes('describeWeather('), 'the infographic does not call describeWeather');
  });

  await check('4: the Russian sharav word is the same everywhere', () => {
    const formatter = fs.readFileSync(path.join(SRC, 'services/weather/formatter.ts'), 'utf8');
    assert(!/хамсин/i.test(formatter), 'the formatter still says хамсин');
    assert(/Шарав/i.test(formatter), 'the formatter does not say Шарав');
  });
}

// ---- Fix 5 ----

async function fix5() {
  await check('5: the delete card in Hebrew says the events of the series "will be deleted" in the plural', async () => {
    const { showDeleteConfirmation } = await import('../src/services/voice/confirmations');
    const { tg, uid } = PEOPLE.he;
    const event = { summary: 'Swimming', start: '2026-11-03T17:00:00+02:00', end: '2026-11-03T18:00:00+02:00', calendarName: 'Home', calendarId: 'native:home1', recurringEventId: 'series-1' };
    for (const scope of ['all', 'following'] as const) {
      sent.length = 0;
      await withLogs(() => showDeleteConfirmation(tg, undefined, event as never, 'native:home1', 'delete swimming', { id: uid, name: 'Dana', language: 'he' } as never, scope));
      const text = botCalls('sendMessage')[0]?.text ?? '';
      assert(text.includes('יימחקו:'), `${scope}: not the plural "יימחקו": ${text}`);
      assert(!/ימחק:/.test(text), `${scope}: still the singular "ימחק": ${text}`);
    }
  });
}

// ---- Fix 6 ----

async function fix6() {
  for (const [type, isAuto, want] of [
    ['pickup', false, 'Напоминание: пора забирать — Маша'],
    ['pickup', true, 'Авто-напоминание: пора забирать — Маша'],
  ] as const) {
    await check(`6: the Russian ${isAuto ? 'auto ' : ''}pickup alert names the pickup, not a fence`, async () => {
      const { sendReminder } = await import('../src/services/reminders');
      const user = { ...(await (await import('../src/services/user-service')).getUserById(3))!, messagingPlatform: 'telegram' };
      const eventTime = new Date(Date.now() + 30 * 60_000);
      const reminder = {
        event: { summary: 'Swimming', start: eventTime.toISOString(), end: new Date(+eventTime + 3_600_000).toISOString(), calendarName: 'Маша', calendarId: 'native:kid', eventId: 'ev-1' },
        type, reminderTime: new Date(), eventTime, isAutoReminder: isAuto, sentKeyDate: '2026-10-28',
      };
      const ok = await withLogs(() => sendReminder(user as never, reminder as never, 'Asia/Jerusalem'));
      assert(ok, 'the reminder was not sent');
      const text = sentTo('telegram')[0]?.text ?? '';
      assert(text.includes(want), `not "${want}":\n${text}`);
      assert(!/забор/.test(text), `still about a fence:\n${text}`);
    });
  }

  await check('6: "in N days" in Russian takes the form of the number', async () => {
    const { getRelativeLabel } = await import('../src/services/claude');
    const expected: Record<number, string> = { 2: 'Через 2 дня', 3: 'Через 3 дня', 4: 'Через 4 дня', 5: 'Через 5 дней', 11: 'Через 11 дней', 12: 'Через 12 дней', 21: 'Через 21 день', 22: 'Через 22 дня', 25: 'Через 25 дней', 101: 'Через 101 день' };
    for (const [n, want] of Object.entries(expected)) assertSame(getRelativeLabel(Number(n), 'ru'), want, `ru, ${n} days`);
    assertSame(getRelativeLabel(0, 'ru'), 'Сегодня', 'today');
    assertSame(getRelativeLabel(1, 'ru'), 'Завтра', 'tomorrow');
    assertSame(getRelativeLabel(3, 'en'), 'In 3 days', 'en');
    assertSame(getRelativeLabel(3, 'he'), 'בעוד 3 ימים', 'he');
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
    await fix4();
    await fix5();
    await fix6();
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

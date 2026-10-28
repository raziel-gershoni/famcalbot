// Smoke test for reminders by zman made by voice and text (zman reminders by voice plan, Tasks 5 and 6):
//   - resolution (src/services/native-reminders/resolve.ts): the model's zman mapped under the WRITER's community, the
//     recipient's clock (the partner's own place and zone for a reminder for them alone), the day per rule or per
//     choice (the next time that has not passed, or the day said), the notice counted at the rule's time (not at the
//     09:00 reminder time), the pause note read through isPaused, the three refusals, the choices on the pending event
//     and the tap that makes one of them the rule;
//   - the create path: reminderCreateFields carries the rule (never unchosen choices), the native provider passes it
//     to the store and refuses a zman the writer's set does not offer, and every native_reminder_created says by_zman;
//   - the questions a refused zman reminder gets, in en/he/ru;
//   - the whole flow (Task 9), in en/he/ru: the model's JSON -> the parser -> the voice handler (map, resolve with the
//     real clock) -> the card and its buttons on Telegram -> the tap through the webhook -> the real native provider's
//     create fields -> the reply; plus the plain-reminder control and the refusals' questions.
//
// The zman clock and the pause are the real ones (hebcal, places from the fixtures' coordinates). Prisma, Redis, the
// timezone lookups, Telegram, the AI and the store's writes are faked. No network: a fetch throws.
// Process zone: this file re-runs itself once per server zone (UTC, Asia/Jerusalem, America/New_York) as child
// processes; nothing here may depend on the one the process has.
//   npx tsx scripts/smoke-zman-voice.ts

import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTranslator } from 'next-intl';
import { instantToWallTime, wallTimeToInstant } from '../src/utils/wall-time';
import { zmanRuleWords } from '../src/lib/calendar-view/zman-words';
import type { ZmanSpecValue } from '../src/lib/calendar-view/zman-spec';
import type { ParsedEvent, VoiceIntentResult } from '../src/services/event-parser';
import type { PartnerSummary } from '../src/services/native-reminders/ownership';
import type { CalendarAssignment, UserConfig } from '../src/types';

const ROOT = path.resolve(__dirname, '..');
const ZONES = ['UTC', 'Asia/Jerusalem', 'America/New_York'] as const;
const CHILD = 'ZMAN_VOICE_SMOKE_CHILD';

async function runChildren(): Promise<void> {
  const outputs = await Promise.all(
    ZONES.map(
      (zone) =>
        new Promise<{ zone: string; code: number; text: string }>((resolve) => {
          const child = spawn(process.execPath, [...process.execArgv, process.argv[1]], {
            env: { ...process.env, TZ: zone, [CHILD]: '1' },
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let text = '';
          child.stdout.on('data', (chunk) => (text += chunk));
          child.stderr.on('data', (chunk) => (text += chunk));
          child.on('close', (code) => resolve({ zone, code: code ?? 1, text }));
        }),
    ),
  );
  let failed = 0;
  for (const { zone, code, text } of outputs) {
    console.log(`\n===== process TZ=${zone} =====\n${text.trimEnd()}`);
    if (code !== 0) failed++;
  }
  console.log(`\n${ZONES.length - failed}/${ZONES.length} process zones passed (${ZONES.join(', ')})`);
  process.exit(failed === 0 ? 0 : 1);
}

// ---- Checks ----

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

async function check(name: string, fn: () => void | Promise<void>) {
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

const show = (v: unknown) => JSON.stringify(v);

// ---- Clock: argument-less new Date() and Date.now() read `clock` once a check sets it (null: the real one) ----

let clock: number | null = null;
const RealDate = Date;
class ClockDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(clock ?? RealDate.now());
    else super(...(args as [number, number, number, number, number, number, number]));
  }
  static now() {
    return clock ?? RealDate.now();
  }
}
globalThis.Date = ClockDate as unknown as DateConstructor;

// ---- Places, people, zones ----

const IL = 'Asia/Jerusalem';
const NY = 'America/New_York';
const TOKYO = 'Asia/Tokyo'; // no main city: with no saved place, nothing to count from
const OSLO = 'Europe/Oslo';
const HARISH = { location: 'Harish', latitude: 32.46182, longitude: 35.04555, elevationM: 270 };
const NEW_YORK = { location: 'New York', latitude: 40.7128, longitude: -74.006, elevationM: 10 };
const TROMSO = { location: 'Tromso', latitude: 69.6492, longitude: 18.9553, elevationM: 10 }; // polar night in December
const NOWHERE = { location: '', latitude: null, longitude: null, elevationM: null };

const dana = {
  id: 1, name: 'Dana', englishName: 'Dana', language: 'en', telegramId: 1001, calendarSource: 'NATIVE', pairingId: 'pair-1',
  isAdmin: false, voiceInputEnabled: true, googleRefreshToken: '', reminderTime: null, ...HARISH, zmanimCommunity: 'sephardi', pauseOnShabbat: true,
} as unknown as UserConfig;
const raziel: PartnerSummary = {
  id: 2, name: 'Raziel', englishName: 'Raziel', gender: 'male', telegramId: BigInt(1002), language: 'he', reminderTime: null,
  ...NEW_YORK, zmanimCommunity: 'ashkenazi', pauseOnShabbat: true,
};
let partner: PartnerSummary | null = raziel;
/** Each person's zone, as resolveUserTimezone answers (the fake). */
let zones: Record<number, string> = {};

const user = (over: Record<string, unknown>) => ({ ...dana, ...over }) as unknown as UserConfig;

// ---- Fakes ----

const created: Array<Record<string, unknown>> = [];
const logs: string[] = [];
/** What the user lookups asked for (the select of each findUnique). */
const selects: Array<Record<string, unknown> | undefined> = [];

/** Redis as Upstash behaves: values round-trip through JSON, so Dates come back as strings. */
const store = new Map<string, string>();
const fakeRedis = {
  get: async (key: string) => (store.has(key) ? JSON.parse(store.get(key)!) : null),
  set: async (key: string, value: unknown) => {
    store.set(key, JSON.stringify(value));
    return 'OK';
  },
  exists: async (key: string) => (store.has(key) ? 1 : 0),
  del: async (key: string) => (store.delete(key) ? 1 : 0),
};
type Sent = { method: string; text: string; opts?: Record<string, unknown> };
let botCalls: Sent[] = [];
const fakeBot = {
  sendMessage: async (_chatId: number, text: string, opts?: Record<string, unknown>) => {
    botCalls.push({ method: 'sendMessage', text, opts });
    return { message_id: 700 + botCalls.length };
  },
  editMessageText: async (text: string, opts?: Record<string, unknown>) => {
    botCalls.push({ method: 'editMessageText', text, opts });
    return true;
  },
  answerCallbackQuery: async (_id: string, opts?: Record<string, unknown>) => {
    botCalls.push({ method: 'answerCallbackQuery', text: String(opts?.text ?? ''), opts });
    return true;
  },
};
const fakeService = {
  sendMessage: async (_chatId: number | string, text: string, opts?: Record<string, unknown>) => {
    botCalls.push({ method: 'sendMessage', text, opts });
    return { messageId: String(900 + botCalls.length) };
  },
  sendTypingIndicator: async () => {},
  deleteMessage: async () => {},
  sendVoice: async () => {},
};
const tracked: Array<{ userId: number; action: string; metadata?: Record<string, unknown> }> = [];
/** The voice extraction: answers the intents the parser made from the model's JSON. */
let extracted: VoiceIntentResult[] = [];
/** The model for typed text: answers `geminiText` and keeps each prompt it was sent. */
let geminiText = '{}';
let geminiPrompts: string[] = [];
const fakeGemini = {
  models: {
    generateContent: async ({ contents }: { contents: Array<{ parts: Array<{ text?: string }> }> }) => {
      geminiPrompts.push(contents[0].parts.map((p) => p.text ?? '').join(''));
      return { text: geminiText, usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } };
    },
  },
};
let currentUser: UserConfig = dana;
function reset() {
  partner = raziel;
  zones = { 1: IL, 2: NY };
  created.length = 0;
  logs.length = 0;
  selects.length = 0;
  store.clear();
  botCalls = [];
  tracked.length = 0;
  extracted = [];
  geminiText = '{}';
  geminiPrompts = [];
  currentUser = dana;
  clock = null;
}

const fakeOver = (real: Record<string, unknown>, fakes: Record<string, unknown>) =>
  new Proxy(real, { get: (target, key) => (typeof key === 'string' && key in fakes ? fakes[key] : Reflect.get(target, key)) });

const SRC = path.resolve(ROOT, 'src');
/** The calendars the flow's person has: the main built-in one, as the store's id form. */
const FLOW_CALENDARS: CalendarAssignment[] = [{ calendarId: 'native:main-1', labels: ['primary', 'yours'], name: 'Dana', color: '#000000' }];
const stubs: Record<string, object | ((real: Record<string, unknown>) => object)> = {
  '@googleapis/calendar': { calendar: () => ({}), auth: { OAuth2: class {} } },
  [`${SRC}/utils/redis.ts`]: { redis: fakeRedis },
  [`${SRC}/utils/prisma.ts`]: {
    prisma: {
      user: {
        // The recipient a refresh reads by id: the partner (with their place), or nobody
        findUnique: async ({ where, select }: { where: { id: number }; select?: Record<string, unknown> }) => {
          selects.push(select);
          return partner && partner.id === where.id ? { ...partner } : null;
        },
      },
      pairing: { findUnique: async () => ({ status: 'ACTIVE', inviterUserId: 1, inviteeUserId: 2 }) },
    },
    withRetry: (fn: () => unknown) => fn(),
  },
  [`${SRC}/lib/error-capture.ts`]: { captureError: () => {}, captureWarning: () => {}, captureInfo: () => {} },
  [`${SRC}/lib/timezone.ts`]: {
    resolveUserTimezone: async (u: { id: number }) => zones[u.id] ?? IL,
    resolveLocation: async () => null,
    LOOKUP_TIMEOUT_MS: 3000,
    TIMEZONE_CACHE_TTL: 86_400,
  },
  [`${SRC}/services/weather/geocoding.ts`]: { fetchWithTimeout: async () => { throw new Error('the smoke reached the network'); } },
  [`${SRC}/services/ai-provider.ts`]: { generateAICompletion: async () => ({ text: '{}' }), getGemini: () => fakeGemini, extractionConfig: () => ({}) },
  [`${SRC}/services/telegram/index.ts`]: { getBot: () => fakeBot, getMessagingService: () => fakeService },
  [`${SRC}/services/telegram/bot.ts`]: { getBot: () => fakeBot, getMessagingService: () => fakeService },
  [`${SRC}/services/analytics-service.ts`]: {
    trackActivityAsync: (userId: number, action: string, metadata?: Record<string, unknown>) => tracked.push({ userId, action, metadata }),
    addBreadcrumb: () => {},
    setUserContext: () => {},
  },
  [`${SRC}/services/subscription-service.ts`]: { checkFeatureAccess: async () => ({ allowed: true }), incrementUsage: async () => {} },
  [`${SRC}/services/user-service.ts`]: { getUserByTelegramId: async () => currentUser },
  [`${SRC}/services/reminder-cache.ts`]: { getVoiceAutoCreateHighConf: async () => false, getVoiceTtsOutcome: async () => false },
  [`${SRC}/services/voice/recent-events-store.ts`]: {
    pushRecentEvent: async () => {}, removeRecentEvent: async () => {}, getRecentEvents: async () => [], formatRecentEventsBlock: () => '',
  },
  [`${SRC}/services/voice/audio-retry.ts`]: {
    isInRetryMode: async () => false, readRetryAudio: async () => null, clearRetryMode: async () => {}, stashFailedAudio: async () => {},
  },
  [`${SRC}/lib/user-moderation.ts`]: (real) => fakeOver(real, { isIdentifierBlocked: async () => false }),
  [`${SRC}/services/native-reminders/support.ts`]: { getReminderSupport: async () => ({ supported: true }) },
  // The real native provider is the one that creates, so its checks and the store's fields are the ones the tap reaches
  [`${SRC}/services/calendar-provider/index.ts`]: {
    providerForCalendar: () => require(`${SRC}/services/calendar-provider/native-provider.ts`).nativeProvider, // eslint-disable-line @typescript-eslint/no-require-imports
    fetchEventsInRange: async () => ({ events: [], failed: [] }),
    createCalendarFor: async (_user: unknown, event: { calendarId?: string }) => event.calendarId ?? FLOW_CALENDARS[0].calendarId,
    hasUsableCalendar: async () => true,
    getCalendarAssignmentsForUser: async () => FLOW_CALENDARS,
  },
  [`${SRC}/services/voice/gemini-voice.ts`]: (real) => fakeOver(real, { processVoiceWithGemini: async () => ({
    intentResult: extracted[0], intentResults: extracted, transcription: 'remind me before the latest time for Shema',
    metrics: { model: 'fake', inputTokens: 0, outputTokens: 0, durationMs: 0 },
  }) }),
  [`${SRC}/services/voice/event-resolution.ts`]: (real) => fakeOver(real, { downloadVoiceFile: async () => Buffer.from('OggS') }),
  [`${SRC}/services/native-calendar/event-store.ts`]: (real) => fakeOver(real, {
    getMainNativeCalendar: async (userId: number) => ({ id: `main${userId}` }),
    createNativeEvent: async (input: Record<string, unknown>) => {
      created.push(input);
      return { id: `ev${created.length}`, calendarId: input.calendarCuid };
    },
  }),
  [`${SRC}/services/native-reminders/ownership.ts`]: (real) => fakeOver(real, {
    getActivePartnerSummary: async (_userId: number, pairingId: string | null) => (pairingId ? partner : null),
  }),
};

const ModuleInternals = Module as unknown as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  _resolveFilename: (request: string, parent: unknown, isMain: boolean) => string;
};
const resolveFilename = ModuleInternals._resolveFilename;
ModuleInternals._resolveFilename = function (request, parent, isMain) {
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
  const key = request in stubs ? request : resolved;
  if (!(key in stubs) || loadingReal.has(key)) return realLoad.call(this, request, parent, isMain);
  return fakeFor(key, () => realLoad.call(this, request, parent, isMain));
};
// import() goes through the ES module loader: the same fakes, served as ES modules.
(globalThis as { zmanVoiceFake?: (file: string) => object }).zmanVoiceFake = (file) => fakeFor(file, () => realLoad.call(Module, file, null, false));
Module.registerHooks({
  load(url, context, nextLoad) {
    const file = url.startsWith('file:') ? fileURLToPath(url.split('?')[0]) : '';
    if (!(file in stubs) || loadingReal.has(file)) return nextLoad(url, context);
    const fake = (globalThis as unknown as { zmanVoiceFake: (file: string) => object }).zmanVoiceFake(file);
    const names = Object.keys(fake).map((name) => `export const ${name} = fake.${name};`).join('\n');
    return { format: 'module', shortCircuit: true, source: `const fake = globalThis.zmanVoiceFake(${JSON.stringify(file)});\n${names}\n` };
  },
});
globalThis.fetch = (async () => { throw new Error('the smoke reached the network'); }) as typeof fetch;

// ---- Fixtures ----

/** An instant from a wall time ('yyyy-MM-dd HH:mm') in a zone, through the one resolver. */
const at = (local: string, tz = IL): Date => wallTimeToInstant(local.replace(' ', 'T'), tz);
const hm = (d: Date | null | undefined, tz = IL) => (d ? instantToWallTime(d, tz).slice(11, 16) : 'none');
const dayOf = (d: Date, tz = IL) => instantToWallTime(d, tz).slice(0, 10);

/** A zman reminder as the parser hands it over: date-only, local midnight of the said day (or of today). */
function zmanReminder(zman: Record<string, unknown>, opts: { day?: string; said?: boolean; now: Date; tz?: string } & Partial<ParsedEvent>): ParsedEvent {
  const { day, said, now, tz = IL, ...over } = opts;
  const start = at(`${day ?? dayOf(now, tz)} 00:00`, tz);
  return {
    title: 'Say Shema', startTime: start, endTime: new Date(start.getTime()), allDay: true, confidence: 'high',
    kind: 'reminder', forPerson: 'self', calendarId: 'native:whatever', calendarName: 'Dana',
    zman: zman as ParsedEvent['zman'], ...(said ? { zmanDaySaid: true as const } : {}), ...over,
  };
}
const SHEMA = (offsetMinutes = -10, opinion: string | null = null) => ({ name: 'SOF_SHMA', opinion, offsetMinutes });
const SHKIA = (offsetMinutes = 0) => ({ name: 'SHKIA', opinion: null, offsetMinutes });

async function main() {
  const resolve = await import('../src/services/native-reminders/resolve');
  const { resolveReminderIntents, refreshReminderNotice, reminderCreateFields, withZmanChoice, zmanAnalytics, zmanTimingFor, zmanTimeOn } = resolve;
  const { isPaused } = await import('../src/services/zmanim/pause');
  const { zmanClockFor } = await import('../src/services/zmanim/reminder-clock');
  const { nativeProvider } = await import('../src/services/calendar-provider/native-provider');
  const { anchorQuestion, formatReminderCard, reminderCreatedLine } = await import('../src/services/voice/confirmations');

  /** One reminder through resolveReminderIntents, as every handler resolves it. Console lines are kept in `logs`. */
  async function resolveOne(event: ParsedEvent, now: Date, who: UserConfig = dana, tz = IL) {
    const kept = { log: console.log, warn: console.warn, error: console.error };
    const take = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    console.log = take; console.warn = take; console.error = take;
    try {
      const intent: VoiceIntentResult = { intent: 'create', confidence: 'high', event };
      const { intents, failures } = await resolveReminderIntents(who, [intent], tz, { now });
      return { event: intents[0].event, intent: intents[0], failure: failures[0] };
    } finally {
      Object.assign(console, kept);
    }
  }
  /** A person's time for a rule on a day, through the real clock. */
  async function clockTime(person: import('../src/services/zmanim/reminder-clock').ZmanUser, zone: string, day: string, spec: { zman: string; offsetMin: number } | { halachicHours: number; offsetMin: number }) {
    const clock = await zmanClockFor(person, zone);
    return clock ? clock.instant(day, spec) : null;
  }

  // ---- The mapping, under the writer's community ----

  await check('Sephardi "10 min before sof zman Shema" with no opinion: two choices, MGA then GRA, no rule, the model\'s words gone', async () => {
    const now = at('2026-10-28 06:00');
    const { event, failure } = await resolveOne(zmanReminder(SHEMA(), { now }), now);
    assert(event && !failure, show(failure));
    assert(event.zmanSpec === undefined && event.zman === undefined, `spec ${show(event.zmanSpec)}, zman ${show(event.zman)}`);
    assert(show(event.zmanChoices?.map((c) => c.spec)) === show([{ zman: 'SOF_SHMA_MGA', offsetMin: -10 }, { zman: 'SOF_SHMA_GRA', offsetMin: -10 }]), show(event.zmanChoices));
    assert(event.allDay && event.kind === 'reminder' && dayOf(event.startTime) === '2026-10-28', `${event.allDay} ${dayOf(event.startTime)}`);
    // The plan's example: Harish on 2026-10-28, GRA 08:27, MGA 07:53
    const times = await Promise.all(event.zmanChoices!.map((c) => clockTime(dana, IL, c.day, c.spec)));
    assert(show(times.map((t) => hm(t))) === show(['07:53', '08:27']), show(times.map((t) => hm(t))));
    assert(logs.some((l) => l.startsWith('[zman-voice]') && l.includes('2 opinions')), show(logs));
  });

  await check('a Chabad writer gets the one Shema key (no buttons); an opinion said is used as said', async () => {
    const now = at('2026-10-28 06:00');
    const chabad = await resolveOne(zmanReminder(SHEMA(), { now }), now, user({ zmanimCommunity: 'chabad' }));
    assert(show(chabad.event?.zmanSpec) === show({ zman: 'SOF_SHMA_GRA', offsetMin: -10 }) && chabad.event?.zmanChoices === undefined, show(chabad.event));
    const gra = await resolveOne(zmanReminder(SHEMA(-10, 'gra'), { now }), now);
    assert(show(gra.event?.zmanSpec) === show({ zman: 'SOF_SHMA_GRA', offsetMin: -10 }) && gra.event?.zmanChoices === undefined, show(gra.event));
    const hours = await resolveOne(zmanReminder({ halachicHours: 3, offsetMinutes: 0 }, { now }), now);
    assert(show(hours.event?.zmanSpec) === show({ halachicHours: 3, offsetMin: 0 }), show(hours.event));
  });

  await check('refused, nothing created, the person asked: an opinion the set lacks (naming what it has), a name it does not know, an offset past 12 hours', async () => {
    const now = at('2026-10-28 06:00');
    const mga = await resolveOne(zmanReminder(SHEMA(-10, 'mga'), { now }), now, user({ zmanimCommunity: 'chabad' }));
    assert(!mga.event && mga.intent.error === 'zman_not_offered', show(mga.intent));
    assert(mga.failure?.error === 'zman_not_offered' && mga.failure.description === 'Say Shema' && mga.failure.zmanRefusal === 'not_offered', show(mga.failure));
    assert(show(mga.failure.offered) === show([{ zman: 'SOF_SHMA_GRA', offsetMin: 0 }]), show(mga.failure.offered));
    assert(logs.some((l) => l.startsWith('[zman-voice]') && l.includes('not_offered')), show(logs));
    const plag = await resolveOne(zmanReminder({ name: 'PLAG', opinion: 'gra', offsetMinutes: 0 }, { now }), now);
    assert(plag.failure?.zmanRefusal === 'not_offered' && show(plag.failure.offered) === show([{ zman: 'PLAG_HALACHA_BERURA', offsetMin: 0 }, { zman: 'PLAG_YALKUT_YOSEF', offsetMin: 0 }]), show(plag.failure));
    const unknown = await resolveOne(zmanReminder({ name: 'RABBEINU_TAM', opinion: null, offsetMinutes: 0 }, { now }), now);
    assert(unknown.failure?.error === 'zman_not_offered' && unknown.failure.zmanRefusal === 'unknown' && show(unknown.failure.offered) === '[]', show(unknown.failure));
    const far = await resolveOne(zmanReminder(SHKIA(-800), { now }), now);
    assert(far.failure?.error === 'zman_not_offered' && far.failure.zmanRefusal === 'bad_offset', show(far.failure));
  });

  // ---- The day ----

  await check('no day said: today while the time is ahead, else tomorrow, per choice (MGA passed goes to tomorrow, GRA still today)', async () => {
    const before = at('2026-10-28 10:00');
    const today = await resolveOne(zmanReminder(SHKIA(), { now: before }), before);
    assert(dayOf(today.event!.startTime) === '2026-10-28' && today.event!.reminderNotice === undefined, show(today.event));
    const after = at('2026-10-28 19:00');
    const tomorrow = await resolveOne(zmanReminder(SHKIA(), { now: after }), after);
    assert(dayOf(tomorrow.event!.startTime) === '2026-10-29' && tomorrow.event!.reminderNotice === undefined, show(tomorrow.event));
    const eight = at('2026-10-28 08:00');
    const { event } = await resolveOne(zmanReminder(SHEMA(), { now: eight }), eight);
    assert(show(event?.zmanChoices?.map((c) => [c.spec, c.day])) === show([[{ zman: 'SOF_SHMA_MGA', offsetMin: -10 }, '2026-10-29'], [{ zman: 'SOF_SHMA_GRA', offsetMin: -10 }, '2026-10-28']]), show(event?.zmanChoices));
    assert(dayOf(event!.startTime) === '2026-10-28', 'the card\'s day is the earliest choice\'s');
  });

  await check('the notice is counted at the zman, not at the 09:00 reminder time: today\'s sunset at 10:00 has none, a passed one is "time passed", never "no time set"', async () => {
    const ten = at('2026-10-28 10:00');
    const ahead = await resolveOne(zmanReminder(SHKIA(-30), { now: ten, said: true }), ten);
    assert(ahead.event && ahead.event.reminderNotice === undefined && dayOf(ahead.event.startTime) === '2026-10-28', show(ahead.event));
    const evening = at('2026-10-28 19:00');
    const passed = await resolveOne(zmanReminder(SHKIA(-30), { now: evening, said: true }), evening);
    assert(passed.event?.reminderNotice === 'time_passed' && dayOf(passed.event.startTime) === '2026-10-28', show(passed.event));
    const refreshed = await refreshReminderNotice(ahead.event!, IL, ten, dana);
    assert(refreshed.reminderNotice === undefined, `refresh at 10:00: ${refreshed.reminderNotice}`);
    const later = await refreshReminderNotice(ahead.event!, IL, evening, dana);
    assert(later.reminderNotice === 'time_passed', `refresh at 19:00: ${later.reminderNotice}`);
  });

  await check('a repeat with no day said starts at its next time and has no notice; one with a passed said day has none either', async () => {
    const evening = at('2026-10-28 19:00');
    const daily = await resolveOne(zmanReminder(SHKIA(-10), { now: evening, recurrence: { frequency: 'daily' } }), evening);
    assert(dayOf(daily.event!.startTime) === '2026-10-29' && daily.event!.reminderNotice === undefined && daily.event!.recurrence?.frequency === 'daily', show(daily.event));
    const said = await resolveOne(zmanReminder(SHKIA(-10), { now: evening, said: true, recurrence: { frequency: 'daily' } }), evening);
    assert(dayOf(said.event!.startTime) === '2026-10-28' && said.event!.reminderNotice === undefined, show(said.event));
  });

  // ---- The first day: the first time that will ping, not a day the series skips ----

  const CANDLES = (offsetMinutes = 0) => ({ name: 'CANDLE_LIGHTING', opinion: null, offsetMinutes });
  const WEEKLY_FRIDAY = { frequency: 'weekly' as const, daysOfWeek: ['FR'] };

  await check('a weekly repeat by zman starts on its first occurrence: "every Friday, an hour before candle lighting" said on a Wednesday is Friday, and the card and the reply give Friday\'s time', async () => {
    const wed = at('2026-10-28 10:00');
    const { event, failure } = await resolveOne(zmanReminder(CANDLES(-60), { now: wed, recurrence: WEEKLY_FRIDAY }), wed);
    assert(event && !failure, show(failure));
    assert(dayOf(event.startTime) === '2026-10-30' && event.reminderNotice === undefined, `${dayOf(event.startTime)} ${event.reminderNotice}`);
    const friday = hm(await clockTime(dana, IL, '2026-10-30', { zman: 'CANDLE_LIGHTING', offsetMin: -60 }));
    const card = await formatReminderCard(event, 'en', IL, 'html', dana);
    assert(card.includes('Fri, Oct 30') && card.includes(friday) && !card.includes('Oct 28'), card);
    const reply = await reminderCreatedLine(event, 'en', IL, true, dana);
    assert(reply.includes('Oct 30') && reply.includes(friday) && !reply.includes('today') && !reply.includes('Oct 28'), reply);
    // The same at the pass: the series fires on that Friday and not on the Wednesday
    const { occurrenceDays } = await import('../src/services/native-calendar/recurrence');
    assert(show(occurrenceDays('FREQ=WEEKLY;BYDAY=FR', '2026-10-28', IL, 20, 3)) === show(['2026-10-30', '2026-11-06', '2026-11-13']), 'the rule\'s own days');
  });

  await check('a weekly repeat whose first Friday time has passed starts on the next Friday; a said day the repeat does not fire on starts on its first occurrence after it', async () => {
    const lateFriday = at('2026-10-30 17:30');
    const next = await resolveOne(zmanReminder(CANDLES(-60), { now: lateFriday, recurrence: WEEKLY_FRIDAY }), lateFriday);
    assert(next.event && dayOf(next.event.startTime) === '2026-11-06' && next.event.reminderNotice === undefined, show(next.event));
    const earlyFriday = at('2026-10-30 08:00');
    const same = await resolveOne(zmanReminder(CANDLES(-60), { now: earlyFriday, recurrence: WEEKLY_FRIDAY }), earlyFriday);
    assert(same.event && dayOf(same.event.startTime) === '2026-10-30', show(same.event));
    const wed = at('2026-10-28 10:00');
    const said = await resolveOne(zmanReminder(SHKIA(-30), { now: wed, day: '2026-10-28', said: true, recurrence: WEEKLY_FRIDAY }), wed);
    assert(said.event && dayOf(said.event.startTime) === '2026-10-30', show(said.event));
    const onDay = await resolveOne(zmanReminder(SHKIA(-30), { now: wed, day: '2026-11-06', said: true, recurrence: WEEKLY_FRIDAY }), wed);
    assert(onDay.event && dayOf(onDay.event.startTime) === '2026-11-06', show(onDay.event));
  });

  await check('a weekly repeat with choices: every choice starts on the repeat\'s first occurrence, so no button names a day the series skips', async () => {
    const wed = at('2026-10-28 10:00');
    const { event } = await resolveOne(zmanReminder(SHEMA(-10), { now: wed, recurrence: WEEKLY_FRIDAY }), wed);
    assert(event?.zmanChoices?.length === 2 && event.zmanChoices.every((c) => c.day === '2026-10-30') && dayOf(event.startTime) === '2026-10-30', show(event?.zmanChoices));
    const card = await formatReminderCard(event, 'en', IL, 'html', dana);
    assert(card.includes('Fri, Oct 30') && !card.includes('Oct 28') && !card.includes('Oct 29'), card);
  });

  await check('candle lighting with no day said is the next eve, not today: a Wednesday goes to Friday, after Friday\'s candles to the next Friday, and the eve of a Yom Tov on a Sunday is an eve', async () => {
    const wed = at('2026-10-28 06:00');
    const eve = await resolveOne(zmanReminder(CANDLES(-60), { now: wed }), wed);
    assert(eve.event && dayOf(eve.event.startTime) === '2026-10-30' && eve.event.reminderNotice === undefined, show(eve.event));
    const after = at('2026-10-30 17:30');
    const next = await resolveOne(zmanReminder(CANDLES(), { now: after }), after);
    assert(next.event && dayOf(next.event.startTime) === '2026-11-06', show(next.event));
    // 2026-09-20 is a Sunday, the eve of Yom Kippur: the candles of a Saturday morning are lit then, not on Friday the 25th (Sukkot)
    const saturday = at('2026-09-19 10:00');
    const kippur = await resolveOne(zmanReminder(CANDLES(), { now: saturday }), saturday);
    assert(kippur.event && dayOf(kippur.event.startTime) === '2026-09-20', show(kippur.event));
    // A day the person said is theirs
    const said = await resolveOne(zmanReminder(CANDLES(), { now: wed, day: '2026-10-29', said: true }), wed);
    assert(said.event && dayOf(said.event.startTime) === '2026-10-29', show(said.event));
    // The other zmanim keep today / tomorrow
    const sunset = await resolveOne(zmanReminder(SHKIA(), { now: wed }), wed);
    assert(sunset.event && dayOf(sunset.event.startTime) === '2026-10-28', show(sunset.event));
  });

  // ---- Whose place ----

  await check('"remind Raziel": timed at his own place and zone (New York), for the day pick and for the notice on refresh', async () => {
    const evening = at('2026-10-28 20:00'); // Harish's sunset has passed; New York's (about 23:55 Israel time) has not
    const theirs = await resolveOne(zmanReminder(SHKIA(), { now: evening, forPerson: 'partner' }), evening);
    assert(theirs.event?.forUserId === 2 && theirs.event.forBoth === false && dayOf(theirs.event.startTime) === '2026-10-28', show(theirs.event));
    const mine = await resolveOne(zmanReminder(SHKIA(), { now: evening }), evening);
    assert(dayOf(mine.event!.startTime) === '2026-10-29', show(mine.event));
    const nySunset = await clockTime(raziel, NY, '2026-10-28', { zman: 'SHKIA', offsetMin: 0 });
    assert(nySunset && nySunset.getTime() > evening.getTime(), `New York sunset ${nySunset?.toISOString()}`);
    // Refresh reads him by id: ahead at 20:00 (Harish's has passed), passed once his has
    const saidDay = { ...theirs.event!, zmanDaySaid: true as const };
    assert((await refreshReminderNotice(saidDay, IL, evening, dana)).reminderNotice === undefined, 'his sunset is ahead');
    const afterHis = new Date(nySunset.getTime() + 30 * 60_000);
    assert((await refreshReminderNotice(saidDay, IL, afterHis, dana)).reminderNotice === 'time_passed', 'his sunset has passed');
    const timing = await zmanTimingFor(dana, saidDay, IL);
    assert(timing.person.id === 2 && timing.zone === NY && hm(zmanTimeOn('2026-10-28', { zman: 'SHKIA', offsetMin: 0 }, timing, IL), NY) === hm(nySunset, NY), `${timing.person.id} ${timing.zone}`);
  });

  await check('"remind us both": the creator\'s times (and choices), each partner needing a place; a partner not on Telegram keeps it the creator\'s with the notice', async () => {
    const evening = at('2026-10-28 20:00');
    const both = await resolveOne(zmanReminder(SHKIA(), { now: evening, forPerson: 'both' }), evening);
    assert(both.event?.forBoth === true && both.event.forUserId === 2 && dayOf(both.event.startTime) === '2026-10-29', show(both.event));
    const six = at('2026-10-28 06:00');
    const choices = await resolveOne(zmanReminder(SHEMA(), { now: six, forPerson: 'both' }), six);
    assert(choices.event?.zmanChoices?.length === 2 && choices.event.forBoth === true, show(choices.event));
    partner = { ...raziel, telegramId: null };
    const off = await resolveOne(zmanReminder(SHKIA(), { now: evening, forPerson: 'partner' }), evening);
    assert(off.event?.forUserId === null && off.event.reminderNotice === 'partner_not_on_telegram' && dayOf(off.event.startTime) === '2026-10-29', show(off.event));
  });

  await check('no place: refused (zman_no_place), the partner named when it is theirs; the zone\'s main city stands in for a person with none saved', async () => {
    const now = at('2026-10-28 06:00');
    zones[5] = TOKYO;
    const lost = await resolveOne(zmanReminder(SHKIA(), { now, tz: TOKYO }), now, user({ id: 5, ...NOWHERE }), TOKYO);
    assert(!lost.event && lost.failure?.error === 'zman_no_place' && lost.failure.name === undefined, show(lost.failure));
    assert(logs.some((l) => l.startsWith('[zman-voice]') && l.includes('no place')), show(logs));
    const zoneOnly = await resolveOne(zmanReminder(SHKIA(), { now }), now, user({ id: 6, ...NOWHERE }));
    assert(show(zoneOnly.event?.zmanSpec) === show({ zman: 'SHKIA', offsetMin: 0 }), show(zoneOnly));
    partner = { ...raziel, ...NOWHERE };
    zones[2] = TOKYO;
    const theirs = await resolveOne(zmanReminder(SHKIA(), { now, forPerson: 'partner' }), now);
    assert(theirs.failure?.error === 'zman_no_place' && theirs.failure.name === 'Raziel', show(theirs.failure));
    const both = await resolveOne(zmanReminder(SHKIA(), { now, forPerson: 'both' }), now);
    assert(both.failure?.error === 'zman_no_place' && both.failure.name === 'Raziel', show(both.failure));
  });

  await check('no such time (polar night): a one-off is refused (zman_no_time), said day or not; a repeat is created', async () => {
    zones[7] = OSLO;
    const north = user({ id: 7, ...TROMSO });
    const now = at('2026-12-15 08:00', OSLO);
    const said = await resolveOne(zmanReminder({ name: 'NETZ', opinion: null, offsetMinutes: 0 }, { now, tz: OSLO, said: true }), now, north, OSLO);
    assert(!said.event && said.failure?.error === 'zman_no_time', show(said.failure));
    const unsaid = await resolveOne(zmanReminder({ name: 'NETZ', opinion: null, offsetMinutes: 0 }, { now, tz: OSLO }), now, north, OSLO);
    assert(unsaid.failure?.error === 'zman_no_time', show(unsaid.failure));
    const daily = await resolveOne(zmanReminder({ name: 'NETZ', opinion: null, offsetMinutes: 0 }, { now, tz: OSLO, recurrence: { frequency: 'daily' } }), now, north, OSLO);
    assert(show(daily.event?.zmanSpec) === show({ zman: 'NETZ', offsetMin: 0 }) && dayOf(daily.event!.startTime, OSLO) === '2026-12-15', show(daily));
  });

  await check('the partner summary (and a refresh\'s lookup) selects every field the zman clock and the pause read', async () => {
    const file = path.join(SRC, 'services/native-reminders/ownership.ts');
    loadingReal.add(file);
    let real: typeof import('../src/services/native-reminders/ownership');
    try {
      real = require(file); // eslint-disable-line @typescript-eslint/no-require-imports
    } finally {
      loadingReal.delete(file);
    }
    const fields = ['location', 'latitude', 'longitude', 'elevationM', 'zmanimCommunity', 'pauseOnShabbat', 'reminderTime'];
    await real.getActivePartnerSummary(1, 'pair-1');
    assert(fields.every((f) => selects[0]?.[f] === true), `partner summary: ${show(selects[0])}`);
    const start = at('2026-10-30 00:00');
    await refreshReminderNotice({ title: 'x', startTime: start, endTime: start, allDay: true, confidence: 'high', kind: 'reminder', forUserId: 2, forBoth: false, zmanSpec: { zman: 'SHKIA', offsetMin: 0 } }, IL, at('2026-10-28 10:00'), dana);
    assert(fields.every((f) => selects[1]?.[f] === true), `refresh: ${show(selects[1])}`);
  });

  // ---- The pause note (through isPaused, never a second window rule) ----

  await check('pause note: a one-off at Friday\'s sunset is held, 30 minutes before it is not, candle lighting is whatever isPaused says', async () => {
    const now = at('2026-10-28 10:00');
    const friday = { now, day: '2026-10-30', said: true };
    const sunset = await resolveOne(zmanReminder(SHKIA(), friday), now);
    assert(sunset.event?.reminderPaused === true, `sunset: ${show(sunset.event)}`);
    const before = await resolveOne(zmanReminder(SHKIA(-30), friday), now);
    assert(before.event?.reminderPaused === undefined, `30 before: ${show(before.event)}`);
    const candles = await resolveOne(zmanReminder({ name: 'CANDLE_LIGHTING', opinion: null, offsetMinutes: 0 }, friday), now);
    const candleAt = await clockTime(dana, IL, '2026-10-30', { zman: 'CANDLE_LIGHTING', offsetMin: 0 });
    assert((candles.event?.reminderPaused === true) === (await isPaused(dana, candleAt!)), `candle lighting: ${show(candles.event)}`);
    const saturday = await resolveOne(zmanReminder({ name: 'PLAG', opinion: 'halachaBerura', offsetMinutes: 0 }, { now, day: '2026-10-31', said: true }), now);
    assert(saturday.event?.reminderPaused === true, `Saturday plag: ${show(saturday.event)}`);
  });

  await check('pause note: none with the pause off, none on a repeat; each choice has its own; a refresh works it out again', async () => {
    const now = at('2026-10-28 10:00');
    const off = await resolveOne(zmanReminder(SHKIA(), { now, day: '2026-10-30', said: true }), now, user({ pauseOnShabbat: false }));
    assert(off.event && off.event.reminderPaused === undefined, show(off.event));
    const weekly = await resolveOne(zmanReminder(SHKIA(), { now, day: '2026-10-30', said: true, recurrence: { frequency: 'weekly', daysOfWeek: ['FR'] } }), now);
    assert(weekly.event && weekly.event.reminderPaused === undefined, show(weekly.event));
    const shabbat = await resolveOne(zmanReminder(SHEMA(), { now, day: '2026-10-31', said: true }), now);
    assert(shabbat.event?.zmanChoices?.length === 2 && shabbat.event.zmanChoices.every((c) => c.paused === true && c.day === '2026-10-31'), show(shabbat.event));
    const thursday = await resolveOne(zmanReminder(SHEMA(), { now, day: '2026-10-29', said: true }), now);
    assert(thursday.event?.zmanChoices?.every((c) => c.paused === undefined), show(thursday.event));
    // Moved to Shabbat (a quick fix of the day): the refresh notes each choice
    const moved = { ...thursday.event!, zmanChoices: thursday.event!.zmanChoices!.map((c) => ({ ...c, day: '2026-10-31' })) };
    const refreshed = await refreshReminderNotice(moved, IL, now, dana);
    assert(refreshed.zmanChoices?.every((c) => c.paused === true), show(refreshed.zmanChoices));
    const single = await refreshReminderNotice({ ...sunsetEvent(), reminderPaused: undefined }, IL, now, dana);
    assert(single.reminderPaused === true, show(single));
    const unpaused = await refreshReminderNotice(sunsetEvent(), IL, now, user({ pauseOnShabbat: false }));
    assert(unpaused.reminderPaused === undefined, show(unpaused));
  });
  function sunsetEvent(): ParsedEvent {
    const start = at('2026-10-30 00:00');
    return { title: 'Light', startTime: start, endTime: start, allDay: true, confidence: 'high', kind: 'reminder', forUserId: null, forBoth: false, zmanSpec: { zman: 'SHKIA', offsetMin: 0 }, zmanDaySaid: true, reminderPaused: true };
  }

  // ---- The choices on the pending card, and the tap ----

  await check('the choices survive the pending card\'s JSON; a tap makes that one the rule on its own day, and an index it lacks is null', async () => {
    const eight = at('2026-10-28 08:00');
    const { event } = await resolveOne(zmanReminder(SHEMA(), { now: eight }), eight);
    const stored = JSON.parse(JSON.stringify(event)) as ParsedEvent;
    stored.startTime = new Date(stored.startTime);
    stored.endTime = new Date(stored.endTime);
    const mga = withZmanChoice(stored, 0, IL)!;
    assert(show(mga.zmanSpec) === show({ zman: 'SOF_SHMA_MGA', offsetMin: -10 }) && mga.zmanChoices === undefined && dayOf(mga.startTime) === '2026-10-29' && mga.allDay, show(mga));
    assert(mga.endTime.getTime() === mga.startTime.getTime(), 'one moment');
    const gra = withZmanChoice(stored, 1, IL)!;
    assert(show(gra.zmanSpec) === show({ zman: 'SOF_SHMA_GRA', offsetMin: -10 }) && dayOf(gra.startTime) === '2026-10-28', show(gra));
    assert(withZmanChoice(stored, 2, IL) === null && withZmanChoice({ ...stored, zmanChoices: undefined }, 0, IL) === null, 'no such choice');
    const fields = reminderCreateFields(gra);
    assert(show(fields.zmanSpec) === show({ zman: 'SOF_SHMA_GRA', offsetMin: -10 }), show(fields));
  });

  // ---- The create path ----

  await check('reminderCreateFields: the rule on a date-only reminder; a plain one byte-identical; a clock time drops it; unchosen choices are refused loudly', async () => {
    const day = at('2026-10-29 00:00');
    const base: ParsedEvent = { title: 'x', startTime: day, endTime: day, allDay: true, confidence: 'high', kind: 'reminder', forUserId: null, forBoth: false };
    assert(show(reminderCreateFields(base)) === show({ kind: 'reminder', forUserId: null, forBoth: false, endTime: day }), show(reminderCreateFields(base)));
    const rule = { zman: 'SHKIA', offsetMin: -30 };
    assert(show(reminderCreateFields({ ...base, zmanSpec: rule })) === show({ kind: 'reminder', forUserId: null, forBoth: false, endTime: day, zmanSpec: rule }), 'with the rule');
    assert(!('zmanSpec' in reminderCreateFields({ ...base, zmanSpec: rule, allDay: false })), 'a clock time is a fixed time');
    assert(show(reminderCreateFields({ ...base, kind: undefined, zmanSpec: rule })) === '{}', 'an event gets nothing');
    const kept = console.error;
    const errors: string[] = [];
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    let threw = false;
    try {
      reminderCreateFields({ ...base, zmanChoices: [{ spec: rule, day: '2026-10-29' }, { spec: { zman: 'TZEIT', offsetMin: 0 }, day: '2026-10-29' }] });
    } catch {
      threw = true;
    } finally {
      console.error = kept;
    }
    assert(threw && errors.some((e) => e.startsWith('[zman-voice]')), `threw ${threw}, ${show(errors)}`);
    // A clock time given since (the Time quick fix): the choices no longer matter
    assert(!('zmanSpec' in reminderCreateFields({ ...base, allDay: false, zmanChoices: [{ spec: rule, day: '2026-10-29' }] })), 'timed with choices');
  });

  await check('the native provider passes the rule to the store, and refuses (nothing stored, logged) a zman the writer\'s set does not offer', async () => {
    const { encodeCalendarId } = await import('../src/services/native-calendar/event-store');
    const day = at('2026-10-29 00:00');
    const input = { title: 'Shema', startTime: day, endTime: day, allDay: true, kind: 'reminder' as const, forUserId: null, forBoth: false };
    const ok = await nativeProvider.createEvent(dana, encodeCalendarId('main1'), { ...input, zmanSpec: { zman: 'SOF_SHMA_GRA', offsetMin: -10 } });
    assert(ok.success && created.length === 1 && show(created[0].zmanSpec) === show({ zman: 'SOF_SHMA_GRA', offsetMin: -10 }) && created[0].kind === 'REMINDER', show(created));
    const plain = await nativeProvider.createEvent(dana, encodeCalendarId('main1'), input);
    assert(plain.success && (created.length as number) === 2 && !('zmanSpec' in created[1]), show(created[1]));
    const kept = console.warn;
    const warned: string[] = [];
    console.warn = (...args: unknown[]) => { warned.push(args.map(String).join(' ')); };
    let refused;
    try {
      refused = await nativeProvider.createEvent(user({ zmanimCommunity: 'chabad' }), encodeCalendarId('main1'), { ...input, zmanSpec: { zman: 'SOF_SHMA_MGA', offsetMin: -10 } });
    } finally {
      console.warn = kept;
    }
    assert(!refused.success && (created.length as number) === 2, `${show(refused)} ${created.length}`);
    assert(warned.some((w) => w.startsWith('[zman-voice]') && w.includes('SOF_SHMA_MGA')), show(warned));
  });

  await check('analytics: by_zman on a reminder created with a rule, and every native_reminder_created of the bot carries it', () => {
    const day = at('2026-10-29 00:00');
    const base: ParsedEvent = { title: 'x', startTime: day, endTime: day, allDay: true, confidence: 'high', kind: 'reminder' };
    assert(show(zmanAnalytics({ ...base, zmanSpec: { zman: 'SHKIA', offsetMin: 0 } })) === show({ by_zman: true }), 'by zman');
    assert(show(zmanAnalytics(base)) === '{}' && show(zmanAnalytics({ ...base, kind: undefined, zmanSpec: { zman: 'SHKIA', offsetMin: 0 } })) === '{}', 'plain, or an event');
    // The audit: the Mini App's write has its own by_zman (cmd.zmanSpec); every other site spreads zmanAnalytics
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(name)) files.push(full);
      }
    };
    walk(SRC);
    let sites = 0;
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (let i = text.indexOf("'native_reminder_created',"); i >= 0; i = text.indexOf("'native_reminder_created',", i + 1)) {
        sites++;
        const call = text.slice(i, text.indexOf(');', i));
        const rel = path.relative(ROOT, file);
        if (rel === 'src/services/calendar-write/write.ts') assert(call.includes('by_zman'), `${rel}: no by_zman`);
        else assert(call.includes('zmanAnalytics('), `${rel}: a native_reminder_created without zmanAnalytics`);
      }
    }
    assert(sites >= 7, `found ${sites} sites`);
  });

  // ---- What a refused one is asked ----

  await check('the questions: each zman refusal in en/he/ru names the reminder, the partner\'s missing place names them, escaped for Telegram', async () => {
    const description = 'Shema <now>';
    for (const language of ['en', 'he', 'ru']) {
      const seen = new Set<string>();
      for (const error of ['zman_not_offered', 'zman_no_place', 'zman_no_time'] as const) {
        const html = await anchorQuestion({ error, description }, language);
        assert(html.includes('Shema &lt;now&gt;') && !html.includes('nativeReminders.'), `${language} ${error}: ${html}`);
        const plain = await anchorQuestion({ error, description }, language, false);
        assert(plain.includes(description), `${language} ${error} plain: ${plain}`);
        seen.add(html);
      }
      const theirs = await anchorQuestion({ error: 'zman_no_place', description, name: 'Raz<i>el' }, language);
      assert(theirs.includes('Raz&lt;i&gt;el') && !seen.has(theirs), `${language}: ${theirs}`);
      assert(seen.size === 3, `${language}: the three questions differ`);
    }
    const anchor = await anchorQuestion({ error: 'anchor_not_found', description: 'the dentist' }, 'en');
    assert(anchor === 'I couldn\'t find “the dentist” in your calendar. Send it again with a time, like “remind me at 16:00 to …”.', anchor);
  });

  // ---- The whole flow (Task 9): the model's JSON -> parser -> voice handler -> card -> tap -> store -> reply ----

  const { parseGeminiEventResponse } = await import('../src/services/voice/gemini-voice');
  const { handleTelegramWebhook } = await import('../src/services/webhook-handlers');
  const { handleVoiceMessage } = await import('../src/services/voice/handler');
  const { getBotMessage } = await import('../src/lib/bot-messages');
  const MESSAGES: Record<string, Record<string, unknown>> = Object.fromEntries(
    ['en', 'he', 'ru'].map((l) => [l, JSON.parse(readFileSync(path.join(ROOT, `messages/${l}.json`), 'utf8'))]),
  );
  const homeT = (language: string) =>
    (createTranslator as unknown as (o: Record<string, unknown>) => unknown)({ locale: language, messages: MESSAGES[language], namespace: 'calendarHome' }) as Parameters<typeof zmanRuleWords>[0];
  const opinionName = (language: string, key: string) => (MESSAGES[language].calendarHome as { zmanim: { opinions: Record<string, string> } }).zmanim.opinions[key];
  const LANGUAGES = ['en', 'he', 'ru'] as const;

  const from = { id: 1001, first_name: 'Dana' };
  const noop = () => {};
  const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
    const kept = { log: console.log, warn: console.warn };
    console.log = noop; console.warn = noop;
    try { return await fn(); } finally { Object.assign(console, kept); }
  };
  const tap = (data: string, chatId = 555, messageId = 701) => quiet(() => handleTelegramWebhook(
    { body: { update_id: 1, callback_query: { id: 'q1', from, message: { chat: { id: chatId }, message_id: messageId }, data } } } as never,
    { status: () => ({ json: noop }) } as never,
  ));
  type Button = { text: string; callback_data: string };
  const lastBot = () => botCalls.filter((c) => c.method !== 'answerCallbackQuery').slice(-1)[0];
  const buttonsOf = (call: Sent) => ((call.opts?.reply_markup as { inline_keyboard: Button[][] } | undefined)?.inline_keyboard ?? []).flat();
  const pendingIdOf = (call: Sent) => buttonsOf(call).find((b) => b.callback_data.startsWith('event_cancel:'))!.callback_data.slice('event_cancel:'.length);

  /**
   * What the person said, as the model answers it (title, kind, the zman or the plain time), parsed by the real parser
   * and handed to the real voice handler as a voice note. The person is Dana in `language`.
   */
  async function say(language: string, event: Record<string, unknown>, now = at('2026-10-28 06:00')) {
    clock = now.getTime();
    currentUser = user({ language });
    const json = { intent: 'create', confidence: 'high', event: { title: 'Say Shema', calendarId: FLOW_CALENDARS[0].calendarId, kind: 'reminder', forPerson: 'self', ...event } };
    const parsed = parseGeminiEventResponse(json, FLOW_CALENDARS, IL, true, now);
    assert(!!parsed.event && !parsed.error, `the parser refused: ${show(parsed)}`);
    extracted = [parsed];
    await quiet(() => handleVoiceMessage(555, 1001, { file_id: 'f1', file_unique_id: 'u1', duration: 4 }, from));
    return parsed;
  }
  /** How many were stored (a function, so a check after `=== 0` is not narrowed). */
  const made = () => created.length;
  const GRA_10: ZmanSpecValue = { zman: 'SOF_SHMA_GRA', offsetMin: -10 };
  const MGA_10: ZmanSpecValue = { zman: 'SOF_SHMA_MGA', offsetMin: -10 };

  await check('flow, no opinion said: the parser keeps the model\'s words, the card has one button per opinion with its time, a tap on GRA stores SOF_SHMA_GRA -10 and the reply names it (en/he/ru)', async () => {
    for (const language of LANGUAGES) {
      reset();
      const parsed = await say(language, { zman: SHEMA() });
      assert(parsed.event!.allDay && show(parsed.event!.zman) === show(SHEMA()) && !parsed.event!.zmanSpec, `${language}: ${show(parsed.event)}`);
      assert(made() === 0, `${language}: created before the tap`);
      const card = lastBot();
      const mga = hm(await clockTime(dana, IL, '2026-10-28', MGA_10));
      const gra = hm(await clockTime(dana, IL, '2026-10-28', GRA_10));
      assert(mga === '07:53' && gra === '08:27', `${language}: the plan's times ${mga} ${gra}`);
      const buttons = buttonsOf(card);
      const id = pendingIdOf(card);
      assert(show(buttons.slice(0, 2)) === show([
        { text: `${opinionName(language, 'mga')} · ${mga}`, callback_data: `event_pick:0:${id}` },
        { text: `${opinionName(language, 'gra')} · ${gra}`, callback_data: `event_pick:1:${id}` },
      ]), `${language}: ${show(buttons)}`);
      assert(!buttons.some((b) => b.callback_data.startsWith('event_create:')), `${language}: a Create button on an unchosen reminder`);
      assert(card.text.includes(await getBotMessage(language, 'nativeReminders.zman.whichOpinion')) && !card.text.includes('nativeReminders.'), `${language}: ${card.text}`);
      for (const b of buttons) assert(Buffer.byteLength(b.callback_data) <= 64, `${language}: ${b.callback_data}`);
      await tap(`event_pick:1:${id}`);
      assert(made() === 1, `${language}: created ${made()}`);
      const row = created[0];
      assert(show(row.zmanSpec) === show({ zman: 'SOF_SHMA_GRA', offsetMin: -10 }) && row.kind === 'REMINDER' && row.allDay === true, `${language}: ${show(row)}`);
      assert((row.startsAt as Date).getTime() === at('2026-10-28 00:00').getTime(), `${language}: stored the day's midnight, not the zman's time: ${(row.startsAt as Date).toISOString()}`);
      const reply = lastBot();
      assert(reply.method === 'editMessageText' && reply.text.includes(opinionName(language, 'gra')) && reply.text.includes(gra) && !reply.text.includes('nativeReminders.'), `${language}: ${reply.text}`);
      assert(reply.text.includes(zmanRuleWords(homeT(language), GRA_10, 'gra')), `${language}: the rule's words are the Mini App's: ${reply.text}`);
      assert(tracked.some((e) => e.action === 'native_reminder_created' && e.metadata?.by_zman === true), `${language}: ${show(tracked)}`);
    }
  });

  await check('flow, an opinion said ("according to the GRA"): no buttons, a Create button, and a tap stores it (en/he/ru)', async () => {
    for (const language of LANGUAGES) {
      reset();
      await say(language, { zman: SHEMA(-10, 'gra') });
      const card = lastBot();
      const buttons = buttonsOf(card);
      assert(!buttons.some((b) => b.callback_data.startsWith('event_pick:')) && buttons.some((b) => b.callback_data.startsWith('event_create:')), `${language}: ${show(buttons)}`);
      assert(card.text.includes('08:27') && card.text.includes(zmanRuleWords(homeT(language), GRA_10, 'gra')), `${language}: ${card.text}`);
      assert(made() === 0, `${language}: a zman reminder is never created without its card`);
      await tap(buttons.find((b) => b.callback_data.startsWith('event_create:'))!.callback_data);
      assert(made() === 1 && show(created[0].zmanSpec) === show({ zman: 'SOF_SHMA_GRA', offsetMin: -10 }), `${language}: ${show(created)}`);
    }
  });

  await check('flow, a Chabad person: one Shema key, so no buttons and a plain rule on the card', async () => {
    reset();
    await say('en', { zman: SHEMA() });
    assert(buttonsOf(lastBot()).some((b) => b.callback_data.startsWith('event_pick:')), 'Sephardi has buttons');
    reset();
    clock = at('2026-10-28 06:00').getTime();
    const chabad = user({ zmanimCommunity: 'chabad' });
    currentUser = chabad;
    const parsed = parseGeminiEventResponse({ intent: 'create', confidence: 'high', event: { title: 'Say Shema', calendarId: FLOW_CALENDARS[0].calendarId, kind: 'reminder', forPerson: 'self', zman: SHEMA() } }, FLOW_CALENDARS, IL, true, new Date());
    extracted = [parsed];
    await quiet(() => handleVoiceMessage(555, 1001, { file_id: 'f1', file_unique_id: 'u1', duration: 4 }, from));
    const buttons = buttonsOf(lastBot());
    assert(!buttons.some((b) => b.callback_data.startsWith('event_pick:')) && buttons.some((b) => b.callback_data.startsWith('event_create:')), show(buttons));
    await tap(buttons.find((b) => b.callback_data.startsWith('event_create:'))!.callback_data);
    assert(made() === 1 && 'zman' in (created[0].zmanSpec as object) && (created[0].zmanSpec as { zman: string }).zman === 'SOF_SHMA_GRA', show(created));
  });

  await check('flow, a daily repeat at sunset, 30 min before: the Friday occurrence is a normal one (no pause note), the rule is stored with the repeat (en/he/ru)', async () => {
    for (const language of LANGUAGES) {
      reset();
      await say(language, { title: 'Light', zman: SHKIA(-30), recurrence: { frequency: 'daily' } });
      const card = lastBot();
      const sunset = hm(await clockTime(dana, IL, '2026-10-28', { zman: 'SHKIA', offsetMin: -30 }));
      assert(card.text.includes(sunset) && card.text.includes(zmanRuleWords(homeT(language), { zman: 'SHKIA', offsetMin: -30 }, null)), `${language}: ${card.text}`);
      const pausedNote = await getBotMessage(language, 'nativeReminders.zman.paused');
      assert(!card.text.includes(pausedNote), `${language}: a repeat carries no pause note: ${card.text}`);
      await tap(buttonsOf(card).find((b) => b.callback_data.startsWith('event_create:'))!.callback_data);
      assert(made() === 1 && show(created[0].zmanSpec) === show({ zman: 'SHKIA', offsetMin: -30 }) && typeof created[0].rrule === 'string' && /FREQ=DAILY/.test(created[0].rrule as string), `${language}: ${show(created)}`);
    }
    // Friday's occurrence is before the window by whatever isPaused says: sent
    const friday = await clockTime(dana, IL, '2026-10-30', { zman: 'SHKIA', offsetMin: -30 });
    const sunsetFriday = await clockTime(dana, IL, '2026-10-30', { zman: 'SHKIA', offsetMin: 0 });
    assert(!(await isPaused(dana, friday!)) && (await isPaused(dana, sunsetFriday!)), 'the pause starts at the eve\'s sunset');
  });

  await check('flow, a one-off at sunset on Friday: the card carries the "won\'t be sent" note exactly when isPaused says so (en/he/ru)', async () => {
    for (const language of LANGUAGES) {
      reset();
      await say(language, { title: 'Light', zman: SHKIA(0), startDate: '2026-10-30' }, at('2026-10-28 10:00'));
      const at0 = await clockTime(dana, IL, '2026-10-30', { zman: 'SHKIA', offsetMin: 0 });
      const note = await getBotMessage(language, 'nativeReminders.zman.paused');
      assert(lastBot().text.includes(note) === (await isPaused(dana, at0!)), `${language}: expects ${await isPaused(dana, at0!)}: ${lastBot().text}`);
      assert(lastBot().text.includes(note), `${language}: sunset on a Friday is inside the pause: ${lastBot().text}`);
      // 30 minutes before sunset the same Friday is not
      reset();
      await say(language, { title: 'Light', zman: SHKIA(-30), startDate: '2026-10-30' }, at('2026-10-28 10:00'));
      assert(!lastBot().text.includes(note), `${language}: 30 min before sunset is sent: ${lastBot().text}`);
    }
  });

  await check('flow, a reminder for the partner: timed at his own place (New York) on the card and in the stored rule, and the reply says his time (en/he/ru)', async () => {
    for (const language of LANGUAGES) {
      reset();
      await say(language, { title: 'Light', zman: SHKIA(-30), forPerson: 'partner' }, at('2026-10-28 06:00'));
      const card = lastBot();
      const theirs = await clockTime(raziel, NY, '2026-10-28', { zman: 'SHKIA', offsetMin: -30 });
      assert(card.text.includes(hm(theirs, NY)), `${language}: ${hm(theirs, NY)} not in ${card.text}`);
      await tap(buttonsOf(card).find((b) => b.callback_data.startsWith('event_create:'))!.callback_data);
      assert(made() === 1 && created[0].forUserId === 2 && show(created[0].zmanSpec) === show({ zman: 'SHKIA', offsetMin: -30 }), `${language}: ${show(created)}`);
      assert(lastBot().text.includes(hm(theirs, NY)), `${language}: ${lastBot().text}`);
    }
  });

  await check('flow, refusals: an opinion the set lacks, a name unknown, an hour out of range: nothing stored, the question in the person\'s language (en/he/ru)', async () => {
    const now = at('2026-10-28 06:00');
    for (const language of LANGUAGES) {
      for (const zman of [SHEMA(-10, 'mga'), { name: 'RABBEINU_TAM', opinion: null, offsetMinutes: 0 }, SHKIA(-800)]) {
        reset();
        clock = now.getTime();
        currentUser = user({ language, zmanimCommunity: 'chabad' });
        const parsed = parseGeminiEventResponse({ intent: 'create', confidence: 'high', event: { title: 'Say Shema', calendarId: FLOW_CALENDARS[0].calendarId, kind: 'reminder', forPerson: 'self', zman } }, FLOW_CALENDARS, IL, true, now);
        extracted = [parsed];
        await quiet(() => handleVoiceMessage(555, 1001, { file_id: 'f1', file_unique_id: 'u1', duration: 4 }, from));
        assert(made() === 0, `${language} ${show(zman)}: created ${show(created)}`);
        const text = lastBot().text;
        assert(text.includes('Say Shema') && !text.includes('nativeReminders.') && buttonsOf(lastBot()).length === 0, `${language} ${show(zman)}: ${text}`);
        assert(!/[a-z]/i.test(text.replace(/Say Shema|GRA|<\/?[a-z]+>/g, '')) || language === 'en', `${language}: the question is in ${language}: ${text}`);
      }
    }
  });

  await check('flow, a plain reminder (control): a clock time stays a plain time: no rule on the card, no zmanSpec stored, the same tap path (en/he/ru)', async () => {
    for (const language of LANGUAGES) {
      reset();
      await say(language, { title: 'Call the plumber', startDate: '2026-10-29', startTime: '10:00', endDate: '2026-10-29', endTime: '10:00', allDay: false });
      const card = lastBot();
      assert(!card.text.includes(await getBotMessage(language, 'nativeReminders.zman.whichOpinion')) && !card.text.includes('·'), `${language}: ${card.text}`);
      await tap(buttonsOf(card).find((b) => b.callback_data.startsWith('event_create:'))!.callback_data);
      assert(made() === 1 && !('zmanSpec' in created[0]) && created[0].zmanSpec === undefined && created[0].allDay === false && created[0].kind === 'REMINDER', `${language}: ${show(created)}`);
      assert(!tracked.some((e) => e.metadata?.by_zman), `${language}: by_zman on a plain reminder`);
    }
  });

  await check('flow, typed text: "remind me 10 minutes before sof zman Shema" in en/he/ru goes through the typed route and the real text parser to the same card and the same stored rule', async () => {
    const typed = {
      en: 'Remind me 10 minutes before sof zman Shema',
      he: 'תזכיר לי 10 דקות לפני סוף זמן קריאת שמע',
      ru: 'Напомни за 10 минут до конца времени Шма',
    };
    let message = 100;
    for (const language of LANGUAGES) {
      reset();
      clock = at('2026-10-28 06:00').getTime();
      currentUser = user({ language });
      geminiText = JSON.stringify({ intent: 'create', confidence: 'high', event: { title: 'Say Shema', calendarId: FLOW_CALENDARS[0].calendarId, kind: 'reminder', forPerson: 'self', zman: SHEMA() } });
      await quiet(() => handleTelegramWebhook(
        { body: { update_id: 2, message: { message_id: ++message, from, chat: { id: 555 }, text: typed[language] } } } as never,
        { status: () => ({ json: noop }) } as never,
      ));
      assert(geminiPrompts.length === 1 && geminiPrompts[0].includes(typed[language]) && geminiPrompts[0].includes('"zman"'), `${language}: the model was not asked with the zman rules`);
      assert(made() === 0, `${language}: typed text never creates without its card`);
      const card = lastBot();
      const buttons = buttonsOf(card);
      const id = pendingIdOf(card);
      assert(show(buttons.slice(0, 2).map((b) => b.callback_data)) === show([`event_pick:0:${id}`, `event_pick:1:${id}`]), `${language}: ${show(buttons)}`);
      assert(buttons[1].text === `${opinionName(language, 'gra')} · 08:27`, `${language}: ${buttons[1].text}`);
      await tap(`event_pick:1:${id}`);
      assert(made() === 1 && show(created[0].zmanSpec) === show({ zman: 'SOF_SHMA_GRA', offsetMin: -10 }) && created[0].kind === 'REMINDER', `${language}: ${show(created)}`);
      assert(lastBot().text.includes(opinionName(language, 'gra')) && lastBot().text.includes('08:27'), `${language}: ${lastBot().text}`);
    }
  });

  await check('flow, the model\'s zman together with a clock time, or on an event, is refused by the parser: nothing reaches a card', () => {
    const kept = console.warn;
    const warned: string[] = [];
    console.warn = (...args: unknown[]) => { warned.push(args.map(String).join(' ')); };
    try {
      parserRefuses();
    } finally {
      console.warn = kept;
    }
    assert(warned.length === 2 && warned.every((w) => w.startsWith('[zman-voice]')), show(warned));
  });
  function parserRefuses() {
    const now = at('2026-10-28 06:00');
    const clash = parseGeminiEventResponse({ intent: 'create', confidence: 'high', event: { title: 'x', calendarId: FLOW_CALENDARS[0].calendarId, kind: 'reminder', zman: SHEMA(), startDate: '2026-10-30', startTime: '17:00', allDay: false } }, FLOW_CALENDARS, IL, true, now);
    assert(!clash.event && !!clash.error, show(clash));
    const event = parseGeminiEventResponse({ intent: 'create', confidence: 'high', event: { title: 'x', calendarId: FLOW_CALENDARS[0].calendarId, kind: 'event', zman: SHEMA(), startDate: '2026-10-30', startTime: '17:00', endDate: '2026-10-30', endTime: '18:00' } }, FLOW_CALENDARS, IL, true, now);
    assert(!event.event && !!event.error, show(event));
  }

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? 'OK ' : 'FAIL'} ${r.name}${r.ok ? '' : `\n     ${r.reason}`}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed (process TZ=${process.env.TZ})`);
  process.exit(failed.length === 0 ? 0 : 1);
}

if (process.env[CHILD]) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  runChildren();
}

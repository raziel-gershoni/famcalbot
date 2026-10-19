// Smoke test for the bot's Hebrew-date repeats (hebrew-repeats spec §5).
//
// What it pins:
//  - the extraction prompt (voice, text, image) learns the Hebrew repeats and the Hebrew date, in
//    he, en and ru, and every Hebrew example in it parses;
//  - the parser reads recurrence.calendar / hebrewKind / hebrewDate, resolves the Hebrew date to the
//    start on the server (with a year, or the next occurrence on or after today) and drops a
//    'hebrew' calendar that does not go with a yearly frequency, with a log line;
//  - recurrenceFields(user, target, ev) is the one place a parsed repeat becomes create fields, and
//    every create site (the five of the plan plus auto-create) goes through it;
//  - a Google target gets no recurrence and a notice on the card before Confirm;
//  - the confirmation lines name the Hebrew date and the kind in three languages.
//
// Telegram, WhatsApp, Redis, Prisma, the AI and the calendar providers are faked; the clock is set
// by hand. No network.
//
// Run under both clocks; the output must not depend on the server's timezone:
//   TZ=UTC npx tsx scripts/smoke-hebrew-repeats-bot.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-hebrew-repeats-bot.ts

import Module from 'node:module';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fromZonedTime, formatInTimeZone } from 'date-fns-tz';
import type { CalendarAssignment, UserConfig } from '../src/types';
import type { ParsedEvent, VoiceIntentResult } from '../src/services/event-parser';

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

function assert(cond: boolean, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

function assertEqual(got: unknown, want: unknown, label = 'value') {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  assert(a === b, `${label}: got ${a}, want ${b}`);
}

// ---- Clock: every argument-less new Date() and Date.now() reads `clock` ----

let clock = 0;
const RealDate = Date;
class ClockDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(clock);
    else super(...(args as [number, number, number, number, number, number, number]));
  }
  static now() {
    return clock;
  }
}
globalThis.Date = ClockDate as unknown as DateConstructor;

const IL = 'Asia/Jerusalem';
const at = (local: string, tz = IL) => fromZonedTime(local, tz);
/** An instant as 'yyyy-MM-dd HH:mm' on the user's clock, or 'invalid'. */
const when = (date: Date | undefined, tz = IL) =>
  date && !isNaN(date.getTime()) ? formatInTimeZone(date, tz, 'yyyy-MM-dd HH:mm') : 'invalid';
/** Wednesday 2026-10-20, 10:00: 9 Cheshvan 5787, a leap year. */
const NOW = '2026-10-20 10:00';

// ---- Fakes ----

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

type Sent = { method: string; chatId?: number | string; text: string; opts?: Record<string, unknown> };
let botCalls: Sent[] = [];
const fakeBot = {
  sendMessage: async (chatId: number, text: string, opts?: Record<string, unknown>) => {
    botCalls.push({ method: 'sendMessage', chatId, text, opts });
    return { message_id: 700 + botCalls.length };
  },
  editMessageText: async (text: string, opts?: Record<string, unknown>) => {
    botCalls.push({ method: 'editMessageText', text, opts });
    return true;
  },
  answerCallbackQuery: async () => true,
};
let serviceCalls: Sent[] = [];
const fakeService = {
  sendMessage: async (chatId: number | string, text: string, opts?: Record<string, unknown>) => {
    serviceCalls.push({ method: 'sendMessage', chatId, text, opts });
    return { messageId: String(900 + serviceCalls.length) };
  },
  sendTypingIndicator: async () => {},
  sendVoice: async () => {},
};
let waCalls: Sent[] = [];
const fakeWhatsApp = {
  sendMessage: async (chatId: string, text: string, opts?: Record<string, unknown>) => {
    waCalls.push({ method: 'sendMessage', chatId, text, opts });
    return { messageId: `wamid.${waCalls.length}` };
  },
  downloadMedia: async () => Buffer.from('OggS'),
};

const logs: string[] = [];
const tracked: Array<{ userId: number; action: string }> = [];
const flags = { autoCreate: false };

const CALENDARS: CalendarAssignment[] = [
  { calendarId: 'native:main-1', labels: ['primary', 'yours'], name: 'Dana', color: '#000000' },
];
const GOOGLE_CALENDARS: CalendarAssignment[] = [
  { calendarId: 'dana@example.com', labels: ['primary', 'yours'], name: 'Dana', color: '#000000' },
];
const nativeUser = (language: string) => ({
  id: 1, name: 'Dana', englishName: 'Dana', language, telegramId: 1001, calendarSource: 'NATIVE',
  pairingId: null, isAdmin: false, voiceInputEnabled: true, googleRefreshToken: '', calendarAssignments: CALENDARS,
}) as unknown as UserConfig;
const googleUser = (language: string) => ({
  id: 4, name: 'Gal', englishName: 'Gal', language, telegramId: 1004, calendarSource: 'GOOGLE',
  pairingId: null, isAdmin: false, voiceInputEnabled: true, googleRefreshToken: 'token', calendarAssignments: GOOGLE_CALENDARS,
}) as unknown as UserConfig;
let currentUser: UserConfig = nativeUser('en');

/** What each provider was asked to create. */
let created: Array<{ provider: string; calendarId: string; input: Record<string, unknown> }> = [];
const providerFor = (name: 'native' | 'google') => ({
  name,
  fetchEventsInRange: async () => [],
  createEvent: async (_user: unknown, calendarId: string, input: Record<string, unknown>) => {
    created.push({ provider: name, calendarId, input });
    return { success: true, eventId: `ev${created.length}` };
  },
  deleteEvent: async () => ({ success: true }),
  updateEvent: async () => ({ success: true }),
});
const fakeNative = providerFor('native');
const fakeGoogle = providerFor('google');

let extracted: VoiceIntentResult[] = [];
async function fakeVoiceExtraction(...args: unknown[]) {
  void args;
  return {
    intentResult: extracted[0], intentResults: extracted, transcription: 'every year on the Hebrew date',
    metrics: { model: 'fake', inputTokens: 0, outputTokens: 0, durationMs: 0 },
  };
}

function reset() {
  clock = at(NOW).getTime();
  store.clear();
  botCalls = [];
  serviceCalls = [];
  waCalls = [];
  tracked.length = 0;
  created = [];
  logs.length = 0;
  extracted = [];
  flags.autoCreate = false;
  currentUser = nativeUser('en');
}

// ---- Module fakes ----

const SRC = path.resolve(__dirname, '../src');

const fakeOver = (real: Record<string, unknown>, fakes: Record<string, unknown>) =>
  new Proxy(real, { get: (target, key) => (typeof key === 'string' && key in fakes ? fakes[key] : Reflect.get(target, key)) });

const stubs: Record<string, object | ((real: Record<string, unknown>) => object)> = {
  '@googleapis/calendar': { calendar: () => ({}), auth: { OAuth2: class {} } },
  [`${SRC}/utils/redis.ts`]: { redis: fakeRedis },
  [`${SRC}/utils/prisma.ts`]: { prisma: {}, withRetry: (fn: () => unknown) => fn() },
  [`${SRC}/lib/error-capture.ts`]: { captureError: () => {}, captureWarning: () => {}, captureInfo: () => {} },
  [`${SRC}/lib/timezone.ts`]: { resolveUserTimezone: async () => IL },
  [`${SRC}/services/ai-provider.ts`]: { generateAICompletion: async () => ({ text: '{}' }), getGemini: () => ({}), extractionConfig: () => ({}) },
  [`${SRC}/services/telegram/index.ts`]: { getBot: () => fakeBot, getMessagingService: () => fakeService },
  [`${SRC}/services/telegram/bot.ts`]: { getBot: () => fakeBot, getMessagingService: () => fakeService },
  [`${SRC}/services/analytics-service.ts`]: {
    trackActivityAsync: (userId: number, action: string) => tracked.push({ userId, action }),
    addBreadcrumb: () => {},
    setUserContext: () => {},
  },
  [`${SRC}/services/subscription-service.ts`]: { checkFeatureAccess: async () => ({ allowed: true }), incrementUsage: async () => {} },
  [`${SRC}/services/user-service.ts`]: { getUserByTelegramId: async () => currentUser, getUserByWhatsAppId: async () => currentUser, getUserByWhatsAppPhone: async () => currentUser },
  [`${SRC}/services/messaging/factory.ts`]: real => fakeOver(real, { getWhatsAppService: () => fakeWhatsApp }),
  [`${SRC}/services/reminder-cache.ts`]: { getVoiceAutoCreateHighConf: async () => flags.autoCreate, getVoiceTtsOutcome: async () => false },
  [`${SRC}/services/voice/recent-events-store.ts`]: {
    pushRecentEvent: async () => {}, removeRecentEvent: async () => {}, getRecentEvents: async () => [], formatRecentEventsBlock: () => '',
  },
  [`${SRC}/services/voice/audio-retry.ts`]: {
    isInRetryMode: async () => false, readRetryAudio: async () => null, clearRetryMode: async () => {}, stashFailedAudio: async () => {},
  },
  [`${SRC}/services/native-reminders/support.ts`]: { getReminderSupport: async () => ({ supported: false, reason: 'disabled' }) },
  [`${SRC}/services/calendar-provider/index.ts`]: {
    getProviderForUser: (u: { calendarSource?: string }) => (u.calendarSource === 'NATIVE' ? fakeNative : fakeGoogle),
    hasUsableCalendar: async () => true,
    getCalendarAssignmentsForUser: async () => CALENDARS,
  },
  [`${SRC}/lib/user-moderation.ts`]: real => fakeOver(real, { isIdentifierBlocked: async () => false }),
  [`${SRC}/services/voice/gemini-voice.ts`]: real => fakeOver(real, { processVoiceWithGemini: fakeVoiceExtraction }),
  [`${SRC}/services/voice/event-resolution.ts`]: real => fakeOver(real, { downloadVoiceFile: async () => Buffer.from('OggS') }),
};

const ModuleInternals = Module as unknown as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  _resolveFilename: (request: string, parent: unknown, isMain: boolean) => string;
};
const resolveFilename = ModuleInternals._resolveFilename;
ModuleInternals._resolveFilename = function (request, parent, isMain) {
  if (request === '@hebcal/core') return path.resolve(__dirname, '../node_modules/@hebcal/core/dist/esm/index.js');
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

(globalThis as { hebrewBotSmokeFake?: (file: string) => object }).hebrewBotSmokeFake = file =>
  fakeFor(file, () => realLoad.call(Module, file, null, false));
Module.registerHooks({
  load(url, context, nextLoad) {
    const file = url.startsWith('file:') ? fileURLToPath(url.split('?')[0]) : '';
    if (!(file in stubs) || loadingReal.has(file)) return nextLoad(url, context);
    const fake = (globalThis as unknown as { hebrewBotSmokeFake: (file: string) => object }).hebrewBotSmokeFake(file);
    const names = Object.keys(fake).map(name => `export const ${name} = fake.${name};`).join('\n');
    return { format: 'module', shortCircuit: true, source: `const fake = globalThis.hebrewBotSmokeFake(${JSON.stringify(file)});\n${names}\n` };
  },
});

// ---- Fixtures ----

/** A Hebrew-repeat event as the parser hands it over (yahrzeit, all day). */
const hebrewEvent = (over: Partial<ParsedEvent> = {}): ParsedEvent => ({
  title: 'Yahrzeit for Dad',
  startTime: at('2026-12-20 00:00'),
  endTime: at('2026-12-20 23:59'),
  allDay: true,
  calendarId: 'native:main-1',
  calendarName: 'Dana',
  confidence: 'medium',
  recurrence: { frequency: 'yearly', calendar: 'hebrew', hebrewKind: 'yahrzeit' },
  ...over,
});
const plainEvent = (over: Partial<ParsedEvent> = {}): ParsedEvent => ({
  title: 'Dentist',
  startTime: at('2026-10-21 10:00'),
  endTime: at('2026-10-21 11:00'),
  allDay: false,
  calendarId: 'native:main-1',
  calendarName: 'Dana',
  confidence: 'high',
  ...over,
});
const createIntent = (event: ParsedEvent, confidence: 'high' | 'medium' | 'low' = 'medium'): VoiceIntentResult =>
  ({ intent: 'create', confidence, event });

const lastBot = () => botCalls[botCalls.length - 1];
const buttonsOf = (call: Sent) =>
  ((call.opts?.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }).inline_keyboard);
const pendingIdOf = (call: Sent, prefix: string) =>
  buttonsOf(call).flat().find(b => b.callback_data.startsWith(prefix))!.callback_data.slice(prefix.length);

async function main() {
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  console.log = () => {};
  void realWarn;

  const { getBotMessage, getBotMessages } = await import('../src/lib/bot-messages');
  const gemini = await import('../src/services/voice/gemini-voice');
  const { buildEventExtractionPrompt, parseGeminiEventResponse, extractIntents } = gemini;
  const { recurrenceFields } = await import('../src/services/recurrence-fields');
  const confirmations = await import('../src/services/voice/confirmations');
  const { showEventConfirmation } = confirmations;
  const { handleEventCallback } = await import('../src/services/voice/callbacks');
  const { autoCreateEvent } = await import('../src/services/voice/auto-create');
  const { showBulkConfirmation, handleBulkConfirmAll } = await import('../src/services/voice/bulk-confirmations');
  const { handleWhatsAppWebhook } = await import('../src/services/webhook-handlers');
  const t = await getBotMessages('en');

  const now = () => new RealDate(clock);
  /** A parse of one model reply, on the fixed clock. */
  const parse = (event: Record<string, unknown>, opts: { reminders?: boolean; tz?: string } = {}) =>
    parseGeminiEventResponse(
      { intent: 'create', confidence: 'high', event: { title: 'Event', calendarId: 'primary', ...event } },
      CALENDARS, opts.tz ?? IL, opts.reminders ?? false, now()
    );
  const hebrewAllDay = (hebrewDate: unknown, recurrence: unknown, extra: Record<string, unknown> = {}) => ({
    startDate: null, endDate: null, startTime: null, endTime: null, allDay: true, hebrewDate, recurrence, ...extra,
  });
  const yahrzeit = { frequency: 'yearly', calendar: 'hebrew', hebrewKind: 'yahrzeit' };
  const birthday = { frequency: 'yearly', calendar: 'hebrew', hebrewKind: 'anniversary' };

  // ================= The prompt =================

  await check('prompt: every mode teaches the Hebrew repeats and the Hebrew date, in he, en and ru', () => {
    for (const mode of ['voice', 'text', 'image'] as const) {
      const prompt = buildEventExtractionPrompt('en', CALENDARS, IL, mode);
      for (const needle of [
        '"calendar"', '"hebrewKind"', '"hebrewDate"', 'anniversary', 'yahrzeit',
        'יום הולדת עברי', 'לפי התאריך העברי', 'יארצייט', 'Hebrew birthday', 'on the Hebrew date',
        'по еврейскому календарю', 'йорцайт', "Sh'vat", 'Adar II',
      ]) assert(prompt.includes(needle), `${mode}: no ${needle}`);
    }
  });

  await check('prompt: the model never converts a Hebrew date, and calendar "hebrew" goes with yearly only', () => {
    const prompt = buildEventExtractionPrompt('en', CALENDARS, IL);
    assert(/never convert/i.test(prompt), 'no "never convert"');
    assert(/"hebrew" only (together )?with .*"yearly"/i.test(prompt) || /only with frequency "yearly"/i.test(prompt), 'no yearly-only rule');
  });

  await check('prompt: every Hebrew example in it parses to a start and a Hebrew repeat', () => {
    const prompt = buildEventExtractionPrompt('en', CALENDARS, IL, 'voice');
    const outputs = prompt.split('\n').filter(l => l.startsWith('Output: ') && l.includes('"hebrewKind"'));
    assert(outputs.length >= 3, `${outputs.length} Hebrew examples`);
    for (const line of outputs) {
      const json = JSON.parse(line.slice('Output: '.length));
      const got = parseGeminiEventResponse(json, CALENDARS, IL, false, now());
      assert(!!got.event && !got.error, `${line}: ${JSON.stringify(got)}`);
      assert(got.event.recurrence?.calendar === 'hebrew', `${line}: ${JSON.stringify(got.event.recurrence)}`);
    }
  });

  // ================= The parser =================

  await check('parse he: a yahrzeit on 10 Tevet with no year starts on the next 10 Tevet and notes it', () => {
    const got = parse(hebrewAllDay({ day: 10, month: 'Tevet', year: null }, yahrzeit, { title: 'יארצייט לאבא' }));
    const e = got.event!;
    assert(!!e, JSON.stringify(got));
    assertEqual(when(e.startTime), '2026-12-20 00:00', 'start');
    assert(e.allDay, 'not all-day');
    assertEqual(e.recurrence, { frequency: 'yearly', calendar: 'hebrew', hebrewKind: 'yahrzeit', hebrewNoYear: true }, 'recurrence');
  });

  await check('parse en: a Hebrew birthday on 15 Sh\'vat 5786 starts on that day, with no "next occurrence" note', () => {
    const e = parse(hebrewAllDay({ day: 15, month: "Sh'vat", year: 5786 }, birthday)).event!;
    assertEqual(when(e.startTime), '2026-02-02 00:00', 'start');
    assertEqual(e.recurrence, { frequency: 'yearly', calendar: 'hebrew', hebrewKind: 'anniversary' }, 'recurrence');
  });

  await check('parse ru: a yahrzeit with the death year 5780 starts on that day, in the past, and notes nothing', () => {
    const e = parse(hebrewAllDay({ day: 3, month: 'Nisan', year: 5780 }, yahrzeit, { title: 'Йорцайт' })).event!;
    assertEqual(when(e.startTime), '2020-03-28 00:00', 'start');
    assert(!('hebrewNoYear' in e.recurrence!), 'noted the year');
  });

  await check('parse: a timed Hebrew-date event keeps the time of day, and the end is on the same day', () => {
    const e = parse({
      startDate: null, endDate: null, startTime: '19:00', endTime: '20:00', allDay: false,
      hebrewDate: { day: 15, month: "Sh'vat", year: null }, recurrence: birthday,
    }).event!;
    assertEqual([when(e.startTime), when(e.endTime)], ['2027-01-23 19:00', '2027-01-23 20:00'], 'times');
  });

  await check('parse: the next occurrence counts today, and a day already past this year goes to the next', () => {
    const today = parse(hebrewAllDay({ day: 9, month: 'Cheshvan' }, null)).event!;
    assertEqual(when(today.startTime), '2026-10-20 00:00', 'today');
    const past = parse(hebrewAllDay({ day: 8, month: 'Cheshvan' }, null)).event!;
    assertEqual(when(past.startTime), '2027-11-08 00:00', 'yesterday goes to next year');
  });

  await check('parse: plain Adar is Adar II in a leap year, Adar I and Adar II are kept apart, and a missing Adar I is skipped', () => {
    assertEqual(when(parse(hebrewAllDay({ day: 15, month: 'Adar' }, null)).event!.startTime), '2027-03-24 00:00', 'Adar (leap year)');
    assertEqual(when(parse(hebrewAllDay({ day: 15, month: 'Adar II' }, null)).event!.startTime), '2027-03-24 00:00', 'Adar II');
    assertEqual(when(parse(hebrewAllDay({ day: 15, month: 'Adar I' }, null)).event!.startTime), '2027-02-22 00:00', 'Adar I');
    // 5786 is a common year: its Adar is the only one, and there is no Adar I in it
    assertEqual(when(parse(hebrewAllDay({ day: 15, month: 'Adar', year: 5786 }, null)).event!.startTime), '2026-03-04 00:00', 'Adar in a common year');
    const none = parse(hebrewAllDay({ day: 15, month: 'Adar I', year: 5786 }, null));
    assert(!none.event && none.confidence === 'low', `Adar I in a common year: ${JSON.stringify(none)}`);
    assert(logs.some(l => l.includes('hebrewDate')), `not logged: ${logs.join(' | ')}`);
  });

  await check('parse: 30 Cheshvan with no year skips the years that have no 30 Cheshvan', () => {
    assertEqual(when(parse(hebrewAllDay({ day: 30, month: 'Cheshvan' }, null)).event!.startTime), '2026-11-10 00:00', '5787');
    clock = at('2027-12-05 10:00').getTime();
    // 5789 and 5790 have a 29-day Cheshvan
    assertEqual(when(parse(hebrewAllDay({ day: 30, month: 'Cheshvan' }, null)).event!.startTime), '2030-11-26 00:00', 'skips to 5791');
    const given = parse(hebrewAllDay({ day: 30, month: 'Cheshvan', year: 5789 }, null));
    assert(!given.event, `a given year without that day: ${JSON.stringify(given.event)}`);
  });

  await check('parse: a year in short form (786) and a wrong one are read as the server needs', () => {
    assertEqual(when(parse(hebrewAllDay({ day: 15, month: "Sh'vat", year: 786 }, null)).event!.startTime), '2026-02-02 00:00', 'short year');
    const wrong = parse(hebrewAllDay({ day: 15, month: "Sh'vat", year: 3 }, yahrzeit)).event!;
    assertEqual(when(wrong.startTime), '2027-01-23 00:00', 'a year that is no year counts as none');
    assert(wrong.recurrence?.hebrewNoYear === true, 'no note');
    assert(logs.some(l => l.includes('year')), `not logged: ${logs.join(' | ')}`);
  });

  await check('parse: a Hebrew date the server cannot read is ignored and logged; the model\'s own startDate stands', () => {
    for (const bad of [{ day: 31, month: 'Tevet' }, { day: 0, month: 'Tevet' }, { day: 1.5, month: 'Tevet' }, { day: 10, month: 'Smarch' }, { day: 10 }, 'Tevet 10', []]) {
      logs.length = 0;
      const e = parse({ startDate: '2026-12-01', endDate: '2026-12-01', startTime: '10:00', endTime: '11:00', allDay: false, hebrewDate: bad }).event!;
      assertEqual(when(e.startTime), '2026-12-01 10:00', `start for ${JSON.stringify(bad)}`);
      assert(logs.some(l => l.includes('hebrewDate')), `${JSON.stringify(bad)} not logged: ${logs.join(' | ')}`);
    }
  });

  await check('parse: calendar "hebrew" with a frequency other than yearly is dropped and logged, the rest of the repeat stays', () => {
    for (const frequency of ['daily', 'weekly', 'monthly']) {
      logs.length = 0;
      const e = parse({
        startDate: '2026-10-27', endDate: '2026-10-27', startTime: '10:00', endTime: '11:00', allDay: false,
        recurrence: { frequency, daysOfWeek: ['TU'], calendar: 'hebrew', hebrewKind: 'yahrzeit' },
      }).event!;
      assertEqual(e.recurrence, { frequency, daysOfWeek: ['TU'] }, `${frequency} recurrence`);
      assert(logs.some(l => l.includes('hebrew') && l.includes(frequency)), `${frequency} not logged: ${logs.join(' | ')}`);
    }
  });

  await check('parse: a hebrewKind without calendar "hebrew" is dropped and logged; calendar "hebrew" without a kind is a birthday rule', () => {
    const alone = parse({ startDate: '2026-12-20', endDate: '2026-12-20', allDay: true, recurrence: { frequency: 'yearly', hebrewKind: 'yahrzeit' } }).event!;
    assertEqual(alone.recurrence, { frequency: 'yearly' }, 'kind alone');
    assert(logs.some(l => l.includes('hebrewKind')), `not logged: ${logs.join(' | ')}`);
    const noKind = parse({ startDate: '2026-12-20', endDate: '2026-12-20', allDay: true, recurrence: { frequency: 'yearly', calendar: 'hebrew' } }).event!;
    assertEqual(noKind.recurrence, { frequency: 'yearly', calendar: 'hebrew', hebrewKind: 'anniversary' }, 'no kind');
    const odd = parse({ startDate: '2026-12-20', endDate: '2026-12-20', allDay: true, recurrence: { frequency: 'yearly', calendar: 'hebrew', hebrewKind: 'birthday' } }).event!;
    assertEqual(odd.recurrence, { frequency: 'yearly', calendar: 'hebrew', hebrewKind: 'anniversary' }, 'unknown kind');
    assert(logs.some(l => l.includes('birthday')), `unknown kind not logged: ${logs.join(' | ')}`);
  });

  await check('parse: a Hebrew repeat on a Gregorian start keeps the start and has no note; INTERVAL, UNTIL and COUNT carry and BYDAY goes', () => {
    const e = parse({
      startDate: '2019-03-03', endDate: '2019-03-03', allDay: true,
      recurrence: { frequency: 'yearly', calendar: 'hebrew', hebrewKind: 'yahrzeit', interval: 2, count: 3, until: '2040-01-01', daysOfWeek: ['MO'] },
    }).event!;
    assertEqual(when(e.startTime), '2019-03-03 00:00', 'start');
    assertEqual(e.recurrence, { frequency: 'yearly', calendar: 'hebrew', hebrewKind: 'yahrzeit', interval: 2, count: 3, until: '2040-01-01' }, 'recurrence');
  });

  await check('parse: a Hebrew date without a repeat sets only the start (a one-off on a Hebrew date)', () => {
    const e = parse(hebrewAllDay({ day: 15, month: "Sh'vat", year: 5787 }, null)).event!;
    assertEqual(when(e.startTime), '2027-01-23 00:00', 'start');
    assert(e.recurrence === undefined, `recurrence ${JSON.stringify(e.recurrence)}`);
  });

  await check('parse: an ordinary repeat is read exactly as before (the model\'s object, untouched); null Hebrew fields are cleaned', () => {
    const raw = { frequency: 'weekly', daysOfWeek: ['TU'] };
    const same = parse({ startDate: '2026-10-27', endDate: '2026-10-27', startTime: '14:00', endTime: '15:00', allDay: false, recurrence: raw }).event!;
    assert(same.recurrence === raw, 'a new object');
    const cleaned = parse({
      startDate: '2026-10-27', endDate: '2026-10-27', startTime: '14:00', endTime: '15:00', allDay: false,
      recurrence: { frequency: 'weekly', daysOfWeek: ['TU'], calendar: null, hebrewKind: null }, hebrewDate: null,
    }).event!;
    assertEqual(cleaned.recurrence, raw, 'null fields');
  });

  await check('parse: a Hebrew reminder resolves its day on the server and keeps the repeat', () => {
    const got = parse({
      kind: 'reminder', forPerson: 'self', title: 'Light a candle', startDate: null, startTime: null, endDate: null, endTime: null, allDay: true,
      hebrewDate: { day: 10, month: 'Tevet', year: null }, recurrence: yahrzeit, anchor: null,
    }, { reminders: true });
    const e = got.event!;
    assert(!!e && e.kind === 'reminder', JSON.stringify(got));
    assertEqual(when(e.startTime), '2026-12-20 00:00', 'start');
    assertEqual(e.recurrence, { frequency: 'yearly', calendar: 'hebrew', hebrewKind: 'yahrzeit', hebrewNoYear: true }, 'recurrence');
  });

  await check('parse: extractIntents (text and image paths) resolves too, in a batch', () => {
    const [a, b] = extractIntents({
      intents: [
        { intent: 'create', confidence: 'high', event: { title: 'A', calendarId: 'primary', ...hebrewAllDay({ day: 10, month: 'Tevet' }, yahrzeit) } },
        { intent: 'create', confidence: 'high', event: { title: 'B', calendarId: 'primary', ...hebrewAllDay({ day: 15, month: "Sh'vat" }, birthday) } },
      ],
    }, CALENDARS, IL, false, now());
    assertEqual([when(a.event?.startTime), when(b.event?.startTime)], ['2026-12-20 00:00', '2027-01-23 00:00'], 'starts');
  });

  await check('parse: the zone decides today (New York is still on the 19th when Israel is on the 20th)', () => {
    clock = at('2026-10-20 02:00').getTime(); // 19:00 on the 19th in Los Angeles
    const e = parse(hebrewAllDay({ day: 8, month: 'Cheshvan' }, null), { tz: 'America/Los_Angeles' }).event!;
    // 2026-10-19 is 8 Cheshvan: today there
    assertEqual(when(e.startTime, 'America/Los_Angeles'), '2026-10-19 00:00', 'Los Angeles');
  });

  // ================= recurrenceFields =================

  await check('recurrenceFields: no repeat gives an empty rule and no other key', async () => {
    const f = await recurrenceFields(nativeUser('en'), 'native', plainEvent());
    assertEqual(f, { recurrence: [] }, 'fields');
  });

  await check('recurrenceFields: an ordinary repeat is buildRecurrenceRule exactly, no Hebrew keys, for either target', async () => {
    const ev = plainEvent({ recurrence: { frequency: 'weekly', daysOfWeek: ['TU', 'TH'], interval: 2, until: '2027-01-01' } });
    for (const target of ['native', 'google'] as const) {
      const f = await recurrenceFields(nativeUser('en'), target, ev);
      assertEqual(f, { recurrence: ['RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;UNTIL=20270101'] }, `${target} fields`);
    }
    const yearly = await recurrenceFields(nativeUser('en'), 'native', plainEvent({ recurrence: { frequency: 'yearly' } }));
    assertEqual(yearly, { recurrence: ['RRULE:FREQ=YEARLY'] }, 'a Gregorian yearly stays Gregorian');
  });

  await check('recurrenceFields: a native Hebrew repeat is FREQ=YEARLY plus the kind and the anchor (the start\'s day in the user\'s zone)', async () => {
    const f = await recurrenceFields(nativeUser('en'), 'native', hebrewEvent());
    assertEqual(f, { recurrence: ['RRULE:FREQ=YEARLY'], hebrewRule: 'yahrzeit', hebrewAnchor: '2026-12-20' }, 'yahrzeit');
    const b = await recurrenceFields(nativeUser('en'), 'native', hebrewEvent({ recurrence: { frequency: 'yearly', calendar: 'hebrew', hebrewKind: 'anniversary' } }));
    assert(b.hebrewRule === 'anniversary', JSON.stringify(b));
  });

  await check('recurrenceFields: INTERVAL, COUNT and UNTIL travel on the yearly rule, BYDAY never', async () => {
    const f = await recurrenceFields(nativeUser('en'), 'native', hebrewEvent({
      recurrence: { frequency: 'yearly', calendar: 'hebrew', hebrewKind: 'yahrzeit', interval: 2, count: 4, daysOfWeek: ['MO'] },
    }));
    assertEqual(f.recurrence, ['RRULE:FREQ=YEARLY;INTERVAL=2;COUNT=4'], 'rule');
    const u = await recurrenceFields(nativeUser('en'), 'native', hebrewEvent({
      recurrence: { frequency: 'yearly', calendar: 'hebrew', hebrewKind: 'anniversary', until: '2040-02-01' },
    }));
    assertEqual(u.recurrence, ['RRULE:FREQ=YEARLY;UNTIL=20400201'], 'until');
  });

  await check('recurrenceFields: a Google target gets no recurrence, no Hebrew keys, and the notice', async () => {
    const f = await recurrenceFields(googleUser('en'), 'google', hebrewEvent({ calendarId: 'dana@example.com' }));
    assertEqual(f, { recurrence: [], notice: 'google_once' }, 'fields');
    assert(logs.some(l => l.includes('Google') || l.includes('google')), `not logged: ${logs.join(' | ')}`);
  });

  await check('recurrenceFields: the anchor is read in the user\'s zone, not the server\'s', async () => {
    // 22:30 UTC on the 19th is 01:30 on the 20th in Israel
    const ev = hebrewEvent({ allDay: false, startTime: new RealDate('2026-12-19T22:30:00Z'), endTime: new RealDate('2026-12-19T23:30:00Z') });
    const f = await recurrenceFields(nativeUser('en'), 'native', ev);
    assertEqual(f.hebrewAnchor, '2026-12-20', 'anchor');
  });

  // ================= Every create site goes through the helper =================

  await check('sites: each create site calls recurrenceFields and none builds the rule itself', () => {
    const read = (file: string) => readFileSync(path.resolve(SRC, file), 'utf8');
    const sites: Array<[string, number]> = [
      ['services/webhook-handlers.ts', 3],
      ['services/voice/bulk-confirmations.ts', 1],
      ['services/voice/callbacks.ts', 1],
      ['services/voice/auto-create.ts', 1],
    ];
    for (const [file, count] of sites) {
      const source = read(file);
      const creates = source.match(/\.createEvent\(/g)?.length ?? 0;
      const helped = source.match(/recurrenceFields\(/g)?.length ?? 0;
      assert(creates === count && helped === count, `${file}: ${creates} creates, ${helped} helper calls, want ${count} each`);
      assert(!/buildRecurrenceRule\(/.test(source), `${file} still builds the rule itself`);
    }
  });

  const hebrewIntent = () => createIntent(hebrewEvent());
  const nativeInput = () => created.find(c => c.provider === 'native')!.input;
  const hebrewFieldsOf = (input: Record<string, unknown>) => ({ recurrence: input.recurrence, hebrewRule: input.hebrewRule, hebrewAnchor: input.hebrewAnchor });
  const HEBREW_CREATE = { recurrence: ['RRULE:FREQ=YEARLY'], hebrewRule: 'yahrzeit', hebrewAnchor: '2026-12-20' };
  const NONE = { recurrence: [] };

  await check('site Telegram confirm: a native Hebrew repeat is created with the pair; the input carries nothing else new', async () => {
    await showEventConfirmation(555, undefined, hebrewEvent(), 'yahrzeit', currentUser);
    await handleEventCallback(555, 701, 'q1', 'create', pendingIdOf(lastBot(), 'event_create:'));
    assert(created.length === 1, `${created.length} creates`);
    assertEqual(hebrewFieldsOf(nativeInput()), HEBREW_CREATE, 'fields');
    assertEqual(Object.keys(nativeInput()), ['title', 'startTime', 'endTime', 'location', 'description', 'allDay', 'recurrence', 'hebrewRule', 'hebrewAnchor'], 'keys');
  });

  await check('site Telegram confirm: a plain event\'s input is what it always was', async () => {
    await showEventConfirmation(555, undefined, plainEvent(), 'dentist', currentUser);
    await handleEventCallback(555, 701, 'q1', 'create', pendingIdOf(lastBot(), 'event_create:'));
    assertEqual(Object.keys(nativeInput()), ['title', 'startTime', 'endTime', 'location', 'description', 'allDay', 'recurrence'], 'keys');
    assertEqual(nativeInput().recurrence, [], 'recurrence');
  });

  await check('site bulk confirm: "Confirm all" creates a Hebrew repeat with the pair, and a plain one without', async () => {
    const plain = createIntent(plainEvent());
    await showBulkConfirmation(555, [hebrewIntent(), plain], currentUser, 'two events', t, fakeService as never, IL);
    const card = serviceCalls[0];
    const markup = card.opts?.replyMarkup as { inline_keyboard: Array<Array<{ callback_data: string }>> };
    const pendingId = markup.inline_keyboard[0][0].callback_data.slice('bulk_confirm:'.length);
    const result = await handleBulkConfirmAll(pendingId);
    assert(result.successCount === 2, JSON.stringify(result));
    assertEqual(hebrewFieldsOf(created[0].input), HEBREW_CREATE, 'hebrew');
    assertEqual(Object.keys(created[1].input), ['title', 'startTime', 'endTime', 'location', 'description', 'allDay', 'recurrence'], 'plain keys');
  });

  await check('site auto-create: a Hebrew repeat reaching it is created with the pair too', async () => {
    flags.autoCreate = true;
    const handled = await autoCreateEvent(currentUser, hebrewEvent(), t, fakeService as never, 555);
    assert(handled, 'not handled');
    assertEqual(hebrewFieldsOf(nativeInput()), HEBREW_CREATE, 'fields');
  });

  const waTap = (id: string) => handleWhatsAppWebhook(
    { body: { entry: [{ changes: [{ value: { messages: [{ from: '972500000008', id: `wamid.tap.${id}`, type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: `event_create:${id}`, title: 'Create' } } }] } }] }] } },
    { status: () => ({ json: () => {} }) }
  );
  const whatsappVoice = () => handleWhatsAppWebhook(
    { body: { entry: [{ changes: [{ value: { messages: [{ from: '972500000008', id: 'wamid.in', type: 'audio', audio: { id: 'media-1' } }] } }] }] } },
    { status: () => ({ json: () => {} }) }
  );

  await check('site WhatsApp confirm: the card, then the button, creates a Hebrew repeat with the pair', async () => {
    extracted = [hebrewIntent()];
    await whatsappVoice();
    const buttons = waCalls[waCalls.length - 1].opts?.whatsappButtons as Array<{ id: string }>;
    assert(buttons[0].id.startsWith('event_create:'), JSON.stringify(waCalls));
    await waTap(buttons[0].id.slice('event_create:'.length));
    assert(created.length === 1, `${created.length} creates`);
    assertEqual(hebrewFieldsOf(nativeInput()), HEBREW_CREATE, 'fields');
  });

  await check('site WhatsApp auto-create and bulk auto-create: a plain event goes through the helper and is created as before', async () => {
    flags.autoCreate = true;
    extracted = [createIntent(plainEvent(), 'high')];
    await whatsappVoice();
    assertEqual(Object.keys(nativeInput()), ['title', 'startTime', 'endTime', 'location', 'description', 'allDay', 'recurrence'], 'single keys');
    created = [];
    extracted = [createIntent(plainEvent(), 'high'), createIntent(plainEvent({ title: 'Gym' }), 'high')];
    await whatsappVoice();
    assert(created.length === 2 && created.every(c => JSON.stringify(Object.keys(c.input)) === JSON.stringify(['title', 'startTime', 'endTime', 'location', 'description', 'allDay', 'recurrence'])), JSON.stringify(created));
  });

  // ================= A Google target =================

  const notice = (language: string) => getBotMessage(language, 'hebrewRepeat.notice.google');

  await check('google: a Hebrew repeat is created once, with no recurrence and no Hebrew key, on every create site', async () => {
    currentUser = googleUser('en');
    const ev = hebrewEvent({ calendarId: 'dana@example.com' });
    // Telegram confirm
    await showEventConfirmation(555, undefined, ev, 'x', currentUser);
    await handleEventCallback(555, 701, 'q1', 'create', pendingIdOf(lastBot(), 'event_create:'));
    // bulk confirm
    await showBulkConfirmation(555, [createIntent(ev), createIntent(ev)], currentUser, 'x', t, fakeService as never, IL);
    const markup = serviceCalls[0].opts?.replyMarkup as { inline_keyboard: Array<Array<{ callback_data: string }>> };
    await handleBulkConfirmAll(markup.inline_keyboard[0][0].callback_data.slice('bulk_confirm:'.length));
    // auto-create
    flags.autoCreate = true;
    await autoCreateEvent(currentUser, ev, t, fakeService as never, 555);
    // WhatsApp confirm
    extracted = [createIntent(ev)];
    await whatsappVoice();
    const buttons = waCalls[waCalls.length - 1].opts?.whatsappButtons as Array<{ id: string }>;
    await waTap(buttons[0].id.slice('event_create:'.length));
    assert(created.length === 5 && created.every(c => c.provider === 'google'), `${created.length} creates: ${JSON.stringify(created.map(c => c.provider))}`);
    for (const c of created) {
      assertEqual(Object.keys(c.input), ['title', 'startTime', 'endTime', 'location', 'description', 'allDay', 'recurrence'], 'keys');
      assertEqual(c.input.recurrence, [], 'recurrence');
    }
  });

  await check('google: the Telegram card, the bulk card and the WhatsApp card say it is added once, before Confirm, in three languages', async () => {
    for (const language of ['en', 'he', 'ru']) {
      currentUser = googleUser(language);
      const text = await notice(language);
      assert(!!text && !text.startsWith('hebrewRepeat') && !text.includes('{'), `${language}: ${text}`);
      const ev = hebrewEvent({ calendarId: 'dana@example.com' });
      botCalls = [];
      await showEventConfirmation(555, undefined, ev, 'x', currentUser);
      assert(lastBot().text.includes(`<i>${text}</i>`), `${language} card: ${lastBot().text}`);
      assert(!lastBot().text.includes('🔄'), `${language}: the card promises a repeat: ${lastBot().text}`);
      serviceCalls = [];
      await showBulkConfirmation(555, [createIntent(ev), createIntent(plainEvent())], currentUser, 'x', await getBotMessages(language), fakeService as never, IL);
      assert(serviceCalls[0].text.includes(`<i>${text}</i>`), `${language} bulk: ${serviceCalls[0].text}`);
      waCalls = [];
      extracted = [createIntent(ev)];
      await whatsappVoice();
      assert(waCalls[waCalls.length - 1].text.includes(text), `${language} WhatsApp: ${waCalls[waCalls.length - 1].text}`);
    }
  });

  await check('google: an ordinary event and an ordinary yearly repeat get no notice', async () => {
    currentUser = googleUser('en');
    await showEventConfirmation(555, undefined, plainEvent({ calendarId: 'dana@example.com', recurrence: { frequency: 'yearly' } }), 'x', currentUser);
    assert(!lastBot().text.includes(await notice('en')), lastBot().text);
    assert(lastBot().text.includes('🔄 Yearly'), lastBot().text);
  });

  // ================= The confirmation line =================

  await check('card en: the Hebrew date and the kind, in place of "Yearly"; the post-create message too', async () => {
    await showEventConfirmation(555, undefined, hebrewEvent(), 'x', currentUser);
    const text = lastBot().text;
    assert(text.includes('🔄 Yahrzeit, every year on 10 Tevet'), text);
    assert(!text.includes('Yearly'), text);
    await handleEventCallback(555, 701, 'q1', 'create', pendingIdOf(lastBot(), 'event_create:'));
    assert(lastBot().text.includes('🔄 Yahrzeit, every year on 10 Tevet'), lastBot().text);
    await showEventConfirmation(555, undefined, hebrewEvent({ recurrence: { frequency: 'yearly', calendar: 'hebrew', hebrewKind: 'anniversary' } }), 'x', currentUser);
    assert(lastBot().text.includes('🔄 Every year on 10 Tevet'), lastBot().text);
  });

  await check('card he: gematriya, "כל שנה בי׳ בטבת" and "יארצייט, כל שנה בי׳ בטבת"', async () => {
    currentUser = nativeUser('he');
    await showEventConfirmation(555, undefined, hebrewEvent(), 'x', currentUser);
    assert(lastBot().text.includes('🔄 יארצייט, כל שנה בי׳ בטבת'), lastBot().text);
    await showEventConfirmation(555, undefined, hebrewEvent({ startTime: at('2027-01-23 00:00'), endTime: at('2027-01-23 23:59'), recurrence: { frequency: 'yearly', calendar: 'hebrew', hebrewKind: 'anniversary' } }), 'x', currentUser);
    assert(lastBot().text.includes('🔄 כל שנה בט״ו בשבט'), lastBot().text);
  });

  await check('card ru: the month in the genitive, "Каждый год 10 тевета" and "Йорцайт, каждый год 10 тевета"', async () => {
    currentUser = nativeUser('ru');
    await showEventConfirmation(555, undefined, hebrewEvent(), 'x', currentUser);
    assert(lastBot().text.includes('🔄 Йорцайт, каждый год 10 тевета'), lastBot().text);
    await showEventConfirmation(555, undefined, hebrewEvent({ recurrence: { frequency: 'yearly', calendar: 'hebrew', hebrewKind: 'anniversary' } }), 'x', currentUser);
    assert(lastBot().text.includes('🔄 Каждый год 10 тевета'), lastBot().text);
  });

  await check('card: the anchor day is the start\'s day in the user\'s zone', async () => {
    // 22:30 UTC on 2026-12-19 is 00:30 on the 20th in Israel: 10 Tevet
    const ev = hebrewEvent({ allDay: false, startTime: new RealDate('2026-12-19T22:30:00Z'), endTime: new RealDate('2026-12-19T23:30:00Z') });
    await showEventConfirmation(555, undefined, ev, 'x', currentUser);
    assert(lastBot().text.includes('every year on 10 Tevet'), lastBot().text);
  });

  await check('card: a yahrzeit with no year says it starts from the next one, in three languages; with a year it does not', async () => {
    for (const language of ['en', 'he', 'ru']) {
      currentUser = nativeUser(language);
      const text = await getBotMessage(language, 'hebrewRepeat.notice.yahrzeitNext');
      assert(!!text && !text.startsWith('hebrewRepeat') && !text.includes('{'), `${language}: ${text}`);
      await showEventConfirmation(555, undefined, hebrewEvent({ recurrence: { frequency: 'yearly', calendar: 'hebrew', hebrewKind: 'yahrzeit', hebrewNoYear: true } }), 'x', currentUser);
      assert(lastBot().text.includes(`<i>${text}</i>`), `${language}: ${lastBot().text}`);
      await showEventConfirmation(555, undefined, hebrewEvent(), 'x', currentUser);
      assert(!lastBot().text.includes(text), `${language} with a year: ${lastBot().text}`);
    }
  });

  await check('card: a Hebrew reminder shows the line on its card and in its created message', async () => {
    const { resolveReminderIntents } = await import('../src/services/native-reminders/resolve');
    const rem = hebrewEvent({ title: 'Light a candle', kind: 'reminder', forPerson: 'self', startTime: at('2026-12-20 00:00'), endTime: at('2026-12-20 00:00') });
    const resolved = (await resolveReminderIntents(currentUser, [createIntent(rem)], IL)).intents[0].event!;
    await showEventConfirmation(555, undefined, resolved, 'x', currentUser);
    assert(lastBot().text.includes('🔄 Yahrzeit, every year on 10 Tevet'), lastBot().text);
    assert(!lastBot().text.includes('Yearly'), lastBot().text);
    await handleEventCallback(555, 701, 'q1', 'create', pendingIdOf(lastBot(), 'event_create:'));
    assert(lastBot().text.includes('🔄 Yahrzeit, every year on 10 Tevet'), lastBot().text);
    assertEqual(hebrewFieldsOf(nativeInput()), HEBREW_CREATE, 'fields');
  });

  await check('card: the bulk line marks the repeat as before', async () => {
    await showBulkConfirmation(555, [hebrewIntent(), createIntent(plainEvent())], currentUser, 'x', t, fakeService as never, IL);
    const text = serviceCalls[0].text;
    assert(text.includes('Yahrzeit for Dad</b> 🔁'), text);
    assert(!text.includes(await notice('en')), 'a native bulk card has the Google notice');
  });

  await check('card: a Gregorian repeat\'s card is unchanged', async () => {
    await showEventConfirmation(555, undefined, plainEvent({ recurrence: { frequency: 'weekly', daysOfWeek: ['TU'] } }), 'x', currentUser);
    assert(lastBot().text.includes('🔄 Weekly (Tue)'), lastBot().text);
  });

  await check('copy: the Hebrew repeat lines and notices exist in en, he and ru with no leftover placeholder', async () => {
    for (const language of ['en', 'he', 'ru']) {
      for (const key of ['hebrewRepeat.line.anniversary', 'hebrewRepeat.line.yahrzeit']) {
        const text = await getBotMessage(language, key, { date: 'DATE' });
        assert(text.includes('DATE') && !text.startsWith('hebrewRepeat') && !/\{\w+\}/.test(text), `${language} ${key}: ${text}`);
      }
      for (const key of ['hebrewRepeat.notice.google', 'hebrewRepeat.notice.yahrzeitNext']) {
        const text = await getBotMessage(language, key);
        assert(!text.startsWith('hebrewRepeat') && !/\{\w+\}/.test(text), `${language} ${key}: ${text}`);
      }
    }
  });

  await check('the model and the thinking level are untouched', () => {
    const models = readFileSync(path.resolve(SRC, 'config/ai-models.ts'), 'utf8');
    assert(/AI_MODEL_ID/.test(models), 'no AI_MODEL_ID');
    const prompt = buildEventExtractionPrompt('en', CALENDARS, IL);
    assert(!/thinking/i.test(prompt), 'the prompt talks about thinking');
  });

  let failed = 0;
  const print = process.stdout.write.bind(process.stdout);
  for (const r of results) {
    print(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}\n`);
    if (!r.ok) failed++;
  }
  print(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})\n`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

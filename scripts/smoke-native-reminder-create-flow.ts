// Smoke test for creating native reminders end to end (spec §3.2-3.3): resolution (the
// creator's main calendar whatever the model picked, the partner as target only when
// they can be pinged, "an hour before the dentist" placed from the calendar, the no-time
// note after 09:00), the card's plain date and the created reply's "today at 17:00" /
// "tomorrow" / "on Fri, Oct 16 at 10:00" in three languages, the card, the confirm,
// auto-create, the bulk card (whose confirm threw after the first create: Redis hands
// its times back as strings), reply-to-correct and the quick time fix, and the voice
// and forwarded-text handlers that wire them.
// Events and Google users must come out as before.
//
// Telegram, Redis, Prisma, the AI, the calendar provider and the partner lookup are
// faked; the clock is set by hand. No network.
//
// Run under both clocks; the output must not depend on the server's timezone:
//   TZ=UTC npx tsx scripts/smoke-native-reminder-create-flow.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-native-reminder-create-flow.ts

import Module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromZonedTime } from 'date-fns-tz';
import type { CalendarAssignment, CalendarEvent, UserConfig } from '../src/types';
import type { ParsedEvent, VoiceIntentResult } from '../src/services/event-parser';
import type { PartnerSummary } from '../src/services/native-reminders/ownership';

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
const NY = 'America/New_York';
const at = (local: string, tz = IL) => fromZonedTime(local, tz);

// ---- Fakes ----

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

/** What Telegram was asked to send or edit. */
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

const tracked: Array<{ userId: number; action: string; metadata?: Record<string, unknown> }> = [];
const flags = { autoCreate: false };
let support: { supported: boolean; reason?: string } = { supported: true };

const raziel: PartnerSummary = {
  id: 2, name: 'Raziel', englishName: 'Raziel', gender: 'male', calendarSource: 'NATIVE', telegramId: BigInt(1002), language: 'he',
};
let partner: PartnerSummary | null = raziel;
let partnerLookups = 0;
async function fakePartnerLookup(_userId: number, pairingId: string | null) {
  partnerLookups++;
  return pairingId ? partner : null;
}

const TIMEZONES: Record<number, string> = { 1: IL, 3: NY };
const CALENDARS: CalendarAssignment[] = [
  { calendarId: 'native:main-1', labels: ['primary', 'yours'], name: 'Dana', color: '#000000' },
  { calendarId: 'native:raziel-cal', labels: ['spouse'], name: 'Raziel', color: '#111111' },
];
const dana = {
  id: 1, name: 'Dana', englishName: 'Dana', language: 'en', telegramId: 1001, calendarSource: 'NATIVE',
  pairingId: 'pair-1', isAdmin: false, voiceInputEnabled: true, googleRefreshToken: '',
  // Two calendars, so an event card offers 📁 Cal and a reminder card must not
  calendarAssignments: CALENDARS,
} as unknown as UserConfig;
const nyUser = { ...dana, id: 3, pairingId: null } as unknown as UserConfig;
let currentUser: UserConfig = dana;

/** The events the provider holds in any range, and what it was asked to create. */
let rangeEvents: CalendarEvent[] = [];
let created: Array<{ calendarId: string; input: Record<string, unknown> }> = [];
const fakeProvider = {
  fetchEventsInRange: async () => rangeEvents,
  createEvent: async (_user: unknown, calendarId: string, input: Record<string, unknown>) => {
    created.push({ calendarId, input });
    return { success: true, eventId: `ev${created.length}` };
  },
  deleteEvent: async () => ({ success: true }),
};

/**
 * The AI matcher: the listed events whose title holds the user's description; one is a
 * match, two are "multiple". Every prompt is kept.
 */
let matcherPrompts: string[] = [];
async function fakeMatcher(prompt: string) {
  matcherPrompts.push(prompt);
  const description = (/User's description: "(.*)"/.exec(prompt)?.[1] ?? '').toLowerCase().replace(/^the /, '');
  const listed = prompt.split('Available events:\n')[1].split('\n\n')[0].split('\n');
  const hits = listed.flatMap((line, i) => (line.toLowerCase().includes(description) ? [i + 1] : []));
  const answer = hits.length === 0 ? { match: 'none' } : hits.length === 1 ? { match: 'single', eventIndex: hits[0] } : { match: 'multiple', matchedIndexes: hits };
  return { text: JSON.stringify(answer) };
}
/** Gemini for reply-to-correct and the quick fix: answers `geminiText`, keeps each prompt. */
let geminiText = '{}';
let geminiPrompts: string[] = [];
const fakeGemini = {
  models: {
    generateContent: async ({ contents }: { contents: Array<{ parts: Array<{ text?: string }> }> }) => {
      geminiPrompts.push(contents[0].parts.map(p => p.text ?? '').join(''));
      return { text: geminiText, usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } };
    },
  },
};

/** The voice and forwarded-text extraction: answers the set intents, keeps the arguments. */
let extracted: VoiceIntentResult[] = [];
let voiceCalls: unknown[][] = [];
async function fakeVoiceExtraction(...args: unknown[]) {
  voiceCalls.push(args);
  return {
    intentResult: extracted[0], intentResults: extracted, transcription: 'remind Raziel to call the plumber',
    metrics: { model: 'fake', inputTokens: 0, outputTokens: 0, durationMs: 0 },
  };
}
let textCalls: unknown[][] = [];
async function fakeTextExtraction(...args: unknown[]) {
  textCalls.push(args);
  return { intentResult: extracted[0], intentResults: extracted, metrics: { model: 'fake', inputTokens: 0, outputTokens: 0, durationMs: 0 } };
}

function reset() {
  clock = at('2026-10-14 10:30').getTime(); // Wednesday morning in Israel
  store.clear();
  botCalls = [];
  serviceCalls = [];
  tracked.length = 0;
  created = [];
  rangeEvents = [];
  matcherPrompts = [];
  geminiPrompts = [];
  geminiText = '{}';
  extracted = [];
  voiceCalls = [];
  textCalls = [];
  flags.autoCreate = false;
  support = { supported: true };
  partner = raziel;
  partnerLookups = 0;
  currentUser = dana;
}

// ---- Module fakes ----

const SRC = path.resolve(__dirname, '../src');

/** Part of a module faked, the rest read through to the real one (a proxy: the store and ownership import each other). */
const fakeOver = (real: Record<string, unknown>, fakes: Record<string, unknown>) =>
  new Proxy(real, { get: (target, key) => (typeof key === 'string' && key in fakes ? fakes[key] : Reflect.get(target, key)) });

/** Modules replaced by fakes, by package name or file path; a function fakes part of the real module. */
const stubs: Record<string, object | ((real: Record<string, unknown>) => object)> = {
  '@googleapis/calendar': { calendar: () => ({}), auth: { OAuth2: class {} } },
  [`${SRC}/utils/redis.ts`]: { redis: fakeRedis },
  [`${SRC}/utils/prisma.ts`]: { prisma: {}, withRetry: (fn: () => unknown) => fn() },
  [`${SRC}/lib/error-capture.ts`]: { captureError: () => {}, captureWarning: () => {}, captureInfo: () => {} },
  [`${SRC}/lib/timezone.ts`]: { resolveUserTimezone: async (u: { id: number }) => TIMEZONES[u.id] ?? IL },
  [`${SRC}/services/ai-provider.ts`]: { generateAICompletion: fakeMatcher, getGemini: () => fakeGemini, extractionConfig: () => ({}) },
  [`${SRC}/services/telegram/index.ts`]: { getBot: () => fakeBot, getMessagingService: () => fakeService },
  [`${SRC}/services/telegram/bot.ts`]: { getBot: () => fakeBot, getMessagingService: () => fakeService },
  [`${SRC}/services/analytics-service.ts`]: {
    trackActivityAsync: (userId: number, action: string, metadata?: Record<string, unknown>) => tracked.push({ userId, action, metadata }),
    addBreadcrumb: () => {},
    setUserContext: () => {},
  },
  [`${SRC}/services/subscription-service.ts`]: { checkFeatureAccess: async () => ({ allowed: true }), incrementUsage: async () => {} },
  [`${SRC}/services/user-service.ts`]: { getUserByTelegramId: async () => currentUser },
  [`${SRC}/services/reminder-cache.ts`]: { getVoiceAutoCreateHighConf: async () => flags.autoCreate, getVoiceTtsOutcome: async () => false },
  [`${SRC}/services/voice/recent-events-store.ts`]: {
    pushRecentEvent: async () => {}, removeRecentEvent: async () => {}, getRecentEvents: async () => [], formatRecentEventsBlock: () => '',
  },
  [`${SRC}/services/voice/audio-retry.ts`]: {
    isInRetryMode: async () => false, readRetryAudio: async () => null, clearRetryMode: async () => {}, stashFailedAudio: async () => {},
  },
  [`${SRC}/services/native-reminders/support.ts`]: { getReminderSupport: async () => support },
  [`${SRC}/services/calendar-provider/index.ts`]: {
    getProviderForUser: () => fakeProvider, hasUsableCalendar: async () => true, getCalendarAssignmentsForUser: async () => CALENDARS,
  },
  [`${SRC}/services/forward-event/gemini-text.ts`]: { processTextWithGemini: fakeTextExtraction },
  [`${SRC}/services/native-calendar/event-store.ts`]: real => fakeOver(real, { getMainNativeCalendar: async (userId: number) => ({ id: `main-${userId}` }) }),
  [`${SRC}/services/native-reminders/ownership.ts`]: real => fakeOver(real, { getActivePartnerSummary: fakePartnerLookup }),
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

/** A partial fake is built once from the real module, then served to require() and import() alike. */
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

// Static imports compile to require() and pass through Module._load.
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

// The handlers load some modules with import(), which goes through the ES module loader
// instead; it gets the same fake, served as an ES module.
(globalThis as { reminderSmokeFake?: (file: string) => object }).reminderSmokeFake = file =>
  fakeFor(file, () => realLoad.call(Module, file, null, false));
Module.registerHooks({
  load(url, context, nextLoad) {
    const file = url.startsWith('file:') ? fileURLToPath(url.split('?')[0]) : '';
    if (!(file in stubs) || loadingReal.has(file)) return nextLoad(url, context);
    const fake = (globalThis as unknown as { reminderSmokeFake: (file: string) => object }).reminderSmokeFake(file);
    const names = Object.keys(fake).map(name => `export const ${name} = fake.${name};`).join('\n');
    return { format: 'module', shortCircuit: true, source: `const fake = globalThis.reminderSmokeFake(${JSON.stringify(file)});\n${names}\n` };
  },
});

// ---- Fixtures ----

/** A reminder as the parser hands it over: the model picked the partner's calendar, as it does for "remind Raziel". */
const parsedReminder = (over: Partial<ParsedEvent> = {}): ParsedEvent => ({
  title: 'Call the plumber',
  startTime: at('2026-10-15 10:00'),
  endTime: at('2026-10-15 10:00'),
  allDay: false,
  calendarId: 'native:raziel-cal',
  calendarName: 'Raziel',
  confidence: 'high',
  kind: 'reminder',
  forPerson: 'self',
  ...over,
});
const dateOnly = (day: string, tz = IL) => ({ allDay: true, startTime: fromZonedTime(`${day} 00:00`, tz), endTime: fromZonedTime(`${day} 00:00`, tz) });
const anchored = (description: string, offsetMinutes: number) =>
  parsedReminder({ anchor: { description, offsetMinutes }, startTime: new Date(NaN), endTime: new Date(NaN) });
const createIntent = (event: ParsedEvent, confidence: 'high' | 'medium' | 'low' = 'medium'): VoiceIntentResult =>
  ({ intent: 'create', confidence, event });
const calendarEvent = (summary: string, start: string, end: string, extra: Partial<CalendarEvent> = {}): CalendarEvent =>
  ({ summary, start, end, calendarName: 'Dana', calendarId: 'native:main-1', ...extra });
const iso = (local: string) => at(local).toISOString();

const sameInstant = (a: unknown, b: Date) => a instanceof RealDate && a.getTime() === b.getTime();
const lastBot = () => botCalls[botCalls.length - 1];
const buttonsOf = (call: Sent) =>
  ((call.opts?.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }).inline_keyboard);
const pendingIdOf = (call: Sent, prefix: string) =>
  buttonsOf(call).flat().find(b => b.callback_data.startsWith(prefix))!.callback_data.slice(prefix.length);

async function main() {
  const { getBotMessage, getBotMessages } = await import('../src/lib/bot-messages');
  const resolve = await import('../src/services/native-reminders/resolve');
  const { resolveReminderForCreate, resolveReminderIntents, reminderCreateFields, anchorCandidates, reminderTimeFromAnchor } = resolve;
  const confirmations = await import('../src/services/voice/confirmations');
  const { showEventConfirmation, formatEventDateTime, formatReminderWhen, formatReminderRelativeWhen, reminderCreatedLine } = confirmations;
  const { handleEventCallback } = await import('../src/services/voice/callbacks');
  const { autoCreateEvent } = await import('../src/services/voice/auto-create');
  const { showBulkConfirmation, handleBulkConfirmAll } = await import('../src/services/voice/bulk-confirmations');
  const { handleEventCorrection } = await import('../src/services/voice/correction-handler');
  const { extractFieldPatch } = await import('../src/services/voice/quick-correction');
  const { formatReminderOutcomeLine } = await import('../src/services/voice/tts-outcome');
  const { handleVoiceMessage } = await import('../src/services/voice/handler');
  const { handleForwardedMessage } = await import('../src/services/forward-event/handler');
  const t = await getBotMessages('en');

  /** A reminder resolved as the handlers resolve it, for the tests of what comes after. */
  const resolved = async (event: ParsedEvent) => {
    const { intents } = await resolveReminderIntents(dana, [createIntent(event)], IL);
    assert(!!intents[0].event, `not resolved: ${JSON.stringify(intents[0])}`);
    return intents[0].event;
  };
  const voice = { file_id: 'f1', file_unique_id: 'u1', duration: 4 };
  const from = { id: 1001, first_name: 'Dana' };

  // ---- resolveReminderForCreate: calendar and target ----

  await check('resolve: "remind me" goes on the creator\'s main calendar, not the one the model picked, with no length', async () => {
    const r = await resolveReminderForCreate(dana, parsedReminder(), IL);
    assert(r.ok, JSON.stringify(r));
    assert(r.calendarId === 'native:main-1', `calendar ${r.calendarId}`);
    assert(r.forUserId === null && r.notice === undefined, `target ${r.forUserId} notice ${r.notice}`);
    assert(sameInstant(r.startTime, at('2026-10-15 10:00')) && sameInstant(r.endTime, at('2026-10-15 10:00')), `times ${r.startTime.toISOString()} ${r.endTime.toISOString()}`);
    assert(partnerLookups === 0, 'looked the partner up for a self reminder');
  });

  await check('resolve: "remind Raziel" is the partner\'s when they are on the built-in calendar and Telegram', async () => {
    const r = await resolveReminderForCreate(dana, parsedReminder({ forPerson: 'partner' }), IL);
    assert(r.ok && r.forUserId === 2 && r.notice === undefined, JSON.stringify(r));
  });

  await check('resolve: a partner who isn\'t on Telegram leaves it the creator\'s, with a notice', async () => {
    partner = { ...raziel, telegramId: null };
    const r = await resolveReminderForCreate(dana, parsedReminder({ forPerson: 'partner' }), IL);
    assert(r.ok && r.forUserId === null && r.notice === 'partner_not_on_telegram', JSON.stringify(r));
  });

  await check('resolve: a partner on Google, or no partner, leaves it the creator\'s with no notice', async () => {
    partner = { ...raziel, calendarSource: 'GOOGLE' };
    const google = await resolveReminderForCreate(dana, parsedReminder({ forPerson: 'partner' }), IL);
    assert(google.ok && google.forUserId === null && google.notice === undefined, `google ${JSON.stringify(google)}`);
    partner = null;
    const unpaired = await resolveReminderForCreate(dana, parsedReminder({ forPerson: 'partner' }), IL);
    assert(unpaired.ok && unpaired.forUserId === null && unpaired.notice === undefined, `unpaired ${JSON.stringify(unpaired)}`);
  });

  // ---- resolveReminderForCreate: the no-time note ----

  await check('resolve: a date-only reminder for today notes "no time set" only once its 09:00 ping is past the 15-minute grace', async () => {
    const today = parsedReminder(dateOnly('2026-10-14'));
    const before = await resolveReminderForCreate(dana, today, IL, at('2026-10-14 08:59'));
    assert(before.ok && before.notice === undefined, `08:59: ${JSON.stringify(before)}`);
    // The pass still pings it at 09:05 (within the grace), so the card mustn't say it has no time
    const inGrace = await resolveReminderForCreate(dana, today, IL, at('2026-10-14 09:05'));
    assert(inGrace.ok && inGrace.notice === undefined, `09:05: ${JSON.stringify(inGrace)}`);
    const pastGrace = await resolveReminderForCreate(dana, today, IL, at('2026-10-14 09:20'));
    assert(pastGrace.ok && pastGrace.notice === 'no_time_set', `09:20: ${JSON.stringify(pastGrace)}`);
    const after = await resolveReminderForCreate(dana, today, IL, at('2026-10-14 09:30'));
    assert(after.ok && after.notice === 'no_time_set', `09:30: ${JSON.stringify(after)}`);
    assert(after.allDay && sameInstant(after.startTime, at('2026-10-14 00:00')) && sameInstant(after.endTime, after.startTime), `times ${after.startTime.toISOString()} ${after.endTime.toISOString()}`);
    const tomorrow = await resolveReminderForCreate(dana, parsedReminder(dateOnly('2026-10-15')), IL, at('2026-10-14 09:30'));
    assert(tomorrow.ok && tomorrow.notice === undefined, `tomorrow: ${JSON.stringify(tomorrow)}`);
  });

  await check('resolve: "after 09:00" is the creator\'s own 09:00 (New York), not Israel\'s', async () => {
    const today = parsedReminder(dateOnly('2026-10-14', NY));
    // 08:30 in New York is 15:30 in Israel
    const before = await resolveReminderForCreate(nyUser, today, NY, at('2026-10-14 08:30', NY));
    assert(before.ok && before.notice === undefined, `08:30 NY: ${JSON.stringify(before)}`);
    const after = await resolveReminderForCreate(nyUser, today, NY, at('2026-10-14 09:30', NY));
    assert(after.ok && after.notice === 'no_time_set', `09:30 NY: ${JSON.stringify(after)}`);
  });

  await check('resolve: a one-off whose time passed over 15 minutes ago notes "time passed"; a repeating one doesn\'t', async () => {
    // Wednesday 10:30 in Israel
    const timed = (local: string, over: Partial<ParsedEvent> = {}) =>
      resolveReminderForCreate(dana, parsedReminder({ startTime: at(local), endTime: at(local), ...over }), IL);
    const inGrace = await timed('2026-10-14 10:20'); // still pings
    assert(inGrace.ok && inGrace.notice === undefined, `10:20: ${JSON.stringify(inGrace)}`);
    const passed = await timed('2026-10-14 10:10');
    assert(passed.ok && passed.notice === 'time_passed', `10:10: ${JSON.stringify(passed)}`);
    const yesterday = await resolveReminderForCreate(dana, parsedReminder(dateOnly('2026-10-13')), IL);
    assert(yesterday.ok && yesterday.notice === 'time_passed', `date-only yesterday: ${JSON.stringify(yesterday)}`);
    // Its next occurrence pings, so nothing to say
    const daily = await timed('2026-10-14 08:00', { recurrence: { frequency: 'daily' } });
    assert(daily.ok && daily.notice === undefined, `daily: ${JSON.stringify(daily)}`);
    // One notice only: a partner who can't be pinged comes first
    partner = { ...raziel, telegramId: null };
    const unreachable = await timed('2026-10-14 08:00', { forPerson: 'partner' });
    assert(unreachable.ok && unreachable.notice === 'partner_not_on_telegram', `partner: ${JSON.stringify(unreachable)}`);
  });

  // ---- resolveReminderForCreate: anchors ----

  await check('anchor: "an hour before the dentist" is the dentist\'s start minus an hour', async () => {
    rangeEvents = [calendarEvent('Dentist', iso('2026-10-15 10:00'), iso('2026-10-15 11:00'))];
    const r = await resolveReminderForCreate(dana, anchored('the dentist', -60), IL);
    assert(r.ok && !r.allDay && sameInstant(r.startTime, at('2026-10-15 09:00')) && sameInstant(r.endTime, at('2026-10-15 09:00')), JSON.stringify(r));
  });

  await check('anchor: reminders and events already started are never the anchor', async () => {
    rangeEvents = [
      calendarEvent('Dentist', iso('2026-10-12 10:00'), iso('2026-10-12 11:00')),
      calendarEvent('Dentist', iso('2026-10-15 08:00'), iso('2026-10-15 08:00'), { eventType: 'reminder' }),
      calendarEvent('Dentist', iso('2026-10-16 10:00'), iso('2026-10-16 11:00')),
    ];
    const r = await resolveReminderForCreate(dana, anchored('the dentist', -60), IL);
    assert(r.ok && sameInstant(r.startTime, at('2026-10-16 09:00')), JSON.stringify(r));
    const listed = matcherPrompts[0].split('Available events:\n')[1].split('\n\n')[0].split('\n');
    assert(listed.length === 1 && listed[0].includes('Friday 2026-10-16'), `matcher saw ${JSON.stringify(listed)}`);
  });

  await check('anchor: a repeating event counts once, at its next occurrence', async () => {
    rangeEvents = [
      calendarEvent('Piano', iso('2026-10-22 16:00'), iso('2026-10-22 17:00'), { recurringEventId: 'piano' }),
      calendarEvent('Piano', iso('2026-10-15 16:00'), iso('2026-10-15 17:00'), { recurringEventId: 'piano' }),
    ];
    const r = await resolveReminderForCreate(dana, anchored('piano', -30), IL);
    assert(r.ok && sameInstant(r.startTime, at('2026-10-15 15:30')), JSON.stringify(r));
    const kept = anchorCandidates(rangeEvents, new RealDate(clock), IL);
    assert(kept.length === 1 && kept[0].start === iso('2026-10-15 16:00'), `candidates ${JSON.stringify(kept)}`);
  });

  await check('anchor: two different matching events ask which one; none asks for a time', async () => {
    rangeEvents = [
      calendarEvent('Dentist', iso('2026-10-15 10:00'), iso('2026-10-15 11:00')),
      calendarEvent('Dentist', iso('2026-10-19 10:00'), iso('2026-10-19 11:00')),
    ];
    const two = await resolveReminderForCreate(dana, anchored('the dentist', -60), IL);
    assert(!two.ok && two.error === 'anchor_ambiguous', JSON.stringify(two));
    rangeEvents = [calendarEvent('Gym', iso('2026-10-15 07:00'), iso('2026-10-15 08:00'))];
    const none = await resolveReminderForCreate(dana, anchored('the dentist', -60), IL);
    assert(!none.ok && none.error === 'anchor_not_found', JSON.stringify(none));
  });

  await check('anchor: an all-day event takes a whole-day offset (date-only) but asks about an hour one', async () => {
    rangeEvents = [calendarEvent('Noa\'s birthday', '2026-10-18', '2026-10-19')];
    const dayBefore = await resolveReminderForCreate(dana, anchored('birthday', -1440), IL);
    assert(dayBefore.ok && dayBefore.allDay && sameInstant(dayBefore.startTime, at('2026-10-17 00:00')), JSON.stringify(dayBefore));
    const hourBefore = await resolveReminderForCreate(dana, anchored('birthday', -60), IL);
    assert(!hourBefore.ok && hourBefore.error === 'anchor_needs_time', JSON.stringify(hourBefore));
  });

  // ---- resolveReminderIntents ----

  await check('intents: reminders are resolved in place, events and edits untouched, the partner looked up once', async () => {
    const event = parsedReminder({ kind: undefined, title: 'Dinner', forPerson: undefined });
    const edit: VoiceIntentResult = { intent: 'edit', confidence: 'high', eventReference: { type: 'last_created' } };
    const { intents, failures } = await resolveReminderIntents(dana, [
      createIntent(event),
      createIntent(parsedReminder({ forPerson: 'partner' })),
      createIntent(parsedReminder({ forPerson: 'partner', title: 'Buy milk', ...dateOnly('2026-10-16') })),
      createIntent(anchored('the dentist', -60)),
      edit,
    ], IL);
    assert(intents[0].event === event && intents[4] === edit, 'an event or an edit was changed');
    const r = intents[1].event!;
    assert(r.calendarId === 'native:main-1' && r.forUserId === 2 && r.forName === 'Raziel' && r.anchor === undefined, JSON.stringify(r));
    assert(intents[2].event!.allDay && intents[2].event!.forUserId === 2, JSON.stringify(intents[2]));
    assert(!intents[3].event && intents[3].error === 'anchor_not_found', JSON.stringify(intents[3]));
    assert(JSON.stringify(failures) === '[{"error":"anchor_not_found","description":"the dentist"}]', JSON.stringify(failures));
    assert(partnerLookups === 1, `${partnerLookups} partner lookups`);
  });

  await check('intents: forwarded text (selfOnly) keeps every reminder the forwarder\'s', async () => {
    const { intents } = await resolveReminderIntents(dana, [createIntent(parsedReminder({ forPerson: 'partner' }))], IL, { selfOnly: true });
    const r = intents[0].event!;
    assert(r.forPerson === 'self' && r.forUserId === null && r.forName === undefined, JSON.stringify(r));
    assert(partnerLookups === 0, `${partnerLookups} partner lookups`);
  });

  await check('create fields: nothing for an event; kind, target and a zero length for a reminder', async () => {
    assert(JSON.stringify(reminderCreateFields(parsedReminder({ kind: undefined }))) === '{}', 'an event (no kind) got fields');
    const fields = reminderCreateFields({ ...parsedReminder(), endTime: at('2026-10-15 11:00'), forUserId: 2 });
    assert(fields.kind === 'reminder' && fields.forUserId === 2 && sameInstant(fields.endTime, at('2026-10-15 10:00')), JSON.stringify(fields));
  });

  // ---- When it fires: the plain date on the card, today/tomorrow in the created reply ----

  await check('when, card: the short date and time in English, Hebrew and Russian, even for today', async () => {
    const plain = [
      { event: { startTime: at('2026-10-15 10:00'), allDay: false }, want: { en: 'Thu, Oct 15, 10:00', he: 'יום ה׳, 15 באוק׳, 10:00', ru: 'чт, 15 окт., 10:00' } },
      { event: { startTime: at('2026-10-14 17:00'), allDay: false }, want: { en: 'Wed, Oct 14, 17:00', he: 'יום ד׳, 14 באוק׳, 17:00', ru: 'ср, 14 окт., 17:00' } },
      { event: dateOnly('2026-10-16'), want: { en: 'Fri, Oct 16', he: 'יום ו׳, 16 באוק׳', ru: 'пт, 16 окт.' } },
    ];
    for (const { event, want } of plain) {
      for (const language of ['en', 'he', 'ru'] as const) {
        const got = formatReminderWhen(event, language, IL);
        assert(got === want[language], `${language} ${event.startTime.toISOString()}: ${got}`);
      }
    }
  });

  await check('when, created reply: today, tomorrow or the date, timed and date-only, in English, Hebrew and Russian', async () => {
    // Wednesday 10:30 in Israel
    const relative = [
      { event: { startTime: at('2026-10-14 17:00'), allDay: false }, want: { en: 'today at 17:00', he: 'היום ב-17:00', ru: 'сегодня в 17:00' } },
      { event: { startTime: at('2026-10-15 10:00'), allDay: false }, want: { en: 'tomorrow at 10:00', he: 'מחר ב-10:00', ru: 'завтра в 10:00' } },
      { event: { startTime: at('2026-10-16 10:00'), allDay: false }, want: { en: 'on Fri, Oct 16 at 10:00', he: 'ביום ו׳, 16 באוק׳, ב-10:00', ru: '16 октября в 10:00' } },
      { event: dateOnly('2026-10-14'), want: { en: 'today', he: 'היום', ru: 'сегодня' } },
      { event: dateOnly('2026-10-15'), want: { en: 'tomorrow', he: 'מחר', ru: 'завтра' } },
      { event: dateOnly('2026-10-16'), want: { en: 'Fri, Oct 16', he: 'יום ו׳, 16 באוק׳', ru: '16 октября' } },
    ];
    for (const { event, want } of relative) {
      for (const language of ['en', 'he', 'ru'] as const) {
        const got = await formatReminderRelativeWhen(event, language, IL);
        assert(got === want[language], `${language} ${event.allDay ? 'date-only ' : ''}${event.startTime.toISOString()}: ${got}`);
      }
    }
  });

  await check('when, created reply: "today" and "tomorrow" are the user\'s own days, not the server\'s', async () => {
    clock = at('2026-10-14 23:30').getTime(); // 20:30 UTC, 16:30 in New York
    const pastMidnight = await formatReminderRelativeWhen({ startTime: at('2026-10-15 00:30'), allDay: false }, 'en', IL);
    assert(pastMidnight === 'tomorrow at 00:30', `Israel: ${pastMidnight}`);
    // 20:00 in New York is already 03:00 on Thursday in Israel
    const evening = await formatReminderRelativeWhen({ startTime: at('2026-10-14 20:00', NY), allDay: false }, 'en', NY);
    assert(evening === 'today at 20:00', `New York: ${evening}`);
    const thursday = await formatReminderRelativeWhen(dateOnly('2026-10-15', NY), 'en', NY);
    assert(thursday === 'tomorrow', `New York, date-only: ${thursday}`);
  });

  // ---- The card ----

  await check('card: a timed reminder for the partner, with no end time and no 📁 Cal button', async () => {
    const event = await resolved(parsedReminder({ forPerson: 'partner' }));
    await showEventConfirmation(555, undefined, event, 'remind Raziel to call the plumber', dana);
    const card = lastBot();
    assert(card.text.startsWith('⏰ <b>Call the plumber</b>\n📆 Thu, Oct 15, 10:00 · for Raziel\n\n'), card.text);
    assert(!card.text.includes(' - ') && !card.text.includes('📁') && !card.text.includes(t.voice.confirmTitle), card.text);
    const buttons = buttonsOf(card);
    assert(buttons[0][0].text === t.voice.createButton, `create button ${buttons[0][0].text}`);
    assert(!buttons.flat().some(b => b.callback_data.startsWith('event_fix:cal:')), 'offers 📁 Cal');
    const pending = await fakeRedis.get(`voice:pending:event:${pendingIdOf(card, 'event_create:')}`);
    assert(pending?.event?.kind === 'reminder' && pending.event.forUserId === 2, `pending ${JSON.stringify(pending?.event)}`);
  });

  await check('card: a date-only reminder for today after 09:00 says it has no time', async () => {
    const event = await resolved(parsedReminder(dateOnly('2026-10-14')));
    await showEventConfirmation(555, undefined, event, 'remind me to call the plumber today', dana);
    const noTime = await getBotMessage('en', 'nativeReminders.card.noTimeSet');
    assert(lastBot().text.startsWith(`⏰ <b>Call the plumber</b>\n📆 Wed, Oct 14\n\n<i>${noTime}</i>`), lastBot().text);
  });

  await check('card: a partner who isn\'t on Telegram gets "keep as mine" on the button', async () => {
    partner = { ...raziel, telegramId: null };
    const event = await resolved(parsedReminder({ forPerson: 'partner' }));
    await showEventConfirmation(555, undefined, event, 'remind Raziel to call the plumber', dana);
    const notice = await getBotMessage('en', 'nativeReminders.card.partnerNotOnTelegram', { name: 'Raziel' });
    assert(lastBot().text.includes(`<i>${notice}</i>`) && !lastBot().text.includes('for Raziel'), lastBot().text);
    assert(buttonsOf(lastBot())[0][0].text === t.nativeReminders.card.keepAsMine, `button ${buttonsOf(lastBot())[0][0].text}`);
  });

  await check('card: titles with <, > and & are escaped, Hebrew too', async () => {
    const he = { ...dana, language: 'he' } as UserConfig;
    const event = await resolved(parsedReminder({ title: 'לקנות <חלב> & ביצים' }));
    await showEventConfirmation(555, undefined, event, 'x', he);
    assert(lastBot().text.includes('<b>לקנות &lt;חלב&gt; &amp; ביצים</b>') && !lastBot().text.includes('<חלב>'), lastBot().text);
  });

  await check('card: an event\'s card is as before, its title now escaped', async () => {
    const event: ParsedEvent = { title: 'Dentist', startTime: at('2026-10-15 10:00'), endTime: at('2026-10-15 11:00'), allDay: false, calendarId: 'native:main-1', calendarName: 'Dana', confidence: 'high' };
    await showEventConfirmation(555, undefined, event, 'dentist', dana);
    const when = formatEventDateTime(event, 'en', t.voice.allDay, IL);
    assert(lastBot().text === `${t.voice.confirmTitle}\n\n<b>Dentist</b>\n${when}\n📁 Dana\n\n<i>${t.voice.from} "dentist"</i>`, lastBot().text);
    assert(buttonsOf(lastBot()).flat().some(b => b.callback_data.startsWith('event_fix:cal:')), 'lost 📁 Cal');
    await showEventConfirmation(555, undefined, { ...event, title: 'R&D <sync>' }, 'x', dana);
    assert(lastBot().text.includes('<b>R&amp;D &lt;sync&gt;</b>'), lastBot().text);
  });

  await check('card: a date-only reminder given a time loses the no-time note when shown again', async () => {
    const event = await resolved(parsedReminder(dateOnly('2026-10-14')));
    assert(event.reminderNotice === 'no_time_set', `notice ${event.reminderNotice}`);
    const fixed = { ...event, allDay: false, startTime: at('2026-10-14 17:00'), endTime: at('2026-10-14 17:00') };
    await showEventConfirmation(555, undefined, fixed, 'x', dana);
    const noTime = await getBotMessage('en', 'nativeReminders.card.noTimeSet');
    assert(lastBot().text.startsWith('⏰ <b>Call the plumber</b>\n📆 Wed, Oct 14, 17:00\n\n') && !lastBot().text.includes(noTime), lastBot().text);
    const pending = await fakeRedis.get(`voice:pending:event:${pendingIdOf(lastBot(), 'event_create:')}`);
    assert(pending.event.reminderNotice === undefined, `pending notice ${pending.event.reminderNotice}`);
  });

  await check('card: a ⏰ quick fix to a later time clears "time passed"', async () => {
    rangeEvents = [calendarEvent('Dentist', iso('2026-10-14 11:00'), iso('2026-10-14 12:00'))];
    const event = await resolved(anchored('the dentist', -150)); // 08:30, two hours ago
    assert(event.reminderNotice === 'time_passed', `notice ${event.reminderNotice}`);
    const timePassed = await getBotMessage('en', 'nativeReminders.card.timePassed');
    await showEventConfirmation(555, undefined, event, 'x', dana);
    assert(lastBot().text.startsWith(`⏰ <b>Call the plumber</b>\n📆 Wed, Oct 14, 08:30\n\n<i>${timePassed}</i>`), lastBot().text);
    geminiText = '{"startTime": "17:00"}';
    const patch = await extractFieldPatch('time', null, '5pm', event, CALENDARS, 'en', IL);
    assert(!!patch, 'no patch');
    await showEventConfirmation(555, 701, { ...event, ...patch }, 'x', dana);
    assert(lastBot().text.includes('📆 Wed, Oct 14, 17:00') && !lastBot().text.includes(timePassed), lastBot().text);
    const pending = await fakeRedis.get(`voice:pending:event:${pendingIdOf(lastBot(), 'event_create:')}`);
    assert(pending.event.reminderNotice === undefined, `pending notice ${pending.event.reminderNotice}`);
  });

  // ---- Confirm, auto-create, replies ----

  await check('confirm: creates a reminder for the partner on the main calendar and says so', async () => {
    const event = await resolved(parsedReminder({ forPerson: 'partner' }));
    await showEventConfirmation(555, undefined, event, 'remind Raziel to call the plumber', dana);
    await handleEventCallback(555, 701, 'q1', 'create', pendingIdOf(lastBot(), 'event_create:'));
    assert(created.length === 1 && created[0].calendarId === 'native:main-1', JSON.stringify(created));
    const input = created[0].input;
    assert(input.kind === 'reminder' && input.forUserId === 2, JSON.stringify(input));
    assert(sameInstant(input.startTime, at('2026-10-15 10:00')) && sameInstant(input.endTime, at('2026-10-15 10:00')), 'not zero-length');
    const line = await getBotMessage('en', 'nativeReminders.created.partner', { name: 'Raziel', when: 'tomorrow at 10:00' });
    assert(lastBot().text === `${line}\n\n<b>Call the plumber</b>`, lastBot().text);
    assert(tracked.some(e => e.action === 'native_reminder_created'), JSON.stringify(tracked));
  });

  await check('confirm: an event\'s create input is exactly what it was', async () => {
    const event: ParsedEvent = { title: 'Dentist', startTime: at('2026-10-15 10:00'), endTime: at('2026-10-15 11:00'), allDay: false, calendarId: 'native:main-1', calendarName: 'Dana', confidence: 'high' };
    await showEventConfirmation(555, undefined, event, 'dentist', dana);
    await handleEventCallback(555, 701, 'q1', 'create', pendingIdOf(lastBot(), 'event_create:'));
    assert(JSON.stringify(Object.keys(created[0].input)) === '["title","startTime","endTime","location","description","allDay","recurrence"]', JSON.stringify(created[0].input));
    assert(lastBot().text.startsWith(`${t.voice.created}\n\n<b>Dentist</b>\n`), lastBot().text);
    assert(!tracked.some(e => e.action === 'native_reminder_created'), 'tracked an event as a reminder');
  });

  await check('auto-create: a HIGH reminder is created with its fields and the reminder reply', async () => {
    flags.autoCreate = true;
    const event = await resolved(parsedReminder());
    const handled = await autoCreateEvent(dana, event, t, fakeService as never, 555);
    assert(handled && created[0].input.kind === 'reminder' && created[0].input.forUserId === null, JSON.stringify(created));
    const line = await getBotMessage('en', 'nativeReminders.created.self', { when: 'tomorrow at 10:00' });
    assert(serviceCalls[0].text === `${line}\n\n<b>Call the plumber</b>`, serviceCalls[0].text);
    assert(tracked.some(e => e.action === 'native_reminder_created' && e.metadata?.auto === true), JSON.stringify(tracked));
  });

  await check('replies: date-only, Hebrew and Russian lines fill every placeholder; the spoken line has no emoji', async () => {
    const event = await resolved(parsedReminder(dateOnly('2026-10-16')));
    const dateLine = await reminderCreatedLine(event, 'en', IL);
    assert(dateLine === await getBotMessage('en', 'nativeReminders.created.dateOnly', { when: 'Fri, Oct 16' }), dateLine);
    const forPartner = await resolved(parsedReminder({ forPerson: 'partner' }));
    for (const language of ['he', 'ru']) {
      const line = await reminderCreatedLine(forPartner, language, IL);
      assert(!line.includes('{') && line.includes('Raziel') && line.includes('10:00'), `${language}: ${line}`);
    }
    const spoken = await formatReminderOutcomeLine(forPartner, 'en', IL);
    assert(spoken === `${(await reminderCreatedLine(forPartner, 'en', IL)).replace('⏰ ', '')} Call the plumber.`, spoken);
  });

  // ---- Bulk ----

  await check('bulk: two reminders show as reminders and "Confirm all" creates both (dates revived from Redis)', async () => {
    const one = await resolved(parsedReminder({ forPerson: 'partner' }));
    const two = await resolved(parsedReminder({ title: 'Buy milk', ...dateOnly('2026-10-16') }));
    await showBulkConfirmation(555, [createIntent(one), createIntent(two)], dana, 'two reminders', t, fakeService as never, IL);
    const card = serviceCalls[0];
    assert(card.text.includes('1. ⏰ <b>Call the plumber</b> — Thu, Oct 15, 10:00 · for Raziel'), card.text);
    assert(card.text.includes('2. ⏰ <b>Buy milk</b> — Fri, Oct 16'), card.text);
    const pendingId = buttonsOf({ ...card, opts: { reply_markup: card.opts?.replyMarkup } })[0][0].callback_data.slice('bulk_confirm:'.length);
    const result = await handleBulkConfirmAll(pendingId);
    assert(result.successCount === 2 && result.failureCount === 0, JSON.stringify(result));
    assert(created.every(c => c.input.kind === 'reminder' && sameInstant(c.input.endTime, c.input.startTime as Date)), JSON.stringify(created));
    assert(created[0].input.forUserId === 2 && created[1].input.forUserId === null, JSON.stringify(created));
  });

  await check('bulk: a partner who can\'t be pinged is noted once under the list', async () => {
    partner = { ...raziel, telegramId: null };
    const one = await resolved(parsedReminder({ forPerson: 'partner' }));
    const two = await resolved(parsedReminder({ forPerson: 'partner', title: 'Buy milk' }));
    await showBulkConfirmation(555, [createIntent(one), createIntent(two)], dana, 'x', t, fakeService as never, IL);
    const notice = await getBotMessage('en', 'nativeReminders.card.partnerNotOnTelegram', { name: 'Raziel' });
    assert(serviceCalls[0].text.endsWith(`— Thu, Oct 15, 10:00\n\n<i>${notice}</i>`), serviceCalls[0].text);
  });

  await check('bulk: an event next to a reminder keeps its own input', async () => {
    const event: ParsedEvent = { title: 'Dentist', startTime: at('2026-10-15 10:00'), endTime: at('2026-10-15 11:00'), allDay: false, calendarId: 'native:main-1', confidence: 'high' };
    const reminder = await resolved(parsedReminder());
    await showBulkConfirmation(555, [createIntent(event), createIntent(reminder)], dana, 'x', t, fakeService as never, IL);
    const pendingId = (serviceCalls[0].opts?.replyMarkup as { inline_keyboard: Array<Array<{ callback_data: string }>> }).inline_keyboard[0][0].callback_data.slice('bulk_confirm:'.length);
    await handleBulkConfirmAll(pendingId);
    assert(!('kind' in created[0].input) && created[1].input.kind === 'reminder', JSON.stringify(created));
  });

  // ---- Reply-to-correct and the quick time fix ----

  await check('correction: a reminder keeps its target, calendar and zero length when the model adds an hour', async () => {
    const event = await resolved(parsedReminder({ forPerson: 'partner' }));
    await showEventConfirmation(555, undefined, event, 'remind Raziel to call the plumber', dana);
    const pendingId = pendingIdOf(lastBot(), 'event_create:');
    geminiText = JSON.stringify({ title: 'Call the plumber', startDate: '2026-10-15', startTime: '17:00', endDate: '2026-10-15', endTime: '18:00', allDay: false, calendarId: 'native:raziel-cal', calendarName: 'Raziel' });
    await handleEventCorrection(555, 1001, pendingId, 701, { text: 'make it 5pm' });
    assert(geminiPrompts[0].includes('This is a REMINDER'), 'prompt never said it is a reminder');
    const card = lastBot();
    assert(card.method === 'editMessageText' && card.text.includes('📆 Thu, Oct 15, 17:00 · for Raziel'), card.text);
    const pending = await fakeRedis.get(`voice:pending:event:${pendingIdOf(card, 'event_create:')}`);
    const e = pending.event;
    assert(e.kind === 'reminder' && e.forUserId === 2 && e.forName === 'Raziel' && e.calendarId === 'native:main-1', JSON.stringify(e));
    assert(e.startTime === at('2026-10-15 17:00').toISOString() && e.endTime === e.startTime, `times ${e.startTime} ${e.endTime}`);
  });

  await check('correction: an event\'s prompt has no reminder line', async () => {
    const event: ParsedEvent = { title: 'Dentist', startTime: at('2026-10-15 10:00'), endTime: at('2026-10-15 11:00'), allDay: false, calendarId: 'native:main-1', calendarName: 'Dana', confidence: 'high' };
    await showEventConfirmation(555, undefined, event, 'dentist', dana);
    geminiText = JSON.stringify({ title: 'Dentist', startDate: '2026-10-15', startTime: '17:00', endDate: '2026-10-15', endTime: '18:00', allDay: false, calendarId: 'native:main-1', calendarName: 'Dana' });
    await handleEventCorrection(555, 1001, pendingIdOf(lastBot(), 'event_create:'), 701, { text: 'make it 5pm' });
    assert(!geminiPrompts[0].includes('REMINDER') && geminiPrompts[0].includes('- All day: false\n\nUSER\'S CALENDARS:'), geminiPrompts[0]);
    assert(lastBot().text.includes('17:00 - 18:00'), lastBot().text);
  });

  await check('quick fix: a reminder\'s time is one time, and a date-only one becomes timed', async () => {
    const event = await resolved(parsedReminder(dateOnly('2026-10-16')));
    geminiText = '{"startTime": "17:00"}';
    const patch = await extractFieldPatch('time', null, '5pm', event, CALENDARS, 'en', IL);
    assert(geminiPrompts[0].includes('TIME of a reminder'), geminiPrompts[0]);
    assert(!!patch && sameInstant(patch.startTime, at('2026-10-16 17:00')) && sameInstant(patch.endTime, at('2026-10-16 17:00')) && patch.allDay === false, JSON.stringify(patch));
    geminiText = '{"startTime": "17:00", "endTime": "18:00"}';
    const eventPatch = await extractFieldPatch('time', null, '5pm', { ...event, kind: undefined, allDay: false }, CALENDARS, 'en', IL);
    assert(!!eventPatch && sameInstant(eventPatch.endTime, at('2026-10-16 18:00')) && eventPatch.allDay === undefined, JSON.stringify(eventPatch));
  });

  // ---- The handlers ----

  await check('voice: a supported user\'s prompt gets both names, and "remind Raziel" shows the reminder card', async () => {
    extracted = [createIntent(parsedReminder({ forPerson: 'partner' }))];
    await handleVoiceMessage(555, 1001, voice, from);
    const context = voiceCalls[0][6];
    assert(JSON.stringify(context) === '{"userName":"Dana","userEnglishName":"Dana","partnerName":"Raziel","partnerEnglishName":"Raziel"}', JSON.stringify(context));
    assert(lastBot()?.text.includes('📆 Thu, Oct 15, 10:00 · for Raziel'), JSON.stringify(botCalls));
  });

  await check('voice: an unsupported user gets no reminder context and the event flow as before', async () => {
    support = { supported: false, reason: 'no_access' };
    const event: ParsedEvent = { title: 'Dentist', startTime: at('2026-10-15 10:00'), endTime: at('2026-10-15 11:00'), allDay: false, calendarId: 'native:main-1', calendarName: 'Dana', confidence: 'medium' };
    extracted = [createIntent(event)];
    await handleVoiceMessage(555, 1001, voice, from);
    assert(voiceCalls[0].length === 7 && voiceCalls[0][6] === undefined, `args ${voiceCalls[0].length}: ${JSON.stringify(voiceCalls[0][6])}`);
    assert(lastBot()?.text.startsWith(t.voice.confirmTitle), JSON.stringify(botCalls));
  });

  await check('voice: an anchor it can\'t find asks for a time and shows no card', async () => {
    extracted = [createIntent(anchored('the dentist', -60))];
    await handleVoiceMessage(555, 1001, voice, from);
    const question = await getBotMessage('en', 'nativeReminders.anchor.notFound', { description: 'the dentist' });
    assert(serviceCalls.some(c => c.text === question), JSON.stringify(serviceCalls));
    assert(botCalls.length === 0 && created.length === 0, JSON.stringify(botCalls));
  });

  await check('voice: auto-create waits for "keep as mine" when the partner can\'t be pinged', async () => {
    flags.autoCreate = true;
    partner = { ...raziel, telegramId: null };
    extracted = [createIntent(parsedReminder({ forPerson: 'partner' }), 'high')];
    await handleVoiceMessage(555, 1001, voice, from);
    assert(created.length === 0, `auto-created ${JSON.stringify(created)}`);
    assert(buttonsOf(lastBot())[0][0].text === t.nativeReminders.card.keepAsMine, JSON.stringify(botCalls));
  });

  await check('voice: a HIGH reminder auto-creates like an event', async () => {
    flags.autoCreate = true;
    extracted = [createIntent(parsedReminder(), 'high')];
    await handleVoiceMessage(555, 1001, voice, from);
    assert(created.length === 1 && created[0].input.kind === 'reminder' && created[0].calendarId === 'native:main-1', JSON.stringify(created));
  });

  await check('forwarded text: no partner in the prompt, and "remind my husband" stays the forwarder\'s', async () => {
    extracted = [createIntent(parsedReminder({ forPerson: 'partner' }))];
    await handleForwardedMessage(555, 1001, 'remind my husband to call the plumber tomorrow at 10', from);
    assert(JSON.stringify(textCalls[0][4]) === '{"userName":"Dana","userEnglishName":"Dana","partnerName":null,"partnerEnglishName":null}', JSON.stringify(textCalls[0][4]));
    assert(partnerLookups === 0, `${partnerLookups} partner lookups`);
    assert(lastBot()?.text.startsWith('⏰ <b>Call the plumber</b>\n📆 Thu, Oct 15, 10:00\n'), JSON.stringify(botCalls));
  });

  await check('replies: a partner\'s date-only reminder names the partner, in three languages', async () => {
    const event = await resolved(parsedReminder({ forPerson: 'partner', ...dateOnly('2026-10-16') }));
    const en = await reminderCreatedLine(event, 'en', IL);
    assert(en === '⏰ Reminder for Raziel set for Fri, Oct 16.', en);
    const ru = await reminderCreatedLine(event, 'ru', IL);
    assert(ru === '⏰ Raziel получит напоминание 16 октября.', ru);
    const he = await reminderCreatedLine(event, 'he', IL);
    assert(he.includes('בשביל Raziel') && !he.includes('ל-') && !he.includes('{'), he);
  });

  await check('anchor: "the day before" keeps the wall-clock time across a DST change', async () => {
    // Israel leaves summer time on Sun Oct 25 2026 at 02:00
    rangeEvents = [calendarEvent('Dentist', iso('2026-10-25 10:00'), iso('2026-10-25 11:00'))];
    const r = await resolveReminderForCreate(dana, anchored('the dentist', -1440), IL);
    assert(r.ok && sameInstant(r.startTime, at('2026-10-24 10:00')), JSON.stringify(r));
  });

  const questionText = await getBotMessage('en', 'nativeReminders.anchor.notFound', { description: 'the dentist' });
  await check('anchor: an offset of 0 returns the anchor instant exactly (ambiguous fall-back hour)', async () => {
    const start = new RealDate('2026-10-24T22:30:00Z');
    const r = reminderTimeFromAnchor(calendarEvent('Dentist', start.toISOString(), new RealDate('2026-10-24T23:30:00Z').toISOString()), 0, IL);
    assert(r.ok && r.startTime.getTime() === start.getTime(), JSON.stringify(r));
  });

  await check('voice: [edit, create] still routes the edit, as before', async () => {
    const edit: VoiceIntentResult = { intent: 'edit', confidence: 'high', eventReference: { type: 'last_created' } };
    extracted = [edit, createIntent(parsedReminder({ title: 'Buy milk' }))];
    await handleVoiceMessage(555, 1001, voice, from);
    assert(!botCalls.some(b => b.text.includes('Buy milk')) && created.length === 0, JSON.stringify(botCalls));
  });

  for (const order of ['failed first', 'valid first'] as const) {
    const list = () => {
      const bad = createIntent(anchored('the dentist', -60));
      const good = createIntent(parsedReminder({ title: 'Buy milk' }));
      return order === 'failed first' ? [bad, good] : [good, bad];
    };
    await check(`voice: ${order} - the valid reminder still gets its card and the failure is asked about`, async () => {
      extracted = list();
      await handleVoiceMessage(555, 1001, voice, from);
      assert(lastBot()?.text.includes('Buy milk'), JSON.stringify(botCalls));
      assert(serviceCalls.some(s => s.text === questionText), JSON.stringify(serviceCalls));
    });
    await check(`forwarded text: ${order} - the valid reminder still gets its card and the failure is asked about`, async () => {
      extracted = list();
      await handleForwardedMessage(555, 1001, 'buy milk, and an hour before the dentist', from);
      assert(lastBot()?.text.includes('Buy milk'), JSON.stringify(botCalls));
      assert(serviceCalls.some(s => s.text === questionText), JSON.stringify(serviceCalls));
    });
  }

  await check('voice: an anchor that lands 2 hours in the past notes "time passed" on its card and never auto-creates', async () => {
    flags.autoCreate = true;
    rangeEvents = [calendarEvent('Dentist', iso('2026-10-14 11:00'), iso('2026-10-14 12:00'))];
    extracted = [createIntent(anchored('the dentist', -150), 'high')]; // 08:30; it's 10:30
    await handleVoiceMessage(555, 1001, voice, from);
    const timePassed = await getBotMessage('en', 'nativeReminders.card.timePassed');
    assert(created.length === 0, `auto-created ${JSON.stringify(created)}`);
    assert(lastBot()?.text.includes(`📆 Wed, Oct 14, 08:30\n\n<i>${timePassed}</i>`), JSON.stringify(botCalls));
    const pending = await fakeRedis.get(`voice:pending:event:${pendingIdOf(lastBot(), 'event_create:')}`);
    assert(pending.event.reminderNotice === 'time_passed', `pending notice ${pending.event.reminderNotice}`);
  });

  await check('voice: a date-only reminder for today after 09:00 never auto-creates; its card says no time was set', async () => {
    flags.autoCreate = true;
    extracted = [createIntent(parsedReminder(dateOnly('2026-10-14')), 'high')];
    await handleVoiceMessage(555, 1001, voice, from);
    const noTime = await getBotMessage('en', 'nativeReminders.card.noTimeSet');
    assert(created.length === 0 && lastBot().text.includes(noTime), JSON.stringify({ created, botCalls }));
  });

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

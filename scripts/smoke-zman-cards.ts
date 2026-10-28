// Smoke test for the cards, replies and opinion buttons of a reminder by zman (zman reminders by voice plan, Tasks 7 and 8):
//   - Task 7: every card and reply line says the rule and its time through one helper (reminderZman: words, at, source):
//     the Telegram card, the WhatsApp card, the created reply, the spoken line, the bulk list; the words are the moved
//     zman-words.ts over calendarHome.zmanim.*; the recipient's own place decides the time ("partner" shows theirs,
//     "both" shows the creator's and says each is at their own place); a plain reminder's card and reply stay byte-identical;
//     what a refusal names (what the set offers; an offset out of range).
//   - Task 8: when the opinion is unsaid the card has one button per opinion, each with its time; a tap creates through
//     the normal path (Telegram and WhatsApp); "Confirm all" sends such an intent as its own card; a correction carries
//     or clears the rule and the choices (a day keeps it, a clock time drops it, a named opinion resolves the choices);
//     a zman reminder is never auto-created on Telegram or WhatsApp.
//
// The zman clock and the pause are the real ones (hebcal, the fixtures' coordinates). Telegram, WhatsApp, Redis, Prisma,
// the AI, the calendar provider and the lookups are faked; the clock is set by hand; a fetch throws.
// Process zone: this file re-runs itself once per server zone (UTC, Asia/Jerusalem, America/New_York) as child
// processes; nothing here may depend on the one the process has.
//   npx tsx scripts/smoke-zman-cards.ts

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTranslator } from 'next-intl';
import { instantToWallTime, wallTimeToInstant } from '../src/utils/wall-time';
import { zmanRuleWords, zmanName } from '../src/lib/calendar-view/zman-words';
import type { ZmanSpecValue } from '../src/lib/calendar-view/zman-spec';
import type { CalendarAssignment, UserConfig } from '../src/types';
import type { ParsedEvent, VoiceIntentResult } from '../src/services/event-parser';
import type { PartnerSummary } from '../src/services/native-reminders/ownership';

// No decrypt-only fallback key here (Prisma would load .env for an unset name).
process.env.ENCRYPTION_KEY_PREVIOUS = '';

const ROOT = path.resolve(__dirname, '..');
const ZONES = ['UTC', 'Asia/Jerusalem', 'America/New_York'] as const;
const CHILD = 'ZMAN_CARDS_SMOKE_CHILD';

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

// ---- Places, people, zones ----

const IL = 'Asia/Jerusalem';
const NY = 'America/New_York';
const HARISH = { location: 'Harish', latitude: 32.46182, longitude: 35.04555, elevationM: 270 };
const NEW_YORK = { location: 'New York', latitude: 40.7128, longitude: -74.006, elevationM: 10 };
const NOWHERE = { location: '', latitude: null, longitude: null, elevationM: null };

/** An instant from a wall time ('yyyy-MM-dd HH:mm') in a zone, through the one resolver. */
const at = (local: string, tz = IL): Date => wallTimeToInstant(local.replace(' ', 'T'), tz);
const hm = (d: Date | null | undefined, tz = IL) => (d ? instantToWallTime(d, tz).slice(11, 16) : 'none');
const dayOf = (d: Date, tz = IL) => instantToWallTime(d, tz).slice(0, 10);

const CALENDARS: CalendarAssignment[] = [{ calendarId: 'native:main-1', labels: ['primary', 'yours'], name: 'Dana', color: '#000000' }];
const dana = {
  id: 1, name: 'Dana', englishName: 'Dana', language: 'en', telegramId: 1001, calendarSource: 'NATIVE', pairingId: 'pair-1',
  isAdmin: false, voiceInputEnabled: true, googleRefreshToken: '', reminderTime: null, ...HARISH, zmanimCommunity: 'sephardi',
  pauseOnShabbat: true, calendarAssignments: CALENDARS,
} as unknown as UserConfig;
const raziel: PartnerSummary = {
  id: 2, name: 'Raziel', englishName: 'Raziel', gender: 'male', telegramId: BigInt(1002), language: 'he', reminderTime: null,
  ...NEW_YORK, zmanimCommunity: 'ashkenazi', pauseOnShabbat: true,
};
const asUser = (over: Record<string, unknown>) => ({ ...dana, ...over }) as unknown as UserConfig;
let partner: PartnerSummary | null = raziel;
let currentUser: UserConfig = dana;
/** Each person's zone, as resolveUserTimezone answers (the fake). */
let zones: Record<number, string> = {};

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

type Sent = { method: string; chatId?: number | string; text: string; opts?: Record<string, unknown>; n?: number };
let seq = 0;
let botCalls: Sent[] = [];
const fakeBot = {
  sendMessage: async (chatId: number, text: string, opts?: Record<string, unknown>) => {
    botCalls.push({ method: 'sendMessage', chatId, text, opts, n: ++seq });
    return { message_id: 700 + botCalls.length };
  },
  editMessageText: async (text: string, opts?: Record<string, unknown>) => {
    botCalls.push({ method: 'editMessageText', text, opts, n: ++seq });
    return true;
  },
  answerCallbackQuery: async (_id: string, opts?: Record<string, unknown>) => {
    botCalls.push({ method: 'answerCallbackQuery', text: String(opts?.text ?? ''), opts });
    return true;
  },
};
let serviceCalls: Sent[] = [];
const fakeService = {
  sendMessage: async (chatId: number | string, text: string, opts?: Record<string, unknown>) => {
    serviceCalls.push({ method: 'sendMessage', chatId, text, opts, n: ++seq });
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

const tracked: Array<{ userId: number; action: string; metadata?: Record<string, unknown> }> = [];
const flags = { autoCreate: false };

/** What the provider was asked to create. */
let created: Array<{ calendarId: string; input: Record<string, unknown> }> = [];
const fakeProvider = {
  fetchEventsInRange: async () => [],
  createEvent: async (_user: unknown, calendarId: string, input: Record<string, unknown>) => {
    created.push({ calendarId, input });
    return { success: true, eventId: `ev${created.length}` };
  },
  deleteEvent: async () => ({ success: true }),
  updateEvent: async () => ({ success: true }),
};

/** Gemini for reply-to-correct and the quick fix: answers `geminiText`, keeps each prompt. */
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

/** The voice extraction: answers the set intents, keeps the arguments. */
let extracted: VoiceIntentResult[] = [];
async function fakeVoiceExtraction() {
  return {
    intentResult: extracted[0], intentResults: extracted, transcription: 'remind me before the latest time for Shema',
    metrics: { model: 'fake', inputTokens: 0, outputTokens: 0, durationMs: 0 },
  };
}

function reset() {
  clock = at('2026-10-28 06:00').getTime(); // Wednesday morning in Harish, before the latest time for Shema
  store.clear();
  botCalls = [];
  serviceCalls = [];
  waCalls = [];
  tracked.length = 0;
  created = [];
  geminiPrompts = [];
  geminiText = '{}';
  extracted = [];
  flags.autoCreate = false;
  partner = raziel;
  currentUser = dana;
  zones = { 1: IL, 2: NY };
}

// ---- Module fakes ----

const SRC = path.resolve(ROOT, 'src');

const fakeOver = (real: Record<string, unknown>, fakes: Record<string, unknown>) =>
  new Proxy(real, { get: (target, key) => (typeof key === 'string' && key in fakes ? fakes[key] : Reflect.get(target, key)) });

const stubs: Record<string, object | ((real: Record<string, unknown>) => object)> = {
  '@googleapis/calendar': { calendar: () => ({}), auth: { OAuth2: class {} } },
  [`${SRC}/utils/redis.ts`]: { redis: fakeRedis },
  [`${SRC}/utils/prisma.ts`]: {
    prisma: {
      user: {
        // The recipient a refresh reads by id: the partner (with their place), or nobody
        findUnique: async ({ where }: { where: { id: number } }) => (partner && partner.id === where.id ? { ...partner } : null),
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
  [`${SRC}/services/user-service.ts`]: { getUserByTelegramId: async () => currentUser, getUserByWhatsAppId: async () => currentUser, getUserByWhatsAppPhone: async () => currentUser },
  [`${SRC}/services/messaging/factory.ts`]: (real) => fakeOver(real, { getWhatsAppService: () => fakeWhatsApp }),
  [`${SRC}/services/reminder-cache.ts`]: { getVoiceAutoCreateHighConf: async () => flags.autoCreate, getVoiceTtsOutcome: async () => false },
  [`${SRC}/services/voice/recent-events-store.ts`]: {
    pushRecentEvent: async () => {}, removeRecentEvent: async () => {}, getRecentEvents: async () => [], formatRecentEventsBlock: () => '',
  },
  [`${SRC}/services/voice/audio-retry.ts`]: {
    isInRetryMode: async () => false, readRetryAudio: async () => null, clearRetryMode: async () => {}, stashFailedAudio: async () => {},
  },
  [`${SRC}/services/native-reminders/support.ts`]: { getReminderSupport: async () => ({ supported: true }) },
  [`${SRC}/services/calendar-provider/index.ts`]: {
    providerForCalendar: () => fakeProvider,
    fetchEventsInRange: async () => ({ events: [], failed: [] }),
    createCalendarFor: async (_user: unknown, event: { calendarId?: string }) => event.calendarId ?? CALENDARS[0].calendarId,
    hasUsableCalendar: async () => true, getCalendarAssignmentsForUser: async () => CALENDARS,
  },
  [`${SRC}/services/native-calendar/event-store.ts`]: (real) => fakeOver(real, { getMainNativeCalendar: async (userId: number) => ({ id: `main-${userId}` }) }),
  [`${SRC}/services/native-reminders/ownership.ts`]: (real) => fakeOver(real, {
    getActivePartnerSummary: async (_userId: number, pairingId: string | null) => (pairingId ? partner : null),
  }),
  [`${SRC}/lib/user-moderation.ts`]: (real) => fakeOver(real, { isIdentifierBlocked: async () => false }),
  [`${SRC}/services/voice/gemini-voice.ts`]: (real) => fakeOver(real, { processVoiceWithGemini: fakeVoiceExtraction }),
  [`${SRC}/services/voice/event-resolution.ts`]: (real) => fakeOver(real, { downloadVoiceFile: async () => Buffer.from('OggS') }),
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
(globalThis as { zmanCardsFake?: (file: string) => object }).zmanCardsFake = (file) => fakeFor(file, () => realLoad.call(Module, file, null, false));
Module.registerHooks({
  load(url, context, nextLoad) {
    const file = url.startsWith('file:') ? fileURLToPath(url.split('?')[0]) : '';
    if (!(file in stubs) || loadingReal.has(file)) return nextLoad(url, context);
    const fake = (globalThis as unknown as { zmanCardsFake: (file: string) => object }).zmanCardsFake(file);
    const names = Object.keys(fake).map((name) => `export const ${name} = fake.${name};`).join('\n');
    return { format: 'module', shortCircuit: true, source: `const fake = globalThis.zmanCardsFake(${JSON.stringify(file)});\n${names}\n` };
  },
});
globalThis.fetch = (async () => { throw new Error('the smoke reached the network'); }) as typeof fetch;

// ---- Fixtures ----

/** A reminder as the parser hands it over (date-only for a zman), the model's words still on it. */
function zmanReminder(zman: Record<string, unknown>, over: Partial<ParsedEvent> = {}): ParsedEvent {
  const start = at(`${dayOf(new Date())} 00:00`);
  return {
    title: 'Say Shema', startTime: start, endTime: new Date(start.getTime()), allDay: true, confidence: 'high',
    kind: 'reminder', forPerson: 'self', calendarId: 'native:whatever', calendarName: 'Dana',
    zman: zman as ParsedEvent['zman'], ...over,
  };
}
const SHEMA = (offsetMinutes = -10, opinion: string | null = null) => ({ name: 'SOF_SHMA', opinion, offsetMinutes });
const SHKIA = (offsetMinutes = 0) => ({ name: 'SHKIA', opinion: null, offsetMinutes });
const plainReminder = (over: Partial<ParsedEvent> = {}): ParsedEvent => ({
  title: 'Call the plumber', startTime: at('2026-10-29 10:00'), endTime: at('2026-10-29 10:00'), allDay: false,
  calendarId: 'native:raziel-cal', calendarName: 'Raziel', confidence: 'high', kind: 'reminder', forPerson: 'self', ...over,
});
const intentOf = (event: ParsedEvent, confidence: 'high' | 'medium' | 'low' = 'medium'): VoiceIntentResult => ({ intent: 'create', confidence, event });

const lastBot = () => botCalls.filter((c) => c.method !== 'answerCallbackQuery').slice(-1)[0];
type Button = { text: string; callback_data: string };
const rowsOf = (call: Sent) => (call.opts?.reply_markup as { inline_keyboard: Button[][] }).inline_keyboard;
const buttonsOf = (call: Sent) => rowsOf(call).flat();
const waButtonsOf = (call: Sent) => (call.opts?.whatsappButtons as Array<{ id: string; title: string }> | undefined) ?? [];
const pendingIdOf = (call: Sent, prefix: string) => buttonsOf(call).find((b) => b.callback_data.startsWith(prefix))!.callback_data.slice(prefix.length);

/** The words of the Mini App, through next-intl directly: what the bot's words must equal. */
const MESSAGES: Record<string, Record<string, unknown>> = Object.fromEntries(
  ['en', 'he', 'ru'].map((l) => [l, JSON.parse(readFileSync(path.join(ROOT, `messages/${l}.json`), 'utf8'))]),
);
const homeT = (language: string) =>
  (createTranslator as unknown as (o: Record<string, unknown>) => unknown)({ locale: language, messages: MESSAGES[language], namespace: 'calendarHome' }) as Parameters<typeof zmanRuleWords>[0];
const GRA_10: ZmanSpecValue = { zman: 'SOF_SHMA_GRA', offsetMin: -10 };
const MGA_10: ZmanSpecValue = { zman: 'SOF_SHMA_MGA', offsetMin: -10 };

async function main() {
  const { getBotMessage } = await import('../src/lib/bot-messages');
  const resolve = await import('../src/services/native-reminders/resolve');
  const { resolveReminderIntents } = resolve;
  const confirmations = await import('../src/services/voice/confirmations');
  const { showEventConfirmation, formatReminderCard, formatReminderCreated, reminderCreatedLine } = confirmations;
  const { formatReminderOutcomeLine } = await import('../src/services/voice/tts-outcome');

  /** A reminder resolved as every handler resolves it. */
  async function resolved(event: ParsedEvent, who: UserConfig = dana, tz = IL): Promise<ParsedEvent> {
    const kept = { log: console.log, warn: console.warn };
    console.log = () => {}; console.warn = () => {};
    try {
      const { intents } = await resolveReminderIntents(who, [intentOf(event)], tz, { now: new Date() });
      assert(!!intents[0].event, `not resolved: ${show(intents[0])}`);
      return intents[0].event;
    } finally {
      Object.assign(console, kept);
    }
  }

  // ---- A plain reminder is byte-identical (pinned from the code before this change) ----

  await check('a plain reminder\'s card and reply are byte-identical, in en/he/ru, timed and date-only, for self, partner and both', async () => {
    const lines: string[] = [];
    const variants: Array<[string, ParsedEvent]> = [
      ['timed', plainReminder()],
      ['dateOnly', plainReminder({ allDay: true, startTime: at('2026-10-30 00:00'), endTime: at('2026-10-30 00:00') })],
      ['partner', plainReminder({ forUserId: 2, forName: 'Raziel', forPerson: 'partner' })],
      ['both', plainReminder({ forUserId: 2, forBoth: true, forName: 'Raziel', forPerson: 'both' })],
      ['daily', plainReminder({ recurrence: { frequency: 'daily' } })],
      ['passed', plainReminder({ reminderNotice: 'time_passed' })],
    ];
    for (const language of ['en', 'he', 'ru']) {
      for (const [name, event] of variants) {
        const user = asUser({ language });
        lines.push(`${language} ${name} card: ${await formatReminderCard(event, language, IL)}`);
        lines.push(`${language} ${name} wa: ${await formatReminderCard(event, language, IL, 'whatsapp', user)}`);
        lines.push(`${language} ${name} line: ${await reminderCreatedLine(event, language, IL, true, user)}`);
        lines.push(`${language} ${name} plain: ${await reminderCreatedLine(event, language, IL, false)}`);
        lines.push(`${language} ${name} created: ${await formatReminderCreated(event, language, IL, user)}`);
        lines.push(`${language} ${name} spoken: ${await formatReminderOutcomeLine(event, language, IL, user)}`);
      }
    }
    if (process.env.ZMAN_CARDS_WRITE_FIXTURE) console.log(`FIXTURE ${JSON.stringify(lines)}`);
    const expected = JSON.parse(readFileSync(path.join(ROOT, 'scripts/fixtures/plain-reminder-lines.json'), 'utf8')) as string[];
    assert(lines.length === expected.length, `${lines.length} lines, expected ${expected.length}`);
    for (let i = 0; i < lines.length; i++) assert(lines[i] === expected[i], `line ${i}\n  got:      ${lines[i]}\n  expected: ${expected[i]}`);
  });

  const { zmanClockFor } = await import('../src/services/zmanim/reminder-clock');
  const { anchorQuestion } = await import('../src/services/voice/confirmations');
  /** A person's time for a rule on a day, through the real clock (not through the card). */
  async function clockTime(person: object, zone: string, day: string, spec: ZmanSpecValue): Promise<Date> {
    const clock = await zmanClockFor(person as never, zone);
    const instant = clock?.instant(day, spec);
    assert(instant, `no clock time for ${show(spec)} on ${day}`);
    return instant;
  }
  /** A resolved single-rule reminder for Dana: SOF_SHMA by the GRA, 10 minutes before, on the day of the clock (a said opinion). */
  const graReminder = (over: Partial<ParsedEvent> = {}) => resolved(zmanReminder(SHEMA(-10, 'gra'), over));

  // ---- Task 7: one helper for the rule's words, time and place ----

  await check('copy: "each at your own place" is neutral in Hebrew (no masculine "of you both") and idiomatic in Russian; the partner\'s zone-only note names them first in Russian, undeclined', () => {
    const copy = (language: string) => JSON.parse(readFileSync(path.join(ROOT, 'messages', `${language}.json`), 'utf8')).bot.nativeReminders.zman as Record<string, string>;
    const he = copy('he');
    const ru = copy('ru');
    assert(he.eachOwnPlace === 'לפי המיקום של כל אחד ואחת', `he eachOwnPlace: ${he.eachOwnPlace}`);
    assert(ru.eachOwnPlace === 'у каждого — по своему местоположению', `ru eachOwnPlace: ${ru.eachOwnPlace}`);
    assert(ru.zoneOnlyPartner === '{name}: местоположение не указано, поэтому время рассчитано для главного города часового пояса.', `ru zoneOnlyPartner: ${ru.zoneOnlyPartner}`);
  });

  await check('the words moved to src/lib/calendar-view/zman-words.ts: nothing left under app/, no zmanim import, the screens import it from there', () => {
    const lib = readFileSync(path.join(ROOT, 'src/lib/calendar-view/zman-words.ts'), 'utf8');
    assert(!/services\/zmanim|@hebcal/.test(lib), 'zman-words.ts imports the zmanim module');
    let gone = false;
    try { readFileSync(path.join(ROOT, 'app/[locale]/dashboard/zman-words.ts'), 'utf8'); } catch { gone = true; }
    assert(gone, 'app/[locale]/dashboard/zman-words.ts is still there');
    for (const file of ['EditorSheet', 'ItemRow', 'ItemSheet', 'ZmanimSheet']) {
      const text = readFileSync(path.join(ROOT, `app/[locale]/dashboard/${file}.tsx`), 'utf8');
      assert(text.includes("@/src/lib/calendar-view/zman-words") && !text.includes("'./zman-words'"), `${file} imports the old path`);
    }
    // One words path in the services: only the view helper builds a rule's words
    const view = readFileSync(path.join(ROOT, 'src/services/native-reminders/zman-view.ts'), 'utf8');
    assert(view.includes('zmanRuleWords('), 'zman-view.ts does not word the rule');
    for (const file of ['src/services/voice/confirmations.ts', 'src/services/voice/bulk-confirmations.ts', 'src/services/voice/tts-outcome.ts', 'src/services/webhook-handlers.ts']) {
      assert(!readFileSync(path.join(ROOT, file), 'utf8').includes('zmanRuleWords('), `${file} words a rule on its own`);
    }
  });

  await check('card: the rule in words and its time at the person\'s place, in the Mini App\'s words, in en/he/ru (Telegram and WhatsApp)', async () => {
    const event = await graReminder();
    assert(event.zmanSpec && show(event.zmanSpec) === show(GRA_10), show(event));
    const time = await clockTime(dana, IL, '2026-10-28', GRA_10);
    assert(hm(time) === '08:27', `the plan's 08:27: ${hm(time)}`);
    const card = await formatReminderCard(event, 'en', IL, 'html', dana);
    assert(card === '⏰ <b>Say Shema</b>\n📆 Wed, Oct 28, 08:27 · 10 min before the latest time for Shema (GRA)', card);
    const wa = await formatReminderCard(event, 'en', IL, 'whatsapp', dana);
    assert(wa === '⏰ *Say Shema*\n📆 Wed, Oct 28, 08:27 · 10 min before the latest time for Shema (GRA)', wa);
    for (const language of ['en', 'he', 'ru']) {
      const rule = zmanRuleWords(homeT(language), GRA_10, 'gra');
      const text = await formatReminderCard(event, language, IL, 'html', asUser({ language }));
      assert(text.includes(`08:27 · ${rule}`), `${language}: ${text} lacks "${rule}"`);
    }
    // not a stored time: the date-only event holds the day's midnight and no zman time
    assert(event.allDay && hm(event.startTime) === '00:00', `${event.allDay} ${hm(event.startTime)}`);
  });

  await check('created reply: "I\'ll remind you today at 08:27: <rule>." with the rule\'s words, the spoken line too, in en/he/ru', async () => {
    const event = await graReminder();
    const en = await formatReminderCreated(event, 'en', IL, dana);
    assert(en === '⏰ I\'ll remind you today at 08:27: 10 min before the latest time for Shema (GRA).\n\n<b>Say Shema</b>', en);
    for (const language of ['en', 'he', 'ru']) {
      const user = asUser({ language });
      const rule = zmanRuleWords(homeT(language), GRA_10, 'gra');
      const when = await getBotMessage(language, 'nativeReminders.when.byZman', { when: await getBotMessage(language, 'nativeReminders.when.todayAt', { time: '08:27' }), rule });
      const line = await reminderCreatedLine(event, language, IL, true, user);
      assert(line === await getBotMessage(language, 'nativeReminders.created.self', { when }), `${language}: ${line}`);
      const spoken = await formatReminderOutcomeLine(event, language, IL, user);
      assert(spoken.includes('08:27') && spoken.includes(rule) && !/⏰/u.test(spoken) && spoken.endsWith(` ${event.title}.`), `${language} spoken: ${spoken}`);
      assert(!line.includes('nativeReminders.'), `${language}: ${line}`);
    }
  });

  await check('a daily repeat: the first occurrence\'s time and the rule, and the repeat line under it', async () => {
    const event = await resolved(zmanReminder(SHKIA(-30), { recurrence: { frequency: 'daily' } }));
    const sunset = await clockTime(dana, IL, '2026-10-28', { zman: 'SHKIA', offsetMin: -30 });
    const card = await formatReminderCard(event, 'en', IL, 'html', dana);
    assert(card.includes(`${hm(sunset)} · 30 min before sunset`) && card.split('\n').length === 3, card);
    const created = await formatReminderCreated(event, 'en', IL, dana);
    assert(created.includes(`today at ${hm(sunset)}: 30 min before sunset`), created);
  });

  await check('partner: the time is the partner\'s, at his place and in his zone; both: the creator\'s, and each at their own place', async () => {
    const forRaziel = await resolved(zmanReminder(SHKIA(-30), { forPerson: 'partner' }));
    assert(forRaziel.forUserId === 2, show(forRaziel));
    // Raziel's sunset on the day the reminder is on, at his place (New York), shown in New York's clock
    const day = dayOf(forRaziel.startTime);
    const theirs = await clockTime(raziel, NY, day, { zman: 'SHKIA', offsetMin: -30 });
    const mine = await clockTime(dana, IL, day, { zman: 'SHKIA', offsetMin: -30 });
    const card = await formatReminderCard(forRaziel, 'en', IL, 'html', dana);
    assert(card.includes(`${hm(theirs, NY)} · 30 min before sunset`) && card.includes('for Raziel') && !card.includes(`${hm(mine)} ·`), card);
    const line = await reminderCreatedLine(forRaziel, 'en', IL, true, dana);
    assert(line.includes(`${hm(theirs, NY)}`) && line.includes('Raziel'), line);
    const both = await resolved(zmanReminder(SHKIA(-30), { forPerson: 'both' }));
    const bothCard = await formatReminderCard(both, 'en', IL, 'html', dana);
    assert(bothCard.includes(`${hm(mine)} · 30 min before sunset`) && bothCard.includes('for both of you · each at your own place'), bothCard);
    const bothLine = await reminderCreatedLine(both, 'en', IL, true, dana);
    assert(bothLine.includes('both of you') && bothLine.includes(hm(mine)), bothLine);
    const plainBoth = await formatReminderCard(plainReminder({ forUserId: 2, forBoth: true, forName: 'Raziel' }), 'en', IL);
    assert(!plainBoth.includes('own place'), plainBoth);
  });

  await check('a place counted from the time zone\'s main city says so on the card; a saved place does not; a partner\'s names them', async () => {
    const zoneOnly = asUser({ ...NOWHERE });
    const event = await resolved(zmanReminder(SHKIA(-30)), zoneOnly);
    const note = await getBotMessage('en', 'nativeReminders.zman.zoneOnly');
    const card = await formatReminderCard(event, 'en', IL, 'html', zoneOnly);
    assert(card.includes(`<i>${note}</i>`), card);
    const saved = await formatReminderCard(await resolved(zmanReminder(SHKIA(-30))), 'en', IL, 'html', dana);
    assert(!saved.includes(note), saved);
    partner = { ...raziel, ...NOWHERE };
    const forRaziel = await resolved(zmanReminder(SHKIA(-30), { forPerson: 'partner' }));
    const theirs = await formatReminderCard(forRaziel, 'en', IL, 'html', dana);
    const partnerNote = await getBotMessage('en', 'nativeReminders.zman.zoneOnlyPartner', { name: 'Raziel' });
    assert(theirs.includes(partnerNote) && !theirs.includes(note), theirs);
    // a partner's name is escaped for Telegram's markup in the note too, and not for WhatsApp's
    partner = { ...raziel, ...NOWHERE, name: 'Ra<z>' };
    const escapedName = await resolved(zmanReminder(SHKIA(-30), { forPerson: 'partner' }));
    const html = await formatReminderCard(escapedName, 'en', IL, 'html', dana);
    assert(html.includes('Ra&lt;z&gt;') && !html.includes('Ra<z>'), html);
  });

  await check('a one-off inside Shabbat: the card says it will not be sent (the pause\'s own answer), in en/he/ru; the pause off says nothing', async () => {
    const friday = await resolved(zmanReminder(SHKIA(0), { startTime: at('2026-10-30 00:00'), endTime: at('2026-10-30 00:00'), zmanDaySaid: true }));
    assert(friday.reminderPaused === true, `the resolver did not note it: ${show(friday)}`);
    for (const language of ['en', 'he', 'ru']) {
      const note = await getBotMessage(language, 'nativeReminders.zman.paused');
      const card = await formatReminderCard(friday, language, IL, 'html', asUser({ language }));
      assert(card.includes(`<i>${note}</i>`) && !note.includes('nativeReminders.'), `${language}: ${card}`);
    }
    const unpaused = { ...friday, reminderPaused: undefined };
    assert(!(await formatReminderCard(unpaused, 'en', IL, 'html', dana)).includes(await getBotMessage('en', 'nativeReminders.zman.paused')), 'noted though not paused');
    const created = await formatReminderCreated(friday, 'en', IL, dana);
    assert(created.includes(await getBotMessage('en', 'nativeReminders.zman.paused')), created);
  });

  await check('"remind us both" with the pause on for only one of the two: the card, the reply and the bulk line say it for one of them (en/he/ru); with it on for both, the plain note; a choice card says it too', async () => {
    const fridayBoth = (over: Partial<ParsedEvent> = {}) => zmanReminder(SHKIA(0), { startTime: at('2026-10-30 00:00'), endTime: at('2026-10-30 00:00'), zmanDaySaid: true, forPerson: 'both', ...over });
    partner = { ...raziel, pauseOnShabbat: false };
    const one = await resolved(fridayBoth());
    assert(one.reminderPaused === 'one', `the resolver did not note it for one: ${show(one.reminderPaused)}`);
    for (const language of ['en', 'he', 'ru']) {
      const noteOne = await getBotMessage(language, 'nativeReminders.zman.pausedOne');
      const noteAll = await getBotMessage(language, 'nativeReminders.zman.paused');
      assert(noteOne !== noteAll && !noteOne.includes('nativeReminders.'), `${language}: ${noteOne}`);
      const card = await formatReminderCard(one, language, IL, 'html', asUser({ language }));
      assert(card.includes(`<i>${noteOne}</i>`) && !card.includes(`<i>${noteAll}</i>`), `${language}: ${card}`);
      const created = await formatReminderCreated(one, language, IL, asUser({ language }));
      assert(created.includes(noteOne) && !created.includes(noteAll), `${language}: ${created}`);
    }
    const { showBulkConfirmation } = await import('../src/services/voice/bulk-confirmations');
    await showBulkConfirmation(555, [intentOf(one), intentOf(plainReminder())], dana, 'two', {}, fakeService as never, IL);
    assert(serviceCalls[0].text.includes(await getBotMessage('en', 'nativeReminders.zman.pausedOneShort')) && !serviceCalls[0].text.includes(await getBotMessage('en', 'nativeReminders.zman.pausedShort')), serviceCalls[0].text);
    partner = raziel;
    const both = await resolved(fridayBoth());
    assert(both.reminderPaused === true, show(both.reminderPaused));
    const bothCard = await formatReminderCard(both, 'en', IL, 'html', dana);
    assert(bothCard.includes(`<i>${await getBotMessage('en', 'nativeReminders.zman.paused')}</i>`) && !bothCard.includes(await getBotMessage('en', 'nativeReminders.zman.pausedOne')), bothCard);
    partner = { ...raziel, pauseOnShabbat: false };
    const choices = await resolved(zmanReminder(SHEMA(-10), { startTime: at('2026-10-31 00:00'), endTime: at('2026-10-31 00:00'), zmanDaySaid: true, forPerson: 'both' }));
    const choiceCard = await formatReminderCard(choices, 'en', IL, 'html', dana);
    assert(choices.zmanChoices?.every((c) => c.paused === 'one') && choiceCard.includes(`<i>${await getBotMessage('en', 'nativeReminders.zman.pausedOne')}</i>`), choiceCard);
  });

  await check('bulk list: a reminder by zman shows its time and rule, a paused one says so, the zone note once; a plain reminder\'s line is as before', async () => {
    const { showBulkConfirmation } = await import('../src/services/voice/bulk-confirmations');
    const spec = await graReminder();
    const plain = plainReminder();
    await showBulkConfirmation(555, [intentOf(spec), intentOf(plain)], dana, 'two reminders', {}, fakeService as never, IL);
    const bulk = serviceCalls[0].text;
    assert(bulk.includes('1. ⏰ <b>Say Shema</b> — Wed, Oct 28, 08:27 · 10 min before the latest time for Shema (GRA)'), bulk);
    assert(bulk.includes('2. ⏰ <b>Call the plumber</b> — Thu, Oct 29, 10:00'), bulk);
    serviceCalls = [];
    const zoneUser = asUser({ ...NOWHERE });
    const a = await resolved(zmanReminder(SHKIA(-30)), zoneUser);
    const b = await resolved(zmanReminder(SHKIA(-20)), zoneUser);
    await showBulkConfirmation(555, [intentOf(a), intentOf(b)], zoneUser, 'two', {}, fakeService as never, IL);
    const note = await getBotMessage('en', 'nativeReminders.zman.zoneOnly');
    assert(serviceCalls[0].text.split(note).length === 2, `the zone note should appear once: ${serviceCalls[0].text}`);
    serviceCalls = [];
    const friday = await resolved(zmanReminder(SHKIA(0), { startTime: at('2026-10-30 00:00'), endTime: at('2026-10-30 00:00'), zmanDaySaid: true }));
    await showBulkConfirmation(555, [intentOf(friday), intentOf(plain)], dana, 'two', {}, fakeService as never, IL);
    assert(serviceCalls[0].text.includes(await getBotMessage('en', 'nativeReminders.zman.pausedShort')), serviceCalls[0].text);
  });

  await check('a refusal names what the set offers (an opinion it lacks), an offset out of range is its own line, a name it does not know stays general; all in en/he/ru', async () => {
    const chabad = asUser({ zmanimCommunity: 'chabad' });
    const run = async (zman: Record<string, unknown>, who: UserConfig = dana) => {
      const kept = { log: console.log, warn: console.warn };
      console.log = () => {}; console.warn = () => {};
      try {
        const { failures } = await resolveReminderIntents(who, [intentOf(zmanReminder(zman))], IL, { now: new Date() });
        assert(failures[0], 'not refused');
        return failures[0];
      } finally {
        Object.assign(console, kept);
      }
    };
    const notOffered = await run(SHEMA(-10, 'mga'), chabad);
    const badOffset = await run(SHKIA(-800));
    const unknown = await run({ name: 'RABBEINU_TAM', opinion: null, offsetMinutes: 0 });
    for (const language of ['en', 'he', 'ru']) {
      const t = homeT(language);
      const questions = [await anchorQuestion(notOffered, language, false), await anchorQuestion(badOffset, language, false), await anchorQuestion(unknown, language, false)];
      assert(new Set(questions).size === 3, `${language}: the three refusals differ: ${show(questions)}`);
      assert(questions.every((q) => !q.includes('nativeReminders.') && q.includes('Say Shema')), `${language}: ${show(questions)}`);
      // The opinion's own name (the Baal HaTanya's, as the Chabad set names it) and the zman's name
      assert(questions[0].includes(t('zmanim.opinions.baalHatanya')) && questions[0].includes(zmanName(t, 'SOF_SHMA_GRA', null)), `${language}: ${questions[0]}`);
      assert(!questions[2].includes(t('zmanim.opinions.baalHatanya')), `${language}: ${questions[2]}`);
    }
    const plag = await run({ name: 'PLAG', opinion: 'gra', offsetMinutes: 0 });
    const plagEn = await anchorQuestion(plag, 'en', false);
    assert(plagEn.includes('Halacha Berura') && plagEn.includes('Yalkut Yosef') && plagEn.includes(' or '), plagEn);
    const plagHe = await anchorQuestion(plag, 'he', false);
    assert(plagHe.includes('הלכה ברורה') && plagHe.includes('ילקוט יוסף'), plagHe);
    // HTML escaping holds for the new lines
    const escaped = await anchorQuestion({ ...notOffered, description: 'a <b>' }, 'en');
    assert(escaped.includes('a &lt;b&gt;'), escaped);
  });

  await check('a time just after midnight reads 00:xx on the card and in the reply, not 24:xx (halachic midnight plus an hour)', async () => {
    const event = await resolved(zmanReminder({ name: 'CHATZOT_HALAYLA', opinion: null, offsetMinutes: 60 }));
    const due = await clockTime(dana, IL, dayOf(event.startTime), { zman: 'CHATZOT_HALAYLA', offsetMin: 60 });
    assert(hm(due).startsWith('00:'), `the fixture's time ${hm(due)}`);
    const card = await formatReminderCard(event, 'en', IL, 'html', dana);
    assert(card.includes(`, ${hm(due)} · `) && !card.includes(', 24:'), `${hm(due)}: ${card}`);
    const line = await reminderCreatedLine(event, 'en', IL, true, dana);
    assert(line.includes(` at ${hm(due)}: `), `${hm(due)}: ${line}`);
  });

  await check('WhatsApp\'s three reply buttons and 20 characters hold: no name has more than 2 keys in any set, no opinion\'s name is longer than 20 characters in any language', async () => {
    const { reminderZmanim, zmanNameOfKey } = await import('../src/services/zmanim/spec');
    for (const community of ['sephardi', 'ashkenazi', 'chabad'] as const) {
      const counts = new Map<string, number>();
      for (const key of reminderZmanim(community)) counts.set(zmanNameOfKey(key), (counts.get(zmanNameOfKey(key)) ?? 0) + 1);
      for (const [name, n] of counts) assert(n <= 2, `${community}: ${name} has ${n} keys`);
    }
    for (const language of ['en', 'he', 'ru']) {
      const opinions = (MESSAGES[language].calendarHome as { zmanim: { opinions: Record<string, string> } }).zmanim.opinions;
      for (const [key, name] of Object.entries(opinions)) assert([...name].length <= 20, `${language}.${key}: "${name}" is ${[...name].length} characters`);
    }
  });

  // ---- Task 8: the opinion buttons, the taps, bulk, corrections, no auto-create ----

  const { handleTelegramWebhook, handleWhatsAppWebhook } = await import('../src/services/webhook-handlers');
  const { handleVoiceMessage } = await import('../src/services/voice/handler');
  const { handleEventCorrection } = await import('../src/services/voice/correction-handler');
  const { setQuickCorrection, extractFieldPatch, applyFieldPatch } = await import('../src/services/voice/quick-correction');
  const { showBulkConfirmation, handleBulkConfirmAll } = await import('../src/services/voice/bulk-confirmations');
  const { autoCreateEvent } = await import('../src/services/voice/auto-create');
  const { getPendingEvent } = confirmations;
  const voice = { file_id: 'f1', file_unique_id: 'u1', duration: 4 };
  const from = { id: 1001, first_name: 'Dana' };
  const noop = () => {};
  const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
    const kept = { log: console.log, warn: console.warn };
    console.log = noop; console.warn = noop;
    try { return await fn(); } finally { Object.assign(console, kept); }
  };
  /** A tap on a Telegram inline button, through the webhook. */
  const tap = (data: string, chatId = 555, messageId = 701) => quiet(() => handleTelegramWebhook(
    { body: { update_id: 1, callback_query: { id: 'q1', from, message: { chat: { id: chatId }, message_id: messageId }, data } } } as never,
    { status: () => ({ json: noop }) } as never,
  ));
  /** A tap on a WhatsApp reply button, through the webhook. */
  const waTap = (id: string) => quiet(() => handleWhatsAppWebhook(
    { body: { entry: [{ changes: [{ value: { messages: [{ from: '972500000008', id: 'wamid.tap', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id, title: 'x' } } }] } }] }] } } as never,
    { status: () => ({ json: noop }) } as never,
  ));
  const whatsappVoice = () => quiet(() => handleWhatsAppWebhook(
    { body: { entry: [{ changes: [{ value: { messages: [{ from: '972500000008', id: 'wamid.in', type: 'audio', audio: { id: 'media-1' } }] } }] }] } } as never,
    { status: () => ({ json: noop }) } as never,
  ));
  /** The reminder the person said without an opinion: two choices (MGA then GRA) for Dana, a Sephardi in Harish. */
  const choosing = (over: Partial<ParsedEvent> = {}) => resolved(zmanReminder(SHEMA(-10), over));
  const lastWa = () => waCalls[waCalls.length - 1];
  /** How many reminders the provider was asked to create (a function, so a check after `=== 0` is not narrowed). */
  const made = () => created.length;

  await check('choices card (Telegram): the rule without an opinion, "Which opinion?", one button per opinion with its time, Cancel and the quick row; no Create', async () => {
    const event = await choosing();
    assert(event.zmanChoices?.length === 2 && !event.zmanSpec, show(event));
    const mga = hm(await clockTime(dana, IL, '2026-10-28', MGA_10));
    const gra = hm(await clockTime(dana, IL, '2026-10-28', GRA_10));
    assert(mga === '07:53' && gra === '08:27', `${mga} ${gra}`);
    await showEventConfirmation(555, undefined, event, 'remind me 10 minutes before sof zman Shema', dana);
    const card = lastBot();
    assert(card.text.startsWith('⏰ <b>Say Shema</b>\n📆 Wed, Oct 28 · 10 min before the latest time for Shema\n\nWhich opinion?'), card.text);
    assert(!card.text.includes('(GRA)') && !card.text.includes('(MGA)'), card.text);
    const id = pendingIdOf({ ...card, opts: { reply_markup: { inline_keyboard: [[{ text: '', callback_data: buttonsOf(card).find((b) => b.callback_data.startsWith('event_cancel:'))!.callback_data }]] } } }, 'event_cancel:');
    const rows = rowsOf(card);
    assert(show(rows[0]) === show([{ text: 'MGA · 07:53', callback_data: `event_pick:0:${id}` }]), show(rows[0]));
    assert(show(rows[1]) === show([{ text: 'GRA · 08:27', callback_data: `event_pick:1:${id}` }]), show(rows[1]));
    assert(rows[2].length === 1 && rows[2][0].callback_data === `event_cancel:${id}`, show(rows[2]));
    assert(rows[3].map((b) => b.callback_data.split(':')[1]).join() === 'time,day' && rows.length === 4, show(rows));
    assert(!buttonsOf(card).some((b) => b.callback_data.startsWith('event_create:')), 'a Create button on an unchosen reminder');
    // The same card in Hebrew and Russian: the Mini App's opinion names
    for (const language of ['he', 'ru']) {
      const user = asUser({ language });
      botCalls = [];
      await showEventConfirmation(555, undefined, event, 'x', user);
      const t = homeT(language);
      assert(show(buttonsOf(lastBot()).slice(0, 2).map((b) => b.text)) === show([`${t('zmanim.opinions.mga')} · 07:53`, `${t('zmanim.opinions.gra')} · 08:27`]), `${language}: ${show(buttonsOf(lastBot()).map((b) => b.text))}`);
      assert(lastBot().text.includes(await getBotMessage(language, 'nativeReminders.zman.whichOpinion')), lastBot().text);
    }
  });

  await check('callback data stays within Telegram\'s 64 bytes for a group chat id, and a choice on another day says so on its button', async () => {
    const event = await choosing();
    await showEventConfirmation(-1001234567890123, undefined, event, 'x', dana);
    for (const b of buttonsOf(lastBot())) assert(Buffer.byteLength(b.callback_data) <= 64, `${b.callback_data.length} bytes: ${b.callback_data}`);
    // 08:00: MGA's time has passed (tomorrow's), GRA's is still ahead (today's)
    clock = at('2026-10-28 08:00').getTime();
    botCalls = [];
    await showEventConfirmation(555, undefined, await choosing(), 'x', dana);
    assert(lastBot().text.includes('📆 Wed, Oct 28 ·'), lastBot().text);
    const mgaTomorrow = hm(await clockTime(dana, IL, '2026-10-29', MGA_10));
    assert(show(buttonsOf(lastBot()).slice(0, 2).map((b) => b.text)) === show([`MGA · tomorrow ${mgaTomorrow}`, 'GRA · 08:27']), show(buttonsOf(lastBot()).map((b) => b.text)));
  });

  await check('a tap on GRA (through the webhook) creates SOF_SHMA_GRA, -10, date-only, through the normal path; the reply names the opinion; a second tap is expired', async () => {
    await showEventConfirmation(555, undefined, await choosing(), 'remind me', dana);
    const id = lastBot().text && buttonsOf(lastBot()).find((b) => b.callback_data.startsWith('event_pick:1:'))!.callback_data.slice('event_pick:1:'.length);
    await tap(`event_pick:1:${id}`);
    assert(made() === 1, `created ${show(created)}`);
    const input = created[0].input;
    assert(input.kind === 'reminder' && show(input.zmanSpec) === show(GRA_10) && input.allDay === true && input.forBoth === false, show(input));
    assert((input.startTime as Date).getTime() === at('2026-10-28 00:00').getTime() && (input.endTime as Date).getTime() === (input.startTime as Date).getTime(), show(input));
    assert(created[0].calendarId === 'native:main-1', created[0].calendarId);
    assert(lastBot().method === 'editMessageText' && lastBot().text === '⏰ I\'ll remind you today at 08:27: 10 min before the latest time for Shema (GRA).\n\n<b>Say Shema</b>', lastBot().text);
    assert(tracked.some((e) => e.action === 'native_reminder_created' && e.metadata?.by_zman === true), show(tracked));
    assert(!(await getPendingEvent(id)), 'the pending event is still there');
    botCalls = [];
    await tap(`event_pick:1:${id}`);
    assert(made() === 1 && botCalls.some((c) => c.text.includes('expired') || c.text.includes('⏰')), `created ${made()}; ${show(botCalls)}`);
  });

  await check('a tap on MGA when its time has passed today creates it for tomorrow (its own day), and says so', async () => {
    clock = at('2026-10-28 08:00').getTime();
    await showEventConfirmation(555, undefined, await choosing(), 'x', dana);
    const id = buttonsOf(lastBot()).find((b) => b.callback_data.startsWith('event_pick:0:'))!.callback_data.slice('event_pick:0:'.length);
    await tap(`event_pick:0:${id}`);
    assert(made() === 1 && show(created[0].input.zmanSpec) === show(MGA_10), show(created));
    assert((created[0].input.startTime as Date).getTime() === at('2026-10-29 00:00').getTime(), show(created[0].input.startTime));
    const mgaTomorrow = hm(await clockTime(dana, IL, '2026-10-29', MGA_10));
    assert(lastBot().text.startsWith(`⏰ I'll remind you tomorrow at ${mgaTomorrow}: 10 min before the latest time for Shema (MGA).`), lastBot().text);
  });

  await check('a partner not on Telegram, with opinions to choose: the card does not ask "Keep it as yours?" (no such button), it says an opinion keeps it as yours, in en/he/ru; the tap creates it as the creator\'s; a single rule still asks', async () => {
    partner = { ...raziel, telegramId: null };
    const event = await choosing({ forPerson: 'partner' });
    assert(event.reminderNotice === 'partner_not_on_telegram' && event.forUserId === null && event.zmanChoices?.length === 2, show(event));
    for (const language of ['en', 'he', 'ru']) {
      const user = asUser({ language });
      const params = { name: 'Raziel' };
      const asks = await getBotMessage(language, 'nativeReminders.card.partnerNotOnTelegram', params);
      const picks = await getBotMessage(language, 'nativeReminders.card.partnerNotOnTelegramPick', params);
      assert(asks !== picks && !picks.includes('nativeReminders.') && picks.includes('Raziel'), `${language}: ${picks}`);
      const card = await formatReminderCard(event, language, IL, 'html', user);
      assert(card.includes(`<i>${picks}</i>`) && !card.includes(asks), `${language}: ${card}`);
      const wa = await formatReminderCard(event, language, IL, 'whatsapp', user);
      assert(wa.includes(`_${picks}_`) && !wa.includes(asks), `${language} WhatsApp: ${wa}`);
    }
    await showEventConfirmation(555, undefined, event, 'x', dana);
    assert(!buttonsOf(lastBot()).some((b) => b.callback_data.startsWith('event_create:')), 'a Create button on an unchosen reminder');
    const pick = buttonsOf(lastBot()).find((b) => b.callback_data.startsWith('event_pick:1:'))!.callback_data;
    await tap(pick);
    assert(made() === 1 && created[0].input.forUserId === null && created[0].input.forBoth === false && show(created[0].input.zmanSpec) === show(GRA_10), show(created));
    // A rule with no choices still asks, with its Keep button
    botCalls = [];
    const single = await resolved(zmanReminder(SHKIA(-30), { forPerson: 'partner' }));
    await showEventConfirmation(555, undefined, single, 'x', dana);
    const asks = await getBotMessage('en', 'nativeReminders.card.partnerNotOnTelegram', { name: 'Raziel' });
    assert(lastBot().text.includes(asks) && buttonsOf(lastBot()).some((b) => b.callback_data.startsWith('event_create:')), lastBot().text);
  });

  await check('a repeating reminder gets the same buttons, and a tap creates the series with the rule', async () => {
    const event = await choosing({ recurrence: { frequency: 'daily' } });
    await showEventConfirmation(555, undefined, event, 'every day', dana);
    assert(lastBot().text.includes('🔄 Daily') && lastBot().text.includes('Which opinion?'), lastBot().text);
    const pick = buttonsOf(lastBot()).find((b) => b.callback_data.startsWith('event_pick:1:'))!.callback_data;
    await tap(pick);
    assert(made() === 1 && show(created[0].input.zmanSpec) === show(GRA_10) && show(created[0].input).includes('DAILY'), show(created));
    assert(lastBot().text.includes('🔄 Daily') && lastBot().text.includes('(GRA)'), lastBot().text);
  });

  await check('a button the reminder has no choice for creates nothing and is answered; a malformed one is answered too', async () => {
    await showEventConfirmation(555, undefined, await choosing(), 'x', dana);
    const id = buttonsOf(lastBot()).find((b) => b.callback_data.startsWith('event_pick:0:'))!.callback_data.slice('event_pick:0:'.length);
    botCalls = [];
    await tap(`event_pick:7:${id}`);
    await tap('event_pick:nonsense');
    assert(made() === 0, show(created));
    assert(botCalls.filter((c) => c.method === 'answerCallbackQuery').length === 2, show(botCalls));
    assert(!!(await getPendingEvent(id)), 'the card should still be there to tap again');
  });

  await check('"Confirm all" never carries a choice: an intent with choices is its own card right after the list; the list creates the rest', async () => {
    const a = await graReminder();
    const b = await resolved(zmanReminder(SHKIA(-30)));
    const pick = await choosing();
    await showBulkConfirmation(555, [intentOf(a), intentOf(pick), intentOf(b)], dana, 'three', {}, fakeService as never, IL);
    const list = serviceCalls[0];
    const card = lastBot();
    assert(list.text.includes('1. ') && list.text.includes('2. ') && !list.text.includes('3. ') && !list.text.includes('Which opinion?'), list.text);
    assert(card.text.includes('Which opinion?') && buttonsOf(card).some((x) => x.callback_data.startsWith('event_pick:')), card.text);
    assert((list as Sent & { n: number }).n < (card as Sent & { n: number }).n, 'the choice card came before the list');
    const batchButtons = (list.opts?.replyMarkup as { inline_keyboard: Button[][] }).inline_keyboard.flat();
    const batchId = batchButtons.find((x) => x.callback_data.startsWith('bulk_confirm:'))!.callback_data.slice('bulk_confirm:'.length);
    const done = await handleBulkConfirmAll(batchId);
    assert(done.successCount === 2 && done.failureCount === 0, show(done));
    assert(made() === 2 && created.every((c) => !!c.input.zmanSpec), show(created));
    // Only one thing besides the choice left: it is not a list of one
    botCalls = []; serviceCalls = []; created = [];
    await showBulkConfirmation(555, [intentOf(a), intentOf(pick)], dana, 'two', {}, fakeService as never, IL);
    assert(serviceCalls.length === 0 && botCalls.length === 2, `${serviceCalls.length} list messages; ${botCalls.length} cards`);
    assert(buttonsOf(botCalls[0]).some((x) => x.callback_data.startsWith('event_create:')) && buttonsOf(botCalls[1]).some((x) => x.callback_data.startsWith('event_pick:')), show(botCalls.map((c) => c.text)));
  });

  await check('the voice handler: a bulk of three with a choice, through the real handler, lists two and cards the choice', async () => {
    extracted = [intentOf(zmanReminder(SHKIA(-30))), intentOf(zmanReminder(SHEMA(-10))), intentOf(plainReminder())];
    await quiet(() => handleVoiceMessage(555, 1001, voice, from));
    assert(serviceCalls[0]?.text.includes('1. ') && serviceCalls[0].text.includes('2. ') && !serviceCalls[0].text.includes('3. '), show(serviceCalls.map((c) => c.text)));
    assert(botCalls.some((c) => c.text.includes('Which opinion?')), show(botCalls.map((c) => c.text)));
  });

  await check('no zman reminder is auto-created on Telegram (a rule or choices, HIGH confidence, the flag on), while a plain one still is', async () => {
    flags.autoCreate = true;
    extracted = [intentOf(zmanReminder(SHEMA(-10, 'gra')), 'high')];
    await quiet(() => handleVoiceMessage(555, 1001, voice, from));
    assert(made() === 0, `auto-created ${show(created)}`);
    assert(buttonsOf(lastBot()).some((b) => b.callback_data.startsWith('event_create:')) && lastBot().text.includes('08:27'), show(lastBot()));
    botCalls = [];
    extracted = [intentOf(zmanReminder(SHEMA(-10)), 'high')];
    await quiet(() => handleVoiceMessage(555, 1001, voice, from));
    assert(made() === 0 && buttonsOf(lastBot()).some((b) => b.callback_data.startsWith('event_pick:')), show(lastBot()));
    // the same through the function itself
    const spec = await graReminder();
    assert((await quiet(() => autoCreateEvent(dana, spec, {}, fakeService as never, 555))) === false && made() === 0, 'autoCreateEvent created a reminder by zman');
    extracted = [intentOf(plainReminder(), 'high')];
    await quiet(() => handleVoiceMessage(555, 1001, voice, from));
    assert(made() === 1 && created[0].input.kind === 'reminder', `a plain reminder should still auto-create: ${show(created)}`);
  });

  await check('WhatsApp voice: a reminder by zman is never auto-created; a rule gets Create and Cancel on its card, with its time', async () => {
    extracted = [intentOf(zmanReminder(SHEMA(-10, 'gra')), 'high')];
    await whatsappVoice();
    assert(made() === 0, `auto-created ${show(created)}`);
    const sent = lastWa();
    assert(sent.text.includes('08:27 · 10 min before the latest time for Shema (GRA)'), sent.text);
    assert(show(waButtonsOf(sent).map((b) => b.id.split(':')[0])) === show(['event_create', 'event_cancel']), show(waButtonsOf(sent)));
    const pendingId = waButtonsOf(sent)[0].id.slice('event_create:'.length);
    await waTap(`event_create:${pendingId}`);
    assert(made() === 1 && show(created[0].input.zmanSpec) === show(GRA_10), show(created));
    assert(lastWa().text.startsWith('⏰ I\'ll remind you today at 08:27: 10 min before the latest time for Shema (GRA).'), lastWa().text);
  });

  await check('WhatsApp voice: with the opinion unsaid, one reply button per opinion (the name alone) and Cancel; each time is a line of the body; a tap creates it', async () => {
    extracted = [intentOf(zmanReminder(SHEMA(-10)), 'high')];
    await whatsappVoice();
    assert(made() === 0, `auto-created ${show(created)}`);
    const sent = lastWa();
    const buttons = waButtonsOf(sent);
    assert(show(buttons.slice(0, 2).map((b) => b.title)) === show(['MGA', 'GRA']), show(buttons));
    assert(buttons.length === 3 && buttons.every((b) => [...b.title].length <= 20 && Buffer.byteLength(b.id) <= 256), show(buttons));
    assert(show(buttons.map((b) => b.id.split(':')[0])) === show(['event_pick', 'event_pick', 'event_cancel']), show(buttons));
    assert(sent.text.includes('Which opinion?\n• MGA · 07:53\n• GRA · 08:27') && !sent.text.includes('(GRA)'), sent.text);
    await waTap(buttons[1].id);
    assert(made() === 1 && show(created[0].input.zmanSpec) === show(GRA_10), show(created));
    assert(lastWa().text.includes('(GRA)') && lastWa().text.includes('08:27'), lastWa().text);
    // a second tap: the confirmation has expired, nothing more is created
    await waTap(buttons[1].id);
    assert(made() === 1, show(created));
    // Cancel drops the pending reminder
    waCalls = [];
    extracted = [intentOf(zmanReminder(SHEMA(-10)), 'high')];
    await whatsappVoice();
    await waTap(waButtonsOf(lastWa())[2].id);
    assert(made() === 1 && lastWa().text.includes('cancelled'), show(waCalls.map((c) => c.text)));
  });

  await check('WhatsApp voice: a batch of two HIGH reminders with a zman in it is the Telegram hint, never auto-created', async () => {
    extracted = [intentOf(zmanReminder(SHKIA(-30)), 'high'), intentOf(plainReminder(), 'high')];
    await whatsappVoice();
    assert(made() === 0, `auto-created ${show(created)}`);
    assert(lastWa().text === (await import('../src/lib/bot-messages').then((m) => m.getBotMessages('en'))).whatsapp.bulkUseTelegram, lastWa().text);
  });

  /** The model's answer to a correction, for a reminder on `day`. */
  const answer = (over: Record<string, unknown>) => JSON.stringify({ title: 'Say Shema', startDate: '2026-10-28', startTime: null, endDate: '2026-10-28', endTime: null, allDay: true, calendarId: 'native:whatever', calendarName: 'Dana', ...over });
  const pendingOf = async (call: Sent) => {
    const id = buttonsOf(call).find((b) => b.callback_data.startsWith('event_cancel:'))!.callback_data.slice('event_cancel:'.length);
    return { id, pending: (await getPendingEvent(id))! };
  };

  await check('correction: a day keeps the rule and says the day was said; the card shows the new day\'s time; Create makes it for that day', async () => {
    await showEventConfirmation(555, undefined, await graReminder(), 'x', dana);
    const { id } = await pendingOf(lastBot());
    geminiText = answer({ startDate: '2026-10-29', endDate: '2026-10-29' });
    await handleEventCorrection(555, 1001, id, 701, { text: 'tomorrow' });
    const card = lastBot();
    const time = hm(await clockTime(dana, IL, '2026-10-29', GRA_10));
    assert(card.text.includes(`📆 Thu, Oct 29, ${time} · 10 min before the latest time for Shema (GRA)`), card.text);
    const { id: next, pending } = await pendingOf(card);
    assert(show(pending.event.zmanSpec) === show(GRA_10) && pending.event.zmanDaySaid === true && pending.event.allDay === true, show(pending.event));
    assert(geminiPrompts[0].includes('timed by a halachic time (a zman)') && geminiPrompts[0].includes('Never change how it is timed.') && !geminiPrompts[0].includes('"opinion"'), geminiPrompts[0]);
    await tap(`event_create:${next}`);
    assert(made() === 1 && show(created[0].input.zmanSpec) === show(GRA_10) && (created[0].input.startTime as Date).getTime() === at('2026-10-29 00:00').getTime(), show(created));
  });

  await check('correction: a clock time makes it a fixed time: no rule, no choices, no zmanSpec in the create', async () => {
    for (const make of [graReminder, choosing]) {
      botCalls = []; created = [];
      await showEventConfirmation(555, undefined, await make(), 'x', dana);
      const { id } = await pendingOf(lastBot());
      geminiText = answer({ startTime: '17:00', endTime: '17:00', allDay: false });
      await handleEventCorrection(555, 1001, id, 701, { text: 'at 5pm' });
      const card = lastBot();
      assert(card.text.includes('📆 Wed, Oct 28, 17:00') && card.text.includes('<b>Say Shema</b>') && !card.text.includes('min before') && !card.text.includes('Which opinion?'), card.text);
      const { id: next, pending } = await pendingOf(card);
      assert(pending.event.zmanSpec === undefined && pending.event.zmanChoices === undefined && pending.event.zmanDaySaid === undefined && pending.event.allDay === false, show(pending.event));
      await tap(`event_create:${next}`);
      assert(made() === 1 && !('zmanSpec' in created[0].input) && (created[0].input.startTime as Date).getTime() === at('2026-10-28 17:00').getTime(), show(created));
    }
  });

  await check('correction: the choices stay through a day change (every choice on the new day) and a reply naming the opinion resolves them', async () => {
    await showEventConfirmation(555, undefined, await choosing(), 'x', dana);
    const { id } = await pendingOf(lastBot());
    geminiText = answer({ startDate: '2026-10-29', endDate: '2026-10-29', opinion: null });
    await handleEventCorrection(555, 1001, id, 701, { text: 'tomorrow' });
    assert(geminiPrompts[0].includes('"opinion": "gra" | "mga"') && geminiPrompts[0].includes('still to choose whose opinion'), geminiPrompts[0]);
    const { id: next, pending } = await pendingOf(lastBot());
    assert(show(pending.event.zmanChoices?.map((c) => c.day)) === show(['2026-10-29', '2026-10-29']) && pending.event.zmanSpec === undefined && pending.event.zmanDaySaid === true, show(pending.event));
    assert(buttonsOf(lastBot()).some((b) => b.callback_data.startsWith('event_pick:')), show(buttonsOf(lastBot())));
    // "the GRA", said in a reply: one rule, with a Create button
    geminiText = answer({ startDate: '2026-10-29', endDate: '2026-10-29', opinion: 'gra' });
    await handleEventCorrection(555, 1001, next, 701, { text: 'the GRA' });
    const card = lastBot();
    const { id: third, pending: chosen } = await pendingOf(card);
    assert(show(chosen.event.zmanSpec) === show(GRA_10) && chosen.event.zmanChoices === undefined && (chosen.event.startTime as Date).getTime() === at('2026-10-29 00:00').getTime(), show(chosen.event));
    assert(card.text.includes('(GRA)') && !card.text.includes('Which opinion?') && buttonsOf(card).some((b) => b.callback_data === `event_create:${third}`), card.text);
    // an opinion the set lacks leaves the choices (and is logged)
    botCalls = [];
    await showEventConfirmation(555, undefined, await choosing(), 'x', dana);
    const { id: fourth } = await pendingOf(lastBot());
    geminiText = answer({ opinion: 'baalHatanya' });
    await handleEventCorrection(555, 1001, fourth, 701, { text: 'the Alter Rebbe' });
    assert(lastBot().text.includes('Which opinion?'), lastBot().text);
  });

  await check('quick fix: Day keeps the rule (and moves every choice), Time drops it; through the webhook\'s own reply handler', async () => {
    const day = await graReminder();
    geminiText = '{"startDate": "2026-10-29"}';
    const patch = await extractFieldPatch('day', null, 'tomorrow', day, CALENDARS, 'en', IL);
    assert(!!patch, 'no patch');
    const moved = applyFieldPatch(day, patch, IL);
    assert(show(moved.zmanSpec) === show(GRA_10) && moved.zmanDaySaid === true && dayOf(moved.startTime) === '2026-10-29' && moved.allDay, show(moved));
    const choicesMoved = applyFieldPatch(await choosing(), patch, IL);
    assert(show(choicesMoved.zmanChoices?.map((c) => c.day)) === show(['2026-10-29', '2026-10-29']) && choicesMoved.zmanSpec === undefined, show(choicesMoved));
    geminiText = '{"startTime": "17:00"}';
    const timePatch = await extractFieldPatch('time', null, '5pm', day, CALENDARS, 'en', IL);
    assert(!!timePatch && timePatch.allDay === false, show(timePatch));
    const fixed = applyFieldPatch(await choosing(), timePatch, IL);
    assert(fixed.zmanSpec === undefined && fixed.zmanChoices === undefined && fixed.reminderPaused === undefined && !fixed.allDay, show(fixed));
    // A plain reminder is patched as it always was
    const plain = plainReminder();
    const plainFixed = applyFieldPatch(plain, timePatch, IL);
    assert(plainFixed.startTime === timePatch.startTime && !('zmanSpec' in plainFixed && plainFixed.zmanSpec !== undefined), show(plainFixed));
    // The reply handler: a Day reply on the card of a rule re-renders the card with the rule and the new day
    await showEventConfirmation(555, undefined, day, 'x', dana);
    const { id } = await pendingOf(lastBot());
    await setQuickCorrection(555, { pendingId: id, field: 'day', messageId: 701 });
    geminiText = '{"startDate": "2026-10-29"}';
    await quiet(() => handleTelegramWebhook({ body: { update_id: 2, message: { message_id: 800, from, chat: { id: 555 }, text: 'tomorrow' } } } as never, { status: () => ({ json: noop }) } as never));
    assert(lastBot().text.includes('Thu, Oct 29') && lastBot().text.includes('(GRA)') && lastBot().text.includes('· 10 min before'), lastBot().text);
    const { pending } = await pendingOf(lastBot());
    assert(pending.event.zmanDaySaid === true && show(pending.event.zmanSpec) === show(GRA_10), show(pending.event));
    // ... and a Time reply drops it
    await setQuickCorrection(555, { pendingId: (await pendingOf(lastBot())).id, field: 'time', messageId: 701 });
    geminiText = '{"startTime": "17:00"}';
    await quiet(() => handleTelegramWebhook({ body: { update_id: 3, message: { message_id: 801, from, chat: { id: 555 }, text: 'at 5pm' } } } as never, { status: () => ({ json: noop }) } as never));
    assert(lastBot().text.includes('17:00') && !lastBot().text.includes('min before'), lastBot().text);
    const timed = (await pendingOf(lastBot())).pending.event;
    assert(timed.zmanSpec === undefined && timed.allDay === false, show(timed));
  });


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

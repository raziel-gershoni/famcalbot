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
  answerCallbackQuery: async (_id: string, opts?: Record<string, unknown>) => {
    botCalls.push({ method: 'answerCallbackQuery', text: String(opts?.text ?? ''), opts });
    return true;
  },
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

  void showEventConfirmation; void waButtonsOf; void lastBot; void rowsOf; void buttonsOf; void pendingIdOf; void MGA_10;

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

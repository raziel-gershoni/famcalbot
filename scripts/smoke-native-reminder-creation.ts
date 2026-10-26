// Smoke test for creating native reminders.
// Part 1, extraction: the reminder rules in the extraction prompt, the reminder fields and
// times the parser reads, several reminders in one message, and a forwarded message with
// several events reaching the bulk card. The model, Telegram, the user lookup and the
// calendars are faked. No network, no database.
//
// Users without reminders must get exactly the prompt they got before reminders existed.
// scripts/fixtures/extraction-prompts.json is that prompt, taken from the builder before
// the reminder rules were added, with:
//   npx tsx scripts/smoke-native-reminder-creation.ts --write-prompt-fixture
// It refuses to overwrite the file. Take a new snapshot only when the prompt for users
// without reminders is meant to change: delete the file, then run it again.
// Retaken once, for hebrew-repeats spec §5, which teaches every user's prompt the Hebrew
// repeats and the Hebrew date (the recurrence schema line, the RECURRENCE DETECTION list, the
// Hebrew-date rules, four examples, and the image prompt's Hebrew-only date line).
// Retaken again 2026-10-21, when the yahrzeit repeat was withdrawn: hebrewKind left the three
// RECURRENCE DETECTION lines, the schema line and the three Hebrew examples, and the yahrzeit
// words became the one Hebrew repeat, every year on the Hebrew date.
//
// Run under both clocks; the output must not depend on the server's timezone:
//   TZ=UTC npx tsx scripts/smoke-native-reminder-creation.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-native-reminder-creation.ts

import Module from 'node:module';
import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { formatInTimeZone } from 'date-fns-tz';
import type { VoiceIntentResult } from '../src/services/event-parser';
import type { ReminderPromptContext } from '../src/services/voice/gemini-voice';
import type { CalendarAssignment, UserConfig } from '../src/types';

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

// ---- Environment: fakes only, set before anything under test loads ----

process.env.NEXT_PUBLIC_APP_URL = 'https://famcal.test';
process.env.GEMINI_API_KEY = 'test-key';
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.UPSTASH_REDIS_REST_URL = 'https://redis.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
process.env.DATABASE_URL = 'postgresql://test@db.invalid/test';

/** Any request that slips past the fakes is refused and counted. */
const networkAttempts: string[] = [];
globalThis.fetch = (async (input: unknown) => {
  networkAttempts.push(String(input));
  throw new Error('network is blocked in this smoke test');
}) as typeof fetch;

// ---- Fixtures ----

const IL = 'Asia/Jerusalem';
const NY = 'America/New_York';
const color = '#4285f4';

/** A built-in calendar pair as the prompt lists it for the user: theirs, then the partner's. */
const NATIVE_CALENDARS: CalendarAssignment[] = [
  { calendarId: 'native:cmain00000000000000000001', name: 'רזיאל', labels: ['primary', 'yours'], color },
  { calendarId: 'native:cdana00000000000000000002', name: 'דנה', labels: ['spouse'], color, personName: 'דנה', personEnglishName: 'Dana', personGender: 'female' },
];
const GOOGLE_CALENDARS: CalendarAssignment[] = [
  { calendarId: 'raziel@example.com', name: 'Raziel', labels: ['primary', 'yours'], color },
  { calendarId: 'kids123@group.calendar.google.com', name: 'Kids', labels: ['kids'], color, rules: ['Noa has ballet on Tuesdays'] },
];
/** The voice prompt's recent-events context, as formatRecentEventsBlock writes it. */
const RECENT_BLOCK = [
  'RECENTLY TOUCHED EVENTS (most recent last) — the user may refer to these via "the lunch", "that meeting", "it", "yesterday\'s appointment", etc.:',
  '1. "רופא שיניים" on Oct 15 at 10:00 (calendar: native:cmain00000000000000000001, action: create)',
].join('\n');

/** The user and the partner, as the reminder rules name them. */
const PAIR: ReminderPromptContext = { userName: 'רזיאל', userEnglishName: 'Raziel', partnerName: 'דנה', partnerEnglishName: 'Dana' };
/** A user with no partner. */
const SOLO: ReminderPromptContext = { userName: 'Raziel', userEnglishName: null, partnerName: null, partnerEnglishName: null };

const USER = {
  id: 7, telegramId: 5551, name: 'רזיאל', englishName: 'Raziel', language: 'he', isAdmin: false, voiceInputEnabled: true,
  calendarSource: 'NATIVE', googleRefreshToken: '', pairingId: 'pair-1', suspendedAt: null,
} as unknown as UserConfig;

const FIXTURE = path.resolve(__dirname, 'fixtures/extraction-prompts.json');

/** The prompt with its clock line pinned, so a snapshot taken on another day still compares. */
const pinClock = (prompt: string) => prompt.replace(/^CURRENT DATE\/TIME: .*$/m, 'CURRENT DATE/TIME: <pinned>');

type PromptArgs = [language: string, calendars: CalendarAssignment[], timezone: string, mode?: 'voice' | 'text' | 'image', recentEventsBlock?: string];
/** Every argument shape the app builds the extraction prompt with, by name. */
const PROMPT_CASES: Record<string, PromptArgs> = {
  'voice-he-native-recent': ['he', NATIVE_CALENDARS, IL, 'voice', RECENT_BLOCK],
  'voice-ru-no-calendars-default-mode': ['ru', [], IL],
  'text-he-native': ['he', NATIVE_CALENDARS, IL, 'text'],
  'text-en-google': ['en', GOOGLE_CALENDARS, NY, 'text'],
  'image-he-native': ['he', NATIVE_CALENDARS, IL, 'image'],
};

/** Where two strings first differ, with a little of each, for a readable failure. */
function firstDifference(got: string, want: string | undefined): string {
  if (want === undefined) return 'missing from the snapshot';
  let i = 0;
  while (i < got.length && got[i] === want[i]) i++;
  return `character ${i}: got ${JSON.stringify(got.slice(i, i + 40))}, snapshot ${JSON.stringify(want.slice(i, i + 40))}`;
}

/** An instant on the user's clock, or 'invalid'. */
const at = (date: Date | undefined, tz: string) =>
  (date && !isNaN(date.getTime()) ? formatInTimeZone(date, tz, 'yyyy-MM-dd HH:mm') : 'invalid');

// ---- Fakes ----

/** The extraction model: answers `modelReply` as Gemini does (in a code block) and records every prompt. */
let modelReply: object = {};
const modelPrompts: string[] = [];
const fakeGemini = {
  models: {
    generateContent: async (request: { contents: Array<{ parts: Array<{ text?: string }> }> }) => {
      modelPrompts.push(request.contents[0].parts[0].text ?? '');
      return { text: '```json\n' + JSON.stringify(modelReply) + '\n```', usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 80 } };
    },
  },
};

/** Every message sent to the user, through the messaging service or the bot. */
const sent: Array<{ chatId: number | string; text: string }> = [];
const telegram = {
  sendMessage: async (chatId: number | string, text: string) => {
    sent.push({ chatId, text });
    return 1;
  },
  sendTypingIndicator: async () => {},
};
const fakeBot = {
  sendMessage: async (chatId: number | string, text: string) => {
    sent.push({ chatId, text });
    return { message_id: 1 };
  },
};

let user: UserConfig = USER;
const cardCalls: unknown[][] = [];
const bulkCalls: unknown[][] = [];
const editCalls: unknown[][] = [];

const SRC = path.resolve(__dirname, '../src');

/** Modules replaced by fakes, by file path; a function fakes part of the real module. */
const stubs: Record<string, object | ((real: Record<string, unknown>) => object)> = {
  [`${SRC}/services/ai-provider.ts`]: { getGemini: () => fakeGemini, extractionConfig: () => ({}) },
  [`${SRC}/services/voice/audio-level.ts`]: { isSilent: () => false },
  [`${SRC}/services/voice/speech-presence.ts`]: { NO_SPEECH: 'no_speech', detectSpeech: async () => true, detectAddressedSpeech: async () => true },
  [`${SRC}/services/telegram/index.ts`]: { getBot: () => fakeBot, getMessagingService: () => telegram },
  [`${SRC}/services/telegram/command-pipeline.ts`]: { startTypingInterval: () => () => {} },
  [`${SRC}/services/user-service.ts`]: { getUserByTelegramId: async () => user },
  [`${SRC}/services/subscription-service.ts`]: { checkFeatureAccess: async () => ({ allowed: true }) },
  [`${SRC}/services/analytics-service.ts`]: { trackActivityAsync: () => {}, addBreadcrumb: () => {}, setUserContext: () => {} },
  [`${SRC}/lib/error-capture.ts`]: { captureError: () => {}, captureWarning: () => {}, captureInfo: () => {} },
  [`${SRC}/lib/timezone.ts`]: { resolveUserTimezone: async () => IL },
  [`${SRC}/services/calendar-provider/index.ts`]: {
    hasUsableCalendar: async () => true,
    getCalendarAssignmentsForUser: async () => NATIVE_CALENDARS,
  },
  [`${SRC}/services/voice/confirmations.ts`]: {
    showEventConfirmation: async (...args: unknown[]) => { cardCalls.push(args); },
    sendAnchorQuestions: async () => {},
  },
  // Reminders off: these checks pin the forwarded flow without reminder support (Task 11)
  [`${SRC}/services/native-reminders/support.ts`]: { getReminderSupport: async () => ({ supported: false, reason: 'disabled' }) },
  [`${SRC}/services/voice/bulk-confirmations.ts`]: {
    showBulkConfirmation: async (...args: unknown[]) => {
      bulkCalls.push(args);
      return 'bulk:1:abc123';
    },
  },
  [`${SRC}/services/voice/index.ts`]: {
    handleEditIntent: async (...args: unknown[]) => { editCalls.push(args); },
    handleDeleteIntent: async (...args: unknown[]) => { editCalls.push(args); },
  },
};

const ModuleInternals = Module as unknown as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  _resolveFilename: (request: string, parent: unknown, isMain: boolean) => string;
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
  if (!(resolved in stubs) || loadingReal.has(resolved)) return realLoad.call(this, request, parent, isMain);
  return fakeFor(resolved, () => realLoad.call(this, request, parent, isMain));
};

// The handlers load the calendar provider and the bulk card with import(), which goes
// through the ES module loader instead; it gets the same fake, served as an ES module.
(globalThis as { creationSmokeFake?: (file: string) => object }).creationSmokeFake = file =>
  fakeFor(file, () => realLoad.call(Module, file, null, false));
Module.registerHooks({
  load(url, context, nextLoad) {
    const file = url.startsWith('file:') ? fileURLToPath(url.split('?')[0]) : '';
    if (!(file in stubs) || loadingReal.has(file)) return nextLoad(url, context);
    const fake = (globalThis as unknown as { creationSmokeFake: (file: string) => object }).creationSmokeFake(file);
    const names = Object.keys(fake).map(name => `export const ${name} = fake.${name};`).join('\n');
    return { format: 'module', shortCircuit: true, source: `const fake = globalThis.creationSmokeFake(${JSON.stringify(file)});\n${names}\n` };
  },
});

// ---- Snapshot ----

async function writePromptFixture() {
  if (existsSync(FIXTURE)) {
    console.error(`${path.relative(process.cwd(), FIXTURE)} exists. Delete it first to take a new snapshot.`);
    process.exit(1);
  }
  const { buildEventExtractionPrompt } = await import('../src/services/voice/gemini-voice');
  const snapshot = Object.fromEntries(
    Object.entries(PROMPT_CASES).map(([name, args]) => [name, pinClock(buildEventExtractionPrompt(...args))])
  );
  mkdirSync(path.dirname(FIXTURE), { recursive: true });
  writeFileSync(FIXTURE, JSON.stringify(snapshot, null, 2) + '\n');
  console.log(`Wrote ${Object.keys(snapshot).length} prompts to ${path.relative(process.cwd(), FIXTURE)}`);
}

// ---- Part 1: extraction ----

async function extractionChecks() {
  const { buildEventExtractionPrompt, extractIntents, parseGeminiEventResponse, processVoiceWithGemini } =
    await import('../src/services/voice/gemini-voice');
  const { processTextWithGemini } = await import('../src/services/forward-event/gemini-text');
  const { handleForwardedMessage } = await import('../src/services/forward-event/handler');
  const { getBotMessages } = await import('../src/lib/bot-messages');
  assert(existsSync(FIXTURE), `${FIXTURE} is missing: take the snapshot first (see the header)`);
  const snapshot: Record<string, string> = JSON.parse(readFileSync(FIXTURE, 'utf8'));

  /** Only the reminder rules: what the prompt with reminders adds to the one without. */
  const rulesFor = (mode: 'voice' | 'text', reminders: ReminderPromptContext = PAIR) => {
    const base = pinClock(buildEventExtractionPrompt('he', NATIVE_CALENDARS, IL, mode));
    const prompt = pinClock(buildEventExtractionPrompt('he', NATIVE_CALENDARS, IL, mode, undefined, reminders));
    assert(prompt.startsWith(base) && prompt.length > base.length, `${mode}: the rules are not appended to the unchanged prompt`);
    return prompt.slice(base.length);
  };

  // (a) The prompt.

  await check('without reminders the prompt is byte-identical to the snapshot, in every mode', () => {
    assert(isDeepStrictEqual(Object.keys(snapshot), Object.keys(PROMPT_CASES)), `snapshot cases: ${Object.keys(snapshot).join(', ')}`);
    for (const [name, [language, calendars, timezone, mode, recent]] of Object.entries(PROMPT_CASES)) {
      const prompt = pinClock(buildEventExtractionPrompt(language, calendars, timezone, mode, recent, undefined));
      assert(prompt === snapshot[name], `${name} differs at ${firstDifference(prompt, snapshot[name])}`);
    }
  });

  await check('voice and text prompts gain the reminder rules after the unchanged prompt', () => {
    for (const mode of ['voice', 'text'] as const) {
      const rules = rulesFor(mode);
      for (const needle of ['REMINDERS', '"kind"', '"forPerson"', '"anchor"', '"offsetMinutes"']) {
        assert(rules.includes(needle), `${mode}: no ${needle}`);
      }
    }
  });

  await check('a photo never gets the reminder rules', () => {
    const base = pinClock(buildEventExtractionPrompt('he', NATIVE_CALENDARS, IL, 'image'));
    const prompt = pinClock(buildEventExtractionPrompt('he', NATIVE_CALENDARS, IL, 'image', undefined, PAIR));
    assert(prompt === base, `the image prompt changed at ${firstDifference(prompt, base)}`);
  });

  await check('the rules name the user and the partner, in both spellings', () => {
    const rules = rulesFor('voice');
    for (const name of ['רזיאל', 'Raziel', 'דנה', 'Dana']) assert(rules.includes(`"${name}"`), `no "${name}"`);
    assert(rules.includes('"forPerson": "partner"'), 'no partner example');
  });

  await check('without a partner every reminder is for the user', () => {
    const rules = rulesFor('text', SOLO);
    assert(rules.includes('"Raziel"'), 'no user name');
    assert(rules.includes('no linked partner'), 'no "no linked partner" rule');
    assert(!rules.includes('"forPerson": "partner"'), 'a partner example is still there');
  });

  await check('with a partner the rules teach "both" (remind us), in English, Hebrew and Russian, with an example of each; without a partner there is none', () => {
    for (const mode of ['voice', 'text'] as const) {
      const rules = rulesFor(mode);
      assert(rules.includes('"forPerson": "self" | "partner" | "both"'), `${mode}: the schema lacks "both"`);
      for (const phrase of ['"both" when it is for the user AND the user\'s partner together', 'remind us to', 'remind both of us', 'תזכיר לנו', 'תזכיר לשנינו', 'напомни нам', 'напомни нам обоим']) {
        assert(rules.includes(phrase), `${mode}: no "${phrase}"`);
      }
      // "Remind us" is no longer a "self" phrase.
      assert(!/"self" for everything else: "remind me", "remind us"/.test(rules), `${mode}: remind us is still self`);
      const bothExamples = rules.split('\n').filter((line) => line.includes('"forPerson": "both"'));
      assert(bothExamples.length === 3, `${mode}: ${bothExamples.length} examples of both`);
      assert(/[\u0590-\u05FF]/.test(bothExamples.join('')) && /[\u0400-\u04FF]/.test(bothExamples.join('')) && /Remind us/.test(rules), `${mode}: en, he and ru`);
    }
    const solo = rulesFor('text', SOLO);
    assert(!solo.includes('"forPerson": "both"') && !solo.includes('"both" when'), 'a user with no partner is offered "both"');
  });

  await check('the live eval\'s "remind us" cases are phrased differently from the prompt\'s own examples (nine, three per language), so they test generalisation', () => {
    const source = readFileSync(path.resolve(__dirname, 'eval-native-reminders.ts'), 'utf8');
    const texts = [...source.matchAll(/label: 'both: [^']+', text: '([^']+)'/g)].map((m) => m[1]);
    assert(texts.length === 9, `${texts.length} cases`);
    for (const mode of ['voice', 'text'] as const) {
      const rules = rulesFor(mode).toLowerCase();
      for (const text of texts) assert(!rules.includes(text.toLowerCase()), `${mode}: the prompt already holds "${text}"`);
    }
  });

  await check('the rules carry the Hebrew, English and Russian phrasings', () => {
    const rules = rulesFor('text');
    const phrases = [
      'remind me', "don't forget", 'תזכיר לי', 'אל תשכח', 'напомни', 'не забудь',
      'I did it', 'סיימתי', 'сделал', 'Stop reminding me', 'תפסיק להזכיר', 'хватит напоминать', "Skip today's",
    ];
    for (const phrase of phrases) assert(rules.includes(phrase), `no "${phrase}"`);
  });

  await check('voice examples carry a transcription, text examples do not', () => {
    assert(rulesFor('voice').includes('"transcription": "Remind me to call the plumber'), 'voice');
    assert(!rulesFor('text').includes('"transcription"'), 'text');
  });

  // (b) The parser.

  const parse = (event: Record<string, unknown>, tz = IL, remindersOn = true) =>
    parseGeminiEventResponse(
      { intent: 'create', confidence: 'high', event: { title: 'Call the plumber', calendarId: 'primary', ...event } },
      NATIVE_CALENDARS, tz, remindersOn
    );

  await check('a timed reminder needs no end time: it ends where it starts', () => {
    for (const tz of [IL, NY]) {
      const { event, error } = parse({ kind: 'reminder', forPerson: 'self', startDate: '2026-10-15', startTime: '10:00', endDate: null, endTime: null, allDay: false }, tz);
      assert(!!event && !error, `${tz}: ${error}`);
      assert(at(event.startTime, tz) === '2026-10-15 10:00', `${tz}: start ${at(event.startTime, tz)}`);
      assert(event.endTime.getTime() === event.startTime.getTime(), `${tz}: end ${at(event.endTime, tz)}`);
      assert(event.kind === 'reminder' && event.forPerson === 'self' && !event.allDay && event.anchor === undefined, `${tz}: ${JSON.stringify(event)}`);
    }
  });

  await check('a date-only reminder starts at local midnight and has no length (no 23:59 end)', () => {
    for (const tz of [IL, NY]) {
      for (const fields of [{ allDay: true }, { allDay: true, startTime: '10:00' }, { allDay: false }]) {
        const { event } = parse({ kind: 'reminder', startDate: '2026-10-16', ...fields }, tz);
        assert(!!event && event.allDay, `${tz} ${JSON.stringify(fields)}: not all day`);
        assert(at(event.startTime, tz) === '2026-10-16 00:00' && event.endTime.getTime() === event.startTime.getTime(),
          `${tz} ${JSON.stringify(fields)}: ${at(event.startTime, tz)}..${at(event.endTime, tz)}`);
      }
    }
  });

  await check('a date-only reminder where daylight saving starts at midnight starts at 01:00', () => {
    const tz = 'America/Santiago';
    const { event } = parse({ kind: 'reminder', startDate: '2026-09-06', allDay: true }, tz);
    assert(!!event && at(event.startTime, tz) === '2026-09-06 01:00' && event.endTime.getTime() === event.startTime.getTime(),
      `${at(event?.startTime, tz)}..${at(event?.endTime, tz)}`);
  });

  await check('a reminder with no date is for today, on the user\'s clock', () => {
    for (const tz of [IL, NY]) {
      const today = formatInTimeZone(new Date(), tz, 'yyyy-MM-dd');
      const dateOnly = parse({ kind: 'reminder', allDay: true }, tz).event;
      assert(!!dateOnly && dateOnly.allDay && at(dateOnly.startTime, tz) === `${today} 00:00`, `${tz} date-only: ${at(dateOnly?.startTime, tz)}`);
      const timed = parse({ kind: 'reminder', startTime: '23:30' }, tz).event;
      assert(!!timed && !timed.allDay && at(timed.startTime, tz) === `${today} 23:30`, `${tz} timed: ${at(timed?.startTime, tz)}`);
    }
  });

  await check('a reminder for the partner or for both says so; anything else is for the user', () => {
    const partner = parse({ kind: 'reminder', forPerson: 'partner', startDate: '2026-10-15', allDay: true }).event;
    assert(partner?.forPerson === 'partner', `partner → ${partner?.forPerson}`);
    const both = parse({ kind: 'reminder', forPerson: 'both', startDate: '2026-10-15', allDay: true }).event;
    assert(both?.forPerson === 'both', `both → ${both?.forPerson}`);
    for (const forPerson of [undefined, null, 'self', 'Dana', 'everyone']) {
      const got = parse({ kind: 'reminder', forPerson, startDate: '2026-10-15', allDay: true }).event?.forPerson;
      assert(got === 'self', `${forPerson} → ${got}`);
    }
  });

  await check('an anchored reminder keeps its anchor, and its times are left for the server', () => {
    const { event, error } = parse({ kind: 'reminder', title: 'Bring the forms', anchor: { description: 'dentist', offsetMinutes: -60 }, startDate: null, startTime: null });
    assert(!!event && !error, `error ${error}`);
    assert(isDeepStrictEqual(event.anchor, { description: 'dentist', offsetMinutes: -60 }), JSON.stringify(event.anchor));
    assert(isNaN(event.startTime.getTime()) && isNaN(event.endTime.getTime()), `${event.startTime}..${event.endTime}`);
    assert(event.kind === 'reminder' && event.title === 'Bring the forms', JSON.stringify(event));
    // A date next to an anchor is ignored: the anchor decides.
    const dated = parse({ kind: 'reminder', anchor: { description: ' רופא שיניים ', offsetMinutes: '-1440' }, startDate: '2026-10-15' }).event;
    assert(isDeepStrictEqual(dated?.anchor, { description: 'רופא שיניים', offsetMinutes: -1440 }), JSON.stringify(dated?.anchor));
    assert(!!dated && isNaN(dated.startTime.getTime()), `dated: ${at(dated?.startTime, IL)}`);
  });

  await check('a broken anchor with no date is reported, not guessed as today', () => {
    for (const anchor of [{ description: '' }, { description: 'dentist', offsetMinutes: 'an hour' }, 'dentist']) {
      const { event, error } = parse({ kind: 'reminder', anchor });
      assert(!event && error === 'Missing date/time fields', `${JSON.stringify(anchor)}: ${error}`);
    }
  });

  await check('an unknown kind is an event: it still needs its end time and gets no reminder fields', () => {
    const missingEnd = parse({ kind: 'task', startDate: '2026-10-15', startTime: '10:00' });
    assert(!missingEnd.event && missingEnd.error === 'Missing date/time fields', `got ${missingEnd.error}`);
    const { event } = parse({
      kind: 'task', forPerson: 'partner', anchor: { description: 'dentist', offsetMinutes: -60 },
      startDate: '2026-10-15', startTime: '10:00', endDate: '2026-10-15', endTime: '11:00',
    });
    assert(!!event && event.kind === undefined && event.forPerson === undefined && event.anchor === undefined, JSON.stringify(event));
    assert(at(event.endTime, IL) === '2026-10-15 11:00', `end ${at(event.endTime, IL)}`);
  });

  await check('an event parses exactly as before, with reminders on or off', () => {
    const json = {
      intent: 'create', confidence: 'high',
      event: { title: 'Dentist', startDate: '2026-10-15', startTime: '10:00', endDate: '2026-10-15', endTime: '11:00', allDay: false, calendarId: 'native:cmain00000000000000000001', calendarName: 'רזיאל', recurrence: null },
    };
    const before = parseGeminiEventResponse(json, NATIVE_CALENDARS, IL);
    const keys = ['title', 'startTime', 'endTime', 'location', 'description', 'allDay', 'calendarId', 'calendarName', 'confidence', 'recurrence'];
    assert(isDeepStrictEqual(Object.keys(before.event ?? {}), keys), `event fields: ${Object.keys(before.event ?? {}).join(', ')}`);
    const tagged = { ...json, event: { ...json.event, kind: 'event', forPerson: 'self', anchor: null } };
    for (const remindersOn of [true, false]) {
      const after = parseGeminiEventResponse(tagged, NATIVE_CALENDARS, IL, remindersOn);
      assert(isDeepStrictEqual(after, before), `reminders ${remindersOn ? 'on' : 'off'}: ${JSON.stringify(after)}`);
    }
  });

  await check('with reminders off, a reminder from the model is read as an event, as before', () => {
    const timed = parse({ kind: 'reminder', forPerson: 'partner', startDate: '2026-10-15', startTime: '10:00', allDay: false }, IL, false);
    assert(!timed.event && timed.error === 'Missing date/time fields', `timed: ${timed.error}`);
    const dateOnly = parse({ kind: 'reminder', forPerson: 'partner', startDate: '2026-10-15', allDay: true }, IL, false).event;
    assert(!!dateOnly && dateOnly.kind === undefined && dateOnly.forPerson === undefined && at(dateOnly.endTime, IL) === '2026-10-15 23:59',
      `date-only: ${JSON.stringify(dateOnly)}`);
  });

  await check('an unreadable reminder time is reported, not thrown', () => {
    const { event, error } = parse({ kind: 'reminder', startDate: '2026-10-15', startTime: 'ten' });
    assert(!event && error === 'Invalid date/time parsed', `got ${error}`);
  });

  await check('a repeating reminder keeps its recurrence and its first time', () => {
    const { event, error } = parse({ kind: 'reminder', title: 'Take out the trash', startDate: '2026-10-18', startTime: '08:00', recurrence: { frequency: 'weekly', daysOfWeek: ['SU'] } });
    assert(!!event, `error ${error}`);
    assert(event.recurrence?.frequency === 'weekly' && event.recurrence.daysOfWeek?.[0] === 'SU', JSON.stringify(event.recurrence));
    assert(at(event.startTime, IL) === '2026-10-18 08:00' && event.endTime.getTime() === event.startTime.getTime(), `${at(event.startTime, IL)}..${at(event.endTime, IL)}`);
  });

  // (c) Several reminders in one message.

  const multi = {
    intents: [
      { intent: 'create', confidence: 'high', event: { kind: 'reminder', forPerson: 'self', title: 'Call mom', startDate: '2026-10-15', startTime: '17:00', calendarId: 'primary' } },
      { intent: 'create', confidence: 'high', event: { kind: 'reminder', forPerson: 'partner', title: 'Buy milk', startDate: '2026-10-16', allDay: true, calendarId: 'primary' } },
      { intent: 'create', confidence: 'high', event: { kind: 'event', title: 'Dentist', startDate: '2026-10-17', startTime: '10:00', endDate: '2026-10-17', endTime: '11:00', allDay: false, calendarId: 'primary' } },
    ],
  };
  const describe = (r: VoiceIntentResult) =>
    (r.event ? `${r.event.kind ?? 'event'}/${r.event.forPerson ?? '-'} ${at(r.event.startTime, IL)}..${at(r.event.endTime, IL)}` : `error ${r.error}`);

  await check('several reminders in one message each come back with their own fields', () => {
    const got = extractIntents(multi, NATIVE_CALENDARS, IL, true).map(describe);
    const want = [
      'reminder/self 2026-10-15 17:00..2026-10-15 17:00',
      'reminder/partner 2026-10-16 00:00..2026-10-16 00:00',
      'event/- 2026-10-17 10:00..2026-10-17 11:00',
    ];
    assert(isDeepStrictEqual(got, want), got.join(' | '));
  });

  await check('with reminders off, the same message parses as it does today', () => {
    const got = extractIntents(multi, NATIVE_CALENDARS, IL).map(describe);
    const want = [
      'error Missing date/time fields',
      'event/- 2026-10-16 00:00..2026-10-16 23:59',
      'event/- 2026-10-17 10:00..2026-10-17 11:00',
    ];
    assert(isDeepStrictEqual(got, want), got.join(' | '));
  });

  // (d) The model calls.

  const dinner = { title: 'Dinner', startDate: '2026-10-16', startTime: '19:00', endDate: '2026-10-16', endTime: '21:00', allDay: false, calendarId: 'primary' };
  const dentist = { title: 'Dentist', startDate: '2026-10-17', startTime: '10:00', endDate: '2026-10-17', endTime: '11:00', allDay: false, calendarId: 'primary' };

  await check('forwarded text without reminders sends the snapshot prompt and the message, as before', async () => {
    modelPrompts.length = 0;
    modelReply = { intent: 'create', confidence: 'high', event: dinner };
    const { intentResult, intentResults } = await processTextWithGemini('Dinner Friday at 7?', 'he', NATIVE_CALENDARS, IL);
    const want = `${snapshot['text-he-native']}\n\nFORWARDED MESSAGE:\nDinner Friday at 7?`;
    assert(pinClock(modelPrompts[0]) === want, `prompt differs at ${firstDifference(pinClock(modelPrompts[0]), want)}`);
    assert(intentResults.length === 1 && intentResults[0] === intentResult && intentResult.event?.title === 'Dinner', JSON.stringify(intentResults));
  });

  await check('forwarded text with reminders sends the rules and returns every intent', async () => {
    modelPrompts.length = 0;
    modelReply = multi;
    const { intentResult, intentResults } = await processTextWithGemini('Remind me to call mom at 5 and Dana to buy milk tomorrow', 'he', NATIVE_CALENDARS, IL, PAIR);
    assert(modelPrompts[0].includes('"forPerson"') && modelPrompts[0].includes('"דנה"'), 'no reminder rules in the prompt');
    assert(intentResults.length === 3 && intentResult === intentResults[0], `${intentResults.length} intents`);
    assert(intentResults.map(describe)[1] === 'reminder/partner 2026-10-16 00:00..2026-10-16 00:00', intentResults.map(describe).join(' | '));
  });

  const spokenReminder = {
    transcription: 'תזכיר לי מחר בערב להתקשר לאמא', intent: 'create', confidence: 'high',
    event: { kind: 'reminder', forPerson: 'self', title: 'להתקשר לאמא', startDate: '2026-10-15', startTime: '20:00', calendarId: 'primary' },
  };

  await check('voice with reminders sends the rules, then the retry note, and reads the reminder', async () => {
    modelPrompts.length = 0;
    modelReply = spokenReminder;
    const audio = Buffer.from('OggS');
    const { intentResult, transcription } = await processVoiceWithGemini(audio, 'he', NATIVE_CALENDARS, IL, RECENT_BLOCK, audio, PAIR);
    const prompt = pinClock(modelPrompts[0]);
    const withRules = pinClock(buildEventExtractionPrompt('he', NATIVE_CALENDARS, IL, 'voice', RECENT_BLOCK, PAIR));
    assert(prompt.startsWith(withRules), `prompt differs at ${firstDifference(prompt, withRules)}`);
    assert(prompt.slice(withRules.length).startsWith('\n\nNOTE: The next attached audio is a PRIOR attempt'), 'no retry note after the rules');
    assert(transcription === spokenReminder.transcription, `transcription ${transcription}`);
    assert(describe(intentResult) === 'reminder/self 2026-10-15 20:00..2026-10-15 20:00', describe(intentResult));
  });

  await check('voice without reminders sends the snapshot prompt and ignores a stray reminder kind', async () => {
    modelPrompts.length = 0;
    modelReply = spokenReminder;
    const { intentResult } = await processVoiceWithGemini(Buffer.from('OggS'), 'he', NATIVE_CALENDARS, IL, RECENT_BLOCK);
    const want = snapshot['voice-he-native-recent'];
    assert(pinClock(modelPrompts[0]) === want, `prompt differs at ${firstDifference(pinClock(modelPrompts[0]), want)}`);
    assert(!intentResult.event && intentResult.error === 'Missing date/time fields', `got ${describe(intentResult)}`);
  });

  // (e) Forwarded messages: several events reach the bulk card.

  const FORWARDED = 'Dinner Friday at 7, and the dentist on Saturday at 10';
  const forward = async (reply: object) => {
    modelReply = reply;
    sent.length = 0;
    cardCalls.length = 0;
    bulkCalls.length = 0;
    editCalls.length = 0;
    user = USER;
    await handleForwardedMessage(5551, 5551, FORWARDED, { id: 5551, first_name: 'Raziel' });
  };

  await check('a forwarded message with two events gets one bulk card that quotes it', async () => {
    await forward({
      intents: [
        { intent: 'create', confidence: 'high', event: dinner },
        { intent: 'create', confidence: 'high', event: dentist },
      ],
    });
    assert(bulkCalls.length === 1 && cardCalls.length === 0 && sent.length === 0, `${bulkCalls.length} bulk, ${cardCalls.length} single, ${sent.length} sent`);
    const [chatId, intents, bulkUser, transcription, , , timezone] = bulkCalls[0] as [number, VoiceIntentResult[], UserConfig, string, unknown, unknown, string];
    assert(chatId === 5551 && bulkUser === USER && transcription === FORWARDED && timezone === IL, `args ${chatId} ${transcription} ${timezone}`);
    assert(isDeepStrictEqual(intents.map(i => i.event?.title), ['Dinner', 'Dentist']), JSON.stringify(intents));
  });

  await check('a forwarded message with one event still gets the single card, called as before', async () => {
    await forward({ intent: 'create', confidence: 'high', event: dinner });
    assert(cardCalls.length === 1 && bulkCalls.length === 0, `${cardCalls.length} single, ${bulkCalls.length} bulk`);
    const args = cardCalls[0];
    const event = args[2] as VoiceIntentResult['event'];
    assert(args.length === 6 && args[0] === 5551 && args[1] === undefined && args[3] === FORWARDED && args[4] === USER && args[5] === undefined,
      `args ${JSON.stringify(args.map((a, i) => (i === 4 ? 'user' : a)))}`);
    assert(event?.title === 'Dinner' && at(event.endTime, IL) === '2026-10-16 21:00', JSON.stringify(event));
  });

  await check('a forwarded edit still goes to the edit flow', async () => {
    await forward({ intent: 'edit', confidence: 'high', eventReference: { type: 'by_description', description: 'dinner' }, editRequest: { newStartTime: '20:00' } });
    assert(editCalls.length === 1 && cardCalls.length === 0 && bulkCalls.length === 0, `${editCalls.length} edit, ${cardCalls.length} single, ${bulkCalls.length} bulk`);
  });

  await check('a forwarded message with no event still says it found none', async () => {
    const t = await getBotMessages('he');
    await forward({ intent: 'none', confidence: 'high', error: 'No calendar event information found in this message.' });
    assert(cardCalls.length === 0 && bulkCalls.length === 0 && sent.length === 1 && sent[0].text === t.voice.forwardNotUnderstood,
      `sent ${JSON.stringify(sent)}`);
  });

  await check('nothing reached the network', () => {
    assert(networkAttempts.length === 0, networkAttempts.join(', '));
  });
}

/** The console's own log: the code under test logs every step, and only the results are shown. */
const print = console.log.bind(console);

function summarize() {
  let failed = 0;
  for (const r of results) {
    print(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  print(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  process.exit(failed ? 1 : 0);
}

async function main() {
  if (process.argv.includes('--write-prompt-fixture')) {
    await writePromptFixture();
    return;
  }
  console.log = () => {};
  console.warn = () => {};
  await extractionChecks();
  summarize();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

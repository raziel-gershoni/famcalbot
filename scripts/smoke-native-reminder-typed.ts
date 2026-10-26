// Smoke test for typed "remind me…" messages (spec §3.1, R4): the keyword filter, the
// Telegram webhook's typed-text branch and src/services/native-reminders/typed-route.ts.
// Typed text that isn't a command used to be dropped. Now a message with a reminder keyword,
// from a user who has native reminders, goes to text-mode extraction marked as typed; every
// create becomes a reminder card, edits and deletes take the chat flows, and nothing changes
// for anyone else. The webhook, the typed route and text extraction (gemini-text with the
// real prompt builder and parser) run for real; Gemini, Telegram, Redis, the user lookup, the
// support gate, reminder resolution (Task 11's resolve.ts), the cards and the anchor
// questions are faked. No network, no DB.
//
// Run under both clocks; the output must not depend on the server's timezone:
//   TZ=UTC npx tsx scripts/smoke-native-reminder-typed.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-native-reminder-typed.ts

import Module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromZonedTime } from 'date-fns-tz';
import type { ParsedEvent, VoiceIntentResult } from '../src/services/event-parser';
import type { UserConfig } from '../src/types';

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

async function check(name: string, fn: () => void | Promise<void>) {
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
process.env.ENCRYPTION_KEY = '0'.repeat(64);
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

/** Intervals still running: the typing indicator must stop on every path. */
const liveIntervals = new Set<unknown>();
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
globalThis.setInterval = ((fn: (...args: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
  const handle = realSetInterval(fn, ms, ...rest);
  liveIntervals.add(handle);
  return handle;
}) as unknown as typeof setInterval;
globalThis.clearInterval = ((handle?: Parameters<typeof clearInterval>[0]) => {
  liveIntervals.delete(handle);
  realClearInterval(handle);
}) as typeof clearInterval;

// ---- Fixtures ----

const IL = 'Asia/Jerusalem';
const RAZIEL = 1001; // NATIVE, English, paired with Dana, has native reminders
const GOOGLE = 1003; // a Google-calendar user
const NO_ACCESS = 1004; // NATIVE, but without the reminders feature
const NOA = 1005; // NATIVE, Hebrew, unpaired
const STRANGER = 1009; // never registered

function makeUser(id: number, telegramId: number, extra: Record<string, unknown>): UserConfig {
  return {
    id, telegramId, name: 'Raziel', englishName: 'Raziel', gender: 'male', language: 'en',
    calendarSource: 'NATIVE', googleRefreshToken: '', pairingId: null, isAdmin: false,
    suspendedAt: null, unreachableSince: null, voiceInputEnabled: false,
    ...extra,
  } as unknown as UserConfig;
}

const USERS: Record<number, UserConfig> = {
  [RAZIEL]: makeUser(1, RAZIEL, { pairingId: 'pair-1' }),
  [GOOGLE]: makeUser(3, GOOGLE, { calendarSource: 'GOOGLE', googleRefreshToken: 'refresh-token' }),
  [NO_ACCESS]: makeUser(4, NO_ACCESS, {}),
  [NOA]: makeUser(5, NOA, { name: 'נועה', englishName: 'Noa', gender: 'female', language: 'he' }),
};
const DANA = { id: 2, name: 'Dana', englishName: 'Dana' }; // Raziel's partner, on Telegram
// Named so that neither person's name reaches the prompt through the calendar list.
const CALENDARS = [
  { calendarId: 'native:raziel-cal', labels: ['primary', 'yours'], name: 'Home', color: '#000' },
  { calendarId: 'native:dana-cal', labels: ['spouse'], name: 'Shared', color: '#111' },
];

// ---- Fakes ----

/** Gemini: each call takes the next scripted answer (model JSON, or an Error to throw). */
let geminiAnswers: Array<object | Error> = [];
let geminiPrompts: string[] = [];
const fakeGemini = {
  models: {
    generateContent: async (request: { contents: Array<{ parts: Array<{ text?: string }> }> }) => {
      geminiPrompts.push(request.contents[0].parts.map(p => p.text ?? '').join(''));
      const answer = geminiAnswers.shift();
      if (!answer) throw new Error('no scripted Gemini answer left');
      if (answer instanceof Error) throw answer;
      return { text: JSON.stringify(answer), usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } };
    },
  },
};

type Sent = { chatId: number | string; text: string; format?: string };
let sent: Sent[] = [];
let deleted: Array<number | string> = [];
let nextMessageId = 900;
const fakeService = {
  sendMessage: async (chatId: number | string, text: string, options?: { format?: string }) => {
    sent.push({ chatId, text, format: options?.format });
    return nextMessageId++;
  },
  deleteMessage: async (_chatId: number | string, messageId: number | string) => {
    deleted.push(messageId);
  },
  updateMessage: async () => {},
  sendTypingIndicator: async () => {},
};

type Card = { chatId: number; messageId: number | undefined; event: ParsedEvent; transcription: string; user: UserConfig; inputModality: string };
let cards: Card[] = [];
let bulkCards: Array<{ chatId: number | string; intents: VoiceIntentResult[]; transcription: string }> = [];
let changeFlows: Array<{ kind: 'edit' | 'delete'; chatId: number; messageId: number | undefined; result: VoiceIntentResult; transcription: string }> = [];
let pairAccepts: string[] = [];
let commands: string[] = [];
let supportChecks: number[] = [];
let resolveCalls: ParsedEvent[] = [];
let resolveOptions: Array<{ selfOnly?: boolean } | undefined> = [];
type Failure = { error: 'anchor_not_found' | 'anchor_ambiguous' | 'anchor_needs_time'; description: string };
/** sendAnchorQuestions calls, with how many cards were already shown at the time. */
let anchorCalls: Array<{ chatId: number | string; failures: Failure[]; language: string; service: unknown; cardsBefore: number }> = [];
let captured: string[] = [];
const locks = new Set<string>();

/**
 * Task 11's resolveReminderIntents as the typed route sees it. Each reminder create gets the
 * main calendar, the partner when asked for (and not selfOnly), its parsed time with end =
 * start, and "no time set" when date-only; an anchor is never found. Like the real one, it
 * resolves only `kind === 'reminder'` creates, swaps a failed one for an error intent with
 * no event, and passes every other intent through untouched.
 */
const fakeResolveIntents = async (
  _user: UserConfig, intents: VoiceIntentResult[], _timezone: string, options?: { selfOnly?: boolean }
) => {
  resolveOptions.push(options);
  const failures: Failure[] = [];
  const resolved = intents.map((intent): VoiceIntentResult => {
    const event = intent.event;
    if (intent.intent !== 'create' || event?.kind !== 'reminder') return intent;
    resolveCalls.push(event);
    if (event.anchor) {
      failures.push({ error: 'anchor_not_found', description: event.anchor.description });
      return { intent: 'create', confidence: intent.confidence, error: 'anchor_not_found' };
    }
    const forPartner = event.forPerson === 'partner' && !options?.selfOnly;
    return {
      ...intent,
      event: {
        ...event,
        calendarId: 'native:raziel-cal',
        calendarName: undefined,
        endTime: event.startTime,
        anchor: undefined,
        forUserId: forPartner ? DANA.id : null,
        forName: forPartner ? DANA.name : undefined,
        reminderNotice: event.allDay ? 'no_time_set' : undefined,
      },
    };
  });
  return { intents: resolved, failures };
};

/** Task 11's reminderPromptContext: Raziel and Dana, unless the caller leaves the partner out. */
const fakePromptContext = async (user: UserConfig, options?: { withPartner?: boolean }) => {
  const partner = user.id === 1 && options?.withPartner !== false ? DANA : null;
  return {
    userName: user.name,
    userEnglishName: user.englishName || null,
    partnerName: partner?.name ?? null,
    partnerEnglishName: partner?.englishName ?? null,
  };
};

const SRC = path.resolve(__dirname, '../src');
const noop = () => {};
const asyncNoop = async () => {};

/** Modules replaced by fakes, by file path. */
const stubs: Record<string, object> = {
  [`${SRC}/services/ai-provider.ts`]: {
    getGemini: () => fakeGemini,
    extractionConfig: () => ({}),
    generateAICompletion: async () => { throw new Error('no AI completion in this test'); },
    streamAICompletion: async () => { throw new Error('no AI stream in this test'); },
  },
  [`${SRC}/utils/redis.ts`]: { redis: { get: async () => null, set: async () => 'OK', del: async () => 0 } },
  [`${SRC}/utils/redis-lock.ts`]: {
    acquireVoiceLock: async (key: string) => (locks.has(key) ? false : (locks.add(key), true)),
    releaseVoiceLock: async (key: string) => { locks.delete(key); },
  },
  [`${SRC}/utils/prisma.ts`]: {
    prisma: new Proxy({}, { get: (_t, model) => { throw new Error(`the database was read (${String(model)})`); } }),
  },
  [`${SRC}/lib/error-capture.ts`]: {
    captureError: (_err: unknown, context: string) => { captured.push(context); },
    captureWarning: noop,
    captureInfo: noop,
  },
  [`${SRC}/lib/user-moderation.ts`]: { isIdentifierBlocked: async () => false, isUserSuspended: () => false },
  [`${SRC}/lib/timezone.ts`]: { resolveUserTimezone: async () => IL },
  [`${SRC}/services/analytics-service.ts`]: { setUserContext: noop, addBreadcrumb: noop, trackActivityAsync: noop, trackActivity: asyncNoop },
  [`${SRC}/services/payment-handler.ts`]: { handlePreCheckoutQuery: asyncNoop, handleSuccessfulPayment: asyncNoop },
  [`${SRC}/services/user-service.ts`]: {
    getUserByTelegramId: async (telegramId: number) => USERS[Number(telegramId)] ?? null,
    getOrCreateUser: async (telegramId: number) => USERS[Number(telegramId)],
    getUserByWhatsAppPhone: async () => null,
    getOrCreateUserByWhatsApp: async () => null,
  },
  [`${SRC}/services/telegram/index.ts`]: {
    getBot: () => ({}),
    getMessagingService: () => fakeService,
    handleStartCommand: async () => { commands.push('/start'); },
    handleSummaryCommand: async () => { commands.push('/summary'); },
    handleWeatherCommand: async () => { commands.push('/weather'); },
    handleFeedbackCommand: async () => { commands.push('/feedback'); },
    handleConnectCommand: async () => { commands.push('/connect'); },
  },
  [`${SRC}/services/telegram/pair-handler.ts`]: {
    parseAcceptCommand: (text: string) => text.trim().match(/^\/?accept\s+([a-fA-F0-9]{16,})\s*$/)?.[1] ?? null,
    handlePairAccept: async (_chatId: number, _userId: number, token: string) => { pairAccepts.push(token); },
  },
  [`${SRC}/services/voice/index.ts`]: {
    handleVoiceMessage: asyncNoop,
    handleEventCallback: asyncNoop,
    handleEditCallback: asyncNoop,
    handleDeleteCallback: asyncNoop,
    handleEditIntent: async (chatId: number, messageId: number | undefined, result: VoiceIntentResult, transcription: string) => {
      changeFlows.push({ kind: 'edit', chatId, messageId, result, transcription });
    },
    handleDeleteIntent: async (chatId: number, messageId: number | undefined, result: VoiceIntentResult, transcription: string) => {
      changeFlows.push({ kind: 'delete', chatId, messageId, result, transcription });
    },
  },
  [`${SRC}/services/voice/quick-correction.ts`]: { getQuickCorrection: async () => null, clearQuickCorrection: asyncNoop, extractFieldPatch: async () => null },
  [`${SRC}/services/voice/confirmations.ts`]: {
    escapeHtml: (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    showEventConfirmation: async (
      chatId: number, messageId: number | undefined, event: ParsedEvent, transcription: string, user: UserConfig,
      _adminFooter: string | undefined, inputModality: string
    ) => { cards.push({ chatId, messageId, event, transcription, user, inputModality }); },
    sendAnchorQuestions: async (chatId: number | string, failures: Failure[], language: string, service: unknown) => {
      anchorCalls.push({ chatId, failures, language, service, cardsBefore: cards.length + bulkCards.length });
    },
  },
  [`${SRC}/services/voice/bulk-confirmations.ts`]: {
    showBulkConfirmation: async (chatId: number | string, intents: VoiceIntentResult[], _user: UserConfig, transcription: string) => {
      bulkCards.push({ chatId, intents, transcription });
      return 'bulk:1';
    },
  },
  [`${SRC}/services/calendar-provider/index.ts`]: {
    hasUsableCalendar: async () => true,
    getCalendarAssignmentsForUser: async () => CALENDARS,
  },
  [`${SRC}/services/native-reminders/support.ts`]: {
    getReminderSupport: async (user: UserConfig) => {
      supportChecks.push(user.id);
      // The Google user here has no reminders by plan (a Google user may have them now: they live in FamCal)
      if (user.calendarSource !== 'NATIVE') return { supported: false, reason: 'no_access' };
      if (user.id === 4) return { supported: false, reason: 'no_access' };
      return { supported: true };
    },
  },
  [`${SRC}/services/native-reminders/resolve.ts`]: {
    resolveReminderIntents: fakeResolveIntents,
    reminderPromptContext: fakePromptContext,
  },
};

// Static imports compile to require() and pass through Module._load.
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

// The webhook and the typed route load some modules with import(), which goes through the
// ES module loader instead; it gets the same fake, served as an ES module.
(globalThis as { smokeStubs?: typeof stubs }).smokeStubs = stubs;
Module.registerHooks({
  load(url, context, nextLoad) {
    const file = url.startsWith('file:') ? fileURLToPath(url) : '';
    const stub = stubs[file];
    if (!stub) return nextLoad(url, context);
    const names = Object.keys(stub).map(name => `export const ${name} = fake.${name};`).join('\n');
    return { format: 'module', shortCircuit: true, source: `const fake = globalThis.smokeStubs[${JSON.stringify(file)}];\n${names}\n` };
  },
});

// ---- Scenario helpers ----

function reset() {
  geminiAnswers = [];
  geminiPrompts = [];
  sent = [];
  deleted = [];
  cards = [];
  bulkCards = [];
  changeFlows = [];
  pairAccepts = [];
  commands = [];
  supportChecks = [];
  resolveCalls = [];
  resolveOptions = [];
  anchorCalls = [];
  captured = [];
}

/** Every reminder the route asked about, across its sendAnchorQuestions calls. */
const askedAbout = () => anchorCalls.flatMap(c => c.failures);

let nextUpdateId = 1;
let nextUserMessageId = 1;

/** A private-chat text message, as Telegram posts it to the webhook. */
function textUpdate(fromId: number, text: string, messageId = nextUserMessageId++) {
  return {
    update_id: nextUpdateId++,
    message: { message_id: messageId, date: 0, text, from: { id: fromId, first_name: 'Raziel' }, chat: { id: fromId, type: 'private' } },
  };
}

/** Runs `fn` with the services' logs silenced. */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const { log, warn, error } = console;
  console.log = noop;
  console.warn = noop;
  console.error = noop;
  try {
    return await fn();
  } finally {
    Object.assign(console, { log, warn, error });
  }
}

/** Posts one update to the real webhook; returns the HTTP status it answered. */
async function deliver(update: object): Promise<number> {
  const { handleTelegramWebhook } = await import('../src/services/webhook-handlers');
  let status = 0;
  await quietly(() => handleTelegramWebhook({ body: update }, { status: code => { status = code; return { json: noop }; } }));
  return status;
}

/** Model JSON for one create, as the text prompt asks for it. */
function createAnswer(event: Record<string, unknown>) {
  return { intent: 'create', confidence: 'high', event: { calendarId: 'native:dana-cal', calendarName: 'Shared', allDay: false, recurrence: null, ...event } };
}

const at = (local: string) => fromZonedTime(local, IL);
const iso = (d: Date | undefined) => (d && !isNaN(d.getTime()) ? d.toISOString() : String(d));

/** Nothing reached the user, the model or the cards. */
function assertUntouched() {
  assert(geminiPrompts.length === 0, `Gemini was called ${geminiPrompts.length} time(s)`);
  assert(sent.length === 0, `sent ${JSON.stringify(sent.map(s => s.text))}`);
  assert(cards.length === 0 && bulkCards.length === 0 && changeFlows.length === 0, 'a card or flow was shown');
  assert(anchorCalls.length === 0, 'the anchor questions were reached');
}

async function main() {
  const { hasReminderKeyword, asTypedReminder } = await import('../src/services/native-reminders/typed-route');
  const { processTextWithGemini } = await import('../src/services/forward-event/gemini-text');
  const { getBotMessage } = await import('../src/lib/bot-messages');
  const copy = (locale: string, key: string, params?: Record<string, string>) => getBotMessage(locale, `nativeReminders.${key}`, params);

  // ---- The keyword filter ----

  await check('keywords: English, Hebrew and Russian phrasings match, whatever the case', () => {
    const positives = [
      'Remind me to call the plumber Thursday at 10',
      'REMINDER: pay the electricity bill',
      "don't forget the milk",
      'Dont forget to call grandma',
      'Don’t forget to water the plants', // the curly apostrophe phone keyboards type
      'תזכיר לי להתקשר לאינסטלטור מחר',
      'תזכירי לדנה לקנות חלב',
      'תזכורת: לשלם ארנונה',
      'תמחק את כל התזכורות של מחר',
      'אפשר להזכיר לי בערב?',
      'אל תשכח לקנות לחם',
      'אל תשכחי את המפתחות',
      'Напомни мне позвонить маме завтра в 5',
      'напоминание: оплатить интернет',
      'Не забудь купить молоко',
      'reminderless', // the substring rule is accepted (spec §3.1)
    ];
    const missed = positives.filter(text => !hasReminderKeyword(text));
    assert(missed.length === 0, `not matched: ${JSON.stringify(missed)}`);
  });

  await check('keywords: the example an unplaced anchor suggests sending is itself typed-reminder text, in every language', async () => {
    const missed: string[] = [];
    for (const locale of ['en', 'he', 'ru']) {
      for (const key of ['notFound', 'ambiguous', 'needsTime']) {
        const text = await copy(locale, `anchor.${key}`, { description: 'dentist' });
        // The last quoted phrase is the example: “…”, "…" or «…»
        const example = [...text.matchAll(/[“"«]([^“”"«»]+)[”"»]/g)].pop()?.[1] ?? '';
        if (!example.includes('16:00') || !hasReminderKeyword(example)) missed.push(`${locale}:${key} → ${example || text}`);
      }
    }
    assert(missed.length === 0, missed.join('\n     '));
  });

  await check('keywords: ordinary chat does not match', () => {
    const negatives = ['hello', 'Can you remember the milk?', 'forget it', 'what time is the dentist?', 'מה נשמע', 'שכחתי', 'привет', 'я забыл', ''];
    const matched = negatives.filter(text => hasReminderKeyword(text));
    assert(matched.length === 0, `matched: ${JSON.stringify(matched)}`);
  });

  // ---- Coercion ----

  await check('coercion: a create read as an event becomes a zero-length reminder; edits pass through', () => {
    const start = at('2026-10-15T17:00:00');
    const created: VoiceIntentResult = {
      intent: 'create', confidence: 'high',
      // An event carries no kind (Task 10 sets it only on reminders)
      event: { title: 'Dentist', startTime: start, endTime: at('2026-10-15T18:00:00'), allDay: false, confidence: 'high' },
    };
    const coerced = asTypedReminder(created);
    assert(coerced.event?.kind === 'reminder', `kind ${coerced.event?.kind}`);
    assert(iso(coerced.event?.endTime) === iso(start) && iso(coerced.event?.startTime) === iso(start), `${iso(coerced.event?.startTime)} - ${iso(coerced.event?.endTime)}`);
    assert(created.event?.kind === undefined && iso(created.event?.endTime) === iso(at('2026-10-15T18:00:00')), 'the input was changed');
    const edit: VoiceIntentResult = { intent: 'edit', confidence: 'high', eventReference: { type: 'by_description', description: 'dentist' } };
    assert(asTypedReminder(edit) === edit, 'an edit was rewritten');
  });

  // ---- Text extraction marks typed text ----

  await check('extraction: forwarded text keeps its exact header; typed text says it was typed by the user', async () => {
    reset();
    geminiAnswers = [{ intent: 'none' }, { intent: 'none' }];
    await quietly(() => processTextWithGemini('dinner Friday at 7', 'en', [], IL));
    await quietly(() => processTextWithGemini('remind me to call mom', 'en', [], IL, { userName: 'Raziel' }, 'typed'));
    const [forwarded, typed] = geminiPrompts;
    assert(forwarded.endsWith('\n\nFORWARDED MESSAGE:\ndinner Friday at 7'), `forwarded ends ${JSON.stringify(forwarded.slice(-60))}`);
    assert(!forwarded.includes('TYPED MESSAGE'), 'the forwarded prompt mentions typed text');
    assert(/\n\nTYPED MESSAGE \(the user typed this to you directly[^\n]*\):\nremind me to call mom$/.test(typed), `typed ends ${JSON.stringify(typed.slice(-160))}`);
    assert(!typed.includes('FORWARDED MESSAGE:'), 'the typed prompt calls itself forwarded');
  });

  // ---- The webhook: who goes to the typed route ----

  await check('webhook: a supported user typing a reminder gets "On it…", then a reminder card', async () => {
    reset();
    geminiAnswers = [createAnswer({ title: 'Call mom', startDate: '2026-10-15', startTime: '17:00', kind: 'reminder', forPerson: 'self' })];
    const text = 'Remind me to call mom tomorrow at 17:00';
    const status = await deliver(textUpdate(RAZIEL, text));
    assert(status === 200, `status ${status}`);
    assert(sent[0]?.text === (await copy('en', 'typed.processing')) && sent[0].chatId === RAZIEL, `first message ${JSON.stringify(sent[0])}`);
    assert(deleted.length === 1 && deleted[0] === 900, `deleted ${JSON.stringify(deleted)}`);
    assert(sent.length === 1, `also sent ${JSON.stringify(sent.slice(1).map(s => s.text))}`);
    assert(cards.length === 1, `${cards.length} cards`);
    const card = cards[0];
    assert(card.chatId === RAZIEL && card.messageId === undefined, `card at ${card.chatId}/${card.messageId}`);
    assert(card.transcription === text && card.inputModality === 'text', `card from ${card.inputModality}: ${card.transcription}`);
    assert(card.event.kind === 'reminder', `kind ${card.event.kind}`);
    assert(iso(card.event.startTime) === iso(at('2026-10-15T17:00:00')) && iso(card.event.endTime) === iso(card.event.startTime),
      `${iso(card.event.startTime)} - ${iso(card.event.endTime)}`);
    assert(card.event.calendarId === 'native:raziel-cal' && card.event.calendarName === undefined,
      `calendar ${card.event.calendarId} / ${card.event.calendarName}`);
    assert(card.event.forUserId === null && card.event.forName === undefined && card.event.reminderNotice === undefined,
      `for ${card.event.forUserId} (${card.event.forName}), notice ${card.event.reminderNotice}`);
    assert(askedAbout().length === 0, `asked about ${JSON.stringify(askedAbout())}`);
    assert(geminiPrompts.length === 1 && geminiPrompts[0].includes('TYPED MESSAGE (') && geminiPrompts[0].endsWith(text), 'not extracted as typed text');
    assert(liveIntervals.size === 0, `${liveIntervals.size} typing interval(s) still running`);
  });

  await check('webhook: the prompt carries the user and the partner, and the card says who it is for', async () => {
    reset();
    geminiAnswers = [createAnswer({ title: 'Buy milk', startDate: '2026-10-15', startTime: '09:00', kind: 'reminder', forPerson: 'partner' })];
    await deliver(textUpdate(RAZIEL, 'remind Dana to buy milk tomorrow morning'));
    // Only the rules above the message count: the message itself says "Dana".
    const rules = (geminiPrompts[0] ?? '').split('TYPED MESSAGE (')[0];
    assert(rules.includes('Raziel') && rules.includes('Dana'), 'the prompt lacks the names');
    assert(resolveCalls[0]?.forPerson === 'partner', `resolved for ${resolveCalls[0]?.forPerson}`);
    // Typed text is the user's own words: "remind Dana" may be for the partner
    assert(resolveOptions.length === 1 && !resolveOptions[0]?.selfOnly, `resolved with ${JSON.stringify(resolveOptions)}`);
    // forName is what the card's "for Dana" and the "I'll remind Dana" reply read
    const event = cards[0]?.event;
    assert(event?.forUserId === DANA.id && event.forName === 'Dana', `card for ${event?.forUserId} (${event?.forName})`);
  });

  await check('webhook: a Google user typing "remind me" is ignored as before', async () => {
    reset();
    const status = await deliver(textUpdate(GOOGLE, 'remind me to call mom at 5'));
    assert(status === 200, `status ${status}`);
    assertUntouched();
  });

  await check('webhook: a NATIVE user without the reminders feature is ignored as before', async () => {
    reset();
    await deliver(textUpdate(NO_ACCESS, 'remind me to call mom at 5'));
    assert(supportChecks.includes(4), 'support was not checked');
    assertUntouched();
  });

  await check('webhook: text with no keyword is ignored without a support check', async () => {
    reset();
    await deliver(textUpdate(RAZIEL, 'hello there'));
    assert(supportChecks.length === 0, `support checked for ${supportChecks.join(', ')}`);
    assertUntouched();
  });

  await check('webhook: an unregistered sender and an unknown command are ignored', async () => {
    reset();
    await deliver(textUpdate(STRANGER, 'remind me to call mom at 5'));
    await deliver(textUpdate(RAZIEL, '/remind me to call mom at 5'));
    assert(supportChecks.length === 0, `support checked for ${supportChecks.join(', ')}`);
    assertUntouched();
  });

  await check('webhook: "accept <token>" and commands still take their own branches', async () => {
    reset();
    await deliver(textUpdate(RAZIEL, 'accept 0123456789abcdef'));
    await deliver(textUpdate(RAZIEL, '/summary remind me'));
    assert(pairAccepts.join() === '0123456789abcdef', `pair accepts ${JSON.stringify(pairAccepts)}`);
    assert(commands.join() === '/summary', `commands ${JSON.stringify(commands)}`);
    assertUntouched();
  });

  await check('webhook: a redelivered update is handled once', async () => {
    reset();
    geminiAnswers = [createAnswer({ title: 'Call mom', startDate: '2026-10-15', startTime: '17:00', kind: 'reminder' })];
    const update = textUpdate(RAZIEL, 'remind me to call mom tomorrow at 17:00');
    await deliver(update);
    await deliver(update);
    assert(geminiPrompts.length === 1, `extracted ${geminiPrompts.length} times`);
    assert(cards.length === 1 && sent.length === 1, `${cards.length} cards, ${sent.length} messages`);
  });

  // ---- The typed route: what the extraction becomes ----

  await check('typed: a create the model read as an event still becomes a reminder card', async () => {
    reset();
    geminiAnswers = [createAnswer({ title: 'Parent-teacher meeting', startDate: '2026-10-20', startTime: '16:30', endDate: '2026-10-20', endTime: '17:30', kind: 'event' })];
    await deliver(textUpdate(RAZIEL, "Don't forget the parent-teacher meeting Tuesday at 16:30"));
    assert(resolveCalls[0]?.kind === 'reminder', `resolved a ${resolveCalls[0]?.kind}`);
    const event = cards[0]?.event;
    assert(event?.kind === 'reminder', `card kind ${event?.kind}`);
    assert(iso(event.startTime) === iso(at('2026-10-20T16:30:00')) && iso(event.endTime) === iso(event.startTime),
      `${iso(event.startTime)} - ${iso(event.endTime)}`);
  });

  await check('typed: a date-only reminder carries the resolution notice to the card', async () => {
    reset();
    geminiAnswers = [createAnswer({ title: 'Pay the bill', startDate: '2026-10-15', allDay: true, kind: 'reminder' })];
    await deliver(textUpdate(RAZIEL, 'remind me to pay the bill tomorrow'));
    const event = cards[0]?.event;
    assert(event?.allDay === true && event.reminderNotice === 'no_time_set', `allDay ${event?.allDay}, notice ${event?.reminderNotice}`);
  });

  await check('typed: two reminders in one message get the bulk card, both as reminders', async () => {
    reset();
    geminiAnswers = [{
      intents: [
        createAnswer({ title: 'Call mom', startDate: '2026-10-15', startTime: '17:00', kind: 'reminder' }),
        createAnswer({ title: 'Buy bread', startDate: '2026-10-15', startTime: '19:00', endDate: '2026-10-15', endTime: '20:00', kind: 'event' }),
      ],
    }];
    const text = 'remind me to call mom at 17:00 and to buy bread at 19:00 tomorrow';
    await deliver(textUpdate(RAZIEL, text));
    assert(cards.length === 0 && bulkCards.length === 1, `${cards.length} cards, ${bulkCards.length} bulk cards`);
    const bulk = bulkCards[0];
    assert(bulk.transcription === text && bulk.intents.length === 2, `${bulk.intents.length} intents`);
    for (const intent of bulk.intents) {
      const e = intent.event;
      assert(e?.kind === 'reminder' && iso(e.endTime) === iso(e.startTime) && e.calendarId === 'native:raziel-cal',
        `${e?.title}: ${e?.kind} ${iso(e?.startTime)} - ${iso(e?.endTime)} on ${e?.calendarId}`);
    }
  });

  await check('typed: an anchor that is not found gets only the question: no card, no "not understood"', async () => {
    reset();
    const description = 'dentist <Dr. Cohen & co>';
    geminiAnswers = [createAnswer({ title: 'Leave for the dentist', kind: 'reminder', anchor: { description, offsetMinutes: -60 } })];
    await deliver(textUpdate(RAZIEL, 'remind me an hour before the dentist <Dr. Cohen & co>'));
    assert(cards.length === 0 && bulkCards.length === 0, 'a card was shown');
    const asked = anchorCalls.filter(c => c.failures.length > 0);
    assert(asked.length === 1, `${asked.length} anchor question call(s)`);
    assert(asked[0].chatId === RAZIEL && asked[0].language === 'en' && asked[0].service === fakeService,
      `asked at ${asked[0].chatId} in ${asked[0].language}`);
    // The description goes over as typed; Task 11's sendAnchorQuestions escapes it for HTML.
    assert(JSON.stringify(asked[0].failures) === JSON.stringify([{ error: 'anchor_not_found', description }]),
      `asked about ${JSON.stringify(asked[0].failures)}`);
    // Only "On it…" was sent, and it went
    assert(sent.length === 1 && deleted.length === 1, `sent ${JSON.stringify(sent.map(s => s.text))}, deleted ${deleted.length}`);
  });

  await check('typed: a reminder next to an anchor that is not found gets its card, then the question', async () => {
    reset();
    geminiAnswers = [{
      intents: [
        createAnswer({ title: 'Call mom', startDate: '2026-10-15', startTime: '17:00', kind: 'reminder' }),
        createAnswer({ title: 'Leave for the dentist', kind: 'reminder', anchor: { description: 'dentist', offsetMinutes: -60 } }),
      ],
    }];
    await deliver(textUpdate(RAZIEL, 'remind me to call mom tomorrow at 17:00, and an hour before the dentist'));
    assert(cards.length === 1 && bulkCards.length === 0 && cards[0].event.title === 'Call mom',
      `${cards.length} cards (${cards.map(c => c.event.title).join(', ')}), ${bulkCards.length} bulk cards`);
    const asked = anchorCalls.filter(c => c.failures.length > 0);
    assert(asked.length === 1 && JSON.stringify(asked[0].failures) === JSON.stringify([{ error: 'anchor_not_found', description: 'dentist' }]),
      `asked about ${JSON.stringify(askedAbout())}`);
    assert(asked[0].cardsBefore === 1, 'the question came before the card');
    assert(sent.length === 1, `also sent ${JSON.stringify(sent.slice(1).map(s => s.text))}`);
  });

  await check('typed: "move the reminder…" goes to the edit flow with the typed text', async () => {
    reset();
    const edit = { intent: 'edit', confidence: 'high', eventReference: { type: 'by_description', description: 'call mom' }, editRequest: { newStartTime: '18:00' } };
    geminiAnswers = [edit];
    const text = 'move the call mom reminder to 18:00';
    await deliver(textUpdate(RAZIEL, text));
    assert(changeFlows.length === 1 && changeFlows[0].kind === 'edit', `flows ${JSON.stringify(changeFlows.map(f => f.kind))}`);
    const flow = changeFlows[0];
    assert(flow.chatId === RAZIEL && flow.messageId === undefined && flow.transcription === text, `edit at ${flow.chatId}/${flow.messageId}: ${flow.transcription}`);
    assert(flow.result.editRequest?.newStartTime === '18:00' && flow.result.eventReference?.description === 'call mom', 'the edit request was lost');
    assert(cards.length === 0 && resolveCalls.length === 0, 'an edit was treated as a create');
  });

  await check('typed: "stop reminding me…" goes to the delete flow with its scope', async () => {
    reset();
    geminiAnswers = [{ intent: 'delete', confidence: 'high', scope: 'all', eventReference: { type: 'by_description', description: 'water the plants' } }];
    await deliver(textUpdate(RAZIEL, 'stop reminding me to water the plants'));
    assert(changeFlows.length === 1 && changeFlows[0].kind === 'delete' && changeFlows[0].result.scope === 'all',
      `flows ${JSON.stringify(changeFlows.map(f => [f.kind, f.result.scope]))}`);
  });

  await check('typed: nothing usable gets the typed "not understood" copy', async () => {
    reset();
    geminiAnswers = [{ intent: 'none', confidence: 'high', error: 'No calendar event information found in this message.' }];
    await deliver(textUpdate(RAZIEL, 'I did the reminder thing already'));
    assert(cards.length === 0 && changeFlows.length === 0, 'a card or flow was shown');
    assert(sent.at(-1)?.text === (await copy('en', 'typed.notUnderstood')), `last message ${JSON.stringify(sent.at(-1)?.text)}`);
    assert(deleted.length === 1, 'the "On it…" message stayed');
  });

  await check('typed: an extraction failure answers "not understood", reports it and stops typing', async () => {
    reset();
    geminiAnswers = [new Error('503 overloaded'), new Error('503 overloaded')];
    const status = await deliver(textUpdate(RAZIEL, 'remind me to call mom'));
    assert(status === 200, `status ${status}`);
    assert(sent.at(-1)?.text === (await copy('en', 'typed.notUnderstood')), `last message ${JSON.stringify(sent.at(-1)?.text)}`);
    assert(captured.includes('native-reminders-typed'), `captured ${JSON.stringify(captured)}`);
    assert(deleted.length === 1, 'the "On it…" message stayed');
    assert(liveIntervals.size === 0, `${liveIntervals.size} typing interval(s) still running`);
  });

  await check('typed: a Hebrew user gets Hebrew copy and a card', async () => {
    reset();
    geminiAnswers = [createAnswer({ title: 'לקנות חלב', startDate: '2026-10-15', startTime: '09:00', kind: 'reminder' })];
    await deliver(textUpdate(NOA, 'תזכיר לי לקנות חלב מחר בבוקר'));
    assert(sent[0]?.text === (await copy('he', 'typed.processing')) && sent[0].text !== (await copy('en', 'typed.processing')),
      `first message ${JSON.stringify(sent[0]?.text)}`);
    assert(cards.length === 1 && cards[0].event.title === 'לקנות חלב', `${cards.length} cards`);
  });

  await check('no network was reached', () => {
    assert(networkAttempts.length === 0, `fetched ${networkAttempts.join(', ')}`);
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

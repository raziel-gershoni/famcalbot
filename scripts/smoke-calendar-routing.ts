// Smoke test for "Google becomes a connection", Task G2: providers by calendar id
// (docs/superpowers/specs/2026-10-19-google-connection-design.md §3, §4 Providers and Gates).
//
// What it pins, on the bot's real paths (Telegram card, "Confirm all", auto-create and its
// Undo, WhatsApp auto-create, bulk and card; the edit and delete confirmations):
//  - every write goes to the provider of its calendar id (`native:` to FamCal, the rest to
//    Google), never to the provider of the user's legacy calendarSource;
//  - an event nothing placed goes to the default calendar (defaultCalendarFor), and the
//    literal 'primary' is never sent; a reminder always goes on the creator's FamCal main;
//  - the "not connected" stop checks the token only for a Google target, and the "You can't
//    change this one" copy is picked by the target's provider;
//  - a Hebrew repeat is worded and created for its own target;
//  - a voice edit whose search could not read Google says so instead of "not found".
//
// Telegram, WhatsApp, Redis, Prisma, the AI, the user's calendars and both providers are
// faked (the providers at their own modules, so the real routing picks them); the clock is set
// by hand. No network.
//
// Run with the fake env runner, under both clocks:
//   bash run-smoke.sh scripts/smoke-calendar-routing.ts UTC
//   bash run-smoke.sh scripts/smoke-calendar-routing.ts Asia/Jerusalem

import Module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromZonedTime } from 'date-fns-tz';
import type { CalendarAssignment, CalendarEvent, UserConfig } from '../src/types';
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

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

function assertEqual(got: unknown, want: unknown, label = 'value') {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  assert(a === b, `${label}: got ${a}, want ${b}`);
}

globalThis.fetch = (async (input: unknown) => {
  throw new Error(`network blocked in smoke: ${String(input)}`);
}) as typeof fetch;

// ---- Clock ----

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
const at = (local: string) => fromZonedTime(local, IL);
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

const flags = { autoCreate: false, reminders: false };
/** The event matcher's answer to a prompt. */
let matcherAnswer: (prompt: string) => string = () => '{"matched":false}';
let captured: string[] = [];

// Users. Dana (1): FamCal, no token. Nava (2): FamCal with Google connected. Gil (3): legacy
// Google (calendarSource GOOGLE), FamCal main made lazily, a Google primary. Hila (4): legacy
// Google with no primary label. Omri (5): legacy Google whose token was cleared.
const famcalRow = (userId: number, labels: CalendarAssignment['labels'] = ['yours']): CalendarAssignment =>
  ({ calendarId: `native:main-${userId}`, labels, name: `FamCal ${userId}`, color: '#000000' });
const googleRow = (calendarId: string, labels: CalendarAssignment['labels']): CalendarAssignment =>
  ({ calendarId, labels, name: calendarId, color: '#4285F4' });
const UNION: Record<number, CalendarAssignment[]> = {
  1: [famcalRow(1, ['primary', 'yours'])],
  2: [famcalRow(2, ['primary', 'yours']), googleRow('nava@gmail.com', ['yours'])],
  3: [famcalRow(3), googleRow('gil@gmail.com', ['primary', 'yours']), googleRow('kids3@group.calendar.google.com', ['kids'])],
  4: [famcalRow(4), googleRow('kids4@group.calendar.google.com', ['kids']), googleRow('hila@gmail.com', ['yours'])],
  5: [famcalRow(5), googleRow('omri@gmail.com', ['primary', 'yours'])],
};
const person = (id: number, over: Record<string, unknown>) => ({
  id, name: `User ${id}`, englishName: `User ${id}`, language: 'en', telegramId: 1000 + id, calendarSource: 'NATIVE',
  pairingId: null, isAdmin: false, voiceInputEnabled: true, googleRefreshToken: '', calendarAssignments: null, ...over,
}) as unknown as UserConfig;
const DANA = person(1, {});
const NAVA = person(2, { googleRefreshToken: 'token', calendarAssignments: UNION[2].slice(1) });
const GIL = person(3, { calendarSource: 'GOOGLE', googleRefreshToken: 'token', calendarAssignments: UNION[3].slice(1) });
const HILA = person(4, { calendarSource: 'GOOGLE', googleRefreshToken: 'token', calendarAssignments: UNION[4].slice(1) });
const OMRI = person(5, { calendarSource: 'GOOGLE', googleRefreshToken: '', calendarAssignments: UNION[5].slice(1) });
let currentUser: UserConfig = DANA;

type Write = { provider: string; op: string; calendarId: string; eventId?: string; input?: Record<string, unknown> };
let writes: Write[] = [];
/** The next answer each provider gives a write, unless it succeeds. */
const failures: Record<string, { error: string } | undefined> = { native: undefined, google: undefined };
/** What each provider's fetch does: events, or a throw. */
const fetches: Record<string, (start: Date, end: Date) => Promise<CalendarEvent[]>> = { native: async () => [], google: async () => [] };
const fetchCalls: Array<{ provider: string; ids: string[] }> = [];
const providerFor = (name: 'native' | 'google') => ({
  name,
  fetchEventsInRange: async (_user: unknown, ids: string[], start: Date, end: Date) => {
    fetchCalls.push({ provider: name, ids });
    return fetches[name](start, end);
  },
  createEvent: async (_user: unknown, calendarId: string, input: Record<string, unknown>) => {
    writes.push({ provider: name, op: 'create', calendarId, input });
    const fail = failures[name];
    return fail ? { success: false, ...fail } : { success: true, eventId: `ev${writes.length}` };
  },
  updateEvent: async (_user: unknown, calendarId: string, eventId: string) => {
    writes.push({ provider: name, op: 'update', calendarId, eventId });
    const fail = failures[name];
    return fail ? { success: false, ...fail } : { success: true };
  },
  deleteEvent: async (_user: unknown, calendarId: string, eventId: string) => {
    writes.push({ provider: name, op: 'delete', calendarId, eventId });
    const fail = failures[name];
    return fail ? { success: false, ...fail } : { success: true };
  },
  listCalendars: async () => [],
  moveEvent: async () => ({ success: true }),
});
const fakeNative = providerFor('native');
const fakeGoogle = providerFor('google');

let extracted: VoiceIntentResult[] = [];
async function fakeVoiceExtraction() {
  return {
    intentResult: extracted[0], intentResults: extracted, transcription: 'something',
    metrics: { model: 'fake', inputTokens: 0, outputTokens: 0, durationMs: 0 },
  };
}

function reset() {
  clock = at(NOW).getTime();
  store.clear();
  botCalls = [];
  serviceCalls = [];
  waCalls = [];
  writes = [];
  captured = [];
  fetchCalls.length = 0;
  failures.native = undefined;
  failures.google = undefined;
  fetches.native = async () => [];
  fetches.google = async () => [];
  extracted = [];
  flags.autoCreate = false;
  flags.reminders = false;
  matcherAnswer = () => '{"matched":false}';
  currentUser = DANA;
}

// ---- Module fakes ----

const SRC = path.resolve(__dirname, '../src');

const fakeOver = (real: Record<string, unknown>, fakes: Record<string, unknown>) =>
  new Proxy(real, { get: (target, key) => (typeof key === 'string' && key in fakes ? fakes[key] : Reflect.get(target, key)) });

const stubs: Record<string, object | ((real: Record<string, unknown>) => object)> = {
  '@googleapis/calendar': { calendar: () => ({}), auth: { OAuth2: class {} } },
  [`${SRC}/utils/redis.ts`]: { redis: fakeRedis },
  [`${SRC}/utils/prisma.ts`]: { prisma: {}, withRetry: (fn: () => unknown) => fn() },
  [`${SRC}/lib/error-capture.ts`]: {
    captureError: (e: unknown, ctx: string) => { captured.push(`${ctx}: ${e instanceof Error ? e.message : String(e)}`); },
    captureWarning: (m: string, ctx: string) => { captured.push(`${ctx}: ${m}`); },
    captureInfo: () => {},
  },
  [`${SRC}/lib/timezone.ts`]: { resolveUserTimezone: async () => IL },
  [`${SRC}/services/ai-provider.ts`]: { generateAICompletion: async (prompt: string) => ({ text: matcherAnswer(prompt) }), getGemini: () => ({}), extractionConfig: () => ({}) },
  [`${SRC}/services/telegram/index.ts`]: { getBot: () => fakeBot, getMessagingService: () => fakeService },
  [`${SRC}/services/telegram/bot.ts`]: { getBot: () => fakeBot, getMessagingService: () => fakeService },
  [`${SRC}/services/analytics-service.ts`]: { trackActivityAsync: () => {}, addBreadcrumb: () => {}, setUserContext: () => {} },
  [`${SRC}/services/subscription-service.ts`]: { checkFeatureAccess: async () => ({ allowed: true }), incrementUsage: async () => {} },
  [`${SRC}/services/user-service.ts`]: {
    getUserByTelegramId: async () => currentUser, getUserByWhatsAppId: async () => currentUser, getUserByWhatsAppPhone: async () => currentUser,
  },
  [`${SRC}/services/messaging/factory.ts`]: real => fakeOver(real, { getWhatsAppService: () => fakeWhatsApp }),
  [`${SRC}/services/reminder-cache.ts`]: { getVoiceAutoCreateHighConf: async () => flags.autoCreate, getVoiceTtsOutcome: async () => false },
  [`${SRC}/services/voice/recent-events-store.ts`]: {
    pushRecentEvent: async () => {}, removeRecentEvent: async () => {}, getRecentEvents: async () => [], formatRecentEventsBlock: () => '',
  },
  [`${SRC}/services/voice/audio-retry.ts`]: {
    isInRetryMode: async () => false, readRetryAudio: async () => null, clearRetryMode: async () => {}, stashFailedAudio: async () => {},
  },
  [`${SRC}/services/native-reminders/support.ts`]: {
    getReminderSupport: async () => (flags.reminders ? { supported: true } : { supported: false, reason: 'disabled' }),
  },
  // The providers, at their own modules: the real routing (calendar-provider/index.ts) picks them.
  [`${SRC}/services/calendar-provider/native-provider.ts`]: real => fakeOver(real, { nativeProvider: fakeNative, wouldRefuseFixedDays: async () => false }),
  [`${SRC}/services/calendar-provider/google-provider.ts`]: real => fakeOver(real, { googleProvider: fakeGoogle }),
  [`${SRC}/services/calendar-provider/user-calendars.ts`]: real => fakeOver(real, {
    getCalendarAssignmentsForUser: async (u: UserConfig) => UNION[u.id] ?? [],
    hasUsableCalendar: async () => true,
  }),
  [`${SRC}/services/native-calendar/event-store.ts`]: real => fakeOver(real, { getMainNativeCalendar: async (userId: number) => ({ id: `main-${userId}` }) }),
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

(globalThis as { routingSmokeFake?: (file: string) => object }).routingSmokeFake = file =>
  fakeFor(file, () => realLoad.call(Module, file, null, false));
Module.registerHooks({
  load(url, context, nextLoad) {
    const file = url.startsWith('file:') ? fileURLToPath(url.split('?')[0]) : '';
    if (!(file in stubs) || loadingReal.has(file)) return nextLoad(url, context);
    const fake = (globalThis as unknown as { routingSmokeFake: (file: string) => object }).routingSmokeFake(file);
    const names = Object.keys(fake).map(name => `export const ${name} = fake.${name};`).join('\n');
    return { format: 'module', shortCircuit: true, source: `const fake = globalThis.routingSmokeFake(${JSON.stringify(file)});\n${names}\n` };
  },
});

// ---- Fixtures ----

const plainEvent = (over: Partial<ParsedEvent> = {}): ParsedEvent => ({
  title: 'Dentist',
  startTime: at('2026-10-21 10:00'),
  endTime: at('2026-10-21 11:00'),
  allDay: false,
  calendarId: 'native:main-1',
  calendarName: 'FamCal 1',
  confidence: 'medium',
  ...over,
});
const createIntent = (event: ParsedEvent, confidence: 'high' | 'medium' | 'low' = 'medium'): VoiceIntentResult =>
  ({ intent: 'create', confidence, event });
const calendarEvent = (calendarId: string, eventId = 'e1'): CalendarEvent => ({
  summary: 'Dentist', start: at('2026-10-21 10:00').toISOString(), end: at('2026-10-21 11:00').toISOString(),
  calendarId, calendarName: calendarId, eventId,
});

const lastBot = () => botCalls[botCalls.length - 1];
const buttonsOf = (call: Sent) =>
  ((call.opts?.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }).inline_keyboard);
const pendingIdOf = (call: Sent, prefix: string) =>
  buttonsOf(call).flat().find(b => b.callback_data.startsWith(prefix))!.callback_data.slice(prefix.length);
const where = () => writes.map(w => `${w.provider} ${w.op} ${w.calendarId}`);

async function main() {
  console.warn = () => {};
  console.log = () => {};

  const { getBotMessages } = await import('../src/lib/bot-messages');
  const { showEventConfirmation, showEditConfirmation, showDeleteConfirmation, hebrewCardParts } = await import('../src/services/voice/confirmations');
  const { handleEventCallback, handleEditCallback, handleDeleteCallback } = await import('../src/services/voice/callbacks');
  const { autoCreateEvent, handleUndoCallback } = await import('../src/services/voice/auto-create');
  const { showBulkConfirmation, handleBulkConfirmAll } = await import('../src/services/voice/bulk-confirmations');
  const { handleWhatsAppWebhook } = await import('../src/services/webhook-handlers');
  const { handleEditIntent } = await import('../src/services/voice/handler');
  const t = await getBotMessages('en');

  const cardConfirm = async (event: ParsedEvent) => {
    await showEventConfirmation(555, undefined, event, 'x', currentUser);
    await handleEventCallback(555, 701, 'q1', 'create', pendingIdOf(lastBot(), 'event_create:'));
  };
  const waTap = (id: string) => handleWhatsAppWebhook(
    { body: { entry: [{ changes: [{ value: { messages: [{ from: '972500000008', id: `wamid.tap.${id}`, type: 'interactive', interactive: { type: 'button_reply', button_reply: { id, title: 'OK' } } }] } }] }] } },
    { status: () => ({ json: () => {} }) }
  );
  const whatsappVoice = () => handleWhatsAppWebhook(
    { body: { entry: [{ changes: [{ value: { messages: [{ from: '972500000008', id: 'wamid.in', type: 'audio', audio: { id: 'media-1' } }] } }] }] } },
    { status: () => ({ json: () => {} }) }
  );

  // ================= Creates go to the provider of their calendar id =================

  await check('card confirm: a legacy Google user\'s FamCal event goes to FamCal, their Google one to Google', async () => {
    currentUser = HILA;
    await cardConfirm(plainEvent({ calendarId: 'native:main-4' }));
    await cardConfirm(plainEvent({ calendarId: 'hila@gmail.com' }));
    assertEqual(where(), ['native create native:main-4', 'google create hila@gmail.com'], 'writes');
  });

  await check('card confirm: a FamCal user who connected Google gets their Google event on Google', async () => {
    currentUser = NAVA;
    await cardConfirm(plainEvent({ calendarId: 'nava@gmail.com' }));
    assertEqual(where(), ['google create nava@gmail.com'], 'writes');
  });

  await check('card confirm: an event nothing placed goes to the default calendar, never to the literal "primary"', async () => {
    for (const [u, want] of [[DANA, 'native create native:main-1'], [HILA, 'google create hila@gmail.com'], [GIL, 'google create gil@gmail.com']] as const) {
      writes = [];
      currentUser = u;
      await cardConfirm(plainEvent({ calendarId: undefined, calendarName: undefined }));
      assertEqual(where(), [want], `user ${u.id}`);
    }
  });

  await check('a reminder goes on the creator\'s FamCal main, whatever calendar it carries', async () => {
    currentUser = GIL;
    const reminder = plainEvent({ kind: 'reminder', forPerson: 'self', calendarId: 'gil@gmail.com', endTime: at('2026-10-21 10:00') });
    await cardConfirm(reminder);
    assertEqual(where(), ['native create native:main-3'], 'writes');
    assertEqual(writes[0].input?.kind, 'reminder', 'kind');
  });

  await check('"Confirm all": each event to its own calendar\'s provider, an unplaced one to the default', async () => {
    currentUser = NAVA;
    const events = [plainEvent({ calendarId: 'native:main-2' }), plainEvent({ calendarId: 'nava@gmail.com' }), plainEvent({ calendarId: undefined })];
    await showBulkConfirmation(555, events.map(e => createIntent(e)), currentUser, 'three', t, fakeService as never, IL);
    const markup = serviceCalls[0].opts?.replyMarkup as { inline_keyboard: Array<Array<{ callback_data: string }>> };
    const result = await handleBulkConfirmAll(markup.inline_keyboard[0][0].callback_data.slice('bulk_confirm:'.length));
    assert(result.successCount === 3, JSON.stringify(result));
    assertEqual(where(), ['native create native:main-2', 'google create nava@gmail.com', 'native create native:main-2'], 'writes');
  });

  await check('auto-create and its Undo: both go to the provider of the event\'s calendar', async () => {
    flags.autoCreate = true;
    currentUser = GIL;
    assert(await autoCreateEvent(currentUser, plainEvent({ calendarId: 'native:main-3' }), t, fakeService as never, 555), 'not handled');
    const undo = (serviceCalls[serviceCalls.length - 1].opts?.replyMarkup as { inline_keyboard: Array<Array<{ callback_data: string }>> }).inline_keyboard[0][0].callback_data;
    const outcome = await handleUndoCallback(currentUser, undo.slice('voice_undo:'.length));
    assert(outcome.ok, JSON.stringify(outcome));
    assertEqual(where(), ['native create native:main-3', 'native delete native:main-3'], 'writes');
  });

  await check('WhatsApp: auto-create, bulk auto-create and the card\'s button, each by its calendar id', async () => {
    flags.autoCreate = true;
    currentUser = HILA;
    extracted = [createIntent(plainEvent({ calendarId: 'native:main-4' }), 'high')];
    await whatsappVoice();
    extracted = [createIntent(plainEvent({ calendarId: 'hila@gmail.com' }), 'high'), createIntent(plainEvent({ calendarId: undefined, title: 'Gym' }), 'high')];
    await whatsappVoice();
    flags.autoCreate = false;
    extracted = [createIntent(plainEvent({ calendarId: 'native:main-4' }))];
    await whatsappVoice();
    const buttons = waCalls[waCalls.length - 1].opts?.whatsappButtons as Array<{ id: string }>;
    await waTap(buttons[0].id);
    assertEqual(where(), [
      'native create native:main-4',
      'google create hila@gmail.com',
      'google create hila@gmail.com',
      'native create native:main-4',
    ], 'writes');
  });

  // ================= Edit and delete route by the event's calendar id =================

  await check('Telegram edit and delete confirmations: by the event\'s calendar id', async () => {
    currentUser = GIL;
    await showEditConfirmation(555, undefined, calendarEvent('native:main-3'), 'native:main-3', { title: 'New' }, 'x', currentUser);
    await handleEditCallback(555, 701, 'q', 'confirm', pendingIdOf(lastBot(), 'edit_confirm:'));
    currentUser = NAVA;
    await showDeleteConfirmation(555, undefined, calendarEvent('nava@gmail.com'), 'nava@gmail.com', 'x', currentUser);
    await handleDeleteCallback(555, 701, 'q', 'confirm', pendingIdOf(lastBot(), 'delete_confirm:'));
    assertEqual(where(), ['native update native:main-3', 'google delete nava@gmail.com'], 'writes');
  });

  await check('WhatsApp edit and delete confirmations: by the event\'s calendar id', async () => {
    currentUser = GIL;
    await showEditConfirmation(555, undefined, calendarEvent('native:main-3'), 'native:main-3', { title: 'New' }, 'x', currentUser);
    await waTap(`edit_confirm:${pendingIdOf(lastBot(), 'edit_confirm:')}`);
    currentUser = NAVA;
    await showDeleteConfirmation(555, undefined, calendarEvent('nava@gmail.com'), 'nava@gmail.com', 'x', currentUser);
    await waTap(`delete_confirm:${pendingIdOf(lastBot(), 'delete_confirm:')}`);
    assertEqual(where(), ['native update native:main-3', 'google delete nava@gmail.com'], 'writes');
  });

  // ================= Gates keyed on the target =================

  await check('the token stop is for a Google target only: a legacy Google user without a token still creates, edits and deletes on FamCal', async () => {
    currentUser = OMRI;
    await cardConfirm(plainEvent({ calendarId: 'native:main-5' }));
    await showEditConfirmation(555, undefined, calendarEvent('native:main-5'), 'native:main-5', { title: 'New' }, 'x', currentUser);
    await handleEditCallback(555, 701, 'q', 'confirm', pendingIdOf(lastBot(), 'edit_confirm:'));
    await showDeleteConfirmation(555, undefined, calendarEvent('native:main-5'), 'native:main-5', 'x', currentUser);
    await handleDeleteCallback(555, 701, 'q', 'confirm', pendingIdOf(lastBot(), 'delete_confirm:'));
    assertEqual(where(), ['native create native:main-5', 'native update native:main-5', 'native delete native:main-5'], 'writes');
    assert(!botCalls.some(c => c.text.includes(t.voice.notConnected)), 'told "not connected"');
  });

  await check('the token stop holds for a Google target without a token, whatever the user\'s source', async () => {
    currentUser = OMRI;
    await cardConfirm(plainEvent({ calendarId: 'omri@gmail.com' }));
    const dana = person(1, { calendarAssignments: [googleRow('dana@gmail.com', ['yours'])] });
    currentUser = dana;
    await showDeleteConfirmation(555, undefined, calendarEvent('dana@gmail.com'), 'dana@gmail.com', 'x', currentUser);
    await handleDeleteCallback(555, 701, 'q', 'confirm', pendingIdOf(lastBot(), 'delete_confirm:'));
    assertEqual(where(), [], 'writes');
    assertEqual(botCalls.filter(c => c.text.startsWith(t.voice.notConnected)).length, 2, '"not connected" answers');
  });

  await check('denied copy by the target\'s provider: FamCal says "You can\'t change this one", Google asks for access', async () => {
    currentUser = GIL;
    failures.native = { error: 'PERMISSION_DENIED' };
    await cardConfirm(plainEvent({ calendarId: 'native:main-3' }));
    assertEqual(lastBot().text, t.nativeReminders.permissionDenied, 'FamCal denial for a legacy Google user');
    failures.native = undefined;
    currentUser = NAVA;
    failures.google = { error: 'PERMISSION_DENIED' };
    await showEditConfirmation(555, undefined, calendarEvent('nava@gmail.com'), 'nava@gmail.com', { title: 'New' }, 'x', currentUser);
    await handleEditCallback(555, 701, 'q', 'confirm', pendingIdOf(lastBot(), 'edit_confirm:'));
    assert(lastBot().text.startsWith(t.voice.permissionRequired), `Google denial for a FamCal user: ${lastBot().text}`);
  });

  // ================= A Hebrew repeat is worded for its own target =================

  await check('a Hebrew repeat on a Google calendar is noted "added once", on FamCal it is not, whatever the user\'s source', async () => {
    const hebrew = { recurrence: { frequency: 'yearly' as const, calendar: 'hebrew' as const, hebrewKind: 'yahrzeit' as const }, allDay: true };
    const onGoogle = await hebrewCardParts(plainEvent({ ...hebrew, calendarId: 'nava@gmail.com' }), NAVA, 'en', IL);
    const onFamcal = await hebrewCardParts(plainEvent({ ...hebrew, calendarId: 'native:main-3' }), GIL, 'en', IL);
    assert(onGoogle.notices.length === 1, `Google target notices ${JSON.stringify(onGoogle.notices)}`);
    assert(onFamcal.notices.length === 0, `FamCal target notices ${JSON.stringify(onFamcal.notices)}`);
    currentUser = GIL;
    await cardConfirm(plainEvent({ ...hebrew, calendarId: 'native:main-3' }));
    assertEqual([writes[0]?.provider, writes[0]?.input?.hebrewRule], ['native', 'yahrzeit'], 'created on FamCal with the Hebrew rule');
  });

  // ================= Voice matching with a failed Google half =================

  await check('a voice edit whose search could not read Google says Google could not be reached, not "not found"', async () => {
    currentUser = NAVA;
    fetches.google = async () => {
      throw new Error('Backend Error');
    };
    const intent: VoiceIntentResult = { intent: 'edit', confidence: 'high', eventReference: { type: 'by_description', description: 'dentist' }, editRequest: { newTitle: 'x' } } as unknown as VoiceIntentResult;
    await handleEditIntent(555, undefined, intent, 'move the dentist', currentUser, t);
    assertEqual(serviceCalls.map(c => c.text), [t.errors.googleUnreachable], 'what the user got');
    assertEqual(fetchCalls.map(c => `${c.provider} ${c.ids.join(',')}`), ['native native:main-2', 'google nava@gmail.com'], 'the split fetch');
    assert(captured.some(c => c.startsWith('calendar-provider-fetch')), `captured ${JSON.stringify(captured)}`);
  });

  await check('a guessed day that finds nothing while Google is down still widens: the FamCal event on another day is found', async () => {
    currentUser = NAVA;
    fetches.google = async () => {
      throw new Error('Backend Error');
    };
    const dentist = calendarEvent('native:main-2');
    fetches.native = async (start, end) => {
      const t0 = new Date(dentist.start).getTime();
      return t0 >= start.getTime() && t0 < end.getTime() ? [dentist] : [];
    };
    matcherAnswer = prompt => (prompt.includes('Dentist') ? '{"match":"single","eventIndex":1}' : '{"match":"none"}');
    const intent: VoiceIntentResult = {
      intent: 'edit', confidence: 'high',
      eventReference: { type: 'by_description', description: 'dentist', originalDate: '2026-10-23' }, editRequest: { newTitle: 'x' },
    } as unknown as VoiceIntentResult;
    await handleEditIntent(555, undefined, intent, 'move the dentist', currentUser, t);
    assertEqual(fetchCalls.filter(c => c.provider === 'native').length, 2, 'FamCal reads (the guessed day, then the wide search)');
    const texts = [...serviceCalls, ...botCalls].map(c => c.text);
    assert(!texts.includes(t.errors.googleUnreachable), `told Google was unreachable: ${JSON.stringify(texts)}`);
    assert(botCalls.some(c => buttonsOf(c).flat().some(b => b.callback_data.startsWith('edit_confirm:'))), `no edit card: ${JSON.stringify(texts)}`);
  });

  await check('a guessed day that finds nothing anywhere while Google is down says Google could not be reached', async () => {
    currentUser = NAVA;
    fetches.google = async () => {
      throw new Error('Backend Error');
    };
    const intent: VoiceIntentResult = {
      intent: 'edit', confidence: 'high',
      eventReference: { type: 'by_description', description: 'dentist', originalDate: '2026-10-23' }, editRequest: { newTitle: 'x' },
    } as unknown as VoiceIntentResult;
    await handleEditIntent(555, undefined, intent, 'move the dentist', currentUser, t);
    assertEqual(serviceCalls.map(c => c.text), [t.errors.googleUnreachable], 'what the user got');
    assertEqual(fetchCalls.filter(c => c.provider === 'native').length, 2, 'FamCal reads');
  });

  await check('[guard] a voice edit that finds nothing with both halves read still says "no events"', async () => {
    currentUser = NAVA;
    const intent: VoiceIntentResult = { intent: 'edit', confidence: 'high', eventReference: { type: 'by_description', description: 'dentist' }, editRequest: { newTitle: 'x' } } as unknown as VoiceIntentResult;
    await handleEditIntent(555, undefined, intent, 'move the dentist', currentUser, t);
    assertEqual(serviceCalls.map(c => c.text), [t.voice.noEventsFound], 'what the user got');
  });

  let failed = 0;
  for (const r of results) {
    process.stdout.write(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}\n`);
    if (!r.ok) failed++;
  }
  process.stdout.write(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})\n`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});

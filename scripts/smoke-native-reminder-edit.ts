// Smoke test for moving and deleting native reminders from chat (spec §7): how the
// candidates read to the matcher (tagged, a repeating reminder once, open ones however
// old), which of an event and a reminder with the same title wins, "cancel that" after a
// repeating reminder, the built-in calendar's answer to a refused create, edit or delete,
// and the pings a move re-arms, which must say where the reminder went and lose their buttons.
// The calendar provider, the AI matcher, Redis, Telegram, the user lookup and the open
// reminders lookup are faked. No network, no database.
//
// Run under both clocks; the output must not depend on the server's timezone:
//   TZ=UTC npx tsx scripts/smoke-native-reminder-edit.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-native-reminder-edit.ts

import Module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromZonedTime } from 'date-fns-tz';
import { REDIS_KEYS } from '../src/config/redis-keys';
import type { ReminderInfo, UserConfig } from '../src/types';
import type { UnifiedEvent, UpdateEventResult } from '../src/services/calendar-provider/types';
import type { EventReference, VoiceIntentResult } from '../src/services/event-parser';

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

const IL = 'Asia/Jerusalem';
const NY = 'America/New_York';
const at = (local: string, tz = IL) => fromZonedTime(local, tz);
/** Wednesday 2026-10-14, 12:00 in Israel. */
const NOW = at('2026-10-14T12:00:00');

// ---- People ----

const user = (fields: Partial<UserConfig>) => ({ isAdmin: false, voiceInputEnabled: true, googleRefreshToken: '', ...fields }) as UserConfig;
const raziel = user({ id: 1, name: 'Raziel', telegramId: 1001, language: 'en', calendarSource: 'NATIVE', pairingId: 'p1' });
const dana = user({ id: 2, name: 'Dana', telegramId: 1002, language: 'ru', calendarSource: 'NATIVE', pairingId: 'p1' });
const googleUser = user({ id: 3, name: 'Noa', telegramId: 1003, language: 'en', calendarSource: 'GOOGLE', googleRefreshToken: 'token' });
const PEOPLE = [raziel, dana, googleUser];
const TIMEZONES: Record<number, string> = { 1: IL, 2: NY, 3: IL };

// ---- Calendar items, as the native provider lists them ----

/** A reminder: a timed one ends where it starts, a date-only one runs to the next date. */
function reminder(title: string, start: string, fields: Partial<UnifiedEvent> & { info?: Partial<ReminderInfo> } = {}): UnifiedEvent {
  const { info, ...rest } = fields;
  return {
    summary: title, start, end: start.includes('T') ? start : nextDay(start), calendarName: 'Raziel', calendarId: 'native:c1',
    eventType: 'reminder', eventId: `${title.replace(/\W/g, '').toLowerCase()}-${start}`, provider: 'native', timeZone: IL,
    reminder: { ownerIsViewer: true, creatorIsViewer: true, ...info },
    ...rest,
  };
}

function event(title: string, start: string, end: string, fields: Partial<UnifiedEvent> = {}): UnifiedEvent {
  return {
    summary: title, start, end, calendarName: 'Raziel', calendarId: 'native:c1',
    eventId: `${title.replace(/\W/g, '').toLowerCase()}-${start}`, provider: 'native', timeZone: IL, ...fields,
  };
}

function nextDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** A daily 09:00 reminder's occurrences, `count` days from `firstDay`. */
function dailyCallMom(firstDay: string, count: number): UnifiedEvent[] {
  return Array.from({ length: count }, (_, i) => {
    const day = new Date(`${firstDay}T00:00:00Z`);
    day.setUTCDate(day.getUTCDate() + i);
    const start = at(`${day.toISOString().slice(0, 10)}T09:00:00`);
    return reminder('Call mom', start.toISOString(), {
      eventId: `daily1#${start.toISOString()}`, recurringEventId: 'daily1', instanceStartsAt: start.toISOString(),
    });
  });
}

// ---- Fakes ----

/** Redis as Upstash behaves: values round-trip through JSON. */
const store = new Map<string, string>();
const fakeRedis = {
  get: async (key: string) => (store.has(key) ? JSON.parse(store.get(key)!) : null),
  set: async (key: string, value: unknown) => {
    store.set(key, JSON.stringify(value));
    return 'OK';
  },
  del: async (key: string) => (store.delete(key) ? 1 : 0),
};

/** The calendar the provider reads, and what its writes answer. */
let calendar: UnifiedEvent[] = [];
let createResult: { success: boolean; eventId?: string; error?: string } = { success: true };
let updateResult: UpdateEventResult = { success: true };
let deleteResult: { success: boolean; error?: string } = { success: true };
const fakeProvider = {
  name: 'native',
  // Every item overlapping [from, to), a zero-length one when it starts inside it
  fetchEventsInRange: async (_user: UserConfig, _calendarIds: string[], from: Date, to: Date) =>
    calendar.filter(e => new Date(e.start) < to && (new Date(e.end) > from || new Date(e.start) >= from)),
  createEvent: async () => createResult,
  updateEvent: async () => updateResult,
  deleteEvent: async () => deleteResult,
};

/** The user's open reminders, as fetchOpenReminders would carry them over, and its calls. */
let openReminders: UnifiedEvent[] = [];
const openCalls: Array<{ viewerId: number; cutoff: string; summaryDay: string; timezone: string; cap: number }> = [];
const fakeOpenReminders = {
  OPEN_REMINDERS_DIGEST_CAP: 5,
  fetchOpenReminders: async (_user: UserConfig, ctx: { viewerId: number }, cutoff: Date, summaryDay: string, timezone: string, cap = 5) => {
    openCalls.push({ viewerId: ctx.viewerId, cutoff: cutoff.toISOString(), summaryDay, timezone, cap });
    return { events: openReminders.slice(0, cap), moreCount: Math.max(0, openReminders.length - cap) };
  },
};

/**
 * The AI matcher, faked: by default it picks the first listed item whose line has the
 * user's description in it. A test can script the answer. Every prompt is recorded.
 */
const matcherPrompts: string[] = [];
let matcherAnswer: ((lines: string[], description: string) => object) | undefined;
async function fakeMatcher(prompt: string) {
  matcherPrompts.push(prompt);
  const description = (/User's description: "(.*)"/.exec(prompt)?.[1] ?? '').toLowerCase();
  const lines = prompt.split('Available events:\n')[1].split('\n\n')[0].split('\n');
  if (matcherAnswer) return { text: JSON.stringify(matcherAnswer(lines, description)) };
  const index = lines.findIndex(line => line.toLowerCase().includes(description));
  return { text: JSON.stringify(index < 0 ? { match: 'none' } : { match: 'single', eventIndex: index + 1 }) };
}
const listedIn = (prompt: string) => prompt.split('Available events:\n')[1].split('\n\n')[0].split('\n');

/** Telegram, recorded. */
type Sent = { chatId: number; text: string; options?: { reply_markup?: unknown } };
let sent: Sent[] = [];
let edits: Sent[] = [];
const fakeBot = {
  sendMessage: async (chatId: number, text: string, options?: Sent['options']) => {
    sent.push({ chatId, text, options });
    return { message_id: 900 + sent.length };
  },
  editMessageText: async (text: string, options: { chat_id: number; reply_markup?: unknown }) => {
    edits.push({ chatId: options.chat_id, text, options });
    return true;
  },
  answerCallbackQuery: async () => true,
};
const fakeMessaging = {
  sendMessage: async (chatId: number, text: string) => {
    sent.push({ chatId, text });
    return { messageId: 900 + sent.length };
  },
};

/** Pings whose buttons were stripped, and one ping chat whose edit fails. */
let stripped: Array<{ chatId: string; messageId: number; text: string }> = [];
let failingPingChat: bigint | undefined;

/** Whether the timezone lookup fails, as its Redis read does when Redis is down. */
let timezoneFails = false;
const fakePing = {
  stripPingButtons: async (chatId: bigint | number, messageId: number, text: string) => {
    if (failingPingChat !== undefined && BigInt(chatId) === failingPingChat) throw new Error('Bad Request: chat not found');
    stripped.push({ chatId: String(chatId), messageId, text });
  },
};

/** What the native event store's update answers (for the provider's own check). */
let storeUpdate = { canonicalEventId: 'r1', clearedPings: [] as Array<{ chatId: bigint; messageId: number }> };

const captured: Array<{ context: string; severity?: string }> = [];

const SRC = path.resolve(__dirname, '../src');

/** A proxy over the real module, not a copy: the store and the ownership helpers import each other. */
const fakeOver = (real: Record<string, unknown>, fakes: Record<string, unknown>) =>
  new Proxy(real, { get: (target, key) => (typeof key === 'string' && key in fakes ? fakes[key] : Reflect.get(target, key)) });

/** Any database access is a bug in this test. */
const noDatabase = new Proxy({}, {
  get: (_target, key) => {
    if (typeof key !== 'string' || key === 'then') return undefined;
    throw new Error(`smoke test touched the database: prisma.${key}`);
  },
});

/** Modules replaced by fakes, by file path; a function fakes part of the real module. */
const stubs: Record<string, object | ((real: Record<string, unknown>) => object)> = {
  [`${SRC}/lib/timezone.ts`]: {
    resolveUserTimezone: async (u: { id: number }) => {
      if (timezoneFails) throw new Error('Redis unavailable');
      return TIMEZONES[u.id];
    },
  },
  [`${SRC}/services/ai-provider.ts`]: { generateAICompletion: fakeMatcher },
  [`${SRC}/utils/redis.ts`]: { redis: fakeRedis },
  [`${SRC}/utils/prisma.ts`]: { prisma: noDatabase },
  [`${SRC}/lib/error-capture.ts`]: {
    captureError: (_error: unknown, context: string, _extra?: unknown, severity?: string) => { captured.push({ context, severity }); },
    captureWarning: () => {},
    captureInfo: () => {},
  },
  [`${SRC}/services/telegram/index.ts`]: { getBot: () => fakeBot, getMessagingService: () => fakeMessaging },
  [`${SRC}/services/user-service.ts`]: {
    getUserByTelegramId: async (telegramId: number | bigint) => PEOPLE.find(p => p.telegramId === Number(telegramId)) ?? null,
  },
  [`${SRC}/services/analytics-service.ts`]: { trackActivityAsync: () => {}, addBreadcrumb: () => {}, setUserContext: () => {} },
  [`${SRC}/services/subscription-service.ts`]: { checkFeatureAccess: async () => ({ allowed: true }), incrementUsage: async () => {} },
  [`${SRC}/services/calendar-provider/index.ts`]: {
    getProviderForUser: () => fakeProvider,
    hasUsableCalendar: async () => true,
    getCalendarAssignmentsForUser: async () => [{ calendarId: 'native:c1', name: 'Raziel', labels: ['primary'], color: '#000' }],
  },
  [`${SRC}/services/voice/recent-events-store.ts`]: {
    pushRecentEvent: async () => {}, removeRecentEvent: async () => {}, getRecentEvents: async () => [], formatRecentEventsBlock: () => '',
  },
  [`${SRC}/services/native-reminders/open-reminders.ts`]: fakeOpenReminders,
  [`${SRC}/services/native-reminders/ping.ts`]: fakePing,
  [`${SRC}/services/native-reminders/ownership.ts`]: real => fakeOver(real, {
    loadViewerContext: async (u: { id: number }) => ({ viewerId: u.id, partner: null }),
  }),
  [`${SRC}/services/native-calendar/event-store.ts`]: real => fakeOver(real, {
    updateNativeEvent: async () => storeUpdate,
  }),
};

// Static imports compile to require() and pass through Module._load.
const ModuleInternals = Module as unknown as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  _resolveFilename: (request: string, parent: unknown, isMain: boolean) => string;
};
const realLoad = ModuleInternals._load;
const partialFakes = new Map<string, object>();
ModuleInternals._load = function (request, parent, isMain) {
  // src/services/claude.ts imports @hebcal/core, which ships ESM only; nothing here uses it
  if (request.startsWith('@hebcal/')) return {};
  let resolved = request;
  try {
    resolved = ModuleInternals._resolveFilename(request, parent, isMain);
  } catch {}
  const stub = stubs[resolved];
  if (!stub) return realLoad.call(this, request, parent, isMain);
  if (typeof stub !== 'function') return stub;
  if (!partialFakes.has(resolved)) partialFakes.set(resolved, stub(realLoad.call(this, request, parent, isMain) as Record<string, unknown>));
  return partialFakes.get(resolved);
};

// The voice handlers load some modules with import(), which goes through the ES module
// loader instead; those get the same fake, served as an ES module.
(globalThis as { smokeStubs?: typeof stubs }).smokeStubs = stubs;
Module.registerHooks({
  load(url, context, nextLoad) {
    const file = url.startsWith('file:') ? fileURLToPath(url) : '';
    const stub = stubs[file];
    if (!stub || typeof stub === 'function') return nextLoad(url, context);
    const names = Object.keys(stub).map(name => `export const ${name} = fake.${name};`).join('\n');
    return { format: 'module', shortCircuit: true, source: `const fake = globalThis.smokeStubs[${JSON.stringify(file)}];\n${names}\n` };
  },
});

function reset() {
  store.clear();
  calendar = [];
  openReminders = [];
  openCalls.length = 0;
  matcherPrompts.length = 0;
  matcherAnswer = undefined;
  sent = [];
  edits = [];
  stripped = [];
  failingPingChat = undefined;
  timezoneFails = false;
  captured.length = 0;
  createResult = { success: true };
  updateResult = { success: true };
  deleteResult = { success: true };
  storeUpdate = { canonicalEventId: 'r1', clearedPings: [] };
}

async function main() {
  const {
    collapseReminderSeries, describeEventForMatching, findMatchingEvent, buildMatchPrompt, isLastCreatedEvent,
  } = await import('../src/services/voice/event-resolution');
  const { handleDeleteIntent } = await import('../src/services/voice/handler');
  const { handleEventCallback, handleEditCallback, handleDeleteCallback } = await import('../src/services/voice/callbacks');
  const { nativeProvider } = await import('../src/services/calendar-provider/native-provider');
  const { getBotMessages } = await import('../src/lib/bot-messages');
  const { showEditConfirmation, showDeleteConfirmation } = await import('../src/services/voice/confirmations');

  const byDescription = (description: string, extra: Partial<EventReference> = {}): EventReference =>
    ({ type: 'by_description', description, ...extra });
  const picked = (result: Awaited<ReturnType<typeof findMatchingEvent>>) =>
    'event' in result ? `${result.event.summary} ${result.event.start}` : result.error;

  // (a) How the candidates read.

  await check('a reminder is tagged, with whose it is when it is the partner\'s; an event is not', () => {
    const mine = describeEventForMatching(reminder('Call mom', '2026-10-14T07:00:00.000Z'), 0, IL);
    assert(mine === '1. [reminder] "Call mom" on Wednesday 2026-10-14 at 10:00 (calendar: native:c1)', `mine: ${mine}`);
    const fromDana = describeEventForMatching(reminder('Pick up the cake', '2026-10-14T13:00:00.000Z', { info: { creatorIsViewer: false, creatorName: 'Dana' } }), 1, IL);
    assert(fromDana === '2. [reminder] "Pick up the cake" on Wednesday 2026-10-14 at 16:00 (calendar: native:c1)', `from Dana: ${fromDana}`);
    const forDana = describeEventForMatching(reminder('Buy milk', '2026-10-15', { info: { ownerIsViewer: false, ownerName: 'Dana' } }), 2, IL);
    assert(forDana === '3. [reminder for Dana] "Buy milk" on Thursday 2026-10-15 (all day) (calendar: native:c1)', `for Dana: ${forDana}`);
    const dentist = describeEventForMatching(event('Dentist', '2026-10-15T07:00:00.000Z', '2026-10-15T08:00:00.000Z'), 3, IL);
    assert(dentist === '4. "Dentist" on Thursday 2026-10-15 at 10:00 (calendar: native:c1)', `event: ${dentist}`);
  });

  await check('a daily reminder over three weeks is one candidate: its next occurrence, else its last', () => {
    const daily = dailyCallMom('2026-10-07', 21);
    const standup = [9, 10, 11].map(d => event('Standup', `2026-10-${d}T06:00:00.000Z`, `2026-10-${d}T06:15:00.000Z`, { recurringEventId: 'standup1', eventId: `standup1#${d}` }));
    const plumber = reminder('Call the plumber', '2026-10-13T08:00:00.000Z');
    const kept = collapseReminderSeries([plumber, ...standup, ...daily], NOW, IL);
    const next = at('2026-10-15T09:00:00').toISOString();
    assert(kept.length === 5 && kept[0] === plumber && kept.slice(1, 4).every((e, i) => e === standup[i]), `kept ${kept.map(e => e.summary).join(', ')}`);
    assert(kept[4].start === next, `the daily one: ${kept[4].start}, wanted ${next}`);
    const afterAll = collapseReminderSeries(daily, at('2026-10-28T12:00:00'), IL);
    assert(afterAll.length === 1 && afterAll[0].start === at('2026-10-27T09:00:00').toISOString(), `after all: ${afterAll.map(e => e.start).join(', ')}`);
    // A date-only occurrence is ahead all through its day
    const dateOnly = ['2026-10-13', '2026-10-14', '2026-10-15'].map(d => reminder('Water the plants', d, { recurringEventId: 'plants1', eventId: `plants1#${d}` }));
    const today = collapseReminderSeries(dateOnly, NOW, IL);
    assert(today.length === 1 && today[0].start === '2026-10-14', `date-only: ${today.map(e => e.start).join(', ')}`);
  });

  // (b) The search.

  await check('a voice edit of a daily reminder reaches the matcher as one line, and finds it', async () => {
    reset();
    calendar = [...dailyCallMom('2026-10-07', 21), event('Dentist', '2026-10-15T07:00:00.000Z', '2026-10-15T08:00:00.000Z')];
    const result = await findMatchingEvent(raziel, ['native:c1'], byDescription('call mom'), 'en', NOW, { openReminders: true });
    assert(picked(result) === `Call mom ${at('2026-10-15T09:00:00').toISOString()}`, `picked ${picked(result)}`);
    const lines = listedIn(matcherPrompts[0]);
    assert(lines.length === 2 && lines.filter(l => l.includes('Call mom')).length === 1, `listed ${JSON.stringify(lines)}`);
    assert(matcherPrompts[0].includes('\n6. Items tagged [reminder] are reminders'), 'no reminder rule in the prompt');
  });

  await check('open reminders of any age are offered, once each, to a native user\'s edit or delete only', async () => {
    reset();
    const plumber = reminder('Pay the plumber', '2026-09-20T07:00:00.000Z', { info: { openSince: '2026-09-20' } });
    const cake = reminder('Order the cake', '2026-10-12T07:00:00.000Z', { info: { openSince: '2026-10-12' } });
    calendar = [{ ...cake, reminder: { ownerIsViewer: true, creatorIsViewer: true } }];
    openReminders = [cake, plumber];
    const result = await findMatchingEvent(raziel, ['native:c1'], byDescription('plumber'), 'en', NOW, { openReminders: true });
    assert(picked(result) === 'Pay the plumber 2026-09-20T07:00:00.000Z', `picked ${picked(result)}`);
    const lines = listedIn(matcherPrompts[0]);
    assert(lines.length === 2 && lines.filter(l => l.includes('Order the cake')).length === 1, `listed ${JSON.stringify(lines)}`);
    const call = openCalls[0];
    assert(openCalls.length === 1 && call.viewerId === 1 && call.cutoff === NOW.toISOString() && call.summaryDay === '2026-10-14' && call.timezone === IL && call.cap === Infinity,
      `fetchOpenReminders called ${JSON.stringify(openCalls)} (cap ${call?.cap})`);

    // Without the option (an anchor lookup passes only `eligible`), and for a Google user, nothing is fetched
    openCalls.length = 0;
    const plain = await findMatchingEvent(raziel, ['native:c1'], byDescription('plumber'), 'en', NOW);
    const google = await findMatchingEvent(googleUser, ['primary'], byDescription('plumber'), 'en', NOW, { openReminders: true });
    assert(openCalls.length === 0 && picked(plain) === 'no_match' && picked(google) === 'no_match', `calls ${openCalls.length}, ${picked(plain)}, ${picked(google)}`);
  });

  await check('with nothing in the range, an open reminder is still found', async () => {
    reset();
    openReminders = [reminder('Renew the passport', '2026-08-01T07:00:00.000Z', { info: { openSince: '2026-08-01' } })];
    const result = await findMatchingEvent(raziel, ['native:c1'], byDescription('passport', { timeHint: 'today' }), 'en', NOW, { openReminders: true });
    assert(picked(result) === 'Renew the passport 2026-08-01T07:00:00.000Z', `picked ${picked(result)}`);
  });

  await check('a tie between an event and a reminder goes to the event, unless the user asks about the reminder', async () => {
    const dentistEvent = event('Dentist', '2026-10-15T07:00:00.000Z', '2026-10-15T08:00:00.000Z');
    const dentistReminder = reminder('Dentist', '2026-10-15T06:00:00.000Z');
    const tie = async (request: string, items: UnifiedEvent[] = [dentistReminder, dentistEvent]) => {
      reset();
      calendar = items;
      matcherAnswer = lines => ({ match: 'multiple', matchedIndexes: lines.map((_, i) => i + 1) });
      const result = await findMatchingEvent(raziel, ['native:c1'], byDescription('dentist'), 'en', NOW, { request, openReminders: true });
      const rule = matcherPrompts[0].split('\n').find(line => line.startsWith('6. ')) ?? '';
      return { picked: 'event' in result ? result.event : result.error, rule };
    };
    const plain = await tie('cancel the dentist');
    assert(plain.picked === dentistEvent && plain.rule.endsWith('choose the event'), `plain: ${JSON.stringify(plain)}`);
    for (const request of ['cancel the dentist reminder', 'תבטל את התזכורת לרופא שיניים', 'удали напоминание про стоматолога']) {
      const asked = await tie(request);
      assert(asked.picked === dentistReminder && asked.rule.endsWith('choose the reminder'), `${request}: ${JSON.stringify(asked)}`);
    }
    const twoEvents = await tie('cancel the dentist', [dentistEvent, { ...dentistEvent, eventId: 'dentist-2', start: '2026-10-16T07:00:00.000Z', end: '2026-10-16T08:00:00.000Z' }]);
    assert(twoEvents.picked === 'multiple_matches' && twoEvents.rule === '', `two events: ${JSON.stringify(twoEvents)}`);
  });

  await check('with no reminder among the candidates, the matcher\'s prompt is as before', async () => {
    const reference = byDescription('dentist', { timeHint: 'tomorrow' });
    const before = buildMatchPrompt(reference, 'en', '1. "Dentist" on Thursday 2026-10-15 at 10:00 (calendar: c1)', NOW, IL);
    const now = buildMatchPrompt(reference, 'en', '1. "Dentist" on Thursday 2026-10-15 at 10:00 (calendar: c1)', NOW, IL, undefined);
    assert(before === now && !before.includes('\n6. '), 'the prompt changed');
    reset();
    calendar = [event('Dentist', '2026-10-15T07:00:00.000Z', '2026-10-15T08:00:00.000Z')];
    await findMatchingEvent(googleUser, ['primary'], reference, 'en', NOW, { request: 'move the dentist reminder', openReminders: true });
    assert(matcherPrompts.length === 1 && !matcherPrompts[0].includes('\n6. ') && !matcherPrompts[0].includes('[reminder'), 'a Google prompt changed');
  });

  // (c) The chat flows around the match.

  await check('"cancel that" right after a repeating reminder finds its first occurrence; a Google id must still match exactly', async () => {
    reset();
    calendar = dailyCallMom('2026-10-15', 3);
    const first = calendar[0];
    await fakeRedis.set(REDIS_KEYS.lastCreatedEvent(1001), {
      eventId: 'daily1', calendarId: 'native:c1', title: 'Call mom', startTime: first.start, endTime: first.end, createdAt: NOW,
    });
    const t = await getBotMessages('en');
    const intent = { intent: 'delete', confidence: 'high', scope: 'single', eventReference: { type: 'last_created' } } as VoiceIntentResult;
    await handleDeleteIntent(1001, undefined, intent, 'cancel that', raziel, t);
    const pending = [...store.entries()].find(([key]) => key.startsWith('voice:pending:delete:'));
    assert(!!pending && JSON.parse(pending[1]).event.eventId === first.eventId, `pending delete ${pending?.[1]}`);
    assert(sent.length === 1 && sent[0].text.includes('Call mom'), `sent ${JSON.stringify(sent.map(s => s.text))}`);

    const googleInstance = { summary: 'Yoga', start: '', end: '', calendarName: 'Main', calendarId: 'primary', eventId: 'g1_20261015', recurringEventId: 'g1' };
    assert(!isLastCreatedEvent(googleInstance, { eventId: 'g1', calendarId: 'primary' }), 'a Google instance matched its series id');
    assert(isLastCreatedEvent({ ...googleInstance, eventId: 'g1' }, { eventId: 'g1', calendarId: 'primary' }), 'a Google event no longer matched its own id');
  });

  /** A pending create, edit or delete of `item` by `by`, then its confirm button. */
  async function confirm(kind: 'create' | 'edit' | 'delete', item: UnifiedEvent, by: UserConfig, updates: Record<string, unknown> = {}) {
    if (kind === 'create') {
      const event = {
        title: item.summary, startTime: new Date(item.start), endTime: new Date(item.end), allDay: false, calendarId: item.calendarId, confidence: 'high',
      };
      await fakeRedis.set(REDIS_KEYS.pendingEvent('p1'), { event, user: by, transcription: 'add it' });
      await handleEventCallback(77, 500, 'q1', 'create', 'p1');
      return edits[edits.length - 1];
    }
    const key = kind === 'edit' ? REDIS_KEYS.pendingEdit('p1') : REDIS_KEYS.pendingDelete('p1');
    await fakeRedis.set(key, kind === 'edit'
      ? { originalEvent: item, calendarId: item.calendarId, updates, user: by, transcription: 'move it', scope: 'single' }
      : { event: item, calendarId: item.calendarId, user: by, transcription: 'delete it', scope: 'single' });
    if (kind === 'edit') await handleEditCallback(77, 500, 'q1', 'confirm', 'p1');
    else await handleDeleteCallback(77, 500, 'q1', 'confirm', 'p1');
    return edits[edits.length - 1];
  }

  await check('a refused create, edit or delete on the built-in calendar says so, with no Google button; Google\'s is as before', async () => {
    const callMom = reminder('Call mom', '2026-10-15T06:00:00.000Z', { calendarId: 'native:c9' });
    const ru = await getBotMessages('ru');
    for (const kind of ['create', 'edit', 'delete'] as const) {
      reset();
      createResult = { success: false, error: 'PERMISSION_DENIED' };
      updateResult = { success: false, error: 'PERMISSION_DENIED' };
      deleteResult = { success: false, error: 'PERMISSION_DENIED' };
      const native = await confirm(kind, callMom, dana);
      assert(native.text === ru.nativeReminders.permissionDenied && !native.options?.reply_markup, `${kind} native: ${JSON.stringify(native)}`);
      const google = await confirm(kind, { ...callMom, calendarId: 'primary', eventType: undefined, reminder: undefined }, googleUser);
      const button = JSON.stringify(google.options?.reply_markup ?? '');
      assert(google.text.includes('Permission') && button.includes('web_app'), `${kind} Google: ${JSON.stringify(google)}`);
    }
  });

  await check('a moved reminder\'s pings say where it went, in their reader\'s language and clock, without buttons', async () => {
    reset();
    const callMom = reminder('Call <mom> & dad', '2026-10-14T07:00:00.000Z', { eventId: 'r1' });
    const fivePm = at('2026-10-15T17:00:00');
    updateResult = { success: true, eventId: 'r1', clearedPings: [{ chatId: 1002n, messageId: 12 }, { chatId: 1001n, messageId: 13 }] };
    await confirm('edit', callMom, raziel, { startTime: fivePm, endTime: fivePm });
    assert(edits.some(e => e.text.startsWith('✅')), `no success message: ${JSON.stringify(edits.map(e => e.text))}`);
    const pings = [...stripped];
    assert(pings.length === 2, `stripped ${JSON.stringify(pings)}`);
    const [forDana, forRaziel] = pings;
    // Dana reads Russian, in New York: 17:00 in Israel is 10:00 there
    assert(forDana.chatId === '1002' && forDana.messageId === 12 && forDana.text.startsWith('⏰ Call &lt;mom&gt; &amp; dad · перенесено на ')
      && forDana.text.includes('15') && forDana.text.endsWith(' 10:00'), `Dana's ping: ${forDana.text}`);
    assert(forRaziel.chatId === '1001' && forRaziel.messageId === 13 && forRaziel.text === '⏰ Call &lt;mom&gt; &amp; dad · moved to Thu, Oct 15 17:00',
      `Raziel's ping: ${forRaziel.text}`);

    // A date-only move reads its own day, whoever reads it
    reset();
    updateResult = { success: true, eventId: 'r1', clearedPings: [{ chatId: 1002n, messageId: 14 }] };
    const friday = at('2026-10-16T00:00:00');
    await confirm('edit', reminder('Buy milk', '2026-10-14', { eventId: 'r2' }), raziel, { startTime: friday, endTime: friday, allDay: true });
    const dateOnly = [...stripped];
    assert(dateOnly.length === 1 && dateOnly[0].text.startsWith('⏰ Buy milk · перенесено на ') && dateOnly[0].text.includes('16') && !/\d\d:\d\d/.test(dateOnly[0].text),
      `date-only: ${dateOnly[0]?.text}`);
  });

  await check('a ping that cannot be edited costs nothing else; an edit that clears none strips none', async () => {
    reset();
    failingPingChat = 1002n;
    updateResult = { success: true, eventId: 'r1', clearedPings: [{ chatId: 1002n, messageId: 12 }, { chatId: 1001n, messageId: 13 }] };
    const fivePm = at('2026-10-15T17:00:00');
    await confirm('edit', reminder('Call mom', '2026-10-14T07:00:00.000Z', { eventId: 'r1' }), raziel, { startTime: fivePm, endTime: fivePm });
    const survivors = [...stripped];
    assert(survivors.length === 1 && survivors[0].chatId === '1001', `stripped ${JSON.stringify(survivors)}`);
    assert(captured.some(c => c.context === 'native-reminder-moved-ping' && c.severity === 'warning'), `captured ${JSON.stringify(captured)}`);
    reset();
    updateResult = { success: true, eventId: 'r1' };
    await confirm('edit', reminder('Call mom', '2026-10-14T07:00:00.000Z', { eventId: 'r1' }), raziel, { title: 'Call grandma' });
    const renamed = [...stripped];
    assert(renamed.length === 0, `a rename stripped ${JSON.stringify(renamed)}`);
  });

  await check('an edit\'s success message escapes the new title', async () => {
    reset();
    const done = await confirm('edit', event('Fix the sink', '2026-10-15T07:00:00.000Z', '2026-10-15T08:00:00.000Z'), raziel, { title: 'Fix <sink> & tap' });
    assert(done.text.includes('Fix &lt;sink&gt; &amp; tap') && !done.text.includes('<sink>'), `edited: ${JSON.stringify(done.text)}`);
  });

  await check('a delete\'s success message escapes the title', async () => {
    reset();
    const done = await confirm('delete', event('A & B', '2026-10-15T07:00:00.000Z', '2026-10-15T08:00:00.000Z'), raziel);
    assert(done.text.includes('<s>A &amp; B</s>'), `deleted: ${JSON.stringify(done.text)}`);
  });

  await check('a move whose pings cannot be worked out still answers "updated", and only logs it', async () => {
    reset();
    timezoneFails = true;
    updateResult = { success: true, eventId: 'r1', clearedPings: [{ chatId: 1002n, messageId: 12 }] };
    const fivePm = at('2026-10-15T17:00:00');
    const done = await confirm('edit', reminder('Call mom', '2026-10-14T07:00:00.000Z', { eventId: 'r1' }), raziel, { startTime: fivePm, endTime: fivePm });
    assert(done.text.startsWith('✅') && done.text.includes('📅 Call mom'), `edited: ${JSON.stringify(done.text)}`);
    assert(stripped.length === 0, `stripped ${JSON.stringify(stripped)}`);
    assert(captured.some(c => c.context === 'native-reminder-moved-ping' && c.severity === 'warning'), `captured ${JSON.stringify(captured)}`);
  });

  await check('the edit card escapes the title, in its current line and its rename', async () => {
    reset();
    const callMom = reminder('Call <mom> & dad', '2026-10-15T07:00:00.000Z');
    await showEditConfirmation(1001, undefined, callMom, 'native:c1', { title: 'Call <grandma> & dad' }, 'rename it', raziel);
    const card = sent[sent.length - 1]?.text ?? '';
    assert(card.includes('📅 Call &lt;mom&gt; &amp; dad\n') && card.includes('📝 Call &lt;mom&gt; &amp; dad → Call &lt;grandma&gt; &amp; dad')
      && !card.includes('<mom>') && !card.includes('<grandma>'), `edit card: ${JSON.stringify(card)}`);
  });

  await check('the delete card escapes the title', async () => {
    reset();
    await showDeleteConfirmation(1001, undefined, reminder('Call <mom> & dad', '2026-10-15T07:00:00.000Z'), 'native:c1', 'delete it', raziel);
    const card = sent[sent.length - 1]?.text ?? '';
    assert(card.includes('📅 <b>Call &lt;mom&gt; &amp; dad</b>') && !card.includes('<mom>'), `delete card: ${JSON.stringify(card)}`);
  });

  await check('the native provider hands back the pings a re-arm cleared, and nothing new for an event', async () => {
    reset();
    storeUpdate = { canonicalEventId: 'r1', clearedPings: [{ chatId: 1002n, messageId: 12 }] };
    const moved = await nativeProvider.updateEvent(raziel, 'native:c1', 'r1', { startTime: NOW, endTime: NOW, scope: 'single' });
    assert(moved.success && moved.clearedPings?.length === 1 && moved.clearedPings[0].chatId === 1002n && moved.clearedPings[0].messageId === 12,
      `moved: ${JSON.stringify(moved, (_k, v) => (typeof v === 'bigint' ? String(v) : v))}`);
    storeUpdate = { canonicalEventId: 'e1', clearedPings: [] };
    const plain = await nativeProvider.updateEvent(raziel, 'native:c1', 'e1', { title: 'Dentist', scope: 'single' });
    assert(JSON.stringify(plain) === '{"success":true,"eventId":"e1"}', `event: ${JSON.stringify(plain)}`);
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

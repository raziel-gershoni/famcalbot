// Smoke test for the briefing as a browser notification (web push spec §3.5, plan Task 10): an account with no chat and a
// device gets the morning and evening briefing as one short line, from the day the summary already reads.
//
// Covered:
//   - the line (src/services/web-push/briefing-line.ts): all-day items first, then the timed ones by start, up to three
//     names, "and N more" in its language's plural form (en, he, ru), times on the person's own clock in 24 hours (a
//     winter and a summer day, a zone that is not the server's), a long name cut, no title in the log;
//   - the batch (sendSummaryToAll in src/services/telegram/summary.ts): a no-chat account with a device gets one push
//     (kind briefing, "Today" or "Tomorrow" in its language, the day tag, the home address), with no model call and no
//     usage counted, and is marked sent; a Telegram account in the same batch is unchanged; a no-chat account with no
//     device, or with push off, is skipped with today's line; text summaries off, an empty day and the Shabbat and Yom
//     Tov pause send nothing; a push no device took and a push service asked to retry is not marked; a Google read that
//     fails is retried once, as for a chat, and the push goes after it.
//
// The real summary.ts, the digest reader, the briefing line, bot messages, summary scheduling and the pause run. Faked:
// the reader's readRange, the clock, Redis (in memory), the database, the users, the AI (it must not be called), Telegram,
// the voice note, the quota, error capture, the admin notifier and sendWebPush (every call recorded). No network, no DB.
//
// Run under both clocks; the output must not depend on the server's timezone:
//   TZ=UTC npx tsx scripts/smoke-push-briefing.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-push-briefing.ts

import Module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromZonedTime } from 'date-fns-tz';
import type { CalendarAssignment, CalendarEvent, UserConfig } from '../src/types';
import type { RangeRead, ReadItem, ReadRangeOptions } from '../src/services/calendar-read/types';
import type { AICompletionResult } from '../src/services/ai-provider';

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

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

function same(got: unknown, want: unknown, what: string) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  assert(g === w, `${what}\n     got  ${g}\n     want ${w}`);
}

process.env.NEXT_PUBLIC_APP_URL = 'https://famcal.test';
// Push is configured (the keys are never used to sign here: sendWebPush is faked)
process.env.VAPID_PUBLIC_KEY = 'smoke-public-key';
process.env.VAPID_PRIVATE_KEY = 'smoke-private-key';
/** Any request that slips past the fakes is refused and counted. */
const networkAttempts: string[] = [];
globalThis.fetch = (async (input: unknown) => {
  networkAttempts.push(String(input));
  throw new Error(`network is blocked in this smoke test: ${String(input)}`);
}) as typeof fetch;

// ---- Clock: every argument-less new Date() and Date.now() reads `clock` ----

const IL = 'Asia/Jerusalem';
const il = (local: string) => fromZonedTime(local, IL).getTime();

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

// ---- What happened ----

/** Every console line of the run so far (cleared by reset). */
let logs: string[] = [];
let marks: string[] = [];
let telegramSent: { chatId: number; text: string }[] = [];
let aiCalls = 0;
let usageCounted: string[] = [];
let captured: { context: string; message: string }[] = [];
let reads: string[] = [];
type PushCall = { userId: number; input: Record<string, unknown> };
let pushes: PushCall[] = [];
/** What the next sendWebPush answers. */
let pushResult = { sent: 1, total: 1, retriable: false };

// ---- Users ----

const cal = (calendarId: string, name: string): CalendarAssignment => ({ calendarId, labels: ['yours'], name, color: '#039BE5' });

function person(id: number, name: string, over: Record<string, unknown>): UserConfig {
  return {
    id, telegramId: null, name, englishName: name, gender: 'female', language: 'en', culture: 'default', calendarSource: 'NATIVE', googleRefreshToken: '',
    location: '', weatherEnabled: false, textSummaryEnabled: true, voiceSummaryEnabled: true, messagingPlatform: 'telegram',
    isAdmin: false, suspendedAt: null, unreachableSince: null, globalRules: [], includeLookaheadInTomorrow: false,
    preferredMorningHour: 7, preferredEveningHour: 19, dailySummaryDays: [0, 1, 2, 3, 4, 5, 6], tomorrowSummaryDays: [0, 1, 2, 3, 4, 5, 6],
    pushDeviceCount: 0,
    ...over,
  } as unknown as UserConfig;
}

/** An account made on famcal.bot with one browser on. */
const MAYA = person(31, 'Maya', { pushDeviceCount: 1 });
const MAYA_HE = person(32, 'Michal', { pushDeviceCount: 2, language: 'he' });
/** No chat and no device: nothing to send to. */
const NODEV = person(33, 'Nadav', {});
/** A Telegram account in the same batch: the summary is as it always was. */
const TAMAR = person(34, 'Tamar', { telegramId: 3400 });
/** Text summaries off. */
const OFFER = person(35, 'Omer', { pushDeviceCount: 1, textSummaryEnabled: false });
/** The Shabbat and Yom Tov pause is on for her, in Jerusalem (Sephardi): Shabbat runs from Friday 17:50 to Saturday 18:39, 2026-10-16/17. */
const PIA = person(36, 'Pia', { pushDeviceCount: 1, pauseOnShabbat: true, zmanimCommunity: 'sephardi', latitude: 31.778, longitude: 35.235, elevationM: 754 });
/** Nothing on her day. */
const EMPTY = person(37, 'Elad', { pushDeviceCount: 1 });
/** A FamCal account that connected Google: FamCal and Google in one read. */
const GAIA = person(38, 'Gaia', { pushDeviceCount: 1, googleRefreshToken: 'refresh-token', calendarAssignments: [cal('gaia@gmail.com', 'Gaia G')] });
/** A read that breaks. */
const BREAKER = person(39, 'Boaz', { pushDeviceCount: 1 });
/** A place and the weather on, but no calendar: a chat gets the weather-only message, a browser briefing has none. */
const NOCAL = person(40, 'Noy', { pushDeviceCount: 1, location: 'Tel Aviv', weatherEnabled: true });
const EVERYONE = [MAYA, MAYA_HE, NODEV, TAMAR, OFFER, PIA, EMPTY, GAIA, BREAKER, NOCAL];
const nameOfChat = (chatId: unknown) => EVERYONE.find(u => u.telegramId === Number(chatId))?.name ?? `chat ${String(chatId)}`;

let batch: UserConfig[] = [];

// ---- The reader ----

type Outcome = 'ok' | 'fail' | 'boom';
let plans = new Map<number, Outcome[]>();

function item(user: UserConfig, event: CalendarEvent): ReadItem {
  return {
    source: 'famcal', key: `famcal|${event.summary}`, event: { ...event, provider: 'native' },
    calendar: { id: event.calendarId, source: 'famcal', name: event.calendarName, color: null, mine: true, inLegend: true },
    title: event.summary, kind: 'event', seriesId: null, originalStart: null, recurring: false, rrule: null, hebrewRule: null, hebrewAnchor: null,
  };
}

const at = (day: string, time: string) => new RealDate(il(`${day} ${time}:00`)).toISOString();
function timed(user: UserConfig, day: string, summary: string, from: string, to: string): CalendarEvent {
  return { summary, start: at(day, from), end: at(day, to), calendarId: 'native:cal', calendarName: user.name };
}
function allDay(user: UserConfig, day: string, summary: string): CalendarEvent {
  const next = new RealDate(`${day}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return { summary, start: day, end: next.toISOString().slice(0, 10), calendarId: 'native:cal', calendarName: user.name };
}

/** The day's events of a user; the default is two timed ones. */
const eventsOf = new Map<number, (user: UserConfig, day: string) => CalendarEvent[]>();
const defaultEvents = (user: UserConfig, day: string) => [timed(user, day, 'Pickup', '16:00', '16:30'), timed(user, day, 'Dentist', '09:00', '10:00')];

async function readRange(user: UserConfig, fromKey: string, toKey: string, opts: ReadRangeOptions): Promise<RangeRead> {
  const famcalOnly = !!opts.sources && opts.sources.length === 1 && opts.sources[0] === 'famcal';
  reads.push(`${user.name} ${fromKey}${famcalOnly ? ' famcal' : ''}`);
  const window = { from: new RealDate(il(`${fromKey} 00:00:00`)), to: new RealDate(il(`${toKey} 00:00:00`)) };
  const items = (eventsOf.get(user.id) ?? defaultEvents)(user, fromKey).map(e => item(user, e));
  const famcal = { status: 'ok' as const, ctx: { viewerId: user.id, partner: null }, calendars: [], partner: null };
  if (famcalOnly) return { window, items, famcal };
  const outcome = plans.get(user.id)?.shift() ?? 'ok';
  if (outcome === 'boom') throw new Error(`the read for ${user.name} broke`);
  if (user.googleRefreshToken) {
    const google: RangeRead['google'] = outcome === 'fail'
      ? { status: 'error', reason: 'transient', cause: new Error('rateLimitExceeded') }
      : { status: 'ok', calendars: [], goneIds: [], partial: null, stale: false };
    return { window, items, google, famcal };
  }
  return { window, items, famcal };
}

// ---- Redis, in memory: the dedup marks ----

const store = new Map<string, string>();
const fakeRedis = {
  get: async (key: string) => store.get(key) ?? null,
  set: async (key: string, value: unknown) => {
    if (key.startsWith('summary:dedup:')) {
      const [, , type, userId, date] = key.split(':');
      marks.push(`${EVERYONE.find(u => u.id === Number(userId))?.name} ${type} ${date}`);
    }
    store.set(key, String(value));
    return 'OK';
  },
  del: async (key: string) => (store.delete(key) ? 1 : 0),
};

// ---- Telegram ----

const telegram = {
  sendMessage: async (chatId: number | string, text: string) => {
    telegramSent.push({ chatId: Number(chatId), text });
    return 1;
  },
  updateMessage: async () => {},
  deleteMessage: async () => {},
  sendTypingIndicator: async () => undefined,
};

/** The AI: a push briefing must never reach it, a Telegram summary answers with the user's name. */
async function generateAICompletion(prompt: string): Promise<AICompletionResult> {
  aiCalls++;
  const named = EVERYONE.filter(u => prompt.includes(u.name));
  return { text: `Summary for ${named.length === 1 ? named[0].name : '?'}`, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end_turn', model: 'fake-model', durationMs: 0 };
}

// ---- Stubs: static imports go through Module._load, import() through the ES module hooks ----

const SRC = path.resolve(__dirname, '../src');
const stubs: Record<string, object> = {
  [`${SRC}/services/calendar-read/index.ts`]: {
    readRange,
    sourcesFor: (u: UserConfig) => (u.googleRefreshToken ? ['famcal', 'google'] : ['famcal']),
  },
  [`${SRC}/services/calendar-provider/index.ts`]: {
    getCalendarAssignmentsForUser: async (u: UserConfig) => (u.id === NOCAL.id ? [] : [cal('native:cal', u.name), ...(u.calendarAssignments ?? [])]),
  },
  [`${SRC}/services/user-service.ts`]: {
    getAllUsers: async () => batch,
    getUserByIdentifier: async () => null,
    getWhatsAppChatId: (u: UserConfig) => u.whatsappPhone || u.whatsappBsuid || null,
  },
  [`${SRC}/services/native-reminders/open-reminders.ts`]: {
    addDigestReminders: async (_user: UserConfig, events: CalendarEvent[]) => ({ events, moreCount: 0 }),
  },
  [`${SRC}/services/ai-provider.ts`]: {
    generateAICompletion,
    streamAICompletion: async () => {
      throw new Error('a scheduled summary never streams');
    },
  },
  [`${SRC}/services/telegram/bot.ts`]: { getMessagingService: () => telegram },
  [`${SRC}/services/messaging/index.ts`]: {
    MessagingPlatform: { TELEGRAM: 'telegram', WHATSAPP: 'whatsapp' },
    MessageFormat: { HTML: 'html', MARKDOWN: 'markdown', PLAIN: 'plain' },
    getMessagingService: () => {
      throw new Error('no WhatsApp user in this smoke');
    },
  },
  [`${SRC}/services/telegram/voice.ts`]: { sendVoiceMessage: async () => {}, sendWeeklyVoiceMessage: async () => {} },
  [`${SRC}/services/telegram/commands.ts`]: { sendSetupNudgeIfNeeded: async () => false },
  [`${SRC}/services/analytics-service.ts`]: { trackActivityAsync: () => {}, addBreadcrumb: () => {} },
  [`${SRC}/services/subscription-service.ts`]: {
    checkFeatureAccess: async () => ({ allowed: true }),
    incrementUsage: async (userId: number, what: string) => {
      usageCounted.push(`${userId}:${what}`);
    },
  },
  [`${SRC}/lib/timezone.ts`]: { resolveUserTimezone: async () => IL },
  [`${SRC}/utils/redis.ts`]: { redis: fakeRedis },
  [`${SRC}/utils/prisma.ts`]: { prisma: {} },
  [`${SRC}/utils/encryption.ts`]: { safeDecrypt: (value: string) => value, readStoredToken: (value: string) => value },
  [`${SRC}/lib/error-capture.ts`]: {
    captureError: (error: unknown, context: string) => {
      captured.push({ context, message: error instanceof Error ? error.message : String(error) });
    },
    captureWarning: (message: string, context: string) => {
      captured.push({ context, message });
    },
    captureInfo: () => {},
  },
  [`${SRC}/utils/error-notifier.ts`]: { notifyAdminWarning: async () => {}, notifyAdminError: async () => {} },
  // The sender is its own task's (send.ts): here it only records what summary.ts hands it
  [`${SRC}/services/web-push/send.ts`]: {
    sendWebPush: async (user: { id: number }, input: Record<string, unknown>) => {
      pushes.push({ userId: user.id, input });
      return pushResult;
    },
  },
};

const ModuleInternals = Module as unknown as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  _resolveFilename: (request: string, parent: unknown, isMain: boolean) => string;
};
// @hebcal/core is ESM-only and tsx loads src/ as CommonJS (see smoke-summary-retry.ts).
const resolveFilename = ModuleInternals._resolveFilename;
ModuleInternals._resolveFilename = function (request, parent, isMain) {
  if (request === '@hebcal/core') return path.resolve(__dirname, '../node_modules/@hebcal/core/dist/esm/index.js');
  return resolveFilename.call(this, request, parent, isMain);
};
const realLoad = ModuleInternals._load;
ModuleInternals._load = function (request, parent, isMain) {
  let resolved = request;
  try {
    resolved = ModuleInternals._resolveFilename(request, parent, isMain);
  } catch {}
  return stubs[resolved] ?? realLoad.call(this, request, parent, isMain);
};
(globalThis as { smokeStubs?: typeof stubs }).smokeStubs = stubs;
Module.registerHooks({
  load(url, context, nextLoad) {
    const file = url.startsWith('file:') ? fileURLToPath(url.split('?')[0]) : '';
    const stub = stubs[file];
    if (!stub) return nextLoad(url, context);
    const names = Object.keys(stub).map(name => `export const ${name} = fake.${name};`).join('\n');
    return { format: 'module', shortCircuit: true, source: `const fake = globalThis.smokeStubs[${JSON.stringify(file)}];\n${names}\n` };
  },
});

// ---- One scheduled run ----

/** Friday 16 October 2026, 07:00 in Israel: every user's morning hour. */
const MORNING = il('2026-10-16 07:00:00');
/** Saturday 17 October 2026, 07:00 in Israel: inside Shabbat. */
const SHABBAT_MORNING = il('2026-10-17 07:00:00');
/** Friday 16 October 2026, 19:00 in Israel: every user's evening hour. */
const EVENING = il('2026-10-16 19:00:00');

function reset(users: UserConfig[], startAt = MORNING) {
  batch = users;
  plans = new Map();
  eventsOf.clear();
  clock = startAt;
  logs = [];
  marks = [];
  telegramSent = [];
  aiCalls = 0;
  usageCounted = [];
  captured = [];
  reads = [];
  pushes = [];
  pushResult = { sent: 1, total: 1, retriable: false };
  store.clear();
}

const pushesOf = (name: string) => pushes.filter(p => EVERYONE.find(u => u.id === p.userId)?.name === name).map(p => p.input);
const readsOf = (name: string) => reads.filter(r => r.startsWith(`${name} `));
const logged = (prefix: string) => logs.filter(l => l.startsWith(prefix));

async function main() {
  const summary = await import('../src/services/telegram/summary');
  const { briefingItems, buildBriefingBody, BRIEFING_NAME_MAX_CHARS } = await import('../src/services/web-push/briefing-line');
  const sleeps: number[] = [];
  summary.__setSummaryConcurrencyForTests(1);
  summary.__setScheduledRetrySleepForTests(async (ms: number) => {
    sleeps.push(ms);
    clock += ms;
  });
  const realLog = console.log;
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    console[level] = (...args: unknown[]) => {
      logs.push(args.map(a => (typeof a === 'string' ? a : a instanceof Error ? a.message : JSON.stringify(a))).join(' '));
    };
  }

  // ---- The line ----

  const ev = (summaryText: string, start: string, over: Partial<CalendarEvent> = {}): CalendarEvent =>
    ({ summary: summaryText, start, end: start, calendarId: 'c', calendarName: 'c', ...over });

  await check('the line: all-day items first, then the timed ones by start (the input order does not matter), times 24 hours on the person\'s clock', async () => {
    const events = [
      ev('Pickup', '2026-12-01T14:00:00.000Z'),
      ev('Dentist', '2026-12-01T07:00:00.000Z'),
      ev('School trip', '2026-12-01', { end: '2026-12-02' }),
    ];
    same(briefingItems(events, IL), [{ name: 'School trip', time: null }, { name: 'Dentist', time: '09:00' }, { name: 'Pickup', time: '16:00' }], 'Jerusalem, winter');
    same(briefingItems(events, 'America/New_York').map(i => i.time), [null, '02:00', '09:00'], 'New York is 24 hours too, not 2:00 AM');
    // Israel's summer time: the same UTC instant is an hour later on the clock
    same(briefingItems([ev('Dentist', '2026-07-01T07:00:00.000Z')], IL).map(i => i.time), ['10:00'], 'Jerusalem, summer');
    same(briefingItems([ev('Dentist', '2026-10-25T22:30:00.000Z')], IL).map(i => i.time), ['00:30'], 'the night summer time ends (UTC+2 from 01:00 on the 25th)');
  });

  await check('the line: an item that started before the day or has only a date has no time; a reminder by zman has its zman; a carried-over open reminder and a nameless item are not listed', async () => {
    const events = [
      ev('Sleepover', '2026-12-01T18:00:00.000Z', { daySpan: 'continues' }),
      ev('Conference', '2026-11-30T08:00:00.000Z', { daySpan: 'spansDay' }),
      ev('Call the plumber', '2026-12-01', { eventType: 'reminder', reminder: { ownerIsViewer: true, creatorIsViewer: true } }),
      ev('Light candles', '2026-12-01', { eventType: 'reminder', reminder: { ownerIsViewer: true, creatorIsViewer: true, zmanAt: '2026-12-01T14:41:00.000Z' } }),
      ev('Old bill', '2026-11-28', { eventType: 'reminder', reminder: { ownerIsViewer: true, creatorIsViewer: true, open: true, openSince: '2026-11-28' } }),
      ev('   ', '2026-12-01T08:00:00.000Z'),
      ev('', '2026-12-01T08:30:00.000Z'),
      ev('Late', 'not a date'),
    ];
    same(briefingItems(events, IL), [
      { name: 'Sleepover', time: null }, { name: 'Conference', time: null }, { name: 'Call the plumber', time: null }, { name: 'Late', time: null },
      { name: 'Light candles', time: '16:41' },
    ], 'items');
  });

  await check('the line: a name is one line and at most 40 characters, cut on whole characters (an emoji is not split)', async () => {
    const long = briefingItems([ev('Parents\' evening\nat the\t\tschool, with a very long name indeed', '2026-12-01')], IL)[0].name;
    assert(!/\s{2}|\n|\t/.test(long) && Array.from(long).length <= BRIEFING_NAME_MAX_CHARS && Array.from(long).length >= BRIEFING_NAME_MAX_CHARS - 2 && long.endsWith('…'), `name ${JSON.stringify(long)}`);
    const emoji = briefingItems([ev('\u{1F600}'.repeat(60), '2026-12-01')], IL)[0].name;
    assert(Array.from(emoji).length === BRIEFING_NAME_MAX_CHARS && !/[\uD800-\uDFFF](?![\uDC00-\uDFFF])/.test(emoji.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')), `emoji name ${JSON.stringify(emoji)}`);
    same(briefingItems([ev('Short', '2026-12-01')], IL)[0].name, 'Short', 'a short name is as it is');
  });

  const six = ['A', 'B', 'C', 'D', 'E', 'F'].map((n, i) => ev(n, `2026-12-01T0${i + 1}:00:00.000Z`));
  const bodyOf = async (events: CalendarEvent[], lang: string) => (await buildBriefingBody(events, 'UTC', lang))?.body;

  await check('the line: up to three names, then "and N more" in the language\'s own plural form (en, he, ru)', async () => {
    same(await bodyOf(six.slice(0, 2), 'en'), 'A 01:00, B 02:00', 'two items');
    same(await bodyOf(six.slice(0, 3), 'en'), 'A 01:00, B 02:00, C 03:00', 'exactly three: no "more"');
    same(await bodyOf(six.slice(0, 4), 'en'), 'A 01:00, B 02:00, C 03:00 and 1 more', 'en, one more');
    same(await bodyOf(six, 'en'), 'A 01:00, B 02:00, C 03:00 and 3 more', 'en, three more');
    same(await bodyOf(six.slice(0, 4), 'he'), 'A 01:00, B 02:00, C 03:00 ועוד אחד', 'he, one more');
    same(await bodyOf(six.slice(0, 5), 'he'), 'A 01:00, B 02:00, C 03:00 ועוד שניים', 'he, two more');
    same(await bodyOf(six, 'he'), 'A 01:00, B 02:00, C 03:00 ועוד 3', 'he, three more');
    same(await bodyOf(six.slice(0, 4), 'ru'), 'A 01:00, B 02:00, C 03:00 и ещё 1', 'ru, one more (a no-break space after the one-letter word)');
    same(await bodyOf(six, 'ru'), 'A 01:00, B 02:00, C 03:00 и ещё 3', 'ru, three more');
    same(await bodyOf(six.slice(0, 4), 'fr'), 'A 01:00, B 02:00, C 03:00 and 1 more', 'an unknown language reads as English');
  });

  await check('the line: an empty day has no line', async () => {
    assert((await buildBriefingBody([], IL, 'en')) === null, 'empty events');
    assert((await buildBriefingBody([ev('', '2026-12-01')], IL, 'en')) === null, 'only a nameless item');
  });

  // ---- The batch ----

  reset([MAYA, MAYA_HE, NODEV, TAMAR, OFFER]);
  const daily = await summary.sendDailySummaryToAll({ filterByHour: true });
  const dailyLogs = [...logs];

  await check('daily: an account with no chat and a device gets one briefing push (kind, title "Today", the home, the day\'s tag, its language), built from the day it reads', () => {
    same(pushesOf('Maya'), [{
      kind: 'briefing', title: 'Today', body: 'Dentist 09:00, Pickup 16:00', url: 'https://famcal.test/en/dashboard?user_id=31', tag: 'briefing-today', lang: 'en',
    }], 'Maya\'s push');
    same(pushesOf('Michal'), [{
      kind: 'briefing', title: 'היום', body: 'Dentist 09:00, Pickup 16:00', url: 'https://famcal.test/he/dashboard?user_id=32', tag: 'briefing-today', lang: 'he',
    }], 'Michal\'s push');
  });

  await check('daily: no model call and no usage for a push; the Telegram account in the same batch gets its AI summary, unchanged, and no push', () => {
    same(telegramSent.map(s => [nameOfChat(s.chatId), s.text]), [['Tamar', 'Summary for Tamar']], 'Telegram sends');
    assert(aiCalls === 1, `the model was called ${aiCalls} times (only Tamar\'s summary should)`);
    same(usageCounted, ['34:textSummaries'], 'usage counted');
    same(pushesOf('Tamar'), [], 'Tamar\'s pushes');
  });

  await check('daily: the push account is marked sent with the same dedup key as a chat; the account with no device is skipped with today\'s line and read not at all; text summaries off reads and sends nothing', () => {
    same(marks.sort(), ['Maya daily 2026-10-16', 'Michal daily 2026-10-16', 'Omer daily 2026-10-16', 'Tamar daily 2026-10-16'].sort(), 'dedup marks');
    same(readsOf('Nadav'), [], 'Nadav\'s reads');
    assert(dailyLogs.includes('[Summary] Skipping user 33: no Telegram and no WhatsApp to deliver to'), `no skip line: ${JSON.stringify(dailyLogs.filter(l => l.includes('33')))}`);
    same(pushesOf('Nadav'), [], 'Nadav\'s pushes');
    same(readsOf('Omer'), [], 'Omer\'s reads');
    same(pushesOf('Omer'), [], 'Omer\'s pushes');
    assert(dailyLogs.includes('[push-briefing] skipped user 35: text summaries are off'), `no off line: ${JSON.stringify(dailyLogs.filter(l => l.includes('push-briefing')))}`);
  });

  await check('daily: processed counts the briefings and summaries that went out (Maya, Michal, Tamar), not the skipped', () => {
    assert(daily.processed === 3, `processed ${daily.processed}`);
  });

  reset([EMPTY]);
  eventsOf.set(EMPTY.id, () => []);
  await summary.sendDailySummaryToAll({ filterByHour: true });
  await check('daily: an empty day sends nothing, says so in one line, and is marked', () => {
    same(pushes, [], 'pushes');
    same(logged('[push-briefing]'), ['[push-briefing] skipped user 37: nothing on today'], 'log lines');
    same(marks, ['Elad daily 2026-10-16'], 'marks');
  });

  reset([MAYA], EVENING);
  const tomorrow = await summary.sendTomorrowSummaryToAll({ filterByHour: true });
  await check('tomorrow: the evening briefing reads tomorrow, "Tomorrow", its own tag and dedup key', () => {
    same(pushesOf('Maya'), [{
      kind: 'briefing', title: 'Tomorrow', body: 'Dentist 09:00, Pickup 16:00', url: 'https://famcal.test/en/dashboard?user_id=31', tag: 'briefing-tomorrow', lang: 'en',
    }], 'Maya\'s push');
    same(readsOf('Maya'), ['Maya 2026-10-17'], 'the day read');
    same(marks, ['Maya tomorrow 2026-10-16'], 'marks');
    assert(tomorrow.processed === 1, `processed ${tomorrow.processed}`);
  });

  reset([MAYA], EVENING);
  eventsOf.set(MAYA.id, (u, day) => [allDay(u, day, 'Trip'), timed(u, day, 'Late', '23:30', '23:59'), timed(u, day, 'Early', '06:00', '07:00'), timed(u, day, 'Lunch', '12:00', '13:00'), timed(u, day, 'Dinner', '19:30', '21:00')]);
  await summary.sendTomorrowSummaryToAll({ filterByHour: true });
  await check('tomorrow: all-day first, then by start, three names and the rest counted, from the real day read', () => {
    same(pushesOf('Maya').map(p => p.body), ['Trip, Early 06:00, Lunch 12:00 and 2 more'], 'body');
  });

  // The pause
  reset([PIA], SHABBAT_MORNING);
  const paused = await summary.sendDailySummaryToAll({ filterByHour: true });
  await check('the pause: inside Shabbat nothing is read or sent and no dedup mark is written (the pause check that was already there)', () => {
    same(pushes, [], 'pushes');
    same(reads, [], 'reads');
    same(marks, [], 'marks');
    assert(paused.skippedPause === 1 && paused.processed === 0, `result ${JSON.stringify(paused)}`);
    assert(logs.includes('[pause] skipped daily summary for 36'), `no pause line: ${JSON.stringify(logs)}`);
  });

  // Push off
  reset([MAYA]);
  delete process.env.VAPID_PRIVATE_KEY;
  await summary.sendDailySummaryToAll({ filterByHour: true });
  process.env.VAPID_PRIVATE_KEY = 'smoke-private-key';
  await check('push off (a key not set): the account is skipped as before, with today\'s line, and nothing is read or sent', () => {
    same(pushes, [], 'pushes');
    same(reads, [], 'reads');
    same(marks, [], 'marks');
    assert(logs.includes('[Summary] Skipping user 31: no Telegram and no WhatsApp to deliver to'), `no skip line: ${JSON.stringify(logs)}`);
  });

  // No device took it
  reset([MAYA]);
  pushResult = { sent: 0, total: 1, retriable: true };
  const retried = await summary.sendDailySummaryToAll({ filterByHour: true });
  await check('a push no device took and a push service asked to retry: not counted, not marked (so a rerun in the hour can try again)', () => {
    same(marks, [], 'marks');
    assert(retried.processed === 0, `processed ${retried.processed}`);
    assert(logs.includes('[push-briefing] user 31: no device took the today briefing and a push service asked to try again; not marked sent'), `no retry line: ${JSON.stringify(logs.filter(l => l.includes('push-briefing')))}`);
  });

  reset([MAYA]);
  pushResult = { sent: 0, total: 0, retriable: false };
  const gone = await summary.sendDailySummaryToAll({ filterByHour: true });
  await check('a push whose devices were all gone (404/410 deleted them): not counted, marked (nothing to retry)', () => {
    same(marks, ['Maya daily 2026-10-16'], 'marks');
    assert(gone.processed === 0, `processed ${gone.processed}`);
  });

  // A broken read
  reset([BREAKER, MAYA]);
  plans.set(BREAKER.id, ['boom']);
  const broke = await summary.sendDailySummaryToAll({ filterByHour: true });
  await check('a read that breaks: logged and sent to Sentry, no push and no mark for that account, and the next account is still served', () => {
    same(pushesOf('Boaz'), [], 'Boaz\'s pushes');
    same(pushesOf('Maya').length, 1, 'Maya\'s pushes');
    same(marks, ['Maya daily 2026-10-16'], 'marks');
    same(captured.map(c => c.context), ['summary-batch-user'], 'Sentry');
    assert(broke.processed === 1, `processed ${broke.processed}`);
  });

  // No calendar
  reset([NOCAL]);
  await summary.sendDailySummaryToAll({ filterByHour: true });
  await check('no calendar: a browser account with a place and the weather on gets no weather-only message (that is a chat message): nothing is sent, read or marked, and the skip is logged', () => {
    same(pushes, [], 'pushes');
    same(reads, [], 'reads');
    same(marks, [], 'marks');
    same(captured, [], 'Sentry (a weather lookup would have been tried and blocked)');
    assert(logs.includes('[Summary] Skipping user 40: No calendars'), `no skip line: ${JSON.stringify(logs)}`);
  });

  // Google retry
  reset([GAIA]);
  plans.set(GAIA.id, ['fail', 'ok']);
  await summary.sendDailySummaryToAll({ filterByHour: true });
  await check('a Google read that fails once is set aside and retried, as for a chat: the push goes after the wait, once, and is marked once', () => {
    same(sleeps.length, 1, 'waits');
    same(pushesOf('Gaia').length, 1, 'Gaia\'s pushes');
    same(marks, ['Gaia daily 2026-10-16'], 'marks');
  });

  reset([GAIA]);
  sleeps.length = 0;
  plans.set(GAIA.id, ['fail', 'fail']);
  await summary.sendDailySummaryToAll({ filterByHour: true });
  await check('a Google read that fails twice: the outage run reads FamCal only, the line is FamCal\'s items and the log says Google\'s are missing', () => {
    same(readsOf('Gaia'), ['Gaia 2026-10-16', 'Gaia 2026-10-16', 'Gaia 2026-10-16 famcal'], 'reads');
    same(pushesOf('Gaia').map(p => p.body), ['Dentist 09:00, Pickup 16:00'], 'body');
    assert(logs.includes('[push-briefing] user 38: Google\'s events are missing from the today read (outage); the line has FamCal\'s items'), `no outage line: ${JSON.stringify(logs.filter(l => l.includes('push-briefing')))}`);
    same(marks, ['Gaia daily 2026-10-16'], 'marks');
  });

  await check('no title, address or token reached a log line, and nothing used the network', () => {
    // Every line of the last scenarios, plus the batch before them
    const everything = [...dailyLogs, ...logs].join('\n');
    assert(!/Dentist|Pickup|School trip|famcal\.test|smoke-public-key|smoke-private-key/.test(everything), `a log line holds content: ${everything.split('\n').filter(l => /Dentist|Pickup|famcal\.test|smoke-/.test(l)).join(' | ')}`);
    same(networkAttempts, [], 'network');
  });

  summary.__setScheduledRetrySleepForTests(null);
  console.log = realLog;

  let passed = 0;
  for (const r of results) {
    if (r.ok) passed++;
    realLog(`${r.ok ? 'OK  ' : 'FAIL'} ${r.name}${r.ok ? '' : `\n     ${r.reason}`}`);
  }
  realLog(`\n${passed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

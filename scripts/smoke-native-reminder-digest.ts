// Smoke test for built-in calendar reminders in the daily digests:
// src/services/native-reminders/open-reminders.ts, the reminder split in
// categorizeEvents (src/services/telegram/summary.ts) and the summary prompt claude.ts
// builds. A reminder stays in the digests until it is done: on its day a done one leaves
// the list and a past-due one is "(open)"; older undone ones are carried over as "open
// since <day>", to its owner and its creator only, newest first, five at most. A daily
// reminder ignored for two weeks shows once, not fourteen times, and a repeating one's
// occurrence from before it was armed (created or re-timed) is never carried. Reminders are filed by
// whose they are, never under "other" (that feeds the kid-name follow-up). Prisma and
// the AI are faked. No network, no DB.
//
// Run under both clocks; the output must not depend on the server's timezone:
//   TZ=UTC npx tsx scripts/smoke-native-reminder-digest.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-native-reminder-digest.ts

import path from 'path';
import { fromZonedTime } from 'date-fns-tz';
import type { NativeEvent, NativeEventInstance } from '@prisma/client';
import { startOfLocalDay } from '../src/utils/day-events';
import { formatEventForPrompt } from '../src/utils/event-formatter';
import type { CalendarAssignment, CalendarEvent, ReminderInfo, UserConfig } from '../src/types';
import type { OpenReminderCandidate } from '../src/services/native-reminders/open-reminders';
import type { PartnerSummary, ViewerContext } from '../src/services/native-reminders/ownership';

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

function assertList(got: string[], want: string[]) {
  assert(JSON.stringify(got) === JSON.stringify(want), `\n     got  ${JSON.stringify(got, null, 1)}\n     want ${JSON.stringify(want, null, 1)}`);
}

// ---- Environment: fakes only, set before anything under test loads ----

process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.DATABASE_URL = 'postgresql://test@db.invalid/test';
process.env.UPSTASH_REDIS_REST_URL = 'https://redis.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.GEMINI_API_KEY = 'test-key';
globalThis.fetch = (async (input: unknown) => {
  throw new Error(`network is blocked in this smoke test: ${String(input)}`);
}) as typeof fetch;

const IL = 'Asia/Jerusalem';
/** Wall-clock time in Israel. */
const il = (local: string) => fromZonedTime(local, IL);

// ---- Viewers: Raziel (1) and his ACTIVE partner Dana (2), both on the built-in calendar ----

const dana: PartnerSummary = { id: 2, name: 'Dana', englishName: 'Dana', gender: 'female', calendarSource: 'NATIVE', telegramId: null, language: 'en' };
const razielCtx: ViewerContext = { viewerId: 1, partner: dana };

const OWN: ReminderInfo = { ownerIsViewer: true, creatorIsViewer: true };
const FROM_DANA: ReminderInfo = { ownerIsViewer: true, creatorIsViewer: false, creatorName: 'Dana' };
const FOR_DANA: ReminderInfo = { ownerIsViewer: false, creatorIsViewer: true, ownerName: 'Dana' };

// ---- Reminder series as the carry-over reads them ----

const CALENDAR = { id: 'cal-raziel', name: 'Raziel' };

/** A REMINDER series, by Raziel for himself unless `over` says otherwise. */
function series(title: string, startsAt: Date, over: Partial<NativeEvent> = {}): NativeEvent {
  return {
    id: title.toLowerCase().replace(/\W+/g, '-'),
    calendarId: CALENDAR.id,
    creatorUserId: 1,
    title,
    description: null,
    location: null,
    startsAt,
    endsAt: startsAt,
    allDay: false,
    timeZone: IL,
    rrule: null,
    hebrewRule: null,
    hebrewAnchor: null,
    exdates: [],
    reminderMinutes: null,
    kind: 'REMINDER',
    forUserId: null,
    armedAt: startsAt,
    isDeleted: false,
    createdAt: startsAt,
    updatedAt: startsAt,
    ...over,
  };
}

/** A date-only reminder: zero length at the start of its day in Israel. */
const dateOnly = (title: string, day: string, over: Partial<NativeEvent> = {}) =>
  series(title, startOfLocalDay(day, IL), { allDay: true, ...over });

type StateRow = OpenReminderCandidate['states'][number];
const done = (originalStartsAt: Date): StateRow => ({ originalStartsAt, doneAt: new Date(originalStartsAt.getTime() + 60_000), snoozedUntil: null });
const snoozed = (originalStartsAt: Date, until: Date): StateRow => ({ originalStartsAt, doneAt: null, snoozedUntil: until });

const candidate = (s: NativeEvent, states: StateRow[] = [], overrides: NativeEventInstance[] = []): OpenReminderCandidate =>
  ({ series: s, calendar: CALENDAR, overrides, states });

/** Seven open one-offs, Monday 5 Oct to Sunday 11 Oct at noon: two past the cap. */
const SEVEN_TASKS = [5, 6, 7, 8, 9, 10, 11].map(d => candidate(series(`Task ${d}`, il(`2026-10-${String(d).padStart(2, '0')} 12:00:00`))));

/** The summary prompt's line for each event, as the digest would list it. */
const linesOf = (events: CalendarEvent[], day: string) => events.map(e => formatEventForPrompt(e, 0, IL, day).slice(3));

// Wednesday 14 Oct 2026 in Israel: the morning digest at 08:00 covers Wednesday and
// carries over what is open from before Wednesday.
const WEDNESDAY = '2026-10-14';
const MORNING = il('2026-10-14 08:00:00');

// ---- Fake Prisma: reminder series, pairings and users ----

type Row = Record<string, unknown>;
const USERS: Row[] = [
  { id: 1, name: 'Raziel', englishName: 'Raziel', gender: 'male', calendarSource: 'NATIVE', telegramId: BigInt(1001), language: 'en', pairingId: 'pair-1' },
  { id: 2, name: 'Dana', englishName: 'Dana', gender: 'female', calendarSource: 'NATIVE', telegramId: null, language: 'en', pairingId: 'pair-1' },
];
const PAIRINGS: Row[] = [{ id: 'pair-1', status: 'ACTIVE', inviterUserId: 1, inviteeUserId: 2 }];
const pick = (row: Row | undefined, select?: Record<string, boolean>) =>
  !row ? null : !select ? row : Object.fromEntries(Object.keys(select).filter(k => select[k]).map(k => [k, row[k]]));

const same = (a: unknown, b: unknown) => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b);

// The filters fetchOpenReminders uses: equality, not, lt, AND, OR, the calendar, and
// `some` over the instances. A row carries both, as asRow includes them.
function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as Row[]).some(w => matches(row, w));
    if (key === 'AND') return (cond as Row[]).every(w => matches(row, w));
    if (key === 'calendar') return matches(row.calendar as Row, cond as Row);
    if (key === 'instances') {
      const { some, ...rest } = cond as { some?: Row };
      if (!some || Object.keys(rest).length > 0) throw new Error("fake prisma: only 'instances: { some }'");
      return (row.instances as Row[]).some(i => matches(i, some));
    }
    const value = row[key];
    if (cond === null || typeof cond !== 'object' || cond instanceof Date) return same(value, cond);
    return Object.entries(cond as Row).every(([op, arg]) => {
      switch (op) {
        case 'not': return !same(value, arg);
        case 'lt': return value != null && (value as Date) < (arg as Date);
        default: throw new Error(`fake prisma: no operator ${op}`);
      }
    });
  });
}

/** The rows nativeEvent.findMany filters, and every query it was asked. */
let reminderRows: Row[] = [];
let findManyError: Error | null = null;
const findManyCalls: Row[] = [];
const fakePrisma = {
  pairing: { findUnique: async ({ where, select }: { where: { id: string }; select?: Record<string, boolean> }) => pick(PAIRINGS.find(p => p.id === where.id), select) },
  user: { findUnique: async ({ where, select }: { where: { id: number }; select?: Record<string, boolean> }) => pick(USERS.find(u => u.id === where.id), select) },
  nativeEvent: {
    findMany: async (args: Row) => {
      findManyCalls.push(args);
      if (findManyError) throw findManyError;
      return reminderRows.filter(r => matches(r, args.where as Row));
    },
  },
};
/** A row as findMany returns it with its calendar, overrides and states included. */
const asRow = (c: OpenReminderCandidate): Row =>
  ({ ...c.series, calendar: { ...c.calendar, isDeleted: false }, instances: c.overrides, states: c.states });

const captured: Array<{ context: string; severity?: string }> = [];
const prompts: string[] = [];

const user = (extra: Record<string, unknown>) =>
  ({ id: 1, name: 'Raziel', englishName: 'Raziel', gender: 'male', language: 'en', calendarSource: 'NATIVE', pairingId: 'pair-1', ...extra }) as unknown as UserConfig;
const raziel = user({});
const googleUser = user({ id: 7, calendarSource: 'GOOGLE', pairingId: null });

/** A reminder on the summary day as the native provider hands it over. */
const dayReminder = (summary: string, start: string, end: string, reminder: ReminderInfo): CalendarEvent =>
  ({ summary, start, end, calendarName: 'Raziel', calendarId: 'native:cal-raziel', eventType: 'reminder', reminder });

async function main() {
  // @hebcal/core is ESM-only and tsx loads src/ as CommonJS (see smoke-week-lookahead.ts);
  // the stubs go into require's cache before the modules that import them load.
  const Module = (await import('module')).default as unknown as {
    new (id: string): { filename: string; loaded: boolean; exports: unknown };
    _resolveFilename: (request: string, ...rest: unknown[]) => string;
    _cache: Record<string, unknown>;
  };
  const resolveFilename = Module._resolveFilename;
  Module._resolveFilename = function (request: string, ...rest: unknown[]) {
    if (request === '@hebcal/core') return path.resolve(__dirname, '../node_modules/@hebcal/core/dist/esm/index.js');
    return resolveFilename.call(this, request, ...rest);
  };
  const stub = (file: string, exports: Record<string, unknown>) => {
    const filename = path.resolve(__dirname, '../src', file);
    const mod = new Module(filename);
    Object.assign(mod, { filename, loaded: true, exports });
    Module._cache[filename] = mod;
  };
  stub('utils/prisma.ts', { prisma: fakePrisma });
  stub('lib/error-capture.ts', {
    captureError: (_error: unknown, context: string, _extra?: unknown, severity?: string) => { captured.push({ context, severity }); },
  });
  stub('services/ai-provider.ts', {
    generateAICompletion: async (prompt: string) => {
      prompts.push(prompt);
      return { text: 'ok' };
    },
    streamAICompletion: async () => {
      throw new Error('not streamed in this test');
    },
  });

  const { addDigestReminders, fetchOpenReminders, openRemindersCutoff, selectOpenReminders, shapeDayReminders, OPEN_REMINDERS_DIGEST_CAP } =
    await import('../src/services/native-reminders/open-reminders');
  const { categorizeEvents } = await import('../src/services/telegram/summary');
  const { generateSummary } = await import('../src/services/claude');
  const { buildCalendarSummaryPrompt } = await import('../src/prompts/calendar-summary');
  const { buildShowPrompt } = await import('../src/prompts/voice-show');

  const cutoff = openRemindersCutoff(WEDNESDAY, IL, MORNING);
  const select = (candidates: OpenReminderCandidate[], ctx = razielCtx, at = cutoff, day = WEDNESDAY, now = MORNING) =>
    selectOpenReminders(candidates, ctx, at, day, IL, now);

  // ---- The cutoff ----

  await check('cutoff: the morning digest carries what was due before its day began', () => {
    assert(cutoff.getTime() === startOfLocalDay(WEDNESDAY, IL).getTime(), `cutoff ${cutoff.toISOString()}`);
  });

  await check('cutoff: the evening digest for tomorrow carries what was due before now', () => {
    const evening = il('2026-10-14 20:00:00');
    assert(openRemindersCutoff('2026-10-15', IL, evening).getTime() === evening.getTime(), 'not now');
  });

  // ---- One-off reminders ----

  const plumber = series('Call the plumber', il('2026-10-12 10:00:00'));
  const gas = series('Pay the gas bill', il('2026-10-13 09:00:00'));

  await check('one-off: an undone one from Monday is open since Monday, dated', () => {
    const { events, moreCount } = select([candidate(plumber)]);
    assertList(linesOf(events, WEDNESDAY), ['Call the plumber (Reminder (open since Mon 12 Oct)) [Calendar: Raziel]']);
    assert(moreCount === 0, `moreCount ${moreCount}`);
    assert(events[0].reminder?.openSince === '2026-10-12' && events[0].eventType === 'reminder', JSON.stringify(events[0].reminder));
  });

  await check('one-off: a done one is not carried', () => {
    assert(select([candidate(gas, [done(gas.startsAt)])]).events.length === 0, 'carried a done reminder');
  });

  await check('one-off: a snoozed one is still open, and says so', () => {
    const { events } = select([candidate(gas, [snoozed(gas.startsAt, il('2026-10-14 09:00:00'))])]);
    assert(events.length === 1 && events[0].reminder?.snoozed === true, JSON.stringify(events[0]?.reminder));
  });

  await check('one-off: a date-only one from Tuesday is open since Tuesday', () => {
    const milk = dateOnly('Buy milk', '2026-10-13');
    assertList(linesOf(select([candidate(milk)]).events, WEDNESDAY), ['Buy milk (Reminder (open since Tue 13 Oct)) [Calendar: Raziel]']);
  });

  await check('one-off: one at or after the cutoff is the day\'s, not carried', () => {
    const today = series('Today', il('2026-10-14 00:00:00'));
    const later = series('Later', il('2026-10-14 10:00:00'));
    assert(select([candidate(today), candidate(later)]).events.length === 0, 'carried the summary day\'s own');
  });

  // ---- The evening digest (summary day = tomorrow, cutoff = now) ----

  await check('evening: what was due earlier today is open since today; tonight\'s is in neither list', () => {
    const evening = il('2026-10-14 20:00:00');
    const at = openRemindersCutoff('2026-10-15', IL, evening);
    const morningCall = series('Morning call', il('2026-10-14 10:00:00'));
    const tonight = series('Tonight', il('2026-10-14 21:00:00'));
    const bread = dateOnly('Buy bread', '2026-10-14');
    const { events } = select([candidate(morningCall), candidate(tonight), candidate(bread)], razielCtx, at, '2026-10-15', evening);
    assertList(linesOf(events, '2026-10-15'), [
      'Morning call (Reminder (open since Wed 14 Oct)) [Calendar: Raziel]',
      'Buy bread (Reminder (open since Wed 14 Oct)) [Calendar: Raziel]',
    ]);
  });

  await check('evening digest sent at 07:00: today\'s date-only reminder is not due yet, so not carried', () => {
    const early = il('2026-10-14 07:00:00');
    const bread = dateOnly('Buy bread', '2026-10-14');
    const at = openRemindersCutoff('2026-10-15', IL, early);
    assert(select([candidate(bread)], razielCtx, at, '2026-10-15', early).events.length === 0, 'carried before 09:00');
  });

  // ---- Repeating reminders ----

  // Mondays at 18:00 since 5 Oct: the latest before Wednesday is Monday the 12th.
  const plants = series('Water the plants', il('2026-10-05 18:00:00'), { rrule: 'FREQ=WEEKLY;BYDAY=MO' });

  await check('repeating: only its latest occurrence before the cutoff, when undone', () => {
    const { events } = select([candidate(plants)]);
    assertList(linesOf(events, WEDNESDAY), ['Water the plants (Reminder (open since Mon 12 Oct)) [Calendar: Raziel]']);
  });

  await check('repeating: the latest one done carries nothing, even with an older one undone', () => {
    assert(select([candidate(plants, [done(il('2026-10-12 18:00:00'))])]).events.length === 0, 'carried an older occurrence');
  });

  await check('repeating: a daily reminder ignored for two weeks is one line, and none when it also falls on the day', () => {
    const vitamins = series('Take vitamins', il('2026-09-30 08:00:00'), { rrule: 'FREQ=DAILY' });
    // It occurs on Wednesday too, so Wednesday's own occurrence speaks for it.
    assert(select([candidate(vitamins)]).events.length === 0, 'carried while it occurs on the summary day');
    // Ended on Tuesday: nothing on Wednesday, so the latest (Tuesday's) is carried, once.
    const ended = series('Take vitamins', il('2026-09-30 08:00:00'), { rrule: 'FREQ=DAILY;UNTIL=20261013T235959' });
    assertList(linesOf(select([candidate(ended)]).events, WEDNESDAY), ['Take vitamins (Reminder (open since Tue 13 Oct)) [Calendar: Raziel]']);
  });

  await check('repeating: an exdated latest occurrence leaves the one before it', () => {
    const exdated = series('Water the plants', il('2026-10-05 18:00:00'), { rrule: 'FREQ=WEEKLY;BYDAY=MO', exdates: [il('2026-10-12 18:00:00')] });
    assertList(linesOf(select([candidate(exdated)]).events, WEDNESDAY), ['Water the plants (Reminder (open since Mon 5 Oct)) [Calendar: Raziel]']);
  });

  // ---- Armed: a repeating reminder's occurrence from before it was armed was never pinged ----

  // Daily at 08:00, ended Tuesday: nothing on Wednesday, so Tuesday's is the latest.
  const stretch = (armedAt: Date) => series('Stretch', il('2026-09-30 08:00:00'), { rrule: 'FREQ=DAILY;UNTIL=20261013T235959', armedAt });

  await check('armed: a daily reminder armed three days ago and undone is open since yesterday, once', () => {
    assertList(linesOf(select([candidate(stretch(il('2026-10-11 08:00:00')))]).events, WEDNESDAY), ['Stretch (Reminder (open since Tue 13 Oct)) [Calendar: Raziel]']);
  });

  await check('armed: the same series re-armed today carries nothing (yesterday\'s was never pinged)', () => {
    assert(select([candidate(stretch(MORNING))]).events.length === 0, 'carried an occurrence from before it was armed');
  });

  await check('armed: a one-off is not bounded: one from two days ago, created today, is still carried', () => {
    const books = series('Return the books', il('2026-10-12 10:00:00'), { armedAt: MORNING, createdAt: MORNING });
    assertList(linesOf(select([candidate(books)]).events, WEDNESDAY), ['Return the books (Reminder (open since Mon 12 Oct)) [Calendar: Raziel]']);
  });

  // ---- Who sees a carried-over reminder (R1) ----

  await check('R1: the partner\'s reminder for themselves is not carried to the viewer', () => {
    const danasOwn = series('Dana\'s yoga', il('2026-10-12 07:00:00'), { creatorUserId: 2 });
    assert(select([candidate(danasOwn)]).events.length === 0, 'carried Dana\'s own reminder');
  });

  await check('R1: one Dana set for the viewer is the viewer\'s, "from Dana"; one the viewer set for Dana says so', () => {
    const fromDana = series('Book the vet', il('2026-10-12 11:00:00'), { creatorUserId: 2, forUserId: 1 });
    const forDana = series('Buy milk', il('2026-10-12 17:00:00'), { forUserId: 2 });
    const { events } = select([candidate(fromDana), candidate(forDana)]);
    assertList(linesOf(events, WEDNESDAY), [
      'Buy milk (Reminder (open since Mon 12 Oct)) (for Dana, you asked) [Calendar: Raziel]',
      'Book the vet (Reminder (open since Mon 12 Oct)) (from Dana) [Calendar: Raziel]',
    ]);
    assert(events[0].reminder?.ownerIsViewer === false && events[1].reminder?.ownerIsViewer === true, 'owners');
  });

  await check('R1: after unlinking, a reminder for the ex-partner reverts to its creator', () => {
    const forDana = series('Buy milk', il('2026-10-12 17:00:00'), { forUserId: 2 });
    const { events } = select([candidate(forDana)], { viewerId: 1, partner: null });
    assert(events.length === 1 && events[0].reminder?.ownerIsViewer === true, JSON.stringify(events[0]?.reminder));
    assertList(linesOf(events, WEDNESDAY), ['Buy milk (Reminder (open since Mon 12 Oct)) [Calendar: Raziel]']);
  });

  // ---- Order and cap ----

  await check(`cap: newest first, ${OPEN_REMINDERS_DIGEST_CAP} lines and how many more`, () => {
    const { events, moreCount } = select(SEVEN_TASKS);
    assertList(events.map(e => e.summary), ['Task 11', 'Task 10', 'Task 9', 'Task 8', 'Task 7']);
    assert(moreCount === 2, `moreCount ${moreCount}`);
    const all = selectOpenReminders(SEVEN_TASKS, razielCtx, cutoff, WEDNESDAY, IL, MORNING, Infinity);
    assert(all.events.length === 7 && all.moreCount === 0, `uncapped ${all.events.length}/${all.moreCount}`);
  });

  // ---- The read ----

  await check('fetch: one read of the viewer\'s and the partner\'s-for-the-viewer REMINDER series before the cutoff', async () => {
    findManyCalls.length = 0;
    reminderRows = [asRow(candidate(plumber))];
    const { events } = await fetchOpenReminders(raziel, razielCtx, cutoff, WEDNESDAY, IL);
    assertList(events.map(e => e.summary), ['Call the plumber']);
    assert(findManyCalls.length === 1, `${findManyCalls.length} reads`);
    assert(JSON.stringify(findManyCalls[0]) === JSON.stringify({
      where: {
        kind: 'REMINDER',
        isDeleted: false,
        calendar: { isDeleted: false },
        AND: [{
          OR: [
            { startsAt: { lt: cutoff } },
            { rrule: { not: null }, instances: { some: { status: 'OVERRIDE', startsAt: { lt: cutoff } } } },
          ],
        }],
        OR: [{ creatorUserId: 1 }, { creatorUserId: 2, forUserId: 1 }],
      },
      include: { calendar: true, instances: true, states: true },
    }), JSON.stringify(findManyCalls[0]));
  });

  await check('fetch: unpaired, only the viewer\'s own; a Google user is never read', async () => {
    findManyCalls.length = 0;
    reminderRows = [];
    await fetchOpenReminders(raziel, { viewerId: 1, partner: null }, cutoff, WEDNESDAY, IL);
    assert(JSON.stringify((findManyCalls[0]?.where as Row)?.OR) === '[{"creatorUserId":1}]', JSON.stringify(findManyCalls[0]));
    findManyCalls.length = 0;
    const none = await fetchOpenReminders(googleUser, { viewerId: 7, partner: null }, cutoff, WEDNESDAY, IL);
    assert(none.events.length === 0 && findManyCalls.length === 0, 'read for a Google user');
  });

  // Daily at 08:00 from Thursday 15 Oct, the day after the summary day, set at `setAt`.
  // Moving its first time earlier leaves the series row starting Thursday, after the cutoff.
  const fromThursday = (title: string, setAt: Date) =>
    series(title, il('2026-10-15 08:00:00'), { rrule: 'FREQ=DAILY', armedAt: setAt, createdAt: setAt, updatedAt: setAt });
  /** The series with its first occurrence, Thursday's, moved to `to` when the series was set. */
  const firstMovedTo = (s: NativeEvent, to: Date): OpenReminderCandidate => candidate(s, [], [{
    id: `ov-${s.id}`, seriesEventId: s.id, originalStartsAt: s.startsAt, status: 'OVERRIDE', title: null, description: null,
    location: null, startsAt: to, endsAt: to, allDay: null, createdAt: s.createdAt, updatedAt: s.createdAt,
  }]);

  await check('fetch: a first occurrence moved before the series start is read and carried, however far back', async () => {
    reminderRows = [
      firstMovedTo(fromThursday('Pills', il('2026-10-12 12:00:00')), il('2026-10-13 20:00:00')),
      // Moved to Sunday, three days before the cutoff.
      firstMovedTo(fromThursday('Vitamins', il('2026-10-09 12:00:00')), il('2026-10-11 20:00:00')),
      // Set Tuesday at 21:00 with its first time moved to 20:00, already past: never
      // armed, so never pinged, and not open (Planning Ruling 4).
      firstMovedTo(fromThursday('Stretch', il('2026-10-13 21:00:00')), il('2026-10-13 20:00:00')),
    ].map(asRow);
    const { events } = await fetchOpenReminders(raziel, razielCtx, cutoff, WEDNESDAY, IL);
    assertList(linesOf(events, WEDNESDAY), [
      'Pills (Reminder (open since Tue 13 Oct)) [Calendar: Raziel]',
      'Vitamins (Reminder (open since Sun 11 Oct)) [Calendar: Raziel]',
    ]);
  });

  // ---- The summary day's own reminders ----

  const nine = dayReminder('Call mom', '2026-10-14T06:00:00.000Z', '2026-10-14T06:00:00.000Z', OWN); // 09:00 Israel
  const pills = dayReminder('Take pills', '2026-10-14T04:00:00.000Z', '2026-10-14T04:00:00.000Z', OWN); // 07:00
  const doneToday = dayReminder('Feed the cat', '2026-10-14T03:00:00.000Z', '2026-10-14T03:00:00.000Z', { ...OWN, done: true });
  const dateOnlyToday = dayReminder('Buy stamps', WEDNESDAY, '2026-10-15', OWN);
  const meeting: CalendarEvent = { summary: 'Standup', start: '2026-10-14T06:30:00.000Z', end: '2026-10-14T06:45:00.000Z', calendarName: 'Work', calendarId: 'native:work' };

  await check('day: a done reminder leaves the day; a past-due one is open; a later one and events are untouched', () => {
    const shaped = shapeDayReminders([pills, doneToday, nine, meeting, dateOnlyToday], MORNING, IL);
    assertList(linesOf(shaped, WEDNESDAY), [
      'Take pills (Reminder 07:00 (open)) [Calendar: Raziel]',
      'Call mom (Reminder 09:00) [Calendar: Raziel]',
      'Standup (09:30 - 09:45) [Calendar: Work]',
      'Buy stamps (Reminder (all day)) [Calendar: Raziel]',
    ]);
    assert(shaped[2] === meeting, 'the event was copied');
  });

  await check('day: a date-only reminder is open from 09:00 on its day', () => {
    const [before] = shapeDayReminders([dateOnlyToday], il('2026-10-14 08:59:00'), IL);
    const [after] = shapeDayReminders([dateOnlyToday], il('2026-10-14 09:01:00'), IL);
    assert(!before.reminder?.open && after.reminder?.open === true, `${before.reminder?.open} ${after.reminder?.open}`);
    assert(linesOf([after], WEDNESDAY)[0] === 'Buy stamps (Reminder (all day, open)) [Calendar: Raziel]', linesOf([after], WEDNESDAY)[0]);
  });

  await check('digest: a Google user\'s events come back as they were, with no read', async () => {
    findManyCalls.length = 0;
    const events = [meeting];
    const result = await addDigestReminders(googleUser, events, WEDNESDAY, IL, MORNING);
    assert(result.events === events && result.moreCount === 0 && findManyCalls.length === 0, 'touched a Google digest');
  });

  await check('digest: the day\'s reminders shaped, then the open ones after them, with the count past the cap', async () => {
    reminderRows = SEVEN_TASKS.map(asRow);
    const { events, moreCount } = await addDigestReminders(raziel, [pills, doneToday, meeting], WEDNESDAY, IL, MORNING);
    assertList(events.map(e => e.summary), ['Take pills', 'Standup', 'Task 11', 'Task 10', 'Task 9', 'Task 8', 'Task 7']);
    assert(moreCount === 2, `moreCount ${moreCount}`);
  });

  await check('digest: a failed carry-over still sends the day, and is reported as a warning', async () => {
    captured.length = 0;
    findManyError = new Error('connection reset');
    const { events, moreCount } = await addDigestReminders(raziel, [pills, meeting], WEDNESDAY, IL, MORNING);
    findManyError = null;
    assertList(linesOf(events, WEDNESDAY), ['Take pills (Reminder 07:00 (open)) [Calendar: Raziel]', 'Standup (09:30 - 09:45) [Calendar: Work]']);
    assert(moreCount === 0, `moreCount ${moreCount}`);
    assert(captured.length === 1 && captured[0].severity === 'warning', JSON.stringify(captured));
  });

  // ---- Categorizing: by whose it is, never "other" ----

  const assignments: CalendarAssignment[] = [
    { calendarId: 'native:mine', labels: ['primary', 'yours'], name: 'Raziel', color: '#000' },
    { calendarId: 'native:danas', labels: ['spouse'], name: 'Dana', color: '#000' },
    { calendarId: 'native:kids', labels: ['kids'], name: 'Noa', color: '#000' },
  ];
  const on = (calendarId: string, e: CalendarEvent): CalendarEvent => ({ ...e, calendarId });

  await check('categorize: reminders go by owner whatever their calendar; events by calendar as before', () => {
    const mineOnDanas = on('native:danas', dayReminder('From Dana', '2026-10-14T08:00:00.000Z', '2026-10-14T08:00:00.000Z', FROM_DANA));
    const danasOnMine = on('native:mine', dayReminder('For Dana', '2026-10-14T09:00:00.000Z', '2026-10-14T09:00:00.000Z', FOR_DANA));
    const mineOnKids = on('native:kids', dayReminder('Sign the form', '2026-10-14T10:00:00.000Z', '2026-10-14T10:00:00.000Z', OWN));
    const dentist = on('native:mine', { ...meeting, summary: 'Dentist' });
    const yoga = on('native:danas', { ...meeting, summary: 'Yoga' });
    const school = on('native:kids', { ...meeting, summary: 'School play' });
    const { userEvents, spouseEvents, otherEvents } = categorizeEvents(
      [mineOnDanas, danasOnMine, mineOnKids, dentist, yoga, school], raziel, assignments
    );
    assertList(userEvents.map(e => e.summary), ['From Dana', 'Sign the form', 'Dentist']);
    assertList(spouseEvents.map(e => e.summary), ['For Dana', 'Yoga']);
    assertList(otherEvents.map(e => e.summary), ['School play']);
  });

  // ---- The summary prompt ----

  const generate = async (userEvents: CalendarEvent[], spouseEvents: CalendarEvent[], openRemindersMore?: number) => {
    prompts.length = 0;
    await generateSummary(
      userEvents, spouseEvents, [], 'Raziel', 'Raziel', 'male', 'Dana', 'Dana', 'female', '',
      il('2026-10-14 12:00:00'), false, undefined, undefined, 'en',
      { calendarAssignments: assignments, openRemindersMore }, false, undefined, IL
    );
    assert(prompts.length === 1, `${prompts.length} prompts`);
    return prompts[0];
  };

  await check('prompt: reminder lines, the reminders guideline and the "N more open" line', async () => {
    const carried = select([candidate(plumber)]).events;
    const prompt = await generate(
      [...shapeDayReminders([pills], MORNING, IL), ...carried],
      [dayReminder('Buy milk', '2026-10-14T14:00:00.000Z', '2026-10-14T14:00:00.000Z', FOR_DANA)],
      3
    );
    assert(prompt.includes('1. Take pills (Reminder 07:00 (open)) [Calendar: Raziel]'), 'open line');
    assert(prompt.includes('2. Call the plumber (Reminder (open since Mon 12 Oct)) [Calendar: Raziel]'), 'carried line');
    assert(prompt.includes('1. Buy milk (Reminder 17:00) (for Dana, you asked) [Calendar: Raziel]'), 'partner line');
    assert(prompt.includes('- **Reminders**: Items marked "Reminder"'), 'guideline');
    assert(prompt.includes('and 3 more open reminders'), '"more" line');
    const ranged = prompt.split('\n').filter(line => line.includes('(Reminder') && /\d\d:\d\d - \d\d:\d\d/.test(line));
    assert(ranged.length === 0, `a reminder got a range: ${ranged.join(' | ')}`);
  });

  await check('prompt: a digest without reminders is unchanged, in every language', async () => {
    const prompt = await generate([meeting], []);
    assert(!prompt.includes('Reminder') && !prompt.includes('⏰'), 'reminder text in a reminder-free prompt');
    for (const language of ['en', 'he', 'ru']) {
      const data = {
        userName: 'Raziel', userEnglishName: 'Raziel', userGender: 'male' as const, hasSpouseCalendar: false,
        currentGregorianDate: 'Wednesday, October 14, 2026', summaryGregorianDate: 'Wednesday, October 14, 2026',
        summaryHebrewDate: '', greeting: 'Hi', userEventsText: 'None', spouseEventsText: 'None', otherEventsText: 'None', language,
      };
      const before = buildCalendarSummaryPrompt(data);
      assert(before === buildCalendarSummaryPrompt({ ...data, hasReminders: false, openRemindersMore: 0 }), `${language} changed`);
      assert(buildCalendarSummaryPrompt({ ...data, hasReminders: true }).length > before.length, `${language} has no guideline`);
    }
  });

  await check('prompt: the "N more open" line is built word for word, in every language', () => {
    const build = (language: string, openRemindersMore: number) => buildCalendarSummaryPrompt({
      userName: 'Raziel', userEnglishName: 'Raziel', userGender: 'male' as const, hasSpouseCalendar: false,
      currentGregorianDate: 'Wednesday, October 14, 2026', summaryGregorianDate: 'Wednesday, October 14, 2026',
      summaryHebrewDate: '', greeting: 'Hi', userEventsText: 'None', spouseEventsText: 'None', otherEventsText: 'None',
      language, hasReminders: true, openRemindersMore,
    });
    assert(build('en', 2).includes('"and 2 more open reminders"'), 'en');
    assert(build('en', 1).includes('"and 1 more open reminder"'), 'en 1');
    assert(build('he', 2).includes('"ועוד 2 תזכורות פתוחות"'), 'he');
    assert(build('he', 1).includes('"ועוד תזכורת פתוחה אחת"'), 'he 1');
    const ru: Record<number, string> = { 1: 'и ещё 1 открытое напоминание', 2: 'и ещё 2 открытых напоминания', 5: 'и ещё 5 открытых напоминаний', 21: 'и ещё 21 открытое напоминание', 22: 'и ещё 22 открытых напоминания' };
    for (const [k, line] of Object.entries(ru)) assert(build('ru', Number(k)).includes(`"${line}"`), `ru ${k}`);
    assert(!build('ru', 2).includes('не сделано"'), 'ru old example');
  });

  // ---- The voice show reads the finished summary ----

  await check('voice show: a summary with ⏰ reminders gets the reminders rule, in he/en/ru; one without is unchanged', () => {
    const rules: Record<string, string> = { en: 'Reminders (marked ⏰ in the summary)', he: 'תזכורות (מסומנות ⏰ בסיכום)', ru: 'Напоминания (в сводке они с ⏰)' };
    for (const locale of ['en', 'he', 'ru']) {
      const show = (summary: string) => buildShowPrompt({
        kind: 'daily', summary, locale, listener: { name: 'Raziel', gender: 'male' }, kids: [], hasKidsCalendars: false,
      });
      assert(show('<b>Your Schedule:</b>\n- 07:00 ⏰ Take pills (still open)').includes(rules[locale]), `${locale}: no rule`);
      assert(!show('<b>Your Schedule:</b>\n- 09:30-09:45 - Standup').includes(rules[locale]), `${locale}: rule without reminders`);
    }
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

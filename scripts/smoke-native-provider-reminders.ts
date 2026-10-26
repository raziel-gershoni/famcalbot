// Smoke test for reminders in the native provider (src/services/calendar-provider/native-provider.ts).
// A reminder is a NativeEvent of kind REMINDER: the provider hands it on as eventType
// 'reminder' with the viewer's side of it (whose it is, who set it, done or snoozed). A
// partner's reminder for the viewer shows on its day even from the partner's PRIVATE
// calendar, and only once when the viewer can see that calendar too. The real event
// store and ownership helpers run against an in-memory Prisma. No network.
//
// Run under both clocks; the output must not depend on the server's timezone:
//   TZ=UTC npx tsx scripts/smoke-native-provider-reminders.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-native-provider-reminders.ts

import path from 'path';
import { fromZonedTime } from 'date-fns-tz';
import type { NativeCalendar, NativeEvent, NativeReminderState } from '@prisma/client';
import type { CalendarEvent, ReminderInfo, UserConfig } from '../src/types';
import type { ViewerContext } from '../src/services/native-reminders/ownership';

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

const IL = 'Asia/Jerusalem';
const NY = 'America/New_York';
const at = (local: string, tz = IL) => fromZonedTime(local, tz);

// ---- In-memory Prisma: the where-clause operators the store and the ownership helpers use ----

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

const same = (a: unknown, b: unknown) => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b);

function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as Where[]).some((w) => matches(row, w));
    if (key === 'AND') return (cond as Where[]).every((w) => matches(row, w));
    const value = row[key];
    if (cond === null || typeof cond !== 'object' || cond instanceof Date) return same(value, cond);
    return Object.entries(cond as Where).every(([op, arg]) => {
      switch (op) {
        case 'in': return (arg as unknown[]).some((a) => same(a, value));
        case 'not': return !same(value, arg);
        case 'lt': return value != null && (value as Date) < (arg as Date);
        case 'lte': return value != null && (value as Date) <= (arg as Date);
        case 'gt': return value != null && (value as Date) > (arg as Date);
        case 'gte': return value != null && (value as Date) >= (arg as Date);
        default: throw new Error(`stand-in Prisma does not know '${op}'`);
      }
    });
  });
}

/** Prisma returns only the selected columns. */
const pick = (row: Row, select?: Record<string, boolean>) =>
  select ? Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]])) : { ...row };

/** Every query, as "<model>.<method>", to see what a fetch costs. */
const queries: string[] = [];

function table(name: string, rows: () => Row[]) {
  return {
    findMany: async ({ where = {}, select }: { where?: Where; select?: Record<string, boolean> } = {}) => {
      queries.push(`${name}.findMany`);
      return rows().filter((r) => matches(r, where)).map((r) => pick(r, select));
    },
    findUnique: async ({ where, select }: { where: Where; select?: Record<string, boolean> }) => {
      queries.push(`${name}.findUnique`);
      const row = rows().find((r) => matches(r, where));
      return row ? pick(row, select) : null;
    },
    create: async ({ data }: { data: Row }) => {
      queries.push(`${name}.create`);
      const row = { id: `${name}-${rows().length + 1}`, ...data };
      rows().push(row);
      return row;
    },
  };
}

const db = {
  users: [] as Row[],
  pairings: [] as Row[],
  calendars: [] as Row[],
  events: [] as Row[],
  instances: [] as Row[],
  states: [] as Row[],
};

const fakePrisma = {
  user: table('user', () => db.users),
  pairing: table('pairing', () => db.pairings),
  nativeCalendar: table('nativeCalendar', () => db.calendars),
  nativeEvent: table('nativeEvent', () => db.events),
  nativeEventInstance: table('nativeEventInstance', () => db.instances),
  nativeReminderState: table('nativeReminderState', () => db.states),
  // No calendar here is copied to Google (google-sync spec §2): the marks find no link.
  googleSyncLink: table('googleSyncLink', () => []),
  // An event's write and its marks run in one interactive transaction; nothing here rolls back.
  $transaction: async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(fakePrisma),
};

// ---- The household: Dana and Raziel, paired; Noam on his own ----

const DANA = 1;
const RAZIEL = 2;
const NOAM = 3;
const CREATED = at('2026-10-01 09:00');

function calendar(fields: Partial<NativeCalendar> & Pick<NativeCalendar, 'id' | 'ownerUserId' | 'name'>): NativeCalendar {
  return {
    color: '#039BE5', labels: ['yours'], personName: null, personEnglishName: null, personGender: null, rules: [],
    privacy: 'PRIVATE', isDeleted: false, createdAt: CREATED, updatedAt: CREATED,
    ...fields,
  };
}

function event(fields: Partial<NativeEvent> & Pick<NativeEvent, 'id' | 'calendarId' | 'creatorUserId' | 'title' | 'startsAt'>): NativeEvent {
  return {
    description: null, location: null, endsAt: fields.startsAt, allDay: false, timeZone: IL, rrule: null, hebrewRule: null, hebrewAnchor: null, exdates: [],
    ownAlerts: false, alertMinutes: [], isDeleted: false, createdAt: CREATED, updatedAt: CREATED,
    kind: 'EVENT', forUserId: null, armedAt: null,
    ...fields,
  };
}

/** A reminder has no length: it ends where it starts. */
const reminder = (fields: Parameters<typeof event>[0]) => event({ kind: 'REMINDER', armedAt: CREATED, ...fields, endsAt: fields.startsAt });

function state(fields: Partial<NativeReminderState> & Pick<NativeReminderState, 'seriesEventId' | 'originalStartsAt'>): NativeReminderState {
  return {
    id: `state-${fields.seriesEventId}-${fields.originalStartsAt.getTime()}`, doneAt: null, doneByUserId: null, snoozedUntil: null,
    lastPingedAt: null, pingAttempts: 0, pingChatId: null, pingMessageId: null, createdAt: CREATED, updatedAt: CREATED,
    ...fields,
  };
}

const user = (id: number, name: string, extra: Row = {}) =>
  ({ id, name, englishName: name, gender: 'female', calendarSource: 'NATIVE', telegramId: BigInt(1000 + id), language: 'en', pairingId: null, ...extra });

/** Each check starts from this household. */
function household() {
  db.users = [
    user(DANA, 'Dana', { pairingId: 'pair-1' }),
    user(RAZIEL, 'Raziel', { gender: 'male', pairingId: 'pair-1' }),
    user(NOAM, 'Noam', { gender: 'male' }),
  ];
  db.pairings = [{ id: 'pair-1', status: 'ACTIVE', inviterUserId: RAZIEL, inviteeUserId: DANA }];
  db.calendars = [
    calendar({ id: 'cal-dana', ownerUserId: DANA, name: 'Dana', labels: ['primary', 'yours'], privacy: 'SHARED_EDITOR' }),
    calendar({ id: 'cal-raz', ownerUserId: RAZIEL, name: 'Raziel', labels: ['primary', 'yours'] }),
    calendar({ id: 'cal-raz-family', ownerUserId: RAZIEL, name: 'Family', labels: ['kids'], privacy: 'SHARED_EDITOR' }),
    calendar({ id: 'cal-raz-old', ownerUserId: RAZIEL, name: 'Old', isDeleted: true }),
    calendar({ id: 'cal-noam', ownerUserId: NOAM, name: 'Noam' }),
  ];
  db.events = [
    event({ id: 'ev-dentist', calendarId: 'cal-dana', creatorUserId: DANA, title: 'Dentist', startsAt: at('2026-10-13 10:00'), endsAt: at('2026-10-13 11:00') }),
    reminder({ id: 'rem-plants', calendarId: 'cal-dana', creatorUserId: DANA, title: 'Water the plants', startsAt: at('2026-10-13 00:00'), allDay: true }),
    reminder({ id: 'rem-bank', calendarId: 'cal-dana', creatorUserId: DANA, forUserId: RAZIEL, title: 'Call the bank', startsAt: at('2026-10-13 15:00') }),
    // Raziel's, on his PRIVATE calendar: Dana sees only the ones for her.
    reminder({ id: 'rem-milk', calendarId: 'cal-raz', creatorUserId: RAZIEL, forUserId: DANA, title: 'Buy milk', startsAt: at('2026-10-13 17:00') }),
    reminder({ id: 'rem-raz-own', calendarId: 'cal-raz', creatorUserId: RAZIEL, title: 'Renew passport', startsAt: at('2026-10-13 12:00') }),
    reminder({
      id: 'rem-vitamins', calendarId: 'cal-raz', creatorUserId: RAZIEL, forUserId: DANA, title: 'Vitamins',
      startsAt: at('2026-10-10 08:00'), rrule: 'FREQ=DAILY',
    }),
    reminder({ id: 'rem-deleted', calendarId: 'cal-raz', creatorUserId: RAZIEL, forUserId: DANA, title: 'Deleted', startsAt: at('2026-10-13 09:30'), isDeleted: true }),
    reminder({ id: 'rem-yesterday', calendarId: 'cal-raz', creatorUserId: RAZIEL, forUserId: DANA, title: 'Yesterday', startsAt: at('2026-10-12 17:00') }),
    reminder({ id: 'rem-old-cal', calendarId: 'cal-raz-old', creatorUserId: RAZIEL, forUserId: DANA, title: 'On a deleted calendar', startsAt: at('2026-10-13 09:00') }),
    // On a calendar Dana can see: it comes back from both fetches.
    reminder({ id: 'rem-cake', calendarId: 'cal-raz-family', creatorUserId: RAZIEL, forUserId: DANA, title: 'Pick up the cake', startsAt: at('2026-10-13 18:00') }),
    event({ id: 'ev-noam', calendarId: 'cal-noam', creatorUserId: NOAM, title: 'Gym', startsAt: at('2026-10-13 07:00'), endsAt: at('2026-10-13 08:00') }),
  ] as unknown as Row[];
  db.instances = [];
  db.states = [
    state({ seriesEventId: 'rem-plants', originalStartsAt: at('2026-10-13 00:00'), doneAt: at('2026-10-13 09:10'), doneByUserId: DANA }),
    state({ seriesEventId: 'rem-milk', originalStartsAt: at('2026-10-13 17:00'), snoozedUntil: at('2099-01-01 09:00') }),
    // Yesterday's vitamins are done; today's are not.
    state({ seriesEventId: 'rem-vitamins', originalStartsAt: at('2026-10-12 08:00'), doneAt: at('2026-10-12 08:05') }),
  ] as unknown as Row[];
  queries.length = 0;
}

const viewer = (id: number) => db.users.find((u) => u.id === id) as unknown as UserConfig;
const DAY = [at('2026-10-13 00:00'), at('2026-10-14 00:00')] as const;

/** An event as one line: a reminder with whose it is, who set it, done and snoozed. */
function describe(e: CalendarEvent): string {
  if (e.eventType !== 'reminder') return e.summary;
  const r = e.reminder!;
  const flags = [
    r.ownerIsViewer ? 'mine' : `for ${r.ownerName}`,
    r.creatorIsViewer ? 'by me' : `by ${r.creatorName}`,
    r.done ? 'done' : '',
    r.snoozed ? 'snoozed' : '',
  ].filter(Boolean);
  return `${e.summary} (${flags.join(', ')})`;
}

async function main() {
  // The stubs go into require's cache before the modules that import them load. The
  // timezone resolver is reached through import(), so it stays real and finds the
  // user's timezone in the (fake) Redis cache, as it does after the first summary.
  const Module = (await import('module')).default as unknown as {
    new (id: string): { filename: string; loaded: boolean; exports: unknown };
    _cache: Record<string, unknown>;
  };
  const stub = (file: string, exports: Record<string, unknown>) => {
    const filename = path.resolve(__dirname, '../src', file);
    const mod = new Module(filename);
    Object.assign(mod, { filename, loaded: true, exports });
    Module._cache[filename] = mod;
  };
  stub('utils/prisma.ts', { prisma: fakePrisma, withRetry: (fn: () => unknown) => fn() });
  stub('utils/redis.ts', { redis: { get: async () => IL, set: async () => 'OK' } });

  const { nativeProvider, reminderInfoFor, toUnifiedEvent } = await import('../src/services/calendar-provider/native-provider');

  const fetchDay = (id: number, calendarIds: string[]) => nativeProvider.fetchEventsInRange(viewer(id), calendarIds, ...DAY);
  const instance = (fields: { startsAt: Date; endsAt: Date; allDay?: boolean; timeZone?: string }) => ({
    title: 'Call the plumber', allDay: false, timeZone: IL, seriesEventId: 'r1', instanceStartsAt: fields.startsAt, isRecurringInstance: false,
    ...fields,
  });
  const mine: ReminderInfo = { ownerIsViewer: true, creatorIsViewer: true, done: false, snoozed: false };

  await check('toUnifiedEvent: a timed reminder has no length and carries the viewer\'s side', () => {
    const e = toUnifiedEvent({ id: 'cal1', name: 'Dana' }, instance({ startsAt: at('2026-10-13 10:00'), endsAt: at('2026-10-13 10:00') }), { kind: 'REMINDER' }, mine);
    assert(e.eventType === 'reminder', `eventType ${e.eventType}`);
    assert(e.start === '2026-10-13T07:00:00.000Z' && e.end === e.start, `times ${e.start}..${e.end}`);
    assert(e.reminder === mine, `reminder ${JSON.stringify(e.reminder)}`);
    // A row stored with a length before the store kept reminders at zero still ends where it starts.
    const old = toUnifiedEvent({ id: 'cal1', name: 'Dana' }, instance({ startsAt: at('2026-10-13 10:00'), endsAt: at('2026-10-13 11:00') }), { kind: 'REMINDER' }, mine);
    assert(old.end === old.start, `old row ends ${old.end}`);
  });

  await check('toUnifiedEvent: a date-only reminder is its one day, on DST days too', () => {
    for (const [day, next, tz] of [['2026-10-13', '2026-10-14', IL], ['2026-10-25', '2026-10-26', IL], ['2026-11-01', '2026-11-02', NY]]) {
      const midnight = at(`${day} 00:00`, tz);
      const e = toUnifiedEvent({ id: 'cal1', name: 'Dana' }, instance({ startsAt: midnight, endsAt: midnight, allDay: true, timeZone: tz }), { kind: 'REMINDER' }, mine);
      assert(e.start === day && e.end === next && e.eventType === 'reminder', `${tz} ${day}: ${e.start}..${e.end} ${e.eventType}`);
    }
  });

  await check('toUnifiedEvent: an event is unchanged, given its series or not', () => {
    const inst = instance({ startsAt: at('2026-10-13 10:00'), endsAt: at('2026-10-13 11:00') });
    const before = toUnifiedEvent({ id: 'cal1', name: 'Dana' }, inst);
    const withSeries = toUnifiedEvent({ id: 'cal1', name: 'Dana' }, inst, { kind: 'EVENT' });
    assert(JSON.stringify(Object.entries(withSeries)) === JSON.stringify(Object.entries(before)), `${JSON.stringify(withSeries)} vs ${JSON.stringify(before)}`);
    assert(!('reminder' in withSeries) && withSeries.eventType === undefined, 'marked as a reminder');
  });

  await check('toUnifiedEvent: an event\'s own alert reaches the pass as alertLeads (a lead, or [] for None); the default carries none', () => {
    const inst = instance({ startsAt: at('2026-10-13 10:00'), endsAt: at('2026-10-13 11:00') });
    const cal = { id: 'cal1', name: 'Dana' };
    assert(JSON.stringify(toUnifiedEvent(cal, inst, { kind: 'EVENT', ownAlerts: true, alertMinutes: [30] }).alertLeads) === '[30]', 'a lead');
    assert(JSON.stringify(toUnifiedEvent(cal, inst, { kind: 'EVENT', ownAlerts: true, alertMinutes: [] }).alertLeads) === '[]', 'none');
    assert(!('alertLeads' in toUnifiedEvent(cal, inst, { kind: 'EVENT', ownAlerts: false, alertMinutes: [] })), 'default');
    assert(!('alertLeads' in toUnifiedEvent(cal, inst, { kind: 'EVENT', ownAlerts: false, alertMinutes: [30] })), 'minutes without ownAlerts are ignored');
    assert(!('alertLeads' in toUnifiedEvent(cal, inst, { kind: 'EVENT' })), 'a series row without the columns');
  });

  await check('toUnifiedEvent: a reminder given no viewer side reads as the viewer\'s own', () => {
    const e = toUnifiedEvent({ id: 'cal1', name: 'Dana' }, instance({ startsAt: at('2026-10-13 10:00'), endsAt: at('2026-10-13 10:00') }), { kind: 'REMINDER' });
    assert(e.reminder?.ownerIsViewer === true && e.reminder.creatorIsViewer === true, `reminder ${JSON.stringify(e.reminder)}`);
  });

  await check('reminderInfoFor: done, snoozed, and a snooze that has run out', () => {
    const ctx: ViewerContext = { viewerId: DANA, partner: null };
    const series = { creatorUserId: DANA, forUserId: null };
    const now = at('2026-10-13 12:00');
    const done = reminderInfoFor(series, { doneAt: at('2026-10-13 09:00'), snoozedUntil: null }, ctx, now);
    assert(done.done === true && done.snoozed === false, `done ${JSON.stringify(done)}`);
    const snoozed = reminderInfoFor(series, { doneAt: null, snoozedUntil: at('2026-10-13 12:15') }, ctx, now);
    assert(snoozed.done === false && snoozed.snoozed === true, `snoozed ${JSON.stringify(snoozed)}`);
    const ranOut = reminderInfoFor(series, { doneAt: null, snoozedUntil: at('2026-10-13 11:45') }, ctx, now);
    assert(ranOut.snoozed === false, `ran out ${JSON.stringify(ranOut)}`);
    const pending = reminderInfoFor(series, undefined, ctx, now);
    assert(JSON.stringify(pending) === JSON.stringify({ ownerIsViewer: true, creatorIsViewer: true, done: false, snoozed: false }), `pending ${JSON.stringify(pending)}`);
  });

  await check('Dana\'s day: hers, and Raziel\'s for her from his PRIVATE calendar, once each, in order', async () => {
    household();
    const events = await fetchDay(DANA, ['native:cal-dana', 'native:cal-raz-family']);
    assertList(events.map(describe), [
      'Water the plants (mine, by me, done)',
      'Vitamins (mine, by Raziel)',
      'Dentist',
      'Call the bank (for Raziel, by me)',
      'Buy milk (mine, by Raziel, snoozed)',
      'Pick up the cake (mine, by Raziel)',
    ]);
    const vitamins = events.find((e) => e.summary === 'Vitamins')!;
    assert(vitamins.eventId === `rem-vitamins#${at('2026-10-13 08:00').toISOString()}` && vitamins.recurringEventId === 'rem-vitamins', `vitamins ${vitamins.eventId}`);
    const plants = events.find((e) => e.summary === 'Water the plants')!;
    assert(plants.start === '2026-10-13' && plants.end === '2026-10-14', `plants ${plants.start}..${plants.end}`);
    const milk = events.find((e) => e.summary === 'Buy milk')!;
    assert(milk.calendarId === 'native:cal-raz' && milk.start === milk.end, `milk ${milk.calendarId} ${milk.start}..${milk.end}`);
  });

  await check('Raziel\'s day: the other side of the same reminders', async () => {
    household();
    const events = await fetchDay(RAZIEL, ['native:cal-raz', 'native:cal-raz-family', 'native:cal-dana']);
    assertList(events.map(describe), [
      'Water the plants (for Dana, by Dana, done)',
      'Vitamins (for Dana, by me)',
      'Dentist',
      'Renew passport (mine, by me)',
      'Call the bank (mine, by Dana)',
      'Buy milk (for Dana, by me, snoozed)',
      'Pick up the cake (for Dana, by me)',
    ]);
  });

  await check('after unlinking, Raziel\'s reminder for Dana is gone and hers for him is hers again', async () => {
    household();
    db.pairings[0].status = 'UNLINKED';
    const events = await fetchDay(DANA, ['native:cal-dana']);
    assertList(events.map(describe), [
      'Water the plants (mine, by me, done)',
      'Dentist',
      'Call the bank (mine, by me)',
    ]);
  });

  await check('a partner with Google connected (the legacy column says GOOGLE): Dana\'s reminder for him stays his (Google as a connection)', async () => {
    household();
    db.users.find((u) => u.id === RAZIEL)!.calendarSource = 'GOOGLE';
    const events = await fetchDay(DANA, ['native:cal-dana']);
    assert(events.map(describe).includes('Call the bank (for Raziel, by me)'), events.map(describe).join(' | '));
  });

  await check('an unpaired user with no reminders: no partner, state or extra event queries', async () => {
    household();
    const events = await fetchDay(NOAM, ['native:cal-noam']);
    assertList(events.map(describe), ['Gym']);
    assertList(queries, ['nativeCalendar.findMany', 'nativeEvent.findMany', 'nativeEventInstance.findMany']);
  });

  await check('createEvent: a reminder reaches the store as a REMINDER for the partner, an event as before', async () => {
    household();
    const dana = viewer(DANA);
    const time = at('2026-10-15 10:00');
    const made = await nativeProvider.createEvent(dana, 'native:cal-dana', { title: 'Call the bank', startTime: time, endTime: time, kind: 'reminder', forUserId: RAZIEL });
    const row = db.events[db.events.length - 1];
    assert(made.success && made.eventId === row.id, `result ${JSON.stringify(made)}`);
    assert(row.kind === 'REMINDER' && row.forUserId === RAZIEL && row.creatorUserId === DANA, `reminder row ${JSON.stringify(row)}`);
    const end = at('2026-10-15 11:00');
    await nativeProvider.createEvent(dana, 'native:cal-dana', { title: 'Dentist', startTime: time, endTime: end });
    const eventRow = db.events[db.events.length - 1];
    // The store leaves both columns out for an event, so the database defaults (EVENT, null) apply; the stand-in has none.
    assert((eventRow.kind ?? 'EVENT') === 'EVENT' && (eventRow.forUserId ?? null) === null, `event row ${JSON.stringify(eventRow)}`);
    assert((eventRow.endsAt as Date).getTime() === end.getTime(), `event ends ${String(eventRow.endsAt)}`);
  });

  // The bot's Hebrew repeat (hebrew-repeats spec §2, §5): the provider stores the pair its caller
  // decided, checks the anchor, and an ordinary repeat keeps both columns empty.
  await check('createEvent: a Hebrew repeat stores the kind and the anchor with the yearly rule; an ordinary one stores neither', async () => {
    household();
    const dana = viewer(DANA);
    // 22:30 UTC on 19 Dec is 00:30 on the 20th in Israel
    const start = new Date('2026-12-19T22:30:00Z');
    const made = await nativeProvider.createEvent(dana, 'native:cal-dana', {
      title: 'Yahrzeit', startTime: start, endTime: start, recurrence: ['RRULE:FREQ=YEARLY'], hebrewRule: 'anniversary', hebrewAnchor: '2026-12-20',
    });
    const row = db.events[db.events.length - 1];
    assert(made.success && made.eventId === row.id, `result ${JSON.stringify(made)}`);
    assert(row.rrule === 'FREQ=YEARLY' && row.hebrewRule === 'anniversary' && row.hebrewAnchor === '2026-12-20', `row ${JSON.stringify(row)}`);
    await nativeProvider.createEvent(dana, 'native:cal-dana', { title: 'Weekly', startTime: start, endTime: start, recurrence: ['RRULE:FREQ=WEEKLY'] });
    const plain = db.events[db.events.length - 1];
    assert(plain.rrule === 'FREQ=WEEKLY' && (plain.hebrewRule ?? null) === null && (plain.hebrewAnchor ?? null) === null, `plain row ${JSON.stringify(plain)}`);
  });

  await check('createEvent: an anchor that is not the start\'s day, or a kind without a yearly rule, is refused and writes nothing', async () => {
    household();
    const dana = viewer(DANA);
    const before = db.events.length;
    const start = at('2026-12-20 00:00');
    const wrongDay = await nativeProvider.createEvent(dana, 'native:cal-dana', {
      title: 'Yahrzeit', startTime: start, endTime: start, recurrence: ['RRULE:FREQ=YEARLY'], hebrewRule: 'anniversary', hebrewAnchor: '2026-12-21',
    });
    const weekly = await nativeProvider.createEvent(dana, 'native:cal-dana', {
      title: 'Yahrzeit', startTime: start, endTime: start, recurrence: ['RRULE:FREQ=WEEKLY'], hebrewRule: 'anniversary', hebrewAnchor: '2026-12-20',
    });
    assert(!wrongDay.success && !weekly.success && db.events.length === before, `${JSON.stringify([wrongDay, weekly])}, ${db.events.length - before} rows written`);
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

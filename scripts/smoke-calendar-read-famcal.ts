// Smoke test for the FamCal half of the calendar reader (spec §2.4): readFamcal and
// carryOverReadItems (src/services/calendar-read/famcal.ts), the fetchViewerItems split
// of the native provider (src/services/calendar-provider/native-provider.ts) and
// fetchOpenReminderItems (src/services/native-reminders/open-reminders.ts).
//
// The reader hands the summaries exactly the events the provider reads today (A-1,
// A-4), never reads a calendar outside the viewer's legend, masks the partner's PRIVATE
// calendar on a reminder-for-me, and makes no query for a Google user. The real event
// store, provider, ownership and open-reminders code run against an in-memory Prisma.
// No network, no DB.
//
// Run under both clocks; the output must not depend on the server's timezone:
//   TZ=UTC npx tsx scripts/smoke-calendar-read-famcal.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-calendar-read-famcal.ts

import path from 'path';
import { fromZonedTime } from 'date-fns-tz';
import type { NativeCalendar, NativeEvent, NativeEventInstance, NativeReminderState } from '@prisma/client';
import type { UserConfig } from '../src/types';
import type { CalendarRef, ReadItem } from '../src/services/calendar-read/types';

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

/** JSON that also prints the partner's telegramId (a BigInt). */
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x));

function assertJson(got: unknown, want: unknown, what: string) {
  const g = json(got);
  const w = json(want);
  assert(g === w, `${what}\n     got  ${g}\n     want ${w}`);
}

globalThis.fetch = (async (input: unknown) => {
  throw new Error(`network is blocked in this smoke test: ${String(input)}`);
}) as typeof fetch;

const IL = 'Asia/Jerusalem';
const at = (local: string) => fromZonedTime(local, IL);

// ---- In-memory Prisma: the operators, relation filters, include and orderBy the code under test uses ----

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;
/** A model's relations: the row a row points at (to-one) or the rows it owns (to-many). */
type Relations = Record<string, (row: Row) => Row | Row[] | undefined>;
type FindArgs = {
  where?: Where;
  select?: Record<string, boolean>;
  include?: Record<string, boolean>;
  orderBy?: Record<string, 'asc' | 'desc'> | Array<Record<string, 'asc' | 'desc'>>;
};

const same = (a: unknown, b: unknown) => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b);

function matches(row: Row, where: Where, relations: Relations = {}): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as Where[]).some((w) => matches(row, w, relations));
    if (key === 'AND') return (Array.isArray(cond) ? (cond as Where[]) : [cond as Where]).every((w) => matches(row, w, relations));
    if (Object.hasOwn(relations, key)) {
      const target = relations[key](row);
      if (Array.isArray(target)) {
        const { some, ...rest } = cond as { some?: Where };
        if (!some || Object.keys(rest).length > 0) throw new Error(`stand-in Prisma only knows '${key}: { some }'`);
        return target.some((r) => matches(r, some));
      }
      return target !== undefined && matches(target, cond as Where);
    }
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

const sortKey = (row: Row, key: string) => {
  const v = row[key];
  return v instanceof Date ? v.getTime() : Number(v);
};

/** Every query, as "<model>.<method>", to see what a read costs. */
const queries: string[] = [];
/** The arguments of every nativeEvent.findMany, as JSON. */
const eventReads: string[] = [];
/** A query that throws, as "<model>.<method>", and what it throws. */
let failOn: string | null = null;
const failure = new Error('connection reset');

function table(name: string, rows: () => Row[], relations: Relations = {}) {
  const run = (method: string) => {
    queries.push(`${name}.${method}`);
    if (failOn === `${name}.${method}`) throw failure;
  };
  const shape = (row: Row, args: FindArgs) => {
    if (args.select) return Object.fromEntries(Object.keys(args.select).filter((k) => args.select![k]).map((k) => [k, row[k]]));
    const out: Row = { ...row };
    for (const [k, on] of Object.entries(args.include ?? {})) if (on) out[k] = relations[k](row);
    return out;
  };
  return {
    findMany: async (args: FindArgs = {}) => {
      run('findMany');
      if (name === 'nativeEvent') eventReads.push(json(args));
      const found = rows().filter((r) => matches(r, args.where ?? {}, relations));
      const orderBy = args.orderBy ? (Array.isArray(args.orderBy) ? args.orderBy : [args.orderBy]) : [];
      found.sort((a, b) => {
        for (const o of orderBy) {
          const [key, dir] = Object.entries(o)[0];
          const d = sortKey(a, key) - sortKey(b, key);
          if (d !== 0) return dir === 'asc' ? d : -d;
        }
        return 0;
      });
      return found.map((r) => shape(r, args));
    },
    findUnique: async (args: FindArgs & { where: Where }) => {
      run('findUnique');
      const row = rows().find((r) => matches(r, args.where, relations));
      return row ? shape(row, args) : null;
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
  nativeEvent: table('nativeEvent', () => db.events, {
    calendar: (r) => db.calendars.find((c) => c.id === r.calendarId),
    instances: (r) => db.instances.filter((i) => i.seriesEventId === r.id),
    states: (r) => db.states.filter((s) => s.seriesEventId === r.id),
  }),
  nativeEventInstance: table('nativeEventInstance', () => db.instances),
  nativeReminderState: table('nativeReminderState', () => db.states),
};

// ---- The household: Dana and Raziel, paired; Noam on his own; Gali on Google ----

const DANA = 1;
const RAZIEL = 2;
const NOAM = 3;
const GALI = 4;
const CREATED = at('2026-10-01 09:00');
const NEVER = at('2099-01-01 09:00');

function calendar(fields: Partial<NativeCalendar> & Pick<NativeCalendar, 'id' | 'ownerUserId' | 'name' | 'createdAt'>): NativeCalendar {
  return {
    color: '#039BE5', labels: ['yours'], personName: null, personEnglishName: null, personGender: null, rules: [],
    privacy: 'PRIVATE', isDeleted: false, updatedAt: CREATED,
    ...fields,
  };
}

function event(fields: Partial<NativeEvent> & Pick<NativeEvent, 'id' | 'calendarId' | 'creatorUserId' | 'title' | 'startsAt'>): NativeEvent {
  return {
    description: null, location: null, endsAt: fields.startsAt, allDay: false, timeZone: IL, rrule: null, hebrewRule: null, hebrewAnchor: null, exdates: [],
    reminderMinutes: null, isDeleted: false, createdAt: CREATED, updatedAt: CREATED,
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

function override(seriesEventId: string, originalStartsAt: Date, fields: Partial<NativeEventInstance>): NativeEventInstance {
  return {
    id: `inst-${seriesEventId}-${originalStartsAt.getTime()}`, seriesEventId, originalStartsAt, status: 'OVERRIDE',
    title: null, description: null, location: null, startsAt: null, endsAt: null, allDay: null, createdAt: CREATED, updatedAt: CREATED,
    ...fields,
  };
}

const user = (id: number, name: string, extra: Row = {}) => ({
  id, name, englishName: name, gender: 'female', calendarSource: 'NATIVE', telegramId: BigInt(1000 + id), language: 'en',
  pairingId: null, suspendedAt: null, googleRefreshToken: null, ...extra,
});

/** The name of Raziel's PRIVATE calendar: it must never reach a CalendarRef. */
const PRIVATE_NAME = 'Surprise party plans';

/** Each check starts from this household. The calendars are stored out of their creation order. */
function household() {
  db.users = [
    user(DANA, 'Dana', { pairingId: 'pair-1' }),
    user(RAZIEL, 'Raziel', { gender: 'male', pairingId: 'pair-1' }),
    user(NOAM, 'Noam', { gender: 'male' }),
    user(GALI, 'Gali', { calendarSource: 'GOOGLE', googleRefreshToken: 'fake-token' }),
  ];
  db.pairings = [{ id: 'pair-1', status: 'ACTIVE', inviterUserId: RAZIEL, inviteeUserId: DANA }];
  db.calendars = [
    calendar({ id: 'cal-raz-family', ownerUserId: RAZIEL, name: 'Family', labels: ['kids'], privacy: 'SHARED_VIEWER', color: '#33B679', createdAt: at('2026-09-03 09:00') }),
    calendar({ id: 'cal-dana', ownerUserId: DANA, name: 'Dana', labels: ['primary', 'yours'], privacy: 'SHARED_EDITOR', color: '#D50000', createdAt: at('2026-09-01 09:00') }),
    calendar({ id: 'cal-raz', ownerUserId: RAZIEL, name: PRIVATE_NAME, labels: ['primary', 'yours'], createdAt: at('2026-09-02 09:00') }),
    calendar({ id: 'cal-dana-kids', ownerUserId: DANA, name: 'Kids', labels: ['kids'], createdAt: at('2026-09-04 09:00') }),
    calendar({ id: 'cal-raz-old', ownerUserId: RAZIEL, name: 'Old', isDeleted: true, createdAt: at('2026-09-05 09:00') }),
    calendar({ id: 'cal-noam', ownerUserId: NOAM, name: 'Noam', createdAt: at('2026-09-06 09:00') }),
  ];
  db.events = [
    // Tuesday 2026-10-13, the day read.
    event({ id: 'ev-dentist', calendarId: 'cal-dana', creatorUserId: DANA, title: 'Dentist', startsAt: at('2026-10-13 10:00'), endsAt: at('2026-10-13 11:00') }),
    event({
      id: 'ev-swim', calendarId: 'cal-dana-kids', creatorUserId: DANA, title: 'Swim', startsAt: at('2026-10-06 16:00'), endsAt: at('2026-10-06 17:00'),
      rrule: 'FREQ=WEEKLY;BYDAY=TU',
    }),
    reminder({ id: 'rem-plants', calendarId: 'cal-dana', creatorUserId: DANA, title: 'Water the plants', startsAt: at('2026-10-13 00:00'), allDay: true }),
    reminder({ id: 'rem-bank', calendarId: 'cal-dana', creatorUserId: DANA, forUserId: RAZIEL, title: 'Call the bank', startsAt: at('2026-10-13 15:00') }),
    // Raziel's, on his PRIVATE calendar: Dana sees only the ones for her.
    reminder({ id: 'rem-milk', calendarId: 'cal-raz', creatorUserId: RAZIEL, forUserId: DANA, title: 'Buy milk', startsAt: at('2026-10-13 17:00') }),
    reminder({ id: 'rem-raz-own', calendarId: 'cal-raz', creatorUserId: RAZIEL, title: 'Renew passport', startsAt: at('2026-10-13 12:00') }),
    reminder({
      id: 'rem-vitamins', calendarId: 'cal-raz', creatorUserId: RAZIEL, forUserId: DANA, title: 'Vitamins',
      startsAt: at('2026-10-10 08:00'), rrule: 'FREQ=DAILY',
    }),
    // On his shared calendar: the reminder comes back from both reads, and is listed once.
    event({ id: 'ev-dinner', calendarId: 'cal-raz-family', creatorUserId: RAZIEL, title: 'Family dinner', startsAt: at('2026-10-13 19:00'), endsAt: at('2026-10-13 21:00') }),
    reminder({ id: 'rem-cake', calendarId: 'cal-raz-family', creatorUserId: RAZIEL, forUserId: DANA, title: 'Pick up the cake', startsAt: at('2026-10-13 18:00') }),
    event({ id: 'ev-noam', calendarId: 'cal-noam', creatorUserId: NOAM, title: 'Gym', startsAt: at('2026-10-13 07:00'), endsAt: at('2026-10-13 08:00') }),
    // Before Tuesday: the carry-overs.
    reminder({ id: 'rem-yesterday', calendarId: 'cal-raz', creatorUserId: RAZIEL, forUserId: DANA, title: 'Book the plumber', startsAt: at('2026-10-12 17:00') }),
    reminder({ id: 'rem-library', calendarId: 'cal-dana', creatorUserId: DANA, title: 'Return the library books', startsAt: at('2026-10-11 10:00') }),
    reminder({ id: 'rem-recycling', calendarId: 'cal-dana', creatorUserId: DANA, title: 'Recycling out', startsAt: at('2026-10-04 08:00'), rrule: 'FREQ=WEEKLY;BYDAY=SU' }),
    reminder({ id: 'rem-done', calendarId: 'cal-dana', creatorUserId: DANA, title: 'Pay the nanny', startsAt: at('2026-10-12 09:00') }),
  ] as unknown as Row[];
  db.instances = [];
  db.states = [
    state({ seriesEventId: 'rem-plants', originalStartsAt: at('2026-10-13 00:00'), doneAt: at('2026-10-13 09:10'), doneByUserId: DANA }),
    state({ seriesEventId: 'rem-milk', originalStartsAt: at('2026-10-13 17:00'), snoozedUntil: NEVER }),
    state({ seriesEventId: 'rem-vitamins', originalStartsAt: at('2026-10-12 08:00'), doneAt: at('2026-10-12 08:05') }),
    state({ seriesEventId: 'rem-library', originalStartsAt: at('2026-10-11 10:00'), snoozedUntil: NEVER }),
    state({ seriesEventId: 'rem-done', originalStartsAt: at('2026-10-12 09:00'), doneAt: at('2026-10-12 09:30') }),
  ] as unknown as Row[];
  queries.length = 0;
  eventReads.length = 0;
  failOn = null;
}

/**
 * A weekly reminder of Dana's that starts on Tuesday the 20th, whose first time was
 * moved to Monday the 12th, 09:00: only Plan A's wider read (spec §8.2) loads it
 * before the 20th.
 */
function addMovedReminder() {
  db.events.push(reminder({
    id: 'rem-moved', calendarId: 'cal-dana', creatorUserId: DANA, title: 'Renew the parking permit',
    startsAt: at('2026-10-20 09:00'), rrule: 'FREQ=WEEKLY;BYDAY=TU',
  }) as unknown as Row);
  db.instances.push(override('rem-moved', at('2026-10-20 09:00'), { startsAt: at('2026-10-12 09:00'), endsAt: at('2026-10-12 09:00') }) as unknown as Row);
}

const viewer = (id: number) => db.users.find((u) => u.id === id) as unknown as UserConfig;
const DAY = { from: at('2026-10-13 00:00'), to: at('2026-10-14 00:00') };
const CUTOFF = at('2026-10-13 00:00');

/** An item as one line: its title, kind, calendar ref and state. */
function line(i: ReadItem): string {
  const ref = i.calendar.id ?? `masked as ${i.calendar.name}`;
  const st = i.state ? ` ${i.state.doneAt ? 'done' : i.state.snoozedUntil ? 'snoozed' : 'pending'}` : '';
  return `${i.title} [${i.kind}${st}] @ ${ref}`;
}

async function main() {
  // The stubs go into require's cache before the modules that import them load.
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
  const captured: string[] = [];
  stub('utils/prisma.ts', { prisma: fakePrisma });
  const record = (_what: unknown, where: string) => { captured.push(where); };
  stub('lib/error-capture.ts', { captureError: record, captureWarning: record, captureInfo: record });

  const { nativeProvider, fetchViewerItems } = await import('../src/services/calendar-provider/native-provider');
  const { getCalendarAssignmentsForUser } = await import('../src/services/calendar-provider/user-calendars');
  const { fetchOpenReminders, fetchOpenReminderItems } = await import('../src/services/native-reminders/open-reminders');
  const { readFamcal, carryOverReadItems } = await import('../src/services/calendar-read/famcal');
  const { toRangeDays } = await import('../src/services/calendar-read/dto');

  /** The day exactly as a summary reads it today: the resolved ids, then the provider. */
  const providerDay = async (id: number) => {
    const ids = (await getCalendarAssignmentsForUser(viewer(id))).map((a) => a.calendarId);
    return { ids, events: await nativeProvider.fetchEventsInRange(viewer(id), ids, DAY.from, DAY.to) };
  };

  // ---- fetchViewerItems: the provider's read, with each row and state beside its event ----

  await check('fetchViewerItems: the provider\'s events, each with its row and state, from the same queries', async () => {
    household();
    const ids = ['native:cal-dana', 'native:cal-dana-kids', 'native:cal-raz-family'];
    const viaProvider = await nativeProvider.fetchEventsInRange(viewer(DANA), ids, DAY.from, DAY.to);
    const providerQueries = [...queries];
    household();
    const { ctx, items } = await fetchViewerItems(viewer(DANA), ['cal-dana', 'cal-dana-kids', 'cal-raz-family'], DAY);
    assertJson(items.map((i) => i.event), viaProvider, 'events');
    assertJson(queries, providerQueries, 'queries');
    assert(ctx.viewerId === DANA && ctx.partner?.id === RAZIEL && ctx.partner.name === 'Raziel', `ctx ${json(ctx)}`);
    for (const i of items) {
      assert(i.row.instance.title === i.event.summary, `${i.event.summary}: row ${i.row.instance.title}`);
      assert(i.row.series.kind === (i.event.eventType === 'reminder' ? 'REMINDER' : 'EVENT'), `${i.event.summary}: kind ${i.row.series.kind}`);
    }
    const stateOf = (title: string) => {
      const item = items.find((i) => i.event.summary === title);
      assert(item !== undefined, `no ${title}`);
      return 'state' in item ? item.state : 'no key';
    };
    const plants = stateOf('Water the plants');
    assert(plants !== 'no key' && plants?.doneAt?.getTime() === at('2026-10-13 09:10').getTime(), 'plants: its done row');
    const milk = stateOf('Buy milk');
    assert(milk !== 'no key' && milk?.snoozedUntil?.getTime() === NEVER.getTime(), 'milk: its snoozed row');
    assert(stateOf('Vitamins') === 'no key', 'vitamins: today has no row, so no state key');
    assert(stateOf('Dentist') === 'no key', 'an event has no state key');
  });

  // ---- readFamcal ----

  await check('readFamcal: Dana\'s events are exactly what her summary reads today (A-1, A-4), in its order', async () => {
    household();
    const today = await providerDay(DANA);
    household();
    const { read, items } = await readFamcal(viewer(DANA), DAY, {});
    assert(read.status === 'ok', `status ${read.status}`);
    assertJson(items.map((i) => i.event), today.events, 'events');
    household();
    const narrowed = await readFamcal(viewer(DANA), DAY, { calendarIds: today.ids });
    assertJson(narrowed.items.map((i) => i.event), today.events, 'events with the summary\'s ids');
  });

  await check('readFamcal: the legend is her own calendars of any privacy, then Raziel\'s shared one, with his name', async () => {
    household();
    const { read } = await readFamcal(viewer(DANA), DAY, {});
    assert(read.status === 'ok', `status ${read.status}`);
    const want: CalendarRef[] = [
      { id: 'native:cal-dana', source: 'famcal', name: 'Dana', color: '#D50000', mine: true, inLegend: true },
      { id: 'native:cal-raz-family', source: 'famcal', name: 'Family', color: '#33B679', mine: false, ownerName: 'Raziel', inLegend: true },
      { id: 'native:cal-dana-kids', source: 'famcal', name: 'Kids', color: '#039BE5', mine: true, inLegend: true },
    ];
    assertJson(read.calendars, want, 'calendars');
    assertJson(read.partner, { name: 'Raziel' }, 'partner');
    assert(read.ctx.viewerId === DANA && read.ctx.partner?.id === RAZIEL, `ctx ${json(read.ctx)}`);
  });

  await check('readFamcal: every item\'s fields', async () => {
    household();
    const { items } = await readFamcal(viewer(DANA), DAY, {});
    assertJson(items.map(line), [
      'Water the plants [reminder done] @ native:cal-dana',
      'Vitamins [reminder pending] @ masked as Raziel',
      'Dentist [event] @ native:cal-dana',
      'Call the bank [reminder pending] @ native:cal-dana',
      'Swim [event] @ native:cal-dana-kids',
      'Buy milk [reminder snoozed] @ masked as Raziel',
      'Pick up the cake [reminder pending] @ native:cal-raz-family',
      'Family dinner [event] @ native:cal-raz-family',
    ], 'items');
    const vitamins08 = at('2026-10-13 08:00').toISOString();
    const swim16 = at('2026-10-13 16:00').toISOString();
    const fields = (i: ReadItem) => ({
      source: i.source, key: i.key, title: i.title, kind: i.kind, seriesId: i.seriesId, originalStart: i.originalStart,
      recurring: i.recurring, rrule: i.rrule, state: i.state ?? 'none', google: i.google ?? 'none', summaryIsTitle: i.event.summary === i.title,
    });
    const byTitle = (t: string) => {
      const i = items.find((x) => x.title === t);
      assert(i !== undefined, `no ${t}`);
      return fields(i);
    };
    assertJson(byTitle('Vitamins'), {
      source: 'famcal', key: `famcal|rem-vitamins#${vitamins08}`, title: 'Vitamins', kind: 'reminder', seriesId: 'rem-vitamins',
      originalStart: vitamins08, recurring: true, rrule: 'FREQ=DAILY', state: { doneAt: null, snoozedUntil: null }, google: 'none', summaryIsTitle: true,
    }, 'Vitamins');
    assertJson(byTitle('Water the plants'), {
      source: 'famcal', key: 'famcal|rem-plants', title: 'Water the plants', kind: 'reminder', seriesId: 'rem-plants',
      originalStart: at('2026-10-13 00:00').toISOString(), recurring: false, rrule: null,
      state: { doneAt: at('2026-10-13 09:10'), snoozedUntil: null }, google: 'none', summaryIsTitle: true,
    }, 'Water the plants (a one-off has its originalStart too)');
    assertJson(byTitle('Buy milk').state, { doneAt: null, snoozedUntil: NEVER }, 'Buy milk state');
    assertJson(byTitle('Swim'), {
      source: 'famcal', key: `famcal|ev-swim#${swim16}`, title: 'Swim', kind: 'event', seriesId: 'ev-swim',
      originalStart: swim16, recurring: true, rrule: 'FREQ=WEEKLY;BYDAY=TU', state: 'none', google: 'none', summaryIsTitle: true,
    }, 'Swim');
    assertJson(byTitle('Dentist'), {
      source: 'famcal', key: 'famcal|ev-dentist', title: 'Dentist', kind: 'event', seriesId: 'ev-dentist',
      originalStart: at('2026-10-13 10:00').toISOString(), recurring: false, rrule: null, state: 'none', google: 'none', summaryIsTitle: true,
    }, 'Dentist');
  });

  await check('readFamcal: a Hebrew-date series reads on its Hebrew day (2 Cheshvan, not the Gregorian 24 Oct) and its item carries the pair', async () => {
    household();
    db.events.push(event({
      id: 'ev-heb', calendarId: 'cal-dana', creatorUserId: DANA, title: 'Grandma', startsAt: at('2025-10-24 12:00'), endsAt: at('2025-10-24 13:00'),
      rrule: 'FREQ=YEARLY', hebrewRule: 'anniversary', hebrewAnchor: '2025-10-24',
    }) as unknown as Row);
    const { items } = await readFamcal(viewer(DANA), DAY, {});
    const heb = items.find((i) => i.seriesId === 'ev-heb');
    assert(heb !== undefined, `not read on 2 Cheshvan 5787: ${items.map((i) => i.title).join(', ')}`);
    assertJson([heb.key, heb.rrule, heb.hebrewRule, heb.hebrewAnchor], [`famcal|ev-heb#${at('2026-10-13 12:00').toISOString()}`, 'FREQ=YEARLY', 'anniversary', '2025-10-24'], 'the item');
    assertJson(items.filter((i) => i.seriesId !== 'ev-heb').every((i) => i.hebrewRule === null && i.hebrewAnchor === null), true, 'the rest have none');
  });

  await check('readFamcal: a reminder-for-me from Raziel\'s PRIVATE calendar never names that calendar', async () => {
    household();
    const { read, items } = await readFamcal(viewer(DANA), DAY, {});
    assert(read.status === 'ok', `status ${read.status}`);
    const masked: CalendarRef = { id: null, source: 'famcal', name: 'Raziel', color: null, mine: false, inLegend: false };
    for (const title of ['Buy milk', 'Vitamins']) {
      const item = items.find((i) => i.title === title);
      assertJson(item?.calendar, masked, `${title} calendar`);
      // The summaries still get the real calendar, as today (A-5, A-6).
      assert(item?.event.calendarName === PRIVATE_NAME && item.event.calendarId === 'native:cal-raz', `${title} event ${item?.event.calendarId}`);
    }
    const refs = json([read.calendars, items.map((i) => i.calendar)]);
    assert(!refs.includes(PRIVATE_NAME) && !refs.includes('"native:cal-raz"') && !refs.includes('"cal-raz"'), `refs ${refs}`);
    assert(!items.some((i) => i.title === 'Renew passport'), 'Raziel\'s own private reminder leaked');
  });

  await check('readFamcal: Raziel sees the other side, Dana\'s shared calendar named after her', async () => {
    household();
    const today = await providerDay(RAZIEL);
    household();
    const { read, items } = await readFamcal(viewer(RAZIEL), DAY, {});
    assert(read.status === 'ok', `status ${read.status}`);
    assertJson(items.map((i) => i.event), today.events, 'events');
    assertJson(read.calendars.map((c) => [c.id, c.mine, c.ownerName ?? null]), [
      ['native:cal-dana', false, 'Dana'],
      ['native:cal-raz', true, null],
      ['native:cal-raz-family', true, null],
    ], 'legend');
    assert(!items.some((i) => i.title === 'Swim'), 'Dana\'s PRIVATE Kids calendar leaked');
    assert(items.every((i) => i.calendar.inLegend), `masked: ${items.filter((i) => !i.calendar.inLegend).map(line).join(' | ')}`);
  });

  await check('readFamcal: calendarIds narrow the legend, and an id outside it is never read', async () => {
    household();
    const today = await nativeProvider.fetchEventsInRange(viewer(DANA), ['native:cal-dana'], DAY.from, DAY.to);
    household();
    const { read, items } = await readFamcal(viewer(DANA), DAY, { calendarIds: ['native:cal-dana', 'native:cal-noam'] });
    assert(read.status === 'ok', `status ${read.status}`);
    assertJson(read.calendars.map((c) => c.id), ['native:cal-dana'], 'legend');
    assertJson(items.map((i) => i.event), today, 'events, as the provider reads her one calendar');
    assert(!items.some((i) => i.title === 'Gym'), 'read Noam\'s calendar');
    // Off the narrowed legend, Raziel's reminder for her on his shared calendar is masked.
    assertJson(items.find((i) => i.title === 'Pick up the cake')?.calendar.id, null, 'cake ref id');
  });

  await check('readFamcal: no legend calendar, no items and no event read, as the provider', async () => {
    household();
    db.calendars.find((c) => c.id === 'cal-noam')!.isDeleted = true;
    const noam = await readFamcal(viewer(NOAM), DAY, {});
    assertJson(noam, { read: { status: 'ok', ctx: { viewerId: NOAM, partner: null }, calendars: [], partner: null }, items: [] }, 'Noam');
    assert(!queries.some((q) => q.startsWith('nativeEvent.')), `queries ${queries.join(', ')}`);
    household();
    const none = await readFamcal(viewer(DANA), DAY, { calendarIds: [] });
    assert(none.read.status === 'ok' && none.read.calendars.length === 0 && none.items.length === 0, json(none.read));
    assert(none.read.partner?.name === 'Raziel', 'the partner is still named');
    assert(!queries.some((q) => q.startsWith('nativeEvent.')), `queries ${queries.join(', ')}`);
  });

  await check('readFamcal: a Google user reads FamCal too (Google as a connection); with no FamCal calendar of their own, an empty ok half', async () => {
    household();
    const { read, items } = await readFamcal(viewer(GALI), DAY, {});
    assert(read.status === 'ok' && items.length === 0 && read.calendars.length === 0, `read ${json(read)}`);
  });

  await check('readFamcal: a database error is the half\'s error, with its cause', async () => {
    for (const where of ['nativeCalendar.findMany', 'nativeEvent.findMany', 'nativeReminderState.findMany', 'pairing.findUnique']) {
      household();
      failOn = where;
      const { read, items } = await readFamcal(viewer(DANA), DAY, {});
      assert(read.status === 'error' && read.cause === failure && items.length === 0, `${where}: ${json(read)}`);
    }
  });

  await check('readFamcal: Noam alone: his calendar, no partner', async () => {
    household();
    const { read, items } = await readFamcal(viewer(NOAM), DAY, {});
    assert(read.status === 'ok' && read.partner === null && read.ctx.partner === null, json(read));
    assertJson(items.map(line), ['Gym [event] @ native:cal-noam'], 'items');
    assertJson(read.calendars, [{ id: 'native:cal-noam', source: 'famcal', name: 'Noam', color: '#039BE5', mine: true, inLegend: true }], 'calendars');
  });

  await check('readFamcal: a suspended partner\'s items stay (R4)', async () => {
    household();
    const before = (await readFamcal(viewer(DANA), DAY, {})).items.map(line);
    household();
    db.users.find((u) => u.id === RAZIEL)!.suspendedAt = at('2026-10-12 12:00');
    const after = (await readFamcal(viewer(DANA), DAY, {})).items.map(line);
    assertJson(after, before, 'items');
  });

  await check('readFamcal: a partner who moved to Google: her own calendars only, the partner still named', async () => {
    household();
    const razielRow = db.users.find((u) => u.id === RAZIEL)!;
    razielRow.calendarSource = 'GOOGLE';
    for (const c of db.calendars) if (c.ownerUserId === RAZIEL) c.isDeleted = true;
    const today = await providerDay(DANA);
    const { read, items } = await readFamcal(viewer(DANA), DAY, {});
    assert(read.status === 'ok', `status ${read.status}`);
    assertJson(read.calendars.map((c) => c.id), ['native:cal-dana', 'native:cal-dana-kids'], 'legend');
    assertJson(read.partner, { name: 'Raziel' }, 'partner');
    assertJson(items.map((i) => i.event), today.events, 'events');
  });

  // ---- fetchOpenReminderItems and carryOverReadItems ----

  const cutoffDay = '2026-10-13';
  const danaCtx = async () => {
    const r = await readFamcal(viewer(DANA), DAY, {});
    assert(r.read.status === 'ok', 'Dana\'s read failed');
    return r.read;
  };

  await check('fetchOpenReminderItems: the same read as fetchOpenReminders, paired or not', async () => {
    household();
    const famcal = await danaCtx();
    for (const ctx of [famcal.ctx, { viewerId: DANA, partner: null }]) {
      eventReads.length = 0;
      await fetchOpenReminders(viewer(DANA), ctx, CUTOFF, cutoffDay, IL, Infinity);
      await fetchOpenReminderItems(viewer(DANA), ctx, CUTOFF, cutoffDay, IL, Infinity);
      assert(eventReads.length === 2 && eventReads[0] === eventReads[1], `reads\n     ${eventReads.join('\n     ')}`);
    }
  });

  await check('fetchOpenReminderItems: the same carry-overs, newest first, each with its occurrence and state row', async () => {
    household();
    const famcal = await danaCtx();
    const old = await fetchOpenReminders(viewer(DANA), famcal.ctx, CUTOFF, cutoffDay, IL, Infinity);
    const { items, moreCount } = await fetchOpenReminderItems(viewer(DANA), famcal.ctx, CUTOFF, cutoffDay, IL, Infinity);
    assertJson(items.map((i) => i.event), old.events, 'events');
    assert(moreCount === old.moreCount && moreCount === 0, `moreCount ${moreCount}`);
    assertJson(items.map((i) => [i.event.summary, i.series.id, i.calendar.id, i.instanceStartsAt.toISOString(), i.state ? i.state.snoozedUntil : 'none']), [
      ['Book the plumber', 'rem-yesterday', 'cal-raz', at('2026-10-12 17:00').toISOString(), 'none'],
      ['Return the library books', 'rem-library', 'cal-dana', at('2026-10-11 10:00').toISOString(), NEVER.toISOString()],
      ['Recycling out', 'rem-recycling', 'cal-dana', at('2026-10-11 08:00').toISOString(), 'none'],
    ], 'items');
    assert(items.every((i) => i.event.reminder?.openSince !== undefined), 'openSince missing');
  });

  await check('fetchOpenReminderItems: a Hebrew-date reminder is carried from its Hebrew day (12 Oct this year), keyed by that slot', async () => {
    household();
    // Anchored a year earlier on 23 Oct 2025: the same Hebrew date is 12 Oct 2026.
    db.events.push(reminder({
      id: 'rem-heb', calendarId: 'cal-dana', creatorUserId: DANA, title: 'Call Grandma', startsAt: at('2025-10-23 16:00'),
      rrule: 'FREQ=YEARLY', hebrewRule: 'anniversary', hebrewAnchor: '2025-10-23',
    }) as unknown as Row);
    const famcal = await danaCtx();
    const { items } = await fetchOpenReminderItems(viewer(DANA), famcal.ctx, CUTOFF, cutoffDay, IL, Infinity);
    assertJson(items.map((i) => [i.event.summary, i.instanceStartsAt.toISOString(), i.event.reminder?.openSince]), [
      ['Book the plumber', at('2026-10-12 17:00').toISOString(), '2026-10-12'],
      ['Call Grandma', at('2026-10-12 16:00').toISOString(), '2026-10-12'],
      ['Return the library books', at('2026-10-11 10:00').toISOString(), '2026-10-11'],
      ['Recycling out', at('2026-10-11 08:00').toISOString(), '2026-10-11'],
    ], 'items');
  });

  await check('fetchOpenReminderItems: the cap and the count past it, as fetchOpenReminders', async () => {
    household();
    const famcal = await danaCtx();
    const old = await fetchOpenReminders(viewer(DANA), famcal.ctx, CUTOFF, cutoffDay, IL, 2);
    const { items, moreCount } = await fetchOpenReminderItems(viewer(DANA), famcal.ctx, CUTOFF, cutoffDay, IL, 2);
    assertJson(items.map((i) => i.event), old.events, 'events');
    assert(items.length === 2 && moreCount === 1 && old.moreCount === 1, `${items.length} items, moreCount ${moreCount}/${old.moreCount}`);
  });

  await check('fetchOpenReminderItems: a Google user is never read', async () => {
    household();
    const none = await fetchOpenReminderItems(viewer(GALI), { viewerId: GALI, partner: null }, CUTOFF, cutoffDay, IL, Infinity);
    assertJson(none, { items: [], moreCount: 0 }, 'result');
    assertJson(queries, [], 'queries');
  });

  await check('carryOverReadItems: masked off the legend, named on it; originalStart is the occurrence\'s', async () => {
    household();
    const famcal = await danaCtx();
    const { items } = await fetchOpenReminderItems(viewer(DANA), famcal.ctx, CUTOFF, cutoffDay, IL, Infinity);
    const read = carryOverReadItems(famcal, items);
    assertJson(read.map(line), [
      'Book the plumber [reminder pending] @ masked as Raziel',
      'Return the library books [reminder snoozed] @ native:cal-dana',
      'Recycling out [reminder pending] @ native:cal-dana',
    ], 'items');
    const recycling = read[2];
    const sunday = at('2026-10-11 08:00').toISOString();
    assertJson(
      [recycling.key, recycling.originalStart, recycling.seriesId, recycling.recurring, recycling.rrule, recycling.source],
      [`famcal|rem-recycling#${sunday}`, sunday, 'rem-recycling', true, 'FREQ=WEEKLY;BYDAY=SU', 'famcal'],
      'the weekly one',
    );
    const library = read[1];
    assertJson([library.key, library.originalStart, library.recurring, library.state], [
      'famcal|rem-library', at('2026-10-11 10:00').toISOString(), false, { doneAt: null, snoozedUntil: NEVER },
    ], 'the one-off');
    assert(read.every((r, i) => r.event === items[i].event), 'the event is not the carry-over\'s own');
    const refs = json(read.map((r) => r.calendar));
    assert(!refs.includes(PRIVATE_NAME) && !refs.includes('cal-raz"'), `refs ${refs}`);
  });

  await check('fetchOpenReminderItems: a first time moved before the series start is carried, keyed by its original slot (Plan A)', async () => {
    household();
    addMovedReminder();
    const famcal = await danaCtx();
    const old = await fetchOpenReminders(viewer(DANA), famcal.ctx, CUTOFF, cutoffDay, IL, Infinity);
    const { items } = await fetchOpenReminderItems(viewer(DANA), famcal.ctx, CUTOFF, cutoffDay, IL, Infinity);
    assertJson(items.map((i) => i.event), old.events, 'events');
    const slot = at('2026-10-20 09:00').toISOString();
    const moved = items.find((i) => i.series.id === 'rem-moved');
    assert(moved !== undefined, `not carried: [${items.map((i) => i.event.summary).join(', ')}]; Plan A's wider fetchOpenReminders read is missing`);
    assert(moved.instanceStartsAt.toISOString() === slot && moved.event.start === at('2026-10-12 09:00').toISOString(), `moved ${moved.instanceStartsAt.toISOString()} ${moved.event.start}`);
    const [asRead] = carryOverReadItems(famcal, [moved]);
    assertJson([asRead.key, asRead.originalStart], [`famcal|rem-moved#${slot}`, slot], 'its ReadItem');
  });

  await check('readFamcal: today\'s Vitamins moved to 10:30 tomorrow ("just this one") is read on tomorrow, keyed and stated by today\'s 08:00 slot', async () => {
    household();
    const slot = at('2026-10-13 08:00');
    const movedTo = at('2026-10-14 10:30');
    db.instances.push(override('rem-vitamins', slot, { startsAt: movedTo, endsAt: movedTo }) as unknown as Row);
    db.states.push(state({ seriesEventId: 'rem-vitamins', originalStartsAt: slot, doneAt: at('2026-10-13 09:30'), doneByUserId: DANA }) as unknown as Row);
    const { read, items } = await readFamcal(viewer(DANA), { from: at('2026-10-13 00:00'), to: at('2026-10-15 00:00') }, {});
    assert(read.status === 'ok', `status ${read.status}`);
    const vitamins = items.filter((i) => i.seriesId === 'rem-vitamins');
    const tomorrow08 = at('2026-10-14 08:00').toISOString();
    assertJson(vitamins.map((i) => [i.key, i.event.start, i.originalStart, i.state]), [
      [`famcal|rem-vitamins#${tomorrow08}`, tomorrow08, tomorrow08, { doneAt: null, snoozedUntil: null }],
      [`famcal|rem-vitamins#${slot.toISOString()}`, movedTo.toISOString(), slot.toISOString(), { doneAt: at('2026-10-13 09:30'), snoozedUntil: null }],
    ], 'the two Vitamins in the two days: tomorrow\'s own, then today\'s moved one');
    const days = toRangeDays(items, '2026-10-13', '2026-10-15', IL, at('2026-10-13 12:00'), '2026-10-13');
    const onDay = (date: string) => days.find((d) => d.date === date)?.items.filter((i) => i.seriesId === 'rem-vitamins') ?? [];
    assertJson(onDay('2026-10-13').map((i) => i.key), [], 'listed today');
    assertJson(onDay('2026-10-14').map((i) => [i.key, i.start, i.originalStart, i.reminder?.done, i.reminder?.open]), [
      [`famcal|rem-vitamins#${tomorrow08}`, tomorrow08, tomorrow08, false, false],
      [`famcal|rem-vitamins#${slot.toISOString()}`, movedTo.toISOString(), slot.toISOString(), true, false],
    ], 'listed tomorrow');
  });

  await check('nothing above reported an error', () => {
    assert(captured.length === 0, `captureError: ${captured.join(', ')}`);
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

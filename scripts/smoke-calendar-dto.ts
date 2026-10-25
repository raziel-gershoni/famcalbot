// Smoke test for the calendar home's DTO layer (spec §4, §10): the day buckets and item
// DTOs in src/services/calendar-read/dto.ts, compareItems in
// src/lib/calendar-view/types.ts, and reminderDueAt's move to the leaf
// src/services/native-reminders/due.ts. A day on the home must list exactly what the
// same day's summary lists (shapeEventsForDay), with the same spans, on overnight,
// multi-day, zero-length and DST fixtures. The JSON never carries a masked calendar's
// real name or id. Pure: no network, no database, no Redis.
//
// Run under three clocks; the output must not depend on the server's timezone:
//   TZ=UTC npx tsx scripts/smoke-calendar-dto.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-calendar-dto.ts
//   TZ=Pacific/Kiritimati npx tsx scripts/smoke-calendar-dto.ts

import path from 'path';
import { fromZonedTime } from 'date-fns-tz';
import { nextDate, shapeEventsForDay } from '../src/utils/day-events';
import { compareItems, type ItemDTO } from '../src/lib/calendar-view/types';
import { isOpenOnDay, toCalendarDto, toCarryOverDto, toItemDto, toRangeDays } from '../src/services/calendar-read/dto';
import { reminderDueAt } from '../src/services/native-reminders/due';
import type { CalendarRef, ReadItem } from '../src/services/calendar-read/types';
import type { UnifiedEvent } from '../src/services/calendar-provider/types';
import type { ReminderInfo } from '../src/types';

// What the static imports above loaded, before anything below can load more.
const LOADED_BY_DTO = Object.keys(require.cache);

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

function assertList(got: string[], want: string[], label = '') {
  assert(
    JSON.stringify(got) === JSON.stringify(want),
    `${label}\n     got  ${JSON.stringify(got, null, 1)}\n     want ${JSON.stringify(want, null, 1)}`
  );
}

const IL = 'Asia/Jerusalem';
const NY = 'America/New_York';
const SCL = 'America/Santiago';

/** A FamCal timed value: the UTC ISO string of a local wall time. */
const utc = (local: string, tz: string) => fromZonedTime(local, tz).toISOString();

// ---- Fixture builders ----

const OWN_CAL: CalendarRef = { id: 'native:cal-own', source: 'famcal', name: 'Raziel', color: '#039BE5', mine: true, inLegend: true };
const NOA_SHARED: CalendarRef = { id: 'native:cal-noa', source: 'famcal', name: 'Noa family', color: '#E67C73', mine: false, ownerName: 'Noa', inLegend: true };
const MASKED: CalendarRef = { id: null, source: 'famcal', name: 'Noa', color: null, mine: false, inLegend: false };
const GOOGLE_CAL: CalendarRef = { id: 'family@group.calendar.google.com', source: 'google', name: 'Family', color: '#7986CB', mine: true, inLegend: true };

type FamcalExtra = {
  kind?: 'event' | 'reminder';
  rrule?: string | null;
  state?: { doneAt: Date | null; snoozedUntil: Date | null };
  reminder?: ReminderInfo;
  tz?: string;
  calendar?: CalendarRef;
  calendarName?: string;
  calendarId?: string;
  originalStart?: string | null;
  description?: string;
  location?: string;
};

/** A FamCal ReadItem as readFamcal builds one: the provider's event plus the series facts. */
function famcal(eventId: string, title: string, start: string, end: string, extra: FamcalExtra = {}): ReadItem {
  const kind = extra.kind ?? 'event';
  const seriesId = eventId.split('#')[0];
  const event: UnifiedEvent = {
    summary: title,
    start,
    end,
    description: extra.description,
    location: extra.location,
    calendarName: extra.calendarName ?? (extra.calendar ?? OWN_CAL).name,
    calendarId: extra.calendarId ?? (extra.calendar ?? OWN_CAL).id ?? 'native:cal-own',
    eventType: kind === 'reminder' ? 'reminder' : undefined,
    recurringEventId: eventId.includes('#') ? seriesId : undefined,
    eventId,
    provider: 'native',
    instanceStartsAt: eventId.includes('#') ? eventId.split('#')[1] : undefined,
    timeZone: extra.tz ?? IL,
    ...(kind === 'reminder' ? { reminder: extra.reminder ?? { ownerIsViewer: true, creatorIsViewer: true } } : {}),
  };
  return {
    source: 'famcal',
    key: `famcal|${eventId}`,
    event,
    calendar: extra.calendar ?? OWN_CAL,
    title,
    kind,
    seriesId,
    originalStart: extra.originalStart !== undefined ? extra.originalStart : start.includes('T') ? start : null,
    recurring: !!extra.rrule,
    rrule: extra.rrule ?? null,
    hebrewRule: null,
    hebrewAnchor: null,
    ...(extra.state ? { state: extra.state } : {}),
  };
}

/** A Google ReadItem as mapGoogleEvent builds one (RFC 3339 times with the offset, or dates). */
function google(id: string, title: string | null, start: string, end: string, extra: { birthday?: boolean; htmlLink?: string | null } = {}): ReadItem {
  const event: UnifiedEvent = {
    summary: title ?? 'No title',
    start,
    end,
    calendarName: GOOGLE_CAL.name,
    calendarId: GOOGLE_CAL.id ?? '',
    eventType: extra.birthday ? 'birthday' : 'default',
    eventId: id,
    provider: 'google',
  };
  return {
    source: 'google',
    key: `google|${GOOGLE_CAL.id}|${id}`,
    event,
    calendar: GOOGLE_CAL,
    title,
    kind: 'event',
    seriesId: null,
    originalStart: null,
    recurring: false,
    rrule: null,
    hebrewRule: null,
    hebrewAnchor: null,
    google: { birthday: !!extra.birthday, htmlLink: extra.htmlLink ?? `https://www.google.com/calendar/event?eid=${id}` },
  };
}

const reminder = (eventId: string, title: string, at: string, extra: FamcalExtra = {}) =>
  famcal(eventId, title, at, at.includes('T') ? at : nextDate(at), { kind: 'reminder', ...extra });

// The clock the open marks are read at: Friday 16 October 2026, 10:30 in Israel.
const NOW = fromZonedTime('2026-10-16 10:30:00', IL);
const TODAY = '2026-10-16';

/** Each day as `id:span` ('-' within the day), in the DTO's order. */
function dayView(days: { date: string; items: ItemDTO[] }[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const day of days) out[day.date] = day.items.map(i => `${i.id}:${i.span ?? '-'}`);
  return out;
}

function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d < to; d = nextDate(d)) out.push(d);
  return out;
}

/**
 * toRangeDays against shapeEventsForDay, day by day: the same items with the same
 * spans (compared after sorting both, since a DTO day is sorted with compareItems),
 * every day present, and each day in compareItems order. Then the expected view.
 */
async function parity(name: string, items: ReadItem[], from: string, to: string, tz: string, want: Record<string, string[]>) {
  await check(`parity: ${name}`, () => {
    const days = toRangeDays(items, from, to, tz, NOW, TODAY);
    assertList(days.map(d => d.date), daysBetween(from, to), 'days');
    for (const day of days) {
      const expected = shapeEventsForDay(items.map(i => i.event), day.date, tz).map(e => `${e.eventId}:${e.daySpan ?? '-'}`).sort();
      const got = day.items.map(i => `${i.id}:${i.span ?? '-'}`).sort();
      assertList(got, expected, `${day.date} vs shapeEventsForDay`);
      for (let k = 1; k < day.items.length; k++) {
        assert(compareItems(day.items[k - 1], day.items[k]) < 0, `${day.date}: ${day.items[k - 1].id} before ${day.items[k].id} breaks compareItems`);
      }
    }
    const view = dayView(days);
    for (const date of Object.keys(want)) assertList(view[date] ?? [], want[date], date);
  });
}

async function main() {
  // ---- The module graph ----

  await check('dto.ts, calendar-view/types.ts and due.ts load no Prisma', () => {
    const prismaModules = LOADED_BY_DTO.filter(p => /[\\/]@prisma[\\/]|[\\/]\.prisma[\\/]|[\\/]src[\\/]utils[\\/]prisma\./.test(p));
    assert(LOADED_BY_DTO.some(p => p.endsWith(path.join('calendar-read', 'dto.ts'))), 'dto.ts not in require.cache: the check would be empty');
    assertList(prismaModules, []);
  });

  await check('reminderDueAt: a timed reminder is due at its time, a date-only one at 09:00 in the viewer\'s timezone', () => {
    assert(reminderDueAt({ start: '2026-10-16T05:00:00.000Z' }, IL).toISOString() === '2026-10-16T05:00:00.000Z', 'timed');
    assert(reminderDueAt({ start: '2026-10-16' }, IL).toISOString() === '2026-10-16T06:00:00.000Z', `IL ${reminderDueAt({ start: '2026-10-16' }, IL).toISOString()}`);
    assert(reminderDueAt({ start: '2026-10-16' }, NY).toISOString() === '2026-10-16T13:00:00.000Z', `NY ${reminderDueAt({ start: '2026-10-16' }, NY).toISOString()}`);
  });

  await check('reminderDueAt: open-reminders.ts re-exports the one in due.ts', async () => {
    // open-reminders.ts reads the database; a stand-in Prisma keeps it offline.
    const Module = (await import('module')).default as unknown as {
      new (id: string): { filename: string; loaded: boolean; exports: unknown };
      _cache: Record<string, unknown>;
    };
    const filename = path.resolve(__dirname, '../src/utils/prisma.ts');
    const mod = new Module(filename);
    Object.assign(mod, { filename, loaded: true, exports: { prisma: {} } });
    Module._cache[filename] = mod;
    const openReminders = await import('../src/services/native-reminders/open-reminders');
    assert(openReminders.reminderDueAt === reminderDueAt, 'not the same function');
  });

  // ---- toRangeDays equals shapeEventsForDay ----

  // Israel, Monday 12 to Sunday 18 October 2026 (the window ends before the 19th).
  await parity(
    'overnight, sleepover, multi-day all-day, New York all-day, zero-length at 00:00 and 23:59 (Israel)',
    [
      famcal('tail', 'Night shift', utc('2026-10-11 20:00', IL), utc('2026-10-12 08:00', IL)),
      famcal('short-tail', 'Late party', utc('2026-10-11 22:00', IL), utc('2026-10-12 05:00', IL)),
      famcal('party', 'Party at Dana', utc('2026-10-12 22:00', IL), utc('2026-10-13 02:00', IL)),
      google('sleepover', 'Maya sleepover', '2026-10-13T18:00:00+03:00', '2026-10-14T10:00:00+03:00'),
      famcal('trip', 'Eilat', '2026-10-14', '2026-10-17'),
      famcal('ny-allday', 'Grandma in town', '2026-10-15', '2026-10-16', { tz: NY }),
      reminder('r-0000', 'Midnight pill', utc('2026-10-16 00:00', IL)),
      reminder('r-2359', 'Lock the door', utc('2026-10-16 23:59', IL)),
      google('conf', 'Conference', '2026-10-17T09:00:00+03:00', '2026-10-19T17:00:00+03:00'),
      google('before', 'Last week', '2026-10-05T09:00:00+03:00', '2026-10-05T10:00:00+03:00'),
      google('after', 'Next week', '2026-10-20T09:00:00+03:00', '2026-10-20T10:00:00+03:00'),
    ],
    '2026-10-12',
    '2026-10-19',
    IL,
    {
      '2026-10-12': ['tail:continues', 'party:endsLater'],
      '2026-10-13': ['sleepover:endsLater'],
      '2026-10-14': ['trip:endsLater', 'sleepover:continues'],
      '2026-10-15': ['trip:spansDay', 'ny-allday:-'],
      '2026-10-16': ['trip:continues', 'r-0000:-', 'r-2359:-'],
      '2026-10-17': ['conf:endsLater'],
      '2026-10-18': ['conf:spansDay'],
    }
  );

  // Israel leaves summer time on Sunday 25 October 2026 at 02:00 (back to 01:00): a 25-hour day.
  await parity(
    'IL DST end 2026-10-25',
    [
      famcal('dst-night', 'Motzei Shabbat', '2026-10-24T20:00:00.000Z', '2026-10-25T01:00:00.000Z'),
      google('dst-day', 'Whole day', '2026-10-25T00:00:00+03:00', '2026-10-26T00:00:00+02:00'),
      google('dst-twice', 'The hour that happens twice', '2026-10-25T01:30:00+03:00', '2026-10-25T01:30:00+02:00'),
      reminder('dst-late', 'Bins out', utc('2026-10-25 23:30', IL)),
      famcal('dst-sleep', 'Sleepover', utc('2026-10-25 20:00', IL), utc('2026-10-26 09:00', IL)),
    ],
    '2026-10-24',
    '2026-10-27',
    IL,
    {
      '2026-10-24': ['dst-night:endsLater'],
      '2026-10-25': ['dst-day:-', 'dst-twice:-', 'dst-sleep:endsLater', 'dst-late:-'],
      '2026-10-26': ['dst-sleep:continues'],
    }
  );

  // New York leaves daylight time on Sunday 1 November 2026 at 02:00 (back to 01:00).
  await parity(
    'US DST end 2026-11-01 (New York)',
    [
      google('halloween', 'Halloween party', '2026-10-31T22:00:00-04:00', '2026-11-01T01:30:00-05:00'),
      google('us-day', 'Whole day', '2026-11-01T00:00:00-04:00', '2026-11-02T00:00:00-05:00'),
      google('us-sleep', 'Sleepover', '2026-11-01T20:00:00-05:00', '2026-11-02T09:00:00-05:00'),
      famcal('us-allday', 'Marathon', '2026-11-01', '2026-11-02', { tz: NY }),
      reminder('us-0000', 'Change the clocks', utc('2026-11-01 00:00', NY), { tz: NY }),
    ],
    '2026-10-31',
    '2026-11-03',
    NY,
    {
      '2026-10-31': ['halloween:endsLater'],
      '2026-11-01': ['us-allday:-', 'us-0000:-', 'us-day:-', 'us-sleep:endsLater'],
      '2026-11-02': ['us-sleep:continues'],
    }
  );

  // Chile starts summer time at midnight: 00:00 on Sunday 6 September 2026 doesn't exist,
  // the day starts at 01:00. It ends at midnight too: 23:00-24:00 on Saturday 4 April
  // 2026 happens twice.
  await parity(
    'Chile midnight DST start 2026-09-06',
    [
      reminder('scl-last', 'Last minute of Saturday', '2026-09-06T03:59:00.000Z', { tz: SCL }),
      reminder('scl-first', 'First minute of Sunday', '2026-09-06T04:00:00.000Z', { tz: SCL }),
      google('scl-night', 'Asado', '2026-09-05T22:00:00-04:00', '2026-09-06T02:00:00-03:00'),
      google('scl-day', 'Whole day', '2026-09-06T01:00:00-03:00', '2026-09-07T00:00:00-03:00'),
      famcal('scl-allday', 'Fiestas', '2026-09-06', '2026-09-08', { tz: SCL }),
    ],
    '2026-09-05',
    '2026-09-08',
    SCL,
    {
      '2026-09-05': ['scl-night:endsLater', 'scl-last:-'],
      '2026-09-06': ['scl-allday:endsLater', 'scl-first:-', 'scl-day:-'],
      '2026-09-07': ['scl-allday:continues'],
    }
  );

  await parity(
    'Chile midnight DST end 2026-04-05',
    [
      google('scl-twice', 'The hour that happens twice', '2026-04-04T23:30:00-03:00', '2026-04-04T23:30:00-04:00'),
      reminder('scl-0000', 'Sunday midnight', '2026-04-05T04:00:00.000Z', { tz: SCL }),
      famcal('scl-over', 'Overnight shift', utc('2026-04-04 22:00', SCL), utc('2026-04-05 07:00', SCL), { tz: SCL }),
    ],
    '2026-04-04',
    '2026-04-06',
    SCL,
    {
      '2026-04-04': ['scl-over:endsLater', 'scl-twice:-'],
      '2026-04-05': ['scl-over:continues', 'scl-0000:-'],
    }
  );

  await check('toRangeDays: every day comes back, empty ones too, and a start-less item is dropped', () => {
    const noStart = famcal('no-start', 'Broken', '', '');
    const days = toRangeDays([noStart], '2026-10-16', '2026-10-19', IL, NOW, TODAY);
    assertList(days.map(d => `${d.date}:${d.items.length}`), ['2026-10-16:0', '2026-10-17:0', '2026-10-18:0']);
    assert(toRangeDays([], '2026-10-16', '2026-10-16', IL, NOW, TODAY).length === 0, 'an empty window has days');
  });

  // ---- Open, done and snoozed ----

  const stateRow = (doneAt: string | null, snoozedUntil: string | null) => ({
    doneAt: doneAt ? new Date(doneAt) : null,
    snoozedUntil: snoozedUntil ? new Date(snoozedUntil) : null,
  });
  const openItems = [
    reminder('r-yesterday', 'Yesterday', utc('2026-10-15 08:00', IL), { state: stateRow(null, null) }),
    reminder('r-past', 'Past due', utc('2026-10-16 08:00', IL), { state: stateRow(null, null) }),
    reminder('r-future', 'Later today', utc('2026-10-16 12:00', IL)),
    reminder('r-done', 'Done', utc('2026-10-16 07:00', IL), {
      state: stateRow('2026-10-16T04:10:00.000Z', null),
      reminder: { ownerIsViewer: true, creatorIsViewer: true, done: true },
    }),
    reminder('r-snoozed', 'Snoozed', utc('2026-10-16 06:00', IL), {
      state: stateRow(null, '2026-10-16T09:00:00.000Z'),
      reminder: { ownerIsViewer: true, creatorIsViewer: true, snoozed: true },
    }),
    reminder('r-snooze-over', 'Snooze ran out', utc('2026-10-16 05:00', IL), { state: stateRow(null, '2026-10-16T06:00:00.000Z') }),
    reminder('r-dateonly', 'Call the bank', '2026-10-16'),
    reminder('r-tomorrow', 'Tomorrow', utc('2026-10-17 08:00', IL)),
    famcal('e-past', 'Breakfast', utc('2026-10-16 07:00', IL), utc('2026-10-16 08:00', IL)),
  ];
  const openDays = toRangeDays(openItems, '2026-10-15', '2026-10-18', IL, NOW, TODAY);
  const find = (id: string): ItemDTO => {
    for (const day of openDays) for (const item of day.items) if (item.id === id) return item;
    throw new Error(`${id} not listed`);
  };

  await check('open: only today\'s past-due reminders are open; earlier today\'s future one, yesterday\'s and tomorrow\'s are not', () => {
    const opens = openDays.flatMap(d => d.items.filter(i => i.reminder?.open).map(i => `${d.date}:${i.id}`));
    assertList(opens, ['r-dateonly', 'r-snooze-over', 'r-snoozed', 'r-past'].map(id => `2026-10-16:${id}`));
    assert(find('r-yesterday').reminder?.open === false, 'yesterday is open');
    assert(find('r-future').reminder?.open === false, 'later today is open');
    assert(find('r-tomorrow').reminder?.open === false, 'tomorrow is open');
  });

  await check("dueAt: every reminder DTO carries when it is due for the viewer: its time, or their reminder time on a date-only one", () => {
    assert(find('r-past').reminder?.dueAt === utc('2026-10-16 08:00', IL), `timed ${find('r-past').reminder?.dueAt}`);
    assert(find('r-dateonly').reminder?.dueAt === '2026-10-16T06:00:00.000Z', `default ${find('r-dateonly').reminder?.dueAt}`);
    const own = toRangeDays(openItems, '2026-10-16', '2026-10-17', IL, NOW, TODAY, '18:00');
    const item = own[0].items.find(i => i.id === 'r-dateonly');
    assert(item?.reminder?.dueAt === '2026-10-16T15:00:00.000Z', `18:00 ${item?.reminder?.dueAt}`);
    const carried = toCarryOverDto(openItems.find(i => i.key === 'famcal|r-dateonly')!, IL, NOW, '07:30');
    assert(carried.reminder?.dueAt === '2026-10-16T04:30:00.000Z', `carry-over ${carried.reminder?.dueAt}`);
  });

  await check('open: a date-only reminder opens at 09:00 in the viewer\'s timezone', () => {
    const item = openItems.find(i => i.key === 'famcal|r-dateonly');
    assert(item !== undefined, 'fixture');
    assert(isOpenOnDay(item, TODAY, TODAY, IL, fromZonedTime('2026-10-16 08:59:00', IL)) === false, 'open at 08:59');
    assert(isOpenOnDay(item, TODAY, TODAY, IL, fromZonedTime('2026-10-16 09:01:00', IL)) === true, 'not open at 09:01');
  });

  await check('done: a done reminder is kept, with doneAt, and is not open', () => {
    const done = find('r-done');
    assert(done.reminder?.done === true, 'not done');
    assert(done.reminder?.doneAt === '2026-10-16T04:10:00.000Z', `doneAt ${done.reminder?.doneAt}`);
    assert(done.reminder?.open === false, 'open');
  });

  await check('snoozed: still open, with snoozedUntil; a snooze that ran out sends no snoozedUntil', () => {
    const snoozed = find('r-snoozed');
    assert(snoozed.reminder?.open === true, 'snoozed is not open');
    assert(snoozed.reminder?.snoozedUntil === '2026-10-16T09:00:00.000Z', `snoozedUntil ${snoozed.reminder?.snoozedUntil}`);
    const over = find('r-snooze-over');
    assert(over.reminder?.open === true && over.reminder.snoozedUntil === null, JSON.stringify(over.reminder));
  });

  await check('events carry no reminder block; days never set openSince', () => {
    assert(find('e-past').reminder === undefined, 'an event has a reminder block');
    assert(openDays.every(d => d.items.every(i => !i.reminder || i.reminder.openSince === null)), 'openSince on a day item');
  });

  // ---- Carry-overs ----

  await check('carry-over: open with openSince, snoozed ones too, the occurrence as originalStart, no span', () => {
    const daily = reminder('ser-daily#2026-10-12T05:00:00.000Z', 'Vitamins', '2026-10-12T05:00:00.000Z', {
      rrule: 'FREQ=DAILY',
      originalStart: '2026-10-12T05:00:00.000Z',
      state: stateRow(null, '2026-10-16T09:00:00.000Z'),
      reminder: { ownerIsViewer: true, creatorIsViewer: true, snoozed: true, openSince: '2026-10-12' },
    });
    const dto = toCarryOverDto(daily, IL, NOW);
    assert(dto.reminder?.open === true, 'not open');
    assert(dto.reminder?.openSince === '2026-10-12', `openSince ${dto.reminder?.openSince}`);
    assert(dto.reminder?.snoozedUntil === '2026-10-16T09:00:00.000Z', 'snooze lost');
    assert(dto.originalStart === '2026-10-12T05:00:00.000Z', `originalStart ${dto.originalStart}`);
    assert(dto.span === null, `span ${dto.span}`);
    assert(dto.id === 'ser-daily#2026-10-12T05:00:00.000Z' && dto.seriesId === 'ser-daily', `${dto.id} ${dto.seriesId}`);
    assert(dto.recurring === true && dto.repeatsDaily === true, 'series facts');
  });

  await check('carry-over: a one-off keeps the occurrence it was given, and openSince falls back to its local due day', () => {
    // 00:30 on the 14th in Israel is still the 13th in UTC.
    const oneOff = reminder('one-off', 'Return the drill', '2026-10-13T21:30:00.000Z', { originalStart: '2026-10-13T21:30:00.000Z' });
    const dto = toCarryOverDto(oneOff, IL, NOW);
    assert(dto.originalStart === '2026-10-13T21:30:00.000Z', `originalStart ${dto.originalStart}`);
    assert(dto.reminder?.open === true && dto.reminder.openSince === '2026-10-14', JSON.stringify(dto.reminder));
    assert(dto.recurring === false && dto.repeatsDaily === false, 'one-off series facts');
  });

  // ---- Field sources ----

  await check('repeatsDaily: a daily reminder only', () => {
    const at = utc('2026-10-16 08:00', IL);
    const cases: Array<[ReadItem, boolean]> = [
      [reminder('a', 'a', at, { rrule: 'FREQ=DAILY' }), true],
      [reminder('b', 'b', at, { rrule: 'FREQ=DAILY;INTERVAL=2' }), true],
      [reminder('c', 'c', at, { rrule: 'FREQ=WEEKLY;BYDAY=MO' }), false],
      [reminder('d', 'd', at), false],
      [famcal('e', 'e', at, utc('2026-10-16 09:00', IL), { rrule: 'FREQ=DAILY' }), false],
    ];
    for (const [item, want] of cases) {
      const dto = toItemDto(item, null, { now: NOW, open: false, openSince: null });
      assert(dto.repeatsDaily === want, `${item.key} ${item.rrule}: ${dto.repeatsDaily}`);
    }
  });

  await check('repeatsEveryDay: FREQ=DAILY with no interval or INTERVAL=1, of an event or a reminder; never INTERVAL=2, other frequencies or a one-off', () => {
    const at = utc('2026-10-16 08:00', IL);
    const end = utc('2026-10-16 09:00', IL);
    const cases: Array<[ReadItem, boolean]> = [
      [famcal('e1', 'e', at, end, { rrule: 'FREQ=DAILY' }), true],
      [famcal('e2', 'e', at, end, { rrule: 'RRULE:FREQ=DAILY;INTERVAL=1;UNTIL=20261231T000000Z' }), true],
      [famcal('e3', 'e', at, end, { rrule: 'FREQ=DAILY;COUNT=5;INTERVAL=1' }), true],
      [famcal('e4', 'e', at, end, { rrule: 'FREQ=DAILY;INTERVAL=2' }), false],
      [famcal('e4b', 'e', at, end, { rrule: 'RRULE:INTERVAL=2;FREQ=DAILY' }), false],
      [famcal('e4c', 'e', at, end, { rrule: 'RRULE:INTERVAL=1;FREQ=DAILY' }), true],
      [famcal('e5', 'e', at, end, { rrule: 'FREQ=WEEKLY;BYDAY=MO' }), false],
      [famcal('e6', 'e', at, end, { rrule: 'FREQ=YEARLY;BYMONTH=10' }), false],
      [famcal('e7', 'e', at, end), false],
      [reminder('r1', 'r', at, { rrule: 'FREQ=DAILY' }), true],
      [reminder('r2', 'r', at, { rrule: 'FREQ=DAILY;INTERVAL=2' }), false],
      [google('g1', 'g', '2026-10-16T08:00:00+03:00', '2026-10-16T09:00:00+03:00'), false],
    ];
    for (const [item, want] of cases) {
      const dto = toItemDto(item, null, { now: NOW, open: false, openSince: null });
      assert(dto.repeatsEveryDay === want, `${item.key} ${item.rrule}: ${dto.repeatsEveryDay}`);
    }
  });

  await check('canEdit: FamCal by the calendar\'s write access or the reminder\'s creator; Google by the calendar\'s role and the event; unknown reads as false', () => {
    const at = utc('2026-10-16 08:00', IL);
    const end = utc('2026-10-16 09:00', IL);
    const writable: CalendarRef = { ...OWN_CAL, canWrite: true };
    const viewOnly: CalendarRef = { ...NOA_SHARED, canWrite: false };
    const edit = (item: ReadItem) => toItemDto(item, null, { now: NOW, open: false, openSince: null }).canEdit;
    assert(edit(famcal('a', 'a', at, end, { calendar: writable })) === true, 'own calendar');
    assert(edit(famcal('b', 'b', at, end, { calendar: viewOnly })) === false, 'a calendar shared to view');
    assert(edit(famcal('c', 'c', at, end)) === false, 'no write info (not known) is read only');
    assert(edit(famcal('d', 'd', at, end, { kind: 'reminder', calendar: viewOnly, reminder: { ownerIsViewer: true, creatorIsViewer: true } })) === true, 'a reminder the viewer created, on a calendar they cannot write');
    assert(edit(famcal('e', 'e', at, end, { kind: 'reminder', calendar: writable, reminder: { ownerIsViewer: true, creatorIsViewer: false } })) === true, 'a reminder the partner created, on a calendar the viewer may write');
    assert(edit(famcal('f', 'f', at, end, { kind: 'reminder', calendar: MASKED, reminder: { ownerIsViewer: true, creatorIsViewer: false } })) === false, 'a partner\'s reminder on their private calendar');
    const g = (calendar: CalendarRef, editable: boolean | undefined) => {
      const item = google('g', 'g', '2026-10-16T08:00:00+03:00', '2026-10-16T09:00:00+03:00');
      return edit({ ...item, calendar, google: { birthday: false, htmlLink: null, ...(editable === undefined ? {} : { editable }) } });
    };
    assert(g({ ...GOOGLE_CAL, canWrite: true }, true) === true, 'a writable calendar and an event the home may change');
    assert(g({ ...GOOGLE_CAL, canWrite: true }, false) === false, 'an event with guests or of another type');
    assert(g({ ...GOOGLE_CAL, canWrite: false }, true) === false, 'a read-only calendar');
    assert(g(GOOGLE_CAL, true) === false, 'a calendar whose role is not known');
    assert(g({ ...GOOGLE_CAL, canWrite: true }, undefined) === false, 'an entry cached before the event was marked');
    const dto = toItemDto(famcal('h', 'h', at, end, { calendar: writable }), null, { now: NOW, open: false, openSince: null });
    assert(!('canWrite' in dto.calendar), 'the calendar ref\'s canWrite stays out of the JSON');
  });

  await check('readOnly, tz, id, allDay, location and description come from the read', () => {
    const fam = toItemDto(
      famcal('ser1#2026-10-16T05:00:00.000Z', 'Swim', '2026-10-16T05:00:00.000Z', '2026-10-16T06:00:00.000Z', {
        tz: NY,
        rrule: 'FREQ=WEEKLY',
        location: 'Pool',
        description: '',
      }),
      'endsLater',
      { now: NOW, open: false, openSince: null }
    );
    assert(fam.readOnly === false && fam.source === 'famcal', 'famcal readOnly');
    assert(fam.tz === NY, `famcal tz ${fam.tz}`);
    assert(fam.id === 'ser1#2026-10-16T05:00:00.000Z' && fam.seriesId === 'ser1', `famcal id ${fam.id}`);
    assert(fam.allDay === false && fam.span === 'endsLater' && fam.recurring === true, 'famcal shape');
    assert(fam.location === 'Pool' && fam.description === null, `location ${fam.location}, description ${JSON.stringify(fam.description)}`);
    assert(!('birthday' in fam) && !('htmlLink' in fam), 'famcal carries Google fields');

    const goo = toItemDto(google('g1', null, '2026-10-16', '2026-10-17', { birthday: true, htmlLink: 'https://calendar.google.com/x' }), null, {
      now: NOW,
      open: false,
      openSince: null,
    });
    assert(goo.readOnly === true && goo.source === 'google', 'google readOnly');
    assert(goo.tz === null, `google tz ${goo.tz}`);
    assert(goo.id === 'g1' && goo.key === 'google|family@group.calendar.google.com|g1', `google id ${goo.id} ${goo.key}`);
    assert(goo.allDay === true && goo.title === null, 'google all-day, raw null title');
    assert(goo.birthday === true && goo.htmlLink === 'https://calendar.google.com/x', 'google fields');
    assert(goo.reminder === undefined, 'google reminder block');
  });

  await check('reminder: whose it is and who set it pass through', () => {
    const dto = toItemDto(
      reminder('nr', 'Buy flowers', utc('2026-10-16 12:00', IL), {
        calendar: NOA_SHARED,
        reminder: { ownerIsViewer: false, creatorIsViewer: false, ownerName: 'Noa', creatorName: 'Noa' },
      }),
      null,
      { now: NOW, open: false, openSince: null }
    );
    assert(dto.reminder?.ownerIsViewer === false && dto.reminder.creatorIsViewer === false, 'flags');
    assert(dto.reminder?.ownerName === 'Noa' && dto.reminder.creatorName === 'Noa', 'names');
    assert(JSON.stringify(dto.calendar) === JSON.stringify({ id: 'native:cal-noa', name: 'Noa family', color: '#E67C73', mine: false, ownerName: 'Noa', inLegend: true }), JSON.stringify(dto.calendar));
  });

  // ---- Privacy ----

  await check('masked: a partner-private reminder-for-me never shows the calendar\'s real name or id, on a day or as a carry-over', () => {
    const secret = reminder('noa-private', 'Pick up the cake', utc('2026-10-16 08:00', IL), {
      calendar: MASKED,
      calendarName: 'Noa therapy',
      calendarId: 'native:cal-noa-private',
      reminder: { ownerIsViewer: true, creatorIsViewer: false, creatorName: 'Noa' },
    });
    const days = toRangeDays([secret], '2026-10-16', '2026-10-17', IL, NOW, TODAY);
    const carry = toCarryOverDto(secret, IL, NOW);
    for (const json of [JSON.stringify(days), JSON.stringify(carry)]) {
      assert(!json.includes('therapy'), 'the real name leaked');
      assert(!json.includes('cal-noa-private'), 'the real id leaked');
    }
    const want = JSON.stringify({ id: null, name: 'Noa', color: null, mine: false, inLegend: false });
    assert(JSON.stringify(days[0].items[0].calendar) === want, JSON.stringify(days[0].items[0].calendar));
    assert(JSON.stringify(carry.calendar) === want, JSON.stringify(carry.calendar));
  });

  await check('masked: a calendar outside the legend never sends its id, whatever the ref says', () => {
    const leaky: CalendarRef = { ...NOA_SHARED, id: 'native:cal-noa-private', inLegend: false };
    const dto = toItemDto(famcal('x', 'x', utc('2026-10-16 08:00', IL), utc('2026-10-16 09:00', IL), { calendar: leaky }), null, {
      now: NOW,
      open: false,
      openSince: null,
    });
    assert(dto.calendar.id === null, `id ${dto.calendar.id}`);
  });

  // ---- Legend ----

  await check('toCalendarDto: legend fields, ownerName and unavailable only when set, a masked ref throws', () => {
    assert(
      JSON.stringify(toCalendarDto(OWN_CAL)) === JSON.stringify({ id: 'native:cal-own', source: 'famcal', name: 'Raziel', color: '#039BE5', mine: true }),
      JSON.stringify(toCalendarDto(OWN_CAL))
    );
    const spouse: CalendarRef = { id: 'dana@gmail.com', source: 'google', name: 'Dana', color: null, mine: false, ownerName: 'Dana', inLegend: true, unavailable: true };
    assert(
      JSON.stringify(toCalendarDto(spouse)) ===
        JSON.stringify({ id: 'dana@gmail.com', source: 'google', name: 'Dana', color: null, mine: false, ownerName: 'Dana', unavailable: true }),
      JSON.stringify(toCalendarDto(spouse))
    );
    assert(!('unavailable' in toCalendarDto({ ...spouse, unavailable: false })), 'unavailable: false sent');
    let threw = false;
    try {
      toCalendarDto(MASKED);
    } catch {
      threw = true;
    }
    assert(threw, 'a masked ref became a legend entry');
  });

  // ---- compareItems ----

  await check('compareItems: all-day first, then start instant, end, FamCal before Google, title, key', () => {
    const dto = (item: ReadItem) => toItemDto(item, null, { now: NOW, open: false, openSince: null });
    const items = [
      dto(google('g-late', 'B', '2026-10-16T12:00:00+03:00', '2026-10-16T13:00:00+03:00')),
      dto(famcal('f-same-b', 'B', utc('2026-10-16 09:00', IL), utc('2026-10-16 10:00', IL))),
      dto(google('g-same', 'A', '2026-10-16T09:00:00+03:00', '2026-10-16T10:00:00+03:00')),
      dto(famcal('f-same-a', 'A', utc('2026-10-16 09:00', IL), utc('2026-10-16 10:00', IL))),
      dto(famcal('f-short', 'Z', utc('2026-10-16 09:00', IL), utc('2026-10-16 09:30', IL))),
      // 06:30 UTC is 09:30 in Israel: later than 09:00+03:00 even though it reads earlier.
      dto(famcal('f-utc', 'A', '2026-10-16T06:30:00.000Z', '2026-10-16T07:00:00.000Z')),
      dto(famcal('f-allday', 'Z', '2026-10-16', '2026-10-17')),
      dto(google('g-allday-earlier', 'Z', '2026-10-14', '2026-10-18')),
      dto(famcal('f-midnight', 'A', utc('2026-10-16 00:00', IL), utc('2026-10-16 00:00', IL))),
    ];
    const sorted = [...items].sort(compareItems).map(i => i.id);
    assertList(sorted, ['g-allday-earlier', 'f-allday', 'f-midnight', 'f-short', 'f-same-a', 'f-same-b', 'g-same', 'f-utc', 'g-late']);
    for (const a of items) {
      for (const b of items) {
        const ab = Math.sign(compareItems(a, b));
        const ba = Math.sign(compareItems(b, a));
        assert(ab === -ba, `not antisymmetric: ${a.id} ${b.id}`);
        assert((ab === 0) === (a.key === b.key), `ties without the same key: ${a.id} ${b.id}`);
      }
    }
    const twin = { ...items[3], key: 'famcal|f-same-a-2', id: 'f-same-a-2' };
    assert(compareItems(items[3], twin) < 0, 'the key does not break the last tie');
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

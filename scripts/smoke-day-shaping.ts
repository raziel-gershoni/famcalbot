// Smoke test for src/utils/day-events.ts and the event lines the summary prompt gets.
// An event from 22:00 to 02:00 used to show on both days, and on the second day its
// bare "22:00 - 02:00" read as that evening. No network.
//
// Run under both clocks; the output must not depend on the server's timezone:
//   TZ=UTC npx tsx scripts/smoke-day-shaping.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-day-shaping.ts

import { formatEventForPrompt } from '../src/utils/event-formatter';
import { localDate, OVERNIGHT_CUTOFF_HOUR, shapeEventsForDay } from '../src/utils/day-events';
import { toUnifiedEvent } from '../src/services/calendar-provider/native-provider';
import type { CalendarEvent } from '../src/types';

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

function check(name: string, fn: () => void) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
}

function assert(cond: boolean, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

const TZ = 'Asia/Jerusalem';
const ev = (summary: string, start: string, end: string, extra: Partial<CalendarEvent> = {}): CalendarEvent =>
  ({ summary, start, end, calendarName: 'Family', calendarId: 'c1', ...extra });

/** The one event as `day` sees it: undefined when dropped, else its prompt line. */
function onDay(event: CalendarEvent, day: string, tz = TZ): string | undefined {
  const [shaped] = shapeEventsForDay([event], day, tz);
  return shaped ? formatEventForPrompt(shaped, 0, tz, day) : undefined;
}

// The reported case: Monday 22:00 to Tuesday 02:00.
const party = ev('Party at Dana', '2026-10-12T22:00:00+03:00', '2026-10-13T02:00:00+03:00');

check('overnight party: Monday shows it ending the next day', () => {
  const line = onDay(party, '2026-10-12');
  assert(line === '1. Party at Dana (22:00 - 02:00 next day) [Calendar: Family]', `got ${line}`);
});

check('overnight party: Tuesday drops it (it belongs to last night)', () => {
  assert(onDay(party, '2026-10-13') === undefined, 'kept on Tuesday');
});

check(`cutoff: a carried-over tail ending exactly at 0${OVERNIGHT_CUTOFF_HOUR}:00 is dropped, one ending later is kept`, () => {
  assert(onDay(ev('Shift', '2026-10-12T22:00:00+03:00', '2026-10-13T06:00:00+03:00'), '2026-10-13') === undefined, '06:00 kept');
  const line = onDay(ev('Shift', '2026-10-12T22:00:00+03:00', '2026-10-13T06:01:00+03:00'), '2026-10-13');
  assert(line === '1. Shift (until 06:01 (started yesterday 22:00)) [Calendar: Family]', `got ${line}`);
});

check('kids sleepover until 10:00: Monday marks the next-day end, Tuesday keeps the pickup', () => {
  const sleepover = ev('Maya sleepover', '2026-10-12T18:00:00+03:00', '2026-10-13T10:00:00+03:00');
  assert(onDay(sleepover, '2026-10-12') === '1. Maya sleepover (18:00 - 10:00 next day) [Calendar: Family]', `Mon ${onDay(sleepover, '2026-10-12')}`);
  assert(onDay(sleepover, '2026-10-13') === '1. Maya sleepover (until 10:00 (started yesterday 18:00)) [Calendar: Family]', `Tue ${onDay(sleepover, '2026-10-13')}`);
});

check('multi-day timed event: first day, middle day, last day, then gone', () => {
  const conference = ev('Conference', '2026-10-12T09:00:00+03:00', '2026-10-14T17:00:00+03:00');
  assert(onDay(conference, '2026-10-12') === '1. Conference (from 09:00 until Wed 17:00) [Calendar: Family]', `Mon ${onDay(conference, '2026-10-12')}`);
  assert(onDay(conference, '2026-10-13') === '1. Conference (all day (Mon 09:00 - Wed 17:00)) [Calendar: Family]', `Tue ${onDay(conference, '2026-10-13')}`);
  assert(onDay(conference, '2026-10-14') === '1. Conference (until 17:00 (started Mon 09:00)) [Calendar: Family]', `Wed ${onDay(conference, '2026-10-14')}`);
  assert(onDay(conference, '2026-10-15') === undefined, 'kept on Thursday');
});

check('an event ending exactly at midnight stays on its day only, without a next-day mark', () => {
  const dinner = ev('Dinner', '2026-10-12T20:00:00+03:00', '2026-10-13T00:00:00+03:00');
  assert(onDay(dinner, '2026-10-12') === '1. Dinner (20:00 - 00:00) [Calendar: Family]', `Mon ${onDay(dinner, '2026-10-12')}`);
  assert(onDay(dinner, '2026-10-13') === undefined, 'kept on Tuesday');
});

check('an event starting exactly at midnight belongs to that day', () => {
  const flight = ev('Flight', '2026-10-13T00:00:00+03:00', '2026-10-13T03:00:00+03:00');
  assert(onDay(flight, '2026-10-13') === '1. Flight (00:00 - 03:00) [Calendar: Family]', `got ${onDay(flight, '2026-10-13')}`);
  assert(onDay(flight, '2026-10-12') === undefined, 'kept the day before');
});

check('single-day all-day event: its day only (Google end dates are exclusive)', () => {
  const holiday = ev('Holiday', '2026-10-12', '2026-10-13');
  assert(onDay(holiday, '2026-10-12') === '1. Holiday (All day) [Calendar: Family]', `Mon ${onDay(holiday, '2026-10-12')}`);
  assert(onDay(holiday, '2026-10-13') === undefined, 'kept on Tuesday');
});

check('multi-day all-day event: each day it covers, marked, and not the day after', () => {
  const vacation = ev('Vacation', '2026-10-12', '2026-10-15');
  assert(onDay(vacation, '2026-10-12') === '1. Vacation (All day, through Wed) [Calendar: Family]', `Mon ${onDay(vacation, '2026-10-12')}`);
  assert(onDay(vacation, '2026-10-13') === '1. Vacation (All day (began Mon, through Wed)) [Calendar: Family]', `Tue ${onDay(vacation, '2026-10-13')}`);
  assert(onDay(vacation, '2026-10-14') === '1. Vacation (All day (last day; began Mon)) [Calendar: Family]', `Wed ${onDay(vacation, '2026-10-14')}`);
  assert(onDay(vacation, '2026-10-15') === undefined, 'kept on Thursday');
});

check('birthdays keep their plain line', () => {
  const birthday = ev("Rachel's birthday", '2026-10-12', '2026-10-13', { eventType: 'birthday' });
  assert(onDay(birthday, '2026-10-12') === "1. Rachel's birthday (Birthday) [Calendar: Family]", `got ${onDay(birthday, '2026-10-12')}`);
});

check('a normal event inside the day is unchanged and unmarked', () => {
  const [shaped] = shapeEventsForDay([ev('Dentist', '2026-10-12T11:00:00+03:00', '2026-10-12T12:00:00+03:00')], '2026-10-12', TZ);
  assert(shaped.daySpan === undefined, `daySpan ${shaped.daySpan}`);
  assert(formatEventForPrompt(shaped, 0, TZ, '2026-10-12') === '1. Dentist (11:00 - 12:00) [Calendar: Family]', 'line');
});

check('daylight saving ends in Israel on 2026-10-25: last night\'s tail is still dropped', () => {
  const party25 = ev('Party', '2026-10-24T22:00:00+03:00', '2026-10-25T02:00:00+02:00');
  assert(onDay(party25, '2026-10-25') === undefined, 'kept on the 25-hour day');
  assert(onDay(party25, '2026-10-24') === '1. Party (22:00 - 02:00 next day) [Calendar: Family]', `Sat ${onDay(party25, '2026-10-24')}`);
});

check("another timezone: the split follows the user's day, not Israel's", () => {
  const ny = ev('Late show', '2026-10-12T22:00:00-04:00', '2026-10-13T01:30:00-04:00');
  assert(onDay(ny, '2026-10-12', 'America/New_York') === '1. Late show (22:00 - 01:30 next day) [Calendar: Family]', `Mon ${onDay(ny, '2026-10-12', 'America/New_York')}`);
  assert(onDay(ny, '2026-10-13', 'America/New_York') === undefined, 'kept on Tuesday');
});

check('the summary day is the date in the user\'s timezone', () => {
  // 21:30 UTC on Monday is already Tuesday 00:30 in Israel.
  assert(localDate(new Date('2026-10-12T21:30:00Z'), TZ) === '2026-10-13', 'Israel');
  assert(localDate(new Date('2026-10-12T21:30:00Z'), 'America/New_York') === '2026-10-12', 'New York');
});

check('events outside the day are dropped and the rest keep their order', () => {
  const day = shapeEventsForDay([
    party,
    ev('Breakfast', '2026-10-13T08:00:00+03:00', '2026-10-13T09:00:00+03:00'),
    ev('Last week', '2026-10-05T08:00:00+03:00', '2026-10-05T09:00:00+03:00'),
    ev('Meeting', '2026-10-13T10:00:00+03:00', '2026-10-13T11:00:00+03:00'),
  ], '2026-10-13', TZ);
  assert(day.map(e => e.summary).join(',') === 'Breakfast,Meeting', day.map(e => e.summary).join(','));
});

check('native all-day event: dated in its own timezone, so a UTC server keeps it on its day', () => {
  // Stored at Israel midnight: 2026-10-12 00:00 local is 2026-10-11 21:00 UTC.
  const unified = toUnifiedEvent({ id: 'cal1', name: 'Family' }, {
    title: 'Holiday', startsAt: new Date('2026-10-11T21:00:00Z'), endsAt: new Date('2026-10-12T21:00:00Z'),
    allDay: true, timeZone: TZ, seriesEventId: 'e1', instanceStartsAt: new Date('2026-10-11T21:00:00Z'), isRecurringInstance: false,
  });
  assert(unified.start === '2026-10-12' && unified.end === '2026-10-13', `dates ${unified.start}..${unified.end}`);
  assert(onDay(unified as CalendarEvent, '2026-10-12') === '1. Holiday (All day) [Calendar: Family]', `line ${onDay(unified as CalendarEvent, '2026-10-12')}`);
});

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
process.exit(failed ? 1 : 0);

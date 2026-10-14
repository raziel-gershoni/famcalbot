// Smoke test for src/utils/day-events.ts and the event lines the summary prompt gets.
// An event from 22:00 to 02:00 used to show on both days, and on the second day its
// bare "22:00 - 02:00" read as that evening. An event a week long or more named its
// ends by weekday alone, "Sat 15:00 - Sat 12:00". No network.
//
// Run under both clocks; the output must not depend on the server's timezone:
//   TZ=UTC npx tsx scripts/smoke-day-shaping.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-day-shaping.ts

import { formatEventForPrompt, isReminderEvent } from '../src/utils/event-formatter';
import { daySpanOf, localDate, OVERNIGHT_CUTOFF_HOUR, shapeEventsForDay } from '../src/utils/day-events';
import { toUnifiedEvent } from '../src/services/calendar-provider/native-provider';
import type { CalendarEvent, ReminderInfo } from '../src/types';

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

// A week apart, weekday names alone repeat: "all day (Sat 15:00 - Sat 12:00)".
check('week-long visit: both ends carry the day of the month', () => {
  const visit = ev('Grandma visiting', '2026-10-10T15:00:00+03:00', '2026-10-17T12:00:00+03:00');
  assert(onDay(visit, '2026-10-10') === '1. Grandma visiting (from 15:00 until Sat 17 12:00) [Calendar: Family]', `Sat ${onDay(visit, '2026-10-10')}`);
  assert(onDay(visit, '2026-10-13') === '1. Grandma visiting (all day (Sat 10 15:00 - Sat 17 12:00)) [Calendar: Family]', `Tue ${onDay(visit, '2026-10-13')}`);
  assert(onDay(visit, '2026-10-17') === '1. Grandma visiting (until 12:00 (started Sat 10 15:00)) [Calendar: Family]', `next Sat ${onDay(visit, '2026-10-17')}`);
  // The dates are the user's: 21:00 Saturday in New York is already Sunday in UTC.
  const nyVisit = ev('Grandma visiting', '2026-10-10T21:00:00-04:00', '2026-10-17T20:00:00-04:00');
  const ny = onDay(nyVisit, '2026-10-13', 'America/New_York');
  assert(ny === '1. Grandma visiting (all day (Sat 10 21:00 - Sat 17 20:00)) [Calendar: Family]', `New York ${ny}`);
});

check('a timed event whose ends are six days apart keeps weekday names alone', () => {
  const visit = ev('Visit', '2026-10-10T15:00:00+03:00', '2026-10-16T12:00:00+03:00');
  assert(onDay(visit, '2026-10-10') === '1. Visit (from 15:00 until Fri 12:00) [Calendar: Family]', `Sat ${onDay(visit, '2026-10-10')}`);
  assert(onDay(visit, '2026-10-13') === '1. Visit (all day (Sat 15:00 - Fri 12:00)) [Calendar: Family]', `Tue ${onDay(visit, '2026-10-13')}`);
  assert(onDay(visit, '2026-10-16') === '1. Visit (until 12:00 (started Sat 15:00)) [Calendar: Family]', `Fri ${onDay(visit, '2026-10-16')}`);
  // Ending at the next Saturday's midnight, the label names that Saturday, so it is dated.
  const toMidnight = ev('Visit', '2026-10-10T15:00:00+03:00', '2026-10-17T00:00:00+03:00');
  assert(onDay(toMidnight, '2026-10-10') === '1. Visit (from 15:00 until Sat 17 00:00) [Calendar: Family]', `midnight ${onDay(toMidnight, '2026-10-10')}`);
});

check('all-day events: dated from a week long, weekday names alone up to six days', () => {
  const camp = ev('Camp', '2026-10-10', '2026-10-18');
  assert(onDay(camp, '2026-10-10') === '1. Camp (All day, through Sat 17) [Calendar: Family]', `Sat ${onDay(camp, '2026-10-10')}`);
  assert(onDay(camp, '2026-10-13') === '1. Camp (All day (began Sat 10, through Sat 17)) [Calendar: Family]', `Tue ${onDay(camp, '2026-10-13')}`);
  assert(onDay(camp, '2026-10-17') === '1. Camp (All day (last day; began Sat 10)) [Calendar: Family]', `next Sat ${onDay(camp, '2026-10-17')}`);
  const shortCamp = ev('Camp', '2026-10-10', '2026-10-17');
  assert(onDay(shortCamp, '2026-10-10') === '1. Camp (All day, through Fri) [Calendar: Family]', `short Sat ${onDay(shortCamp, '2026-10-10')}`);
  assert(onDay(shortCamp, '2026-10-16') === '1. Camp (All day (last day; began Sat)) [Calendar: Family]', `short Fri ${onDay(shortCamp, '2026-10-16')}`);
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

// Native all-day events as the bot saves them: 00:00 to 23:59 local on the last day.
const nativeAllDay = (title: string, startsAt: string, endsAt: string) => toUnifiedEvent({ id: 'cal1', name: 'Family' }, {
  title, startsAt: new Date(startsAt), endsAt: new Date(endsAt), allDay: true, timeZone: TZ,
  seriesEventId: 'e1', instanceStartsAt: new Date(startsAt), isRecurringInstance: false,
}) as CalendarEvent;

check('native one-day all-day event saved 00:00-23:59 stays on its day', () => {
  // Saturday 2026-10-17 in Israel: 2026-10-16T21:00Z to 2026-10-17T20:59Z.
  const beach = nativeAllDay('Beach day', '2026-10-16T21:00:00Z', '2026-10-17T20:59:00Z');
  assert(beach.start === '2026-10-17' && beach.end === '2026-10-18', `dates ${beach.start}..${beach.end}`);
  assert(onDay(beach, '2026-10-17') === '1. Beach day (All day) [Calendar: Family]', `Sat ${onDay(beach, '2026-10-17')}`);
  assert(onDay(beach, '2026-10-18') === undefined, 'kept on Sunday');
});

check('native multi-day all-day event Mon 00:00 - Wed 23:59 runs through Wednesday', () => {
  const trip = nativeAllDay('Trip', '2026-10-18T21:00:00Z', '2026-10-21T20:59:00Z');
  assert(trip.start === '2026-10-19' && trip.end === '2026-10-22', `dates ${trip.start}..${trip.end}`);
  assert(onDay(trip, '2026-10-19') === '1. Trip (All day, through Wed) [Calendar: Family]', `Mon ${onDay(trip, '2026-10-19')}`);
  assert(onDay(trip, '2026-10-22') === undefined, 'kept on Thursday');
});

check('native recurring all-day occurrence on the 25-hour DST day keeps one day', () => {
  // 24 h from local midnight on 2026-10-25 ends at 23:00 the same day.
  const weekly = nativeAllDay('Cleaning day', '2026-10-24T21:00:00Z', '2026-10-25T21:00:00Z');
  assert(weekly.start === '2026-10-25' && weekly.end === '2026-10-26', `dates ${weekly.start}..${weekly.end}`);
  assert(onDay(weekly, '2026-10-25') === '1. Cleaning day (All day) [Calendar: Family]', `line ${onDay(weekly, '2026-10-25')}`);
});

check('an all-day event whose end does not advance counts as one day', () => {
  const odd = ev('Odd', '2026-10-12', '2026-10-12');
  assert(onDay(odd, '2026-10-12') === '1. Odd (All day) [Calendar: Family]', `got ${onDay(odd, '2026-10-12')}`);
});

check('where DST starts at midnight (Chile), the evening before keeps its last hour', () => {
  // America/Santiago skips 2026-09-06 00:00 -> 01:00.
  const late = ev('Late call', '2026-09-05T23:00:00-04:00', '2026-09-05T23:45:00-04:00');
  assert(onDay(late, '2026-09-05', 'America/Santiago') === '1. Late call (23:00 - 23:45) [Calendar: Family]', `Sat ${onDay(late, '2026-09-05', 'America/Santiago')}`);
  assert(onDay(late, '2026-09-06', 'America/Santiago') === undefined, 'kept on Sunday');
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

// Reminders are saved with no length. One at exactly 00:00 ended where its day began,
// so the overlap test put it on no day at all.
check('a zero-length item at 00:00 belongs to its own day, not the day before', () => {
  const pills = ev('Pills', '2026-10-13T00:00:00+03:00', '2026-10-13T00:00:00+03:00');
  assert(daySpanOf(pills, '2026-10-13', TZ) === undefined, `Tue ${daySpanOf(pills, '2026-10-13', TZ)}`);
  assert(daySpanOf(pills, '2026-10-12', TZ) === null, `Mon ${daySpanOf(pills, '2026-10-12', TZ)}`);
  assert(shapeEventsForDay([pills], '2026-10-13', TZ).length === 1, 'dropped from Tuesday');
  assert(shapeEventsForDay([pills], '2026-10-12', TZ).length === 0, 'kept on Monday');
  // The 25-hour DST day in Israel, and another timezone.
  const dst = ev('Pills', '2026-10-25T00:00:00+03:00', '2026-10-25T00:00:00+03:00');
  assert(daySpanOf(dst, '2026-10-25', TZ) === undefined && daySpanOf(dst, '2026-10-24', TZ) === null, 'DST day');
  const ny = ev('Pills', '2026-11-01T00:00:00-04:00', '2026-11-01T00:00:00-04:00');
  const nyDays = [daySpanOf(ny, '2026-10-31', 'America/New_York'), daySpanOf(ny, '2026-11-01', 'America/New_York')];
  assert(nyDays[0] === null && nyDays[1] === undefined, `New York ${nyDays.join(',')}`);
});

check('a zero-length item at 23:59 stays on its day', () => {
  const lock = ev('Lock the door', '2026-10-13T23:59:00+03:00', '2026-10-13T23:59:00+03:00');
  assert(daySpanOf(lock, '2026-10-13', TZ) === undefined, `Tue ${daySpanOf(lock, '2026-10-13', TZ)}`);
  assert(daySpanOf(lock, '2026-10-14', TZ) === null, `Wed ${daySpanOf(lock, '2026-10-14', TZ)}`);
});

check('a native zero-length occurrence at 00:00, as the store saves a reminder, is on its day', () => {
  // 2026-10-13 00:00 in Israel is 2026-10-12T21:00Z.
  const midnight = new Date('2026-10-12T21:00:00Z');
  const native = toUnifiedEvent({ id: 'cal1', name: 'Family' }, {
    title: 'Pills', startsAt: midnight, endsAt: midnight, allDay: false, timeZone: TZ,
    seriesEventId: 'e1', instanceStartsAt: midnight, isRecurringInstance: false,
  }) as CalendarEvent;
  assert(shapeEventsForDay([native], '2026-10-13', TZ).length === 1, 'dropped from Tuesday');
  assert(shapeEventsForDay([native], '2026-10-12', TZ).length === 0, 'kept on Monday');
});

check('events with a length keep their spans', () => {
  assert(daySpanOf(party, '2026-10-12', TZ) === 'endsLater', `party Mon ${daySpanOf(party, '2026-10-12', TZ)}`);
  assert(daySpanOf(party, '2026-10-13', TZ) === null, `party Tue ${daySpanOf(party, '2026-10-13', TZ)}`);
  const dinner = ev('Dinner', '2026-10-12T20:00:00+03:00', '2026-10-13T00:00:00+03:00');
  assert(daySpanOf(dinner, '2026-10-12', TZ) === undefined && daySpanOf(dinner, '2026-10-13', TZ) === null, 'dinner until midnight');
  const flight = ev('Flight', '2026-10-13T00:00:00+03:00', '2026-10-13T03:00:00+03:00');
  assert(daySpanOf(flight, '2026-10-13', TZ) === undefined && daySpanOf(flight, '2026-10-12', TZ) === null, 'flight from midnight');
});

// Built-in calendar reminders: one moment, never "10:00 - 10:00". The owner/creator
// flags are the viewer's side of it, as the native provider sets them.
{
  const ownReminder: ReminderInfo = { ownerIsViewer: true, creatorIsViewer: true };
  const reminderEv = (summary: string, start: string, end = start, reminder: ReminderInfo = ownReminder) =>
    ev(summary, start, end, { eventType: 'reminder', reminder });

  check('reminder: a timed one reads "Reminder 10:00", never a range', () => {
    const line = onDay(reminderEv('Call the plumber', '2026-10-13T07:00:00.000Z'), '2026-10-13');
    assert(line === '1. Call the plumber (Reminder 10:00) [Calendar: Family]', `got ${line}`);
    assert(isReminderEvent(reminderEv('x', '2026-10-13T07:00:00.000Z')) && !isReminderEvent(party), 'isReminderEvent');
  });

  check('reminder: a date-only one (zero length, as the store saves it) is "Reminder (all day)" on its day only', () => {
    // 2026-10-13 00:00 in Israel is 2026-10-12T21:00Z; start = end.
    const milk = { ...nativeAllDay('Buy milk', '2026-10-12T21:00:00Z', '2026-10-12T21:00:00Z'), eventType: 'reminder', reminder: ownReminder };
    assert(milk.start === '2026-10-13' && milk.end === '2026-10-14', `dates ${milk.start}..${milk.end}`);
    assert(onDay(milk, '2026-10-13') === '1. Buy milk (Reminder (all day)) [Calendar: Family]', `Tue ${onDay(milk, '2026-10-13')}`);
    assert(onDay(milk, '2026-10-12') === undefined && onDay(milk, '2026-10-14') === undefined, 'kept on another day');
  });

  check('reminder: at exactly 00:00 it is that day\'s "Reminder 00:00", not the day before\'s', () => {
    const pill = reminderEv('Night pill', '2026-10-13T00:00:00+03:00');
    assert(onDay(pill, '2026-10-13') === '1. Night pill (Reminder 00:00) [Calendar: Family]', `Tue ${onDay(pill, '2026-10-13')}`);
    assert(onDay(pill, '2026-10-12') === undefined, 'kept on Monday');
  });

  check('reminder: past due and not done is "(open)", timed or date-only', () => {
    const open = { ...ownReminder, open: true };
    assert(onDay(reminderEv('Call mom', '2026-10-13T07:00:00.000Z', undefined, open), '2026-10-13') === '1. Call mom (Reminder 10:00 (open)) [Calendar: Family]', 'timed');
    assert(onDay(reminderEv('Buy milk', '2026-10-13', '2026-10-14', open), '2026-10-13') === '1. Buy milk (Reminder (all day, open)) [Calendar: Family]', 'date-only');
  });

  check('reminder: carried over from an earlier day says since when, dated, with no time', () => {
    // Carried-over lines join after shaping (it would drop them), so format them directly.
    const carried = reminderEv('Pay the gas bill', '2026-10-06T06:00:00.000Z', undefined, { ...ownReminder, openSince: '2026-10-06' });
    assert(formatEventForPrompt(carried, 2, TZ, '2026-10-13') === '3. Pay the gas bill (Reminder (open since Tue 6 Oct)) [Calendar: Family]', formatEventForPrompt(carried, 2, TZ, '2026-10-13'));
    const dateOnly = reminderEv('Buy milk', '2026-10-12', '2026-10-13', { ...ownReminder, openSince: '2026-10-12' });
    assert(formatEventForPrompt(dateOnly, 0, TZ, '2026-10-13') === '1. Buy milk (Reminder (open since Mon 12 Oct)) [Calendar: Family]', 'date-only');
  });

  check('reminder: one the partner set for the viewer says "from", one the viewer set for the partner says "for ..., you asked"', () => {
    const fromDana = reminderEv('Book the vet', '2026-10-13T08:00:00.000Z', undefined, { ownerIsViewer: true, creatorIsViewer: false, creatorName: 'Dana' });
    assert(onDay(fromDana, '2026-10-13') === '1. Book the vet (Reminder 11:00) (from Dana) [Calendar: Family]', `from ${onDay(fromDana, '2026-10-13')}`);
    const forDana = reminderEv('Buy milk', '2026-10-13T14:00:00.000Z', undefined, { ownerIsViewer: false, creatorIsViewer: true, ownerName: 'Dana' });
    assert(onDay(forDana, '2026-10-13') === '1. Buy milk (Reminder 17:00) (for Dana, you asked) [Calendar: Family]', `for ${onDay(forDana, '2026-10-13')}`);
    // Dana's own reminder, on a calendar the viewer can see: her section says whose it is.
    const danasOwn = reminderEv('Yoga mat', '2026-10-13T05:00:00.000Z', undefined, { ownerIsViewer: false, creatorIsViewer: false, ownerName: 'Dana', creatorName: 'Dana' });
    assert(onDay(danasOwn, '2026-10-13') === '1. Yoga mat (Reminder 08:00) [Calendar: Family]', `own ${onDay(danasOwn, '2026-10-13')}`);
  });

  check('reminder: a name cannot break the line', () => {
    const odd = reminderEv('Call', '2026-10-13T08:00:00.000Z', undefined, { ownerIsViewer: true, creatorIsViewer: false, creatorName: 'Dana\n[urgent]' });
    assert(onDay(odd, '2026-10-13') === '1. Call (Reminder 11:00) (from Dana) [Calendar: Family]', `got ${onDay(odd, '2026-10-13')}`);
  });

  check('reminder: the line follows the user\'s timezone', () => {
    const ny = reminderEv('Call the plumber', '2026-10-13T14:00:00.000Z');
    assert(onDay(ny, '2026-10-13', 'America/New_York') === '1. Call the plumber (Reminder 10:00) [Calendar: Family]', `New York ${onDay(ny, '2026-10-13', 'America/New_York')}`);
  });
}

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
process.exit(failed ? 1 : 0);

// Pure-function smoke test for src/services/native-calendar/recurrence.ts.
// Verifies that recurring expansion + EXDATE + override + CANCELLED behave as
// the native provider expects, and that a fetch window takes every event that
// overlaps it. The event-store check runs against an in-memory stand-in for
// Prisma. No DB; safe to run anywhere.
//
// Run under both clocks; the output must not depend on the server's timezone:
//   TZ=UTC npx tsx scripts/smoke-recurrence.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-recurrence.ts

import { fromZonedTime } from 'date-fns-tz';
import { expandSeries, truncateRruleBefore, VirtualInstance } from '../src/services/native-calendar/recurrence';
import { nextDate, startOfLocalDay } from '../src/utils/day-events';
import type { NativeEvent, NativeEventInstance } from '@prisma/client';

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

async function checkAsync(name: string, fn: () => Promise<void>) {
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

function makeSeries(overrides: Partial<NativeEvent> = {}): NativeEvent {
  const now = new Date('2026-06-01T09:00:00Z');
  return {
    id: 'series-1',
    calendarId: 'cal-1',
    creatorUserId: 1,
    title: 'Weekly standup',
    description: null,
    location: null,
    startsAt: now,
    endsAt: new Date(now.getTime() + 30 * 60 * 1000),
    allDay: false,
    timeZone: 'UTC',
    rrule: null,
    exdates: [],
    reminderMinutes: null,
    kind: 'EVENT',
    forUserId: null,
    armedAt: null,
    isDeleted: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeOverride(seriesId: string, originalStartsAt: Date, fields: Partial<NativeEventInstance> = {}): NativeEventInstance {
  return {
    id: `inst-${originalStartsAt.toISOString()}`,
    seriesEventId: seriesId,
    originalStartsAt,
    status: 'OVERRIDE',
    title: null,
    description: null,
    location: null,
    startsAt: null,
    endsAt: null,
    allDay: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...fields,
  };
}

// 1. Non-recurring event in range
check('non-recurring event in range yields one instance', () => {
  const series = makeSeries();
  const out = expandSeries(series, {
    from: new Date('2026-05-30T00:00:00Z'),
    to: new Date('2026-06-05T00:00:00Z'),
  });
  assert(out.length === 1, `expected 1 got ${out.length}`);
  assert(out[0].isRecurringInstance === false, 'expected single-event flag false');
  assert(out[0].title === 'Weekly standup', 'title preserved');
});

// 2. Non-recurring event outside range
check('non-recurring event outside range yields zero', () => {
  const series = makeSeries();
  const out = expandSeries(series, {
    from: new Date('2026-07-01T00:00:00Z'),
    to: new Date('2026-07-10T00:00:00Z'),
  });
  assert(out.length === 0, `expected 0 got ${out.length}`);
});

// 3. Weekly recurring (every Monday) — count 4 weeks
check('weekly RRULE produces correct count in window', () => {
  const series = makeSeries({ rrule: 'FREQ=WEEKLY;BYDAY=MO' });
  const out = expandSeries(series, {
    from: new Date('2026-06-01T00:00:00Z'),
    to: new Date('2026-07-01T00:00:00Z'),
  });
  // 2026-06-01 is a Monday → 4 Mondays in June (1, 8, 15, 22, 29) → 5 occurrences
  assert(out.length === 5, `expected 5 got ${out.length}`);
  assert(out.every((i) => i.isRecurringInstance === true), 'all instances marked recurring');
  assert(out[0].instanceStartsAt.getUTCDate() === 1, 'first instance Jun 1');
  assert(out[4].instanceStartsAt.getUTCDate() === 29, 'last instance Jun 29');
});

// 4. EXDATE removes a specific occurrence
check('EXDATE removes the specified occurrence', () => {
  const series = makeSeries({
    rrule: 'FREQ=WEEKLY;BYDAY=MO',
    exdates: [new Date('2026-06-08T09:00:00Z')],
  });
  const out = expandSeries(series, {
    from: new Date('2026-06-01T00:00:00Z'),
    to: new Date('2026-07-01T00:00:00Z'),
  });
  assert(out.length === 4, `expected 4 (5 - 1 exdate) got ${out.length}`);
  assert(!out.some((i) => i.instanceStartsAt.getUTCDate() === 8), 'June 8 excluded');
});

// 5. Override applies field changes
check('OVERRIDE row applies new title and time to that instance only', () => {
  const series = makeSeries({ rrule: 'FREQ=WEEKLY;BYDAY=MO' });
  const overrideStart = new Date('2026-06-15T11:00:00Z'); // shifted
  const overrides = [
    makeOverride('series-1', new Date('2026-06-15T09:00:00Z'), {
      status: 'OVERRIDE',
      title: 'Standup (rescheduled)',
      startsAt: overrideStart,
      endsAt: new Date('2026-06-15T11:30:00Z'),
    }),
  ];
  const out = expandSeries(series, {
    from: new Date('2026-06-01T00:00:00Z'),
    to: new Date('2026-07-01T00:00:00Z'),
  }, overrides);
  const overridden = out.find((i) => i.isOverridden);
  assert(overridden !== undefined, 'expected an overridden instance');
  assert(overridden!.title === 'Standup (rescheduled)', `bad title: ${overridden!.title}`);
  assert(overridden!.startsAt.getTime() === overrideStart.getTime(), 'start time shifted');
  // Other instances preserved
  const nonOverridden = out.filter((i) => !i.isOverridden);
  assert(nonOverridden.every((i) => i.title === 'Weekly standup'), 'others unchanged');
});

// 6. CANCELLED override removes the occurrence
check('CANCELLED override removes the occurrence', () => {
  const series = makeSeries({ rrule: 'FREQ=WEEKLY;BYDAY=MO' });
  const overrides = [
    makeOverride('series-1', new Date('2026-06-15T09:00:00Z'), { status: 'CANCELLED' }),
  ];
  const out = expandSeries(series, {
    from: new Date('2026-06-01T00:00:00Z'),
    to: new Date('2026-07-01T00:00:00Z'),
  }, overrides);
  assert(out.length === 4, `expected 4 (5 - 1 cancelled) got ${out.length}`);
  assert(!out.some((i) => i.instanceStartsAt.getUTCDate() === 15), 'June 15 cancelled');
});

// 7. RRULE COUNT bounds
check('FREQ=DAILY;COUNT=3 returns 3 events', () => {
  const series = makeSeries({ rrule: 'FREQ=DAILY;COUNT=3' });
  const out = expandSeries(series, {
    from: new Date('2026-05-01T00:00:00Z'),
    to: new Date('2026-12-31T00:00:00Z'),
  });
  assert(out.length === 3, `expected 3 got ${out.length}`);
});

// 8. Range half-open [from, to)
check('Range is half-open: occurrence at exactly `to` is excluded', () => {
  const startsAt = new Date('2026-06-01T09:00:00Z');
  const series = makeSeries({ startsAt, endsAt: new Date(startsAt.getTime() + 60_000), rrule: 'FREQ=DAILY' });
  // Range exactly matches one occurrence start at the right edge
  const out = expandSeries(series, {
    from: new Date('2026-06-01T00:00:00Z'),
    to: new Date('2026-06-02T09:00:00Z'),
  });
  // Should include Jun 1 09:00 but NOT Jun 2 09:00 (exact boundary)
  const has2nd = out.some((i) => i.instanceStartsAt.getTime() === new Date('2026-06-02T09:00:00Z').getTime());
  assert(!has2nd, 'instance at exactly `to` should be excluded');
});

// 9. truncateRruleBefore appends UNTIL
check('truncateRruleBefore replaces UNTIL/COUNT with new UNTIL', () => {
  const inDay = new Date('2026-06-15T09:00:00Z');
  const out = truncateRruleBefore('FREQ=WEEKLY;BYDAY=MO;COUNT=10', inDay, 'UTC');
  // One second before the cut occurrence, not the previous midnight.
  assert(out.includes('UNTIL=20260615T085959'), `wrong UNTIL: ${out}`);
  assert(!out.includes('COUNT='), `COUNT should be removed: ${out}`);
  assert(out.includes('FREQ=WEEKLY'), 'FREQ preserved');
  assert(out.includes('BYDAY=MO'), 'BYDAY preserved');
});

// 10. A 'following' cut must not eat the occurrence before it. The old
// day-before-midnight UNTIL dropped one extra event from every timed series.
check('following-cut keeps the occurrence immediately before the cut', () => {
  const series = makeSeries({ rrule: 'FREQ=DAILY' });
  const cut = new Date('2026-06-04T09:00:00Z');
  const truncated = truncateRruleBefore('FREQ=DAILY', cut, 'UTC');
  const out = expandSeries({ ...series, rrule: truncated }, {
    from: new Date('2026-06-01T00:00:00Z'),
    to: new Date('2026-07-01T00:00:00Z'),
  });
  const days = out.map((i) => i.startsAt.toISOString().slice(0, 10));
  assert(
    days.join(',') === '2026-06-01,2026-06-02,2026-06-03',
    `expected Jun 1-3, got [${days.join(',')}] from ${truncated}`
  );
});

// 11. DST: a weekly event must hold its LOCAL time across a transition.
// Anchoring the rule at the stored UTC instant holds the UTC time-of-day
// instead, walking an 08:00 event to 07:00. Note rrule's own `tzid` option
// does not fix this - it expects a floating dtstart.
check('weekly event holds local time across a DST transition', () => {
  const TZ = 'Asia/Jerusalem';
  const series = makeSeries({
    // 2026-09-17 08:00 Asia/Jerusalem (UTC+3 in summer)
    startsAt: new Date('2026-09-17T05:00:00Z'),
    endsAt: new Date('2026-09-17T06:00:00Z'),
    timeZone: TZ,
    rrule: 'FREQ=WEEKLY;BYDAY=TH',
  });
  const out = expandSeries(series, {
    from: new Date('2026-09-01T00:00:00Z'),
    to: new Date('2026-12-01T00:00:00Z'),
  });
  assert(out.length >= 8, `expected several occurrences, got ${out.length}`);
  const locals = new Set(
    out.map((i) =>
      new Intl.DateTimeFormat('en-GB', {
        timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false,
      }).format(i.startsAt)
    )
  );
  assert(locals.size === 1, `local time drifted across DST: ${[...locals].join(', ')}`);
  assert(locals.has('08:00'), `expected 08:00 local, got ${[...locals].join(', ')}`);
  // And it must actually span the transition, or the check proves nothing.
  assert(
    out.some((i) => i.startsAt > new Date('2026-10-29T00:00:00Z')),
    'range did not cross the Oct 2026 transition'
  );
});

// 12. An EXDATE recorded after a DST transition must still match the
// occurrence instant the expander now produces.
check('post-DST exdate still cancels its occurrence', () => {
  const TZ = 'Asia/Jerusalem';
  const series = makeSeries({
    startsAt: new Date('2026-09-17T05:00:00Z'),
    endsAt: new Date('2026-09-17T06:00:00Z'),
    timeZone: TZ,
    rrule: 'FREQ=WEEKLY;BYDAY=TH',
    // 2026-11-05 08:00 Asia/Jerusalem, now UTC+2
    exdates: [new Date('2026-11-05T06:00:00Z')],
  });
  const out = expandSeries(series, {
    from: new Date('2026-11-01T00:00:00Z'),
    to: new Date('2026-11-12T00:00:00Z'),
  });
  assert(out.length === 0, `exdate did not match; got ${out.length} occurrence(s)`);
});

// --- Overlap: a window takes every event still running inside it -------------
// Native fetches used to take only events that START in the window, so the
// second day of anything overnight or multi-day never reached that day's
// summary. Google returns events by overlap; the summary shaping then decides
// what to show. Days below are Asia/Jerusalem local days, as a summary fetches.

const JLM = 'Asia/Jerusalem';
/** A wall-clock time in Jerusalem, e.g. '2026-11-09 18:00'. */
const at = (local: string) => fromZonedTime(`${local}:00`, JLM);
/** The local day as a fetch window: midnight to midnight. */
const dayOf = (day: string) => ({ from: startOfLocalDay(day, JLM), to: startOfLocalDay(nextDate(day), JLM) });
const jlm = (fields: Partial<NativeEvent>) => makeSeries({ timeZone: JLM, ...fields });

// 2026-11-09 is a Monday. The Monday 22:00 - Tuesday 02:00 weekly event recurs
// from the week before.
const overnightWeekly = (fields: Partial<NativeEvent> = {}) => jlm({
  title: 'Night shift', startsAt: at('2026-11-02 22:00'), endsAt: at('2026-11-03 02:00'), rrule: 'FREQ=WEEKLY;BYDAY=MO', ...fields,
});

// 13. The reported case: a sleepover from Monday 18:00 to Tuesday 10:00.
check('overlap: overnight single event reaches its second day, whole', () => {
  const sleepover = jlm({ title: 'Sleepover', startsAt: at('2026-11-09 18:00'), endsAt: at('2026-11-10 10:00') });
  const tue = expandSeries(sleepover, dayOf('2026-11-10'));
  assert(tue.length === 1, `expected it on Tuesday, got ${tue.length}`);
  assert(tue[0].startsAt.getTime() === sleepover.startsAt.getTime(), 'start must not be clipped to the window');
  assert(tue[0].isRecurringInstance === false, 'still a one-off');
  assert(expandSeries(sleepover, dayOf('2026-11-09')).length === 1, 'still on Monday');
  assert(expandSeries(sleepover, dayOf('2026-11-11')).length === 0, 'not on Wednesday');
});

// 14. All-day, saved the way the bot saves it: 00:00 to 23:59 local on the last day.
check('overlap: multi-day all-day event reaches its middle and last days', () => {
  const trip = jlm({ title: 'Trip', allDay: true, startsAt: at('2026-11-09 00:00'), endsAt: at('2026-11-11 23:59') });
  const days = ['2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12'];
  const counts = days.map((d) => expandSeries(trip, dayOf(d)).length).join(',');
  assert(counts === '0,1,1,1,0', `expected Mon-Wed only, got [${counts}] for Sun-Thu`);
});

// 15. Half-open at both ends: ending at midnight is not the next day, but
// anything starting inside the window counts whatever its end says.
check('overlap: an event ending at midnight stays off the next day', () => {
  const late = jlm({ startsAt: at('2026-11-09 22:00'), endsAt: at('2026-11-10 00:00') });
  assert(expandSeries(late, dayOf('2026-11-10')).length === 0, 'ended as Tuesday began');
  assert(expandSeries(late, dayOf('2026-11-09')).length === 1, 'still on Monday');
});

check('overlap: events wholly inside the window are unchanged', () => {
  const lunch = jlm({ startsAt: at('2026-11-10 12:00'), endsAt: at('2026-11-10 13:00') });
  const counts = ['2026-11-09', '2026-11-10', '2026-11-11'].map((d) => expandSeries(lunch, dayOf(d)).length).join(',');
  assert(counts === '0,1,0', `expected Tuesday only, got [${counts}]`);
  const instant = jlm({ startsAt: at('2026-11-10 00:00'), endsAt: at('2026-11-10 00:00') });
  assert(expandSeries(instant, dayOf('2026-11-10')).length === 1, 'zero-length event at the window start kept');
  assert(expandSeries(instant, dayOf('2026-11-09')).length === 0, 'and not pulled back a day');
});

// 16. A recurring overnight occurrence belongs to the window it runs into.
check('overlap: weekly Mon 22:00-02:00 occurrence reaches the Tuesday, once', () => {
  const series = overnightWeekly();
  const tue = expandSeries(series, dayOf('2026-11-10'));
  assert(tue.length === 1, `expected Monday night's occurrence on Tuesday, got ${tue.length}`);
  assert(tue[0].instanceStartsAt.getTime() === at('2026-11-09 22:00').getTime(), `wrong occurrence: ${tue[0].instanceStartsAt.toISOString()}`);
  assert(tue[0].isRecurringInstance, 'marked recurring');
  assert(expandSeries(series, dayOf('2026-11-09')).length === 1, 'still on Monday');
  assert(expandSeries(series, dayOf('2026-11-11')).length === 0, 'not on Wednesday');
  const monToWed = expandSeries(series, { from: dayOf('2026-11-09').from, to: dayOf('2026-11-11').from });
  assert(monToWed.length === 1, `a two-day window counts it once, got ${monToWed.length}`);
});

// 17. A Friday-Saturday all-day weekly event.
check('overlap: weekly two-day all-day occurrence reaches its last day', () => {
  const series = jlm({
    title: 'Grandparents', allDay: true, startsAt: at('2026-11-06 00:00'), endsAt: at('2026-11-07 23:59'), rrule: 'FREQ=WEEKLY;BYDAY=FR',
  });
  const sat = expandSeries(series, dayOf('2026-11-14'));
  assert(sat.length === 1, `expected Friday's occurrence on Saturday, got ${sat.length}`);
  assert(sat[0].instanceStartsAt.getTime() === at('2026-11-13 00:00').getTime(), 'the Friday it started');
  assert(expandSeries(series, dayOf('2026-11-15')).length === 0, 'not on Sunday');
});

// 17b. An occurrence that started more than a day before the window. The DST pad
// reaches back a day on its own; only reaching back by the series's length finds
// Friday's occurrence on Sunday.
const weekendCamp = (fields: Partial<NativeEvent> = {}) => jlm({
  title: 'Camp', allDay: true, startsAt: at('2026-11-06 00:00'), endsAt: at('2026-11-08 23:59'), rrule: 'FREQ=WEEKLY;BYDAY=FR', ...fields,
});
const dadWeekend = jlm({
  title: 'Dad weekend', startsAt: at('2026-11-06 18:00'), endsAt: at('2026-11-08 18:00'), rrule: 'FREQ=WEEKLY;BYDAY=FR',
});
check('overlap: a weekly occurrence over two days long reaches its last day', () => {
  for (const [series, friday] of [[weekendCamp(), '2026-11-13 00:00'], [dadWeekend, '2026-11-13 18:00']] as const) {
    const days = ['2026-11-13', '2026-11-14', '2026-11-15', '2026-11-16'];
    const counts = days.map((d) => expandSeries(series, dayOf(d)).length).join(',');
    assert(counts === '1,1,1,0', `${series.title}: expected Fri-Sun only, got [${counts}] for Fri-Mon`);
    const sun = expandSeries(series, dayOf('2026-11-15'));
    assert(sun[0].instanceStartsAt.getTime() === at(friday).getTime(), `${series.title}: Sunday has ${sun[0].instanceStartsAt.toISOString()}`);
  }
});

// 18. Friday 2027-03-26 is 23 hours long in Jerusalem. A fixed 23h59m length
// would end that occurrence at 00:59 Saturday and pull it into Saturday.
check('overlap: weekly all-day occurrence on a 23-hour DST day stays off the next day', () => {
  const series = jlm({
    title: 'Market day', allDay: true, startsAt: at('2027-03-05 00:00'), endsAt: at('2027-03-05 23:59'), rrule: 'FREQ=WEEKLY;BYDAY=FR',
  });
  const fri = expandSeries(series, dayOf('2027-03-26'));
  assert(fri.length === 1, `expected it on the DST Friday, got ${fri.length}`);
  assert(fri[0].endsAt.getTime() === at('2027-03-26 23:59').getTime(), `ends ${fri[0].endsAt.toISOString()}, not 23:59 local`);
  assert(expandSeries(series, dayOf('2027-03-27')).length === 0, 'leaked into Saturday');
});

// 19. Exclusions still hold for the occurrence a window reaches back to.
check('overlap: EXDATE and CANCELLED still remove a reached-back occurrence', () => {
  const night = at('2026-11-09 22:00');
  const exdated = overnightWeekly({ exdates: [night] });
  assert(expandSeries(exdated, dayOf('2026-11-10')).length === 0, 'EXDATE ignored on Tuesday');
  assert(expandSeries(exdated, dayOf('2026-11-17')).length === 1, 'the next week is untouched');
  const cancelled = expandSeries(overnightWeekly(), dayOf('2026-11-10'), [makeOverride('series-1', night, { status: 'CANCELLED' })]);
  assert(cancelled.length === 0, 'CANCELLED override ignored on Tuesday');
});

// 20. An override decides where its occurrence is, not the original slot.
check('overlap: an occurrence moved later shows where it moved, once', () => {
  const night = at('2026-11-09 22:00');
  const moved = [makeOverride('series-1', night, { title: 'Moved', startsAt: at('2026-11-10 20:00'), endsAt: at('2026-11-10 23:00') })];
  assert(expandSeries(overnightWeekly(), dayOf('2026-11-09'), moved).length === 0, 'still on Monday after moving off it');
  const tue = expandSeries(overnightWeekly(), dayOf('2026-11-10'), moved);
  assert(tue.length === 1, `expected the moved occurrence once on Tuesday, got ${tue.length}`);
  assert(tue[0].title === 'Moved' && tue[0].startsAt.getTime() === at('2026-11-10 20:00').getTime(), 'override fields applied');
  assert(tue[0].instanceStartsAt.getTime() === night.getTime(), 'keeps its original start as the recurrence id');

  // Nudged an hour later, it still starts Monday and still runs into Tuesday.
  const nudged = [makeOverride('series-1', night, { startsAt: at('2026-11-09 23:00'), endsAt: at('2026-11-10 03:00') })];
  const tueNudged = expandSeries(overnightWeekly(), dayOf('2026-11-10'), nudged);
  assert(tueNudged.length === 1 && tueNudged[0].isOverridden, `expected the nudged occurrence on Tuesday, got ${tueNudged.length}`);
});

check('overlap: an occurrence an override lengthens reaches every day it covers', () => {
  const night = at('2026-11-09 22:00');
  const long = [makeOverride('series-1', night, { endsAt: at('2026-11-12 12:00') })];
  const thu = expandSeries(overnightWeekly(), dayOf('2026-11-12'), long);
  assert(thu.length === 1, `expected the lengthened occurrence on Thursday, got ${thu.length}`);
  assert(thu[0].startsAt.getTime() === night.getTime(), 'starts at its original slot');
  assert(expandSeries(overnightWeekly(), dayOf('2026-11-13'), long).length === 0, 'not past its end');
});

// --- fetchEventsInCalendars: the SQL filter must take overlap too ------------
// A one-off is filtered in the query before expandSeries sees it, so the store
// gets a minimal in-memory Prisma: just the where-clause operators it uses.

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
        case 'in': return (arg as unknown[]).includes(value);
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

async function checkStore() {
  const calendar = { id: 'cal-1', name: 'Family', isDeleted: false };
  const series = (id: string, fields: Partial<NativeEvent>) => jlm({ id, calendarId: 'cal-1', ...fields });
  const events: NativeEvent[] = [
    series('sleepover', { title: 'Sleepover', startsAt: at('2026-11-09 18:00'), endsAt: at('2026-11-10 10:00') }),
    series('party', { title: 'Party', startsAt: at('2026-11-09 22:00'), endsAt: at('2026-11-10 02:00') }),
    series('trip', { title: 'Trip', allDay: true, startsAt: at('2026-11-09 00:00'), endsAt: at('2026-11-11 23:59') }),
    series('lunch', { title: 'Lunch', startsAt: at('2026-11-10 12:00'), endsAt: at('2026-11-10 13:00') }),
    series('monday', { title: 'Monday only', startsAt: at('2026-11-09 09:00'), endsAt: at('2026-11-09 10:00') }),
    series('alarm', { title: 'Wake-up call', startsAt: at('2026-11-10 00:00'), endsAt: at('2026-11-10 00:00') }),
    series('gone', { title: 'Deleted', startsAt: at('2026-11-10 09:00'), endsAt: at('2026-11-10 10:00'), isDeleted: true }),
    overnightWeekly({ id: 'shift', calendarId: 'cal-1' }),
    weekendCamp({ id: 'camp', calendarId: 'cal-1' }),
  ];
  const table = <T extends Row>(rows: T[]) => ({ findMany: async ({ where }: { where: Where }) => rows.filter((r) => matches(r, where)) });
  // src/utils/prisma reuses global.prisma when set; it must be in place before the store loads.
  (globalThis as { prisma?: unknown }).prisma = {
    nativeCalendar: table([calendar]),
    nativeEvent: table(events as unknown as Row[]),
    nativeEventInstance: table([] as Row[]),
  };
  const { fetchEventsInCalendars } = await import('../src/services/native-calendar/event-store');
  const titlesOn = async (day: string) =>
    (await fetchEventsInCalendars(['cal-1'], dayOf(day))).map((r) => r.instance.title).sort().join(', ');

  // Tuesday takes everything running into it; the summary shaping, not the
  // fetch, drops the party's short tail.
  const tue = await titlesOn('2026-11-10');
  assert(tue === 'Lunch, Night shift, Party, Sleepover, Trip, Wake-up call', `Tuesday got [${tue}]`);
  const wed = await titlesOn('2026-11-11');
  assert(wed === 'Trip', `Wednesday got [${wed}]`);
  const mon = await titlesOn('2026-11-09');
  assert(mon === 'Monday only, Night shift, Party, Sleepover, Trip', `Monday got [${mon}]`);
  // The recurring camp's Friday started two days before Sunday's window.
  const sun = await titlesOn('2026-11-15');
  assert(sun === 'Camp', `Sunday got [${sun}]`);
}

async function main() {
  await checkAsync('overlap: fetchEventsInCalendars takes everything running into the window', checkStore);

  // Print results
  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();

// Silence unused-import warning when file is type-checked but not yet run
void (null as unknown as VirtualInstance | undefined);

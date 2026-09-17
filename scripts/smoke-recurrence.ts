// Pure-function smoke test for src/services/native-calendar/recurrence.ts.
// Verifies that recurring expansion + EXDATE + override + CANCELLED behave as
// the native provider expects. No DB; safe to run anywhere.
//
// Run: npx tsx scripts/smoke-recurrence.ts

import { expandSeries, truncateRruleBefore, VirtualInstance } from '../src/services/native-calendar/recurrence';
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

// Print results
let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);

// Silence unused-import warning when file is type-checked but not yet run
void (null as unknown as VirtualInstance | undefined);

// Smoke test for the richer repeats' server model (editor upgrades spec §3, "Richer repeats"):
// the one rule builder (ruleOfSpec), reading a rule back as the sheet says it (specOfRule),
// the limits of a RepeatSpec and both write bodies' parsing, the change test (repeatChanges),
// the end rules of a repeat change (ruleToWrite), and that every spec crosses to Google.
// The writes themselves (FamCal create/update through the store, Google create/update) are in
// smoke-calendar-editor-api and smoke-google-write.
//
// Pure: no database, no network. The recurrence expansion, rrule.js and the mapper run for real.
//
// Run under both clocks; nothing may depend on the server's timezone:
//   TZ=UTC npx tsx scripts/smoke-repeat-spec.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-repeat-spec.ts

import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';

process.env.TELEGRAM_BOT_TOKEN ||= 'test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);

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
const show = (value: unknown) => JSON.stringify(value);
function assertSame(got: unknown, want: unknown, label: string) {
  assert(show(got) === show(want), `${label}\n     got  ${show(got)}\n     want ${show(want)}`);
}

const IL = 'Asia/Jerusalem';
const at = (local: string, tz = IL) => fromZonedTime(`${local}:00`, tz);

async function main() {
  const rec = await import('../src/services/native-calendar/recurrence');
  const write = await import('../src/services/calendar-write/repeat-spec');
  const validate = await import('../src/services/calendar-write/validate');
  const mapper = await import('../src/services/calendar-move/mapper');
  const { NativeRuleError } = await import('../src/services/native-calendar/recurrence');
  /**
   * The bot's builder (calendar.ts buildRecurrenceRule), copied: calendar.ts pulls the whole bot in and this smoke is pure.
   * smoke-calendar-editor-api runs the real one against ruleFor's old output.
   */
  const buildRecurrenceRule = (r: { frequency: string; daysOfWeek?: string[]; interval?: number; until?: string; count?: number }): string[] => {
    let rule = `RRULE:FREQ=${r.frequency.toUpperCase()}`;
    if (r.interval && r.interval > 1) rule += `;INTERVAL=${r.interval}`;
    if (r.daysOfWeek && r.daysOfWeek.length > 0) rule += `;BYDAY=${r.daysOfWeek.join(',')}`;
    if (r.until) rule += `;UNTIL=${r.until.replace(/-/g, '')}`;
    else if (r.count) rule += `;COUNT=${r.count}`;
    return [rule];
  };
  type Spec = import('../src/lib/calendar-view/editor-types').RepeatSpec;

  /** A stored series shaped as the store's rows are, for the expander and the mapper. */
  const seriesOf = (rrule: string | null, start: Date, extra: Record<string, unknown> = {}) =>
    ({
      id: 's1', calendarId: 'c', creatorUserId: 1, title: 't', description: null, location: null, allDay: false, timeZone: IL,
      startsAt: start, endsAt: new Date(start.getTime() + 3_600_000), rrule, hebrewRule: null, hebrewAnchor: null, exdates: [],
      ownAlerts: false, alertMinutes: [], kind: 'EVENT', forUserId: null, armedAt: null, isDeleted: false,
      createdAt: new Date(0), updatedAt: new Date(0), ...extra,
    }) as unknown as import('@prisma/client').NativeEvent;
  /** The days (yyyy-MM-dd in Israel) a rule yields from its start, the first `n` up to `to`. */
  const days = (rrule: string, start: Date, to = '2027-03-01') =>
    rec.expandSeries(seriesOf(rrule, start), { from: start, to: at(`${to} 00:00`) }, []).map((i) => formatInTimeZone(i.startsAt, IL, 'yyyy-MM-dd'));
  const build = (spec: Spec, start: string, tz = IL) => write.ruleOfSpec(spec, at(start, tz), tz);
  const refused = (fn: () => unknown) => {
    try {
      fn();
    } catch (err) {
      return err instanceof NativeRuleError;
    }
    return false;
  };

  await check('ruleOfSpec: a string choice is its spec and writes today\'s rule byte for byte; none has no spec', () => {
    const start = at('2026-10-20 10:00');
    for (const choice of ['daily', 'weekly', 'monthly', 'yearly'] as const) {
      const spec = write.specOfChoice(choice)!;
      assertSame(write.ruleOfSpec(spec, start, IL), { rrule: buildRecurrenceRule({ frequency: choice })[0].replace(/^RRULE:/, ''), hebrewRule: null }, choice);
    }
    assertSame(write.ruleOfSpec(write.specOfChoice('hebrew')!, start, IL), { rrule: 'FREQ=YEARLY', hebrewRule: 'anniversary' }, 'hebrew');
    assertSame(write.specOfChoice('none'), null, 'none');
  });

  await check('ruleOfSpec: "the second Tuesday" is BYDAY=2TU on a start that is one, and follows the start\'s ordinal', () => {
    const rule = build({ freq: 'monthly', interval: 1, monthly: 'weekday' }, '2026-10-13 10:00').rrule;
    assertSame(rule, 'FREQ=MONTHLY;BYDAY=2TU', 'rule');
    assertSame(days(rule, at('2026-10-13 10:00'), '2027-01-01'), ['2026-10-13', '2026-11-10', '2026-12-08'], 'the second Tuesdays');
    assertSame(build({ freq: 'monthly', interval: 1, monthly: 'weekday' }, '2026-10-29 10:00').rrule, 'FREQ=MONTHLY;BYDAY=5TH', 'the 29th is the fifth Thursday');
    assertSame(build({ freq: 'monthly', interval: 2, monthly: 'day' }, '2026-10-14 10:00').rrule, 'FREQ=MONTHLY;INTERVAL=2', 'on day 14 follows the start');
  });

  await check('ruleOfSpec: "the last Tuesday" is BYDAY=-1TU, only when the start is in the month\'s last seven days', () => {
    const rule = build({ freq: 'monthly', interval: 1, monthly: 'last' }, '2026-10-27 10:00').rrule;
    assertSame(rule, 'FREQ=MONTHLY;BYDAY=-1TU', 'rule');
    assertSame(days(rule, at('2026-10-27 10:00'), '2027-01-01'), ['2026-10-27', '2026-11-24', '2026-12-29'], 'the last Tuesdays');
    assert(refused(() => build({ freq: 'monthly', interval: 1, monthly: 'last' }, '2026-10-20 10:00')), 'the 20th is not in the last week');
    assertSame(build({ freq: 'monthly', interval: 1, monthly: 'last' }, '2026-10-25 10:00').rrule, 'FREQ=MONTHLY;BYDAY=-1SU', 'the 25th is (October has 31 days)');
    assert(refused(() => build({ freq: 'monthly', interval: 1, monthly: 'last' }, '2026-02-21 10:00')), '21 Feb: February has 28 days, the last week starts on the 22nd');
  });

  await check('ruleOfSpec: INTERVAL only above 1; an until is a date-only UNTIL, a count COUNT; the occurrences end where they should', () => {
    assertSame(build({ freq: 'daily', interval: 1 }, '2026-10-20 10:00').rrule, 'FREQ=DAILY', 'interval 1 is not written');
    const every3 = build({ freq: 'daily', interval: 3, until: '2026-11-01' }, '2026-10-20 10:00').rrule;
    assertSame(every3, 'FREQ=DAILY;INTERVAL=3;UNTIL=20261101', 'rule');
    assertSame(days(every3, at('2026-10-20 10:00')), ['2026-10-20', '2026-10-23', '2026-10-26', '2026-10-29', '2026-11-01'], 'until is inclusive, the last day too (a timed series)');
    const counted = build({ freq: 'weekly', interval: 2, count: 3 }, '2026-10-20 10:00').rrule;
    assertSame(counted, 'FREQ=WEEKLY;INTERVAL=2;COUNT=3', 'count');
    assertSame(days(counted, at('2026-10-20 10:00')), ['2026-10-20', '2026-11-03', '2026-11-17'], 'three occurrences');
    assertSame(build({ freq: 'yearly', interval: 1, until: '2028-10-20' }, '2026-10-20 10:00').rrule, 'FREQ=YEARLY;UNTIL=20281020', 'yearly');
  });

  await check('ruleOfSpec, weekly: BYDAY only for more days than the start\'s; the start\'s day is always added; days in Monday-first order', () => {
    const tue = '2026-10-20 10:00';
    assertSame(build({ freq: 'weekly', interval: 1 }, tue).rrule, 'FREQ=WEEKLY', 'no days');
    assertSame(build({ freq: 'weekly', interval: 1, byDay: ['TU'] }, tue).rrule, 'FREQ=WEEKLY', 'the start\'s day alone writes no BYDAY, so it follows its start');
    assertSame(build({ freq: 'weekly', interval: 1, byDay: ['TH', 'TU'] }, tue).rrule, 'FREQ=WEEKLY;BYDAY=TU,TH', 'two days');
    assertSame(build({ freq: 'weekly', interval: 1, byDay: ['TH'] }, tue).rrule, 'FREQ=WEEKLY;BYDAY=TU,TH', 'the start\'s day is added');
    assertSame(build({ freq: 'weekly', interval: 2, byDay: ['SU', 'MO'] }, '2026-10-21 10:00').rrule, 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,SU', 'Wednesday start, Sunday and Monday');
    const rule = build({ freq: 'weekly', interval: 2, byDay: ['SU', 'TU'], until: '2026-11-30' }, '2026-10-20 10:00').rrule;
    assertSame(days(rule, at('2026-10-20 10:00'), '2026-11-30'), ['2026-10-20', '2026-10-25', '2026-11-03', '2026-11-08', '2026-11-17', '2026-11-22'], 'every other week on Tue and Sun: weeks start on Monday (no WKST is written), so the Sunday ends its week');
    // The day is read in the item's zone, not the server's: 00:30 Tuesday in Israel is Monday in UTC.
    assertSame(build({ freq: 'weekly', interval: 1, byDay: ['TH'] }, '2026-10-20 00:30').rrule, 'FREQ=WEEKLY;BYDAY=TU,TH', 'Israel\'s Tuesday');
  });

  await check('ruleOfSpec, WKST: every N weeks on several days carries the user\'s week start, so the days pair within their week; nothing else writes WKST', () => {
    const sun = at('2026-10-25 10:00'); // a Sunday
    const spec: Spec = { freq: 'weekly', interval: 2, byDay: ['TU'] };
    const sunStart = write.ruleOfSpec(spec, sun, IL, 0).rrule;
    const monStart = write.ruleOfSpec(spec, sun, IL, 1).rrule;
    assertSame([sunStart, monStart], ['FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,SU;WKST=SU', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,SU;WKST=MO'], 'rules');
    assertSame(days(sunStart, sun, '2026-11-20'), ['2026-10-25', '2026-10-27', '2026-11-08', '2026-11-10'], 'Sunday-start week: Sun and Tue of the same week');
    assertSame(days(monStart, sun, '2026-11-20'), ['2026-10-25', '2026-11-03', '2026-11-08', '2026-11-17'], 'Monday-start week: the Sunday ends its week, the Tuesday is two weeks on');
    assertSame(write.ruleOfSpec({ freq: 'weekly', interval: 1 }, sun, IL, 0).rrule, 'FREQ=WEEKLY', 'a plain weekly');
    assertSame(write.ruleOfSpec({ freq: 'weekly', interval: 1, byDay: ['TU'] }, sun, IL, 0).rrule, 'FREQ=WEEKLY;BYDAY=TU,SU', 'interval 1');
    assertSame(write.ruleOfSpec({ freq: 'weekly', interval: 2 }, sun, IL, 0).rrule, 'FREQ=WEEKLY;INTERVAL=2', 'one day');
    assertSame(write.ruleOfSpec({ freq: 'daily', interval: 2 }, sun, IL, 0).rrule, 'FREQ=DAILY;INTERVAL=2', 'daily');
    assertSame(write.ruleOfSpec({ freq: 'weekly', interval: 2, byDay: ['TU'], count: 3 }, sun, IL, 6).rrule, 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,SU;WKST=SA;COUNT=3', 'Saturday, before the end');
    assertSame(mapper.googleRuleLine(sunStart, false, IL), `RRULE:${sunStart}`, 'Google keeps it');
    assertSame(rec.specOfRule(sunStart, sun, IL), { freq: 'weekly', interval: 2, byDay: ['TU', 'SU'] }, 'reading ignores it');
    const stored = { rrule: sunStart, startsAt: sun, timeZone: IL };
    assertSame(write.repeatChanges({ freq: 'weekly', interval: 2, byDay: ['TU', 'SU'] }, stored, 'custom', sun, IL), false, 'the change test ignores it');
  });

  await check('ruleOfSpec, Hebrew: FREQ=YEARLY with the pair, every N years and an end', () => {
    assertSame(build({ freq: 'hebrew', interval: 2, count: 3 }, '2027-01-24 10:00'), { rrule: 'FREQ=YEARLY;INTERVAL=2;COUNT=3', hebrewRule: 'anniversary' }, 'every 2 years, 3 times');
    assertSame(build({ freq: 'hebrew', interval: 1, until: '2030-01-01' }, '2027-01-24 10:00'), { rrule: 'FREQ=YEARLY;UNTIL=20300101', hebrewRule: 'anniversary' }, 'until');
  });

  await check('limits: interval 1..99, count 1..999, until a real day within the years and not before the start, byDay only weekly and non-empty, monthly only monthly, never both ends', () => {
    const ok = (spec: unknown) => validate.specWithinLimits(spec);
    assertSame([ok({ freq: 'daily', interval: 1 }), ok({ freq: 'daily', interval: 99 }), ok({ freq: 'daily', interval: 0 }), ok({ freq: 'daily', interval: 100 }), ok({ freq: 'daily', interval: 1.5 }), ok({ freq: 'daily' })], [true, true, false, false, false, false], 'interval');
    assertSame([ok({ freq: 'daily', interval: 1, count: 999 }), ok({ freq: 'daily', interval: 1, count: 1000 }), ok({ freq: 'daily', interval: 1, count: 0 }), ok({ freq: 'daily', interval: 1, count: '3' })], [true, false, false, false], 'count');
    assertSame([ok({ freq: 'daily', interval: 1, until: '2026-10-20' }), ok({ freq: 'daily', interval: 1, until: '2026-02-30' }), ok({ freq: 'daily', interval: 1, until: '2101-01-01' }), ok({ freq: 'daily', interval: 1, until: '1999-12-31' }), ok({ freq: 'yearly', interval: 1, until: '1950-01-01' }), ok({ freq: 'daily', interval: 1, until: 5 })], [true, false, false, false, true, false], 'until');
    assertSame([ok({ freq: 'daily', interval: 1, until: '2026-10-20', count: 3 })], [false], 'never both');
    assertSame([ok({ freq: 'weekly', interval: 1, byDay: ['MO'] }), ok({ freq: 'weekly', interval: 1, byDay: [] }), ok({ freq: 'weekly', interval: 1, byDay: ['XX'] }), ok({ freq: 'weekly', interval: 1, byDay: ['MO', 'MO'] }), ok({ freq: 'daily', interval: 1, byDay: ['MO'] }), ok({ freq: 'monthly', interval: 1, byDay: ['MO'] })], [true, false, false, false, false, false], 'byDay');
    assertSame([ok({ freq: 'monthly', interval: 1, monthly: 'last' }), ok({ freq: 'monthly', interval: 1, monthly: 'sometimes' }), ok({ freq: 'weekly', interval: 1, monthly: 'day' }), ok({ freq: 'hebrew', interval: 1, monthly: 'day' })], [true, false, false, false], 'monthly');
    assertSame([ok({ freq: 'hourly', interval: 1 }), ok({ freq: 'daily', interval: 1, extra: 1 }), ok('daily'), ok(null), ok([])], [false, false, false, false, false], 'shape');
    assert(refused(() => build({ freq: 'daily', interval: 100 }, '2026-10-20 10:00')), 'the builder refuses a spec beyond its limits too');
    assert(refused(() => build({ freq: 'daily', interval: 1, until: '2026-10-19' }, '2026-10-20 10:00')), 'an until before the start\'s day');
    assert(!refused(() => build({ freq: 'daily', interval: 1, until: '2026-10-20' }, '2026-10-20 10:00')), 'an until on the start\'s day');
    // The start's day is read in the item's zone: 01:00 on the 21st in Israel is still the 20th in UTC.
    assert(refused(() => build({ freq: 'daily', interval: 1, until: '2026-10-20' }, '2026-10-21 01:00')), 'Israel\'s 21st is after the 20th');
  });

  await check('specOfRule: a spec built is read back as itself, for every kind of repeat', () => {
    const cases: [Spec, string][] = [
      [{ freq: 'daily', interval: 1 }, '2026-10-20 10:00'],
      [{ freq: 'daily', interval: 3, count: 5 }, '2026-10-20 10:00'],
      [{ freq: 'weekly', interval: 1, byDay: ['TU'] }, '2026-10-20 10:00'],
      [{ freq: 'weekly', interval: 2, byDay: ['TU', 'SU'], until: '2026-12-01' }, '2026-10-20 10:00'],
      [{ freq: 'monthly', interval: 1, monthly: 'day' }, '2026-10-14 10:00'],
      [{ freq: 'monthly', interval: 3, monthly: 'weekday', count: 4 }, '2026-10-13 10:00'],
      [{ freq: 'monthly', interval: 1, monthly: 'last', until: '2027-03-30' }, '2026-10-27 10:00'],
      [{ freq: 'yearly', interval: 1 }, '2026-10-20 10:00'],
      [{ freq: 'yearly', interval: 5, count: 2 }, '2026-10-20 10:00'],
    ];
    for (const [spec, start] of cases) {
      const built = build(spec, start);
      assertSame(rec.specOfRule(built.rrule, at(start), IL), spec, built.rrule);
    }
    const heb = build({ freq: 'hebrew', interval: 2, count: 3 }, '2027-01-24 10:00');
    assertSame(rec.specOfRule(heb.rrule, at('2027-01-24 10:00'), IL, { hebrewRule: 'anniversary', hebrewAnchor: '2027-01-24' }), { freq: 'hebrew', interval: 2, count: 3 }, 'hebrew');
  });

  await check('specOfRule: the bot\'s rules (buildRecurrenceRule) read back, and what the sheet can\'t say stays custom (null)', () => {
    const tue = at('2026-10-20 10:00');
    const bot = (r: Parameters<typeof buildRecurrenceRule>[0]) => buildRecurrenceRule(r)[0].replace(/^RRULE:/, '');
    assertSame(rec.specOfRule(bot({ frequency: 'weekly', daysOfWeek: ['TU', 'TH'], interval: 2, until: '2026-12-31' }), tue, IL), { freq: 'weekly', interval: 2, byDay: ['TU', 'TH'], until: '2026-12-31' }, 'weekly Tue Thu every 2, until');
    assertSame(rec.specOfRule(bot({ frequency: 'weekly', daysOfWeek: ['TU'], count: 4 }), tue, IL), { freq: 'weekly', interval: 1, byDay: ['TU'], count: 4 }, 'every Tuesday, 4 times');
    assertSame(rec.specOfRule(bot({ frequency: 'daily', interval: 2 }), tue, IL), { freq: 'daily', interval: 2 }, 'daily every 2');
    assertSame(rec.specOfRule(bot({ frequency: 'weekly' }), tue, IL), { freq: 'weekly', interval: 1, byDay: ['TU'] }, 'weekly lists the start\'s day');
    const custom = [
      'FREQ=WEEKLY;BYDAY=MO,WE', // not the start's weekday
      'FREQ=WEEKLY;BYDAY=2TU', // an ordinal on a weekly rule
      'FREQ=DAILY;BYDAY=TU', 'FREQ=MONTHLY;BYDAY=TU', // no ordinal
      'FREQ=MONTHLY;BYDAY=2TU', // the 20th is the third Tuesday
      'FREQ=MONTHLY;BYDAY=-1TU', // the 20th is not in the last week
      'FREQ=MONTHLY;BYMONTHDAY=21', 'FREQ=MONTHLY;BYMONTHDAY=20,21', 'FREQ=MONTHLY;BYMONTHDAY=-1',
      'FREQ=YEARLY;BYMONTH=11', 'FREQ=YEARLY;BYMONTH=10;BYMONTHDAY=21', 'FREQ=YEARLY;BYDAY=TU',
      'FREQ=HOURLY', 'FREQ=WEEKLY;INTERVAL=100', 'FREQ=MONTHLY;BYSETPOS=1;BYDAY=TU', 'FREQ=WEEKLY;UNTIL=20261231;COUNT=3', 'not a rule',
    ];
    for (const rule of custom) assertSame(rec.specOfRule(rule, tue, IL), null, rule);
    assertSame(rec.specOfRule('FREQ=MONTHLY;BYDAY=3TU', tue, IL), { freq: 'monthly', interval: 1, monthly: 'weekday' }, 'the 20th is the third Tuesday');
    assertSame(rec.specOfRule('FREQ=MONTHLY;BYDAY=-1TU', at('2026-10-27 10:00'), IL), { freq: 'monthly', interval: 1, monthly: 'last' }, 'the 27th is in the last week');
    assertSame(rec.specOfRule('FREQ=MONTHLY;BYMONTHDAY=20;WKST=MO', tue, IL), { freq: 'monthly', interval: 1, monthly: 'day' }, 'BYMONTHDAY at the start\'s day; WKST aside');
    assertSame(rec.specOfRule('FREQ=YEARLY;INTERVAL=2;BYMONTH=10;BYMONTHDAY=20', tue, IL), { freq: 'yearly', interval: 2 }, 'yearly at the start\'s month and day');
    // A cut series' date-time UNTIL (floating) is its day; a Hebrew rule with a BY part is not sayable.
    assertSame(rec.specOfRule('FREQ=DAILY;UNTIL=20261024T095959', tue, IL), { freq: 'daily', interval: 1, until: '2026-10-23' }, 'a cut\'s UNTIL is its last occurrence\'s day (the 24th at 09:59:59 excludes the 24th at 10:00)');
    assertSame(rec.specOfRule('FREQ=YEARLY;BYMONTH=1', at('2027-01-24 10:00'), IL, { hebrewRule: 'anniversary', hebrewAnchor: '2027-01-24' }), null, 'hebrew with a BY part');
    assertSame(rec.specOfRule(null, tue, IL), null, 'none');
  });

  await check('endOfRule: an UNTIL is its day, a COUNT its number, neither is Never', () => {
    assertSame([rec.endOfRule('FREQ=DAILY'), rec.endOfRule('RRULE:FREQ=DAILY;COUNT=3'), rec.endOfRule('FREQ=DAILY;UNTIL=20261231'), rec.endOfRule('FREQ=DAILY;UNTIL=20261024T095959'), rec.endOfRule(null)],
      [{}, { count: 3 }, { until: '2026-12-31' }, { until: '2026-10-24' }, {}], 'ends');
  });

  await check('endOfRule, a date-time UNTIL is the day of the last slot at or before it in the series\' zone; a date-only one its own day', () => {
    const tue = at('2026-10-20 10:00');
    assertSame(rec.endOfRule('FREQ=WEEKLY;UNTIL=20261027T095959', tue, IL), { until: '2026-10-20' }, 'a weekly head cut at the 27th ends on the 20th');
    assertSame(rec.endOfRule('FREQ=WEEKLY;UNTIL=20261027T100000', tue, IL), { until: '2026-10-27' }, 'an UNTIL on the slot');
    assertSame(rec.endOfRule('FREQ=WEEKLY;UNTIL=20261027', tue, IL), { until: '2026-10-27' }, 'date-only: its own day');
    assertSame(rec.endOfRule('FREQ=WEEKLY;UNTIL=20261027T095959'), { until: '2026-10-27' }, 'without a start, the UNTIL\'s own day');
    const read = rec.specOfRule('FREQ=WEEKLY;UNTIL=20261027T095959', tue, IL);
    assertSame(read, { freq: 'weekly', interval: 1, byDay: ['TU'], until: '2026-10-20' }, 'the spec says it');
    // The ruling-5 round trip: the day the sheet shows, sent back, is the end (a date-only UNTIL on it, not the head's UNTIL a period later).
    const stored = { rrule: 'FREQ=WEEKLY;UNTIL=20261027T095959', startsAt: tue, timeZone: IL };
    assertSame(write.ruleToWrite(read!, stored, tue, IL, null), { rrule: 'FREQ=WEEKLY;UNTIL=20261020', hebrewRule: null, endGiven: true }, 'the shown end is written');
  });

  await check('specOfRule: YEARLY with BYMONTHDAY alone is custom (rrule expands it monthly); with the start\'s BYMONTH it is yearly', () => {
    const tue = at('2026-10-20 10:00');
    assertSame(rec.specOfRule('FREQ=YEARLY;BYMONTHDAY=20', tue, IL), null, 'BYMONTHDAY alone');
    assertSame(rec.specOfRule('FREQ=YEARLY;BYMONTH=10;BYMONTHDAY=20', tue, IL), { freq: 'yearly', interval: 1 }, 'both');
    assertSame(rec.specOfRule('FREQ=YEARLY;BYMONTH=10', tue, IL), { freq: 'yearly', interval: 1 }, 'BYMONTH alone');
  });

  await check('a rebuilt stored every-N-weeks rule keeps its own week start (Monday without a WKST); a new one takes the user\'s', () => {
    const sun = at('2026-10-25 10:00');
    const stored = { rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,TU', startsAt: sun, timeZone: IL };
    const cut = { at: at('2026-11-03 10:00'), first: false };
    const spec: Spec = { freq: 'weekly', interval: 2, byDay: ['SU', 'TU'], count: 5 };
    const kept = write.ruleToWrite(spec, stored, at('2026-11-03 10:00'), IL, cut, 0).rrule;
    assert(kept.includes('WKST=MO'), `kept the stored Monday: ${kept}`);
    assertSame(days(kept, at('2026-11-03 10:00'), '2026-12-01'), ['2026-11-03', '2026-11-08', '2026-11-17', '2026-11-22'], 'the 8th and the 22nd stay');
    const own = { ...stored, rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,TU;WKST=SU' };
    assert(write.ruleToWrite(spec, own, at('2026-11-03 10:00'), IL, cut, 1).rrule.includes('WKST=SU'), 'its own WKST');
    const plain = { ...stored, rrule: 'FREQ=WEEKLY' };
    assert(write.ruleToWrite(spec, plain, at('2026-11-03 10:00'), IL, cut, 0).rrule.includes('WKST=SU'), 'a change that introduces the shape takes the user\'s');
    assert(write.ruleToWrite(spec, null, sun, IL, null, 0).rrule.includes('WKST=SU'), 'a one-off becoming a series');
  });

  await check('ruleCrosses: the start is a slot of every spec, so the mapper never refuses one (monthly 31st, a 29 Feb yearly, the last Tuesday)', () => {
    const specs: [Spec, string][] = [
      [{ freq: 'daily', interval: 2 }, '2026-10-20 10:00'], [{ freq: 'weekly', interval: 1, byDay: ['MO', 'TH'] }, '2026-10-20 10:00'],
      [{ freq: 'weekly', interval: 3 }, '2026-10-20 10:00'], [{ freq: 'monthly', interval: 1, monthly: 'day' }, '2026-10-31 10:00'],
      [{ freq: 'monthly', interval: 1, monthly: 'weekday' }, '2026-10-13 10:00'], [{ freq: 'monthly', interval: 2, monthly: 'last', count: 5 }, '2026-10-27 10:00'],
      [{ freq: 'monthly', interval: 1, monthly: 'weekday' }, '2026-10-29 10:00'], [{ freq: 'yearly', interval: 1 }, '2028-02-29 10:00'],
      [{ freq: 'yearly', interval: 2, until: '2040-01-01' }, '2026-10-20 10:00'],
    ];
    for (const [spec, start] of specs) {
      const built = build(spec, start);
      assertSame(mapper.famcalCrossRefusal(seriesOf(built.rrule, at(start)), []), null, built.rrule);
    }
  });

  await check('repeatChanges, a string: another choice, or the same one over a rule it doesn\'t write (a bot\'s BYDAY=TU re-picked follows its start); ends ignored', () => {
    const start = at('2026-10-20 10:00');
    const stored = (rrule: string | null) => ({ rrule, startsAt: start, timeZone: IL });
    const classify = (rrule: string | null) => rec.classifyRule(rrule, start, IL).choice;
    const changes = (choice: Parameters<typeof write.repeatChanges>[0], rrule: string | null) => write.repeatChanges(choice, stored(rrule), classify(rrule), start, IL);
    assertSame([changes('weekly', 'FREQ=WEEKLY'), changes('weekly', 'FREQ=WEEKLY;BYDAY=TU'), changes('daily', 'FREQ=WEEKLY'), changes('none', null), changes('none', 'FREQ=DAILY'), changes('weekly', 'FREQ=WEEKLY;UNTIL=20261231')],
      [false, true, true, false, true, false], 'strings');
  });

  await check('repeatChanges, a spec: it differs when the rule it builds does, its end does, or its Hebrew pair does; a bot rule the sheet shows is no change', () => {
    const start = at('2026-10-20 10:00');
    const stored = (rrule: string | null, hebrew = false) => ({ rrule, startsAt: start, timeZone: IL, ...(hebrew ? { hebrewRule: 'anniversary', hebrewAnchor: '2026-10-20' } : {}) });
    const changes = (spec: Spec, rrule: string | null, tail = start, hebrew = false) => write.repeatChanges(spec, stored(rrule, hebrew), rec.classifyRule(rrule, start, IL, stored(rrule, hebrew)).choice, tail, IL);
    assertSame(changes({ freq: 'weekly', interval: 1, byDay: ['TU'] }, 'FREQ=WEEKLY'), false, 'the shown spec of a weekly');
    assertSame(changes({ freq: 'weekly', interval: 1, byDay: ['TU'] }, 'FREQ=WEEKLY;BYDAY=TU'), true, 'a spec on a bot\'s every Tuesday is a change: the rule follows its start (ruling 6)');
    assertSame(changes({ freq: 'weekly', interval: 1, byDay: ['TH'] }, 'FREQ=WEEKLY;BYDAY=TU', at('2026-10-22 10:00')), true, 'a Tuesday series restated on Thursday: FREQ=WEEKLY from there (the day move)');
    assertSame(changes({ freq: 'monthly', interval: 1, monthly: 'day' }, 'FREQ=MONTHLY;BYMONTHDAY=14', at('2026-10-15 10:00')), true, 'BYMONTHDAY=14 restated on the 15th');
    assertSame(changes({ freq: 'weekly', interval: 2, byDay: ['SU', 'TU'] }, 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,SU;WKST=SU'), false, 'WKST and the order of the days are ignored');
    assertSame(changes({ freq: 'weekly', interval: 2, byDay: ['TU'] }, 'FREQ=WEEKLY'), true, 'interval');
    assertSame(changes({ freq: 'weekly', interval: 1, byDay: ['TU', 'TH'] }, 'FREQ=WEEKLY'), true, 'a day');
    assertSame(changes({ freq: 'weekly', interval: 1, byDay: ['TU', 'TH'] }, 'FREQ=WEEKLY;BYDAY=TH,TU'), false, 'the same days in another order');
    assertSame(changes({ freq: 'weekly', interval: 1, byDay: ['TU'] }, 'FREQ=WEEKLY;BYDAY=MO,WE'), true, 'a custom rule is compared as it is');
    assertSame(changes({ freq: 'weekly', interval: 1, byDay: ['TU'], count: 3 }, 'FREQ=WEEKLY'), true, 'an end added');
    assertSame(changes({ freq: 'weekly', interval: 1, byDay: ['TU'] }, 'FREQ=WEEKLY;COUNT=3'), true, 'an end removed (Never)');
    assertSame(changes({ freq: 'weekly', interval: 1, byDay: ['TU'], count: 3 }, 'FREQ=WEEKLY;COUNT=3'), false, 'the same end');
    assertSame(changes({ freq: 'weekly', interval: 1, byDay: ['TU'], until: '2026-12-31' }, 'FREQ=WEEKLY;UNTIL=20261231'), false, 'the same until');
    assertSame(changes({ freq: 'weekly', interval: 1, byDay: ['TU'], until: '2026-12-30' }, 'FREQ=WEEKLY;UNTIL=20261231'), true, 'another until');
    assertSame(changes({ freq: 'daily', interval: 1 }, null), true, 'a one-off becoming a repeat');
    assertSame(changes({ freq: 'yearly', interval: 1 }, 'FREQ=YEARLY'), false, 'the same yearly');
    assertSame(changes({ freq: 'hebrew', interval: 1 }, 'FREQ=YEARLY'), true, 'Gregorian to Hebrew');
    assertSame(changes({ freq: 'yearly', interval: 1 }, 'FREQ=YEARLY', start, true), true, 'Hebrew to Gregorian');
    assertSame(changes({ freq: 'hebrew', interval: 1 }, 'FREQ=YEARLY', start, true), false, 'the same Hebrew');
    // A fixed-day series restated on a start that moved: the rule is rebuilt on the new start.
    assertSame(changes({ freq: 'weekly', interval: 1, byDay: ['TU', 'TH'] }, 'FREQ=WEEKLY;BYDAY=TU,TH', at('2026-10-22 10:00')), false, 'moved onto a listed day: the same rule, no change (the day move is then "only this one")');
    assertSame(changes({ freq: 'weekly', interval: 1, byDay: ['TU', 'TH'] }, 'FREQ=WEEKLY;BYDAY=TU,TH', at('2026-10-21 10:00')), true, 'moved onto Wednesday: the chips gain it');
    assertSame(changes({ freq: 'monthly', interval: 1, monthly: 'weekday' }, 'FREQ=MONTHLY;BYDAY=3TU', at('2026-10-27 10:00')), true, 'the ordinal follows the new start (the 4th Tuesday)');
    assert(refused(() => changes({ freq: 'monthly', interval: 1, monthly: 'last' }, 'FREQ=MONTHLY')), 'a "last Tuesday" off the last week throws, so the write answers 400 repeat');
  });

  await check('ruleToWrite: a split head\'s date-time UNTIL is shown as its last occurrence\'s day, so a spec leaving the end alone writes that day (never the UNTIL a period later); a choice string and a date-only UNTIL are as before', () => {
    const start = at('2026-10-13 10:00');
    const head = { rrule: 'FREQ=WEEKLY;UNTIL=20261027T095959', startsAt: start, timeZone: IL };
    assertSame(write.ruleToWrite({ freq: 'daily', interval: 1, until: '2026-10-20' }, head, start, IL, { at: start, first: true }), { rrule: 'FREQ=DAILY;UNTIL=20261020', hebrewRule: null, endGiven: true }, 'Daily on the head, end untouched');
    assertSame(write.ruleToWrite({ freq: 'weekly', interval: 1, byDay: ['TU', 'TH'], until: '2026-10-20' }, head, start, IL, { at: start, first: true }).rrule, 'FREQ=WEEKLY;BYDAY=TU,TH;UNTIL=20261020', 'a day added');
    const custom = { rrule: 'FREQ=WEEKLY;BYDAY=MO,TU;UNTIL=20261027T095959', startsAt: start, timeZone: IL };
    assertSame(write.ruleToWrite({ freq: 'weekly', interval: 1, byDay: ['TU'], until: '2026-10-26' }, custom, start, IL, { at: start, first: true }), { rrule: 'FREQ=WEEKLY;UNTIL=20261026', hebrewRule: null, endGiven: true }, 'a custom head left for Weekly (its last occurrence is the Monday)');
    assertSame(write.ruleToWrite('daily', head, start, IL, { at: start, first: true }), { rrule: 'FREQ=DAILY', hebrewRule: null, endGiven: false }, 'a choice string is the bot\'s carry');
    assertSame(write.ruleToWrite({ freq: 'daily', interval: 1, until: '2026-12-01' }, { ...head, rrule: 'FREQ=WEEKLY;UNTIL=20261201' }, start, IL, { at: start, first: true }).endGiven, false, 'a date-only UNTIL is its own day');
  });

  await check('classifyRule: YEARLY with a day of the month and no month expands monthly, so it is custom, not the yearly choice', () => {
    const start = at('2026-11-14 10:00');
    assertSame(rec.classifyRule('FREQ=YEARLY;BYMONTHDAY=14', start, IL).choice, 'custom', 'YEARLY;BYMONTHDAY');
    assertSame(rec.classifyRule('FREQ=YEARLY;BYMONTH=11;BYMONTHDAY=14', start, IL).choice, 'yearly', 'with its month');
    assertSame(rec.classifyRule('FREQ=YEARLY', start, IL).choice, 'yearly', 'plain');
  });

  await check('ruleToWrite: an unchanged end carries (no end in the rule, endGiven false); a changed one is the spec\'s, counted from the first occurrence on a later cut; Never removes it', () => {
    const start = at('2026-10-20 10:00');
    const stored = (rrule: string) => ({ rrule, startsAt: start, timeZone: IL });
    const cutAt = { at: at('2026-11-03 10:00'), first: false }; // two slots of a weekly series before it
    // Unchanged end: the rule without it.
    assertSame(write.ruleToWrite({ freq: 'daily', interval: 1, count: 6 }, stored('FREQ=WEEKLY;COUNT=6'), at('2026-11-03 10:00'), IL, cutAt), { rrule: 'FREQ=DAILY', hebrewRule: null, endGiven: false }, 'count unchanged');
    assertSame(write.ruleToWrite({ freq: 'daily', interval: 1, until: '2026-12-01' }, stored('FREQ=WEEKLY;UNTIL=20261201'), at('2026-11-03 10:00'), IL, cutAt).endGiven, false, 'until unchanged');
    assertSame(write.ruleToWrite('daily', stored('FREQ=WEEKLY;COUNT=6'), at('2026-11-03 10:00'), IL, cutAt), { rrule: 'FREQ=DAILY', hebrewRule: null, endGiven: false }, 'a string choice');
    // Changed count: n from the first occurrence, less the slots before the cut.
    assertSame(write.ruleToWrite({ freq: 'daily', interval: 1, count: 5 }, stored('FREQ=WEEKLY;COUNT=6'), at('2026-11-03 10:00'), IL, cutAt), { rrule: 'FREQ=DAILY;COUNT=3', hebrewRule: null, endGiven: true }, '5 in all, 2 gone');
    assertSame(write.ruleToWrite({ freq: 'daily', interval: 1, count: 2 }, stored('FREQ=WEEKLY;COUNT=6'), at('2026-11-03 10:00'), IL, cutAt).rrule, 'FREQ=DAILY;COUNT=1', 'at least 1');
    assertSame(write.ruleToWrite({ freq: 'daily', interval: 1, count: 5 }, stored('FREQ=WEEKLY;COUNT=6'), start, IL, { at: start, first: true }).rrule, 'FREQ=DAILY;COUNT=5', 'from the first occurrence it is the whole count');
    assertSame(write.ruleToWrite({ freq: 'daily', interval: 1, count: 5 }, stored('FREQ=WEEKLY'), at('2026-11-03 10:00'), IL, cutAt).rrule, 'FREQ=DAILY;COUNT=3', 'a count added to an endless series');
    assertSame(write.ruleToWrite({ freq: 'daily', interval: 1, count: 5 }, null, start, IL, null).rrule, 'FREQ=DAILY;COUNT=5', 'a one-off becoming a repeat');
    // Changed until, and Never.
    assertSame(write.ruleToWrite({ freq: 'daily', interval: 1, until: '2026-12-15' }, stored('FREQ=WEEKLY;COUNT=6'), at('2026-11-03 10:00'), IL, cutAt), { rrule: 'FREQ=DAILY;UNTIL=20261215', hebrewRule: null, endGiven: true }, 'until');
    assertSame(write.ruleToWrite({ freq: 'daily', interval: 1 }, stored('FREQ=WEEKLY;UNTIL=20261231'), at('2026-11-03 10:00'), IL, cutAt), { rrule: 'FREQ=DAILY', hebrewRule: null, endGiven: true }, 'Never on a stored end removes it');
    // A Hebrew series' slots before the cut are its Hebrew ones.
    const heb = { rrule: 'FREQ=YEARLY;COUNT=5', startsAt: at('2025-01-24 10:00'), timeZone: IL, hebrewRule: 'anniversary', hebrewAnchor: '2025-01-24' };
    const slots = rec.expandSeries(seriesOf(heb.rrule, heb.startsAt, { hebrewRule: 'anniversary', hebrewAnchor: '2025-01-24' }), { from: heb.startsAt, to: at('2031-01-01 00:00') }, []).map((i) => i.startsAt);
    assertSame(slots.length, 5, 'five Hebrew slots');
    const hebCut = { at: slots[2], first: false };
    assertSame(write.ruleToWrite({ freq: 'hebrew', interval: 1, count: 4 }, heb, slots[2], IL, hebCut).rrule, 'FREQ=YEARLY;COUNT=2', 'Hebrew: two slots before the cut, 4 in all');
  });

  await check('parseCreate and parseUpdate: repeat takes the old string or a spec; anything else is field repeat; a spec sets the year floor', () => {
    const create = (repeat: unknown, over: Record<string, unknown> = {}) =>
      validate.parseCreate({ kind: 'event', title: 'x', allDay: false, start: '2026-10-20T10:00', end: '2026-10-20T11:00', repeat, ...over });
    const spec: Spec = { freq: 'weekly', interval: 2, byDay: ['TU', 'TH'], until: '2026-12-31' };
    const parsed = create(spec);
    assertSame(parsed.ok && parsed.value.repeat, spec, 'a spec');
    assertSame(create('weekly').ok && (create('weekly') as { value: { repeat: unknown } }).value.repeat, 'weekly', 'a string');
    assertSame((create(undefined) as { value: { repeat: unknown } }).value.repeat, 'none', 'default');
    for (const bad of ['hourly', 'custom', 7, true, {}, { freq: 'daily' }, { freq: 'daily', interval: 0 }, { freq: 'daily', interval: 1, count: 1000 }, { freq: 'daily', interval: 1, until: '2026-02-30' }, { freq: 'daily', interval: 1, until: '2026-10-20', count: 2 }, { freq: 'monthly', interval: 1, byDay: ['MO'] }, { freq: 'weekly', interval: 1, byDay: [] }, { freq: 'daily', interval: 1, x: 1 }]) {
      assertSame(create(bad), { ok: false, field: 'repeat' }, `create ${show(bad)}`);
    }
    // The floor: a yearly spec may start in 1950, a daily one may not.
    assert(create({ freq: 'yearly', interval: 1 }, { start: '1950-03-02T10:00', end: '1950-03-02T11:00' }).ok, 'yearly spec from 1950');
    assertSame(create({ freq: 'hebrew', interval: 1 }, { start: '1950-03-02T10:00', end: '1950-03-02T11:00' }).ok, true, 'hebrew spec from 1950');
    assertSame(create({ freq: 'daily', interval: 1 }, { start: '1950-03-02T10:00', end: '1950-03-02T11:00' }), { ok: false, field: 'start' }, 'daily spec from 1950');
    const update = (repeat: unknown) => validate.parseUpdate({ key: 'famcal|abc#2026-10-20T07:00:00.000Z', scope: 'following', changes: { repeat } });
    const u = update(spec);
    assertSame(u.ok && u.value.changes.repeat, spec, 'update: a spec');
    assertSame(update('daily').ok && (update('daily') as { value: { changes: { repeat: unknown } } }).value.changes.repeat, 'daily', 'update: a string');
    assertSame(update('none').ok, true, 'update: none');
    for (const bad of ['hourly', 3, { freq: 'daily', interval: 100 }, { freq: 'weekly', interval: 1, monthly: 'day' }, null]) {
      assertSame(update(bad), { ok: false, field: 'repeat' }, `update ${show(bad)}`);
    }
    assertSame([validate.isHebrewChoice('hebrew'), validate.isHebrewChoice({ freq: 'hebrew', interval: 1 }), validate.isHebrewChoice({ freq: 'yearly', interval: 1 }), validate.isHebrewChoice('yearly'), validate.isHebrewChoice(undefined)], [true, true, false, false, false], 'isHebrewChoice');
  });

  await check('minYearFor: a spec reads by its freq (yearly and hebrew 1900, the rest 2000); the choices as before', async () => {
    const { minYearFor } = await import('../src/lib/calendar-view/year-limits');
    assertSame(['yearly', 'hebrew', 'daily', 'weekly', 'monthly'].map((freq) => minYearFor({ freq: freq as Spec['freq'], interval: 1 })), [1900, 1900, 2000, 2000, 2000], 'specs');
    assertSame([minYearFor('none'), minYearFor('yearly'), minYearFor('custom'), minYearFor(undefined)], [1900, 1900, 2000, 1900], 'choices');
  });

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(r.ok ? `OK   ${r.name}` : `FAIL ${r.name}\n     ${r.reason}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

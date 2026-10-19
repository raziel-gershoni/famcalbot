// Pure-function smoke test for Hebrew-date repeats (docs/superpowers/specs/2026-10-19-hebrew-repeats-design.md
// §2, §3, §6): the Hebrew expander in src/services/native-calendar/recurrence.ts and the
// rule helpers that branch on NativeEvent.hebrewRule / hebrewAnchor.
//
// A Hebrew series is a plain FREQ=YEARLY rule next to the pair (hebrewRule: 'anniversary' |
// 'yahrzeit', hebrewAnchor: the anchor's civil date in the series' zone). Its days come from
// hebcal: getBirthdayOrAnniversary for 'anniversary', getYahrzeit for 'yahrzeit'. The
// expected dates below were read off hebcal 0.21.1 by hand (scratchpad hr/probe/p.cjs), so a
// change in the library's rules, or in how the expander calls it, shows here.
//
// No DB, no network. Run under these server clocks; the output must not depend on them:
//   TZ=UTC npx tsx scripts/smoke-hebrew-repeats.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-hebrew-repeats.ts
//   TZ=Pacific/Kiritimati npx tsx scripts/smoke-hebrew-repeats.ts
//   TZ=America/Los_Angeles npx tsx scripts/smoke-hebrew-repeats.ts

import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { HDate, getYahrzeit } from '@hebcal/hdate';
import type { NativeEvent, NativeEventInstance } from '@prisma/client';
import * as rec from '../src/services/native-calendar/recurrence';

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

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

const show = (value: unknown) => JSON.stringify(value);
function assertSame(got: unknown, want: unknown, label: string) {
  assert(show(got) === show(want), `${label}\n     got  ${show(got)}\n     want ${show(want)}`);
}

const IL = 'Asia/Jerusalem';
const LA = 'America/Los_Angeles';
const KIRITIMATI = 'Pacific/Kiritimati';

/** A wall-clock time in `tz` as an instant. */
const at = (local: string, tz = IL) => fromZonedTime(`${local}:00`, tz);
const dayIn = (d: Date, tz = IL) => formatInTimeZone(d, tz, 'yyyy-MM-dd');
const wallIn = (d: Date, tz = IL) => formatInTimeZone(d, tz, 'yyyy-MM-dd HH:mm');

type Kind = 'anniversary' | 'yahrzeit';

/** A Hebrew series as the store writes it: FREQ=YEARLY, the pair, the anchor its start's date in its zone. */
function hebrew(kind: Kind, start: Date, o: Partial<NativeEvent> = {}): NativeEvent {
  const tz = (o.timeZone as string | undefined) ?? IL;
  return {
    id: 'heb-1',
    calendarId: 'cal-1',
    creatorUserId: 1,
    title: 'Birthday',
    description: null,
    location: null,
    startsAt: start,
    endsAt: new Date(start.getTime() + 60 * 60 * 1000),
    allDay: false,
    timeZone: tz,
    rrule: 'FREQ=YEARLY',
    hebrewRule: kind,
    hebrewAnchor: dayIn(start, tz),
    exdates: [],
    reminderMinutes: null,
    kind: 'EVENT',
    forUserId: null,
    armedAt: null,
    isDeleted: false,
    createdAt: start,
    updatedAt: start,
    ...o,
  };
}

function override(seriesId: string, originalStartsAt: Date, fields: Partial<NativeEventInstance> = {}): NativeEventInstance {
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

/** The days a series falls on (in its zone) between two civil dates there. */
function days(series: NativeEvent, from: string, to: string, overrides: NativeEventInstance[] = []): string[] {
  const tz = series.timeZone;
  return rec.expandSeries(series, { from: at(`${from} 00:00`, tz), to: at(`${to} 00:00`, tz) }, overrides).map((i) => dayIn(i.startsAt, tz));
}

/** The civil date of a Date at local midnight (what hebcal returns), from its local getters. */
const civil = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const thrown = (fn: () => unknown): unknown => {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
};

function main() {
  // ================= §1's table, both kinds =================

  check('table: 30 Cheshvan (5783) in a year without it: anniversary on 1 Kislev, yahrzeit on 29 Cheshvan (its first anniversary year lacked the 30th)', () => {
    const start = at('2022-11-24 10:00'); // 30 Cheshvan 5783
    assertSame(days(hebrew('anniversary', start), '2022-01-01', '2029-01-01'),
      ['2022-11-24', '2023-11-14', '2024-12-01', '2025-11-21', '2026-11-10', '2027-11-30', '2028-11-19'], 'anniversary');
    assertSame(days(hebrew('yahrzeit', start), '2022-01-01', '2029-01-01'),
      ['2022-11-24', '2023-11-13', '2024-12-01', '2025-11-20', '2026-11-10', '2027-11-30', '2028-11-18'], 'yahrzeit');
  });

  check('table: 30 Cheshvan (5787) whose first anniversary year has the 30th: the yahrzeit moves to 1 Kislev where it is missing, like the anniversary', () => {
    const start = at('2026-11-10 10:00'); // 30 Cheshvan 5787
    assertSame(days(hebrew('yahrzeit', start), '2026-01-01', '2030-01-01'), ['2026-11-10', '2027-11-30', '2028-11-19', '2029-11-08'], 'yahrzeit');
    assertSame(days(hebrew('anniversary', start), '2026-01-01', '2030-01-01'), ['2026-11-10', '2027-11-30', '2028-11-19', '2029-11-08'], 'anniversary');
  });

  check('table: 30 Kislev (5783) in a year without it: anniversary on 1 Tevet, yahrzeit on 29 Kislev', () => {
    const start = at('2022-12-24 10:00'); // 30 Kislev 5783
    assertSame(days(hebrew('anniversary', start), '2023-06-01', '2024-06-01'), ['2023-12-13'], 'anniversary 5784');
    assertSame(days(hebrew('yahrzeit', start), '2023-06-01', '2024-06-01'), ['2023-12-12'], 'yahrzeit 5784');
  });

  check('table: Adar in a common year (15 Adar 5785) read in a leap year: anniversary in Adar II, yahrzeit in Adar I', () => {
    const start = at('2025-03-15 10:00');
    assertSame(days(hebrew('anniversary', start), '2026-06-01', '2027-06-01'), ['2027-03-24'], 'anniversary 5787');
    assertSame(days(hebrew('yahrzeit', start), '2026-06-01', '2027-06-01'), ['2027-02-22'], 'yahrzeit 5787');
    assertSame(days(hebrew('anniversary', start), '2025-06-01', '2026-06-01'), ['2026-03-04'], 'a common year is plain Adar for both');
    assertSame(days(hebrew('yahrzeit', start), '2025-06-01', '2026-06-01'), ['2026-03-04'], 'yahrzeit 5786');
  });

  check('table: 30 Adar I (5784) in a common year: anniversary on 1 Nisan, yahrzeit on 30 Shvat; a leap year keeps 30 Adar I for both', () => {
    const start = at('2024-03-10 10:00');
    assertSame(days(hebrew('anniversary', start), '2024-06-01', '2027-06-01'), ['2025-03-30', '2026-03-19', '2027-03-09'], 'anniversary');
    assertSame(days(hebrew('yahrzeit', start), '2024-06-01', '2027-06-01'), ['2025-02-28', '2026-02-17', '2027-03-09'], 'yahrzeit');
  });

  // ================= the anchor year =================

  check('anchor year: the start is the first occurrence for both kinds (hebcal gives nothing for a yahrzeit there), keyed by the start itself', () => {
    for (const kind of ['anniversary', 'yahrzeit'] as const) {
      const s = hebrew(kind, at('2024-03-10 10:00'));
      const [first] = rec.expandSeries(s, { from: at('2024-03-01 00:00'), to: at('2024-04-01 00:00') });
      assert(first, `${kind}: no occurrence at the start`);
      assert(first.instanceStartsAt.getTime() === s.startsAt.getTime() && first.startsAt.getTime() === s.startsAt.getTime(), `${kind}: keyed ${first.instanceStartsAt.toISOString()}`);
      assertSame(rec.hebrewCandidates({ ...s, rrule: s.rrule!, hebrewRule: kind, hebrewAnchor: s.hebrewAnchor! }, { from: at('2024-03-01 00:00'), to: at('2024-04-01 00:00') })
        .filter((d) => d >= at('2024-03-01 00:00') && d < at('2024-04-01 00:00')).map((d) => d.toISOString()), [s.startsAt.toISOString()], `${kind}: candidates`);
    }
  });

  check('anchor year: a past date of death is a past occurrence, and nothing comes before it', () => {
    const s = hebrew('yahrzeit', at('2024-03-10 10:00'));
    assertSame(days(s, '2020-01-01', '2024-03-10'), [], 'before the start');
    const latest = rec.latestOccurrenceBefore(s, [], at('2024-12-01 00:00'));
    assert(latest && latest.startsAt.getTime() === s.startsAt.getTime(), `latest before ${latest?.startsAt.toISOString()}`);
  });

  // ================= INTERVAL, COUNT, UNTIL =================

  const shvat = at('2026-02-02 10:00'); // 15 Shvat 5786

  check('INTERVAL=2: every other Hebrew year from the anchor (5786, 5788, 5790)', () => {
    assertSame(days(hebrew('anniversary', shvat, { rrule: 'FREQ=YEARLY;INTERVAL=2' }), '2026-01-01', '2031-01-01'), ['2026-02-02', '2028-02-12', '2030-01-19'], 'interval 2');
  });

  check('COUNT=3: the anchor and the next two, then none', () => {
    assertSame(days(hebrew('anniversary', shvat, { rrule: 'FREQ=YEARLY;COUNT=3' }), '2026-01-01', '2035-01-01'), ['2026-02-02', '2027-01-23', '2028-02-12'], 'count 3');
    assertSame(days(hebrew('yahrzeit', shvat, { rrule: 'FREQ=YEARLY;INTERVAL=2;COUNT=2' }), '2026-01-01', '2035-01-01'), ['2026-02-02', '2028-02-12'], 'count 2, interval 2');
  });

  check('COUNT, a window 20 years from the start: the 21st occurrence (5806) is there, the 22nd (5807) is not', () => {
    const s = hebrew('anniversary', shvat, { rrule: 'FREQ=YEARLY;COUNT=21' });
    const want5806 = civil(new HDate(15, 11, 5806).greg());
    const want5807 = civil(new HDate(15, 11, 5807).greg());
    const y5806 = Number(want5806.slice(0, 4));
    assertSame(days(s, `${y5806}-01-01`, `${y5806 + 1}-01-01`).filter((d) => d === want5806), [want5806], 'the 21st');
    assertSame(days(s, want5807, `${Number(want5807.slice(0, 4)) + 1}-12-31`), [], 'no 22nd');
    assertSame(rec.slotsBefore(s, at(`${want5806} 10:00`)), 20, 'twenty slots before the 21st');
    assertSame([...rec.yieldsSlots(s, [at(`${want5806} 10:00`), at(`${want5807} 10:00`), at('2046-02-02 10:00')])].map((t) => dayIn(new Date(t))), [want5806], 'yieldsSlots far from the start');
  });

  check('UNTIL: a date-only UNTIL reads as the end of that day; a date-time, with a Z or without, as a wall time', () => {
    const s = (rrule: string) => days(hebrew('anniversary', shvat, { rrule }), '2026-01-01', '2035-01-01');
    assertSame(s('FREQ=YEARLY;UNTIL=20280212'), ['2026-02-02', '2027-01-23', '2028-02-12'], 'date-only on the day');
    assertSame(s('FREQ=YEARLY;UNTIL=20280211'), ['2026-02-02', '2027-01-23'], 'date-only the day before');
    assertSame(s('FREQ=YEARLY;UNTIL=20280212T095959'), ['2026-02-02', '2027-01-23'], 'a cut one second before 10:00 (truncateRruleBefore)');
    assertSame(s('FREQ=YEARLY;UNTIL=20280212T100000'), ['2026-02-02', '2027-01-23', '2028-02-12'], 'a wall time at 10:00');
    // 10:00 in Israel is 08:00Z: read as an instant, 09:00Z would keep the occurrence.
    assertSame(s('FREQ=YEARLY;UNTIL=20280212T090000Z'), ['2026-02-02', '2027-01-23'], 'a Z stamp read as wall time');
  });

  check('truncateRruleBefore and shiftUntil keep a Hebrew rule a plain yearly rule its expansion reads', () => {
    const s = hebrew('anniversary', shvat);
    const cut = rec.truncateRruleBefore(s.rrule!, at('2028-02-12 10:00'), IL);
    assertSame(cut, 'FREQ=YEARLY;UNTIL=20280212T095959', 'the cut rule');
    assertSame(days({ ...s, rrule: cut }, '2026-01-01', '2035-01-01'), ['2026-02-02', '2027-01-23'], 'the cut series');
  });

  // ================= overrides, exdates =================

  check('an exdate and an override on Hebrew occurrences apply as on any series; an override moved far is still found', () => {
    const s = hebrew('anniversary', shvat, { exdates: [at('2027-01-23 10:00')] });
    const moved = override(s.id, at('2028-02-12 10:00'), { title: 'Party', startsAt: at('2028-02-13 18:00'), endsAt: at('2028-02-13 20:00') });
    const got = rec.expandSeries(s, { from: at('2026-01-01 00:00'), to: at('2030-01-01 00:00') }, [moved]);
    assertSame(got.map((i) => `${wallIn(i.startsAt)} ${i.title}`), ['2026-02-02 10:00 Birthday', '2028-02-13 18:00 Party', '2029-01-31 10:00 Birthday'], 'expanded');
    assertSame(got.map((i) => i.instanceStartsAt.toISOString()), [at('2026-02-02 10:00'), at('2028-02-12 10:00'), at('2029-01-31 10:00')].map((d) => d.toISOString()), 'keys are the slots');
    const far = override(s.id, at('2029-01-31 10:00'), { startsAt: at('2033-05-01 10:00'), endsAt: at('2033-05-01 11:00') });
    const window = rec.expandSeries(s, { from: at('2033-04-30 00:00'), to: at('2033-05-02 00:00') }, [far]);
    assertSame(window.map((i) => `${wallIn(i.startsAt)} ${i.instanceStartsAt.toISOString()}`), [`2033-05-01 10:00 ${at('2029-01-31 10:00').toISOString()}`], 'the orphan override');
  });

  // ================= the mutation regression (getYahrzeit mutates its argument) =================

  check('one expansion over 24 years equals per-year expansions and per-year hebcal calls on a fresh date (10 Adar II 5782)', () => {
    const start = at('2022-03-13 10:00'); // 10 Adar II 5782
    assertSame(new HDate(new Date(2022, 2, 13)).toString(), '10 Adar II 5782', 'the anchor');
    for (const kind of ['yahrzeit', 'anniversary'] as const) {
      const s = hebrew(kind, start);
      const all = days(s, '2022-01-01', '2046-01-01');
      const each: string[] = [];
      for (let y = 2022; y < 2046; y++) each.push(...days(s, `${y}-01-01`, `${y + 1}-01-01`));
      assertSame(all, each, `${kind}: one expansion against per-year ones`);
      if (kind === 'yahrzeit') {
        const fresh = ['2022-03-13'];
        for (let hy = 5783; hy <= 5805; hy++) fresh.push(civil(getYahrzeit(hy, { yy: 5782, mm: 13, dd: 10 })!));
        assertSame(all, fresh.filter((d) => d < '2046-01-01'), 'against hebcal on a fresh date each year');
      }
      assert(all.length >= 23, `${kind}: ${all.length} occurrences`);
    }
  });

  // ================= zones =================

  check('the anchor is read in the event\'s zone: 23:30Z on 1 Feb is 15 Shvat in Israel and 14 Shvat in UTC; the wall time stays', () => {
    const instant = new Date('2026-02-01T23:30:00Z');
    const il = hebrew('anniversary', instant, { timeZone: IL });
    assertSame(il.hebrewAnchor, '2026-02-02', 'anchor in Israel');
    assertSame(rec.expandSeries(il, { from: at('2026-06-01 00:00'), to: at('2027-06-01 00:00') }).map((i) => wallIn(i.startsAt, IL)), ['2027-01-23 01:30'], 'Israel: 15 Shvat 5787 at 01:30');
    const utc = hebrew('anniversary', instant, { timeZone: 'UTC' });
    assertSame(utc.hebrewAnchor, '2026-02-01', 'anchor in UTC');
    assertSame(rec.expandSeries(utc, { from: at('2026-06-01 00:00', 'UTC'), to: at('2027-06-01 00:00', 'UTC') }).map((i) => wallIn(i.startsAt, 'UTC')), [`${civil(new HDate(14, 11, 5787).greg())} 23:30`], 'UTC: 14 Shvat 5787 at 23:30');
  });

  check('the wall time holds across DST: 10:00 in Israel\'s winter is 10:00 on a summer-time 1 Nisan; Los Angeles and Kiritimati too', () => {
    const s = hebrew('anniversary', at('2024-03-10 10:00')); // 30 Adar I, winter
    const nisan = rec.expandSeries(s, { from: at('2025-03-01 00:00'), to: at('2025-04-30 00:00') });
    assertSame(nisan.map((i) => wallIn(i.startsAt)), ['2025-03-30 10:00'], 'Israel, after the spring change');
    for (const tz of [LA, KIRITIMATI]) {
      const z = hebrew('anniversary', at('2026-02-02 09:00', tz), { timeZone: tz });
      assertSame(rec.expandSeries(z, { from: at('2026-01-01 00:00', tz), to: at('2028-12-31 00:00', tz) }).map((i) => wallIn(i.startsAt, tz)),
        ['2026-02-02 09:00', '2027-01-23 09:00', '2028-02-12 09:00'], tz);
    }
  });

  check('an all-day Hebrew series keeps its day span (00:00 to 23:59 local) in every year', () => {
    const start = at('2026-02-02 00:00');
    const s = hebrew('anniversary', start, { allDay: true, endsAt: at('2026-02-02 23:59') });
    assertSame(rec.expandSeries(s, { from: at('2027-01-01 00:00'), to: at('2027-12-31 00:00') }).map((i) => `${wallIn(i.startsAt)}-${wallIn(i.endsAt)}`), ['2027-01-23 00:00-2027-01-23 23:59'], 'all day');
  });

  // ================= a tail whose anchor year precedes its start =================

  check('a tail keeps its anchor: started on a rolled 1 Kislev 5786, it still falls on 30 Cheshvan in long years; nothing before its start', () => {
    const s = hebrew('anniversary', at('2025-11-21 10:00'), { hebrewAnchor: '2022-11-24' });
    assertSame(days(s, '2020-01-01', '2029-01-01'), ['2025-11-21', '2026-11-10', '2027-11-30', '2028-11-19'], 'the tail');
    assertSame(days({ ...s, rrule: 'FREQ=YEARLY;COUNT=2' }, '2020-01-01', '2029-01-01'), ['2025-11-21', '2026-11-10'], 'its COUNT counts from its start');
    assertSame(rec.slotsBefore({ ...s, rrule: 'FREQ=YEARLY;COUNT=3' }, at('2027-11-30 10:00')), 2, 'slots before, from its start');
  });

  // ================= the helpers =================

  check('latestOccurrenceBefore spans the longest gap, 385 days (30 Adar I 5787 to 1 Nisan 5788)', () => {
    const s = hebrew('anniversary', at('2024-03-10 10:00'));
    const latest = rec.latestOccurrenceBefore(s, [], at('2028-03-28 09:00'));
    assert(latest && wallIn(latest.startsAt) === '2027-03-09 10:00', `latest ${latest && wallIn(latest.startsAt)}`);
  });

  check('fixesDays is false for a Hebrew rule; classifyRule names the kind, with INTERVAL 1 or absent, and an end as its last occurrence', () => {
    const s = hebrew('anniversary', shvat);
    assertSame(rec.fixesDays(s.rrule), false, 'fixesDays');
    const cls = (rrule: string, kind: Kind) => rec.classifyRule(rrule, shvat, IL, { hebrewRule: kind, hebrewAnchor: '2026-02-02' });
    assertSame(cls('FREQ=YEARLY', 'anniversary'), { choice: 'hebrew' }, 'anniversary');
    assertSame(cls('FREQ=YEARLY', 'yahrzeit'), { choice: 'yahrzeit' }, 'yahrzeit');
    assertSame(cls('FREQ=YEARLY;INTERVAL=1', 'anniversary'), { choice: 'hebrew' }, 'INTERVAL=1');
    assertSame(cls('FREQ=YEARLY;INTERVAL=2', 'anniversary'), { choice: 'custom' }, 'INTERVAL=2 is custom');
    assertSame(cls('FREQ=YEARLY;COUNT=3', 'yahrzeit'), { choice: 'yahrzeit', until: at('2028-02-12 10:00') }, 'a COUNT\'s last occurrence');
    assertSame(cls('FREQ=YEARLY;UNTIL=20290101', 'anniversary'), { choice: 'hebrew', until: at('2028-02-12 10:00') }, 'an UNTIL\'s last occurrence');
    assertSame(cls('FREQ=YEARLY;INTERVAL=2;COUNT=2', 'anniversary'), { choice: 'custom', until: at('2028-02-12 10:00') }, 'custom with an end');
    assertSame(rec.classifyRule('FREQ=YEARLY', shvat, IL), { choice: 'yearly' }, 'without the pair it is Gregorian yearly');
    assertSame(rec.classifyRule('FREQ=YEARLY', shvat, IL, { hebrewRule: null, hebrewAnchor: null }), { choice: 'yearly' }, 'with a null pair too');
  });

  check('slotsBefore counts Hebrew slots, exdates included', () => {
    const s = hebrew('anniversary', shvat, { exdates: [at('2027-01-23 10:00')] });
    assertSame([rec.slotsBefore(s, at('2028-02-12 10:00')), rec.slotsBefore(s, shvat), rec.slotsBefore(s, at('2027-06-01 10:00'))], [2, 0, 2], 'slots before');
  });

  check('yieldsSlots: a Hebrew series yields its Hebrew days, not the Gregorian anniversary of its start', () => {
    const s = hebrew('anniversary', shvat);
    const yields = rec.yieldsSlots(s, [at('2027-01-23 10:00'), at('2027-02-02 10:00')]);
    assertSame([...yields].map((t) => dayIn(new Date(t))), ['2027-01-23'], 'yields');
  });

  check('endCarriedRule: a COUNT on a Hebrew rule becomes the UNTIL of its last Hebrew occurrence', () => {
    const series = { startsAt: shvat, timeZone: IL, hebrewRule: 'anniversary', hebrewAnchor: '2026-02-02' };
    assertSame(rec.endCarriedRule('FREQ=WEEKLY', 'FREQ=YEARLY;COUNT=3', series), 'FREQ=WEEKLY;UNTIL=20280212', 'the last Hebrew one, 15 Shvat 5788');
  });

  // ================= assertStorableRule both ways =================

  check('assertStorableRule: a Hebrew rule is FREQ=YEARLY with at most INTERVAL, UNTIL or COUNT; a pair needs a rule', () => {
    const ok: Array<[string | null, Kind | null | undefined]> = [
      ['FREQ=YEARLY', 'anniversary'],
      ['FREQ=YEARLY;INTERVAL=2;COUNT=3', 'yahrzeit'],
      ['FREQ=YEARLY;UNTIL=20300101', 'anniversary'],
      ['FREQ=YEARLY;UNTIL=20300101T095959', 'yahrzeit'],
      ['RRULE:FREQ=YEARLY', 'anniversary'],
      ['FREQ=WEEKLY;BYDAY=TU', null],
      ['FREQ=MONTHLY', undefined],
      [null, null],
      [null, undefined],
    ];
    for (const [rule, kind] of ok) {
      const e = thrown(() => rec.assertStorableRule(rule, kind));
      assert(e === undefined, `${rule} ${kind}: refused ${e instanceof Error ? e.message : e}`);
    }
    const bad: Array<[string | null, string]> = [
      ['FREQ=MONTHLY', 'anniversary'],
      ['FREQ=WEEKLY', 'yahrzeit'],
      ['FREQ=YEARLY;BYMONTH=3', 'anniversary'],
      ['FREQ=YEARLY;BYMONTHDAY=3', 'yahrzeit'],
      ['FREQ=YEARLY;BYDAY=MO', 'anniversary'],
      ['FREQ=YEARLY;WKST=MO', 'anniversary'],
      ['FREQ=YEARLY;INTERVAL=0', 'anniversary'],
      ['FREQ=YEARLY', 'monthly'],
      ['FREQ=YEARLY', ''],
      [null, 'anniversary'],
      [null, 'yahrzeit'],
    ];
    for (const [rule, kind] of bad) {
      const e = thrown(() => rec.assertStorableRule(rule, kind as Kind));
      assert(e instanceof rec.NativeRuleError, `${rule} ${kind}: ${e === undefined ? 'kept' : String(e)}`);
    }
  });

  check('a stored Hebrew series with a kind or anchor the app cannot read throws NativeRuleError on expansion (the read guards log it)', () => {
    for (const o of [{ hebrewRule: 'monthly' }, { hebrewAnchor: null }, { hebrewAnchor: '2026-13-40' }] as Partial<NativeEvent>[]) {
      const e = thrown(() => rec.expandSeries(hebrew('anniversary', shvat, o), { from: at('2026-01-01 00:00'), to: at('2028-01-01 00:00') }));
      assert(e instanceof rec.NativeRuleError, `${show(o)}: ${e === undefined ? 'expanded' : String(e)}`);
    }
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();

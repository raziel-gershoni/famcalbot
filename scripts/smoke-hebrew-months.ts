// Smoke test for the Hebrew month keys in the Month's arithmetic (release 3, Task 1):
// src/lib/calendar-view/hebrew-months.ts, month-mode.ts and grid.ts's dispatch.
//
// Pure: no database, Redis, network or AI. Run it under other clocks too:
//   TZ=America/Los_Angeles npx tsx scripts/smoke-hebrew-months.ts

import fs from 'fs';
import path from 'path';
import {
  addMonths,
  defaultSpan,
  growSpan,
  inSpan,
  monthFirstDay,
  monthGrid,
  monthLastDay,
  monthModeOf,
  monthOf,
  monthOrdinal,
  monthReach,
  monthWindow,
  spanMonths,
  spanToShow,
} from '../src/lib/calendar-view/grid';
import { hebrewMonthAt, hebrewMonthDays, hebrewMonthKeyOf, hebrewMonthOrdinal, isHebrewMonthKey } from '../src/lib/calendar-view/hebrew-months';
import { isMonthMode } from '../src/lib/calendar-view/month-mode';

const ROOT = path.resolve(__dirname, '..');

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

function assertEqual<T>(got: T, want: T, label: string) {
  assert(JSON.stringify(got) === JSON.stringify(want), `${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

async function main() {
  await check('H1 keys', () => {
    assertEqual(hebrewMonthKeyOf('2026-11-27'), 'h5787-03', '2026-11-27');
    assertEqual(hebrewMonthKeyOf('1900-01-01'), 'h5660-05', '1900-01-01');
    assertEqual(hebrewMonthKeyOf('2100-12-31'), 'h5861-03', '2100-12-31');
    assert(!isHebrewMonthKey('h5786-13'), '5786 is common');
    assert(isHebrewMonthKey('h5787-13'), '5787 is leap');
    assert(!isHebrewMonthKey('2026-11'), 'a civil key');
    assert(!isHebrewMonthKey('h5787-00'), 'place 0');
    assertEqual(hebrewMonthKeyOf('2026-02-30'), '', 'a bad day');
  });

  await check('H2 days', () => {
    assertEqual([monthFirstDay('h5787-03'), monthLastDay('h5787-03')], ['2026-11-11', '2026-12-10'], 'Kislev 5787');
    assertEqual(monthFirstDay('h5787-06'), '2027-02-08', 'Adar I 5787');
    const adarII = hebrewMonthDays('h5787-07');
    assertEqual(adarII?.first, '2027-03-10', 'Adar II starts');
    assertEqual(adarII?.last, '2027-04-07', 'Adar II ends (29 days)');
    assertEqual(monthWindow('h5787-03'), { from: '2026-11-11', to: '2026-12-11' }, 'window');
    const rows = monthGrid('h5787-03', 0);
    assertEqual([rows.length, rows[0][0]], [5, '2026-11-08'], 'grid');
    assertEqual(hebrewMonthDays('2026-11'), null, 'not a Hebrew key');
  });

  await check('H3 steps', () => {
    const steps: [string, number, string][] = [
      ['h5787-05', 1, 'h5787-06'],
      ['h5787-07', 1, 'h5787-08'],
      ['h5786-05', 1, 'h5786-06'],
      ['h5786-06', 1, 'h5786-07'],
      ['h5787-13', 1, 'h5788-01'],
      ['h5788-01', -1, 'h5787-13'],
    ];
    for (const [k, n, want] of steps) assertEqual(addMonths(k, n), want, `addMonths(${k}, ${n})`);
    assertEqual(addMonths('h5787-05', 1.5), '', 'fractional');
    const reach = monthReach('hebrew');
    let key = reach.first;
    let count = 0;
    while (true) {
      const ord = hebrewMonthOrdinal(key);
      assert(ord !== null && hebrewMonthAt(ord) === key, `ordinal round trip of ${key}`);
      assert(monthOrdinal(key) === ord, `monthOrdinal of ${key}`);
      assert(monthOf(monthFirstDay(key), 'hebrew') === key, `monthOf(first day) of ${key}`);
      assert(monthOf(monthLastDay(key), 'hebrew') === key, `monthOf(last day) of ${key}`);
      count++;
      if (key === reach.last) break;
      const next = addMonths(key, 1);
      assert(hebrewMonthOrdinal(next) === (ord as number) + 1, `${next} follows ${key}`);
      assert(monthFirstDay(next) === dayAfter(monthLastDay(key)) || monthFirstDay(next) === monthFirstDay(key), `${next} starts the day after ${key}`);
      key = next;
    }
    assert(count > 2400 && count < 2500, `${count} months in the reach`);
  });

  await check('H4 mode', () => {
    assertEqual(monthOf('2026-11-27'), '2026-11', 'gregorian default');
    assertEqual(monthOf('2026-11-27', 'hebrew'), 'h5787-03', 'hebrew');
    assertEqual([monthModeOf('h5787-03'), monthModeOf('2026-11')], ['hebrew', 'gregorian'], 'monthModeOf');
    assert(isMonthMode('hebrew') && isMonthMode('gregorian') && !isMonthMode('Hebrew') && !isMonthMode(null), 'isMonthMode');
  });

  await check('H5 reach', () => {
    assertEqual(monthReach('hebrew'), { first: 'h5660-05', last: 'h5861-03' }, 'hebrew reach');
    assertEqual(monthReach('gregorian'), { first: '1900-01', last: '2100-12' }, 'gregorian reach');
    assertEqual(monthLastDay('h5861-03'), '2100-12-31', 'cut at the end');
    assertEqual(monthFirstDay('h5660-05'), '1900-01-01', 'cut at the start');
    assertEqual(monthWindow('h5861-03').to, '2101-01-01', 'window end');
    // Final review M-2: a Hebrew month wholly outside the reach has no days, never a backwards window.
    for (const k of ['h5861-04', 'h5660-04', 'h5900-01', 'h5600-01']) {
      assertEqual([monthFirstDay(k), monthLastDay(k)], ['', ''], `${k} has no days in the reach`);
      assertEqual(monthWindow(k), { from: '', to: '' }, `${k} has no window`);
    }
    const reach = monthReach('hebrew');
    const ord = (k: string) => hebrewMonthOrdinal(k) as number;
    const inside = (k: string) => ord(k) >= ord(reach.first) && ord(k) <= ord(reach.last);
    const atEnd = { first: addMonths(reach.last, -20), last: reach.last };
    assertEqual(growSpan(atEnd, 'after'), atEnd, 'cannot grow past the end');
    const atStart = { first: reach.first, last: addMonths(reach.first, 20) };
    assertEqual(growSpan(atStart, 'before'), atStart, 'cannot grow before the start');
    const grown = growSpan({ first: addMonths(reach.last, -20), last: addMonths(reach.last, -5) }, 'after');
    assert(inside(grown.first) && inside(grown.last), 'growSpan stays inside');
    for (const month of [addMonths(reach.last, 40), addMonths(reach.first, -40)]) {
      const s = spanToShow(atEnd, month);
      assert(inside(s.first) && inside(s.last), `spanToShow(${month}) stays inside`);
    }
  });

  await check('H6 span', () => {
    const span = defaultSpan('2026-11-27', 'hebrew');
    assertEqual([span?.first, span?.last], [addMonths('h5787-03', -12), addMonths('h5787-03', 18)], 'the span ends');
    assertEqual(spanMonths(span).length, 31, '31 months');
    assertEqual(spanToShow(defaultSpan('2026-11-27')!, 'h5787-03'), span!, 'a month of the other kind: the span around it');
    assertEqual(spanToShow(span!, '2026-11'), defaultSpan('2026-11-27')!, 'and back');
    assert(!inSpan(defaultSpan('2026-11-27')!, 'h5787-03'), 'a Gregorian span holds no Hebrew key');
    assert(!inSpan(span!, '2026-11'), 'a Hebrew span holds no civil key');
    assert(inSpan(span!, 'h5787-03'), 'a Hebrew span holds its month');
  });

  await check('H7 client-safe', () => {
    for (const file of ['hebrew-months.ts', 'grid.ts', 'month-mode.ts']) {
      const source = fs.readFileSync(path.join(ROOT, 'src/lib/calendar-view', file), 'utf8');
      const imports = source.split('\n').filter(l => /^import\b/.test(l));
      assert(!imports.some(l => l.includes('@hebcal/core')), `${file} imports @hebcal/core`);
    }
    const months = fs.readFileSync(path.join(ROOT, 'src/lib/calendar-view/hebrew-months.ts'), 'utf8').replace(/\/\/.*$/gm, '');
    assert(!/\.(get|set)(Date|Day|Month|FullYear|Hours)\(|new Date\(\)|Date\.now/.test(months.replace(/hd\.get\w+\(\)/g, '')), 'hebrew-months.ts reads no local calendar');
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  process.exit(failed ? 1 : 0);
}

function dayAfter(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1, 12)).toISOString().slice(0, 10);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

// Smoke test for the Month's calendar arithmetic and titles (spec §7.4, §5's month
// windows, Ruling R12; Plan E, Task E2): src/lib/calendar-view/grid.ts, and
// formatMonthTitle and formatWeekdayHeader in src/lib/calendar-view/format.ts.
//
// The Month draws each month as week rows from the user's week start (0 = Sunday …
// 6 = Saturday): the first row is the week holding the 1st and the last row the week
// holding the month's last day, so a month has 4, 5 or 6 rows. It fetches each month's
// own days, [1st, 1st of next month) (R12), over a window of 12 months back to 18 ahead.
// A day key is a calendar day, so none of this may depend on the device's clock: the
// checks read days through an independent local-noon reference and run under five
// device clocks, America/Santiago's midnight DST change included.
//
// Pure: no database, Redis, network or AI. Run it under four clocks:
//   TZ=UTC npx tsx scripts/smoke-calendar-grid.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-calendar-grid.ts
//   TZ=Pacific/Kiritimati npx tsx scripts/smoke-calendar-grid.ts
//   TZ=America/Santiago npx tsx scripts/smoke-calendar-grid.ts

import fs from 'fs';
import path from 'path';
import {
  MONTHS_AHEAD,
  MONTHS_BACK,
  addMonths,
  grid,
  monthFirstDay,
  monthGrid,
  monthLastDay,
  monthOf,
  monthSpan,
  monthWindow,
  weekdayOrder,
} from '../src/lib/calendar-view/grid';
import { formatMonthTitle, formatWeekdayHeader } from '../src/lib/calendar-view/format';
import type { WeekStart } from '../src/lib/calendar-view/types';

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

const WEEK_STARTS: readonly WeekStart[] = [0, 1, 2, 3, 4, 5, 6];
const pad = (n: number) => String(n).padStart(2, '0');

// The reference reads days through the device's own calendar at local noon (which exists
// on every day in every zone), never through grid.ts's UTC arithmetic.
function localNoon(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d, 12);
}
function localKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function nextKey(key: string): string {
  const d = localNoon(key);
  d.setDate(d.getDate() + 1);
  return localKey(d);
}
function weekdayRef(key: string): number {
  return localNoon(key).getDay();
}
function daysInMonthRef(y: number, m: number): number {
  return new Date(y, m, 0, 12).getDate();
}
/** Each row as "first..last", for exact expectations that stay readable. */
function spans(rows: string[][]): string[] {
  return rows.map(r => `${r[0]}..${r[r.length - 1]}`);
}

async function main() {
  await check('every month from 2020-01 to 2035-12 at every week start 0–6: rows of 7 consecutive days from the week start, the first holding the 1st, the last holding the last day, 4–6 rows', () => {
    const rowCounts = WEEK_STARTS.map(() => new Set<number>());
    for (let y = 2020; y <= 2035; y++) {
      for (let m = 1; m <= 12; m++) {
        const month = `${y}-${pad(m)}`;
        const len = daysInMonthRef(y, m);
        const firstKey = `${month}-01`;
        const lastKey = `${month}-${pad(len)}`;
        for (const ws of WEEK_STARTS) {
          const label = `${month} at week start ${ws}`;
          const rows = monthGrid(month, ws);
          assert(rows.length >= 4 && rows.length <= 6, `${label}: ${rows.length} rows`);
          assert(rows.every(r => r.length === 7), `${label}: a row without 7 days`);
          const flat = rows.flat();
          for (let i = 1; i < flat.length; i++) {
            assert(flat[i] === nextKey(flat[i - 1]), `${label}: ${flat[i]} follows ${flat[i - 1]}`);
          }
          for (const row of rows) assert(weekdayRef(row[0]) === ws, `${label}: the row from ${row[0]} starts on weekday ${weekdayRef(row[0])}`);
          assert(rows[0].includes(firstKey), `${label}: the first row ${spans(rows)[0]} misses ${firstKey}`);
          assert(rows[rows.length - 1].includes(lastKey), `${label}: the last row ${spans(rows).at(-1)} misses ${lastKey}`);
          const inMonth = flat.filter(k => k.startsWith(`${month}-`));
          assert(inMonth.length === len && new Set(inMonth).size === len, `${label}: ${inMonth.length} in-month cells, want ${len}`);
          const offset = (weekdayRef(firstKey) - ws + 7) % 7;
          assert(rows.length === Math.ceil((offset + len) / 7), `${label}: ${rows.length} rows, want ${Math.ceil((offset + len) / 7)}`);
          assertEqual(rows, grid(firstKey, lastKey, ws), `${label}: monthGrid is grid(1st, last day)`);
          rowCounts[ws].add(rows.length);
        }
      }
    }
    WEEK_STARTS.forEach(ws => assertEqual([...rowCounts[ws]].sort(), [4, 5, 6], `row counts seen at week start ${ws}`));
  });

  await check('4-row months: February 2026 at week start 0 (it starts on a Sunday) and February 2027 at week start 1 (a Monday)', () => {
    assertEqual(spans(monthGrid('2026-02', 0)), ['2026-02-01..2026-02-07', '2026-02-08..2026-02-14', '2026-02-15..2026-02-21', '2026-02-22..2026-02-28'], 'February 2026, ws 0');
    assertEqual(spans(monthGrid('2027-02', 1)), ['2027-02-01..2027-02-07', '2027-02-08..2027-02-14', '2027-02-15..2027-02-21', '2027-02-22..2027-02-28'], 'February 2027, ws 1');
    assertEqual(monthGrid('2026-02', 1).length, 5, 'February 2026 at week start 1 needs a fifth row');
  });

  await check('6-row months: August 2026 at week starts 0 and 1; October 2026 has 5 rows at week starts 0–4 and 6 at 5 and 6', () => {
    assertEqual(spans(monthGrid('2026-08', 0)), ['2026-07-26..2026-08-01', '2026-08-02..2026-08-08', '2026-08-09..2026-08-15', '2026-08-16..2026-08-22', '2026-08-23..2026-08-29', '2026-08-30..2026-09-05'], 'August 2026, ws 0');
    assertEqual(spans(monthGrid('2026-08', 1)), ['2026-07-27..2026-08-02', '2026-08-03..2026-08-09', '2026-08-10..2026-08-16', '2026-08-17..2026-08-23', '2026-08-24..2026-08-30', '2026-08-31..2026-09-06'], 'August 2026, ws 1');
    assertEqual(spans(monthGrid('2026-10', 5)), ['2026-09-25..2026-10-01', '2026-10-02..2026-10-08', '2026-10-09..2026-10-15', '2026-10-16..2026-10-22', '2026-10-23..2026-10-29', '2026-10-30..2026-11-05'], 'October 2026, ws 5');
    assertEqual(spans(monthGrid('2026-10', 6)), ['2026-09-26..2026-10-02', '2026-10-03..2026-10-09', '2026-10-10..2026-10-16', '2026-10-17..2026-10-23', '2026-10-24..2026-10-30', '2026-10-31..2026-11-06'], 'October 2026, ws 6');
    const october: [WeekStart, string, string, number][] = [
      [0, '2026-09-27', '2026-10-31', 5],
      [1, '2026-09-28', '2026-11-01', 5],
      [2, '2026-09-29', '2026-11-02', 5],
      [3, '2026-09-30', '2026-11-03', 5],
      [4, '2026-10-01', '2026-11-04', 5],
    ];
    for (const [ws, first, last, rows] of october) {
      const g = monthGrid('2026-10', ws);
      assertEqual([g[0][0], g.at(-1)?.[6], g.length], [first, last, rows], `October 2026, ws ${ws}`);
    }
  });

  await check("grid on any run of days: one day, runs across a year and a leap day; [] for a bad key or a backwards run", () => {
    assertEqual(grid('2026-10-15', '2026-10-15', 4), [['2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21']], 'a Thursday at week start 4');
    assertEqual(spans(grid('2026-10-15', '2026-10-15', 0)), ['2026-10-11..2026-10-17'], 'a Thursday at week start 0');
    assertEqual(spans(grid('2026-12-30', '2027-01-02', 1)), ['2026-12-28..2027-01-03'], 'across the new year in one row');
    assertEqual(spans(grid('2026-12-27', '2027-01-10', 0)), ['2026-12-27..2027-01-02', '2027-01-03..2027-01-09', '2027-01-10..2027-01-16'], 'across the new year in three rows');
    assertEqual(grid('2028-02-27', '2028-03-01', 1)[1].slice(0, 3), ['2028-02-28', '2028-02-29', '2028-03-01'], 'the leap day');
    const bad: [string, string][] = [
      ['', '2026-10-31'],
      ['2026-10-01', ''],
      ['2026-10-01', '2026-02-30'],
      ['2026-13-01', '2026-13-31'],
      ['2026-1-01', '2026-10-31'],
      ['0026-10-01', '0026-10-31'],
      ['2026-10-01T00:00', '2026-10-31'],
      ['2026-10-31', '2026-10-01'],
    ];
    for (const [a, b] of bad) assertEqual(grid(a, b, 0), [], `grid(${JSON.stringify(a)}, ${JSON.stringify(b)})`);
  });

  await check('month maths: monthOf, addMonths across December and across years, the first and last days (leap years included), monthWindow [1st, 1st of next month) (R12)', () => {
    assertEqual([monthOf('2026-10-15'), monthOf('2026-12-31'), monthOf('2028-02-29')], ['2026-10', '2026-12', '2028-02'], 'monthOf');
    assertEqual([monthOf('2026-02-30'), monthOf('2026-10'), monthOf('')], ['', '', ''], 'monthOf a bad key');
    const adds: [string, number, string][] = [
      ['2026-12', 1, '2027-01'],
      ['2027-01', -1, '2026-12'],
      ['2026-10', 0, '2026-10'],
      ['2026-10', 18, '2028-04'],
      ['2026-10', -12, '2025-10'],
      ['2026-10', -22, '2024-12'],
      ['2026-10', 27, '2029-01'],
      ['2026-11', 14, '2028-01'],
      ['2026-10', 1.5, ''],
      ['2026-13', 1, ''],
      ['2026-1', 1, ''],
      ['', 1, ''],
    ];
    for (const [month, n, want] of adds) assertEqual(addMonths(month, n), want, `addMonths(${JSON.stringify(month)}, ${n})`);
    assertEqual([monthFirstDay('2026-10'), monthFirstDay('2027-01'), monthFirstDay('2026-13'), monthFirstDay('2026-10-01')], ['2026-10-01', '2027-01-01', '', ''], 'monthFirstDay');
    const lasts: [string, string][] = [
      ['2026-01', '2026-01-31'],
      ['2026-02', '2026-02-28'],
      ['2028-02', '2028-02-29'],
      ['2100-02', '2100-02-28'],
      ['2000-02', '2000-02-29'],
      ['2026-04', '2026-04-30'],
      ['2026-12', '2026-12-31'],
      ['2026-00', ''],
      ['', ''],
    ];
    for (const [month, want] of lasts) assertEqual(monthLastDay(month), want, `monthLastDay(${JSON.stringify(month)})`);
    assertEqual(monthWindow('2026-10'), { from: '2026-10-01', to: '2026-11-01' }, 'October 2026');
    assertEqual(monthWindow('2026-12'), { from: '2026-12-01', to: '2027-01-01' }, 'December 2026, across the year');
    assertEqual(monthWindow('2028-02'), { from: '2028-02-01', to: '2028-03-01' }, 'February 2028');
    assertEqual(monthWindow('2026-13'), { from: '', to: '' }, 'a bad month');
    assertEqual(monthGrid('2026-13', 0), [], 'monthGrid of a bad month');
  });

  await check('monthSpan(2026-10-15) is the 31 months 2025-10 … 2028-04, oldest first (MONTHS_BACK 12, MONTHS_AHEAD 18)', () => {
    assertEqual([MONTHS_BACK, MONTHS_AHEAD], [12, 18], 'the window constants');
    const span = monthSpan('2026-10-15');
    assertEqual(span.length, 31, 'months');
    assertEqual([span[0], span[MONTHS_BACK], span[30]], ['2025-10', '2026-10', '2028-04'], 'first, today and last');
    span.forEach((m, i) => assert(m === addMonths('2025-10', i), `month ${i} is ${m}, want ${addMonths('2025-10', i)}`));
    assertEqual([...span].sort(), span, 'oldest first');
    assertEqual(new Set(span).size, 31, 'no month twice');
    const jan = monthSpan('2026-01-01');
    assertEqual([jan[0], jan.at(-1), jan.length], ['2025-01', '2027-07', 31], 'from 1 January');
    const dec = monthSpan('2026-12-31');
    assertEqual([dec[0], dec.at(-1), dec.length], ['2025-12', '2028-06', 31], 'from 31 December');
    assertEqual([monthSpan(''), monthSpan('2026-10'), monthSpan('2026-02-30')], [[], [], []], 'a bad today');
  });

  await check("weekdayOrder starts at the week start and matches every grid row's weekdays", () => {
    assertEqual(weekdayOrder(0), [0, 1, 2, 3, 4, 5, 6], 'ws 0');
    assertEqual(weekdayOrder(1), [1, 2, 3, 4, 5, 6, 0], 'ws 1');
    assertEqual(weekdayOrder(5), [5, 6, 0, 1, 2, 3, 4], 'ws 5');
    assertEqual(weekdayOrder(6), [6, 0, 1, 2, 3, 4, 5], 'ws 6');
    for (const ws of WEEK_STARTS) {
      for (const month of ['2026-02', '2026-08', '2026-10', '2027-02']) {
        for (const row of monthGrid(month, ws)) assertEqual(row.map(weekdayRef), weekdayOrder(ws), `${month} ws ${ws} row from ${row[0]}`);
      }
    }
    // A week start the server never sends reads Sunday rather than misaligning the rows.
    for (const odd of [7, -1, 1.5, Number.NaN]) {
      assertEqual(weekdayOrder(odd as WeekStart), weekdayOrder(0), `weekdayOrder(${odd})`);
      assertEqual(monthGrid('2026-10', odd as WeekStart), monthGrid('2026-10', 0), `monthGrid at week start ${odd}`);
    }
  });

  await check("formatMonthTitle (Ruling 8): 'October 2026' / 'אוקטובר 2026' / 'Октябрь 2026', the month alone without the year; Russian nominative, capitalised, no 'г.'", () => {
    assertEqual(['en', 'he', 'ru'].map(l => formatMonthTitle('2026-10', l, true)), ['October 2026', 'אוקטובר 2026', 'Октябрь 2026'], 'with the year');
    assertEqual(['en', 'he', 'ru'].map(l => formatMonthTitle('2026-10', l, false)), ['October', 'אוקטובר', 'Октябрь'], 'without the year');
    const months = Array.from({ length: 12 }, (_, i) => `2027-${pad(i + 1)}`);
    assertEqual(months.map(m => formatMonthTitle(m, 'ru', true)), ['Январь 2027', 'Февраль 2027', 'Март 2027', 'Апрель 2027', 'Май 2027', 'Июнь 2027', 'Июль 2027', 'Август 2027', 'Сентябрь 2027', 'Октябрь 2027', 'Ноябрь 2027', 'Декабрь 2027'], 'ru, every month');
    assertEqual(months.map(m => formatMonthTitle(m, 'he', false)), ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'], 'he, every month');
    assertEqual(months.map(m => formatMonthTitle(m, 'en', false)), ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'], 'en, every month');
    assertEqual(formatMonthTitle('2028-04', 'de', true), 'April 2028', 'an unknown locale reads English');
    for (const bad of ['2026-13', '2026-00', '2026-1', '', '2026-10-01']) assertEqual(formatMonthTitle(bad, 'en', true), '', `formatMonthTitle(${JSON.stringify(bad)})`);
  });

  await check("formatWeekdayHeader (Ruling 8): en narrow 'S M T W T F S', he narrow 'א׳ ב׳ …', ru two letters 'Пн Вт …', in weekStart order", () => {
    assertEqual(weekdayOrder(0).map(d => formatWeekdayHeader(d, 'en')), ['S', 'M', 'T', 'W', 'T', 'F', 'S'], 'en, ws 0');
    assertEqual(weekdayOrder(0).map(d => formatWeekdayHeader(d, 'he')), ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'], 'he, ws 0');
    assertEqual(weekdayOrder(1).map(d => formatWeekdayHeader(d, 'ru')), ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'], 'ru, ws 1');
    assertEqual(weekdayOrder(6).map(d => formatWeekdayHeader(d, 'en')), ['S', 'S', 'M', 'T', 'W', 'T', 'F'], 'en, ws 6');
    assertEqual(formatWeekdayHeader(4, 'de'), 'T', 'an unknown locale reads English');
    for (const odd of [7, -1, 1.5]) assertEqual(formatWeekdayHeader(odd as WeekStart, 'en'), '', `formatWeekdayHeader(${odd})`);
  });

  await check("the same grids, spans, windows and titles on five device clocks (America/Santiago's midnight DST change included)", () => {
    const months = Array.from({ length: 48 }, (_, i) => addMonths('2025-01', i));
    const snapshot = () =>
      JSON.stringify({
        grids: months.map(m => WEEK_STARTS.map(ws => monthGrid(m, ws))),
        // Santiago: 2026-04-05 and 2026-09-06 change at midnight; Jerusalem: 2026-10-25.
        runs: [grid('2026-09-05', '2026-09-07', 0), grid('2026-04-04', '2026-04-06', 1), grid('2026-10-24', '2026-10-26', 6)],
        spans: ['2026-10-15', '2026-09-06', '2026-04-05', '2026-01-01'].map(monthSpan),
        windows: months.map(monthWindow),
        lasts: months.map(monthLastDay),
        titles: months.map(m => ['en', 'he', 'ru'].map(l => formatMonthTitle(m, l, true))),
        weekdays: ['en', 'he', 'ru'].map(l => WEEK_STARTS.map(d => formatWeekdayHeader(d, l))),
      });
    const saved = process.env.TZ;
    try {
      process.env.TZ = 'UTC';
      const reference = snapshot();
      for (const tz of ['Asia/Jerusalem', 'Pacific/Kiritimati', 'America/Santiago', 'America/Los_Angeles']) {
        process.env.TZ = tz;
        assert(snapshot() === reference, `the output differs with the clock in ${tz}`);
      }
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  });

  await check('grid.ts is pure: it imports only the DTO types (or date-fns), with no Intl, @hebcal, timezone library, local-time getter or clock', () => {
    const source = fs.readFileSync(path.join(ROOT, 'src/lib/calendar-view/grid.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const imports = [...code.matchAll(/^import\s+(type\s+)?(?:[^'"]*?\s+from\s+)?'([^']+)';/gm)].map(m => `${m[1] ? 'type ' : ''}${m[2]}`);
    for (const spec of imports) assert(spec === 'type ./types' || /^date-fns(\/|$)/.test(spec), `grid.ts imports ${spec}`);
    assert(!/require\(|import\(/.test(code), 'no require() or import()');
    for (const banned of [/\bIntl\b/, /toLocale/, /@hebcal/, /date-fns-tz/, /getTimezoneOffset/, /new Date\(\)/, /Date\.now/]) {
      assert(!banned.test(code), `grid.ts uses ${banned}`);
    }
    const local = code.match(/\.(get|set)(Date|Day|Month|FullYear|Hours)\(/);
    assert(!local, `grid.ts reads the device's calendar: ${local?.[0]}`);
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

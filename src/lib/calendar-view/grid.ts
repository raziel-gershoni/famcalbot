// The Month's calendar arithmetic (spec §7.4, §5's month windows, Ruling R12): the
// months of the window, each month's own days and its week rows. Client-safe and pure:
// no Intl, no @hebcal, no timezone, no clock. It imports only the DTO types.
//
// - A day key is a calendar day in the viewer's timezone, so every step is UTC
//   arithmetic on UTC noon of the day, the rule of store.ts's addDaysToKey and
//   format.ts's keyDate. The device's clock and its DST changes can never move a day.
// - A month is drawn as rows of 7 days from the week start: the first row is the week
//   holding the 1st and the last row the week holding the month's last day, so a month
//   has 4, 5 or 6 rows. The days outside the month stay blank (R12).
// - A month fetches its own days, [1st, 1st of next month) (R12).
// - Nothing here throws: a malformed key gives '' (or [], or an empty window).

import type { DayKey, WeekStart } from './types';

/** A calendar month, 'yyyy-MM'. */
export type MonthKey = string;

/** The Month's window (spec §7.4): 12 months before today's month … 18 months after it. */
export const MONTHS_BACK = 12;
export const MONTHS_AHEAD = 18;

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_KEY = /^\d{4}-\d{2}$/;
const DAY_MS = 86_400_000;

/** UTC noon of a real 'yyyy-MM-dd' day, in ms; null otherwise ('2026-02-30' and years before 0100 included). */
function dayMs(day: DayKey): number | null {
  if (!DAY_KEY.test(day)) return null;
  const [y, m, d] = day.split('-').map(Number);
  const ms = Date.UTC(y, m - 1, d, 12);
  return new Date(ms).toISOString().slice(0, 10) === day ? ms : null;
}

function keyOf(ms: number): DayKey {
  return new Date(ms).toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday. */
function weekdayOf(ms: number): number {
  return new Date(ms).getUTCDay();
}

/** A week start the server never sends (not an integer 0–6) reads Sunday, so rows never misalign. */
function weekStartOf(weekStart: WeekStart): WeekStart {
  return Number.isInteger(weekStart) && weekStart >= 0 && weekStart <= 6 ? weekStart : 0;
}

/** year × 12 + the month's index (0–11) of a real 'yyyy-MM' month; null otherwise. */
function monthIndex(month: MonthKey): number | null {
  if (!MONTH_KEY.test(month) || dayMs(`${month}-01`) === null) return null;
  return Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;
}

/** The month of a monthIndex, or '' outside the years a key can write. */
function monthAt(index: number): MonthKey {
  const year = Math.floor(index / 12);
  const month = `${String(year).padStart(4, '0')}-${String(index - year * 12 + 1).padStart(2, '0')}`;
  return monthIndex(month) === null ? '' : month;
}

/**
 * The week rows from the week holding `firstKey` to the week holding `lastKey` (inclusive),
 * each 7 consecutive day keys from `weekStart`. A month's grid has 4, 5 or 6 rows.
 * [] for a malformed key or a backwards run.
 */
export function grid(firstKey: DayKey, lastKey: DayKey, weekStart: WeekStart): DayKey[][] {
  const first = dayMs(firstKey);
  const last = dayMs(lastKey);
  if (first === null || last === null || last < first) return [];
  const ws = weekStartOf(weekStart);
  const start = first - ((weekdayOf(first) - ws + 7) % 7) * DAY_MS;
  const end = last + ((ws + 6 - weekdayOf(last)) % 7) * DAY_MS;
  const rows: DayKey[][] = [];
  for (let row = start; row <= end; row += 7 * DAY_MS) {
    rows.push(Array.from({ length: 7 }, (_, i) => keyOf(row + i * DAY_MS)));
  }
  return rows;
}

/** The month of a day key: '2026-10-15' → '2026-10'; '' for a malformed key. */
export function monthOf(day: DayKey): MonthKey {
  return dayMs(day) === null ? '' : day.slice(0, 7);
}

/** `n` months after `month` (before it when negative): '2026-12' + 1 → '2027-01'; '' for a malformed month or a fractional n. */
export function addMonths(month: MonthKey, n: number): MonthKey {
  const index = monthIndex(month);
  return index === null || !Number.isInteger(n) ? '' : monthAt(index + n);
}

/** The month's 1st: '2026-10' → '2026-10-01'; '' for a malformed month. */
export function monthFirstDay(month: MonthKey): DayKey {
  return monthIndex(month) === null ? '' : `${month}-01`;
}

/** The month's last day: '2028-02' → '2028-02-29'; '' for a malformed month. */
export function monthLastDay(month: MonthKey): DayKey {
  if (monthIndex(month) === null) return '';
  const [y, m] = month.split('-').map(Number);
  // Day 0 of the next month is this month's last day.
  return keyOf(Date.UTC(y, m, 0, 12));
}

/** The days a month fetches (R12): [1st, 1st of next month), the end excluded. Both '' for a malformed month. */
export function monthWindow(month: MonthKey): { from: DayKey; to: DayKey } {
  const from = monthFirstDay(month);
  const to = monthFirstDay(addMonths(month, 1));
  return from && to ? { from, to } : { from: '', to: '' };
}

/** The month's week rows from `weekStart`: grid(1st, last day). [] for a malformed month. */
export function monthGrid(month: MonthKey, weekStart: WeekStart): DayKey[][] {
  const first = monthFirstDay(month);
  return first ? grid(first, monthLastDay(month), weekStart) : [];
}

/**
 * The Month's window around today (spec §7.4): MONTHS_BACK months before today's month,
 * today's month, then MONTHS_AHEAD after it, oldest first (31 months). [] for a malformed today.
 */
export function monthSpan(today: DayKey): MonthKey[] {
  const month = monthOf(today);
  if (!month) return [];
  const out: MonthKey[] = [];
  for (let n = -MONTHS_BACK; n <= MONTHS_AHEAD; n++) {
    const m = addMonths(month, n);
    if (m) out.push(m);
  }
  return out;
}

/** The weekdays in column order: [weekStart, weekStart + 1, …] mod 7. */
export function weekdayOrder(weekStart: WeekStart): WeekStart[] {
  const ws = weekStartOf(weekStart);
  return Array.from({ length: 7 }, (_, i) => ((ws + i) % 7) as WeekStart);
}

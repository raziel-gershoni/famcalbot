// The Month's calendar arithmetic (spec §7.4, §5's month windows, Ruling R12): the
// months browse holds (its span), each month's own days and its week rows. Client-safe and
// pure: no Intl, no @hebcal, no timezone, no clock. It imports only the DTO types and the
// reach (year-limits.ts).
// - The span (owner 2026-11-17, "infinite scroll"): browse opens on today's month −12 … +18,
//   grows SPAN_GROW months at an end the month in view comes within SPAN_EDGE months of, and
//   moves to a month far past it (a jump), all inside MONTH_REACH.
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
import { MONTH_REACH } from './year-limits';

/** A calendar month, 'yyyy-MM'. */
export type MonthKey = string;

/** Browse's opening span (spec §7.4): 12 months before today's month … 18 months after it. */
export const MONTHS_BACK = 12;
export const MONTHS_AHEAD = 18;
/** The months browse adds at an end, and how near the month in view comes to it first. */
export const SPAN_GROW = 12;
export const SPAN_EDGE = 6;

/** The months browse holds, oldest and newest, inside MONTH_REACH. */
export interface MonthSpan {
  first: MonthKey;
  last: MonthKey;
}

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

/** A month held inside MONTH_REACH; '' for a malformed one. */
function inReach(month: MonthKey): MonthKey {
  if (!addMonths(month, 0)) return '';
  return month < MONTH_REACH.first ? MONTH_REACH.first : month > MONTH_REACH.last ? MONTH_REACH.last : month;
}

/** The span around `month`: MONTHS_BACK before it … MONTHS_AHEAD after it, inside the reach; null for a malformed month. */
function spanAround(month: MonthKey): MonthSpan | null {
  if (!addMonths(month, 0)) return null;
  return { first: inReach(addMonths(month, -MONTHS_BACK)), last: inReach(addMonths(month, MONTHS_AHEAD)) };
}

/** Browse's opening span (spec §7.4): today's month −MONTHS_BACK … +MONTHS_AHEAD; null for a malformed today. */
export function defaultSpan(today: DayKey): MonthSpan | null {
  return spanAround(monthOf(today));
}

/** The span's months, oldest first; [] for a malformed span. */
export function spanMonths(span: MonthSpan | null): MonthKey[] {
  const first = span ? monthIndex(span.first) : null;
  const last = span ? monthIndex(span.last) : null;
  if (first === null || last === null) return [];
  const out: MonthKey[] = [];
  for (let i = first; i <= last; i++) out.push(monthAt(i));
  return out;
}

/** Whether `month` is one of the span's. */
export function inSpan(span: MonthSpan, month: MonthKey): boolean {
  return addMonths(month, 0) !== '' && month >= span.first && month <= span.last;
}

/** Whether the month in view is within SPAN_EDGE months of an end the span can still grow at. */
export function nearSpanEdge(span: MonthSpan, month: MonthKey, edge: 'before' | 'after'): boolean {
  const at = monthIndex(month);
  const end = monthIndex(edge === 'before' ? span.first : span.last);
  if (at === null || end === null) return false;
  return edge === 'before' ? span.first > MONTH_REACH.first && at - end < SPAN_EDGE : span.last < MONTH_REACH.last && end - at < SPAN_EDGE;
}

/** The span with SPAN_GROW more months at one end, inside the reach; the same span when it can't grow. */
export function growSpan(span: MonthSpan, edge: 'before' | 'after'): MonthSpan {
  const next = edge === 'before' ? { first: inReach(addMonths(span.first, -SPAN_GROW)), last: span.last } : { first: span.first, last: inReach(addMonths(span.last, SPAN_GROW)) };
  return next.first && next.last && (next.first !== span.first || next.last !== span.last) ? next : span;
}

/**
 * The span once `month` must be in it (a jump, picked's chevrons, Today): the same span when it
 * is; grown to MONTHS_BACK / MONTHS_AHEAD past it when it is at most SPAN_GROW months beyond an
 * end; else the span around it, so browse never holds decades of months it skipped.
 */
export function spanToShow(span: MonthSpan, month: MonthKey): MonthSpan {
  // A month past the reach is its end: the span never chases a month it can't hold.
  const target = inReach(month);
  const at = monthIndex(target);
  const first = monthIndex(span.first);
  const last = monthIndex(span.last);
  if (at === null || first === null || last === null) return span;
  if (at >= first && at <= last) return span;
  let next: MonthSpan | null;
  if (at < first && first - at <= SPAN_GROW) next = { first: inReach(addMonths(target, -MONTHS_BACK)), last: span.last };
  else if (at > last && at - last <= SPAN_GROW) next = { first: span.first, last: inReach(addMonths(target, MONTHS_AHEAD)) };
  else next = spanAround(target);
  return next && (next.first !== span.first || next.last !== span.last) ? next : span;
}

/**
 * The span around today (spec §7.4): MONTHS_BACK months before today's month, today's month,
 * then MONTHS_AHEAD after it, oldest first (31 months). [] for a malformed today.
 */
export function monthSpan(today: DayKey): MonthKey[] {
  return spanMonths(defaultSpan(today));
}

/** The weekdays in column order: [weekStart, weekStart + 1, …] mod 7. */
export function weekdayOrder(weekStart: WeekStart): WeekStart[] {
  const ws = weekStartOf(weekStart);
  return Array.from({ length: 7 }, (_, i) => ((ws + i) % 7) as WeekStart);
}

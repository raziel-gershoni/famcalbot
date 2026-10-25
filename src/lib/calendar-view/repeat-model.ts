// The Repeat sheet's model, as pure logic (editor upgrades spec §3, rulings 1 to 11): what the
// form holds for a repeat, the sheet's operations on it (a frequency, every N, weekday chips,
// the monthly options, the end), and the spec the request sends. Client-safe and pure: it
// imports only the shared editing types.
//
// The form keeps a repeat as a RepeatSpec, 'none' or 'custom' (a stored rule the sheet can't
// say, kept as it is until another choice is made). A weekly spec's `byDay` is the whole set of
// days the person chose, or absent for a plain weekly, which follows its start. Moving the start
// never edits the form: shownSpec (what the request sends and the sheet shows) adds the start's
// day to the set, so a move adds the new start's day and moving back restores the set, and a
// plain weekly moves with its start. The monthly choice is 'day' | 'weekday' | 'last' and the
// ordinal is never stored: the start gives it ('last' reads as the n-th weekday once the start
// can't hold it). All of it is built on the start's day in the series' zone (editor-model's
// repeatDayOf), as the server builds it.

import { REPEAT_COUNT_MAX, REPEAT_INTERVAL_MAX, WEEKDAY_CODES, type RepeatInput, type RepeatSpec, type WeekdayCode } from './editor-types';

export type RepeatForm = RepeatSpec | 'none' | 'custom';
export type RepeatFreq = RepeatSpec['freq'];

export const isSpec = (r: RepeatForm): r is RepeatSpec => typeof r === 'object';

/** Whether the repeat follows the start's Hebrew date. */
export const isHebrewForm = (r: RepeatForm): r is RepeatSpec & { freq: 'hebrew' } => isSpec(r) && r.freq === 'hebrew';

/** The weekday ids the copy's select takes, by Date's day of the week (0 is Sunday). */
export const WEEKDAY_IDS_BY_INDEX = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
/** The code of each weekday by Date's day of the week (0 is Sunday). */
export const CODES_BY_INDEX: WeekdayCode[] = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const INDEX_OF_CODE: Record<WeekdayCode, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

/** The day's parts, or null while it is not a real yyyy-MM-dd. */
function partsOf(day: string): { y: number; m: number; d: number; dow: number } | null {
  const hit = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!hit) return null;
  const [y, m, d] = [Number(hit[1]), Number(hit[2]), Number(hit[3])];
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return { y, m, d, dow: date.getUTCDay() };
}

/** The weekday code of a real day, else null. */
export function codeOfDay(day: string): WeekdayCode | null {
  const p = partsOf(day);
  return p ? CODES_BY_INDEX[p.dow] : null;
}

/** The weekday id the copy's select takes, of a code. */
export const idOfCode = (code: WeekdayCode): (typeof WEEKDAY_IDS_BY_INDEX)[number] => WEEKDAY_IDS_BY_INDEX[INDEX_OF_CODE[code]];

/**
 * What the monthly choice offers for a start: the ordinal of its weekday in the month (the
 * second Tuesday, `ceil(day / 7)`, 1..5) and whether "the last" also applies (the start is in
 * the month's last seven days). Null while the start is not a real day.
 */
export function monthlyOptions(day: string): { ordinal: number; last: boolean } | null {
  const p = partsOf(day);
  if (!p) return null;
  const inMonth = new Date(Date.UTC(p.y, p.m, 0)).getUTCDate();
  return { ordinal: Math.ceil(p.d / 7), last: p.d > inMonth - 7 };
}

/** A day moved by `n` days, '' for a day that isn't real. */
function plusDays(day: string, n: number): string {
  const p = partsOf(day);
  if (!p) return '';
  return new Date(Date.UTC(p.y, p.m - 1, p.d + n)).toISOString().slice(0, 10);
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, Math.trunc(Number.isFinite(n) ? n : min)));

/** The weekday codes in the order the week reads from `weekStart` (0 is Sunday). */
export function weekOrder(weekStart: number): WeekdayCode[] {
  return Array.from({ length: 7 }, (_, i) => CODES_BY_INDEX[(weekStart + i) % 7]);
}

/**
 * The spec in the form's shape for a start: the interval and end clamped to the limits, the
 * weekly days as the whole set, Monday first, the start's day among them (a set that is just the
 * start's day is a plain weekly, which follows its start: no byDay), 'last' only while the start is
 * in its month's last seven days (else the n-th weekday of the start), the monthly choice only on
 * a monthly spec, one end only.
 */
export function normalizeSpec(spec: RepeatSpec, startDay: string): RepeatSpec {
  const own = codeOfDay(startDay);
  const out: RepeatSpec = { freq: spec.freq, interval: clamp(spec.interval, 1, REPEAT_INTERVAL_MAX) };
  if (spec.freq === 'weekly') {
    const days = WEEKDAY_CODES.filter((c) => c === own || (spec.byDay ?? []).includes(c));
    if (days.length > 1 || (own === null && days.length > 0)) out.byDay = days;
  }
  if (spec.freq === 'monthly') {
    const options = monthlyOptions(startDay);
    out.monthly = spec.monthly === 'last' && options && !options.last ? 'weekday' : (spec.monthly ?? 'day');
  }
  if (spec.until) out.until = spec.until;
  else if (spec.count !== undefined) out.count = clamp(spec.count, 1, REPEAT_COUNT_MAX);
  return out;
}

/** A stored repeat in the form's shape (see normalizeSpec) for the start it is shown against. */
export function formRepeat(repeat: RepeatForm, startDay: string): RepeatForm {
  return isSpec(repeat) ? normalizeSpec(repeat, startDay) : repeat;
}

/**
 * The spec the request sends, and the sheet shows, for a start: a weekly spec lists its days
 * Monday first with the start's day among them. Moving the start adds its day to a listed set
 * and moves a plain weekly with it, because the form keeps what the person chose and this adds
 * the start. Null for 'none' and 'custom' (nothing to say).
 */
export function shownSpec(repeat: RepeatForm, startDay: string): RepeatSpec | null {
  if (!isSpec(repeat)) return null;
  const spec = normalizeSpec(repeat, startDay);
  const own = codeOfDay(startDay);
  if (spec.freq === 'weekly' && own) spec.byDay = WEEKDAY_CODES.filter((c) => c === own || (spec.byDay ?? []).includes(c));
  return spec;
}

/** What `repeat` in a request body carries: the shown spec, or 'none' (a kept-as-is rule is never sent: see editor-model). */
export function repeatInput(repeat: RepeatForm, startDay: string): RepeatInput {
  return shownSpec(repeat, startDay) ?? 'none';
}

/** A spec as the request would say it, for comparing. */
function canonical(spec: RepeatSpec): string {
  return JSON.stringify([spec.freq, spec.interval, [...(spec.byDay ?? [])].sort(), spec.freq === 'monthly' ? (spec.monthly ?? 'day') : null, spec.until ?? null, spec.until ? null : (spec.count ?? null)]);
}

/**
 * Whether two repeats say the same against one start: each is shown on it (shownSpec), so a start
 * that moved is not a change, and a series stored as 'last' that the start can no longer hold is
 * compared as the n-th weekday on both sides.
 */
export function sameRepeat(a: RepeatForm, b: RepeatForm, startDay: string): boolean {
  if (!isSpec(a) || !isSpec(b)) return a === b;
  const [x, y] = [shownSpec(a, startDay), shownSpec(b, startDay)];
  return x !== null && y !== null && canonical(x) === canonical(y);
}

// ---- The sheet's operations ----

/** What a stored rule the sheet can't say lends a spec made from it: its end, and its interval for the same frequency. */
export interface CustomSeed {
  freq?: RepeatFreq;
  interval?: number;
  until?: string;
  count?: number;
}

/** A spec of a frequency with the interval and end it had (switching Weekly to Monthly keeps "every 2" and the end). */
export function specOf(freq: RepeatFreq, from: RepeatForm, startDay: string, seed?: CustomSeed): RepeatSpec {
  const keep = isSpec(from)
    ? { interval: from.interval, ...(from.until ? { until: from.until } : {}), ...(!from.until && from.count !== undefined ? { count: from.count } : {}) }
    : seed
      ? { interval: seed.freq === freq && seed.interval ? seed.interval : 1, ...(seed.until ? { until: seed.until } : {}), ...(!seed.until && seed.count !== undefined ? { count: seed.count } : {}) }
      : { interval: 1 };
  return normalizeSpec({ freq, ...keep }, startDay);
}

/** The sheet's frequency pick: 'none' ends the repeat; the same frequency again changes nothing. Leaving 'custom' carries its end (and its interval for the same frequency). */
export function pickFrequency(from: RepeatForm, pick: RepeatFreq | 'none', startDay: string, seed?: CustomSeed): RepeatForm {
  if (pick === 'none') return 'none';
  if (isSpec(from) && from.freq === pick) return from;
  return specOf(pick, from, startDay, from === 'custom' ? seed : undefined);
}

/** Every N: clamped to 1..REPEAT_INTERVAL_MAX. */
export function withInterval(spec: RepeatSpec, interval: number): RepeatSpec {
  return { ...spec, interval: clamp(interval, 1, REPEAT_INTERVAL_MAX) };
}

/** A weekday chip tapped: the start's own day can't be turned off. The result lists the whole set. */
export function toggleDay(spec: RepeatSpec, code: WeekdayCode, startDay: string): RepeatSpec {
  const own = codeOfDay(startDay);
  if (code === own) return spec;
  const shown = shownSpec(spec, startDay);
  const has = (shown?.byDay ?? []).includes(code);
  const days = WEEKDAY_CODES.filter((c) => (c === code ? !has : c === own || (shown?.byDay ?? []).includes(c)));
  return normalizeSpec({ ...spec, byDay: days }, startDay);
}

/** The monthly choice. */
export function withMonthly(spec: RepeatSpec, monthly: NonNullable<RepeatSpec['monthly']>): RepeatSpec {
  return { ...spec, monthly };
}

export type EndKind = 'never' | 'until' | 'count';

export function endKindOf(spec: RepeatSpec): EndKind {
  return spec.until ? 'until' : spec.count !== undefined ? 'count' : 'never';
}

/** How far an end the person hasn't chosen yet reaches: four repeats from the start. */
const STEP_DAYS: Record<RepeatFreq, number> = { daily: 1, weekly: 7, monthly: 30, yearly: 365, hebrew: 365 };
export const DEFAULT_COUNT = 5;

/** The end chosen: Never, On <date> (a first date four repeats on, never before the start), After N times. */
export function withEnd(spec: RepeatSpec, kind: EndKind, startDay: string): RepeatSpec {
  const next: RepeatSpec = { ...spec };
  delete next.until;
  delete next.count;
  if (kind === 'until') next.until = spec.until ?? plusDays(startDay, STEP_DAYS[spec.freq] * spec.interval * 4);
  if (kind === 'count') next.count = spec.count ?? DEFAULT_COUNT;
  return next;
}

/** A date for "On <date>". */
export function withUntil(spec: RepeatSpec, until: string): RepeatSpec {
  const next: RepeatSpec = { ...spec, until };
  delete next.count;
  return next;
}

/** "After N times": clamped to 1..REPEAT_COUNT_MAX. */
export function withCount(spec: RepeatSpec, count: number): RepeatSpec {
  const next: RepeatSpec = { ...spec, count: clamp(count, 1, REPEAT_COUNT_MAX) };
  delete next.until;
  return next;
}

/** A Hebrew-date repeat on a calendar that has none falls back to the Gregorian yearly one, with its interval and end. */
export function toGregorian(repeat: RepeatForm, startDay: string): RepeatForm {
  return isHebrewForm(repeat) ? specOf('yearly', repeat, startDay) : repeat;
}

/** Whether the repeat's end falls before the start's day (the sheet's date sheet doesn't allow it; a start moved later can). */
export function endsBeforeStart(repeat: RepeatForm, startDay: string): boolean {
  return isSpec(repeat) && !!repeat.until && repeat.until < startDay;
}

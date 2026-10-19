// The Hebrew holidays on the calendar home (Hebrew holidays spec §5): a small client cache
// of GET /api/calendar/holidays, one month at a time, and the hook the Month's cells, the
// day headers and the header read it with.
//
// Holidays are decoration, never an error state: a failed month logs, shows nothing and is
// asked again the next time a view needs it (a failure is not cached). They load alongside
// the range requests and never block them, and only when the home shows Hebrew dates.
// Client-safe: it imports only the grid's month arithmetic and the wire types, never
// @hebcal/core (the server computes the holidays).

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { monthFirstDay, monthLastDay, type MonthKey } from './grid';
import type { DayKey, Holiday } from './types';

/** A month's holidays by day; days without one have no key. */
export type HolidayDays = Record<DayKey, readonly Holiday[]>;

const NONE: HolidayDays = Object.freeze({});

/** Months that landed, by "<lang>|<month>". */
const landed = new Map<string, HolidayDays>();
/** One request per key at a time. */
const inflight = new Map<string, Promise<HolidayDays>>();
const listeners = new Set<() => void>();
/** Bumped when a month lands, so a hook knows to read the cache again. */
let version = 0;

const cacheKey = (month: MonthKey, lang: string) => `${lang}|${month}`;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Forgets every month, for a test that wants a cold cache. */
export function resetHolidaysCache(): void {
  landed.clear();
  inflight.clear();
  version++;
  listeners.forEach((listener) => listener());
}

function isHoliday(value: unknown): value is Holiday {
  const h = value as Partial<Holiday> | null;
  return typeof h === 'object' && h !== null && typeof h.title === 'string' && typeof h.brief === 'string' && typeof h.chag === 'boolean';
}

/** The answer's days when it has the shape, else null. */
function readDays(body: unknown): HolidayDays | null {
  const days = (body as { days?: unknown } | null)?.days;
  if (typeof days !== 'object' || days === null || Array.isArray(days)) return null;
  const out: Record<DayKey, readonly Holiday[]> = {};
  for (const [day, list] of Object.entries(days)) {
    if (!Array.isArray(list) || !list.every(isHoliday)) return null;
    out[day] = list;
  }
  return out;
}

async function fetchMonth(month: MonthKey, lang: string): Promise<HolidayDays> {
  const from = monthFirstDay(month);
  const to = monthLastDay(month);
  if (!from || !to) return NONE;
  let status = 0;
  try {
    const res = await fetch(`/api/calendar/holidays?from=${from}&to=${to}&lang=${encodeURIComponent(lang)}`);
    status = res.status;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const days = readDays(await res.json());
    if (!days) throw new Error('unexpected answer');
    landed.set(cacheKey(month, lang), days);
    version++;
    listeners.forEach((listener) => listener());
    return days;
  } catch (error) {
    console.error(`[holidays] ${month} (${lang}) failed${status ? ` with ${status}` : ''}:`, error);
    return NONE;
  }
}

/**
 * A month's holidays: from the cache, or asked of the route once, however many views ask at
 * the same time. A failure resolves to {} and is not cached.
 */
export function holidaysFor(month: MonthKey, lang: string): Promise<HolidayDays> {
  const key = cacheKey(month, lang);
  const have = landed.get(key);
  if (have) return Promise.resolve(have);
  const pending = inflight.get(key);
  if (pending) return pending;
  const request = fetchMonth(month, lang).finally(() => inflight.delete(key));
  inflight.set(key, request);
  return request;
}

/**
 * The holidays of the days of `months`, merged, in `lang`; re-renders when a month lands.
 * Asks for nothing, and answers {}, while `on` is false (the home shows no Hebrew dates).
 */
export function useHolidays(months: readonly MonthKey[], lang: string, on: boolean): HolidayDays {
  const monthsKey = months.join(',');
  const seen = useSyncExternalStore(subscribe, () => version, () => 0);
  useEffect(() => {
    if (!on) return;
    for (const month of monthsKey ? monthsKey.split(',') : []) void holidaysFor(month, lang);
  }, [on, lang, monthsKey]);
  return useMemo(() => {
    if (!on) return NONE;
    const merged: Record<DayKey, readonly Holiday[]> = {};
    for (const month of monthsKey ? monthsKey.split(',') : []) Object.assign(merged, landed.get(cacheKey(month, lang)));
    return merged;
    // `seen` is the cache's version: a month that landed since the last read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, lang, monthsKey, seen]);
}

/** The titles of a day's holidays in one line, joined the way `locale` lists things ("Chanukah: 8 Candles and Rosh Chodesh Tevet"). */
export function holidayTitles(list: readonly Holiday[], locale: string): string {
  return new Intl.ListFormat(locale, { style: 'long', type: 'unit' }).format(list.map((h) => h.title));
}

/** Whether any of a day's holidays is a yom tov (the accent colour). */
export function hasChag(list: readonly Holiday[] | undefined): boolean {
  return list?.some((h) => h.chag) ?? false;
}

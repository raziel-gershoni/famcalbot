// The Hebrew holidays on the calendar home (Hebrew holidays spec §5): a small client cache
// of GET /api/calendar/holidays, one month at a time, and the hook the Month's cells, the
// day headers and the header read it with.
//
// Holidays are decoration, never an error state: a failed month logs, shows nothing and is
// asked again the next time a view needs it, or when the month in view changes (a failure
// is not cached, retryFailedHolidays asks the failed months again). They load alongside
// the range requests and never block them, and only when the home shows Hebrew dates.
// Client-safe: it imports only the grid's month arithmetic, the title join and the wire types, never
// @hebcal/core (the server computes the holidays).

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { joinTitles } from '../join-titles';
import { monthFirstDay, monthLastDay, type MonthKey } from './grid';
import type { DayKey, Holiday } from './types';

/** A month's holidays by day; days without one have no key. */
export type HolidayDays = Record<DayKey, readonly Holiday[]>;

/**
 * Asked of the route with every month: the route's answers are cached for a day, so a change in what a month
 * holds (v2: the weekly parasha and the special Shabbatot) needs a new URL to skip the old cached answers.
 */
const API_VERSION = 2;

const NONE: HolidayDays = Object.freeze({});

/** Months that landed, by "<lang>|<month>". */
const landed = new Map<string, HolidayDays>();
/** One request per key at a time. */
const inflight = new Map<string, Promise<HolidayDays>>();
/** Months whose last request failed, by key; a request that lands takes its month out. */
const failed = new Map<string, { month: MonthKey; lang: string }>();
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
  failed.clear();
  version++;
  listeners.forEach((listener) => listener());
  nextLanded.clear();
  nextInflight.clear();
  nextVersion++;
  nextListeners.forEach((listener) => listener());
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
    const res = await fetch(`/api/calendar/holidays?from=${from}&to=${to}&lang=${encodeURIComponent(lang)}&v=${API_VERSION}`);
    status = res.status;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const days = readDays(await res.json());
    if (!days) throw new Error('unexpected answer');
    landed.set(cacheKey(month, lang), days);
    failed.delete(cacheKey(month, lang));
    version++;
    listeners.forEach((listener) => listener());
    return days;
  } catch (error) {
    console.error(`[holidays] ${month} (${lang}) failed${status ? ` with ${status}` : ''}:`, error);
    failed.set(cacheKey(month, lang), { month, lang });
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

/** Whether a month's holidays have landed (so a day without one is known to have none). */
export function monthLanded(month: MonthKey, lang: string): boolean {
  return landed.has(cacheKey(month, lang));
}

/**
 * Asks again for every month whose request failed (a month with a request on its way, or one that
 * landed since, is left alone). The Month calls it when the month in view changes: its grids stay
 * mounted, so their hooks would never ask again by themselves.
 */
export function retryFailedHolidays(): void {
  for (const { month, lang } of [...failed.values()]) void holidaysFor(month, lang);
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

/** The next holiday worth counting down to, as the route answers it. */
export interface NextHoliday {
  day: DayKey;
  name: string;
}

/** Answers that landed, by "<lang>|<after>"; null is "no holiday ahead". */
const nextLanded = new Map<string, NextHoliday | null>();
const nextInflight = new Set<string>();
/** Bumped when an answer lands, so the hook reads the cache again. */
let nextVersion = 0;
const nextListeners = new Set<() => void>();

function subscribeNext(listener: () => void): () => void {
  nextListeners.add(listener);
  return () => nextListeners.delete(listener);
}

function readNext(body: unknown): NextHoliday | null | undefined {
  const next = (body as { next?: unknown } | null)?.next;
  if (next === null) return null;
  const n = next as Partial<NextHoliday> | undefined;
  return typeof n === 'object' && typeof n.day === 'string' && typeof n.name === 'string' ? { day: n.day, name: n.name } : undefined;
}

async function fetchNext(after: DayKey, lang: string): Promise<void> {
  const key = `${lang}|${after}`;
  if (nextInflight.has(key)) return;
  nextInflight.add(key);
  let status = 0;
  try {
    const res = await fetch(`/api/calendar/holidays?next=${after}&lang=${encodeURIComponent(lang)}`);
    status = res.status;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const next = readNext(await res.json());
    if (next === undefined) throw new Error('unexpected answer');
    nextLanded.set(key, next);
    nextVersion++;
    nextListeners.forEach((listener) => listener());
  } catch (error) {
    // Not cached: the next render that wants it asks again.
    console.error(`[holidays] next after ${after} (${lang}) failed${status ? ` with ${status}` : ''}:`, error);
  } finally {
    nextInflight.delete(key);
  }
}

/**
 * The next holiday worth counting down to after `after` (the server's today), in `lang`;
 * null while it loads, when none is ahead or the request failed. Asks for nothing while
 * `on` is false (no Hebrew dates, or today has a holiday line of its own).
 */
export function useNextHoliday(after: DayKey | null, lang: string, on: boolean): NextHoliday | null {
  const seen = useSyncExternalStore(subscribeNext, () => nextVersion, () => 0);
  const key = after ? `${lang}|${after}` : '';
  const have = key ? nextLanded.has(key) : false;
  useEffect(() => {
    if (on && after && !have) void fetchNext(after, lang);
  }, [on, after, lang, have]);
  return useMemo(() => (on && key ? nextLanded.get(key) ?? null : null),
    // `seen` is the cache's version: an answer that landed since the last read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [on, key, seen]);
}

/** The titles of a day's holidays in one line, comma-joined in every language ("Chanukah: 8 Candles, Rosh Chodesh Tevet"). */
export function holidayTitles(list: readonly Holiday[]): string {
  return joinTitles(list.map((h) => h.title));
}

/** Whether a day's entry is the weekly portion or its special Shabbat (listed with the holidays, but none). */
export function isPortion(h: Holiday): boolean {
  return h.kind === 'parasha' || h.kind === 'specialShabbat';
}

/** Whether any of a day's holidays is a yom tov (the accent colour). */
export function hasChag(list: readonly Holiday[] | undefined): boolean {
  return list?.some((h) => h.chag) ?? false;
}

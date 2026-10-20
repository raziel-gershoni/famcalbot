// The Hebrew-date series' horizon in their Google copies (google-sync spec §4, Hebrew series).
// Pure: no I/O, no clock of its own.
//
// Google has no Hebrew rule, so a Hebrew series is copied as explicit dates: the first one in
// the current Hebrew year, then each of its slots through 10 Hebrew years ahead (the mapper's
// toGoogleHebrewEvent writes them as RDATE lines). The first year listed is kept with the
// copy (its item's slotHashes, under HEBREW_FROM_KEY), so the dates sent stay the same from
// one push to the next, and the list moves on only when fewer than 2 Hebrew years remain
// ahead of the current one. Past years then drop out of the copy (a known limitation).

import { HDate, months } from '@hebcal/hdate';
import type { NativeEvent, NativeEventInstance } from '@prisma/client';
import { TIMEZONE } from '../../config/constants';
import { localDate, startOfLocalDay } from '../../utils/day-events';
import { expandSeries } from '../native-calendar/recurrence';

/** How many Hebrew years after the first one the copy lists. */
export const HEBREW_YEARS_AHEAD = 10;
/** The list moves on once fewer than this many Hebrew years remain after the current one. */
export const HEBREW_REFRESH_BELOW = 2;
/** The slotHashes key holding the first Hebrew year a copy lists (no slot key starts with '~'). */
export const HEBREW_FROM_KEY = '~hebrewFrom';

const pad = (n: number) => String(n).padStart(2, '0');

/** The Hebrew year of an instant's civil day in `zone` (daytime dates, the home's rule). */
export function hebrewYearOf(at: Date, zone: string): number {
  const [y, m, d] = localDate(at, zone).split('-').map(Number);
  return new HDate(new Date(y, m - 1, d)).getFullYear();
}

/** 00:00 in `zone` on 1 Tishrei of a Hebrew year. */
function roshHashana(year: number, zone: string): Date {
  // hebcal hands back local midnight of the civil day, so the local getters read it exactly
  const g = new HDate(1, months.TISHREI, year).greg();
  return startOfLocalDay(`${g.getFullYear()}-${pad(g.getMonth() + 1)}-${pad(g.getDate())}`, zone);
}

/**
 * The first Hebrew year the copy lists: the one it lists already while at least
 * HEBREW_REFRESH_BELOW years remain after the current one, else the current year.
 */
export function hebrewHorizonFrom(stored: number | null, now: Date, zone: string): number {
  const current = hebrewYearOf(now, zone);
  if (stored !== null && stored <= current && stored + HEBREW_YEARS_AHEAD - current >= HEBREW_REFRESH_BELOW) return stored;
  return current;
}

/** The instants the listed Hebrew years cover: 1 Tishrei of `from` up to 1 Tishrei after the last. */
export function hebrewWindow(from: number, zone: string): { from: Date; to: Date } {
  return { from: roshHashana(from, zone), to: roshHashana(from + HEBREW_YEARS_AHEAD + 1, zone) };
}

/** The first Hebrew year a copy's stored hashes say it lists, or null. */
export function storedHebrewFrom(slotHashes: unknown): number | null {
  const raw = slotHashes && typeof slotHashes === 'object' && !Array.isArray(slotHashes) ? (slotHashes as Record<string, unknown>)[HEBREW_FROM_KEY] : undefined;
  const year = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(year) ? year : null;
}

/**
 * The series' own slots in the window (exdates and overrides aside), without the skipped ones
 * (an exdate or a CANCELLED row): the dates the copy lists. An OVERRIDE row's slot stays; its
 * changes are the patch of that instance.
 */
export function hebrewSlots(series: NativeEvent, overrides: readonly NativeEventInstance[], window: { from: Date; to: Date }): Date[] {
  const skipped = new Set([...series.exdates, ...overrides.filter((o) => o.status === 'CANCELLED').map((o) => o.originalStartsAt)].map((d) => d.getTime()));
  const zoneSeries = { ...series, timeZone: series.timeZone || TIMEZONE, exdates: [] };
  return expandSeries(zoneSeries, window, [])
    .map((i) => i.instanceStartsAt)
    .filter((d) => d >= window.from && d < window.to && !skipped.has(d.getTime()));
}

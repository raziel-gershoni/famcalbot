// Wall times for the calendar home's write routes (home editing spec §3): the editor
// sends 'YYYY-MM-DDTHH:mm' (a timed item) or 'YYYY-MM-DD' (an all-day one) on the user's
// clock, and the server turns them into instants with the zone it resolved itself. Pure.

import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { addDaysToDate, localDate, startOfLocalDay } from '../../utils/day-events';
import { MAX_YEAR, MIN_YEAR_SERIES } from '../../lib/calendar-view/year-limits';

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const WALL = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/;
const DAY_MS = 86_400_000;
/** The longest an item may last: a year, to the day. */
export const MAX_SPAN_DAYS = 366;

/**
 * A yyyy-MM-dd that names a real date within the accepted years: 2026-02-30 doesn't, nor a typo
 * like 0026 or 20260. `minYear` is the item's floor (year-limits.ts minYearFor): 2000 unless the
 * item is a one-off or a yearly one.
 */
export function isDay(value: unknown, minYear: number = MIN_YEAR_SERIES): value is string {
  if (typeof value !== 'string') return false;
  const m = DAY.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  if (year < minYear || year > MAX_YEAR) return false;
  const t = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === value;
}

/** A YYYY-MM-DDTHH:mm with a real date and a clock time (00:00 to 23:59). */
export function isWall(value: unknown, minYear: number = MIN_YEAR_SERIES): value is string {
  if (typeof value !== 'string') return false;
  const m = WALL.exec(value);
  if (!m || !isDay(m[1], minYear)) return false;
  return Number(m[2]) < 24 && Number(m[3]) < 60;
}

/** The day of a wall time or a day. */
export const dayOfWall = (wall: string): string => wall.slice(0, 10);

/** The instant a wall time is in `tz`. A time a spring-forward skips lands an hour on, as a phone's clock does. */
export function wallToInstant(wall: string, tz: string): Date {
  return fromZonedTime(`${wall}:00`, tz);
}

export function instantToWall(instant: Date, tz: string): string {
  return formatInTimeZone(instant, tz, "yyyy-MM-dd'T'HH:mm");
}

/** The first instant of an all-day item's first day. */
export const dayStart = (day: string, tz: string): Date => startOfLocalDay(day, tz);

/** An all-day item's end, as the bot stores it: 23:59 local on the last day. */
export const dayEnd = (lastDay: string, tz: string): Date => fromZonedTime(`${lastDay}T23:59:00`, tz);

/** Calendar days from `from` to `to` (both yyyy-MM-dd). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/**
 * An all-day item's last day (inclusive) from its stored instants, counted in whole days
 * as the home's DTO counts them (toUnifiedEvent): a DST day is 23 or 25 hours long, and a
 * date-only reminder with no length is its one day.
 */
export function lastDayOf(startsAt: Date, endsAt: Date, tz: string): string {
  const first = localDate(startsAt, tz);
  const days = Math.max(1, Math.round((endsAt.getTime() - startsAt.getTime()) / DAY_MS));
  return addDaysToDate(first, days - 1);
}

export { addDaysToDate, localDate };

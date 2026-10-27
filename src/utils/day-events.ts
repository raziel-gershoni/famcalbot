/**
 * Which events belong to a summary day, and how.
 *
 * Google's events.list returns every event that overlaps the requested window, so an
 * event from 22:00 to 02:00 came back for both days, and on the second day its bare
 * "22:00 - 02:00" read as that evening. Reminders need the overlap (an overnight pickup
 * at 01:45 must fire), so the fetch stays as it is and summaries shape its result here:
 * last night's short tail is dropped, and anything that crosses the day's edges is
 * marked so the prompt can say so.
 */

import type { CalendarEvent, DaySpan } from '../types';
import { instantToWallTime, wallTimeToInstant } from './wall-time';

/**
 * An event carried over from the previous day that ends at or before this hour belongs
 * to last night, not to this day. The owner's call (2026-10-13): a party until 02:00 is
 * yesterday's, a sleepover until 10:00 is today's pickup.
 */
export const OVERNIGHT_CUTOFF_HOUR = 6;

/** The summary day as yyyy-MM-dd in the user's timezone. */
export function localDate(date: Date, timezone: string): string {
  return instantToWallTime(date, timezone).slice(0, 10);
}

/** The calendar date after yyyy-MM-dd. */
export function nextDate(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Plus `days` calendar days to yyyy-MM-dd. */
export function addDaysToDate(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * The first instant of `day` in `timezone`. Where daylight saving starts at midnight
 * (Chile, Cuba, Lebanon) 00:00 does not exist and the resolver moves it forward by the
 * jump, so the day then starts at 01:00; where the clocks go back at midnight, 00:00
 * happens twice and the day starts at the first.
 */
export function startOfLocalDay(day: string, timezone: string): Date {
  return wallTimeToInstant(`${day}T00:00`, timezone);
}

/**
 * How an event sits on `day` (yyyy-MM-dd in `timezone`): undefined when wholly inside
 * it, a DaySpan when it crosses the day's edges, or null when it does not belong to the
 * day at all - outside it, or last night's tail ending by OVERNIGHT_CUTOFF_HOUR. All-day
 * events use Google's exclusive end date; a timed event's day is local midnight to local
 * midnight, so DST days are 23 or 25 hours long.
 */
export function daySpanOf(event: CalendarEvent, day: string, timezone: string): DaySpan | undefined | null {
  if (!event.start) return undefined;

  if (!event.start.includes('T')) {
    // Google's end date is exclusive; a missing or non-advancing end means one day.
    const end = event.end && !event.end.includes('T') && event.end > event.start ? event.end : nextDate(event.start);
    if (day < event.start || day >= end) return null;
    const startsBefore = event.start < day;
    const endsAfter = end > nextDate(day);
    return startsBefore ? (endsAfter ? 'spansDay' : 'continues') : endsAfter ? 'endsLater' : undefined;
  }

  const dayStart = startOfLocalDay(day, timezone);
  const dayEnd = startOfLocalDay(nextDate(day), timezone);
  const start = new Date(event.start);
  const end = new Date(event.end || event.start);
  // A zero-length item (a reminder) is an instant, so it belongs to the day it falls
  // in. The overlap test below would put one at exactly 00:00 on no day: it ends
  // where its own day begins.
  if (end.getTime() === start.getTime()) return start >= dayStart && start < dayEnd ? undefined : null;
  if (end <= dayStart || start >= dayEnd) return null;
  const startsBefore = start < dayStart;
  const endsAfter = end > dayEnd;
  if (startsBefore && !endsAfter) {
    const cutoff = wallTimeToInstant(`${day}T${String(OVERNIGHT_CUTOFF_HOUR).padStart(2, '0')}:00`, timezone);
    if (end <= cutoff) return null;
  }
  return startsBefore ? (endsAfter ? 'spansDay' : 'continues') : endsAfter ? 'endsLater' : undefined;
}

/** The events that belong to `day`, in their original order, marked with their DaySpan. */
export function shapeEventsForDay(events: CalendarEvent[], day: string, timezone: string): CalendarEvent[] {
  const shaped: CalendarEvent[] = [];
  for (const event of events) {
    const span = daySpanOf(event, day, timezone);
    if (span === null) continue;
    shaped.push(span ? { ...event, daySpan: span } : event);
  }
  return shaped;
}

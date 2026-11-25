// The Birthday switch (docs/superpowers/specs/2026-11-25-birthday-switch-design.md): what can be a birthday, and the
// year a civil-date birthday counts its age from. The event store keeps `NativeEvent.birthday` only on a series
// `canBeBirthday` takes; `birthYearOf` is read by the count (hebrew-anniversary.ts' anniversaryOf).
//
// Client-safe and pure: no clock, no I/O.

import { instantToWallTime } from '../utils/wall-time';

/** FREQ=YEARLY with no INTERVAL or INTERVAL=1 (an end, UNTIL or COUNT, is allowed): "Every year", civil or on the Hebrew date. */
export function isEveryYearRule(rrule: string | null | undefined): boolean {
  if (!rrule) return false;
  const parts = rrule.replace(/^RRULE:/, '').split(';');
  if (!parts.includes('FREQ=YEARLY')) return false;
  const interval = parts.find((p) => p.startsWith('INTERVAL='));
  return interval === undefined || interval === 'INTERVAL=1';
}

/** A series that may be a birthday: an all-day event (not a reminder) repeating every year. */
export function canBeBirthday(series: { kind: string; allDay: boolean; rrule: string | null }): boolean {
  return series.kind === 'EVENT' && series.allDay && isEveryYearRule(series.rrule);
}

/**
 * The civil year a civil-date birthday counts its age from: the stored one (a part split off "from this one on" keeps
 * the original series' year), else the year of the series' own start on its zone's clock.
 */
export function birthYearOf(series: { birthYear: number | null; startsAt: Date; timeZone: string }): number {
  if (series.birthYear !== null) return series.birthYear;
  return Number(instantToWallTime(series.startsAt, series.timeZone || 'UTC').slice(0, 4));
}

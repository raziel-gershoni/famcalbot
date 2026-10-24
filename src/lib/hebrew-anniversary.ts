// The anniversary count of a Hebrew yearly event (docs/superpowers/specs/2026-10-25-hebrew-anniversary-count-design.md):
// how many Hebrew years this occurrence is after the original one ("Dana's birthday (35)").
// The one place that does the subtraction; the home, the summaries and the Google copy all call it.
//
// Client-safe and pure: @hebcal/hdate only, no clock, no I/O. A civil day's Hebrew year is the
// daytime date's (no sunset shift), as hebrew-date.ts and the expander read it.

import { HDate } from '@hebcal/hdate';
import { formatInTimeZone } from 'date-fns-tz';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The Hebrew year of a civil 'yyyy-MM-dd', or null when it is not a real date. */
function hebrewYearOfDay(day: string | null | undefined): number | null {
  if (!day || !DAY.test(day)) return null;
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
  return new HDate(date).getFullYear();
}

/**
 * N = the Hebrew year of `occurrenceDay` minus the Hebrew year of `anchorDay` (both civil
 * 'yyyy-MM-dd'). Null when N < 1 (the first occurrence, an anchor in a later year) or when
 * either day cannot be read. A day the expander rolled (30 Adar I to 1 Nisan) is counted in
 * the year it lands in, which is the year the occurrence belongs to.
 */
export function anniversaryCount(anchorDay: string | null | undefined, occurrenceDay: string | null | undefined): number | null {
  const anchor = hebrewYearOfDay(anchorDay);
  const at = hebrewYearOfDay(occurrenceDay);
  if (anchor === null || at === null) return null;
  const n = at - anchor;
  return n >= 1 ? n : null;
}

/**
 * The count of one occurrence of a series: `start` is the event's start as the reader carries
 * it (an all-day 'yyyy-MM-dd', or an instant), read as a civil day in `zone`. Null for a
 * series that is not a Hebrew anniversary.
 */
export function anniversaryOf(series: { hebrewRule?: string | null; hebrewAnchor?: string | null }, start: string, zone: string): number | null {
  if (series.hebrewRule !== 'anniversary' || !series.hebrewAnchor) return null;
  if (DAY.test(start)) return anniversaryCount(series.hebrewAnchor, start);
  const at = new Date(start);
  if (Number.isNaN(at.getTime())) return null;
  return anniversaryCount(series.hebrewAnchor, formatInTimeZone(at, zone, 'yyyy-MM-dd'));
}

/**
 * The title with its count as plain text, "Dana's birthday (35)": for places that cannot style a
 * pill (the Google copy). The bare title while there is no count (N < 1).
 */
export function titleWithCount(title: string, count: number | null): string {
  return count !== null && count >= 1 ? `${title} (${count})` : title;
}

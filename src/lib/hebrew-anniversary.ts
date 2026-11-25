// The anniversary count of a Hebrew yearly event (docs/superpowers/specs/2026-10-25-hebrew-anniversary-count-design.md):
// how many Hebrew years this occurrence is after the original one ("Dana's birthday (35)"); and a civil-date birthday's
// age (docs/superpowers/specs/2026-11-25-birthday-switch-design.md), civil years since its start year.
// The one place that does the subtraction; the home, the summaries and the Google copy all call it.
//
// Client-safe and pure: @hebcal/hdate only, no clock, no I/O. A civil day's Hebrew year is the
// daytime date's (no sunset shift), as hebrew-date.ts and the expander read it.

import { HDate } from '@hebcal/hdate';
import { formatInTimeZone } from 'date-fns-tz';
import { birthYearOf, isEveryYearRule } from './birthday';

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

/** The series fields the count reads: the Hebrew pair, and for a civil-date birthday its switch, rule, start and year. */
export interface CountedSeries {
  hebrewRule?: string | null;
  hebrewAnchor?: string | null;
  birthday?: boolean;
  rrule?: string | null;
  startsAt?: Date;
  timeZone?: string;
  birthYear?: number | null;
}

/**
 * The count of one occurrence of a series: `start` is the event's start as the reader carries
 * it (an all-day 'yyyy-MM-dd', or an instant), read as a civil day in `zone`. A Hebrew anniversary
 * counts Hebrew years from its anchor; a civil-date birthday (the Birthday switch on an every-year
 * civil rule, birthday spec) counts civil years from birthYearOf. Null for any other series, and
 * below 1.
 */
export function anniversaryOf(series: CountedSeries, start: string, zone: string): number | null {
  const day = dayOf(start, zone);
  if (day === null) return null;
  if (series.hebrewRule === 'anniversary') return series.hebrewAnchor ? anniversaryCount(series.hebrewAnchor, day) : null;
  if (series.hebrewRule || !series.birthday || !isEveryYearRule(series.rrule) || !series.startsAt || !series.timeZone) return null;
  const n = Number(day.slice(0, 4)) - birthYearOf({ birthYear: series.birthYear ?? null, startsAt: series.startsAt, timeZone: series.timeZone });
  return n >= 1 ? n : null;
}

/** An occurrence's start as a civil 'yyyy-MM-dd' in `zone`: an all-day date as it is, an instant read in the zone; null when unreadable. */
function dayOf(start: string, zone: string): string | null {
  if (DAY.test(start)) return start;
  const at = new Date(start);
  if (Number.isNaN(at.getTime())) return null;
  return formatInTimeZone(at, zone, 'yyyy-MM-dd');
}

/**
 * The title with its count as plain text, "Dana's birthday (35)": for places that cannot style a
 * pill (the Google copy). The bare title while there is no count (N < 1).
 */
export function titleWithCount(title: string, count: number | null): string {
  return count !== null && count >= 1 ? `${title} (${count})` : title;
}

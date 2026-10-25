// The years an item may start in, one rule for the editor and the server (editor upgrades
// spec §1, Data and API). Client-safe and pure: no imports besides a type.
//
// A one-off or a yearly item (Gregorian or by the Hebrew date) may start as early as 1900, so
// a birth date fits, which the anniversary count wants. Every other repeat keeps 2000: the
// expander walks a series from its start, so a daily series from 1950 would cost about 27k
// steps per read.

import type { RuleChoice } from './editor-types';

/** The latest year any item may start in. */
export const MAX_YEAR = 2100;
/** The earliest year for a one-off or a yearly item. */
export const MIN_YEAR_BIRTH = 1900;
/** The earliest year for every other repeat. */
export const MIN_YEAR_SERIES = 2000;

/** The earliest year an item with this repeat may start in. No repeat reads as a one-off. */
export function minYearFor(repeat: RuleChoice | undefined): number {
  return repeat === undefined || repeat === 'none' || repeat === 'yearly' || repeat === 'hebrew' ? MIN_YEAR_BIRTH : MIN_YEAR_SERIES;
}

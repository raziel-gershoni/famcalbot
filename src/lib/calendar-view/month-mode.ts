// Which calendar the Month counts its months in. Client-safe, no imports.

/** The Month's two calendars: the civil months, or the Hebrew ones. */
export type MonthMode = 'gregorian' | 'hebrew';

export function isMonthMode(value: unknown): value is MonthMode {
  return value === 'gregorian' || value === 'hebrew';
}

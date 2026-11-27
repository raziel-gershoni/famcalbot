// The Month's title, one place for the month bar and the date picker's page: a month's name
// over the other calendar's months. Client-safe and pure (the day helpers only).

import { formatMonthRange, formatMonthTitle } from './format';
import { monthFirstDay, monthLastDay, monthModeOf, type MonthKey } from './grid';
import { hebrewMonthHeader, hebrewMonthRange } from './hebrew-date';

/**
 * A Gregorian month: "March 2027" over its Hebrew months (empty without Hebrew dates). A Hebrew
 * month: "Adar II 5787" over the Gregorian months its days fall in.
 */
export function monthTitle(month: MonthKey, lang: string, hebrewDates: boolean): { title: string; subtitle: string } {
  if (monthModeOf(month) === 'gregorian') {
    return { title: formatMonthTitle(month, lang, true), subtitle: hebrewDates ? hebrewMonthHeader(month, lang) : '' };
  }
  const first = monthFirstDay(month);
  const last = monthLastDay(month);
  return { title: hebrewMonthRange(first, last, lang), subtitle: formatMonthRange(first, last, lang) };
}

// The words of a Hebrew-date repeat ("Every year on 30 Cheshvan", "Every 2 years on
// 30 Cheshvan"), shared by the editor's Repeat row and the item sheet's tag so a family reads
// the same rule everywhere (hebrew-repeats spec §1, §4). The date is the series' stored anchor,
// never the opened occurrence's, which may be a rolled day.

import type { useTranslations } from 'next-intl';
import { hebrewDayLabel } from '@/src/lib/calendar-view/hebrew-date';

type CalendarHomeT = ReturnType<typeof useTranslations<'calendarHome'>>;

export interface HebrewRepeat {
  /** The rule's INTERVAL in years. */
  count: number;
  /** The anchor's civil day (yyyy-MM-dd). */
  anchor: string;
}

/** The Hebrew date of a day in the language's own form (gematriya in Hebrew; Russian reads its month genitives). '' for a key that isn't a real day. */
export function hebrewLabelOf(t: CalendarHomeT, locale: string, day: string): string {
  if (!day) return '';
  const genitive = locale === 'ru' ? (t.raw('hebrewMonthGenitive') as string[]) : undefined;
  return hebrewDayLabel(day, locale, genitive);
}

/** The rule in words; without a readable anchor, the plain "every N years". */
export function hebrewRepeatText(t: CalendarHomeT, locale: string, w: HebrewRepeat): string {
  const when = hebrewLabelOf(t, locale, w.anchor);
  return when ? t('editor.repeat.hebrewEvery', { count: w.count, date: when }) : t('editor.repeat.every.yearly', { count: w.count });
}

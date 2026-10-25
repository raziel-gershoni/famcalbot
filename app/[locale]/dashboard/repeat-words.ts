// The words of a repeat (editor upgrades spec §3, ruling 10), in one place: the Repeat row's
// value, the Repeat sheet's summary and the scope sheet's short name of "all of them" all come
// from here, so a family reads the same rule the same way everywhere. From a RepeatSpec
// ("Every 2 weeks on Sun and Tue, until 1 Mar", "Every month on the second Tuesday, 5 times",
// "Every 2 years on ט״ו בשבט") and, for a rule the sheet can't say, from the server's RepeatInfo
// (editor-model's repeatWords).
//
// The copy is calendarHome.editor.repeat.*: ICU plurals for every N; a monthly weekday takes its
// ordinal from a select on the weekday's grammatical gender (Russian «каждый второй вторник»,
// «каждую вторую среду», «каждое второе воскресенье»; Hebrew «ביום שלישי השני בכל חודש»,
// «בשבת השנייה»), the weekday list is in the week-start order and in the locale's short names.

import type { useTranslations } from 'next-intl';
import type { RepeatInfo, RepeatSpec } from '@/src/lib/calendar-view/editor-types';
import type { RepeatWords, WeekdayId } from '@/src/lib/calendar-view/editor-model';
import { formatDayMonth, intlLocale } from '@/src/lib/calendar-view/format';
import { WEEKDAY_CODES } from '@/src/lib/calendar-view/editor-types';
import { codeOfDay, idOfCode, monthlyOptions, shownSpec, weekOrder, type RepeatForm } from '@/src/lib/calendar-view/repeat-model';
import type { WeekStart } from '@/src/lib/calendar-view/types';
import { hebrewRepeatText } from './hebrew-repeat-words';

type CalendarHomeT = ReturnType<typeof useTranslations<'calendarHome'>>;

/** What a repeat is worded against. */
export interface WordsContext {
  /** The start's day (yyyy-MM-dd): a monthly "day" and "weekday" and the lone weekday of a weekly repeat come from it. */
  startDay: string;
  /** The week's first day (0 is Sunday): the order of a weekday list. */
  weekStart: WeekStart;
  /** A Hebrew repeat's anchor day (yyyy-MM-dd): its words name that date, else the start's. */
  anchorDay?: string;
}

/** The weekdays of a list, in the week-start order, as "Sun and Tue" (one day is named in full, as the sentence needs it). */
function dayList(t: CalendarHomeT, locale: string, days: WeekdayId[], weekStart: WeekStart): { n: number; days: string } {
  const order = weekOrder(weekStart).map(idOfCode);
  const sorted = order.filter((d) => days.includes(d));
  if (sorted.length === 1) return { n: 1, days: t('editor.repeat.dayOn', { weekday: sorted[0] }) };
  const names = sorted.map((d) => t('editor.repeat.dayShort', { weekday: d }));
  return { n: sorted.length, days: new Intl.ListFormat(intlLocale(locale), { type: 'conjunction', style: 'long' }).format(names) };
}

/** The ordinal word of a weekday in the month, agreeing with the weekday's gender ("second", «вторую»). */
function ordinalWord(t: CalendarHomeT, ordinal: number | 'last', day: WeekdayId): string {
  return t('editor.repeat.ordinal', { ord: String(ordinal), g: t('editor.repeat.gender', { weekday: day }) });
}

/** "Every 2 weeks on Sun and Tue". */
export function weeklyText(t: CalendarHomeT, locale: string, interval: number, days: WeekdayId[], weekStart: WeekStart): string {
  const list = dayList(t, locale, days, weekStart);
  return t('editor.repeat.weeklyOn', { count: interval, n: list.n, days: list.days });
}

/** "Every month on the second Tuesday". */
export function monthlyNthText(t: CalendarHomeT, interval: number, ordinal: number | 'last', weekday: WeekdayId): string {
  return t('editor.repeat.monthlyNth', {
    count: interval,
    ordinal: ordinalWord(t, ordinal, weekday),
    day: t('editor.repeat.dayNth', { weekday }),
    g: t('editor.repeat.gender', { weekday }),
    ord: String(ordinal),
  });
}

/** The sheet's monthly option "On the second Tuesday" / "On the last Tuesday". */
export function monthOnNthText(t: CalendarHomeT, ordinal: number | 'last', weekday: WeekdayId): string {
  return t('editor.repeat.monthOnNth', { ord: String(ordinal), ordinal: ordinalWord(t, ordinal, weekday), day: t('editor.repeat.dayNth', { weekday }) });
}

/** A Gregorian day in the words' own form. */
const dayText = (day: string, locale: string): string => (day ? formatDayMonth(day, locale) : '');

/** A text with an end: "…, until 1 Mar" / "…, 5 times". */
export function withEndText(t: CalendarHomeT, locale: string, text: string, end: { until?: string; count?: number }): string {
  if (end.until) return t('editor.repeat.until', { rule: text, date: dayText(end.until, locale) });
  if (end.count !== undefined) return t('editor.repeat.times', { rule: text, count: end.count });
  return text;
}

/**
 * A spec in words, end included. The spec is the shown one (a weekly spec lists its days, the
 * start's among them): "Every week on Thursday", "Every 2 weeks on Sun and Tue, until 1 Mar",
 * "Every month on the 14th", "Every month on the second Tuesday, 5 times", "Every 2 years on
 * ט״ו בשבט". A day that isn't real reads as the frequency alone.
 */
export function specText(t: CalendarHomeT, locale: string, spec: RepeatSpec, ctx: WordsContext): string {
  const text = specBase(t, locale, spec, ctx);
  return withEndText(t, locale, text, spec);
}

function specBase(t: CalendarHomeT, locale: string, spec: RepeatSpec, ctx: WordsContext): string {
  const { interval } = spec;
  switch (spec.freq) {
    case 'daily':
      return t('editor.repeat.every.daily', { count: interval });
    case 'weekly': {
      const own = codeOfDay(ctx.startDay);
      const codes = spec.byDay && spec.byDay.length > 0 ? spec.byDay : own ? [own] : [];
      if (codes.length === 0) return t('editor.repeat.every.weekly', { count: interval });
      return weeklyText(t, locale, interval, WEEKDAY_CODES.filter((c) => codes.includes(c)).map(idOfCode), ctx.weekStart);
    }
    case 'monthly': {
      const options = monthlyOptions(ctx.startDay);
      const own = codeOfDay(ctx.startDay);
      if (!options || !own) return t('editor.repeat.every.monthly', { count: interval });
      const day = Number(ctx.startDay.slice(8, 10));
      if (spec.monthly === 'weekday') return monthlyNthText(t, interval, options.ordinal, idOfCode(own));
      if (spec.monthly === 'last' && options.last) return monthlyNthText(t, interval, 'last', idOfCode(own));
      return t('editor.repeat.monthlyDay', { count: interval, day });
    }
    case 'yearly': {
      if (!ctx.startDay) return t('editor.repeat.every.yearly', { count: interval });
      return t('editor.repeat.yearlyOn', { count: interval, date: dayText(ctx.startDay, locale) });
    }
    case 'hebrew':
      return hebrewRepeatText(t, locale, { count: interval, anchor: ctx.anchorDay ?? ctx.startDay });
  }
}

/** The Repeat sheet's summary and the row's value for a form repeat ('custom' is worded by its own words, so it is not handled here). */
export function repeatFormText(t: CalendarHomeT, locale: string, repeat: RepeatForm, ctx: WordsContext): string {
  if (repeat === 'none') return t('editor.repeat.none');
  if (repeat === 'custom') return t('editor.repeat.currentPlain');
  // The form lists a weekly spec's days beside the start's; the words name them all.
  return specText(t, locale, shownSpec(repeat, ctx.startDay) ?? repeat, ctx);
}

/**
 * A stored rule the sheet can't say, in words from the server's rule info. null when it has
 * none (the caller says "Current repeat"). The end is added by the caller (withEndText).
 */
export function infoText(t: CalendarHomeT, locale: string, w: RepeatWords, weekStart: WeekStart): string | null {
  switch (w.key) {
    case 'daily':
      return t('scope.everyDay');
    case 'weekday':
      return t('scope.everyWeekday', { weekday: w.weekday });
    case 'interval':
      return t(`editor.repeat.every.${w.unit}`, { count: w.count });
    case 'weekly':
      return t('editor.repeat.weeklyPlain');
    case 'monthly':
      return t('editor.repeat.monthlyPlain');
    case 'yearly':
      return t('editor.repeat.yearlyPlain');
    case 'hebrewEvery':
      return hebrewRepeatText(t, locale, w);
    case 'weekdays':
      return weeklyText(t, locale, w.interval, w.days, weekStart);
    case 'nth':
      return monthlyNthText(t, w.interval, w.ordinal, w.weekday);
    case 'monthDay':
      return t('editor.repeat.monthlyDay', { count: w.interval, day: w.day });
    default:
      return null;
  }
}

/** The end a rule info reports, for the words of a rule the sheet can't say. */
export const endOfInfo = (repeat: RepeatInfo | null, ruleUntil?: string): { until?: string; count?: number } => ({
  ...((ruleUntil ?? repeat?.until) ? { until: ruleUntil ?? repeat?.until } : {}),
  ...(repeat?.count !== undefined && !(ruleUntil ?? repeat?.until) ? { count: repeat.count } : {}),
});

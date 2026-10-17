// Dates and times on the calendar home (spec §7.1 Times, §7.3). Intl only; client-safe
// and pure (it imports only the store's day arithmetic and the DTO types).
//
// - Times are in the viewer's timezone (the route's `tz`), 24-hour with two-digit hours
//   (hourCycle 'h23'): "09:30", never "9:30 AM".
// - A day key is a calendar day. It is formatted as UTC noon of that day in UTC, so the
//   device's clock can never move it to the day before or after.
// - English is day-first, as in the approved mockups ("Thu 15 Oct", "Thursday, 15 October").
// - Hebrew day labels name the weekday as the Hebrew mockup does, "חמישי 15 באוק׳", not
//   he-IL's short "יום ה׳, 15 באוק׳"; the long header keeps Intl's "יום חמישי, 15 באוקטובר".
// - A range of days in one month names the month once, as spec §7.3 and the mockups do:
//   "Sat 17 – Sun 18 Oct", "שבת 17 – ראשון 18 באוק׳", "сб, 17 – вс, 18 окт.".
// - Nothing here throws during a render: a bad value gives '' (or null), and a timezone
//   the device's Intl doesn't know falls back to the device's own zone.

import { addDaysToKey } from './store';
import type { DayKey, ItemDTO } from './types';

/** The weekday of a day key, as calendarHome.stillOpen.sinceWeekday's select names it. */
export type WeekdayId = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat';

const WEEKDAYS: readonly WeekdayId[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const INTL_LOCALES: Readonly<Record<string, string>> = { en: 'en-GB', he: 'he-IL', ru: 'ru-RU' };

/** The Intl locale for a page locale: en-GB (day-first English), he-IL, ru-RU; anything else reads English. */
export function intlLocale(locale: string): string {
  return INTL_LOCALES[locale] ?? INTL_LOCALES.en;
}

const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** UTC noon of a real 'yyyy-MM-dd' day, else null. */
function keyDate(day: DayKey): Date | null {
  const m = DAY_KEY.exec(day);
  if (!m) return null;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
  return date.toISOString().slice(0, 10) === day ? date : null;
}

function instant(value: string | null | undefined): Date | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t);
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** A cached formatter. A timezone the device's Intl rejects falls back to the device's zone. */
function formatter(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let f = formatters.get(key);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat(intlLocale(locale), options);
    } catch {
      const { timeZone: _ignored, ...rest } = options;
      f = new Intl.DateTimeFormat(intlLocale(locale), rest);
    }
    formatters.set(key, f);
  }
  return f;
}

const SHORT_DAY: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' };
const LONG_DAY: Intl.DateTimeFormatOptions = { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' };
const DAY_MONTH: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', timeZone: 'UTC' };

function timeOptions(tz: string): Intl.DateTimeFormatOptions {
  return { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz };
}

const isHebrew = (locale: string) => intlLocale(locale) === INTL_LOCALES.he;

/** A Hebrew weekday as the mockup's labels write it: the long name without "יום " ("חמישי", "שבת"). */
function hebrewWeekday(d: Date, timeZone: string): string {
  return formatter('he', { weekday: 'long', timeZone }).format(d).replace(/^יום\s+/, '');
}

/** "Thu 15 Oct" / "חמישי 15 באוק׳" / "чт, 15 окт.": the Agenda's day labels. */
export function formatDayShort(day: DayKey, locale: string): string {
  const d = keyDate(day);
  if (!d) return '';
  if (isHebrew(locale)) return `${hebrewWeekday(d, 'UTC')} ${formatter(locale, DAY_MONTH).format(d)}`;
  return formatter(locale, SHORT_DAY).format(d);
}

/** A day label without its month, for the first day of a range in one month: "Sat 17" / "שבת 17" / "сб, 17". */
function dayWithoutMonth(d: Date, locale: string): string {
  if (isHebrew(locale)) return `${hebrewWeekday(d, 'UTC')} ${d.getUTCDate()}`;
  const parts = formatter(locale, SHORT_DAY).formatToParts(d);
  const dayAt = parts.findIndex((p) => p.type === 'day');
  return dayAt < 0 ? formatter(locale, SHORT_DAY).format(d) : parts.slice(0, dayAt + 1).map((p) => p.value).join('');
}

/**
 * "Thursday, 15 October" / "יום חמישי, 15 באוקטובר" / "четверг, 15 октября": the home's header
 * (D6). en-GB writes no comma after the weekday; spec §7.2 and the mockups have one, as he-IL
 * and ru-RU do, so English gets it here.
 */
export function formatDayLong(day: DayKey, locale: string): string {
  const d = keyDate(day);
  if (!d) return '';
  const f = formatter(locale, LONG_DAY);
  if (intlLocale(locale) !== INTL_LOCALES.en) return f.format(d);
  return f
    .formatToParts(d)
    .map((part, i, parts) =>
      part.type === 'literal' && parts[i - 1]?.type === 'weekday' && !part.value.includes(',') ? `,${part.value}` : part.value
    )
    .join('');
}

/** "6 Oct" / "6 באוק׳" / "6 окт.": an older carry-over's "since". */
export function formatDayMonth(day: DayKey, locale: string): string {
  const d = keyDate(day);
  return d ? formatter(locale, DAY_MONTH).format(d) : '';
}

/**
 * One day, or `first` to `last`: "Sat 17 Oct"; "Sat 17 – Sun 18 Oct" in one month (spec
 * §7.3's fold line, "שבת 17 – ראשון 18 באוק׳", "сб, 17 – вс, 18 окт."); "Sat 31 Oct – Sun
 * 1 Nov" across months. The fold line's {range}, and the dates of a multi-day all-day item.
 */
export function formatDayRange(first: DayKey, last: DayKey, locale: string): string {
  const a = keyDate(first);
  const b = keyDate(last);
  if (!a) return '';
  if (!b || last <= first) return formatDayShort(first, locale);
  const start = first.slice(0, 7) === last.slice(0, 7) ? dayWithoutMonth(a, locale) : formatDayShort(first, locale);
  return `${start} – ${formatDayShort(last, locale)}`;
}

/** "09:30": an instant's time in `tz`; '' when the value isn't an instant. */
export function formatTime(value: string | null | undefined, tz: string, locale: string): string {
  const d = instant(value);
  return d ? formatter(locale, timeOptions(tz)).format(d) : '';
}

/** "Fri 02:00" / "שישי 02:00": an instant's weekday and time in `tz`, for an end or a snooze on another day. */
export function formatWeekdayTime(value: string | null | undefined, tz: string, locale: string): string {
  const d = instant(value);
  if (!d) return '';
  if (isHebrew(locale)) return `${hebrewWeekday(d, tz)} ${formatTime(value, tz, locale)}`;
  return formatter(locale, { weekday: 'short', ...timeOptions(tz) }).format(d);
}

/** "Thu 15 Oct, 22:00" / "חמישי 15 באוק׳, 22:00": an instant's day and time in `tz`, for a range across days. */
export function formatDayTime(value: string | null | undefined, tz: string, locale: string): string {
  const d = instant(value);
  if (!d) return '';
  const day = isHebrew(locale) ? instantDay(value, tz) : null;
  if (day) return `${formatDayShort(day, locale)}, ${formatTime(value, tz, locale)}`;
  return formatter(locale, { weekday: 'short', day: 'numeric', month: 'short', ...timeOptions(tz) }).format(d);
}

/** The day key an instant falls on in `tz`, or null when the value isn't an instant. */
export function instantDay(value: string | null | undefined, tz: string): DayKey | null {
  const d = instant(value);
  if (!d) return null;
  const parts = formatter('en', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: tz }).formatToParts(d);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  const key = `${part('year')}-${part('month')}-${part('day')}`;
  return DAY_KEY.test(key) ? key : null;
}

/** The weekday of a day key, or null for a key that isn't a real day. */
export function weekdayOf(day: DayKey): WeekdayId | null {
  const d = keyDate(day);
  return d ? WEEKDAYS[d.getUTCDay()] : null;
}

/** Whole calendar days from `from` to `to` (negative when `to` is earlier); NaN for a bad key. */
export function daysBetween(from: DayKey, to: DayKey): number {
  const a = keyDate(from);
  const b = keyDate(to);
  return a && b ? Math.round((b.getTime() - a.getTime()) / 86_400_000) : Number.NaN;
}

/** An all-day item's last day: its end date is exclusive; a missing or non-advancing end means one day (as daySpanOf). */
export function allDayLastDay(item: Pick<ItemDTO, 'start' | 'end'>): DayKey {
  return DAY_KEY.test(item.end) && item.end > item.start ? addDaysToKey(item.end, -1) : item.start;
}

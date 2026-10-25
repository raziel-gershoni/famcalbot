// Hebrew dates on the calendar home (spec §7.8): the full date under the header
// ("4 Cheshvan 5787"), the Hebrew date beside each Agenda day ("4 Cheshvan"), and on the
// Month (Plan E) each month's Hebrew months ("Tishrei – Cheshvan 5787") and each cell's
// Hebrew day ("16", or "1 Chesh." with the month).
// Client-safe and pure. It uses @hebcal/hdate and the Russian month names only, never
// @hebcal/core, which would pull the holiday tables into the home's bundle.
//
// A day key is a calendar day in the viewer's timezone. Its Hebrew date is the daytime
// date of that day (no sunset shift), so it never depends on the device's clock.

import { HDate, Locale, gematriya, type MonthName } from '@hebcal/hdate';
// Adds Russian to @hebcal/hdate's Locale. package.json pins @hebcal/hdate to the one copy
// @hebcal/core and @hebcal/locales share, so this is the same Locale the bot reads.
import '@hebcal/locales/ru';
import { monthFirstDay, monthLastDay, type MonthKey } from './grid';
import type { DayKey } from './types';

/**
 * The 14 Hebrew month names, in the order of `calendarHome.hebrewMonthGenitive` in
 * messages/{en,he,ru}.json: the year from Tishrei, with the plain Adar of a common
 * year before the Adar I and Adar II of a leap year.
 */
export const HEBREW_MONTHS = [
  'Tishrei',
  'Cheshvan',
  'Kislev',
  'Tevet',
  "Sh'vat",
  'Adar',
  'Adar I',
  'Adar II',
  'Nisan',
  'Iyyar',
  'Sivan',
  'Tamuz',
  'Av',
  'Elul',
] as const satisfies readonly MonthName[];

type Lang = 'en' | 'he' | 'ru';

/** The home's languages; anything else reads English. */
function langOf(lang: string): Lang {
  return lang === 'he' || lang === 'ru' ? lang : 'en';
}

/** The Hebrew date of a day key, or null when the key isn't a real 'yyyy-MM-dd' day. */
export function hebrewDateOf(dayKey: DayKey): HDate | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  // Local midnight of that calendar day, never an instant: HDate reads the local year,
  // month and day back, whatever the device's timezone. (A UTC midnight is still the day
  // before anywhere west of Greenwich.)
  const date = new Date(y, m - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
  return new HDate(date);
}

/** The day key of an HDate's civil day (the date picker pages by Hebrew month and needs the days back). */
export function dayKeyOfHDate(hd: HDate): DayKey {
  const date = hd.greg();
  const pad = (n: number, width: number) => String(n).padStart(width, '0');
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1, 2)}-${pad(date.getDate(), 2)}`;
}

/** A month-name list from messages (the genitives, or the Month's short names): 14 non-empty strings. */
function isMonthList(list: readonly string[] | undefined): list is readonly string[] {
  return (
    Array.isArray(list) &&
    list.length === HEBREW_MONTHS.length &&
    list.every(entry => typeof entry === 'string' && entry.trim() !== '')
  );
}

/**
 * The month as a day label names it. Hebrew: without nikud ("חשון"). Russian: the
 * genitive from the list ("хешвана", Ruling R9), or the nominative ("Хешван") when the
 * list is missing or broken. English: hebcal's name ("Cheshvan").
 */
function monthLabel(hd: HDate, lang: Lang, genitive: readonly string[] | undefined): string {
  const name = hd.getMonthName();
  if (lang === 'he') {
    return Locale.lookupTranslation(name, 'he-x-NoNikud') ?? Locale.hebrewStripNikkud(Locale.gettext(name, 'he'));
  }
  if (lang === 'ru') {
    const index = (HEBREW_MONTHS as readonly string[]).indexOf(name);
    if (index >= 0 && isMonthList(genitive)) return genitive[index];
    return Locale.lookupTranslation(name, 'ru') ?? name;
  }
  return name;
}

/** The Hebrew day number: gematriya in Hebrew ("ט״ז"), digits otherwise ("16"). */
function dayNumber(hd: HDate, lang: Lang): string {
  return lang === 'he' ? gematriya(hd.getDate()) : String(hd.getDate());
}

/** The Hebrew year: gematriya in Hebrew ("תשפ״ז"), digits otherwise ("5787"). */
function yearLabel(hd: HDate, lang: Lang): string {
  return lang === 'he' ? gematriya(hd.getFullYear()) : String(hd.getFullYear());
}

function dayLabel(hd: HDate, lang: Lang, genitive: readonly string[] | undefined): string {
  const day = dayNumber(hd, lang);
  const month = monthLabel(hd, lang, genitive);
  return lang === 'he' ? `${day} ב${month}` : `${day} ${month}`;
}

/**
 * The Hebrew day and month of a day key: "4 Cheshvan", "ד׳ בחשון", "4 хешвана".
 * `genitive` is `calendarHome.hebrewMonthGenitive` (14 entries in HEBREW_MONTHS order);
 * only Russian reads it. Returns '' for a key that isn't a real day.
 */
export function hebrewDayLabel(dayKey: DayKey, lang: string, genitive?: readonly string[]): string {
  const hd = hebrewDateOf(dayKey);
  return hd ? dayLabel(hd, langOf(lang), genitive) : '';
}

/**
 * The Hebrew date with its year: "4 Cheshvan 5787", "ד׳ בחשון תשפ״ז", "4 хешвана 5787".
 * `genitive` as for hebrewDayLabel. Returns '' for a key that isn't a real day.
 */
export function hebrewFullDate(dayKey: DayKey, lang: string, genitive?: readonly string[]): string {
  const hd = hebrewDateOf(dayKey);
  if (!hd) return '';
  const l = langOf(lang);
  return `${dayLabel(hd, l, genitive)} ${yearLabel(hd, l)}`;
}

/**
 * The first and last Hebrew months a run of days touches (spec §7.8's month headers; a
 * month in between is skipped), with the year on both sides only when it differs:
 * "Elul 5786 – Tishrei 5787", "Tishrei – Cheshvan 5787", or one month, "Cheshvan 5788".
 * Hebrew: names without nikud and a gematriya year ("אלול תשפ״ו – תשרי תשפ״ז"). Russian:
 * the nominative (Ruling R9, "Тишрей – Хешван 5787"). '' when a key isn't a real day or
 * `lastKey` is before `firstKey`.
 */
export function hebrewMonthRange(firstKey: DayKey, lastKey: DayKey, lang: string): string {
  const a = hebrewDateOf(firstKey);
  const b = hebrewDateOf(lastKey);
  if (!a || !b || lastKey < firstKey) return '';
  const l = langOf(lang);
  const first = monthLabel(a, l, undefined);
  const last = monthLabel(b, l, undefined);
  if (a.getFullYear() !== b.getFullYear()) return `${first} ${yearLabel(a, l)} – ${last} ${yearLabel(b, l)}`;
  if (a.getMonth() === b.getMonth()) return `${first} ${yearLabel(b, l)}`;
  return `${first} – ${last} ${yearLabel(b, l)}`;
}

/** A Gregorian month's Hebrew months, for its header: hebrewMonthRange(1st, last day). '' for a malformed month. */
export function hebrewMonthHeader(month: MonthKey, lang: string): string {
  const first = monthFirstDay(month);
  return first ? hebrewMonthRange(first, monthLastDay(month), lang) : '';
}

/** Whether a day key is Hebrew day 1 (the cells that name the month); false for a malformed key. */
export function isHebrewMonthStart(dayKey: DayKey): boolean {
  return hebrewDateOf(dayKey)?.getDate() === 1;
}

/**
 * The month's short name from `shortMonths` (`calendarHome.hebrewMonthShort`, 14 entries in
 * HEBREW_MONTHS order). With no list, or a broken one, the month as hebrewDayLabel names
 * it without a genitive list: "Cheshvan", "חשון", "Хешван".
 */
function shortMonthName(hd: HDate, lang: Lang, shortMonths: readonly string[] | undefined): string {
  const index = (HEBREW_MONTHS as readonly string[]).indexOf(hd.getMonthName());
  return index >= 0 && isMonthList(shortMonths) ? shortMonths[index] : monthLabel(hd, lang, undefined);
}

/**
 * A Month cell's Hebrew day: the day alone ("16" / "ט״ז" / "16"), or with the month's short
 * name ("1 Chesh." / "א׳ חשון" / "1 хешв."). `shortMonths` is
 * `calendarHome.hebrewMonthShort`; with no list, or a broken one, the month reads "1
 * Cheshvan" / "א׳ חשון" / "1 Хешван". '' for a key that isn't a real day.
 */
export function hebrewCellLabel(dayKey: DayKey, lang: string, withMonth: boolean, shortMonths?: readonly string[]): string {
  const hd = hebrewDateOf(dayKey);
  if (!hd) return '';
  const l = langOf(lang);
  const day = dayNumber(hd, l);
  return withMonth ? `${day} ${shortMonthName(hd, l, shortMonths)}` : day;
}

/**
 * The month's short name alone, for the browse cell's second line (Plan E Ruling 3: on
 * Hebrew day 1 and on the month's first cell): "Chesh." / "חשון" / "хешв.", with
 * hebrewCellLabel's fallback ("Cheshvan" / "חשון" / "Хешван"). '' for a key that isn't a
 * real day.
 */
export function hebrewCellMonth(dayKey: DayKey, lang: string, shortMonths?: readonly string[]): string {
  const hd = hebrewDateOf(dayKey);
  return hd ? shortMonthName(hd, langOf(lang), shortMonths) : '';
}

/** The Hebrew month of a day, named as a title names it and without its year: "Adar II" / "אדר ב׳" / "Адар II". '' for a key that isn't a real day. */
export function hebrewMonthOf(dayKey: DayKey, lang: string): string {
  const hd = hebrewDateOf(dayKey);
  return hd ? monthLabel(hd, langOf(lang), undefined) : '';
}

/** A Hebrew year as a title writes it: gematriya in Hebrew ("תשפ״ז"), digits otherwise ("5787"). */
export function hebrewYearText(year: number, lang: string): string {
  return langOf(lang) === 'he' ? gematriya(year) : String(year);
}

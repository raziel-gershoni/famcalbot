// Hebrew dates on the calendar home (spec §7.8): the full date under the header
// ("4 Cheshvan 5787") and the Hebrew date beside each Agenda day ("4 Cheshvan").
// Client-safe and pure. It uses @hebcal/hdate and the Russian month names only, never
// @hebcal/core, which would pull the holiday tables into the home's bundle.
//
// A day key is a calendar day in the viewer's timezone. Its Hebrew date is the daytime
// date of that day (no sunset shift), so it never depends on the device's clock.

import { HDate, Locale, gematriya, type MonthName } from '@hebcal/hdate';
// Adds Russian to @hebcal/hdate's Locale. package.json pins @hebcal/hdate to the one copy
// @hebcal/core and @hebcal/locales share, so this is the same Locale the bot reads.
import '@hebcal/locales/ru';
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
function hebrewDateOf(dayKey: DayKey): HDate | null {
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

function isGenitiveList(list: readonly string[] | undefined): list is readonly string[] {
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
    if (index >= 0 && isGenitiveList(genitive)) return genitive[index];
    return Locale.lookupTranslation(name, 'ru') ?? name;
  }
  return name;
}

function dayLabel(hd: HDate, lang: Lang, genitive: readonly string[] | undefined): string {
  const month = monthLabel(hd, lang, genitive);
  return lang === 'he' ? `${gematriya(hd.getDate())} ב${month}` : `${hd.getDate()} ${month}`;
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
  const year = l === 'he' ? gematriya(hd.getFullYear()) : String(hd.getFullYear());
  return `${dayLabel(hd, l, genitive)} ${year}`;
}

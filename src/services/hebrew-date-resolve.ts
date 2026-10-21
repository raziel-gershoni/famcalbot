/**
 * A Hebrew date the user spoke, turned into a calendar day on the server (hebrew-repeats spec §5).
 *
 * The model only reads the words ("10 Tevet", "י׳ בטבת", "10 тевета", with a Hebrew year if one was
 * said); it never converts, because models convert dates unreliably. This is the conversion, done
 * with hebcal: the given year, or, with no year, the next occurrence on or after today.
 *
 * Days are daytime dates with no sunset shift, which is the home's rule. Pure: no clock of its own,
 * no I/O. The day it returns is a 'yyyy-MM-dd' key read in the user's zone.
 */

import { HDate, months } from '@hebcal/hdate';
import { HEBREW_MONTHS } from '../lib/calendar-view/hebrew-date';

/** The month names the prompt offers the model, Adar I and Adar II apart. */
export type HebrewMonthName = (typeof HEBREW_MONTHS)[number];

/** A Hebrew date as the model reads it from speech. */
export interface SpokenHebrewDate {
  day: number;
  month: HebrewMonthName;
  /** The Hebrew year (5786), only when the user said one. */
  year?: number;
}

/** How far ahead "the next occurrence" looks: the longest gap a date can have is a few years (30 Cheshvan). */
const SEARCH_YEARS = 20;

const FIRST_YEAR = 5000;
const LAST_YEAR = 6999;

/** The model's spelling of a month, folded to letters and single spaces so "Sh'vat" and "shvat" meet. */
const fold = (name: string) => name.toLowerCase().replace(/['’`.]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/** Spellings a model drifts to, by their folded form, beside the exact names of the prompt. */
const MONTH_ALIASES: Record<string, HebrewMonthName> = {
  tishri: 'Tishrei',
  heshvan: 'Cheshvan',
  marcheshvan: 'Cheshvan',
  'mar cheshvan': 'Cheshvan',
  teves: 'Tevet',
  shvat: "Sh'vat",
  shevat: "Sh'vat",
  'adar 1': 'Adar I',
  'adar 2': 'Adar II',
  'adar a': 'Adar I',
  'adar b': 'Adar II',
  iyar: 'Iyyar',
  tammuz: 'Tamuz',
};
const MONTHS_BY_FOLDED = new Map<string, HebrewMonthName>([
  ...HEBREW_MONTHS.map((name): [string, HebrewMonthName] => [fold(name), name]),
  ...Object.entries(MONTH_ALIASES),
]);

export interface ReadSpokenHebrewDate {
  /** The date, when the model gave a readable day and month. */
  date?: SpokenHebrewDate;
  /** What was wrong, for the log: an unreadable date, or a year that is no year (the date still stands without it). */
  problems: string[];
}

/**
 * The model's `hebrewDate`, validated: a whole day 1 to 30, a month the prompt names, and a year
 * that is a Hebrew year. A year of three digits is the short form Hebrew speech uses (786 is 5786).
 * A date that cannot be read gives no `date`; a bad year only loses the year.
 */
export function readSpokenHebrewDate(raw: unknown): ReadSpokenHebrewDate {
  const problems: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { problems: [`hebrewDate is not an object: ${JSON.stringify(raw)}`] };
  }
  const { day, month, year } = raw as { day?: unknown; month?: unknown; year?: unknown };
  if (typeof day !== 'number' || !Number.isInteger(day) || day < 1 || day > 30) {
    return { problems: [`hebrewDate day is not a day from 1 to 30: ${JSON.stringify(day)}`] };
  }
  const name = typeof month === 'string' ? MONTHS_BY_FOLDED.get(fold(month)) : undefined;
  if (!name) return { problems: [`hebrewDate month is not a Hebrew month: ${JSON.stringify(month)}`] };

  let readYear: number | undefined;
  if (year !== null && year !== undefined) {
    const full = typeof year === 'number' && Number.isInteger(year) && year >= 100 && year < 1000 ? year + 5000 : year;
    if (typeof full === 'number' && Number.isInteger(full) && full >= FIRST_YEAR && full <= LAST_YEAR) readYear = full;
    else problems.push(`hebrewDate year is not a Hebrew year, read as none: ${JSON.stringify(year)}`);
  }
  return { date: { day, month: name, ...(readYear !== undefined ? { year: readYear } : {}) }, problems };
}

/**
 * The month number hebcal uses for a spoken month in a Hebrew year, or null when that year has no
 * such month (Adar I in a common year).
 */
function monthNumber(name: HebrewMonthName, year: number): number | null {
  const leap = HDate.isLeapYear(year);
  switch (name) {
    case 'Adar I': return leap ? months.ADAR_I : null;
    case 'Adar II': return leap ? months.ADAR_II : null;
    // The only Adar of a common year; in a leap year the plain Adar of speech is Adar II
    case 'Adar': return leap ? months.ADAR_II : months.ADAR_I;
    case 'Tishrei': return months.TISHREI;
    case 'Cheshvan': return months.CHESHVAN;
    case 'Kislev': return months.KISLEV;
    case 'Tevet': return months.TEVET;
    case "Sh'vat": return months.SHVAT;
    case 'Nisan': return months.NISAN;
    case 'Iyyar': return months.IYYAR;
    case 'Sivan': return months.SIVAN;
    case 'Tamuz': return months.TAMUZ;
    case 'Av': return months.AV;
    case 'Elul': return months.ELUL;
  }
}

const pad = (n: number) => String(n).padStart(2, '0');

/** The day a Hebrew date falls on in one Hebrew year, as 'yyyy-MM-dd', or null when that year has no such day (30 Cheshvan in a short year). */
function dayIn(spoken: SpokenHebrewDate, year: number): string | null {
  const month = monthNumber(spoken.month, year);
  if (month === null || spoken.day > HDate.daysInMonth(month, year)) return null;
  // hebcal hands back local midnight of the civil day, so the local getters read it exactly
  const greg = new HDate(spoken.day, month, year).greg();
  return `${greg.getFullYear()}-${pad(greg.getMonth() + 1)}-${pad(greg.getDate())}`;
}

/**
 * The calendar day of a spoken Hebrew date, as 'yyyy-MM-dd'. With a year it is that year's day
 * (null when the year has no such day). Without one it is the first day on or after `today`
 * ('yyyy-MM-dd' in the user's zone), skipping the years in which the day does not exist; null
 * when none comes within SEARCH_YEARS. A plain "Adar" is read as spoken: Adar II in a leap year.
 */
export function resolveSpokenHebrewDate(spoken: SpokenHebrewDate, today: string): string | null {
  if (spoken.year !== undefined) return dayIn(spoken, spoken.year);
  const [y, m, d] = today.split('-').map(Number);
  const first = new HDate(new Date(y, m - 1, d)).getFullYear();
  for (let year = first; year < first + SEARCH_YEARS; year++) {
    const date = dayIn(spoken, year);
    if (date && date >= today) return date;
  }
  return null;
}

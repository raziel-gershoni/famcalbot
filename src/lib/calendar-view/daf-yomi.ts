// The day's Daf Yomi page on the calendar home (spec §6, release 1): "Daf Yomi · Arachin 3".
// Client-safe and pure. It uses @hebcal/hdate and the `dafYomiBase` subpath of
// @hebcal/learning only, never @hebcal/core or the package's main entry (which imports
// @hebcal/core and would pull its tables into the home's bundle).
//
// A day key is a calendar day, so its page never depends on the device's clock: the day is
// read only through hebrewDateOf. The date check comes first because hebcal throws a
// RangeError for a day before the first cycle (11 September 1923) and the Month reaches
// back to January 1900; React must never see that error.
//
// The tractate's name is never hebcal's translation: the caller passes FamCal's own table
// (calendarHome.dafYomi.tractates, keyed by hebcal's English name).

import { gematriya } from '@hebcal/hdate';
import { DafYomi } from '@hebcal/learning/dafYomiBase';
import { hebrewDateOf } from './hebrew-date';
import type { DayKey } from './types';

/** The first day of the first cycle, 11 September 1923. */
export const DAF_YOMI_FIRST_DAY: DayKey = '1923-09-11';

export interface DafOfDay {
  /** hebcal's English name, the key of FamCal's tractate table. */
  tractate: string;
  page: number;
}

/** The day's page, or null for a key that is no real day or is before the first cycle. */
export function dafYomiOf(day: DayKey): DafOfDay | null {
  const hdate = hebrewDateOf(day);
  if (!hdate || day < DAF_YOMI_FIRST_DAY) return null;
  const daf = new DafYomi(hdate);
  return { tractate: daf.getName(), page: Number(daf.getBlatt()) };
}

/** The page in gematriya in Hebrew ("ג׳", "ט״ו"), digits in every other language. */
export function dafPageText(page: number, lang: string): string {
  return lang === 'he' ? gematriya(page) : String(page);
}

/**
 * The line's two arguments for a day. A tractate the table lacks shows hebcal's English
 * name rather than hiding the line (the smoke makes that impossible).
 */
export function dafYomiWords(
  day: DayKey,
  lang: string,
  tractates: Readonly<Record<string, string>>
): { tractate: string; page: string } | null {
  const daf = dafYomiOf(day);
  if (!daf) return null;
  return { tractate: tractates[daf.tractate] ?? daf.tractate, page: dafPageText(daf.page, lang) };
}

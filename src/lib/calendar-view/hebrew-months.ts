// Hebrew month keys for the Month's arithmetic. Client-safe and pure: @hebcal/hdate only
// (never @hebcal/core), no clock, and no server timezone: a day key is read as the UTC day it
// names, and hebcal is fed day numbers (abs), never a Date.
//
// A key is 'hYYYY-PP': the Hebrew year and the month's place counted from Tishrei (01…12 in
// a common year, 01…13 in a leap one). hebcal numbers its months Nisan = 1 … Elul = 6,
// Tishrei = 7 … Adar (Adar I in a leap year) = 12, Adar II = 13.

import { HDate } from '@hebcal/hdate';
import type { DayKey } from './types';

/** A month key: 'yyyy-MM' (civil) or 'hYYYY-PP' (Hebrew). */
type MonthKey = string;

const HEBREW_KEY = /^h(\d{4})-(\d{2})$/;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
/** hebcal's day number of 1970-01-01, so a day key maps to a day number by UTC arithmetic. */
const ABS_OF_EPOCH = 719_163;
const MAX_YEAR = 9999;

/** hebcal's day number of a real 'yyyy-MM-dd' day; null otherwise. */
function absOfDay(day: DayKey): number | null {
  if (!DAY_KEY.test(day)) return null;
  const [y, m, d] = day.split('-').map(Number);
  const ms = Date.UTC(y, m - 1, d, 12);
  if (new Date(ms).toISOString().slice(0, 10) !== day) return null;
  return Math.floor(ms / DAY_MS) + ABS_OF_EPOCH;
}

function dayOfAbs(abs: number): DayKey {
  return new Date((abs - ABS_OF_EPOCH) * DAY_MS + DAY_MS / 2).toISOString().slice(0, 10);
}

const pad = (n: number, width: number) => String(n).padStart(width, '0');

/** The month's place from Tishrei, given hebcal's month number. */
function placeOf(hebcalMonth: number, leap: boolean): number {
  if (hebcalMonth >= 7) return hebcalMonth - 6;
  return hebcalMonth + (leap ? 7 : 6);
}

/** hebcal's month number of a place from Tishrei. */
function hebcalMonthOf(place: number, leap: boolean): number {
  if (leap) return place <= 7 ? place + 6 : place - 7;
  return place <= 6 ? place + 6 : place - 6;
}

function parse(key: MonthKey): { year: number; place: number } | null {
  const match = HEBREW_KEY.exec(key);
  if (!match) return null;
  const year = Number(match[1]);
  const place = Number(match[2]);
  if (year < 1 || place < 1 || place > HDate.monthsInYear(year)) return null;
  return { year, place };
}

/** Whether a key is a real Hebrew month: place 1 … the year's month count. */
export function isHebrewMonthKey(key: string): boolean {
  return parse(key) !== null;
}

/** The Hebrew month of a day key; '' for a malformed day. */
export function hebrewMonthKeyOf(day: DayKey): MonthKey {
  const abs = absOfDay(day);
  if (abs === null) return '';
  const hd = new HDate(abs);
  const year = hd.getFullYear();
  if (year < 1 || year > MAX_YEAR) return '';
  return `h${pad(year, 4)}-${pad(placeOf(hd.getMonth(), HDate.isLeapYear(year)), 2)}`;
}

/** The months before a Hebrew year (the 19-year cycle's count), so ordinals run on across years. */
function monthsBefore(year: number): number {
  return Math.floor((235 * year - 234) / 19);
}

/** A month's number counting on across years; null for a key that isn't a real Hebrew month. */
export function hebrewMonthOrdinal(key: MonthKey): number | null {
  const parsed = parse(key);
  return parsed ? monthsBefore(parsed.year) + parsed.place - 1 : null;
}

/** The month at an ordinal; '' outside the years a key can write. */
export function hebrewMonthAt(ordinal: number): MonthKey {
  if (!Number.isInteger(ordinal)) return '';
  let year = Math.floor((ordinal * 19) / 235) + 1;
  while (monthsBefore(year + 1) <= ordinal) year++;
  while (monthsBefore(year) > ordinal) year--;
  if (year < 1 || year > MAX_YEAR) return '';
  return `h${pad(year, 4)}-${pad(ordinal - monthsBefore(year) + 1, 2)}`;
}

/** The month's real civil days (not cut to any reach); null for a key that isn't a real Hebrew month. */
export function hebrewMonthDays(key: MonthKey): { first: DayKey; last: DayKey } | null {
  const parsed = parse(key);
  if (!parsed) return null;
  const month = hebcalMonthOf(parsed.place, HDate.isLeapYear(parsed.year));
  const first = new HDate(1, month, parsed.year).abs();
  return { first: dayOfAbs(first), last: dayOfAbs(first + HDate.daysInMonth(month, parsed.year) - 1) };
}

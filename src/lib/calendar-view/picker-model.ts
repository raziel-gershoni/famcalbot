// The date and time pickers as pure logic (editor upgrades spec §1): paging by Gregorian or
// Hebrew month, the six-row page, the limits, the wheels' lists and the labels. Client-safe
// and pure: no React, no clock (the caller passes today), no timezone. It reads the home's
// own helpers (grid.ts, hebrew-date.ts, format.ts) and @hebcal/hdate, never @hebcal/core.
//
// - A page is one month of the chosen calendar: its first and last civil day (yyyy-MM-dd).
//   Gregorian: the 1st to the last day. Hebrew: Hebrew day 1 to 29 or 30, so Adar I and Adar II
//   of a leap year are two pages and a common year has one Adar.
// - Every page is drawn as 6 rows of 7, so paging never moves the sheet; a cell outside the
//   page is null (blank), as in the Month (R12).
// - Limits are days: the year floor (year-limits.ts) and the "not before" day an end carries.
//   A day past a limit is shown greyed and can't be picked.

import { HDate, type MonthName } from '@hebcal/hdate';
import { MAX_YEAR, MIN_YEAR_BIRTH } from './year-limits';
import { monthFirstDay, monthLastDay, monthOf } from './grid';
import { formatDayFull, formatDayMonth, formatMonthRange, formatMonthTitle } from './format';
import {
  HEBREW_MONTHS,
  dayKeyOfHDate,
  hebrewCellLabel,
  hebrewDateOf,
  hebrewDayLabel,
  hebrewFullDate,
  hebrewMonthHeader,
  hebrewMonthOf,
  hebrewMonthRange,
  hebrewYearText,
  isHebrewMonthStart,
} from './hebrew-date';
import { addDaysToKey } from './store';
import type { DayKey, WeekStart } from './types';

export type PickerMode = 'gregorian' | 'hebrew';

/** The earliest and latest day any picker offers. */
export const PICKER_MIN_DAY: DayKey = `${MIN_YEAR_BIRTH}-01-01`;
export const PICKER_MAX_DAY: DayKey = `${MAX_YEAR}-12-31`;

const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Whether `value` is a real yyyy-MM-dd day (no limit applied). */
export function isDayKey(value: string): boolean {
  const m = DAY_KEY.exec(value);
  if (!m) return false;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
  return new Date(ms).toISOString().slice(0, 10) === value;
}

/** 0 (Sunday) to 6 of a real day. */
function weekdayIndex(day: DayKey): number {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
}

// ---- Limits ----

export interface PickerLimits {
  /** The first day that can be picked. */
  min: DayKey;
  /** The last day that can be picked. */
  max: DayKey;
}

/**
 * The days a picker offers: from the year floor (`minYear`, year-limits.ts minYearFor) or the
 * day an end may not precede (`notBefore`), whichever is later, to 31 December 2100. A
 * `notBefore` that isn't a real day is ignored.
 */
export function limitsFor(minYear: number, notBefore?: DayKey | null): PickerLimits {
  const floor: DayKey = `${String(Math.min(Math.max(minYear, MIN_YEAR_BIRTH), MAX_YEAR)).padStart(4, '0')}-01-01`;
  const min = notBefore && isDayKey(notBefore) && notBefore > floor ? notBefore : floor;
  return { min: min > PICKER_MAX_DAY ? PICKER_MAX_DAY : min, max: PICKER_MAX_DAY };
}

/** Whether a day is past a limit (greyed, not pickable). */
export function isDisabledDay(day: DayKey, limits: PickerLimits): boolean {
  return day < limits.min || day > limits.max;
}

/** `day` held inside the limits. */
export function clampDay(day: DayKey, limits: PickerLimits): DayKey {
  return day < limits.min ? limits.min : day > limits.max ? limits.max : day;
}

// ---- Pages ----

export interface PickerPage {
  mode: PickerMode;
  /** The page's first civil day. */
  first: DayKey;
  /** The page's last civil day. */
  last: DayKey;
}

/** The page of `mode` that holds `day`; null for a key that isn't a real day. */
export function pageOf(mode: PickerMode, day: DayKey): PickerPage | null {
  if (!isDayKey(day)) return null;
  if (mode === 'gregorian') {
    const month = monthOf(day);
    return { mode, first: monthFirstDay(month), last: monthLastDay(month) };
  }
  const hd = hebrewDateOf(day);
  if (!hd) return null;
  const first = new HDate(1, hd.getMonth(), hd.getFullYear());
  const last = new HDate(first.daysInMonth(), hd.getMonth(), hd.getFullYear());
  return { mode, first: dayKeyOfHDate(first), last: dayKeyOfHDate(last) };
}

/** The page `n` months after this one (before it when negative); the page itself when the step leaves the real days. */
export function stepPage(page: PickerPage, n: number): PickerPage {
  let current = page;
  for (let i = 0; i < Math.abs(n); i++) {
    const next = pageOf(page.mode, n > 0 ? addDaysToKey(current.last, 1) : addDaysToKey(current.first, -1));
    if (!next) return current;
    current = next;
  }
  return current;
}

/** Whether the page one step `direction` (1 or -1) on holds a day inside the limits. */
export function canStep(page: PickerPage, direction: 1 | -1, limits: PickerLimits): boolean {
  const next = stepPage(page, direction);
  if (next === page) return false;
  return direction === 1 ? next.first <= limits.max : next.last >= limits.min;
}

/** `page`, or the nearest page that holds a day inside the limits. */
export function clampPage(page: PickerPage, limits: PickerLimits): PickerPage {
  if (page.last < limits.min) return pageOf(page.mode, limits.min) ?? page;
  if (page.first > limits.max) return pageOf(page.mode, limits.max) ?? page;
  return page;
}

/** The rows a page is always drawn in. */
export const PAGE_ROWS = 6;

/**
 * The page's 6 rows of 7 days from `weekStart`, `null` where a cell is outside the page. A
 * month never needs more than 6 rows, so paging never changes the sheet's height.
 */
export function pageCells(page: PickerPage, weekStart: WeekStart): (DayKey | null)[][] {
  const ws = Number.isInteger(weekStart) && weekStart >= 0 && weekStart <= 6 ? weekStart : 0;
  const lead = (weekdayIndex(page.first) - ws + 7) % 7;
  const rows: (DayKey | null)[][] = [];
  for (let r = 0; r < PAGE_ROWS; r++) {
    rows.push(
      Array.from({ length: 7 }, (_, c) => {
        const day = addDaysToKey(page.first, r * 7 + c - lead);
        return day >= page.first && day <= page.last ? day : null;
      }),
    );
  }
  return rows;
}

/** The page's title and, under it, the other calendar's months: "March 2027" over "Adar – Nisan 5787", or the reverse in Hebrew mode. */
export function pageTitle(page: PickerPage, lang: string, hebrewDates: boolean): { title: string; subtitle: string } {
  if (page.mode === 'gregorian') {
    return {
      title: formatMonthTitle(monthOf(page.first), lang, true),
      subtitle: hebrewDates ? hebrewMonthHeader(monthOf(page.first), lang) : '',
    };
  }
  return { title: hebrewMonthRange(page.first, page.last, lang), subtitle: formatMonthRange(page.first, page.last, lang) };
}

// ---- Labels ----

/** What a cell shows: the calendar that leads in big type and, under it, the other (empty without Hebrew dates). */
export interface CellText {
  primary: string;
  secondary: string;
}

/**
 * A cell's two lines. Gregorian mode: the day number over the Hebrew day (with its month on
 * Hebrew day 1). Hebrew mode: the Hebrew day over the Gregorian day (with its month on the 1st).
 * `shortMonths` is `calendarHome.hebrewMonthShort`.
 */
export function cellText(day: DayKey, mode: PickerMode, lang: string, hebrewDates: boolean, shortMonths?: readonly string[]): CellText {
  const gregorian = String(Number(day.slice(8, 10)));
  if (mode === 'hebrew') {
    return {
      primary: hebrewCellLabel(day, lang, false),
      secondary: day.endsWith('-01') ? formatDayMonth(day, lang) : gregorian,
    };
  }
  return { primary: gregorian, secondary: hebrewDates ? hebrewCellLabel(day, lang, isHebrewMonthStart(day), shortMonths) : '' };
}

/** A cell's accessible name, as browse reads it: "Sunday, 14 March 2027, 5 Adar II" (the Hebrew part only with Hebrew dates). `genitive` is `calendarHome.hebrewMonthGenitive`. */
export function dayAriaLabel(day: DayKey, lang: string, hebrewDates: boolean, genitive?: readonly string[]): string {
  const full = formatDayFull(day, lang);
  const hebrew = hebrewDates ? hebrewDayLabel(day, lang, genitive) : '';
  return hebrew ? `${full}, ${hebrew}` : full;
}

/** The footer's choice in both calendars: "Sunday, 14 March 2027 · 5 Adar II 5787" (one calendar without Hebrew dates). */
export function footerText(day: DayKey, lang: string, hebrewDates: boolean, genitive?: readonly string[]): string {
  const full = formatDayFull(day, lang);
  const hebrew = hebrewDates ? hebrewFullDate(day, lang, genitive) : '';
  return hebrew ? `${full} · ${hebrew}` : full;
}

// ---- Keyboard ----

export type DayMove = 'prevDay' | 'nextDay' | 'prevWeek' | 'nextWeek' | 'prevMonth' | 'nextMonth' | 'weekStart' | 'weekEnd';

/**
 * Where a keyboard move from `day` lands on `page`, held inside the limits' pages. Days and
 * weeks step across pages; a month move keeps the day number (the page's last day when it is
 * shorter); the week's ends stay on this page, where the blank cells are.
 */
export function moveDay(day: DayKey, move: DayMove, page: PickerPage, weekStart: WeekStart, limits: PickerLimits): DayKey {
  const ws = Number.isInteger(weekStart) && weekStart >= 0 && weekStart <= 6 ? weekStart : 0;
  let target: DayKey;
  switch (move) {
    case 'prevDay':
      target = addDaysToKey(day, -1);
      break;
    case 'nextDay':
      target = addDaysToKey(day, 1);
      break;
    case 'prevWeek':
      target = addDaysToKey(day, -7);
      break;
    case 'nextWeek':
      target = addDaysToKey(day, 7);
      break;
    case 'prevMonth':
    case 'nextMonth': {
      const to = stepPage(pageOf(page.mode, day) ?? page, move === 'nextMonth' ? 1 : -1);
      const number = page.mode === 'hebrew' ? (hebrewDateOf(day)?.getDate() ?? 1) : Number(day.slice(8, 10));
      const length = daysBetweenKeys(to.first, to.last) + 1;
      target = addDaysToKey(to.first, Math.min(number, length) - 1);
      break;
    }
    case 'weekStart':
    case 'weekEnd': {
      const lead = (weekdayIndex(day) - ws + 7) % 7;
      const edge = move === 'weekStart' ? addDaysToKey(day, -lead) : addDaysToKey(day, 6 - lead);
      target = edge < page.first ? page.first : edge > page.last ? page.last : edge;
      break;
    }
  }
  // Held inside the pages the limits reach: the first page of the min and the last of the max.
  const lowest = pageOf(page.mode, limits.min)?.first ?? limits.min;
  const highest = pageOf(page.mode, limits.max)?.last ?? limits.max;
  return target < lowest ? lowest : target > highest ? highest : target;
}

function daysBetweenKeys(from: DayKey, to: DayKey): number {
  const ms = (k: DayKey) => {
    const [y, m, d] = k.split('-').map(Number);
    return Date.UTC(y, m - 1, d, 12);
  };
  return Math.round((ms(to) - ms(from)) / 86_400_000);
}

// ---- Jump far: the month and year wheels ----

/** A month and a year as the wheels hold them: Gregorian '01' to '12', or a Hebrew month name. */
export interface WheelSelection {
  month: string;
  year: number;
}

/** Whether a Hebrew year has an Adar I and an Adar II. */
export function isLeapHebrewYear(year: number): boolean {
  return HDate.isLeapYear(year);
}

/** The Hebrew months of a year in the order the year runs, from Tishrei: Adar alone in a common year, Adar I and Adar II in a leap year. */
export function hebrewMonthsOfYear(year: number): MonthName[] {
  const leap = isLeapHebrewYear(year);
  return HEBREW_MONTHS.filter((name) => (leap ? name !== 'Adar' : name !== 'Adar I' && name !== 'Adar II'));
}

/** The wheels' years for a mode: 1900 to 2100 (Hebrew 5660 to 5861) cut to the limits. */
export function wheelYears(mode: PickerMode, limits: PickerLimits): number[] {
  const [low, high] = [limits.min, limits.max].map((day) => {
    if (mode === 'gregorian') return Number(day.slice(0, 4));
    return hebrewDateOf(day)?.getFullYear() ?? 0;
  });
  return Array.from({ length: Math.max(0, high - low + 1) }, (_, i) => low + i);
}

/** The month and year a page shows, for the wheels to open on. */
export function selectionOf(page: PickerPage): WheelSelection {
  if (page.mode === 'gregorian') return { month: page.first.slice(5, 7), year: Number(page.first.slice(0, 4)) };
  const hd = hebrewDateOf(page.first);
  return { month: hd?.getMonthName() ?? 'Tishrei', year: hd?.getFullYear() ?? 5660 };
}

/** The Hebrew month a name lands on in `year`: Adar I or II in a common year is Adar, and Adar in a leap year is Adar II. */
export function hebrewMonthIn(name: string, year: number): MonthName {
  const leap = isLeapHebrewYear(year);
  if (!leap && (name === 'Adar I' || name === 'Adar II')) return 'Adar';
  if (leap && name === 'Adar') return 'Adar II';
  return (HEBREW_MONTHS as readonly string[]).includes(name) ? (name as MonthName) : 'Tishrei';
}

/** The page the wheels chose, held to the limits. Adar I or II moved to a common year lands on Adar. */
export function pageOfWheels(mode: PickerMode, selection: WheelSelection, limits: PickerLimits): PickerPage {
  let first: DayKey;
  if (mode === 'gregorian') {
    first = `${String(selection.year).padStart(4, '0')}-${selection.month}-01`;
  } else {
    first = dayKeyOfHDate(new HDate(1, hebrewMonthIn(selection.month, selection.year), selection.year));
  }
  const page = pageOf(mode, first) ?? (pageOf(mode, limits.min) as PickerPage);
  return clampPage(page, limits);
}

/** The month wheel's names for a year ("March" / "Adar II"), as `{ value, label }` for the wheel. */
export function wheelMonths(mode: PickerMode, year: number, lang: string): { value: string; label: string }[] {
  if (mode === 'gregorian') {
    return Array.from({ length: 12 }, (_, i) => {
      const month = String(i + 1).padStart(2, '0');
      return { value: month, label: formatMonthTitle(`2001-${month}`, lang, false) };
    });
  }
  return hebrewMonthsOfYear(year).map((name) => ({
    value: name,
    label: hebrewMonthOf(dayKeyOfHDate(new HDate(1, name, year)), lang),
  }));
}

/** The year wheel's labels: the number, or the Hebrew year in letters in Hebrew. */
export function yearLabel(mode: PickerMode, year: number, lang: string): string {
  return mode === 'hebrew' ? hebrewYearText(year, lang) : String(year);
}

// ---- The time wheels ----

/** The hour wheel: '00' to '23'. */
export function hourOptions(): string[] {
  return Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'));
}

/**
 * The minute wheel: 0 to 59 on a step of `step` minutes. A stored minute off the step
 * (10:07 from Google or the bot) joins the list in its place, so opening and closing the sheet
 * changes nothing.
 */
export function minuteOptions(step: number, current?: string | null): string[] {
  const size = Number.isInteger(step) && step >= 1 && step <= 30 ? step : 5;
  const minutes: number[] = [];
  for (let m = 0; m < 60; m += size) minutes.push(m);
  const now = current !== undefined && current !== null && /^\d{2}$/.test(current) ? Number(current) : null;
  if (now !== null && now < 60 && !minutes.includes(now)) {
    minutes.push(now);
    minutes.sort((a, b) => a - b);
  }
  return minutes.map((m) => String(m).padStart(2, '0'));
}

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** The hour and minute of an 'HH:mm' time, or null when it isn't one. */
export function splitTime(time: string): { hour: string; minute: string } | null {
  const m = TIME.exec(time);
  return m ? { hour: m[1], minute: m[2] } : null;
}

/** 'HH:mm' from the two wheels. */
export function joinTime(hour: string, minute: string): string {
  return `${hour}:${minute}`;
}

// A city's zmanim page as data (spec 2026-10-30-public-zmanim §4.2, §4.3, §6.1, §6.2): the parameters the URL may carry,
// the day's list, the Shabbat and Yom Tov ahead, and the month. The page words and draws it (app/[locale]/(site)/zmanim/
// [city]/page.tsx); the Hebrew dates are written there too (hebrew-date.ts), never stored here.
//
// - One code path with the bot: every row is zmanDayForPlace's (src/services/zmanim/day-list.ts), at the city's point and
//   height under the community's set, so the page and the sun sheet show the same times.
// - Each view has its own memo and asks quietly: a crawler can never flush the bot's process memo, and a zman the sun does
//   not make is shown as a dash, not logged.
// - Holidays follow the city: il = inIsrael(city.timeZone), the same flag the engine's windows read, for the labels too.
// - "Today" is the city's own (instantToWallTime: the repo's wall-time rule), and the range a URL may ask for is a year
//   back to three years ahead of it.
// - A section that fails (a hebcal error) is caught and returned as a failure: the page logs it and words it, and the
//   rest of the page still renders.
//
// Server only by import discipline (it reads src/services/zmanim and @hebcal/core through the holiday module). Pure:
// no database, Redis, network or clock (the page hands it `now`).

import { addMonths, monthFirstDay, monthGrid, monthLastDay, monthOf } from '@/src/lib/calendar-view/grid';
import type { WeekStart } from '@/src/lib/calendar-view/types';
import { WINDOW_ROW_KEYS, type ZmanimListRow } from '@/src/lib/calendar-view/zmanim-list';
import { holidaysInRange, type Holiday } from '@/src/services/hebrew-holidays';
import { inIsrael, restDayBlocks, type Place } from '@/src/services/zmanim/compute';
import { zmanDayForPlace, type ZmanDayList, type ZmanMemo } from '@/src/services/zmanim/day-list';
import { isCommunity, type ZmanimCommunity } from '@/src/services/zmanim/sets';
import type { City } from '@/src/site/cities';
import { addDaysToDate, startOfLocalDay } from '@/src/utils/day-events';
import { weekStartFor } from '@/src/utils/locale-rules';
import { instantToWallTime } from '@/src/utils/wall-time';

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** A Shabbat or Yom Tov listed ahead begins at most this many days after the day shown (spec §4.2.3). */
const AHEAD_DAYS = 8;

/** The most rest days in a row (a Yom Tov on Thursday and Friday, then Shabbat): how far a block reaches past its eve. */
const LONGEST_BLOCK = 3;

export type CityParams = { day: string; community: ZmanimCommunity; today: string; dayFromParam: boolean; communityFromParam: boolean };

/** One day of a window: only its window rows (WINDOW_ROW_KEYS), as the day list gives them. */
export type AheadDay = { day: string; rows: ZmanimListRow[] };

export type AheadWindow = {
  /** The day whose sunset begins it (yyyy-MM-dd in the city's zone). */
  eve: string;
  /** Its last rest day. */
  last: string;
  /** Its Yom Tov days' names, or, with none, its chol hamoed or special Shabbat's. */
  holidays: Holiday[];
  parasha: Holiday | null;
  days: AheadDay[];
  /** The sun does not make its end (the far north in summer): the end row is a dash. */
  endMissing: boolean;
};

export type MonthCell = { day: string; inMonth: boolean; inRange: boolean; holidays: Holiday[]; yomTov: boolean; isToday: boolean; isShown: boolean };

export type MonthEntry = { day: string; holidays: Holiday[]; shabbat: { parasha: Holiday | null; rows: ZmanimListRow[] } | null };

export type MonthView = {
  key: string;
  weekStart: WeekStart;
  prevMonthDay: string | null;
  nextMonthDay: string | null;
  /** null: the month could not be computed (failures says why). */
  weeks: MonthCell[][] | null;
  entries: MonthEntry[] | null;
};

export type CitySection = 'day' | 'ahead' | 'month';
export type SectionFailure = { section: CitySection; error: unknown };

export type CityView = {
  city: City;
  community: ZmanimCommunity;
  isDefaultCommunity: boolean;
  day: string;
  today: string;
  isToday: boolean;
  prevDay: string | null;
  nextDay: string | null;
  /** null: the day could not be computed. */
  list: ZmanDayList | null;
  /** A row of the day has no time (a dash), so the page explains it. */
  hasDash: boolean;
  /** null: the windows could not be computed. */
  ahead: AheadWindow[] | null;
  month: MonthView;
  il: boolean;
  /** The height the times count from, named in the note: Sephardi in Israel above sea level only. */
  heightM: number | null;
  failures: SectionFailure[];
};

/** The city as the engine reads a place. */
export function cityPlace(city: City): Place {
  return { latitude: city.latitude, longitude: city.longitude, elevationM: city.elevationM, timeZone: city.timeZone };
}

/** The owner's rule (spec §2.6): Sephardi in Israel, Ashkenazi abroad. */
export function defaultCommunity(city: City): ZmanimCommunity {
  return inIsrael(city.timeZone) ? 'sephardi' : 'ashkenazi';
}

/** Today in the city, yyyy-MM-dd, by the city's own clock. */
export function cityToday(city: City, now: Date): string {
  return instantToWallTime(now, city.timeZone).slice(0, 10);
}

function isRealDay(day: string): boolean {
  if (!DAY_KEY.test(day)) return false;
  const ms = Date.parse(`${day}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === day;
}

/** The same month and day `years` years on; 29 February is 28 February in a year without one. */
function yearsOn(day: string, years: number): string {
  const year = String(Number(day.slice(0, 4)) + years).padStart(4, '0');
  const moved = `${year}${day.slice(4)}`;
  return isRealDay(moved) ? moved : `${year}-02-28`;
}

function rangeOf(today: string): { first: string; last: string } {
  return { first: yearsOn(today, -1), last: yearsOn(today, 3) };
}

/** The days a URL may ask for: a year before today to three years after it, in the city (spec §4.3). */
export function publicRange(city: City, now: Date): { first: string; last: string } {
  return rangeOf(cityToday(city, now));
}

/** A parameter Next passes as one string; a repeated one (?date=a&date=b reaches the page as an array) is no value. */
const single = (value: string | string[] | undefined): string | undefined => (typeof value === 'string' ? value : undefined);

/**
 * The day and community a city page shows. `?date=yyyy-MM-dd` inside the range, else today; `?community=` one of the three
 * sets, else the city's default. A value that is missing, repeated, malformed, out of range or the default itself is
 * dropped (review focus d): the page shows today or the default, and nothing throws.
 */
export function readCityParams(city: City, search: Record<string, string | string[] | undefined>, now: Date): CityParams {
  const today = cityToday(city, now);
  const range = rangeOf(today);
  const asked = single(search.date);
  const day = asked !== undefined && isRealDay(asked) && asked >= range.first && asked <= range.last ? asked : null;
  const fallback = defaultCommunity(city);
  const wanted = single(search.community);
  const community = isCommunity(wanted) && wanted !== fallback ? wanted : null;
  return { day: day ?? today, community: community ?? fallback, today, dayFromParam: day !== null, communityFromParam: community !== null };
}

/** The days from `first` to `last`, both included. */
function daysFrom(first: string, last: string): string[] {
  const out: string[] = [];
  for (let day = first; day <= last; day = addDaysToDate(day, 1)) out.push(day);
  return out;
}

const weekdayOf = (day: string): number => new Date(`${day}T00:00:00Z`).getUTCDay();

function uniqueByTitle(holidays: Holiday[]): Holiday[] {
  const seen = new Set<string>();
  return holidays.filter((h) => (seen.has(h.title) ? false : (seen.add(h.title), true)));
}

/** Rows a list component draws, for one day's window rows (the hours line stays off: hours []). */
export function windowList(view: CityView, day: string, rows: ZmanimListRow[]): ZmanDayList {
  return { day, tz: view.city.timeZone, community: view.community, rows, hours: [] };
}

/** The view of `city` for `params`, in `locale`'s words: one memo, quiet, every section on its own. */
export function buildCityView(city: City, params: CityParams, locale: string): CityView {
  const place = cityPlace(city);
  const il = inIsrael(city.timeZone);
  const { day, community, today } = params;
  const range = rangeOf(today);
  const memo: ZmanMemo = new Map();
  const listOf = (d: string): ZmanDayList => zmanDayForPlace(place, community, d, { memo, quiet: true });
  const windowRows = (d: string): ZmanimListRow[] => listOf(d).rows.filter((row) => WINDOW_ROW_KEYS.includes(row.key));

  const failures: SectionFailure[] = [];
  const attempt = <T>(section: CitySection, build: () => T): T | null => {
    try {
      return build();
    } catch (error) {
      failures.push({ section, error });
      return null;
    }
  };

  const list = attempt('day', () => listOf(day));

  const ahead = attempt('ahead', (): AheadWindow[] => {
    const until = addDaysToDate(day, AHEAD_DAYS);
    const blocks = restDayBlocks(
      { from: startOfLocalDay(addDaysToDate(day, -LONGEST_BLOCK), city.timeZone), to: startOfLocalDay(addDaysToDate(until, LONGEST_BLOCK + 1), city.timeZone) },
      place,
      community,
    )
      // The one under way on the day shown (it ends on it or later), and every one that begins within AHEAD_DAYS
      .filter((block) => block.last >= day && block.eve <= until)
      .sort((a, b) => (a.eve < b.eve ? -1 : a.eve > b.eve ? 1 : 0));
    if (blocks.length === 0) return [];
    const holidays = holidaysInRange(blocks[0].eve, blocks[blocks.length - 1].last, locale, { il });
    return blocks.map((block) => {
      const found = daysFrom(addDaysToDate(block.eve, 1), block.last).flatMap((d) => holidays[d] ?? []);
      const chag = found.filter((h) => h.chag);
      return {
        eve: block.eve,
        last: block.last,
        holidays: uniqueByTitle(chag.length > 0 ? chag : found.filter((h) => h.kind === 'cholHamoed' || h.kind === 'specialShabbat')),
        parasha: found.find((h) => h.kind === 'parasha') ?? null,
        days: daysFrom(block.eve, block.last).map((d) => ({ day: d, rows: windowRows(d) })),
        endMissing: block.end === null,
      };
    });
  });

  const key = monthOf(day);
  const weekStart = weekStartFor({ culture: 'jewish', language: locale, tz: city.timeZone, tzKnown: true });
  const prevKey = addMonths(key, -1);
  const nextFirst = monthFirstDay(addMonths(key, 1));
  const prevFirst = monthFirstDay(prevKey);
  const prevMonthDay = monthLastDay(prevKey) >= range.first ? (prevFirst < range.first ? range.first : prevFirst) : null;
  const nextMonthDay = nextFirst <= range.last ? nextFirst : null;
  const body = attempt('month', () => {
    const firstDay = monthFirstDay(key);
    const lastDay = monthLastDay(key);
    const holidays = holidaysInRange(firstDay, lastDay, locale, { il });
    // A cell marks a holiday, not the weekly portion or its special Shabbat (they are no holiday: hebrew-holidays.ts)
    const marked = (d: string) => (holidays[d] ?? []).filter((h) => h.kind !== 'parasha' && h.kind !== 'specialShabbat');
    const weeks: MonthCell[][] = monthGrid(key, weekStart).map((week) =>
      week.map((d) => {
        const inMonth = d.slice(0, 7) === key;
        const marks = inMonth ? marked(d) : [];
        return { day: d, inMonth, inRange: d >= range.first && d <= range.last, holidays: marks, yomTov: marks.some((h) => h.chag), isToday: d === today, isShown: d === day };
      }),
    );
    const entries: MonthEntry[] = [];
    for (const d of daysFrom(firstDay, lastDay)) {
      const named = (holidays[d] ?? []).filter((h) => h.kind !== 'parasha');
      const saturday = weekdayOf(d) === 6;
      if (!saturday && named.length === 0) continue;
      entries.push({
        day: d,
        holidays: named,
        // The Shabbat's own rows: the Friday's candles, and the Saturday's end (or its "not before", into a Yom Tov)
        shabbat: saturday ? { parasha: (holidays[d] ?? []).find((h) => h.kind === 'parasha') ?? null, rows: [...windowRows(addDaysToDate(d, -1)), ...windowRows(d)] } : null,
      });
    }
    return { weeks, entries };
  });

  return {
    city,
    community,
    isDefaultCommunity: community === defaultCommunity(city),
    day,
    today,
    isToday: day === today,
    prevDay: day > range.first ? addDaysToDate(day, -1) : null,
    nextDay: day < range.last ? addDaysToDate(day, 1) : null,
    list,
    hasDash: list?.rows.some((row) => row.at === null) ?? false,
    ahead,
    month: { key, weekStart, prevMonthDay, nextMonthDay, weeks: body?.weeks ?? null, entries: body?.entries ?? null },
    il,
    heightM: community === 'sephardi' && il && city.elevationM !== null && city.elevationM > 0 ? city.elevationM : null,
    failures,
  };
}

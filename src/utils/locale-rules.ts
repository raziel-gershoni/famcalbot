/**
 * Week start and Hebrew dates (spec §6), plus the bot's week boundaries for any week
 * start.
 *
 * Pure: no Prisma, Redis or network, and no Intl week data at runtime (Node 22 and newer
 * Node expose it through different APIs). Server-only by import discipline: the zone table
 * stays off the client, which receives a week-start number and a boolean.
 *
 * Culture and language are not validated when saved, so they are compared strictly.
 */

import { NON_MONDAY_ZONES } from '../config/week-start-zones';
import { addDaysToDate } from './day-events';
import type { WeekStart } from '../lib/calendar-view/types';

/**
 * A week's first day: 0 = Sunday ... 6 = Saturday, as Date.getUTCDay counts. Defined once,
 * in the client-safe src/lib/calendar-view/types.ts: client code imports it from there,
 * never from here, which would pull the zone table into the client bundle.
 */
export type { WeekStart };

/**
 * What the rules decide from: the user's culture and language, the timezone from
 * resolveUserTimezone, and whether that timezone came from the user (tzKnownFor).
 */
export type LocaleFacts = { culture?: string; language?: string; tz: string; tzKnown: boolean };

/** Israel's zone and its old spellings, compared as given. */
export const ISRAEL_ZONES: ReadonlySet<string> = new Set(['Asia/Jerusalem', 'Asia/Tel_Aviv', 'Israel']);

/**
 * Whether the user's timezone comes from them (a location, or Google's settings) rather
 * than the Asia/Jerusalem fallback. resolveUserTimezone caches the fallback like a real
 * answer, so the timezone alone can't tell.
 */
export function tzKnownFor(u: { location?: string | null; googleRefreshToken?: string | null }): boolean {
  return !!u.location || !!u.googleRefreshToken;
}

/** Today's rule for the bot's weeks: Jewish culture starts on Sunday, everyone else on Monday. */
export function legacyWeekStart(culture?: string): 0 | 1 {
  return culture === 'jewish' ? 0 : 1;
}

/** Intl's name for a zone (Asia/Tel_Aviv → Asia/Jerusalem), or null when Intl rejects it. */
function canonicalZone(tz: string): string | null {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** UTC, GMT and Etc/*: zones with no country. */
function isCountrylessZone(zone: string): boolean {
  return zone === 'UTC' || zone === 'GMT' || zone.startsWith('Etc/');
}

function listedStart(zone: string): WeekStart | undefined {
  return Object.hasOwn(NON_MONDAY_ZONES, zone) ? NON_MONDAY_ZONES[zone] : undefined;
}

/**
 * The user's week start, in this order:
 * 1. Jewish culture → Sunday.
 * 2. A known timezone of a country → that country's week start (Monday unless listed).
 * 3. The language: Hebrew and English → Sunday, Russian → Monday.
 * 4. Anything else → Monday.
 */
export function weekStartFor(f: LocaleFacts): WeekStart {
  if (f.culture === 'jewish') return 0;
  if (f.tzKnown && f.tz) {
    const canonical = canonicalZone(f.tz);
    if (canonical !== null && !isCountrylessZone(f.tz) && !isCountrylessZone(canonical)) {
      return listedStart(f.tz) ?? listedStart(canonical) ?? 1;
    }
  }
  if (f.language === 'he' || f.language === 'en') return 0;
  if (f.language === 'ru') return 1;
  return 1;
}

/** Hebrew dates for Jewish culture, the Hebrew language, or a known Israel timezone. */
export function hebrewDatesFor(f: LocaleFacts): boolean {
  return f.culture === 'jewish' || f.language === 'he' || (f.tzKnown && ISRAEL_ZONES.has(f.tz));
}

/** Day of the week of yyyy-MM-dd, 0 = Sunday. */
function weekdayOf(day: string): number {
  return new Date(`${day}T00:00:00Z`).getUTCDay();
}

/**
 * This week's last day (yyyy-MM-dd) for weeks starting on `ws`: the day before the next
 * week start, which is today on the week's last day. With `always7`, 7 days from today.
 * `today` is the user's day (a DayKey). For ws 0 and 1 this is week-lookahead.ts's
 * getNextWeekBoundary for Jewish and default culture.
 */
export function nextWeekBoundary(ws: WeekStart, always7: boolean | undefined, today: string): string {
  const daysUntilBoundary = always7 ? 7 : (((ws + 6) % 7) - weekdayOf(today) + 7) % 7;
  return addDaysToDate(today, daysUntilBoundary);
}

/**
 * Next week's first and last days (yyyy-MM-dd) for weeks starting on `ws`: the next week
 * start after today (a week on when today is one) and the 6 days after it. For ws 0 and 1
 * this is week-lookahead.ts's getNextWeekBoundaries for Jewish and default culture.
 */
export function nextWeekBoundaries(ws: WeekStart, today: string): { first: string; last: string } {
  const first = addDaysToDate(today, ((ws - weekdayOf(today) + 7) % 7) || 7);
  return { first, last: addDaysToDate(first, 6) };
}

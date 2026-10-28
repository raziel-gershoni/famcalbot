/**
 * The heavy half of the pause (pause.ts is the light one): the person's place, their Shabbat and
 * Yom Tov windows, and the per-person per-day cache. Plan:
 * docs/superpowers/plans/2026-10-28-zmanim-reminders.md (Task 2).
 *
 * The place is the person's own (getUserPlace: saved coordinates, filled once from a place name).
 * With none to be had, the timezone's main city stands in (Asia/Jerusalem gives Jerusalem) and
 * that is logged, once a day per person; a zone with no main city in MAIN_CITIES cannot be
 * counted from, so it is not paused and says so.
 *
 * Cached per person per UTC day: the windows overlapping that day (a window that straddles its
 * midnight comes whole, and answering needs no zone work), keyed by the place and the community
 * so a changed location or community is computed again. The switch is
 * never cached: pause.ts reads it from the person every time. The cache is on globalThis: Next 16
 * gives the scheduler and the routes separate module instances (src/lib/timezone.ts).
 */

import { Location } from '@hebcal/core';
import { resolveUserTimezone } from '../../lib/timezone';
import { DEFAULT_COMMUNITY, isCommunity, type ZmanimCommunity } from './sets';
import { shabbatYomTovWindows, type Place } from './compute';
import { getUserPlace, type PlaceUser } from './place';
import type { PauseUser } from './pause';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/**
 * A timezone's main city, by name in hebcal's own list of cities (it holds the coordinates and the
 * height). Only zones whose city hebcal has; the aliases map the older names of a zone to the same city.
 */
export const MAIN_CITIES: Record<string, string> = {
  'Asia/Jerusalem': 'Jerusalem',
  'Asia/Tel_Aviv': 'Jerusalem',
  Israel: 'Jerusalem',
  'America/New_York': 'New York',
  'America/Chicago': 'Chicago',
  'America/Denver': 'Denver',
  'America/Los_Angeles': 'Los Angeles',
  'America/Phoenix': 'Phoenix',
  'America/Detroit': 'Detroit',
  'America/Toronto': 'Toronto',
  'America/Vancouver': 'Vancouver',
  'America/Mexico_City': 'Mexico City',
  'America/Panama': 'Panama City',
  'America/Bogota': 'Bogota',
  'America/La_Paz': 'La Paz',
  'America/Sao_Paulo': 'Sao Paulo',
  'America/Argentina/Buenos_Aires': 'Buenos Aires',
  'Pacific/Honolulu': 'Hawaii',
  'Europe/London': 'London',
  'Europe/Paris': 'Paris',
  'Europe/Berlin': 'Berlin',
  'Europe/Budapest': 'Budapest',
  'Europe/Helsinki': 'Helsinki',
  'Europe/Gibraltar': 'Gibraltar',
  'Europe/Moscow': 'Moscow',
  'Europe/Kiev': 'Kiev',
  'Europe/Kyiv': 'Kiev',
  'Africa/Johannesburg': 'Johannesburg',
  'Asia/Baghdad': 'Baghdad',
  'Australia/Sydney': 'Sydney',
  'Australia/Melbourne': 'Melbourne',
};

/** The Place of a zone's main city (under the person's own zone name), or null where the zone has none. */
export function mainCityPlace(zone: string): Place | null {
  const name = MAIN_CITIES[zone];
  const city = name ? Location.lookup(name) : undefined;
  if (!city) return null;
  return { latitude: city.getLatitude(), longitude: city.getLongitude(), elevationM: city.getElevation(), timeZone: zone };
}

interface Cached {
  /** The UTC day, the place and the community the windows were computed for. */
  key: string;
  /** Epoch ms, half-open [start, end). */
  windows: Array<[number, number]>;
  /** The answer holds for `at` before this (epoch ms). */
  until: number;
}

const shared = globalThis as { __pauseCache?: Map<number, Cached>; __pauseFallbackLoggedOn?: Map<number, number> };
const cache: Map<number, Cached> = (shared.__pauseCache ??= new Map());
/** The UTC day each person's fallback was last logged: the log is once a day per person. */
const fallbackLoggedOn: Map<number, number> = (shared.__pauseFallbackLoggedOn ??= new Map());

/** Smoke scripts only: back to a fresh process. */
export function __resetPauseForTests(): void {
  cache.clear();
  fallbackLoggedOn.clear();
}

function logFallbackOnce(userId: number, day: number, message: string): void {
  if (fallbackLoggedOn.get(userId) === day) return;
  fallbackLoggedOn.set(userId, day);
  console.warn(`[pause] user ${userId} ${message}`);
}

/** The windows for the UTC `day` (a day number since the epoch) at the person's place. */
async function compute(user: PauseUser, at: Date, community: ZmanimCommunity, day: number): Promise<Pick<Cached, 'windows' | 'until'>> {
  const placeUser: PlaceUser = {
    id: user.id,
    location: user.location ?? '',
    latitude: user.latitude ?? null,
    longitude: user.longitude ?? null,
    elevationM: user.elevationM ?? null,
    googleRefreshToken: user.googleRefreshToken,
  };
  const endOfDay = (day + 1) * DAY_MS;
  let place = await getUserPlace(placeUser);
  let until = endOfDay;
  if (!place) {
    const zone = await resolveUserTimezone(placeUser);
    place = mainCityPlace(zone);
    if (!place) {
      logFallbackOnce(user.id, day, `has no usable location and ${zone} has no main city to count Shabbat from: not paused`);
      return { windows: [], until: endOfDay };
    }
    logFallbackOnce(user.id, day, `has no usable location: pausing by the main city of ${zone} (${MAIN_CITIES[zone]})`);
    // A person with a place name may still get coordinates (the lookup is tried again after an hour).
    if (placeUser.location.trim() !== '') until = Math.min(endOfDay, at.getTime() + HOUR_MS);
  }
  const windows = shabbatYomTovWindows({ from: new Date(day * DAY_MS), to: new Date(endOfDay) }, place, community);
  return { windows: windows.map(([start, end]): [number, number] => [start.getTime(), end.getTime()]), until };
}

/**
 * Whether `at` falls inside a window at the person's place. The switch is the caller's (pause.ts).
 * Throws what the place or the windows throw; the caller reads that as "not paused".
 */
export async function pausedAt(user: PauseUser, at: Date): Promise<boolean> {
  const day = Math.floor(at.getTime() / DAY_MS);
  const community = isCommunity(user.zmanimCommunity) ? user.zmanimCommunity : DEFAULT_COMMUNITY;
  const key = [day, user.location ?? '', user.latitude ?? '', user.longitude ?? '', user.elevationM ?? '', community].join('|');
  let entry = cache.get(user.id);
  if (!entry || entry.key !== key || at.getTime() >= entry.until) {
    entry = { key, ...(await compute(user, at, community, day)) };
    cache.set(user.id, entry);
  }
  const t = at.getTime();
  return entry.windows.some(([start, end]) => t >= start && t < end);
}

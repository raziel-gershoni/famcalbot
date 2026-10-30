// "Near me" (spec docs/superpowers/specs/2026-10-30-public-zmanim-design.md §4.1): the nearest listed city to a position,
// found on the device. Client-safe: besides types it imports only the repo's pure clock reader (src/utils/wall-time.ts,
// itself import-free), so the island ships it with the city table, and the position never leaves the browser.
//
// The answer by distance to the nearest city:
//   - within OPEN_KM: that city's page opens;
//   - within NEAR_KM, and only when the city's UTC offset right now is the device's: the page names the city and how far
//     it is;
//   - otherwise none. A city near by in another offset (Amman runs an hour ahead of Israel in winter) is no answer: its
//     times would be read on the wrong clock. A device with no zone, or one Intl does not know, gets no "near" answer
//     either (its offset is unknown); the OPEN_KM band is by distance alone, and nothing here throws for an odd zone.

import { instantToWallTime } from '../utils/wall-time';

export type NearCity = { slug: string; latitude: number; longitude: number; timeZone: string };
export type NearAnswer = { kind: 'open'; slug: string } | { kind: 'near'; slug: string; km: number } | { kind: 'none' };

export const OPEN_KM = 30;
export const NEAR_KM = 100;
/** The mean Earth radius (IUGG), in km. */
const EARTH_RADIUS_KM = 6371.0088;

const radians = (degrees: number): number => (degrees * Math.PI) / 180;

/** The great-circle distance between two points in km, by the haversine formula on the mean Earth radius. */
export function haversineKm(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const dLatitude = radians(b.latitude - a.latitude);
  const dLongitude = radians(b.longitude - a.longitude);
  const h = Math.sin(dLatitude / 2) ** 2 + Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(dLongitude / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * `timeZone`'s offset from UTC at `at`, in minutes east (Israel: 120 in winter, 180 in summer; New York: -300 in winter),
 * read from the zone's clock by instantToWallTime. Throws RangeError for a zone Intl does not know.
 */
export function utcOffsetMinutes(timeZone: string, at: Date): number {
  const wall = instantToWallTime(at, timeZone);
  const [year, month, day, hour, minute, second] = wall.split(/[-T:]/).map(Number);
  const wholeSecond = at.getTime() - (((at.getTime() % 1000) + 1000) % 1000);
  return Math.round((Date.UTC(year, month - 1, day, hour, minute, second) - wholeSecond) / 60_000);
}

/**
 * The device zone's offset at `at`, or null where the browser gave no zone or one Intl does not know (an old or odd
 * browser): then no city is "near" by offset. Logged in the browser's own console, without the zone.
 */
function deviceOffset(deviceZone: string, at: Date): number | null {
  if (!deviceZone) return null;
  try {
    return utcOffsetMinutes(deviceZone, at);
  } catch (error) {
    console.warn('[near-me] the device\'s time zone is not one Intl knows: no "near" answer by offset', error instanceof Error ? error.name : 'unknown error');
    return null;
  }
}

/**
 * What "Near me" answers for `position`: the nearest of `cities` by haversine distance, then the bands above. `deviceZone`
 * is the browser's own zone (Intl.DateTimeFormat().resolvedOptions().timeZone) and `at` the moment of the tap; a missing
 * or unknown one gives no "near" answer, never a throw. `km` is rounded to whole kilometres. No city at all is none.
 */
export function nearAnswer(position: { latitude: number; longitude: number }, deviceZone: string, at: Date, cities: readonly NearCity[]): NearAnswer {
  let nearest: NearCity | null = null;
  let nearestKm = Infinity;
  for (const city of cities) {
    const km = haversineKm(position, city);
    if (km < nearestKm) {
      nearest = city;
      nearestKm = km;
    }
  }
  if (!nearest) return { kind: 'none' };
  if (nearestKm <= OPEN_KM) return { kind: 'open', slug: nearest.slug };
  const device = nearestKm <= NEAR_KM ? deviceOffset(deviceZone, at) : null;
  if (device !== null && utcOffsetMinutes(nearest.timeZone, at) === device) {
    return { kind: 'near', slug: nearest.slug, km: Math.round(nearestKm) };
  }
  return { kind: 'none' };
}

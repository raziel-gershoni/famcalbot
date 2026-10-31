/**
 * A place's IANA time zone from its coordinates, on our own server: geo-tz (MIT) over timezone-boundary-builder's map
 * (© OpenStreetMap contributors, ODbL), its default "1970" data set (the "now" set calls Ariel Asia/Gaza and Kyiv
 * Europe/Athens). No network. Spec docs/superpowers/specs/2026-10-31-open-meteo-replacement-design.md §5 (time zone);
 * plan docs/superpowers/plans/2026-10-31-open-meteo-replacement.md, Task 1.
 *
 * - The map overlaps over the Green Line: Ariel and Ma'ale Adumim get Jerusalem, then Hebron. pickZone: Asia/Jerusalem
 *   when it is among the answers, else the first. Hebron, Ramallah and Gaza keep their own zones.
 * - Coordinates that are not numbers in range, the open sea (Etc/GMT±n) and a lookup that throws (the data file missing
 *   from the image): each is logged under location-lookup and answers null, never a default zone. No coordinates and no
 *   thrown message in a log.
 * - geo-tz caches the map tiles it reads; the cache holds at most TILE_CACHE_MAX of them (the server has 1 GB).
 *
 * Its own leaf module: geocoding.ts and timezone.ts both use it, and timezone.ts imports geocoding.ts (timezone.ts
 * re-exports it). Server only (it reads its data from disk): never in a 'use client' file, the proxy or the edge.
 * next.config.js keeps geo-tz out of the bundle (serverExternalPackages). All three of its data sets sit in node_modules
 * (about 75 MB), which is what `next start` on Railway runs from; this file reads the "1970" one.
 */

import { find, setCache } from 'geo-tz';
import { LRUCache } from 'lru-cache';
import { captureError, captureWarning } from './error-capture';

/** The most zone-map tiles kept in memory at once: FamCal's places fall in a handful of them. */
export const TILE_CACHE_MAX = 32;

const tiles = new LRUCache<string, object>({ max: TILE_CACHE_MAX });
let stored = 0;
// geo-tz takes any store with get and set (CacheOptions.store); set at load, before any lookup.
setCache({
  store: {
    get: (key: string) => tiles.get(key),
    set: (key: string, value: object) => {
      stored++;
      tiles.set(key, value);
    },
  },
});

/** The tiles in memory now, and how many were ever read from disk (the smoke's memory bound). */
export function tileCacheStats(): { size: number; stored: number } {
  return { size: tiles.size, stored };
}

/** True when Intl accepts `zone` as an IANA zone. */
function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false; // Intl's RangeError is the answer, not a failure to report
  }
}

/** The zone the West Bank rule picks from the map's answers: Asia/Jerusalem when listed, else the first; null for none. */
export function pickZone(zones: readonly string[]): string | null {
  if (zones.includes('Asia/Jerusalem')) return 'Asia/Jerusalem';
  return zones[0] ?? null;
}

/**
 * What a throw from the map is reported as. geo-tz's own messages can carry the coordinate ("Invalid latitude: 32.1"),
 * and a place is the person's: only the error's name goes out, plus its errno code when it has one (ENOENT tells a
 * missing data file from a bug).
 */
function describeThrow(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,24}$/.test(code) ? `${name}, ${code}` : name;
}

/**
 * The IANA zone at the coordinates, or null (logged under location-lookup, never with the coordinates) when they are not
 * numbers in range or the map has no zone, puts the place at sea (Etc/…) or answers a zone Intl does not know
 * (warnings), or when the map throws (an error: most likely its data file is missing from the image). Sync and local.
 */
export function zoneForCoords(latitude: number, longitude: number): string | null {
  const context = { service: 'timezone' };
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    captureWarning('The zone lookup was given coordinates that are not valid', 'location-lookup', context);
    return null;
  }
  let zones: string[];
  try {
    zones = find(latitude, longitude);
  } catch (error) {
    captureError(new Error(`The zone map lookup threw (${describeThrow(error)})`), 'location-lookup', context);
    return null;
  }
  const zone = pickZone(zones);
  if (zone === null) {
    captureWarning('The zone map has no zone for the place', 'location-lookup', context);
    return null;
  }
  if (zone.startsWith('Etc/')) {
    captureWarning(`The zone map puts the place at sea (${zone}): no zone`, 'location-lookup', context);
    return null;
  }
  if (!isValidTimeZone(zone)) {
    captureWarning(`The zone map's ${zone} is not a zone Intl knows`, 'location-lookup', context);
    return null;
  }
  return zone;
}

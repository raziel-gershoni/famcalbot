/**
 * Where a person is, for zmanim: their coordinates and the highest ground in their place, saved
 * with their location and filled lazily for anyone who has a place name and none of these.
 * Plan: docs/superpowers/plans/2026-10-28-zmanim-reminders.md (Task 1).
 *
 *   saveUserPlace          the one writer of User.latitude / longitude / elevationM (a saved location,
 *                          the lazy fill and the height's retry all go through it); a saved place wakes the
 *                          native reminders' due gate, because every time counted from it has moved
 *   ensureUserCoordinates  the lazy fill: once per person and place, logged (`background`: started, not waited for)
 *   retryMissingElevation  a place in Israel saved without a height (its request failed) is looked up again in
 *                          the background, at most once an hour
 *   getUserPlace           a Place for compute.ts: coordinates (filled if need be) + the person's zone
 *
 * The elevation is the highest point in the place (Rav Ovadia's rule): a 5 x 5 grid over the
 * place's Nominatim bounding box, capped at 3 km around the centre, sampled with Open-Meteo's free
 * elevation API in one request; the highest of the 25 is kept. A failure of that request is
 * logged and leaves the elevation null: it never blocks saving the place.
 *
 * The lookups are resolveLocation's (src/lib/timezone.ts) and the same 3 s, no-retry policy.
 */

import { prisma } from '../../utils/prisma';
import { redis } from '../../utils/redis';
import { REDIS_KEYS } from '../../config/redis-keys';
import { captureError, captureWarning } from '../../lib/error-capture';
import { LOOKUP_TIMEOUT_MS, TIMEZONE_CACHE_TTL, resolveLocation, resolveUserTimezone, type BoundingBox } from '../../lib/timezone';
import { fetchWithTimeout } from '../weather/geocoding';
import { invalidateDueGate } from '../native-reminders/due-gate';
import { inIsrael } from '../../utils/locale-rules';
import type { Place } from './compute';

/** The grid is this many points on a side: 5 x 5 = 25, well under Open-Meteo's 100 per request. */
const GRID_SIDE = 5;
/** The grid reaches at most this far from the place's centre, in metres. */
const MAX_REACH_M = 3000;
const METRES_PER_DEGREE_LATITUDE = 111_320;
/** After a lazy fill finds nothing, the same person and place are not looked up again for this long. */
const RETRY_AFTER_MS = 60 * 60 * 1000;

export interface Coordinates {
  latitude: number;
  longitude: number;
}

/** The fields of a user the place is read from. `UserConfig` has all of them. */
export interface PlaceUser {
  id: number;
  location: string;
  latitude: number | null;
  longitude: number | null;
  elevationM: number | null;
  googleRefreshToken?: string;
  telegramId?: number | null;
}

/** What a saved place holds. */
export interface SavedPlace extends Coordinates {
  elevationM: number | null;
  /** The zone the lookup found; null when that request failed. */
  timeZone: string | null;
}

/**
 * The 25 points to ask the elevation of: a 5 x 5 grid over the place's bounding box, each edge
 * pulled in to at most 3 km from the centre. Just the centre where Nominatim sent no box.
 */
export function elevationGrid(centre: Coordinates, box: BoundingBox | null): Coordinates[] {
  if (!box) return [centre];
  const reachLatitude = MAX_REACH_M / METRES_PER_DEGREE_LATITUDE;
  const reachLongitude = MAX_REACH_M / (METRES_PER_DEGREE_LATITUDE * Math.max(Math.cos((centre.latitude * Math.PI) / 180), 0.01));
  const south = Math.max(box[0], centre.latitude - reachLatitude);
  const north = Math.min(box[1], centre.latitude + reachLatitude);
  const west = Math.max(box[2], centre.longitude - reachLongitude);
  const east = Math.min(box[3], centre.longitude + reachLongitude);
  if (!(south <= north && west <= east)) return [centre];
  const points: Coordinates[] = [];
  for (let row = 0; row < GRID_SIDE; row++) {
    for (let column = 0; column < GRID_SIDE; column++) {
      points.push({
        latitude: south + ((north - south) * row) / (GRID_SIDE - 1),
        longitude: west + ((east - west) * column) / (GRID_SIDE - 1),
      });
    }
  }
  return points;
}

/**
 * The highest ground among `points`, in whole metres, from one Open-Meteo request
 * (https://api.open-meteo.com/v1/elevation?latitude=a,b&longitude=x,y answers {"elevation":[m, m]}).
 * Null, and logged, when the request fails or answers no numbers.
 */
export async function fetchHighestElevation(points: Coordinates[], userId: number): Promise<number | null> {
  const context = { service: 'zmanim', user_id: userId };
  try {
    const latitudes = points.map(point => point.latitude.toFixed(5)).join(',');
    const longitudes = points.map(point => point.longitude.toFixed(5)).join(',');
    const response = await fetchWithTimeout(`https://api.open-meteo.com/v1/elevation?latitude=${latitudes}&longitude=${longitudes}`, {}, LOOKUP_TIMEOUT_MS, 0);
    if (!response.ok) {
      captureWarning(`Open-Meteo's elevation answered ${response.status}: the place is kept without an elevation`, 'zmanim-elevation', context);
      return null;
    }
    const { elevation } = await response.json() as { elevation?: unknown };
    const metres = Array.isArray(elevation) ? elevation.filter((value): value is number => typeof value === 'number' && Number.isFinite(value)) : [];
    if (metres.length === 0) {
      captureWarning("Open-Meteo's elevation sent no numbers: the place is kept without an elevation", 'zmanim-elevation', context);
      return null;
    }
    return Math.round(Math.max(...metres));
  } catch (error) {
    captureError(error, 'zmanim-elevation', context, 'warning');
    return null;
  }
}

/**
 * Looks `location` (trimmed) up and saves its coordinates and highest ground on the user, and
 * the zone the lookup found in the zone cache. The one writer of those columns. Nothing is
 * written when the user's stored location is no longer `location` (two quick saves each schedule a
 * lookup, and the older can land last). A failed elevation leaves it null; a failed zone leaves
 * the cached one as it is. Null when the place is not found or was changed meanwhile; throws
 * only what the database or Redis throws.
 */
export async function saveUserPlace(userId: number, location: string): Promise<SavedPlace | null> {
  const resolved = await resolveLocation(location);
  if (!resolved) {
    console.warn(`[zmanim] no coordinates for user ${userId}: the lookup found no place`);
    return null;
  }
  const points = elevationGrid(resolved, resolved.boundingBox);
  const elevationM = await fetchHighestElevation(points, userId);

  // A row that is gone reads as ''. Compared trimmed, as the save compares it.
  const stored = await prisma.user.findUnique({ where: { id: userId }, select: { location: true } });
  if (!stored || stored.location.trim() !== location) {
    console.warn(`[zmanim] the location of user ${userId} changed while it was looked up: nothing saved`);
    return null;
  }
  // Compare and set in one statement: a save in between leaves the count at 0.
  const { count } = await prisma.user.updateMany({
    where: { id: userId, location: stored.location },
    data: { latitude: resolved.latitude, longitude: resolved.longitude, elevationM },
  });
  if (count === 0) {
    console.warn(`[zmanim] the location of user ${userId} changed while it was saved: nothing saved`);
    return null;
  }
  console.log(`[zmanim] place saved for user ${userId}: centre ${resolved.latitude.toFixed(4)},${resolved.longitude.toFixed(4)}, highest ground ${elevationM === null ? 'unknown' : `${elevationM} m`} over ${points.length} point(s)`);
  // Every zman time counted from this place has moved: the due gate holds the earliest due time of the old one for up to
  // an hour, so a reminder whose new time is earlier would wait for it.
  invalidateDueGate();

  if (resolved.timezone) await redis.set(REDIS_KEYS.userTimezone(userId), resolved.timezone, { ex: TIMEZONE_CACHE_TTL });
  return { latitude: resolved.latitude, longitude: resolved.longitude, elevationM, timeZone: resolved.timezone };
}

/** Whether the user has both coordinates saved (numbers: a null or a missing field is none). */
function hasCoordinates(user: Pick<PlaceUser, 'latitude' | 'longitude'>): user is { latitude: number; longitude: number } & typeof user {
  return typeof user.latitude === 'number' && typeof user.longitude === 'number';
}

/**
 * The lazy fills, on globalThis (Next 16 gives the scheduler and the routes separate module
 * instances), keyed `${userId}|${location}`: the ones running, the ones that found a place (so a
 * caller holding the user as it was before the fill gets it without another lookup), and when
 * each that found nothing last tried.
 */
interface FillState {
  running: Map<string, Promise<(Coordinates & { elevationM: number | null }) | null>>;
  filled: Map<string, Coordinates & { elevationM: number | null }>;
  failedAt: Map<string, number>;
}
const shared = globalThis as { __zmanimPlaceFill?: FillState };
const fills: FillState = (shared.__zmanimPlaceFill ??= { running: new Map(), filled: new Map(), failedAt: new Map() });

/** What the lookups give a place: its coordinates and highest ground (null where that request failed). */
type FilledPlace = Coordinates & { elevationM: number | null };

/** The key of a person and their place name in the lazy fills (a row from a cache that predates the columns may lack the name). */
const fillKey = (user: Pick<PlaceUser, 'id' | 'location'>): string => `${user.id}|${(user.location ?? '').trim()}`;

/**
 * Starts the lookup that saves `location` on the user (saveUserPlace), shared by every caller that needs it: one at a
 * time per person and place, its outcome remembered for the process. A place saved without a height is also marked as
 * tried, so the height's retry (retryMissingElevation) waits an hour after a lookup that has just failed to find it.
 */
function startFill(userId: number, location: string, key: string): Promise<FilledPlace | null> {
  const fill = saveUserPlace(userId, location)
    .then(saved => {
      if (!saved) {
        fills.failedAt.set(key, performance.now());
        return null;
      }
      const place = { latitude: saved.latitude, longitude: saved.longitude, elevationM: saved.elevationM };
      fills.filled.set(key, place);
      if (place.elevationM === null) fills.failedAt.set(key, performance.now());
      return place;
    })
    .catch(error => {
      captureError(error, 'zmanim-place-fill', { service: 'zmanim', user_id: userId }, 'warning');
      fills.failedAt.set(key, performance.now());
      return null;
    })
    .finally(() => {
      fills.running.delete(key);
    });
  fills.running.set(key, fill);
  return fill;
}

/**
 * The user's coordinates and highest ground: the saved ones, else (a place name and none of
 * these) filled now, once: the lookup is saved in the database, remembered for the process, and
 * logged. Null for a user with no place name, or whose place the lookup does not find (tried
 * again after an hour). Never throws: a failure is logged and reads as no place.
 *
 * `background`: a lookup this call would have to wait for is started (or joined) and the answer is null at once, for a
 * caller that has a stand-in for this one time and must not be held up for up to three 3 s requests (the editor's info).
 */
export async function ensureUserCoordinates(user: PlaceUser, options: { background?: boolean } = {}): Promise<FilledPlace | null> {
  const key = fillKey(user);
  // typeof, not !== null: a user read from a cache that predates these columns has them undefined.
  if (hasCoordinates(user)) {
    const own = { latitude: user.latitude, longitude: user.longitude, elevationM: typeof user.elevationM === 'number' ? user.elevationM : null };
    // A height the row lacks may have been found since the caller read it (retryMissingElevation).
    return own.elevationM === null ? (fills.filled.get(key) ?? own) : own;
  }
  const location = (user.location ?? '').trim();
  if (location === '') return null;

  const known = fills.filled.get(key);
  if (known) return known;
  const failedAt = fills.failedAt.get(key);
  if (failedAt !== undefined && performance.now() - failedAt < RETRY_AFTER_MS) return null;
  const running = fills.running.get(key);
  if (running) return options.background ? null : running;

  console.log(`[zmanim] user ${user.id} has a place name and no coordinates: filling them in, once`);
  const fill = startFill(user.id, location, key);
  return options.background ? null : fill;
}

/**
 * A place saved in Israel without a height (the elevation request failed when it was saved) is looked up again, in the
 * background and at most once an hour per person and place: the Sephardi times and the pause's windows there are cut at
 * the elevation, so a missing height is a few minutes off for good otherwise. Nothing waits for it, and nothing is asked
 * where the height is not used (abroad, sea level), where the row has it, or for a person with no place name. The height
 * found is saved (saveUserPlace) and read by callers still holding the row as they read it (ensureUserCoordinates).
 */
export function retryMissingElevation(user: PlaceUser, zone: string): void {
  if (!inIsrael(zone) || !hasCoordinates(user) || typeof user.elevationM === 'number') return;
  const location = (user.location ?? '').trim();
  if (location === '') return;
  const key = fillKey(user);
  if (typeof fills.filled.get(key)?.elevationM === 'number' || fills.running.has(key)) return;
  const failedAt = fills.failedAt.get(key);
  if (failedAt !== undefined && performance.now() - failedAt < RETRY_AFTER_MS) return;
  console.log(`[zmanim] user ${user.id} has a place in Israel and no height: looking it up again, in the background`);
  void startFill(user.id, location, key);
}

/** A Place from a user's saved coordinates and a zone, or null where the user has no coordinates. */
export function placeOf(user: Pick<PlaceUser, 'latitude' | 'longitude' | 'elevationM'>, timeZone: string): Place | null {
  if (!hasCoordinates(user)) return null;
  return { latitude: user.latitude, longitude: user.longitude, elevationM: typeof user.elevationM === 'number' ? user.elevationM : null, timeZone };
}

/**
 * The Place of a user whose coordinates `ensureUserCoordinates` found, in their zone: with no height in Israel the place
 * is used as it is now and the height is looked up again in the background (retryMissingElevation). The one way a caller
 * turns those coordinates into a Place.
 */
export function placeWithHeightRetry(user: PlaceUser, coordinates: FilledPlace, timeZone: string): Place | null {
  if (coordinates.elevationM === null) retryMissingElevation(user, timeZone);
  return placeOf(coordinates, timeZone);
}

/**
 * The user's Place for compute.ts: their coordinates (filled once if they have a place name and
 * none) and their timezone (resolveUserTimezone). Null where there are no coordinates to be had
 * (no place name, or a place the lookup does not find): the caller falls back as its own task says
 * and logs that; a lookup that fails has been logged here.
 */
export async function getUserPlace(user: PlaceUser): Promise<Place | null> {
  const coordinates = await ensureUserCoordinates(user);
  if (!coordinates) return null;
  return placeWithHeightRetry(user, coordinates, await resolveUserTimezone(user));
}

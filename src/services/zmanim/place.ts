/**
 * Where a person is, for zmanim: their coordinates and the highest ground in their place, saved
 * with their location and filled lazily for anyone who has a place name and none of these.
 * Plan: docs/superpowers/plans/2026-10-28-zmanim-reminders.md (Task 1).
 *
 *   saveUserPlace          the one writer of User.latitude / longitude / elevationM (a saved location,
 *                          the lazy fill and the height's retry all go through it); a saved place wakes the
 *                          native reminders' due gate, because every time counted from it has moved
 *   ensureUserCoordinates  the lazy fill: once per person and place, logged (`background`: started, not waited for)
 *   retryMissingElevation  a place in Israel saved without a height (the map had none, or could not be read) is looked up again in
 *                          the background, at most once an hour
 *   getUserPlace           a Place for compute.ts: coordinates (filled if need be) + the person's zone
 *
 * The elevation is the highest point in the place (Rav Ovadia's rule): a 5 x 5 grid over the
 * place's Nominatim bounding box, capped at 3 km around the centre (elevationGrid, in the pure
 * elevation-grid.ts), read from the stored Israel height map (heights.ts, Copernicus GLO-90); the highest of the 25 is kept.
 * It is read only for a place whose zone is Israel's, the only places whose height is used (compute.ts); a failure is
 * logged and leaves the elevation null: it never blocks saving the place.
 *
 * The place lookup is resolveLocation's (src/lib/timezone.ts): Nominatim, 3 s, no retry; the zone and the height are local.
 */

import { prisma } from '../../utils/prisma';
import { redis } from '../../utils/redis';
import { REDIS_KEYS } from '../../config/redis-keys';
import { captureError, captureWarning } from '../../lib/error-capture';
import { TIMEZONE_CACHE_TTL, resolveLocation, resolveUserTimezone } from '../../lib/timezone';
import { invalidateDueGate } from '../native-reminders/due-gate';
import { inIsrael } from '../../utils/locale-rules';
import type { Place } from './compute';
import { elevationGrid, type Coordinates } from './elevation-grid';
import { highestHeight } from './heights';

// The grid lives in the pure elevation-grid.ts, so scripts/build-city-heights.ts counts the public cities' heights by the same rule.
export { elevationGrid, type Coordinates } from './elevation-grid';

/** After a lazy fill finds nothing, the same person and place are not looked up again for this long. */
const RETRY_AFTER_MS = 60 * 60 * 1000;

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
  /** The zone our map gives the place; null when it has none (at sea). */
  timeZone: string | null;
}

/**
 * The highest ground among `points`, in whole metres, from the stored Israel height map (heights.ts). Null, and logged
 * under zmanim-elevation, when no point is on the map (a warning) or the map can't be read (an error): the place is
 * kept without an elevation.
 */
export function fetchHighestElevation(points: Coordinates[], userId: number): number | null {
  const context = { service: 'zmanim', user_id: userId };
  try {
    const metres = highestHeight(points);
    if (metres === null) captureWarning('No point of the place is on the Israel height map: the place is kept without an elevation', 'zmanim-elevation', context);
    return metres;
  } catch (error) {
    captureError(error, 'zmanim-elevation', context);
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
  // The height is read only where it is used: the Sephardi times in Israel (compute.ts). Abroad the place has none.
  const israeli = resolved.timezone !== null && inIsrael(resolved.timezone);
  const points = israeli ? elevationGrid(resolved, resolved.boundingBox) : [];
  const elevationM = israeli ? fetchHighestElevation(points, userId) : null;

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
  console.log(`[zmanim] place saved for user ${userId}: centre ${resolved.latitude.toFixed(4)},${resolved.longitude.toFixed(4)}, highest ground ${israeli ? `${elevationM === null ? 'unknown' : `${elevationM} m`} over ${points.length} point(s)` : 'not read (abroad)'}`);
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

/** What the lookups give a place: its coordinates and highest ground (null where the map had none or could not be read, and abroad). */
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
 * caller that has a stand-in for this one time and must not be held up for the 3 s place lookup (the editor's info).
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
 * A place saved in Israel without a height (the map had none, or could not be read, when it was saved) is looked up again, in the
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

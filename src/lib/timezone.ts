/**
 * User Timezone Resolution
 * Resolves user's timezone via Redis cache → Geocoding → Google Calendar → UTC
 */

import { redis } from '@/src/utils/redis';
import { TIMEZONE } from '../config/constants';
import { REDIS_KEYS } from '../config/redis-keys';
import { getUserCalendarTimezone } from '../services/calendar';
import { geocodeLocation } from '../services/weather/geocoding';
import { captureInfo, captureWarning } from './error-capture';

const TIMEZONE_CACHE_TTL = 24 * 60 * 60; // 24 hours in seconds

/**
 * Resolve user's timezone dynamically
 * Priority: Redis cache → Geocoding → Google Calendar → UTC
 * Caches successful result for 24h to avoid repeated API calls
 */
export async function resolveUserTimezone(
  user: { id: number; location?: string; googleRefreshToken?: string; telegramId?: number | null }
): Promise<string> {
  const cacheKey = REDIS_KEYS.userTimezone(user.id);

  // 1. Check Redis cache
  const cached = await redis.get<string>(cacheKey);
  if (cached) return cached;

  // 2. Try geocoding from location (with 1 retry)
  if (user.location) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const geo = await geocodeLocation(user.location);
        if (geo.timezone) {
          await redis.set(cacheKey, geo.timezone, { ex: TIMEZONE_CACHE_TTL });
          return geo.timezone;
        }
        break; // got result but no timezone, don't retry
      } catch {
        if (attempt === 0) await new Promise(r => setTimeout(r, 2000));
      }
    }
  }

  // 3. Try Google Calendar settings (with 1 retry)
  if (user.googleRefreshToken) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const gcalTz = await getUserCalendarTimezone(user.googleRefreshToken);
        if (gcalTz) {
          await redis.set(cacheKey, gcalTz, { ex: TIMEZONE_CACHE_TTL });
          return gcalTz;
        }
        break;
      } catch {
        if (attempt === 0) await new Promise(r => setTimeout(r, 2000));
      }
    }
  }

  // 4. No timezone resolved — fall back to the default (cached once per 24h).
  // Distinguish "a configured source failed" (worth a warning — e.g. a revoked
  // Google token or a geocoding outage) from "no source configured at all"
  // (expected for location-less WhatsApp users — log at info, not as an error).
  const attemptedSource = !!user.location || !!user.googleRefreshToken;
  const ctx = {
    user_id: user.id,
    service: 'timezone',
    hasToken: !!user.googleRefreshToken,
    location: user.location || '(none)',
  };
  if (attemptedSource) {
    captureWarning('Timezone sources failed; using default', 'timezone-resolution', ctx);
  } else {
    captureInfo('No timezone source configured; using default', 'timezone-resolution', ctx);
  }

  await redis.set(cacheKey, TIMEZONE, { ex: TIMEZONE_CACHE_TTL });
  return TIMEZONE;
}

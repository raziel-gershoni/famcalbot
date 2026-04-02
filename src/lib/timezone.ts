/**
 * User Timezone Resolution
 * Resolves user's timezone via Redis cache → Geocoding → Google Calendar → UTC
 */

import { redis } from '@/src/utils/redis';
import { TIMEZONE } from '../config/constants';
import { REDIS_KEYS } from '../config/redis-keys';
import { getUserCalendarTimezone } from '../services/calendar';
import { geocodeLocation } from '../services/weather/geocoding';
import { captureError } from './error-capture';

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

  // 4. Fallback to UTC — log Sentry warning once per 24h (cached)
  captureError(
    new Error('No timezone source available'),
    'timezone-resolution',
    {
      user_id: user.id,
      service: 'timezone',
      hasToken: !!user.googleRefreshToken,
      location: user.location || '(none)',
    },
    'warning'
  );

  await redis.set(cacheKey, TIMEZONE, { ex: TIMEZONE_CACHE_TTL });
  return TIMEZONE;
}

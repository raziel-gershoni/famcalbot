/**
 * User Timezone Resolution
 * Dynamically resolves user's timezone from Google Calendar or location
 */

import { TIMEZONE } from '../config/constants';
import { getUserCalendarTimezone } from '../services/calendar';
import { captureError } from './error-capture';

/**
 * Location to timezone mapping for common locations
 * Covers most users without needing a geocoding API
 */
const LOCATION_TIMEZONE_MAP: Record<string, string> = {
  // Israel
  'israel': 'Asia/Jerusalem',
  'tel aviv': 'Asia/Jerusalem',
  'jerusalem': 'Asia/Jerusalem',
  'haifa': 'Asia/Jerusalem',
  // Russia
  'russia': 'Europe/Moscow',
  'moscow': 'Europe/Moscow',
  'санкт-петербург': 'Europe/Moscow',
  'saint petersburg': 'Europe/Moscow',
  // USA
  'new york': 'America/New_York',
  'los angeles': 'America/Los_Angeles',
  'chicago': 'America/Chicago',
  // Europe
  'london': 'Europe/London',
  'paris': 'Europe/Paris',
  'berlin': 'Europe/Berlin',
  'amsterdam': 'Europe/Amsterdam',
};

/**
 * Infer timezone from location string
 * @param location - User's location (e.g., "Haifa, Israel")
 * @returns IANA timezone or null if not found
 */
export function inferTimezoneFromLocation(location: string): string | null {
  const lower = location.toLowerCase();
  for (const [key, tz] of Object.entries(LOCATION_TIMEZONE_MAP)) {
    if (lower.includes(key)) return tz;
  }
  return null;
}

/**
 * Resolve user's timezone dynamically
 * Priority: Google Calendar → Location → Fallback
 * Logs to Sentry if no timezone source available
 */
export async function resolveUserTimezone(
  user: { location?: string; googleRefreshToken?: string; telegramId: number }
): Promise<string> {
  // 1. Try Google Calendar settings (most authoritative)
  if (user.googleRefreshToken) {
    const gcalTz = await getUserCalendarTimezone(user.googleRefreshToken);
    if (gcalTz) return gcalTz;
  }

  // 2. Try inferring from location
  if (user.location) {
    const locationTz = inferTimezoneFromLocation(user.location);
    if (locationTz) return locationTz;
  }

  // 3. Log to Sentry - no timezone source available
  captureError(
    new Error('No timezone source available'),
    'timezone-resolution',
    {
      user_id: user.telegramId,
      service: 'timezone',
      hasToken: !!user.googleRefreshToken,
      location: user.location || '(none)'
    },
    'warning'
  );

  // 4. Fallback to default
  return TIMEZONE;
}

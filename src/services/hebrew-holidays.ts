/**
 * Jewish Holiday Detection via CalBrew API
 * Replaces simple Rosh Chodesh check with full holiday support
 */

import { redis } from '../utils/redis';
import { REDIS_KEYS } from '../config/redis-keys';
import { captureError } from '../lib/error-capture';

const CALBREW_API_URL = 'https://calbrew.vercel.app/api/v1/dates/holidays';

interface CalBrewHoliday {
  title: string;
  gregorianDate: string;
  type: string;
}

/**
 * Get holiday names for a specific date via CalBrew API
 * Returns array of holiday titles, empty array if no holidays
 * Caches in Redis for 24h (holidays don't change)
 */
export async function getHolidaysForDate(date: Date, language: string, timezone: string): Promise<string[]> {
  const token = process.env.CALBREW_API_TOKEN;
  if (!token) return [];

  // Format date as YYYY-MM-DD in user's timezone
  const dateStr = date.toLocaleDateString('en-CA', { timeZone: timezone }); // en-CA gives YYYY-MM-DD

  // Check cache first
  const cacheKey = REDIS_KEYS.holidays(dateStr, language);
  const cached = await redis.get(cacheKey);
  if (cached) {
    // Upstash may return parsed JSON (array) or raw string
    if (Array.isArray(cached)) return cached as string[];
    if (typeof cached === 'string') {
      try { return JSON.parse(cached); } catch { return [cached]; }
    }
  }

  try {
    const lang = language === 'he' ? 'he' : language === 'ru' ? 'ru' : 'en';
    const url = `${CALBREW_API_URL}?startDate=${dateStr}&endDate=${dateStr}&language=${lang}&types=majorHolidays,minorHolidays,roshChodesh`;

    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      throw new Error(`CalBrew API error: ${response.status}`);
    }

    const data = await response.json() as { success: boolean; data: { holidays: CalBrewHoliday[] } };
    if (!data.success) {
      throw new Error('CalBrew API returned success: false');
    }

    const titles = data.data.holidays.map(h => h.title);

    // Cache for 24h
    await redis.set(cacheKey, JSON.stringify(titles), { ex: 86400 });

    return titles;
  } catch (error) {
    console.error('[CalBrew] Failed to fetch holidays:', error);
    captureError(error, 'calbrew-holidays', { date: dateStr, language }, 'warning');

    // Fallback: check Rosh Chodesh via hebcal (existing behavior)
    try {
      const { HDate } = await import('@hebcal/core');
      const localDate = new Date(date.toLocaleString('en-US', { timeZone: timezone }));
      const hdate = new HDate(localDate);
      const day = hdate.getDate();
      if (day === 1 || day === 30) {
        const { Locale } = await import('@hebcal/core');
        const monthName = Locale.lookupTranslation(hdate.getMonthName(), language === 'he' ? 'he' : 'en') || hdate.getMonthName();
        return [`Rosh Chodesh ${monthName}`];
      }
    } catch { /* ignore fallback errors */ }

    return [];
  }
}

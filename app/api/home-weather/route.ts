/**
 * GET /api/home-weather: today's weather in the calendar home's header, at the person's saved place.
 *
 *   ?user_id=<id>&locale=<en|he|ru>      (a locale that is none of these reads as en)
 *   X-Telegram-Init-Data: <initData>     (or the __Host-famcal_session cookie in a browser)
 *
 * The answer is { weather: HomeWeather } (src/lib/calendar-view/home-weather.ts): the temperature now, today's low and
 * high, the icon's name and the condition in the person's language (homeWeatherOf, src/services/weather/home-weather.ts).
 * No place saved: { weather: null }, with no geocode and no forecast request. The forecast is fetchWeather's, the same as
 * the /weather command's, at the place's own zone; a failure is 502 { error: 'no_forecast' } and the header shows nothing.
 * The summaries' weather switch does not matter here. Authenticated like the sun sheet's list.
 */

import { NextRequest } from 'next/server';
import { verifyUserAuth } from '@/src/lib/api-auth';
import { calendarRateLimiter } from '@/src/lib/rate-limit';
import { requestInitData } from '@/src/lib/request-init-data';
import { captureError } from '@/src/lib/error-capture';
import { getBotMessages } from '@/src/lib/bot-messages';
import { routing } from '@/i18n/routing';
import { fetchWeather } from '@/src/services/weather/forecast';
import { getTimezone } from '@/src/services/weather/geocoding';
import { homeWeatherOf } from '@/src/services/weather/home-weather';
import { authFailure, json } from '@/src/services/calendar-write/respond';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  // A GET has no body: the init data comes from the header only, never the query.
  const auth = await verifyUserAuth(request, params.get('user_id'), requestInitData(request), calendarRateLimiter, 'home-weather');
  if (!auth.success) return authFailure(auth.response);
  const user = auth.user;
  if (!user.location) return json({ weather: null });
  const asked = params.get('locale');
  const locale = routing.locales.find((l) => l === asked) ?? 'en';
  try {
    // The place's own zone, for the forecast's days (as the /weather command does); no zone is the failure below.
    const zone = await getTimezone(user.location);
    const weather = await fetchWeather(user.location, zone);
    return json({ weather: homeWeatherOf(weather, await getBotMessages(locale)) });
  } catch (err) {
    // The place is the person's free text and the forecast is asked by its coordinates: neither is in a log or a report,
    // and an error's message is not trusted to be free of them. The user id, the error's name and its status say what failed.
    const status = typeof (err as { status?: unknown } | null)?.status === 'number' ? (err as { status: number }).status : null;
    const name = err instanceof Error ? err.name : typeof err;
    const failure = new Error(`no forecast: ${name}${status === null ? '' : ` ${status}`}`);
    captureError(failure, 'home-weather', { user_id: user.id });
    return json({ error: 'no_forecast' }, 502);
  }
}

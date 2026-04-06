import { NextRequest, NextResponse } from 'next/server';
import { getUserById } from '@/src/services/user-service';
import { validateSessionFromRequest } from '@/src/lib/session-auth';
import { verifyUserAccess } from '@/src/lib/telegram-auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/weather-image?user_id=X
 * Generates and returns a weather infographic PNG for the user's location.
 * Used by the Mini App for shareToStory.
 */
export async function GET(request: NextRequest) {
  const userId = request.nextUrl.searchParams.get('user_id');
  const initData = request.nextUrl.searchParams.get('initData');

  if (!userId) {
    return NextResponse.json({ error: 'Missing user_id' }, { status: 400 });
  }

  const userIdNum = parseInt(userId);

  // Auth: session cookie OR Telegram initData
  const sessionUserId = validateSessionFromRequest(request);
  const hasSessionAuth = sessionUserId !== null && sessionUserId === userIdNum;
  const hasTelegramAuth = initData ? verifyUserAccess(initData, userIdNum) : false;

  if (!hasSessionAuth && !hasTelegramAuth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const user = await getUserById(userIdNum);
  if (!user || !user.location) {
    return NextResponse.json({ error: 'User not found or no location set' }, { status: 404 });
  }

  try {
    const { fetchWeather } = await import('@/src/services/weather/open-meteo');
    const { fetchAirQuality } = await import('@/src/services/weather/air-quality');
    const { getTimezone } = await import('@/src/services/weather/geocoding');
    const { formatWeatherAI } = await import('@/src/services/weather/formatter');
    const { generateWeatherInfographic } = await import('@/src/services/weather/infographic');
    const { TIMEZONE } = await import('@/src/config/constants');

    let timezone = TIMEZONE;
    try { timezone = await getTimezone(user.location); } catch { /* fallback */ }

    const [weatherData, airQualityData] = await Promise.all([
      fetchWeather(user.location),
      fetchAirQuality(user.location, timezone).catch(() => null),
    ]);

    const result = await formatWeatherAI(weatherData, user.language, user.name, timezone, user.culture, false, true, airQualityData);

    if (!result.infographicConfig) {
      return NextResponse.json({ error: 'Failed to generate config' }, { status: 500 });
    }

    const imageBuffer = await generateWeatherInfographic(result.infographicConfig);
    if (!imageBuffer) {
      return NextResponse.json({ error: 'Failed to generate image' }, { status: 500 });
    }

    return new NextResponse(new Uint8Array(imageBuffer), {
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=1800', // 30 min cache
      },
    });
  } catch (error) {
    console.error('[weather-image] Error:', error);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

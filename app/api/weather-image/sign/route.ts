import { NextRequest, NextResponse } from 'next/server';
import { validateSessionFromRequest } from '@/src/lib/session-auth';
import { verifyUserAccess } from '@/src/lib/telegram-auth';
import { getUserById } from '@/src/services/user-service';
import { redis } from '@/src/utils/redis';
import crypto from 'crypto';

export const dynamic = 'force-dynamic';

/**
 * GET /api/weather-image/sign?user_id=X&initData=...
 * Pre-renders the weather infographic, caches it in Redis, and returns a signed URL.
 * Telegram fetches the URL server-side for shareToStory — must be fast.
 */
export async function GET(request: NextRequest) {
  const userId = request.nextUrl.searchParams.get('user_id');
  const initData = request.nextUrl.searchParams.get('initData');

  if (!userId) {
    return NextResponse.json({ error: 'Missing user_id' }, { status: 400 });
  }

  const userIdNum = parseInt(userId);
  const sessionUserId = validateSessionFromRequest(request);
  const hasSessionAuth = sessionUserId !== null && sessionUserId === userIdNum;
  const hasTelegramAuth = initData ? verifyUserAccess(initData, userIdNum) : false;

  if (!hasSessionAuth && !hasTelegramAuth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const secret = process.env.ENCRYPTION_KEY || process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'Server config error' }, { status: 500 });
  }

  const user = await getUserById(userIdNum);
  if (!user || !user.location) {
    return NextResponse.json({ error: 'No location set' }, { status: 404 });
  }

  // Pre-render the infographic and cache in Redis
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

    // Cache PNG in Redis (base64, 30 min TTL)
    const cacheKey = `story:img:${userId}`;
    await redis.set(cacheKey, Buffer.from(imageBuffer).toString('base64'), { ex: 1800 });

    // Build signed URL pointing to the cached image
    const ts = Date.now().toString();
    const sig = crypto.createHmac('sha256', secret).update(`${userId}:${ts}`).digest('hex');
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || `https://${request.headers.get('host')}`;
    const url = `${appUrl}/api/weather-image?user_id=${userId}&ts=${ts}&sig=${sig}`;

    return NextResponse.json({ url });
  } catch (error) {
    console.error('[weather-image/sign] Error:', error);
    return NextResponse.json({ error: 'Failed to generate image' }, { status: 500 });
  }
}

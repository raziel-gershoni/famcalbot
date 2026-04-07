import { NextRequest, NextResponse } from 'next/server';
import { validateSessionFromRequest } from '@/src/lib/session-auth';
import { validateInitData } from '@/src/lib/telegram-auth';
import { redis } from '@/src/utils/redis';
import crypto from 'crypto';

export const dynamic = 'force-dynamic';

/**
 * GET /api/weather-image/sign?user_id=X&initData=...
 * Returns a signed URL for the cached weather image.
 * Image must already be cached from the /weather command.
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
  // validateInitData checks signature only (no user_id match needed — user_id is internal DB ID, not TG ID)
  const hasTelegramAuth = initData ? !!validateInitData(initData) : false;

  if (!hasSessionAuth && !hasTelegramAuth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const source = request.nextUrl.searchParams.get('source') || 'fresh';
  // source=summary: always generate fresh card from stashed text
  // source=cached: weather image from cache
  // source=fresh: generate new weather image
  const cacheKey = `story:img:${userId}`;
  let cached: string | null = null;

  if (source === 'summary') {
    const msgId = request.nextUrl.searchParams.get('msg');
    const textKey = msgId ? `story:text:${userId}:${msgId}` : `story:summary:text:${userId}`;
    const summaryText = await redis.get<string>(textKey);
    if (!summaryText) {
      return NextResponse.json({ error: 'Summary expired — request a new one' }, { status: 404 });
    }

    const { generateSummaryCard } = await import('@/src/services/summary-card');
    const { getUserById } = await import('@/src/services/user-service');
    const user = await getUserById(userIdNum);

    const imageBuffer = await generateSummaryCard({
      text: summaryText,
      language: user?.language || 'en',
      userName: user?.name,
    });

    cached = Buffer.from(imageBuffer).toString('base64');
    // Cache briefly for the serve endpoint to pick up
    await redis.set(`story:summary:${userId}`, cached, { ex: 300 });
  } else {
    cached = source === 'cached' ? await redis.get<string>(cacheKey) : null;
  }

  if (!cached) {
    const { getUserById } = await import('@/src/services/user-service');
    const user = await getUserById(userIdNum);
    if (!user?.location) {
      return NextResponse.json({ error: 'No location set' }, { status: 404 });
    }

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

    cached = Buffer.from(imageBuffer).toString('base64');
    await redis.set(cacheKey, cached, { ex: 1800 });
  }

  const secret = process.env.ENCRYPTION_KEY || process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'Server config error' }, { status: 500 });
  }

  const ts = Date.now().toString();
  const sig = crypto.createHmac('sha256', secret).update(`${userId}:${ts}`).digest('hex');
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || `https://${request.headers.get('host')}`;
  const sourceParam = source !== 'fresh' ? `&source=${source}` : '';
  const url = `${appUrl}/api/weather-image?user_id=${userId}&ts=${ts}&sig=${sig}${sourceParam}`;

  return NextResponse.json({ url });
}

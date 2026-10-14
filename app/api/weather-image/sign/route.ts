import { NextRequest, NextResponse } from 'next/server';
import { verifyUserAuth } from '@/src/lib/api-auth';
import { generalRateLimiter } from '@/src/lib/rate-limit';
import { redis } from '@/src/utils/redis';
import crypto from 'crypto';

export const dynamic = 'force-dynamic';

/**
 * GET /api/weather-image/sign?user_id=X&initData=...&source=...&msg=...
 * Returns a signed URL for the cached weather image or the summary card.
 * Image must already be cached from the /weather command.
 *
 * user_id is the DB id (share-story links carry it, since the story keys are per
 * DB id); a Telegram user may also send the telegramId. The URL is signed for the
 * proved user only, and the signature covers source and msg.
 */
export async function GET(request: NextRequest) {
  const userId = request.nextUrl.searchParams.get('user_id');
  const initData = request.nextUrl.searchParams.get('initData');

  const auth = await verifyUserAuth(request, userId, initData, generalRateLimiter, 'weather-image-sign');
  if (!auth.success) {
    return auth.response;
  }
  const dbUserId = String(auth.user.id);

  const msgId = request.nextUrl.searchParams.get('msg') || null;
  if (msgId !== null && !/^\d+$/.test(msgId)) {
    return NextResponse.json({ error: 'Invalid msg' }, { status: 400 });
  }

  const source = request.nextUrl.searchParams.get('source') || 'fresh';
  // source=summary: always generate fresh card from stashed text
  // source=cached: weather image from cache
  // source=fresh: generate new weather image
  const { REDIS_KEYS } = await import('@/src/config/redis-keys');
  const cacheKey = REDIS_KEYS.storyImage(dbUserId);
  let cached: string | null = null;

  if (source !== 'summary') {
    cached = source === 'cached' ? await redis.get<string>(cacheKey) : null;
  }

  if (!cached && source !== 'summary') {
    const user = auth.user;
    if (!user.location) {
      return NextResponse.json({ error: 'No location set' }, { status: 404 });
    }

    const { fetchWeather } = await import('@/src/services/weather/open-meteo');
    const { fetchAirQuality } = await import('@/src/services/weather/air-quality');
    const { getTimezone } = await import('@/src/services/weather/geocoding');
    const { buildInfographicConfig } = await import('@/src/services/weather/formatter');
    const { generateWeatherInfographic } = await import('@/src/services/weather/infographic');
    const { TIMEZONE } = await import('@/src/config/constants');

    let timezone = TIMEZONE;
    try { timezone = await getTimezone(user.location); } catch { /* fallback */ }

    const [weatherData, airQualityData] = await Promise.all([
      fetchWeather(user.location),
      fetchAirQuality(user.location, timezone).catch(() => null),
    ]);

    const config = buildInfographicConfig(weatherData, user.language, timezone, user.culture, airQualityData);
    const imageBuffer = await generateWeatherInfographic(config);
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

  // weather-image recomputes this same string from the URL (source defaults to 'fresh')
  const ts = Date.now().toString();
  const sig = crypto.createHmac('sha256', secret).update(`${dbUserId}:${source}:${msgId ?? ''}:${ts}`).digest('hex');
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || `https://${request.headers.get('host')}`;
  const sourceParam = source !== 'fresh' ? `&source=${encodeURIComponent(source)}` : '';
  const msgParam = msgId ? `&msg=${msgId}` : '';
  const url = `${appUrl}/api/weather-image?user_id=${dbUserId}&ts=${ts}&sig=${sig}${sourceParam}${msgParam}`;

  return NextResponse.json({ url });
}

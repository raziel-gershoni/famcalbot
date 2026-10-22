import { NextRequest, NextResponse } from 'next/server';
import { verifyUserAuth } from '@/src/lib/api-auth';
import { requestInitData } from '@/src/lib/request-init-data';
import { generalRateLimiter } from '@/src/lib/rate-limit';
import { redis } from '@/src/utils/redis';
import { appKey } from '@/src/lib/app-keys';
import { signImageLink } from '@/src/lib/image-link';

export const dynamic = 'force-dynamic';

/** The 500 for a missing image-link key (appKey has already reported it, once per process). */
function noKeyResponse() {
  console.error('[weather-image/sign] SESSION_SECRET is not set; no image link signed');
  return NextResponse.json({ error: 'Server config error' }, { status: 500 });
}

/**
 * GET /api/weather-image/sign?user_id=X&source=...&msg=... (initData in the X-Telegram-Init-Data header)
 * Returns a signed URL for the cached weather image or the summary card.
 * Image must already be cached from the /weather command.
 *
 * user_id is the DB id (share-story links carry it, since the story keys are per
 * DB id); a Telegram user may also send the telegramId. The URL is signed for the
 * proved user only, and the signature covers source and msg.
 */
export async function GET(request: NextRequest) {
  const userId = request.nextUrl.searchParams.get('user_id');
  const initData = requestInitData(request);

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

  // The key first: with no image-link key no link can be signed, so build no image for it.
  // appKey reports the missing SESSION_SECRET (once per process).
  if (!appKey('image-link')) return noKeyResponse();

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

  // weather-image verifies the same params from the URL (source defaults to 'fresh')
  const ts = Date.now();
  const sig = signImageLink({ userId: dbUserId, source, msgId, ts });
  // null if SESSION_SECRET went away while the image was built
  if (!sig) return noKeyResponse();
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || `https://${request.headers.get('host')}`;
  const sourceParam = source !== 'fresh' ? `&source=${encodeURIComponent(source)}` : '';
  const msgParam = msgId ? `&msg=${msgId}` : '';
  const url = `${appUrl}/api/weather-image?user_id=${dbUserId}&ts=${ts}&sig=${sig}${sourceParam}${msgParam}`;

  return NextResponse.json({ url });
}

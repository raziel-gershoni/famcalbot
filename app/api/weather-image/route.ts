import { NextRequest, NextResponse } from 'next/server';
import { getUserById } from '@/src/services/user-service';
import crypto from 'crypto';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Validate HMAC signature for public access (Telegram fetches this server-side for stories).
 * Signature = HMAC-SHA256(user_id:timestamp, ENCRYPTION_KEY), valid for 1 hour.
 */
function validateSignature(userId: string, timestamp: string, signature: string): boolean {
  const secret = process.env.ENCRYPTION_KEY || process.env.CRON_SECRET;
  if (!secret) return false;

  const age = Date.now() - parseInt(timestamp);
  if (isNaN(age) || age > 3600_000) return false; // 1 hour max

  const expected = crypto.createHmac('sha256', secret).update(`${userId}:${timestamp}`).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

/**
 * GET /api/weather-image?user_id=X&ts=TIMESTAMP&sig=SIGNATURE
 * Generates and returns a weather infographic PNG for the user's location.
 * Auth via HMAC signature (for Telegram story sharing) — no cookies needed.
 */
export async function GET(request: NextRequest) {
  const userId = request.nextUrl.searchParams.get('user_id');
  const ts = request.nextUrl.searchParams.get('ts');
  const sig = request.nextUrl.searchParams.get('sig');

  if (!userId || !ts || !sig) {
    return NextResponse.json({ error: 'Missing parameters' }, { status: 400 });
  }

  if (!validateSignature(userId, ts, sig)) {
    return NextResponse.json({ error: 'Invalid or expired signature' }, { status: 401 });
  }

  const user = await getUserById(parseInt(userId));
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
        'Cache-Control': 'public, max-age=1800',
      },
    });
  } catch (error) {
    console.error('[weather-image] Error:', error);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

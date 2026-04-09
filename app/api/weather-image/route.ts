import { NextRequest, NextResponse } from 'next/server';
import { redis } from '@/src/utils/redis';
import crypto from 'crypto';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function validateSignature(userId: string, timestamp: string, signature: string): boolean {
  const secret = process.env.ENCRYPTION_KEY || process.env.CRON_SECRET;
  if (!secret) return false;

  const age = Date.now() - parseInt(timestamp);
  if (isNaN(age) || age > 3600_000) return false;

  const expected = crypto.createHmac('sha256', secret).update(`${userId}:${timestamp}`).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

/**
 * GET /api/weather-image?user_id=X&ts=TIMESTAMP&sig=SIGNATURE&source=...&msg=...
 * Serves weather image from cache, or generates summary card on the fly.
 */
export async function GET(request: NextRequest) {
  const userId = request.nextUrl.searchParams.get('user_id');
  const ts = request.nextUrl.searchParams.get('ts');
  const sig = request.nextUrl.searchParams.get('sig');
  const source = request.nextUrl.searchParams.get('source');
  const msgId = request.nextUrl.searchParams.get('msg');

  if (!userId || !ts || !sig) {
    return NextResponse.json({ error: 'Missing parameters' }, { status: 400 });
  }

  if (!validateSignature(userId, ts, sig)) {
    return NextResponse.json({ error: 'Invalid or expired signature' }, { status: 401 });
  }

  let imageBuffer: Buffer;

  if (source === 'summary') {
    // Generate summary card on the fly from stashed text
    const { REDIS_KEYS } = await import('@/src/config/redis-keys');
    const textKey = msgId ? REDIS_KEYS.storyText(userId, msgId) : `story:summary:text:${userId}`;
    const summaryText = await redis.get<string>(textKey);
    if (!summaryText) {
      return NextResponse.json({ error: 'Summary expired' }, { status: 404 });
    }

    const { generateSummaryCard } = await import('@/src/services/summary-card');
    const { getUserById } = await import('@/src/services/user-service');
    const user = await getUserById(parseInt(userId));

    imageBuffer = await generateSummaryCard({
      text: summaryText,
      language: user?.language || 'en',
      userName: user?.name,
    });
  } else {
    // Weather image from cache
    const { REDIS_KEYS: RK } = await import('@/src/config/redis-keys');
    const cached = await redis.get<string>(RK.storyImage(userId));
    if (!cached) {
      return NextResponse.json({ error: 'Image not found' }, { status: 404 });
    }
    imageBuffer = Buffer.from(cached, 'base64');
  }

  return new NextResponse(new Uint8Array(imageBuffer), {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=300',
    },
  });
}

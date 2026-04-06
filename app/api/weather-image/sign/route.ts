import { NextRequest, NextResponse } from 'next/server';
import { validateSessionFromRequest } from '@/src/lib/session-auth';
import { verifyUserAccess } from '@/src/lib/telegram-auth';
import crypto from 'crypto';

export const dynamic = 'force-dynamic';

/**
 * GET /api/weather-image/sign?user_id=X
 * Returns a signed URL for the weather image (valid 1 hour).
 * Requires session or Telegram auth.
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

  // Also accept if opened from Telegram WebApp (initData comes from TG context)
  if (!hasSessionAuth && !hasTelegramAuth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const secret = process.env.ENCRYPTION_KEY || process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'Server config error' }, { status: 500 });
  }

  const ts = Date.now().toString();
  const sig = crypto.createHmac('sha256', secret).update(`${userId}:${ts}`).digest('hex');

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || `https://${request.headers.get('host')}`;
  const url = `${appUrl}/api/weather-image?user_id=${userId}&ts=${ts}&sig=${sig}`;

  return NextResponse.json({ url });
}

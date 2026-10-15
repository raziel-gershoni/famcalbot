import { NextRequest, NextResponse } from 'next/server';
import { redis } from '@/src/utils/redis';
import { REDIS_KEYS } from '@/src/config/redis-keys';
import { captureError } from '@/src/lib/error-capture';
import { verifyUserAuth } from '@/src/lib/api-auth';
import { generalRateLimiter } from '@/src/lib/rate-limit';

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const userId = searchParams.get('user_id');
  // In a header, never the query string: initData is a credential for 24 hours, and URLs
  // end up in logs and traces
  const initData = request.headers.get('x-telegram-init-data');

  if (!userId) {
    return NextResponse.json({ error: 'Missing parameters' }, { status: 400 });
  }

  try {
    // Telegram initData (user_id = telegramId) or the WhatsApp session (user_id = DB id)
    const auth = await verifyUserAuth(request, userId, initData, generalRateLimiter, 'check-token-refresh');
    if (!auth.success) {
      return auth.response;
    }

    // Set by commitGoogleToken once the owner confirmed from their own chat. A fresh
    // updatedAt with a token proves nothing: any other change to the row bumps it.
    const connected = await redis.exists(REDIS_KEYS.googleConnected(auth.user.id));

    return NextResponse.json({ refreshed: connected > 0 });
  } catch (error) {
    captureError(error, 'check-token-refresh', { api_route: '/api/check-token-refresh' });
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { redis } from '@/src/utils/redis';
import { REDIS_KEYS } from '@/src/config/redis-keys';
import { captureError } from '@/src/lib/error-capture';
import { verifyUserAuth } from '@/src/lib/api-auth';
import { tokenPollRateLimiter } from '@/src/lib/rate-limit';

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const userId = searchParams.get('user_id');
  // When this attempt opened Google (ms): a flag from an earlier connect doesn't count
  const sinceParam = searchParams.get('since');
  const since = Number(sinceParam);
  // In a header, never the query string: initData is a credential for 24 hours, and URLs
  // end up in logs and traces
  const initData = request.headers.get('x-telegram-init-data');

  if (!userId || !sinceParam || !Number.isFinite(since)) {
    return NextResponse.json({ error: 'Missing parameters' }, { status: 400 });
  }

  try {
    // Telegram initData (user_id = telegramId) or the WhatsApp session (user_id = DB id).
    // Its own limiter: the 2 s poll would use up the general one that page-data shares.
    const auth = await verifyUserAuth(request, userId, initData, tokenPollRateLimiter, 'check-token-refresh');
    if (!auth.success) {
      return auth.response;
    }

    // Set by commitGoogleToken, to when it committed, once the owner confirmed from their
    // own chat. A fresh updatedAt with a token proves nothing: any other change to the row
    // bumps it.
    const connectedAt = Number(await redis.get(REDIS_KEYS.googleConnected(auth.user.id)));

    return NextResponse.json({ refreshed: connectedAt > since });
  } catch (error) {
    captureError(error, 'check-token-refresh', { api_route: '/api/check-token-refresh' });
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/src/utils/prisma';
import { captureError } from '@/src/lib/error-capture';
import { verifyUserAuth } from '@/src/lib/api-auth';
import { generalRateLimiter } from '@/src/lib/rate-limit';

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const userId = searchParams.get('user_id');
  const since = searchParams.get('since');
  const initData = searchParams.get('initData');

  if (!userId || !since) {
    return NextResponse.json({ error: 'Missing parameters' }, { status: 400 });
  }

  try {
    // Telegram initData (user_id = telegramId) or the WhatsApp session (user_id = DB id)
    const auth = await verifyUserAuth(request, userId, initData, generalRateLimiter, 'check-token-refresh');
    if (!auth.success) {
      return auth.response;
    }

    const user = await prisma.user.findUnique({
      where: { id: auth.user.id },
      select: { updatedAt: true, googleRefreshToken: true }
    });

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    const sinceDate = new Date(parseInt(since));
    const wasRefreshed = user.updatedAt > sinceDate && !!user.googleRefreshToken;

    return NextResponse.json({ refreshed: wasRefreshed });
  } catch (error) {
    captureError(error, 'check-token-refresh', { api_route: '/api/check-token-refresh' });
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

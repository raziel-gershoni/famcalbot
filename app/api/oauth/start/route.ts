// POST /api/oauth/start — begin the Google Calendar OAuth flow for the proved user.
// Body: { user_id, initData? }. Returns { oauthUrl, serverTime }.
//
// The OAuth state used to be created by the /refresh-token page for whatever user_id
// was in its URL, with no credential, and the callback saved the Google token on that
// user. Now the state is created only here, after verifyUserAuth, and it records the
// proved user's DB id. The u1_ prefix marks this kind of state; the callback refuses
// any other (old states live at most 10 minutes).

import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { verifyUserAuth } from '@/src/lib/api-auth';
import { requestInitData } from '@/src/lib/request-init-data';
import { settingsRateLimiter } from '@/src/lib/rate-limit';
import { prisma } from '@/src/utils/prisma';
import { buildUrl } from '@/src/config/urls';
import { captureError } from '@/src/lib/error-capture';
import { OAUTH_STATE_PREFIX } from '@/src/lib/oauth-state';

export const dynamic = 'force-dynamic';

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// OAuth scopes: always request both read and write for full functionality
const CALENDAR_SCOPE_READ = 'https://www.googleapis.com/auth/calendar.readonly';
const CALENDAR_SCOPE_WRITE = 'https://www.googleapis.com/auth/calendar.events';

export async function POST(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const body = await request.json().catch(() => ({}));
    const rawUserId = body.user_id ?? searchParams.get('user_id');
    const initData = requestInitData(request, body);

    const auth = await verifyUserAuth(
      request,
      rawUserId != null ? String(rawUserId) : null,
      initData,
      settingsRateLimiter,
      'oauth-start'
    );
    if (!auth.success) return auth.response;

    // Secure random state token, stored with a 10-minute expiry
    const stateToken = OAUTH_STATE_PREFIX + crypto.randomBytes(32).toString('hex');
    await prisma.oAuthState.create({
      data: {
        userId: BigInt(auth.user.id),
        token: stateToken,
        expiresAt: new Date(Date.now() + OAUTH_STATE_TTL_MS),
      },
    });

    const urlParams = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID || '',
      redirect_uri: buildUrl('/api/refresh-token'),
      response_type: 'code',
      scope: `${CALENDAR_SCOPE_READ} ${CALENDAR_SCOPE_WRITE}`,
      access_type: 'offline',
      prompt: 'consent', // Force consent to get refresh token
      state: stateToken,
    });

    // serverTime: this server's clock, which the commit flag uses too. The phone's clock can
    // be minutes off, so the page puts its tap on this one (check-token-refresh's since).
    return NextResponse.json({
      oauthUrl: `https://accounts.google.com/o/oauth2/v2/auth?${urlParams.toString()}`,
      serverTime: Date.now(),
    });
  } catch (error) {
    captureError(error, 'oauth-start', { api_route: '/api/oauth/start' });
    return NextResponse.json({ error: 'Failed to start Google sign-in' }, { status: 500 });
  }
}

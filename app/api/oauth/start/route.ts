// POST /api/oauth/start — begin the Google Calendar OAuth flow for the proved user.
// Body: { user_id, initData?, purpose?, nativeCalendarId? }. Returns { oauthUrl, serverTime }.
//
// The OAuth state used to be created by the /refresh-token page for whatever user_id
// was in its URL, with no credential, and the callback saved the Google token on that
// user. Now the state is created only here, after verifyUserAuth, and it records the
// proved user's DB id. The u1_ prefix marks this kind of state; the callback refuses
// any other (old states live at most 10 minutes).
//
// purpose 'sync' (google-sync spec §3): the first "Copy to Google" of an own FamCal
// calendar, which also asks for calendar.app.created; the state carries the calendar, and
// the commit creates the copy's link. No purpose is a connect, as before.

import { NextRequest, NextResponse } from 'next/server';
import { verifyUserAuth } from '@/src/lib/api-auth';
import { requestInitData } from '@/src/lib/request-init-data';
import { settingsRateLimiter } from '@/src/lib/rate-limit';
import { captureError } from '@/src/lib/error-capture';
import { createGoogleConsent, parseConsentRequest } from '@/src/services/google-connect';

export const dynamic = 'force-dynamic';

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

    const asked = parseConsentRequest(body);
    if (!asked) {
      console.warn(`[oauth-start] user ${auth.user.id}: refused a consent request (purpose ${typeof body.purpose === 'string' ? body.purpose.slice(0, 20) : typeof body.purpose}, calendar ${typeof body.nativeCalendarId})`);
      return NextResponse.json({ error: 'invalid_purpose' }, { status: 400 });
    }
    const consent = await createGoogleConsent(auth.user.id, asked);
    if (consent.status !== 'ok') {
      return NextResponse.json({ error: consent.status }, { status: 400 });
    }

    // serverTime: this server's clock, which the commit flag uses too. The phone's clock can
    // be minutes off, so the page puts its tap on this one (check-token-refresh's since).
    return NextResponse.json({
      oauthUrl: consent.oauthUrl,
      serverTime: Date.now(),
    });
  } catch (error) {
    captureError(error, 'oauth-start', { api_route: '/api/oauth/start' });
    return NextResponse.json({ error: 'Failed to start Google sign-in' }, { status: 500 });
  }
}

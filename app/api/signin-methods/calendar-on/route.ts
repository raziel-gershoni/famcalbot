// Settings → Sign in on the web → Turn on (web sign-in spec §2.17): the Google account a calendar is connected from, for a
// connection that has no usable key yet (connected before 6b, or keyed under another SESSION_SECRET).
//
// POST /api/signin-methods/calendar-on?user_id=…  (no body needed; the press is the person's consent)
//   → { ok: true, methods }: on (the key was read from Google once, live, and kept). Nothing else changes: no chat
//     notice (the first sign-in with it sends one) and no session ends.
//   → { ok: false, error }: shared (409: another FamCal account holds the same Google account, nothing is kept: use Add
//     Google), reconnect (409: the calendar's token is dead), not-offered (409: the row isn't in the Turn on state),
//     failed (502: Google didn't answer, or the connection changed meanwhile; 500 for a fault of ours).
//
// Security: Origin and JSON first (refuseCrossSite), then verifyUserAuth with the settings limiter (a 429 is the
// client's `busy`); acts on the proved user only. Google is asked through the one policy (turnOnCalendarAccount →
// syncGoogle → getGoogleAuth/googleFetch); no log line holds an address.

import { NextRequest, NextResponse } from 'next/server';
import { verifyUserAuth } from '@/src/lib/api-auth';
import { requestInitData } from '@/src/lib/request-init-data';
import { settingsRateLimiter } from '@/src/lib/rate-limit';
import { captureSignInFailure } from '@/src/services/web-signin/safe-error';
import { refuseCrossSite } from '@/src/lib/same-origin';
import { getUserById } from '@/src/services/user-service';
import { turnOnCalendarAccount, type TurnOnResult } from '@/src/services/web-signin/calendar-account';
import { listSignInMethods } from '@/src/services/web-signin/identities';

export const dynamic = 'force-dynamic';

const STATUS: Record<Exclude<TurnOnResult, 'on'>, number> = { shared: 409, reconnect: 409, 'not-offered': 409, failed: 502 };

export async function POST(request: NextRequest) {
  const refused = refuseCrossSite(request);
  if (refused) return refused;
  let userId: number | undefined;
  try {
    // A body that is not JSON is read as no body; the fact is logged, never the parse message
    const body = await request.json().catch(() => {
      console.warn('[signin-methods] the body is not JSON');
      return null;
    });
    const auth = await verifyUserAuth(request, request.nextUrl.searchParams.get('user_id'), requestInitData(request, body), settingsRateLimiter, 'signin-methods-calendar-on');
    if (!auth.success) return auth.response;
    userId = auth.user.id;
    const result = await turnOnCalendarAccount(userId);
    if (result !== 'on') return NextResponse.json({ ok: false, error: result }, { status: STATUS[result] });
    const fresh = (await getUserById(userId)) ?? auth.user;
    return NextResponse.json({ ok: true, methods: await listSignInMethods(fresh) });
  } catch (error) {
    captureSignInFailure(error, 'signin-methods-calendar-on', { user_id: userId });
    return NextResponse.json({ ok: false, error: 'failed' }, { status: 500 });
  }
}

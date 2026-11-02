// Settings → Sign in on the web → Remove (web sign-in spec §4, §2.13, §2.17).
//
// POST /api/signin-methods/remove?user_id=…  body { which: 'google' | 'email' | 'calendar-google' }
//   → { ok: true, methods }. Every web session of the account ends (sessionsValidAfter); the device this came from, when
//     it is a web session, gets a fresh cookie with the same method and a sign-in time of now, so it stays signed in.
//     A WhatsApp link's cookie keeps its own expiry (spec §2.4: never renewed); a web session gets a full new life.
//     Any Google removal turns the calendar's Google account off (googleCalendarSignIn).
//   → 400 invalid for anything else (Telegram and WhatsApp can't be removed here), 500 failed.
//
// Security: Origin and JSON first, then verifyUserAuth with the settings limiter; acts on the proved user only.

import { NextRequest, NextResponse } from 'next/server';
import { verifyUserAuth } from '@/src/lib/api-auth';
import { requestInitData } from '@/src/lib/request-init-data';
import { settingsRateLimiter } from '@/src/lib/rate-limit';
import { captureSignInFailure } from '@/src/services/web-signin/safe-error';
import { refuseCrossSite } from '@/src/lib/same-origin';
import { createSessionToken, setSessionCookie } from '@/src/lib/session-auth';
import { getUserById } from '@/src/services/user-service';
import { listSignInMethods, removeSignInMethod, type RemovableWay } from '@/src/services/web-signin/identities';

export const dynamic = 'force-dynamic';

const WAYS: readonly RemovableWay[] = ['google', 'email', 'calendar-google'];
const isWay = (value: unknown): value is RemovableWay => typeof value === 'string' && (WAYS as readonly string[]).includes(value);

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
    const auth = await verifyUserAuth(request, request.nextUrl.searchParams.get('user_id'), requestInitData(request, body), settingsRateLimiter, 'signin-methods-remove');
    if (!auth.success) return auth.response;
    userId = auth.user.id;
    const which: unknown = body?.which;
    if (!isWay(which)) {
      console.warn(`[signin-methods] user ${userId}: refused a removal of an unknown way`);
      return NextResponse.json({ ok: false, error: 'invalid' }, { status: 400 });
    }
    await removeSignInMethod(userId, which);
    const fresh = (await getUserById(userId)) ?? auth.user;
    const response = NextResponse.json({ ok: true, methods: await listSignInMethods(fresh) });
    if (auth.via === 'session') {
      // Signed in now, so after the new sessionsValidAfter: this device stays signed in, every other one is out. A
      // WhatsApp link is never renewed: its cookie keeps the link's own expiry and only the seconds left.
      const keep = auth.session.method === 'wa' ? auth.session.exp : null;
      const token = createSessionToken(userId, auth.session.method, Date.now(), keep === null ? undefined : { exp: keep });
      setSessionCookie(response, token, keep === null ? undefined : { maxAgeSec: Math.max(1, keep - Math.floor(Date.now() / 1000)) });
    }
    return response;
  } catch (error) {
    captureSignInFailure(error, 'signin-methods-remove', { user_id: userId });
    return NextResponse.json({ ok: false, error: 'failed' }, { status: 500 });
  }
}

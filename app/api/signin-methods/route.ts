// Settings → Sign in on the web (web sign-in spec §4): the ways this account signs in on the web.
//
// GET /api/signin-methods?user_id=…  → SignInMethodsView & { session }: Telegram (on for a Telegram account), the
//   Google and email ways with the addresses to show, whether the calendar's Google account would sign in (§2.17),
//   which ways this server has set up, and how this browser signed in (null inside Telegram).
//
// Security: verifyUserAuth proves the caller (Telegram initData, or the session cookie) with the general limiter; the
// answer is the proved user's own, never the id in the URL. A same-origin GET carries no Origin in most browsers, so
// the Origin guard is on the POSTs only; this route changes nothing.

import { NextRequest, NextResponse } from 'next/server';
import { verifyUserAuth } from '@/src/lib/api-auth';
import { requestInitData } from '@/src/lib/request-init-data';
import { generalRateLimiter } from '@/src/lib/rate-limit';
import { captureSignInFailure } from '@/src/services/web-signin/safe-error';
import { listSignInMethods } from '@/src/services/web-signin/identities';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  let userId: number | undefined;
  try {
    const auth = await verifyUserAuth(request, request.nextUrl.searchParams.get('user_id'), requestInitData(request), generalRateLimiter, 'signin-methods');
    if (!auth.success) return auth.response;
    userId = auth.user.id;
    const methods = await listSignInMethods(auth.user);
    return NextResponse.json({ ...methods, session: auth.via === 'session' ? auth.session.method : null });
  } catch (error) {
    captureSignInFailure(error, 'signin-methods', { user_id: userId });
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}

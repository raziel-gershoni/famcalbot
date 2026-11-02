// POST /api/auth/signout-all?user_id=: sign out on all devices (web sign-in spec §2.13, §4). Sets the account's
// sessionsValidAfter to now, so every session cookie signed in before it is refused on its next request, and clears
// this browser's cookie. From the web app (the cookie) and the Mini App (initData, which this doesn't end).
// Origin and JSON are checked first (same-origin.ts). user_id comes from the query, as on every user route; the
// contract's body `user_id` is read when the query has none.

import { NextRequest, NextResponse } from 'next/server';
import { refuseCrossSite } from '@/src/lib/same-origin';
import { verifyUserAuth } from '@/src/lib/api-auth';
import { requestInitData } from '@/src/lib/request-init-data';
import { settingsRateLimiter } from '@/src/lib/rate-limit';
import { clearSessionCookie } from '@/src/lib/session-auth';
import { updateUserById } from '@/src/services/user-service';
import { captureError } from '@/src/lib/error-capture';

export async function POST(request: NextRequest) {
  const refused = refuseCrossSite(request);
  if (refused) return refused;

  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await request.json();
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {
    // Not the error's message: V8 quotes the start of the text it couldn't parse
    console.warn('[signout-all] refused: the body is not JSON');
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }

  const userId = request.nextUrl.searchParams.get('user_id')
    ?? (typeof body.user_id === 'string' || typeof body.user_id === 'number' ? String(body.user_id) : null);
  const auth = await verifyUserAuth(request, userId, requestInitData(request, body), settingsRateLimiter, 'signout-all');
  if (!auth.success) return auth.response;

  try {
    await updateUserById(auth.user.id, { sessionsValidAfter: new Date() });
  } catch (error) {
    captureError(error, 'signout-all', { user_id: auth.user.id });
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
  console.info(`[signout-all] user ${auth.user.id} ended every web session (${auth.via})`);
  const response = NextResponse.json({ ok: true });
  clearSessionCookie(response);
  return response;
}

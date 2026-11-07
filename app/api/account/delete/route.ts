// Settings' "Delete account" (spec docs/superpowers/specs/2026-11-07-b-features-design.md §B3).
//
// POST /api/account/delete?user_id=…  — body { confirm: true }: deletes the proved user's own account with the admin's
//   one delete path (hardDeleteUser(id, 'self'): the copies in Google carried out (Keep honoured), the Google grant
//   revoked, the partner unlinked, every row of the account gone, the caches cleared). Answers { ok: true } and clears this
//   browser's session cookie; a session in another browser then finds no account (404, its cookie cleared).
//
// In order: the same-origin check (an irreversible write a session cookie can make), the proof (Telegram initData, or the
// session cookie, with the settings limiter), a sign-in from the last hour for a browser (refuseStaleSignIn; initData is
// never asked), the explicit { confirm: true }, and never an admin account (the owner's own). A suspended account is
// refused by verifyUserAuth (403); a banned one may delete itself, and its ban rows stay. The route acts only on
// auth.user.id. Logs and Sentry hold the user id only.

import { NextRequest, NextResponse } from 'next/server';
import { refuseCrossSite } from '@/src/lib/same-origin';
import { verifyUserAuth } from '@/src/lib/api-auth';
import { requestInitData } from '@/src/lib/request-init-data';
import { settingsRateLimiter } from '@/src/lib/rate-limit';
import { refuseStaleSignIn } from '@/src/lib/recent-sign-in';
import { clearSessionCookie } from '@/src/lib/session-auth';
import { captureError } from '@/src/lib/error-capture';
import { hardDeleteUser } from '@/src/lib/user-moderation';

export const dynamic = 'force-dynamic';

const TAG = 'account-delete';

export async function POST(request: NextRequest) {
  const crossSite = refuseCrossSite(request);
  if (crossSite) return crossSite;

  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await request.json();
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {
    // Not the error's message: V8 quotes the start of the text it couldn't parse
    console.warn(`[${TAG}] refused: the body is not JSON`);
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }

  const auth = await verifyUserAuth(request, request.nextUrl.searchParams.get('user_id'), requestInitData(request, body), settingsRateLimiter, TAG);
  if (!auth.success) return auth.response;
  const stale = refuseStaleSignIn(auth, TAG);
  if (stale) return stale;

  const userId = auth.user.id;
  if (body.confirm !== true) {
    console.warn(`[${TAG}] user ${userId}: refused a request without confirm: true`);
    return NextResponse.json({ error: 'confirm_required' }, { status: 400 });
  }
  if (auth.user.isAdmin) {
    console.warn(`[${TAG}] user ${userId}: refused: an admin account is not deleted from Settings`);
    return NextResponse.json({ error: 'admin' }, { status: 403 });
  }

  try {
    await hardDeleteUser(userId, 'self');
  } catch (error) {
    captureError(error, TAG, { user_id: userId });
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
  console.log(`[${TAG}] user ${userId} deleted their account (${auth.via})`);
  const response = NextResponse.json({ ok: true });
  clearSessionCookie(response);
  return response;
}

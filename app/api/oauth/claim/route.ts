// POST /api/oauth/claim: Finish here, the browser's way to finish a Google Calendar connect (web sign-up spec §2.10,
// §3.10). The OAuth callback parked the token for the account that started the consent (google-connect.ts, R3); the
// chat claim (gc_<id> from the owner's own Telegram or WhatsApp) still works beside this. Both calls are this site's and
// JSON (refuseCrossSite), and the id rides in the body only: never in a URL, which a server's HTTP log may record.
//
// - { token, peek: true } → { mine }: whether this browser's session is that account, read without using the entry up
//   (peekPendingOwner), and checked in full (verifyUserAuth) only when the ids match. It never says whose it is. The
//   finish page asks it to show Finish here.
// - { token } → claimPendingGoogleToken(token, { userId }) for the session's account, checked in full first: with no
//   session, or one that has ended, it answers signed-out before the entry is touched, so the chat claim can still
//   finish it; a live session of another account uses the entry up and connects nothing, as the chat claim from
//   someone else does.
//   → { ok: true, page, userId, redirect } (the page the chat claim leads to: Select calendars, or Calendars after a copy
//   to Google) | { ok: false, error: 'not_owner' (403) | 'expired' (410; 400 for a body with no id) | 'signed-out' (401)
//   | 'failed' (500) }.
// The id rides as `token`, a name the Sentry scrubber drops, and is in no log line: the user id and the outcome only.

import { NextRequest, NextResponse } from 'next/server';
import { verifyUserAuth } from '@/src/lib/api-auth';
import { captureError } from '@/src/lib/error-capture';
import { settingsRateLimiter } from '@/src/lib/rate-limit';
import { refuseCrossSite } from '@/src/lib/same-origin';
import { clearSessionCookie, readSession } from '@/src/lib/session-auth';
import { appPageUrl } from '@/src/lib/web-session';
import { claimPendingGoogleToken, peekPendingOwner } from '@/src/services/google-connect';

export const dynamic = 'force-dynamic';

type ClaimError = 'not_owner' | 'expired' | 'signed-out' | 'failed';
const STATUS: Record<ClaimError, number> = { not_owner: 403, expired: 410, 'signed-out': 401, failed: 500 };

function refuse(error: ClaimError, status: number = STATUS[error]): NextResponse {
  return NextResponse.json({ ok: false, error }, { status });
}

/** The check: whether this browser's live session is the account that started the consent. */
async function peek(request: NextRequest, token: string): Promise<NextResponse> {
  const answer = (mine: boolean) => NextResponse.json({ mine }, { headers: { 'Cache-Control': 'no-store' } });
  try {
    const session = readSession(request);
    if (!session) return answer(false);
    const owner = await peekPendingOwner(token);
    if (owner === null || owner !== session.userId) return answer(false);
    // The ids match: the session must still be good (not ended, not suspended), or Finish here would only fail
    const auth = await verifyUserAuth(request, String(session.userId), null, settingsRateLimiter, 'oauth-claim-check');
    if (auth.success) console.log(`[oauth-claim] user ${auth.user.id}: this browser may finish the Google connect here`);
    return answer(auth.success);
  } catch (error) {
    captureError(error, 'oauth-claim-check');
    return answer(false);
  }
}

export async function POST(request: NextRequest) {
  const crossSite = refuseCrossSite(request);
  if (crossSite) return crossSite;
  let userId: number | undefined;
  try {
    let body: { token?: unknown; peek?: unknown } | null;
    try {
      body = await request.json();
    } catch (error) {
      console.warn(`[oauth-claim] a Finish here whose body is not JSON (${error instanceof Error ? error.name : typeof error})`);
      return refuse('expired', 400);
    }
    const token = body?.token;
    if (typeof token !== 'string') {
      console.warn('[oauth-claim] a Finish here with no connection id');
      return refuse('expired', 400);
    }
    if (body?.peek === true) return await peek(request, token);
    const session = readSession(request);
    if (!session) {
      console.log('[oauth-claim] Finish here with no session in this browser; the connection is left for the chat claim');
      return refuse('signed-out');
    }
    const auth = await verifyUserAuth(request, String(session.userId), null, settingsRateLimiter, 'oauth-claim');
    if (!auth.success) {
      if (auth.response.status === 429) return auth.response;
      // verifyUserAuth logged why (ended, suspended, no row); the refused cookie is cleared, and the entry is left
      const signedOut = refuse('signed-out');
      clearSessionCookie(signedOut);
      return signedOut;
    }
    userId = auth.user.id;
    const claim = await claimPendingGoogleToken(token, { userId });
    if (claim.status === 'not_owner') {
      console.warn(`[oauth-claim] user ${userId}: Finish here on a connection another account started; it is used up and nothing was connected`);
      return refuse('not_owner');
    }
    if (claim.status === 'expired') {
      console.log(`[oauth-claim] user ${userId}: Finish here on a connection that was used or has expired`);
      return refuse('expired');
    }
    const { owner } = claim;
    const page = claim.sync ? 'calendars' : 'select-calendars';
    console.log(`[oauth-claim] user ${owner.id}: the Google ${claim.sync ? 'copy' : 'connect'} was finished in the browser`);
    return NextResponse.json({ ok: true, page, userId: owner.id, redirect: appPageUrl(owner.language, page, owner.id) });
  } catch (error) {
    // The commit can fail half-way, after the token is saved: the page says to check, never that nothing was connected
    captureError(error, 'google-connect-claim', { user_id: userId });
    return refuse('failed');
  }
}

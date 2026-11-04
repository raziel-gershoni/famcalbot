// Join (web sign-up spec 2026-11-03 §2.9, §3.6): the answer to the question Add Google or Add email ended on.
//
// POST /api/signin-methods/join?user_id=…  body { token } (the question's id: `token` so the log and Sentry scrubber
//   drops it)
//   → { ok: true, methods }: the other account is joined into this one, which gets the notice for the way it gained.
//   → { ok: false, error }: expired (410: late, used or not an id), refused (409: another account's question, or a
//     check failed now), failed (500).
//
// Security: Origin and JSON first, then verifyUserAuth (Telegram initData in the Mini App, the session cookie in a
// browser) with the settings limiter; the question must have been made for the proved account (runJoin). No log line
// holds the id.

import { NextRequest, NextResponse } from 'next/server';
import { verifyUserAuth } from '@/src/lib/api-auth';
import { requestInitData } from '@/src/lib/request-init-data';
import { settingsRateLimiter } from '@/src/lib/rate-limit';
import { refuseCrossSite } from '@/src/lib/same-origin';
import { captureSignInFailure } from '@/src/services/web-signin/safe-error';
import { runJoin } from '@/src/services/web-signin/join';

export const dynamic = 'force-dynamic';

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
    const auth = await verifyUserAuth(request, request.nextUrl.searchParams.get('user_id'), requestInitData(request, body), settingsRateLimiter, 'signin-methods-join');
    if (!auth.success) return auth.response;
    userId = auth.user.id;
    const result = await runJoin(auth.user.id, body?.token);
    if (result.ok) return NextResponse.json({ ok: true, methods: result.methods });
    return NextResponse.json({ ok: false, error: result.error }, { status: result.error === 'expired' ? 410 : 409 });
  } catch (error) {
    captureSignInFailure(error, 'signin-methods-join', { user_id: userId });
    return NextResponse.json({ ok: false, error: 'failed' }, { status: 500 });
  }
}

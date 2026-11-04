// Connect Telegram (web sign-up spec §2.9, §3.6): the one-time link that opens the bot for an account made on
// famcal.bot.
//
// POST /api/telegram-connect?user_id=…  body {}
//   → { url }: t.me/<bot>?start=w_<token>, valid 10 minutes, usable once.
//   → 409 { error: 'has-chat' }: the account has Telegram or WhatsApp.
//   → 403 { error: 'stale-sign-in' }: signed in on this browser more than an hour ago, or by a WhatsApp link (the page
//     says "Sign in again to connect Telegram").
//   → 429 { error: 'limit' }: 5 links an hour.
//   → 503 { error: 'unavailable' }: the store failed. A throw is 500 { error: 'unavailable' }.
//   → 401 with no session (verifyUserAuth's own answer, as for its other refusals); 403 { error: 'cross_site' } and
//     415 { error: 'json_only' } from refuseCrossSite.
//
// Security: Origin and JSON first (refuseCrossSite), then verifyUserAuth by the session cookie only (no initData: an
// account inside Telegram has Telegram already) with the settings limiter; the route acts on the proved user only. No
// log line holds the token or the link.

import { NextRequest, NextResponse } from 'next/server';
import { verifyUserAuth } from '@/src/lib/api-auth';
import { settingsRateLimiter } from '@/src/lib/rate-limit';
import { refuseCrossSite } from '@/src/lib/same-origin';
import { captureSignInFailure } from '@/src/services/web-signin/safe-error';
import { createConnectLink } from '@/src/services/telegram-connect';

export const dynamic = 'force-dynamic';

const STATUS = { 'has-chat': 409, 'stale-sign-in': 403, limit: 429, unavailable: 503 } as const;

export async function POST(request: NextRequest) {
  const refused = refuseCrossSite(request);
  if (refused) return refused;
  let userId: number | undefined;
  try {
    const auth = await verifyUserAuth(request, request.nextUrl.searchParams.get('user_id'), null, settingsRateLimiter, 'telegram-connect');
    if (!auth.success) return auth.response;
    userId = auth.user.id;
    // Without initData only the cookie can prove the user, so this is a session; the check narrows the type
    if (auth.via !== 'session') return NextResponse.json({ error: 'has-chat' }, { status: STATUS['has-chat'] });
    const made = await createConnectLink(auth.user, auth.session);
    if (!made.ok) return NextResponse.json({ error: made.error }, { status: STATUS[made.error] });
    return NextResponse.json({ url: made.url });
  } catch (error) {
    captureSignInFailure(error, 'telegram-connect', { user_id: userId });
    return NextResponse.json({ error: 'unavailable' }, { status: 500 });
  }
}

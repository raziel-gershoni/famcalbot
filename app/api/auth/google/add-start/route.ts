// Continue on /signin/add-google (web sign-in spec §2.9): use the one-time link up and start Google.
//
// POST /api/auth/google/add-start  body { token }
//   → { url }: Google's sign-in URL, with an 'add-google' flow (state, nonce, PKCE) bound to this browser by the
//     famcal_signin cookie (Path=/api/auth, 10 minutes). Google's answer comes back to /api/auth/google/callback.
//   → 410 { error: 'expired' } for a used, late or bad link; 403 { error: 'suspended' }; 403 { error: 'stale-sign-in' } for a
//     link made on a browser session that is over an hour old by now (the link is used up; src/lib/recent-sign-in.ts); 409 { error: 'unavailable' }
//     with no Google sign-in client; 500 { error: 'failed' }.
//
// Security: Origin and JSON first, so only the famcal.bot page can use a link up; looking at the page never does
// (peekAddGoogleToken). No log line holds the token or the state.

import { NextRequest, NextResponse } from 'next/server';
import { captureSignInFailure } from '@/src/services/web-signin/safe-error';
import { refuseCrossSite } from '@/src/lib/same-origin';
import { recentlyProved } from '@/src/lib/recent-sign-in';
import { normalizeLocale } from '@/src/utils/locale';
import { getUserById } from '@/src/services/user-service';
import { startFlow, type OidcFlow } from '@/src/services/web-signin/flow';
import { authorizationUrl, newOidcChecks, providerConfigured } from '@/src/services/web-signin/oidc';
import { takeAddGoogleToken } from '@/src/services/web-signin/add-google';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const refused = refuseCrossSite(request);
  if (refused) return refused;
  let userId: number | undefined;
  try {
    // A body that is not JSON is read as no body; the fact is logged, never the parse message
    const body = await request.json().catch(() => {
      console.warn('[signin] add-google: the body is not JSON');
      return null;
    });
    const link = await takeAddGoogleToken(body?.token);
    if (!link) {
      console.warn('[signin] add-google: Continue with a link that is used, late or not one');
      return NextResponse.json({ error: 'expired' }, { status: 410 });
    }
    userId = link.userId;
    // A link made in a browser carries that session's proved-at; the hour is asked again before Google (a Mini App link has none)
    if (link.provedAt !== undefined && !recentlyProved(link.provedAt)) {
      console.warn(`[recent-sign-in] user ${link.userId}: add-google-start refused: the sign-in is not recent`);
      return NextResponse.json({ error: 'stale-sign-in' }, { status: 403 });
    }
    const user = await getUserById(link.userId);
    if (!user) {
      console.warn(`[signin] add-google: the account ${link.userId} that made the link is not there`);
      return NextResponse.json({ error: 'expired' }, { status: 410 });
    }
    if (user.suspendedAt) {
      console.warn(`[signin] user ${user.id}: add-google refused: the account is suspended`);
      return NextResponse.json({ error: 'suspended' }, { status: 403 });
    }
    if (!providerConfigured('google')) {
      console.warn(`[signin] user ${user.id}: add-google with no Google sign-in client set up`);
      return NextResponse.json({ error: 'unavailable' }, { status: 409 });
    }
    const flow: OidcFlow = { kind: 'add-google', ...newOidcChecks(), locale: normalizeLocale(user.language), userId: user.id, ...(link.provedAt === undefined ? {} : { provedAt: link.provedAt }) };
    const url = await authorizationUrl('google', flow);
    const response = NextResponse.json({ url: url.toString() });
    await startFlow(response, flow);
    console.log(`[signin] user ${user.id}: add-google went to Google`);
    return response;
  } catch (error) {
    captureSignInFailure(error, 'signin-add-google-start', { user_id: userId });
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}

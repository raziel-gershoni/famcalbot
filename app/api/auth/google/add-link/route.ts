// Settings → Sign in on the web → Add Google (web sign-in spec §2.9): the one-time link that opens in the browser.
//
// POST /api/auth/google/add-link?user_id=…  body {}
//   → { url }: famcal.bot/{lang}/signin/add-google?token=<token> (English unprefixed), 5 minutes, used up only by Continue on that page.
//   → 409 { error: 'unavailable' } with no Google sign-in client set up; 409 { error: 'has-one' } when the account has a
//     Google way already (remove it first); 500 { error: 'failed' }.
//
// Security: Origin and JSON first, then verifyUserAuth with the settings limiter; the link is for the proved user. No
// log line holds the token.

import { NextRequest, NextResponse } from 'next/server';
import { verifyUserAuth } from '@/src/lib/api-auth';
import { requestInitData } from '@/src/lib/request-init-data';
import { settingsRateLimiter } from '@/src/lib/rate-limit';
import { captureSignInFailure } from '@/src/services/web-signin/safe-error';
import { refuseCrossSite } from '@/src/lib/same-origin';
import { providerConfigured } from '@/src/services/web-signin/oidc';
import { hasIdentity } from '@/src/services/web-signin/identities';
import { createAddGoogleLink } from '@/src/services/web-signin/add-google';

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
    const auth = await verifyUserAuth(request, request.nextUrl.searchParams.get('user_id'), requestInitData(request, body), settingsRateLimiter, 'signin-add-google-link');
    if (!auth.success) return auth.response;
    userId = auth.user.id;
    if (!providerConfigured('google')) {
      console.warn(`[signin] user ${userId}: Add Google asked with no Google sign-in client set up`);
      return NextResponse.json({ error: 'unavailable' }, { status: 409 });
    }
    if (await hasIdentity(userId, 'google')) {
      console.warn(`[signin] user ${userId}: Add Google refused: the account has a Google way`);
      return NextResponse.json({ error: 'has-one' }, { status: 409 });
    }
    const url = await createAddGoogleLink(auth.user);
    console.log(`[signin] user ${userId}: an Add Google link was made`);
    return NextResponse.json({ url });
  } catch (error) {
    captureSignInFailure(error, 'signin-add-google-link', { user_id: userId });
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}

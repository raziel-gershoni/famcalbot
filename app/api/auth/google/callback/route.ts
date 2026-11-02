import { NextRequest, NextResponse } from 'next/server';
import { handleOidcCallback } from '@/src/services/web-signin/oidc-route';
import { resolveGoogleSignIn } from '@/src/services/web-signin/google-signin';
import { finishSignIn, signInPageUrl } from '@/src/lib/web-session';

/**
 * GET /api/auth/google/callback: Google sends the browser back here. Google must have verified the account's address
 * (for every kind of Google flow, so this check stays first); the account is resolveGoogleSignIn's.
 */
export async function GET(request: NextRequest) {
  return handleOidcCallback('google', request, ['google'], async (claims, flow) => {
    if (!claims.emailVerified || !claims.email) {
      console.warn(`[signin] google: the account's address is not verified (${flow.kind} flow)`);
      return NextResponse.redirect(signInPageUrl(flow.locale, 'failed'));
    }
    const found = await resolveGoogleSignIn(claims);
    if ('status' in found) return NextResponse.redirect(signInPageUrl(flow.locale, found.status));
    return finishSignIn(found.user, 'google');
  });
}

import { NextRequest, NextResponse } from 'next/server';
import { handleOidcCallback } from '@/src/services/web-signin/oidc-route';
import { resolveGoogleSignIn } from '@/src/services/web-signin/google-signin';
import { finishAddGoogle } from '@/src/services/web-signin/add-google';
import { finishSignIn, signInPageUrl } from '@/src/lib/web-session';

/**
 * GET /api/auth/google/callback: Google sends the browser back here, for "Continue with Google" on /signin and for
 * Settings' Add Google (an 'add-google' flow, web sign-in spec §2.9). Google must have verified the account's address
 * (for every kind of Google flow, so this check stays first). Then:
 *   - 'google' (sign in): the account is resolveGoogleSignIn's (the added Google account, else the one the calendar is
 *     connected from, §2.17), and finishSignIn signs it in or shows its page;
 *   - 'add-google': the Google account is attached to the account that made the link, the chat gets the notice, and
 *     this browser is signed in as that account (finishAddGoogle).
 */
export async function GET(request: NextRequest) {
  return handleOidcCallback('google', request, ['google', 'add-google'], async (claims, flow) => {
    if (!claims.emailVerified || !claims.email) {
      console.warn(`[signin] google: the account's address is not verified (${flow.kind} flow)`);
      return NextResponse.redirect(signInPageUrl(flow.locale, 'failed'));
    }
    if (flow.kind === 'add-google') return finishAddGoogle(flow, claims);
    const found = await resolveGoogleSignIn(claims);
    if ('status' in found) return NextResponse.redirect(signInPageUrl(flow.locale, found.status));
    return finishSignIn(found.user, 'google');
  });
}

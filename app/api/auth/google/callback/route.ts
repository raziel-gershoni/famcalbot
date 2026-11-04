import { NextRequest, NextResponse } from 'next/server';
import { handleOidcCallback } from '@/src/services/web-signin/oidc-route';
import { resolveGoogleSignIn } from '@/src/services/web-signin/google-signin';
import { finishAddGoogle } from '@/src/services/web-signin/add-google';
import { startFlow } from '@/src/services/web-signin/flow';
import { finishSignIn, signInPageUrl, signUpPageUrl } from '@/src/lib/web-session';

/**
 * GET /api/auth/google/callback: Google sends the browser back here, for "Continue with Google" on /signin and for
 * Settings' Add Google (an 'add-google' flow, web sign-in spec §2.9). Google must have verified the account's address
 * (for every kind of Google flow, so this check stays first). Then:
 *   - 'google' (sign in): the account is resolveGoogleSignIn's (the added Google account, else the one the calendar is
 *     connected from, §2.17), and finishSignIn signs it in or shows its page;
 *   - 'google' with no account holding this Google account in any way ('new', web sign-up spec §3.3): the sign-up
 *     record (the sub, the verified address, the language, the invite) is kept for this browser and the person goes to
 *     /{locale}/signup; the cookie that names it stays on the answer (keepFlowCookie);
 *   - its address already another account's email way ('exists'): /signin?status=exists-email;
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
    if ('user' in found) return finishSignIn(found.user, 'google');
    if (found.status === 'new') {
      const response = NextResponse.redirect(signUpPageUrl(flow.locale));
      await startFlow(response, {
        kind: 'signup',
        way: 'google',
        subject: claims.sub,
        address: claims.email,
        locale: flow.locale,
        ...(flow.invite ? { invite: flow.invite } : {}),
      });
      return { response, keepFlowCookie: true };
    }
    if (found.status === 'exists') return NextResponse.redirect(signInPageUrl(flow.locale, 'exists-email'));
    return NextResponse.redirect(signInPageUrl(flow.locale, found.status));
  });
}

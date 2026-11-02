import { NextRequest, NextResponse } from 'next/server';
import { refuseCrossSite } from '@/src/lib/same-origin';
import { finishSignIn, type SignInStatus } from '@/src/lib/web-session';
import { clientAddress } from '@/src/services/web-signin/client-address';
import { clearFlowCookie, peekFlow } from '@/src/services/web-signin/flow';
import { codeChecksBlocked, recordWrongCode } from '@/src/services/web-signin/limits';
import { checkCode } from '@/src/services/web-signin/email-code';
import { emailSignInAccount, touchEmailSignIn } from '@/src/services/web-signin/identities';
import { captureSignInFailure, safeErrorSummary } from '@/src/services/web-signin/safe-error';

const ROUTE = '/api/auth/email/verify';

type VerifyError = 'wrong' | 'restart' | 'limited' | 'suspended' | 'blocked' | 'failed';

function refusal(error: VerifyError, opts: { clearFlow?: boolean; status?: number } = {}): NextResponse {
  const response = NextResponse.json({ ok: false, error }, { status: opts.status ?? 200 });
  if (opts.clearFlow) clearFlowCookie(response);
  return response;
}

/**
 * The code screen on /signin (spec §3 "Email", §5). The flow comes from this browser's famcal_signin cookie and stays
 * for the next try (peekFlow). Wrong codes paused for the address or the IP → 'limited', before the code is touched;
 * a wrong, expired or unknown address's code → 'wrong', counted as a wrong code either way; a right one finishes the
 * sign-in as that account ({ ok: true, redirect } with the session cookie) and clears the flow cookie.
 */
export async function POST(request: NextRequest) {
  const crossSite = refuseCrossSite(request);
  if (crossSite) return crossSite;
  try {
    const flow = await peekFlow(request, 'email');
    if (!flow) {
      console.log('[signin-email] a code check with no email flow in this browser: start again');
      // The cookie is left as it is: it may name this browser's newer sign-in of another way (Telegram or Google,
      // started in another tab), which must still finish; a dead one ends by itself in 10 minutes.
      return refusal('restart');
    }
    let body: { code?: unknown };
    try {
      body = await request.json();
    } catch (error) {
      console.warn(`[signin-email] a code check whose body is not JSON: ${safeErrorSummary(error)}`);
      return refusal('wrong');
    }
    const code = typeof body?.code === 'string' ? body.code.trim() : '';
    if (!/^\d{6}$/.test(code)) return refusal('wrong');

    const ip = clientAddress(request);
    if (await codeChecksBlocked({ emailKey: flow.emailKey, ip })) {
      console.log('[signin-email] a code check held back: too many wrong codes for this address or IP');
      return refusal('limited');
    }
    const checked = await checkCode('signin', flow.emailKey, code);
    if (!checked.ok) {
      await recordWrongCode({ emailKey: flow.emailKey, ip });
      console.log(`[signin-email] a code refused (${checked.reason})`);
      return refusal('wrong');
    }
    const account = await emailSignInAccount(checked.userId, checked.address);
    if (!account) {
      console.warn(`[signin-email] user ${checked.userId}: the email way was removed after the code was sent; no session`);
      return refusal('restart', { clearFlow: true });
    }
    const finished = await finishSignIn(account.user, 'email', { respond: 'json' });
    const outcome = (await finished.clone().json()) as { ok?: boolean; status?: SignInStatus };
    if (!outcome.ok) {
      console.log(`[signin-email] user ${checked.userId} refused at the finish (${outcome.status ?? 'no status'})`);
      const error: VerifyError = outcome.status === 'suspended' || outcome.status === 'blocked' ? outcome.status : 'failed';
      return refusal(error, { clearFlow: true });
    }
    try {
      await touchEmailSignIn(account.identityId);
    } catch (error) {
      captureSignInFailure(error, 'signin-email-touch', { api_route: ROUTE, user_id: checked.userId });
    }
    clearFlowCookie(finished);
    console.log(`[signin-email] user ${checked.userId} signed in with an email code`);
    return finished;
  } catch (error) {
    captureSignInFailure(error, 'signin-email-verify', { api_route: ROUTE });
    return refusal('failed', { status: 500 });
  }
}

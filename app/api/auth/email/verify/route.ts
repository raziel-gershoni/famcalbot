import { NextRequest, NextResponse } from 'next/server';
import { refuseCrossSite } from '@/src/lib/same-origin';
import { finishSignIn, landingPage, signUpPageUrl, type SignInStatus } from '@/src/lib/web-session';
import { clientAddress } from '@/src/services/web-signin/client-address';
import { clearFlowCookie, peekFlow, startFlow, takeFlow, type EmailFlow } from '@/src/services/web-signin/flow';
import { codeChecksBlocked, recordWrongCode } from '@/src/services/web-signin/limits';
import { checkCode } from '@/src/services/web-signin/email-code';
import { emailSignInAccount, findEmailSignIn, findWayByAddress, touchEmailSignIn, type IdentityKind } from '@/src/services/web-signin/identities';
import { captureSignInFailure, SafeSignInError, safeErrorSummary } from '@/src/services/web-signin/safe-error';

const ROUTE = '/api/auth/email/verify';

type VerifyError = 'wrong' | 'restart' | 'limited' | 'suspended' | 'blocked' | 'failed' | 'exists';

function refusal(error: VerifyError, opts: { clearFlow?: boolean; status?: number; way?: IdentityKind } = {}): NextResponse {
  const response = NextResponse.json({ ok: false, error, ...(opts.way ? { way: opts.way } : {}) }, { status: opts.status ?? 200 });
  if (opts.clearFlow) clearFlowCookie(response);
  return response;
}

type Checked =
  | { ok: true; purpose: 'signin'; userId: number; address: string }
  | { ok: true; purpose: 'signup'; address: string }
  | { ok: false; reason: 'wrong' | 'expired' };

/**
 * The address's sign-in code, then its sign-up code (web sign-up spec §3.2). The sign-up code is tried only when the
 * address has no sign-in code to try (an address with no account): a wrong code for an account's address counts one
 * try, as before.
 */
async function checkEither(emailKey: string, code: string): Promise<Checked> {
  const signin = await checkCode('signin', emailKey, code);
  if (signin.ok) {
    if (signin.userId === null) throw new SafeSignInError('a sign-in code with no account');
    return { ok: true, purpose: 'signin', userId: signin.userId, address: signin.address };
  }
  if (signin.reason === 'wrong') return signin;
  const signup = await checkCode('signup', emailKey, code);
  return signup.ok ? { ok: true, purpose: 'signup', address: signup.address } : signup;
}

/**
 * The code screen on /signin (spec §3 "Email", §5). The flow comes from this browser's famcal_signin cookie and stays
 * for the next try (peekFlow). Wrong codes paused for the address or the IP → 'limited', before the code is touched;
 * a wrong, expired or unknown address's code → 'wrong', counted as a wrong code either way; a right sign-in code
 * finishes the sign-in as that account ({ ok: true, redirect } with the session cookie) and clears the flow cookie; a
 * right sign-up code goes on to the sign-up page (signUpNext).
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
    const checked = await checkEither(flow.emailKey, code);
    if (!checked.ok) {
      await recordWrongCode({ emailKey: flow.emailKey, ip });
      console.log(`[signin-email] a code refused (${checked.reason})`);
      return refusal('wrong');
    }
    if (checked.purpose === 'signup') return await signUpNext(request, flow, checked.address);
    return await signIn(checked.userId, checked.address, flow.invite);
  } catch (error) {
    captureSignInFailure(error, 'signin-email-verify', { api_route: ROUTE });
    return refusal('failed', { status: 500 });
  }
}

/**
 * A right code for an account's email way: the session as that account, the flow cookie cleared, landing on the invite
 * the sign-in began on (the email flow's `invite`), else the calendar.
 */
async function signIn(userId: number, address: string, invite?: string): Promise<NextResponse> {
  const account = await emailSignInAccount(userId, address);
  if (!account) {
    console.warn(`[signin-email] user ${userId}: the email way was removed after the code was sent; no session`);
    return refusal('restart', { clearFlow: true });
  }
  const finished = await finishSignIn(account.user, 'email', { respond: 'json', page: landingPage(invite) });
  const outcome = (await finished.clone().json()) as { ok?: boolean; status?: SignInStatus };
  if (!outcome.ok) {
    console.log(`[signin-email] user ${userId} refused at the finish (${outcome.status ?? 'no status'})`);
    const error: VerifyError = outcome.status === 'suspended' || outcome.status === 'blocked' ? outcome.status : 'failed';
    return refusal(error, { clearFlow: true, status: error === 'failed' ? 500 : 200 });
  }
  try {
    await touchEmailSignIn(account.identityId);
  } catch (error) {
    captureSignInFailure(error, 'signin-email-touch', { api_route: ROUTE, user_id: userId });
  }
  clearFlowCookie(finished);
  console.log(`[signin-email] user ${userId} signed in with an email code`);
  return finished;
}

/**
 * A right sign-up code (web sign-up spec §3.2): the person proved this address, and no account had it when the code
 * went out. Looked up again, since a way may have been added since: an account that signs in with it now signs in as
 * usual; a way that shows it (a Google way) answers 'exists' with that way, so the page says to use it; otherwise the
 * email flow is used up and the sign-up flow starts under a new famcal_signin cookie (kept: only the finished
 * sign-up clears it), and the answer names the sign-up page.
 */
async function signUpNext(request: NextRequest, flow: EmailFlow, address: string): Promise<NextResponse> {
  const account = await findEmailSignIn(address);
  if (account) {
    console.log(`[signin-email] a right sign-up code for an address user ${account.userId} signs in with now: signing in`);
    return signIn(account.userId, account.address, flow.invite);
  }
  const way = await findWayByAddress(address);
  if (way) {
    console.log(`[signin-email] a right sign-up code for an address user ${way.userId}'s ${way.kind} way shows: no sign-up`);
    return refusal('exists', { clearFlow: true, way: way.kind });
  }
  if (!(await takeFlow(request, ['email']))) {
    console.warn('[signin-email] a right sign-up code, but the email flow was used meanwhile: start again');
    return refusal('restart');
  }
  const response = NextResponse.json({ ok: true, redirect: signUpPageUrl(flow.locale) });
  await startFlow(response, { kind: 'signup', way: 'email', subject: address, address, locale: flow.locale, ...(flow.invite ? { invite: flow.invite } : {}) });
  console.log('[signin-email] a right sign-up code: the sign-up page is next');
  return response;
}

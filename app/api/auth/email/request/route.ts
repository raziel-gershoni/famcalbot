import crypto from 'crypto';
import { NextRequest, NextResponse, after } from 'next/server';
import { refuseCrossSite } from '@/src/lib/same-origin';
import { appKey } from '@/src/lib/app-keys';
import { normalizeLocale } from '@/src/utils/locale';
import { clientAddress, clientIp } from '@/src/services/web-signin/client-address';
import { turnstileConfigured, verifyTurnstile } from '@/src/services/web-signin/turnstile';
import { emailKey, normalizeEmail } from '@/src/services/web-signin/email-address';
import { allowCodeRequest, takeSignUpSend } from '@/src/services/web-signin/limits';
import { startFlow } from '@/src/services/web-signin/flow';
import { emailConfigured } from '@/src/services/web-signin/email-send';
import { issueCode } from '@/src/services/web-signin/email-code';
import { findEmailSignIn } from '@/src/services/web-signin/identities';
import { cleanInviteToken } from '@/src/lib/invite-token';
import { isIdentifierBlocked } from '@/src/lib/user-moderation';
import { captureSignInFailure, safeErrorSummary } from '@/src/services/web-signin/safe-error';

const ROUTE = '/api/auth/email/request';

/**
 * "Email me a code" on /signin (spec §3 "Email", §5). Every address gets the same answer, { ok: true }, and a
 * famcal_signin flow for the code screen, whether it is on an account, held back by a limit, or no usable address at
 * all. The limits are counted before anything is looked up, for every address; the account lookup, the code and the
 * send run after the answer (after()), so the answer's timing says nothing about the address. The code goes to the
 * address stored on the account, never the typed text.
 *
 * With Turnstile configured (web sign-up spec §3.1) the body's `token` is checked first, before any limit is counted:
 * a missing or failed check answers { ok: false, error: 'check' } (403) with no flow, the same for every address.
 */
export async function POST(request: NextRequest) {
  const crossSite = refuseCrossSite(request);
  if (crossSite) return crossSite;
  if (!emailConfigured() || !appKey('signin')) {
    console.warn('[signin-email] a code was asked for, but email sign-in is not set up (RESEND_API_KEY or SESSION_SECRET)');
    return NextResponse.json({ ok: false, error: 'unavailable' }, { status: 503 });
  }
  try {
    let body: { email?: unknown; locale?: unknown; token?: unknown; invite?: unknown };
    try {
      body = await request.json();
    } catch (error) {
      console.warn(`[signin-email] a code request whose body is not JSON: ${safeErrorSummary(error)}`);
      return NextResponse.json({ ok: false, error: 'bad_request' }, { status: 400 });
    }
    // The bot check first (verifyTurnstile logs why it refused; never the token)
    if (turnstileConfigured()) {
      const checked = await verifyTurnstile(body?.token, clientIp(request));
      if (!checked.ok) return NextResponse.json({ ok: false, error: 'check' }, { status: 403 });
    }
    const locale = normalizeLocale(typeof body?.locale === 'string' ? body.locale : null);
    const normalized = normalizeEmail(body?.email);
    // Text that is no usable address still takes the IP's limit and gets a flow, under a key nothing matches.
    const key = normalized ? emailKey(normalized) : crypto.randomBytes(16).toString('hex');
    const ip = clientAddress(request);
    const verdict = await allowCodeRequest({ emailKey: key, ip });
    if (!verdict.ok) console.log(`[signin-email] a code request held back (${verdict.reason})`);
    else if (!normalized) console.log('[signin-email] a code request for text that is not a usable email address');

    const response = NextResponse.json({ ok: true });
    // The invite page's way in rides in the flow record (a clean token only), never in the answer
    const invite = cleanInviteToken(body?.invite);
    await startFlow(response, { kind: 'email', emailKey: key, locale, ...(invite ? { invite } : {}) });
    if (verdict.ok && normalized) after(() => sendCode(normalized, key, locale, ip));
    return response;
  } catch (error) {
    captureSignInFailure(error, 'signin-email-request', { api_route: ROUTE });
    return NextResponse.json({ ok: false, error: 'failed' }, { status: 500 });
  }
}

/**
 * After the answer: the account with this address gets a sign-in code at the address it stores. An address on no
 * account gets a sign-up code at the address typed (normalised, in the page's language) while email sign-up is on
 * (Turnstile configured, so this request passed the check), the address is not banned (checked before the share, so a
 * banned one spends none of it), and within the sign-up share of the day's mail (takeSignUpSend: 30 a day, 3 per
 * client address; web sign-up spec §2.5, §2.8, §3.1); otherwise nothing is mailed. The answer was the same either way,
 * so it never shows a ban.
 */
async function sendCode(normalized: string, key: string, locale: string, ip: string | null): Promise<void> {
  let userId: number | undefined;
  let purpose: 'signin' | 'signup' = 'signin';
  try {
    const account = await findEmailSignIn(normalized);
    if (account) {
      userId = account.userId;
      await issueCode({ purpose: 'signin', emailKey: key, address: account.address, userId: account.userId, locale: account.language });
      return;
    }
    if (!turnstileConfigured()) {
      console.log('[signin-email] no account signs in with this address; no code sent');
      return;
    }
    if (await isIdentifierBlocked({ email: normalized })) {
      console.warn('[signin-email] no account signs in with this address, and it is on the blocklist; no sign-up code');
      return;
    }
    const share = await takeSignUpSend(ip);
    if (!share.ok) {
      console.log(`[signin-email] no account signs in with this address; no sign-up code (${share.reason})`);
      return;
    }
    purpose = 'signup';
    await issueCode({ purpose: 'signup', emailKey: key, address: normalized, userId: null, locale });
  } catch (error) {
    captureSignInFailure(error, 'signin-email-send', { api_route: ROUTE, user_id: userId, purpose });
  }
}

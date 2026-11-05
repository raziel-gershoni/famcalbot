// Settings → Sign in on the web → Add email (web sign-in spec §4, §5): mail a code to the address.
//
// POST /api/signin-methods/email/add?user_id=…  body { email }
//   → { ok: true }: the code is on its way (10 minutes), and the account waits for it (REDIS_KEYS.signinAddEmail).
//   → { ok: false, error: 'stale-sign-in' } (403) for a browser session signed in over an hour ago (src/lib/recent-sign-in.ts).
//   → { ok: false, error }: invalid (400: not an ASCII address), has-one (409: the account has an email way),
//     unavailable (409: no email sender set up), limit (429: Add email codes per account, per address, per IP), failed (500).
// An address another account signs in with is mailed like any other and refused only once its code is right
// (email/confirm), so this answer never tells whose an address is.
//
// Security: Origin and JSON first (refuseCrossSite), then verifyUserAuth with the settings limiter; the route acts on
// the proved user only. No log line holds the address or the code.

import { NextRequest, NextResponse } from 'next/server';
import { verifyUserAuth } from '@/src/lib/api-auth';
import { requestInitData } from '@/src/lib/request-init-data';
import { refuseStaleSignIn } from '@/src/lib/recent-sign-in';
import { settingsRateLimiter } from '@/src/lib/rate-limit';
import { captureSignInFailure } from '@/src/services/web-signin/safe-error';
import { refuseCrossSite } from '@/src/lib/same-origin';
import { REDIS_KEYS } from '@/src/config/redis-keys';
import { redis } from '@/src/utils/redis';
import { normalizeLocale } from '@/src/utils/locale';
import { clientAddress } from '@/src/services/web-signin/client-address';
import { emailKey, normalizeEmail } from '@/src/services/web-signin/email-address';
import { allowCodeRequest } from '@/src/services/web-signin/limits';
import { emailConfigured } from '@/src/services/web-signin/email-send';
import { issueCode } from '@/src/services/web-signin/email-code';
import { hasIdentity } from '@/src/services/web-signin/identities';

export const dynamic = 'force-dynamic';

/** How long an Add email waits for its code: the code's own life */
const PENDING_TTL_SECONDS = 10 * 60;

const answer = (body: Record<string, unknown>, status = 200) => NextResponse.json(body, { status });

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
    const auth = await verifyUserAuth(request, request.nextUrl.searchParams.get('user_id'), requestInitData(request, body), settingsRateLimiter, 'signin-methods-email-add');
    if (!auth.success) return auth.response;
    const user = auth.user;
    userId = user.id;
    // A browser needs a sign-in from the last hour (Mini App initData passes); no mail, no pending key before this
    const stale = refuseStaleSignIn(auth, 'add-email');
    if (stale) return stale;

    if (!emailConfigured()) {
      console.warn(`[signin-methods] user ${user.id}: Add email asked with no email sender set up`);
      return answer({ ok: false, error: 'unavailable' }, 409);
    }
    const address = normalizeEmail(body?.email);
    if (!address) {
      console.warn(`[signin-methods] user ${user.id}: Add email refused an address that is not one`);
      return answer({ ok: false, error: 'invalid' }, 400);
    }
    if (await hasIdentity(user.id, 'email')) {
      console.warn(`[signin-methods] user ${user.id}: Add email refused: the account has an email way`);
      return answer({ ok: false, error: 'has-one' }, 409);
    }
    const key = emailKey(address);
    const allowed = await allowCodeRequest({ emailKey: key, ip: clientAddress(request), addForUserId: user.id });
    if (!allowed.ok) {
      console.warn(`[signin-methods] user ${user.id}: Add email code refused (${allowed.reason})`);
      return answer({ ok: false, error: 'limit' }, 429);
    }
    await issueCode({ purpose: 'add', emailKey: key, address, userId: user.id, locale: normalizeLocale(user.language) });
    // After the code is out: a mail that fails to send leaves no pending Add email pointing at an address with no code
    await redis.set(REDIS_KEYS.signinAddEmail(user.id), JSON.stringify({ emailKey: key }), { ex: PENDING_TTL_SECONDS });
    console.log(`[signin-methods] user ${user.id}: an Add email code was issued`);
    return answer({ ok: true });
  } catch (error) {
    captureSignInFailure(error, 'signin-methods-email-add', { user_id: userId });
    return answer({ ok: false, error: 'failed' }, 500);
  }
}

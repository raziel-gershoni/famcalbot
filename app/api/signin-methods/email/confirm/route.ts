// Settings → Sign in on the web → Add email, the code (web sign-in spec §4, §5).
//
// POST /api/signin-methods/email/confirm?user_id=…  body { code }
//   → { ok: true, methods }: the email way is made, the chat gets the notice (§2.10).
//   → { ok: false, error }: wrong (400), limit (429: too many wrong codes for this address or from this IP),
//     restart (410: no Add email waiting, the code expired or was used), taken (409: another account signs in with this
//     address), has-one (409: the account got an email way meanwhile), blocked (403: the address is on the blocklist;
//     Settings shows its generic error), failed (500).
//   → { ok: false, error: 'join', joinId, summary } (409): the address belongs to an account with no chat that can be
//     joined into this one (web sign-up spec §3.6); Settings asks, and the answer goes to /api/signin-methods/join.
//     A blocked address is answered 403 first and never reaches the question.
// Tries are counted before the compare (checkCode), and every wrong one counts toward the address's and the IP's limits.
//
// Security: Origin and JSON first, then verifyUserAuth with the settings limiter. The code must have been issued for
// this same account. No log line holds the address or the code.

import { NextRequest, NextResponse } from 'next/server';
import { verifyUserAuth } from '@/src/lib/api-auth';
import { requestInitData } from '@/src/lib/request-init-data';
import { settingsRateLimiter } from '@/src/lib/rate-limit';
import { captureSignInFailure } from '@/src/services/web-signin/safe-error';
import { refuseCrossSite } from '@/src/lib/same-origin';
import { REDIS_KEYS } from '@/src/config/redis-keys';
import { redis } from '@/src/utils/redis';
import { clientAddress } from '@/src/services/web-signin/client-address';
import { codeChecksBlocked, recordWrongCode } from '@/src/services/web-signin/limits';
import { checkCode } from '@/src/services/web-signin/email-code';
import { addIdentity, identityHolder, listSignInMethods } from '@/src/services/web-signin/identities';
import { isIdentifierBlocked } from '@/src/lib/user-moderation';
import { sendSignInNotice } from '@/src/services/web-signin/notice';
import { offerJoin } from '@/src/services/web-signin/join';

export const dynamic = 'force-dynamic';

const answer = (body: Record<string, unknown>, status = 200) => NextResponse.json(body, { status });

/** The Add email waiting for this account's code: the hashed address, or null. */
async function pendingEmailKey(userId: number): Promise<string | null> {
  const raw = await redis.get<{ emailKey?: unknown } | string>(REDIS_KEYS.signinAddEmail(userId));
  if (!raw) return null;
  const entry = (typeof raw === 'string' ? JSON.parse(raw) : raw) as { emailKey?: unknown };
  return typeof entry.emailKey === 'string' ? entry.emailKey : null;
}

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
    const auth = await verifyUserAuth(request, request.nextUrl.searchParams.get('user_id'), requestInitData(request, body), settingsRateLimiter, 'signin-methods-email-confirm');
    if (!auth.success) return auth.response;
    const user = auth.user;
    userId = user.id;

    const key = await pendingEmailKey(user.id);
    if (!key) {
      console.warn(`[signin-methods] user ${user.id}: an Add email code with no Add email waiting`);
      return answer({ ok: false, error: 'restart' }, 410);
    }
    const ip = clientAddress(request);
    if (await codeChecksBlocked({ emailKey: key, ip })) {
      console.warn(`[signin-methods] user ${user.id}: Add email codes paused (too many wrong ones)`);
      return answer({ ok: false, error: 'limit' }, 429);
    }
    const code = typeof body?.code === 'string' ? body.code.trim() : '';
    const result = await checkCode('add', key, code);
    if (!result.ok) {
      if (result.reason === 'expired') {
        await redis.del(REDIS_KEYS.signinAddEmail(user.id));
        console.warn(`[signin-methods] user ${user.id}: the Add email code expired or was used up`);
        return answer({ ok: false, error: 'restart' }, 410);
      }
      await recordWrongCode({ emailKey: key, ip });
      console.warn(`[signin-methods] user ${user.id}: a wrong Add email code`);
      return answer({ ok: false, error: 'wrong' }, 400);
    }
    await redis.del(REDIS_KEYS.signinAddEmail(user.id));
    if (result.userId !== user.id) {
      // The address's add code was issued to another account meanwhile (a code is per address)
      console.warn(`[signin-methods] user ${user.id}: the Add email code was issued to another account`);
      return answer({ ok: false, error: 'restart' }, 410);
    }
    // The address itself may be on the blocklist (a banned account's, after its delete): it becomes no way
    if (await isIdentifierBlocked({ email: result.address })) {
      console.warn(`[signin-methods] user ${user.id}: Add email refused: the address is on the blocklist`);
      return answer({ ok: false, error: 'blocked' }, 403);
    }
    const added = await addIdentity(user.id, 'email', result.address, result.address);
    if (added === 'taken') {
      const holder = await identityHolder('email', result.address);
      const join = holder === null ? null : await offerJoin(user, holder, { kind: 'email', subject: result.address, address: result.address });
      if (join) return answer({ ok: false, error: 'join', joinId: join.joinId, summary: join.summary }, 409);
    }
    if (added === 'taken' || added === 'has-one') {
      console.warn(`[signin-methods] user ${user.id}: Add email refused after the right code (${added})`);
      return answer({ ok: false, error: added }, 409);
    }
    // 'kept': this account already holds the address (a second tap on the same code), whose notice went out when the way was made
    if (added === 'added') await sendSignInNotice(user, { kind: 'email', address: result.address, via: 'added' });
    return answer({ ok: true, methods: await listSignInMethods(user) });
  } catch (error) {
    captureSignInFailure(error, 'signin-methods-email-confirm', { user_id: userId });
    return answer({ ok: false, error: 'failed' }, 500);
  }
}

/**
 * API Authentication Middleware
 * Common auth and rate limiting patterns for user-authenticated routes
 */

import { NextRequest, NextResponse } from 'next/server';
import { Ratelimit } from '@upstash/ratelimit';
import { validateInitData } from './telegram-auth';
import { clearSessionCookie, readSession, type WebSession } from './session-auth';
import { checkRateLimit, getRateLimitHeaders } from './rate-limit';
import { getUserById, getUserByTelegramId } from '../services/user-service';
import type { UserConfig } from '../types';

/** Which credential proved the user: Telegram initData, or the web session cookie (a WhatsApp link or a famcal.bot sign-in). */
export type AuthVia = 'telegram' | 'session';

/**
 * On success, `user` is the row the credential proved. There is deliberately no bare
 * user id here: the number in user_id is a telegramId on the Telegram path and a DB id
 * on the session path, so routes must act on `user.id` (or `user.telegramId`), never on
 * the raw parameter. A session's success also carries its cookie (how and when the person
 * signed in): page-data renews it, and a reply in a chat follows its method.
 */
export type AuthResult =
  | { success: true; via: 'telegram'; user: UserConfig }
  | { success: true; via: 'session'; user: UserConfig; session: WebSession }
  | { success: false; response: NextResponse };

/**
 * A refusal. With `clearSession`, the request's session cookie passed its signature check but is refused (its account is
 * gone or suspended, or it was signed in before the account's sessionsValidAfter), so the answer also clears it: /signin
 * and the gate's card then show their buttons instead of sending the browser round again.
 */
function fail(error: string, status: number, opts: { headers?: Record<string, string>; clearSession?: boolean } = {}): AuthResult {
  const response = NextResponse.json({ error }, { status, headers: opts.headers });
  if (opts.clearSession) clearSessionCookie(response);
  return { success: false, response };
}

/**
 * Verify user authentication and check rate limits
 * Supports dual auth: Telegram initData (primary) + the web session cookie
 *
 * Telegram: the identity is the signed initData user, looked up by telegramId. user_id
 * must be that telegramId, or that same user's own DB id (old buttons carry the DB id).
 * Session: user_id must equal the DB id in the cookie, and the cookie must be signed in
 * at or after the row's sessionsValidAfter (milliseconds; a pre-6b cookie counts its iat).
 *
 * @param request - The NextRequest
 * @param userId - User ID from query params (telegramId for TG, DB id for a session)
 * @param initData - Telegram initData for verification (null outside Telegram)
 * @param rateLimiter - Rate limiter instance to use
 * @param endpointName - Name for logging (e.g., 'settings', 'select-calendars')
 * @returns 400 without user_id, 401 when no credential matches it or the session was ended,
 *   404 when the proved user has no row, 403 when that user is suspended (a refused session
 *   cookie is cleared with the 401, 404 or 403), 429 when that user's bucket (keyed
 *   `u<user.id>` in rateLimiter) is spent
 */
export async function verifyUserAuth(
  request: NextRequest,
  userId: string | null,
  initData: string | null | undefined,
  rateLimiter: Ratelimit,
  endpointName: string
): Promise<AuthResult> {
  // Check for missing user_id
  if (!userId) {
    return fail('Missing user_id parameter', 400);
  }

  const userIdNum = parseInt(userId);
  let via: AuthVia | null = null;
  let user: UserConfig | null = null;
  let session: WebSession | null = null;

  // Telegram initData first: the identity comes from the signed user only.
  const tgUser = initData ? validateInitData(initData) : null;
  if (tgUser) {
    const tgRow = await getUserByTelegramId(tgUser.id);
    if (tgUser.id === userIdNum || (tgRow !== null && tgRow.id === userIdNum)) {
      via = 'telegram';
      user = tgRow;
    }
  }

  // Fall back to the session cookie; user_id is the DB id.
  if (!via) {
    const cookieSession = readSession(request);
    if (cookieSession !== null && cookieSession.userId === userIdNum) {
      via = 'session';
      session = cookieSession;
      user = await getUserById(cookieSession.userId);
    }
  }

  if (!via) {
    console.warn(`[${endpointName}] Unauthorized access attempt for user ${userId}`);
    return fail('Unauthorized', 401);
  }

  const clearSession = via === 'session';

  if (!user) {
    if (clearSession) console.warn(`[${endpointName}] Session for user ${userId} names no account; cookie cleared`);
    return fail('User not found', 404, { clearSession });
  }

  if (user.suspendedAt) {
    console.warn(`[${endpointName}] Suspended user ${user.id} refused (${via})${clearSession ? '; cookie cleared' : ''}`);
    return fail('Account suspended', 403, { clearSession });
  }

  // Sign out on all devices, removing a sign-in way, a suspension and a ban move sessionsValidAfter: a session signed
  // in before it is over. The same row read as above, so this costs no query.
  if (session && user.sessionsValidAfter && session.signedInAt < user.sessionsValidAfter.getTime()) {
    console.warn(`[${endpointName}] Session of user ${user.id} (${session.method}) was ended; cookie cleared`);
    return fail('Session ended', 401, { clearSession: true });
  }

  // Rate limit the proved row, not the raw user_id: '123', '0123' and the DB id of one
  // user share a bucket, and two users who send the same number never do.
  const rateLimitResult = await checkRateLimit(rateLimiter, `u${user.id}`);
  if (!rateLimitResult.success) {
    return fail('Too many requests. Please wait a minute.', 429, { headers: getRateLimitHeaders(rateLimitResult) });
  }

  return session ? { success: true, via: 'session', user, session } : { success: true, via: 'telegram', user };
}

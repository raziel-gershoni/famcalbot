/**
 * API Authentication Middleware
 * Common auth and rate limiting patterns for user-authenticated routes
 */

import { NextRequest, NextResponse } from 'next/server';
import { Ratelimit } from '@upstash/ratelimit';
import { validateInitData } from './telegram-auth';
import { validateSessionFromRequest } from './session-auth';
import { checkRateLimit, getRateLimitHeaders } from './rate-limit';
import { getUserById, getUserByTelegramId } from '../services/user-service';
import type { UserConfig } from '../types';

/** Which credential proved the user: Telegram initData or the WhatsApp magic-link cookie. */
export type AuthVia = 'telegram' | 'session';

/**
 * On success, `user` is the row the credential proved. There is deliberately no bare
 * user id here: the number in user_id is a telegramId on the Telegram path and a DB id
 * on the session path, so routes must act on `user.id` (or `user.telegramId`), never on
 * the raw parameter.
 */
export type AuthResult =
  | { success: true; via: AuthVia; user: UserConfig }
  | { success: false; response: NextResponse };

function fail(error: string, status: number, headers?: Record<string, string>): AuthResult {
  return { success: false, response: NextResponse.json({ error }, { status, headers }) };
}

/**
 * Verify user authentication and check rate limits
 * Supports dual auth: Telegram initData (primary) + session cookie (WhatsApp magic link)
 *
 * Telegram: the identity is the signed initData user, looked up by telegramId. user_id
 * must be that telegramId, or that same user's own DB id (old buttons carry the DB id).
 * Session: user_id must equal the DB id in the cookie.
 *
 * @param request - The NextRequest
 * @param userId - User ID from query params (telegramId for TG, DB id for WA)
 * @param initData - Telegram initData for verification (null for WA users)
 * @param rateLimiter - Rate limiter instance to use
 * @param endpointName - Name for logging (e.g., 'settings', 'select-calendars')
 * @returns 400 without user_id, 401 when no credential matches it, 404 when the proved
 *   user has no row, 403 when that user is suspended, 429 when rate limited
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

  // Telegram initData first: the identity comes from the signed user only.
  const tgUser = initData ? validateInitData(initData) : null;
  if (tgUser) {
    const tgRow = await getUserByTelegramId(tgUser.id);
    if (tgUser.id === userIdNum || (tgRow !== null && tgRow.id === userIdNum)) {
      via = 'telegram';
      user = tgRow;
    }
  }

  // Fall back to session cookie (WhatsApp magic link auth); user_id is the DB id.
  if (!via) {
    const sessionUserId = validateSessionFromRequest(request);
    if (sessionUserId !== null && sessionUserId === userIdNum) {
      via = 'session';
      user = await getUserById(sessionUserId);
    }
  }

  if (!via) {
    console.warn(`[${endpointName}] Unauthorized access attempt for user ${userId}`);
    return fail('Unauthorized', 401);
  }

  if (!user) {
    return fail('User not found', 404);
  }

  if (user.suspendedAt) {
    console.warn(`[${endpointName}] Suspended user ${user.id} refused (${via})`);
    return fail('Account suspended', 403);
  }

  // Check rate limits
  const rateLimitResult = await checkRateLimit(rateLimiter, userId);
  if (!rateLimitResult.success) {
    return fail('Too many requests. Please wait a minute.', 429, getRateLimitHeaders(rateLimitResult));
  }

  return { success: true, via, user };
}

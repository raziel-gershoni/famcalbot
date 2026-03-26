/**
 * API Authentication Middleware
 * Common auth and rate limiting patterns for user-authenticated routes
 */

import { NextRequest, NextResponse } from 'next/server';
import { Ratelimit } from '@upstash/ratelimit';
import { verifyUserAccess } from './telegram-auth';
import { validateSessionFromRequest } from './session-auth';
import { checkRateLimit, getRateLimitHeaders } from './rate-limit';

export type AuthResult =
  | { success: true; userId: number }
  | { success: false; response: NextResponse };

/**
 * Verify user authentication and check rate limits
 * Supports dual auth: Telegram initData (primary) + session cookie (WhatsApp magic link)
 *
 * @param request - The NextRequest
 * @param userId - User ID from query params (telegramId for TG, DB id for WA)
 * @param initData - Telegram initData for verification (null for WA users)
 * @param rateLimiter - Rate limiter instance to use
 * @param endpointName - Name for logging (e.g., 'settings', 'select-calendars')
 * @returns AuthResult indicating success with userId or failure with error response
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
    return {
      success: false,
      response: NextResponse.json(
        { error: 'Missing user_id parameter' },
        { status: 400 }
      )
    };
  }

  const userIdNum = parseInt(userId);

  // Try Telegram initData first (existing flow, unchanged)
  const telegramAuthed = verifyUserAccess(initData ?? null, userIdNum);

  // Fall back to session cookie (WhatsApp magic link auth)
  let sessionAuthed = false;
  if (!telegramAuthed) {
    const sessionUserId = validateSessionFromRequest(request);
    sessionAuthed = sessionUserId !== null && sessionUserId === userIdNum;
  }

  if (!telegramAuthed && !sessionAuthed) {
    console.warn(`[${endpointName}] Unauthorized access attempt for user ${userId}`);
    return {
      success: false,
      response: NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    };
  }

  // Check rate limits
  const rateLimitResult = await checkRateLimit(rateLimiter, userId);
  if (!rateLimitResult.success) {
    return {
      success: false,
      response: NextResponse.json(
        { error: 'Too many requests. Please wait a minute.' },
        { status: 429, headers: getRateLimitHeaders(rateLimitResult) }
      )
    };
  }

  return { success: true, userId: userIdNum };
}

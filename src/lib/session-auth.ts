/**
 * Session Cookie Authentication
 * JWT-based session cookies for WhatsApp users accessing the web app via magic links.
 * Layers alongside (not replaces) Telegram initData auth.
 */

import crypto from 'crypto';
import { NextRequest } from 'next/server';
import { cookies } from 'next/headers';

const COOKIE_NAME = 'famcal_session';
const SESSION_TTL = 24 * 60 * 60; // 24 hours in seconds

function getSecret(): string {
  const secret = process.env.SESSION_SECRET || process.env.CRON_SECRET;
  if (!secret) {
    throw new Error('SESSION_SECRET or CRON_SECRET must be configured');
  }
  return secret;
}

interface SessionPayload {
  userId: number;
  iat: number;
  exp: number;
}

/**
 * Create a signed session token (simple HMAC-signed JSON, not full JWT)
 */
export function createSessionToken(userId: number): string {
  const payload: SessionPayload = {
    userId,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL,
  };

  const payloadStr = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto
    .createHmac('sha256', getSecret())
    .update(payloadStr)
    .digest('base64url');

  return `${payloadStr}.${signature}`;
}

/**
 * Validate a session token and return the payload
 */
export function validateSessionToken(token: string): SessionPayload | null {
  try {
    const [payloadStr, signature] = token.split('.');
    if (!payloadStr || !signature) return null;

    // Verify signature
    const expectedSignature = crypto
      .createHmac('sha256', getSecret())
      .update(payloadStr)
      .digest('base64url');

    const sigBuffer = Buffer.from(signature, 'base64url');
    const expectedBuffer = Buffer.from(expectedSignature, 'base64url');
    if (sigBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
      return null;
    }

    // Parse payload
    const payload = JSON.parse(Buffer.from(payloadStr, 'base64url').toString()) as SessionPayload;

    // Check expiration
    if (payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

/**
 * Validate session from a NextRequest's cookies
 * Returns userId if valid session exists, null otherwise
 */
export function validateSessionFromRequest(request: NextRequest): number | null {
  const cookie = request.cookies.get(COOKIE_NAME);
  if (!cookie?.value) return null;

  const payload = validateSessionToken(cookie.value);
  return payload?.userId ?? null;
}

/**
 * Get session userId from server component cookies
 * For use in Next.js server components (pages)
 */
export async function getSessionUserId(): Promise<number | null> {
  const cookieStore = await cookies();
  const cookie = cookieStore.get(COOKIE_NAME);
  if (!cookie?.value) return null;

  const payload = validateSessionToken(cookie.value);
  return payload?.userId ?? null;
}

/**
 * Cookie name and options for setting the session cookie
 */
export const SESSION_COOKIE = {
  name: COOKIE_NAME,
  options: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    maxAge: SESSION_TTL,
    path: '/',
  },
};

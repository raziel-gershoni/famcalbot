/**
 * Magic Link Service
 * Generates and validates one-time-use magic link tokens for WhatsApp users
 * to authenticate into the web app.
 */

import crypto from 'crypto';
import { redis } from '../utils/redis';
import { REDIS_KEYS } from '../config/redis-keys';
import { buildUrl } from '../config/urls';

const MAGIC_LINK_TTL = 300; // 5 minutes

interface MagicLinkData {
  userId: number;
  locale: string;
}

/**
 * Generate a magic link URL for a user
 * Token is stored in Redis with 5-minute TTL, one-time use
 */
export async function generateMagicLink(userId: number, locale: string): Promise<string> {
  const token = crypto.randomBytes(32).toString('hex');

  await redis.set(
    REDIS_KEYS.magicLink(token),
    JSON.stringify({ userId, locale } satisfies MagicLinkData),
    { ex: MAGIC_LINK_TTL }
  );

  return buildUrl(`/api/auth/magic?token=${token}`);
}

/**
 * Validate and consume a magic link token (one-time use)
 * Returns user data if valid, null if expired/invalid/already used
 */
export async function validateMagicToken(token: string): Promise<MagicLinkData | null> {
  const key = REDIS_KEYS.magicLink(token);

  // Upstash auto-parses JSON, so this returns the object directly
  const data = await redis.get<MagicLinkData>(key);
  if (!data) return null;

  // Delete the key to prevent reuse
  await redis.del(key);

  return data;
}

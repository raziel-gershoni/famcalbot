/**
 * Magic Link Service
 * Generates and validates one-time-use magic link tokens for WhatsApp users
 * to authenticate into the web app.
 */

import crypto from 'crypto';
import { Redis } from '@upstash/redis';
import { REDIS_KEYS } from '../config/redis-keys';
import { buildUrl } from '../config/urls';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

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

  // Get and delete atomically (one-time use)
  const data = await redis.get<string>(key);
  if (!data) return null;

  // Delete the key to prevent reuse
  await redis.del(key);

  try {
    return JSON.parse(data) as MagicLinkData;
  } catch {
    return null;
  }
}

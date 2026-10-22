/**
 * Constant-time compare for shared secrets: CRON_SECRET, the Telegram webhook secret
 * header and the Meta verify token. Both sides are hashed first, so the compare never
 * throws on a length mismatch and its timing says nothing about the secret. An unset or
 * empty expected value never matches: an empty env var must not open a route.
 */

import crypto from 'crypto';

const digest = (value: string) => crypto.createHash('sha256').update(value, 'utf8').digest();

/** True only when both are non-empty strings and equal. */
export function matchesSecret(given: string | null | undefined, expected: string | null | undefined): boolean {
  if (typeof expected !== 'string' || expected === '') return false;
  if (typeof given !== 'string' || given === '') return false;
  return crypto.timingSafeEqual(digest(given), digest(expected));
}

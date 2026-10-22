/**
 * Share-story image links. weather-image/sign signs a URL for the proved user, and
 * weather-image checks it. The signature covers the user, the source, the msg and the
 * time, so a signed URL can't be pointed at another summary or another kind of image.
 * The key is the image-link key from app-keys.ts; no other secret signs a link.
 */

import crypto from 'crypto';
import { appKey } from './app-keys';

/** A link is good for an hour, and its time may run at most a minute ahead of this server's clock. */
const MAX_AGE_MS = 3600_000;
const MAX_AHEAD_MS = 60_000;

export interface ImageLinkParams {
  /** The DB id, as the URL's user_id carries it */
  userId: string;
  /** 'summary', 'cached' or 'fresh' (the URL leaves out 'fresh') */
  source: string;
  /** The summary's message id, when the link is for one */
  msgId?: string | null;
  /** When the link was signed, in ms since the epoch */
  ts: number;
}

function payload(p: ImageLinkParams): string {
  return `${p.userId}:${p.source}:${p.msgId ?? ''}:${p.ts}`;
}

/** The hex signature for a link, or null when there is no image-link key (SESSION_SECRET unset). */
export function signImageLink(p: ImageLinkParams): string | null {
  const key = appKey('image-link');
  if (!key) return null;
  return crypto.createHmac('sha256', key).update(payload(p)).digest('hex');
}

/**
 * True when `sig` signs these params under the image-link key and the link's time is
 * within the window. False with no key. Constant-time compare.
 */
export function verifyImageLink(p: ImageLinkParams, sig: string, nowMs: number = Date.now()): boolean {
  if (!Number.isSafeInteger(p.ts)) return false;
  if (p.ts - nowMs > MAX_AHEAD_MS || nowMs - p.ts > MAX_AGE_MS) return false;
  const expected = signImageLink(p);
  if (!expected) return false;
  const want = Buffer.from(expected);
  const given = Buffer.from(sig);
  // timingSafeEqual throws on different lengths
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

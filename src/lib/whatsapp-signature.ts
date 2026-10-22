/**
 * WhatsApp webhook signatures. Meta signs every webhook POST: X-Hub-Signature-256 is
 * 'sha256=' plus the hex HMAC-SHA256 of the raw body under the app secret. Without the
 * check, anyone could post a WhatsApp-shaped body and act as any phone.
 */

import crypto from 'crypto';

/** True when `header` is the body's signature under `secret`. Constant-time compare. */
export function isValidWhatsAppSignature(rawBody: string, header: string | null, secret: string): boolean {
  if (!header) return false;
  const expected = Buffer.from(`sha256=${crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')}`);
  const given = Buffer.from(header);
  // timingSafeEqual throws on different lengths
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/**
 * verified: signed with WHATSAPP_APP_SECRET. rejected: the secret is set and the signature
 * is missing or wrong. unconfigured: no secret (unset or ''), so nothing can be verified:
 * refused, never processed unsigned.
 */
export function checkWhatsAppSignature(rawBody: string, header: string | null): 'verified' | 'rejected' | 'unconfigured' {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) return 'unconfigured';
  return isValidWhatsAppSignature(rawBody, header, secret) ? 'verified' : 'rejected';
}

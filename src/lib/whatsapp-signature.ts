/**
 * WhatsApp webhook signatures. Meta signs every webhook POST: X-Hub-Signature-256 is
 * 'sha256=' plus the hex HMAC-SHA256 of the raw body under the app secret. Without the
 * check, anyone could post a WhatsApp-shaped body and act as any phone.
 */

import crypto from 'crypto';

/**
 * What a WhatsApp POST gets while WHATSAPP_APP_SECRET is unset. true: processed
 * unverified, as before signatures were checked, with one error log per process. false:
 * refused. The owner hasn't chosen yet; flipping this line is the whole change.
 */
export const ACCEPT_UNSIGNED_WHATSAPP_WEBHOOKS = true;

const UNSIGNED_WARNING = '[WhatsApp] WHATSAPP_APP_SECRET is not set; webhook signatures are NOT verified';

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
 * is missing or wrong. unverified: no secret, accepted (ACCEPT_UNSIGNED_WHATSAPP_WEBHOOKS).
 * unconfigured: no secret, refused.
 */
export function checkWhatsAppSignature(rawBody: string, header: string | null): 'verified' | 'rejected' | 'unverified' | 'unconfigured' {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (secret) return isValidWhatsAppSignature(rawBody, header, secret) ? 'verified' : 'rejected';
  if (!ACCEPT_UNSIGNED_WHATSAPP_WEBHOOKS) return 'unconfigured';
  // Once per process: route bundles can each hold their own copy of this module
  const g = globalThis as { __famcalUnsignedWhatsAppWarned?: boolean };
  if (!g.__famcalUnsignedWhatsAppWarned) {
    g.__famcalUnsignedWhatsAppWarned = true;
    console.error(UNSIGNED_WARNING);
  }
  return 'unverified';
}

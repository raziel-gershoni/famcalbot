/**
 * Keys the app derives from SESSION_SECRET, one per purpose. HKDF (RFC 5869) turns the one
 * secret into independent keys, each bound to its own label, so a session-cookie signature
 * can never pass as an image-link signature, and neither key is SESSION_SECRET itself.
 *
 * There is no fallback to another secret: with SESSION_SECRET unset or '' every key is
 * null, and its callers refuse (no session cookie, no image link).
 */

import crypto from 'crypto';
import { captureError } from './error-capture';

export type AppKeyPurpose = 'session-cookie' | 'image-link';

/**
 * The purposes already reported missing in this process. On globalThis: the scheduler and
 * the route bundles each load their own copy of this module (Next 16).
 */
function reportedMissing(): Set<AppKeyPurpose> {
  const g = globalThis as { __famcalAppKeyMissing?: Set<AppKeyPurpose> };
  g.__famcalAppKeyMissing ??= new Set();
  return g.__famcalAppKeyMissing;
}

/**
 * The 32-byte key for `purpose`, or null when SESSION_SECRET is unset or ''. Reads the env
 * on each call, so a changed value is seen at once. A missing secret is reported once per
 * process per purpose (app-key-missing), never with a value.
 */
export function appKey(purpose: AppKeyPurpose): Buffer | null {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    const reported = reportedMissing();
    if (!reported.has(purpose)) {
      reported.add(purpose);
      captureError(new Error(`SESSION_SECRET is not set: no ${purpose} key, so ${purpose} requests are refused`), 'app-key-missing', { purpose });
    }
    return null;
  }
  return Buffer.from(crypto.hkdfSync('sha256', secret, '', `famcal/${purpose}/v1`, 32));
}

/**
 * The keyed hash of a Google account's address (web sign-in spec §2.17): what FamCal keeps of the account a calendar
 * is connected from, so that a Google sign-in with that account can find the person. Never the address itself. The key
 * is appKey('google-account') (HKDF from SESSION_SECRET with its own label); the value starts with the key's id, so the
 * startup pass (calendar-account.ts) can tell a key made under another SESSION_SECRET and make it again. Pure, with no
 * I/O, so the OAuth callback and google-connect.ts import it without the sign-in modules.
 */

import crypto from 'crypto';
import { appKey } from '../../lib/app-keys';

const idOf = (key: Buffer) => crypto.createHmac('sha256', key).update('key-id').digest('hex').slice(0, 8);

/** The id of the key in use: the first 8 hex of HMAC(key, 'key-id'); null when SESSION_SECRET is unset. */
export function googleAccountKeyId(): string | null {
  const key = appKey('google-account');
  return key ? idOf(key) : null;
}

/** `<key id>:<hex HMAC-SHA256 of the trimmed, lower-cased address>`; null when SESSION_SECRET is unset or the address is empty. */
export function googleAccountKey(address: string): string | null {
  const normalized = address.trim().toLowerCase();
  if (!normalized) return null;
  const key = appKey('google-account');
  if (!key) return null;
  return `${idOf(key)}:${crypto.createHmac('sha256', key).update(`address:${normalized}`).digest('hex')}`;
}

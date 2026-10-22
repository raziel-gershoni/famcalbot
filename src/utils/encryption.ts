/**
 * Encryption utility for sensitive data (OAuth tokens)
 * Uses AES-256-GCM encryption
 *
 * Key rotation (secret rotation spec §a): ENCRYPTION_KEY encrypts and decrypts;
 * ENCRYPTION_KEY_PREVIOUS, when set, only decrypts, so values written under the old key
 * stay readable until the key sweep re-encrypts them. Both are read from env on every
 * call. The scheduler and the routes load separate copies of this module (Next 16), so
 * the once-per-process reports live on globalThis.
 */

import crypto from 'crypto';
import { captureError } from '../lib/error-capture';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const KEY_HEX = /^[0-9a-f]{64}$/i;
/** What encrypt('') writes: iv and tag, no data. select-calendars wrote it for users with no token. */
const EMPTY_CIPHER = /^[0-9a-f]{32}:[0-9a-f]{32}:$/i;

/**
 * A stored value that neither key opens, or that is not in our iv:tag:data format. It has
 * no `code` and wraps nothing: classifyGoogleError counts an error with a string code and
 * no response as transient, which would keep it out of Sentry.
 */
export class UndecryptableError extends Error {
  constructor(message = 'The value does not decrypt with ENCRYPTION_KEY or ENCRYPTION_KEY_PREVIOUS') {
    super(message);
    this.name = 'UndecryptableError';
  }
}

/** Once per process, shared by every copy of this module. */
type Reports = { previousInvalid: boolean; previousSame: boolean; undecryptable: Set<string> };
function reports(): Reports {
  const g = globalThis as typeof globalThis & { __famcalEncryptionReports?: Reports };
  g.__famcalEncryptionReports ??= { previousInvalid: false, previousSame: false, undecryptable: new Set() };
  return g.__famcalEncryptionReports;
}

/** Whether a raw ENCRYPTION_KEY value is one the app can use: 64 hex characters once trimmed (the rule envKey/parseKey apply). */
export function isUsableEncryptionKey(raw: string | undefined): boolean {
  return KEY_HEX.test((raw ?? '').trim());
}

/** Parsed keys by their raw env value: a changed env is seen on the next call. */
const parsedKeys = new Map<string, Buffer>();
function parseKey(raw: string): Buffer | null {
  if (!KEY_HEX.test(raw)) return null;
  let key = parsedKeys.get(raw);
  if (!key) {
    key = Buffer.from(raw, 'hex');
    parsedKeys.set(raw, key);
  }
  return key;
}

/**
 * A key as set in env, trimmed. Buffer.from(hex) used to stop at a trailing newline or
 * space from a paste, so a value like that worked before and must keep working.
 */
function envKey(name: 'ENCRYPTION_KEY' | 'ENCRYPTION_KEY_PREVIOUS'): string {
  return (process.env[name] ?? '').trim();
}

// The current key: encrypts, and decrypts first. Missing or malformed throws, as before.
function getKeyBuffer(): Buffer {
  const raw = envKey('ENCRYPTION_KEY');
  if (!raw) {
    console.error('ENCRYPTION_KEY environment variable is not set');
    throw new Error('ENCRYPTION_KEY environment variable is required');
  }
  const key = parseKey(raw);
  if (!key) {
    console.error(`ENCRYPTION_KEY has wrong length or format: ${raw.length} characters (expected 64 hex)`);
    throw new Error('ENCRYPTION_KEY must be 32 bytes (64 hex characters)');
  }
  return key;
}

export type PreviousKeyStatus = 'unset' | 'valid' | 'invalid' | 'same';

/**
 * ENCRYPTION_KEY_PREVIOUS as decryption sees it. An invalid value (logged and captured)
 * or one equal to ENCRYPTION_KEY (a warning) is ignored, each reported once per process.
 */
export function previousKeyStatus(): PreviousKeyStatus {
  const raw = envKey('ENCRYPTION_KEY_PREVIOUS');
  if (raw === '') return 'unset';
  const previous = parseKey(raw);
  if (!previous) {
    const r = reports();
    if (!r.previousInvalid) {
      r.previousInvalid = true;
      console.error(`[encryption] ENCRYPTION_KEY_PREVIOUS is not 64 hex characters (${raw.length} characters); ignored`);
      captureError(new Error('ENCRYPTION_KEY_PREVIOUS is not 64 hex characters; ignored'), 'encryption-previous-invalid');
    }
    return 'invalid';
  }
  const current = parseKey(envKey('ENCRYPTION_KEY'));
  if (current && current.equals(previous)) {
    const r = reports();
    if (!r.previousSame) {
      r.previousSame = true;
      console.warn('[encryption] ENCRYPTION_KEY_PREVIOUS is the same key as ENCRYPTION_KEY; ignored (nothing is rotated)');
    }
    return 'same';
  }
  return 'valid';
}

function previousKey(): Buffer | null {
  return previousKeyStatus() === 'valid' ? parseKey(envKey('ENCRYPTION_KEY_PREVIOUS')) : null;
}

/**
 * Encrypt a string, always with ENCRYPTION_KEY
 */
export function encrypt(text: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKeyBuffer(), iv);

  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag();

  // Format: iv:authTag:encryptedData
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

/** The plaintext under `key`, or null when GCM's tag check refuses the key (or the data). */
function openWith(key: Buffer, iv: Buffer, authTag: Buffer, encrypted: string): string | null {
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch {
    // Expected while trying keys: a wrong key fails the tag check. The caller throws
    // UndecryptableError, which is logged, once neither key opens the value.
    return null;
  }
}

/**
 * Decrypt with ENCRYPTION_KEY, then ENCRYPTION_KEY_PREVIOUS, and say which one opened it.
 * Two keys are safe to try: AES-GCM's tag check refuses a wrong key.
 */
export function decryptDetailed(encryptedText: string): { value: string; key: 'current' | 'previous' } {
  const parts = encryptedText.split(':');

  if (parts.length !== 3) {
    throw new UndecryptableError('Invalid encrypted text format');
  }

  const iv = Buffer.from(parts[0], 'hex');
  const authTag = Buffer.from(parts[1], 'hex');
  const encrypted = parts[2];

  // encrypt() always writes a 16-byte tag. Node 22 (engines.node) would otherwise verify
  // a truncated one down to 4 bytes (DEP0182), so a forgery only had to match 32 bits.
  if (authTag.length !== AUTH_TAG_LENGTH) {
    throw new UndecryptableError('Invalid encrypted text format');
  }

  const current = openWith(getKeyBuffer(), iv, authTag, encrypted);
  if (current !== null) return { value: current, key: 'current' };
  const previous = previousKey();
  const old = previous ? openWith(previous, iv, authTag, encrypted) : null;
  if (old !== null) return { value: old, key: 'previous' };
  throw new UndecryptableError();
}

/**
 * Decrypt a string (ENCRYPTION_KEY, then ENCRYPTION_KEY_PREVIOUS)
 */
export function decrypt(encryptedText: string): string {
  return decryptDetailed(encryptedText).value;
}

/**
 * Check if a string is encrypted (has our format)
 */
export function isEncrypted(text: string): boolean {
  return /^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/i.test(text);
}

/**
 * Safely decrypt (returns original if not encrypted)
 */
export function safeDecrypt(text: string): string {
  if (!text) return text;
  return isEncrypted(text) ? decrypt(text) : text;
}

/** An empty cipher (iv:tag: with no data) is what select-calendars wrote for "no token". */
export function isEmptyCipher(raw: string): boolean {
  return EMPTY_CIPHER.test(raw);
}

/** A stored token column as the app means it: an empty cipher is no token (''). */
export function normalizeStored(raw: string): string {
  return isEmptyCipher(raw) ? '' : raw;
}

/**
 * A stored Google token, decrypted. Never throws: no token or an empty cipher is '', legacy
 * plaintext comes back as it is, and a value neither key opens is '' (the user counts as
 * not connected), logged and captured once per user and column per process. Never logs
 * the value.
 */
export function readStoredToken(stored: string, ctx: { userId: number; column: string }): string {
  if (!stored) return '';
  const value = normalizeStored(stored);
  if (!value) return '';
  if (!isEncrypted(value)) return value;
  try {
    return decrypt(value);
  } catch (err) {
    reportUndecryptable(err, ctx);
    return '';
  }
}

/**
 * Logs and captures (token-undecryptable) a stored token that no key opens, once per user
 * and column per process. Ids only, never the value. The one report for every source of a
 * token (the database columns via readStoredToken, the reminder cache).
 */
export function reportUndecryptable(err: unknown, ctx: { userId: number; column: string }): void {
  const seen = reports().undecryptable;
  const key = `${ctx.userId}:${ctx.column}`;
  if (seen.has(key)) return;
  seen.add(key);
  console.error('[token] undecryptable', { userId: ctx.userId, column: ctx.column });
  captureError(err, 'token-undecryptable', { user_id: ctx.userId, column: ctx.column });
}

/** The first 8 hex characters of sha256 over the key's 32 bytes; null when unset or invalid. For log lines only. */
export function keyFingerprint(which: 'current' | 'previous'): string | null {
  const key = parseKey(envKey(which === 'current' ? 'ENCRYPTION_KEY' : 'ENCRYPTION_KEY_PREVIOUS'));
  return key ? crypto.createHash('sha256').update(key).digest('hex').slice(0, 8) : null;
}

/** The startup line: which keys this process has, by fingerprint. */
export function describeKeys(): string {
  const fp = keyFingerprint('current');
  const current = fp ? `ENCRYPTION_KEY fp ${fp}` : 'ENCRYPTION_KEY missing or invalid';
  const status = previousKeyStatus();
  const previous =
    status === 'unset' ? 'unset'
    : status === 'invalid' ? 'invalid (ignored)'
    : status === 'same' ? 'same as ENCRYPTION_KEY (ignored)'
    : `fp ${keyFingerprint('previous')}`;
  return `[startup] ${current}; ENCRYPTION_KEY_PREVIOUS ${previous}`;
}

/** A secret for Redis: '' stays '', a value already encrypted passes, anything else is encrypted. */
export function sealSecret(v: string): string {
  if (v === '' || isEncrypted(v)) return v;
  return encrypt(v);
}

/** A sealed secret back: '' is '', anything else must decrypt (either key) or UndecryptableError is thrown. */
export function openSecret(v: string): string {
  if (v === '') return '';
  if (!isEncrypted(v)) throw new UndecryptableError('Not an encrypted value');
  return decrypt(v);
}

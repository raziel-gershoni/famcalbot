/**
 * Voice pending entries (voice:pending:event|edit|delete|batch:*) keep the user's whole
 * UserConfig in Redis for ten minutes, until the confirm or cancel tap. Its Google token
 * goes in sealed (sealSecret: ciphertext) and comes out opened, so Redis never holds it in
 * plain form (secret rotation spec, section c). Only the pending setters and getters in
 * confirmations.ts and bulk-confirmations.ts call these; their callers see the plain
 * UserConfig as before.
 */

import { isEncrypted, openSecret, sealSecret } from '../../utils/encryption';

/** The user with its Google token sealed, for a pending entry's write. No token: unchanged. */
export function sealUser<T extends { googleRefreshToken: string }>(user: T): T {
  if (!user.googleRefreshToken) return user;
  return { ...user, googleRefreshToken: sealSecret(user.googleRefreshToken) };
}

/**
 * The user of a pending entry with its Google token opened. Throws UndecryptableError when
 * no key opens it; the getters treat that as any failed read. An entry written in plain
 * form before this release (at most ten minutes before the deploy) is accepted with a
 * warning; remove that branch in a later release.
 */
export function openUser<T extends { googleRefreshToken: string }>(stored: T): T {
  const token = stored.googleRefreshToken;
  if (!token) return stored;
  if (!isEncrypted(token)) {
    console.warn('[voice-pending] legacy plaintext pending entry accepted');
    return stored;
  }
  return { ...stored, googleRefreshToken: openSecret(token) };
}

/**
 * Voice pending entries (voice:pending:event|edit|delete|batch:*) keep the user's whole
 * UserConfig in Redis for ten minutes, until the confirm or cancel tap. Its Google token
 * goes in sealed (sealSecret: ciphertext) and comes out opened, so Redis never holds it in
 * plain form (secret rotation spec, section c). Only the pending setters and getters in
 * confirmations.ts and bulk-confirmations.ts call these; their callers see the plain
 * UserConfig as before.
 */

import { openSecret, sealSecret } from '../../utils/encryption';

/** The user with its Google token sealed, for a pending entry's write. No token: unchanged. */
export function sealUser<T extends { googleRefreshToken: string }>(user: T): T {
  if (!user.googleRefreshToken) return user;
  return { ...user, googleRefreshToken: sealSecret(user.googleRefreshToken) };
}

/**
 * The user of a pending entry with its Google token opened. Throws UndecryptableError when
 * no key opens it, and for a token that is not sealed at all (nothing writes one: an entry
 * lives ten minutes and sealing shipped 2026-10-23); the getters treat that as any failed
 * read, and the error names no value.
 */
export function openUser<T extends { googleRefreshToken: string }>(stored: T): T {
  const token = stored.googleRefreshToken;
  if (!token) return stored;
  return { ...stored, googleRefreshToken: openSecret(token) };
}

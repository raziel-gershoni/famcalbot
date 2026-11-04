/**
 * Email codes (spec docs/superpowers/specs/2026-11-02-web-sign-in-design.md §3 "Email", §5; the sign-up code, web
 * sign-up spec 2026-11-03 §3.1, §3.2).
 *
 *   issueCode   a 6-digit code (crypto.randomInt), kept in Upstash only as a keyed hash (HMAC-SHA256 with
 *               appKey('signin')) with its account and address, for 10 minutes, one per purpose and address: a new code
 *               replaces the old one and, once it is mailed, its tries start again. That reset is safe because the
 *               new code is a fresh secret and the guesses are capped apart from it: 10 wrong codes a day per address
 *               pause the checks (recordWrongCode, limits.ts), and that count is not reset. The day's send budget
 *               (takeDailySend) is asked before the code is stored, so a spent day never replaces a code that still
 *               works. Then it is mailed; when the send fails (sendCodeEmail throws), the code that worked before is
 *               put back with its remaining time and tries, so a failed send never leaves the person with no code.
 *               A sign-in or Add email code names its account; a sign-up code names none (there is no account yet):
 *               its record is the hash and the address it went to, and nothing else.
 *   checkCode   counts the try with countWithin (limits.ts: one Lua call, INCR and the expiry together, so a count is
 *               never left without one) before it compares; the fifth wrong try voids the code; a right one is used up
 *               at once (GETDEL). A missing code is 'expired', with the same work as a wrong one. A right code gives
 *               its account (null for a sign-up code) and its address.
 *
 * The account lookups by address (findEmailSignIn, emailSignInAccount, touchEmailSignIn) are in identities.ts, the one
 * file that reads SignInIdentity.
 *
 * No line holds the address or the code. Server only.
 */

import crypto from 'crypto';
import { appKey } from '../../lib/app-keys';
import { matchesSecret } from '../../lib/secret-compare';
import { REDIS_KEYS } from '../../config/redis-keys';
import { redis } from '../../utils/redis';
import { countWithin, takeDailySend } from './limits';
import { codeOwner, sendCodeEmail, type CodePurpose } from './email-send';
import { SafeSignInError, safeErrorSummary } from './safe-error';

/** How long a code works, and how long its tries are counted (s). */
export const CODE_TTL_SEC = 10 * 60;
/** What is left of a stored code's time, from Redis's TTL answer (-1 no expiry, -2 no key), never past a code's 10 minutes. */
export function codeTimeLeftSec(ttl: number): number {
  return ttl > 0 ? Math.min(ttl, CODE_TTL_SEC) : 0;
}

/** Tries per code: the fifth wrong one voids it. */
export const CODE_MAX_TRIES = 5;

/** A stored code: its keyed hash and the address it went to; the account it signs in or adds to, except a sign-up code's. */
interface CodeRecord {
  hash: string;
  userId?: number;
  address: string;
}

/** A stored code of this purpose: a sign-up code has no account, every other code has one. */
function isCodeRecord(value: unknown, purpose: CodePurpose): value is CodeRecord {
  const v = value as Partial<CodeRecord> | null;
  if (!v || typeof v !== 'object' || typeof v.hash !== 'string' || typeof v.address !== 'string') return false;
  return purpose === 'signup' ? v.userId === undefined : typeof v.userId === 'number';
}

/** The code's keyed hash, bound to its purpose and address. Throws without SESSION_SECRET (appKey reports it). */
function codeHash(purpose: CodePurpose, emailKey: string, code: string): string {
  const key = appKey('signin');
  if (!key) throw new SafeSignInError('SESSION_SECRET is not set: no sign-in key, so no code can be made or checked');
  return crypto.createHmac('sha256', key).update(`code:${purpose}:${emailKey}:${code}`).digest('hex');
}

/**
 * Makes, stores and mails a code for `address` (the row's address for sign-in; the address being added for 'add'; the
 * normalised address typed for 'signup'). `userId` is the account, and null exactly for a sign-up code.
 */
export async function issueCode(args: { purpose: CodePurpose; emailKey: string; address: string; userId: number | null; locale: string }): Promise<void> {
  const { purpose, emailKey, address, userId, locale } = args;
  if ((purpose === 'signup') !== (userId === null)) {
    throw new SafeSignInError(`a ${purpose} code ${userId === null ? 'needs an account' : 'names no account'}`);
  }
  const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
  const record: CodeRecord = { hash: codeHash(purpose, emailKey, code), address, ...(userId !== null ? { userId } : {}) };
  if (!(await takeDailySend())) {
    console.warn(`[signin-email] the day's send budget is spent: no ${purpose} code for ${codeOwner(userId)}`);
    return;
  }
  const codeKey = REDIS_KEYS.signinCode(purpose, emailKey);
  const stored = await redis.get<CodeRecord>(codeKey);
  const previous = isCodeRecord(stored, purpose) ? stored : null;
  const previousSec = previous ? await redis.ttl(codeKey) : -2;
  await redis.set(codeKey, record, { ex: CODE_TTL_SEC });
  try {
    await sendCodeEmail({ to: address, code, locale, purpose, userId });
  } catch (error) {
    await restoreAfterFailedSend(codeKey, record, previous, previousSec, purpose, userId);
    throw error;
  }
  // The tries start again only for a code that reached the person (a failed send keeps the old code's count).
  await redis.del(REDIS_KEYS.signinCodeTries(purpose, emailKey));
}

/**
 * The send failed, so the new code was never delivered: put the code that worked before back with the time it had left,
 * or drop the new one when there was none. Only while the stored code is still this one (a newer request may have
 * replaced it). A failure here is logged and the send's own error is still the one thrown.
 */
async function restoreAfterFailedSend(
  codeKey: string,
  issued: CodeRecord,
  previous: CodeRecord | null,
  previousSec: number,
  purpose: CodePurpose,
  userId: number | null
): Promise<void> {
  try {
    const current = await redis.get<CodeRecord>(codeKey);
    if (!isCodeRecord(current, purpose) || current.hash !== issued.hash) return;
    const codeLeftSec = codeTimeLeftSec(previousSec);
    if (previous && codeLeftSec > 0) {
      await redis.set(codeKey, previous, { ex: codeLeftSec });
      console.warn(`[signin-email] the ${purpose} code for ${codeOwner(userId)} was not sent: the earlier code works again`);
    } else {
      await redis.del(codeKey);
    }
  } catch (restoreError) {
    console.error(`[signin-email] the ${purpose} code for ${codeOwner(userId)} was not sent, and the earlier code could not be put back: ${safeErrorSummary(restoreError)}`);
  }
}

/** Checks `code` against the address's current code of this purpose (see the file comment). */
export async function checkCode(
  purpose: CodePurpose,
  emailKey: string,
  code: string
): Promise<{ ok: true; userId: number | null; address: string } | { ok: false; reason: 'wrong' | 'expired' }> {
  const codeKey = REDIS_KEYS.signinCode(purpose, emailKey);
  const triesKey = REDIS_KEYS.signinCodeTries(purpose, emailKey);
  const given = codeHash(purpose, emailKey, code);
  const tries = await countWithin(triesKey, CODE_TTL_SEC);
  const stored = await redis.get<CodeRecord>(codeKey);
  if (!isCodeRecord(stored, purpose)) return { ok: false, reason: 'expired' };
  if (tries > CODE_MAX_TRIES) {
    await redis.del(codeKey);
    return { ok: false, reason: 'expired' };
  }
  if (!matchesSecret(given, stored.hash)) {
    if (tries === CODE_MAX_TRIES) await redis.del(codeKey);
    return { ok: false, reason: 'wrong' };
  }
  // Used up at once. Another request may have taken it, or a new code replaced it, since the read.
  const claimed = await redis.getdel<CodeRecord>(codeKey);
  if (!isCodeRecord(claimed, purpose) || !matchesSecret(given, claimed.hash)) return { ok: false, reason: 'expired' };
  await redis.del(triesKey);
  return { ok: true, userId: claimed.userId ?? null, address: claimed.address };
}

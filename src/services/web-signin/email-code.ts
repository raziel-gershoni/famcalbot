/**
 * Email sign-in codes (spec docs/superpowers/specs/2026-11-02-web-sign-in-design.md §3 "Email", §5).
 *
 *   issueCode   a 6-digit code (crypto.randomInt), kept in Upstash only as a keyed hash (HMAC-SHA256 with
 *               appKey('signin')) with its user and address, for 10 minutes, one per purpose and address: a new code
 *               replaces the old one and its tries start again. The day's send budget (takeDailySend) is asked before
 *               the code is stored, so a spent day never replaces a code that still works. Then it is mailed.
 *   checkCode   counts the try with countWithin (limits.ts: one Lua call, INCR and the expiry together, so a count is
 *               never left without one) before it compares; the fifth wrong try voids the code; a right one is used up
 *               at once (GETDEL). A missing code is 'expired', with the same work as a wrong one.
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
import { sendCodeEmail, type CodePurpose } from './email-send';
import { SafeSignInError } from './safe-error';

/** How long a code works, and how long its tries are counted (s). */
export const CODE_TTL_SEC = 10 * 60;
/** Tries per code: the fifth wrong one voids it. */
export const CODE_MAX_TRIES = 5;

interface CodeRecord {
  hash: string;
  userId: number;
  address: string;
}

function isCodeRecord(value: unknown): value is CodeRecord {
  const v = value as Partial<CodeRecord> | null;
  return !!v && typeof v === 'object' && typeof v.hash === 'string' && typeof v.userId === 'number' && typeof v.address === 'string';
}

/** The code's keyed hash, bound to its purpose and address. Throws without SESSION_SECRET (appKey reports it). */
function codeHash(purpose: CodePurpose, emailKey: string, code: string): string {
  const key = appKey('signin');
  if (!key) throw new SafeSignInError('SESSION_SECRET is not set: no sign-in key, so no code can be made or checked');
  return crypto.createHmac('sha256', key).update(`code:${purpose}:${emailKey}:${code}`).digest('hex');
}

/** Makes, stores and mails a code for `address` (the row's address for sign-in; the address being added for 'add'). */
export async function issueCode(args: { purpose: CodePurpose; emailKey: string; address: string; userId: number; locale: string }): Promise<void> {
  const { purpose, emailKey, address, userId, locale } = args;
  const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
  const record: CodeRecord = { hash: codeHash(purpose, emailKey, code), userId, address };
  if (!(await takeDailySend())) {
    console.warn(`[signin-email] the day's send budget is spent: no ${purpose} code for user ${userId}`);
    return;
  }
  await redis.set(REDIS_KEYS.signinCode(purpose, emailKey), record, { ex: CODE_TTL_SEC });
  await redis.del(REDIS_KEYS.signinCodeTries(purpose, emailKey));
  await sendCodeEmail({ to: address, code, locale, purpose, userId });
}

/** Checks `code` against the address's current code (see the file comment). */
export async function checkCode(
  purpose: CodePurpose,
  emailKey: string,
  code: string
): Promise<{ ok: true; userId: number; address: string } | { ok: false; reason: 'wrong' | 'expired' }> {
  const codeKey = REDIS_KEYS.signinCode(purpose, emailKey);
  const triesKey = REDIS_KEYS.signinCodeTries(purpose, emailKey);
  const given = codeHash(purpose, emailKey, code);
  const tries = await countWithin(triesKey, CODE_TTL_SEC);
  const stored = await redis.get<CodeRecord>(codeKey);
  if (!isCodeRecord(stored)) return { ok: false, reason: 'expired' };
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
  if (!isCodeRecord(claimed) || !matchesSecret(given, claimed.hash)) return { ok: false, reason: 'expired' };
  await redis.del(triesKey);
  return { ok: true, userId: claimed.userId, address: claimed.address };
}

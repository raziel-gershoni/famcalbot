/**
 * The email sign-in limits (web sign-in spec §5), all in Upstash, before any database lookup, and counted the same for
 * an address no account has, so the answers and their timing say nothing about who has an account.
 *
 * | What                               | Limit                                                       |
 * |------------------------------------|-------------------------------------------------------------|
 * | Codes to one email                 | 1 a minute, 5 a day                                         |
 * | Code requests from one address     | 20 an hour                                                  |
 * | Add-email codes per account        | 3 addresses a day                                           |
 * | Wrong codes for one email          | 10 a day, then email sign-in for it pauses for a day        |
 * | Wrong codes from one address       | 20 an hour                                                  |
 * | All codes sent                     | 90 a UTC day (Resend allows 100), then one admin message    |
 *
 * (Tries per code, 5 then void, are counted by email-code.ts through countWithin below.)
 *
 * - Keys are `signin:lim:<what>:<keyed hash>` (signinHash: the email's key, the address's, the account's), never an
 *   address, an IP or a user id in clear, and each expires within a day. The day's budget is keyed by its UTC date and
 *   expires at the next 00:00 UTC.
 * - A count and its expiry are set in one Lua call, so no key is ever left without one. A count past its limit is
 *   still counted (an attacker's flood doesn't reset anything).
 * - Redis failing fails closed: no code is sent or checked, and the failure is logged.
 * - An address is clientAddress() (x-real-ip, IPv6 by /64). Without one, requests count under one shared key, logged
 *   once per process (a sign that Railway stopped setting the header).
 */

import { redis } from '../../utils/redis';
import { REDIS_KEYS } from '../../config/redis-keys';
import { captureError } from '../../lib/error-capture';
import { signinHash } from './email-address';

export type LimitReason =
  | 'email-minute'
  | 'email-day'
  | 'ip-hour'
  | 'account-day'
  | 'wrong-email-day'
  | 'wrong-ip-hour'
  | 'daily-budget'
  | 'store-down';

const MINUTE_SEC = 60;
const HOUR_SEC = 60 * 60;
const DAY_SEC = 24 * 60 * 60;
const DAY_MS = DAY_SEC * 1000;

const LIMIT = {
  codesPerEmailDay: 5,
  codeRequestsPerAddressHour: 20,
  addAddressesPerAccountDay: 3,
  wrongCodesPerEmailDay: 10,
  wrongCodesPerAddressHour: 20,
  codesSentPerDay: 90,
} as const;

/**
 * INCR KEYS[1] and return the count; set its expiry (ARGV[1] seconds) when it has none, and again when the count
 * reaches ARGV[2] (when > 0), so the pause after a limit is a whole window. Exported so the smoke pins its text.
 */
export const COUNT_SCRIPT =
  "local n = redis.call('INCR', KEYS[1]) if redis.call('TTL', KEYS[1]) < 0 or n == tonumber(ARGV[2]) then redis.call('EXPIRE', KEYS[1], ARGV[1]) end return n";
/**
 * SADD ARGV[1] to the set KEYS[1], with its expiry (ARGV[2] seconds) when it has none. A new member past ARGV[3]
 * members is taken out again and refused (0); otherwise 1. A member already in the set always passes. Exported so the
 * smoke pins its text.
 */
export const ADD_MEMBER_SCRIPT =
  "local added = redis.call('SADD', KEYS[1], ARGV[1]) if redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end if added == 1 and redis.call('SCARD', KEYS[1]) > tonumber(ARGV[3]) then redis.call('SREM', KEYS[1], ARGV[1]) return 0 end return 1";

/** The key every request without a client address shares. */
const NO_ADDRESS = 'none';

const limitKey = (what: string, id: string) => REDIS_KEYS.signinLimit(what, id);

/** The address's hash, the shared one without an address (said once per process, on globalThis: Next 16 bundles). */
function addressId(ip: string | null): string {
  if (ip === null) {
    const g = globalThis as { __famcalSigninNoAddressWarned?: boolean };
    if (!g.__famcalSigninNoAddressWarned) {
      g.__famcalSigninNoAddressWarned = true;
      console.warn('[signin-limits] a request came with no x-real-ip: requests without one share one count');
    }
  }
  return signinHash('ip', ip ?? NO_ADDRESS);
}

async function count(key: string, windowSec: number, restartAt = 0): Promise<number> {
  return Number(await redis.eval(COUNT_SCRIPT, [key], [String(windowSec), String(restartAt)]));
}

/**
 * Counts one more on `key` and returns the count: the first count gives the key `windowSec` seconds to live, the next
 * ones don't renew it. One Lua call, so a crash between an INCR and an EXPIRE can't leave a counter that never ends.
 * For a count that is not one of the limits above (Task 5's tries per code). A Redis failure is thrown: the caller
 * decides what a failed count means.
 */
export async function countWithin(key: string, windowSec: number): Promise<number> {
  return count(key, windowSec);
}

/** The day's budget: its key (the UTC date) and the seconds to the next 00:00 UTC. */
function budget(nowMs: number): { key: string; ttlSec: number } {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const nextMidnight = (Math.floor(nowMs / DAY_MS) + 1) * DAY_MS;
  return { key: limitKey('daily-send', day), ttlSec: Math.max(1, Math.ceil((nextMidnight - nowMs) / 1000)) };
}

function refused(step: string, reason: LimitReason, userId?: number): { ok: false; reason: LimitReason } {
  console.info(`[signin-limits] ${step} refused: ${reason}${userId !== undefined ? ` (user ${userId})` : ''}`);
  return { ok: false, reason };
}

/**
 * May a code be mailed for this address? Counts the request: the address's 20 an hour, then the email's 1 a minute
 * and 5 a day, then (Add email, `addForUserId`) the account's 3 addresses a day. Refused first, without counting, when
 * the day's 90 are sent or the email is paused for wrong codes. Runs for every request, whether or not an account has
 * the address.
 */
export async function allowCodeRequest(args: {
  emailKey: string;
  ip: string | null;
  addForUserId?: number;
}): Promise<{ ok: true } | { ok: false; reason: LimitReason }> {
  const step = args.addForUserId !== undefined ? 'add-email code request' : 'code request';
  try {
    const [sent, wrong] = await redis.mget<(number | string | null)[]>(
      budget(Date.now()).key,
      limitKey('wrong-email-day', args.emailKey),
    );
    if (Number(sent ?? 0) >= LIMIT.codesSentPerDay) return refused(step, 'daily-budget', args.addForUserId);
    if (Number(wrong ?? 0) >= LIMIT.wrongCodesPerEmailDay) return refused(step, 'wrong-email-day', args.addForUserId);
    if ((await count(limitKey('ip-hour', addressId(args.ip)), HOUR_SEC)) > LIMIT.codeRequestsPerAddressHour) {
      return refused(step, 'ip-hour', args.addForUserId);
    }
    const firstThisMinute = await redis.set(limitKey('email-minute', args.emailKey), 1, { nx: true, ex: MINUTE_SEC });
    if (firstThisMinute === null) return refused(step, 'email-minute', args.addForUserId);
    if ((await count(limitKey('email-day', args.emailKey), DAY_SEC)) > LIMIT.codesPerEmailDay) {
      return refused(step, 'email-day', args.addForUserId);
    }
    if (args.addForUserId !== undefined) {
      const accountKey = limitKey('account-day', signinHash('account', String(args.addForUserId)));
      const allowed = Number(await redis.eval(ADD_MEMBER_SCRIPT, [accountKey], [args.emailKey, String(DAY_SEC), String(LIMIT.addAddressesPerAccountDay)]));
      if (allowed !== 1) return refused(step, 'account-day', args.addForUserId);
    }
    return { ok: true };
  } catch (error) {
    captureError(error, 'signin-limits', { step, ...(args.addForUserId !== undefined ? { user_id: args.addForUserId } : {}) });
    return { ok: false, reason: 'store-down' };
  }
}

/** Is checking a code paused here: 10 wrong codes for this email today, or 20 from this address this hour? Fails closed. */
export async function codeChecksBlocked(args: { emailKey: string; ip: string | null }): Promise<boolean> {
  try {
    const [forEmail, fromAddress] = await redis.mget<(number | string | null)[]>(
      limitKey('wrong-email-day', args.emailKey),
      limitKey('wrong-ip-hour', addressId(args.ip)),
    );
    if (Number(forEmail ?? 0) >= LIMIT.wrongCodesPerEmailDay) {
      console.info('[signin-limits] code check refused: wrong-email-day');
      return true;
    }
    if (Number(fromAddress ?? 0) >= LIMIT.wrongCodesPerAddressHour) {
      console.info('[signin-limits] code check refused: wrong-ip-hour');
      return true;
    }
    return false;
  } catch (error) {
    captureError(error, 'signin-limits', { step: 'code check' });
    return true;
  }
}

/** Counts a wrong (or expired) code for this email (a day, restarted at the 10th) and from this address (an hour). */
export async function recordWrongCode(args: { emailKey: string; ip: string | null }): Promise<void> {
  try {
    await count(limitKey('wrong-email-day', args.emailKey), DAY_SEC, LIMIT.wrongCodesPerEmailDay);
    await count(limitKey('wrong-ip-hour', addressId(args.ip)), HOUR_SEC);
  } catch (error) {
    captureError(error, 'signin-limits', { step: 'wrong code' });
  }
}

/** The one admin message when the day's budget is spent. */
async function tellAdminBudgetSpent(): Promise<void> {
  try {
    const { notifyAdminWarning } = await import('../../utils/error-notifier');
    await notifyAdminWarning(
      'signin-email-budget',
      `Email sign-in sent its ${LIMIT.codesSentPerDay} codes for today (UTC), and pauses until 00:00 UTC. Resend's free plan allows 100 a day.`,
    );
  } catch (error) {
    captureError(error, 'signin-email-budget-alert', {}, 'warning');
  }
}

/**
 * Takes one send from the UTC day's 90. true: send. false: the day's codes are spent (or Redis failed), so no mail.
 * The send that spends the 90th tells the admin, once a day.
 */
export async function takeDailySend(): Promise<boolean> {
  const { key, ttlSec } = budget(Date.now());
  try {
    const sent = await count(key, ttlSec);
    if (sent === LIMIT.codesSentPerDay) await tellAdminBudgetSpent();
    if (sent > LIMIT.codesSentPerDay) {
      console.warn(`[signin-limits] the day's ${LIMIT.codesSentPerDay} sign-in emails are sent: no more until 00:00 UTC`);
      return false;
    }
    return true;
  } catch (error) {
    captureError(error, 'signin-limits', { step: 'daily send' });
    return false;
  }
}

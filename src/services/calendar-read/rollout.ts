/**
 * The calendar home's rollout switch (docs/superpowers/specs/2026-10-16-calendar-home-design.md §1).
 *
 * AdminSettings.calendarHomeRollout is OFF, ADMINS or ALL. It covers the new home and the
 * summaries' move onto the shared reader, so every call site asks
 * `await isCalendarHomeOn(user)` with a fresh DB user row.
 *
 * A read goes through a 30 s memo, then Redis (chome:rollout), then the DB. The memo lives
 * on globalThis: in Next 16 the scheduler and the routes get separate copies of this
 * module, and a set in one must clear the memo the other reads. Every Redis write expires
 * in 60 s and a failed one deletes the key, so the DB value always wins within about a
 * minute. Anything that is not one of the three values, both stores failing, or no row
 * reads as OFF: the old home and today's summary path.
 *
 * When neither store answers, that OFF is kept for 5 s, with one warning. The summaries
 * ask the switch once or twice per user, so during a Redis and DB outage a batch would
 * otherwise retry both stores, and warn twice, for every user it reaches.
 */

import { redis } from '../../utils/redis';
import { prisma } from '../../utils/prisma';
import { REDIS_KEYS } from '../../config/redis-keys';
import { captureError } from '../../lib/error-capture';

export type CalendarHomeRolloutValue = 'OFF' | 'ADMINS' | 'ALL';

const VALUES: readonly CalendarHomeRolloutValue[] = ['OFF', 'ADMINS', 'ALL'];
const KEY = REDIS_KEYS.CALENDAR_HOME_ROLLOUT;
const MEMO_MS = 30_000;
/** How long the OFF of a read that neither store answered is kept. */
const FALLBACK_MEMO_MS = 5_000;
const REDIS_TTL_S = 60;
const CONTEXT = 'calendar-home-rollout';

type Memo = { value: CalendarHomeRolloutValue; at: number; fallback?: true };
const shared = globalThis as typeof globalThis & { __calendarHomeRolloutMemo?: Memo | null };

export function isCalendarHomeRolloutValue(value: unknown): value is CalendarHomeRolloutValue {
  return typeof value === 'string' && (VALUES as readonly string[]).includes(value);
}

function remember(value: CalendarHomeRolloutValue): CalendarHomeRolloutValue {
  shared.__calendarHomeRolloutMemo = { value, at: Date.now() };
  return value;
}

function warn(error: unknown, extra: Record<string, unknown> = {}): void {
  captureError(error, CONTEXT, extra, 'warning');
}

/** The switch as this process sees it: the memo, then Redis, then the DB; OFF when nothing answers. */
export async function getCalendarHomeRollout(): Promise<CalendarHomeRolloutValue> {
  const memo = shared.__calendarHomeRolloutMemo;
  if (memo) {
    const age = Date.now() - memo.at;
    if (age >= 0 && age < (memo.fallback ? FALLBACK_MEMO_MS : MEMO_MS)) return memo.value;
  }

  let redisUp = true;
  let redisError: unknown;
  let cached: unknown = null;
  try {
    cached = await redis.get<string>(KEY);
    if (isCalendarHomeRolloutValue(cached)) return remember(cached);
  } catch (error) {
    redisUp = false;
    redisError = error;
  }

  try {
    const settings = await prisma.adminSettings.findUnique({
      where: { id: 'global' },
      select: { calendarHomeRollout: true },
    });
    // Redis failed but the DB answered: one warning, and the value is kept 30 s.
    if (!redisUp) warn(redisError);
    const stored: unknown = settings?.calendarHomeRollout;
    const value = isCalendarHomeRolloutValue(stored) ? stored : 'OFF';
    if (redisUp) {
      try {
        // On a miss, only fill the key if a set hasn't written it meanwhile; a value that
        // is none of the three is overwritten.
        if (cached === null) await redis.set(KEY, value, { ex: REDIS_TTL_S, nx: true });
        else await redis.set(KEY, value, { ex: REDIS_TTL_S });
      } catch (error) {
        warn(error);
      }
    }
    return remember(value);
  } catch (error) {
    // Neither store answered: OFF for the next 5 s, with this one warning for both.
    warn(error, { stage: redisUp ? 'db' : 'redis and db' });
    shared.__calendarHomeRolloutMemo = { value: 'OFF', at: Date.now(), fallback: true };
    return 'OFF';
  }
}

/** Whether this user gets the calendar home and the summary reader. Always awaited. */
export async function isCalendarHomeOn(user: { isAdmin?: boolean | null }): Promise<boolean> {
  const rollout = await getCalendarHomeRollout();
  return rollout === 'ALL' || (rollout === 'ADMINS' && user.isAdmin === true);
}

/**
 * Saves the switch: the DB (a failure there rejects, and nothing is saved), then Redis
 * with EX 60, deleting the key if that write fails, then clears the memo. Answers whether
 * Redis took the value; false means other processes see it within about a minute.
 */
export async function setCalendarHomeRollout(value: CalendarHomeRolloutValue): Promise<boolean> {
  if (!isCalendarHomeRolloutValue(value)) {
    throw new TypeError(`Not a calendar home rollout value: ${String(value)}`);
  }
  await prisma.adminSettings.upsert({
    where: { id: 'global' },
    update: { calendarHomeRollout: value },
    create: { id: 'global', calendarHomeRollout: value },
  });

  let propagated = true;
  try {
    await redis.set(KEY, value, { ex: REDIS_TTL_S });
    console.log(`[CalendarHome] Set the rollout to ${value}`);
  } catch (error) {
    propagated = false;
    warn(error);
    try {
      await redis.del(KEY);
    } catch (delError) {
      warn(delError);
    }
  }
  shared.__calendarHomeRolloutMemo = null;
  return propagated;
}

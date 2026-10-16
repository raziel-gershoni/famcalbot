// The recurrence rules of series masters, kept so a series costs one lookup (spec §8.3).
// src/services/week-lookahead.ts reads and fills it to tell daily series from weekly and
// monthly ones; a write to a user's calendar clears that user's entries.
//
// A leaf: it imports nothing, so the calendar write paths can clear a user's entries
// without importing week-lookahead, which imports the calendar providers (that import
// would close a cycle through the Google provider).
//
// Keyed `${userId}:${calendarId}:${recurringEventId}`: two users can share a calendar and
// its series ids, and one user's failure must not become the other's answer. It lives on
// globalThis: Next 16 compiles the scheduler (instrumentation.ts, the tomorrow summary's
// lookahead) and the route handlers (/week, /nextweek) into separate module instances,
// and clearing a user's entries must reach both. Railway runs one instance; a second
// replica would keep its own.
//
// An answer is kept 6 hours. A failed lookup is kept 10 minutes: kept for good, one
// Google hiccup hid a monthly series from /week until the next deploy. A series that is
// gone (404, 410) is an answer.

/** How long an answer is kept: the master's rules, or none. */
export const RECURRENCE_ANSWER_TTL_MS = 6 * 60 * 60 * 1000;
/** How long a series that is gone (a Google 404 or 410) is kept: it is an answer too. */
export const RECURRENCE_GONE_TTL_MS = RECURRENCE_ANSWER_TTL_MS;
/** How long a failed lookup is kept, so a hiccup is asked about again soon. */
export const RECURRENCE_FAILURE_TTL_MS = 10 * 60 * 1000;

/**
 * A kept lookup: the rules (null for none, or none known), when it was asked (epoch ms)
 * and how long it holds. A failure and a gone series both keep null, so the entry carries
 * its own lifetime.
 */
export type RecurrenceEntry = { value: string[] | null; at: number; ttlMs: number };

const g = globalThis as { __recurrenceCache?: Map<string, RecurrenceEntry> };
const cache = (g.__recurrenceCache ??= new Map<string, RecurrenceEntry>());

/** The cache key of one user's series. */
export function recurrenceCacheKey(userId: number, calendarId: string, recurringEventId: string): string {
  return `${userId}:${calendarId}:${recurringEventId}`;
}

/** The entry under `key` while it holds at `now` (epoch ms); undefined if none, or it ran out. */
export function readRecurrenceCache(key: string, now: number): RecurrenceEntry | undefined {
  const entry = cache.get(key);
  return entry && now - entry.at < entry.ttlMs ? entry : undefined;
}

/** Keeps `entry` under `key`, replacing what was there. */
export function writeRecurrenceCache(key: string, entry: RecurrenceEntry): void {
  cache.set(key, entry);
}

/**
 * Forget one user's kept recurrence rules, for after a write to their calendar: their
 * next lookahead asks again. A run already under way keeps the answers it has.
 */
export function clearRecurrenceCacheForUser(userId: number): void {
  const prefix = `${userId}:`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

/**
 * Clear recurrence cache, every user's (useful for testing or memory management)
 */
export function clearRecurrenceCache(): void {
  cache.clear();
}

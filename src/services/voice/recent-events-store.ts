// Recent-events sliding window — Tier A follow-up context.
//
// Each successful CRUD pushes the event onto a per-user Redis list (LPUSH),
// trims to the last 5 (LTRIM), and refreshes a 10-min EXPIRE. The Gemini
// prompt builder reads this list and injects "recently touched events" so
// natural references like "the lunch", "that meeting", "it" resolve via the
// existing by_description matcher rather than only via the single
// last_created reference.

import { redis } from '../../utils/redis';
import { REDIS_KEYS } from '../../config/redis-keys';

const MAX_RECENT = 5;
const TTL_SECONDS = 600; // 10 minutes

export interface RecentEvent {
  provider: 'google' | 'native';
  calendarId: string;
  calendarName?: string;
  eventId: string;
  recurringEventId?: string;
  instanceStartsAt?: string; // ISO; only for recurring instances
  title: string;
  startsAt: string; // ISO
  endsAt: string;   // ISO
  action: 'create' | 'edit' | 'delete';
  ts: number;       // Date.now() at push
}

/**
 * Push a recent event onto the per-user list. Trims to 5, refreshes TTL.
 * Best-effort: if Redis fails, the call is silently dropped — recent-events
 * are an optimization, not a correctness requirement.
 */
export async function pushRecentEvent(userId: number, entry: Omit<RecentEvent, 'ts'>): Promise<void> {
  try {
    const key = REDIS_KEYS.recentEvents(userId);
    const payload: RecentEvent = { ...entry, ts: Date.now() };
    // Upstash Redis JS client: lpush + ltrim + expire are separate calls.
    await redis.lpush(key, JSON.stringify(payload));
    await redis.ltrim(key, 0, MAX_RECENT - 1);
    await redis.expire(key, TTL_SECONDS);
  } catch (err) {
    console.warn('[RecentEvents] push failed (non-fatal):', err);
  }
}

/**
 * Read the recent-events list for a user. Returns oldest-first for prompt
 * readability ("a few minutes ago you ... then ... most recent ..."). Returns
 * empty array on Redis errors or missing key.
 */
export async function getRecentEvents(userId: number): Promise<RecentEvent[]> {
  try {
    const key = REDIS_KEYS.recentEvents(userId);
    // Upstash returns the values as already-parsed when stored as strings; we
    // wrap in JSON.stringify on push so we always parse here.
    const raw = await redis.lrange<string>(key, 0, MAX_RECENT - 1);
    if (!raw || raw.length === 0) return [];
    const parsed: RecentEvent[] = [];
    for (const item of raw) {
      try {
        // Upstash sometimes returns already-parsed objects; handle both.
        const obj = typeof item === 'string' ? JSON.parse(item) : (item as RecentEvent);
        parsed.push(obj);
      } catch {
        // skip malformed entry
      }
    }
    // LRANGE returns newest-first (we LPUSH); reverse for oldest-first.
    return parsed.reverse();
  } catch (err) {
    console.warn('[RecentEvents] get failed (non-fatal):', err);
    return [];
  }
}

/**
 * Render the recent-events list as a short prompt block. Skipped (empty
 * string) if no events to show. Caller embeds this near the calendar list.
 */
export function formatRecentEventsBlock(recent: RecentEvent[], userTimezone: string): string {
  if (recent.length === 0) return '';
  const lines = recent.map((e, i) => {
    const start = new Date(e.startsAt);
    const dateStr = start.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: userTimezone });
    const timeStr = start.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: userTimezone });
    return `${i + 1}. "${e.title}" on ${dateStr} at ${timeStr} (calendar: ${e.calendarId}, action: ${e.action})`;
  });
  return [
    'RECENTLY TOUCHED EVENTS (most recent last) — the user may refer to these via "the lunch", "that meeting", "it", "yesterday\'s appointment", etc.:',
    ...lines,
  ].join('\n');
}

/**
 * Forget a specific event from the recent list — used when an Undo is
 * triggered and we want the just-deleted event to disappear from context.
 */
export async function removeRecentEvent(userId: number, eventId: string): Promise<void> {
  try {
    const key = REDIS_KEYS.recentEvents(userId);
    const items = await redis.lrange<string>(key, 0, MAX_RECENT - 1);
    if (!items || items.length === 0) return;
    // Re-write the list without the matching entry. Cheap because list ≤ 5.
    const kept: string[] = [];
    for (const item of items) {
      try {
        const obj = typeof item === 'string' ? JSON.parse(item) : (item as RecentEvent);
        if (obj.eventId !== eventId) kept.push(JSON.stringify(obj));
      } catch {
        // skip malformed
      }
    }
    await redis.del(key);
    if (kept.length > 0) {
      await redis.lpush(key, ...kept);
      await redis.expire(key, TTL_SECONDS);
    }
  } catch (err) {
    console.warn('[RecentEvents] remove failed (non-fatal):', err);
  }
}

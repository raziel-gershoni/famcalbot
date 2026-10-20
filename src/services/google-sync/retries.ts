// A copy's own failing step, backed off (google-sync spec §4 Failures): the calls a link makes
// outside its items (the account check, creating or renaming its Google calendar, a queued
// Remove or Keep). An item's retries live on its row (attempts, nextAttemptAt); a link's live
// in Redis, one key per link, as "<attempts>:<next attempt, epoch ms>" with a 2-day TTL (the
// backoff caps at 6 h, so a failing link's key never lapses between attempts). A success, a
// commit, a re-enable or a recreate clears it.
//
// Redis failing never blocks a copy: a read that fails is logged and the links run as if
// none were backed off (the user lock, taken next, is the fail-closed part); a write that
// fails is logged, and the link is tried again at the next tick.

import { REDIS_KEYS } from '../../config/redis-keys';
import { captureError } from '../../lib/error-capture';
import { redis } from '../../utils/redis';

/** A link's failing step: how many times in a row, and when it may run again. */
export interface LinkRetry {
  attempts: number;
  at: number;
}

const RETRY_TTL_S = 2 * 86_400;

/** "<attempts>:<at>" (never valid JSON, so the Redis client hands it back as the string it stored). */
function parse(raw: unknown): LinkRetry | null {
  if (typeof raw !== 'string') return null;
  const m = /^(\d+):(\d+)$/.exec(raw);
  return m ? { attempts: Number(m[1]), at: Number(m[2]) } : null;
}

/** The backed-off links among these, by id. */
export async function readLinkRetries(linkIds: readonly string[]): Promise<Map<string, LinkRetry>> {
  const out = new Map<string, LinkRetry>();
  if (linkIds.length === 0) return out;
  try {
    const raw = await redis.mget<unknown[]>(...linkIds.map((id) => REDIS_KEYS.googleSyncLinkRetry(id)));
    linkIds.forEach((id, i) => {
      const r = parse(raw[i]);
      if (r) out.set(id, r);
    });
  } catch (error) {
    console.error('[google-sync] reading the copies\' retries failed; none treated as backed off', error);
    captureError(error, 'google-sync-link-retry', { step: 'read', links: linkIds.length }, 'warning');
  }
  return out;
}

/** Store a link's next attempt. */
export async function writeLinkRetry(linkId: string, retry: LinkRetry): Promise<void> {
  try {
    await redis.set(REDIS_KEYS.googleSyncLinkRetry(linkId), `${retry.attempts}:${retry.at}`, { ex: RETRY_TTL_S });
  } catch (error) {
    console.error(`[google-sync] link ${linkId}: storing its retry failed; it runs again at the next tick`, error);
    captureError(error, 'google-sync-link-retry', { step: 'write', link_id: linkId }, 'warning');
  }
}

/** Forget these links' retries, so they run at the next tick. */
export async function clearLinkRetries(linkIds: readonly string[]): Promise<void> {
  if (linkIds.length === 0) return;
  try {
    await redis.del(...linkIds.map((id) => REDIS_KEYS.googleSyncLinkRetry(id)));
  } catch (error) {
    console.error(`[google-sync] clearing the retries of links [${linkIds.join(',')}] failed; they wait out their backoff`, error);
    captureError(error, 'google-sync-link-retry', { step: 'clear', links: linkIds.length }, 'warning');
  }
}

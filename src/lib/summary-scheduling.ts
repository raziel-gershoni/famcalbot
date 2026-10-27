/**
 * Per-user summary scheduling utilities
 * Filters users by preferred delivery hour and handles dedup via Redis
 */

import { redis } from '@/src/utils/redis';
import { UserConfig } from '../types';
import { resolveUserTimezone } from './timezone';
import { REDIS_KEYS } from '../config/redis-keys';
import { instantToWallTime, wallTimeToInstant } from '../utils/wall-time';

type SummaryType = 'daily' | 'tomorrow';

interface FilterResult {
  eligible: UserConfig[];
  skippedHour: number;
  skippedDay: number;
  skippedDedup: number;
}

/**
 * The local hour a summary preferred at `hour` goes out on `day` (yyyy-MM-dd) in `timezone`: that
 * hour, or, when the clocks skip it that day (02:00 on the day Israel springs forward), the first
 * hour after the jump, which is where the resolver puts a skipped wall time (src/utils/wall-time.ts).
 */
export function summaryHourOn(day: string, hour: number, timezone: string): number {
  const at = wallTimeToInstant(`${day}T${String(hour).padStart(2, '0')}:00`, timezone);
  return Number.isNaN(at.getTime()) ? hour : Number(instantToWallTime(at, timezone).slice(11, 13));
}

/**
 * Filter users whose preferred summary hour matches their current local hour. An hour the clocks
 * skip today goes out at the first hour after the jump (summaryHourOn); the dedup below, keyed by
 * the local date, keeps that to one send, and keeps a repeated hour to one send as well.
 * Also checks Redis dedup to avoid re-sending if already sent today.
 */
export async function filterUsersForSummary(
  users: UserConfig[],
  summaryType: SummaryType
): Promise<FilterResult> {
  const eligible: UserConfig[] = [];
  let skippedHour = 0;
  let skippedDay = 0;
  let skippedDedup = 0;

  for (const user of users) {
    try {
      const timezone = await resolveUserTimezone(user);
      const now = new Date();
      // The zone's clock by instant (instantToWallTime), not formatInTimeZone, which reads an hour late in the server's own skipped hour
      const wall = instantToWallTime(now, timezone);
      const localHour = Number(wall.slice(11, 13));
      const localDate = wall.slice(0, 10);
      const preferredHour = summaryType === 'daily'
        ? (user.preferredMorningHour ?? 7)
        : (user.preferredEveningHour ?? 19);
      const sendHour = summaryHourOn(localDate, preferredHour, timezone);

      if (localHour !== sendHour) {
        skippedHour++;
        continue;
      }
      if (sendHour !== preferredHour) {
        console.log(`[SummaryScheduling] user ${user.telegramId}: ${preferredHour}:00 does not exist on ${localDate} in ${timezone}, sending the ${summaryType} summary at ${sendHour}:00`);
      }

      // Check day-of-week preference
      const localDay = new Date(`${localDate}T00:00:00Z`).getUTCDay(); // 0=Sun
      const summaryDays = summaryType === 'daily'
        ? (user.dailySummaryDays ?? [0, 1, 2, 3, 4, 5, 6])
        : (user.tomorrowSummaryDays ?? [0, 1, 2, 3, 4, 5, 6]);

      if (!summaryDays.includes(localDay)) {
        skippedDay++;
        continue;
      }

      // Check dedup — use the local date as the key
      const dedupKey = REDIS_KEYS.summaryDedup(user.id, summaryType, localDate);
      const alreadySent = await redis.get(dedupKey);

      if (alreadySent) {
        skippedDedup++;
        continue;
      }

      eligible.push(user);
    } catch (error) {
      // If timezone resolution fails, skip this user for this run
      console.error(`[SummaryScheduling] Failed to resolve timezone for user ${user.telegramId}:`, error);
      skippedHour++;
    }
  }

  return { eligible, skippedHour, skippedDay, skippedDedup };
}

/**
 * Mark a summary as sent for a user (sets Redis dedup key with 23h TTL).
 * 23h TTL ensures key expires before the next day's scheduled run.
 * @param sentFor - The moment whose local date the mark is for; defaults to now. The
 *   scheduled retry passes its batch's start, so a summary that goes out past midnight
 *   is still marked for the day the batch chose it, and the next day's run isn't skipped.
 */
export async function markSummarySent(
  userId: number,
  summaryType: SummaryType,
  timezone: string,
  sentFor: Date = new Date()
): Promise<void> {
  const localDate = instantToWallTime(sentFor, timezone).slice(0, 10);
  const dedupKey = REDIS_KEYS.summaryDedup(userId, summaryType, localDate);
  await redis.set(dedupKey, '1', { ex: 23 * 60 * 60 }); // 23h TTL
}

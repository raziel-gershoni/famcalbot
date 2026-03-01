/**
 * Per-user summary scheduling utilities
 * Filters users by preferred delivery hour and handles dedup via Redis
 */

import { formatInTimeZone } from 'date-fns-tz';
import { Redis } from '@upstash/redis';
import { UserConfig } from '../types';
import { resolveUserTimezone } from './timezone';
import { REDIS_KEYS } from '../config/redis-keys';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

type SummaryType = 'daily' | 'tomorrow';

interface FilterResult {
  eligible: UserConfig[];
  skippedHour: number;
  skippedDedup: number;
}

/**
 * Filter users whose preferred summary hour matches their current local hour.
 * Also checks Redis dedup to avoid re-sending if already sent today.
 */
export async function filterUsersForSummary(
  users: UserConfig[],
  summaryType: SummaryType
): Promise<FilterResult> {
  const eligible: UserConfig[] = [];
  let skippedHour = 0;
  let skippedDedup = 0;

  for (const user of users) {
    try {
      const timezone = await resolveUserTimezone(user);
      const localHour = parseInt(formatInTimeZone(new Date(), timezone, 'H'), 10);
      const preferredHour = summaryType === 'daily'
        ? (user.preferredMorningHour ?? 7)
        : (user.preferredEveningHour ?? 19);

      if (localHour !== preferredHour) {
        skippedHour++;
        continue;
      }

      // Check dedup — use the local date as the key
      const localDate = formatInTimeZone(new Date(), timezone, 'yyyy-MM-dd');
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

  return { eligible, skippedHour, skippedDedup };
}

/**
 * Mark a summary as sent for a user (sets Redis dedup key with 23h TTL).
 * 23h TTL ensures key expires before the next day's scheduled run.
 */
export async function markSummarySent(
  userId: number,
  summaryType: SummaryType,
  timezone: string
): Promise<void> {
  const localDate = formatInTimeZone(new Date(), timezone, 'yyyy-MM-dd');
  const dedupKey = REDIS_KEYS.summaryDedup(userId, summaryType, localDate);
  await redis.set(dedupKey, '1', { ex: 23 * 60 * 60 }); // 23h TTL
}

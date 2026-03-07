/**
 * Progress Cleanup (Dead-Man's Switch)
 * Schedules a delayed QStash message to clean up stuck progress messages
 * if Vercel kills the function before voice generation completes.
 */

import { Redis } from '@upstash/redis';
import { getQStashClient } from '../../lib/qstash-client';
import { buildUrl } from '../../config/urls';
import { REDIS_KEYS } from '../../config/redis-keys';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

/**
 * Schedule a delayed QStash message to clean up a stuck progress message.
 * Fires after maxDuration (65s default = 60s maxDuration + 5s buffer).
 * Non-blocking — catches all errors so voice pipeline is not interrupted.
 */
export async function scheduleProgressCleanup(
  chatId: number | string,
  messageId: number | string,
  language: string,
  delaySec: number = 65
): Promise<void> {
  try {
    const client = getQStashClient();
    if (!client) {
      console.warn('[ProgressCleanup] QStash client not configured, skipping cleanup schedule');
      return;
    }

    const url = buildUrl('/api/progress-cleanup');

    await client.publishJSON({
      url,
      body: { chatId, messageId, language },
      delay: delaySec,
    });

    console.log(`[ProgressCleanup] Scheduled cleanup for chat=${chatId} msg=${messageId} in ${delaySec}s`);
  } catch (error) {
    console.error('[ProgressCleanup] Failed to schedule cleanup:', error);
  }
}

/**
 * Mark a progress message as completed (success or handled error).
 * The cleanup endpoint checks this flag before replacing the message.
 * TTL = 120s (enough for the delayed QStash message to fire and check).
 */
export async function markProgressCompleted(
  chatId: number | string,
  messageId: number | string
): Promise<void> {
  try {
    const key = REDIS_KEYS.progressDone(chatId, messageId);
    await redis.set(key, '1', { ex: 120 });
  } catch (error) {
    console.error('[ProgressCleanup] Failed to mark progress completed:', error);
  }
}

/**
 * Redis-based distributed lock for preventing duplicate executions
 * Uses Upstash Redis for serverless-friendly persistent state
 */

import { redis } from './redis';
import { captureError } from '../lib/error-capture';

const VOICE_LOCK_KEY_PREFIX = 'voice:lock:';
const VOICE_LOCK_TTL_SECONDS = 60; // Voice processing is fast (5-15s), with safety margin

/**
 * Try to acquire a lock for media message processing (voice, photo, …)
 * @param fileUniqueId - Unique file ID from Telegram (consistent across retries)
 * @param ttlSeconds - Lock lifetime; default suits fast voice jobs. Slower jobs
 *   (e.g. image OCR + retry) should pass a longer TTL so the lock doesn't expire
 *   mid-processing and let a webhook retry double-process.
 * @returns true if lock acquired, false if already locked (duplicate)
 */
export async function acquireVoiceLock(
  fileUniqueId: string,
  ttlSeconds: number = VOICE_LOCK_TTL_SECONDS
): Promise<boolean> {
  const lockKey = `${VOICE_LOCK_KEY_PREFIX}${fileUniqueId}`;

  try {
    const result = await redis.set(lockKey, Date.now(), { nx: true, ex: ttlSeconds });

    if (result === 'OK') {
      console.log(`[Voice Lock] Acquired for file ${fileUniqueId}`);
      return true;
    }

    console.log(`[Voice Lock] Already processing file ${fileUniqueId} - duplicate detected`);
    return false;
  } catch (error) {
    console.error('[Voice Lock] Error acquiring lock:', error);
    captureError(error, 'redis-lock', {}, 'warning');
    // On error, allow execution (better to have duplicates than no execution)
    return true;
  }
}

/**
 * Release the lock after voice message processing completes
 * @param fileUniqueId - Unique file ID from Telegram
 */
export async function releaseVoiceLock(fileUniqueId: string): Promise<void> {
  const lockKey = `${VOICE_LOCK_KEY_PREFIX}${fileUniqueId}`;

  try {
    await redis.del(lockKey);
    console.log(`[Voice Lock] Released for file ${fileUniqueId}`);
  } catch (error) {
    console.error('[Voice Lock] Error releasing lock:', error);
    captureError(error, 'redis-lock', {}, 'warning');
    // Non-fatal - lock will auto-expire via TTL
  }
}

/**
 * Redis-based distributed lock for preventing duplicate testmodels executions
 * Uses Upstash Redis for serverless-friendly persistent state
 */

import { Redis } from '@upstash/redis';

// Initialize Redis client
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const LOCK_KEY_PREFIX = 'testmodels:lock:';
const LOCK_TTL_SECONDS = 180; // 3 minutes - auto-expire if function crashes

/**
 * Try to acquire a lock for testmodels execution
 * @param userId - User ID to create user-specific lock
 * @param updateId - Unique update ID from Telegram
 * @returns true if lock acquired, false if already locked
 */
export async function acquireTestModelsLock(userId: number, updateId: number): Promise<boolean> {
  const lockKey = `${LOCK_KEY_PREFIX}${userId}`;

  try {
    // SET NX EX - Set if Not eXists with EXpiry
    // Returns "OK" if set, null if already exists
    const result = await redis.set(lockKey, updateId, { nx: true, ex: LOCK_TTL_SECONDS });

    if (result === 'OK') {
      console.log(`Lock acquired for user ${userId}, updateId ${updateId}`);
      return true;
    }

    // Lock already exists - check if it's the same updateId (duplicate retry)
    const existingUpdateId = await redis.get(lockKey);
    if (existingUpdateId === updateId) {
      console.log(`Duplicate retry detected for updateId ${updateId}`);
      return false;
    }

    console.log(`Lock already held by another execution for user ${userId}`);
    return false;
  } catch (error) {
    console.error('Error acquiring lock:', error);
    // On error, allow execution (better to have duplicates than no execution)
    return true;
  }
}

/**
 * Release the lock after testmodels execution completes
 * @param userId - User ID
 */
export async function releaseTestModelsLock(userId: number): Promise<void> {
  const lockKey = `${LOCK_KEY_PREFIX}${userId}`;

  try {
    await redis.del(lockKey);
    console.log(`Lock released for user ${userId}`);
  } catch (error) {
    console.error('Error releasing lock:', error);
    // Non-fatal - lock will auto-expire via TTL
  }
}

/**
 * Check if testmodels is currently running for a user
 * @param userId - User ID
 * @returns true if locked (test running), false if available
 */
export async function isTestModelsLocked(userId: number): Promise<boolean> {
  const lockKey = `${LOCK_KEY_PREFIX}${userId}`;

  try {
    const exists = await redis.exists(lockKey);
    return exists === 1;
  } catch (error) {
    console.error('Error checking lock:', error);
    return false;
  }
}

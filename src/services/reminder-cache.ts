/**
 * Redis cache for reminder users
 * Eliminates DB queries from 5-minute reminder cron to allow Neon auto-suspend
 */

import { Redis } from '@upstash/redis';

// Initialize Redis client
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const CACHE_KEY = 'reminders:users';
const GLOBAL_KEY = 'reminders:global_enabled';

export interface CachedReminderUser {
  id: number;
  telegramId: string;
  googleRefreshToken: string; // Already decrypted
  calendarAssignments: any;
  defaultReminderMinutes: number | null;
  language: string;
  name: string;
  pickupRemindersEnabled: boolean;
}

/**
 * Read all reminder users from cache
 * Returns null if cache is empty or error occurs
 */
export async function getCachedReminderUsers(): Promise<CachedReminderUser[] | null> {
  try {
    return await redis.get<CachedReminderUser[]>(CACHE_KEY);
  } catch (error) {
    console.error('[Reminder Cache] Redis read error:', error);
    return null;
  }
}

/**
 * Sync full user list to cache (called by daily-summary)
 * No TTL - cache is manually synced twice daily
 */
export async function syncReminderCache(users: CachedReminderUser[]): Promise<void> {
  try {
    await redis.set(CACHE_KEY, users);
    console.log(`[Reminder Cache] Synced ${users.length} users to cache`);
  } catch (error) {
    console.error('[Reminder Cache] Redis write error:', error);
  }
}

/**
 * Update single user in cache (called on settings/oauth changes)
 * Adds user if not in cache, updates if exists
 */
export async function updateUserInCache(user: CachedReminderUser): Promise<void> {
  try {
    const users = await getCachedReminderUsers() ?? [];
    const index = users.findIndex(u => u.id === user.id);
    if (index >= 0) {
      users[index] = user;
    } else {
      users.push(user);
    }
    await redis.set(CACHE_KEY, users);
    console.log(`[Reminder Cache] Updated user ${user.id} in cache`);
  } catch (error) {
    console.error('[Reminder Cache] Redis update error:', error);
  }
}

/**
 * Remove user from cache (if reminders disabled or no token)
 */
export async function removeUserFromCache(userId: number): Promise<void> {
  try {
    const users = await getCachedReminderUsers() ?? [];
    const filtered = users.filter(u => u.id !== userId);
    await redis.set(CACHE_KEY, filtered);
    console.log(`[Reminder Cache] Removed user ${userId} from cache`);
  } catch (error) {
    console.error('[Reminder Cache] Redis remove error:', error);
  }
}

/**
 * Get global reminders enabled toggle from Redis
 */
export async function getGlobalRemindersEnabled(): Promise<boolean> {
  try {
    return await redis.get<boolean>(GLOBAL_KEY) ?? false;
  } catch (error) {
    console.error('[Reminder Cache] Redis read global toggle error:', error);
    return false;
  }
}

/**
 * Set global reminders enabled toggle in Redis
 */
export async function setGlobalRemindersEnabled(enabled: boolean): Promise<void> {
  try {
    await redis.set(GLOBAL_KEY, enabled);
    console.log(`[Reminder Cache] Set global reminders enabled to ${enabled}`);
  } catch (error) {
    console.error('[Reminder Cache] Redis write global toggle error:', error);
  }
}

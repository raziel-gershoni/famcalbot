/**
 * Redis cache for reminder users
 * Eliminates DB queries from 5-minute reminder cron to allow Neon auto-suspend
 */

import { Redis } from '@upstash/redis';
import { REDIS_KEYS } from '../config/redis-keys';

// Initialize Redis client
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const CACHE_KEY = REDIS_KEYS.REMINDER_USERS;
const GLOBAL_KEY = REDIS_KEYS.REMINDERS_GLOBAL_ENABLED;
const EARLY_ADOPTION_KEY = REDIS_KEYS.EARLY_ADOPTION_GLOBAL;

export interface CachedReminderUser {
  id: number;
  telegramId: string;
  googleRefreshToken: string; // Already decrypted
  calendarAssignments: unknown;
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
 * Get global reminders enabled toggle from Redis (read-through cache from DB)
 */
export async function getGlobalRemindersEnabled(): Promise<boolean> {
  try {
    const cached = await redis.get<boolean>(GLOBAL_KEY);
    if (cached !== null) return cached;

    // Redis key not set — read from DB and cache
    const { prisma } = await import('@/src/utils/prisma');
    const settings = await prisma.adminSettings.findUnique({
      where: { id: 'global' },
      select: { remindersEnabled: true },
    });
    const value = settings?.remindersEnabled ?? false;
    await redis.set(GLOBAL_KEY, value);
    return value;
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

/**
 * Get early adoption mode toggle from Redis (read-through cache from DB)
 */
export async function getEarlyAdoptionMode(): Promise<boolean> {
  try {
    const cached = await redis.get<boolean>(EARLY_ADOPTION_KEY);
    if (cached !== null) return cached;

    // Redis key not set — read from DB and cache
    const { prisma } = await import('@/src/utils/prisma');
    const settings = await prisma.adminSettings.findUnique({
      where: { id: 'global' },
      select: { earlyAdoptionMode: true },
    });
    const value = settings?.earlyAdoptionMode ?? false;
    await redis.set(EARLY_ADOPTION_KEY, value);
    return value;
  } catch (error) {
    console.error('[Reminder Cache] Redis read early adoption toggle error:', error);
    return false;
  }
}

/**
 * Set early adoption mode toggle in Redis
 */
export async function setEarlyAdoptionMode(enabled: boolean): Promise<void> {
  try {
    await redis.set(EARLY_ADOPTION_KEY, enabled);
    console.log(`[Reminder Cache] Set early adoption mode to ${enabled}`);
  } catch (error) {
    console.error('[Reminder Cache] Redis write early adoption toggle error:', error);
  }
}

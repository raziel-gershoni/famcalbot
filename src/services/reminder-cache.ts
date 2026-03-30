/**
 * Redis cache for reminder users
 * Eliminates DB queries from 5-minute reminder cron to allow Neon auto-suspend
 */

import { Redis } from '@upstash/redis';
import { REDIS_KEYS } from '../config/redis-keys';
import { captureError } from '../lib/error-capture';

// Initialize Redis client
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const CACHE_KEY = REDIS_KEYS.REMINDER_USERS;
const GLOBAL_KEY = REDIS_KEYS.REMINDERS_GLOBAL_ENABLED;
const EARLY_ADOPTION_KEY = REDIS_KEYS.EARLY_ADOPTION_GLOBAL;
const DEFAULT_AI_MODEL_KEY = REDIS_KEYS.DEFAULT_AI_MODEL;
const GEMINI_THINKING_LEVEL_KEY = REDIS_KEYS.GEMINI_THINKING_LEVEL;

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
    captureError(error, 'reminder-cache', {}, 'warning');
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
    captureError(error, 'reminder-cache', {}, 'warning');
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
    captureError(error, 'reminder-cache', {}, 'warning');
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
    captureError(error, 'reminder-cache', {}, 'warning');
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
    captureError(error, 'reminder-cache', {}, 'warning');
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
    captureError(error, 'reminder-cache', {}, 'warning');
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
    captureError(error, 'reminder-cache', {}, 'warning');
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
    captureError(error, 'reminder-cache', {}, 'warning');
  }
}

/**
 * Get default AI model setting from Redis (read-through cache from DB)
 */
export async function getDefaultAiModelSetting(): Promise<string | null> {
  try {
    const cached = await redis.get<string>(DEFAULT_AI_MODEL_KEY);
    if (cached !== null) return cached;

    // Redis key not set — read from DB and cache
    const { prisma } = await import('@/src/utils/prisma');
    const settings = await prisma.adminSettings.findUnique({
      where: { id: 'global' },
      select: { defaultAiModel: true },
    });
    const value = settings?.defaultAiModel ?? null;
    if (value) {
      await redis.set(DEFAULT_AI_MODEL_KEY, value);
    }
    return value;
  } catch (error) {
    console.error('[Reminder Cache] Redis read default AI model error:', error);
    captureError(error, 'reminder-cache', {}, 'warning');
    return null;
  }
}

/**
 * Set default AI model setting in Redis (null clears the key)
 */
export async function setDefaultAiModelSetting(modelId: string | null): Promise<void> {
  try {
    if (modelId) {
      await redis.set(DEFAULT_AI_MODEL_KEY, modelId);
    } else {
      await redis.del(DEFAULT_AI_MODEL_KEY);
    }
    console.log(`[Reminder Cache] Set default AI model to ${modelId ?? 'env default'}`);
  } catch (error) {
    console.error('[Reminder Cache] Redis write default AI model error:', error);
    captureError(error, 'reminder-cache', {}, 'warning');
  }
}

/**
 * Get Gemini thinking level from Redis (read-through cache from DB)
 */
export async function getGeminiThinkingLevel(): Promise<string | null> {
  try {
    const cached = await redis.get<string>(GEMINI_THINKING_LEVEL_KEY);
    if (cached !== null) return cached;

    const { prisma } = await import('@/src/utils/prisma');
    const settings = await prisma.adminSettings.findUnique({
      where: { id: 'global' },
      select: { geminiThinkingLevel: true },
    });
    const value = settings?.geminiThinkingLevel ?? null;
    if (value) {
      await redis.set(GEMINI_THINKING_LEVEL_KEY, value);
    }
    return value;
  } catch (error) {
    console.error('[Reminder Cache] Redis read Gemini thinking level error:', error);
    captureError(error, 'reminder-cache', {}, 'warning');
    return null;
  }
}

/**
 * Set Gemini thinking level in Redis (null clears the key)
 */
export async function setGeminiThinkingLevel(level: string | null): Promise<void> {
  try {
    if (level) {
      await redis.set(GEMINI_THINKING_LEVEL_KEY, level);
    } else {
      await redis.del(GEMINI_THINKING_LEVEL_KEY);
    }
    console.log(`[Reminder Cache] Set Gemini thinking level to ${level ?? 'default (MEDIUM)'}`);
  } catch (error) {
    console.error('[Reminder Cache] Redis write Gemini thinking level error:', error);
    captureError(error, 'reminder-cache', {}, 'warning');
  }
}

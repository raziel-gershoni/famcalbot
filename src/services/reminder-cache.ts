/**
 * Redis cache for reminder users
 * Eliminates DB queries from 5-minute reminder cron to allow Neon auto-suspend
 *
 * Each Google token is cached sealed (sealSecret: ciphertext), never in plain form, and the
 * reminder run opens it per user (handlers.ts handleReminders). The pre-v2 key held the
 * tokens decrypted; it is only ever deleted (purgeLegacyReminderCache).
 */

import { redis } from '../utils/redis';
import { REDIS_KEYS } from '../config/redis-keys';
import { captureError } from '../lib/error-capture';
import { normalizeStored, sealSecret } from '../utils/encryption';

/** The reminder users, each Google token sealed: 'reminders:users:v2'. */
export const REMINDER_CACHE_KEY = REDIS_KEYS.REMINDER_USERS;
/** The pre-v2 key, which held every token in plain form: 'reminders:users'. Only ever deleted. */
export const LEGACY_REMINDER_CACHE_KEY = REDIS_KEYS.REMINDER_USERS_LEGACY;

const CACHE_KEY = REMINDER_CACHE_KEY;
const GLOBAL_KEY = REDIS_KEYS.REMINDERS_GLOBAL_ENABLED;
const EARLY_ADOPTION_KEY = REDIS_KEYS.EARLY_ADOPTION_GLOBAL;
const VOICE_AUTO_CREATE_KEY = REDIS_KEYS.VOICE_AUTO_CREATE_HIGH_CONF;
const VOICE_TTS_OUTCOME_KEY = REDIS_KEYS.VOICE_TTS_OUTCOME;

/**
 * What an entry is built from: the user's fields, with the Google token as the database
 * stores it (ciphertext, legacy plaintext, an empty cipher or '') or already decrypted.
 * toEntry seals it either way.
 */
export type ReminderCacheSource = Omit<CachedReminderUser, 'googleToken'> & { googleRefreshToken: string };

export interface CachedReminderUser {
  id: number;
  telegramId: string;
  // Sealed: ciphertext (under ENCRYPTION_KEY, or under ENCRYPTION_KEY_PREVIOUS until the
  // key sweep converts the row and rebuilds the cache), or '' for no token. The run opens
  // it with openSecret, per user.
  googleToken: string;
  calendarAssignments: unknown;
  defaultReminderMinutes: number | null;
  language: string;
  name: string;
  pickupRemindersEnabled: boolean;
  // calendarSource is legacy: the providers are chosen by calendar id ("Google as a connection");
  // it is read only as liveGoogleChoices' marker for the stored choices of a user with no token.
  // pairingId lets the FamCal half see the partner's shared calendars.
  calendarSource?: string;
  pairingId?: string | null;
  // The reminder run resolves the user's timezone from it, as the summaries do;
  // without it a NATIVE user fell back to Israel, and that fallback was cached for
  // the summaries too. Optional for entries written before it existed.
  location?: string;
}

/**
 * The one builder of a cache entry, for the hourly sync (rebuildReminderCache) and
 * updateUserInCache. The token is sealed: an empty cipher (iv:tag: with no token, from the
 * old select-calendars bug) becomes '', a stored ciphertext is kept as it is, and anything
 * else is encrypted with ENCRYPTION_KEY. It never decrypts, so a row that no key opens is
 * cached as it is and fails only its own user's run.
 */
export function toEntry(user: ReminderCacheSource): CachedReminderUser {
  const { googleRefreshToken, ...fields } = user;
  return { ...fields, googleToken: sealSecret(normalizeStored(googleRefreshToken)) };
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
 * Sync full user list to cache (called by daily-summary, the boot step and the key sweep)
 * No TTL - the cache is rebuilt hourly. Entries come from toEntry.
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
 * Adds user if not in cache, updates if exists. The entry is built by toEntry (token sealed).
 */
export async function updateUserInCache(user: ReminderCacheSource): Promise<void> {
  try {
    const entry = toEntry(user);
    const users = await getCachedReminderUsers() ?? [];
    const index = users.findIndex(u => u.id === entry.id);
    if (index >= 0) {
      users[index] = entry;
    } else {
      users.push(entry);
    }
    await redis.set(CACHE_KEY, users);
    console.log(`[Reminder Cache] Updated user ${entry.id} in cache`);
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
 * Deletes the pre-v2 key, which held every remindable user's Google token in plain form.
 * Called at boot and by the hourly sync. Never throws: a failure is logged and captured,
 * and the next call tries again.
 */
export async function purgeLegacyReminderCache(): Promise<void> {
  try {
    const removed = await redis.del(LEGACY_REMINDER_CACHE_KEY);
    if (removed) console.log('[Reminder Cache] Deleted the legacy plaintext key reminders:users');
  } catch (error) {
    console.error('[Reminder Cache] Failed to delete the legacy key reminders:users:', error);
    captureError(error, 'reminder-cache-purge');
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

// --- Voice frictionlessness toggles (PR 10 / PR 12) ------------------------
//
// Read-through cache from AdminSettings, mirrors the earlyAdoptionMode pattern.
// Defaults are false in both DB and cache so callers degrade safely.

export async function getVoiceAutoCreateHighConf(): Promise<boolean> {
  try {
    const cached = await redis.get<boolean>(VOICE_AUTO_CREATE_KEY);
    if (cached !== null) return cached;
    const { prisma } = await import('@/src/utils/prisma');
    const settings = await prisma.adminSettings.findUnique({
      where: { id: 'global' },
      select: { voiceAutoCreateHighConf: true },
    });
    const value = settings?.voiceAutoCreateHighConf ?? false;
    await redis.set(VOICE_AUTO_CREATE_KEY, value);
    return value;
  } catch (error) {
    console.error('[Reminder Cache] Redis read voiceAutoCreateHighConf error:', error);
    captureError(error, 'reminder-cache', {}, 'warning');
    return false;
  }
}

export async function setVoiceAutoCreateHighConf(enabled: boolean): Promise<void> {
  try {
    await redis.set(VOICE_AUTO_CREATE_KEY, enabled);
    console.log(`[Reminder Cache] Set voiceAutoCreateHighConf to ${enabled}`);
  } catch (error) {
    console.error('[Reminder Cache] Redis write voiceAutoCreateHighConf error:', error);
    captureError(error, 'reminder-cache', {}, 'warning');
  }
}

export async function getVoiceTtsOutcome(): Promise<boolean> {
  try {
    const cached = await redis.get<boolean>(VOICE_TTS_OUTCOME_KEY);
    if (cached !== null) return cached;
    const { prisma } = await import('@/src/utils/prisma');
    const settings = await prisma.adminSettings.findUnique({
      where: { id: 'global' },
      select: { voiceTtsOutcome: true },
    });
    const value = settings?.voiceTtsOutcome ?? false;
    await redis.set(VOICE_TTS_OUTCOME_KEY, value);
    return value;
  } catch (error) {
    console.error('[Reminder Cache] Redis read voiceTtsOutcome error:', error);
    captureError(error, 'reminder-cache', {}, 'warning');
    return false;
  }
}

export async function setVoiceTtsOutcome(enabled: boolean): Promise<void> {
  try {
    await redis.set(VOICE_TTS_OUTCOME_KEY, enabled);
    console.log(`[Reminder Cache] Set voiceTtsOutcome to ${enabled}`);
  } catch (error) {
    console.error('[Reminder Cache] Redis write voiceTtsOutcome error:', error);
    captureError(error, 'reminder-cache', {}, 'warning');
  }
}

/**
 * Redis cache for reminder users
 * The 5-minute event alerts pass takes its users from here, not from the database, so Neon can
 * auto-suspend: with the event alerts gate (src/services/event-alerts-gate.ts) closed, an idle
 * pass makes no database query. A write here that can change a user's FamCal alerts opens the
 * gate: every updateUserInCache, and a sync that adds a user or changes their pairing, default
 * lead or pickup switch.
 *
 * Each Google token is cached sealed (sealSecret: ciphertext), never in plain form, and the
 * reminder run opens it per user (handlers.ts handleReminders). The pre-v2 key held the
 * tokens decrypted; it is only ever deleted (purgeLegacyReminderCache).
 */

import { redis } from '../utils/redis';
import { REDIS_KEYS } from '../config/redis-keys';
import { captureError } from '../lib/error-capture';
import { normalizeStored, sealSecret } from '../utils/encryption';
import type { UserConfig } from '../types';
import { openEventAlertsGate } from './event-alerts-gate';
import { canReachByPush } from './web-push/reach';

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
  // '' for a push entry (pushDevice): an account with no chat, which the run alerts by notification (reminders.ts sendReminder).
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
  // The Shabbat and Yom Tov pause (src/services/zmanim/pause.ts) reads these, so the 5-minute run needs no
  // database read to know whether to send: the switch, the community, and the place the windows are counted at.
  // Optional for entries written before they existed (the hourly sync and the boot step rebuild every entry,
  // and a missing switch reads as off).
  pauseOnShabbat?: boolean;
  zmanimCommunity?: string;
  latitude?: number | null;
  longitude?: number | null;
  elevationM?: number | null;
  // True only for an account with no chat and a device with notifications on (alertChannelOf 'push'): the run sends its
  // alerts as notifications. Never the devices themselves: sendWebPush reads them when an alert is due.
  pushDevice?: boolean;
}

/** The fields alertChannelOf reads: a database row, a UserConfig and the hourly rebuild's select all fit. */
export interface AlertAdmissionUser {
  remindersEnabled?: boolean | null;
  telegramId: bigint | number | string | null | undefined;
  whatsappPhone?: string | null;
  whatsappBsuid?: string | null;
  suspendedAt?: Date | null;
  unreachableSince?: Date | null;
}

/**
 * How the 5-minute alert pass reaches this account, or null when the cache does not hold it: the one admission rule, read
 * by the hourly rebuild (handlers.ts rebuildReminderCache) and every entry sync. Alerts on, not suspended, not unreachable
 * (Telegram refuses that chat every 5 minutes), and a Telegram chat, or no chat at all and a device with notifications on
 * (canReachByPush, web push spec §3.5). A WhatsApp-only account is not held: event alerts go to Telegram only.
 */
export function alertChannelOf(user: AlertAdmissionUser, pushDeviceCount: number): 'telegram' | 'push' | null {
  if (!user.remindersEnabled || user.suspendedAt || user.unreachableSince) return null;
  if (user.telegramId != null) return 'telegram';
  return canReachByPush({ ...user, pushDeviceCount }) ? 'push' : null;
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

/** The fields of an entry that change which FamCal alerts the user gets, or when. */
const alertsOf = (u: CachedReminderUser) => [u.pairingId ?? null, u.defaultReminderMinutes ?? null, u.pickupRemindersEnabled].join('|');

/**
 * Whether a sync from `previous` to `next` can add a FamCal alert: a user who was not cached
 * (a new user, an unsuspended or reachable-again one, alerts turned back on), or whose pairing,
 * default lead or pickup switch changed (a pairing reaches the cache only through the sync).
 * A user who left adds none. With no previous list (missing or unreadable), every user is new.
 */
export function syncAddsAlerts(previous: CachedReminderUser[] | null, next: CachedReminderUser[]): boolean {
  const before = new Map((previous ?? []).map(u => [u.id, alertsOf(u)]));
  return next.some(u => before.get(u.id) !== alertsOf(u));
}

/**
 * Sync full user list to cache (called by daily-summary, the boot step and the key sweep)
 * No TTL - the cache is rebuilt hourly. Entries come from toEntry. Opens the event alerts gate
 * after the write when the new list can add an alert (syncAddsAlerts), so the hourly sync
 * forces no extra FamCal read when nothing changed.
 */
export async function syncReminderCache(users: CachedReminderUser[]): Promise<void> {
  const previous = await getCachedReminderUsers();
  try {
    await redis.set(CACHE_KEY, users);
    console.log(`[Reminder Cache] Synced ${users.length} users to cache`);
  } catch (error) {
    console.error('[Reminder Cache] Redis write error:', error);
    captureError(error, 'reminder-cache', {}, 'warning');
  }
  if (syncAddsAlerts(previous, users)) openEventAlertsGate();
}

/**
 * Update single user in cache (called on settings/oauth changes)
 * Adds user if not in cache, updates if exists. The entry is built by toEntry (token sealed).
 * Then opens the event alerts gate: a settings save (the default lead, the pickup switch, alerts
 * on), a Google connect, the calendar choices or a merge can each add an alert.
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
  } finally {
    // Also when the write failed: the row behind it may have changed, and a read costs one pass.
    openEventAlertsGate();
  }
}

/**
 * Put a user's entry in line with their row, by the hourly sync's rule (alertChannelOf): everyone who gets reminders is
 * in the cache, with or without a Google token (everyone has FamCal); a user with reminders off, no way to be reached (no
 * Telegram chat, and no device with notifications on for an account with no chat), suspended or unreachable is not
 * (Telegram refuses an unreachable chat every 5 minutes, and a save must not put them back). `user` is the row as
 * convertPrismaUserToConfig returns it (the token already decrypted). The devices are counted here (one query) only for
 * an account the cache would hold by notification once it has one, never for a chat account; a failed count leaves the
 * entry as it was, for the hourly rebuild to put right.
 */
export async function syncReminderCacheEntry(
  user: Pick<UserConfig, 'id' | 'telegramId' | 'whatsappPhone' | 'whatsappBsuid' | 'remindersEnabled' | 'suspendedAt' | 'unreachableSince' | 'googleRefreshToken' | 'calendarAssignments' | 'calendarSource' | 'pairingId' | 'defaultReminderMinutes' | 'language' | 'name' | 'pickupRemindersEnabled' | 'location' | 'pauseOnShabbat' | 'zmanimCommunity' | 'latitude' | 'longitude' | 'elevationM'>,
  /** Values newer than the row in hand: the token just stored (plain), the calendar choices just saved. */
  fresh: { googleRefreshToken?: string; calendarAssignments?: unknown } = {}
): Promise<void> {
  let pushDeviceCount = 0;
  if (alertChannelOf(user, 1) === 'push') {
    try {
      // devices.ts calls this function after a device change (afterDevicesChanged), hence the late import.
      const { countDevices } = await import('./web-push/devices');
      pushDeviceCount = await countDevices(user.id);
    } catch (error) {
      console.error(`[Reminder Cache] Counting the devices of user ${user.id} failed; the entry is left as it was:`, error);
      captureError(error, 'reminder-cache', { user_id: user.id }, 'warning');
      return;
    }
  }
  const channel = alertChannelOf(user, pushDeviceCount);
  if (!channel) return removeUserFromCache(user.id);
  return updateUserInCache({
    id: user.id,
    telegramId: user.telegramId?.toString() ?? '',
    googleRefreshToken: fresh.googleRefreshToken ?? user.googleRefreshToken,
    calendarAssignments: 'calendarAssignments' in fresh ? fresh.calendarAssignments : user.calendarAssignments,
    calendarSource: user.calendarSource,
    pairingId: user.pairingId,
    defaultReminderMinutes: user.defaultReminderMinutes ?? null,
    language: user.language,
    name: user.name,
    pickupRemindersEnabled: user.pickupRemindersEnabled ?? true,
    location: user.location,
    pauseOnShabbat: user.pauseOnShabbat,
    zmanimCommunity: user.zmanimCommunity,
    latitude: user.latitude,
    longitude: user.longitude,
    elevationM: user.elevationM,
    ...(channel === 'push' ? { pushDevice: true } : {}),
  });
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

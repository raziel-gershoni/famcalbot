/**
 * Native reminders: the admin switch and the one gate for who gets reminders (spec R3).
 *
 * A user gets reminders only on the built-in calendar, when reminders can reach them (on Telegram, where the ping and
 * its buttons live, or, with no chat, by a browser notification on a device: reachableForReminders, 6c-2 spec §3.5),
 * while the admin switch is on, and with access to the
 * 'reminders' feature (Pro, trial, admin override or early adoption). When any of these
 * fails, the extraction prompt has no reminder rules, typed text keeps today's route, and
 * the pass skips that creator's reminders.
 */

import { redis } from '../../utils/redis';
import { prisma } from '../../utils/prisma';
import { REDIS_KEYS } from '../../config/redis-keys';
import { captureError } from '../../lib/error-capture';
import { checkFeatureAccess, peekFeatureAccess } from '../subscription-service';
import { invalidateDueGate } from './due-gate';
import { getActivePartnerSummary } from './ownership';
import { reachableForReminders, type ReachUser } from '../web-push/reach';

const FLAG_KEY = REDIS_KEYS.NATIVE_REMINDERS_ENABLED;

/** no_channel: neither Telegram nor (with no chat) a device with browser notifications on can reach them. */
export type ReminderSupportReason = 'no_channel' | 'disabled' | 'no_access';

export interface ReminderSupport {
  supported: boolean;
  reason?: ReminderSupportReason;
}

/**
 * The admin switch AdminSettings.nativeRemindersEnabled, read through Redis. It defaults
 * to on, as the column does: no settings row reads as on, and so does Redis and the DB
 * both failing. When only Redis fails, the DB value is used.
 */
export async function isNativeRemindersEnabled(): Promise<boolean> {
  let redisUp = true;
  try {
    const cached = await redis.get<boolean>(FLAG_KEY);
    if (typeof cached === 'boolean') return cached;
  } catch (error) {
    redisUp = false;
    console.error('[NativeReminders] Redis read of the admin switch failed:', error);
    captureError(error, 'native-reminders-flag', {}, 'warning');
  }

  try {
    const settings = await prisma.adminSettings.findUnique({
      where: { id: 'global' },
      select: { nativeRemindersEnabled: true },
    });
    const value = settings?.nativeRemindersEnabled ?? true;
    if (redisUp) {
      await redis.set(FLAG_KEY, value).catch(error => captureError(error, 'native-reminders-flag', {}, 'warning'));
    }
    return value;
  } catch (error) {
    console.error('[NativeReminders] DB read of the admin switch failed:', error);
    captureError(error, 'native-reminders-flag', {}, 'warning');
    return true;
  }
}

/**
 * Writes the admin switch to Redis (the admin route has already written the DB) and
 * reopens the due gate, so switching on pings due reminders at the next minute instead
 * of after the gate's hour.
 */
export async function setNativeRemindersEnabled(enabled: boolean): Promise<void> {
  try {
    await redis.set(FLAG_KEY, enabled);
    console.log(`[NativeReminders] Set the admin switch to ${enabled}`);
  } catch (error) {
    console.error('[NativeReminders] Redis write of the admin switch failed:', error);
    captureError(error, 'native-reminders-flag', {}, 'warning');
  }
  invalidateDueGate();
}

/**
 * Whether this user gets reminders and, if not, the first reason why. Reminders live in
 * FamCal, which everyone has ("Google as a connection" spec §4), so a Google user gets
 * them too; the reach and plan gates stay. Reach is reachableForReminders: Telegram, or no chat and a
 * device with browser notifications on (its count comes with the user's read: UserConfig.pushDeviceCount,
 * PartnerSummary.pushDeviceCount). The checks run cheapest first, so a
 * WhatsApp-only user costs no Redis read. checkFeatureAccess
 * caches its answer in Redis for 24h; a caller that needs the answer more than once per
 * message keeps the result. An error in the feature check fails closed: without
 * reminders the user gets today's behaviour.
 */
export async function getReminderSupport(user: { id: number } & ReachUser, options: { quiet?: boolean } = {}): Promise<ReminderSupport> {
  if (!reachableForReminders(user)) return { supported: false, reason: 'no_channel' };
  if (!(await isNativeRemindersEnabled())) return { supported: false, reason: 'disabled' };

  try {
    // quiet: a hint (the home's), not a gate, so a plan without reminders logs nothing
    const access = await (options.quiet ? peekFeatureAccess : checkFeatureAccess)(user.id, 'reminders');
    if (!access.allowed) return { supported: false, reason: 'no_access' };
  } catch (error) {
    console.error(`[NativeReminders] Feature check failed for user ${user.id}:`, error);
    captureError(error, 'native-reminders-support', { user_id: user.id }, 'warning');
    return { supported: false, reason: 'no_access' };
  }
  return { supported: true };
}

/**
 * Whether this user can be pinged by FamCal reminders, so the time those pings ring at
 * (User.reminderTime) means something to them: their own plan allows reminders, or reminders can reach
 * them (reachableForReminders) and their active partner's plan does (the pass pings a partner-owned
 * reminder at the recipient's time, gated on the creator's plan only). The one rule for
 * showing the setting and for accepting it. An error finding the partner fails closed.
 */
export async function canReceiveReminderPings(
  user: { id: number; pairingId?: string | null } & ReachUser,
  options: { quiet?: boolean } = {},
): Promise<boolean> {
  if ((await getReminderSupport(user, options)).supported) return true;
  if (!reachableForReminders(user) || !user.pairingId) return false;
  try {
    const partner = await getActivePartnerSummary(user.id, user.pairingId);
    return !!partner && (await getReminderSupport(partner, options)).supported;
  } catch (error) {
    console.error(`[NativeReminders] Partner lookup for the reminder time failed for user ${user.id}:`, error);
    captureError(error, 'native-reminders-partner-support', { user_id: user.id }, 'warning');
    return false;
  }
}

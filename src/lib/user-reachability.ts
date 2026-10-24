/**
 * Delivery reachability.
 *
 * When Telegram tells us a chat is permanently undeliverable (the user blocked the
 * bot, deactivated, or kicked us), we record it on the user so the scheduled
 * populations can skip them. Before this existed, a blocked user was retried on every
 * run forever - three failed sends each time, and an admin warning on the third.
 *
 * The flag clears itself: their next message reaches the webhook (handleTelegramWebhook or
 * handleWhatsAppWebhook), and the webhook clears it there.
 */

import { prisma } from '../utils/prisma';
import { trackActivityAsync } from '../services/analytics-service';
import { captureError } from './error-capture';
import { describeDeliveryError, isUnreachableError } from './delivery-errors';

/**
 * Record that we can no longer deliver to this user.
 *
 * Idempotent, and deliberately does not refresh the timestamp on repeat calls - the
 * value is meant to answer "since when", so the first observation is the useful one.
 */
export async function markUserUnreachable(userId: number, reason: string): Promise<void> {
  try {
    const result = await prisma.user.updateMany({
      where: { id: userId, unreachableSince: null },
      data: { unreachableSince: new Date() },
    });

    // updateMany reports 0 when the user was already flagged, which is the common case
    // on a second delivery attempt in the same run. Only log the transition.
    if (result.count > 0) {
      console.warn(`[Reachability] User ${userId} is unreachable: ${reason}`);
      trackActivityAsync(userId, 'user_unreachable', { reason });
    }
  } catch (error) {
    // Never let bookkeeping break a delivery path.
    captureError(error, 'reachability-mark', { user_id: userId }, 'warning');
  }
}

/**
 * After a WhatsApp send failed: flag the user when Meta says they can never receive (see
 * delivery-errors). The flag is for the whole user, so it is set only when WhatsApp is their
 * only channel; someone who also has Telegram still gets their Telegram messages.
 * Returns true when the user was flagged.
 */
export async function markUnreachableAfterWhatsAppFailure(
  user: { id: number; telegramId: number | null },
  error: unknown
): Promise<boolean> {
  if (!isUnreachableError(error)) return false;
  const reason = `WhatsApp: ${describeDeliveryError(error)}`;
  if (user.telegramId !== null) {
    console.warn(`[Reachability] User ${user.id} cannot receive on WhatsApp (${reason}); not flagged, Telegram still works`);
    return false;
  }
  await markUserUnreachable(user.id, reason);
  return true;
}

/**
 * Clear the flag after hearing from the user again. Called on every inbound update,
 * so it must stay cheap: the updateMany no-ops for the overwhelming majority of users,
 * who were never flagged.
 */
export async function clearUserUnreachable(userId: number): Promise<void> {
  try {
    const result = await prisma.user.updateMany({
      where: { id: userId, unreachableSince: { not: null } },
      data: { unreachableSince: null },
    });

    if (result.count > 0) {
      console.log(`[Reachability] User ${userId} is reachable again`);
      trackActivityAsync(userId, 'user_reachable_again', {});
    }
  } catch (error) {
    captureError(error, 'reachability-clear', { user_id: userId }, 'warning');
  }
}

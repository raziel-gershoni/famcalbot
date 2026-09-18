/**
 * Delivery reachability.
 *
 * When Telegram tells us a chat is permanently undeliverable (the user blocked the
 * bot, deactivated, or kicked us), we record it on the user so the scheduled
 * populations can skip them. Before this existed, a blocked user was retried on every
 * run forever - three failed sends each time, and an admin warning on the third.
 *
 * The flag clears itself: unblocking the bot lets their next message reach the
 * webhook, and handleTelegramWebhook clears it there.
 */

import { prisma } from '../utils/prisma';
import { trackActivityAsync } from '../services/analytics-service';
import { captureError } from './error-capture';

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

/**
 * Admin user-moderation helpers
 * - Suspend / unsuspend a user (soft, reversible)
 * - Hard delete a user and all related rows
 * - Ban / unban an identifier (persistent blocklist; survives hard delete)
 */

import { prisma } from '../utils/prisma';
import { redis } from '../utils/redis';
import { REDIS_KEYS, subscriptionReminderKeys } from '../config/redis-keys';
import { invalidateFeatureAccessCache } from '../services/subscription-service';
import { removeUserFromCache } from '../services/reminder-cache';
import { setupTrackKeys } from '../services/setup-tracks';
import { captureError } from './error-capture';
import { readStoredToken } from '../utils/encryption';

const BLOCK_CACHE_TTL = 3600; // 1 hour — primed on ban, cleared on unban

// ============================================
// SUSPENSION
// ============================================

export function isUserSuspended(user: { suspendedAt: Date | null } | null | undefined): boolean {
  return !!user?.suspendedAt;
}

export async function suspendUser(userId: number, adminId: number, reason: string | null): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: {
      suspendedAt: new Date(),
      suspendedBy: adminId,
      suspendedReason: reason,
    },
  });

  await invalidateFeatureAccessCache(userId);
  console.log(`[Moderation] Admin ${adminId} suspended user ${userId}`);
}

export async function unsuspendUser(userId: number, adminId: number): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: {
      suspendedAt: null,
      suspendedBy: null,
      suspendedReason: null,
    },
  });

  await invalidateFeatureAccessCache(userId);
  console.log(`[Moderation] Admin ${adminId} unsuspended user ${userId}`);
}

// ============================================
// HARD DELETE
// ============================================

/**
 * Delete a user and every row that points at them, in one transaction. The
 * schema refuses the delete (ON DELETE RESTRICT) while a calendar, an event
 * they created, a pairing, or any of the per-user rows below still holds the
 * id, so those go first:
 *   1. Unpair, with unlink()'s writes: the pairing stays as UNLINKED history,
 *      both partners' pairingId is cleared and the partner's calendars go back
 *      to PRIVATE (users first, then calendars, as acceptInvite locks them).
 *   2. Their own calendars; the events in them cascade.
 *   3. Events they created in someone else's calendar go to that calendar's
 *      owner, so the partner keeps them.
 *   4. Pairing history: a row needs its inviter, so the pairings they started
 *      go; where they were the invitee the row stays with no invitee.
 * NativeEvent.forUserId, NativeReminderState.doneByUserId and
 * PairingInvite.acceptedByUserId are SET NULL and their invites and their
 * NativeReminderPing rows CASCADE in the database, as do their copies to Google (GoogleSyncLink, and its items). The Google
 * token goes with the user, so nothing can reach a copy afterwards: before this
 * transaction, each copy with work queued is carried out in Google synchronously
 * (google-sync spec §2): Remove for a copy that is on, the queued Remove or Keep for one
 * turned off, with the link's unlinkToken or else the user's own token, through the
 * worker's own Remove and Keep (carryOutCopiesBeforeDelete). Best effort: a failure is
 * logged with the link id and sent to Sentry, and the delete goes on. Then the user's
 * own Google token is revoked at Google (revokeGoogleToken, Disconnect Google's call),
 * best effort the same way: without it the grant would outlive the row that held it.
 * Admin ids they left in compedBy, grantedBy, suspendedBy and bannedBy stay: they
 * are plain audit columns, and compedBy != null is what marks a comp.
 * Also clears Redis caches keyed by userId.
 */
export async function hardDeleteUser(userId: number, adminId: number): Promise<void> {
  try {
    // Loaded here: the worker reaches the Google client and the calendar code, which the
    // moderation helpers' other callers (the webhooks' blocklist checks) never need.
    const { carryOutCopiesBeforeDelete } = await import('../services/google-sync/worker');
    await carryOutCopiesBeforeDelete(userId);
  } catch (error) {
    // Reading the copies failed: the delete goes on, and their Google calendars stay.
    console.error(`[Moderation] Hard delete of user ${userId}: carrying out the copies to Google failed`, error);
    captureError(error, 'google-sync-hard-delete', { user_id: userId });
  }

  // The Google token goes with the row below, and the grant would stay alive at Google with nothing left that could
  // ever use or revoke it: revoke it now, with Disconnect Google's own call (after the copies above, which needed it).
  // revokeGoogleToken logs and reports its own failure; the delete goes on either way.
  // The same tokens Disconnect Google revokes: the person's own, and any a merged-away account left on a copy link
  // (unlinkToken), which the cascade below would otherwise drop with the link while the grant lives on.
  try {
    const row = await prisma.user.findUnique({ where: { id: userId }, select: { googleRefreshToken: true } });
    const links = await prisma.googleSyncLink.findMany({ where: { userId, unlinkToken: { not: null } }, select: { id: true, unlinkToken: true } });
    const tokens = [...new Set([
      row ? readStoredToken(row.googleRefreshToken, { userId, column: 'googleRefreshToken' }) : '',
      ...links.map((l) => readStoredToken(l.unlinkToken ?? '', { userId, column: `unlinkToken of link ${l.id}` })),
    ].filter(Boolean))];
    if (tokens.length > 0) {
      const { revokeGoogleToken } = await import('../services/google-disconnect');
      for (const token of tokens) {
        if (!(await revokeGoogleToken(token, { user_id: userId }))) {
          console.warn(`[Moderation] Hard delete of user ${userId}: a Google grant could not be revoked; the delete goes on`);
        }
      }
    }
  } catch (error) {
    console.error(`[Moderation] Hard delete of user ${userId}: revoking the Google token failed; the delete goes on`, error);
    captureError(error, 'google-hard-delete-revoke', { user_id: userId });
  }

  // The person's cache keys that need their rows to be named (read before the rows go)
  const cacheKeys = await personalCacheKeys(userId);

  await prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: userId }, select: { pairingId: true } });

    if (user?.pairingId) {
      await tx.pairing.updateMany({
        where: { id: user.pairingId, status: 'ACTIVE' },
        data: { status: 'UNLINKED', unlinkedAt: new Date(), unlinkedByUserId: adminId },
      });
      const partners = await tx.user.findMany({ where: { pairingId: user.pairingId, id: { not: userId } }, select: { id: true } });
      await tx.user.updateMany({ where: { pairingId: user.pairingId }, data: { pairingId: null } });
      await tx.nativeCalendar.updateMany({
        where: { ownerUserId: { in: partners.map(p => p.id) }, privacy: { not: 'PRIVATE' } },
        data: { privacy: 'PRIVATE' },
      });
    }

    await tx.nativeCalendar.deleteMany({ where: { ownerUserId: userId } });

    const elsewhere = await tx.nativeEvent.findMany({ where: { creatorUserId: userId }, select: { calendarId: true } });
    const calendars = await tx.nativeCalendar.findMany({
      where: { id: { in: [...new Set(elsewhere.map(e => e.calendarId))] } },
      select: { id: true, ownerUserId: true },
    });
    for (const calendar of calendars) {
      await tx.nativeEvent.updateMany({
        where: { creatorUserId: userId, calendarId: calendar.id },
        data: { creatorUserId: calendar.ownerUserId },
      });
    }

    await tx.pairing.deleteMany({ where: { inviterUserId: userId } });
    await tx.pairing.updateMany({ where: { inviteeUserId: userId }, data: { inviteeUserId: null } });
    await tx.pairing.updateMany({ where: { unlinkedByUserId: userId }, data: { unlinkedByUserId: null } });

    await tx.userActivity.deleteMany({ where: { userId } });
    await tx.userFeedback.deleteMany({ where: { userId } });
    await tx.usageCounter.deleteMany({ where: { userId } });
    // Our payment records go with the account (the Privacy Policy keeps only Telegram's own after a deletion)
    await tx.payment.deleteMany({ where: { userId } });
    await tx.subscription.deleteMany({ where: { userId } });
    await tx.userFeatureOverride.deleteMany({ where: { userId } });
    await tx.oAuthState.deleteMany({ where: { userId: BigInt(userId) } });
    await tx.user.delete({ where: { id: userId } });
  });

  await clearDeletedUserCaches(userId, cacheKeys);

  console.log(`[Moderation] Admin ${adminId} hard-deleted user ${userId}`);
}

/**
 * The person's Redis keys that only their rows can name: the subscription reminders (keyed by the Telegram id, or the
 * user id, and a month's end: the current month's and each payment's). Read before an account goes (hard delete, the
 * WhatsApp-only half of a merge) and handed to clearDeletedUserCaches. A read that fails is logged; the keys then
 * expire within their 30 days.
 */
export async function personalCacheKeys(userId: number): Promise<string[]> {
  try {
    const [user, subscription, payments] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId }, select: { telegramId: true } }),
      prisma.subscription.findUnique({ where: { userId }, select: { currentPeriodEnd: true } }),
      prisma.payment.findMany({ where: { userId }, select: { periodEnd: true } }),
    ]);
    return subscriptionReminderKeys([user?.telegramId, userId], [subscription?.currentPeriodEnd, ...payments.map((p) => p.periodEnd)]);
  } catch (err) {
    console.error(`[Moderation] Reading the cache keys of user ${userId} failed; they expire within 30 days:`, err);
    captureError(err, 'moderation-cache-keys', { user_id: userId }, 'warning');
    return [];
  }
}

/**
 * Best-effort cleanup of the Redis state keyed by a user id that no longer
 * exists: after a hard delete, and for the WhatsApp-only half of an account
 * merge. Drops them from the reminder cache too, so the reminder run stops
 * reading a user that is gone before the next hourly sync. Every key of the
 * person that outlives a day goes (the account's deletion clears them, not only
 * their 30 days): the access cache, the timezone, the voice flows' state, the
 * setup tracks, the copy-to-Google markers and the Google cache stamps by their
 * id, the kid-name notes by a scan of their prefix, and `extraKeys`
 * (personalCacheKeys, read before the rows went). Keys that live a day or less
 * (the Google ranges, the summary dedup, a briefing's text, the event alerts'
 * marks, the voice cards) expire on their own.
 */
export async function clearDeletedUserCaches(userId: number, extraKeys: string[] = []): Promise<void> {
  try {
    await Promise.all([
      invalidateFeatureAccessCache(userId),
      removeUserFromCache(userId),
      redis.del(
        REDIS_KEYS.userTimezone(userId),
        REDIS_KEYS.lastCreatedEvent(userId),
        REDIS_KEYS.storyImage(userId),
        REDIS_KEYS.recentEvents(userId),
        REDIS_KEYS.googleSyncOrphans(userId),
        REDIS_KEYS.googleSyncDisconnect(userId),
        REDIS_KEYS.gcalStamp(userId),
        REDIS_KEYS.gcalColours(userId),
        REDIS_KEYS.gcalGoneWarned(userId),
        ...setupTrackKeys(userId),
        ...extraKeys,
      ),
      import('../services/google-disconnect').then(({ deleteMatching }) => deleteMatching(`kidname:asked:${userId}:*`)),
    ]);
  } catch (err) {
    console.warn(`[Moderation] Redis cleanup failed for deleted user ${userId}:`, err);
    captureError(err, 'moderation-cache-cleanup', { user_id: userId }, 'warning');
  }
}

// ============================================
// BLOCKLIST
// ============================================

interface BlockArgs {
  telegramId?: number | bigint | null;
  whatsappPhone?: string | null;
}

/**
 * Returns true if either identifier is currently blocked.
 * Cached in Redis for 1h; the cache is primed/cleared by ban/unban.
 */
export async function isIdentifierBlocked({ telegramId, whatsappPhone }: BlockArgs): Promise<boolean> {
  // Quick path: check Redis caches first
  if (telegramId) {
    try {
      const cached = await redis.get<string>(REDIS_KEYS.blockedTelegramId(telegramId.toString()));
      if (cached === '1') return true;
    } catch { /* fall through to DB */ }
  }
  if (whatsappPhone) {
    try {
      const cached = await redis.get<string>(REDIS_KEYS.blockedWhatsAppPhone(whatsappPhone));
      if (cached === '1') return true;
    } catch { /* fall through to DB */ }
  }

  // DB fallback
  const filters: Array<{ telegramId?: bigint } | { whatsappPhone?: string }> = [];
  if (telegramId) filters.push({ telegramId: BigInt(telegramId) });
  if (whatsappPhone) filters.push({ whatsappPhone });
  if (filters.length === 0) return false;

  const blocked = await prisma.blockedIdentifier.findFirst({
    where: { OR: filters },
  });

  if (blocked) {
    // Re-prime cache
    if (blocked.telegramId !== null) {
      redis.set(REDIS_KEYS.blockedTelegramId(blocked.telegramId.toString()), '1', { ex: BLOCK_CACHE_TTL }).catch(() => {});
    }
    if (blocked.whatsappPhone) {
      redis.set(REDIS_KEYS.blockedWhatsAppPhone(blocked.whatsappPhone), '1', { ex: BLOCK_CACHE_TTL }).catch(() => {});
    }
    return true;
  }

  return false;
}

export async function banIdentifier(
  args: BlockArgs,
  adminId: number,
  reason: string | null
): Promise<void> {
  if (!args.telegramId && !args.whatsappPhone) {
    throw new Error('At least one of telegramId or whatsappPhone is required');
  }

  // Use upsert keyed by whichever identifier is present.
  // If the same admin tries to ban a tg+wa pair, write two rows (one per unique key).
  const ops: Promise<unknown>[] = [];

  if (args.telegramId) {
    const tg = BigInt(args.telegramId);
    ops.push(prisma.blockedIdentifier.upsert({
      where: { telegramId: tg },
      update: { bannedBy: adminId, bannedReason: reason },
      create: { telegramId: tg, bannedBy: adminId, bannedReason: reason },
    }));
    ops.push(redis.set(REDIS_KEYS.blockedTelegramId(tg.toString()), '1', { ex: BLOCK_CACHE_TTL }));
  }

  if (args.whatsappPhone) {
    ops.push(prisma.blockedIdentifier.upsert({
      where: { whatsappPhone: args.whatsappPhone },
      update: { bannedBy: adminId, bannedReason: reason },
      create: { whatsappPhone: args.whatsappPhone, bannedBy: adminId, bannedReason: reason },
    }));
    ops.push(redis.set(REDIS_KEYS.blockedWhatsAppPhone(args.whatsappPhone), '1', { ex: BLOCK_CACHE_TTL }));
  }

  await Promise.all(ops);
  console.log(`[Moderation] Admin ${adminId} banned identifier`, args);
}

export async function unbanIdentifier(args: BlockArgs, adminId: number): Promise<void> {
  if (!args.telegramId && !args.whatsappPhone) {
    throw new Error('At least one of telegramId or whatsappPhone is required');
  }

  const ops: Promise<unknown>[] = [];

  if (args.telegramId) {
    const tg = BigInt(args.telegramId);
    ops.push(prisma.blockedIdentifier.deleteMany({ where: { telegramId: tg } }));
    ops.push(redis.del(REDIS_KEYS.blockedTelegramId(tg.toString())));
  }

  if (args.whatsappPhone) {
    ops.push(prisma.blockedIdentifier.deleteMany({ where: { whatsappPhone: args.whatsappPhone } }));
    ops.push(redis.del(REDIS_KEYS.blockedWhatsAppPhone(args.whatsappPhone)));
  }

  await Promise.all(ops);
  console.log(`[Moderation] Admin ${adminId} unbanned identifier`, args);
}

export async function listBlockedIdentifiers(): Promise<Array<{
  id: number;
  telegramId: number | null;
  whatsappPhone: string | null;
  bannedBy: number;
  bannedReason: string | null;
  createdAt: Date;
}>> {
  const rows = await prisma.blockedIdentifier.findMany({
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(r => ({
    id: r.id,
    telegramId: r.telegramId !== null ? Number(r.telegramId) : null,
    whatsappPhone: r.whatsappPhone,
    bannedBy: r.bannedBy,
    bannedReason: r.bannedReason,
    createdAt: r.createdAt,
  }));
}

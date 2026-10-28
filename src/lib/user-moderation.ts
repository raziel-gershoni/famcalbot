/**
 * Admin user-moderation helpers
 * - Suspend / unsuspend a user (soft, reversible)
 * - Hard delete a user and all related rows
 * - Ban / unban an identifier (persistent blocklist; survives hard delete)
 */

import { prisma } from '../utils/prisma';
import { redis } from '../utils/redis';
import { REDIS_KEYS } from '../config/redis-keys';
import { invalidateFeatureAccessCache } from '../services/subscription-service';
import { removeUserFromCache } from '../services/reminder-cache';
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
    await tx.subscription.deleteMany({ where: { userId } });
    await tx.userFeatureOverride.deleteMany({ where: { userId } });
    await tx.oAuthState.deleteMany({ where: { userId: BigInt(userId) } });
    await tx.user.delete({ where: { id: userId } });
  });

  await clearDeletedUserCaches(userId);

  console.log(`[Moderation] Admin ${adminId} hard-deleted user ${userId}`);
}

/**
 * Best-effort cleanup of the Redis state keyed by a user id that no longer
 * exists: after a hard delete, and for the WhatsApp-only half of an account
 * merge. Drops them from the reminder cache too, so the reminder run stops
 * reading a user that is gone before the next hourly sync.
 */
export async function clearDeletedUserCaches(userId: number): Promise<void> {
  try {
    await Promise.all([
      invalidateFeatureAccessCache(userId),
      removeUserFromCache(userId),
      redis.del(REDIS_KEYS.userTimezone(userId)),
      redis.del(REDIS_KEYS.lastCreatedEvent(userId)),
      redis.del(REDIS_KEYS.storyImage(userId)),
      redis.del(REDIS_KEYS.recentEvents(userId)),
    ]);
  } catch (err) {
    console.warn(`[Moderation] Redis cleanup failed for deleted user ${userId}:`, err);
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

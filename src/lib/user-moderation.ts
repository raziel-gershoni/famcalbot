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
 * Cascade-delete a user and all related rows.
 * Order matches src/services/account-linking.ts to satisfy FK constraints.
 * Also clears Redis caches keyed by userId.
 */
export async function hardDeleteUser(userId: number, adminId: number): Promise<void> {
  await prisma.$transaction([
    prisma.userActivity.deleteMany({ where: { userId } }),
    prisma.userFeedback.deleteMany({ where: { userId } }),
    prisma.usageCounter.deleteMany({ where: { userId } }),
    prisma.subscription.deleteMany({ where: { userId } }),
    prisma.userFeatureOverride.deleteMany({ where: { userId } }),
    prisma.user.delete({ where: { id: userId } }),
  ]);

  // Best-effort Redis cleanup
  try {
    await Promise.all([
      invalidateFeatureAccessCache(userId),
      redis.del(REDIS_KEYS.userTimezone(userId)),
      redis.del(REDIS_KEYS.lastCreatedEvent(userId)),
      redis.del(REDIS_KEYS.storyImage(userId)),
    ]);
  } catch (err) {
    console.warn(`[Moderation] Redis cleanup failed for deleted user ${userId}:`, err);
  }

  console.log(`[Moderation] Admin ${adminId} hard-deleted user ${userId}`);
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

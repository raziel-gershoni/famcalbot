/**
 * Account Linking Service
 * Links Telegram and WhatsApp accounts via short-lived link codes.
 *
 * Flow:
 * 1. Telegram user sends /connect → generateLinkCode() → gets 6-char code
 * 2. User sends "link CODE" on WhatsApp → redeemLinkCode() → accounts merged
 */

import type { NativeCalendar, Prisma, Subscription } from '@prisma/client';
import { redis } from '../utils/redis';
import { REDIS_KEYS } from '../config/redis-keys';
import { prisma } from '../utils/prisma';
import { getUserByTelegramId } from './user-service';
import { convertPrismaUserToConfig, UserConfig } from '../types';
import { invalidateFeatureAccessCache } from './subscription-service';
import { getCachedReminderUsers, updateUserInCache } from './reminder-cache';
import { invalidateDueGate } from './native-reminders/due-gate';
import { clearDeletedUserCaches } from '../lib/user-moderation';

const LINK_CODE_TTL = 300; // 5 minutes

interface LinkCodeData {
  telegramId: number;
}

/**
 * Generate a 6-character uppercase link code for a Telegram user
 * Stores in Redis with 5-minute TTL. Calling again invalidates the previous code.
 */
export async function generateLinkCode(telegramId: number): Promise<string> {
  // Generate 6-char uppercase alphanumeric code
  const code = Array.from({ length: 6 }, () =>
    'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]
  ).join('');

  const data: LinkCodeData = { telegramId };

  // Store code → telegramId mapping
  await redis.set(
    REDIS_KEYS.linkCode(code),
    JSON.stringify(data),
    { ex: LINK_CODE_TTL }
  );

  // Store reverse mapping (invalidates previous code for this user)
  await redis.set(
    REDIS_KEYS.linkUser(telegramId),
    code,
    { ex: LINK_CODE_TTL }
  );

  return code;
}

export interface LinkResult {
  success: boolean;
  error?: 'invalid_or_expired' | 'telegram_user_not_found' | 'already_linked' | 'phone_in_use' | 'unknown';
  user?: UserConfig;
}

/**
 * When the access a subscription gives runs out, in epoch ms, by the rules in
 * subscription-service: a comp never does (no period end, the expiry cron skips
 * it), a trial at trialEndsAt, a paid plan (ACTIVE, or CANCELED until the period
 * ends) at currentPeriodEnd, and EXPIRED already has.
 */
function accessEndsAt(sub: Subscription): number {
  if (sub.status === 'EXPIRED') return -Infinity;
  if (sub.compedBy != null) return Infinity;
  if (sub.status === 'TRIALING') return sub.trialEndsAt.getTime();
  return sub.plan !== 'FREE' && sub.currentPeriodEnd ? sub.currentPeriodEnd.getTime() : -Infinity;
}

/** Two default calendars (both primary), or two the user named alike, with the same privacy, are one calendar. */
function isSameCalendar(a: NativeCalendar, b: NativeCalendar): boolean {
  if (a.privacy !== b.privacy) return false;
  return a.name === b.name || (a.labels.includes('primary') && b.labels.includes('primary'));
}

/**
 * Fold the WhatsApp-only user W into the Telegram user T and delete W, inside
 * the caller's transaction. Everything W has moves to T, so the delete clears
 * the schema's ON DELETE RESTRICT relations (calendars, created events,
 * pairings, the per-user rows). A moved calendar keeps its privacy and a fold
 * needs the same privacy on both sides, so the merge shows nobody an event
 * they could not see before. Returns T's pairingId after the merge.
 */
async function mergeWhatsAppUser(
  tx: Prisma.TransactionClient,
  waOnlyUserId: number,
  telegramUserId: number,
  whatsappPhone: string
): Promise<string | null> {
  const w = await tx.user.findUniqueOrThrow({ where: { id: waOnlyUserId } });
  const t = await tx.user.findUniqueOrThrow({ where: { id: telegramUserId } });
  const tIsNative = t.calendarSource === 'NATIVE';

  // Pairing: only NATIVE users pair, one partner each. W's pairing moves to T
  // when T can take it; otherwise W is unpaired with unlink()'s writes.
  let pairingId = t.pairingId;
  const wPairing = w.pairingId ? await tx.pairing.findUnique({ where: { id: w.pairingId } }) : null;
  if (wPairing?.status === 'ACTIVE') {
    if (!t.pairingId && tIsNative) {
      pairingId = wPairing.id;
      await tx.user.update({ where: { id: t.id }, data: { pairingId } });
    } else {
      await tx.pairing.update({
        where: { id: wPairing.id },
        data: { status: 'UNLINKED', unlinkedAt: new Date(), unlinkedByUserId: w.id },
      });
      await tx.user.updateMany({ where: { pairingId: wPairing.id }, data: { pairingId: null } });
      if (pairingId === wPairing.id) pairingId = null; // T and W were paired with each other
    }
  }
  // The moved pairing, and W's pairing history, now name T.
  await tx.pairing.updateMany({ where: { inviterUserId: w.id }, data: { inviterUserId: t.id } });
  await tx.pairing.updateMany({ where: { inviteeUserId: w.id }, data: { inviteeUserId: t.id } });
  await tx.pairing.updateMany({ where: { unlinkedByUserId: w.id }, data: { unlinkedByUserId: t.id } });
  await tx.pairingInvite.updateMany({ where: { acceptedByUserId: w.id }, data: { acceptedByUserId: t.id } });
  // W's own invites cascade with W.

  // Calendars. W's default calendar folds into T's (they are named after each
  // profile, so the names rarely match); the rest move over, soft-deleted ones
  // too. T keeps one primary calendar. A Google user has no live native
  // calendars (oauth-callback soft-deletes them), so for one W's arrive deleted.
  if (tIsNative) {
    const live = (ownerUserId: number) =>
      tx.nativeCalendar.findMany({ where: { ownerUserId, isDeleted: false }, orderBy: { createdAt: 'asc' } });
    const tCalendars = await live(t.id);
    const wCalendars = await live(w.id);
    const folded = new Set<string>();
    let tHasPrimary = tCalendars.some(c => c.labels.includes('primary'));
    for (const wCalendar of wCalendars) {
      const into = tCalendars.find(c => !folded.has(c.id) && isSameCalendar(c, wCalendar));
      if (into) {
        folded.add(into.id);
        await tx.nativeEvent.updateMany({ where: { calendarId: wCalendar.id }, data: { calendarId: into.id } });
        await tx.nativeCalendar.delete({ where: { id: wCalendar.id } });
      } else if (wCalendar.labels.includes('primary')) {
        if (tHasPrimary) {
          await tx.nativeCalendar.update({
            where: { id: wCalendar.id },
            data: { labels: wCalendar.labels.filter(l => l !== 'primary') },
          });
        }
        tHasPrimary = true;
      }
    }
  }
  await tx.nativeCalendar.updateMany({
    where: { ownerUserId: w.id },
    data: { ownerUserId: t.id, ...(tIsNative ? {} : { isDeleted: true }) },
  });

  // Events and reminders W created, was reminded of, or marked done.
  await tx.nativeEvent.updateMany({ where: { creatorUserId: w.id }, data: { creatorUserId: t.id } });
  await tx.nativeEvent.updateMany({ where: { forUserId: w.id }, data: { forUserId: t.id } });
  await tx.nativeReminderState.updateMany({ where: { doneByUserId: w.id }, data: { doneByUserId: t.id } });

  // Subscription (userId is unique): the one that runs longer stays; a tie keeps T's.
  const tSub = await tx.subscription.findUnique({ where: { userId: t.id } });
  const wSub = await tx.subscription.findUnique({ where: { userId: w.id } });
  if (wSub && (!tSub || accessEndsAt(wSub) > accessEndsAt(tSub))) {
    if (tSub) await tx.subscription.delete({ where: { id: tSub.id } });
    await tx.subscription.update({ where: { id: wSub.id }, data: { userId: t.id } });
  } else if (wSub) {
    await tx.subscription.delete({ where: { id: wSub.id } });
  }

  // Usage counter and override are one per user: T's stays, W's moves only into
  // a gap. The early-adopter flag survives from either side.
  const tUsage = await tx.usageCounter.findUnique({ where: { userId: t.id } });
  if (tUsage) await tx.usageCounter.deleteMany({ where: { userId: w.id } });
  else await tx.usageCounter.updateMany({ where: { userId: w.id }, data: { userId: t.id } });

  const tOverride = await tx.userFeatureOverride.findUnique({ where: { userId: t.id } });
  const wOverride = await tx.userFeatureOverride.findUnique({ where: { userId: w.id } });
  if (wOverride && !tOverride) {
    await tx.userFeatureOverride.update({ where: { id: wOverride.id }, data: { userId: t.id } });
  } else if (wOverride && tOverride) {
    if (wOverride.earlyAdopter && !tOverride.earlyAdopter) {
      await tx.userFeatureOverride.update({ where: { id: tOverride.id }, data: { earlyAdopter: true } });
    }
    await tx.userFeatureOverride.delete({ where: { id: wOverride.id } });
  }

  await tx.userActivity.updateMany({ where: { userId: w.id }, data: { userId: t.id } });
  await tx.userFeedback.updateMany({ where: { userId: w.id }, data: { userId: t.id } });
  // A Google sign-in W left half-done is minutes old; it is restarted from T.
  await tx.oAuthState.deleteMany({ where: { userId: BigInt(w.id) } });

  // W goes before T takes its WhatsApp ids: they are unique.
  await tx.user.delete({ where: { id: w.id } });
  await tx.user.update({
    where: { id: t.id },
    data: {
      whatsappPhone: w.whatsappPhone || whatsappPhone,
      whatsappBsuid: w.whatsappBsuid || null,
      messagingPlatform: 'all',
    },
  });

  return pairingId;
}

/**
 * After a merge commits: W's caches go, T's reminder-cache entry gets the
 * pairing it now has (the reminder run reads it from there until the hourly
 * sync), and the reminder pass wakes for the reminders T took over. Best
 * effort: the merge has already happened. T's feature access is invalidated
 * by the caller, as for a plain link.
 */
async function afterMerge(wUserId: number, tUserId: number, pairingId: string | null): Promise<void> {
  await clearDeletedUserCaches(wUserId);
  invalidateDueGate();
  const cached = (await getCachedReminderUsers())?.find(u => u.id === tUserId);
  if (cached && (cached.pairingId ?? null) !== pairingId) {
    await updateUserInCache({ ...cached, pairingId });
  }
}

/**
 * Redeem a link code to connect a WhatsApp phone to a Telegram account.
 * If a WA-only user exists with this phone, everything they have moves to the
 * Telegram user, their record is deleted, and the phone goes to the Telegram user.
 */
export async function redeemLinkCode(code: string, whatsappPhone: string): Promise<LinkResult> {
  // Look up code in Redis
  const raw = await redis.get<string>(REDIS_KEYS.linkCode(code));
  if (!raw) {
    return { success: false, error: 'invalid_or_expired' };
  }

  let data: LinkCodeData;
  try {
    // Upstash may return already-parsed object or raw string
    data = typeof raw === 'string' ? JSON.parse(raw) : raw as unknown as LinkCodeData;
  } catch {
    return { success: false, error: 'invalid_or_expired' };
  }

  // Look up Telegram user
  const telegramUser = await getUserByTelegramId(data.telegramId);
  if (!telegramUser) {
    return { success: false, error: 'telegram_user_not_found' };
  }

  // Check if TG user already has a WhatsApp phone
  if (telegramUser.whatsappPhone) {
    return { success: false, error: 'already_linked' };
  }

  try {
    // Check if a WA-only user exists with this phone
    const waOnlyUser = await prisma.user.findUnique({
      where: { whatsappPhone: whatsappPhone }
    });

    if (waOnlyUser && waOnlyUser.id !== telegramUser.id && waOnlyUser.telegramId !== null) {
      // The phone belongs to another Telegram account, not a WhatsApp-only one.
      return { success: false, error: 'phone_in_use' };
    }

    if (waOnlyUser && waOnlyUser.id !== telegramUser.id) {
      const pairingId = await prisma.$transaction((tx) =>
        mergeWhatsAppUser(tx, waOnlyUser.id, telegramUser.id, whatsappPhone)
      );
      await afterMerge(waOnlyUser.id, telegramUser.id, pairingId);

      console.log(`[AccountLink] Merged WA-only user ${waOnlyUser.id} into TG user ${telegramUser.id}`);
    } else if (!waOnlyUser) {
      // No WA-only user — just update TG user
      const isBsuid = !whatsappPhone.match(/^\+?\d+$/);
      await prisma.user.update({
        where: { id: telegramUser.id },
        data: {
          ...(isBsuid ? { whatsappBsuid: whatsappPhone } : { whatsappPhone: whatsappPhone }),
          messagingPlatform: 'all',
        },
      });

      console.log(`[AccountLink] Linked WhatsApp ${whatsappPhone} to TG user ${telegramUser.id}`);
    }
    // If waOnlyUser.id === telegramUser.id, the user is already linked (shouldn't happen)

    // Clean up Redis
    await redis.del(REDIS_KEYS.linkCode(code));
    await redis.del(REDIS_KEYS.linkUser(data.telegramId));

    // Invalidate feature access cache
    await invalidateFeatureAccessCache(telegramUser.id);

    // Return updated user
    const updatedUser = await prisma.user.findUnique({ where: { id: telegramUser.id } });
    return {
      success: true,
      user: updatedUser ? convertPrismaUserToConfig(updatedUser) : undefined,
    };
  } catch (error) {
    console.error('[AccountLink] Error redeeming link code:', error);
    return { success: false, error: 'unknown' };
  }
}

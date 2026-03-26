/**
 * Account Linking Service
 * Links Telegram and WhatsApp accounts via short-lived link codes.
 *
 * Flow:
 * 1. Telegram user sends /connect → generateLinkCode() → gets 6-char code
 * 2. User sends "link CODE" on WhatsApp → redeemLinkCode() → accounts merged
 */

import { Redis } from '@upstash/redis';
import { REDIS_KEYS } from '../config/redis-keys';
import { prisma } from '../utils/prisma';
import { getUserByTelegramId } from './user-service';
import { convertPrismaUserToConfig, UserConfig } from '../types';
import { invalidateFeatureAccessCache } from './subscription-service';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

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
 * Redeem a link code to connect a WhatsApp phone to a Telegram account.
 * If a WA-only user exists with this phone, their record is deleted and
 * the phone is merged into the Telegram user.
 */
export async function redeemLinkCode(code: string, whatsappPhone: string): Promise<LinkResult> {
  // Look up code in Redis
  const raw = await redis.get<string>(REDIS_KEYS.linkCode(code));
  if (!raw) {
    return { success: false, error: 'invalid_or_expired' };
  }

  let data: LinkCodeData;
  try {
    data = JSON.parse(raw) as LinkCodeData;
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

    if (waOnlyUser && waOnlyUser.id !== telegramUser.id) {
      // Merge: delete WA-only user and update TG user in a transaction
      await prisma.$transaction([
        // Delete WA-only user's related records
        prisma.userActivity.deleteMany({ where: { userId: waOnlyUser.id } }),
        prisma.userFeedback.deleteMany({ where: { userId: waOnlyUser.id } }),
        prisma.usageCounter.deleteMany({ where: { userId: waOnlyUser.id } }),
        prisma.subscription.deleteMany({ where: { userId: waOnlyUser.id } }),
        prisma.userFeatureOverride.deleteMany({ where: { userId: waOnlyUser.id } }),
        // Delete WA-only user
        prisma.user.delete({ where: { id: waOnlyUser.id } }),
        // Update TG user with WhatsApp phone
        prisma.user.update({
          where: { id: telegramUser.id },
          data: {
            whatsappPhone: whatsappPhone,
            messagingPlatform: 'all',
          },
        }),
      ]);

      console.log(`[AccountLink] Merged WA-only user ${waOnlyUser.id} into TG user ${telegramUser.id}`);
    } else if (!waOnlyUser) {
      // No WA-only user — just update TG user
      await prisma.user.update({
        where: { id: telegramUser.id },
        data: {
          whatsappPhone: whatsappPhone,
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

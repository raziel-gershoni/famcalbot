/**
 * Subscription Reminders Service
 * Sends renewal reminders and handles subscription expiration at month end
 */

import { Redis } from '@upstash/redis';
import { prisma, withDbRetry } from '../utils/prisma';
import { getBot } from './telegram';
import { getTelegramService } from './messaging/factory';
import { MessageFormat } from './messaging/types';
import { PLAN_CONFIGS, PlanId } from '../config/plans';
import { trackActivity } from './analytics-service';
import { buildUrl } from '../config/urls';
import { captureError } from '../lib/error-capture';

// Initialize Redis client
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const REMINDER_TTL_SECONDS = 35 * 24 * 60 * 60; // 35 days

type ReminderType = '3day' | 'lastday' | 'expired';

/**
 * Get year-month string for current month (e.g., "2026-02")
 */
function getYearMonth(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

/**
 * Generate Redis key for subscription reminder tracking
 */
function getReminderKey(telegramId: bigint | string, type: ReminderType): string {
  return `subscription_reminder:${telegramId}:${getYearMonth()}:${type}`;
}

/**
 * Check if a reminder has already been sent this month
 */
async function hasReminderBeenSent(telegramId: bigint | string, type: ReminderType): Promise<boolean> {
  const key = getReminderKey(telegramId, type);
  try {
    const exists = await redis.exists(key);
    return exists === 1;
  } catch (error) {
    console.error('[Subscription Reminders] Error checking reminder status:', error);
    return false; // On error, allow sending (better to duplicate than miss)
  }
}

/**
 * Mark a reminder as sent
 */
async function markReminderSent(telegramId: bigint | string, type: ReminderType): Promise<void> {
  const key = getReminderKey(telegramId, type);
  try {
    await redis.set(key, '1', { ex: REMINDER_TTL_SECONDS });
  } catch (error) {
    console.error('[Subscription Reminders] Error marking reminder as sent:', error);
  }
}

/**
 * Load localized messages for subscription reminders
 */
async function getSubscriptionMessages(locale: string) {
  const messages = await import(`../../messages/${locale === 'he' || locale === 'ru' ? locale : 'en'}.json`);
  return messages.default.subscription;
}

/**
 * Send expiring subscription reminders
 * @param daysLeft - Days until subscription expires (3 = 3-day warning, 0 = last day)
 */
async function sendExpiringReminders(daysLeft: number): Promise<void> {
  const reminderType: ReminderType = daysLeft === 0 ? 'lastday' : '3day';
  console.log(`[Subscription Reminders] Sending ${reminderType} reminders...`);

  // Find active/canceled subscriptions expiring at end of month
  const now = new Date();
  const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);

  const subscriptions = await withDbRetry(
    () => prisma.subscription.findMany({
      where: {
        status: { in: ['ACTIVE', 'CANCELED'] },
        plan: { not: 'FREE' },
        currentPeriodEnd: {
          gte: now,
          lt: endOfMonth,
        },
      },
      include: {
        user: {
          select: {
            telegramId: true,
            language: true,
            name: true,
          },
        },
      },
    }),
    'subscription-reminders.findExpiring'
  );

  console.log(`[Subscription Reminders] Found ${subscriptions.length} subscriptions expiring this month`);

  // Get usage stats for all users at once
  const userIds = subscriptions.map(s => s.userId);
  const usageCounters = await withDbRetry(
    () => prisma.usageCounter.findMany({
      where: { userId: { in: userIds } },
    }),
    'subscription-reminders.getUsage'
  );

  const usageMap = new Map(usageCounters.map(u => [u.userId, u]));

  const bot = getBot();
  const service = getTelegramService(bot);

  for (const sub of subscriptions) {
    const telegramId = sub.user.telegramId;

    // Skip users without Telegram ID
    if (!telegramId) {
      console.log(`[Subscription Reminders] Skipping user ${sub.userId} - no Telegram ID`);
      continue;
    }

    // Skip if already sent this month
    if (await hasReminderBeenSent(telegramId, reminderType)) {
      continue;
    }

    const locale = sub.user.language || 'en';
    const t = await getSubscriptionMessages(locale);
    const planConfig = PLAN_CONFIGS[sub.plan as PlanId];
    const usage = usageMap.get(sub.userId);
    const subscriptionUrl = buildUrl(`/${locale}/subscription?user_id=${telegramId}`);

    let message: string;

    if (daysLeft > 0) {
      // 3-day reminder with usage stats
      const usageStats = [
        t.reminders?.expiringSoon?.textUsage?.replace('{count}', String(usage?.textSummariesUsed ?? 0)) || `${usage?.textSummariesUsed ?? 0} text summaries`,
        t.reminders?.expiringSoon?.voiceUsage?.replace('{count}', String(usage?.voiceSummariesUsed ?? 0)) || `${usage?.voiceSummariesUsed ?? 0} voice messages`,
        t.reminders?.expiringSoon?.eventUsage?.replace('{count}', String(usage?.voiceEventsCreated ?? 0)) || `${usage?.voiceEventsCreated ?? 0} voice-created events`,
      ].map(s => `  \u2022 ${s}`).join('\n');

      message = [
        (t.reminders?.expiringSoon?.title || '\uD83C\uDF1F Heads up! Your FamCal {plan} renews in {days} days')
          .replace('{plan}', planConfig.name)
          .replace('{days}', String(daysLeft)),
        '',
        t.reminders?.expiringSoon?.usage || 'Your family has used:',
        usageStats,
        '',
        (t.reminders?.expiringSoon?.cta || 'Keep the magic going for just \u2B50{price}/month')
          .replace('{price}', String(planConfig.priceStars)),
      ].join('\n');
    } else {
      // Last day reminder
      const freeLimits = PLAN_CONFIGS.FREE.limits;
      message = [
        t.reminders?.lastDay?.title || '\u23F0 Last day to renew your FamCal subscription!',
        '',
        t.reminders?.lastDay?.warning || "Tomorrow you'll switch to the Free plan:",
        `  \u2022 ${(t.reminders?.lastDay?.limitedText || '{limit} text summaries (was unlimited)').replace('{limit}', String(freeLimits.textSummaries))}`,
        `  \u2022 ${(t.reminders?.lastDay?.limitedVoice || '{limit} voice messages (was unlimited)').replace('{limit}', String(freeLimits.voiceSummaries))}`,
        `  \u2022 ${t.reminders?.lastDay?.noVoiceEvents || 'No voice event creation'}`,
        '',
        t.reminders?.lastDay?.cta || 'Stay organized - renew now:',
      ].join('\n');
    }

    const buttonText = daysLeft > 0
      ? (t.reminders?.expiringSoon?.button || '\uD83D\uDCAB Renew Subscription')
      : (t.reminders?.lastDay?.button || '\uD83D\uDCAB Renew for \u2B50{price}').replace('{price}', String(planConfig.priceStars));

    try {
      const chatId = String(telegramId);
      await service.sendMessage(chatId, message, {
        format: MessageFormat.HTML,
        replyMarkup: {
          inline_keyboard: [[
            { text: buttonText, web_app: { url: subscriptionUrl } },
          ]],
        },
      });

      await markReminderSent(telegramId, reminderType);
      await trackActivity(sub.userId, 'subscription_reminder_sent', {
        type: reminderType,
        plan: sub.plan,
        days_left: daysLeft,
      });

      console.log(`[Subscription Reminders] Sent ${reminderType} reminder to user ${chatId}`);
    } catch (error) {
      captureError(error, 'subscription-reminder-send', {
        user_id: sub.userId,
        telegram_id: String(telegramId),
        type: reminderType,
      });
    }
  }
}

/**
 * Expire subscriptions on the 1st of the month
 * Downgrade to FREE and send notification
 */
async function expireSubscriptions(): Promise<void> {
  console.log('[Subscription Reminders] Processing subscription expirations...');

  const now = new Date();

  // Find subscriptions that have expired (currentPeriodEnd is in the past)
  const expiredSubscriptions = await withDbRetry(
    () => prisma.subscription.findMany({
      where: {
        status: { in: ['ACTIVE', 'CANCELED'] },
        plan: { not: 'FREE' },
        currentPeriodEnd: {
          lt: now,
        },
      },
      include: {
        user: {
          select: {
            telegramId: true,
            language: true,
            name: true,
          },
        },
      },
    }),
    'subscription-reminders.findExpired'
  );

  console.log(`[Subscription Reminders] Found ${expiredSubscriptions.length} expired subscriptions`);

  const bot = getBot();
  const service = getTelegramService(bot);

  for (const sub of expiredSubscriptions) {
    const telegramId = sub.user.telegramId;
    const previousPlan = sub.plan;

    // Skip users without Telegram ID
    if (!telegramId) {
      console.log(`[Subscription Reminders] Skipping expired user ${sub.userId} - no Telegram ID`);
      continue;
    }

    // Skip if already sent this month
    if (await hasReminderBeenSent(telegramId, 'expired')) {
      continue;
    }

    // Downgrade to FREE
    await withDbRetry(
      () => prisma.subscription.update({
        where: { userId: sub.userId },
        data: {
          status: 'EXPIRED',
          plan: 'FREE',
        },
      }),
      'subscription-reminders.expire'
    );

    // Send notification
    const locale = sub.user.language || 'en';
    const t = await getSubscriptionMessages(locale);
    const planConfig = PLAN_CONFIGS[previousPlan as PlanId];
    const subscriptionUrl = buildUrl(`/${locale}/subscription?user_id=${telegramId}`);

    const message = [
      t.reminders?.expired?.title || '\uD83D\uDCC5 Your FamCal subscription has ended',
      '',
      t.reminders?.expired?.body || "You're now on the Free plan. No worries - your calendars and settings are safe!",
      '',
      t.reminders?.expired?.cta || 'Miss the unlimited features? Resubscribe anytime:',
    ].join('\n');

    const buttonText = (t.reminders?.expired?.button || '\uD83D\uDCAB Get {plan} - \u2B50{price}/month')
      .replace('{plan}', planConfig.name)
      .replace('{price}', String(planConfig.priceStars));

    try {
      const chatId = String(telegramId);
      await service.sendMessage(chatId, message, {
        format: MessageFormat.HTML,
        replyMarkup: {
          inline_keyboard: [[
            { text: buttonText, web_app: { url: subscriptionUrl } },
          ]],
        },
      });

      await markReminderSent(telegramId, 'expired');
      await trackActivity(sub.userId, 'subscription_expired', {
        plan: previousPlan,
      });

      console.log(`[Subscription Reminders] Expired subscription for user ${chatId}, sent notification`);
    } catch (error) {
      captureError(error, 'subscription-expiration-notify', {
        user_id: sub.userId,
        telegram_id: String(telegramId),
      });
    }
  }
}

/**
 * Main entry point - process subscription reminders based on day of month
 * Called daily by the health check endpoint
 */
export async function processSubscriptionReminders(): Promise<void> {
  const now = new Date();
  const dayOfMonth = now.getDate();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();

  console.log(`[Subscription Reminders] Processing for day ${dayOfMonth} of ${daysInMonth}`);

  // 3 days before end of month
  if (dayOfMonth === daysInMonth - 2) {
    await sendExpiringReminders(3);
  }

  // Last day of month
  if (dayOfMonth === daysInMonth) {
    await sendExpiringReminders(0);
  }

  // 1st of month - expire subscriptions
  if (dayOfMonth === 1) {
    await expireSubscriptions();
  }

  console.log('[Subscription Reminders] Processing complete');
}

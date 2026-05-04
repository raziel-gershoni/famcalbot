/**
 * Subscription Reminders Service
 * Sends renewal reminders and handles subscription expiration at month end
 */

import { redis } from '../utils/redis';
import { prisma } from '../utils/prisma';
import { getBot } from './telegram';
import { getTelegramService } from './messaging/factory';
import { MessageFormat } from './messaging/types';
import { PLAN_CONFIGS, PlanId } from '../config/plans';
import { trackActivity } from './analytics-service';
import { buildUrl } from '../config/urls';
import { captureError } from '../lib/error-capture';
import { getEarlyAdoptionMode } from './reminder-cache';
import { REDIS_KEYS } from '../config/redis-keys';


const REMINDER_TTL_SECONDS = 35 * 24 * 60 * 60; // 35 days

type ReminderType = '3day' | 'lastday' | 'expired';

/**
 * Generate Redis key for subscription reminder tracking
 * Uses the subscription period end date for dedup (each billing period gets its own set of reminders)
 */
function getReminderKey(telegramId: bigint | string, periodEnd: Date, type: ReminderType): string {
  const dateStr = periodEnd.toISOString().split('T')[0];
  return REDIS_KEYS.subscriptionReminder(telegramId, dateStr, type);
}

/**
 * Check if a reminder has already been sent for this billing period
 */
async function hasReminderBeenSent(telegramId: bigint | string, periodEnd: Date, type: ReminderType): Promise<boolean> {
  const key = getReminderKey(telegramId, periodEnd, type);
  try {
    const exists = await redis.exists(key);
    return exists === 1;
  } catch (error) {
    console.error('[Subscription Reminders] Error checking reminder status:', error);
    captureError(error, 'subscription-reminder-check-status', { telegramId: String(telegramId) }, 'warning');
    return false; // On error, allow sending (better to duplicate than miss)
  }
}

/**
 * Mark a reminder as sent for this billing period
 */
async function markReminderSent(telegramId: bigint | string, periodEnd: Date, type: ReminderType): Promise<void> {
  const key = getReminderKey(telegramId, periodEnd, type);
  try {
    await redis.set(key, '1', { ex: REMINDER_TTL_SECONDS });
  } catch (error) {
    console.error('[Subscription Reminders] Error marking reminder as sent:', error);
    captureError(error, 'subscription-reminder-mark-sent', { telegramId: String(telegramId) }, 'warning');
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

  const now = new Date();
  const windowEnd = new Date(now);
  windowEnd.setDate(windowEnd.getDate() + daysLeft + 1);

  // Find subscriptions expiring within the window
  const subscriptions = await prisma.subscription.findMany({
    where: {
      status: { in: ['ACTIVE', 'CANCELED'] },
      plan: { not: 'FREE' },
      currentPeriodEnd: {
        gt: now,
        lte: windowEnd,
      },
    },
    include: {
      user: {
        select: {
          telegramId: true,
          whatsappPhone: true,
          whatsappBsuid: true,
          messagingPlatform: true,
          language: true,
          name: true,
        },
      },
    },
  });

  console.log(`[Subscription Reminders] Found ${subscriptions.length} subscriptions expiring within ${daysLeft + 1} days`);

  // Get usage stats for all users at once
  const userIds = subscriptions.map(s => s.userId);
  const usageCounters = await prisma.usageCounter.findMany({
    where: { userId: { in: userIds } },
  });

  const usageMap = new Map(usageCounters.map(u => [u.userId, u]));

  const bot = getBot();
  const service = getTelegramService(bot);

  for (const sub of subscriptions) {
    const telegramId = sub.user.telegramId;
    const whatsappPhone = sub.user.whatsappPhone;

    // Skip users without any messaging channel
    if (!telegramId && !whatsappPhone) {
      console.log(`[Subscription Reminders] Skipping user ${sub.userId} - no messaging channel`);
      continue;
    }

    // Skip if already sent for this billing period (use userId for dedup)
    if (await hasReminderBeenSent(telegramId || String(sub.userId), sub.currentPeriodEnd!, reminderType)) {
      continue;
    }

    const locale = sub.user.language || 'en';
    const t = await getSubscriptionMessages(locale);
    const planConfig = PLAN_CONFIGS[sub.plan as PlanId];
    const usage = usageMap.get(sub.userId);
    const subscriptionUrl = buildUrl(`/${locale}/subscription?user_id=${sub.userId}`);

    // Compute per-user days left
    const userDaysLeft = Math.max(0, Math.ceil(
      (sub.currentPeriodEnd!.getTime() - now.getTime()) / 86400000
    ));

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
          .replace('{days}', String(userDaysLeft)),
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
      // Send to Telegram if available
      if (telegramId) {
        const chatId = String(telegramId);
        await service.sendMessage(chatId, message, {
          format: MessageFormat.HTML,
          replyMarkup: {
            inline_keyboard: [[
              { text: buttonText, web_app: { url: subscriptionUrl } },
            ]],
          },
        });
      }

      // Send to WhatsApp if available — template notification only (no free-form).
      // Prefer phone (Meta-reliable) over BSUID until June 2026 transition; see getWhatsAppChatId.
      const waChatId = whatsappPhone || sub.user.whatsappBsuid;
      if (waChatId && (!telegramId || sub.user.messagingPlatform === 'whatsapp' || sub.user.messagingPlatform === 'all')) {
        const { getWhatsAppService } = await import('./messaging/factory');
        const { buildWhatsAppTemplate } = await import('./messaging/whatsapp-template');
        const template = buildWhatsAppTemplate(sub.user.language || 'en');
        const waService = getWhatsAppService();
        await waService.sendMessage(waChatId, '', { whatsappTemplate: template });
      }

      await markReminderSent(telegramId || String(sub.userId), sub.currentPeriodEnd!, reminderType);
      await trackActivity(sub.userId, 'subscription_reminder_sent', {
        type: reminderType,
        plan: sub.plan,
        days_left: userDaysLeft,
      });

      console.log(`[Subscription Reminders] Sent ${reminderType} reminder to user ${sub.userId}`);
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
 * Expire subscriptions past their period end date
 * Downgrade to FREE and send notification
 */
async function expireSubscriptions(): Promise<void> {
  console.log('[Subscription Reminders] Processing subscription expirations...');

  const now = new Date();

  // Find subscriptions that have expired (currentPeriodEnd is in the past)
  const expiredSubscriptions = await prisma.subscription.findMany({
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
          whatsappPhone: true,
          whatsappBsuid: true,
          messagingPlatform: true,
          language: true,
          name: true,
        },
      },
    },
  });

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

    // Skip if already sent for this billing period
    if (await hasReminderBeenSent(telegramId, sub.currentPeriodEnd!, 'expired')) {
      continue;
    }

    // Downgrade to FREE
    await prisma.subscription.update({
      where: { userId: sub.userId },
      data: {
        status: 'EXPIRED',
        plan: 'FREE',
      },
    });

    // Send notification
    const locale = sub.user.language || 'en';
    const t = await getSubscriptionMessages(locale);
    const planConfig = PLAN_CONFIGS[previousPlan as PlanId];
    const subscriptionUrl = buildUrl(`/${locale}/subscription?user_id=${sub.userId}`);

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

      await markReminderSent(telegramId, sub.currentPeriodEnd!, 'expired');
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
 * Main entry point - process subscription reminders daily
 * Called daily by the health check endpoint
 * Runs all checks every day since subscriptions can expire on any date
 */
export async function processSubscriptionReminders(): Promise<void> {
  const earlyMode = await getEarlyAdoptionMode();
  if (earlyMode) {
    console.log('[Subscription Reminders] Skipped - early adoption mode is ON');
    return;
  }

  console.log('[Subscription Reminders] Processing daily subscription checks...');

  await sendExpiringReminders(3);   // 3-day warnings
  await sendExpiringReminders(0);   // last-day warnings
  await expireSubscriptions();       // expire past-due

  console.log('[Subscription Reminders] Processing complete');
}

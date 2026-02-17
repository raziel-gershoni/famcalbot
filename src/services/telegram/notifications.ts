/**
 * Telegram notification functions for subscription events
 */

import { getMessagingService } from './bot';
import { getBotMessages } from '../../lib/bot-messages';
import { buildUrl } from '../../config/urls';
import { MessageFormat } from '../messaging';

/**
 * Send trial expired notification to user via bot message
 * Called once when trial expires (in expireTrialSubscription)
 */
export async function sendTrialExpiredNotification(telegramId: number, locale: string): Promise<void> {
  const service = getMessagingService();
  const t = await getBotMessages(locale);
  const upgradeUrl = buildUrl(`/${locale}/subscription?user_id=${telegramId}`);

  const message = t.subscription?.trialExpired?.message
    || '📋 Your Pro trial has ended. You\'re now on the Free plan.';

  await service.sendMessage(telegramId, message, {
    format: MessageFormat.HTML,
    replyMarkup: {
      inline_keyboard: [[
        { text: t.subscription?.upgradeButton || '⭐ Upgrade Plan', web_app: { url: upgradeUrl } },
      ]],
    },
  });
}

/**
 * Send reminder downgrade notification to user via bot message
 * Called once when user with reminders enabled loses Pro access
 */
export async function sendReminderDowngradeNotification(telegramId: number, locale: string): Promise<void> {
  const service = getMessagingService();
  const t = await getBotMessages(locale);
  const upgradeUrl = buildUrl(`/${locale}/subscription?user_id=${telegramId}`);

  const message = t.subscription?.remindersLost?.message
    || '🔔 Your event reminders are paused because your Pro trial ended. Upgrade to re-enable!';

  await service.sendMessage(telegramId, message, {
    format: MessageFormat.HTML,
    replyMarkup: {
      inline_keyboard: [[
        { text: t.subscription?.upgradeButton || '⭐ Upgrade Plan', web_app: { url: upgradeUrl } },
      ]],
    },
  });
}

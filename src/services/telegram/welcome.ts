/**
 * The bot's welcome with the dashboard button: what /start answers when no deep link takes over, and the first message
 * after Connect Telegram (src/services/telegram-connect.ts). One builder, so both say the same and open the same page.
 *
 * - An admin gets both boards.
 * - With no place yet, the onboarding welcome with the Settings button: the place is the only setup that gates good
 *   summaries (everyone has FamCal, and Google is optional).
 * - Otherwise the welcome with the dashboard button.
 *
 * Every welcome ends with the Privacy Policy and the Terms, with no link preview (the notice that comes with the first
 * request for data). The name is the person's own and is escaped for HTML (a function replacement, so "$&" in a name stays text).
 */

import type { UserConfig } from '../../types';
import { buildUrl } from '../../config/urls';
import { getBotMessages } from '../../lib/bot-messages';
import { policyLinks } from '../../lib/plan-disclosure';
import { escapeHtml } from '../../utils/html';
import { MessagingPlatform, MessageFormat } from '../messaging/types';
import { getMessagingService } from './bot';

export async function sendWelcome(
  chatId: number | string,
  user: UserConfig,
  platform: MessagingPlatform = MessagingPlatform.TELEGRAM,
): Promise<void> {
  // The name is the person's own text and goes into HTML: escaped, so an "&" or a "<" in it can't make Telegram refuse the welcome
  const name = escapeHtml(user.name || 'there');
  const locale = user.language || 'en';
  const t = await getBotMessages(locale);
  const service = getMessagingService();
  const links = policyLinks(t.policy, locale, 'html');
  const dashboardUrl = buildUrl(`/${locale}/dashboard?user_id=${user.telegramId ?? user.id}`);
  const welcome = t.start.welcome.replace('{name}', () => name);

  if (user.isAdmin) {
    const adminUrl = buildUrl(`/${locale}/admin-panel?user_id=${user.telegramId ?? user.id}`);
    const message = `${welcome}\n\n${t.start.chooseBoard}\n\n${links}`;

    await service.sendMessage(chatId, message, {
      format: MessageFormat.HTML,
      disablePreview: true,
      replyMarkup: {
        inline_keyboard: [
          [{ text: t.start.userDashboard, web_app: { url: dashboardUrl } }],
          [{ text: t.start.adminPanel, web_app: { url: adminUrl } }]
        ]
      }
    });
    return;
  }

  if (!user.location) {
    const settingsUrl = buildUrl(`/${locale}/settings?user_id=${user.telegramId ?? user.id}`);
    const platformName = platform === MessagingPlatform.TELEGRAM ? 'Telegram' : 'WhatsApp';
    const nativeWelcome = t.onboarding.nativeWelcome
      .replace('{platform}', platformName)
      .replace('{name}', () => name);
    await service.sendMessage(chatId, `${nativeWelcome}\n\n${links}`, {
      format: MessageFormat.HTML,
      disablePreview: true,
      replyMarkup: {
        inline_keyboard: [[
          { text: t.onboarding.nativeLocationButton, web_app: { url: settingsUrl } }
        ]]
      }
    });
    return;
  }

  // Returning user: simple dashboard button
  const message = `${welcome}\n\n${t.start.tapButton}\n\n${links}`;

  await service.sendMessage(chatId, message, {
    format: MessageFormat.HTML,
    disablePreview: true,
    replyMarkup: {
      inline_keyboard: [[
        { text: t.start.dashboard, web_app: { url: dashboardUrl } }
      ]]
    }
  });
}

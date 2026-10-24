/**
 * The text-summary quota gate for every on-demand text answer: the daily and tomorrow
 * summaries, /weather, /lookahead and /nextweek. One path, so the wording, the upgrade
 * button and the open draft are handled once.
 */

import type { UserConfig } from '../../types';
import { IMessagingService, MessageFormat } from '../messaging';
import type { StreamMessageHandle } from '../messaging/types';
import { checkFeatureAccess } from '../subscription-service';
import { getBotMessages, getSubscriptionMessages } from '../../lib/bot-messages';
import { buildUrl } from '../../config/urls';

/**
 * When the user is out of text summaries: tell them in their language, with an upgrade button
 * (a Mini App button on Telegram, a link button on WhatsApp), and say so, so the caller stops.
 * An open stream draft turns into the message (no "Preparing…" stage message stays behind);
 * without one it is a new message.
 */
export async function denyOverTextLimit(
  user: UserConfig,
  chatId: number | string,
  messagingService: IMessagingService,
  userLanguage: string,
  streamHandle?: StreamMessageHandle
): Promise<boolean> {
  const access = await checkFeatureAccess(user.id, 'text_summary');
  if (access.allowed) return false;

  const [subscription, bot] = await Promise.all([getSubscriptionMessages(userLanguage), getBotMessages(userLanguage)]);
  const text = String(subscription.textLimitReached).replace('{limit}', access.limit !== undefined ? String(access.limit) : '');
  const upgradeLabel: string = bot.subscription?.upgradeButton ?? subscription.upgradeButton;
  const upgradeUrl = buildUrl(`/${userLanguage}/subscription?user_id=${user.telegramId ?? user.id}`);
  const options = {
    format: MessageFormat.HTML,
    replyMarkup: { inline_keyboard: [[{ text: upgradeLabel, web_app: { url: upgradeUrl } }]] },
    whatsappUrlButton: { text: upgradeLabel, url: upgradeUrl },
  };
  if (streamHandle) await streamHandle.cancel(text, options);
  else await messagingService.sendMessage(chatId, text, options);
  return true;
}

/**
 * Where a command started from the web app answers: the chat that belongs to the
 * proved user. A DB id is never used as a chat id (for a WhatsApp-only user it used to
 * become Telegram chat <DB id>, which is someone else's chat or nobody's).
 */

import type { UserConfig } from '../types';
import { MessagingPlatform } from '../services/messaging/types';
import { getWhatsAppChatId } from '../services/user-service';
import type { AuthVia } from './api-auth';

export interface CommandTarget {
  platform: MessagingPlatform;
  chatId: number | string;
}

/**
 * - A WhatsApp session with a WhatsApp chat id answers on WhatsApp (phone, else BSUID).
 * - Otherwise, a user with a telegramId answers on Telegram.
 * - Otherwise there is no channel: null.
 *
 * `via` is how the request was proved; 'server' is the operator (CRON_SECRET) path.
 */
export function resolveCommandTarget(user: UserConfig, via: AuthVia | 'server'): CommandTarget | null {
  const whatsappChatId = getWhatsAppChatId(user);
  if (via === 'session' && whatsappChatId) {
    return { platform: MessagingPlatform.WHATSAPP, chatId: whatsappChatId };
  }
  if (user.telegramId) {
    return { platform: MessagingPlatform.TELEGRAM, chatId: Number(user.telegramId) };
  }
  return null;
}

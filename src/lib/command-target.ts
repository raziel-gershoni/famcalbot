/**
 * Where a command started from the web app answers: the chat that belongs to the
 * proved user, and how they signed in. A DB id is never used as a chat id (for a
 * WhatsApp-only user it used to become Telegram chat <DB id>, which is someone else's
 * chat or nobody's).
 */

import type { UserConfig } from '../types';
import { MessagingPlatform } from '../services/messaging/types';
import { getWhatsAppChatId } from '../services/user-service';
import type { AuthVia } from './api-auth';
import type { SignInMethod } from './session-auth';

export interface CommandTarget {
  platform: MessagingPlatform;
  chatId: number | string;
}

/**
 * Why there is no chat: 'wa_link_needed' is a WhatsApp-only account signed in another way
 * (Telegram, Google or email). WhatsApp refuses a free reply once 24 hours have passed
 * since the person's last message, so only a session opened from WhatsApp's own link
 * (which means they just wrote) may answer there. 'no_channel' is an account with neither chat.
 */
export type CommandTargetRefusal = 'wa_link_needed' | 'no_channel';

export type CommandTargetResult = { ok: true; target: CommandTarget } | { ok: false; reason: CommandTargetRefusal };

/**
 * - A 'wa' session (the WhatsApp link, and any cookie from before web sign-in) with a WhatsApp
 *   chat id answers on WhatsApp (phone, else BSUID).
 * - Otherwise, a user with a telegramId answers on Telegram: Telegram initData, an operator
 *   call, and a tg, google or email session.
 * - A tg, google or email session of a WhatsApp-only account: refused, 'wa_link_needed'.
 * - Otherwise there is no channel.
 *
 * `via` is how the request was proved ('server' is the operator, CRON_SECRET); `method` is
 * the session's sign-in method, read only for a session (absent counts as 'wa').
 */
export function resolveCommandTargetOrReason(
  user: UserConfig,
  via: AuthVia | 'server',
  method?: SignInMethod | null,
): CommandTargetResult {
  const whatsappChatId = getWhatsAppChatId(user);
  const sessionMethod = via === 'session' ? (method ?? 'wa') : null;
  if (sessionMethod === 'wa' && whatsappChatId) {
    return { ok: true, target: { platform: MessagingPlatform.WHATSAPP, chatId: whatsappChatId } };
  }
  if (user.telegramId) {
    return { ok: true, target: { platform: MessagingPlatform.TELEGRAM, chatId: Number(user.telegramId) } };
  }
  if (sessionMethod !== null && sessionMethod !== 'wa' && whatsappChatId) {
    return { ok: false, reason: 'wa_link_needed' };
  }
  return { ok: false, reason: 'no_channel' };
}

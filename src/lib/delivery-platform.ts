/**
 * Where a person's scheduled messages (the summaries) can go, from the platform they saved and the channels they have.
 *
 * User.messagingPlatform is a choice made in Settings (or set by a sign-up, a merge or an admin), and it can name a channel
 * the person does not have: a WhatsApp person saved "telegram" before they ever linked Telegram, a Telegram person an admin
 * switched to "whatsapp" whose number was later removed. Delivery that took the saved word as it stood sent nothing at
 * all. This is the one place the saved choice is narrowed to the channels that exist; every reader that picks a channel for
 * a summary asks here (summary.ts), and Settings offers only a choice the person can make.
 */

import { getWhatsAppChatId } from '../services/user-service';

/** Platform options for message delivery. */
export type DeliveryPlatform = 'telegram' | 'whatsapp' | 'all';

export interface DeliveryChannelFacts {
  messagingPlatform?: string | null;
  telegramId?: unknown;
  whatsappPhone?: string | null;
  whatsappBsuid?: string | null;
}

/** The channels the person has: a Telegram id, a WhatsApp phone or BSUID. */
export function channelsOf(user: DeliveryChannelFacts): { telegram: boolean; whatsapp: boolean } {
  return { telegram: Boolean(user.telegramId), whatsapp: getWhatsAppChatId(user) !== null };
}

/**
 * The saved choice narrowed to the channels the person has: "whatsapp" without WhatsApp but with Telegram is "telegram",
 * "telegram" without Telegram but with WhatsApp is "whatsapp", "all" is whichever exist. A person with no channel at all
 * has none: null. An unset choice reads as "telegram", as it always has.
 */
export function deliveryPlatformFor(user: DeliveryChannelFacts): DeliveryPlatform | null {
  const { telegram, whatsapp } = channelsOf(user);
  if (!telegram && !whatsapp) return null;
  const saved = user.messagingPlatform || 'telegram';
  if (saved === 'telegram') return telegram ? 'telegram' : 'whatsapp';
  if (saved === 'whatsapp') return whatsapp ? 'whatsapp' : 'telegram';
  // "all", or a word nothing writes: both when both exist
  return telegram && whatsapp ? 'all' : telegram ? 'telegram' : 'whatsapp';
}

/** Whether the person can choose this platform in Settings: they have every channel it names. */
export function platformAvailable(platform: unknown, user: DeliveryChannelFacts): boolean {
  const { telegram, whatsapp } = channelsOf(user);
  if (platform === 'telegram') return telegram;
  if (platform === 'whatsapp') return whatsapp;
  if (platform === 'all') return telegram && whatsapp;
  return false;
}

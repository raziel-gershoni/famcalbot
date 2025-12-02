/**
 * Messaging Service Factory
 * Creates platform-specific messaging adapters
 */

import TelegramBot from 'node-telegram-bot-api';
import { IMessagingService, MessagingPlatform } from './types';
import { TelegramAdapter } from './telegram-adapter';
import { WhatsAppAdapter } from './whatsapp-adapter';

/**
 * Singleton instances for each platform
 */
let telegramInstance: IMessagingService | null = null;
let whatsappInstance: IMessagingService | null = null;

/**
 * Create or get Telegram messaging service
 */
export function getTelegramService(bot: TelegramBot): IMessagingService {
  if (!telegramInstance) {
    telegramInstance = new TelegramAdapter(bot);
  }
  return telegramInstance;
}

/**
 * Create or get WhatsApp messaging service
 */
export function getWhatsAppService(): IMessagingService {
  if (!whatsappInstance) {
    const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

    if (!accessToken || !phoneNumberId) {
      throw new Error('WhatsApp credentials not configured in environment variables');
    }

    whatsappInstance = new WhatsAppAdapter(accessToken, phoneNumberId);
  }
  return whatsappInstance;
}

/**
 * Get messaging service by platform
 */
export function getMessagingService(
  platform: MessagingPlatform,
  bot?: TelegramBot
): IMessagingService {
  switch (platform) {
    case MessagingPlatform.TELEGRAM:
      if (!bot) {
        throw new Error('Telegram bot instance required for Telegram adapter');
      }
      return getTelegramService(bot);

    case MessagingPlatform.WHATSAPP:
      return getWhatsAppService();

    default:
      throw new Error(`Unsupported messaging platform: ${platform}`);
  }
}

/**
 * Detect platform from webhook request
 */
export function detectPlatform(req: any): MessagingPlatform {
  // Telegram webhook has 'message' or 'callback_query' at root
  if (req.body?.message || req.body?.callback_query) {
    return MessagingPlatform.TELEGRAM;
  }

  // WhatsApp webhook has 'entry' array with 'changes'
  if (req.body?.entry?.[0]?.changes) {
    return MessagingPlatform.WHATSAPP;
  }

  // Default to Telegram for backwards compatibility
  return MessagingPlatform.TELEGRAM;
}

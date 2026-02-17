import TelegramBot from 'node-telegram-bot-api';
import { IMessagingService, getTelegramService } from '../messaging';
import { getBotMessages } from '../../lib/bot-messages';
import { buildUrl } from '../../config/urls';

let bot: TelegramBot | null = null;
let messagingService: IMessagingService | null = null;

/**
 * Initialize the Telegram bot
 * In development: uses polling mode
 * In production: uses webhook mode (no polling)
 */
export function initBot(): TelegramBot {
  if (bot) {
    return bot;
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN is not set');
  }

  const isDevelopment = process.env.NODE_ENV === 'development';

  if (isDevelopment) {
    // Development mode: use polling
    bot = new TelegramBot(token, { polling: true });
    // Import setupHandlers lazily to avoid circular dependency
    import('./commands').then(({ setupHandlers }) => {
      setupHandlers(bot!);
    });
    console.log('🤖 Telegram bot initialized in POLLING mode (development)');
  } else {
    // Production mode: no polling (webhook-based)
    bot = new TelegramBot(token);
    console.log('🤖 Telegram bot initialized in WEBHOOK mode (production)');
  }

  return bot;
}

/**
 * Set per-user menu button with localized text
 * Opens the dashboard webapp in the user's preferred language
 */
export async function setUserMenuButton(userId: number, locale: string): Promise<void> {
  const botInstance = getBot();

  try {
    const messages = await getBotMessages(locale);
    const text = messages.menuButton.open;
    const url = buildUrl(`/${locale}/dashboard?user_id=${userId}`);

    const menuButtonJson = JSON.stringify({
      type: 'web_app',
      text: text,
      web_app: { url }
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (botInstance as any).setChatMenuButton({
      chat_id: userId,
      menu_button: menuButtonJson
    });
    console.log(`✅ Menu button set for user ${userId} (${locale})`);
  } catch (error) {
    console.error(`❌ Failed to set menu button for user ${userId}:`, error);
  }
}

/**
 * Get or create bot instance (without polling for serverless)
 */
export function getBot(): TelegramBot {
  if (bot) {
    return bot;
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN is not set');
  }

  bot = new TelegramBot(token);
  return bot;
}

/**
 * Get or create messaging service instance
 */
export function getMessagingService(): IMessagingService {
  if (!messagingService) {
    const botInstance = getBot();
    messagingService = getTelegramService(botInstance);
  }
  return messagingService;
}

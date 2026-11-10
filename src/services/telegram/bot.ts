import { Api } from 'node-telegram-bot-api';
import { IMessagingService, getTelegramService } from '../messaging';
import { getBotMessages } from '../../lib/bot-messages';
import { buildUrl } from '../../config/urls';

let bot: Api | null = null;
let messagingService: IMessagingService | null = null;

/**
 * The one Bot API client's options. The library's own retries would send a message twice when an answer is lost, and
 * its 5-minute timeout would be one of our own: both off (CLAUDE.md, the third-party retry rule).
 */
export const TELEGRAM_API_OPTIONS = { maxRetries: 0, timeoutMs: 0 } as const;

/**
 * Set per-user menu button with localized text. Opens the dashboard webapp
 * in the user's preferred language.
 *
 * Android Telegram requires this to actually succeed for the button to
 * render — there's no fallback rendering like iOS has when the call fails.
 * Errors used to be swallowed with console.error only; now they're routed
 * to Sentry via captureError so silent regressions become visible.
 */
export async function setUserMenuButton(userId: number, locale: string): Promise<void> {
  const botInstance = getBot();

  try {
    const messages = await getBotMessages(locale);
    const text = messages.menuButton.open;
    const url = buildUrl(`/${locale}/dashboard?user_id=${userId}`);

    await botInstance.setChatMenuButton({
      chat_id: userId,
      menu_button: { type: 'web_app', text, web_app: { url } },
    });
    console.log(`✅ Menu button set for user ${userId} (${locale})`);
  } catch (error) {
    console.error(`❌ Failed to set menu button for user ${userId}:`, error);
    const { captureError } = await import('../../lib/error-capture');
    captureError(error, 'set-menu-button-per-user', { user_id: userId, locale }, 'warning');
  }
}

/** The Bot API client (webhook mode: Telegram's updates come to app/api/webhook, never by polling). */
export function getBot(): Api {
  if (bot) {
    return bot;
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN is not set');
  }

  bot = new Api(token, TELEGRAM_API_OPTIONS);
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

/**
 * Error Notification Utility
 * Sends critical errors to admin via Telegram
 */

import { getBot } from '../services/telegram';
import { ADMIN_USER_ID } from '../config/constants';

/**
 * Notify admin of a critical error via Telegram
 * @param context - Where the error occurred (e.g., "Webhook Handler", "Daily Summary Cron")
 * @param error - The error object or message
 * @param additionalInfo - Optional additional context
 */
export async function notifyAdminError(
  context: string,
  error: unknown,
  additionalInfo?: string
): Promise<void> {
  try {
    const bot = getBot();
    const errorMessage = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;

    let message = `🚨 <b>Error in ${context}</b>\n\n`;
    message += `<b>Error:</b> ${errorMessage}\n`;

    if (additionalInfo) {
      message += `\n<b>Context:</b> ${additionalInfo}\n`;
    }

    if (stack) {
      // Only include first 3 lines of stack trace to avoid message length issues
      const stackLines = stack.split('\n').slice(0, 3).join('\n');
      message += `\n<code>${stackLines}</code>`;
    }

    message += `\n\n<i>Time: ${new Date().toISOString()}</i>`;

    await bot.sendMessage(ADMIN_USER_ID, message, { parse_mode: 'HTML' });
  } catch (notificationError) {
    // If notification fails, at least log it
    console.error('Failed to send error notification to admin:', notificationError);
    console.error('Original error:', error);
  }
}

/**
 * Notify admin of a warning (non-critical)
 */
export async function notifyAdminWarning(context: string, message: string): Promise<void> {
  try {
    const bot = getBot();
    const warningMessage = `⚠️ <b>Warning: ${context}</b>\n\n${message}\n\n<i>Time: ${new Date().toISOString()}</i>`;
    await bot.sendMessage(ADMIN_USER_ID, warningMessage, { parse_mode: 'HTML' });
  } catch (error) {
    console.error('Failed to send warning notification:', error);
  }
}

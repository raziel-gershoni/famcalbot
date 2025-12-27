/**
 * Progress Message Service
 * Provides animated "working" messages that cycle dots
 * Example: "⏳ Generating your summary." → "⏳ Generating your summary.." → "..."
 */

import { IMessagingService } from './messaging/types';

export type ProgressType = 'summary' | 'summaryTomorrow' | 'weather' | 'voice';

/**
 * Progress text translations
 */
const PROGRESS_TEXTS: Record<string, Record<ProgressType, string>> = {
  en: {
    summary: 'Generating your summary',
    summaryTomorrow: "Generating tomorrow's summary",
    weather: 'Fetching weather forecast',
    voice: 'Generating voice message',
  },
  he: {
    summary: 'מכין את הסיכום שלך',
    summaryTomorrow: 'מכין את סיכום המחר',
    weather: 'מביא את תחזית מזג האוויר',
    voice: 'מכין הודעה קולית',
  },
  ru: {
    summary: 'Создаю сводку',
    summaryTomorrow: 'Создаю сводку на завтра',
    weather: 'Получаю прогноз погоды',
    voice: 'Создаю голосовое сообщение',
  },
};

/**
 * Get localized progress text
 */
export function getProgressText(type: ProgressType, language: string = 'en'): string {
  const texts = PROGRESS_TEXTS[language] || PROGRESS_TEXTS.en;
  return texts[type] || texts.summary;
}

/**
 * Format progress message with emoji and dots
 */
export function formatProgressMessage(baseText: string, dotCount: number = 1): string {
  const dots = '.'.repeat(dotCount);
  return `⏳ ${baseText}${dots}`;
}

/**
 * Start progress animation that cycles dots
 * Returns a cleanup function to stop the animation
 *
 * @param chatId - Chat to send progress to
 * @param messageId - Message ID to update
 * @param baseText - Base progress text (without dots)
 * @param service - Messaging service to use for updates
 * @param intervalMs - Interval between dot updates (default 800ms)
 * @returns Cleanup function to stop the animation
 */
export function startProgressAnimation(
  chatId: number | string,
  messageId: number | string,
  baseText: string,
  service: IMessagingService,
  intervalMs: number = 800
): () => void {
  let dotCount = 1;
  let isRunning = true;

  const interval = setInterval(async () => {
    if (!isRunning) return;

    dotCount = (dotCount % 3) + 1;
    const progressText = formatProgressMessage(baseText, dotCount);

    try {
      await service.updateMessage(chatId, messageId, progressText);
    } catch (error) {
      // Stop animation if update fails
      isRunning = false;
      clearInterval(interval);
    }
  }, intervalMs);

  // Return cleanup function
  return () => {
    isRunning = false;
    clearInterval(interval);
  };
}

/**
 * Send initial progress message and start animation
 * Returns messageId and cleanup function
 */
export async function sendProgressWithAnimation(
  chatId: number | string,
  type: ProgressType,
  language: string,
  service: IMessagingService
): Promise<{ messageId: number | string; stopAnimation: () => void }> {
  const baseText = getProgressText(type, language);
  const initialMessage = formatProgressMessage(baseText, 1);

  const messageId = await service.sendMessage(chatId, initialMessage);
  const stopAnimation = startProgressAnimation(chatId, messageId, baseText, service);

  return { messageId, stopAnimation };
}

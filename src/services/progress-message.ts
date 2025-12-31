/**
 * Progress Message Service
 * Provides animated "working" messages that cycle dots
 * Example: "⏳ Generating your summary." → "⏳ Generating your summary.." → "..."
 */

import { IMessagingService } from './messaging/types';

export type ProgressType = 'summary' | 'summaryTomorrow' | 'weather' | 'voice' | 'lookahead';

/**
 * Progress text translations
 */
const PROGRESS_TEXTS: Record<string, Record<ProgressType, string>> = {
  en: {
    summary: 'Generating your summary',
    summaryTomorrow: "Generating tomorrow's summary",
    weather: 'Fetching weather forecast',
    voice: 'Generating voice message',
    lookahead: 'Scanning upcoming events',
  },
  he: {
    summary: 'מכין את הסיכום שלך',
    summaryTomorrow: 'מכין את סיכום המחר',
    weather: 'מביא את תחזית מזג האוויר',
    voice: 'מכין הודעה קולית',
    lookahead: 'סורק אירועים קרובים',
  },
  ru: {
    summary: 'Создаю сводку',
    summaryTomorrow: 'Создаю сводку на завтра',
    weather: 'Получаю прогноз погоды',
    voice: 'Создаю голосовое сообщение',
    lookahead: 'Сканирую предстоящие события',
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
 * Braille spinner frames (10 frames) - smooth rotating effect
 */
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * Format progress message with spinning braille and static dots
 */
export function formatProgressMessage(baseText: string, frame: number = 0): string {
  const spinner = SPINNER_FRAMES[frame % 10];
  return `${spinner} ${baseText}...`;
}

/**
 * Start progress animation with spinning braille
 * Returns a cleanup function to stop the animation
 *
 * @param chatId - Chat to send progress to
 * @param messageId - Message ID to update
 * @param baseText - Base progress text (without dots)
 * @param service - Messaging service to use for updates
 * @param intervalMs - Interval between frame updates (default 300ms)
 * @returns Cleanup function to stop the animation
 */
export function startProgressAnimation(
  chatId: number | string,
  messageId: number | string,
  baseText: string,
  service: IMessagingService,
  intervalMs: number = 300
): () => void {
  let frame = 1;
  let isRunning = true;

  const interval = setInterval(async () => {
    if (!isRunning) return;

    frame++;
    const progressText = formatProgressMessage(baseText, frame);

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

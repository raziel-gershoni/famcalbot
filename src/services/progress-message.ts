/**
 * Progress Message Service
 * Sends a static animated-emoji progress message (no edit loop).
 * Uses Telegram's custom emoji tag which animates client-side.
 */

import { IMessagingService, MessageFormat } from './messaging/types';

export type ProgressType = 'summary' | 'summaryTomorrow' | 'weather' | 'voice' | 'lookahead' | 'nextweek';

/**
 * Animated emoji ID for the progress spinner.
 * Set to empty string to fall back to static Unicode hourglass.
 * To discover the ID: send an animated hourglass emoji in Telegram,
 * then use the /emojiid command to extract it.
 */
export const ANIMATED_HOURGLASS_EMOJI_ID = '5451732530048802485';

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
    nextweek: 'Scanning next week',
  },
  he: {
    summary: 'מכין את הסיכום שלך',
    summaryTomorrow: 'מכין את סיכום המחר',
    weather: 'מביא את תחזית מזג האוויר',
    voice: 'מכין הודעה קולית',
    lookahead: 'סורק אירועים קרובים',
    nextweek: 'סורק את השבוע הבא',
  },
  ru: {
    summary: 'Создаю сводку',
    summaryTomorrow: 'Создаю сводку на завтра',
    weather: 'Получаю прогноз погоды',
    voice: 'Создаю голосовое сообщение',
    lookahead: 'Сканирую предстоящие события',
    nextweek: 'Сканирую следующую неделю',
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
 * Build the animated-emoji progress message HTML.
 * Premium users see the animated custom emoji; others see a static hourglass.
 */
export function buildProgressHtml(text: string): string {
  if (ANIMATED_HOURGLASS_EMOJI_ID) {
    return `<tg-emoji emoji-id="${ANIMATED_HOURGLASS_EMOJI_ID}">\u231B</tg-emoji> ${text}...`;
  }
  return `\u231B ${text}...`;
}

/**
 * Send a static animated-emoji progress message (no edit loop).
 * Uses Telegram's custom emoji tag which animates client-side.
 * Returns just the messageId — caller deletes or edits it when done.
 */
export async function sendAnimatedProgress(
  chatId: number | string,
  type: ProgressType,
  language: string,
  service: IMessagingService
): Promise<number | string> {
  const baseText = getProgressText(type, language);
  const html = buildProgressHtml(baseText);
  return service.sendMessage(chatId, html, { format: MessageFormat.HTML });
}

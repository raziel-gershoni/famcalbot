/**
 * Centralized UI label translations
 * Used for inline keyboard buttons and CTA text across the app
 */

export const SHARE_STORY_LABELS: Record<string, string> = {
  he: 'שתף לסטורי',
  ru: 'В историю',
  en: 'Share to Story',
};

export const TELEGRAM_CTA_LABELS: Record<string, string> = {
  he: 'פתח בטלגרם',
  ru: 'Открыть в Telegram',
  en: 'Open in Telegram',
};

export function getLabel(labels: Record<string, string>, language: string): string {
  return labels[language] || labels.en;
}

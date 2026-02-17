/**
 * Bot Messages Loader
 * Loads localized bot messages from the shared messages/*.json files
 */

import { VALID_LOCALES, Locale } from '../utils/locale';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MessageTree = Record<string, any>;

// Cache for loaded messages to avoid repeated imports
const messageCache: Record<string, MessageTree> = {};
const subscriptionMessageCache: Record<string, MessageTree> = {};

/**
 * Get bot messages for a specific locale
 * Falls back to English if locale is not supported
 */
export async function getBotMessages(locale: string) {
  const normalizedLocale: Locale = VALID_LOCALES.includes(locale as Locale)
    ? (locale as Locale)
    : 'en';

  if (!messageCache[normalizedLocale]) {
    const messages = await import(`../../messages/${normalizedLocale}.json`);
    messageCache[normalizedLocale] = messages.default.bot;
  }

  return messageCache[normalizedLocale];
}

/**
 * Get subscription messages for a specific locale
 * Falls back to English if locale is not supported
 */
export async function getSubscriptionMessages(locale: string) {
  const normalizedLocale: Locale = VALID_LOCALES.includes(locale as Locale)
    ? (locale as Locale)
    : 'en';

  if (!subscriptionMessageCache[normalizedLocale]) {
    const messages = await import(`../../messages/${normalizedLocale}.json`);
    subscriptionMessageCache[normalizedLocale] = messages.default.subscription;
  }

  return subscriptionMessageCache[normalizedLocale];
}

/**
 * Get a specific bot message with optional interpolation
 * @param locale - User's locale
 * @param keyPath - Dot-notation path to the message (e.g., 'start.welcome')
 * @param params - Optional parameters for interpolation (e.g., {name: 'John'})
 */
export async function getBotMessage(
  locale: string,
  keyPath: string,
  params?: Record<string, string>
): Promise<string> {
  const messages = await getBotMessages(locale);

  // Navigate to the message using dot notation
  const keys = keyPath.split('.');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let current: any = messages;

  for (const key of keys) {
    current = current?.[key];
    if (current === undefined) {
      console.warn(`[bot-messages] Missing key: bot.${keyPath} for locale: ${locale}`);
      return keyPath; // Return the key as fallback
    }
  }

  // Interpolate parameters if provided
  if (params && typeof current === 'string') {
    return current.replace(/\{(\w+)\}/g, (_, key) => params[key] || `{${key}}`);
  }

  return current;
}

/**
 * Preload messages for a locale (useful for warming the cache)
 */
export async function preloadBotMessages(locale: string): Promise<void> {
  await getBotMessages(locale);
}

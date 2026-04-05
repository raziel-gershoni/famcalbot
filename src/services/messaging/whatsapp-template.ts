/**
 * WhatsApp Template Message Builder
 * Templates with quick reply buttons for proactive sends.
 * User taps button → opens service window → we send full content as free-form.
 */

import { WhatsAppTemplate } from './types';

const TEMPLATE_PREFIX = 'famcal_notify';
const SUPPORTED_LANGUAGES = ['en', 'he', 'ru'];

/**
 * Build a WhatsApp template for a proactive message.
 * When buttonPayload is set, the template's quick reply button will carry
 * that payload, which maps to an existing command (e.g. "summary", "weather").
 */
export function buildWhatsAppTemplate(language: string, buttonPayload?: string): WhatsAppTemplate {
  const lang = SUPPORTED_LANGUAGES.includes(language) ? language : 'en';
  return {
    name: `${TEMPLATE_PREFIX}_${lang}`,
    language: lang,
    ...(buttonPayload && { buttonPayload }),
  };
}

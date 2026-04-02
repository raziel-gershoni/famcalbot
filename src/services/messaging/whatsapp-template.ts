/**
 * WhatsApp Template Message Builder
 * Wraps any proactive message in the approved famcal_update template
 * so it delivers outside the 24h messaging window.
 */

import { WhatsAppTemplate } from './types';

const TEMPLATE_PREFIX = 'famcal_update';
const SUPPORTED_LANGUAGES = ['en', 'he', 'ru'];

/**
 * Build WhatsApp template options for a proactive message.
 * Uses famcal_update_{lang} template with {{1}}=content, {{2}}=settingsUrl.
 */
export function buildWhatsAppTemplate(
  content: string,
  language: string,
  settingsUrl: string
): WhatsAppTemplate {
  const lang = SUPPORTED_LANGUAGES.includes(language) ? language : 'en';
  return {
    name: `${TEMPLATE_PREFIX}_${lang}`,
    language: lang,
    bodyParams: [content, settingsUrl],
  };
}

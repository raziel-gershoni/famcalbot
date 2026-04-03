/**
 * WhatsApp Template Message Builder
 * Parameter-free marketing templates act as "door openers" to start a
 * business-initiated conversation window. Actual content follows as free-form text.
 */

import { WhatsAppTemplate } from './types';

const TEMPLATE_PREFIX = 'famcal_notify';
const SUPPORTED_LANGUAGES = ['en', 'he', 'ru'];

/**
 * Build a WhatsApp door-opener template for a proactive message.
 * The template itself has no parameters — it just opens the 24h conversation window.
 */
export function buildWhatsAppTemplate(language: string): WhatsAppTemplate {
  const lang = SUPPORTED_LANGUAGES.includes(language) ? language : 'en';
  return {
    name: `${TEMPLATE_PREFIX}_${lang}`,
    language: lang,
  };
}

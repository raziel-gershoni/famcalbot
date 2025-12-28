/**
 * Voice Condenser Prompts - Per-Language
 *
 * Each language has its own prompt file with native instructions
 * for more natural-sounding voice output.
 */

import { buildVoiceCondenserPrompt as buildEnglishPrompt } from './en';
import { buildVoiceCondenserPrompt as buildHebrewPrompt } from './he';
import { buildVoiceCondenserPrompt as buildRussianPrompt } from './ru';

type PromptBuilder = (fullSummary: string) => string;

const promptBuilders: Record<string, PromptBuilder> = {
  en: buildEnglishPrompt,
  he: buildHebrewPrompt,
  ru: buildRussianPrompt,
};

/**
 * Get the appropriate prompt builder for a given locale
 * Falls back to English if locale is not supported
 */
export function getPromptForLocale(locale: string): PromptBuilder {
  return promptBuilders[locale] || promptBuilders.en;
}

/**
 * Build a voice condenser prompt for a given locale
 */
export function buildVoiceCondenserPrompt(fullSummary: string, locale: string = 'en'): string {
  const builder = getPromptForLocale(locale);
  return builder(fullSummary);
}

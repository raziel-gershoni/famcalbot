/**
 * Voice Condenser Prompts - Per-Language
 *
 * Each language has its own prompt file with native instructions
 * for more natural-sounding voice output.
 */

import { buildVoiceCondenserPrompt as buildEnglishPrompt } from './en';
import { buildVoiceCondenserPrompt as buildHebrewPrompt } from './he';
import { buildVoiceCondenserPrompt as buildRussianPrompt } from './ru';
import { buildWeeklyVoiceCondenserPrompt as buildWeeklyEnglishPrompt } from './week-en';
import { buildWeeklyVoiceCondenserPrompt as buildWeeklyHebrewPrompt } from './week-he';
import { buildWeeklyVoiceCondenserPrompt as buildWeeklyRussianPrompt } from './week-ru';
import { VoiceCondenserContext } from './types';

export type { VoiceCondenserContext } from './types';

type PromptBuilder = (context: VoiceCondenserContext) => string;

const promptBuilders: Record<string, PromptBuilder> = {
  en: buildEnglishPrompt,
  he: buildHebrewPrompt,
  ru: buildRussianPrompt,
};

const weeklyPromptBuilders: Record<string, PromptBuilder> = {
  en: buildWeeklyEnglishPrompt,
  he: buildWeeklyHebrewPrompt,
  ru: buildWeeklyRussianPrompt,
};

/**
 * Get the appropriate prompt builder for a given locale
 * Falls back to English if locale is not supported
 */
export function getPromptForLocale(locale: string): PromptBuilder {
  return promptBuilders[locale] || promptBuilders.en;
}

/**
 * Get the appropriate weekly prompt builder for a given locale
 * Falls back to English if locale is not supported
 */
export function getWeeklyPromptForLocale(locale: string): PromptBuilder {
  return weeklyPromptBuilders[locale] || weeklyPromptBuilders.en;
}

/**
 * Build a voice condenser prompt for a given locale
 * @param context - Full context including summary, family structure, and preferences
 */
export function buildVoiceCondenserPrompt(context: VoiceCondenserContext): string {
  const builder = getPromptForLocale(context.locale);
  return builder(context);
}

/**
 * Build a weekly voice condenser prompt for a given locale
 * @param context - Full context including summary, family structure, and preferences
 */
export function buildWeeklyVoiceCondenserPrompt(context: VoiceCondenserContext): string {
  const builder = getWeeklyPromptForLocale(context.locale);
  return builder(context);
}

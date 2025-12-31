/**
 * Week Lookahead Prompts - Per-Language
 *
 * Each language has its own prompt file with native instructions
 * so that user rules written in their native language are understood naturally.
 */

export type { WeekLookaheadPromptData, LookaheadEventData, LookaheadDayData } from './types';

import { WeekLookaheadPromptData } from './types';
import { buildWeekLookaheadPrompt as buildEnglishPrompt } from './en';
import { buildWeekLookaheadPrompt as buildHebrewPrompt } from './he';
import { buildWeekLookaheadPrompt as buildRussianPrompt } from './ru';

type PromptBuilder = (data: WeekLookaheadPromptData) => string;

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
 * Build a week lookahead prompt for a given locale
 */
export function buildWeekLookaheadPrompt(data: WeekLookaheadPromptData): string {
  const locale = data.language || 'en';
  const builder = getPromptForLocale(locale);
  return builder(data);
}

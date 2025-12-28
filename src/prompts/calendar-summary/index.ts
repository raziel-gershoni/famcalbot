/**
 * Calendar Summary Prompts - Per-Language
 *
 * Each language has its own prompt file with native instructions
 * so that user rules written in their native language are understood naturally.
 */

export type { SummaryPromptData } from './types';

import { SummaryPromptData } from './types';
import { buildCalendarSummaryPrompt as buildEnglishPrompt } from './en';
import { buildCalendarSummaryPrompt as buildHebrewPrompt } from './he';
import { buildCalendarSummaryPrompt as buildRussianPrompt } from './ru';

type PromptBuilder = (data: SummaryPromptData) => string;

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
 * Build a calendar summary prompt for a given locale
 */
export function buildCalendarSummaryPrompt(data: SummaryPromptData): string {
  const locale = data.language || 'en';
  const builder = getPromptForLocale(locale);
  return builder(data);
}

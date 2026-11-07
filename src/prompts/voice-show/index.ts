/**
 * Voice-note writer prompts, per language: the two-host show, and the calm single voice (format 'calm'). A language
 * gets the show only when it has a prompt here and host voices in voice-generator's table; calm has a prompt in
 * every show language.
 */

import { buildCalmPrompt as buildEnglishCalmPrompt } from './calm-en';
import { buildCalmPrompt as buildHebrewCalmPrompt } from './calm-he';
import { buildCalmPrompt as buildRussianCalmPrompt } from './calm-ru';
import { buildShowPrompt as buildEnglishShowPrompt } from './en';
import { buildShowPrompt as buildHebrewShowPrompt } from './he';
import { buildShowPrompt as buildRussianShowPrompt } from './ru';
import type { ShowPromptContext } from './types';

export type { ShowPromptContext, ShowPerson } from './types';

const builders: Record<string, (context: ShowPromptContext) => string> = {
  en: buildEnglishShowPrompt,
  he: buildHebrewShowPrompt,
  ru: buildRussianShowPrompt,
};

const calmBuilders: Record<string, (context: ShowPromptContext) => string> = {
  en: buildEnglishCalmPrompt,
  he: buildHebrewCalmPrompt,
  ru: buildRussianCalmPrompt,
};

export function hasShowPrompt(locale: string): boolean {
  return Object.hasOwn(builders, locale);
}

export function hasCalmPrompt(locale: string): boolean {
  return Object.hasOwn(calmBuilders, locale);
}

/** The writer's prompt: calm's for format 'calm', else the show's. */
export function buildShowPrompt(context: ShowPromptContext): string {
  if (!hasShowPrompt(context.locale)) throw new Error(`No show prompt for locale "${context.locale}"`);
  if (context.format === 'calm') {
    if (!hasCalmPrompt(context.locale)) throw new Error(`No calm prompt for locale "${context.locale}"`);
    return calmBuilders[context.locale](context);
  }
  return builders[context.locale](context);
}

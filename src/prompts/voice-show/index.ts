/**
 * Two-host show prompts, per language. A language gets the show only when it has a
 * prompt here and host voices in voice-generator's table.
 */

import { buildShowPrompt as buildHebrewShowPrompt } from './he';
import type { ShowPromptContext } from './types';

export type { ShowPromptContext, ShowPerson } from './types';

const builders: Record<string, (context: ShowPromptContext) => string> = {
  he: buildHebrewShowPrompt,
};

export function hasShowPrompt(locale: string): boolean {
  return Object.hasOwn(builders, locale);
}

export function buildShowPrompt(context: ShowPromptContext): string {
  if (!hasShowPrompt(context.locale)) throw new Error(`No show prompt for locale "${context.locale}"`);
  return builders[context.locale](context);
}

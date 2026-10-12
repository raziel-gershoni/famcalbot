/**
 * Writes the show script: one LLM call through generateAICompletion (the admin's
 * default model) in JSON mode, then ./script's validator. A rejected answer is
 * regenerated once with the reason attached; a second rejection throws, and the caller
 * takes the "voice unavailable" path.
 */

import type { AICompletionOptions, AICompletionResult } from '../ai-provider';
import { buildShowPrompt } from '../../prompts/voice-show';
import type { ShowPromptContext } from '../../prompts/voice-show/types';
import { parseShowScript, ShowScriptError, SHOW_RESPONSE_SCHEMA } from './script';
import type { ShowScript } from './types';

export type CompletionFn = (prompt: string, modelId?: string, options?: AICompletionOptions) => Promise<AICompletionResult>;

export interface WrittenShow {
  script: ShowScript;
  /** The completion that produced the accepted script. */
  completion: AICompletionResult;
  attempts: number;
}

export interface WriteShowOptions {
  /** Defaults to generateAICompletion. Tests inject a fake. */
  complete?: CompletionFn;
  /** Overrides the admin default model. Used by the eval script. */
  modelId?: string;
}

const MAX_ATTEMPTS = 2;

export async function writeShowScript(context: ShowPromptContext, options: WriteShowOptions = {}): Promise<WrittenShow> {
  // Imported lazily so the prompt and validator stay loadable without the SDKs.
  const complete = options.complete ?? (await import('../ai-provider')).generateAICompletion;
  const prompt = buildShowPrompt(context);
  let rejection: ShowScriptError | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const request = rejection
      ? `${prompt}\n\nYour previous answer was rejected: ${rejection.message}. Answer again with valid JSON that follows every rule above.`
      : prompt;
    const completion = await complete(request, options.modelId, { responseJsonSchema: SHOW_RESPONSE_SCHEMA });
    try {
      return { script: parseShowScript(completion.text), completion, attempts: attempt };
    } catch (error) {
      if (!(error instanceof ShowScriptError)) throw error;
      console.warn(`[VoiceShow] Script rejected (attempt ${attempt}/${MAX_ATTEMPTS}): ${error.message}`);
      rejection = error;
    }
  }
  throw rejection!;
}

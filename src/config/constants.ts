/**
 * Application-wide constants
 */

import { getModelConfig, AI_MODEL } from './ai-models';

export const TIMEZONE = 'Asia/Jerusalem';

export { AI_MODEL };

// Retry configuration (static)
// MAX_RETRIES=1 means 2 total attempts (initial + 1 retry).
// SDK-level retries are disabled (maxRetries:0), so this is the only retry layer.
export const AI_RETRY_CONFIG = {
  MAX_RETRIES: parseInt(process.env.AI_MAX_RETRIES || '1', 10),
  INITIAL_RETRY_DELAY: 1000, // 1 second, will exponentially backoff
} as const;

/**
 * AI configuration. Everything runs on AI_MODEL; the optional id is for scripts that
 * compare a candidate model (the live eval's --model). An unknown id falls back to
 * AI_MODEL with a warning rather than taking the request down.
 */
export function getAIConfig(modelId?: string) {
  let selectedModelId = modelId || AI_MODEL;
  let modelConfig = getModelConfig(selectedModelId);

  if (!modelConfig) {
    console.warn(`[ai-config] Unknown AI model "${selectedModelId}" - using "${AI_MODEL}".`);
    selectedModelId = AI_MODEL;
    modelConfig = getModelConfig(AI_MODEL);
  }

  if (!modelConfig) {
    throw new Error(`AI_MODEL "${AI_MODEL}" is missing from AI_MODELS. This is a build-time bug.`);
  }

  return {
    MODEL_ID: selectedModelId,
    MODEL_CONFIG: modelConfig,
    MAX_TOKENS: process.env.AI_MAX_TOKENS
      ? parseInt(process.env.AI_MAX_TOKENS, 10)
      : modelConfig.maxOutputTokens, // Use maximum available tokens for each model
  };
}

// Default AI configuration (for backwards compatibility)
export const AI_CONFIG = getAIConfig();

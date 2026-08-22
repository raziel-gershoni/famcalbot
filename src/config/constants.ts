/**
 * Application-wide constants
 */

import { getModelConfig, ModelConfig, FALLBACK_AI_MODEL } from './ai-models';

export const TIMEZONE = 'Asia/Jerusalem';

export { FALLBACK_AI_MODEL };

// Default AI model from environment
export const DEFAULT_AI_MODEL = process.env.AI_MODEL || FALLBACK_AI_MODEL;

// Retry configuration (static)
// MAX_RETRIES=1 means 2 total attempts (initial + 1 retry).
// SDK-level retries are disabled (maxRetries:0), so this is the only retry layer.
export const AI_RETRY_CONFIG = {
  MAX_RETRIES: parseInt(process.env.AI_MAX_RETRIES || '1', 10),
  INITIAL_RETRY_DELAY: 1000, // 1 second, will exponentially backoff
} as const;

/**
 * Get AI configuration for a specific model
 * @param modelId - Model identifier (e.g., 'gemini-3.7-flash')
 * @returns AI configuration object
 */
export function getAIConfig(modelId?: string) {
  let selectedModelId = modelId || DEFAULT_AI_MODEL;
  let modelConfig = getModelConfig(selectedModelId);

  // Degrade instead of throwing. The identifier can come from AdminSettings or the
  // AI_MODEL env var, neither of which is validated against the catalog at write
  // time, and AI_CONFIG below is evaluated at import — so a stale value here would
  // take the whole app down rather than one request.
  if (!modelConfig) {
    console.warn(
      `[ai-config] Unknown AI model "${selectedModelId}" — falling back to "${FALLBACK_AI_MODEL}". ` +
        'Check src/config/ai-models.ts for available models.'
    );
    selectedModelId = FALLBACK_AI_MODEL;
    modelConfig = getModelConfig(FALLBACK_AI_MODEL);
  }

  if (!modelConfig) {
    throw new Error(
      `FALLBACK_AI_MODEL "${FALLBACK_AI_MODEL}" is missing from AI_MODELS. This is a build-time bug.`
    );
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

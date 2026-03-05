/**
 * Application-wide constants
 */

import { getModelConfig, ModelConfig } from './ai-models';

export const TIMEZONE = 'Asia/Jerusalem';

// Default AI model from environment
export const DEFAULT_AI_MODEL = process.env.AI_MODEL || 'gemini-3.1-flash-lite';

// Retry configuration (static)
// MAX_RETRIES=1 means 2 total attempts (initial + 1 retry).
// SDK-level retries are disabled (maxRetries:0), so this is the only retry layer.
export const AI_RETRY_CONFIG = {
  MAX_RETRIES: parseInt(process.env.AI_MAX_RETRIES || '1', 10),
  INITIAL_RETRY_DELAY: 1000, // 1 second, will exponentially backoff
} as const;

/**
 * Get AI configuration for a specific model
 * @param modelId - Model identifier (e.g., 'claude-sonnet-4.5')
 * @returns AI configuration object
 */
export function getAIConfig(modelId?: string) {
  const selectedModelId = modelId || DEFAULT_AI_MODEL;
  const modelConfig = getModelConfig(selectedModelId);

  if (!modelConfig) {
    throw new Error(
      `Invalid AI_MODEL: "${selectedModelId}". Check src/config/ai-models.ts for available models.`
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

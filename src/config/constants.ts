/**
 * Application-wide constants
 */

import { getModelConfig, ModelConfig } from './ai-models';

export const TIMEZONE = 'Asia/Jerusalem';
export const ADMIN_USER_ID = 762715667; // Raziel's Telegram ID for system alerts

// Default AI model from environment
export const DEFAULT_AI_MODEL = process.env.AI_MODEL || 'claude-sonnet-4.5';

// Retry configuration (static)
export const AI_RETRY_CONFIG = {
  MAX_RETRIES: parseInt(process.env.AI_MAX_RETRIES || '3', 10),
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
      : Math.min(modelConfig.maxOutputTokens, 2000),
  };
}

// Default AI configuration (for backwards compatibility)
export const AI_CONFIG = getAIConfig();

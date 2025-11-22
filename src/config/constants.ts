/**
 * Application-wide constants
 */

import { getModelConfig } from './ai-models';

export const TIMEZONE = 'Asia/Jerusalem';
export const ADMIN_USER_ID = 762715667; // Raziel's Telegram ID for system alerts

// AI Configuration
const AI_MODEL_ID = process.env.AI_MODEL || 'claude-sonnet-4.5';
const modelConfig = getModelConfig(AI_MODEL_ID);

if (!modelConfig) {
  throw new Error(
    `Invalid AI_MODEL: "${AI_MODEL_ID}". Check src/config/ai-models.ts for available models.`
  );
}

export const AI_CONFIG = {
  // Model selection
  MODEL_ID: AI_MODEL_ID,
  MODEL_CONFIG: modelConfig,

  // Token configuration (with environment override)
  MAX_TOKENS: process.env.AI_MAX_TOKENS
    ? parseInt(process.env.AI_MAX_TOKENS, 10)
    : Math.min(modelConfig.maxOutputTokens, 2000), // Default to 2000 or model max, whichever is lower

  // Retry configuration
  MAX_RETRIES: parseInt(process.env.AI_MAX_RETRIES || '3', 10),
  INITIAL_RETRY_DELAY: 1000, // 1 second, will exponentially backoff
} as const;

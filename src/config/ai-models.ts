/**
 * AI Model Catalog
 * Updated: 2025-11-23
 *
 * Defines available AI models with their specifications.
 * Use simple identifiers (e.g., 'claude-sonnet-4.5') in environment variables.
 */

export interface ModelConfig {
  provider: 'claude' | 'openai';
  modelId: string;
  displayName: string;
  maxOutputTokens: number;
  contextWindow: number;
  costPer1MTokens: { input: number; output: number }; // USD
  description: string;
}

/**
 * Available AI models catalog
 * Key: Simple identifier for environment variable
 * Value: Full model configuration
 */
export const AI_MODELS: Record<string, ModelConfig> = {
  // ============================================
  // CLAUDE MODELS (Anthropic)
  // ============================================

  'claude-sonnet-4.5': {
    provider: 'claude',
    modelId: 'claude-sonnet-4-5-20250929',
    displayName: 'Claude Sonnet 4.5',
    maxOutputTokens: 64000,
    contextWindow: 1000000,
    costPer1MTokens: { input: 3, output: 15 },
    description: 'Latest Claude model (Sep 2025), best coding model in the world',
  },

  'claude-opus-4.1': {
    provider: 'claude',
    modelId: 'claude-opus-4-1-20250805',
    displayName: 'Claude Opus 4.1',
    maxOutputTokens: 64000,
    contextWindow: 1000000,
    costPer1MTokens: { input: 15, output: 75 },
    description: 'Most powerful Claude (Aug 2025), optimized for agentic tasks and reasoning',
  },

  'claude-sonnet-4': {
    provider: 'claude',
    modelId: 'claude-sonnet-4-20250514',
    displayName: 'Claude Sonnet 4',
    maxOutputTokens: 64000,
    contextWindow: 1000000,
    costPer1MTokens: { input: 3, output: 15 },
    description: 'Previous Sonnet (May 2025), still very capable',
  },

  'claude-3.7-sonnet': {
    provider: 'claude',
    modelId: 'claude-3-7-sonnet-20250219',
    displayName: 'Claude 3.7 Sonnet',
    maxOutputTokens: 64000,
    contextWindow: 200000,
    costPer1MTokens: { input: 3, output: 15 },
    description: 'Hybrid model (Feb 2025) with optional extended thinking mode',
  },

  'claude-3.5-sonnet': {
    provider: 'claude',
    modelId: 'claude-3-5-sonnet-20241022',
    displayName: 'Claude 3.5 Sonnet',
    maxOutputTokens: 8192,
    contextWindow: 200000,
    costPer1MTokens: { input: 3, output: 15 },
    description: 'Legacy model (Oct 2024), consider upgrading to 4.x',
  },

  // ============================================
  // OPENAI MODELS (GPT-5.1 Series - Newest)
  // ============================================

  'gpt-5.1': {
    provider: 'openai',
    modelId: 'gpt-5.1-2025-11-13',
    displayName: 'GPT-5.1',
    maxOutputTokens: 16000,
    contextWindow: 196000, // 196K for thinking mode
    costPer1MTokens: { input: 1.25, output: 10 }, // Estimated based on GPT-5
    description: 'Latest GPT (Nov 2025), adaptive reasoning, balances intelligence and speed',
  },

  'gpt-5.1-instant': {
    provider: 'openai',
    modelId: 'gpt-5.1-chat-latest',
    displayName: 'GPT-5.1 Instant',
    maxOutputTokens: 16000,
    contextWindow: 128000,
    costPer1MTokens: { input: 1.25, output: 10 }, // Estimated
    description: 'Fast mode with adaptive reasoning, 128K context',
  },

  'gpt-5.1-codex': {
    provider: 'openai',
    modelId: 'gpt-5.1-codex',
    displayName: 'GPT-5.1 Codex',
    maxOutputTokens: 16000,
    contextWindow: 128000,
    costPer1MTokens: { input: 1.25, output: 10 }, // Estimated
    description: 'Coding-optimized GPT-5.1 variant',
  },

  'gpt-5.1-codex-mini': {
    provider: 'openai',
    modelId: 'gpt-5.1-codex-mini',
    displayName: 'GPT-5.1 Codex Mini',
    maxOutputTokens: 16000,
    contextWindow: 128000,
    costPer1MTokens: { input: 0.25, output: 2 }, // Estimated based on mini pricing
    description: 'Smaller coding model, 4x more usage',
  },

  // ============================================
  // OPENAI MODELS (GPT-5 Series - Current Flagship)
  // ============================================

  'gpt-5': {
    provider: 'openai',
    modelId: 'gpt-5-2025-08-07',
    displayName: 'GPT-5',
    maxOutputTokens: 16000,
    contextWindow: 272000, // ~272K
    costPer1MTokens: { input: 1.25, output: 10 },
    description: 'GPT-5 flagship (Aug 2025), state-of-the-art reasoning with 90% cache discount',
  },

  'gpt-5-mini': {
    provider: 'openai',
    modelId: 'gpt-5-mini-2025-08-07',
    displayName: 'GPT-5 Mini',
    maxOutputTokens: 16000,
    contextWindow: 272000,
    costPer1MTokens: { input: 0.25, output: 2 },
    description: 'Balanced GPT-5 variant, great for most tasks',
  },

  'gpt-5-nano': {
    provider: 'openai',
    modelId: 'gpt-5-nano-2025-08-07',
    displayName: 'GPT-5 Nano',
    maxOutputTokens: 16000,
    contextWindow: 272000,
    costPer1MTokens: { input: 0.05, output: 0.4 },
    description: 'Cheapest GPT-5, excellent for summaries and simple tasks',
  },

  'gpt-5-pro': {
    provider: 'openai',
    modelId: 'gpt-5-pro-2025-10-06',
    displayName: 'GPT-5 Pro',
    maxOutputTokens: 16000,
    contextWindow: 272000,
    costPer1MTokens: { input: 2.5, output: 20 }, // Estimated higher than base
    description: 'Most powerful GPT-5 (Oct 2025), extended reasoning',
  },

  'gpt-5-codex': {
    provider: 'openai',
    modelId: 'gpt-5-codex',
    displayName: 'GPT-5 Codex',
    maxOutputTokens: 16000,
    contextWindow: 272000,
    costPer1MTokens: { input: 1.25, output: 10 },
    description: 'Coding-optimized GPT-5 variant',
  },
};

/**
 * Get model configuration by identifier
 * @param identifier - Simple model identifier (e.g., 'claude-sonnet-4.5')
 * @returns Model configuration or undefined if not found
 */
export function getModelConfig(identifier: string): ModelConfig | undefined {
  return AI_MODELS[identifier];
}

/**
 * Get all available model identifiers
 */
export function getAvailableModels(): string[] {
  return Object.keys(AI_MODELS);
}

/**
 * Get models by provider
 */
export function getModelsByProvider(provider: 'claude' | 'openai'): Record<string, ModelConfig> {
  return Object.fromEntries(
    Object.entries(AI_MODELS).filter(([, config]) => config.provider === provider)
  );
}

/**
 * Get recommended models for testing
 * Focus on GPT-5 series only
 */
export function getRecommendedModels(): string[] {
  return [
    'gpt-5',               // GPT-5 flagship (Aug 2025)
    'gpt-5-mini',          // Balanced performance
    'gpt-5-nano',          // Cheapest option
  ];
}

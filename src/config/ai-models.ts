/**
 * AI Model Catalog
 * Updated: 2025-11-22
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
    contextWindow: 1000000, // 1M with context-1m-2025-08-07 beta header
    costPer1MTokens: { input: 3, output: 15 },
    description: 'Latest Claude model, excellent balance of speed and capability',
  },

  'claude-opus-4': {
    provider: 'claude',
    modelId: 'claude-opus-4',
    displayName: 'Claude Opus 4',
    maxOutputTokens: 64000,
    contextWindow: 1000000,
    costPer1MTokens: { input: 15, output: 75 },
    description: 'Most powerful Claude model, best for complex reasoning and coding',
  },

  'claude-sonnet-4': {
    provider: 'claude',
    modelId: 'claude-sonnet-4',
    displayName: 'Claude Sonnet 4',
    maxOutputTokens: 64000,
    contextWindow: 1000000,
    costPer1MTokens: { input: 3, output: 15 },
    description: 'Previous generation, still very capable',
  },

  // ============================================
  // OPENAI MODELS (GPT-4.1 Series - Latest)
  // ============================================

  'gpt-4.1': {
    provider: 'openai',
    modelId: 'gpt-4.1-2025-04-14',
    displayName: 'GPT-4.1',
    maxOutputTokens: 16000,
    contextWindow: 1000000, // 1M tokens
    costPer1MTokens: { input: 2.5, output: 10 },
    description: 'Latest GPT model, major improvements in coding and instruction following',
  },

  'gpt-4.1-mini': {
    provider: 'openai',
    modelId: 'gpt-4.1-mini-2025-04-14',
    displayName: 'GPT-4.1 Mini',
    maxOutputTokens: 16000,
    contextWindow: 1000000,
    costPer1MTokens: { input: 0.15, output: 0.6 },
    description: 'Faster and more affordable, excellent for most tasks',
  },

  'gpt-4.1-nano': {
    provider: 'openai',
    modelId: 'gpt-4.1-nano-2025-04-14',
    displayName: 'GPT-4.1 Nano',
    maxOutputTokens: 16000,
    contextWindow: 1000000,
    costPer1MTokens: { input: 0.04, output: 0.16 },
    description: 'Fastest and cheapest, great for simple tasks like summaries',
  },

  // ============================================
  // OPENAI MODELS (GPT-4o Series - Multimodal)
  // ============================================

  'gpt-4o': {
    provider: 'openai',
    modelId: 'gpt-4o',
    displayName: 'GPT-4o',
    maxOutputTokens: 16000,
    contextWindow: 128000,
    costPer1MTokens: { input: 2.5, output: 10 },
    description: 'Multimodal model (audio, vision, text), real-time capabilities',
  },

  'gpt-4o-mini': {
    provider: 'openai',
    modelId: 'gpt-4o-mini',
    displayName: 'GPT-4o Mini',
    maxOutputTokens: 16000,
    contextWindow: 128000,
    costPer1MTokens: { input: 0.15, output: 0.6 },
    description: 'Cheaper multimodal model, good balance of speed and cost',
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

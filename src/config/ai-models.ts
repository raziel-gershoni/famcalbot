/**
 * AI Model Catalog
 * Updated: 2025-12-20
 *
 * Defines available AI models with their specifications.
 * Use simple identifiers (e.g., 'claude-sonnet-4.5') in environment variables.
 */

export interface ModelConfig {
  provider: 'claude' | 'openai' | 'gemini';
  modelId: string;
  displayName: string;
  maxOutputTokens: number;
  contextWindow: number;
  costPer1MTokens: { input: number; output: number }; // USD
  description: string;
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'none'; // Optional: For GPT-5 models
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

  'claude-sonnet-4': {
    provider: 'claude',
    modelId: 'claude-sonnet-4-20250514',
    displayName: 'Claude Sonnet 4',
    maxOutputTokens: 64000,
    contextWindow: 1000000,
    costPer1MTokens: { input: 3, output: 15 },
    description: 'Previous Sonnet (May 2025), still very capable',
  },

  // ============================================
  // OPENAI MODELS (GPT-5.2 Series - Newest)
  // ============================================

  'gpt-5.2': {
    provider: 'openai',
    modelId: 'gpt-5.2-2025-12-11',
    displayName: 'GPT-5.2',
    maxOutputTokens: 16000,
    contextWindow: 200000,
    costPer1MTokens: { input: 1.25, output: 10 },
    description: 'Latest GPT (Dec 2025), improved reasoning and efficiency',
  },

  // ============================================
  // OPENAI MODELS (GPT-5.1 Series)
  // ============================================

  'gpt-5.1': {
    provider: 'openai',
    modelId: 'gpt-5.1-2025-11-13',
    displayName: 'GPT-5.1',
    maxOutputTokens: 16000,
    contextWindow: 196000,
    costPer1MTokens: { input: 1.25, output: 10 },
    description: 'Latest GPT (Nov 2025), adaptive reasoning defaults to none, fast and efficient',
  },

  'gpt-5.1-instant': {
    provider: 'openai',
    modelId: 'gpt-5.1-chat-latest',
    displayName: 'GPT-5.1 Instant',
    maxOutputTokens: 16000,
    contextWindow: 128000,
    costPer1MTokens: { input: 1.25, output: 10 },
    description: 'Fast mode with adaptive reasoning, 128K context',
  },

  // ============================================
  // OPENAI MODELS (GPT-5 Series - Current Flagship)
  // ============================================

  'gpt-5': {
    provider: 'openai',
    modelId: 'gpt-5-2025-08-07',
    displayName: 'GPT-5',
    maxOutputTokens: 16000,
    contextWindow: 272000,
    costPer1MTokens: { input: 1.25, output: 10 },
    description: 'GPT-5 flagship (Aug 2025), state-of-the-art reasoning with 90% cache discount',
    reasoningEffort: 'minimal',
  },

  'gpt-5-mini': {
    provider: 'openai',
    modelId: 'gpt-5-mini-2025-08-07',
    displayName: 'GPT-5 Mini',
    maxOutputTokens: 16000,
    contextWindow: 272000,
    costPer1MTokens: { input: 0.25, output: 2 },
    description: 'Balanced GPT-5 variant, great for most tasks',
    reasoningEffort: 'minimal',
  },

  'gpt-5-nano': {
    provider: 'openai',
    modelId: 'gpt-5-nano-2025-08-07',
    displayName: 'GPT-5 Nano',
    maxOutputTokens: 16000,
    contextWindow: 272000,
    costPer1MTokens: { input: 0.05, output: 0.4 },
    description: 'Cheapest GPT-5, excellent for summaries and simple tasks',
    reasoningEffort: 'minimal',
  },

  // ============================================
  // GEMINI MODELS (Google AI)
  // ============================================

  'gemini-3-pro': {
    provider: 'gemini',
    modelId: 'gemini-3-pro-preview',
    displayName: 'Gemini 3 Pro',
    maxOutputTokens: 65536,
    contextWindow: 1048576,
    costPer1MTokens: { input: 2.00, output: 12.00 }, // ≤200K context
    description: 'Latest Gemini (Nov 2025), best multimodal reasoning, 1M context',
  },

  'gemini-3-flash': {
    provider: 'gemini',
    modelId: 'gemini-3-flash-preview',
    displayName: 'Gemini 3 Flash',
    maxOutputTokens: 65536,
    contextWindow: 1048576,
    costPer1MTokens: { input: 0.50, output: 3.00 },
    description: 'Latest Flash (Dec 2025), Pro-grade reasoning with Flash latency, 3x faster than 2.5 Pro',
  },

  'gemini-2.5-flash': {
    provider: 'gemini',
    modelId: 'gemini-2.5-flash',
    displayName: 'Gemini 2.5 Flash',
    maxOutputTokens: 65536,
    contextWindow: 1048576,
    costPer1MTokens: { input: 0.30, output: 2.50 },
    description: 'Best price-performance, advanced reasoning, 1M context',
  },

  'gemini-2.5-flash-lite': {
    provider: 'gemini',
    modelId: 'gemini-2.5-flash-lite',
    displayName: 'Gemini 2.5 Flash-Lite',
    maxOutputTokens: 65536,
    contextWindow: 1048576,
    costPer1MTokens: { input: 0.10, output: 0.40 },
    description: 'Ultra-cheap, fastest flash model, perfect for summaries',
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
export function getModelsByProvider(provider: 'claude' | 'openai' | 'gemini'): Record<string, ModelConfig> {
  return Object.fromEntries(
    Object.entries(AI_MODELS).filter(([, config]) => config.provider === provider)
  );
}

/**
 * Get recommended models for testing
 * Focus on latest models across providers
 */
export function getRecommendedModels(): string[] {
  return [
    'claude-sonnet-4.5',        // Fast, reliable Claude baseline
    'gpt-5.2',                  // Latest OpenAI (Dec 2025)
    'gemini-3-pro',             // Latest Gemini (Nov 2025)
    'gemini-3-flash',           // Latest Flash (Dec 2025), now default in Gemini app
    'gemini-2.5-flash',         // Best price-performance
    'gemini-2.5-flash-lite',    // Ultra-cheap, fastest
  ];
}

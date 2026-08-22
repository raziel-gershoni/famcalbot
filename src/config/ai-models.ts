/**
 * AI Model Catalog
 * Updated: 2026-03-07
 *
 * Defines available AI models with their specifications.
 * Use simple identifiers (e.g., 'claude-sonnet-4.6') in environment variables.
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
  unsupportedThinkingLevels?: ThinkingLevelName[]; // Optional: Gemini levels this model rejects with a 400
}

/** Gemini thinking levels, mirroring the SDK's ThinkingLevel enum. */
export type ThinkingLevelName = 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH';

/**
 * Nearest supported level to fall back to when a model rejects one outright.
 * MINIMAL -> LOW is behaviour-preserving: on models without MINIMAL, LOW is the
 * floor and returns zero thought tokens.
 */
const THINKING_LEVEL_FALLBACK: Partial<Record<ThinkingLevelName, ThinkingLevelName>> = {
  MINIMAL: 'LOW',
};

/**
 * Available AI models catalog
 * Key: Simple identifier for environment variable
 * Value: Full model configuration
 */
export const AI_MODELS: Record<string, ModelConfig> = {
  // ============================================
  // CLAUDE MODELS (Anthropic)
  // ============================================

  'claude-opus-4.6': {
    provider: 'claude',
    modelId: 'claude-opus-4-6',
    displayName: 'Claude Opus 4.6',
    maxOutputTokens: 128000,
    contextWindow: 200000,
    costPer1MTokens: { input: 5, output: 25 },
    description: 'Most capable Claude model, 128K output, 200K context (1M beta)',
  },

  'claude-sonnet-4.6': {
    provider: 'claude',
    modelId: 'claude-sonnet-4-6',
    displayName: 'Claude Sonnet 4.6',
    maxOutputTokens: 64000,
    contextWindow: 200000,
    costPer1MTokens: { input: 3, output: 15 },
    description: 'Best balance of speed and intelligence, 200K context (1M beta)',
  },

  'claude-haiku-4.5': {
    provider: 'claude',
    modelId: 'claude-haiku-4-5-20251001',
    displayName: 'Claude Haiku 4.5',
    maxOutputTokens: 64000,
    contextWindow: 200000,
    costPer1MTokens: { input: 1, output: 5 },
    description: 'Fastest and most affordable Claude, great for summaries',
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

  'gemini-3.1-pro': {
    provider: 'gemini',
    modelId: 'gemini-3.1-pro-preview',
    displayName: 'Gemini 3.1 Pro',
    maxOutputTokens: 65536,
    contextWindow: 1048576,
    costPer1MTokens: { input: 2.00, output: 12.00 },
    description: 'Latest Gemini Pro (Mar 2026), replaces 3 Pro Preview',
  },

  'gemini-3-flash': {
    provider: 'gemini',
    modelId: 'gemini-3-flash-preview',
    displayName: 'Gemini 3 Flash',
    maxOutputTokens: 65536,
    contextWindow: 1048576,
    costPer1MTokens: { input: 0.50, output: 3.00 },
    description: 'Flash (Dec 2025), Pro-grade reasoning with Flash latency, 3x faster than 2.5 Pro',
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

  'gemini-3.1-flash-lite': {
    provider: 'gemini',
    modelId: 'gemini-3.1-flash-lite',
    displayName: 'Gemini 3.1 Flash-Lite',
    maxOutputTokens: 65536,
    contextWindow: 1048576,
    costPer1MTokens: { input: 0.25, output: 1.50 },
    description: 'Latest Flash-Lite (Mar 2026), best cost-efficiency for high-volume tasks',
  },

  'gemini-3.5-flash': {
    provider: 'gemini',
    modelId: 'gemini-3.5-flash',
    displayName: 'Gemini 3.5 Flash',
    maxOutputTokens: 65536,
    contextWindow: 1048576,
    costPer1MTokens: { input: 1.50, output: 9.00 },
    description: 'Smarter Flash (May 2026) — better prose and agentic reasoning, thinking on by default',
  },

  'gemini-3.7-flash': {
    provider: 'gemini',
    modelId: 'gemini-3.7-flash',
    displayName: 'Gemini 3.7 Flash',
    maxOutputTokens: 65536,
    contextWindow: 1048576,
    // Introductory rate through 2026-12-31; rises to $1.50 / $7.50 on 2027-01-01.
    costPer1MTokens: { input: 0.75, output: 3.75 },
    description: 'Flash (Aug 2026), current default — stronger coding and agentic work than 3.5 at half the price',
    // 3.7 dropped MINIMAL: sending it returns 400 "Thinking level MINIMAL is not
    // supported for this model". 3.5 and earlier still accept it.
    unsupportedThinkingLevels: ['MINIMAL'],
  },
};

/**
 * Get model configuration by identifier
 * @param identifier - Simple model identifier (e.g., 'claude-sonnet-4.6')
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
 * Coerce an admin-selected Gemini thinking level to one the model actually accepts.
 * Levels differ per model generation, so passing the stored value through blind
 * turns a settings change into a 400 on every completion.
 *
 * @returns the level to send, or null to omit thinkingConfig and take the model default
 */
export function resolveThinkingLevel(
  model: ModelConfig,
  level: string | null | undefined
): ThinkingLevelName | null {
  if (!level) return null;
  const requested = level as ThinkingLevelName;
  if (!model.unsupportedThinkingLevels?.includes(requested)) return requested;
  return THINKING_LEVEL_FALLBACK[requested] ?? null;
}

/**
 * Get models by provider
 */
export function getModelsByProvider(provider: 'claude' | 'openai' | 'gemini'): Record<string, ModelConfig> {
  return Object.fromEntries(
    Object.entries(AI_MODELS).filter(([, config]) => config.provider === provider)
  );
}


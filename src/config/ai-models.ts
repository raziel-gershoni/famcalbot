/**
 * AI Model Catalog
 * Updated: 2026-08-23
 *
 * Defines available AI models with their specifications.
 * Use simple identifiers (e.g., 'gemini-3.7-flash') in environment variables.
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
  // Optional: thinking level to send when the admin has not chosen one. Without it the
  // API applies the model's own default, which for some models is far too slow.
  defaultThinkingLevel?: ThinkingLevelName;
}

/** Gemini thinking levels, mirroring the SDK's ThinkingLevel enum. */
export type ThinkingLevelName = 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH';

/**
 * Nearest supported level to fall back to when a model rejects one outright.
 * MINIMAL -> LOW is the closest available intent: on models without MINIMAL, LOW is
 * the floor. It reduces thinking (often to nothing) but is not guaranteed to be zero
 * — the model still decides per prompt.
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
  // Only the models actually in use are listed. Adding one back is a matter of
  // re-adding its entry here — nothing else keys off the catalog contents.

  'gemini-3.5-flash': {
    provider: 'gemini',
    modelId: 'gemini-3.5-flash',
    displayName: 'Gemini 3.5 Flash',
    maxOutputTokens: 65536,
    contextWindow: 1048576,
    costPer1MTokens: { input: 1.50, output: 9.00 },
    description: 'Previous default (May 2026) — kept as the rollback target for 3.7',
  },

  'gemini-3.7-flash': {
    provider: 'gemini',
    modelId: 'gemini-3.7-flash',
    displayName: 'Gemini 3.7 Flash',
    maxOutputTokens: 65536,
    contextWindow: 1048576,
    // Introductory rate through 2026-12-31; rises to $1.50 / $7.50 on 2027-01-01.
    costPer1MTokens: { input: 0.75, output: 3.75 },
    description: 'Current default (Aug 2026) — stronger coding and agentic work than 3.5 at half the price',
    // 3.7 dropped MINIMAL: sending it returns 400 "Thinking level MINIMAL is not
    // supported for this model". 3.5 and earlier still accept it.
    unsupportedThinkingLevels: ['MINIMAL'],
  },

  'gemini-3.8-flash': {
    provider: 'gemini',
    modelId: 'gemini-3.8-flash',
    displayName: 'Gemini 3.8 Flash',
    maxOutputTokens: 65536,
    contextWindow: 1048576,
    // Same as 3.7: introductory through 2026-12-31, then $1.50 / $7.50 from 2027-01-01.
    costPer1MTokens: { input: 0.75, output: 3.75 },
    description: 'GA Sep 2026 - same price as 3.7, runs at LOW thinking by default',
    // Like 3.7, MINIMAL returns 400.
    unsupportedThinkingLevels: ['MINIMAL'],
    // 3.8's own default is MEDIUM, and on the real Hebrew daily-summary prompt that
    // took 17-46s (median 38s) against 5-11s on 3.7. At HIGH, 3 of 4 runs never
    // finished inside the 45s abort. LOW ran a stable ~5s with correct output, so an
    // unset admin level means LOW for this model rather than the API default.
    defaultThinkingLevel: 'LOW',
  },
};

/**
 * Model used when nothing valid is configured. Must always be a key in AI_MODELS.
 */
export const FALLBACK_AI_MODEL = 'gemini-3.7-flash';

/**
 * Raw provider model ID for FALLBACK_AI_MODEL. Services that call the Gemini SDK
 * directly need the API-side ID, not the catalog key — use this rather than pasting
 * a literal, so a retired model can never be left behind in one file.
 */
export const FALLBACK_MODEL_ID: string = AI_MODELS[FALLBACK_AI_MODEL].modelId;

/**
 * Get model configuration by identifier
 * @param identifier - Simple model identifier (e.g., 'gemini-3.7-flash')
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
 * turns a settings change into a 400 on every completion. With no admin level set,
 * the model's own declared defaultThinkingLevel applies, if it has one.
 *
 * @returns the level to send, or null to omit thinkingConfig and take the API default
 */
export function resolveThinkingLevel(
  model: ModelConfig,
  level: string | null | undefined
): ThinkingLevelName | null {
  if (!level) return model.defaultThinkingLevel ?? null;
  const requested = level as ThinkingLevelName;
  if (!model.unsupportedThinkingLevels?.includes(requested)) return requested;
  return THINKING_LEVEL_FALLBACK[requested] ?? null;
}

/**
 * Look up a catalog entry by its raw API model id rather than its catalog key.
 * The media pipelines carry only the API id by the time they call the model.
 */
export function getModelConfigByModelId(modelId: string): ModelConfig | undefined {
  return Object.values(AI_MODELS).find(m => m.modelId === modelId);
}

/**
 * Thinking level for the media pipelines (voice, image, forwarded text, corrections).
 *
 * These calls have never sent a thinking config, so they run at the API default. That
 * is fine for 3.7, but on 3.8 the default made voice extraction ~6s and photo
 * extraction up to 18s, against 3-5s and 3-10s at LOW with the same output. So apply
 * the model's declared default, and only that: the admin thinking level stays a
 * summary setting, as it always has been. Returns null - send nothing - for models
 * that declare no default, which leaves today's behaviour for 3.5 and 3.7 unchanged.
 */
export function getExtractionThinkingLevel(modelId: string): ThinkingLevelName | null {
  return getModelConfigByModelId(modelId)?.defaultThinkingLevel ?? null;
}

/**
 * Get models by provider
 */
export function getModelsByProvider(provider: 'claude' | 'openai' | 'gemini'): Record<string, ModelConfig> {
  return Object.fromEntries(
    Object.entries(AI_MODELS).filter(([, config]) => config.provider === provider)
  );
}


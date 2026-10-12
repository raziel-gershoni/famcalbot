/**
 * The AI model. Every text call in the app runs on Gemini 3.8 Flash: the owner removed
 * model selection on 2026-10-12, so there is no admin, env or per-call choice left.
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
  // Thinking level to send. Without it the API applies the model's own default, which
  // for 3.8 is far too slow.
  defaultThinkingLevel?: ThinkingLevelName;
}

/** Gemini thinking levels, mirroring the SDK's ThinkingLevel enum. */
export type ThinkingLevelName = 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH';

export const AI_MODELS: Record<string, ModelConfig> = {
  'gemini-3.8-flash': {
    provider: 'gemini',
    modelId: 'gemini-3.8-flash',
    displayName: 'Gemini 3.8 Flash',
    maxOutputTokens: 65536,
    contextWindow: 1048576,
    // Introductory through 2026-12-31, then $1.50 / $7.50 from 2027-01-01.
    costPer1MTokens: { input: 0.75, output: 3.75 },
    description: 'GA Sep 2026, run at LOW thinking',
    // 3.8's own default is MEDIUM, and on the real Hebrew daily-summary prompt that
    // took 17-46s (median 38s) against 5-11s on 3.7. At HIGH, 3 of 4 runs never
    // finished inside the 45s abort. LOW ran a stable ~5s with correct output.
    defaultThinkingLevel: 'LOW',
  },
};

/** The model every text call uses. Must be a key in AI_MODELS. */
export const AI_MODEL = 'gemini-3.8-flash';

/** Its raw API id, for services that call the Gemini SDK directly. */
export const AI_MODEL_ID: string = AI_MODELS[AI_MODEL].modelId;

/**
 * Get model configuration by identifier
 * @param identifier - Model identifier (e.g., 'gemini-3.8-flash')
 * @returns Model configuration or undefined if not found
 */
export function getModelConfig(identifier: string): ModelConfig | undefined {
  return AI_MODELS[identifier];
}

/**
 * Look up a catalog entry by its raw API model id rather than its catalog key.
 * The media pipelines carry only the API id by the time they call the model.
 */
export function getModelConfigByModelId(modelId: string): ModelConfig | undefined {
  return Object.values(AI_MODELS).find(m => m.modelId === modelId);
}

/**
 * The thinking level to send for a model: its declared default, or null to omit
 * thinkingConfig and take the API default.
 */
export function thinkingLevelFor(model: ModelConfig): ThinkingLevelName | null {
  return model.defaultThinkingLevel ?? null;
}

/**
 * Thinking level for the media pipelines (voice, image, forwarded text, corrections),
 * which carry only the raw API id. On 3.8 the API default made voice extraction ~6s and
 * photo extraction up to 18s, against 3-5s and 3-10s at LOW with the same output.
 */
export function getExtractionThinkingLevel(modelId: string): ThinkingLevelName | null {
  const model = getModelConfigByModelId(modelId);
  return model ? thinkingLevelFor(model) : null;
}

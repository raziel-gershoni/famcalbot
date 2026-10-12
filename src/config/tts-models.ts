/**
 * The text-to-speech model. Every voice message runs on Gemini 3.8 Flash TTS: the
 * owner removed model selection on 2026-10-12 and preferred Flash over Flash-Lite by
 * ear. Pure data; the request/response logic lives in src/services/gemini-tts.ts.
 */

export interface TtsModelConfig {
  displayName: string;
  description: string;
  /** USD per 1M output audio tokens, standard paid tier. */
  costPer1MAudioTokens: number;
}

export const TTS_MODELS: Record<string, TtsModelConfig> = {
  'gemini-3.8-flash-tts': {
    displayName: 'Gemini 3.8 Flash TTS',
    // Introductory rate through 2026-12-31; rises to $18 on 2027-01-01.
    costPer1MAudioTokens: 9,
    description: 'The voice model for every show and reply',
  },
};

/** The model every voice message uses. Must be a key in TTS_MODELS. */
export const TTS_MODEL = 'gemini-3.8-flash-tts';

export function getTtsModelConfig(id: string): TtsModelConfig | undefined {
  return TTS_MODELS[id];
}

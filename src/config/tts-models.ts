/**
 * Text-to-speech model catalog.
 *
 * Pure data, safe to import from client components - the admin panel builds its TTS
 * dropdown from this. The request/response logic lives in src/services/gemini-tts.ts.
 */

export interface TtsModelConfig {
  displayName: string;
  description: string;
  /** USD per 1M output audio tokens, standard paid tier. */
  costPer1MAudioTokens: number;
}

export const TTS_MODELS: Record<string, TtsModelConfig> = {
  'gemini-3.8-flash-lite-tts': {
    displayName: 'Gemini 3.8 Flash-Lite TTS',
    // Introductory rate through 2026-12-31; rises to $12 on 2027-01-01.
    costPer1MAudioTokens: 6,
    description: "Default. Google's named replacement for 3.1 preview, built for read-aloud",
  },
  'gemini-3.8-flash-tts': {
    displayName: 'Gemini 3.8 Flash TTS',
    // Introductory rate through 2026-12-31; rises to $18 on 2027-01-01.
    costPer1MAudioTokens: 9,
    description: 'Higher-fidelity tier, 1.5x the audio cost of Flash-Lite',
  },
  'gemini-3.1-flash-tts-preview': {
    displayName: 'Gemini 3.1 Flash TTS (legacy)',
    costPer1MAudioTokens: 20,
    // Kept only as a rollback target. Its earliest shutdown is 2026-11-17; after that
    // it should be removed from this list.
    description: 'Legacy preview - Google shuts it down from 2026-11-17',
  },
};

/** Used when neither the admin setting nor GEMINI_TTS_MODEL picks one. */
export const DEFAULT_TTS_MODEL = 'gemini-3.8-flash-lite-tts';

export function getTtsModelConfig(id: string): TtsModelConfig | undefined {
  return TTS_MODELS[id];
}

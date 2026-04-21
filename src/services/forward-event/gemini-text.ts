/**
 * Gemini Text Processing for Forwarded Messages
 * Sends forwarded message text to Gemini for intent detection + event extraction
 */

import { getGemini } from '../ai-provider';
import { VoiceIntentResult } from '../event-parser';
import { CalendarAssignment } from '../../types';
import { getDefaultAiModelSetting } from '../reminder-cache';
import { getModelConfig } from '../../config/ai-models';
import { buildEventExtractionPrompt, parseGeminiEventResponse } from '../voice/gemini-voice';

const TEXT_RETRY_CONFIG = {
  maxRetries: 1,
  baseDelayMs: 500,
} as const;

const TEXT_MODEL_FALLBACK = 'gemini-3-flash-preview';

export interface TextProcessingMetrics {
  model: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Process forwarded message text with Gemini
 * Single API call: intent detection + event extraction
 */
export async function processTextWithGemini(
  text: string,
  language: string,
  calendars: CalendarAssignment[],
  timezone: string
): Promise<{ intentResult: VoiceIntentResult; metrics: TextProcessingMetrics }> {
  const startTime = Date.now();
  let lastError: Error | null = null;

  // Resolve model: admin setting → env var → hardcoded fallback
  const adminDefault = await getDefaultAiModelSetting();
  let resolvedModelId = TEXT_MODEL_FALLBACK;
  if (adminDefault) {
    const cfg = getModelConfig(adminDefault);
    if (cfg) resolvedModelId = cfg.modelId;
  } else if (process.env.AI_MODEL) {
    const cfg = getModelConfig(process.env.AI_MODEL);
    if (cfg) resolvedModelId = cfg.modelId;
  }

  for (let attempt = 0; attempt <= TEXT_RETRY_CONFIG.maxRetries; attempt++) {
    try {
      const promptText = buildEventExtractionPrompt(language, calendars, timezone, 'text');

      const response = await getGemini().models.generateContent({
        model: resolvedModelId,
        contents: [
          {
            role: 'user',
            parts: [
              { text: promptText + '\n\nFORWARDED MESSAGE:\n' + text },
            ],
          },
        ],
      });

      const duration = Date.now() - startTime;
      const inputTokens = response.usageMetadata?.promptTokenCount || 0;
      const outputTokens = response.usageMetadata?.candidatesTokenCount || 0;

      console.log(`[Forward Gemini] Response in ${duration}ms, model: ${resolvedModelId}, tokens: ${inputTokens}in/${outputTokens}out, attempt: ${attempt + 1}`);

      // response.text getter can throw if no candidates are present
      let responseText: string;
      try {
        responseText = response.text ?? '';
      } catch {
        throw new Error('Gemini returned empty response');
      }
      if (!responseText) {
        throw new Error('Gemini returned empty response');
      }

      // Extract JSON from response (may be wrapped in markdown code blocks)
      let jsonSource = responseText;
      const codeBlockMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (codeBlockMatch) {
        jsonSource = codeBlockMatch[1];
      }
      const jsonMatch = jsonSource.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('Failed to extract JSON from Gemini response');
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const parsed: any = JSON.parse(jsonMatch[0]);
      const intentResult = parseGeminiEventResponse(parsed, calendars, timezone);

      return {
        intentResult,
        metrics: { model: resolvedModelId, inputTokens, outputTokens, durationMs: duration },
      };

    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt < TEXT_RETRY_CONFIG.maxRetries) {
        const delay = TEXT_RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt);
        console.warn(`[Forward Gemini] Error (attempt ${attempt + 1}/${TEXT_RETRY_CONFIG.maxRetries + 1}), retrying in ${delay}ms:`, error);
        await sleep(delay);
      }
    }
  }

  console.error(`[Forward Gemini] Failed after ${TEXT_RETRY_CONFIG.maxRetries + 1} attempts:`, lastError);
  throw new Error(`Text processing failed: ${lastError?.message || 'Unknown error'}`);
}

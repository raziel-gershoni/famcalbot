/**
 * Gemini Image Processing for invitation photos
 * Single multimodal API call: OCR + intent detection + event extraction.
 * Twin of processTextWithGemini, but sends an image inlineData part.
 */

import { getGemini } from '../ai-provider';
import { VoiceIntentResult } from '../event-parser';
import { CalendarAssignment } from '../../types';
import { getDefaultAiModelSetting } from '../reminder-cache';
import { getModelConfig, FALLBACK_MODEL_ID } from '../../config/ai-models';
import { buildEventExtractionPrompt, extractIntents } from '../voice/gemini-voice';

const IMAGE_RETRY_CONFIG = {
  maxRetries: 1,
  baseDelayMs: 500,
} as const;

const IMAGE_MODEL_FALLBACK = FALLBACK_MODEL_ID;

export interface ImageProcessingMetrics {
  model: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Process an invitation image with Gemini.
 * @param imageBuffer raw image bytes
 * @param mimeType e.g. 'image/jpeg'
 * @param caption optional user caption sent with the photo (extra context)
 */
export async function processImageWithGemini(
  imageBuffer: Buffer,
  mimeType: string,
  caption: string | undefined,
  language: string,
  calendars: CalendarAssignment[],
  timezone: string
): Promise<{ intentResult: VoiceIntentResult; intentResults?: VoiceIntentResult[]; metrics: ImageProcessingMetrics }> {
  const startTime = Date.now();
  let lastError: Error | null = null;

  // Resolve model: admin setting → env var → hardcoded fallback
  const adminDefault = await getDefaultAiModelSetting();
  let resolvedModelId = IMAGE_MODEL_FALLBACK;
  if (adminDefault) {
    const cfg = getModelConfig(adminDefault);
    if (cfg) resolvedModelId = cfg.modelId;
  } else if (process.env.AI_MODEL) {
    const cfg = getModelConfig(process.env.AI_MODEL);
    if (cfg) resolvedModelId = cfg.modelId;
  }

  for (let attempt = 0; attempt <= IMAGE_RETRY_CONFIG.maxRetries; attempt++) {
    try {
      const promptText = buildEventExtractionPrompt(language, calendars, timezone, 'image')
        + (caption?.trim() ? `\n\nUSER CAPTION (extra context):\n${caption.trim()}` : '');

      const response = await getGemini().models.generateContent({
        model: resolvedModelId,
        contents: [
          {
            role: 'user',
            parts: [
              { text: promptText },
              { inlineData: { mimeType, data: imageBuffer.toString('base64') } },
            ],
          },
        ],
      });

      const duration = Date.now() - startTime;
      const inputTokens = response.usageMetadata?.promptTokenCount || 0;
      const outputTokens = response.usageMetadata?.candidatesTokenCount || 0;

      console.log(`[Image Gemini] Response in ${duration}ms, model: ${resolvedModelId}, tokens: ${inputTokens}in/${outputTokens}out, attempt: ${attempt + 1}`);

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
      const intentResults = extractIntents(parsed, calendars, timezone);
      const intentResult = intentResults[0];

      return {
        intentResult,
        intentResults,
        metrics: { model: resolvedModelId, inputTokens, outputTokens, durationMs: duration },
      };

    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt < IMAGE_RETRY_CONFIG.maxRetries) {
        const delay = IMAGE_RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt);
        console.warn(`[Image Gemini] Error (attempt ${attempt + 1}/${IMAGE_RETRY_CONFIG.maxRetries + 1}), retrying in ${delay}ms:`, error);
        await sleep(delay);
      }
    }
  }

  console.error(`[Image Gemini] Failed after ${IMAGE_RETRY_CONFIG.maxRetries + 1} attempts:`, lastError);
  throw new Error(`Image processing failed: ${lastError?.message || 'Unknown error'}`);
}

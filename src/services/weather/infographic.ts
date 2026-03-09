/**
 * Weather Infographic Generator
 * Uses Gemini's native image generation (Nano Banana) to create visual weather infographics
 */

import { getGemini } from '../ai-provider';

const GEMINI_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.0-flash-exp';

// Retry configuration (same pattern as TTS)
const MAX_RETRIES = 1;
const BASE_DELAY_MS = 500;

/**
 * Generate a weather infographic image using Gemini's native image generation.
 *
 * @param infographicPrompt - Pre-crafted prompt from the text AI describing the infographic
 * @returns PNG image buffer, or null on failure (caller falls back to text)
 */
export async function generateWeatherInfographic(
  infographicPrompt: string,
): Promise<Buffer | null> {
  const startMs = Date.now();

  console.log('[Weather Infographic] Generating image:', {
    model: GEMINI_IMAGE_MODEL,
    promptLength: infographicPrompt.length,
  });

  try {
    const result = await callWithRetry(async () => {
      return await getGemini().models.generateContent({
        model: GEMINI_IMAGE_MODEL,
        contents: infographicPrompt,
        config: {
          responseModalities: ['TEXT', 'IMAGE'],
          imageConfig: { aspectRatio: '9:16' },
        },
      });
    }, MAX_RETRIES, BASE_DELAY_MS);

    // Extract PNG from response
    const parts = result.candidates?.[0]?.content?.parts;
    if (!parts) {
      console.warn('[Weather Infographic] No parts in response');
      return null;
    }

    for (const part of parts) {
      if (part.inlineData?.data && part.inlineData.mimeType?.startsWith('image/')) {
        const buffer = Buffer.from(part.inlineData.data, 'base64');
        const elapsed = Date.now() - startMs;
        console.log('[Weather Infographic] Generated successfully:', {
          sizeKB: (buffer.length / 1024).toFixed(1),
          durationMs: elapsed,
        });
        return buffer;
      }
    }

    console.warn('[Weather Infographic] No image data found in response parts');
    return null;
  } catch (error) {
    const elapsed = Date.now() - startMs;
    console.error('[Weather Infographic] Generation failed:', {
      error,
      durationMs: elapsed,
    });
    return null;
  }
}

/**
 * Retry wrapper for transient errors (429/503).
 */
async function callWithRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number,
  baseDelay: number,
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: unknown) {
      const err = error as { status?: number };
      const isRetryable = err.status === 503 || err.status === 429;
      if (attempt === maxRetries || !isRetryable) throw error;
      await new Promise(r => setTimeout(r, baseDelay * Math.pow(2, attempt)));
    }
  }
  throw new Error('Unreachable');
}

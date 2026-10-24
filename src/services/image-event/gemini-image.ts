/**
 * Gemini Image Processing for invitation photos
 * Single multimodal API call: OCR + intent detection + event extraction.
 * Twin of processTextWithGemini, but sends an image inlineData part.
 */

import { getGemini, extractionConfig } from '../ai-provider';
import { VoiceIntentResult } from '../event-parser';
import { CalendarAssignment } from '../../types';
import { AI_MODEL_ID } from '../../config/ai-models';
import { buildEventExtractionPrompt, extractIntents } from '../voice/gemini-voice';

/**
 * Gemini refused or could not use the file itself (an unreadable or password-protected
 * document): a client error (4xx except timeout/rate limit), INVALID_ARGUMENT, or an empty
 * or non-JSON answer. Retrying a refusal is pointless; the handler can tell the user.
 */
export class MediaRejectedError extends Error {
  constructor(cause: Error) {
    super(`Gemini could not read the file: ${cause.message}`);
    this.name = 'MediaRejectedError';
    this.cause = cause;
  }
}

function isClientRejection(error: Error): boolean {
  const status = (error as { status?: unknown }).status;
  if (typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429) return true;
  return /INVALID_ARGUMENT/.test(error.message);
}
function isUnusableAnswer(error: Error): boolean {
  return /empty response|Failed to extract JSON/.test(error.message);
}

const IMAGE_RETRY_CONFIG = {
  maxRetries: 1,
  baseDelayMs: 500,
} as const;

export interface ImageProcessingMetrics {
  model: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** One file for Gemini: an image or a PDF. */
export interface MediaPart {
  buffer: Buffer;
  /** e.g. 'image/jpeg' or 'application/pdf' */
  mimeType: string;
}

/**
 * Added to the prompt when several files (an album) or a document are sent in one
 * request. The files are one set: a table or list may run on from one to the next, and an
 * event shown on two of them is one event.
 */
const MULTI_FILE_RULES = (count: number) => `

MULTIPLE FILES (${count} attached, labelled "File 1 of ${count}" and so on):
- They are ONE set of files, in the order sent. Read them in that order, as one document.
- A table, schedule or list may continue from one file onto the next: read it as one.
- They may also be different invitations: return every distinct event, using the "intents" array when there are 2 or more.
- If the same event appears on more than one file, return it ONCE.
- If a file is not an event, ignore it; return intent "none" only when NO file has an event.`;

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
  return processMediaWithGemini([{ buffer: imageBuffer, mimeType }], caption, language, calendars, timezone);
}

/**
 * Process one or more files (photos of an album, a PDF) with Gemini in ONE request.
 * Same prompt, retry and parsing as a single image; with several files the prompt also
 * carries the album rules and each file is labelled with its place in the set.
 * @param caption optional user caption (for an album, the one on any of its items)
 */
export async function processMediaWithGemini(
  media: MediaPart[],
  caption: string | undefined,
  language: string,
  calendars: CalendarAssignment[],
  timezone: string
): Promise<{ intentResult: VoiceIntentResult; intentResults?: VoiceIntentResult[]; metrics: ImageProcessingMetrics }> {
  const startTime = Date.now();
  let lastError: Error | null = null;

  // Encoded once: base64 of many large files is big, and a retry reuses it.
  const fileParts = media.flatMap((m, i) => [
    ...(media.length > 1 ? [{ text: `File ${i + 1} of ${media.length}:` }] : []),
    { inlineData: { mimeType: m.mimeType, data: m.buffer.toString('base64') } },
  ]);

  for (let attempt = 0; attempt <= IMAGE_RETRY_CONFIG.maxRetries; attempt++) {
    try {
      const promptText = buildEventExtractionPrompt(language, calendars, timezone, 'image')
        + (media.length > 1 ? MULTI_FILE_RULES(media.length) : '')
        + (caption?.trim() ? `\n\nUSER CAPTION (extra context):\n${caption.trim()}` : '');
      const response = await getGemini().models.generateContent({
        model: AI_MODEL_ID,
        ...extractionConfig(AI_MODEL_ID),
        contents: [
          {
            role: 'user',
            parts: [
              { text: promptText },
              ...fileParts,
            ],
          },
        ],
      });

      const duration = Date.now() - startTime;
      const inputTokens = response.usageMetadata?.promptTokenCount || 0;
      const outputTokens = response.usageMetadata?.candidatesTokenCount || 0;

      console.log(`[Image Gemini] Response in ${duration}ms, model: ${AI_MODEL_ID}, tokens: ${inputTokens}in/${outputTokens}out, attempt: ${attempt + 1}`);

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
        metrics: { model: AI_MODEL_ID, inputTokens, outputTokens, durationMs: duration },
      };

    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (isClientRejection(lastError)) {
        console.error('[Image Gemini] Gemini refused the file, not retrying:', lastError);
        throw new MediaRejectedError(lastError);
      }
      if (attempt < IMAGE_RETRY_CONFIG.maxRetries) {
        const delay = IMAGE_RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt);
        console.warn(`[Image Gemini] Error (attempt ${attempt + 1}/${IMAGE_RETRY_CONFIG.maxRetries + 1}), retrying in ${delay}ms:`, error);
        await sleep(delay);
      }
    }
  }

  console.error(`[Image Gemini] Failed after ${IMAGE_RETRY_CONFIG.maxRetries + 1} attempts:`, lastError);
  if (lastError && isUnusableAnswer(lastError)) throw new MediaRejectedError(lastError);
  throw new Error(`Image processing failed: ${lastError?.message || 'Unknown error'}`);
}

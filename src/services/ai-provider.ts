/**
 * AI Provider Abstraction Layer
 * Gemini behind a single interface, retry logic, and monitoring
 */

import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { getAIConfig, AI_RETRY_CONFIG } from '../config/constants';
import { thinkingLevelFor, getExtractionThinkingLevel } from '../config/ai-models';
import { notifyAdminWarning } from '../utils/error-notifier';
import { captureError } from '../lib/error-capture';

// Lazy initialization of API clients to avoid build-time errors
let gemini: GoogleGenAI | null = null;

/**
 * generateContent options for the media pipelines (voice, image, forwarded text and
 * corrections), spread into the request. Applies the model's declared default
 * thinking level - see getExtractionThinkingLevel - and is empty for models that
 * declare none.
 */
export function extractionConfig(modelId: string): { config?: { thinkingConfig: { thinkingLevel: ThinkingLevel } } } {
  const level = getExtractionThinkingLevel(modelId);
  return level ? { config: { thinkingConfig: { thinkingLevel: ThinkingLevel[level] } } } : {};
}

export const getGemini = () => {
  if (!gemini) {
    gemini = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });
  }
  return gemini;
};

/**
 * Extra request options. Every model in the catalog is Gemini.
 */
export interface AICompletionOptions {
  /** JSON Schema the answer must follow. Also sets responseMimeType to application/json. */
  responseJsonSchema?: object;
}

/**
 * Result from AI completion request
 */
export interface AICompletionResult {
  text: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    thinkingTokens?: number;
  };
  stopReason: string;
  model: string;
  responseModel?: string;
  durationMs: number;
  thinkingLevel?: string;
}

/**
 * Sleep utility for retry delays
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Send alert to admin about token ceiling hit
 */
async function alertTokenCeiling(
  model: string,
  outputTokens: number,
  maxTokens: number
): Promise<void> {
  await notifyAdminWarning(
    'AI Token Ceiling Hit',
    `Model: ${model}\nOutput tokens: ${outputTokens}/${maxTokens}\n\nThe AI response was truncated. Consider increasing AI_MAX_TOKENS.`
  );
}

/**
 * Call Gemini API with a prompt
 */
async function callGemini(prompt: string, modelId?: string, options: AICompletionOptions = {}): Promise<AICompletionResult> {
  const config = getAIConfig(modelId);

  // The model's own level, not the API default - see thinkingLevelFor().
  const thinkingLevel = thinkingLevelFor(config.MODEL_CONFIG);

  const response = await getGemini().models.generateContent({
    model: config.MODEL_CONFIG.modelId,
    contents: prompt,
    config: {
      abortSignal: AbortSignal.timeout(45_000),
      ...(thinkingLevel && {
        thinkingConfig: { thinkingLevel: ThinkingLevel[thinkingLevel as keyof typeof ThinkingLevel] },
      }),
      ...(options.responseJsonSchema && {
        responseMimeType: 'application/json',
        responseJsonSchema: options.responseJsonSchema,
      }),
    },
  });
  const text = response.text ?? '';

  // Check if response was truncated
  const finishReason = response.candidates?.[0]?.finishReason || 'STOP';
  const finishReasonStr = String(finishReason);

  if (finishReasonStr.includes('MAX_TOKENS') || finishReasonStr === 'OTHER') {
    const outputTokens = response.usageMetadata?.candidatesTokenCount || 0;
    console.warn('⚠️ WARNING: Gemini response may have been truncated!');
    console.warn(`Used ${outputTokens}/${config.MAX_TOKENS} output tokens`);

    // Send alert to admin (non-blocking)
    alertTokenCeiling(
      config.MODEL_CONFIG.displayName,
      outputTokens,
      config.MAX_TOKENS
    ).catch(err => captureError(err, 'ai-token-ceiling-alert', {}, 'warning'));
  }

  return {
    text,
    usage: {
      inputTokens: response.usageMetadata?.promptTokenCount || 0,
      outputTokens: response.usageMetadata?.candidatesTokenCount || 0,
      thinkingTokens: (response.usageMetadata as Record<string, number> | undefined)?.thoughtsTokenCount || undefined,
    },
    stopReason: finishReasonStr,
    model: config.MODEL_CONFIG.displayName,
    responseModel: (response as unknown as Record<string, unknown>).modelVersion as string | undefined,
    durationMs: 0,
    thinkingLevel: thinkingLevel || undefined,
  };
}

/**
 * Check if an error should NOT be retried (overload, auth, forbidden).
 * These resolve in minutes/never, not seconds — retrying wastes time.
 */
function isNonRetryableError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as Record<string, unknown>;
  const status = e.status ?? e.statusCode;
  if (status === 429 || status === 529 || status === 401 || status === 403) return true;
  const name = e.name;
  if (name === 'RateLimitError' || name === 'AuthenticationError') return true;
  // AbortError from AbortSignal.timeout means the model didn't finish in
  // time. Retrying produces the same slow generation; surface the timeout
  // fast so the pipeline can render a user-facing error instead of burning
  // the whole 50s budget on two doomed attempts.
  if (name === 'AbortError') return true;
  const code = e.code;
  if (code === 20 /* DOMException.ABORT_ERR */ || code === 'ABORT_ERR') return true;
  return false;
}

/**
 * Generate AI completion with retry logic and exponential backoff
 *
 * @param prompt - The prompt to send to the AI
 * @param modelId - Optional catalog key; defaults to AI_MODEL (the live eval's --model passes one)
 * @param options - Optional request options (JSON mode)
 * @returns AI completion result with text and usage statistics
 * @throws Original error if all retries fail (preserves .status for downstream detection)
 */
export async function generateAICompletion(prompt: string, modelId?: string, options?: AICompletionOptions): Promise<AICompletionResult> {
  let lastError: unknown = null;
  const maxRetries = AI_RETRY_CONFIG.MAX_RETRIES;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const startMs = Date.now();
      const result = await callGemini(prompt, modelId, options);
      result.durationMs = Date.now() - startMs;

      // Log successful completion
      console.log('AI Completion Success:', {
        model: result.model,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        stopReason: result.stopReason,
        attempt: attempt + 1,
      });

      return result;
    } catch (error) {
      lastError = error;

      // Fail fast on non-retryable errors (429, 529, auth)
      if (isNonRetryableError(error)) {
        console.error(`AI API non-retryable error (${(error as Record<string, unknown>).status || (error as Record<string, unknown>).name}):`, error);
        throw error;
      }

      // Don't retry on last attempt
      if (attempt === maxRetries) {
        break;
      }

      // Calculate exponential backoff delay: 1s, 2s, etc.
      const delay = AI_RETRY_CONFIG.INITIAL_RETRY_DELAY * Math.pow(2, attempt);

      console.warn(
        `AI API error (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms:`,
        error
      );

      // Wait before retrying
      await sleep(delay);
    }
  }

  // All retries failed — re-throw original error to preserve .status
  console.error(`AI API failed after ${maxRetries + 1} attempts:`, lastError);
  if (lastError instanceof Error) {
    throw lastError;
  }
  throw new Error(`AI API failed: ${lastError}`);
}

export { streamAICompletion } from './streaming/text-stream';
export type { StreamAICompletionOptions } from './streaming/text-stream';

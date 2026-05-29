/**
 * AI Provider Abstraction Layer
 * Supports Claude and OpenAI with unified interface, retry logic, and monitoring
 */

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { getAIConfig, AI_RETRY_CONFIG } from '../config/constants';
import { notifyAdminWarning } from '../utils/error-notifier';
import { captureError } from '../lib/error-capture';

// Lazy initialization of API clients to avoid build-time errors
let anthropic: Anthropic | null = null;
let openai: OpenAI | null = null;
let gemini: GoogleGenAI | null = null;

export const getAnthropic = () => {
  if (!anthropic) {
    anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      timeout: 25_000,
      maxRetries: 0,
    });
  }
  return anthropic;
};

const getOpenAI = () => {
  if (!openai) {
    openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      timeout: 25_000,
      maxRetries: 0,
    });
  }
  return openai;
};

export const getGemini = () => {
  if (!gemini) {
    gemini = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });
  }
  return gemini;
};

/**
 * Result from AI completion request
 */
export interface AICompletionResult {
  text: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
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
 * Call Claude API with a prompt
 */
async function callClaude(prompt: string, modelId?: string): Promise<AICompletionResult> {
  const config = getAIConfig(modelId);

  // Cap at 8192 to avoid "streaming required for >10 min" error
  // Calendar summaries never need more than ~5000 tokens
  const maxTokens = Math.min(config.MAX_TOKENS, 8192);

  const message = await getAnthropic().messages.create({
    model: config.MODEL_CONFIG.modelId,
    max_tokens: maxTokens,
    messages: [
      {
        role: 'user',
        content: prompt,
      },
    ],
  });

  const textContent = message.content.find(block => block.type === 'text');
  const text =
    textContent && 'text' in textContent ? textContent.text : 'Unable to generate summary.';

  // Check if response was truncated
  if (message.stop_reason === 'max_tokens') {
    console.warn('⚠️ WARNING: Claude response was truncated due to token limit!');
    console.warn(`Used ${message.usage.output_tokens}/${maxTokens} output tokens`);

    // Send alert to admin (non-blocking)
    alertTokenCeiling(
      config.MODEL_CONFIG.displayName,
      message.usage.output_tokens,
      maxTokens
    ).catch(err => captureError(err, 'ai-token-ceiling-alert', {}, 'warning'));
  }

  return {
    text,
    usage: {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      cacheReadTokens: (message.usage as unknown as Record<string, number>).cache_read_input_tokens || undefined,
      cacheCreationTokens: (message.usage as unknown as Record<string, number>).cache_creation_input_tokens || undefined,
    },
    stopReason: message.stop_reason ?? 'unknown',
    model: config.MODEL_CONFIG.displayName,
    responseModel: message.model,
    durationMs: 0,
  };
}

/**
 * Call OpenAI API with a prompt
 */
async function callOpenAI(prompt: string, modelId?: string): Promise<AICompletionResult> {
  const config = getAIConfig(modelId);

  // GPT-5/5.1 and o-series models use 'max_completion_tokens', older models use 'max_tokens'
  const useNewTokenParam = config.MODEL_CONFIG.modelId.startsWith('gpt-5') ||
                           config.MODEL_CONFIG.modelId.startsWith('o1') ||
                           config.MODEL_CONFIG.modelId.startsWith('o3') ||
                           config.MODEL_CONFIG.modelId.startsWith('o4');

  // Use reasoning_effort from model config if specified
  const reasoningEffort = config.MODEL_CONFIG.reasoningEffort;

  const completion = await getOpenAI().chat.completions.create({
    model: config.MODEL_CONFIG.modelId,
    ...(useNewTokenParam
      ? { max_completion_tokens: config.MAX_TOKENS }
      : { max_tokens: config.MAX_TOKENS }
    ),
    ...(reasoningEffort && { reasoning_effort: reasoningEffort }),
    messages: [
      {
        role: 'user',
        content: prompt,
      },
    ],
  });

  const choice = completion.choices[0];
  const text = choice?.message?.content || 'Unable to generate summary.';

  // Debug logging for missing content
  if (!choice?.message?.content) {
    console.error('❌ OpenAI returned no content!');
    console.error('Choice:', JSON.stringify(choice, null, 2));
    console.error('Completion:', JSON.stringify(completion, null, 2));
  }

  // Check if response was truncated
  if (choice?.finish_reason === 'length') {
    const outputTokens = completion.usage?.completion_tokens || 0;
    console.warn('⚠️ WARNING: OpenAI response was truncated due to token limit!');
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
      inputTokens: completion.usage?.prompt_tokens || 0,
      outputTokens: completion.usage?.completion_tokens || 0,
      thinkingTokens: (completion.usage?.completion_tokens_details as Record<string, number> | undefined)?.reasoning_tokens || undefined,
    },
    stopReason: choice?.finish_reason ?? 'unknown',
    model: config.MODEL_CONFIG.displayName,
    responseModel: completion.model,
    durationMs: 0,
    thinkingLevel: config.MODEL_CONFIG.reasoningEffort,
  };
}

/**
 * Call Gemini API with a prompt
 */
async function callGemini(prompt: string, modelId?: string): Promise<AICompletionResult> {
  const config = getAIConfig(modelId);

  const { getGeminiThinkingLevel } = await import('./reminder-cache');
  const thinkingLevel = await getGeminiThinkingLevel();

  const response = await getGemini().models.generateContent({
    model: config.MODEL_CONFIG.modelId,
    contents: prompt,
    config: {
      abortSignal: AbortSignal.timeout(45_000),
      ...(thinkingLevel && {
        thinkingConfig: { thinkingLevel: ThinkingLevel[thinkingLevel as keyof typeof ThinkingLevel] },
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
 * Automatically routes to the configured provider (Claude, OpenAI, or Gemini)
 *
 * @param prompt - The prompt to send to the AI
 * @param modelId - Optional model ID to override default model
 * @returns AI completion result with text and usage statistics
 * @throws Original error if all retries fail (preserves .status for downstream detection)
 */
export async function generateAICompletion(prompt: string, modelId?: string): Promise<AICompletionResult> {
  if (!modelId) {
    const { getDefaultAiModelSetting } = await import('./reminder-cache');
    const adminDefault = await getDefaultAiModelSetting();
    if (adminDefault) modelId = adminDefault;
  }

  let lastError: unknown = null;
  const maxRetries = AI_RETRY_CONFIG.MAX_RETRIES;
  const config = getAIConfig(modelId);

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // Route to the appropriate provider with timing
      const startMs = Date.now();
      let result: AICompletionResult;
      if (config.MODEL_CONFIG.provider === 'claude') {
        result = await callClaude(prompt, modelId);
      } else if (config.MODEL_CONFIG.provider === 'gemini') {
        result = await callGemini(prompt, modelId);
      } else {
        result = await callOpenAI(prompt, modelId);
      }
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

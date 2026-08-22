/**
 * Streaming AI completion.
 *
 * Sibling to generateAICompletion in ai-provider.ts, but emits text deltas as
 * the model writes — used by the 4 user-invoked summary surfaces so the bot can
 * render to Telegram via sendMessageDraft animated drafts.
 *
 * Partial streams can't be safely retried mid-flight, so this function does NOT
 * wrap the call in the retry loop that generateAICompletion uses. Callers are
 * expected to fall back to the buffered path on failure.
 */

import { ThinkingLevel, type GenerateContentResponse } from '@google/genai';
import { getAnthropic, getGemini } from '../ai-provider';
import { getAIConfig } from '../../config/constants';
import { resolveThinkingLevel } from '../../config/ai-models';
import { notifyAdminWarning } from '../../utils/error-notifier';
import { captureError } from '../../lib/error-capture';
import type { AICompletionResult } from '../ai-provider';

export interface StreamAICompletionOptions {
  prompt: string;
  modelId?: string;
  onTextDelta: (delta: string, accumulated: string) => void | Promise<void>;
  abortSignal?: AbortSignal;
}

async function alertTokenCeiling(
  model: string,
  outputTokens: number,
  maxTokens: number
): Promise<void> {
  await notifyAdminWarning(
    'AI Token Ceiling Hit (streaming)',
    `Model: ${model}\nOutput tokens: ${outputTokens}/${maxTokens}\n\nThe streamed AI response was truncated. Consider increasing AI_MAX_TOKENS.`
  );
}

async function streamClaude(
  opts: StreamAICompletionOptions
): Promise<AICompletionResult> {
  const config = getAIConfig(opts.modelId);
  // Streaming removes the 10-minute generation cap that forced the 8192 limit
  // in callClaude, so use the full configured budget.
  const maxTokens = config.MAX_TOKENS;

  let accumulated = '';

  // The shared Anthropic client at ai-provider.ts:22 has timeout 25_000 to
  // bound buffered calls. Streamed calls need longer — the prose summaries
  // can legitimately run 20-30s. Override per-call to 60s; the messaging
  // adapter's own 25s safety guard still persists partial text before the
  // Telegram draft's 30s expiry, so even if the model runs the full minute
  // the user has a real message in their chat by 25s.
  const stream = getAnthropic().messages.stream(
    {
      model: config.MODEL_CONFIG.modelId,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: opts.prompt }],
    },
    {
      timeout: 60_000,
      ...(opts.abortSignal ? { signal: opts.abortSignal } : {}),
    }
  );

  stream.on('text', (delta: string) => {
    accumulated += delta;
    // Fire-and-forget: caller is responsible for backpressure (we buffer the
    // latest text in the TG adapter's flush loop, not per-token).
    void opts.onTextDelta(delta, accumulated);
  });

  const finalMessage = await stream.finalMessage();

  if (finalMessage.stop_reason === 'max_tokens') {
    console.warn('⚠️ WARNING: Claude streamed response was truncated due to token limit!');
    console.warn(`Used ${finalMessage.usage.output_tokens}/${maxTokens} output tokens`);
    alertTokenCeiling(
      config.MODEL_CONFIG.displayName,
      finalMessage.usage.output_tokens,
      maxTokens
    ).catch(err => captureError(err, 'ai-token-ceiling-alert', {}, 'warning'));
  }

  const usage = finalMessage.usage as unknown as Record<string, number>;

  return {
    text: accumulated,
    usage: {
      inputTokens: finalMessage.usage.input_tokens,
      outputTokens: finalMessage.usage.output_tokens,
      cacheReadTokens: usage.cache_read_input_tokens || undefined,
      cacheCreationTokens: usage.cache_creation_input_tokens || undefined,
    },
    stopReason: finalMessage.stop_reason ?? 'unknown',
    model: config.MODEL_CONFIG.displayName,
    responseModel: finalMessage.model,
    durationMs: 0,
  };
}

async function streamGemini(
  opts: StreamAICompletionOptions
): Promise<AICompletionResult> {
  const config = getAIConfig(opts.modelId);

  const { getGeminiThinkingLevel } = await import('../reminder-cache');
  // Same reconciliation as the non-streaming path — see callGemini().
  const thinkingLevel = resolveThinkingLevel(config.MODEL_CONFIG, await getGeminiThinkingLevel());

  const stream = await getGemini().models.generateContentStream({
    model: config.MODEL_CONFIG.modelId,
    contents: opts.prompt,
    config: {
      ...(opts.abortSignal && { abortSignal: opts.abortSignal }),
      ...(thinkingLevel && {
        thinkingConfig: {
          thinkingLevel: ThinkingLevel[thinkingLevel as keyof typeof ThinkingLevel],
        },
      }),
    },
  });

  let accumulated = '';
  let lastChunk: GenerateContentResponse | undefined;

  try {
    for await (const chunk of stream) {
      const delta = chunk.text ?? '';
      if (delta) {
        accumulated += delta;
        void opts.onTextDelta(delta, accumulated);
      }
      lastChunk = chunk;
    }
  } catch (iterError) {
    // Iterator threw mid-stream. We have whatever accumulated so far —
    // capture context and re-throw so callAI can fall back to buffered.
    console.warn(
      `Gemini stream errored mid-flight after ${accumulated.length} chars`,
      iterError
    );
    captureError(
      iterError,
      'gemini-stream-iterator-error',
      { accumulated_chars: accumulated.length, model: config.MODEL_CONFIG.displayName },
      'warning'
    );
    throw iterError;
  }

  const finishReason = lastChunk?.candidates?.[0]?.finishReason || 'STOP';
  const finishReasonStr = String(finishReason);
  const outputTokens = lastChunk?.usageMetadata?.candidatesTokenCount || 0;

  if (finishReasonStr.includes('MAX_TOKENS') || finishReasonStr === 'OTHER') {
    console.warn('⚠️ WARNING: Gemini streamed response may have been truncated!');
    console.warn(`Used ${outputTokens}/${config.MAX_TOKENS} output tokens`);
    alertTokenCeiling(
      config.MODEL_CONFIG.displayName,
      outputTokens,
      config.MAX_TOKENS
    ).catch(err => captureError(err, 'ai-token-ceiling-alert', {}, 'warning'));
  }

  return {
    text: accumulated,
    usage: {
      inputTokens: lastChunk?.usageMetadata?.promptTokenCount || 0,
      outputTokens,
      thinkingTokens:
        (lastChunk?.usageMetadata as Record<string, number> | undefined)?.thoughtsTokenCount ||
        undefined,
    },
    stopReason: finishReasonStr,
    model: config.MODEL_CONFIG.displayName,
    responseModel: (lastChunk as unknown as Record<string, unknown> | undefined)?.modelVersion as
      | string
      | undefined,
    durationMs: 0,
    thinkingLevel: thinkingLevel || undefined,
  };
}

/**
 * Stream an AI completion to the caller via onTextDelta. Returns the same
 * AICompletionResult shape as generateAICompletion once the stream finalizes.
 *
 * Provider dispatch matches generateAICompletion. OpenAI streaming is not
 * implemented — none of the 4 target surfaces routes through OpenAI today.
 */
export async function streamAICompletion(
  opts: StreamAICompletionOptions
): Promise<AICompletionResult> {
  let modelId = opts.modelId;
  if (!modelId) {
    const { getDefaultAiModelSetting } = await import('../reminder-cache');
    const adminDefault = await getDefaultAiModelSetting();
    if (adminDefault) modelId = adminDefault;
  }

  const config = getAIConfig(modelId);
  const startMs = Date.now();

  let result: AICompletionResult;
  if (config.MODEL_CONFIG.provider === 'claude') {
    result = await streamClaude({ ...opts, modelId });
  } else if (config.MODEL_CONFIG.provider === 'gemini') {
    result = await streamGemini({ ...opts, modelId });
  } else {
    throw new Error(
      `streamAICompletion: provider "${config.MODEL_CONFIG.provider}" is not supported for streaming. Use generateAICompletion (buffered) instead.`
    );
  }
  result.durationMs = Date.now() - startMs;

  console.log('AI Streaming Success:', {
    model: result.model,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    stopReason: result.stopReason,
    durationMs: result.durationMs,
  });

  return result;
}

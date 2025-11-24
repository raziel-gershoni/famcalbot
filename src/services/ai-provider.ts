/**
 * AI Provider Abstraction Layer
 * Supports Claude and OpenAI with unified interface, retry logic, and monitoring
 */

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { getAIConfig, AI_RETRY_CONFIG, ADMIN_USER_ID } from '../config/constants';
import { getBot } from './telegram';

// Initialize API clients
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * Result from AI completion request
 */
export interface AICompletionResult {
  text: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
  stopReason: string;
  model: string;
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
  try {
    const bot = getBot();
    await bot.sendMessage(
      ADMIN_USER_ID,
      `⚠️ <b>AI Token Ceiling Hit!</b>

Model: ${model}
Output tokens: ${outputTokens}/${maxTokens}

The AI response was truncated. Consider increasing AI_MAX_TOKENS in environment variables.`,
      { parse_mode: 'HTML' }
    );
  } catch (error) {
    console.error('Failed to send token ceiling alert:', error);
  }
}

/**
 * Call Claude API with a prompt
 */
async function callClaude(prompt: string, modelId?: string): Promise<AICompletionResult> {
  const config = getAIConfig(modelId);

  // Cap at 8192 to avoid "streaming required for >10 min" error
  // Calendar summaries never need more than ~5000 tokens
  const maxTokens = Math.min(config.MAX_TOKENS, 8192);

  const message = await anthropic.messages.create({
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
    ).catch(err => console.error('Alert failed:', err));
  }

  return {
    text,
    usage: {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
    },
    stopReason: message.stop_reason ?? 'unknown',
    model: config.MODEL_CONFIG.displayName,
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

  const completion = await openai.chat.completions.create({
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
    ).catch(err => console.error('Alert failed:', err));
  }

  return {
    text,
    usage: {
      inputTokens: completion.usage?.prompt_tokens || 0,
      outputTokens: completion.usage?.completion_tokens || 0,
    },
    stopReason: choice?.finish_reason ?? 'unknown',
    model: config.MODEL_CONFIG.displayName,
  };
}

/**
 * Generate AI completion with retry logic and exponential backoff
 * Automatically routes to the configured provider (Claude or OpenAI)
 *
 * @param prompt - The prompt to send to the AI
 * @param modelId - Optional model ID to override default model
 * @returns AI completion result with text and usage statistics
 * @throws Error if all retries fail
 */
export async function generateAICompletion(prompt: string, modelId?: string): Promise<AICompletionResult> {
  let lastError: Error | null = null;
  const maxRetries = AI_RETRY_CONFIG.MAX_RETRIES;
  const config = getAIConfig(modelId);

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // Route to the appropriate provider
      const result =
        config.MODEL_CONFIG.provider === 'claude'
          ? await callClaude(prompt, modelId)
          : await callOpenAI(prompt, modelId);

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
      lastError = error instanceof Error ? error : new Error(String(error));

      // Don't retry on last attempt
      if (attempt === maxRetries) {
        break;
      }

      // Calculate exponential backoff delay: 1s, 2s, 4s, 8s, etc.
      const delay = AI_RETRY_CONFIG.INITIAL_RETRY_DELAY * Math.pow(2, attempt);

      console.warn(
        `AI API error (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms:`,
        error
      );

      // Wait before retrying
      await sleep(delay);
    }
  }

  // All retries failed
  console.error(`AI API failed after ${maxRetries + 1} attempts:`, lastError);
  throw new Error(`AI API failed: ${lastError?.message || 'Unknown error'}`);
}

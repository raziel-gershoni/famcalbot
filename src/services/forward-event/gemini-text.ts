/**
 * Gemini Text Processing for Forwarded Messages
 * Sends forwarded message text to Gemini for intent detection + event extraction
 */

import { getGemini, extractionConfig } from '../ai-provider';
import { VoiceIntentResult } from '../event-parser';
import { CalendarAssignment } from '../../types';
import { AI_MODEL_ID } from '../../config/ai-models';
import { buildEventExtractionPrompt, extractIntents, ReminderPromptContext } from '../voice/gemini-voice';

const TEXT_RETRY_CONFIG = {
  maxRetries: 1,
  baseDelayMs: 500,
} as const;

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
 * Where the text came from. In a forwarded message "me" is whoever wrote it; a typed one is
 * the user talking to us (spec §3.1). Forwarded text gets exactly the prompt it always had.
 */
export type TextSource = 'forwarded' | 'typed';

const MESSAGE_HEADERS: Record<TextSource, string> = {
  forwarded: 'FORWARDED MESSAGE:',
  typed: 'TYPED MESSAGE (the user typed this to you directly, it was not forwarded, so "me", "I" and "my" mean the user):',
};

/**
 * Process forwarded message text with Gemini
 * Single API call: intent detection + event extraction
 * Several actions in one message come back as `intentResults`; `intentResult` is the first.
 * `reminders` is given only for users who have reminders: the prompt learns them and the
 * parser reads them.
 */
export async function processTextWithGemini(
  text: string,
  language: string,
  calendars: CalendarAssignment[],
  timezone: string,
  reminders?: ReminderPromptContext,
  source: TextSource = 'forwarded'
): Promise<{ intentResult: VoiceIntentResult; intentResults: VoiceIntentResult[]; metrics: TextProcessingMetrics }> {
  const startTime = Date.now();
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= TEXT_RETRY_CONFIG.maxRetries; attempt++) {
    try {
      const promptText = buildEventExtractionPrompt(language, calendars, timezone, 'text', undefined, reminders);

      const response = await getGemini().models.generateContent({
        model: AI_MODEL_ID,
        ...extractionConfig(AI_MODEL_ID),
        contents: [
          {
            role: 'user',
            parts: [
              { text: promptText + '\n\n' + MESSAGE_HEADERS[source] + '\n' + text },
            ],
          },
        ],
      });

      const duration = Date.now() - startTime;
      const inputTokens = response.usageMetadata?.promptTokenCount || 0;
      const outputTokens = response.usageMetadata?.candidatesTokenCount || 0;

      console.log(`[Forward Gemini] Response in ${duration}ms, model: ${AI_MODEL_ID}, tokens: ${inputTokens}in/${outputTokens}out, attempt: ${attempt + 1}`);

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
      const intentResults = extractIntents(parsed, calendars, timezone, !!reminders);
      const intentResult = intentResults[0];

      return {
        intentResult,
        intentResults,
        metrics: { model: AI_MODEL_ID, inputTokens, outputTokens, durationMs: duration },
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

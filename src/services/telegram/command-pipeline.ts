/**
 * Unified Command Pipeline
 * Single execution path for all user-facing bot commands.
 * Handles progress messages, operation timeouts, error categorization, and admin notifications.
 */

import { IMessagingService, MessageFormat } from '../messaging/types';
import { ProgressType, getProgressText } from '../progress-message';
import { getBotMessages } from '../../lib/bot-messages';

const DEFAULT_OPERATION_TIMEOUT_MS = 50_000;

/**
 * Animated emoji ID for the progress spinner.
 * Set to empty string to fall back to static Unicode hourglass.
 * To discover the ID: send an animated hourglass emoji in Telegram,
 * then use the /emojiid command to extract it.
 */
const ANIMATED_HOURGLASS_EMOJI_ID = '5451732530048802485';

export interface CommandPipelineOptions<T> {
  chatId: number | string;
  progressType: ProgressType;
  language: string;
  existingProgressMessageId?: number;
  messagingService: IMessagingService;
  operationTimeoutMs?: number;
  errorKey: string;
  commandName: string;
  context?: string;
  operation: () => Promise<T>;
  onSuccess: (result: T, messageId: number | string) => Promise<void>;
  onError?: (error: Error, messageId: number | string) => Promise<boolean>;
}

/**
 * Check if an error is an AI overload (429/529) that should not be retried
 */
export function isAIOverloadError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as Record<string, unknown>;
  const status = e.status ?? (e as Record<string, unknown>).statusCode;
  if (status === 429 || status === 529) return true;
  const name = (e as Record<string, unknown>).name;
  if (name === 'RateLimitError') return true;
  return false;
}

class OperationTimeoutError extends Error {
  constructor() {
    super('Operation timed out');
    this.name = 'OperationTimeoutError';
  }
}

/**
 * Build the animated-emoji progress message.
 * Premium users see the animated custom emoji; others see a static hourglass.
 */
function buildProgressHtml(text: string): string {
  if (ANIMATED_HOURGLASS_EMOJI_ID) {
    return `<tg-emoji emoji-id="${ANIMATED_HOURGLASS_EMOJI_ID}">\u231B</tg-emoji> ${text}...`;
  }
  return `\u231B ${text}...`;
}

/**
 * Unified command execution pipeline.
 *
 * 1. Send (or reuse) a progress message with animated emoji
 * 2. Run operation() with a timeout
 * 3. On success  -> onSuccess callback edits the message
 * 4. On error    -> categorise, show localized error, notify admin
 */
export async function executeCommand<T>(opts: CommandPipelineOptions<T>): Promise<void> {
  const {
    chatId,
    progressType,
    language,
    existingProgressMessageId,
    messagingService,
    operationTimeoutMs = DEFAULT_OPERATION_TIMEOUT_MS,
    errorKey,
    commandName,
    context,
    operation,
    onSuccess,
    onError,
  } = opts;

  // 1. Progress message
  let messageId: number | string;
  const progressText = getProgressText(progressType, language);
  const progressHtml = buildProgressHtml(progressText);

  if (existingProgressMessageId) {
    messageId = existingProgressMessageId;
    try {
      await messagingService.updateMessage(chatId, messageId, progressHtml, { format: MessageFormat.HTML });
    } catch {
      // If update fails, the existing message still shows the old progress text — acceptable
    }
  } else {
    messageId = await messagingService.sendMessage(chatId, progressHtml, { format: MessageFormat.HTML });
  }

  // 2. Run operation with timeout
  try {
    const result = await Promise.race<T>([
      operation(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new OperationTimeoutError()), operationTimeoutMs)
      ),
    ]);

    // 3. Success
    await onSuccess(result, messageId);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error(`[${commandName}] Error:`, error);

    // Let custom handler run first
    if (onError) {
      try {
        const handled = await onError(error, messageId);
        if (handled) return;
      } catch (handlerErr) {
        console.error(`[${commandName}] onError handler failed:`, handlerErr);
      }
    }

    // 4. Determine error message key
    const t = await getBotMessages(language);
    let userMessage: string;

    if (error instanceof OperationTimeoutError) {
      userMessage = t.errors?.timeout || 'Sorry, the request took too long. Please try again.';
    } else if (isAIOverloadError(err)) {
      userMessage = t.errors?.aiBusy || 'The AI service is currently busy. Please try again in a few minutes.';
    } else {
      userMessage = t.errors?.[errorKey] || t.errors?.generic || 'Sorry, there was an error. Please try again later.';
    }

    // Update progress message with error (wrapped in try-catch)
    try {
      await messagingService.updateMessage(chatId, messageId, userMessage);
    } catch (updateErr) {
      console.error(`[${commandName}] Failed to update message with error:`, updateErr);
    }

    // Notify admin (wrapped in try-catch)
    try {
      const { notifyAdminError } = await import('../../utils/error-notifier');
      await notifyAdminError(commandName, error, context);
    } catch (notifyErr) {
      console.error(`[${commandName}] Failed to notify admin:`, notifyErr);
    }
  }
}

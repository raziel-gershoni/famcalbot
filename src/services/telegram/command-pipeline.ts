/**
 * Unified Command Pipeline
 * Single execution path for all user-facing bot commands.
 * Uses typing indicators instead of progress messages, with error handling and admin notifications.
 */

import { IMessagingService, MessageFormat } from '../messaging/types';
import { getBotMessages } from '../../lib/bot-messages';

const DEFAULT_OPERATION_TIMEOUT_MS = 50_000;
const TYPING_INTERVAL_MS = 4_000;

export interface CommandPipelineOptions<T> {
  chatId: number | string;
  language: string;
  messagingService: IMessagingService;
  operationTimeoutMs?: number;
  errorKey: string;
  commandName: string;
  context?: string;
  typingType?: 'text' | 'audio' | 'photo';
  operation: () => Promise<T>;
  onSuccess: (result: T) => Promise<void>;
  onError?: (error: Error) => Promise<boolean>;
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
 * Start a repeating typing indicator that fires every 4s.
 * Returns a cleanup function.
 * @param typingType - 'text' for typing, 'audio' for recording audio
 * @param messageId - WA inbound message ID (required for WA typing)
 */
export function startTypingInterval(
  chatId: number | string,
  service: IMessagingService,
  typingType: 'text' | 'audio' | 'photo' = 'text',
  messageId?: string
): () => void {
  service.sendTypingIndicator(chatId, messageId, typingType).catch(() => {});
  const interval = setInterval(() => {
    service.sendTypingIndicator(chatId, messageId, typingType).catch(() => {});
  }, TYPING_INTERVAL_MS);
  return () => clearInterval(interval);
}

/**
 * Unified command execution pipeline.
 *
 * 1. Start typing indicator (repeating every 4s)
 * 2. Run operation() with a timeout
 * 3. On success  -> onSuccess callback sends the result
 * 4. On error    -> send error as new message, notify admin
 */
export async function executeCommand<T>(opts: CommandPipelineOptions<T>): Promise<void> {
  const {
    chatId,
    language,
    messagingService,
    operationTimeoutMs = DEFAULT_OPERATION_TIMEOUT_MS,
    errorKey,
    commandName,
    context,
    typingType,
    operation,
    onSuccess,
    onError,
  } = opts;

  // 1. Start typing indicator
  const stopTyping = startTypingInterval(chatId, messagingService, typingType);

  // 2. Run operation with timeout
  try {
    const result = await Promise.race<T>([
      operation(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new OperationTimeoutError()), operationTimeoutMs)
      ),
    ]);

    stopTyping();

    // 3. Success
    await onSuccess(result);
  } catch (err) {
    stopTyping();

    const error = err instanceof Error ? err : new Error(String(err));
    console.error(`[${commandName}] Error:`, error);

    // Let custom handler run first
    if (onError) {
      try {
        const handled = await onError(error);
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

    // Send error as new message
    try {
      await messagingService.sendMessage(chatId, userMessage);
    } catch (sendErr) {
      console.error(`[${commandName}] Failed to send error message:`, sendErr);
    }

    // Notify admin
    try {
      const { notifyAdminError } = await import('../../utils/error-notifier');
      await notifyAdminError(commandName, error, context);
    } catch (notifyErr) {
      console.error(`[${commandName}] Failed to notify admin:`, notifyErr);
    }
  }
}

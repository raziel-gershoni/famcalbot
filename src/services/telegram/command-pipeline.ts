/**
 * Unified Command Pipeline
 * Single execution path for all user-facing bot commands.
 * Uses typing indicators instead of progress messages, with error handling and admin notifications.
 */

import { IMessagingService, StreamMessageHandle } from '../messaging/types';
import { getBotMessages } from '../../lib/bot-messages';
import { trackActivityAsync } from '../analytics-service';

const DEFAULT_OPERATION_TIMEOUT_MS = 50_000;
const TYPING_INTERVAL_MS = 4_000;

export interface CommandPipelineOptions<T> {
  chatId: number | string;
  language: string;
  messagingService: IMessagingService;
  operationTimeoutMs?: number;
  errorKey: string;
  commandName: string;
  /** The user's DB id: when set, an error the pipeline shows the user is logged as user_error_shown. */
  userId?: number;
  context?: string;
  typingType?: 'text' | 'audio' | 'photo';
  operation: () => Promise<T>;
  onSuccess: (result: T) => Promise<void>;
  onError?: (error: Error) => Promise<boolean>;
  /** When set, the default error path collapses the in-flight draft into the error message instead of opening a separate sendMessage. */
  streamHandle?: StreamMessageHandle;
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
 *
 * Resolves true when the operation and onSuccess both ran to the end, false when it failed
 * (whether the error was answered by onError or by the default message).
 */
export async function executeCommand<T>(opts: CommandPipelineOptions<T>): Promise<boolean> {
  const {
    chatId,
    language,
    messagingService,
    operationTimeoutMs = DEFAULT_OPERATION_TIMEOUT_MS,
    errorKey,
    commandName,
    userId,
    context,
    typingType,
    operation,
    onSuccess,
    onError,
    streamHandle,
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
    return true;
  } catch (err) {
    stopTyping();

    const error = err instanceof Error ? err : new Error(String(err));
    console.error(`[${commandName}] Error:`, error);

    // Let custom handler run first
    if (onError) {
      try {
        const handled = await onError(error);
        if (handled) {
          // The handler answered the user itself (a Google read problem, say).
          if (userId !== undefined) trackActivityAsync(userId, 'user_error_shown', { error_type: errorKey, command: commandName, handled: true });
          return false;
        }
      } catch (handlerErr) {
        console.error(`[${commandName}] onError handler failed:`, handlerErr);
      }
    }

    // 4. Determine error message key
    const t = await getBotMessages(language);
    let userMessage: string;

    let errorType: string;
    if (error instanceof OperationTimeoutError) {
      userMessage = t.errors?.timeout || 'Sorry, the request took too long. Please try again.';
      errorType = 'timeout';
    } else if (isAIOverloadError(err)) {
      userMessage = t.errors?.aiBusy || 'The AI service is currently busy. Please try again in a few minutes.';
      errorType = 'ai_busy';
    } else {
      userMessage = t.errors?.[errorKey] || t.errors?.generic || 'Sorry, there was an error. Please try again later.';
      errorType = errorKey;
    }

    // Send error as new message. When a streaming draft is open, collapse it
    // into the error so the user doesn't see a stale "Composing…" placeholder
    // sitting above the error message.
    try {
      if (streamHandle) {
        await streamHandle.cancel(userMessage);
      } else {
        await messagingService.sendMessage(chatId, userMessage);
      }
      if (userId !== undefined) trackActivityAsync(userId, 'user_error_shown', { error_type: errorType, command: commandName });
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
    return false;
  }
}

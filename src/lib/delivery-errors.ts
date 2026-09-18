/**
 * Classification of delivery failures.
 *
 * Telegram answers a send to someone who has blocked the bot with
 * `403 Forbidden: bot was blocked by the user`. node-telegram-bot-api surfaces that
 * as a TelegramError with `code = 'ETELEGRAM'` and the API response on
 * `response.body`, and a message of the form
 * `ETELEGRAM: 403 Forbidden: bot was blocked by the user`.
 *
 * This is a terminal state, not a transient one: retrying tomorrow produces the same
 * 403. It has to be distinguishable from an ordinary failure so callers can stop
 * retrying and stop paging an admin about it.
 */

/** Why a send failed, when we can tell. */
export type DeliveryFailure = 'unreachable' | 'other';

interface TelegramErrorShape {
  code?: string;
  message?: string;
  response?: { body?: { error_code?: number; description?: string } };
}

// 403 descriptions that mean "this chat will never accept our messages again".
// Kept as substrings because Telegram has changed the exact wording before.
const TERMINAL_403_MARKERS = [
  'bot was blocked by the user',
  'user is deactivated',
  'bot was kicked',
  'chat not found',
  'bot is not a member',
];

/**
 * True when the chat is permanently undeliverable.
 *
 * Deliberately narrow: it requires a 403 AND a recognised description. A bare 403 with
 * unfamiliar wording returns false, because the cost of a false positive here is
 * silently disabling summaries for a reachable user, which is far worse than one more
 * admin warning.
 */
export function isUnreachableError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const err = error as TelegramErrorShape;

  const status = err.response?.body?.error_code;
  const description = err.response?.body?.description ?? '';
  const message = typeof err.message === 'string' ? err.message : '';

  // Structured form: what node-telegram-bot-api attaches to the error.
  if (status === 403 && TERMINAL_403_MARKERS.some(m => description.toLowerCase().includes(m))) {
    return true;
  }

  // Fallback: the flattened message, for paths where the response body is lost
  // (re-thrown errors, serialized errors crossing a boundary).
  const lower = message.toLowerCase();
  if (lower.includes('403') && TERMINAL_403_MARKERS.some(m => lower.includes(m))) {
    return true;
  }

  return false;
}

export function classifyDeliveryFailure(error: unknown): DeliveryFailure {
  return isUnreachableError(error) ? 'unreachable' : 'other';
}

/** Short, log-safe reason string. */
export function describeDeliveryError(error: unknown): string {
  if (!error) return 'Unknown error';
  const err = error as TelegramErrorShape;
  return err.response?.body?.description || err.message || 'Unknown error';
}

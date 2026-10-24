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
 *
 * WhatsApp Cloud API failures are classified by Meta's error code, from the API's JSON
 * error body (the adapter's "WhatsApp API error: {...}" message) or from a failed delivery
 * status webhook. See WHATSAPP_UNREACHABLE_CODES for which codes count and why.
 */

/** Why a send failed, when we can tell. */
export type DeliveryFailure = 'unreachable' | 'other';

interface TelegramErrorShape {
  code?: string;
  message?: string;
  /** A WhatsApp error object attached to the thrown error, e.g. a failed delivery status's errors[0]. */
  whatsappError?: { code?: number };
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
 * WhatsApp Cloud API error codes that mean this recipient cannot receive our messages.
 * Source: https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes/
 *  - 131026 "Unable to deliver message": the recipient's number is not a WhatsApp number,
 *    they have not accepted WhatsApp's new Terms of Service, or run an old WhatsApp version.
 *    All recipient-side; Meta's remedy is on the recipient (confirm they can message us).
 *
 * Deliberately NOT here: 131047 (24-hour window: a template fixes it), 131056 and 130429
 * (rate limits), 131000 (unknown, retry), 131050 (opted out of marketing only, other
 * messages still arrive), 131403 (we blocked them), 131049 (engagement limit, wait),
 * and the sender-side ones (131031, 131045, 133010, 368, 80007, 131021).
 */
const WHATSAPP_UNREACHABLE_CODES = new Set([131026]);

const WHATSAPP_API_ERROR_PREFIX = 'WhatsApp API error:';

/** The Cloud API error code in a thrown error, or null. */
export function whatsappErrorCode(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const err = error as TelegramErrorShape;
  if (typeof err.whatsappError?.code === 'number') return err.whatsappError.code;
  const message = typeof err.message === 'string' ? err.message : '';
  if (!message.startsWith(WHATSAPP_API_ERROR_PREFIX)) return null;
  // The adapter's message is the API body as JSON: {"error":{"message":..,"type":..,"code":131026,..}}
  const match = /"code"\s*:\s*(\d+)/.exec(message);
  return match ? Number(match[1]) : null;
}

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

  const waCode = whatsappErrorCode(error);
  if (waCode !== null) return WHATSAPP_UNREACHABLE_CODES.has(waCode);

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

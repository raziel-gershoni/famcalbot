// The smokes' Telegram failures, built with node-telegram-bot-api 2.x's own error classes (dist/core/errors.js), with
// the messages its transport gives them (dist/core/transport.js), so a fake cannot drift from what the library throws.

import { NetworkError, ParseError, TelegramApiError } from 'node-telegram-bot-api';

/** Telegram's own refusal, as 2.4.0 throws it (`code` ETELEGRAM, message `<status>: <description>`). */
export function tgRefused(status: number, description: string, retryAfterSeconds?: number): Error {
  return new TelegramApiError(status, description, retryAfterSeconds === undefined ? undefined : { retry_after: retryAfterSeconds });
}
/** No answer: fetch threw (`code` EFETCH). */
export function tgNoAnswer(method = 'sendMessage', causeMessage = 'fetch failed'): Error {
  return new NetworkError(`Network request failed: ${method}`, { cause: new TypeError(causeMessage) });
}
/** A 5xx whose body is not Telegram's JSON (a gateway's page): 2.4.0 throws a NetworkError, the status only in the words. */
export function tgServerPage(status: number, method = 'sendMessage'): Error {
  return new NetworkError(`Server error ${status} on ${method}`);
}
/** An answer under 500 that is not JSON (a proxy's page): `code` EPARSE, no status. */
export function tgUnreadable(method = 'sendMessage'): Error {
  return new ParseError(`Invalid JSON in response to ${method}`, { responseText: '<html>' });
}

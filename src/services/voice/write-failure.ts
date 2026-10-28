/**
 * What a person is told when a create, an edit or a delete they confirmed (a voice or text card, on Telegram or on
 * WhatsApp, or one event of a batch) does not go through. The one place that turns a provider's failure into words:
 * the provider's own text (Prisma's, the rule parser's, Google's English) and its bare code never reach the person.
 * The failure is logged here, with the provider's text, so it can be debugged in prod.
 *
 * A Telegram branch that carries a button (PERMISSION_DENIED, TOKEN_EXPIRED, FORBIDDEN) keeps its own text and is
 * answered by its caller; everything else comes here.
 */

import type { BotMessages } from '../../lib/bot-messages';
import type { ProviderErrorCode } from '../calendar-provider/types';

export type WriteAction = 'create' | 'update' | 'delete';

/** The provider's answer to a failed write: the parts this module reads. */
export interface WriteFailure {
  error?: ProviderErrorCode;
  errorMessage?: string;
  retryable?: boolean;
}

/** Whose failure it was, for the log line. */
export interface WriteFailureLog {
  userId: number;
  calendarId?: string;
}

const HEADING = { create: 'failedToCreate', update: 'failedToUpdate', delete: 'failedToDelete' } as const;

function logFailure(result: WriteFailure, action: WriteAction, log: WriteFailureLog): void {
  const where = `user ${log.userId}${log.calendarId ? `, calendar ${log.calendarId}` : ''}`;
  console.error(
    `[voice-write] ${action} failed code=${result.error ?? 'none'} retryable=${result.retryable === true}: ${result.errorMessage ?? '(no message)'} (${where})`
  );
}

/** The sentence a failure has of its own, or null when it is only "that failed" (a code with nothing more to say). */
function ownSentence(result: WriteFailure, t: BotMessages): string | null {
  switch (result.error) {
    case 'NOT_FOUND':
      return t.voice.eventNotFound;
    case 'FIXED_DAYS':
      return t.voice.fixedDaysMove;
    case 'NOT_CONNECTED':
      return t.voice.googleNotConnected;
    case 'HEBREW_REPEAT':
      return t.voice.googleNoHebrewRepeat;
    default:
      return result.retryable ? t.voice.writeRetry : null;
  }
}

/** The failure as a message: its own sentence, or the action's heading and "Unknown error occurred." */
export function writeFailureText(result: WriteFailure, t: BotMessages, action: WriteAction, log: WriteFailureLog): string {
  logFailure(result, action, log);
  return ownSentence(result, t) ?? `${t.voice[HEADING[action]]}\n\n${t.voice.unknownError}`;
}

/** Only the reason, one line for a list of failures (one event of a batch): its own sentence, or "Unknown error occurred." */
export function writeFailureReason(result: WriteFailure, t: BotMessages, action: WriteAction, log: WriteFailureLog): string {
  logFailure(result, action, log);
  return ownSentence(result, t) ?? t.voice.unknownError;
}

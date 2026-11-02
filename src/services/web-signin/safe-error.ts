/**
 * Failures on the sign-in paths, told without what they carry. An error's message can hold the input that caused it
 * (JSON.parse quotes the body it read, Prisma prints the query's values), and the input here is an email address or a
 * code, so a console line or a Sentry report names only the error's kind: its name, a Prisma or system code, an HTTP
 * status. An error this code throws itself is a SafeSignInError, whose message holds neither and is kept.
 * Server only.
 */

import { captureError } from '../../lib/error-capture';
import { HttpStatusError } from '../../utils/fetch-retry';

/** An error whose message is known to hold no address, code, token or state. */
export class SafeSignInError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SafeSignInError';
  }
}

/** What went wrong, without the error's message: e.g. "PrismaClientKnownRequestError P2002", "HTTP 422", "TypeError ECONNRESET". */
export function safeErrorSummary(error: unknown): string {
  if (error instanceof SafeSignInError) return error.message;
  if (error instanceof HttpStatusError) return `HTTP ${error.status}`;
  if (!(error instanceof Error)) return `a thrown ${typeof error}`;
  const code = (error as { code?: unknown }).code;
  const causeCode = (error.cause as { code?: unknown } | null | undefined)?.code;
  return [error.name, typeof code === 'string' ? code : null, typeof causeCode === 'string' ? causeCode : null].filter(Boolean).join(' ');
}

/** Logs and reports a failure (captureError) by its kind only, with the user id and route when known. */
export function captureSignInFailure(
  error: unknown,
  context: string,
  extra: { user_id?: number; api_route?: string; purpose?: string } = {}
): void {
  captureError(new SafeSignInError(`${context}: ${safeErrorSummary(error)}`), context, extra);
}

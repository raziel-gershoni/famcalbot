/**
 * The one retry loop for calls to a third party FamCal has no policy of its own for: MET Norway's forecast, Copernicus's
 * dust files, every browser push service (web-push/send.ts), FCM included, and WhatsApp's Cloud API
 * (messaging/whatsapp-adapter.ts: sends, uploads, the typing indicator, media downloads). Spec
 * docs/superpowers/specs/2026-10-31-open-meteo-replacement-design.md, and 2026-11-05-web-push-design.md §3.4.
 *
 *   retryWithBackoff   any async step: a failure is retried up to 3 times after max(what the server asked, a full-jitter
 *                      backoff from 500 ms); an ask over 10 s, or a failure the caller calls not retryable, is thrown at
 *                      once; the last error is thrown itself. onRetry runs before each wait (log, drop a stale cache),
 *                      onGiveUp once before the throw (the one place to log the failure).
 *   fetchWithRetry     fetch on top of it: 429, 5xx and no answer retried, Retry-After honoured; any other status
 *                      (403, 404 ...) fails at once as an HttpStatusError; a status the caller accepts (a 304) is an answer
 *   fetchAndReadWithRetry  the same with the body read inside the attempt (a GET), so a body that comes cut off or does
 *                      not parse is retried like no answer
 *
 * No timeout of our own: a call runs to the provider's ceiling (CLAUDE.md), and the retry is what handles its failure.
 * Google's APIs are NOT here: every Google API call goes through src/services/google-retry.ts, which has its own rules.
 * A push to Google's FCM (fcm.googleapis.com) is a push service's call, not a Google API's, so it is here.
 * Server only. Tests skip the waits through __useRetryForTests.
 */

import { retryAfterMs } from '../services/calendar-read/google-map';

/** Whether a failure is worth another attempt, and how long the server asked to wait before it (ms). */
export interface RetryVerdict {
  retry: boolean;
  askedMs?: number;
}

/** What a caller of the loop can set; each has the default the plan's constraints give. */
export interface RetryOptions {
  /** Retries after the first attempt. Default 3. */
  maxRetries?: number;
  /** A retry n (0, 1, 2 ...) waits random() * baseMs * 2^n ms at most. Default 500. */
  baseMs?: number;
  /** A wait the server asks for (Retry-After) longer than this fails at once instead. Default 10 000. */
  maxAskedMs?: number;
  /** Prefix of the loop's console lines, e.g. '[weather-forecast]'. Default '[retry]'. */
  label?: string;
  /** Whether a failure is worth another attempt, and how long the server asked to wait. Default: every failure, no ask. */
  retryable?: (error: unknown) => RetryVerdict;
  /** Before each wait: log, retire a reader whose file changed, forget a cache. Awaited; a throw ends the loop. */
  onRetry?: (info: { error: unknown; retry: number; maxRetries: number; waitMs: number }) => void | Promise<void>;
  /** Once, just before the last error is thrown: why it gave up. The caller logs the failure here. */
  onGiveUp?: (error: unknown, info: { retried: number; why: string }) => void;
}

/** A response that was not an answer: its status, and how long the server asked to wait (Retry-After), if it did. */
export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
    super(`HTTP ${status}`);
    this.name = 'HttpStatusError';
  }
}

// ---- The test seam: the waits, the jitter and the clock ----

interface Seam {
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  now: () => number;
}
const seamState = globalThis as { __famcalRetryForTests?: Partial<Seam> | null };
/** Tests only: replaces the waits, the jitter and the clock (Retry-After as a date counts from it). */
export function __useRetryForTests(seam: Partial<Seam> | null): void {
  seamState.__famcalRetryForTests = seam;
}
const seam = (): Seam => ({ sleep: ms => new Promise(resolve => setTimeout(resolve, ms)), random: Math.random, now: () => Date.now(), ...seamState.__famcalRetryForTests });

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs `attempt`, retrying a failure with backoff. Returns its value; throws the last error unchanged once it has given
 * up (see RetryOptions).
 */
export async function retryWithBackoff<T>(attempt: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { maxRetries = 3, baseMs = 500, maxAskedMs = 10_000, label = '[retry]', retryable = (): RetryVerdict => ({ retry: true }), onRetry, onGiveUp } = options;
  for (let retried = 0; ; retried++) {
    try {
      return await attempt();
    } catch (error) {
      const verdict = retryable(error);
      const asked = verdict.askedMs;
      const why = !verdict.retry
        ? 'not retryable'
        : retried === maxRetries
          ? `gave up after ${retried} retries`
          : asked !== undefined && asked > maxAskedMs
            ? `Retry-After ${asked} ms is over the ${maxAskedMs} ms cap`
            : null;
      if (why !== null) {
        onGiveUp?.(error, { retried, why });
        throw error;
      }
      const waitMs = Math.max(asked ?? 0, Math.round(seam().random() * baseMs * 2 ** retried));
      console.warn(`${label} ${describe(error)}; retry ${retried + 1} of ${maxRetries} in ${waitMs} ms`);
      await onRetry?.({ error, retry: retried + 1, maxRetries, waitMs });
      await seam().sleep(waitMs);
    }
  }
}

/** Retryable: no answer (fetch threw), 429 and 5xx; Retry-After is the server's ask. Everything else is a refusal. */
function retryableFetchFailure(error: unknown): RetryVerdict {
  if (!(error instanceof HttpStatusError)) return { retry: true };
  return { retry: error.status === 429 || error.status >= 500, askedMs: error.retryAfterMs };
}

export interface FetchRetryOptions extends Omit<RetryOptions, 'retryable'> {
  /** Statuses besides 2xx that are an answer, not a failure: a 304 for a request with If-Modified-Since. */
  okStatuses?: readonly number[];
}

/**
 * fetch with the retries above. Resolves with a 2xx (or an accepted) response; throws an HttpStatusError for a refusal or
 * for a 429/5xx that ran out of retries, and the fetch error itself for no answer that ran out of retries.
 */
export function fetchWithRetry(url: string, init: RequestInit = {}, options: FetchRetryOptions = {}): Promise<Response> {
  return fetchAndReadWithRetry(url, init, async response => response, options);
}

/**
 * fetchWithRetry with the answer's body read in the same attempt, for a request that is safe to send again (a GET):
 * `read` turns a 2xx (or an accepted) response into the value, and a read that throws (a body cut off on the way, which
 * fetch can hand over whole-looking when it was compressed, or one that does not parse) is retried like no answer.
 * Its error message is in the loop's console lines: never put the body in it.
 */
export async function fetchAndReadWithRetry<T>(url: string, init: RequestInit, read: (response: Response) => Promise<T>, options: FetchRetryOptions = {}): Promise<T> {
  const { okStatuses = [], ...retry } = options;
  return retryWithBackoff(async () => {
    const response = await fetch(url, init);
    if (response.ok || okStatuses.includes(response.status)) return read(response);
    // Free the connection: the body of a refusal is of no use to us. Not awaited, so a stream that is slow to close can't hold the retry.
    response.body?.cancel().catch(error => console.warn(`${retry.label ?? '[retry]'} could not drop the body of a ${response.status}: ${describe(error)}`));
    throw new HttpStatusError(response.status, retryAfterMs({ response: { headers: response.headers } }, seam().now()));
  }, { ...retry, retryable: retryableFetchFailure });
}

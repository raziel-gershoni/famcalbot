// The one retry policy for every call to Google: the Calendar API through the OAuth2
// client's transporter (getGoogleAuth, calendar.ts), and the few raw fetch calls (googleFetch).
//
// What is retried, and when:
// - 408, 429, any 5xx, an answer that never came (no response), and a 403 whose reason is
//   rateLimitExceeded or userRateLimitExceeded (Calendar's own way of saying "too fast").
// - quotaExceeded and dailyLimitExceeded are never retried here: a wait of seconds does not
//   clear them. The caller, or the durable layer behind it (the copy worker's cooldown), decides.
// - A POST to the Calendar API (events.insert, calendars.insert, events.move) is retried only
//   when Google refused it before processing: 429 and the two 403 reasons. A 5xx or a lost
//   answer might hide a create that went through, and a retry would make a duplicate. GET, PUT,
//   PATCH and DELETE are retried on everything above. The token endpoint (oauth2.googleapis.com)
//   is not the Calendar API: its POSTs (refresh, revoke, the code exchange) repeat safely.
// - At most 3 retries (MAX_RETRIES), a caller's own `retry` lowering it (the calendar reader
//   keeps its per-call retry: 1). Enforced here, in shouldRetry: gaxios's own guard is replaced
//   by a custom shouldRetry, and a hook that forgot the count would loop for ever.
//
// How long it waits: max(Retry-After, full-jitter exponential from 500 ms). A Retry-After over
// the inline cap (10 s) is not slept on: the original error is thrown at once, and the caller
// can still read retryAfterMs(e) to decide later. A wait that would end at or after the
// caller's deadline (getGoogleAuth's deadlineAt, the reader's) is not slept on either. The
// sleep ends when the request's signal aborts, and clears its timer, so a read that has
// answered leaves nothing running. The cap bounds a sleep, never a Google call.
//
// Every retry is one console line (the request without its query or ids, the status and
// reasons, the attempt, the wait, Retry-After) and never a body or a header. The final
// failure goes on to the callers' own captureError.

import { BRIEF_RATE_LIMIT_REASONS, LONG_QUOTA_REASONS, googleErrorFacts, retryAfterMs } from './calendar-read/google-map';

export const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 500;
/** The longest Retry-After slept on inside a request; a longer one is handed to the caller. */
export const INLINE_RETRY_AFTER_CAP_MS = 10_000;
/** gaxios's own default for answers that never came, kept when the caller sets none. */
const NO_RESPONSE_RETRIES = 2;
const LOG = '[google-retry]';

// ---- The clock and the dice, replaceable by a smoke ----

export interface Seam {
  /** Waits `ms`, or rejects at once when `signal` aborts. */
  sleep: (ms: number, signal?: AbortSignal | null) => Promise<void>;
  random: () => number;
  now: () => number;
}

function abortError(): Error {
  // What node-fetch rejects with when the request's signal is aborted.
  return Object.assign(new Error('The user aborted a request.'), { name: 'AbortError', type: 'aborted' });
}

function abortableSleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    if (ms <= 0) return resolve();
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const seamState = globalThis as { __googleRetryForTests?: Partial<Seam> | null };

/** Smoke scripts only: the sleep, the random source and the clock this policy uses (null: the real ones again). */
export function __useGoogleRetryForTests(seam: Partial<Seam> | null): void {
  seamState.__googleRetryForTests = seam;
}

const seam = (): Seam => ({ sleep: abortableSleep, random: Math.random, now: () => Date.now(), ...seamState.__googleRetryForTests });

// ---- The decision, a pure rule ----

/** What a failed attempt tells the policy. */
export interface RetryAttempt {
  /** Upper-case. */
  method: string;
  url?: string;
  /** Absent when no answer came. */
  status?: number;
  reasons: readonly string[];
  /** The Retry-After the answer carried, in ms. */
  retryAfterMs?: number;
  aborted: boolean;
  /** Retries already made. */
  retried: number;
  /** The most retries this call allows (already at most MAX_RETRIES). */
  maxRetries: number;
  /** The most retries for an answer that never came. */
  noResponseRetries: number;
  /** Epoch ms the caller cannot wait past. */
  deadlineAt?: number;
}

export type RetryPlan = { retry: true; waitMs: number } | { retry: false; why: string };

/** A POST to the Calendar API is a create (or a move): only the token endpoint's POSTs repeat safely. */
const isCreate = (a: RetryAttempt) => a.method === 'POST' && !/^https:\/\/oauth2\.googleapis\.com\//.test(a.url ?? '');

/** Whether to retry a failed attempt, and the wait before it. */
export function planRetry(a: RetryAttempt, env: Seam = seam()): RetryPlan {
  if (a.aborted) return { retry: false, why: 'aborted' };
  if (a.retried >= a.maxRetries) return { retry: false, why: 'attempts used' };
  if (a.reasons.some((r) => LONG_QUOTA_REASONS.has(r))) return { retry: false, why: 'quota' };
  if (a.status === undefined) {
    if (isCreate(a)) return { retry: false, why: 'a create with no answer' };
    if (a.retried >= a.noResponseRetries) return { retry: false, why: 'no-answer attempts used' };
  } else {
    const refusedFirst = a.status === 429 || (a.status === 403 && a.reasons.some((r) => BRIEF_RATE_LIMIT_REASONS.has(r)));
    const transient = a.status === 408 || (a.status >= 500 && a.status <= 599);
    if (!refusedFirst && !transient) return { retry: false, why: 'status' };
    if (isCreate(a) && !refusedFirst) return { retry: false, why: 'a create that may have gone through' };
  }
  if (a.retryAfterMs !== undefined && a.retryAfterMs > INLINE_RETRY_AFTER_CAP_MS) return { retry: false, why: 'retry-after over the cap' };
  const jitter = Math.round(env.random() * BACKOFF_BASE_MS * 2 ** a.retried);
  const waitMs = Math.max(a.retryAfterMs ?? 0, jitter);
  if (a.deadlineAt !== undefined && env.now() + waitMs >= a.deadlineAt) return { retry: false, why: 'deadline' };
  return { retry: true, waitMs };
}

/** The reasons that end a wait the caller would otherwise have made: worth a line, unlike a plain 404. */
const WORTH_A_LINE = new Set(['retry-after over the cap', 'deadline']);

function logRetry(request: string, status: number | undefined, reasons: readonly string[], attempt: number, max: number, waitMs: number, asked: number | undefined): void {
  const answer = status === undefined ? 'got no answer' : `answered ${status}${reasons.length > 0 ? ` (${reasons.join(', ')})` : ''}`;
  console.warn(`${LOG} ${request} ${answer}; retry ${attempt} of ${max} in ${waitMs} ms${asked !== undefined ? ` (Retry-After ${asked} ms)` : ''}`);
}

function logGaveUp(request: string, status: number | undefined, reasons: readonly string[], plan: Extract<RetryPlan, { retry: false }>, retried: number, asked: number | undefined): void {
  if (!WORTH_A_LINE.has(plan.why) && !(plan.why === 'attempts used' && retried > 0)) return;
  const answer = status === undefined ? 'got no answer' : `answered ${status}${reasons.length > 0 ? ` (${reasons.join(', ')})` : ''}`;
  console.warn(`${LOG} ${request} ${answer}; not retried (${plan.why}${asked !== undefined ? `, Retry-After ${asked} ms` : ''}) after ${retried} ${retried === 1 ? 'retry' : 'retries'}`);
}

// ---- The gaxios hooks ----

/** What the hooks read of a gaxios error (structural: gaxios' own types are not imported). */
interface HookError {
  name?: unknown;
  error?: unknown;
  response?: unknown;
  config?: unknown;
}

interface HookConfig {
  method?: unknown;
  url?: unknown;
  signal?: AbortSignal | null;
  retryConfig?: { retry?: unknown; currentRetryAttempt?: unknown; noResponseRetries?: unknown };
}

const configOf = (err: HookError): HookConfig => (err.config && typeof err.config === 'object' ? (err.config as HookConfig) : {});

function attemptOf(err: HookError, deadlineAt: number | undefined, now: number): RetryAttempt & { request: string } {
  const facts = googleErrorFacts(err);
  const config = configOf(err);
  const state = config.retryConfig ?? {};
  const cause = err.error && typeof err.error === 'object' ? (err.error as { name?: unknown }) : undefined;
  const asked = retryAfterMs(err, now);
  const allowed = typeof state.retry === 'number' ? state.retry : MAX_RETRIES;
  return {
    method: typeof config.method === 'string' ? config.method.toUpperCase() : 'GET',
    url: config.url === undefined ? undefined : String(config.url),
    status: facts.status,
    reasons: facts.reasons,
    ...(asked !== undefined ? { retryAfterMs: asked } : {}),
    aborted: err.name === 'AbortError' || cause?.name === 'AbortError' || config.signal?.aborted === true,
    retried: typeof state.currentRetryAttempt === 'number' ? state.currentRetryAttempt : 0,
    maxRetries: Math.min(allowed, MAX_RETRIES),
    noResponseRetries: typeof state.noResponseRetries === 'number' ? state.noResponseRetries : NO_RESPONSE_RETRIES,
    ...(deadlineAt !== undefined ? { deadlineAt } : {}),
    request: facts.request ?? 'request',
  };
}

/** The retry config the OAuth2 client's transporter carries (gaxios' RetryConfig, the hooks it calls). */
export interface GoogleRetryConfig {
  readonly retry: number;
  readonly shouldRetry: (err: HookError) => boolean;
  readonly retryBackoff: (err: HookError, defaultMs: number) => Promise<void>;
  readonly onRetryAttempt: (err: HookError) => void;
}

/**
 * The policy as gaxios hooks. `deadlineAt` (epoch ms) is a read's deadline: no wait runs
 * past it. Each config keeps the plan shouldRetry made for an error, so the wait that is slept
 * and logged is the one that was decided (the jitter is drawn once).
 */
export function googleRetryConfig(opts: { deadlineAt?: number } = {}): GoogleRetryConfig {
  const plans = new WeakMap<object, { attempt: ReturnType<typeof attemptOf>; plan: RetryPlan }>();
  return Object.freeze({
    retry: MAX_RETRIES,
    shouldRetry: (err: HookError): boolean => {
      const env = seam();
      const attempt = attemptOf(err, opts.deadlineAt, env.now());
      const plan = planRetry(attempt, env);
      plans.set(err, { attempt, plan });
      if (!plan.retry) logGaveUp(attempt.request, attempt.status, attempt.reasons, plan, attempt.retried, attempt.retryAfterMs);
      return plan.retry;
    },
    retryBackoff: async (err: HookError): Promise<void> => {
      const planned = plans.get(err)?.plan;
      await seam().sleep(planned?.retry ? planned.waitMs : 0, configOf(err).signal);
    },
    onRetryAttempt: (err: HookError): void => {
      const planned = plans.get(err);
      if (!planned?.plan.retry) return;
      const { attempt } = planned;
      // gaxios counted this retry before calling the hook.
      logRetry(attempt.request, attempt.status, attempt.reasons, attempt.retried + 1, attempt.maxRetries, planned.plan.waitMs, attempt.retryAfterMs);
    },
  });
}

/** The policy with no deadline: for every client that is not a bounded read. */
export const GOOGLE_RETRY_CONFIG: GoogleRetryConfig = googleRetryConfig();

// ---- Raw fetch ----

/** A Calendar API error body's reasons ('rateLimitExceeded', ...), or none when the body is not that. */
async function reasonsOf(res: Response, request: string): Promise<string[]> {
  try {
    const body = (await res.clone().json()) as { error?: { errors?: unknown } } | null;
    const list = body && typeof body === 'object' && body.error && Array.isArray(body.error.errors) ? body.error.errors : [];
    return list.map((x: unknown) => (x && typeof x === 'object' ? (x as { reason?: unknown }).reason : undefined)).filter((r): r is string => typeof r === 'string');
  } catch (error) {
    console.warn(`${LOG} ${request} answered ${res.status} with a body that is not JSON; no reasons read`, error instanceof Error ? error.message : error);
    return [];
  }
}

/** A fetch URL as logged: method, host and path, no query. */
function requestOf(method: string, url: string): string {
  const parts = /^https?:\/\/([^/?#]+)([^?#]*)/.exec(url);
  return parts ? `${method} ${parts[1]}${parts[2]}` : `${method} (not a URL)`;
}

/**
 * fetch with the same policy as the API client: the response of a refused or failed attempt is
 * thrown away and the call repeated after the wait; the first answer that is not retried (a
 * success, a 4xx, or the last failure) is returned for the caller to read as it always did.
 * A fetch that rejects (no answer) is retried the same way and, when not retried, rethrown as
 * it was. `init.signal` ends a sleep.
 */
export async function googleFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase();
  const request = requestOf(method, url);
  const base = { method, url, maxRetries: MAX_RETRIES, noResponseRetries: NO_RESPONSE_RETRIES };
  for (let retried = 0; ; retried++) {
    const env = seam();
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (error) {
      const aborted = init.signal?.aborted === true || (error instanceof Error && error.name === 'AbortError');
      const plan = planRetry({ ...base, reasons: [], aborted, retried }, env);
      if (!plan.retry) {
        logGaveUp(request, undefined, [], plan, retried, undefined);
        throw error;
      }
      logRetry(request, undefined, [], retried + 1, MAX_RETRIES, plan.waitMs, undefined);
      await env.sleep(plan.waitMs, init.signal);
      continue;
    }
    if (res.ok) return res;
    const reasons = res.status === 403 ? await reasonsOf(res, request) : [];
    const asked = retryAfterMs({ response: { headers: res.headers } }, env.now());
    const plan = planRetry({ ...base, status: res.status, reasons, ...(asked !== undefined ? { retryAfterMs: asked } : {}), aborted: init.signal?.aborted === true, retried }, env);
    if (!plan.retry) {
      logGaveUp(request, res.status, reasons, plan, retried, asked);
      return res;
    }
    // Not awaited: a body's cancel can wait on a branch nobody reads (a tee, after reasonsOf's clone), and a retry must not.
    res.body?.cancel().catch((error: unknown) => console.warn(`${LOG} ${request}: dropping the refused answer's body failed`, error instanceof Error ? error.message : error));
    logRetry(request, res.status, reasons, retried + 1, MAX_RETRIES, plan.waitMs, asked);
    await env.sleep(plan.waitMs, init.signal);
  }
}

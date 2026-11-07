// The Jewish times API's answers (spec docs/superpowers/specs/2026-11-07-zmanim-api-design.md §3.6, §3.7): JSON in UTF-8,
// one error shape { error: { code, message } }, the caching and CORS headers, and how a thrown error is reported.
//
// - A 200 is `private, max-age=<s>` (a shared cache such as Cloudflare never serves it to a caller with no key); every error
//   is `no-store`. Every answer sends `Vary: Origin`.
// - An error's message is English developer text: never a place, a key or a value the caller sent.
// - reportable(): a thrown error as Sentry gets it, its kind and stack frames without its message (an engine's message
//   could hold a place).

import { safeErrorSummary } from '../../services/web-signin/safe-error';

export type ApiErrorCode =
  | 'INVALID_PLACE'
  | 'UNKNOWN_CITY'
  | 'INVALID_COORDINATES'
  | 'NO_TIME_ZONE'
  | 'INVALID_DATE'
  | 'INVALID_RANGE'
  | 'OUT_OF_RANGE'
  | 'INVALID_COMMUNITY'
  | 'INVALID_LANG'
  | 'UNKNOWN_PARAMETER'
  | 'MISSING_KEY'
  | 'INVALID_KEY'
  | 'ORIGIN_NOT_ALLOWED'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'INTERNAL'
  | 'KEYS_UNAVAILABLE';

export const STATUS_OF: Record<ApiErrorCode, number> = {
  INVALID_PLACE: 400,
  UNKNOWN_CITY: 400,
  INVALID_COORDINATES: 400,
  NO_TIME_ZONE: 400,
  INVALID_DATE: 400,
  INVALID_RANGE: 400,
  OUT_OF_RANGE: 400,
  INVALID_COMMUNITY: 400,
  INVALID_LANG: 400,
  UNKNOWN_PARAMETER: 400,
  MISSING_KEY: 401,
  INVALID_KEY: 401,
  ORIGIN_NOT_ALLOWED: 403,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  KEYS_UNAVAILABLE: 503,
};

/** A refusal the handler answers with its code and message. */
export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** How long a 200 may be kept: the same inputs always give the same answer. */
export const HOUR_S = 3600;

const JSON_TYPE = 'application/json; charset=utf-8';

export function errorResponse(code: ApiErrorCode, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status: STATUS_OF[code],
    headers: { 'Content-Type': JSON_TYPE, 'Cache-Control': 'no-store', Vary: 'Origin', ...headers },
  });
}

export function okResponse(body: unknown, maxAgeS: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': JSON_TYPE, 'Cache-Control': `private, max-age=${maxAgeS}`, Vary: 'Origin', ...headers },
  });
}

/** The headers that let a browser on `origin` read an answer, its rate headers included. */
export function corsHeaders(origin: string): Record<string, string> {
  return { 'Access-Control-Allow-Origin': origin, 'Access-Control-Expose-Headers': 'Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset' };
}

/** `error` as Sentry may get it: "<label>: <its kind>", with the original stack frames and never its message. */
export function reportable(error: unknown, label: string): Error {
  const out = new Error(`${label}: ${safeErrorSummary(error)}`);
  if (error instanceof Error && typeof error.stack === 'string') {
    const frames = error.stack.split('\n').filter((line) => /^\s+at /.test(line));
    out.stack = [`${out.name}: ${out.message}`, ...frames].join('\n');
  }
  return out;
}

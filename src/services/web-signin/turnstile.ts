/**
 * Cloudflare Turnstile on the email-code form (web sign-up spec docs/superpowers/specs/2026-11-03-web-sign-up-design.md
 * §2.4, §3.1): the check that a person, not a program, asks for an email code, on every code request (sign-in and
 * sign-up alike, so the answer still says nothing about an address).
 *
 * - On only when both TURNSTILE_SITE_KEY and TURNSTILE_SECRET are set; until then the form shows no widget, the request
 *   route checks nothing, and email sign-up stays off (no sign-up code is mailed: the request route's after()).
 * - verifyTurnstile posts the token to siteverify (secret, response, remoteip when known, an idempotency_key) through the
 *   one retry loop (fetch-retry.ts's fetchAndReadWithRetry, the body read whole inside the attempt with wholeJson). A
 *   POST is safe to send again here because of the idempotency key: Cloudflare answers a repeat of the same key as it
 *   answered the first, so a retry after a cut-off answer is not a "timeout-or-duplicate". One key per call, the same
 *   on its retries.
 * - A pass is success true AND the answer's hostname equal to the app's own (new URL(getBaseUrl()).hostname, never the
 *   request's Host) AND its action equal to TURNSTILE_ACTION, as Cloudflare asks the server to check.
 * - Every refusal is one line with the reason and Cloudflare's error codes; never the token or the secret. A secret
 *   Cloudflare refuses is reported (the setup is broken for everyone); giving up after the retries is reported as a
 *   warning.
 * Server only.
 */

import crypto from 'crypto';
import { isIP } from 'net';
import { getBaseUrl } from '../../config/urls';
import { captureError } from '../../lib/error-capture';
import { fetchAndReadWithRetry, HttpStatusError } from '../../utils/fetch-retry';
import { wholeJson } from '../../utils/whole-json';
import { SafeSignInError, safeErrorSummary } from './safe-error';

export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
/** The widget's action on the email form; the client sends the same string (components/site/TurnstileWidget.tsx). */
export const TURNSTILE_ACTION = 'email-code';
/** The longest token Cloudflare makes. */
const MAX_TOKEN = 2048;

export type TurnstileRefusal = 'missing' | 'refused' | 'hostname' | 'action' | 'unavailable';
export type TurnstileVerdict = { ok: true } | { ok: false; why: TurnstileRefusal };

/** The token's own fault: a person can pass a new check. */
const TOKEN_FAULTS = new Set(['missing-input-response', 'invalid-input-response', 'timeout-or-duplicate']);
/** Our setup's fault: no one can pass until the secret is fixed. */
const SETUP_FAULTS = new Set(['missing-input-secret', 'invalid-input-secret']);

/** Whether the email form has the check: both variables set. */
export function turnstileConfigured(): boolean {
  return Boolean(process.env.TURNSTILE_SITE_KEY && process.env.TURNSTILE_SECRET);
}

/** The site key the /signin page gives its form, read per request (never NEXT_PUBLIC_, so no build holds it); null while off. */
export function turnstileSiteKey(): string | null {
  return turnstileConfigured() ? (process.env.TURNSTILE_SITE_KEY as string) : null;
}

/** Cloudflare's error codes as they came, only when they look like codes (letters, digits and hyphens). */
function errorCodes(answer: Record<string, unknown>): string[] {
  const raw = answer['error-codes'];
  return Array.isArray(raw) ? raw.filter((c): c is string => typeof c === 'string' && /^[a-z0-9-]{1,64}$/.test(c)) : [];
}

function refuse(why: TurnstileRefusal, detail = ''): TurnstileVerdict {
  console.info(`[turnstile] check refused: ${why}${detail ? ` (${detail})` : ''}`);
  return { ok: false, why };
}

/**
 * Checks a Turnstile token for an email-code request. `ip` is the client's own address (clientIp), sent as remoteip
 * when it is one. Never throws: every failure is a refusal (the route answers 'check').
 */
export async function verifyTurnstile(token: unknown, ip: string | null): Promise<TurnstileVerdict> {
  const secret = process.env.TURNSTILE_SECRET;
  if (!secret) return refuse('unavailable', 'TURNSTILE_SECRET is not set');
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN) return refuse('missing');
  const form = new URLSearchParams({ secret, response: token, idempotency_key: crypto.randomUUID() });
  if (ip !== null && isIP(ip) !== 0) form.set('remoteip', ip);

  let answer: unknown;
  try {
    const response = await fetchAndReadWithRetry(SITEVERIFY_URL, { method: 'POST', body: form }, wholeJson, {
      label: '[turnstile]',
      onGiveUp: (error, { retried, why }) => {
        const status = error instanceof HttpStatusError ? `status ${error.status}` : 'no answer';
        console.error(`[turnstile] gave up on siteverify: ${status}, ${why} (${retried} retries)`);
      },
    });
    answer = await response.json();
  } catch (error) {
    captureError(new SafeSignInError(`turnstile siteverify: ${safeErrorSummary(error)}`), 'turnstile', {}, 'warning');
    return refuse('unavailable');
  }
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return refuse('unavailable', 'an answer that is not an object');
  const fields = answer as Record<string, unknown>;
  const codes = errorCodes(fields);
  if (fields.success !== true) {
    if (codes.some((c) => SETUP_FAULTS.has(c))) {
      captureError(new SafeSignInError(`turnstile: Cloudflare refused the secret (${codes.join(', ')})`), 'turnstile');
      return refuse('unavailable', codes.join(', '));
    }
    if (codes.length > 0 && codes.every((c) => TOKEN_FAULTS.has(c))) return refuse('refused', codes.join(', '));
    return refuse('unavailable', codes.join(', ') || 'no error codes');
  }
  if (fields.hostname !== new URL(getBaseUrl()).hostname) return refuse('hostname');
  if (fields.action !== TURNSTILE_ACTION) return refuse('action');
  return { ok: true };
}

/**
 * The front of the three push-device routes (web push spec 2026-11-05 §3.2): one path for all of them, so none can forget a
 * step. In this order: the request comes from the app's own origin and sends JSON (refuseCrossSite), then the session
 * cookie proves the person (verifyUserAuth with no initData, so a Mini App request has nothing to prove it by) under the
 * push limiter (20 a minute per account), then, for the routes that need push on, 503 while the VAPID keys are not set.
 * Every refusal logs one line with the user id and the reason, never the endpoint or the keys. Server only.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { verifyUserAuth, type AuthResult } from '../../lib/api-auth';
import { pushDeviceRateLimiter } from '../../lib/rate-limit';
import { refuseCrossSite } from '../../lib/same-origin';
import { isPushServiceUrl, pushConfigured } from './config';

/** A proved request that rides the web session cookie (the only credential these routes take). */
export type PushSessionAuth = Extract<AuthResult, { success: true; via: 'session' }>;

export type PushFront = { ok: true; auth: PushSessionAuth } | { ok: false; response: NextResponse };

/**
 * `tag` names the route in the logs and the limiter's lines. `needsPushOn`: answer 503 { ok: false, error: 'push-off' }
 * while push is not configured (subscribe and check); an unsubscribe passes false, so a device can always be removed.
 */
export async function pushFront(request: NextRequest, tag: string, opts: { needsPushOn: boolean }): Promise<PushFront> {
  const refused = refuseCrossSite(request);
  if (refused) return { ok: false, response: refused };
  const auth = await verifyUserAuth(request, request.nextUrl.searchParams.get('user_id'), null, pushDeviceRateLimiter, tag);
  if (!auth.success) {
    // verifyUserAuth logs its other refusals itself; the spent minute (429) it answers silently, and the person is proved by then
    if (auth.response.status === 429) console.warn(`[push] ${tag} refused: too many requests`);
    return { ok: false, response: auth.response };
  }
  // With no initData only the cookie can prove the user, so this is a session; the check narrows the type
  if (auth.via !== 'session') {
    console.warn(`[push] user ${auth.user.id}: ${tag} refused: not a browser session`);
    return { ok: false, response: NextResponse.json({ ok: false, error: 'browser-only' }, { status: 403 }) };
  }
  if (opts.needsPushOn && !pushConfigured()) {
    console.warn(`[push] user ${auth.user.id}: ${tag} refused: push is off`);
    return { ok: false, response: NextResponse.json({ ok: false, error: 'push-off' }, { status: 503 }) };
  }
  return { ok: true, auth };
}

/** The body as JSON, or null (and one line saying only that it was not JSON). */
export async function readPushBody(request: NextRequest, tag: string): Promise<unknown> {
  return request.json().catch(() => {
    console.warn(`[push] ${tag}: the body is not JSON`);
    return null;
  });
}

/** devices.ts's own limit for an endpoint: the check and the unsubscribe only compare it with stored rows. */
const MAX_ENDPOINT_CHARS = 1024;

/**
 * For a subscribe that was refused as bad input (controller ruling R3): when the endpoint is an https URL whose host is not
 * a push service, that host, and nothing else of the URL (no path, no query: they hold the device's secret), so a browser on
 * a push service not yet in PUSH_SERVICE_HOSTS shows in the logs and the list can be widened. Otherwise null.
 */
export function unknownPushHost(body: unknown): string | null {
  const endpoint = typeof body === 'object' && body !== null ? (body as { endpoint?: unknown }).endpoint : undefined;
  if (typeof endpoint !== 'string') return null;
  try {
    const url = new URL(endpoint);
    return url.protocol === 'https:' && !isPushServiceUrl(url) ? url.hostname.slice(0, 253) : null;
  } catch {
    return null; // not a URL: plain bad input
  }
}

/** The body's `endpoint` when it is a non-empty string of at most 1024 characters, else null. */
export function endpointOf(body: unknown): string | null {
  const endpoint = typeof body === 'object' && body !== null ? (body as { endpoint?: unknown }).endpoint : undefined;
  return typeof endpoint === 'string' && endpoint.length > 0 && endpoint.length <= MAX_ENDPOINT_CHARS ? endpoint : null;
}

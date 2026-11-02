/**
 * The guard on every sign-in and Settings POST (web sign-in spec §3): the request must come from the app's own origin
 * and send JSON. A page on another site can still make a browser POST here with its cookies (SameSite=Lax lets a
 * top-level form through), so without this someone else's sign-in could land in your browser (login CSRF), or a
 * signed-in browser could be made to sign out. A cross-site form can't set the Origin header, and it can't send
 * `application/json` without a CORS preflight, which this app never answers.
 *
 * The origin is the app's base URL (getBaseUrl), never the request's Host header, which the client writes.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getBaseUrl } from '../config/urls';

/** The media type a request says it sends, lower-cased, without parameters ("application/json; charset=utf-8" → "application/json"). */
function mediaType(request: NextRequest): string {
  return (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
}

/**
 * null when the request may go on. Otherwise the answer to return at once: 403 `{ error: 'cross_site' }` when its
 * Origin is missing or not the app's, 415 `{ error: 'json_only' }` when its body is not JSON (pass `json: false` for a
 * route that takes no JSON body). Each refusal is logged with the method, the path and the reason, never a header value.
 */
export function refuseCrossSite(request: NextRequest, opts: { json?: boolean } = {}): NextResponse | null {
  const where = `${request.method} ${request.nextUrl.pathname}`;
  const origin = request.headers.get('origin');
  if (origin === null || origin !== new URL(getBaseUrl()).origin) {
    console.warn(`[same-origin] refused ${where}: ${origin === null ? 'no Origin header' : 'another Origin'}`);
    return NextResponse.json({ error: 'cross_site' }, { status: 403 });
  }
  if (opts.json !== false && mediaType(request) !== 'application/json') {
    console.warn(`[same-origin] refused ${where}: the body is not JSON`);
    return NextResponse.json({ error: 'json_only' }, { status: 415 });
  }
  return null;
}

// The write routes' common answers (home editing spec §3): private, no-store JSON, and a
// WriteResult as its status code.

import { NextResponse } from 'next/server';
import type { WriteResponse } from '../../lib/calendar-view/editor-types';
import type { WriteResult } from './write';

export const NO_STORE = 'private, no-store';

export function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': NO_STORE } });
}

/** A failed auth answer (400/401/403/404/429), made private as the home's other routes do. */
export function authFailure(response: NextResponse): NextResponse {
  response.headers.set('Cache-Control', NO_STORE);
  return response;
}

/** The body's user_id (the Telegram id, or the account's id for a browser session), as a string. */
export function userIdOf(raw: unknown): string | null {
  const id = (raw as { user_id?: unknown } | null)?.user_id;
  return typeof id === 'string' ? id : typeof id === 'number' ? String(id) : null;
}

/**
 * A write's result as its response: 200, 400, 403, 404 or 409. A Google connection that
 * needs the user answers 403 { error: 'reconnect', reason }; a Google failure (already
 * logged) 500, as any server failure. A cross-source move: 429 busy while another move of
 * the series runs, 500 move_failed when it was taken back, 200 with leftIn when the
 * original is still there beside its copy.
 */
export function writeResponse(result: WriteResult): NextResponse {
  switch (result.status) {
    case 'ok': {
      const body: WriteResponse = { status: 'ok', ...(result.key ? { key: result.key } : {}), ...(result.leftIn !== undefined ? { leftIn: result.leftIn } : {}) };
      return json(body);
    }
    case 'invalid': return json({ error: 'invalid', field: result.field, ...(result.reason ? { reason: result.reason } : {}) } satisfies WriteResponse, 400);
    case 'not_allowed': return json({ error: 'not_allowed' } satisfies WriteResponse, 403);
    case 'not_found': return json({ error: 'not_found' } satisfies WriteResponse, 404);
    case 'changed': return json({ error: 'changed' } satisfies WriteResponse, 409);
    case 'reconnect': return json({ error: 'reconnect', reason: result.reason } satisfies WriteResponse, 403);
    case 'busy': return json({ error: 'busy' } satisfies WriteResponse, 429);
    case 'move_failed': return json({ error: 'move_failed' } satisfies WriteResponse, 500);
    case 'failed': return json({ error: 'internal_error' } satisfies WriteResponse, 500);
  }
}

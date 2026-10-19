/**
 * POST, PATCH and DELETE /api/calendar/items: add, change and remove a FamCal event or
 * reminder from the calendar home (home editing spec §3). The bodies are CreateItemBody,
 * UpdateItemBody and DeleteItemBody (src/lib/calendar-view/editor-types.ts); times are
 * wall times on the user's clock.
 *
 *   X-Telegram-Init-Data: <initData>   (or the famcal_session cookie in a browser)
 *
 * The route acts for the authenticated user only. The answer is 200 { status: 'ok', key? },
 * or 400 { error: 'invalid', field }, 403 not_allowed, 404 not_found, 409 changed (the
 * occurrence is gone), 500 internal_error, all private and no-store. The writes themselves
 * are src/services/calendar-write/write.ts; a title never reaches a log.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyUserAuth } from '@/src/lib/api-auth';
import { calendarWriteRateLimiter } from '@/src/lib/rate-limit';
import { requestInitData } from '@/src/lib/request-init-data';
import { captureError } from '@/src/lib/error-capture';
import { resolveUserTimezone } from '@/src/lib/timezone';
import { authFailure, json, userIdOf, writeResponse } from '@/src/services/calendar-write/respond';
import { parseCreate, parseDelete, parseUpdate, type Parsed } from '@/src/services/calendar-write/validate';
import { createItem, deleteItem, scrubbed, updateItem, type WriteResult } from '@/src/services/calendar-write/write';
import type { UserConfig } from '@/src/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Auth, rate limit, strict parse, then the write; the three verbs differ only in the last two. */
async function handle<T>(
  request: NextRequest,
  name: string,
  parse: (raw: unknown) => Parsed<T>,
  write: (user: UserConfig, command: T) => Promise<WriteResult>
): Promise<NextResponse> {
  const raw: unknown = await request.json().catch(() => null);
  const auth = await verifyUserAuth(request, userIdOf(raw), requestInitData(request, raw), calendarWriteRateLimiter, name);
  if (!auth.success) return authFailure(auth.response);
  const user = auth.user;
  const parsed = parse(raw);
  if (!parsed.ok) {
    return parsed.field === 'body' ? json({ error: 'bad_request' }, 400) : json({ error: 'invalid', field: parsed.field }, 400);
  }
  try {
    return writeResponse(await write(user, parsed.value));
  } catch (err) {
    // The user id only: a store error quotes the title it was given.
    captureError(scrubbed(err), name, { user_id: user.id });
    return json({ error: 'internal_error' }, 500);
  }
}

export function POST(request: NextRequest) {
  return handle(request, 'calendar-items-create', parseCreate, async (user, command) => createItem(user, command, await resolveUserTimezone(user)));
}

export function PATCH(request: NextRequest) {
  return handle(request, 'calendar-items-update', parseUpdate, async (user, command) => updateItem(user, command, await resolveUserTimezone(user)));
}

export function DELETE(request: NextRequest) {
  return handle(request, 'calendar-items-delete', parseDelete, (user, command) => deleteItem(user, command));
}

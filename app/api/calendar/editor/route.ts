/**
 * GET /api/calendar/editor: what the calendar home's "+" needs (home editing spec §3).
 *
 *   ?user_id=<id>
 *   X-Telegram-Init-Data: <initData>   (or the famcal_session cookie in a browser)
 *
 * The answer is { kinds: { event, reminder }, calendars, partner, tz } (EditorInfoResponse
 * in src/lib/calendar-view/editor-types.ts): what the user can add, to which of the
 * calendars they may write to, for whom, and the zone the editor's wall times are in.
 */

import { NextRequest } from 'next/server';
import { verifyUserAuth } from '@/src/lib/api-auth';
import { calendarRateLimiter } from '@/src/lib/rate-limit';
import { requestInitData } from '@/src/lib/request-init-data';
import { captureError } from '@/src/lib/error-capture';
import { resolveUserTimezone } from '@/src/lib/timezone';
import { editorInfo } from '@/src/services/calendar-write/item-info';
import { authFailure, json } from '@/src/services/calendar-write/respond';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  // A GET has no body: the init data comes from the header only, never the query.
  const auth = await verifyUserAuth(request, request.nextUrl.searchParams.get('user_id'), requestInitData(request), calendarRateLimiter, 'calendar-editor');
  if (!auth.success) return authFailure(auth.response);
  const user = auth.user;
  try {
    return json(await editorInfo(user, await resolveUserTimezone(user)));
  } catch (err) {
    // No titles in the context: the user id only.
    captureError(err, 'calendar-editor', { user_id: user.id });
    return json({ error: 'internal_error' }, 500);
  }
}

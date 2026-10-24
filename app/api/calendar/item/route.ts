/**
 * GET /api/calendar/item: the edit info of one item (home editing spec §3), FamCal
 * ('famcal|…') or Google ('google|<calendarId>|<eventId>', 3b spec §3.3).
 *
 *   ?user_id=<id>&key=<ItemDTO.key>
 *   X-Telegram-Init-Data: <initData>   (or the famcal_session cookie in a browser)
 *
 * Read live (the store, or Google), for the item sheet's pencil and the editor's prefill: what the
 * home's DTO lacks, the series, the permissions and the scopes (ItemEditInfoResponse in
 * src/lib/calendar-view/editor-types.ts). An unknown item, one the user can't see, and an
 * occurrence that is gone are all 404 { error: 'not_found' }.
 */

import { NextRequest } from 'next/server';
import { verifyUserAuth } from '@/src/lib/api-auth';
import { calendarRateLimiter } from '@/src/lib/rate-limit';
import { requestInitData } from '@/src/lib/request-init-data';
import { captureError } from '@/src/lib/error-capture';
import { resolveUserTimezone } from '@/src/lib/timezone';
import { displayColourFor, displayColourMap } from '@/src/services/native-calendar/colour';
import { itemInfoFor } from '@/src/services/calendar-write/item-info';
import { authFailure, json } from '@/src/services/calendar-write/respond';
import { parseAnyItemKey } from '@/src/services/calendar-write/validate';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const auth = await verifyUserAuth(request, params.get('user_id'), requestInitData(request), calendarRateLimiter, 'calendar-item');
  if (!auth.success) return authFailure(auth.response);
  const user = auth.user;
  const key = parseAnyItemKey(params.get('key'));
  if (!key) return json({ error: 'invalid', field: 'key' }, 400);
  try {
    const info = await itemInfoFor(user, key, await resolveUserTimezone(user));
    if (info === 'not_found') return json({ error: 'not_found' }, 404);
    if (info.calendar) info.calendar = displayColourFor(info.calendar, await displayColourMap(user));
    return json(info);
  } catch (err) {
    // No titles in the context: the user id only.
    captureError(err, 'calendar-item', { user_id: user.id });
    return json({ error: 'internal_error' }, 500);
  }
}

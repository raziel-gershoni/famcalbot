/**
 * GET /api/calendar/item: the edit info of one FamCal item (home editing spec §3).
 *
 *   ?user_id=<id>&key=<ItemDTO.key>
 *   X-Telegram-Init-Data: <initData>   (or the famcal_session cookie in a browser)
 *
 * Read live from the store, for the item sheet's pencil and the editor's prefill: what the
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
import { itemEditInfo, loadItem } from '@/src/services/calendar-write/item-info';
import { authFailure, json } from '@/src/services/calendar-write/respond';
import { parseItemKey } from '@/src/services/calendar-write/validate';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const auth = await verifyUserAuth(request, params.get('user_id'), requestInitData(request), calendarRateLimiter, 'calendar-item');
  if (!auth.success) return authFailure(auth.response);
  const user = auth.user;
  const key = parseItemKey(params.get('key'));
  if (!key) return json({ error: 'invalid', field: 'key' }, 400);
  try {
    const item = await loadItem(user, key);
    if (item.status !== 'ok') return json({ error: 'not_found' }, 404);
    return json(await itemEditInfo(item, await resolveUserTimezone(user), user));
  } catch (err) {
    // No titles in the context: the user id only.
    captureError(err, 'calendar-item', { user_id: user.id });
    return json({ error: 'internal_error' }, 500);
  }
}

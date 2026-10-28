/**
 * GET /api/zmanim: the home's sun sheet, a day's zmanim at the person's place.
 *
 *   ?user_id=<id>&date=<yyyy-MM-dd>      (no date: today in the person's zone)
 *   X-Telegram-Init-Data: <initData>     (or the famcal_session cookie in a browser)
 *
 * The answer is a ZmanimListResponse (src/lib/calendar-view/zmanim-list.ts): the day, the zone, the community, where the
 * times are counted (the saved place, the zone's main city, or none), the rows in the order of the day (the candle
 * lighting and the end of Shabbat or Yom Tov on the days they fall) and the halachic hour. The client words it; the
 * instants come from src/services/zmanim only (zmanDayList). Authenticated like the editor's info.
 */

import { NextRequest } from 'next/server';
import { verifyUserAuth } from '@/src/lib/api-auth';
import { calendarRateLimiter } from '@/src/lib/rate-limit';
import { requestInitData } from '@/src/lib/request-init-data';
import { captureError } from '@/src/lib/error-capture';
import { resolveUserTimezone } from '@/src/lib/timezone';
import { PICKER_MAX_DAY, PICKER_MIN_DAY, isDayKey } from '@/src/lib/calendar-view/picker-model';
import { zmanDayList } from '@/src/services/zmanim/reminder-times';
import { localDate } from '@/src/utils/day-events';
import { authFailure, json } from '@/src/services/calendar-write/respond';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  // A GET has no body: the init data comes from the header only, never the query.
  const auth = await verifyUserAuth(request, params.get('user_id'), requestInitData(request), calendarRateLimiter, 'zmanim');
  if (!auth.success) return authFailure(auth.response);
  const user = auth.user;
  const date = params.get('date');
  if (date !== null && (!isDayKey(date) || date < PICKER_MIN_DAY || date > PICKER_MAX_DAY)) {
    console.warn(`[zmanim] user ${user.id} asked for a day that is not one (${date.slice(0, 20)}): refused`);
    return json({ error: 'bad_request', detail: `date is a yyyy-MM-dd day between ${PICKER_MIN_DAY} and ${PICKER_MAX_DAY}` }, 400);
  }
  try {
    const zone = await resolveUserTimezone(user);
    return json(await zmanDayList(user, zone, date ?? localDate(new Date(), zone)));
  } catch (err) {
    // No place or titles in the context: the user id only.
    captureError(err, 'zmanim-list', { user_id: user.id });
    return json({ error: 'internal_error' }, 500);
  }
}

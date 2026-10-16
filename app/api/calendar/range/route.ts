/**
 * GET /api/calendar/range: the calendar home's days (calendar home spec §4).
 *
 *   ?user_id=<id>[&from=yyyy-MM-dd&to=yyyy-MM-dd][&sources=famcal|google|famcal,google][&fresh=1]
 *   X-Telegram-Init-Data: <initData>   (or the famcal_session cookie in a browser)
 *
 * Only for users the rollout switch covers; everyone else gets 404 not_enabled, and the
 * client then falls back to today's dashboard. The facts (timezone, today, week start,
 * Hebrew dates) are worked out here, never taken from the client, and so are the
 * calendars: the legend is the reader's. The answer is built field by field, so the
 * user row (Google token, phone, pairing) never reaches the JSON, and neither does a
 * masked calendar's real name or id.
 */

import { NextRequest, NextResponse, after } from 'next/server';
import { verifyUserAuth } from '@/src/lib/api-auth';
import { calendarRateLimiter } from '@/src/lib/rate-limit';
import { requestInitData } from '@/src/lib/request-init-data';
import { captureError } from '@/src/lib/error-capture';
import { resolveUserTimezone } from '@/src/lib/timezone';
import { TIMEZONE } from '@/src/config/constants';
import { isCalendarHomeOn } from '@/src/services/calendar-read/rollout';
import { readRange, sourcesFor } from '@/src/services/calendar-read';
import { carryOverReadItems } from '@/src/services/calendar-read/famcal';
import { toCalendarDto, toCarryOverDto, toRangeDays } from '@/src/services/calendar-read/dto';
import type { GoogleRead, RangeRead } from '@/src/services/calendar-read/types';
import { fetchOpenReminderItems, openRemindersCutoff } from '@/src/services/native-reminders/open-reminders';
import { hebrewDatesFor, tzKnownFor, weekStartFor } from '@/src/utils/locale-rules';
import { addDaysToDate, localDate } from '@/src/utils/day-events';
import type { DayKey, ItemDTO, RangeResponse, SourceName } from '@/src/lib/calendar-view/types';
import type { UserConfig } from '@/src/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = 'private, no-store';
/** The window with no from/to: today and the next 6 days (Ruling R8). */
const DEFAULT_DAYS = 7;
/** The longest window: a month grid's 6 weeks. */
const MAX_DAYS = 42;
const MAX_YEARS_AWAY = 5;
/** The whole Google half, cache miss included (spec §2.2 Deadlines). */
const GOOGLE_DEADLINE_MS = 6000;
/**
 * How long the answer waits for the user's timezone. A tz:user miss (once a day per user)
 * asks Nominatim and Open-Meteo, or Google's settings, with retries that take about 48 s
 * when those are slow. Past this the answer goes out in the fallback zone.
 */
const TZ_LOOKUP_MS = 2000;
const SOURCE_NAMES: readonly SourceName[] = ['famcal', 'google'];
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

type GoogleSource = NonNullable<RangeResponse['sources']['google']>;
type Query = { from: DayKey; to: DayKey; sources: SourceName[] | null; fresh: boolean };

/**
 * The user's timezone, or null when resolveUserTimezone takes longer than `ms`. The lookup
 * carries on and caches its answer for the next open, as it always does; the route caches
 * nothing. A lookup that fails within `ms` rejects, as before.
 */
async function timezoneWithin(user: UserConfig, ms: number): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([resolveUserTimezone(user), late]);
  } finally {
    clearTimeout(timer);
  }
}

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': NO_STORE } });
}

/** A strict yyyy-MM-dd that names a real date: 2026-02-30 and 2026-1-05 don't. */
function isDayKey(value: string): boolean {
  if (!DAY_KEY.test(value)) return false;
  const t = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === value;
}

function isSourceName(value: string): value is SourceName {
  return (SOURCE_NAMES as readonly string[]).includes(value);
}

const yearsApart = (a: DayKey, b: DayKey) => Math.abs(Number(a.slice(0, 4)) - Number(b.slice(0, 4)));

/**
 * The window and the sources asked for, or why the query is refused (a 400). from and to
 * come both or neither; to is at most 42 days after from, compared as dates, so a 42-day
 * window across a DST change is fine.
 */
function parseQuery(params: URLSearchParams, today: DayKey): Query | { error: string } {
  const fromParam = params.get('from');
  const toParam = params.get('to');
  let from = today;
  let to = addDaysToDate(today, DEFAULT_DAYS);
  if (fromParam !== null || toParam !== null) {
    if (fromParam === null || toParam === null) return { error: 'from and to come together' };
    if (!isDayKey(fromParam) || !isDayKey(toParam)) return { error: 'from and to are yyyy-MM-dd dates' };
    if (!(fromParam < toParam)) return { error: 'from must come before to' };
    if (yearsApart(fromParam, today) > MAX_YEARS_AWAY || yearsApart(toParam, today) > MAX_YEARS_AWAY) {
      return { error: `from and to are within ${MAX_YEARS_AWAY} years of today` };
    }
    if (toParam > addDaysToDate(fromParam, MAX_DAYS)) return { error: `at most ${MAX_DAYS} days` };
    from = fromParam;
    to = toParam;
  }
  let sources: SourceName[] | null = null;
  const sourcesParam = params.get('sources');
  if (sourcesParam !== null) {
    const names = sourcesParam.split(',');
    if (!names.every(isSourceName)) return { error: 'sources is famcal, google or both' };
    sources = names;
  }
  return { from, to, sources, fresh: params.get('fresh') === '1' };
}

/**
 * Each applicable source's status: what the read said for a requested one, 'pending' for
 * one that applies but wasn't requested. A source that doesn't apply has no key, so a
 * FamCal user can never be shown "Reconnect Google" (that flow would switch them to
 * Google and hide their calendars).
 */
function sourcesDto(applicable: readonly SourceName[], read: RangeRead): RangeResponse['sources'] {
  const out: RangeResponse['sources'] = {};
  if (applicable.includes('famcal')) out.famcal = { status: read.famcal ? read.famcal.status : 'pending' };
  if (applicable.includes('google')) out.google = read.google ? googleSource(read.google) : { status: 'pending' };
  return out;
}

function googleSource(google: GoogleRead): GoogleSource {
  if (google.status !== 'ok') return { status: google.status, reason: google.reason };
  return {
    status: 'ok',
    ...(google.partial ? { partial: { failed: google.partial.failed, truncated: google.partial.truncated } } : {}),
    ...(google.stale ? { stale: true } : {}),
  };
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  // A GET has no body: the init data comes from the header only, never the query.
  const auth = await verifyUserAuth(request, params.get('user_id'), requestInitData(request), calendarRateLimiter, 'calendar-range');
  if (!auth.success) {
    auth.response.headers.set('Cache-Control', NO_STORE);
    return auth.response;
  }
  const user = auth.user;

  try {
    if (!(await isCalendarHomeOn(user))) return json({ error: 'not_enabled' }, 404);

    const now = new Date();
    // A slow lookup costs this answer the user's zone, never the answer: the fallback zone
    // with tzKnown false, so the week start and Hebrew dates follow the language (R15).
    const resolved = await timezoneWithin(user, TZ_LOOKUP_MS);
    if (resolved === null) {
      captureError(new Error(`The timezone lookup took over ${TZ_LOOKUP_MS} ms`), 'calendar-range-timezone', { user_id: user.id }, 'warning');
    }
    const tz = resolved ?? TIMEZONE;
    const today = localDate(now, tz);
    const facts = { culture: user.culture, language: user.language, tz, tzKnown: resolved !== null && tzKnownFor(user) };
    const weekStart = weekStartFor(facts);
    const hebrewDates = hebrewDatesFor(facts);

    const query = parseQuery(params, today);
    if ('error' in query) return json({ error: 'bad_request', detail: query.error }, 400);
    const { from, to } = query;

    const applicable = sourcesFor(user);
    const requested = applicable.filter((s) => query.sources === null || query.sources.includes(s));
    const read = await readRange(user, from, to, {
      tz,
      sources: requested,
      googleCache: query.fresh ? 'refresh' : 'use',
      deadlineMs: GOOGLE_DEADLINE_MS,
      defer: (task) => after(task),
    });

    const famcal = read.famcal;
    if (famcal?.status === 'error') captureError(famcal.cause, 'calendar-range-famcal', { user_id: user.id }, 'warning');

    // The older open reminders, for a window that holds today, all of them, newest
    // first. carryOverReadItems masks them by the rows' legend rule: a calendar outside
    // the legend shows only the partner's name. A failed read costs the home its "Still
    // open" card, never the answer.
    let carryOvers: ItemDTO[] | undefined;
    if (famcal?.status === 'ok' && from <= today && today < to) {
      try {
        const open = await fetchOpenReminderItems(user, famcal.ctx, openRemindersCutoff(today, tz, now), today, tz, Infinity);
        carryOvers = carryOverReadItems(famcal, open.items).map((item) => toCarryOverDto(item, tz, now));
      } catch (err) {
        captureError(err, 'calendar-range-carryovers', { user_id: user.id }, 'warning');
      }
    }

    const legend = [
      ...(famcal?.status === 'ok' ? famcal.calendars : []),
      ...(read.google?.status === 'ok' ? read.google.calendars : []),
    ];
    const body: RangeResponse = {
      tz,
      today,
      weekStart,
      hebrewDates,
      from,
      to,
      sources: sourcesDto(applicable, read),
      partner: famcal?.status === 'ok' && famcal.partner ? { name: famcal.partner.name } : null,
      calendars: legend.map(toCalendarDto),
      days: toRangeDays(read.items, from, to, tz, now, today),
      ...(carryOvers ? { carryOvers } : {}),
    };
    return json(body);
  } catch (err) {
    // No titles in the context: the user id only.
    captureError(err, 'calendar-range', { user_id: user.id });
    return json({ error: 'internal_error' }, 500);
  }
}

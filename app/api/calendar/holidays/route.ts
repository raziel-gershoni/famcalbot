/**
 * GET /api/calendar/holidays: the Hebrew holidays of a range, for the calendar home (Hebrew
 * holidays spec §4).
 *
 *   ?from=yyyy-MM-dd&to=yyyy-MM-dd[&lang=en|he|ru]
 *   ?next=yyyy-MM-dd[&lang=en|he|ru]   the next holiday worth counting down to after that
 *                                      day, { next: { day, name } | null } (not with from/to)
 *
 * Public data with no user in it (the Israel schedule, computed in-process), so there is no
 * auth and the answer is cached for a day, by the browser and by the CDN. An unknown lang
 * reads as English. At most 100 days a request; anything else is 400 { error: 'invalid', field }.
 */

import { NextRequest, NextResponse } from 'next/server';
import { captureError } from '@/src/lib/error-capture';
import { daysBetween } from '@/src/lib/calendar-view/format';
import { holidaysInRange, nextHoliday } from '@/src/services/hebrew-holidays';

export const runtime = 'nodejs';

const MAX_DAYS = 100;
const CACHE = 'public, max-age=86400, s-maxage=86400';

function invalid(field: 'from' | 'to' | 'next'): NextResponse {
  return NextResponse.json({ error: 'invalid', field }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const params = request.nextUrl.searchParams;
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const lang = params.get('lang') ?? 'en';

  if (params.has('next')) {
    const next = params.get('next') ?? '';
    if (Number.isNaN(daysBetween(next, next)) || params.has('from') || params.has('to')) return invalid('next');
    try {
      return NextResponse.json({ next: nextHoliday(next, lang) }, { headers: { 'Cache-Control': CACHE } });
    } catch (error) {
      captureError(error, 'calendar-holidays', { next, lang });
      return NextResponse.json({ error: 'failed' }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
    }
  }

  // daysBetween is NaN for anything that is not a real yyyy-MM-dd day.
  if (Number.isNaN(daysBetween(from, from))) return invalid('from');
  if (Number.isNaN(daysBetween(to, to))) return invalid('to');
  const span = daysBetween(from, to) + 1;
  if (span < 1 || span > MAX_DAYS) return invalid('to');

  try {
    return NextResponse.json({ days: holidaysInRange(from, to, lang) }, { headers: { 'Cache-Control': CACHE } });
  } catch (error) {
    captureError(error, 'calendar-holidays', { from, to, lang });
    return NextResponse.json({ error: 'failed' }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
}

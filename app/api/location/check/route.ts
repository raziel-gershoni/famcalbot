/**
 * POST /api/location/check { user_id (query), place, initData }: the check of a place typed in Settings, made by the
 * server (the final review's M-3), so the person's browser never calls OpenStreetMap for it and OpenStreetMap sees our
 * server's address, not theirs. One Nominatim search, as the browser made it before (English names, so a collapsed
 * address is stored forward-geocodable), read by src/lib/location-place.ts. Answers { check }: valid (with the name to
 * store), notFound, or failed (Nominatim could not say: logged, never with the place's name).
 *
 * The person is authenticated like Settings' own save (Telegram initData or the WhatsApp session), on the general rate
 * limit: a place is checked each time the sheet closes on a new one.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyUserAuth } from '@/src/lib/api-auth';
import { generalRateLimiter } from '@/src/lib/rate-limit';
import { captureError } from '@/src/lib/error-capture';
import { checkFromHits, MAX_LOCATION_LENGTH, type LocationCheck } from '@/src/lib/location-place';
import { fetchWithTimeout } from '@/src/services/weather/geocoding';

export const dynamic = 'force-dynamic';

/** An error's text with the place cut out (plain and URL-encoded): a place is the person's free text, never logged. */
function withoutPlace(error: unknown, place: string): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return place ? text.split(place).join('[place]').split(encodeURIComponent(place)).join('[place]') : text;
}

export async function POST(request: NextRequest) {
  let place = '';
  try {
    const userId = new URL(request.url).searchParams.get('user_id');
    const body = (await request.json()) as { place?: unknown; initData?: string };
    const auth = await verifyUserAuth(request, userId, body.initData, generalRateLimiter, 'location-check');
    if (!auth.success) return auth.response;

    if (typeof body.place !== 'string' || body.place.length > MAX_LOCATION_LENGTH) {
      return NextResponse.json({ error: `place is required, a string of at most ${MAX_LOCATION_LENGTH} characters` }, { status: 400 });
    }
    place = body.place.trim();
    if (!place) return NextResponse.json({ check: { kind: 'valid', normalized: '' } satisfies LocationCheck });

    const response = await fetchWithTimeout(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(place)}&format=json&limit=1&addressdetails=1`,
      // Names we may store come back in English (as the reverse lookup asks), or a collapsed address lands in the local script
      { headers: { 'User-Agent': 'FamilyCalendarBot/1.0', 'Accept-Language': 'en' } },
    );
    if (!response.ok) {
      console.warn(`[location-check] user ${auth.user.id}: Nominatim answered ${response.status}`);
      return NextResponse.json({ check: { kind: 'failed' } satisfies LocationCheck });
    }
    return NextResponse.json({ check: checkFromHits(await response.json(), place) });
  } catch (error) {
    // Never the place's name: the error of a fetch can carry the URL, which holds it
    const why = withoutPlace(error, place);
    console.error(`[location-check] the check failed: ${why}`);
    captureError(new Error(`The location check failed: ${why}`), 'location-check', { api_route: '/api/location/check' }, 'warning');
    return NextResponse.json({ check: { kind: 'failed' } satisfies LocationCheck });
  }
}

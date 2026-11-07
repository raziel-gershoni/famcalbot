// Every request to /api/v1/* (spec docs/superpowers/specs/2026-11-07-zmanim-api-design.md §3.6; reference
// docs/api/jewish-times-v1.md), in this order: the key (Authorization: Bearer fcj_…), the origin a key is locked to, the
// key's rate, the parameters, the place, the answer.
//
// - The key comes from the process's copy (findApiKey): no database query and no Redis command in the steady state.
// - CORS: an answer to a key carries Access-Control-Allow-Origin only for an origin that key lists (a key with none is a
//   server key and gets none); a refused key, and the browser's preflight (which carries no key), answer by whether any
//   active key lists the origin, so a listed website can read why it was refused.
// - "Today" is the place's own day (localDate over instantToWallTime), and an answer that depends on it is kept at most to
//   the place's next midnight.
// - One log line per request: `[api] key <id> <endpoint> <status> [<code>] <ms> ms`, or `[api] 401 <code>` for a refused
//   key. No query, place, origin or key reaches a log; a thrown error reaches Sentry by its kind only (reportable).

import { KeysUnavailable, anyKeyListsOrigin, findApiKey, type FoundKey } from '../../services/api-keys/lookup';
import { dayView, shabbatView } from '../../services/zmanim/api-view';
import { defaultCommunityIn } from '../../site/zmanim/city-view';
import { addDaysToDate, localDate, startOfLocalDay } from '../../utils/day-events';
import { captureError } from '../error-capture';
import { creditsFor } from './credits';
import { DEFAULT_SPAN_DAYS, LAST_DAY, checkRange, readDayParams, readShabbatParams, type Endpoint } from './params';
import { resolveApiPlace } from './place';
import { countRequest, rateHeaders } from './rate';
import { ApiError, HOUR_S, corsHeaders, errorResponse, okResponse, reportable, type ApiErrorCode } from './respond';

const BEARER = /^Bearer\s+(\S+)\s*$/i;

/** How long an answer may be kept: an hour, or to the place's next midnight when it is about "today". */
function maxAgeFor(aboutToday: boolean, today: string, zone: string, now: number): number {
  if (!aboutToday) return HOUR_S;
  const midnight = startOfLocalDay(addDaysToDate(today, 1), zone).getTime();
  return Math.max(1, Math.min(HOUR_S, Math.ceil((midnight - now) / 1000)));
}

async function answer(endpoint: Endpoint, search: URLSearchParams, now: number): Promise<{ body: unknown; maxAgeS: number }> {
  if (endpoint === 'shabbat') {
    const params = readShabbatParams(search);
    const place = resolveApiPlace(params.place);
    const zone = place.place.timeZone;
    const today = localDate(new Date(now), zone);
    const from = params.from ?? today;
    const spanEnd = addDaysToDate(from, DEFAULT_SPAN_DAYS);
    const to = params.to ?? (spanEnd > LAST_DAY ? LAST_DAY : spanEnd);
    if (params.from === null || params.to === null) checkRange(from, to);
    const community = params.community ?? defaultCommunityIn(zone);
    const body = await shabbatView({ place, community, lang: params.lang, from, to, credits: creditsFor(place) });
    return { body, maxAgeS: maxAgeFor(params.from === null, today, zone, now) };
  }
  const params = readDayParams(search);
  const place = resolveApiPlace(params.place);
  const zone = place.place.timeZone;
  const today = localDate(new Date(now), zone);
  const community = params.community ?? defaultCommunityIn(zone);
  const body = await dayView({ place, community, lang: params.lang, date: params.date ?? today, credits: creditsFor(place) });
  return { body, maxAgeS: maxAgeFor(params.date === null, today, zone, now) };
}

/** The CORS headers for a request that carries no usable key: the origin's, when some active key lists it. */
async function corsForAnyKey(origin: string | null, now: number): Promise<Record<string, string>> {
  if (origin === null) return {};
  try {
    return (await anyKeyListsOrigin(origin, now)) ? corsHeaders(origin) : {};
  } catch (error) {
    console.warn(`[api] no CORS answer: the key list is unavailable (${error instanceof Error ? error.name : typeof error})`);
    return {};
  }
}

async function refusedKey(code: ApiErrorCode, message: string, origin: string | null, now: number): Promise<Response> {
  console.warn(`[api] 401 ${code}`);
  return errorResponse(code, message, await corsForAnyKey(origin, now));
}

export async function handleApiV1(request: Request, endpoint: Endpoint): Promise<Response> {
  const started = performance.now();
  const now = Date.now();
  const origin = request.headers.get('origin');
  const raw = BEARER.exec(request.headers.get('authorization') ?? '')?.[1] ?? null;
  if (raw === null) return refusedKey('MISSING_KEY', 'send the key as Authorization: Bearer <key>', origin, now);

  let found: FoundKey | null;
  try {
    found = await findApiKey(raw, now);
  } catch (error) {
    if (!(error instanceof KeysUnavailable)) captureError(reportable(error, 'api-v1 key lookup failed'), 'api-v1', { endpoint });
    console.error(`[api] 503 KEYS_UNAVAILABLE ${endpoint}`);
    return errorResponse('KEYS_UNAVAILABLE', 'the API cannot check keys right now; try again in a minute', { 'Retry-After': '60' });
  }
  if (!found) return refusedKey('INVALID_KEY', 'the key is not the key of an active app', origin, now);
  const key: FoundKey = found;

  const done = (res: Response, code?: ApiErrorCode): Response => {
    console.log(`[api] key ${key.id} ${endpoint} ${res.status}${code ? ` ${code}` : ''} ${Math.round(performance.now() - started)} ms`);
    return res;
  };
  const cors = origin !== null && key.origins.includes(origin) ? corsHeaders(origin) : {};
  if (origin !== null && key.origins.length > 0 && !key.origins.includes(origin)) {
    return done(errorResponse('ORIGIN_NOT_ALLOWED', 'this key may not be used from this website', cors), 'ORIGIN_NOT_ALLOWED');
  }

  const rate = countRequest(key.id, now);
  const headers = { ...cors, ...rateHeaders(rate) };
  if (!rate.ok) {
    return done(errorResponse('RATE_LIMITED', `at most ${rate.limit} requests a minute per key`, { ...headers, 'Retry-After': String(rate.retryAfterS) }), 'RATE_LIMITED');
  }

  try {
    const { body, maxAgeS } = await answer(endpoint, new URL(request.url).searchParams, now);
    return done(okResponse(body, maxAgeS, headers));
  } catch (error) {
    if (error instanceof ApiError) return done(errorResponse(error.code, error.message, headers), error.code);
    captureError(reportable(error, `api-v1 ${endpoint} failed`), 'api-v1', { endpoint, key_id: key.id });
    return done(errorResponse('INTERNAL', 'something went wrong on our side', headers), 'INTERNAL');
  }
}

/** The browser's preflight: it carries no key, so it is allowed for an origin some active key lists, and refused otherwise. */
export async function preflight(request: Request): Promise<Response> {
  const origin = request.headers.get('origin');
  const cors = await corsForAnyKey(origin, Date.now());
  const headers: Record<string, string> = { 'Cache-Control': 'no-store', Vary: 'Origin' };
  if (cors['Access-Control-Allow-Origin']) {
    Object.assign(headers, cors, { 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Allow-Headers': 'Authorization', 'Access-Control-Max-Age': '600' });
  }
  return new Response(null, { status: 204, headers });
}

/** Any other path under /api/v1/. */
export function notFound(): Response {
  console.warn('[api] 404 NOT_FOUND');
  return errorResponse('NOT_FOUND', 'no such endpoint: /api/v1/shabbat and /api/v1/day are the ones there are');
}

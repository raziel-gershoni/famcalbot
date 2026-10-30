// The day's zmanim list, as the Mini App reads it (GET /api/zmanim): the answer's shape, the request, and the one
// way an hour's length is written. Client-safe and pure apart from fetch: it imports nothing from src/services/zmanim,
// which is server only (the keys here are plain strings, as in zman-spec.ts). The client words everything; the server
// sends no strings.
//
// Nothing here throws: a request that fails, or answers in a form this file does not know, reads as `failed`.

import { initDataHeaders } from '../read-init-data';
import type { ZmanOpinion } from './zman-spec';

/**
 * The rows a day's list carries besides the set's own zmanim: the Shabbat and Yom Tov blocks (restDayBlocks, whose
 * complete ones are the pause's windows) say on which days they fall, so the list and the pause agree on the days; where
 * the sun makes no end (the far north in summer) the rows are still there and the end has no time. The sheet draws them in
 * the accent. The pause begins at the eve's sunset (the set's plain sunset row) and ends at the end row; the candle
 * lighting is the day's own time, 20 minutes before that sunset, not the window's start.
 *  - CANDLE_LIGHTING: on the day a window begins (a Friday, the eve of a Yom Tov) and on every Friday, a Friday inside a
 *    longer window (a Yom Tov on a Friday): that day's own time.
 *  - CANDLE_LIGHTING_NOT_BEFORE: on a rest day inside a window that is neither a Friday nor the window's last day (a Saturday
 *    before a Yom Tov on Sunday, the first day of a two-day Yom Tov): the second night's candles, not before the day's own end
 *    of Shabbat or Yom Tov.
 *  - SHABBAT_ENDS: on the Saturday a window ends; SHABBAT_YOM_TOV_ENDS: when that Saturday is also a Yom Tov; YOM_TOV_ENDS:
 *    on any other day one ends.
 */
export const WINDOW_ROW_KEYS: readonly string[] = ['CANDLE_LIGHTING', 'CANDLE_LIGHTING_NOT_BEFORE', 'SHABBAT_ENDS', 'YOM_TOV_ENDS', 'SHABBAT_YOM_TOV_ENDS'];

/**
 * One row of the day: a zman of the person's set, in the order of the day, or one of the window rows above (WINDOW_ROW_KEYS).
 * `at` is null where the sun does not make that zman that day.
 */
export interface ZmanimListRow {
  key: string;
  opinion: ZmanOpinion | null;
  at: string | null;
}

/** The length of a halachic hour in milliseconds under one opinion; null where the day has no sunrise or sunset. */
export interface ZmanimListHour {
  opinion: ZmanOpinion;
  ms: number | null;
}

export interface ZmanimListResponse {
  /** The civil day (yyyy-MM-dd, the person's zone) the rows are for. */
  day: string;
  /** The zone the instants are shown in. */
  tz: string;
  community: 'sephardi' | 'ashkenazi' | 'chabad';
  /**
   * Where the times are counted. 'saved': the person's own place, named by `name` (what they typed). 'zone': none
   * saved, their zone's main city stands in. null: nothing to count from (no rows).
   */
  place: { source: 'saved'; name: string } | { source: 'zone' } | null;
  rows: ZmanimListRow[];
  /** The halachic hour under the opinions the set counts the day by: GRA and Magen Avraham, or the Baal HaTanya's for Chabad. */
  hours: ZmanimListHour[];
}

/** What a request came to, for the sheet to word. */
export type ZmanimListOutcome = { kind: 'ok'; list: ZmanimListResponse } | { kind: 'failed'; status: number | null };

/** The home's dependency for the list, so a smoke can fake the request. */
export interface ZmanimApi {
  list: (userId: number, day: string) => Promise<ZmanimListOutcome>;
}

const OPINIONS: readonly string[] = ['gra', 'mga', 'halachaBerura', 'yalkutYosef', 'baalHatanya'];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The fields the sheet reads, so a body that is not a list is a failure to show, not a crash. */
export function isZmanimList(value: unknown): value is ZmanimListResponse {
  if (!isObject(value)) return false;
  const place = value.place;
  const placeOk = place === null || (isObject(place) && (place.source === 'zone' || (place.source === 'saved' && typeof place.name === 'string')));
  return (
    typeof value.day === 'string' &&
    typeof value.tz === 'string' &&
    (value.community === 'sephardi' || value.community === 'ashkenazi' || value.community === 'chabad') &&
    placeOk &&
    Array.isArray(value.rows) &&
    value.rows.every((r) => isObject(r) && typeof r.key === 'string' && (r.opinion === null || (typeof r.opinion === 'string' && OPINIONS.includes(r.opinion))) && (r.at === null || typeof r.at === 'string')) &&
    Array.isArray(value.hours) &&
    value.hours.every((h) => isObject(h) && typeof h.opinion === 'string' && OPINIONS.includes(h.opinion) && (h.ms === null || (typeof h.ms === 'number' && Number.isFinite(h.ms))))
  );
}

/** The list for `day` (yyyy-MM-dd). The init data goes in the header only; in a browser the session cookie rides along. user_id is the page's own. */
export async function fetchZmanimList(userId: number, day: string): Promise<ZmanimListOutcome> {
  let res: Response;
  try {
    res = await fetch(`/api/zmanim?${new URLSearchParams({ user_id: String(userId), date: day })}`, {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: initDataHeaders(),
    });
  } catch (error) {
    console.error('[zmanim-list] the request did not reach the server:', error);
    return { kind: 'failed', status: null };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch (error) {
    console.error(`[zmanim-list] the answer (${res.status}) was not JSON:`, error);
  }
  if (res.status === 200 && isZmanimList(body)) return { kind: 'ok', list: body };
  console.error(`[zmanim-list] the list for ${day} was not delivered: status ${res.status}`);
  return { kind: 'failed', status: res.status };
}

export const REAL_ZMANIM: ZmanimApi = { list: fetchZmanimList };

/**
 * A halachic hour as minutes and seconds: 55:25, and 66:30 on a long summer day (more than 60 minutes is minutes, not
 * hours). Whole seconds, rounded. '—' where the day has none.
 */
export function formatHalachicHour(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '—';
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

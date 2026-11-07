// The query of /api/v1/shabbat and /api/v1/day (spec docs/superpowers/specs/2026-11-07-zmanim-api-design.md §3.1, §3.7):
// read strictly, so a typo in the other app shows at once. Any other parameter, a repeated one or a malformed one is a 400
// ApiError; an error's message names the parameter, never echoes its value.
//
// - A place is exactly one of `city` (a slug of src/site/cities.ts) or `lat` and `lon` (decimal degrees, rounded to 4
//   places, about 11 m); coordinates are checked here, before any zone lookup.
// - Dates are real days, yyyy-MM-dd, from 2000-01-01 to 2099-12-31; `to` is at most 366 days after `from`. A date left
//   out stays null here: its default is "today at the place" (handle.ts), which needs the place's zone.
// Pure: no import beyond the day check, the community check and the error.

import { isDayKey } from '../calendar-view/picker-model';
import { isCommunity, type ZmanimCommunity } from '../../services/zmanim/sets';
import { ApiError } from './respond';

export const API_LANGS = ['en', 'he', 'ru'] as const;
export type ApiLang = (typeof API_LANGS)[number];

export const FIRST_DAY = '2000-01-01';
export const LAST_DAY = '2099-12-31';
export const MAX_RANGE_DAYS = 366;
/** /shabbat with no `to`: a week after `from` (this week's Shabbat and any Yom Tov in it). */
export const DEFAULT_SPAN_DAYS = 7;

export type Endpoint = 'shabbat' | 'day';
export type PlaceParam = { kind: 'city'; slug: string } | { kind: 'coords'; latitude: number; longitude: number };
type CommonParams = { place: PlaceParam; community: ZmanimCommunity | null; lang: ApiLang };
export type ShabbatParams = CommonParams & { from: string | null; to: string | null };
export type DayParams = CommonParams & { date: string | null };

const ALLOWED: Record<Endpoint, readonly string[]> = {
  shabbat: ['city', 'lat', 'lon', 'community', 'lang', 'from', 'to'],
  day: ['city', 'lat', 'lon', 'community', 'lang', 'date'],
};
const SLUG = /^[a-z0-9-]{1,40}$/;
const DECIMAL = /^-?\d{1,3}(?:\.\d+)?$/;

/** A parameter name as an error may quote it: printable, at most 40 characters. */
const nameOf = (name: string) => name.replace(/[^\x20-\x7e]/g, '?').slice(0, 40);

/** The parameters, each once; an unknown or a repeated one is UNKNOWN_PARAMETER. */
function singles(search: URLSearchParams, endpoint: Endpoint): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, value] of search) {
    if (!ALLOWED[endpoint].includes(name)) throw new ApiError('UNKNOWN_PARAMETER', `${nameOf(name)} is not a parameter of /api/v1/${endpoint} (${ALLOWED[endpoint].join(', ')})`);
    if (out.has(name)) throw new ApiError('UNKNOWN_PARAMETER', `${name} is given more than once`);
    out.set(name, value);
  }
  return out;
}

function coordinate(text: string | undefined, limit: number, name: string): number {
  if (text === undefined || !DECIMAL.test(text)) throw new ApiError('INVALID_COORDINATES', `${name} must be decimal degrees, like 31.7683`);
  const value = Number(text);
  if (!Number.isFinite(value) || Math.abs(value) > limit) throw new ApiError('INVALID_COORDINATES', `${name} must be between -${limit} and ${limit}`);
  return Math.round(value * 10_000) / 10_000;
}

function readPlace(p: Map<string, string>): PlaceParam {
  const city = p.get('city');
  const hasLat = p.has('lat');
  const hasLon = p.has('lon');
  if (city !== undefined && (hasLat || hasLon)) throw new ApiError('INVALID_PLACE', 'give city, or lat and lon, not both');
  if (city !== undefined) {
    if (!SLUG.test(city)) throw new ApiError('UNKNOWN_CITY', 'city must be a slug of the city list in lower case (see the reference\'s city list)');
    return { kind: 'city', slug: city };
  }
  if (!hasLat && !hasLon) throw new ApiError('INVALID_PLACE', 'give city, or lat and lon');
  if (!hasLat || !hasLon) throw new ApiError('INVALID_PLACE', 'lat and lon go together');
  return { kind: 'coords', latitude: coordinate(p.get('lat'), 90, 'lat'), longitude: coordinate(p.get('lon'), 180, 'lon') };
}

function readDay(text: string | undefined, name: string): string | null {
  if (text === undefined) return null;
  if (!isDayKey(text)) throw new ApiError('INVALID_DATE', `${name} must be a real day, yyyy-MM-dd`);
  if (text < FIRST_DAY || text > LAST_DAY) throw new ApiError('OUT_OF_RANGE', `${name} must be between ${FIRST_DAY} and ${LAST_DAY}`);
  return text;
}

function readCommon(p: Map<string, string>): CommonParams {
  const place = readPlace(p);
  const community = p.get('community');
  if (community !== undefined && !isCommunity(community)) throw new ApiError('INVALID_COMMUNITY', 'community must be sephardi, ashkenazi or chabad');
  const lang = p.get('lang') ?? 'en';
  if (!(API_LANGS as readonly string[]).includes(lang)) throw new ApiError('INVALID_LANG', 'lang must be en, he or ru');
  return { place, community: community ?? null, lang: lang as ApiLang };
}

/** Whole days from `a` to `b` (yyyy-MM-dd), read as the UTC days they name. */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** `to` is not before `from` and at most 366 days after it. */
export function checkRange(from: string, to: string): void {
  if (to < from) throw new ApiError('INVALID_RANGE', 'to must not be before from');
  if (daysBetween(from, to) > MAX_RANGE_DAYS) throw new ApiError('INVALID_RANGE', `to must be at most ${MAX_RANGE_DAYS} days after from`);
}

export function readShabbatParams(search: URLSearchParams): ShabbatParams {
  const p = singles(search, 'shabbat');
  const common = readCommon(p);
  const from = readDay(p.get('from'), 'from');
  const to = readDay(p.get('to'), 'to');
  if (from !== null && to !== null) checkRange(from, to);
  return { ...common, from, to };
}

export function readDayParams(search: URLSearchParams): DayParams {
  const p = singles(search, 'day');
  return { ...readCommon(p), date: readDay(p.get('date'), 'date') };
}

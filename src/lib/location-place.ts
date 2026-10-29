// Settings' location: what a Nominatim search answer means for the place the person typed, and a city-level name from a
// Nominatim address. Shared by the server's check of a typed place (app/api/location/check: the person's browser never
// calls OpenStreetMap for it, so OpenStreetMap sees our server, not the person) and the browser's "use my location"
// (app/[locale]/(app)/settings/location-lookup.ts). Pure and client-safe: no import.

/**
 * Granularity accepted for weather: anything from a country down to a suburb.
 * Nominatim's place_rank is the reliable dial here (country 4, state 8,
 * state_district 10, city 16, suburb 19, road 26, building 30) — addresstype is an
 * open-ended vocabulary, so an allowlist of it alone always leaves gaps.
 */
export const MAX_LOCATION_PLACE_RANK = 20;

/** Kept as an extra accept-path for named types that rank below the cutoff. */
export const VALID_LOCATION_TYPES = [
  'city', 'town', 'village', 'municipality', 'county', 'state', 'state_district',
  'country', 'suburb', 'hamlet', 'locality', 'region', 'province',
  'district', 'neighbourhood', 'borough', 'quarter',
];

/** The most a typed place may be: longer is no place name, and is not sent on. */
export const MAX_LOCATION_LENGTH = 200;

/**
 * Build a city-level name from a Nominatim `address` object. Shared by the
 * geolocation button and by the check of a typed place so both store the same shape.
 */
export const buildPlaceName = (addr: Record<string, string> | undefined): string => {
  const place =
    addr?.city || addr?.town || addr?.village || addr?.municipality ||
    addr?.county || addr?.state_district || addr?.state;
  const country = addr?.country;
  if (place && country) return `${place}, ${country}`;
  return place || '';
};

/** What checking a place came to: stored as `normalized`, or no such place, or Nominatim could not say. */
export type LocationCheck = { kind: 'valid'; normalized: string } | { kind: 'notFound' } | { kind: 'failed' };

/**
 * What Nominatim's search answer (format=json&limit=1&addressdetails=1) means for the place as typed: kept as typed when
 * the first hit is city-level or wider, collapsed to the city that contains it when it is narrower (a street address,
 * a building: weather is grid-based, so the precision buys nothing, and there is no reason to persist a house number),
 * or no such place.
 */
export function checkFromHits(hits: unknown, typed: string): LocationCheck {
  if (!Array.isArray(hits) || hits.length === 0) return { kind: 'notFound' };
  const result = hits[0] as { place_rank?: number; addresstype?: string; address?: Record<string, string> };
  // Anything geocodeLocation() can resolve is acceptable — this gate must never
  // be stricter than the weather pipeline that consumes the value. It decides
  // only whether to keep the string as typed. Deliberately not keyed on
  // `importance`: that measures fame, not granularity, so it would let a
  // well-known building ("1600 Pennsylvania Ave NW") through uncollapsed.
  const isCityLevel =
    (typeof result.place_rank === 'number' && result.place_rank <= MAX_LOCATION_PLACE_RANK) ||
    VALID_LOCATION_TYPES.includes(result.addresstype ?? '');
  if (isCityLevel) return { kind: 'valid', normalized: typed };
  const collapsed = buildPlaceName(result.address);
  return { kind: 'valid', normalized: collapsed || typed };
}

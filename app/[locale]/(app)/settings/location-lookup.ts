// Settings' location: checking a typed place and finding the place the device is in, both against
// OpenStreetMap's Nominatim (free, no key), called from the browser. Moved out of SettingsClient as it was;
// what changed is only that the checks answer with a result instead of setting the page's state, and that
// a failure is logged.

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
 * Validate a location, and collapse over-specific matches to the city containing
 * them. Returns the value that should actually be stored.
 */
export async function validateLocation(query: string): Promise<LocationCheck> {
  const trimmed = query.trim();

  if (!trimmed) return { kind: 'valid', normalized: '' }; // Empty is allowed

  try {
    const response = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(trimmed)}&format=json&limit=1&addressdetails=1`,
      {
        headers: {
          'User-Agent': 'FamCalBot/1.0',
          // Match the reverse-geocode call: names we may store must come back in
          // English, or a collapsed address lands in the DB in the local script.
          'Accept-Language': 'en',
        },
      },
    );

    if (!response.ok) {
      console.warn('[settings] location check answered', response.status);
      return { kind: 'failed' };
    }

    const data = await response.json();

    if (Array.isArray(data) && data.length > 0) {
      const result = data[0];

      // Anything geocodeLocation() can resolve is acceptable — this gate must never
      // be stricter than the weather pipeline that consumes the value. It decides
      // only whether to keep the string as typed. Deliberately not keyed on
      // `importance`: that measures fame, not granularity, so it would let a
      // well-known building ("1600 Pennsylvania Ave NW") through uncollapsed.
      const isCityLevel =
        result.place_rank <= MAX_LOCATION_PLACE_RANK ||
        VALID_LOCATION_TYPES.includes(result.addresstype);

      if (isCityLevel) {
        return { kind: 'valid', normalized: trimmed };
      }

      // Over-specific match (a street address or a single building): keep it, but
      // store the city that contains it. Weather is grid-based, so the precision
      // buys nothing, and there is no reason to persist a house number.
      const collapsed = buildPlaceName(result.address);
      return { kind: 'valid', normalized: collapsed || trimmed };
    }
    return { kind: 'notFound' };
  } catch (error) {
    console.warn('[settings] location check failed:', error);
    return { kind: 'failed' };
  }
}

/**
 * The place a position is in, as a city-level name ('' when Nominatim names none). Reverse geocoding:
 * zoom controls the *bottom* of the returned hierarchy, so a higher zoom only
 * ever adds narrower fields to `address`. zoom=14 is deep enough that city/town
 * is populated even in sparsely mapped areas (zoom=10 stops at the subdistrict
 * and omits it entirely), while staying above road level, where `name` ignores
 * accept-language, and building level, where `name` is often empty.
 * English output keeps the result forward-geocodable.
 */
export async function reverseLookup(lat: number, lon: number): Promise<string> {
  const response = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=14&accept-language=en`);
  const data = await response.json();

  // Always read `address`, never `name`/`display_name`: those hold whatever object
  // happened to match the zoom (a suburb, a road, an unnamed building), while
  // `address` reliably carries the containing city/town on upward.
  let locationString = buildPlaceName(data.address);

  if (!locationString && data.display_name) {
    // Fallback to display name, but shorten it
    const parts = data.display_name.split(',');
    locationString = parts.slice(0, 2).join(',').trim();
  }
  return locationString;
}

/** The device's position (browser geolocation; rejects when it is refused, unavailable or slow). */
export function devicePosition(): Promise<GeolocationPosition> {
  return new Promise<GeolocationPosition>((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: false,
      timeout: 10000,
      maximumAge: 300000, // 5 minutes cache
    });
  });
}

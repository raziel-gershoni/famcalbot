/**
 * Geocoding Service
 * Converts location strings to coordinates and timezone.
 * Uses Nominatim (OpenStreetMap) for the coordinates and our own zone map (zoneForCoords) for the zone.
 * FREE, no API key needed
 */

import { zoneForCoords } from '../../lib/zone-for-coords';
import { Coordinates } from '../../types';

/**
 * Fetch with a timeout and automatic retries on timeout/network errors.
 * Default timeout: 5s, 3 retries (these APIs normally respond in 200-500ms).
 */
export async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 5000, maxRetries = 3): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

export interface GeoLocation extends Coordinates {
  /** The zone our map gives the coordinates (zoneForCoords); null when it has none, logged there. Never a default. */
  timezone: string | null;
}

// Simple in-memory cache for 24h
const geocodeCache = new Map<string, { location: GeoLocation; timestamp: number }>();
const displayNameCache = new Map<string, { name: string; timestamp: number }>();
const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Geocode a location string to coordinates and timezone
 * Uses Nominatim (OpenStreetMap) for the coordinates and our own zone map (zoneForCoords) for the zone
 *
 * @param location - Human-readable location (e.g., "Harish, Israel")
 * @returns GeoLocation {latitude, longitude, timezone}
 */
export async function geocodeLocation(location: string): Promise<GeoLocation> {
  // Check cache first
  const cached = geocodeCache.get(location);
  if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
    console.log(`Using cached location for "${location}"`);
    return cached.location;
  }

  console.log(`Geocoding location: "${location}"`);

  try {
    // Nominatim API (OpenStreetMap)
    // Rate limit: 1 request per second (we respect this with cache)
    const encodedLocation = encodeURIComponent(location);
    const url = `https://nominatim.openstreetmap.org/search?q=${encodedLocation}&format=json&limit=1`;

    const response = await fetchWithTimeout(url, {
      headers: {
        'User-Agent': 'FamilyCalendarBot/1.0'  // Required by Nominatim
      }
    });

    if (!response.ok) {
      throw new Error(`Nominatim API error: ${response.status}`);
    }

    const results = await response.json() as Array<{ lat: string; lon: string }>;

    if (!results || results.length === 0) {
      throw new Error(`Location not found: "${location}"`);
    }

    const latitude = parseFloat(results[0].lat);
    const longitude = parseFloat(results[0].lon);

    // The zone from our own map; null (logged there) for a point at sea, never Asia/Jerusalem by default
    const timezone = zoneForCoords(latitude, longitude);

    const geoLocation: GeoLocation = { latitude, longitude, timezone };

    // Cache the result, unless it has no zone: the next call asks again (and logs why) instead of repeating the gap for a day
    if (timezone !== null) geocodeCache.set(location, { location: geoLocation, timestamp: Date.now() });

    console.log(`Geocoded "${location}" to ${latitude}, ${longitude} (${timezone})`);

    return geoLocation;
  } catch (error) {
    console.error(`Geocoding failed for "${location}":`, error);
    // The place is the person's free text: it stays in the console line above and out of the error, which callers report to Sentry
    throw new Error('Could not geocode the location (the lookup logged why)');
  }
}

/**
 * The zone of a location (geocodeLocation's). Rejects when the place has none (the zone lookup logged why): a caller
 * never falls back to another zone's clock.
 */
export async function getTimezone(location: string): Promise<string> {
  const { timezone } = await geocodeLocation(location);
  if (!timezone) throw new Error('No time zone for the place (the zone lookup logged why)');
  return timezone;
}

/**
 * Get localized display name for a location via Nominatim.
 * Cached per location+language for 24h. Falls back to original on failure.
 */
export async function getLocalizedLocationName(location: string, language: string): Promise<string> {
  const cacheKey = `${location}:${language}`;
  const cached = displayNameCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
    return cached.name;
  }

  try {
    const encodedLocation = encodeURIComponent(location);
    const url = `https://nominatim.openstreetmap.org/search?q=${encodedLocation}&format=json&limit=1&addressdetails=1`;
    const response = await fetchWithTimeout(url, {
      headers: {
        'User-Agent': 'FamilyCalendarBot/1.0',
        'Accept-Language': language,
      },
    });

    if (!response.ok) return location;

    const results = await response.json() as Array<{
      display_name: string;
      address?: { city?: string; town?: string; village?: string; state?: string; country?: string };
    }>;
    if (!results?.length) return location;

    // Build a short name: city/town + country
    const addr = results[0].address;
    const city = addr?.city || addr?.town || addr?.village;
    const country = addr?.country;
    const name = city && country ? `${city}, ${country}` : results[0].display_name.split(',').slice(0, 2).join(',');

    displayNameCache.set(cacheKey, { name, timestamp: Date.now() });
    return name;
  } catch {
    return location;
  }
}

/**
 * Clear the geocode cache (useful for testing)
 */
export function clearGeocodeCache(): void {
  geocodeCache.clear();
  displayNameCache.clear();
}

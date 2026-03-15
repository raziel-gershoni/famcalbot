/**
 * Geocoding Service
 * Converts location strings to coordinates and timezone
 * Uses Nominatim (OpenStreetMap) for geocoding and Open-Meteo for timezone
 * FREE, no API key needed
 */

import { Coordinates } from '../../types';

export interface GeoLocation extends Coordinates {
  timezone: string;
}

// Simple in-memory cache for 24h
const geocodeCache = new Map<string, { location: GeoLocation; timestamp: number }>();
const displayNameCache = new Map<string, { name: string; timestamp: number }>();
const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Geocode a location string to coordinates and timezone
 * Uses Nominatim (OpenStreetMap) for geocoding, Open-Meteo for timezone
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

    const response = await fetch(url, {
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

    // Get timezone from Open-Meteo using the coordinates
    const timezone = await getTimezoneFromCoords(latitude, longitude);

    const geoLocation: GeoLocation = { latitude, longitude, timezone };

    // Cache the result
    geocodeCache.set(location, { location: geoLocation, timestamp: Date.now() });

    console.log(`Geocoded "${location}" to ${latitude}, ${longitude} (${timezone})`);

    return geoLocation;
  } catch (error) {
    console.error(`Geocoding failed for "${location}":`, error);
    throw new Error(`Could not geocode location: ${location}`);
  }
}

/**
 * Get timezone from coordinates using Open-Meteo
 */
async function getTimezoneFromCoords(latitude: number, longitude: number): Promise<string> {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m&timezone=auto`;
    const response = await fetch(url);

    if (!response.ok) {
      console.warn('Failed to get timezone from Open-Meteo, using default');
      return 'Asia/Jerusalem';
    }

    const data = await response.json() as { timezone?: string };
    return data.timezone || 'Asia/Jerusalem';
  } catch (error) {
    console.warn('Error getting timezone:', error);
    return 'Asia/Jerusalem';
  }
}

/**
 * Get timezone for a location (convenience wrapper)
 */
export async function getTimezone(location: string): Promise<string> {
  const geoLocation = await geocodeLocation(location);
  return geoLocation.timezone;
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
    const response = await fetch(url, {
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

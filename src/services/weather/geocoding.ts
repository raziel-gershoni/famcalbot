/**
 * Geocoding Service
 * Converts location strings to coordinates using Nominatim (OpenStreetMap)
 * FREE, no API key needed
 */

import { Coordinates } from '../../types';

// Simple in-memory cache for 24h
const geocodeCache = new Map<string, { coords: Coordinates; timestamp: number }>();
const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Geocode a location string to coordinates
 * Uses Nominatim (OpenStreetMap) - free, no API key
 *
 * @param location - Human-readable location (e.g., "Harish, Israel")
 * @returns Coordinates {latitude, longitude}
 */
export async function geocodeLocation(location: string): Promise<Coordinates> {
  // Check cache first
  const cached = geocodeCache.get(location);
  if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
    console.log(`Using cached coordinates for "${location}"`);
    return cached.coords;
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

    const coords: Coordinates = {
      latitude: parseFloat(results[0].lat),
      longitude: parseFloat(results[0].lon)
    };

    // Cache the result
    geocodeCache.set(location, { coords, timestamp: Date.now() });

    console.log(`Geocoded "${location}" to ${coords.latitude}, ${coords.longitude}`);

    return coords;
  } catch (error) {
    console.error(`Geocoding failed for "${location}":`, error);
    throw new Error(`Could not geocode location: ${location}`);
  }
}

/**
 * Clear the geocode cache (useful for testing)
 */
export function clearGeocodeCache(): void {
  geocodeCache.clear();
}

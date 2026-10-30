// Settings' location: checking a typed place, and naming the place the device is in.
// - The typed place is checked by our server (POST /api/location/check), so OpenStreetMap sees our server's address and
//   never the person's; the answer's meaning is src/lib/location-place.ts's, shared with the server.
// - "Use my location" takes the device's position from src/lib/geolocation.ts (shared with the zmanim pages' Near me) and
//   asks OpenStreetMap's reverse lookup from the browser: the Privacy Policy promises the device's position never reaches
//   our servers, and names OpenStreetMap's receipt of the browser's IP address for it.
// A failure is logged.

import { readInitData } from '@/src/lib/read-init-data';
import { buildPlaceName, type LocationCheck } from '@/src/lib/location-place';

export type { LocationCheck };

/**
 * Validate a location, and collapse over-specific matches to the city containing them (the server's check). Returns the
 * value that should actually be stored. `userId` is the page's user_id, as Settings' save sends it.
 */
export async function validateLocation(query: string, userId: string | number): Promise<LocationCheck> {
  const trimmed = query.trim();

  if (!trimmed) return { kind: 'valid', normalized: '' }; // Empty is allowed

  try {
    const response = await fetch(`/api/location/check?user_id=${encodeURIComponent(String(userId))}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ place: trimmed, initData: readInitData() || undefined }),
    });
    if (!response.ok) {
      console.warn('[settings] location check answered', response.status);
      return { kind: 'failed' };
    }
    const { check } = (await response.json()) as { check?: LocationCheck };
    if (check?.kind === 'valid' || check?.kind === 'notFound') return check;
    console.warn(check?.kind === 'failed' ? '[settings] location check: OpenStreetMap could not say (the server logged why)' : '[settings] location check sent no answer it knows');
    return { kind: 'failed' };
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

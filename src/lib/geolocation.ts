// The device's position, asked of the browser: Settings' "Use my current location" and the zmanim index's "Near me"
// (spec 2026-10-30-public-zmanim §4.1.2, §6.3). One request with one set of options, and its outcome as data, so each
// caller words and logs it its own way (a refusal is the person's choice, not an error). The timeout is the
// Geolocation API's own option, not an app timer. The position goes back to the caller only; this file sends nothing.
// Client-safe: no import.

export type GeoResult = { kind: 'ok'; latitude: number; longitude: number } | { kind: 'denied' } | { kind: 'unavailable' } | { kind: 'unsupported' };

/** No high accuracy, the browser's own 10 s timeout, and a position up to 5 minutes old. */
export const POSITION_OPTIONS: PositionOptions = { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 };

/** GeolocationPositionError.PERMISSION_DENIED (the constant isn't on every browser's error object). */
const PERMISSION_DENIED = 1;

/** The device's position, or why there is none. Never rejects. */
export function currentPosition(): Promise<GeoResult> {
  const geolocation = typeof navigator === 'undefined' ? undefined : navigator.geolocation;
  if (!geolocation) return Promise.resolve({ kind: 'unsupported' });
  return new Promise<GeoResult>((resolve) => {
    try {
      geolocation.getCurrentPosition(
        (position) => resolve({ kind: 'ok', latitude: position.coords.latitude, longitude: position.coords.longitude }),
        (error) => resolve({ kind: error?.code === PERMISSION_DENIED ? 'denied' : 'unavailable' }),
        POSITION_OPTIONS,
      );
    } catch (error) {
      console.warn('[geolocation] the browser refused to ask for the position:', error);
      resolve({ kind: 'unavailable' });
    }
  });
}

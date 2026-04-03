/**
 * Open-Meteo Air Quality API
 * FREE, no authentication required
 * https://open-meteo.com/en/docs/air-quality-api
 */

import { AirQualityData } from '../../types';
import { fetchWithTimeout, geocodeLocation } from './geocoding';

interface AirQualityResponse {
  hourly: {
    time: string[];
    pm10: (number | null)[];
    pm2_5: (number | null)[];
    dust: (number | null)[];
  };
}

/**
 * Fetch air quality data from Open-Meteo Air Quality API.
 * Returns null on any error (graceful degradation — must never break weather).
 */
export async function fetchAirQuality(
  location: string,
  timezone: string = 'Asia/Jerusalem'
): Promise<AirQualityData | null> {
  try {
    const coords = await geocodeLocation(location);

    const params = new URLSearchParams({
      latitude: coords.latitude.toString(),
      longitude: coords.longitude.toString(),
      hourly: 'pm10,pm2_5,dust',
      timezone,
      forecast_days: '7',
    });

    const url = `https://air-quality-api.open-meteo.com/v1/air-quality?${params.toString()}`;
    const response = await fetchWithTimeout(url);

    if (!response.ok) {
      console.warn(`Air quality API error: ${response.status}`);
      return null;
    }

    const data = (await response.json()) as AirQualityResponse;

    return {
      hourly: {
        time: data.hourly.time,
        pm10: data.hourly.pm10,
        pm2_5: data.hourly.pm2_5,
        dust: data.hourly.dust,
      },
    };
  } catch (error) {
    console.warn('Failed to fetch air quality data:', error);
    return null;
  }
}

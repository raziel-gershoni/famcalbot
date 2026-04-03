/**
 * Dust storm detection using Open-Meteo Air Quality data.
 * Separate from thermal sharav — catches Saharan dust transport events
 * that arrive via upper-level winds with moderate temperatures.
 */

import { AirQualityData, WeatherData } from '../../types';

export interface DustStormDay {
  dayIndex: number;
  date: string;
  severity: 'mild' | 'moderate' | 'severe';
  peakPM10: number;
  peakDust: number;
  minVisibility?: number;
  clearingHour?: number;
}

/**
 * Get severity from peak concentration (PM10 or dust, whichever is higher).
 * Thresholds based on WHO guidelines and Israeli meteorological standards.
 */
function getDustSeverity(peak: number): 'mild' | 'moderate' | 'severe' {
  if (peak > 200) return 'severe';
  if (peak >= 100) return 'moderate';
  return 'mild';
}

/**
 * Compute minimum daytime visibility (06:00–22:00) for a given day.
 */
function computeMinVisibility(
  hourly: NonNullable<WeatherData['hourly']>,
  dayDate: string
): number | undefined {
  if (!hourly.visibility) return undefined;

  let min = Infinity;
  let found = false;

  for (let i = 0; i < hourly.time.length; i++) {
    if (!hourly.time[i].startsWith(dayDate)) continue;
    const hour = new Date(hourly.time[i]).getHours();
    if (hour >= 6 && hour <= 22) {
      const v = hourly.visibility[i];
      if (v != null && v < min) {
        min = v;
        found = true;
      }
    }
  }

  return found ? Math.round(min) : undefined;
}

/**
 * Detect dust storm days from air quality data.
 * Returns [] if airQuality is null (graceful degradation).
 */
export function detectDustStorm(
  airQuality: AirQualityData | null,
  weather?: WeatherData
): DustStormDay[] {
  if (!airQuality) return [];

  const { time, pm10, dust } = airQuality.hourly;
  if (!time.length) return [];

  // Group hourly data by date
  const dayMap = new Map<string, { pm10: number[]; dust: number[]; hours: number[] }>();

  for (let i = 0; i < time.length; i++) {
    const date = time[i].slice(0, 10); // "YYYY-MM-DD"
    if (!dayMap.has(date)) {
      dayMap.set(date, { pm10: [], dust: [], hours: [] });
    }
    const day = dayMap.get(date)!;
    day.pm10.push(pm10[i] ?? 0);
    day.dust.push(dust[i] ?? 0);
    day.hours.push(new Date(time[i]).getHours());
  }

  // Get ordered dates to compute dayIndex
  const dates = [...dayMap.keys()].sort();

  const results: DustStormDay[] = [];

  for (let dayIndex = 0; dayIndex < dates.length; dayIndex++) {
    const date = dates[dayIndex];
    const day = dayMap.get(date)!;

    const peakPM10 = Math.round(Math.max(...day.pm10));
    const peakDust = Math.round(Math.max(...day.dust));
    const peak = Math.max(peakPM10, peakDust);

    if (peak < 50) continue;

    let severity = getDustSeverity(peak);

    // Check visibility from weather data — upgrade severity if very low
    let minVisibility: number | undefined;
    if (weather?.hourly) {
      minVisibility = computeMinVisibility(weather.hourly, date);
      if (minVisibility != null && minVisibility < 1000 && severity !== 'severe') {
        severity = 'severe';
      }
    }

    // Compute clearing hour for today/tomorrow only
    let clearingHour: number | undefined;
    if (dayIndex <= 1) {
      // Find peak hour first
      let peakIdx = 0;
      let peakVal = 0;
      for (let i = 0; i < day.pm10.length; i++) {
        if (day.pm10[i] > peakVal) {
          peakVal = day.pm10[i];
          peakIdx = i;
        }
      }
      // Scan after peak for first hour when PM10 drops below 50
      for (let i = peakIdx + 1; i < day.pm10.length; i++) {
        if (day.pm10[i] < 50) {
          clearingHour = day.hours[i];
          break;
        }
      }
    }

    results.push({
      dayIndex,
      date,
      severity,
      peakPM10,
      peakDust,
      minVisibility,
      clearingHour,
    });
  }

  return results;
}

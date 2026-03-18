/**
 * Sharav (hot dry desert wind) detection heuristic
 * Uses temperature, wind direction, humidity, and weather code from Open-Meteo data.
 */

import { WeatherData } from '../../types';
import { getWindDirectionLabel } from './open-meteo';

export interface SharavDay {
  dayIndex: number;
  date: string;
  severity: 'mild' | 'moderate' | 'severe';
  tempMax: number;
  avgHumidity: number;
  windDirectionLabel: string;
  anomaly: number;
  sharavBreakHour?: number;
}

/**
 * Monthly average max temperatures for Israel (central/coastal), Jan–Dec.
 * Used to compute temperature anomaly for sharav detection.
 */
const MONTHLY_AVG_MAX: readonly number[] = [17, 18, 20, 25, 28, 31, 33, 33, 32, 29, 24, 18];

/**
 * Compute average daytime humidity (08:00–18:00) for a given day
 */
function computeDaytimeHumidity(
  hourly: NonNullable<WeatherData['hourly']>,
  dayDate: string
): number {
  let sum = 0;
  let count = 0;

  for (let i = 0; i < hourly.time.length; i++) {
    const timeStr = hourly.time[i];
    if (!timeStr.startsWith(dayDate)) continue;

    const hour = new Date(timeStr).getHours();
    if (hour >= 8 && hour <= 18) {
      sum += hourly.humidity[i];
      count++;
    }
  }

  return count > 0 ? Math.round(sum / count) : 100; // default high = no sharav
}

/**
 * Check if wind direction is from E through SW (90°–225°)
 */
function isDesertWindDirection(degrees: number): boolean {
  return degrees >= 90 && degrees <= 225;
}

/**
 * Weather codes compatible with sharav conditions:
 * 0–3 (clear/cloudy), 45/48 (fog — dust haze can appear as fog)
 */
function isSharavWeatherCode(code: number): boolean {
  return (code >= 0 && code <= 3) || code === 45 || code === 48;
}

/**
 * Detect the hour when sharav conditions ease (humidity rises above 40%).
 * Only meaningful for today (dayIndex 0) and tomorrow (dayIndex 1).
 */
function detectSharavBreakHour(
  hourly: NonNullable<WeatherData['hourly']>,
  dayDate: string
): number | null {
  for (let i = 0; i < hourly.time.length; i++) {
    const timeStr = hourly.time[i];
    if (!timeStr.startsWith(dayDate)) continue;

    const hour = new Date(timeStr).getHours();
    if (hour < 12) continue; // Only scan from noon onward

    if (hourly.humidity[i] >= 40) {
      return hour;
    }
  }
  return null;
}

/**
 * Detect sharav days from weather data.
 * Criteria per day:
 *  - tempMax >= 27°C (IMS absolute minimum)
 *  - tempMax >= monthlyAvg + 5°C (anomaly criterion)
 *  - wind direction 90°–225° (E through SW)
 *  - average daytime humidity < 40%
 *  - weather code: clear/cloudy/fog
 *
 * Severity based on anomaly: mild 5–8°C, moderate 8–12°C, severe >12°C
 */
export function detectSharav(weather: WeatherData): SharavDay[] {
  const daily = weather.daily;
  const hourly = weather.hourly;
  if (!daily || !hourly) return [];

  const results: SharavDay[] = [];

  for (let i = 0; i < daily.length; i++) {
    const day = daily[i];

    if (day.tempMax < 27) continue;

    const month = parseInt(day.date.slice(5, 7), 10) - 1; // 0-based
    const monthlyAvg = MONTHLY_AVG_MAX[month];
    const anomaly = Math.round((day.tempMax - monthlyAvg) * 10) / 10;

    if (anomaly < 5) continue;
    if (!isDesertWindDirection(day.windDirection)) continue;
    if (!isSharavWeatherCode(day.weatherCode)) continue;

    const avgHumidity = computeDaytimeHumidity(hourly, day.date);
    if (avgHumidity >= 40) continue;

    const severity: SharavDay['severity'] =
      anomaly > 12 ? 'severe' : anomaly >= 8 ? 'moderate' : 'mild';

    results.push({
      dayIndex: i,
      date: day.date,
      severity,
      tempMax: day.tempMax,
      avgHumidity,
      windDirectionLabel: getWindDirectionLabel(day.windDirection),
      anomaly,
      sharavBreakHour: i <= 1 ? detectSharavBreakHour(hourly, day.date) ?? undefined : undefined,
    });
  }

  return results;
}

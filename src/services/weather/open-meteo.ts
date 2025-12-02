/**
 * Open-Meteo Weather Provider
 * FREE weather API, no authentication required
 * https://open-meteo.com/
 */

import { WeatherData } from '../../types';
import { geocodeLocation } from './geocoding';

interface OpenMeteoResponse {
  current: {
    time: string;
    temperature_2m: number;
    relative_humidity_2m: number;
    apparent_temperature: number;
    weather_code: number;
    wind_speed_10m: number;
    uv_index: number;
  };
  hourly: {
    time: string[];
    temperature_2m: number[];
    precipitation_probability: number[];
    precipitation: number[];
    weather_code: number[];
    wind_speed_10m: number[];
  };
  daily: {
    time: string[];
    temperature_2m_max: number[];
    temperature_2m_min: number[];
    precipitation_probability_max: number[];
    weather_code: number[];
    wind_speed_10m_max: number[];
    sunrise: string[];
    sunset: string[];
    uv_index_max: number[];
  };
}

/**
 * Fetch weather data from Open-Meteo API
 *
 * @param location - Human-readable location (e.g., "Harish, Israel")
 * @param timezone - Timezone for the forecast (default: "Asia/Jerusalem")
 * @returns Weather data with current, today, tomorrow, hourly, and 7-day forecasts
 */
export async function fetchWeather(
  location: string,
  timezone: string = 'Asia/Jerusalem'
): Promise<WeatherData> {
  console.log(`Fetching weather for: ${location}`);

  // Get coordinates for the location
  const coords = await geocodeLocation(location);

  // Build Open-Meteo API URL
  const params = new URLSearchParams({
    latitude: coords.latitude.toString(),
    longitude: coords.longitude.toString(),
    current: 'temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,uv_index',
    hourly: 'temperature_2m,precipitation_probability,precipitation,weather_code,wind_speed_10m',
    daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code,wind_speed_10m_max,sunrise,sunset,uv_index_max',
    timezone: timezone,
    forecast_days: '7'
  });

  const url = `https://api.open-meteo.com/v1/forecast?${params.toString()}`;

  console.log(`Fetching from Open-Meteo API...`);

  try {
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Open-Meteo API error: ${response.status}`);
    }

    const data = await response.json() as OpenMeteoResponse;

    // Parse the response into our WeatherData structure
    const weatherData: WeatherData = {
      location,
      current: {
        temperature: Math.round(data.current.temperature_2m),
        feelsLike: Math.round(data.current.apparent_temperature),
        humidity: data.current.relative_humidity_2m,
        weatherCode: data.current.weather_code,
        windSpeed: Math.round(data.current.wind_speed_10m),
        uvIndex: Math.round(data.current.uv_index * 10) / 10  // One decimal place
      },
      today: {
        tempMax: Math.round(data.daily.temperature_2m_max[0]),
        tempMin: Math.round(data.daily.temperature_2m_min[0]),
        precipitationProbability: data.daily.precipitation_probability_max[0],
        weatherCode: data.daily.weather_code[0],
        sunrise: data.daily.sunrise[0],
        sunset: data.daily.sunset[0],
        uvIndexMax: Math.round(data.daily.uv_index_max[0] * 10) / 10
      },
      tomorrow: data.daily.time.length > 1 ? {
        tempMax: Math.round(data.daily.temperature_2m_max[1]),
        tempMin: Math.round(data.daily.temperature_2m_min[1]),
        precipitationProbability: data.daily.precipitation_probability_max[1],
        weatherCode: data.daily.weather_code[1],
        sunrise: data.daily.sunrise[1],
        sunset: data.daily.sunset[1],
        uvIndexMax: Math.round(data.daily.uv_index_max[1] * 10) / 10
      } : undefined,
      hourly: {
        time: data.hourly.time,
        temperature: data.hourly.temperature_2m,
        precipitation_probability: data.hourly.precipitation_probability,
        precipitation: data.hourly.precipitation,
        weatherCode: data.hourly.weather_code,
        windSpeed: data.hourly.wind_speed_10m
      },
      daily: data.daily.time.map((date, index) => ({
        date,
        tempMax: Math.round(data.daily.temperature_2m_max[index]),
        tempMin: Math.round(data.daily.temperature_2m_min[index]),
        precipitationProbability: data.daily.precipitation_probability_max[index],
        weatherCode: data.daily.weather_code[index],
        sunrise: data.daily.sunrise[index],
        sunset: data.daily.sunset[index],
        uvIndexMax: Math.round(data.daily.uv_index_max[index] * 10) / 10
      }))
    };

    console.log(`Weather data fetched successfully for ${location}`);
    console.log(`Current: ${weatherData.current.temperature}°C, Today: ${weatherData.today.tempMin}-${weatherData.today.tempMax}°C`);

    return weatherData;
  } catch (error) {
    console.error(`Failed to fetch weather for "${location}":`, error);
    throw new Error(`Could not fetch weather data: ${error}`);
  }
}

/**
 * Weather code descriptions (WMO Weather interpretation codes)
 * https://open-meteo.com/en/docs
 */
export function getWeatherDescription(code: number): string {
  const descriptions: Record<number, string> = {
    0: 'Clear sky',
    1: 'Mainly clear',
    2: 'Partly cloudy',
    3: 'Overcast',
    45: 'Foggy',
    48: 'Depositing rime fog',
    51: 'Light drizzle',
    53: 'Moderate drizzle',
    55: 'Dense drizzle',
    56: 'Light freezing drizzle',
    57: 'Dense freezing drizzle',
    61: 'Slight rain',
    63: 'Moderate rain',
    65: 'Heavy rain',
    66: 'Light freezing rain',
    67: 'Heavy freezing rain',
    71: 'Slight snow',
    73: 'Moderate snow',
    75: 'Heavy snow',
    77: 'Snow grains',
    80: 'Slight rain showers',
    81: 'Moderate rain showers',
    82: 'Violent rain showers',
    85: 'Slight snow showers',
    86: 'Heavy snow showers',
    95: 'Thunderstorm',
    96: 'Thunderstorm with slight hail',
    99: 'Thunderstorm with heavy hail'
  };

  return descriptions[code] || 'Unknown';
}

/**
 * Get emoji for weather code
 */
export function getWeatherEmoji(code: number): string {
  if (code === 0) return '☀️';
  if (code <= 3) return '⛅';
  if (code <= 48) return '🌫️';
  if (code <= 57) return '🌧️';
  if (code <= 67) return '🌧️';
  if (code <= 77) return '❄️';
  if (code <= 82) return '🌧️';
  if (code <= 86) return '❄️';
  if (code >= 95) return '⛈️';
  return '🌤️';
}

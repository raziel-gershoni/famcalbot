// Today's weather for the calendar home's header (GET /api/home-weather): the forecast reduced to what the header shows.
// Server only (it reads the weather services); the shape is the client-safe src/lib/calendar-view/home-weather.ts's.

import type { BotMessages } from '../../lib/bot-messages';
import type { HomeWeather } from '../../lib/calendar-view/home-weather';
import type { WeatherData } from '../../types';
import { describeWeather } from './forecast';
import { weatherIconName } from './weather-icons';

/** A temperature in whole degrees; Math.round(-0.4) is -0, and "-0°" is never shown. */
const whole = (degrees: number): number => Math.round(degrees) || 0;

/** How many days after today the header shows (the client's strip shows as many as fit, the later ones drop first). */
const DAYS_AHEAD = 4;

/**
 * The temperature now, today's low and high, today's icon and condition (today's code, the day's most notable weather,
 * not the current step's), the person's place as they typed it (trimmed; it goes to their own screen, never to a log) and
 * up to four days after today with each one's high, icon and condition (`daily[0]` is today). The conditions are worded
 * by describeWeather in the language of `t`.
 */
export function homeWeatherOf(weather: WeatherData, t: BotMessages, place: string): HomeWeather {
  return {
    place: place.trim(),
    now: whole(weather.current.temperature),
    low: whole(weather.today.tempMin),
    high: whole(weather.today.tempMax),
    icon: weatherIconName(weather.today.weatherCode),
    condition: describeWeather(weather.today.weatherCode, t),
    days: (weather.daily ?? []).slice(1, 1 + DAYS_AHEAD).map((d) => ({
      date: d.date,
      high: whole(d.tempMax),
      icon: weatherIconName(d.weatherCode),
      condition: describeWeather(d.weatherCode, t),
    })),
  };
}

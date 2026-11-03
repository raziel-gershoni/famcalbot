// Today's weather for the calendar home's header (GET /api/home-weather): the forecast reduced to what the header shows.
// Server only (it reads the weather services); the shape is the client-safe src/lib/calendar-view/home-weather.ts's.

import type { BotMessages } from '../../lib/bot-messages';
import type { HomeWeather } from '../../lib/calendar-view/home-weather';
import type { WeatherData } from '../../types';
import { describeWeather } from './forecast';
import { weatherIconName } from './weather-icons';

/** A temperature in whole degrees; Math.round(-0.4) is -0, and "-0°" is never shown. */
const whole = (degrees: number): number => Math.round(degrees) || 0;

/**
 * The temperature now, today's low and high, and today's icon and condition (today's code, the day's most notable
 * weather, not the current step's). The condition is worded by describeWeather in the language of `t`.
 */
export function homeWeatherOf(weather: WeatherData, t: BotMessages): HomeWeather {
  return {
    now: whole(weather.current.temperature),
    low: whole(weather.today.tempMin),
    high: whole(weather.today.tempMax),
    icon: weatherIconName(weather.today.weatherCode),
    condition: describeWeather(weather.today.weatherCode, t),
  };
}

/**
 * Weather Formatter
 * Formats weather data for standard and detailed display
 */

import { WeatherData } from '../../types';
import { getWeatherDescription, getWeatherEmoji } from './open-meteo';

interface RainHours {
  startTime: string;
  endTime: string;
  probability: number;
}

/**
 * Extract rain hours from hourly data for a specific day
 *
 * @param hourly - Hourly weather data
 * @param dayDate - Date string (YYYY-MM-DD) to analyze
 * @returns Array of rain periods with start/end times and probability
 */
function extractRainHours(
  hourly: { time: string[]; precipitation_probability: number[]; precipitation: number[] },
  dayDate: string
): RainHours[] {
  const rainPeriods: RainHours[] = [];
  let currentPeriod: RainHours | null = null;

  for (let i = 0; i < hourly.time.length; i++) {
    const timeStr = hourly.time[i];
    const date = timeStr.split('T')[0];

    // Only process hours for the specified day
    if (date !== dayDate) {
      // If we were tracking a period and day changed, close it
      if (currentPeriod) {
        rainPeriods.push(currentPeriod);
        currentPeriod = null;
      }
      continue;
    }

    const probability = hourly.precipitation_probability[i];
    const precipitation = hourly.precipitation[i];

    // Consider it "rain" if probability >= 40% or actual precipitation > 0
    if (probability >= 40 || precipitation > 0) {
      const hour = new Date(timeStr).getHours();
      const timeDisplay = `${hour.toString().padStart(2, '0')}:00`;

      if (!currentPeriod) {
        // Start new rain period
        currentPeriod = {
          startTime: timeDisplay,
          endTime: timeDisplay,
          probability: probability
        };
      } else {
        // Extend current period
        currentPeriod.endTime = timeDisplay;
        currentPeriod.probability = Math.max(currentPeriod.probability, probability);
      }
    } else {
      // No rain, close current period if exists
      if (currentPeriod) {
        rainPeriods.push(currentPeriod);
        currentPeriod = null;
      }
    }
  }

  // Close any remaining period
  if (currentPeriod) {
    rainPeriods.push(currentPeriod);
  }

  return rainPeriods;
}

/**
 * Format rain hours for display
 */
function formatRainHours(rainPeriods: RainHours[]): string {
  if (rainPeriods.length === 0) return '';

  return rainPeriods
    .map(period => {
      if (period.startTime === period.endTime) {
        return `${period.startTime} (${period.probability}%)`;
      }
      return `${period.startTime} - ${period.endTime} (${period.probability}%)`;
    })
    .join(', ');
}

/**
 * Get UV index description
 */
function getUVDescription(uvIndex: number): string {
  if (uvIndex < 3) return 'Low';
  if (uvIndex < 6) return 'Moderate';
  if (uvIndex < 8) return 'High';
  if (uvIndex < 11) return 'Very High';
  return 'Extreme';
}

/**
 * Generate pattern-based weekly summary (rule-based, no AI)
 */
function generateWeeklySummary(daily: WeatherData['daily']): string {
  if (!daily || daily.length < 3) return '';

  // Analyze days 2-6 (skip today and tomorrow)
  const weekDays = daily.slice(2, Math.min(7, daily.length));
  if (weekDays.length === 0) return '';

  const summary: string[] = [];

  // Temperature trend analysis
  const firstTemp = (weekDays[0].tempMin + weekDays[0].tempMax) / 2;
  const lastTemp = (weekDays[weekDays.length - 1].tempMin + weekDays[weekDays.length - 1].tempMax) / 2;
  const tempDiff = lastTemp - firstTemp;

  const minTemp = Math.min(...weekDays.map(d => d.tempMin));
  const maxTemp = Math.max(...weekDays.map(d => d.tempMax));

  // Build temperature trend description
  let tempDesc = '';
  if (Math.abs(tempDiff) > 5) {
    // Significant trend
    if (tempDiff > 0) {
      tempDesc = `Warming trend, ${Math.round(firstTemp)}°C → ${Math.round(lastTemp)}°C`;
    } else {
      tempDesc = `Cooling trend, ${Math.round(firstTemp)}°C → ${Math.round(lastTemp)}°C`;
    }
  } else {
    // Stable temps
    tempDesc = `Stable temps around ${Math.round((minTemp + maxTemp) / 2)}°C (${minTemp}-${maxTemp}°C range)`;
  }

  summary.push(tempDesc);

  // Rain analysis
  const rainyDays = weekDays.filter(d => d.precipitationProbability >= 40);
  if (rainyDays.length > 0) {
    const rainDayNames = rainyDays.map(d => {
      const date = new Date(d.date);
      return date.toLocaleDateString('en-US', { weekday: 'short' });
    }).join(', ');

    if (rainyDays.length === 1) {
      summary.push(`rain ${rainDayNames}`);
    } else {
      summary.push(`rain likely ${rainDayNames}`);
    }
  } else {
    summary.push('mostly dry');
  }

  // Weather pattern (clear vs cloudy)
  const clearDays = weekDays.filter(d => d.weatherCode <= 1).length;
  const totalDays = weekDays.length;

  if (clearDays >= totalDays * 0.7) {
    summary.push('clear skies');
  } else if (clearDays <= totalDays * 0.3) {
    summary.push('mostly overcast');
  }

  return summary.join(', ');
}

/**
 * Format time from ISO string to HH:MM
 */
function formatTime(isoString: string): string {
  const date = new Date(isoString);
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  return `${hours}:${minutes}`;
}

/**
 * Generate ASCII temperature graph for the week
 */
function generateTemperatureGraph(daily: WeatherData['daily']): string {
  if (!daily || daily.length < 2) return '';

  const data = daily.slice(0, 7);
  const temps = data.flatMap(d => [d.tempMin, d.tempMax]);
  const minTemp = Math.min(...temps);
  const maxTemp = Math.max(...temps);
  const range = maxTemp - minTemp;

  // Graph height (in characters)
  const height = 8;
  const graphLines: string[] = [];

  // Build graph from top to bottom
  for (let row = height; row >= 0; row--) {
    const temp = minTemp + (range * row / height);
    let line = `${Math.round(temp).toString().padStart(3)}°│`;

    for (const day of data) {
      const maxPos = Math.round(((day.tempMax - minTemp) / range) * height);
      const minPos = Math.round(((day.tempMin - minTemp) / range) * height);

      if (row === maxPos) {
        line += '▄';
      } else if (row === minPos) {
        line += '▀';
      } else if (row > minPos && row < maxPos) {
        line += '█';
      } else {
        line += ' ';
      }
    }

    graphLines.push(line);
  }

  // Add day labels
  const dayLabels = '    └' + data.map(d => {
    const date = new Date(d.date);
    return date.toLocaleDateString('en-US', { weekday: 'narrow' });
  }).join('');

  graphLines.push(dayLabels);

  return '```\n' + graphLines.join('\n') + '\n```';
}

/**
 * Format weather data in standard format
 * Simple, concise view with current conditions and forecast
 */
export async function formatWeatherStandard(weather: WeatherData): Promise<string> {
  let output = `🌤️ *Weather for ${weather.location}*\n\n`;

  // Current conditions
  output += `*Now:* ${weather.current.temperature}°C (feels like ${weather.current.feelsLike}°C)\n`;
  output += `${getWeatherEmoji(weather.current.weatherCode)} ${getWeatherDescription(weather.current.weatherCode)}\n`;
  output += `💨 Wind: ${weather.current.windSpeed} km/h | 💧 Humidity: ${weather.current.humidity}%\n\n`;

  // Today
  output += `*Today:* ${weather.today.tempMin}-${weather.today.tempMax}°C`;
  if (weather.today.precipitationProbability > 0) {
    output += ` | ${weather.today.precipitationProbability}% rain`;
  }
  output += `\n`;

  // Check for rain hours today
  if (weather.today.precipitationProbability >= 40 && weather.hourly) {
    const todayDate = weather.daily?.[0]?.date || new Date().toISOString().split('T')[0];
    const rainHours = extractRainHours(weather.hourly, todayDate);
    if (rainHours.length > 0) {
      output += `   ⏰ Rain expected: ${formatRainHours(rainHours)}\n`;
    }
  }

  // Tomorrow
  if (weather.tomorrow) {
    output += `*Tomorrow:* ${weather.tomorrow.tempMin}-${weather.tomorrow.tempMax}°C`;
    if (weather.tomorrow.precipitationProbability > 0) {
      output += ` | ${weather.tomorrow.precipitationProbability}% rain`;
    }
    output += `\n`;

    // Check for rain hours tomorrow
    if (weather.tomorrow.precipitationProbability >= 40 && weather.hourly) {
      const tomorrowDate = weather.daily?.[1]?.date || '';
      if (tomorrowDate) {
        const rainHours = extractRainHours(weather.hourly, tomorrowDate);
        if (rainHours.length > 0) {
          output += `   ⏰ Rain expected: ${formatRainHours(rainHours)}\n`;
        }
      }
    }
  }

  // Weekly pattern summary
  if (weather.daily && weather.daily.length > 2) {
    const weeklySummary = generateWeeklySummary(weather.daily);
    if (weeklySummary) {
      output += `\n*This Week:*\n${weeklySummary}`;
    }
  }

  return output;
}

/**
 * Format weather data in detailed format
 * Comprehensive view with hourly breakdown, UV, sunrise/sunset, and temperature graph
 */
export async function formatWeatherDetailed(weather: WeatherData): Promise<string> {
  let output = `🌤️ *Weather for ${weather.location}*\n\n`;

  // ========== CURRENT CONDITIONS ==========
  output += `*━━━ Current Conditions ━━━*\n`;
  output += `${getWeatherEmoji(weather.current.weatherCode)} ${getWeatherDescription(weather.current.weatherCode)}\n`;
  output += `🌡️ Temperature: ${weather.current.temperature}°C (feels like ${weather.current.feelsLike}°C)\n`;
  output += `💨 Wind: ${weather.current.windSpeed} km/h`;

  // Wind comfort
  if (weather.current.windSpeed > 25) {
    output += ` (Strong winds, feels colder)`;
  } else if (weather.current.windSpeed > 15) {
    output += ` (Breezy)`;
  }
  output += `\n`;

  output += `💧 Humidity: ${weather.current.humidity}%\n`;
  output += `☀️ UV Index: ${weather.current.uvIndex} (${getUVDescription(weather.current.uvIndex)})\n\n`;

  // ========== TODAY ==========
  output += `*━━━ Today ━━━*\n`;
  output += `📈 High: ${weather.today.tempMax}°C | 📉 Low: ${weather.today.tempMin}°C\n`;
  output += `${getWeatherEmoji(weather.today.weatherCode)} ${getWeatherDescription(weather.today.weatherCode)}\n`;
  output += `🌅 Sunrise: ${formatTime(weather.today.sunrise)} | 🌇 Sunset: ${formatTime(weather.today.sunset)}\n`;
  output += `☀️ Max UV: ${weather.today.uvIndexMax} (${getUVDescription(weather.today.uvIndexMax)})`;

  if (weather.today.uvIndexMax >= 6) {
    output += ` - Sunscreen recommended`;
  }
  output += `\n`;

  if (weather.today.precipitationProbability > 0) {
    output += `🌧️ Rain probability: ${weather.today.precipitationProbability}%\n`;
  }

  // Rain hours for today
  if (weather.today.precipitationProbability >= 40 && weather.hourly) {
    const todayDate = weather.daily?.[0]?.date || new Date().toISOString().split('T')[0];
    const rainHours = extractRainHours(weather.hourly, todayDate);
    if (rainHours.length > 0) {
      output += `⏰ Rain expected: ${formatRainHours(rainHours)}\n`;
    }
  }

  // ========== 12-HOUR HOURLY BREAKDOWN ==========
  if (weather.hourly) {
    output += `\n*━━━ Next 12 Hours ━━━*\n`;
    const now = new Date();
    const currentHour = now.getHours();

    let hoursShown = 0;
    for (let i = 0; i < weather.hourly.time.length && hoursShown < 12; i++) {
      const hourTime = new Date(weather.hourly.time[i]);

      // Only show future hours
      if (hourTime <= now) continue;

      const hour = hourTime.getHours();
      const temp = Math.round(weather.hourly.temperature[i]);
      const weatherCode = weather.hourly.weatherCode[i];
      const wind = Math.round(weather.hourly.windSpeed[i]);
      const precip = weather.hourly.precipitation_probability[i];

      const timeStr = `${hour.toString().padStart(2, '0')}:00`;
      output += `${timeStr}: ${temp}°C ${getWeatherEmoji(weatherCode)}`;

      if (precip > 30) {
        output += ` 💧${precip}%`;
      }

      if (wind > 20) {
        output += ` 💨${wind}km/h`;
      }

      output += `\n`;
      hoursShown++;
    }
  }

  // ========== TOMORROW ==========
  if (weather.tomorrow) {
    output += `\n*━━━ Tomorrow ━━━*\n`;
    output += `📈 High: ${weather.tomorrow.tempMax}°C | 📉 Low: ${weather.tomorrow.tempMin}°C\n`;
    output += `${getWeatherEmoji(weather.tomorrow.weatherCode)} ${getWeatherDescription(weather.tomorrow.weatherCode)}\n`;
    output += `🌅 Sunrise: ${formatTime(weather.tomorrow.sunrise)} | 🌇 Sunset: ${formatTime(weather.tomorrow.sunset)}\n`;
    output += `☀️ Max UV: ${weather.tomorrow.uvIndexMax} (${getUVDescription(weather.tomorrow.uvIndexMax)})\n`;

    if (weather.tomorrow.precipitationProbability > 0) {
      output += `🌧️ Rain probability: ${weather.tomorrow.precipitationProbability}%\n`;
    }

    // Rain hours for tomorrow
    if (weather.tomorrow.precipitationProbability >= 40 && weather.hourly) {
      const tomorrowDate = weather.daily?.[1]?.date || '';
      if (tomorrowDate) {
        const rainHours = extractRainHours(weather.hourly, tomorrowDate);
        if (rainHours.length > 0) {
          output += `⏰ Rain expected: ${formatRainHours(rainHours)}\n`;
        }
      }
    }
  }

  // ========== TEMPERATURE GRAPH ==========
  if (weather.daily && weather.daily.length >= 2) {
    output += `\n*━━━ Weekly Temperature Trend ━━━*\n`;
    output += generateTemperatureGraph(weather.daily);
    output += `\n`;
  }

  // ========== 7-DAY FORECAST ==========
  if (weather.daily && weather.daily.length > 2) {
    output += `*━━━ 7-Day Forecast ━━━*\n`;
    for (let i = 2; i < Math.min(7, weather.daily.length); i++) {
      const day = weather.daily[i];
      const date = new Date(day.date);
      const dayName = date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

      output += `${dayName}: ${day.tempMin}-${day.tempMax}°C ${getWeatherEmoji(day.weatherCode)}`;

      if (day.precipitationProbability > 20) {
        output += ` 💧${day.precipitationProbability}%`;
      }

      if (day.uvIndexMax >= 7) {
        output += ` ☀️${day.uvIndexMax}`;
      }

      output += `\n`;
    }
  }

  return output;
}

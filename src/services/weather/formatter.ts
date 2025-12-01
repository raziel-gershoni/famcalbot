/**
 * Weather Formatter
 * Formats weather data for standard and detailed display
 */

import { WeatherData } from '../../types';
import { getWeatherDescription, getWeatherEmoji } from './open-meteo';
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

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
 * Generate AI summary for detailed weather format
 */
async function generateWeatherSummary(weather: WeatherData): Promise<string> {
  // Use the same model configuration as summary generation
  const { getAIConfig } = await import('../../config/constants');
  const config = getAIConfig();

  const prompt = `Generate a brief, insightful weather summary (1-2 sentences, max 150 chars) based on this data:

Current: ${weather.current.temperature}°C, ${getWeatherDescription(weather.current.weatherCode)}
Today: ${weather.today.tempMin}-${weather.today.tempMax}°C, ${weather.today.precipitationProbability}% rain
Tomorrow: ${weather.tomorrow ? `${weather.tomorrow.tempMin}-${weather.tomorrow.tempMax}°C, ${weather.tomorrow.precipitationProbability}% rain` : 'N/A'}
Week: ${weather.daily?.slice(0, 7).map(d => `${d.tempMin}-${d.tempMax}°C`).join(', ')}

Be concise and highlight the most important weather patterns. Examples:
- "Light rain today clearing by tomorrow. Mid-week warm and dry."
- "Clear skies all week with gradually warming temperatures."
- "Cooler temps today, warming trend through the weekend."

Summary:`;

  try {
    const response = await anthropic.messages.create({
      model: config.MODEL_CONFIG.modelId,
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: prompt
      }]
    });

    const summary = response.content[0].type === 'text'
      ? response.content[0].text.trim()
      : '';

    return summary;
  } catch (error) {
    console.error('Failed to generate weather summary:', error);
    return ''; // Return empty string if AI generation fails
  }
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

  // Next 5 days summary
  if (weather.daily && weather.daily.length > 2) {
    output += `\n*This Week:*\n`;
    for (let i = 2; i < Math.min(7, weather.daily.length); i++) {
      const day = weather.daily[i];
      const date = new Date(day.date);
      const dayName = date.toLocaleDateString('en-US', { weekday: 'short' });

      output += `${dayName}: ${day.tempMin}-${day.tempMax}°C ${getWeatherEmoji(day.weatherCode)}`;
      if (day.precipitationProbability > 30) {
        output += ` ${day.precipitationProbability}%`;
      }
      output += `\n`;
    }
  }

  return output;
}

/**
 * Format weather data in detailed format
 * Comprehensive view with AI-generated summary
 */
export async function formatWeatherDetailed(weather: WeatherData): Promise<string> {
  // Generate AI summary first
  const summary = await generateWeatherSummary(weather);

  let output = `🌤️ *Weather for ${weather.location}*\n\n`;

  // AI-generated summary (if available)
  if (summary) {
    output += `📊 *${summary}*\n\n`;
  }

  // Current conditions (more detailed)
  output += `*Current Conditions:*\n`;
  output += `${getWeatherEmoji(weather.current.weatherCode)} ${getWeatherDescription(weather.current.weatherCode)}\n`;
  output += `🌡️ Temperature: ${weather.current.temperature}°C (feels like ${weather.current.feelsLike}°C)\n`;
  output += `💨 Wind: ${weather.current.windSpeed} km/h\n`;
  output += `💧 Humidity: ${weather.current.humidity}%\n\n`;

  // Today (detailed)
  output += `*Today:*\n`;
  output += `📈 High: ${weather.today.tempMax}°C | 📉 Low: ${weather.today.tempMin}°C\n`;
  output += `${getWeatherEmoji(weather.today.weatherCode)} ${getWeatherDescription(weather.today.weatherCode)}\n`;
  if (weather.today.precipitationProbability > 0) {
    output += `🌧️ Rain probability: ${weather.today.precipitationProbability}%\n`;
  }

  // Rain hours for today
  if (weather.today.precipitationProbability >= 40 && weather.hourly) {
    const todayDate = weather.daily?.[0]?.date || new Date().toISOString().split('T')[0];
    const rainHours = extractRainHours(weather.hourly, todayDate);
    if (rainHours.length > 0) {
      output += `⏰ Expected: ${formatRainHours(rainHours)}\n`;
    }
  }

  // Tomorrow (detailed)
  if (weather.tomorrow) {
    output += `\n*Tomorrow:*\n`;
    output += `📈 High: ${weather.tomorrow.tempMax}°C | 📉 Low: ${weather.tomorrow.tempMin}°C\n`;
    output += `${getWeatherEmoji(weather.tomorrow.weatherCode)} ${getWeatherDescription(weather.tomorrow.weatherCode)}\n`;
    if (weather.tomorrow.precipitationProbability > 0) {
      output += `🌧️ Rain probability: ${weather.tomorrow.precipitationProbability}%\n`;
    }

    // Rain hours for tomorrow
    if (weather.tomorrow.precipitationProbability >= 40 && weather.hourly) {
      const tomorrowDate = weather.daily?.[1]?.date || '';
      if (tomorrowDate) {
        const rainHours = extractRainHours(weather.hourly, tomorrowDate);
        if (rainHours.length > 0) {
          output += `⏰ Expected: ${formatRainHours(rainHours)}\n`;
        }
      }
    }
  }

  // 7-day forecast
  if (weather.daily && weather.daily.length > 2) {
    output += `\n*7-Day Forecast:*\n`;
    for (let i = 2; i < Math.min(7, weather.daily.length); i++) {
      const day = weather.daily[i];
      const date = new Date(day.date);
      const dayName = date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

      output += `${dayName}: ${day.tempMin}-${day.tempMax}°C ${getWeatherEmoji(day.weatherCode)}`;
      if (day.precipitationProbability > 20) {
        output += ` 🌧️${day.precipitationProbability}%`;
      }
      output += `\n`;
    }
  }

  return output;
}

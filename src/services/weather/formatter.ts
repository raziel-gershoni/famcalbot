/**
 * Weather Formatter
 * AI-powered weather forecast formatting with rule-based fallback
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
 * Format time from ISO string to HH:MM
 */
function formatTime(isoString: string): string {
  const date = new Date(isoString);
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  return `${hours}:${minutes}`;
}

/**
 * Build a compact, token-efficient payload for AI weather generation
 */
export function buildWeatherAIPayload(weather: WeatherData): object {
  const todayDate = weather.daily?.[0]?.date || new Date().toISOString().split('T')[0];
  const tomorrowDate = weather.daily?.[1]?.date || '';

  const todayRainHours = weather.hourly
    ? formatRainHours(extractRainHours(weather.hourly, todayDate))
    : '';
  const tomorrowRainHours = weather.hourly && tomorrowDate
    ? formatRainHours(extractRainHours(weather.hourly, tomorrowDate))
    : '';

  const buildDaySummary = (day: NonNullable<WeatherData['daily']>[number], rainHoursStr?: string) => {
    const result: Record<string, unknown> = {
      day: new Date(day.date).toLocaleDateString('en-US', { weekday: 'long' }),
      date: day.date,
      high: day.tempMax,
      low: day.tempMin,
      rainPct: day.precipitationProbability,
      condition: getWeatherDescription(day.weatherCode),
      sunrise: formatTime(day.sunrise),
      sunset: formatTime(day.sunset),
      uvMax: day.uvIndexMax,
    };
    if (rainHoursStr) result.rainHours = rainHoursStr;
    return result;
  };

  const daily = weather.daily || [];

  return {
    location: weather.location,
    current: {
      temp: weather.current.temperature,
      feelsLike: weather.current.feelsLike,
      humidity: weather.current.humidity,
      wind: weather.current.windSpeed,
      uvIndex: weather.current.uvIndex,
      condition: getWeatherDescription(weather.current.weatherCode),
    },
    today: daily[0] ? buildDaySummary(daily[0], todayRainHours) : null,
    tomorrow: daily[1] ? buildDaySummary(daily[1], tomorrowRainHours) : null,
    thisWeek: daily.slice(2, 7).map(d => buildDaySummary(d)),
    extended: daily.slice(7, 16).map(d => buildDaySummary(d)),
  };
}

const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  he: 'Hebrew',
  ru: 'Russian',
};

const SECTION_HEADERS: Record<string, { todayTomorrow: string; thisWeek: string; extended: string }> = {
  en: { todayTomorrow: 'Today & Tomorrow', thisWeek: 'This Week', extended: 'Extended Outlook' },
  he: { todayTomorrow: 'היום ומחר', thisWeek: 'השבוע', extended: 'תחזית מורחבת' },
  ru: { todayTomorrow: 'Сегодня и завтра', thisWeek: 'На этой неделе', extended: 'Расширенный прогноз' },
};

/**
 * Format weather data using AI for a natural, conversational summary
 * Falls back to formatWeatherDetailed on AI failure
 */
export async function formatWeatherAI(weather: WeatherData, language: string): Promise<string> {
  const payload = buildWeatherAIPayload(weather);
  const langName = LANGUAGE_NAMES[language] || 'English';
  const headers = SECTION_HEADERS[language] || SECTION_HEADERS.en;

  const prompt = `You are a friendly weatherperson giving a natural, conversational forecast briefing on someone's phone via Telegram.

**Rules:**
- Respond ENTIRELY in ${langName}
- Use Telegram Markdown: *bold* for the 3 section headers only
- Use weather emojis naturally throughout
- Keep it concise — designed for mobile reading (~2000 characters max)
- Mention UV warnings when UV index ≥ 6
- Mention wind only when > 20 km/h
- Mention rain timing when relevant (use rainHours data if available)
- Write in flowing paragraphs, NOT bullet lists or one-line-per-day format
- Group days with similar weather together (e.g. "Wednesday through Friday stays warm and dry around 22–24°C") rather than listing each day separately
- Transition naturally between sections — no numbered lists

**Use these 3 bold section headers, each followed by natural flowing paragraphs:**

*${headers.todayTomorrow}*
Current conditions, today's and tomorrow's forecast with temperatures, precipitation, notable conditions.

*${headers.thisWeek}*
Days 3-7 in flowing prose. Group similar days, highlight changes and notable conditions.

*${headers.extended}*
2-3 sentences on the general trend for days 8-16. These are rough estimates — use hedging language ("likely", "expected to", "may") and focus on general trends (warming/cooling, wet/dry pattern) rather than specific daily numbers.

**Weather Data:**
${JSON.stringify(payload, null, 2)}`;

  try {
    const { generateAICompletion } = await import('../ai-provider');
    const result = await generateAICompletion(prompt);
    return result.text.trim();
  } catch (error) {
    console.error('Failed to generate AI weather forecast:', error);
    return formatWeatherDetailed(weather);
  }
}

/**
 * Format weather data in detailed format (fallback when AI is unavailable)
 */
async function formatWeatherDetailed(weather: WeatherData): Promise<string> {
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

  // ========== 7-DAY FORECAST ==========
  if (weather.daily && weather.daily.length > 2) {
    output += `\n*━━━ 7-Day Forecast ━━━*\n`;
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

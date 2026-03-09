/**
 * Weather Formatter
 * AI-powered weather forecast formatting with rule-based fallback
 */

import { HDate, Locale } from '@hebcal/core';
import '@hebcal/locales';
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

export interface WeatherFormatResult {
  brief: string;              // ~500-800 chars for text display
  detailed: string;           // ~1500-2000 chars for voice narration
  infographicPrompt?: string; // structured prompt for image generation
}

/**
 * Format weather data using AI for a natural, conversational summary
 * Returns brief (text) and detailed (voice) versions
 * Falls back to formatWeatherDetailed on AI failure
 */
export async function formatWeatherAI(
  weather: WeatherData,
  language: string,
  userName: string,
  timezone: string,
  culture?: string,
  isAdmin?: boolean,
  generateInfographic?: boolean,
): Promise<WeatherFormatResult> {
  const payload = buildWeatherAIPayload(weather);
  const langName = LANGUAGE_NAMES[language] || 'English';
  const headers = SECTION_HEADERS[language] || SECTION_HEADERS.en;

  const now = new Date();
  const dateStr = now.toLocaleDateString(
    language === 'he' ? 'he-IL' : language === 'ru' ? 'ru-RU' : 'en-US',
    {
      timeZone: timezone,
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    },
  );

  // Hebrew date for Jewish culture users
  let hebrewDateStr = '';
  if (culture === 'jewish') {
    const localDate = new Date(now.toLocaleString('en-US', { timeZone: timezone }));
    const hdate = new HDate(localDate);
    const day = hdate.getDate();
    const monthName = Locale.lookupTranslation(hdate.getMonthName(), 'he') || hdate.getMonthName();
    const year = hdate.getFullYear();
    hebrewDateStr = ` | ${day} ב${monthName} ${year}`;
  }

  // Compute local time for time-aware today section
  const localTimeStr = now.toLocaleTimeString(
    language === 'he' ? 'he-IL' : language === 'ru' ? 'ru-RU' : 'en-US',
    { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false }
  );

  // Build forecast data for infographic — today + tomorrow + next 10 days (up to 12 rows)
  const forecastDays = (weather.daily || []).slice(0, 12).map((d, i) => {
    const date = new Date(d.date);
    const dayName = date.toLocaleDateString(
      language === 'he' ? 'he-IL' : language === 'ru' ? 'ru-RU' : 'en-US',
      { weekday: 'short' }
    );
    const label = i === 0 ? (language === 'he' ? 'היום' : language === 'ru' ? 'Сегодня' : 'Today')
                : i === 1 ? (language === 'he' ? 'מחר' : language === 'ru' ? 'Завтра' : 'Tomorrow')
                : dayName;
    return `${label}: ${d.tempMin}–${d.tempMax}°C [${getWeatherDescription(d.weatherCode)}]${d.precipitationProbability > 20 ? ` ${d.precipitationProbability}%` : ''}`;
  }).join('\n');

  const infographicSection = generateInfographic ? `
THEN: The exact line: ===INFOGRAPHIC===
THEN: A detailed image generation prompt (in English) for creating a weather infographic image. This prompt will be sent to an AI image generator. Include:
- A clean, modern VERTICAL (9:16 portrait) mobile-friendly weather infographic, 1080x1920 pixels resolution
- Gradient background matching current weather (warm oranges/yellows for sunny, cool blues for rainy, grays for overcast)
- Header: location "${weather.location}", date "${dateStr}"${hebrewDateStr ? `, Hebrew date "${hebrewDateStr.replace(' | ', '')}"` : ''}, currently ${weather.current.temperature}°C
- THE MAIN FOCUS is a vertical multi-day forecast chart taking most of the image, styled like the iOS Weather app:
  - Days stacked vertically (top = today, bottom = furthest day)
  - Each row has EXACTLY these elements, each appearing ONCE and only once: ${language === 'he' ? 'low°–high° | ●───● | weather icon | day name (RTL order — day name on the right)' : 'day name | weather icon | ●───● | low°–high°'}
  - Rain % (if > 20%) appears ONLY next to the weather icon, nowhere else in the row
  - The ●───● is a dumbbell chart: blue dot at low end, orange dot at high end, gradient line between. The dots represent temperature visually by position only — do NOT write any numbers on or near the dots/line
  - Align the dumbbell bars horizontally across all rows on a shared temperature axis
  - Temperature numbers appear ONLY ONCE per row, as "low°–high°" text at the end of the row. Do NOT label the dots with numbers
  - The [condition] in brackets is the weather condition — render it as a SINGLE small icon per row. Do NOT show the condition as text
  - CRITICAL: Do NOT duplicate any element. Each row must have exactly ONE icon, ONE rain %, ONE low temp, ONE high temp. Nothing appears twice
- Forecast data:
${forecastDays}
- All text and numbers must be EXACTLY as specified above — do not approximate
- ${language === 'he' ? 'Use Hebrew labels for days and sections. IMPORTANT: The entire layout must be RTL (right-to-left) — text aligned right, day rows read right-to-left' : language === 'ru' ? 'Use Russian labels for days and sections' : 'Use English labels'}
- Style: flat design, no watermarks, no 3D effects, high contrast text, suitable for mobile viewing
- IMPORTANT: This is a data visualization — accuracy of all numbers is critical` : '';

  const prompt = `You are a friendly weatherperson giving a natural, conversational forecast briefing on someone's phone via Telegram.

**Output ${generateInfographic ? 'three' : 'two'} versions separated by exact delimiters on their own lines.**

FIRST: A BRIEF version (~500-800 characters) — a compact mobile-friendly summary.
THEN: The exact line: ===FULL===
THEN: A FULL version (~1500-2000 characters) — detailed prose for voice narration.${infographicSection}

**Rules (apply to BOTH text versions):**
- Respond ENTIRELY in ${langName}
- Start with a short, warm greeting using the person's name: ${userName}
- Include the current date (${dateStr}${hebrewDateStr}) right after the greeting
${culture === 'jewish' ? (language === 'he' ? '- השתמש בגימטריה לתאריך העברי (כ"ח כסלו תשפ"ה)' : language === 'ru' ? '- Отображайте еврейскую дату стандартными цифрами (например: "28 Кислев 5785")' : '- Display Hebrew date using standard numerals (e.g., "28 Kislev 5785")') : ''}
- The current local time is ${localTimeStr}. For today's section, focus on current conditions and what's ahead — don't describe weather from earlier in the day. Weave the current state naturally (e.g. "still sunny", "already cooling down to 15°C").
- Use Telegram HTML: <b>bold</b> for the 3 section headers only
- Use weather emojis naturally throughout
- Mention UV warnings when UV index ≥ 6
- Mention wind only when > 20 km/h
- Mention rain timing when relevant (use rainHours data if available)
- Write in flowing paragraphs, NOT bullet lists or one-line-per-day format
- Group days with similar weather together (e.g. "Wednesday through Friday stays warm and dry around 22–24°C") rather than listing each day separately
- Transition naturally between sections — no numbered lists

**BRIEF version rules:**
- Same 3 bold section headers, but only 1-2 sentences per section
- Focus on highlights: current temp, today's high/low, rain yes/no, week trend
- No extended outlook — skip the third section entirely

**FULL version rules:**
- All 3 sections with full flowing paragraphs

**Use these 3 bold section headers, each followed by natural flowing paragraphs:**

<b>${headers.todayTomorrow}</b>
Current conditions, today's and tomorrow's forecast with temperatures, precipitation, notable conditions.

<b>${headers.thisWeek}</b>
Days 3-7 in flowing prose. Group similar days, highlight changes and notable conditions.

<b>${headers.extended}</b>
2-3 sentences on the general trend for days 8-16. These are rough estimates — use hedging language ("likely", "expected to", "may") and focus on general trends (warming/cooling, wet/dry pattern) rather than specific daily numbers.

**Weather Data:**
${JSON.stringify(payload, null, 2)}`;

  try {
    const { generateAICompletion } = await import('../ai-provider');
    const { formatAdminFooter } = await import('../../utils/ai-footer');
    const result = await generateAICompletion(prompt);
    const text = result.text.trim();

    const modelFooter = formatAdminFooter(result, isAdmin ?? false);

    const fullDelimiter = '===FULL===';
    const infographicDelimiter = '===INFOGRAPHIC===';

    const fullIndex = text.indexOf(fullDelimiter);
    if (fullIndex !== -1) {
      const afterFull = text.substring(fullIndex + fullDelimiter.length);
      const infographicIndex = afterFull.indexOf(infographicDelimiter);

      let detailed: string;
      let infographicPrompt: string | undefined;

      if (infographicIndex !== -1) {
        detailed = afterFull.substring(0, infographicIndex).trim();
        infographicPrompt = afterFull.substring(infographicIndex + infographicDelimiter.length).trim();
      } else {
        detailed = afterFull.trim();
      }

      return {
        brief: text.substring(0, fullIndex).trim() + modelFooter,
        detailed,
        infographicPrompt,
      };
    }
    // If no delimiter found, use full text for both
    return { brief: text + modelFooter, detailed: text };
  } catch (error) {
    console.error('Failed to generate AI weather forecast:', error);
    const fallback = await formatWeatherDetailed(weather);
    return { brief: fallback, detailed: fallback };
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

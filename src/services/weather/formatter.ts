/**
 * Weather Formatter
 * AI-powered weather forecast formatting with rule-based fallback
 */

import { HDate, Locale } from '@hebcal/core';
import { gematriya } from '@hebcal/hdate';
import '@hebcal/locales';
import { WeatherData } from '../../types';
import { getWeatherDescription, getWeatherEmoji, getWindDirectionLabel } from './open-meteo';
import { detectSharav, SharavDay } from './sharav';

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
      windMax: day.windSpeedMax,
      windDir: getWindDirectionLabel(day.windDirection),
    };
    if (rainHoursStr) result.rainHours = rainHoursStr;
    return result;
  };

  const daily = weather.daily || [];
  const sharavDays = detectSharav(weather);

  const payload: Record<string, unknown> = {
    location: weather.location,
    current: {
      temp: weather.current.temperature,
      feelsLike: weather.current.feelsLike,
      humidity: weather.current.humidity,
      wind: weather.current.windSpeed,
      windDir: getWindDirectionLabel(weather.current.windDirection),
      uvIndex: weather.current.uvIndex,
      condition: getWeatherDescription(weather.current.weatherCode),
    },
    today: daily[0] ? buildDaySummary(daily[0], todayRainHours) : null,
    tomorrow: daily[1] ? buildDaySummary(daily[1], tomorrowRainHours) : null,
    thisWeek: daily.slice(2, 7).map(d => buildDaySummary(d)),
    extended: daily.slice(7, 16).map(d => buildDaySummary(d)),
  };

  if (sharavDays.length > 0) {
    payload.sharav = sharavDays.map(s => ({
      date: s.date,
      severity: s.severity,
      tempMax: s.tempMax,
      avgHumidity: s.avgHumidity,
      windDir: s.windDirectionLabel,
    }));
  }

  return payload;
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

  // Build infographic prompt directly in code (not via text AI) to avoid duplication/typo issues
  let directInfographicPrompt: string | undefined;
  if (generateInfographic) {
    const isRTL = language === 'he';
    const rows = (weather.daily || []).slice(0, 12).map((d, i) => {
      const date = new Date(d.date);
      const dayName = date.toLocaleDateString(
        language === 'he' ? 'he-IL' : language === 'ru' ? 'ru-RU' : 'en-US',
        { weekday: 'short' }
      );
      const label = i === 0 ? (language === 'he' ? 'היום' : language === 'ru' ? 'Сегодня' : 'Today')
                  : i === 1 ? (language === 'he' ? 'מחר' : language === 'ru' ? 'Завтра' : 'Tomorrow')
                  : dayName;
      const condition = getWeatherDescription(d.weatherCode);
      const rain = d.precipitationProbability > 20 ? ` ${d.precipitationProbability}%` : '';
      const windUnit = language === 'he' ? 'קמ״ש' : language === 'ru' ? 'км/ч' : 'km/h';
      const wind = d.windSpeedMax > 25 ? ` 💨${getWindDirectionLabel(d.windDirection, language)} ${d.windSpeedMax}${windUnit}` : '';
      if (isRTL) {
        return `${d.tempMin}°–${d.tempMax}°  ●───●${wind}  ${condition}${rain}  ${label}`;
      }
      return `${label}  ${condition}${rain}${wind}  ●───●  ${d.tempMin}°–${d.tempMax}°`;
    }).join('\n');

    let hebrewDateForInfographic = '';
    if (culture === 'jewish') {
      const localDate = new Date(now.toLocaleString('en-US', { timeZone: timezone }));
      const hdate = new HDate(localDate);
      if (language === 'he') {
        // Gematria for Hebrew: כ״א באדר תשפ״ו
        hebrewDateForInfographic = `${gematriya(hdate.getDate())} ב${Locale.lookupTranslation(hdate.getMonthName(), 'he') || hdate.getMonthName()} ${gematriya(hdate.getFullYear())}`;
      } else {
        // Numbers + English month name for other languages: 21 Adar 5786
        hebrewDateForInfographic = `${hdate.getDate()} ${hdate.getMonthName()} ${hdate.getFullYear()}`;
      }
    }
    const headerDate = hebrewDateForInfographic
      ? `${dateStr}\n${hebrewDateForInfographic}`
      : dateStr;

    directInfographicPrompt = `Generate a clean, modern weather infographic image.

LAYOUT: Vertical 9:16 portrait, 1080×1920px, dark gradient background matching weather conditions.

HEADER (compact, top):
${weather.location}${language !== 'en' ? ` (translate the location name to ${langName})` : ''}
${headerDate}

FORECAST CHART (main content, fills most of the image):
${isRTL ? 'RTL layout — day names on the RIGHT side, temperatures on the LEFT side.' : 'LTR layout — day names on the LEFT side, temperatures on the RIGHT side.'}
Each row shows: day name, a small weather condition icon${isRTL ? '' : ','} a horizontal colored bar (blue dot ● on low end, orange dot ● on high end, gradient line connecting them), and temperature range.
Temperature numbers appear ONCE per row as text — do NOT write numbers on the dots.
Rain percentage shown small next to the condition icon only — nowhere else.
When a 💨 wind label appears in a row, render it as small inline text on the SAME line as the condition icon — never on a separate line below the bar.
The bars must be aligned on a shared horizontal temperature axis across all rows so the ranges are visually comparable.

ROWS:
${rows}
${(() => {
      const sharavDays = detectSharav(weather);
      if (sharavDays.length === 0) return '';
      const sharavLines = sharavDays.map(s => `${s.date}: ${s.severity} (${s.tempMax}°C, humidity ${s.avgHumidity}%, wind ${s.windDirectionLabel})`).join(', ');
      return `
WARNINGS:
Sharav/heatwave detected: ${sharavLines}
Render an orange/red warning strip at the bottom of the image with a heat/wind warning icon and the sharav dates.`;
    })()}

STYLE:
- Flat design, no watermarks, no 3D, high contrast white text on dark background
- Weather condition rendered as a small icon only, not as text
- Every data element appears exactly ONCE per row — no duplication of icons, percentages, or temperatures`;
  }

  const prompt = `You are a friendly weatherperson giving a natural, conversational forecast briefing on someone's phone via Telegram.

**Output two versions separated by the exact delimiter ===FULL=== on its own line.**

FIRST: A BRIEF version (~500-800 characters) — a compact mobile-friendly summary.
THEN: The exact line: ===FULL===
THEN: A FULL version (~1500-2000 characters) — detailed prose for voice narration.

**Rules (apply to BOTH text versions):**
- Respond ENTIRELY in ${langName}
- Start with a short, warm greeting using the person's name: ${userName}
- Include the current date (${dateStr}${hebrewDateStr}) right after the greeting
${culture === 'jewish' ? (language === 'he' ? '- השתמש בגימטריה לתאריך העברי (כ"ח כסלו תשפ"ה)' : language === 'ru' ? '- Отображайте еврейскую дату стандартными цифрами (например: "28 Кислев 5785")' : '- Display Hebrew date using standard numerals (e.g., "28 Kislev 5785")') : ''}
- The current local time is ${localTimeStr}. For today's section, focus on current conditions and what's ahead — don't describe weather from earlier in the day. Weave the current state naturally (e.g. "still sunny", "already cooling down to 15°C").
- Use Telegram HTML: <b>bold</b> for the 3 section headers only
- Use weather emojis naturally throughout
- Mention UV warnings when UV index ≥ 6
- Mention wind (direction + speed) only when > 20 km/h
- Mention rain timing when relevant (use rainHours data if available)
- When sharav data is present in the weather data, warn about it prominently with severity and practical advice (stay hydrated, avoid outdoor exertion, keep windows closed). Use "שרב" in Hebrew, "хамсин" in Russian, "sharav/heatwave" in English.
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

    const delimiter = '===FULL===';
    const delimiterIndex = text.indexOf(delimiter);
    if (delimiterIndex !== -1) {
      return {
        brief: text.substring(0, delimiterIndex).trim() + modelFooter,
        detailed: text.substring(delimiterIndex + delimiter.length).trim(),
        infographicPrompt: directInfographicPrompt,
      };
    }
    // If no delimiter found, use full text for both
    return { brief: text + modelFooter, detailed: text, infographicPrompt: directInfographicPrompt };
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

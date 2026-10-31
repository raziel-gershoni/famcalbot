/**
 * Weather Formatter
 * AI-powered weather forecast formatting with rule-based fallback
 */

import { HDate, Locale } from '@hebcal/core';
import { instantToWallTime } from '../../utils/wall-time';
import { gematriya } from '@hebcal/hdate';
import { formatInTimeZone } from 'date-fns-tz';
import '@hebcal/locales';
import type { AirQualityData, WeatherData, WeatherDay } from '../../types';
import { detectDustStorm } from './dust-storm';
import { describeWeather, getWeatherDescription, getWeatherEmoji, getWindDirectionLabel } from './forecast';
import { formatRainMm, rainHoursForModel, rainHoursForPerson } from './rain';
import { detectSharav } from './sharav';
import { timeOfDayGreeting } from '../../utils/greeting';
import { escapeHtml } from '../../utils/html';
import { getBotMessages, type BotMessages } from '../../lib/bot-messages';
import type { InfographicConfig } from './infographic';

/**
 * Get UV index description, in the language of the fallback messages
 */
function getUVDescription(uvIndex: number, f: BotMessages['weatherFallback']): string {
  if (uvIndex < 3) return f.uvLow;
  if (uvIndex < 6) return f.uvModerate;
  if (uvIndex < 8) return f.uvHigh;
  if (uvIndex < 11) return f.uvVeryHigh;
  return f.uvExtreme;
}

/**
 * HH:MM of a forecast time, a wall time at the place ('yyyy-MM-ddTHH:mm'): read from the text, never through a Date
 * parsed in the server's zone. A dash where there is none (no sunrise or sunset that day, in the far north).
 */
function formatTime(isoString: string): string {
  return isoString === '' ? '—' : isoString.slice(11, 16);
}

/**
 * Build a compact, token-efficient payload for AI weather generation
 */
export function buildWeatherAIPayload(weather: WeatherData, airQuality?: AirQualityData | null): object {
  const buildDaySummary = (day: WeatherDay, withHours: boolean) => {
    const result: Record<string, unknown> = {
      day: new Date(day.date).toLocaleDateString('en-US', { weekday: 'long' }),
      date: day.date,
      high: day.tempMax,
      low: day.tempMin,
      rainMm: day.precipitation,
      condition: getWeatherDescription(day.weatherCode),
      sunrise: formatTime(day.sunrise),
      sunset: formatTime(day.sunset),
      windMax: day.windSpeedMax,
      windDir: getWindDirectionLabel(day.windDirection),
    };
    if (day.uvIndexMax !== null) result.uvMax = day.uvIndexMax;
    if (withHours && day.rainHours.length > 0) result.rainHours = rainHoursForModel(day.rainHours);
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
    today: daily[0] ? buildDaySummary(daily[0], true) : null,
    tomorrow: daily[1] ? buildDaySummary(daily[1], true) : null,
    thisWeek: daily.slice(2, 7).map(d => buildDaySummary(d, false)),
    extended: daily.slice(7).map(d => buildDaySummary(d, false)),
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

  const dustDays = detectDustStorm(airQuality ?? null);
  if (dustDays.length > 0) {
    payload.dustStorm = dustDays.map(d => ({
      date: d.date,
      severity: d.severity,
      peakPM10: d.peakPM10,
      peakDust: d.peakDust,
    }));
  }

  return payload;
}

const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  he: 'Hebrew',
  ru: 'Russian',
};

/** The one name per language the model may use for each hazard; naming all three made it echo them all. */
const HAZARD_TERMS: Record<string, { sharav: string; dustStorm: string }> = {
  en: { sharav: 'sharav', dustStorm: 'dust storm' },
  he: { sharav: 'שרב', dustStorm: 'סופת אבק' },
  ru: { sharav: 'шарав', dustStorm: 'пылевая буря' },
};

const SECTION_HEADERS: Record<string, { todayTomorrow: string; thisWeek: string; extended: string }> = {
  en: { todayTomorrow: 'Today & Tomorrow', thisWeek: 'This Week', extended: 'Extended Outlook' },
  he: { todayTomorrow: 'היום ומחר', thisWeek: 'השבוע', extended: 'תחזית מורחבת' },
  ru: { todayTomorrow: 'Сегодня и завтра', thisWeek: 'На этой неделе', extended: 'Расширенный прогноз' },
};

export interface WeatherFormatResult {
  brief: string;              // ~500-800 chars for text display
  detailed: string;           // ~1500-2000 chars for voice narration
  infographicConfig?: InfographicConfig; // config for satori rendering
}

/** The long local date both the forecast and its infographic open with. */
function weatherDateLine(now: Date, language: string, timezone: string): string {
  return now.toLocaleDateString(
    language === 'he' ? 'he-IL' : language === 'ru' ? 'ru-RU' : 'en-US',
    {
      timeZone: timezone,
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    },
  );
}

/**
 * The weather infographic's input. It comes from the weather data alone, so the story
 * image route builds it here instead of paying for a forecast it would throw away.
 */
export function buildInfographicConfig(
  weather: WeatherData,
  language: string,
  timezone: string,
  culture?: string,
  airQuality?: AirQualityData | null,
  now: Date = new Date(),
): InfographicConfig {
  let hebrewDateStr: string | undefined;
  if (culture === 'jewish') {
    const localDate = new Date(now.toLocaleString('en-US', { timeZone: timezone }));
    const hdate = new HDate(localDate);
    if (language === 'he') {
      hebrewDateStr = `${gematriya(hdate.getDate())} ב${Locale.lookupTranslation(hdate.getMonthName(), 'he') || hdate.getMonthName()} ${gematriya(hdate.getFullYear())}`;
    } else {
      hebrewDateStr = `${hdate.getDate()} ${hdate.getMonthName()} ${hdate.getFullYear()}`;
    }
  }
  return { weather, airQuality: airQuality ?? null, language, dateStr: weatherDateLine(now, language, timezone), hebrewDateStr, timezone };
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
  airQuality?: AirQualityData | null,
  now: Date = new Date(),
): Promise<WeatherFormatResult> {
  const payload = buildWeatherAIPayload(weather, airQuality);
  const langName = LANGUAGE_NAMES[language] || 'English';
  const headers = SECTION_HEADERS[language] || SECTION_HEADERS.en;

  const dateStr = weatherDateLine(now, language, timezone);

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

  const greeting = timeOfDayGreeting(Number(formatInTimeZone(now, timezone, 'H')), language);
  const terms = HAZARD_TERMS[language] || HAZARD_TERMS.en;
  const sharavRule = `Call it "${terms.sharav}"${language === 'en' ? ' (say once that it is a desert heatwave)' : ''}, and never add another language's word for it.`;

  const infographicConfig = generateInfographic
    ? buildInfographicConfig(weather, language, timezone, culture, airQuality, now)
    : undefined;

  const prompt = `You are a friendly weatherperson giving a natural, conversational forecast briefing on someone's phone via Telegram.

**Rules:**
- Respond ENTIRELY in ${langName}
- Open with "${greeting}" and the person's name (${userName}), short and warm
- Include the current date (${dateStr}${hebrewDateStr}) right after the greeting
${culture === 'jewish' ? (language === 'he' ? '- השתמש בגימטריה לתאריך העברי (כ"ח כסלו תשפ"ה)' : language === 'ru' ? '- Отображайте еврейскую дату стандартными цифрами (например: "28 Кислев 5785")' : '- Display Hebrew date using standard numerals (e.g., "28 Kislev 5785")') : ''}
- The current local time is ${localTimeStr}. For today's section, focus on current conditions and what's ahead — don't describe weather from earlier in the day. Weave the current state naturally (e.g. "still sunny", "already cooling down to 15°C").
- Use Telegram HTML: <b>bold</b> for the 3 section headers only
- Use weather emojis naturally throughout
- Mention UV warnings when UV index ≥ 6
- Mention wind (direction + speed) only when > 20 km/h
- Mention rain timing and amount when relevant (rainHours and rainMm, in millimetres). The data has no chance of rain, so never give one as a percentage
- When sharav data is present in the weather data, warn about it prominently with severity and practical advice (stay hydrated, avoid outdoor exertion, keep windows closed). ${sharavRule}
- When dustStorm data is present, warn about it prominently with health advice (close windows, avoid outdoor activity, use air purifier if available, N95 mask outdoors). Call it "${terms.dustStorm}", and never add another language's word for it. It can occur in cool, humid weather — it is NOT the same as ${terms.sharav}.
- Write in flowing paragraphs, NOT bullet lists or one-line-per-day format
- Group days with similar weather together (e.g. "Wednesday through Friday stays warm and dry around 22–24°C") rather than listing each day separately
- Transition naturally between sections — no numbered lists
- Output ~1500-2000 characters — detailed prose suitable for voice narration

**Use these 3 bold section headers, each followed by natural flowing paragraphs:**

<b>${headers.todayTomorrow}</b>
Current conditions, today's and tomorrow's forecast with temperatures, precipitation, notable conditions.

<b>${headers.thisWeek}</b>
Days 3-7 in flowing prose. Group similar days, highlight changes and notable conditions.

<b>${headers.extended}</b>
2-3 sentences on the general trend for days 8 and 9. These are rough estimates — use hedging language ("likely", "expected to", "may") and focus on general trends (warming/cooling, wet/dry pattern) rather than specific daily numbers.

**Weather Data:**
${JSON.stringify(payload, null, 2)}`;

  try {
    const { generateAICompletion } = await import('../ai-provider');
    const { formatAdminFooter } = await import('../../utils/ai-footer');
    const result = await generateAICompletion(prompt);
    const text = result.text.trim();

    const modelFooter = formatAdminFooter(result, isAdmin ?? false);

    return { brief: text + modelFooter, detailed: text, infographicConfig };
  } catch (error) {
    console.error('Failed to generate AI weather forecast:', error);
    const fallback = await formatWeatherDetailed(weather, language, timezone, now);
    return { brief: fallback, detailed: fallback };
  }
}

/**
 * Format weather data in detailed format (fallback when AI is unavailable), in the person's language.
 * It is sent as Telegram HTML (and read out as the voice text), so bold is <b> and the place name is escaped.
 */
async function formatWeatherDetailed(weather: WeatherData, language: string, timezone: string, now: Date): Promise<string> {
  const t = await getBotMessages(language);
  const w = t.weatherOnly;
  const f = t.weatherFallback;
  const locale = language === 'he' ? 'he-IL' : language === 'ru' ? 'ru-RU' : 'en-US';
  const section = (title: string) => `<b>━━━ ${title} ━━━</b>\n`;

  let output = `🌤️ <b>${escapeHtml(f.title.replace('{location}', weather.location))}</b>\n\n`;

  // ========== CURRENT CONDITIONS ==========
  output += section(w.current);
  output += `${getWeatherEmoji(weather.current.weatherCode)} ${describeWeather(weather.current.weatherCode, t)}\n`;
  output += `🌡️ ${f.temperature}: ${weather.current.temperature}°C (${w.feelsLike} ${weather.current.feelsLike}°C)\n`;
  output += `💨 ${f.wind}: ${weather.current.windSpeed} ${w.windSpeed}`;

  // Wind comfort
  if (weather.current.windSpeed > 25) {
    output += ` (${f.windStrong})`;
  } else if (weather.current.windSpeed > 15) {
    output += ` (${f.windBreezy})`;
  }
  output += `\n`;

  output += `💧 ${f.humidity}: ${weather.current.humidity}%\n`;
  output += `☀️ ${f.uvIndex}: ${weather.current.uvIndex} (${getUVDescription(weather.current.uvIndex, f)})\n\n`;

  // ========== TODAY ==========
  output += section(w.today);
  output += `📈 ${w.high}: ${weather.today.tempMax}°C | 📉 ${w.low}: ${weather.today.tempMin}°C\n`;
  output += `${getWeatherEmoji(weather.today.weatherCode)} ${describeWeather(weather.today.weatherCode, t)}\n`;
  output += `🌅 ${f.sunrise}: ${formatTime(weather.today.sunrise)} | 🌇 ${f.sunset}: ${formatTime(weather.today.sunset)}\n`;
  output += `☀️ ${f.maxUv}: ${weather.today.uvIndexMax} (${getUVDescription(weather.today.uvIndexMax, f)})`;

  if (weather.today.uvIndexMax >= 6) {
    output += ` - ${f.sunscreen}`;
  }
  output += `\n`;

  if (weather.today.precipitation > 0) {
    output += `🌧️ ${f.rain}: ${formatRainMm(weather.today.precipitation, language)} ${w.mm}\n`;
  }
  if (weather.today.rainHours.length > 0) {
    output += `⏰ ${f.rainExpected}: ${rainHoursForPerson(weather.today.rainHours)}\n`;
  }

  // ========== 12-HOUR HOURLY BREAKDOWN ==========
  if (weather.hourly) {
    output += `\n${section(f.next12Hours)}`;
    // The forecast's times are wall times at the place ('yyyy-MM-ddTHH:mm', in the person's zone), so they compare with
    // the place's own clock, never with a Date parsed in the server's zone
    const nowAtPlace = instantToWallTime(now, timezone).slice(0, 16);

    let hoursShown = 0;
    for (let i = 0; i < weather.hourly.time.length && hoursShown < 12; i++) {
      const wallTime = weather.hourly.time[i];

      // Only show future hours
      if (wallTime <= nowAtPlace) continue;

      const hour = Number(wallTime.slice(11, 13));
      const temp = Math.round(weather.hourly.temperature[i]);
      const weatherCode = weather.hourly.weatherCode[i];
      const wind = Math.round(weather.hourly.windSpeed[i]);
      const precip = weather.hourly.precipitation[i];

      const timeStr = `${hour.toString().padStart(2, '0')}:00`;
      output += `${timeStr}: ${temp}°C ${getWeatherEmoji(weatherCode)}`;

      if (precip > 0) {
        output += ` 💧${formatRainMm(precip, language)} ${w.mm}`;
      }

      if (wind > 20) {
        output += ` 💨${wind} ${w.windSpeed}`;
      }

      output += `\n`;
      hoursShown++;
    }
  }

  // ========== TOMORROW ==========
  if (weather.tomorrow) {
    output += `\n${section(w.tomorrow)}`;
    output += `📈 ${w.high}: ${weather.tomorrow.tempMax}°C | 📉 ${w.low}: ${weather.tomorrow.tempMin}°C\n`;
    output += `${getWeatherEmoji(weather.tomorrow.weatherCode)} ${describeWeather(weather.tomorrow.weatherCode, t)}\n`;
    output += `🌅 ${f.sunrise}: ${formatTime(weather.tomorrow.sunrise)} | 🌇 ${f.sunset}: ${formatTime(weather.tomorrow.sunset)}\n`;
    output += `☀️ ${f.maxUv}: ${weather.tomorrow.uvIndexMax} (${getUVDescription(weather.tomorrow.uvIndexMax, f)})\n`;

    if (weather.tomorrow.precipitation > 0) {
      output += `🌧️ ${f.rain}: ${formatRainMm(weather.tomorrow.precipitation, language)} ${w.mm}\n`;
    }
    if (weather.tomorrow.rainHours.length > 0) {
      output += `⏰ ${f.rainExpected}: ${rainHoursForPerson(weather.tomorrow.rainHours)}\n`;
    }
  }

  // ========== 7-DAY FORECAST ==========
  if (weather.daily && weather.daily.length > 2) {
    output += `\n${section(f.forecast7Days)}`;
    for (let i = 2; i < Math.min(7, weather.daily.length); i++) {
      const day = weather.daily[i];
      // The day is a plain date: read it as the UTC day it names, not as the server's local day
      const dayName = new Date(day.date).toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

      output += `${dayName}: ${day.tempMin}-${day.tempMax}°C ${getWeatherEmoji(day.weatherCode)}`;

      if (day.precipitation > 0) {
        output += ` 💧${formatRainMm(day.precipitation, language)} ${w.mm}`;
      }

      if (day.uvIndexMax !== null && day.uvIndexMax >= 7) {
        output += ` ☀️${day.uvIndexMax}`;
      }

      output += `\n`;
    }
  }

  return output;
}

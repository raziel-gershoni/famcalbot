import { HDate, Locale } from '@hebcal/core';
import '@hebcal/locales';
import { CalendarEvent, CalendarAssignment } from '../types';
import { TIMEZONE } from '../config/constants';
import { buildCalendarSummaryPrompt, SummaryPromptData } from '../prompts/calendar-summary';
import { formatEventList } from '../utils/event-formatter';
import { generateAICompletion } from './ai-provider';

/**
 * Localized greetings by language and time of day
 */
const GREETINGS: Record<string, { morning: string; afternoon: string; evening: string }> = {
  he: { morning: 'בוקר טוב!', afternoon: 'צהריים טובים!', evening: 'ערב טוב!' },
  en: { morning: 'Good morning!', afternoon: 'Good afternoon!', evening: 'Good evening!' },
  ru: { morning: 'Доброе утро!', afternoon: 'Добрый день!', evening: 'Добрый вечер!' },
};

/**
 * Get localized greeting based on time of day and language
 */
function getLocalizedGreeting(hour: number, language: string = 'en'): string {
  const greetings = GREETINGS[language] || GREETINGS.en;
  if (hour < 12) return greetings.morning;
  if (hour < 18) return greetings.afternoon;
  return greetings.evening;
}

/**
 * User context for summary generation
 */
export interface SummaryUserContext {
  culture?: string;
  globalRules?: string[];
  calendarAssignments?: CalendarAssignment[];
}

/**
 * Get Hebrew date information and check if today is Rosh Chodesh
 */
function getHebrewDateInfo(date: Date = new Date(), timezone: string = TIMEZONE): { hebrewDate: string; isRoshChodesh: boolean; hebrewDateFormatted: string } {
  // Convert to user's timezone to get correct Hebrew date (server runs in UTC)
  const localDate = new Date(date.toLocaleString('en-US', { timeZone: timezone }));
  const hdate = new HDate(localDate);

  const day = hdate.getDate();
  const monthName = Locale.lookupTranslation(hdate.getMonthName(), 'he') || hdate.getMonthName();
  const year = hdate.getFullYear();

  // Check if it's Rosh Chodesh
  // Rosh Chodesh is on day 1 of any month, or day 30 of a 30-day month
  const isRoshChodesh = day === 1 || day === 30;

  const hebrewDate = `${day} ${monthName} ${year}`;
  const hebrewDateFormatted = `${day} ב${monthName} ${year}`;

  return { hebrewDate, isRoshChodesh, hebrewDateFormatted };
}

/**
 * Build prompt data from events and user information
 */
function buildPromptData(
  userEvents: CalendarEvent[],
  spouseEvents: CalendarEvent[],
  otherEvents: CalendarEvent[],
  userName: string,
  userEnglishName: string,
  userGender: 'male' | 'female',
  spouseName: string | undefined,
  spouseEnglishName: string | undefined,
  spouseGender: 'male' | 'female' | undefined,
  date: Date,
  timezone: string = TIMEZONE,
  weatherSummary?: string,
  language?: string,
  userContext?: SummaryUserContext
): SummaryPromptData {
  // Get current date (today) for comparison
  const currentDate = new Date();
  const currentGregorianDate = currentDate.toLocaleDateString('en-US', {
    timeZone: timezone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  // Determine greeting based on current time and user's language
  const currentHour = parseInt(currentDate.toLocaleTimeString('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    hour12: false
  }));
  const greeting = getLocalizedGreeting(currentHour, language);

  // Get summary date and Hebrew date information
  const { isRoshChodesh, hebrewDateFormatted } = getHebrewDateInfo(date, timezone);
  const gregorianDate = date.toLocaleDateString('en-US', {
    timeZone: timezone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  // Format event lists
  const userEventsText = formatEventList(userEvents);
  const spouseEventsText = formatEventList(spouseEvents);
  const otherEventsText = formatEventList(otherEvents);

  // Extract calendar rules from assignments
  const calendarRules = userContext?.calendarAssignments
    ?.filter(a => a.rules && a.rules.length > 0)
    .map(a => ({ calendarName: a.name, rule: a.rules![0] })) || [];

  // Check if user has kids calendars
  const hasKidsCalendars = userContext?.calendarAssignments?.some(a => a.labels.includes('kids')) ?? false;

  return {
    userName,
    userEnglishName,
    userGender,
    hasSpouseCalendar: spouseEvents.length > 0,
    spouseName,
    spouseEnglishName,
    spouseGender,
    currentGregorianDate,
    summaryGregorianDate: gregorianDate,
    summaryHebrewDate: hebrewDateFormatted,
    isRoshChodesh,
    greeting,
    userEventsText,
    spouseEventsText,
    otherEventsText,
    weatherSummary,
    language,
    // New fields
    culture: userContext?.culture,
    globalRules: userContext?.globalRules,
    calendarRules,
    hasKidsCalendars,
  };
}

/**
 * Call AI provider with retry logic
 * @param prompt - The prompt to send to AI
 * @param includeModelInfo - Whether to append model info footer (for admin only)
 * @param modelId - Optional model ID to override default model
 */
async function callAI(prompt: string, includeModelInfo: boolean = false, modelId?: string): Promise<string> {
  try {
    const result = await generateAICompletion(prompt, modelId);

    // Add model info footer only if requested (for admin user)
    if (includeModelInfo) {
      const modelFooter = `\n\n<i>📊 ${result.model} | ${result.usage.inputTokens}→${result.usage.outputTokens} tokens</i>`;
      return result.text + modelFooter;
    }

    return result.text;
  } catch (error) {
    console.error('Error generating summary with AI:', error);
    return 'Sorry, I could not generate a summary at this time.';
  }
}

/**
 * Generate a natural language summary of calendar events using Claude
 */
export async function generateSummary(
  userEvents: CalendarEvent[],
  spouseEvents: CalendarEvent[],
  otherEvents: CalendarEvent[],
  userName: string,
  userEnglishName: string,
  userGender: 'male' | 'female',
  spouseName: string | undefined,
  spouseEnglishName: string | undefined,
  spouseGender: 'male' | 'female' | undefined,
  primaryCalendar: string,
  date: Date = new Date(),
  includeModelInfo: boolean = false,
  modelId?: string,
  location?: string,
  language?: string,
  userContext?: SummaryUserContext
): Promise<string> {
  // Get timezone from location (or use default)
  let timezone = TIMEZONE;
  let weatherSummary: string | undefined;

  if (location) {
    try {
      const { getTimezone } = await import('./weather/geocoding');
      const { fetchWeather, getWeatherDescription } = await import('./weather/open-meteo');

      // Get timezone for the location
      timezone = await getTimezone(location);

      // Fetch weather data
      const weatherData = await fetchWeather(location, timezone);

      // Build weather summary for prompt
      weatherSummary = `Current: ${weatherData.current.temperature}°C (feels like ${weatherData.current.feelsLike}°C), ${getWeatherDescription(weatherData.current.weatherCode)}
Today: High ${weatherData.today.tempMax}°C, Low ${weatherData.today.tempMin}°C, ${weatherData.today.precipitationProbability}% chance of rain
${weatherData.tomorrow ? `Tomorrow: High ${weatherData.tomorrow.tempMax}°C, Low ${weatherData.tomorrow.tempMin}°C, ${weatherData.tomorrow.precipitationProbability}% chance of rain` : ''}`;
    } catch (error) {
      console.error('Failed to fetch weather/timezone for summary:', error);
      // Continue with defaults if it fails
    }
  }

  // Build prompt data
  const promptData = buildPromptData(
    userEvents,
    spouseEvents,
    otherEvents,
    userName,
    userEnglishName,
    userGender,
    spouseName,
    spouseEnglishName,
    spouseGender,
    date,
    timezone,
    weatherSummary,
    language,
    userContext
  );

  // Build the prompt
  const prompt = buildCalendarSummaryPrompt(promptData);

  // Call AI provider with retry logic, including model info if requested
  return await callAI(prompt, includeModelInfo, modelId);
}

/**
 * Generate summary with full metrics for testing
 * Returns the AICompletionResult with actual token usage
 */
export async function generateSummaryWithMetrics(
  userEvents: CalendarEvent[],
  spouseEvents: CalendarEvent[],
  otherEvents: CalendarEvent[],
  userName: string,
  userEnglishName: string,
  userGender: 'male' | 'female',
  spouseName: string | undefined,
  spouseEnglishName: string | undefined,
  spouseGender: 'male' | 'female' | undefined,
  primaryCalendar: string,
  date: Date = new Date(),
  modelId?: string,
  location?: string,
  language?: string,
  userContext?: SummaryUserContext
) {
  // Get timezone from location (or use default)
  let timezone = TIMEZONE;
  let weatherSummary: string | undefined;

  if (location) {
    try {
      const { getTimezone } = await import('./weather/geocoding');
      const { fetchWeather, getWeatherDescription } = await import('./weather/open-meteo');

      // Get timezone for the location
      timezone = await getTimezone(location);

      // Fetch weather data
      const weatherData = await fetchWeather(location, timezone);

      // Build weather summary for prompt
      weatherSummary = `Current: ${weatherData.current.temperature}°C (feels like ${weatherData.current.feelsLike}°C), ${getWeatherDescription(weatherData.current.weatherCode)}
Today: High ${weatherData.today.tempMax}°C, Low ${weatherData.today.tempMin}°C, ${weatherData.today.precipitationProbability}% chance of rain
${weatherData.tomorrow ? `Tomorrow: High ${weatherData.tomorrow.tempMax}°C, Low ${weatherData.tomorrow.tempMin}°C, ${weatherData.tomorrow.precipitationProbability}% chance of rain` : ''}`;
    } catch (error) {
      console.error('Failed to fetch weather/timezone for summary:', error);
      // Continue with defaults if it fails
    }
  }

  // Build prompt data
  const promptData = buildPromptData(
    userEvents,
    spouseEvents,
    otherEvents,
    userName,
    userEnglishName,
    userGender,
    spouseName,
    spouseEnglishName,
    spouseGender,
    date,
    timezone,
    weatherSummary,
    language,
    userContext
  );

  // Build the prompt
  const prompt = buildCalendarSummaryPrompt(promptData);

  // Call AI provider and return full result
  return await generateAICompletion(prompt, modelId);
}

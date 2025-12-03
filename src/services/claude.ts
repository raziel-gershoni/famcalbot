import { HDate, months } from 'hebcal';
import { CalendarEvent } from '../types';
import { TIMEZONE } from '../config/constants';
import { buildCalendarSummaryPrompt, SummaryPromptData } from '../prompts/calendar-summary';
import { formatEventList } from '../utils/event-formatter';
import { generateAICompletion } from './ai-provider';

/**
 * Get Hebrew date information and check if today is Rosh Chodesh
 */
function getHebrewDateInfo(date: Date = new Date()): { hebrewDate: string; isRoshChodesh: boolean; hebrewDateFormatted: string } {
  const hdate = new HDate(date);

  const day = hdate.getDate();
  const monthName = hdate.getMonthName('h'); // Hebrew month name
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
  userHebrewName: string,
  userGender: 'male' | 'female',
  spouseName: string,
  spouseHebrewName: string,
  spouseGender: 'male' | 'female',
  date: Date,
  weatherSummary?: string,
  language?: string
): SummaryPromptData {
  // Get current date (today) for comparison
  const currentDate = new Date();
  const currentGregorianDate = currentDate.toLocaleDateString('en-US', {
    timeZone: TIMEZONE,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  // Determine greeting based on current time
  const currentHour = parseInt(currentDate.toLocaleTimeString('en-US', {
    timeZone: TIMEZONE,
    hour: '2-digit',
    hour12: false
  }));

  let greeting: string;
  if (currentHour < 12) {
    greeting = 'Good morning!';
  } else if (currentHour < 18) {
    greeting = 'Good afternoon!';
  } else {
    greeting = 'Good evening!';
  }

  // Get summary date and Hebrew date information
  const { isRoshChodesh, hebrewDateFormatted } = getHebrewDateInfo(date);
  const gregorianDate = date.toLocaleDateString('en-US', {
    timeZone: TIMEZONE,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  // Format event lists
  const userEventsText = formatEventList(userEvents);
  const spouseEventsText = formatEventList(spouseEvents);
  const otherEventsText = formatEventList(otherEvents);

  return {
    userName,
    userHebrewName,
    userGender,
    spouseName,
    spouseHebrewName,
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
  userHebrewName: string,
  userGender: 'male' | 'female',
  spouseName: string,
  spouseHebrewName: string,
  spouseGender: 'male' | 'female',
  primaryCalendar: string,
  date: Date = new Date(),
  includeModelInfo: boolean = false,
  modelId?: string,
  location?: string,
  language?: string
): Promise<string> {
  // Fetch weather data if location is provided
  let weatherSummary: string | undefined;
  if (location) {
    try {
      const { fetchWeather } = await import('./weather/open-meteo');
      const { getWeatherDescription } = await import('./weather/open-meteo');
      const weatherData = await fetchWeather(location);

      // Build weather summary for prompt
      weatherSummary = `Current: ${weatherData.current.temperature}°C (feels like ${weatherData.current.feelsLike}°C), ${getWeatherDescription(weatherData.current.weatherCode)}
Today: High ${weatherData.today.tempMax}°C, Low ${weatherData.today.tempMin}°C, ${weatherData.today.precipitationProbability}% chance of rain
${weatherData.tomorrow ? `Tomorrow: High ${weatherData.tomorrow.tempMax}°C, Low ${weatherData.tomorrow.tempMin}°C, ${weatherData.tomorrow.precipitationProbability}% chance of rain` : ''}`;
    } catch (error) {
      console.error('Failed to fetch weather for summary:', error);
      // Continue without weather if it fails
    }
  }

  // Build prompt data
  const promptData = buildPromptData(
    userEvents,
    spouseEvents,
    otherEvents,
    userName,
    userHebrewName,
    userGender,
    spouseName,
    spouseHebrewName,
    spouseGender,
    date,
    weatherSummary,
    language
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
  userHebrewName: string,
  userGender: 'male' | 'female',
  spouseName: string,
  spouseHebrewName: string,
  spouseGender: 'male' | 'female',
  primaryCalendar: string,
  date: Date = new Date(),
  modelId?: string,
  location?: string,
  language?: string
) {
  // Fetch weather data if location is provided
  let weatherSummary: string | undefined;
  if (location) {
    try {
      const { fetchWeather } = await import('./weather/open-meteo');
      const { getWeatherDescription } = await import('./weather/open-meteo');
      const weatherData = await fetchWeather(location);

      // Build weather summary for prompt
      weatherSummary = `Current: ${weatherData.current.temperature}°C (feels like ${weatherData.current.feelsLike}°C), ${getWeatherDescription(weatherData.current.weatherCode)}
Today: High ${weatherData.today.tempMax}°C, Low ${weatherData.today.tempMin}°C, ${weatherData.today.precipitationProbability}% chance of rain
${weatherData.tomorrow ? `Tomorrow: High ${weatherData.tomorrow.tempMax}°C, Low ${weatherData.tomorrow.tempMin}°C, ${weatherData.tomorrow.precipitationProbability}% chance of rain` : ''}`;
    } catch (error) {
      console.error('Failed to fetch weather for summary:', error);
      // Continue without weather if it fails
    }
  }

  // Build prompt data
  const promptData = buildPromptData(
    userEvents,
    spouseEvents,
    otherEvents,
    userName,
    userHebrewName,
    userGender,
    spouseName,
    spouseHebrewName,
    spouseGender,
    date,
    weatherSummary,
    language
  );

  // Build the prompt
  const prompt = buildCalendarSummaryPrompt(promptData);

  // Call AI provider and return full result
  return await generateAICompletion(prompt, modelId);
}

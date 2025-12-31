import { HDate, Locale, gematriya } from '@hebcal/core';
import '@hebcal/locales';
import { CalendarEvent, CalendarAssignment, UserConfig } from '../types';
import { TIMEZONE } from '../config/constants';
import { buildCalendarSummaryPrompt, SummaryPromptData } from '../prompts/calendar-summary';
import { buildWeekLookaheadPrompt, WeekLookaheadPromptData, LookaheadDayData, LookaheadEventData } from '../prompts/week-lookahead';
import { formatEventList } from '../utils/event-formatter';
import { generateAICompletion } from './ai-provider';
import type { WeekLookahead, LookaheadEvent } from './week-lookahead';

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
 * Format date header for voice-only delivery
 * Supports locale (he/en/ru) and culture (jewish/default)
 * Uses gematriya for Hebrew locale
 */
export function formatDateHeader(
  date: Date,
  language: string = 'en',
  culture?: string,
  timezone: string = TIMEZONE
): string {
  const currentHour = parseInt(new Date().toLocaleString('en-US', { timeZone: timezone, hour: '2-digit', hour12: false }));
  const greeting = getLocalizedGreeting(currentHour, language);

  // Format gregorian date based on locale
  const intlLocale = language === 'he' ? 'he-IL' : language === 'ru' ? 'ru-RU' : 'en-US';
  const gregorianDate = date.toLocaleDateString(intlLocale, {
    timeZone: timezone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });

  let dateHeader = `<b>${greeting}</b>\n\n<b>${gregorianDate}</b>`;

  // Add Hebrew date for Jewish culture
  if (culture === 'jewish') {
    const localDate = new Date(date.toLocaleString('en-US', { timeZone: timezone }));
    const hdate = new HDate(localDate);
    const hebDay = language === 'he' ? gematriya(hdate.getDate()) : hdate.getDate();
    const hebMonth = Locale.lookupTranslation(hdate.getMonthName(), language) || hdate.getMonthName();
    const hebrewDate = `${hebDay} ${hebMonth}`;
    dateHeader = `<b>${greeting}</b>\n\n<b>${gregorianDate} • ${hebrewDate}</b>`;
  }

  return dateHeader;
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
  userContext?: SummaryUserContext,
  weatherEnabled: boolean = true
): Promise<string> {
  // Get timezone from location (or use default)
  let timezone = TIMEZONE;
  let weatherSummary: string | undefined;

  if (location && weatherEnabled) {
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
  userContext?: SummaryUserContext,
  weatherEnabled: boolean = true
) {
  // Get timezone from location (or use default)
  let timezone = TIMEZONE;
  let weatherSummary: string | undefined;

  if (location && weatherEnabled) {
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

/**
 * Localized relative day labels
 */
const RELATIVE_LABELS: Record<string, Record<string, string>> = {
  en: { today: 'Today', tomorrow: 'Tomorrow', inDays: 'In {n} days' },
  he: { today: 'היום', tomorrow: 'מחר', inDays: 'בעוד {n} ימים' },
  ru: { today: 'Сегодня', tomorrow: 'Завтра', inDays: 'Через {n} дней' },
};

/**
 * Get relative day label based on days from now
 */
function getRelativeLabel(daysFromNow: number, language: string): string {
  const labels = RELATIVE_LABELS[language] || RELATIVE_LABELS.en;
  if (daysFromNow === 0) return labels.today;
  if (daysFromNow === 1) return labels.tomorrow;
  return labels.inDays.replace('{n}', String(daysFromNow));
}

/**
 * Format date for week lookahead display
 */
function formatLookaheadDate(
  date: Date,
  language: string,
  timezone: string = TIMEZONE
): string {
  const intlLocale = language === 'he' ? 'he-IL' : language === 'ru' ? 'ru-RU' : 'en-US';
  return date.toLocaleDateString(intlLocale, {
    timeZone: timezone,
    weekday: 'long',
    day: 'numeric',
    month: 'short',
  });
}

/**
 * Get Hebrew date string for a given date
 */
function getHebrewDateString(date: Date, language: string, timezone: string = TIMEZONE): string {
  const localDate = new Date(date.toLocaleString('en-US', { timeZone: timezone }));
  const hdate = new HDate(localDate);
  const hebDay = language === 'he' ? gematriya(hdate.getDate()) : hdate.getDate();
  const hebMonth = Locale.lookupTranslation(hdate.getMonthName(), language) || hdate.getMonthName();
  return `${hebDay} ${hebMonth}`;
}

/**
 * Build week lookahead prompt data from lookahead events and user info
 */
function buildWeekLookaheadPromptData(
  lookahead: WeekLookahead,
  user: UserConfig,
  language: string,
  timezone: string = TIMEZONE
): WeekLookaheadPromptData {
  const { events, dateRange } = lookahead;

  // Format today's date
  const today = new Date();
  const todayGregorian = formatLookaheadDate(today, language, timezone);
  const weekEndGregorian = formatLookaheadDate(dateRange.end, language, timezone);

  // Hebrew dates if Jewish culture
  const todayHebrew = user.culture === 'jewish' ? getHebrewDateString(today, language, timezone) : undefined;
  const weekEndHebrew = user.culture === 'jewish' ? getHebrewDateString(dateRange.end, language, timezone) : undefined;

  // Check for spouse and kids calendars
  const hasSpouseCalendar = user.calendarAssignments?.some(c => c.labels.includes('spouse')) ?? false;
  const hasKidsCalendars = user.calendarAssignments?.some(c => c.labels.includes('kids')) ?? false;

  // Get spouse name from calendar assignment
  const spouseCalendar = user.calendarAssignments?.find(c => c.labels.includes('spouse'));
  const spouseName = spouseCalendar?.personName;

  // Group events by day
  const eventsByDayMap = new Map<string, LookaheadEvent[]>();
  for (const event of events) {
    const dayKey = event.start.toDateString();
    if (!eventsByDayMap.has(dayKey)) {
      eventsByDayMap.set(dayKey, []);
    }
    eventsByDayMap.get(dayKey)!.push(event);
  }

  // Format events by day
  const intlLocale = language === 'he' ? 'he-IL' : language === 'ru' ? 'ru-RU' : 'en-US';
  const allDayLabel = language === 'he' ? 'כל היום' : language === 'ru' ? 'Весь день' : 'All day';

  const eventsByDay: LookaheadDayData[] = [];
  for (const [dayKey, dayEvents] of eventsByDayMap) {
    const date = new Date(dayKey);
    const daysFromNow = dayEvents[0].daysFromNow;

    const dayLabel = formatLookaheadDate(date, language, timezone);
    const hebrewDate = user.culture === 'jewish' ? getHebrewDateString(date, language, timezone) : undefined;
    const relativeLabel = getRelativeLabel(daysFromNow, language);

    const formattedEvents: LookaheadEventData[] = dayEvents.map(event => {
      // Format time
      const time = event.start.toLocaleTimeString(intlLocale, {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone: timezone,
      });
      const isAllDay = time === '00:00';

      return {
        time: isAllDay ? allDayLabel : time,
        summary: event.summary,
        calendarName: event.calendarName,
        calendarLabel: event.calendarLabel as 'yours' | 'spouse' | 'kids',
        isRecurring: event.recurrenceType !== 'single',
        recurrenceType: event.recurrenceType !== 'single' ? event.recurrenceType as 'weekly' | 'monthly' | 'yearly' : undefined,
      };
    });

    eventsByDay.push({
      dayLabel,
      hebrewDate,
      daysFromNow,
      relativeLabel,
      events: formattedEvents,
    });
  }

  // Count unique days with events
  const totalDays = eventsByDay.length;

  return {
    userName: user.name,
    userEnglishName: user.englishName,
    userGender: user.gender as 'male' | 'female' | undefined,
    hasSpouseCalendar,
    spouseName,
    culture: user.culture,
    language,
    todayGregorian,
    todayHebrew,
    weekEndGregorian,
    weekEndHebrew,
    eventsByDay,
    globalRules: user.globalRules,
    hasKidsCalendars,
    totalEvents: events.length,
    totalDays,
  };
}

/**
 * Generate AI-rendered week lookahead
 */
export async function generateWeekLookahead(
  lookahead: WeekLookahead,
  user: UserConfig,
  language: string,
  modelId?: string
): Promise<string> {
  // Build prompt data
  const promptData = buildWeekLookaheadPromptData(lookahead, user, language);

  // Handle empty lookahead
  if (lookahead.events.length === 0) {
    const noEventsMsg = {
      en: `<b>Week Ahead</b>\n<b>${promptData.todayGregorian} - ${promptData.weekEndGregorian}</b>${promptData.culture === 'jewish' ? `\n<i>${promptData.todayHebrew} - ${promptData.weekEndHebrew}</i>` : ''}\n\nNo notable events for the upcoming week. Enjoy the clear schedule!`,
      he: `<b>מבט לשבוע הקרוב</b>\n<b>${promptData.todayGregorian} - ${promptData.weekEndGregorian}</b>${promptData.culture === 'jewish' ? `\n<i>${promptData.todayHebrew} - ${promptData.weekEndHebrew}</i>` : ''}\n\nאין אירועים מיוחדים לשבוע הקרוב. תהנה מהשבוע הפנוי!`,
      ru: `<b>Неделя вперёд</b>\n<b>${promptData.todayGregorian} - ${promptData.weekEndGregorian}</b>${promptData.culture === 'jewish' ? `\n<i>${promptData.todayHebrew} - ${promptData.weekEndHebrew}</i>` : ''}\n\nНет примечательных событий на ближайшую неделю. Наслаждайтесь свободным расписанием!`,
    };
    return noEventsMsg[language as keyof typeof noEventsMsg] || noEventsMsg.en;
  }

  // Build the prompt
  const prompt = buildWeekLookaheadPrompt(promptData);

  // Call AI provider
  const result = await generateAICompletion(prompt, modelId);
  return result.text;
}

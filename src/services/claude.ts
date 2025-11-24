import { HDate, months } from 'hebcal';
import { CalendarEvent } from '../types';
import { TIMEZONE } from '../config/constants';
import { USER_MESSAGES } from '../config/messages';
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
  spouseName: string,
  spouseHebrewName: string,
  date: Date
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
    spouseName,
    spouseHebrewName,
    currentGregorianDate,
    summaryGregorianDate: gregorianDate,
    summaryHebrewDate: hebrewDateFormatted,
    isRoshChodesh,
    greeting,
    userEventsText,
    spouseEventsText,
    otherEventsText,
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
  spouseName: string,
  spouseHebrewName: string,
  primaryCalendar: string,
  date: Date = new Date(),
  includeModelInfo: boolean = false,
  modelId?: string
): Promise<string> {
  const allEvents = [...userEvents, ...spouseEvents, ...otherEvents];

  if (allEvents.length === 0) {
    return USER_MESSAGES.NO_EVENTS_TODAY;
  }

  // Build prompt data
  const promptData = buildPromptData(
    userEvents,
    spouseEvents,
    otherEvents,
    userName,
    userHebrewName,
    spouseName,
    spouseHebrewName,
    date
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
  spouseName: string,
  spouseHebrewName: string,
  primaryCalendar: string,
  date: Date = new Date(),
  modelId?: string
) {
  const allEvents = [...userEvents, ...spouseEvents, ...otherEvents];

  if (allEvents.length === 0) {
    return {
      text: USER_MESSAGES.NO_EVENTS_TODAY,
      model: 'none',
      usage: { inputTokens: 0, outputTokens: 0 },
      stopReason: 'no_events' as const
    };
  }

  // Build prompt data
  const promptData = buildPromptData(
    userEvents,
    spouseEvents,
    otherEvents,
    userName,
    userHebrewName,
    spouseName,
    spouseHebrewName,
    date
  );

  // Build the prompt
  const prompt = buildCalendarSummaryPrompt(promptData);

  // Call AI provider and return full result
  return await generateAICompletion(prompt, modelId);
}

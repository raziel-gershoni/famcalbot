/**
 * Event Parser Service
 * Uses AI to parse natural language into calendar event details
 */

import { generateAICompletion } from './ai-provider';
import { CalendarAssignment } from '../types';
import { TIMEZONE } from '../config/constants';

/**
 * Parsed event data from natural language
 */
export interface ParsedEvent {
  title: string;
  startTime: Date;
  endTime: Date;
  location?: string;
  description?: string;
  allDay: boolean;
  calendarId?: string;
  calendarName?: string;
  confidence: 'high' | 'medium' | 'low';
  ambiguities?: string[];
}

/**
 * Parse result from AI
 */
interface ParseResult {
  success: boolean;
  event?: ParsedEvent;
  error?: string;
  needsClarification?: boolean;
  clarificationQuestion?: string;
}

/**
 * Build the event parsing prompt
 */
function buildParsePrompt(
  text: string,
  language: string,
  calendars: CalendarAssignment[],
  currentDate: Date
): string {
  const calendarList = calendars.map(c =>
    `- "${c.name || c.calendarId}" (ID: ${c.calendarId}, labels: ${c.labels.join(', ')})`
  ).join('\n');

  const currentDateStr = currentDate.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: TIMEZONE
  });

  const currentTimeStr = currentDate.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: TIMEZONE
  });

  return `You are a calendar event parser. Parse the following voice transcription into a structured calendar event.

CURRENT DATE/TIME: ${currentDateStr} at ${currentTimeStr} (timezone: ${TIMEZONE})
USER LANGUAGE: ${language}

USER'S CALENDARS:
${calendarList || '- Primary calendar (ID: primary)'}

VOICE TRANSCRIPTION:
"${text}"

INSTRUCTIONS:
1. Extract the event title, date, time, duration, and location from the transcription
2. If a calendar name is mentioned or implied (e.g., "work meeting" → work calendar), match it to the user's calendars
3. If no end time is specified, default to 1 hour duration
4. If the date is relative (tomorrow, next week, etc.), calculate the absolute date
5. If time is ambiguous (e.g., "at 3" could be 3 AM or 3 PM), assume PM for typical events

RESPOND IN JSON FORMAT ONLY:
{
  "success": true/false,
  "event": {
    "title": "Event title",
    "startDate": "YYYY-MM-DD",
    "startTime": "HH:MM" (24-hour format),
    "endDate": "YYYY-MM-DD",
    "endTime": "HH:MM" (24-hour format),
    "allDay": false,
    "location": "Location if mentioned" or null,
    "description": "Description if mentioned" or null,
    "calendarId": "matched calendar ID" or "primary",
    "calendarName": "matched calendar name" or "Primary",
    "confidence": "high"/"medium"/"low"
  },
  "ambiguities": ["List of unclear aspects"] or null,
  "error": "Error message if parsing failed" or null,
  "needsClarification": true/false,
  "clarificationQuestion": "Question to ask user" or null
}

EXAMPLES:
Input: "Meeting with David tomorrow at 3pm"
Output: {"success": true, "event": {"title": "Meeting with David", "startDate": "2024-01-06", "startTime": "15:00", "endDate": "2024-01-06", "endTime": "16:00", "allDay": false, "location": null, "description": null, "calendarId": "primary", "calendarName": "Primary", "confidence": "high"}, "ambiguities": null}

Input: "פגישה עם יוסי ביום שלישי בשעה 10" (Hebrew: Meeting with Yossi on Tuesday at 10)
Output: {"success": true, "event": {"title": "פגישה עם יוסי", "startDate": "2024-01-09", "startTime": "10:00", "endDate": "2024-01-09", "endTime": "11:00", "allDay": false, "location": null, "description": null, "calendarId": "primary", "calendarName": "Primary", "confidence": "high"}, "ambiguities": null}

Input: "Dentist"
Output: {"success": false, "needsClarification": true, "clarificationQuestion": "When would you like to schedule the dentist appointment?"}`;
}

/**
 * Parse natural language text into a calendar event
 * @param text - Transcribed voice message text
 * @param language - User's preferred language
 * @param calendars - User's calendar assignments
 * @returns Parsed event or error
 */
export async function parseEventFromText(
  text: string,
  language: string,
  calendars: CalendarAssignment[]
): Promise<ParseResult> {
  const currentDate = new Date();

  try {
    const prompt = buildParsePrompt(text, language, calendars, currentDate);

    // Use AI to parse the text
    const result = await generateAICompletion(prompt);
    const response = result.text;

    // Extract JSON from response
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return {
        success: false,
        error: 'Failed to parse AI response as JSON',
      };
    }

    const parsed = JSON.parse(jsonMatch[0]);

    if (!parsed.success) {
      return {
        success: false,
        error: parsed.error,
        needsClarification: parsed.needsClarification,
        clarificationQuestion: parsed.clarificationQuestion,
      };
    }

    // Convert parsed dates to Date objects
    const eventData = parsed.event;
    const startDateTime = new Date(`${eventData.startDate}T${eventData.startTime}:00`);
    const endDateTime = new Date(`${eventData.endDate}T${eventData.endTime}:00`);

    // Validate dates
    if (isNaN(startDateTime.getTime()) || isNaN(endDateTime.getTime())) {
      return {
        success: false,
        error: 'Invalid date/time parsed from input',
      };
    }

    const event: ParsedEvent = {
      title: eventData.title,
      startTime: startDateTime,
      endTime: endDateTime,
      location: eventData.location || undefined,
      description: eventData.description || undefined,
      allDay: eventData.allDay || false,
      calendarId: eventData.calendarId || 'primary',
      calendarName: eventData.calendarName || 'Primary',
      confidence: eventData.confidence || 'medium',
      ambiguities: parsed.ambiguities || undefined,
    };

    return {
      success: true,
      event,
    };
  } catch (error) {
    console.error('[EventParser] Error parsing event:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown parsing error',
    };
  }
}

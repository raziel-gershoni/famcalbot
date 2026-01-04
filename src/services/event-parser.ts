/**
 * Event Parser Service
 * Uses AI to parse natural language into calendar event details
 */

import { generateAICompletion } from './ai-provider';
import { CalendarAssignment } from '../types';
import { TIMEZONE } from '../config/constants';
import { fromZonedTime } from 'date-fns-tz';

/**
 * Voice intent types
 */
export type VoiceIntent = 'create' | 'edit' | 'delete';

/**
 * Reference to an existing event for edit/delete operations
 */
export interface EventReference {
  type: 'last_created' | 'by_description';
  description?: string;  // "dentist appointment", "meeting with David"
  timeHint?: string;     // "tomorrow", "next week" - raw text for date range
  originalTime?: string; // "15:00" - the start time of the event being referenced (for disambiguation)
  originalDate?: string; // "YYYY-MM-DD" - explicit date if mentioned (more specific than timeHint)
}

/**
 * Requested changes for an edit operation
 */
export interface EditRequest {
  newTitle?: string;
  newStartDate?: string;  // YYYY-MM-DD
  newStartTime?: string;  // HH:MM
  newEndDate?: string;    // YYYY-MM-DD
  newEndTime?: string;    // HH:MM
  newLocation?: string;
  newAllDay?: boolean;
}

/**
 * Result of parsing voice intent
 */
export interface VoiceIntentResult {
  intent: VoiceIntent;
  event?: ParsedEvent;           // For CREATE intent
  editRequest?: EditRequest;     // For EDIT intent
  eventReference?: EventReference;  // For EDIT/DELETE intent
  confidence: 'high' | 'medium' | 'low';
  error?: string;
  needsClarification?: boolean;
  clarificationQuestion?: string;
}

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

    // Convert parsed dates to Date objects (times are in user's timezone)
    const eventData = parsed.event;
    // Parse as local Israel time, then convert to UTC for proper Date handling
    const startDateTime = fromZonedTime(`${eventData.startDate}T${eventData.startTime}:00`, TIMEZONE);
    const endDateTime = fromZonedTime(`${eventData.endDate}T${eventData.endTime}:00`, TIMEZONE);

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

/**
 * Build the intent detection prompt
 */
function buildIntentPrompt(
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

  return `You are a calendar assistant. Analyze the following voice command and determine the user's intent.

CURRENT DATE/TIME: ${currentDateStr} at ${currentTimeStr} (timezone: ${TIMEZONE})
USER LANGUAGE: ${language}

USER'S CALENDARS:
${calendarList || '- Primary calendar (ID: primary)'}

VOICE COMMAND:
"${text}"

INTENT DETECTION RULES:
1. EDIT intent - User wants to modify an existing event. Keywords/phrases:
   - English: move, change, reschedule, update, edit, push, postpone, make it, shift
   - Hebrew: הזז, שנה, עדכן, ערוך, דחה, העבר, תשנה, תזיז
   - Russian: перенеси, измени, передвинь, обнови, сдвинь

2. DELETE intent - User wants to remove/cancel an event. Keywords/phrases:
   - English: cancel, delete, remove, skip, forget
   - Hebrew: בטל, מחק, הסר, תבטל, תמחק
   - Russian: отмени, удали, убери, отменить

3. CREATE intent - User wants to add a new event (default if no edit/delete keywords)
   - Creating something new, adding to calendar

4. "that", "את זה", "это" or similar references to "last event" mean the most recently created event

RESPOND IN JSON FORMAT ONLY:
{
  "intent": "create" | "edit" | "delete",
  "confidence": "high" | "medium" | "low",

  // For CREATE intent - full event details:
  "event": {
    "title": "Event title",
    "startDate": "YYYY-MM-DD",
    "startTime": "HH:MM",
    "endDate": "YYYY-MM-DD",
    "endTime": "HH:MM",
    "allDay": false,
    "location": "Location if mentioned" or null,
    "description": "Description if mentioned" or null,
    "calendarId": "matched calendar ID" or "primary",
    "calendarName": "matched calendar name" or "Primary"
  },

  // For EDIT intent - what to change:
  "editRequest": {
    "newTitle": "New title" or null,
    "newStartDate": "YYYY-MM-DD" or null,
    "newStartTime": "HH:MM" or null,
    "newEndDate": "YYYY-MM-DD" or null,
    "newEndTime": "HH:MM" or null,
    "newLocation": "New location" or null,
    "newAllDay": true/false or null
  },

  // For EDIT/DELETE - which event to modify:
  "eventReference": {
    "type": "last_created" | "by_description",
    "description": "dentist", "meeting with David" - keywords to match event,
    "timeHint": "tomorrow", "next week" - relative date hint,
    "originalTime": "HH:MM" or null - the START TIME of the event being referenced (NOT the new time),
    "originalDate": "YYYY-MM-DD" or null - explicit date of the event (if mentioned)
  },

  "error": "Error message" or null,
  "needsClarification": true/false,
  "clarificationQuestion": "Question for user" or null
}

EXAMPLES:

Input: "Move my dentist to 4pm"
Output: {"intent": "edit", "confidence": "high", "eventReference": {"type": "by_description", "description": "dentist"}, "editRequest": {"newStartTime": "16:00", "newEndTime": "17:00"}}

Input: "Move the lesson from tomorrow 15:00 to today 20:00"
Output: {"intent": "edit", "confidence": "high", "eventReference": {"type": "by_description", "description": "lesson", "timeHint": "tomorrow", "originalTime": "15:00"}, "editRequest": {"newStartDate": "2024-01-05", "newStartTime": "20:00", "newEndTime": "21:00"}}

Input: "Cancel the 10am dentist"
Output: {"intent": "delete", "confidence": "high", "eventReference": {"type": "by_description", "description": "dentist", "originalTime": "10:00"}}

Input: "Cancel the meeting tomorrow"
Output: {"intent": "delete", "confidence": "high", "eventReference": {"type": "by_description", "description": "meeting", "timeHint": "tomorrow"}}

Input: "תבטל את זה" (Hebrew: Cancel that)
Output: {"intent": "delete", "confidence": "high", "eventReference": {"type": "last_created"}}

Input: "Change the 14:00 meeting to 3pm on Thursday"
Output: {"intent": "edit", "confidence": "high", "eventReference": {"type": "by_description", "description": "meeting", "originalTime": "14:00"}, "editRequest": {"newStartDate": "2024-01-11", "newStartTime": "15:00", "newEndTime": "16:00"}}

Input: "Meeting with David tomorrow at 3pm"
Output: {"intent": "create", "confidence": "high", "event": {"title": "Meeting with David", "startDate": "2024-01-06", "startTime": "15:00", "endDate": "2024-01-06", "endTime": "16:00", "allDay": false, "calendarId": "primary", "calendarName": "Primary"}}`;
}

/**
 * Parse voice command to detect intent and extract details
 * Determines if user wants to create, edit, or delete an event
 */
export async function parseVoiceIntent(
  text: string,
  language: string,
  calendars: CalendarAssignment[]
): Promise<VoiceIntentResult> {
  const currentDate = new Date();

  try {
    const prompt = buildIntentPrompt(text, language, calendars, currentDate);
    const result = await generateAICompletion(prompt);
    const response = result.text;

    // Extract JSON from response
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return {
        intent: 'create',
        confidence: 'low',
        error: 'Failed to parse AI response as JSON',
      };
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const intent: VoiceIntent = parsed.intent || 'create';

    // Handle CREATE intent - convert to ParsedEvent
    if (intent === 'create' && parsed.event) {
      const eventData = parsed.event;
      const startDateTime = fromZonedTime(`${eventData.startDate}T${eventData.startTime}:00`, TIMEZONE);
      const endDateTime = fromZonedTime(`${eventData.endDate}T${eventData.endTime}:00`, TIMEZONE);

      if (isNaN(startDateTime.getTime()) || isNaN(endDateTime.getTime())) {
        return {
          intent: 'create',
          confidence: 'low',
          error: 'Invalid date/time parsed from input',
        };
      }

      return {
        intent: 'create',
        confidence: parsed.confidence || 'medium',
        event: {
          title: eventData.title,
          startTime: startDateTime,
          endTime: endDateTime,
          location: eventData.location || undefined,
          description: eventData.description || undefined,
          allDay: eventData.allDay || false,
          calendarId: eventData.calendarId || 'primary',
          calendarName: eventData.calendarName || 'Primary',
          confidence: parsed.confidence || 'medium',
        },
        error: parsed.error,
        needsClarification: parsed.needsClarification,
        clarificationQuestion: parsed.clarificationQuestion,
      };
    }

    // Handle EDIT intent
    if (intent === 'edit') {
      return {
        intent: 'edit',
        confidence: parsed.confidence || 'medium',
        editRequest: parsed.editRequest || undefined,
        eventReference: parsed.eventReference || undefined,
        error: parsed.error,
        needsClarification: parsed.needsClarification,
        clarificationQuestion: parsed.clarificationQuestion,
      };
    }

    // Handle DELETE intent
    if (intent === 'delete') {
      return {
        intent: 'delete',
        confidence: parsed.confidence || 'medium',
        eventReference: parsed.eventReference || undefined,
        error: parsed.error,
        needsClarification: parsed.needsClarification,
        clarificationQuestion: parsed.clarificationQuestion,
      };
    }

    // Fallback - treat as create with error
    return {
      intent: 'create',
      confidence: 'low',
      error: parsed.error || 'Unknown intent',
      needsClarification: parsed.needsClarification,
      clarificationQuestion: parsed.clarificationQuestion,
    };

  } catch (error) {
    console.error('[EventParser] Error parsing voice intent:', error);
    return {
      intent: 'create',
      confidence: 'low',
      error: error instanceof Error ? error.message : 'Unknown parsing error',
    };
  }
}

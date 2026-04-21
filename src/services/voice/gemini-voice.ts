/**
 * Gemini Event Extraction
 * Shared prompt builder + response parser for voice and text event extraction
 * Voice: sends audio directly to Gemini for transcription + intent detection + event extraction
 * Text: sends forwarded message text for intent detection + event extraction
 */

import { getGemini } from '../ai-provider';
import { VoiceIntentResult, VoiceIntent, ParsedEvent } from '../event-parser';
import { CalendarAssignment } from '../../types';
import { fromZonedTime } from 'date-fns-tz';
import { getDefaultAiModelSetting } from '../reminder-cache';
import { getModelConfig } from '../../config/ai-models';

const VOICE_RETRY_CONFIG = {
  maxRetries: 1,
  baseDelayMs: 500,
} as const;

const VOICE_MODEL_FALLBACK = 'gemini-3-flash-preview';

/**
 * Build the event extraction prompt (shared between voice and text modes)
 */
export function buildEventExtractionPrompt(
  language: string,
  calendars: CalendarAssignment[],
  timezone: string,
  mode: 'voice' | 'text' = 'voice'
): string {
  const calendarList = calendars.map(c =>
    `- "${c.name || c.calendarId}" (ID: ${c.calendarId}, labels: ${c.labels.join(', ')})`
  ).join('\n');

  const now = new Date();
  const currentDateStr = now.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: timezone,
  });
  const currentTimeStr = now.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: timezone,
  });

  const modeInstructions = mode === 'voice'
    ? `You are a calendar assistant. Listen to the attached audio message and:
1. Transcribe what the user said
2. Determine the user's intent (create, edit, or delete a calendar event)
3. Extract structured event data based on the intent`
    : `You are a calendar assistant. Parse the following forwarded text message and extract calendar event information.
The text may be conversational (e.g. "Hey, can you come to dinner at our place on Friday at 7pm?"). Look for dates, times, event names, and locations.
1. Determine the intent (create, edit, delete, or none if no event information found)
2. Extract structured event data based on the intent`;

  return `${modeInstructions}

CURRENT DATE/TIME: ${currentDateStr} at ${currentTimeStr} (timezone: ${timezone})
USER LANGUAGE: ${language}

USER'S CALENDARS:
${calendarList || '- Primary calendar (ID: primary)'}

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
   - RECURRENCE DETECTION for recurring events:
     * "every day/daily" (כל יום, каждый день) → frequency: "daily"
     * "every week/weekly" (כל שבוע, каждую неделю) → frequency: "weekly"
     * "every month/monthly" (כל חודש, каждый месяц) → frequency: "monthly"
     * "every Tuesday" (כל יום שלישי, каждый вторник) → frequency: "weekly", daysOfWeek: ["TU"]
     * "every Monday and Wednesday" → frequency: "weekly", daysOfWeek: ["MO", "WE"]
     * Day codes: MO, TU, WE, TH, FR, SA, SU

4. "that", "את זה", "это" or similar references to "last event" mean the most recently created event

5. SCOPE DETECTION (for EDIT/DELETE of recurring events):
   - Default: "single" (only the matched instance)
   - scope: "all" keywords:
     * English: "all events", "all [name] events", "entire series", "the whole series"
     * Hebrew: "כל האירועים", "את כל ה", "כל הסדרה"
     * Russian: "все события", "всю серию"
   - scope: "following" keywords:
     * English: "all future", "all following", "from now on", "going forward", "this and all future"
     * Hebrew: "מעכשיו והלאה", "כל העתידיים", "מכאן והלאה"
     * Russian: "все будущие", "с этого момента", "начиная отсюда"

RESPOND IN JSON FORMAT ONLY:
{${mode === 'voice' ? '\n  "transcription": "Exact text of what the user said in the audio",' : ''}
  "intent": ${mode === 'voice' ? '"create" | "edit" | "delete"' : '"create" | "edit" | "delete" | "none"'},
  "confidence": "high" | "medium" | "low",
  "scope": "single" | "all" | "following" (default: "single", only for edit/delete),

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
    "calendarName": "matched calendar name" or "Primary",
    "recurrence": {"frequency": "daily"/"weekly"/"monthly"/"yearly", "daysOfWeek": ["MO",...], "interval": number} or null
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

Input audio: "Move my dentist to 4pm"
Output: {"transcription": "Move my dentist to 4pm", "intent": "edit", "confidence": "high", "eventReference": {"type": "by_description", "description": "dentist"}, "editRequest": {"newStartTime": "16:00", "newEndTime": "17:00"}}

Input audio: "Cancel the 10am dentist"
Output: {"transcription": "Cancel the 10am dentist", "intent": "delete", "confidence": "high", "eventReference": {"type": "by_description", "description": "dentist", "originalTime": "10:00"}}

Input audio: "Meeting with David tomorrow at 3pm"
Output: {"transcription": "Meeting with David tomorrow at 3pm", "intent": "create", "confidence": "high", "event": {"title": "Meeting with David", "startDate": "YYYY-MM-DD", "startTime": "15:00", "endDate": "YYYY-MM-DD", "endTime": "16:00", "allDay": false, "calendarId": "primary", "calendarName": "Primary", "recurrence": null}}

Input audio: "Team meeting every Tuesday at 2pm"
Output: {"transcription": "Team meeting every Tuesday at 2pm", "intent": "create", "confidence": "high", "event": {"title": "Team meeting", "startDate": "YYYY-MM-DD", "startTime": "14:00", "endDate": "YYYY-MM-DD", "endTime": "15:00", "allDay": false, "calendarId": "primary", "calendarName": "Primary", "recurrence": {"frequency": "weekly", "daysOfWeek": ["TU"]}}}

Input audio: "תבטל את זה" (Hebrew: Cancel that)
Output: {"transcription": "תבטל את זה", "intent": "delete", "confidence": "high", "eventReference": {"type": "last_created"}}

Input audio: "Delete ALL gym events"
Output: {"transcription": "Delete ALL gym events", "intent": "delete", "confidence": "high", "scope": "all", "eventReference": {"type": "by_description", "description": "gym"}}

Input audio: "Move all future standup meetings to 10am"
Output: {"transcription": "Move all future standup meetings to 10am", "intent": "edit", "confidence": "high", "scope": "following", "eventReference": {"type": "by_description", "description": "standup"}, "editRequest": {"newStartTime": "10:00", "newEndTime": "10:30"}}

Input audio: "הזז את רופא השיניים לארבע" (Hebrew: Move the dentist to four)
Output: {"transcription": "הזז את רופא השיניים לארבע", "intent": "edit", "confidence": "high", "eventReference": {"type": "by_description", "description": "רופא שיניים"}, "editRequest": {"newStartTime": "16:00", "newEndTime": "17:00"}}

Input audio: "Reschedule my 9am yoga to next Monday"
Output: {"transcription": "Reschedule my 9am yoga to next Monday", "intent": "edit", "confidence": "high", "eventReference": {"type": "by_description", "description": "yoga", "originalTime": "09:00"}, "editRequest": {"newStartDate": "YYYY-MM-DD", "newStartTime": "09:00", "newEndDate": "YYYY-MM-DD", "newEndTime": "10:00"}}

Input audio: "перенеси встречу с Давидом на пятницу в три" (Russian: Move the meeting with David to Friday at three)
Output: {"transcription": "перенеси встречу с Давидом на пятницу в три", "intent": "edit", "confidence": "high", "eventReference": {"type": "by_description", "description": "встреча с Давидом"}, "editRequest": {"newStartDate": "YYYY-MM-DD", "newStartTime": "15:00", "newEndDate": "YYYY-MM-DD", "newEndTime": "16:00"}}

Input audio: "Move the lesson from tomorrow 15:00 to today 20:00"
Output: {"transcription": "Move the lesson from tomorrow 15:00 to today 20:00", "intent": "edit", "confidence": "high", "eventReference": {"type": "by_description", "description": "lesson", "timeHint": "tomorrow", "originalTime": "15:00"}, "editRequest": {"newStartDate": "YYYY-MM-DD", "newStartTime": "20:00", "newEndTime": "21:00"}}

Input audio: "Extend the dentist until 17:00"
Output: {"transcription": "Extend the dentist until 17:00", "intent": "edit", "confidence": "high", "eventReference": {"type": "by_description", "description": "dentist"}, "editRequest": {"newEndTime": "17:00"}}

Input audio: "Change the title of tomorrow's lunch to Lunch with Sarah"
Output: {"transcription": "Change the title of tomorrow's lunch to Lunch with Sarah", "intent": "edit", "confidence": "high", "eventReference": {"type": "by_description", "description": "lunch", "timeHint": "tomorrow"}, "editRequest": {"newTitle": "Lunch with Sarah"}}` + (mode === 'text' ? `

ADDITIONAL TEXT-MODE EXAMPLES:

Input text: "Hey, can we do dinner at my place on Friday at 7pm?"
Output: {"intent": "create", "confidence": "high", "event": {"title": "Dinner", "startDate": "YYYY-MM-DD", "startTime": "19:00", "endDate": "YYYY-MM-DD", "endTime": "21:00", "allDay": false, "calendarId": "primary", "calendarName": "Primary", "recurrence": null}}

Input text: "Don't forget - parent-teacher meeting next Tuesday at 16:30 in room 204"
Output: {"intent": "create", "confidence": "high", "event": {"title": "Parent-teacher meeting", "startDate": "YYYY-MM-DD", "startTime": "16:30", "endDate": "YYYY-MM-DD", "endTime": "17:30", "allDay": false, "location": "Room 204", "calendarId": "primary", "calendarName": "Primary", "recurrence": null}}

Input text: "haha that's hilarious 😂"
Output: {"intent": "none", "confidence": "high", "error": "No calendar event information found in this message."}

Input text: "The meeting tomorrow is pushed to 3pm instead"
Output: {"intent": "edit", "confidence": "high", "eventReference": {"type": "by_description", "description": "meeting", "timeHint": "tomorrow"}, "editRequest": {"newStartTime": "15:00", "newEndTime": "16:00"}}` : '');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Parse Gemini JSON response into VoiceIntentResult
 * Shared between voice and text processing pipelines
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseGeminiEventResponse(
  parsed: any,
  calendars: CalendarAssignment[],
  timezone: string
): VoiceIntentResult {
  const intent: VoiceIntent | 'none' = parsed.intent || 'create';
  const confidence = parsed.confidence || 'medium';

  // Handle 'none' intent (text mode — no event found)
  if (intent === 'none') {
    return {
      intent: 'create',
      confidence: 'low',
      error: parsed.error || 'no_event_found',
    };
  }

  if (intent === 'create' && parsed.event) {
    const eventData = parsed.event;

    // Validate calendarId against user's actual calendars
    const geminiCalId = eventData.calendarId || '';
    let matchedCalendar = calendars.find(c => c.calendarId === geminiCalId);
    // Partial match: Gemini may strip the @group.calendar.google.com suffix
    if (!matchedCalendar && geminiCalId) {
      matchedCalendar = calendars.find(c => c.calendarId.startsWith(geminiCalId));
    }
    // Name match: try matching by calendar name (case-insensitive)
    if (!matchedCalendar && (geminiCalId || eventData.calendarName)) {
      const nameToMatch = (eventData.calendarName || geminiCalId).toLowerCase();
      matchedCalendar = calendars.find(c => c.name?.toLowerCase() === nameToMatch);
    }
    if (!matchedCalendar) {
      console.warn(`[Gemini] Could not match calendarId "${geminiCalId}" / name "${eventData.calendarName}" to user calendars, falling back to "${calendars[0]?.calendarId || 'primary'}"`);
    }
    const resolvedCalendarId = matchedCalendar?.calendarId || calendars[0]?.calendarId || 'primary';
    const resolvedCalendarName = matchedCalendar?.name || calendars[0]?.name || 'Primary';

    // All-day events may not have startTime/endTime from Gemini
    const startTimeStr = eventData.allDay ? (eventData.startTime || '00:00') : eventData.startTime;
    const endTimeStr = eventData.allDay ? (eventData.endTime || '23:59') : eventData.endTime;
    const endDateStr = eventData.endDate || eventData.startDate;

    if (!eventData.startDate || (!eventData.allDay && (!startTimeStr || !endTimeStr))) {
      return {
        intent: 'create',
        confidence: 'low',
        error: 'Missing date/time fields',
      };
    }

    const startDateTime = fromZonedTime(`${eventData.startDate}T${startTimeStr}:00`, timezone);
    const endDateTime = fromZonedTime(`${endDateStr}T${endTimeStr}:00`, timezone);

    if (isNaN(startDateTime.getTime()) || isNaN(endDateTime.getTime())) {
      return {
        intent: 'create',
        confidence: 'low',
        error: 'Invalid date/time parsed',
      };
    }

    const event: ParsedEvent = {
      title: eventData.title,
      startTime: startDateTime,
      endTime: endDateTime,
      location: eventData.location || undefined,
      description: eventData.description || undefined,
      allDay: eventData.allDay || false,
      calendarId: resolvedCalendarId,
      calendarName: resolvedCalendarName,
      confidence,
      recurrence: eventData.recurrence?.frequency ? eventData.recurrence : undefined,
    };

    return {
      intent: 'create',
      confidence,
      event,
      error: parsed.error,
      needsClarification: parsed.needsClarification,
      clarificationQuestion: parsed.clarificationQuestion,
    };
  } else if (intent === 'edit') {
    return {
      intent: 'edit',
      confidence,
      editRequest: parsed.editRequest || undefined,
      eventReference: parsed.eventReference || undefined,
      scope: parsed.scope || 'single',
      error: parsed.error,
      needsClarification: parsed.needsClarification,
      clarificationQuestion: parsed.clarificationQuestion,
    };
  } else if (intent === 'delete') {
    return {
      intent: 'delete',
      confidence,
      eventReference: parsed.eventReference || undefined,
      scope: parsed.scope || 'single',
      error: parsed.error,
      needsClarification: parsed.needsClarification,
      clarificationQuestion: parsed.clarificationQuestion,
    };
  } else {
    return {
      intent: 'create',
      confidence: 'low',
      error: parsed.error || 'Unknown intent',
      needsClarification: parsed.needsClarification,
      clarificationQuestion: parsed.clarificationQuestion,
    };
  }
}

/**
 * Process voice audio directly with Gemini 3 Flash
 * Single API call: transcription + intent detection + event extraction
 */
export interface VoiceProcessingMetrics {
  model: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

export async function processVoiceWithGemini(
  audioBuffer: Buffer,
  language: string,
  calendars: CalendarAssignment[],
  timezone: string
): Promise<{ intentResult: VoiceIntentResult; transcription: string; metrics: VoiceProcessingMetrics }> {
  const startTime = Date.now();
  let lastError: Error | null = null;

  // Resolve model: admin setting → env var → hardcoded fallback
  const adminDefault = await getDefaultAiModelSetting();
  let resolvedModelId = VOICE_MODEL_FALLBACK;
  if (adminDefault) {
    const cfg = getModelConfig(adminDefault);
    if (cfg) resolvedModelId = cfg.modelId;
  } else if (process.env.AI_MODEL) {
    const cfg = getModelConfig(process.env.AI_MODEL);
    if (cfg) resolvedModelId = cfg.modelId;
  }

  for (let attempt = 0; attempt <= VOICE_RETRY_CONFIG.maxRetries; attempt++) {
    try {
      const promptText = buildEventExtractionPrompt(language, calendars, timezone, 'voice');

      const response = await getGemini().models.generateContent({
        model: resolvedModelId,
        contents: [
          {
            role: 'user',
            parts: [
              { text: promptText },
              { inlineData: { mimeType: 'audio/ogg', data: audioBuffer.toString('base64') } },
            ],
          },
        ],
      });

      const duration = Date.now() - startTime;
      const inputTokens = response.usageMetadata?.promptTokenCount || 0;
      const outputTokens = response.usageMetadata?.candidatesTokenCount || 0;

      console.log(`[Voice Gemini] Response in ${duration}ms, model: ${resolvedModelId}, tokens: ${inputTokens}in/${outputTokens}out, attempt: ${attempt + 1}`);

      // response.text getter can throw if no candidates are present
      let responseText: string;
      try {
        responseText = response.text ?? '';
      } catch {
        throw new Error('Gemini returned empty response');
      }
      if (!responseText) {
        throw new Error('Gemini returned empty response');
      }

      // Extract JSON from response (may be wrapped in markdown code blocks)
      let jsonSource = responseText;
      const codeBlockMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (codeBlockMatch) {
        jsonSource = codeBlockMatch[1];
      }
      const jsonMatch = jsonSource.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('Failed to extract JSON from Gemini response');
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const parsed: any = JSON.parse(jsonMatch[0]);
      const transcription: string = parsed.transcription || '';

      // Empty transcription guard
      if (!transcription.trim()) {
        console.log('[Voice Gemini] empty transcription received');
        throw new Error('Empty transcription - could not understand audio');
      }

      const intentResult = parseGeminiEventResponse(parsed, calendars, timezone);

      return {
        intentResult,
        transcription,
        metrics: { model: resolvedModelId, inputTokens, outputTokens, durationMs: duration },
      };

    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt < VOICE_RETRY_CONFIG.maxRetries) {
        const delay = VOICE_RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt);
        console.warn(`[Voice Gemini] Error (attempt ${attempt + 1}/${VOICE_RETRY_CONFIG.maxRetries + 1}), retrying in ${delay}ms:`, error);
        await sleep(delay);
      }
    }
  }

  console.error(`[Voice Gemini] Failed after ${VOICE_RETRY_CONFIG.maxRetries + 1} attempts:`, lastError);
  throw new Error(`Voice processing failed: ${lastError?.message || 'Unknown error'}`);
}

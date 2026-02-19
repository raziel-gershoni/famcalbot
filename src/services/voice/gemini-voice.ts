/**
 * Gemini Direct Voice Processing
 * Sends audio directly to Gemini 3 Flash for transcription + intent detection + event extraction
 */

import { getGemini } from '../ai-provider';
import { VoiceIntentResult, VoiceIntent, ParsedEvent } from '../event-parser';
import { CalendarAssignment } from '../../types';
import { fromZonedTime } from 'date-fns-tz';

const VOICE_RETRY_CONFIG = {
  maxRetries: 1,
  baseDelayMs: 500,
} as const;

const GEMINI_VOICE_MODEL = 'gemini-3-flash-preview';

/**
 * Build the voice processing prompt
 */
function buildVoicePrompt(
  language: string,
  calendars: CalendarAssignment[],
  timezone: string
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

  return `You are a calendar assistant. Listen to the attached audio message and:
1. Transcribe what the user said
2. Determine the user's intent (create, edit, or delete a calendar event)
3. Extract structured event data based on the intent

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
{
  "transcription": "Exact text of what the user said in the audio",
  "intent": "create" | "edit" | "delete",
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
Output: {"transcription": "Change the title of tomorrow's lunch to Lunch with Sarah", "intent": "edit", "confidence": "high", "eventReference": {"type": "by_description", "description": "lunch", "timeHint": "tomorrow"}, "editRequest": {"newTitle": "Lunch with Sarah"}}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Process voice audio directly with Gemini 3 Flash
 * Single API call: transcription + intent detection + event extraction
 */
export async function processVoiceWithGemini(
  audioBuffer: Buffer,
  language: string,
  calendars: CalendarAssignment[],
  timezone: string
): Promise<{ intentResult: VoiceIntentResult; transcription: string }> {
  const startTime = Date.now();
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= VOICE_RETRY_CONFIG.maxRetries; attempt++) {
    try {
      const promptText = buildVoicePrompt(language, calendars, timezone);

      const response = await getGemini().models.generateContent({
        model: GEMINI_VOICE_MODEL,
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

      console.log(`[Voice Gemini] Response in ${duration}ms, model: ${GEMINI_VOICE_MODEL}, tokens: ${inputTokens}in/${outputTokens}out, attempt: ${attempt + 1}`);

      const responseText = response.text;
      if (!responseText) {
        throw new Error('Gemini returned empty response');
      }

      // Extract JSON from response (may be wrapped in markdown code blocks)
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
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

      const intent: VoiceIntent = parsed.intent || 'create';
      const confidence = parsed.confidence || 'medium';

      // Build intent result based on detected intent
      let intentResult: VoiceIntentResult;

      if (intent === 'create' && parsed.event) {
        const eventData = parsed.event;

        // Validate calendarId against user's actual calendars
        const geminiCalId = eventData.calendarId || '';
        let matchedCalendar = calendars.find(c => c.calendarId === geminiCalId);
        // Partial match: Gemini may strip the @group.calendar.google.com suffix
        if (!matchedCalendar && geminiCalId) {
          matchedCalendar = calendars.find(c => c.calendarId.startsWith(geminiCalId) || geminiCalId.startsWith(c.calendarId));
        }
        // Name match: try matching by calendar name (case-insensitive)
        if (!matchedCalendar && (geminiCalId || eventData.calendarName)) {
          const nameToMatch = (eventData.calendarName || geminiCalId).toLowerCase();
          matchedCalendar = calendars.find(c => c.name?.toLowerCase() === nameToMatch);
        }
        if (!matchedCalendar) {
          console.warn(`[Voice Gemini] Could not match calendarId "${geminiCalId}" / name "${eventData.calendarName}" to user calendars, falling back to "${calendars[0]?.calendarId || 'primary'}"`);
        }
        const resolvedCalendarId = matchedCalendar?.calendarId || calendars[0]?.calendarId || 'primary';
        const resolvedCalendarName = matchedCalendar?.name || calendars[0]?.name || 'Primary';

        const startDateTime = fromZonedTime(`${eventData.startDate}T${eventData.startTime}:00`, timezone);
        const endDateTime = fromZonedTime(`${eventData.endDate}T${eventData.endTime}:00`, timezone);

        if (isNaN(startDateTime.getTime()) || isNaN(endDateTime.getTime())) {
          intentResult = {
            intent: 'create',
            confidence: 'low',
            error: 'Invalid date/time parsed from audio',
          };
        } else {
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

          intentResult = {
            intent: 'create',
            confidence,
            event,
            error: parsed.error,
            needsClarification: parsed.needsClarification,
            clarificationQuestion: parsed.clarificationQuestion,
          };
        }
      } else if (intent === 'edit') {
        intentResult = {
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
        intentResult = {
          intent: 'delete',
          confidence,
          eventReference: parsed.eventReference || undefined,
          scope: parsed.scope || 'single',
          error: parsed.error,
          needsClarification: parsed.needsClarification,
          clarificationQuestion: parsed.clarificationQuestion,
        };
      } else {
        intentResult = {
          intent: 'create',
          confidence: 'low',
          error: parsed.error || 'Unknown intent',
          needsClarification: parsed.needsClarification,
          clarificationQuestion: parsed.clarificationQuestion,
        };
      }

      return { intentResult, transcription };

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

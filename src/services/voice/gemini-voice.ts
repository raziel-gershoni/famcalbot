/**
 * Gemini Event Extraction
 * Shared prompt builder + response parser for voice and text event extraction
 * Voice: sends audio directly to Gemini for transcription + intent detection + event extraction
 * Text: sends forwarded message text for intent detection + event extraction
 */

import { getGemini, extractionConfig } from '../ai-provider';
import { isSilent } from './audio-level';
import { detectAddressedSpeech, detectSpeech, NO_SPEECH } from './speech-presence';
import { VoiceIntentResult, VoiceIntent, ParsedEvent, RecurrencePattern } from '../event-parser';
import { CalendarAssignment } from '../../types';
import { defaultCalendarFor, isFamcalId } from '../../utils/calendar-helpers';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { AI_MODEL_ID } from '../../config/ai-models';
import { addDaysToDate, localDate, nextDate, startOfLocalDay } from '../../utils/day-events';
import { readSpokenHebrewDate, resolveSpokenHebrewDate } from '../hebrew-date-resolve';

const VOICE_RETRY_CONFIG = {
  maxRetries: 1,
  baseDelayMs: 500,
} as const;

/**
 * Who a reminder can be for, as the extraction prompt names them. Each name comes as the
 * user wrote it and in English: a partner can be "דנה" to one of them and "Dana" to the other.
 */
export interface ReminderPromptContext {
  userName: string;
  userEnglishName?: string | null;
  partnerName?: string | null;
  partnerEnglishName?: string | null;
}

/**
 * Build the event extraction prompt (shared between voice and text modes)
 * With `reminders`, voice and text prompts also learn reminders (see buildReminderRules);
 * without it the prompt is exactly the one users without reminders always had.
 */
export function buildEventExtractionPrompt(
  language: string,
  calendars: CalendarAssignment[],
  timezone: string,
  mode: 'voice' | 'text' | 'image' = 'voice',
  recentEventsBlock?: string,
  reminders?: ReminderPromptContext
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
    : mode === 'image'
    ? `You are a calendar assistant. The user sent an IMAGE of an event invitation, flyer, poster, or a screenshot. Read ALL text visible in the image (OCR) — it may be in Hebrew (right-to-left), Russian, or English — and:
1. Determine whether the image describes a calendar event (intent "create") or not (intent "none").
2. Extract structured event data for the event.

IMAGE-SPECIFIC RULES:
- If the image is NOT an event (a meme, a random photo, a screenshot with no event details), return intent "none".
- Extract the ACTUAL event date and start time. If the invitation also shows an RSVP / reply-by / confirmation deadline (e.g. "אישור הגעה", "RSVP by", "просьба подтвердить до"), that is NOT the event date — never use it as the event start; you may mention it in "description".
- If the year is not printed, choose the nearest FUTURE date consistent with the current date/time below.
- Put the venue name and/or address into "location".
- CONFIDENCE: return "high" ONLY when the event date AND start time are explicitly and unambiguously printed. If the year is not printed, it is still clear - keep "high" - when the nearest future date falls later this year or within the next 2 months, unless that day and month also fell within the last 2 months. Otherwise the printed date has most likely passed already (e.g. an old flyer): return "medium". A printed year is never lowered by this rule, but a fully printed date that is already past also gets "medium". Keep the day and month as printed - never move them to fit a printed weekday - and return "medium" when the printed weekday does not fall on that date. A date printed only in the Hebrew calendar (e.g. "כ"ח בכסלו") gets "medium", and you return it as "hebrewDate" (see HEBREW DATES below) instead of converting it yourself. Return "medium" or "low" as well when you guessed the time or are unsure whether a printed date is the event date or an RSVP date. (Lower confidence routes the event to a manual confirmation card instead of auto-creating it.)
- Intent is ONLY "create" or "none" — never "edit" or "delete" for an image.`
    : `You are a calendar assistant. Parse the following forwarded text message and extract calendar event information.
The text may be conversational (e.g. "Hey, can you come to dinner at our place on Friday at 7pm?"). Look for dates, times, event names, and locations.
1. Determine the intent (create, edit, delete, or none if no event information found)
2. Extract structured event data based on the intent`;

  const prompt = `${modeInstructions}

CURRENT DATE/TIME: ${currentDateStr} at ${currentTimeStr} (timezone: ${timezone})
USER LANGUAGE: ${language}

USER'S CALENDARS:
${calendarList || '- Primary calendar (ID: primary)'}
NOTE: A calendar ID may start with "native:" — preserve the full ID verbatim in your response.
${recentEventsBlock ? `\n${recentEventsBlock}\n` : ''}

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
     * "every year", "yearly", "every birthday" (כל שנה, каждый год) → frequency: "yearly". This is the Gregorian date: leave "calendar" out.
     * By the Hebrew calendar: "every year on the Hebrew date", "Hebrew birthday" (יום הולדת עברי, כל שנה לפי התאריך העברי, на еврейскую дату, по еврейскому календарю) → frequency: "yearly", "calendar": "hebrew"
     * A "yahrzeit" (יארצייט, יום פטירה, йорцайт, годовщина смерти по еврейскому календарю) repeats the same way, every year on the Hebrew date → frequency: "yearly", "calendar": "hebrew". Keep the user's own words in the title.
     * "calendar": "hebrew" goes only with frequency "yearly". Never use it for a daily, weekly or monthly repeat.

   - HEBREW DATES: when the user says a date of the Hebrew calendar ("15 Shvat", "the 10th of Tevet", "ט״ו בשבט", "י׳ בטבת", "15 швата"), NEVER convert it to a Gregorian date yourself. Return "hebrewDate": {"day": 15, "month": "Sh'vat", "year": null} and set "startDate" and "endDate" to null; the server works out the Gregorian date.
     * "day" is a whole number from 1 to 30.
     * "month" is exactly one of: "Tishrei", "Cheshvan", "Kislev", "Tevet", "Sh'vat", "Adar", "Adar I", "Adar II", "Nisan", "Iyyar", "Sivan", "Tamuz", "Av", "Elul", whatever language the user said it in. Use "Adar I" or "Adar II" only when the user says which; otherwise "Adar".
     * "year" is the Hebrew year as a number (תשפ״ו → 5786), only when the user said one; otherwise null. The year of a person's death or birth in the Hebrew calendar is a "year"; a Gregorian year is not.
     * The time of day stays in "startTime" and "endTime" as always. With no time, "allDay": true.
     * If the user gives a Gregorian date for a Hebrew birthday or yahrzeit ("Hebrew birthday, born March 3 2019"), put it in "startDate" and leave "hebrewDate" null.

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

MULTI-EVENT EXTRACTION:
If the user clearly describes multiple distinct events or actions in one message
(e.g. "Lunch with Anna tomorrow at 1, then dentist Friday at 9 and birthday party
Saturday all day"), return them as an "intents" array of up to 10 entries. Each
entry has the same shape as the single-intent fields below. Only group multiple
events into "intents" when they are truly separate; do NOT split a single event
that just mentions multiple attendees or dates. If unsure, return a single intent.

RESPOND IN JSON FORMAT ONLY:
{${mode === 'voice' ? '\n  "transcription": "Exact text of what the user said in the audio",' : ''}
  // Multi-event (preferred when 2+ distinct events): array of intents.
  // For single events, return the top-level fields below instead and omit "intents".
  "intents": [
    {
      "intent": "create" | "edit" | "delete",
      "confidence": "high" | "medium" | "low",
      "event": { /* same shape as below */ } or null,
      "editRequest": { /* same shape as below */ } or null,
      "eventReference": { /* same shape as below */ } or null,
      "scope": "single" | "all" | "following" or null
    }
  ] or null (omit for single-event input),

  "intent": ${mode === 'voice' ? '"create" | "edit" | "delete"' : mode === 'image' ? '"create" | "none"' : '"create" | "edit" | "delete" | "none"'},
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
    "recurrence": {"frequency": "daily"/"weekly"/"monthly"/"yearly", "daysOfWeek": ["MO",...], "interval": number, "calendar": "hebrew" (only with "yearly")} or null,
    "hebrewDate": {"day": 1-30, "month": "Tishrei"/"Cheshvan"/"Kislev"/"Tevet"/"Sh'vat"/"Adar"/"Adar I"/"Adar II"/"Nisan"/"Iyyar"/"Sivan"/"Tamuz"/"Av"/"Elul", "year": Hebrew year as a number or null} or null (a Hebrew date the user said; then "startDate" and "endDate" are null)
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
    "originalDate": "YYYY-MM-DD" or null - the DATE of the event being referenced, if mentioned (NOT the new date)
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

Input audio: "יארצייט לאבא בעשרה בטבת" (Hebrew: Yahrzeit for Dad on the 10th of Tevet)
Output: {"transcription": "יארצייט לאבא בעשרה בטבת", "intent": "create", "confidence": "high", "event": {"title": "יארצייט לאבא", "startDate": null, "startTime": null, "endDate": null, "endTime": null, "allDay": true, "calendarId": "primary", "calendarName": "Primary", "hebrewDate": {"day": 10, "month": "Tevet", "year": null}, "recurrence": {"frequency": "yearly", "calendar": "hebrew"}}}

Input audio: "Hebrew birthday for Noa every year on 15 Shvat"
Output: {"transcription": "Hebrew birthday for Noa every year on 15 Shvat", "intent": "create", "confidence": "high", "event": {"title": "Noa's Hebrew birthday", "startDate": null, "startTime": null, "endDate": null, "endTime": null, "allDay": true, "calendarId": "primary", "calendarName": "Primary", "hebrewDate": {"day": 15, "month": "Sh'vat", "year": null}, "recurrence": {"frequency": "yearly", "calendar": "hebrew"}}}

Input audio: "йорцайт дедушки каждый год, он умер 3 нисана 5780 года" (Russian: Grandfather's yahrzeit every year, he died on 3 Nisan 5780)
Output: {"transcription": "йорцайт дедушки каждый год, он умер 3 нисана 5780 года", "intent": "create", "confidence": "high", "event": {"title": "Йорцайт дедушки", "startDate": null, "startTime": null, "endDate": null, "endTime": null, "allDay": true, "calendarId": "primary", "calendarName": "Primary", "hebrewDate": {"day": 3, "month": "Nisan", "year": 5780}, "recurrence": {"frequency": "yearly", "calendar": "hebrew"}}}

Input audio: "Dana's birthday every year, March 3" (the Gregorian date, so no "calendar")
Output: {"transcription": "Dana's birthday every year, March 3", "intent": "create", "confidence": "high", "event": {"title": "Dana's birthday", "startDate": "YYYY-03-03", "startTime": null, "endDate": "YYYY-03-03", "endTime": null, "allDay": true, "calendarId": "primary", "calendarName": "Primary", "recurrence": {"frequency": "yearly"}}}

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
Output: {"intent": "edit", "confidence": "high", "eventReference": {"type": "by_description", "description": "meeting", "timeHint": "tomorrow"}, "editRequest": {"newStartTime": "15:00", "newEndTime": "16:00"}}` : '') + (mode === 'image' ? `

ADDITIONAL IMAGE-MODE EXAMPLES (the actual input is the attached image; these show the expected OUTPUT):

Image: a birthday invitation reading "You're invited! Noa turns 5 — March 14 at 17:00, Gymboree Hall, Herzliya. RSVP by March 1." No year is printed, and the next March 14 is five weeks away.
Output: {"intent": "create", "confidence": "high", "event": {"title": "Noa's 5th birthday", "startDate": "YYYY-03-14", "startTime": "17:00", "endDate": "YYYY-03-14", "endTime": "19:00", "allDay": false, "location": "Gymboree Hall, Herzliya", "description": "RSVP by March 1", "calendarId": "primary", "calendarName": "Primary", "recurrence": null}}

Image: a concert poster reading "Spring Concert — April 2 at 19:30, City Hall." No year is printed, and April 2 was three weeks ago, so this is most likely an old poster.
Output: {"intent": "create", "confidence": "medium", "event": {"title": "Spring Concert", "startDate": "YYYY-04-02", "startTime": "19:30", "endDate": "YYYY-04-02", "endTime": "21:30", "allDay": false, "location": "City Hall", "calendarId": "primary", "calendarName": "Primary", "recurrence": null}}

Image: a class notice reading "Parents' evening — Thursday, November 20 at 18:00, school library." No year is printed, and the coming November 20 is a Friday, so the notice is most likely from another year.
Output: {"intent": "create", "confidence": "medium", "event": {"title": "Parents' evening", "startDate": "YYYY-11-20", "startTime": "18:00", "endDate": "YYYY-11-20", "endTime": "19:00", "allDay": false, "location": "School library", "calendarId": "primary", "calendarName": "Primary", "recurrence": null}}

Image: a wedding invitation in Hebrew with the date printed but no time.
Output: {"intent": "create", "confidence": "medium", "event": {"title": "Wedding", "startDate": "YYYY-MM-DD", "startTime": "19:00", "endDate": "YYYY-MM-DD", "endTime": "23:00", "allDay": false, "location": "...", "calendarId": "primary", "calendarName": "Primary", "recurrence": null}}

Image: a photo of a cat with no text.
Output: {"intent": "none", "confidence": "high", "error": "No event found in this image."}` : '');

  // A photo never makes a reminder, so the image prompt never learns them.
  return reminders && mode !== 'image' ? prompt + buildReminderRules(mode, reminders) : prompt;
}

/** `"דנה" (in English: "Dana")`, or just `"Dana"` when both spellings are the same. */
function spellings(name: string, englishName?: string | null): string {
  return englishName && englishName.trim().toLowerCase() !== name.trim().toLowerCase()
    ? `"${name}" (in English: "${englishName}")`
    : `"${name}"`;
}

/**
 * The reminder rules appended to the voice and text prompts for users who have reminders.
 * They teach the "kind", "forPerson" and "anchor" event fields, a reminder's single time,
 * and the phrasings that must not become events or deletes, in Hebrew, English and Russian.
 * Examples follow the mode: a voice example repeats its words as the transcription.
 */
function buildReminderRules(mode: 'voice' | 'text', people: ReminderPromptContext): string {
  const partner = people.partnerName || people.partnerEnglishName;
  const partnerInEnglish = people.partnerEnglishName || partner;
  const example = (input: string, translation: string, output: string) => (mode === 'voice'
    ? `Input audio: "${input}"${translation ? ` (${translation})` : ''}\nOutput: {"transcription": "${input}", ${output}}`
    : `Input text: "${input}"${translation ? ` (${translation})` : ''}\nOutput: {${output}}`);
  const reminder = (fields: string) => `"intent": "create", "confidence": "high", "event": {"kind": "reminder", ${fields}}`;

  const peopleRules = partner
    ? `- The user: ${spellings(people.userName, people.userEnglishName)}
- The user's partner: ${spellings(partner, people.partnerEnglishName)}. Also called "my wife", "my husband", "my partner", "אשתי", "בעלי", "בן הזוג שלי", "בת הזוג שלי", "моя жена", "мой муж".`
    : `- The user: ${spellings(people.userName, people.userEnglishName)}
- The user has no linked partner, so every reminder is for the user.`;

  const whoRules = partner
    ? `2. WHO IT IS FOR - every reminder has "forPerson":
   - "partner" when it is for the user's partner, by name or by role: "remind ${partnerInEnglish} to...", "remind my wife to...", "תזכיר לבעלי...", "תזכירי לאשתי...", "напомни мужу...", "напомни жене...".
   - "both" when it is for the user AND the user's partner together: "remind us to...", "remind both of us to...", "remind me and ${partnerInEnglish} to...", "תזכיר לנו...", "תזכיר לשנינו...", "תזכיר לי ול${partner}...", "напомни нам...", "напомни нам обоим...", "напомни мне и <имя партнёра в дательном падеже: «Дане», «Маше»>...".
   - "self" for everything else: "remind me", and a child or anyone else. Keep that person's name in the title: "Remind Noa to take her medicine" → title "Noa: take her medicine", "forPerson": "self".`
    : `2. WHO IT IS FOR - "forPerson" is always "self". Keep anyone else's name in the title: "Remind Noa to take her medicine" → title "Noa: take her medicine".`;

  const forwardedRule = mode === 'text'
    ? `\n\n8. FORWARDED MESSAGES - in a message the user forwarded, "me", "I", "לי" and "мне" mean the user who forwarded it, never whoever wrote it.`
    : '';

  const examples = [
    example('Remind me to call the plumber Thursday at 10', '',
      reminder('"forPerson": "self", "title": "Call the plumber", "startDate": "YYYY-MM-DD", "startTime": "10:00", "endDate": null, "endTime": null, "allDay": false, "recurrence": null, "anchor": null')),
    partner
      ? example(`Remind ${partnerInEnglish} to buy milk tomorrow`, '',
        reminder('"forPerson": "partner", "title": "Buy milk", "startDate": "YYYY-MM-DD", "startTime": null, "endDate": null, "endTime": null, "allDay": true, "recurrence": null, "anchor": null'))
      : example('Remind me to buy milk tomorrow', '',
        reminder('"forPerson": "self", "title": "Buy milk", "startDate": "YYYY-MM-DD", "startTime": null, "endDate": null, "endTime": null, "allDay": true, "recurrence": null, "anchor": null')),
    example('תזכיר לי בערב להתקשר לאמא', 'Hebrew: Remind me in the evening to call mom',
      reminder('"forPerson": "self", "title": "להתקשר לאמא", "startDate": "YYYY-MM-DD", "startTime": "20:00", "endDate": null, "endTime": null, "allDay": false, "recurrence": null, "anchor": null')),
    ...(partner
      ? [example('напомни мужу забрать детей в четыре', 'Russian: Remind my husband to pick up the kids at four',
        reminder('"forPerson": "partner", "title": "Забрать детей", "startDate": "YYYY-MM-DD", "startTime": "16:00", "endDate": null, "endTime": null, "allDay": false, "recurrence": null, "anchor": null'))]
      : []),
    ...(partner
      ? [
        example('Remind us to book the flights tomorrow', '',
          reminder('"forPerson": "both", "title": "Book the flights", "startDate": "YYYY-MM-DD", "startTime": null, "endDate": null, "endTime": null, "allDay": true, "recurrence": null, "anchor": null')),
        example('תזכיר לשנינו לשלם את חשבון החשמל ביום חמישי בשמונה', 'Hebrew: Remind both of us to pay the electricity bill on Thursday at eight',
          reminder('"forPerson": "both", "title": "לשלם את חשבון החשמל", "startDate": "YYYY-MM-DD", "startTime": "20:00", "endDate": null, "endTime": null, "allDay": false, "recurrence": null, "anchor": null')),
        example('напомни нам обоим про родительское собрание в шесть', 'Russian: Remind both of us about the parents meeting at six',
          reminder('"forPerson": "both", "title": "Родительское собрание", "startDate": "YYYY-MM-DD", "startTime": "18:00", "endDate": null, "endTime": null, "allDay": false, "recurrence": null, "anchor": null')),
      ]
      : []),
    example('напомни через 20 минут выключить духовку', 'Russian: Remind me in 20 minutes to turn off the oven; said at 18:40',
      reminder('"forPerson": "self", "title": "Выключить духовку", "startDate": "YYYY-MM-DD", "startTime": "19:00", "endDate": null, "endTime": null, "allDay": false, "recurrence": null, "anchor": null')),
    example('Remind me every Sunday at 8 to take out the trash', '',
      reminder('"forPerson": "self", "title": "Take out the trash", "startDate": "YYYY-MM-DD", "startTime": "08:00", "endDate": null, "endTime": null, "allDay": false, "recurrence": {"frequency": "weekly", "daysOfWeek": ["SU"]}, "anchor": null')),
    example('Remind me an hour before the dentist to bring the forms', '',
      reminder('"forPerson": "self", "title": "Bring the forms", "startDate": null, "startTime": null, "endDate": null, "endTime": null, "allDay": false, "recurrence": null, "anchor": {"description": "dentist", "offsetMinutes": -60}')),
    example('אל תשכח לשלם את חשבון החשמל', "Hebrew: Don't forget to pay the electricity bill",
      reminder('"forPerson": "self", "title": "לשלם את חשבון החשמל", "startDate": "YYYY-MM-DD", "startTime": null, "endDate": null, "endTime": null, "allDay": true, "recurrence": null, "anchor": null')),
    example('Dentist Thursday at 10', '',
      '"intent": "create", "confidence": "high", "event": {"kind": "event", "title": "Dentist", "startDate": "YYYY-MM-DD", "startTime": "10:00", "endDate": "YYYY-MM-DD", "endTime": "11:00", "allDay": false, "calendarId": "primary", "calendarName": "Primary", "recurrence": null}'),
    example('Move the plumber reminder to 5pm', '',
      '"intent": "edit", "confidence": "high", "eventReference": {"type": "by_description", "description": "plumber"}, "editRequest": {"newStartTime": "17:00"}'),
    example('Stop reminding me about the vitamins', '',
      '"intent": "delete", "confidence": "high", "scope": "all", "eventReference": {"type": "by_description", "description": "vitamins"}'),
    example('סיימתי', "Hebrew: I'm done",
      '"intent": "none", "confidence": "high", "error": "The user reported a finished task; there is nothing to change."'),
  ];

  return `

REMINDERS:
The user can also ask FamCal to remind someone of something. A reminder is a calendar item with a single moment and no duration; at that moment FamCal sends the person a reminder message. These rules come on top of the rules above and win wherever they disagree.

PEOPLE:
${peopleRules}

1. KIND - every "event" has "kind":
   - "reminder" ONLY when the user explicitly asks to be reminded, or not to forget something:
     * English: "remind me", "remind us", "remind <name>", "set a reminder", "reminder to", "don't forget to"
     * Hebrew: "תזכיר לי", "תזכירי לי", "תזכיר ל<name>", "תזכורת", "להזכיר", "אל תשכח", "אל תשכחי"
     * Russian: "напомни", "напомните", "напоминай", "напоминать", "напоминание", "не забудь", "не забыть"
   - "event" for everything else. An appointment stays an event: "Dentist Thursday at 10" is an event.
   - "Don't forget - <a meeting, class or party with its own time and place>" announces an event, so it stays an event. "Don't forget to <do something>" is a reminder.
   - The "forget" in "don't forget", "אל תשכח" or "не забудь" is never the DELETE keyword.

${whoRules}

3. TITLE - the bare task, in the language the user used: "Call the plumber", "להתקשר לאינסטלטור", "Позвонить сантехнику". Never "Remind <name> to...", "Reminder: ...", "תזכורת ל...", "Напоминание: ...".

4. TIME - a reminder has a start and nothing else:
   - Give "startDate", and "startTime" when there is a time. "endDate" and "endTime" are always null.
   - A date with no time: "allDay": true and no "startTime".
   - No date and no time: today's date, "allDay": true.
   - Parts of the day: morning, בבוקר, утром → 09:00. Noon, בצהריים, в обед, в полдень → 12:00. Afternoon, אחר הצהריים, после обеда → 16:00. Evening, tonight, בערב, הערב, вечером, сегодня вечером → 20:00.
   - An hour with no date and no part of the day ("at 5", "בחמש", "в пять") is the next time the clock shows it: said at 14:00, "at 5" is 17:00 today; said at 21:00, "at 8" is 08:00 tomorrow. A full time that has already passed today ("at 13:00" said at 15:00) is tomorrow.
   - "In 20 minutes", "בעוד חצי שעה", "через 20 минут": the CURRENT DATE/TIME above plus that much, as "startDate" and "startTime".
   - Repeating reminders use "recurrence" as events do, with "startDate" the first time: "every Sunday at 8" → weekly, "daysOfWeek": ["SU"], "startTime": "08:00"; "every morning" → daily at 09:00.
   - A Hebrew-calendar date ("every year on 15 Shvat", "ביום ט״ו בשבט", "15 швата") is returned as "hebrewDate" with "startDate" null, exactly as in HEBREW DATES above; the server finds the day, so it is never "today".
   - Leave out "calendarId" and "calendarName": FamCal keeps a reminder on the user's own calendar, whoever it is for.

5. RELATIVE TO ANOTHER EVENT - "an hour before the dentist", "שעה לפני רופא השיניים", "за час до стоматолога":
   - Give "anchor": {"description": the words naming that event, "offsetMinutes": minutes from that event's start, negative for before}. Leave "startDate" and "startTime" null: FamCal finds the event and works out the time.
   - "An hour before" → -60. "Half an hour after" → 30. "The day before" → -1440. "On the day of" → 0.

6. CHANGING A REMINDER:
   - Moving a reminder ("move the reminder to 5", "תזיז את התזכורת לחמש", "перенеси напоминание на пять") sets "newStartDate" and/or "newStartTime" (or "newAllDay") only. "newEndDate" and "newEndTime" stay null: a reminder has one time, so never add an hour.
   - "Stop reminding me to...", "תפסיק להזכיר לי...", "хватит напоминать..." → intent "delete", "scope": "all".
   - "Skip today's reminder", "תדלג על התזכורת של היום", "пропусти сегодняшнее напоминание" → intent "delete", "scope": "single", "eventReference": {"type": "by_description", "description": <the reminder's title>, "timeHint": "today"}.

7. DONE - "I did it", "done", "I already called", "סיימתי", "עשיתי את זה", "כבר התקשרתי", "сделал", "сделала", "готово" report a finished task: intent "none", with nothing to create, edit or delete. "none" is allowed here in every mode.${forwardedRule}

REMINDER FIELDS (inside "event", and inside the "event" of each "intents" entry):
  "kind": "event" | "reminder",
  "forPerson": "self" | "partner" | "both" (reminders only),
  "anchor": {"description": "dentist", "offsetMinutes": -60} or null (reminders only)

REMINDER EXAMPLES:

${examples.join('\n\n')}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Multi-event support (PR 11): if Gemini returned `intents` as an array of 2+
 * entries, split each one through parseGeminiEventResponse. Otherwise return a
 * single-element array containing the parsed primary intent. Callers that
 * always expect a single intent can read `[0]`.
 *
 * Caps at 10 entries per the locked product decision.
 * `remindersOn` and `now` as in parseGeminiEventResponse.
 */
export function extractIntents(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw model JSON, read field by field
  parsed: any,
  calendars: CalendarAssignment[],
  timezone: string,
  remindersOn = false,
  now: Date = new Date()
): VoiceIntentResult[] {
  if (Array.isArray(parsed.intents) && parsed.intents.length > 1) {
    const capped = parsed.intents.slice(0, 10);
    return capped.map((it: unknown) =>
      parseGeminiEventResponse(
        // Each intents[i] entry is a sibling shape — splice it onto the top-level
        // shape parseGeminiEventResponse expects.
        { ...(it as object), transcription: parsed.transcription },
        calendars,
        timezone,
        remindersOn,
        now
      )
    );
  }
  return [parseGeminiEventResponse(parsed, calendars, timezone, remindersOn, now)];
}

/**
 * When an extracted event starts and ends in `timezone`. An all-day event starts at the
 * first instant of its first day: where daylight saving starts at midnight (Chile,
 * Lebanon, Egypt) 00:00 does not exist and resolves to 23:00 the day before, which dated
 * the event a day early. It ends at 23:59 on its last day whatever end time the model
 * read: the native calendar counts an all-day event's days from its length, so a camp
 * ending at an 11:00 pickup lost its last day there while Google kept it.
 * An end date that is not yyyy-MM-dd is a slip of the model's, mostly after a 20:00 start
 * ("20:26-10-23": the year's "20" took the hour's colon), and that slip is read back as the
 * date it was. For any other, the start and end time are still right, so the event ends on
 * its start date, as with no end date at all, or on the next day when that would end it
 * before its start. An end time equal to the start time stays a zero-length event.
 * Any other unreadable date or time gives an Invalid Date.
 */
export function buildEventTimes(
  startDate: string,
  startTime: string | undefined,
  endDate: string | undefined,
  endTime: string | undefined,
  allDay: boolean,
  timezone: string
): { start: Date; end: Date } {
  const isDate = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d);
  // "20:26-10-25" back to "2026-10-25"
  const recovered = endDate && !isDate(endDate) ? endDate.replace(/^(\d{2}):(\d{2})-/, '$1$2-') : endDate;
  const garbledEnd = !!recovered && !isDate(recovered);
  const lastDate = recovered && !garbledEnd ? recovered : startDate;
  if (!allDay) {
    const start = fromZonedTime(`${startDate}T${startTime}:00`, timezone);
    const end = fromZonedTime(`${lastDate}T${endTime}:00`, timezone);
    return {
      start,
      end: garbledEnd && end.getTime() < start.getTime() ? fromZonedTime(`${nextDate(startDate)}T${endTime}:00`, timezone) : end,
    };
  }
  const midnight = fromZonedTime(`${startDate}T00:00:00`, timezone);
  return {
    start: isNaN(midnight.getTime()) ? midnight : startOfLocalDay(startDate, timezone),
    end: fromZonedTime(`${lastDate}T23:59:00`, timezone),
  };
}

/**
 * When a reminder is due in `timezone`. A reminder is one moment, so callers end it where it
 * starts. With a time it is that moment. A date with no time is all day, starting at the
 * first instant of that day as an all-day event does (buildEventTimes) but with no length,
 * where an event's 23:59 end would give it one. No date at all means today.
 * An unreadable date or time gives an Invalid Date.
 */
export function buildReminderTimes(
  startDate: string | undefined,
  startTime: string | undefined,
  allDay: boolean,
  timezone: string,
  now: Date = new Date()
): { start: Date; allDay: boolean } {
  const date = startDate || formatInTimeZone(now, timezone, 'yyyy-MM-dd');
  const dateOnly = allDay || !startTime;
  const { start } = buildEventTimes(date, startTime, undefined, startTime, dateOnly, timezone);
  return { start, allDay: dateOnly };
}

/** The recurrence and the start the model's event reads as (hebrew-repeats spec §5). */
interface ReadRepeat {
  recurrence?: RecurrencePattern;
  /** The start day: the Hebrew date resolved on the server when the user spoke one, else the model's own. */
  startDate?: string;
  /** The end day, moved with the start when the Hebrew date set it. */
  endDate?: string;
}

/** The days from one 'yyyy-MM-dd' to another, or null when either is not one. */
function daysBetweenDates(from: unknown, to: unknown): number | null {
  const isDay = (d: unknown): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
  if (!isDay(from) || !isDay(to)) return null;
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * The model's `recurrence` and `hebrewDate` for one event.
 *
 * A Hebrew date the user spoke is resolved here, with hebcal, never by the model: the given
 * year, or the next occurrence on or after today in `timezone`. It sets the start day (and moves
 * the end day with it, or to the next day for a timed event that ends before it starts). One that cannot be read or does not exist is logged and ignored, so the
 * model's own startDate, if it gave one, stands.
 *
 * `calendar: 'hebrew'` is kept only with frequency 'yearly'; the rest is dropped with a log line
 * and the repeat stays what it was. A `hebrewKind` is dropped with a log line wherever it comes:
 * there is one Hebrew repeat, every year on the Hebrew date (a yahrzeit's too), so a kind the
 * model still names changes nothing. An ordinary repeat is returned as the model wrote it.
 */
export function readRepeat(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw model JSON, read field by field
  eventData: any,
  timezone: string,
  now: Date
): ReadRepeat {
  let startDate: string | undefined = eventData.startDate || undefined;
  let endDate: string | undefined = eventData.endDate || undefined;

  if (eventData.hebrewDate !== undefined && eventData.hebrewDate !== null) {
    const read = readSpokenHebrewDate(eventData.hebrewDate);
    for (const problem of read.problems) console.warn(`[Gemini] ${problem}`);
    const resolved = read.date ? resolveSpokenHebrewDate(read.date, localDate(now, timezone)) : null;
    if (read.date && !resolved) {
      console.warn(`[Gemini] hebrewDate ${JSON.stringify(read.date)} has no such day (or none in the next 20 years); ignored`);
    }
    if (resolved) {
      const shift = daysBetweenDates(eventData.startDate, eventData.endDate);
      endDate = shift !== null && shift > 0 ? addDaysToDate(resolved, shift) : undefined;
      // The model nulls both days for a Hebrew date, so a timed event that runs past midnight
      // ("22:00 to 01:00") has no span to move: it ends the day after the resolved start
      const clock = /^\d{2}:\d{2}$/;
      if (!endDate && !eventData.allDay && clock.test(eventData.startTime ?? '') && clock.test(eventData.endTime ?? '') && eventData.endTime < eventData.startTime) {
        endDate = nextDate(resolved);
      }
      startDate = resolved;
    }
  }

  const raw = eventData.recurrence;
  if (raw?.hebrewKind != null) {
    console.warn(`[Gemini] recurrence.hebrewKind ${JSON.stringify(raw.hebrewKind)} is not read (one Hebrew repeat, every year on the Hebrew date); dropped`);
  }
  if (!raw?.frequency) {
    if (raw?.calendar) console.warn(`[Gemini] recurrence has calendar but no frequency; dropped: ${JSON.stringify(raw)}`);
    return { startDate, endDate };
  }
  // An ordinary repeat is the model's object, untouched
  if (!('calendar' in raw) && !('hebrewKind' in raw)) return { recurrence: raw, startDate, endDate };

  const { frequency, daysOfWeek, interval, until, count } = raw;
  const ends = {
    ...(interval != null ? { interval } : {}),
    ...(until != null ? { until } : {}),
    ...(count != null ? { count } : {}),
  };
  const gregorian: RecurrencePattern = { frequency, ...(daysOfWeek != null ? { daysOfWeek } : {}), ...ends };
  if (raw.calendar !== 'hebrew') {
    if (raw.calendar != null) console.warn(`[Gemini] recurrence.calendar ${JSON.stringify(raw.calendar)} is not "hebrew"; dropped`);
    return { recurrence: gregorian, startDate, endDate };
  }
  if (frequency !== 'yearly') {
    console.warn(`[Gemini] recurrence.calendar "hebrew" needs frequency "yearly", got ${JSON.stringify(frequency)}; the Hebrew calendar is dropped`);
    return { recurrence: gregorian, startDate, endDate };
  }
  // A Hebrew yearly rule has no BY parts, so daysOfWeek is left out
  return { recurrence: { frequency, ...ends, calendar: 'hebrew' }, startDate, endDate };
}

/** The model's anchor ("an hour before the dentist"), or undefined when it is missing or unreadable. */
function readAnchor(raw: unknown): ParsedEvent['anchor'] {
  if (!raw || typeof raw !== 'object') return undefined;
  const { description, offsetMinutes } = raw as { description?: unknown; offsetMinutes?: unknown };
  if (typeof description !== 'string' || !description.trim()) return undefined;
  const offset = Number(offsetMinutes ?? 0);
  return Number.isFinite(offset) ? { description: description.trim(), offsetMinutes: Math.round(offset) } : undefined;
}

/**
 * A reminder the model created. It ends where it starts (see buildReminderTimes). An
 * anchored one has no time of its own yet: both times stay Invalid Dates until resolution
 * finds the anchor event. It goes on the user's own calendar whatever the model picked, so
 * the model's pick is neither matched nor warned about.
 */
function parseReminderCreate(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw model JSON, read field by field
  parsed: any,
  calendars: CalendarAssignment[],
  timezone: string,
  now: Date
): VoiceIntentResult {
  const eventData = parsed.event;
  const confidence = parsed.confidence || 'medium';
  const anchor = readAnchor(eventData.anchor);
  const repeat = readRepeat(eventData, timezone, now);
  if (!anchor && eventData.anchor && !repeat.startDate) {
    return { intent: 'create', confidence: 'low', error: 'Missing date/time fields' };
  }
  // A Hebrew date the user spoke that did not resolve has no day: refuse it as an event does,
  // instead of letting the reminder default to today and repeat from today's Hebrew date
  if (!anchor && !repeat.startDate && eventData.hebrewDate != null) {
    console.warn(`[Gemini] reminder has a hebrewDate that did not resolve to a day; refused: ${JSON.stringify(eventData.hebrewDate)}`);
    return { intent: 'create', confidence: 'low', error: 'Missing date/time fields' };
  }

  const { start, allDay } = anchor
    ? { start: new Date(NaN), allDay: false }
    : buildReminderTimes(repeat.startDate, eventData.startTime, !!eventData.allDay, timezone, now);
  if (!anchor && isNaN(start.getTime())) {
    return { intent: 'create', confidence: 'low', error: 'Invalid date/time parsed' };
  }

  // Reminders live in FamCal ("Google as a connection" spec §3): never a Google calendar. The
  // FamCal primary is a placeholder; resolution and the create site pin it to the creator's main.
  const own = calendars.find(c => isFamcalId(c.calendarId) && c.labels.includes('primary'));
  const event: ParsedEvent = {
    title: eventData.title,
    startTime: start,
    endTime: new Date(start.getTime()),
    location: eventData.location || undefined,
    description: eventData.description || undefined,
    allDay,
    calendarId: own?.calendarId,
    calendarName: own?.name,
    confidence,
    recurrence: repeat.recurrence,
    kind: 'reminder',
    forPerson: eventData.forPerson === 'partner' || eventData.forPerson === 'both' ? eventData.forPerson : 'self',
    ...(anchor ? { anchor } : {}),
  };

  return {
    intent: 'create',
    confidence,
    event,
    error: parsed.error,
    needsClarification: parsed.needsClarification,
    clarificationQuestion: parsed.clarificationQuestion,
  };
}

/**
 * Parse Gemini JSON response into VoiceIntentResult
 * Shared between voice and text processing pipelines
 * `remindersOn`: the prompt had the reminder rules, so an event of kind "reminder" is read
 * as one. Off, every create is read as an event, exactly as before reminders existed.
 */
export function parseGeminiEventResponse(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw model JSON, validated field by field below
  parsed: any,
  calendars: CalendarAssignment[],
  timezone: string,
  remindersOn = false,
  now: Date = new Date()
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
    if (remindersOn && parsed.event.kind === 'reminder') {
      return parseReminderCreate(parsed, calendars, timezone, now);
    }
    const eventData = parsed.event;

    // Validate calendarId against user's actual calendars
    const geminiCalId = eventData.calendarId || '';
    let matchedCalendar = calendars.find(c => c.calendarId === geminiCalId);
    // Partial match: Gemini may strip the @group.calendar.google.com suffix.
    // Restricted to non-native IDs because a truncated `native:abc` could
    // accidentally match a longer `native:abc123` cuid.
    if (!matchedCalendar && geminiCalId && !geminiCalId.startsWith('native:')) {
      matchedCalendar = calendars.find(c => !c.calendarId.startsWith('native:') && c.calendarId.startsWith(geminiCalId));
    }
    // Name match: try matching by calendar name (case-insensitive)
    if (!matchedCalendar && (geminiCalId || eventData.calendarName)) {
      const nameToMatch = (eventData.calendarName || geminiCalId).toLowerCase();
      matchedCalendar = calendars.find(c => c.name?.toLowerCase() === nameToMatch);
    }
    // No match: the default of the union (spec §3), not the list's first row, which is a FamCal
    // one for everyone now. With no default the event carries no calendar, and the create site
    // puts it on the main FamCal calendar (createCalendarFor).
    if (!matchedCalendar) {
      const defaultId = defaultCalendarFor(calendars);
      matchedCalendar = defaultId ? calendars.find(c => c.calendarId === defaultId) : undefined;
      console.warn(`[Gemini] Could not match calendarId "${geminiCalId}" / name "${eventData.calendarName}" to user calendars, using the default "${matchedCalendar?.calendarId ?? 'the FamCal main'}"`);
    }
    const resolvedCalendarId = matchedCalendar?.calendarId;
    const resolvedCalendarName = matchedCalendar?.name;

    // A Hebrew date the user spoke becomes the start day here, on the server
    const repeat = readRepeat(eventData, timezone, now);

    // All-day events may not have startTime/endTime from Gemini
    if (!repeat.startDate || (!eventData.allDay && (!eventData.startTime || !eventData.endTime))) {
      return {
        intent: 'create',
        confidence: 'low',
        error: 'Missing date/time fields',
      };
    }

    const { start: startDateTime, end: endDateTime } = buildEventTimes(
      repeat.startDate, eventData.startTime, repeat.endDate, eventData.endTime, !!eventData.allDay, timezone
    );

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
      recurrence: repeat.recurrence,
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
  timezone: string,
  recentEventsBlock?: string,
  // PR 10 polish: optional prior-attempt audio for retry-mode parses. Sent
  // as a SEPARATE inlineData part so Gemini decodes both OGG containers
  // independently — byte-concat would produce an invalid OGG stream.
  priorAudioBuffer?: Buffer,
  // Given only for users who have reminders: the prompt learns them and the parser reads them.
  reminders?: ReminderPromptContext
): Promise<{ intentResult: VoiceIntentResult; intentResults?: VoiceIntentResult[]; transcription: string; metrics: VoiceProcessingMetrics }> {
  const startTime = Date.now();
  let lastError: Error | null = null;

  // Speech presence. Without these gates, non-speech audio - silence, a pocket
  // recording, music - came back as a high-confidence create, edit or delete in every
  // test run, on both 3.7 and 3.8. See ./speech-presence for why there are two.
  const noSpeechResult = (reason: string) => {
    console.log(`[Voice Gemini] No speech detected (${reason}); no calendar action taken`);
    const intentResult: VoiceIntentResult = { intent: 'create', confidence: 'low', error: NO_SPEECH };
    return {
      intentResult,
      intentResults: [intentResult],
      transcription: '',
      metrics: { model: AI_MODEL_ID, inputTokens: 0, outputTokens: 0, durationMs: Date.now() - startTime },
    };
  };

  // Quiet audio first: the model invents words for near-silence however it is asked,
  // and catching it here costs no model call at all.
  if (isSilent(audioBuffer)) {
    return noSpeechResult('near-silent audio');
  }

  // Loud non-speech the model judges correctly on its own but not inside the
  // extraction prompt, so ask separately and in parallel - extraction is slower, so
  // this adds no latency in the usual case. Only the newest clip is checked: in
  // retry mode a silent follow-up is not a clarification.
  const speechCheck = detectSpeech(audioBuffer, AI_MODEL_ID);
  let speechVerdict: boolean | undefined;
  void speechCheck.then(v => { speechVerdict = v; });
  // TV or radio is speech, so it passes the check above; whether it was meant for the
  // device is asked the same way. Never rejects, so it can sit unawaited.
  const addressedCheck = detectAddressedSpeech(audioBuffer, AI_MODEL_ID);

  for (let attempt = 0; attempt <= VOICE_RETRY_CONFIG.maxRetries; attempt++) {
    try {
      const retryNote = priorAudioBuffer
        ? '\n\nNOTE: The next attached audio is a PRIOR attempt that failed to parse. The audio AFTER it is the user clarifying or correcting. Treat the second audio as the authoritative input and use the first only if it adds context.'
        : '';
      const promptText = buildEventExtractionPrompt(language, calendars, timezone, 'voice', recentEventsBlock, reminders) + retryNote;

      const audioParts: Array<{ inlineData: { mimeType: string; data: string } }> = [];
      if (priorAudioBuffer) {
        audioParts.push({ inlineData: { mimeType: 'audio/ogg', data: priorAudioBuffer.toString('base64') } });
      }
      audioParts.push({ inlineData: { mimeType: 'audio/ogg', data: audioBuffer.toString('base64') } });

      const response = await getGemini().models.generateContent({
        model: AI_MODEL_ID,
        ...extractionConfig(AI_MODEL_ID),
        contents: [
          {
            role: 'user',
            parts: [{ text: promptText }, ...audioParts],
          },
        ],
      });

      const duration = Date.now() - startTime;
      const inputTokens = response.usageMetadata?.promptTokenCount || 0;
      const outputTokens = response.usageMetadata?.candidatesTokenCount || 0;

      console.log(`[Voice Gemini] Response in ${duration}ms, model: ${AI_MODEL_ID}, tokens: ${inputTokens}in/${outputTokens}out, attempt: ${attempt + 1}`);

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

      const intentResults = extractIntents(parsed, calendars, timezone, !!reminders);
      const intentResult = intentResults[0];

      // The extraction prompt fabricates commands for non-speech, so its answer only
      // counts if the context-free check agrees there was speech at all.
      if (!(await speechCheck)) return noSpeechResult('speech gate');

      const metrics = { model: AI_MODEL_ID, inputTokens, outputTokens, durationMs: duration };

      // A TV promo naming a day and a time came back as a create, at "medium" or "high".
      // On a NO the parse is kept, whatever its confidence, and every intent is flagged
      // so it never auto-creates. Nothing is dropped: a forwarded voice note (a spouse's,
      // a teacher's) is real speech not addressed to the device, and losing a real
      // command is worse than showing a card for TV. A wrong NO costs one tap, and
      // background speech can never create or change anything unseen.
      const actionable = intentResults.filter(r => r.event || r.eventReference);
      if (actionable.length > 0 && !(await addressedCheck)) {
        console.log(`[Voice Gemini] Speech not addressed to the device; ${actionable.length} action(s) held for confirmation`);
        const flagged = intentResults.map(r => ({ ...r, notAddressed: true as const }));
        return { intentResult: flagged[0], intentResults: flagged, transcription, metrics };
      }

      return { intentResult, intentResults, transcription, metrics };

    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // A failed parse of audio already judged speechless is not worth a retry.
      if (speechVerdict === false) return noSpeechResult('speech gate');

      if (attempt < VOICE_RETRY_CONFIG.maxRetries) {
        const delay = VOICE_RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt);
        console.warn(`[Voice Gemini] Error (attempt ${attempt + 1}/${VOICE_RETRY_CONFIG.maxRetries + 1}), retrying in ${delay}ms:`, error);
        await sleep(delay);
      }
    }
  }

  // Every attempt failed. If there was no speech, say so rather than report an
  // outage - the handler's error path would also stash this clip and merge it into
  // the user's next message.
  if (!(await speechCheck)) return noSpeechResult('speech gate');

  console.error(`[Voice Gemini] Failed after ${VOICE_RETRY_CONFIG.maxRetries + 1} attempts:`, lastError);
  throw new Error(`Voice processing failed: ${lastError?.message || 'Unknown error'}`);
}

/**
 * What the voice_not_addressed activity records when the addressed check said NO to a
 * parse that would have acted: the highest confidence among its actions and how many
 * there were. Every intent of such a parse is flagged notAddressed. Null when the check
 * said YES or failed, or there was nothing to act on. Recorded so the rate of wrong NOs
 * on real commands can be read in production.
 */
export function notAddressedTelemetry(
  results: VoiceIntentResult[]
): { maxConfidence: VoiceIntentResult['confidence']; intentCount: number } | null {
  const held = results.filter(r => r.notAddressed && (r.event || r.eventReference));
  if (held.length === 0) return null;
  const rank = { low: 0, medium: 1, high: 2 } as const;
  const maxConfidence = held.reduce<VoiceIntentResult['confidence']>(
    (max, r) => (rank[r.confidence] > rank[max] ? r.confidence : max),
    'low'
  );
  return { maxConfidence, intentCount: held.length };
}

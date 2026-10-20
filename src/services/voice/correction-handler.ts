/**
 * Event correction handler
 * Processes text or voice replies to pending event confirmations
 * Sends correction to Gemini and updates the confirmation message in-place
 */

import { getGemini, extractionConfig } from '../ai-provider';
import { ParsedEvent } from '../event-parser';
import { getMessagingService } from '../telegram';
import { MessageFormat } from '../messaging/types';
import { resolveUserTimezone } from '../../lib/timezone';
import { getBotMessages } from '../../lib/bot-messages';
import { trackActivityAsync, addBreadcrumb } from '../analytics-service';
import { captureError } from '../../lib/error-capture';
import { AI_MODEL_ID } from '../../config/ai-models';
import { formatInTimeZone } from 'date-fns-tz';
import { getPendingEvent, removePendingEvent, showEventConfirmation } from './confirmations';
import { buildEventTimes, readRepeat } from './gemini-voice';
import { normalizeReminderTimes } from '../native-calendar/event-store';
import { redis } from '../../utils/redis';
import { REDIS_KEYS } from '../../config/redis-keys';
import { startTypingInterval } from '../telegram/command-pipeline';

type CorrectionInput = { text: string } | { audioBuffer: Buffer; language: string };

/**
 * Build the correction prompt with current event context
 */
function buildCorrectionPrompt(
  event: ParsedEvent,
  calendars: { calendarId: string; name: string; labels: string[] }[],
  timezone: string
): string {
  const calendarList = calendars.map(c =>
    `- "${c.name || c.calendarId}" (ID: ${c.calendarId}, labels: ${c.labels.join(', ')})`
  ).join('\n');

  const startDateStr = formatInTimeZone(event.startTime, timezone, 'yyyy-MM-dd');
  const startTimeStr = formatInTimeZone(event.startTime, timezone, 'HH:mm');
  const endDateStr = formatInTimeZone(event.endTime, timezone, 'yyyy-MM-dd');
  const endTimeStr = formatInTimeZone(event.endTime, timezone, 'HH:mm');
  // A reminder has one time: without this the model gives it the usual hour
  const reminderNote = event.kind === 'reminder'
    ? '\nThis is a REMINDER: it has one time and no end. Return endDate and endTime equal to startDate and startTime.\n'
    : '';

  // The model reads a Hebrew date and the server converts it (hebrew-repeats spec §5); a repeat by the Hebrew date keeps its rule
  const hebrewNote = event.recurrence?.calendar === 'hebrew'
    ? `\nThis event repeats every year by the Hebrew calendar (${event.recurrence.hebrewKind === 'yahrzeit' ? 'a yahrzeit' : 'a Hebrew birthday or anniversary'}). Its start date is the day of the first occurrence. Do not change how it repeats.\n`
    : '';

  return `You are correcting a calendar event based on user feedback.
The user will provide their correction as text or voice.

CURRENT EVENT:
- Title: ${event.title}
- Start date: ${startDateStr}
- Start time: ${startTimeStr}
- End date: ${endDateStr}
- End time: ${endTimeStr}
- Location: ${event.location || 'none'}
- Calendar: ${event.calendarName || 'Primary'} (ID: ${event.calendarId || 'primary'})
- All day: ${event.allDay}
${reminderNote}${hebrewNote}
USER'S CALENDARS:
${calendarList || '- Primary calendar (ID: primary)'}

TIMEZONE: ${timezone}

Apply the user's correction and return the updated event in JSON format.
Only change the fields the user mentioned. Keep everything else exactly as-is.
HEBREW DATES: when the user gives a date of the Hebrew calendar ("11 Tevet", "the 10th of Tevet 5770", "י״א בטבת", "15 швата"), NEVER convert it to a Gregorian date yourself. Return "hebrewDate" with the day, the month and the Hebrew year only if the user said one, and set "startDate" and "endDate" to null; the server works out the Gregorian date. Otherwise "hebrewDate" is null. The month is one of Tishrei, Cheshvan, Kislev, Tevet, Sh'vat, Adar, Adar I, Adar II, Nisan, Iyyar, Sivan, Tamuz, Av, Elul ("Adar" when the user does not say which in a leap year).

RESPOND IN JSON FORMAT ONLY:
{
  "title": "...",
  "startDate": "YYYY-MM-DD",
  "startTime": "HH:MM",
  "endDate": "YYYY-MM-DD",
  "endTime": "HH:MM",
  "allDay": false,
  "hebrewDate": {"day": 1-30, "month": "Tevet", "year": Hebrew year as a number or null} or null,
  "location": "..." or null,
  "calendarId": "..." or "primary",
  "calendarName": "..." or "Primary"
}`;
}

/**
 * The repeat after a correction. A Hebrew date the user gave re-reads the rule (a given year drops
 * the "no year was given" note). Otherwise the rule stays, and the note stays only while the start
 * day does: a new day is the date the user chose, not "the next occurrence".
 */
function correctedRecurrence(
  event: ParsedEvent,
  newStart: Date,
  hebrew: ReturnType<typeof readRepeat> | null,
  timezone: string
): ParsedEvent['recurrence'] {
  if (hebrew) return hebrew.recurrence ?? event.recurrence;
  const recurrence = event.recurrence;
  if (!recurrence?.hebrewNoYear) return recurrence;
  const day = (d: Date) => formatInTimeZone(d, timezone, 'yyyy-MM-dd');
  if (day(newStart) === day(event.startTime)) return recurrence;
  const kept = { ...recurrence };
  delete kept.hebrewNoYear;
  return kept;
}

/**
 * Handle a correction to a pending event confirmation
 */
export async function handleEventCorrection(
  chatId: number,
  userId: number,
  pendingId: string,
  confirmationMessageId: number,
  correctionInput: CorrectionInput
): Promise<void> {
  const messagingService = getMessagingService();
  let stopTyping: (() => void) | null = null;

  try {
    const pending = await getPendingEvent(pendingId);

    if (!pending) {
      const t = await getBotMessages('en');
      await messagingService.sendMessage(chatId,
        t.voice?.expiredMessage || '⏰ This event confirmation has expired. Please send a new voice message.',
        { format: MessageFormat.HTML }
      );
      return;
    }

    const { event, user, transcription } = pending;

    addBreadcrumb('event_correction_started', {
      user_id: userId,
      input_type: 'text' in correctionInput ? 'text' : 'voice',
    }, 'voice');

    stopTyping = startTypingInterval(chatId, messagingService);

    const timezone = await resolveUserTimezone(user);
    const { getCalendarAssignmentsForUser } = await import('../calendar-provider');
    const userCalendars = await getCalendarAssignmentsForUser(user);
    const correctionPrompt = buildCorrectionPrompt(event, userCalendars, timezone);

    // Build Gemini request parts — text or audio in a single call
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parts: any[] = [{ text: correctionPrompt }];

    if ('audioBuffer' in correctionInput) {
      parts.push({
        inlineData: {
          mimeType: 'audio/ogg',
          data: correctionInput.audioBuffer.toString('base64'),
        },
      });
    } else {
      parts.push({ text: `\n\nUSER'S CORRECTION: "${correctionInput.text}"` });
    }

    const response = await getGemini().models.generateContent({
      model: AI_MODEL_ID,
      ...extractionConfig(AI_MODEL_ID),
      contents: [{ role: 'user', parts }],
    });

    let responseText: string;
    try {
      responseText = response.text ?? '';
    } catch {
      throw new Error('Gemini returned empty response for correction');
    }
    if (!responseText) {
      throw new Error('Gemini returned empty response for correction');
    }

    // Extract JSON from response
    let jsonSource = responseText;
    const codeBlockMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      jsonSource = codeBlockMatch[1];
    }
    const jsonMatch = jsonSource.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Failed to extract JSON from correction response');
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parsed: any = JSON.parse(jsonMatch[0]);

    // A Hebrew date the user gave is resolved here, by the same reader as a new event, never by the model
    const hebrew = parsed.hebrewDate != null
      ? readRepeat({ ...parsed, recurrence: event.recurrence }, timezone, new Date())
      : null;
    const startDate = hebrew ? hebrew.startDate : parsed.startDate;
    const endDate = hebrew ? hebrew.endDate : parsed.endDate;

    // Build corrected ParsedEvent. A reminder's end is its start, whatever the model sent.
    const reminder = event.kind === 'reminder';
    const { start: startDateTime, end: endDateTime } = buildEventTimes(
      startDate,
      parsed.startTime,
      reminder ? startDate : endDate,
      reminder ? parsed.startTime : parsed.endTime,
      !!parsed.allDay,
      timezone
    );

    if (isNaN(startDateTime.getTime()) || isNaN(endDateTime.getTime())) {
      throw new Error('Invalid date/time in correction response');
    }

    // Validate calendarId against user's calendars
    const calendars = userCalendars;
    const matchedCalendar = calendars.find(c => c.calendarId === parsed.calendarId)
      || calendars.find(c => c.name?.toLowerCase() === (parsed.calendarName || '').toLowerCase());
    // Only one of the user's calendars, else the card's own: an unknown id (the literal 'primary'
    // the prompt shows for a card with no calendar) would send the event to Google. With neither,
    // the create site picks the default ("Google as a connection" spec §3).
    const resolvedCalendarId = matchedCalendar?.calendarId || event.calendarId;
    const resolvedCalendarName = matchedCalendar?.name || event.calendarName;

    const correctedEvent: ParsedEvent = {
      title: parsed.title || event.title,
      startTime: startDateTime,
      endTime: endDateTime,
      location: parsed.location || undefined,
      description: event.description,
      allDay: parsed.allDay ?? event.allDay,
      calendarId: resolvedCalendarId,
      calendarName: resolvedCalendarName,
      confidence: 'high',
      recurrence: correctedRecurrence(event, startDateTime, hebrew, timezone),
    };
    if (reminder) {
      // A reminder keeps who it is for and its main calendar, and stays zero-length.
      // The card works its notice out again from the corrected time.
      const times = normalizeReminderTimes(startDateTime, correctedEvent.allDay, timezone);
      Object.assign(correctedEvent, {
        startTime: times.startsAt,
        endTime: times.endsAt,
        calendarId: event.calendarId,
        calendarName: event.calendarName,
        kind: event.kind,
        forPerson: event.forPerson,
        anchor: event.anchor,
        forUserId: event.forUserId,
        forName: event.forName,
        reminderNotice: event.reminderNotice,
      });
    }

    // Clean up old pending event + reverse mapping
    await removePendingEvent(pendingId);
    await redis.del(REDIS_KEYS.pendingReply(chatId, confirmationMessageId));

    stopTyping();

    // Build admin footer
    const inputTokens = response.usageMetadata?.promptTokenCount || 0;
    const outputTokens = response.usageMetadata?.candidatesTokenCount || 0;
    const adminFooter = user.isAdmin
      ? `\n\n<i>📊 correction | ${AI_MODEL_ID} | ${inputTokens}→${outputTokens} tok</i>`
      : undefined;

    // Show updated confirmation — edits the original message in-place
    // showEventConfirmation creates a new pending event + new reverse mapping
    await showEventConfirmation(chatId, confirmationMessageId, correctedEvent, transcription, user, adminFooter);

    trackActivityAsync(user.id, 'event_correction_applied', {
      language: user.language,
    });

    console.log(`[Correction] Applied correction for user ${userId}, pending ${pendingId}`);

  } catch (error) {
    if (stopTyping) stopTyping();
    console.error('[Correction] Error applying correction:', error);
    captureError(error, 'event-correction');

    const t = await getBotMessages('en');
    await messagingService.sendMessage(chatId,
      t.voice?.correctionFailed || '❌ Could not apply correction. Please try again.',
      { format: MessageFormat.HTML }
    );
  }
}

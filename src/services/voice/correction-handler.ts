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
import { buildEventTimes } from './gemini-voice';
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
${reminderNote}
USER'S CALENDARS:
${calendarList || '- Primary calendar (ID: primary)'}

TIMEZONE: ${timezone}

Apply the user's correction and return the updated event in JSON format.
Only change the fields the user mentioned. Keep everything else exactly as-is.

RESPOND IN JSON FORMAT ONLY:
{
  "title": "...",
  "startDate": "YYYY-MM-DD",
  "startTime": "HH:MM",
  "endDate": "YYYY-MM-DD",
  "endTime": "HH:MM",
  "allDay": false,
  "location": "..." or null,
  "calendarId": "..." or "primary",
  "calendarName": "..." or "Primary"
}`;
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

    // Build corrected ParsedEvent. A reminder's end is its start, whatever the model sent.
    const reminder = event.kind === 'reminder';
    const { start: startDateTime, end: endDateTime } = buildEventTimes(
      parsed.startDate,
      parsed.startTime,
      reminder ? parsed.startDate : parsed.endDate,
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
    const resolvedCalendarId = matchedCalendar?.calendarId || parsed.calendarId || event.calendarId || 'primary';
    const resolvedCalendarName = matchedCalendar?.name || parsed.calendarName || event.calendarName || 'Primary';

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
      recurrence: event.recurrence,
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

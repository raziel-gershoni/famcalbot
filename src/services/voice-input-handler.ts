/**
 * Voice Input Handler
 * Handles incoming voice messages from Telegram for event creation
 */

import { getBot, getMessagingService } from './telegram';
import { getUserByTelegramId } from './user-service';
import { MessageFormat } from './messaging/types';
import { transcribeVoice } from './transcription';
import { parseEventFromText, ParsedEvent, parseVoiceIntent, EventReference, EditRequest, VoiceIntentResult } from './event-parser';
import { createEvent, CreateEventResult, fetchEventsInRange, CalendarEvent, updateEvent, UpdateEventData, UpdateEventResult, deleteEvent, DeleteEventResult } from './calendar';
import { TIMEZONE } from '../config/constants';
import { resolveUserTimezone } from '../lib/timezone';
import { buildUrl } from '../config/urls';
import { UserConfig } from '../types';
import { getBotMessages } from '../lib/bot-messages';
import { generateAICompletion } from './ai-provider';
import { fromZonedTime } from 'date-fns-tz';

interface TelegramVoice {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
}

/**
 * Download voice file from Telegram CDN
 * @param fileId - Telegram file_id
 * @returns Buffer containing the audio data
 */
async function downloadVoiceFile(fileId: string): Promise<Buffer> {
  const bot = getBot();

  // Get file info from Telegram
  const fileInfo = await bot.getFile(fileId);
  const filePath = fileInfo.file_path;

  if (!filePath) {
    throw new Error('Could not get file path from Telegram');
  }

  // Construct download URL
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;

  // Download the file
  const response = await fetch(downloadUrl);
  if (!response.ok) {
    throw new Error(`Failed to download voice file: ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// Store pending events for confirmation (in-memory, short-lived)
// In production, this could use Redis or database
const pendingEvents: Map<string, { event: ParsedEvent; user: UserConfig; transcription: string }> = new Map();

/**
 * Track last created event per user for "edit that" / "cancel that" references
 */
interface CreatedEventTracker {
  eventId: string;
  calendarId: string;
  title: string;
  startTime: Date;
  endTime: Date;
  location?: string;
  createdAt: Date;
}

// Store last created event per user (expires after 30 minutes)
const lastCreatedEvents: Map<number, CreatedEventTracker> = new Map();

/**
 * Store a created event for "last created" reference
 */
export function trackCreatedEvent(
  userId: number,
  eventId: string,
  calendarId: string,
  event: ParsedEvent
): void {
  lastCreatedEvents.set(userId, {
    eventId,
    calendarId,
    title: event.title,
    startTime: event.startTime,
    endTime: event.endTime,
    location: event.location,
    createdAt: new Date()
  });

  // Clean up old entries (older than 30 minutes)
  const thirtyMinutesAgo = Date.now() - 30 * 60 * 1000;
  for (const [key, value] of lastCreatedEvents.entries()) {
    if (value.createdAt.getTime() < thirtyMinutesAgo) {
      lastCreatedEvents.delete(key);
    }
  }
}

/**
 * Get the last created event for a user
 */
export function getLastCreatedEvent(userId: number): CreatedEventTracker | undefined {
  const event = lastCreatedEvents.get(userId);
  if (!event) return undefined;

  // Check if expired (30 minutes)
  const thirtyMinutesAgo = Date.now() - 30 * 60 * 1000;
  if (event.createdAt.getTime() < thirtyMinutesAgo) {
    lastCreatedEvents.delete(userId);
    return undefined;
  }

  return event;
}

/**
 * Find a matching event based on description and time hint
 * Uses AI to match event titles and returns the best match
 */
export async function findMatchingEvent(
  refreshToken: string,
  calendarIds: string[],
  reference: EventReference,
  language: string
): Promise<{ event: CalendarEvent; calendarId: string } | { error: string; multiple?: CalendarEvent[] }> {
  // Determine date range based on timeHint
  const now = new Date();
  let startDate = new Date(now);
  let endDate = new Date(now);

  // Default: search 2 weeks ahead and 1 week back
  startDate.setDate(startDate.getDate() - 7);
  endDate.setDate(endDate.getDate() + 14);

  // If timeHint is provided, narrow the search
  if (reference.timeHint) {
    const hint = reference.timeHint.toLowerCase();
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);

    if (hint.includes('today') || hint.includes('היום') || hint.includes('сегодня')) {
      startDate = today;
      endDate = new Date(today);
      endDate.setDate(endDate.getDate() + 1);
    } else if (hint.includes('tomorrow') || hint.includes('מחר') || hint.includes('завтра')) {
      startDate = new Date(today);
      startDate.setDate(startDate.getDate() + 1);
      endDate = new Date(startDate);
      endDate.setDate(endDate.getDate() + 1);
    } else if (hint.includes('next week') || hint.includes('שבוע הבא') || hint.includes('следующ')) {
      startDate = new Date(today);
      endDate = new Date(today);
      endDate.setDate(endDate.getDate() + 14);
    }
  }

  // Fetch events from all calendars
  const events = await fetchEventsInRange(refreshToken, calendarIds, startDate, endDate);

  if (events.length === 0) {
    return { error: 'no_events_found' };
  }

  // If no description, can't match
  if (!reference.description) {
    return { error: 'no_description' };
  }

  // Use AI to find the best matching event
  const eventList = events.map((e, i) => {
    const startDate = new Date(e.start);
    const timeStr = startDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    return `${i + 1}. "${e.summary}" on ${startDate.toLocaleDateString()} at ${timeStr} (calendar: ${e.calendarId})`;
  }).join('\n');

  const prompt = `Find the event that best matches the user's description.

User's description: "${reference.description}"
${reference.timeHint ? `Date hint: "${reference.timeHint}"` : ''}
${reference.originalTime ? `Original event time: "${reference.originalTime}" (IMPORTANT: strongly prefer events starting at this exact time)` : ''}
User language: ${language}

Available events:
${eventList}

MATCHING CRITERIA (in priority order):
1. Title must contain the user's description keywords (partial match OK, e.g., "dentist" matches "Dentist appointment")
2. If originalTime is provided (e.g., "15:00"):
   - STRONG MATCH: Event starts at exactly that time
   - WEAK MATCH: Event starts within ±1 hour
   - If multiple title matches exist, the time match MUST be used to disambiguate
3. If timeHint is provided (e.g., "tomorrow"), prefer events on that date
4. If multiple events match ALL criteria equally, return "multiple"
5. If no event matches the description, return "none"

RESPOND IN JSON:
{
  "match": "single" | "multiple" | "none",
  "eventIndex": <1-based index if single match>,
  "matchedIndexes": [<indexes if multiple>],
  "confidence": "high" | "medium" | "low"
}`;

  try {
    const result = await generateAICompletion(prompt);
    const jsonMatch = result.text.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      return { error: 'ai_parse_error' };
    }

    const parsed = JSON.parse(jsonMatch[0]);

    if (parsed.match === 'none') {
      return { error: 'no_match' };
    }

    if (parsed.match === 'multiple') {
      const matchedEvents = (parsed.matchedIndexes || []).map((i: number) => events[i - 1]).filter(Boolean);
      return { error: 'multiple_matches', multiple: matchedEvents };
    }

    if (parsed.match === 'single' && parsed.eventIndex) {
      const matchedEvent = events[parsed.eventIndex - 1];
      if (matchedEvent) {
        return { event: matchedEvent, calendarId: matchedEvent.calendarId };
      }
    }

    return { error: 'no_match' };
  } catch (error) {
    console.error('[Voice] Error matching event:', error);
    return { error: 'ai_error' };
  }
}

/**
 * Pending edit operation data
 */
interface PendingEdit {
  originalEvent: CalendarEvent;
  calendarId: string;
  updates: UpdateEventData;
  user: UserConfig;
  transcription: string;
}

// Store pending edit operations
const pendingEdits: Map<string, PendingEdit> = new Map();

/**
 * Format CalendarEvent date/time for display (uses string dates)
 */
function formatCalendarEventDateTime(event: CalendarEvent, language: string, allDayText: string): string {
  const locale = language === 'he' ? 'he-IL' : language === 'ru' ? 'ru-RU' : 'en-US';
  const startDate = new Date(event.start);
  const endDate = new Date(event.end);

  const dateOptions: Intl.DateTimeFormatOptions = {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: TIMEZONE
  };

  const timeOptions: Intl.DateTimeFormatOptions = {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: TIMEZONE
  };

  const dateStr = startDate.toLocaleDateString(locale, dateOptions);
  const startTimeStr = startDate.toLocaleTimeString(locale, timeOptions);
  const endTimeStr = endDate.toLocaleTimeString(locale, timeOptions);

  // Check if all-day event (no time component)
  const isAllDay = event.start.length <= 10;  // YYYY-MM-DD format

  if (isAllDay) {
    return `📆 ${dateStr} (${allDayText})`;
  }

  return `📆 ${dateStr}\n🕐 ${startTimeStr} - ${endTimeStr}`;
}

/**
 * Format the changes being made to an event
 */
function formatEditChanges(
  originalEvent: CalendarEvent,
  updates: UpdateEventData,
  language: string
): string {
  const locale = language === 'he' ? 'he-IL' : language === 'ru' ? 'ru-RU' : 'en-US';
  const changes: string[] = [];

  const timeOptions: Intl.DateTimeFormatOptions = {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: TIMEZONE
  };

  const dateOptions: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: TIMEZONE
  };

  if (updates.title && updates.title !== originalEvent.summary) {
    changes.push(`📝 ${originalEvent.summary} → ${updates.title}`);
  }

  if (updates.startTime) {
    const originalStart = new Date(originalEvent.start);
    const newStart = updates.startTime;

    // Check if date changed
    const originalDateStr = originalStart.toLocaleDateString(locale, dateOptions);
    const newDateStr = newStart.toLocaleDateString(locale, dateOptions);
    if (originalDateStr !== newDateStr) {
      changes.push(`📆 ${originalDateStr} → ${newDateStr}`);
    }

    // Check if time changed
    const originalTimeStr = originalStart.toLocaleTimeString(locale, timeOptions);
    const newTimeStr = newStart.toLocaleTimeString(locale, timeOptions);
    if (originalTimeStr !== newTimeStr) {
      changes.push(`🕐 ${originalTimeStr} → ${newTimeStr}`);
    }
  }

  if (updates.location) {
    const originalLoc = originalEvent.location || '(none)';
    changes.push(`📍 ${originalLoc} → ${updates.location}`);
  }

  return changes.length > 0 ? changes.join('\n') : '(no changes detected)';
}

/**
 * Show edit confirmation with inline keyboard
 */
export async function showEditConfirmation(
  chatId: number,
  messageId: number,
  originalEvent: CalendarEvent,
  calendarId: string,
  updates: UpdateEventData,
  transcription: string,
  user: UserConfig
): Promise<void> {
  const bot = getBot();
  const t = await getBotMessages(user.language || 'en');

  // Generate unique ID for this pending edit
  const pendingId = `${chatId}:${Date.now()}`;

  // Store pending edit
  pendingEdits.set(pendingId, { originalEvent, calendarId, updates, user, transcription });

  // Clean up old pending edits (older than 10 minutes)
  const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
  for (const [key] of pendingEdits.entries()) {
    const timestamp = parseInt(key.split(':')[1]);
    if (timestamp < tenMinutesAgo) {
      pendingEdits.delete(key);
    }
  }

  const currentInfo = formatCalendarEventDateTime(originalEvent, user.language || 'en', t.voice?.allDay || 'All day');
  const changesInfo = formatEditChanges(originalEvent, updates, user.language || 'en');

  // Use localized messages with fallbacks
  const editTitle = t.voice?.editConfirmTitle || '📝 <b>Edit this event?</b>';
  const currentLabel = t.voice?.currentEvent || 'Current:';
  const changesLabel = t.voice?.changes || 'Changes:';
  const confirmBtn = t.voice?.confirmEditButton || '✅ Confirm Edit';
  const cancelBtn = t.voice?.cancelButton || '❌ Cancel';
  const fromLabel = t.voice?.from || 'From:';

  const confirmationMessage =
    `${editTitle}\n\n` +
    `<b>${currentLabel}</b>\n` +
    `📅 ${originalEvent.summary}\n` +
    `${currentInfo}\n\n` +
    `<b>${changesLabel}</b>\n` +
    `${changesInfo}\n\n` +
    `<i>${fromLabel} "${transcription}"</i>`;

  // Update message with confirmation buttons
  await bot.editMessageText(confirmationMessage, {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [[
        { text: confirmBtn, callback_data: `edit_confirm:${pendingId}` },
        { text: cancelBtn, callback_data: `edit_cancel:${pendingId}` }
      ]]
    }
  });
}

/**
 * Handle edit callback (when user clicks Confirm Edit or Cancel)
 */
export async function handleEditCallback(
  chatId: number,
  messageId: number,
  queryId: string,
  action: string,
  pendingId: string
): Promise<void> {
  const bot = getBot();

  // Get pending edit
  const pending = pendingEdits.get(pendingId);

  if (!pending) {
    const t = await getBotMessages('en');
    await bot.answerCallbackQuery(queryId, { text: t.voice?.expired || 'Request expired' });
    await bot.editMessageText(t.voice?.expiredMessage || '⏰ This request has expired.', {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML'
    });
    return;
  }

  const { originalEvent, calendarId, updates, user } = pending;
  const t = await getBotMessages(user.language || 'en');

  // Remove from pending
  pendingEdits.delete(pendingId);

  if (action === 'cancel') {
    await bot.answerCallbackQuery(queryId, { text: t.voice?.cancelled || 'Cancelled' });
    await bot.editMessageText(t.voice?.cancelledMessage || '❌ Edit cancelled.', {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML'
    });
    return;
  }

  // Update the event
  if (action === 'confirm') {
    await bot.answerCallbackQuery(queryId, { text: t.voice?.updating || 'Updating...' });

    // Update message to show progress
    await bot.editMessageText(t.voice?.updatingEvent || '⏳ Updating event...', {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML'
    });

    // Check if user has refresh token
    if (!user.googleRefreshToken) {
      await bot.editMessageText(
        `${t.voice?.notConnected || '❌ Not connected'}\n\n${t.voice?.connectFirst || 'Please connect your calendar first.'}`,
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'HTML'
        }
      );
      return;
    }

    // Get event ID
    const eventId = originalEvent.eventId;
    if (!eventId) {
      await bot.editMessageText(
        t.voice?.eventNotFound || '❌ Could not find the event to update.',
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'HTML'
        }
      );
      return;
    }

    // Update the event
    const result: UpdateEventResult = await updateEvent(
      user.googleRefreshToken,
      calendarId,
      eventId,
      updates
    );

    if (result.success) {
      const linkButton = result.eventLink
        ? `\n\n<a href="${result.eventLink}">${t.voice?.openInCalendar || 'Open in Calendar'}</a>`
        : '';

      const editedMsg = t.voice?.edited || '✅ <b>Event updated!</b>';

      await bot.editMessageText(
        `${editedMsg}\n\n` +
        `📅 ${updates.title || originalEvent.summary}${linkButton}`,
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'HTML',
          disable_web_page_preview: true
        }
      );
    } else if (result.error === 'PERMISSION_DENIED') {
      const upgradeUrl = buildUrl(`/refresh-token?user_id=${user.telegramId}&scope=write`);
      await bot.editMessageText(
        `${t.voice?.permissionRequired || '🔐 Permission required'}\n\n${t.voice?.permissionMessage || 'Please grant calendar write access.'}`,
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[
              { text: t.voice?.grantAccess || 'Grant Access', web_app: { url: upgradeUrl } }
            ]]
          }
        }
      );
    } else if (result.error === 'TOKEN_EXPIRED') {
      const refreshUrl = buildUrl(`/refresh-token?user_id=${user.telegramId}&scope=write`);
      await bot.editMessageText(
        `${t.voice?.accessExpired || '🔑 Access expired'}\n\n${t.voice?.accessExpiredMessage || 'Please re-authorize.'}`,
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[
              { text: t.voice?.reauthorize || 'Re-authorize', web_app: { url: refreshUrl } }
            ]]
          }
        }
      );
    } else if (result.error === 'NOT_FOUND') {
      await bot.editMessageText(
        t.voice?.eventNotFound || '❌ Event not found. It may have been deleted.',
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'HTML'
        }
      );
    } else {
      await bot.editMessageText(
        `${t.voice?.failedToUpdate || '❌ Failed to update event'}\n\n${result.errorMessage || t.voice?.unknownError || 'Unknown error'}`,
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'HTML'
        }
      );
    }
  }
}

/**
 * Pending delete operation data
 */
interface PendingDelete {
  event: CalendarEvent;
  calendarId: string;
  user: UserConfig;
  transcription: string;
}

// Store pending delete operations
const pendingDeletes: Map<string, PendingDelete> = new Map();

/**
 * Show delete confirmation with inline keyboard
 */
export async function showDeleteConfirmation(
  chatId: number,
  messageId: number,
  event: CalendarEvent,
  calendarId: string,
  transcription: string,
  user: UserConfig
): Promise<void> {
  const bot = getBot();
  const t = await getBotMessages(user.language || 'en');

  // Generate unique ID for this pending delete
  const pendingId = `${chatId}:${Date.now()}`;

  // Store pending delete
  pendingDeletes.set(pendingId, { event, calendarId, user, transcription });

  // Clean up old pending deletes (older than 10 minutes)
  const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
  for (const [key] of pendingDeletes.entries()) {
    const timestamp = parseInt(key.split(':')[1]);
    if (timestamp < tenMinutesAgo) {
      pendingDeletes.delete(key);
    }
  }

  const eventInfo = formatCalendarEventDateTime(event, user.language || 'en', t.voice?.allDay || 'All day');

  // Use localized messages with fallbacks
  const deleteTitle = t.voice?.deleteConfirmTitle || '🗑️ <b>Delete this event?</b>';
  const deleteBtn = t.voice?.deleteButton || '🗑️ Delete';
  const keepBtn = t.voice?.keepButton || '❌ Keep';
  const fromLabel = t.voice?.from || 'From:';

  const confirmationMessage =
    `${deleteTitle}\n\n` +
    `📅 <b>${event.summary}</b>\n` +
    `${eventInfo}\n\n` +
    `<i>${fromLabel} "${transcription}"</i>`;

  // Update message with confirmation buttons
  await bot.editMessageText(confirmationMessage, {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [[
        { text: deleteBtn, callback_data: `delete_confirm:${pendingId}` },
        { text: keepBtn, callback_data: `delete_cancel:${pendingId}` }
      ]]
    }
  });
}

/**
 * Handle delete callback (when user clicks Delete or Keep)
 */
export async function handleDeleteCallback(
  chatId: number,
  messageId: number,
  queryId: string,
  action: string,
  pendingId: string
): Promise<void> {
  const bot = getBot();

  // Get pending delete
  const pending = pendingDeletes.get(pendingId);

  if (!pending) {
    const t = await getBotMessages('en');
    await bot.answerCallbackQuery(queryId, { text: t.voice?.expired || 'Request expired' });
    await bot.editMessageText(t.voice?.expiredMessage || '⏰ This request has expired.', {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML'
    });
    return;
  }

  const { event, calendarId, user } = pending;
  const t = await getBotMessages(user.language || 'en');

  // Remove from pending
  pendingDeletes.delete(pendingId);

  if (action === 'cancel') {
    await bot.answerCallbackQuery(queryId, { text: t.voice?.kept || 'Kept' });
    await bot.editMessageText(t.voice?.keptMessage || '✅ Event kept.', {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML'
    });
    return;
  }

  // Delete the event
  if (action === 'confirm') {
    await bot.answerCallbackQuery(queryId, { text: t.voice?.deleting || 'Deleting...' });

    // Update message to show progress
    await bot.editMessageText(t.voice?.deletingEvent || '⏳ Deleting event...', {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML'
    });

    // Check if user has refresh token
    if (!user.googleRefreshToken) {
      await bot.editMessageText(
        `${t.voice?.notConnected || '❌ Not connected'}\n\n${t.voice?.connectFirst || 'Please connect your calendar first.'}`,
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'HTML'
        }
      );
      return;
    }

    // Get event ID
    const eventId = event.eventId;
    if (!eventId) {
      await bot.editMessageText(
        t.voice?.eventNotFound || '❌ Could not find the event to delete.',
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'HTML'
        }
      );
      return;
    }

    // Delete the event
    const result: DeleteEventResult = await deleteEvent(
      user.googleRefreshToken,
      calendarId,
      eventId
    );

    if (result.success) {
      const deletedMsg = t.voice?.deleted || '✅ <b>Event deleted!</b>';
      await bot.editMessageText(
        `${deletedMsg}\n\n` +
        `📅 <s>${event.summary}</s>`,
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'HTML'
        }
      );
    } else if (result.error === 'PERMISSION_DENIED') {
      const upgradeUrl = buildUrl(`/refresh-token?user_id=${user.telegramId}&scope=write`);
      await bot.editMessageText(
        `${t.voice?.permissionRequired || '🔐 Permission required'}\n\n${t.voice?.permissionMessage || 'Please grant calendar write access.'}`,
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[
              { text: t.voice?.grantAccess || 'Grant Access', web_app: { url: upgradeUrl } }
            ]]
          }
        }
      );
    } else if (result.error === 'TOKEN_EXPIRED') {
      const refreshUrl = buildUrl(`/refresh-token?user_id=${user.telegramId}&scope=write`);
      await bot.editMessageText(
        `${t.voice?.accessExpired || '🔑 Access expired'}\n\n${t.voice?.accessExpiredMessage || 'Please re-authorize.'}`,
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[
              { text: t.voice?.reauthorize || 'Re-authorize', web_app: { url: refreshUrl } }
            ]]
          }
        }
      );
    } else if (result.error === 'NOT_FOUND') {
      await bot.editMessageText(
        t.voice?.eventNotFound || '❌ Event not found. It may have already been deleted.',
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'HTML'
        }
      );
    } else {
      await bot.editMessageText(
        `${t.voice?.failedToDelete || '❌ Failed to delete event'}\n\n${result.errorMessage || t.voice?.unknownError || 'Unknown error'}`,
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'HTML'
        }
      );
    }
  }
}

/**
 * Format event date/time for display
 */
function formatEventDateTime(event: ParsedEvent, language: string, allDayText: string): string {
  const locale = language === 'he' ? 'he-IL' : language === 'ru' ? 'ru-RU' : 'en-US';

  const dateOptions: Intl.DateTimeFormatOptions = {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: TIMEZONE
  };

  const timeOptions: Intl.DateTimeFormatOptions = {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: TIMEZONE
  };

  const dateStr = event.startTime.toLocaleDateString(locale, dateOptions);
  const startTimeStr = event.startTime.toLocaleTimeString(locale, timeOptions);
  const endTimeStr = event.endTime.toLocaleTimeString(locale, timeOptions);

  if (event.allDay) {
    return `📆 ${dateStr} (${allDayText})`;
  }

  return `📆 ${dateStr}\n🕐 ${startTimeStr} - ${endTimeStr}`;
}

/**
 * Show event confirmation with inline keyboard
 */
async function showEventConfirmation(
  chatId: number,
  messageId: number,
  event: ParsedEvent,
  transcription: string,
  user: UserConfig
): Promise<void> {
  const bot = getBot();
  const t = await getBotMessages(user.language || 'en');

  // Generate unique ID for this pending event
  const pendingId = `${chatId}:${Date.now()}`;

  // Store pending event
  pendingEvents.set(pendingId, { event, user, transcription });

  // Clean up old pending events (older than 10 minutes)
  const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
  for (const [key, value] of pendingEvents.entries()) {
    const timestamp = parseInt(key.split(':')[1]);
    if (timestamp < tenMinutesAgo) {
      pendingEvents.delete(key);
    }
  }

  const dateTimeStr = formatEventDateTime(event, user.language || 'en', t.voice.allDay);
  const locationStr = event.location ? `\n📍 ${event.location}` : '';
  const calendarStr = event.calendarName ? `\n📁 ${event.calendarName}` : '';

  const confirmationMessage =
    `${t.voice.confirmTitle}\n\n` +
    `<b>${event.title}</b>\n` +
    `${dateTimeStr}${locationStr}${calendarStr}\n\n` +
    `<i>${t.voice.from} "${transcription}"</i>`;

  // Update message with confirmation buttons
  await bot.editMessageText(confirmationMessage, {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [[
        { text: t.voice.createButton, callback_data: `event_create:${pendingId}` },
        { text: t.voice.cancelButton, callback_data: `event_cancel:${pendingId}` }
      ]]
    }
  });
}

/**
 * Handle event creation callback (when user clicks Create or Cancel)
 */
export async function handleEventCallback(
  chatId: number,
  messageId: number,
  queryId: string,
  action: string,
  pendingId: string
): Promise<void> {
  const bot = getBot();

  // Get pending event
  const pending = pendingEvents.get(pendingId);

  if (!pending) {
    // Use English as fallback when we don't know user language
    const t = await getBotMessages('en');
    await bot.answerCallbackQuery(queryId, { text: t.voice.expired });
    await bot.editMessageText(t.voice.expiredMessage, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML'
    });
    return;
  }

  const { event, user } = pending;
  const t = await getBotMessages(user.language || 'en');

  // Remove from pending
  pendingEvents.delete(pendingId);

  if (action === 'cancel') {
    await bot.answerCallbackQuery(queryId, { text: t.voice.cancelled });
    await bot.editMessageText(t.voice.cancelledMessage, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML'
    });
    return;
  }

  // Create the event
  if (action === 'create') {
    await bot.answerCallbackQuery(queryId, { text: t.voice.creating });

    // Update message to show progress
    await bot.editMessageText(t.voice.creatingInCalendar, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML'
    });

    // Check if user has refresh token
    if (!user.googleRefreshToken) {
      await bot.editMessageText(
        `${t.voice.notConnected}\n\n${t.voice.connectFirst}`,
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'HTML'
        }
      );
      return;
    }

    // Create the event
    const result: CreateEventResult = await createEvent(
      user.googleRefreshToken,
      event.calendarId || 'primary',
      {
        title: event.title,
        startTime: event.startTime,
        endTime: event.endTime,
        location: event.location,
        description: event.description,
        allDay: event.allDay
      }
    );

    if (result.success) {
      // Track created event for "edit that" / "delete that" references
      if (result.eventId) {
        trackCreatedEvent(user.telegramId, result.eventId, event.calendarId || 'primary', event);
      }

      const dateTimeStr = formatEventDateTime(event, user.language || 'en', t.voice.allDay);
      const linkButton = result.eventLink
        ? `\n\n<a href="${result.eventLink}">${t.voice.openInCalendar}</a>`
        : '';

      await bot.editMessageText(
        `${t.voice.created}\n\n` +
        `<b>${event.title}</b>\n` +
        `${dateTimeStr}${linkButton}`,
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'HTML',
          disable_web_page_preview: true
        }
      );
    } else if (result.error === 'PERMISSION_DENIED') {
      // Need to upgrade OAuth scope
      const upgradeUrl = buildUrl(`/refresh-token?user_id=${user.telegramId}&scope=write`);

      await bot.editMessageText(
        `${t.voice.permissionRequired}\n\n${t.voice.permissionMessage}`,
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[
              { text: t.voice.grantAccess, web_app: { url: upgradeUrl } }
            ]]
          }
        }
      );
    } else if (result.error === 'TOKEN_EXPIRED') {
      // Token expired - need to re-authorize
      const refreshUrl = buildUrl(`/refresh-token?user_id=${user.telegramId}&scope=write`);

      await bot.editMessageText(
        `${t.voice.accessExpired}\n\n${t.voice.accessExpiredMessage}`,
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[
              { text: t.voice.reauthorize, web_app: { url: refreshUrl } }
            ]]
          }
        }
      );
    } else {
      await bot.editMessageText(
        `${t.voice.failedToCreate}\n\n${result.errorMessage || t.voice.unknownError}`,
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'HTML'
        }
      );
    }
  }
}

/**
 * Helper to convert EditRequest to UpdateEventData
 */
function convertEditRequestToUpdates(
  editRequest: EditRequest | undefined,
  originalEvent: CalendarEvent,
  timezone: string
): UpdateEventData {
  const updates: UpdateEventData = {};

  if (!editRequest) return updates;

  if (editRequest.newTitle) {
    updates.title = editRequest.newTitle;
  }

  // Handle time changes
  const originalStart = new Date(originalEvent.start);
  const originalEnd = new Date(originalEvent.end);
  const duration = originalEnd.getTime() - originalStart.getTime();

  // Get original times in user's timezone
  const originalStartLocal = originalStart.toLocaleString('sv-SE', { timeZone: timezone });
  const [originalDatePart, originalTimePart] = originalStartLocal.split(' ');
  const originalEndLocal = originalEnd.toLocaleString('sv-SE', { timeZone: timezone });
  const [originalEndDatePart, originalEndTimePart] = originalEndLocal.split(' ');

  if (editRequest.newStartDate || editRequest.newStartTime) {
    // Start time is changing
    const newStartDate = editRequest.newStartDate || originalDatePart;
    const newStartTime = editRequest.newStartTime || originalTimePart.substring(0, 5);
    updates.startTime = fromZonedTime(`${newStartDate}T${newStartTime}:00`, timezone);

    // If end time also provided, use it; otherwise preserve duration
    if (editRequest.newEndDate || editRequest.newEndTime) {
      const newEndDate = editRequest.newEndDate || originalEndDatePart;
      const newEndTime = editRequest.newEndTime || originalEndTimePart.substring(0, 5);
      updates.endTime = fromZonedTime(`${newEndDate}T${newEndTime}:00`, timezone);
    } else {
      updates.endTime = new Date(updates.startTime.getTime() + duration);
    }
  } else if (editRequest.newEndDate || editRequest.newEndTime) {
    // Only end time is changing (e.g., "extend until 17:00")
    const newEndDate = editRequest.newEndDate || originalEndDatePart;
    const newEndTime = editRequest.newEndTime || originalEndTimePart.substring(0, 5);
    updates.endTime = fromZonedTime(`${newEndDate}T${newEndTime}:00`, timezone);
  }

  if (editRequest.newLocation) {
    updates.location = editRequest.newLocation;
  }

  if (editRequest.newAllDay !== undefined) {
    updates.allDay = editRequest.newAllDay;
  }

  return updates;
}

/**
 * Handle EDIT intent - find event and show edit confirmation
 */
async function handleEditIntent(
  chatId: number,
  messageId: number,
  intentResult: VoiceIntentResult,
  transcription: string,
  user: UserConfig,
  t: any
): Promise<void> {
  const messagingService = getMessagingService();

  if (!user.googleRefreshToken) {
    await messagingService.updateMessage(chatId, messageId, t.voice?.noCalendar || 'Calendar not connected.', { format: MessageFormat.PLAIN });
    return;
  }

  // Find the event to edit
  let targetEvent: CalendarEvent | undefined;
  let targetCalendarId: string | undefined;

  if (intentResult.eventReference?.type === 'last_created') {
    // Use last created event
    const lastEvent = getLastCreatedEvent(user.telegramId);
    if (!lastEvent) {
      await messagingService.updateMessage(chatId, messageId,
        t.voice?.noLastEvent || "❌ No recent event found. Try specifying which event to edit.",
        { format: MessageFormat.HTML }
      );
      return;
    }

    // Fetch the event to get full details
    const calendarIds = (user.calendarAssignments || []).map(c => c.calendarId);
    if (!calendarIds.includes(lastEvent.calendarId)) {
      calendarIds.push(lastEvent.calendarId);
    }

    const events = await fetchEventsInRange(
      user.googleRefreshToken,
      [lastEvent.calendarId],
      new Date(lastEvent.startTime.getTime() - 60000),
      new Date(lastEvent.endTime.getTime() + 60000)
    );

    targetEvent = events.find(e => e.eventId === lastEvent.eventId);
    targetCalendarId = lastEvent.calendarId;

  } else if (intentResult.eventReference?.type === 'by_description') {
    // Search for matching event
    const calendarIds = (user.calendarAssignments || []).map(c => c.calendarId);
    const matchResult = await findMatchingEvent(
      user.googleRefreshToken,
      calendarIds,
      intentResult.eventReference,
      user.language || 'en'
    );

    if ('error' in matchResult) {
      if (matchResult.error === 'no_events_found') {
        await messagingService.updateMessage(chatId, messageId,
          t.voice?.noEventsFound || "❌ No events found in that time range.",
          { format: MessageFormat.HTML }
        );
      } else if (matchResult.error === 'multiple_matches') {
        await messagingService.updateMessage(chatId, messageId,
          t.voice?.ambiguousEvent || "🤔 Found multiple matching events. Please be more specific.",
          { format: MessageFormat.HTML }
        );
      } else {
        await messagingService.updateMessage(chatId, messageId,
          t.voice?.eventNotFound || "❌ Couldn't find that event.",
          { format: MessageFormat.HTML }
        );
      }
      return;
    }

    targetEvent = matchResult.event;
    targetCalendarId = matchResult.calendarId;
  }

  if (!targetEvent || !targetCalendarId) {
    await messagingService.updateMessage(chatId, messageId,
      t.voice?.eventNotFound || "❌ Couldn't find the event to edit.",
      { format: MessageFormat.HTML }
    );
    return;
  }

  // Resolve user's timezone dynamically
  const timezone = await resolveUserTimezone(user);

  // Convert edit request to update data
  const updates = convertEditRequestToUpdates(intentResult.editRequest, targetEvent, timezone);

  // Show edit confirmation
  await showEditConfirmation(chatId, messageId, targetEvent, targetCalendarId, updates, transcription, user);
}

/**
 * Handle DELETE intent - find event and show delete confirmation
 */
async function handleDeleteIntent(
  chatId: number,
  messageId: number,
  intentResult: VoiceIntentResult,
  transcription: string,
  user: UserConfig,
  t: any
): Promise<void> {
  const messagingService = getMessagingService();

  if (!user.googleRefreshToken) {
    await messagingService.updateMessage(chatId, messageId, t.voice?.noCalendar || 'Calendar not connected.', { format: MessageFormat.PLAIN });
    return;
  }

  // Find the event to delete
  let targetEvent: CalendarEvent | undefined;
  let targetCalendarId: string | undefined;

  if (intentResult.eventReference?.type === 'last_created') {
    // Use last created event
    const lastEvent = getLastCreatedEvent(user.telegramId);
    if (!lastEvent) {
      await messagingService.updateMessage(chatId, messageId,
        t.voice?.noLastEvent || "❌ No recent event found. Try specifying which event to cancel.",
        { format: MessageFormat.HTML }
      );
      return;
    }

    // Fetch the event to get full details
    const events = await fetchEventsInRange(
      user.googleRefreshToken,
      [lastEvent.calendarId],
      new Date(lastEvent.startTime.getTime() - 60000),
      new Date(lastEvent.endTime.getTime() + 60000)
    );

    targetEvent = events.find(e => e.eventId === lastEvent.eventId);
    targetCalendarId = lastEvent.calendarId;

  } else if (intentResult.eventReference?.type === 'by_description') {
    // Search for matching event
    const calendarIds = (user.calendarAssignments || []).map(c => c.calendarId);
    const matchResult = await findMatchingEvent(
      user.googleRefreshToken,
      calendarIds,
      intentResult.eventReference,
      user.language || 'en'
    );

    if ('error' in matchResult) {
      if (matchResult.error === 'no_events_found') {
        await messagingService.updateMessage(chatId, messageId,
          t.voice?.noEventsFound || "❌ No events found in that time range.",
          { format: MessageFormat.HTML }
        );
      } else if (matchResult.error === 'multiple_matches') {
        await messagingService.updateMessage(chatId, messageId,
          t.voice?.ambiguousEvent || "🤔 Found multiple matching events. Please be more specific.",
          { format: MessageFormat.HTML }
        );
      } else {
        await messagingService.updateMessage(chatId, messageId,
          t.voice?.eventNotFound || "❌ Couldn't find that event.",
          { format: MessageFormat.HTML }
        );
      }
      return;
    }

    targetEvent = matchResult.event;
    targetCalendarId = matchResult.calendarId;
  }

  if (!targetEvent || !targetCalendarId) {
    await messagingService.updateMessage(chatId, messageId,
      t.voice?.eventNotFound || "❌ Couldn't find the event to delete.",
      { format: MessageFormat.HTML }
    );
    return;
  }

  // Show delete confirmation
  await showDeleteConfirmation(chatId, messageId, targetEvent, targetCalendarId, transcription, user);
}

/**
 * Handle incoming voice message for event creation
 * @param chatId - Telegram chat ID
 * @param userId - Telegram user ID
 * @param voice - Voice message data from Telegram
 * @param from - Telegram user info
 */
export async function handleVoiceMessage(
  chatId: number,
  userId: number,
  voice: TelegramVoice,
  from: TelegramUser
): Promise<void> {
  console.log(`[Voice] Starting voice handler for user ${userId}`);
  const messagingService = getMessagingService();

  try {
    // Get user from database
    console.log(`[Voice] Looking up user ${userId} in database`);
    const user = await getUserByTelegramId(userId);

    if (!user) {
      console.log(`[Voice] User ${userId} not found in database`);
      const t = await getBotMessages('en');
      await messagingService.sendMessage(chatId, t.voice.notRegistered, { format: MessageFormat.PLAIN });
      return;
    }

    const t = await getBotMessages(user.language || 'en');
    console.log(`[Voice] User ${userId} found: ${user.name}, hasToken: ${!!user.googleRefreshToken}, voiceInputEnabled: ${user.voiceInputEnabled}`);

    // Check if voice input is enabled for this user
    if (!user.voiceInputEnabled) {
      console.log(`[Voice] Voice input disabled for user ${userId}, sending settings prompt`);
      const bot = getBot();
      const settingsUrl = buildUrl(`/${user.language || 'en'}/settings?user_id=${userId}`);
      await bot.sendMessage(chatId, t.voice.featureDisabled, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[
            { text: t.voice.enableInSettings, web_app: { url: settingsUrl } }
          ]]
        }
      });
      return;
    }

    // Check if user has Google token
    if (!user.googleRefreshToken) {
      console.log(`[Voice] User ${userId} has no Google refresh token`);
      await messagingService.sendMessage(chatId, t.voice.noCalendar, { format: MessageFormat.PLAIN });
      return;
    }

    // Send processing message
    console.log(`[Voice] Sending processing message to chat ${chatId}`);
    let processingMsg: number | string;
    try {
      processingMsg = await messagingService.sendMessage(chatId, t.voice.processing, { format: MessageFormat.PLAIN });
      console.log(`[Voice] Processing message sent, id: ${processingMsg}`);
    } catch (sendError) {
      console.error(`[Voice] Failed to send processing message:`, sendError);
      throw sendError;
    }
    const processingMsgId = typeof processingMsg === 'number' ? processingMsg : parseInt(processingMsg);

    // Download the voice file
    console.log(`[Voice] Downloading voice file for user ${userId}, file_id: ${voice.file_id}, duration: ${voice.duration}s`);
    const audioBuffer = await downloadVoiceFile(voice.file_id);
    console.log(`[Voice] Downloaded ${audioBuffer.length} bytes`);

    // Update progress
    await messagingService.updateMessage(chatId, processingMsgId, t.voice.transcribing, { format: MessageFormat.PLAIN });

    // Transcribe the voice message
    const transcription = await transcribeVoice(audioBuffer, user.language || 'en');

    if (!transcription.text || transcription.text.trim() === '') {
      await messagingService.updateMessage(chatId, processingMsgId, t.voice.transcriptionFailed, { format: MessageFormat.PLAIN });
      return;
    }

    // Update progress
    await messagingService.updateMessage(chatId, processingMsgId, t.voice.understanding, { format: MessageFormat.PLAIN });

    // Parse the transcription to detect intent (create/edit/delete)
    const intentResult = await parseVoiceIntent(
      transcription.text,
      user.language || 'en',
      user.calendarAssignments || []
    );

    console.log(`[Voice] Intent detected: ${intentResult.intent}, confidence: ${intentResult.confidence}`);

    // Handle based on intent
    if (intentResult.intent === 'create') {
      // CREATE: Show event creation confirmation
      if (!intentResult.event) {
        await messagingService.updateMessage(chatId, processingMsgId,
          `${t.voice.notUnderstood}\n\n` +
          `${t.voice.iHeard} "<i>${transcription.text}</i>"\n\n` +
          `${t.voice.tryExamples}\n` +
          `• "${t.voice.example1}"\n` +
          `• "${t.voice.example2}"\n` +
          `• "${t.voice.example3}"`,
          { format: MessageFormat.HTML }
        );
        return;
      }
      await showEventConfirmation(chatId, processingMsgId, intentResult.event, transcription.text, user);

    } else if (intentResult.intent === 'edit') {
      // EDIT: Find the event and show edit confirmation
      await handleEditIntent(chatId, processingMsgId, intentResult, transcription.text, user, t);

    } else if (intentResult.intent === 'delete') {
      // DELETE: Find the event and show delete confirmation
      await handleDeleteIntent(chatId, processingMsgId, intentResult, transcription.text, user, t);
    }

  } catch (error) {
    console.error('[Voice] Error handling voice message:', error);

    const t = await getBotMessages('en');
    await messagingService.sendMessage(chatId, t.voice.genericError, { format: MessageFormat.PLAIN });
  }
}

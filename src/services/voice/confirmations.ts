/**
 * Voice confirmation UI
 * Shows confirmation messages for event creation, editing, and deletion
 * Pending operations stored in Redis for serverless compatibility
 */

import { Redis } from '@upstash/redis';
import { getBot } from '../telegram';
import { ParsedEvent, RecurrenceScope } from '../event-parser';
import { CalendarEvent, UpdateEventData } from '../calendar';
import { resolveUserTimezone } from '../../lib/timezone';
import { UserConfig } from '../../types';
import { getBotMessages } from '../../lib/bot-messages';
import { REDIS_KEYS } from '../../config/redis-keys';
import { captureError } from '../../lib/error-capture';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const PENDING_TTL_SECONDS = 600; // 10 minutes

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Reconstruct Date objects from JSON-parsed data
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function reviveDates<T>(obj: any, dateFields: string[]): T {
  if (!obj) return obj;
  for (const field of dateFields) {
    if (obj[field] && typeof obj[field] === 'string') {
      obj[field] = new Date(obj[field]);
    }
  }
  return obj as T;
}

/**
 * Get a pending event by ID (used by callbacks)
 */
export async function getPendingEvent(pendingId: string) {
  try {
    const data = await redis.get<{ event: ParsedEvent; user: UserConfig; transcription: string }>(
      REDIS_KEYS.pendingEvent(pendingId)
    );
    if (!data) return undefined;
    // Reconstruct Date objects that were serialized as strings
    reviveDates(data.event, ['startTime', 'endTime']);
    return data;
  } catch (error) {
    console.error('[Voice] Error getting pending event from Redis:', error);
    captureError(error, 'voice-confirmations', {}, 'warning');
    return undefined;
  }
}

/**
 * Remove a pending event by ID
 */
export async function removePendingEvent(pendingId: string) {
  try {
    await redis.del(REDIS_KEYS.pendingEvent(pendingId));
  } catch (error) {
    console.error('[Voice] Error removing pending event from Redis:', error);
    captureError(error, 'voice-confirmations', {}, 'warning');
  }
}

/**
 * Pending edit operation data
 */
export interface PendingEdit {
  originalEvent: CalendarEvent;
  calendarId: string;
  updates: UpdateEventData;
  user: UserConfig;
  transcription: string;
  scope?: RecurrenceScope;
}

/**
 * Get a pending edit by ID (used by callbacks)
 */
export async function getPendingEdit(pendingId: string) {
  try {
    const data = await redis.get<PendingEdit>(REDIS_KEYS.pendingEdit(pendingId));
    if (!data) return undefined;
    reviveDates(data.updates, ['startTime', 'endTime']);
    return data;
  } catch (error) {
    console.error('[Voice] Error getting pending edit from Redis:', error);
    captureError(error, 'voice-confirmations', {}, 'warning');
    return undefined;
  }
}

/**
 * Remove a pending edit by ID
 */
export async function removePendingEdit(pendingId: string) {
  try {
    await redis.del(REDIS_KEYS.pendingEdit(pendingId));
  } catch (error) {
    console.error('[Voice] Error removing pending edit from Redis:', error);
    captureError(error, 'voice-confirmations', {}, 'warning');
  }
}

/**
 * Pending delete operation data
 */
export interface PendingDelete {
  event: CalendarEvent;
  calendarId: string;
  user: UserConfig;
  transcription: string;
  scope?: RecurrenceScope;
}

/**
 * Get a pending delete by ID (used by callbacks)
 */
export async function getPendingDelete(pendingId: string) {
  try {
    const data = await redis.get<PendingDelete>(REDIS_KEYS.pendingDelete(pendingId));
    if (!data) return undefined;
    return data;
  } catch (error) {
    console.error('[Voice] Error getting pending delete from Redis:', error);
    captureError(error, 'voice-confirmations', {}, 'warning');
    return undefined;
  }
}

/**
 * Remove a pending delete by ID
 */
export async function removePendingDelete(pendingId: string) {
  try {
    await redis.del(REDIS_KEYS.pendingDelete(pendingId));
  } catch (error) {
    console.error('[Voice] Error removing pending delete from Redis:', error);
    captureError(error, 'voice-confirmations', {}, 'warning');
  }
}

/**
 * Format CalendarEvent date/time for display (uses string dates)
 */
function formatCalendarEventDateTime(event: CalendarEvent, language: string, allDayText: string, timezone: string): string {
  const locale = language === 'he' ? 'he-IL' : language === 'ru' ? 'ru-RU' : 'en-US';
  const startDate = new Date(event.start);
  const endDate = new Date(event.end);

  const dateOptions: Intl.DateTimeFormatOptions = {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: timezone
  };

  const timeOptions: Intl.DateTimeFormatOptions = {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: timezone
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
  language: string,
  timezone: string
): string {
  const locale = language === 'he' ? 'he-IL' : language === 'ru' ? 'ru-RU' : 'en-US';
  const changes: string[] = [];

  const timeOptions: Intl.DateTimeFormatOptions = {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: timezone
  };

  const dateOptions: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: timezone
  };

  if (updates.title && updates.title !== originalEvent.summary) {
    changes.push(`📝 ${originalEvent.summary} → ${updates.title}`);
  }

  if (updates.startTime) {
    const originalStart = new Date(originalEvent.start);
    const newStart = updates.startTime;

    const originalDateStr = originalStart.toLocaleDateString(locale, dateOptions);
    const newDateStr = newStart.toLocaleDateString(locale, dateOptions);
    if (originalDateStr !== newDateStr) {
      changes.push(`📆 ${originalDateStr} → ${newDateStr}`);
    }

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
 * Format recurrence pattern for display
 */
function formatRecurrence(recurrence: ParsedEvent['recurrence'], language: string): string | null {
  if (!recurrence?.frequency) return null;

  const dayNames: Record<string, Record<string, string>> = {
    en: { MO: 'Mon', TU: 'Tue', WE: 'Wed', TH: 'Thu', FR: 'Fri', SA: 'Sat', SU: 'Sun' },
    he: { MO: 'שני', TU: 'שלישי', WE: 'רביעי', TH: 'חמישי', FR: 'שישי', SA: 'שבת', SU: 'ראשון' },
    ru: { MO: 'Пн', TU: 'Вт', WE: 'Ср', TH: 'Чт', FR: 'Пт', SA: 'Сб', SU: 'Вс' },
  };

  const freqLabels: Record<string, Record<string, string>> = {
    en: { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', yearly: 'Yearly' },
    he: { daily: 'יומי', weekly: 'שבועי', monthly: 'חודשי', yearly: 'שנתי' },
    ru: { daily: 'Ежедневно', weekly: 'Еженедельно', monthly: 'Ежемесячно', yearly: 'Ежегодно' },
  };

  const lang = language in dayNames ? language : 'en';
  const freq = freqLabels[lang][recurrence.frequency] || recurrence.frequency;

  let result = `🔄 ${freq}`;

  if (recurrence.daysOfWeek && recurrence.daysOfWeek.length > 0) {
    const days = recurrence.daysOfWeek.map(d => dayNames[lang][d] || d).join(', ');
    result += ` (${days})`;
  }

  if (recurrence.interval && recurrence.interval > 1) {
    result += ` x${recurrence.interval}`;
  }

  return result;
}

/**
 * Format ParsedEvent date/time for display
 */
export function formatEventDateTime(event: ParsedEvent, language: string, allDayText: string, timezone: string): string {
  const locale = language === 'he' ? 'he-IL' : language === 'ru' ? 'ru-RU' : 'en-US';

  const dateOptions: Intl.DateTimeFormatOptions = {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: timezone
  };

  const timeOptions: Intl.DateTimeFormatOptions = {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: timezone
  };

  const dateStr = event.startTime.toLocaleDateString(locale, dateOptions);
  const startTimeStr = event.startTime.toLocaleTimeString(locale, timeOptions);
  const endTimeStr = event.endTime.toLocaleTimeString(locale, timeOptions);

  const recurrenceStr = formatRecurrence(event.recurrence, language);

  if (event.allDay) {
    return recurrenceStr
      ? `📆 ${dateStr} (${allDayText})\n${recurrenceStr}`
      : `📆 ${dateStr} (${allDayText})`;
  }

  const base = `📆 ${dateStr}\n🕐 ${startTimeStr} - ${endTimeStr}`;
  return recurrenceStr ? `${base}\n${recurrenceStr}` : base;
}

/**
 * Show event creation confirmation with inline keyboard
 */
export async function showEventConfirmation(
  chatId: number,
  messageId: number,
  event: ParsedEvent,
  transcription: string,
  user: UserConfig,
  adminFooter?: string
): Promise<void> {
  const bot = getBot();
  const t = await getBotMessages(user.language || 'en');
  const timezone = await resolveUserTimezone(user);

  const pendingId = `${chatId}:${Date.now()}`;

  // Store in Redis with TTL (survives serverless cold starts)
  await redis.set(REDIS_KEYS.pendingEvent(pendingId), { event, user, transcription }, { ex: PENDING_TTL_SECONDS });

  const dateTimeStr = formatEventDateTime(event, user.language || 'en', t.voice.allDay, timezone);
  const locationStr = event.location ? `\n📍 ${event.location}` : '';
  const calendarStr = event.calendarName ? `\n📁 ${event.calendarName}` : '';

  const confirmationMessage =
    `${t.voice.confirmTitle}\n\n` +
    `<b>${event.title}</b>\n` +
    `${dateTimeStr}${locationStr}${calendarStr}\n\n` +
    `<i>${t.voice.from} "${escapeHtml(transcription)}"</i>` +
    (adminFooter || '');

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
 * Show edit confirmation with inline keyboard
 */
export async function showEditConfirmation(
  chatId: number,
  messageId: number,
  originalEvent: CalendarEvent,
  calendarId: string,
  updates: UpdateEventData,
  transcription: string,
  user: UserConfig,
  scope?: RecurrenceScope,
  adminFooter?: string
): Promise<void> {
  const bot = getBot();
  const t = await getBotMessages(user.language || 'en');
  const timezone = await resolveUserTimezone(user);

  const pendingId = `${chatId}:${Date.now()}`;

  await redis.set(REDIS_KEYS.pendingEdit(pendingId), { originalEvent, calendarId, updates, user, transcription, scope }, { ex: PENDING_TTL_SECONDS });

  const currentInfo = formatCalendarEventDateTime(originalEvent, user.language || 'en', t.voice?.allDay || 'All day', timezone);
  const changesInfo = formatEditChanges(originalEvent, updates, user.language || 'en', timezone);

  const editTitle = t.voice?.editConfirmTitle || '📝 <b>Edit this event?</b>';
  const currentLabel = t.voice?.currentEvent || 'Current:';
  const changesLabel = t.voice?.changes || 'Changes:';
  const confirmBtn = t.voice?.confirmEditButton || '✅ Confirm Edit';
  const cancelBtn = t.voice?.cancelButton || '❌ Cancel';
  const fromLabel = t.voice?.from || 'From:';

  // Show scope info for recurring events
  let scopeInfo = '';
  if (scope === 'all' && originalEvent.recurringEventId) {
    const scopeLabels: Record<string, string> = {
      en: '🔄 Applies to: ALL events in series',
      he: '🔄 חל על: כל האירועים בסדרה',
      ru: '🔄 Применяется к: ВСЕМ событиям серии'
    };
    scopeInfo = `\n${scopeLabels[user.language || 'en'] || scopeLabels.en}\n`;
  } else if (scope === 'following' && originalEvent.recurringEventId) {
    const scopeLabels: Record<string, string> = {
      en: '🔄 Applies to: This and all FUTURE events',
      he: '🔄 חל על: אירוע זה וכל העתידיים',
      ru: '🔄 Применяется к: Этому и ВСЕМ будущим событиям'
    };
    scopeInfo = `\n${scopeLabels[user.language || 'en'] || scopeLabels.en}\n`;
  }

  const confirmationMessage =
    `${editTitle}\n\n` +
    `<b>${currentLabel}</b>\n` +
    `📅 ${originalEvent.summary}\n` +
    `${currentInfo}${scopeInfo}\n\n` +
    `<b>${changesLabel}</b>\n` +
    `${changesInfo}\n\n` +
    `<i>${fromLabel} "${escapeHtml(transcription)}"</i>` +
    (adminFooter || '');

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
 * Show delete confirmation with inline keyboard
 */
export async function showDeleteConfirmation(
  chatId: number,
  messageId: number,
  event: CalendarEvent,
  calendarId: string,
  transcription: string,
  user: UserConfig,
  scope?: RecurrenceScope,
  adminFooter?: string
): Promise<void> {
  const bot = getBot();
  const t = await getBotMessages(user.language || 'en');
  const timezone = await resolveUserTimezone(user);

  const pendingId = `${chatId}:${Date.now()}`;

  await redis.set(REDIS_KEYS.pendingDelete(pendingId), { event, calendarId, user, transcription, scope }, { ex: PENDING_TTL_SECONDS });

  const eventInfo = formatCalendarEventDateTime(event, user.language || 'en', t.voice?.allDay || 'All day', timezone);

  const deleteTitle = t.voice?.deleteConfirmTitle || '🗑️ <b>Delete this event?</b>';
  const deleteBtn = t.voice?.deleteButton || '🗑️ Delete';
  const keepBtn = t.voice?.keepButton || '❌ Keep';
  const fromLabel = t.voice?.from || 'From:';

  // Show scope info for recurring events
  let scopeInfo = '';
  if (scope === 'all' && event.recurringEventId) {
    const scopeLabels: Record<string, string> = {
      en: '🔄 Will delete: ALL events in series',
      he: '🔄 ימחק: כל האירועים בסדרה',
      ru: '🔄 Будет удалено: ВСЕ события серии'
    };
    scopeInfo = `\n${scopeLabels[user.language || 'en'] || scopeLabels.en}\n`;
  } else if (scope === 'following' && event.recurringEventId) {
    const scopeLabels: Record<string, string> = {
      en: '🔄 Will delete: This and all FUTURE events',
      he: '🔄 ימחק: אירוע זה וכל העתידיים',
      ru: '🔄 Будет удалено: Это и ВСЕ будущие события'
    };
    scopeInfo = `\n${scopeLabels[user.language || 'en'] || scopeLabels.en}\n`;
  }

  const confirmationMessage =
    `${deleteTitle}\n\n` +
    `📅 <b>${event.summary}</b>\n` +
    `${eventInfo}${scopeInfo}\n\n` +
    `<i>${fromLabel} "${escapeHtml(transcription)}"</i>` +
    (adminFooter || '');

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

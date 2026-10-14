/**
 * Voice confirmation UI
 * Shows confirmation messages for event creation, editing, and deletion
 * Pending operations stored in Redis for serverless compatibility
 */

import { redis } from '../../utils/redis';
import { getBot } from '../telegram';
import { ParsedEvent, RecurrenceScope } from '../event-parser';
import { CalendarEvent, UpdateEventData } from '../calendar';
import { resolveUserTimezone } from '../../lib/timezone';
import { UserConfig } from '../../types';
import { getBotMessage, getBotMessages } from '../../lib/bot-messages';
import { formatInTimeZone } from 'date-fns-tz';
import { addDaysToDate, localDate } from '../../utils/day-events';
import { MessageFormat } from '../messaging/types';
import type { IMessagingService } from '../messaging/types';
import { refreshReminderNotice } from '../native-reminders/resolve';
import type { ReminderFailure } from '../native-reminders/resolve';
import { REDIS_KEYS } from '../../config/redis-keys';
import { captureError } from '../../lib/error-capture';
import { daysBetween, describeEdit, EditSpan } from './event-resolution';
import { escapeHtml } from '../../utils/html';

// Voice modules import escapeHtml from here; anything outside voice imports src/utils/html.
export { escapeHtml } from '../../utils/html';

const PENDING_TTL_SECONDS = 600; // 10 minutes

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
    const data = await redis.get<{
      event: ParsedEvent;
      user: UserConfig;
      transcription: string;
      inputModality?: 'voice' | 'text' | 'image';
    }>(REDIS_KEYS.pendingEvent(pendingId));
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
export function formatCalendarEventDateTime(event: CalendarEvent, language: string, allDayText: string, timezone: string): string {
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
    // Its own date: read as an instant it is UTC midnight, the day before west of UTC
    const day = new Date(`${event.start}T12:00:00Z`).toLocaleDateString(locale, { ...dateOptions, timeZone: 'UTC' });
    return `📆 ${day} (${allDayText})`;
  }

  return `📆 ${dateStr}\n🕐 ${startTimeStr} - ${endTimeStr}`;
}

/**
 * Format the changes being made to an event. Its days and times come from describeEdit,
 * on the user's clock: an all-day event's own dates, never its date read as an instant.
 */
export function formatEditChanges(
  originalEvent: CalendarEvent,
  updates: UpdateEventData,
  language: string,
  timezone: string,
  allDayText: string
): string {
  const locale = language === 'he' ? 'he-IL' : language === 'ru' ? 'ru-RU' : 'en-US';
  const changes: string[] = [];

  // A yyyy-MM-dd date as the user reads it
  const dayLabel = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString(locale, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC'
  });

  if (updates.title && updates.title !== originalEvent.summary) {
    changes.push(`📝 ${originalEvent.summary} → ${updates.title}`);
  }

  const { before, after } = describeEdit(originalEvent, updates, timezone);

  // The date: a timed event's start day, an all-day event's first to last day
  const days = (span: EditSpan) =>
    span.allDay && span.lastDay !== span.firstDay ? `${dayLabel(span.firstDay)} – ${dayLabel(span.lastDay)}` : dayLabel(span.firstDay);
  if (days(before) !== days(after)) {
    changes.push(`📆 ${days(before)} → ${days(after)}`);
  }

  // The time: a timed event's start, or its whole span when only the end moves. A span is
  // the same when its end time and its length in days are: one that crosses midnight moved
  // to another day keeps both, and the date line shows the move.
  const time = (span: EditSpan) => (span.allDay ? allDayText : span.startTime);
  const timeSpan = (span: EditSpan) =>
    `${span.startTime} - ${span.lastDay !== span.firstDay ? `${dayLabel(span.lastDay)} ` : ''}${span.endTime}`;
  const sameSpan = before.endTime === after.endTime &&
    daysBetween(before.firstDay, before.lastDay) === daysBetween(after.firstDay, after.lastDay);
  if (time(before) !== time(after)) {
    changes.push(`🕐 ${time(before)} → ${time(after)}`);
  } else if (!after.allDay && !sameSpan) {
    changes.push(`🕐 ${timeSpan(before)} → ${timeSpan(after)}`);
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
 * When a reminder fires, as its card and the bulk card list it: the short date and time
 * in the user's language ("Thu, Oct 15, 10:00"), or the date alone for a date-only one.
 * No end: a reminder has no length. Never relative: "📆 on Thu, Oct 15 at 10:00" reads
 * wrong on a card. The created reply uses formatReminderRelativeWhen instead.
 */
export function formatReminderWhen(
  event: Pick<ParsedEvent, 'startTime' | 'allDay'>,
  language: string,
  timezone: string
): string {
  const locale = language === 'he' ? 'he-IL' : language === 'ru' ? 'ru-RU' : 'en-US';
  const date: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric', timeZone: timezone };
  return event.allDay
    ? event.startTime.toLocaleDateString(locale, date)
    : event.startTime.toLocaleString(locale, { ...date, hour: '2-digit', minute: '2-digit', hour12: false });
}

/**
 * When a reminder fires, as the created reply says it (plan ruling 6): "today at 17:00",
 * "tomorrow at 10:00" or "on Fri, Oct 16 at 10:00", and "today", "tomorrow" or "Fri,
 * Oct 16" for a date-only one, from the when.* copy. Today is the user's own day
 * (`timezone`), not the server's. `{date}` is formatReminderWhen's short date.
 */
export async function formatReminderRelativeWhen(
  event: Pick<ParsedEvent, 'startTime' | 'allDay'>,
  language: string,
  timezone: string
): Promise<string> {
  const day = localDate(event.startTime, timezone);
  const today = localDate(new Date(), timezone);
  const relative = day === today ? 'today' : day === addDaysToDate(today, 1) ? 'tomorrow' : 'date';
  const date = formatReminderWhen({ startTime: event.startTime, allDay: true }, language, timezone);
  if (event.allDay) return getBotMessage(language, `nativeReminders.when.${relative}`, { date });
  const time = formatInTimeZone(event.startTime, timezone, 'HH:mm');
  return getBotMessage(language, `nativeReminders.when.${relative}At`, { date, time });
}

/** Telegram's HTML or WhatsApp's own markup, for text both platforms show. */
const MARKUP = {
  html: { bold: (s: string) => `<b>${s}</b>`, italic: (s: string) => `<i>${s}</i>`, text: escapeHtml },
  whatsapp: { bold: (s: string) => `*${s}*`, italic: (s: string) => `_${s}_`, text: (s: string) => s },
};

/**
 * A reminder's card (spec §3.3): its title, when it fires and for whom, and anything
 * that keeps it from pinging. No end time and no calendar: a reminder has no length and
 * always goes on its creator's main calendar.
 */
export async function formatReminderCard(
  event: ParsedEvent,
  language: string,
  timezone: string,
  markup: keyof typeof MARKUP = 'html'
): Promise<string> {
  const m = MARKUP[markup];
  const t = await getBotMessages(language);
  const forPartner = event.forUserId != null && event.forName
    ? ` · ${await getBotMessage(language, 'nativeReminders.card.forPartner', { name: m.text(event.forName) })}`
    : '';
  const lines = [
    await getBotMessage(language, 'nativeReminders.card.title', { title: m.bold(m.text(event.title)) }),
    `📆 ${formatReminderWhen(event, language, timezone)}${forPartner}`,
  ];
  const recurrence = formatRecurrence(event.recurrence, language);
  if (recurrence) lines.push(recurrence);
  if (event.location) lines.push(`📍 ${m.text(event.location)}`);
  if (event.reminderNotice === 'no_time_set') {
    lines.push('', m.italic(t.nativeReminders.card.noTimeSet));
  } else if (event.reminderNotice === 'partner_not_on_telegram') {
    const name = m.text(event.forName || '');
    lines.push('', m.italic(await getBotMessage(language, 'nativeReminders.card.partnerNotOnTelegram', { name })));
  }
  return lines.join('\n');
}

/**
 * The line saying a reminder is set: for whom and when ("tomorrow at 10:00"), or just the
 * day for a date-only one. `html` escapes the partner's name for Telegram; WhatsApp and
 * speech take it as is.
 */
export async function reminderCreatedLine(
  event: ParsedEvent,
  language: string,
  timezone: string,
  html = true
): Promise<string> {
  const when = await formatReminderRelativeWhen(event, language, timezone);
  if (event.allDay) return getBotMessage(language, 'nativeReminders.created.dateOnly', { when });
  if (event.forUserId != null && event.forName) {
    const name = html ? escapeHtml(event.forName) : event.forName;
    return getBotMessage(language, 'nativeReminders.created.partner', { name, when });
  }
  return getBotMessage(language, 'nativeReminders.created.self', { when });
}

/** What a reminder's card says once the reminder is created (confirmed or auto-created). */
export async function formatReminderCreated(event: ParsedEvent, language: string, timezone: string): Promise<string> {
  const recurrence = formatRecurrence(event.recurrence, language);
  return `${await reminderCreatedLine(event, language, timezone)}\n\n<b>${escapeHtml(event.title)}</b>` +
    (recurrence ? `\n${recurrence}` : '');
}

const ANCHOR_QUESTIONS = { anchor_not_found: 'notFound', anchor_ambiguous: 'ambiguous', anchor_needs_time: 'needsTime' } as const;

/** What to ask when a reminder set relative to an event ("an hour before the dentist") can't be placed. */
export function anchorQuestion(failure: ReminderFailure, language: string, html = true): Promise<string> {
  return getBotMessage(language, `nativeReminders.anchor.${ANCHOR_QUESTIONS[failure.error]}`, {
    description: html ? escapeHtml(failure.description) : failure.description,
  });
}

/** Ask about each reminder in a message that couldn't be placed (Telegram). */
export async function sendAnchorQuestions(
  chatId: number | string,
  failures: ReminderFailure[],
  language: string,
  service: IMessagingService
): Promise<void> {
  for (const failure of failures) {
    await service.sendMessage(chatId, await anchorQuestion(failure, language), { format: MessageFormat.HTML });
  }
}

/**
 * Show event creation confirmation with inline keyboard
 */
export async function showEventConfirmation(
  chatId: number,
  messageId: number | undefined,
  event: ParsedEvent,
  transcription: string,
  user: UserConfig,
  adminFooter?: string,
  inputModality: 'voice' | 'text' | 'image' = 'voice'
): Promise<void> {
  const bot = getBot();
  const t = await getBotMessages(user.language || 'en');
  const timezone = await resolveUserTimezone(user);

  const pendingId = `${chatId}:${Date.now()}`;

  // A reminder's notice is worked out again on every showing: a quick fix or a reply may
  // have given it a time since it was resolved.
  const reminder = event.kind === 'reminder';
  const shown = reminder ? refreshReminderNotice(event, timezone) : event;

  // Store in Redis with TTL (survives serverless cold starts).
  // PR 12: inputModality threads through so callbacks know whether to voice
  // the outcome (preserves voice-in/voice-out for the same conversation).
  await redis.set(REDIS_KEYS.pendingEvent(pendingId), { event: shown, user, transcription, inputModality }, { ex: PENDING_TTL_SECONDS });

  let body: string;
  if (reminder) {
    body = await formatReminderCard(shown, user.language || 'en', timezone);
  } else {
    const dateTimeStr = formatEventDateTime(event, user.language || 'en', t.voice.allDay, timezone);
    const locationStr = event.location ? `\n📍 ${escapeHtml(event.location)}` : '';
    const calendarStr = event.calendarName ? `\n📁 ${escapeHtml(event.calendarName)}` : '';
    body = `${t.voice.confirmTitle}\n\n<b>${escapeHtml(event.title)}</b>\n${dateTimeStr}${locationStr}${calendarStr}`;
  }

  const confirmationMessage =
    `${body}\n\n` +
    `<i>${t.voice.from} "${escapeHtml(transcription)}"</i>` +
    (adminFooter || '');

  // Quick-correction shortcut row (PR 10 polish): one tap re-prompts for just
  // one field of the pending event. Only show "Cal" when user has multiple
  // calendars to pick from — otherwise the button is meaningless. A reminder
  // never offers it: it always goes on the creator's main calendar.
  const calendarCount = (user.calendarAssignments?.length ?? 0);
  const quickRow: Array<{ text: string; callback_data: string }> = [
    { text: t.voice?.fixTime || '⏰ Time', callback_data: `event_fix:time:${pendingId}` },
    { text: t.voice?.fixDay || '📅 Day', callback_data: `event_fix:day:${pendingId}` },
  ];
  if (calendarCount > 1 && !reminder) {
    quickRow.push({ text: t.voice?.fixCal || '📁 Cal', callback_data: `event_fix:cal:${pendingId}` });
  }

  // A partner who can't be pinged: confirming keeps the reminder as the creator's
  const createLabel = shown.reminderNotice === 'partner_not_on_telegram'
    ? t.nativeReminders.card.keepAsMine
    : t.voice.createButton;

  const replyMarkup = {
    inline_keyboard: [
      [
        { text: createLabel, callback_data: `event_create:${pendingId}` },
        { text: t.voice.cancelButton, callback_data: `event_cancel:${pendingId}` }
      ],
      quickRow,
    ]
  };

  if (messageId) {
    await bot.editMessageText(confirmationMessage, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
      reply_markup: replyMarkup,
    });
    // Store reverse mapping for reply-to-correct
    await redis.set(REDIS_KEYS.pendingReply(chatId, messageId), pendingId, { ex: PENDING_TTL_SECONDS });
  } else {
    const sentMessage = await bot.sendMessage(chatId, confirmationMessage, {
      parse_mode: 'HTML',
      reply_markup: replyMarkup,
    });
    // Store reverse mapping for reply-to-correct
    await redis.set(REDIS_KEYS.pendingReply(chatId, sentMessage.message_id), pendingId, { ex: PENDING_TTL_SECONDS });
  }
}

/**
 * Show edit confirmation with inline keyboard
 */
export async function showEditConfirmation(
  chatId: number,
  messageId: number | undefined,
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
  const changesInfo = formatEditChanges(originalEvent, updates, user.language || 'en', timezone, t.voice?.allDay || 'All day');

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

  const replyMarkup = {
    inline_keyboard: [[
      { text: confirmBtn, callback_data: `edit_confirm:${pendingId}` },
      { text: cancelBtn, callback_data: `edit_cancel:${pendingId}` }
    ]]
  };

  if (messageId) {
    await bot.editMessageText(confirmationMessage, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
      reply_markup: replyMarkup,
    });
  } else {
    await bot.sendMessage(chatId, confirmationMessage, {
      parse_mode: 'HTML',
      reply_markup: replyMarkup,
    });
  }
}

/**
 * Show delete confirmation with inline keyboard
 */
export async function showDeleteConfirmation(
  chatId: number,
  messageId: number | undefined,
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

  const replyMarkup = {
    inline_keyboard: [[
      { text: deleteBtn, callback_data: `delete_confirm:${pendingId}` },
      { text: keepBtn, callback_data: `delete_cancel:${pendingId}` }
    ]]
  };

  if (messageId) {
    await bot.editMessageText(confirmationMessage, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
      reply_markup: replyMarkup,
    });
  } else {
    await bot.sendMessage(chatId, confirmationMessage, {
      parse_mode: 'HTML',
      reply_markup: replyMarkup,
    });
  }
}

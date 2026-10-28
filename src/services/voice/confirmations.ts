/**
 * Voice confirmation UI
 * Shows confirmation messages for event creation, editing, and deletion
 * Pending operations stored in Redis for serverless compatibility
 */

import { redis } from '../../utils/redis';
import { getBot } from '../telegram';
import { ParsedEvent, RecurrenceScope } from '../event-parser';
import type { VoiceIntentResult, ZmanParseError } from '../event-parser';
import { CalendarEvent, UpdateEventData } from '../calendar';
import { resolveUserTimezone } from '../../lib/timezone';
import { UserConfig } from '../../types';
import { getBotMessage, getBotMessages } from '../../lib/bot-messages';
import { formatInTimeZone } from 'date-fns-tz';
import { addDaysToDate, localDate, startOfLocalDay } from '../../utils/day-events';
import { MessageFormat } from '../messaging/types';
import type { IMessagingService } from '../messaging/types';
import { refreshReminderNotice, withZmanChoice } from '../native-reminders/resolve';
import type { ReminderCreator, ReminderFailure } from '../native-reminders/resolve';
import { offeredWords, reminderZman, showsZman, zmanList, type ZmanView } from '../native-reminders/zman-view';
import { REDIS_KEYS } from '../../config/redis-keys';
import { captureError } from '../../lib/error-capture';
import { daysBetween, describeEdit, EditSpan } from './event-resolution';
import { isReminderEvent } from '../../utils/event-formatter';
import { escapeHtml } from '../../utils/html';
import { hebrewRepeatCard } from './hebrew-repeat-card';
import { targetOf } from '../recurrence-fields';
import { liveGoogleChoices } from '../../lib/google-state';
import { openUser, sealUser } from './pending-seal';

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
 * A pending event: what its confirmation card's Create tap creates
 */
export interface PendingEventData {
  event: ParsedEvent;
  user: UserConfig;
  transcription: string;
  inputModality?: 'voice' | 'text' | 'image';
}

/**
 * Store a pending event for its card's Create tap (10 minutes). The one writer of
 * voice:pending:event:*, for the Telegram card and the WhatsApp one: the user's Google
 * token is stored sealed (pending-seal.ts).
 */
export async function setPendingEvent(pendingId: string, pending: PendingEventData): Promise<void> {
  await redis.set(REDIS_KEYS.pendingEvent(pendingId), { ...pending, user: sealUser(pending.user) }, { ex: PENDING_TTL_SECONDS });
}

/**
 * Get a pending event by ID (used by callbacks), its user's Google token opened
 */
export async function getPendingEvent(pendingId: string) {
  try {
    const data = await redis.get<PendingEventData>(REDIS_KEYS.pendingEvent(pendingId));
    if (!data) return undefined;
    // Reconstruct Date objects that were serialized as strings
    reviveDates(data.event, ['startTime', 'endTime']);
    return { ...data, user: openUser(data.user) };
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
 * Claim a pending event for the tap that creates (or cancels) it: read it and remove it, so that of several taps
 * delivered at once (Telegram may run the updates of one chat in parallel) exactly one gets it. Redis DEL answers how
 * many keys it removed, and only one of the callers that read the event removes it. The others get undefined, like an
 * expired card. Where Redis cannot be asked, the event is returned as before (logged), so a failure never blocks a tap.
 */
export async function takePendingEvent(pendingId: string): Promise<PendingEventData | undefined> {
  const pending = await getPendingEvent(pendingId);
  if (!pending) return undefined;
  try {
    const removed = await redis.del(REDIS_KEYS.pendingEvent(pendingId));
    if (removed === 0) {
      console.warn(`[Voice] pending event ${pendingId} was taken by another tap at the same moment; this one is treated as expired`);
      return undefined;
    }
  } catch (error) {
    console.error('[Voice] Error removing pending event from Redis:', error);
    captureError(error, 'voice-confirmations', {}, 'warning');
  }
  return pending;
}

/**
 * A tap on one of a reminder's opinion buttons (Telegram's event_pick, WhatsApp's reply button): the tap claims the
 * pending reminder (takePendingEvent), so a second tap at the same moment finds it gone, and the reminder becomes the
 * one with that opinion's rule, on that choice's day, its notice and pause note worked out again. It is NOT stored back:
 * the caller creates it at once, like any confirmed reminder. `expired` is a pending event that is gone (or taken by
 * another tap); `no_such_choice` is a button the reminder has no choice for (logged), and the card is put back as it was.
 */
export async function chooseZmanOpinion(
  pendingId: string,
  index: number
): Promise<{ ok: true; pending: PendingEventData } | { ok: false; reason: 'expired' } | { ok: false; reason: 'no_such_choice' | 'failed'; pending: PendingEventData }> {
  const pending = await takePendingEvent(pendingId);
  if (!pending) return { ok: false, reason: 'expired' };
  try {
    const timezone = await resolveUserTimezone(pending.user);
    const chosen = withZmanChoice(pending.event, index, timezone);
    if (!chosen) {
      console.error(`[zman-voice] user ${pending.user.id}: opinion button ${index} of ${pendingId} has no choice (${pending.event.zmanChoices?.length ?? 0} choices)`);
      await setPendingEvent(pendingId, pending);
      return { ok: false, reason: 'no_such_choice', pending };
    }
    const event = await refreshReminderNotice(chosen, timezone, new Date(), pending.user);
    return { ok: true, pending: { ...pending, event } };
  } catch (error) {
    // The tap claimed the card; a failure before the create puts it back, so the next tap can still choose.
    console.error(`[zman-voice] user ${pending.user.id}: opinion button ${index} of ${pendingId} failed before the create, the card is kept:`, error);
    captureError(error, 'zman-voice', { user_id: pending.user.id }, 'warning');
    await setPendingEvent(pendingId, pending);
    return { ok: false, reason: 'failed', pending };
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
    return { ...data, user: openUser(data.user) };
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
    return { ...data, user: openUser(data.user) };
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

  // A reminder has one time, never a range
  if (isReminderEvent(event)) return `📆 ${dateStr}\n🕐 ${startTimeStr}`;

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
    changes.push(`📝 ${escapeHtml(originalEvent.summary)} → ${escapeHtml(updates.title)}`);
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
    changes.push(`📍 ${escapeHtml(originalLoc)} → ${escapeHtml(updates.location)}`);
  }

  return changes.length > 0 ? changes.join('\n') : '(no changes detected)';
}

/**
 * Format recurrence pattern for display
 */
function formatRecurrence(recurrence: ParsedEvent['recurrence'], language: string): string | null {
  // A Hebrew repeat is worded by hebrewRepeatCard (with its Hebrew date), never as "Yearly"
  if (!recurrence?.frequency || recurrence.calendar === 'hebrew') return null;

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
 * What an event's card says about a repeat by the Hebrew date: the line with the Hebrew date, and
 * the note that an event headed for Google is added once. Nothing for any other event, which also
 * costs no provider lookup.
 */
export async function hebrewCardParts(
  event: Pick<ParsedEvent, 'recurrence' | 'startTime' | 'calendarId' | 'kind'>,
  user: UserConfig,
  language: string,
  timezone: string
): Promise<{ line: string | null; notices: string[] }> {
  if (event.recurrence?.calendar !== 'hebrew') return { line: null, notices: [] };
  return hebrewRepeatCard(event, await targetOf(user, event), language, timezone);
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
 * A reminder by zman's date and time, as formatReminderWhen says a timed one, but on the 24-hour clock all night (en-US
 * writes midnight "24:03" with hour12: false): the zman's own time, in the zone it is counted in.
 */
function formatZmanTime(at: Date, language: string, zone: string): string {
  const locale = language === 'he' ? 'he-IL' : language === 'ru' ? 'ru-RU' : 'en-US';
  return at.toLocaleString(locale, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: zone });
}

/**
 * When a reminder fires as a card or the bulk list says it. A plain one: formatReminderWhen. One by zman: its first
 * time at the recipient's place and the rule ("Wed, Oct 28, 08:27 · 10 min before the latest time for Shema (GRA)");
 * with the opinion still to choose, the day and the rule (the times are the buttons').
 */
export function formatReminderWhenWithRule(
  event: Pick<ParsedEvent, 'startTime' | 'allDay'>,
  view: ZmanView | null,
  language: string,
  timezone: string
): string {
  if (!view) return formatReminderWhen(event, language, timezone);
  const when = view.at ? formatZmanTime(view.at, language, view.zone) : formatReminderWhen(event, language, timezone);
  return `${when} · ${view.words}`;
}

/**
 * When a reminder fires, as the created reply says it (plan ruling 6): "today at 17:00",
 * "tomorrow at 10:00" or "on Fri, Oct 16 at 10:00", and "today", "tomorrow" or "Fri,
 * Oct 16" for a date-only one, from the when.* copy (Russian says the day plus the long
 * month: "16 октября"). Today is the user's own day
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
  // Russian says the date as "16 октября", not as a timestamp "пт, 16 окт."
  const date = language === 'ru'
    ? event.startTime.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: timezone })
    : formatReminderWhen({ startTime: event.startTime, allDay: true }, language, timezone);
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
  markup: keyof typeof MARKUP = 'html',
  creator?: ReminderCreator
): Promise<string> {
  const m = MARKUP[markup];
  const t = await getBotMessages(language);
  // A reminder by zman: its rule, its time at the recipient's place and where that is from (null for a plain one)
  const view = await reminderZman(event, creator, language, timezone);
  const forPartner = event.forUserId != null && event.forBoth
    ? ` · ${await getBotMessage(language, 'nativeReminders.card.forBoth')}${view ? ` · ${await getBotMessage(language, 'nativeReminders.zman.eachOwnPlace')}` : ''}`
    : event.forUserId != null && event.forName
      ? ` · ${await getBotMessage(language, 'nativeReminders.card.forPartner', { name: m.text(event.forName) })}`
      : '';
  const lines = [
    await getBotMessage(language, 'nativeReminders.card.title', { title: m.bold(m.text(event.title)) }),
    `📆 ${formatReminderWhenWithRule(event, view, language, timezone)}${forPartner}`,
  ];
  // A reminder is always the creator's own, on the built-in calendar
  const hebrew = await hebrewRepeatCard(event, 'native', language, timezone);
  const recurrence = hebrew.line ?? formatRecurrence(event.recurrence, language);
  if (recurrence) lines.push(recurrence);
  if (event.location) lines.push(`📍 ${m.text(event.location)}`);
  if (view?.choices) {
    lines.push('', await getBotMessage(language, 'nativeReminders.zman.whichOpinion'));
    // WhatsApp's buttons name the opinion alone, so its body carries each one's time; Telegram's buttons carry it
    if (markup === 'whatsapp') for (const label of await zmanChoiceLabels(event, view, language, timezone)) lines.push(`• ${label}`);
  }
  for (const note of await zmanNotes(event, view, language, m.text)) lines.push('', m.italic(note));
  if (event.reminderNotice === 'no_time_set') {
    lines.push('', m.italic(t.nativeReminders.card.noTimeSet));
  } else if (event.reminderNotice === 'time_passed') {
    lines.push('', m.italic(t.nativeReminders.card.timePassed));
  } else if (event.reminderNotice === 'partner_not_on_telegram') {
    const name = m.text(event.forName || '');
    // With opinions to choose, a tap on one keeps it as the creator's (there is no "Keep it as yours?" button to answer)
    const key = view?.choices ? 'nativeReminders.card.partnerNotOnTelegramPick' : 'nativeReminders.card.partnerNotOnTelegram';
    lines.push('', m.italic(await getBotMessage(language, key, { name })));
  }
  for (const notice of hebrew.notices) lines.push('', m.italic(notice));
  return lines.join('\n');
}

/**
 * The one-line notes under a reminder by zman: its time is counted from the time zone's main city (no place saved), and
 * a one-off inside its recipient's paused Shabbat or Yom Tov will not be sent. `text` escapes a name for the card's markup.
 */
async function zmanNotes(event: ParsedEvent, view: ZmanView | null, language: string, text: (s: string) => string): Promise<string[]> {
  if (!view) return [];
  const notes: string[] = [];
  if (view.source === 'zone') {
    notes.push(view.forPartner
      ? await getBotMessage(language, 'nativeReminders.zman.zoneOnlyPartner', { name: text(event.forName || '') })
      : await getBotMessage(language, 'nativeReminders.zman.zoneOnly'));
  }
  if (view.choices) {
    // Held for everyone it pings, and (a reminder to both) held for one of the two: each has its own line
    const all = view.choices.length;
    const held = view.choices.filter((c) => c.paused === true);
    const heldForOne = view.choices.filter((c) => c.paused === 'one');
    if (held.length === all) notes.push(await getBotMessage(language, 'nativeReminders.zman.paused'));
    else if (held.length > 0) notes.push(await getBotMessage(language, 'nativeReminders.zman.pausedSome', { opinions: zmanList(held.map((c) => c.name), language) }));
    if (heldForOne.length === all) notes.push(await getBotMessage(language, 'nativeReminders.zman.pausedOne'));
    else if (heldForOne.length > 0) notes.push(await getBotMessage(language, 'nativeReminders.zman.pausedOneSome', { opinions: zmanList(heldForOne.map((c) => c.name), language) }));
  } else if (event.reminderPaused) {
    notes.push(await getBotMessage(language, event.reminderPaused === 'one' ? 'nativeReminders.zman.pausedOne' : 'nativeReminders.zman.paused'));
  }
  return notes;
}

/**
 * When each opinion of a reminder whose opinion is still to choose is due, in the set's order: the time, with the day
 * word (today, tomorrow or the date) before it when that choice's day is not the card's ("tomorrow 08:27"). Empty
 * where that opinion has no time at the recipient's place.
 */
export async function zmanChoiceWhens(event: ParsedEvent, view: ZmanView, language: string, timezone: string): Promise<string[]> {
  const cardDay = localDate(event.startTime, timezone);
  return Promise.all((view.choices ?? []).map(async (choice) => {
    const dayWord = choice.day === cardDay
      ? null
      : await formatReminderRelativeWhen({ startTime: startOfLocalDay(choice.day, timezone), allDay: true }, language, timezone);
    return [dayWord, choice.time].filter(Boolean).join(' ');
  }));
}

/**
 * The buttons of a reminder whose opinion is still to choose, in the set's order: "<opinion> · <hh:mm>", with the day
 * word (today, tomorrow or the date) before the time when that choice's day is not the card's.
 */
export async function zmanChoiceLabels(event: ParsedEvent, view: ZmanView, language: string, timezone: string): Promise<string[]> {
  const whens = await zmanChoiceWhens(event, view, language, timezone);
  return (view.choices ?? []).map((choice, i) => (whens[i] ? `${choice.name} · ${whens[i]}` : choice.name));
}

/**
 * The line saying a reminder is set: for whom and when ("tomorrow at 10:00"), or just the
 * day for a date-only one. One whose time had already passed promises no ping, whoever
 * it is for. `html` escapes the partner's name for Telegram; WhatsApp and speech take it
 * as is.
 */
export async function reminderCreatedLine(
  event: ParsedEvent,
  language: string,
  timezone: string,
  html = true,
  creator?: ReminderCreator
): Promise<string> {
  if (event.reminderNotice === 'time_passed') return getBotMessage(language, 'nativeReminders.created.passed');
  // A reminder by zman is told at its time ("today at 08:27: 10 min before ..."), with no time where there is none that day
  const view = await reminderZman(event, creator, language, timezone);
  let when = view?.at
    ? await formatReminderRelativeWhen({ startTime: view.at, allDay: false }, language, view.zone)
    : await formatReminderRelativeWhen(event, language, timezone);
  if (view) when = await getBotMessage(language, 'nativeReminders.when.byZman', { when, rule: view.words });
  const dateOnly = view ? view.at === null : event.allDay;
  if (event.forUserId != null && event.forBoth) {
    return getBotMessage(language, dateOnly ? 'nativeReminders.created.bothDateOnly' : 'nativeReminders.created.both', { when });
  }
  const forPartner = event.forUserId != null && !!event.forName;
  const name = forPartner ? (html ? escapeHtml(event.forName!) : event.forName!) : '';
  if (dateOnly) {
    return forPartner
      ? getBotMessage(language, 'nativeReminders.created.partnerDateOnly', { name, when })
      : getBotMessage(language, 'nativeReminders.created.dateOnly', { when });
  }
  if (forPartner) {
    return getBotMessage(language, 'nativeReminders.created.partner', { name, when });
  }
  return getBotMessage(language, 'nativeReminders.created.self', { when });
}

/** The note under the reply of a one-off by zman inside its recipient's paused Shabbat or Yom Tov: it is created and will not be sent. Null for any other. */
export async function reminderPausedNote(event: ParsedEvent, language: string): Promise<string | null> {
  if (!showsZman(event) || !event.reminderPaused) return null;
  return getBotMessage(language, event.reminderPaused === 'one' ? 'nativeReminders.zman.pausedOne' : 'nativeReminders.zman.paused');
}

/** What a reminder's card says once the reminder is created (confirmed or auto-created). */
export async function formatReminderCreated(event: ParsedEvent, language: string, timezone: string, creator?: ReminderCreator): Promise<string> {
  const recurrence = (await hebrewRepeatCard(event, 'native', language, timezone)).line ?? formatRecurrence(event.recurrence, language);
  // A one-off by zman inside Shabbat or Yom Tov is created, and the reply says it will not be sent
  const pausedNote = await reminderPausedNote(event, language);
  const paused = pausedNote ? `\n\n<i>${pausedNote}</i>` : '';
  return `${await reminderCreatedLine(event, language, timezone, true, creator)}\n\n<b>${escapeHtml(event.title)}</b>` +
    (recurrence ? `\n${recurrence}` : '') + paused;
}

const ANCHOR_QUESTIONS = {
  anchor_not_found: 'anchor.notFound',
  anchor_ambiguous: 'anchor.ambiguous',
  anchor_needs_time: 'anchor.needsTime',
  zman_not_offered: 'zman.notOffered',
  zman_no_place: 'zman.noPlace',
  zman_no_time: 'zman.noTime',
} as const satisfies Record<ReminderFailure['error'], string>;

/**
 * What to ask when a reminder can't be placed: one set relative to an event ("an hour before the dentist"), or one
 * by zman (not a zman the set has, no place to count it from, or no such time that day). A missing place that is
 * the partner's names them.
 */
export async function anchorQuestion(failure: ReminderFailure, language: string, html = true): Promise<string> {
  const text = (s: string) => (html ? escapeHtml(s) : s);
  let key: string = ANCHOR_QUESTIONS[failure.error];
  const params: Record<string, string> = { description: text(failure.description), ...(failure.name ? { name: text(failure.name) } : {}) };
  if (failure.error === 'zman_no_place' && failure.name) key = 'zman.noPlacePartner';
  if (failure.error === 'zman_not_offered') {
    if (failure.zmanRefusal === 'bad_offset') {
      key = 'zman.badOffset';
    } else if (failure.zmanRefusal === 'not_offered' && failure.offered?.length) {
      // An opinion the set lacks: name what it has for that zman
      const words = await offeredWords(failure.offered, failure.offeredOpinions ?? [], language);
      if (words) {
        key = 'zman.notOfferedOpinion';
        params.zman = words.zman;
        params.opinions = words.opinions;
      }
    }
  }
  return getBotMessage(language, `nativeReminders.${key}`, params);
}

const ZMAN_PARSE_QUESTIONS = {
  unreadable: 'zman.parseUnreadable',
  with_anchor: 'zman.parseAnchor',
  with_clock_time: 'zman.parseClockTime',
  not_a_reminder: 'zman.parseNotReminder',
} as const satisfies Record<ZmanParseError, string>;

/**
 * What to say when the parser refused a reminder by zman (a zman it could not read, or one with an anchor, a clock time
 * or an event): one line saying what to change, in place of "I couldn't understand that" with event examples. Null when
 * none of the results was refused for that, so the caller falls back to its general answer. The first one asked about.
 */
export async function zmanParseQuestion(results: Array<Pick<VoiceIntentResult, 'zmanParseError'> | undefined>, language: string): Promise<string | null> {
  const reason = results.find((r) => r?.zmanParseError)?.zmanParseError;
  return reason ? getBotMessage(language, `nativeReminders.${ZMAN_PARSE_QUESTIONS[reason]}`) : null;
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
  const shown = reminder ? await refreshReminderNotice(event, timezone, new Date(), user) : event;

  // Store in Redis with TTL (survives serverless cold starts).
  // PR 12: inputModality threads through so callbacks know whether to voice
  // the outcome (preserves voice-in/voice-out for the same conversation).
  await setPendingEvent(pendingId, { event: shown, user, transcription, inputModality });

  let body: string;
  if (reminder) {
    body = await formatReminderCard(shown, user.language || 'en', timezone, 'html', user);
  } else {
    const hebrew = await hebrewCardParts(event, user, user.language || 'en', timezone);
    const dateTimeStr = formatEventDateTime(event, user.language || 'en', t.voice.allDay, timezone) + (hebrew.line ? `\n${hebrew.line}` : '');
    const locationStr = event.location ? `\n📍 ${escapeHtml(event.location)}` : '';
    const calendarStr = event.calendarName ? `\n📁 ${escapeHtml(event.calendarName)}` : '';
    const noticeStr = hebrew.notices.map(notice => `\n\n<i>${notice}</i>`).join('');
    body = `${t.voice.confirmTitle}\n\n<b>${escapeHtml(event.title)}</b>\n${dateTimeStr}${locationStr}${calendarStr}${noticeStr}`;
  }

  const confirmationMessage =
    `${body}\n\n` +
    `<i>${t.voice.from} "${escapeHtml(transcription)}"</i>` +
    (adminFooter || '');

  // Quick-correction shortcut row (PR 10 polish): one tap re-prompts for just
  // one field of the pending event. Only show "Cal" when user has multiple
  // calendars to pick from — otherwise the button is meaningless. A reminder
  // never offers it: it always goes on the creator's main calendar.
  const calendarCount = liveGoogleChoices(user).length;
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

  // A reminder by zman whose opinion is unsaid: one button per opinion with its time, in place of Create. A tap
  // creates it (event_pick), through the same path as Create.
  const choiceView = reminder && shown.allDay && shown.zmanChoices?.length
    ? await reminderZman(shown, user, user.language || 'en', timezone)
    : null;
  const choiceRows = choiceView?.choices
    ? (await zmanChoiceLabels(shown, choiceView, user.language || 'en', timezone)).map((text, i) => [{ text, callback_data: `event_pick:${i}:${pendingId}` }])
    : null;

  const replyMarkup = {
    inline_keyboard: choiceRows
      ? [...choiceRows, [{ text: t.voice.cancelButton, callback_data: `event_cancel:${pendingId}` }], quickRow]
      : [
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

  // The user's Google token is stored sealed (pending-seal.ts); getPendingEdit opens it
  await redis.set(REDIS_KEYS.pendingEdit(pendingId), { originalEvent, calendarId, updates, user: sealUser(user), transcription, scope }, { ex: PENDING_TTL_SECONDS });

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
    `📅 ${escapeHtml(originalEvent.summary)}\n` +
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

  // The user's Google token is stored sealed (pending-seal.ts); getPendingDelete opens it
  await redis.set(REDIS_KEYS.pendingDelete(pendingId), { event, calendarId, user: sealUser(user), transcription, scope }, { ex: PENDING_TTL_SECONDS });

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
      he: '🔄 יימחקו: כל האירועים בסדרה',
      ru: '🔄 Будет удалено: ВСЕ события серии'
    };
    scopeInfo = `\n${scopeLabels[user.language || 'en'] || scopeLabels.en}\n`;
  } else if (scope === 'following' && event.recurringEventId) {
    const scopeLabels: Record<string, string> = {
      en: '🔄 Will delete: This and all FUTURE events',
      he: '🔄 יימחקו: אירוע זה וכל העתידיים',
      ru: '🔄 Будет удалено: Это и ВСЕ будущие события'
    };
    scopeInfo = `\n${scopeLabels[user.language || 'en'] || scopeLabels.en}\n`;
  }

  const confirmationMessage =
    `${deleteTitle}\n\n` +
    `📅 <b>${escapeHtml(event.summary)}</b>\n` +
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

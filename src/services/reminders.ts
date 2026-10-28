/**
 * Event Reminders Service
 * Sends Telegram reminders for calendar events based on their reminder settings.
 * For kids' events, sends both start and end (pickup) reminders.
 */

import { redis } from '../utils/redis';
import { CalendarEvent, CalendarAssignment, UserConfig } from '../types';
import { fetchEventsInRange, getCalendarAssignmentsForUser, hasUsableCalendar } from './calendar-provider';
import { getBot } from './telegram';
import { getTelegramService, getWhatsAppService } from './messaging/factory';
import { MessageFormat } from './messaging/types';
import { getWhatsAppChatId } from './user-service';
import { trackActivityAsync } from './analytics-service';
import { checkFeatureAccess, incrementUsage } from './subscription-service';
import { REDIS_KEYS } from '../config/redis-keys';
import { resolveUserTimezone } from '../lib/timezone';
import { isPaused } from './zmanim/pause';
import { getBotMessages } from '../lib/bot-messages';
import { captureError } from '../lib/error-capture';
import { markUnreachableAfterSendFailure } from '../lib/user-reachability';
import { isAllDayEvent } from '../utils/event-formatter';
import { localDate, nextDate } from '../utils/day-events';
import { escapeHtml } from '../utils/html';
import { MAX_LEAD_MINUTES, defaultLeadOf, nearestReminderLead } from '../lib/calendar-view/alert-leads';


const REMINDER_TTL_SECONDS = 86400; // 24 hours
// MAX_LEAD_MINUTES (alert-leads.ts, one source with the editor's list) is the longest lead
// the bot sends. A ping for an event on a later calendar day than the ping says so
// ("tomorrow at 10:00", formatReminderMessage), so it never reads as starting now. A longer
// lead is skipped.

export type ReminderType = 'start' | 'pickup';

export interface DueReminder {
  event: CalendarEvent;
  type: ReminderType;
  reminderTime: Date;
  eventTime: Date;
  calendarAssignment?: CalendarAssignment;
  isAutoReminder: boolean;  // true if using user's default, false if event has its own reminder
  sentKeyDate: string;  // reminderTime's date in the user's timezone; checked and marked under the same key
}

/**
 * Get the reminder minutes for an event
 * Priority: the event's own alert (a FamCal event's, set in the editor) > the event's Google reminders > user default > 0 (at event time)
 * Returns both the minutes and whether it's an auto-reminder (using default); null when the
 * event is set to no alert at all.
 */
function getReminderMinutes(event: CalendarEvent, user: Pick<UserConfig, 'defaultReminderMinutes'>): { minutes: number; isAuto: boolean } | null {
  // A FamCal event with an alert of its own: its lead, or none (an empty list).
  if (event.alertLeads) {
    if (event.alertLeads.length === 0) return null;
    return { minutes: Math.min(...event.alertLeads), isAuto: false };
  }

  // Check event-specific reminders: the nearest of the popups (or, without one, the emails).
  // Taking the first one dropped the 30-minute popup of an event that also has "1 day before".
  const lead = nearestReminderLead(event.reminders?.overrides);
  if (lead !== null) return { minutes: lead, isAuto: false };

  // Fall back to user default
  return { minutes: defaultLeadOf(user), isAuto: true };
}

/**
 * Whether a reminder at `reminderTime` for `eventTime` (a start, or an end for a pickup)
 * is sent: up to MAX_LEAD_MINUTES ahead. A longer lead is skipped: it would fall on a day
 * the ping's "tomorrow" can't name.
 */
function isSendable(reminderTime: Date, eventTime: Date): boolean {
  return eventTime.getTime() - reminderTime.getTime() <= MAX_LEAD_MINUTES * 60 * 1000;
}

/**
 * Generate a unique key for a reminder to track if it's been sent
 */
function getReminderKey(userId: number, eventId: string, type: ReminderType, date: string): string {
  return REDIS_KEYS.reminder(userId, eventId, type, date);
}

/**
 * Check if a reminder has already been sent
 */
async function isReminderSent(userId: number, eventId: string, type: ReminderType, date: string): Promise<boolean> {
  const key = getReminderKey(userId, eventId, type, date);
  try {
    const exists = await redis.exists(key);
    return exists === 1;
  } catch (error) {
    console.error('[Reminders] Error checking reminder status:', error);
    captureError(error, 'reminders-check-status', { userId, eventId }, 'warning');
    return false; // On error, allow sending (better to duplicate than miss)
  }
}

/**
 * Mark a reminder as sent
 */
async function markReminderSent(userId: number, eventId: string, type: ReminderType, date: string): Promise<void> {
  const key = getReminderKey(userId, eventId, type, date);
  try {
    await redis.set(key, '1', { ex: REMINDER_TTL_SECONDS });
  } catch (error) {
    console.error('[Reminders] Error marking reminder as sent:', error);
    captureError(error, 'reminders-mark-sent', { userId, eventId }, 'warning');
  }
}

/**
 * Check if an event belongs to a kids calendar
 */
function isKidsEvent(event: CalendarEvent, assignments?: CalendarAssignment[]): boolean {
  if (!assignments) return false;
  const assignment = assignments.find(a => a.calendarId === event.calendarId);
  return assignment?.labels.includes('kids') ?? false;
}

/**
 * Get calendar assignment for an event
 */
function getCalendarAssignment(event: CalendarEvent, assignments?: CalendarAssignment[]): CalendarAssignment | undefined {
  if (!assignments) return undefined;
  return assignments.find(a => a.calendarId === event.calendarId);
}

/**
 * Calculate due reminders for a user within a time window
 * @param user - User configuration
 * @param windowMinutes - Time window in minutes (e.g., 5 for 5-minute cron interval)
 */
export async function getDueReminders(
  user: UserConfig,
  windowMinutes: number = 5,
  timezone?: string
): Promise<DueReminder[]> {
  if (!(await hasUsableCalendar(user))) {
    return [];
  }
  const assignments = await getCalendarAssignmentsForUser(user);
  const calendarIds = assignments.map(a => a.calendarId);
  if (calendarIds.length === 0) {
    return [];
  }

  // Truncate to minute boundary to avoid millisecond edge cases
  // e.g., now = 12:35:06 → 12:35:00, so window is [12:35:00, 12:40:00)
  // On the epoch, not through local fields: setSeconds(0, 0) reads the server's own clock, which in the
  // repeated hour of a clock change takes the first occurrence and sends "now" an hour back.
  const now = new Date(Math.floor(Date.now() / 60_000) * 60_000);
  const windowEnd = new Date(now.getTime() + windowMinutes * 60 * 1000);
  const dueReminders: DueReminder[] = [];

  // Fetch the events a reminder in this window can belong to: those starting or ending
  // up to MAX_LEAD_MINUTES after it. Fetching "today" dropped every reminder whose event
  // lay past the user's midnight (23:55 for a 00:10 start). Both providers return what
  // overlaps the range; it opens a minute early because an event ending exactly at its
  // opening is left out, and a pickup at 0 minutes falls on that end.
  const tz = timezone ?? (await resolveUserTimezone(user));
  // Split by calendar id (spec §4 Providers): a failed half is logged and reported by the
  // fetch itself, and the other half's alerts still go out (a Google outage keeps FamCal's).
  let events: CalendarEvent[];
  try {
    const fetched = await fetchEventsInRange(
      user,
      calendarIds,
      new Date(now.getTime() - 60 * 1000),
      new Date(windowEnd.getTime() + MAX_LEAD_MINUTES * 60 * 1000)
    );
    events = fetched.events;
    if (fetched.failed.length > 0) console.warn(`[Reminders] user ${user.id}: no alerts this run from ${fetched.failed.join(', ')} (the fetch failed)`);
  } catch (error) {
    console.error(`[Reminders] Error fetching events for user ${user.telegramId}:`, error);
    captureError(error, 'reminders-fetch-events', { telegramId: user.telegramId }, 'warning');
    return [];
  }

  for (const event of events) {
    if (!event.eventId) continue;
    // A built-in calendar reminder pings through its own pass (src/services/native-reminders).
    // An alert here would ping it again, a pickup one on a kids calendar too, and for both partners.
    if (event.eventType === 'reminder') continue;
    // An all-day event has no start or pickup time; its date alone would become a
    // reminder at midnight UTC (3 AM in Israel).
    if (isAllDayEvent(event)) continue;

    const startTime = new Date(event.start);
    const endTime = new Date(event.end);
    const lead = getReminderMinutes(event, user);
    // An event set to no alert pings neither at its start nor at its pickup.
    if (!lead) continue;
    const { minutes: reminderMinutes, isAuto } = lead;

    // Debug logging with actual times
    const startTimeStr = startTime.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz });
    const endTimeStr = endTime.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz });
    const nowStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz });
    const windowEndStr = windowEnd.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz });
    console.log(`[Reminders] Event: ${event.summary}, start: ${startTimeStr}, end: ${endTimeStr}, window: [${nowStr}-${windowEndStr}), reminderMin: ${reminderMinutes}`);

    // Check START reminder
    const startReminderTime = new Date(startTime.getTime() - reminderMinutes * 60 * 1000);
    if (startReminderTime >= now && startReminderTime < windowEnd && isSendable(startReminderTime, startTime)) {
      // Check if already sent. The key's date is the reminder's own, not the server's
      // today: a run whose window overlaps the last one must find its mark even when the
      // server's date turned in between (20:00 in New York on a UTC server).
      const sentKeyDate = localDate(startReminderTime, tz);
      const alreadySent = await isReminderSent(user.id, event.eventId, 'start', sentKeyDate);
      if (!alreadySent) {
        dueReminders.push({
          event,
          type: 'start',
          reminderTime: startReminderTime,
          eventTime: startTime,
          calendarAssignment: getCalendarAssignment(event, assignments),
          isAutoReminder: isAuto,
          sentKeyDate,
        });
      }
    }

    // Check PICKUP reminder (only for kids' events, when pickup reminders are enabled)
    if (isKidsEvent(event, assignments) && user.pickupRemindersEnabled !== false) {
      const pickupReminderTime = new Date(endTime.getTime() - reminderMinutes * 60 * 1000);
      const pickupReminderTimeStr = pickupReminderTime.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz });
      console.log(`[Reminders] Pickup check: ${event.summary}, pickupAt: ${endTimeStr}, reminderTime: ${pickupReminderTimeStr}, inWindow: ${pickupReminderTime >= now && pickupReminderTime < windowEnd}`);
      if (pickupReminderTime >= now && pickupReminderTime < windowEnd && isSendable(pickupReminderTime, endTime)) {
        // Check if already sent
        const sentKeyDate = localDate(pickupReminderTime, tz);
        const alreadySent = await isReminderSent(user.id, event.eventId, 'pickup', sentKeyDate);
        if (!alreadySent) {
          dueReminders.push({
            event,
            type: 'pickup',
            reminderTime: pickupReminderTime,
            eventTime: endTime,
            calendarAssignment: getCalendarAssignment(event, assignments),
            isAutoReminder: isAuto,
            sentKeyDate,
          });
        }
      }
    }
  }

  return dueReminders;
}

/**
 * When the ping says the event is, as the clause after the clock: the same-day form on the
 * ping's own day (the wording these alerts always had); the tomorrow form when the
 * event is on the next calendar day, and the weekday and date when it is further. `pingAt` is
 * when the ping goes out, the days are the user's.
 */
async function eventWhen(
  type: ReminderType,
  eventTime: Date,
  pingAt: Date,
  timeStr: string,
  language: string,
  timezone: string
): Promise<string> {
  const pingDay = localDate(pingAt, timezone);
  const eventDay = localDate(eventTime, timezone);
  const lang = ['en', 'he', 'ru'].includes(language) ? language : 'en';
  const t = (await getBotMessages(lang)).eventAlertWhen as Record<string, string>;
  if (eventDay <= pingDay) return t[type === 'start' ? 'startsAt' : 'pickupAt'].replace('{time}', timeStr);

  if (eventDay === nextDate(pingDay)) return t[type === 'start' ? 'startsTomorrow' : 'pickupTomorrow'].replace('{time}', timeStr);
  const locale = lang === 'he' ? 'he-IL' : lang === 'ru' ? 'ru-RU' : 'en-GB';
  const day = eventTime.toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short', timeZone: timezone });
  return t[type === 'start' ? 'startsOn' : 'pickupOn'].replace('{day}', day).replace('{time}', timeStr);
}

/**
 * Format reminder message based on type, language, and source (event vs auto)
 */
async function formatReminderMessage(
  reminder: DueReminder,
  language: string = 'en',
  timezone?: string,
  pingAt: Date = new Date()
): Promise<string> {
  const { event, type, eventTime, isAutoReminder } = reminder;
  const tz = timezone || 'UTC';
  const timeStr = eventTime.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: tz,
  });
  const when = await eventWhen(type, eventTime, pingAt, timeStr, language, tz);
  // Titles and names are the user's own text inside HTML: a "<" or "&" in one made
  // Telegram refuse the whole message, and the alert was lost.
  const title = escapeHtml(event.summary);
  const location = event.location ? `\n📍 ${escapeHtml(event.location)}` : '';

  // Get calendar name for start reminders
  const calendarName = escapeHtml(reminder.calendarAssignment?.name || event.calendarName);
  // Get child name from calendar name for kids events (pickup reminders)
  const childName = calendarName;

  const messages: Record<string, Record<ReminderType, { event: string; auto: string }>> = {
    en: {
      start: {
        event: `🔔 <b>Reminder: ${title}</b>\n📅 ${calendarName}\n⏰ ${when}${location}`,
        auto: `🤖 <b>Auto-Reminder: ${title}</b>\n📅 ${calendarName}\n⏰ ${when}${location}`,
      },
      pickup: {
        event: `🚗 <b>Pickup Reminder: ${childName}</b>\n⏰ ${when}${location}`,
        auto: `🤖🚗 <b>Auto-Pickup Reminder: ${childName}</b>\n⏰ ${when}${location}`,
      },
    },
    he: {
      start: {
        event: `🔔 <b>תזכורת: ${title}</b>\n📅 ${calendarName}\n⏰ ${when}${location}`,
        auto: `🤖 <b>תזכורת אוטומטית: ${title}</b>\n📅 ${calendarName}\n⏰ ${when}${location}`,
      },
      pickup: {
        event: `🚗 <b>תזכורת איסוף: ${childName}</b>\n⏰ ${when}${location}`,
        auto: `🤖🚗 <b>תזכורת איסוף אוטומטית: ${childName}</b>\n⏰ ${when}${location}`,
      },
    },
    ru: {
      start: {
        event: `🔔 <b>Напоминание: ${title}</b>\n📅 ${calendarName}\n⏰ ${when}${location}`,
        auto: `🤖 <b>Авто-напоминание: ${title}</b>\n📅 ${calendarName}\n⏰ ${when}${location}`,
      },
      pickup: {
        event: `🚗 <b>Напоминание о заборе: ${childName}</b>\n⏰ ${when}${location}`,
        auto: `🤖🚗 <b>Авто-напоминание о заборе: ${childName}</b>\n⏰ ${when}${location}`,
      },
    },
  };

  const lang = messages[language] ? language : 'en';
  return isAutoReminder ? messages[lang][type].auto : messages[lang][type].event;
}

/**
 * Send a reminder to a user
 */
export async function sendReminder(
  user: UserConfig,
  reminder: DueReminder,
  timezone?: string
): Promise<boolean> {
  const platform = user.messagingPlatform || 'telegram';
  const message = await formatReminderMessage(reminder, user.language, timezone);
  let sent = false;

  try {
    // Send to Telegram if applicable
    if ((platform === 'telegram' || platform === 'all') && user.telegramId) {
      const bot = getBot();
      const service = getTelegramService(bot);
      await service.sendMessage(user.telegramId, message, { format: MessageFormat.HTML });
      sent = true;
    }

    // Send to WhatsApp if applicable
    const waChatId = getWhatsAppChatId(user);
    if ((platform === 'whatsapp' || platform === 'all') && waChatId) {
      const waService = getWhatsAppService();
      await waService.sendMessage(waChatId, message, { format: MessageFormat.HTML });
      sent = true;
    }

    if (!sent) {
      console.log(`[Reminders] No delivery channel for user ${user.id}`);
      return false;
    }

    // Mark as sent, under the key getDueReminders checked
    if (reminder.event.eventId) {
      await markReminderSent(user.id, reminder.event.eventId, reminder.type, reminder.sentKeyDate);
    }

    trackActivityAsync(user.id, 'reminder_sent', {
      reminder_type: reminder.type,
      minutes_before: getReminderMinutes(reminder.event, user)?.minutes,
    });
    incrementUsage(user.id, 'reminders').catch(err => {
      console.error('[Subscription] Failed to increment reminders:', err);
      captureError(err, 'reminders-increment-usage', { user_id: user.id }, 'warning');
    });

    console.log(`[Reminders] Sent ${reminder.type} reminder to user ${user.id} for event: ${reminder.event.summary}`);
    return true;
  } catch (error) {
    // A 403 means the chat will never take our messages again. Record it, so the hourly
    // sync leaves the user out, instead of failing here every five minutes.
    if (await markUnreachableAfterSendFailure(user, error)) return false;
    console.error(`[Reminders] Error sending reminder to user ${user.id}:`, error);
    captureError(error, 'reminders-send', { user_id: user.id });
    return false;
  }
}

/**
 * Process reminders for a single user
 * @param user - User configuration
 * @param windowMinutes - Time window in minutes (should match cron interval)
 */
export async function processUserReminders(user: UserConfig, windowMinutes: number = 5): Promise<number> {
  // Check subscription feature access for reminders (Pro feature)
  const reminderAccess = await checkFeatureAccess(user.id, 'reminders');
  if (!reminderAccess.allowed) {
    // If user had reminders enabled, send one-time downgrade notification
    // Shabbat and Yom Tov (the pause): the notice waits; it is not marked sent, so the next run after the window sends it.
    if (user.remindersEnabled && user.telegramId && !(await isPaused(user, new Date(), 'reminders downgrade notice'))) {
      const redisKey = REDIS_KEYS.reminderDowngradeNotified(user.id);
      try {
        const alreadyNotified = await redis.get(redisKey);
        if (!alreadyNotified) {
          const { sendReminderDowngradeNotification } = await import('./telegram');
          await sendReminderDowngradeNotification(user.telegramId, user.language || 'en');
          await redis.set(redisKey, '1', { ex: 30 * 24 * 60 * 60 }); // 30-day TTL
          console.log(`[Reminders] Sent downgrade notification to user ${user.telegramId}`);
        }
      } catch (error) {
        console.error(`[Reminders] Failed to send downgrade notification for user ${user.telegramId}:`, error);
        captureError(error, 'reminders-downgrade-notify', { telegramId: user.telegramId }, 'warning');
      }
    }
    return 0;
  }

  const timezone = await resolveUserTimezone(user);
  const dueReminders = await getDueReminders(user, windowMinutes, timezone);
  let sentCount = 0;

  for (const reminder of dueReminders) {
    // Shabbat and Yom Tov (the pause): the alert is not sent, and not sent later either: the 5-minute run only
    // covers the alerts due in its own window, so a skipped one is gone. The pause is read at the instant the
    // alert would go out (this run), so a run that starts inside the window sends nothing, whatever it covers.
    if (await isPaused(user, new Date(), 'event alert')) continue;
    const success = await sendReminder(user, reminder, timezone);
    if (success) sentCount++;
  }

  return sentCount;
}

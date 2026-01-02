/**
 * Event Reminders Service
 * Sends Telegram reminders for calendar events based on their reminder settings.
 * For kids' events, sends both start and end (pickup) reminders.
 */

import { Redis } from '@upstash/redis';
import { CalendarEvent, CalendarAssignment, UserConfig } from '../types';
import { fetchTodayEvents, TIMEZONE } from './calendar';
import { getBot } from './telegram';
import { getTelegramService } from './messaging/factory';
import { MessageFormat } from './messaging/types';
import { format } from 'date-fns';

// Initialize Redis client
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const REMINDER_KEY_PREFIX = 'reminder:';
const REMINDER_TTL_SECONDS = 86400; // 24 hours

export type ReminderType = 'start' | 'pickup';

export interface DueReminder {
  event: CalendarEvent;
  type: ReminderType;
  reminderTime: Date;
  eventTime: Date;
  calendarAssignment?: CalendarAssignment;
  isAutoReminder: boolean;  // true if using user's default, false if event has its own reminder
}

/**
 * Get the reminder minutes for an event
 * Priority: event reminders > user default > 0 (at event time)
 * Returns both the minutes and whether it's an auto-reminder (using default)
 */
function getReminderMinutes(event: CalendarEvent, userDefault?: number): { minutes: number; isAuto: boolean } {
  // Check event-specific reminders
  if (event.reminders?.overrides?.length) {
    // Use the first popup/email reminder (prefer popup)
    const popup = event.reminders.overrides.find(r => r.method === 'popup');
    const any = event.reminders.overrides[0];
    const minutes = popup?.minutes ?? any?.minutes;
    if (minutes !== undefined) {
      return { minutes, isAuto: false };
    }
  }

  // Fall back to user default
  return { minutes: userDefault ?? 0, isAuto: true };
}

/**
 * Generate a unique key for a reminder to track if it's been sent
 */
function getReminderKey(userId: number, eventId: string, type: ReminderType, date: string): string {
  return `${REMINDER_KEY_PREFIX}${userId}:${eventId}:${type}:${date}`;
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
  windowMinutes: number = 5
): Promise<DueReminder[]> {
  const calendarIds = user.calendarAssignments?.map(a => a.calendarId) || [];
  if (!calendarIds.length || !user.googleRefreshToken) {
    return [];
  }

  // Fetch today's events
  let events: CalendarEvent[];
  try {
    events = await fetchTodayEvents(user.googleRefreshToken, calendarIds);
  } catch (error) {
    console.error(`[Reminders] Error fetching events for user ${user.telegramId}:`, error);
    return [];
  }

  const now = new Date();
  const windowEnd = new Date(now.getTime() + windowMinutes * 60 * 1000);
  const dateStr = format(now, 'yyyy-MM-dd');
  const dueReminders: DueReminder[] = [];

  for (const event of events) {
    if (!event.eventId) continue;

    const startTime = new Date(event.start);
    const endTime = new Date(event.end);
    const { minutes: reminderMinutes, isAuto } = getReminderMinutes(event, user.defaultReminderMinutes ?? undefined);

    // Check START reminder
    const startReminderTime = new Date(startTime.getTime() - reminderMinutes * 60 * 1000);
    if (startReminderTime >= now && startReminderTime < windowEnd) {
      // Check if already sent
      const alreadySent = await isReminderSent(user.telegramId, event.eventId, 'start', dateStr);
      if (!alreadySent) {
        dueReminders.push({
          event,
          type: 'start',
          reminderTime: startReminderTime,
          eventTime: startTime,
          calendarAssignment: getCalendarAssignment(event, user.calendarAssignments),
          isAutoReminder: isAuto,
        });
      }
    }

    // Check PICKUP reminder (only for kids' events)
    if (isKidsEvent(event, user.calendarAssignments)) {
      const pickupReminderTime = new Date(endTime.getTime() - reminderMinutes * 60 * 1000);
      if (pickupReminderTime >= now && pickupReminderTime < windowEnd) {
        // Check if already sent
        const alreadySent = await isReminderSent(user.telegramId, event.eventId, 'pickup', dateStr);
        if (!alreadySent) {
          dueReminders.push({
            event,
            type: 'pickup',
            reminderTime: pickupReminderTime,
            eventTime: endTime,
            calendarAssignment: getCalendarAssignment(event, user.calendarAssignments),
            isAutoReminder: isAuto,
          });
        }
      }
    }
  }

  return dueReminders;
}

/**
 * Format reminder message based on type, language, and source (event vs auto)
 */
function formatReminderMessage(
  reminder: DueReminder,
  language: string = 'en'
): string {
  const { event, type, eventTime, isAutoReminder } = reminder;
  // Format time in Israel timezone
  const timeStr = eventTime.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: TIMEZONE,
  });
  const location = event.location ? `\n📍 ${event.location}` : '';

  // Get child name from calendar name for kids events
  const childName = reminder.calendarAssignment?.name || event.calendarName;

  const messages: Record<string, Record<ReminderType, { event: string; auto: string }>> = {
    en: {
      start: {
        event: `🔔 <b>Reminder: ${event.summary}</b>\n⏰ Starting at ${timeStr}${location}`,
        auto: `🤖 <b>Auto-Reminder: ${event.summary}</b>\n⏰ Starting at ${timeStr}${location}`,
      },
      pickup: {
        event: `🚗 <b>Pickup Reminder: ${childName}</b>\n⏰ Pickup at ${timeStr}${location}`,
        auto: `🤖🚗 <b>Auto-Pickup Reminder: ${childName}</b>\n⏰ Pickup at ${timeStr}${location}`,
      },
    },
    he: {
      start: {
        event: `🔔 <b>תזכורת: ${event.summary}</b>\n⏰ מתחיל ב-${timeStr}${location}`,
        auto: `🤖 <b>תזכורת אוטומטית: ${event.summary}</b>\n⏰ מתחיל ב-${timeStr}${location}`,
      },
      pickup: {
        event: `🚗 <b>תזכורת איסוף: ${childName}</b>\n⏰ איסוף ב-${timeStr}${location}`,
        auto: `🤖🚗 <b>תזכורת איסוף אוטומטית: ${childName}</b>\n⏰ איסוף ב-${timeStr}${location}`,
      },
    },
    ru: {
      start: {
        event: `🔔 <b>Напоминание: ${event.summary}</b>\n⏰ Начало в ${timeStr}${location}`,
        auto: `🤖 <b>Авто-напоминание: ${event.summary}</b>\n⏰ Начало в ${timeStr}${location}`,
      },
      pickup: {
        event: `🚗 <b>Напоминание о заборе: ${childName}</b>\n⏰ Забрать в ${timeStr}${location}`,
        auto: `🤖🚗 <b>Авто-напоминание о заборе: ${childName}</b>\n⏰ Забрать в ${timeStr}${location}`,
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
  reminder: DueReminder
): Promise<boolean> {
  try {
    const bot = getBot();
    const service = getTelegramService(bot);
    const message = formatReminderMessage(reminder, user.language);

    await service.sendMessage(user.telegramId, message, {
      format: MessageFormat.HTML,
    });

    // Mark as sent
    const dateStr = format(new Date(), 'yyyy-MM-dd');
    if (reminder.event.eventId) {
      await markReminderSent(user.telegramId, reminder.event.eventId, reminder.type, dateStr);
    }

    console.log(`[Reminders] Sent ${reminder.type} reminder to user ${user.telegramId} for event: ${reminder.event.summary}`);
    return true;
  } catch (error) {
    console.error(`[Reminders] Error sending reminder to user ${user.telegramId}:`, error);
    return false;
  }
}

/**
 * Process reminders for a single user
 * @param user - User configuration
 * @param windowMinutes - Time window in minutes (should match cron interval)
 */
export async function processUserReminders(user: UserConfig, windowMinutes: number = 5): Promise<number> {
  const dueReminders = await getDueReminders(user, windowMinutes);
  let sentCount = 0;

  for (const reminder of dueReminders) {
    const success = await sendReminder(user, reminder);
    if (success) sentCount++;
  }

  return sentCount;
}

// When a native reminder occurrence pings, and whether it may ping now (spec §4.2,
// ruling R6). Pure: no database, and no clock of its own.

import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import type { CalendarEvent } from '../../types';
import { TIMEZONE } from '../../config/constants';
import { localDate, nextDate } from '../../utils/day-events';
import { DEFAULT_REMINDER_TIME, isValidReminderTime } from '../../lib/reminder-time';

// Date-only reminders ping at the recipient's reminder time (src/lib/reminder-time.ts,
// 09:00 unless they chose another), and 💤 Tomorrow wakes at it. Every function here that
// needs it takes it as `reminderTime` (HH:mm), and reads a missing one as the default.
/** How late a ping may still go out, after downtime or a slow tick. */
export const PING_LOOKBACK_MS = 60 * 60 * 1000;
/** A reminder set for a time that has just passed still pings when it is this recent. */
export const ARMED_GRACE_MS = 15 * 60 * 1000;
/** Sends tried for one occurrence before a passing failure stops being retried. */
export const MAX_PING_ATTEMPTS = 3;

// 💤 Tomorrow tapped before this local hour means this morning: it's still the night.
const SAME_MORNING_BEFORE_HOUR = 4;

/** `reminderTime` (HH:mm) on `day` (yyyy-MM-dd) in `tz`. */
function morningOf(day: string, tz: string, reminderTime?: string | null): Date {
  const time = isValidReminderTime(reminderTime) ? reminderTime : DEFAULT_REMINDER_TIME;
  return fromZonedTime(`${day} ${time}:00`, tz);
}

/**
 * When an occurrence pings. A timed one at its start. A date-only one at
 * the recipient's reminder time in the recipient's timezone, on the date it has in the
 * event's own timezone, so a partner abroad gets it at their own time of that date.
 */
export function dueAtForOccurrence(
  occ: { startsAt: Date; allDay: boolean; timeZone: string },
  recipientTz: string,
  recipientReminderTime?: string | null
): Date {
  if (!occ.allDay) return occ.startsAt;
  return morningOf(localDate(occ.startsAt, occ.timeZone || TIMEZONE), recipientTz, recipientReminderTime);
}

/**
 * When a reminder on a digest or the calendar home is due, in the viewer's timezone:
 * its time, or the viewer's reminder time (the ping's) on its date (an all-day start is
 * already the event's own date). Lives here, in this leaf, so the calendar home's pure
 * DTO code can use it without loading Prisma; open-reminders.ts re-exports it.
 */
export function reminderDueAt(event: Pick<CalendarEvent, 'start'>, timezone: string, reminderTime?: string | null): Date {
  if (event.start.includes('T')) return new Date(event.start);
  return morningOf(event.start, timezone, reminderTime);
}

/**
 * 💤 Tomorrow: the reminder time tomorrow in `tz`, or today's when tapped between 00:00
 * and 04:00 and that time is still ahead (a reminder time of 01:00 tapped at 02:00 has
 * gone by, so it is tomorrow's).
 */
export function tomorrowMorning(now: Date, tz: string, reminderTime?: string | null): Date {
  const today = localDate(now, tz);
  const hour = Number(formatInTimeZone(now, tz, 'H'));
  if (hour < SAME_MORNING_BEFORE_HOUR) {
    const thisMorning = morningOf(today, tz, reminderTime);
    if (thisMorning.getTime() > now.getTime()) return thisMorning;
  }
  return morningOf(nextDate(today), tz, reminderTime);
}

/**
 * Whether an occurrence pings now: not done, due within the last PING_LOOKBACK_MS, not
 * set long after its own time had passed (armedAt, which a snooze ignores), and not yet
 * pinged for this due time.
 */
export function isEligible(a: {
  due: Date;
  now: Date;
  armedAt: Date | null;
  snoozed: boolean;
  lastPingedAt: Date | null;
  doneAt: Date | null;
}): boolean {
  if (a.doneAt) return false;
  const due = a.due.getTime();
  const now = a.now.getTime();
  if (due > now || due < now - PING_LOOKBACK_MS) return false;
  if (!a.snoozed && a.armedAt && due < a.armedAt.getTime() - ARMED_GRACE_MS) return false;
  return !a.lastPingedAt || a.lastPingedAt.getTime() < due;
}

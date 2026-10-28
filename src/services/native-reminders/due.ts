// When a native reminder occurrence pings, and whether it may ping now (spec §4.2,
// ruling R6). Pure: no database, and no clock of its own.

import { formatInTimeZone } from 'date-fns-tz';
import type { CalendarEvent } from '../../types';
import { TIMEZONE } from '../../config/constants';
import { localDate, nextDate, startOfLocalDay } from '../../utils/day-events';
import { wallTimeToInstant } from '../../utils/wall-time';
import { DEFAULT_REMINDER_TIME, isValidReminderTime } from '../../lib/reminder-time';
import { readZmanSpec, type ZmanClock, type ZmanSpecValue } from '../../lib/calendar-view/zman-spec';

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

/**
 * `reminderTime` (HH:mm) on `day` (yyyy-MM-dd) in `tz`. A time the clocks skip that day moves
 * forward by the jump (02:30 is 03:30), and a repeated one is its first occurrence (wall-time.ts).
 */
function morningOf(day: string, tz: string, reminderTime?: string | null): Date {
  const time = isValidReminderTime(reminderTime) ? reminderTime : DEFAULT_REMINDER_TIME;
  return wallTimeToInstant(`${day}T${time}`, tz);
}

/**
 * A reminder by zman (NativeEvent.zmanSpec): its rule, and the clock of the person it is counted for. A null clock
 * (no place can be had) leaves every occurrence without a zman time; the readers then fall back to the reminder
 * time and the pass skips it. Never stored: the time is worked out here, for the recipient and the day.
 */
export interface ZmanRule {
  spec: ZmanSpecValue;
  clock: ZmanClock | null;
}

/** A reminder's rule from its stored spec (a series column, ReminderInfo.zmanSpec), or undefined for a plain reminder. */
export function zmanRuleOf(rawSpec: unknown, clock: ZmanClock | null | undefined): ZmanRule | undefined {
  const spec = readZmanSpec(rawSpec);
  return spec ? { spec, clock: clock ?? null } : undefined;
}

/**
 * The one place a zman rule becomes a due time: the person's clock on the occurrence's civil date. Null where the
 * clock has no time (no place, or the sun does not make that zman that day: the clock has logged it).
 */
export function zmanDueAt(day: string, rule: ZmanRule): Date | null {
  return rule.clock ? rule.clock.instant(day, rule.spec) : null;
}

/**
 * An occurrence's zman time: undefined when the rule does not apply to it (a timed occurrence, a moved one given a
 * time of its own, is a fixed time), the Date when it has one, null when it applies and there is none.
 */
export function zmanDueForOccurrence(occ: { startsAt: Date; allDay: boolean; timeZone: string }, rule: ZmanRule): Date | null | undefined {
  if (!occ.allDay) return undefined;
  return zmanDueAt(localDate(occ.startsAt, occ.timeZone || TIMEZONE), rule);
}

/**
 * When an occurrence pings. A timed one at its start. A date-only one at
 * the recipient's reminder time in the recipient's timezone, on the date it has in the
 * event's own timezone, so a partner abroad gets it at their own time of that date. A date-only
 * one of a reminder by zman (`zman`) at its zman time for the recipient's place, on that date; with
 * no zman time it reads at the reminder time (the pass skips it instead: zmanDueForOccurrence).
 */
export function dueAtForOccurrence(
  occ: { startsAt: Date; allDay: boolean; timeZone: string },
  recipientTz: string,
  recipientReminderTime?: string | null,
  zman?: ZmanRule
): Date {
  if (!occ.allDay) return occ.startsAt;
  const day = localDate(occ.startsAt, occ.timeZone || TIMEZONE);
  return (zman ? zmanDueAt(day, zman) : null) ?? morningOf(day, recipientTz, recipientReminderTime);
}

/**
 * When a reminder on a digest or the calendar home is due, in the viewer's timezone:
 * its time, or the viewer's reminder time (the ping's) on its date (an all-day start is
 * already the event's own date), or, for a reminder by zman (`zman`), its zman time on that date
 * at the viewer's place. Lives here, in this leaf, so the calendar home's pure
 * DTO code can use it without loading Prisma; open-reminders.ts re-exports it.
 */
export function reminderDueAt(event: Pick<CalendarEvent, 'start'>, timezone: string, reminderTime?: string | null, zman?: ZmanRule): Date {
  if (event.start.includes('T')) return new Date(event.start);
  return (zman ? zmanDueAt(event.start, zman) : null) ?? morningOf(event.start, timezone, reminderTime);
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
 * The local day (in `tz`) a date-only occurrence pings on, as [start, end): the key of its
 * "pinged once that day" rule, whatever time of day the user's reminder time puts it at.
 */
export function pingDayOf(due: Date, tz: string): { start: Date; end: Date } {
  const day = localDate(due, tz);
  return { start: startOfLocalDay(day, tz), end: startOfLocalDay(nextDate(day), tz) };
}

/**
 * Whether an occurrence pings now: not done, due within the last PING_LOOKBACK_MS, not
 * set long after its own time had passed (armedAt, which a snooze ignores), and not yet
 * pinged for this due time.
 *
 * A date-only occurrence (`dateOnlyDay`, not snoozed) is keyed by its day, not by its due
 * instant: once pinged that day it does not ping again when the user moves their reminder time
 * later, and when they move it earlier it still pings once that day, past the catch-up window.
 */
export function isEligible(a: {
  dateOnlyDay?: { start: Date; end: Date } | null;
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
  const day = a.snoozed ? null : a.dateOnlyDay ?? null;
  if (due > now) return false;
  if (due < now - PING_LOOKBACK_MS && !(day && now < day.end.getTime())) return false;
  if (!a.snoozed && a.armedAt && due < a.armedAt.getTime() - ARMED_GRACE_MS) return false;
  if (day) return !a.lastPingedAt || a.lastPingedAt.getTime() < day.start.getTime();
  return !a.lastPingedAt || a.lastPingedAt.getTime() < due;
}

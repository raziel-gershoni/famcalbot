// The local time a reminder with no time of day pings at, and a snooze to tomorrow
// wakes at. One helper for the pass, the snooze, the voice edit and the Mini App, so
// the 09:00 default lives in one place. A leaf: no imports, so client code can use it.

/** What a user who never chose a time gets. */
export const DEFAULT_REMINDER_TIME = '09:00';
/** The picker's step, and the only minutes the server accepts. */
export const REMINDER_TIME_STEP_MINUTES = 15;

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Whether `value` is a stored reminder time: HH:mm, 24h, on a 15-minute step. */
export function isValidReminderTime(value: unknown): value is string {
  const m = typeof value === 'string' ? TIME.exec(value) : null;
  return !!m && Number(m[2]) % REMINDER_TIME_STEP_MINUTES === 0;
}

/** The user's reminder time as HH:mm: their own, or 09:00 when unset or unreadable. */
export function reminderTimeOf(user: { reminderTime?: string | null } | null | undefined): string {
  const stored = user?.reminderTime;
  return isValidReminderTime(stored) ? stored : DEFAULT_REMINDER_TIME;
}

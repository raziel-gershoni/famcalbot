// The alert an event can carry (editor upgrades spec §2), as the client, the editor routes and the
// reminders pass share it. Pure and client-safe: it imports nothing.
//
// One alert per event: the user's default lead, none, or one lead from the list below. The pass
// sends it once, that many minutes before the start (and before a kids' pickup).

/** The leads the Alert row offers, in minutes (0 = at start). The longest is MAX_LEAD_MINUTES. */
export const ALERT_LEADS: readonly number[] = [0, 5, 10, 15, 30, 60, 120, 1440];

/**
 * The longest lead the bot sends, the evening before included (23:55 for a 00:10 start): one
 * day, Google's "1 day before". A longer one is skipped by the pass.
 */
export const MAX_LEAD_MINUTES = 1440;

/** The API value and the form's: the user's default, no alert, or a lead in minutes. */
export type AlertChoice = 'default' | 'none' | number;

/** An alert as the store keeps it: `own` false = the default; own with no minutes = none. */
export interface AlertColumns {
  ownAlerts: boolean;
  alertMinutes: number[];
}

/** Whether `value` is an alert the API takes: 'default', 'none' or one of ALERT_LEADS. */
export function parseAlertChoice(value: unknown): AlertChoice | null {
  if (value === 'default' || value === 'none') return value;
  return typeof value === 'number' && ALERT_LEADS.includes(value) ? value : null;
}

/** The store's columns for a choice. */
export function alertColumns(choice: AlertChoice): AlertColumns {
  if (choice === 'default') return { ownAlerts: false, alertMinutes: [] };
  return { ownAlerts: true, alertMinutes: choice === 'none' ? [] : [choice] };
}

/** The choice a stored alert reads as (a stored lead may be off the list: a migrated one). */
export function alertChoiceOf(columns: AlertColumns): AlertChoice {
  if (!columns.ownAlerts) return 'default';
  return columns.alertMinutes.length === 0 ? 'none' : Math.min(...columns.alertMinutes);
}

/** A lead worded by its largest whole unit: divisible by 1440 is days, by 60 hours, else minutes (the copy's `before`). */
export function leadParts(minutes: number): { unit: 'minute' | 'hour' | 'day'; count: number } {
  if (minutes % 1440 === 0) return { unit: 'day', count: minutes / 1440 };
  if (minutes % 60 === 0) return { unit: 'hour', count: minutes / 60 };
  return { unit: 'minute', count: minutes };
}

/** The user's default lead in minutes (Settings; none set = at start). One rule for the pass and the editor. */
export const defaultLeadOf = (user: { defaultReminderMinutes?: number | null }): number => user.defaultReminderMinutes ?? 0;

/**
 * The lead a Google event's own reminders give: the nearest popup, else the nearest email
 * (the pass's rule), or null when it has none. An event that also has "1 day before" is
 * reminded at its 30-minute popup too, not only a day ahead.
 */
export function nearestReminderLead(overrides: ReadonlyArray<{ method?: string | null; minutes?: number | null }> | null | undefined): number | null {
  const timed = (overrides ?? []).filter((r): r is { method?: string | null; minutes: number } => typeof r.minutes === 'number');
  if (timed.length === 0) return null;
  const popups = timed.filter((r) => r.method === 'popup');
  return Math.min(...(popups.length ? popups : timed).map((r) => r.minutes));
}

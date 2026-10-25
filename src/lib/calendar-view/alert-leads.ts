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

/** The user's default lead in minutes (Settings; none set = at start). One rule for the pass and the editor. */
export const defaultLeadOf = (user: { defaultReminderMinutes?: number | null }): number => user.defaultReminderMinutes ?? 0;

/**
 * The lead a Google event's own reminders give: the nearest popup, else the nearest email
 * (the pass's rule), or null when it has none. An event that also has "1 day before" is
 * reminded at its 30-minute popup too, not only a day ahead.
 */
export function nearestReminderLead(overrides: ReadonlyArray<{ method: string; minutes: number }> | undefined): number | null {
  if (!overrides?.length) return null;
  const popups = overrides.filter((r) => r.method === 'popup');
  return Math.min(...(popups.length ? popups : overrides).map((r) => r.minutes));
}

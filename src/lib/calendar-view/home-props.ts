// The calendar home's props: what the dashboard's page-data hands PageGate, and PageGate
// hands CalendarHome (Plan D). Type-only and
// client-safe: it imports nothing, so page-data, PageGate and the home's client bundle
// can all read it.

/**
 * Which ways of adding things this user can use, for the empty Agenda's hint (Ruling
 * R10). page-data computes them: `reminders` from getReminderSupport (a FamCal calendar,
 * Telegram and the native-reminders switch), `voiceEvents` from the voice_events feature.
 */
export type HomeHints = { reminders: boolean; voiceEvents: boolean };

export type CalendarHomeProps = {
  user: { id: number; name: string; isAdmin: boolean };
  locale: string;
  calendarSource: 'GOOGLE' | 'NATIVE';
  needsOAuth: boolean;
  needsCalendars: boolean;
  hints: HomeHints;
  /**
   * The trial's days left, for the home's trial banner (spec §7.2); null when there is no
   * trial (or the user is an early adopter). Absent means unknown: no banner.
   */
  trialDaysLeft?: number | null;
  /**
   * Whether a location is set, for "Set your location for the right times" (spec §7.2).
   * Absent means unknown: no banner.
   */
  hasLocation?: boolean;
  /**
   * The "always show 7 days" setting, for the Send sheet's This week dates (the bot's week
   * ends a day before the next one starts, or 7 days on with it). Absent means unknown:
   * no dates for This week.
   */
  lookahead7?: boolean;
};

// The calendar home's props: what the dashboard's page-data hands PageGate, and PageGate
// hands CalendarHome, when the rollout switch covers the user (Plan D). Type-only and
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
};

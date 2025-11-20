export interface UserConfig {
  telegramId: number;
  name: string;
  calendars: string[];  // Google Calendar IDs to fetch events from
  googleRefreshToken: string;
  primaryCalendar: string;  // User's main personal calendar ID
  ownCalendars: string[];  // All calendars belonging to this user (personal + work)
  spouseCalendars: string[];  // Spouse's calendar IDs
}

export interface CalendarEvent {
  summary: string;
  start: string;
  end: string;
  description?: string;
  location?: string;
  calendarName: string;
  calendarId: string;
}

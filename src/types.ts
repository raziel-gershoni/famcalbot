export interface UserConfig {
  telegramId: number;
  name: string;
  calendars: string[];  // Google Calendar IDs
  greeting: string;
  eveningGreeting: string;  // Evening greeting for tomorrow's summary
  googleRefreshToken: string;
  primaryCalendar: string;  // User's personal calendar ID for personalization
}

export interface CalendarEvent {
  summary: string;
  start: string;
  end: string;
  description?: string;
  location?: string;
  calendarName: string;
}

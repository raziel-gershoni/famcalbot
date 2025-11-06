export interface UserConfig {
  telegramId: number;
  name: string;
  calendars: string[];  // Google Calendar IDs
  greeting: string;
  googleRefreshToken: string;
}

export interface CalendarEvent {
  summary: string;
  start: string;
  end: string;
  description?: string;
  location?: string;
  calendarName: string;
}

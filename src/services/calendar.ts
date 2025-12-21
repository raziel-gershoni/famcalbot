import { google } from 'googleapis';
import { CalendarEvent } from '../types';
import { getBot } from './telegram';
import { fromZonedTime } from 'date-fns-tz';
import { addDays, format } from 'date-fns';
import { TIMEZONE, ADMIN_USER_ID } from '../config/constants';
import { ALERT_MESSAGES } from '../config/messages';
import { isTokenError } from '../utils/errors';

/**
 * Get start and end of day in Israel timezone as ISO strings
 * Handles DST automatically using date-fns-tz
 */
function getDayBoundaries(daysOffset: number = 0): { start: string; end: string } {
  // Get current date in Israel timezone
  const nowInIsrael = new Date(new Date().toLocaleString('en-US', { timeZone: TIMEZONE }));

  // Add offset for tomorrow, day after, etc.
  const targetDate = addDays(nowInIsrael, daysOffset);
  const dateStr = format(targetDate, 'yyyy-MM-dd');

  // Convert Israel timezone midnight to UTC (handles DST automatically)
  // fromZonedTime converts a date in a specific timezone to UTC
  const start = fromZonedTime(`${dateStr} 00:00:00`, TIMEZONE);
  const end = fromZonedTime(`${dateStr} 23:59:59`, TIMEZONE);

  return {
    start: start.toISOString(),
    end: end.toISOString()
  };
}

/**
 * Fetch events from Google Calendar for a specific day
 * @param refreshToken - Google OAuth refresh token
 * @param calendarIds - Array of calendar IDs to fetch from
 * @param daysOffset - Number of days from today (0 = today, 1 = tomorrow, etc.)
 * @returns Array of calendar events sorted by start time
 */
async function fetchEvents(
  refreshToken: string,
  calendarIds: string[],
  daysOffset: number
): Promise<CalendarEvent[]> {
  // Create OAuth2 client
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );

  oauth2Client.setCredentials({
    refresh_token: refreshToken,
  });

  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

  // Get day boundaries in Israel timezone
  const { start, end } = getDayBoundaries(daysOffset);

  const allEvents: CalendarEvent[] = [];

  // Fetch events from each calendar
  for (const calendarId of calendarIds) {
    try {
      // Fetch calendar metadata to get the display name
      const calendarInfo = await calendar.calendars.get({
        calendarId: calendarId,
      });
      const calendarName = calendarInfo.data.summary || calendarId;

      const response = await calendar.events.list({
        calendarId: calendarId,
        timeMin: start,
        timeMax: end,
        singleEvents: true,
        orderBy: 'startTime',
        timeZone: TIMEZONE,
      });

      const events = response.data.items || [];

      for (const event of events) {
        allEvents.push({
          summary: event.summary || 'No title',
          start: event.start?.dateTime || event.start?.date || '',
          end: event.end?.dateTime || event.end?.date || '',
          description: event.description || undefined,
          location: event.location || undefined,
          calendarName: calendarName,
          calendarId: calendarId,
        });
      }
    } catch (error) {
      console.error(`Error fetching calendar ${calendarId}:`, error);

      // If it's a token error, re-throw so calling code can handle it
      if (isTokenError(error)) {
        throw new Error('GOOGLE_TOKEN_EXPIRED');
      }

      // Continue with other calendars if it's a different error (calendar-specific issue)
    }
  }

  // Sort all events by start time
  allEvents.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

  return allEvents;
}

/**
 * Fetch today's events from Google Calendar for a user
 */
export async function fetchTodayEvents(
  refreshToken: string,
  calendarIds: string[]
): Promise<CalendarEvent[]> {
  return fetchEvents(refreshToken, calendarIds, 0);
}

/**
 * Fetch tomorrow's events from Google Calendar for a user
 */
export async function fetchTomorrowEvents(
  refreshToken: string,
  calendarIds: string[]
): Promise<CalendarEvent[]> {
  return fetchEvents(refreshToken, calendarIds, 1);
}

/**
 * Calendar information returned from Google Calendar API
 */
export interface CalendarInfo {
  id: string;
  name: string;
  description: string;
  primary: boolean;
  accessRole: string;
  backgroundColor: string;
}

/**
 * List all calendars the user has access to
 * @param refreshToken - Google OAuth refresh token
 * @returns Array of calendar information
 */
export async function listUserCalendars(refreshToken: string): Promise<CalendarInfo[]> {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );

  oauth2Client.setCredentials({
    refresh_token: refreshToken,
  });

  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

  const response = await calendar.calendarList.list();
  const calendars = response.data.items || [];

  return calendars.map(cal => ({
    id: cal.id || '',
    name: cal.summary || 'Unnamed Calendar',
    description: cal.description || '',
    primary: cal.primary || false,
    accessRole: cal.accessRole || 'reader',
    backgroundColor: cal.backgroundColor || '#039BE5'
  }));
}

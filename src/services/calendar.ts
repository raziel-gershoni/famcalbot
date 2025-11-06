import { google } from 'googleapis';
import { CalendarEvent } from '../types';

const TIMEZONE = 'Asia/Jerusalem';

/**
 * Fetch today's events from Google Calendar for a user
 */
export async function fetchTodayEvents(
  refreshToken: string,
  calendarIds: string[]
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

  // Get today's date range in user's timezone
  const now = new Date();
  const startOfDay = new Date(now.toLocaleString('en-US', { timeZone: TIMEZONE }));
  startOfDay.setHours(0, 0, 0, 0);

  const endOfDay = new Date(now.toLocaleString('en-US', { timeZone: TIMEZONE }));
  endOfDay.setHours(23, 59, 59, 999);

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
        timeMin: startOfDay.toISOString(),
        timeMax: endOfDay.toISOString(),
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
        });
      }
    } catch (error) {
      console.error(`Error fetching calendar ${calendarId}:`, error);
      // Continue with other calendars even if one fails
    }
  }

  // Sort all events by start time
  allEvents.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

  return allEvents;
}

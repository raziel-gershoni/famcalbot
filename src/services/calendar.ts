import { google } from 'googleapis';
import { CalendarEvent } from '../types';
import { getBot } from './telegram';
import { fromZonedTime } from 'date-fns-tz';
import { addDays, format } from 'date-fns';

const TIMEZONE = 'Asia/Jerusalem';
const ADMIN_USER_ID = 762715667; // Raziel's Telegram ID for alerts

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

  // Get today's date boundaries in Israel timezone
  const { start, end } = getDayBoundaries(0);

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
        });
      }
    } catch (error) {
      console.error(`Error fetching calendar ${calendarId}:`, error);

      // Alert admin if it's a token issue
      if (error instanceof Error && error.message.includes('invalid_grant')) {
        try {
          const bot = getBot();
          await bot.sendMessage(
            ADMIN_USER_ID,
            '🚨 <b>URGENT: Google Calendar Token Expired!</b>\n\n' +
            'The Google refresh token is no longer valid.\n\n' +
            '<b>To fix:</b>\n' +
            '1. Run: <code>npm run get-google-token</code>\n' +
            '2. Update GOOGLE_REFRESH_TOKEN in .env and Vercel\n' +
            '3. Redeploy\n\n' +
            `Failed calendar: ${calendarId}`,
            { parse_mode: 'HTML' }
          );
        } catch (alertError) {
          console.error('Failed to send admin alert:', alertError);
        }
      }

      // Continue with other calendars even if one fails
    }
  }

  // Sort all events by start time
  allEvents.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

  return allEvents;
}

/**
 * Fetch tomorrow's events from Google Calendar for a user
 */
export async function fetchTomorrowEvents(
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

  // Get tomorrow's date boundaries in Israel timezone
  const { start, end } = getDayBoundaries(1); // 1 day offset for tomorrow

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
        });
      }
    } catch (error) {
      console.error(`Error fetching calendar ${calendarId}:`, error);

      // Alert admin if it's a token issue
      if (error instanceof Error && error.message.includes('invalid_grant')) {
        try {
          const bot = getBot();
          await bot.sendMessage(
            ADMIN_USER_ID,
            '🚨 <b>URGENT: Google Calendar Token Expired!</b>\n\n' +
            'The Google refresh token is no longer valid.\n\n' +
            '<b>To fix:</b>\n' +
            '1. Run: <code>npm run get-google-token</code>\n' +
            '2. Update GOOGLE_REFRESH_TOKEN in .env and Vercel\n' +
            '3. Redeploy\n\n' +
            `Failed calendar: ${calendarId}`,
            { parse_mode: 'HTML' }
          );
        } catch (alertError) {
          console.error('Failed to send admin alert:', alertError);
        }
      }

      // Continue with other calendars even if one fails
    }
  }

  // Sort all events by start time
  allEvents.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

  return allEvents;
}

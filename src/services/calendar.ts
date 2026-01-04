import { google, calendar_v3 } from 'googleapis';
import { CalendarEvent } from '../types';
import { getBot } from './telegram';
import { fromZonedTime } from 'date-fns-tz';
import { addDays, format } from 'date-fns';
import { TIMEZONE } from '../config/constants';
import { ALERT_MESSAGES } from '../config/messages';
import { isTokenError } from '../utils/errors';

// Re-export TIMEZONE and CalendarEvent for convenience
export { TIMEZONE };
export type { CalendarEvent };

/**
 * Create a Google Calendar API client with OAuth credentials
 */
export function getCalendarClient(refreshToken: string): calendar_v3.Calendar {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );

  oauth2Client.setCredentials({
    refresh_token: refreshToken,
  });

  return google.calendar({ version: 'v3', auth: oauth2Client });
}

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
          eventType: event.eventType || undefined,
          recurringEventId: event.recurringEventId || undefined,
          eventId: event.id || undefined,
          reminders: event.reminders ? {
            useDefault: event.reminders.useDefault || false,
            overrides: event.reminders.overrides?.map(o => ({
              method: o.method || 'popup',
              minutes: o.minutes || 0,
            })),
          } : undefined,
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

  const response = await calendar.calendarList.list({
    showHidden: true,  // Include hidden calendars like birthdays
  });
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

/**
 * Event data for creating a new calendar event
 */
export interface CreateEventData {
  title: string;
  startTime: Date;
  endTime: Date;
  description?: string;
  location?: string;
  allDay?: boolean;
}

/**
 * Result of creating a calendar event
 */
export interface CreateEventResult {
  success: boolean;
  eventId?: string;
  eventLink?: string;
  error?: 'PERMISSION_DENIED' | 'TOKEN_EXPIRED' | 'UNKNOWN_ERROR';
  errorMessage?: string;
}

/**
 * Create a new event in Google Calendar
 * @param refreshToken - Google OAuth refresh token
 * @param calendarId - Calendar ID to create event in (use 'primary' for user's main calendar)
 * @param eventData - Event details
 * @returns Result with event ID and link, or error information
 */
export async function createEvent(
  refreshToken: string,
  calendarId: string,
  eventData: CreateEventData
): Promise<CreateEventResult> {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );

  oauth2Client.setCredentials({
    refresh_token: refreshToken,
  });

  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

  try {
    // Build event request body
    const eventBody: calendar_v3.Schema$Event = {
      summary: eventData.title,
      description: eventData.description,
      location: eventData.location,
    };

    if (eventData.allDay) {
      // All-day event uses date format (YYYY-MM-DD)
      eventBody.start = {
        date: format(eventData.startTime, 'yyyy-MM-dd'),
        timeZone: TIMEZONE,
      };
      eventBody.end = {
        date: format(eventData.endTime, 'yyyy-MM-dd'),
        timeZone: TIMEZONE,
      };
    } else {
      // Timed event uses dateTime format (ISO 8601)
      eventBody.start = {
        dateTime: eventData.startTime.toISOString(),
        timeZone: TIMEZONE,
      };
      eventBody.end = {
        dateTime: eventData.endTime.toISOString(),
        timeZone: TIMEZONE,
      };
    }

    const response = await calendar.events.insert({
      calendarId: calendarId,
      requestBody: eventBody,
    });

    return {
      success: true,
      eventId: response.data.id || undefined,
      eventLink: response.data.htmlLink || undefined,
    };
  } catch (error) {
    console.error('Error creating calendar event:', error);

    // Check for specific error types
    if (isTokenError(error)) {
      return {
        success: false,
        error: 'TOKEN_EXPIRED',
        errorMessage: 'Google Calendar access has expired. Please re-authorize.',
      };
    }

    // Check for permission denied (scope not granted)
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage.includes('insufficientPermissions') ||
        errorMessage.includes('forbidden') ||
        errorMessage.includes('403')) {
      return {
        success: false,
        error: 'PERMISSION_DENIED',
        errorMessage: 'Calendar write permission not granted. Please authorize event creation.',
      };
    }

    return {
      success: false,
      error: 'UNKNOWN_ERROR',
      errorMessage: errorMessage,
    };
  }
}

/**
 * Fetch events from multiple calendars within a date range
 * @param refreshToken - Google OAuth refresh token
 * @param calendarIds - Array of calendar IDs to fetch from
 * @param startDate - Start of the range
 * @param endDate - End of the range
 * @returns Array of calendar events sorted by start time
 */
export async function fetchEventsInRange(
  refreshToken: string,
  calendarIds: string[],
  startDate: Date,
  endDate: Date
): Promise<CalendarEvent[]> {
  const calendar = getCalendarClient(refreshToken);

  const allEvents: CalendarEvent[] = [];

  for (const calendarId of calendarIds) {
    try {
      // Fetch calendar metadata to get the display name
      const calendarInfo = await calendar.calendars.get({
        calendarId: calendarId,
      });
      const calendarName = calendarInfo.data.summary || calendarId;

      const response = await calendar.events.list({
        calendarId: calendarId,
        timeMin: startDate.toISOString(),
        timeMax: endDate.toISOString(),
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
          eventType: event.eventType || undefined,
          recurringEventId: event.recurringEventId || undefined,
          eventId: event.id || undefined,
          reminders: event.reminders ? {
            useDefault: event.reminders.useDefault || false,
            overrides: event.reminders.overrides?.map(o => ({
              method: o.method || 'popup',
              minutes: o.minutes || 0,
            })),
          } : undefined,
        });
      }
    } catch (error) {
      console.error(`Error fetching calendar ${calendarId}:`, error);

      if (isTokenError(error)) {
        throw new Error('GOOGLE_TOKEN_EXPIRED');
      }
      // Continue with other calendars if it's a different error
    }
  }

  // Sort all events by start time
  allEvents.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

  return allEvents;
}

/**
 * Event data for updating an existing calendar event
 */
export interface UpdateEventData {
  title?: string;
  startTime?: Date;
  endTime?: Date;
  description?: string;
  location?: string;
  allDay?: boolean;
}

/**
 * Result of updating a calendar event
 */
export interface UpdateEventResult {
  success: boolean;
  eventId?: string;
  eventLink?: string;
  error?: 'PERMISSION_DENIED' | 'TOKEN_EXPIRED' | 'NOT_FOUND' | 'UNKNOWN_ERROR';
  errorMessage?: string;
}

/**
 * Update an existing event in Google Calendar
 * Uses PATCH for partial updates (only specified fields are changed)
 * @param refreshToken - Google OAuth refresh token
 * @param calendarId - Calendar ID containing the event
 * @param eventId - ID of the event to update
 * @param updates - Fields to update (only specified fields will change)
 * @returns Result with event ID and link, or error information
 */
export async function updateEvent(
  refreshToken: string,
  calendarId: string,
  eventId: string,
  updates: UpdateEventData
): Promise<UpdateEventResult> {
  const calendar = getCalendarClient(refreshToken);

  try {
    // Build update request body with only specified fields
    const updateBody: calendar_v3.Schema$Event = {};

    if (updates.title !== undefined) {
      updateBody.summary = updates.title;
    }
    if (updates.description !== undefined) {
      updateBody.description = updates.description;
    }
    if (updates.location !== undefined) {
      updateBody.location = updates.location;
    }

    // Handle time updates
    if (updates.startTime !== undefined || updates.endTime !== undefined || updates.allDay !== undefined) {
      // First fetch the current event to get existing times if needed
      const currentEvent = await calendar.events.get({
        calendarId: calendarId,
        eventId: eventId,
      });

      const existingStart = currentEvent.data.start;
      const existingEnd = currentEvent.data.end;
      const isCurrentlyAllDay = !existingStart?.dateTime;

      const newAllDay = updates.allDay ?? isCurrentlyAllDay;
      const startTime = updates.startTime ?? (existingStart?.dateTime ? new Date(existingStart.dateTime) : new Date(existingStart?.date || ''));
      const endTime = updates.endTime ?? (existingEnd?.dateTime ? new Date(existingEnd.dateTime) : new Date(existingEnd?.date || ''));

      if (newAllDay) {
        updateBody.start = {
          date: format(startTime, 'yyyy-MM-dd'),
          timeZone: TIMEZONE,
        };
        updateBody.end = {
          date: format(endTime, 'yyyy-MM-dd'),
          timeZone: TIMEZONE,
        };
      } else {
        updateBody.start = {
          dateTime: startTime.toISOString(),
          timeZone: TIMEZONE,
        };
        updateBody.end = {
          dateTime: endTime.toISOString(),
          timeZone: TIMEZONE,
        };
      }
    }

    const response = await calendar.events.patch({
      calendarId: calendarId,
      eventId: eventId,
      requestBody: updateBody,
    });

    return {
      success: true,
      eventId: response.data.id || undefined,
      eventLink: response.data.htmlLink || undefined,
    };
  } catch (error) {
    console.error('Error updating calendar event:', error);

    if (isTokenError(error)) {
      return {
        success: false,
        error: 'TOKEN_EXPIRED',
        errorMessage: 'Google Calendar access has expired. Please re-authorize.',
      };
    }

    const errorMessage = error instanceof Error ? error.message : String(error);

    // Check for not found error
    if (errorMessage.includes('notFound') || errorMessage.includes('404')) {
      return {
        success: false,
        error: 'NOT_FOUND',
        errorMessage: 'Event not found. It may have been deleted.',
      };
    }

    if (errorMessage.includes('insufficientPermissions') ||
        errorMessage.includes('forbidden') ||
        errorMessage.includes('403')) {
      return {
        success: false,
        error: 'PERMISSION_DENIED',
        errorMessage: 'You do not have permission to edit this event.',
      };
    }

    return {
      success: false,
      error: 'UNKNOWN_ERROR',
      errorMessage: errorMessage,
    };
  }
}

/**
 * Result of deleting a calendar event
 */
export interface DeleteEventResult {
  success: boolean;
  error?: 'PERMISSION_DENIED' | 'TOKEN_EXPIRED' | 'NOT_FOUND' | 'UNKNOWN_ERROR';
  errorMessage?: string;
}

/**
 * Delete an event from Google Calendar
 * @param refreshToken - Google OAuth refresh token
 * @param calendarId - Calendar ID containing the event
 * @param eventId - ID of the event to delete
 * @returns Result indicating success or error information
 */
export async function deleteEvent(
  refreshToken: string,
  calendarId: string,
  eventId: string
): Promise<DeleteEventResult> {
  const calendar = getCalendarClient(refreshToken);

  try {
    await calendar.events.delete({
      calendarId: calendarId,
      eventId: eventId,
    });

    return { success: true };
  } catch (error) {
    console.error('Error deleting calendar event:', error);

    if (isTokenError(error)) {
      return {
        success: false,
        error: 'TOKEN_EXPIRED',
        errorMessage: 'Google Calendar access has expired. Please re-authorize.',
      };
    }

    const errorMessage = error instanceof Error ? error.message : String(error);

    if (errorMessage.includes('notFound') || errorMessage.includes('404')) {
      return {
        success: false,
        error: 'NOT_FOUND',
        errorMessage: 'Event not found. It may have already been deleted.',
      };
    }

    if (errorMessage.includes('insufficientPermissions') ||
        errorMessage.includes('forbidden') ||
        errorMessage.includes('403')) {
      return {
        success: false,
        error: 'PERMISSION_DENIED',
        errorMessage: 'You do not have permission to delete this event.',
      };
    }

    return {
      success: false,
      error: 'UNKNOWN_ERROR',
      errorMessage: errorMessage,
    };
  }
}

import { google, calendar_v3 } from 'googleapis';
import { CalendarEvent } from '../types';
import { getBot } from './telegram';
import { fromZonedTime } from 'date-fns-tz';
import { addDays, format } from 'date-fns';
import { TIMEZONE } from '../config/constants';
import { ALERT_MESSAGES } from '../config/messages';
import { isTokenError, isInsufficientScopesError } from '../utils/errors';
import { captureError } from '../lib/error-capture';

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
 * Get user's timezone from Google Calendar settings
 * @param refreshToken - Google OAuth refresh token
 * @returns IANA timezone string (e.g., "Asia/Jerusalem") or null if failed
 */
export async function getUserCalendarTimezone(refreshToken: string): Promise<string | null> {
  try {
    const calendar = getCalendarClient(refreshToken);
    const response = await calendar.settings.get({ setting: 'timezone' });
    return response.data.value || null;
  } catch (error) {
    console.warn('[Calendar] Failed to fetch timezone:', error);
    return null;
  }
}

/**
 * Get start and end of day in Israel timezone as ISO strings
 * Handles DST automatically using date-fns-tz
 */
function getDayBoundaries(daysOffset: number = 0, tz: string = TIMEZONE): { start: string; end: string } {
  // Get current date in user's timezone
  const nowLocal = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));

  // Add offset for tomorrow, day after, etc.
  const targetDate = addDays(nowLocal, daysOffset);
  const dateStr = format(targetDate, 'yyyy-MM-dd');

  // Convert timezone midnight to UTC (handles DST automatically)
  // fromZonedTime converts a date in a specific timezone to UTC
  const start = fromZonedTime(`${dateStr} 00:00:00`, tz);
  const end = fromZonedTime(`${dateStr} 23:59:59`, tz);

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
  daysOffset: number,
  timezone: string = TIMEZONE
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

  // Get day boundaries in user's timezone
  const { start, end } = getDayBoundaries(daysOffset, timezone);

  // Fetch events from all calendars in parallel
  const results = await Promise.allSettled(
    calendarIds.map(async (calendarId) => {
      // Fetch calendar metadata and events in parallel
      const [calendarInfo, response] = await Promise.all([
        calendar.calendars.get({ calendarId }),
        calendar.events.list({
          calendarId,
          timeMin: start,
          timeMax: end,
          singleEvents: true,
          orderBy: 'startTime',
          timeZone: timezone,
        }),
      ]);

      const calendarName = calendarInfo.data.summary || calendarId;
      const events = response.data.items || [];

      return events.map((event): CalendarEvent => ({
        summary: event.summary || 'No title',
        start: event.start?.dateTime || event.start?.date || '',
        end: event.end?.dateTime || event.end?.date || '',
        description: event.description || undefined,
        location: event.location || undefined,
        calendarName,
        calendarId,
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
      }));
    })
  );

  // Collect events from successful fetches, re-throw critical errors
  const allEvents: CalendarEvent[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') {
      allEvents.push(...result.value);
    } else {
      const error = result.reason;
      console.error(`Error fetching calendar:`, error);
      captureError(error, 'calendar-fetch-events', undefined, 'warning');

      if (isInsufficientScopesError(error)) {
        throw new Error('GOOGLE_INSUFFICIENT_SCOPES');
      }
      if (isTokenError(error)) {
        throw new Error('GOOGLE_TOKEN_EXPIRED');
      }
      // Continue with other calendars for non-critical errors
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
  calendarIds: string[],
  timezone?: string
): Promise<CalendarEvent[]> {
  return fetchEvents(refreshToken, calendarIds, 0, timezone);
}

/**
 * Fetch tomorrow's events from Google Calendar for a user
 */
export async function fetchTomorrowEvents(
  refreshToken: string,
  calendarIds: string[],
  timezone?: string
): Promise<CalendarEvent[]> {
  return fetchEvents(refreshToken, calendarIds, 1, timezone);
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

  try {
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
  } catch (error) {
    console.error('Error listing user calendars:', error);
    captureError(error, 'calendar-list-calendars');

    // If it's an insufficient scopes error, re-throw with specific message
    if (isInsufficientScopesError(error)) {
      throw new Error('GOOGLE_INSUFFICIENT_SCOPES');
    }

    // If it's a token error, re-throw with specific message
    if (isTokenError(error)) {
      throw new Error('GOOGLE_TOKEN_EXPIRED');
    }

    // Re-throw other errors
    throw error;
  }
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
  recurrence?: string[];  // RRULE strings for Google Calendar API
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
 * Build RRULE string from recurrence pattern for Google Calendar API
 * @param recurrence - Array of RRULE strings
 * @returns Formatted RRULE array or undefined
 */
function formatRecurrenceForAPI(recurrence?: string[]): string[] | undefined {
  if (!recurrence || recurrence.length === 0) return undefined;

  // Ensure each rule starts with RRULE: prefix
  return recurrence.map(rule =>
    rule.startsWith('RRULE:') ? rule : `RRULE:${rule}`
  );
}

/**
 * Build RRULE string from parsed recurrence pattern
 * @param recurrence - Parsed recurrence pattern from voice input
 * @returns Array with single RRULE string
 */
export function buildRecurrenceRule(recurrence?: {
  frequency: string;
  daysOfWeek?: string[];
  interval?: number;
  until?: string;
  count?: number;
}): string[] {
  if (!recurrence?.frequency) return [];

  let rule = `RRULE:FREQ=${recurrence.frequency.toUpperCase()}`;

  if (recurrence.interval && recurrence.interval > 1) {
    rule += `;INTERVAL=${recurrence.interval}`;
  }

  if (recurrence.daysOfWeek && recurrence.daysOfWeek.length > 0) {
    rule += `;BYDAY=${recurrence.daysOfWeek.join(',')}`;
  }

  if (recurrence.until) {
    // Format: YYYYMMDD
    rule += `;UNTIL=${recurrence.until.replace(/-/g, '')}`;
  } else if (recurrence.count) {
    rule += `;COUNT=${recurrence.count}`;
  }

  return [rule];
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

    // Add recurrence rules if provided
    if (eventData.recurrence && eventData.recurrence.length > 0) {
      eventBody.recurrence = formatRecurrenceForAPI(eventData.recurrence);
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
    captureError(error, 'calendar-create-event');

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
      captureError(error, 'calendar-fetch-range', { calendarId }, 'warning');

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
 * Scope for recurring event modifications
 */
export type RecurrenceScope = 'single' | 'all' | 'following';

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
  scope?: RecurrenceScope;        // For recurring events: single instance, all, or this+following
  recurringEventId?: string;      // Parent event ID for recurring event modifications
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
 * @param eventId - ID of the event to update (instance ID for recurring events)
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
  const scope = updates.scope || 'single';

  // For 'following' scope, use the special handler
  if (scope === 'following' && updates.recurringEventId) {
    return updateThisAndFollowing(refreshToken, calendarId, eventId, updates);
  }

  // Determine which eventId to use based on scope
  // 'all' scope: use parent recurringEventId to affect entire series
  // 'single' scope: use instance eventId (default behavior)
  const targetEventId = scope === 'all' && updates.recurringEventId
    ? updates.recurringEventId
    : eventId;

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
        eventId: targetEventId,
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
      eventId: targetEventId,
      requestBody: updateBody,
    });

    return {
      success: true,
      eventId: response.data.id || undefined,
      eventLink: response.data.htmlLink || undefined,
    };
  } catch (error) {
    console.error('Error updating calendar event:', error);
    captureError(error, 'calendar-update-event');

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
 * Update this instance and all following instances of a recurring event
 * This is a two-step process:
 * 1. Truncate the original series by adding UNTIL clause (day before this instance)
 * 2. Create a new recurring event starting from this instance with updates applied
 */
async function updateThisAndFollowing(
  refreshToken: string,
  calendarId: string,
  instanceEventId: string,
  updates: UpdateEventData
): Promise<UpdateEventResult> {
  const calendar = getCalendarClient(refreshToken);

  try {
    // Step 1: Get the parent recurring event
    const parentEvent = await calendar.events.get({
      calendarId: calendarId,
      eventId: updates.recurringEventId!,
    });

    // Step 2: Get the instance to find its start date
    const instanceEvent = await calendar.events.get({
      calendarId: calendarId,
      eventId: instanceEventId,
    });

    const instanceStartStr = instanceEvent.data.start?.dateTime || instanceEvent.data.start?.date;
    if (!instanceStartStr) {
      return {
        success: false,
        error: 'NOT_FOUND',
        errorMessage: 'Could not determine instance start date.',
      };
    }

    const instanceDate = new Date(instanceStartStr);

    // Step 3: Update original event to end BEFORE this instance
    const endBeforeInstance = new Date(instanceDate);
    endBeforeInstance.setDate(endBeforeInstance.getDate() - 1);
    const untilDate = format(endBeforeInstance, 'yyyyMMdd');

    const originalRecurrence = parentEvent.data.recurrence || [];
    const modifiedRecurrence = originalRecurrence.map(rule => {
      if (rule.startsWith('RRULE:')) {
        // Remove existing UNTIL/COUNT and add new UNTIL
        const parts = rule.split(';').filter(part =>
          !part.startsWith('UNTIL=') && !part.startsWith('COUNT=')
        );
        return `${parts.join(';')};UNTIL=${untilDate}`;
      }
      return rule;
    });

    await calendar.events.patch({
      calendarId: calendarId,
      eventId: updates.recurringEventId!,
      requestBody: {
        recurrence: modifiedRecurrence,
      },
    });

    // Step 4: Create new recurring event from this instance with updates
    const existingStart = instanceEvent.data.start;
    const existingEnd = instanceEvent.data.end;
    const isAllDay = !existingStart?.dateTime;

    const newStartTime = updates.startTime ?? new Date(existingStart?.dateTime || existingStart?.date || '');
    const newEndTime = updates.endTime ?? new Date(existingEnd?.dateTime || existingEnd?.date || '');

    const newEventBody: calendar_v3.Schema$Event = {
      summary: updates.title ?? parentEvent.data.summary,
      description: updates.description ?? parentEvent.data.description,
      location: updates.location ?? parentEvent.data.location,
      recurrence: parentEvent.data.recurrence, // Copy original recurrence (without the UNTIL we just added)
    };

    if (isAllDay || updates.allDay) {
      newEventBody.start = {
        date: format(newStartTime, 'yyyy-MM-dd'),
        timeZone: TIMEZONE,
      };
      newEventBody.end = {
        date: format(newEndTime, 'yyyy-MM-dd'),
        timeZone: TIMEZONE,
      };
    } else {
      newEventBody.start = {
        dateTime: newStartTime.toISOString(),
        timeZone: TIMEZONE,
      };
      newEventBody.end = {
        dateTime: newEndTime.toISOString(),
        timeZone: TIMEZONE,
      };
    }

    const response = await calendar.events.insert({
      calendarId: calendarId,
      requestBody: newEventBody,
    });

    return {
      success: true,
      eventId: response.data.id || undefined,
      eventLink: response.data.htmlLink || undefined,
    };
  } catch (error) {
    console.error('Error updating this and following events:', error);
    captureError(error, 'calendar-update-following');

    if (isTokenError(error)) {
      return {
        success: false,
        error: 'TOKEN_EXPIRED',
        errorMessage: 'Google Calendar access has expired. Please re-authorize.',
      };
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
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
 * Options for deleting recurring events
 */
export interface DeleteEventOptions {
  scope?: RecurrenceScope;       // For recurring events: single instance, all, or this+following
  recurringEventId?: string;     // Parent event ID for recurring event modifications
}

/**
 * Delete an event from Google Calendar
 * @param refreshToken - Google OAuth refresh token
 * @param calendarId - Calendar ID containing the event
 * @param eventId - ID of the event to delete (instance ID for recurring events)
 * @param options - Optional settings for recurring event deletion
 * @returns Result indicating success or error information
 */
export async function deleteEvent(
  refreshToken: string,
  calendarId: string,
  eventId: string,
  options?: DeleteEventOptions
): Promise<DeleteEventResult> {
  const calendar = getCalendarClient(refreshToken);
  const scope = options?.scope || 'single';

  // For 'following' scope, truncate the series instead of deleting
  if (scope === 'following' && options?.recurringEventId) {
    return deleteThisAndFollowing(refreshToken, calendarId, eventId, options.recurringEventId);
  }

  // Determine which eventId to use based on scope
  // 'all' scope: use parent recurringEventId to delete entire series
  // 'single' scope: use instance eventId (default behavior)
  const targetEventId = scope === 'all' && options?.recurringEventId
    ? options.recurringEventId
    : eventId;

  try {
    await calendar.events.delete({
      calendarId: calendarId,
      eventId: targetEventId,
    });

    return { success: true };
  } catch (error) {
    console.error('Error deleting calendar event:', error);
    captureError(error, 'calendar-delete-event');

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

/**
 * Delete this instance and all following instances of a recurring event
 * This truncates the series by adding UNTIL clause (day before this instance)
 */
async function deleteThisAndFollowing(
  refreshToken: string,
  calendarId: string,
  instanceEventId: string,
  recurringEventId: string
): Promise<DeleteEventResult> {
  const calendar = getCalendarClient(refreshToken);

  try {
    // Step 1: Get the instance to find its start date
    const instanceEvent = await calendar.events.get({
      calendarId: calendarId,
      eventId: instanceEventId,
    });

    const instanceStartStr = instanceEvent.data.start?.dateTime || instanceEvent.data.start?.date;
    if (!instanceStartStr) {
      return {
        success: false,
        error: 'NOT_FOUND',
        errorMessage: 'Could not determine instance start date.',
      };
    }

    const instanceDate = new Date(instanceStartStr);

    // Step 2: Get the parent recurring event
    const parentEvent = await calendar.events.get({
      calendarId: calendarId,
      eventId: recurringEventId,
    });

    // Step 3: Update original event to end BEFORE this instance
    const endBeforeInstance = new Date(instanceDate);
    endBeforeInstance.setDate(endBeforeInstance.getDate() - 1);
    const untilDate = format(endBeforeInstance, 'yyyyMMdd');

    const originalRecurrence = parentEvent.data.recurrence || [];
    const modifiedRecurrence = originalRecurrence.map(rule => {
      if (rule.startsWith('RRULE:')) {
        // Remove existing UNTIL/COUNT and add new UNTIL
        const parts = rule.split(';').filter(part =>
          !part.startsWith('UNTIL=') && !part.startsWith('COUNT=')
        );
        return `${parts.join(';')};UNTIL=${untilDate}`;
      }
      return rule;
    });

    await calendar.events.patch({
      calendarId: calendarId,
      eventId: recurringEventId,
      requestBody: {
        recurrence: modifiedRecurrence,
      },
    });

    return { success: true };
  } catch (error) {
    console.error('Error deleting this and following events:', error);
    captureError(error, 'calendar-delete-following');

    if (isTokenError(error)) {
      return {
        success: false,
        error: 'TOKEN_EXPIRED',
        errorMessage: 'Google Calendar access has expired. Please re-authorize.',
      };
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: 'UNKNOWN_ERROR',
      errorMessage: errorMessage,
    };
  }
}

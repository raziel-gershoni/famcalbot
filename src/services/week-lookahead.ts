/**
 * Week Lookahead Service
 * Surfaces notable upcoming events, filtering out routine daily noise
 */

import { CalendarEvent, CalendarAssignment, CalendarLabel, UserConfig } from '../types';
import { getCalendarClient, TIMEZONE } from './calendar';

// Recurrence frequency types
export type RecurrenceType = 'single' | 'daily' | 'weekly' | 'monthly' | 'yearly';

export interface LookaheadEvent {
  summary: string;
  start: Date;
  end: Date;
  calendarName: string;
  calendarId: string;
  calendarLabel: CalendarLabel;
  recurrenceType: RecurrenceType;
  daysFromNow: number;
}

export interface WeekLookahead {
  events: LookaheadEvent[];
  dateRange: { start: Date; end: Date };
}

// Cache for master event recurrence rules to avoid repeated API calls
const recurrenceCache = new Map<string, string[] | null>();

/**
 * Get the next week boundary based on user settings
 * - If lookaheadAlways7Days: always 7 days from now
 * - Jewish culture: next Sunday (week starts Sunday)
 * - Default culture: next Monday (week starts Monday)
 */
function getNextWeekBoundary(culture?: string, always7Days?: boolean): Date {
  const now = new Date();
  // Get current day in Israel timezone
  const israelTime = new Date(now.toLocaleString('en-US', { timeZone: TIMEZONE }));

  let daysUntilBoundary: number;

  if (always7Days) {
    // Always 7 days
    daysUntilBoundary = 7;
  } else {
    const dayOfWeek = israelTime.getDay(); // 0=Sun, 1=Mon, ...

    if (culture === 'jewish') {
      // Next Sunday (week ends Friday, so scan until Sunday = start of next week)
      daysUntilBoundary = (7 - dayOfWeek) % 7 || 7;
    } else {
      // Next Monday
      daysUntilBoundary = ((8 - dayOfWeek) % 7) || 7;
    }
  }

  const boundary = new Date(israelTime);
  boundary.setDate(boundary.getDate() + daysUntilBoundary);
  boundary.setHours(23, 59, 59, 999);

  return boundary;
}

/**
 * Parse RRULE to determine recurrence frequency
 */
function parseRecurrence(rrule?: string[]): RecurrenceType {
  if (!rrule?.length) return 'single';

  const rule = rrule[0];
  if (rule.includes('FREQ=DAILY')) return 'daily';
  if (rule.includes('FREQ=WEEKLY')) return 'weekly';
  if (rule.includes('FREQ=MONTHLY')) return 'monthly';
  if (rule.includes('FREQ=YEARLY')) return 'yearly';

  return 'single';
}

/**
 * Fetch recurrence rules from master event
 * Uses caching to avoid repeated API calls for the same recurring event
 */
async function getMasterEventRecurrence(
  refreshToken: string,
  calendarId: string,
  recurringEventId: string
): Promise<string[] | null> {
  const cacheKey = `${calendarId}:${recurringEventId}`;

  if (recurrenceCache.has(cacheKey)) {
    return recurrenceCache.get(cacheKey) || null;
  }

  try {
    const calendar = getCalendarClient(refreshToken);
    const master = await calendar.events.get({
      calendarId,
      eventId: recurringEventId,
    });

    const recurrence = master.data.recurrence || null;
    recurrenceCache.set(cacheKey, recurrence);
    return recurrence;
  } catch (error) {
    console.warn(`Failed to fetch master event ${recurringEventId}:`, error);
    recurrenceCache.set(cacheKey, null);
    return null;
  }
}

/**
 * Get calendar label for an event based on calendar assignments
 */
function getCalendarLabel(
  calendarId: string,
  assignments: CalendarAssignment[]
): CalendarLabel {
  const assignment = assignments.find(a => a.calendarId === calendarId);
  if (!assignment) return 'yours'; // Default

  // Return the most specific label (priority: primary > spouse > kids > birthdays > yours)
  if (assignment.labels.includes('primary')) return 'yours';
  if (assignment.labels.includes('spouse')) return 'spouse';
  if (assignment.labels.includes('kids')) return 'kids';
  if (assignment.labels.includes('birthdays')) return 'birthdays';
  return 'yours';
}

/**
 * Calculate days from now
 */
function getDaysFromNow(eventStart: Date): number {
  const now = new Date();
  const today = new Date(now.toLocaleString('en-US', { timeZone: TIMEZONE }));
  today.setHours(0, 0, 0, 0);

  const eventDay = new Date(eventStart);
  eventDay.setHours(0, 0, 0, 0);

  const diffMs = eventDay.getTime() - today.getTime();
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

/**
 * Fetch events for date range from all assigned calendars
 */
async function fetchEventsInRange(
  refreshToken: string,
  calendarIds: string[],
  start: Date,
  end: Date
): Promise<CalendarEvent[]> {
  const calendar = getCalendarClient(refreshToken);
  const allEvents: CalendarEvent[] = [];

  for (const calendarId of calendarIds) {
    try {
      const calendarInfo = await calendar.calendars.get({ calendarId });
      const calendarName = calendarInfo.data.summary || calendarId;

      const response = await calendar.events.list({
        calendarId,
        timeMin: start.toISOString(),
        timeMax: end.toISOString(),
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
          calendarName,
          calendarId,
          eventType: event.eventType || undefined,
          recurringEventId: event.recurringEventId || undefined,
        });
      }
    } catch (error) {
      console.warn(`Failed to fetch calendar ${calendarId}:`, error);
    }
  }

  return allEvents;
}

/**
 * Get week lookahead with notable events
 */
export async function getWeekLookahead(
  user: UserConfig,
  calendars: CalendarAssignment[]
): Promise<WeekLookahead> {
  const now = new Date();
  const endDate = getNextWeekBoundary(user.culture, user.lookaheadAlways7Days);

  // Get calendar IDs (exclude birthdays calendars from the scan)
  const calendarIds = calendars
    .filter(c => !c.labels.includes('birthdays'))
    .map(c => c.calendarId);

  if (calendarIds.length === 0 || !user.googleRefreshToken) {
    return { events: [], dateRange: { start: now, end: endDate } };
  }

  // Fetch all events in range
  const events = await fetchEventsInRange(
    user.googleRefreshToken,
    calendarIds,
    now,
    endDate
  );

  // Process events and filter
  const lookaheadEvents: LookaheadEvent[] = [];

  for (const event of events) {
    // Skip birthday events (using eventType from Google Calendar API)
    if (event.eventType === 'birthday') continue;

    // Determine recurrence type
    let recurrenceType: RecurrenceType = 'single';

    if (event.recurringEventId) {
      // Fetch master event to get recurrence rules
      const rrule = await getMasterEventRecurrence(
        user.googleRefreshToken,
        event.calendarId,
        event.recurringEventId
      );
      recurrenceType = parseRecurrence(rrule || undefined);
    }

    // Filter by recurrence rules
    if (recurrenceType === 'daily') continue;
    if (recurrenceType === 'weekly' && !user.includeWeeklyInLookahead) continue;

    const startDate = new Date(event.start);
    const endDateEvent = new Date(event.end);

    lookaheadEvents.push({
      summary: event.summary,
      start: startDate,
      end: endDateEvent,
      calendarName: event.calendarName,
      calendarId: event.calendarId,
      calendarLabel: getCalendarLabel(event.calendarId, calendars),
      recurrenceType,
      daysFromNow: getDaysFromNow(startDate),
    });
  }

  // Sort by start time
  lookaheadEvents.sort((a, b) => a.start.getTime() - b.start.getTime());

  return {
    events: lookaheadEvents,
    dateRange: { start: now, end: endDate },
  };
}

/**
 * Clear recurrence cache (useful for testing or memory management)
 */
export function clearRecurrenceCache(): void {
  recurrenceCache.clear();
}

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
 * Get the week boundary based on user settings
 * - If lookaheadAlways7Days: always 7 days from reference date
 * - Jewish culture: through Saturday (week ends Saturday, Sunday is next week)
 * - Default culture: through Sunday (week ends Sunday, Monday is next week)
 * @param culture - User's culture setting
 * @param always7Days - Whether to always show 7 days
 * @param referenceDate - The date to calculate from (defaults to now)
 */
function getNextWeekBoundary(culture?: string, always7Days?: boolean, referenceDate?: Date): Date {
  const baseDate = referenceDate || new Date();
  // Get day in Israel timezone
  const israelTime = new Date(baseDate.toLocaleString('en-US', { timeZone: TIMEZONE }));

  let daysUntilBoundary: number;

  if (always7Days) {
    // Always 7 days
    daysUntilBoundary = 7;
  } else {
    const dayOfWeek = israelTime.getDay(); // 0=Sun, 1=Mon, ...

    if (culture === 'jewish') {
      // Through Saturday (dayOfWeek 6) - Sunday is already next week
      daysUntilBoundary = (6 - dayOfWeek + 7) % 7;
    } else {
      // Through Sunday (dayOfWeek 0) - Monday is next week
      daysUntilBoundary = (7 - dayOfWeek) % 7;
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

  const rule = rrule.find(r => r.startsWith('RRULE:'));
  if (!rule) return 'single';
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
 * Calculate days from reference date
 * @param eventStart - Event start date
 * @param referenceDate - The date to calculate from (defaults to now)
 */
function getDaysFromReference(eventStart: Date, referenceDate?: Date): number {
  const baseDate = referenceDate || new Date();
  const refDay = new Date(baseDate.toLocaleString('en-US', { timeZone: TIMEZONE }));
  refDay.setHours(0, 0, 0, 0);

  const eventDay = new Date(eventStart);
  eventDay.setHours(0, 0, 0, 0);

  const diffMs = eventDay.getTime() - refDay.getTime();
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
 * Filter events by recurrence rules and build LookaheadEvent objects
 */
async function filterAndBuildLookaheadEvents(
  events: CalendarEvent[],
  user: UserConfig,
  calendars: CalendarAssignment[],
  referenceDate?: Date
): Promise<LookaheadEvent[]> {
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
      if (rrule && rrule.length > 0) {
        recurrenceType = parseRecurrence(rrule);
        // A known-recurring event should never be classified as single —
        // if RRULE couldn't be parsed (e.g., EXDATE-only array), default to daily (filter out)
        if (recurrenceType === 'single') recurrenceType = 'daily';
      } else {
        // If RRULE can't be fetched, assume daily (filter out)
        recurrenceType = 'daily';
      }
    }

    // Filter by recurrence rules
    if (recurrenceType === 'daily') continue;
    if (recurrenceType === 'weekly' && !user.includeWeeklyInLookahead) continue;

    const eventStartDate = new Date(event.start);
    const eventEndDate = new Date(event.end);

    lookaheadEvents.push({
      summary: event.summary,
      start: eventStartDate,
      end: eventEndDate,
      calendarName: event.calendarName,
      calendarId: event.calendarId,
      calendarLabel: getCalendarLabel(event.calendarId, calendars),
      recurrenceType,
      daysFromNow: getDaysFromReference(eventStartDate, referenceDate),
    });
  }

  // Sort by start time
  lookaheadEvents.sort((a, b) => a.start.getTime() - b.start.getTime());

  return lookaheadEvents;
}

/**
 * Get week lookahead with notable events
 * @param user - User configuration
 * @param calendars - Calendar assignments
 * @param referenceDate - The date to calculate lookahead from (defaults to now, use tomorrow for tomorrow's summary)
 */
export async function getWeekLookahead(
  user: UserConfig,
  calendars: CalendarAssignment[],
  referenceDate?: Date
): Promise<WeekLookahead> {
  const startDate = referenceDate || new Date();
  const endDate = getNextWeekBoundary(user.culture, user.lookaheadAlways7Days, startDate);

  // Get calendar IDs (exclude birthdays calendars from the scan)
  const calendarIds = calendars
    .filter(c => !c.labels.includes('birthdays'))
    .map(c => c.calendarId);

  if (calendarIds.length === 0 || !user.googleRefreshToken) {
    return { events: [], dateRange: { start: startDate, end: endDate } };
  }

  // Fetch all events in range
  const events = await fetchEventsInRange(
    user.googleRefreshToken,
    calendarIds,
    startDate,
    endDate
  );

  const lookaheadEvents = await filterAndBuildLookaheadEvents(events, user, calendars, referenceDate);

  return {
    events: lookaheadEvents,
    dateRange: { start: startDate, end: endDate },
  };
}

/**
 * Get next week's boundaries based on culture
 * - Jewish: Sunday to Saturday
 * - Default: Monday to Sunday
 * @param culture - User's culture setting
 * @param referenceDate - The date to calculate from (defaults to now)
 */
function getNextWeekBoundaries(culture?: string, referenceDate?: Date): { start: Date; end: Date } {
  const baseDate = referenceDate || new Date();
  const israelTime = new Date(baseDate.toLocaleString('en-US', { timeZone: TIMEZONE }));
  const dayOfWeek = israelTime.getDay(); // 0=Sun, 1=Mon, ...

  let daysUntilNextWeekStart: number;
  let weekLength: number = 7;

  if (culture === 'jewish') {
    // Next Sunday (start of next week for Jewish)
    daysUntilNextWeekStart = (7 - dayOfWeek) % 7 || 7;
  } else {
    // Next Monday (start of next week for default)
    daysUntilNextWeekStart = ((8 - dayOfWeek) % 7) || 7;
  }

  const start = new Date(israelTime);
  start.setDate(start.getDate() + daysUntilNextWeekStart);
  start.setHours(0, 0, 0, 0);

  const end = new Date(start);
  end.setDate(end.getDate() + weekLength - 1);
  end.setHours(23, 59, 59, 999);

  return { start, end };
}

/**
 * Get next week lookahead with notable events
 * @param user - User configuration
 * @param calendars - Calendar assignments
 * @param referenceDate - The date to calculate from (defaults to now)
 */
export async function getNextWeekLookahead(
  user: UserConfig,
  calendars: CalendarAssignment[],
  referenceDate?: Date
): Promise<WeekLookahead> {
  const { start, end } = getNextWeekBoundaries(user.culture, referenceDate);

  // Get calendar IDs (exclude birthdays calendars from the scan)
  const calendarIds = calendars
    .filter(c => !c.labels.includes('birthdays'))
    .map(c => c.calendarId);

  if (calendarIds.length === 0 || !user.googleRefreshToken) {
    return { events: [], dateRange: { start, end } };
  }

  // Fetch all events in range
  const events = await fetchEventsInRange(
    user.googleRefreshToken,
    calendarIds,
    start,
    end
  );

  const lookaheadEvents = await filterAndBuildLookaheadEvents(events, user, calendars, referenceDate);

  return {
    events: lookaheadEvents,
    dateRange: { start, end },
  };
}

/**
 * Clear recurrence cache (useful for testing or memory management)
 */
export function clearRecurrenceCache(): void {
  recurrenceCache.clear();
}

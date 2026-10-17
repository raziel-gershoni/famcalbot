/**
 * Week Lookahead Service
 * Surfaces notable upcoming events, filtering out routine daily noise
 */

import { CalendarEvent, CalendarAssignment, CalendarLabel, ReminderInfo, UserConfig } from '../types';
import { getCalendarClient } from './calendar';
import { getProviderForUser } from './calendar-provider';
import { DEFAULT_ON_DEMAND_READ, readLookaheadEvents, type DigestRead } from './calendar-read/digest';
import { isCalendarHomeOn } from './calendar-read/rollout';
import { getNativeSeriesRrule } from './native-calendar/event-store';
import {
  RECURRENCE_ANSWER_TTL_MS,
  RECURRENCE_FAILURE_TTL_MS,
  RECURRENCE_GONE_TTL_MS,
  readRecurrenceCache,
  recurrenceCacheKey,
  writeRecurrenceCache,
} from './recurrence-cache';
import { eventTimeLabel, isAllDayEvent, isBirthdayEvent, isReminderEvent, reminderAttribution } from '../utils/event-formatter';
import { daySpanOf, localDate, nextDate, startOfLocalDay } from '../utils/day-events';
import { legacyWeekStart, nextWeekBoundaries, nextWeekBoundary, tzKnownFor, weekStartFor, type WeekStart } from '../utils/locale-rules';
import { resolveUserTimezone } from '../lib/timezone';

// Recurrence frequency types
export type RecurrenceType = 'single' | 'daily' | 'weekly' | 'monthly' | 'yearly';

export interface LookaheadEvent {
  summary: string;
  start: Date;
  end: Date;
  /**
   * The user's local day it is listed on (yyyy-MM-dd): the day it starts, or the first
   * day for one already running then.
   */
  day: string;
  /**
   * For an event already running on the first day (a vacation since Monday, a sleepover
   * until 10:00): how it sits on that day, in the daily summary's words. Its own start
   * time is not that day's.
   */
  runningLabel?: string;
  calendarName: string;
  calendarId: string;
  calendarLabel: CalendarLabel;
  recurrenceType: RecurrenceType;
  daysFromNow: number;
  isAllDay: boolean;
  isBirthday: boolean;
  /** Set on a built-in calendar reminder: whose it is, from the viewer's side. */
  reminder?: ReminderInfo;
}

export interface WeekLookahead {
  events: LookaheadEvent[];
  dateRange: { start: Date; end: Date };
  /** The user's timezone; the lookahead's days are their local days. */
  timezone: string;
}

/** The user's days a lookahead lists, and the day "In N days" counts from (yyyy-MM-dd). */
interface LookaheadDays {
  timezone: string;
  today: string;
  first: string;
  last: string;
}

/**
 * One lookahead run's series lookups, by cache key: each series is asked about once per
 * run. ./recurrence-cache keeps the answers across runs.
 */
type SeriesLookups = Map<string, Promise<string[] | null>>;

/** The last instant of yyyy-MM-dd in `timezone`. */
function endOfLocalDay(day: string, timezone: string): Date {
  return new Date(startOfLocalDay(nextDate(day), timezone).getTime() - 1);
}

/**
 * The first day of the user's week (0 = Sunday), which sets This week's last day and Next
 * week's days. With the calendar home on (spec §6): Sunday for Jewish culture, else the
 * country of the user's own timezone (from their location or Google), else the language.
 * Otherwise today's rule: Sunday for Jewish culture, Monday for everyone else.
 */
function weekStartOf(user: UserConfig, timezone: string, homeOn: boolean): WeekStart {
  return homeOn
    ? weekStartFor({ culture: user.culture, language: user.language, tz: timezone, tzKnown: tzKnownFor(user) })
    : legacyWeekStart(user.culture);
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

/** The HTTP status of a Google API error, if it has one (gaxios sets status and response.status). */
function googleErrorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const e = error as { status?: unknown; code?: unknown; response?: { status?: unknown } };
  for (const status of [e.status, e.response?.status, e.code]) {
    if (typeof status === 'number') return status;
  }
  return undefined;
}

/**
 * Fetch recurrence rules from master event
 * Kept per user (./recurrence-cache), and asked once per lookahead run (`lookups`)
 */
async function getMasterEventRecurrence(
  user: UserConfig,
  calendarId: string,
  recurringEventId: string,
  lookups: SeriesLookups
): Promise<string[] | null> {
  const cacheKey = recurrenceCacheKey(user.id, calendarId, recurringEventId);
  let lookup = lookups.get(cacheKey);
  if (!lookup) {
    lookup = lookUpRecurrence(user, calendarId, recurringEventId, cacheKey);
    lookups.set(cacheKey, lookup);
  }
  return lookup;
}

/** The kept answer while it holds; otherwise ask, and keep the answer. */
async function lookUpRecurrence(
  user: UserConfig,
  calendarId: string,
  recurringEventId: string,
  cacheKey: string
): Promise<string[] | null> {
  // An answer is as old as its question.
  const at = Date.now();
  const cached = readRecurrenceCache(cacheKey, at);
  if (cached) return cached.value;

  const { value, ttlMs } = await fetchMasterEventRecurrence(user, calendarId, recurringEventId);
  writeRecurrenceCache(cacheKey, { value, at, ttlMs });
  return value;
}

/** A series' rules from its master event, and how long that answer holds. Never rejects. */
async function fetchMasterEventRecurrence(
  user: UserConfig,
  calendarId: string,
  recurringEventId: string
): Promise<{ value: string[] | null; ttlMs: number }> {
  // NATIVE: the series rule lives in our own table. Falling through to the
  // Google client here would authenticate with an empty refresh token, fail,
  // and land in the catch below - which classifies the event as 'daily' and
  // therefore filters every recurring native event out of the lookahead,
  // including the monthly and yearly ones that ought to show.
  if (user.calendarSource === 'NATIVE') {
    try {
      const rrule = await getNativeSeriesRrule(recurringEventId);
      // parseRecurrence only looks at entries prefixed 'RRULE:', which is how
      // Google returns them. Native stores the bare rule, so normalize - without
      // this every recurring native event parses as 'single', gets forced to
      // 'daily' by the caller, and is filtered out of the lookahead.
      const recurrence = rrule
        ? [rrule.startsWith('RRULE:') ? rrule : `RRULE:${rrule}`]
        : null;
      return { value: recurrence, ttlMs: RECURRENCE_ANSWER_TTL_MS };
    } catch (error) {
      console.warn(`Failed to read native series ${recurringEventId}:`, error);
      return { value: null, ttlMs: RECURRENCE_FAILURE_TTL_MS };
    }
  }

  try {
    const calendar = getCalendarClient(user.googleRefreshToken);
    const master = await calendar.events.get({
      calendarId,
      eventId: recurringEventId,
    });

    return { value: master.data.recurrence || null, ttlMs: RECURRENCE_ANSWER_TTL_MS };
  } catch (error) {
    console.warn(`Failed to fetch master event ${recurringEventId}:`, error);
    // A 404 or 410 is an answer: the series is gone. Anything else may pass in a moment.
    const status = googleErrorStatus(error);
    return { value: null, ttlMs: status === 404 || status === 410 ? RECURRENCE_GONE_TTL_MS : RECURRENCE_FAILURE_TTL_MS };
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
 * Calendar days from the reference day to the event's day, both yyyy-MM-dd. Read as
 * UTC dates, so a 23- or 25-hour DST day still counts as one.
 */
function getDaysFromReference(eventDay: string, referenceDay: string): number {
  return Math.round((Date.parse(`${eventDay}T00:00:00Z`) - Date.parse(`${referenceDay}T00:00:00Z`)) / 86_400_000);
}

/**
 * Fetch events for date range from all assigned calendars. With the calendar home on,
 * the shared reader (spec §3.1): the user's own source over [start, the end of the last
 * day), Google's clean-up, and Google's failures thrown for the command to answer.
 */
async function fetchEventsInRange(
  user: UserConfig,
  calendarIds: string[],
  start: Date,
  end: Date,
  timezone: string,
  homeOn: boolean,
  read: DigestRead
): Promise<CalendarEvent[]> {
  if (homeOn) return readLookaheadEvents(user, start, end, timezone, calendarIds, read);

  // NATIVE users go through the provider, which reads the in-bot calendar.
  // This function's Google path below talks to the API directly, so without
  // this branch /week and /nextweek returned nothing for them.
  if (user.calendarSource === 'NATIVE') {
    return getProviderForUser(user).fetchEventsInRange(user, calendarIds, start, end);
  }

  const calendar = getCalendarClient(user.googleRefreshToken);
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
        timeZone: timezone,
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
  days: LookaheadDays
): Promise<LookaheadEvent[]> {
  const lookaheadEvents: LookaheadEvent[] = [];
  // Each series is asked about once per run, even if its kept answer runs out mid-run.
  const seriesLookups: SeriesLookups = new Map();

  for (const event of events) {
    const birthday = isBirthdayEvent(event);
    const allDay = isAllDayEvent(event);
    // A reminder is listed only on its own day: having no duration, it is never running
    // on the first day. One already done is not coming up.
    const reminder = isReminderEvent(event) ? event.reminder ?? { ownerIsViewer: true, creatorIsViewer: true } : undefined;
    if (reminder?.done) continue;

    // An event is listed once, on the day it starts in the user's timezone; all-day
    // dates already are such days. The fetch returns whatever overlaps the range, so one
    // that started before the first day comes back too. It is listed on the first day,
    // as running, if it belongs to that day by the daily summary's rule (a vacation, a
    // sleepover until 10:00), and dropped if not (last night's party until 02:00); its
    // own day would read "In -1 days". One without a start has no day.
    if (!event.start) continue;
    let day = allDay ? event.start : localDate(new Date(event.start), days.timezone);
    if (day > days.last) continue;
    let runningLabel: string | undefined;
    if (day < days.first) {
      const span = daySpanOf(event, days.first, days.timezone);
      if (!span) continue;
      // "Started yesterday" only reads right when the first day is today.
      runningLabel = eventTimeLabel({ ...event, daySpan: span }, days.timezone, days.first === days.today ? days.first : undefined);
      day = days.first;
    }

    // Determine recurrence type (skip for birthdays — always include them)
    let recurrenceType: RecurrenceType = birthday ? 'yearly' : 'single';

    if (!birthday && event.recurringEventId) {
      // Fetch master event to get recurrence rules
      const rrule = await getMasterEventRecurrence(
        user,
        event.calendarId,
        event.recurringEventId,
        seriesLookups
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

    // Filter by recurrence rules (birthdays bypass this — already set to 'yearly')
    if (recurrenceType === 'daily') continue;
    if (recurrenceType === 'weekly' && !user.includeWeeklyInLookahead) continue;

    // An all-day event starts at the user's midnight, not at UTC midnight, which west of
    // UTC is the evening before. Its end date is exclusive; a missing or non-advancing
    // end means one day, as in daySpanOf.
    let eventStartDate = new Date(event.start);
    let eventEndDate = new Date(event.end);
    if (allDay) {
      const endDate = event.end && !event.end.includes('T') && event.end > event.start ? event.end : nextDate(event.start);
      eventStartDate = startOfLocalDay(event.start, days.timezone);
      eventEndDate = startOfLocalDay(endDate, days.timezone);
    }

    lookaheadEvents.push({
      summary: event.summary,
      start: eventStartDate,
      end: eventEndDate,
      day,
      calendarName: event.calendarName,
      calendarId: event.calendarId,
      calendarLabel: getCalendarLabel(event.calendarId, calendars),
      recurrenceType,
      daysFromNow: getDaysFromReference(day, days.today),
      isAllDay: allDay,
      isBirthday: birthday,
      runningLabel,
      ...(reminder ? { reminder } : {}),
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
 * @param read - With the calendar home on, the read's mode and deadline (defaults to on demand)
 */
export async function getWeekLookahead(
  user: UserConfig,
  calendars: CalendarAssignment[],
  referenceDate?: Date,
  read: DigestRead = DEFAULT_ON_DEMAND_READ
): Promise<WeekLookahead> {
  const startDate = referenceDate || new Date();
  // The week is made of the user's days, from the reference day to the end of the last.
  const timezone = await resolveUserTimezone(user);
  // Asked once: the switch decides both the week's days and the read.
  const homeOn = await isCalendarHomeOn(user);
  const today = localDate(startDate, timezone);
  const lastDay = nextWeekBoundary(weekStartOf(user, timezone, homeOn), user.lookaheadAlways7Days, today);
  const endDate = endOfLocalDay(lastDay, timezone);

  // Get all calendar IDs (including birthdays)
  const calendarIds = calendars.map(c => c.calendarId);

  if (calendarIds.length === 0 || (user.calendarSource !== 'NATIVE' && !user.googleRefreshToken)) {
    return { events: [], dateRange: { start: startDate, end: endDate }, timezone };
  }

  // Fetch all events in range
  const events = await fetchEventsInRange(
    user,
    calendarIds,
    startDate,
    endDate,
    timezone,
    homeOn,
    read
  );

  const lookaheadEvents = await filterAndBuildLookaheadEvents(events, user, calendars, {
    timezone, today, first: today, last: lastDay,
  });

  return {
    events: lookaheadEvents,
    dateRange: { start: startDate, end: endDate },
    timezone,
  };
}

/**
 * The lookahead block of the tomorrow summary, one line per event. The lookahead counts
 * from the summary day, which the summary itself covers, so it starts the day after
 * (daysFromNow 1); `> 1`, written when it counted from today, dropped that day.
 */
export function formatTomorrowLookahead(lookahead: WeekLookahead): string {
  const { timezone } = lookahead;
  return lookahead.events
    .filter(e => e.daysFromNow >= 1)
    .map(e => {
      const dayName = e.start.toLocaleDateString('en-US', { weekday: 'long', timeZone: timezone });
      if (e.isBirthday) {
        return `${dayName}: ${e.summary} (Birthday)`;
      }
      if (e.reminder) {
        // The daily summary's reminder label: one moment, with whose it is
        const label = e.isAllDay
          ? 'Reminder (all day)'
          : `Reminder ${e.start.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: timezone })}`;
        const attribution = reminderAttribution(e);
        return `${dayName}: ${e.summary} (${label})${attribution ? ` (${attribution})` : ''}`;
      }
      if (e.isAllDay) {
        return `${dayName}: ${e.summary} (All day) (${e.calendarName})`;
      }
      const time = e.start.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: timezone });
      return `${dayName}: ${e.summary} at ${time} (${e.calendarName})`;
    })
    .join('\n');
}

/**
 * Get next week lookahead with notable events
 * @param user - User configuration
 * @param calendars - Calendar assignments
 * @param referenceDate - The date to calculate from (defaults to now)
 * @param read - With the calendar home on, the read's mode and deadline (defaults to on demand)
 */
export async function getNextWeekLookahead(
  user: UserConfig,
  calendars: CalendarAssignment[],
  referenceDate?: Date,
  read: DigestRead = DEFAULT_ON_DEMAND_READ
): Promise<WeekLookahead> {
  // Next week's days run from the user's midnight to the end of their last day.
  const timezone = await resolveUserTimezone(user);
  // Asked once: the switch decides both the week's days and the read.
  const homeOn = await isCalendarHomeOn(user);
  const today = localDate(referenceDate || new Date(), timezone);
  const { first, last } = nextWeekBoundaries(weekStartOf(user, timezone, homeOn), today);
  const start = startOfLocalDay(first, timezone);
  const end = endOfLocalDay(last, timezone);

  // Get all calendar IDs (including birthdays)
  const calendarIds = calendars.map(c => c.calendarId);

  if (calendarIds.length === 0 || (user.calendarSource !== 'NATIVE' && !user.googleRefreshToken)) {
    return { events: [], dateRange: { start, end }, timezone };
  }

  // Fetch all events in range
  const events = await fetchEventsInRange(
    user,
    calendarIds,
    start,
    end,
    timezone,
    homeOn,
    read
  );

  const lookaheadEvents = await filterAndBuildLookaheadEvents(events, user, calendars, { timezone, today, first, last });

  return {
    events: lookaheadEvents,
    dateRange: { start, end },
    timezone,
  };
}

// The clear functions live in ./recurrence-cache, which imports nothing, so a calendar
// write path can call them without importing this module and the calendar providers
// behind it. Re-exported for the callers that import them from here.
export { clearRecurrenceCache, clearRecurrenceCacheForUser } from './recurrence-cache';

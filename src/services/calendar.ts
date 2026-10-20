import { calendar as googleCalendar, calendar_v3, auth } from '@googleapis/calendar';
import { CalendarEvent } from '../types';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { TIMEZONE } from '../config/constants';
import { addDaysToDate, localDate, nextDate, startOfLocalDay } from '../utils/day-events';
import { isTokenError, isInsufficientScopesError } from '../utils/errors';
import { captureError } from '../lib/error-capture';
import { classifyGoogleError, googleErrorFacts, type GoogleErrorClass } from './calendar-read/google-map';
import { isSyncCopy } from './google-sync/markers';
import { syncCopyCalendarIds } from './google-sync/links';
import {
  daysFromTo,
  endCarriedRule,
  endOfLocalDay,
  fixesDays,
  followingTimesFor,
  seriesTimesFor,
  shiftOnWall,
  slotsBefore,
  withCount,
} from './native-calendar/recurrence';

// Re-export TIMEZONE and CalendarEvent for convenience
export { TIMEZONE };
export type { CalendarEvent };

/**
 * The OAuth2 client for a user's refresh token, as getCalendarClient has always built it.
 * A fresh client holds no access token, so its first request refreshes one. The calendar
 * home's reader (calendar-read/google.ts) runs that refresh itself first, inside its
 * deadline, so a dead token or a stuck token server is one outcome for the whole read.
 *
 * The reader also passes `transport`: every request of this client, the token refresh
 * included, gets that timeout unless it sets its own, and is cancelled when the signal is
 * aborted. Without it (getCalendarClient), the client is built exactly as before.
 */
export function getGoogleAuth(
  refreshToken: string,
  transport?: { timeout: number; signal: AbortSignal }
): InstanceType<typeof auth.OAuth2> {
  const oauth2Client = transport
    ? new auth.OAuth2({
        clientId: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        transporterOptions: { timeout: transport.timeout, signal: transport.signal },
      })
    : new auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET
      );

  oauth2Client.setCredentials({
    refresh_token: refreshToken,
  });

  return oauth2Client;
}

/**
 * Create a Google Calendar API client with OAuth credentials
 */
export function getCalendarClient(refreshToken: string): calendar_v3.Calendar {
  return googleCalendar({ version: 'v3', auth: getGoogleAuth(refreshToken) });
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
 * List all calendars the user has access to, but FamCal's own copies (google-sync spec §2:
 * every Google calendar a copy link of the user holds, on or off), so select-calendars,
 * the editor's targets and everything chosen from them never offer one.
 * @param refreshToken - Google OAuth refresh token
 * @param userId - the user's DB id, whose copy links are hidden
 * @returns Array of calendar information
 */
export async function listUserCalendars(refreshToken: string, userId: number): Promise<CalendarInfo[]> {
  const oauth2Client = new auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );

  oauth2Client.setCredentials({
    refresh_token: refreshToken,
  });

  const calendar = googleCalendar({ version: 'v3', auth: oauth2Client });

  try {
    const [response, copies] = await Promise.all([
      calendar.calendarList.list({
        showHidden: true,  // Include hidden calendars like birthdays
      }),
      syncCopyCalendarIds(userId),
    ]);
    const calendars = (response.data.items || []).filter(cal => !cal.id || !copies.has(cal.id));

    return calendars.map(cal => ({
      id: cal.id || '',
      name: cal.summary || 'Unnamed Calendar',
      description: cal.description || '',
      primary: cal.primary || false,
      accessRole: cal.accessRole || 'reader',
      backgroundColor: cal.backgroundColor || '#039BE5'
    }));
  } catch (error) {
    // Every path rethrows: the caller reports it, by its class and without Google's raw
    // error (the editor's calendars, the select-calendars page).
    console.warn('[calendar-list-calendars] listing the user\'s calendars failed:', scrubbedGoogleError(error, classifyGoogleError(error)).message);

    // If it's an insufficient scopes error, re-throw with specific message (the cause keeps
    // Google's error, which the home classifies by its own table)
    if (isInsufficientScopesError(error)) {
      throw new Error('GOOGLE_INSUFFICIENT_SCOPES', { cause: error });
    }

    // If it's a token error, re-throw with specific message
    if (isTokenError(error)) {
      throw new Error('GOOGLE_TOKEN_EXPIRED', { cause: error });
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
  timeZone?: string;      // The user's: the new event's zone, and the clock an all-day event's instants are on (allDayDates)
}

/**
 * Google's dates for an all-day event, which the bot hands over as instants: 00:00 on its
 * first day to a time on its last (23:59 as created), in the user's timezone, as the
 * native calendar stores one. A string is a date Google already holds, kept as it is. The
 * end date is exclusive. Formatted on the server's clock (UTC in production) the dates
 * came out a day early east of UTC.
 */
function allDayDates(start: Date | string, end: Date | string, timezone: string): { start: string; end: string } {
  const startDate = typeof start === 'string' ? start : formatInTimeZone(start, timezone, 'yyyy-MM-dd');
  // An end instant falls on the last day; one exactly at midnight ends the day before.
  const endDate = typeof end === 'string' ? end : nextDate(formatInTimeZone(new Date(end.getTime() - 1), timezone, 'yyyy-MM-dd'));
  return { start: startDate, end: endDate > startDate ? endDate : nextDate(startDate) };
}

/** What a failed write answers (3b spec §3.2 "Errors"): every write helper maps Google's error the same way. */
export type GoogleWriteError = 'PERMISSION_DENIED' | 'TOKEN_EXPIRED' | 'NOT_FOUND' | 'FORBIDDEN' | 'FIXED_DAYS' | 'UNKNOWN_ERROR';

interface WriteFailure {
  success: false;
  error: GoogleWriteError;
  errorMessage: string;
  retryable?: boolean;
}

/**
 * Result of creating a calendar event
 */
export interface CreateEventResult {
  success: boolean;
  eventId?: string;
  eventLink?: string;
  /** A series' first occurrence, which the home's key names. */
  instanceId?: string;
  error?: GoogleWriteError;
  errorMessage?: string;
  retryable?: boolean;
}

/**
 * A Google error as it is logged and sent to Sentry: its class, HTTP status, the API's
 * reasons and Google's own message. The GaxiosError itself carries the request, whose body
 * holds the title, so it never reaches a log.
 */
export function scrubbedGoogleError(error: unknown, cls: GoogleErrorClass): Error & { status?: number; reasons: string[] } {
  const facts = googleErrorFacts(error);
  const name = error instanceof Error ? error.name : typeof error;
  const scrubbed = new Error(`Google ${cls} (${name}${facts.status ? ` ${facts.status}` : ''}${facts.reasons.length ? ` ${facts.reasons.join(',')}` : ''}): ${facts.message}`);
  return Object.assign(scrubbed, { status: facts.status, reasons: facts.reasons });
}

/**
 * A failed write as its result (3b spec §3.2): one classifier, classifyGoogleError, for
 * every write helper, instead of matching '403' in the message.
 * - scopes → PERMISSION_DENIED, the grant-write flow;
 * - token → TOKEN_EXPIRED;
 * - forbidden (a read-only calendar, not the organizer) → FORBIDDEN, which no grant fixes;
 * - gone → NOT_FOUND;
 * - transient (rate limits, 5xx, timeouts) → UNKNOWN_ERROR, retryable;
 * - config and anything else → UNKNOWN_ERROR with Google's message.
 * Logged by class and ids only.
 */
function googleWriteFailure(error: unknown, context: string, extra: Record<string, unknown> = {}): WriteFailure {
  const cls = classifyGoogleError(error);
  captureError(scrubbedGoogleError(error, cls), context, extra, cls === 'gone' || cls === 'transient' ? 'warning' : 'error');
  switch (cls) {
    case 'scopes':
      return { success: false, error: 'PERMISSION_DENIED', errorMessage: 'Calendar write permission not granted. Please authorize event changes.' };
    case 'token':
      return { success: false, error: 'TOKEN_EXPIRED', errorMessage: 'Google Calendar access has expired. Please re-authorize.' };
    case 'forbidden':
      return { success: false, error: 'FORBIDDEN', errorMessage: 'Google Calendar does not allow this change.' };
    case 'gone':
      return { success: false, error: 'NOT_FOUND', errorMessage: 'Event not found. It may have been deleted.' };
    case 'transient':
      return { success: false, error: 'UNKNOWN_ERROR', errorMessage: 'Google Calendar did not answer. Please try again.', retryable: true };
    default:
      return { success: false, error: 'UNKNOWN_ERROR', errorMessage: googleErrorFacts(error).message || 'Unknown error' };
  }
}

const RECURRENCE_LINE = /^(RRULE|EXDATE|RDATE)[:;]/i;

/**
 * A recurrence as Google takes it: RRULE, EXDATE and RDATE lines pass as they are, and a
 * bare rule ('FREQ=WEEKLY') gets its RRULE: prefix.
 */
function formatRecurrenceForAPI(recurrence?: string[]): string[] | undefined {
  if (!recurrence || recurrence.length === 0) return undefined;
  return recurrence.map((line) => (RECURRENCE_LINE.test(line) ? line : `RRULE:${line}`));
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
 * Create a new event in Google Calendar, in the user's zone (eventData.timeZone).
 * @param refreshToken - Google OAuth refresh token
 * @param calendarId - Calendar ID to create event in (use 'primary' for user's main calendar)
 * @param eventData - Event details
 * @returns Result with event ID and link (and a series' first occurrence), or error information
 */
export async function createEvent(
  refreshToken: string,
  calendarId: string,
  eventData: CreateEventData
): Promise<CreateEventResult> {
  const calendar = getCalendarClient(refreshToken);
  const zone = eventData.timeZone ?? TIMEZONE;

  try {
    const eventBody: calendar_v3.Schema$Event = {
      summary: eventData.title,
      description: eventData.description,
      location: eventData.location,
    };

    if (eventData.allDay) {
      // All-day event uses date format (YYYY-MM-DD)
      const dates = allDayDates(eventData.startTime, eventData.endTime, zone);
      eventBody.start = { date: dates.start, timeZone: zone };
      eventBody.end = { date: dates.end, timeZone: zone };
    } else {
      // Timed event uses dateTime format (ISO 8601)
      eventBody.start = { dateTime: eventData.startTime.toISOString(), timeZone: zone };
      eventBody.end = { dateTime: eventData.endTime.toISOString(), timeZone: zone };
    }

    // Add recurrence rules if provided
    if (eventData.recurrence && eventData.recurrence.length > 0) {
      eventBody.recurrence = formatRecurrenceForAPI(eventData.recurrence);
    }

    const response = await calendar.events.insert({
      calendarId: calendarId,
      requestBody: eventBody,
    });
    const eventId = response.data.id || undefined;

    return {
      success: true,
      eventId,
      eventLink: response.data.htmlLink || undefined,
      ...(eventId && eventBody.recurrence ? { instanceId: await firstInstanceId(calendar, calendarId, eventId) } : {}),
    };
  } catch (error) {
    return googleWriteFailure(error, 'calendar-create-event', { calendar_id: calendarId });
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

  // Fetch events from all calendars in parallel, as fetchEvents does: one after another
  // they cost the 5-minute reminder run two round trips per calendar per user.
  const results = await Promise.allSettled(
    calendarIds.map(async (calendarId) => {
      // Fetch calendar metadata (for the display name) and events in parallel
      const [calendarInfo, response] = await Promise.all([
        calendar.calendars.get({ calendarId }),
        calendar.events.list({
          calendarId: calendarId,
          timeMin: startDate.toISOString(),
          timeMax: endDate.toISOString(),
          singleEvents: true,
          orderBy: 'startTime',
          timeZone: TIMEZONE,
        }),
      ]);
      const calendarName = calendarInfo.data.summary || calendarId;

      // FamCal's own copies to Google are never read back (google-sync spec §2)
      const events = (response.data.items || []).filter(event => !isSyncCopy(event));

      return events.map((event): CalendarEvent => ({
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
      }));
    })
  );

  // Collect in calendar order, so the events, the failures reported and the token error
  // are the same as when the calendars were fetched one by one
  const allEvents: CalendarEvent[] = [];
  for (const [i, result] of results.entries()) {
    if (result.status === 'fulfilled') {
      allEvents.push(...result.value);
      continue;
    }
    const calendarId = calendarIds[i];
    const error = result.reason;
    console.error(`Error fetching calendar ${calendarId}:`, error);
    captureError(error, 'calendar-fetch-range', { calendarId }, 'warning');

    if (isTokenError(error)) {
      throw new Error('GOOGLE_TOKEN_EXPIRED');
    }
    // Continue with other calendars if it's a different error
  }
  // Not one calendar answered: Google itself couldn't be read, which is no answer at all. The
  // provider's caller (the split fetch) then knows its Google half failed ("Google as a
  // connection" spec §4), instead of reading it as a day with no events. Calendars that are
  // gone (404, 410: deleted, unshared) are no events, not an outage, as the reader's
  // calendars_gone: only a failure that isn't a gone calendar fails the fetch.
  if (
    calendarIds.length > 0 &&
    results.every(r => r.status === 'rejected') &&
    results.some(r => r.status === 'rejected' && classifyGoogleError(r.reason) !== 'gone')
  ) {
    throw new Error('GOOGLE_FETCH_FAILED');
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
  timeZone?: string;              // The user's: the clock an all-day event's instants are on (allDayDates), and the last zone to fall back on
  /** 3b: the new rule from this occurrence on ('RRULE:…' or bare), null to stop; omitted keeps it. */
  rrule?: string | null;
  /** 3b: a 'following' edit's new part goes on this calendar. */
  toCalendarId?: string;
}

/**
 * Result of updating a calendar event
 */
export interface UpdateEventResult {
  success: boolean;
  /** The event written last: the patched one, or a new part's (a split, a replaced rule). */
  eventId?: string;
  eventLink?: string;
  /** Where the opened occurrence is now: its instance id, or a one-off's own id. */
  instanceId?: string;
  /** The calendar it is on now. */
  calendarId?: string;
  error?: GoogleWriteError;
  errorMessage?: string;
  retryable?: boolean;
}

/**
 * Result of deleting a calendar event
 */
export interface DeleteEventResult {
  success: boolean;
  error?: GoogleWriteError;
  errorMessage?: string;
  retryable?: boolean;
}

/**
 * Options for deleting recurring events
 */
export interface DeleteEventOptions {
  scope?: RecurrenceScope;       // For recurring events: single instance, all, or this+following
  recurringEventId?: string;     // Parent event ID for recurring event modifications
}

// ---- The arithmetic of a Google series (3b spec §3.2) ----

type GEvent = calendar_v3.Schema$Event;
type GClient = calendar_v3.Calendar;

/** An occurrence's times as instants in the event's zone: an all-day one from 00:00 on its first day to 23:59 on its last. */
interface Times {
  start: Date;
  end: Date;
  allDay: boolean;
}

const FIXED_DAYS_FAILURE: WriteFailure = {
  success: false,
  error: 'FIXED_DAYS',
  errorMessage: 'A series on set days cannot move its days for more than one occurrence.',
};

/** The bare rule of a recurrence's RRULE line (no RRULE: prefix), or null. */
export function ruleOf(recurrence: readonly string[] | null | undefined): string | null {
  const line = (recurrence ?? []).find((l) => /^RRULE:/i.test(l));
  return line ? line.slice('RRULE:'.length) : null;
}

const bareRule = (rule: string) => rule.replace(/^RRULE:/i, '');
const withoutEnd = (rule: string) => rule.split(';').filter((p) => !/^(UNTIL|COUNT)=/i.test(p)).join(';');
const utcStamp = (d: Date) => formatInTimeZone(d, 'UTC', "yyyyMMdd'T'HHmmss'Z'");
const compactDay = (day: string) => day.replace(/-/g, '');
const dayOfCompact = (v: string) => `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;

/** An RRULE UNTIL as an instant: a UTC stamp as it is, a date as the end of that day in `zone`, a floating time on `zone`'s clock. */
function untilInstant(until: string, zone: string): Date {
  if (/^\d{8}$/.test(until)) return fromZonedTime(`${dayOfCompact(until)}T23:59:59`, zone);
  const wall = `${dayOfCompact(until)}T${until.slice(9, 11)}:${until.slice(11, 13)}:${until.slice(13, 15)}`;
  return until.endsWith('Z') ? new Date(`${wall}Z`) : fromZonedTime(wall, zone);
}

/**
 * A Google rule as the native rule helpers read it (they expand on the event's wall
 * clock): a UTC UNTIL becomes the wall time it is in `zone`.
 */
export function nativeRuleOf(rule: string, zone: string): string {
  return rule.replace(/(^|;)UNTIL=(\d{8}T\d{6})Z(?=;|$)/i, (_m, lead: string, v: string) => `${lead}UNTIL=${formatInTimeZone(untilInstant(`${v}Z`, zone), zone, "yyyyMMdd'T'HHmmss")}`);
}

/** A rule whose UNTIL is the end of `day` (a date for an all-day series, the end of that day in UTC for a timed one). */
function withUntilDay(rule: string, day: string, allDay: boolean, zone: string): string {
  const until = allDay ? compactDay(day) : utcStamp(fromZonedTime(`${day}T23:59:59`, zone));
  return rule.replace(/(^|;)UNTIL=[^;]+/i, `$1UNTIL=${until}`);
}

/** An event's own times (an instance's as shown), in `zone`. */
function timesOf(e: GEvent, zone: string): Times {
  if (e.start?.date) {
    const last = e.end?.date ? addDaysToDate(e.end.date, -1) : e.start.date;
    return { allDay: true, start: startOfLocalDay(e.start.date, zone), end: endOfLocalDay(last < e.start.date ? e.start.date : last, zone) };
  }
  const start = new Date(e.start?.dateTime ?? NaN);
  return { allDay: false, start, end: e.end?.dateTime ? new Date(e.end.dateTime) : start };
}

/** An instance's slot: its original start (an all-day one's 00:00 in `zone`), else its start. */
function slotOf(e: GEvent, zone: string): Date {
  const o = e.originalStartTime;
  if (o?.dateTime) return new Date(o.dateTime);
  if (o?.date) return startOfLocalDay(o.date, zone);
  return timesOf(e, zone).start;
}

/**
 * The times an edit asks for, or null when it asks for none. Missing pieces follow the
 * occurrence as shown: a new start alone keeps its length (its span in days, all day). An
 * all-day edit's instants are on the user's clock (`userTz`), as the bot and the home send them.
 */
function requestedTimes(updates: UpdateEventData, shown: Times, zone: string, userTz: string): Times | null {
  if (updates.startTime === undefined && updates.endTime === undefined && updates.allDay === undefined) return null;
  const allDay = updates.allDay ?? shown.allDay;
  if (allDay) {
    const span = shown.allDay ? Math.max(0, daysFromTo(localDate(shown.start, zone), localDate(shown.end, zone))) : 0;
    const startDay = updates.startTime ? localDate(updates.startTime, userTz) : localDate(shown.start, zone);
    const endExclusive = updates.endTime ? allDayDates(startDay, updates.endTime, userTz).end : addDaysToDate(startDay, span + 1);
    return { allDay: true, start: startOfLocalDay(startDay, zone), end: endOfLocalDay(addDaysToDate(endExclusive, -1), zone) };
  }
  const length = shown.allDay ? 3_600_000 : shown.end.getTime() - shown.start.getTime();
  const start = updates.startTime ?? shown.start;
  return { allDay: false, start, end: updates.endTime ?? new Date(start.getTime() + length) };
}

/** Times as Google's start and end, in the event's zone (an all-day end is the exclusive next date). */
function googleTimes(t: Times, zone: string): Pick<GEvent, 'start' | 'end'> {
  if (t.allDay) {
    const dates = allDayDates(t.start, t.end, zone);
    return { start: { date: dates.start, timeZone: zone }, end: { date: dates.end, timeZone: zone } };
  }
  return { start: { dateTime: t.start.toISOString(), timeZone: zone }, end: { dateTime: t.end.toISOString(), timeZone: zone } };
}

const movesDay = (from: Date, to: Date, zone: string) => localDate(from, zone) !== localDate(to, zone);

/**
 * The zone a write uses (3b spec §3.2 "Zone"): the event's own (an instance's, else its
 * master's start.timeZone), else its calendar's, else the user's. Asking the calendar is
 * one calendarList.get, made only when the events have none; a failure logs and falls
 * through to the user's.
 */
async function eventZone(calendar: GClient, calendarId: string, events: Array<GEvent | undefined>, userTz: string | undefined): Promise<string> {
  for (const e of events) if (e?.start?.timeZone) return e.start.timeZone;
  try {
    const entry = await calendar.calendarList.get({ calendarId });
    if (entry.data.timeZone) return entry.data.timeZone;
  } catch (error) {
    captureError(scrubbedGoogleError(error, classifyGoogleError(error)), 'calendar-write-zone', { calendar_id: calendarId }, 'warning');
  }
  return userTz ?? TIMEZONE;
}

/** The text an edit sets, as Google's fields. */
function textFields(updates: UpdateEventData): GEvent {
  return {
    ...(updates.title !== undefined ? { summary: updates.title } : {}),
    ...(updates.description !== undefined ? { description: updates.description } : {}),
    ...(updates.location !== undefined ? { location: updates.location } : {}),
  };
}

/** The fields a new part takes from the occurrence it starts at, as shown (3b spec §3.2 "Tail fields"); never ids, guests, Meet, files or properties. */
const TAIL_FIELDS = ['summary', 'description', 'location', 'colorId', 'reminders', 'visibility', 'transparency'] as const;
function tailFields(instance: GEvent, updates: UpdateEventData): GEvent {
  const body: GEvent = {};
  for (const f of TAIL_FIELDS) {
    const v = instance[f];
    if (v !== undefined && v !== null) Object.assign(body, { [f]: v });
  }
  return { ...body, ...textFields(updates) };
}

/** An EXDATE or RDATE value: a date, or an instant (UTC, or a wall time in its TZID or the event's zone). */
function exceptionValueAt(value: string, tzid: string | undefined, zone: string): { date?: string; instant?: Date } {
  if (/^\d{8}$/.test(value)) return { date: dayOfCompact(value) };
  return { instant: untilInstant(value, tzid ?? zone) };
}

/**
 * An UNTIL, EXDATE or RDATE instant moved as its series moved, `from` to `to` on `zone`'s
 * wall clock (shiftOnWall, FamCal's arithmetic), written as the series will be: a date all
 * day, else a UTC stamp.
 */
function movedStamp(at: Date, from: Date, to: Date, zone: string, allDay: boolean): string {
  const moved = shiftOnWall(at, from, to, zone);
  return allDay ? compactDay(localDate(moved, zone)) : utcStamp(moved);
}

/** An exception line's values moved as the series moved (movedStamp), as one line. */
function movedExceptionLine(head: string, values: readonly string[], from: Date, to: Date, zone: string, allDay: boolean): string {
  const tzid = /TZID=([^;:]+)/i.exec(head)?.[1];
  const name = head.split(';')[0].toUpperCase();
  const moved = values.map((v) => {
    const at = exceptionValueAt(v, tzid, zone);
    return movedStamp(at.date ? startOfLocalDay(at.date, zone) : at.instant!, from, to, zone, allDay);
  });
  return allDay ? `${name};VALUE=DATE:${moved.join(',')}` : `${name}:${moved.join(',')}`;
}

/** A rule line's UNTIL moved as the series moved (movedStamp), so it keeps its last occurrence; a COUNT, or no end, stays. */
function movedRuleLine(line: string, from: Date, to: Date, zone: string, allDay: boolean): string {
  return line.replace(/([:;])UNTIL=([^;]+)/i, (_m, lead: string, until: string) => `${lead}UNTIL=${movedStamp(untilInstant(until, zone), from, to, zone, allDay)}`);
}

/**
 * A series' recurrence moved as its start moved, `from` to `to` ('all' with a time change,
 * as FamCal's shiftUntil and carriedExdates): its UNTIL and every EXDATE and RDATE value
 * shift with it, so it keeps its last occurrence and its exclusions stay on their slots.
 */
function movedRecurrence(lines: readonly string[], from: Date, to: Date, zone: string, allDay: boolean): string[] {
  return lines.map((line) => {
    if (/^RRULE:/i.test(line)) return movedRuleLine(line, from, to, zone, allDay);
    if (!/^(EXDATE|RDATE)[:;]/i.test(line)) return line;
    const colon = line.indexOf(':');
    return movedExceptionLine(line.slice(0, colon), line.slice(colon + 1).split(',').filter(Boolean), from, to, zone, allDay);
  });
}

/**
 * A recurrence's EXDATE and RDATE lines split at the cut (3b spec §3.2 "Exclusion lines"):
 * the values before it stay with the master, those at or after it go to the new part.
 * `shift` moves the new part's values when its occurrences moved (a new time or day).
 */
function splitExceptionLines(
  lines: readonly string[],
  cut: Date,
  zone: string,
  shift?: { to: Date; allDay: boolean }
): { before: string[]; after: string[] } {
  const before: string[] = [];
  const after: string[] = [];
  const cutDay = localDate(cut, zone);
  for (const line of lines) {
    if (!/^(EXDATE|RDATE)[:;]/i.test(line)) continue;
    const colon = line.indexOf(':');
    const head = line.slice(0, colon);
    const tzid = /TZID=([^;:]+)/i.exec(head)?.[1];
    const early: string[] = [];
    const late: string[] = [];
    for (const v of line.slice(colon + 1).split(',').filter(Boolean)) {
      const at = exceptionValueAt(v, tzid, zone);
      const atOrAfter = at.date ? at.date >= cutDay : at.instant!.getTime() >= cut.getTime();
      (atOrAfter ? late : early).push(v);
    }
    if (early.length) before.push(`${head}:${early.join(',')}`);
    if (!late.length) continue;
    if (!shift || (shift.to.getTime() === cut.getTime())) {
      after.push(`${head}:${late.join(',')}`);
      continue;
    }
    // The new part moved: its excluded occurrences move with it, written in UTC (or as dates).
    after.push(movedExceptionLine(head, late, cut, shift.to, zone, shift.allDay));
  }
  return { before, after };
}

/** The master's recurrence cut before `cut` (3b spec §3.2 "Master"): its COUNT and UNTIL replaced by one UNTIL a second before it, in UTC (a date the day before, all day). */
function headRecurrence(lines: readonly string[], cut: Date, zone: string, allDay: boolean): string[] {
  const until = allDay ? compactDay(addDaysToDate(localDate(cut, zone), -1)) : utcStamp(new Date(cut.getTime() - 1000));
  const { before } = splitExceptionLines(lines, cut, zone);
  const rules = lines.filter((l) => /^RRULE:/i.test(l)).map((l) => `RRULE:${withoutEnd(bareRule(l))};UNTIL=${until}`);
  const others = lines.filter((l) => !RECURRENCE_LINE.test(l));
  return [...rules, ...before, ...others];
}

/**
 * The new part's recurrence for the same rule (3b spec §3.2 "Tail recurrence"): the
 * original UNTIL if there was one (moved as the cut moved, so it keeps its last occurrence,
 * as FamCal's tailRule); else what is left of its COUNT, counted in rule slots
 * from the master's start in its zone (exclusions ignored, at least 1); else no end. Never
 * UNTIL and COUNT together. Its exclusion lines are those at or after the cut.
 */
function tailRecurrence(lines: readonly string[], master: Times, cut: Date, zone: string, tailStart: Date): string[] {
  const { after } = splitExceptionLines(lines, cut, zone, { to: tailStart, allDay: master.allDay });
  const rules = lines.filter((l) => /^RRULE:/i.test(l)).map((l) => {
    const rule = bareRule(l);
    const count = /(^|;)COUNT=(\d+)/i.exec(rule);
    if (/(^|;)UNTIL=/i.test(rule)) return tailStart.getTime() === cut.getTime() ? `RRULE:${rule}` : movedRuleLine(`RRULE:${rule}`, cut, tailStart, zone, master.allDay);
    if (!count) return `RRULE:${rule}`;
    const before = slotsBefore({ rrule: nativeRuleOf(rule, zone), startsAt: master.start, timeZone: zone }, cut);
    return `RRULE:${withCount(rule, Math.max(1, Number(count[2]) - before))}`;
  });
  return [...rules, ...after];
}

/**
 * The new part's recurrence for a new rule (3b spec §2.1 "Ends"): an UNTIL carries over as
 * it is; a COUNT becomes the end of the day of its last occurrence under the old rule (in
 * UTC for a timed series); Never has none. An end before the new part's start moves to that
 * start's day, so the new part keeps its first occurrence.
 */
function newRuleRecurrence(newRule: string, oldRule: string, lines: readonly string[], master: Times, cut: Date, zone: string, tailStart: Date): string[] {
  let rule = endCarriedRule(bareRule(newRule), oldRule, { startsAt: master.start, timeZone: zone }) ?? bareRule(newRule);
  const until = /(^|;)UNTIL=(\d{8})(?=;|$)/i.exec(rule);
  if (until && /(^|;)COUNT=/i.test(oldRule)) rule = withUntilDay(rule, dayOfCompact(until[2]), master.allDay, zone);
  const end = /(^|;)UNTIL=([^;]+)/i.exec(rule)?.[2];
  if (end && untilInstant(end, zone).getTime() < tailStart.getTime()) rule = withUntilDay(rule, localDate(tailStart, zone), master.allDay, zone);
  const { after } = splitExceptionLines(lines, cut, zone, { to: tailStart, allDay: master.allDay });
  return [`RRULE:${rule}`, ...after];
}

/** Whether the series shows an occurrence before `cut` (its slot before it, not cancelled): if not, the cut is its first. */
async function showsOneBefore(calendar: GClient, calendarId: string, masterId: string, cut: Date, zone: string): Promise<boolean> {
  const res = await calendar.events.instances({ calendarId, eventId: masterId, timeMax: cut.toISOString(), maxResults: 50 });
  return (res.data.items ?? []).some((i) => i.status !== 'cancelled' && slotOf(i, zone).getTime() < cut.getTime());
}

/** A series' first occurrence's id; a failed lookup logs and answers undefined (the caller keeps the series id). */
async function firstInstanceId(calendar: GClient, calendarId: string, eventId: string): Promise<string | undefined> {
  try {
    const res = await calendar.events.instances({ calendarId, eventId, maxResults: 1 });
    return res.data.items?.[0]?.id ?? undefined;
  } catch (error) {
    captureError(scrubbedGoogleError(error, classifyGoogleError(error)), 'calendar-instance-lookup', { calendar_id: calendarId, event_id: eventId }, 'warning');
    return undefined;
  }
}

/** The id of a series' occurrence at `slot`; when Google lists none, its id by Google's convention (<id>_<UTC stamp>, <id>_<date>). */
async function instanceIdAt(calendar: GClient, calendarId: string, masterId: string, slot: Date, allDay: boolean, zone: string): Promise<string> {
  const conventional = `${masterId}_${allDay ? compactDay(localDate(slot, zone)) : utcStamp(slot)}`;
  try {
    const res = await calendar.events.instances({ calendarId, eventId: masterId, originalStart: allDay ? localDate(slot, zone) : slot.toISOString(), maxResults: 1 });
    return res.data.items?.[0]?.id ?? conventional;
  } catch (error) {
    captureError(scrubbedGoogleError(error, classifyGoogleError(error)), 'calendar-instance-lookup', { calendar_id: calendarId, event_id: masterId }, 'warning');
    return conventional;
  }
}

/**
 * After a series was cut at `cut`: exceptions Google kept past its new end (3b spec §3.2
 * "Strays") are deleted, and their count logged. A failure here logs and doesn't fail the
 * write, which has already taken.
 */
async function deleteStrays(calendar: GClient, calendarId: string, masterId: string, cut: Date, zone: string): Promise<void> {
  let deleted = 0;
  try {
    let pageToken: string | undefined;
    let pages = 0;
    do {
      const res = await calendar.events.instances({ calendarId, eventId: masterId, timeMin: cut.toISOString(), maxResults: 250, ...(pageToken ? { pageToken } : {}) });
      for (const i of res.data.items ?? []) {
        if (!i.id || i.status === 'cancelled' || slotOf(i, zone).getTime() < cut.getTime()) continue;
        await calendar.events.delete({ calendarId, eventId: i.id });
        deleted++;
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken && ++pages < 10);
  } catch (error) {
    captureError(scrubbedGoogleError(error, classifyGoogleError(error)), 'calendar-following-strays', { calendar_id: calendarId, event_id: masterId, deleted }, 'warning');
    return;
  }
  if (deleted > 0) console.log(`[calendar] following: ${deleted} stray occurrence(s) after the cut deleted (calendar ${calendarId}, series ${masterId})`);
}

/**
 * Update an existing event in Google Calendar, for a scope (3b spec §3.2). The bot and the
 * calendar home share it. `eventId` is the occurrence (an instance id) for a series, with
 * `updates.recurringEventId` its master:
 * - 'single': a patch of the occurrence (a one-off: of itself; a new rule on a one-off is
 *   patched onto it);
 * - 'all': a patch of the master; a time change shifts it as the occurrence moved;
 * - 'following', and any rule change on a series: from the occurrence on (its slot is the cut).
 * Only what `updates` sets is written; the writes use the event's own zone.
 */
export async function updateEvent(
  refreshToken: string,
  calendarId: string,
  eventId: string,
  updates: UpdateEventData
): Promise<UpdateEventResult> {
  const calendar = getCalendarClient(refreshToken);
  const scope = updates.scope || 'single';
  const masterId = updates.recurringEventId && updates.recurringEventId !== eventId ? updates.recurringEventId : undefined;
  const fromOccurrence = Boolean(masterId) && (scope === 'following' || updates.rrule !== undefined);
  try {
    if (masterId && fromOccurrence) return await updateFromOccurrence(calendar, calendarId, eventId, masterId, updates);
    if (masterId && scope === 'all') return await updateSeries(calendar, calendarId, eventId, masterId, updates);
    return await updateOne(calendar, calendarId, eventId, updates);
  } catch (error) {
    return googleWriteFailure(error, fromOccurrence ? 'calendar-update-following' : 'calendar-update-event', { calendar_id: calendarId, event_id: eventId, scope });
  }
}

/** One event: an occurrence (an exception of it), or a one-off, which a rule turns into a series keeping its id. */
async function updateOne(calendar: GClient, calendarId: string, eventId: string, updates: UpdateEventData): Promise<UpdateEventResult> {
  const body = textFields(updates);
  const timed = updates.startTime !== undefined || updates.endTime !== undefined || updates.allDay !== undefined;
  const repeats = typeof updates.rrule === 'string';
  if (timed || repeats) {
    const current = (await calendar.events.get({ calendarId, eventId })).data;
    const zone = await eventZone(calendar, calendarId, [current], updates.timeZone);
    const shown = timesOf(current, zone);
    // A series needs its zone on its start: the times go along with a new rule, moved or not.
    Object.assign(body, googleTimes(requestedTimes(updates, shown, zone, updates.timeZone ?? zone) ?? shown, zone));
    if (repeats) body.recurrence = formatRecurrenceForAPI([updates.rrule as string]);
  }
  const response = await calendar.events.patch({ calendarId, eventId, requestBody: body });
  const id = response.data.id || eventId;
  return {
    success: true,
    eventId: id,
    eventLink: response.data.htmlLink || undefined,
    instanceId: repeats ? ((await firstInstanceId(calendar, calendarId, id)) ?? id) : id,
    calendarId,
  };
}

/**
 * Every occurrence (3b spec §3.2 "'all' with a time change"): the master's fields, and for
 * a time change its start moved as the occurrence moved (seriesTimesFor, FamCal's
 * arithmetic): by the days from where it is shown to where it goes, at its new time of day
 * on the event's wall clock (whole days, all day). Its recurrence moves with it
 * (movedRecurrence): the UNTIL and every EXDATE and RDATE value. A day move on a rule with
 * fixed days is refused before anything is written.
 */
async function updateSeries(calendar: GClient, calendarId: string, instanceId: string, masterId: string, updates: UpdateEventData): Promise<UpdateEventResult> {
  const body = textFields(updates);
  let newSlot: { at: Date; allDay: boolean; zone: string } | null = null;
  if (updates.startTime !== undefined || updates.endTime !== undefined || updates.allDay !== undefined) {
    const [master, instance] = await Promise.all([
      calendar.events.get({ calendarId, eventId: masterId }).then((r) => r.data),
      calendar.events.get({ calendarId, eventId: instanceId }).then((r) => r.data),
    ]);
    const zone = await eventZone(calendar, calendarId, [instance, master], updates.timeZone);
    const shown = timesOf(instance, zone);
    const to = requestedTimes(updates, shown, zone, updates.timeZone ?? zone)!;
    if (fixesDays(ruleOf(master.recurrence)) && movesDay(shown.start, to.start, zone)) return FIXED_DAYS_FAILURE;
    const target = { startsAt: to.start, endsAt: to.end, allDay: to.allDay };
    const masterTimes = timesOf(master, zone);
    const moved = seriesTimesFor({ startsAt: masterTimes.start, timeZone: zone }, shown.start, target);
    Object.assign(body, googleTimes({ start: moved.startsAt, end: moved.endsAt, allDay: to.allDay }, zone));
    const lines = master.recurrence ?? [];
    if (masterTimes.start.getTime() !== moved.startsAt.getTime() || masterTimes.allDay !== to.allDay) {
      const recurrence = movedRecurrence(lines, masterTimes.start, moved.startsAt, zone, to.allDay);
      if (recurrence.some((l, i) => l !== lines[i])) body.recurrence = recurrence;
    }
    newSlot = { at: seriesTimesFor({ startsAt: slotOf(instance, zone), timeZone: zone }, shown.start, target).startsAt, allDay: to.allDay, zone };
  }
  const response = await calendar.events.patch({ calendarId, eventId: masterId, requestBody: body });
  return {
    success: true,
    eventId: response.data.id || masterId,
    eventLink: response.data.htmlLink || undefined,
    instanceId: newSlot ? await instanceIdAt(calendar, calendarId, masterId, newSlot.at, newSlot.allDay, newSlot.zone) : instanceId,
    calendarId,
  };
}

/**
 * "This one and the ones after", and any rule change (3b spec §3.2): the cut is the
 * occurrence's slot (originalStartTime).
 * - At the series' first shown occurrence it runs as 'all': the master changes in place (a
 *   calendar change moves it first), and a new rule or a stop replaces it (the new event is
 *   inserted, then the master deleted, which takes its exceptions along).
 * - Later, the master ends before the cut and a new part starts there: the same rule with
 *   what is left of its end, or the new rule with the old end, or (a stop) a one-off at the
 *   occurrence as shown. The new part takes the cut occurrence's fields, goes on the
 *   destination calendar when there is one, and exceptions left past the cut are deleted.
 */
async function updateFromOccurrence(calendar: GClient, calendarId: string, instanceId: string, masterId: string, updates: UpdateEventData): Promise<UpdateEventResult> {
  const [master, instance] = await Promise.all([
    calendar.events.get({ calendarId, eventId: masterId }).then((r) => r.data),
    calendar.events.get({ calendarId, eventId: instanceId }).then((r) => r.data),
  ]);
  if (instance.status === 'cancelled') return { success: false, error: 'NOT_FOUND', errorMessage: 'Event not found. It may have been deleted.' };
  const lines = master.recurrence ?? [];
  const rule = ruleOf(lines);
  if (!rule) return updateOne(calendar, calendarId, instanceId, { ...updates, scope: 'single' });
  const zone = await eventZone(calendar, calendarId, [instance, master], updates.timeZone);
  const userTz = updates.timeZone ?? zone;
  const masterTimes = timesOf(master, zone);
  const cut = slotOf(instance, zone);
  const newRule = updates.rrule === undefined ? undefined : updates.rrule === null ? null : bareRule(updates.rrule);
  const stop = newRule === null;
  const ruleAfter = newRule !== undefined ? newRule : rule;
  const shown = timesOf(instance, zone);
  const to = requestedTimes(updates, shown, zone, userTz);
  if (to && !stop && fixesDays(ruleAfter) && movesDay(shown.start, to.start, zone)) return FIXED_DAYS_FAILURE;

  // Where the new part (or the one-off) starts: a stop keeps the occurrence's own times; a
  // new time follows followingTimesFor (FamCal's); no new time starts it at the cut, with
  // the series' own length.
  let tail: Times;
  if (stop) {
    tail = to ?? shown;
  } else if (to) {
    const t = followingTimesFor({ rrule: nativeRuleOf(ruleAfter ?? rule, zone), timeZone: zone }, cut, shown.start, { startsAt: to.start, endsAt: to.end, allDay: to.allDay });
    tail = { start: t.startsAt, end: t.endsAt, allDay: to.allDay };
  } else if (masterTimes.allDay) {
    const cutDay = localDate(cut, zone);
    tail = { allDay: true, start: cut, end: endOfLocalDay(addDaysToDate(cutDay, daysFromTo(localDate(masterTimes.start, zone), localDate(masterTimes.end, zone))), zone) };
  } else {
    tail = { allDay: false, start: cut, end: new Date(cut.getTime() + (masterTimes.end.getTime() - masterTimes.start.getTime())) };
  }
  const destination = updates.toCalendarId && updates.toCalendarId !== calendarId ? updates.toCalendarId : undefined;
  const first = !(await showsOneBefore(calendar, calendarId, masterId, cut, zone));

  if (first && newRule === undefined) {
    // As 'all', in place: the series keeps its id; it starts at the new part's start.
    let onCalendar = calendarId;
    if (destination) {
      await calendar.events.move({ calendarId, eventId: masterId, destination });
      onCalendar = destination;
    }
    const body = textFields(updates);
    if (to) Object.assign(body, googleTimes(tail, zone), { recurrence: [...tailRecurrence(lines, masterTimes, cut, zone, tail.start), ...lines.filter((l) => !RECURRENCE_LINE.test(l))] });
    let link = master.htmlLink ?? undefined;
    if (Object.keys(body).length > 0) {
      try {
        link = (await calendar.events.patch({ calendarId: onCalendar, eventId: masterId, requestBody: body })).data.htmlLink ?? link;
      } catch (error) {
        // After a move that took (3b spec §3.2 "Move"): the series is on the destination now,
        // so the failure is logged and its key there returned, the occurrence as it was.
        if (!destination) throw error;
        captureError(scrubbedGoogleError(error, classifyGoogleError(error)), 'calendar-update-following-patch-after-move', {
          calendar_id: onCalendar, event_id: masterId,
        });
        return { success: true, eventId: masterId, eventLink: link, instanceId, calendarId: onCalendar };
      }
    }
    return {
      success: true,
      eventId: masterId,
      eventLink: link,
      instanceId: to ? await instanceIdAt(calendar, onCalendar, masterId, tail.start, tail.allDay, zone) : instanceId,
      calendarId: onCalendar,
    };
  }

  const onCalendar = destination ?? calendarId;
  const body: GEvent = { ...tailFields(instance, updates), ...googleTimes(tail, zone) };
  if (!stop) {
    body.recurrence = newRule !== undefined
      ? newRuleRecurrence(newRule, rule, lines, masterTimes, cut, zone, tail.start)
      : tailRecurrence(lines, masterTimes, cut, zone, tail.start);
  }
  if (first) {
    // A new rule or a stop from the first occurrence: the new event replaces the series.
    const inserted = (await calendar.events.insert({ calendarId: onCalendar, requestBody: body })).data;
    await calendar.events.delete({ calendarId, eventId: masterId });
    const id = inserted.id ?? '';
    return { success: true, eventId: id, eventLink: inserted.htmlLink ?? undefined, instanceId: stop ? id : ((await firstInstanceId(calendar, onCalendar, id)) ?? id), calendarId: onCalendar };
  }
  await calendar.events.patch({ calendarId, eventId: masterId, requestBody: { recurrence: headRecurrence(lines, cut, zone, masterTimes.allDay) } });
  const inserted = (await calendar.events.insert({ calendarId: onCalendar, requestBody: body })).data;
  await deleteStrays(calendar, calendarId, masterId, cut, zone);
  const id = inserted.id ?? '';
  return { success: true, eventId: id, eventLink: inserted.htmlLink ?? undefined, instanceId: stop ? id : ((await firstInstanceId(calendar, onCalendar, id)) ?? id), calendarId: onCalendar };
}

/**
 * Delete an event from Google Calendar, for a scope (3b spec §3.2): 'single' the occurrence
 * (or a one-off), 'all' the master, 'following' the master cut before the occurrence (the
 * whole series from its first shown occurrence).
 */
export async function deleteEvent(
  refreshToken: string,
  calendarId: string,
  eventId: string,
  options?: DeleteEventOptions
): Promise<DeleteEventResult> {
  const calendar = getCalendarClient(refreshToken);
  const scope = options?.scope || 'single';
  const masterId = options?.recurringEventId && options.recurringEventId !== eventId ? options.recurringEventId : undefined;
  try {
    if (scope === 'following' && masterId) {
      const [master, instance] = await Promise.all([
        calendar.events.get({ calendarId, eventId: masterId }).then((r) => r.data),
        calendar.events.get({ calendarId, eventId }).then((r) => r.data),
      ]);
      const zone = await eventZone(calendar, calendarId, [instance, master], undefined);
      const cut = slotOf(instance, zone);
      if (!(await showsOneBefore(calendar, calendarId, masterId, cut, zone))) {
        await calendar.events.delete({ calendarId, eventId: masterId });
        return { success: true };
      }
      const lines = master.recurrence ?? [];
      await calendar.events.patch({ calendarId, eventId: masterId, requestBody: { recurrence: headRecurrence(lines, cut, zone, timesOf(master, zone).allDay) } });
      await deleteStrays(calendar, calendarId, masterId, cut, zone);
      return { success: true };
    }
    await calendar.events.delete({ calendarId, eventId: scope === 'all' && masterId ? masterId : eventId });
    return { success: true };
  } catch (error) {
    return googleWriteFailure(error, scope === 'following' ? 'calendar-delete-following' : 'calendar-delete-event', { calendar_id: calendarId, event_id: eventId, scope });
  }
}

/** Result of moving an event to another calendar */
export interface MoveEventResult {
  success: boolean;
  eventId?: string;
  error?: GoogleWriteError;
  errorMessage?: string;
  retryable?: boolean;
}

/**
 * Move an event (a series: its master, which takes every occurrence and exception along)
 * to another calendar with Google's own move (3b spec §3.2 "Move"). It keeps its id, its
 * Meet link and its own alert overrides; no guest is notified.
 */
export async function moveEvent(refreshToken: string, fromCalendarId: string, eventId: string, toCalendarId: string): Promise<MoveEventResult> {
  const calendar = getCalendarClient(refreshToken);
  try {
    const response = await calendar.events.move({ calendarId: fromCalendarId, eventId, destination: toCalendarId });
    return { success: true, eventId: response.data.id || eventId };
  } catch (error) {
    return googleWriteFailure(error, 'calendar-move-event', { calendar_id: fromCalendarId, to_calendar_id: toCalendarId, event_id: eventId });
  }
}

/**
 * Whether updateEvent would refuse this edit as a day move on a rule with fixed days
 * (FIXED_DAYS), asked before the bot's confirmation card: it reads the master (the rule
 * that will be stored: a new one when the edit sets it) and the occurrence. A read error
 * logs and answers false (the write asks again).
 */
export async function wouldRefuseFixedDays(refreshToken: string, calendarId: string, eventId: string, updates: UpdateEventData): Promise<boolean> {
  const masterId = updates.recurringEventId && updates.recurringEventId !== eventId ? updates.recurringEventId : undefined;
  const scope = updates.scope || 'single';
  if (!masterId || (scope === 'single' && updates.rrule === undefined)) return false;
  if (updates.startTime === undefined && updates.endTime === undefined && updates.allDay === undefined) return false;
  if (updates.rrule === null) return false;
  try {
    const calendar = getCalendarClient(refreshToken);
    const [master, instance] = await Promise.all([
      calendar.events.get({ calendarId, eventId: masterId }).then((r) => r.data),
      calendar.events.get({ calendarId, eventId }).then((r) => r.data),
    ]);
    const rule = typeof updates.rrule === 'string' ? bareRule(updates.rrule) : ruleOf(master.recurrence);
    if (!fixesDays(rule)) return false;
    const zone = await eventZone(calendar, calendarId, [instance, master], updates.timeZone);
    const shown = timesOf(instance, zone);
    const to = requestedTimes(updates, shown, zone, updates.timeZone ?? zone);
    return to !== null && movesDay(shown.start, to.start, zone);
  } catch (error) {
    captureError(scrubbedGoogleError(error, classifyGoogleError(error)), 'google-fixed-days-check', { calendar_id: calendarId, event_id: eventId }, 'warning');
    return false;
  }
}

/** What the home's edit info reads of one Google item, live (3b spec §3.3). */
export interface GoogleItemRead {
  /** The user's role on the calendar ('owner', 'writer', 'reader', 'freeBusyReader'). */
  accessRole: string;
  /** The calendar's own zone, when Google gives it. */
  calendarTimeZone?: string;
  /** The event as the key names it: an occurrence (instance) or a one-off. */
  event: GEvent;
  /** A series' master, when the event is an occurrence. */
  master?: GEvent;
  /** The series shows no occurrence before this one (true for a one-off). */
  first: boolean;
  /** The zone the event is written in: its own, else its calendar's (undefined: the user's). */
  zone?: string;
}

/**
 * One Google item, read for the editor: calendarList.get (the role) and events.get of the
 * event, then its master for a series. Google's errors are thrown, for the caller to sort
 * with classifyGoogleError.
 */
export async function readEventForEdit(refreshToken: string, calendarId: string, eventId: string, userTz?: string): Promise<GoogleItemRead> {
  const calendar = getCalendarClient(refreshToken);
  const [entry, event] = await Promise.all([
    calendar.calendarList.get({ calendarId }).then((r) => r.data),
    calendar.events.get({ calendarId, eventId }).then((r) => r.data),
  ]);
  const masterId = event.recurringEventId && event.recurringEventId !== eventId ? event.recurringEventId : undefined;
  const master = masterId ? (await calendar.events.get({ calendarId, eventId: masterId })).data : undefined;
  const zone = event.start?.timeZone ?? master?.start?.timeZone ?? entry.timeZone ?? undefined;
  const first = !masterId || !(await showsOneBefore(calendar, calendarId, masterId, slotOf(event, zone ?? userTz ?? TIMEZONE), zone ?? userTz ?? TIMEZONE));
  return { accessRole: entry.accessRole ?? 'reader', calendarTimeZone: entry.timeZone ?? undefined, event, ...(master ? { master } : {}), first, ...(zone ? { zone } : {}) };
}

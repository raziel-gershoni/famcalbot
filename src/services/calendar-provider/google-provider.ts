// Google Calendar provider — adapter over the existing src/services/calendar.ts
// surface. Behavior is identical to the pre-abstraction direct calls; the additions
// are the `provider: 'google'` tag on every returned event/calendar, and the calendar
// home's cache stamp after every write.

import {
  fetchEventsInRange as gcalFetchRange,
  listUserCalendars as gcalListCalendars,
  createEvent as gcalCreate,
  updateEvent as gcalUpdate,
  deleteEvent as gcalDelete,
  moveEvent as gcalMove,
  wouldRefuseFixedDays as gcalWouldRefuseFixedDays,
} from '../calendar';
import {
  CalendarProvider,
  UnifiedEvent,
  UnifiedCalendar,
  CreateEventInput,
  CreateEventResult,
  UpdateEventInput,
  UpdateEventResult,
  DeleteEventOptions,
  DeleteEventResult,
  MoveEventInput,
  MoveEventResult,
} from './types';
import { UserConfig } from '../../types';
import { stampGoogleCache } from '../calendar-read/google';

const PROVIDER_NAME = 'google' as const;

/**
 * The user's timezone: a new event's zone, the clock an all-day event's instants are on
 * (see CreateEventInput), and the last zone an edit falls back on when neither the event
 * nor its calendar has one (calendar.ts, 3b spec §3.2 "Zone").
 */
async function userTimezone(user: UserConfig): Promise<string> {
  const { resolveUserTimezone } = await import('../../lib/timezone');
  return resolveUserTimezone(user);
}

/**
 * Runs a write to Google, then stamps the user's calendar-home cache (spec §2.6) whatever
 * happened: a failed write may still have changed Google ("this and following" is two
 * calls). The stamp never throws and runs once the write's outcome is in hand, so the
 * caller gets the write's own result or error.
 */
async function writeThenStamp<T>(userId: number, write: () => Promise<T>): Promise<T> {
  let result: T;
  try {
    result = await write();
  } catch (err) {
    await stampGoogleCache(userId);
    throw err;
  }
  await stampGoogleCache(userId);
  return result;
}

function notConnected(action: string): {
  success: false;
  error: 'NOT_CONNECTED';
  errorMessage: string;
} {
  return {
    success: false,
    error: 'NOT_CONNECTED',
    errorMessage: `Cannot ${action}: Google Calendar is not connected.`,
  };
}

export const googleProvider: CalendarProvider = {
  name: PROVIDER_NAME,

  async fetchEventsInRange(user: UserConfig, calendarIds: string[], startDate: Date, endDate: Date): Promise<UnifiedEvent[]> {
    // The union list (getCalendarAssignmentsForUser) holds FamCal ids too; they are never Google's.
    const googleIds = calendarIds.filter((id) => !id.startsWith('native:'));
    if (!user.googleRefreshToken || googleIds.length === 0) return [];
    const events = await gcalFetchRange(user.googleRefreshToken, googleIds, startDate, endDate);
    return events.map((e) => ({ ...e, provider: PROVIDER_NAME }));
  },

  async listCalendars(user: UserConfig): Promise<UnifiedCalendar[]> {
    if (!user.googleRefreshToken) return [];
    const cals = await gcalListCalendars(user.googleRefreshToken);
    return cals.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      primary: c.primary,
      accessRole: c.accessRole,
      backgroundColor: c.backgroundColor,
      provider: PROVIDER_NAME,
    }));
  },

  async createEvent(user: UserConfig, calendarId: string, data: CreateEventInput): Promise<CreateEventResult> {
    // Google cannot hold a Hebrew-date rule, and its yearly rule would repeat on the wrong day:
    // the bot's recurrenceFields never sends one, so this is a bug upstream, refused loudly.
    if (data.hebrewRule) {
      console.error(`[GoogleProvider] refusing a Hebrew repeat (${data.hebrewRule}) for user ${user.id}: Google Calendar cannot hold it`);
      return { success: false, error: 'UNKNOWN_ERROR', errorMessage: 'Google Calendar cannot repeat by the Hebrew date' };
    }
    if (!user.googleRefreshToken) return notConnected('create event');
    const result = await writeThenStamp(user.id, async () => gcalCreate(user.googleRefreshToken, calendarId, {
      title: data.title,
      startTime: data.startTime,
      endTime: data.endTime,
      description: data.description,
      location: data.location,
      allDay: data.allDay,
      recurrence: data.recurrence,
      timeZone: await userTimezone(user),
    }));
    return result;
  },

  async updateEvent(user: UserConfig, calendarId: string, eventId: string, data: UpdateEventInput): Promise<UpdateEventResult> {
    if (!user.googleRefreshToken) return notConnected('update event');
    const result = await writeThenStamp(user.id, async () => gcalUpdate(user.googleRefreshToken, calendarId, eventId, {
      title: data.title,
      startTime: data.startTime,
      endTime: data.endTime,
      description: data.description,
      location: data.location,
      allDay: data.allDay,
      scope: data.scope,
      recurringEventId: data.recurringEventId,
      // instanceStartsAt is native-only; GCal uses the instance eventId (the occurrence) directly.
      rrule: data.rrule,
      toCalendarId: data.toCalendarId,
      timeZone: await userTimezone(user),
    }));
    return result;
  },

  async deleteEvent(user: UserConfig, calendarId: string, eventId: string, options?: DeleteEventOptions): Promise<DeleteEventResult> {
    if (!user.googleRefreshToken) return notConnected('delete event');
    const result = await writeThenStamp(user.id, async () => gcalDelete(user.googleRefreshToken, calendarId, eventId, {
      scope: options?.scope,
      recurringEventId: options?.recurringEventId,
    }));
    return result;
  },

  async moveEvent(user: UserConfig, move: MoveEventInput): Promise<MoveEventResult> {
    if (!user.googleRefreshToken) return notConnected('move event');
    return writeThenStamp(user.id, () => gcalMove(user.googleRefreshToken, move.fromCalendarId, move.eventId, move.toCalendarId));
  },
};

/**
 * Whether the Google write would refuse this edit as a day move on a series with fixed days
 * (FIXED_DAYS), asked before the bot's confirmation card. It only reads; a read error logs
 * and answers false.
 */
export async function wouldRefuseFixedDaysOnGoogle(user: UserConfig, calendarId: string, eventId: string, data: UpdateEventInput): Promise<boolean> {
  if (!user.googleRefreshToken) return false;
  return gcalWouldRefuseFixedDays(user.googleRefreshToken, calendarId, eventId, {
    startTime: data.startTime,
    endTime: data.endTime,
    allDay: data.allDay,
    scope: data.scope,
    recurringEventId: data.recurringEventId,
    rrule: data.rrule,
    timeZone: await userTimezone(user),
  });
}

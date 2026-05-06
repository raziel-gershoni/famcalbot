// Google Calendar provider — adapter over the existing src/services/calendar.ts
// surface. Behavior is identical to the pre-abstraction direct calls; the only
// addition is the `provider: 'google'` tag on every returned event/calendar.

import {
  fetchTodayEvents as gcalFetchToday,
  fetchTomorrowEvents as gcalFetchTomorrow,
  fetchEventsInRange as gcalFetchRange,
  listUserCalendars as gcalListCalendars,
  createEvent as gcalCreate,
  updateEvent as gcalUpdate,
  deleteEvent as gcalDelete,
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
} from './types';
import { UserConfig } from '../../types';

const PROVIDER_NAME = 'google' as const;

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

  async fetchTodayEvents(user: UserConfig, calendarIds: string[], timezone?: string): Promise<UnifiedEvent[]> {
    if (!user.googleRefreshToken || calendarIds.length === 0) return [];
    const events = await gcalFetchToday(user.googleRefreshToken, calendarIds, timezone);
    return events.map((e) => ({ ...e, provider: PROVIDER_NAME }));
  },

  async fetchTomorrowEvents(user: UserConfig, calendarIds: string[], timezone?: string): Promise<UnifiedEvent[]> {
    if (!user.googleRefreshToken || calendarIds.length === 0) return [];
    const events = await gcalFetchTomorrow(user.googleRefreshToken, calendarIds, timezone);
    return events.map((e) => ({ ...e, provider: PROVIDER_NAME }));
  },

  async fetchEventsInRange(user: UserConfig, calendarIds: string[], startDate: Date, endDate: Date): Promise<UnifiedEvent[]> {
    if (!user.googleRefreshToken || calendarIds.length === 0) return [];
    const events = await gcalFetchRange(user.googleRefreshToken, calendarIds, startDate, endDate);
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
    if (!user.googleRefreshToken) return notConnected('create event');
    const result = await gcalCreate(user.googleRefreshToken, calendarId, {
      title: data.title,
      startTime: data.startTime,
      endTime: data.endTime,
      description: data.description,
      location: data.location,
      allDay: data.allDay,
      recurrence: data.recurrence,
    });
    return result;
  },

  async updateEvent(user: UserConfig, calendarId: string, eventId: string, data: UpdateEventInput): Promise<UpdateEventResult> {
    if (!user.googleRefreshToken) return notConnected('update event');
    const result = await gcalUpdate(user.googleRefreshToken, calendarId, eventId, {
      title: data.title,
      startTime: data.startTime,
      endTime: data.endTime,
      description: data.description,
      location: data.location,
      allDay: data.allDay,
      scope: data.scope,
      recurringEventId: data.recurringEventId,
      // instanceStartsAt is native-only; GCal uses the instance eventId directly.
    });
    return result;
  },

  async deleteEvent(user: UserConfig, calendarId: string, eventId: string, options?: DeleteEventOptions): Promise<DeleteEventResult> {
    if (!user.googleRefreshToken) return notConnected('delete event');
    const result = await gcalDelete(user.googleRefreshToken, calendarId, eventId, {
      scope: options?.scope,
      recurringEventId: options?.recurringEventId,
    });
    return result;
  },
};

// In-bot native calendar provider — implements CalendarProvider against the
// NativeCalendar / NativeEvent / NativeEventInstance tables.
//
// PR 3 wires this internally only; getProviderForUser still returns the Google
// provider for everyone. PR 4 will branch on user.calendarSource.

import { format } from 'date-fns';
import { fromZonedTime } from 'date-fns-tz';
import {
  CalendarProvider,
  CreateEventInput,
  CreateEventResult,
  DeleteEventOptions,
  DeleteEventResult,
  UnifiedCalendar,
  UnifiedEvent,
  UpdateEventInput,
  UpdateEventResult,
} from './types';
import { UserConfig } from '../../types';
import {
  NativePermissionDeniedError,
  NativeNotFoundError,
  createNativeEvent,
  decodeCalendarId,
  decodeEventId,
  deleteNativeEvent,
  encodeCalendarId,
  encodeEventId,
  fetchEventsInCalendars,
  isNativeCalendarId,
  listVisibleCalendars,
  updateNativeEvent,
  UpdateScope,
} from '../native-calendar/event-store';
import { TIMEZONE } from '../../config/constants';

const PROVIDER_NAME = 'native' as const;

function ownDayBoundaries(daysOffset: number, tz: string): { from: Date; to: Date } {
  const nowLocal = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
  const target = new Date(nowLocal);
  target.setDate(target.getDate() + daysOffset);
  const dateStr = format(target, 'yyyy-MM-dd');
  return {
    from: fromZonedTime(`${dateStr} 00:00:00`, tz),
    to: fromZonedTime(`${dateStr} 23:59:59.999`, tz),
  };
}

/**
 * Translate stored NativeCalendar + VirtualInstance into the UnifiedEvent shape
 * downstream code already knows how to render. Date strings mirror GCal's
 * format: `YYYY-MM-DD` for all-day, ISO8601 for timed.
 */
function toUnifiedEvent(
  calendar: { id: string; name: string },
  instance: {
    title: string;
    description?: string;
    location?: string;
    startsAt: Date;
    endsAt: Date;
    allDay: boolean;
    seriesEventId: string;
    instanceStartsAt: Date;
    isRecurringInstance: boolean;
  }
): UnifiedEvent {
  const start = instance.allDay
    ? format(instance.startsAt, 'yyyy-MM-dd')
    : instance.startsAt.toISOString();
  const end = instance.allDay
    ? format(instance.endsAt, 'yyyy-MM-dd')
    : instance.endsAt.toISOString();

  return {
    summary: instance.title,
    start,
    end,
    description: instance.description,
    location: instance.location,
    calendarName: calendar.name,
    calendarId: encodeCalendarId(calendar.id),
    eventType: undefined,
    recurringEventId: instance.isRecurringInstance ? instance.seriesEventId : undefined,
    eventId: encodeEventId(instance.seriesEventId, instance.isRecurringInstance ? instance.instanceStartsAt : undefined),
    reminders: undefined,
    provider: PROVIDER_NAME,
    instanceStartsAt: instance.isRecurringInstance ? instance.instanceStartsAt.toISOString() : undefined,
  };
}

function filterCalendarCuids(calendarIds: string[]): string[] {
  const out: string[] = [];
  for (const id of calendarIds) {
    const cuid = decodeCalendarId(id);
    if (cuid) out.push(cuid);
  }
  return out;
}

// Map permission/parsing errors from event-store into provider error shape.
function toErrorResult<T extends { success: boolean; error?: string; errorMessage?: string }>(err: unknown): T {
  if (err instanceof NativePermissionDeniedError) {
    return {
      success: false,
      error: 'PERMISSION_DENIED',
      errorMessage: err.message,
    } as unknown as T;
  }
  if (err instanceof NativeNotFoundError) {
    return {
      success: false,
      error: 'NOT_FOUND',
      errorMessage: err.message,
    } as unknown as T;
  }
  const errorMessage = err instanceof Error ? err.message : String(err);
  return {
    success: false,
    error: 'UNKNOWN_ERROR',
    errorMessage,
  } as unknown as T;
}

function mapScope(s?: 'single' | 'all' | 'following'): UpdateScope {
  return s ?? 'single';
}

export const nativeProvider: CalendarProvider = {
  name: PROVIDER_NAME,

  async fetchTodayEvents(user: UserConfig, calendarIds: string[], timezone?: string): Promise<UnifiedEvent[]> {
    const tz = timezone || TIMEZONE;
    const cuids = filterCalendarCuids(calendarIds);
    if (cuids.length === 0) return [];
    const range = ownDayBoundaries(0, tz);
    const rows = await fetchEventsInCalendars(cuids, range);
    return rows.map((r) => toUnifiedEvent(r.calendar, r.instance));
  },

  async fetchTomorrowEvents(user: UserConfig, calendarIds: string[], timezone?: string): Promise<UnifiedEvent[]> {
    const tz = timezone || TIMEZONE;
    const cuids = filterCalendarCuids(calendarIds);
    if (cuids.length === 0) return [];
    const range = ownDayBoundaries(1, tz);
    const rows = await fetchEventsInCalendars(cuids, range);
    return rows.map((r) => toUnifiedEvent(r.calendar, r.instance));
  },

  async fetchEventsInRange(
    user: UserConfig,
    calendarIds: string[],
    startDate: Date,
    endDate: Date
  ): Promise<UnifiedEvent[]> {
    const cuids = filterCalendarCuids(calendarIds);
    if (cuids.length === 0) return [];
    const rows = await fetchEventsInCalendars(cuids, { from: startDate, to: endDate });
    return rows.map((r) => toUnifiedEvent(r.calendar, r.instance));
  },

  async listCalendars(user: UserConfig): Promise<UnifiedCalendar[]> {
    const cals = await listVisibleCalendars(user.id, (user as { pairingId?: string | null }).pairingId ?? null);
    return cals.map((c) => ({
      id: encodeCalendarId(c.id),
      name: c.name,
      description: undefined,
      primary: c.labels.includes('primary'),
      accessRole: c.ownerUserId === user.id ? 'owner' : c.privacy === 'SHARED_EDITOR' ? 'writer' : 'reader',
      backgroundColor: c.color,
      provider: PROVIDER_NAME,
    }));
  },

  async createEvent(user: UserConfig, calendarId: string, data: CreateEventInput): Promise<CreateEventResult> {
    const cuid = decodeCalendarId(calendarId);
    if (!cuid) {
      // Defensive: native provider received a non-native calendarId. PR 4
      // dispatching should prevent this, but bail cleanly.
      return { success: false, error: 'NOT_FOUND', errorMessage: `Not a native calendar id: ${calendarId}` };
    }
    try {
      const tz = (user as { location?: string }).location || TIMEZONE;
      const event = await createNativeEvent({
        calendarCuid: cuid,
        creatorUserId: user.id,
        title: data.title,
        description: data.description,
        location: data.location,
        startsAt: data.startTime,
        endsAt: data.endTime,
        allDay: data.allDay ?? false,
        timeZone: tz,
        rrule: data.recurrence && data.recurrence.length > 0
          ? data.recurrence[0].replace(/^RRULE:/, '')
          : null,
      });
      return {
        success: true,
        eventId: encodeEventId(event.id),
      };
    } catch (err) {
      return toErrorResult<CreateEventResult>(err);
    }
  },

  async updateEvent(
    user: UserConfig,
    calendarId: string,
    eventId: string,
    data: UpdateEventInput
  ): Promise<UpdateEventResult> {
    if (!isNativeCalendarId(calendarId)) {
      return { success: false, error: 'NOT_FOUND', errorMessage: `Not a native calendar id: ${calendarId}` };
    }
    try {
      const { seriesCuid, instanceStartsAt } = decodeEventId(eventId);
      const occ = data.instanceStartsAt ?? instanceStartsAt;
      const result = await updateNativeEvent({
        seriesCuid,
        instanceStartsAt: occ,
        scope: mapScope(data.scope),
        actingUserId: user.id,
        title: data.title,
        description: data.description,
        location: data.location,
        startsAt: data.startTime,
        endsAt: data.endTime,
        allDay: data.allDay,
      });
      return { success: true, eventId: result.canonicalEventId };
    } catch (err) {
      return toErrorResult<UpdateEventResult>(err);
    }
  },

  async deleteEvent(
    user: UserConfig,
    calendarId: string,
    eventId: string,
    options?: DeleteEventOptions
  ): Promise<DeleteEventResult> {
    if (!isNativeCalendarId(calendarId)) {
      return { success: false, error: 'NOT_FOUND', errorMessage: `Not a native calendar id: ${calendarId}` };
    }
    try {
      const { seriesCuid, instanceStartsAt } = decodeEventId(eventId);
      const occ = options?.instanceStartsAt ?? instanceStartsAt;
      await deleteNativeEvent({
        seriesCuid,
        instanceStartsAt: occ,
        scope: mapScope(options?.scope),
        actingUserId: user.id,
      });
      return { success: true };
    } catch (err) {
      return toErrorResult<DeleteEventResult>(err);
    }
  },
};

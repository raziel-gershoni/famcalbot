// In-bot native calendar provider — implements CalendarProvider against the
// NativeCalendar / NativeEvent / NativeEventInstance tables. It holds every `native:` calendar
// id (routing.ts providerForCalendar).

import type { NativeEvent } from '@prisma/client';
import { formatInTimeZone } from 'date-fns-tz';
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
  MoveEventResult,
} from './types';
import { ReminderInfo, UserConfig } from '../../types';
import {
  FetchRange,
  NativeEventRow,
  NativeFixedDaysError,
  NativePermissionDeniedError,
  NativeNotFoundError,
  NativeRuleError,
  ReminderStateRow,
  createNativeEvent,
  decodeCalendarId,
  decodeEventId,
  deleteNativeEvent,
  encodeCalendarId,
  encodeEventId,
  fetchEventsInCalendars,
  fetchReminderStates,
  fetchRemindersForUserInRange,
  isNativeCalendarId,
  listVisibleCalendars,
  refusesFixedDays,
  updateNativeEvent,
  type UpdateNativeEventInput,
  UpdateScope,
} from '../native-calendar/event-store';
import { loadViewerContext, recipientIdsForViewer, userDoneAt, viewerSnoozedUntil, ViewerContext, type ReminderSeriesColumns } from '../native-reminders/ownership';
import { TIMEZONE } from '../../config/constants';
import { addDaysToDate } from '../../utils/day-events';
import { captureError } from '../../lib/error-capture';
import { readZmanSpec } from '../../lib/calendar-view/zman-spec';
import { anniversaryOf } from '../../lib/hebrew-anniversary';

const PROVIDER_NAME = 'native' as const;

/**
 * Translate stored NativeCalendar + VirtualInstance into the UnifiedEvent shape
 * downstream code already knows how to render. Date strings mirror GCal's
 * format: `YYYY-MM-DD` for all-day, ISO8601 for timed.
 *
 * Given a REMINDER series, the event is a reminder: eventType 'reminder', and `info`,
 * the viewer's side of it. Without `info` it reads as the viewer's own.
 */
export function toUnifiedEvent(
  calendar: { id: string; name: string },
  instance: {
    title: string;
    description?: string;
    location?: string;
    startsAt: Date;
    endsAt: Date;
    allDay: boolean;
    timeZone: string;
    seriesEventId: string;
    instanceStartsAt: Date;
    isRecurringInstance: boolean;
  },
  series?: Pick<NativeEvent, 'kind'> & Partial<Pick<NativeEvent, 'hebrewRule' | 'hebrewAnchor' | 'ownAlerts' | 'alertMinutes'>>,
  info?: ReminderInfo
): UnifiedEvent {
  const isReminder = series?.kind === 'REMINDER';
  // All-day dates follow Google: the start date and an exclusive end date, both in the
  // event's own timezone (on the server's clock a UTC server would shift them a day).
  // The bot saves an all-day event as 00:00 to 23:59 local on its last day, and a
  // recurring one keeps that duration, so count whole days rather than reading the
  // end's date: a DST day is 23 or 25 hours long. A date-only reminder has no length
  // and still counts as its one day. A timed reminder ends where it starts.
  const start = instance.allDay
    ? formatInTimeZone(instance.startsAt, instance.timeZone, 'yyyy-MM-dd')
    : instance.startsAt.toISOString();
  const end = instance.allDay
    ? addDaysToDate(start, Math.max(1, Math.round((instance.endsAt.getTime() - instance.startsAt.getTime()) / 86_400_000)))
    : isReminder ? start : instance.endsAt.toISOString();

  // A Hebrew yearly series counts its years from the anchor (anniversary count spec); null hides it.
  const anniversary = series ? anniversaryOf(series, start, instance.timeZone) : null;

  return {
    summary: instance.title,
    start,
    end,
    description: instance.description,
    location: instance.location,
    calendarName: calendar.name,
    calendarId: encodeCalendarId(calendar.id),
    eventType: isReminder ? 'reminder' : undefined,
    recurringEventId: instance.isRecurringInstance ? instance.seriesEventId : undefined,
    eventId: encodeEventId(instance.seriesEventId, instance.isRecurringInstance ? instance.instanceStartsAt : undefined),
    reminders: undefined,
    // An event with an alert of its own (editor upgrades spec §2): the pass reads it before the user's default.
    ...(series?.ownAlerts ? { alertLeads: series.alertMinutes ?? [] } : {}),
    provider: PROVIDER_NAME,
    instanceStartsAt: instance.isRecurringInstance ? instance.instanceStartsAt.toISOString() : undefined,
    timeZone: instance.timeZone,
    ...(isReminder ? { reminder: info ?? { ownerIsViewer: true, creatorIsViewer: true } } : {}),
    ...(anniversary !== null ? { anniversary } : {}),
  };
}

/**
 * A reminder occurrence from the viewer's side: whose it is, who set it, and whether
 * it is done or snoozed. Names come from the pairing: a reminder the viewer can see
 * was set by the viewer or their partner, and is for one of the two.
 */
export function reminderInfoFor(
  series: ReminderSeriesColumns,
  state: Pick<ReminderStateRow, 'doneAt' | 'pings'> | undefined,
  ctx: ViewerContext,
  now: Date
): ReminderInfo {
  const recipients = recipientIdsForViewer(series, ctx);
  const ownerId = recipients[recipients.length - 1];
  const partnerName = (userId: number) => (ctx.partner?.id === userId ? ctx.partner.name : undefined);
  const snoozedUntil = viewerSnoozedUntil(series, state, ctx);
  // Each marks their own Done: only while the viewer still has a partner on it (an unlink leaves the creator's own Done to decide).
  const partnerId = series.eachMarksDone && recipients.includes(ctx.viewerId) ? recipients.find((id) => id !== ctx.viewerId) : undefined;
  const info: ReminderInfo = {
    // "Owner" is whoever it is for: the viewer is one of them (both partners, for a reminder for both).
    ownerIsViewer: recipients.includes(ctx.viewerId),
    creatorIsViewer: series.creatorUserId === ctx.viewerId,
    // Done for the viewer: the shared Done, or (each marks their own) their own.
    done: userDoneAt(series, state, ctx.viewerId) !== null,
    snoozed: !!snoozedUntil && snoozedUntil > now,
    ...(recipients.length > 1 ? { forBoth: true } : {}),
    eachMarksDone: partnerId !== undefined,
    partnerDone: partnerId !== undefined ? userDoneAt(series, state, partnerId) !== null : null,
    ...(partnerId !== undefined && partnerName(partnerId) ? { partnerName: partnerName(partnerId) } : {}),
  };
  // A reminder by zman: its rule rides along, and each reader works its time out for the viewer's place (reminderDueAt).
  const zmanSpec = readZmanSpec(series.zmanSpec);
  if (zmanSpec) info.zmanSpec = zmanSpec;
  const ownerName = info.ownerIsViewer ? undefined : partnerName(ownerId);
  const creatorName = info.creatorIsViewer ? undefined : partnerName(series.creatorUserId);
  if (ownerName) info.ownerName = ownerName;
  if (creatorName) info.creatorName = creatorName;
  return info;
}

/** The key a reminder occurrence's state is stored under: its series and original start. */
function occurrenceKey(seriesEventId: string, originalStartsAt: Date): string {
  return `${seriesEventId}|${originalStartsAt.getTime()}`;
}

/** The event id a row is listed under, as toUnifiedEvent encodes it. */
function rowEventId(instance: NativeEventRow['instance']): string {
  return encodeEventId(instance.seriesEventId, instance.isRecurringInstance ? instance.instanceStartsAt : undefined);
}

/**
 * Add the reminders fetched for the viewer to the calendar rows, skipping any already
 * there: a partner's reminder on a calendar the viewer can see comes back from both.
 */
function mergeRows(rows: NativeEventRow[], forViewer: NativeEventRow[]): NativeEventRow[] {
  const seen = new Set(rows.map((r) => rowEventId(r.instance)));
  const added = forViewer.filter((r) => !seen.has(rowEventId(r.instance)));
  if (added.length === 0) return rows;
  return [...rows, ...added].sort((a, b) => a.instance.startsAt.getTime() - b.instance.startsAt.getTime());
}

/**
 * One occurrence the viewer sees: its store row, the event the provider hands on for
 * it, and, for a reminder, the occurrence's state row when it has one (no row: pending).
 */
export interface ViewerItem {
  row: NativeEventRow;
  state?: ReminderStateRow;
  event: UnifiedEvent;
}

/** Store rows as the viewer's items. The reminders' states are read in one query. */
async function toViewerItems(rows: NativeEventRow[], ctx: ViewerContext): Promise<ViewerItem[]> {
  const reminderRows = rows.filter((r) => r.series.kind === 'REMINDER');
  if (reminderRows.length === 0) return rows.map((row) => ({ row, event: toUnifiedEvent(row.calendar, row.instance, row.series) }));

  const states = await fetchReminderStates(
    reminderRows.map((r) => ({ seriesEventId: r.series.id, originalStartsAt: r.instance.instanceStartsAt }))
  );
  const stateByKey = new Map(states.map((s) => [occurrenceKey(s.seriesEventId, s.originalStartsAt), s]));
  const now = new Date();
  return rows.map((row) => {
    if (row.series.kind !== 'REMINDER') return { row, event: toUnifiedEvent(row.calendar, row.instance, row.series) };
    const state = stateByKey.get(occurrenceKey(row.series.id, row.instance.instanceStartsAt));
    const event = toUnifiedEvent(row.calendar, row.instance, row.series, reminderInfoFor(row.series, state, ctx, now));
    return state ? { row, state, event } : { row, event };
  });
}

/**
 * The viewer's occurrences in a range: those on the given calendars, plus the reminders
 * their partner set for them, which they see on its day whatever the privacy of the
 * partner's calendar (spec §2). Each comes with its row and state row beside its event,
 * with the viewer context they were read under: the calendar reader
 * (src/services/calendar-read/famcal.ts) builds its items from them.
 */
export async function fetchViewerItems(
  user: UserConfig,
  cuids: string[],
  range: FetchRange
): Promise<{ ctx: ViewerContext; items: ViewerItem[] }> {
  const [ctx, rows] = await Promise.all([
    loadViewerContext({ id: user.id, pairingId: user.pairingId ?? null }),
    fetchEventsInCalendars(cuids, range),
  ]);
  const forViewer = ctx.partner ? await fetchRemindersForUserInRange(user.id, ctx.partner.id, range) : [];
  return { ctx, items: await toViewerItems(mergeRows(rows, forViewer), ctx) };
}

/** The viewer's events in a range: fetchViewerItems' events, in its order. */
async function fetchForViewer(user: UserConfig, cuids: string[], range: FetchRange): Promise<UnifiedEvent[]> {
  const { items } = await fetchViewerItems(user, cuids, range);
  return items.map((i) => i.event);
}

function filterCalendarCuids(calendarIds: string[]): string[] {
  const out: string[] = [];
  for (const id of calendarIds) {
    const cuid = decodeCalendarId(id);
    if (cuid) out.push(cuid);
  }
  return out;
}

// Map permission/parsing errors from event-store into provider error shape. A rule the
// store refused is UNKNOWN_ERROR to the bot, logged with the ids it was for (3b spec §3.1).
function toErrorResult<T extends { success: boolean; error?: string; errorMessage?: string }>(
  err: unknown,
  ids: { user_id: number; calendar_id: string; event_id?: string }
): T {
  if (err instanceof NativeRuleError) captureError(err, 'native-provider-rule', ids, 'warning');
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
  if (err instanceof NativeFixedDaysError) {
    return {
      success: false,
      error: 'FIXED_DAYS',
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

/** What the store is asked for an edit of the bot's: the times are those of the occurrence it was told about. */
function updateInput(user: UserConfig, eventId: string, data: UpdateEventInput): UpdateNativeEventInput {
  const { seriesCuid, instanceStartsAt } = decodeEventId(eventId);
  return {
    seriesCuid,
    instanceStartsAt: data.instanceStartsAt ?? instanceStartsAt,
    scope: mapScope(data.scope),
    actingUserId: user.id,
    // For 'all' the store moves the series by as much as that occurrence moved.
    occurrenceTimes: true,
    title: data.title,
    description: data.description,
    location: data.location,
    startsAt: data.startTime,
    endsAt: data.endTime,
    allDay: data.allDay,
  };
}

/**
 * Whether `updateEvent` would refuse this edit as a day move for a series on set days
 * (FIXED_DAYS), asked before the confirmation card. False for any other calendar.
 */
export async function wouldRefuseFixedDays(user: UserConfig, calendarId: string, eventId: string, data: UpdateEventInput): Promise<boolean> {
  // Per calendar: a Google id is answered from its master (3b spec §3.2 "Fixed days").
  if (!isNativeCalendarId(calendarId)) {
    const { wouldRefuseFixedDaysOnGoogle } = await import('./google-provider');
    return wouldRefuseFixedDaysOnGoogle(user, calendarId, eventId, data);
  }
  try {
    return await refusesFixedDays(updateInput(user, eventId, data));
  } catch (error) {
    // The early answer only: the confirmation's write asks the store again and answers then.
    captureError(error, 'native-fixed-days-check', { user_id: user.id, calendar_id: calendarId, event_id: eventId }, 'warning');
    return false;
  }
}

export const nativeProvider: CalendarProvider = {
  name: PROVIDER_NAME,

  async fetchEventsInRange(
    user: UserConfig,
    calendarIds: string[],
    startDate: Date,
    endDate: Date
  ): Promise<UnifiedEvent[]> {
    const cuids = filterCalendarCuids(calendarIds);
    if (cuids.length === 0) return [];
    return fetchForViewer(user, cuids, { from: startDate, to: endDate });
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
      // user.location is a city name (e.g. "Tel Aviv"), not an IANA tz —
      // resolveUserTimezone is the authoritative source.
      const { resolveUserTimezone } = await import('../../lib/timezone');
      const tz = (await resolveUserTimezone(user)) || TIMEZONE;
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
        // The pair travels with the rule (hebrew-repeats spec §2); the store checks the anchor
        ...(data.hebrewRule ? { hebrewRule: data.hebrewRule, hebrewAnchor: data.hebrewAnchor } : {}),
        kind: data.kind === 'reminder' ? 'REMINDER' : 'EVENT',
        forUserId: data.forUserId ?? null,
        forBoth: data.forBoth === true,
        eachMarksDone: data.eachMarksDone === true,
      });
      return {
        success: true,
        eventId: encodeEventId(event.id),
      };
    } catch (err) {
      return toErrorResult<CreateEventResult>(err, { user_id: user.id, calendar_id: calendarId });
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
      const result = await updateNativeEvent(updateInput(user, eventId, data));
      return {
        success: true,
        eventId: result.canonicalEventId,
        ...(result.clearedPings.length > 0 ? { clearedPings: result.clearedPings } : {}),
      };
    } catch (err) {
      return toErrorResult<UpdateEventResult>(err, { user_id: user.id, calendar_id: calendarId, event_id: eventId });
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
      return toErrorResult<DeleteEventResult>(err, { user_id: user.id, calendar_id: calendarId, event_id: eventId });
    }
  },

  // A FamCal event changes calendar through updateNativeEvent's calendarId (the home's
  // routes); nothing calls this for one.
  async moveEvent(): Promise<MoveEventResult> {
    return { success: false, error: 'UNKNOWN_ERROR', errorMessage: 'Built-in calendar events move through their edit, not moveEvent.' };
  },
};

// The FamCal half of the calendar reader (calendar home spec §2.4): the built-in
// calendar's occurrences in a window as ReadItems, with the legend the home may show.
//
// The events are the native provider's own (fetchViewerItems), so a summary on the
// reader reads exactly what it reads today (A-1, A-4). Only built-in calendar users are
// read: anyone else makes no query. Nothing here writes, so it never calls
// ensurePrimaryNativeCalendar, getMainNativeCalendar or hasUsableCalendar.
//
// What the home may say about an item's calendar is its CalendarRef, never the event.
// A reminder the partner set for the viewer can sit on the partner's PRIVATE calendar;
// its ref is masked to the partner's name with no id. event.calendarName keeps the real
// name for the summary prompt, as today (A-6); the DTO never reads it.

import type { NativeCalendar, NativeEvent } from '@prisma/client';
import type { UserConfig } from '../../types';
import type { UnifiedEvent } from '../calendar-provider/types';
import { fetchViewerItems, viewerSnoozedUntil } from '../calendar-provider/native-provider';
import { encodeCalendarId, listVisibleCalendars, type ReminderStateRow } from '../native-calendar/event-store';
import { loadViewerContext, type ViewerContext } from '../native-reminders/ownership';
import type { OpenReminderItem } from '../native-reminders/open-reminders';
import type { CalendarRef, FamcalRead, ReadItem } from './types';

type FamcalOk = Extract<FamcalRead, { status: 'ok' }>;
type Partner = { name: string } | null;

const partnerOf = (ctx: ViewerContext): Partner => (ctx.partner ? { name: ctx.partner.name } : null);

/** A legend calendar: the partner's carry the partner's name (Ruling R7). */
function legendRef(calendar: NativeCalendar, viewerId: number, partner: Partner): CalendarRef {
  const mine = calendar.ownerUserId === viewerId;
  return {
    id: encodeCalendarId(calendar.id),
    source: 'famcal',
    name: calendar.name,
    color: calendar.color,
    mine,
    ...(!mine && partner ? { ownerName: partner.name } : {}),
    inLegend: true,
    // getCalendarAccess: the owner, or the partner's calendar shared for editing.
    canWrite: mine || calendar.privacy === 'SHARED_EDITOR',
  };
}

/**
 * The ref of an occurrence on calendar `cuid`: its legend entry, or masked when the
 * calendar is not in the legend (the partner's PRIVATE calendar, for a reminder the
 * partner set for the viewer).
 */
function refFor(cuid: string, legend: ReadonlyMap<string, CalendarRef>, partner: Partner): CalendarRef {
  return legend.get(encodeCalendarId(cuid)) ?? { id: null, source: 'famcal', name: partner?.name ?? '', color: null, mine: false, inLegend: false };
}

/** The legend's refs by calendar id ('native:<cuid>'). */
function legendById(calendars: readonly CalendarRef[]): Map<string, CalendarRef> {
  const byId = new Map<string, CalendarRef>();
  for (const c of calendars) if (c.id) byId.set(c.id, c);
  return byId;
}

/**
 * One occurrence as a ReadItem. `event` is the provider's, untouched. A reminder always
 * has `state` (nulls when the occurrence has no state row); an event has none.
 */
function toReadItem(
  parts: {
    series: Pick<NativeEvent, 'id' | 'kind' | 'rrule' | 'hebrewRule' | 'hebrewAnchor' | 'creatorUserId' | 'forUserId' | 'forBoth'>;
    title: string;
    instanceStartsAt: Date;
    state?: Pick<ReminderStateRow, 'doneAt' | 'pings'>;
    event: UnifiedEvent;
  },
  calendar: CalendarRef,
  ctx: ViewerContext
): ReadItem {
  const kind = parts.series.kind === 'REMINDER' ? 'reminder' : 'event';
  return {
    source: 'famcal',
    key: `famcal|${parts.event.eventId ?? parts.series.id}`,
    event: parts.event,
    calendar,
    title: parts.title,
    kind,
    seriesId: parts.series.id,
    originalStart: parts.instanceStartsAt.toISOString(),
    recurring: parts.series.rrule != null,
    rrule: parts.series.rrule,
    hebrewRule: parts.series.hebrewRule,
    hebrewAnchor: parts.series.hebrewAnchor,
    ...(kind === 'reminder'
      ? { state: { doneAt: parts.state?.doneAt ?? null, snoozedUntil: viewerSnoozedUntil(parts.series, parts.state, ctx) } }
      : {}),
  };
}

/**
 * The built-in calendar's occurrences in [window.from, window.to), and the legend.
 *
 * - Legend: listVisibleCalendars, the viewer's own calendars of any privacy and the
 *   ACTIVE partner's shared ones, narrowed to `calendarIds` when given (the summaries
 *   pass the ids they resolved). Calendar ids never come from anywhere else.
 * - No legend calendar: no items, as the native provider gives for an empty calendar list.
 * - Items: fetchViewerItems over the legend, in the provider's order, so
 *   items.map(i => i.event) is what the provider returns for the same calendars.
 * - Any error: { status: 'error', cause } and no items. Nothing is logged here: the
 *   summary rethrows the cause, and the route reports the status.
 */
export async function readFamcal(
  user: UserConfig,
  window: { from: Date; to: Date },
  opts: { calendarIds?: readonly string[] }
): Promise<{ read: FamcalRead; items: ReadItem[] }> {
  try {
    const visible = await listVisibleCalendars(user.id, user.pairingId ?? null);
    const wanted = opts.calendarIds ? new Set(opts.calendarIds) : null;
    const legend = wanted ? visible.filter((c) => wanted.has(encodeCalendarId(c.id))) : visible;
    if (legend.length === 0) {
      const ctx = await loadViewerContext({ id: user.id, pairingId: user.pairingId ?? null });
      return { read: { status: 'ok', ctx, calendars: [], partner: partnerOf(ctx) }, items: [] };
    }
    const { ctx, items } = await fetchViewerItems(user, legend.map((c) => c.id), window);
    const partner = partnerOf(ctx);
    const calendars = legend.map((c) => legendRef(c, user.id, partner));
    const byId = legendById(calendars);
    return {
      read: { status: 'ok', ctx, calendars, partner },
      items: items.map(({ row, state, event }) =>
        toReadItem(
          { series: row.series, title: row.instance.title, instanceStartsAt: row.instance.instanceStartsAt, state, event },
          refFor(row.calendar.id, byId, partner),
          ctx
        )
      ),
    };
  } catch (cause) {
    return { read: { status: 'error', cause }, items: [] };
  }
}

/**
 * Carried-over reminders (fetchOpenReminderItems) as ReadItems, under the rows' legend
 * rule: named when the calendar is in `famcal`'s legend, else masked. Each one's
 * originalStart is its occurrence's original start. For the range route (spec §4 step 6).
 */
export function carryOverReadItems(famcal: FamcalOk, carryOvers: readonly OpenReminderItem[]): ReadItem[] {
  const byId = legendById(famcal.calendars);
  return carryOvers.map((c) =>
    toReadItem(
      { series: c.series, title: c.event.summary, instanceStartsAt: c.instanceStartsAt, state: c.state, event: c.event },
      refFor(c.calendar.id, byId, famcal.partner),
      famcal.ctx
    )
  );
}

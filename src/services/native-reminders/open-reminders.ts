// Reminders in the daily digests (spec §6.1-6.2, rulings R1 and R5).
//
// A reminder stays in the digests until someone marks it done. On the summary day a
// done occurrence leaves the list and one whose time has passed is marked open. Older
// undone ones are carried over as "open since <day>", only to the two people
// responsible for them (everyone it is for, and its creator), newest first, at most
// OPEN_REMINDERS_DIGEST_CAP of them. A repeating reminder carries only its latest
// occurrence before the cutoff, and nothing when it also occurs on the summary day:
// that occurrence speaks for it. Nor when that occurrence came before the series was
// armed (created or re-timed): it was never pinged, so it is not open.

import type { NativeEvent, NativeEventInstance } from '@prisma/client';
import type { CalendarEvent, ReminderInfo, UserConfig } from '../../types';
import { prisma } from '../../utils/prisma';
import { captureError } from '../../lib/error-capture';
import { localDate, nextDate, startOfLocalDay } from '../../utils/day-events';
import { isReminderEvent } from '../../utils/event-formatter';
import { expandSeries, latestOccurrenceBefore } from '../native-calendar/recurrence';
import { reminderInfoFor, toUnifiedEvent } from '../calendar-provider/native-provider';
import type { ReminderStateRow } from '../native-calendar/event-store';
import type { UnifiedEvent } from '../calendar-provider/types';
import { loadViewerContext, recipientIdsForViewer, type ViewerContext } from './ownership';
import { ARMED_GRACE_MS, reminderDueAt } from './due';

// reminderDueAt moved to the leaf due.ts (the calendar home's DTO code reads it); its
// callers keep importing it from here.
export { reminderDueAt };

export const OPEN_REMINDERS_DIGEST_CAP = 5;

/** Stands in for a reminder whose info is missing: the viewer's own. */
const OWN_REMINDER: ReminderInfo = { ownerIsViewer: true, creatorIsViewer: true };

/**
 * Where the carry-over ends: the start of the summary day, or now when that comes
 * first. The evening digest is for tomorrow, so what was due earlier today is open,
 * and what is still to come tonight is in neither list: it will ping.
 */
export function openRemindersCutoff(summaryDay: string, timezone: string, now: Date): Date {
  const dayStart = startOfLocalDay(summaryDay, timezone);
  return now < dayStart ? now : dayStart;
}

/**
 * The summary day's own reminders: a done occurrence leaves the list, and one whose
 * time has passed is marked open (a snoozed one too: it is not done). Everything
 * else passes through untouched.
 */
export function shapeDayReminders(events: CalendarEvent[], now: Date, timezone: string, reminderTime?: string | null): CalendarEvent[] {
  const shaped: CalendarEvent[] = [];
  for (const event of events) {
    if (!isReminderEvent(event)) {
      shaped.push(event);
      continue;
    }
    if (event.reminder?.done) continue;
    const open = reminderDueAt(event, timezone, reminderTime) < now;
    shaped.push(open ? { ...event, reminder: { ...(event.reminder ?? OWN_REMINDER), open: true } } : event);
  }
  return shaped;
}

/** What the carry-over reads of an occurrence's state row: done, and each recipient's snooze. */
export type OpenReminderState = Pick<ReminderStateRow, 'originalStartsAt' | 'doneAt' | 'pings'>;

/** A REMINDER series with what the carry-over reads: its calendar, overrides and state rows. */
export interface OpenReminderCandidate {
  series: NativeEvent;
  calendar: { id: string; name: string };
  overrides: NativeEventInstance[];
  states: OpenReminderState[];
}

/**
 * A carried-over reminder with what the home needs beside its event (calendar home
 * spec §4 step 6): its series, its calendar, the occurrence's original start and its
 * state row. The calendar carries its real name: never hand it to the client.
 */
export interface OpenReminderItem {
  /** Exactly the event fetchOpenReminders lists for it: eventType 'reminder', with openSince. */
  event: UnifiedEvent;
  series: NativeEvent;
  calendar: { id: string; name: string };
  /** The occurrence's original start, which its state row is keyed by; a one-off's own start. */
  instanceStartsAt: Date;
  /** The occurrence's state row, when it has one (a snoozed one). Never a done one: those are not carried. */
  state?: OpenReminderState;
}

/**
 * Which reminders a digest carries over, without the database. Each series offers its
 * latest occurrence before `cutoff`; it is carried when it is due before the cutoff,
 * not done, the viewer is someone it is for or its creator (R1), and, for a
 * repeating one, the series has no occurrence on the summary day and the occurrence is
 * not due before `armedAt - ARMED_GRACE_MS`. A one-off has no armed bound: someone set
 * that one item, so it stays a to-do until done, even when its time had already passed.
 * Newest first; the first `cap`, and how many more there are.
 */
export function selectOpenReminders(
  candidates: OpenReminderCandidate[],
  ctx: ViewerContext,
  cutoff: Date,
  summaryDay: string,
  timezone: string,
  now: Date,
  cap: number = OPEN_REMINDERS_DIGEST_CAP,
  reminderTime?: string | null
): { events: CalendarEvent[]; moreCount: number } {
  const { items, moreCount } = selectOpenReminderItems(candidates, ctx, cutoff, summaryDay, timezone, now, cap, reminderTime);
  return { events: items.map(i => i.event), moreCount };
}

/** selectOpenReminders with each carry-over's OpenReminderItem: the same rules, order and cap. */
function selectOpenReminderItems(
  candidates: OpenReminderCandidate[],
  ctx: ViewerContext,
  cutoff: Date,
  summaryDay: string,
  timezone: string,
  now: Date,
  cap: number,
  reminderTime?: string | null
): { items: OpenReminderItem[]; moreCount: number } {
  const summaryRange = { from: startOfLocalDay(summaryDay, timezone), to: startOfLocalDay(nextDate(summaryDay), timezone) };
  const open: Array<{ due: Date; item: OpenReminderItem }> = [];
  for (const { series, calendar, overrides, states } of candidates) {
    // R1: carried over only to everyone it is for and its creator
    if (!recipientIdsForViewer(series, ctx).includes(ctx.viewerId) && series.creatorUserId !== ctx.viewerId) continue;
    let occurrence: ReturnType<typeof latestOccurrenceBefore>;
    let onSummaryDay: boolean;
    try {
      occurrence = latestOccurrenceBefore(series, overrides, cutoff);
      onSummaryDay = !!series.rrule && expandSeries(series, summaryRange, overrides).length > 0;
    } catch (error) {
      // A stored rule that can't be read: report it by id and carry the rest (3b spec §3.1).
      captureError(error, 'native-reminders-open-series', { series_id: series.id });
      continue;
    }
    if (!occurrence) continue;
    if (onSummaryDay) continue;
    const event = toUnifiedEvent(calendar, occurrence);
    const due = reminderDueAt(event, timezone, reminderTime);
    if (due >= cutoff) continue; // a date-only one whose morning has not come yet
    // Never armed: due before the series was created or re-timed, so never pinged and
    // with no state. Showing it as open would be a phantom.
    if (series.rrule && series.armedAt && due.getTime() < series.armedAt.getTime() - ARMED_GRACE_MS) continue;
    const key = occurrence.instanceStartsAt.getTime();
    const state = states.find(s => s.originalStartsAt.getTime() === key);
    if (state?.doneAt) continue;
    const info = reminderInfoFor(series, state, ctx, now);
    info.openSince = localDate(due, timezone);
    open.push({
      due,
      item: {
        event: { ...event, eventType: 'reminder', reminder: info },
        series,
        calendar,
        instanceStartsAt: occurrence.instanceStartsAt,
        ...(state ? { state } : {}),
      },
    });
  }
  open.sort((a, b) => b.due.getTime() - a.due.getTime());
  return { items: open.slice(0, cap).map(o => o.item), moreCount: Math.max(0, open.length - cap) };
}

/**
 * The viewer's open reminders from before `cutoff` (see selectOpenReminders), in one
 * read: the REMINDER series they created, and those their ACTIVE partner made for
 * them, whatever the calendar's privacy, on calendars that still exist. The digest's
 * cap by default; pass Infinity for all of them.
 */
export async function fetchOpenReminders(
  user: UserConfig,
  ctx: ViewerContext,
  cutoff: Date,
  summaryDay: string,
  timezone: string,
  cap: number = OPEN_REMINDERS_DIGEST_CAP
): Promise<{ events: CalendarEvent[]; moreCount: number }> {
  const candidates = await loadOpenReminderCandidates(ctx, cutoff);
  return selectOpenReminders(candidates, ctx, cutoff, summaryDay, timezone, new Date(), cap, user.reminderTime);
}

/**
 * fetchOpenReminders' carry-overs as OpenReminderItems: the same read, rules, order and
 * cap, with each one's series, calendar, occurrence and state row. The calendar home's
 * range route passes Infinity.
 */
export async function fetchOpenReminderItems(
  user: UserConfig,
  ctx: ViewerContext,
  cutoff: Date,
  summaryDay: string,
  timezone: string,
  cap: number = OPEN_REMINDERS_DIGEST_CAP
): Promise<{ items: OpenReminderItem[]; moreCount: number }> {
  const candidates = await loadOpenReminderCandidates(ctx, cutoff);
  return selectOpenReminderItems(candidates, ctx, cutoff, summaryDay, timezone, new Date(), cap, user.reminderTime);
}

/** The one read behind fetchOpenReminders and fetchOpenReminderItems: each series with its calendar, overrides and state rows. */
async function loadOpenReminderCandidates(ctx: ViewerContext, cutoff: Date): Promise<OpenReminderCandidate[]> {
  const rows = await prisma.nativeEvent.findMany({
    where: {
      kind: 'REMINDER',
      isDeleted: false,
      calendar: { isDeleted: false },
      // Due before the cutoff: a one-off by its own time, a repeating one once it has
      // begun or when an occurrence was moved to before the cutoff (a first occurrence
      // moved earlier than the series start). In AND because the OR below is taken: it
      // says whose reminders these are.
      AND: [
        {
          OR: [
            { startsAt: { lt: cutoff } },
            { rrule: { not: null }, instances: { some: { status: 'OVERRIDE', startsAt: { lt: cutoff } } } },
          ],
        },
      ],
      OR: [
        { creatorUserId: ctx.viewerId },
        ...(ctx.partner ? [{ creatorUserId: ctx.partner.id, forUserId: ctx.viewerId }] : []),
      ],
    },
    include: { calendar: true, instances: true, states: { select: { originalStartsAt: true, doneAt: true, pings: { select: { userId: true, snoozedUntil: true } } } } },
  });
  return rows.map(row => ({ series: row, calendar: row.calendar, overrides: row.instances, states: row.states }));
}

/**
 * A digest's reminders, for summary.ts after shapeEventsForDay: done ones leave the
 * day, past-due ones are marked open, and the viewer's older open ones follow the
 * day's own, with a count of those past the cap. Only built-in calendar users have
 * reminders; anyone else's events come back as they were. A failed carry-over costs
 * the digest its open lines, never the digest.
 */
export async function addDigestReminders(
  user: UserConfig,
  dayEvents: CalendarEvent[],
  summaryDay: string,
  timezone: string,
  now: Date = new Date()
): Promise<{ events: CalendarEvent[]; moreCount: number }> {
  const events = shapeDayReminders(dayEvents, now, timezone, user.reminderTime);
  try {
    const ctx = await loadViewerContext(user);
    const open = await fetchOpenReminders(user, ctx, openRemindersCutoff(summaryDay, timezone, now), summaryDay, timezone);
    return { events: [...events, ...open.events], moreCount: open.moreCount };
  } catch (error) {
    captureError(error, 'native-reminders-open', { user_id: user.id }, 'warning');
    return { events, moreCount: 0 };
  }
}

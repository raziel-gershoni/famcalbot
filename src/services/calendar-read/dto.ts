// The calendar home's day buckets and DTOs (spec §4). Pure: no Prisma, no Redis and no
// clock of its own (`now` comes in), so the smokes run it without stubs.
//
// Day membership is daySpanOf's, the rule the summaries apply through
// shapeEventsForDay, so a day on the home and the same day's summary always list the
// same items. The DTO is built field by field from the ReadItem: nothing is spread, so
// event.calendarName and event.calendarId (the real name and id of a partner's private
// calendar behind a masked CalendarRef) never reach the JSON.

import type { DaySpan } from '../../types';
import { addDaysToDate, daySpanOf, localDate, nextDate } from '../../utils/day-events';
import { reminderDueAt } from '../native-reminders/due';
import {
  compareItems,
  type CalendarDTO,
  type DayKey,
  type ItemCalendarDTO,
  type ItemDTO,
  type ItemReminderDTO,
} from '../../lib/calendar-view/types';
import type { CalendarRef, ReadItem } from './types';

export interface ItemDtoOptions {
  now: Date;
  /** The caller decides: a past-due undone reminder on today's bucket, or a carry-over. */
  open: boolean;
  /** Carry-overs only; null elsewhere. */
  openSince: DayKey | null;
  /** A reminder's due instant for the viewer (reminderDueAt); the sheet reads its state against it. */
  dueAt?: Date;
}

function isDone(item: ReadItem): boolean {
  return (item.state?.doneAt ?? null) !== null || item.event.reminder?.done === true;
}

/** The item's calendar as the UI may show it. A calendar outside the legend never shows its id. */
function itemCalendar(ref: CalendarRef): ItemCalendarDTO {
  return {
    id: ref.inLegend ? ref.id : null,
    name: ref.name,
    color: ref.color,
    mine: ref.mine,
    ...(ref.ownerName ? { ownerName: ref.ownerName } : {}),
    inLegend: ref.inLegend,
  };
}

function reminderDto(item: ReadItem, opts: ItemDtoOptions): ItemReminderDTO {
  // A FamCal reminder always carries its info (toUnifiedEvent); without it, it reads
  // as the viewer's own, as the summaries do.
  const info = item.event.reminder;
  const doneAt = item.state?.doneAt ?? null;
  const snoozedUntil = item.state?.snoozedUntil ?? null;
  return {
    done: isDone(item),
    doneAt: doneAt ? doneAt.toISOString() : null,
    // A snooze that has run out is no longer one: the badge would show a past time.
    snoozedUntil: snoozedUntil && snoozedUntil > opts.now ? snoozedUntil.toISOString() : null,
    open: opts.open,
    openSince: opts.openSince,
    ...(opts.dueAt ? { dueAt: opts.dueAt.toISOString() } : {}),
    ownerIsViewer: info?.ownerIsViewer ?? true,
    creatorIsViewer: info?.creatorIsViewer ?? true,
    ...(info?.ownerName ? { ownerName: info.ownerName } : {}),
    ...(info?.creatorName ? { creatorName: info.creatorName } : {}),
  };
}

/** Whether a FamCal rule repeats every single day: FREQ=DAILY with no interval, or INTERVAL=1. */
export function repeatsEveryDay(rrule: string | null): boolean {
  if (!rrule || !/(^|;)FREQ=DAILY(;|$)/.test(rrule.replace(/^RRULE:/, ''))) return false;
  const interval = /(?:^|;)INTERVAL=(\d+)(?:;|$)/.exec(rrule);
  return !interval || Number(interval[1]) === 1;
}

/**
 * Whether the viewer may change the item, by what the read already holds, as the editor decides
 * (item-info.ts loadItem, google-item.ts): FamCal, a calendar the viewer may write or a reminder
 * they created; Google, a calendar they may write (its live role) and an event the home may change.
 */
function canEditItem(item: ReadItem): boolean {
  if (item.source === 'google') return item.calendar.canWrite === true && item.google?.editable === true;
  return item.calendar.canWrite === true || (item.kind === 'reminder' && item.event.reminder?.creatorIsViewer === true);
}

/** One item as one day lists it (span is that day's daySpanOf, null when inside the day), or as a carry-over. */
export function toItemDto(item: ReadItem, span: DaySpan | null, opts: ItemDtoOptions): ItemDTO {
  const { event } = item;
  const dto: ItemDTO = {
    key: item.key,
    source: item.source,
    readOnly: item.source === 'google',
    id: event.eventId ?? item.key,
    seriesId: item.seriesId,
    originalStart: item.originalStart,
    kind: item.kind,
    title: item.title,
    start: event.start,
    end: event.end,
    allDay: !event.start.includes('T'),
    tz: item.source === 'famcal' ? (event.timeZone ?? null) : null,
    recurring: item.recurring,
    repeatsDaily: item.kind === 'reminder' && /FREQ=DAILY/.test(item.rrule ?? ''),
    repeatsEveryDay: repeatsEveryDay(item.rrule),
    canEdit: canEditItem(item),
    span,
    calendar: itemCalendar(item.calendar),
    location: event.location || null,
    description: event.description || null,
  };
  if (item.kind === 'reminder') dto.reminder = reminderDto(item, opts);
  if (event.anniversary) dto.anniversary = event.anniversary;
  if (item.source === 'google') {
    dto.birthday = item.google?.birthday ?? false;
    dto.htmlLink = item.google?.htmlLink ?? null;
  }
  return dto;
}

/**
 * Whether a reminder listed on `day` shows as open: only on today, not done, and due
 * before now. A snoozed one is still open; past days are never open.
 */
export function isOpenOnDay(item: ReadItem, day: DayKey, today: DayKey, tz: string, now: Date, reminderTime?: string | null): boolean {
  if (day !== today || item.kind !== 'reminder' || isDone(item)) return false;
  return reminderDueAt(item.event, tz, reminderTime) < now;
}

/**
 * The days daySpanOf could accept for an event, [lo, hi), so it isn't asked about
 * every day of a 42-day window. All-day: its dates, with the end daySpanOf uses. Timed:
 * a day either side of its local start and end dates; daySpanOf still decides.
 */
function candidateDays(event: ReadItem['event'], tz: string): [DayKey, DayKey] {
  if (!event.start.includes('T')) {
    const end = event.end && !event.end.includes('T') && event.end > event.start ? event.end : nextDate(event.start);
    return [event.start, end];
  }
  const a = localDate(new Date(event.start), tz);
  const b = event.end ? localDate(new Date(event.end), tz) : a;
  return [addDaysToDate(a < b ? a : b, -1), addDaysToDate(a < b ? b : a, 2)];
}

function hasReadableStart(event: ReadItem['event']): boolean {
  if (!event.start) return false;
  if (!event.start.includes('T')) return /^\d{4}-\d{2}-\d{2}$/.test(event.start);
  return !Number.isNaN(Date.parse(event.start)) && (!event.end || !Number.isNaN(Date.parse(event.end)));
}

/**
 * Every day in [fromKey, toKey), empty ones included. Each item is listed on every day
 * daySpanOf puts it on, with that day's span, and each day is sorted with
 * compareItems. Reminders are marked open only on `today` (isOpenOnDay); done ones are
 * kept. An item without a readable start is dropped (readRange drops those already).
 */
export function toRangeDays(
  items: ReadItem[],
  fromKey: DayKey,
  toKey: DayKey,
  tz: string,
  now: Date,
  today: DayKey,
  reminderTime?: string | null
): { date: DayKey; items: ItemDTO[] }[] {
  const days: { date: DayKey; items: ItemDTO[] }[] = [];
  const byDate = new Map<DayKey, ItemDTO[]>();
  for (let d = fromKey; d < toKey; d = nextDate(d)) {
    const list: ItemDTO[] = [];
    days.push({ date: d, items: list });
    byDate.set(d, list);
  }
  for (const item of items) {
    if (!hasReadableStart(item.event)) continue;
    const [lo, hi] = candidateDays(item.event, tz);
    for (let d = lo < fromKey ? fromKey : lo; d < hi && d < toKey; d = nextDate(d)) {
      const span = daySpanOf(item.event, d, tz);
      if (span === null) continue;
      const list = byDate.get(d);
      if (!list) continue;
      list.push(toItemDto(item, span ?? null, { now, open: isOpenOnDay(item, d, today, tz, now, reminderTime), openSince: null, ...(item.kind === 'reminder' ? { dueAt: reminderDueAt(item.event, tz, reminderTime) } : {}) }));
    }
  }
  for (const day of days) day.items.sort(compareItems);
  return days;
}

/**
 * A carry-over (an older open reminder) as the "Still open" card gets it: always open,
 * snoozed ones too, with openSince, the day it fell due (selectOpenReminders sets it;
 * worked out the same way when missing). No span: it isn't listed on a day. The
 * caller builds the ReadItem with the occurrence's instanceStartsAt as originalStart
 * and a CalendarRef masked by the legend rule.
 */
export function toCarryOverDto(item: ReadItem, tz: string, now: Date, reminderTime?: string | null): ItemDTO {
  const openSince = item.event.reminder?.openSince ?? localDate(reminderDueAt(item.event, tz, reminderTime), tz);
  return toItemDto(item, null, { now, open: true, openSince, dueAt: reminderDueAt(item.event, tz, reminderTime) });
}

/**
 * A legend entry. Only legend refs come here (FamcalRead.calendars, GoogleRead.calendars);
 * a masked ref has no id and is never a legend entry, so it throws.
 */
export function toCalendarDto(ref: CalendarRef): CalendarDTO {
  if (ref.id === null) throw new Error('toCalendarDto: a masked calendar is not a legend entry');
  return {
    id: ref.id,
    source: ref.source,
    name: ref.name,
    color: ref.color,
    mine: ref.mine,
    ...(ref.ownerName ? { ownerName: ref.ownerName } : {}),
    ...(ref.unavailable ? { unavailable: true } : {}),
  };
}

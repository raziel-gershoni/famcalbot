/**
 * When the person is busy on the days a guest message asks about (spec 2026-11-07-ask-in-chat §5.2-5.4).
 *
 * One read through the summaries' reader (readLookaheadEvents, calendar-read/digest.ts) on the calendars the summary
 * reads (getCalendarAssignmentsForUser), with its failure rules: a Google gap keeps the FamCal half (googleGap), a
 * Google failure with no FamCal items throws GOOGLE_TOKEN_EXPIRED / GOOGLE_INSUFFICIENT_SCOPES / GOOGLE_FETCH_FAILED,
 * and a FamCal (database) error rethrows its cause. Busy is made of the reader's events, not the summary's shaping
 * (ruling 12): last night's tail counts.
 *
 * Every edge is an instant (epoch ms): a day's edges through startOfLocalDay (wallTimeToInstant), a window's through
 * wallTimeToInstant, the hour from a time by epoch arithmetic, and no Date local getter (CLAUDE.md's wall-time rule).
 */

import type { CalendarAssignment, CalendarEvent, UserConfig } from '../../types';
import type { DayKey } from '../calendar-read/types';
import type { DigestEvents, DigestRead, GoogleGap } from '../calendar-read/digest';
import { getCalendarsByLabel } from '../../utils/calendar-helpers';
import { nextDate, startOfLocalDay } from '../../utils/day-events';
import { isBirthdayEvent, isReminderEvent } from '../../utils/event-formatter';
import { wallTimeToInstant } from '../../utils/wall-time';
import type { AskRange, PartOfDay } from './window';

/** A busy stretch of one day, clipped to it. `start === end` is an instant (an event with no length). */
export interface Interval {
  start: number;
  end: number;
  /** The event (or a merged one) began before the day: shown as "until <end>". */
  startsBefore: boolean;
  /** It goes on after the day: shown as "from <start>". */
  endsAfter: boolean;
}

export interface BusyDay {
  day: DayKey;
  intervals: Interval[];
}

export interface BusyRead {
  days: BusyDay[];
  googleGap?: GoogleGap;
}

/** Google's public holiday calendars: never busy (ruling 12). */
const HOLIDAY_CALENDAR = /#holiday@group\.v\.calendar\.google\.com$/;

/** Ruling 10: a part of the day, from and until (24:00 is the next day's start). */
export const PART_HOURS: Record<PartOfDay, [string, string]> = {
  morning: ['06:00', '12:00'],
  afternoon: ['12:00', '17:00'],
  evening: ['17:00', '22:00'],
  night: ['22:00', '24:00'],
};

const HOUR_MS = 3_600_000;

/** The first instant of `day` and of the day after it, in `tz` (a day of 23 or 25 hours as it falls). */
export function dayEdges(day: DayKey, tz: string): { dayStart: number; dayEnd: number } {
  return { dayStart: startOfLocalDay(day, tz).getTime(), dayEnd: startOfLocalDay(nextDate(day), tz).getTime() };
}

/**
 * The busy intervals of `day` in `tz`, merged: every event of the read except reminders, Google birthdays, events on a
 * calendar labelled birthdays and on Google's holiday calendars. An all-day event covering the day makes the whole day
 * busy; a timed one is clipped to the day; one with no length is busy at that minute. Overlapping or touching
 * intervals merge.
 */
export function busyIntervals(events: readonly CalendarEvent[], day: DayKey, tz: string, assignments: readonly CalendarAssignment[]): Interval[] {
  const birthdayCalendars = new Set(getCalendarsByLabel([...assignments], 'birthdays'));
  const { dayStart, dayEnd } = dayEdges(day, tz);
  const found: Interval[] = [];
  for (const event of events) {
    if (!event.start) continue;
    if (isReminderEvent(event) || isBirthdayEvent(event)) continue;
    if (birthdayCalendars.has(event.calendarId) || HOLIDAY_CALENDAR.test(event.calendarId)) continue;
    if (!event.start.includes('T')) {
      // Google's end date is exclusive; a missing or non-advancing end means one day (as daySpanOf reads it).
      const end = event.end && !event.end.includes('T') && event.end > event.start ? event.end : nextDate(event.start);
      if (day < event.start || day >= end) continue;
      found.push({ start: dayStart, end: dayEnd, startsBefore: event.start < day, endsAfter: end > nextDate(day) });
      continue;
    }
    const start = Date.parse(event.start);
    const parsedEnd = Date.parse(event.end || event.start);
    if (Number.isNaN(start)) continue;
    const end = Number.isNaN(parsedEnd) || parsedEnd < start ? start : parsedEnd;
    if (end === start) {
      if (start >= dayStart && start < dayEnd) found.push({ start, end, startsBefore: false, endsAfter: false });
      continue;
    }
    if (end <= dayStart || start >= dayEnd) continue;
    found.push({ start: Math.max(start, dayStart), end: Math.min(end, dayEnd), startsBefore: start < dayStart, endsAfter: end > dayEnd });
  }
  found.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Interval[] = [];
  for (const next of found) {
    const last = merged[merged.length - 1];
    if (last && next.start <= last.end) {
      if (next.end > last.end) {
        last.end = next.end;
        last.endsAfter = next.endsAfter;
      } else if (next.end === last.end) {
        last.endsAfter = last.endsAfter || next.endsAfter;
      }
      last.startsBefore = last.startsBefore || (next.start === last.start && next.startsBefore);
      continue;
    }
    merged.push({ ...next });
  }
  return merged;
}

/** The window a range asks about on `day`, as [start, end) instants. */
export function windowOf(range: AskRange, day: DayKey, tz: string): { start: number; end: number } {
  const { dayStart, dayEnd } = dayEdges(day, tz);
  const at = (hhmm: string) => (hhmm === '24:00' ? dayEnd : wallTimeToInstant(`${day}T${hhmm}`, tz).getTime());
  let start: number;
  let end: number;
  switch (range.kind) {
    case 'day':
      return { start: dayStart, end: dayEnd };
    case 'part':
      [start, end] = PART_HOURS[range.part].map(at) as [number, number];
      break;
    case 'at':
      start = at(range.time);
      end = Math.min(start + HOUR_MS, dayEnd);
      break;
    case 'between':
      start = at(range.from);
      end = at(range.to);
      break;
  }
  // A window the clocks squeezed to nothing (both ends in the skipped hour) still asks about its minute.
  return { start, end: Math.max(end, start + 60_000) };
}

export type Verdict = 'free' | 'busyAll' | 'busySome';

export interface Judged {
  verdict: Verdict;
  /** The merged intervals that touch the window, with their own day-clipped edges ("20:00: busy (19:00-21:00)"). */
  shown: Interval[];
}

/** The window against the day's intervals (spec §5.3). */
export function judgeWindow(range: AskRange, day: DayKey, intervals: readonly Interval[], tz: string): Judged {
  const w = windowOf(range, day, tz);
  const shown = intervals.filter(i => (i.start === i.end ? i.start >= w.start && i.start < w.end : i.start < w.end && i.end > w.start));
  if (shown.length === 0) return { verdict: 'free', shown: [] };
  const covered = shown.some(i => i.start <= w.start && i.end >= w.end);
  return { verdict: covered ? 'busyAll' : 'busySome', shown };
}

/** The reader the busy times come from; the smokes inject a fake. */
export interface BusyReader {
  readLookaheadEvents: (user: UserConfig, start: Date, end: Date, tz: string, ids: readonly string[], read: DigestRead) => Promise<DigestEvents>;
  DEFAULT_ON_DEMAND_READ: DigestRead;
}

export interface BusyDeps {
  reader?: BusyReader;
  assignmentsOf?: (user: UserConfig) => Promise<CalendarAssignment[]>;
}

/**
 * The busy intervals of each of `days` (consecutive, first to last) for `user` in `tz`: one read from the first day's
 * start to the last instant of the last day. Throws as the summaries' reader does (spec §5.4).
 */
export async function readBusyDays(user: UserConfig, days: readonly DayKey[], tz: string, deps: BusyDeps = {}): Promise<BusyRead> {
  const reader = deps.reader ?? (await import('../calendar-read/digest'));
  const assignmentsOf = deps.assignmentsOf ?? (await import('../calendar-provider')).getCalendarAssignmentsForUser;
  const assignments = await assignmentsOf(user);
  const ids = assignments.map(a => a.calendarId);
  const first = days[0];
  const last = days[days.length - 1];
  const start = startOfLocalDay(first, tz);
  const end = new Date(startOfLocalDay(nextDate(last), tz).getTime() - 1);
  const events = await reader.readLookaheadEvents(user, start, end, tz, ids, reader.DEFAULT_ON_DEMAND_READ);
  return {
    days: days.map(day => ({ day, intervals: busyIntervals(events, day, tz, assignments) })),
    ...(events.googleGap ? { googleGap: events.googleGap } : {}),
  };
}

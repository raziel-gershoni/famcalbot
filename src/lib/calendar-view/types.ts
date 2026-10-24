// The calendar home's wire format (spec §4): what GET /api/calendar/range answers and
// what the client keeps in its store. Client-safe: no imports, so the home's bundle
// never pulls in server code. The server builds these in
// src/services/calendar-read/dto.ts.

/** A calendar day, 'yyyy-MM-dd', in the viewer's timezone. */
export type DayKey = string;

/** Where an item comes from. */
export type SourceName = 'famcal' | 'google';

/** The first day of the week: 0 = Sunday … 6 = Saturday (as Date#getUTCDay). */
export type WeekStart = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/**
 * How an item sits on a day it is listed on when it crosses the day's edges (as
 * daySpanOf decides); null when it is wholly inside the day.
 */
export type ItemSpan = 'endsLater' | 'continues' | 'spansDay';

export type GoogleStatusReason = 'token' | 'scopes' | 'calendars_gone' | 'transient' | 'timeout' | 'config' | 'unknown';

export interface RangeResponse {
  tz: string;
  today: DayKey;
  weekStart: WeekStart;
  hebrewDates: boolean;
  from: DayKey;
  to: DayKey;
  sources: {
    famcal?: { status: 'ok' | 'pending' | 'error' };
    google?: {
      status: 'ok' | 'pending' | 'reconnect' | 'error';
      reason?: GoogleStatusReason;
      partial?: { failed: number; truncated: number };
      stale?: boolean;
    };
  };
  partner: { name: string } | null;
  /** The legend for the requested sources. */
  calendars: CalendarDTO[];
  /** Every day in [from, to), empty ones included, each sorted with compareItems. */
  days: { date: DayKey; items: ItemDTO[] }[];
  /** Newest first. */
  carryOvers?: ItemDTO[];
}

export interface CalendarDTO {
  id: string;
  source: SourceName;
  name: string;
  color: string | null;
  mine: boolean;
  ownerName?: string;
  unavailable?: boolean;
}

export interface ItemCalendarDTO {
  /** null when masked (a partner's private calendar). */
  id: string | null;
  name: string;
  color: string | null;
  mine: boolean;
  ownerName?: string;
  inLegend: boolean;
}

export interface ItemReminderDTO {
  done: boolean;
  doneAt: string | null;
  /** Set only while the snooze is still running. */
  snoozedUntil: string | null;
  /** Today's past-due undone reminders, and every carry-over. */
  open: boolean;
  /** 'yyyy-MM-dd'; carry-overs only. */
  openSince: string | null;
  /** When it is due for the viewer: an instant (a date-only one is at the viewer's reminder time on its date). */
  dueAt?: string;
  ownerIsViewer: boolean;
  creatorIsViewer: boolean;
  ownerName?: string;
  creatorName?: string;
}

export interface ItemDTO {
  key: string;
  source: SourceName;
  readOnly: boolean;
  id: string;
  seriesId: string | null;
  originalStart: string | null;
  kind: 'event' | 'reminder';
  title: string | null;
  /**
   * Timed: an instant (FamCal UTC ISO, Google RFC 3339 with the user's offset).
   * All-day: 'yyyy-MM-dd', with an exclusive end.
   */
  start: string;
  end: string;
  allDay: boolean;
  /** The event's own timezone (FamCal only). */
  tz: string | null;
  recurring: boolean;
  repeatsDaily: boolean;
  span: ItemSpan | null;
  calendar: ItemCalendarDTO;
  location: string | null;
  /** Plain text. */
  description: string | null;
  reminder?: ItemReminderDTO;
  /** A Hebrew yearly series: the Hebrew years since the original date (>= 1); absent on the first occurrence and elsewhere. */
  anniversary?: number;
  /** Google only. */
  birthday?: boolean;
  /** Google only. */
  htmlLink?: string | null;
}

/** An instant to sort by; an all-day 'yyyy-MM-dd' reads as UTC midnight, which keeps date order. */
function sortInstant(value: string, fallback: number): number {
  const t = Date.parse(value);
  return Number.isNaN(t) ? fallback : t;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The order of a day's items, the same on the server and the client: all-day first,
 * then start instant, then end, FamCal before Google, then title. The key breaks the
 * last ties, so the order is total and two sorts of the same items always agree.
 * Strings compare by code unit, never by locale.
 */
export function compareItems(a: ItemDTO, b: ItemDTO): number {
  if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
  const aStart = sortInstant(a.start, 0);
  const bStart = sortInstant(b.start, 0);
  if (aStart !== bStart) return aStart - bStart;
  const aEnd = sortInstant(a.end, aStart);
  const bEnd = sortInstant(b.end, bStart);
  if (aEnd !== bEnd) return aEnd - bEnd;
  if (a.source !== b.source) return a.source === 'famcal' ? -1 : 1;
  const byTitle = compareStrings(a.title ?? '', b.title ?? '');
  if (byTitle !== 0) return byTitle;
  return compareStrings(a.key, b.key);
}

/** What kind of holiday it is, highest priority first (the server ranks a day's holidays by it). */
export type HolidayKind = 'chag' | 'fast' | 'erev' | 'cholHamoed' | 'minor' | 'modern' | 'roshChodesh';

/**
 * A Hebrew holiday of a day, as GET /api/calendar/holidays answers (src/services/hebrew-holidays.ts
 * builds it; this is the client's copy, so the home never imports the server module). `title` is
 * the full name, `brief` the short one for the Month's cells, `chag` a yom tov.
 */
export interface Holiday {
  title: string;
  brief: string;
  chag: boolean;
  kind: HolidayKind;
}

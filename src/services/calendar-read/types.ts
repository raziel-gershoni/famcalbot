// The shared reader's server types (spec §2.2). One read covers the calendar home and the
// summaries. Types only.

import type { UnifiedEvent } from '../calendar-provider/types';
import type { ViewerContext } from '../native-reminders/ownership';
import type { SourceName } from '../../lib/calendar-view/types';

export type { DayKey, SourceName } from '../../lib/calendar-view/types';

/** What the UI may show about an item's calendar. */
export interface CalendarRef {
  /** 'native:<cuid>' or the Google id; null when masked. */
  id: string | null;
  source: SourceName;
  name: string;
  color: string | null;
  mine: boolean;
  /** The partner, or a spouse-labelled Google calendar's person. */
  ownerName?: string;
  inLegend: boolean;
  /** A chosen Google calendar that is gone. */
  unavailable?: boolean;
}

export interface ReadItem {
  source: SourceName;
  /** 'famcal|<eventId>' or 'google|<calendarId>|<id>'. */
  key: string;
  /** Exactly what the summaries consume today. */
  event: UnifiedEvent;
  /** For the DTO; the summaries never read it. */
  calendar: CalendarRef;
  /** The raw title; event.summary keeps 'No title'. */
  title: string | null;
  kind: 'event' | 'reminder';
  seriesId: string | null;
  /** FamCal instanceStartsAt (one-offs too) or Google originalStartTime. */
  originalStart: string | null;
  recurring: boolean;
  /** The FamCal series rrule; null for Google. */
  rrule: string | null;
  state?: { doneAt: Date | null; snoozedUntil: Date | null };
  google?: { birthday: boolean; htmlLink: string | null };
}

export interface ReadRangeOptions {
  /** The caller's resolveUserTimezone. */
  tz: string;
  /** Intersected with sourcesFor(user); absent = every applicable source. */
  sources?: readonly SourceName[];
  /** Summary callers only: the ids they already resolved. */
  calendarIds?: readonly string[];
  /** Clip the start to an instant (This week starts now). */
  notBefore?: Date;
  /** Default 'bypass'; only the route uses the cache. */
  googleCache?: 'use' | 'refresh' | 'bypass';
  /** Covers the whole Google half (spec §2.2 Deadlines). */
  deadlineMs: number;
  /** Runs the stale-entry refresh (spec §2.6); the route passes after(). */
  defer?: (task: () => Promise<void>) => void;
}

export type FamcalRead =
  | { status: 'ok'; ctx: ViewerContext; calendars: CalendarRef[]; partner: { name: string } | null }
  | { status: 'error'; cause: unknown };

export type GoogleRead =
  | {
      status: 'ok';
      calendars: CalendarRef[];
      goneIds: string[];
      partial: { failed: number; truncated: number } | null;
      stale: boolean;
    }
  | { status: 'reconnect'; reason: 'token' | 'scopes' }
  | { status: 'error'; reason: 'transient' | 'config' | 'timeout' | 'calendars_gone' | 'unknown'; cause?: unknown };

export interface RangeRead {
  window: { from: Date; to: Date };
  /** FamCal then Google, each in today's order; not bucketed into days. */
  items: ReadItem[];
  /** Absent when it doesn't apply or wasn't requested. */
  famcal?: FamcalRead;
  google?: GoogleRead;
}

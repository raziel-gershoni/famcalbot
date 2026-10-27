// Calendar provider abstraction — single seam for Google Calendar (legacy) and the
// in-bot Native calendar (PR 3+). Existing CalendarEvent fields are preserved so
// downstream code (reminders, summaries, voice confirmations, miniapp) needs no
// type-level changes; an extra `provider` discriminator is added for native
// recurrence handling.

import { CalendarEvent, UserConfig } from '../../types';
import type { ClearedPing } from '../native-calendar/event-store';
import type { HebrewRule } from '../native-calendar/recurrence';

export type CalendarProviderName = 'google' | 'native';

export type RecurrenceScope = 'single' | 'all' | 'following';

// CalendarEvent + provider tag + (for native) the original instance start so callers
// editing a recurring instance know which occurrence they're touching.
export interface UnifiedEvent extends CalendarEvent {
  provider: CalendarProviderName;
  instanceStartsAt?: string; // ISO; only set for native recurring instances
  // Native only: the event's own IANA timezone, the one its all-day dates are read in.
  timeZone?: string;
}

// Subset of GCal CalendarInfo + provider tag. Surfaces in select-calendars and
// the future native-calendars miniapp page through the same shape.
export interface UnifiedCalendar {
  id: string;
  name: string;
  description?: string;
  primary: boolean;
  accessRole: string; // 'owner' | 'reader' | 'writer'
  backgroundColor: string;
  provider: CalendarProviderName;
}

// An all-day event's startTime and endTime are 00:00 on its first day and a time on its
// last (23:59 as the bot creates one), in the user's timezone, for both providers: the
// native calendar stores them, the Google provider turns them into Google's dates.
export interface CreateEventInput {
  title: string;
  startTime: Date;
  endTime: Date;
  description?: string;
  location?: string;
  allDay?: boolean;
  recurrence?: string[]; // RFC-5545 RRULE strings
  // Native only (hebrew-repeats spec §2): the recurrence is then a plain FREQ=YEARLY and the
  // series repeats on the Hebrew date of its anchor, the start's day in the user's zone. Only the
  // bot's recurrenceFields sets them; the Google provider refuses a create that carries them.
  hebrewRule?: HebrewRule;
  hebrewAnchor?: string;
  // Native only; the Google provider ignores both. A reminder has no length
  // (startTime === endTime), and forUserId is the partner it is for (null: the creator).
  kind?: 'event' | 'reminder';
  forUserId?: number | null;
  /** With forUserId = the partner: the reminder is for both of them. */
  forBoth?: boolean;
  /** With forBoth: each of them marks their own Done. Only the editor sets it; the bot's create leaves it off. */
  eachMarksDone?: boolean;
}

export interface UpdateEventInput {
  title?: string;
  startTime?: Date;
  endTime?: Date;
  description?: string;
  location?: string;
  allDay?: boolean;
  scope?: RecurrenceScope;
  recurringEventId?: string;
  // Native only — identifies which occurrence to override on scope=single.
  // GCal ignores this and uses the instance eventId.
  instanceStartsAt?: Date;
  // Google only (3b spec §3.2). The new rule from the opened occurrence on ('RRULE:…'), or
  // null to stop repeating; omitted keeps it. A rule change on a series always works from
  // the occurrence (eventId), whatever the scope.
  rrule?: string | null;
  // Google only: the new rule's end (or none) is the caller's, so the old rule's end is not carried (richer repeats ruling 5).
  endGiven?: boolean;
  // Google only: the new rule was built on the new part's start (the Repeat sheet), so a day move is not a move off a fixed day.
  rebuilt?: boolean;
  // Google only: a 'following' edit puts the new part on this calendar.
  toCalendarId?: string;
}

export interface DeleteEventOptions {
  scope?: RecurrenceScope;
  recurringEventId?: string;
  instanceStartsAt?: Date;
}

export type ProviderErrorCode =
  | 'PERMISSION_DENIED'
  | 'TOKEN_EXPIRED'
  | 'NOT_FOUND'
  | 'NOT_CONNECTED' // a Google calendar with no Google token
  | 'FIXED_DAYS' // a day move for more than one occurrence of a series with fixed days (BYDAY), both providers
  | 'FORBIDDEN' // Google refused this write: a read-only calendar, an event the user doesn't organize (no grant fixes it)
  | 'UNKNOWN_ERROR'; // with retryable when it was transient (a rate limit, a 5xx, a timeout)

export interface CreateEventResult {
  success: boolean;
  eventId?: string;
  eventLink?: string;
  /** Google: a series' first occurrence (the home's key names an occurrence). */
  instanceId?: string;
  error?: ProviderErrorCode;
  errorMessage?: string;
  /** A transient failure (rate limit, 5xx, timeout): trying again may work. */
  retryable?: boolean;
}

export interface UpdateEventResult {
  success: boolean;
  eventId?: string;
  eventLink?: string;
  /** Google: where the opened occurrence is after the write (its instance id, or a one-off's id). */
  instanceId?: string;
  /** Google: the calendar it is on after the write (a 'following' tail can go elsewhere). */
  calendarId?: string;
  error?: ProviderErrorCode;
  errorMessage?: string;
  /** A transient failure (rate limit, 5xx, timeout): trying again may work. */
  retryable?: boolean;
  // Native only: the live pings of a reminder whose time changed, now without state
  // (re-armed), so the caller can strip their buttons. Absent when there are none.
  clearedPings?: ClearedPing[];
}

export interface DeleteEventResult {
  success: boolean;
  error?: ProviderErrorCode;
  errorMessage?: string;
  /** A transient failure (rate limit, 5xx, timeout): trying again may work. */
  retryable?: boolean;
}

/** Moving an event (a whole series: its master) to another calendar of the same provider. */
export interface MoveEventInput {
  eventId: string;
  fromCalendarId: string;
  toCalendarId: string;
}

export type MoveEventResult = DeleteEventResult & { eventId?: string };

export interface CalendarProvider {
  readonly name: CalendarProviderName;

  fetchEventsInRange(user: UserConfig, calendarIds: string[], startDate: Date, endDate: Date): Promise<UnifiedEvent[]>;

  listCalendars(user: UserConfig): Promise<UnifiedCalendar[]>;

  createEvent(user: UserConfig, calendarId: string, data: CreateEventInput): Promise<CreateEventResult>;
  updateEvent(user: UserConfig, calendarId: string, eventId: string, data: UpdateEventInput): Promise<UpdateEventResult>;
  deleteEvent(user: UserConfig, calendarId: string, eventId: string, options?: DeleteEventOptions): Promise<DeleteEventResult>;
  /** Google's events.move; FamCal moves through updateNativeEvent's calendarId instead. */
  moveEvent(user: UserConfig, move: MoveEventInput): Promise<MoveEventResult>;
}

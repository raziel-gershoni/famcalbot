// Calendar provider abstraction — single seam for Google Calendar (legacy) and the
// in-bot Native calendar (PR 3+). Existing CalendarEvent fields are preserved so
// downstream code (reminders, summaries, voice confirmations, miniapp) needs no
// type-level changes; an extra `provider` discriminator is added for native
// recurrence handling.

import { CalendarEvent, UserConfig } from '../../types';

export type CalendarProviderName = 'google' | 'native';

export type RecurrenceScope = 'single' | 'all' | 'following';

// CalendarEvent + provider tag + (for native) the original instance start so callers
// editing a recurring instance know which occurrence they're touching.
export interface UnifiedEvent extends CalendarEvent {
  provider: CalendarProviderName;
  instanceStartsAt?: string; // ISO; only set for native recurring instances
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

export interface CreateEventInput {
  title: string;
  startTime: Date;
  endTime: Date;
  description?: string;
  location?: string;
  allDay?: boolean;
  recurrence?: string[]; // RFC-5545 RRULE strings
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
  | 'NOT_CONNECTED' // user.calendarSource mismatch / missing credentials
  | 'UNKNOWN_ERROR';

export interface CreateEventResult {
  success: boolean;
  eventId?: string;
  eventLink?: string;
  error?: ProviderErrorCode;
  errorMessage?: string;
}

export interface UpdateEventResult {
  success: boolean;
  eventId?: string;
  eventLink?: string;
  error?: ProviderErrorCode;
  errorMessage?: string;
}

export interface DeleteEventResult {
  success: boolean;
  error?: ProviderErrorCode;
  errorMessage?: string;
}

export interface CalendarProvider {
  readonly name: CalendarProviderName;

  fetchTodayEvents(user: UserConfig, calendarIds: string[], timezone?: string): Promise<UnifiedEvent[]>;
  fetchTomorrowEvents(user: UserConfig, calendarIds: string[], timezone?: string): Promise<UnifiedEvent[]>;
  fetchEventsInRange(user: UserConfig, calendarIds: string[], startDate: Date, endDate: Date): Promise<UnifiedEvent[]>;

  listCalendars(user: UserConfig): Promise<UnifiedCalendar[]>;

  createEvent(user: UserConfig, calendarId: string, data: CreateEventInput): Promise<CreateEventResult>;
  updateEvent(user: UserConfig, calendarId: string, eventId: string, data: UpdateEventInput): Promise<UpdateEventResult>;
  deleteEvent(user: UserConfig, calendarId: string, eventId: string, options?: DeleteEventOptions): Promise<DeleteEventResult>;
}

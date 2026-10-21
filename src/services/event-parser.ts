/**
 * Event Parser Types
 * Type definitions for voice intent parsing and calendar event data
 */

/**
 * Voice intent types
 */
export type VoiceIntent = 'create' | 'edit' | 'delete';

/**
 * Reference to an existing event for edit/delete operations
 */
export interface EventReference {
  type: 'last_created' | 'by_description';
  description?: string;  // "dentist appointment", "meeting with David"
  timeHint?: string;     // "tomorrow", "next week" - raw text for date range
  originalTime?: string; // "15:00" - the start time of the event being referenced (for disambiguation)
  originalDate?: string; // "YYYY-MM-DD" - explicit date if mentioned (more specific than timeHint)
}

/**
 * Requested changes for an edit operation
 */
export interface EditRequest {
  newTitle?: string;
  newStartDate?: string;  // YYYY-MM-DD
  newStartTime?: string;  // HH:MM
  newEndDate?: string;    // YYYY-MM-DD
  newEndTime?: string;    // HH:MM
  newLocation?: string;
  newAllDay?: boolean;
}

/**
 * Scope for recurring event modifications
 */
export type RecurrenceScope = 'single' | 'all' | 'following';

/**
 * Result of parsing voice intent
 */
export interface VoiceIntentResult {
  intent: VoiceIntent;
  event?: ParsedEvent;           // For CREATE intent
  editRequest?: EditRequest;     // For EDIT intent
  eventReference?: EventReference;  // For EDIT/DELETE intent
  scope?: RecurrenceScope;       // For EDIT/DELETE: single instance, all, or this+following
  confidence: 'high' | 'medium' | 'low';
  error?: string;
  needsClarification?: boolean;
  clarificationQuestion?: string;
  // A voice parse kept although the speech seemed not meant for the device (TV, radio):
  // it is never auto-created, so the user always confirms it on the card.
  notAddressed?: true;
}

/**
 * Recurrence pattern for repeating events
 */
export interface RecurrencePattern {
  frequency: 'daily' | 'weekly' | 'monthly' | 'yearly';
  daysOfWeek?: string[];  // ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']
  interval?: number;       // every N weeks/months (default 1)
  until?: string;          // YYYY-MM-DD end date
  count?: number;          // number of occurrences
  /**
   * 'hebrew': repeat every year on the start's Hebrew date, by hebcal's birthday rule, the one
   * Hebrew repeat (hebrew-repeats spec §5). Only with frequency 'yearly'; the parser drops it
   * otherwise. Unset: the Gregorian rule, as always.
   */
  calendar?: 'hebrew';
}

/**
 * Parsed event data from natural language
 */
export interface ParsedEvent {
  title: string;
  startTime: Date;
  endTime: Date;
  location?: string;
  description?: string;
  allDay: boolean;
  calendarId?: string;
  calendarName?: string;
  confidence: 'high' | 'medium' | 'low';
  ambiguities?: string[];
  recurrence?: RecurrencePattern;
  // A reminder once resolved for creation (src/services/native-reminders/resolve.ts).
  // The pending card keeps them, so its confirm creates exactly what the card showed.
  forUserId?: number | null; // the partner it is for; null = the creator
  forName?: string; // that partner's name, for the card and the reply
  reminderNotice?: 'partner_not_on_telegram' | 'time_passed' | 'no_time_set';
  /** 'reminder' for a reminder: one moment, so endTime equals startTime. Unset on an event. */
  kind?: 'event' | 'reminder';
  /** Reminders only: who it is for, as a role. Resolution maps 'partner' to the user's partner. */
  forPerson?: 'self' | 'partner';
  /**
   * Reminders only, for "an hour before the dentist": the words naming that event and the
   * minutes from its start (negative is before). startTime and endTime are Invalid Dates
   * until resolution finds the event.
   */
  anchor?: { description: string; offsetMinutes: number };
}

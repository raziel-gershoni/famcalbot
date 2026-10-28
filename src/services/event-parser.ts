/**
 * Event Parser Types
 * Type definitions for voice intent parsing and calendar event data
 */

import type { ModelZman } from './zmanim/spec';
import type { ZmanSpecValue } from '../lib/calendar-view/zman-spec';

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
  /**
   * A reminder by zman the parser refused (with `error`, and no event): why, so the person is asked one line about it
   * instead of being told it was not understood. Logged by the parser as [zman-voice].
   */
  zmanParseError?: ZmanParseError;
}

/** Why the parser refused a reminder by zman: its zman was not a readable shape, came with an anchor or a clock time, or was on an event. */
export type ZmanParseError = 'unreadable' | 'with_anchor' | 'with_clock_time' | 'not_a_reminder';

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
  forUserId?: number | null; // the partner it is for (with forBoth, the partner it is also for); null = the creator
  forBoth?: boolean; // for the creator and that partner
  forName?: string; // that partner's name, for the card and the reply
  reminderNotice?: 'partner_not_on_telegram' | 'time_passed' | 'no_time_set';
  /** 'reminder' for a reminder: one moment, so endTime equals startTime. Unset on an event. */
  kind?: 'event' | 'reminder';
  /** Reminders only: who it is for, as a role. Resolution maps 'partner' to the user's partner. */
  forPerson?: 'self' | 'partner' | 'both';
  /**
   * Reminders only, for "an hour before the dentist": the words naming that event and the
   * minutes from its start (negative is before). startTime and endTime are Invalid Dates
   * until resolution finds the event.
   */
  anchor?: { description: string; offsetMinutes: number };
  /**
   * Reminders only, for "10 minutes before sof zman Shema": what the model said about the zman, read but not yet
   * mapped to a rule (readZmanFromModel does that, under the person's community). A reminder with one is date-only
   * and has no clock time.
   */
  zman?: ModelZman;
  /**
   * Reminders by zman only: the person said the day (or a Hebrew date), so resolution keeps it. Unset, resolution
   * picks the next day whose zman time has not passed (today, else tomorrow), per opinion when there are choices.
   */
  zmanDaySaid?: true;
  /**
   * Reminders only, once resolved (resolve.ts): the rule it is created with, mapped from `zman` under the writer's
   * community. The reminder is date-only; its time is never stored, every reader counts it at its recipient's place.
   */
  zmanSpec?: ZmanSpecValue;
  /**
   * Reminders only, once resolved: the name has several opinions in the writer's set and none was said, so nothing
   * is defaulted: the card offers one button per choice, in the set's order, and a tap makes it `zmanSpec`
   * (withZmanChoice). Each has its own day (yyyy-MM-dd, the creator's zone; plain JSON, so it survives Redis) and its
   * own pause note. Never together with `zmanSpec`.
   */
  zmanChoices?: ZmanChoice[];
  /**
   * Reminders by zman, one-off only: its time falls inside a Shabbat or Yom Tov window while its recipient's pause is
   * on (isPaused), so it will not be sent. `true`: to every person it pings. `'one'`: for a reminder to both, only to
   * one of the two (each person is asked at their own place). The card says so in one line.
   */
  reminderPaused?: ZmanPause;
}

/** What the pause says of a one-off by zman: held for everyone it pings (true), or, for a reminder to both, for one of the two. */
export type ZmanPause = true | 'one';

/** One opinion a reminder by zman can be created with (ParsedEvent.zmanChoices). */
export interface ZmanChoice {
  spec: ZmanSpecValue;
  /** The civil day (yyyy-MM-dd, the creator's zone) this choice is created on: its own next time, or the said day. */
  day: string;
  /** This choice's time falls inside the recipient's paused Shabbat or Yom Tov (a one-off only); 'one': for one of the two of a reminder to both. */
  paused?: ZmanPause;
}

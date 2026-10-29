import { CalendarAssignment, CalendarLabel, UserConfig } from '../types';
import { liveGoogleChoices } from '../lib/google-state';

/**
 * Spouse info extracted from calendar assignment or legacy user fields
 * All fields are optional - spouse events should appear even without metadata
 */
export interface SpouseInfo {
  name?: string;              // Optional - use "Spouse" fallback if missing
  englishName?: string;
  gender?: 'male' | 'female'; // Optional
}

/**
 * Get spouse info from calendar assignments
 * Returns null only if no spouse calendar exists
 * Returns partial info if spouse calendar exists but metadata is incomplete
 * @param assignments - Resolved assignments (getCalendarAssignmentsForUser). Without them,
 *   the Google choices that count (liveGoogleChoices), so a FamCal partner is never found.
 */
export function getSpouseInfo(user: UserConfig, assignments?: CalendarAssignment[]): SpouseInfo | null {
  // Find any spouse calendar (may or may not have metadata)
  const spouseCalendar = (assignments ?? liveGoogleChoices(user)).find(
    a => a.labels.includes('spouse')
  );

  if (!spouseCalendar) return null;

  // Return whatever metadata is available (may have partial or no data)
  return {
    name: spouseCalendar.personName,
    englishName: spouseCalendar.personEnglishName,
    gender: spouseCalendar.personGender,
  };
}

/**
 * Get all calendar IDs that have a specific label
 */
export function getCalendarsByLabel(
  assignments: CalendarAssignment[],
  label: CalendarLabel
): string[] {
  return assignments
    .filter(a => a.labels.includes(label))
    .map(a => a.calendarId);
}

/**
 * Get the primary calendar ID
 */
export function getPrimaryCalendar(
  assignments: CalendarAssignment[]
): string | null {
  const primary = assignments.find(a => a.labels.includes('primary'));
  return primary?.calendarId || null;
}

/** A FamCal calendar id ('native:<cuid>'); every other id is Google's. */
export const isFamcalId = (calendarId: string): boolean => calendarId.startsWith('native:');

/**
 * Where an event goes when nothing places it ("Google as a connection" spec §3), over the
 * union list (getCalendarAssignmentsForUser: FamCal rows, then the Google choices). The
 * first match wins:
 * 1. the user's own calendar labelled primary, the Google one when both kinds carry it;
 * 2. the first Google calendar labelled yours, else the first Google calendar;
 * 3. the main FamCal calendar: null, for the caller to resolve (getMainNativeCalendar,
 *    which makes it when there is none). The list can't tell an own FamCal row from the
 *    partner's without a primary.
 * Partner rows never count: labelsFromViewerSide strips their primary, and every Google
 * choice is the user's own.
 */
export function defaultCalendarFor(calendars: readonly Pick<CalendarAssignment, 'calendarId' | 'labels'>[]): string | null {
  const google = calendars.filter((c) => !isFamcalId(c.calendarId));
  const primary = google.find((c) => c.labels.includes('primary')) ?? calendars.find((c) => c.labels.includes('primary'));
  if (primary) return primary.calendarId;
  return (google.find((c) => c.labels.includes('yours')) ?? google[0])?.calendarId ?? null;
}

/** Why a selection of Google calendars is refused: a stable code beside each message, for the screen that says it in the person's words. */
export type AssignmentIssueCode = 'multiple_primary' | 'primary_not_yours' | 'none_selected' | 'multiple_categories' | 'no_yours';

/**
 * Validate calendar assignments against business rules. `errors` are the messages (English, for logs and old callers);
 * `codes` are the same issues in the same order, as stable codes.
 */
export function validateCalendarAssignments(
  assignments: CalendarAssignment[]
): { valid: boolean; errors: string[]; codes: AssignmentIssueCode[] } {
  const errors: string[] = [];
  const codes: AssignmentIssueCode[] = [];
  const refuse = (code: AssignmentIssueCode, message: string) => {
    codes.push(code);
    errors.push(message);
  };

  // Rule 1: Only one primary
  const primaryCount = assignments.filter(a => a.labels.includes('primary')).length;
  if (primaryCount > 1) {
    refuse('multiple_primary', 'Only one calendar can be primary');
  }

  // Rule 2: Primary must also be in "yours"
  const primaryCal = assignments.find(a => a.labels.includes('primary'));
  if (primaryCal && !primaryCal.labels.includes('yours')) {
    refuse('primary_not_yours', 'Primary calendar must be in "yours" category');
  }

  // Rule 3: At least one calendar must be checked
  if (assignments.length === 0) {
    refuse('none_selected', 'At least one calendar must be selected');
  }

  // Rule 4: Mutual exclusivity (except primary+yours)
  for (const assignment of assignments) {
    const categories = assignment.labels.filter(l => l !== 'primary');
    if (categories.length > 1) {
      refuse('multiple_categories', `Calendar "${assignment.name}" cannot be in multiple categories (except primary+yours)`);
    }
  }

  // Rule 5: At least one calendar must have 'yours' label
  const hasYours = assignments.some(a => a.labels.includes('yours'));
  if (assignments.length > 0 && !hasYours) {
    refuse('no_yours', 'At least one calendar must be marked as "yours"');
  }

  return {
    valid: errors.length === 0,
    errors,
    codes
  };
}

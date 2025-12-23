import { CalendarAssignment, CalendarLabel } from '../types';

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

/**
 * Validate calendar assignments against business rules
 */
export function validateCalendarAssignments(
  assignments: CalendarAssignment[]
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Rule 1: Only one primary
  const primaryCount = assignments.filter(a => a.labels.includes('primary')).length;
  if (primaryCount > 1) {
    errors.push('Only one calendar can be primary');
  }

  // Rule 2: Primary must also be in "yours"
  const primaryCal = assignments.find(a => a.labels.includes('primary'));
  if (primaryCal && !primaryCal.labels.includes('yours')) {
    errors.push('Primary calendar must be in "yours" category');
  }

  // Rule 3: At least one calendar must be checked
  if (assignments.length === 0) {
    errors.push('At least one calendar must be selected');
  }

  // Rule 4: Mutual exclusivity (except primary+yours)
  for (const assignment of assignments) {
    const categories = assignment.labels.filter(l => l !== 'primary');
    if (categories.length > 1) {
      errors.push(`Calendar "${assignment.name}" cannot be in multiple categories (except primary+yours)`);
    }
  }

  // Rule 5: At least one calendar must have 'yours' label
  const hasYours = assignments.some(a => a.labels.includes('yours'));
  if (assignments.length > 0 && !hasYours) {
    errors.push('At least one calendar must be marked as "yours"');
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

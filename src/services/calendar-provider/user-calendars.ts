// Cross-provider helpers that resolve the user's calendar context into shapes
// the existing voice prompt and reminder/summary code already understand.
//
// For GOOGLE users this is just `user.calendarAssignments` (verbatim). For
// NATIVE users we synthesize CalendarAssignment objects from NativeCalendar
// rows so the existing label-aware prompt logic in gemini-voice.ts works
// unchanged — native calendar IDs are namespaced as `native:<cuid>`.

import type { UserConfig } from '../../types';
import type { CalendarAssignment, CalendarLabel } from '../../types';
import {
  encodeCalendarId,
  getPartnerUserId,
  listVisibleCalendars,
} from '../native-calendar/event-store';

/**
 * Resolve the CalendarAssignment[] shape for a user regardless of provider.
 * Pure read; safe to call from voice handlers, reminders, summaries.
 */
export async function getCalendarAssignmentsForUser(user: UserConfig): Promise<CalendarAssignment[]> {
  if (user.calendarSource === 'NATIVE') {
    const calendars = await listVisibleCalendars(user.id, user.pairingId ?? null);
    return calendars.map((c) => ({
      calendarId: encodeCalendarId(c.id),
      labels: (c.labels as CalendarLabel[]) || [],
      name: c.name,
      color: c.color,
      personName: c.personName ?? undefined,
      personEnglishName: c.personEnglishName ?? undefined,
      personGender: (c.personGender as 'male' | 'female' | undefined) ?? undefined,
      rules: c.rules || undefined,
    }));
  }
  // GOOGLE: existing behavior — assignments are stored on User.calendarAssignments JSON
  return user.calendarAssignments ?? [];
}

/**
 * True if the user has a usable calendar setup for read/write. For GOOGLE
 * users that means a non-empty refresh token. For NATIVE users we just need
 * at least one visible calendar (own or partner-shared editor).
 *
 * NATIVE recovery: if a NATIVE user has zero visible calendars (rare — only
 * if `ensurePrimaryNativeCalendar` failed at signup), this lazily re-runs
 * the bootstrap so the user isn't permanently bricked. Best-effort only.
 */
export async function hasUsableCalendar(user: UserConfig): Promise<boolean> {
  if (user.calendarSource === 'NATIVE') {
    let assignments = await getCalendarAssignmentsForUser(user);
    if (assignments.length === 0) {
      try {
        const { ensurePrimaryNativeCalendar } = await import('../native-calendar/onboarding');
        await ensurePrimaryNativeCalendar(user.id);
        assignments = await getCalendarAssignmentsForUser(user);
      } catch (err) {
        console.warn('[UserCalendars] Lazy primary-calendar bootstrap failed:', err);
      }
    }
    return assignments.length > 0;
  }
  return Boolean(user.googleRefreshToken && user.googleRefreshToken.length > 0);
}

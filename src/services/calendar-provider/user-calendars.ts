// Cross-provider helpers that resolve the user's calendar context into shapes
// the existing voice prompt and reminder/summary code already understand.
//
// For GOOGLE users this is just `user.calendarAssignments` (verbatim). For
// NATIVE users we synthesize CalendarAssignment objects from NativeCalendar
// rows so the existing label-aware prompt logic in gemini-voice.ts works
// unchanged — native calendar IDs are namespaced as `native:<cuid>`.

import type { NativeCalendar, User } from '@prisma/client';
import type { UserConfig } from '../../types';
import type { CalendarAssignment, CalendarLabel } from '../../types';
import { prisma } from '../../utils/prisma';
import {
  encodeCalendarId,
  listVisibleCalendars,
} from '../native-calendar/event-store';

type CalendarOwner = Pick<User, 'id' | 'name' | 'englishName' | 'gender'>;

/**
 * Resolve the CalendarAssignment[] shape for a user regardless of provider.
 * Pure read; safe to call from voice handlers, reminders, summaries.
 *
 * A NativeCalendar's labels are its owner's, so the partner's own calendar says
 * `primary, yours`. The user sees the partner's calendars labelled from their own
 * side (labelsFromViewerSide), and the partner's own calendar, when it names no
 * person, is named after the partner, so summaries file and name it as the spouse's.
 */
export async function getCalendarAssignmentsForUser(user: UserConfig): Promise<CalendarAssignment[]> {
  if (user.calendarSource === 'NATIVE') {
    const calendars = await listVisibleCalendars(user.id, user.pairingId ?? null);
    const owners = await loadUnnamedOwners(calendars, user.id);
    return calendars.map((c) => {
      const partnersCalendar = c.ownerUserId !== user.id;
      const owner = needsOwnerName(c, user.id) ? owners.get(c.ownerUserId) : undefined;
      return {
        calendarId: encodeCalendarId(c.id),
        labels: partnersCalendar ? labelsFromViewerSide(c.labels as CalendarLabel[]) : (c.labels as CalendarLabel[]) || [],
        name: c.name,
        color: c.color,
        personName: owner ? owner.name : c.personName ?? undefined,
        personEnglishName: owner ? owner.englishName || undefined : c.personEnglishName ?? undefined,
        personGender: ((owner ? owner.gender : c.personGender) as 'male' | 'female' | undefined) ?? undefined,
        rules: c.rules || undefined,
      };
    });
  }
  // GOOGLE: existing behavior — assignments are stored on User.calendarAssignments JSON
  return user.calendarAssignments ?? [];
}

/**
 * The labels of the partner's calendar as the other partner sees it: the owner's
 * own (`primary` or `yours`) is the spouse's, the owner's `spouse` is the viewer's
 * own (`yours`), and `kids` and `birthdays` stay. `primary` is dropped, since the
 * viewer's primary calendar is their own.
 */
export function labelsFromViewerSide(labels: CalendarLabel[]): CalendarLabel[] {
  const seen = new Set<CalendarLabel>();
  for (const label of labels) {
    if (label === 'primary' || label === 'yours') seen.add('spouse');
    else if (label === 'spouse') seen.add('yours');
    else seen.add(label);
  }
  return [...seen];
}

/** The partner's own calendar with no person on it, which is named after its owner. */
function needsOwnerName(calendar: NativeCalendar, viewerId: number): boolean {
  if (calendar.ownerUserId === viewerId || calendar.personName?.trim()) return false;
  const viewerLabels = labelsFromViewerSide(calendar.labels as CalendarLabel[]);
  // A kids calendar's person is a child, never the partner.
  return viewerLabels.includes('spouse') && !viewerLabels.includes('kids');
}

/** The owners of the calendars needsOwnerName picks, in one query; none when it picks none. */
async function loadUnnamedOwners(calendars: NativeCalendar[], viewerId: number): Promise<Map<number, CalendarOwner>> {
  const ids = [...new Set(calendars.filter(c => needsOwnerName(c, viewerId)).map(c => c.ownerUserId))];
  if (ids.length === 0) return new Map();
  const owners = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true, englishName: true, gender: true },
  });
  return new Map(owners.map(o => [o.id, o]));
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

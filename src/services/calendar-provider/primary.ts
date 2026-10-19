// One primary across the user's own FamCal calendars and Google choices ("Google as a
// connection" spec §3). A save that ADDS primary to a calendar (its stored labels lacked
// it) takes it from every other own calendar of both kinds; a save that leaves primary
// where it was never touches the other list, so renames and label toggles are safe.
// Used by the select-calendars POST, the FamCal POST and PATCH, and the WA→TG merge.

import type { Prisma } from '@prisma/client';
import type { CalendarAssignment } from '../../types';
import { prisma } from '../../utils/prisma';

type Db = Prisma.TransactionClient | typeof prisma;

/** True when `after` has primary and `before` (the stored labels; none for a new calendar) did not. */
export function addsPrimary(before: readonly string[] | null | undefined, after: readonly string[]): boolean {
  return after.includes('primary') && !(before ?? []).includes('primary');
}

/** The Google choices without primary, except on `keepCalendarId`; null when nothing changes. */
export function withoutOtherGooglePrimary(
  assignments: readonly CalendarAssignment[],
  keepCalendarId?: string
): CalendarAssignment[] | null {
  if (!assignments.some((a) => a.calendarId !== keepCalendarId && a.labels.includes('primary'))) return null;
  return assignments.map((a) =>
    a.calendarId !== keepCalendarId && a.labels.includes('primary') ? { ...a, labels: a.labels.filter((l) => l !== 'primary') } : a
  );
}

/**
 * Makes `keep` the user's only primary: primary comes off every other own live FamCal
 * calendar and every other Google choice (yours stays, as a primary must be in yours).
 * Returns what it changed (logged with the FamCal ids and the Google count).
 */
export async function clearOtherPrimaries(
  userId: number,
  keep: { famcalId?: string; googleCalendarId?: string },
  db: Db = prisma
): Promise<{ famcal: string[]; google: string[] }> {
  const famcal = await db.nativeCalendar.findMany({
    where: { ownerUserId: userId, isDeleted: false, labels: { has: 'primary' } },
    select: { id: true, labels: true },
  });
  const cleared = { famcal: [] as string[], google: [] as string[] };
  for (const c of famcal) {
    if (c.id === keep.famcalId) continue;
    await db.nativeCalendar.update({ where: { id: c.id }, data: { labels: c.labels.filter((l) => l !== 'primary') } });
    cleared.famcal.push(c.id);
  }
  const user = await db.user.findUnique({ where: { id: userId }, select: { calendarAssignments: true } });
  const stored = Array.isArray(user?.calendarAssignments) ? (user.calendarAssignments as unknown as CalendarAssignment[]) : [];
  const next = withoutOtherGooglePrimary(stored, keep.googleCalendarId);
  if (next) {
    await db.user.update({ where: { id: userId }, data: { calendarAssignments: next as unknown as Prisma.InputJsonValue } });
    cleared.google = stored.filter((a) => a.calendarId !== keep.googleCalendarId && a.labels.includes('primary')).map((a) => a.calendarId);
  }
  if (cleared.famcal.length || cleared.google.length) {
    console.log(`[Primary] User ${userId}: primary moved; cleared FamCal [${cleared.famcal.join(',')}] and ${cleared.google.length} Google`);
  }
  return cleared;
}

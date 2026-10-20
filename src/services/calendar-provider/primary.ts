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

/**
 * The first Google choices came with no Google primary: the user's FamCal main, if it is
 * still the fresh, empty default (their only own primary, with no live events or reminders,
 * and not shared with a partner), gives up primary (yours stays). The lazy main made before
 * the choices got ['primary', 'yours']; made after, it would have had ['yours'] only (spec §3),
 * so the default is then the first Google "yours" either way. The WA→TG merge applies the same
 * rule to a fresh T's empty default. Returns the calendar it changed, if any.
 */
export async function dropFreshFamcalPrimary(user: { id: number; pairingId?: string | null }, db: Db = prisma): Promise<string | null> {
  if (user.pairingId) return null;
  const primaries = await db.nativeCalendar.findMany({
    where: { ownerUserId: user.id, isDeleted: false, labels: { has: 'primary' } },
    select: { id: true, labels: true },
  });
  if (primaries.length !== 1) return null;
  const main = primaries[0];
  const events = await db.nativeEvent.count({ where: { calendarId: main.id, isDeleted: false } });
  if (events > 0) return null;
  await db.nativeCalendar.update({ where: { id: main.id }, data: { labels: main.labels.filter((l) => l !== 'primary') } });
  console.log(`[Primary] User ${user.id}: primary off the fresh FamCal default ${main.id}; the first Google choices have no primary`);
  return main.id;
}

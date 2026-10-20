// Dirty marks for the copy-to-Google outbox (google-sync spec §2, Dirty marks).
//
// Every FamCal write that can change what a Google copy shows calls markSyncDirty with
// its own transaction client, so the mark commits or rolls back with the write: the
// event store (create, update, delete, the 3b and Hebrew paths, createNativeSeries), the
// calendar PATCH and DELETE routes, the WhatsApp → Telegram merge and the hard delete.
//
// Marks are per link. Only a calendar with an enabled GoogleSyncLink whose user owns the
// calendar gets marks, so a partner's data reaches only the owner's Google, and only for
// calendars the owner owns. Reminders are never copied, so they are never marked and
// cost no query. A write on a calendar with no link costs one indexed lookup and marks
// nothing.
//
// A mark is `dirtySeq + 1`. The worker records the dirtySeq it read and stores it as
// pushedSeq, so an item is clean only when pushedSeq === dirtySeq, and a write that lands
// mid-push leaves it dirty.

import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../utils/prisma';
import { openSyncGate } from './gate';

/** A series a write touched: every calendar it was in before the write or is in after it. */
export interface SyncSeries {
  id: string;
  kind: string;
  calendarIds: ReadonlyArray<string | null | undefined>;
}

/**
 * What to mark: series (one item per series per link of each of its calendars), or a
 * calendar's link itself (a rename: the worker renames the Google calendar).
 */
export type SyncMarkTarget = { series: ReadonlyArray<SyncSeries> } | { calendarId: string };

/** What turning a copy off asked for (spec §1): delete the Google calendar, or leave it. */
export type UnlinkChoice = 'remove' | 'keep';

type Db = Prisma.TransactionClient;

/** Transactions a mark landed in, so markedTransaction opens the gate once they commit. */
const markedIn = new WeakSet<object>();

function noteMark(db: Db): void {
  markedIn.add(db);
  openSyncGate();
}

/** The enabled links on these calendars whose user owns the calendar. */
async function ownedLinks(db: Db, calendarIds: string[]): Promise<Array<{ id: string; nativeCalendarId: string }>> {
  const links = await db.googleSyncLink.findMany({
    where: { nativeCalendarId: { in: calendarIds }, enabled: true },
    select: { id: true, userId: true, nativeCalendarId: true, nativeCalendar: { select: { ownerUserId: true } } },
  });
  return links.flatMap((l) =>
    l.nativeCalendarId && l.nativeCalendar && l.nativeCalendar.ownerUserId === l.userId ? [{ id: l.id, nativeCalendarId: l.nativeCalendarId }] : []
  );
}

/**
 * Mark what a write changed, inside the write's transaction (`db`). Returns how many
 * items or links it marked; any mark opens the gate.
 */
export async function markSyncDirty(db: Db, target: SyncMarkTarget): Promise<number> {
  if ('calendarId' in target) {
    const links = await ownedLinks(db, [target.calendarId]);
    if (links.length === 0) return 0;
    await db.googleSyncLink.updateMany({ where: { id: { in: links.map((l) => l.id) } }, data: { dirtySeq: { increment: 1 } } });
    noteMark(db);
    return links.length;
  }

  const series = target.series.filter((s) => s.kind !== 'REMINDER');
  const calendarIds = [...new Set(series.flatMap((s) => s.calendarIds).filter((id): id is string => !!id))];
  if (calendarIds.length === 0) return 0;
  const links = await ownedLinks(db, calendarIds);
  if (links.length === 0) return 0;

  const keys = new Map<string, { linkId: string; seriesId: string }>();
  for (const link of links) {
    for (const s of series) {
      if (s.calendarIds.includes(link.nativeCalendarId)) keys.set(`${link.id}\u0000${s.id}`, { linkId: link.id, seriesId: s.id });
    }
  }
  if (keys.size === 0) return 0;
  // One statement, atomic per row: a new item starts dirty, an existing one goes up by one.
  // Rows in key order, so two writes marking the same items lock them in the same order.
  const rows = [...keys.values()].sort((a, b) => (a.linkId === b.linkId ? (a.seriesId < b.seriesId ? -1 : 1) : a.linkId < b.linkId ? -1 : 1));
  await db.$executeRaw`
    INSERT INTO "GoogleSyncItem" ("id", "linkId", "nativeEventId", "dirtySeq")
    VALUES ${Prisma.join(rows.map((r) => Prisma.sql`(${randomUUID()}, ${r.linkId}, ${r.seriesId}, 1)`))}
    ON CONFLICT ("linkId", "nativeEventId") DO UPDATE
      SET "dirtySeq" = "GoogleSyncItem"."dirtySeq" + 1`;
  noteMark(db);
  return rows.length;
}

/**
 * Turn the enabled copies of these calendars, or of this user, off, inside the caller's
 * transaction: enabled = false with the choice for the worker to carry out (Remove deletes
 * the Google calendar, or only FamCal's events when the user added their own; Keep marks
 * its description as no longer updated). The link row stays, so the Google calendar stays
 * hidden from FamCal's reads and a re-enable can reuse it. Returns how many it turned off.
 */
export async function unlinkSync(
  db: Db,
  where: { calendarIds: string[] } | { userId: number },
  choice: UnlinkChoice
): Promise<number> {
  const scope = 'userId' in where ? { userId: where.userId } : { nativeCalendarId: { in: where.calendarIds } };
  if ('calendarIds' in where && where.calendarIds.length === 0) return 0;
  const { count } = await db.googleSyncLink.updateMany({
    where: { ...scope, enabled: true },
    data: { enabled: false, unlinkChoice: choice, dirtySeq: { increment: 1 } },
  });
  if (count > 0) noteMark(db);
  return count;
}

/**
 * prisma.$transaction for a write that marks: once it commits, the gate opens again if a
 * mark landed in it. The mark opened the gate already, but a worker pass that went
 * through the gate before the commit read the database without it; opening again after
 * the commit keeps that pass from closing the gate over it.
 */
export async function markedTransaction<T>(write: (tx: Db) => Promise<T>): Promise<T> {
  let client: object | undefined;
  const result = await prisma.$transaction(async (tx) => {
    client = tx;
    return write(tx);
  });
  if (client && markedIn.has(client)) {
    markedIn.delete(client);
    openSyncGate();
  }
  return result;
}

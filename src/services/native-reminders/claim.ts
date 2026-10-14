// The atomic claim on a reminder occurrence before its ping is sent (spec §4.3).
//
// Overlapping ticks, a manual run, and the two processes Railway runs during a deploy
// can each find the same occurrence due. Only the one whose claim returns a row sends.
// The claim is one conditional upsert on the state row's (seriesEventId,
// originalStartsAt) key. Prisma's upsert can't carry the condition, hence the raw SQL.

import { randomUUID } from 'crypto';
import { prisma } from '../../utils/prisma';

export interface Claim {
  id: string; // the state row, which the ping's buttons carry
  claimedAt: Date; // the lastPingedAt this claim wrote
  previousLastPingedAt: Date | null; // what releaseClaim puts back
  pingAttempts: number; // claims made on this occurrence, this one included
}

/**
 * Claim one occurrence for a ping due at `due`. Null when it is done or something has
 * already pinged it for this due time. The row is created on the first claim: until
 * then the occurrence has no state, which means pending.
 *
 * Timestamps go in as ISO strings read as UTC, because Prisma keeps DateTime columns as
 * timestamp(3) holding UTC wall-clock time, whatever the session's timezone is.
 */
export async function claimOccurrence(
  seriesEventId: string,
  originalStartsAt: Date,
  due: Date,
  now: Date = new Date()
): Promise<Claim | null> {
  const previous = await prisma.nativeReminderState.findUnique({
    where: { seriesEventId_originalStartsAt: { seriesEventId, originalStartsAt } },
    select: { lastPingedAt: true },
  });
  const at = now.toISOString();
  const rows = await prisma.$queryRaw<Array<{ id: string; lastPingedAt: Date; pingAttempts: number }>>`
    INSERT INTO "NativeReminderState" ("id", "seriesEventId", "originalStartsAt", "lastPingedAt", "pingAttempts", "updatedAt")
    VALUES (${randomUUID()}, ${seriesEventId}, (${originalStartsAt.toISOString()}::timestamptz AT TIME ZONE 'UTC'),
            (${at}::timestamptz AT TIME ZONE 'UTC'), 1, (${at}::timestamptz AT TIME ZONE 'UTC'))
    ON CONFLICT ("seriesEventId", "originalStartsAt") DO UPDATE
      SET "lastPingedAt" = EXCLUDED."lastPingedAt",
          "pingAttempts" = "NativeReminderState"."pingAttempts" + 1,
          "updatedAt" = EXCLUDED."updatedAt"
      WHERE "NativeReminderState"."doneAt" IS NULL
        AND ("NativeReminderState"."lastPingedAt" IS NULL
             OR "NativeReminderState"."lastPingedAt" < (${due.toISOString()}::timestamptz AT TIME ZONE 'UTC'))
    RETURNING "id", "lastPingedAt", "pingAttempts"`;
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    claimedAt: row.lastPingedAt,
    previousLastPingedAt: previous?.lastPingedAt ?? null,
    pingAttempts: Number(row.pingAttempts),
  };
}

/**
 * Undo a claim whose send failed for a passing reason, so a later pass tries again.
 * It does nothing once anything else has written lastPingedAt since.
 */
export async function releaseClaim(claim: Claim): Promise<void> {
  await prisma.nativeReminderState.updateMany({
    where: { id: claim.id, lastPingedAt: claim.claimedAt },
    data: { lastPingedAt: claim.previousLastPingedAt },
  });
}

// The atomic claim on a reminder occurrence, for one recipient, before their ping is sent
// (spec §4.3, "remind us both" spec Data model).
//
// Overlapping ticks, a manual run, and the two processes Railway runs during a deploy
// can each find the same occurrence due. Only the one whose claim returns a row sends.
// The claim is one statement: ensure the occurrence's state row (unique on seriesEventId,
// originalStartsAt), then insert-or-update the recipient's ping row (unique on stateId,
// userId) while the occurrence is not done, that recipient has not marked their own Done and has not
// been pinged for this due time. A person's own Done counts only while the series' switch "each of us
// marks it done" is on (the SQL reads it from the series row); with it off a leftover ping Done is never
// read, as ownership.userDoneAt. Prisma's upsert can't carry the condition, hence the raw SQL. A reminder
// for both partners is claimed once per recipient, so each is pinged once.

import { randomUUID } from 'crypto';
import { prisma } from '../../utils/prisma';

export interface Claim {
  id: string; // the recipient's ping row
  stateId: string; // the occurrence's state row, which the ping's buttons carry
  userId: number; // the recipient
  claimedAt: Date; // the lastPingedAt this claim wrote
  previousLastPingedAt: Date | null; // what releaseClaim puts back
  pingAttempts: number; // claims made on this recipient's ping, this one included
  created: boolean; // the claim made the ping row (this recipient had none for the occurrence)
}

/**
 * Claim one occurrence for `userId`'s ping due at `due`. Null when it is done or something
 * has already pinged them for this due time. The rows are created on the first claim: until
 * then the occurrence has no state, which means pending.
 *
 * Timestamps go in as ISO strings read as UTC, because Prisma keeps DateTime columns as
 * timestamp(3) holding UTC wall-clock time, whatever the session's timezone is.
 */
export async function claimOccurrence(
  seriesEventId: string,
  originalStartsAt: Date,
  userId: number,
  due: Date,
  now: Date = new Date()
): Promise<Claim | null> {
  const previous = await prisma.nativeReminderPing.findFirst({
    where: { userId, state: { seriesEventId, originalStartsAt } },
    select: { lastPingedAt: true },
  });
  const at = now.toISOString();
  const dueAt = due.toISOString();
  // The state row insert is a no-op update when the row exists, so RETURNING gives its id and
  // doneAt either way. The ping row is then written only while the occurrence is not done.
  const rows = await prisma.$queryRaw<Array<{ id: string; stateId: string; lastPingedAt: Date; pingAttempts: number }>>`
    WITH state AS (
      INSERT INTO "NativeReminderState" ("id", "seriesEventId", "originalStartsAt", "updatedAt")
      VALUES (${randomUUID()}, ${seriesEventId}, (${originalStartsAt.toISOString()}::timestamptz AT TIME ZONE 'UTC'),
              (${at}::timestamptz AT TIME ZONE 'UTC'))
      ON CONFLICT ("seriesEventId", "originalStartsAt") DO UPDATE SET "updatedAt" = "NativeReminderState"."updatedAt"
      RETURNING "id", "doneAt"
    )
    INSERT INTO "NativeReminderPing" ("id", "stateId", "userId", "lastPingedAt", "pingAttempts", "updatedAt")
    SELECT ${randomUUID()}::text, state."id", ${userId}::integer, (${at}::timestamptz AT TIME ZONE 'UTC'), 1, (${at}::timestamptz AT TIME ZONE 'UTC')
    FROM state
    WHERE state."doneAt" IS NULL
    ON CONFLICT ("stateId", "userId") DO UPDATE
      SET "lastPingedAt" = EXCLUDED."lastPingedAt",
          "pingAttempts" = "NativeReminderPing"."pingAttempts" + 1,
          "updatedAt" = EXCLUDED."updatedAt"
      WHERE ("NativeReminderPing"."doneAt" IS NULL
             OR NOT COALESCE((SELECT "eachMarksDone" FROM "NativeEvent" WHERE "id" = ${seriesEventId}), false))
        AND ("NativeReminderPing"."lastPingedAt" IS NULL
         OR "NativeReminderPing"."lastPingedAt" < (${dueAt}::timestamptz AT TIME ZONE 'UTC'))
    RETURNING "id", "stateId", "lastPingedAt", "pingAttempts"`;
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    stateId: row.stateId,
    userId,
    claimedAt: row.lastPingedAt,
    previousLastPingedAt: previous?.lastPingedAt ?? null,
    pingAttempts: Number(row.pingAttempts),
    created: previous === null,
  };
}

/**
 * Take back a claim made on a stale read of its series (3b spec §3.1, Recipient race): the
 * ping row it made goes, or the row it updated gets its last ping and attempts back, as if
 * it had never happened. Does nothing once anything else has written lastPingedAt since.
 * A row that has gained the person's own Done since is not the claim's to delete (the Done
 * made it a row in its own right), so it is put back like an updated one.
 */
export async function undoClaim(claim: Claim): Promise<void> {
  if (claim.created) {
    const { count } = await prisma.nativeReminderPing.deleteMany({ where: { id: claim.id, lastPingedAt: claim.claimedAt, doneAt: null } });
    if (count > 0) return;
  }
  await prisma.nativeReminderPing.updateMany({
    where: { id: claim.id, lastPingedAt: claim.claimedAt },
    data: { lastPingedAt: claim.previousLastPingedAt, pingAttempts: Math.max(0, claim.pingAttempts - 1) },
  });
}

/**
 * Undo a claim whose send failed for a passing reason, so a later pass tries again.
 * It does nothing once anything else has written lastPingedAt since.
 */
export async function releaseClaim(claim: Claim): Promise<void> {
  await prisma.nativeReminderPing.updateMany({
    where: { id: claim.id, lastPingedAt: claim.claimedAt },
    data: { lastPingedAt: claim.previousLastPingedAt },
  });
}

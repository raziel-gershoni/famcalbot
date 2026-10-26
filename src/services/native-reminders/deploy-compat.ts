// Deploy-window compatibility for "remind us both", THIS RELEASE ONLY. Remove with the step-2 SQL
// (drop-reminder-state-ping-columns), which drops the old columns these two read and write.
//
// The migration copied the state rows' ping columns into NativeReminderPing at the start of the
// build, but the previous build keeps serving, and writing only the old columns, until the new
// one takes over (and for as long as a failed build leaves it up). So:
//   1. catchUpOldPingWrites() copies what the old build wrote after the copy (a snooze, a ping it
//      sent, its live message) into the old recipient's ping row, only where it is newer.
//   2. recordOldLastPing() lets the old build's claim see a ping the new build sent, so a
//      process still running the old code doesn't ping the same occurrence again.

import { prisma } from '../../utils/prisma';
import { captureError } from '../../lib/error-capture';

/**
 * Copy the old ping columns of state rows into the ping row of the person the old build pinged
 * (COALESCE(forUserId, creatorUserId), as the migration), where they are newer than the ping row
 * and the state row was written after it. Creates the ping row when missing. Resolves to how many
 * ping rows it wrote.
 */
export async function catchUpOldPingWrites(): Promise<number> {
  return prisma.$executeRaw`
    INSERT INTO "NativeReminderPing" AS p ("id", "stateId", "userId", "snoozedUntil", "lastPingedAt", "pingAttempts", "pingChatId", "pingMessageId", "createdAt", "updatedAt")
    SELECT gen_random_uuid()::text, s."id", COALESCE(e."forUserId", e."creatorUserId"),
           s."snoozedUntil", s."lastPingedAt", s."pingAttempts", s."pingChatId", s."pingMessageId", s."createdAt", s."updatedAt"
    FROM "NativeReminderState" s
    JOIN "NativeEvent" e ON e."id" = s."seriesEventId"
    WHERE s."snoozedUntil" IS NOT NULL OR s."lastPingedAt" IS NOT NULL OR s."pingChatId" IS NOT NULL
    ON CONFLICT ("stateId", "userId") DO UPDATE SET
      "snoozedUntil" = CASE WHEN EXCLUDED."snoozedUntil" IS NOT NULL AND (p."snoozedUntil" IS NULL OR EXCLUDED."snoozedUntil" > p."snoozedUntil")
                            THEN EXCLUDED."snoozedUntil" ELSE p."snoozedUntil" END,
      "lastPingedAt" = CASE WHEN EXCLUDED."lastPingedAt" > COALESCE(p."lastPingedAt", 'epoch'::timestamp) THEN EXCLUDED."lastPingedAt" ELSE p."lastPingedAt" END,
      "pingAttempts" = CASE WHEN EXCLUDED."lastPingedAt" > COALESCE(p."lastPingedAt", 'epoch'::timestamp) THEN EXCLUDED."pingAttempts" ELSE p."pingAttempts" END,
      "pingChatId" = CASE WHEN EXCLUDED."lastPingedAt" > COALESCE(p."lastPingedAt", 'epoch'::timestamp) THEN EXCLUDED."pingChatId" ELSE p."pingChatId" END,
      "pingMessageId" = CASE WHEN EXCLUDED."lastPingedAt" > COALESCE(p."lastPingedAt", 'epoch'::timestamp) THEN EXCLUDED."pingMessageId" ELSE p."pingMessageId" END,
      "updatedAt" = NOW()
    WHERE EXCLUDED."updatedAt" > p."updatedAt"
      AND (EXCLUDED."lastPingedAt" > COALESCE(p."lastPingedAt", 'epoch'::timestamp)
           OR (EXCLUDED."snoozedUntil" IS NOT NULL AND (p."snoozedUntil" IS NULL OR EXCLUDED."snoozedUntil" > p."snoozedUntil")))`;
}

/** The catch-up as the scheduler runs it: counted in the log, never throws (errors go to Sentry). */
export async function runCatchUp(label: string): Promise<void> {
  try {
    const rows = await catchUpOldPingWrites();
    console.log(`[NativeReminders] Deploy catch-up (${label}): ${rows} ping row(s) brought up to date from the previous build`);
  } catch (error) {
    console.error(`[NativeReminders] Deploy catch-up (${label}) failed:`, error);
    captureError(error, 'native-reminders-deploy-catchup', { label });
  }
}

/** Run the catch-up now, and again 5, 15 and 30 minutes after boot. Never blocks boot. */
export function scheduleCatchUps(): void {
  void runCatchUp('boot');
  for (const minutes of [5, 15, 30]) {
    const timer = setTimeout(() => void runCatchUp(`+${minutes} min`), minutes * 60_000);
    timer.unref?.();
  }
}

/**
 * After a single (not both) reminder's ping was sent, put its claim on the state row's own
 * lastPingedAt too, so the previous build's claim (still running during the overlap) finds the
 * occurrence pinged. Best effort: a failure is logged and reported, the ping already went out.
 */
export async function recordOldLastPing(stateId: string, claimedAt: Date, userId: number): Promise<void> {
  try {
    await prisma.$executeRaw`
      UPDATE "NativeReminderState"
      SET "lastPingedAt" = (${claimedAt.toISOString()}::timestamptz AT TIME ZONE 'UTC')
      WHERE "id" = ${stateId} AND ("lastPingedAt" IS NULL OR "lastPingedAt" < (${claimedAt.toISOString()}::timestamptz AT TIME ZONE 'UTC'))`;
  } catch (error) {
    console.error(`[NativeReminders] Recording the old lastPingedAt failed for state ${stateId}, user ${userId}:`, error);
    captureError(error, 'native-reminders-old-last-ping', { state_id: stateId, user_id: userId }, 'warning');
  }
}

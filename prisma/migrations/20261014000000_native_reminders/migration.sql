-- Native reminders (docs/superpowers/specs/2026-10-14-native-reminders-design.md §1).
-- A reminder is a NativeEvent of kind REMINDER with no duration. forUserId names the
-- creator's partner when it is for them (SET NULL on delete: it reverts to the creator).
-- armedAt bounds the ping lookback. Per-occurrence state (pinged, snoozed, done) lives in
-- NativeReminderState, keyed like NativeEventInstance. AdminSettings gets the launch
-- switch, on by default. Existing rows become kind EVENT, so no event changes.
--
-- Hand-written and idempotent, like the other recent migrations: these are the
-- statements Prisma's diff produces for this schema change, guarded so a re-run is a
-- no-op (CREATE TYPE and ADD CONSTRAINT have no IF NOT EXISTS, hence the DO blocks).

DO $$ BEGIN
  CREATE TYPE "NativeEventKind" AS ENUM ('EVENT', 'REMINDER');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

ALTER TABLE "AdminSettings" ADD COLUMN IF NOT EXISTS "nativeRemindersEnabled" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "NativeEvent" ADD COLUMN IF NOT EXISTS "kind" "NativeEventKind" NOT NULL DEFAULT 'EVENT';
ALTER TABLE "NativeEvent" ADD COLUMN IF NOT EXISTS "forUserId" INTEGER;
ALTER TABLE "NativeEvent" ADD COLUMN IF NOT EXISTS "armedAt" TIMESTAMP(3);

-- The ping pass's candidate scan (kind = REMINDER, not deleted, by start) and the
-- "reminders for me" read across a partner's calendars, whatever their privacy.
CREATE INDEX IF NOT EXISTS "NativeEvent_kind_isDeleted_startsAt_idx" ON "NativeEvent"("kind", "isDeleted", "startsAt");
CREATE INDEX IF NOT EXISTS "NativeEvent_forUserId_idx" ON "NativeEvent"("forUserId");

CREATE TABLE IF NOT EXISTS "NativeReminderState" (
    "id" TEXT NOT NULL,
    "seriesEventId" TEXT NOT NULL,
    "originalStartsAt" TIMESTAMP(3) NOT NULL,
    "doneAt" TIMESTAMP(3),
    "doneByUserId" INTEGER,
    "snoozedUntil" TIMESTAMP(3),
    "lastPingedAt" TIMESTAMP(3),
    "pingAttempts" INTEGER NOT NULL DEFAULT 0,
    "pingChatId" BIGINT,
    "pingMessageId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NativeReminderState_pkey" PRIMARY KEY ("id")
);

-- The unique key is also the ON CONFLICT target of the pass's atomic claim.
CREATE UNIQUE INDEX IF NOT EXISTS "NativeReminderState_seriesEventId_originalStartsAt_key" ON "NativeReminderState"("seriesEventId", "originalStartsAt");
CREATE INDEX IF NOT EXISTS "NativeReminderState_snoozedUntil_idx" ON "NativeReminderState"("snoozedUntil");

-- Foreign keys
DO $$ BEGIN
  ALTER TABLE "NativeEvent" ADD CONSTRAINT "NativeEvent_forUserId_fkey"
    FOREIGN KEY ("forUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "NativeReminderState" ADD CONSTRAINT "NativeReminderState_seriesEventId_fkey"
    FOREIGN KEY ("seriesEventId") REFERENCES "NativeEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "NativeReminderState" ADD CONSTRAINT "NativeReminderState_doneByUserId_fkey"
    FOREIGN KEY ("doneByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

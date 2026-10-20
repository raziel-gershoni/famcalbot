-- FamCal → Google one-way sync (docs/superpowers/specs/2026-10-20-google-sync-design.md §2).
-- GoogleSyncLink: one own FamCal calendar copied into its own Google calendar, kept after
-- the copy is turned off (enabled = false). GoogleSyncItem: the outbox, one row per series
-- per link, marked dirty (dirtySeq + 1) in the transaction of every FamCal write.
-- nativeEventId has no foreign key, so a series can vanish under its item; the link's
-- calendar is SET NULL and the user CASCADE, so neither blocks a merge or a hard delete.
-- User gets the Google scopes saved at commit, and the once-per-outage message stamp.
-- Existing rows are unchanged: no link means nothing is copied.
--
-- Hand-written and idempotent, like the other recent migrations: the statements Prisma's
-- diff produces for this schema change, guarded so a re-run is a no-op (ADD CONSTRAINT has
-- no IF NOT EXISTS, hence the DO blocks).

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "googleScopes" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "googleSyncNotifiedAt" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "GoogleSyncLink" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "nativeCalendarId" TEXT,
    "googleCalendarId" TEXT,
    "googleAccount" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "state" TEXT NOT NULL DEFAULT 'creating',
    "unlinkChoice" TEXT,
    "dirtySeq" INTEGER NOT NULL DEFAULT 0,
    "pushedSeq" INTEGER NOT NULL DEFAULT 0,
    "pushedName" TEXT,
    "lastError" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "backfilledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GoogleSyncLink_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "GoogleSyncItem" (
    "id" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "nativeEventId" TEXT NOT NULL,
    "googleEventId" TEXT,
    "generation" INTEGER NOT NULL DEFAULT 0,
    "masterHash" TEXT,
    "slotHashes" JSONB NOT NULL DEFAULT '{}',
    "dirtySeq" INTEGER NOT NULL DEFAULT 0,
    "pushedSeq" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'ok',
    "lastError" TEXT,

    CONSTRAINT "GoogleSyncItem_pkey" PRIMARY KEY ("id")
);

-- One link per own calendar; the marks look links up by calendar.
CREATE UNIQUE INDEX IF NOT EXISTS "GoogleSyncLink_userId_nativeCalendarId_key" ON "GoogleSyncLink"("userId", "nativeCalendarId");
CREATE INDEX IF NOT EXISTS "GoogleSyncLink_nativeCalendarId_enabled_idx" ON "GoogleSyncLink"("nativeCalendarId", "enabled");
-- The unique key is also the ON CONFLICT target of the mark's upsert.
CREATE UNIQUE INDEX IF NOT EXISTS "GoogleSyncItem_linkId_nativeEventId_key" ON "GoogleSyncItem"("linkId", "nativeEventId");

-- Foreign keys
DO $$ BEGIN
  ALTER TABLE "GoogleSyncLink" ADD CONSTRAINT "GoogleSyncLink_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "GoogleSyncLink" ADD CONSTRAINT "GoogleSyncLink_nativeCalendarId_fkey"
    FOREIGN KEY ("nativeCalendarId") REFERENCES "NativeCalendar"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "GoogleSyncItem" ADD CONSTRAINT "GoogleSyncItem_linkId_fkey"
    FOREIGN KEY ("linkId") REFERENCES "GoogleSyncLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

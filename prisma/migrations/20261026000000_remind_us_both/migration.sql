-- "Remind us both" (docs/superpowers/specs/2026-10-26-remind-us-both-design.md): one reminder
-- for both paired partners. NativeEvent.forBoth marks it (forUserId is then the partner), and
-- each recipient's ping gets its own row in the new NativeReminderPing, because a snooze, the
-- claim that stops a second send and the live Telegram message are per person now. Done stays
-- on the occurrence's NativeReminderState row, shared.
--
-- The old ping columns of "NativeReminderState" (snoozedUntil, lastPingedAt, pingAttempts,
-- pingChatId, pingMessageId and the snoozedUntil index) are NOT dropped here: the build runs
-- this migration while the previous code still serves, and its Prisma client selects and
-- writes those columns by name. They leave schema.prisma in this change, and the claim also
-- reads the old lastPingedAt for this one release (src/services/native-reminders/claim.ts),
-- so a ping the old build sends during the deploy is not sent twice. A later push drops the
-- columns, the index and that fallback.
--
-- Hand-written and idempotent, like the other recent migrations: the column, table, indexes and
-- keys are created only when missing, and the copy skips a ping row that already exists, so
-- a re-run is a no-op.

ALTER TABLE "NativeEvent" ADD COLUMN IF NOT EXISTS "forBoth" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "NativeReminderPing" (
    "id" TEXT NOT NULL,
    "stateId" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "snoozedUntil" TIMESTAMP(3),
    "lastPingedAt" TIMESTAMP(3),
    "pingAttempts" INTEGER NOT NULL DEFAULT 0,
    "pingChatId" BIGINT,
    "pingMessageId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NativeReminderPing_pkey" PRIMARY KEY ("id")
);

-- The unique key is also the ON CONFLICT target of the pass's atomic claim.
CREATE UNIQUE INDEX IF NOT EXISTS "NativeReminderPing_stateId_userId_key" ON "NativeReminderPing"("stateId", "userId");
CREATE INDEX IF NOT EXISTS "NativeReminderPing_snoozedUntil_idx" ON "NativeReminderPing"("snoozedUntil");

DO $$ BEGIN
  ALTER TABLE "NativeReminderPing" ADD CONSTRAINT "NativeReminderPing_stateId_fkey"
    FOREIGN KEY ("stateId") REFERENCES "NativeReminderState"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "NativeReminderPing" ADD CONSTRAINT "NativeReminderPing_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Every state row that has any ping data becomes the ping row of the person it pinged: the
-- reminder's forUserId, else its creator (every reminder so far is for exactly one person).
INSERT INTO "NativeReminderPing" ("id", "stateId", "userId", "snoozedUntil", "lastPingedAt", "pingAttempts", "pingChatId", "pingMessageId", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, s."id", COALESCE(e."forUserId", e."creatorUserId"),
       s."snoozedUntil", s."lastPingedAt", s."pingAttempts", s."pingChatId", s."pingMessageId", s."createdAt", s."updatedAt"
FROM "NativeReminderState" s
JOIN "NativeEvent" e ON e."id" = s."seriesEventId"
WHERE s."snoozedUntil" IS NOT NULL OR s."lastPingedAt" IS NOT NULL OR s."pingAttempts" > 0
   OR s."pingChatId" IS NOT NULL OR s."pingMessageId" IS NOT NULL
ON CONFLICT ("stateId", "userId") DO NOTHING;

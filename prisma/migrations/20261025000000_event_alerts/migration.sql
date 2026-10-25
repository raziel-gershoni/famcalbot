-- One alert per event (docs/superpowers/specs/2026-10-25-editor-upgrades-design.md §2):
-- "ownAlerts" false = the user's default lead; true = the leads in "alertMinutes" (minutes
-- before the start; an empty list = no alert). They replace "reminderMinutes", which nothing
-- ever read or wrote, so a non-null value is copied (expected: no rows) as one own lead.
--
-- "reminderMinutes" is NOT dropped here: the build runs this migration while the old code
-- still serves, and the old Prisma client selects that column by name. A later migration
-- drops it once only the new code runs.
--
-- Hand-written and idempotent, like the other recent migrations: the columns are added only
-- when missing, and the copy touches only rows not already copied (ownAlerts still false), so
-- a re-run is a no-op.

ALTER TABLE "NativeEvent" ADD COLUMN IF NOT EXISTS "alertMinutes" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[];
ALTER TABLE "NativeEvent" ADD COLUMN IF NOT EXISTS "ownAlerts" BOOLEAN NOT NULL DEFAULT false;

UPDATE "NativeEvent"
SET "alertMinutes" = ARRAY["reminderMinutes"], "ownAlerts" = true
WHERE "reminderMinutes" IS NOT NULL AND "ownAlerts" = false;

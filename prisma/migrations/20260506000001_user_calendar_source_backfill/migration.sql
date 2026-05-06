-- Backfill User.calendarSource and tighten nullability.
-- Existing users with a non-empty googleRefreshToken stay on Google; everyone else
-- (including any without a token) becomes NATIVE. After this migration, the column
-- is NOT NULL and defaults to NATIVE for new rows.
--
-- Note: googleRefreshToken stays NOT NULL. NATIVE users use empty string '' (the
-- existing pattern for pre-OAuth GCal users — see user-service.ts:182,248,324).
-- A later migration may loosen this once all consumers are null-aware.

UPDATE "User"
SET "calendarSource" = 'GOOGLE'
WHERE "calendarSource" IS NULL
  AND "googleRefreshToken" <> '';

UPDATE "User"
SET "calendarSource" = 'NATIVE'
WHERE "calendarSource" IS NULL;

ALTER TABLE "User" ALTER COLUMN "calendarSource" SET NOT NULL;
ALTER TABLE "User" ALTER COLUMN "calendarSource" SET DEFAULT 'NATIVE';

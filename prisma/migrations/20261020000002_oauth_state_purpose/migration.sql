-- Google copy, the consent side (docs/superpowers/specs/2026-10-20-google-sync-design.md §3).
-- OAuthState gets the consent's purpose and calendar: a 'sync' consent (asked the first time
-- a copy is turned on) carries the FamCal calendar to copy, so its commit creates the link.
-- A plain connect leaves both null, so existing rows are unchanged. No foreign key: the
-- commit re-checks the calendar is still the user's own.
--
-- Its own migration because 20261020000001_google_sync has already shipped: migrate deploy
-- never re-runs an applied migration, so an edit to it would never reach prod.
--
-- Hand-written and idempotent, like the other recent migrations: the statements Prisma's
-- diff produces for this schema change, guarded so a re-run is a no-op.

ALTER TABLE "OAuthState" ADD COLUMN IF NOT EXISTS "purpose" TEXT;
ALTER TABLE "OAuthState" ADD COLUMN IF NOT EXISTS "nativeCalendarId" TEXT;

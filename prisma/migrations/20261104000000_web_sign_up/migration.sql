-- Web sign-up on famcal.bot (spec docs/superpowers/specs/2026-11-03-web-sign-up-design.md §2.8, §3.8).
--
-- "BlockedIdentifier"."googleSub": a banned Google account, by Google's account id (never the address).
-- "BlockedIdentifier"."email": a banned sign-in address, in normalizeEmail's form. Each is unique, like the Telegram id
-- and the WhatsApp number, so a ban is one row per identifier and a second ban of the same one updates its reason.
--
-- Additions only, so one push is enough: the previous build, still serving while this runs, never reads or writes
-- them. Hand-written and idempotent, like the other recent migrations: each is made only when missing, so a re-run is
-- a no-op.

ALTER TABLE "BlockedIdentifier" ADD COLUMN IF NOT EXISTS "googleSub" TEXT;
ALTER TABLE "BlockedIdentifier" ADD COLUMN IF NOT EXISTS "email" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "BlockedIdentifier_googleSub_key" ON "BlockedIdentifier"("googleSub");
CREATE UNIQUE INDEX IF NOT EXISTS "BlockedIdentifier_email_key" ON "BlockedIdentifier"("email");

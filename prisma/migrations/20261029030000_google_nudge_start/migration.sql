-- When the 07:00 run first saw the person in a Google setup state (a token with no chosen calendars, or a legacy Google
-- user with no token): the start of the Google setup nudges (src/services/setup-tracks.ts). It lived in Redis for a year,
-- past the Privacy Policy's "up to 30 days" for cache copies (the final review's M-2); the nudges' attempt marks stay in
-- Redis, now for 30 days, and the start is account data, deleted with the account. Null: no Google track has started
-- (or a fresh connect, a disconnect or an admin reset started them over).
--
-- One nullable column, so one push is enough: the previous build, still serving while this runs, never reads or writes
-- it. Hand-written and idempotent: added only when missing, so a re-run is a no-op.

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "googleNudgeStartedAt" TIMESTAMP(3);

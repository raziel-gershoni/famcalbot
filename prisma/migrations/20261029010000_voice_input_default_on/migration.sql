-- New accounts can add events by voice note from the start (owner 2026-10-29): the site's "just say it" is true on day one.
-- Only the default changes; every existing account keeps the value it has.
ALTER TABLE "User" ALTER COLUMN "voiceInputEnabled" SET DEFAULT true;

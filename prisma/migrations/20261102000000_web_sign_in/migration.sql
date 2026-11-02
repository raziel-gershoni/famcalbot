-- Web sign-in on famcal.bot (spec docs/superpowers/specs/2026-11-02-web-sign-in-design.md §2.12, §2.13, §2.17).
--
-- "SignInIdentity": the ways a person signs in besides Telegram, a Google account (subject = Google's account id) or
-- an email address (subject = the normalised address). One of each kind per person ("userId", "kind"), each on one
-- account only ("kind", "subject"); deleted with the account (ON DELETE CASCADE).
-- "User"."sessionsValidAfter": a web session signed in before it is refused (Sign out on all devices, removing a way,
-- a suspension, a ban); null = none ended. It sits in the row every request already reads, so it costs no query.
-- "User"."googleAccountKey": a keyed hash of the connected Google Calendar account's address, never the address; null
-- until a connect, or the startup pass for accounts connected before this, writes it. Indexed: a Google sign-in looks
-- it up.
-- "User"."googleCalendarSignIn": whether that account may sign in. On for every row, the existing ones included, so a
-- person who connected Google Calendar long ago signs in with it once their key is filled; off once they remove a
-- Google way.
--
-- Additions only, so one push is enough: the previous build, still serving while this runs, never reads or writes
-- them. Hand-written and idempotent, like the other recent migrations: each is made only when missing, so a re-run is
-- a no-op.

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "sessionsValidAfter" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "googleAccountKey" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "googleCalendarSignIn" BOOLEAN NOT NULL DEFAULT true;
CREATE INDEX IF NOT EXISTS "User_googleAccountKey_idx" ON "User"("googleAccountKey");

CREATE TABLE IF NOT EXISTS "SignInIdentity" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "SignInIdentity_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SignInIdentity_kind_subject_key" ON "SignInIdentity"("kind", "subject");
CREATE UNIQUE INDEX IF NOT EXISTS "SignInIdentity_userId_kind_key" ON "SignInIdentity"("userId", "kind");

DO $$ BEGIN
  ALTER TABLE "SignInIdentity" ADD CONSTRAINT "SignInIdentity_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

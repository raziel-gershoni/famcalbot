-- Notifications in the browser (spec docs/superpowers/specs/2026-11-05-web-push-design.md §3.1).
--
-- "PushDevice": a browser that turned FamCal's notifications on. "endpoint" is the address its push service gave that
-- browser, unique, so a browser is on one account at a time; "p256dh" and "auth" are the two keys that encrypt a
-- notification for it. At most 10 per account (src/services/web-push/devices.ts, the only file that reads or writes
-- them); deleted with the account (ON DELETE CASCADE).
--
-- Additions only, so one push is enough: the previous build, still serving while this runs, never reads or writes
-- it. Hand-written and idempotent, like the other recent migrations: each is made only when missing, so a re-run is
-- a no-op.

CREATE TABLE IF NOT EXISTS "PushDevice" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PushDevice_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PushDevice_endpoint_key" ON "PushDevice"("endpoint");
CREATE INDEX IF NOT EXISTS "PushDevice_userId_idx" ON "PushDevice"("userId");

DO $$ BEGIN
  ALTER TABLE "PushDevice" ADD CONSTRAINT "PushDevice_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

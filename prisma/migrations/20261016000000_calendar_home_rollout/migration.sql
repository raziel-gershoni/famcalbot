-- The calendar home's rollout switch (docs/superpowers/specs/2026-10-16-calendar-home-design.md §1).
-- OFF: nobody gets the new home or the summary reader; ADMINS: users with isAdmin; ALL:
-- everyone. Ships as OFF, so the deploy changes nothing anyone sees.
--
-- Hand-written and idempotent, like the other recent migrations: these are the
-- statements Prisma's diff produces for this schema change, guarded so a re-run is a
-- no-op (CREATE TYPE has no IF NOT EXISTS, hence the DO block).

DO $$ BEGIN
  CREATE TYPE "CalendarHomeRollout" AS ENUM ('OFF', 'ADMINS', 'ALL');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

ALTER TABLE "AdminSettings" ADD COLUMN IF NOT EXISTS "calendarHomeRollout" "CalendarHomeRollout" NOT NULL DEFAULT 'OFF';

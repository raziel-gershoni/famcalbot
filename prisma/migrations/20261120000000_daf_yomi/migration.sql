-- The Daf Yomi line on the calendar home (spec docs/superpowers/specs/2026-11-19-responsive-home-design.md §6).
--
-- "dafYomi": whether the day's page of Talmud shows under each date of the Month's picked day and the Agenda. Off for
-- everyone, existing accounts included; the Settings switch is shown only while the Jewish calendar is picked, and the
-- value is kept when another calendar is.
--
-- An addition only, so one push is enough: the previous build, still serving while this runs, never reads it.
-- Idempotent: a second run changes nothing.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "dafYomi" BOOLEAN NOT NULL DEFAULT false;

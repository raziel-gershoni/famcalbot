-- The Month's months on the calendar home (spec docs/superpowers/specs/2026-11-19-responsive-home-design.md §7).
--
-- "monthMode": 'gregorian' or 'hebrew', which calendar the Month counts its months in. Gregorian for everyone,
-- existing accounts included; the switch is shown only while the Jewish calendar is picked, and the value is kept
-- when another calendar is. An addition only: the previous build never reads it.
ALTER TABLE "User" ADD COLUMN "monthMode" TEXT NOT NULL DEFAULT 'gregorian';

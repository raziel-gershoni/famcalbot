-- Reminders by zman (docs/superpowers/plans/2026-10-28-zmanim-reminders.md, Task 3): a reminder's time can be a
-- zman (a halachic time such as the latest time for Shema) plus an offset, or N halachic hours after sunrise,
-- worked out every day for each person from their own place.
--
--   NativeEvent.zmanSpec  { "zman": "<KEY>", "offsetMin": <clock minutes> } or
--                         { "halachicHours": <0..12>, "offsetMin": <clock minutes> }; NULL = a plain reminder.
--                         Only a date-only (allDay) REMINDER holds one: the store clears it when the reminder
--                         is given a time of day. The computed time is never stored: startsAt stays the date.
--
-- Additions only, so one push is enough: the previous build, still serving while this runs, never selects or
-- writes the column, and NULL changes nothing it reads.
--
-- Hand-written and idempotent, like the other recent migrations: the column is added only when it is missing,
-- so a re-run is a no-op.

ALTER TABLE "NativeEvent" ADD COLUMN IF NOT EXISTS "zmanSpec" JSONB;

-- Zmanim (docs/superpowers/plans/2026-10-28-zmanim-reminders.md, Task 1): where a person is, which set
-- of zmanim they follow, and the Shabbat and Yom Tov pause switch.
--
--   latitude, longitude  the coordinates the location lookup already finds (Nominatim), kept.
--   elevationM           the highest ground in the place, metres (Open-Meteo); NULL = not known.
--   zmanimCommunity      'sephardi' (the default) | 'ashkenazi' | 'chabad'.
--   pauseOnShabbat       true = no scheduled message from candle lighting to nightfall on Shabbat
--                        and Yom Tov. On for everyone whose calendar is the Jewish one.
--
-- Additions only, so one push is enough: the previous build, still serving while this runs, never
-- selects or writes these columns, and the defaults change nothing it reads.
--
-- Hand-written and idempotent, like the other recent migrations: each column is added only when it
-- is missing. The UPDATE is a plain one: it sets the switch for the Jewish calendar's users once,
-- when the migration is applied.

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "latitude" DOUBLE PRECISION;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "longitude" DOUBLE PRECISION;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "elevationM" INTEGER;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "zmanimCommunity" TEXT NOT NULL DEFAULT 'sephardi';
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "pauseOnShabbat" BOOLEAN NOT NULL DEFAULT false;

UPDATE "User" SET "pauseOnShabbat" = true WHERE "culture" = 'jewish';

-- One Hebrew repeat (docs/superpowers/specs/2026-10-19-hebrew-repeats-design.md, amended
-- 2026-10-21): the yahrzeit kind is withdrawn and hebrewRule is only ever 'anniversary',
-- every year on the Hebrew date by hebcal's birthday rules. The app no longer reads a
-- 'yahrzeit' row, so each one becomes an 'anniversary' series with the same anchor, rule,
-- exdates and overrides. Its days move only where the two rules differ: an Adar anchor of a
-- common year read in a leap year (Adar II, not Adar I), 30 Adar I read in a common year
-- (1 Nisan, not 30 Shvat), and 30 Cheshvan or 30 Kislev in a year that month is short.
--
-- Their Google copies are marked dirty first (dirtySeq + 1, as markSyncDirty marks a write),
-- so the worker's first pass after the deploy sends them again; a copy whose days did not
-- move comes out the same. updatedAt moves as a Prisma write would move it, so a reminder
-- pass that read a series before the change reads it again (native-reminders/pass.ts).
--
-- Hand-written and idempotent, like the other recent migrations: once the rows are converted
-- neither statement matches anything, so a re-run is a no-op.

UPDATE "GoogleSyncItem"
SET "dirtySeq" = "dirtySeq" + 1
WHERE "nativeEventId" IN (SELECT "id" FROM "NativeEvent" WHERE "hebrewRule" = 'yahrzeit');

UPDATE "NativeEvent"
SET "hebrewRule" = 'anniversary', "updatedAt" = CURRENT_TIMESTAMP
WHERE "hebrewRule" = 'yahrzeit';

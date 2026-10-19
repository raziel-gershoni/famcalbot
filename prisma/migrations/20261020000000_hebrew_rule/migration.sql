-- Hebrew-date repeats (docs/superpowers/specs/2026-10-19-hebrew-repeats-design.md §2).
-- A series that repeats every year on its Hebrew date keeps a plain FREQ=YEARLY rrule and
-- names its kind ('anniversary' | 'yahrzeit') in hebrewRule, with its anchor's civil date
-- ('yyyy-MM-dd', in the series' zone) in hebrewAnchor. Both are null for every other row,
-- so existing rows are unchanged.
--
-- Hand-written and idempotent, like the other recent migrations: the statements Prisma's
-- diff produces for this schema change, guarded so a re-run is a no-op.

ALTER TABLE "NativeEvent" ADD COLUMN IF NOT EXISTS "hebrewRule" TEXT;
ALTER TABLE "NativeEvent" ADD COLUMN IF NOT EXISTS "hebrewAnchor" TEXT;

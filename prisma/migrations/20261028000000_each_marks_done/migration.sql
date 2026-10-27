-- "Each of us marks it done" (docs/superpowers/plans/2026-10-28-each-marks-done.md): a reminder for
-- both partners can let each person mark their own Done. NativeEvent.eachMarksDone is the
-- per-reminder switch (false: today's shared Done; the server keeps it false unless forBoth is
-- on), and NativeReminderPing.doneAt is one recipient's own Done. NativeReminderState.doneAt keeps
-- meaning "done for everyone": with the switch on it is set when the last recipient who can be
-- reached has marked theirs.
--
-- Additions only, so one push is enough: the previous build, still serving while this runs, never
-- selects or writes either column, and a default of false / null changes nothing it reads.
--
-- Hand-written and idempotent, like the other recent migrations: each column is added only when
-- it is missing, so a re-run is a no-op.

ALTER TABLE "NativeEvent" ADD COLUMN IF NOT EXISTS "eachMarksDone" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "NativeReminderPing" ADD COLUMN IF NOT EXISTS "doneAt" TIMESTAMP(3);

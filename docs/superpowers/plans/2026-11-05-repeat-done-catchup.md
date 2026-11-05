# Missed repeating reminders stay open until Done Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A repeating reminder's missed time no longer disappears when the next time comes: it stays in "Still open" (and the daily digest) as one row "since <first missed day>", and a Done closes the pressed time and every earlier open time of that reminder.

**Owner's design (2026-11-05):** "marking done can mark done also all appearances before this one"; Undo reopens only the time it was pressed on (option B: "if B is less work then definitely B"). Today's rule is the native reminders spec 2026-10-14 §6.2 ("Only its latest occurrence before the cutoff… Suppressed when the same series has an occurrence on the summary day"); this plan replaces those two lines.

**Architecture:** Two changes, each in the one place its logic lives. (1) `selectOpenReminderItems` (`src/services/native-reminders/open-reminders.ts`), shared by the calendar home's carry-overs, the daily digests and voice's open-reminder candidates: a repeating series offers its *open run* (every occurrence after the viewer's latest done one, inside the armed bound, due before the cutoff) as one row — the newest occurrence of the run, with `openSince` = the day of the run's oldest — and is no longer suppressed on a day it occurs again. (2) `applyReminderAction` (`src/services/native-reminders/actions.ts`), the one Done path of the bot's buttons and the home: after a Done of a repeating series' occurrence succeeds, it also marks Done every earlier open occurrence (same rules, per person where each marks their own), with no extra "Done by" notes; the home's route tells the client which ones it closed. No schema change.

**Tech Stack:** Prisma (`NativeReminderState`, `NativeReminderPing`), rrule expansion (`expandSeries`, `src/services/native-calendar/recurrence.ts`), the calendar home store (`src/lib/calendar-view/store.ts`), smoke scripts.

**Spec:** `docs/superpowers/specs/2026-10-14-native-reminders-design.md` §6.2 (amended by Task 1) and `docs/superpowers/specs/2026-10-26-remind-us-both-design.md` (per-person Done). The calendar home spec `2026-10-16-calendar-home-design.md` §7.3 (Still open card) is unchanged: it shows what the carry-over gives it.

## Global Constraints

- The armed bound stays: a repeating series never offers an occurrence due before `series.armedAt - ARMED_GRACE_MS` (it was never pinged). One-off reminders are unchanged.
- "Done for the viewer" is only ever `userDoneAt(series, state, viewerId)` (`ownership.ts`): the shared Done, or the viewer's own where each marks their own.
- The cascade closes only occurrences whose due time is before `now` and whose original start (`instanceStartsAt`/`originalStartsAt`) is before the pressed one's; never a later or a not-yet-due one. It never runs on Undo, Snooze, a one-off, or a Done that answered `already_done`.
- One "Done by" note and one activity event per press (the pressed occurrence's), never one per closed occurrence. Telegram trouble never fails the action (the existing rule).
- Undo is unchanged: it reopens only its own occurrence.
- No new user-facing words. Logs carry ids and counts only, never a title.
- Never run `npm run build`; gates are `npx tsc --noEmit -p .`, `npm run lint`, `bash scripts/ci-smokes.sh`.

## Review Focus

1. A daily reminder missed for 3 days: one carry-over row (the newest missed day) with `openSince` the first missed day, not 3 rows; a Done on today's occurrence closes all 4.
2. Mon + Thu weekly, Monday missed, Thursday morning before Thursday's time: Still open shows Monday's row ("since Monday"); its Done closes Monday only and Thursday still pings at its time.
3. Each marks their own Done: Noa's Done closes only Noa's earlier ones; an occurrence becomes done for everyone only when every counted person has marked it (the existing `markOwnDone` rule), and Dana's carry-over still shows the ones Dana hasn't marked.
4. Undo after a cascade reopens only the pressed occurrence; the carry-over then shows it as the run (its earlier ones stay done).
5. A series re-timed or created after some past occurrences (the armed bound): the cascade and the run never touch those.

---

### Task 1: The open run in the carry-over

**Files:**
- Modify: `src/services/native-reminders/open-reminders.ts` (`selectOpenReminderItems`, the file's header comment, `selectOpenReminders`' doc)
- Modify: `docs/superpowers/specs/2026-10-14-native-reminders-design.md` §6.2 "Repeating" (replace the "Only its latest occurrence…" and "Suppressed when…" lines with the open-run rule, marked "owner 2026-11-05")
- Test: `scripts/smoke-native-reminder-digest.ts` (and adjust any existing check in `smoke-calendar-range.ts`, `smoke-calendar-read-famcal.ts`, `smoke-reminder-actions.ts`, `smoke-native-rule-guards.ts` that pins the old suppression: change it to the new rule, never delete the case)

- [ ] **Step 1: Failing checks** in `smoke-native-reminder-digest.ts` (pure `selectOpenReminders`, no database): weekly Mon+Thu, Monday undone, summary day Thursday → one row, Monday's occurrence, `openSince` Monday (today it is suppressed); summary day Friday with Mon and Thu undone → one row, Thursday's occurrence, `openSince` Monday; Mon undone, Thu done, summary Friday → nothing; daily, 3 days undone → one row, the newest, `openSince` the first; an occurrence before `armedAt - ARMED_GRACE_MS` never starts the run; each marks their own: Noa done Mon, Dana not → Noa's list has nothing for Mon, Dana's has it; a snoozed occurrence in the run counts as open; a one-off is unchanged; the cap and newest-first order still hold.
- [ ] **Step 2: Run** `bash <run-smoke> smoke-native-reminder-digest` — expect FAIL on the new checks.
- [ ] **Step 3: Implement.** For a repeating series: the bound is the later of `armedAt - ARMED_GRACE_MS` (when set) and the latest occurrence before the cutoff that is done for the viewer (exclusive); expand the series from the bound to the cutoff with its overrides (`expandSeries`, which applies exdates, cancelled and moved occurrences); keep occurrences due before the cutoff and not done for the viewer; none → no row; else the row is the newest by due time and `info.openSince = localDate(<oldest's due>, timezone)`. Drop the `onSummaryDay` suppression. The done-for-viewer test reads the state rows already loaded (`states`), matched by `originalStartsAt === instanceStartsAt`. A rule that can't be read keeps its existing capture-and-skip. One-offs keep their code path.
- [ ] **Step 4: Run** `smoke-native-reminder-digest`, `smoke-calendar-range`, `smoke-calendar-read-famcal`, `smoke-reminder-actions`, `smoke-native-rule-guards`, `smoke-recurrence`, then the three gates — PASS. Commit `feat(reminders): a repeating reminder's missed times stay open as one row`.

### Task 2: Done closes the earlier open times

**Files:**
- Modify: `src/services/native-reminders/actions.ts` (`applyReminderAction` both Done branches, `afterDone`/`afterOwnDone` gain a no-note mode, a new `closeEarlierOpen` helper, the result type gains `closedEarlier`)
- Modify: `app/api/calendar/reminder/route.ts` (the answer carries the closed occurrences' item keys) and the client that applies the answer (`app/[locale]/(app)/dashboard/CalendarHome.tsx` / `src/lib/calendar-view/store.ts`: mark each closed key done in the days and the carry-overs, the same patch a Done applies)
- Modify: `src/services/native-reminders/callbacks.ts` only if its answer handling needs the new field (the ping's own message edit is unchanged)
- Test: `scripts/smoke-reminder-actions.ts`, the store's smoke (`grep -l "carryOvers" scripts/*.ts`)

**Interfaces — Produces:** `ReminderActionResult` `ok` for a Done gains `closedEarlier?: Date[]` (the original starts it closed, oldest first; absent when none).

- [ ] **Step 1: Failing checks** in `smoke-reminder-actions.ts` (it fakes Prisma the way the file already does): weekly series, Mon and Thu undone, Done on Thu → Mon's state `doneAt` set by the actor, `closedEarlier` = [Mon]; one "Done by" note only (for Thu); Mon's live ping message edited to done (no buttons), no note for it; Done on Mon (from its old ping) → closes only Mon and earlier, Thu stays open; a not-yet-due earlier occurrence is never closed; Done on a one-off → no `closedEarlier`; `already_done` → no cascade; each marks their own → the actor's own ping rows get `doneAt` for the earlier ones, the shared `doneAt` only where every counted person is done; Undo of Thu after the cascade → Thu open, Mon still done; the armed bound is respected; the activity event fires once with `closed_earlier: n`. In the store's smoke: an answer with closed keys marks those items done in the days and the carry-overs.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** After the pressed Done succeeds on a repeating series: find the earlier open occurrences for the actor (expand from the later of the armed bound and the actor's latest done occurrence before the pressed one, exclusive, to the pressed one's original start, exclusive; keep those due before `now` and not done for the actor); mark each with the same write the pressed one got (shared: create the state row if missing with `createMany … skipDuplicates`, then the conditional `updateMany` on `doneAt: null`; each marks their own: `markOwnDone` with the same `counted`); then edit their live pings as a Done would, without notes, after the action has answered (not awaited; each failure logged and captured). Log one line `[NativeReminders] series <id>: Done also closed <n> earlier` when n > 0. The route maps `closedEarlier` to the item keys the home uses (the same key builder as the DTO) and the client patches them like the pressed one.
- [ ] **Step 4: Run** the smokes, then the gates — PASS. Commit `feat(reminders): Done also closes a repeating reminder's earlier open times`.

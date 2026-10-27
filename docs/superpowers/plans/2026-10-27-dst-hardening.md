# Summer/winter time hardening, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the clock change never moves a reminder, event, alert or summary off its local wall time, whatever zone the server process runs in.

**Background:** the owner asked (2026-10-27) to check that reminders and events are not influenced by summer/winter time. A probe-based audit ran the real code under process TZ=UTC and TZ=Asia/Jerusalem around 2026-03-27 and 2026-10-25 (Israel), 2026-11-01 (New York) and Moscow as a control, and each finding was then checked by a skeptic.
- **Holds** (55 checks): recurring events, reminders, event and pickup alerts, Google read/copy, summaries and day ranges all keep local wall time on the UTC server.
- **10 confirmed findings, in 5 groups,** all minor. They are in `<S>/dst-audit.json`, with the probes under `.superpowers/dst-probes/` in the main checkout.

`<S>` = /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad

## Global Constraints
- One code path: a single helper turns a local wall time into an instant. Every caller uses it.
- Behaviour must be the same under any process TZ. Prove it by running every new check under TZ=UTC, Asia/Jerusalem and America/New_York.
- No behaviour change outside the gap hour, the repeated hour and the items listed. Existing smokes stay green unchanged, except where a check pinned the old gap behaviour; such a check is updated and named.
- Out of scope, ruled on:
  - timed events that span the change keep their exact length (commit 445d4ae chose that);
  - housekeeping crons (health, purge) stay on UTC hours.
- No data migration. The audit found no wrong stored rows that need fixing. Rows created inside a past gap hour are indistinguishable from intended ones, so they are left alone.
- Gate: `npx prisma generate && npx tsc --noEmit && npx eslint . && bash scripts/ci-smokes.sh && npx tsx scripts/check-i18n-parity.ts`. Never run a build.

## Review Focus
1. **A nonexistent local time:**
   - 02:30 on Israel 2026-03-27 → 03:30 local (as the walltime.ts comment promises and Google does);
   - New York 2026-03-08 02:30 → 03:30;
   - London 2026-03-29 01:30 → 02:30.
2. **An ambiguous local time** (01:30 on Israel 2026-10-25) → the first occurrence (IDT, 22:30Z), in every process TZ. Editing an item without touching its time never moves it (the round-trip guard).
3. **`tomorrowMorning` with reminderTime 02:30** tapped at 01:50 on the gap day → that day's 03:30, not the next day.
4. **A summary preferred at 02:00** on the gap day → sent once at 03:00. Every other hour and day is unchanged.
5. **Event alerts under process TZ=Asia/Jerusalem** in the repeated hour → none missed. The same for the other local-field setters.

---

### Task 1: One wall-time resolver, used everywhere
**Files:**
- `src/services/calendar-write/walltime.ts`: the helper. Its comment states the rule.
- The callers, routed through it:
  - `wallToInstant` / `dayEnd` (walltime.ts);
  - `morningOf` (`src/services/native-reminders/due.ts`);
  - `src/services/native-reminders/resolve.ts`;
  - `fromFloating` and the direct `fromZonedTime` calls in `src/services/native-calendar/recurrence.ts` (about lines 500, 965, 1096, 1109);
  - `src/utils/day-events.ts`;
  - `src/services/calendar.ts` (about 549);
  - `src/services/calendar-move/mapper.ts` (about 106, 316);
  - `src/services/voice/event-resolution.ts` (about 619-620);
  - any other `fromZonedTime` on a wall time (grep).
- The round-trip guard, in `src/services/calendar-write/write.ts` (`updateItem`, about 303/348) and `google-item.ts` (about 364/408): when the start wall string equals `instantToWall(stored startsAt)`, keep the stored instant.
- New `scripts/smoke-dst.ts`.

**Rule** (host-independent; do not rely on date-fns-tz's own ambiguity choice, which depends on the host zone):
- `wallTimeToInstant(wall: 'yyyy-MM-ddTHH:mm[:ss]', zone)` returns the instant whose local time in `zone` equals `wall`.
- If there are two, return the earlier one (the first occurrence).
- If there is none (a gap), return the instant of `wall + gap length` (for example 02:30 → 03:30).
- Compute it from the zone's offsets just before and after the candidate (for example with date-fns-tz `getTimezoneOffset(zone, instant)`, which does not depend on the host), and verify by round-trip.

- [ ] **Step 1: Write `scripts/smoke-dst.ts`.** It runs the real functions (stubbed DB, as the existing reminder smokes do).
  - The helper on gap, ambiguous and normal times for IL, NY, London, Moscow and UTC.
  - `reminderDueAt`, `dueAtForOccurrence` and `tomorrowMorning` across the IL gap.
  - A weekly 18:00 series from 2026-03-01, expanded across both 2026 changes, stays 18:00 local.
  - A one-off created at 02:30 on the gap day is stored at 03:30.
  - An item edited without its time changing keeps its instant on the ambiguous day.
  - **Every case runs under process TZ=UTC, Asia/Jerusalem and America/New_York.** The smoke re-spawns itself with each TZ, or the CI script runs it three times; choose one and document it.
- [ ] **Step 2: Run.** Expected: FAIL on the gap and host-TZ cases.
- [ ] **Step 3: Implement** the helper and route every caller through it. Fix the misleading comment.
- [ ] **Step 4: Run** the new smoke, every reminder, recurrence, calendar, Google-sync and voice smoke, and the full gate. Expected: PASS. Name any check that pinned the old gap behaviour, and update it with the reason.
- [ ] **Step 5: Mutations:**
  - the helper falls back to `fromZonedTime` (the gap and ambiguity cases fail);
  - one caller bypasses the helper (its case fails);
  - the round-trip guard is removed.
- [ ] **Step 6: Commit** `fix(time): one wall-time resolver for every path: a skipped hour moves forward, a repeated one takes the first, the same on any server zone`.

### Task 2: Host-independent "now", the summary gap hour, the setup-reminder hour
**Files:**
- `src/services/reminders.ts:150`: `const now = new Date(Math.floor(Date.now() / 60_000) * 60_000)`.
- **Class audit** of local-field setters on Date in `src/` and `app/api/`: `setSeconds`, `setMinutes`, `setHours` and `setDate` without `UTC`. Known sites:
  - `src/services/subscription-reminders.ts:79`;
  - `src/services/telegram/summary.ts:819/837`;
  - `src/services/voice/event-resolution.ts:202-203`;
  - `src/services/telegram/commands.ts:706`;
  - `src/cron/handlers.ts:448`;
  - `app/api/feedback/route.ts:69`.
  
  Make each one host-independent: epoch arithmetic, a `*UTC` setter, or the zone helper, whichever matches its meaning. List each site with its ruling in the commit body.
- `src/lib/summary-scheduling.ts` `filterUsersForSummary`: when the user's preferred hour does not exist on today's local date, the effective hour is the first hour after the gap. The local-date dedup key still prevents a double send. This applies to daily and tomorrow alike.
- `src/cron/scheduler.ts`: the setup-reminders job gets `{ timezone: DEFAULT_TIMEZONE }` (or the constant the repo uses for Israel), so it runs at a stable local hour. Its comment says which hour. Health and purge stay on UTC.
- `instrumentation.ts`: one startup log line with the process zone and whether it observes DST, as an info line, so prod logs show it.
- Test: extend `scripts/smoke-dst.ts`.

- [ ] **Step 1: Add the checks:**
  - **alerts:** a 5-minute run at 23:30:30Z on 2026-10-24 under TZ=Asia/Jerusalem finds the alerts due in the second 01:xx hour (the audit's probe cases);
  - **every setter site:** each one under all three process zones gives the same result;
  - **summaries:**
    - preferred hour 2 on IL 2026-03-27: sent at 03:00, once;
    - hour 2 on 2026-03-28: sent at 02:00;
    - hour 7 on both change days: sent once;
    - New York 2026-03-08 hour 2: sent at 03:00;
  - **setup reminders:** scheduled with the zone option.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the full gate. Expected: PASS.
- [ ] **Step 5: Mutations:**
  - put back `setSeconds(0,0)`;
  - drop the summary gap rule;
  - drop the zone option.
- [ ] **Step 6: Commit** `fix(time): "now" and dates that do not depend on the server's zone; a summary hour skipped by the clock change goes out at the next hour; setup reminders at a stable Israel hour`.

## After the build (controller)
- One Opus review.
- One fix round.
- Mutation spot checks.
- The CI mirror.
- Push.
- Delete this plan file.
- Report to the owner, folded into the end-of-work notification.

# FamCal → Google sync — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A user can copy each FamCal calendar they own into its own "FamCal · <name>" Google calendar, kept up to date one way.

**Architecture:**
- **The outbox.** A DB outbox (`GoogleSyncLink`, `GoogleSyncItem`) is marked from every FamCal writer in the write's own transaction.
- **The worker.** A gated per-minute cron worker converges each dirty series to its Google form with the cross-source move's mapper. It uses deterministic event ids, so retries are safe.
- **Permissions.** `calendar.app.created` is requested incrementally, and only for calendar-level calls.

**Tech stack:** Prisma (migrations auto-applied on deploy), Upstash Redis (fail-closed NX lock), node-cron (src/cron), `@googleapis/calendar` 9.8, next-intl.

**Spec:** docs/superpowers/specs/2026-10-20-google-sync-design.md is the authority; section numbers below refer to it. The reviews are in the session scratchpad next/review-sync-code-api.md and in the run log. **Prerequisite:** the Google connection plan is on main, G4 included (mapper.ts, `createNativeSeries`, the split providers).

## Global constraints
- **One code path.** Every writer marks through one helper, `markSyncDirty(tx, seriesIds | calendarId)`. The worker uses the move's mapper, never a second converter.
- **No silent failures.** Every catch logs ids (never titles) and goes through `captureError`. No artificial timeouts: rely on Google's own failures plus real backoff.
- **Fail-closed lock.** The lock has its own key prefix, `set nx ex 600`, is renewed per item and released in finally. A Redis error skips the user's run.
- **Copy.** No inline user-facing strings: messages/{en,he,ru}.json with matching keys. Hebrew is gender-neutral; Russian uses the formal вы.
- **Migrations** are hand-written under prisma/migrations/<YYYYMMDD000000>_google_sync/. Never run prisma migrate or db push.
- **Tests never reach Google, Telegram or the DB.**

## Review focus
1. A write landing during a push is never lost (`dirtySeq`).
2. A retry never makes a second event or a second calendar (deterministic ids; the 'creating' adopt).
3. A copy never shows back in FamCal: reads, select-calendars, the editor, the LLM list.
4. A partner's data reaches only the calendar owner's Google, and only for calendars the owner owns.
5. Rate limits and outages pause; they never burn attempts or flood Sentry.

---

### Task S1: Schema, plan feature, dirty marks and the gate (§2)

**Files:**
- `prisma/schema.prisma`, plus the migration
- `src/config/plans.ts` and `src/services/subscription-service.ts` (feature `googleSync`)
- `src/services/native-calendar/event-store.ts` (every write; wrap the non-transactional ones)
- `src/services/calendar-move/*` (`createNativeSeries`)
- `app/api/native-calendars/[id]/route.ts` (PATCH rename marks the link; DELETE asks Remove/Keep through a body flag)
- `src/services/account-linking.ts`, `src/services/user-moderation.ts` (turn links off and queue the Google calendar's removal)
- a new `src/services/google-sync/{marks.ts,gate.ts}`
- Tests: a new `scripts/smoke-google-sync.ts` (marks part)

- [ ] Write failing checks:
  - each writer sets `dirtySeq + 1` in its own transaction, including the merge and hard delete;
  - a mark opens the gate;
  - a reminder or a non-owned calendar is never marked;
  - the plan feature's access per tier.
- [ ] Migration and schema:
  - `GoogleSyncLink` and `GoogleSyncItem` exactly as spec §2, with FKs as stated (link → User cascade, link → NativeCalendar SetNull, item → link cascade, no FK to NativeEvent);
  - `User.googleScopes String[] @default([])`;
  - `User.googleSyncNotifiedAt DateTime?`.
- [ ] Add `markSyncDirty` and the gate (globalThis, modelled on src/services/native-reminders/due-gate.ts, 60-minute ceiling), and call them from every writer.
- [ ] Run the new smoke's marks part, editor-api, every `smoke-native-*`, account-merge, the moderation smokes, tsc and lint. Commit.

### Task S2: OAuth and the read filters (§2 Markers, §3 permission)

**Files:**
- `app/api/oauth/start/route.ts` (`include_granted_scopes`, `purpose`, `nativeCalendarId` in the state, the extra scope on purpose 'sync')
- `app/oauth-callback/page.tsx`
- `src/services/google-connect.ts` (scopes in the pending entry, written at commit; a sync-purpose commit creates the link; reset links to 'ok')
- `src/services/calendar-read/{google.ts,google-map.ts}` (mask and filter)
- `src/services/calendar.ts` (`fetchEventsInRange` filter; `listUserCalendars` drops linked ids)
- `app/api/select-calendars/route.ts`
- `app/[locale]/privacy/page.tsx`
- Tests: the sync smoke (OAuth part), calendar-read-google*, page-auth, the connection smoke

- [ ] Write failing checks from spec §6's OAuth line, plus the read filter across home, digest, voice matching and legacy alerts, and `listUserCalendars` hiding copy calendars.
- [ ] Implement them. Get the token's account `sub` from the id token or the userinfo the exchange already returns, and store it on links. Check what the callback receives first; don't add a scope just for it.
- [ ] Run the task's smokes, tsc and lint. Commit.

### Task S3: The worker (§3 calendars, §4)

**Files:**
- `src/services/google-sync/{worker.ts,push.ts,calendars.ts,hebrew.ts}`
- `src/cron/scheduler.ts` and `src/cron/handlers.ts` (`handleGoogleSync`, the same pattern as handleNativeReminders: globalThis running flag, admin alert)
- `src/lib/cron-handler.ts` (manual trigger)
- Tests: the sync smoke (worker part)

- [ ] Write failing checks from spec §6's worker list. Watch them fail.
- [ ] Calendars:
  - create, with 'creating', the token in the description, the bidi-isolated name with de-duplication, the zone, and `defaultReminders: []`;
  - adopt on retry;
  - rename;
  - Remove, both forms;
  - Keep;
  - re-enable;
  - recreate.
- [ ] Push:
  - the deterministic id (base32hex of sha256(`linkId:seriesId:generation`), 26+ chars, a–v and 0–9) with 409 adopt;
  - the structural vs patch branches with instance replay and slot hashes;
  - deletes with 404/410 counted as done;
  - the owner re-check;
  - unsupported items;
  - the Hebrew RDATE horizon;
  - `reminders: { useDefault: false, overrides: [] }`.
- [ ] Failures:
  - 404 → `calendars.get` split;
  - second 404 → error;
  - backoff with jitter;
  - rate-limit pause;
  - token, scopes and otherAccount states with one message per outage;
  - plan and suspended skips;
  - the admin alert after 10 attempts, deduplicated per link per day.
- [ ] Pace: 3 users at a time, the lock with TTL and renew, 100 calls per user per run, serial calendar creation. Backfill with progress counts.
- [ ] Run the sync smoke, the cron smokes, tsc and lint. Commit per step.

### Task S4: Routes, the calendars page and copy (§1, §5)

**Files:**
- `app/api/google-sync/route.ts` (new: GET states per own calendar; POST enable, which starts consent when the scope is missing; DELETE disable with Remove/Keep; POST recreate)
- `app/[locale]/calendars/CalendarsClient.tsx` (or wherever the FamCal calendars page lives; find by grep)
- `messages/*.json`
- Tests: render or page smokes for the calendars page (follow the existing page smoke style), and the sync smoke's route part

- [ ] Write failing checks:
  - each state's row;
  - the non-owner line;
  - progress;
  - "N can't be copied";
  - the unlink question;
  - enable without the scope going to consent with purpose 'sync';
  - en/he/ru;
  - the CSS rules.
- [ ] Implement the route (verifyUserAuth, a rate limiter, the plan gate, ids only from the user's own calendars) and the rows, using the existing page's tokens and patterns. Write the copy.
- [ ] Run the task's smokes, page-auth, parity, tsc and lint. Commit.

### Task S5: Finish
- [ ] Update the spec's status and Known limitations to match what shipped. Give the owner the exact console steps (spec §3) in the summary. Commit.

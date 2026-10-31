# Event alerts gate: an idle 5-minute pass reads no database (design, 2026-10-31)

**Owner, 2026-10-31:** Neon emailed that FamCal had used 80.4 of its 100 free compute-hours; at 100% Neon suspends the database until the next period, so FamCal would be down. The owner chose "Neon 1" (fix the code, stay on the free plan) and "don't wait for me on neon approval. proceed. it is urgent". Both extra wakers below (the :00 ceiling and the feature-access expiry) are included.

**Cause:** the every-5-minutes event-alerts pass reads the database for every cached user on every run since 2026-10-20 (04eff976, b0433631), undoing 86fb7b82 (Feb 2026, Redis-only for Neon auto-suspend). Neon suspends only after 5 minutes with no query, so it never slept (~6 CU-hours a day at 0.25 CU).


## Where the reads are today (per cached user, every 5 minutes)
handleReminders (handlers.ts:181) reads Redis only, then processUserReminders → getDueReminders (reminders.ts):
- `hasUsableCalendar` → `getCalendarAssignmentsForUser` → `listVisibleCalendars` (pairing.findUnique + nativeCalendar.findMany, + user.findMany for an unnamed partner calendar), and on 0 calendars a lazy `ensurePrimaryNativeCalendar` (a write).
- `getCalendarAssignmentsForUser` again (same 2-3 queries, a second time).
- `fetchEventsInRange` FamCal half → `fetchViewerItems`: loadViewerContext (pairing), fetchEventsInCalendars, and fetchRemindersForUserInRange when paired.
- So roughly 6-9 queries per user per pass, for every user: since 04eff976 every user has FamCal (the union list), and b0433631 sent every user through the split fetch. 86fb7b82's Redis-only pass held only for Google users, whose list came from the cached `calendarAssignments`.
- Already DB-free in the pass: the global switch (Redis, no TTL), the cache entry, the Google half (Google API plus the cached token and choices: `liveGoogleChoices` is pure), the timezone (Redis `tz:user`; a miss goes to the network, not the DB), and `isPaused` (the cached place).
- Still reaches the DB from this pass: `checkFeatureAccess` on a miss of its 24h key (see Other wakers); `incrementUsage` and `trackActivityAsync` only when an alert is actually sent.

## Approach A: what the pass needs from the DB goes into Redis
Per user, put the FamCal calendar list (own and the partner's shared, with viewer-side labels) and the upcoming FamCal alert times (the next ~65 min) into the `reminders:users:v2` entry or a sibling key. The hourly rebuild fills it, and every write recomputes the entries of the users it touches (the owner, plus the partner for a shared calendar or a pairing).
- Pro: survives restarts and a second replica; the pass is pure Redis.
- Con: a second copy of the event store's view logic (recurrence, overrides, partner visibility, "for the partner" reminders). Every write must know which users it affects and recompute them, and a missed recompute means a missed alert. More Redis traffic, and the entry gets large.

## Approach B: an in-process FamCal alerts gate, like the native reminders' due gate (RECOMMENDED)
While the gate is closed the pass skips the FamCal half for everyone: no store reads, Google still read every pass. When the gate is open, the pass runs exactly as today and computes when the next FamCal alert is due. Any FamCal write opens the gate: one global flag, so a write never has to know which users it affects.
- Pro: the DB stays the source of truth (every FamCal send follows a fresh read in the same pass), it mirrors two proven gates, and the change is small.
- Con: the gate is per process (Railway runs one instance; a second replica would need it in Redis, the same caveat as the other two gates). It depends on every adding write opening the gate; a new smoke enforces that.

## Spec (B)

### 1. One gate mechanism
New `src/utils/pass-gate.ts`, holding exactly the logic of `due-gate.ts`/`gate.ts` today:
- `createPassGate(globalKey)` returns `{ open(), shouldRun(now), setNext(next, now), reset() }`.
- State lives on `globalThis[globalKey]`: `{ nextAt, writtenSinceGate }`.
- `due-gate.ts` and `google-sync/gate.ts` become thin wrappers over it. Their export names stay, so no call site or smoke changes.
- The ceiling becomes `nextTopOfHourUtc(now)` (the first :00 after now) instead of now+1h, for all three gates (Decision 2).

New `src/services/event-alerts-gate.ts` = `createPassGate('__eventAlertsGate')`:
- `openEventAlertsGate()`
- `shouldReadFamcal(now)`
- `setNextFamcalAlert(next, now, token)`: `next` is the earliest FamCal alert time minus the window, plus 1 ms, so the tick whose window holds it opens. (Review I1: without the 1 ms, the tick at exactly alert − window, whose window [alert − 5, alert) misses the alert, opened too and read for nothing, about 5 extra awake minutes per alert.)
- `__resetEventAlertsGateForTests()`

Only the latest open pass may close the gate: it keeps a start token on `globalThis.__eventAlertsCron`, the way handleNativeReminders uses startedAt.

### 2. The pass (one code path: scheduler and the manual route)
In `handlers.ts handleReminders`:
- `famcal = shouldReadFamcal(tick)`, taken once per pass.
- Each user goes through `processUserReminders(user, window, { famcal })`, which returns `{ sent, nextFamcalAt, famcalFailed }`.
- After the loop, only if `famcal` and no user holds the gate (below) and `cachedUsers.length > 0`: `setNextFamcalAlert(min nextFamcalAt − window + 1 ms, tick, token)`.
- No users cached, a failed FamCal read (the calendars or the FamCal half), or a user who threw: the gate stays open, so the next tick reads again. The failure is already logged and captured (`reminders-calendars-read`, `calendar-provider-fetch`, `cron-reminders-process-user`). When the gate is held for that reason, also send `captureError('event-alerts-gate-held', …, 'warning')`, at most once an hour.
- A user who keeps failing does not hold the gate forever (review I2): their first failure starts a clock on `globalThis.__eventAlertsCron`, their next clean read clears it, and after 15 minutes they stop holding when another user's FamCal read succeeded in the same pass (`event-alerts-gate-hold-dropped`, at most once an hour). No failure holds it for more than an hour, also when every read fails (fix round 2: prod may have a single cached user, failing for any cause): after that a failing pass closes the gate to the usual ceiling, so the next :00 pass retries. An outage then costs one read an hour, alerts are back within the hour after it, and any write still opens the gate at once. The held warning says when it stops holding (`stopsHoldingAt`).
- The gate is taken before the cached users are read (review M1), so a cache write in between opens it for the next pass.
- On an open pass, a failed calendar read (`getCalendarAssignmentsForUser`) is caught: captured, the FamCal half counts as failed, and the user's Google alerts still go out (review M8).

In `reminders.ts getDueReminders`:
- Open: as today, `hasUsableCalendar` then the union list (reuse the list from hasUsableCalendar instead of reading it twice), and the fetch range end extended to `windowEnd + MAX_LEAD + (nextTopOfHour - now)`.
- Closed: the calendars are `liveGoogleChoices(user)` (no DB), and the fetch goes to the Google ids only. With no Google ids there is no fetch at all.
- Pull the per-event loop into `alertCandidates(event, user, assignments)` → `[{ type, reminderTime, eventTime, isAuto }]`. It is the existing filters unchanged: reminder kind, all-day, None, the lead from `getReminderMinutes`, `isSendable`, kids+pickup switch. It feeds both the in-window due list and `nextFamcalAt` (the earliest candidate ≥ windowEnd on a `native:` calendar). One code path.
- `processUserReminders`: the access check and the downgrade notice come first, as today (Redis); a user without access adds nothing to `nextFamcalAt`. `isPaused` stays per send, unchanged.

### 3. What opens the gate (after commit)
1. `event-store.ts`: `createNativeEvent`, `createNativeSeries`, `updateNativeEvent`, `deleteNativeEvent` open it at their end, for both kinds (harmless for reminders). Every FamCal event writer goes through these, calendar-move included.
2. `app/api/native-calendars/[id]/route.ts` PATCH: a kids label adds pickups; privacy shared shows the partner's events.
3. `pairing-service.ts acceptInvite` and `unlink`, for uniformity: the pass reads the pairing from the reminder cache, so it sees a new one at the next hourly sync, which opens the gate itself (item 5).
4. `account-linking.ts afterMerge`, next to invalidateDueGate and openSyncGate.
5. `reminder-cache.ts updateUserInCache`: covers the settings saves (default minutes, pickup switch, alerts on), OAuth, select-calendars and the merge.
   `syncReminderCache` opens only when an entry was added, or its `(id, pairingId, defaultReminderMinutes, pickupRemindersEnabled)` changed against the previous cache. This covers a pairing, an unsuspend or a reachable-again user that reaches the cache only through the hourly rebuild, without forcing a :05 read every hour.
6. `subscription-service.ts invalidateFeatureAccessCache` / `invalidateAllFeatureAccessCaches`: a plan regained, early adoption.
7. `app/api/reminders/route.ts` opens it before its run, as app/api/native-reminders does.

Deletes need no hook for correctness: a send only follows a fresh read. They open the gate anyway.

### 4. Cross-bundle, deploy, failure
- State on `globalThis.__eventAlertsGate`: route writes, in the route bundles, wake the scheduler bundle.
- A fresh process starts open (nextAt = 0). The first pass after a deploy reads FamCal, together with bootReminderCache's own DB read, then closes until the next due alert or :00.
- A pass that started before the boot rebuild finished sees no users and stays open.
- A write during an open pass sets writtenSinceGate, so that pass cannot close over it.

## Tests
Existing smokes on this path:
- smoke-reminders.ts: the real handlers, cache, settings route and alerts, with event-store reads faked.
- smoke-native-provider-reminders.ts and smoke-partner-labels.ts: the store and labels.
- smoke-calendar-range.ts: the split fetch.
- smoke-event-alerts.ts: leads.
- smoke-pause.ts and smoke-pause-subscription.ts: the pause, the downgrade notice.
- smoke-native-reminders.ts and smoke-reminder-actions.ts: the due gate.
- smoke-google-sync.ts and smoke-google-sync-worker.ts: the sync gate.
- smoke-dst.ts: stubs the handlers.
- smoke-key-sweep.ts: the rebuild.

New in smoke-reminders.ts (FAILS today):
- Wrap `fakePrisma` in a recording Proxy, and count the faked store reads (listVisibleCalendars, fetchEventsInCalendars, fetchReminderStates, loadViewerContext).
- Setup: two users cached (one FamCal-only, one with Google), feature access and tz cached, and the next FamCal alert at 13:20.
- The 12:00 pass may read. The 12:05 … 12:55 passes make ZERO Prisma or store calls. Google is still asked each pass, and a Google alert at 12:30 is still sent.
- Today, listVisibleCalendars is counted on every pass.

Also:
- createNativeEvent at 12:07 for an event at 12:20, lead 10 → sent by the 12:10 pass.
- Moved earlier → sent at the new time. Deleted → never sent.
- The partner creates on a shared calendar → the viewer is alerted.
- The settings route changes the default minutes or turns pickups on → the new time is honoured.
- The plan is regained (invalidateFeatureAccessCache) → alerts resume.
- A failed FamCal half leaves the gate open, captured. The next pass reads.
- A fresh `__resetEventAlertsGateForTests()` reads at once.

Also:
- New `scripts/smoke-alerts-gate-writers.ts`, modelled on smoke-pause's tables. It scans src/ and app/ for writes to `nativeEvent|nativeEventInstance|nativeCalendar|pairing` (and callers of the four store writes), and fails on any file not in `OPENS` or `NO_NEW_ALERT` with a reason:
  - NO_NEW_ALERT: native-calendars POST (empty calendar), onboarding (empty main), kid-name-callbacks (name and rules), primary.ts (the primary label), user-moderation (removal), google-sync worker (marks).
- pass-gate unit checks: the :00 ceiling, writtenSinceGate, a stale token can't close.

## Neon after the fix (free plan: suspends after 5 min idle; 0.25 CU minimum)
- Baseline: the hourly :00 jobs (the summaries, rebuildReminderCache every hour, setup reminders at 10:00 Israel, health 03:00, purge 03:30). About 5-6 min awake per hour ≈ 2.2 h/day ≈ 0.55 CU-h/day ≈ 17 CU-h/month.
- Plus about 5 min (≈0.02 CU-h) for each FamCal alert, native reminder ping or Google alert send (incrementUsage) not within 5 min of another wake. Plus real user activity.
- Plausibly 0.7-1.2 CU-h/day ≈ 20-35 CU-h/month, against ~6 CU-h/day (180/month) now.

## Other wakers (both fixes included: owner said proceed)
1. The native reminders and Copy to Google gate ceilings are now+1h from the last read. After any off-hour read (a write at 12:37), each gate then reads at :37 every hour, indefinitely. That is up to 2 extra wakes/hour (≈ +4 h/day).
   Fix: the :00-aligned ceiling in pass-gate (Decision 2, recommended).
2. Feature access (24h TTL, `FEATURE_ACCESS_CACHE_TTL`): the alerts pass recomputes it from the DB whenever a user's key expires, at arbitrary minutes, once per user per day.
   Fix: write the key with a TTL ending at hh:59 between 23 and 24 h ahead, so the recompute lands on the :00 pass (Decision 3, recommended).
3. Key sweep (*/10): one read about 10 min after each deploy, then idle. Fine.
   The `tz:user` refresh is network only. The global switch's Redis key has no TTL.

## Stale text to fix with the change
- handlers.ts:178 "Reads from Redis cache (zero DB queries)".
- reminder-cache.ts header "Eliminates DB queries from 5-minute reminder cron" (true again only with the gate).
- The scheduler's `*/5` comment and its registered-jobs log line (add "gated").
- The "Railway runs one instance" caveat goes into the new gate's header too.
- MEMORY "Schedules" says nothing about the alerts gate; add it.

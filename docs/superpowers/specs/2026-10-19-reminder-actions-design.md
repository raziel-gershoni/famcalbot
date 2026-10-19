# Done, undo and snooze in the calendar home

Status: designed 2026-10-19 under the owner's delegation ("go with it … proceed fast, don't pause"). Roadmap step 2 of the calendar UI (`project_native_calendar_roadmap`). It builds on the native-reminders spec (2026-10-14) §5 and the calendar-home spec (2026-10-16) §7.5, whose item sheet was view-only.

## 1. What changes for people

Opening a FamCal reminder in the home (an Agenda row, a "Still open" row or a picked day's row) shows actions under its state line:

| The occurrence is | Actions |
|---|---|
| Not done, due or past due ("Not done yet"), or snoozed | **Done** (primary). **Snooze:** 15 min · 1 hour · Tomorrow |
| Not done, not due yet ("Not due yet") | **Done** (doing it early; it then never pings) |
| Done | **Not done** (undo) |

- Events, Google items and reminders the viewer may not act on show no actions. The sheet stays as it is today.
- Who may act is the ping buttons' rule (native-reminders spec §5): the effective owner (the person it is for) or the creator. A partner who neither created it nor is its target sees it but gets no actions.
- After a tap the sheet shows the new state at once: the check and struck title, "Snoozed until 14:30", or back to "Not done yet". The rows, the "Still open" card, the Month's chips and dots and the counts follow. The sheet stays open, so a mis-tap can be undone right there.
- A tap that can no longer apply shows a short note in the sheet and refreshes the home:
  - the reminder was changed or deleted: "This reminder changed. The calendar is up to date now.";
  - someone else marked it done: "Already done";
  - access was lost: "This reminder isn't yours anymore".
- Busy (429), offline or a server error: "Couldn't save. Try again." The state is unchanged.

## 2. Behaviour behind it (server)

One service, used by the ping callbacks and the new route: `applyReminderAction(actor, { seriesEventId, originalStartsAt }, action, now)` in `src/services/native-reminders/actions.ts`. The action is `done`, `undo`, `snooze15`, `snooze60` or `snoozeTomorrow`.

1. **Load and check the occurrence.** Load the series, its calendar, its creator and its instances. The occurrence must still be live: not deleted, still a reminder, not cancelled, and its key still in `expandSeries` (as `liveOccurrenceTitle` checks). Otherwise the answer is `changed`.
2. **Permission.** `actor.id` must be `effectiveOwnerId(series, creatorPartner)` or `series.creatorUserId`. Otherwise the answer is `not_yours`.
3. **Write,** conditionally, on the unique `(seriesEventId, originalStartsAt)`. The row is upserted, because an occurrence never pinged has no row.
   - `done`: `doneAt = now`, `doneByUserId = actor.id`, only where `doneAt` is null. Already done gives `already_done`.
   - `undo`: `doneAt = null`, `doneByUserId = null`, and `snoozedUntil` cleared, only where `doneAt` is set. Not done gives `not_done`, which the client treats as success: the state is already what was asked.
     - An occurrence that was pinged keeps `lastPingedAt`, so undo doesn't re-ping it. It shows as open in the home and in the digests, which is what undo is for.
   - `snooze*`: `snoozedUntil = now + 15 min`, `now + 60 min`, or `tomorrowMorning(now, actor's tz)`; `pingAttempts = 0`; only where `doneAt` is null. Done gives `already_done`.
     - A never-pinged occurrence whose upserted row has `lastPingedAt` null must be pinged at `snoozedUntil`. The plan verifies the pass does this (`pass.ts` snooze read, `due.ts isEligible`) and fixes it if not.
4. **After a write.** The callbacks' behaviour stays the same, and the route behaves the same way:
   - `invalidateDueGate()` after snooze and undo;
   - analytics: `native_reminder_done`, `native_reminder_snoozed` and, new, `native_reminder_undone`, with `{ series_event_id, source: 'ping' | 'app' }`;
   - the creator's done notice when the actor isn't the creator (Telegram only, R12);
   - **the live ping** (`pingChatId` / `pingMessageId` on the row): an in-app done edits it to "✅ title" with no buttons, and an in-app snooze to the callback's "💤 title · until HH:mm". Undo leaves it as it is. Telegram errors here are swallowed and never fail the action.
5. **Refactor, no behaviour change.** The callbacks call the same service. A ping tap resolves its state id to the key first, and the toast and ping edits stay in `callbacks.ts`. `smoke-native-reminder-buttons` must stay green unchanged, apart from the new `source` field.

## 3. The route

`POST /api/calendar/reminder`, body `{ user_id, initData?, seriesId, originalStart, action }`:
- Auth goes through `verifyUserAuth` with `requestInitData`. The rate limiter is new, `reminderActionRateLimiter`, 30 per minute per user.
- Validation:
  - `seriesId` is a cuid-shaped string;
  - `originalStart` is an ISO instant that parses exactly;
  - `action` is one of the five.
  - Anything else gets 400 `bad_request`.
- The route acts on `auth.user` only; the body never names whose reminder it is.
- `200 { status: 'ok' | 'already_done' | 'not_done' | 'changed' | 'not_yours', reminder? }`. `reminder` is the occurrence's new `ItemReminderDTO`, built by the DTO code the range route uses.
- Errors are `500 internal_error` with `captureError(…, 'calendar-reminder', { user_id })`. The context carries no titles. All answers are `Cache-Control: private, no-store`.
- Google items have no `seriesId` in this sense. The client never sends them, and the server refuses any series that isn't native (`changed`).

## 4. The client

- **Sheet buttons.** ItemSheet gets the actions as buttons under the state line:
  - Done is primary, a full-width `ch-btn-primary`.
  - Snooze is a row of three `ch-btn`s: 15 min, 1 hour, Tomorrow.
  - Undo is one `ch-btn`.
  - All are at least 44 px, with labels in the three languages.
  - While a request is in flight, the buttons are disabled and the tapped one shows a small spinner.
- **`deps.reminderAction`** is a new CalendarHome dependency, used for the fetch so the smokes can fake it. It sends the init-data header and the body like the other Mini App POSTs.
- **Instant update.** A new store action, `patchReminder({ key, reminder })`, updates the item wherever the store holds it: each day's items and `carryOvers`. It recomputes `open` with the store's rules: a done item isn't open, and a snoozed past-due one still is. Then `refetchVisible({ only: 'famcal' })` confirms it. On `changed` or `not_yours` it only refetches.
- **The open sheet** follows the store: CalendarHome keeps the selected item's key and re-derives the row on each render, not a snapshot (`CalendarHome.tsx:249`). An item that disappears closes the sheet after the note.
- **Telegram:** `HapticFeedback.notificationOccurred('success')` after a done, on clients that have it.

## 5. Copy (en; he and ru written naturally, Hebrew gender-neutral)

`calendarHome.sheet.actions.*`:
- `done` "Done"
- `undo` "Not done"
- `snoozeLabel` "Snooze"
- `snooze15` "15 min"
- `snooze60` "1 hour"
- `snoozeTomorrow` "Tomorrow"

`calendarHome.sheet.notes.*`:
- `changed` "This reminder changed. The calendar is up to date now."
- `alreadyDone` "Already done"
- `notYours` "This reminder isn't yours anymore"
- `failed` "Couldn't save. Try again."

## 6. Tests

- **`smoke-reminder-actions` (new):** the service over the matrix.
  - Who acts: owner, creator, ex-partner, stranger.
  - Occurrence: one-off, recurring, moved, exdated, cancelled, deleted series, deleted calendar.
  - State: never pinged (upsert), pinged, done, snoozed.
  - Each action. Also: the double done, undo of a not-done one, snooze after done, and the tomorrow math across the morning cutoff in Asia/Jerusalem.
  - The gate is invalidated, analytics carry `source`, the creator notice fires, and the ping edit is attempted and swallowed on a Telegram error.
  - A snoozed never-pinged occurrence is due at `snoozedUntil`.
- **The route, in the same smoke or a route smoke:**
  - auth outcomes, 400s and the rate limit;
  - acts on `auth.user` only;
  - `no-store`;
  - the `reminder` DTO matches the range route's for the same occurrence.
- **Render (`smoke-calendar-home-render`):**
  - the sheet's actions by state and by who views;
  - none on events, Google items or for a viewer who can't act;
  - a tap patches the store and the rows, the card and the Month marks follow;
  - the sheet re-derives;
  - the notes;
  - buttons disabled in flight;
  - 44 px, and no untranslated key in en, he or ru.
- **`smoke-native-reminder-buttons`:** unchanged and green.

## 7. Out of scope

Editing a reminder's title, time or repeats (roadmap step 3). Done from the digests (the native-reminders spec rules it out). WhatsApp pings (none exist).

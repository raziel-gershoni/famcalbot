# Adding, editing and deleting in the calendar home (first pass)

Status: built and live on main, 76f0360..4a9f622 (the API, the copy, the editor, the wiring), then the fix rounds eb420cf, 7ee7911, 42bfa49, 1d6f1be, fee8648, 8e4a3fd, 58c7d3d, 349ebe8 and 4a9f622, and the follow-ups 3972749, 539a648 and 56dd070. Designed 2026-10-19 under the owner's delegation ("go with it … proceed fast, don't pause"). Where the code differs from the design below, the text says how it shipped. Mockups: https://claude.ai/artifact/KJQjWZ7MFRRCr3A4raAQos, third row (Done, snooze and editing). This is roadmap step 3, first pass. Step 3b, later, covers changing how something repeats, moving an item to another calendar, and Google items.

## 1. Scope

**In:**
- Add, edit and delete **FamCal** events and reminders from the home.
- For a repeating item, the choice of which occurrences a change or a delete applies to.
- Repeats can be chosen when creating.

**Out (3b or later):**
- Changing a series' repeat rule, or moving an item to another calendar. The store can't do either today (`updateNativeEvent` edits only title, description, location, start, end and all-day).
- Changing a reminder's recipient.
- Editing Google items (they stay view-only). Google-source users' event creation, which the Google-connection spec decides.
- Alerts per event (`reminderMinutes` is unused).
- Drag to move.

## 2. What people see

**Add.**
- A "+" button in the home's header, beside Send and ⋯, opens the editor ("New").
- It is prefilled for the day in view:
  - the selected day in Month picked, at 09:00;
  - otherwise today, at the next round hour, lasting one hour.

  A picked day other than today starts at 09:00 (not the next round hour), also lasting one hour.
- An Event | Reminder switch heads the editor. It shows only when the user can create both: events need `calendarSource === 'NATIVE'`, reminders need the home's reminders hint. If only one kind applies, the editor opens on it with no switch. With neither, there is no "+".

**The editor (event):**
- Title (required) and location.
- All day.
- Starts: date and time. Ends: date and time.
  - Moving the start keeps the duration.
  - All day hides the times.
- Repeat: Never, Every day, Every week on <weekday>, Every month on the <n>th, Every year on <date>. A choice on create only.
- Calendar: the user's writable calendars, own and the partner's SHARED_EDITOR, each with its colour, defaulting to the main calendar. A choice on create only.
- Notes.
- A Save button in a sticky bottom bar, and Cancel in the header. Cancel asks to discard only when something changed.

**The editor (reminder):**
- Title.
- When: a date, plus "At a set time" with a time. With no time it arrives at 09:00, as the bot's date-only reminders do.
- Repeat, as for events.
- For: Me | <partner>. It shows only when the partner can receive reminders (active, FamCal, on Telegram, as `resolve.ts` rules), on create only.

**Edit.** A pencil in the item sheet's header opens the editor prefilled.
- What can't change in this pass is shown as text, not a control: "Repeats every Tuesday", "Family", "For Noa". The calendar's name is shown for events only; a reminder shows its repeat and its "For" line but no calendar.
- On Save, a repeating item asks "This event repeats. Save the change to:"
  - Only this one (Tue 20 Oct)
  - This one and the ones after
  - Every Tuesday, or "All of them" when there's no short name
- A series whose rule fixes its days (BYDAY, BYMONTHDAY, BYMONTH, BYYEARDAY or BYWEEKNO, as the bot's rules do) cannot move its days for more than one occurrence. When the change moves the start to another day, in the series' own zone, the sheet offers only "Only this one" and the note "To move all of them to another day, delete the series and create it again." A new time of day works for every scope.

**Delete.** "Delete event" or "Delete reminder" at the bottom of the item sheet asks the same three choices for a repeating item. For a single item it asks "Delete «title»?" with Delete and Cancel.

**Who may do what** follows the store's rules:
- edit or delete: the calendar's owner, or an editor of the partner's shared calendar;
- a reminder: its creator can edit it, and its creator or the person it's for can delete it.

A viewer who can't do anything sees no pencil and no Delete.

**After Save or Delete,** the editor closes and the home refreshes FamCal. The new or changed item shows, and the item sheet shows the changed item (or closes if it is gone). After an edit the sheet follows the item to its new key once the refetch brings it (a "this one and the ones after" edit, or an "all" edit that moves the day, makes a new key), and only the edit's own refetch may close it.

**Errors:**
- inline, under the field: "Add a title", "It ends before it starts";
- above Save: "You can't change this one", "This changed in the meantime — reopen it", "Couldn't save. Try again".

## 3. Server

**`GET /api/calendar/editor?user_id=`** is what the "+" needs:
- `{ kinds: { event, reminder } }`;
- `calendars: [{ id, name, color, main }]`, the writable ones;
- `partner: { name, canRemind } | null`;
- `tz`, which is the range's `resolveUserTimezone`.

**`GET /api/calendar/item?user_id=&key=`** is the edit info for one FamCal item. It is read live from the store; the DTO lacks the rule and the permissions:
- `{ kind, canEdit, canDelete }`;
- `occurrence: { start, end, allDay, title, location, description }`;
- `series: { recurring, start, repeat, fixedDays, zone }`: `repeat` is `{ freq, interval, byDay, ends }` or null, worded on the client; `fixedDays` is whether the rule names its days; `zone` is the series' own zone, where the store reads days;
- `tz`: the user's zone, which the wall times above are read in;
- `calendar: { id | null, name, color }`;
- `forName`;
- `scopes`: ['single'] or ['single', 'following', 'all'].

The client reads a day move in the series' zone (`movesDay`, from `tz` and `series.zone`), as the store does, not on the user's clock.

Unknown or not visible gives 404 `not_found`.

**`POST /api/calendar/items`** creates: `{ kind, title, location?, description?, allDay, start, end?, repeat?, calendarId?, forPartner? }`.
- Times are wall times in the user's tz, as `YYYY-MM-DDTHH:mm` (or `YYYY-MM-DD` for all-day). The server converts them with the user's zone.
- `repeat` is one of `none | daily | weekly | monthly | yearly`, built with `buildRecurrenceRule`, anchored on the start.
- Events go through `createNativeEvent` (with access checks).
- Reminders go through the bot's reminder create path (`resolve.ts` / the native-reminders create function). That keeps the main calendar, `forUserId`, `armedAt` and the due gate as the bot does them.

**`PATCH /api/calendar/items`** edits: `{ key, scope, changes: { title?, location?, description?, allDay?, start?, end? } }`.
- Events go through `updateNativeEvent`.
- A day move under `following` or `all` on a fixed-days rule answers 400 `invalid`, field `start`: the store throws `NativeFixedDaysError` before any write, so the bot is covered too (`FIXED_DAYS`).
- Reminders go through `updateNativeReminder`, then `stripMovedPings(clearedPings)`, as the bot does.

**`DELETE /api/calendar/items`** deletes: `{ key, scope }` through `deleteNativeEvent`.

**Every write:**
- goes through `verifyUserAuth` with a new 20-per-minute `calendarWriteRateLimiter`;
- validates on the server: title 1–200 characters after trim; location up to 200; notes up to 2,000; valid dates; a timed event's end after its start; all-day end on or after its start;
- calls `clearRecurrenceCacheForUser` for the user and for the partner when the calendar is shared;
- tracks analytics with `source: 'app'`: creates reuse the bot's `voice_event_created` (and `native_reminder_created` for a reminder); edits and deletes use the new `calendar_item_edited` and `calendar_item_deleted`, carrying `{ kind, scope, source }`, because the bot has no edit or delete names to reuse;
- returns 200 `{ status: 'ok', key? }`, or 403 `not_allowed`, 404 `not_found`, 409 `changed` (the occurrence is gone), 400 `invalid` with a field (or `bad_request` for a body that is not an object), 429 with the "Too many changes at once" copy, or 500.

Also enforced: years 2000 to 2100 and a span of at most 366 days. While a year is being typed, the end keeps the last real length.

**The bot's dialogs don't change, but the store beneath them does,** and so does what its scopes do (both Telegram's `handleEditCallback` and WhatsApp's `edit_confirm` go through `nativeProvider.updateEvent`, which passes `occurrenceTimes: true`):
- **"All of them" with new times.** The times are those of the occurrence the user was told about. The series moves as far as that occurrence moved, from where it is now, to its new time of day and length. It keeps its earlier occurrences: before 58c7d3d the new start became the series' start and the earlier ones were lost.
  - Exdates move on the wall clock (DST-aware) and are kept where the moved rule still yields them.
  - Overrides are re-keyed and lose their own times, keeping their title, description and location. Cancellations are re-keyed. Rows the moved rule never yields are deleted.
  - The UNTIL moves: a date-only one by days, a date-time one as wall time (Z or floating).
  - A reminder keeps its exdates and cancellations and drops every override; its state is cleared, so it pings again.
  - With the series' own start resent unchanged (the bot saying the time it already has), nothing is reset: an occurrence moved on its own stays moved (3972749). A new end or all-day flag resets the overrides' own times and keeps their titles and cancellations (7ee7911); a new start moves everything as above.
- **"This one and the ones after."** The new series starts on the date entered when the rule follows its start and the day changed; otherwise it starts on the cut slot's day at the new time. Exdates and overrides from the cut are carried, re-keyed and filtered by what the rule yields, and the UNTIL moves. An event's new series has the editor as its creator; a reminder keeps its creator.
- **Fixed days.** A day move under "all" or "following" on a rule with fixed days is refused before any write (`FIXED_DAYS`). A new time of day, and "only this one", are still allowed. Telegram answers at once, before the Confirm card, with `bot.voice.fixedDaysMove` ("To move all of them to another day, delete the series and create it again."; he impersonal, ru formal), by asking the store without writing (`refusesFixedDays`, `wouldRefuseFixedDays`). The Confirm callbacks keep the same reply for a card made before. WhatsApp has no card-making path for edits, so its `edit_confirm` reply (a free-form message, inside the 24 h window of the tap) is the only one it needs.

## 4. Client

- **New components:** `EditorSheet.tsx` (the editor) and `ScopeSheet.tsx` (the three choices). The item sheet gets the pencil and Delete when the edit info allows them. The edit info is fetched when the sheet opens, and the controls show once it arrives.
- **Form kit,** in the home's CSS (`ch-form-*`), to be lifted into F1 later:
  - grouped cards;
  - a text field;
  - a switch row (the whole row is the target, `role="switch"`);
  - a segmented control;
  - a value row with a native `<select>` over it;
  - date and time pills that are native `<input type="date|time">` styled as pills;
  - a radio pair;
  - a sticky Save bar.

  Every target is at least 44 px, with logical properties, no `:hover` and nothing under 11 px.
- **The editor** is a full-height BottomSheet variant (`full`): a header with Cancel and the title, a scrolling body, and the Save bar. Telegram's BackButton cancels.
- **After a write,** `refetchVisible({ only: 'famcal' })`. The open item sheet re-derives from the store by key (done/snooze adds this), and after an edit follows the item to its new key.

## 5. Copy

The `calendarHome.editor.*` and `calendarHome.scope.*` keys are written in en, he and ru, natural and with gender-neutral Hebrew.

## 6. Tests

- **`smoke-calendar-editor-api`:**
  - every route's auth, validation and limits;
  - create event (timed, all-day, each repeat, partner's shared calendar, a viewer calendar refused);
  - create reminder (timed, date-only, for the partner);
  - edit for each scope, events and reminders; a reminder's time change clears state and strips the ping;
  - delete for each scope, plus the reminder's owner may delete while the creator edits;
  - wall times in Asia/Jerusalem across a DST change; the 409 on a gone occurrence;
  - recurrence cache cleared; nothing logs a title.
- **Render (`smoke-calendar-home-render`):**
  - the "+" by kinds;
  - the editor's fields by kind, its defaults, the duration kept, all-day hiding the times;
  - the scope sheet for repeating items only;
  - the pencil and Delete by permission;
  - inline errors;
  - the Save bar disabled in flight;
  - 44 px; no untranslated key in en, he or ru; RTL;
  - the BackButton cancels.

## 7. Risks

The scope semantics live in the store, which the bot already uses, so the app inherits their behaviour, including the quirk that "following" makes the editor the new series' creator for events. Date and time inputs vary across Telegram webviews (iOS, Android, Desktop). The device check covers them.

### Known limitations (shipped on purpose)

- The date and time pills show each webview's native format, not the mockups'.
- Shipped later in 3b (see `2026-10-19-home-editing-3b-design.md`): the repeat rule, the calendar, Google items and a reminder's recipient. Still out: per-event alerts and drag.
- A fixed-days series' day move is for this one only.
- The calendar choice's native `<select>` list has no colour dots; only the chosen value shows one.
- Spring-forward: a stored key inside the skipped hour (02:xx) is read back as 03:xx floating, so a carried exdate or override of a moved series can be dropped (the deleted occurrence comes back, or its rename is lost).
- An all-day "following" day move sent with a start but no end takes the end from the length in milliseconds, so across a DST change it can land an hour over. Latent: the home and the bot always send both ends.
- A reminder's "all" or "following" time move drops title-only renames, not only the moved ones.
- The bot's early answer to a fixed-days move is Telegram's; a pending card made before the answer existed is still refused at Confirm.

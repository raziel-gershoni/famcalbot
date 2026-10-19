# Editing in the calendar home, step 3b: repeats, calendars, recipients and Google items

Status: designed 2026-10-19 under the owner's delegation ("you can proceed with development. i'll test everything when i start using the system"), then revised after three adversarial reviews: store, Google API and UX. The reviews are in session scratchpad next/review-3b-*.md.

This builds on the shipped first pass, docs/superpowers/specs/2026-10-19-home-editing-design.md (called "3a" here), and reuses its editor, scope sheet, form kit and routes.

## 1. Scope

**In:**
- **Repeat on edit.** A FamCal or Google item can start repeating, get another of the five rules, or stop repeating.
- **Calendar on edit.** A FamCal event can move to another writable FamCal calendar. A Google event can move to another writable Google calendar, using Google's own move for whole series.
- **Recipient on edit.** The creator of a FamCal reminder can change who it is for (Me | partner).
- **Google items in the home**, for users whose calendar is Google: add an event, edit and delete with the three scopes, change the repeat, and move.
- **Fixes in the shared paths these surfaced.** The bot benefits too; see §6.

**Out:**
- **Moving between FamCal and Google** (the owner's cross-source idea). It ships with "Google as a connection", because today each person is FamCal-only or Google-only (`sourcesFor`, calendar-read/index.ts:22). Calendar ids stay provider-prefixed (`native:<cuid>` or a Google id), so the mixed list needs no reshaping.
- **Changing kind** (event ↔ reminder). It stays create-only.
- **"Ends on", weekday sets and "every N"** as controls. An end the rule already has is kept (§2.1).
- **Per-event alert times.** Alerts before events already exist (Settings, Pro) with the person's default lead time.
- **Editing Google events with other guests**, events on read-only calendars, and Google's special types.

## 2. What people see

### 2.1 Repeat on edit
- **The row.** The create Repeat row shows on edit, for events and reminders. Its choices are the five, worded from the form's start date as on create: Never; Every day; Every week on <weekday>; Every month on the <n>th; Every year on <date>.
- **Classifying the stored rule.** A stored rule counts as one of the five when all of these hold, after parsing with rrule:
  - its FREQ matches;
  - its INTERVAL is 1 or absent;
  - any BY* parts equal what that choice would mean for the item's own start (BYDAY = the start's weekday for weekly; BYMONTHDAY = the start's day for monthly; BYMONTH and BYMONTHDAY = the start's date for yearly);
  - it has no other parts. WKST is ignored.

  Otherwise it is **custom**.
- **The custom choice.** A custom rule gets a sixth choice that comes first and is selected: "<its words> (current)", using the existing `repeatWords`. An unreadable rule shows "Current repeat". Opening and saving never changes a rule nobody touched.
- **Ends.** A stored end is shown and kept. Labels gain ", until <date>" (for example "Every day, until 19 Oct (current)"). Picking another of the five keeps the end:
  - an UNTIL carries over as it is;
  - a COUNT turns into the UNTIL of its last occurrence under the old rule, so the series still ends on the same day.

  Never has no end.
- **A repeat change always applies from the opened occurrence on.** The earlier occurrences keep their old rule; that is "This one and the ones after". There is no scope question. When the opened occurrence isn't the first, a line under the Repeat row says "From <date> on. Earlier ones stay as they were."
  - **From the first occurrence:** the whole series changes.
  - **Never, from a later occurrence:** the earlier ones keep repeating up to it, the opened one stays as a one-off, and the later ones go.
  - **Never, from the first:** the item becomes a one-off.
  - **One-off → repeating:** the item becomes a series starting at the form's start.
  - **Other changes in the same save** (title, time, all-day, calendar, recipient) apply from the opened occurrence on too.
- **The fixed-days guard.** A day move on a set-weekdays series is refused, and the guard reads the rule that will be stored. The five rules have no BY* parts and follow the start, so a move that also picks one of the five is never refused.

### 2.2 Calendar on edit (events)
- **When the row shows.** The create Calendar row shows on edit, with the current calendar selected. It needs:
  - the item's calendar is one the user can write;
  - there is at least one other writable calendar of the same source.

  Otherwise the calendar name stays as text.
- **Scope.** For a series it asks "This one and the ones after" or "All of them", never "Only this one". A line on the sheet explains: "A calendar or recipient change applies from here on or to all of them." Both buttons read neutrally ("This one and the ones after" / "All of them"), not the old rule's "Every Tuesday".
- **Access.**
  - FamCal: write access to both the source and the destination.
  - When the event is on the partner's calendar, the user's own private calendars aren't offered, so the partner's event can't silently leave their view.
  - Reminders have no calendar row (they live on their creator's main calendar).
- **Set-weekdays series.** A day move on a set-weekdays series together with a calendar or recipient change can't be saved: the day move needs "Only this one", and the other change needs a series scope. Save shows "Save the day change on its own first." and nothing is written.

### 2.3 Recipient on edit (FamCal reminders)
- **Who sees the row.** "For: Me | <partner>" shows on edit to the reminder's **creator** only. "Me" is always the creator. It shows when the partner can receive reminders (active pairing, FamCal, on Telegram, as `resolve.ts` rules), or when the reminder is currently for the partner. In the second case "Me" stays available, so the creator can always take it back.
- **The recipient's view.** The recipient sees "For <name>" text and has Done and Snooze only, as in 3a.
- **Scope.** For a series it uses the same two-choice scope sheet and line as §2.2.
- **After the change:**
  - Done occurrences stay done.
  - Each open occurrence in range starts fresh for the new person. One due within the last hour pings them now, as any due reminder does.
  - The old person's live ping loses its buttons and reads "⏰ <title> · now for <name>", with the new recipient's name.

### 2.4 Google items (Google-calendar users)
- **The "+".** It shows for Google users and opens the editor on Event, with no switch. The Calendar row lists the user's chosen Google calendars that they can write to (owner or writer, read live). The default is the primary, or else the first. If that list can't be read, there's no "+" and the error is logged.
- **Pencil and Delete.** Editable means all of:
  - the item's calendar is writable;
  - `eventType` is absent or `default`;
  - `locked` isn't set;
  - no other attendees (rooms count; `attendeesOmitted` counts as unknown, so not editable);
  - `organizer.self` is true, or the event has no attendees at all.

  These are read on the instance, which carries the master's organizer and attendees.
  - When the calendar is writable but another rule fails, the sheet adds "This one can only be changed in Google Calendar".
  - Read-only calendars show no line, as FamCal viewers see none.
- **Fields.** Title, location, all day, starts, ends, notes, repeat and calendar. Notes are written back only when changed (Google keeps HTML notes; the form shows plain text).
- **Calendar row.** The move uses Google's own move, which keeps the same event, its Meet link and its own alert overrides; default alerts and colour follow the new calendar. For a series, the scope sheet offers two choices:
  - "All of them" moves the whole series;
  - "This one and the ones after" leaves the earlier part where it was and puts the rest on the new calendar.
- **Scopes.** As in FamCal: Only this one / This one and the ones after / All of them for field changes, and from the opened occurrence on for a repeat change (§2.1).

### 2.5 After Save or Delete
As in 3a. The editor closes and the home refreshes the item's source. The sheet follows the key PATCH returns; a split, a stop or a new series gives a new key. The sheet closes if the item is gone.

### 2.6 Errors
3a's set (notAllowed, changed, failed, busy) plus **reconnect**. Its copy is the banner's "Your Google connection expired". The home also raises its reconnect banner (token or scopes), the same banner a failed Google read raises.
- A read-only Google calendar or a Google refusal gives notAllowed ("You can't change this one").
- A rate limit, 5xx or timeout gives failed ("Couldn't save. Try again").
- An event that's gone (404 or 410) gives changed.
- A refused day move gives the inline day note.

## 3. Server

### 3.1 FamCal store (src/services/native-calendar/event-store.ts)
`UpdateNativeEventInput` gains three optional series-level fields, and the one function keeps doing every scope:
- `rrule?: string | null`: the new rule, or `null` to stop. Omitted keeps the rule.
- `calendarId?: string`: a native cuid; events only.
- `forUserId?: number | null`: reminders only; null is the creator.

**Scopes.**
- A series-level field with scope 'single' on a series is refused: `NativeScopeError` → 400 invalid `scope`.
- A new `rrule` (or null) is only valid with 'following'. The route always sends 'following' for a repeat change on a series.

**'following' from the first occurrence becomes 'all'** (every edit, the bot's too). "First" means that the parent, truncated at the cut, would have no visible occurrence: expand from the series start to the cut with its exdates and overrides applied.
- Times are still resolved as 'following' (`followingTimesFor`). The series' new start is the tail's start.
- Rows are shifted as 'all' shifts them.
- The fields the edit sets are cleared from the overrides, as 'following' clears them.
- The key is computed from the result, and the store returns it.
- Delete-following from the first occurrence deletes the whole series. That ends the empty "husk" series left today.

**The rule that places times.** Wherever the store or the route reads the rule to place times or refuse a move, it reads `input.rrule !== undefined ? input.rrule : series.rrule`. That covers `movesFixedDays`, `refusesFixedDays`, `followingTimesFor`, `ownTimes` and wr's key anchor.

**Rule validity: `assertStorableRule`.** It parses the rule with any `RRULE:` prefix stripped, using `RRule.parseString`. It is called by `createNativeEvent` and by every update that writes a rule, and throws `NativeRuleError` (the bot maps it to UNKNOWN_ERROR with a log of the ids; the home to 400 invalid `repeat`). It requires:
- the parsed keys are within freq, interval, byweekday, bymonthday, bymonth, until, count and wkst;
- FREQ is daily, weekly, monthly or yearly;
- INTERVAL, when present, is an integer ≥ 1, and so is COUNT. A negative interval hangs the rrule library.

**New rule ('following', or 'all' at the first occurrence).**
- **The split.** The existing split runs with the new rule on the tail.
- **The end carry.** The tail's end follows §2.1: an untouched UNTIL is carried over; a COUNT becomes the UNTIL of the old rule's last occurrence; Never has none.
- **Validation.** Every instance row, exdate and reminder state row of the tail is moved and validated through `moveInstances` / `carriedExdates`, with the new shape, even when no time changed. That includes the reminder branches that skip it today (ee:897-913, ee:931-933). Rows the new rule doesn't yield are deleted, because an orphan override renders, and pings, as a ghost.
- **The ping copy.** The deleted occurrences' live pings are stripped with the existing `nativeReminders.changed` copy, not "moved".
- **Re-arm.** A reminder tail gets `armedAt = now`, so occurrences the new rule creates in the past don't ping. One due within the 15-minute grace still pings. The tail's open past occurrence also leaves the open carry-over. That is accepted: the change resets the series from there.

**Stop repeating.** The route sends the opened occurrence's effective values (overrides applied) with the form's edits on top. These are occurrence times, never converted to series times.
- **'following' from a later occurrence.**
  - The parent is truncated at the cut.
  - A one-off is created with those values: the series' creator and kind; the form's calendar and recipient when the save changes them, else the series'.
  - Rows at or after the cut are deleted.
  - The opened occurrence's reminder state moves to the one-off only when its start and all-day are unchanged, keeping done and snooze. Otherwise it is deleted and its ping stripped with "moved", since it moved.
- **The first occurrence ('all').** The series row itself becomes the one-off with those values: `rrule = null`, `exdates = []`, every NativeEventInstance row deleted.
  - Every other state row is deleted first, in the same transaction, and their pings are stripped with `changed`.
  - The opened occurrence's state is then re-keyed to the one-off's start under the same unchanged-time rule. The other rows are already gone, so the re-key can't collide.

**One-off → series.** Set `rrule` (validated). The row keeps its id, and the key gains `#<start>`. Reminder state at the start stays.

**Calendar move.**
- 'all' updates `calendarId`, and the children follow. 'following' splits, with the tail on the new calendar.
- It needs `canWriteAccess` on the source (as today) and on the destination (as create).
- A missing, deleted or unwritable destination gives `NativeDestinationError` → 400 invalid `calendarId`. It never gives not_found, so the sheet doesn't close as if the item were gone.
- When the source is the partner's calendar and the destination is the user's own PRIVATE calendar, it is refused the same way.
- Kind REMINDER refuses with `NativeScopeError` field `calendarId`.

**Recipient.**
- Only the creator may change it (`NativePermissionDeniedError` otherwise).
- The value must be null, or the creator's ACTIVE partner who is NATIVE and on Telegram. Otherwise `NativeRecipientError` → 400 invalid `forPartner`.
- 'all' sets `forUserId`. 'following' splits, and the tail gets the new value.
- The open (not done) state rows in range are deleted, and their pings are returned as `reassignedPings`.
- `armedAt` stays, so an occurrence due within the last hour pings the new person.
- When a time change comes in the same save, every open row's ping is returned as `reassignedPings`, not `clearedPings`.

**Recipient race with the pass.** After a successful claim, the pass re-reads the series' `forUserId`, `isDeleted` and `updatedAt`. If any changed since its read, it deletes the state row it just created (or restores the previous `lastPingedAt` when it updated one) and skips, so the next tick pings the right person. A smoke drives the interleaving.

**COUNT on 'following'** (the bot's too). The tail's COUNT is the original COUNT minus the rule's slots before the cut. Slots are counted by expanding the stored rule from the series start with exdates and overrides ignored (as `yieldsSlots` does). This applies in the event and the reminder branches, and the result is at least 1. The parent gets only UNTIL.

**The read guards.** A per-series try/catch logs the series id (never the title) with `captureError`, then skips that series. It sits in:
- `expandCandidates`;
- `selectOpenReminderItems`'s per-candidate body;
- `loadItem` (answers not_found);
- `liveOccurrenceTitle` (treated as changed).

`repeatInfo`'s empty catch logs too. One bad stored rule no longer empties anyone's FamCal view, digest, open list or bot lookup.

**Due gate.** `invalidateDueGate()` runs for every reminder write, as today.

### 3.2 Google path (src/services/calendar.ts, calendar-provider/google-provider.ts)
The bot and the home share these, so each fix reaches both.

- **Zone.** Writes use the event's own zone: the instance's or master's `start.timeZone`, else the calendar's (`calendarList.get`), else the user's. New events use the user's zone. This replaces the `Asia/Jerusalem` constant.
- **'all' with a time change.**
  - The instance is read (`events.get` on the instance id), and the master is shifted by the same arithmetic as FamCal's `seriesTimesFor`. The base is the instance's `originalStartTime`; the change is the requested start minus its displayed start.
  - Timed events shift on the wall clock in the event's zone. All-day events shift by whole days.
  - `UpdateEventInput` gains the instance id the bot already holds, so the master shift no longer lays the occurrence's date onto the master (which today drops every earlier occurrence).
- **'following' (update and delete).** The cut is the instance's `originalStartTime`.
  - **Master.** Its COUNT and UNTIL are replaced by a single UNTIL one second before the cut. For a timed series that is written in UTC as `YYYYMMDDTHHMMSSZ`. For an all-day series it is the day before, as a date. It is no longer computed on the server's clock.
  - **Tail recurrence.** The tail carries the original UNTIL if there was one. Otherwise its COUNT is the original COUNT minus the rule's slots before the cut (counted by expanding the master's RRULE in its zone, EXDATE ignored). Otherwise it has no end. Never UNTIL and COUNT together.
  - **Exclusion lines.** EXDATE and RDATE lines at or after the cut go to the tail. The ones before stay on the master.
  - **Tail fields.** Unchanged fields come from the cut instance as shown: title, HTML description, location, colour, `reminders`, visibility and transparency. It leaves out ids, attendees, conference data, attachments and extended properties.
  - **Destination.** A calendar change puts the tail on the destination calendar.
  - **First slot.** When the cut is the rule's first slot, the change runs as 'all'.
  - **Strays.** After the split, `events.instances(master, timeMin = cut)` is read, and anything still there (exceptions Google kept past the new UNTIL) is deleted, with a logged count.
- **Repeat change.** It always works from the opened occurrence, by replacing from the cut:
  - From a later occurrence: the master is truncated as above. A new event is inserted from the cut instance's values plus the form's edits, with the new rule (or none, for Never). Then strays are cleaned up.
  - From the first slot: the new event is inserted and the master deleted, which also removes its exceptions.
  - The new event has a new id, and PATCH returns its key.
  - One-off → series patches `recurrence` onto the event.
- **Fixed days.** It uses the shared `fixesDays` predicate (BYDAY, BYMONTHDAY, BYMONTH, BYYEARDAY, BYWEEKNO). A day move on 'all' or 'following' is refused with FIXED_DAYS.
  - `wouldRefuseFixedDays` answers for Google ids too, by reading the master. On a read error it logs and doesn't block.
  - Its empty catch logs.
- **Move.** `CalendarProvider.moveEvent(user, { eventId, fromCalendarId, toCalendarId })` calls `events.move` on the master (or the one-off), inside `writeThenStamp`.
  - In a save, the move comes first. Any field patch then goes to the destination calendar id.
  - If the move fails, nothing else is written.
  - If the patch fails after a successful move, the failure is logged, the new key is returned and the stamp runs.
  - `cannotChangeOrganizer` and other 403s map to FORBIDDEN.
- **Errors.** `classifyGoogleError` gains a `forbidden` class (a 403 that is neither a scope nor a rate-limit error). `ProviderErrorCode` gains FORBIDDEN, and results gain `retryable`.
  - scopes → PERMISSION_DENIED: the existing grant-write flow and copy, unchanged.
  - forbidden → FORBIDDEN: the bot says `nativeReminders.permissionDenied`, and the home gives notAllowed.
  - token → TOKEN_EXPIRED.
  - gone → NOT_FOUND.
  - transient (429, rate-limit 403s, 408, 5xx, timeouts) → UNKNOWN_ERROR with `retryable: true`.
  - config → UNKNOWN_ERROR.
  - The status is read from `err.status ?? err.response?.status ?? err.code`.
  - The three bot call sites (callbacks.ts edit, delete and create) gain the FORBIDDEN branch, and so does `deleteThisAndFollowing`.
- **Guests.** No write sends guest emails (`sendUpdates` unset, as the bot does today).
- **Recurrence lines.** `formatRecurrenceForAPI` passes lines matching `/^(RRULE|EXDATE|RDATE)[:;]/i` through and prefixes only bare rules.

### 3.3 Routes
The shapes from 3a, widened:
- **`GET /api/calendar/editor`.** For Google users:
  - `kinds { event: true, reminder: false }`;
  - `calendars`: the chosen Google calendars whose live `accessRole` (one `calendarList.list`) is owner or writer, with name and colour; `main` marks the primary;
  - `partner: null`.

  The client's two NATIVE-only gates for editor info and kinds (CalendarHome.tsx:541, :553-556) open for Google users. `canAdd` already waits for setup (needsOAuth / needsCalendars). Events have no plan gate.
- **`GET /api/calendar/item?key=`.** It accepts `google|<calendarId>|<eventId>`.
  - The calendar id must be in the user's own calendar assignments; ids never come from the client.
  - The server reads `calendarList.get` (role), `events.get` of the instance and, for a series, the master (rule, zone).
  - It returns the 3a shape plus `source` and the additions below, with eligibility from §2.4.
  - Notes come back as plain text (`htmlToText`).
- **Edit-info additions** (`ItemEditInfoResponse`; all optional, so older fakes still parse):
  - `series.rule`: `{ choice: RepeatChoice | 'custom', words?: string, until?: DayKey }`, as classified in §2.1;
  - `series.first`: whether the opened occurrence is the first;
  - `canMoveCalendar` and `moveTargets` (calendar ids allowed for this item, which applies §2.2's private filter);
  - `canChangeRecipient`, and `forPartner` (the current value, relative to the creator);
  - `editableInGoogleOnly`, which drives the sheet line;
  - `source`.
- **`POST /api/calendar/items`.** A `calendarId` that isn't `native:` is a Google id. It is checked against the editor's writable list, and the event is created through `googleProvider.createEvent` with the user's zone.
- **`PATCH /api/calendar/items`.**
  - `changes` gains `repeat` (`none|daily|weekly|monthly|yearly`; omitted keeps it), `calendarId` and `forPartner`.
  - A repeat change forces scope 'following'. A calendar or recipient change refuses 'single' on a series.
  - Google keys go to the Google path.
  - PATCH returns `{ status: 'ok', key }` with the item's key after the write.
- **`DELETE`** accepts Google keys.
- **Every write keeps 3a's rules:** auth, the write rate limiter, server validation, caches, analytics and no titles in logs.
  - Google writes stamp through `writeThenStamp`.
  - A calendar move or recipient change clears the recurrence cache for every user it touches: the old and new calendar owners, and the old and new recipient.
  - Analytics stay `calendar_item_created` / `_edited` / `_deleted`, with `source: 'app'`, `provider` and `changed_fields`.

## 4. Client
- **EditorSheet** turns on the three create-only rows in edit mode when the info allows them: Repeat (with the custom choice and the "From <date> on" line), Calendar (`moveTargets`) and For (`canChangeRecipient`). Otherwise it shows 3a's text lines.
- **editor-model.**
  - `editItemForm` seeds `repeat`, `calendarId` and `forPartner`.
  - `updateBody` sends each only when changed. For a stop, it always sends the effective occurrence values.
  - Scope rules:
    - a repeat change → 'following', no sheet;
    - a calendar or recipient change on a series → a sheet with following/all and the line;
    - a day move on a set-weekdays series plus a calendar or recipient change → the inline note, and no write.
- **ScopeSheet** takes `choices` and an optional `note`. A series-level sheet uses the neutral `scope.following` / `scope.all` labels.
- **CalendarHome.**
  - It asks editor info and item info for Google users too.
  - After a write it refreshes the item's source.
  - On a `reconnect` outcome it raises the reconnect notice.
- **ItemSheet** shows the "only in Google Calendar" line when `editableInGoogleOnly`.

## 5. Copy
New keys in en, he and ru, natural for each: gender-neutral Hebrew, and the formal вы in Russian.
- `calendarHome.editor.repeat.current`: "{words} (current)".
- `calendarHome.editor.repeat.currentPlain`: "Current repeat".
- `calendarHome.editor.repeat.until`: "{rule}, until {date}".
- `calendarHome.editor.repeat.fromHere`: "From {date} on. Earlier ones stay as they were."
- `calendarHome.editor.dayMoveAlone`: "Save the day change on its own first."
- `calendarHome.editor.submitErrors.reconnect`: reuses the banner wording.
- `calendarHome.scope.seriesNote`: "A calendar or recipient change applies from here on or to all of them."
- `calendarHome.sheet.googleOnly`: "This one can only be changed in Google Calendar".
- `nativeReminders.reassigned`: "⏰ {title} · now for {name}". Hebrew matches `forName`'s "בשביל {name}"; Russian "теперь для {name}".

## 6. What the bot gains (shared fixes)
- **Google:**
  - 'all' time edits keep the series' history;
  - 'following' gets the right UNTIL in every zone, keeps COUNT totals and the cut instance's own fields, and cleans up strays;
  - writes use the event's zone;
  - set-weekday day moves are refused early;
  - a read-only calendar or a non-organizer gets "You can't change this one". The scope grant flow is unchanged.
- **FamCal:**
  - 'following' keeps COUNT totals;
  - the first occurrence no longer leaves an empty series;
  - delete-following from the first occurrence deletes the series;
  - a stored rule that would hang or break reads is refused at write time;
  - a bad stored rule no longer blanks anyone's view, digest, open list or lookup;
  - a recipient change can't race the reminder pass.

## 7. Tests
- **smoke-calendar-editor-api:**
  - every new field, its validation and the scope rules;
  - classifying rules (five, custom, BYDAY equal to the start, ends);
  - the end carry (UNTIL, COUNT → UNTIL);
  - one-off ↔ series, and keys returned;
  - stop 'following' and stop at the first occurrence, with state kept only for an unchanged time and no unique-key collision;
  - the rule change dropping orphan overrides, exdates and state in every branch, with the copy per kind of ping;
  - calendar move: both ends, partner calendars, the private filter, the deleted destination giving 400, the reminder refusal;
  - recipient: creator only, eligibility, the take-back, done kept, open cleared, reassignedPings including a combined time change, armedAt kept;
  - the COUNT split, counted in slots;
  - the first occurrence as 'all', for edit and delete;
  - `assertStorableRule`, including INTERVAL=-1 and COUNT=0 refused;
  - cache clears for every user touched;
  - Asia/Jerusalem across DST.
- **The read guards:** one series with a broken rule is skipped and logged in the range read, the digest open lines, the open list, loadItem and the ping title, and the rest is whole.
- **The pass race:** a recipient change between the pass's read and its claim sends nothing to the old person and pings the new one on the next tick.
- **A new smoke-google-write,** with a fake `@googleapis/calendar` client that records calls:
  - single/all/following edit and delete;
  - the master shift in the event's zone (timed and all-day);
  - UNTIL as UTC Z or a date, never UNTIL with COUNT;
  - the tail's COUNT counted in slots;
  - EXDATE lines split at the cut;
  - tail fields from the cut instance;
  - first slot as 'all';
  - stray cleanup;
  - repeat replace from the cut and from the first slot;
  - one-off → series;
  - the move order and its failure branches;
  - the following-with-calendar insert on the destination;
  - fixed-days with `fixesDays`;
  - the error classes with a real GaxiosError shape;
  - recurrence line passthrough;
  - the stamp after every write, including failures;
  - eligibility (rooms, `attendeesOmitted`, organizer, type, locked, role);
  - the item-info shape;
  - the editor calendars.
- **smoke-calendar-home-render:**
  - update #81/#82;
  - add the custom and end labels, the "from here" line, no sheet for a repeat change, the two-choice sheet with its note, the day-alone note, the calendar and For rows (take-back included), the private filter shown, the Google "+", pencil, Delete and googleOnly line (and none on read-only calendars), the reconnect outcome raising the banner, follow across a key change, en/he/ru copy, and the CSS rules.
- **Bot regressions:**
  - the voice edit and delete smokes pass;
  - FORBIDDEN gets permissionDenied;
  - PERMISSION_DENIED still offers the grant button;
  - the bot's Google 'all' edit shifts the master and doesn't drop history.

## 8. Risks
- **Google's real behaviour isn't run in tests:** UNTIL in UTC on timed series, events.move of a master, and whether strays exist after a truncation. The fake pins the calls. Every failure is a logged Google error that the user sees as an error, never a silent loss. The owner's prod test is the check.
- **A Google replace or split is two or more writes.** A failure in the middle can leave the head truncated without its new part. It is logged and shown as "Couldn't save", and the stamp refreshes the view. Today's bot has the same gap.

### Known limitations (shipped on purpose)
- **Repeat changes** offer the five simple rules from the opened occurrence on (no "ends on", weekday sets or intervals). Bot rules are kept or replaced whole, with their end date kept.
- **Google repeat changes** give the event a new id. The Meet link, attachments and extended properties don't carry over to the new part. Neither do they on a 'following' split.
- **Google events** with other guests, on read-only calendars or of special types stay view-only in the home.
- **Moving between FamCal and Google** waits for "Google as a connection".

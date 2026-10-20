# One-way sync: FamCal → Google

Status: designed 2026-10-20 under the owner's delegation. The owner chose option A for where the copies go (§3) on 2026-10-20 ("a"). The spec was revised after a code/API review and a product review (session scratchpad next/review-sync-code-api.md, plus the product findings in the run log).

The owner's earlier rulings, from 2026-10-14: "sync should be only us to gcal at first, then we'll see if gcal to us is even needed" and "famcal should support more than one cal. so sync should be famcal:personal, famcal:kid1 or smth like this if possible".

It builds on Google as a connection (2026-10-19-google-connection-design.md) and reuses its native→Google mapper. Research is in next/facts-sync.md, which includes CalBrew's one-way sync (read only).

## 1. What people get
- **Copy to Google.** A user with Google connected can copy any FamCal calendar they **own** into Google. Each one gets its own Google calendar, "FamCal · <name>", created by FamCal.
- **What arrives.** FamCal events show in Google Calendar on every device within a couple of minutes: new ones, changes, deletes, repeats, single-occurrence changes and skipped days. That includes events the partner adds to the owner's shared calendar.
- **One way only.** Edits made in Google to a copy are replaced by the next FamCal change and are never read back. The settings row says so.
- **No alerts in Google.** The copies carry no alerts (`reminders: { useDefault: false, overrides: [] }`), and the new calendar is created with no default notifications. FamCal's own event alerts remain the alert source, so nothing pings twice. The row says "Alerts come from FamCal, not from the Google copy."
- **Not copied:**
  - reminders, because FamCal pings them;
  - one-offs that ended more than 30 days ago;
  - a partner's calendars. Only the owner can copy those, and a non-owner's row says "Only <owner> can copy this one".
- **Hebrew-rule series** are copied as explicit dates for the next 10 Hebrew years, refreshed when fewer than 2 remain.
- **Who can use it.** The feature is the plan feature `googleSync`, on the same plans as reminders (Pro, trial, early adopters, admin grant). The owner can change it in plans.ts. When a plan lapses, the copies stop updating and stay where they are. The row says "Copying is paused on your plan."
- **Where it lives.** The FamCal calendars page gets a "Copy to Google" row on each own calendar. The row shows:
  - its state (§2);
  - "Copying… 340 of 1,200" during the first copy;
  - "N can't be copied" for unsupported items (§4).

  Turning it off asks: "Delete the calendar “FamCal · <name>” from Google too, including anything you added to it?", with Remove and Keep.

## 2. Model
- **`GoogleSyncLink`**:
  - `id`, `userId` (→ User, cascade), `nativeCalendarId` (→ NativeCalendar, SetNull);
  - `googleCalendarId`, `googleAccount` (the account's `sub`, from the token's id info);
  - `enabled`;
  - `state`: 'creating' | 'ok' | 'token' | 'scopes' | 'gone' | 'otherAccount' | 'plan' | 'error';
  - `pushedName`, `lastError`, `lastSyncedAt`, `backfilledAt`.

  It's unique per `(userId, nativeCalendarId)`. The row is kept after Keep or Remove, with `enabled = false`, so a re-enable reuses the Google calendar and FamCal never shows it again in select-calendars or reads.
- **`GoogleSyncItem`**:
  - `id`, `linkId` (→ link, cascade), `nativeEventId` (plain column, no FK, so the series can vanish under it);
  - `googleEventId`, `generation`;
  - `masterHash`, `slotHashes Json` (one hash per override or cancelled slot);
  - `dirtySeq`, `pushedSeq`, `attempts`, `nextAttemptAt`;
  - `status`: 'ok' | 'unsupported' | 'error', and `lastError`.

  It's unique on `(linkId, nativeEventId)`.
- **Dirty marks** go in the same transaction as the write, as `dirtySeq + 1`:
  - from every event-store write (create, update, delete, and the 3b and Hebrew paths, shared with the bot and the home);
  - from `createNativeSeries` (the move);
  - from the calendar PATCH (a rename marks the link) and DELETE routes;
  - from the WA→TG merge's event and calendar moves (account-linking.ts) and from hardDeleteUser, which also turn the link off and remove the Google calendar, as with Remove, because the token goes with the user.

  Store writes that run outside a transaction today are wrapped. A push records the `dirtySeq` it pushed, and the item is clean only when `pushedSeq === dirtySeq`, so a write that lands mid-push is never lost.
- **The gate.** A mark opens a gate on globalThis (like the reminders' due gate), and the worker runs only when the gate is open, so FamCal doesn't query the DB every minute and Neon can sleep. A 60-minute ceiling catches anything missed. The DB stays the source of truth.
- **Markers:**
  - every Google copy carries `extendedProperties.private` `{ famcalSync: <linkId>, famcalSeries: <seriesId> }`;
  - each calendar's description ends with the fixed token `[famcal:<linkId>]` (not translated).
- **Never shown back.**
  - Google reads drop events with `famcalSync` in `keepGoogleEvent` (calendar-read/google-map.ts) and in calendar.ts's `fetchEventsInRange`. The read mask adds `extendedProperties(private)`.
  - `listUserCalendars` drops every linked calendar id, so select-calendars, the editor's move targets, the LLM's list and the default calendar never see them. select-calendars' POST drops them too.
  - The move's `famcalMovedFrom` is a different key and is never treated as a copy.

## 3. FamCal's own Google calendars (owner, 2026-10-20: "a")
- **Creating the calendar.** Turning a copy on sets the link to 'creating'.
  - It calls `calendars.insert` with the name "FamCal · <name>" and the series' zone. The name is bidi-isolated (FSI/PDI) for Hebrew. A name clash adds " (2)".
  - The description, in the user's language, explains that FamCal keeps the calendar, then carries the token.
  - `calendarList.patch` sets `defaultReminders: []`.
  - Then the id is stored and the link becomes 'ok'.
  - A retry while 'creating' first looks in `calendarList` for the token, and adopts that calendar instead of creating a second one.
- **Rename.** A FamCal rename patches the name (`pushedName` keeps them in step).
- **Remove.**
  - When the calendar holds only FamCal's marked events, Remove deletes it (`calendars.delete`, allowed for calendars the app created).
  - When the user added their own events there, only the marked events are deleted and the calendar stays.
- **Keep.** It patches the description to say FamCal no longer updates it.
- **Re-enable.** It reuses the calendar, and marks every item dirty with its hashes cleared.
- **The permission** is `https://www.googleapis.com/auth/calendar.app.created`, used only for `calendars.*` calls (create, rename, delete, default reminders). Event writes on the copy calendar use `calendar.events`, which FamCal already has.
  - **Every OAuth request** now sends `include_granted_scopes=true`, so a later reconnect never drops it.
  - **Asked only on first use.** The first "Copy to Google" without the scope starts consent with `purpose: 'sync'` and the `nativeCalendarId` in the OAuth state. The R3 claim step still applies (consent, then the Telegram or WhatsApp tap), and the row says "Approve in Google, then tap the link FamCal sends you."
  - **The scopes are saved at commit,** not at exchange: the granted scope string travels in the pending entry, and `commitGoogleToken` writes `User.googleScopes String[]` (a new migration). An empty list means the scope is missing. A sync-purpose commit creates the link.
  - **Connecting** still requires only the two existing scopes.
- **Owner steps (Google Cloud Console):**
  1. Under Google Auth Platform → Data Access, add `…/auth/calendar.app.created`. Check the label it shows: Calendar scopes are sensitive, not restricted.
  2. If the app is **in testing**: test users can grant it right away, but refresh tokens expire after 7 days. That already affects reading, and sync makes it a weekly reconnect. Moving to production is advised.
  3. If the app is **in production and verified**: Google asks for this scope to be verified (a justification and a demo video of the "Copy to Google" flow). Until then, people see Google's "unverified app" screen for this one permission, and unverified grants are capped at about 100 users. Nothing else is blocked meanwhile.
  4. The privacy page (code, done in the build) names the Google copy in its data-use text.

## 4. The worker
- **Pace.** It runs each minute while the gate is open.
  - At most 3 users run at a time, each under a fail-closed Redis NX lock with its own prefix, a 10-minute TTL, renewal per item, and a finally-release. A locked user is skipped.
  - Each user gets at most 100 Google calls per run. Calendar creation is serial.
  - A rate-limit answer (`usageLimits`, 403 rateLimitExceeded, 429) ends that user's run without counting attempts.
- **Each item** is rebuilt from the series' current FamCal state with the move's mapper (`toGoogleEvent`). That covers the zone, the RRULE and UNTIL forms, EXDATE lines, and overrides as instance patches via `events.instances({ originalStart })`. The owner is re-checked at push: the calendar's `ownerUserId` must equal `link.userId`, and the calendar must not be deleted. Then:
  - **Gone from the copy.** A series that's missing, deleted, now a reminder, or moved out of the link's calendar is deleted in Google. A delete that answers 404 or 410 counts as done. One that was never inserted is just dropped.
  - **New.** It's inserted with a deterministic id: base32hex of a hash of `linkId:seriesId:generation`. A 409 means the copy is already there, so it's adopted and patched. That makes retries after a timeout or deploy safe.
  - **Structural changes** (rule, start, all-day, a removed override or exdate, a one-off becoming a series or the reverse) delete the master and insert it again with the next generation, so no stale exception survives.
  - **Otherwise** the master is patched when its hash changed. Any master write replays every instance patch, because a master change can drop exceptions. An override-only change patches just the slots whose hash changed.
  - **Hebrew series.** DTSTART is the first occurrence in the current Hebrew year, with RDATE lines through 10 years ahead. The list is extended only when fewer than 2 years remain, and hashed on the dates actually sent.
  - **Unsupported.** A series the mapper can't express (its start isn't one of its slots, an override slot Google won't yield, an unparseable part) is marked 'unsupported'. It's logged once and never retried, and the row counts it.
- **Failures:**
  - **404 or 410 on a write.** `calendars.get` decides what's gone. If the calendar is gone, the link goes to 'gone', nothing else is written, and the row offers "Create it again", which resets every item's id and hashes and copies everything again. If only the event is gone, it's reinserted with the next generation. A second 404 on the same item sets 'error' with no more retries.
  - **Transient errors** back off exponentially with jitter. After 10 attempts the admin is alerted, deduplicated per link per day.
  - **Token or scopes** set every link of the user to that state. The user gets the reconnect message once per outage (`User.googleSyncNotifiedAt`). A commit puts their links back to 'ok' and clears `nextAttemptAt`.
  - **Another Google account** (the token's `sub` differs from `link.googleAccount`) sets 'otherAccount'. The row asks "This is a different Google account. Copy again from scratch?"
  - **Logging.** Every catch logs ids, never titles, and goes to Sentry.
- **Backfill.** A new or re-enabled link marks every series of the calendar dirty (the event kind only), with one-offs from 30 days back and series whole. It drains at the pace above, showing progress from item counts.
- **Suspended users** are skipped. A lapsed plan sets 'plan' and pauses the link.

## 5. Copy
New keys, natural in en, he and ru: gender-neutral Hebrew, formal вы in Russian.
- **Row:** the row title; the one-way, alerts and Hebrew-dates notes.
- **States:** Copying (with progress), Copied, Approve in Google, Needs reconnect, Paused on your plan, Gone with "Create it again", Another account, N can't be copied, Error.
- **Other:** the non-owner line, the unlink question with Remove and Keep, the calendar name prefix and both descriptions (managed, and no longer updated), and the sync reconnect message.

## 6. Tests
- **smoke-google-sync** (new; fake Prisma, fake Google and fake Redis):
  - dirty marks from every listed writer, in one transaction, with the `dirtySeq` race;
  - the gate;
  - each push branch: insert with the deterministic id and 409 adopt, master patch with instance replay, slot-only patches, structural delete and reinsert, deletes counting 404 as done, reminder and moved-out removal, the owner re-check;
  - the Hebrew RDATE horizon;
  - unsupported items;
  - the 404 split (calendars.get), a second 404, backoff, rate-limit pause;
  - token, scopes, otherAccount and plan states, and the reset on commit;
  - the lock with TTL and renew;
  - per-run caps;
  - backfill with progress;
  - creating with adopt by token;
  - Remove with and without user events, Keep, re-enable, recreate;
  - the read filter (home, digest, voice, alerts);
  - `listUserCalendars` hiding copy calendars;
  - no titles in logs.
- **OAuth:** `include_granted_scopes` on every request; scopes carried through the pending entry to commit; a sync-purpose commit creating the link; connect without the new scope still working.
- **Render:** the settings rows and states, the non-owner line, the unlink question, en/he/ru copy, the CSS rules.

### Known limitations (shipped on purpose)
- One way only; Google edits are replaced.
- Reminders and one-offs older than 30 days aren't copied.
- Only the owner can copy a calendar.
- Hebrew series appear in Google as explicit dates (past years drop out of the copy).
- With the app in testing, Google's 7-day token expiry means weekly reconnects.

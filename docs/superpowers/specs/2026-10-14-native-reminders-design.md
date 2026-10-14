# Native reminders: design

**Date:** 2026-10-14 · **Branch:** `feat/native-reminders` · **Status:** approved in conversation, section by section. The owner delegated the remaining choices ("go with your defaults"). Those choices are listed under *Rulings* so they can be reviewed.

## Goal

A built-in-calendar user can say or type "remind me to call the plumber Thursday at 10" or "remind Dana to buy milk tomorrow". FamCal then:
- keeps it as an event with no duration;
- pings the person it is for at that time, with ✅ Done and 💤 Snooze;
- keeps it in the daily digests until someone marks it done.

**Philosophy (owner):** a reminder IS an event. It just has no duration. A reminder with no time is an all-day event. Reminders travel through the same pipeline as events, not a separate list.

## Scope

**In scope**
- NATIVE-calendar users who have a Telegram account.
- Creating reminders from voice notes, forwarded text, and new typed text.
- Pings with buttons.
- Daily digests (morning today-summary and evening tomorrow-summary), with carry-over of open reminders.
- Week views.
- Chat edit and delete.
- The pre-existing bugs listed in §11 that this feature runs into.

**Out of scope** (later projects)
- The calendar UI (Telegram mini app and web), where marking done will also live.
- Google sync.
- A per-user setting for the date-only ping time (fixed at 09:00 until then).
- Reminders from photos.
- "Remind us both".
- A chat "I did it" intent.
- Pruning old state rows.

## Owner decisions (from the conversation)

1. Done and Snooze buttons on the ping. An undone reminder carries over in the digests until it is done.
2. A reminder can be for the paired partner. The person it is for gets the ping, either of the two can mark it done, and both see it until it is done.
3. No time given → a date-only reminder. It pings at **09:00** local for now. A per-user "when to ping all-day reminders" setting comes later.
4. Built-in calendar users only.
5. Same `NativeEvent` table with a kind field. Timed means start = end, and date-only means all-day.
6. Reminders appear in every digest, morning and evening. A past one that is still undone shows as "open since <day>".
7. No buttons under the digests. Marking done belongs in the coming calendar UI. Until then, the ping's buttons are the way (old pings stay live).
8. Pro gating like event alerts. Early adoption unlocks it.

## Rulings (the owner delegated these)

| # | Ruling | Why |
|---|---|---|
| R1 | A **day's** reminders follow calendar visibility like events, plus the person a reminder is for always sees it. **Carry-over** ("open since") lines appear only for the person the reminder is for and its creator. | "Reminders are events" means the same visibility. Carry-over is a nag, so it goes only to the people responsible. |
| R2 | The **effective owner** is worked out on every read: `forUserId` when that user is still the creator's ACTIVE partner and is NATIVE, otherwise the creator. Unpairing writes nothing. | Covers unlink, the NATIVE→GOOGLE switch (which leaves the pairing ACTIVE) and account deletion. Re-pairing restores the link. |
| R3 | Reminders are available when all of these hold: `calendarSource = NATIVE`, a `telegramId`, the new admin flag `nativeRemindersEnabled` (default **on**), and the creator has `checkFeatureAccess(creator, 'reminders')`. When any is false, the extraction prompt has no reminder rules and behaves exactly as it does today. At fire time, the creator's access is checked. | One gate everywhere. WhatsApp-only users can't be pinged and can't close or delete reminders, so they never get them. |
| R4 | **Typed text** (not forwarded) is routed to extraction only when it contains a reminder keyword (§3.1), and only for users who pass R3. Creates from that route are always reminders. It is **not** gated on `voiceInputEnabled`. | Typed text is dropped today, so the keyword filter can't change anything else. "Voice Event Creation" is a voice setting. |
| R5 | Carry-over has **no age limit** (owner: "until done"). A digest names at most **5** open reminders, newest first, then "and N more". | Keeps a long backlog from flooding the digest. |
| R6 | 💤 "Tomorrow morning" means **09:00** in the recipient's timezone. Pressed between 00:00 and 04:00 local, it means today at 09:00. | One morning time for reminders. The coming per-user setting replaces it. Section 3 said "summary hour"; this ruling replaces that. |
| R7 | Pings fire within about **1 minute**. A 1-minute cron tick runs the pass, but the database is read only when an in-process "next due" memo says something is due, and at least every 60 minutes. Every reminder write clears the memo. | Pings are close to on time without a database query every minute. Railway runs one instance, so an in-process memo is enough. The spec records that a second replica would need the memo in Redis. |
| R8 | Built-in calendar digests get the partner's identity. The partner's calendars are labelled from the viewer's side (`yours`→`spouse`, `primary` dropped), and the partner's name and gender come from the pairing. | Partner reminders need a correct partner section. Today the partner's events are filed under "Your Schedule" (a bug). |
| R9 | In settings, the event-alert copy "Event Reminders" becomes "Event alerts" (en/he/ru). | "Reminders" is now the new feature's name. |
| R10 | Image (photo) extraction never produces reminders in v1. | YAGNI. A caption-driven reminder can come later. |
| R11 | "Remind me an hour before the dentist" is resolved on the server: find the anchor event, then take its time plus the offset. The reminder keeps **no link** to the anchor. | Simple. The card states the resolved time. |
| R12 | The partner-done notice and pings go to Telegram only. A WhatsApp-only creator gets no done notice. | WhatsApp's 24h rule would need templates. Telegram comes first anyway. |

## 1. Data model

New migration: `prisma/migrations/20261014000000_native_reminders/migration.sql`. It is hand-written and idempotent (`ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, enum creation inside a `DO $$ … EXCEPTION WHEN duplicate_object` block), with a leading comment, like the recent migrations.

```prisma
enum NativeEventKind {
  EVENT
  REMINDER
}

model NativeEvent {
  // …existing fields…
  kind      NativeEventKind @default(EVENT)
  forUserId Int?            // reminder target; null = the creator. Meaningful only for REMINDER
  forUser   User?           @relation("NativeRemindersFor", fields: [forUserId], references: [id], onDelete: SetNull)
  armedAt   DateTime?       // REMINDER: when its time was last set (create or time change); bounds the ping lookback
  states    NativeReminderState[]

  @@index([kind, isDeleted, startsAt])
  @@index([forUserId])
}

model NativeReminderState {
  id               String    @id @default(cuid())
  seriesEventId    String
  seriesEvent      NativeEvent @relation(fields: [seriesEventId], references: [id], onDelete: Cascade)
  originalStartsAt DateTime  // occurrence key, exactly expandSeries' instanceStartsAt (one-off: startsAt)
  doneAt           DateTime?
  doneByUserId     Int?
  doneBy           User?     @relation("NativeRemindersDone", fields: [doneByUserId], references: [id], onDelete: SetNull)
  snoozedUntil     DateTime?
  lastPingedAt     DateTime?
  pingAttempts     Int       @default(0)
  pingChatId       BigInt?   // the live ping message, so later edits can strip its buttons
  pingMessageId    Int?
  createdAt        DateTime  @default(now())
  updatedAt        DateTime  @updatedAt

  @@unique([seriesEventId, originalStartsAt])
  @@index([snoozedUntil])
}
```

`User` gets the back-relations. `AdminSettings` gets `nativeRemindersEnabled Boolean @default(true)`, synced to Redis like the other toggles (DB upsert → Redis set). It also gets a toggle row in the admin settings page.

**Shape rules, enforced in `event-store.ts`, the single choke point for every native write:**
- `kind = REMINDER` forces `endsAt = startsAt`, on create, on update, and on instance overrides.
- An all-day reminder starts at the start of its local day in the event's `timeZone`, with zero length.
- `armedAt` is set on create and whenever `startsAt` or `allDay` changes.
- A `following` split copies `kind`, `forUserId`, `armedAt` and the **original** `creatorUserId` (today it sets the creator to the acting user and copies none of the new columns).

**"No state row" means pending.** A state row exists once an occurrence has been pinged, snoozed or marked done.

**Naming.** In this codebase "reminder" already means event alerts (`src/services/reminders.ts`, `User.remindersEnabled`, the Redis `reminder:*`/`reminders:*` keys, the `reminders` FeatureType). The new code therefore uses:
- the module `src/services/native-reminders/`,
- the table `NativeReminderState`,
- the callback prefix `nr:`,
- log tag `[NativeReminders]`.

It adds no new Redis keys under `reminder:`.

## 2. Who owns, sees and acts on a reminder

- **Effective owner** (R2): `forUserId` if that user is the creator's ACTIVE partner and is NATIVE, otherwise the creator. One helper, `effectiveOwnerId(series, creatorPartner)`, used everywhere.
- **Sees it on its day:** anyone who can see its calendar (like events), plus the effective owner even when the calendar is PRIVATE. The native provider fetchers add a supplementary query for "reminders whose `forUserId` is me, by my ACTIVE partner", whatever the calendar's privacy, and deduplicate by event id.
- **Sees it as carried over:** only the effective owner and the creator (R1).
- **Gets the ping:** only the effective owner.
- **Done and Snooze:** the effective owner or the creator. A partner with view-only access can do both, because they write the state table, not the event.
- **Edit:** calendar write access as today, or the creator.
- **Delete:** calendar write access, the creator, or the effective owner ("stop reminding me").
- **A native `PERMISSION_DENIED`** shows a plain "you can't change this one" message, not the Google re-auth button.

## 3. Creating reminders

### 3.1 Entry points

| Path | Change |
|---|---|
| Telegram voice note | Unchanged route. The prompt learns reminders when R3 holds. |
| Telegram forwarded text | Unchanged route. The prompt learns reminders when R3 holds. Uses `extractIntents`, so a message with several reminders works. "Me" in forwarded content means the forwarder, so it is always for the creator. |
| **Telegram typed text (new)** | Non-command text matching a keyword (case-insensitive substring) goes to text-mode extraction with `typed: true`, for R3 users. It gets typed-specific copy ("⏰ Got it…" rather than "📨 Processing forwarded message…"). Keywords: `remind`, `reminder`, `don't forget`, `dont forget`; `תזכיר`, `תזכירי`, `תזכורת`, `להזכיר`, `אל תשכח`, `אל תשכחי`; `напомни`, `напомина`, `не забудь`. Typed edits and deletes work when the message has a keyword ("move the reminder…"). |
| WhatsApp voice | Users linked to Telegram may create reminders (the ping goes to Telegram). All `createEvent` call sites carry the new fields. WhatsApp-only users get today's prompt (R3). |
| Photo | No reminders (R10). |

### 3.2 Prompt and parser (`buildEventExtractionPrompt`, `parseGeminiEventResponse`)

When `remindersSupported` is true, the prompt gets a reminder block (en/he/ru phrasing examples) and new output fields on `event`:
- `kind: "event" | "reminder"`. It is a reminder only for "remind me/us/Dana", "תזכיר לי", "напомни", "don't forget to…". An event stays an event: "dentist Thursday at 10" is an event. "Don't forget" is exempt from the DELETE keyword "forget".
- `forPerson: "self" | "partner"`. It is a role, not a name. The prompt receives the user's and the partner's `name`/`englishName`, plus "my wife/husband", "אשתי/בעלי", "жена/муж". Kids and anyone else count as `self`, with the name kept in the title.
- The title is the bare task in the speaker's language ("Call the plumber"), never "Remind Dana to…".
- **Time rules:**
  - A reminder has a start only, with no `endTime`.
  - A date with no time → `allDay: true`.
  - No date and no time → today, date-only.
  - Part-of-day words: morning 09:00, noon 12:00, afternoon 16:00, evening/tonight 20:00.
  - A bare hour that has already passed today means the next future one.
  - Relative times ("in 20 minutes") and repeats use the existing recurrence fields.
- `anchor: { description, offsetMinutes }` for "an hour before the dentist" (R11). `startDate`/`startTime` are then left empty.
- Statements like "I did it", "סיימתי" or "сделал" get `intent: "none"`, and nothing is created.
- Edit examples must not teach a reminder `newEndTime = start + 1h`. For reminders, edits move the single time.
- "Stop reminding me…", "תפסיק להזכיר", "хватит напоминать" → delete with scope `all`. "Skip today's" → `single`.

**Parser and `ParsedEvent`:**
- Accepts `kind`, `forPerson` and `anchor`.
- A reminder doesn't need `endTime`, and `end = start` is forced.
- `buildEventTimes` doesn't stretch an all-day reminder to 23:59.
- `correction-handler.ts` and the quick-fix "time" path carry the new fields, and a reminder's quick fix takes a single time.

**Resolution after parsing (server side):**
- **Calendar:** for `kind = reminder`, ignore the model's calendar and use `getMainNativeCalendar(creatorId)`: the creator's own non-deleted calendar labelled `primary`, oldest first; otherwise their oldest own calendar; otherwise `ensurePrimaryNativeCalendar`.
- **Target:**
  - `forPerson: partner` with an ACTIVE NATIVE partner who has a `telegramId` → `forUserId = partner`.
  - Partner paired but not on Telegram → the card says "Dana isn't on Telegram, so I can't ping her" and offers to keep it as the creator's.
  - Unpaired, or the partner is GOOGLE → the creator's. Like every self reminder, the card has no "for" part (§3.3).
  - Forwarded text is always the forwarder's: the prompt gets no partner names, and resolution forces self.
  - A partner-not-on-Telegram reminder never auto-creates; the card must ask "Keep as mine?".
- **Anchor:** `findMatchingEvent` over the creator's visible calendars, nearest upcoming occurrence; reminder time = its start + `offsetMinutes`.
  - No match, or several matches → a clarification message, and nothing is created.
  - An all-day anchor with an hour offset → ask for a time. With a day offset → a date-only reminder.

### 3.3 Card, auto-create, replies

- **Card:** `⏰ Call the plumber · Thu 10:00 · for Dana` (date-only: `· Thu`; for self: no "for" part). It shows no end time and no dead "📁 Cal" button. A date-only reminder for today created after 09:00 adds "No time set; it'll be in your summaries."
- **Auto-create:** the same rules as events (single intent, HIGH confidence, non-recurring, admin flag). Repeating reminders always get the card.
- **Bulk:** the multi-intent bulk card supports reminders. This needs the bulk-confirm crash fix in §11.
- **Replies:** the created message and the spoken reply have reminder variants ("I'll remind Dana tomorrow at 17:00", "Reminder set for today"). `{when}` is relative for today and tomorrow, otherwise "on Thu, Oct 15 at 10:00" (`bot.nativeReminders.when.*`).
- **HTML:** titles in the card and the ping are HTML-escaped. `escapeHtml` moves to the leaf module `src/utils/html.ts`; `confirmations.ts` re-exports it.

## 4. Firing

### 4.1 The pass

- `handleNativeReminders()` runs on its own `* * * * *` schedule in `src/cron/scheduler.ts`. It is **outside** `handleReminders`, which returns early on the alert toggles.
- It has its own try/catch and admin notification, and an in-process `running` flag so overlapping runs are skipped.
- It also has a manual trigger through the existing cron API pattern.
- **Gate (R7):** an in-process `nextDueAt` memo, starting at 0. The pass reads the database only when `now >= nextDueAt`. After a pass, `nextDueAt = min(earliest upcoming due, now + 60 min)`.
- `invalidateDueGate()` sets it to 0. Every reminder write in `event-store.ts` calls it, and so does every state write (snooze).
- If the admin flag is off, the pass does nothing.

### 4.2 Due times and eligibility

- **Candidates:** `NativeEvent` rows that are `kind = REMINDER`, not deleted, on a calendar that isn't deleted, and either repeating or with `startsAt` between −2 days and +26 hours. State rows with a `snoozedUntil` inside the window count too.
- **Expansion:** repeats go through `expandSeries`. Occurrence keys come **only** from `instanceStartsAt` and are never recomputed.
- **Due:**
  - Timed: the occurrence's start.
  - Date-only: 09:00 in the **recipient's** `resolveUserTimezone` on the occurrence's date. The date comes from the event's `timeZone`.
  - Snoozed: `snoozedUntil`.
- **Eligible when:**
  - `due ∈ [max(now − 60 min, armedAt − 15 min), now]`. `armedAt` is the series' value, or the override's `updatedAt` for a moved occurrence. The `armedAt` bound doesn't apply to snoozes.
  - Not done, and `lastPingedAt` is null or earlier than the due time.
  - Recipient checks: the effective owner has a `telegramId`, is not suspended, unreachable or blocked (`isIdentifierBlocked`), and the creator passes R3 access.
- **One live ping per series per pass:** if several occurrences of one series are due (a daily reminder snoozed to tomorrow morning), only the newest is pinged. The older ones get `lastPingedAt = now` without a send.
- **Effect:** a reminder created 10 minutes late for "in 2 minutes" still pings, and one created for a time that passed long ago doesn't ping but shows as open in the digest.

### 4.3 Atomic claim

Before sending, the pass claims the occurrence in one statement (`$queryRaw`, because Prisma's upsert can't be conditional):

```sql
INSERT INTO "NativeReminderState" (id, "seriesEventId", "originalStartsAt", "lastPingedAt", "pingAttempts", "createdAt", "updatedAt")
VALUES ($id, $series, $occ, now(), 1, now(), now())
ON CONFLICT ("seriesEventId", "originalStartsAt") DO UPDATE
  SET "lastPingedAt" = now(), "pingAttempts" = "NativeReminderState"."pingAttempts" + 1, "updatedAt" = now()
  WHERE "NativeReminderState"."doneAt" IS NULL
    AND ("NativeReminderState"."lastPingedAt" IS NULL OR "NativeReminderState"."lastPingedAt" < $due)
RETURNING id;
```

Only the process that gets a row back sends. That covers overlapping ticks and Railway's two processes during a deploy. The returned id goes into the buttons.

### 4.4 The ping

- **Text:** `⏰ <b>{title}</b>`. When the creator is not the recipient, a second line reads `from Raziel` / `מאת: רזיאל` / `от: Raziel`. The colon forms avoid gendered or declined grammar.
- **Keyboard:**
  - Row 1: `✅ Done`.
  - Row 2: `💤 15 min`, `💤 1 hour`, `💤 Tomorrow`.
- **After sending:** the message's chat and id are saved on the state row.

### 4.5 Send failures

| Failure | Handling |
|---|---|
| Transient (5xx, 429 including `retry_after`, network) | Release the claim: restore the previous `lastPingedAt`, conditional on the claimed value. Retry on later passes, up to 3 attempts in total (`pingAttempts`). |
| 403 the codebase's `isUnreachableError` recognises (blocked, deactivated, chat not found) | `markUserUnreachable`, keep the claim. |
| Any other 403 | Keep the claim and `captureError`. |
| Other 4xx | Keep the claim and `captureError`. |

## 5. Buttons

- **Callback data:**
  - `nr:d:<stateId>` (done)
  - `nr:s15:<stateId>`, `nr:s60:<stateId>` (snooze 15 or 60 minutes)
  - `nr:st:<stateId>` (snooze to tomorrow morning)

  Each is at most 43 bytes (the claim writes UUID state ids), within Telegram's 64, and the prefix doesn't collide with existing ones.
- **Handler:** `handleNativeReminderCallback`, routed in `webhook-handlers.ts`. It:
  1. answers the callback first;
  2. wraps everything in try/catch, so no 500 reaches Telegram and no redelivery follows;
  3. catches "message is not modified" and "query is too old".
- **Authentication:** `callbackQuery.from.id` → user. The tapper must be the effective owner or the creator (§2). Anyone else gets "This reminder isn't yours."
- **Re-validation on every tap** (buttons never expire): the series exists and isn't deleted; its calendar isn't deleted; it is still a REMINDER; the occurrence isn't cancelled or exdated; the state row still exists (a time change deletes it); the pairing is still ACTIVE when the tapper isn't the creator. When a check fails, the reply is "This reminder changed or no longer exists." and the buttons are removed.
- **Done:**
  - Writes `doneAt` and `doneByUserId` conditionally on `doneAt IS NULL`, so a double tap gets "Already done."
  - Edits the message to `✅ <title>` with no buttons.
  - If the tapper isn't the creator, sends the creator a silent `✅ Done by Dana: Buy milk` on Telegram (R12).
- **Snooze:**
  - Sets `snoozedUntil` to now + 15 minutes, now + 1 hour, or tomorrow morning (R6).
  - Edits the message to `💤 <title> · until 15:40` with no buttons.
  - Clears the due gate.
  - The re-ping is a fresh message with fresh buttons.

## 6. Summaries and week views

### 6.1 Reminders as events

- **Carrying the data:** the native provider passes the series row into `toUnifiedEvent`. `CalendarEvent` gains `eventType: 'reminder'` and an optional

  ```ts
  reminder?: {
    ownerIsViewer: boolean;
    creatorIsViewer: boolean;
    ownerName?: string;
    creatorName?: string;
    done?: boolean;      // this occurrence was marked done (dropped from digests)
    snoozed?: boolean;   // snoozed into the future (still counts as open)
    open?: boolean;      // due earlier on the summary day and still undone
    openSince?: string;  // yyyy-MM-dd of a carried-over occurrence
  }
  ```
- **Labels:**
  - `eventTimeLabel` and `formatEventForPrompt` print a reminder as `Reminder 10:00`, or `Reminder (all day)`, never `10:00 - 10:00`.
  - The week prompt builders' localized time labels get the same treatment.
- **`daySpanOf` fix:** a zero-length event is kept on the day when `dayStart <= start < dayEnd`. Today a timed item at 00:00 is dropped (§11).
- **Categorizing:**
  - Reminders are filed by **effective owner**, not calendar: the viewer's own go to `userEvents`, the partner's go to `spouseEvents`.
  - A reminder never lands in `otherEvents`, which feeds kid-name detection.
  - The prompt shows creator context: for the viewer: "(from Raziel)"; set by the viewer for the partner: "Dana: … (you asked)".
- **Inside the summary day:**
  - An occurrence that is already done is dropped.
  - One past due but undone is marked `(open)`.
  - A snoozed one counts as open.

### 6.2 Carry-over

- **Fetch:** `fetchOpenReminders(viewer, cutoff)` runs alongside the day fetch in `prepareSummaryForUser`. Its result is appended **after** `shapeEventsForDay` and before categorizing.
- **Cutoff:** `min(now, start of the summary day)` in the viewer's timezone.
- **Which reminders:** only ones whose effective owner or creator is the viewer (R1).
- **One-off:** undone and due before the cutoff.
- **Repeating:**
  - Only its latest occurrence before the cutoff, and only if that occurrence is undone.
  - Never an occurrence due before `series.armedAt − 15 min`: it was never armed or pinged (its time predates the series or its last time change), so "open" would be a phantom. One-offs have no such bound.
  - Suppressed when the same series has an occurrence on the summary day.
  - The new `latestOccurrenceBefore(series, overrides, cutoff)` in `recurrence.ts` applies exdates, CANCELLED occurrences and moved overrides.
- **Cap:** at most 5 lines, newest first, plus `and N more open` (R5).
- **Label:** `Reminder (open since Tue 12 Oct)`, localized.
- **Prompt rule (en/he/ru daily and tomorrow prompts):**
  - Mention open reminders briefly, as still-open to-dos with the day they were due.
  - Never give a reminder a duration.
  - A partner's reminder is attributed to the partner by name.
- **Voice shows:** they read the finished summary, so `prompts/voice-show/{en,he,ru}.ts` get one rule: reminders are one quick line each, open ones as "still open", never a segment.

### 6.3 Partner identity in built-in calendar digests (R8)

- **Labels from the viewer's side:** `getCalendarAssignmentsForUser` relabels calendars the viewer doesn't own: `yours` → `spouse`, `spouse` → `yours`, `primary` dropped (a partner calendar labelled `primary` alone becomes `spouse`). When a partner calendar relabels to `spouse` and has no `personName`, it fills `personName`, `personEnglishName` and `personGender` from the owner user. Partner `kids`/`birthdays` calendars stay unnamed, so the partner never shows up as a child.
- **Spouse info:** `getSpouseInfo` takes the resolved assignments, so built-in calendar users get the partner's name and gender.
- **Callers:** daily and tomorrow prompts (`summary.ts`), week prompts (`claude.ts` week builders), and the voice show context (`voice-show/context.ts`). Google users are unchanged.
- **Side effect:** a paired built-in calendar user's digest now puts the partner's events in the partner's section, by name, instead of under "Your Schedule".

### 6.4 Week views

- A reminder appears only on its own day, with the reminder label and attribution.
- Past reminders never appear in week views (`/week` starts at now), and daily reminders never appear there (existing lookahead filter).
- `formatTomorrowLookahead` prints reminder lines with the reminder label.

### 6.5 WhatsApp digests

Users on `messagingPlatform: 'all'` see reminders in their WhatsApp digest like events. No extra line is added.

## 7. Edit, delete, re-arm

- **Matching:** `findMatchingEvent` candidates:
  - tag reminders (`[reminder]`, `[reminder for Dana]`);
  - collapse a repeating series to its nearest upcoming occurrence;
  - add the viewer's open carried-over reminders, whatever their age.

  The matcher prefers events over reminders when a title matches both, unless the request says "reminder".
- **Times:** `convertEditRequestToUpdates` gives a reminder a single time. It never adds an hour, and an all-day reminder is never stretched to 23:59. The store forces zero length anyway (§1).
- **Re-arm:** in `updateNativeEvent`, a time or `allDay` change on a REMINDER deletes the affected state rows in the same transaction:
  - `single`: that occurrence's key;
  - `all`: every row of the series;
  - `following`: rows at or after the cut.

  It sets `armedAt`, clears the due gate, and, best-effort after commit, edits a live ping to `⏰ <title> · moved to Fri 10:00` with no buttons. A title or location change keeps the state.
- **Delete:** a soft delete, as today. Live pings lose their buttons on the next tap through re-validation. "Stop reminding me" maps to scope `all` (§3.2).
- **"Cancel that"** after creating a repeating reminder also matches by `recurringEventId` (§11).

## 8. Existing paths that must ignore reminders

- **Event alerts:** `getDueReminders` in `src/services/reminders.ts` skips `eventType === 'reminder'`. Otherwise a reminder would also get the "Auto-Reminder" alert and, on kids calendars, a pickup alert, for both partners.
- **Google users:** unchanged. They have no reminder prompt rules, aren't routed by the typed-text filter, and the reminder filter can never match a Google event.

## 9. Gating and admin

- **R3 is one helper:** `getReminderSupport(user) → { supported, reason }`. It is not cached itself; each message handler computes it once and passes it down (the admin flag and feature access underneath are Redis-cached). It fails closed if the feature check throws.
- **No downgrade notice:** the new pass never sends the event-alert "reminders paused" notice.
- **Admin flag:** the admin settings page gets a "Native reminders" toggle (`nativeRemindersEnabled`). The settings API accepts it as a partial update, following the toggle-sync pattern.
- **Analytics:** new `ActivityAction` values `native_reminder_created`, `native_reminder_pinged`, `native_reminder_done`, `native_reminder_snoozed`. `UsageCounter.remindersTriggered` is not incremented, because it counts event alerts.

## 10. Copy and i18n

- **New keys:** all new bot copy lives under `bot.nativeReminders.*` in `messages/{en,he,ru}.json`, added to all three together:
  - ping
  - from
  - buttons
  - done
  - snoozed until
  - already done
  - not yours
  - changed
  - done-by notice
  - moved
  - card lines
  - typed-route copy
  - partner-not-on-Telegram
  - no-time note
  - anchor clarifications
- **Parity check:** a parity check script, `scripts/check-i18n-parity.ts`, fails when the key sets differ.
- **Tone:** copy is natural and conversational in each language, not literal. It is gender-neutral where it names a person, so no gendered verbs.
- **Settings copy (R9):** "Event Reminders" → "Event alerts" / "התראות על אירועים" / "Уведомления о событиях".

## 11. Pre-existing bugs fixed here (the feature runs into each)

1. **Bulk confirm crash:** `getPendingBatch` returns dates as strings, and `handleBulkConfirmAll` then calls `startTime.toISOString()` after the first create. Revive the dates when reading.
2. **00:00 items dropped:** `daySpanOf` drops a zero-length timed item at 00:00 (probe-verified).
3. **"Cancel that" misses repeating native items:** it stores the bare cuid, but occurrences are `cuid#ISO`. Also match on `recurringEventId`.
4. **Wrong error UI:** a native `PERMISSION_DENIED` shows the Google re-auth button.
5. **Event alerts:** titles aren't HTML-escaped, and a 403 never marks the user unreachable.
6. **No partner identity in native digests:** fixed by R8.
7. **`UNTIL` drops the last day:** `UNTIL=YYYYMMDD` loses the last day's timed occurrence. UNTIL should become the end of that local day.
8. **Unknown callback prefixes:** they get no `answerCallbackQuery`, so the spinner hangs. Answer them.

## 12. Testing

The repo has no test runner. Tests are `tsx` smoke scripts, run under `TZ=UTC` and `TZ=Asia/Jerusalem`.
- **`scripts/smoke-native-reminders.ts` (new),** with a fake Prisma that has the new fields, a fake bot recorder that captures `replyMarkup`, and fake timezones. It covers:
  - eligibility (lookback, `armedAt`, snooze, date-only 09:00 across timezones and a DST day);
  - the claim (two concurrent passes → one ping);
  - one live ping per series;
  - send-failure release and the 3-attempt cap;
  - 403 → unreachable;
  - suspended, unreachable and blocked recipients;
  - the creator lacking access;
  - the admin flag off;
  - the due gate (memo, invalidation, 60-minute ceiling).
- **`scripts/smoke-native-reminder-buttons.ts`, for buttons:** owner, creator, ex-partner, stranger; double Done; a stale button after a re-arm or delete; snooze math including R6's 00:00–04:00 case; the creator's done notice.
- **`scripts/smoke-recurrence.ts`:** `latestOccurrenceBefore` with exdates, cancelled occurrences, overrides moved in and out, and DST; the `UNTIL` fix.
- **`scripts/smoke-day-shaping.ts`:**
  - reminder labels;
  - a 00:00 reminder kept;
  - a zero-length date-only reminder;
  - done, open and snoozed states inside the day;
  - open-since lines with the cap and the suppression rule;
  - owner and creator attribution;
  - partner relabelling (R8).
- **`scripts/smoke-week-lookahead.ts`:** reminders only on their own day, attribution, and `formatTomorrowLookahead`.
- **`scripts/smoke-reminders.ts`:** event alerts skip reminders.
- **Per-area scripts** (the File Structure table in the plan lists them all):
  - store (`smoke-native-reminder-store.ts`): edits keep zero length, the following split copies the fields, re-arm deletes state;
  - extraction (`smoke-native-reminder-creation.ts`): parser reminder fields, no `endTime` needed, date-only, zero length, byte-identical prompts when reminders are off;
  - creation flow, typed route, provider, digest, partner labels, support gate and edit/delete each get their own script.
- **`scripts/check-i18n-parity.ts`** passes.
- **Live Gemini check at MEDIUM thinking** (`scripts/eval-native-reminders.ts`), he/en/ru:
  - creation phrases: remind me, remind Dana, date-only, part of day, relative, repeating, anchor;
  - near-misses that must stay events;
  - "don't forget";
  - "I did it" → none.

  Plus a few generated digests with reminders. They must not show `HH:MM - HH:MM` for a reminder, and "open since" and the partner wording must read naturally.
- **Database pass:** a pass against a throwaway NATIVE pair in the dev database, as in commit `2b39a5b`.
- **Before main:** type-check, lint, all smoke scripts, a fresh-clone build (the build runs the migration), then the Railway and Vercel commit status.

## 13. Accepted limitations

- A partner in another timezone gets the date-only ping at their own 09:00, which can fall on a different date for them than for the creator.
- An edit that lands during a pass can cause one extra ping.
- Downtime longer than 60 minutes skips pings. The reminders still show as open in the digests.
- Users with no location fall back to Asia/Jerusalem (existing behaviour).
- Moving the anchor event doesn't move a reminder set relative to it.
- Typed edits and deletes need a reminder keyword in the message.
- The due-gate memo assumes one app process (Railway today). Inside that process it lives on `globalThis`, because Next 16 gives `instrumentation.ts` and the route handlers separate module instances. A second replica needs it moved to Redis.
- A "done" statement ("I did it", "סיימתי") creates nothing and gets the generic "didn't understand" reply. Marking done belongs to the ping buttons and the future calendar UI.
- After a series-level time change, an undone occurrence from before the change no longer carries over (state is re-keyed; see §6.2).
- A "from now on" edit that keeps the time carries the series' skipped and moved occurrences into the new series. One that changes the time drops them, as it does for events today.

# Google becomes a connection, and events move between FamCal and Google

Status: designed 2026-10-19 under the owner's delegation, then revised after code and product reviews (session scratchpad next/review-connection-*.md). It follows the model the owner agreed on 2026-10-15, and adds the owner's 2026-10-19 cross-source move idea: "switching events source between gcal and famcal … this way manual move can be a real thing". It builds on editing 3b (docs/superpowers/specs/2026-10-19-home-editing-3b-design.md) and Hebrew repeats (2026-10-19-hebrew-repeats-design.md). Research notes: next/facts-connection.md, facts-google-write.md, facts-critic.md §(b).

## 1. The model (owner rulings, 2026-10-15)
- **FamCal is for everyone.** Every user has FamCal, created lazily. A Google-only user's FamCal can stay empty, and nothing pushes them into it.
- **Google is an optional connection:** a token plus the chosen calendars. Connecting no longer flips the user's source or hides FamCal. Calendars hidden by past connects stay hidden, with no migration.
- **One calendar list** holds both kinds: the legend, the editor's Calendar row, the LLM's list and the summaries.
- **Routing.** The LLM routes a new event by calendar name or label. Anything it can't place goes to the default calendar (§3).
- **Reminders** always live in FamCal, on the creator's main FamCal calendar.
- **Google calendars are visible only to their owner.** Partners see them through Google's own sharing.
- **Cross-source move** (owner, 2026-10-19). The Calendar row lists both kinds. Picking the other kind moves the event: a copy there, then a delete here. Inside Google, 3b's `events.move` is used.

## 2. What changes for people
- **FamCal users** can connect Google from the ⋯ menu ("Connect Google Calendar"). After they choose calendars, those join the home, summaries and bot. Their FamCal calendars, partner and reminders stay.
- **Google users** (including those whose FamCal was hidden by an old connect) keep everything as now, including where unplaced events go (§3). They also gain:
  - FamCal reminders on Telegram;
  - the "+" for FamCal events;
  - pairing for shared FamCal calendars;
  - moving events between their calendars.
- **Banners, menu and nudges** follow the user's Google state:

  | Google state | Banner and menu | 07:00 nudge |
  | --- | --- | --- |
  | Never connected (no token, no live choices) | Connect, in the ⋯ menu only, never as a banner | none |
  | Token, no chosen calendars | Choose calendars | Choose calendars, at any account age |
  | Dead token or missing permissions (the token is kept), calendars chosen | Reconnect, by the read's answer | none (the cron can't see it; the summary's line says it) |
  | A legacy Google user (`calendarSource` GOOGLE) with no token, calendars stored | Reconnect | Reconnect |

  The OAuth setup track is removed everywhere: cron, admin buttons and admin reset.
- **Stale choices are none** (owner ruling, 2026-10-20). Some FamCal users (`calendarSource` NATIVE) have no token but old Google choices stored: migration 20260506000001 made every user without a token NATIVE, and a scope error used to clear only the token. `liveGoogleChoices(user)` (google-state.ts) counts the stored choices only with a token, or for a legacy Google user with none; a FamCal user's are relics and count as none. Every reader of the stored choices goes through it: `googleStateOf`, the union, `hasGoogleChoices` (the lazy main), the calendar totals, the 07:00 track query (`GOOGLE_NUDGE_WHERE`), the summaries, the editor, select-calendars, the admin card and stats, kid names, the voice show and the LLM context. Writes keep the column as it is. A scope error no longer clears the token (the select-calendars page and the bot's read answers), so no new relics are made; a reconnect replaces the token.
- **Disconnect.** A "Disconnect Google" entry is out of scope.

## 3. The default calendar
- **`defaultCalendarFor(calendars)`** is a pure rule over the union list. The first match wins:
  1. the user's own calendar labelled `primary` (when both kinds carry it, the Google one);
  2. the first own Google assignment labelled `yours`, else the first Google assignment;
  3. the main FamCal calendar.

  Partner rows never count (`labelsFromViewerSide` already strips their `primary`).
- **Where it applies.** The LLM resolver returns "no match" instead of `calendars[0]`, and the create site resolves the default. That covers every `'primary'` literal fallback: callbacks.ts, auto-create.ts, bulk-confirmations.ts:212 and :227, webhook-handlers.ts:1062, :1076, :1156, :1162, :1280 and :1312. The editor's default is the same rule for both kinds.
- **One primary across both lists.**
  - A save that adds `primary` to a calendar that didn't have it (stored labels compared with the new ones) removes it from every other own calendar of both kinds. That applies to the select-calendars POST, the FamCal PATCH and the FamCal POST.
  - A save that leaves `primary` as it was never touches the other list, so renames and label toggles are safe.
  - On select-calendars, ticking `primary` while a FamCal calendar holds it shows "New events will go to <name>".
- **Reminders** never use the default. They pin to `getMainNativeCalendar(creator)`; `parseReminderCreate` stops picking a Google `own`. When reminders aren't supported for the creator (no Telegram, or the plan has no reminders), a reminder request becomes an ordinary event in the default calendar, as Google users get today.
- **The lazy FamCal main** gets labels `['yours']` when the user has any Google choices, and `['primary', 'yours']` when they have none. With a Google `primary` that makes no double primary; without one the default stays the first Google `yours`, since a FamCal `primary` would win rule 1.

## 4. Server
- **The switches.**
  - `sourcesFor(user)` returns `['famcal', ...(token ? ['google'] : [])]`, and `readFamcal` drops its NATIVE gate.
  - `getCalendarAssignmentsForUser` returns the union: FamCal rows, then the Google assignments.
  - `hasUsableCalendar` is true when the user has any FamCal calendar (lazily) or Google with assignments.
  - `ensurePrimaryNativeCalendar` drops its NATIVE gate (onboarding.ts:23), with §3's labels.
- **Providers by calendar id.** `providerForCalendar(id)` sends `native:` ids to nativeProvider and the rest to googleProvider.
  - `fetchEventsInRange(user, ids, from, to)` splits the ids, asks each provider, and returns `{ events, failed: ('famcal' | 'google')[] }`. A failed half is logged and sent to Sentry, never thrown.
  - Callers:
    - the legacy alerts use `events`, so FamCal alerts survive a Google outage;
    - voice matching (event-resolution.ts:464) treats a failed Google half as "couldn't check Google" (the existing fetch-failed copy), not as no match.
  - All 15 `getProviderForUser` call sites switch: webhook-handlers.ts:1047, :1052, :1146, :1148, :1273, :1275, :1337, :1338, :1367, :1368; reminders.ts:162; bulk-confirmations.ts:199; event-resolution.ts:464; callbacks.ts:91, :297, :489; handler.ts:78, :186; auto-create.ts:99, :200.
  - Edit and delete route by the event's calendar id.
- **Gates that key on the target, not the user:**
  - callbacks.ts:79, :272 and :464 check the token only when the target id isn't `native:`;
  - callbacks.ts:171, :346 and :527 pick the denied copy by the target's provider.
- **The source column.** Nothing gates on `User.calendarSource` any more. It is read only as `liveGoogleChoices`' legacy marker (§2, stale choices), and is dropped in a later cleanup once no legacy Google user is without a token. Changes:
  - `commitGoogleToken` stops flipping and stops soft-deleting.
  - The pairing gates go (`INVITER_NOT_NATIVE` / `INVITEE_NOT_NATIVE`, the conditional link at pairing-service.ts:237), and api/pair:21.
  - native-calendars POST's `native_only` goes, and so do the page notices.
  - Reminder-cache eligibility (handlers.ts:52-58, settings/route.ts:112, account-linking.ts:445) drops the source term. The cached `calendarSource` field is unread.
  - summary.ts:558-563: `hasBackend` is always true, and `assignments` is the union.
  - week-lookahead branches on the event's calendar id (`fetchMasterEventRecurrence` and the early returns at :341 and :414).
  - claude.ts, telegram/voice.ts, kid-name detection and voice-show read the union. The kid-name write-back writes `NativeCalendar.personName` for a FamCal calendar.
  - **Client:** props send `sources` (from `sourcesFor`), `googleConnected` and `googleState`, instead of `calendarSource`. `homeSources`, `setupNeeded`, the banners, MenuSheet, PageGate's default and the editor gates use them.
- **WA→TG merge** (account-linking.ts):
  - `wHasGoogle` is "W has a token". W's Google moves when T has no token. The T-unpaired and T-has-no-events conditions go, and T's calendars are never soft-deleted.
  - The pairing move drops `tIsNative` and the source condition.
  - After the merge, primary uniqueness runs once, and T's primary wins. When W's Google moves with no `primary`, a fresh T's empty default (one W's calendar did not replace) gives up `primary` too, so W's default stays the first Google `yours`. The mirror case: when T keeps Google choices of its own (token or not) and had no FamCal primary (a legacy Google user's FamCal was hidden), W's FamCal primary comes over without `primary`, so T's default stays its Google one.
  - `afterMerge`'s `remindable` drops the source term.
- **Native reminders.**
  - `getReminderSupport` drops `not_native`, and the open-reminder readers and voice's `openReminderCandidates` serve everyone. The plan and Telegram gates stay, so a Basic user sees no reminders section.
  - `resolve.ts`, `item-info.ts` and 3b's recipient rule stop requiring a NATIVE partner; Telegram and an active pairing stay.
  - `ownership.ts` stops reading the column.
- **3b's per-source branches become per-calendar.**
  - The editor info returns the union: FamCal kinds and the partner by FamCal rules, plus the writable Google calendars.
  - A failed `calendarList` drops only the Google rows, and is logged.
  - `main` follows §3.
- **Summaries.** A failed Google half never hides the FamCal half.
  - `throwForDigest` throws for a FamCal error. For a Google failure it throws only when the FamCal half is empty.
  - Otherwise, `reconnect` sends the summary with the FamCal items plus the existing token-expired line and button, and marks it sent. GOOGLE_FETCH_FAILED goes to the retry queue as today.
  - The outage run (`googleOut`) reads FamCal only (`sources: ['famcal']`), and its week block too.
  - `googleWithoutToken` is deleted.
- **Calendar limit.** One shared total: own FamCal calendars plus Google assignments, not counting the FamCal main when the user has Google assignments. `checkCalendarLimit(userId, afterSaveTotal)` blocks only when the total exceeds the limit **and** the save raises the user's current total, so existing setups keep working.
- **Admin.** Badges and stats show "Google connected" by token, and `calendarsCount` counts both kinds.

## 5. The cross-source move
- **Where.** The 3b Calendar row's `moveTargets` adds the other kind's writable calendars for an event. Reminders have no row.
- **Eligibility:**
  - **A Google source:**
    - 3b §2.4's editable test (no other guests, organizer, default type, not locked, writable);
    - no `conferenceData` and no `attachments`. Otherwise: "This one has a video call or files, so it stays in Google Calendar".
  - **A FamCal source:**
    - the source calendar is the user's own. A partner's event never leaves the partner's view.
    - no Hebrew rule ("Google Calendar can't repeat by the Hebrew date").
  - **Any repeat** that can't cross is refused: an RDATE, a rule part `assertStorableRule` refuses, a series whose start isn't one of its own slots, or an override whose slot the copy's rule wouldn't yield. The reason: "This repeat can't be moved".
  - **Into a shared calendar.** A move from Google into a FamCal calendar that isn't PRIVATE shows "Your partner will see this" in the sheet.
- **Saved alone.** A cross-source move has no other changes in its save. If any field changed, Save shows "Save the move on its own first." and nothing is written.
  - For a series, the move takes the whole series: the scope sheet offers only "All of them", with "Moving to another kind of calendar moves the whole series."
  - The sheet notes "Alerts and colour follow the new calendar."
- **One mapper** (`src/services/calendar-move/mapper.ts`), shared with the later sync:
  - **FamCal → Google:**
    - **Basics.** Title, location and notes. Times in the series' own zone (`timeZone` on start and end). An all-day end becomes the exclusive next day.
    - **Recurrence.** `RRULE:` plus the rule:
      - a floating UNTIL on a timed series becomes UTC `…Z`;
      - a date-only UNTIL on a timed series becomes that day's 23:59:59 in the zone, sent as UTC `…Z`;
      - a date-only UNTIL on an all-day series stays a date.
    - **Exceptions.** `EXDATE` lines carry the exdates and CANCELLED rows: TZID form in the series' zone for timed, VALUE=DATE for all-day.
    - **Marker.** `extendedProperties.private.famcalMovedFrom` = the series id.
    - **Overrides.** After the insert, each OVERRIDE row patches its instance. The instance is found with `events.instances({ eventId, originalStart })` and matched as an instant.
  - **Google → FamCal:**
    - **Reading.** `events.get` (master), then `events.list({ iCalUID, singleEvents: false, showDeleted: true })`. Only items with `recurringEventId === masterId` and a slot the rule yields are kept, which drops strays and a cancelled master.
    - **Recurrence.** RRULE becomes `rrule` (validated; a `Z` UNTIL becomes floating local time in the event's zone). EXDATE values, in every form (`;TZID=…:a,b`, `:…Z`, `;VALUE=DATE:…`, several lines), become exactly the instants `expandSeries` yields (all-day: 00:00 local). Cancelled exceptions become exdates too. An unparseable line refuses the move.
    - **Exceptions and fields.** Modified exceptions become OVERRIDE rows. All-day ends become 23:59 on the day before Google's exclusive end, for the series and each exception (`dayEnd`). The description becomes plain text, and the zone is `start.timeZone`, else the calendar's.
    - **Write.** A new store function, `createNativeSeries({ …, exdates, overrides })`, writes everything in one transaction.
- **Order and safety.**
  - **Lock.** A move takes a fail-closed Redis NX lock on the source series id for its whole run (not the fail-open voice lock). A second save gets busy.
  - **Copy, then delete.** The copy is created first and made whole (every patch or row). Only then is the original deleted.
  - **When the delete fails,** the original is read again:
    - gone (404, 410, `cancelled` or `isDeleted`): the move counts as done;
    - confirmed present: the copy is deleted and the user gets "Couldn't move. Try again";
    - unreadable: both are left, both ids are logged and sent to Sentry, and the user gets "Moved, but the old one is still in <calendar>". A failed compensation shows the same message.
  - **A copy that fails part-way** is deleted, and the original is untouched.
  - **Retries.** A retry into Google first looks for an existing copy in the destination calendar only (`privateExtendedProperty=famcalMovedFrom=<id>`). It re-applies every override and cancellation to that copy before deleting the original. A copy found elsewhere is logged and left. The sync later never treats `famcalMovedFrom` as a mirror key.
  - **Logging.** Ids only, never titles.
- **What doesn't move.** The Google id and its links, colour and alert overrides. Events with a Meet link or attachments aren't eligible. The copy takes the destination's default alerts, and FamCal events get the legacy alerts when they're on.
- **The home.**
  - After a move the client drops the old key from its source at once (a new store op, `dropItem(key)`), refetches both sources and follows the new key across kinds. The new key is the opened occurrence's: the Google instance id via `originalStart`, or `famcal|<newSeries>#<ISO>`.
  - The sheet closes only if neither answer has it.
- **Analytics.** `calendar_item_moved { from, to, recurring, source: 'app' }`, a new action in the union.

## 6. Copy
New keys, natural in en, he and ru: gender-neutral Hebrew, and the formal вы in Russian.
- the menu's Connect Google entry, and the select-calendars note "New events will go to <name>";
- the cross-source scope line, "Save the move on its own first.", "Your partner will see this" and "Alerts and colour follow the new calendar.";
- the can't-move reasons: "This one has a video call or files, so it stays in Google Calendar", "Google Calendar can't repeat by the Hebrew date", "This repeat can't be moved";
- the move errors: "Couldn't move. Try again" and "Moved, but the old one is still in <calendar>".

The reconnect and choose-calendars keys are reused.

## 7. Tests
- **smoke-calendar-connection** (new):
  - `sourcesFor`;
  - the union order;
  - `defaultCalendarFor` across the cases (including Google-only users with no primary);
  - primary uniqueness only when newly added;
  - the lazy main's labels;
  - `providerForCalendar` and the split fetch with each half failing;
  - connect not flipping or hiding;
  - pairing with a Google user;
  - reminders for a Google user, including the plan fallback;
  - the limit (shared, over-limit setups kept, `>` not `>=`);
  - the WA→TG merge carrying a token from a NATIVE W;
  - the Google states and nudges.
- **smoke-calendar-move** (new), with fake Prisma and fake Google:
  - both directions for a one-off, a timed series with exdates, cancellations and overrides, and an all-day series;
  - every UNTIL form across DST;
  - every EXDATE form;
  - the refusals (guests, Meet, partner source, Hebrew, RDATE, start not a slot, an unyielded override, other fields changed);
  - the lock;
  - compensation at every failure point, including a delete that applied and a 404;
  - the retry reusing and repairing the copy;
  - strays and a cancelled master in the iCalUID list;
  - analytics with no titles in logs.
- **The existing smokes:**
  - voice: routing by id, the reminder pin, the default for Google-only users, the target-keyed token and denied copy;
  - digest: a FamCal half kept on reconnect and outage, FamCal-only users unaffected;
  - week-lookahead with mixed ids;
  - legacy alerts with a failed Google half;
  - render: banners and menu by Google state, the "+" and reminders for Google users, mixed calendar rows, the cross-source scope sheet and notes, and `dropItem` on move;
  - page-auth;
  - the admin stats.

## 8. Risks
- Google's `iCalUID` listing returning exceptions is unverified in-repo. The filter keeps only matching items, and an event whose exceptions don't come back moves without them. The owner's prod test is the check.

### Known limitations (shipped on purpose)
- No "Disconnect Google".
- A cross-source move takes whole series only and must be saved on its own. Events with Meet links or files, and Hebrew-rule or RDATE series, can't cross.
- A Google → FamCal retry after a failed compensation can leave a duplicate FamCal series (logged to Sentry).
- A moved event can get a second legacy alert the same day (the dedup key is per event id).

# Editor upgrades: pickers, alerts, repeats, drag to move

Approved by the owner, 2026-10-25. Four owner-approved parts, built and shipped in this order, each
on its own (part 3's "until" uses part 1's picker).

**Shared ground.** Only the Mini App changes; the chat bot (Telegram, WhatsApp) parses as today. In a
plain browser the home looks the same, the sheets' Close button stands in for the BackButton and
haptics do nothing. Copy goes in `messages/{en,he,ru}.json`: Hebrew gender-neutral (infinitives,
plurals, nouns), Russian formal (вы). Times are 24h, left to right. Tests are smoke scripts in
`scripts/`, with the DB, Google and Telegram mocked.

## 1. Date and time pickers (L)

**Behaviour.** One pair, `DatePickerSheet` and `TimePickerSheet`, serves the editor's start and end,
part 3's "until" and Settings' reminder time. They replace the native inputs in `form-kit.tsx`
`PillRow` and the reminder-time `<select>` in `SettingsClient.tsx`.
- Date pill: "Sun, 14 Mar 2027", with the Hebrew date under it while the home shows Hebrew dates
  ("ה׳ אדר ב׳ תשפ״ז"). Time pill: "09:30". A tap opens the sheet.
- **Date sheet**: the home's month grid in small (`grid.ts`, `hebrew-date.ts`). A cell has the
  Gregorian day and the Hebrew day (with the month on its 1st). A tap picks and closes. Days past a
  limit are greyed and can't be picked (end and "until" not before the start).
- **Gregorian | Hebrew** (form-kit `Segmented`, only while Hebrew dates are on). In Hebrew mode a
  page is one Hebrew month (1 to 29/30) and the Hebrew day is the big number. Chevrons step Hebrew
  months with hebcal `HDate`: leap years run Shvat, Adar I, Adar II, Nisan; common years Shvat,
  Adar, Nisan. Title "Adar II 5787" over "Mar – Apr 2027". A Hebrew yearly repeat (new or stored)
  opens the sheet in Hebrew mode; otherwise Gregorian, nothing remembered.
- **Jump far**: tapping the title swaps the grid for month and year wheels; Done returns to the grid
  on that month. Years 1900–2100 (5660–5861). The Hebrew month wheel lists Adar I and II only in
  leap years; Adar I or II moved to a common year lands on Adar.
- Footer: the choice in both calendars ("Sunday, 14 March 2027 · 5 Adar II 5787") and Today.
- **Time sheet**: hours and minutes wheels, looping, left to right; 5-minute steps in the editor, 15
  in Settings (`REMINDER_TIME_STEP_MINUTES`). A stored off-step minute (10:07 from Google or the
  bot) joins the wheel, so open and close changes nothing. Done applies; scrim, Back and Escape
  cancel. Moving the start still keeps the length (`moveStart`).

**Look** (frontend-design pass, inside the home's system, no new colour). `BottomSheet` on
`--ch-section`; the chosen day `--ch-selected`/`--ch-selected-text` as in Month picked, today's
number `--ch-accent`, the second date line `--ch-muted` at 11px, the wheel band `--ch-surface`, Done
`.ch-btn-primary` as Save. The one memorable thing: every cell carries both calendars and the switch
swaps which leads, never a second grid. The body is always six rows high (wheels fill the same box),
so paging never makes the sheet jump. At 360px: seven 46px columns in 16px gutters, 48px rows, about
520px tall. RTL: chevrons flip (`.ch-flip`), the date wheels follow reading order, the time wheels
stay left to right. Pages slide 120ms in reading direction, not under `prefers-reduced-motion`.

```
 [‹]      March 2027        [›]      ← tap the title: wheels
          Adar – Nisan 5787
 [ Gregorian | Hebrew ]
  S    M    T    W    T    F    S
  .    1    2    3    4    5    6     (6 rows; chosen day = text and background swapped)
      כ״ב  כ״ג  כ״ד  כ״ה  כ״ו  כ״ז
 Sunday, 14 March 2027 · ה׳ אדר ב׳     [Today]
```

**Library.** `@ncdai/react-wheel-picker` 1.2.3 (MIT, Aug 2026, peers React ^19, `"use client"`,
already in CalBrew): unstyled with data attributes, so it takes our tokens; it handles arrows,
Home/End and type-ahead and blocks touch scroll inside a wheel, but sets no ARIA, so our wrapper
adds `role="spinbutton"`, `aria-label`, `aria-valuetext`. Fallback: CSS scroll-snap columns.

**Data and API.** The 2000–2100 limit (`editor-model.ts`, `calendar-write/walltime.ts`) opens to
1900 for one-off and yearly items (Gregorian or Hebrew), so a birth date fits, which the anniversary
count wants. Other repeats keep 2000 with an inline error: the expander walks a series from its
start, so a daily series from 1950 costs about 27k steps per read. Paging, limits, wheel lists and
labels go in a pure `src/lib/calendar-view/picker-model.ts`; `PillRow` adds `mode` and `min`.

**A yearly series moved with "All"** (owner ruling 2026-10-25, found in review). The count hint asks
for the original date, so a user opens this year's birthday and picks 1985. Moving the series start
by the same number of days (today's `seriesTimesFor`) lands in the wrong year and slips a day on leap
and Hebrew years (15 Shvat became 14 Shvat). For a yearly series (Gregorian `FREQ=YEARLY` that follows
its start, or a Hebrew one): a new date half a year or more from the opened occurrence becomes the
series' first date (start and Hebrew anchor exactly the picked date); a nearer one keeps the first
year and puts every year on the picked month and day (Hebrew: the first Hebrew year, the picked
Hebrew month and day, Adar per hebcal). Other rules keep the day shift. One rule for FamCal, the
store and Google masters (the editor's All goes through the store's occurrence path, as the bot's
does). A moved start outside the year floor is refused (`invalid`, `start`, reason `year`, which the
editor shows on the start row). As built: a near move carries a change of year (Dec 31 → Jan 1
starts a 2020 series on 2021-01-01); a far move, or a near one whose years change (onto 29 Feb),
turns a COUNT into an end on its last year, and one past the series' end leaves the picked date
alone; a Hebrew near move keeps the anchor's year (the count stays); All from a rolled Hebrew year
now moves every year to the picked day, refused only where the anchor's year lacks that date (30
Cheshvan or Kislev in a short year, Adar I in a common one). All back onto the series' own day brings
an occurrence moved on its own back to it (FamCal and Google); a Google RDATE keeps its own day, in
its year plus the move's change of year.

**Telegram and web.** CalendarHome stays the BackButton's only owner; the editor's cancel chain
closes an open picker first, as it does the scope sheet. Settings shows the BackButton while its
picker is open. Vertical swipes lock while a picker is open (a wheel dragged down would minimize the
app): CalendarHome's one `useTelegramVerticalSwipes` call becomes `browsing || pickerOpen ||
dragging`. Settings is outside `.ch-home`, so its picker brings the scope (`HOME_THEME_CSS`,
`data-theme`, `dir`). Haptic `selectionChanged` on a day tap and when a wheel settles.

**Keyboard and screen reader.** The grid is `role="grid"` with one focus stop: arrows by day and
week, PageUp/PageDown by month, Home/End to the week's ends, Enter or Space picks. Labels read like
browse ("Sunday, 14 March 2027, 5 Adar II") with `aria-selected`, `aria-current="date"`,
`aria-disabled`; the title is `aria-live="polite"`. Focus lands on the chosen day, back on the pill
on close.

**Failure.** Client-only, no fetch, only real days pickable; a chunk that fails to load falls to the
home's error boundary. **i18n.** `calendarHome.picker.{gregorian, hebrew, today, done, chooseMonth,
prevMonth, nextMonth, hour, minute, dateSheet, timeSheet}`; Hebrew nouns (שעה, דקות, היום, אישור),
Russian «Готово», «Выберите месяц».
**Tests.** New `scripts/smoke-date-picker.ts`: Hebrew paging over leap and common years, 30 Adar I,
Adar II to Adar on a year change, six-row pages, limits, the off-step minute, the 5 and 15 lists,
labels in three languages, the floor (1950 yearly accepted, 1950 daily refused). Render smoke of
both sheets in he, en, ru, light and dark.

## 2. Alerts per event (M)

**Today.** `getReminderMinutes` (`src/services/reminders.ts`): a Google event with its own
reminders pings once, at its nearest popup (else nearest email); everything else at the user's
default lead (Settings, Pro). FamCal events reach the pass via `native-provider.ts` with `reminders:
undefined`, so `NativeEvent.reminderMinutes` is never read, and nothing writes it. All-day events
never alert; alerts are Telegram only; FamCal's Google copies carry none and are left out of reads.

**Behaviour.** An Alert row for timed events (hidden for all-day events and reminders): Default
("Default (15 min before)", from the user's lead), None, At start, 5, 10, 15, 30 min, 1 h, 2 h,
1 day (`MAX_LEAD_MINUTES`). Shown only when an alert can reach the user: Settings' own condition
(alerts on, admin switch, plan) and a Telegram chat. On a series it's series-level, like a calendar
change (ScopeSheet: "this one and the ones after" or "all"). The cross-source move keeps its ruling:
alerts don't move. Google items (ruling E): the row shows Google's own alert read-only ("From Google
Calendar: 30 min before"), or the default when the event has none.

**Data and API.**
- Migration: `alertMinutes Int[] @default([])` and `ownAlerts Boolean @default(false)` replace
  `reminderMinutes` (Prisma lists can't be null): false = default, true with [] = None. A non-null
  `reminderMinutes` is copied (expected zero rows; read-only count first).
- `CreateItemBody` and `UpdateItemBody.changes` get `alert?: 'default' | 'none' | number` (listed
  values only); `ItemEditInfoResponse.alert` prefills; `EditorInfoResponse` adds `alertsOn`,
  `defaultLead`.
- Pass: `native-provider` sets `CalendarEvent.alertLeads` when `ownAlerts`; `getReminderMinutes`
  reads it first. Google path and pickups (same lead) unchanged; one lead per event (ruling
  A), so today's dedup key stays.

**Platforms.** Telegram only, as now; chat-created events keep the default. **Failure.** A bad
value: 400 `invalid`, field `alert`, inline under the row; pass errors already go to Sentry.
**i18n.** `editor.alert.{label, default, none, atStart, before, fromGoogle}` with ICU plurals («за 1
минуту», «за 5 минут»; «דקה אחת לפני», «5 דקות לפני»).
**Tests.** Extend `smoke-native-provider-reminders.ts` (own lead, None, default); a reminders case
(Google's nearest popup still wins, all-day skipped, no duplicate after the key change);
`smoke-calendar-editor-api.ts` (create and patch with an alert, series scope, validation); the copy
migration.

**As built.** None (an own alert with no lead) silences the event: no start ping and no pickup ping. An
alert change is series-level, like a calendar change (ScopeSheet "this one and the ones after" or "all";
"only this one" is refused on a series; the tail gets the new alert, the head keeps its own). Reminders
and all-day events have no Alert row; an all-day event keeps a stored alert, which shows again when it is
made timed. A Google event's alert is read-only (its nearest popup, else its nearest email, else
Default), and so is the row for a new event on a Google calendar; a lead off the list is shown as it is
and a stored off-list lead stays an option of its own. Alerts don't cross kinds: moving to Google drops
the own alert, moving to FamCal lands on Default; while such a move is picked the row shows Default
read-only, and an alert edited before it goes back, so the move is saved alone. `reminderMinutes` stays in the database for this deploy
(the old Prisma client still selects it while the migration runs); a later migration drops it.

## 3. Richer repeats (L)

**What already works.** The expander is rrule.js; `assertStorableRule` keeps INTERVAL, BYDAY (with
ordinals ±1..53), BYMONTHDAY, BYMONTH, UNTIL, COUNT. So "2nd Tuesday" is `BYDAY=2TU`, "last Tuesday"
`BYDAY=-1TU`, no BYSETPOS. A Hebrew rule is FREQ=YEARLY with INTERVAL, UNTIL or COUNT only. The bot
already writes INTERVAL, BYDAY, UNTIL, COUNT (`buildRecurrenceRule`), which the editor calls
"custom" (`classifyRule`). For Google, the mapper refuses a rule whose start isn't one of its days.

**Behaviour.** The Repeat row opens a Repeat sheet of form-kit cards, a summary on top that is also
the row's value ("Every 2 weeks on Sun and Tue, until 1 Mar").
- Frequency: Never, Daily, Weekly, Monthly, Yearly, Every year on the Hebrew date. Every [N] days,
  weeks, months or years: a stepper with 44px − and +.
- Weekly: weekday chips from the week start; the start's day is always on, so the start is always a
  day of the series (Google and the cross-source move need that).
- Monthly: "On day 14" or "On the second Tuesday", plus "On the last Tuesday" when the start is in
  the month's last seven days.
- Ends: Never, On <date> (part 1's picker, not before the start), After [N] times. Hebrew gets Ends
  and "every N years" (ruling B).
- A rule the sheet can't say stays "custom", kept unless changed (3b). Today's edit rules stay: a
  repeat change applies from this occurrence on, the end carries (`endCarriedRule`), a series on
  set weekdays moves days "only this one".

**Data and API.** `repeat` takes the old `RepeatChoice` string (cached clients) or `RepeatSpec
{ freq, interval, byDay?, monthly?: 'day' | 'weekday', until?, count? }`. One builder, `ruleOfSpec`
(beside `ruleFor` in `calendar-write/write.ts`), writes the RRULE for FamCal and Google items, then
`assertStorableRule`. `RepeatInfo` adds `until`, `count`, ordinal `byDay`, `byMonthDay`; item info
returns `series.spec` when the sheet can say the rule. The Google copy, the cross-source move and
Google edits need no new mapping, since the start is always a slot.

**Platforms.** The bot is unchanged; rules it made now open with their real words. **Failure.**
`NativeRuleError`: 400 `invalid`, field `repeat`, inline; a Google refusal gets today's copy.
**i18n.** ICU plurals for N; monthly ordinals `select` on the weekday, as Russian agrees in gender
(«каждый второй вторник», «каждую вторую среду»); Hebrew «ביום שלישי השני בכל חודש».
**Tests.** New `scripts/smoke-repeat-spec.ts`: spec to rule to occurrences (2TU, -1TU, interval,
until, count, weekdays with the start pinned), rule back to spec, custom stays custom, Hebrew ends,
`ruleCrosses` true for every spec, a following split with a COUNT; API validation of both bodies.

## 4. Drag to move (L)

**Behaviour.**
- A long-press (450ms, under 8px of movement) lifts an item; moving sooner scrolls, a short tap
  still opens. Lifted, it follows the finger as a ghost, the origin dims, the day under the finger
  gets a 2px `--ch-accent` outline. Browse scrolls at the edges; in picked, 600ms over a chevron
  turns the month.
- On drop only the day changes (time and length kept; a multi-day item shifts by the days between
  the grabbed and drop days). Its own day or outside the grid: nothing.
- Where (ruling C): picked, a row of the day's list onto the grid above; browse, a chip onto a cell. Not
  the Agenda (no empty days to drop on).
- What (ruling D): items the user can edit. Never read-only calendars, holidays or daily repeats (a day
  move doubles a day). Long-press on one that can't move: warning haptic, "This calendar can't be
  changed here".
- Repeating: the drop opens the editor's ScopeSheet (`scopePlan` on a form built from the item); a
  set-weekdays series offers "Only this one". A Hebrew series follows the store ("all" moves its
  anchor, a rolled year is refused with today's error). Days are read in the series' zone.
- Save: optimistic, with a pending look; PATCH via `editor-client`; on success `refreshWritten` and
  the Undo bar; on failure it snaps back, the bar shows the editor's error copy, and it's logged
  with the key and scope.
- Undo: "Moved to Thu, 15 Oct · Undo", 6s, `aria-live`. It sends the move back with the same scope
  on the key the PATCH answered. Not after "this one and the ones after": that split can't be
  cleanly undone, and the ScopeSheet already asked.

**Data and API.** The PATCH is unchanged. `ItemDTO` gains `canEdit` (calendar access, the
reminder's creator, a Google calendar's role), since today's `readOnly` only means "from Google".
The server still checks every write. **Library.** `@dnd-kit/core` 6.3.1 (MIT, React >=16.8; touch
sensor with delay and tolerance, auto-scroll, mouse sensor); stable but quiet since Nov 2024, and
`@dnd-kit/react` is still 0.5.

**Telegram and web.** On lift: the shared swipe lock, `touchmove` blocked, `-webkit-touch-callout:
none` and `user-select: none` on items so iOS opens no text menu. The BackButton cancels a lift.
`HapticFeedback`: `impactOccurred('medium')` on lift, `selectionChanged` per new day,
`notificationOccurred(success | error | warning)` on the outcome. Web: mouse drag (6px), no
haptics. No keyboard drag: the date picker stays the accessible way to move an item.
**i18n.** `calendarHome.drag.{moved, undo, undone, cantMove, failed}`; ScopeSheet copy reused.
**Tests.** New `scripts/smoke-drag-move.ts`: target-day maths (timed, all-day, multi-day, past
midnight, DST day), which items lift, scope choices per series type, the undo body and none after
"following"; `canEdit` per source.

## Risks

- On iOS `disableVerticalSwipes` may not stop a touch already in progress, so a drag in picked could
  minimize the app. Test on iOS and Android; fallback: lock swipes in all of picked (Ruling 9, owner).
- Small targets: browse cells are about 47 × 92px with three slots at 360px (hit area: full width).
- The wheel library has no ARIA (our wrapper adds it); the 1900 floor needs its non-yearly guard.
- Undo after "all" can't restore a 31st monthly series' skipped months exactly (rare). Settings
  isn't redesigned (F1 deferred), so its picker looks like the home on an older page.

## Sizes

1 Pickers L · 2 Alerts M · 3 Repeats L · 4 Drag L.

## Owner rulings (2026-10-25: "all recommended")

- **A. Alerts per event:** one per event: Default, None or a set time.
- **B. Repeat options:** all five (until, N times, weekdays, every N, Nth weekday), and every N years
  for Hebrew repeats.
- **C. Drag where:** Month picked and browse; not the Agenda.
- **D. Drag what:** everything the editor can change: own FamCal, the partner's shared calendar,
  writable Google calendars.
- **E. A Google event's alert:** shown only ("From Google Calendar: 30 min before"), not editable.
- **F. Plans:** the Alert row follows Settings (hidden without the alerts plan); pickers, repeats and
  drag on every plan.

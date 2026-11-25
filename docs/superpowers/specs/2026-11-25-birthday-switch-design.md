# Birthday switch — design

Owner 2026-11-25: "we should make some special event type for birthdays". Approved in chat ("good", with the civil-date age added), item by item, below.

## Why

People save a birthday as just the person's name ("Dana"), every year on the Hebrew date. FamCal then has no idea it is a birthday: the summaries and voice notes say "Dana" and drop the age (their year-count rule uses the count only when the title says what is counted), and the calendar shows "Dana" with a bare 35 pill.

## What changes (owner's choices)

1. **A Birthday switch in the event editor** (owner chose a switch over a third Type and over guessing from titles). It shows only on an all-day Event (not a Reminder) whose Repeat is "Every year" or "Every year on the Hebrew date". Changing the repeat to anything else, or turning All day off, hides the switch and saves it off. The title stays what the person typed. (All-day only is Claude's call: a birthday is a date, and the summaries show a birthday with no time, as Google's are.)
2. **The calendar screen shows a cake, not words** (owner: "replace with just some icon"). Lucide `Cake`, before the title, where the reminder icon sits on a reminder row; the title and the anniversary pill stay as they are. Readers get "Birthday" as visually hidden text.
3. **The summaries and voice notes say it is a birthday**, with the age when there is one ("Dana's 35th birthday", "יום הולדת 35 לדנה"): the model words it, so Russian names decline naturally.
4. **The copy in Google is unchanged** ("Dana (35)", owner: "google 2"). It is built from the stored series (`toGoogleEvent` / `toGoogleHebrewSingles` in `src/services/calendar-move/mapper.ts`), never from the unified event's `eventType`, so it stays unchanged by construction; a smoke pins that a birthday series maps exactly as the same series without the switch. Converting it to Google's own birthday event type was looked at and dropped (owner: "skip it, not important"): Google's birthday type must repeat every civil year as one series, so a Hebrew-date birthday (one Google event per year) can't be one, and it carries only title, colour and reminders.
5. **Existing data is not touched.** The owner turns the switch on for their saved birthdays in the editor.

## How it flows (the parts decided here)

- **Stored on the series:** `NativeEvent.birthday Boolean @default(false)`, with a migration. It is a series-level property, like the calendar and the alerts: an occurrence never has its own. A "from this one on" split carries it to the new series. The store refuses `birthday: true` on a REMINDER, on a timed series, or on a series that is not yearly (FREQ=YEARLY rrule, or the Hebrew 'anniversary' rule), and a change that leaves yearly or all-day clears it.
- **Editing scope:** the switch is a series-level change, so a save that changes it takes `scopePlan`'s existing series-level rule, alone or with other changes in the same save: "This one only" is not offered, as for a calendar or alert change. There is no single-occurrence birthday.
- **Readers:** `toUnifiedEvent` (`src/services/calendar-provider/native-provider.ts`) gives a birthday series `eventType: 'birthday'`. From there the existing Google-birthday handling applies with no new code path: `isBirthdayEvent` makes the summaries' line "(Birthday)" with no time, and Ask FamCal in a chat stops counting it as busy (`busyIntervals` already skips birthdays; today a FamCal "Dana" all-day event makes the person busy all day).
- **The home's item DTO:** `birthday` is no longer "Google only": a FamCal birthday sets it too (`src/services/calendar-read/dto.ts`, `src/lib/calendar-view/types.ts`).
- **Year count wording:** a line marked "(Birthday)" with "[Year N since the original date]" must come out as the Nth birthday in every summary kind (daily, tomorrow, week, voice show, calm voice, condensers). If a prompt rule has to change for that, change it in all three languages, and re-record `scripts/fixtures/voice-show-golden.json` with `--write-show-golden` (the show is meant to change here).

## Google contact birthdays

They already reach the home as `birthday: true` and show the word "Birthday" in the row's meta line. They get the same cake instead of that word, so every birthday looks the same. (Claude's call.)

## The details sheet

`ItemSheet` shows the cake before the title like the row, and keeps its "Birthday" tag (the sheet is where words belong). (Claude's call.)

## Non-goals

- No third Type, no title guessing, no auto-marking of existing events.
- The bot does not set the switch (spoken, typed, forwarded or photo events). Its birthdays already have "birthday" in their title, so they are mentioned right; their title is kept for a Google target, where there is no switch. (Claude's call, keeping scope tight; the switch is one tap in the editor.)
- No change to the Google copy, the cross-source move (moving a FamCal birthday to Google gives a plain Google event; the mark does not travel), event alerts (all-day events have none) or reminders.
- No count for a civil yearly event that is not a birthday (an insurance renewal with a "3" pill would be noise); the Hebrew count stays on every Hebrew yearly series, as today.

## The age of a civil-date birthday (owner 2026-11-25: "add age for regular date birthdays too")

- A birthday on the civil "Every year" repeat gets the same count a Hebrew one has: N = the occurrence's civil year minus the original date's civil year, shown and worded exactly like the Hebrew count (the home's pill, the summaries' "[Year N since the original date]", hidden while N < 1). One place computes both (`src/lib/hebrew-anniversary.ts`, `anniversaryOf`).
- The original year is stored, so a "from this one on" split does not restart the age: `NativeEvent.birthYear Int?` (as built: only the year counts). Null means the series' own start year. A split-off part of a civil every-year series gets the original series' year (`birthYearOf`), and keeps it while its start stays in the cut's year (a day corrected); a part, or a whole series, whose start moves to another year counts from that new start (the person picked the original date, as the hint asks), so its `birthYear` is null. The Hebrew anchor and its behaviour do not change.
- An occurrence of a birthday given a time of day on its own (a party at 18:00, "only this one") is not a birthday: it keeps its time in the summaries, is busy, and has no cake.
- The editor shows the existing hint "To show the year count, set the date to the original one, like the birth date." under the switch for a civil birthday too (it already shows for the Hebrew repeat).
- The Google copy of a civil yearly series is one Google series with one title, so it has no count ("Dana"); the owner said the Google side is not important.
- 29 February: a civil yearly rule on 29 Feb occurs only in leap years (RFC 5545), as it does today; the count is right in those years. Not changed here.

## Constraints

- Copy: the switch label and the hidden "Birthday" in en/he/ru, natural and gender-neutral in Hebrew, formal in Russian; reuse `calendarHome.row.birthday` where it fits.
- Lucide icons only, no emoji; no `:hover`; light and dark; RTL.
- FamCal events are written only through the event store's four writes (they open the event alerts gate).
- The show's golden changes only if the prompts do, and then deliberately.
- Tests: TDD smokes; never the real Telegram or Google API.

## Left to the builder

The editor row's exact place under Repeat, the migration name, the smokes' shape, and whether the year-count wording needs a prompt change or only the line's data.

# Hebrew anniversary count

A NativeEvent with `hebrewRule = 'anniversary'` repeats every year on its anchor's Hebrew date.
This adds the count CalBrew showed ("Dana's birthday (35)"): how many Hebrew years this
occurrence is after the original one. Owner-approved 2026-10-25.

## Decisions

1. **N** = the Hebrew year of the occurrence minus the Hebrew year of `hebrewAnchor` (a civil
   `yyyy-MM-dd`). Shown only when N >= 1; the first occurrence, and an anchor in a future
   year, show nothing. The occurrence's year is the Hebrew year of its civil day in the
   series' zone, so a rolled day (30 Adar I to 1 Nisan, 30 Cheshvan to 1 Kislev) stays in its
   own year.
2. **One helper**, `src/lib/hebrew-anniversary.ts` (`anniversaryCount`), built on hebcal's
   `HDate`. Everything below calls it; nothing else does the subtraction.
3. **FamCal UI**: a small muted number pill right after the title, never literal
   parentheses. It sits at the logical end (RTL-safe), uses tabular numbers, the home's own
   tokens (`--ch-surface`, `--ch-muted`), light and dark, no emoji. A visually hidden
   "N years" follows for screen readers.
   - Agenda rows and the item sheet: always, when N >= 1.
   - Month cells: the title truncates first; the pill is dropped (container query on the
     slot's width) rather than hide the title.
4. **Editor**: under the "every year on the Hebrew date" repeat option, a short hint that to
   show the count the date must be the original one (the birth date). he/en/ru.
5. **Summaries and voice**: the count travels as data on the event (`CalendarEvent.anniversary`),
   serialised as a marker in the daily list (`formatEventForPrompt`), the week lookahead
   (`LookaheadEventData.anniversary`) and the tomorrow lookahead line. A generic guideline
   line (en/he/ru, gender-neutral Hebrew) is added to a prompt only when some event carries
   a count, so prompts without one are byte-identical (the goldens in
   `scripts/smoke-digest-reader.ts` and `scripts/smoke-summary-prompt-parity.ts` do not
   change unless a fixture has a Hebrew series; checked, none does). The voice show is
   written from the finished text summary, so it picks the count up from there.
6. **Google copy**: today a Hebrew series is ONE Google event with RDATE lines for about 10
   Hebrew years. Now each year is its own single event titled `Title (N)` (plain text; no
   count when N < 1) over the same horizon (`hebrew.ts`).
   - Event id per single: `syncEventId`'s hash of `link:series:hs:<slot ISO>`; no
     generation, so a wiped sync state re-adopts the same events (insert, 409, update) and
     never duplicates.
   - State in the item: `slotHashes['~singles'] = '1'` and `slotHashes['~s:<slot>'] =
     <body hash>` (`'?'` while being written, saved first so a cut-short push loses no id).
     `googleEventId` holds the series' old master id as a marker (never inserted again), so
     the horizon refresh and the "emptied" paths that look at it keep working.
   - **Migration**: an item with a `googleEventId` and no `~singles` is an old RDATE copy (or
     a wiped state). The push lists the calendar's events carrying this series' marker
     (`privateExtendedProperty famcalSeries=<id>`), deletes every one that is not a planned
     single, then writes the singles. A second pass is clean (hashes equal, no calls).
   - **Edit**: a changed title, time, place or note changes each single's hash and updates it.
     Slots that leave the plan (an exdate, a cancelled instance, the horizon moving) are
     deleted by their stored id. An OVERRIDE row is applied to its single.
   - **Delete / leaves the copy / becomes non-Hebrew / unsupported**: every single is
     deleted by its stored ids (404/410 counts as done).
   - Existing retry, backoff, budget and 401/404 guards are unchanged: the singles are
     written inside `pushItem`, so `BudgetSpent` and Google errors reach the worker as before.

## Files

- new `src/lib/hebrew-anniversary.ts`
- `src/services/calendar-provider/*` (UnifiedEvent field) and `src/types.ts` (CalendarEvent)
- `src/services/calendar-read/dto.ts`, `src/lib/calendar-view/types.ts` (ItemDTO), `month.ts` (MonthSlot)
- `app/[locale]/dashboard/{ItemRow,ItemSheet,MonthBrowse,AgendaView,EditorSheet}.tsx`
- `messages/{en,he,ru}.json`
- `src/utils/event-formatter.ts`, `src/services/week-lookahead.ts`, `src/prompts/{calendar-summary,week-lookahead}/*`
- `src/services/calendar-move/mapper.ts` (`toGoogleHebrewSingles`), `src/services/google-sync/{push,hebrew,worker}.ts`

## Tests

New `scripts/smoke-hebrew-anniversary.ts`: the count across leap years and Adar (including
30 Adar I to 1 Nisan in a one-Adar year), N = 0 hidden, an anchor in a future year, the DTO
field, the markup (pill present or absent, after the title, hidden label), the Month-cell
rule (slot count, container query in the CSS), the prompt data (daily, week, tomorrow, and
no change without a count), the editor hint keys in all three languages.
Extended `scripts/smoke-google-sync-worker.ts`: mapping to singles with titles, migration of
an existing RDATE copy and no duplicates on a second pass, edit and delete propagation,
retry on a mid-push failure.

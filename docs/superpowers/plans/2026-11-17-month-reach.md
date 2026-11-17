# Month reach: fresh months after a write, endless Month, jump to a date

> For agentic workers: executed natively (inline) by the controller, then one whole-change review.

**Goal:** a saved, moved, deleted or done item shows in every month and week already loaded; the Month
scrolls without end (1900 to 2100) and jumps to any date.

**Owner asks (2026-11-17):** the new event showed late in a month seen before ("delay?"); "in month view
can you do infinite scroll?"; "fold jump to date picker into it already".

**Spec it amends:** docs/superpowers/specs/2026-10-16-calendar-home-design.md §5 (Freshness) and §7.4
(the 31-month window). Updated in the same change.

## Decisions

1. **Writes refresh everywhere.** A refetch after a write (`renew`) or Refresh (`fresh`) marks every
   window it did not re-ask (this epoch, those sources) as out of date. `ensure()` asks an out-of-date
   window again as soon as it is wanted (the Agenda's weeks, a month coming near), with `renew`, so a
   request from before the write is never the one kept. The foreground return stays as it is (on-screen
   windows only, spec §5).
2. **Reach = the editor's years.** The Month reaches January `MIN_YEAR_BIRTH` (1900) to December
   `MAX_YEAR` (2100), year-limits.ts, the years an item may start in. The range route's "within 5 years of
   today" becomes the same reach (one rule for client and server).
3. **Browse grows.** The rendered months are a span `{ first, last }` held by CalendarHome, starting at
   today's month −12 / +18 (as now). When the month in view comes within 6 months of an end, that end
   moves 12 months out (inside the reach). Growing at the top waits until scrolling stops (about 150 ms
   with no scroll event; on iOS moving the page during a fling cuts the fling); at the bottom it grows at
   once. MonthBrowse already keeps the month in view in place when months[0] changes.
4. **Jump.** The month name in browse's bar and in picked's header is a button that opens the editor's
   DatePickerSheet (Gregorian | Hebrew switch while Hebrew dates are on, month and year wheels, Today),
   limited to the reach. Picking a day opens picked on that day (its grid and list). The span then covers
   the day's month: grown to it when it is at most 12 months past an end, else re-centred on it (−12/+18,
   clamped to the reach), so the page never holds decades of empty months.
5. **Today in browse** with today's month outside the span (after a far jump): the span re-centres on
   today and browse remounts on today's month.
6. **Picked's chevrons, drag's month flip and wantedMonths** read the reach, not today's window; a step
   past the span grows it.
7. A new visit still opens on today's month (the span is not remembered).

## Tasks

### Task 1: the loader refreshes every loaded window after a write

- Modify `src/lib/calendar-view/home-loader.ts`: a `stale` set of `${epoch}|${source}|${windowKey}`.
  `refetchVisible({ renew | fresh })` adds every issued key of the asked sources in this epoch that it did
  not send now. `ensure()` sends a stale wanted window (agenda weeks while showing, wanted months) with
  `renew: true` regardless of coverage; sending a key removes it from `stale`. Header notes updated.
- Test `scripts/smoke-calendar-loader.ts`: a month answered, scrolled away, a write's
  `refetchVisible({ only: 'famcal', renew: true })`, the month wanted again → one new famcal request for
  it; a month never left is not asked twice; the foreground `refetchVisible()` marks nothing; Agenda
  weeks after a write made on the Month tab are asked again when the Agenda shows. Proven to fail without
  the fix.

### Task 2: the reach and the span model

- `src/lib/calendar-view/year-limits.ts`: `MONTH_REACH = { first: '1900-01', last: '2100-12' }` from
  `MIN_YEAR_BIRTH` and `MAX_YEAR`.
- `src/lib/calendar-view/grid.ts`: `MonthSpan`, `defaultSpan(today)`, `spanMonths(span)`; `monthSpan(today)`
  stays as `spanMonths(defaultSpan(today))`.
- `src/lib/calendar-view/month.ts`: `windowOf(today)` → the reach; `canStep`, `stepMonth`, `clampMonthUi`,
  `wantedMonths` keep their shapes (today still picks the day to select) but bound by the reach;
  `growSpan(span, month, edge)`, `spanToShow(span, month)` (grow ≤ 12 months past an end, else re-centre),
  `jumpToDay(ui, day)`.
- `app/api/calendar/range/route.ts`: from/to inside the reach instead of 5 years of today.
- Tests: `smoke-calendar-month-picked.ts` (chevrons at 1900-01 / 2100-12, not at today ±window),
  `smoke-calendar-range.ts` (1900-01-01 ok, 1899-12-31 refused, 2100-12-31 ok, 2101-01-01 refused),
  a span check in the month smoke.

### Task 3: browse grows as it scrolls; Today re-centres

- `MonthBrowse.tsx`: `onNeedMonths(edge: 'before' | 'after')`, called from `measure()` when the month in
  view is within 6 months of an end; 'before' only after a scroll-idle timer; `onToday()` when today's
  month is not in `months`.
- `CalendarHome.tsx`: `span` state (default on new facts; union with the default span when today moves),
  `months = spanMonths(span)`; grows on `onNeedMonths`; re-centres on Today (browse remount key).
- Tests in `smoke-calendar-month-browse.ts`: the request at 6 months from the top fires only after idle,
  at the bottom at once; the month in view keeps its place after 12 months are added above.

### Task 4: jump to a date

- `MonthBrowse.tsx` bar title and `MonthPicked.tsx` title become buttons (44 px tap, focus ring, no hover)
  with the label `calendarHome.month.jumpLabel` ("Go to a date"); `MonthView.tsx` opens
  `DatePickerSheet` (`label`, `value` = picked day or the 1st of the month in view, `minYear` 1900,
  opening in Gregorian; the Gregorian | Hebrew switch is there while the home shows Hebrew dates).
- `CalendarHome.tsx`: `onJump(day)` → span via `spanToShow`, `ui` via `jumpToDay`.
- Messages he/en/ru: `month.jumpLabel`, `month.jumpSheet` (sheet's name). KEYS table in
  `smoke-calendar-home-copy.ts`.
- Tests in `smoke-calendar-home-render.ts`: tapping the bar's month opens the sheet; picking 2018-06-09
  opens picked on it and asks June 2018's window; "All months" browses around it; Today comes back.

### Task 5: docs, gate, review, push

- Spec §5 and §7.4 amended; README untouched (no setup change).
- Fresh-clone CI mirror; one whole-change review (most capable model); fix findings; push; check Railway
  and CI; delete this plan file once shipped.

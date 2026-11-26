# Responsive home release 2 (layouts) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One Month screen for every window: the month and the selected day together, side by side when wide, a split with a handle when upright; size-aware day squares; a one-line header on short windows; centred pop-ups on wide windows.

**Architecture:** Pure rules first (`month-layout.ts`, new focus helpers in `month.ts`), then three new view parts (`MonthSquares`, `MonthPane`, `DayPanel` + `SplitHandle`), then `MonthView` and `CalendarHome` rewired onto them in one swap that deletes `MonthBrowse.tsx` and `MonthPicked.tsx`. The Month tab becomes a fixed-height region with two inner scrollers; the Agenda keeps document scroll. Months in the pane are all exactly one scroller tall, so every scroll position is `index × height`.

**Tech Stack:** Next.js 16 client components, React 19, next-intl, @dnd-kit/core (existing `DragSurface.tsx`), TypeScript smokes on `scripts/lib/fake-dom.ts`.

**Spec:** `docs/superpowers/specs/2026-11-19-responsive-home-design.md` (§1–§5, §9; decisions 1–6, 9). Background: `docs/superpowers/specs/2026-10-16-calendar-home-design.md` §7, `docs/superpowers/specs/2026-10-25-editor-upgrades-design.md` §4.

## Global Constraints

- Wide = `(min-width: 600px) and (orientation: landscape)`; short header = `(max-height: 520px) and (orientation: landscape)`; centred pop-ups and the Agenda column = `(min-width: 600px)` in any orientation (CSS only).
- Read the wide layout with a `matchMedia` listener, never resize polling; SSR and the first client render are upright (no hydration mismatch).
- Logical properties only; nothing under 11 px; every tap at least 44 px except the day squares (spec §1 allows rows down to 36 px; the CSS lint gets an explicit exception for the square class only); no `:hover`; light and dark through the `--ch-*` tokens; RTL by `dir`; lucide icons only.
- No `setHours`/`setDate`/`fromZonedTime`, no reading a date string through the server's zone (`scripts/smoke-dst.ts` scans `app/` and `src/`).
- New copy in `messages/{en,he,ru}.json` under `calendarHome.month`: Hebrew gender-neutral, Russian formal; keys no longer used are deleted from all three files and from `scripts/smoke-calendar-home-copy.ts`'s table.
- The drag library stays out of the Agenda's and CalendarHome's chunk: only the lazily loaded `MonthView` chunk imports `DragSurface.tsx` (render smoke #43).
- `BottomSheet`'s default render stays byte-identical (other screens' smokes compare its class strings); the opt-in only adds a class.
- Smokes use `scripts/lib/fake-dom.ts`; extend it (a `ResizeObserver` with a manual trigger, `scrollTop`/`clientHeight`/`clientWidth`/`scrollTo` on elements) where a check needs it, without changing what existing smokes see.
- Run single smokes with the fake env only: `bash <scratchpad>/repro/run-env.sh scripts/smoke-x.ts`. Never `npm run build`.

## Rulings made while planning (Claude's calls, reported to the owner)

1. The pane's per-month problems (loading, failed, Google pills) stay as the pills over that month, as All months shows them today; picked's notice rows go.
2. The selected day's month is always fetched, second after the month in view, so the list is right after scrolling far away.
3. On the Month tab "+" starts on the selected day (it is always on screen now).
4. The header and the tab bar never stick: on the Month tab the page does not scroll, and the Agenda never stuck them.
5. While an item is lifted, resting on a chevron scrolls the pane a month (picked's preview month goes).
6. The bar: ‹ title › at the start, Today at the end; the space between stays empty for release 3's Gregorian | Hebrew switch.
7. Square sizes come from the computed scroller size in the split (its height is set by `splitHeights`), so the 200 ms animation never re-renders the squares per frame; in the wide layout one `ResizeObserver` on the scroller measures, with a trailing settle of 220 ms.
8. v1 memory: `'browse'` → grown, `'picked'` → split, then the v1 key is removed.
9. The handle's touch area reaches 11 px above and below its 22 px bar (44 px in all, the home's tap floor) where the spec says 8 px (38 px).
10. Handle copy: en "Show the month bigger" / "Show the month smaller"; he "הגדלת החודש" / "הקטנת החודש"; ru "Увеличить месяц" / "Уменьшить месяц".

## Review Focus

1. A resize while a month is in view (rotation, Telegram expand, the split animating): the same month stays in view, snapped, with no jump to a neighbour.
2. Months added above while scrolling up (span growth 'before'): the month in view does not move, and the growth waits for scroll idle (iOS stops a fling when `scrollTop` is set mid-fling).
3. A selected day far from the month in view: its list still loads and shows, and Today shows.
4. Dragging a list row onto a square two months away by resting on a chevron; dropping on a small (dots) square.
5. A 6-week month in the collapsed split on a 320 × 568 phone: the list keeps 120 px and rows never go under 36 px.

---

### Task 1: The pure rules

**Files:**
- Create: `src/lib/calendar-view/month-layout.ts`
- Modify: `src/lib/calendar-view/month.ts` (add; delete nothing yet)
- Test: `scripts/smoke-month-layout.ts` (new)

**Interfaces:**
- Produces (`month-layout.ts`, client-safe, imports nothing from React):
  - `WIDE_QUERY = '(min-width: 600px) and (orientation: landscape)'`, `SHORT_QUERY = '(max-height: 520px) and (orientation: landscape)'`
  - `HANDLE_PX = 22`, `HANDLE_TOUCH_PX = 11`, `HANDLE_TAP_PX = 12`, `LIST_MIN_PX = 120`, `ROW_MIN_PX = 44`, `ROW_SHORT_MIN_PX = 36`, `PEEK_PX = 44`, `SPLIT_ROWS = 6`, `SETTLE_MS = 220`
  - `interface SplitHeights { rowPx: number; scrollerPx: number; listPx: number }`
  - `splitHeights(h: number, chrome: number, cellWidth: number, grown: boolean): SplitHeights` — collapsed: `rowPx = max(44, min(round(cellWidth × 0.9), floor((h × 0.6 − chrome) / 6)))`; if `h − chrome − 6·rowPx − HANDLE_PX < 120` then `rowPx = max(36, floor((h − chrome − HANDLE_PX − 120) / 6))`; `scrollerPx = 6·rowPx`; `listPx = max(0, h − chrome − scrollerPx − HANDLE_PX)`. Grown: `scrollerPx = max(0, h − chrome − HANDLE_PX − PEEK_PX)`, `rowPx = floor(scrollerPx / 6)`, `listPx = PEEK_PX`. Any non-finite or non-positive `h` or `cellWidth` → `{0,0,0}`.
  - `type SquareKind = 'small' | 'medium' | 'large'`; `interface SquareSize { kind: SquareKind; lines: number; big: boolean }`
  - `SQUARE_SLOT_PX = 18`, `SQUARE_SLOT_BIG_PX = 21`, `SQUARE_USED_PX = 35`, `SQUARE_USED_BIG_PX = 41`, `SQUARE_MAX_LINES = 7`
  - `squareSize(h: number, w: number): SquareSize` — small when `h < 60 || w < 44`, medium when `h < 82` (both `lines: 0, big: false`); else large, `big = w >= 110 && h >= 100`, `lines = clamp(1, 7, floor((h − used) / slot))` with the big or normal used/slot. Non-finite → small.
  - `monthAtScroll(scrollTop: number, paneHeight: number, count: number): number` — `clamp(0, count − 1, floor((scrollTop + paneHeight / 2) / paneHeight))`; 0 when `paneHeight <= 0` or `count <= 0`.
- Produces (`month.ts`, beside the old helpers, which stay until Task 6):
  - `interface MonthFocus { month: MonthKey; selected: DayKey }` — `month` is the month the pane was last sent to (opening, Today, a jump, leaving the tab); `selected` the day the list shows.
  - `initialFocus(today: DayKey): MonthFocus | null`, `selectDay(f: MonthFocus, day: DayKey): MonthFocus` (month unchanged; same object when equal), `focusToday(f, today)`, `focusJump(f, day)` (`{ month: monthOf(day), selected: day }`), `focusMonth(f, month)` (selection unchanged), `canStepMonth(month: MonthKey, delta: -1 | 1, today: DayKey): boolean` (inside MONTH_REACH), `clampFocus(f, today)` (a malformed or out-of-reach month → the nearest end, malformed → today's month; a selected day outside the reach → today; same object when unchanged).
  - `wantedFocusMonths(f: MonthFocus, near: readonly MonthKey[], inView: MonthKey | null, today: DayKey): RangeWindow[]` — the anchor (`inView` when valid, else `f.month`), then `monthOf(f.selected)` when different (Ruling 2), then browse's pool (near + the anchor's two neighbours) nearest first, the later month first on a tie; each once, inside the reach.
  - `fitSlots(slots: readonly MonthSlot[], lines: number): { shown: MonthSlot[]; more: number }` and `fitRow(cells: readonly MonthCell[], lines: number)` — `limitSlots`/`limitRow`'s three steps with the limit clamped to `[1, SQUARE_MAX_LINES]` and, when it still overflows, `keep = limit − 1` items then "+N" (so `lines` is the total lines drawn, "+N" included).

- [ ] **Step 1: Write the failing smoke `scripts/smoke-month-layout.ts`** with these checks (exact values):
  - `splitHeights(560, 76, 54, false)` → `{ rowPx: 44, scrollerPx: 264, listPx: 198 }`; `(440, 76, 54, false)` → `{ 37, 222, 120 }`; `(380, 76, 54, false)` → `{ 36, 216, 66 }`; `(900, 76, 110, false)` → `{ 77, 462, 340 }`; `(560, 76, 54, true)` → `{ 69, 418, 44 }`; `(NaN, 76, 54, false)` → `{ 0, 0, 0 }`. Review Focus 5: a 320 × 568 phone's region (`h = 330`, chrome 76, cellWidth 42) gives `rowPx >= 36`.
  - `squareSize(44, 54)` small; `(70, 54)` medium; `(82, 30)` small; `(92, 54)` → large, 3 lines, not big; `(82, 54)` → large, 2; `(100, 110)` → large, 2, big; `(300, 120)` → large, 7, big; `(NaN, 54)` small.
  - `monthAtScroll(0, 400, 31) = 0`, `(199, 400, 31) = 0`, `(200, 400, 31) = 1`, `(12000, 400, 31) = 30`, `(50, 0, 31) = 0`.
  - focus helpers on today `2026-10-15`: `initialFocus` → `{ month: '2026-10', selected: '2026-10-15' }`; `selectDay` keeps the month and returns the same object for the same day; `focusJump(f, '2027-03-04')` → `{ '2027-03', '2027-03-04' }`; `canStepMonth('2100-12', 1, today)` and `('1900-01', -1, today)` false; `clampFocus` of `{ month: 'x', selected: '1800-01-01' }` → `{ '2026-10', '2026-10-15' }`.
  - `wantedFocusMonths({ month: '2026-10', selected: '2026-08-15' }, [], '2026-10', '2026-10-15')` → windows for `2026-10, 2026-08, 2026-11, 2026-09` in that order; with `inView: null` the anchor is `f.month`.
  - `fitSlots` of 4 one-day items with 3 lines → 2 shown, `more: 2`; 3 items with 3 lines → all, `more: 0`; 2 items with 1 line → 0 shown, `more: 2`; 9 items with 7 lines → 6 shown, `more: 3`; a bar in lane 2 that moves up gets `showTitle: true` (limitSlots' rule); `fitRow` re-titles a bar the day before did not draw in the same slot.
  - The two files are client-safe: importing them loads no React, no Prisma, no `@hebcal/core` (check `require.cache` as `smoke-calendar-month.ts` does).
- [ ] **Step 2: Run it; expect FAIL** (`Cannot find module '../src/lib/calendar-view/month-layout'`).
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run it and `scripts/smoke-calendar-month.ts`; expect both PASS.**
- [ ] **Step 5: Commit** `feat(month): the layout rules (split heights, square sizes, the month at a scroll) and the focus helpers for one Month screen`.

### Task 2: The media hook and the v2 layout memory

**Files:**
- Create: `src/lib/calendar-view/use-media.ts`
- Modify: `src/lib/calendar-view/home-storage.ts`
- Test: `scripts/smoke-calendar-home-tabs.ts` (#6, #7 extended), `scripts/smoke-month-layout.ts` (hook check)

**Interfaces:**
- Produces: `useMediaQuery(query: string): boolean` — `useSyncExternalStore` over `matchMedia(query)` with MonthBrowse's guards (no window, no `matchMedia`, a throwing call → false and logged once with `console.warn('[media] matchMedia failed:', …)`), `addEventListener('change')` with the `addListener` fallback; server snapshot false.
- Produces: `type MonthSplit = 'split' | 'grown'`; `monthSplitKey(userId: string) = 'famcal:monthLayout:v2:' + userId`; `readMonthSplit(userId: string): MonthSplit` (v2 when valid; else v1 `'browse'` → `'grown'`, `'picked'` → `'split'`, written to v2 and the v1 key removed; else `'split'`; storage that throws → `'split'`); `writeMonthSplit(userId: string, split: MonthSplit): void`. The v1 helpers stay until Task 6.

- [ ] **Step 1: Write the failing checks.** Tabs #6b: the v2 key string for user `5550001`; v2 `'grown'` read back; v1 `'browse'` alone → `'grown'`, v2 now holds `'grown'`, v1 gone; v1 `'picked'` → `'split'`; nothing → `'split'`; v2 `'wide'` (garbage) falls back to v1 then the default. #7b: getItem/setItem/removeItem that throw → `'split'`, no throw. Layout smoke: `useMediaQuery` rendered through `renderToString` is false; with a fake `matchMedia` answering `matches: true` and a `change` event, a mounted probe re-renders true then false; it unsubscribes on unmount.
- [ ] **Step 2: Run both smokes; expect FAIL** (missing exports).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run both; expect PASS.**
- [ ] **Step 5: Commit** `feat(month): a shared media-query hook and the v2 Month layout memory (split or grown, mapped once from v1)`.

### Task 3: The day squares

**Files:**
- Create: `app/[locale]/(app)/dashboard/MonthSquares.tsx` (exports `MonthSquaresGrid`, `Square`, `SquareChip`, `MONTH_SQUARES_CSS`)
- Test: `scripts/smoke-month-pane.ts` (new; squares part)

**Interfaces:**
- Consumes: `squareSize`, `fitRow` (Task 1); `limitDots`, `MonthModel`, `MonthCell`, `MonthSlot` (month.ts); `useItemDrag`, `useDayDrop` (DragSurface); `useHolidays`, `holidayTitles`, `isPortion` (holidays-client); `hebrewCellLabel`, `hebrewCellMonth`, `hebrewDayLabel`, `isHebrewMonthStart` (hebrew-date); `calendarMark` (ItemRow).
- Produces: `MonthSquaresGrid({ model: MonthModel; month: MonthKey; today: DayKey; selected: DayKey; hebrewDates: boolean; size: SquareSize; onSelectDay(day: DayKey): void; onRetryMonth(month, source): void; onChooseCalendars(): void })` — the month's weeks as `grid-template-rows: repeat(<weeks>, 1fr)` filling its block, every in-month day one `<button class="ch-sq">` (blank days `span.ch-sq.is-blank`, aria-hidden, no drop target).
- What a square shows (spec §4, copied from today's code, not rewritten): small — the Gregorian day, the Hebrew day (month name on Hebrew day 1 and the month's first square) and MonthPicked's dots (`limitDots`, filled mine, ring partner's, `has-cal` colours, "+N"); medium — small plus the holiday line (MonthBrowse's rule: the holiday brief, chag in the accent, the portion never beats the month name); large — MonthBrowse's head line, the holiday line and `fitRow(week, size.lines)` chips (bars joined across days with `is-before`/`is-after`, "+N" as the last line, the anniversary count pill by container query), `is-big` adding 13 px chips in 21 px slots. Daily-repeating reminders stay out (they already are out of `slots` and `dots`).
- Each square: MonthBrowse's translated label (`formatDayLong`, the Hebrew day, holidays, `month.cellItems`, `month.cellFromPartner`, loading/failed/nothing), `aria-current="date"` on today, `aria-pressed` on the selected day; chips, dots and lines `aria-hidden`; `useDayDrop(day)` on every in-month square; `useItemDrag` on chips in large squares only.
- The month's loading/failed/Google pills: MonthBrowse's `NoticePill` overlay, moved here unchanged in behaviour (Ruling 1).
- CSS `MONTH_SQUARES_CSS`, class prefix `ch-sq-`; the selected square's day number gets `--ch-selected` (today stays `--ch-today`, both: `--ch-today`), the drop outline comes from `DRAG_CSS`.

- [ ] **Step 1: Write the failing checks in `scripts/smoke-month-pane.ts`** (renderToString with `NextIntlClientProvider`, a model from `buildMonth` over a fixture store like `smoke-calendar-month-browse.ts`'s): en/he/ru labels and `dir`; one button per in-month day, `aria-current` on today only, `aria-pressed="true"` on the selected day only; `size` small → dots (`.ch-sq-dot.is-mine` / `.is-partner`, "+N" past 3) and no chips; medium → dots plus the holiday line; large with 3 lines and 4 items → 2 chips and "+2"; a bar across two days titled once per week row; the Hebrew day in gematriya in he; R11 daily reminder absent from squares; the count pill markup (`<bdi>` then `.ch-sq-count`) and its container query; CSS lint (`lintCss` from `scripts/lib/css-lint.ts`): nothing under 11 px, logical properties only, no hover, the 44 px rule waived for `.ch-sq` only; calendar colours: `.ch-sq-dot.has-cal.is-mine { background: var(--cal-line) }`, `.ch-sq-dot.has-cal.is-partner { border-color: var(--cal-line) }`, chips use `--cal-fill/--cal-text/--cal-line`.
- [ ] **Step 2: Run; expect FAIL** (missing module).
- [ ] **Step 3: Implement** by copying MonthBrowse's `Slot`/`Chip`/`LiveCell`/`NoticePill`/label code and MonthPicked's `Marks`/`useCellLabel` into `MonthSquares.tsx` under the new classes; MonthBrowse and MonthPicked keep their own copies until Task 6 deletes them.
- [ ] **Step 4: Run it, `smoke-calendar-month-browse.ts` and `smoke-calendar-month-picked.ts`; expect all PASS.**
- [ ] **Step 5: Commit** `feat(month): size-aware day squares (dots, the holiday line, event names as many as fit)`.

### Task 4: The month pane

**Files:**
- Create: `app/[locale]/(app)/dashboard/MonthPane.tsx` (exports `MonthPane`, `MonthPaneProps`, `MonthPaneHandle`, `MONTH_PANE_CSS`)
- Test: `scripts/smoke-month-pane.ts` (pane part)

**Interfaces:**
- Consumes: Task 1 (`monthAtScroll`, `canStepMonth`, `squareSize`, `SETTLE_MS`), Task 3 (`MonthSquaresGrid`); `nearSpanEdge`, `monthOf`, `monthGrid`, `weekdayOrder` (grid.ts); `monthBarPx`, `loadingMonth` (month.ts); `useNavDrop` (DragSurface); `formatMonthTitle`, `formatWeekdayHeader` (format.ts); `hebrewMonthHeader`; `SCROLL_IDLE_MS = 150` moves here from MonthBrowse.
- Produces:
  ```ts
  interface MonthPaneProps {
    months: readonly MonthKey[];            // the span, oldest first
    today: DayKey; weekStart: WeekStart; hebrewDates: boolean;
    getMonth(month: MonthKey): MonthModel | null;
    selected: DayKey;
    seek: { month: MonthKey; seq: number }; // scroll here on mount (instant) and whenever seq changes
    scrollerPx: number | null;              // the split sets the scroller's height; null fills (wide)
    onSelectDay(day: DayKey): void;
    onMonthInView(month: MonthKey): void;
    onNearMonths(months: MonthKey[]): void; // the drawn months: in view ±1
    onNeedMonths(edge: 'before' | 'after'): void;
    onToday(): void;
    onJump?(): void;
    onRetryMonth(month: MonthKey, source: SourceName): void;
    onChooseCalendars(): void;
  }
  interface MonthPaneHandle { step(delta: -1 | 1): void }  // React 19 `ref` prop
  ```
- Structure: `section.ch-pane` (`dir` rtl in he) → `div.ch-pane-bar` (‹ `NavButton` prev, the title button `.ch-pane-title` = the month in view's `formatMonthTitle` with the chevron-down and, with Hebrew dates, `hebrewMonthHeader(inView)` under it, opening `onJump`; › `NavButton` next; an empty flexible gap; Today `.ch-pane-today` when `selected !== today || inView !== monthOf(today)`) → `div.ch-pane-weekdays` → `div.ch-pane-scroller` (`overflow-y: auto; overscroll-behavior: contain; scroll-snap-type: y mandatory`; block-size `scrollerPx` px or `flex: 1`) holding one `div.ch-pane-month[data-month]` per month (`block-size: 100%; scroll-snap-align: start`), the grid drawn only for in view ±1, the rest empty. Bar + weekdays height = `monthBarPx(hebrewDates)`.
- Behaviour:
  - in view = `months[monthAtScroll(scrollTop, clientHeight, n)]`, measured once per animation frame on `scroll`; reported on change with `onNearMonths(in view ±1)`; holidays' failed retries on the 2nd+ change (`retryFailedHolidays`), as browse.
  - span growth: `'after'` as soon as `nearSpanEdge(span, inView, 'after')`, once per `months[n-1]`; `'before'` only after `SCROLL_IDLE_MS` of no scroll, once per `months[0]`. When `months[0]` moves earlier by k months, `scrollTop += k × clientHeight` in a layout effect before paint (Review Focus 2).
  - seek: on mount `scrollTop = index(seek.month) × h` instantly; on a new `seq` with the month in `months`, `scrollTo` smooth when it is the next or previous month and reduced motion is off, else instant.
  - `step(delta)` and the chevrons: scroll to in view ± 1 (smooth unless reduced motion), never changing the selection; disabled past the reach (`canStepMonth`); at the span's end ask `onNeedMonths` first. The chevrons are `useNavDrop` targets (`nav:prev`/`nav:next`), class `is-drop-nav` while hovered.
  - resize: one `ResizeObserver` on the scroller; each callback re-aligns `scrollTop = index(inView) × clientHeight` at once (no render, Review Focus 1), and the squares' size state (`squareSize(clientHeight / weeks, (clientWidth − 12) / 7)` per month) updates after `SETTLE_MS` of no further resize (first measure immediate). With `scrollerPx` set, the height in that formula is `scrollerPx` (Ruling 7).
  - Today calls `onToday` (the container moves selection and seeks); the pane never selects by itself.

- [ ] **Step 1: Write the failing checks** (port from `smoke-calendar-month-browse.ts` #2 bar/title/dir, #7 weekday order, #15 near, #16 measure per frame, #17 Today, #18 callbacks, #22 unmount cleanup, #26b span growth, #26c far Today and jump; plus new): the scroller's CSS (`scroll-snap-type: y mandatory`, `overscroll-behavior: contain`, months `block-size: 100%`, `scroll-snap-align: start`); mount with seek `2026-10` in a 31-month span puts `scrollTop` at `12 × h`; scrolling to `13.6 × h` reports `2026-12` once, near `2026-11..2027-01`; growth 'after' fires once near the end; 'before' only after 150 ms idle; prepending 12 months keeps the same month in view (`scrollTop` grew by `12 × h`); a resize from h 400 to 300 keeps the month (`scrollTop = idx × 300`) and the squares' size changes only after 220 ms; `step(1)` scrolls one month and calls no `onSelectDay`; chevrons disabled at `1900-01`/`2100-12`; Today shown when the selection or the month in view isn't today's, hidden otherwise; the title opens `onJump`; the Hebrew months line with Hebrew dates; no React warnings; unmount removes the scroll listener, the observer and the idle timer.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run it; expect PASS.**
- [ ] **Step 5: Commit** `feat(month): the month pane: whole months that snap, the bar's chevrons and Today, the span and the windows reported as browse did`.

### Task 5: The day panel and the handle

**Files:**
- Create: `app/[locale]/(app)/dashboard/DayPanel.tsx` (`DayPanel`, `DAY_PANEL_CSS`), `app/[locale]/(app)/dashboard/SplitHandle.tsx` (`SplitHandle`, `SPLIT_HANDLE_CSS`)
- Modify: `messages/{en,he,ru}.json` (`calendarHome.month.showBigger`, `calendarHome.month.showSmaller`, Ruling 10), `scripts/smoke-calendar-home-copy.ts`
- Test: `scripts/smoke-month-pane.ts` (panel and handle part)

**Interfaces:**
- Produces: `DayPanel({ day, today, tz, hebrewDates, dafYomi, rows: AgendaRow[], status: DayStatus, top?: ReactNode, peek?: boolean, onPeek?(): void, onOpenItem(row: AgendaRow): void })` — MonthPicked's list moved, not rewritten: the `h3#ch-dp-day` header ("Today · …" on today), the Hebrew date, the holiday line (`useHolidays([month])`), `DafYomiLine` when `dafYomi`, `ul.ch-list` of `LiftableRow` (moved from MonthPicked), `agenda.nothingPlanned`, `PlaceholderRows` while loading. `top` renders first inside the scroller (banners and the unavailable row, spec §1). With `peek` the scroller has `overflow: hidden` and the whole panel is one button-like region whose tap calls `onPeek` (`aria-label` = `month.showSmaller`). Renders `AGENDA_CSS` once.
- Produces: `SplitHandle({ grown: boolean, onToggle(next: 'split' | 'grown'): void })` — a `<button type="button" class="ch-handle">` 22 px tall with a 36 × 5 pill, an 11 px touch extension above and below (`HANDLE_TOUCH_PX`, Ruling 9; padding plus negative margins, so the bar still takes 22 px), `touch-action: none`, `aria-expanded={grown}`, label `month.showBigger` when collapsed and `month.showSmaller` when grown. Pointer events with capture: movement under `HANDLE_TAP_PX` toggles; down past 12 px grows, up past 12 px shrinks; a pointer gesture marks the following `click` as handled so it does not toggle twice; Enter and Space toggle through `click`. Never a drag source.

- [ ] **Step 1: Write the failing checks**: the panel's header, Hebrew date, holiday line, Daf Yomi line placement (port picked #16), rows in order with `LiftableRow`, the nothing and loading states, `top` first in the scroller; `peek` blocks scrolling and a tap calls `onPeek`; the handle's label and `aria-expanded` both ways, a 5 px move toggles, a 30 px move down grows, 30 px up shrinks, a pointer tap fires `onToggle` once (not again on the click), keyboard click toggles; the copy keys exist in en/he/ru with the Ruling 10 words; CSS lint (the handle's tap area is 22 + 2 × 11 = 44 px; the bar's layout height stays 22 px).
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run it and the copy smoke; expect PASS.**
- [ ] **Step 5: Commit** `feat(month): the day panel (the picked day's list, now shared) and the split's handle`.

### Task 6: One Month screen in the home

**Files:**
- Rewrite: `app/[locale]/(app)/dashboard/MonthView.tsx`
- Modify: `app/[locale]/(app)/dashboard/CalendarHome.tsx`, `src/lib/calendar-view/month.ts` (delete the old state helpers and browse/picked geometry: `MonthUi`, `MonthLayout`, `initialMonthUi`, `pickDay`, `backToBrowse`, `canStep`, `stepMonth`, `pickToday`, `clampMonthUi`, `wantedMonths`, `pickedScrollTop`, `monthTitlePx`, `monthBlockPx`, `monthOffsets`, `monthsInViewport`, `limitSlots`, `limitRow`, and the constants only they used), `src/lib/calendar-view/home-storage.ts` (delete the v1 read/write helpers; keep the v1 key name only inside the migration), `messages/*.json` and the copy smoke (delete `month.allMonths` and any other key left unused)
- Delete: `MonthBrowse.tsx`, `MonthPicked.tsx`, `scripts/smoke-calendar-month-browse.ts`, `scripts/smoke-calendar-month-picked.ts` (their checks that still describe the product live in `smoke-month-pane.ts` from Tasks 3–5; port any missing ones there first)
- Modify tests: `scripts/smoke-calendar-home-render.ts`, `scripts/smoke-calendar-month.ts`, `scripts/smoke-calendar-home-tabs.ts`, `scripts/smoke-app-ui.ts`, `scripts/smoke-calendar-colours.ts`, `scripts/smoke-hebrew-anniversary.ts`, and every other script `grep -l 'MonthBrowse\|MonthPicked\|ch-mb-\|ch-mp-' scripts/*.ts` finds

**Interfaces:**
- `MonthView(props)`: `{ today; tz; weekStart; hebrewDates; dafYomi?; months; getMonth; focus: MonthFocus; seek: { month; seq }; split: MonthSplit; onSplit(next: MonthSplit); dayRows: { rows; status }; unavailableCalendars: number; banners: ReactNode; selected: AgendaRow | null; onSelect(row | null); sheetActions?; onSelectDay(day); onMonthInView; onNearMonths; onNeedMonths; onToday; onJump?; onRetryMonth; onChooseCalendars; jump?: { value; onPick; onClose } | null; drag?: MonthDrag }`, with `MonthDrag = Omit<DragLayerProps, 'children' | 'onNav'>` (MonthView supplies `onNav: (d) => paneRef.current?.step(d)`, Ruling 5).
- The region `div.ch-mv`: `block-size: calc(var(--tg-viewport-stable-height, 100dvh) - var(--ch-top-h, 0px) - var(--tg-safe-area-inset-top, 0px) - var(--tg-content-safe-area-inset-top, 0px) - max(env(safe-area-inset-bottom, 0px), var(--tg-safe-area-inset-bottom, 0px)))`, `overflow: hidden`; one `ResizeObserver` on it gives `h` and `w`. Wide (`useMediaQuery(WIDE_QUERY)`): `grid-template-columns: 2fr 1fr`, pane then panel (RTL mirrors), `scrollerPx = null`. Upright: column of pane (`scrollerPx = splitHeights(h, monthBarPx(hebrewDates), (w − 12) / 7, split === 'grown').scrollerPx`), `SplitHandle`, `DayPanel` (`flex: 1`); the month area's `block-size` transitions over 200 ms, none under `prefers-reduced-motion`. Grown: a square tap selects and calls `onSplit('split')`; the panel gets `peek` and `onPeek = () => onSplit('split')`.
- `banners` (HomeBanners) and the unavailable row go into `DayPanel.top` (spec §1); the ItemSheet and the JumpSheet stay as MonthView renders them today; the `DragLayer` wraps the region.
- CalendarHome: `focus: MonthFocus | null` replaces `monthUi`; `seekSeq` state; `split` from `readMonthSplit` (written by `onSplit` through `writeMonthSplit`); `monthFresh`, `browseKey`, `previewMonth`, `savedLayout`, `turnPreviewMonth` and `changeUi` go. First answer: `initialFocus(today)` (a new visit selects today); a later today: `clampFocus`. The span follows `focus.month` as today. `getMonths` → `wantedFocusMonths(focus, near, inView, today)`. The day list is `dayRows(store, focus.selected)` whenever the Month shows. `onSelectDay` → `selectDay` (+ `setSelected(null)` when the day changes). Today → span to today's month, `focusToday`, `seekSeq + 1`. Jump → `focusJump`, `seekSeq + 1`. Leaving the Month tab writes `inView` into `focus.month` (`focusMonth`). `openAdd` starts on `focus.selected` while the Month shows (Ruling 3). `back()` and `backActive` lose the picked step; `itemOpen` on the Month is `selected !== null && monthShown`. Swipes: `useTelegramVerticalSwipes(activeTab === 'month' || pickerOpen || jumpShown || dragging)`. `HomeTop` loses `sticky` and `HOME_TOP_CSS` its `.is-sticky` rule (Ruling 4; `publishTopHeight` stays). The top-level `HomeBanners` renders only when the Month tab doesn't show.

- [ ] **Step 1: Rewrite the home render smoke's Month checks first, against the new behaviour** (they fail on the old code): #43 one `import('./MonthView')`, which loads MonthPane, MonthSquares, DayPanel and SplitHandle; #45 the Month opens on today's month with today selected and its list shown, swipes off before the first answer; #46 swipes off on the whole Month tab (collapsed, grown, wide), on in the Agenda and after unmount, `isVerticalSwipesEnabled` never read, a 7.0 client makes no call; #47/#48 the handle toggles and v2 remembers it, a stored v1 `'browse'` opens grown once, no BackButton for either state, the item sheet's BackButton closes only the sheet; #54 no `transform`/`filter` on any ancestor of the Month and `overflow` other than visible only on `.ch-mv` and the two scrollers; #55 the unavailable row once, first in the day panel's scroller; #56 the header and tabs never stick and `.ch-mv`'s height uses `--ch-top-h`; #57 a tab switch keeps the month in view and the selection; #59b the jump selects the picked day and seeks its month, the span follows; #72/#72b Done from a list row; #75a/#76 "+" starts on the selected day; #d1–#d11 chips in large squares and list rows lift, drops land on squares (small ones included), resting 600 ms on a chevron scrolls the pane one month (Review Focus 4), BackButton cancels a lift; #88–#92 holidays by square size and in the list header; #133 `DayPanel.tsx` imports `ItemRow` from `./ItemRow`; #145 the Daf Yomi line in the list; the file loop at the old line 6818 lists `MonthPane`, `MonthSquares`, `DayPanel`, `DayList`, `HomeHeader`; wide (`matchMedia(WIDE_QUERY)` true in `fakeMediaList`) shows pane and panel side by side with no handle; a selected day two months from the month in view still loads (Review Focus 3). Keep every check whose subject is unchanged; delete only checks of removed things (All months, picked's BackButton, the page-scroll and peek maths), each replaced by its new-behaviour check above.
- [ ] **Step 2: Run the render smoke; expect those checks to FAIL.**
- [ ] **Step 3: Implement MonthView and the CalendarHome wiring; delete the old views, helpers and smokes; update the other smokes' imports and CSS lists (`MONTH_SQUARES_CSS`, `MONTH_PANE_CSS`, `DAY_PANEL_CSS`, `SPLIT_HANDLE_CSS`, `MONTH_VIEW_CSS` into smoke-app-ui's `home` map and smoke-calendar-colours' list; smoke-hebrew-anniversary to `SquareChip`/`MONTH_SQUARES_CSS`).**
- [ ] **Step 4: Run `npx tsc --noEmit`, `npm run lint` and every smoke (`bash scripts/ci-smokes.sh` with the fake env); expect all PASS.**
- [ ] **Step 5: Commit** `feat(month): one Month screen: the month and the selected day together, side by side when wide and a split with a handle when upright; All months and the tapped-day screen go`.

### Task 7: The short header

**Files:**
- Modify: `app/[locale]/(app)/dashboard/home-shell.ts` (an `@media (max-height: 520px) and (orientation: landscape)` block at the end of `HOME_SHELL_CSS`, after the option rules, its selectors indented so the single-rule lookups of other smokes still find one match)
- Test: `scripts/smoke-zmanim-sheet.ts` (a new check), `scripts/smoke-home-weather.ts` (still green)

- [ ] **Step 1: Write the failing check**: the block exists once; inside it `.ch-head` doesn't wrap, the title is one line at 17 px, `.ch-head-text` lays its children in a row with `.ch-head-zone` on a line of its own (`flex-basis: 100%`); `.ch-day-holiday`, `.ch-head-zman`, `.ch-head-next`, `.ch-head-weather-place`, `.ch-head-weather-range` and `.ch-head-weather-days` are `display: none`; the Hebrew date (the date tile, or the line's text without the tile) and `.ch-head-weather-now` stay; the buttons stay 44 px; logical properties only.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run it and smoke-home-weather; expect PASS.**
- [ ] **Step 5: Commit** `feat(home): a one-line header on short windows (a phone held sideways)`.

### Task 8: Pop-ups as centred cards on wide windows, the Agenda as a column

**Files:**
- Modify: `components/app-ui/BottomSheet.tsx` (`card?: boolean`, default false: adds `ch-sheet-card` to the layer's class only), `components/app-ui/theme.ts` (after `.ch-sheet-full`: an `@media (min-width: 600px)` block for `.ch-sheet-card`), the home's sheets (`ItemSheet`, `SendSheet`, `MenuSheet`, `ZmanimSheet`, `ScopeSheet` and `ConfirmSheet`, `EditorSheet`, `RepeatSheet` pass `card`; `DatePickerSheet` and `TimePickerSheet` take `card?: boolean` and forward it, and only the home's call sites pass it), `AgendaView.tsx` (`AGENDA_CSS`: `@media (min-width: 600px) { .ch-agenda { max-inline-size: 720px; margin-inline: auto } }`)
- Test: `scripts/smoke-app-ui.ts` (K-check for the card), `scripts/smoke-calendar-home-render.ts` (the home's sheets carry the class)

**Interfaces:**
- Card CSS values: the layer centres (`justify-content: center; align-items: center; padding: 16px`); `.ch-sheet-card > .ch-sheet` `inline-size: 480px; max-inline-size: 100%; max-block-size: 85vh; border-radius: 20px; padding-block-end: 16px;` with an opacity-and-scale entry keyframe `ch-card-in` (180 ms); `.ch-sheet-card > .ch-sheet-full` `flex: none; inline-size: 640px; block-size: 85vh; padding: 0; border-radius: 20px; overflow: hidden`; `.ch-sheet-card .ch-sheet-grab { display: none }`.

- [ ] **Step 1: Write the failing checks**: `BottomSheet` without `card` renders exactly today's markup (the class strings `ch-sheet-layer`, `ch-sheet-backdrop`, `ch-btn ch-sheet-close`); with `card` the layer's class is `ch-sheet-layer ch-sheet-card` and nothing else changes; theme CSS has the block with the values above and passes `lintCss`; every home sheet passes `card`, and Settings, Calendars, Select calendars, Pair, admin and the site's menu don't; `AGENDA_CSS` has the 720 px column rule; the editor's Save bar still sticks inside the 640 px card (`.ch-save-bar` rules unchanged).
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run smoke-app-ui, the home render smoke, smoke-site-chrome, smoke-settings-render; expect PASS.**
- [ ] **Step 5: Commit** `feat(home): on wide windows the home's sheets are centred cards and the Agenda a centred column`.

### Task 9: Docs and the full gate

**Files:**
- Modify: `docs/superpowers/specs/2026-11-19-responsive-home-design.md` (status: release 2 built, with the rulings above), `docs/superpowers/specs/2026-10-16-calendar-home-design.md` §7.1/§7.4 (one line each: the Month is one screen with inner scrollers per the responsive-home spec), README only if it describes the two Month screens.

- [ ] **Step 1: Update the docs.**
- [ ] **Step 2: Run the CI mirror on a fresh clone; expect every step exit 0 and all smoke files passed.**
- [ ] **Step 3: Commit** `docs(month): release 2 of the responsive home is built`.

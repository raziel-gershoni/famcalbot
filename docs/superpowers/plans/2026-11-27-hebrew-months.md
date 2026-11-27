# Hebrew months on the Month (responsive home, release 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A switch on the Month's bar turns every month pane into a Hebrew month (Tishrei … Elul, Adar I and Adar II in leap years), saved on the account; Jewish calendar only.

**Architecture:** A month key can name a Hebrew month (`h5787-03`: the Hebrew year and the month's place from Tishrei, 01–13). grid.ts's arithmetic dispatches on the key's kind, so the span, the fetch windows, the holidays, the focus, the chevrons, Today, the jump and drag all work on Hebrew keys with no second code path; only "which month holds this day" asks for a mode. The home holds the chosen mode, remounts the pane when it changes, and saves it through `/api/settings`.

**Tech Stack:** Next.js 16 client components, `@hebcal/hdate` (already in the home's bundle; never `@hebcal/core` on the client), Prisma 7 migration, next-intl messages, the repo's `scripts/smoke-*.ts` tests (`npx tsx scripts/<file>`; the fake env from `scripts/ci-smokes.sh`).

**Spec:** `docs/superpowers/specs/2026-11-19-responsive-home-design.md` §7 (with §8, §10), amended by the owner's answers to this plan's decisions (recorded in the spec's status line at ship).

## Global Constraints

- Shows only for the Jewish calendar (`facts.hebrewDates`); with it off the Month is Gregorian and the stored choice is kept.
- Saved on the account: `User.monthMode String @default("gregorian")`, values `'gregorian' | 'hebrew'` only; anything else is refused with 400 and nothing of that request is written.
- The reach stays 1900-01-01 … 2100-12-31. Hebrew months: `h5660-05` (Sh'vat 5660, which starts on 1900-01-01) … `h5861-03` (Kislev 5861, cut to end on 2100-12-31; its 30th day, 2101-01-01, is outside and blank).
- Week start, the Agenda and the day list are unchanged.
- Hebrew months use `@hebcal/hdate` only, and never `@hebcal/core`, in client files.
- No `:hover`; nothing under 11 px; 44 px taps; logical properties; light/dark from the theme tokens; lucide only, no emoji.
- Copy in `messages/{en,he,ru}.json` only; Hebrew gender-neutral, Russian formal and natural.
- Never `npm run build`; never call the real Telegram API; smokes on the fake env.
- One code path: the bar's title and the jump sheet's title come from one function (`monthTitle`).

## Review Focus

1. Switching the mode while a day far from today is selected: the pane opens on that day's month in the new calendar, the selection kept, no blank or stuck pane (Task 5, `R3 switch keeps the day`).
2. A Hebrew month that straddles a Gregorian month the store already holds: its days show what was fetched, never "loading" forever, and the loader limits it like any month (Task 3, `L-H1`/`L-H2`).
3. Adar in leap and common years and the Elul → Tishrei turn: the chevrons step Shvat → Adar I → Adar II → Nisan in 5787 and Shvat → Adar → Nisan in 5786, and Elul 5787 → Tishrei 5788 (Task 1, `H3`).
4. The reach's last Hebrew month: Kislev 5861's last day (2101-01-01) is blank and never fetched; the range route never gets a window past 2101-01-01 (Task 1, `H5`; Task 2, `M-H6`).
5. The culture switched away from Jewish while Hebrew months are on (another device, Settings): the next answer's `hebrewDates: false` turns the Month Gregorian at the selected day's month without a reload (Task 5, `R4 culture off`).

---

### Task 1: Hebrew month keys in the grid

**Files:**
- Create: `src/lib/calendar-view/hebrew-months.ts`, `src/lib/calendar-view/month-mode.ts`, `scripts/smoke-hebrew-months.ts`
- Modify: `src/lib/calendar-view/grid.ts`
- Test: `scripts/smoke-hebrew-months.ts`, `scripts/smoke-calendar-grid.ts` (must stay green unchanged)

**Interfaces:**
- Produces (`month-mode.ts`, no imports): `type MonthMode = 'gregorian' | 'hebrew'`; `isMonthMode(value: unknown): value is MonthMode`.
- Produces (`hebrew-months.ts`, `@hebcal/hdate` only): `isHebrewMonthKey(key: string): boolean` (`/^h\d{4}-\d{2}$/`, place 1 … the year's month count); `hebrewMonthKeyOf(day: DayKey): MonthKey` ('' for a malformed day); `hebrewMonthOrdinal(key: MonthKey): number | null` (consecutive across years: months elapsed before the year, `Math.floor((235 * y - 234) / 19)`, plus place − 1); `hebrewMonthAt(ordinal: number): MonthKey`; `hebrewMonthDays(key: MonthKey): { first: DayKey; last: DayKey } | null` (real civil days, not cut).
- Produces (`grid.ts`): `monthModeOf(month: MonthKey): MonthMode`; `monthOf(day: DayKey, mode: MonthMode = 'gregorian'): MonthKey`; `monthOrdinal(month: MonthKey): number | null`; `monthReach(mode: MonthMode): { first: MonthKey; last: MonthKey }`; `defaultSpan(today: DayKey, mode: MonthMode = 'gregorian')`. Every existing export (`addMonths`, `monthFirstDay`, `monthLastDay`, `monthWindow`, `monthGrid`, `spanMonths`, `inSpan`, `nearSpanEdge`, `growSpan`, `spanToShow`) takes either kind of key and keeps its Gregorian results byte for byte. A Hebrew month's first and last days are cut to the reach's days; `monthWindow` is `{ from: first, to: the day after last }` for both kinds. Order and reach checks compare ordinals of the same kind, never key strings. `spanToShow(span, month)` with a month of the other kind returns the span around that month.

- [ ] **Step 1: Write `scripts/smoke-hebrew-months.ts`** (the repo's check/assert pattern), checks:
  - `H1 keys`: `hebrewMonthKeyOf('2026-11-27') === 'h5787-03'`; `hebrewMonthKeyOf('1900-01-01') === 'h5660-05'`; `hebrewMonthKeyOf('2100-12-31') === 'h5861-03'`; `isHebrewMonthKey('h5786-13') === false` (5786 is common), `isHebrewMonthKey('h5787-13') === true`, `isHebrewMonthKey('2026-11') === false`; `hebrewMonthKeyOf('2026-02-30') === ''`.
  - `H2 days`: `monthFirstDay('h5787-03') === '2026-11-11'`, `monthLastDay('h5787-03') === '2026-12-10'`; Adar I 5787 `h5787-06` starts `'2027-02-08'`, Adar II `h5787-07` starts `'2027-03-10'` and has 29 days; `monthWindow('h5787-03')` deep-equals `{ from: '2026-11-11', to: '2026-12-11' }`; `monthGrid('h5787-03', 0)` has 5 rows starting `'2026-11-08'`.
  - `H3 steps`: `addMonths('h5787-05', 1) === 'h5787-06'`, `addMonths('h5787-07', 1) === 'h5787-08'`, `addMonths('h5786-05', 1) === 'h5786-06'`, `addMonths('h5786-06', 1) === 'h5786-07'` (Adar → Nisan), `addMonths('h5787-13', 1) === 'h5788-01'`, `addMonths('h5788-01', -1) === 'h5787-13'`; ordinal round trip `hebrewMonthAt(hebrewMonthOrdinal(k)) === k` and `monthOf(monthFirstDay(k), 'hebrew') === k` for every month of the reach.
  - `H4 mode`: `monthOf('2026-11-27') === '2026-11'`, `monthOf('2026-11-27', 'hebrew') === 'h5787-03'`; `monthModeOf('h5787-03') === 'hebrew'`, `monthModeOf('2026-11') === 'gregorian'`; `isMonthMode('hebrew')`, `!isMonthMode('Hebrew')`, `!isMonthMode(null)`.
  - `H5 reach`: `monthReach('hebrew')` deep-equals `{ first: 'h5660-05', last: 'h5861-03' }`; `monthLastDay('h5861-03') === '2100-12-31'`; `monthWindow('h5861-03').to === '2101-01-01'`; `addMonths` past either end of the reach inside a span stays inside (`growSpan`, `spanToShow` never return a Hebrew month outside the reach).
  - `H6 span`: `defaultSpan('2026-11-27', 'hebrew')` has 31 months from `addMonths('h5787-03', -12)` to `addMonths('h5787-03', 18)`; `spanToShow(defaultSpan('2026-11-27'), 'h5787-03')` equals `defaultSpan('2026-11-27', 'hebrew')`; `inSpan` of a Gregorian span and a Hebrew key is false.
  - `H7 client-safe`: `hebrew-months.ts` and `grid.ts` import no `@hebcal/core` (read the files' import lines).
- [ ] **Step 2: Run it and watch it fail.** Run: `npx tsx scripts/smoke-hebrew-months.ts`. Expected: FAIL (the module does not exist).
- [ ] **Step 3: Implement** `month-mode.ts`, `hebrew-months.ts` and grid.ts's dispatch as the Interfaces block says. hebcal's month numbers are Nisan = 1 … Elul = 6, Tishrei = 7 … Adar I = 12, Adar II = 13; the place from Tishrei maps to them by the year's leap flag (`HDate.isLeapYear`). Update grid.ts's header comment (it now reads `@hebcal/hdate` through hebrew-months.ts).
- [ ] **Step 4: Run both smokes.** Run: `npx tsx scripts/smoke-hebrew-months.ts && npx tsx scripts/smoke-calendar-grid.ts`. Expected: all passed.
- [ ] **Step 5: Commit** `feat(month): Hebrew month keys in the grid's arithmetic`.

### Task 2: The Month's model and title in Hebrew months

**Files:**
- Create: `src/lib/calendar-view/month-title.ts`
- Modify: `src/lib/calendar-view/month.ts`, `src/lib/calendar-view/picker-model.ts` (pageTitle), `scripts/smoke-calendar-month.ts`, `scripts/smoke-month-layout.ts` (the cell literal gains the new field)
- Test: `scripts/smoke-calendar-month.ts`, `scripts/smoke-date-picker.ts` (stays green)

**Interfaces:**
- Consumes: Task 1's `monthOf`, `monthModeOf`, `monthOrdinal`, `monthReach`, `MonthMode`.
- Produces: `monthTitle(month: MonthKey, lang: string, hebrewDates: boolean): { title: string; subtitle: string }` in `month-title.ts` (Gregorian: `formatMonthTitle(month, lang, true)` over `hebrewDates ? hebrewMonthHeader(month, lang) : ''`; Hebrew: `hebrewMonthRange(first, last, lang)` over `formatMonthRange(first, last, lang)`). `pageTitle` returns `monthTitle` of its page's month.
- Produces (`month.ts`): `initialFocus(today, mode: MonthMode = 'gregorian')`; `focusInMode(f: MonthFocus, mode: MonthMode): MonthFocus` (month = `monthOf(f.selected, mode)`, the same object when `f.month` is already of that kind); `focusToday`, `focusJump`, `clampFocus`, `canStepMonth`, `wantedFocusMonths` work in the kind of the focus or month they are given (selected day's month in the anchor's kind; distances by `monthOrdinal`). `MonthCell` gains `gregorianMonthStart: boolean` (in a Hebrew month: the Gregorian 1st or the month's first day; false in a Gregorian month and on blank cells); in a Hebrew month `hebrewMonthStart` is false on every cell. A cell is in the month when its day is within `[monthFirstDay(month), monthLastDay(month)]`.

- [ ] **Step 1: Add checks to `scripts/smoke-calendar-month.ts`:**
  - `M-H1 cells`: `buildMonth(store, 'h5787-03')` (week start 0, today 2026-11-27): the in-month days are exactly 2026-11-11 … 2026-12-10; `gregorianMonthStart` exactly on `['2026-11-11', '2026-12-01']`; `hebrewMonthStart` on none; `loadingMonth('h5787-03', 0, '2026-11-27')` has the same in-month days.
  - `M-H2 focus`: `initialFocus('2026-11-27', 'hebrew')` deep-equals `{ month: 'h5787-03', selected: '2026-11-27' }`; `focusJump(that, '2027-02-20').month === 'h5787-06'`; `focusToday({ month: 'h5787-08', selected: '2027-04-10' }, '2026-11-27')` deep-equals `{ month: 'h5787-03', selected: '2026-11-27' }`; `focusInMode({ month: 'h5787-03', selected: '2026-11-27' }, 'gregorian')` deep-equals `{ month: '2026-11', selected: '2026-11-27' }`; `focusInMode(f, monthModeOf(f.month)) === f`.
  - `M-H3 chevrons`: `canStepMonth('h5861-03', 1, today) === false`, `canStepMonth('h5660-05', -1, today) === false`, `canStepMonth('h5787-03', 1, today) === true`.
  - `M-H4 wanted`: `wantedFocusMonths({ month: 'h5787-03', selected: '2027-02-20' }, [], null, '2026-11-27')` starts with the windows of `h5787-03`, then `h5787-06` (the selected day's), then `h5787-04`, `h5787-02`.
  - `M-H5 clamp`: `clampFocus({ month: 'h5900-01', selected: '2026-11-27' }, '2026-11-27').month === 'h5861-03'`.
  - `M-H6 the reach's end`: in `buildMonth(store, 'h5861-03')` the cell of 2101-01-01, if the grid draws it, is blank (`inMonth === false`).
  - `M-H7 titles`: `monthTitle('h5787-03', 'he', true)` deep-equals `{ title: 'כסלו תשפ״ז', subtitle: formatMonthRange('2026-11-11', '2026-12-10', 'he') }`; `monthTitle('h5787-06', 'en', true).title === 'Adar I 5787'`; `monthTitle('2026-11', 'en', true)` deep-equals `{ title: formatMonthTitle('2026-11', 'en', true), subtitle: hebrewMonthHeader('2026-11', 'en') }`; `monthTitle('2026-11', 'en', false).subtitle === ''`.
- [ ] **Step 2: Run and watch the new checks fail.** Run: `npx tsx scripts/smoke-calendar-month.ts`. Expected: the M-H checks FAIL, the rest pass.
- [ ] **Step 3: Implement** as the Interfaces block says; `windowOf` becomes the reach of the key's kind; `monthNumber` gives way to `monthOrdinal`.
- [ ] **Step 4: Run.** Run: `npx tsx scripts/smoke-calendar-month.ts && npx tsx scripts/smoke-month-layout.ts && npx tsx scripts/smoke-date-picker.ts && npx tsx scripts/smoke-hebrew-date.ts`. Expected: all passed.
- [ ] **Step 5: Commit** `feat(month): the Month's model, focus and title in Hebrew months`.

### Task 3: The loader treats a Hebrew month as a month

**Files:**
- Modify: `src/lib/calendar-view/home-loader.ts`, `scripts/smoke-calendar-loader.ts`
- Test: `scripts/smoke-calendar-loader.ts`

**Interfaces:**
- Consumes: Task 1's `monthWindow` (a Hebrew month's window is not 1st-to-1st).
- Produces: the loader's `Ask` carries `month: boolean`, set where the ask is made (the host's `getMonths()` windows, `retryWindow`, their refetches and follow-ups: true; the Agenda's weeks and the default window: false). The shape test `isMonthWindow` is removed; the queue (`MONTH_INFLIGHT_MAX`), the dropped-when-unwanted rule and the follow-ups read the flag.

- [ ] **Step 1: Add checks:** `L-H1` three Hebrew-month windows wanted at once (`h5787-03`, `-04`, `-02`): `MONTH_INFLIGHT_MAX` (2) leave, the third waits until one settles; `L-H2` a Hebrew month's stale Google follow-up is dropped once `getMonths()` no longer lists it, and sent while it does; `L-H3` the Gregorian month checks that exist still pass unchanged.
- [ ] **Step 2: Run and watch L-H1/L-H2 fail.** Run: `npx tsx scripts/smoke-calendar-loader.ts`. Expected: L-H1 FAILS (all three leave at once).
- [ ] **Step 3: Implement** the flag.
- [ ] **Step 4: Run.** Same command. Expected: all passed.
- [ ] **Step 5: Commit** `fix(loader): a Hebrew month's window queues like any month`.

### Task 4: `User.monthMode`, saved and read

**Files:**
- Create: `prisma/migrations/20261127100000_month_mode/migration.sql`, `src/lib/calendar-view/month-mode-client.ts`
- Modify: `prisma/schema.prisma`, `app/api/settings/route.ts`, `src/lib/page-data.ts`, `src/lib/calendar-view/home-props.ts`, `app/[locale]/(app)/PageGate.tsx`, `src/services/account-linking.ts` (`NEW_ACCOUNT.monthMode: 'gregorian'`), `scripts/smoke-address-me-as.ts`, `scripts/smoke-account-merge.ts`
- Test: those two smokes, `scripts/smoke-dead-columns.ts`, `scripts/smoke-page-auth.ts`

**Interfaces:**
- Consumes: Task 1's `MonthMode`, `isMonthMode`.
- Produces: column `monthMode String @default("gregorian")` (comment: the Month's months, Jewish calendar only, spec 2026-11-19-responsive-home §7); migration `ALTER TABLE "User" ADD COLUMN "monthMode" TEXT NOT NULL DEFAULT 'gregorian';`. The route: `monthMode` other than the two values → 400 `{ error: 'Invalid monthMode' }`, nothing written; accepted → saved, the activity log gets the field's name only. `CalendarHomeProps.monthMode?: MonthMode` = `user.culture === 'jewish' && user.monthMode === 'hebrew' ? 'hebrew' : 'gregorian'` (page-data, passed by PageGate like `dafYomi`). `saveMonthMode(userId: number | string, mode: MonthMode): Promise<boolean>` POSTs `/api/settings?user_id=` with `{ user_id, monthMode, initData? }` and the init-data header (as `copy-client.ts` does), never throws, and logs `[month mode] save failed: <status or error kind>` on a failure.

- [ ] **Step 1: Add checks:** in smoke-address-me-as `A10` the route saves `'hebrew'` and `'gregorian'` (200, the row holds it, the activity log has `monthMode` and not the value) and `A11` `'Hebrew'`, `''`, `1`, `null` → 400 `Invalid monthMode`, nothing of the request written; in smoke-account-merge the merge's fixtures gain `monthMode` and a T that never chose takes W's `'hebrew'`; a new check in `scripts/smoke-month-mode-client.ts` (fake `fetch`) that `saveMonthMode` sends the body and header above, returns false on a 429 and on a thrown fetch, and logs no user id beyond the URL's.
- [ ] **Step 2: Run and watch them fail.** Run: `npx tsx scripts/smoke-address-me-as.ts; npx tsx scripts/smoke-account-merge.ts; npx tsx scripts/smoke-month-mode-client.ts`. Expected: the new checks FAIL.
- [ ] **Step 3: Implement** the column, migration, route, props and client; `npx prisma generate`.
- [ ] **Step 4: Run** the three smokes and `npx tsx scripts/smoke-dead-columns.ts && npx tsx scripts/smoke-page-auth.ts && npx tsc --noEmit`. Expected: all passed, no type errors.
- [ ] **Step 5: Commit** `feat(month): the Month's months are saved on the account`.

### Task 5: The switch, the Hebrew squares and the home's wiring

**Files:**
- Modify: `app/[locale]/(app)/dashboard/MonthPane.tsx`, `MonthSquares.tsx`, `MonthView.tsx`, `CalendarHome.tsx`, `messages/{en,he,ru}.json`, `scripts/smoke-month-pane.ts`, `scripts/smoke-calendar-home-render.ts`, `scripts/smoke-calendar-home-copy.ts` (if it lists keys)
- Test: those smokes

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: `MonthPaneProps.monthMode: MonthMode` and `onMonthMode?: (mode: MonthMode) => void` (the switch shows only when `hebrewDates && onMonthMode`); `MonthView` passes both and uses `monthOf(selectedDay, monthMode)` for the day's Retry and `mode={monthMode}` for the jump sheet. Message key `calendarHome.month.hebrewMonths`: en "Hebrew months", he "חודשים עבריים", ru "Еврейские месяцы".

Design (owner decision 1): one 44 × 44 toggle in the bar's gap, before Today: a 32 px pill on the Today pill's tokens showing "א" (aria-hidden), `aria-pressed` on when Hebrew months show, accessible name `month.hebrewMonths`; on, the pill takes the accent fill. Invoke `frontend-design:frontend-design` for the pill's on/off look within the existing tokens. On a bar narrower than 420 px with the toggle shown, the title's small ▾ hides and the title's inline padding goes to 0 (`@container`), so the month and year are never cut at 375 px in en, he and ru with Today showing (measured in the scratchpad with headless Chrome iframes: September 2026 / Сентябрь 2026 / ספטמבר 2026 and Cheshvan 5787 / Хешван 5787).

In a Hebrew pane a square leads with the Hebrew day (`hebrewCellLabel(day, locale, false)`: gematriya in Hebrew, digits in en/ru) and shows the Gregorian day small, as "1 Dec" (`formatDayMonth`) on `gregorianMonthStart`; the line holds the day's holiday only (no month name: the bar names the month). The bar's title and subtitle are `monthTitle(inView, locale, hebrewDates)`. `showToday` compares with `monthOf(today, monthMode)`.

CalendarHome: `chosen` mode state from `props.monthMode`; the shown mode is `facts.hebrewDates && chosen === 'hebrew' ? 'hebrew' : 'gregorian'`. When the shown mode and the focus month's kind differ (a tap, or `hebrewDates` going off), in the render phase like the existing facts block: `focusInMode`, the span becomes `defaultSpan` around the new focus month (`spanToShow`), `near`/`inView` reset, seek bumps, and the pane is keyed by the mode so it remounts on the new month. `initialFocus(facts.today, mode)`. The jump sheet opens on the selected day while it is in the month in view (`monthFirstDay(inView) <= selected <= monthLastDay(inView)`), else on `monthFirstDay(inView)`. A tap sets `chosen` and calls `saveMonthMode` (a failed save keeps the choice for this visit; the log line says why).

- [ ] **Step 1: Add checks:**
  - smoke-month-pane `P-H1` the toggle shows only with `hebrewDates` and `onMonthMode`, `aria-pressed` follows `monthMode`, its name is the message in each language, it sits before Today; `P-H2` a Hebrew pane's bar reads `monthTitle`'s title and subtitle, the chevrons step to `addMonths(inView, ±1)` of the Hebrew kind; `P-H3` a Hebrew square of 2026-11-27 in he leads with "י״ז" and shows "27" small, the square of 2026-12-01 shows "1 בדצמ׳"-style `formatDayMonth('2026-12-01', 'he')`, and no square's line holds a Hebrew month name.
  - smoke-calendar-home-render `R1` `monthMode: 'hebrew'` with a Jewish answer opens on `h5787-03` (fake clock 2026-11-27) and asks the range for `from=2026-11-11&to=2026-12-11` first; `R2` a tap on the toggle POSTs `/api/settings` with `{ monthMode: 'gregorian' }` and the pane shows November 2026; `R3 switch keeps the day` with 2027-02-20 selected, switching to Hebrew shows Adar I 5787 with 2027-02-20 still selected; `R4 culture off` an answer with `hebrewDates: false` while Hebrew shows turns the pane to the selected day's Gregorian month and hides the toggle; `R5` the jump sheet opens on the Hebrew wheels while Hebrew months show.
- [ ] **Step 2: Run and watch them fail.** Run: `npx tsx scripts/smoke-month-pane.ts; npx tsx scripts/smoke-calendar-home-render.ts`. Expected: the new checks FAIL.
- [ ] **Step 3: Implement** as above; messages in all three files.
- [ ] **Step 4: Run** the two smokes, `npx tsx scripts/smoke-calendar-home-copy.ts`, `npx tsx scripts/smoke-he-neutral.ts` (if present), `npx tsc --noEmit`, `npx next lint` or the repo's lint. Expected: all passed. Then the scratchpad width measure at 375 px in three languages. Expected: no cut title.
- [ ] **Step 5: Commit** `feat(month): the Gregorian | Hebrew switch on the Month's bar and Hebrew squares`.

### Ship

- [ ] Whole-branch review (Opus, `superpowers:requesting-code-review`), with this plan's Review Focus; fix every valid finding with a failing test first.
- [ ] Spec status line: release 3 built, the owner's answers to the plan's decisions and Claude's calls. Memory `project_responsive_home.md` updated. Delete this plan file.
- [ ] CI mirror on a fresh clone at the final commit; push to main; `revamp/wait-deploy.sh <SHA>`; push notification.

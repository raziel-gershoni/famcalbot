# Calendar Home, Plan E: Month, Tabs and Swipes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the Month tab and the tab bar to the calendar home for the users the rollout switch covers. That covers:
- the iOS-style Month: browse, with stacked months, the sticky bar, cells with Hebrew days, chips and multi-day bars; and picked, with the compact month and the day's rows;
- per-month fetching with at most 2 in flight;
- tab and layout memory;
- §7.6's swipe rules.

Along the way it takes the Plan D follow-ups that the Month makes worse. Users the switch doesn't cover see no change apart from the dashboard chunk preload and the messages payload named below. The switch stays where the owner set it (`ADMINS` at most until the device check).

**Architecture:**
- Pure modules under `src/lib/calendar-view/`:
  - `grid.ts`: the month grid for any week start;
  - Hebrew month ranges and cell labels added to `hebrew-date.ts`, titles to `format.ts` (E2);
  - Month windows in the store and loader, with the 2-in-flight cap (E3);
  - `month.ts`: the Month model, chips, bars, `limitRow`, `pickedScrollTop` (E5);
  - `home-storage.ts`: tab and layout memory (E4).
- Server: `src/lib/timezone.ts` gets a per-user shared lookup on `globalThis` (E3).
- Views:
  - `HomeTabs.tsx` and the swipe rules in `telegram-ui.ts` (E4);
  - `MonthBrowse.tsx` (E6) and `MonthPicked.tsx` (E7);
  - `MonthView.tsx` with `CalendarHome.tsx`'s tab state, lazily loaded (E8).
- D's Agenda, item sheet, header, banners and sheets are reused.

**Tech Stack:** Next.js 16.1 · React 19 · TypeScript · next-intl (ICU plurals) · Telegram Web App 6.1+ (swipes 7.7+, gated) · `@hebcal/hdate` 0.21 · date-fns · `Intl` · `IntersectionObserver` (with a fallback) · tsx smoke scripts with `react-dom/server` and real React.

**Spec:** `docs/superpowers/specs/2026-10-16-calendar-home-design.md`:
- §5 (Month windows);
- §7.1 (tabs, tab memory);
- §7.4 (Month);
- §7.6 (swipes, BackButton in picked);
- §7.7 (tabs and Month accessibility);
- §7.8 (the Month cell's Hebrew day and the month-header ranges);
- §9 (Month copy);
- §10 (Plan E smokes and the device check);
- Rulings R11, R12 and R19.

This is the last of the spec's five delivery plans (A → B → C ∥ D → E); Plans A–D are on `main` (0064e8f). The approved mockups (`Main.dc.html` with the tab bar; `MonthFlow` and `MonthPicked`, the iOS-style Month; `Hebrew`; `Dark`) are the visual reference. Where a mockup draws text under 11 px or 36 px tab buttons, the 11 px floor and 44 px targets win.

## Global Constraints

- Plan D's Global Constraints hold unchanged (the public repo, no test runner, the fake-env smoke prefix, no schema change, commit checks and trailers, branch `feat/calendar-home`, client-safe imports, the mobile Mini App rules, natural gender-neutral copy, user ids). In short:
  ```bash
  TZ=UTC DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/<name>.ts; echo "exit $?"
  ```
  Each task's smokes run under `TZ=UTC` and `TZ=Asia/Jerusalem`. E2, E3 and E5 also run under `TZ=Pacific/Kiritimati`, and E2 under `TZ=America/Santiago`, whose DST change falls at midnight.
- Every commit passes `npx tsc --noEmit -p .` and `npm run -s lint`, and its message ends with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
  ```
- Never push to `main` from a task, and never force-push. Task 9 (the controller) lands the plan.
- Every Telegram call is gated with `isVersionAtLeast` and wrapped in try/catch. Every storage access is wrapped in try/catch. `isVerticalSwipesEnabled` is never read.
- Mobile layout:
  - logical properties only;
  - `dir="auto"` / `<bdi>` on titles and names, `dir="ltr"` on digits and times;
  - directional icons flipped with `.ch-flip`;
  - no ancestor of the Month uses `overflow: hidden`, and the frame has no transform or filter (sticky positioning).
- Render smokes copy the harness pieces they need from `scripts/smoke-calendar-home-render.ts`; no shared test helper is added.
- **Fixed values:**
  - the window runs `MONTHS_BACK = 12` to `MONTHS_AHEAD = 18`;
  - browse cells are about 92 px; picked cells are 46–48 px;
  - at most 3 chips per cell, 2 at 360 px or narrower, then "+N";
  - at most 2 Month windows in flight;
  - storage keys `famcal:homeTab:v1:{userId}` (`sessionStorage`) and `famcal:monthLayout:v1:{userId}` (`localStorage`);
  - a caller joins a running timezone lookup only within its first 1,500 ms.

## Review Focus

The five conditions most worth a reviewer's eye, most likely first. Each names the check that pins it (check numbers as of the reference chain).

1. **Browse at today's month (6,400 px down the list): back to the Agenda, ⋯ → Refresh or Send.** While the Month shows browse (its loading included), the header and the tab bar sit in one wrapper, `.ch-home-top`, that sticks under the safe areas, above browse's bar (z-index 4 over 3) and under the sheets (50); its height goes on `.ch-home` as `--ch-top-h`, where browse's bar sticks and its titles stop. So the Agenda tab, Send and ⋯ are a tap away, and Refresh asks the months near the one on screen. On the Agenda and in picked the wrapper scrolls with the page. Pinned by E8's `smoke-calendar-home-render` #56 (the tablist's wrapper sticky in browse and not on the Agenda or in picked, its CSS against the bar's and the sheets' z-index, `--ch-top-h` = the wrapper's height, the bar's top and the titles' scroll margin using it, and ⋯ → Refresh from 6,400 px down asking October, November and September with `fresh=1`), E6's `smoke-calendar-month-browse` #12 (the two CSS values) and #24 (the opening scroll, the month in view and Today under a 126 px sticky region). Device-check line: from browse at October, reach the Agenda, ⋯ → Refresh and Send without scrolling.

2. **iOS (no scroll anchoring): content above browse changes height while the user is scrolled.** The Reconnect banner and the unavailable calendars hold for the store's epoch once an answer shows them (a dead token answering `ok` from Google's cache no longer hides the banner; a legend from an older cache entry no longer hides the row), and a store drop clears both. Whatever still changes height above the list (the first time each of those appears, the header's "Times in <zone>" line around a store drop) moves the list in the document, and browse puts the month in view back under the bar with one instant scroll; at the page's top nothing scrolls. Pinned by E3's `smoke-calendar-agenda` (the epoch check: ok, reconnect, ok keep `reconnect` at "token", a calendar once unavailable stays counted, a reset clears both; and D's reconnect check, which now wants the banner kept over a later ok answer) and E6's `smoke-calendar-month-browse` #23 (scrolled 40 px into January, a month's answer with +62, +56 and -118 px above the list gives one instant scroll each and keeps January 40 px under the bar; nothing moved, no scroll; at the page's top, no scroll). Device-check line: a dead Google token while scrolling months, some cached and some not.

3. **A Google user whose cache entries are 3-30 minutes old browses at about 0.7 s a month.** A month's stale re-request and its error retry go only while the host still wants the month when they fall due, slot or no slot; queued months were already dropped that way. The review's fling probe now sends about 40 requests in the first minute (38 to 43 across runs; it was 60, the limiter's whole allowance), one for a month left behind while its request was out (19 before); 32 with fresh entries, as before. Pinned by E3's `smoke-calendar-loader` (October answered stale and November with a transient error, the wanted months moved to March and April, both slots free: no October or November request after `ERROR_RETRY_MS`; March's stale re-request, still wanted, goes). Device-check line: a fling through 31 months stays under the rate limit, with no 429 notice.

4. **A 360 px screen with three overlapping multi-day bars** (Alpha 5-7, Beta 6-8, Gamma 7-9 October, week start 0). Bars keep their lanes while a day's slots fit; a day that overflows first lets its one-day items into a bar's empty lanes, then moves its bars up, each one that leaves its lane named, then "+N". `limitRow` names a bar wherever the day before didn't draw it in the same slot. So on a narrow screen the 9th shows Gamma, named, not "+1" under two empty lines, and the 8th shows Beta and Gamma, both named; wide, the three stay in their lanes. Pinned by E5's `smoke-calendar-month` (the limitSlots check's overflow cases; the limitRow check on that fixture at both widths, a bar hidden and back, a bar moved up and back, and every row of the fixtures at both widths: no spacer over "+N", no "+N" while the items fit, no item lost, no bar nameless) and E6's `smoke-calendar-month-browse` #25 (the same fixture through the view, narrow and wide, and Foxtrot hidden behind "+2 more" on the 12th and named on the 13th). Device-check line: 11 px cell text and chips on a 360 px phone.

5. **Small phones: a 6-row month in picked with Hebrew dates and the trial and location banners on 375 × 667 (or 320 × 568).** From E7's CSS the day's header ends at 571 px under the header and the tab bar, 695 px under the two banners, against about 560-590 px of screen under Telegram's header. Entering picked now goes to the top only while the day's header and its first row fit; else it scrolls just far enough to show them, never past picked's bar (390 × 844: 0, or 19 px with the banners; 375 × 667: 27 px for 5 rows, 75 px for 6, 199 px with the banners; 320 × 568: to the bar). Pinned by E5's `smoke-calendar-month` (pickedScrollTop: the top while they fit, the cap at the layout's top, 0 for anything not finite) and E7's `smoke-calendar-month-picked` #13 (the sum of E7's fixed heights from its CSS, 50 + 46 + 27 + 6 × 48 + 37 px, for those screens with and without the banners, and in real React one `scrollTo(0, 199)` on a 560 px screen, `scrollTo(0, 227)` under a 20 px safe area at 470 px, `scrollTo(0, 0)` on a tall one). Device-check lines: a 6-row picked month (August 2026) with both banners on 375 × 667 and 320 × 568; 320 px browse cells with "+12 more" and the Russian short months.

## Planning Rulings

Decided while splitting, drafting, integrating and reviewing. Rulings 1–10 come from the split. Rulings 11–16 come from the review patch, and each refines an earlier one where they overlap. The spec is updated to match (§5, §7.1, §7.4) in the commit that adds this plan. Executors treat these as binding. The owner may want to change the UI choices in 3, 4, 6 and 11–16.

1. **The tab bar** sits under the header and above the banners, as in `Main.dc.html`. It shows only when a tab panel can show: not blocked, no home card (busy, retry, switch-off), and not `setupNeeded`. While `setupNeeded`, the home behaves as D's: the Agenda panel and no tab bar. The stored tab is left as it is. *Why:* with nothing chosen, a Month tab would be a dead end (R19's reason).
2. **Tab memory:** `sessionStorage` key `famcal:homeTab:v1:{userId}`, value `'agenda' | 'month'`. Anything else, or a throwing storage, reads `'agenda'`. A new session opens on the Agenda, the landing tab (§7.3). A tab switch closes any sheet. The Agenda opens at the top. The Month's browse comes back with the month that was in view under the bar. **Layout memory:** `localStorage` key `famcal:monthLayout:v1:{userId}`, value `'browse' | 'picked'`. A restored picked layout opens on today (§7.4).
3. **Browse cell lines** (92 px; the 11 px floor). The cell has four parts:
   - a head line: the Gregorian day, with the Hebrew day number at its end;
   - a second 13 px line: the Hebrew month name on Hebrew day 1 and on the month's first cell, empty otherwise. This is the line §7.4 keeps for holidays;
   - 3 slots of 18 px;
   - an overflow rule: a day with more items than fit shows 2 chips and "+N" in the third slot. A 360 px or narrower screen shows at most 2 chips, so a day with exactly 3 shows 2 + "+1".

   *Why:* at about 54 px wide, "1 Chesh." doesn't fit beside the day at 11 px, and 92 px holds the head, one line and three slots. *If wrong:* the model's constants and E6's CSS.
4. **Month notices overlay the grid.** These are failed, busy, calendars gone and partial. A failure shows as a pill centred over dimmed cells. Partial shows as a pill at the grid's top over live cells. They never change a month's height. A reconnect dims the cells and adds no pill, because the Reconnect banner covers it. "N calendars aren't available · Choose again" shows once, above the Month. *Why:* the window renders with known heights, and iOS's WKWebView has no scroll anchoring, so a row appearing above the viewport would jump the page.
5. **R11, extended:** daily-repeating reminders (`repeatsDaily`) are left out of the chips, the dots, "+N" and the cell's label count. They are listed under the picked day. *Why:* a count must match what's drawn.
6. **Today and picked.**
   - Browse's Today button shows while no part of today's month is on screen. It scrolls smoothly, or instantly under `prefers-reduced-motion`.
   - Picked's Today pill shows while the selected day isn't today.
   - Entering picked scrolls the page to the top: the header, the tabs, the bar, the compact month and the start of the list fit in one screen, as in the mockup. Focus moves to the selected day.
   - "All months", Telegram's BackButton and Android's back gesture return to browse, with the picked month under the sticky bar.
7. **Month fetching (§5).**
   - The 2-in-flight cap counts Month windows only. The Agenda's weeks keep D's flow.
   - Every send for a month window goes through the cap: the first ask, a refetch, Retry, and the stale and error follow-ups.
   - A queued month that is no longer wanted when its turn comes is dropped and isn't marked asked.
   - A return to the foreground and ⋯ → Refresh ask again for the tab on screen. On the Agenda that is its weeks. On the Month in browse it is the months near the viewport; in picked it is the picked month and the months on each side.
   - Without `IntersectionObserver`, "near" is the month in view and its two neighbours.
8. **Titles and weekdays.**
   - A month's `h2` names the month, with the year when it isn't today's year, then the Hebrew range when it's on. The sticky bar and the picked title always carry the year.
   - Russian month names are the standalone nominative, capitalised, without "г." ("Октябрь 2026").
   - The weekday row is en narrow ("S M T W T F S"), he narrow ("א׳ ב׳ …") and ru two-letter ("Пн Вт …"), in `weekStart` order.
9. **Swipes (Bot API 7.7+).**
   - Locked (`disableVerticalSwipes()`) while the Month tab shows browse, its loading state included.
   - `enableVerticalSwipes()` in every other state, on mount when not locked (a reload can leave swipes off), on unmount, and before a reload.
   - `isVerticalSwipesEnabled` is never read.
10. **D's deferred list** (`plans/E/D-deferred.md`).
    - **Taken:**
      - the old epoch's failure flash (E3);
      - the per-window failure reason (E3);
      - the parity parser, because the Month adds plurals (E1);
      - the per-user in-flight timezone lookup, because the Month fetches many windows (E3).
    - **Not taken** (they stay on the before-ALL list):
      - the BottomSheet focus trap and StillOpenCard's `aria-expanded`: the Month adds no sheet, since picked rows open D's item sheet;
      - `useTelegramTheme`'s shared handler: the Month adds no second user;
      - the page-data hint logging, the masked carry-over's empty name and the `linkText` scheme allowlist: none of them touches the Month.
11. **The header and the tab bar stick while the Month shows browse** (E8). They sit in one wrapper, `.ch-home-top`, whose height is `--ch-top-h`; browse's bar sticks under it. On the Agenda and in picked they scroll with the page, as in D. *Why:* from 6,400 px down the months, the Agenda tab, Send and ⋯ stay a tap away. The mockups fix them on every screen; on short screens they take about 126 px. *If wrong:* one CSS rule per layout.
12. **Entering picked on a short screen** (refines 6). It goes to the top only while the day's header and its first row fit. Otherwise it scrolls just far enough to show them, never past picked's bar (`pickedScrollTop`). "Fits one screen" holds only on tall phones.
13. **An overflowing day** (refines 3). It first lets its one-day items into a bar's empty lanes. Then it moves its bars up, naming each bar that leaves its lane, and only then shows "+N" (`limitRow`). So a bar may leave its lane and repeat its title, but no day shows "+1" under empty lines.
14. **Banners that would change height above browse** hold for the store's epoch once shown, until midnight or a facts change: the Reconnect banner and the unavailable-calendars row. D followed the latest answer. *Why:* iOS's webview has no scroll anchoring, so a banner that came and went would jump the months.
15. **The Month's views load lazily** (E8). MonthView, MonthBrowse and MonthPicked are fetched with `import()` after the first answer, so the dashboard preload stays at about 93 KB (28.6 KB gzipped) rather than 115 KB. A first Month tap on a slow network can briefly show placeholders.
16. **Follow-ups are only for months still wanted** (refines 7; §5). A month's stale re-request and its error retry go only if the host still wants the month when they fall due. A fling through 31 months then stays under the 60-per-minute limiter (about 40 requests in the first minute).

## File Structure

| File | Task | Change |
|---|---|---|
| `messages/{en,he,ru}.json`, `scripts/check-i18n-parity.ts`, `scripts/smoke-calendar-home-copy.ts` | 1 | The Month and tab copy (`tabs.*`, `month.*`, `hebrewMonthShort`); the parity parser's three fixes |
| `src/lib/calendar-view/grid.ts` (new), `hebrew-date.ts`, `format.ts`; `scripts/smoke-calendar-grid.ts` (new), `smoke-hebrew-date.ts` | 2 | The grid, Hebrew month ranges and cell labels, titles and weekday headers |
| `src/lib/calendar-view/store.ts`, `agenda.ts`, `home-loader.ts`; `src/lib/timezone.ts`; `app/[locale]/dashboard/HomeBanners.tsx` (two comments); `scripts/smoke-calendar-agenda.ts`, `smoke-calendar-loader.ts` (new), `smoke-timezone-inflight.ts` (new), `smoke-calendar-home-render.ts` (#42) | 3 | Month windows and the cap; per-window failure; the old-epoch flash; the epoch-held banners; the shared timezone lookup |
| `src/lib/telegram-ui.ts`, `src/lib/calendar-view/home-storage.ts` (new), `app/[locale]/dashboard/{HomeTabs.tsx (new), home-theme.ts, HomeErrorBoundary.tsx}`; `scripts/smoke-telegram-ui.ts`, `smoke-calendar-home-tabs.ts` (new) | 4 | Tabs, tab and layout memory, swipes, the Month's colours |
| `src/lib/calendar-view/month.ts` (new); `scripts/smoke-calendar-month.ts` (new) | 5 | The Month model |
| `app/[locale]/dashboard/MonthBrowse.tsx` (new); `scripts/smoke-calendar-month-browse.ts` (new) | 6 | Browse |
| `app/[locale]/dashboard/MonthPicked.tsx` (new); `scripts/smoke-calendar-month-picked.ts` (new) | 7 | Picked |
| `app/[locale]/dashboard/{CalendarHome.tsx, MonthView.tsx (new), BottomSheet.tsx}`; `scripts/smoke-calendar-home-render.ts` (#22, #43 on) | 8 | The container's tabs, the lazy Month, the sticky top in browse, the sheet's focus trap |

Tasks run in order 1 → 9. Each later task consumes the modules of earlier ones (each task's **Interfaces** block names them). Line numbers are as of the state each task starts from on `main` 0064e8f plus the tasks before it; every Before block is matched by its text, which is unique in its file. Inside the tasks, cross-references use the draft names: E*N* is Task *N*.

---

### Task 1 (E1): Copy and the parity parser

> **Interface change versus the split: none.** The split's key names stand, each with the arguments its Copy table implies. What the later tasks should know:
> - **Arguments:** `month.dayToday {date}`, `month.more {count}`, `month.moreShort {count}`, `month.cellItems {count}` (an ICU plural), `month.cellFromPartner {count} {name}`. Every other new key takes none. `month.more` is a plain `{count}` in all three languages ("+2 more", "עוד 2", "Ещё 2"), because none of them needs a plural form there.
> - **The cell label is built by E6 from parts**, joined with ", ": the weekday and date (E2's format), the Hebrew day, then `cellItems` and `cellFromPartner` when the day has items, then `cellLoading` or `cellFailed` until the day is answered, or `cellNothing` for an answered day with nothing drawn (E6 note 8, E7 note 2). The state words are lower case so they read well mid-label: "Thursday, 15 October, 4 Cheshvan, 3 items, 1 from Noa"; "יום חמישי, 15 באוקטובר, ד׳ בחשון, 3 אירועים, 1 של נועה"; "четверг, 15 октября, 4 хешвана, 3 события, Маша: 1".
> - **Russian `cellFromPartner` is `{name}: {count}`**, so the name stays in the nominative, as D's "От: Маша" does ("от Маши" would need the genitive of any name).
> - **`hebrewMonthShort`** is read with `t.raw('hebrewMonthShort') as string[]` in all three languages (E2's `hebrewCellLabel` takes it as `shortMonths`). Hebrew holds the same plain names the Agenda's day labels use.
> - `scripts/check-i18n-parity.ts` keeps its command line and its problem lines. Only what it accepts changes (the three fixes below).

**What and why:** The tab bar (E4) and the Month (E6, E7) need their words in en, he and ru before they render. Wave 1 drafts E1–E3 in parallel, so this task fixes the key names and texts now. The copy is natural in each language rather than a word-for-word rendering, and it is gender-neutral: Hebrew uses nouns and impersonal forms, Russian keeps names in the nominative. The tab names follow the mockups: "סדר יום" / "חודש" in Hebrew, and "Расписание" / "Месяц" in Russian ("Расписание" is the Russian name Google Calendar gives its list view).

The Month adds plurals, so this task also takes three parity-checker fixes from D's deferred list (Ruling 10). Each one makes the checker agree with the code that actually reads the strings:
- **`bot.*` strings** are filled by `getBotMessage` with a plain `{word}` replace, not by ICU. The checker parsed them as ICU, so "Reply '{word}'" lost its `{word}` to ICU quoting, and a `{` that ICU rejects failed a string the bot prints fine.
- **`''` inside a quoted literal** is one apostrophe in ICU and leaves the quote open. The checker ended the quote at the first `'` of the pair.
- **An `=N` form** stands in for a plural category only when that category holds N and nothing else: `=1` for en/he `one`, `=2` for he `two`. Nothing stands in for ru `one`, which also holds 21, 31, … The checker never let `=N` stand in, so `{count, plural, =1 {Tomorrow} other {In # days}}` failed in English.

Nothing renders the new keys yet: E4, E6 and E7 do. The switch stays as it is, and no user sees a change.

**Files:**
- Modify: `messages/en.json`, `messages/he.json`, `messages/ru.json`. Two spots each, at the same lines in all three (as of 0064e8f):
  - after `:161`, the `},` that closes `calendarHome.agenda` (`:155-161`): the new `tabs` and `month` objects;
  - `:210`, `hebrewMonthGenitive`, the last key of `calendarHome`: it gets a comma, and `hebrewMonthShort` follows it.
- Modify: `scripts/check-i18n-parity.ts`:
  - `:7-14`, the header comment (lines 12-13 change, and a paragraph on `bot.*` is added);
  - `:51-65`, the quote branch of `text()`, with a new `quoteEnd()` before it;
  - `:130-147`: `botArguments`, `isBotKey` and `loneCounts` go between `icuArguments` and `formProblems`, and the plural branch of `formProblems` lets an `=N` form stand in;
  - `:194-195`, the parse call in the main loop.
- Modify (test): `scripts/smoke-calendar-home-copy.ts`:
  - `:1-17`, the header comment;
  - `:182-186`, the end of `KEYS`, and `ARRAY_KEYS`;
  - `:209`: after `RU_GENITIVE`, the three short lists;
  - `:406-407`: the end of #4's cases;
  - `:558-561`: after #14, the new checks #15–#18.
- Test: `scripts/smoke-calendar-home-copy.ts` and `scripts/check-i18n-parity.ts`, under `TZ=UTC` and `TZ=Asia/Jerusalem`. Nothing here buckets days, so `Pacific/Kiritimati` adds nothing.
- Regression (unchanged; they read `messages/*.json` or render with it): `smoke-calendar-home-render`, `smoke-hebrew-date`, `smoke-miniapp-gate`, `smoke-page-auth`, `smoke-admin-panel-ssr`, `smoke-calendar-home-rollout`, the seven native-reminder smokes, `smoke-google-connect`, `smoke-oauth-weather`, `smoke-account-merge`, and Plan C's five summary smokes (Step 3 lists them).

**Interfaces:**
- Consumes:
  - `next-intl` 4.6.1: `createTranslator` (the smoke; it is also the reference for ICU quoting, through intl-messageformat 10.7.18);
  - `@hebcal/hdate` 0.21.1: `Locale.lookupTranslation(name, 'he-x-NoNikud')`, the name D2's `monthLabel` gives in Hebrew (the smoke's #15);
  - D2's `HEBREW_MONTHS` order (the smoke keeps its own copy, as D1 did);
  - `getBotMessage`'s fill rule, `/\{(\w+)\}/g` (bot-messages.ts:77), and `getBotMessages`, which returns only `messages.bot` (:26);
  - `Intl.PluralRules` (Node 22.15 or later; verified on 26.11.1, ICU 78.3, CLDR 48).
- Produces (messages, under `calendarHome`):

| Key | Args | en | he | ru | Read by |
|---|---|---|---|---|---|
| `tabs.label` | — | Calendar view | תצוגת היומן | Вид календаря | E4 HomeTabs: the tablist's `aria-label` |
| `tabs.agenda` | — | Agenda | סדר יום | Расписание | E4 HomeTabs |
| `tabs.month` | — | Month | חודש | Месяц | E4 HomeTabs |
| `month.today` | — | Today | היום | Сегодня | E6's Today button, E7's Today pill |
| `month.allMonths` | — | All months | כל החודשים | Все месяцы | E7's back control |
| `month.previous` | — | Previous month | החודש הקודם | Предыдущий месяц | E7's chevron label |
| `month.next` | — | Next month | החודש הבא | Следующий месяц | E7's chevron label |
| `month.dayToday` | `date` | Today · {date} | היום · {date} | Сегодня · {date} | E7's day header when the day is today |
| `month.more` | `count` | +{count} more | עוד {count} | Ещё {count} | E6's "+N" slot |
| `month.moreShort` | `count` | +{count} | +{count} | +{count} | E7's dots, and E6 where the slot is narrow |
| `month.cellItems` | `count` | {count, plural, one {# item} other {# items}} | {count, plural, one {אירוע אחד} two {שני אירועים} other {# אירועים}} | {count, plural, one {# событие} few {# события} many {# событий} other {# события}} | E6/E7 cell label |
| `month.cellFromPartner` | `count`, `name` | {count} from {name} | {count} של {name} | {name}: {count} | E6/E7 cell label, when the partner has items that day |
| `month.cellNothing` | — | nothing planned | אין אירועים | ничего не запланировано | cell label, an answered empty day |
| `month.cellLoading` | — | loading | בטעינה | загружается | cell label, a loading day |
| `month.cellFailed` | — | couldn’t load | לא נטען | не удалось загрузить | cell label, a failed day |
| `month.failed` | — | Couldn’t load this month | לא הצלחנו לטעון את החודש הזה | Не удалось загрузить этот месяц | E6/E7's failed notice (Ruling 4), with `actions.retry` |
| `hebrewMonthShort` | array | Tish., Chesh., Kis., Tev., Sh'vat, Adar, Adar I, Adar II, Nisan, Iyyar, Sivan, Tamuz, Av, Elul | תשרי, חשון, כסלו, טבת, שבט, אדר, אדר א׳, אדר ב׳, ניסן, אייר, סיון, תמוז, אב, אלול | тишр., хешв., кисл., тев., швата, адара, адара I, адара II, нисана, ияра, сивана, тамуза, ава, элула | E2's `hebrewCellLabel(…, shortMonths)`: "1 Chesh.", "א׳ חשון", "1 хешв." |

  D's keys are reused for the rest, as the split says: `actions.retry` / `chooseAgain`, `state.busy` / `calendarsGone` / `partial` / `unavailable`, `agenda.nothingPlanned`, `shell.loading`, `row.noTitle` and `hebrewMonthGenitive`.
- Produces (how E4, E6 and E7 read it):
  ```
  const t = useTranslations('calendarHome');
  t('tabs.agenda');                                  // "Agenda" / "סדר יום" / "Расписание"
  t('month.cellItems', { count: 3 });                // "3 items" / "3 אירועים" / "3 события"
  t('month.cellFromPartner', { count: 1, name });    // "1 from Noa" / "1 של נועה" / "Маша: 1"
  t('month.more', { count: 2 });                     // "+2 more" / "עוד 2" / "Ещё 2"
  const shortMonths = t.raw('hebrewMonthShort') as string[];   // 14 names; E2's shortMonths
  ```
- Produces (`scripts/check-i18n-parity.ts`): the same command (`npx tsx scripts/check-i18n-parity.ts [messages-dir]`) and the same problem lines. Three changes in what it accepts:
  - a `bot.*` string's arguments are its `{word}`s, and it is never "not valid ICU";
  - `''` inside a quoted literal is one apostrophe and leaves the quote open;
  - a plural with no `one` form passes in en or he when it has `=1`, and with no `two` form in he when it has `=2`. Nothing else stands in.

**Findings that shaped the code:**
- next-intl reads `Say '{it''s}' to {name}` as "Say {it's} to Noa", the same `''` rule as ICU (formatjs `tryParseQuote`). The old checker ended the quote at the first `'` of `''`, then failed the message with `a "}" with no "{"`.
- formatjs lets a quote that never closes run to the end of the message without an error. The checker still fails it, as D1 decided, now also when a `''` sits inside it. formatjs also starts a quote at `'<` and `'>` (tags); the checker doesn't. No message uses them, and the fix is not one of the three, so it is left alone.
- `bot.whatsapp.greeting` is also formatted by next-intl, on the landing, how-it-works and share pages. It has no braces and no apostrophe before one, so both rules agree on it today. If a brace were ever added there, the checker would read it the bot's way only.
- `Intl.PluralRules` over the whole counts 0–1000 gives: en `one` = {1}; he `one` = {1} and `two` = {2}; ru `one` = {1, 21, 31, …}; every en ordinal category holds many counts. Hebrew `one` also holds 0.5, so the check counts whole numbers only. These messages count whole things (items, days, calendars).
- No string in `messages/` today contains `'{`, `''` or an `=N` form (checked over all three files). So the three fixes change no result on the real files: parity stays OK, and the key count goes from 996 to 1013 from the new copy alone (16 keys plus one array).
- Copy choices:
  - Hebrew counts items as "אירועים", matching D's "אין אירועים"; Russian uses "события".
  - Hebrew `cellFromPartner` is "של {name}" (Noa's), because "מאת", D's chip word, reads as "by" here.
  - Hebrew `more` uses digits ("עוד 2"), which avoid choosing between "אחד" and "אחת" for a mix of events and reminders.
  - `hebrewMonthShort`: en and ru cut the four names the approved mockup cuts (Tish., Chesh., Kis., Tev.) and keep the rest whole, since they fit a 46–54 px cell at 11 px. Russian is the genitive cut by the usual rule (after a consonant, before a vowel: "хешв."), so it reads right after a number. Hebrew is never cut. The longest Russian label, "22 адара II", may need E6's or E7's ellipsis in a 46 px picked cell (device check).

**Verified on a copy of 0064e8f** (E1 is in wave 1, so no earlier E draft applies):
- Before (Step 1's smoke on the unchanged checker and messages): `11/18 passed`, exit 1, under `TZ=UTC` and `TZ=Asia/Jerusalem`; #2, #3, #4 and #15–#18 fail (Step 2 has the lines).
- After: `18/18 passed` under both clocks; `check-i18n-parity` prints `i18n parity OK (1013 keys)` (996 before).
- The regression smokes in Step 3 print the same counts before and after, under both clocks.
- `tsc` and lint are clean.
- Mutations caught:
  - the bot rule off → #16; the bot rule on every key → #10–#14, #16–#18;
  - `''` ending the quote again → #17;
  - `=N` never standing in → #18; any `=N` standing in for `one` (so ru passes) → #18; fractions counted in the sweep → #18;
  - ru `few` dropped from `cellItems` → #10;
  - `{name}` renamed in he `cellFromPartner` → #3, #4, #10;
  - the en short list in a Nisan-first order → #15; nikud in a he short name → #15;
  - `tabs.month` missing in ru → #2, #3, #10.
- The task text was replayed with `dapply.py` on a fresh copy of 0064e8f. Every Before block matched once, and the result was byte-identical to the reference commit.

**Verified against stand-ins:** none needed. E1 consumes no other E task's export.

All smoke commands below use this fake environment (never `.env`):
```bash
E="DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake"
```

- [ ] **Step 1: Update the smoke `scripts/smoke-calendar-home-copy.ts`**

Five edits, each Before block matching once. The header comment (`:1-17`):

Before:
```ts
// Smoke test for the calendar home's copy (calendar-home spec §9, §7.8 and Ruling R9;
// Plan D, Task D1).
//
// The calendarHome namespace in messages/{en,he,ru}.json holds every string the new home
// shows. Its key names are a contract: Tasks D2-D7 use them verbatim. So this smoke lists
// them (KEYS, the task's Keys table) and checks that the three files carry exactly those
// keys, each formatting through next-intl with exactly its arguments. It also pins:
//  - the plurals (Russian one/few/many, Hebrew one/two/other) and the weekday select;
//  - the 14 Hebrew month names in Task D2's order (from Tishrei), genitive in Russian (R9);
//  - no slash or bracket gender forms in the Hebrew or Russian copy;
//  - calendarHome as its own top-level object between dashboard and admin, away from the
//    bot.errors keys Plan C adds;
//  - spec §9's fixes on the old screens: the Header's aria-labels and admin badge (also
//    on Subscription and Select calendars), the dashboard loader's "Loading Dashboard...",
//    and the old home's "Free" plan badge;
//  - scripts/check-i18n-parity.ts's ICU check, run on fixture files in a temp directory.
//
```
After:
```ts
// Smoke test for the calendar home's copy (calendar-home spec §9, §7.8 and Ruling R9;
// Plan D, Task D1; the tabs and the Month, Plan E, Task E1).
//
// The calendarHome namespace in messages/{en,he,ru}.json holds every string the new home
// shows. Its key names are a contract: Tasks D2-D7 and E2-E8 use them verbatim. So this
// smoke lists them (KEYS, the tasks' Keys tables) and checks that the three files carry
// exactly those keys, each formatting through next-intl with exactly its arguments. It
// also pins:
//  - the plurals (Russian one/few/many, Hebrew one/two/other) and the weekday select;
//  - the 14 Hebrew month names in Task D2's order (from Tishrei), genitive in Russian (R9),
//    and their short forms for the Month's cells (hebrewMonthShort);
//  - no slash or bracket gender forms in the Hebrew or Russian copy;
//  - calendarHome as its own top-level object between dashboard and admin, away from the
//    bot.errors keys Plan C adds;
//  - spec §9's fixes on the old screens: the Header's aria-labels and admin badge (also
//    on Subscription and Select calendars), the dashboard loader's "Loading Dashboard...",
//    and the old home's "Free" plan badge;
//  - scripts/check-i18n-parity.ts's ICU check, run on fixture files in a temp directory,
//    with E1's three fixes: bot.* read as getBotMessage fills it, '' inside a quoted
//    literal, and =N forms standing in for a category that holds N alone.
//
```

The end of `KEYS`, and `ARRAY_KEYS` (`:182-186`):

Before:
```ts
  'empty.hintEvents': [],
  'empty.hintReminders': [],
};
/** Keys whose value is an array (read with t.raw). */
const ARRAY_KEYS = ['hebrewMonthGenitive'];
```
After:
```ts
  'empty.hintEvents': [],
  'empty.hintReminders': [],
  // The tab bar (E4), spec §7.1 and §7.7
  'tabs.label': [],
  'tabs.agenda': [],
  'tabs.month': [],
  // The Month (E6 browse, E7 picked), spec §7.4 and §7.7
  'month.today': [],
  'month.allMonths': [],
  'month.previous': [],
  'month.next': [],
  'month.dayToday': ['date'],
  'month.more': ['count'],
  'month.moreShort': ['count'],
  'month.cellItems': ['count'],
  'month.cellFromPartner': ['count', 'name'],
  'month.cellNothing': [],
  'month.cellLoading': [],
  'month.cellFailed': [],
  'month.failed': [],
};
/** Keys whose value is an array (read with t.raw). */
const ARRAY_KEYS = ['hebrewMonthGenitive', 'hebrewMonthShort'];
```

The three short lists, after `RU_GENITIVE` (`:209`):

Before:
```ts
const RU_GENITIVE = ['тишрея', 'хешвана', 'кислева', 'тевета', 'швата', 'адара', 'адара I', 'адара II', 'нисана', 'ияра', 'сивана', 'тамуза', 'ава', 'элула'];
```
After:
```ts
const RU_GENITIVE = ['тишрея', 'хешвана', 'кислева', 'тевета', 'швата', 'адара', 'адара I', 'адара II', 'нисана', 'ияра', 'сивана', 'тамуза', 'ава', 'элула'];
/**
 * calendarHome.hebrewMonthShort, the Month cell's month after the Hebrew day ("1 Chesh.",
 * "א׳ חשון", "1 хешв."), in HEBREW_MONTHS order. English and Russian cut the four long
 * names the approved mockup cuts (Tish., Chesh., Kis., Tev.) and keep the rest whole;
 * Russian is the genitive, to read after a number. Hebrew is the plain name, the one the
 * Agenda's day labels use.
 */
const EN_SHORT = ['Tish.', 'Chesh.', 'Kis.', 'Tev.', "Sh'vat", 'Adar', 'Adar I', 'Adar II', 'Nisan', 'Iyyar', 'Sivan', 'Tamuz', 'Av', 'Elul'];
const HE_SHORT = ['תשרי', 'חשון', 'כסלו', 'טבת', 'שבט', 'אדר', 'אדר א׳', 'אדר ב׳', 'ניסן', 'אייר', 'סיון', 'תמוז', 'אב', 'אלול'];
const RU_SHORT = ['тишр.', 'хешв.', 'кисл.', 'тев.', 'швата', 'адара', 'адара I', 'адара II', 'нисана', 'ияра', 'сивана', 'тамуза', 'ава', 'элула'];
```

#4's new cases, at the end of its list (`:406-407`):

Before:
```ts
      ['he', 'agenda.nothingPlannedRange', { range: 'שבת, 17 באוק׳' }, 'אין אירועים בשבת, 17 באוק׳'],
    ];
```
After:
```ts
      ['he', 'agenda.nothingPlannedRange', { range: 'שבת, 17 באוק׳' }, 'אין אירועים בשבת, 17 באוק׳'],
      // The Month (E1): a cell's label parts, its "+N" and the picked day's header
      ['en', 'month.cellItems', { count: 1 }, '1 item'],
      ['en', 'month.cellItems', { count: 3 }, '3 items'],
      ['he', 'month.cellItems', { count: 1 }, 'אירוע אחד'],
      ['he', 'month.cellItems', { count: 2 }, 'שני אירועים'],
      ['he', 'month.cellItems', { count: 3 }, '3 אירועים'],
      ['ru', 'month.cellItems', { count: 1 }, '1 событие'],
      ['ru', 'month.cellItems', { count: 3 }, '3 события'],
      ['ru', 'month.cellItems', { count: 5 }, '5 событий'],
      ['ru', 'month.cellItems', { count: 21 }, '21 событие'],
      ['en', 'month.cellFromPartner', { count: 1, name: 'Noa' }, '1 from Noa'],
      ['he', 'month.cellFromPartner', { count: 1, name: 'נועה' }, '1 של נועה'],
      ['ru', 'month.cellFromPartner', { count: 1, name: 'Маша' }, 'Маша: 1'],
      ['en', 'month.more', { count: 2 }, '+2 more'],
      ['he', 'month.more', { count: 2 }, 'עוד 2'],
      ['ru', 'month.more', { count: 2 }, 'Ещё 2'],
      ['en', 'month.moreShort', { count: 4 }, '+4'],
      ['he', 'month.moreShort', { count: 4 }, '+4'],
      ['ru', 'month.moreShort', { count: 4 }, '+4'],
      ['en', 'month.dayToday', { date: 'Thursday, 15 October' }, 'Today · Thursday, 15 October'],
      ['he', 'month.dayToday', { date: 'יום חמישי, 15 באוקטובר' }, 'היום · יום חמישי, 15 באוקטובר'],
      ['ru', 'month.dayToday', { date: 'четверг, 15 октября' }, 'Сегодня · четверг, 15 октября'],
    ];
```

The new checks #15–#18, after #14 (`:558-561`). Each fixture pairs a case the fix must accept with cases it must still refuse:

Before:
```ts
    assert(!/he: x\.n has arguments/.test(res.out), `an unparsable message was also compared: ${res.out.trim()}`);
  });

  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
```
After:
```ts
    assert(!/he: x\.n has arguments/.test(res.out), `an unparsable message was also compared: ${res.out.trim()}`);
  });

  await check('#15 hebrewMonthShort: 14 short names in each language in HEBREW_MONTHS order, read whole by t.raw; en and ru each the whole name or its start with a period, ru genitive, he hebcal\'s plain name', () => {
    const want: Record<Locale, readonly string[]> = { en: EN_SHORT, he: HE_SHORT, ru: RU_SHORT };
    const problems: string[] = [];
    const lists = {} as Record<Locale, unknown>;
    for (const locale of LOCALES) {
      const errors: string[] = [];
      lists[locale] = translator(locale, errors).raw('hebrewMonthShort');
      if (errors.length || show(lists[locale]) !== show(want[locale])) problems.push(`${locale}: ${show(lists[locale])} ${errors[0] ?? ''}`);
    }
    // "Chesh." cuts "Cheshvan", "хешв." cuts "хешвана"; a name short enough stays whole.
    const cutOf = (short: unknown, full: string) =>
      typeof short === 'string' && (short === full || (short.length > 1 && short.endsWith('.') && full.startsWith(short.slice(0, -1))));
    const fullNames: [Locale, readonly string[]][] = [['en', HEBREW_MONTHS], ['ru', RU_GENITIVE]];
    for (const [locale, full] of fullNames) {
      const list = lists[locale];
      if (!Array.isArray(list) || list.length !== 14) continue;
      list.forEach((short: unknown, i: number) => {
        if (!cutOf(short, full[i])) problems.push(`${locale}: ${show(short)} is neither ${full[i]} nor a cut of it`);
      });
    }
    // Hebrew: the name the Agenda's day labels use (D2's monthLabel), without nikud.
    const { Locale: HebcalLocale } = nodeRequire('@hebcal/hdate');
    const plain = HEBREW_MONTHS.map(name => HebcalLocale.lookupTranslation(name, 'he-x-NoNikud'));
    if (show(lists.he) !== show(plain)) problems.push(`he is not hebcal's plain names ${show(plain)}`);
    assert(problems.length === 0, problems.join('; '));
  });

  await check('#16 check-i18n-parity reads bot.* the way getBotMessage fills it: each {word} is an argument, with no ICU quoting or syntax; elsewhere ICU stands', () => {
    // getBotMessage fills both {word} and {name} in "Reply '{word}' to {name}"; ICU would
    // quote {word} away. "{a, b}" isn't ICU, but getBotMessage just leaves it as it is.
    const bot = runParity(fixture({
      en: { bot: { q: "Reply '{word}' to {name}", j: 'Send {name} a list like {a, b}' } },
      he: { bot: { q: 'אפשר לענות {word} ל{name}', j: 'אפשר לשלוח ל{name} רשימה כמו {a, b}' } },
      ru: { bot: { q: 'Ответьте {word}, {name}', j: 'Отправьте {name} список вроде {a, b}' } },
    }));
    assert(bot.code === 0 && bot.out.includes('i18n parity OK (2 keys)'), `bot.*: exit ${bot.code}: ${bot.out.trim().slice(-300)}`);
    // A bot argument renamed in one language is still caught, and outside bot.* the quote holds.
    const res = runParity(fixture({
      en: { bot: { s: 'Hi {name}' }, x: { q: "Reply '{word}' to {name}" } },
      he: { bot: { s: 'היי {name}' }, x: { q: 'אפשר לענות {word} ל{name}' } },
      ru: { bot: { s: 'Привет, {nmae}' }, x: { q: 'Ответьте {word}, {name}' } },
    }));
    assert(res.code === 1, `exit ${res.code}: ${res.out.trim().slice(-300)}`);
    for (const line of ['ru: bot.s has arguments [nmae], en has [name]', 'he: x.q has arguments [name word], en has [name]']) {
      assert(res.out.includes(line), `no "${line}" in: ${res.out.trim().slice(-300)}`);
    }
  });

  await check("#17 check-i18n-parity reads '' inside a quoted literal as one apostrophe that leaves the quote open, as next-intl does", () => {
    const quoted = "Say '{it''s}' to {name}";
    const inForm = "{count, plural, one {# note: '{it''s}'} other {# notes: '{it''s}'}}";
    const errors: string[] = [];
    const { createTranslator } = nodeRequire('next-intl');
    const t = createTranslator({ locale: 'en', messages: { q: quoted, p: inForm }, onError: (err: Error) => errors.push(err.message) });
    const shown = [t('q', { name: 'Noa' }), t('p', { count: 2 })];
    assert(!errors.length && show(shown) === show(["Say {it's} to Noa", "2 notes: {it's}"]), `next-intl: ${show(shown)} ${errors[0] ?? ''}`);
    const good = runParity(fixture({
      en: { x: { q: quoted, p: inForm } },
      he: { x: { q: 'אפשר להגיד ל{name}', p: GOOD_PLURALS.he } },
      ru: { x: { q: 'Скажите {name}', p: GOOD_PLURALS.ru } },
    }));
    assert(good.code === 0 && good.out.includes('i18n parity OK (2 keys)'), `fixture: exit ${good.code}: ${good.out.trim().slice(-300)}`);
    // A quote that never closes still fails, '' or not.
    const open = runParity(fixture({
      en: { x: { q: "Say '{it''s} to {name}" } },
      he: { x: { q: 'אפשר להגיד ל{name}' } },
      ru: { x: { q: 'Скажите {name}' } },
    }));
    assert(open.code === 1 && open.out.includes('en: x.q is not valid ICU: a quote that never closes'), `unclosed: exit ${open.code}: ${open.out.trim().slice(-300)}`);
  });

  await check('#18 check-i18n-parity lets an =N form stand in for a category that holds N alone (=1 for en and he one, =2 for he two), never for ru one', () => {
    const good = runParity(fixture({
      en: { x: { n: '{count, plural, =1 {One item} other {# items}}', d: '{count, plural, =1 {Tomorrow} other {In # days}}' } },
      he: { x: { n: '{count, plural, =1 {פריט אחד} =2 {שני פריטים} other {# פריטים}}', d: '{count, plural, =1 {מחר} =2 {מחרתיים} other {בעוד # ימים}}' } },
      ru: { x: {
        n: '{count, plural, =1 {Один пункт} one {# пункт} few {# пункта} many {# пунктов} other {# пункта}}',
        d: '{count, plural, =1 {Завтра} one {Через # день} few {Через # дня} many {Через # дней} other {Через # дня}}',
      } },
    }));
    assert(good.code === 0 && good.out.includes('i18n parity OK (2 keys)'), `fixture: exit ${good.code}: ${good.out.trim().slice(-300)}`);
    // =2 is not en one; =1 alone leaves he two; ru one also holds 21, 31, …
    const res = runParity(fixture({
      en: { x: { n: '{count, plural, =2 {Two items} other {# items}}' } },
      he: { x: { n: '{count, plural, =1 {פריט אחד} other {# פריטים}}' } },
      ru: { x: { n: '{count, plural, =1 {Один пункт} few {# пункта} many {# пунктов} other {# пункта}}' } },
    }));
    assert(res.code === 1, `exit ${res.code}: ${res.out.trim().slice(-300)}`);
    for (const line of ['en: x.n {count, plural} lacks the "one" form', 'he: x.n {count, plural} lacks the "two" form', 'ru: x.n {count, plural} lacks the "one" form']) {
      assert(res.out.includes(line), `no "${line}" in: ${res.out.trim().slice(-300)}`);
    }
    assert(!res.out.includes('he: x.n {count, plural} lacks the "one" form'), `=1 did not stand in for he one: ${res.out.trim()}`);
  });

  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
```

- [ ] **Step 2: Run it and see it fail**

```bash
for tz in UTC Asia/Jerusalem; do
  eval "env TZ=$tz $E npx tsx scripts/smoke-calendar-home-copy.ts"; echo "smoke-calendar-home-copy TZ=$tz exit $?"
done
```
Expected, in both timezones: `11/18 passed`, then `exit 1`. #1 and #5–#14 pass. The failures, first lines:
```
FAIL  #2 each language holds exactly the Keys table under calendarHome: none missing, none extra — en lacks 17: hebrewMonthShort, month.allMonths, month.cellFailed, month.cellFromPartner, month.cellItems, month.cellLoading, …; he lacks 17: …; ru lacks 17: …
FAIL  #3 every key formats through next-intl in each language with exactly its arguments: no error, nothing left unfilled, each argument shown — en tabs.label: MISSING_MESSAGE: calendarHome.tabs.label (en); …
FAIL  #4 plurals, the weekday select and the person chips read naturally (exact text in en/he/ru) — en month.cellItems {"count":1}: "[missing month.cellItems]" (MISSING_MESSAGE: calendarHome.month.cellItems (en)), want "1 item"; …
FAIL  #15 hebrewMonthShort: … — en: "[missing hebrewMonthShort]" MISSING_MESSAGE: calendarHome.hebrewMonthShort (en); …
FAIL  #16 check-i18n-parity reads bot.* the way getBotMessage fills it: … — bot.*: exit 1: …
```
The parity output inside #16–#18 shows the old checker's three faults:
- #16: `he: bot.j is not valid ICU: {a, b}: not an ICU argument type (at character 34)` and `he: bot.q has arguments [name word], en has [name]` (and the same for ru, and for en's `bot.j`);
- #17: `en: x.p is not valid ICU: the "'" form of {count} has no message (at character 38)` and `en: x.q is not valid ICU: a "}" with no "{" (at character 11)`;
- #18: `en: x.n {count, plural} lacks the "one" form`, `he: x.n {count, plural} lacks the "one" form`, `he: x.n {count, plural} lacks the "two" form`, and the same three for `x.d`.

tsx may print `DEP0205` deprecation warnings on stderr; ignore them.

- [ ] **Step 3: Record the regression smokes' baseline**

```bash
L=$(mktemp -d)
for tz in UTC Asia/Jerusalem; do
  for s in check-i18n-parity smoke-calendar-home-render smoke-hebrew-date smoke-miniapp-gate smoke-page-auth smoke-admin-panel-ssr smoke-calendar-home-rollout smoke-native-reminder-support smoke-native-reminder-buttons smoke-native-reminders smoke-native-reminder-create-flow smoke-native-reminder-creation smoke-native-reminder-edit smoke-native-reminder-typed smoke-google-connect smoke-oauth-weather smoke-account-merge smoke-digest-reader-parity smoke-summary-prompt-parity smoke-summary-retry smoke-summary-seam smoke-week-commands; do
    eval "env TZ=$tz $E npx tsx scripts/$s.ts" > "$L/$s.log" 2>&1; echo "$s TZ=$tz exit $? $(grep -E 'passed|parity' "$L/$s.log" | tail -1)"
  done
done
```
Expected, every one `exit 0`, in both timezones: `i18n parity OK (996 keys)`; `smoke-calendar-home-render` 41/41; `smoke-hebrew-date` 14/14; `smoke-miniapp-gate` 20/20; `smoke-page-auth` 14/14; `smoke-admin-panel-ssr` 10/10; `smoke-calendar-home-rollout` 35/35; `smoke-native-reminder-support` 32/32; `smoke-native-reminder-buttons` 36/36; `smoke-native-reminders` 45/45; `smoke-native-reminder-create-flow` 56/56; `smoke-native-reminder-creation` 30/30; `smoke-native-reminder-edit` 18/18; `smoke-native-reminder-typed` 24/24; `smoke-google-connect` 30/30; `smoke-oauth-weather` 14/14; `smoke-account-merge` 50/50; `smoke-digest-reader-parity` 28/28; `smoke-summary-prompt-parity` 9/9; `smoke-summary-retry` 20/20; `smoke-summary-seam` 23/23; `smoke-week-commands` 7/7. These are the smokes that read `messages/*.json` (the last five read the `bot` texts).

- [ ] **Step 4: Fix `scripts/check-i18n-parity.ts`**

Four edits, each Before block matching once. The header comment (`:7-14`):

Before:
```ts
// The arguments are ICU's: {name}, and {count, plural, …} or {x, select, …} together with
// the arguments inside their forms. Only the names must match: a count can be a plain
// {count} in one language and a plural in another. Each message must also be one ICU can
// parse (next-intl formats every web message with it), every select needs an `other`
// form, and every plural gives exactly the forms its language uses (Intl.PluralRules:
// en one/other, he one/two/other, ru one/few/many/other; `=N` forms are extra). A Russian
// plural with no `few` form would print "2 напоминаний".
//
```
After:
```ts
// The arguments are ICU's: {name}, and {count, plural, …} or {x, select, …} together with
// the arguments inside their forms. Only the names must match: a count can be a plain
// {count} in one language and a plural in another. Each message must also be one ICU can
// parse (next-intl formats every web message with it), every select needs an `other`
// form, and every plural gives exactly the forms its language uses (Intl.PluralRules:
// en one/other, he one/two/other, ru one/few/many/other). A Russian plural with no `few`
// form would print "2 напоминаний". An `=N` form is extra, and it stands in for a form
// whose category holds N alone among whole counts: =1 for en and he `one`, =2 for he
// `two`. Nothing stands in for ru `one`, which also holds 21, 31, …
//
// The bot's strings (bot.*) are read the way getBotMessage fills them
// (src/lib/bot-messages.ts): every {word} is an argument and nothing else is special, so
// there is no ICU quoting, plural or select there. getBotMessage fills {word} in
// "Reply '{word}'", which ICU would quote away.
//
```

The quote's end (`:51-65`). `quoteEnd()` skips each `''` pair inside the quote, and `fail` still reports the opening quote's position:

Before:
```ts
  // Literal text up to the "}" that closes the enclosing form, or to the end at the top.
  // ICU's quoting: '' is one apostrophe; an apostrophe before { or } (or # in a plural)
  // quotes up to the next apostrophe; any other apostrophe is plain text ("don't").
  const text = (inForm: boolean, inPlural: boolean): void => {
    while (i < message.length) {
      const c = message[i];
      if (c === "'") {
        const next = message[i + 1];
        if (next === "'") {
          i += 2;
        } else if (next === '{' || next === '}' || (inPlural && next === '#')) {
          const close = message.indexOf("'", i + 1);
          if (close < 0) fail('a quote that never closes');
          i = close + 1;
        } else {
```
After:
```ts
  // Just past the quote that opens at i ("'{…'"): its end is the next apostrophe that isn't
  // one of a pair, because '' inside a quote is one apostrophe too ("'{it''s}'" is {it's}).
  const quoteEnd = (): number => {
    let at = i + 2;
    for (;;) {
      const close = message.indexOf("'", at);
      if (close < 0) return fail('a quote that never closes');
      if (message[close + 1] !== "'") return close + 1;
      at = close + 2;
    }
  };

  // Literal text up to the "}" that closes the enclosing form, or to the end at the top.
  // ICU's quoting: '' is one apostrophe; an apostrophe before { or } (or # in a plural)
  // quotes up to the next lone apostrophe (see quoteEnd); any other apostrophe is plain
  // text ("don't").
  const text = (inForm: boolean, inPlural: boolean): void => {
    while (i < message.length) {
      const c = message[i];
      if (c === "'") {
        const next = message[i + 1];
        if (next === "'") {
          i += 2;
        } else if (next === '{' || next === '}' || (inPlural && next === '#')) {
          i = quoteEnd();
        } else {
```

The bot rule and the `=N` stand-ins (`:130-147`). `loneCounts` sweeps the whole counts once per language and plural type:

Before:
```ts
  text(false, false);
  return found;
}

/** What a locale's plural and select forms get wrong in one message. */
function formProblems(locale: Locale, key: string, args: IcuArgument[]): string[] {
  const problems: string[] = [];
  for (const arg of args) {
    if (arg.type === 'select' && !arg.forms.includes('other')) {
      problems.push(`${locale}: ${key} {${arg.name}, select} has no "other" form`);
    }
    if (arg.type && PLURAL_TYPES.has(arg.type)) {
      const rules = new Intl.PluralRules(locale, { type: arg.type === 'plural' ? 'cardinal' : 'ordinal' });
      const uses: string[] = [...rules.resolvedOptions().pluralCategories];
      const named = arg.forms.filter(form => !/^=\d+$/.test(form));
      for (const form of uses) {
        if (!named.includes(form)) problems.push(`${locale}: ${key} {${arg.name}, ${arg.type}} lacks the "${form}" form`);
      }
```
After:
```ts
  text(false, false);
  return found;
}

/** getBotMessage's rule (src/lib/bot-messages.ts): it fills every {word} and nothing else. */
function botArguments(message: string): IcuArgument[] {
  return [...message.matchAll(/\{(\w+)\}/g)].map(match => ({ name: match[1], type: null, forms: [] }));
}

/** The keys getBotMessage reads: getBotMessages returns the bot subtree. */
const isBotKey = (key: string): boolean => key.startsWith('bot.');

/** Whole counts 0–1000: enough for en, he and ru, whose rules look at n % 10 and n % 100. */
const WHOLE_COUNTS = 1000;
const loneCountCache = new Map<string, Map<string, number>>();

/**
 * The categories that hold one whole count alone, each with that count: en one → 1;
 * he one → 1, two → 2; none in ru, whose `one` also holds 21, 31, … Only whole counts:
 * a fraction can fall in one too (he 0.5), and these messages count whole things.
 */
function loneCounts(locale: Locale, type: 'cardinal' | 'ordinal'): Map<string, number> {
  const cacheKey = `${locale} ${type}`;
  const cached = loneCountCache.get(cacheKey);
  if (cached) return cached;
  const rules = new Intl.PluralRules(locale, { type });
  const first = new Map<string, number | null>(); // its one count, or null once it holds two
  for (let n = 0; n <= WHOLE_COUNTS; n++) {
    const category = rules.select(n);
    first.set(category, first.has(category) ? null : n);
  }
  const lone = new Map<string, number>();
  for (const [category, n] of first) if (n !== null) lone.set(category, n);
  loneCountCache.set(cacheKey, lone);
  return lone;
}

/** What a locale's plural and select forms get wrong in one message. */
function formProblems(locale: Locale, key: string, args: IcuArgument[]): string[] {
  const problems: string[] = [];
  for (const arg of args) {
    if (arg.type === 'select' && !arg.forms.includes('other')) {
      problems.push(`${locale}: ${key} {${arg.name}, select} has no "other" form`);
    }
    if (arg.type && PLURAL_TYPES.has(arg.type)) {
      const type = arg.type === 'plural' ? 'cardinal' : 'ordinal';
      const rules = new Intl.PluralRules(locale, { type });
      const uses: string[] = [...rules.resolvedOptions().pluralCategories];
      const named = arg.forms.filter(form => !/^=\d+$/.test(form));
      const exact = new Set(arg.forms.filter(form => /^=\d+$/.test(form)).map(form => Number(form.slice(1))));
      const lone = loneCounts(locale, type);
      for (const form of uses) {
        const standIn = lone.get(form);
        if (named.includes(form) || (standIn !== undefined && exact.has(standIn))) continue;
        problems.push(`${locale}: ${key} {${arg.name}, ${arg.type}} lacks the "${form}" form`);
      }
```

The parse call in the main loop (`:194-195`). A `bot.*` string is never "not valid ICU", and the form checks find nothing in it:

Before:
```ts
    try {
      const args = icuArguments(value);
```
After:
```ts
    try {
      const args = isBotKey(key) ? botArguments(value) : icuArguments(value);
```

- [ ] **Step 5: Add the tabs, the Month and the short month names to `messages/en.json`**

Two edits. The `tabs` and `month` objects go after `agenda` (`:155-161`):

Before:
```json
      "showNextWeek": "Show next week"
    },
    "stillOpen": {
```
After:
```json
      "showNextWeek": "Show next week"
    },
    "tabs": {
      "label": "Calendar view",
      "agenda": "Agenda",
      "month": "Month"
    },
    "month": {
      "today": "Today",
      "allMonths": "All months",
      "previous": "Previous month",
      "next": "Next month",
      "dayToday": "Today · {date}",
      "more": "+{count} more",
      "moreShort": "+{count}",
      "cellItems": "{count, plural, one {# item} other {# items}}",
      "cellFromPartner": "{count} from {name}",
      "cellNothing": "nothing planned",
      "cellLoading": "loading",
      "cellFailed": "couldn’t load",
      "failed": "Couldn’t load this month"
    },
    "stillOpen": {
```

`hebrewMonthShort` after `hebrewMonthGenitive` (`:210`). The apostrophes in "couldn’t" are U+2019, like the rest of D's English, so ICU never sees an apostrophe there:

Before:
```json
    "hebrewMonthGenitive": ["Tishrei", "Cheshvan", "Kislev", "Tevet", "Sh'vat", "Adar", "Adar I", "Adar II", "Nisan", "Iyyar", "Sivan", "Tamuz", "Av", "Elul"]
  },
```
After:
```json
    "hebrewMonthGenitive": ["Tishrei", "Cheshvan", "Kislev", "Tevet", "Sh'vat", "Adar", "Adar I", "Adar II", "Nisan", "Iyyar", "Sivan", "Tamuz", "Av", "Elul"],
    "hebrewMonthShort": ["Tish.", "Chesh.", "Kis.", "Tev.", "Sh'vat", "Adar", "Adar I", "Adar II", "Nisan", "Iyyar", "Sivan", "Tamuz", "Av", "Elul"]
  },
```

- [ ] **Step 6: Add the same keys to `messages/he.json`**

Two edits, at the same lines as in English. After `agenda`:

Before:
```json
      "showNextWeek": "להציג את השבוע הבא"
    },
    "stillOpen": {
```
After:
```json
      "showNextWeek": "להציג את השבוע הבא"
    },
    "tabs": {
      "label": "תצוגת היומן",
      "agenda": "סדר יום",
      "month": "חודש"
    },
    "month": {
      "today": "היום",
      "allMonths": "כל החודשים",
      "previous": "החודש הקודם",
      "next": "החודש הבא",
      "dayToday": "היום · {date}",
      "more": "עוד {count}",
      "moreShort": "+{count}",
      "cellItems": "{count, plural, one {אירוע אחד} two {שני אירועים} other {# אירועים}}",
      "cellFromPartner": "{count} של {name}",
      "cellNothing": "אין אירועים",
      "cellLoading": "בטעינה",
      "cellFailed": "לא נטען",
      "failed": "לא הצלחנו לטעון את החודש הזה"
    },
    "stillOpen": {
```

After `hebrewMonthGenitive`:

Before:
```json
    "hebrewMonthGenitive": ["תשרי", "חשון", "כסלו", "טבת", "שבט", "אדר", "אדר א׳", "אדר ב׳", "ניסן", "אייר", "סיון", "תמוז", "אב", "אלול"]
  },
```
After:
```json
    "hebrewMonthGenitive": ["תשרי", "חשון", "כסלו", "טבת", "שבט", "אדר", "אדר א׳", "אדר ב׳", "ניסן", "אייר", "סיון", "תמוז", "אב", "אלול"],
    "hebrewMonthShort": ["תשרי", "חשון", "כסלו", "טבת", "שבט", "אדר", "אדר א׳", "אדר ב׳", "ניסן", "אייר", "סיון", "תמוז", "אב", "אלול"]
  },
```

- [ ] **Step 7: Add the same keys to `messages/ru.json`**

Two edits, at the same lines. After `agenda`:

Before:
```json
      "showNextWeek": "Показать следующую неделю"
    },
    "stillOpen": {
```
After:
```json
      "showNextWeek": "Показать следующую неделю"
    },
    "tabs": {
      "label": "Вид календаря",
      "agenda": "Расписание",
      "month": "Месяц"
    },
    "month": {
      "today": "Сегодня",
      "allMonths": "Все месяцы",
      "previous": "Предыдущий месяц",
      "next": "Следующий месяц",
      "dayToday": "Сегодня · {date}",
      "more": "Ещё {count}",
      "moreShort": "+{count}",
      "cellItems": "{count, plural, one {# событие} few {# события} many {# событий} other {# события}}",
      "cellFromPartner": "{name}: {count}",
      "cellNothing": "ничего не запланировано",
      "cellLoading": "загружается",
      "cellFailed": "не удалось загрузить",
      "failed": "Не удалось загрузить этот месяц"
    },
    "stillOpen": {
```

After `hebrewMonthGenitive`:

Before:
```json
    "hebrewMonthGenitive": ["тишрея", "хешвана", "кислева", "тевета", "швата", "адара", "адара I", "адара II", "нисана", "ияра", "сивана", "тамуза", "ава", "элула"]
  },
```
After:
```json
    "hebrewMonthGenitive": ["тишрея", "хешвана", "кислева", "тевета", "швата", "адара", "адара I", "адара II", "нисана", "ияра", "сивана", "тамуза", "ава", "элула"],
    "hebrewMonthShort": ["тишр.", "хешв.", "кисл.", "тев.", "швата", "адара", "адара I", "адара II", "нисана", "ияра", "сивана", "тамуза", "ава", "элула"]
  },
```

- [ ] **Step 8: Run the smoke and the parity check under both clocks and see them pass**

```bash
for tz in UTC Asia/Jerusalem; do
  eval "env TZ=$tz $E npx tsx scripts/smoke-calendar-home-copy.ts"; echo "smoke-calendar-home-copy TZ=$tz exit $?"
  eval "env TZ=$tz $E npx tsx scripts/check-i18n-parity.ts"; echo "check-i18n-parity TZ=$tz exit $?"
done
```
Expected, in both timezones: 18 `OK` lines, `18/18 passed`, `exit 0`; then `i18n parity OK (1013 keys)`, `exit 0`.

- [ ] **Step 9: Run the regression smokes again**

Run Step 3's loop. Expected: the same counts, every one `exit 0`, except that `check-i18n-parity` now prints `i18n parity OK (1013 keys)`.

- [ ] **Step 10: Type-check and lint**

```bash
npx tsc --noEmit -p .; echo "tsc exit $?"
npm run -s lint; echo "lint exit $?"
```
Expected: no output from either, then `tsc exit 0` and `lint exit 0`.

- [ ] **Step 11: Commit**

```bash
git add messages/en.json messages/he.json messages/ru.json scripts/check-i18n-parity.ts scripts/smoke-calendar-home-copy.ts
git commit -m "$(cat <<'EOF'
feat(calendar-home): the tab bar's and the Month's copy, and three parity fixes

calendarHome gains the tab bar's labels (Agenda / Month; he "סדר יום" /
"חודש", ru "Расписание" / "Месяц") and the Month's words: Today, All months,
the chevrons, the picked day's "Today · …", "+N more" and "+N", a cell's
label parts (items as an ICU plural, how many are the partner's, and the
nothing / loading / couldn't-load states) and the failed-month notice. Also
hebrewMonthShort, the 14 Hebrew month names for the cells: en and ru cut the
four long names as the mockup does, ru in the genitive to read after a
number, he the plain names. Natural and gender-neutral in each language.
Nothing reads them yet.

check-i18n-parity now reads bot.* the way getBotMessage fills it (each
{word}, no ICU quoting), reads '' inside a quoted literal as one apostrophe
that leaves the quote open, and lets an =N plural form stand in for a
category that holds N alone (=1 for en and he one, =2 for he two, never for
ru one). smoke-calendar-home-copy pins the new keys and each fix.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
EOF
)"
```

---

### Task 2 (E2): Grid and month headers (spec §7.4, §5's month windows, §7.8's Month cells and month headers; Rulings R9, R12; Plan E Rulings 3 and 8)

> **INTERFACE ADDITION VERSUS THE SPLIT (read this first; E6 and E7 use it). Nothing the split names is renamed, removed or changed, and every signature is the split's.**
> 1. **New export in `hebrew-date.ts`: `hebrewCellMonth(dayKey: DayKey, lang: string, shortMonths?: readonly string[]): string`**, the short month name alone: "Chesh." / "חשון" / "хешв.". It has `hebrewCellLabel`'s fallback ("Cheshvan" / "חשון" / "Хешван") and gives '' for a bad key. *Why:* Plan E Ruling 3 puts the Hebrew day number at the end of the browse cell's head line and the month name alone on its second line, because "1 Chesh." doesn't fit beside the day at 11 px. The split's `hebrewCellLabel(day, lang, true, list)` gives "1 Chesh.", the number and the month together. That suits picked, but browse needs the name without the number. For every day, `hebrewCellLabel(day, lang, true, list)` equals `` `${hebrewCellLabel(day, lang, false, list)} ${hebrewCellMonth(day, lang, list)}` ``, and the smoke checks it.
> 2. **Left open by the split and decided here:**
>    - nothing throws: a malformed key gives `''`, `[]`, `{ from: '', to: '' }` or `false`;
>    - a week start that isn't an integer 0–6 reads 0 (Sunday) in `grid`, `monthGrid` and `weekdayOrder`, so rows never misalign;
>    - `addMonths` with a fractional `n` gives `''`;
>    - `formatWeekdayHeader` gives `''` outside 0–6.

**What and why:** the Month (E5–E8) needs the calendar arithmetic of its window, the week rows of each month, its titles and weekday row, and the Hebrew months on its headers and cells. This task adds them as pure functions, with no React and no fetch:
- **`src/lib/calendar-view/grid.ts`** (new):
  - the window is 12 months back to 18 ahead of today's month, 31 months, oldest first (spec §7.4);
  - each month is drawn as rows of 7 days from the user's week start. The first row is the week holding the 1st and the last row the week holding the last day, so a month has 4, 5 or 6 rows;
  - each month fetches its own days, `[1st, 1st of next month)` (R12).

  A day key is a calendar day, so everything is UTC arithmetic on UTC noon, as `store.ts`'s `addDaysToKey` already does, and the device's clock can never move a day. No Intl, no @hebcal, no timezone.
- **`format.ts`:**
  - the month title: "October 2026" / "אוקטובר 2026" / "Октябрь 2026", with Russian in the standalone nominative, capitalised, without "г.";
  - the weekday row: one letter in English and Hebrew, two in Russian (Ruling 8).
- **`hebrew-date.ts`:**
  - the month header, the first and last Hebrew months a month touches, with the year on both sides only when it differs: "Elul 5786 – Tishrei 5787", "Tishrei – Cheshvan 5787", "Cheshvan 5788". Hebrew uses gematriya, Russian the nominative (R9);
  - whether a day is Hebrew day 1;
  - the cell's Hebrew day ("16" / "ט״ז"), with or without the short month name from `calendarHome.hebrewMonthShort` (E1).

Nothing renders these yet: E6 and E7 do. No user sees a change, and the switch is unchanged.

**Files:**
- Prerequisite: the base 0064e8f (Plans A–D). This task is in wave 1, so no earlier E task is applied first. Its smoke's check 18 reads E1's `calendarHome.hebrewMonthShort`. Integration applies E1 first, and without E1 only that check fails, with "(Task E1 adds it)".
- Create: `src/lib/calendar-view/grid.ts`
- Modify: `src/lib/calendar-view/format.ts:1-2` (header), `:11-12` (a header bullet), `:16-17` (imports), `:180-183` (`allDayLastDay`; the new code goes after it, at the end of the file)
- Modify: `src/lib/calendar-view/hebrew-date.ts:1-2` (header), `:12-13` (imports), `:57` (`isGenitiveList` becomes `isMonthList`), `:77` (its one call), `:83-86` (`dayLabel`), `:103-108` (`hebrewFullDate`'s body; the new exports go after it, at the end of the file)
- Create (test): `scripts/smoke-calendar-grid.ts`
- Modify (test): `scripts/smoke-hebrew-date.ts:1-9` (header), `:26` (import), `:57-58` (the end of `RU_GENITIVE`), `:209` (the new checks go before D1's messages check), `:266-269` (the import scan allows `./grid`)
- Test: `scripts/smoke-calendar-grid.ts` and `scripts/smoke-hebrew-date.ts` under `TZ=UTC`, `Asia/Jerusalem`, `Pacific/Kiritimati` and `America/Santiago`. Both also switch the clock inside the process to Los Angeles and Santiago.
- Regression (unchanged):
  - `scripts/smoke-calendar-home-render.ts`, under `TZ=UTC` and `Asia/Jerusalem`. It renders DayList, ItemRow, ItemSheet, StillOpenCard and HomeHeader, which import `format.ts` and `hebrew-date.ts`, and its import rule walks what they load.
  - `scripts/check-i18n-parity.ts`.

**Interfaces:**
- Consumes:
  - from B3, `src/lib/calendar-view/types.ts`: `DayKey` ('yyyy-MM-dd') and `WeekStart` (`0|1|2|3|4|5|6`, 0 = Sunday);
  - D2's internals in `hebrew-date.ts`: `hebrewDateOf`, `langOf`, `monthLabel` and `HEBREW_MONTHS`, plus `HDate`, `Locale` and `gematriya` from `@hebcal/hdate` 0.21.1;
  - D5's internals in `format.ts`: `keyDate`, `formatter`, `intlLocale` and `INTL_LOCALES`;
  - from E1, in the smoke only: `calendarHome.hebrewMonthShort` in `messages/{en,he,ru}.json`, 14 strings in `HEBREW_MONTHS` order. The modules never read messages. Callers pass the list.
- Produces:
  - `src/lib/calendar-view/grid.ts` (pure; it imports only `type { DayKey, WeekStart } from './types'`):
    - `export type MonthKey = string;` ('yyyy-MM')
    - `export const MONTHS_BACK = 12;` and `export const MONTHS_AHEAD = 18;`
    - `export function grid(firstKey: DayKey, lastKey: DayKey, weekStart: WeekStart): DayKey[][]`: `lastKey` inclusive. The rows run from the week holding `firstKey` to the week holding `lastKey`, each 7 consecutive keys from `weekStart`. `[]` for a bad key or `lastKey < firstKey`.
    - `export function monthOf(day: DayKey): MonthKey`: '2026-10-15' → '2026-10'
    - `export function addMonths(month: MonthKey, n: number): MonthKey`: '2026-12' + 1 → '2027-01'
    - `export function monthFirstDay(month: MonthKey): DayKey`: '2026-10' → '2026-10-01'
    - `export function monthLastDay(month: MonthKey): DayKey`: '2028-02' → '2028-02-29'
    - `export function monthWindow(month: MonthKey): { from: DayKey; to: DayKey }`: `[1st, 1st of next month)`, so '2026-12' → `{ from: '2026-12-01', to: '2027-01-01' }`
    - `export function monthGrid(month: MonthKey, weekStart: WeekStart): DayKey[][]`: `grid(monthFirstDay(month), monthLastDay(month), weekStart)`
    - `export function monthSpan(today: DayKey): MonthKey[]`: 31 months, oldest first. `monthSpan('2026-10-15')` is '2025-10' … '2028-04', with today's month at index `MONTHS_BACK`.
    - `export function weekdayOrder(weekStart: WeekStart): WeekStart[]`: `[ws, ws + 1, …]` mod 7
  - `src/lib/calendar-view/format.ts`:
    - `export function formatMonthTitle(month: MonthKey, locale: string, withYear: boolean): string`: "October 2026" / "אוקטובר 2026" / "Октябрь 2026"; without the year, "October" / "אוקטובר" / "Октябрь". `''` for a bad month.
    - `export function formatWeekdayHeader(weekday: WeekStart, locale: string): string`: en "S M T W T F S", he "א׳ ב׳ ג׳ ד׳ ה׳ ו׳ ש׳", ru "Вс Пн Вт Ср Чт Пт Сб" (weekday 0–6)
  - `src/lib/calendar-view/hebrew-date.ts` (still `@hebcal/hdate` and `@hebcal/locales/ru` only, plus `./grid`):
    - `export function hebrewMonthRange(firstKey: DayKey, lastKey: DayKey, lang: string): string`: "Elul 5786 – Tishrei 5787", "Tishrei – Cheshvan 5787", "Cheshvan 5788"; he "אלול תשפ״ו – תשרי תשפ״ז"; ru "Тишрей – Хешван 5787". `''` for a bad key or a backwards run.
    - `export function hebrewMonthHeader(month: MonthKey, lang: string): string`: `hebrewMonthRange(monthFirstDay(month), monthLastDay(month), lang)`
    - `export function isHebrewMonthStart(dayKey: DayKey): boolean`: Hebrew day 1
    - `export function hebrewCellLabel(dayKey: DayKey, lang: string, withMonth: boolean, shortMonths?: readonly string[]): string`: "16" / "ט״ז" / "16", or with the month "1 Chesh." / "א׳ חשון" / "1 хешв."
    - **(addition)** `export function hebrewCellMonth(dayKey: DayKey, lang: string, shortMonths?: readonly string[]): string`: "Chesh." / "חשון" / "хешв."
  - How E5–E7 call them, in client components with `const t = useTranslations('calendarHome')` and `const locale = useLocale()`:
    ```
    const short = t.raw('hebrewMonthShort') as string[];          // E1; D's pattern for hebrewMonthGenitive
    monthGrid(month, weekStart);                                 // E5's weeks; rows.length for monthBlockPx
    monthSpan(today);                                            // the window; canStep's ends
    monthWindow(month);                                          // E5's wantedMonths, E8's retryWindow
    formatMonthTitle(month, locale, month.slice(0, 4) !== today.slice(0, 4));   // a month's h2 (Ruling 8)
    formatMonthTitle(month, locale, true);                       // the sticky bar and picked's title
    weekdayOrder(weekStart).map(d => formatWeekdayHeader(d, locale));          // the weekday row
    hebrewMonthHeader(month, locale);                            // only when hebrewDates
    // E6, a browse cell (Ruling 3), only when hebrewDates:
    hebrewCellLabel(cell.day, locale, false);                    // the head line's end: "16" / "ט״ז"
    cell.hebrewMonthStart ? hebrewCellMonth(cell.day, locale, short) : '';   // the second line
    // E7, a picked cell:
    hebrewCellLabel(cell.day, locale, cell.hebrewMonthStart, short);         // "16", or "1 Chesh."
    ```
    E5 sets `MonthCell.hebrewMonthStart` to `isHebrewMonthStart(day)` or the month's first in-month cell. Pass the server's `today` and the store's day keys, never a `new Date()`. An empty string means "render nothing".

**Findings that shaped the code:**
- **No date-fns in grid.ts.** The brief allows UTC arithmetic or local-noon Dates, and its "date-fns only" rules out any other library. date-fns's helpers read the device's local calendar, so they would need local-noon Dates to give the same keys. UTC noon plus whole days is the rule `store.ts`'s `addDaysToKey` and `format.ts`'s `keyDate` already use, so grid.ts imports nothing but the DTO types. The smoke's purity check would still accept a later `date-fns` import, but not `date-fns-tz`, Intl, @hebcal, a local-time getter or a clock.
- **Hebrew month facts** (measured with `@hebcal/hdate` 0.21.1, the dates of each Gregorian month's first and last days):

  | Month | First day | Last day | Note |
  |---|---|---|---|
  | 2026-09 | 19 Elul 5786 | 19 Tishrei 5787 | |
  | 2026-10 | 20 Tishrei 5787 | 20 Cheshvan 5787 | |
  | 2030-07 | 30 Sivan 5790 | 1 Av 5790 | all of Tamuz in between |
  | 2027-11 | 1 Cheshvan 5788 | 30 Cheshvan 5788 | 5788 is a complete year, so its Cheshvan has 30 days |
  | 2025-02 | 3 Sh'vat 5785 | 30 Sh'vat 5785 | |
  | 2027-02 | 24 Sh'vat 5787 | 21 Adar I 5787 | |
  | 2027-03 | 22 Adar I 5787 | 22 Adar II 5787 | |

  From 2025 to 2030, only July 2030 touches three Hebrew months. The sweep asserts that at least one month does.
- **Names:**
  - `monthLabel(hd, lang, undefined)` already gives exactly the header names: hebcal's English, Hebrew from `he-x-NoNikud` ("אדר א׳", "אדר ב׳"), and the Russian nominative from `@hebcal/locales`: Тишрей, Хешван, Кислев, Тевет, Шват, Адар, Адар I, Адар II, Нисан, Ияр, Сиван, Тамуз, Ав, Элул. The range and the cell's fallback reuse it.
  - `isGenitiveList` becomes `isMonthList`, because it now checks both lists.
  - `gematriya(5790)` is 'תש״צ', 5785 is 'תשפ״ה', 5788 is 'תשפ״ח', and 20 is 'כ׳'.
- **Intl** (Node 26.11.1, ICU 78.3; the formatters use `timeZone: 'UTC'` on UTC noon):

  | | en-GB | he-IL | ru-RU |
  |---|---|---|---|
  | `{ month: 'long' }` | "October" | "אוקטובר" | "октябрь" (standalone nominative) |
  | month and year | | | "октябрь 2026 г." (hence the title is built from the name and the key's year) |
  | narrow weekday | S M T W T F S | א׳ ב׳ ג׳ ד׳ ה׳ ו׳ ש׳ | В П В С Ч П С (ambiguous) |
  | short weekday | | | вс пн вт ср чт пт сб (capitalised) |

  - The Hebrew narrow weekdays use U+05F3, the same geresh `gematriya` writes.
  - Stripping a trailing '.' from the Russian short weekday guards ICU builds that abbreviate with a period. None was seen.
  - Telegram's WebViews use the platform's ICU, so the device check covers them.
- **Grid sizes:**
  - A 4-row month needs a 28-day February that starts on the week start. From 2020 to 2035 that happens at every week start: Sunday 2026, Monday 2021 and 2027, Tuesday 2022 and 2033, Wednesday 2023 and 2034, Thursday 2029 and 2035, Friday 2030, Saturday 2025 and 2031. So the sweep asserts 4, 5 and 6 rows at every week start.
  - October 2026 starts on a Thursday and has 31 days: 5 rows at week starts 0–4, and 6 at 5 and 6.
  - August 2026 starts on a Saturday: 6 rows at 0 and 1.
- **Clocks:** grid.ts never reads the device's calendar, and the smoke's reference does, at local noon. So running under Santiago and Kiritimati checks each against the other:
  - Santiago has no 00:00 on 2026-09-06 and repeats 23:00 on 2026-04-04;
  - Kiritimati is UTC+14;
  - the in-process clock check (`process.env.TZ`, as D's hebrew-date smoke does) adds Los Angeles.
- **hebrew-date.ts now imports `./grid`** for the header. grid imports only types, so the home's bundle gains no package. D's import-scan check is updated to allow it.
- **Mutations caught** (24, each run alone):
  - grid: local-midnight days (under Jerusalem), the last row one day long, the week start ignored, an inclusive month window, `MONTHS_AHEAD = 17`, the span newest first, a fractional `n` rounded, a wrong last day, and an out-of-range week start used as it is;
  - format: Russian "октябрь 2026 г.", no capital, Russian narrow weekdays, Hebrew short weekdays, and the weekday from a local Date (under Kiritimati);
  - hebrew-date:
    - the header: the year on both sides always, the middle month instead of the last, Hebrew nikud in the header, a Russian genitive in the header, and no backwards-run check;
    - the cell: digits in a Hebrew cell, a broken short list accepted, "ב" in a cell label, and Hebrew day 30 for the month's start;
    - `@hebcal/core` imported.
- **Verified** on a copy of 0064e8f:
  - Before: the grid smoke exits 1 with `Cannot find module '../src/lib/calendar-view/grid'` under all four clocks, and the hebrew-date smoke gives 13/22 (exit 1).
  - After: the grid smoke gives 11/11 and the hebrew-date smoke 22/22 under UTC, Asia/Jerusalem, Pacific/Kiritimati, America/Santiago and America/Los_Angeles.
  - `tsc --noEmit` and `eslint .` are clean.
  - The render smoke gives 41/41 with the same lines as before, under UTC and Asia/Jerusalem (also 41/41 under Kiritimati). `check-i18n-parity` exits 0.
  - The task text was applied with `dapply.py` to a fresh copy of 0064e8f (17 edits, none skipped), and the five files are byte-identical to the verified copy. The before and after runs above were repeated there, and Step 12's commit ran as written.
- **Verified against stand-ins:**
  - E1's `calendarHome.hebrewMonthShort` was stood in, in the copy only, as one line per messages file: en `["Tish.", "Chesh.", "Kis.", "Tev.", "Sh'vat", "Adar", "Adar I", "Adar II", "Nisan", "Iyar", "Sivan", "Tamuz", "Av", "Elul"]`, he the plain names (`"חשון"`, `"אדר א׳"`, …), ru `["тишр.", "хешв.", "кисл.", "тев.", "шват", "адар", "адар I", "адар II", "нис.", "ияр", "сив.", "там.", "ав", "элул"]`.
  - With it in, the hebrew-date smoke gives 22/22 and `check-i18n-parity` exits 0. Without it, only check 18 fails, and the smoke gives 21/22.
  - With the stand-in, `smoke-calendar-home-copy.ts` #2 reports the key as extra until E1's Keys table lists it. That's E1's file, and this task doesn't touch it.
  - Check 18 accepts any natural short form. Each entry must be a non-empty string that starts with the same letter as the month's name in that language, Adar, Adar I and Adar II must differ, Hebrew must have no nikud, and the cell must read the list as it is, never the fallback.

- [ ] **Step 1: Write the failing smoke `scripts/smoke-calendar-grid.ts`**

Create the file with exactly this content:

```ts
// Smoke test for the Month's calendar arithmetic and titles (spec §7.4, §5's month
// windows, Ruling R12; Plan E, Task E2): src/lib/calendar-view/grid.ts, and
// formatMonthTitle and formatWeekdayHeader in src/lib/calendar-view/format.ts.
//
// The Month draws each month as week rows from the user's week start (0 = Sunday …
// 6 = Saturday): the first row is the week holding the 1st and the last row the week
// holding the month's last day, so a month has 4, 5 or 6 rows. It fetches each month's
// own days, [1st, 1st of next month) (R12), over a window of 12 months back to 18 ahead.
// A day key is a calendar day, so none of this may depend on the device's clock: the
// checks read days through an independent local-noon reference and run under five
// device clocks, America/Santiago's midnight DST change included.
//
// Pure: no database, Redis, network or AI. Run it under four clocks:
//   TZ=UTC npx tsx scripts/smoke-calendar-grid.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-calendar-grid.ts
//   TZ=Pacific/Kiritimati npx tsx scripts/smoke-calendar-grid.ts
//   TZ=America/Santiago npx tsx scripts/smoke-calendar-grid.ts

import fs from 'fs';
import path from 'path';
import {
  MONTHS_AHEAD,
  MONTHS_BACK,
  addMonths,
  grid,
  monthFirstDay,
  monthGrid,
  monthLastDay,
  monthOf,
  monthSpan,
  monthWindow,
  weekdayOrder,
} from '../src/lib/calendar-view/grid';
import { formatMonthTitle, formatWeekdayHeader } from '../src/lib/calendar-view/format';
import type { WeekStart } from '../src/lib/calendar-view/types';

const ROOT = path.resolve(__dirname, '..');

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
}

function assert(cond: boolean, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

function assertEqual<T>(got: T, want: T, label: string) {
  assert(JSON.stringify(got) === JSON.stringify(want), `${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

const WEEK_STARTS: readonly WeekStart[] = [0, 1, 2, 3, 4, 5, 6];
const pad = (n: number) => String(n).padStart(2, '0');

// The reference reads days through the device's own calendar at local noon (which exists
// on every day in every zone), never through grid.ts's UTC arithmetic.
function localNoon(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d, 12);
}
function localKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function nextKey(key: string): string {
  const d = localNoon(key);
  d.setDate(d.getDate() + 1);
  return localKey(d);
}
function weekdayRef(key: string): number {
  return localNoon(key).getDay();
}
function daysInMonthRef(y: number, m: number): number {
  return new Date(y, m, 0, 12).getDate();
}
/** Each row as "first..last", for exact expectations that stay readable. */
function spans(rows: string[][]): string[] {
  return rows.map(r => `${r[0]}..${r[r.length - 1]}`);
}

async function main() {
  await check('every month from 2020-01 to 2035-12 at every week start 0–6: rows of 7 consecutive days from the week start, the first holding the 1st, the last holding the last day, 4–6 rows', () => {
    const rowCounts = WEEK_STARTS.map(() => new Set<number>());
    for (let y = 2020; y <= 2035; y++) {
      for (let m = 1; m <= 12; m++) {
        const month = `${y}-${pad(m)}`;
        const len = daysInMonthRef(y, m);
        const firstKey = `${month}-01`;
        const lastKey = `${month}-${pad(len)}`;
        for (const ws of WEEK_STARTS) {
          const label = `${month} at week start ${ws}`;
          const rows = monthGrid(month, ws);
          assert(rows.length >= 4 && rows.length <= 6, `${label}: ${rows.length} rows`);
          assert(rows.every(r => r.length === 7), `${label}: a row without 7 days`);
          const flat = rows.flat();
          for (let i = 1; i < flat.length; i++) {
            assert(flat[i] === nextKey(flat[i - 1]), `${label}: ${flat[i]} follows ${flat[i - 1]}`);
          }
          for (const row of rows) assert(weekdayRef(row[0]) === ws, `${label}: the row from ${row[0]} starts on weekday ${weekdayRef(row[0])}`);
          assert(rows[0].includes(firstKey), `${label}: the first row ${spans(rows)[0]} misses ${firstKey}`);
          assert(rows[rows.length - 1].includes(lastKey), `${label}: the last row ${spans(rows).at(-1)} misses ${lastKey}`);
          const inMonth = flat.filter(k => k.startsWith(`${month}-`));
          assert(inMonth.length === len && new Set(inMonth).size === len, `${label}: ${inMonth.length} in-month cells, want ${len}`);
          const offset = (weekdayRef(firstKey) - ws + 7) % 7;
          assert(rows.length === Math.ceil((offset + len) / 7), `${label}: ${rows.length} rows, want ${Math.ceil((offset + len) / 7)}`);
          assertEqual(rows, grid(firstKey, lastKey, ws), `${label}: monthGrid is grid(1st, last day)`);
          rowCounts[ws].add(rows.length);
        }
      }
    }
    WEEK_STARTS.forEach(ws => assertEqual([...rowCounts[ws]].sort(), [4, 5, 6], `row counts seen at week start ${ws}`));
  });

  await check('4-row months: February 2026 at week start 0 (it starts on a Sunday) and February 2027 at week start 1 (a Monday)', () => {
    assertEqual(spans(monthGrid('2026-02', 0)), ['2026-02-01..2026-02-07', '2026-02-08..2026-02-14', '2026-02-15..2026-02-21', '2026-02-22..2026-02-28'], 'February 2026, ws 0');
    assertEqual(spans(monthGrid('2027-02', 1)), ['2027-02-01..2027-02-07', '2027-02-08..2027-02-14', '2027-02-15..2027-02-21', '2027-02-22..2027-02-28'], 'February 2027, ws 1');
    assertEqual(monthGrid('2026-02', 1).length, 5, 'February 2026 at week start 1 needs a fifth row');
  });

  await check('6-row months: August 2026 at week starts 0 and 1; October 2026 has 5 rows at week starts 0–4 and 6 at 5 and 6', () => {
    assertEqual(spans(monthGrid('2026-08', 0)), ['2026-07-26..2026-08-01', '2026-08-02..2026-08-08', '2026-08-09..2026-08-15', '2026-08-16..2026-08-22', '2026-08-23..2026-08-29', '2026-08-30..2026-09-05'], 'August 2026, ws 0');
    assertEqual(spans(monthGrid('2026-08', 1)), ['2026-07-27..2026-08-02', '2026-08-03..2026-08-09', '2026-08-10..2026-08-16', '2026-08-17..2026-08-23', '2026-08-24..2026-08-30', '2026-08-31..2026-09-06'], 'August 2026, ws 1');
    assertEqual(spans(monthGrid('2026-10', 5)), ['2026-09-25..2026-10-01', '2026-10-02..2026-10-08', '2026-10-09..2026-10-15', '2026-10-16..2026-10-22', '2026-10-23..2026-10-29', '2026-10-30..2026-11-05'], 'October 2026, ws 5');
    assertEqual(spans(monthGrid('2026-10', 6)), ['2026-09-26..2026-10-02', '2026-10-03..2026-10-09', '2026-10-10..2026-10-16', '2026-10-17..2026-10-23', '2026-10-24..2026-10-30', '2026-10-31..2026-11-06'], 'October 2026, ws 6');
    const october: [WeekStart, string, string, number][] = [
      [0, '2026-09-27', '2026-10-31', 5],
      [1, '2026-09-28', '2026-11-01', 5],
      [2, '2026-09-29', '2026-11-02', 5],
      [3, '2026-09-30', '2026-11-03', 5],
      [4, '2026-10-01', '2026-11-04', 5],
    ];
    for (const [ws, first, last, rows] of october) {
      const g = monthGrid('2026-10', ws);
      assertEqual([g[0][0], g.at(-1)?.[6], g.length], [first, last, rows], `October 2026, ws ${ws}`);
    }
  });

  await check("grid on any run of days: one day, runs across a year and a leap day; [] for a bad key or a backwards run", () => {
    assertEqual(grid('2026-10-15', '2026-10-15', 4), [['2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21']], 'a Thursday at week start 4');
    assertEqual(spans(grid('2026-10-15', '2026-10-15', 0)), ['2026-10-11..2026-10-17'], 'a Thursday at week start 0');
    assertEqual(spans(grid('2026-12-30', '2027-01-02', 1)), ['2026-12-28..2027-01-03'], 'across the new year in one row');
    assertEqual(spans(grid('2026-12-27', '2027-01-10', 0)), ['2026-12-27..2027-01-02', '2027-01-03..2027-01-09', '2027-01-10..2027-01-16'], 'across the new year in three rows');
    assertEqual(grid('2028-02-27', '2028-03-01', 1)[1].slice(0, 3), ['2028-02-28', '2028-02-29', '2028-03-01'], 'the leap day');
    const bad: [string, string][] = [
      ['', '2026-10-31'],
      ['2026-10-01', ''],
      ['2026-10-01', '2026-02-30'],
      ['2026-13-01', '2026-13-31'],
      ['2026-1-01', '2026-10-31'],
      ['0026-10-01', '0026-10-31'],
      ['2026-10-01T00:00', '2026-10-31'],
      ['2026-10-31', '2026-10-01'],
    ];
    for (const [a, b] of bad) assertEqual(grid(a, b, 0), [], `grid(${JSON.stringify(a)}, ${JSON.stringify(b)})`);
  });

  await check('month maths: monthOf, addMonths across December and across years, the first and last days (leap years included), monthWindow [1st, 1st of next month) (R12)', () => {
    assertEqual([monthOf('2026-10-15'), monthOf('2026-12-31'), monthOf('2028-02-29')], ['2026-10', '2026-12', '2028-02'], 'monthOf');
    assertEqual([monthOf('2026-02-30'), monthOf('2026-10'), monthOf('')], ['', '', ''], 'monthOf a bad key');
    const adds: [string, number, string][] = [
      ['2026-12', 1, '2027-01'],
      ['2027-01', -1, '2026-12'],
      ['2026-10', 0, '2026-10'],
      ['2026-10', 18, '2028-04'],
      ['2026-10', -12, '2025-10'],
      ['2026-10', -22, '2024-12'],
      ['2026-10', 27, '2029-01'],
      ['2026-11', 14, '2028-01'],
      ['2026-10', 1.5, ''],
      ['2026-13', 1, ''],
      ['2026-1', 1, ''],
      ['', 1, ''],
    ];
    for (const [month, n, want] of adds) assertEqual(addMonths(month, n), want, `addMonths(${JSON.stringify(month)}, ${n})`);
    assertEqual([monthFirstDay('2026-10'), monthFirstDay('2027-01'), monthFirstDay('2026-13'), monthFirstDay('2026-10-01')], ['2026-10-01', '2027-01-01', '', ''], 'monthFirstDay');
    const lasts: [string, string][] = [
      ['2026-01', '2026-01-31'],
      ['2026-02', '2026-02-28'],
      ['2028-02', '2028-02-29'],
      ['2100-02', '2100-02-28'],
      ['2000-02', '2000-02-29'],
      ['2026-04', '2026-04-30'],
      ['2026-12', '2026-12-31'],
      ['2026-00', ''],
      ['', ''],
    ];
    for (const [month, want] of lasts) assertEqual(monthLastDay(month), want, `monthLastDay(${JSON.stringify(month)})`);
    assertEqual(monthWindow('2026-10'), { from: '2026-10-01', to: '2026-11-01' }, 'October 2026');
    assertEqual(monthWindow('2026-12'), { from: '2026-12-01', to: '2027-01-01' }, 'December 2026, across the year');
    assertEqual(monthWindow('2028-02'), { from: '2028-02-01', to: '2028-03-01' }, 'February 2028');
    assertEqual(monthWindow('2026-13'), { from: '', to: '' }, 'a bad month');
    assertEqual(monthGrid('2026-13', 0), [], 'monthGrid of a bad month');
  });

  await check('monthSpan(2026-10-15) is the 31 months 2025-10 … 2028-04, oldest first (MONTHS_BACK 12, MONTHS_AHEAD 18)', () => {
    assertEqual([MONTHS_BACK, MONTHS_AHEAD], [12, 18], 'the window constants');
    const span = monthSpan('2026-10-15');
    assertEqual(span.length, 31, 'months');
    assertEqual([span[0], span[MONTHS_BACK], span[30]], ['2025-10', '2026-10', '2028-04'], 'first, today and last');
    span.forEach((m, i) => assert(m === addMonths('2025-10', i), `month ${i} is ${m}, want ${addMonths('2025-10', i)}`));
    assertEqual([...span].sort(), span, 'oldest first');
    assertEqual(new Set(span).size, 31, 'no month twice');
    const jan = monthSpan('2026-01-01');
    assertEqual([jan[0], jan.at(-1), jan.length], ['2025-01', '2027-07', 31], 'from 1 January');
    const dec = monthSpan('2026-12-31');
    assertEqual([dec[0], dec.at(-1), dec.length], ['2025-12', '2028-06', 31], 'from 31 December');
    assertEqual([monthSpan(''), monthSpan('2026-10'), monthSpan('2026-02-30')], [[], [], []], 'a bad today');
  });

  await check("weekdayOrder starts at the week start and matches every grid row's weekdays", () => {
    assertEqual(weekdayOrder(0), [0, 1, 2, 3, 4, 5, 6], 'ws 0');
    assertEqual(weekdayOrder(1), [1, 2, 3, 4, 5, 6, 0], 'ws 1');
    assertEqual(weekdayOrder(5), [5, 6, 0, 1, 2, 3, 4], 'ws 5');
    assertEqual(weekdayOrder(6), [6, 0, 1, 2, 3, 4, 5], 'ws 6');
    for (const ws of WEEK_STARTS) {
      for (const month of ['2026-02', '2026-08', '2026-10', '2027-02']) {
        for (const row of monthGrid(month, ws)) assertEqual(row.map(weekdayRef), weekdayOrder(ws), `${month} ws ${ws} row from ${row[0]}`);
      }
    }
    // A week start the server never sends reads Sunday rather than misaligning the rows.
    for (const odd of [7, -1, 1.5, Number.NaN]) {
      assertEqual(weekdayOrder(odd as WeekStart), weekdayOrder(0), `weekdayOrder(${odd})`);
      assertEqual(monthGrid('2026-10', odd as WeekStart), monthGrid('2026-10', 0), `monthGrid at week start ${odd}`);
    }
  });

  await check("formatMonthTitle (Ruling 8): 'October 2026' / 'אוקטובר 2026' / 'Октябрь 2026', the month alone without the year; Russian nominative, capitalised, no 'г.'", () => {
    assertEqual(['en', 'he', 'ru'].map(l => formatMonthTitle('2026-10', l, true)), ['October 2026', 'אוקטובר 2026', 'Октябрь 2026'], 'with the year');
    assertEqual(['en', 'he', 'ru'].map(l => formatMonthTitle('2026-10', l, false)), ['October', 'אוקטובר', 'Октябрь'], 'without the year');
    const months = Array.from({ length: 12 }, (_, i) => `2027-${pad(i + 1)}`);
    assertEqual(months.map(m => formatMonthTitle(m, 'ru', true)), ['Январь 2027', 'Февраль 2027', 'Март 2027', 'Апрель 2027', 'Май 2027', 'Июнь 2027', 'Июль 2027', 'Август 2027', 'Сентябрь 2027', 'Октябрь 2027', 'Ноябрь 2027', 'Декабрь 2027'], 'ru, every month');
    assertEqual(months.map(m => formatMonthTitle(m, 'he', false)), ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'], 'he, every month');
    assertEqual(months.map(m => formatMonthTitle(m, 'en', false)), ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'], 'en, every month');
    assertEqual(formatMonthTitle('2028-04', 'de', true), 'April 2028', 'an unknown locale reads English');
    for (const bad of ['2026-13', '2026-00', '2026-1', '', '2026-10-01']) assertEqual(formatMonthTitle(bad, 'en', true), '', `formatMonthTitle(${JSON.stringify(bad)})`);
  });

  await check("formatWeekdayHeader (Ruling 8): en narrow 'S M T W T F S', he narrow 'א׳ ב׳ …', ru two letters 'Пн Вт …', in weekStart order", () => {
    assertEqual(weekdayOrder(0).map(d => formatWeekdayHeader(d, 'en')), ['S', 'M', 'T', 'W', 'T', 'F', 'S'], 'en, ws 0');
    assertEqual(weekdayOrder(0).map(d => formatWeekdayHeader(d, 'he')), ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'], 'he, ws 0');
    assertEqual(weekdayOrder(1).map(d => formatWeekdayHeader(d, 'ru')), ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'], 'ru, ws 1');
    assertEqual(weekdayOrder(6).map(d => formatWeekdayHeader(d, 'en')), ['S', 'S', 'M', 'T', 'W', 'T', 'F'], 'en, ws 6');
    assertEqual(formatWeekdayHeader(4, 'de'), 'T', 'an unknown locale reads English');
    for (const odd of [7, -1, 1.5]) assertEqual(formatWeekdayHeader(odd as WeekStart, 'en'), '', `formatWeekdayHeader(${odd})`);
  });

  await check("the same grids, spans, windows and titles on five device clocks (America/Santiago's midnight DST change included)", () => {
    const months = Array.from({ length: 48 }, (_, i) => addMonths('2025-01', i));
    const snapshot = () =>
      JSON.stringify({
        grids: months.map(m => WEEK_STARTS.map(ws => monthGrid(m, ws))),
        // Santiago: 2026-04-05 and 2026-09-06 change at midnight; Jerusalem: 2026-10-25.
        runs: [grid('2026-09-05', '2026-09-07', 0), grid('2026-04-04', '2026-04-06', 1), grid('2026-10-24', '2026-10-26', 6)],
        spans: ['2026-10-15', '2026-09-06', '2026-04-05', '2026-01-01'].map(monthSpan),
        windows: months.map(monthWindow),
        lasts: months.map(monthLastDay),
        titles: months.map(m => ['en', 'he', 'ru'].map(l => formatMonthTitle(m, l, true))),
        weekdays: ['en', 'he', 'ru'].map(l => WEEK_STARTS.map(d => formatWeekdayHeader(d, l))),
      });
    const saved = process.env.TZ;
    try {
      process.env.TZ = 'UTC';
      const reference = snapshot();
      for (const tz of ['Asia/Jerusalem', 'Pacific/Kiritimati', 'America/Santiago', 'America/Los_Angeles']) {
        process.env.TZ = tz;
        assert(snapshot() === reference, `the output differs with the clock in ${tz}`);
      }
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  });

  await check('grid.ts is pure: it imports only the DTO types (or date-fns), with no Intl, @hebcal, timezone library, local-time getter or clock', () => {
    const source = fs.readFileSync(path.join(ROOT, 'src/lib/calendar-view/grid.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const imports = [...code.matchAll(/^import\s+(type\s+)?(?:[^'"]*?\s+from\s+)?'([^']+)';/gm)].map(m => `${m[1] ? 'type ' : ''}${m[2]}`);
    for (const spec of imports) assert(spec === 'type ./types' || /^date-fns(\/|$)/.test(spec), `grid.ts imports ${spec}`);
    assert(!/require\(|import\(/.test(code), 'no require() or import()');
    for (const banned of [/\bIntl\b/, /toLocale/, /@hebcal/, /date-fns-tz/, /getTimezoneOffset/, /new Date\(\)/, /Date\.now/]) {
      assert(!banned.test(code), `grid.ts uses ${banned}`);
    }
    const local = code.match(/\.(get|set)(Date|Day|Month|FullYear|Hours)\(/);
    assert(!local, `grid.ts reads the device's calendar: ${local?.[0]}`);
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
for tz in UTC Asia/Jerusalem Pacific/Kiritimati America/Santiago; do
  TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-calendar-grid.ts; echo "exit $?"
done
```

Expected under each clock (the module doesn't exist yet):

```
Error: Cannot find module '../src/lib/calendar-view/grid'
Require stack:
- …/scripts/smoke-calendar-grid.ts
…
exit 1
```

- [ ] **Step 3: Add the Month's cases to `scripts/smoke-hebrew-date.ts`**

Make five edits, top to bottom. Each Before block occurs exactly once.

1. The header comment (lines 1–9). Before:

```ts
// Smoke test for the calendar home's Hebrew dates (spec §7.8, Plan D):
// src/lib/calendar-view/hebrew-date.ts, on @hebcal/hdate.
//
// The home shows the Hebrew date under its header ("4 Cheshvan 5787") and beside each
// Agenda day ("4 Cheshvan"), in the viewer's language. Hebrew uses gematriya and month
// names without nikud ("ד׳ בחשון תשפ״ז"). English uses the number and hebcal's month
// name. Russian uses the genitive from calendarHome.hebrewMonthGenitive ("4 хешвана",
// Ruling R9). A day key is a calendar day, so its Hebrew date never depends on the
// device's clock, and it is the daytime date (no sunset shift).
```

After:

```ts
// Smoke test for the calendar home's Hebrew dates (spec §7.8, Plans D and E):
// src/lib/calendar-view/hebrew-date.ts, on @hebcal/hdate.
//
// The home shows the Hebrew date under its header ("4 Cheshvan 5787") and beside each
// Agenda day ("4 Cheshvan"), in the viewer's language. Hebrew uses gematriya and month
// names without nikud ("ד׳ בחשון תשפ״ז"). English uses the number and hebcal's month
// name. Russian uses the genitive from calendarHome.hebrewMonthGenitive ("4 хешвана",
// Ruling R9). A day key is a calendar day, so its Hebrew date never depends on the
// device's clock, and it is the daytime date (no sunset shift).
//
// The Month (Plan E) adds two things. Each month's header names the first and last
// Hebrew months it touches, with the year on both sides only when it differs ("Elul
// 5786 – Tishrei 5787", "Tishrei – Cheshvan 5787"; Russian in the nominative, R9). Each
// cell shows the Hebrew day ("16", "ט״ז"), with a short month name on Hebrew day 1 and
// on the month's first cell ("1 Chesh.", "א׳ חשון", "1 хешв.", from
// calendarHome.hebrewMonthShort).
```

2. The import (line 26). Before:

```ts
import { HEBREW_MONTHS, hebrewDayLabel, hebrewFullDate } from '../src/lib/calendar-view/hebrew-date';
```

After:

```ts
import {
  HEBREW_MONTHS,
  hebrewCellLabel,
  hebrewCellMonth,
  hebrewDayLabel,
  hebrewFullDate,
  hebrewMonthHeader,
  hebrewMonthRange,
  isHebrewMonthStart,
} from '../src/lib/calendar-view/hebrew-date';
```

3. The end of `RU_GENITIVE` (lines 57–58), followed by the three short-name fixtures. Before:

```ts
  'адара II', 'нисана', 'ияра', 'сивана', 'тамуза', 'ава', 'элула',
];
```

After:

```ts
  'адара II', 'нисана', 'ияра', 'сивана', 'тамуза', 'ава', 'элула',
];

/** Short month names for the Month's cells, in HEBREW_MONTHS order, so the checks don't depend on messages/*.json. */
const EN_SHORT = ['Tish.', 'Chesh.', 'Kis.', 'Tev.', "Sh'vat", 'Adar', 'Adar I', 'Adar II', 'Nis.', 'Iyar', 'Siv.', 'Tam.', 'Av', 'Elul'];
const HE_SHORT = ['תשרי', 'חשון', 'כסלו', 'טבת', 'שבט', 'אדר', 'אדר א׳', 'אדר ב׳', 'ניסן', 'אייר', 'סיון', 'תמוז', 'אב', 'אלול'];
const RU_SHORT = ['тишр.', 'хешв.', 'кисл.', 'тев.', 'шват', 'адар', 'адар I', 'адар II', 'нис.', 'ияр', 'сив.', 'там.', 'ав', 'элул'];
```

4. Eight new checks (11–18), inserted before D1's messages check (line 209). Before:

```ts
  await check("messages/ru.json's calendarHome.hebrewMonthGenitive lines up with HEBREW_MONTHS (Task D1)", () => {
```

After:

```ts
  await check('Month headers (Plan E): the first and last Hebrew months a month touches, the year on both sides only when it differs; he gematriya, ru nominative (R9)', () => {
    // [month, en, he, ru]
    const rows: Row[] = [
      ['2026-09', 'Elul 5786 – Tishrei 5787', 'אלול תשפ״ו – תשרי תשפ״ז', 'Элул 5786 – Тишрей 5787'],
      ['2026-10', 'Tishrei – Cheshvan 5787', 'תשרי – חשון תשפ״ז', 'Тишрей – Хешван 5787'],
      // July 2030 runs from 30 Sivan through all of Tamuz to 1 Av: the middle month is skipped.
      ['2030-07', 'Sivan – Av 5790', 'סיון – אב תש״צ', 'Сиван – Ав 5790'],
      ['2027-11', 'Cheshvan 5788', 'חשון תשפ״ח', 'Хешван 5788'],
      ['2025-02', "Sh'vat 5785", 'שבט תשפ״ה', 'Шват 5785'],
      // 5787 is a leap year: Adar I, then Adar II.
      ['2027-02', "Sh'vat – Adar I 5787", 'שבט – אדר א׳ תשפ״ז', 'Шват – Адар I 5787'],
      ['2027-03', 'Adar I – Adar II 5787', 'אדר א׳ – אדר ב׳ תשפ״ז', 'Адар I – Адар II 5787'],
    ];
    for (const [month, en, he, ru] of rows) {
      assertEqual(hebrewMonthHeader(month, 'en'), en, `${month} en`);
      assertEqual(hebrewMonthHeader(month, 'he'), he, `${month} he`);
      assertEqual(hebrewMonthHeader(month, 'ru'), ru, `${month} ru`);
    }
    assertEqual(
      ['2030-07-01', '2030-07-15', '2030-07-31'].map(k => hebrewFullDate(k, 'en')),
      ['30 Sivan 5790', '14 Tamuz 5790', '1 Av 5790'],
      'fixture: July 2030 touches three Hebrew months'
    );
  });

  await check("hebrewMonthRange on any run of days; '' for a bad key or a backwards run; an unknown language reads English", () => {
    assertEqual(hebrewMonthRange('2026-10-15', '2026-10-15', 'en'), 'Cheshvan 5787', 'one day');
    assertEqual(hebrewMonthRange('2026-09-11', '2026-09-12', 'en'), 'Elul 5786 – Tishrei 5787', 'across the Tishrei year boundary');
    assertEqual(hebrewMonthRange('2026-09-12', '2026-10-12', 'he'), 'תשרי – חשון תשפ״ז', '1 Tishrei to 1 Cheshvan');
    assertEqual(hebrewMonthRange('2026-10-01', '2026-10-31', 'de'), 'Tishrei – Cheshvan 5787', 'de');
    const bad: [string, string][] = [
      ['2026-10-15', '2026-10-14'],
      ['', '2026-10-31'],
      ['2026-10-01', '2026-02-30'],
      ['2026-10-01', '2026-10'],
    ];
    for (const [a, b] of bad) assertEqual(hebrewMonthRange(a, b, 'en'), '', `hebrewMonthRange(${JSON.stringify(a)}, ${JSON.stringify(b)})`);
    for (const month of ['2026-13', '2026-00', '2026-1', '', '2026-10-01']) {
      assertEqual(hebrewMonthHeader(month, 'he'), '', `hebrewMonthHeader(${JSON.stringify(month)})`);
    }
  });

  await check("every month from 2025-01 to 2030-12 against hebcal's own calendar, three-month ones included", () => {
    let three = 0;
    for (let y = 2025; y <= 2030; y++) {
      for (let m = 1; m <= 12; m++) {
        const month = `${y}-${String(m).padStart(2, '0')}`;
        const days = new Date(y, m, 0, 12).getDate();
        const touched: HDate[] = [];
        for (let d = 1; d <= days; d++) {
          const hd = new HDate(new Date(y, m - 1, d, 12));
          const prev = touched[touched.length - 1];
          if (!prev || prev.getMonth() !== hd.getMonth() || prev.getFullYear() !== hd.getFullYear()) touched.push(hd);
        }
        if (touched.length === 3) three++;
        const a = touched[0];
        const b = touched[touched.length - 1];
        const want =
          touched.length === 1
            ? `${a.getMonthName()} ${a.getFullYear()}`
            : a.getFullYear() !== b.getFullYear()
              ? `${a.getMonthName()} ${a.getFullYear()} – ${b.getMonthName()} ${b.getFullYear()}`
              : `${a.getMonthName()} – ${b.getMonthName()} ${b.getFullYear()}`;
        assertEqual(hebrewMonthHeader(month, 'en'), want, month);
      }
    }
    assert(three > 0, 'fixture: no month from 2025 to 2030 touches three Hebrew months');
  });

  await check('isHebrewMonthStart is Hebrew day 1, on every day from 1 Tishrei 5786 to 29 Elul 5788', () => {
    assertEqual(
      ['2026-10-12', '2026-10-11', '2026-09-12', '2027-02-08', '2027-03-10', '2026-10-15'].map(isHebrewMonthStart),
      [true, false, true, true, true, false],
      '1 Cheshvan, 30 Tishrei, 1 Tishrei, 1 Adar I, 1 Adar II, 4 Cheshvan'
    );
    let hd = new HDate(1, 7, 5786);
    while (hd.getFullYear() <= 5788) {
      const key = keyOf(hd);
      assert(isHebrewMonthStart(key) === (hd.getDate() === 1), `${key} (${hd.toString()})`);
      hd = hd.next();
    }
    for (const bad of ['', '2026-13-01', '2026-02-30']) assertEqual(isHebrewMonthStart(bad), false, `isHebrewMonthStart(${JSON.stringify(bad)})`);
  });

  await check("hebrewCellLabel without the month: the day alone, '16' / 'ט״ז' / '16' (and ט״ו for 15)", () => {
    // [day key, en and ru, he]
    const rows: [string, string, string][] = [
      ['2026-10-27', '16', 'ט״ז'],
      ['2026-10-26', '15', 'ט״ו'],
      ['2026-10-12', '1', 'א׳'],
      ['2026-10-15', '4', 'ד׳'],
      ['2026-11-10', '30', 'ל׳'],
    ];
    for (const [key, digits, he] of rows) {
      assertEqual(hebrewCellLabel(key, 'en', false, EN_SHORT), digits, `${key} en`);
      assertEqual(hebrewCellLabel(key, 'he', false, HE_SHORT), he, `${key} he`);
      assertEqual(hebrewCellLabel(key, 'ru', false, RU_SHORT), digits, `${key} ru`);
      assertEqual(hebrewCellLabel(key, 'he', false), he, `${key} he without a list`);
    }
  });

  await check("hebrewCellLabel with the month, and hebrewCellMonth alone, read the short list ('1 Chesh.' / 'א׳ חשון' / '1 хешв.'); a missing or broken list falls back to hebrewDayLabel's month names", () => {
    const rows: Row[] = [
      ['2026-10-12', '1 Chesh.', 'א׳ חשון', '1 хешв.'],
      ['2026-09-12', '1 Tish.', 'א׳ תשרי', '1 тишр.'],
      ['2027-02-08', '1 Adar I', 'א׳ אדר א׳', '1 адар I'],
      ['2027-03-10', '1 Adar II', 'א׳ אדר ב׳', '1 адар II'],
      ['2026-02-18', '1 Adar', 'א׳ אדר', '1 адар'],
      // A month's first cell names the month too (Ruling 3), whatever its Hebrew day.
      ['2026-10-01', '20 Tish.', 'כ׳ תשרי', '20 тишр.'],
    ];
    for (const [key, en, he, ru] of rows) {
      assertEqual(hebrewCellLabel(key, 'en', true, EN_SHORT), en, `${key} en`);
      assertEqual(hebrewCellLabel(key, 'he', true, HE_SHORT), he, `${key} he`);
      assertEqual(hebrewCellLabel(key, 'ru', true, RU_SHORT), ru, `${key} ru`);
      // Ruling 3's browse cell: the day number on the head line, the month alone on the second.
      const lists: [string, string[]][] = [['en', EN_SHORT], ['he', HE_SHORT], ['ru', RU_SHORT]];
      for (const [lang, list] of lists) {
        assertEqual(`${hebrewCellLabel(key, lang, false, list)} ${hebrewCellMonth(key, lang, list)}`, hebrewCellLabel(key, lang, true, list), `${key} ${lang}: the day, then hebrewCellMonth`);
      }
    }
    assertEqual(['en', 'he', 'ru'].map((l, i) => hebrewCellMonth('2026-10-12', l, [EN_SHORT, HE_SHORT, RU_SHORT][i])), ['Chesh.', 'חשון', 'хешв.'], 'hebrewCellMonth on 1 Cheshvan');
    // The fallback is the month as hebrewDayLabel names it without a genitive list: hebcal's
    // English name, the Hebrew without nikud (and without "ב"), the Russian nominative.
    const broken: unknown[] = [
      undefined,
      RU_SHORT.slice(0, 13),
      RU_SHORT.map((s, i) => (i === 1 ? ' ' : s)),
      RU_SHORT.map((s, i) => (i === 1 ? 7 : s)),
      'хешв.',
      {},
      null,
    ];
    for (const list of broken) {
      const l = list as string[] | undefined;
      assertEqual(hebrewCellLabel('2026-10-12', 'en', true, l), '1 Cheshvan', `en with ${JSON.stringify(list)}`);
      assertEqual(hebrewCellLabel('2026-10-12', 'he', true, l), 'א׳ חשון', `he with ${JSON.stringify(list)}`);
      assertEqual(hebrewCellLabel('2026-10-12', 'ru', true, l), '1 Хешван', `ru with ${JSON.stringify(list)}`);
      assertEqual(['en', 'he', 'ru'].map(lang => hebrewCellMonth('2026-10-12', lang, l)), ['Cheshvan', 'חשון', 'Хешван'], `hebrewCellMonth with ${JSON.stringify(list)}`);
    }
    assertEqual(hebrewCellLabel('2026-10-12', 'ru', true), hebrewDayLabel('2026-10-12', 'ru'), "ru's fallback is hebrewDayLabel's month");
    assertEqual(hebrewCellLabel('2026-10-12', 'de', true, EN_SHORT), '1 Chesh.', 'an unknown language reads English');
    for (const bad of ['', '2026-13-01', '2026-02-30', '0026-10-15']) {
      assertEqual(hebrewCellLabel(bad, 'he', true, HE_SHORT), '', `hebrewCellLabel(${JSON.stringify(bad)}) with the month`);
      assertEqual(hebrewCellLabel(bad, 'en', false), '', `hebrewCellLabel(${JSON.stringify(bad)}) without it`);
      assertEqual(hebrewCellMonth(bad, 'ru', RU_SHORT), '', `hebrewCellMonth(${JSON.stringify(bad)})`);
    }
  });

  await check("the Month's headers and cell labels on five device clocks", () => {
    const months = ['2026-09', '2026-10', '2030-07', '2027-02', '2027-03', '2026-04'];
    // Santiago changes at midnight on 2026-04-05 and 2026-09-06; Jerusalem on 2026-10-25.
    const keys = ['2026-10-12', '2026-10-27', '2026-09-06', '2026-04-05', '2026-10-25', '2026-10-01'];
    const labelsNow = () =>
      JSON.stringify([
        months.flatMap(m => ['en', 'he', 'ru'].map(l => hebrewMonthHeader(m, l))),
        keys.flatMap(k => [
          hebrewCellLabel(k, 'en', true, EN_SHORT),
          hebrewCellLabel(k, 'he', false),
          hebrewCellLabel(k, 'ru', true, RU_SHORT),
          hebrewCellMonth(k, 'he', HE_SHORT),
          isHebrewMonthStart(k),
        ]),
      ]);
    const saved = process.env.TZ;
    try {
      process.env.TZ = 'UTC';
      const reference = labelsNow();
      assert(reference.startsWith('[["Elul 5786 – Tishrei 5787","אלול תשפ״ו – תשרי תשפ״ז"'), `reference under UTC: ${reference.slice(0, 80)}`);
      for (const tz of ['Asia/Jerusalem', 'Pacific/Kiritimati', 'America/Los_Angeles', 'America/Santiago']) {
        process.env.TZ = tz;
        assertEqual(labelsNow(), reference, `with the clock in ${tz}`);
      }
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  });

  await check("messages' calendarHome.hebrewMonthShort lines up with HEBREW_MONTHS in en, he and ru (Task E1)", () => {
    for (const lang of ['en', 'he', 'ru']) {
      const messages = readJson(`messages/${lang}.json`) as { calendarHome?: { hebrewMonthShort?: unknown } };
      const list = messages.calendarHome?.hebrewMonthShort;
      assert(Array.isArray(list), `messages/${lang}.json has no calendarHome.hebrewMonthShort array (Task E1 adds it)`);
      assert(list.length === 14, `${lang}: the list has ${list.length} entries, want 14`);
      HEBREW_MONTHS.forEach((name, i) => {
        const entry = list[i];
        assert(typeof entry === 'string' && entry.trim() !== '', `${lang} entry ${i} (${name}) is empty`);
        const full = lang === 'en' ? name : (Locale.lookupTranslation(name, lang === 'he' ? 'he-x-NoNikud' : 'ru') ?? '');
        // A short form starts as the name does: "Chesh." / "חשון" / "хешв." for Cheshvan.
        assert(
          full !== '' && entry.charAt(0).toLowerCase() === full.charAt(0).toLowerCase(),
          `${lang} entry ${i} is ${JSON.stringify(entry)}, not a short form of ${full} (${name})`
        );
      });
      assert(new Set(list.slice(5, 8)).size === 3, `${lang}: Adar, Adar I and Adar II must differ: ${JSON.stringify(list.slice(5, 8))}`);
      if (lang === 'he') assert(!list.some(e => /[֑-ׇ]/.test(String(e))), 'he: no nikud in the short names');
      // Read as it is, never the fallback.
      const day = lang === 'he' ? 'א׳' : '1';
      assertEqual(hebrewCellLabel('2026-10-12', lang, true, list as string[]), `${day} ${list[1]}`, `${lang}: 1 Cheshvan with the shipped list`);
    }
  });

  await check("messages/ru.json's calendarHome.hebrewMonthGenitive lines up with HEBREW_MONTHS (Task D1)", () => {
```

5. The import scan (lines 266–269) now allows `./grid`. Before:

```ts
  await check('hebrew-date.ts imports only @hebcal/hdate, @hebcal/locales/ru and the DTO types (no @hebcal/core on the home)', () => {
    const source = fs.readFileSync(path.join(ROOT, 'src/lib/calendar-view/hebrew-date.ts'), 'utf8');
    const imports = [...source.matchAll(/^import\s+(type\s+)?(?:[^'"]*?\s+from\s+)?'([^']+)';/gm)].map(m => `${m[1] ? 'type ' : ''}${m[2]}`);
    assertEqual(imports.sort(), ['@hebcal/hdate', '@hebcal/locales/ru', 'type ./types'], 'imports');
```

After:

```ts
  await check("hebrew-date.ts imports only @hebcal/hdate, @hebcal/locales/ru, the Month's grid and the DTO types (no @hebcal/core on the home)", () => {
    const source = fs.readFileSync(path.join(ROOT, 'src/lib/calendar-view/hebrew-date.ts'), 'utf8');
    const imports = [...source.matchAll(/^import\s+(type\s+)?(?:[^'"]*?\s+from\s+)?'([^']+)';/gm)].map(m => `${m[1] ? 'type ' : ''}${m[2]}`);
    // grid.ts imports only the DTO types (smoke-calendar-grid.ts checks it), so this pulls in nothing else.
    assertEqual(imports.sort(), ['./grid', '@hebcal/hdate', '@hebcal/locales/ru', 'type ./types'], 'imports');
```

- [ ] **Step 4: Run it and watch the new checks fail**

```bash
for tz in UTC Asia/Jerusalem Pacific/Kiritimati America/Santiago; do
  TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-hebrew-date.ts; echo "exit $?"
done
```

Expected under each clock: D's ten checks, D1's messages check and the two dependency checks pass. The eight new checks and the import scan fail. The lines below are without E1. With E1 in, check 18 fails with `(0 , import_hebrew_date.hebrewCellLabel) is not a function` instead, and the count is the same.

```
OK  15 October 2026 (a Thursday) is 4 Cheshvan 5787 in en, he and ru
OK  every month's name in each language, Adar I and Adar II 5787 and plain Adar 5786 included
OK  Adar I and Adar II in 5787, a leap year: 30 days of Adar I, then Adar II, then Nisan; 5786 has one Adar
OK  Cheshvan and Kislev of 29 and 30 days (5786, 5787 and 5784)
OK  the Tishrei year boundary: 29 Elul 5786, then 1 Tishrei 5787
OK  Hebrew days 15 and 16 are ט״ו and ט״ז
OK  every day from 1 Tishrei 5786 to 29 Elul 5788 matches hebcal's own calendar
OK  the same labels on five device clocks: a day key is a calendar day, never an instant
OK  Russian: the genitive list is read only in Russian; with no list or a broken one, the nominative
OK  an unknown language gets English; a day key that isn't a real day gets an empty string
FAIL  Month headers (Plan E): the first and last Hebrew months a month touches, the year on both sides only when it differs; he gematriya, ru nominative (R9) — (0 , import_hebrew_date.hebrewMonthHeader) is not a function
FAIL  hebrewMonthRange on any run of days; '' for a bad key or a backwards run; an unknown language reads English — (0 , import_hebrew_date.hebrewMonthRange) is not a function
FAIL  every month from 2025-01 to 2030-12 against hebcal's own calendar, three-month ones included — (0 , import_hebrew_date.hebrewMonthHeader) is not a function
FAIL  isHebrewMonthStart is Hebrew day 1, on every day from 1 Tishrei 5786 to 29 Elul 5788 — undefined is not a function
FAIL  hebrewCellLabel without the month: the day alone, '16' / 'ט״ז' / '16' (and ט״ו for 15) — (0 , import_hebrew_date.hebrewCellLabel) is not a function
FAIL  hebrewCellLabel with the month, and hebrewCellMonth alone, read the short list ('1 Chesh.' / 'א׳ חשון' / '1 хешв.'); a missing or broken list falls back to hebrewDayLabel's month names — (0 , import_hebrew_date.hebrewCellLabel) is not a function
FAIL  the Month's headers and cell labels on five device clocks — (0 , import_hebrew_date.hebrewMonthHeader) is not a function
FAIL  messages' calendarHome.hebrewMonthShort lines up with HEBREW_MONTHS in en, he and ru (Task E1) — messages/en.json has no calendarHome.hebrewMonthShort array (Task E1 adds it)
OK  messages/ru.json's calendarHome.hebrewMonthGenitive lines up with HEBREW_MONTHS (Task D1)
OK  one Locale: the Russian that hebrew-date.ts registers is what @hebcal/core sees ('Хешван')
OK  @hebcal/hdate is a direct dependency pinned to ^0.21.1, with one copy in the lock and in node_modules
FAIL  hebrew-date.ts imports only @hebcal/hdate, @hebcal/locales/ru, the Month's grid and the DTO types (no @hebcal/core on the home) — imports: got ["@hebcal/hdate","@hebcal/locales/ru","type ./types"], want ["./grid","@hebcal/hdate","@hebcal/locales/ru","type ./types"]
13/22 passed (process TZ=UTC)
exit 1
```

- [ ] **Step 5: Create `src/lib/calendar-view/grid.ts`**

Create the file with exactly this content:

```ts
// The Month's calendar arithmetic (spec §7.4, §5's month windows, Ruling R12): the
// months of the window, each month's own days and its week rows. Client-safe and pure:
// no Intl, no @hebcal, no timezone, no clock. It imports only the DTO types.
//
// - A day key is a calendar day in the viewer's timezone, so every step is UTC
//   arithmetic on UTC noon of the day, the rule of store.ts's addDaysToKey and
//   format.ts's keyDate. The device's clock and its DST changes can never move a day.
// - A month is drawn as rows of 7 days from the week start: the first row is the week
//   holding the 1st and the last row the week holding the month's last day, so a month
//   has 4, 5 or 6 rows. The days outside the month stay blank (R12).
// - A month fetches its own days, [1st, 1st of next month) (R12).
// - Nothing here throws: a malformed key gives '' (or [], or an empty window).

import type { DayKey, WeekStart } from './types';

/** A calendar month, 'yyyy-MM'. */
export type MonthKey = string;

/** The Month's window (spec §7.4): 12 months before today's month … 18 months after it. */
export const MONTHS_BACK = 12;
export const MONTHS_AHEAD = 18;

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_KEY = /^\d{4}-\d{2}$/;
const DAY_MS = 86_400_000;

/** UTC noon of a real 'yyyy-MM-dd' day, in ms; null otherwise ('2026-02-30' and years before 0100 included). */
function dayMs(day: DayKey): number | null {
  if (!DAY_KEY.test(day)) return null;
  const [y, m, d] = day.split('-').map(Number);
  const ms = Date.UTC(y, m - 1, d, 12);
  return new Date(ms).toISOString().slice(0, 10) === day ? ms : null;
}

function keyOf(ms: number): DayKey {
  return new Date(ms).toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday. */
function weekdayOf(ms: number): number {
  return new Date(ms).getUTCDay();
}

/** A week start the server never sends (not an integer 0–6) reads Sunday, so rows never misalign. */
function weekStartOf(weekStart: WeekStart): WeekStart {
  return Number.isInteger(weekStart) && weekStart >= 0 && weekStart <= 6 ? weekStart : 0;
}

/** year × 12 + the month's index (0–11) of a real 'yyyy-MM' month; null otherwise. */
function monthIndex(month: MonthKey): number | null {
  if (!MONTH_KEY.test(month) || dayMs(`${month}-01`) === null) return null;
  return Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;
}

/** The month of a monthIndex, or '' outside the years a key can write. */
function monthAt(index: number): MonthKey {
  const year = Math.floor(index / 12);
  const month = `${String(year).padStart(4, '0')}-${String(index - year * 12 + 1).padStart(2, '0')}`;
  return monthIndex(month) === null ? '' : month;
}

/**
 * The week rows from the week holding `firstKey` to the week holding `lastKey` (inclusive),
 * each 7 consecutive day keys from `weekStart`. A month's grid has 4, 5 or 6 rows.
 * [] for a malformed key or a backwards run.
 */
export function grid(firstKey: DayKey, lastKey: DayKey, weekStart: WeekStart): DayKey[][] {
  const first = dayMs(firstKey);
  const last = dayMs(lastKey);
  if (first === null || last === null || last < first) return [];
  const ws = weekStartOf(weekStart);
  const start = first - ((weekdayOf(first) - ws + 7) % 7) * DAY_MS;
  const end = last + ((ws + 6 - weekdayOf(last)) % 7) * DAY_MS;
  const rows: DayKey[][] = [];
  for (let row = start; row <= end; row += 7 * DAY_MS) {
    rows.push(Array.from({ length: 7 }, (_, i) => keyOf(row + i * DAY_MS)));
  }
  return rows;
}

/** The month of a day key: '2026-10-15' → '2026-10'; '' for a malformed key. */
export function monthOf(day: DayKey): MonthKey {
  return dayMs(day) === null ? '' : day.slice(0, 7);
}

/** `n` months after `month` (before it when negative): '2026-12' + 1 → '2027-01'; '' for a malformed month or a fractional n. */
export function addMonths(month: MonthKey, n: number): MonthKey {
  const index = monthIndex(month);
  return index === null || !Number.isInteger(n) ? '' : monthAt(index + n);
}

/** The month's 1st: '2026-10' → '2026-10-01'; '' for a malformed month. */
export function monthFirstDay(month: MonthKey): DayKey {
  return monthIndex(month) === null ? '' : `${month}-01`;
}

/** The month's last day: '2028-02' → '2028-02-29'; '' for a malformed month. */
export function monthLastDay(month: MonthKey): DayKey {
  if (monthIndex(month) === null) return '';
  const [y, m] = month.split('-').map(Number);
  // Day 0 of the next month is this month's last day.
  return keyOf(Date.UTC(y, m, 0, 12));
}

/** The days a month fetches (R12): [1st, 1st of next month), the end excluded. Both '' for a malformed month. */
export function monthWindow(month: MonthKey): { from: DayKey; to: DayKey } {
  const from = monthFirstDay(month);
  const to = monthFirstDay(addMonths(month, 1));
  return from && to ? { from, to } : { from: '', to: '' };
}

/** The month's week rows from `weekStart`: grid(1st, last day). [] for a malformed month. */
export function monthGrid(month: MonthKey, weekStart: WeekStart): DayKey[][] {
  const first = monthFirstDay(month);
  return first ? grid(first, monthLastDay(month), weekStart) : [];
}

/**
 * The Month's window around today (spec §7.4): MONTHS_BACK months before today's month,
 * today's month, then MONTHS_AHEAD after it, oldest first (31 months). [] for a malformed today.
 */
export function monthSpan(today: DayKey): MonthKey[] {
  const month = monthOf(today);
  if (!month) return [];
  const out: MonthKey[] = [];
  for (let n = -MONTHS_BACK; n <= MONTHS_AHEAD; n++) {
    const m = addMonths(month, n);
    if (m) out.push(m);
  }
  return out;
}

/** The weekdays in column order: [weekStart, weekStart + 1, …] mod 7. */
export function weekdayOrder(weekStart: WeekStart): WeekStart[] {
  const ws = weekStartOf(weekStart);
  return Array.from({ length: 7 }, (_, i) => ((ws + i) % 7) as WeekStart);
}
```

- [ ] **Step 6: Add the month title and the weekday header to `src/lib/calendar-view/format.ts`**

Make four edits, top to bottom.

1. The header's first lines (1–2). Before:

```ts
// Dates and times on the calendar home (spec §7.1 Times, §7.3). Intl only; client-safe
// and pure (it imports only the store's day arithmetic and the DTO types).
```

After:

```ts
// Dates and times on the calendar home (spec §7.1 Times, §7.3, §7.4). Intl only;
// client-safe and pure (it imports only the store's day arithmetic and the DTO and
// month-key types).
```

2. A header bullet for the Month (lines 11–12). Before:

```ts
// - A range of days in one month names the month once, as spec §7.3 and the mockups do:
//   "Sat 17 – Sun 18 Oct", "שבת 17 – ראשון 18 באוק׳", "сб, 17 – вс, 18 окт.".
```

After:

```ts
// - A range of days in one month names the month once, as spec §7.3 and the mockups do:
//   "Sat 17 – Sun 18 Oct", "שבת 17 – ראשון 18 באוק׳", "сб, 17 – вс, 18 окт.".
// - The Month's titles are the standalone month name ("October 2026", "Октябрь 2026"),
//   and its weekday row is one letter in English and Hebrew, two in Russian (Plan E
//   Ruling 8).
```

3. The imports (lines 16–17). Before:

```ts
import { addDaysToKey } from './store';
import type { DayKey, ItemDTO } from './types';
```

After:

```ts
import type { MonthKey } from './grid';
import { addDaysToKey } from './store';
import type { DayKey, ItemDTO, WeekStart } from './types';
```

4. The two functions, after `allDayLastDay` at the end of the file (lines 180–183). Before:

```ts
/** An all-day item's last day: its end date is exclusive; a missing or non-advancing end means one day (as daySpanOf). */
export function allDayLastDay(item: Pick<ItemDTO, 'start' | 'end'>): DayKey {
  return DAY_KEY.test(item.end) && item.end > item.start ? addDaysToKey(item.end, -1) : item.start;
}
```

After:

```ts
/** An all-day item's last day: its end date is exclusive; a missing or non-advancing end means one day (as daySpanOf). */
export function allDayLastDay(item: Pick<ItemDTO, 'start' | 'end'>): DayKey {
  return DAY_KEY.test(item.end) && item.end > item.start ? addDaysToKey(item.end, -1) : item.start;
}

const MONTH_NAME: Intl.DateTimeFormatOptions = { month: 'long', timeZone: 'UTC' };

/** The first letter upper-cased: Intl writes Russian month and weekday names in lower case. */
function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * A month's title (Plan E Ruling 8): "October 2026" / "אוקטובר 2026" / "Октябрь 2026",
 * or the month alone without the year ("October"). It is built from the standalone month
 * name and the key's year, so Russian reads the nominative, capitalised, without the
 * "г." of ru-RU's month-and-year pattern ("октябрь 2026 г."). '' for a key that isn't a
 * real 'yyyy-MM' month.
 */
export function formatMonthTitle(month: MonthKey, locale: string, withYear: boolean): string {
  const d = /^\d{4}-\d{2}$/.test(month) ? keyDate(`${month}-01`) : null;
  if (!d) return '';
  const name = capitalise(formatter(locale, MONTH_NAME).format(d));
  return withYear ? `${name} ${month.slice(0, 4)}` : name;
}

/**
 * A weekday column's header in the Month (Plan E Ruling 8): one letter in English
 * ("S M T W T F S") and Hebrew ("א׳ ב׳ ג׳ ד׳ ה׳ ו׳ ש׳"), two in Russian ("Пн Вт Ср Чт
 * Пт Сб Вс"), whose one-letter forms repeat (П for both Monday and Friday). `weekday` is
 * 0 = Sunday … 6 = Saturday; '' for anything else.
 */
export function formatWeekdayHeader(weekday: WeekStart, locale: string): string {
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) return '';
  // 18 October 2026 is a Sunday.
  const d = new Date(Date.UTC(2026, 9, 18 + weekday, 12));
  if (intlLocale(locale) === INTL_LOCALES.ru) {
    return capitalise(formatter(locale, { weekday: 'short', timeZone: 'UTC' }).format(d).replace(/\.$/, ''));
  }
  return formatter(locale, { weekday: 'narrow', timeZone: 'UTC' }).format(d);
}
```

- [ ] **Step 7: Run the grid smoke under the four clocks**

```bash
for tz in UTC Asia/Jerusalem Pacific/Kiritimati America/Santiago; do
  TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-calendar-grid.ts; echo "exit $?"
done
```

Expected under each clock:

```
OK  every month from 2020-01 to 2035-12 at every week start 0–6: rows of 7 consecutive days from the week start, the first holding the 1st, the last holding the last day, 4–6 rows
OK  4-row months: February 2026 at week start 0 (it starts on a Sunday) and February 2027 at week start 1 (a Monday)
OK  6-row months: August 2026 at week starts 0 and 1; October 2026 has 5 rows at week starts 0–4 and 6 at 5 and 6
OK  grid on any run of days: one day, runs across a year and a leap day; [] for a bad key or a backwards run
OK  month maths: monthOf, addMonths across December and across years, the first and last days (leap years included), monthWindow [1st, 1st of next month) (R12)
OK  monthSpan(2026-10-15) is the 31 months 2025-10 … 2028-04, oldest first (MONTHS_BACK 12, MONTHS_AHEAD 18)
OK  weekdayOrder starts at the week start and matches every grid row's weekdays
OK  formatMonthTitle (Ruling 8): 'October 2026' / 'אוקטובר 2026' / 'Октябрь 2026', the month alone without the year; Russian nominative, capitalised, no 'г.'
OK  formatWeekdayHeader (Ruling 8): en narrow 'S M T W T F S', he narrow 'א׳ ב׳ …', ru two letters 'Пн Вт …', in weekStart order
OK  the same grids, spans, windows and titles on five device clocks (America/Santiago's midnight DST change included)
OK  grid.ts is pure: it imports only the DTO types (or date-fns), with no Intl, @hebcal, timezone library, local-time getter or clock
11/11 passed (process TZ=UTC)
exit 0
```

The process zone in the summary line follows the clock: `Asia/Jerusalem`, `Pacific/Kiritimati`, `America/Santiago`.

- [ ] **Step 8: Add the Month's Hebrew helpers to `src/lib/calendar-view/hebrew-date.ts`**

Make six edits, top to bottom.

1. The header's first lines (1–2). Before:

```ts
// Hebrew dates on the calendar home (spec §7.8): the full date under the header
// ("4 Cheshvan 5787") and the Hebrew date beside each Agenda day ("4 Cheshvan").
```

After:

```ts
// Hebrew dates on the calendar home (spec §7.8): the full date under the header
// ("4 Cheshvan 5787"), the Hebrew date beside each Agenda day ("4 Cheshvan"), and on the
// Month (Plan E) each month's Hebrew months ("Tishrei – Cheshvan 5787") and each cell's
// Hebrew day ("16", or "1 Chesh." with the month).
```

2. The imports (lines 12–13). Before:

```ts
import '@hebcal/locales/ru';
import type { DayKey } from './types';
```

After:

```ts
import '@hebcal/locales/ru';
import { monthFirstDay, monthLastDay, type MonthKey } from './grid';
import type { DayKey } from './types';
```

3. `isGenitiveList` checks the short names too, so it becomes `isMonthList` (line 57). Before:

```ts
function isGenitiveList(list: readonly string[] | undefined): list is readonly string[] {
```

After:

```ts
/** A month-name list from messages (the genitives, or the Month's short names): 14 non-empty strings. */
function isMonthList(list: readonly string[] | undefined): list is readonly string[] {
```

4. Its one call (line 77). Before:

```ts
    if (index >= 0 && isGenitiveList(genitive)) return genitive[index];
```

After:

```ts
    if (index >= 0 && isMonthList(genitive)) return genitive[index];
```

5. `dayLabel` (lines 83–86) takes its day number from a new helper, `dayNumber`, which the cell label shares. A second helper, `yearLabel`, goes beside it for `hebrewFullDate` and the month range. Before:

```ts
function dayLabel(hd: HDate, lang: Lang, genitive: readonly string[] | undefined): string {
  const month = monthLabel(hd, lang, genitive);
  return lang === 'he' ? `${gematriya(hd.getDate())} ב${month}` : `${hd.getDate()} ${month}`;
}
```

After:

```ts
/** The Hebrew day number: gematriya in Hebrew ("ט״ז"), digits otherwise ("16"). */
function dayNumber(hd: HDate, lang: Lang): string {
  return lang === 'he' ? gematriya(hd.getDate()) : String(hd.getDate());
}

/** The Hebrew year: gematriya in Hebrew ("תשפ״ז"), digits otherwise ("5787"). */
function yearLabel(hd: HDate, lang: Lang): string {
  return lang === 'he' ? gematriya(hd.getFullYear()) : String(hd.getFullYear());
}

function dayLabel(hd: HDate, lang: Lang, genitive: readonly string[] | undefined): string {
  const day = dayNumber(hd, lang);
  const month = monthLabel(hd, lang, genitive);
  return lang === 'he' ? `${day} ב${month}` : `${day} ${month}`;
}
```

6. `hebrewFullDate`'s body (lines 103–108) uses the year helper, and the new exports follow it at the end of the file. Before:

```ts
  const hd = hebrewDateOf(dayKey);
  if (!hd) return '';
  const l = langOf(lang);
  const year = l === 'he' ? gematriya(hd.getFullYear()) : String(hd.getFullYear());
  return `${dayLabel(hd, l, genitive)} ${year}`;
}
```

After:

```ts
  const hd = hebrewDateOf(dayKey);
  if (!hd) return '';
  const l = langOf(lang);
  return `${dayLabel(hd, l, genitive)} ${yearLabel(hd, l)}`;
}

/**
 * The first and last Hebrew months a run of days touches (spec §7.8's month headers; a
 * month in between is skipped), with the year on both sides only when it differs:
 * "Elul 5786 – Tishrei 5787", "Tishrei – Cheshvan 5787", or one month, "Cheshvan 5788".
 * Hebrew: names without nikud and a gematriya year ("אלול תשפ״ו – תשרי תשפ״ז"). Russian:
 * the nominative (Ruling R9, "Тишрей – Хешван 5787"). '' when a key isn't a real day or
 * `lastKey` is before `firstKey`.
 */
export function hebrewMonthRange(firstKey: DayKey, lastKey: DayKey, lang: string): string {
  const a = hebrewDateOf(firstKey);
  const b = hebrewDateOf(lastKey);
  if (!a || !b || lastKey < firstKey) return '';
  const l = langOf(lang);
  const first = monthLabel(a, l, undefined);
  const last = monthLabel(b, l, undefined);
  if (a.getFullYear() !== b.getFullYear()) return `${first} ${yearLabel(a, l)} – ${last} ${yearLabel(b, l)}`;
  if (a.getMonth() === b.getMonth()) return `${first} ${yearLabel(b, l)}`;
  return `${first} – ${last} ${yearLabel(b, l)}`;
}

/** A Gregorian month's Hebrew months, for its header: hebrewMonthRange(1st, last day). '' for a malformed month. */
export function hebrewMonthHeader(month: MonthKey, lang: string): string {
  const first = monthFirstDay(month);
  return first ? hebrewMonthRange(first, monthLastDay(month), lang) : '';
}

/** Whether a day key is Hebrew day 1 (the cells that name the month); false for a malformed key. */
export function isHebrewMonthStart(dayKey: DayKey): boolean {
  return hebrewDateOf(dayKey)?.getDate() === 1;
}

/**
 * The month's short name from `shortMonths` (`calendarHome.hebrewMonthShort`, 14 entries in
 * HEBREW_MONTHS order). With no list, or a broken one, the month as hebrewDayLabel names
 * it without a genitive list: "Cheshvan", "חשון", "Хешван".
 */
function shortMonthName(hd: HDate, lang: Lang, shortMonths: readonly string[] | undefined): string {
  const index = (HEBREW_MONTHS as readonly string[]).indexOf(hd.getMonthName());
  return index >= 0 && isMonthList(shortMonths) ? shortMonths[index] : monthLabel(hd, lang, undefined);
}

/**
 * A Month cell's Hebrew day: the day alone ("16" / "ט״ז" / "16"), or with the month's short
 * name ("1 Chesh." / "א׳ חשון" / "1 хешв."). `shortMonths` is
 * `calendarHome.hebrewMonthShort`; with no list, or a broken one, the month reads "1
 * Cheshvan" / "א׳ חשון" / "1 Хешван". '' for a key that isn't a real day.
 */
export function hebrewCellLabel(dayKey: DayKey, lang: string, withMonth: boolean, shortMonths?: readonly string[]): string {
  const hd = hebrewDateOf(dayKey);
  if (!hd) return '';
  const l = langOf(lang);
  const day = dayNumber(hd, l);
  return withMonth ? `${day} ${shortMonthName(hd, l, shortMonths)}` : day;
}

/**
 * The month's short name alone, for the browse cell's second line (Plan E Ruling 3: on
 * Hebrew day 1 and on the month's first cell): "Chesh." / "חשון" / "хешв.", with
 * hebrewCellLabel's fallback ("Cheshvan" / "חשון" / "Хешван"). '' for a key that isn't a
 * real day.
 */
export function hebrewCellMonth(dayKey: DayKey, lang: string, shortMonths?: readonly string[]): string {
  const hd = hebrewDateOf(dayKey);
  return hd ? shortMonthName(hd, langOf(lang), shortMonths) : '';
}
```

- [ ] **Step 9: Run the hebrew-date smoke under the four clocks**

```bash
for tz in UTC Asia/Jerusalem Pacific/Kiritimati America/Santiago; do
  TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-hebrew-date.ts; echo "exit $?"
done
```

Expected under each clock, with E1 in:

```
22/22 passed (process TZ=UTC)
exit 0
```

Every line reads `OK`. Without E1, only check 18 fails: `FAIL  messages' calendarHome.hebrewMonthShort lines up with HEBREW_MONTHS in en, he and ru (Task E1) — messages/en.json has no calendarHome.hebrewMonthShort array (Task E1 adds it)`, and the smoke gives 21/22.

- [ ] **Step 10: Run the regression smokes**

```bash
for tz in UTC Asia/Jerusalem; do
  TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-calendar-home-render.ts; echo "exit $?"
done
TZ=UTC DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/check-i18n-parity.ts; echo "exit $?"
```

Expected:
- the render smoke gives `41/41 passed (process TZ=UTC)` and `41/41 passed (process TZ=Asia/Jerusalem)`, each followed by `exit 0`, with the same lines as before this task (E1, E3 and later tasks change it, but this one doesn't);
- `check-i18n-parity` prints `exit 0`.

- [ ] **Step 11: Type-check and lint**

```bash
npx tsc --noEmit; echo "tsc exit $?"
npx eslint src/lib/calendar-view/grid.ts src/lib/calendar-view/format.ts src/lib/calendar-view/hebrew-date.ts scripts/smoke-calendar-grid.ts scripts/smoke-hebrew-date.ts; echo "eslint exit $?"
```

Expected: no output from either tool, then `tsc exit 0` and `eslint exit 0`.

- [ ] **Step 12: Commit**

```bash
git add src/lib/calendar-view/grid.ts src/lib/calendar-view/format.ts src/lib/calendar-view/hebrew-date.ts scripts/smoke-calendar-grid.ts scripts/smoke-hebrew-date.ts
git commit -F - <<'EOF'
feat(calendar-home): the Month's grid, titles and Hebrew month headers

grid.ts holds the Month's calendar arithmetic, pure and on UTC noon so the
device's clock never moves a day: the window of 12 months back to 18 ahead,
each month's week rows from the user's week start (4, 5 or 6 rows: the
week holding the 1st to the week holding the last day), and each month's
own fetch window, [1st, 1st of next month) (R12). format.ts adds the month
title ("October 2026", "Октябрь 2026" in the nominative without "г.") and
the weekday row (one letter in English and Hebrew, two in Russian).
hebrew-date.ts adds the month header, the first and last Hebrew months a
month touches with the year on both sides only when it differs ("Elul
5786 – Tishrei 5787", "Tishrei – Cheshvan 5787"; gematriya in Hebrew, the
nominative in Russian, R9), whether a day is Hebrew day 1, and a cell's
Hebrew day with or without the short month name, plus that name alone
for the browse cell's second line. Nothing renders them yet.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
EOF
```

---

### Task 3 (E3): Month windows in the store and loader, and the server's shared timezone lookup (spec §5 "Month windows" and States, Plan E Rulings 7 and 10)

> **INTERFACE CHANGE VERSUS THE SPLIT (read this first; E5 and E8 build on it).** Every name and signature the split gives E3 is used verbatim (`DayCoverage.failure`, `dayFailure`, `MONTH_INFLIGHT_MAX`, `LoaderHost.getMonths?` and `agendaShowing?`, `HomeLoader.retryWindow`, `globalThis.__tzInflight` and its key). One change, and two points the split leaves open:
> 1. **A lookup takes callers in for its first 1.5 s only** (`JOIN_MS`, under the range route's 2 s wait; review patch). The split's map shares a lookup for as long as it runs. But a lookup can hang on a call with no time limit of its own (an Upstash read, Google's `settings.get`), and every later caller for that user, the summaries and reminders included, would then wait on it until undici gives up after about 300 s. So an entry keeps when it started (`performance.now()`, the process's monotonic clock, which a smoke's fake `Date` leaves alone), and a call 1.5 s or more after that starts its own lookup, which takes callers in from then on: at most one lookup per key starts in any 1.5 s. The map's values are `{ lookup, startedAt }`, and an entry is deleted only by its own lookup. `scripts/smoke-calendar-range.ts` is not edited: #24's second open comes after the route's 2 s wait, so it starts afresh and lands, as it did before this task.
> 2. **Which windows count as Month windows (binding for E8):** a window counts when it is exactly `[yyyy-MM-01, the 1st of the next month)`, which is E2's `monthWindow` shape (R12), whoever sends it. An Agenda week (7 days) is never one. So E8 needs no flag: `getMonths()` and `retryWindow(monthWindow(m), source)` go through the cap because of the window's shape, and so do their stale and error follow-ups, whose window is the answer's own `[from, to)`.
> 3. **"Most wanted first" also decides the queue:** when a slot frees, the loader reads `getMonths()` again. It drops every queued month that isn't in it (or that was queued before the last store drop), and sends the one that comes first in it. So in a fast scroll the months the user has passed are never fetched, and the one under the bar goes next. A dropped month isn't marked asked: `ensure()` asks it again when it comes back. A dropped Retry or follow-up isn't asked again on its own. A failed month counts as covered, so it shows "Couldn't load · Retry" again, and a stale month waits for the next return to the foreground or ⋯ → Refresh, as a second stale answer does today.
>    **A month's stale or error follow-up is dropped the same way when it falls due** (review patch): it goes only while `getMonths()` still has the month, even with a slot free. Without this, a Google user browsing at about 0.7 s a month with 3-30 minute old cache entries sent 60 requests in the first minute, the limiter's whole allowance, 19 of them for months no longer near (the review's fling probe); with it, about 40 (38 to 43 across runs: the probe runs on real timers), one of them for a month left behind while its request was out.
> 4. **The Reconnect banner and the unavailable calendars hold for the epoch** (review patch; E6 and E8 rely on it). A dead token answers `ok` where Google's cache has the window and `reconnect` where it hasn't, and a legend from an older cache entry doesn't list a calendar that went since. With `homeNotices` reading only the latest answer, the Reconnect banner and E8's "N calendars aren't available" row came and went as each month answered, above the Month, and iOS has no scroll anchoring. The store now keeps `reconnect` (the latest reconnect's reason, null until one) and `unavailable` (the ids any ok answer listed as unavailable) for the epoch, and `homeNotices` reads them. A store drop (midnight, other facts) clears both; Reconnect and Choose again leave the page, and the home starts afresh when it comes back. This reaches the Agenda's users now: a refetch that answers from the cache no longer hides the banner.

**What and why.** Plan E's Month asks each month's own days (R12), several months at a time, so the client data flow needs six things D didn't:
- **A failure per day** (D's deferred item). Today a state row takes its reason from the store-wide `lastFailure`. So a 429 on Agenda week 1 turns week 0's "Your calendars aren't available · Choose again" into "Busy", and with many months the latest failure anywhere would decide every row. Each failed day now keeps the failure that marked it (`DayCoverage.failure`, read with `dayFailure`). The Agenda's state row takes the earliest shown failed day's reason, then `lastFailure`, then a generic error. E5 gives each Month notice its earliest in-month failed day's reason the same way.
- **Month windows in the loader** (spec §5, Ruling 7):
  - the host says which months it wants (`getMonths()`, most wanted first), and `ensure()` asks each uncovered one once per epoch and source;
  - at most `MONTH_INFLIGHT_MAX` (2) month requests are in flight; every send for a month waits its turn (the first ask, a refetch, Retry, and the stale and error follow-ups), and the Agenda's weeks never do;
  - `refetchVisible()` asks the Agenda's weeks only while `agendaShowing()`, then the wanted months;
  - `retryWindow()` is the Month's Retry.
- **Windows keyed by both ends.** On the 1st of a month, Agenda week 0 `[1st, 8th)` and that month `[1st, 1st of next month)` share a start. Keyed by `from` alone, the month was counted as asked once week 0 was, and the two were deduped against each other.
- **No card for an older epoch's failure** (D's deferred item). After the midnight reset (no facts yet), a 429 or a 500 answering a request sent before the reset called `onFirstLoadFailed`, and the busy or retry card flashed until the new day's answer. The busy/error branch now starts with `if (epoch !== host.getStore().epoch) return;`.
- **No follow-up for a month left behind** (review patch): a stale re-request or an error retry for a month the host no longer wants is dropped when it falls due (interface note 3).
- **The banners hold for the epoch** (review patch): the Reconnect banner and the unavailable calendars no longer follow each answer (interface note 4).

On the server, **`resolveUserTimezone` shares a lookup in flight per user** (D's deferred item; the Month opens several windows at once). The range route waits 2 s for the zone and lets the lookup go on (spec §4 step 3). A stuck Nominatim keeps that lookup alive for about 48 s, and until now every open in that time started another one. The map is on `globalThis.__tzInflight`, keyed `${user.id}|${location ?? ''}|${token ? 'g' : ''}`. Every caller within 1.5 s of a lookup's start gets its answer, a rejection reaches each of them, and the entry is deleted when the lookup settles; a later caller starts its own (interface note 1), so a stuck call holds nobody for long. Nothing else in the lookup changes, and the key (which holds a location) is never logged.

CalendarHome isn't edited. Its loader host is D's, without the two new methods, so it sends exactly what it sends today. The loader smoke pins this URL for URL, and that check passes on D's loader too. The Month's fetching reaches users only with E8, which adds the Month to the host. One change reaches the Agenda's users now: the Reconnect banner and the unavailable row hold for the epoch (interface note 4; `HomeBanners.tsx` gets two comment lines that say so).

**Files** (line numbers as of 0064e8f, the state this task starts from):
- Modify: `src/lib/calendar-view/store.ts` (lines 13-18, 52-55, 75-80, 103-108, 129-131, 173-177, 216-223, 230-233, 252-263, 311-314, 319-325)
- Modify: `src/lib/calendar-view/agenda.ts` (lines 9-14, 18-21, 197-201, 205-209, 229-233)
- Modify: `src/lib/calendar-view/home-loader.ts` (lines 6-24, 33-36, 53-65, 71-79, 89-92, 101-104, 119-122, 132-151, 164-171, 178-188)
- Modify: `src/lib/timezone.ts` (lines 52-63)
- Modify (comments only): `app/[locale]/dashboard/HomeBanners.tsx` (lines 10-11, 29)
- Create (test): `scripts/smoke-calendar-loader.ts`, `scripts/smoke-timezone-inflight.ts`
- Modify (test): `scripts/smoke-calendar-agenda.ts` (lines 10-13, 19-22, 400-403, 477, 496-499, 514-517), `scripts/smoke-calendar-home-render.ts` (lines 49-52, 2247-2250)
- Not modified: `app/[locale]/dashboard/CalendarHome.tsx` and every other app file but `HomeBanners.tsx`'s comments, `src/lib/calendar-view/home-client.ts`, the route, and `scripts/smoke-calendar-range.ts`.
- Test: `smoke-calendar-agenda` (33 → 37), `smoke-calendar-loader` (new, 12), `smoke-calendar-home-render` (41 → 42) and `smoke-timezone-inflight` (new, 7), each under `TZ=UTC`, `TZ=Asia/Jerusalem` and `TZ=Pacific/Kiritimati`.
- Regression: `smoke-calendar-range` (24, three clocks, #24 unchanged: it pins that an open after the route's 2 s wait starts its own lookup); under UTC and Asia/Jerusalem, `smoke-location-timezone` (14), `smoke-reminders` (23) and `smoke-account-merge` (50), which run the real `resolveUserTimezone` with a fake Redis, and `smoke-initdata-header` (9) and `smoke-auth-leftovers` (9), which scan `app/`, `src/` and `scripts/`.

**Interfaces:**
- Consumes (all on 0064e8f; E3 uses no E1 or E2 export):
  - `src/lib/calendar-view/store.ts`: `reduceStore`, `emptyStore`, `daysInWindow`, `dayStatus`, `failedSources`, and the types `CalendarStore`, `DayCoverage`, `SourceFailure`, `StoreAction`;
  - `src/lib/calendar-view/agenda.ts`: `agendaWeekWindow(today: DayKey, week: number): { from: DayKey; to: DayKey }`;
  - `src/lib/calendar-view/home-client.ts`: `fetchRange(userId, source, window: RangeWindow | null, fresh: boolean, limit?: RangeTimeLimit): Promise<RangeOutcome>`, `interface RangeWindow { from: DayKey; to: DayKey }`;
  - `src/services/weather/geocoding.ts` `geocodeLocation`, `src/services/calendar.ts` `getUserCalendarTimezone`, `src/utils/redis.ts` `redis` (unchanged, stubbed in the smoke).
- Produces, `src/lib/calendar-view/store.ts`:
  - `export interface DayCoverage { ok: boolean; failed: boolean; partial: boolean; failure: SourceFailure | null }`, with `failure` set exactly when `failed`, and null when ok or untouched;
  - `export function dayFailure(state: CalendarStore, day: DayKey, source: SourceName): SourceFailure | null`;
  - `lastFailure` is unchanged: each source's latest failure, still set by both actions;
  - `CalendarStore` gains `reconnect: 'token' | 'scopes' | null` and `unavailable: string[]` (interface note 4), both empty in `emptyStore()`; `homeNotices(state)` keeps its signature and reads them, so `reconnect` and `unavailableCalendars` hold for the epoch.
- Produces, `src/lib/calendar-view/agenda.ts`: no signature change. `buildAgenda(...).stateRows[i].failure` is `dayFailure` on the earliest shown failed day, then `lastFailure`, then `{ kind: 'error', source, reason: null }`.
- Produces, `src/lib/calendar-view/home-loader.ts`:
  - `export const MONTH_INFLIGHT_MAX = 2`;
  - `LoaderHost` gains `getMonths?(): readonly RangeWindow[]` (the Month windows wanted now, most wanted first; absent or `[]` means none) and `agendaShowing?(): boolean` (absent means true);
  - `HomeLoader` gains `retryWindow(window: RangeWindow, only?: SourceName): void`: the window again, plain, for each applicable source (or only `only`), through the cap when it is a month;
  - a month's stale or error follow-up goes only while `getMonths()` has the month when it falls due (interface note 3);
  - `STALE_RETRY_MS`, `ERROR_RETRY_MS`, `RANGE_TIMEOUT_MS`, `createHomeLoader(host)`, `ensure()`, `refetchVisible(o?)` and `dispose()` keep their signatures.
- Produces, `src/lib/timezone.ts`: `resolveUserTimezone(user: { id: number; location?: string; googleRefreshToken?: string; telegramId?: number | null }): Promise<string>`, same signature; `globalThis.__tzInflight: Map<string, { lookup: Promise<string>; startedAt: number }>` (`startedAt` from `performance.now()`), joined for `JOIN_MS` = 1500 ms.
- **How E8 wires it** (E8's task): its host's `getMonths` returns E5's `wantedMonths(ui, near, inView, today)` while the Month panel shows, else `[]`; `agendaShowing` returns whether the Agenda tab is the one on screen; the Month's Retry calls `loader.retryWindow(monthWindow(m), source)`. The ensure effect also runs when the tab, the near months or the UI changes. E5 reads `dayFailure` for `MonthNotice.failure`.

**Findings that shaped the code** (line numbers as of 0064e8f):
- **Where the failure lived.**
  - `store.ts:47-54`: `DayCoverage` says only whether a day failed.
  - Both writers mark a failed day with `failedCoverage()` (`:175`): `merge` for an error or reconnect answer (`:220-222`) and `markFailed` for a 429, a 500 or no answer (`:260-262`). Both also overwrite `lastFailure[source]` (`:203-204`, `:254-255`).
  - `agenda.ts:231` reads that store-wide value for every state row.
  - Both writers skip a day an ok answer covers (`!coverage[s]?.ok`), so storing the failure next to `failed` makes "a newer failure replaces an older one on its own days only" fall out.
  - Every failure kind is already a `SourceFailure` (`:63-67`), including `markFailed`'s busy and error.
- **`dayFailure` needs no `ok` check:** an ok day's `failure` is null.
- **Every state row is built in one place.** `buildAgenda` walks the shown days in order (`agenda.ts:203-226`), so the first failed day it meets for a source is the earliest. The fallbacks (`lastFailure`, then a generic error) are kept for a failed day without a failure of its own. The reducer never makes one, and the smoke builds one by hand.
- **Keys.**
  - `home-loader.ts:138` keys a window by `ask.window.from`, and `ensure()` checks `issued` by `window.from` (`:166`).
  - On the 1st, `agendaWeekWindow(today, 0)` (`agenda.ts:129-131`) and the month window start on the same day, so the month counted as asked once week 0 was.
  - The inflight dedupe matched them too: one refetch sent only week 0.
  - The no-dates request keeps its `default` key, and week 0 still counts as asked after it (`:166`'s second clause).
- **The follow-ups already go through `send`** (`:102-110`), with the answer's own `[from, to)` (`:100`). The route echoes the window it was asked for (`app/api/calendar/range/route.ts:209-210`). So a cap enforced in `send`, for windows of the month shape, covers the stale and error follow-ups with no flag carried along.
- **A month slot can't be held forever:** `fetchRange`'s time limit (`home-client.ts:93-118`, `RANGE_TIMEOUT_MS`) settles every request within 15 s, and the slot frees when it does (the loader smoke checks this).
- **The old epoch's flash.**
  - After a reset (`CalendarHome.tsx:194` on a late foreground, `:228` at midnight), the store has no facts.
  - The busy/error branch (`home-loader.ts:119-130`) then took the no-facts path, `onFirstLoadFailed` (`:129`). The home shows its card while `!facts && firstLoad` (`CalendarHome.tsx:274`), until the new answer's `onAnswer` (`:156`).
  - The reducer already ignores an older epoch's `windowFailed` (`store.ts:251`), so returning at once changes nothing else.
  - An older epoch's ok answer is unchanged: the reducer keeps it only while its facts still match.
- **D's host has neither new method** (`CalendarHome.tsx:148-170`), and both are optional, so with no months D's requests are the same. The keys change, but no two of D's windows share a start.
- **The timezone lookup.**
  - `timezone.ts:59-119` has no sharing.
  - The route races it against 2 s and lets it run (`route.ts:56-71`).
  - `geocodeLocation`'s `fetchWithTimeout` tries 4 times, 5 s each, with 0.5/1/1.5 s pauses (`geocoding.ts:14-27`), and `resolveUserTimezone` retries the geocode once after 2 s (`:69-82`). A stuck Nominatim keeps one lookup alive for about 48 s (2 × 23 s, plus the 2 s pause).
  - The key carries the location, so a lookup started before a location change is never the answer for the new location. R20's strict lookup after a save (`resolveTimezoneForLocation`) is separate and untouched.
  - The token counts only as present or absent, so callers holding different copies of it still share.
  - Shared state goes on `globalThis` because Next 16 compiles the scheduler and the routes into separate module instances (`calendar-read/google.ts:458`, `recurrence-cache.ts:37`).
  - **Why the join is bounded** (review patch). Of the lookup's calls, `redis.get` (Upstash's fetch) and `getUserCalendarTimezone` (Google's `settings.get`) have no time limit of their own, so a lookup can hang for undici's ~300 s; about 30 callers of `resolveUserTimezone` (summaries, voice, reminders, webhooks) would all have joined it. The review's probe: on 0064e8f a second call answered with 2 Redis reads; with the unbounded map it was still waiting after 1 s, with 1. The bound is under the route's 2 s wait (`route.ts:49`), so an open after a fallback answer, like #24's, starts afresh; 3 s would make #24 fail with `a quick lookup` (the patch's mutation run). `performance.now()` because `smoke-calendar-range` fakes `Date` with a frozen clock, under which every lookup looks 0 ms old.
- **The banners from the latest answer** (review patch). `homeNotices` (`store.ts:319-325`) read `status.google`, the latest answer, and `calendars`, the latest ok legend (`:228-232`). Google's cache answers a window from an entry under 3 minutes old without asking Google (`google.ts:622-629`), so with a dead token a cached month answers `ok` and an uncached one `reconnect`. The reconnect stamps the user's entries (`:523-526`), but a month answered from the cache before the stamp, such as the one in flight beside it, still comes back `ok` after it, and the banner went. A calendar that went after an entry was written is listed available in that entry. The review's banner probe flips the banner on four answers in a row; with the epoch's notices it shows from November on, and the row from February on.
- **The follow-ups** (review patch). `again` (`home-loader.ts:101-104`) sent through `send`, which starts at once when a slot is free and checks `getMonths()` only for queued sends (`nextMonth`). So a stale or error follow-up for a month the user had passed went out whenever a slot was free.
- **Left as it is: the warning's context carries the location** (`timezone.ts:105-110`: `location: user.location || '(none)'`, to Sentry when every source failed). The split says the behaviour is otherwise unchanged, so E3 doesn't touch it. The new code and both new smokes never log or print a location. Whether to drop it from that context is for the controller (before `ALL`).

- [ ] **Step 1: Add the failing store and Agenda checks to `scripts/smoke-calendar-agenda.ts`**

Six edits, in this order. Line numbers are the file's before the first edit.

**1.** In `scripts/smoke-calendar-agenda.ts`, lines 10-13: the header gains a sentence on the per-day failure. Before:
```ts
// "Still open" card holds today's open reminders and the carry-overs, 5 then the rest.
// Whose an item is follows the summaries' rules. Pure: no network, no DB, no React.
//
// Run under three clocks; the output must not depend on the process timezone:
```
After:
```ts
// "Still open" card holds today's open reminders and the carry-overs, 5 then the rest.
// Whose an item is follows the summaries' rules. Pure: no network, no DB, no React.
// Each failed day keeps the failure that marked it (Plan E): a state row gives the
// earliest shown failed day's reason, so a 429 on a later week never turns an earlier
// week's "Choose again" into "Busy".
//
// Run under three clocks; the output must not depend on the process timezone:
```

**2.** In `scripts/smoke-calendar-agenda.ts`, lines 19-22: the store import adds `dayFailure`. Before:
```ts
import {
  addDaysToKey,
  dayItems,
  dayStatus,
```
After:
```ts
import {
  addDaysToKey,
  dayFailure,
  dayItems,
  dayStatus,
```

**3.** In `scripts/smoke-calendar-agenda.ts`, lines 400-403: two store checks go before the addDaysToKey check (a failed day keeps its failure and an ok answer clears it; a newer failure replaces an older one on its own days only). Before:
```ts
  });

  await check('addDaysToKey matches the server\'s addDaysToDate across DST and year ends', async () => {
    const { addDaysToDate } = await import('../src/utils/day-events');
```
After:
```ts
  });

  await check('a failed day keeps the failure that marked it (DayCoverage.failure, set exactly when failed); an ok answer clears it, and a failure over ok data marks nothing', () => {
    const TIMEOUT = { kind: 'error', source: 'google', reason: 'timeout' } as const;
    let s = run([answer(googleAnswer({ sources: { google: { status: 'error', reason: 'timeout' } }, calendars: [] }))]);
    assertJson(s.days[TODAY]?.coverage.google, { ok: false, failed: true, partial: false, failure: TIMEOUT }, 'today after a timeout');
    assertJson(dayFailure(s, day(6), 'google'), TIMEOUT, 'dayFailure on day 6');
    assert(dayFailure(s, day(7), 'google') === null, 'a day nothing covered has a failure');
    assert(dayFailure(s, TODAY, 'famcal') === null, 'a source that does not apply has a failure');
    s = reduceStore(s, answer(googleAnswer()));
    assertJson(s.days[TODAY]?.coverage.google, { ok: true, failed: false, partial: false, failure: null }, 'today after an ok answer');
    assert(dayFailure(s, TODAY, 'google') === null, 'the failure outlived an ok answer');
    s = reduceStore(s, { type: 'windowFailed', from: TODAY, to: day(14), sources: ['google'], kind: 'busy', epoch: 0 });
    assert(dayFailure(s, TODAY, 'google') === null, 'a busy over ok data marked the day');
    assertJson(dayFailure(s, day(7), 'google'), { kind: 'busy', source: 'google' }, 'dayFailure on day 7');
    for (const [date, d] of Object.entries(s.days)) {
      const c = d.coverage.google;
      assert(c !== undefined && (c.failure !== null) === c.failed && c.failed !== c.ok, `${date}: ${JSON.stringify(c)}`);
    }
  });

  await check('a newer failure replaces an older one on its own days only', () => {
    const TRANSIENT = { kind: 'error', source: 'google', reason: 'transient' } as const;
    const BUSY = { kind: 'busy', source: 'google' } as const;
    const GONE = { kind: 'calendarsGone', source: 'google' } as const;
    const failures = (st: CalendarStore) => [0, 6, 7, 13, 14, 20, 21].map((n) => dayFailure(st, day(n), 'google'));
    let s = run([answer(googleAnswer({ sources: { google: { status: 'error', reason: 'transient' } }, calendars: [] }))]);
    s = reduceStore(s, { type: 'windowFailed', from: day(7), to: day(21), sources: ['google'], kind: 'busy', epoch: 0 });
    assertJson(failures(s), [TRANSIENT, TRANSIENT, BUSY, BUSY, BUSY, BUSY, null], 'a busy on weeks 1 and 2');
    assertJson(buildAgenda(s, 3)?.stateRows, [{ source: 'google', failure: TRANSIENT }], 'the state row: week 0\'s reason');
    s = reduceStore(s, answer(googleAnswer({ sources: { google: { status: 'error', reason: 'calendars_gone' } }, calendars: [] })));
    assertJson(failures(s), [GONE, GONE, BUSY, BUSY, BUSY, BUSY, null], 'calendars_gone on week 0');
    s = reduceStore(s, answer(googleAnswer({ ...agendaWeekWindow(TODAY, 2), sources: { google: { status: 'error', reason: 'timeout' } }, calendars: [] })));
    assertJson(failures(s).slice(4), [{ kind: 'error', source: 'google', reason: 'timeout' }, { kind: 'error', source: 'google', reason: 'timeout' }, null], 'a timeout on week 2');
    assertJson(failures(s).slice(0, 4), [GONE, GONE, BUSY, BUSY], 'weeks 0 and 1 keep theirs');
    assertJson(buildAgenda(s, 3)?.stateRows, [{ source: 'google', failure: GONE }], 'the state row: week 0\'s reason');
  });

  await check('addDaysToKey matches the server\'s addDaysToDate across DST and year ends', async () => {
    const { addDaysToDate } = await import('../src/utils/day-events');
```

**4.** In `scripts/smoke-calendar-agenda.ts`, lines 496-499: the Agenda check (a busy week 1 keeps week 0's calendars-gone row) goes before the partial-answer check. Before:
```ts
      `F ${day(14)}..${day(20)}`,
    ], 'weeks 0 and 2 answered, week 1 failed');
  });

```
After:
```ts
      `F ${day(14)}..${day(20)}`,
    ], 'weeks 0 and 2 answered, week 1 failed');
  });

  await check('a busy week 1 keeps week 0\'s calendars-gone row: a state row gives the earliest shown failed day\'s reason, then lastFailure, then a generic error', () => {
    const GONE_ROW = [{ source: 'google', failure: { kind: 'calendarsGone', source: 'google' } }];
    const gone = run([answer(googleAnswer({ sources: { google: { status: 'error', reason: 'calendars_gone' } }, calendars: [] }))]);
    const s = reduceStore(gone, { type: 'windowFailed', ...agendaWeekWindow(TODAY, 1), sources: ['google'], kind: 'busy', epoch: 0 });
    assertJson(s.lastFailure.google, { kind: 'busy', source: 'google' }, 'lastFailure is still the latest');
    assertJson(buildAgenda(s, 1)?.stateRows, GONE_ROW, 'week 0');
    assertJson(buildAgenda(s, 2)?.stateRows, GONE_ROW, 'weeks 0 and 1: Choose again, not Busy');
    const back = reduceStore(s, answer(googleAnswer()));
    assertJson(buildAgenda(back, 2)?.stateRows, [{ source: 'google', failure: { kind: 'busy', source: 'google' } }], 'week 0 answered: week 1\'s busy');
    // A failed day without a failure of its own (the reducer never makes one) reads lastFailure, then a generic error.
    const bare: CalendarStore = { ...back, days: { ...back.days, [day(7)]: { items: [], coverage: { google: { ok: false, failed: true, partial: false, failure: null } } } } };
    assertJson(buildAgenda(bare, 2)?.stateRows, [{ source: 'google', failure: { kind: 'busy', source: 'google' } }], 'no failure of its own: lastFailure');
    assertJson(buildAgenda({ ...bare, lastFailure: {} }, 2)?.stateRows, [{ source: 'google', failure: { kind: 'error', source: 'google', reason: null } }], 'no lastFailure either: a generic error');
  });

```

**5.** In `scripts/smoke-calendar-agenda.ts`, line 477: D's reconnect check now wants the banner kept over a later ok answer (a cache hit), the rule Step 6 brings in (interface note 4). Before:
```ts
    const back = reduceStore(s, answer(googleAnswer()));
    assert(homeNotices(back).reconnect === null, 'the banner outlived an ok answer');
  });
```
After:
```ts
    const back = reduceStore(s, answer(googleAnswer()));
    assert(homeNotices(back).reconnect === 'scopes', 'a later ok answer (a cache hit) took the banner away');
  });
```

**6.** In `scripts/smoke-calendar-agenda.ts`, lines 514-517: the check that the Reconnect banner and the unavailable calendars hold for the epoch goes after the partial-answer check. Before:
```ts
    assert(buildAgenda(reduceStore(s, answer(googleAnswer())))?.partial === false, 'partial after a whole answer');
  });

  await check('agendaWeekWindow: week 0 is the route\'s no-dates window, each later week the next 7 days', () => {
```
After:
```ts
    assert(buildAgenda(reduceStore(s, answer(googleAnswer())))?.partial === false, 'partial after a whole answer');
  });

  await check('the Reconnect banner and the unavailable calendars hold for the whole epoch, so a row above the Month never comes and goes with each month\'s answer (iOS has no scroll anchoring): ok, reconnect, ok keep reconnect at "token"; a calendar once listed unavailable stays counted; a store drop clears both', () => {
    const GONE = { id: 'gone@group.calendar.google.com', source: 'google' as const, name: 'Old', color: null, mine: true };
    const legend = (gone: boolean, more: RangeResponse['calendars'] = []) => [
      { id: FAMILY_G.id, source: 'google' as const, name: 'Family', color: null, mine: true },
      { ...GONE, unavailable: gone },
      ...more,
    ];
    // A dead token: a window with a cache entry answers ok, one without answers reconnect.
    let s = run([answer(googleAnswer())]);
    assertJson(homeNotices(s), { reconnect: null, unavailableCalendars: 0 }, 'the first answer, a cache hit');
    s = reduceStore(s, answer(googleAnswer({ from: '2026-11-01', to: '2026-12-01', sources: { google: { status: 'reconnect', reason: 'token' } }, calendars: [] })));
    assertJson(homeNotices(s), { reconnect: 'token', unavailableCalendars: 0 }, 'November, no cache entry');
    s = reduceStore(s, answer(googleAnswer({ from: '2026-12-01', to: '2027-01-01' })));
    assertJson(homeNotices(s), { reconnect: 'token', unavailableCalendars: 0 }, 'December, a cache hit');
    // A chosen calendar gone: listed unavailable in one month's answer, not in an older cache entry's.
    s = reduceStore(s, answer(googleAnswer({ from: '2027-02-01', to: '2027-03-01', calendars: legend(true) })));
    assertJson(homeNotices(s), { reconnect: 'token', unavailableCalendars: 1 }, 'February');
    s = reduceStore(s, answer(googleAnswer({ from: '2027-03-01', to: '2027-04-01', calendars: legend(false) })));
    assertJson(homeNotices(s), { reconnect: 'token', unavailableCalendars: 1 }, 'March, from an older cache entry');
    s = reduceStore(s, answer(googleAnswer({ from: '2027-04-01', to: '2027-05-01', calendars: legend(true, [{ id: 'x@group.calendar.google.com', source: 'google', name: 'X', color: null, mine: true, unavailable: true }]) })));
    assertJson(homeNotices(s), { reconnect: 'token', unavailableCalendars: 2 }, 'April, a second one gone');
    assert(buildAgenda(s)?.unavailableCalendars === 2, `the Agenda's row: ${buildAgenda(s)?.unavailableCalendars}`);
    s = reduceStore(s, { type: 'reset' });
    assertJson(homeNotices(s), { reconnect: null, unavailableCalendars: 0 }, 'after the midnight drop');
    s = reduceStore(s, answer(googleAnswer(), 1));
    assertJson(homeNotices(s), { reconnect: null, unavailableCalendars: 0 }, 'the new epoch\'s first answer');
  });

  await check('agendaWeekWindow: week 0 is the route\'s no-dates window, each later week the next 7 days', () => {
```

- [ ] **Step 2: Write the failing smoke `scripts/smoke-calendar-loader.ts`**

A fake host on the real reducer, a fake fetch whose answers each check hands out one at a time, and a fake timer. The month windows are written out by hand, with no E2 import. The last check is D's host: it passes on D's loader too, which shows E3 changes nothing D sends. The sixth (review patch) moves the wanted months on before the follow-ups fall due.

Create `scripts/smoke-calendar-loader.ts` with exactly this content:

```ts
// Smoke test for the calendar home's loader (src/lib/calendar-view/home-loader.ts; spec
// §5 "Month windows", Plan E Ruling 7): which range requests go out, and when.
//
// The Month asks each month's own days, [1st, 1st of the next month) (R12), for the
// months on screen or next to it (the host's getMonths(), most wanted first). At most
// MONTH_INFLIGHT_MAX month requests are in flight; every send for a month window counts
// (the first ask, a refetch, Retry, and the stale and error follow-ups), and the
// Agenda's weeks never do. A queued month that is no longer wanted when a slot frees is
// dropped, never marked asked, so it is asked again once it comes back; a month's stale
// or error follow-up that falls due once it is no longer wanted is dropped. A window is
// keyed by both its ends, so on the 1st of a month the Agenda's week 0 and that month
// don't collide. refetchVisible() asks the Agenda's weeks only while agendaShowing().
// An older epoch's 429 or 500 after a reset changes nothing (no state row, no card).
// D's host, which has no getMonths, sends exactly what it sent before.
//
// A fake host on the real reducer (D3's reduceStore), a fake fetch whose answers the
// checks hand out one by one, and a fake timer. No network, no React.
//
// Run with the fake env from the plan, under three clocks (the output must not depend
// on the process timezone):
//   TZ=UTC npx tsx scripts/smoke-calendar-loader.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-calendar-loader.ts
//   TZ=Pacific/Kiritimati npx tsx scripts/smoke-calendar-loader.ts

import {
  ERROR_RETRY_MS,
  MONTH_INFLIGHT_MAX,
  RANGE_TIMEOUT_MS,
  STALE_RETRY_MS,
  createHomeLoader,
  type HomeLoader,
  type LoaderHost,
} from '../src/lib/calendar-view/home-loader';
import { dayStatus, emptyStore, reduceStore, type CalendarStore } from '../src/lib/calendar-view/store';
import type { RangeWindow } from '../src/lib/calendar-view/home-client';
import type { DayKey, RangeResponse, SourceName } from '../src/lib/calendar-view/types';

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

const show = (value: unknown) => JSON.stringify(value);

function assertSame(got: unknown, want: unknown, label: string) {
  assert(show(got) === show(want), `${label}\n     got  ${show(got)}\n     want ${show(want)}`);
}

// ---- Fixtures: Thursday 15 October 2026 in Israel ----

const IL = 'Asia/Jerusalem';
const TODAY: DayKey = '2026-10-15';
const USER_ID = 5550001;
/** The fixtures' own day arithmetic (UTC), so the checks never lean on the code under test. */
const plusDays = (key: DayKey, n: number): DayKey => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const month = (from: DayKey, to: DayKey): RangeWindow => ({ from, to });
const SEP = month('2026-09-01', '2026-10-01');
const OCT = month('2026-10-01', '2026-11-01');
const NOV = month('2026-11-01', '2026-12-01');
const DEC = month('2026-12-01', '2027-01-01');

// ---- A fake fetch: every range call waits until a check answers it ----

type Reply = { status: number; body?: unknown } | 'throw';
interface Call {
  url: string;
  source: string;
  from: string | null;
  to: string | null;
  fresh: boolean;
  settled: boolean;
  reply: (r: Reply) => void;
}
const calls: Call[] = [];

globalThis.fetch = ((input: unknown) => {
  const url = String(input);
  const q = new URL(url, 'https://famcal.test').searchParams;
  return new Promise((resolve, reject) => {
    const call: Call = {
      url,
      source: q.get('sources') ?? '',
      from: q.get('from'),
      to: q.get('to'),
      fresh: q.get('fresh') === '1',
      settled: false,
      reply: (r) => {
        assert(!call.settled, `${describe(call)} answered twice`);
        call.settled = true;
        if (r === 'throw') reject(new TypeError('Failed to fetch (smoke)'));
        else resolve({ status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => r.body } as Response);
      },
    };
    calls.push(call);
  });
}) as typeof fetch;

/** A call as "<source> <from>..<to>[ fresh]", or "<source> default" with no dates. */
const describe = (c: Call) => `${c.source} ${c.from ? `${c.from}..${c.to}` : 'default'}${c.fresh ? ' fresh' : ''}`;
const sent = (since = 0) => calls.slice(since).map(describe);
const isMonth = (c: Call) => c.from !== null && c.from.endsWith('-01') && c.to !== null && c.to.endsWith('-01');
const monthsInFlight = () => calls.filter((c) => isMonth(c) && !c.settled).length;
/** The one call still waiting that `describe` names. */
function pending(what: string): Call {
  const found = calls.filter((c) => !c.settled && describe(c) === what);
  assert(found.length === 1, `${found.length} calls waiting for ${show(what)}; sent ${show(sent())}`);
  return found[0];
}

/** Lets fetchRange's promise chain and the loader's handlers run. */
async function flush() {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** An answer for a call's own window (the no-dates one is [today, today+7)), every day listed, nothing on them. */
function answerFor(
  c: Call,
  o: { today?: DayKey; sources?: readonly SourceName[]; status?: RangeResponse['sources'] } = {},
): Reply {
  const today = o.today ?? TODAY;
  const from = c.from ?? today;
  const to = c.to ?? plusDays(today, 7);
  const days: RangeResponse['days'] = [];
  for (let d = from; d < to; d = plusDays(d, 1)) days.push({ date: d, items: [] });
  const sources: RangeResponse['sources'] = {};
  for (const s of o.sources ?? [c.source as SourceName]) sources[s] = s === c.source ? { status: 'ok' } : { status: 'pending' };
  const body: RangeResponse = {
    tz: IL,
    today,
    weekStart: 0,
    hebrewDates: true,
    from,
    to,
    sources: { ...sources, ...o.status },
    partner: null,
    calendars: [],
    days,
  };
  return { status: 200, body };
}

async function answer(what: string, o: Parameters<typeof answerFor>[1] = {}) {
  const c = pending(what);
  c.reply(answerFor(c, o));
  await flush();
}

async function fail(what: string, reply: Reply) {
  pending(what).reply(reply);
  await flush();
}

// ---- A fake host on the real reducer, with a fake timer ----

interface HostOptions {
  sources?: SourceName[];
  /** The Month windows wanted now; null leaves getMonths out (D's host). */
  months?: RangeWindow[] | null;
  /** agendaShowing()'s answer; null leaves the method out (D's host). */
  agenda?: boolean | null;
  weeks?: number;
}

function fakeHost(o: HostOptions = {}) {
  let now = 0;
  let seq = 0;
  const timers: { id: number; at: number; run: () => void }[] = [];
  const state = {
    store: emptyStore() as CalendarStore,
    weeks: o.weeks ?? 1,
    months: o.months ?? [],
    agenda: o.agenda ?? true,
    blocked: false,
    firstFailed: null as 'busy' | 'error' | null,
    /** What the loader did to the host: dispatches and callbacks, in order. */
    log: [] as string[],
  };
  const host: LoaderHost = {
    userId: USER_ID,
    sources: o.sources ?? ['famcal'],
    getStore: () => state.store,
    getWeeks: () => state.weeks,
    dispatch: (a) => {
      state.store = reduceStore(state.store, a);
      if (a.type === 'response') state.log.push(`response ${a.response.from}..${a.response.to} @${a.epoch}`);
      else if (a.type === 'windowFailed') state.log.push(`windowFailed ${a.from}..${a.to} ${a.kind} @${a.epoch}`);
      else state.log.push('reset');
    },
    isBlocked: () => state.blocked,
    firstLoadFailed: () => state.firstFailed !== null,
    onAnswer: () => {
      state.firstFailed = null;
    },
    onFirstLoadFailed: (kind) => {
      state.firstFailed = kind;
      state.log.push(`firstLoadFailed ${kind}`);
    },
    onNoCredential: () => state.log.push('noCredential'),
    onNotEnabled: () => state.log.push('notEnabled'),
    setTimer: (run, ms) => {
      const id = ++seq;
      timers.push({ id, at: now + ms, run });
      return () => {
        const i = timers.findIndex((t) => t.id === id);
        if (i >= 0) timers.splice(i, 1);
      };
    },
  };
  if (o.months !== null) host.getMonths = () => state.months;
  if (o.agenda !== null) host.agendaShowing = () => state.agenda;
  const loader: HomeLoader = createHomeLoader(host);
  return {
    state,
    host,
    loader,
    /** Moves the clock on, running each timer that falls due, in order. */
    advance: async (ms: number) => {
      const end = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at || a.id - b.id);
        const next = timers[0];
        if (!next || next.at > end) break;
        timers.shift();
        now = next.at;
        next.run();
        await flush();
      }
      now = end;
    },
    /** The first load: ensure(), then its no-dates request answered, so the facts are pinned. */
    firstLoad: async (o2: Parameters<typeof answerFor>[1] = {}) => {
      loader.ensure();
      for (const s of host.sources) await answer(`${s} default`, { sources: host.sources, ...o2 });
      assert(state.store.facts !== null, 'the first answer pinned no facts');
    },
  };
}

/** A fresh slate for a check: no calls from the last one. */
function reset() {
  for (const c of calls) if (!c.settled) c.settled = true; // the last check's leftovers never answer
  calls.length = 0;
}

async function main() {
  await check('at most 2 month requests are in flight (MONTH_INFLIGHT_MAX); the rest wait, and when a slot frees the most wanted goes; the Agenda\'s weeks never wait', async () => {
    reset();
    assert(MONTH_INFLIGHT_MAX === 2, `MONTH_INFLIGHT_MAX is ${MONTH_INFLIGHT_MAX}`);
    const h = fakeHost({ months: [OCT, NOV, SEP, DEC] });
    await h.firstLoad();
    const start = calls.length;
    h.loader.ensure();
    assertSame(sent(start), ['famcal 2026-10-01..2026-11-01', 'famcal 2026-11-01..2026-12-01'], 'the two most wanted');
    h.state.weeks = 3;
    h.loader.ensure();
    assertSame(sent(start), ['famcal 2026-10-01..2026-11-01', 'famcal 2026-11-01..2026-12-01', 'famcal 2026-10-22..2026-10-29', 'famcal 2026-10-29..2026-11-05'], 'weeks 1 and 2 go at once');
    // The user scrolls down: December is wanted before September now.
    h.state.months = [OCT, NOV, DEC, SEP];
    await answer('famcal 2026-10-01..2026-11-01');
    assertSame(sent(start + 4), ['famcal 2026-12-01..2027-01-01'], 'October answered: December goes');
    assert(monthsInFlight() === 2, `${monthsInFlight()} months in flight`);
    await answer('famcal 2026-11-01..2026-12-01');
    assertSame(sent(start + 4), ['famcal 2026-12-01..2027-01-01', 'famcal 2026-09-01..2026-10-01'], 'November answered: September goes');
    await answer('famcal 2026-12-01..2027-01-01');
    await answer('famcal 2026-09-01..2026-10-01');
    assert(calls.length === start + 6, `nothing more: ${show(sent(start))}`);
    assert(dayStatus(h.state.store, '2026-09-01') === 'answered' && dayStatus(h.state.store, '2026-12-31') === 'answered', 'the months are in the store');
  });

  await check('a queued month that is no longer wanted when a slot frees is dropped, never sent, and not marked asked: it is asked once it is wanted again', async () => {
    reset();
    const h = fakeHost({ months: [OCT, NOV, SEP] });
    await h.firstLoad();
    const start = calls.length;
    h.loader.ensure();
    assertSame(sent(start), ['famcal 2026-10-01..2026-11-01', 'famcal 2026-11-01..2026-12-01'], 'September waits');
    h.state.months = [OCT, NOV]; // scrolled away from September
    await answer('famcal 2026-10-01..2026-11-01');
    await answer('famcal 2026-11-01..2026-12-01');
    assertSame(sent(start), ['famcal 2026-10-01..2026-11-01', 'famcal 2026-11-01..2026-12-01'], 'September was never sent');
    h.state.months = [SEP, OCT, NOV];
    h.loader.ensure();
    assertSame(sent(start + 2), ['famcal 2026-09-01..2026-10-01'], 'back in view: asked now');
  });

  await check('months are deduped per epoch, source and window: two ensure()s send one request per month and source, and an answered month is not asked again', async () => {
    reset();
    const h = fakeHost({ months: [OCT, NOV, SEP] });
    await h.firstLoad();
    const start = calls.length;
    h.loader.ensure();
    h.loader.ensure();
    assertSame(sent(start), ['famcal 2026-10-01..2026-11-01', 'famcal 2026-11-01..2026-12-01'], 'two ensure()s in flight');
    await answer('famcal 2026-10-01..2026-11-01'); // September takes the slot
    h.loader.ensure();
    await answer('famcal 2026-09-01..2026-10-01');
    h.loader.ensure();
    await answer('famcal 2026-11-01..2026-12-01'); // a slot frees with nothing left to ask
    h.loader.ensure();
    h.loader.ensure();
    assertSame(sent(start), ['famcal 2026-10-01..2026-11-01', 'famcal 2026-11-01..2026-12-01', 'famcal 2026-09-01..2026-10-01'], 'each month once');
    // Two sources (the store is ready for "Google becomes a connection"): one request per month
    // and source, and both count towards the cap.
    reset();
    const both = fakeHost({ sources: ['famcal', 'google'], months: [OCT, NOV] });
    await both.firstLoad();
    assertSame(both.state.store.facts?.sources, ['famcal', 'google'], 'both sources apply');
    const from = calls.length;
    both.loader.ensure();
    both.loader.ensure();
    assertSame(sent(from), ['famcal 2026-10-01..2026-11-01', 'google 2026-10-01..2026-11-01'], 'October for each source, November waits');
    await answer('famcal 2026-10-01..2026-11-01', { sources: ['famcal', 'google'] });
    await answer('google 2026-10-01..2026-11-01', { sources: ['famcal', 'google'] });
    assertSame(sent(from + 2), ['famcal 2026-11-01..2026-12-01', 'google 2026-11-01..2026-12-01'], 'then November for each');
  });

  await check('a window is keyed by both its ends: on the 1st, the Agenda\'s week 0 [1st, 8th) and the month [1st, 1st of next month) never collide', async () => {
    reset();
    const h = fakeHost({ months: [] });
    await h.firstLoad({ today: '2026-11-01' });
    const start = calls.length;
    h.loader.refetchVisible(); // week 0, asked with its dates, on the Agenda
    await answer('famcal 2026-11-01..2026-11-08', { today: '2026-11-01' });
    h.state.months = [NOV]; // the Month tab opens on November
    h.loader.ensure();
    assertSame(sent(start), ['famcal 2026-11-01..2026-11-08', 'famcal 2026-11-01..2026-12-01'], 'November is asked although week 0 was');
    await answer('famcal 2026-11-01..2026-12-01', { today: '2026-11-01' });
    // One refetch asks both at once: neither is deduped behind the other.
    h.loader.refetchVisible();
    assertSame(sent(start + 2), ['famcal 2026-11-01..2026-11-08', 'famcal 2026-11-01..2026-12-01'], 'a refetch asks both');
  });

  await check('the stale and the error follow-ups of a month go through the cap: they wait while 2 months are in flight, and go when a slot frees', async () => {
    reset();
    const h = fakeHost({ sources: ['google'], months: [OCT, NOV, SEP] });
    await h.firstLoad();
    const start = calls.length;
    h.loader.ensure();
    await answer('google 2026-10-01..2026-11-01', { status: { google: { status: 'ok', stale: true } } });
    assertSame(sent(start), ['google 2026-10-01..2026-11-01', 'google 2026-11-01..2026-12-01', 'google 2026-09-01..2026-10-01'], 'September took October\'s slot');
    await h.advance(STALE_RETRY_MS);
    assert(calls.length === start + 3 && monthsInFlight() === 2, `the stale re-request waits: ${show(sent(start))}`);
    await answer('google 2026-11-01..2026-12-01', { status: { google: { status: 'error', reason: 'transient' } } });
    assertSame(sent(start + 3), ['google 2026-10-01..2026-11-01'], 'November answered: October\'s stale re-request goes');
    await h.advance(ERROR_RETRY_MS);
    assert(calls.length === start + 4 && monthsInFlight() === 2, `the error retry waits: ${show(sent(start))}`);
    await answer('google 2026-09-01..2026-10-01');
    assertSame(sent(start + 4), ['google 2026-11-01..2026-12-01'], 'September answered: November\'s retry goes');
    await answer('google 2026-10-01..2026-11-01', { status: { google: { status: 'ok', stale: true } } });
    await answer('google 2026-11-01..2026-12-01', { status: { google: { status: 'error', reason: 'transient' } } });
    await h.advance(ERROR_RETRY_MS);
    assert(calls.length === start + 5, `each follow-up once: ${show(sent(start))}`);
  });

  await check('a month\'s stale or error follow-up that falls due once the month is no longer wanted is dropped, even with both slots free: the months a fast scroll passed are not asked again; one still wanted goes', async () => {
    reset();
    const h = fakeHost({ sources: ['google'], months: [OCT, NOV] });
    await h.firstLoad();
    const start = calls.length;
    h.loader.ensure();
    await answer('google 2026-10-01..2026-11-01', { status: { google: { status: 'ok', stale: true } } });
    await answer('google 2026-11-01..2026-12-01', { status: { google: { status: 'error', reason: 'transient' } } });
    const MAR = month('2027-03-01', '2027-04-01');
    const APR = month('2027-04-01', '2027-05-01');
    h.state.months = [MAR, APR]; // the user flung on to March
    await h.advance(ERROR_RETRY_MS);
    assert(monthsInFlight() === 0, `${monthsInFlight()} months in flight`);
    assertSame(sent(start + 2), [], 'October\'s stale re-request and November\'s error retry, with both slots free');
    h.loader.ensure();
    assertSame(sent(start + 2), ['google 2027-03-01..2027-04-01', 'google 2027-04-01..2027-05-01'], 'March and April');
    await answer('google 2027-03-01..2027-04-01', { status: { google: { status: 'ok', stale: true } } });
    await answer('google 2027-04-01..2027-05-01');
    await h.advance(STALE_RETRY_MS);
    assertSame(sent(start + 4), ['google 2027-03-01..2027-04-01'], 'March, still wanted: its stale re-request goes');
  });

  await check('a month request that never settles frees its slot at the time limit (about 15 s), and the next month goes', async () => {
    reset();
    const h = fakeHost({ months: [OCT, NOV, SEP] });
    await h.firstLoad();
    const start = calls.length;
    h.loader.ensure();
    await h.advance(RANGE_TIMEOUT_MS - 1);
    assert(calls.length === start + 2, `before the limit: ${show(sent(start))}`);
    await h.advance(1);
    assertSame(sent(start + 2), ['famcal 2026-09-01..2026-10-01'], 'past the limit');
    assert(h.state.log.includes('windowFailed 2026-10-01..2026-11-01 error @0'), `log ${show(h.state.log)}`);
  });

  await check('refetchVisible() asks the Agenda\'s weeks only while agendaShowing() (absent = true), and the wanted months always, fresh=1 included', async () => {
    reset();
    const h = fakeHost({ months: [OCT, NOV], agenda: false });
    await h.firstLoad();
    h.loader.ensure();
    await answer('famcal 2026-10-01..2026-11-01');
    await answer('famcal 2026-11-01..2026-12-01');
    let start = calls.length;
    h.loader.refetchVisible();
    assertSame(sent(start), ['famcal 2026-10-01..2026-11-01', 'famcal 2026-11-01..2026-12-01'], 'on the Month: the months only');
    await answer('famcal 2026-10-01..2026-11-01');
    await answer('famcal 2026-11-01..2026-12-01');
    start = calls.length;
    h.loader.refetchVisible({ fresh: true });
    assertSame(sent(start), ['famcal 2026-10-01..2026-11-01 fresh', 'famcal 2026-11-01..2026-12-01 fresh'], 'Refresh on the Month');
    await answer('famcal 2026-10-01..2026-11-01 fresh');
    await answer('famcal 2026-11-01..2026-12-01 fresh');
    h.state.agenda = true;
    h.state.months = [];
    start = calls.length;
    h.loader.refetchVisible();
    assertSame(sent(start), ['famcal 2026-10-15..2026-10-22'], 'on the Agenda: its weeks only');
    reset();
    const d = fakeHost({ months: [OCT], agenda: null });
    await d.firstLoad();
    start = calls.length;
    d.loader.refetchVisible();
    assertSame(sent(start), ['famcal 2026-10-15..2026-10-22', 'famcal 2026-10-01..2026-11-01'], 'no agendaShowing: the weeks, then the months');
  });

  await check('retryWindow() asks a window again for each applicable source (or `only`), through the cap', async () => {
    reset();
    const h = fakeHost({ months: [OCT, NOV, SEP] });
    await h.firstLoad();
    h.loader.ensure();
    await fail('famcal 2026-10-01..2026-11-01', { status: 429, body: {} });
    await answer('famcal 2026-11-01..2026-12-01');
    await answer('famcal 2026-09-01..2026-10-01');
    assert(dayStatus(h.state.store, '2026-10-05') === 'failed', `5 October is ${dayStatus(h.state.store, '2026-10-05')}`);
    let start = calls.length;
    h.loader.ensure();
    assert(calls.length === start, `ensure() asks a failed month again: ${show(sent(start))}`);
    h.loader.retryWindow(OCT, 'google');
    assert(calls.length === start, `only: google on a FamCal user: ${show(sent(start))}`);
    h.loader.retryWindow(OCT);
    assertSame(sent(start), ['famcal 2026-10-01..2026-11-01'], 'Retry');
    await answer('famcal 2026-10-01..2026-11-01');
    assert(dayStatus(h.state.store, '2026-10-05') === 'answered', `after Retry, 5 October is ${dayStatus(h.state.store, '2026-10-05')}`);
    // Through the cap: with two months in flight, a third Retry waits for a slot.
    start = calls.length;
    h.loader.retryWindow(NOV);
    h.loader.retryWindow(SEP);
    h.loader.retryWindow(OCT);
    assertSame(sent(start), ['famcal 2026-11-01..2026-12-01', 'famcal 2026-09-01..2026-10-01'], 'October\'s Retry waits');
    await answer('famcal 2026-11-01..2026-12-01');
    assertSame(sent(start + 2), ['famcal 2026-10-01..2026-11-01'], 'then goes');
  });

  await check('an older epoch\'s 500 or 429 after a reset dispatches nothing and never calls onFirstLoadFailed, and its queued months are dropped; the new epoch\'s own failure still shows the card', async () => {
    for (const reply of [{ status: 500, body: { error: 'internal_error' } }, { status: 429, body: {} }, 'throw'] as Reply[]) {
      reset();
      const h = fakeHost({ months: [OCT, NOV, SEP] });
      await h.firstLoad();
      h.loader.ensure(); // October and November in flight, September queued, under epoch 0
      h.loader.refetchVisible(); // week 0 again, under epoch 0
      h.state.store = reduceStore(h.state.store, { type: 'reset' }); // midnight
      h.loader.ensure();
      const start = calls.length;
      assertSame(sent(start - 1), ['famcal default'], `${show(reply)}: the new epoch's first load`);
      const before = h.state.log.length;
      await fail('famcal 2026-10-15..2026-10-22', reply);
      assertSame(h.state.log.slice(before), [], `${show(reply)}: the old epoch's week 0`);
      await fail('famcal 2026-10-01..2026-11-01', reply);
      assertSame(h.state.log.slice(before), [], `${show(reply)}: the old epoch's October`);
      assert(h.state.firstFailed === null, `${show(reply)}: the card is up (${h.state.firstFailed})`);
      assertSame(sent(start), [], `${show(reply)}: September, queued under epoch 0, was sent`);
      await fail('famcal default', reply);
      assertSame(h.state.log.slice(before), [`firstLoadFailed ${reply !== 'throw' && reply.status === 429 ? 'busy' : 'error'}`], `${show(reply)}: the new epoch's own failure`);
    }
  });

  await check('dispose() drops the queue and the timers: nothing more is sent or dispatched', async () => {
    reset();
    const h = fakeHost({ sources: ['google'], months: [OCT, NOV, SEP] });
    await h.firstLoad({ status: { google: { status: 'ok', stale: true } } });
    h.loader.ensure();
    const start = calls.length;
    const before = h.state.log.length;
    h.loader.dispose();
    await answer('google 2026-10-01..2026-11-01');
    await answer('google 2026-11-01..2026-12-01');
    await h.advance(RANGE_TIMEOUT_MS + STALE_RETRY_MS + ERROR_RETRY_MS);
    h.loader.ensure();
    h.loader.refetchVisible();
    h.loader.retryWindow(SEP);
    assert(calls.length === start, `sent after dispose: ${show(sent(start))}`);
    assertSame(h.state.log.slice(before), [], 'dispatched after dispose');
  });

  await check('D\'s host (no getMonths, no agendaShowing) sends exactly what it sent before: the same URLs, in the same order', async () => {
    reset();
    const famcal = fakeHost({ months: null, agenda: null });
    assert(famcal.host.getMonths === undefined && famcal.host.agendaShowing === undefined, 'the host has the new methods');
    famcal.loader.ensure();
    famcal.loader.ensure();
    await answer('famcal default');
    famcal.loader.ensure();
    famcal.state.weeks = 2;
    famcal.loader.ensure();
    await answer('famcal 2026-10-22..2026-10-29');
    famcal.loader.refetchVisible();
    famcal.loader.refetchVisible();
    famcal.loader.refetchVisible({ fresh: true });
    famcal.loader.refetchVisible({ only: 'google' });
    const google = fakeHost({ sources: ['google'], months: null, agenda: null });
    google.loader.ensure();
    await answer('google default', { status: { google: { status: 'ok', stale: true } } });
    await google.advance(STALE_RETRY_MS);
    await answer('google 2026-10-15..2026-10-22', { status: { google: { status: 'error', reason: 'timeout' } } });
    await google.advance(ERROR_RETRY_MS);
    await answer('google 2026-10-15..2026-10-22', { status: { google: { status: 'error', reason: 'timeout' } } });
    await google.advance(ERROR_RETRY_MS);
    const base = '/api/calendar/range?user_id=5550001';
    assertSame(calls.map((c) => c.url), [
      `${base}&sources=famcal`,
      `${base}&sources=famcal&from=2026-10-22&to=2026-10-29`,
      `${base}&sources=famcal&from=2026-10-15&to=2026-10-22`,
      `${base}&sources=famcal&from=2026-10-22&to=2026-10-29`,
      `${base}&sources=famcal&from=2026-10-15&to=2026-10-22&fresh=1`,
      `${base}&sources=famcal&from=2026-10-22&to=2026-10-29&fresh=1`,
      `${base}&sources=google`,
      `${base}&sources=google&from=2026-10-15&to=2026-10-22`,
      `${base}&sources=google&from=2026-10-15&to=2026-10-22`,
    ], 'the URLs');
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 3: Add the failing check #42 to `scripts/smoke-calendar-home-render.ts`**

#42 comes after #41, so #41's "no React warning" doesn't cover it, and #42 checks its own warnings. E8's #43 on come after it the same way. Two edits, in this order; line numbers are the file's before the first edit.

**1.** In `scripts/smoke-calendar-home-render.ts`, lines 49-52: the header names #42. Before:
```ts
// that rejects with a ChunkLoadError, as after a deploy, reloads once behind the loader;
// within the guard, or for any other error, the gate's error card.
// React must log no warning. No network, no DB, no Redis.
//
```
After:
```ts
// that rejects with a ChunkLoadError, as after a deploy, reloads once behind the loader;
// within the guard, or for any other error, the gate's error card.
//
// The midnight reset with a refetch in flight (Plan E, Task E3, #42): when that refetch
// fails after the reset, no retry card flashes before the new day's answer.
//
// React must log no warning. No network, no DB, no Redis.
//
```

**2.** In `scripts/smoke-calendar-home-render.ts`, lines 2247-2250: #42 goes after #41, before the results are printed. Before:
```ts
  });

  let failed = 0;
  for (const r of results) {
```
After:
```ts
  });

  await check('#42 the midnight reset with a refetch in flight that then fails (500): no retry card, only the placeholders until the new day\'s answer, which then shows; React logs no warning', async () => {
    resetHome();
    const warned = reactWarnings.length;
    const clock = fakeClock('2026-10-15T20:59:30Z'); // 23:59:30 in Israel, Thursday 15 October
    answerFetch = () => ok200(answer({ items: WEEK }));
    const m = await mountHome('en', {}, clock);
    try {
      await clock.advance(25_000); // 23:59:55: the day check is still 5.5 s away
      let failOld: (a: FetchAnswer) => void = noop;
      answerFetch = () => new Promise<FetchAnswer>((resolve) => (failOld = resolve));
      fireDocument('visibilitychange');
      await settle();
      assert(show(ranges()) === show(['famcal default', `famcal ${day(0)}→${day(7)}`]), `the refetch is in flight: ${show(ranges())}`);
      let answerNew: (a: FetchAnswer) => void = noop;
      answerFetch = () => new Promise<FetchAnswer>((resolve) => (answerNew = resolve));
      await clock.advance(6_000); // past midnight: the store starts over
      assert(show(ranges().slice(2)) === show(['famcal default']), `the new day's no-dates request: ${show(ranges())}`);
      await React.act(async () => failOld({ status: 500, body: { error: 'internal_error' } }));
      await settle();
      assertLacks(m.text(), ['Something went wrong', 'Retry'], 'the old refetch\'s 500');
      assertHas(m.text(), ['Loading your calendar…'], 'the placeholders until the new answer');
      await React.act(async () => answerNew(ok200(answer({ today: day(1), from: day(1), to: day(8), items: { [day(1)]: [GRANDMA] } }))));
      await settle();
      assert(m.html().includes('<h1 class="ch-head-title">Friday, 16 October</h1>'), `the header: ${m.text().slice(0, 80)}`);
      assertHas(m.text(), [`Today ${ref.dayShort('en-GB', day(1))}`, 'All day Grandma visits'], 'the new Today');
      assertLacks(m.text(), ['Something went wrong'], 'no card after the answer');
      assert(ranges().length === 3, `nothing more was asked: ${show(ranges())}`);
    } finally {
      m.unmount();
    }
    assert(reactWarnings.length === warned, `warnings: ${show(reactWarnings.slice(warned, warned + 5))}`);
  });

  let failed = 0;
  for (const r of results) {
```

- [ ] **Step 4: Write the failing smoke `scripts/smoke-timezone-inflight.ts`**

Create `scripts/smoke-timezone-inflight.ts` with exactly this content:

```ts
// Smoke test for the shared timezone lookup (resolveUserTimezone in src/lib/timezone.ts;
// Plan E, from Plan D's deferred list). The range route waits at most 2 s for a user's
// timezone, and the lookup carries on after that. The Month opens several windows at
// once, so without a shared lookup every further open started another Nominatim lookup
// for the same user. Now a lookup is shared per user (and location, and whether a
// Google token is there), on globalThis.__tzInflight: every caller within 1.5 s of its
// start gets its answer, a rejection reaches every one of them, and the entry goes when
// the lookup settles. A later caller starts its own, so a lookup stuck on a call with no
// time limit (a Redis read, Google's settings call) holds nobody after that. The map is
// on globalThis because Next 16 gives the scheduler and the routes separate module
// instances (two instances here share it).
//
// timezone.ts and REDIS_KEYS run for real. Faked: Redis (in memory, each read can be
// held), the geocoding module (geocodeLocation answers when a check releases it), the
// Google calendar service and error capture. No network, no DB.
//
// Run with the fake env from the plan:
//   TZ=UTC npx tsx scripts/smoke-timezone-inflight.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-timezone-inflight.ts

import path from 'path';
import { createRequire } from 'module';

type Row = Record<string, unknown>;
type Resolve = (user: { id: number; location?: string; googleRefreshToken?: string }) => Promise<string>;

const ROOT = path.resolve(__dirname, '..');
const TIMEZONE_TS = path.join(ROOT, 'src/lib/timezone.ts');
const nodeRequire = createRequire(__filename);

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

const show = (v: unknown) => JSON.stringify(v);

// ---- Fakes ----

/** Redis, in memory. While `holdReads` is set, each read waits for releaseReads(). */
const redisStore = new Map<string, unknown>();
let redisReads = 0;
let redisSets = 0;
let holdReads: { release: (error?: Error) => void; wait: Promise<void> } | null = null;
function holdRedisReads() {
  let release: (error?: Error) => void = () => {};
  const wait = new Promise<void>((resolve, reject) => {
    release = (error) => (error ? reject(error) : resolve());
  });
  wait.catch(() => undefined); // each read rethrows it below
  holdReads = { release, wait };
  return (error?: Error) => {
    holdReads = null;
    release(error);
  };
}
const fakeRedis = {
  get: async (key: string) => {
    redisReads++;
    if (holdReads) await holdReads.wait;
    return redisStore.has(key) ? redisStore.get(key) : null;
  },
  set: async (key: string, value: unknown) => {
    redisSets++;
    redisStore.set(key, value);
    return 'OK';
  },
};

/** geocodeLocation's calls, each waiting until the check answers it. */
type Geocode = { location: string; answer: (timezone: string) => void };
const geocodes: Geocode[] = [];
const fakeGeocoding = {
  geocodeLocation: (location: string) =>
    new Promise((resolve) => {
      geocodes.push({ location, answer: (timezone) => resolve({ latitude: 0, longitude: 0, timezone }) });
    }),
  fetchWithTimeout: async () => {
    throw new Error('the lookup asked the network');
  },
};

/** Every console line written while the checks ran. */
const consoleLines: string[] = [];

function installStubs() {
  const Module = nodeRequire('module');
  const stub = (rel: string, exports: Row) => {
    const filename = path.join(ROOT, rel);
    const mod = new Module(filename);
    Object.assign(mod, { filename, loaded: true, exports });
    Module._cache[filename] = mod;
  };
  stub('src/utils/redis.ts', { redis: fakeRedis });
  stub('src/services/weather/geocoding.ts', fakeGeocoding);
  stub('src/services/calendar.ts', { getUserCalendarTimezone: async () => null });
  stub('src/lib/error-capture.ts', { captureError: () => {}, captureWarning: () => {}, captureInfo: () => {} });
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    console[level] = (...args: unknown[]) => void consoleLines.push(args.map(String).join(' '));
  }
}

/** A fresh copy of src/lib/timezone.ts: its own module instance, as another Next bundle has. */
function loadTimezone(): Resolve {
  delete nodeRequire.cache[TIMEZONE_TS];
  return (nodeRequire(TIMEZONE_TS) as { resolveUserTimezone: Resolve }).resolveUserTimezone;
}

const inflight = () => (globalThis as { __tzInflight?: Map<string, unknown> }).__tzInflight;

async function flush() {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve));
}

function seed() {
  redisStore.clear();
  redisReads = 0;
  redisSets = 0;
  holdReads = null;
  geocodes.length = 0;
}

/** The one geocode call still waiting for `location`. */
function geocodeFor(location: string): Geocode {
  const found = geocodes.filter((g) => g.location === location);
  assert(found.length === 1, `${found.length} geocode calls for one of the fixtures' locations (of ${geocodes.length})`);
  return found[0];
}

async function main() {
  installStubs();
  const resolveUserTimezone = loadTimezone();

  await check('two calls for one user while the lookup is in flight make one Redis read and one geocode call, and both get its answer', async () => {
    seed();
    const a = resolveUserTimezone({ id: 7, location: 'London' });
    const b = resolveUserTimezone({ id: 7, location: 'London' });
    await flush();
    assert(geocodes.length === 1 && redisReads === 1, `${geocodes.length} geocode calls, ${redisReads} Redis reads`);
    assert(inflight()?.size === 1, `in flight: ${inflight()?.size}`);
    geocodeFor('London').answer('Europe/London');
    assert(show(await Promise.all([a, b])) === show(['Europe/London', 'Europe/London']), 'the answers');
    assert(redisSets === 1 && redisStore.get('tz:user:7') === 'Europe/London', `${redisSets} Redis writes`);
  });

  await check('once the lookup settles its entry is gone, and the next call looks up afresh', async () => {
    seed();
    const first = resolveUserTimezone({ id: 7, location: 'London' });
    await flush();
    geocodeFor('London').answer('Europe/London');
    await first;
    assert(inflight()?.size === 0, `entries left: ${inflight()?.size}`);
    redisStore.clear(); // the cached zone ran out
    const again = resolveUserTimezone({ id: 7, location: 'London' });
    await flush();
    assert(geocodes.length === 2 && redisReads === 2, `${geocodes.length} geocode calls, ${redisReads} Redis reads`);
    geocodes[1].answer('Europe/London');
    assert((await again) === 'Europe/London', 'the second answer');
    const cached = await resolveUserTimezone({ id: 7, location: 'London' });
    assert(cached === 'Europe/London' && geocodes.length === 2, `a cached zone: ${geocodes.length} geocode calls`);
    assert(inflight()?.size === 0, `entries left: ${inflight()?.size}`);
  });

  await check('a lookup that rejects (Redis down) rejects for every caller with the same error, and its entry goes', async () => {
    seed();
    const release = holdRedisReads();
    const a = resolveUserTimezone({ id: 7, location: 'London' });
    const b = resolveUserTimezone({ id: 7, location: 'London' });
    await flush();
    assert(redisReads === 1, `${redisReads} Redis reads`);
    const down = new Error('redis down');
    release(down);
    const outcomes = await Promise.allSettled([a, b]);
    assert(outcomes.every((o) => o.status === 'rejected' && o.reason === down), `outcomes: ${show(outcomes.map((o) => o.status))}`);
    assert(inflight()?.size === 0, `entries left: ${inflight()?.size}`);
    redisStore.set('tz:user:7', 'Europe/London');
    assert((await resolveUserTimezone({ id: 7, location: 'London' })) === 'Europe/London', 'the next call');
  });

  await check('another user, a changed location or a Google token (or none) make a lookup of their own; two token values share one', async () => {
    seed();
    const calls = [
      resolveUserTimezone({ id: 7, location: 'London' }),
      resolveUserTimezone({ id: 8, location: 'London' }),
      resolveUserTimezone({ id: 7, location: 'Paris' }),
      resolveUserTimezone({ id: 7, location: 'London', googleRefreshToken: 'token-a' }),
      resolveUserTimezone({ id: 7, location: 'London', googleRefreshToken: 'token-b' }),
    ];
    await flush();
    assert(geocodes.length === 4 && redisReads === 4 && inflight()?.size === 4, `${geocodes.length} geocode calls, ${redisReads} Redis reads, ${inflight()?.size} in flight`);
    const zones = ['Europe/London', 'Europe/Dublin', 'Europe/Paris', 'Europe/Lisbon'];
    geocodes.forEach((g, i) => g.answer(zones[i]));
    assert(show(await Promise.all(calls)) === show([...zones, 'Europe/Lisbon']), 'each caller got its own lookup\'s answer');
    assert(inflight()?.size === 0, `entries left: ${inflight()?.size}`);
  });

  await check('two module instances (the scheduler\'s and a route\'s) share the in-flight map', async () => {
    seed();
    const other = loadTimezone();
    assert(other !== resolveUserTimezone, 'the same module instance');
    const a = resolveUserTimezone({ id: 9, location: 'London' });
    const b = other({ id: 9, location: 'London' });
    await flush();
    assert(geocodes.length === 1 && redisReads === 1, `${geocodes.length} geocode calls, ${redisReads} Redis reads`);
    geocodeFor('London').answer('Europe/London');
    assert(show(await Promise.all([a, b])) === show(['Europe/London', 'Europe/London']), 'the answers');
    assert(inflight()?.size === 0, `entries left: ${inflight()?.size}`);
  });

  await check('a lookup stuck 1.5 s or more (a Redis read or a Google call that never answers) holds no later caller: a call within 1.5 s joins it, a later one makes a lookup of its own and gets its answer, and the stuck one settling meanwhile leaves the later one\'s entry alone', async () => {
    seed();
    // timezone.ts times its lookups with performance.now(): this check moves it by hand.
    const realNow = performance.now.bind(performance);
    let now = realNow();
    performance.now = () => now;
    try {
      const release = holdRedisReads();
      const stuck = resolveUserTimezone({ id: 7, location: 'London' });
      await flush();
      holdReads = null; // the reads after this one answer at once; the first stays stuck
      now += 1000;
      const joined = resolveUserTimezone({ id: 7, location: 'London' });
      await flush();
      const reads = () => redisReads;
      assert(reads() === 1 && inflight()?.size === 1, `a call 1 s in: ${reads()} Redis reads, ${inflight()?.size} in flight`);
      now += 500;
      const fresh = resolveUserTimezone({ id: 7, location: 'London' });
      await flush();
      assert(reads() === 2 && geocodes.length === 1, `a call 1.5 s in joined the stuck lookup: ${reads()} Redis reads, ${geocodes.length} geocode calls`);
      const late = new Error('the stuck read fails at last');
      release(late);
      const outcomes = await Promise.allSettled([stuck, joined]);
      assert(outcomes.every((o) => o.status === 'rejected' && o.reason === late), `the stuck lookup and the call that joined it: ${show(outcomes.map((o) => o.status))}`);
      assert(inflight()?.size === 1, `the stuck lookup took the later one's entry with it: ${inflight()?.size} in flight`);
      geocodeFor('London').answer('Europe/London');
      const answer = await Promise.race([fresh, new Promise((resolve) => setTimeout(() => resolve('no answer'), 200))]);
      assert(answer === 'Europe/London', `the call 1.5 s in: ${show(answer)}`);
      assert(inflight()?.size === 0, `entries left: ${inflight()?.size}`);
    } finally {
      performance.now = realNow;
    }
  });

  await check('the shared lookup prints nothing: no console line names a location', () => {
    const named = consoleLines.filter((l) => /London|Paris/.test(l)).length;
    assert(named === 0, `${named} console lines name a location`);
  });

  let failed = 0;
  for (const r of results) {
    process.stdout.write(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}\n`);
    if (!r.ok) failed++;
  }
  process.stdout.write(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
```

- [ ] **Step 5: Run the new checks and see them fail; record the regression smokes' baseline**

```bash
cd /Users/razielgershoni/development/famcalbot
for tz in UTC Asia/Jerusalem Pacific/Kiritimati; do for s in smoke-calendar-agenda smoke-calendar-loader smoke-calendar-home-render smoke-timezone-inflight; do TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/$s.ts 2>&1 | grep -E '^FAIL|passed' | sed 's/ — .*//'; echo "$s $tz exit=${pipestatus[1]}"; done; done
```
(Run it in zsh: `pipestatus` is zsh's. In bash, use `${PIPESTATUS[0]}`.)

Expected under `TZ=UTC`, and the same lines under the other two clocks with their names:
```
FAIL  a failed day keeps the failure that marked it (DayCoverage.failure, set exactly when failed); an ok answer clears it, and a failure over ok data marks nothing
FAIL  a newer failure replaces an older one on its own days only
FAIL  reconnect is never a state row: the banner (homeNotices) carries it, and only for Google users
FAIL  a busy week 1 keeps week 0's calendars-gone row: a state row gives the earliest shown failed day's reason, then lastFailure, then a generic error
FAIL  the Reconnect banner and the unavailable calendars hold for the whole epoch, so a row above the Month never comes and goes with each month's answer (iOS has no scroll anchoring): ok, reconnect, ok keep reconnect at "token"; a calendar once listed unavailable stays counted; a store drop clears both
32/37 passed (process TZ=UTC)
smoke-calendar-agenda UTC exit=1
FAIL  at most 2 month requests are in flight (MONTH_INFLIGHT_MAX); the rest wait, and when a slot frees the most wanted goes; the Agenda's weeks never wait
FAIL  a queued month that is no longer wanted when a slot frees is dropped, never sent, and not marked asked: it is asked once it is wanted again
FAIL  months are deduped per epoch, source and window: two ensure()s send one request per month and source, and an answered month is not asked again
FAIL  a window is keyed by both its ends: on the 1st, the Agenda's week 0 [1st, 8th) and the month [1st, 1st of next month) never collide
FAIL  the stale and the error follow-ups of a month go through the cap: they wait while 2 months are in flight, and go when a slot frees
FAIL  a month's stale or error follow-up that falls due once the month is no longer wanted is dropped, even with both slots free: the months a fast scroll passed are not asked again; one still wanted goes
FAIL  a month request that never settles frees its slot at the time limit (about 15 s), and the next month goes
FAIL  refetchVisible() asks the Agenda's weeks only while agendaShowing() (absent = true), and the wanted months always, fresh=1 included
FAIL  retryWindow() asks a window again for each applicable source (or `only`), through the cap
FAIL  an older epoch's 500 or 429 after a reset dispatches nothing and never calls onFirstLoadFailed, and its queued months are dropped; the new epoch's own failure still shows the card
FAIL  dispose() drops the queue and the timers: nothing more is sent or dispatched
1/12 passed (process TZ=UTC)
smoke-calendar-loader UTC exit=1
FAIL  #42 the midnight reset with a refetch in flight that then fails (500): no retry card, only the placeholders until the new day's answer, which then shows; React logs no warning
41/42 passed (process TZ=UTC)
smoke-calendar-home-render UTC exit=1
FAIL  two calls for one user while the lookup is in flight make one Redis read and one geocode call, and both get its answer
FAIL  once the lookup settles its entry is gone, and the next call looks up afresh
FAIL  a lookup that rejects (Redis down) rejects for every caller with the same error, and its entry goes
FAIL  another user, a changed location or a Google token (or none) make a lookup of their own; two token values share one
FAIL  two module instances (the scheduler's and a route's) share the in-flight map
FAIL  a lookup stuck 1.5 s or more (a Redis read or a Google call that never answers) holds no later caller: a call within 1.5 s joins it, a later one makes a lookup of its own and gets its answer, and the stuck one settling meanwhile leaves the later one's entry alone
1/7 passed (process TZ=UTC)
smoke-timezone-inflight UTC exit=1
```
Why each fails:
- **smoke-calendar-agenda:** a failed day's coverage has no `failure`, `dayFailure` doesn't exist ("is not a function"), and every state row reads `lastFailure`, so week 0's row says Busy. `homeNotices` reads the latest answer, so a later ok answer takes the Reconnect banner away (D's reconnect check, as edit 5 has it, and the new epoch check, at "December, a cache hit").
- **smoke-calendar-loader:** D's loader has no `MONTH_INFLIGHT_MAX` (undefined), never asks `getMonths()`, has no `retryWindow`, and calls `onFirstLoadFailed` for the old epoch's week 0. Only the check on D's host passes.
- **smoke-calendar-home-render #42:** the old refetch's 500 shows "Something went wrong … Retry".
- **smoke-timezone-inflight:** two calls make two Redis reads and two geocode calls, and `globalThis.__tzInflight` doesn't exist. Only the console check passes; the stuck-lookup check fails at its first count ("a call 1 s in: 2 Redis reads").

`npx tsc --noEmit -p .` also fails now. The new checks name `dayFailure`, `DayCoverage.failure`, `MONTH_INFLIGHT_MAX`, `getMonths`, `agendaShowing` and `retryWindow`, which Steps 6-8 add.

Then the regression smokes' baseline:
```bash
cd /Users/razielgershoni/development/famcalbot
for tz in UTC Asia/Jerusalem Pacific/Kiritimati; do TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-calendar-range.ts 2>&1 | grep -E '^FAIL|passed' | sed 's/ — .*//'; echo "smoke-calendar-range $tz exit=${pipestatus[1]}"; done
for tz in UTC Asia/Jerusalem; do for s in smoke-location-timezone smoke-reminders smoke-account-merge smoke-initdata-header smoke-auth-leftovers; do TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/$s.ts 2>&1 | grep -E '^FAIL|passed' | sed 's/ — .*//'; echo "$s $tz exit=${pipestatus[1]}"; done; done
```
Expected:
```
24/24 passed (process TZ=UTC)
smoke-calendar-range UTC exit=0
24/24 passed (process TZ=Asia/Jerusalem)
smoke-calendar-range Asia/Jerusalem exit=0
24/24 passed (process TZ=Pacific/Kiritimati)
smoke-calendar-range Pacific/Kiritimati exit=0
14/14 passed (process TZ=UTC)
smoke-location-timezone UTC exit=0
23/23 passed (process TZ=UTC)
smoke-reminders UTC exit=0
50/50 passed
smoke-account-merge UTC exit=0
9/9 passed
smoke-initdata-header UTC exit=0
9/9 passed
smoke-auth-leftovers UTC exit=0
14/14 passed (process TZ=Asia/Jerusalem)
smoke-location-timezone Asia/Jerusalem exit=0
23/23 passed (process TZ=Asia/Jerusalem)
smoke-reminders Asia/Jerusalem exit=0
50/50 passed
smoke-account-merge Asia/Jerusalem exit=0
9/9 passed
smoke-initdata-header Asia/Jerusalem exit=0
9/9 passed
smoke-auth-leftovers Asia/Jerusalem exit=0
```

- [ ] **Step 6: Keep each day's failure, and the epoch's banners, in `src/lib/calendar-view/store.ts`**

Eleven edits to `store.ts`, then two to `HomeBanners.tsx`'s comments, in this order. Line numbers are each file's before its first edit.

**1.** In `src/lib/calendar-view/store.ts`, lines 13-18: the header says each failed day keeps its failure, and that the epoch's banners hold. Before:
```ts
//   older epoch is kept only while its facts still match.
// - Each day remembers, per source, whether an ok answer covered it ("answered", spec
//   §5 "Empty means answered") and whether a failed one did. Only answered days may
//   read as empty.

import {
```
After:
```ts
//   older epoch is kept only while its facts still match.
// - Each day remembers, per source, whether an ok answer covered it ("answered", spec
//   §5 "Empty means answered") and whether a failed one did, with that failure: a state
//   row says why for its own days, whatever another window got later. Only answered
//   days may read as empty.
// - A Google reconnect, and the chosen calendars an ok answer lists as unavailable, hold
//   for the epoch: a later answer from Google's cache (ok with a dead token, or a legend
//   from before a calendar went) never takes the banner or the row away, so nothing above
//   the Month comes and goes as its months answer (Plan E, iOS has no scroll anchoring).

import {
```

**2.** In `src/lib/calendar-view/store.ts`, lines 52-55: `DayCoverage` gains `failure`. Before:
```ts
  /** The latest ok answer was partial (Google calendars that failed or were cut short). */
  partial: boolean;
}

```
After:
```ts
  /** The latest ok answer was partial (Google calendars that failed or were cut short). */
  partial: boolean;
  /** The failure that marked the day (set exactly when failed); null when ok or untouched. */
  failure: SourceFailure | null;
}

```

**3.** In `src/lib/calendar-view/store.ts`, lines 75-80: `lastFailure`'s comment (the field and its updates stay as they are), and after the legend the epoch's `reconnect` and `unavailable`. Before:
```ts
  /** Each source's status in the latest answer that asked for it (a `pending` one never overwrites it). */
  status: { famcal?: FamcalStatus; google?: GoogleStatus };
  /** Each source's latest failure, kept after a later ok answer for another window: the state row's copy. */
  lastFailure: Partial<Record<SourceName, SourceFailure>>;
  /** The legend from each source's latest ok answer, FamCal first. */
  calendars: CalendarDTO[];
```
After:
```ts
  /** Each source's status in the latest answer that asked for it (a `pending` one never overwrites it). */
  status: { famcal?: FamcalStatus; google?: GoogleStatus };
  /** Each source's latest failure, kept after a later ok answer for another window. A state row reads its day's own (dayFailure) first. */
  lastFailure: Partial<Record<SourceName, SourceFailure>>;
  /** The legend from each source's latest ok answer, FamCal first. */
  calendars: CalendarDTO[];
  /** Google asked for a reconnect in this epoch (the latest such answer's reason); null until it does. */
  reconnect: 'token' | 'scopes' | null;
  /** The ids of the Google calendars any ok answer in this epoch listed as unavailable, in the order first seen. */
  unavailable: string[];
```

**4.** In `src/lib/calendar-view/store.ts`, lines 103-108: `HomeNotices` says both hold for the epoch. Before:
```ts
export interface HomeNotices {
  /** Google asked for a reconnect in its latest answer. Never set for a FamCal user. */
  reconnect: 'token' | 'scopes' | null;
  /** Chosen Google calendars that are gone: "N calendars aren't available · Choose again". */
  unavailableCalendars: number;
}
```
After:
```ts
export interface HomeNotices {
  /** Google asked for a reconnect in this epoch: kept until the store drops. Never set for a FamCal user. */
  reconnect: 'token' | 'scopes' | null;
  /** Chosen Google calendars seen gone in this epoch: "N calendars aren't available · Choose again". */
  unavailableCalendars: number;
}
```

**5.** In `src/lib/calendar-view/store.ts`, lines 129-131: `emptyStore` starts with neither. Before:
```ts
export function emptyStore(epoch = 0): CalendarStore {
  return { epoch, facts: null, days: {}, status: {}, lastFailure: {}, calendars: [], partner: null, carryOvers: null };
}
```
After:
```ts
export function emptyStore(epoch = 0): CalendarStore {
  return { epoch, facts: null, days: {}, status: {}, lastFailure: {}, calendars: [], reconnect: null, unavailable: [], partner: null, carryOvers: null };
}
```

**6.** In `src/lib/calendar-view/store.ts`, lines 173-177: `failedCoverage` takes the failure. Before:
```ts
}

const failedCoverage = (): DayCoverage => ({ ok: false, failed: true, partial: false });

/** Merges an answer whose facts match `state.facts` (already pinned). */
```
After:
```ts
}

const failedCoverage = (failure: SourceFailure): DayCoverage => ({ ok: false, failed: true, partial: false, failure });

/** Merges an answer whose facts match `state.facts` (already pinned). */
```

**7.** In `src/lib/calendar-view/store.ts`, lines 216-223: `merge`: an ok source's days clear the failure, a failed source's days take its own. Before:
```ts
      const fresh = (incoming.get(date) ?? NO_ITEMS).filter((i) => ok.includes(i.source));
      items = dedupeSorted([...kept, ...fresh]);
      for (const s of ok) coverage[s] = { ok: true, failed: false, partial: s === 'google' && partial };
    }
    for (const f of failures) {
      if (!coverage[f.source]?.ok) coverage[f.source] = failedCoverage();
    }
    days[date] = { items, coverage };
```
After:
```ts
      const fresh = (incoming.get(date) ?? NO_ITEMS).filter((i) => ok.includes(i.source));
      items = dedupeSorted([...kept, ...fresh]);
      for (const s of ok) coverage[s] = { ok: true, failed: false, partial: s === 'google' && partial, failure: null };
    }
    for (const f of failures) {
      if (!coverage[f.source]?.ok) coverage[f.source] = failedCoverage(f);
    }
    days[date] = { items, coverage };
```

**8.** In `src/lib/calendar-view/store.ts`, lines 230-233: `merge` keeps the epoch's reconnect (the latest one's reason) and adds the calendars an ok Google answer lists as unavailable. Before:
```ts
  const partner = ok.includes('famcal') ? (r.partner ? { name: r.partner.name } : null) : state.partner;
  const carryOvers = r.carryOvers ? [...r.carryOvers] : state.carryOvers;
  return { ...state, days, status, lastFailure, calendars, partner, carryOvers };
}
```
After:
```ts
  const partner = ok.includes('famcal') ? (r.partner ? { name: r.partner.name } : null) : state.partner;
  const carryOvers = r.carryOvers ? [...r.carryOvers] : state.carryOvers;
  const reconnect = google?.status === 'reconnect' ? (google.reason === 'scopes' ? 'scopes' : 'token') : state.reconnect;
  const gone = ok.includes('google') ? r.calendars.filter((c) => c.source === 'google' && c.unavailable === true).map((c) => c.id) : [];
  const added = gone.filter((id, i) => !state.unavailable.includes(id) && gone.indexOf(id) === i);
  const unavailable = added.length > 0 ? [...state.unavailable, ...added] : state.unavailable;
  return { ...state, days, status, lastFailure, calendars, reconnect, unavailable, partner, carryOvers };
}
```

**9.** In `src/lib/calendar-view/store.ts`, lines 252-263: `markFailed`: one failure per source, written to `lastFailure` and to each day it marks. Before:
```ts
  const sources = state.facts.sources.filter((s) => a.sources.includes(s));
  if (sources.length === 0) return state;
  const lastFailure = { ...state.lastFailure };
  for (const s of sources) lastFailure[s] = a.kind === 'busy' ? { kind: 'busy', source: s } : { kind: 'error', source: s, reason: null };
  const days: Record<DayKey, StoreDay> = { ...state.days };
  for (const date of daysInWindow(a.from, a.to)) {
    const prev = state.days[date];
    const coverage = { ...prev?.coverage };
    for (const s of sources) {
      if (!coverage[s]?.ok) coverage[s] = failedCoverage();
    }
    days[date] = { items: prev ? prev.items : [], coverage };
```
After:
```ts
  const sources = state.facts.sources.filter((s) => a.sources.includes(s));
  if (sources.length === 0) return state;
  const failures = sources.map((s): SourceFailure => (a.kind === 'busy' ? { kind: 'busy', source: s } : { kind: 'error', source: s, reason: null }));
  const lastFailure = { ...state.lastFailure };
  for (const f of failures) lastFailure[f.source] = f;
  const days: Record<DayKey, StoreDay> = { ...state.days };
  for (const date of daysInWindow(a.from, a.to)) {
    const prev = state.days[date];
    const coverage = { ...prev?.coverage };
    for (const f of failures) {
      if (!coverage[f.source]?.ok) coverage[f.source] = failedCoverage(f);
    }
    days[date] = { items: prev ? prev.items : [], coverage };
```

**10.** In `src/lib/calendar-view/store.ts`, lines 311-314: the new `dayFailure`, after `failedSources`. Before:
```ts
}

/** Whether the day's Google data came from a partial answer. */
export function isPartialDay(state: CalendarStore, day: DayKey): boolean {
```
After:
```ts
}

/**
 * Why `source` has no data for `day`: the failure that marked the day, the latest one
 * that covered it. null when the source answered ok for it or nothing has covered it.
 */
export function dayFailure(state: CalendarStore, day: DayKey, source: SourceName): SourceFailure | null {
  return state.days[day]?.coverage[source]?.failure ?? null;
}

/** Whether the day's Google data came from a partial answer. */
export function isPartialDay(state: CalendarStore, day: DayKey): boolean {
```

**11.** In `src/lib/calendar-view/store.ts`, lines 319-325: `homeNotices` reads the epoch's two. Before:
```ts
export function homeNotices(state: CalendarStore): HomeNotices {
  const g = state.status.google;
  return {
    reconnect: g?.status === 'reconnect' ? (g.reason === 'scopes' ? 'scopes' : 'token') : null,
    unavailableCalendars: state.calendars.filter((c) => c.source === 'google' && c.unavailable === true).length,
  };
}
```
After:
```ts
/** The banners' inputs. Both hold for the epoch (see the header): a store drop clears them. */
export function homeNotices(state: CalendarStore): HomeNotices {
  return { reconnect: state.reconnect, unavailableCalendars: state.unavailable.length };
}
```

**12.** In `app/[locale]/dashboard/HomeBanners.tsx`, lines 10-11: the header says the Reconnect banner holds. Before:
```tsx
// - Reconnect Google, when the latest Google answer asked for it: a dead token, or
//   missing permission (the scopes copy); never with the Connect card, never for FamCal;
```
After:
```tsx
// - Reconnect Google, once a Google answer in this epoch asked for it (it holds until the
//   store drops): a dead token, or missing permission (the scopes copy); never with the
//   Connect card, never for FamCal;
```

**13.** In `app/[locale]/dashboard/HomeBanners.tsx`, line 29: so does the prop's comment. Before:
```tsx
  /** The store's latest Google answer asked for a reconnect (homeNotices). */
```
After:
```tsx
  /** A Google answer in this epoch asked for a reconnect (homeNotices: it holds until the store drops). */
```

- [ ] **Step 7: Take the state row's reason from its earliest failed day in `src/lib/calendar-view/agenda.ts`**

Five edits, in this order. Line numbers are the file's before the first edit.

**1.** In `src/lib/calendar-view/agenda.ts`, lines 9-14: the header says where a state row's reason comes from. Before:
```ts
//   empty neighbours, but only once every applicable source answered ok for it (§5).
// - A day a source failed for, with no earlier ok data, shows no empty line and no
//   fold; the source's state row shows once, above the days. A reconnect is the
//   Reconnect banner's (homeNotices, in the container), never a state row.
// - Still open: today's open reminders by time, then the carry-overs newest first;
//   5 shown, then the rest.
```
After:
```ts
//   empty neighbours, but only once every applicable source answered ok for it (§5).
// - A day a source failed for, with no earlier ok data, shows no empty line and no
//   fold; the source's state row shows once, above the days, with the reason of the
//   earliest such day (dayFailure), so a later window's failure never rewrites it. A
//   reconnect is the Reconnect banner's (homeNotices, in the container), never a state row.
// - Still open: today's open reminders by time, then the carry-overs newest first;
//   5 shown, then the rest.
```

**2.** In `src/lib/calendar-view/agenda.ts`, lines 18-21: the store import adds `dayFailure`. Before:
```ts
  SOURCE_ORDER,
  addDaysToKey,
  dayItems,
  dayStatus,
```
After:
```ts
  SOURCE_ORDER,
  addDaysToKey,
  dayFailure,
  dayItems,
  dayStatus,
```

**3.** In `src/lib/calendar-view/agenda.ts`, lines 197-201: `failing` keeps each source's earliest failed day's failure. Before:
```ts

  const entries: AgendaEntry[] = [];
  const failing = new Set<SourceName>();
  let fold: AgendaFold | null = null;
  let partial = false;
```
After:
```ts

  const entries: AgendaEntry[] = [];
  /** Each source that failed for a shown day, with its earliest such day's failure. */
  const failing = new Map<SourceName, SourceFailure | null>();
  let fold: AgendaFold | null = null;
  let partial = false;
```

**4.** In `src/lib/calendar-view/agenda.ts`, lines 205-209: only the first (earliest) failed day of each source is kept. Before:
```ts
    const status = dayStatus(state, date);
    const rows = dayItems(state, date).map((item) => toRow(item, partnerName));
    for (const s of failedSources(state, date)) failing.add(s);
    if (isPartialDay(state, date)) partial = true;
    if (status !== 'answered' || rows.length > 0) nothing = false;
```
After:
```ts
    const status = dayStatus(state, date);
    const rows = dayItems(state, date).map((item) => toRow(item, partnerName));
    for (const s of failedSources(state, date)) {
      if (!failing.has(s)) failing.set(s, dayFailure(state, date, s));
    }
    if (isPartialDay(state, date)) partial = true;
    if (status !== 'answered' || rows.length > 0) nothing = false;
```

**5.** In `src/lib/calendar-view/agenda.ts`, lines 229-233: the state row's reason: that day's failure, then `lastFailure`, then a generic error. Before:
```ts
  for (const source of SOURCE_ORDER) {
    if (!failing.has(source)) continue;
    const failure: SourceFailure = state.lastFailure[source] ?? { kind: 'error', source, reason: null };
    if (failure.kind === 'reconnect') continue;
    stateRows.push({ source, failure });
```
After:
```ts
  for (const source of SOURCE_ORDER) {
    if (!failing.has(source)) continue;
    const failure: SourceFailure = failing.get(source) ?? state.lastFailure[source] ?? { kind: 'error', source, reason: null };
    if (failure.kind === 'reconnect') continue;
    stateRows.push({ source, failure });
```

- [ ] **Step 8: Add Month windows to `src/lib/calendar-view/home-loader.ts`**

Twelve edits, in this order; line numbers are the file's before the first edit. Edit 9 replaces `send` with `send`, `start` and `nextMonth`. Edit 8 is the busy/error branch's new first line, exactly as the split gives it. Edit 7 (review patch) drops a month's follow-up that falls due once the month is no longer wanted.

**1.** In `src/lib/calendar-view/home-loader.ts`, lines 6-24: the header: Month windows, the cap, the keys, `retryWindow` and an older epoch's failures. Before:
```ts
// - First load: one request per applicable source, in parallel, with no dates (the
//   server's [today, today+7)). Whichever answers first pins the facts and paints.
// - ensure(): every visible window (week 0 … weeks-1 of the Agenda) whose days a source
//   hasn't covered in this epoch gets one request. That covers "Show next week" (one
//   more week) and a store drop (midnight, other facts: the epoch moves on and the days
//   are gone). A window is asked at most once per epoch this way.
// - refetchVisible(): every visible window again: a return to the foreground, a Retry,
//   or ⋯ → Refresh (fresh=1). A request already in flight is not sent twice.
// - An answer with google.stale asks that window once more after about 3 s; if that is
//   stale too, the window waits for the next foreground or Refresh. A Google error
//   (not calendars_gone) gets one automatic retry after about 5 s.
// - Every request has a time limit (about 15 s, on the host's timer): one that never
//   settles reads as no answer, so it leaves the in-flight set and the next foreground
//   or Retry asks again instead of being deduped behind it forever.
// - 404 not_enabled → the host reloads once; 401, 403, any other 404 → the host's
//   no-credential card; 429 → busy, a 500 or no answer → error: a state row for the
//   window once the facts are pinned, else the host's busy or retry card.

import { agendaWeekWindow } from './agenda';
```
After:
```ts
// - First load: one request per applicable source, in parallel, with no dates (the
//   server's [today, today+7)). Whichever answers first pins the facts and paints.
// - ensure(): every visible window (week 0 … weeks-1 of the Agenda, and the Month
//   windows the host wants now) whose days a source hasn't covered in this epoch gets
//   one request. That covers "Show next week" (one more week), a month coming near the
//   viewport, and a store drop (midnight, other facts: the epoch moves on and the days
//   are gone). A window is asked at most once per epoch this way.
// - refetchVisible(): every visible window again: a return to the foreground, a Retry,
//   or ⋯ → Refresh (fresh=1). The Agenda's weeks only while the Agenda is on screen,
//   and the wanted months. A request already in flight is not sent twice.
// - retryWindow(): one window again (the Month's Retry).
// - An answer with google.stale asks that window once more after about 3 s; if that is
//   stale too, the window waits for the next foreground or Refresh. A Google error
//   (not calendars_gone) gets one automatic retry after about 5 s.
// - Month windows (spec §5, Plan E Ruling 7) are a month's own days, [1st, 1st of the
//   next month) (R12). At most MONTH_INFLIGHT_MAX of them are in flight; every send for
//   one waits its turn (the first ask, a refetch, Retry, the stale and error follow-ups),
//   and the Agenda's weeks never do. When a slot frees, the queued months the host no
//   longer wants are dropped without being marked asked, so ensure() asks them again if
//   they come back; then the most wanted goes. A month's stale or error follow-up that
//   falls due once the month is no longer wanted is dropped too, slot or no slot.
// - Windows are keyed by both ends, `from..to`: on the 1st of a month the Agenda's week 0
//   and that month share a start, never a key.
// - Every request has a time limit (about 15 s, on the host's timer): one that never
//   settles reads as no answer, so it leaves the in-flight set (and frees its month slot)
//   and the next foreground or Retry asks again instead of being deduped behind it forever.
// - 404 not_enabled → the host reloads once; 401, 403, any other 404 → the host's
//   no-credential card; 429 → busy, a 500 or no answer → error: a state row for the
//   window once the facts are pinned, else the host's busy or retry card. A failure
//   from before the last store drop changes nothing: the loader asks again anyway.

import { agendaWeekWindow } from './agenda';
```

**2.** In `src/lib/calendar-view/home-loader.ts`, lines 33-36: `MONTH_INFLIGHT_MAX`. Before:
```ts
/** A range request's time limit: past it, the request is aborted and reads as no answer. */
export const RANGE_TIMEOUT_MS = 15_000;

export interface LoaderHost {
```
After:
```ts
/** A range request's time limit: past it, the request is aborted and reads as no answer. */
export const RANGE_TIMEOUT_MS = 15_000;
/** Month windows in flight at once (spec §5); the Agenda's weeks don't count. */
export const MONTH_INFLIGHT_MAX = 2;

export interface LoaderHost {
```

**3.** In `src/lib/calendar-view/home-loader.ts`, lines 53-56: the host's two optional methods. Before:
```ts
  onNotEnabled(): void;
  setTimer(run: () => void, ms: number): () => void;
}

```
After:
```ts
  onNotEnabled(): void;
  setTimer(run: () => void, ms: number): () => void;
  /** Month windows wanted now (on screen or next to it), most wanted first; absent or [] = none. */
  getMonths?(): readonly RangeWindow[];
  /** Whether the Agenda is on screen: refetchVisible asks its weeks only then. Absent = true. */
  agendaShowing?(): boolean;
}

```

**4.** In `src/lib/calendar-view/home-loader.ts`, lines 58-65: `retryWindow` on the loader, and the queue's entry type. Before:
```ts
  ensure(): void;
  refetchVisible(o?: { fresh?: boolean; only?: SourceName }): void;
  dispose(): void;
}

type Ask = { source: SourceName; window: RangeWindow | null; fresh?: boolean; followUp?: 'stale' | 'retry' };

/** Whether some day of the window has no answer (ok or failed) from `source` yet. */
```
After:
```ts
  ensure(): void;
  refetchVisible(o?: { fresh?: boolean; only?: SourceName }): void;
  /** One window again, for each applicable source or only `only` (the Month's Retry). */
  retryWindow(window: RangeWindow, only?: SourceName): void;
  dispose(): void;
}

type Ask = { source: SourceName; window: RangeWindow | null; fresh?: boolean; followUp?: 'stale' | 'retry' };
/** A month send waiting for a slot: its in-flight key and the epoch it was asked in. */
type Queued = { key: string; ask: Ask; epoch: number };

/** Whether some day of the window has no answer (ok or failed) from `source` yet. */
```

**5.** In `src/lib/calendar-view/home-loader.ts`, lines 71-79: `windowKey` and `isMonthWindow`; the queue and the month slot count. Before:
```ts
}

export function createHomeLoader(host: LoaderHost): HomeLoader {
  /** `${epoch}|${source}|${from or 'default'}`: asked by ensure() in that epoch. */
  const issued = new Set<string>();
  /** The same plus `|fresh` or `|plain`: on its way now. */
  const inflight = new Set<string>();
  const timers = new Set<() => void>();
  let live = true;
```
After:
```ts
}

/** A window's key, both ends: `from..to`; 'default' for the no-dates request. */
function windowKey(window: RangeWindow | null): string {
  return window ? `${window.from}..${window.to}` : 'default';
}

/** A month's own days, [1st, 1st of the next month) (R12). An Agenda week (7 days) never is one. */
function isMonthWindow(window: RangeWindow | null): boolean {
  if (!window || !/^\d{4}-\d{2}-01$/.test(window.from)) return false;
  const [y, m] = window.from.split('-').map(Number);
  return window.to === new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
}

export function createHomeLoader(host: LoaderHost): HomeLoader {
  /** `${epoch}|${source}|${windowKey}`: asked in that epoch. */
  const issued = new Set<string>();
  /** The same plus `|fresh` or `|plain`: on its way now. */
  const inflight = new Set<string>();
  /** Month sends waiting for a slot, in the order they were asked. */
  const queue: Queued[] = [];
  let monthsInFlight = 0;
  const timers = new Set<() => void>();
  let live = true;
```

**6.** In `src/lib/calendar-view/home-loader.ts`, lines 89-92: `wantedMonths`. Before:
```ts
  const visibleWindows = (today: string): RangeWindow[] =>
    Array.from({ length: Math.max(1, Math.floor(host.getWeeks())) }, (_, week) => agendaWeekWindow(today, week));

  function handle(outcome: RangeOutcome, ask: Ask, epoch: number, where: string) {
```
After:
```ts
  const visibleWindows = (today: string): RangeWindow[] =>
    Array.from({ length: Math.max(1, Math.floor(host.getWeeks())) }, (_, week) => agendaWeekWindow(today, week));
  const wantedMonths = (): readonly RangeWindow[] => host.getMonths?.() ?? [];

  function handle(outcome: RangeOutcome, ask: Ask, epoch: number, where: string) {
```

**7.** In `src/lib/calendar-view/home-loader.ts`, lines 101-104: a month's stale or error follow-up goes only while the host still wants the month (interface note 3). Before:
```ts
        // A follow-up is for this epoch's window only: after a drop the loader starts over anyway.
        const again = (followUp: 'stale' | 'retry') => {
          if (host.getStore().epoch === epoch) send({ source, window: answered, followUp });
        };
```
After:
```ts
        // A follow-up is for this epoch's window only: after a drop the loader starts over
        // anyway. A month's goes only while the host still wants the month: after a fast
        // scroll the months passed are not asked again (each is a request off the rate limit).
        const again = (followUp: 'stale' | 'retry') => {
          if (host.getStore().epoch !== epoch) return;
          if (isMonthWindow(answered) && !wantedMonths().some((w) => windowKey(w) === windowKey(answered))) return;
          send({ source, window: answered, followUp });
        };
```

**8.** In `src/lib/calendar-view/home-loader.ts`, lines 119-122: an older epoch's 429 or 500 returns at once (the busy/error branch's first line). Before:
```ts
      case 'busy':
      case 'error': {
        const facts = host.getStore().facts;
        const failed = window ?? (facts ? agendaWeekWindow(facts.today, 0) : null);
```
After:
```ts
      case 'busy':
      case 'error': {
        if (epoch !== host.getStore().epoch) return;
        // Sent before the last store drop: the loader asks the new epoch's windows anyway,
        // and a card or a state row now would only flash until they answer.
        const facts = host.getStore().facts;
        const failed = window ?? (facts ? agendaWeekWindow(facts.today, 0) : null);
```

**9.** In `src/lib/calendar-view/home-loader.ts`, lines 132-151: `send` keys by both ends and queues a month past the cap; `start` sends; `nextMonth` drops the unwanted and sends the most wanted. Before:
```ts
  }

  /** The one place a request leaves; nothing leaves once the home is blocked. */
  function send(ask: Ask) {
    if (!live || host.isBlocked()) return;
    const epoch = host.getStore().epoch;
    const where = ask.window ? ask.window.from : 'default';
    const key = `${epoch}|${ask.source}|${where}|${ask.fresh ? 'fresh' : 'plain'}`;
    if (inflight.has(key)) return;
    inflight.add(key);
    issued.add(`${epoch}|${ask.source}|${where}`);
    void fetchRange(host.userId, ask.source, ask.window, ask.fresh === true, { ms: RANGE_TIMEOUT_MS, setTimer: host.setTimer })
      .catch((): RangeOutcome => ({ kind: 'error', status: null }))
      .then((outcome) => {
        inflight.delete(key);
        if (live) handle(outcome, ask, epoch, where);
      })
      .catch((err: unknown) => console.error('[calendar-home] A range answer could not be applied:', err));
  }

```
After:
```ts
  }

  /** The one place a request leaves; nothing leaves once the home is blocked. A month waits for a slot. */
  function send(ask: Ask) {
    if (!live || host.isBlocked()) return;
    const epoch = host.getStore().epoch;
    const key = `${epoch}|${ask.source}|${windowKey(ask.window)}|${ask.fresh ? 'fresh' : 'plain'}`;
    if (inflight.has(key)) return;
    if (isMonthWindow(ask.window)) {
      if (queue.some((q) => q.key === key)) return;
      if (monthsInFlight >= MONTH_INFLIGHT_MAX) {
        queue.push({ key, ask, epoch });
        return;
      }
    }
    start(ask, epoch, key);
  }

  function start(ask: Ask, epoch: number, key: string) {
    const where = windowKey(ask.window);
    const month = isMonthWindow(ask.window);
    inflight.add(key);
    issued.add(`${epoch}|${ask.source}|${where}`);
    if (month) monthsInFlight++;
    void fetchRange(host.userId, ask.source, ask.window, ask.fresh === true, { ms: RANGE_TIMEOUT_MS, setTimer: host.setTimer })
      .catch((): RangeOutcome => ({ kind: 'error', status: null }))
      .then((outcome) => {
        inflight.delete(key);
        if (month) monthsInFlight--;
        try {
          if (live) handle(outcome, ask, epoch, where);
        } finally {
          if (month) nextMonth();
        }
      })
      .catch((err: unknown) => console.error('[calendar-home] A range answer could not be applied:', err));
  }

  /**
   * A month slot is free: drop the queued months the host no longer wants (or that were
   * asked before the last store drop), none of them marked asked; then send the most wanted.
   */
  function nextMonth() {
    while (live && monthsInFlight < MONTH_INFLIGHT_MAX && queue.length > 0) {
      if (host.isBlocked()) {
        queue.length = 0;
        return;
      }
      const epoch = host.getStore().epoch;
      const wanted = wantedMonths().map(windowKey);
      const rank = (q: Queued) => wanted.indexOf(windowKey(q.ask.window));
      for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i].epoch !== epoch || rank(queue[i]) < 0 || inflight.has(queue[i].key)) queue.splice(i, 1);
      }
      if (queue.length === 0) return;
      let best = 0;
      for (let i = 1; i < queue.length; i++) if (rank(queue[i]) < rank(queue[best])) best = i;
      const [q] = queue.splice(best, 1);
      start(q.ask, epoch, q.key);
    }
  }

```

**10.** In `src/lib/calendar-view/home-loader.ts`, lines 164-171: `ensure` keys its weeks by both ends and asks the wanted months. Before:
```ts
      visibleWindows(facts.today).forEach((window, week) => {
        for (const source of facts.sources) {
          const asked = issued.has(`${store.epoch}|${source}|${window.from}`) || (week === 0 && issued.has(`${store.epoch}|${source}|default`));
          if (!asked && uncovered(store, source, window)) send({ source, window });
        }
      });
    },

```
After:
```ts
      visibleWindows(facts.today).forEach((window, week) => {
        for (const source of facts.sources) {
          const asked = issued.has(`${store.epoch}|${source}|${windowKey(window)}`) || (week === 0 && issued.has(`${store.epoch}|${source}|default`));
          if (!asked && uncovered(store, source, window)) send({ source, window });
        }
      });
      for (const window of wantedMonths()) {
        for (const source of facts.sources) {
          if (!issued.has(`${store.epoch}|${source}|${windowKey(window)}`) && uncovered(store, source, window)) send({ source, window });
        }
      }
    },

```

**11.** In `src/lib/calendar-view/home-loader.ts`, lines 178-183: `refetchVisible` asks the weeks only while the Agenda shows, then the months; the new `retryWindow`. Before:
```ts
        return;
      }
      for (const window of visibleWindows(facts.today)) {
        for (const source of sources) send({ source, window, fresh });
      }
    },
```
After:
```ts
        return;
      }
      if (host.agendaShowing?.() !== false) {
        for (const window of visibleWindows(facts.today)) {
          for (const source of sources) send({ source, window, fresh });
        }
      }
      for (const window of wantedMonths()) {
        for (const source of sources) send({ source, window, fresh });
      }
    },

    retryWindow(window: RangeWindow, only?: SourceName) {
      if (!live) return;
      const facts = host.getStore().facts;
      for (const source of (facts ? facts.sources : host.sources).filter((s) => only === undefined || s === only)) {
        send({ source, window });
      }
    },
```

**12.** In `src/lib/calendar-view/home-loader.ts`, lines 185-188: `dispose` drops the queue. Before:
```ts
    dispose() {
      live = false;
      for (const cancel of timers) cancel();
      timers.clear();
```
After:
```ts
    dispose() {
      live = false;
      queue.length = 0;
      for (const cancel of timers) cancel();
      timers.clear();
```

- [ ] **Step 9: Share the lookup in flight in `src/lib/timezone.ts`, for its first 1.5 s**

One edit. The body of the old `resolveUserTimezone`, from its Redis read to the default zone, stays exactly as it is and becomes `lookUpUserTimezone`.

**1.** In `src/lib/timezone.ts`, lines 52-63: the in-flight map, and `resolveUserTimezone` joins a lookup for its key in the lookup's first 1.5 s (interface note 1); the old body becomes `lookUpUserTimezone`. Before:
```ts
}

/**
 * Resolve user's timezone dynamically
 * Priority: Redis cache → Geocoding → Google Calendar → UTC
 * Caches successful result for 24h to avoid repeated API calls
 */
export async function resolveUserTimezone(
  user: { id: number; location?: string; googleRefreshToken?: string; telegramId?: number | null }
): Promise<string> {
  const cacheKey = REDIS_KEYS.userTimezone(user.id);

```
After:
```ts
}

type TimezoneUser = { id: number; location?: string; googleRefreshToken?: string; telegramId?: number | null };

/**
 * The lookups in flight, one per user, location and whether a Google token is there:
 * `${id}|${location}|g` (or no `g`), each with when it started. The range route waits
 * at most 2 s for a zone and lets the lookup go on, and the Month opens several windows
 * at once, so an open within JOIN_MS of a lookup's start joins it rather than starting
 * another Nominatim request. On globalThis: Next 16 gives the scheduler and the routes
 * separate module instances. The keys hold a location: they are never logged.
 */
/** A lookup and when it started, on the process's monotonic clock (performance.now(): no wall-clock jumps). */
type InflightLookup = { lookup: Promise<string>; startedAt: number };
const shared = globalThis as { __tzInflight?: Map<string, InflightLookup> };
const inflight: Map<string, InflightLookup> = (shared.__tzInflight ??= new Map());

/**
 * How long a lookup takes callers in: under the range route's 2 s wait. An older one is
 * slower than any open waits for, or stuck on a call with no time limit of its own (a
 * Redis read, Google's settings call), so it holds no later caller: the next one starts
 * its own lookup, which takes callers in from then on. At most one lookup per key starts
 * in any 1.5 s.
 */
const JOIN_MS = 1500;

/**
 * Resolve user's timezone dynamically
 * Priority: Redis cache → Geocoding → Google Calendar → UTC
 * Caches successful result for 24h to avoid repeated API calls.
 * Calls made within JOIN_MS of the start of a lookup for the same user, location and
 * token presence share it: one answer, or one rejection, for all of them. The entry goes
 * when it settles, unless a newer lookup has taken its place.
 */
export async function resolveUserTimezone(user: TimezoneUser): Promise<string> {
  const key = `${user.id}|${user.location ?? ''}|${user.googleRefreshToken ? 'g' : ''}`;
  const now = performance.now();
  const running = inflight.get(key);
  if (running && now - running.startedAt < JOIN_MS) return running.lookup;
  const lookup = lookUpUserTimezone(user).finally(() => {
    if (inflight.get(key)?.lookup === lookup) inflight.delete(key);
  });
  inflight.set(key, { lookup, startedAt: now });
  return lookup;
}

/** One lookup: Redis cache → Geocoding → Google Calendar → the default (resolveUserTimezone's order). */
async function lookUpUserTimezone(user: TimezoneUser): Promise<string> {
  const cacheKey = REDIS_KEYS.userTimezone(user.id);

```

- [ ] **Step 10: Run the new checks under the three clocks and see them pass**

Run Step 5's first command again.

Expected, under each clock (UTC shown; the others print the same with their names):
```
37/37 passed (process TZ=UTC)
smoke-calendar-agenda UTC exit=0
12/12 passed (process TZ=UTC)
smoke-calendar-loader UTC exit=0
42/42 passed (process TZ=UTC)
smoke-calendar-home-render UTC exit=0
7/7 passed (process TZ=UTC)
smoke-timezone-inflight UTC exit=0
```
No `FAIL` line. The two new smokes' full output under `TZ=UTC` (the other clocks repeat it line for line, apart from the TZ name):
```
OK  at most 2 month requests are in flight (MONTH_INFLIGHT_MAX); the rest wait, and when a slot frees the most wanted goes; the Agenda's weeks never wait
OK  a queued month that is no longer wanted when a slot frees is dropped, never sent, and not marked asked: it is asked once it is wanted again
OK  months are deduped per epoch, source and window: two ensure()s send one request per month and source, and an answered month is not asked again
OK  a window is keyed by both its ends: on the 1st, the Agenda's week 0 [1st, 8th) and the month [1st, 1st of next month) never collide
OK  the stale and the error follow-ups of a month go through the cap: they wait while 2 months are in flight, and go when a slot frees
OK  a month's stale or error follow-up that falls due once the month is no longer wanted is dropped, even with both slots free: the months a fast scroll passed are not asked again; one still wanted goes
OK  a month request that never settles frees its slot at the time limit (about 15 s), and the next month goes
OK  refetchVisible() asks the Agenda's weeks only while agendaShowing() (absent = true), and the wanted months always, fresh=1 included
OK  retryWindow() asks a window again for each applicable source (or `only`), through the cap
OK  an older epoch's 500 or 429 after a reset dispatches nothing and never calls onFirstLoadFailed, and its queued months are dropped; the new epoch's own failure still shows the card
OK  dispose() drops the queue and the timers: nothing more is sent or dispatched
OK  D's host (no getMonths, no agendaShowing) sends exactly what it sent before: the same URLs, in the same order
12/12 passed (process TZ=UTC)
smoke-calendar-loader UTC exit=0
OK  two calls for one user while the lookup is in flight make one Redis read and one geocode call, and both get its answer
OK  once the lookup settles its entry is gone, and the next call looks up afresh
OK  a lookup that rejects (Redis down) rejects for every caller with the same error, and its entry goes
OK  another user, a changed location or a Google token (or none) make a lookup of their own; two token values share one
OK  two module instances (the scheduler's and a route's) share the in-flight map
OK  a lookup stuck 1.5 s or more (a Redis read or a Google call that never answers) holds no later caller: a call within 1.5 s joins it, a later one makes a lookup of its own and gets its answer, and the stuck one settling meanwhile leaves the later one's entry alone
OK  the shared lookup prints nothing: no console line names a location
7/7 passed (process TZ=UTC)
smoke-timezone-inflight UTC exit=0
```

If the check on D's host fails, the loader changed something D sends. Fix the loader, not the check.

- [ ] **Step 11: Run the regression smokes again**

Run Step 5's second command again. Expected: exactly Step 5's lines, every one `exit=0`. If `smoke-calendar-range` #24 fails with `a quick lookup`, the join window is not under the route's 2 s wait: #24's second open, which comes just after its first open's 2 s fallback, joined the first open's stuck lookup.

- [ ] **Step 12: Type-check and lint**

```bash
cd /Users/razielgershoni/development/famcalbot
npx tsc --noEmit -p . && npm run -s lint; echo "exit $?"
```
Expected: no output from either, then `exit 0`. `next build` type-checks `scripts/**`, so the new smokes are covered too.

- [ ] **Step 13: Commit**

```bash
cd /Users/razielgershoni/development/famcalbot
git add src/lib/calendar-view/store.ts src/lib/calendar-view/agenda.ts src/lib/calendar-view/home-loader.ts src/lib/timezone.ts "app/[locale]/dashboard/HomeBanners.tsx" scripts/smoke-calendar-agenda.ts scripts/smoke-calendar-loader.ts scripts/smoke-calendar-home-render.ts scripts/smoke-timezone-inflight.ts
git commit -m "$(cat <<'EOF'
feat(calendar-home): Month windows in the loader, a failure per day, one timezone lookup per user

The store keeps, on each failed day, the failure that marked it
(dayFailure), and the Agenda's state row gives its earliest shown failed
day's reason: a 429 on week 1 no longer turns week 0's "Choose again"
into "Busy". The Reconnect banner and the unavailable calendars now hold
for the epoch, so an answer from Google's cache no longer hides them.
The loader asks the Month windows the host wants (none yet: CalendarHome's
host is unchanged), at most 2 in flight, the follow-ups and Retry
included; a queued month the host no longer wants is dropped and asked
again when it comes back, and so is a follow-up that falls due once the
month is no longer wanted. Windows are keyed by both ends, so on the 1st
week 0 and the month don't collide, and an older epoch's 429 or 500 after
the midnight reset no longer flashes the retry card. resolveUserTimezone
shares a lookup per user on globalThis for its first 1.5 s, so the
Month's many opens start one Nominatim lookup, not one each, and a lookup
stuck on a call with no time limit holds no later caller.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
EOF
)"
```
Stage only these nine paths. The working tree may show plan or spec files as modified; they aren't part of this task.

---

---

### Task 4 (E4): Tab bar, tab memory, swipes and the Month's colours (spec §7.1 State and Look, §7.4 Memory, §7.6, §7.7; Plan E Rulings 1, 2 and 9)

> **INTERFACE CHANGE VERSUS THE SPLIT: none.** Every name and signature the split gives E4 is used verbatim: `useTelegramVerticalSwipes`, `releaseTelegramControls`, `HomeTab`, `homeTabKey`, `monthLayoutKey`, `readHomeTab`, `writeHomeTab`, `readMonthLayout`, `writeMonthLayout`, `TAB_IDS`, `PANEL_IDS`, `HomeTabsProps`, `HomeTabs`, `TABS_CSS`, and the 23 tokens. Nothing is added to any export list. Five points the split leaves open are now binding, and E6, E7 and E8 build on them:
> 1. **HomeTabs** renders a fragment: its `<style>`, then the tablist. The tablist sets its own `dir` from the locale. `onTab` is never called with the tab already on screen. A key moves focus and also selects (automatic activation). The arrows move from the tab that has focus. E8 gives each panel `role="tabpanel"`, `id={PANEL_IDS[tab]}` and `aria-labelledby={TAB_IDS[tab]}`.
> 2. **The partner's items are outlined everywhere**, so colour is never the only signal.
>    - E6 draws the partner's timed chip with a 1 px `--ch-partner-line` border on `--ch-bg`, in `--ch-partner-line-text`.
>    - The partner's all-day items and bars are `--ch-partner-soft` under `--ch-partner-soft-text`, with the same 1 px `--ch-partner-line` border.
>    - The viewer's items have no border: `--ch-mine-soft` / `--ch-mine-soft-text` (timed), `--ch-mine-solid` / `--ch-mine-solid-text` (all-day items and bars).
>    - E7's dots are a filled `--ch-dot-mine`, or a 1.5 px `--ch-dot-partner` ring.
>    - The mockup's partner bar has no border. In dark, though, the two bar fills are only 2.45:1 apart, so the border is what tells them apart.
> 3. **`--ch-today` is a fill** under `--ch-today-text`. When E7 shows today's number as plain text (picked, today not selected), it uses `--ch-accent`: `--ch-today` as text is only 3.5:1 on the dark fallback.
> 4. **HomeCrash also calls `useTelegramVerticalSwipes(false)`** (in `HomeErrorBoundary.tsx`, a file the split gives E4), next to D's `useTelegramBackButton(false, noop)`. A reload in the Month's browse can leave swipes off, and the crash card has no lock to keep: Ruling 9's "every other state".
> 5. **Two fallbacks differ from the mockups** because of the contrast floor:
>    - the light `--ch-partner-line` is `#b05f22`, because the mockup's `#d98b4a` is 2.7:1 on white, under the 3:1 a mark needs;
>    - the dark `--ch-today` / `--ch-mine-solid` fallback is `#6d4ff0`, because D's dark button (`--brand-primary`, `#7c5cfc`) gives white text only 4.4:1.

**What and why.** Plan E adds the Month tab. So the home needs a tab bar, a memory for the tab and for the Month's layout, Telegram's swipe lock for browse, and the colours the Month draws with. This task writes those pieces. E8 wires them into CalendarHome. CalendarHome isn't edited here, so the home renders exactly as it does today, and no user sees a change.
- **Swipes** (spec §7.6, Ruling 9). `useTelegramVerticalSwipes(locked)` turns Telegram's swipe-down-to-minimize off while `locked` (E8 locks it while the Month shows browse) and back on otherwise:
  - it makes one call per change;
  - an unlocked mount enables, because a reload can leave swipes off;
  - unmount enables;
  - it never reads `isVerticalSwipesEnabled`, which is wrong after a reload.

  `releaseTelegramControls()` lets the BackButton go and enables swipes, outside React, just before a reload. HomeErrorBoundary's chunk-load reload now calls it, and its card enables swipes on mount.
- **Memory** (Ruling 2). `home-storage.ts` keeps the tab in sessionStorage (`famcal:homeTab:v1:{userId}`) and the Month's layout in localStorage (`famcal:monthLayout:v1:{userId}`), keyed by the page's own `user_id`. Every access is in try/catch:
  - with no window, a blocked or full storage, or an unknown value, the tab reads `'agenda'` and the layout `null`;
  - a write never throws.
- **The tab bar** (spec §7.1, §7.7, Ruling 1, `Main.dc.html`):
  - a tablist with two tabs, the mockup's segmented control;
  - each tab is 44 px tall, with an inset pill;
  - the arrow keys follow the reading direction and are mirrored in Hebrew; Home and End work;
  - the selected tab is semibold as well as filled, so the state never rests on colour.
- **The colours** (spec §7.3 "Whose an item is", §7.4, §7.7). The 23 tokens the split lists are in light and dark:
  - they map onto Telegram's theme params where one fits;
  - their fallbacks are the mockups' shades;
  - D's contrast floor holds: every text colour is at least 4.5:1, and the marks that tell the viewer's items from the partner's are at least 3:1.

**Files** (line numbers as of 0064e8f; E1–E3 don't touch these four files, so the numbers hold after E3 too):
- Modify: `src/lib/telegram-ui.ts` (lines 1-7, 16-19, 121-124)
- Modify: `app/[locale]/dashboard/home-theme.ts` (lines 23-26, 45-48, 73-76, 84-87)
- Modify: `app/[locale]/dashboard/HomeErrorBoundary.tsx` (lines 5-10, 13-15, 36-37, 64-66)
- Create: `src/lib/calendar-view/home-storage.ts`
- Create: `app/[locale]/dashboard/HomeTabs.tsx`
- Modify (test): `scripts/smoke-telegram-ui.ts` (lines 9-14, 146-155, 178-183, 186-196, 243-255, 496-501)
- Create (test): `scripts/smoke-calendar-home-tabs.ts`
- Not modified:
  - `app/[locale]/dashboard/CalendarHome.tsx`. E8 renders HomeTabs, calls the swipe hook, and swaps its not_enabled reload (`:167`) to `releaseTelegramControls`.
  - `src/types/telegram-webapp.d.ts`: D4 already typed both swipe methods (`:96-98`).
  - `scripts/smoke-calendar-home-render.ts`: E8 flips #22 and adds #43 on.
  - PageGate.
- Test: `smoke-telegram-ui` (14 → 19) and `smoke-calendar-home-tabs` (new, 11), each under `TZ=UTC` and `TZ=Asia/Jerusalem`. Neither smoke buckets days.
- Regression (unchanged, both clocks):
  - `smoke-calendar-home-render` (42): HomeErrorBoundary, home-theme under its #14 rules, and telegram-ui through CalendarHome;
  - `smoke-calendar-home-copy` (18);
  - `smoke-miniapp-gate` (20): PageGate's imports;
  - `smoke-auth-identity` (26), `smoke-auth-leftovers` (9) and `smoke-initdata-header` (9): they scan `app/`, `src/` and `scripts/`.

**Interfaces:**
- Consumes:
  - from E1, `messages/{en,he,ru}.json` `calendarHome.tabs.label`, `tabs.agenda`, `tabs.month`:
    - en "Calendar view", "Agenda", "Month";
    - he "תצוגת היומן", "סדר יום", "חודש";
    - ru "Вид календаря", "Расписание", "Месяц";
  - from D, `calendarHome.errorBoundary.title|body` and `actions.reload` (unchanged);
  - from D4, `src/lib/telegram-ui.ts`: the module-private `tgCall(version, what, call)` (gates with `isVersionAtLeast`, logs `[telegram-ui] <what> failed:` on a throw), `telegramSupports`, `releaseTelegramBackButton(): void`, `useTelegramBackButton(active, onBack)`, `useTelegramTheme()`;
  - from D4, `src/types/telegram-webapp.d.ts`: `enableVerticalSwipes: () => void`, `disableVerticalSwipes: () => void`;
  - from D, `src/lib/calendar-view/reload-guard.ts`: `reloadOnce(key: string, nowMs?: number, beforeReload?: () => void): boolean`;
  - from D5, the `home-theme.ts` tokens `--ch-bg`, `--ch-text`, `--ch-hint`, `--ch-muted`, `--ch-accent`, `--ch-surface`, `--ch-section`, `--ch-button`, `--ch-button-text`, `--ch-card`;
  - next-intl 4.6.1 (`useTranslations`, `useLocale`, `NextIntlClientProvider` in the smoke); React 19.2 (`useEffect`, `useRef`; `react-dom/server` and `react-dom/client` in the smokes);
  - nothing from E2, E3 or E5, so there are no stand-ins.
- Produces, `src/lib/telegram-ui.ts`:
  - `export function useTelegramVerticalSwipes(locked: boolean): void` (Bot API 7.7);
  - `export function releaseTelegramControls(): void` (`releaseTelegramBackButton()`, then `enableVerticalSwipes()`).
- Produces, `src/lib/calendar-view/home-storage.ts` (no imports):
  - `export type HomeTab = 'agenda' | 'month'`
  - `export function homeTabKey(userId: number): string`: `'famcal:homeTab:v1:' + userId`
  - `export function monthLayoutKey(userId: number): string`: `'famcal:monthLayout:v1:' + userId`
  - `export function readHomeTab(userId: number): HomeTab`: sessionStorage; `'agenda'` with no window, a throw, or any value but `'month'`
  - `export function writeHomeTab(userId: number, tab: HomeTab): void`
  - `export function readMonthLayout(userId: number): 'browse' | 'picked' | null`: localStorage; `null` with no window, a throw, or any other value
  - `export function writeMonthLayout(userId: number, layout: 'browse' | 'picked'): void`
- Produces, `app/[locale]/dashboard/HomeTabs.tsx`:
  - `export const TAB_IDS = { agenda: 'ch-tab-agenda', month: 'ch-tab-month' } as const`
  - `export const PANEL_IDS = { agenda: 'ch-panel-agenda', month: 'ch-panel-month' } as const`
  - `export interface HomeTabsProps { tab: HomeTab; onTab: (tab: HomeTab) => void }`
  - `export function HomeTabs(props: HomeTabsProps)`, which returns `<><style>{TABS_CSS}</style><div className="ch-tabs" role="tablist" …>…</div></>`
  - `export const TABS_CSS: string`, with the classes `.ch-tabs`, `.ch-tab` and `.ch-tab-pill`
- Produces, `app/[locale]/dashboard/home-theme.ts`. Each token is declared in both the `.ch-home` and the `.ch-home[data-theme='dark']` block:
  - `--ch-tab-track`, `--ch-tab-on`, `--ch-tab-on-text`, `--ch-tab-shadow`;
  - `--ch-mine-soft`, `--ch-mine-soft-text`, `--ch-mine-solid`, `--ch-mine-solid-text`;
  - `--ch-partner-soft`, `--ch-partner-soft-text`, `--ch-partner-line`, `--ch-partner-line-text`;
  - `--ch-dot-mine`, `--ch-dot-partner`;
  - `--ch-today`, `--ch-today-text`, `--ch-selected`, `--ch-selected-text`;
  - `--ch-pill-bg`, `--ch-pill-line`, `--ch-pill-text`;
  - `--ch-disabled`, `--ch-month-title`.

  The file's header says how each pair is drawn (point 2 above).
- `HomeErrorBoundary.tsx`: no signature change.
- **How E8 wires it** (E8's task):
  - `const [tab, setTab] = useState(() => readHomeTab(userId))`, with `writeHomeTab(userId, tab)` on each change;
  - `<HomeTabs tab={tab} onTab={…} />` under the header and above the banners, only when a panel can show (Ruling 1);
  - the panels as `<div role="tabpanel" id={PANEL_IDS[tab]} aria-labelledby={TAB_IDS[tab]}>`;
  - `initialMonthUi(readMonthLayout(userId), today)`, with `writeMonthLayout` on each layout change;
  - `useTelegramVerticalSwipes(tab === 'month' && layout === 'browse' && panelShown)`, called once, at CalendarHome's root;
  - `reloadOnce(NOT_ENABLED_RELOAD_KEY, Date.now(), releaseTelegramControls)`.

**Findings that shaped the code** (line numbers as of 0064e8f):
- **Swipes.**
  - The d.ts already types both methods and says not to read the flag (`telegram-webapp.d.ts:96-98`). The smoke's #1 already checks the type.
  - `tgCall` (`telegram-ui.ts:51-61`) gates on `telegramSupports(version)`, which calls the SDK's own `isVersionAtLeast` (`:40-48`). So `7.10` counts as newer than `7.7`, and nothing parses the version string.
  - Two effects:
    - one keyed on `locked` makes the call and has no cleanup;
    - one with no deps enables in its cleanup, which runs only on unmount.

    So a change makes exactly one call. With a cleanup on the keyed effect, an unlock would enable twice and a lock would enable, then disable. StrictMode's extra mount pass still ends in the asked state (#16).
- **Before a reload.**
  - `reloadOnce` runs `beforeReload` just before `location.reload()`, inside its own try (`reload-guard.ts:37-41`).
  - The boundary's `componentDidCatch` runs during the commit, before the passive-effect cleanups of the subtree it replaces. So the reload goes out before any of the home's cleanups could let the controls go. #10 checks the order: offClick, hide, enable, reload.
  - `CalendarHome.tsx:167` still passes `releaseTelegramBackButton`; E8 swaps it.
- **The crash card.** D's card hides a BackButton kept from before a reload (`HomeErrorBoundary.tsx:36`). Swipes have the same problem: when the home throws on its first render after a reload in browse, CalendarHome's effects never ran, so nothing enabled them.
- **Tab memory.**
  - sessionStorage gives Ruling 2's "a new session opens on the Agenda" while a reload keeps the tab. localStorage keeps the layout per device (§7.4).
  - Both keys end with `user.id`, the page's own `user_id` (`home-props.ts:14`, `CalendarHome.tsx:119`). Neither is ever a telegramId.
  - With storage blocked, Safari throws a SecurityError on the `window.sessionStorage` read itself, so the property read is inside the try (#7).
  - Only the exact values count: `'month'` for the tab, `'browse'` / `'picked'` for the layout. A value in the other storage doesn't count (#6).
- **The tabs' behaviour** follows the WAI-ARIA Authoring Practices tabs pattern:
  - a roving tabIndex;
  - automatic activation, because both panels are in-page state (spec §7.1: tabs are React state, never `router.push`);
  - arrows that wrap, plus Home and End.

  The direction comes from `useLocale() === 'he'`, as `AgendaView.tsx:151` and `CalendarHome.tsx:291` set it.
- **The tabs' look.**
  - The mockup's 36 px tab inside a 4 px track padding makes a 44 px row. So each button is the whole 44 px, and the pill sits 4 px inside it (2 px on the inner side, so there are 4 px between the pills, as in the mockup).
  - The selected label is semibold, like iOS's segmented control. The unselected one reads D's `--ch-muted`.
  - The focus ring is D's `.ch-btn:focus-visible` ring (`home-theme.ts:131-135`).
  - There is no `font:` shorthand and no `overflow: hidden`. D's CSS checks forbid the first (`smoke-calendar-home-render.ts:1171`). E8 checks that nothing above the Month uses the second.
- **The tokens and D's checks.**
  - D's #14 (`smoke-calendar-home-render.ts:1186-1197`) requires every variable HOME_THEME_CSS reads, other than `--tg-*` and `--ch-*`, to be a globals.css token, and pins D's fallbacks by regex. The additions read only `--tg-theme-*` and `--ch-*`, and D's lines are unchanged.
  - The cascade:
    - `.ch-home[data-theme='dark']` outranks `.ch-home`, so the light-only `@supports` rule never reaches dark;
    - the dark `@supports` rule comes after the plain dark block, so it wins there;
    - every token is declared in both plain blocks, so an engine without color-mix gets the mockup shades.
- **Telegram's mapping.**
  - The tab track and the selected pill are Telegram's secondary background and section background, the pair Telegram uses for a card on a grouped list. The pill should stand out from the track in the themes Telegram ships, light and dark; the device check confirms it.
  - Today and the viewer's solid fills are the button pair.
  - The selected day is text on background, swapped.
  - The dots, titles and pill text are the accent. The titles and pill text are pulled a fifth towards the text colour, a floor like D's `--ch-muted`.
  - Telegram has no partner colour, so the partner's shades are fixed orange, like D's person chip (`--ch-chip-*`).
- **The contrast**, on the fallbacks (light / dark, without color-mix), as the smoke's #9 computes it:

  | Pair | Light | Dark |
  |---|---|---|
  | selected tab text | 17.1 | 10.8 |
  | unselected tab label | 5.6 | 6.6 |
  | mine soft text | 11.0 | 9.6 |
  | mine solid text | 6.1 | 5.2 |
  | partner soft text | 8.0 | 9.1 |
  | partner line text | 9.0 | 10.7 |
  | today text | 6.1 | 5.2 |
  | selected-day text | 17.1 | 16.0 |
  | pill text | 7.5 | 7.8 |
  | month title | 8.2 | 8.8 |

  With color-mix, four text pairs change (light / dark): the unselected tab label 7.4 / 8.1, mine soft text 8.5 / 7.5, the pill text 6.8 / 8.7 and the month title 7.6 / 10.0. The marks:
  - the dots: 6.1 / 8.8 (mine), 5.0 / 7.7 (partner);
  - the partner's line: 4.7 / 6.7 on the page, 3.5 / 4.7 on the partner's soft fill;
  - the solid fills on the page: 6.1 / 3.5.
- **The smoke's resolver** is a small cascade over HOME_THEME_CSS and globals.css's `:root` tokens:
  - `var()` with fallbacks;
  - `color-mix(in srgb, A p%, B)`, mixed on the 0–255 values, as `in srgb` does;
  - WCAG relative luminance.

  The mapping check (#8) sets every Telegram param to a different grey and records which params each token reads.

- [ ] **Step 1: Add the failing swipe checks to `scripts/smoke-telegram-ui.ts`**

Six edits, in this order. Line numbers are the file's before the first edit.

**1.** In `scripts/smoke-telegram-ui.ts`, lines 9-14: the header names the swipe hook and the release. Before:
```ts
//   Telegram and prefers-color-scheme in a browser.
// - onTelegramEvent and openExternalLink, for the home's foreground refetch and
//   "Open in Google Calendar".
// Every SDK call is gated with isVersionAtLeast and wrapped in try/catch: a 6.0 client,
// a browser (the SDK defines Telegram.WebApp there too, at 6.0) or a throwing method
// never breaks the page.
```
After:
```ts
//   Telegram and prefers-color-scheme in a browser.
// - onTelegramEvent and openExternalLink, for the home's foreground refetch and
//   "Open in Google Calendar".
// - useTelegramVerticalSwipes(locked) (Plan E Ruling 9, Bot API 7.7): disable while
//   locked, enable when not, on an unlocked mount and on unmount; one call per change;
//   never a read of isVerticalSwipesEnabled. releaseTelegramControls(), before a reload:
//   the BackButton let go, then swipes enabled.
// Every SDK call is gated with isVersionAtLeast and wrapped in try/catch: a 6.0 client,
// a browser (the SDK defines Telegram.WebApp there too, at 6.0) or a throwing method
// never breaks the page.
```

**2.** In `scripts/smoke-telegram-ui.ts`, lines 146-155: the fake records what the swipe calls left the swipes at, and counts reads of the flag. Before:
```ts
/**
 * A fake Telegram.WebApp that records every call (handlers as fn1, fn2… so offClick can
 * be matched to its onClick) and keeps event handlers in a set per event, as the SDK
 * does. Methods named in `throwOn` throw after recording.
 */
function fakeTelegram(o: { version: string; initData?: string; colorScheme?: 'light' | 'dark'; throwOn?: string[] }) {
  const calls: string[] = [];
  const handlers = new Map<string, Set<() => void>>();
  const ids = new Map<unknown, string>();
  const label = (a: unknown) => {
```
After:
```ts
/**
 * A fake Telegram.WebApp that records every call (handlers as fn1, fn2… so offClick can
 * be matched to its onClick) and keeps event handlers in a set per event, as the SDK
 * does. Methods named in `throwOn` throw after recording. Its isVerticalSwipesEnabled is
 * a getter that counts the read and throws: the home must never read it (spec §7.6).
 * `swipes()` is what the calls left them at (null before any call).
 */
function fakeTelegram(o: { version: string; initData?: string; colorScheme?: 'light' | 'dark'; throwOn?: string[] }) {
  const calls: string[] = [];
  let swipes: boolean | null = null;
  let flagReads = 0;
  const handlers = new Map<string, Set<() => void>>();
  const ids = new Map<unknown, string>();
  const label = (a: unknown) => {
```

**3.** In `scripts/smoke-telegram-ui.ts`, lines 178-183: the fake gets both swipe methods. Before:
```ts
    onEvent: rec('onEvent', (type, h) => on(String(type), h as unknown as () => void)),
    offEvent: rec('offEvent', (type, h) => off(String(type), h as unknown as () => void)),
    openLink: rec('openLink'),
    BackButton: {
      isVisible: false,
      onClick: rec('BackButton.onClick', h => on('backButtonClicked', h as unknown as () => void)),
```
After:
```ts
    onEvent: rec('onEvent', (type, h) => on(String(type), h as unknown as () => void)),
    offEvent: rec('offEvent', (type, h) => off(String(type), h as unknown as () => void)),
    openLink: rec('openLink'),
    enableVerticalSwipes: rec('enableVerticalSwipes', () => { swipes = true; }),
    disableVerticalSwipes: rec('disableVerticalSwipes', () => { swipes = false; }),
    BackButton: {
      isVisible: false,
      onClick: rec('BackButton.onClick', h => on('backButtonClicked', h as unknown as () => void)),
```

**4.** In `scripts/smoke-telegram-ui.ts`, lines 186-196: `isVerticalSwipesEnabled` is a getter that counts the read and throws, and the fake returns `swipes()` and `flagReads()`. Before:
```ts
      hide: rec('BackButton.hide', () => { webApp.BackButton.isVisible = false; }),
    },
  };
  return {
    webApp,
    calls,
    fire: (type: string) => [...(handlers.get(type) ?? [])].forEach(h => h()),
    count: (type: string) => handlers.get(type)?.size ?? 0,
  };
}

```
After:
```ts
      hide: rec('BackButton.hide', () => { webApp.BackButton.isVisible = false; }),
    },
  };
  Object.defineProperty(webApp, 'isVerticalSwipesEnabled', {
    get() {
      flagReads++;
      throw new Error('isVerticalSwipesEnabled was read');
    },
  });
  return {
    webApp,
    calls,
    fire: (type: string) => [...(handlers.get(type) ?? [])].forEach(h => h()),
    count: (type: string) => handlers.get(type)?.size ?? 0,
    swipes: () => swipes,
    flagReads: () => flagReads,
  };
}

```

**5.** In `scripts/smoke-telegram-ui.ts`, lines 243-255: `main` takes the two new exports and gets a probe for the hook. Before Task E4 they don't exist, and a probe calling one would throw while rendering, so each check first asserts they are functions. Before:
```ts
}

async function main() {
  const { useTelegramBackButton, useTelegramTheme } = await ui().catch(() => ({} as Row));

  function BackProbe(props: { active: boolean; onBack: () => void }) {
    useTelegramBackButton(props.active, props.onBack);
    return null;
  }
  const back = (active: boolean, onBack: () => void) => React.createElement(BackProbe, { active, onBack });

  function ThemeProbe(props: { seen: string[] }) {
    props.seen.push(useTelegramTheme());
```
After:
```ts
}

async function main() {
  const { useTelegramBackButton, useTelegramTheme, useTelegramVerticalSwipes, releaseTelegramControls } = await ui().catch(() => ({} as Row));

  function BackProbe(props: { active: boolean; onBack: () => void }) {
    useTelegramBackButton(props.active, props.onBack);
    return null;
  }
  const back = (active: boolean, onBack: () => void) => React.createElement(BackProbe, { active, onBack });

  function SwipeProbe(props: { locked: boolean }) {
    useTelegramVerticalSwipes(props.locked);
    return null;
  }
  const swipes = (locked: boolean) => React.createElement(SwipeProbe, { locked });
  const strict = (locked: boolean) => React.createElement(React.StrictMode, null, swipes(locked));
  /** The E4 exports exist (before Task E4 they don't, and a probe calling one would throw while rendering). */
  const swipesExported = () => {
    assert(typeof useTelegramVerticalSwipes === 'function', 'useTelegramVerticalSwipes is not exported');
    assert(typeof releaseTelegramControls === 'function', 'releaseTelegramControls is not exported');
  };
  const swipeCalls = (calls: string[]) => calls.filter(c => c.includes('VerticalSwipes'));

  function ThemeProbe(props: { seen: string[] }) {
    props.seen.push(useTelegramTheme());
```

**6.** In `scripts/smoke-telegram-ui.ts`, lines 496-501: checks #15–#19 go after #14. Before:
```ts
    assert(show(got) === show({ browserSdk: false, noSdk: false, sdk: true, hash: true }), show(got));
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
```
After:
```ts
    assert(show(got) === show({ browserSdk: false, noSdk: false, sdk: true, hash: true }), show(got));
  });

  await check('#15 vertical swipes on a 7.6 client and in a browser (SDK at 6.0, no initData): no swipe call, locked or not, mounted or not; none during a server render; with no SDK nothing throws', async () => {
    await ui();
    swipesExported();
    for (const tg of [fakeTelegram({ version: '7.6' }), fakeTelegram({ version: '6.0', initData: '' })]) {
      await withEnv({ webApp: tg.webApp }, () => {
        const view = mount(swipes(false));
        view.render(swipes(true));
        view.render(swipes(false));
        view.render(swipes(true));
        view.unmount();
        releaseTelegramControls();
        assert(swipeCalls(tg.calls).length === 0, `${tg.webApp.initData ? '7.6 client' : 'browser'}: ${show(tg.calls)}`);
      });
    }
    const tg = fakeTelegram({ version: '8.0' });
    await withEnv({ webApp: tg.webApp }, () => {
      renderToString(React.createElement(React.Fragment, null, swipes(true), swipes(false)));
      assert(tg.calls.length === 0, `calls during a server render: ${show(tg.calls)}`);
    });
    await withEnv({ webApp: null }, () => {
      const view = mount(swipes(true));
      view.render(swipes(false));
      view.unmount();
      releaseTelegramControls();
    });
  });

  await check('#16 vertical swipes on 7.7, 7.10 and 8.0: an unlocked mount enables (a reload can leave them off); lock → disable, unlock → enable, one call per change and none on a re-render; a locked mount only disables; unmount enables; under StrictMode the state still ends as asked', async () => {
    await ui();
    swipesExported();
    for (const version of ['7.7', '7.10', '8.0']) {
      const tg = fakeTelegram({ version });
      await withEnv({ webApp: tg.webApp }, () => {
        const view = mount(swipes(false));
        assert(show(tg.calls) === show(['enableVerticalSwipes()']), `${version} unlocked mount: ${show(tg.calls)}`);
        view.render(swipes(true));
        view.render(swipes(true));
        assert(show(tg.calls.slice(1)) === show(['disableVerticalSwipes()']) && tg.swipes() === false, `${version} lock: ${show(tg.calls)}`);
        view.render(swipes(false));
        view.render(swipes(false));
        assert(show(tg.calls.slice(2)) === show(['enableVerticalSwipes()']) && tg.swipes() === true, `${version} unlock: ${show(tg.calls)}`);
        view.render(swipes(true));
        view.unmount();
        assert(show(tg.calls.slice(3)) === show(['disableVerticalSwipes()', 'enableVerticalSwipes()']) && tg.swipes() === true, `${version} lock, then unmount: ${show(tg.calls)}`);
      });
    }
    const locked = fakeTelegram({ version: '7.7' });
    await withEnv({ webApp: locked.webApp }, () => {
      const view = mount(swipes(true));
      assert(show(locked.calls) === show(['disableVerticalSwipes()']), `locked mount: ${show(locked.calls)}`);
      view.unmount();
      assert(show(locked.calls) === show(['disableVerticalSwipes()', 'enableVerticalSwipes()']), `locked unmount: ${show(locked.calls)}`);
    });
    const twice = fakeTelegram({ version: '7.7' });
    await withEnv({ webApp: twice.webApp }, () => {
      const view = mount(strict(true));
      assert(twice.swipes() === false, `StrictMode locked mount: ${show(twice.calls)}`);
      view.render(strict(false));
      assert(twice.swipes() === true, `StrictMode unlock: ${show(twice.calls)}`);
      view.render(strict(true));
      assert(twice.swipes() === false, `StrictMode lock: ${show(twice.calls)}`);
      view.unmount();
      assert(twice.swipes() === true, `StrictMode unmount: ${show(twice.calls)}`);
    });
  });

  await check('#17 isVerticalSwipesEnabled is never read (it is wrong after a reload): a getter that throws is never touched through mount, lock, unlock, unmount and releaseTelegramControls', async () => {
    await ui();
    swipesExported();
    const tg = fakeTelegram({ version: '8.0' });
    await withEnv({ webApp: tg.webApp }, warnings => {
      const view = mount(swipes(true));
      view.render(swipes(false));
      view.render(swipes(true));
      view.unmount();
      releaseTelegramControls();
      assert(tg.flagReads() === 0, `isVerticalSwipesEnabled read ${tg.flagReads()} times`);
      assert(warnings.length === 0, `warnings ${show(warnings)}`);
      assert(
        show(swipeCalls(tg.calls)) === show(['disableVerticalSwipes()', 'enableVerticalSwipes()', 'disableVerticalSwipes()', 'enableVerticalSwipes()', 'enableVerticalSwipes()']),
        `calls ${show(tg.calls)}`,
      );
    });
  });

  await check('#18 a swipe call that throws is logged, never raised: a throwing disableVerticalSwipes on a locked mount still lets an unlock enable; a throwing enableVerticalSwipes on mount and on unmount is logged each time', async () => {
    await ui();
    swipesExported();
    const disables = fakeTelegram({ version: '7.7', throwOn: ['disableVerticalSwipes'] });
    await withEnv({ webApp: disables.webApp }, warnings => {
      const view = mount(swipes(true));
      assert(warnings.some(w => w.startsWith('[telegram-ui] disableVerticalSwipes failed:') && w.includes('disableVerticalSwipes threw')), `warnings ${show(warnings)}`);
      view.render(swipes(false));
      assert(disables.swipes() === true, `after the unlock: ${show(disables.calls)}`);
      view.unmount();
    });
    const enables = fakeTelegram({ version: '7.7', throwOn: ['enableVerticalSwipes'] });
    await withEnv({ webApp: enables.webApp }, warnings => {
      const view = mount(swipes(false));
      view.render(swipes(true));
      view.unmount();
      assert(show(enables.calls) === show(['enableVerticalSwipes()', 'disableVerticalSwipes()', 'enableVerticalSwipes()']), `calls ${show(enables.calls)}`);
      assert(warnings.filter(w => w.includes('enableVerticalSwipes threw')).length === 2, `warnings ${show(warnings)}`);
    });
  });

  await check('#19 releaseTelegramControls, before a reload (outside React): offClick(the live handler) and hide(), then enableVerticalSwipes(); a 7.6 client gets the BackButton calls only; a throwing hide() still enables; with no SDK nothing throws', async () => {
    await ui();
    assert(typeof releaseTelegramControls === 'function', 'releaseTelegramControls is not exported');
    const tg = fakeTelegram({ version: '8.0' });
    await withEnv({ webApp: tg.webApp }, () => {
      const view = mount(back(true, noop));
      const before = tg.calls.length;
      releaseTelegramControls();
      assert(show(tg.calls.slice(before)) === show(['BackButton.offClick(fn1)', 'BackButton.hide()', 'enableVerticalSwipes()']), `release: ${show(tg.calls)}`);
      assert(!tg.webApp.BackButton.isVisible && tg.count('backButtonClicked') === 0 && tg.swipes() === true, 'the button still shown or registered, or swipes not enabled');
      view.unmount();
    });
    const old = fakeTelegram({ version: '7.6' });
    await withEnv({ webApp: old.webApp }, () => {
      releaseTelegramControls();
      assert(show(old.calls) === show(['BackButton.hide()']), `7.6: ${show(old.calls)}`);
    });
    const hides = fakeTelegram({ version: '7.7', throwOn: ['BackButton.hide'] });
    await withEnv({ webApp: hides.webApp }, warnings => {
      releaseTelegramControls();
      assert(show(hides.calls) === show(['BackButton.hide()', 'enableVerticalSwipes()']) && hides.swipes() === true, `after a throwing hide(): ${show(hides.calls)}`);
      assert(warnings.some(w => w.includes('BackButton.hide threw')), `warnings ${show(warnings)}`);
    });
    await withEnv({ webApp: null }, () => releaseTelegramControls());
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
```

- [ ] **Step 2: Run it and see the five new checks fail**

```bash
cd /Users/razielgershoni/development/famcalbot
for tz in UTC Asia/Jerusalem; do for s in smoke-telegram-ui; do TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/$s.ts 2>&1 | grep -E '^FAIL|passed|Cannot find module' | sed -e 's/ — .*//' -e "s#^Error: Cannot find module '\([^']*\)'.*#Error: Cannot find module '\1'#"; echo "$s $tz exit=${pipestatus[1]}"; done; done
```
(Run it in zsh: `pipestatus` is zsh's. In bash, use `${PIPESTATUS[0]}`.)

Expected:
```
FAIL  #15 vertical swipes on a 7.6 client and in a browser (SDK at 6.0, no initData): no swipe call, locked or not, mounted or not; none during a server render; with no SDK nothing throws
FAIL  #16 vertical swipes on 7.7, 7.10 and 8.0: an unlocked mount enables (a reload can leave them off); lock → disable, unlock → enable, one call per change and none on a re-render; a locked mount only disables; unmount enables; under StrictMode the state still ends as asked
FAIL  #17 isVerticalSwipesEnabled is never read (it is wrong after a reload): a getter that throws is never touched through mount, lock, unlock, unmount and releaseTelegramControls
FAIL  #18 a swipe call that throws is logged, never raised: a throwing disableVerticalSwipes on a locked mount still lets an unlock enable; a throwing enableVerticalSwipes on mount and on unmount is logged each time
FAIL  #19 releaseTelegramControls, before a reload (outside React): offClick(the live handler) and hide(), then enableVerticalSwipes(); a 7.6 client gets the BackButton calls only; a throwing hide() still enables; with no SDK nothing throws
14/19 passed (process TZ=UTC)
smoke-telegram-ui UTC exit=1
FAIL  #15 vertical swipes on a 7.6 client and in a browser (SDK at 6.0, no initData): no swipe call, locked or not, mounted or not; none during a server render; with no SDK nothing throws
FAIL  #16 vertical swipes on 7.7, 7.10 and 8.0: an unlocked mount enables (a reload can leave them off); lock → disable, unlock → enable, one call per change and none on a re-render; a locked mount only disables; unmount enables; under StrictMode the state still ends as asked
FAIL  #17 isVerticalSwipesEnabled is never read (it is wrong after a reload): a getter that throws is never touched through mount, lock, unlock, unmount and releaseTelegramControls
FAIL  #18 a swipe call that throws is logged, never raised: a throwing disableVerticalSwipes on a locked mount still lets an unlock enable; a throwing enableVerticalSwipes on mount and on unmount is logged each time
FAIL  #19 releaseTelegramControls, before a reload (outside React): offClick(the live handler) and hide(), then enableVerticalSwipes(); a 7.6 client gets the BackButton calls only; a throwing hide() still enables; with no SDK nothing throws
14/19 passed (process TZ=Asia/Jerusalem)
smoke-telegram-ui Asia/Jerusalem exit=1
```
Why: #15–#18 stop at "useTelegramVerticalSwipes is not exported", and #19 at "releaseTelegramControls is not exported". #1–#14 pass as before. `npx tsc --noEmit -p .` stays clean, because the smoke reads the module as `Row`.

- [ ] **Step 3: Write the failing smoke `scripts/smoke-calendar-home-tabs.ts`**

This smoke covers HomeTabs (markup, real React and CSS), the storage helpers, the tokens and their contrast, and HomeErrorBoundary's release. It copies the fake DOM and `mount` from `scripts/smoke-calendar-home-render.ts`; its `key()` also returns the event, so a check can see whether a key was taken.

Create `scripts/smoke-calendar-home-tabs.ts` with exactly this content:

```ts
// Smoke test for the calendar home's tab bar, its memory and the Month's colours (Plan E,
// Task E4; spec §7.1 State and Look, §7.4 Memory, §7.6, §7.7; Plan E Rulings 1, 2 and 9):
//  - HomeTabs (app/[locale]/dashboard/HomeTabs.tsx) in en, he and ru: one tablist named
//    by tabs.label, two tabs with their ids, aria-selected, aria-controls naming their
//    panels and a roving tabIndex, the labels, dir="rtl" in Hebrew only;
//  - in real React (react-dom/client with act on a small fake DOM): a tap selects the
//    other tab and a tap on the selected one does nothing; the arrow keys follow the
//    reading direction (mirrored in Hebrew) and wrap, Home and End go to the ends, focus
//    follows, and only those keys are taken;
//  - its CSS: every tab at least 44 px tall, nothing under 11 px, logical properties
//    only, no hover, the selected tab told apart by weight as well as colour, and only
//    tokens home-theme.ts defines;
//  - the storage helpers (src/lib/calendar-view/home-storage.ts): the per-user keys, the
//    tab in sessionStorage and the layout in localStorage, and their defaults with no
//    window, with storage that throws (on the property, on get, on set) and for unknown
//    values;
//  - the Month's colour tokens in home-theme.ts: each in light and dark; on Telegram's
//    theme params where one fits (resolved with every param set); the contrast floor on
//    the fallbacks, with and without color-mix (4.5:1 for text, 3:1 for the marks that
//    tell the viewer's items from the partner's);
//  - HomeErrorBoundary: a chunk-load error lets Telegram's BackButton and vertical swipes
//    go before its one reload (releaseTelegramControls), and its card turns swipes back on.
// React must log no warning. No network, no DB, no Redis.
//
// Run with the fake env from the task brief (no dotenv), under two clocks:
//   TZ=UTC npx tsx scripts/smoke-calendar-home-tabs.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-calendar-home-tabs.ts

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import React, { createElement, type ComponentProps, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { HomeTabs, PANEL_IDS, TAB_IDS, TABS_CSS } from '../app/[locale]/dashboard/HomeTabs';
import { HOME_THEME_CSS } from '../app/[locale]/dashboard/home-theme';
import { CHUNK_RELOAD_KEY, HomeErrorBoundary } from '../app/[locale]/dashboard/HomeErrorBoundary';
import { useTelegramBackButton } from '../src/lib/telegram-ui';
import { homeTabKey, monthLayoutKey, readHomeTab, readMonthLayout, writeHomeTab, writeMonthLayout, type HomeTab } from '../src/lib/calendar-view/home-storage';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const ROOT = path.resolve(__dirname, '..');
const nodeRequire = createRequire(__filename);
const LOCALES = ['en', 'he', 'ru'] as const;
type Locale = (typeof LOCALES)[number];

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

const show = (value: unknown) => JSON.stringify(value);
const noop = () => undefined;
const messages: Record<Locale, Row> = {
  en: JSON.parse(fs.readFileSync(path.join(ROOT, 'messages/en.json'), 'utf8')),
  he: JSON.parse(fs.readFileSync(path.join(ROOT, 'messages/he.json'), 'utf8')),
  ru: JSON.parse(fs.readFileSync(path.join(ROOT, 'messages/ru.json'), 'utf8')),
};

// ---- React must not warn ----

const reactWarnings: string[] = [];
/** The app's own log lines (the error boundary's): a check expects one; they are never React's. */
const appLogs: string[] = [];
for (const level of ['error', 'warn'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    const text = args.map(String).join(' ');
    if (text.startsWith('[telegram-ui]')) return original(...args);
    // Node's own warnings (tsx's module.register() deprecation on Node 26 lands here, at a time that varies) aren't React's.
    if (text.startsWith('(node:')) return original(...args);
    if (text.startsWith('[calendar-home]')) {
      appLogs.push(text.slice(0, 300));
      return;
    }
    reactWarnings.push(text.slice(0, 300));
  };
}

// ---- Rendering ----

function inIntl(locale: Locale, el: ReactElement): ReactElement {
  // The provider's props type makes children required; createElement takes them as its third argument.
  const provider = { locale, messages: messages[locale], timeZone: 'Asia/Jerusalem' } as ComponentProps<typeof NextIntlClientProvider>;
  return createElement(NextIntlClientProvider, provider, el);
}

const renderTabs = (locale: Locale, tab: HomeTab) => renderToString(inIntl(locale, createElement(HomeTabs, { tab, onTab: noop })));

/** An attribute of one opening tag, or null. */
const attr = (tag: string, name: string) => new RegExp(` ${name}="([^"]*)"`).exec(tag)?.[1] ?? null;

/** The text a reader sees: tags and React's text separators out, spaces collapsed. */
const textOf = (html: string) =>
  html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/g, ' ')
    .replace(/<!-- -->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** HomeTabs as the container holds it: the tab in state; `seen` records each onTab. */
function TabsHost({ start, seen }: { start: HomeTab; seen: HomeTab[] }) {
  const [tab, setTab] = React.useState<HomeTab>(start);
  return createElement(HomeTabs, {
    tab,
    onTab: (next: HomeTab) => {
      seen.push(next);
      setTab(next);
    },
  });
}

// ---- A small fake DOM for react-dom/client (no jsdom in node_modules), as in smoke-calendar-home-render.ts ----

const HTML_NS = 'http://www.w3.org/1999/xhtml';
type Listener = { type: string; capture: boolean; fn: (event: Row) => void };

class FakeNode {
  parentNode: FakeNode | null = null;
  childNodes: FakeNode[] = [];
  listeners: Listener[] = [];
  constructor(
    public nodeType: number,
    public nodeName: string,
  ) {}
  get ownerDocument(): Row {
    return fakeDocument;
  }
  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }
  get lastChild(): FakeNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }
  get nextSibling(): FakeNode | null {
    const siblings = this.parentNode?.childNodes ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
  get parentElement(): FakeNode | null {
    return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
  }
  appendChild(child: FakeNode): FakeNode {
    child.parentNode?.removeChild(child);
    this.childNodes.push(child);
    child.parentNode = this;
    return child;
  }
  insertBefore(child: FakeNode, before: FakeNode | null): FakeNode {
    if (!before) return this.appendChild(child);
    child.parentNode?.removeChild(child);
    this.childNodes.splice(this.childNodes.indexOf(before), 0, child);
    child.parentNode = this;
    return child;
  }
  removeChild(child: FakeNode): FakeNode {
    const i = this.childNodes.indexOf(child);
    if (i >= 0) this.childNodes.splice(i, 1);
    child.parentNode = null;
    return child;
  }
  get textContent(): string {
    return this.childNodes.map((c) => c.textContent).join('');
  }
  set textContent(value: string) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    if (value) this.appendChild(new FakeText(String(value)));
  }
  addEventListener(type: string, fn: (event: Row) => void, options?: boolean | { capture?: boolean }) {
    const capture = typeof options === 'boolean' ? options : !!options?.capture;
    this.listeners.push({ type, capture, fn });
  }
  removeEventListener(type: string, fn: (event: Row) => void) {
    this.listeners = this.listeners.filter((l) => l.type !== type || l.fn !== fn);
  }
}

class FakeText extends FakeNode {
  constructor(public data: string) {
    super(3, '#text');
  }
  get nodeValue(): string {
    return this.data;
  }
  set nodeValue(value: string) {
    this.data = String(value);
  }
  get textContent(): string {
    return this.data;
  }
  set textContent(value: string) {
    this.data = String(value);
  }
}

class FakeElement extends FakeNode {
  tagName: string;
  attributes = new Map<string, string>();
  style: Row = { setProperty(k: string, v: string) { this[k] = v; }, removeProperty(k: string) { delete this[k]; } };
  constructor(
    public localName: string,
    public namespaceURI: string,
  ) {
    super(1, namespaceURI === HTML_NS ? localName.toUpperCase() : localName);
    this.tagName = this.nodeName;
  }
  setAttribute(name: string, value: unknown) {
    this.attributes.set(name, String(value));
  }
  setAttributeNS(_ns: string | null, name: string, value: unknown) {
    this.setAttribute(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  removeAttributeNS(_ns: string | null, name: string) {
    this.attributes.delete(name);
  }
  get className(): string {
    return this.getAttribute('class') ?? '';
  }
  set className(value: string) {
    this.setAttribute('class', value);
  }
  focus() {
    fakeDocument.activeElement = this;
  }
  blur() {
    if (fakeDocument.activeElement === this) fakeDocument.activeElement = fakeDocument.body;
  }
}

const fakeDocument: Row = {
  nodeType: 9,
  nodeName: '#document',
  documentElement: { nodeType: 1, nodeName: 'HTML' },
  createElement: (tag: string) => new FakeElement(String(tag).toLowerCase(), HTML_NS),
  createElementNS: (ns: string, tag: string) => new FakeElement(tag, ns),
  createTextNode: (text: string) => new FakeText(text),
  addEventListener: noop,
  removeEventListener: noop,
};
fakeDocument.body = new FakeElement('body', HTML_NS);
fakeDocument.activeElement = fakeDocument.body;

/** A Storage-like object over a Map. */
function memoryStorage(saved = new Map<string, string>()): Row {
  return {
    getItem: (k: string) => saved.get(k) ?? null,
    setItem: (k: string, v: string) => void saved.set(k, String(v)),
    removeItem: (k: string) => void saved.delete(k),
  };
}

const fakeWindow: Row = {
  document: fakeDocument,
  HTMLIFrameElement: class {},
  addEventListener: noop,
  removeEventListener: noop,
  location: { hash: '' },
  sessionStorage: memoryStorage(),
  localStorage: memoryStorage(),
};
fakeDocument.defaultView = fakeWindow;

const g = globalThis as Row;
function installWindow() {
  g.window = fakeWindow;
  g.document = fakeDocument;
  g.IS_REACT_ACT_ENVIRONMENT = true;
}

type Mounted = {
  container: FakeElement;
  render: (el: ReactElement) => void;
  click: (el: FakeNode) => void;
  /** A keydown on `el`; returns the event, to see whether it was taken (defaultPrevented). */
  key: (el: FakeNode, key: string) => Row;
  unmount: () => void;
};

function mount(el: ReactElement, rootOptions?: Row): Mounted {
  const { createRoot } = nodeRequire('react-dom/client');
  const container = new FakeElement('div', HTML_NS);
  const root = createRoot(container, rootOptions);
  React.act(() => root.render(el));
  const dispatch = (target: FakeNode, type: string, extra: Row): Row => {
    const event: Row = {
      type,
      target,
      srcElement: target,
      bubbles: true,
      cancelable: true,
      defaultPrevented: false,
      isTrusted: true,
      timeStamp: Date.now(),
      button: 0,
      buttons: 0,
      detail: 1,
      ...extra,
      preventDefault() {
        event.defaultPrevented = true;
      },
      stopPropagation: noop,
      stopImmediatePropagation: noop,
    };
    React.act(() => {
      fakeWindow.event = event;
      for (const capture of [true, false]) {
        for (const l of container.listeners.filter((x) => x.type === type && x.capture === capture)) l.fn(event);
      }
      fakeWindow.event = undefined;
    });
    return event;
  };
  return {
    container,
    render: (next) => React.act(() => root.render(next)),
    click: (target) => void dispatch(target, 'click', {}),
    key: (target, key) => dispatch(target, 'keydown', { key }),
    unmount: () => React.act(() => root.unmount()),
  };
}

function elements(node: FakeNode, out: FakeElement[] = []): FakeElement[] {
  for (const c of node.childNodes) {
    if (c instanceof FakeElement) {
      out.push(c);
      elements(c, out);
    }
  }
  return out;
}
const byRole = (node: FakeNode, role: string) => elements(node).filter((e) => e.getAttribute('role') === role);

/** The two tabs, Agenda first, and the selected one's label check. */
function tabsOf(m: Mounted): [FakeElement, FakeElement] {
  const tabs = byRole(m.container, 'tab');
  assert(tabs.length === 2 && tabs[0].getAttribute('id') === TAB_IDS.agenda && tabs[1].getAttribute('id') === TAB_IDS.month, `tabs: ${show(tabs.map((t) => t.getAttribute('id')))}`);
  return [tabs[0], tabs[1]];
}
const selectedOf = (m: Mounted) => byRole(m.container, 'tab').filter((t) => t.getAttribute('aria-selected') === 'true').map((t) => t.getAttribute('id'));
const tabIndexes = (m: Mounted) => byRole(m.container, 'tab').map((t) => t.getAttribute('tabindex'));

// ---- A fake Telegram.WebApp (records calls, as the SDK's methods are called) ----

/** Bot API versions compared as the SDK does: part by part, missing parts 0. */
function versionAtLeast(have: string, want: string): boolean {
  const a = have.split('.').map(Number);
  const b = want.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

function fakeTelegram(calls: string[], version: string): Row {
  const ids = new Map<unknown, string>();
  const label = (a: unknown) => {
    if (typeof a !== 'function') return String(a);
    if (!ids.has(a)) ids.set(a, `fn${ids.size + 1}`);
    return ids.get(a) as string;
  };
  const rec =
    (name: string) =>
    (...args: unknown[]) =>
      void calls.push(`${name}(${args.map(label).join(',')})`);
  return {
    initData: 'query_id=AAE&user=%7B%22id%22%3A5550001%7D&auth_date=1792000000&hash=abc',
    version,
    colorScheme: 'light',
    isVersionAtLeast: (v: string) => versionAtLeast(version, v),
    setHeaderColor: rec('setHeaderColor'),
    setBackgroundColor: rec('setBackgroundColor'),
    onEvent: rec('onEvent'),
    offEvent: rec('offEvent'),
    enableVerticalSwipes: rec('enableVerticalSwipes'),
    disableVerticalSwipes: rec('disableVerticalSwipes'),
    BackButton: { onClick: rec('BackButton.onClick'), offClick: rec('BackButton.offClick'), show: rec('BackButton.show'), hide: rec('BackButton.hide') },
  };
}

// ---- The theme's tokens, resolved the way a browser resolves them ----

/** Plan E's tokens (the split's list); E6 and E7 read only these and D's. */
const TOKENS = [
  '--ch-tab-track',
  '--ch-tab-on',
  '--ch-tab-on-text',
  '--ch-tab-shadow',
  '--ch-mine-soft',
  '--ch-mine-soft-text',
  '--ch-mine-solid',
  '--ch-mine-solid-text',
  '--ch-partner-soft',
  '--ch-partner-soft-text',
  '--ch-partner-line',
  '--ch-partner-line-text',
  '--ch-dot-mine',
  '--ch-dot-partner',
  '--ch-today',
  '--ch-today-text',
  '--ch-selected',
  '--ch-selected-text',
  '--ch-pill-bg',
  '--ch-pill-line',
  '--ch-pill-text',
  '--ch-disabled',
  '--ch-month-title',
] as const;

type Theme = 'light' | 'dark';
type Rgb = [number, number, number];
type Rule = { selectors: string[]; decls: [string, string][]; supports: boolean };

/** The top-level blocks of a style sheet: [prelude, body]. Comments out first. */
function cssBlocks(css: string): [string, string][] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: [string, string][] = [];
  let depth = 0;
  let preludeStart = 0;
  let bodyStart = 0;
  let prelude = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') {
      if (depth === 0) {
        prelude = text.slice(preludeStart, i).trim();
        bodyStart = i + 1;
      }
      depth++;
    } else if (text[i] === '}') {
      depth--;
      if (depth === 0) {
        out.push([prelude, text.slice(bodyStart, i)]);
        preludeStart = i + 1;
      }
    }
  }
  return out;
}

/** The custom properties a block body declares, in order. */
const customProps = (body: string): [string, string][] =>
  body
    .split(';')
    .map((d) => /^\s*(--[\w-]+)\s*:\s*([\s\S]+?)\s*$/.exec(d))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => [m[1], m[2]]);

/** The theme's rules in source order; the ones inside @supports (color-mix) marked. */
function themeRules(css: string): Rule[] {
  const rules: Rule[] = [];
  for (const [prelude, body] of cssBlocks(css)) {
    if (prelude.startsWith('@supports')) {
      for (const [inner, innerBody] of cssBlocks(body)) rules.push({ selectors: inner.split(',').map((s) => s.trim()), decls: customProps(innerBody), supports: true });
    } else if (!prelude.startsWith('@')) {
      rules.push({ selectors: prelude.split(',').map((s) => s.trim()), decls: customProps(body), supports: false });
    }
  }
  return rules;
}

/** The custom properties on .ch-home for a theme: the cascade over the two selectors the theme uses. */
function cascade(css: string, theme: Theme, colorMix: boolean): Map<string, string> {
  const specificity = (selector: string) => (selector === '.ch-home' ? 10 : selector === ".ch-home[data-theme='dark']" && theme === 'dark' ? 20 : 0);
  const won = new Map<string, { spec: number; value: string }>();
  for (const rule of themeRules(css)) {
    if (rule.supports && !colorMix) continue;
    const spec = Math.max(0, ...rule.selectors.map(specificity));
    if (spec === 0) continue;
    for (const [name, value] of rule.decls) {
      const prev = won.get(name);
      if (!prev || spec >= prev.spec) won.set(name, { spec, value });
    }
  }
  return new Map([...won].map(([k, v]) => [k, v.value]));
}

const GLOBALS = new Map(
  [...fs.readFileSync(path.join(ROOT, 'app/globals.css'), 'utf8').matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)].map((m) => [m[1], m[2].trim()] as [string, string]),
);

/** Splits a function's arguments at its top-level commas. */
function splitArgs(inner: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === '(') depth++;
    else if (inner[i] === ')') depth--;
    else if (inner[i] === ',' && depth === 0) {
      out.push(inner.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(inner.slice(start).trim());
  return out;
}

/** A resolver for one theme: a token's colour and the Telegram params it read. */
function resolver(theme: Theme, colorMix: boolean, tg: Record<string, string> = {}) {
  const props = cascade(HOME_THEME_CSS, theme, colorMix);
  let read = new Set<string>();
  const lookup = (name: string): string | null => {
    if (name.startsWith('--tg-')) {
      if (!(name in tg)) return null;
      read.add(name.replace(/^--tg-theme-|-color$/g, ''));
      return tg[name];
    }
    return props.get(name) ?? GLOBALS.get(name) ?? null;
  };
  const colour = (value: string, depth = 0): Rgb => {
    assert(depth < 20, `a var() loop at ${value}`);
    const v = value.trim();
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v);
    if (hex) {
      const h = hex[1].length === 3 ? hex[1].replace(/./g, (c) => c + c) : hex[1];
      return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;
    }
    if (v.startsWith('var(') && v.endsWith(')')) {
      const [name, ...fallback] = splitArgs(v.slice(4, -1));
      const found = lookup(name);
      if (found !== null) return colour(found, depth + 1);
      assert(fallback.length > 0, `${name} is unset and has no fallback`);
      return colour(fallback.join(','), depth + 1);
    }
    if (v.startsWith('color-mix(') && v.endsWith(')')) {
      const [space, a, b] = splitArgs(v.slice(10, -1));
      assert(space === 'in srgb', `color-mix space ${space}`);
      const pa = /^([\s\S]+?)\s+([\d.]+)%$/.exec(a);
      assert(pa && !/%$/.test(b), `color-mix form: ${v}`);
      const p = Number(pa[2]) / 100;
      const x = colour(pa[1], depth + 1);
      const y = colour(b, depth + 1);
      return [0, 1, 2].map((i) => x[i] * p + y[i] * (1 - p)) as Rgb;
    }
    throw new Error(`not a colour: ${v}`);
  };
  return {
    props,
    colour: (token: string) => colour(`var(${token})`),
    reads: (token: string) => {
      read = new Set();
      colour(`var(${token})`);
      return [...read].sort();
    },
  };
}

const linear = (c: number) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, gr, b]: Rgb) => 0.2126 * linear(r) + 0.7152 * linear(gr) + 0.0722 * linear(b);
function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Text on what it sits on: 4.5:1 (WCAG 1.4.3). */
const TEXT_PAIRS: [string, string][] = [
  ['--ch-tab-on-text', '--ch-tab-on'],
  ['--ch-muted', '--ch-tab-track'],
  ['--ch-mine-soft-text', '--ch-mine-soft'],
  ['--ch-mine-solid-text', '--ch-mine-solid'],
  ['--ch-partner-soft-text', '--ch-partner-soft'],
  ['--ch-partner-line-text', '--ch-bg'],
  ['--ch-today-text', '--ch-today'],
  ['--ch-selected-text', '--ch-selected'],
  ['--ch-pill-text', '--ch-pill-bg'],
  ['--ch-month-title', '--ch-bg'],
];
/** The marks that tell whose an item is without colour, and the solid fills: 3:1 (WCAG 1.4.11). */
const MARK_PAIRS: [string, string][] = [
  ['--ch-dot-mine', '--ch-bg'],
  ['--ch-dot-partner', '--ch-bg'],
  ['--ch-partner-line', '--ch-bg'],
  ['--ch-partner-line', '--ch-partner-soft'],
  ['--ch-mine-solid', '--ch-bg'],
  ['--ch-today', '--ch-bg'],
];

/** Every Telegram theme param the home maps, each a different grey, so the reads are unambiguous. */
const TG_ALL: Record<string, string> = Object.fromEntries(
  ['bg', 'text', 'hint', 'link', 'button', 'button-text', 'secondary-bg', 'header-bg', 'accent-text', 'section-bg', 'section-header-text', 'section-separator', 'subtitle-text', 'destructive-text'].map((n, i) => [
    `--tg-theme-${n}-color`,
    `#${(0x111111 * (i + 1)).toString(16).padStart(6, '0')}`,
  ]),
);

/** The Telegram params each token reads with color-mix, in light and dark alike ([] = a fixed shade: Telegram has no partner colour). */
const TG_READS: Record<string, string[]> = {
  '--ch-tab-track': ['secondary-bg'],
  '--ch-tab-on': ['section-bg'],
  '--ch-tab-on-text': ['text'],
  '--ch-mine-soft': ['accent-text', 'bg'],
  '--ch-mine-soft-text': ['accent-text', 'text'],
  '--ch-mine-solid': ['button'],
  '--ch-mine-solid-text': ['button-text'],
  '--ch-partner-soft': [],
  '--ch-partner-soft-text': [],
  '--ch-partner-line': [],
  '--ch-partner-line-text': [],
  '--ch-dot-mine': ['accent-text'],
  '--ch-dot-partner': [],
  '--ch-today': ['button'],
  '--ch-today-text': ['button-text'],
  '--ch-selected': ['text'],
  '--ch-selected-text': ['bg'],
  '--ch-pill-bg': ['accent-text', 'bg'],
  '--ch-pill-line': ['accent-text', 'bg'],
  '--ch-pill-text': ['accent-text', 'text'],
  '--ch-disabled': ['bg', 'hint'],
  '--ch-month-title': ['accent-text', 'text'],
};

// ---- The checks ----

async function main() {
  await check('#1 HomeTabs in en, he and ru: one tablist named by tabs.label; two tabs (type="button") with their ids, aria-selected, aria-controls naming their panels and a roving tabIndex (0 on the selected one only); the labels; dir="rtl" in Hebrew only; its own style sheet', () => {
    assert(
      show(TAB_IDS) === show({ agenda: 'ch-tab-agenda', month: 'ch-tab-month' }) && show(PANEL_IDS) === show({ agenda: 'ch-panel-agenda', month: 'ch-panel-month' }),
      `ids ${show(TAB_IDS)} ${show(PANEL_IDS)}`,
    );
    for (const locale of LOCALES) {
      const copy = messages[locale].calendarHome.tabs;
      for (const tab of ['agenda', 'month'] as const) {
        const html = renderTabs(locale, tab);
        const where = `${locale}, ${tab}`;
        const lists = html.match(/<div[^>]*role="tablist"[^>]*>/g) ?? [];
        assert(lists.length === 1, `${where}: ${lists.length} tablists`);
        assert(attr(lists[0], 'aria-label') === copy.label, `${where}: the tablist's name ${attr(lists[0], 'aria-label')}`);
        assert(attr(lists[0], 'dir') === (locale === 'he' ? 'rtl' : 'ltr'), `${where}: dir ${attr(lists[0], 'dir')}`);
        const buttons = [...html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)];
        assert(buttons.length === 2, `${where}: ${buttons.length} buttons`);
        (['agenda', 'month'] as const).forEach((id, i) => {
          const open = buttons[i][1];
          const on = id === tab;
          const got = { role: attr(open, 'role'), type: attr(open, 'type'), id: attr(open, 'id'), selected: attr(open, 'aria-selected'), controls: attr(open, 'aria-controls'), tabIndex: attr(open, 'tabindex'), text: textOf(buttons[i][2]) };
          const want = { role: 'tab', type: 'button', id: TAB_IDS[id], selected: String(on), controls: PANEL_IDS[id], tabIndex: on ? '0' : '-1', text: copy[id] };
          assert(show(got) === show(want), `${where}, the ${id} tab: ${show(got)}, want ${show(want)}`);
        });
        assert(/^<style>[\s\S]*\.ch-tab[\s\S]*<\/style><div/.test(html), `${where}: its own style sheet first`);
        assert(!/calendarHome\.|tabs\./.test(textOf(html)), `${where}: an untranslated key`);
      }
    }
    assert(messages.he.calendarHome.tabs.agenda === 'סדר יום' && messages.he.calendarHome.tabs.month === 'חודש', 'the Hebrew labels (the split)');
  });

  await check('#2 in real React: a tap on the other tab calls onTab with it, and the selection and the tab order follow; a tap on the selected tab calls nothing', () => {
    installWindow();
    const seen: HomeTab[] = [];
    const m = mount(inIntl('en', createElement(TabsHost, { start: 'agenda', seen })));
    try {
      const [agenda, month] = tabsOf(m);
      m.click(month.childNodes[0]);
      assert(show(seen) === show(['month']), `tap Month: ${show(seen)}`);
      assert(show(selectedOf(m)) === show([TAB_IDS.month]) && show(tabIndexes(m)) === show(['-1', '0']), `after the tap: ${show(selectedOf(m))} ${show(tabIndexes(m))}`);
      m.click(month);
      assert(show(seen) === show(['month']), `a tap on the selected tab: ${show(seen)}`);
      m.click(agenda);
      assert(show(seen) === show(['month', 'agenda']) && show(selectedOf(m)) === show([TAB_IDS.agenda]) && show(tabIndexes(m)) === show(['0', '-1']), `tap Agenda: ${show(seen)} ${show(selectedOf(m))}`);
    } finally {
      m.unmount();
    }
  });

  await check('#3 in real React, English and Russian: ArrowRight goes to the next tab and ArrowLeft to the previous one, both wrapping; Home and End go to the first and last; a key on the unselected tab moves from that tab; focus follows and each of those keys is taken; ArrowUp, ArrowDown, Enter, Space, Tab and letters are left alone', () => {
    installWindow();
    for (const locale of ['en', 'ru'] as const) {
      const seen: HomeTab[] = [];
      const m = mount(inIntl(locale, createElement(TabsHost, { start: 'agenda', seen })));
      try {
        const [agenda, month] = tabsOf(m);
        const steps: [FakeElement, string, HomeTab, FakeElement][] = [
          [agenda, 'ArrowRight', 'month', month],
          [month, 'ArrowRight', 'agenda', agenda],
          [agenda, 'ArrowLeft', 'month', month],
          [month, 'ArrowLeft', 'agenda', agenda],
          [agenda, 'End', 'month', month],
          [month, 'Home', 'agenda', agenda],
        ];
        for (const [from, key, to, focused] of steps) {
          const event = m.key(from, key);
          assert(seen[seen.length - 1] === to && show(selectedOf(m)) === show([TAB_IDS[to]]), `${locale} ${key}: ${show(seen)} ${show(selectedOf(m))}`);
          assert(fakeDocument.activeElement === focused, `${locale} ${key}: focus on ${fakeDocument.activeElement?.getAttribute?.('id')}`);
          assert(event.defaultPrevented, `${locale} ${key} was not taken`);
        }
        const count = seen.length;
        const home = m.key(agenda, 'Home');
        assert(seen.length === count && home.defaultPrevented && fakeDocument.activeElement === agenda, `Home on the first tab: ${show(seen)}`);
        // Focus on the unselected Month (a screen reader can put it there): the previous tab from it is the Agenda, already selected.
        const other = m.key(month, 'ArrowLeft');
        assert(seen.length === count && other.defaultPrevented && fakeDocument.activeElement === agenda, `ArrowLeft on the unselected Month: ${show(seen)}`);
        for (const key of ['ArrowUp', 'ArrowDown', 'Enter', ' ', 'Tab', 'a']) {
          const event = m.key(agenda, key);
          assert(!event.defaultPrevented && seen.length === count, `${locale} ${show(key)} was taken: ${show(seen)}`);
        }
      } finally {
        m.unmount();
      }
    }
  });

  await check('#4 in real React, Hebrew (RTL): the arrows follow the reading direction, so ArrowLeft goes to the next tab and ArrowRight to the previous one, both wrapping; Home and End as in English', () => {
    installWindow();
    const seen: HomeTab[] = [];
    const m = mount(inIntl('he', createElement(TabsHost, { start: 'agenda', seen })));
    try {
      const [agenda, month] = tabsOf(m);
      m.key(agenda, 'ArrowLeft');
      assert(show(seen) === show(['month']) && fakeDocument.activeElement === month, `ArrowLeft from the Agenda: ${show(seen)}`);
      m.key(month, 'ArrowRight');
      assert(show(seen) === show(['month', 'agenda']) && fakeDocument.activeElement === agenda, `ArrowRight from the Month: ${show(seen)}`);
      m.key(agenda, 'ArrowRight');
      assert(show(seen) === show(['month', 'agenda', 'month']), `ArrowRight from the Agenda wraps to the Month: ${show(seen)}`);
      m.key(month, 'ArrowLeft');
      assert(show(seen) === show(['month', 'agenda', 'month', 'agenda']), `ArrowLeft from the Month wraps to the Agenda: ${show(seen)}`);
      m.key(agenda, 'End');
      m.key(month, 'Home');
      assert(show(seen.slice(4)) === show(['month', 'agenda']), `End, Home: ${show(seen)}`);
    } finally {
      m.unmount();
    }
  });

  await check('#5 the tab bar\'s CSS: every tab at least 44 px tall; nothing under 11 px, every size in px; logical properties only; no hover; no overflow: hidden; the 16 px gutter; the selected tab semibold on --ch-tab-on, the other label in D\'s --ch-muted; a focus ring; only tokens home-theme.ts defines', () => {
    const css = TABS_CSS;
    const rule = (selector: string) => {
      const m = new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(css);
      assert(m, `no rule ${selector}`);
      return m[1];
    };
    const sizes = [...css.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
    assert(sizes.length >= 1 && Math.min(...sizes) >= 11, `font sizes: ${show(sizes)}`);
    assert(!/font-size:\s*[\d.]+(?:em|rem|%)|font:\s/.test(css), 'every font size in px (so the floor is checkable)');
    const min = /min-height:\s*(\d+)px/.exec(rule('.ch-tab'));
    assert(min && Number(min[1]) >= 44, `.ch-tab min-height ${min?.[1]}`);
    const physical = css.match(/(?:margin|padding|border)-(?:left|right)|(?:^|[\s;{])(?:left|right)\s*:|text-align:\s*(?:left|right)|float:/g);
    assert(!physical, `physical properties: ${show(physical)}`);
    assert(!/:hover/.test(css), 'no hover styles');
    assert(!/overflow:\s*hidden/.test(css), 'overflow: hidden');
    assert(/margin-inline:\s*16px/.test(rule('.ch-tabs')) && /background:\s*var\(--ch-tab-track\)/.test(rule('.ch-tabs')), `the track: ${rule('.ch-tabs')}`);
    assert(/color:\s*var\(--ch-muted\)/.test(rule('.ch-tab')), 'the other tab reads --ch-muted (D\'s floor)');
    const on = rule(".ch-tab[aria-selected='true']");
    assert(/font-weight:\s*600/.test(on) && /color:\s*var\(--ch-tab-on-text\)/.test(on), `the selected tab: ${on}`);
    const pill = rule(".ch-tab[aria-selected='true'] .ch-tab-pill");
    assert(/background:\s*var\(--ch-tab-on\)/.test(pill) && /box-shadow:\s*var\(--ch-tab-shadow\)/.test(pill), `the selected pill: ${pill}`);
    assert(/outline:\s*2px solid var\(--ch-accent\)/.test(rule('.ch-tab:focus-visible')), 'a focus ring');
    const defined = new Set(cascade(HOME_THEME_CSS, 'dark', true).keys());
    const used = [...new Set([...css.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]))];
    assert(used.length >= 5 && used.every((n) => defined.has(n)), `tokens read but not defined: ${show(used.filter((n) => !defined.has(n)))}`);
  });

  await check('#6 the storage helpers: per-user keys with the page\'s user_id as it is; the tab in sessionStorage and the layout in localStorage, never the other way round; unknown values read as the defaults', () => {
    const saved = g.window;
    try {
      assert(homeTabKey(5550001) === 'famcal:homeTab:v1:5550001' && homeTabKey(42) === 'famcal:homeTab:v1:42', `homeTabKey ${homeTabKey(5550001)}`);
      assert(monthLayoutKey(5550001) === 'famcal:monthLayout:v1:5550001' && monthLayoutKey(42) === 'famcal:monthLayout:v1:42', `monthLayoutKey ${monthLayoutKey(5550001)}`);
      const session = new Map<string, string>();
      const local = new Map<string, string>();
      g.window = { sessionStorage: memoryStorage(session), localStorage: memoryStorage(local) };
      assert(readHomeTab(1) === 'agenda' && readMonthLayout(1) === null, 'an empty storage');
      writeHomeTab(1, 'month');
      assert(show([...session]) === show([['famcal:homeTab:v1:1', 'month']]) && local.size === 0, `the tab: ${show([...session])} ${show([...local])}`);
      assert(readHomeTab(1) === 'month' && readHomeTab(2) === 'agenda', 'per user');
      writeMonthLayout(1, 'picked');
      writeMonthLayout(2, 'browse');
      assert(show([...local]) === show([['famcal:monthLayout:v1:1', 'picked'], ['famcal:monthLayout:v1:2', 'browse']]) && session.size === 1, `the layouts: ${show([...local])}`);
      assert(readMonthLayout(1) === 'picked' && readMonthLayout(2) === 'browse' && readMonthLayout(3) === null, 'per user');
      writeHomeTab(1, 'agenda');
      assert(readHomeTab(1) === 'agenda', 'back to the Agenda');
      for (const value of ['Month', 'week', '', ' month', '"month"', 'null', 'picked']) {
        session.set(homeTabKey(7), value);
        assert(readHomeTab(7) === 'agenda', `the tab ${show(value)} read as ${readHomeTab(7)}`);
      }
      for (const value of ['Picked', 'grid', '', 'month', 'agenda', '"picked"']) {
        local.set(monthLayoutKey(7), value);
        assert(readMonthLayout(7) === null, `the layout ${show(value)} read as ${readMonthLayout(7)}`);
      }
      session.clear();
      local.clear();
      local.set(homeTabKey(8), 'month');
      session.set(monthLayoutKey(8), 'picked');
      assert(readHomeTab(8) === 'agenda' && readMonthLayout(8) === null, 'a value in the other storage counts');
    } finally {
      g.window = saved;
    }
  });

  await check('#7 the storage helpers never throw: no window (the server); a storage whose property read throws (blocked); a missing storage; getItem and setItem that throw (full) — reads give the defaults, writes do nothing', () => {
    const saved = g.window;
    try {
      const all = () => {
        writeHomeTab(1, 'month');
        writeMonthLayout(1, 'picked');
        return show([readHomeTab(1), readMonthLayout(1)]);
      };
      delete g.window;
      assert(all() === show(['agenda', null]), 'no window');
      const blocked: Row = {};
      for (const area of ['sessionStorage', 'localStorage']) {
        Object.defineProperty(blocked, area, {
          get() {
            throw new Error('SecurityError: The operation is insecure.');
          },
        });
      }
      g.window = blocked;
      assert(all() === show(['agenda', null]), 'a blocked storage');
      g.window = { sessionStorage: null, localStorage: undefined };
      assert(all() === show(['agenda', null]), 'no storage');
      const writes: string[] = [];
      const throwing = {
        getItem: () => {
          throw new Error('getItem threw');
        },
        setItem: (k: string) => {
          writes.push(k);
          throw new Error('QuotaExceededError');
        },
      };
      g.window = { sessionStorage: throwing, localStorage: throwing };
      assert(all() === show(['agenda', null]) && writes.length === 2, `throwing get and set: ${show(writes)}`);
      const full = new Map<string, string>([[homeTabKey(1), 'month'], [monthLayoutKey(1), 'picked']]);
      const readOnly = { getItem: (k: string) => full.get(k) ?? null, setItem: () => { throw new Error('QuotaExceededError'); } };
      g.window = { sessionStorage: readOnly, localStorage: readOnly };
      writeHomeTab(1, 'agenda');
      writeMonthLayout(1, 'browse');
      assert(readHomeTab(1) === 'month' && readMonthLayout(1) === 'picked', 'a full storage still reads');
    } finally {
      g.window = saved;
    }
  });

  await check('#8 Plan E\'s colour tokens: each one declared in the light and the dark block; resolved with every Telegram param set (and color-mix), each reads the params the split maps it onto, the partner\'s shades none, and no text colour reads the hint straight', () => {
    const lightBlock = cssBlocks(HOME_THEME_CSS).find(([p]) => p === '.ch-home');
    const darkBlock = cssBlocks(HOME_THEME_CSS).find(([p]) => p === ".ch-home[data-theme='dark']");
    assert(lightBlock && darkBlock, 'no light or dark block');
    for (const [name, block] of [['light', lightBlock[1]], ['dark', darkBlock[1]]] as const) {
      const declared = new Set(customProps(block).map(([n]) => n));
      const missing = TOKENS.filter((t) => !declared.has(t));
      assert(missing.length === 0, `${name}: missing ${show(missing)}`);
    }
    assert(Object.keys(TG_READS).length === TOKENS.length - 1, 'every colour token has an expectation (--ch-tab-shadow is a shadow)');
    for (const theme of ['light', 'dark'] as const) {
      const r = resolver(theme, true, TG_ALL);
      const got = Object.fromEntries(Object.keys(TG_READS).map((t) => [t, r.reads(t)]));
      const wrong = Object.keys(TG_READS).filter((t) => show(got[t]) !== show(TG_READS[t]));
      assert(wrong.length === 0, `${theme}: ${show(Object.fromEntries(wrong.map((t) => [t, got[t]])))}, want ${show(Object.fromEntries(wrong.map((t) => [t, TG_READS[t]])))}`);
    }
    const shadow = (theme: Theme) => cascade(HOME_THEME_CSS, theme, true).get('--ch-tab-shadow');
    assert(shadow('light') === '0 1px 2px rgba(26, 26, 46, 0.14)' && shadow('dark') === 'none', `the tab shadow: ${shadow('light')} / ${shadow('dark')}`);
  });

  await check('#9 the contrast floor on the fallbacks (a browser: no Telegram params), light and dark, with and without color-mix: every text colour at least 4.5:1 on what it sits on, and the marks that tell whose an item is (dots, the partner\'s outline, the solid fills) at least 3:1', () => {
    const low: string[] = [];
    for (const theme of ['light', 'dark'] as const) {
      for (const colorMix of [false, true]) {
        const r = resolver(theme, colorMix);
        for (const [pairs, floor] of [[TEXT_PAIRS, 4.5], [MARK_PAIRS, 3]] as const) {
          for (const [fg, bg] of pairs) {
            const ratio = contrast(r.colour(fg), r.colour(bg));
            if (ratio < floor) low.push(`${theme}${colorMix ? '+mix' : ''} ${fg} on ${bg}: ${ratio.toFixed(2)}`);
          }
        }
      }
    }
    assert(low.length === 0, `under the floor: ${show(low)}`);
  });

  await check('#10 HomeErrorBoundary: a chunk-load error lets Telegram\'s controls go before its one reload (offClick of the live handler, hide(), then enableVerticalSwipes()), and its card hides the BackButton and turns swipes back on', () => {
    installWindow();
    const calls: string[] = [];
    const savedLocation = fakeWindow.location;
    const savedSession = fakeWindow.sessionStorage;
    fakeWindow.Telegram = { WebApp: fakeTelegram(calls, '7.7') };
    fakeWindow.location = { hash: '', reload: () => void calls.push('location.reload()') };
    fakeWindow.sessionStorage = memoryStorage();
    appLogs.length = 0;
    function Probe({ crash }: { crash: boolean }) {
      useTelegramBackButton(true, noop);
      if (crash) throw Object.assign(new Error('Loading chunk 77 failed.'), { name: 'ChunkLoadError' });
      return null;
    }
    const tree = (crash: boolean) => inIntl('en', createElement(HomeErrorBoundary, null, createElement(Probe, { crash })));
    const controls = () => calls.filter((c) => /^(?:BackButton|enableVerticalSwipes|disableVerticalSwipes|location)/.test(c));
    const m = mount(tree(false), { onCaughtError: noop, onUncaughtError: noop });
    try {
      assert(show(controls()) === show(['BackButton.hide()', 'BackButton.onClick(fn1)', 'BackButton.show()']), `mounted: ${show(calls)}`);
      calls.length = 0;
      m.render(tree(true));
      const steps = controls();
      const reload = steps.indexOf('location.reload()');
      assert(reload >= 0 && steps.filter((c) => c === 'location.reload()').length === 1, `one reload: ${show(steps)}`);
      assert(show(steps.slice(0, reload)) === show(['BackButton.offClick(fn1)', 'BackButton.hide()', 'enableVerticalSwipes()']), `before the reload: ${show(steps)}`);
      const card = steps.slice(reload + 1);
      assert(card.includes('BackButton.hide()') && card.includes('enableVerticalSwipes()') && !card.includes('disableVerticalSwipes()'), `the card: ${show(card)}`);
      assert(fakeWindow.sessionStorage.getItem(CHUNK_RELOAD_KEY) !== null, 'the reload guard is set');
      assert(appLogs.some((l) => l.startsWith('[calendar-home] The home failed to render')), `logged: ${show(appLogs)}`);
    } finally {
      m.unmount();
      fakeWindow.Telegram = undefined;
      fakeWindow.location = savedLocation;
      fakeWindow.sessionStorage = savedSession;
      appLogs.length = 0;
    }
  });

  await check('#11 React logged no warning', () => {
    assert(reactWarnings.length === 0, show(reactWarnings));
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 4: Run it and see it fail; record the regression smokes' baseline**

Step 2's command with `smoke-calendar-home-tabs` in place of `smoke-telegram-ui`. Expected:
```
Error: Cannot find module '../app/[locale]/dashboard/HomeTabs'
smoke-calendar-home-tabs UTC exit=1
Error: Cannot find module '../app/[locale]/dashboard/HomeTabs'
smoke-calendar-home-tabs Asia/Jerusalem exit=1
```
`npx tsc --noEmit -p .` fails too, on the two modules Steps 7 and 9 create:
```
scripts/smoke-calendar-home-tabs.ts(35,56): error TS2307: Cannot find module '../app/[locale]/dashboard/HomeTabs' or its corresponding type declarations.
scripts/smoke-calendar-home-tabs.ts(39,120): error TS2307: Cannot find module '../src/lib/calendar-view/home-storage' or its corresponding type declarations.
```

Then record the regression smokes' baseline:
```bash
cd /Users/razielgershoni/development/famcalbot
for tz in UTC Asia/Jerusalem; do for s in smoke-calendar-home-render smoke-calendar-home-copy smoke-miniapp-gate smoke-auth-identity smoke-auth-leftovers smoke-initdata-header; do TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/$s.ts 2>&1 | grep -E '^FAIL|passed' | sed 's/ — .*//'; echo "$s $tz exit=${pipestatus[1]}"; done; done
```
Expected:
```
42/42 passed (process TZ=UTC)
smoke-calendar-home-render UTC exit=0
18/18 passed
smoke-calendar-home-copy UTC exit=0
20/20 passed
smoke-miniapp-gate UTC exit=0
26/26 passed
smoke-auth-identity UTC exit=0
9/9 passed
smoke-auth-leftovers UTC exit=0
9/9 passed
smoke-initdata-header UTC exit=0
42/42 passed (process TZ=Asia/Jerusalem)
smoke-calendar-home-render Asia/Jerusalem exit=0
18/18 passed
smoke-calendar-home-copy Asia/Jerusalem exit=0
20/20 passed
smoke-miniapp-gate Asia/Jerusalem exit=0
26/26 passed
smoke-auth-identity Asia/Jerusalem exit=0
9/9 passed
smoke-auth-leftovers Asia/Jerusalem exit=0
9/9 passed
smoke-initdata-header Asia/Jerusalem exit=0
```

- [ ] **Step 5: Add the swipe hook and the release to `src/lib/telegram-ui.ts`**

Three edits, in this order.

**1.** In `src/lib/telegram-ui.ts`, lines 1-7: the header names Ruling 9. Before:
```ts
/**
 * The Telegram Mini App calls the calendar home makes (spec §7.1 Look, §7.6). Every SDK
 * call is gated with isVersionAtLeast and wrapped in try/catch, so a 6.0 client, a plain
 * browser (the SDK defines Telegram.WebApp there too, at version 6.0) or a method that
 * throws never breaks the page; in a browser the in-page buttons do the same jobs.
 *
 * Client components only. Nothing here touches window at import, and while rendering on
```
After:
```ts
/**
 * The Telegram Mini App calls the calendar home makes (spec §7.1 Look, §7.6; the vertical
 * swipes follow Plan E Ruling 9). Every SDK call is gated with isVersionAtLeast and
 * wrapped in try/catch, so a 6.0 client, a plain browser (the SDK defines Telegram.WebApp
 * there too, at version 6.0) or a method that throws never breaks the page; in a browser
 * the in-page buttons do the same jobs.
 *
 * Client components only. Nothing here touches window at import, and while rendering on
```

**2.** In `src/lib/telegram-ui.ts`, lines 16-19: the version the swipe calls need. Before:
```ts
const COLOURS = '6.1';
const OPEN_LINK = '6.1';

/** Events newer than the first SDK (6.0). */
```
After:
```ts
const COLOURS = '6.1';
const OPEN_LINK = '6.1';
const VERTICAL_SWIPES = '7.7';

/** Events newer than the first SDK (6.0). */
```

**3.** In `src/lib/telegram-ui.ts`, lines 121-124: the setter, the hook and the release go after `releaseTelegramBackButton`. Before:
```ts
}

export type ColorScheme = 'light' | 'dark';

```
After:
```ts
}

/** enableVerticalSwipes() or disableVerticalSwipes() on a 7.7+ client; a throw is logged. */
function setVerticalSwipes(enabled: boolean): void {
  if (enabled) tgCall(VERTICAL_SWIPES, 'enableVerticalSwipes', (tg) => tg.enableVerticalSwipes());
  else tgCall(VERTICAL_SWIPES, 'disableVerticalSwipes', (tg) => tg.disableVerticalSwipes());
}

/**
 * Telegram's swipe down to minimize or close (Bot API 7.7+; spec §7.6, Plan E Ruling 9):
 * off while `locked`, on otherwise. The home locks it while the Month shows browse, where
 * a drag down at the top would take the app away instead of scrolling the months.
 * - Each change of `locked` makes one call: disableVerticalSwipes() when it locks,
 *   enableVerticalSwipes() when it unlocks. A re-render with the same value makes none.
 * - On mount it makes the call for its `locked`, so an unlocked mount enables: a reload
 *   can leave swipes off.
 * - On unmount it enables.
 * - It only sets, never reads isVerticalSwipesEnabled, which is wrong after a reload.
 * One mounted component owns it at a time (the home's container, or the error card in its
 * place): another one's unmount would turn swipes back on under the first one's lock.
 */
export function useTelegramVerticalSwipes(locked: boolean): void {
  useEffect(() => {
    setVerticalSwipes(!locked);
  }, [locked]);

  useEffect(() => () => setVerticalSwipes(true), []);
}

/**
 * Lets Telegram's controls go at once, outside React, before a page reload (spec §5: 404
 * not_enabled, a chunk-load error): releaseTelegramBackButton(), then
 * enableVerticalSwipes(). A reload runs no React cleanup, and the client can keep both
 * across it, so the page after it could otherwise show a back button that does nothing,
 * or keep swipes off where nothing locks them.
 */
export function releaseTelegramControls(): void {
  releaseTelegramBackButton();
  setVerticalSwipes(true);
}

export type ColorScheme = 'light' | 'dark';

```

- [ ] **Step 6: Run `smoke-telegram-ui` and see it pass**

Run Step 2's command again. Expected:
```
19/19 passed (process TZ=UTC)
smoke-telegram-ui UTC exit=0
19/19 passed (process TZ=Asia/Jerusalem)
smoke-telegram-ui Asia/Jerusalem exit=0
```

- [ ] **Step 7: Create `src/lib/calendar-view/home-storage.ts`**

Create `src/lib/calendar-view/home-storage.ts` with exactly this content:

```ts
// The calendar home's memory on the device (spec §7.1 State, §7.4 Memory; Plan E Ruling 2):
// - the tab on screen, in sessionStorage, so a new session opens on the Agenda, the landing
//   tab (§7.3), while a reload inside a session keeps the tab;
// - the Month's layout (browse or picked), in localStorage, kept per device.
// Both keys end with the page's own user_id as it is (a Telegram id or a DB id, never
// swapped for the other), so two accounts on one device keep their own. Every access is
// in try/catch: storage can be missing, blocked (private mode, a WebView's settings), full,
// or throw on the property read itself. A read then gives its default, and a write does
// nothing: the memory is a convenience.
//
// Pure, no React and no imports; nothing touches window at import, so the server render
// can import it (a read there gives the default).

/** The two tabs of the calendar home (spec §7.1). */
export type HomeTab = 'agenda' | 'month';

/** The sessionStorage key for the tab on screen. */
export function homeTabKey(userId: number): string {
  return 'famcal:homeTab:v1:' + userId;
}

/** The localStorage key for the Month's layout. */
export function monthLayoutKey(userId: number): string {
  return 'famcal:monthLayout:v1:' + userId;
}

type Area = 'sessionStorage' | 'localStorage';

/** The string under `key`, or null: no window, no storage, a throw, or nothing stored. */
function readKey(area: Area, key: string): string | null {
  try {
    if (typeof window === 'undefined') return null;
    const value: unknown = window[area].getItem(key);
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

/** Stores `value` under `key`; never throws. */
function writeKey(area: Area, key: string, value: string): void {
  try {
    if (typeof window === 'undefined') return;
    window[area].setItem(key, value);
  } catch {
    // Blocked or full: the tab or layout just isn't remembered.
  }
}

/** The tab this session last showed; 'agenda' with no window, a throw or an unknown value. */
export function readHomeTab(userId: number): HomeTab {
  return readKey('sessionStorage', homeTabKey(userId)) === 'month' ? 'month' : 'agenda';
}

/** Remembers the tab on screen for this session. Never throws. */
export function writeHomeTab(userId: number, tab: HomeTab): void {
  writeKey('sessionStorage', homeTabKey(userId), tab);
}

/** The Month's last layout on this device; null when none is stored, it's unknown, or storage fails. */
export function readMonthLayout(userId: number): 'browse' | 'picked' | null {
  const value = readKey('localStorage', monthLayoutKey(userId));
  return value === 'browse' || value === 'picked' ? value : null;
}

/** Remembers the Month's layout on this device. Never throws. */
export function writeMonthLayout(userId: number, layout: 'browse' | 'picked'): void {
  writeKey('localStorage', monthLayoutKey(userId), layout);
}
```

- [ ] **Step 8: Add the Month's colour tokens to `app/[locale]/dashboard/home-theme.ts`**

Four edits, in this order. Line numbers are the file's before the first edit.

**1.** In `app/[locale]/dashboard/home-theme.ts`, lines 23-26: the header says how each token is meant to be used. E6 and E7 follow it. Before:
```ts
// Rules: nothing smaller than 11 px; every tap target at least 44 px; logical
// properties only, so RTL needs no overrides; no hover styles (touch only).

export const HOME_THEME_CSS = `
```
After:
```ts
// Rules: nothing smaller than 11 px; every tap target at least 44 px; logical
// properties only, so RTL needs no overrides; no hover styles (touch only).
//
// Plan E's tokens, for the tab bar and the Month (E6 and E7 read only these and the ones
// above). Each is set in light and dark, on Telegram's theme params where one fits; the
// fallbacks are the approved mockups' shades (MonthFlow, MonthPicked, Dark).
// - The tabs: --ch-tab-track behind both; --ch-tab-on, --ch-tab-on-text and
//   --ch-tab-shadow for the selected one (Telegram's section colour on its secondary
//   background, the pairing it uses for a card on a grouped list).
// - Whose an item is (spec §7.3), never told by colour alone:
//   - the viewer's items are filled: a timed one is --ch-mine-soft under
//     --ch-mine-soft-text; all-day items and bars are --ch-mine-solid under
//     --ch-mine-solid-text;
//   - the partner's are outlined: a timed one is a 1 px --ch-partner-line border on the
//     page's background with --ch-partner-line-text; all-day items and bars are
//     --ch-partner-soft under --ch-partner-soft-text, with the same 1 px --ch-partner-line
//     border;
//   - picked's dots: a filled --ch-dot-mine, or a 1.5 px --ch-dot-partner ring.
//   Telegram has no colour for a partner, so those shades are fixed (orange, as D's person
//   chip). The marks (the lines, rings, dots and the solid fill) keep 3:1 against what
//   they sit on, and every text colour 4.5:1.
// - Today's number on --ch-today with --ch-today-text, Telegram's button pair. As plain
//   text on the page (picked, when today isn't selected) it reads --ch-accent.
// - The selected day: --ch-selected with --ch-selected-text (the theme's text and
//   background, swapped).
// - The Today pill: --ch-pill-bg, --ch-pill-line and --ch-pill-text. Month titles:
//   --ch-month-title. Both are the accent pulled a fifth towards the text.
// - A disabled chevron: --ch-disabled, faint on purpose (the button is also disabled). It
//   is the only new colour that reads the hint straight. Every text colour keeps D's
//   floor: an unselected tab's label reads --ch-muted.

export const HOME_THEME_CSS = `
```

**2.** In `app/[locale]/dashboard/home-theme.ts`, lines 45-48: the light tokens, after D's. Before:
```ts
  --ch-scrim: rgba(18, 18, 32, 0.45);
  --ch-sheet-shadow: 0 -8px 24px rgba(18, 18, 32, 0.18);
  color-scheme: light;
  background: var(--ch-bg);
```
After:
```ts
  --ch-scrim: rgba(18, 18, 32, 0.45);
  --ch-sheet-shadow: 0 -8px 24px rgba(18, 18, 32, 0.18);
  --ch-tab-track: var(--ch-surface);
  --ch-tab-on: var(--ch-section);
  --ch-tab-on-text: var(--ch-text);
  --ch-tab-shadow: 0 1px 2px rgba(26, 26, 46, 0.14);
  --ch-mine-soft: #eee9ff;
  --ch-mine-soft-text: #2e1a87;
  --ch-mine-solid: var(--ch-button);
  --ch-mine-solid-text: var(--ch-button-text);
  --ch-partner-soft: #ffd9b8;
  --ch-partner-soft-text: #6b2c00;
  --ch-partner-line: #b05f22;
  --ch-partner-line-text: #7a3500;
  --ch-dot-mine: var(--ch-accent);
  --ch-dot-partner: #b4540b;
  --ch-today: var(--ch-button);
  --ch-today-text: var(--ch-button-text);
  --ch-selected: var(--ch-text);
  --ch-selected-text: var(--ch-bg);
  --ch-pill-bg: var(--ch-card);
  --ch-pill-line: #d9d2fa;
  --ch-pill-text: var(--tg-theme-accent-text-color, var(--tg-theme-link-color, #4b2fc9));
  --ch-disabled: #c9c8d6;
  --ch-month-title: var(--tg-theme-accent-text-color, var(--tg-theme-link-color, #4b2fc9));
  color-scheme: light;
  background: var(--ch-bg);
```

**3.** In `app/[locale]/dashboard/home-theme.ts`, lines 73-76: the dark tokens, after D's. Before:
```ts
  --ch-scrim: rgba(0, 0, 0, 0.6);
  --ch-sheet-shadow: 0 -8px 24px rgba(0, 0, 0, 0.5);
  color-scheme: dark;
}
```
After:
```ts
  --ch-scrim: rgba(0, 0, 0, 0.6);
  --ch-sheet-shadow: 0 -8px 24px rgba(0, 0, 0, 0.5);
  --ch-tab-track: var(--ch-surface);
  --ch-tab-on: var(--tg-theme-section-bg-color, #33334a);
  --ch-tab-on-text: var(--ch-text);
  --ch-tab-shadow: none;
  --ch-mine-soft: #2c2550;
  --ch-mine-soft-text: #d9cfff;
  --ch-mine-solid: var(--tg-theme-button-color, #6d4ff0);
  --ch-mine-solid-text: var(--ch-button-text);
  --ch-partner-soft: #4a2b12;
  --ch-partner-soft-text: #ffd2a8;
  --ch-partner-line: #d98b4a;
  --ch-partner-line-text: #ffb877;
  --ch-dot-mine: var(--ch-accent);
  --ch-dot-partner: #f0924a;
  --ch-today: var(--tg-theme-button-color, #6d4ff0);
  --ch-today-text: var(--ch-button-text);
  --ch-selected: var(--ch-text);
  --ch-selected-text: var(--ch-bg);
  --ch-pill-bg: var(--ch-card);
  --ch-pill-line: #3a3166;
  --ch-pill-text: var(--ch-accent);
  --ch-disabled: #4a4a5e;
  --ch-month-title: var(--ch-accent);
  color-scheme: dark;
}
```

**4.** In `app/[locale]/dashboard/home-theme.ts`, lines 84-87: the color-mix versions. They are the same in both themes where the formula is, and split by theme where the mix differs. Before:
```ts
    --ch-done: color-mix(in srgb, var(--ch-hint) 80%, var(--ch-bg));
    --ch-outline: color-mix(in srgb, var(--ch-hint) 45%, var(--ch-bg));
  }
}
```
After:
```ts
    --ch-done: color-mix(in srgb, var(--ch-hint) 80%, var(--ch-bg));
    --ch-outline: color-mix(in srgb, var(--ch-hint) 45%, var(--ch-bg));
    /* Plan E: text in the accent, pulled towards the text so it reads on any theme's background; a faint disabled chevron. */
    --ch-mine-soft-text: color-mix(in srgb, var(--ch-accent) 55%, var(--ch-text));
    --ch-pill-text: color-mix(in srgb, var(--ch-accent) 80%, var(--ch-text));
    --ch-month-title: color-mix(in srgb, var(--ch-accent) 80%, var(--ch-text));
    --ch-disabled: color-mix(in srgb, var(--ch-hint) 35%, var(--ch-bg));
  }
  .ch-home {
    --ch-mine-soft: color-mix(in srgb, var(--ch-accent) 12%, var(--ch-bg));
    --ch-pill-line: color-mix(in srgb, var(--ch-accent) 25%, var(--ch-bg));
  }
  .ch-home[data-theme='dark'] {
    --ch-mine-soft: color-mix(in srgb, var(--ch-accent) 22%, var(--ch-bg));
    --ch-pill-line: color-mix(in srgb, var(--ch-accent) 30%, var(--ch-bg));
  }
}
```

- [ ] **Step 9: Create `app/[locale]/dashboard/HomeTabs.tsx`**

Create `app/[locale]/dashboard/HomeTabs.tsx` with exactly this content:

```tsx
'use client';

// The calendar home's tab bar (spec §7.1, §7.7; Plan E Rulings 1 and 2; the approved
// Main.dc.html): Agenda and Month as one segmented control under the header.
// Presentational: the container (CalendarHome) holds the tab, remembers it
// (home-storage's readHomeTab / writeHomeTab) and decides when the bar shows (Ruling 1).
//
// - A tablist named by tabs.label, then two tabs. Each tab has its id (TAB_IDS),
//   aria-selected, and aria-controls naming its panel (PANEL_IDS). The container gives
//   each panel role="tabpanel", that id and aria-labelledby. Only the selected tab is in
//   the Tab order (a roving tabIndex).
// - The arrow keys follow the reading direction: the next tab is to the right in
//   English and Russian, and to the left in Hebrew. Both wrap. Home and End go to the
//   first and the last tab. Focus moves there, and the key selects that tab (automatic
//   activation): both panels are in-page state, so a switch shows at once.
// - A tap on the other tab selects it; a tap on the selected one does nothing.
// - Each tab is a full 44 px tall. The mockup's segmented look is an inset pill inside
//   it. The selected tab's label is also semibold, so the state never rests on colour
//   alone.
// - No hover styles (touch only), logical properties only, nothing under 11 px.

import { useRef, type KeyboardEvent } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import type { HomeTab } from '@/src/lib/calendar-view/home-storage';

/** Each tab's element id. */
export const TAB_IDS = { agenda: 'ch-tab-agenda', month: 'ch-tab-month' } as const;
/** Each panel's element id, for the tab's aria-controls (the container renders the panels). */
export const PANEL_IDS = { agenda: 'ch-panel-agenda', month: 'ch-panel-month' } as const;

export interface HomeTabsProps {
  /** The tab on screen. */
  tab: HomeTab;
  /** The user picked another tab (a tap, or a key). Never called with the tab already on screen. */
  onTab: (tab: HomeTab) => void;
}

/** The tabs in reading order. */
const ORDER: readonly HomeTab[] = ['agenda', 'month'];

export function HomeTabs({ tab, onTab }: HomeTabsProps) {
  const t = useTranslations('calendarHome');
  const locale = useLocale();
  const rtl = locale === 'he';
  const buttons = useRef<Partial<Record<HomeTab, HTMLButtonElement | null>>>({});

  const pick = (next: HomeTab) => {
    if (next !== tab) onTab(next);
  };

  /** A key on the tab `from` (the focused one; with the roving tabIndex, normally the selected one). */
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, from: HomeTab) => {
    const at = ORDER.indexOf(from);
    const forward = rtl ? 'ArrowLeft' : 'ArrowRight';
    const backward = rtl ? 'ArrowRight' : 'ArrowLeft';
    let next: HomeTab | null = null;
    if (event.key === forward) next = ORDER[(at + 1) % ORDER.length];
    else if (event.key === backward) next = ORDER[(at + ORDER.length - 1) % ORDER.length];
    else if (event.key === 'Home') next = ORDER[0];
    else if (event.key === 'End') next = ORDER[ORDER.length - 1];
    if (!next) return;
    event.preventDefault();
    buttons.current[next]?.focus();
    pick(next);
  };

  return (
    <>
      <style>{TABS_CSS}</style>
      <div className="ch-tabs" role="tablist" aria-label={t('tabs.label')} dir={rtl ? 'rtl' : 'ltr'}>
        {ORDER.map((id) => {
          const selected = id === tab;
          return (
            <button
              key={id}
              ref={(el) => {
                buttons.current[id] = el;
              }}
              type="button"
              role="tab"
              id={TAB_IDS[id]}
              className="ch-tab"
              aria-selected={selected}
              aria-controls={PANEL_IDS[id]}
              tabIndex={selected ? 0 : -1}
              onClick={() => pick(id)}
              onKeyDown={(event) => onKeyDown(event, id)}
            >
              <span className="ch-tab-pill">{id === 'agenda' ? t('tabs.agenda') : t('tabs.month')}</span>
            </button>
          );
        })}
      </div>
    </>
  );
}

/**
 * The tab bar's styles. They read the tokens HOME_THEME_CSS (./home-theme.ts) puts on
 * .ch-home: --ch-tab-track behind both tabs, --ch-tab-on / --ch-tab-on-text /
 * --ch-tab-shadow for the selected one, D's --ch-muted (the contrast floor) for the other
 * label and --ch-accent for the focus ring. The 16 px side gutter matches the header's.
 * The pill sits 4 px inside the track, with 4 px between the two pills, as in the mockup.
 */
export const TABS_CSS = `
.ch-tabs {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  margin-block: 0 4px;
  margin-inline: 16px;
  border-radius: 12px;
  background: var(--ch-tab-track);
}
.ch-tab {
  display: flex;
  align-items: stretch;
  min-width: 0;
  min-height: 44px;
  margin: 0;
  padding-block: 4px;
  padding-inline: 4px 2px;
  border: 0;
  border-radius: 12px;
  background: transparent;
  color: var(--ch-muted);
  font-family: inherit;
  font-size: 15px;
  font-weight: 500;
  line-height: 1.2;
  text-align: center;
  cursor: pointer;
  touch-action: manipulation;
}
.ch-tab + .ch-tab {
  padding-inline: 2px 4px;
}
.ch-tab-pill {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  min-width: 0;
  padding-inline: 8px;
  border-radius: 9px;
}
.ch-tab[aria-selected='true'] {
  color: var(--ch-tab-on-text);
  font-weight: 600;
}
.ch-tab[aria-selected='true'] .ch-tab-pill {
  background: var(--ch-tab-on);
  box-shadow: var(--ch-tab-shadow);
}
.ch-tab:focus-visible {
  outline: 2px solid var(--ch-accent);
  outline-offset: 2px;
}
`;
```

- [ ] **Step 10: Run the tabs smoke: only the error boundary's check fails**

Step 2's command with `smoke-calendar-home-tabs` in place of `smoke-telegram-ui`. Expected:
```
FAIL  #10 HomeErrorBoundary: a chunk-load error lets Telegram's controls go before its one reload (offClick of the live handler, hide(), then enableVerticalSwipes()), and its card hides the BackButton and turns swipes back on
10/11 passed (process TZ=UTC)
smoke-calendar-home-tabs UTC exit=1
FAIL  #10 HomeErrorBoundary: a chunk-load error lets Telegram's controls go before its one reload (offClick of the live handler, hide(), then enableVerticalSwipes()), and its card hides the BackButton and turns swipes back on
10/11 passed (process TZ=Asia/Jerusalem)
smoke-calendar-home-tabs Asia/Jerusalem exit=1
```
Why: HomeErrorBoundary still passes `releaseTelegramBackButton` to `reloadOnce`, so #10's reason reads `before the reload: ["BackButton.offClick(fn1)","BackButton.hide()","location.reload()",…]`, with no `enableVerticalSwipes()`.

- [ ] **Step 11: Release the controls in `app/[locale]/dashboard/HomeErrorBoundary.tsx`**

Four edits, in this order.

**1.** In `app/[locale]/dashboard/HomeErrorBoundary.tsx`, lines 5-10: the header. Before:
```tsx
// the files while the app was open) reloads the page once by itself, letting Telegram's
// BackButton go first; the guard in sessionStorage keeps that from looping. The fallback
// carries the home's own look and hides a Telegram BackButton the client kept from
// before. The home's own chunk failing to load is PageGate's boundary's (D7): this one
// lives inside that chunk.

```
After:
```tsx
// the files while the app was open) reloads the page once by itself, letting Telegram's
// BackButton and vertical swipes go first (releaseTelegramControls); the guard in
// sessionStorage keeps that from looping. The fallback carries the home's own look,
// hides a Telegram BackButton the client kept from before and turns vertical swipes back
// on, which a reload in the Month's browse can leave off (Plan E Ruling 9). The home's
// own chunk failing to load is PageGate's boundary's (D7): this one lives inside that
// chunk.

```

**2.** In `app/[locale]/dashboard/HomeErrorBoundary.tsx`, lines 13-15: the imports. Before:
```tsx
import { CHUNK_RELOAD_KEY, isChunkLoadError, reloadOnce } from '@/src/lib/calendar-view/reload-guard';
import { releaseTelegramBackButton, useTelegramBackButton, useTelegramTheme } from '@/src/lib/telegram-ui';
import { HOME_SHELL_CSS } from './home-shell';
```
After:
```tsx
import { CHUNK_RELOAD_KEY, isChunkLoadError, reloadOnce } from '@/src/lib/calendar-view/reload-guard';
import { releaseTelegramControls, useTelegramBackButton, useTelegramTheme, useTelegramVerticalSwipes } from '@/src/lib/telegram-ui';
import { HOME_SHELL_CSS } from './home-shell';
```

**3.** In `app/[locale]/dashboard/HomeErrorBoundary.tsx`, lines 36-37: the card enables swipes on mount. Before:
```tsx
  useTelegramBackButton(false, noop);
  return (
```
After:
```tsx
  useTelegramBackButton(false, noop);
  useTelegramVerticalSwipes(false);
  return (
```

**4.** In `app/[locale]/dashboard/HomeErrorBoundary.tsx`, lines 64-66: the chunk-load reload lets both controls go. Before:
```tsx
    console.error('[calendar-home] The home failed to render:', error, info.componentStack);
    if (isChunkLoadError(error)) reloadOnce(CHUNK_RELOAD_KEY, Date.now(), releaseTelegramBackButton);
  }
```
After:
```tsx
    console.error('[calendar-home] The home failed to render:', error, info.componentStack);
    if (isChunkLoadError(error)) reloadOnce(CHUNK_RELOAD_KEY, Date.now(), releaseTelegramControls);
  }
```

- [ ] **Step 12: Run both smokes under both clocks and see them pass**

```bash
cd /Users/razielgershoni/development/famcalbot
for tz in UTC Asia/Jerusalem; do for s in smoke-telegram-ui smoke-calendar-home-tabs; do TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/$s.ts 2>&1 | grep -E '^FAIL|passed|Cannot find module' | sed -e 's/ — .*//' -e "s#^Error: Cannot find module '\([^']*\)'.*#Error: Cannot find module '\1'#"; echo "$s $tz exit=${pipestatus[1]}"; done; done
```
Expected, with no `FAIL` line:
```
19/19 passed (process TZ=UTC)
smoke-telegram-ui UTC exit=0
11/11 passed (process TZ=UTC)
smoke-calendar-home-tabs UTC exit=0
19/19 passed (process TZ=Asia/Jerusalem)
smoke-telegram-ui Asia/Jerusalem exit=0
11/11 passed (process TZ=Asia/Jerusalem)
smoke-calendar-home-tabs Asia/Jerusalem exit=0
```

- [ ] **Step 13: Run the regression smokes again**

Run Step 4's second command again. Expected: exactly Step 4's lines, every one `exit=0`. `smoke-calendar-home-render` prints the same `OK` lines as before (42 of them). Its #14 also reads HOME_THEME_CSS, and its #35 mounts HomeErrorBoundary. Its fake Telegram is a 7.0 client, so the new swipe calls never reach it.

- [ ] **Step 14: Type-check and lint**

```bash
cd /Users/razielgershoni/development/famcalbot
npx tsc --noEmit -p . && npm run -s lint; echo "exit $?"
```
Expected: no output from either, then `exit 0`. `next build` type-checks `scripts/**`, so the new smoke is covered too.

- [ ] **Step 15: Commit**

```bash
cd /Users/razielgershoni/development/famcalbot
git add src/lib/telegram-ui.ts src/lib/calendar-view/home-storage.ts 'app/[locale]/dashboard/HomeTabs.tsx' 'app/[locale]/dashboard/home-theme.ts' 'app/[locale]/dashboard/HomeErrorBoundary.tsx' scripts/smoke-telegram-ui.ts scripts/smoke-calendar-home-tabs.ts
git commit -m "$(cat <<'EOF'
feat(calendar-home): the tab bar, tab memory, swipe lock and the Month's colours

useTelegramVerticalSwipes(locked) turns Telegram's swipe-down-to-minimize
off while locked and back on otherwise (Bot API 7.7): one call per change,
an unlocked mount and unmount enable, and isVerticalSwipesEnabled is never
read. releaseTelegramControls() lets the BackButton go and enables swipes
before a reload; the home's error boundary uses it for its chunk-load
reload, and its card enables swipes. home-storage keeps the tab in
sessionStorage and the Month's layout in localStorage, per user_id, never
throwing. HomeTabs is the Agenda/Month tablist: 44 px tabs, arrows in the
reading direction, Home and End. home-theme gains the Month's tokens in
light and dark, on Telegram's params where one fits, with the partner's
items outlined so colour is never the only signal. Nothing shows the
tabs or the new colours yet: CalendarHome is unchanged until the Month
lands.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
EOF
)"
```
Stage only these seven paths. The working tree may show plan or spec files as modified; they aren't part of this task.

---

---

### Task 5 (E5): The Month model (spec §7.4, §5's month windows, §7.8's Month cells; Rulings R11 and R12; Plan E Rulings 3–7)

> **INTERFACE NOTE VERSUS THE SPLIT (read this first; E6, E7 and E8 build on it). Every export the split gives is here, verbatim; the review patch adds three (`limitRow`, `pickedScrollTop` and `PICKED_FIRST_ROW_PX`, notes 11 and 12). One addition to the import list, and the points the split left open, now binding:**
> 1. **`month.ts` also imports `isHebrewMonthStart` from `hebrew-date.ts` (E2).** The split's import list for `month.ts` (grid, store, agenda, format, the `RangeWindow` type) leaves out `hebrew-date.ts`, but `MonthCell.hebrewMonthStart` is "Hebrew day 1", which only `@hebcal/hdate` knows. The home's bundle gains nothing: `hebrew-date.ts` is already in it (D's header), and it is still `@hebcal/hdate` and `@hebcal/locales/ru` only. The smoke's import walk allows exactly `src/lib/calendar-view/*` and those two packages, and checks that `home-client.ts` is never loaded (`RangeWindow` stays `import type`).
> 2. **Heights (E6 sets these exactly, as `block-size`):**
>    - `monthTitlePx(false)` = 42 (14 px above, a 22 px month line, 6 px below, as the mockup's `.mh`); `monthTitlePx(true)` = 58 (plus a 16 px line for the Hebrew months);
>    - `monthBarPx(false)` = 72 (a 48 px row that holds the 44 px Today button, plus a 24 px weekday row with its bottom border); `monthBarPx(true)` = 76 (the row is 52 px with the Hebrew line);
>    - `monthBlockPx(rows, hd)` = `monthTitlePx(hd) + rows × 92`.
> 3. **Lanes.** The split's "start, longer first, then key" is read as: the day the bar starts being drawn in the week row, then all-day before timed, then the item's earlier real start, then its later end (the longer), then key. With the real start in the order, a bar that came from an earlier row keeps its lane above a longer bar that starts on the row's first day (the smoke's "Visit A" and "Visit B"). Lane 0 is the top slot. "Spacers below a continuing bar" is read as: a day with a bar in lane n keeps a spacer in each lane before n that no bar of the day uses. There is never a spacer after the day's last bar.
> 4. **Edges.** On the month's first and last day, the span marks decide, always, even when the neighbouring month is loaded. So a month's model never changes when its neighbours answer: the smoke checks that October alone equals October with September and November loaded, and that each edge agrees with what the server's `toRangeDays` lists on the other month's day. Inside the month, the store decides: a timed bar stops at a day whose neighbour hasn't answered yet.
> 5. **`limitSlots`** shows every slot while they fit, spacers and all, so each bar keeps its lane. Past the limit (review patch): the day's one-day items first move into the spacers above its bars, the bars keeping their lanes; if that is still too many, the spacers go and the bars move up, each bar that leaves its lane with its title; if that is still too many, the first `min(maxChips, BROWSE_SLOTS - 1)` items, bars first, and "+N". So a spacer never shows over "+N", and "+N" never shows while the items would fit: the review's three overlapping bars on a 360 px screen gave the 9th only "+1" under two empty lines, and Gamma's title never showed. A trailing spacer never shows. **`limitDots`** shows `PICKED_DOTS` (3), then "+N", as the mockup does.
> 6. **A blank cell** (`inMonth: false`) carries nothing: `today` false, `status` `'answered'`, no slots or dots, `count` 0, `hebrewMonthStart` false. The view reads only `day` and `inMonth` on it.
> 7. **Notices** are worked out whatever the month's status, so an Agenda week that failed shows its failure while the rest of the month still loads. There is at most one `failed` and one `partial` notice per source, in the store's source order (FamCal first). A failed notice's `failure` is `dayFailure` on the earliest failing in-month day, then `lastFailure`, then `{ kind: 'error', source, reason: null }`. A reconnect makes no notice.
> 8. **`wantedMonths` order:**
>    - picked: the picked month, the month after it, the month before;
>    - browse: the month in view (`inView`, or `ui.month` while `inView` is null) and its two neighbours, always, with `near`, nearest to the month in view first, the later month first when two are as near. With `near` empty (no IntersectionObserver, or before it reports) that is Ruling 7's fallback. The neighbours are in even when `near` is given (review patch): on Telegram's web clients the app is a cross-origin iframe, where the observer ignores its `rootMargin` and reports only the months on screen;
>    - months outside the window, malformed keys and repeats are dropped, and a malformed `today` gives `[]`.
> 9. **Navigation** returns the same object when nothing changes, so React's state setter bails out. Also:
>    - `stepMonth` in browse moves the month only;
>    - `clampMonthUi` keeps a picked day even when it was today. A month past an end moves to that end, and picked then selects its 1st, or today in today's month. A malformed month goes to today's;
>    - `pickDay` with a malformed day keeps the UI;
>    - `initialMonthUi('picked', today)` is picked on today.
> 10. **Malformed input:** `monthsInViewport` on an empty list gives `{ first: 0, last: -1 }`, and `buildMonth` gives `null` for a malformed month as well as before the facts. Nothing in `month.ts` throws.
> 11. **`limitRow(cells, maxChips)`** (review patch; E6 calls it for each week row in place of `limitSlots` per cell): `limitSlots` for each in-month cell, a blank cell showing nothing; then a bar that the day before didn't draw in the same slot (it was behind that day's "+N", or in another slot) shows its title. So no bar is drawn nameless: the model's `showTitle` knows only the run's first day, not what a narrow cell left out.
> 12. **`pickedScrollTop(layoutTop, dayHeadBottom, viewport)`** and **`PICKED_FIRST_ROW_PX`** (64) (review patch; E7 calls it on entering picked): 0 (the top, Ruling 6) while the day's header and its first row fit on the screen; else just far enough down that they do, never past `layoutTop`, so the picked layout's bar stays on screen. 0 for anything not finite or no screen. A 6-row month under the trial and location banners on a 375 × 667 phone doesn't fit at the top (E7's check), so "fits one screen" holds on a tall phone and becomes "shows the day's start" on a short one.

**What and why.** The Month (E6–E8) needs one model of what it draws, worked out from the store the Agenda already shares (spec §5). This task writes it as pure functions, with no React, no fetch, no clock and no storage, so the views only format and lay out:
- **Cells** (spec §7.4, Ruling 3):
  - each month draws its own days, and the days of its rows outside it are blank (R12);
  - a cell's slots are the bars first, by lane, then its one-day items (all-day before timed);
  - whose an item is follows the Agenda's `whoseItem` (filled for the viewer's, outlined for the partner's), and a done reminder is struck through;
  - the dots (picked), the item count and the "from <partner>" count follow the drawn items;
  - the cells that name the Hebrew month are Hebrew day 1 and the month's first day.
- **Daily reminders** (R11, Ruling 5) are left out of the slots, the dots and the counts, so a count always matches what is drawn. The picked day's list (`dayRows`, the Agenda's rows) still has them.
- **Bars:**
  - an all-day item over its dates, from `start` to `allDayLastDay`;
  - a timed item that the store lists on the day before or after. At the month's edges the other day is another month's, so the span marks decide, with daySpanOf's 06:00 rule: an overnight 22:00–02:00 item is a one-day chip, on the month's last day too;
  - lanes per week row, with spacers that keep a bar in line, and the title on the first day the bar is drawn in each row.
- **"+N"** (Ruling 3): 3 slots, or 2 slots and "+N" in the third; a narrow screen shows at most 2. A day that overflows fills a bar's empty lanes with its one-day items first, then moves its bars up with their titles, so it never shows an empty line over "+N" (`limitRow`, per week row).
- **A month's status and notices** (Ruling 4): answered, loading or failed; failed and partial pills with the earliest failing day's reason; never a reconnect, which the banner covers.
- **The browse's geometry:** the block heights it renders with (it lays out 31 months at known heights; iOS has no scroll anchoring), each month's offset, and the months a band of the page shows.
- **Navigation** over the window, 12 months back to 18 ahead: open, pick a day, back, the chevrons (the 1st, or today in today's month), Today, and the clamp after midnight.
- **The months to fetch** (§5, Ruling 7), most wanted first, which E8 hands to E3's loader as `getMonths()`: the month in view and its neighbours always, then the near months.
- **Where entering picked scrolls** (Ruling 6, review patch): the top, or on a short screen as far down as shows the day's header and first row (`pickedScrollTop`).

Nothing renders the model yet: E6, E7 and E8 do. No user sees a change, and the switch is unchanged.

**Files** (the state this task starts from: 0064e8f with E1, E2 and E3 applied):
- Prerequisite: E2 (`grid.ts`; `isHebrewMonthStart` in `hebrew-date.ts`) and E3 (`DayCoverage.failure` and `dayFailure` in `store.ts`) are in. E5 reads no E1 copy and nothing of E4.
- Create: `src/lib/calendar-view/month.ts`
- Create (test): `scripts/smoke-calendar-month.ts`
- Modify: none. No existing file changes.
- Test: `scripts/smoke-calendar-month.ts` under `TZ=UTC`, `TZ=Asia/Jerusalem` and `TZ=Pacific/Kiritimati`. It also switches the process clock to Santiago and Los Angeles inside one check.
- Regression (unchanged), under `TZ=UTC` and `TZ=Asia/Jerusalem`:
  - `smoke-calendar-agenda` (37), `smoke-calendar-loader` (12), `smoke-calendar-grid` (11), `smoke-hebrew-date` (22): the modules `month.ts` imports;
  - `smoke-calendar-dto` (23): the server bucketing the new smoke builds its answers with;
  - `smoke-initdata-header` (9) and `smoke-auth-leftovers` (9), which scan `app/`, `src/` and `scripts/`;
  - `smoke-calendar-home-render` (42).

**Interfaces:**
- Consumes (line numbers as of the starting state):
  - from E2, `src/lib/calendar-view/grid.ts`: `type MonthKey` ('yyyy-MM'), `MONTHS_BACK` (12), `MONTHS_AHEAD` (18), `addMonths(month, n): MonthKey`, `monthFirstDay(month): DayKey`, `monthLastDay(month): DayKey`, `monthGrid(month, weekStart): DayKey[][]`, `monthOf(day): MonthKey` and `monthWindow(month): { from: DayKey; to: DayKey }`, each giving `''` (or `[]`) for a malformed key;
  - from E2, `src/lib/calendar-view/hebrew-date.ts:151`: `isHebrewMonthStart(dayKey: DayKey): boolean`;
  - from E3 and D3, `src/lib/calendar-view/store.ts`: `addDaysToKey(day, days)`, `dayItems(state, day)` (`:285`), `dayStatus(state, day)`, `failedSources(state, day)`, `dayFailure(state, day, source): SourceFailure | null` (`:321`), `isPartialDay(state, day)` (`:326`), and the types `CalendarStore`, `DayStatus` and `SourceFailure`;
  - from D3, `src/lib/calendar-view/agenda.ts`: `whoseItem(item, partnerName): Whose` (`:138`), `reminderMark(item): ReminderMark | null` (`:156`) and the type `AgendaRow` (`{ item; whose; mark }`);
  - from D5, `src/lib/calendar-view/format.ts`: `formatTime(value, tz, locale)` (`:140`), `instantDay(value, tz)` (`:163`) and `allDayLastDay(item)` (`:186`);
  - from D6, `src/lib/calendar-view/home-client.ts`: `type RangeWindow = { from: DayKey; to: DayKey }`, as `import type`;
  - from B3, `src/lib/calendar-view/types.ts`: `DayKey`, `ItemDTO`, `SourceName`, `WeekStart`;
  - in the smoke only: the server's `toRangeDays` and `toCalendarDto` (`src/services/calendar-read/dto.ts`), `OVERNIGHT_CUTOFF_HOUR` (`src/utils/day-events.ts:20`), `fromZonedTime` from `date-fns-tz`, and the types `ReadItem`, `CalendarRef`, `UnifiedEvent` and `ReminderInfo`.
- Produces, `src/lib/calendar-view/month.ts` (pure, client-safe; exactly the split's block):
  - `export type MonthLayout = 'browse' | 'picked'`
  - `export interface MonthUi { layout: MonthLayout; month: MonthKey; selected: DayKey | null }`: `selected` is set exactly when picked, to a day of `month`. In browse, `month` is the month to bring under the bar when browse comes back (the picked month after "All months").
  - `export const BROWSE_CELL_PX = 92`, `PICKED_CELL_PX = 48`, `BROWSE_SLOTS = 3`, `BROWSE_CHIPS_NARROW = 2`, `NARROW_MAX_PX = 360`, `PICKED_DOTS = 3`, and (review patch) `PICKED_FIRST_ROW_PX = 64`
  - `export function monthTitlePx(hebrewDates: boolean): number`: 42, or 58 with the Hebrew line
  - `export function monthBarPx(hebrewDates: boolean): number`: 72, or 76; the titles' `scroll-margin-top` is this plus the safe areas
  - `export function monthBlockPx(rows: number, hebrewDates: boolean): number`: `monthTitlePx(hebrewDates) + rows × BROWSE_CELL_PX`
  - `export function monthOffsets(months: readonly MonthKey[], weekStart: WeekStart, hebrewDates: boolean): number[]`: each month's top from the list's top (0 first, then the blocks above it added up)
  - `export function monthsInViewport(offsets: readonly number[], top: number, bottom: number): { first: number; last: number }`: `first` is the month whose block holds `top`, and `last` the last one that starts above `bottom`, both clamped to the list
  - `export type SlotKind = 'bar' | 'allDay' | 'timed' | 'spacer'`
  - `export interface MonthSlot { kind: SlotKind; key: string | null; title: string | null; showTitle: boolean; mine: boolean; done: boolean; continuesBefore: boolean; continuesAfter: boolean }`: `key` and `title` are null for a spacer, and `continuesBefore`/`continuesAfter` are false on every slot that isn't a bar
  - `export interface MonthCell { day: DayKey; inMonth: boolean; today: boolean; status: DayStatus; slots: MonthSlot[]; dots: boolean[]; count: number; fromPartner: number; hebrewMonthStart: boolean }`
  - `export interface MonthNotice { source: SourceName; kind: 'failed' | 'partial'; failure: SourceFailure | null }`
  - `export interface MonthModel { month: MonthKey; weeks: MonthCell[][]; status: DayStatus; notices: MonthNotice[]; partner: string | null }`
  - `export function buildMonth(store: CalendarStore, month: MonthKey): MonthModel | null`
  - `export function monthModels(store: CalendarStore): (month: MonthKey) => MonthModel | null`: the same function for the same store, and the same model for the same month
  - `export function limitSlots(slots: readonly MonthSlot[], maxChips: number): { shown: MonthSlot[]; more: number }`: interface note 5
  - (review patch) `export function limitRow(cells: readonly MonthCell[], maxChips: number): { shown: MonthSlot[]; more: number }[]`: one entry per cell, interface note 11
  - `export function limitDots(dots: readonly boolean[]): { shown: boolean[]; more: number }`
  - (review patch) `export function pickedScrollTop(layoutTop: number, dayHeadBottom: number, viewport: number): number`: interface note 12
  - `export function dayRows(store: CalendarStore, day: DayKey): AgendaRow[]`
  - `export function initialMonthUi(saved: MonthLayout | null, today: DayKey): MonthUi`
  - `export function pickDay(ui: MonthUi, day: DayKey): MonthUi`
  - `export function backToBrowse(ui: MonthUi): MonthUi`
  - `export function canStep(ui: MonthUi, delta: -1 | 1, today: DayKey): boolean`
  - `export function stepMonth(ui: MonthUi, delta: -1 | 1, today: DayKey): MonthUi`
  - `export function pickToday(ui: MonthUi, today: DayKey): MonthUi`
  - `export function clampMonthUi(ui: MonthUi, today: DayKey): MonthUi`
  - `export function wantedMonths(ui: MonthUi, near: readonly MonthKey[], inView: MonthKey | null, today: DayKey): RangeWindow[]`: each window is `monthWindow(m)`, the shape E3's loader counts against its cap
- **How E6–E8 call it** (pass the store's `today` and day keys, never a `new Date()`):
  ```
  // E8 (CalendarHome / MonthView)
  const getMonth = useMemo(() => monthModels(store), [store]);
  const [monthUi, setMonthUi] = useState(() => initialMonthUi(readMonthLayout(userId), today));   // once the facts are pinned
  setMonthUi((ui) => clampMonthUi(ui, today));                       // after a day change
  getMonths: () => (monthShowing ? wantedMonths(monthUi, near, inView, today) : []);   // E3's LoaderHost
  onPickDay: (day) => setMonthUi((ui) => pickDay(ui, day));          // back: backToBrowse; chevrons: stepMonth; Today: pickToday
  rows = dayRows(store, monthUi.selected); dayStatus(store, monthUi.selected);             // MonthPicked's list
  // E6 (MonthBrowse); months = monthSpan(today)
  const offsets = monthOffsets(months, weekStart, hebrewDates);       // the h2 at offsets[i], height monthTitlePx(hebrewDates)
  const { first } = monthsInViewport(offsets, scrollTopInList + monthBarPx(hebrewDates), scrollBottomInList);  // onMonthInView(months[first])
  const limited = limitRow(row, narrow ? BROWSE_CHIPS_NARROW : BROWSE_SLOTS);   // per week row; narrow: matchMedia(`(max-width: ${NARROW_MAX_PX}px)`)
  const { shown, more } = limited[col];
  // a slot: 'spacer' → an empty 18 px line; showTitle false → the bar with no text; more > 0 → "+{more}" after `shown`
  // E7 (MonthPicked)
  const { shown: dots, more: plus } = limitDots(cell.dots);           // filled when true, a ring when false; "+{plus}" when > 0
  disabled = !canStep(monthUi, -1, today) / !canStep(monthUi, 1, today);
  window.scrollTo(0, pickedScrollTop(layoutTopInDocument, dayHeaderBottomInDocument, window.innerHeight));   // on mount
  ```
  The cell's label (E1's note) reads `count` and `fromPartner` with `model.partner`, and `status` for "loading" or "couldn't load". A notice's `failure.kind` picks the copy: `busy` → `state.busy`, `calendarsGone` → `state.calendarsGone` with Choose again, `error` → `month.failed` with Retry; `partial` → `state.partial`.

**Findings that shaped the code** (line numbers as of the starting state):
- **The 06:00 rule at the edges.** `daySpanOf` (`src/utils/day-events.ts:58-86`) drops an item from a day it started before when it ends by `OVERNIGHT_CUTOFF_HOUR` (6) there (`:82-83`). So on the month's last day, an item marked `endsLater` or `spansDay` is listed on the next day exactly when it ends after that day (its end's local day is later) or ends on it after 06:00. `month.ts` reads the end's local day with `instantDay` and its wall time with `formatTime(end, tz, 'en')` ("HH:mm", h23) and compares with `'06:00'`.
  - The constant is restated in `month.ts`, because `day-events.ts` is a server module. The smoke reads `OVERNIGHT_CUTOFF_HOUR` and checks that the two agree.
  - A tail ending at 06:00:30 reads as 06:00 here but is kept by `daySpanOf` (`end <= cutoff`). Every item the home shows ends on a whole minute, so this costs nothing.
  - On the month's first day, `continues` or `spansDay` means the item is on the day before too: it started earlier and ends after the day's start, so the 06:00 rule can't drop it there.
  - Checked against the server: the smoke builds every month's days with the route's own `toRangeDays` (`src/services/calendar-read/dto.ts:134-162`, which calls `daySpanOf`) and compares each edge slot's flag with what the other month's answer lists. Israel's Sep/Oct/Nov fixtures and New York's 31 October (the US DST end at 02:00 on 1 November) cover 05:30 (dropped), exactly 06:00 (dropped), 06:30 (kept) and an item over two nights.
- **Inside the month the store decides.** Each day a timed item touches is listed by the server with its own span mark, and the store keeps it on each such day (`store.ts:285`). A timed item continues to the next day when that day lists the same occurrence: the same key and the same `start`. The start guard matters because `google-map.ts:103` keys an event without an id `google|<calendar>|`, so two such events on consecutive days would otherwise join into a bar. The smoke has that case.
- **A month never reads another month's days.** With the edges read from span marks and the interior from the month's own days, a month's model is the same whether its neighbours are loaded or not. So a month's rows never reflow when the next month answers, which matters because the browse renders 31 months at fixed heights. The smoke checks October alone against October with both neighbours.
- **All-day bars come from their dates** (`allDayLastDay`, `format.ts:186`): an exclusive end, so `'2026-10-25'`–`'2026-10-30'` is drawn on the 25th to the 29th.
- **Lanes.**
  - Greedy, per week row: the bars sorted as in the interface note, each in the lowest lane that is free on all its days in the row.
  - With "longer first" read as the run's length in the row, two bars could swap lanes between rows. "Visit A" (12–16 Nov) and "Visit B" (14–21 Nov) at week start 0: in the row from the 15th, B's run is 7 days and A's 2, so B would jump to lane 0 and A to lane 1. With the real start in the order, A keeps lane 0 in both rows.
  - All-day before timed among bars that start on the same day follows `compareItems`, which lists all-day items first.
- **Titles.** A bar's run in a row starts at its own first day, at day 1 when it comes from the month before, or at the row's first column when it comes from the row before. So "the first day drawn this month and at each week-row start" is one rule: the title shows on the first day of each run.
- **Daily reminders.** `repeatsDaily` is set by the DTO for `kind === 'reminder'` with `FREQ=DAILY` (`dto.ts:84`), so a daily event is still drawn and a weekly reminder is too. The smoke checks every October day.
- **Heights,** from the approved `MonthFlow.dc.html`:
  - the month title `.mh` is padded 14 px above and 6 px below;
  - the sticky bar `.sbar` has a 48 px minimum, and its Today pill is 36 px there, raised to 44 px by the touch rule;
  - the weekday row `.wk` is 12 px text with 6 + 4 px of padding and a 1 px border;
  - the cell is 92 px.

  The 22 px title line matches the bar's title line, the 16 px Hebrew line holds 12–13 px text over the 11 px floor, and the bar gets 4 more px when it carries two lines. E6 sets the heights exactly, so `monthOffsets` stays true.
- **Hebrew month starts** (measured with `@hebcal/hdate` 0.21.1): 1 Cheshvan 5787 is 12 October 2026, 1 Kislev is 11 November 2026, and July 2030 has 1 Tamuz on the 2nd and 1 Av on the 31st (with 30 Sivan on the 1st), so its first cell and two more name a month.
- **Status and notices.** `dayStatus` is `loading` while a source has neither answered nor failed for the day (`store.ts:294-308`). So a month with any such day is loading, one with every day answered is answered, and anything else is failed. Both writers overwrite a day's failure only where no ok answer covers it (`store.ts:224`, `:265`), so a day's failure is the latest that covered it. The earliest failing day can therefore differ from `lastFailure`. The smoke's October is busy from the 1st and has calendars gone from the 25th, while the latest failure is November's error, and the notice says busy.
- **Memo.** `monthModels` keeps one function per store in a `WeakMap` and builds a month the first time it is asked. Every answer gives a new store, so a model never outlives its store, and an old store's function keeps its own models. A malformed month is cached as `null`.
- **`dayRows`** builds the Agenda's rows as `toRow` does (`agenda.ts:165-167`, not exported): `{ item, whose: whoseItem(item, partner), mark: reminderMark(item) }`, with the store's partner name.
- **Review patch: the overflow rule.** Lanes are fixed per row, so a lane-2 bar on a day whose lanes 0 and 1 are free kept two spacers, and the old "drop a trailing spacer" left the 9th of the review's Alpha 5–7, Beta 6–8, Gamma 7–9 with nothing but "+1" on a 360 px screen (its probe `bars.ts`). The patch keeps the lanes while the slots fit (wide, the three bars line up across the row, as before) and spends the empty lanes only on a day that overflows: one-day items first (the bars stay in line), then the bars move up. A bar that moves up, or comes back after a day that hid it, is named again; `limitRow` does the second part, because only the row knows what the day before drew. Every row of the autumn fixtures, at both widths, is checked for: no spacer over "+N", no "+N" while the items fit, no item lost, no bar nameless.
- **Review patch: the neighbours always wanted.** An IntersectionObserver whose root is the implicit one ignores `rootMargin` in a cross-origin iframe (Telegram Web K and A), so there `near` was the months on screen only, and the months next to them were drawn (E6 draws the month in view's neighbours) but not fetched. On the mobile clients `near` already holds them, so nothing more is sent there.
- **Review patch: entering picked on a short screen.** E7's fixed heights, with D's header (75 px with the Hebrew line) and E4's tab bar (48 px) above, put a 6-row month's day header at 571 px from the top, 695 px under the trial and location banners; the screen under Telegram's header on a 375 × 667 phone is about 560-590 px, so the day's list started below it. `pickedScrollTop` keeps Ruling 6's top where it fits and shows the day's start where it doesn't; E7 measures the layout and passes the numbers.
- **Mutations caught** (48, each run alone under UTC and Kiritimati):
  - cells: daily reminders drawn, `mine` from `calendar.mine`, done ignored, dots with spacers, singles before bars, a blank cell marked today, and `hebrewMonthStart` without day 1 or without the first cell;
  - edges and bars: the edges read from the store (before and after), the interior read from spans, the all-day end read from the store, the cutoff as `>=`, at 07:00 or ignored, and `listedOn` without the start;
  - lanes and titles: no start, no length, the key reversed, the run's length first, no spacers, the title only where the item starts, and the title on every day;
  - status and notices: failed before loading, `lastFailure` first, the latest failing day, a reconnect notice, and no partial notice;
  - limits: keeping `limit` slots, counting spacers, no trailing trim, and 2 dots;
  - navigation: `dayRows` without daily reminders, a restored picked layout on the 1st, `backToBrowse` with no identity, a window one month longer, `stepMonth` always on the 1st, and `clampMonthUi` resetting a picked day;
  - `wantedMonths`: the earlier month first on a tie, picked's previous month before the next, `inView` left out, and no window filter;
  - geometry: offsets that include their own block, `monthsInViewport` with `<`, and an 18 px title padding;
  - the memo off, a server module imported, and a value import from `home-client.ts`.
  - review patch (9, each caught under UTC; `erev/mut/m-e5.py`): no packing, no compaction, a moved bar left untitled, `limitRow` without its title pass, the title pass by key only (a bar back in its lane after being moved up), the old prefix with spacers over "+N", `wantedMonths` without the neighbours, `pickedScrollTop` without its cap and without the first row.
- **Verified** on a scratch copy of 0064e8f with E1, E2 and E3 applied by `dapply.py` (files byte-identical to the drafters' trees):
  - Before: the new smoke exits 1 with `Cannot find module '../src/lib/calendar-view/month'` under all three clocks.
  - After: 26/26 under UTC, Asia/Jerusalem and Pacific/Kiritimati, plus the in-process Santiago and Los Angeles clocks (24/24 before the review patch, which changes three assertions of the limitSlots check and three of the wantedMonths check, and adds the limitRow and pickedScrollTop checks).
  - `tsc --noEmit`, `eslint .` and `check-i18n-parity` are clean.
  - The regression smokes print the same lines before and after under UTC and Asia/Jerusalem: agenda 37/37, loader 12/12, grid 11/11, hebrew-date 22/22, dto 23/23, initdata-header 9/9, auth-leftovers 9/9, render 42/42.
  - This task text, applied with `dapply.py` to a fresh copy (0064e8f, E1–E3, then E5), gives files byte-identical to the verified ones, and the smoke and Step 7's commit ran there as written.
- **Verified against stand-ins:** none. E5 reads only E2 and E3 (wave 1), applied as written; E4 (same wave) exports nothing E5 uses.
- **Not verified:** `next build` (the controller's fresh-clone build after E8 covers it), Node 22 (the local Node is 26.11.1), and the model inside E6–E8's views and on a device.
- **D's deferred list:** E5 takes none of it. Ruling 10 gives the per-window failure and the timezone map to E3 and the parity parser to E1, and leaves the rest for before `ALL`. E5 reads E3's per-day failure.

- [ ] **Step 1: Write the failing smoke `scripts/smoke-calendar-month.ts`**

Create the file with exactly this content:

```ts
// Smoke test for the Month's model (spec §7.4, §5's month windows, Rulings R11 and R12;
// Plan E Rulings 3–7; Task E5): src/lib/calendar-view/month.ts.
//
// Each month draws its own days, and the days of its rows outside it are blank (R12).
// A cell's slots are the bars first, by lane, then its one-day items; whose an item is
// follows the Agenda's rule, and a done reminder is struck through. Daily-repeating
// reminders are left out of the slots, the dots and the counts (R11, Ruling 5) but are
// listed for the picked day. A bar is an all-day item over its dates or a timed one
// the store lists on the next or the day before; at the month's edges its span marks
// decide, with daySpanOf's 06:00 rule, and the checks hold that against the server's
// own bucketing of the next month. Lanes are per week row, with spacers that keep a
// bar in line; a bar's title shows on the first day it is drawn in each row. A cell
// shows 3 slots, or 2 and "+N" (Ruling 3); a day with more than fits lets its one-day
// items into a bar's empty lanes, then moves its bars up with their titles, so no cell
// shows an empty line over "+N" (limitRow, per week row). A month is answered, loading or failed, and
// its notices carry the earliest failing day's reason, never a reconnect. Then the
// layout's navigation over the window of 12 months back to 18 ahead, the months to
// fetch (Ruling 7), the block heights the browse lays out with, and the memo.
//
// The store is fed real answers for month windows: the fixtures are ReadItems, each
// month's days come from the server's toRangeDays (daySpanOf, as the route builds
// them), and they go through D3's reducer. Pure: no network, no database, no React.
//
// Run with the fake env from the plan, under three clocks (the output must not depend
// on the process timezone):
//   TZ=UTC npx tsx scripts/smoke-calendar-month.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-calendar-month.ts
//   TZ=Pacific/Kiritimati npx tsx scripts/smoke-calendar-month.ts

import {
  BROWSE_CELL_PX,
  BROWSE_CHIPS_NARROW,
  BROWSE_SLOTS,
  NARROW_MAX_PX,
  PICKED_CELL_PX,
  PICKED_DOTS,
  PICKED_FIRST_ROW_PX,
  backToBrowse,
  buildMonth,
  canStep,
  clampMonthUi,
  dayRows,
  initialMonthUi,
  limitDots,
  limitRow,
  limitSlots,
  monthBarPx,
  monthBlockPx,
  monthModels,
  monthOffsets,
  monthTitlePx,
  monthsInViewport,
  pickDay,
  pickToday,
  pickedScrollTop,
  stepMonth,
  wantedMonths,
  type MonthCell,
  type MonthModel,
  type MonthSlot,
  type MonthUi,
} from '../src/lib/calendar-view/month';
import fs from 'fs';
import path from 'path';
import { fromZonedTime } from 'date-fns-tz';
import { monthGrid } from '../src/lib/calendar-view/grid';
import { reminderMark, whoseItem } from '../src/lib/calendar-view/agenda';
import {
  dayItems,
  dayStatus,
  emptyStore,
  homeNotices,
  reduceStore,
  type CalendarStore,
  type FamcalStatus,
  type GoogleStatus,
  type StoreAction,
} from '../src/lib/calendar-view/store';
import type { DayKey, RangeResponse, SourceName, WeekStart } from '../src/lib/calendar-view/types';
import { toCalendarDto, toRangeDays } from '../src/services/calendar-read/dto';
import type { CalendarRef, ReadItem } from '../src/services/calendar-read/types';
import type { UnifiedEvent } from '../src/services/calendar-provider/types';
import type { ReminderInfo } from '../src/types';
import { OVERNIGHT_CUTOFF_HOUR } from '../src/utils/day-events';

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
}

function assert(cond: boolean, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

function assertJson(got: unknown, want: unknown, label: string) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  assert(g === w, `${label}\n     got  ${g}\n     want ${w}`);
}

// ---- Fixtures: a FamCal user in Israel paired with Noa, Thursday 15 October 2026 ----

const IL = 'Asia/Jerusalem';
const NY = 'America/New_York';
const TODAY = '2026-10-15';
/** The clock the open marks are read at: 09:00 in Israel. */
const NOW = fromZonedTime('2026-10-15 09:00:00', IL);

/** A FamCal timed value: the UTC ISO string of a local wall time. */
const utc = (local: string, tz = IL) => fromZonedTime(local, tz).toISOString();

const OWN_CAL: CalendarRef = { id: 'native:cal-own', source: 'famcal', name: 'Raziel', color: '#039BE5', mine: true, inLegend: true };
const NOA_SHARED: CalendarRef = { id: 'native:cal-noa', source: 'famcal', name: 'Noa family', color: '#E67C73', mine: false, ownerName: 'Noa', inLegend: true };
const FAMILY_G: CalendarRef = { id: 'family@group.calendar.google.com', source: 'google', name: 'Family', color: '#7986CB', mine: true, inLegend: true };

type Extra = {
  kind?: 'event' | 'reminder';
  rrule?: string | null;
  state?: { doneAt: Date | null; snoozedUntil: Date | null };
  reminder?: ReminderInfo;
  calendar?: CalendarRef;
  tz?: string;
};

/** A FamCal ReadItem as readFamcal builds one. `eventId` 'series#instant' is a recurring instance. */
function famcal(eventId: string, title: string, start: string, end: string, extra: Extra = {}): ReadItem {
  const kind = extra.kind ?? 'event';
  const calendar = extra.calendar ?? OWN_CAL;
  const event: UnifiedEvent = {
    summary: title,
    start,
    end,
    calendarName: calendar.name,
    calendarId: calendar.id ?? 'native:cal-own',
    eventType: kind === 'reminder' ? 'reminder' : undefined,
    recurringEventId: eventId.includes('#') ? eventId.split('#')[0] : undefined,
    eventId,
    provider: 'native',
    instanceStartsAt: eventId.includes('#') ? eventId.split('#')[1] : undefined,
    timeZone: extra.tz ?? IL,
    ...(kind === 'reminder' ? { reminder: extra.reminder ?? { ownerIsViewer: true, creatorIsViewer: true } } : {}),
  };
  return {
    source: 'famcal',
    key: `famcal|${eventId}`,
    event,
    calendar,
    title,
    kind,
    seriesId: eventId.split('#')[0],
    originalStart: start.includes('T') ? start : null,
    recurring: !!extra.rrule,
    rrule: extra.rrule ?? null,
    ...(extra.state ? { state: extra.state } : {}),
  };
}

/** A zero-length FamCal reminder at a timed instant. */
const reminder = (eventId: string, title: string, at: string, extra: Extra = {}) => famcal(eventId, title, at, at, { kind: 'reminder', ...extra });

/** A Google ReadItem on the Family calendar. */
function google(id: string, title: string, start: string, end: string): ReadItem {
  const event: UnifiedEvent = { summary: title, start, end, calendarName: FAMILY_G.name, calendarId: FAMILY_G.id ?? '', eventType: 'default', eventId: id, provider: 'google' };
  return {
    source: 'google',
    key: `google|${FAMILY_G.id}|${id}`,
    event,
    calendar: FAMILY_G,
    title,
    kind: 'event',
    seriesId: null,
    originalStart: null,
    recurring: false,
    rrule: null,
    google: { birthday: false, htmlLink: null },
  };
}

/** A month's own days, [1st, 1st of the next month), worked out here rather than with grid.ts. */
function windowOf(month: string): { from: DayKey; to: DayKey } {
  const [y, m] = month.split('-').map(Number);
  return { from: `${month}-01`, to: new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10) };
}

const pad = (n: number) => String(n).padStart(2, '0');
const OCTOBER = Array.from({ length: 31 }, (_, i) => `2026-10-${pad(i + 1)}`);

type AnswerOpts = {
  month?: string;
  today?: DayKey;
  window?: { from: DayKey; to: DayKey };
  tz?: string;
  weekStart?: WeekStart;
  famcal?: FamcalStatus;
  google?: GoogleStatus;
};

/**
 * The route's answer for a window (a month's by default), with the days the server's
 * toRangeDays buckets. A FamCal user's answer, or a Google user's when `google` is given.
 * Only an ok source's items are in it, as on the server.
 */
function answer(items: ReadItem[], o: AnswerOpts): RangeResponse {
  const tz = o.tz ?? IL;
  const today = o.today ?? TODAY;
  const { from, to } = o.window ?? windowOf(o.month ?? '2026-10');
  const isGoogle = o.google !== undefined;
  const status = isGoogle ? o.google! : (o.famcal ?? { status: 'ok' as const });
  const source: SourceName = isGoogle ? 'google' : 'famcal';
  const kept = status.status === 'ok' ? items.filter((i) => i.source === source) : [];
  return {
    tz,
    today,
    weekStart: o.weekStart ?? 0,
    hebrewDates: true,
    from,
    to,
    sources: isGoogle ? { google: o.google } : { famcal: status as FamcalStatus },
    partner: isGoogle ? null : { name: 'Noa' },
    calendars: (isGoogle ? [FAMILY_G] : [OWN_CAL, NOA_SHARED]).map(toCalendarDto),
    days: toRangeDays(kept, from, to, tz, NOW, today),
  };
}

const respond = (response: RangeResponse, epoch = 0): StoreAction => ({ type: 'response', response, epoch });
const storeOf = (actions: StoreAction[]) => actions.reduce(reduceStore, emptyStore());

// The family's autumn, in Israel.
const daily = OCTOBER.map((d) => reminder(`vit#${utc(`${d} 08:00`)}`, 'Take vitamins', utc(`${d} 08:00`), { rrule: 'FREQ=DAILY' }));
const weekly = ['2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26'].map((d) =>
  reminder(`recycle#${utc(`${d} 21:00`)}`, 'Take out the recycling', utc(`${d} 21:00`), { rrule: 'FREQ=WEEKLY;BYDAY=MO' })
);
const ITEMS: ReadItem[] = [
  // Across September and October.
  famcal('trip', 'Sukkot trip', '2026-09-29', '2026-10-03'),
  famcal('shift', 'Night shift', utc('2026-09-30 20:00'), utc('2026-10-01 08:00')),
  // Whose and done, on Wednesday 14 October.
  famcal('gym', 'Gym', utc('2026-10-14 07:00'), utc('2026-10-14 08:00')),
  famcal('pilates', 'Pilates', utc('2026-10-14 19:00'), utc('2026-10-14 20:00'), { calendar: NOA_SHARED }),
  // A reminder goes by its owner, not its calendar: Noa's for the viewer on her calendar, the viewer's for Noa on theirs.
  reminder('plumber', 'Call the plumber', utc('2026-10-14 11:00'), { reminder: { ownerIsViewer: true, creatorIsViewer: false, creatorName: 'Noa' }, calendar: NOA_SHARED }),
  reminder('flowers', 'Buy flowers', utc('2026-10-14 12:00'), { reminder: { ownerIsViewer: false, creatorIsViewer: true, ownerName: 'Noa' } }),
  reminder('bill', 'Pay the bill', utc('2026-10-14 09:00'), { state: { doneAt: new Date(utc('2026-10-14 09:05')), snoozedUntil: null } }),
  // Bars inside October.
  famcal('sleepover', 'Kids sleepover', utc('2026-10-16 18:00'), utc('2026-10-17 10:00'), { calendar: NOA_SHARED }),
  famcal('conf', 'Conference', utc('2026-10-19 09:00'), utc('2026-10-21 17:00')),
  famcal('hack', 'Hackathon', utc('2026-10-20 10:00'), utc('2026-10-22 16:00')),
  famcal('party', 'Party at Dana', utc('2026-10-23 22:00'), utc('2026-10-24 02:00')),
  famcal('eilat', 'Eilat trip', '2026-10-25', '2026-10-30'),
  famcal('grandma', 'Grandma visits', '2026-10-27', '2026-10-29', { calendar: NOA_SHARED }),
  famcal('snorkel', 'Snorkeling', utc('2026-10-26 10:00'), utc('2026-10-26 12:00'), { calendar: NOA_SHARED }),
  // Across October and November.
  famcal('halloween', 'Halloween party', utc('2026-10-31 22:00'), utc('2026-11-01 02:00')),
  famcal('flight', 'Late flight', utc('2026-10-31 23:00'), utc('2026-11-01 07:30')),
  famcal('weekend', 'Family weekend', '2026-10-31', '2026-11-02'),
  // Lanes in November: the same dates go by key, the same start by length (the longer has the later key),
  // and an earlier start keeps its lane above a longer bar from the row's first day.
  famcal('twin-b', 'Twin B', '2026-11-09', '2026-11-11'),
  famcal('twin-a', 'Twin A', '2026-11-09', '2026-11-11'),
  famcal('long-a', 'Visit A', '2026-11-12', '2026-11-17'),
  famcal('long-b', 'Visit B', '2026-11-14', '2026-11-22'),
  famcal('expo', 'Expo', '2026-11-22', '2026-11-24'),
  famcal('tour', 'Bike tour', '2026-11-22', '2026-11-26'),
  ...daily,
  ...weekly,
];

const AUTUMN = ['2026-09', '2026-10', '2026-11'];
/** September, October and November answered, at week start `ws`. */
const autumn = (ws: WeekStart) => storeOf(AUTUMN.map((m) => respond(answer(ITEMS, { month: m, weekStart: ws }))));
const STORE_0 = autumn(0);
const STORE_1 = autumn(1);

const idOf = (key: string | null) => (key ?? '').replace(/^famcal\|/, '').replace(/#.*$/, '');
/**
 * A slot as a short string: kind:id, then * when the title shows, < and > for a bar
 * that goes on before and after, ~ for the partner's, x for done; a spacer is _.
 */
const show = (s: MonthSlot) =>
  s.kind === 'spacer'
    ? '_'
    : `${s.kind}:${idOf(s.key)}${s.showTitle ? '*' : ''}${s.continuesBefore ? '<' : ''}${s.continuesAfter ? '>' : ''}${s.mine ? '' : '~'}${s.done ? 'x' : ''}`;

function modelOf(store: CalendarStore, month: string): MonthModel {
  const model = buildMonth(store, month);
  assert(model !== null, `no model for ${month}`);
  return model;
}

function cellOf(model: MonthModel, day: DayKey): MonthCell {
  const cell = model.weeks.flat().find((c) => c.day === day && c.inMonth);
  assert(cell !== undefined, `no in-month cell ${day} in ${model.month}`);
  return cell;
}

/** Each listed day's slots as strings. */
function slotsOf(model: MonthModel, days: DayKey[]): Record<DayKey, string[]> {
  const out: Record<DayKey, string[]> = {};
  for (const d of days) out[d] = cellOf(model, d).slots.map(show);
  return out;
}

const keysOn = (store: CalendarStore, day: DayKey) => dayItems(store, day).map((i) => i.key);

const ui = (layout: 'browse' | 'picked', month: string, selected: DayKey | null = null): MonthUi => ({ layout, month, selected });
const slot = (kind: MonthSlot['kind'], id: string | null): MonthSlot => ({
  kind,
  key: id === null ? null : `famcal|${id}`,
  title: id,
  showTitle: kind !== 'spacer',
  mine: true,
  done: false,
  continuesBefore: false,
  continuesAfter: false,
});
const chips = (n: number) => Array.from({ length: n }, (_, i) => slot('timed', `c${i}`));

async function main() {
  await check('whose and done: the viewer\'s chips filled, the partner\'s outlined (whoseItem), a done reminder struck through; dots and counts follow', () => {
    const oct = modelOf(STORE_0, '2026-10');
    const cell = cellOf(oct, '2026-10-14');
    assertJson(cell.slots.map(show), ['timed:gym*', 'timed:bill*x', 'timed:plumber*', 'timed:flowers*~', 'timed:pilates*~'], '14 October');
    assertJson(cell.dots, [true, true, true, false, false], 'dots');
    assert(cell.count === 5 && cell.fromPartner === 2, `count ${cell.count}, fromPartner ${cell.fromPartner}`);
    assert(oct.partner === 'Noa', `partner ${oct.partner}`);
    // Every drawn slot of the month against the Agenda's rules for the same item.
    for (const c of oct.weeks.flat().filter((x) => x.inMonth)) {
      const items = new Map(dayItems(STORE_0, c.day).map((i) => [i.key, i]));
      for (const s of c.slots) {
        if (s.kind === 'spacer') continue;
        const item = items.get(s.key ?? '');
        assert(item !== undefined, `${c.day}: ${s.key} is not a day item`);
        assert(s.mine === whoseItem(item, 'Noa').mine, `${c.day} ${s.key}: mine ${s.mine}`);
        assert(s.done === (reminderMark(item) === 'done'), `${c.day} ${s.key}: done ${s.done}`);
        assert(s.title === item.title, `${c.day} ${s.key}: title ${s.title}`);
      }
      const drawn = c.slots.filter((s) => s.kind !== 'spacer');
      assertJson(c.dots, drawn.map((s) => s.mine), `${c.day} dots`);
      assert(c.count === drawn.length && c.fromPartner === drawn.filter((s) => !s.mine).length, `${c.day} counts`);
    }
  });

  await check('the Eilat trip (25–29 October): one bar along its week row at week start 0, its title on the 25th only; Grandma\'s visit in lane 1', () => {
    const oct = modelOf(STORE_0, '2026-10');
    assertJson(
      slotsOf(oct, ['2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30']),
      {
        '2026-10-25': ['bar:eilat*>'],
        '2026-10-26': ['bar:eilat<>', 'timed:snorkel*~', 'timed:recycle*'],
        '2026-10-27': ['bar:eilat<>', 'bar:grandma*>~'],
        '2026-10-28': ['bar:eilat<>', 'bar:grandma<~'],
        '2026-10-29': ['bar:eilat<'],
        '2026-10-30': [],
      },
      'week start 0'
    );
  });

  await check('the Eilat trip across two week rows at week start 1: the title again at the second row\'s start', () => {
    const oct = modelOf(STORE_1, '2026-10');
    assertJson(
      slotsOf(oct, ['2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29']),
      {
        '2026-10-25': ['bar:eilat*>'],
        '2026-10-26': ['bar:eilat*<>', 'timed:snorkel*~', 'timed:recycle*'],
        '2026-10-27': ['bar:eilat<>', 'bar:grandma*>~'],
        '2026-10-28': ['bar:eilat<>', 'bar:grandma<~'],
        '2026-10-29': ['bar:eilat<'],
      },
      'week start 1'
    );
    assert(oct.weeks[3][6].day === '2026-10-25' && oct.weeks[4][0].day === '2026-10-26', 'the 25th ends a row and the 26th starts the next');
  });

  await check('lanes per week row: the same start goes by length, then key; an earlier start keeps its lane above a longer bar from the row\'s first day', () => {
    const nov = modelOf(STORE_0, '2026-11');
    assertJson(
      slotsOf(nov, ['2026-11-09', '2026-11-10', '2026-11-12', '2026-11-14', '2026-11-15', '2026-11-16', '2026-11-17', '2026-11-22', '2026-11-24']),
      {
        '2026-11-09': ['bar:twin-a*>', 'bar:twin-b*>'],
        '2026-11-10': ['bar:twin-a<', 'bar:twin-b<'],
        '2026-11-12': ['bar:long-a*>'],
        '2026-11-14': ['bar:long-a<>', 'bar:long-b*>'],
        '2026-11-15': ['bar:long-a*<>', 'bar:long-b*<>'],
        '2026-11-16': ['bar:long-a<', 'bar:long-b<>'],
        '2026-11-17': ['_', 'bar:long-b<>'],
        '2026-11-22': ['bar:tour*>', 'bar:expo*>'],
        '2026-11-24': ['bar:tour<>'],
      },
      'November at week start 0'
    );
  });

  await check('a bar continuing from the previous month into day 1: the all-day Sukkot trip and the timed night shift, with September\'s side', () => {
    const oct = modelOf(STORE_0, '2026-10');
    assertJson(slotsOf(oct, ['2026-10-01', '2026-10-02', '2026-10-03']), {
      '2026-10-01': ['bar:trip*<>', 'bar:shift*<'],
      '2026-10-02': ['bar:trip<'],
      '2026-10-03': [],
    }, 'October');
    const sep = modelOf(STORE_0, '2026-09');
    assertJson(slotsOf(sep, ['2026-09-28', '2026-09-29', '2026-09-30']), {
      '2026-09-28': [],
      '2026-09-29': ['bar:trip*>'],
      '2026-09-30': ['bar:trip<>', 'bar:shift*>'],
    }, 'September');
    // The row they share is blank on the other month's days (R12).
    for (const c of sep.weeks[4]) if (c.day >= '2026-10-01') assert(!c.inMonth && c.slots.length === 0, `${c.day} is blank in September`);
    for (const c of oct.weeks[0]) if (c.day < '2026-10-01') assert(!c.inMonth && c.slots.length === 0, `${c.day} is blank in October`);
  });

  await check('a Mon–Wed timed conference is one bar; Tuesday–Thursday\'s hackathon takes lane 1, with a spacer in lane 0 on Thursday', () => {
    const oct = modelOf(STORE_0, '2026-10');
    assertJson(
      slotsOf(oct, ['2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22']),
      {
        '2026-10-18': [],
        '2026-10-19': ['bar:conf*>', 'timed:recycle*'],
        '2026-10-20': ['bar:conf<>', 'bar:hack*>'],
        '2026-10-21': ['bar:conf<', 'bar:hack<>'],
        '2026-10-22': ['_', 'bar:hack<'],
      },
      'week of the 18th'
    );
    const thursday = cellOf(oct, '2026-10-22');
    assert(thursday.count === 1 && thursday.dots.length === 1, 'the spacer is not an item');
  });

  await check('an overnight 22:00–02:00 item is a one-day chip, inside the month and on its last day; a sleepover until 10:00 is a bar', () => {
    const oct = modelOf(STORE_0, '2026-10');
    assertJson(slotsOf(oct, ['2026-10-16', '2026-10-17', '2026-10-23', '2026-10-24', '2026-10-31']), {
      '2026-10-16': ['bar:sleepover*>~'],
      '2026-10-17': ['bar:sleepover<~'],
      '2026-10-23': ['timed:party*'],
      '2026-10-24': [],
      '2026-10-31': ['bar:weekend*>', 'bar:flight*>', 'timed:halloween*'],
    }, 'October');
    const nov = modelOf(STORE_0, '2026-11');
    assertJson(slotsOf(nov, ['2026-11-01', '2026-11-02']), { '2026-11-01': ['bar:weekend*<', 'bar:flight*<'], '2026-11-02': [] }, 'November');
    assert(!keysOn(STORE_0, '2026-11-01').includes('famcal|halloween'), 'the server lists the party\'s tail on 1 November');
  });

  await check('at the month\'s edges the span marks agree with the next month\'s own answer (Israel, and New York\'s DST end on 1 November)', () => {
    const edge = (store: CalendarStore, a: string, b: string) => {
      const last = `${a}-${pad(new Date(Date.UTC(Number(a.slice(0, 4)), Number(a.slice(5, 7)), 0)).getUTCDate())}`;
      const first = `${b}-01`;
      const after = cellOf(modelOf(store, a), last).slots.filter((s) => s.kind !== 'spacer');
      const before = cellOf(modelOf(store, b), first).slots.filter((s) => s.kind !== 'spacer');
      for (const s of after) {
        const listed = keysOn(store, first).includes(s.key ?? '');
        assert(s.continuesAfter === listed, `${last} ${s.key}: continuesAfter ${s.continuesAfter}, listed on ${first}: ${listed}`);
      }
      for (const s of before) {
        const listed = keysOn(store, last).includes(s.key ?? '');
        assert(s.continuesBefore === listed, `${first} ${s.key}: continuesBefore ${s.continuesBefore}, listed on ${last}: ${listed}`);
      }
      return after.length + before.length;
    };
    assert(edge(STORE_0, '2026-09', '2026-10') === 4 && edge(STORE_0, '2026-10', '2026-11') === 5, 'the edge fixtures');
    const nyItems = [
      famcal('ny-short', 'Ends 05:30', utc('2026-10-31 22:00', NY), utc('2026-11-01 05:30', NY), { tz: NY }),
      famcal('ny-six', 'Ends 06:00', utc('2026-10-31 22:00', NY), utc('2026-11-01 06:00', NY), { tz: NY }),
      famcal('ny-late', 'Ends 06:30', utc('2026-10-31 22:00', NY), utc('2026-11-01 06:30', NY), { tz: NY }),
      famcal('ny-long', 'Two nights', utc('2026-10-31 20:00', NY), utc('2026-11-02 09:00', NY), { tz: NY }),
    ];
    const ny = storeOf(['2026-10', '2026-11'].map((m) => respond(answer(nyItems, { month: m, tz: NY }))));
    assert(edge(ny, '2026-10', '2026-11') === 6, 'the New York fixtures');
    assertJson(cellOf(modelOf(ny, '2026-10'), '2026-10-31').slots.map(show), ['bar:ny-long*>', 'bar:ny-late*>', 'timed:ny-short*', 'timed:ny-six*'], '31 October in New York');
  });

  await check('a month reads only its own days: October\'s model is the same with September and November loaded or not; inside it, the store decides', () => {
    const alone = storeOf([respond(answer(ITEMS, { month: '2026-10' }))]);
    assertJson(buildMonth(alone, '2026-10'), buildMonth(STORE_0, '2026-10'), 'October alone and with its neighbours');
    // With only the Agenda's week in, the 22nd hasn't answered: the hackathon stops at the 21st until it does.
    const week = storeOf([respond(answer(ITEMS, { window: { from: TODAY, to: '2026-10-22' } }))]);
    assertJson(slotsOf(modelOf(week, '2026-10'), ['2026-10-20', '2026-10-21', '2026-10-22']), {
      '2026-10-20': ['bar:conf<>', 'bar:hack*>'],
      '2026-10-21': ['bar:conf<', 'bar:hack<'],
      '2026-10-22': [],
    }, 'the Agenda\'s week only');
  });

  await check('daily reminders are left out of the slots, the dots and the counts (R11, Ruling 5) but are in dayRows; a weekly one is drawn', () => {
    const oct = modelOf(STORE_0, '2026-10');
    for (const d of OCTOBER) {
      const cell = cellOf(oct, d);
      assert(!cell.slots.some((s) => idOf(s.key) === 'vit'), `${d}: the daily reminder is drawn`);
      const rows = dayRows(STORE_0, d);
      assert(rows.filter((r) => idOf(r.item.key) === 'vit').length === 1, `${d}: dayRows lacks the daily reminder`);
      assert(rows.length === keysOn(STORE_0, d).length, `${d}: dayRows lists every item`);
      assert(cell.count === rows.filter((r) => !r.item.repeatsDaily).length, `${d}: count ${cell.count}`);
    }
    const saturday = cellOf(oct, '2026-10-03');
    assertJson([saturday.slots, saturday.dots, saturday.count, saturday.fromPartner], [[], [], 0, 0], 'a day with only the daily reminder');
    const rows = dayRows(STORE_0, '2026-10-14');
    assertJson(rows.map((r) => `${idOf(r.item.key)}:${r.whose.mine ? 'mine' : r.whose.person}:${r.mark ?? '-'}`), [
      'gym:mine:-', 'vit:mine:later', 'bill:mine:done', 'plumber:mine:later', 'flowers:Noa:later', 'pilates:Noa:-',
    ], 'the picked day\'s rows (the Agenda\'s, daily reminder included)');
    assert(cellOf(oct, '2026-10-12').slots.map(show).join() === 'timed:recycle*', 'the weekly reminder on Monday the 12th');
  });

  await check('limitSlots (Ruling 3): 3 → 3; 4 → 2 + "+2"; narrow 3 → 2 + "+1"; spacers never counted; past the limit the one-day items fill a bar\'s empty lanes, then the bars move up with their titles, so no spacer shows over "+N"; limitDots: 3, then "+N"', () => {
    const view = (r: { shown: MonthSlot[]; more: number }) => `${r.shown.map(show).join(' ')} +${r.more}`;
    assert(view(limitSlots(chips(3), BROWSE_SLOTS)) === 'timed:c0* timed:c1* timed:c2* +0', '3 wide');
    assert(view(limitSlots(chips(4), BROWSE_SLOTS)) === 'timed:c0* timed:c1* +2', '4 wide');
    assert(view(limitSlots(chips(3), BROWSE_CHIPS_NARROW)) === 'timed:c0* timed:c1* +1', '3 narrow');
    assert(view(limitSlots(chips(2), BROWSE_CHIPS_NARROW)) === 'timed:c0* timed:c1* +0', '2 narrow');
    assert(view(limitSlots([], BROWSE_SLOTS)) === ' +0', 'none');
    const withSpacer = [slot('spacer', null), slot('bar', 'b'), ...chips(2)];
    assert(view(limitSlots(withSpacer, BROWSE_SLOTS)) === 'timed:c0* bar:b* timed:c1* +0', `a spacer and 3 items, wide: the first one-day item in the spacer: ${view(limitSlots(withSpacer, BROWSE_SLOTS))}`);
    assert(view(limitSlots(withSpacer, BROWSE_CHIPS_NARROW)) === 'bar:b* timed:c0* +1', `a spacer and 3 items, narrow: ${view(limitSlots(withSpacer, BROWSE_CHIPS_NARROW))}`);
    const deep = [slot('spacer', null), slot('spacer', null), slot('bar', 'b')];
    assert(view(limitSlots(deep, BROWSE_SLOTS)) === '_ _ bar:b* +0', 'a lane-2 bar fits wide');
    assert(view(limitSlots(deep, BROWSE_CHIPS_NARROW)) === 'bar:b* +0', `a lane-2 bar, narrow: moved up to lane 0: ${view(limitSlots(deep, BROWSE_CHIPS_NARROW))}`);
    const untitled = [slot('spacer', null), { ...slot('bar', 'b'), showTitle: false }];
    assert(view(limitSlots(untitled, 1)) === 'bar:b* +0', `a bar that moves up shows its title: ${view(limitSlots(untitled, 1))}`);
    assert(view(limitSlots([...chips(1), slot('spacer', null)], BROWSE_SLOTS)) === 'timed:c0* +0', 'a trailing spacer goes');
    const hiddenSpacer = [slot('bar', 'b0'), slot('bar', 'b1'), slot('spacer', null), slot('bar', 'b3')];
    assert(view(limitSlots(hiddenSpacer, BROWSE_SLOTS)) === 'bar:b0* bar:b1* bar:b3* +0', `three bars in four lanes, wide: ${view(limitSlots(hiddenSpacer, BROWSE_SLOTS))}`);
    const four = [slot('bar', 'b0'), slot('spacer', null), slot('bar', 'b2'), ...chips(2)];
    assert(view(limitSlots(four, BROWSE_SLOTS)) === 'bar:b0* bar:b2* +2', `two bars and two items, wide: bars first: ${view(limitSlots(four, BROWSE_SLOTS))}`);
    const oct = modelOf(STORE_0, '2026-10');
    assert(view(limitSlots(cellOf(oct, '2026-10-14').slots, BROWSE_SLOTS)) === 'timed:gym* timed:bill*x +3', 'the 14th, wide');
    assert(view(limitSlots(cellOf(oct, '2026-10-26').slots, BROWSE_SLOTS)) === 'bar:eilat<> timed:snorkel*~ timed:recycle* +0', 'the 26th, wide');
    assert(view(limitSlots(cellOf(oct, '2026-10-26').slots, BROWSE_CHIPS_NARROW)) === 'bar:eilat<> timed:snorkel*~ +1', 'the 26th, narrow');
    assertJson(limitDots([true, false, true]), { shown: [true, false, true], more: 0 }, '3 dots');
    assertJson(limitDots([true, false, true, false, true]), { shown: [true, false, true], more: 2 }, '5 dots');
    assertJson(limitDots(cellOf(oct, '2026-10-14').dots), { shown: [true, true, true], more: 2 }, 'the 14th\'s dots');
  });

  await check('limitRow (Ruling 3) on three overlapping bars, Alpha 5–7, Beta 6–8 and Gamma 7–9 October: on a 360 px screen the 9th shows Gamma with its title, not "+1" under two empty lines, and a bar drawn out of its lane or after a day that hid it shows its title; wide, the three keep their lanes; over every row of the fixtures, at both widths, no spacer over "+N", no "+N" while the items fit, no item lost and no bar drawn nameless', () => {
    const abg = storeOf([
      respond(answer([famcal('alpha', 'Alpha', '2026-10-05', '2026-10-08'), famcal('beta', 'Beta', '2026-10-06', '2026-10-09'), famcal('gamma', 'Gamma', '2026-10-07', '2026-10-10')], { month: '2026-10' })),
    ]);
    const row = modelOf(abg, '2026-10').weeks.find((w) => w.some((c) => c.day === '2026-10-05'));
    assert(row !== undefined, 'no row for 5 October');
    const view = (r: { shown: MonthSlot[]; more: number }) => `${r.shown.map(show).join(' ')}${r.more ? ` +${r.more}` : ''}`;
    const days = (limited: { shown: MonthSlot[]; more: number }[]) =>
      Object.fromEntries(row.map((c, i) => [c.day.slice(8), view(limited[i])] as const).filter(([d]) => ['05', '06', '07', '08', '09'].includes(d)));
    assertJson(days(limitRow(row, BROWSE_CHIPS_NARROW)), { '05': 'bar:alpha*>', '06': 'bar:alpha<> bar:beta*>', '07': 'bar:alpha< bar:beta<> +1', '08': 'bar:beta*< bar:gamma*<>', '09': 'bar:gamma*<' }, 'narrow');
    assertJson(days(limitRow(row, BROWSE_SLOTS)), { '05': 'bar:alpha*>', '06': 'bar:alpha<> bar:beta*>', '07': 'bar:alpha< bar:beta<> bar:gamma*>', '08': '_ bar:beta< bar:gamma<>', '09': '_ _ bar:gamma<' }, 'wide');
    // A bar hidden behind "+N" one day and back in its own lane the next shows its title there.
    const cellWith = (day: DayKey, slots: MonthSlot[]): MonthCell => ({ day, inMonth: true, today: false, status: 'answered', slots, dots: [], count: 0, fromPartner: 0, hebrewMonthStart: false });
    const mid = (id: string) => ({ ...slot('bar', id), showTitle: false, continuesBefore: true, continuesAfter: true });
    const hidden = limitRow([cellWith('2026-10-05', [slot('bar', 'a'), slot('bar', 'b'), slot('bar', 'c'), slot('timed', 't')]), cellWith('2026-10-06', [slot('spacer', null), slot('spacer', null), mid('c')])], BROWSE_SLOTS);
    assertJson(hidden.map(view), ['bar:a* bar:b* +2', '_ _ bar:c*<>'], 'C, hidden on the 5th, named on the 6th');
    const moved = limitRow([cellWith('2026-10-05', [slot('spacer', null), mid('b'), mid('c'), slot('timed', 't1'), slot('timed', 't2')]), cellWith('2026-10-06', [slot('spacer', null), slot('spacer', null), mid('c')])], BROWSE_SLOTS);
    assertJson(moved.map(view), ['bar:b*<> bar:c*<> +2', '_ _ bar:c*<>'], 'C, moved up on the 5th, back in its lane on the 6th: named again');
    let rows = 0;
    const stores: [CalendarStore, string[]][] = [[STORE_0, AUTUMN], [STORE_1, AUTUMN], [abg, ['2026-10']]];
    for (const [store, months] of stores) {
      for (const m of months) {
        for (const week of modelOf(store, m).weeks) {
          for (const max of [BROWSE_SLOTS, BROWSE_CHIPS_NARROW]) {
            rows++;
            const limited = limitRow(week, max);
            week.forEach((cell, i) => {
              const { shown, more } = limited[i];
              const real = cell.slots.filter((s) => s.kind !== 'spacer');
              const where = `${cell.day} at ${max}`;
              if (more > 0) assert(shown.every((s) => s.kind !== 'spacer') && shown.length === Math.min(max, BROWSE_SLOTS - 1), `${where}: ${shown.map(show).join(' ')} +${more}`);
              assert(more === 0 || real.length > max, `${where}: "+${more}" while its ${real.length} items fit`);
              assert(shown.filter((s) => s.kind !== 'spacer').length + more === real.length, `${where}: an item lost`);
              shown.forEach((s, k) => {
                if (s.kind === 'bar' && !s.showTitle) assert(limited[i - 1]?.shown[k]?.key === s.key, `${where}: ${s.key} has no title, and the day before didn't draw it there`);
              });
            });
          }
        }
      }
    }
    assert(rows >= 30, `only ${rows} rows checked`);
  });

  await check('a month\'s cells: its week rows from the week start, blank outside it (R12), today, and each day\'s status', () => {
    const oct = modelOf(STORE_0, '2026-10');
    assertJson(oct.weeks.map((w) => w.map((c) => c.day)), monthGrid('2026-10', 0), 'the rows');
    for (const c of oct.weeks.flat()) {
      assert(c.inMonth === c.day.startsWith('2026-10-'), `${c.day} inMonth`);
      if (!c.inMonth) assertJson([c.today, c.status, c.slots, c.dots, c.count, c.hebrewMonthStart], [false, 'answered', [], [], 0, false], `${c.day} blank`);
      else assert(c.status === dayStatus(STORE_0, c.day), `${c.day} status`);
    }
    assertJson(oct.weeks.flat().filter((c) => c.today).map((c) => c.day), [TODAY], 'today');
    assert(modelOf(STORE_1, '2026-10').weeks[0][0].day === '2026-09-28', 'week start 1 starts on Monday');
    const first = storeOf(['2026-09', '2026-10'].map((m) => respond(answer(ITEMS, { month: m, today: '2026-10-01' }))));
    const blank = modelOf(first, '2026-09').weeks[4].find((c) => c.day === '2026-10-01');
    assert(blank !== undefined && !blank.inMonth && !blank.today, 'today in another month\'s row is a blank, not today');
    assert(cellOf(modelOf(first, '2026-10'), '2026-10-01').today, 'and today in its own month');
  });

  await check('a month\'s status: loading while any day is, answered once every day is, failed otherwise', () => {
    const week = storeOf([respond(answer(ITEMS, { window: { from: TODAY, to: '2026-10-22' } }))]);
    const loading = modelOf(week, '2026-10');
    assert(loading.status === 'loading', `with the Agenda's week only: ${loading.status}`);
    assert(cellOf(loading, '2026-10-15').status === 'answered' && cellOf(loading, '2026-10-14').status === 'loading', 'the cells');
    assertJson(loading.notices, [], 'no notice while loading');
    assert(modelOf(STORE_0, '2026-10').status === 'answered', 'answered');
    const weekFailed = storeOf([respond(answer([], { window: { from: TODAY, to: '2026-10-22' }, famcal: { status: 'error' } }))]);
    const partly = modelOf(weekFailed, '2026-10');
    assert(partly.status === 'loading', `the week failed, the rest not asked yet: ${partly.status}`);
    assertJson(partly.notices, [{ source: 'famcal', kind: 'failed', failure: { kind: 'error', source: 'famcal', reason: null } }], 'its failure already shows');
    const failed = storeOf([respond(answer(ITEMS, { window: { from: TODAY, to: '2026-10-22' } })), respond(answer([], { month: '2026-10', famcal: { status: 'error' } }))]);
    const model = modelOf(failed, '2026-10');
    assert(model.status === 'failed', `an error on the month after the week's ok: ${model.status}`);
    assert(cellOf(model, '2026-10-15').status === 'answered' && cellOf(model, '2026-10-01').status === 'failed', 'the week keeps its data');
  });

  await check('notices: failed with the earliest failing day\'s reason (not the latest failure), busy, error and calendars gone; FamCal\'s error; reconnect none; partial', () => {
    const gWeek = (window: { from: DayKey; to: DayKey }, g: GoogleStatus) => respond(answer([], { window, google: g }));
    // October: busy from the 1st, calendars gone from the 25th; the latest failure is November's error.
    const mixed = storeOf([
      gWeek({ from: TODAY, to: '2026-10-22' }, { status: 'error', reason: 'transient' }),
      { type: 'windowFailed', from: '2026-10-01', to: '2026-11-01', sources: ['google'], kind: 'busy', epoch: 0 },
      gWeek({ from: '2026-10-25', to: '2026-11-01' }, { status: 'error', reason: 'calendars_gone' }),
      { type: 'windowFailed', from: '2026-11-01', to: '2026-12-01', sources: ['google'], kind: 'error', epoch: 0 },
    ]);
    assert(mixed.lastFailure.google?.kind === 'error', 'the latest failure is November\'s error');
    assertJson(modelOf(mixed, '2026-10').notices, [{ source: 'google', kind: 'failed', failure: { kind: 'busy', source: 'google' } }], 'October (busy from the 1st)');
    assertJson(modelOf(mixed, '2026-11').notices, [{ source: 'google', kind: 'failed', failure: { kind: 'error', source: 'google', reason: null } }], 'November');
    const gone = storeOf([gWeek(windowOf('2026-10'), { status: 'error', reason: 'calendars_gone' })]);
    assertJson(modelOf(gone, '2026-10').notices, [{ source: 'google', kind: 'failed', failure: { kind: 'calendarsGone', source: 'google' } }], 'calendars gone');
    const famcalError = storeOf([respond(answer([], { month: '2026-10', famcal: { status: 'error' } }))]);
    assertJson(modelOf(famcalError, '2026-10').notices, [{ source: 'famcal', kind: 'failed', failure: { kind: 'error', source: 'famcal', reason: null } }], 'FamCal');
    const reconnect = storeOf([gWeek(windowOf('2026-10'), { status: 'reconnect', reason: 'token' })]);
    const rModel = modelOf(reconnect, '2026-10');
    assert(rModel.status === 'failed' && homeNotices(reconnect).reconnect === 'token', 'failed, with the Reconnect banner');
    assertJson(rModel.notices, [], 'no notice for a reconnect');
    const partial = storeOf([respond(answer([google('lunch', 'Lunch', '2026-10-15T12:00:00+03:00', '2026-10-15T13:00:00+03:00')], { month: '2026-10', google: { status: 'ok', partial: { failed: 1, truncated: 0 } } }))]);
    const pModel = modelOf(partial, '2026-10');
    assert(pModel.status === 'answered', `partial is answered: ${pModel.status}`);
    assertJson(pModel.notices, [{ source: 'google', kind: 'partial', failure: null }], 'partial');
    assertJson(cellOf(pModel, '2026-10-15').slots.map((s) => `${s.kind}:${s.title}`), ['timed:Lunch'], 'a Google chip');
    // Two Google events without an id share a key; on consecutive days they are still two one-day chips.
    const noId = storeOf([respond(answer([google('', 'Swim', '2026-10-20T07:00:00+03:00', '2026-10-20T08:00:00+03:00'), google('', 'Swim', '2026-10-21T07:00:00+03:00', '2026-10-21T08:00:00+03:00')], { month: '2026-10', google: { status: 'ok' } }))]);
    assertJson(slotsOf(modelOf(noId, '2026-10'), ['2026-10-20', '2026-10-21']), { '2026-10-20': ['timed:google|family@group.calendar.google.com|*'], '2026-10-21': ['timed:google|family@group.calendar.google.com|*'] }, 'id-less events');
    assertJson(modelOf(STORE_0, '2026-10').notices, [], 'all answered');
  });

  await check('hebrewMonthStart on Hebrew day 1 and on the month\'s first cell: October 2026, and July 2030 (three Hebrew months)', () => {
    const starts = (m: MonthModel) => m.weeks.flat().filter((c) => c.hebrewMonthStart).map((c) => c.day);
    assertJson(starts(modelOf(STORE_0, '2026-10')), ['2026-10-01', '2026-10-12'], 'October 2026 (1 Cheshvan is the 12th)');
    assertJson(starts(modelOf(STORE_0, '2026-11')), ['2026-11-01', '2026-11-11'], 'November 2026 (1 Kislev is the 11th)');
    assertJson(starts(modelOf(STORE_0, '2030-07')), ['2030-07-01', '2030-07-02', '2030-07-31'], 'July 2030 (1 Tamuz and 1 Av)');
  });

  await check('initialMonthUi, pickDay and backToBrowse', () => {
    assertJson(initialMonthUi(null, TODAY), ui('browse', '2026-10'), 'nothing saved');
    assertJson(initialMonthUi('browse', TODAY), ui('browse', '2026-10'), 'browse saved');
    assertJson(initialMonthUi('picked', TODAY), ui('picked', '2026-10', TODAY), 'a restored picked layout opens on today');
    const browse = ui('browse', '2026-10');
    assertJson(pickDay(browse, '2026-11-05'), ui('picked', '2026-11', '2026-11-05'), 'a tap');
    const picked = ui('picked', '2026-11', '2026-11-05');
    assert(pickDay(picked, '2026-11-05') === picked, 'the same day keeps the UI');
    assert(pickDay(picked, '2026-11-31') === picked && pickDay(picked, '') === picked, 'a bad day keeps the UI');
    assertJson(pickDay(picked, '2026-11-09'), ui('picked', '2026-11', '2026-11-09'), 'another day');
    assertJson(backToBrowse(picked), ui('browse', '2026-11'), 'back: the picked month under the bar');
    assert(backToBrowse(browse) === browse, 'back in browse keeps the UI');
  });

  await check('canStep and stepMonth at both ends of the window (2025-10 … 2028-04): the 1st, or today in today\'s month', () => {
    const first = ui('picked', '2025-10', '2025-10-01');
    const last = ui('picked', '2028-04', '2028-04-01');
    assert(!canStep(first, -1, TODAY) && canStep(first, 1, TODAY), 'the first month');
    assert(canStep(last, -1, TODAY) && !canStep(last, 1, TODAY), 'the last month');
    assert(stepMonth(first, -1, TODAY) === first && stepMonth(last, 1, TODAY) === last, 'no step past the ends');
    assertJson(stepMonth(first, 1, TODAY), ui('picked', '2025-11', '2025-11-01'), 'to the 1st');
    assertJson(stepMonth(ui('picked', '2026-09', '2026-09-20'), 1, TODAY), ui('picked', '2026-10', TODAY), 'into today\'s month: today');
    assertJson(stepMonth(ui('picked', '2026-10', TODAY), 1, TODAY), ui('picked', '2026-11', '2026-11-01'), 'out of it: the 1st');
    assertJson(stepMonth(ui('picked', '2027-01', '2027-01-01'), -1, TODAY), ui('picked', '2026-12', '2026-12-01'), 'back across a year');
    assertJson(stepMonth(ui('browse', '2026-10'), 1, TODAY), ui('browse', '2026-11'), 'browse moves the month only');
    assert(!canStep(ui('picked', 'bad', null), 1, TODAY) && !canStep(first, 1, 'bad'), 'a bad month or today');
  });

  await check('pickToday, and clampMonthUi after a day change (forward and back), the picked day kept', () => {
    assertJson(pickToday(ui('picked', '2026-11', '2026-11-05'), TODAY), ui('picked', '2026-10', TODAY), 'the Today pill');
    const onToday = ui('picked', '2026-10', TODAY);
    assert(pickToday(onToday, TODAY) === onToday, 'already on today');
    assertJson(pickToday(ui('browse', '2026-12'), TODAY), ui('browse', '2026-10'), 'the Today button');
    const browseToday = ui('browse', '2026-10');
    assert(pickToday(browseToday, TODAY) === browseToday, 'browse on today\'s month');
    // Midnight to 1 November: the window becomes 2025-11 … 2028-05.
    const NEXT = '2026-11-01';
    assertJson(clampMonthUi(ui('picked', '2025-10', '2025-10-07'), NEXT), ui('picked', '2025-11', '2025-11-01'), 'off the start');
    assertJson(clampMonthUi(ui('browse', '2025-10'), NEXT), ui('browse', '2025-11'), 'browse off the start');
    const yesterday = ui('picked', '2026-10', TODAY);
    assert(clampMonthUi(yesterday, NEXT) === yesterday, 'the picked day stays, though it was today');
    const inside = ui('browse', '2027-03');
    assert(clampMonthUi(inside, NEXT) === inside, 'inside the window');
    assert(canStep(ui('picked', '2028-04', '2028-04-01'), 1, NEXT), 'the window reaches 2028-05');
    // Other facts can move today back: the window becomes 2025-09 … 2028-03.
    assertJson(clampMonthUi(ui('picked', '2028-04', '2028-04-09'), '2026-09-30'), ui('picked', '2028-03', '2028-03-01'), 'off the end');
    assertJson(clampMonthUi(ui('picked', '2026-10', '2026-11-02'), NEXT), ui('picked', '2026-10', '2026-10-01'), 'a picked day outside its month');
    assertJson(clampMonthUi(ui('picked', 'bad', null), NEXT), ui('picked', '2026-11', NEXT), 'a bad month: today');
  });

  await check('wantedMonths (Ruling 7): picked then the next and the previous; browse nearest the month in view first, the later on a tie, its two neighbours always (a web client\'s observer reports only the months on screen); the fallback; in the window only', () => {
    const months = (w: { from: string; to: string }[]) => w.map((x) => `${x.from}..${x.to}`);
    assertJson(months(wantedMonths(ui('picked', '2026-10', TODAY), ['2027-05'], '2027-05', TODAY)), ['2026-10-01..2026-11-01', '2026-11-01..2026-12-01', '2026-09-01..2026-10-01'], 'picked');
    const short = (w: { from: string }[]) => w.map((x) => x.from.slice(0, 7));
    assertJson(short(wantedMonths(ui('picked', '2028-04', '2028-04-01'), [], null, TODAY)), ['2028-04', '2028-03'], 'picked at the last month');
    assertJson(short(wantedMonths(ui('picked', '2025-10', '2025-10-01'), [], null, TODAY)), ['2025-10', '2025-11'], 'picked at the first month');
    const browse = ui('browse', '2026-10');
    assertJson(short(wantedMonths(browse, ['2026-09', '2026-10', '2026-11', '2026-12'], '2026-10', TODAY)), ['2026-10', '2026-11', '2026-09', '2026-12'], 'browse');
    assertJson(short(wantedMonths(browse, ['2027-01', '2027-02'], '2026-12', TODAY)), ['2026-12', '2027-01', '2026-11', '2027-02'], 'the month in view comes first, with its neighbours');
    assertJson(short(wantedMonths(browse, ['2027-03'], '2027-03', TODAY)), ['2027-03', '2027-04', '2027-02'], 'a web client: only the month on screen reported near');
    assertJson(short(wantedMonths(browse, [], null, TODAY)), ['2026-10', '2026-11', '2026-09'], 'no observer yet: ui.month and its neighbours');
    assertJson(short(wantedMonths(browse, [], '2027-06', TODAY)), ['2027-06', '2027-07', '2027-05'], 'no observer: the month in view and its neighbours');
    assertJson(short(wantedMonths(browse, ['2026-12', '2026-11'], null, TODAY)), ['2026-10', '2026-11', '2026-09', '2026-12'], 'near months by distance from ui.month, with it and its neighbours');
    assertJson(short(wantedMonths(ui('browse', '2025-10'), ['2025-09', '2025-10', '2025-11'], '2025-10', TODAY)), ['2025-10', '2025-11'], 'outside the window dropped');
    assertJson(short(wantedMonths(browse, ['2026-11', 'bad', '2026-11'], null, TODAY)), ['2026-10', '2026-11', '2026-09'], 'junk and repeats dropped');
    assertJson(wantedMonths(browse, [], null, 'bad'), [], 'a bad today');
  });

  await check('heights: the constants, the title, the bar and a month\'s block; monthOffsets adds up monthBlockPx; monthsInViewport', () => {
    assertJson([BROWSE_CELL_PX, PICKED_CELL_PX, BROWSE_SLOTS, BROWSE_CHIPS_NARROW, NARROW_MAX_PX, PICKED_DOTS], [92, 48, 3, 2, 360, 3], 'constants');
    assertJson([monthTitlePx(false), monthTitlePx(true), monthBarPx(false), monthBarPx(true)], [42, 58, 72, 76], 'title and bar');
    assertJson([monthBlockPx(4, false), monthBlockPx(5, true), monthBlockPx(6, false), monthBlockPx(0, false)], [410, 518, 594, 42], 'blocks');
    const months = ['2026-08', '2026-09', '2026-10', '2027-02'];
    for (const [ws, hd, rows] of [[0, false, [6, 5, 5, 5]], [1, true, [6, 5, 5, 4]]] as [WeekStart, boolean, number[]][]) {
      const offsets = monthOffsets(months, ws, hd);
      assertJson(months.map((m) => monthGrid(m, ws).length), rows, `rows at week start ${ws}`);
      let top = 0;
      const want = months.map((m) => {
        const at = top;
        top += monthBlockPx(monthGrid(m, ws).length, hd);
        return at;
      });
      assertJson(offsets, want, `offsets at week start ${ws}`);
    }
    const offsets = monthOffsets(months, 0, false);
    assertJson(offsets, [0, 594, 1096, 1598], 'the offsets, in px');
    assertJson(monthsInViewport(offsets, 0, 700), { first: 0, last: 1 }, 'the top');
    assertJson(monthsInViewport(offsets, 593, 1096), { first: 0, last: 1 }, 'just above a title');
    assertJson(monthsInViewport(offsets, 594, 1097), { first: 1, last: 2 }, 'a title at the top');
    assertJson(monthsInViewport(offsets, -100, -50), { first: 0, last: 0 }, 'above the list');
    assertJson(monthsInViewport(offsets, 5000, 6000), { first: 3, last: 3 }, 'below the list');
    assertJson(monthsInViewport([], 0, 100), { first: 0, last: -1 }, 'no months');
  });

  await check('pickedScrollTop (Ruling 6): the top while the day\'s header and first row fit on the screen; else just far enough down to show them, never past the picked layout\'s top; 0 for anything not finite or no screen', () => {
    assert(PICKED_FIRST_ROW_PX === 64, `PICKED_FIRST_ROW_PX is ${PICKED_FIRST_ROW_PX}`);
    assertJson([pickedScrollTop(126, 526, 590), pickedScrollTop(126, 574, 590), pickedScrollTop(250, 698, 590), pickedScrollTop(250, 698, 470), pickedScrollTop(0, 900, 590)], [0, 48, 172, 250, 0], 'it fits; 48 down; 172 down; no further than the layout\'s top; a layout at the page\'s top');
    assertJson([pickedScrollTop(Number.NaN, 500, 590), pickedScrollTop(100, Infinity, 590), pickedScrollTop(100, 800, 0), pickedScrollTop(-20, 800, 590), pickedScrollTop(126.4, 640.2, 590)], [0, 0, 0, 0, 114], 'not finite, no screen, a layout above the page, rounded');
  });

  await check('monthModels: one function per store, one model per month; a new store builds afresh and the old one keeps its own', () => {
    const get = monthModels(STORE_0);
    assert(monthModels(STORE_0) === get, 'the same function for the same store');
    const oct = get('2026-10');
    assert(oct !== null && get('2026-10') === oct, 'the same model');
    assertJson(oct, buildMonth(STORE_0, '2026-10'), 'the memo holds buildMonth\'s model');
    assert(buildMonth(STORE_0, '2026-10') !== oct, 'buildMonth itself builds a new one');
    const next = reduceStore(STORE_0, respond(answer(ITEMS, { month: '2026-12' })));
    assert(next !== STORE_0 && monthModels(next) !== get, 'a new store, a new function');
    assert(monthModels(next)('2026-10') !== oct && get('2026-10') === oct, 'built afresh; the old store keeps its own');
    const none = monthModels(emptyStore());
    assert(none('2026-10') === null && none('2026-10') === null, 'null before facts');
  });

  await check('null before the first answer and for a malformed month', () => {
    assert(buildMonth(emptyStore(), '2026-10') === null, 'no facts');
    assert(buildMonth(STORE_0, '2026-13') === null && buildMonth(STORE_0, '') === null && buildMonth(STORE_0, '2026-1') === null, 'malformed');
  });

  await check('the same models, windows and heights on five device clocks', () => {
    const snapshot = () =>
      JSON.stringify([
        AUTUMN.map((m) => buildMonth(STORE_0, m)),
        buildMonth(STORE_1, '2026-10'),
        wantedMonths(ui('browse', '2026-10'), [], null, TODAY),
        stepMonth(ui('picked', '2026-09', '2026-09-20'), 1, TODAY),
        monthOffsets(AUTUMN, 1, true),
      ]);
    const saved = process.env.TZ;
    try {
      process.env.TZ = 'UTC';
      const reference = snapshot();
      for (const tz of ['Asia/Jerusalem', 'Pacific/Kiritimati', 'America/Santiago', 'America/Los_Angeles']) {
        process.env.TZ = tz;
        assert(snapshot() === reference, `the output differs with the clock in ${tz}`);
      }
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  });

  await check('month.ts is client-safe and pure: it loads only src/lib/calendar-view and @hebcal/hdate, reads no clock, and its 06:00 is daySpanOf\'s', () => {
    const view = path.resolve(__dirname, '..', 'src', 'lib', 'calendar-view');
    const root = path.join(view, 'month.ts');
    const loaded = new Set<string>();
    const walk = (id: string) => {
      for (const child of require.cache[id]?.children ?? []) {
        if (loaded.has(child.id)) continue;
        loaded.add(child.id);
        walk(child.id);
      }
    };
    assert(require.cache[root] !== undefined, `${root} is not in require.cache: the check would be empty`);
    walk(root);
    assert(loaded.has(path.join(view, 'store.ts')) && loaded.has(path.join(view, 'grid.ts')), 'the walk found no calendar-view module: the check would be empty');
    const outside = [...loaded].filter((p) => !p.startsWith(view + path.sep) && !/[\\/]node_modules[\\/]@hebcal[\\/](hdate|locales)[\\/]/.test(p));
    assertJson(outside, [], 'modules outside src/lib/calendar-view and @hebcal/hdate');
    assert(!loaded.has(path.join(view, 'home-client.ts')), 'home-client.ts is loaded: RangeWindow must be a type-only import');
    const code = fs.readFileSync(root, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const banned of [/new Date\(/, /Date\.now/, /\bwindow\./, /\bdocument\./, /localStorage|sessionStorage/, /@hebcal\/core/, /fetch\(/]) {
      assert(!banned.test(code), `month.ts uses ${banned}`);
    }
    assert(code.includes(`const OVERNIGHT_CUTOFF = '${pad(OVERNIGHT_CUTOFF_HOUR)}:00';`), `month.ts's cutoff is not daySpanOf's ${OVERNIGHT_CUTOFF_HOUR}:00`);
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
for tz in UTC Asia/Jerusalem Pacific/Kiritimati; do
  TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-calendar-month.ts; echo "exit $?"
done
```

Expected under each clock (the module doesn't exist yet):

```
Error: Cannot find module '../src/lib/calendar-view/month'
Require stack:
- …/scripts/smoke-calendar-month.ts
…
exit 1
```

- [ ] **Step 3: Create `src/lib/calendar-view/month.ts`**

Create the file with exactly this content:

```ts
// The Month's model (spec §7.4, §5's month windows, Rulings R11 and R12; Plan E
// Rulings 3–7): what the Month draws, worked out from the client store. Pure and
// client-safe: it imports the store, the Agenda's whose and reminder rules, the grid,
// the day format, the Hebrew day-1 test and the RangeWindow type, and nothing else. The
// views (MonthBrowse, MonthPicked) format dates and copy and fit the slots to the
// screen; this file decides each cell's chips and bars, its dots and counts, each
// month's status and notices, the heights the browse lays its months out with, the
// layout's navigation and which months to fetch.
//
// - A month draws its own days; the days of its rows outside it are blank (R12).
// - A cell's slots: the bars first, by lane, then its one-day items (all-day before
//   timed, as compareItems orders them). Whose an item is follows the Agenda's rule
//   (filled for the viewer's, outlined for the partner's); a done reminder is struck through.
// - Daily-repeating reminders are left out of the slots, the dots and the counts
//   (R11, Ruling 5); the picked day's list (dayRows) still has them.
// - A bar is an item drawn across days: an all-day item over its dates, or a timed
//   one that the store lists on the next or the day before. At the month's edges the
//   neighbouring day is another month's, so its span marks decide, with daySpanOf's
//   06:00 rule: last night's tail ending by 06:00 is not listed on the next day, so an
//   overnight 22:00–02:00 item is a one-day chip, on the month's last day too.
// - Lanes are per week row, lane 0 being the top slot. Bars take the lowest free lane in
//   this order: the day the bar starts in the row, all-day before timed, the earlier
//   start, the longer, then key. A day with a bar in lane n and nothing in a lane above
//   it keeps a spacer there, so the bar stays in line across its days. A bar's title
//   shows on the first day it is drawn in each row: where it starts, at day 1 when it
//   continues from the month before, and at each week row's start.
// - A day with more than fits (Ruling 3) first lets its one-day items into the empty
//   lanes above a bar; if that is still too many, the spacers go and the bars move up,
//   each with its title, then "+N". So a cell never shows an empty line over "+N", and a
//   bar that is drawn out of its lane, or after a day that hid it, says what it is
//   (limitRow, per week row).
// - Nothing here throws: a malformed month gives null, and a malformed day leaves the
//   layout as it is.

import { reminderMark, whoseItem, type AgendaRow } from './agenda';
import { allDayLastDay, formatTime, instantDay } from './format';
import {
  MONTHS_AHEAD,
  MONTHS_BACK,
  addMonths,
  monthFirstDay,
  monthGrid,
  monthLastDay,
  monthOf,
  monthWindow,
  type MonthKey,
} from './grid';
import { isHebrewMonthStart } from './hebrew-date';
import type { RangeWindow } from './home-client';
import {
  addDaysToKey,
  dayFailure,
  dayItems,
  dayStatus,
  failedSources,
  isPartialDay,
  type CalendarStore,
  type DayStatus,
  type SourceFailure,
} from './store';
import type { DayKey, ItemDTO, SourceName, WeekStart } from './types';

export type MonthLayout = 'browse' | 'picked';

/** Where the Month is: the layout, its month (browse: the month to bring under the bar), and the picked day. */
export interface MonthUi {
  layout: MonthLayout;
  month: MonthKey;
  /** Set exactly when picked: a day of `month`. */
  selected: DayKey | null;
}

/** A browse cell's height (Ruling 3): the head line, the 13 px Hebrew month line and 3 slots of 18 px. */
export const BROWSE_CELL_PX = 92;
/** A picked cell's height (spec §7.4: 46–48 px). */
export const PICKED_CELL_PX = 48;
/** Slots in a browse cell (Ruling 3). */
export const BROWSE_SLOTS = 3;
/** Chips a browse cell shows at most on a narrow screen (Ruling 3). */
export const BROWSE_CHIPS_NARROW = 2;
/** A narrow screen: this wide or narrower (`(max-width: 360px)`). */
export const NARROW_MAX_PX = 360;
/** Dots a picked cell shows, then "+N". */
export const PICKED_DOTS = 3;
/**
 * The picked day's first row (one of D's ItemRows with its meta line): entering picked
 * keeps it on screen when the screen is tall enough (pickedScrollTop).
 */
export const PICKED_FIRST_ROW_PX = 64;

/** A month title's padding (14 px above, 6 below, as the mockup's month titles). */
const TITLE_PAD_PX = 20;
/** One line of a title: the month name (or the bar's, beside the 44 px Today button). */
const TITLE_LINE_PX = 22;
/** The Hebrew months' line under a title, in smaller muted text. */
const HEBREW_LINE_PX = 16;
/** The sticky bar's row: it holds the 44 px Today button, with 2 px either side. */
const BAR_ROW_PX = 48;
/** The sticky bar's row with the Hebrew line: 22 + 16 px of text, 7 px either side. */
const BAR_ROW_HEBREW_PX = 52;
/** The weekday row under the bar, its bottom border included. */
const WEEKDAY_ROW_PX = 24;

/**
 * A month's title block in browse: the `h2`'s month line and, when on, its Hebrew
 * months' line, each one line with an ellipsis. The view sets this height exactly.
 */
export function monthTitlePx(hebrewDates: boolean): number {
  return TITLE_PAD_PX + TITLE_LINE_PX + (hebrewDates ? HEBREW_LINE_PX : 0);
}

/**
 * The browse's sticky bar with its weekday row. The view sets this height exactly; the
 * titles' scroll-margin-top is this plus the safe areas, which the bar sits under.
 */
export function monthBarPx(hebrewDates: boolean): number {
  return (hebrewDates ? BAR_ROW_HEBREW_PX : BAR_ROW_PX) + WEEKDAY_ROW_PX;
}

/** A month's block in browse: its title and `rows` week rows. */
export function monthBlockPx(rows: number, hebrewDates: boolean): number {
  const whole = Number.isFinite(rows) && rows > 0 ? Math.floor(rows) : 0;
  return monthTitlePx(hebrewDates) + whole * BROWSE_CELL_PX;
}

/** Each month's top, from the top of the list of months: 0, then the blocks above it added up. */
export function monthOffsets(months: readonly MonthKey[], weekStart: WeekStart, hebrewDates: boolean): number[] {
  const out: number[] = [];
  let top = 0;
  for (const month of months) {
    out.push(top);
    top += monthBlockPx(monthGrid(month, weekStart).length, hebrewDates);
  }
  return out;
}

/**
 * The months a band of the list shows, as indexes into `offsets` (both in the list's
 * coordinates): `first` is the month whose block holds `top` (the one under the
 * sticky bar when `top` is the bar's bottom), `last` the last one that starts above
 * `bottom`. Clamped to the list: a band above it gives the first month, below it the
 * last. An empty list gives { first: 0, last: -1 }.
 */
export function monthsInViewport(offsets: readonly number[], top: number, bottom: number): { first: number; last: number } {
  const n = offsets.length;
  if (n === 0) return { first: 0, last: -1 };
  let first = 0;
  while (first + 1 < n && offsets[first + 1] <= top) first++;
  let last = first;
  while (last + 1 < n && offsets[last + 1] < bottom) last++;
  return { first, last };
}

export type SlotKind = 'bar' | 'allDay' | 'timed' | 'spacer';

export interface MonthSlot {
  kind: SlotKind;
  /** The item's key; null for a spacer (it keeps a bar's lane in line). */
  key: string | null;
  /** The item's title (null when it has none); null for a spacer. */
  title: string | null;
  /** One-day items always; a bar on the first day it is drawn in its week row. */
  showTitle: boolean;
  /** Filled (the viewer's) or outlined (the partner's), by whoseItem. */
  mine: boolean;
  /** A done reminder: struck through. */
  done: boolean;
  /** A bar that goes on from the day before / to the day after (flat edges). */
  continuesBefore: boolean;
  continuesAfter: boolean;
}

export interface MonthCell {
  day: DayKey;
  /**
   * false: a day of another month in this month's rows, drawn blank and aria-hidden
   * (R12). A blank cell carries nothing: today false, status 'answered', no slots.
   */
  inMonth: boolean;
  today: boolean;
  status: DayStatus;
  /** Every slot, bars by lane first; the view limits them (limitSlots). Empty on a blank cell. */
  slots: MonthSlot[];
  /** Whether each drawn item is the viewer's, in slot order, spacers left out (picked's dots). */
  dots: boolean[];
  /** Drawn items (Ruling 5: daily reminders not counted), and how many of them aren't the viewer's. */
  count: number;
  fromPartner: number;
  /** Hebrew day 1, or the month's first day: the cells that name the Hebrew month (Ruling 3). */
  hebrewMonthStart: boolean;
}

/** A pill over the grid (Ruling 4). A reconnect never makes one: the Reconnect banner says it. */
export interface MonthNotice {
  source: SourceName;
  kind: 'failed' | 'partial';
  /** failed: the earliest failing day's failure (busy, calendars gone or an error); partial: null. */
  failure: SourceFailure | null;
}

export interface MonthModel {
  month: MonthKey;
  /** The month's week rows from the week start (4–6), seven cells each. */
  weeks: MonthCell[][];
  /** answered once every day of the month is; loading while any day is; failed otherwise. */
  status: DayStatus;
  /** At most one failed and one partial notice per source, FamCal first. */
  notices: MonthNotice[];
  /** The partner's name, for the cells' "N from <partner>". */
  partner: string | null;
}

/**
 * The 06:00 rule's hour as a wall time, as daySpanOf's OVERNIGHT_CUTOFF_HOUR
 * (src/utils/day-events.ts): a tail ending at or before it on the next day belongs to
 * last night. A server module, so it is restated here, and the smoke checks the two agree.
 */
const OVERNIGHT_CUTOFF = '06:00';

const SPACER: MonthSlot = Object.freeze({
  kind: 'spacer',
  key: null,
  title: null,
  showTitle: false,
  mine: false,
  done: false,
  continuesBefore: false,
  continuesAfter: false,
}) as MonthSlot;

/** An item as one cell draws it: whose and done, and whether it goes on before and after the day. */
interface Drawn {
  item: ItemDTO;
  mine: boolean;
  done: boolean;
  before: boolean;
  after: boolean;
}

/** A bar's days in one week row: from column `first` to `last`, in lane `lane`. */
interface Run {
  key: string;
  item: ItemDTO;
  first: number;
  last: number;
  lane: number;
  cells: Map<number, Drawn>;
}

/** The same occurrence on `day`: its key, and its start (a key alone could repeat if an id is missing). */
function listedOn(store: CalendarStore, item: ItemDTO, day: DayKey): boolean {
  return dayItems(store, day).some((other) => other.key === item.key && other.start === item.start);
}

/**
 * Whether a timed item listed on `day` with an endsLater or spansDay mark is listed on
 * the next day too: it is unless it ends there by 06:00 (daySpanOf's overnight rule).
 */
function goesOnNextDay(item: ItemDTO, day: DayKey, tz: string): boolean {
  if (item.span !== 'endsLater' && item.span !== 'spansDay') return false;
  const next = addDaysToKey(day, 1);
  const endDay = instantDay(item.end, tz);
  if (endDay === null) return false;
  if (endDay !== next) return endDay > next;
  return formatTime(item.end, tz, 'en') > OVERNIGHT_CUTOFF;
}

function drawnOn(store: CalendarStore, day: DayKey, first: DayKey, last: DayKey, tz: string, partner: string | null): Drawn[] {
  const out: Drawn[] = [];
  for (const item of dayItems(store, day)) {
    if (item.repeatsDaily) continue;
    let before: boolean;
    let after: boolean;
    if (item.allDay) {
      before = item.start < day;
      after = allDayLastDay(item) > day;
    } else {
      before = day === first ? item.span === 'continues' || item.span === 'spansDay' : listedOn(store, item, addDaysToKey(day, -1));
      after = day === last ? goesOnNextDay(item, day, tz) : listedOn(store, item, addDaysToKey(day, 1));
    }
    out.push({ item, mine: whoseItem(item, partner).mine, done: reminderMark(item) === 'done', before, after });
  }
  return out;
}

const isBar = (d: Drawn) => d.before || d.after;

function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** An item's start or end to sort by; an all-day 'yyyy-MM-dd' reads as UTC midnight, as compareItems does. */
function sortInstant(value: string): number {
  const t = Date.parse(value);
  return Number.isNaN(t) ? 0 : t;
}

/**
 * The order bars take their lanes in a week row: the day it starts being drawn in the
 * row, then all-day before timed, the earlier start (so a bar that came from an earlier
 * row keeps its place above one that starts on the row's first day), the longer, the key.
 */
function compareRuns(a: Run, b: Run): number {
  if (a.first !== b.first) return a.first - b.first;
  if (a.item.allDay !== b.item.allDay) return a.item.allDay ? -1 : 1;
  const start = sortInstant(a.item.start) - sortInstant(b.item.start);
  if (start !== 0) return start;
  const end = sortInstant(b.item.end) - sortInstant(a.item.end);
  if (end !== 0) return end;
  return compareKeys(a.key, b.key);
}

/** The bars of one week row, each in its lane (the lowest free one, in compareRuns order). */
function rowRuns(cols: readonly (Drawn[] | null)[]): Run[] {
  const runs: Run[] = [];
  const open = new Map<string, Run>();
  cols.forEach((drawn, col) => {
    for (const d of drawn ?? []) {
      if (!isBar(d)) continue;
      const run = open.get(d.item.key);
      if (run && run.last === col - 1) {
        run.last = col;
        run.cells.set(col, d);
      } else {
        const fresh: Run = { key: d.item.key, item: d.item, first: col, last: col, lane: 0, cells: new Map([[col, d]]) };
        runs.push(fresh);
        open.set(d.item.key, fresh);
      }
    }
  });
  runs.sort(compareRuns);
  const used: boolean[][] = [];
  for (const run of runs) {
    let lane = 0;
    const busy = (l: number) => {
      for (let c = run.first; c <= run.last; c++) if (used[l]?.[c]) return true;
      return false;
    };
    while (busy(lane)) lane++;
    run.lane = lane;
    used[lane] ??= [];
    for (let c = run.first; c <= run.last; c++) used[lane][c] = true;
  }
  return runs;
}

function slotOf(d: Drawn, kind: SlotKind, showTitle: boolean): MonthSlot {
  const bar = kind === 'bar';
  return {
    kind,
    key: d.item.key,
    title: d.item.title,
    showTitle,
    mine: d.mine,
    done: d.done,
    continuesBefore: bar && d.before,
    continuesAfter: bar && d.after,
  };
}

function blankCell(day: DayKey): MonthCell {
  return { day, inMonth: false, today: false, status: 'answered', slots: [], dots: [], count: 0, fromPartner: 0, hebrewMonthStart: false };
}

function buildRow(store: CalendarStore, row: readonly DayKey[], month: MonthKey, first: DayKey, last: DayKey, today: DayKey, tz: string, partner: string | null): MonthCell[] {
  const cols = row.map((day) => (monthOf(day) === month ? drawnOn(store, day, first, last, tz, partner) : null));
  const runs = rowRuns(cols);
  return row.map((day, col) => {
    const drawn = cols[col];
    if (drawn === null) return blankCell(day);
    // Lanes 0 … the day's deepest bar: a spacer where no bar of the day is.
    const lanes: MonthSlot[] = [];
    for (const run of runs) {
      const d = run.cells.get(col);
      if (!d) continue;
      while (lanes.length <= run.lane) lanes.push(SPACER);
      lanes[run.lane] = slotOf(d, 'bar', col === run.first);
    }
    const singles = drawn.filter((d) => !isBar(d)).map((d) => slotOf(d, d.item.allDay ? 'allDay' : 'timed', true));
    const slots = [...lanes, ...singles];
    const dots = slots.filter((s) => s.kind !== 'spacer').map((s) => s.mine);
    return {
      day,
      inMonth: true,
      today: day === today,
      status: dayStatus(store, day),
      slots,
      dots,
      count: dots.length,
      fromPartner: dots.filter((mine) => !mine).length,
      hebrewMonthStart: day === first || isHebrewMonthStart(day),
    };
  });
}

/**
 * The Month for `month` ('yyyy-MM'): its week rows from the week start, every cell's
 * slots, dots and counts, the month's status and its notices. null before the first
 * answer pins the facts, and for a malformed month.
 */
export function buildMonth(store: CalendarStore, month: MonthKey): MonthModel | null {
  const facts = store.facts;
  if (!facts) return null;
  const rows = monthGrid(month, facts.weekStart);
  if (rows.length === 0) return null;
  const first = monthFirstDay(month);
  const last = monthLastDay(month);
  const partner = store.partner?.name ?? null;
  const weeks = rows.map((row) => buildRow(store, row, month, first, last, facts.today, facts.tz, partner));

  const days = weeks.flat().filter((cell) => cell.inMonth);
  const statuses = days.map((cell) => cell.status);
  const status: DayStatus = statuses.every((s) => s === 'answered') ? 'answered' : statuses.includes('loading') ? 'loading' : 'failed';

  const notices: MonthNotice[] = [];
  for (const source of facts.sources) {
    const failedDay = days.find((cell) => failedSources(store, cell.day).includes(source));
    if (failedDay) {
      const failure: SourceFailure = dayFailure(store, failedDay.day, source) ?? store.lastFailure[source] ?? { kind: 'error', source, reason: null };
      if (failure.kind !== 'reconnect') notices.push({ source, kind: 'failed', failure });
    }
    if (source === 'google' && days.some((cell) => isPartialDay(store, cell.day))) notices.push({ source, kind: 'partial', failure: null });
  }
  return { month, weeks, status, notices, partner };
}

const models = new WeakMap<CalendarStore, (month: MonthKey) => MonthModel | null>();

/**
 * buildMonth for one store, memoized: the same store gives the same function, and the
 * function gives the same model for the same month. A new store (any answer) starts
 * afresh, so a model never outlives the store it was built from.
 */
export function monthModels(store: CalendarStore): (month: MonthKey) => MonthModel | null {
  let get = models.get(store);
  if (!get) {
    const cache = new Map<MonthKey, MonthModel | null>();
    get = (month: MonthKey) => {
      if (!cache.has(month)) cache.set(month, buildMonth(store, month));
      return cache.get(month) ?? null;
    };
    models.set(store, get);
  }
  return get;
}

/**
 * The slots a browse cell shows (Ruling 3). Up to `maxChips` (BROWSE_SLOTS, or
 * BROWSE_CHIPS_NARROW on a narrow screen) every slot shows, spacers and all, so each bar
 * stays in its lane. Past it:
 * - the day's one-day items move up into the spacers above its bars (the bars keep their
 *   lanes); if all fits then, all shows;
 * - else the spacers go and the bars move up: a bar that leaves its lane shows its title
 *   (it no longer lines up with its other days); if all fits then, all shows;
 * - else the first min(maxChips, BROWSE_SLOTS - 1) items show, bars first, and "+N" in
 *   the next slot, N being the items left out.
 * So a spacer never shows over "+N", and "+N" never shows while the items would fit.
 * Trailing spacers never show.
 */
export function limitSlots(slots: readonly MonthSlot[], maxChips: number): { shown: MonthSlot[]; more: number } {
  const limit = Number.isFinite(maxChips) ? Math.max(1, Math.min(BROWSE_SLOTS, Math.floor(maxChips))) : BROWSE_SLOTS;
  const items = withoutTrailingSpacers(slots);
  if (items.length <= limit) return { shown: items, more: 0 };
  // The one-day items into the bars' empty lanes.
  const singles = items.filter((s) => s.kind !== 'bar' && s.kind !== 'spacer');
  const packed = withoutTrailingSpacers([
    ...items.filter((s) => s.kind === 'bar' || s.kind === 'spacer').map((s) => (s.kind === 'spacer' && singles.length > 0 ? (singles.shift() as MonthSlot) : s)),
    ...singles,
  ]);
  if (packed.length <= limit) return { shown: packed, more: 0 };
  // No spacers: a bar that moves up shows its title.
  const real: MonthSlot[] = [];
  items.forEach((s, lane) => {
    if (s.kind === 'spacer') return;
    real.push(s.kind === 'bar' && real.length !== lane && !s.showTitle ? { ...s, showTitle: true } : s);
  });
  if (real.length <= limit) return { shown: real, more: 0 };
  const keep = Math.min(limit, BROWSE_SLOTS - 1);
  return { shown: real.slice(0, keep), more: real.length - keep };
}

function withoutTrailingSpacers(slots: readonly MonthSlot[]): MonthSlot[] {
  let end = slots.length;
  while (end > 0 && slots[end - 1].kind === 'spacer') end--;
  return slots.slice(0, end);
}

/**
 * A week row's cells as browse shows them: limitSlots for each in-month cell (a blank
 * one shows nothing), then a bar that the day before did not draw in the same slot (it
 * was hidden behind "+N" there, or drawn in another slot) shows its title, so no bar is
 * drawn nameless.
 */
export function limitRow(cells: readonly MonthCell[], maxChips: number): { shown: MonthSlot[]; more: number }[] {
  const out = cells.map((cell) => (cell.inMonth ? limitSlots(cell.slots, maxChips) : { shown: [], more: 0 }));
  for (let col = 1; col < out.length; col++) {
    const before = out[col - 1].shown;
    out[col].shown = out[col].shown.map((s, i) => (s.kind === 'bar' && !s.showTitle && before[i]?.key !== s.key ? { ...s, showTitle: true } : s));
  }
  return out;
}

/** The dots a picked cell shows: PICKED_DOTS, then "+N" for the rest. */
export function limitDots(dots: readonly boolean[]): { shown: boolean[]; more: number } {
  return { shown: dots.slice(0, PICKED_DOTS), more: Math.max(0, dots.length - PICKED_DOTS) };
}

/**
 * Where entering picked scrolls the page (Ruling 6), in document px: the top (0), so the
 * header, the tabs, the bar, the month and the start of the day's list show together;
 * when the screen is too short for that (a 6-row month under two banners on a 375 × 667
 * phone), just far enough down that the day's header and its first row
 * (PICKED_FIRST_ROW_PX) show, and never past the picked layout's own top, so its bar
 * stays on screen. `layoutTop` and `dayHeadBottom` are where the layout starts and the
 * day's header ends in the document; `viewport` is the screen's height. 0 for anything
 * that isn't a finite number, or no screen.
 */
export function pickedScrollTop(layoutTop: number, dayHeadBottom: number, viewport: number): number {
  if (!Number.isFinite(layoutTop) || !Number.isFinite(dayHeadBottom) || !Number.isFinite(viewport) || viewport <= 0) return 0;
  const short = dayHeadBottom + PICKED_FIRST_ROW_PX - viewport;
  return short <= 0 ? 0 : Math.round(Math.min(short, Math.max(0, layoutTop)));
}

/** A day's rows as the Agenda lists them, daily reminders included: the picked day's list. */
export function dayRows(store: CalendarStore, day: DayKey): AgendaRow[] {
  const partner = store.partner?.name ?? null;
  return dayItems(store, day).map((item) => ({ item, whose: whoseItem(item, partner), mark: reminderMark(item) }));
}

/** The window's first and last months around `today` (spec §7.4), or null for a malformed day. */
function windowOf(today: DayKey): { first: MonthKey; last: MonthKey } | null {
  const month = monthOf(today);
  if (!month) return null;
  return { first: addMonths(month, -MONTHS_BACK), last: addMonths(month, MONTHS_AHEAD) };
}

function inWindow(month: MonthKey, ends: { first: MonthKey; last: MonthKey }): boolean {
  return addMonths(month, 0) !== '' && month >= ends.first && month <= ends.last;
}

/** The day picked selects in `month`: today in today's month, else the 1st. */
function dayToSelect(month: MonthKey, today: DayKey): DayKey {
  return month === monthOf(today) ? today : monthFirstDay(month);
}

/**
 * Where the Month opens (spec §7.4 Memory): browse on today's month, or, when the
 * remembered layout is picked, picked on today.
 */
export function initialMonthUi(saved: MonthLayout | null, today: DayKey): MonthUi {
  const month = monthOf(today);
  return saved === 'picked' && month ? { layout: 'picked', month, selected: today } : { layout: 'browse', month, selected: null };
}

/** A tap on a day: picked, on that day and its month. The same UI back when nothing changes. */
export function pickDay(ui: MonthUi, day: DayKey): MonthUi {
  const month = monthOf(day);
  if (!month) return ui;
  if (ui.layout === 'picked' && ui.selected === day && ui.month === month) return ui;
  return { layout: 'picked', month, selected: day };
}

/** "All months", the BackButton, Android's back: browse, with the picked month under the bar. */
export function backToBrowse(ui: MonthUi): MonthUi {
  return ui.layout === 'browse' && ui.selected === null ? ui : { layout: 'browse', month: ui.month, selected: null };
}

/** Whether a chevron can move one month: false past the window's ends (spec §7.4). */
export function canStep(ui: MonthUi, delta: -1 | 1, today: DayKey): boolean {
  const ends = windowOf(today);
  const next = addMonths(ui.month, delta);
  return ends !== null && next !== '' && inWindow(next, ends);
}

/** A chevron: the month before or after, selecting the 1st, or today in today's month. The same UI at the window's ends. */
export function stepMonth(ui: MonthUi, delta: -1 | 1, today: DayKey): MonthUi {
  if (!canStep(ui, delta, today)) return ui;
  const month = addMonths(ui.month, delta);
  return ui.layout === 'picked' ? { layout: 'picked', month, selected: dayToSelect(month, today) } : { layout: 'browse', month, selected: null };
}

/** The Today pill (picked: today selected) or button (browse: today's month). The same UI when already there. */
export function pickToday(ui: MonthUi, today: DayKey): MonthUi {
  const month = monthOf(today);
  if (!month) return ui;
  if (ui.layout === 'picked') return ui.month === month && ui.selected === today ? ui : { layout: 'picked', month, selected: today };
  return ui.month === month && ui.selected === null ? ui : { layout: 'browse', month, selected: null };
}

/**
 * After today moves (midnight, other facts): the UI kept, but inside the new window.
 * A month past an end moves to that end, and picked then selects its 1st (or today in
 * today's month); a malformed month goes to today's. A picked day stays picked, even
 * when it was today. The same UI when nothing changes.
 */
export function clampMonthUi(ui: MonthUi, today: DayKey): MonthUi {
  const ends = windowOf(today);
  if (!ends) return ui;
  let month = ui.month;
  if (addMonths(month, 0) === '') month = monthOf(today);
  else if (month < ends.first) month = ends.first;
  else if (month > ends.last) month = ends.last;
  if (ui.layout === 'picked') {
    if (month === ui.month && ui.selected !== null && monthOf(ui.selected) === month) return ui;
    return { layout: 'picked', month, selected: dayToSelect(month, today) };
  }
  return month === ui.month && ui.layout === 'browse' && ui.selected === null ? ui : { layout: 'browse', month, selected: null };
}

/** year × 12 + month index of a valid 'yyyy-MM'. */
function monthNumber(month: MonthKey): number {
  return Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;
}

/**
 * The Month windows to fetch now (spec §5, Ruling 7), most wanted first, each once and
 * inside the window, as the loader's getMonths wants them:
 * - picked: the picked month, then the month after it, then the month before;
 * - browse: the month in view (`inView`, or `ui.month` before browse reports one) and
 *   its two neighbours, Ruling 7's fallback, with the months near the viewport (`near`,
 *   from the IntersectionObserver). The neighbours are always in: on Telegram's web
 *   clients the app runs in a cross-origin iframe, where the observer ignores its
 *   rootMargin and reports only the months on screen. Nearest to the month in view
 *   first, and the later month first when two are as near.
 */
export function wantedMonths(ui: MonthUi, near: readonly MonthKey[], inView: MonthKey | null, today: DayKey): RangeWindow[] {
  const ends = windowOf(today);
  if (!ends) return [];
  const valid = (m: MonthKey | null): m is MonthKey => m !== null && inWindow(m, ends);
  const anchor = ui.layout === 'browse' && inView !== null && addMonths(inView, 0) !== '' ? inView : ui.month;
  if (addMonths(anchor, 0) === '') return [];
  let months: MonthKey[];
  if (ui.layout === 'picked') {
    months = [anchor, addMonths(anchor, 1), addMonths(anchor, -1)];
  } else {
    const pool = [anchor, ...near, addMonths(anchor, 1), addMonths(anchor, -1)];
    const at = monthNumber(anchor);
    months = pool
      .filter(valid)
      .map((m) => ({ m, d: monthNumber(m) - at }))
      .sort((a, b) => Math.abs(a.d) - Math.abs(b.d) || b.d - a.d)
      .map((x) => x.m);
  }
  const out: RangeWindow[] = [];
  const seen = new Set<MonthKey>();
  for (const m of months) {
    if (!valid(m) || seen.has(m)) continue;
    seen.add(m);
    out.push(monthWindow(m));
  }
  return out;
}
```

- [ ] **Step 4: Run the smoke under the three clocks**

```bash
for tz in UTC Asia/Jerusalem Pacific/Kiritimati; do
  TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-calendar-month.ts; echo "exit $?"
done
```

Expected under each clock:

```
OK  whose and done: the viewer's chips filled, the partner's outlined (whoseItem), a done reminder struck through; dots and counts follow
OK  the Eilat trip (25–29 October): one bar along its week row at week start 0, its title on the 25th only; Grandma's visit in lane 1
OK  the Eilat trip across two week rows at week start 1: the title again at the second row's start
OK  lanes per week row: the same start goes by length, then key; an earlier start keeps its lane above a longer bar from the row's first day
OK  a bar continuing from the previous month into day 1: the all-day Sukkot trip and the timed night shift, with September's side
OK  a Mon–Wed timed conference is one bar; Tuesday–Thursday's hackathon takes lane 1, with a spacer in lane 0 on Thursday
OK  an overnight 22:00–02:00 item is a one-day chip, inside the month and on its last day; a sleepover until 10:00 is a bar
OK  at the month's edges the span marks agree with the next month's own answer (Israel, and New York's DST end on 1 November)
OK  a month reads only its own days: October's model is the same with September and November loaded or not; inside it, the store decides
OK  daily reminders are left out of the slots, the dots and the counts (R11, Ruling 5) but are in dayRows; a weekly one is drawn
OK  limitSlots (Ruling 3): 3 → 3; 4 → 2 + "+2"; narrow 3 → 2 + "+1"; spacers never counted; past the limit the one-day items fill a bar's empty lanes, then the bars move up with their titles, so no spacer shows over "+N"; limitDots: 3, then "+N"
OK  limitRow (Ruling 3) on three overlapping bars, Alpha 5–7, Beta 6–8 and Gamma 7–9 October: on a 360 px screen the 9th shows Gamma with its title, not "+1" under two empty lines, and a bar drawn out of its lane or after a day that hid it shows its title; wide, the three keep their lanes; over every row of the fixtures, at both widths, no spacer over "+N", no "+N" while the items fit, no item lost and no bar drawn nameless
OK  a month's cells: its week rows from the week start, blank outside it (R12), today, and each day's status
OK  a month's status: loading while any day is, answered once every day is, failed otherwise
OK  notices: failed with the earliest failing day's reason (not the latest failure), busy, error and calendars gone; FamCal's error; reconnect none; partial
OK  hebrewMonthStart on Hebrew day 1 and on the month's first cell: October 2026, and July 2030 (three Hebrew months)
OK  initialMonthUi, pickDay and backToBrowse
OK  canStep and stepMonth at both ends of the window (2025-10 … 2028-04): the 1st, or today in today's month
OK  pickToday, and clampMonthUi after a day change (forward and back), the picked day kept
OK  wantedMonths (Ruling 7): picked then the next and the previous; browse nearest the month in view first, the later on a tie, its two neighbours always (a web client's observer reports only the months on screen); the fallback; in the window only
OK  heights: the constants, the title, the bar and a month's block; monthOffsets adds up monthBlockPx; monthsInViewport
OK  pickedScrollTop (Ruling 6): the top while the day's header and first row fit on the screen; else just far enough down to show them, never past the picked layout's top; 0 for anything not finite or no screen
OK  monthModels: one function per store, one model per month; a new store builds afresh and the old one keeps its own
OK  null before the first answer and for a malformed month
OK  the same models, windows and heights on five device clocks
OK  month.ts is client-safe and pure: it loads only src/lib/calendar-view and @hebcal/hdate, reads no clock, and its 06:00 is daySpanOf's

26/26 passed (process TZ=UTC)
exit 0
```

The process zone in the summary line follows the clock: `Asia/Jerusalem`, `Pacific/Kiritimati`. (Node may print its `module.register()` deprecation warning first; it is tsx's, not the smoke's.)

- [ ] **Step 5: Run the regression smokes**

```bash
for s in smoke-calendar-agenda smoke-calendar-loader smoke-calendar-grid smoke-hebrew-date smoke-calendar-dto smoke-initdata-header smoke-auth-leftovers smoke-calendar-home-render; do
  for tz in UTC Asia/Jerusalem; do
    out=$(TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/$s.ts 2>&1); code=$?
    echo "$s $tz: $(echo "$out" | tail -1) exit $code"
  done
done
TZ=UTC DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/check-i18n-parity.ts > /dev/null; echo "parity exit $?"
```

Expected, the same as before this task (shown for UTC; Asia/Jerusalem gives the same counts, with its own zone in the agenda, loader, grid, hebrew-date, dto and render lines):

```
smoke-calendar-agenda UTC: 37/37 passed (process TZ=UTC) exit 0
smoke-calendar-loader UTC: 12/12 passed (process TZ=UTC) exit 0
smoke-calendar-grid UTC: 11/11 passed (process TZ=UTC) exit 0
smoke-hebrew-date UTC: 22/22 passed (process TZ=UTC) exit 0
smoke-calendar-dto UTC: 23/23 passed (process TZ=UTC) exit 0
smoke-initdata-header UTC: 9/9 passed exit 0
smoke-auth-leftovers UTC: 9/9 passed exit 0
smoke-calendar-home-render UTC: 42/42 passed (process TZ=UTC) exit 0
parity exit 0
```

Each smoke's own lines are the same as before this task: no existing file changes, and the scans in `smoke-initdata-header` and `smoke-auth-leftovers` find nothing in the two new files.

- [ ] **Step 6: Type-check and lint**

```bash
npx tsc --noEmit; echo "tsc exit $?"
npx eslint src/lib/calendar-view/month.ts scripts/smoke-calendar-month.ts; echo "eslint exit $?"
```

Expected: no output from either tool, then `tsc exit 0` and `eslint exit 0`.

- [ ] **Step 7: Commit**

```bash
git add src/lib/calendar-view/month.ts scripts/smoke-calendar-month.ts
git commit -F - <<'EOF'
feat(calendar-home): the Month's model

month.ts works out what the Month draws from the client store, pure and
client-safe. Each month draws its own days, blank outside them (R12). A
cell's slots are its bars first, by lane, then its one-day items; whose an
item is follows the Agenda's rule, and a done reminder is struck through.
Daily-repeating reminders stay out of the slots, the dots and the counts
(R11) and stay in the picked day's rows. A bar is an all-day item over its
dates, or a timed one the store lists on the day before or after; at the
month's edges its span marks decide, with daySpanOf's 06:00 rule, so an
overnight 22:00-02:00 item is a one-day chip on the month's last day too,
and a month never changes when its neighbours load. Lanes are per week
row, with spacers that keep a bar in line, and a bar's title shows on the
first day it is drawn in each row. A month is answered, loading or failed,
and its notices carry the earliest failing day's reason, never a
reconnect. Also: "+N" past 3 slots (2 on a narrow screen), with a day
that overflows filling a bar's empty lanes first, then moving its bars up
with their titles, so no cell shows an empty line over "+N" (limitRow);
the block heights the browse lays out with; the layout's navigation over
the window of 12 months back to 18 ahead; the months to fetch, most wanted
first, the month in view's neighbours always; and where entering picked
scrolls on a short screen (pickedScrollTop). Nothing renders it yet.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
EOF
```

---

### Task 6 (E6): Month browse (spec §7.4 Browse, §5's month windows, §7.7, §7.8; Rulings R11 and R12; Plan E Rulings 3, 4, 6, 7 and 8)

> **INTERFACE NOTE VERSUS THE SPLIT (read this first; E8 builds on it).** `MonthBrowseProps` and `MonthBrowse` are the split's, verbatim. **One addition: `export const MONTH_BROWSE_CSS: string`**, the view's style sheet. `MonthBrowse` renders it itself, as AgendaView does with `AGENDA_CSS` and E4's HomeTabs with `TABS_CSS`, and the smoke reads it. The split and the brief left these points open; they are now binding:
> 1. **The cell's second line is the Hebrew month's short name alone**, from E2's `hebrewCellMonth`, aligned to the end under the Hebrew day number. That number stays at the head line's end on every cell. The brief says "the label with the month"; this task reads that through Ruling 3 ("the Hebrew month name") and E2's note, because `hebrewCellLabel(…, true)` ("1 Chesh.") would print the number twice. Russian's short list is in the genitive ("швата"), which reads under the number the way Russian calendars stack "1 / швата".
> 2. **The month in view** is read half a week row (`BROWSE_CELL_PX / 2`) below the bar's bottom: `monthsInViewport(offsets, barBottom + 46, viewportBottom).first`. At the opening position (with peek), the bar's bottom is inside the month before. Read there, the bar would name September, and E8's `wantedMonths`, which centres on the month in view, would fetch September first.
> 3. **The Today button** puts today's month's title just under the bar, with no peek. It scrolls smoothly, or instantly under `prefers-reduced-motion`, which is read with `matchMedia` at the tap. For the button, "on screen" means the band from the bar's bottom to the viewport's bottom.
> 4. **Drawn months**:
>    - The months that draw their grids are the observer's near months plus the month in view and its two neighbours, so the screen's months always draw, even before the observer reports.
>    - `onNearMonths` gets only the observer's list, oldest first. It fires at most once a frame, and only when the list changes. Without an observer, the scroll measure reports the month in view and its neighbours.
>    - `onMonthInView` fires on the first frame after mount, then whenever the month changes.
>    - The `rootMargin` is `'100% 0px'`.
> 5. **Re-anchoring** also runs when `hebrewDates` changes, since that changes the titles' height (`store.facts.hebrewDates` follows the latest answer). It keeps the month in view at the same distance under the bar with one instant scroll. When no offset above that month moved, it doesn't scroll.
> 6. **`start` is read on mount only**, and MonthBrowse measures the layout when it mounts. So:
>    - E8 mounts it only while the browse is shown, because a hidden panel measures zeros;
>    - E8 remounts it to apply a new start (back from picked, a tab switch);
>    - E8 memoizes `months` (`useMemo(() => monthSpan(today), [today])`).
> 7. **A model built under another week start** (its first cell isn't `monthGrid(month, weekStart)[0][0]`) draws as loading. So during a facts change, a month's rows never disagree with its block height.
> 8. **The cell label** is these parts, joined with ", " (E1's note):
>    - the date (`formatDayLong`);
>    - the Hebrew day (`hebrewDayLabel`, with the genitive list in Russian);
>    - when the day has items, `cellItems`, then `cellFromPartner` only when there is a partner name;
>    - then `cellLoading` or `cellFailed`, or `cellNothing` for an answered empty day.
> 9. **Notices**:
>    - busy → `state.busy` with Retry;
>    - calendars gone → `state.calendarsGone` with Choose again;
>    - any other failure → `month.failed` with Retry;
>    - partial → `state.partial` with Retry (`onRetryMonth(month, 'google')`).
>
>    Failed pills sit centred in an overlay over the month's body, and a partial pill at its top. Only the pill takes taps.
> 10. **No Telegram call, no new copy.** MonthBrowse uses E1's `month.*` keys and D's `actions.retry` / `chooseAgain`, `state.busy` / `calendarsGone` / `partial`, `row.noTitle` and `hebrewMonthGenitive`. The swipe lock and the BackButton stay with E8. Each month is a plain `div` with its `h2`: a named `section` would add 31 landmarks, and an unnamed one adds nothing.
> 11. **What sticks above the bar** (review patch; E8 sets it). The bar's `top` and the titles' `scroll-margin-top` add `var(--ch-top-h, 0px)`, the height of whatever sticks above browse: E8's header and tab bar, which it keeps on screen in browse as the approved MonthFlow does, and whose height it puts on `.ch-home`. Without it the value is 0px and nothing changes. Every scroll the view makes already reads the margin from `getComputedStyle` and the bar from its rect, so the opening position, Today and the month in view follow with no other change (#24).
> 12. **Re-anchoring when the list moves** (review patch). Each render's layout effect also compares the list's top in the document with the last one. When content above the Month changed height (E8's Reconnect banner or unavailable row coming or going, the header's "Times in" line after a store drop), the same re-anchor puts the month in view back under the bar with one instant scroll. At the page's top the bar sits on the list, so the computed scroll is 0: a row above shows where it comes (#23).
> 13. **`limitRow`** (E5, review patch) fits each week row: a cell gets its `shown` and `more` from its row, so a bar a narrow cell hid, or moved up, is named on the next day it is drawn (#25).
> 14. **The titles are worked out once** per window, week start, language and Hebrew line (`useMemo`), not on every report of the month in view or the near months: 31 `monthGrid`s, titles and Hebrew ranges took about 1 ms a render on an M-series Mac in the review's probe, and a mid-range Android phone is several times slower.

**What and why.** The Month's default layout is browse (spec §7.4): the window's 31 months stacked vertically, iOS style, under a sticky bar. This task writes the view. E5's model already decides each cell's chips, bars, counts and status, and each month's notices and heights. The view formats and lays them out:
- **The sticky bar** sits under the safe areas and anything that sticks above it (E8's header and tab bar, `--ch-top-h`). From the top:
  - the month in view with its year (Ruling 8);
  - its Hebrew months when they're on (§7.8);
  - a Today button while no part of today's month is on screen (Ruling 6);
  - the weekday row in week-start order.
- **The months.** Each month renders at its known height (`monthBlockPx`), with an `h2` that stops just under the bar. iOS's WKWebView has no scroll anchoring, so nothing above the viewport may ever change height. The months near the viewport draw their grids; the rest are their title and an empty box of the same height. The notices are overlays (Ruling 4).
- **The cells** (Ruling 3, R11):
  - the Gregorian day, with the Hebrew day at the head line's end;
  - the Hebrew month's short name on Hebrew day 1 and on the month's first cell;
  - three slots of one-line chips and bars, or two and "+N" (two at most on a 360 px screen), as E5's `limitRow` fits the week row;
  - a placeholder while a day loads, and dimmed when it failed, so a day never looks free before it is answered (§5).
- **Accessibility** (§7.7): one button per day, with a label that reads the whole cell. `aria-current="date"` marks today. The chips, the blank cells and the weekday row are hidden from assistive tech.
- **Scrolling**:
  - the opening position: the start month's title under the bar, with half a week row of the month before above it;
  - the month in view, from a passive scroll listener that measures at most once a frame;
  - the months near the screen, from one IntersectionObserver (Ruling 7);
  - a re-anchor when the window's first month, the week start or the Hebrew line changes, or when content above the list changes height while it is scrolled (review patch).

Nothing renders MonthBrowse yet: E8 does. No user sees a change, and the switch is unchanged.

**Files** (the state this task starts from: 0064e8f with E1–E5 applied, in task order):
- Prerequisite: E1's `calendarHome.month.*` and `hebrewMonthShort`, E2's `grid.ts` and its `hebrew-date.ts` and `format.ts` additions, E4's tokens in `home-theme.ts`, and E5's `month.ts` are in. E6 reads nothing from E3 directly (E5 does), and nothing from E7 (same wave).
- Create: `app/[locale]/dashboard/MonthBrowse.tsx`
- Create (test): `scripts/smoke-calendar-month-browse.ts`
- Modify: none. No existing file changes.
- Test: `scripts/smoke-calendar-month-browse.ts` under `TZ=UTC` and `TZ=Asia/Jerusalem`. It buckets no days, but it passes under `TZ=Pacific/Kiritimati` too.
- Regression (unchanged), under `TZ=UTC` and `TZ=Asia/Jerusalem`:
  - the modules MonthBrowse reads: `smoke-calendar-month` (26), `smoke-calendar-grid` (11), `smoke-hebrew-date` (22) and `smoke-calendar-home-tabs` (11, E4's tokens);
  - `smoke-calendar-home-render` (42);
  - the smokes that scan `app/`, `src/` and `scripts/`: `smoke-initdata-header` (9), `smoke-auth-leftovers` (9) and `smoke-auth-identity` (26);
  - `check-i18n-parity`.

**Interfaces:**
- Consumes (line numbers as of the starting state):
  - from E5, `src/lib/calendar-view/month.ts`:
    - the constants `BROWSE_CELL_PX` (`:74`, 92), `BROWSE_SLOTS` (`:78`, 3), `BROWSE_CHIPS_NARROW` (`:80`, 2) and `NARROW_MAX_PX` (`:82`, 360);
    - `monthTitlePx(hebrewDates): number` (`:108`, 42 / 58) and `monthBarPx(hebrewDates): number` (`:116`, 72 / 76);
    - `monthBlockPx(rows, hebrewDates): number` (`:121`) and `monthOffsets(months, weekStart, hebrewDates): number[]` (`:127`);
    - `monthsInViewport(offsets, top, bottom): { first; last }` (`:144`) and `limitRow(cells, maxChips): { shown; more }[]` (`:494`, review patch; in place of `limitSlots` per cell);
    - the types `MonthSlot` (`:156`), `MonthCell` (`:173`), `MonthNotice` (`:194`) and `MonthModel` (`:201`);
    - in the smoke only, `monthModels(store)` (`:434`).
  - from E2, `src/lib/calendar-view/grid.ts`: `type MonthKey` (`:17`), `monthOf` (`:82`), `monthFirstDay` (`:93`), `monthGrid(month, weekStart): DayKey[][]` (`:113`) and `weekdayOrder(weekStart): WeekStart[]` (`:134`). In the smoke also `monthSpan(today)` (`:122`).
  - from E2 and D2, `src/lib/calendar-view/hebrew-date.ts`:
    - `hebrewDayLabel(dayKey, lang, genitive?)` (`:108`) and `hebrewMonthHeader(month, lang)` (`:145`);
    - `isHebrewMonthStart(dayKey)` (`:151`);
    - `hebrewCellLabel(dayKey, lang, withMonth, shortMonths?)` (`:171`, here with `withMonth` false) and `hebrewCellMonth(dayKey, lang, shortMonths?)` (`:185`).
  - from E2 and D5, `src/lib/calendar-view/format.ts`: `formatDayLong(day, locale)` (`:106`), `formatMonthTitle(month, locale, withYear)` (`:204`) and `formatWeekdayHeader(weekday, locale)` (`:217`).
  - from E4, `app/[locale]/dashboard/home-theme.ts` (`:75-97` light, `:126-148` dark):
    - the chip tokens: `--ch-mine-soft`, `--ch-mine-soft-text`, `--ch-mine-solid`, `--ch-mine-solid-text`, `--ch-partner-soft`, `--ch-partner-soft-text`, `--ch-partner-line` and `--ch-partner-line-text`;
    - the other Month tokens: `--ch-today`, `--ch-today-text`, `--ch-pill-bg`, `--ch-pill-line`, `--ch-pill-text` and `--ch-month-title`;
    - D's `--ch-bg`, `--ch-text`, `--ch-muted`, `--ch-accent`, `--ch-surface`, `--ch-section`, `--ch-separator` and `--ch-outline`;
    - D's `.ch-btn` (`:198`, 44 × 44) and `.ch-visually-hidden` (`:187`).
  - from E1 and D1, `messages/{en,he,ru}.json` `calendarHome`:
    - `month.today`, `month.more {count}`, `month.cellItems {count}`, `month.cellFromPartner {count} {name}`, `month.cellNothing`, `month.cellLoading`, `month.cellFailed` and `month.failed`;
    - `hebrewMonthShort` and `hebrewMonthGenitive`, read with `t.raw`;
    - `state.busy`, `state.calendarsGone` and `state.partial`, `actions.retry` and `actions.chooseAgain`, and `row.noTitle`.
  - from B3, `src/lib/calendar-view/types.ts`: `DayKey`, `SourceName`, `WeekStart`. In the smoke also `compareItems` and the DTO types.
  - in the smoke only, D3's `src/lib/calendar-view/store.ts`: `emptyStore`, `reduceStore`, `daysInWindow`, and the types `CalendarStore`, `GoogleStatus` and `StoreAction`.
  - `next-intl` 4.6.1: `useTranslations`, `useLocale`; React 19.2: `memo`, `useCallback`, `useEffect`, `useLayoutEffect`, `useMemo`, `useRef`, `useState`, `useSyncExternalStore`.
- Produces, `app/[locale]/dashboard/MonthBrowse.tsx` (`'use client'`):
  - `export interface MonthBrowseProps { months: readonly MonthKey[]; today: DayKey; weekStart: WeekStart; hebrewDates: boolean; getMonth: (month: MonthKey) => MonthModel | null; start: { month: MonthKey; peek: boolean }; onNearMonths: (months: MonthKey[]) => void; onMonthInView: (month: MonthKey) => void; onPickDay: (day: DayKey) => void; onRetryMonth: (month: MonthKey, source: SourceName) => void; onChooseCalendars: () => void }`, exactly the split's
  - `export function MonthBrowse(props: MonthBrowseProps): JSX.Element`: a `<section class="ch-mb">` with its own `<style>`, `dir` from the locale, and `--ch-mb-bar`, `--ch-mb-title` and `--ch-mb-cell` set from month.ts; it reads `--ch-top-h` (0px without it) from an ancestor
  - `export const MONTH_BROWSE_CSS: string` (the addition)
- **How E8 renders it** (inside CalendarHome's `.ch-home` root, which carries HOME_THEME_CSS and HOME_SHELL_CSS; only while the Month tab shows browse):
  ```
  const months = useMemo(() => monthSpan(today), [today]);   // today = store.facts.today
  const getMonth = useMemo(() => monthModels(store), [store]);
  <MonthBrowse
    months={months} today={facts.today} weekStart={facts.weekStart} hebrewDates={facts.hebrewDates}
    getMonth={getMonth}
    start={start}                                   // { month: monthOf(today), peek: true } on the first open; { month: ui.month, peek: false } after back or a tab switch
    onNearMonths={setNear} onMonthInView={setInView} // wantedMonths(ui, near, inView, today) → the loader's getMonths
    onPickDay={(day) => setMonthUi((ui) => pickDay(ui, day))}
    onRetryMonth={(month, source) => loader.retryWindow(monthWindow(month), source)}
    onChooseCalendars={chooseCalendars}
  />
  ```
  E8 owns the swipe lock (`useTelegramVerticalSwipes(tab === 'month' && layout === 'browse' && panel shown)`, Ruling 9) and the unavailable-calendars row above the Month (Ruling 4), and (review patch) sticks its header and tab bar above browse with their height on `.ch-home` as `--ch-top-h`.

**Findings that shaped the code** (line numbers as of the starting state):
- **No scroll anchoring on iOS.** WKWebView doesn't adjust the scroll position when content above the viewport changes height, so every month always renders at `monthBlockPx(rows, hebrewDates)`, near or far. Overlays never add height (Ruling 4), and a model whose rows don't fit the block draws as loading.
  - When the offsets do move (the window's first month at a month's turn, a new week start, the Hebrew line), the view puts the month in view back by hand.
  - The smoke's week-start case uses 0 → 6, because the twelve months above November 2026 have 62 rows at both week start 0 and 1, so 0 → 1 moves nothing there.
- **One scroll formula for every jump.** A title's `scroll-margin-top` is the safe areas plus what sticks above the bar plus the bar (`calc(var(--tg-safe-area-inset-top, 0px) + var(--tg-content-safe-area-inset-top, 0px) + var(--ch-top-h, 0px) + var(--ch-mb-bar))`), as spec §7.4 asks. `getComputedStyle(title).scrollMarginTop` resolves it to px, so the opening position, the Today button and both safe areas share one target: `scrollY + title.top − margin − peek`.
  - It is one `window.scrollTo({ top, behavior })`. A peek can't ride on `scrollIntoView`, and two smooth scrolls would cut each other off.
  - Without a readable margin, the bar's own height stands in.
  - `'instant'` is in TS 5.9's `ScrollBehavior`. A WebView that rejects the options dictionary gets `scrollTo(0, y)` in the catch.
- **The month in view and the peek.** E5's `monthsInViewport(offsets, top, bottom).first` is the month whose block holds `top`. With the opening peek, the bar's bottom is 46 px inside September. So the view reads 46 px lower (interface note 2). Restoring with `peek: false` reads the same month either way.
- **Document-level scroll** (spec §7.1). The view measures with `getBoundingClientRect` on the list and the bar: the bar's bottom minus the list's top is the band's top in the list's coordinates, and `innerHeight` minus the list's top is its bottom. When the bar isn't stuck, at the page's top, its bottom is the list's top, so the first month is in view.
- **React Compiler lint rules.** `eslint-config-next` 16 turns on `eslint-plugin-react-hooks` 7's `refs` and `set-state-in-effect` as errors. So:
  - the latest props sit in a ref synced by a layout effect (CalendarHome does the same at `CalendarHome.tsx:140-145`, in a passive effect);
  - the first measure, the only one that sets state after mount, runs on the next frame, never in an effect's body;
  - the opening scroll and the re-anchor run in layout effects, before the first paint and before the browser paints the moved offsets.
- **`matchMedia`.** The narrow-screen flag uses `useSyncExternalStore`, with `false` as the server snapshot. Its subscription falls back to `addListener` for Safari before 14. The reduced-motion flag is read at the tap.
- **The IntersectionObserver.** It observes every month's block, with `rootMargin: '100% 0px'` (one viewport above and below). Its callbacks are gathered on the next frame, and a list equal to the last one isn't sent again.
  - In a cross-origin iframe (Telegram Web), browsers don't apply `rootMargin`, so only the months on screen count. The months drawn still include the month in view and its neighbours, and E5's `wantedMonths` (review patch) fetches the month in view's neighbours whatever `near` says.
  - Without an observer, or when its constructor throws, the scroll measure reports the month in view and its neighbours (Ruling 7).
- **Overflow.**
  - The root clips with `overflow-x: clip`, which doesn't make a scroll container, so the bar stays sticky. Before Safari 16, `clip` is ignored and nothing overflows anyway.
  - `overflow: hidden` appears only on text leaves (chips, "+N", the title and bar lines, the Hebrew month line), for their ellipsis. The bar's only ancestor in the view is the root.
  - `text-overflow` needs a non-visible overflow on the element itself. WebKit before Safari 16 has no `overflow: clip`, so a leaf on `clip` would get no ellipsis there.
- **Bars.** E5 gives `continuesBefore` / `continuesAfter`. The chip then reaches the cell's edge (`margin-inline: -2px`, the cell's 2 px padding), loses its radius and its partner border on that side, and the bar reads as one piece across days. Logical properties flip it in Hebrew.
- **Partner names.** `fromPartner` counts the items that aren't the viewer's. A Google user has no partner name (the store's `partner` comes from FamCal answers), so the label leaves "from" out rather than inventing a name.
- **Israel's clock in the fixtures.** IDT (UTC+3) ends on 25 October 2026, so the smoke's `at()` uses +3 before that day and +2 from it. Only the order of a day's items depends on it.
- **Review patch: content above the list.** The review's banner probe flipped the Reconnect banner, which sits above the panel, on four month answers in a row, and the unavailable row (E8, above browse) on two; E3 now holds both for the epoch, but each still comes once, and a store drop takes the header's "Times in <zone>" line away until the next answer. Each moves the list in the document while the user is months down it, and WKWebView doesn't compensate. A render's layout effect sees the list's new top before the paint (E8's banners and MonthBrowse re-render in the same commit when an answer lands), and the existing re-anchor, run for this too, gives one instant scroll. It needs no guard for the page's top: when the list isn't under the bar, the bar's bottom is the list's top, and the re-anchor computes no scroll.
- **Review patch: what sticks above the bar.** Browse is 6,400 px down at today's month (the review's offsets probe), so E8 keeps its header and tab bar on screen. The view only needs the extra height in two CSS values; the geometry is read from the DOM (#24 runs the opening, the month in view and Today under a 126 px region).
- **D's deferred list (Ruling 10).** E6 takes none of it:
  - it adds no sheet (the focus trap);
  - it adds no copy or plural (the parity parser);
  - it makes no second `useTelegramTheme` call;
  - E3 took the per-window failure reason, the old epoch's flash and the timezone map, and E6 reads their results through E5.
- **Mutations caught** (61, each run alone under UTC and Asia/Jerusalem):
  - the opening: no peek, read with no peek, `'auto'` instead of `'instant'`, and the scroll margin ignored;
  - Today: always smooth, with a peek, shown the wrong way round, and its band not starting at the bar;
  - frames and the observer: an unthrottled measure, uncoalesced reports, `rootMargin` 0, no dedupe of the near months or of the month in view, every month drawn, and no fallback without an observer;
  - heights: a block without its title, a short far box, and no week-start guard;
  - narrow screens: ignored, or the change not heard;
  - labels: no partner, no Hebrew day, "nothing planned" while loading, and no `aria-current`;
  - cells: no placeholder, failed not dimmed, busy read as an error, calendars gone retrying, the partial pill centred, the month line with the number or without the first cell, partner chips filled, done not struck, the continuation classes swapped, a bar's title on every day, and `moreShort`;
  - titles: the year always, or never in the bar;
  - re-anchoring: off, ignoring the distance, or on the first month only;
  - listeners: not passive, and the resize listener, the frame or the observer kept after unmount;
  - no `dir="rtl"`, the weekday row always from Sunday, and an import of `telegram-ui`;
  - the CSS: `overflow: hidden` on the bar or the root, `top: 0`, 10 px text, `margin-left`, a 36 px Today button, no reduced-motion rule, a scroll margin without the safe areas, an 8 px title padding, a hover rule, the partner's timed chip without its line, an unknown token, and a `transform`;
  - review patch (`erev/mut/m-e6.py`, under UTC): the list's moves ignored, a smooth re-anchor, `limitSlots` per cell in place of `limitRow`, and the bar's top or the titles' margin without `--ch-top-h`, each caught; the titles' memo without the language and the year in its keys is not (they change only with `months` in the app).
- **Verified** on a scratch copy of 0064e8f with E1–E5 applied by `dapply.py` in task order:
  - Before: the new smoke exits 1 with `Cannot find module '../app/[locale]/dashboard/MonthBrowse'` under both clocks.
  - After: 26/26 under UTC and Asia/Jerusalem, with the same lines (and under Pacific/Kiritimati); 23/23 before the review patch, which adds #23-#25 and changes #12's top and scroll margin.
  - `tsc --noEmit` and `eslint .` are clean.
  - The regression smokes print the same lines before and after, apart from pids and timestamps: month 26/26, home-tabs 11/11, grid 11/11, hebrew-date 22/22, render 42/42, initdata-header 9/9, auth-leftovers 9/9 and auth-identity 26/26, each under both clocks. `check-i18n-parity` exits 0.
  - This task text, applied with `dapply.py` to a fresh copy (0064e8f, E1–E5, then E6), gives files byte-identical to the verified ones, and Step 7's commit ran as written.
- **Verified against stand-ins:** none. E6 reads E1, E2, E4 and E5, all from earlier waves and applied as written. It reads nothing from E7, its same-wave sibling.
- **Not verified:**
  - `next build`: nothing imports MonthBrowse until E8, and the controller's fresh-clone build after E8 covers it;
  - Node 22 (the local Node is 26.11.1);
  - E8's wiring;
  - a device. The device check (§10 and the split's list) covers the sticky bar during momentum scroll and the top bounce, the 11 px chips on a 360 px phone, Hebrew bars running right to left, and a fling through 31 months.

- [ ] **Step 1: Write the failing smoke `scripts/smoke-calendar-month-browse.ts`**

Create the file with exactly this content:

```ts
// Smoke test for the Month's browse layout (Plan E, Task E6; spec §7.4 Browse, §5's month
// windows, §7.7, §7.8; Rulings R11 and R12; Plan E Rulings 3, 4, 6, 7 and 8):
// app/[locale]/dashboard/MonthBrowse.tsx.
//
// The months get their data the way the container (E8) will feed them: range answers for
// month windows go through D3's real reducer, and E5's monthModels builds each month.
// MonthBrowse renders in en, he and ru through next-intl with the real messages. It checks:
//  - the markup: the sticky bar (the month in view with its year and Hebrew months, the
//    Today button, the weekday row in week-start order for 0, 1 and 6), Ruling 8's titles
//    with each month's Hebrew range, the cells (Ruling 3's head line and Hebrew month line,
//    the chips coloured by whose, done ones struck, daily reminders left out, bars with
//    their continuation shapes, "+N"), the cell labels ("Thursday, 15 October, 4 Cheshvan,
//    3 items, 1 from Noa"), aria-current and aria-hidden, dir="rtl" in Hebrew;
//  - no free-looking cell while a month loads or failed (§5), and the notices as overlays
//    (Ruling 4): busy, an error, calendars gone, partial, and a reconnect with no pill;
//  - the block sizes: every month at monthBlockPx, near and far alike, for 4-, 5- and
//    6-row months, with and without the Hebrew line;
//  - the CSS: nothing under 11 px, the 44 px Today button, logical properties only, the
//    sticky top under the safe areas, overflow-x: clip on the root and overflow: hidden
//    only on text leaves, no transform or filter, the reduced-motion rule, no hover, and
//    only the theme's tokens;
//  - in real React (react-dom/client with act on a small fake DOM that lays the months out
//    from their rendered block sizes, with a fake IntersectionObserver, a fake scroll, fake
//    frames and a fake matchMedia): the opening scroll calls, with and without the peek;
//    the grids near the start before any observer fires; the near months, coalesced; the
//    month in view as the page scrolls, one measure a frame; the Today button and its
//    smooth or instant scroll; a tap on a day; Retry and Choose again; the narrow screen's
//    chips, three overlapping bars included; the re-anchoring when the window's first
//    month, the week start or the Hebrew line changes, and when the list moves in the page
//    (a row coming above it); a sticky region above the bar (E8's --ch-top-h); the
//    fallback without IntersectionObserver; and the clean-up on unmount;
//  - client-safe imports: no server module, no @hebcal/core, no home-client, no Telegram.
// React must log no warning. No network, no DB, no Redis.
//
// Run with the fake env from the task brief (no dotenv), under two clocks:
//   TZ=UTC npx tsx scripts/smoke-calendar-month-browse.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-calendar-month-browse.ts

// The view first: the import-rule check walks what it loads.
import { MonthBrowse, MONTH_BROWSE_CSS, type MonthBrowseProps } from '../app/[locale]/dashboard/MonthBrowse';
import { HOME_THEME_CSS } from '../app/[locale]/dashboard/home-theme';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import React, { createElement, type ComponentProps, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { BROWSE_CELL_PX, monthBarPx, monthBlockPx, monthModels, monthTitlePx } from '../src/lib/calendar-view/month';
import { monthGrid, monthSpan, type MonthKey } from '../src/lib/calendar-view/grid';
import { daysInWindow, emptyStore, reduceStore, type CalendarStore, type GoogleStatus, type StoreAction } from '../src/lib/calendar-view/store';
import { compareItems, type CalendarDTO, type DayKey, type ItemCalendarDTO, type ItemDTO, type ItemReminderDTO, type RangeResponse, type SourceName, type WeekStart } from '../src/lib/calendar-view/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const ROOT = path.resolve(__dirname, '..');
const nodeRequire = createRequire(__filename);
const LOCALES = ['en', 'he', 'ru'] as const;
type Locale = (typeof LOCALES)[number];

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

const show = (value: unknown) => JSON.stringify(value);
const noop = () => undefined;
const messages: Record<Locale, Row> = {
  en: JSON.parse(fs.readFileSync(path.join(ROOT, 'messages/en.json'), 'utf8')),
  he: JSON.parse(fs.readFileSync(path.join(ROOT, 'messages/he.json'), 'utf8')),
  ru: JSON.parse(fs.readFileSync(path.join(ROOT, 'messages/ru.json'), 'utf8')),
};

// ---- React must not warn ----

const reactWarnings: string[] = [];
for (const level of ['error', 'warn'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    const text = args.map(String).join(' ');
    // Node's own warnings (tsx's module.register() deprecation on Node 26 lands here, at a time that varies) aren't React's.
    if (text.startsWith('(node:')) return original(...args);
    reactWarnings.push(text.slice(0, 300));
  };
}

// ---- Fixtures: an Israeli FamCal user paired with Noa, on Thursday 15 October 2026 ----

const TZ = 'Asia/Jerusalem';
const TODAY: DayKey = '2026-10-15';

/** A wall-clock time in Israel on a day, as UTC ISO (IDT, UTC+3, until 25 October; IST, UTC+2, from then). */
function at(day: DayKey, hhmm: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const [h, min] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, h - (day < '2026-10-25' ? 3 : 2), min)).toISOString();
}

const MY_CAL: ItemCalendarDTO = { id: 'native:cal_me_7f3a', name: 'Family', color: '#039BE5', mine: true, inLegend: true };
const NOA_CAL: ItemCalendarDTO = { id: 'native:cal_noa_91b2', name: 'Noa and the kids', color: '#F4511E', mine: false, ownerName: 'Noa', inLegend: true };
const LEGEND: CalendarDTO[] = [
  { id: 'native:cal_me_7f3a', source: 'famcal', name: 'Family', color: '#039BE5', mine: true },
  { id: 'native:cal_noa_91b2', source: 'famcal', name: 'Noa and the kids', color: '#F4511E', mine: false, ownerName: 'Noa' },
];

function item(id: string, o: Partial<ItemDTO> & { start: string }): ItemDTO {
  return {
    key: `${o.source ?? 'famcal'}|${id}`,
    source: 'famcal',
    readOnly: false,
    id,
    seriesId: null,
    originalStart: o.start,
    kind: 'event',
    title: id,
    end: o.start,
    allDay: false,
    tz: TZ,
    recurring: false,
    repeatsDaily: false,
    span: null,
    calendar: MY_CAL,
    location: null,
    description: null,
    ...o,
  };
}
function rem(o: Partial<ItemReminderDTO> = {}): ItemReminderDTO {
  return { done: false, doneAt: null, snoozedUntil: null, open: false, openSince: null, ownerIsViewer: true, creatorIsViewer: true, ...o };
}
const timed = (id: string, title: string, day: DayKey, from: string, to: string, calendar = MY_CAL) => item(id, { title, start: at(day, from), end: at(day, to), calendar });

const CALL_MOM = item('call-mom', { kind: 'reminder', title: 'Call Mom', start: at('2026-10-06', '20:00'), reminder: rem({ done: true, doneAt: at('2026-10-06', '20:05') }) });
const GYM = timed('gym', 'Gym', '2026-10-14', '07:00', '08:00');
const PLUMBER = item('plumber', { kind: 'reminder', title: 'Call the plumber', start: at('2026-10-14', '11:00'), reminder: rem({ creatorIsViewer: false, creatorName: 'Noa' }) });
const PILATES = timed('pilates', 'Pilates', '2026-10-14', '19:00', '20:00', NOA_CAL);
const VITAMINS = item('vitamins', { kind: 'reminder', title: 'Take vitamins', start: at(TODAY, '08:00'), recurring: true, repeatsDaily: true, reminder: rem({ done: true, doneAt: at(TODAY, '08:10') }) });
const DENTIST = timed('dentist', 'Dentist', TODAY, '09:30', '10:30');
const FORM = item('form', { kind: 'reminder', title: 'Send the school form', start: at(TODAY, '13:00'), reminder: rem({ open: true }) });
const FOOTBALL = timed('football', 'Football practice', TODAY, '17:00', '18:00', NOA_CAL);
const GRANDMA = item('grandma', { title: 'Grandma visits', start: '2026-10-16', end: '2026-10-17', allDay: true, tz: null, calendar: NOA_CAL });
const BIRTHDAY = item('birthday', { title: 'Noa’s birthday', start: '2026-10-20', end: '2026-10-21', allDay: true, tz: null });
const EILAT = item('eilat', { title: 'Eilat trip', start: '2026-10-25', end: '2026-10-30', allDay: true, tz: null });
const SNORKEL = timed('snorkel', 'Snorkeling', '2026-10-26', '10:00', '12:00', NOA_CAL);
const SPA = timed('spa', 'Spa', '2026-10-26', '16:00', '17:30', NOA_CAL);
const PORT = timed('port', 'Dinner at the port', '2026-10-26', '20:00', '21:30');

const OCTOBER: Record<DayKey, ItemDTO[]> = {
  '2026-10-06': [CALL_MOM],
  '2026-10-14': [GYM, PLUMBER, PILATES],
  [TODAY]: [VITAMINS, DENTIST, FORM, FOOTBALL],
  '2026-10-16': [GRANDMA],
  '2026-10-20': [BIRTHDAY],
  '2026-10-25': [EILAT],
  '2026-10-26': [EILAT, SNORKEL, SPA, PORT],
  '2026-10-27': [EILAT],
  '2026-10-28': [EILAT],
  '2026-10-29': [EILAT],
};

/** A month's own days, [1st, 1st of the next month), worked out here rather than with grid.ts. */
function windowOf(month: MonthKey): { from: DayKey; to: DayKey } {
  const [y, m] = month.split('-').map(Number);
  return { from: `${month}-01`, to: new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10) };
}

type AnswerOpts = { weekStart?: WeekStart; hebrewDates?: boolean; google?: GoogleStatus };

/** A range answer for one month window: FamCal ok, or (with `google`) a Google user's answer. */
function answer(month: MonthKey, items: Record<DayKey, ItemDTO[]>, o: AnswerOpts = {}): RangeResponse {
  const { from, to } = windowOf(month);
  return {
    tz: TZ,
    today: TODAY,
    weekStart: o.weekStart ?? 0,
    hebrewDates: o.hebrewDates ?? true,
    from,
    to,
    sources: o.google ? { google: o.google } : { famcal: { status: 'ok' } },
    partner: o.google ? null : { name: 'Noa' },
    calendars: o.google ? [{ id: 'family@group.calendar.google.com', source: 'google', name: 'Family', color: '#7986CB', mine: true }] : LEGEND,
    days: daysInWindow(from, to).map((date) => ({ date, items: [...(items[date] ?? [])].sort(compareItems) })),
  };
}

const ok = (response: RangeResponse): StoreAction => ({ type: 'response', response, epoch: 0 });
const windowFailed = (month: MonthKey, kind: 'busy' | 'error', sources: SourceName[] = ['famcal']): StoreAction => ({ type: 'windowFailed', ...windowOf(month), sources, kind, epoch: 0 });
const storeOf = (actions: StoreAction[]): CalendarStore => actions.reduce(reduceStore, emptyStore());

/** October answered, September not asked yet (loading), November busy (429), December an error (500). */
function famcalStore(o: AnswerOpts = {}): CalendarStore {
  return storeOf([ok(answer('2026-10', OCTOBER, o)), windowFailed('2026-11', 'busy'), windowFailed('2026-12', 'error')]);
}

const DINNER: ItemDTO = item('dinner', {
  source: 'google',
  readOnly: true,
  tz: null,
  title: 'Dinner with the Cohens',
  start: '2026-10-15T19:30:00+03:00',
  end: '2026-10-15T22:00:00+03:00',
  calendar: { id: 'family@group.calendar.google.com', name: 'Family', color: '#7986CB', mine: true, inLegend: true },
  htmlLink: null,
  birthday: false,
});

/** A Google user: October partial, November's calendars gone, December asking for a reconnect. */
function googleStore(): CalendarStore {
  return storeOf([
    ok(answer('2026-10', { [TODAY]: [DINNER] }, { google: { status: 'ok', partial: { failed: 1, truncated: 0 } } })),
    ok(answer('2026-11', {}, { google: { status: 'error', reason: 'calendars_gone' } })),
    ok(answer('2026-12', {}, { google: { status: 'reconnect', reason: 'token' } })),
  ]);
}

// ---- Rendering ----

function inIntl(locale: Locale, el: ReactElement): ReactElement {
  // The provider's props type makes children required; createElement takes them as its third argument.
  const provider = { locale, messages: messages[locale], timeZone: TZ } as ComponentProps<typeof NextIntlClientProvider>;
  return createElement(NextIntlClientProvider, provider, el);
}

/** The home's frame around the view (CalendarHome's root and its tokens), for the static markup. */
function inHome(locale: Locale, el: ReactElement): ReactElement {
  return inIntl(locale, createElement('div', { className: 'ch-home', 'data-theme': 'light' }, createElement('style', null, HOME_THEME_CSS), el));
}

function browseProps(store: CalendarStore, o: Partial<MonthBrowseProps> = {}): MonthBrowseProps {
  const facts = store.facts;
  assert(facts, 'the fixture pinned no facts');
  return {
    months: monthSpan(facts.today),
    today: facts.today,
    weekStart: facts.weekStart,
    hebrewDates: facts.hebrewDates,
    getMonth: monthModels(store),
    start: { month: '2026-10', peek: true },
    onNearMonths: noop,
    onMonthInView: noop,
    onPickDay: noop,
    onRetryMonth: noop,
    onChooseCalendars: noop,
    ...o,
  };
}

const renderBrowse = (locale: Locale, props: MonthBrowseProps) => renderToString(inHome(locale, createElement(MonthBrowse, props)));

/** The markup without the style sheets (their class names would match anything). */
const markup = (html: string) => html.replace(/<style[^>]*>[\s\S]*?<\/style>/g, '');

function decode(text: string): string {
  return text.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** A month's block in the markup: from its opening tag to the next month's. */
function monthHtml(html: string, month: MonthKey): string {
  const open = `<div class="ch-mb-month" data-month="${month}"`;
  const start = html.indexOf(open);
  assert(start >= 0, `no block for ${month}`);
  const next = html.indexOf('<div class="ch-mb-month" data-month="', start + open.length);
  return html.slice(start, next < 0 ? undefined : next);
}

type CellView = { cls: string[]; label: string; today: boolean; inner: string };

/** The day buttons in a piece of markup, in order. */
function cellsOf(html: string): CellView[] {
  return [...html.matchAll(/<button type="button" class="(ch-mb-cell[^"]*)" aria-label="([^"]*)"( aria-current="date")?>([\s\S]*?)<\/button>/g)].map((m) => ({
    cls: m[1].split(' '),
    label: decode(m[2]),
    today: !!m[3],
    inner: m[4],
  }));
}

function cellOf(html: string, labelStart: string): CellView {
  const found = cellsOf(html).filter((c) => c.label.startsWith(labelStart));
  assert(found.length === 1, `one cell labelled ${show(labelStart)}: ${show(cellsOf(html).map((c) => c.label).slice(0, 8))}`);
  return found[0];
}

/** A cell's chips: their classes and their text. */
const chipsOf = (cell: CellView) => [...cell.inner.matchAll(/<span class="(ch-mb-chip[^"]*)" dir="auto">([^<]*)<\/span>/g)].map((m) => ({ cls: m[1], text: decode(m[2]) }));
const headOf = (cell: CellView) => {
  const m = /<span class="ch-mb-head" aria-hidden="true"><span class="ch-mb-day" dir="ltr">(\d+)<\/span>(?:<span class="ch-mb-hday">([^<]*)<\/span>)?<\/span><span class="ch-mb-hmonth" aria-hidden="true">([^<]*)<\/span>/.exec(cell.inner);
  assert(m, `no head line in ${show(cell.inner.slice(0, 300))}`);
  return { day: m[1], hebrewDay: m[2] ?? '', hebrewMonth: m[3] };
};
const moreOf = (cell: CellView) => /<span class="ch-mb-more">([^<]*)<\/span>/.exec(cell.inner)?.[1] ?? null;

function titleOf(html: string, month: MonthKey) {
  const m = /<h2 class="ch-mb-title"><span class="ch-mb-title-month">([^<]*)<\/span>(?:<span class="ch-visually-hidden">, <\/span><span class="ch-mb-title-hebrew">([^<]*)<\/span>)?<\/h2>/.exec(monthHtml(html, month));
  assert(m, `no title for ${month}`);
  return { month: decode(m[1]), hebrew: m[2] === undefined ? null : decode(m[2]) };
}

function barOf(html: string) {
  const m = /<div class="ch-mb-bar"><div class="ch-mb-bar-row"><p class="ch-mb-bar-text" aria-hidden="true"><span class="ch-mb-bar-month">([^<]*)<\/span>(?:<span class="ch-mb-bar-hebrew">([^<]*)<\/span>)?<\/p>(<button type="button" class="ch-mb-today">([^<]*)<\/button>)?<\/div><div class="ch-mb-weekdays" aria-hidden="true">((?:<span class="ch-mb-weekday">[^<]*<\/span>)*)<\/div><\/div>/.exec(html);
  assert(m, `no sticky bar in ${show(markup(html).slice(0, 600))}`);
  return { month: m[1], hebrew: m[2] ?? null, today: m[4] ?? null, weekdays: [...m[5].matchAll(/<span class="ch-mb-weekday">([^<]*)<\/span>/g)].map((w) => w[1]) };
}

/** Each month's block-size in the markup, and its body's. */
function blockSizes(html: string): { month: MonthKey; block: number; body: number; far: boolean }[] {
  return [...html.matchAll(/<div class="ch-mb-month" data-month="(\d{4}-\d{2})" style="block-size:(\d+)px">/g)].map((m) => {
    const body = /<div class="ch-mb-body( ch-mb-far)?" style="block-size:(\d+)px"/.exec(monthHtml(html, m[1]));
    assert(body, `no body for ${m[1]}`);
    return { month: m[1], block: Number(m[2]), body: Number(body[2]), far: !!body[1] };
  });
}

// ---- A small fake DOM for react-dom/client (no jsdom in node_modules), as in smoke-calendar-home-render.ts ----
// It also lays the browse out: the list of months starts LAYOUT.listTop px down the
// document, each month is as tall as its rendered block-size, the sticky bar sticks at
// LAYOUT.safeTop plus LAYOUT.topH (what sticks above it: E8's header and tab bar,
// --ch-top-h; 0 unless a check says so), and each title's scroll-margin-top is those plus
// the bar, as the CSS says (#12 checks the CSS).

const HTML_NS = 'http://www.w3.org/1999/xhtml';
type Listener = { type: string; capture: boolean; fn: (event: Row) => void };

const LAYOUT = { listTop: 300, safeTop: 20, topH: 0, width: 390 };

class FakeNode {
  parentNode: FakeNode | null = null;
  childNodes: FakeNode[] = [];
  listeners: Listener[] = [];
  constructor(
    public nodeType: number,
    public nodeName: string,
  ) {}
  get ownerDocument(): Row {
    return fakeDocument;
  }
  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }
  get lastChild(): FakeNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }
  get nextSibling(): FakeNode | null {
    const siblings = this.parentNode?.childNodes ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
  get parentElement(): FakeNode | null {
    return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
  }
  appendChild(child: FakeNode): FakeNode {
    child.parentNode?.removeChild(child);
    this.childNodes.push(child);
    child.parentNode = this;
    return child;
  }
  insertBefore(child: FakeNode, before: FakeNode | null): FakeNode {
    if (!before) return this.appendChild(child);
    child.parentNode?.removeChild(child);
    this.childNodes.splice(this.childNodes.indexOf(before), 0, child);
    child.parentNode = this;
    return child;
  }
  removeChild(child: FakeNode): FakeNode {
    const i = this.childNodes.indexOf(child);
    if (i >= 0) this.childNodes.splice(i, 1);
    child.parentNode = null;
    return child;
  }
  get textContent(): string {
    return this.childNodes.map((c) => c.textContent).join('');
  }
  set textContent(value: string) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    if (value) this.appendChild(new FakeText(String(value)));
  }
  addEventListener(type: string, fn: (event: Row) => void, options?: boolean | { capture?: boolean }) {
    const capture = typeof options === 'boolean' ? options : !!options?.capture;
    this.listeners.push({ type, capture, fn });
  }
  removeEventListener(type: string, fn: (event: Row) => void) {
    this.listeners = this.listeners.filter((l) => l.type !== type || l.fn !== fn);
  }
}

class FakeText extends FakeNode {
  constructor(public data: string) {
    super(3, '#text');
  }
  get nodeValue(): string {
    return this.data;
  }
  set nodeValue(value: string) {
    this.data = String(value);
  }
  get textContent(): string {
    return this.data;
  }
  set textContent(value: string) {
    this.data = String(value);
  }
}

class FakeElement extends FakeNode {
  tagName: string;
  attributes = new Map<string, string>();
  style: Row = { setProperty(k: string, v: string) { this[k] = v; }, removeProperty(k: string) { delete this[k]; } };
  constructor(
    public localName: string,
    public namespaceURI: string,
  ) {
    super(1, namespaceURI === HTML_NS ? localName.toUpperCase() : localName);
    this.tagName = this.nodeName;
  }
  setAttribute(name: string, value: unknown) {
    this.attributes.set(name, String(value));
  }
  setAttributeNS(_ns: string | null, name: string, value: unknown) {
    this.setAttribute(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  removeAttributeNS(_ns: string | null, name: string) {
    this.attributes.delete(name);
  }
  get className(): string {
    return this.getAttribute('class') ?? '';
  }
  set className(value: string) {
    this.setAttribute('class', value);
  }
  focus() {
    fakeDocument.activeElement = this;
  }
  blur() {
    if (fakeDocument.activeElement === this) fakeDocument.activeElement = fakeDocument.body;
  }
  getBoundingClientRect() {
    return layoutRect(this);
  }
}

const hasClass = (el: FakeNode, cls: string) => el instanceof FakeElement && el.className.split(' ').includes(cls);
function closest(el: FakeNode | null, cls: string): FakeElement | null {
  for (let n = el; n; n = n.parentNode) if (hasClass(n, cls)) return n as FakeElement;
  return null;
}
const px = (value: unknown) => Number.parseFloat(String(value ?? '')) || 0;
/** The bar's height, as MonthBrowse sets it on its root (--ch-mb-bar). */
const barPxOf = (el: FakeNode) => px(closest(el, 'ch-mb')?.style['--ch-mb-bar']);

function rect(top: number, height: number) {
  return { top, bottom: top + height, left: 0, right: LAYOUT.width, width: LAYOUT.width, height, x: 0, y: top };
}

/** A month block's top in the list, from the block sizes rendered above it. */
function sectionTop(section: FakeNode): number {
  let y = 0;
  for (const sibling of section.parentNode?.childNodes ?? []) {
    if (sibling === section) break;
    y += px((sibling as FakeElement).style?.blockSize);
  }
  return y;
}

function layoutRect(el: FakeElement) {
  const scrollY = fakeWindow.scrollY as number;
  if (hasClass(el, 'ch-mb-months')) {
    const height = el.childNodes.reduce((sum, s) => sum + px((s as FakeElement).style?.blockSize), 0);
    return rect(LAYOUT.listTop - scrollY, height);
  }
  if (hasClass(el, 'ch-mb-bar')) {
    const bar = barPxOf(el);
    return rect(Math.max(LAYOUT.safeTop + LAYOUT.topH, LAYOUT.listTop - bar - scrollY), bar);
  }
  if (hasClass(el, 'ch-mb-title') && el.parentNode) {
    return rect(LAYOUT.listTop + sectionTop(el.parentNode) - scrollY, px(closest(el, 'ch-mb')?.style['--ch-mb-title']));
  }
  return rect(0, 0);
}

const fakeDocument: Row = {
  nodeType: 9,
  nodeName: '#document',
  documentElement: { nodeType: 1, nodeName: 'HTML', clientHeight: 800 },
  createElement: (tag: string) => new FakeElement(String(tag).toLowerCase(), HTML_NS),
  createElementNS: (ns: string, tag: string) => new FakeElement(tag, ns),
  createTextNode: (text: string) => new FakeText(text),
  addEventListener: noop,
  removeEventListener: noop,
};
fakeDocument.body = new FakeElement('body', HTML_NS);
fakeDocument.activeElement = fakeDocument.body;

/** window.addEventListener's listeners (scroll and resize), with their options. */
type WindowListener = { type: string; fn: () => void; options: unknown };
const windowListeners: WindowListener[] = [];
/** Every window.scrollTo call: the top and the behaviour ('plain' for the two-number form). */
const scrollCalls: { top: number; behavior: string }[] = [];
/** The frames requested and not run yet. */
const frames = new Map<number, () => void>();
let nextFrameId = 1;
/** The media queries' answers, and their change listeners. */
const media = new Map<string, boolean>();
const mediaListeners = new Map<string, Set<() => void>>();

const NARROW = '(max-width: 360px)';
const REDUCED = '(prefers-reduced-motion: reduce)';

function fakeMediaList(query: string): Row {
  const set = () => {
    if (!mediaListeners.has(query)) mediaListeners.set(query, new Set());
    return mediaListeners.get(query) as Set<() => void>;
  };
  return {
    media: query,
    get matches() {
      return media.get(query) === true;
    },
    addEventListener: (_type: string, fn: () => void) => void set().add(fn),
    removeEventListener: (_type: string, fn: () => void) => void set().delete(fn),
    addListener: (fn: () => void) => void set().add(fn),
    removeListener: (fn: () => void) => void set().delete(fn),
  };
}

/** A fake IntersectionObserver: it records what it observes; a check fires its entries. */
class FakeIO {
  static all: FakeIO[] = [];
  observed = new Set<FakeElement>();
  disconnected = false;
  constructor(
    public callback: (entries: Row[], observer: FakeIO) => void,
    public options: Row = {},
  ) {
    FakeIO.all.push(this);
  }
  observe(el: FakeElement) {
    this.observed.add(el);
  }
  unobserve(el: FakeElement) {
    this.observed.delete(el);
  }
  disconnect() {
    this.disconnected = true;
    this.observed.clear();
  }
  takeRecords() {
    return [];
  }
  /** One callback with an entry for each observed month named in `states`. */
  fire(states: Record<MonthKey, boolean>) {
    const entries = [...this.observed]
      .filter((el) => (el.getAttribute('data-month') ?? '') in states)
      .map((el) => ({ target: el, isIntersecting: states[el.getAttribute('data-month') ?? ''] }));
    React.act(() => this.callback(entries, this));
  }
}

const fakeWindow: Row = {
  document: fakeDocument,
  HTMLIFrameElement: class {},
  location: { hash: '' },
  scrollY: 0,
  innerHeight: 800,
  addEventListener: (type: string, fn: () => void, options?: unknown) => void windowListeners.push({ type, fn, options }),
  removeEventListener: (type: string, fn: () => void) => {
    const i = windowListeners.findIndex((l) => l.type === type && l.fn === fn);
    if (i >= 0) windowListeners.splice(i, 1);
  },
  scrollTo: (a: Row | number, b?: number) => {
    const call = typeof a === 'number' ? { top: b ?? 0, behavior: 'plain' } : { top: Number(a.top), behavior: String(a.behavior ?? 'auto') };
    scrollCalls.push(call);
    fakeWindow.scrollY = Math.max(0, call.top);
  },
  getComputedStyle: (el: FakeElement) => ({
    scrollMarginTop: hasClass(el, 'ch-mb-title') ? `${LAYOUT.safeTop + LAYOUT.topH + barPxOf(el)}px` : '0px',
  }),
  matchMedia: (query: string) => fakeMediaList(query),
  requestAnimationFrame: (fn: () => void) => {
    const id = nextFrameId++;
    frames.set(id, fn);
    return id;
  },
  cancelAnimationFrame: (id: number) => void frames.delete(id),
  setTimeout,
  clearTimeout,
  IntersectionObserver: FakeIO,
};
fakeDocument.defaultView = fakeWindow;

function installWindow() {
  const g = globalThis as Row;
  g.window = fakeWindow;
  g.document = fakeDocument;
  g.IS_REACT_ACT_ENVIRONMENT = true;
}

/** A clean page: scrolled to the top, no calls, no frames, wide, motion allowed, a fresh observer class. */
function resetPage() {
  fakeWindow.scrollY = 0;
  scrollCalls.length = 0;
  frames.clear();
  media.clear();
  FakeIO.all = [];
  fakeWindow.IntersectionObserver = FakeIO;
}

/** Runs the frames requested so far (and any they request), inside act. */
function flushFrames() {
  React.act(() => {
    for (let round = 0; round < 5 && frames.size > 0; round++) {
      const batch = [...frames.values()];
      frames.clear();
      for (const run of batch) run();
    }
  });
}

/** The user scrolls to `top`: the page moves and the window gets a scroll event. */
function scrollPageTo(top: number) {
  fakeWindow.scrollY = top;
  fireScroll();
}
function fireScroll() {
  React.act(() => {
    for (const l of windowListeners.filter((x) => x.type === 'scroll')) l.fn();
  });
}

function setMedia(query: string, matches: boolean) {
  media.set(query, matches);
  React.act(() => {
    for (const fn of mediaListeners.get(query) ?? []) fn();
  });
}

type Mounted = {
  container: FakeElement;
  render: (el: ReactElement) => void;
  click: (el: FakeNode) => void;
  unmount: () => void;
};

function mount(el: ReactElement): Mounted {
  const { createRoot } = nodeRequire('react-dom/client');
  const container = new FakeElement('div', HTML_NS);
  const root = createRoot(container);
  React.act(() => root.render(el));
  const dispatch = (target: FakeNode, type: string) => {
    const event: Row = {
      type,
      target,
      srcElement: target,
      bubbles: true,
      cancelable: true,
      defaultPrevented: false,
      isTrusted: true,
      timeStamp: Date.now(),
      button: 0,
      buttons: 0,
      detail: 1,
      preventDefault() {
        event.defaultPrevented = true;
      },
      stopPropagation: noop,
      stopImmediatePropagation: noop,
    };
    React.act(() => {
      fakeWindow.event = event;
      for (const capture of [true, false]) {
        for (const l of container.listeners.filter((x) => x.type === type && x.capture === capture)) l.fn(event);
      }
      fakeWindow.event = undefined;
    });
  };
  return {
    container,
    render: (next) => React.act(() => root.render(next)),
    click: (target) => dispatch(target, 'click'),
    unmount: () => React.act(() => root.unmount()),
  };
}

function elements(node: FakeNode, out: FakeElement[] = []): FakeElement[] {
  for (const c of node.childNodes) {
    if (c instanceof FakeElement) {
      out.push(c);
      elements(c, out);
    }
  }
  return out;
}
const byClass = (node: FakeNode, cls: string) => elements(node).filter((e) => hasClass(e, cls));
function sectionEl(m: Mounted, month: MonthKey): FakeElement {
  const found = byClass(m.container, 'ch-mb-month').find((e) => e.getAttribute('data-month') === month);
  assert(found, `no block for ${month}`);
  return found;
}
/** The day buttons a month draws (0 for a far month). */
const dayButtons = (m: Mounted, month: MonthKey) => elements(sectionEl(m, month)).filter((e) => e.localName === 'button' && hasClass(e, 'ch-mb-cell'));
function dayButton(m: Mounted, month: MonthKey, labelStart: string): FakeElement {
  const found = dayButtons(m, month).filter((b) => (b.getAttribute('aria-label') ?? '').startsWith(labelStart));
  assert(found.length === 1, `one day button ${show(labelStart)} in ${month}`);
  return found[0];
}
const barText = (m: Mounted) => byClass(m.container, 'ch-mb-bar-month')[0]?.textContent ?? null;
const todayButton = (m: Mounted) => byClass(m.container, 'ch-mb-today')[0] ?? null;
/** The month's top in the list, from the block sizes the view rendered above it. */
const topOf = (m: Mounted, month: MonthKey) => sectionTop(sectionEl(m, month));
/** The bar's bottom, in the list's coordinates (where the reader's view starts). */
function bandTop(m: Mounted): number {
  const bar = byClass(m.container, 'ch-mb-bar')[0];
  const list = byClass(m.container, 'ch-mb-months')[0];
  return bar.getBoundingClientRect().bottom - list.getBoundingClientRect().top;
}
/** The page offset that puts `month`'s title just under the stuck bar. */
const titleUnderBar = (m: Mounted, month: MonthKey) => LAYOUT.listTop + topOf(m, month) - (LAYOUT.safeTop + LAYOUT.topH + barPxOf(byClass(m.container, 'ch-mb-bar')[0]));

/** MonthBrowse with recording callbacks. */
function recorder() {
  const seen = { inView: [] as MonthKey[], near: [] as MonthKey[][], picked: [] as DayKey[], retried: [] as string[], chosen: 0 };
  const callbacks: Partial<MonthBrowseProps> = {
    onMonthInView: (month) => void seen.inView.push(month),
    onNearMonths: (months) => void seen.near.push(months),
    onPickDay: (day) => void seen.picked.push(day),
    onRetryMonth: (month, source) => void seen.retried.push(`${month}:${source}`),
    onChooseCalendars: () => void seen.chosen++,
  };
  return { seen, callbacks };
}

const browseIn = (locale: Locale, props: MonthBrowseProps) => inIntl(locale, createElement(MonthBrowse, props));

// ---- The CSS, as rules ----

type Rule = { selector: string; body: string };
/** The innermost rules: a rule inside @media or @keyframes comes out with its own selector. */
const cssRules = (css: string): Rule[] => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1].trim(), body: m[2] }));
const ruleOf = (css: string, selector: string) => {
  const found = cssRules(css).filter((r) => r.selector === selector);
  assert(found.length === 1, `one ${selector} rule: ${found.length}`);
  return found[0].body;
};
const declOf = (body: string, prop: string) => new RegExp(`(?:^|[\\s;])${prop}\\s*:\\s*([^;]+);`).exec(body)?.[1].trim() ?? null;

async function main() {
  await check('#1 the view is client-safe: MonthBrowse loads no server module (DB, Redis, services, date-fns-tz, @hebcal/core), no home-client and no Telegram code; it reads month.ts, grid.ts, hebrew-date.ts and format.ts', () => {
    const root = path.join(ROOT, 'app/[locale]/dashboard/MonthBrowse.tsx');
    assert(require.cache[root] !== undefined, 'MonthBrowse is not in require.cache: the check would be empty');
    const loaded = new Set<string>();
    const walk = (id: string) => {
      for (const child of require.cache[id]?.children ?? []) {
        if (loaded.has(child.id)) continue;
        loaded.add(child.id);
        walk(child.id);
      }
    };
    walk(root);
    for (const want of ['src/lib/calendar-view/month.ts', 'src/lib/calendar-view/grid.ts', 'src/lib/calendar-view/hebrew-date.ts', 'src/lib/calendar-view/format.ts']) {
      assert(loaded.has(path.join(ROOT, want)), `${want} not among the loaded modules: the check would be empty`);
    }
    const forbidden = [...loaded].filter((p) =>
      /[\\/](src[\\/](services|utils|config)|@prisma|\.prisma|@upstash|date-fns-tz|@hebcal[\\/]core|googleapis|@googleapis)[\\/]|src[\\/]lib[\\/](page-data|api-auth|prisma|telegram-ui|calendar-view[\\/]home-client)/.test(p),
    );
    assert(forbidden.length === 0, `modules the view must not load: ${show(forbidden.map((p) => path.relative(ROOT, p)))}`);
  });

  await check('#2 en: the sticky bar names the month in view with its year and Hebrew months; the titles follow Ruling 8 (the year only off today\'s year) with each month\'s Hebrew range; dir="ltr"', () => {
    const html = renderBrowse('en', browseProps(famcalStore()));
    assert(/<section class="ch-mb" dir="ltr" style="--ch-mb-bar:76px;--ch-mb-title:58px;--ch-mb-cell:92px">/.test(html), 'the root: dir="ltr" and the heights');
    const bar = barOf(html);
    assert(show([bar.month, bar.hebrew, bar.today]) === show(['October 2026', 'Tishrei – Cheshvan 5787', null]), `bar: ${show(bar)}`);
    const titles = (['2025-10', '2026-09', '2026-10', '2026-11', '2027-01', '2028-04'] as const).map((m) => titleOf(html, m));
    assert(
      show(titles) ===
        show([
          { month: 'October 2025', hebrew: 'Tishrei – Cheshvan 5786' },
          { month: 'September', hebrew: 'Elul 5786 – Tishrei 5787' },
          { month: 'October', hebrew: 'Tishrei – Cheshvan 5787' },
          { month: 'November', hebrew: 'Cheshvan – Kislev 5787' },
          { month: 'January 2027', hebrew: 'Tevet – Sh\'vat 5787' },
          { month: 'April 2028', hebrew: 'Nisan – Iyyar 5788' },
        ]),
      `titles: ${show(titles)}`,
    );
    assert((html.match(/<h2 class="ch-mb-title">/g) ?? []).length === 31, 'one h2 per month of the window (31)');
  });

  await check('#3 en cells: the labels ("Thursday, 15 October, 4 Cheshvan, 3 items, 1 from Noa"), aria-current on today only, the head line\'s Hebrew day and the month line on Hebrew day 1 and the first cell (Ruling 3)', () => {
    const html = monthHtml(renderBrowse('en', browseProps(famcalStore())), '2026-10');
    const cells = cellsOf(html);
    assert(cells.length === 31, `31 day buttons: ${cells.length}`);
    const labels = ['Thursday, 15 October', 'Friday, 16 October', 'Saturday, 17 October', 'Monday, 12 October', 'Tuesday, 6 October', 'Tuesday, 20 October', 'Thursday, 1 October'].map((d) => cellOf(html, d).label);
    assert(
      show(labels) ===
        show([
          'Thursday, 15 October, 4 Cheshvan, 3 items, 1 from Noa',
          'Friday, 16 October, 5 Cheshvan, 1 item, 1 from Noa',
          'Saturday, 17 October, 6 Cheshvan, nothing planned',
          'Monday, 12 October, 1 Cheshvan, nothing planned',
          'Tuesday, 6 October, 25 Tishrei, 1 item',
          'Tuesday, 20 October, 9 Cheshvan, 1 item',
          'Thursday, 1 October, 20 Tishrei, nothing planned',
        ]),
      `labels: ${show(labels)}`,
    );
    assert(show(cells.filter((c) => c.today).map((c) => c.label.slice(0, 20))) === show(['Thursday, 15 October']), 'aria-current="date" on today only');
    assert(cellOf(html, 'Thursday, 15 October').cls.includes('is-today'), 'today is marked');
    const heads = ['Thursday, 15 October', 'Monday, 12 October', 'Thursday, 1 October', 'Tuesday, 13 October'].map((d) => headOf(cellOf(html, d)));
    assert(
      show(heads) ===
        show([
          { day: '15', hebrewDay: '4', hebrewMonth: '' },
          { day: '12', hebrewDay: '1', hebrewMonth: 'Chesh.' },
          { day: '1', hebrewDay: '20', hebrewMonth: 'Tish.' },
          { day: '13', hebrewDay: '2', hebrewMonth: '' },
        ]),
      `head lines: ${show(heads)}`,
    );
    assert(cells.every((c) => /<span class="ch-mb-head" aria-hidden="true">/.test(c.inner) && /<span class="ch-mb-slots" aria-hidden="true">/.test(c.inner)), 'every head line and slot list is aria-hidden');
    const blanks = html.match(/<div class="ch-mb-cell is-blank"[^>]*>/g) ?? [];
    assert(blanks.length === 4 && blanks.every((b) => b === '<div class="ch-mb-cell is-blank" aria-hidden="true">'), `4 blank cells, aria-hidden, no button: ${show(blanks)}`);
  });

  await check('#4 en chips: whose (E4: mine filled, the partner\'s outlined), done struck through, the daily reminder left out (R11), the Eilat bar\'s shapes with its title on its first day, "+2 more" in the third slot, dir="auto"', () => {
    const html = monthHtml(renderBrowse('en', browseProps(famcalStore())), '2026-10');
    const chips = (d: string) => chipsOf(cellOf(html, d)).map((c) => `${c.cls}|${c.text}`);
    assert(
      show(chips('Thursday, 15 October')) ===
        show(['ch-mb-chip is-timed is-mine-timed|Dentist', 'ch-mb-chip is-timed is-mine-timed|Send the school form', 'ch-mb-chip is-timed is-partner-timed|Football practice']),
      `15 Oct: ${show(chips('Thursday, 15 October'))}`,
    );
    assert(!html.includes('Take vitamins'), 'the daily reminder is not drawn');
    assert(show(chips('Friday, 16 October')) === show(['ch-mb-chip is-allDay is-partner-solid|Grandma visits']), `16 Oct: ${show(chips('Friday, 16 October'))}`);
    assert(show(chips('Tuesday, 20 October')) === show(['ch-mb-chip is-allDay is-mine-solid|Noa’s birthday']), `20 Oct: ${show(chips('Tuesday, 20 October'))}`);
    assert(show(chips('Tuesday, 6 October')) === show(['ch-mb-chip is-timed is-mine-timed is-done|Call Mom']), `6 Oct: ${show(chips('Tuesday, 6 October'))}`);
    const eilat = ['Sunday, 25 October', 'Monday, 26 October', 'Tuesday, 27 October', 'Wednesday, 28 October', 'Thursday, 29 October'].map((d) => chips(d)[0]);
    assert(
      show(eilat) ===
        show([
          'ch-mb-chip is-bar is-mine-solid is-after|Eilat trip',
          'ch-mb-chip is-bar is-mine-solid is-before is-after|',
          'ch-mb-chip is-bar is-mine-solid is-before is-after|',
          'ch-mb-chip is-bar is-mine-solid is-before is-after|',
          'ch-mb-chip is-bar is-mine-solid is-before|',
        ]),
      `the Eilat bar: ${show(eilat)}`,
    );
    const busy = cellOf(html, 'Monday, 26 October');
    assert(show(chips('Monday, 26 October')) === show(['ch-mb-chip is-bar is-mine-solid is-before is-after|', 'ch-mb-chip is-timed is-partner-timed|Snorkeling']), `26 Oct: ${show(chips('Monday, 26 October'))}`);
    assert(moreOf(busy) === '+2 more' && busy.label === 'Monday, 26 October, 15 Cheshvan, 4 items, 2 from Noa', `26 Oct: ${show([moreOf(busy), busy.label])}`);
    assert(show(chips('Wednesday, 14 October').map((c) => c.split('|')[1])) === show(['Gym', 'Call the plumber', 'Pilates']) && moreOf(cellOf(html, 'Wednesday, 14 October')) === null, 'a day of 3 shows 3 chips on a wide screen');
    // Under week start 1 the trip crosses a row: its title shows again at the second row's start.
    const ws1 = monthHtml(renderBrowse('en', browseProps(famcalStore({ weekStart: 1 }))), '2026-10');
    assert(show(chipsOf(cellOf(ws1, 'Monday, 26 October'))[0]) === show({ cls: 'ch-mb-chip is-bar is-mine-solid is-before is-after', text: 'Eilat trip' }), 'the bar\'s title at a week row\'s start');
  });

  await check('#5 he: dir="rtl"; the bar, the titles and the Hebrew ranges in Hebrew with gematriya years; the labels in Hebrew; the Hebrew day in gematriya and the month line', () => {
    const html = renderBrowse('he', browseProps(famcalStore()));
    assert(/<section class="ch-mb" dir="rtl"/.test(html), 'the root is dir="rtl"');
    const bar = barOf(html);
    assert(show([bar.month, bar.hebrew]) === show(['אוקטובר 2026', 'תשרי – חשון תשפ״ז']), `bar: ${show(bar)}`);
    const titles = (['2026-09', '2026-10', '2027-01'] as const).map((m) => titleOf(html, m));
    assert(
      show(titles) === show([{ month: 'ספטמבר', hebrew: 'אלול תשפ״ו – תשרי תשפ״ז' }, { month: 'אוקטובר', hebrew: 'תשרי – חשון תשפ״ז' }, { month: 'ינואר 2027', hebrew: 'טבת – שבט תשפ״ז' }]),
      `titles: ${show(titles)}`,
    );
    const october = monthHtml(html, '2026-10');
    const labels = ['יום חמישי, 15 באוקטובר', 'יום שישי, 16 באוקטובר', 'יום שבת, 17 באוקטובר'].map((d) => cellOf(october, d).label);
    assert(
      show(labels) === show(['יום חמישי, 15 באוקטובר, ד׳ בחשון, 3 אירועים, 1 של Noa', 'יום שישי, 16 באוקטובר, ה׳ בחשון, אירוע אחד, 1 של Noa', 'יום שבת, 17 באוקטובר, ו׳ בחשון, אין אירועים']),
      `labels: ${show(labels)}`,
    );
    const heads = ['יום חמישי, 15 באוקטובר', 'יום שני, 12 באוקטובר', 'יום חמישי, 1 באוקטובר'].map((d) => headOf(cellOf(october, d)));
    assert(
      show(heads) === show([{ day: '15', hebrewDay: 'ד׳', hebrewMonth: '' }, { day: '12', hebrewDay: 'א׳', hebrewMonth: 'חשון' }, { day: '1', hebrewDay: 'כ׳', hebrewMonth: 'תשרי' }]),
      `head lines: ${show(heads)}`,
    );
    assert(moreOf(cellOf(october, 'יום שני, 26 באוקטובר')) === 'עוד 2', '"+N" in Hebrew');
  });

  await check('#6 ru: the titles in the capitalised nominative without "г." (Ruling 8), the Hebrew ranges in the nominative and the labels in the genitive (R9), "Noa: 1", the month line', () => {
    const html = renderBrowse('ru', browseProps(famcalStore()));
    const bar = barOf(html);
    assert(show([bar.month, bar.hebrew]) === show(['Октябрь 2026', 'Тишрей – Хешван 5787']), `bar: ${show(bar)}`);
    const titles = (['2026-09', '2026-10', '2027-01'] as const).map((m) => titleOf(html, m));
    assert(
      show(titles) === show([{ month: 'Сентябрь', hebrew: 'Элул 5786 – Тишрей 5787' }, { month: 'Октябрь', hebrew: 'Тишрей – Хешван 5787' }, { month: 'Январь 2027', hebrew: 'Тевет – Шват 5787' }]),
      `titles: ${show(titles)}`,
    );
    const october = monthHtml(html, '2026-10');
    const labels = ['четверг, 15 октября', 'пятница, 16 октября', 'суббота, 17 октября'].map((d) => cellOf(october, d).label);
    assert(
      show(labels) === show(['четверг, 15 октября, 4 хешвана, 3 события, Noa: 1', 'пятница, 16 октября, 5 хешвана, 1 событие, Noa: 1', 'суббота, 17 октября, 6 хешвана, ничего не запланировано']),
      `labels: ${show(labels)}`,
    );
    assert(show(headOf(cellOf(october, 'понедельник, 12 октября'))) === show({ day: '12', hebrewDay: '1', hebrewMonth: 'хешв.' }), 'the month line on Hebrew day 1');
    assert(show(headOf(cellOf(october, 'четверг, 1 октября'))) === show({ day: '1', hebrewDay: '20', hebrewMonth: 'тишр.' }), 'the month line on the first cell');
    assert(moreOf(cellOf(october, 'понедельник, 26 октября')) === 'Ещё 2', '"+N" in Russian');
  });

  await check('#7 the weekday row in week-start order (Ruling 8) for week starts 0, 1 and 6 in en, he and ru, aria-hidden; each month\'s first row starts on the week start', () => {
    const want: Record<Locale, Record<0 | 1 | 6, string>> = {
      en: { 0: 'S M T W T F S', 1: 'M T W T F S S', 6: 'S S M T W T F' },
      he: { 0: 'א׳ ב׳ ג׳ ד׳ ה׳ ו׳ ש׳', 1: 'ב׳ ג׳ ד׳ ה׳ ו׳ ש׳ א׳', 6: 'ש׳ א׳ ב׳ ג׳ ד׳ ה׳ ו׳' },
      ru: { 0: 'Вс Пн Вт Ср Чт Пт Сб', 1: 'Пн Вт Ср Чт Пт Сб Вс', 6: 'Сб Вс Пн Вт Ср Чт Пт' },
    };
    for (const ws of [0, 1, 6] as const) {
      const store = famcalStore({ weekStart: ws });
      for (const locale of LOCALES) {
        const html = renderBrowse(locale, browseProps(store));
        const row = barOf(html).weekdays.join(' ');
        assert(row === want[locale][ws], `${locale} ws ${ws}: ${row}`);
        // October 2026 starts on a Thursday: its first row has (4 - ws + 7) % 7 blank cells.
        const firstRow = /<div class="ch-mb-row">([\s\S]*?)<\/div><div class="ch-mb-row">/.exec(monthHtml(html, '2026-10'))?.[1] ?? '';
        const blanks = (firstRow.match(/is-blank/g) ?? []).length;
        assert(blanks === (4 - ws + 7) % 7, `${locale} ws ${ws}: ${blanks} blanks before the 1st`);
      }
    }
  });

  await check('#8 no free-looking cell while a month loads or failed (§5): September loading shows placeholders, a model-less month too; November busy and December\'s error are dimmed under a centred pill with Retry; none reads "nothing planned"', () => {
    const html = renderBrowse('en', browseProps(famcalStore(), { start: { month: '2026-11', peek: false } }));
    const september = cellsOf(monthHtml(renderBrowse('en', browseProps(famcalStore())), '2026-09'));
    assert(september.length === 30 && september.every((c) => c.cls.includes('is-loading') && c.inner.includes('ch-mb-ghost') && c.label.endsWith(', loading')), `September: ${show(september.slice(0, 2))}`);
    const modelLess = cellsOf(monthHtml(renderBrowse('en', browseProps(famcalStore(), { getMonth: () => null })), '2026-10'));
    assert(modelLess.length === 31 && modelLess.every((c) => c.cls.includes('is-loading') && c.inner.includes('ch-mb-ghost') && !c.inner.includes('ch-mb-chip')), 'with no model, every day of the month is loading');
    assert(modelLess.filter((c) => c.today).length === 1, 'today is still marked');
    for (const [month, pill, count] of [
      ['2026-11', 'Busy right now, try again in a minute', 30],
      ['2026-12', 'Couldn’t load this month', 31],
    ] as const) {
      const block = monthHtml(html, month);
      const cells = cellsOf(block);
      assert(cells.length === count && cells.every((c) => c.cls.includes('is-failed') && c.label.endsWith(', couldn’t load') && !c.inner.includes('ch-mb-ghost')), `${month} dimmed: ${show(cells.slice(0, 1))}`);
      const overlay = /<div class="ch-mb-overlay is-centre"><div class="ch-mb-pill"><span class="ch-mb-pill-text">([^<]*)<\/span><button type="button" class="ch-btn ch-mb-pill-action">([^<]*)<\/button><\/div><\/div>/.exec(block);
      assert(overlay && show([decode(overlay[1]), overlay[2]]) === show([pill, 'Retry']), `${month}'s pill: ${show(overlay?.slice(1))}`);
    }
    const all = [...september, ...cellsOf(monthHtml(html, '2026-11')), ...cellsOf(monthHtml(html, '2026-12'))];
    assert(!all.some((c) => c.label.includes('nothing planned')), 'no loading or failed day reads "nothing planned"');
    assert(!monthHtml(html, '2026-10').includes('ch-mb-overlay'), 'an answered month has no pill');
  });

  await check('#9 a Google user (Ruling 4): calendars gone is a centred pill with Choose again; partial is a pill at the top over live cells; a reconnect dims the cells with no pill (the banner says it)', () => {
    const html = renderBrowse('en', browseProps(googleStore(), { start: { month: '2026-11', peek: false } }));
    const october = monthHtml(html, '2026-10');
    assert(/<div class="ch-mb-overlay is-top"><div class="ch-mb-pill"><span class="ch-mb-pill-text">Some calendars didn’t load<\/span><button type="button" class="ch-btn ch-mb-pill-action">Retry<\/button><\/div><\/div>/.test(october), 'October: the partial pill at the top');
    assert(cellsOf(october).every((c) => !c.cls.includes('is-failed') && !c.cls.includes('is-loading')), 'October\'s cells stay live');
    assert(cellOf(october, 'Thursday, 15 October').label === 'Thursday, 15 October, 4 Cheshvan, 1 item', `no "from" without a partner: ${cellOf(october, 'Thursday, 15 October').label}`);
    const november = monthHtml(html, '2026-11');
    assert(/<div class="ch-mb-overlay is-centre"><div class="ch-mb-pill"><span class="ch-mb-pill-text">Your calendars aren’t available<\/span><button type="button" class="ch-btn ch-mb-pill-action">Choose again<\/button>/.test(november), 'November: calendars gone');
    const december = monthHtml(html, '2026-12');
    assert(!december.includes('ch-mb-overlay') && cellsOf(december).every((c) => c.cls.includes('is-failed') && c.label.endsWith('couldn’t load')), 'December: dimmed, no pill');
  });

  await check('#10 with Hebrew dates off: no Hebrew line in the bar, the titles or the cells, and the shorter heights (bar 72, title 42)', () => {
    const store = famcalStore({ hebrewDates: false });
    const html = renderBrowse('en', browseProps(store));
    assert(/<section class="ch-mb" dir="ltr" style="--ch-mb-bar:72px;--ch-mb-title:42px;--ch-mb-cell:92px">/.test(html), 'the heights without the Hebrew line');
    assert(barOf(html).hebrew === null && titleOf(html, '2026-10').hebrew === null, 'no Hebrew months in the bar or the titles');
    const october = monthHtml(html, '2026-10');
    assert(!/ch-mb-hday|Cheshvan|Chesh\./.test(october), 'no Hebrew day in the cells');
    assert(cellOf(october, 'Thursday, 15 October').label === 'Thursday, 15 October, 3 items, 1 from Noa', 'the label without the Hebrew date');
    assert(cellsOf(october).every((c) => c.inner.includes('<span class="ch-mb-hmonth" aria-hidden="true"></span>')), 'the month line stays, empty (the line kept for holidays)');
  });

  await check('#11 the block sizes: every month at monthBlockPx(rows, hebrewDates), near or far, for 4-, 5- and 6-row months; a body is rows × 92; a far month is its title and an empty aria-hidden box; a model from another week start draws as loading at the new height', () => {
    for (const [ws, hd] of [
      [0, true],
      [0, false],
      [1, true],
      [6, true],
    ] as const) {
      const html = markup(renderBrowse('en', browseProps(famcalStore({ weekStart: ws, hebrewDates: hd }))));
      const sizes = blockSizes(html);
      assert(show(sizes.map((s) => s.month)) === show(monthSpan(TODAY)), `ws ${ws}: the window's 31 months in order`);
      for (const s of sizes) {
        const rows = monthGrid(s.month, ws).length;
        assert(s.block === monthBlockPx(rows, hd) && s.body === rows * BROWSE_CELL_PX && s.block === monthTitlePx(hd) + s.body, `ws ${ws} hd ${hd} ${s.month}: ${show(s)}`);
      }
      assert(show(sizes.filter((s) => !s.far).map((s) => s.month)) === show(['2026-09', '2026-10', '2026-11']), `ws ${ws}: only the start month and its neighbours drawn: ${show(sizes.filter((s) => !s.far).map((s) => s.month))}`);
      if (ws === 0) {
        const rowCounts = new Set(sizes.map((s) => s.body / BROWSE_CELL_PX));
        assert(show([...rowCounts].sort()) === show([4, 5, 6]), `4-, 5- and 6-row months: ${show([...rowCounts])}`);
        const known = Object.fromEntries(sizes.map((s) => [s.month, s.block]));
        // Arithmetic from the spec's heights: title 58 (42 without the Hebrew line) + rows × 92.
        assert(show([known['2026-02'], known['2026-10'], known['2026-08']]) === show(hd ? [426, 518, 610] : [410, 502, 594]), `Feb, Oct and Aug 2026: ${show([known['2026-02'], known['2026-10'], known['2026-08']])}`);
      }
      const far = monthHtml(html, '2027-03');
      assert(/<div class="ch-mb-body ch-mb-far" style="block-size:\d+px" aria-hidden="true"><\/div>/.test(far) && !far.includes('<button'), 'a far month: an empty, aria-hidden box');
    }
    assert(monthBarPx(true) === 76 && monthBarPx(false) === 72 && monthTitlePx(true) === 58 && monthTitlePx(false) === 42 && BROWSE_CELL_PX === 92, 'E5\'s heights');
    // Mid-change: the week start moved to 1 (March 2026 goes from 5 rows to 6) while the models are still week start 0's.
    const html = markup(renderBrowse('en', browseProps(famcalStore(), { weekStart: 1, start: { month: '2026-03', peek: false } })));
    const march = blockSizes(html).find((s) => s.month === '2026-03');
    assert(march && monthGrid('2026-03', 0).length === 5 && march.block === monthBlockPx(6, true) && march.body === 6 * BROWSE_CELL_PX, `March at week start 1: ${show(march)}`);
    const cells = cellsOf(monthHtml(html, '2026-03'));
    assert(cells.length === 31 && cells.every((c) => c.cls.includes('is-loading')), 'a model from another week start draws as loading, at the new height');
    const october = cellsOf(monthHtml(markup(renderBrowse('en', browseProps(famcalStore(), { weekStart: 1 }))), '2026-10'));
    assert(october.every((c) => c.cls.includes('is-loading')), 'October too, though its rows are as many');
  });

  await check('#12 the CSS: nothing under 11 px; the 44 px Today button and pill; logical properties only; the sticky top under both safe areas and what sticks above the bar (--ch-top-h); overflow-x: clip on the root and overflow: hidden only on text leaves; no transform or filter; the reduced-motion rule; no hover; the heights add up; E4\'s tokens only', () => {
    const css = MONTH_BROWSE_CSS;
    const sizes = [...css.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
    assert(sizes.length >= 8 && Math.min(...sizes) >= 11, `font sizes: ${show(sizes)}`);
    assert(!/font-size:\s*[\d.]+(?:em|rem|%)|font:\s/.test(css), 'every font size in px (so the floor is checkable)');
    const today = ruleOf(css, '.ch-mb-today');
    assert(px(declOf(today, 'min-height')) >= 44 && px(declOf(today, 'min-width')) >= 44, `the Today button: ${today}`);
    assert(px(declOf(ruleOf(css, '.ch-mb-pill'), 'min-height')) >= 44, 'a pill is at least 44 px');
    assert(/\.ch-btn \{[^}]*min-height: 44px;[^}]*min-width: 44px;/.test(HOME_THEME_CSS), 'the pill\'s action is a .ch-btn (44 × 44)');
    const physical = css.match(/(?:margin|padding|border)-(?:left|right)|(?:^|[\s;{])(?:left|right)\s*:|text-align:\s*(?:left|right)|float:/g);
    assert(!physical, `physical properties: ${show(physical)}`);
    assert(!/:hover/.test(css), 'no hover styles');
    const bar = ruleOf(css, '.ch-mb-bar');
    assert(declOf(bar, 'position') === 'sticky' && declOf(bar, 'top') === 'calc(var(--tg-safe-area-inset-top, 0px) + var(--tg-content-safe-area-inset-top, 0px) + var(--ch-top-h, 0px))', `the sticky bar: ${bar}`);
    assert(declOf(bar, 'background') === 'var(--ch-bg)' && declOf(bar, 'block-size') === 'var(--ch-mb-bar)', 'the bar is opaque and exactly --ch-mb-bar tall');
    assert((css.match(/(?:^|[\s;{])top\s*:/g) ?? []).length === 1, 'the bar\'s top is the only top');
    assert(declOf(ruleOf(css, '.ch-mb-title'), 'scroll-margin-top') === 'calc(var(--tg-safe-area-inset-top, 0px) + var(--tg-content-safe-area-inset-top, 0px) + var(--ch-top-h, 0px) + var(--ch-mb-bar))', 'titles stop under the bar');
    // Overflow: the root clips sideways only, and only text leaves hide their overflow (their ellipsis).
    const overflows = cssRules(css).flatMap((r) => [...r.body.matchAll(/(?:^|[\s;])(overflow(?:-[xy])?)\s*:\s*([^;]+);/g)].map((m) => ({ selector: r.selector, decl: `${m[1]}: ${m[2].trim()}` })));
    assert(show(overflows.filter((o) => o.selector === '.ch-mb').map((o) => o.decl)) === show(['overflow-x: clip']), `the root: ${show(overflows.filter((o) => o.selector === '.ch-mb'))}`);
    const leaves = overflows.filter((o) => o.selector !== '.ch-mb');
    assert(leaves.every((o) => o.decl === 'overflow: hidden' && /^\.ch-mb-[a-z-]+$/.test(o.selector)), `other overflows: ${show(leaves)}`);
    const html = markup(renderBrowse('en', browseProps(famcalStore())));
    for (const { selector } of leaves) {
      const cls = selector.slice(1);
      const found = [...html.matchAll(new RegExp(`<(\\w+) class="${cls}(?: [^"]*)?"[^>]*>([\\s\\S]*?)</\\1>`, 'g'))];
      assert(found.length > 0, `${cls} is in the markup`);
      assert(found.every((m) => !m[2].replace(/<!-- -->/g, '').includes('<')), `${cls} holds text only: ${show(found.find((m) => m[2].includes('<'))?.[0].slice(0, 200))}`);
    }
    assert(/<section class="ch-mb"[^>]*><style>[\s\S]*?<\/style><div class="ch-mb-bar">/.test(renderBrowse('en', browseProps(famcalStore()))), 'the bar is the root\'s child: its only ancestor here is the root');
    assert(!/(?:^|[\s;{])(?:transform|filter|backdrop-filter|perspective|will-change|contain)\s*:/.test(css), 'no transform or filter (sticky, and D\'s fixed sheets)');
    assert(/@media \(prefers-reduced-motion: reduce\) \{\s*\.ch-mb-ghost \{\s*animation: none;/.test(css), 'reduced motion stops the placeholder\'s pulse');
    assert(show(cssRules(css).filter((r) => /animation\s*:/.test(r.body)).map((r) => r.selector)) === show(['.ch-mb-ghost', '.ch-mb-ghost']), 'the placeholder is the only animation');
    assert(!/scroll-behavior/.test(css), 'no CSS smooth scrolling: the Today button picks smooth or instant in JS');
    // The fixed heights add up to month.ts's.
    assert(px(declOf(ruleOf(css, '.ch-mb-weekdays'), 'block-size')) === 24 && monthBarPx(false) - 24 >= 44 && monthBarPx(true) - 24 >= 44, 'the bar\'s row holds the 44 px button above the 24 px weekday row');
    const title = ruleOf(css, '.ch-mb-title');
    const pad = (declOf(title, 'padding-block') ?? '').split(' ').map(px);
    const line = px(declOf(ruleOf(css, '.ch-mb-title-month'), 'line-height'));
    const hebrewLine = px(declOf(ruleOf(css, '.ch-mb-title-hebrew'), 'line-height'));
    assert(pad[0] + line + pad[1] === monthTitlePx(false) && pad[0] + line + hebrewLine + pad[1] === monthTitlePx(true) && declOf(title, 'block-size') === 'var(--ch-mb-title)', `the title: ${show([pad, line, hebrewLine])}`);
    const cell = ruleOf(css, '.ch-mb-cell');
    const inside = 1 + px((declOf(cell, 'padding-block') ?? '').split(' ')[0]) + px(declOf(ruleOf(css, '.ch-mb-head'), 'block-size')) + px(declOf(ruleOf(css, '.ch-mb-hmonth'), 'block-size')) + 3 * px(declOf(ruleOf(css, '.ch-mb-slot'), 'block-size'));
    assert(declOf(cell, 'block-size') === 'var(--ch-mb-cell)' && inside <= BROWSE_CELL_PX, `a cell's lines (${inside} px) fit its ${BROWSE_CELL_PX} px`);
    // Colours: E4's tokens, mine filled, the partner's outlined.
    const look = (sel: string) => ['background', 'color', 'border-color'].map((p) => declOf(ruleOf(css, sel), p));
    assert(show(look('.ch-mb-chip.is-mine-timed')) === show(['var(--ch-mine-soft)', 'var(--ch-mine-soft-text)', null]), 'mine, timed');
    assert(show(look('.ch-mb-chip.is-mine-solid')) === show(['var(--ch-mine-solid)', 'var(--ch-mine-solid-text)', null]), 'mine, all-day and bars');
    assert(show(look('.ch-mb-chip.is-partner-timed')) === show(['var(--ch-bg)', 'var(--ch-partner-line-text)', 'var(--ch-partner-line)']), 'the partner\'s, timed: outlined');
    assert(show(look('.ch-mb-chip.is-partner-solid')) === show(['var(--ch-partner-soft)', 'var(--ch-partner-soft-text)', 'var(--ch-partner-line)']), 'the partner\'s, all-day and bars: outlined too');
    assert(show(look('.ch-mb-cell.is-today .ch-mb-day').slice(0, 2)) === show(['var(--ch-today)', 'var(--ch-today-text)']), 'today on the --ch-today fill');
    const used = new Set([...css.matchAll(/var\((--ch-[a-z-]+)/g)].map((m) => m[1]));
    const defined = new Set([...HOME_THEME_CSS.matchAll(/(--ch-[a-z-]+)\s*:/g)].map((m) => m[1]));
    // The view's own three, and --ch-top-h, which E8's container sets on .ch-home (0px without it).
    const own = new Set(['--ch-mb-bar', '--ch-mb-title', '--ch-mb-cell', '--ch-top-h']);
    const unknown = [...used].filter((v) => !defined.has(v) && !own.has(v));
    assert(unknown.length === 0, `tokens home-theme.ts doesn't define: ${show(unknown)}`);
  });

  installWindow();

  await check('#13 in real React, the opening position: one instant scroll puts October\'s title under the bar with half a week row of September above it; Sep–Nov draw before any observer fires; then the month in view is October, with no Today button; one observer, rootMargin "100% 0px", on all 31 months; passive listeners', () => {
    resetPage();
    const { seen, callbacks } = recorder();
    const m = mount(browseIn('en', browseProps(famcalStore(), callbacks)));
    try {
      assert(show(['2026-08', '2026-09', '2026-10', '2026-11', '2026-12'].map((mo) => dayButtons(m, mo).length)) === show([0, 30, 31, 30, 0]), 'the start month and its neighbours draw before any observer fires');
      const want = titleUnderBar(m, '2026-10') - BROWSE_CELL_PX / 2;
      assert(show(scrollCalls) === show([{ top: want, behavior: 'instant' }]), `the opening scroll: ${show(scrollCalls)} (want ${want})`);
      assert(topOf(m, '2026-10') === [...monthSpan(TODAY).slice(0, 12)].reduce((sum, mo) => sum + monthBlockPx(monthGrid(mo, 0).length, true), 0), 'October\'s top is the blocks above it');
      assert(seen.inView.length === 0, 'nothing reported before the first frame');
      flushFrames();
      assert(show(seen.inView) === show(['2026-10']), `in view: ${show(seen.inView)}`);
      assert(bandTop(m) === topOf(m, '2026-10') - BROWSE_CELL_PX / 2, 'half a week row of September shows under the bar');
      assert(barText(m) === 'October 2026' && todayButton(m) === null, `the bar: ${barText(m)}, Today: ${todayButton(m) !== null}`);
      assert(seen.near.length === 0, 'the observer reports the near months (not yet fired)');
      assert(FakeIO.all.length === 1 && FakeIO.all[0].options.rootMargin === '100% 0px' && FakeIO.all[0].observed.size === 31, `one observer: ${show(FakeIO.all.map((io) => [io.options, io.observed.size]))}`);
      const scroll = windowListeners.filter((l) => l.type === 'scroll');
      assert(scroll.length === 1 && (scroll[0].options as Row)?.passive === true, `one passive scroll listener: ${show(scroll.map((l) => l.options))}`);
    } finally {
      m.unmount();
    }
  });

  await check('#14 the opening without peek (start December): December\'s title just under the bar, the month in view December, and the Today button shown (October is off screen)', () => {
    resetPage();
    const { seen, callbacks } = recorder();
    const m = mount(browseIn('en', browseProps(famcalStore(), { ...callbacks, start: { month: '2026-12', peek: false } })));
    try {
      assert(show(scrollCalls) === show([{ top: titleUnderBar(m, '2026-12'), behavior: 'instant' }]), `the opening scroll: ${show(scrollCalls)}`);
      assert(todayButton(m)?.textContent === 'Today', 'the Today button shows from the first render');
      flushFrames();
      assert(show(seen.inView) === show(['2026-12']) && bandTop(m) === topOf(m, '2026-12'), `in view: ${show(seen.inView)}`);
      assert(barText(m) === 'December 2026' && todayButton(m) !== null, 'the bar names December, and Today stays');
      assert(show(['2026-11', '2026-12', '2027-01'].map((mo) => dayButtons(m, mo).length)) === show([30, 31, 31]), 'December and its neighbours draw');
    } finally {
      m.unmount();
    }
  });

  await check('#15 the near months: the observer\'s reports gathered into one onNearMonths a frame, oldest first, only when they change; a month that comes near draws its grid', () => {
    resetPage();
    const { seen, callbacks } = recorder();
    const m = mount(browseIn('en', browseProps(famcalStore(), callbacks)));
    try {
      flushFrames();
      const io = FakeIO.all[0];
      io.fire({ '2026-10': true, '2026-11': true, '2026-09': true });
      io.fire({ '2026-12': true });
      assert(show([seen.near.length, frames.size]) === show([0, 1]), `one frame for two reports: ${frames.size}`);
      assert(dayButtons(m, '2026-12').length === 0, 'December is far until the frame');
      flushFrames();
      assert(show(seen.near) === show([['2026-09', '2026-10', '2026-11', '2026-12']]), `near: ${show(seen.near)}`);
      assert(dayButtons(m, '2026-12').length === 31, 'December draws once near');
      io.fire({ '2026-09': false });
      flushFrames();
      assert(show(seen.near.at(-1)) === show(['2026-10', '2026-11', '2026-12']), `September left: ${show(seen.near)}`);
      io.fire({ '2026-10': true });
      flushFrames();
      assert(seen.near.length === 2, 'the same months again: no call');
      assert(dayButtons(m, '2026-09').length === 30, 'the month in view\'s neighbours stay drawn');
      assert(dayButtons(m, '2027-05').length === 0, 'a far month stays an empty box');
    } finally {
      m.unmount();
    }
  });

  await check('#16 scrolling: one measure a frame however many scroll events; the month under the bar reported as it changes, the bar following; the Today button while no part of October is on screen, gone when its last row comes back', () => {
    resetPage();
    const { seen, callbacks } = recorder();
    const m = mount(browseIn('en', browseProps(famcalStore(), callbacks)));
    try {
      flushFrames();
      const november = titleUnderBar(m, '2026-11');
      fakeWindow.scrollY = november;
      fireScroll();
      fireScroll();
      fireScroll();
      assert(frames.size === 1, `three scroll events, one frame: ${frames.size}`);
      flushFrames();
      assert(show(seen.inView) === show(['2026-10', '2026-11']) && barText(m) === 'November 2026', `in view: ${show(seen.inView)}, bar ${barText(m)}`);
      assert(todayButton(m) !== null, 'October is all above the bar: Today shows');
      scrollPageTo(november - 10);
      flushFrames();
      assert(todayButton(m) === null && show(seen.inView) === show(['2026-10', '2026-11']), 'October\'s last 10 px are on screen: no Today button, November still in view');
      scrollPageTo(titleUnderBar(m, '2027-06') + 200);
      flushFrames();
      assert(seen.inView.at(-1) === '2027-06' && barText(m) === 'June 2027' && todayButton(m) !== null, `far away: ${show(seen.inView)}`);
      scrollPageTo(0);
      flushFrames();
      assert(seen.inView.at(-1) === '2025-10' && barText(m) === 'October 2025', 'at the top: the window\'s first month');
    } finally {
      m.unmount();
    }
  });

  await check('#17 the Today button (Ruling 6): a smooth scroll that puts October\'s title under the bar; under prefers-reduced-motion an instant one', () => {
    resetPage();
    const m = mount(browseIn('en', browseProps(famcalStore(), { start: { month: '2027-06', peek: false } })));
    try {
      flushFrames();
      const button = todayButton(m);
      assert(button, 'the Today button shows in June 2027');
      scrollCalls.length = 0;
      m.click(button);
      assert(show(scrollCalls) === show([{ top: titleUnderBar(m, '2026-10'), behavior: 'smooth' }]), `smooth: ${show(scrollCalls)}`);
      setMedia(REDUCED, true);
      scrollCalls.length = 0;
      scrollPageTo(titleUnderBar(m, '2027-06'));
      flushFrames();
      m.click(todayButton(m) as FakeElement);
      assert(show(scrollCalls) === show([{ top: titleUnderBar(m, '2026-10'), behavior: 'instant' }]), `reduced motion: ${show(scrollCalls)}`);
    } finally {
      m.unmount();
    }
  });

  await check('#18 a tap on a day calls onPickDay with its day; Retry on a failed or partial pill calls onRetryMonth(month, source); Choose again calls onChooseCalendars', () => {
    resetPage();
    const { seen, callbacks } = recorder();
    const m = mount(browseIn('en', browseProps(famcalStore(), callbacks)));
    try {
      m.click(dayButton(m, '2026-10', 'Tuesday, 20 October'));
      m.click(dayButton(m, '2026-11', 'Sunday, 1 November'));
      assert(show(seen.picked) === show(['2026-10-20', '2026-11-01']), `picked: ${show(seen.picked)}`);
      const retry = (mo: MonthKey) => elements(sectionEl(m, mo)).find((e) => hasClass(e, 'ch-mb-pill-action')) as FakeElement;
      m.click(retry('2026-11'));
      flushFrames();
      FakeIO.all[0].fire({ '2026-12': true });
      flushFrames();
      m.click(retry('2026-12'));
      assert(show(seen.retried) === show(['2026-11:famcal', '2026-12:famcal']), `retried: ${show(seen.retried)}`);
    } finally {
      m.unmount();
    }
    resetPage();
    const google = recorder();
    const g = mount(browseIn('en', browseProps(googleStore(), { ...google.callbacks, start: { month: '2026-11', peek: false } })));
    try {
      const action = (mo: MonthKey) => elements(sectionEl(g, mo)).find((e) => hasClass(e, 'ch-mb-pill-action')) as FakeElement;
      g.click(action('2026-10'));
      g.click(action('2026-11'));
      assert(show(google.seen.retried) === show(['2026-10:google']) && google.seen.chosen === 1, `google: ${show(google.seen)}`);
    } finally {
      g.unmount();
    }
  });

  await check('#19 a narrow screen, (max-width: 360px) (Ruling 3): a day of 3 shows 2 chips and "+1 more", and 3 again once the screen is wide; a day of 4 shows "+2 more" either way', () => {
    resetPage();
    media.set(NARROW, true);
    const m = mount(browseIn('en', browseProps(famcalStore())));
    try {
      const chips = (label: string) => byClass(dayButton(m, '2026-10', label), 'ch-mb-chip').map((c) => c.textContent);
      const more = (label: string) => byClass(dayButton(m, '2026-10', label), 'ch-mb-more').map((c) => c.textContent);
      assert(show([chips('Wednesday, 14 October'), more('Wednesday, 14 October')]) === show([['Gym', 'Call the plumber'], ['+1 more']]), `narrow: ${show([chips('Wednesday, 14 October'), more('Wednesday, 14 October')])}`);
      assert(show(more('Monday, 26 October')) === show(['+2 more']), 'narrow: "+2 more"');
      setMedia(NARROW, false);
      assert(show([chips('Wednesday, 14 October'), more('Wednesday, 14 October')]) === show([['Gym', 'Call the plumber', 'Pilates'], []]), `wide: ${show(chips('Wednesday, 14 October'))}`);
      assert(show(more('Monday, 26 October')) === show(['+2 more']), 'wide: "+2 more"');
    } finally {
      m.unmount();
    }
  });

  await check('#20 re-anchoring: when the window\'s first month moves (2025-10 → 2025-11), the week start changes (0 → 6) or the Hebrew line goes, one instant scroll keeps the month in view where it was under the bar', () => {
    resetPage();
    const store0 = famcalStore();
    // Week start 6, not 1: the twelve months above November have as many rows at 0 as at 1 (62), so 1 would move nothing.
    const store6 = famcalStore({ weekStart: 6 });
    const storeOff = famcalStore({ weekStart: 6, hebrewDates: false });
    const { seen, callbacks } = recorder();
    const base = browseProps(store0, { ...callbacks, start: { month: '2026-11', peek: false } });
    const m = mount(browseIn('en', base));
    try {
      flushFrames();
      scrollPageTo(fakeWindow.scrollY + 100);
      flushFrames();
      assert(seen.inView.at(-1) === '2026-11' && bandTop(m) - topOf(m, '2026-11') === 100, 'November in view, 100 px into it');
      const shifted = monthSpan('2026-11-01');
      const steps: { label: string; props: MonthBrowseProps }[] = [
        { label: 'the first month', props: { ...base, months: shifted } },
        { label: 'the week start', props: { ...base, months: shifted, weekStart: 6, getMonth: monthModels(store6) } },
        { label: 'the Hebrew line', props: { ...base, months: shifted, weekStart: 6, hebrewDates: false, getMonth: monthModels(storeOff) } },
      ];
      for (const step of steps) {
        const before = topOf(m, '2026-11');
        scrollCalls.length = 0;
        m.render(browseIn('en', step.props));
        const moved = topOf(m, '2026-11') - before;
        assert(moved !== 0, `${step.label}: November's offset moved (the check would be empty)`);
        assert(scrollCalls.length === 1 && scrollCalls[0].behavior === 'instant', `${step.label}: one instant scroll: ${show(scrollCalls)}`);
        assert(bandTop(m) - topOf(m, '2026-11') === 100, `${step.label}: November still 100 px under the bar (${bandTop(m) - topOf(m, '2026-11')})`);
        flushFrames();
        assert(seen.inView.at(-1) === '2026-11', `${step.label}: in view ${show(seen.inView)}`);
      }
      scrollCalls.length = 0;
      m.render(browseIn('en', { ...steps[2].props, onPickDay: noop }));
      assert(scrollCalls.length === 0, 'a re-render with the same layout scrolls nothing');
    } finally {
      m.unmount();
    }
  });

  await check('#21 without IntersectionObserver (Ruling 7): the near months are the month in view and its two neighbours, from the scroll measure', () => {
    resetPage();
    fakeWindow.IntersectionObserver = undefined;
    const { seen, callbacks } = recorder();
    const m = mount(browseIn('en', browseProps(famcalStore(), callbacks)));
    try {
      flushFrames();
      assert(show(seen.near) === show([['2026-09', '2026-10', '2026-11']]), `near: ${show(seen.near)}`);
      scrollPageTo(titleUnderBar(m, '2026-12'));
      flushFrames();
      assert(show(seen.near.at(-1)) === show(['2026-11', '2026-12', '2027-01']) && dayButtons(m, '2027-01').length === 31, `after a scroll: ${show(seen.near)}`);
      scrollPageTo(0);
      flushFrames();
      assert(show(seen.near.at(-1)) === show(['2025-10', '2025-11']), `the window's first month has one neighbour: ${show(seen.near.at(-1))}`);
    } finally {
      m.unmount();
      fakeWindow.IntersectionObserver = FakeIO;
    }
  });

  await check('#22 unmount lets go of everything: the scroll and resize listeners, the observer, the media listener and a pending frame', () => {
    resetPage();
    const m = mount(browseIn('en', browseProps(famcalStore())));
    flushFrames();
    assert(show([windowListeners.map((l) => l.type), mediaListeners.get(NARROW)?.size]) === show([['scroll', 'resize'], 1]), `mounted: ${show(windowListeners.map((l) => l.type))}`);
    fireScroll();
    assert(show(frames.size) === show(1), 'a frame is pending');
    m.unmount();
    assert(windowListeners.length === 0, `listeners left: ${show(windowListeners.map((l) => l.type))}`);
    assert(FakeIO.all[0].disconnected, 'the observer is disconnected');
    assert((mediaListeners.get(NARROW)?.size ?? 0) === 0, 'the media listener is gone');
    assert(frames.size === 0, 'the pending frame is cancelled');
  });

  await check('#23 the list moves in the page while scrolled into it (a banner or the unavailable row comes or goes above the Month, the header\'s zone line): one instant scroll by as much keeps January where it was under the bar (iOS has no scroll anchoring); at the page\'s top, nothing scrolls; nothing moved, nothing scrolls', () => {
    resetPage();
    const store = famcalStore();
    const listTop = LAYOUT.listTop;
    const base = browseProps(store, { start: { month: '2027-01', peek: false } });
    const m = mount(browseIn('en', base));
    try {
      flushFrames();
      scrollPageTo(fakeWindow.scrollY + 40);
      flushFrames();
      assert(bandTop(m) - topOf(m, '2027-01') === 40, `January 40 px under the bar: ${bandTop(m) - topOf(m, '2027-01')}`);
      let answered = store;
      for (const [label, delta] of [['the Reconnect banner comes', 62], ['the unavailable row comes', 56], ['both go', -118]] as const) {
        const y = Number(fakeWindow.scrollY);
        scrollCalls.length = 0;
        LAYOUT.listTop += delta;
        answered = reduceStore(answered, ok(answer('2027-01', {})));
        m.render(browseIn('en', { ...base, getMonth: monthModels(answered) })); // a month's answer: the store, and the rows above, changed
        assert(show(scrollCalls) === show([{ top: y + delta, behavior: 'instant' }]), `${label}: ${show(scrollCalls)}`);
        assert(bandTop(m) - topOf(m, '2027-01') === 40, `${label}: January ${bandTop(m) - topOf(m, '2027-01')} px under the bar`);
        flushFrames();
      }
      scrollCalls.length = 0;
      m.render(browseIn('en', { ...base, getMonth: monthModels(answered), onPickDay: noop }));
      assert(scrollCalls.length === 0, `nothing moved: ${show(scrollCalls)}`);
      scrollPageTo(0);
      flushFrames();
      scrollCalls.length = 0;
      LAYOUT.listTop += 62;
      m.render(browseIn('en', { ...base, getMonth: monthModels(answered), onRetryMonth: noop }));
      assert(scrollCalls.length === 0, `at the page's top the banner shows where it comes: ${show(scrollCalls)}`);
    } finally {
      m.unmount();
      LAYOUT.listTop = listTop;
    }
  });

  await check('#24 a sticky region above the bar (E8\'s header and tab bar, --ch-top-h): the bar sticks under it, and the opening scroll, the month in view and the Today button all read the bar where it sticks', () => {
    resetPage();
    const topH = LAYOUT.topH;
    LAYOUT.topH = 126;
    const { seen, callbacks } = recorder();
    const m = mount(browseIn('en', browseProps(famcalStore(), { ...callbacks, start: { month: '2026-12', peek: false } })));
    try {
      assert(show(scrollCalls) === show([{ top: titleUnderBar(m, '2026-12'), behavior: 'instant' }]), `the opening scroll: ${show(scrollCalls)} (want ${titleUnderBar(m, '2026-12')})`);
      flushFrames();
      const bar = byClass(m.container, 'ch-mb-bar')[0].getBoundingClientRect();
      assert(bar.top === LAYOUT.safeTop + 126, `the bar sticks at ${bar.top}`);
      assert(seen.inView.at(-1) === '2026-12' && bandTop(m) === topOf(m, '2026-12'), `in view ${show(seen.inView)}, ${bandTop(m) - topOf(m, '2026-12')} px into December`);
      const today = todayButton(m);
      assert(today !== null, 'the Today button (October is off screen)');
      scrollCalls.length = 0;
      m.click(today);
      assert(show(scrollCalls) === show([{ top: titleUnderBar(m, '2026-10'), behavior: 'smooth' }]), `Today: ${show(scrollCalls)}`);
    } finally {
      m.unmount();
      LAYOUT.topH = topH;
    }
  });

  await check('#25 a narrow screen with three overlapping bars, Alpha 5–7, Beta 6–8 and Gamma 7–9 October (E5\'s limitRow): the 9th shows Gamma, named, not "+1 more" under two empty lines; the 8th Beta and Gamma, both named; wide, the bars keep their lanes, and a bar hidden behind "+2 more" on the 12th is named on the 13th, back in its lane', () => {
    const bar = (id: string, title: string, start: DayKey, end: DayKey) => item(id, { title, start, end, allDay: true, tz: null });
    const days: Record<DayKey, ItemDTO[]> = {};
    for (const it of [
      bar('alpha', 'Alpha', '2026-10-05', '2026-10-08'),
      bar('beta', 'Beta', '2026-10-06', '2026-10-09'),
      bar('gamma', 'Gamma', '2026-10-07', '2026-10-10'),
      bar('delta', 'Delta', '2026-10-12', '2026-10-14'),
      bar('echo', 'Echo', '2026-10-12', '2026-10-14'),
      bar('foxtrot', 'Foxtrot', '2026-10-12', '2026-10-14'),
      timed('lunch', 'Lunch', '2026-10-12', '12:00', '13:00'),
    ]) {
      for (const d of it.allDay ? daysInWindow(it.start, it.end) : ['2026-10-12']) (days[d] ??= []).push(it);
    }
    const store = storeOf([ok(answer('2026-10', days))]);
    resetPage();
    media.set(NARROW, true);
    const m = mount(browseIn('en', browseProps(store)));
    try {
      /** A cell's slots: [title] for a chip or a bar, "_" for an empty line, or the "+N" text. */
      const slots = (label: string) =>
        byClass(dayButton(m, '2026-10', label), 'ch-mb-slot').map((s) => {
          const chip = byClass(s, 'ch-mb-chip')[0];
          const more = byClass(s, 'ch-mb-more')[0];
          return chip ? `[${chip.textContent}]` : more ? more.textContent : '_';
        });
      const week = ['Monday, 5 October', 'Tuesday, 6 October', 'Wednesday, 7 October', 'Thursday, 8 October', 'Friday, 9 October'];
      assert(show(week.map(slots)) === show([['[Alpha]'], ['[]', '[Beta]'], ['[]', '[]', '+1 more'], ['[Beta]', '[Gamma]'], ['[Gamma]']]), `narrow: ${show(week.map(slots))}`);
      setMedia(NARROW, false);
      assert(show(week.map(slots)) === show([['[Alpha]'], ['[]', '[Beta]'], ['[]', '[]', '[Gamma]'], ['_', '[]', '[]'], ['_', '_', '[]']]), `wide: ${show(week.map(slots))}`);
      const next = ['Monday, 12 October', 'Tuesday, 13 October'];
      assert(show(next.map(slots)) === show([['[Delta]', '[Echo]', '+2 more'], ['[]', '[]', '[Foxtrot]']]), `wide, Foxtrot hidden then back: ${show(next.map(slots))}`);
    } finally {
      m.unmount();
    }
  });

  await check('#26 React logged no warning', () => {
    assert(reactWarnings.length === 0, show(reactWarnings));
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
for tz in UTC Asia/Jerusalem; do
  TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-calendar-month-browse.ts; echo "exit $?"
done
```

Expected under each clock (the view doesn't exist yet):

```
Error: Cannot find module '../app/[locale]/dashboard/MonthBrowse'
Require stack:
- …/scripts/smoke-calendar-month-browse.ts
…
exit 1
```

- [ ] **Step 3: Create `app/[locale]/dashboard/MonthBrowse.tsx`**

Create the file with exactly this content:

```tsx
'use client';

// The Month's browse layout (spec §7.4 Browse, §5's month windows, §7.7, §7.8; Rulings
// R11 and R12; Plan E Rulings 3, 4, 6, 7 and 8): the window's months stacked
// vertically, iOS style, under a sticky bar. Presentational: the container (E8's
// MonthView, under CalendarHome) owns the store and the fetches, builds each month's
// model with month.ts (E5) and hands it here through getMonth.
//
// - The sticky bar sits under the safe areas and whatever sticks above it (the
//   container's header and tab bar: --ch-top-h on .ch-home, 0px without it). It shows
//   the month in view with its year, that month's Hebrew months when Hebrew dates are
//   on, a Today button while no part of today's month is on screen, and then the
//   weekday row from the week start.
// - Every month renders at its known height (monthBlockPx), so nothing above the
//   viewport ever changes height: iOS's WKWebView has no scroll anchoring. The months
//   near the viewport draw their grids. The rest show their title and an empty box of
//   the same height.
// - A cell has four parts (Ruling 3): the Gregorian day with the Hebrew day at the
//   head line's end; the Hebrew month's short name under it, on Hebrew day 1 and on the
//   month's first cell; 3 slots of chips and bars, or 2 and "+N" (at most 2 chips on a
//   360 px screen), as month.ts's limitRow fits each week row (a day that overflows
//   moves its bars up, named, and never shows an empty line over "+N"). A loading cell
//   shows a placeholder and a failed one is dimmed, so a day never looks free before it
//   is answered (§5).
// - A month's failure is a pill centred over its dimmed cells, and a partial answer a
//   pill at its top (Ruling 4). Neither changes the month's height.
// - One button per day of the month, whose label reads the whole cell ("Thursday, 15
//   October, 4 Cheshvan, 3 items, 1 from Noa"). The chips, the blank cells and the
//   weekday row are aria-hidden.
// - On mount the start month's title goes just under the bar; with peek, half a week
//   row of the month before shows above it. A passive scroll listener, at most once a
//   frame, reports the month in view. One IntersectionObserver, about a viewport beyond
//   the screen, reports the months near it; without one, near is the month in view and
//   its two neighbours (Ruling 7). When the window's first month, the week start or the
//   Hebrew line changes, or the list moves in the page while scrolled into it (a banner
//   or a row coming or going above the Month, the header's zone line: iOS's WKWebView
//   has no scroll anchoring), the month in view stays where it was on screen.
// - MonthBrowse reads the layout when it mounts, so the container mounts it only while
//   it is displayed.
// - No ancestor of the sticky bar clips with overflow: hidden (the root clips with
//   overflow-x: clip); logical properties only; nothing under 11 px; taps at least
//   44 px; no hover styles.

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { formatDayLong, formatMonthTitle, formatWeekdayHeader } from '@/src/lib/calendar-view/format';
import { monthFirstDay, monthGrid, monthOf, weekdayOrder, type MonthKey } from '@/src/lib/calendar-view/grid';
import { hebrewCellLabel, hebrewCellMonth, hebrewDayLabel, hebrewMonthHeader, isHebrewMonthStart } from '@/src/lib/calendar-view/hebrew-date';
import {
  BROWSE_CELL_PX,
  BROWSE_CHIPS_NARROW,
  BROWSE_SLOTS,
  NARROW_MAX_PX,
  limitRow,
  monthBarPx,
  monthBlockPx,
  monthOffsets,
  monthTitlePx,
  monthsInViewport,
  type MonthCell,
  type MonthModel,
  type MonthNotice,
  type MonthSlot,
} from '@/src/lib/calendar-view/month';
import type { DayKey, SourceName, WeekStart } from '@/src/lib/calendar-view/types';

export interface MonthBrowseProps {
  /** The window, oldest first: monthSpan(today), 12 months back to 18 ahead. */
  months: readonly MonthKey[];
  today: DayKey;
  weekStart: WeekStart;
  hebrewDates: boolean;
  /** monthModels(store): a month's model, or null (its cells then read as loading). */
  getMonth: (month: MonthKey) => MonthModel | null;
  /** Read on mount: that month's title under the sticky bar; peek adds half a week row of the month before (the opening position). */
  start: { month: MonthKey; peek: boolean };
  /** The months within about a viewport of the screen (IntersectionObserver), oldest first; coalesced, and only when they change. */
  onNearMonths: (months: MonthKey[]) => void;
  /** The month under the sticky bar, as the user scrolls; only when it changes. */
  onMonthInView: (month: MonthKey) => void;
  /** A tap on a day: the container opens picked on it. */
  onPickDay: (day: DayKey) => void;
  /** Retry on a month's failed or partial pill. */
  onRetryMonth: (month: MonthKey, source: SourceName) => void;
  /** "Choose again" on a calendars-gone pill: the existing select-calendars page. */
  onChooseCalendars: () => void;
}

/**
 * Half a week row. The opening position shows this much of the month before above the
 * start month's title, and the month in view is read this far below the bar, so the
 * opening position reads as the start month.
 */
const PEEK_PX = BROWSE_CELL_PX / 2;
/** About one viewport above and below the screen: the months that count as near (Ruling 7). */
const NEAR_MARGIN = '100% 0px';
const NARROW_QUERY = `(max-width: ${NARROW_MAX_PX}px)`;
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** A media query's list, or null where there is no window or no matchMedia. */
function mediaList(query: string): MediaQueryList | null {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query) : null;
  } catch {
    return null;
  }
}

function subscribeNarrow(onChange: () => void): () => void {
  const list = mediaList(NARROW_QUERY);
  if (!list) return () => {};
  try {
    if (typeof list.addEventListener === 'function') {
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    }
    // Safari before 14 has only the older pair.
    list.addListener(onChange);
    return () => list.removeListener(onChange);
  } catch {
    return () => {};
  }
}
const isNarrow = () => mediaList(NARROW_QUERY)?.matches === true;
const notNarrow = () => false;
const reducedMotion = () => mediaList(REDUCED_MOTION_QUERY)?.matches === true;

/** Runs `run` on the next frame (a timer where there is no requestAnimationFrame); returns its cancel. */
function nextFrame(run: () => void): () => void {
  if (typeof window.requestAnimationFrame === 'function') {
    const id = window.requestAnimationFrame(run);
    return () => window.cancelAnimationFrame(id);
  }
  const id = window.setTimeout(run, 16);
  return () => window.clearTimeout(id);
}

type Motion = 'instant' | 'smooth';

/** Scrolls the document (spec §7.1: no inner scroller). A browser that rejects the options object gets the plain form. */
function scrollPage(top: number, behavior: Motion) {
  const y = Math.max(0, Math.round(top));
  try {
    window.scrollTo({ top: y, behavior });
  } catch {
    try {
      window.scrollTo(0, y);
    } catch {
      // The page stays where it is.
    }
  }
}

/**
 * The document offset that puts `title` just under the sticky bar, as its
 * scroll-margin-top says (the safe areas plus the bar), less `peek`. Without a
 * scroll-margin-top to read, the bar's own height stands in.
 */
function titleScrollTop(title: HTMLElement, fallbackMargin: number, peek: number): number {
  let margin = Number.NaN;
  try {
    margin = parseFloat(window.getComputedStyle(title).scrollMarginTop);
  } catch {
    // Read below.
  }
  if (!Number.isFinite(margin) || margin <= 0) margin = fallbackMargin;
  return window.scrollY + title.getBoundingClientRect().top - margin - peek;
}

function viewportHeight(): number {
  return window.innerHeight || document.documentElement?.clientHeight || 0;
}

/** The month at `index` and its two neighbours, inside the window. */
function around(months: readonly MonthKey[], index: number): MonthKey[] {
  return index < 0 ? [] : months.slice(Math.max(0, index - 1), index + 2);
}

/** Where the window opens: the start month, else today's month, else the first. */
function startIndexOf(months: readonly MonthKey[], month: MonthKey, today: DayKey): number {
  const at = months.indexOf(month);
  if (at >= 0) return at;
  const todays = months.indexOf(monthOf(today));
  return todays >= 0 ? todays : 0;
}

function blockPx(month: MonthKey, weekStart: WeekStart, hebrewDates: boolean): number {
  return monthBlockPx(monthGrid(month, weekStart).length, hebrewDates);
}

/** A month with no model yet: its own days loading, the rest blank (R12). */
function loadingWeeks(month: MonthKey, weekStart: WeekStart, today: DayKey): MonthCell[][] {
  const first = monthFirstDay(month);
  return monthGrid(month, weekStart).map((row) =>
    row.map((day): MonthCell => {
      const inMonth = monthOf(day) === month;
      return {
        day,
        inMonth,
        today: inMonth && day === today,
        status: inMonth ? 'loading' : 'answered',
        slots: [],
        dots: [],
        count: 0,
        fromPartner: 0,
        hebrewMonthStart: inMonth && (day === first || isHebrewMonthStart(day)),
      };
    }),
  );
}

/** One chip or bar, a spacer's empty line, coloured by whose it is (E4's tokens). */
function Slot({ slot, noTitle }: { slot: MonthSlot; noTitle: string }) {
  if (slot.kind === 'spacer') return <span className="ch-mb-slot" />;
  const look = slot.kind === 'timed' ? (slot.mine ? 'is-mine-timed' : 'is-partner-timed') : slot.mine ? 'is-mine-solid' : 'is-partner-solid';
  const className = [
    'ch-mb-chip',
    `is-${slot.kind}`,
    look,
    slot.continuesBefore ? 'is-before' : '',
    slot.continuesAfter ? 'is-after' : '',
    slot.done ? 'is-done' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const title = slot.showTitle ? (slot.title && slot.title.trim() !== '' ? slot.title : noTitle) : '';
  return (
    <span className="ch-mb-slot">
      <span className={className} dir="auto">
        {title}
      </span>
    </span>
  );
}

interface CellProps {
  cell: MonthCell;
  partner: string | null;
  hebrewDates: boolean;
  /** The slots the cell shows and the items left for "+N" (limitRow). */
  shown: readonly MonthSlot[];
  more: number;
  /** calendarHome.hebrewMonthGenitive, Russian only (the label's Hebrew day, Ruling R9). */
  genitive: readonly string[] | undefined;
  /** calendarHome.hebrewMonthShort (the cell's Hebrew month line). */
  shortMonths: readonly string[] | undefined;
  noTitle: string;
  onPickDay: (day: DayKey) => void;
}

function Cell({ cell, partner, hebrewDates, shown, more, genitive, shortMonths, noTitle, onPickDay }: CellProps) {
  const t = useTranslations('calendarHome');
  const locale = useLocale();
  if (!cell.inMonth) return <div className="ch-mb-cell is-blank" aria-hidden="true" />;

  // A day still loading never looks free: a placeholder in the next free slot.
  const placeholder = cell.status === 'loading' && more === 0 && shown.length < BROWSE_SLOTS;
  const hebrewDay = hebrewDates ? hebrewCellLabel(cell.day, locale, false) : '';
  const hebrewMonth = hebrewDates && cell.hebrewMonthStart ? hebrewCellMonth(cell.day, locale, shortMonths) : '';

  const parts = [formatDayLong(cell.day, locale)];
  if (hebrewDates) {
    const full = hebrewDayLabel(cell.day, locale, genitive);
    if (full) parts.push(full);
  }
  if (cell.count > 0) {
    parts.push(t('month.cellItems', { count: cell.count }));
    if (cell.fromPartner > 0 && partner) parts.push(t('month.cellFromPartner', { count: cell.fromPartner, name: partner }));
  }
  if (cell.status === 'loading') parts.push(t('month.cellLoading'));
  else if (cell.status === 'failed') parts.push(t('month.cellFailed'));
  else if (cell.count === 0) parts.push(t('month.cellNothing'));

  const className = ['ch-mb-cell', cell.today ? 'is-today' : '', cell.status === 'loading' ? 'is-loading' : '', cell.status === 'failed' ? 'is-failed' : '']
    .filter(Boolean)
    .join(' ');
  return (
    <button type="button" className={className} aria-label={parts.join(', ')} aria-current={cell.today ? 'date' : undefined} onClick={() => onPickDay(cell.day)}>
      <span className="ch-mb-head" aria-hidden="true">
        <span className="ch-mb-day" dir="ltr">
          {Number(cell.day.slice(8, 10))}
        </span>
        {hebrewDay ? <span className="ch-mb-hday">{hebrewDay}</span> : null}
      </span>
      <span className="ch-mb-hmonth" aria-hidden="true">
        {hebrewMonth}
      </span>
      <span className="ch-mb-slots" aria-hidden="true">
        {shown.map((slot, i) => (
          <Slot key={i} slot={slot} noTitle={noTitle} />
        ))}
        {more > 0 ? (
          <span className="ch-mb-slot">
            <span className="ch-mb-more">{t('month.more', { count: more })}</span>
          </span>
        ) : null}
        {placeholder ? (
          <span className="ch-mb-slot">
            <span className="ch-mb-ghost" />
          </span>
        ) : null}
      </span>
    </button>
  );
}

/** A month's notice (Ruling 4): busy, calendars gone or an error, or a partial answer. */
function NoticePill({ notice, month, onRetryMonth, onChooseCalendars }: { notice: MonthNotice; month: MonthKey; onRetryMonth: MonthBrowseProps['onRetryMonth']; onChooseCalendars: () => void }) {
  const t = useTranslations('calendarHome');
  const gone = notice.kind === 'failed' && notice.failure?.kind === 'calendarsGone';
  const text =
    notice.kind === 'partial' ? t('state.partial') : gone ? t('state.calendarsGone') : notice.failure?.kind === 'busy' ? t('state.busy') : t('month.failed');
  return (
    <div className="ch-mb-pill">
      <span className="ch-mb-pill-text">{text}</span>
      <button type="button" className="ch-btn ch-mb-pill-action" onClick={gone ? onChooseCalendars : () => onRetryMonth(month, notice.source)}>
        {gone ? t('actions.chooseAgain') : t('actions.retry')}
      </button>
    </div>
  );
}

interface MonthGridProps {
  month: MonthKey;
  model: MonthModel | null;
  weekStart: WeekStart;
  today: DayKey;
  hebrewDates: boolean;
  narrow: boolean;
  onPickDay: (day: DayKey) => void;
  onRetryMonth: MonthBrowseProps['onRetryMonth'];
  onChooseCalendars: () => void;
}

/** A near month's grid and its notices. Memoized: a scroll that changes only the bar leaves it alone. */
const MonthGrid = memo(function MonthGrid({ month, model, weekStart, today, hebrewDates, narrow, onPickDay, onRetryMonth, onChooseCalendars }: MonthGridProps) {
  const t = useTranslations('calendarHome');
  const locale = useLocale();
  // A model drawn from another week start (a store not yet dropped after the facts
  // changed) would not fit this month's block: until the new one comes, it reads as loading.
  const fits = model !== null && model.weeks[0]?.[0]?.day === monthGrid(month, weekStart)[0]?.[0];
  const weeks = model && fits ? model.weeks : loadingWeeks(month, weekStart, today);
  const genitive = hebrewDates && locale === 'ru' ? (t.raw('hebrewMonthGenitive') as string[]) : undefined;
  const shortMonths = hebrewDates ? (t.raw('hebrewMonthShort') as string[]) : undefined;
  const noTitle = t('row.noTitle');
  const notices = model && fits ? model.notices : [];
  const failed = notices.filter((n) => n.kind === 'failed');
  const partial = notices.filter((n) => n.kind === 'partial');
  const maxChips = narrow ? BROWSE_CHIPS_NARROW : BROWSE_SLOTS;
  return (
    <div className="ch-mb-body" style={{ blockSize: weeks.length * BROWSE_CELL_PX }}>
      {partial.length > 0 ? (
        <div className="ch-mb-overlay is-top">
          {partial.map((n) => (
            <NoticePill key={`partial-${n.source}`} notice={n} month={month} onRetryMonth={onRetryMonth} onChooseCalendars={onChooseCalendars} />
          ))}
        </div>
      ) : null}
      {failed.length > 0 ? (
        <div className="ch-mb-overlay is-centre">
          {failed.map((n) => (
            <NoticePill key={`failed-${n.source}`} notice={n} month={month} onRetryMonth={onRetryMonth} onChooseCalendars={onChooseCalendars} />
          ))}
        </div>
      ) : null}
      <div className="ch-mb-grid">
        {weeks.map((row) => {
          const limited = limitRow(row, maxChips);
          return (
            <div key={row[0]?.day ?? ''} className="ch-mb-row">
              {row.map((cell, col) => (
                <Cell
                  key={cell.day}
                  cell={cell}
                  partner={model && fits ? model.partner : null}
                  hebrewDates={hebrewDates}
                  shown={limited[col].shown}
                  more={limited[col].more}
                  genitive={genitive}
                  shortMonths={shortMonths}
                  noTitle={noTitle}
                  onPickDay={onPickDay}
                />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
});

export function MonthBrowse(props: MonthBrowseProps) {
  const { months, today, weekStart, hebrewDates, getMonth } = props;
  const t = useTranslations('calendarHome');
  const locale = useLocale();
  const narrow = useSyncExternalStore(subscribeNarrow, isNarrow, notNarrow);
  const offsets = useMemo(() => monthOffsets(months, weekStart, hebrewDates), [months, weekStart, hebrewDates]);
  // Each month's rows, title and Hebrew range, once per window, week start, language and
  // Hebrew line: not again on every report of the month in view or the near months.
  const thisYear = today.slice(0, 4);
  const heads = useMemo(
    () =>
      months.map((month) => ({
        month,
        rows: monthGrid(month, weekStart).length,
        title: formatMonthTitle(month, locale, month.slice(0, 4) !== thisYear),
        hebrew: hebrewDates ? hebrewMonthHeader(month, locale) : '',
      })),
    [months, weekStart, locale, hebrewDates, thisYear],
  );

  // The opening position, read once: `start` is only for the mount.
  const [opening] = useState(() => {
    const index = startIndexOf(months, props.start.month, today);
    return { month: months[index] ?? '', peek: props.start.peek, index };
  });
  /** The months whose grids render, beyond the month in view and its neighbours. */
  const [near, setNear] = useState<readonly MonthKey[]>(() => around(months, opening.index));
  const [inView, setInView] = useState<MonthKey>(opening.month);
  const [showToday, setShowToday] = useState(() => monthOf(today) !== opening.month);

  const listRef = useRef<HTMLDivElement | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const titles = useRef(new Map<MonthKey, HTMLElement>());
  const sections = useRef(new Map<MonthKey, HTMLElement>());
  /** The month in view at the last measure, and how far the bar's bottom was below its top. */
  const anchor = useRef<{ month: MonthKey; delta: number } | null>(null);
  const reported = useRef<{ inView: MonthKey | null; near: string | null }>({ inView: null, near: null });
  /** Whether an IntersectionObserver reports the near months (else the scroll measure does). */
  const observing = useRef(false);
  const cancelFrame = useRef<(() => void) | null>(null);
  // The latest props and offsets, for the listeners and callbacks (synced before any other effect reads them).
  const live = useRef({ props, offsets });
  useLayoutEffect(() => {
    live.current = { props, offsets };
  });

  const reportNear = useCallback((list: MonthKey[]) => {
    const key = list.join(',');
    if (reported.current.near === key) return;
    reported.current.near = key;
    setNear(list);
    live.current.props.onNearMonths(list);
  }, []);

  /** Reads where the page is: the month in view, the Today button, and the near months without an observer. */
  const measure = useCallback(() => {
    const list = listRef.current;
    const bar = barRef.current;
    const { props: p, offsets: tops } = live.current;
    if (!list || !bar || p.months.length === 0) return;
    const listTop = list.getBoundingClientRect().top;
    const top = bar.getBoundingClientRect().bottom - listTop;
    const bottom = viewportHeight() - listTop;
    const { first } = monthsInViewport(tops, top + PEEK_PX, bottom);
    const month = p.months[first];
    anchor.current = { month, delta: top - tops[first] };
    setInView(month);
    if (reported.current.inView !== month) {
      reported.current.inView = month;
      p.onMonthInView(month);
    }
    const at = p.months.indexOf(monthOf(p.today));
    const end = at >= 0 ? tops[at] + blockPx(p.months[at], p.weekStart, p.hebrewDates) : 0;
    setShowToday(at >= 0 && !(tops[at] < bottom && end > top));
    if (!observing.current) reportNear(around(p.months, first));
  }, [reportNear]);

  /** One measure per frame, however many scroll events come. */
  const requestMeasure = useCallback(() => {
    if (cancelFrame.current) return;
    cancelFrame.current = nextFrame(() => {
      cancelFrame.current = null;
      measure();
    });
  }, [measure]);

  // The opening position: the start month's title under the bar, with the peek.
  useLayoutEffect(() => {
    const title = titles.current.get(opening.month);
    if (title) scrollPage(titleScrollTop(title, monthBarPx(live.current.props.hebrewDates), opening.peek ? PEEK_PX : 0), 'instant');
  }, [opening]);

  // The window's first month, the week start or the Hebrew line changed (every offset
  // moved), or the list moved in the page (a banner or a row came or went above the
  // Month, the header's zone line; iOS's WKWebView has no scroll anchoring to make up
  // for it): the month in view is put back where it was under the bar. At the page's
  // top the bar sits on the list (nothing is under it), so nothing scrolls then: a row
  // above shows where it comes.
  const layoutKey = `${months[0] ?? ''}|${weekStart}|${hebrewDates ? 1 : 0}`;
  const laidOut = useRef<{ key: string; listTop: number | null }>({ key: layoutKey, listTop: null });
  useLayoutEffect(() => {
    const list = listRef.current;
    const bar = barRef.current;
    if (!list || !bar) return;
    const listTop = window.scrollY + list.getBoundingClientRect().top;
    const last = laidOut.current;
    laidOut.current = { key: layoutKey, listTop };
    const relaid = last.key !== layoutKey;
    const moved = last.listTop !== null && Math.abs(listTop - last.listTop) >= 1;
    if (!relaid && !moved) return;
    const was = anchor.current;
    const { props: p, offsets: tops } = live.current;
    if (was && p.months.length > 0) {
      let at = p.months.indexOf(was.month);
      if (at < 0) at = was.month < p.months[0] ? 0 : p.months.length - 1;
      const block = blockPx(p.months[at], p.weekStart, p.hebrewDates);
      const want = tops[at] + Math.min(Math.max(was.delta, -PEEK_PX), block - 1);
      const now = bar.getBoundingClientRect().bottom - list.getBoundingClientRect().top;
      if (Math.abs(want - now) >= 1) scrollPage(window.scrollY + want - now, 'instant');
    }
    requestMeasure();
  });

  // The scroll listener: passive, one measure a frame. The first measure follows the opening scroll.
  useEffect(() => {
    const options: AddEventListenerOptions = { passive: true };
    window.addEventListener('scroll', requestMeasure, options);
    window.addEventListener('resize', requestMeasure, options);
    requestMeasure();
    return () => {
      window.removeEventListener('scroll', requestMeasure, options);
      window.removeEventListener('resize', requestMeasure, options);
      cancelFrame.current?.();
      cancelFrame.current = null;
    };
  }, [requestMeasure]);

  // The near months: one observer on every month, about a viewport beyond the screen,
  // its reports gathered into one call a frame.
  const monthsKey = months.join(',');
  useEffect(() => {
    const Observer = typeof window.IntersectionObserver === 'function' ? window.IntersectionObserver : null;
    if (!Observer) return;
    const intersecting = new Map<MonthKey, boolean>();
    let cancel: (() => void) | null = null;
    const flush = () => {
      cancel = null;
      reportNear(live.current.props.months.filter((m) => intersecting.get(m) === true));
    };
    let observer: IntersectionObserver;
    try {
      observer = new Observer(
        (entries) => {
          for (const entry of entries) {
            const month = entry.target.getAttribute('data-month');
            if (month) intersecting.set(month, entry.isIntersecting);
          }
          if (!cancel) cancel = nextFrame(flush);
        },
        { rootMargin: NEAR_MARGIN },
      );
    } catch {
      return;
    }
    observing.current = true;
    for (const el of sections.current.values()) observer.observe(el);
    return () => {
      observing.current = false;
      observer.disconnect();
      cancel?.();
    };
  }, [monthsKey, reportNear]);

  const goToday = useCallback(() => {
    const p = live.current.props;
    const title = titles.current.get(monthOf(p.today));
    if (title) scrollPage(titleScrollTop(title, monthBarPx(p.hebrewDates), 0), reducedMotion() ? 'instant' : 'smooth');
  }, []);
  const pickDay = useCallback((day: DayKey) => live.current.props.onPickDay(day), []);
  const retryMonth = useCallback((month: MonthKey, source: SourceName) => live.current.props.onRetryMonth(month, source), []);
  const chooseCalendars = useCallback(() => live.current.props.onChooseCalendars(), []);

  const at = months.indexOf(inView);
  const drawn = new Set<MonthKey>([...near, ...around(months, at)]);
  const rootStyle = {
    '--ch-mb-bar': `${monthBarPx(hebrewDates)}px`,
    '--ch-mb-title': `${monthTitlePx(hebrewDates)}px`,
    '--ch-mb-cell': `${BROWSE_CELL_PX}px`,
  } as CSSProperties;

  return (
    <section className="ch-mb" dir={locale === 'he' ? 'rtl' : 'ltr'} style={rootStyle}>
      <style>{MONTH_BROWSE_CSS}</style>
      <div className="ch-mb-bar" ref={barRef}>
        <div className="ch-mb-bar-row">
          <p className="ch-mb-bar-text" aria-hidden="true">
            <span className="ch-mb-bar-month">{formatMonthTitle(inView, locale, true)}</span>
            {hebrewDates ? <span className="ch-mb-bar-hebrew">{hebrewMonthHeader(inView, locale)}</span> : null}
          </p>
          {showToday ? (
            <button type="button" className="ch-mb-today" onClick={goToday}>
              {t('month.today')}
            </button>
          ) : null}
        </div>
        <div className="ch-mb-weekdays" aria-hidden="true">
          {weekdayOrder(weekStart).map((weekday) => (
            <span key={weekday} className="ch-mb-weekday">
              {formatWeekdayHeader(weekday, locale)}
            </span>
          ))}
        </div>
      </div>
      <div className="ch-mb-months" ref={listRef}>
        {heads.map(({ month, rows, title, hebrew }) => (
          <div
            key={month}
            className="ch-mb-month"
            data-month={month}
            style={{ blockSize: monthBlockPx(rows, hebrewDates) }}
            ref={(el) => {
              if (el) sections.current.set(month, el);
              else sections.current.delete(month);
            }}
          >
            <h2
              className="ch-mb-title"
              ref={(el) => {
                if (el) titles.current.set(month, el);
                else titles.current.delete(month);
              }}
            >
              <span className="ch-mb-title-month">{title}</span>
              {hebrewDates ? (
                <>
                  <span className="ch-visually-hidden">, </span>
                  <span className="ch-mb-title-hebrew">{hebrew}</span>
                </>
              ) : null}
            </h2>
            {drawn.has(month) ? (
              <MonthGrid
                month={month}
                model={getMonth(month)}
                weekStart={weekStart}
                today={today}
                hebrewDates={hebrewDates}
                narrow={narrow}
                onPickDay={pickDay}
                onRetryMonth={retryMonth}
                onChooseCalendars={chooseCalendars}
              />
            ) : (
              <div className="ch-mb-body ch-mb-far" style={{ blockSize: rows * BROWSE_CELL_PX }} aria-hidden="true" />
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * The browse's styles. They read the tokens HOME_THEME_CSS (./home-theme.ts) puts on
 * .ch-home, D's and E4's, the three heights MonthBrowse sets on its root from
 * month.ts: --ch-mb-bar (monthBarPx), --ch-mb-title (monthTitlePx) and --ch-mb-cell
 * (BROWSE_CELL_PX), and --ch-top-h, the height of what sticks above the bar (the
 * container's header and tab bar; 0px without it). The fixed parts add up to them: the bar is its row and the 24 px
 * weekday row; a title is 14 px + 22 px (+ 16 px with the Hebrew line) + 6 px; a cell
 * is its 1 px rule, 3 px, the 18 px head, the 13 px Hebrew month line and three 18 px
 * slots, within 92 px. overflow: hidden only on text leaves (the ellipsis); the root
 * clips with overflow-x: clip, which keeps the bar sticky.
 */
export const MONTH_BROWSE_CSS = `
.ch-mb {
  padding-block-end: calc(24px + max(env(safe-area-inset-bottom, 0px), var(--tg-safe-area-inset-bottom, 0px)));
  overflow-x: clip;
}
.ch-mb-bar {
  position: sticky;
  top: calc(var(--tg-safe-area-inset-top, 0px) + var(--tg-content-safe-area-inset-top, 0px) + var(--ch-top-h, 0px));
  z-index: 3;
  display: flex;
  flex-direction: column;
  block-size: var(--ch-mb-bar);
  background: var(--ch-bg);
}
.ch-mb-bar-row {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 0;
  padding-inline: 16px;
}
.ch-mb-bar-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
  margin: 0;
}
.ch-mb-bar-month {
  font-size: 17px;
  font-weight: 600;
  line-height: 22px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ch-mb-bar-hebrew {
  font-size: 13px;
  line-height: 16px;
  color: var(--ch-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ch-mb-today {
  flex: none;
  min-width: 44px;
  min-height: 44px;
  margin: 0;
  padding-block: 0;
  padding-inline: 16px;
  border: 1px solid var(--ch-pill-line);
  border-radius: 22px;
  background: var(--ch-pill-bg);
  color: var(--ch-pill-text);
  font-family: inherit;
  font-size: 14px;
  font-weight: 500;
  line-height: 1.2;
  cursor: pointer;
  touch-action: manipulation;
}
.ch-mb-today:focus-visible {
  outline: 2px solid var(--ch-accent);
  outline-offset: 2px;
}
.ch-mb-cell:focus-visible {
  outline: 2px solid var(--ch-accent);
  outline-offset: -2px;
}
.ch-mb-weekdays {
  display: grid;
  flex: none;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  block-size: 24px;
  padding-inline: 6px;
  border-block-end: 1px solid var(--ch-separator);
  font-size: 12px;
  line-height: 23px;
  color: var(--ch-muted);
  text-align: center;
}
.ch-mb-month {
  display: flex;
  flex-direction: column;
}
.ch-mb-title {
  flex: none;
  block-size: var(--ch-mb-title);
  margin: 0;
  padding-block: 14px 6px;
  padding-inline: 16px;
  scroll-margin-top: calc(var(--tg-safe-area-inset-top, 0px) + var(--tg-content-safe-area-inset-top, 0px) + var(--ch-top-h, 0px) + var(--ch-mb-bar));
  color: var(--ch-month-title);
  font-size: 15px;
  font-weight: 600;
}
.ch-mb-title-month {
  display: block;
  line-height: 22px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ch-mb-title-hebrew {
  display: block;
  font-size: 12px;
  font-weight: 400;
  line-height: 16px;
  color: var(--ch-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ch-mb-body {
  position: relative;
  flex: none;
}
.ch-mb-grid {
  margin-inline: 6px;
}
.ch-mb-row {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  block-size: var(--ch-mb-cell);
}
.ch-mb-cell {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  min-width: 0;
  block-size: var(--ch-mb-cell);
  margin: 0;
  padding-block: 3px 0;
  padding-inline: 2px;
  border: 0;
  border-block-start: 1px solid var(--ch-separator);
  background: transparent;
  color: inherit;
  font-family: inherit;
  text-align: start;
  cursor: pointer;
  touch-action: manipulation;
}
.ch-mb-cell.is-blank {
  border-block-start-color: transparent;
  cursor: default;
}
button.ch-mb-cell:active {
  background: var(--ch-surface);
}
.ch-mb-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 2px;
  block-size: 18px;
  padding-inline: 2px;
}
.ch-mb-day {
  min-inline-size: 18px;
  font-size: 13px;
  font-weight: 500;
  line-height: 18px;
  text-align: center;
}
.ch-mb-cell.is-today .ch-mb-day {
  padding-inline: 4px;
  border-radius: 9px;
  background: var(--ch-today);
  color: var(--ch-today-text);
  font-weight: 600;
}
.ch-mb-hday {
  font-size: 11px;
  line-height: 18px;
  color: var(--ch-muted);
  white-space: nowrap;
}
.ch-mb-hmonth {
  display: block;
  block-size: 13px;
  padding-inline: 2px;
  font-size: 11px;
  line-height: 13px;
  color: var(--ch-muted);
  text-align: end;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ch-mb-slots {
  display: block;
}
.ch-mb-slot {
  display: block;
  block-size: 18px;
  padding-block-start: 2px;
}
.ch-mb-chip {
  display: block;
  block-size: 16px;
  padding-inline: 3px;
  border: 1px solid transparent;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 500;
  line-height: 14px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ch-mb-chip.is-mine-timed {
  background: var(--ch-mine-soft);
  color: var(--ch-mine-soft-text);
}
.ch-mb-chip.is-mine-solid {
  background: var(--ch-mine-solid);
  color: var(--ch-mine-solid-text);
}
.ch-mb-chip.is-partner-timed {
  border-color: var(--ch-partner-line);
  background: var(--ch-bg);
  color: var(--ch-partner-line-text);
}
.ch-mb-chip.is-partner-solid {
  border-color: var(--ch-partner-line);
  background: var(--ch-partner-soft);
  color: var(--ch-partner-soft-text);
}
.ch-mb-chip.is-before {
  margin-inline-start: -2px;
  border-inline-start-width: 0;
  border-start-start-radius: 0;
  border-end-start-radius: 0;
}
.ch-mb-chip.is-after {
  margin-inline-end: -2px;
  border-inline-end-width: 0;
  border-start-end-radius: 0;
  border-end-end-radius: 0;
}
.ch-mb-chip.is-done {
  text-decoration: line-through;
}
.ch-mb-more {
  display: block;
  padding-inline: 3px;
  font-size: 11px;
  line-height: 16px;
  color: var(--ch-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ch-mb-ghost {
  display: block;
  block-size: 12px;
  margin-block-start: 2px;
  border-radius: 4px;
  background: var(--ch-surface);
  animation: ch-mb-pulse 1.4s ease-in-out infinite;
}
.ch-mb-cell.is-failed {
  background: var(--ch-surface);
}
.ch-mb-cell.is-failed .ch-mb-day {
  color: var(--ch-muted);
}
.ch-mb-cell.is-failed .ch-mb-hmonth,
.ch-mb-cell.is-failed .ch-mb-slots {
  opacity: 0.5;
}
.ch-mb-overlay {
  position: absolute;
  inset: 0;
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding-block: 8px;
  padding-inline: 16px;
  pointer-events: none;
}
.ch-mb-overlay.is-centre {
  justify-content: center;
}
.ch-mb-pill {
  display: flex;
  align-items: center;
  gap: 4px;
  max-inline-size: 100%;
  min-height: 44px;
  padding-inline: 14px 0;
  border: 1px solid var(--ch-outline);
  border-radius: 22px;
  background: var(--ch-section);
  color: var(--ch-text);
  box-shadow: 0 2px 8px rgba(18, 18, 32, 0.12);
  font-size: 14px;
  line-height: 1.3;
  pointer-events: auto;
}
.ch-mb-pill-text {
  min-width: 0;
  padding-block: 6px;
}
.ch-mb-pill-action {
  flex: none;
  border-radius: 22px;
  background: transparent;
}
@keyframes ch-mb-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.55; }
}
@media (prefers-reduced-motion: reduce) {
  .ch-mb-ghost {
    animation: none;
  }
}
`;
```

- [ ] **Step 4: Run the smoke under both clocks**

```bash
for tz in UTC Asia/Jerusalem; do
  TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-calendar-month-browse.ts; echo "exit $?"
done
```

Expected under each clock:

```
OK  #1 the view is client-safe: MonthBrowse loads no server module (DB, Redis, services, date-fns-tz, @hebcal/core), no home-client and no Telegram code; it reads month.ts, grid.ts, hebrew-date.ts and format.ts
OK  #2 en: the sticky bar names the month in view with its year and Hebrew months; the titles follow Ruling 8 (the year only off today's year) with each month's Hebrew range; dir="ltr"
OK  #3 en cells: the labels ("Thursday, 15 October, 4 Cheshvan, 3 items, 1 from Noa"), aria-current on today only, the head line's Hebrew day and the month line on Hebrew day 1 and the first cell (Ruling 3)
OK  #4 en chips: whose (E4: mine filled, the partner's outlined), done struck through, the daily reminder left out (R11), the Eilat bar's shapes with its title on its first day, "+2 more" in the third slot, dir="auto"
OK  #5 he: dir="rtl"; the bar, the titles and the Hebrew ranges in Hebrew with gematriya years; the labels in Hebrew; the Hebrew day in gematriya and the month line
OK  #6 ru: the titles in the capitalised nominative without "г." (Ruling 8), the Hebrew ranges in the nominative and the labels in the genitive (R9), "Noa: 1", the month line
OK  #7 the weekday row in week-start order (Ruling 8) for week starts 0, 1 and 6 in en, he and ru, aria-hidden; each month's first row starts on the week start
OK  #8 no free-looking cell while a month loads or failed (§5): September loading shows placeholders, a model-less month too; November busy and December's error are dimmed under a centred pill with Retry; none reads "nothing planned"
OK  #9 a Google user (Ruling 4): calendars gone is a centred pill with Choose again; partial is a pill at the top over live cells; a reconnect dims the cells with no pill (the banner says it)
OK  #10 with Hebrew dates off: no Hebrew line in the bar, the titles or the cells, and the shorter heights (bar 72, title 42)
OK  #11 the block sizes: every month at monthBlockPx(rows, hebrewDates), near or far, for 4-, 5- and 6-row months; a body is rows × 92; a far month is its title and an empty aria-hidden box; a model from another week start draws as loading at the new height
OK  #12 the CSS: nothing under 11 px; the 44 px Today button and pill; logical properties only; the sticky top under both safe areas and what sticks above the bar (--ch-top-h); overflow-x: clip on the root and overflow: hidden only on text leaves; no transform or filter; the reduced-motion rule; no hover; the heights add up; E4's tokens only
OK  #13 in real React, the opening position: one instant scroll puts October's title under the bar with half a week row of September above it; Sep–Nov draw before any observer fires; then the month in view is October, with no Today button; one observer, rootMargin "100% 0px", on all 31 months; passive listeners
OK  #14 the opening without peek (start December): December's title just under the bar, the month in view December, and the Today button shown (October is off screen)
OK  #15 the near months: the observer's reports gathered into one onNearMonths a frame, oldest first, only when they change; a month that comes near draws its grid
OK  #16 scrolling: one measure a frame however many scroll events; the month under the bar reported as it changes, the bar following; the Today button while no part of October is on screen, gone when its last row comes back
OK  #17 the Today button (Ruling 6): a smooth scroll that puts October's title under the bar; under prefers-reduced-motion an instant one
OK  #18 a tap on a day calls onPickDay with its day; Retry on a failed or partial pill calls onRetryMonth(month, source); Choose again calls onChooseCalendars
OK  #19 a narrow screen, (max-width: 360px) (Ruling 3): a day of 3 shows 2 chips and "+1 more", and 3 again once the screen is wide; a day of 4 shows "+2 more" either way
OK  #20 re-anchoring: when the window's first month moves (2025-10 → 2025-11), the week start changes (0 → 6) or the Hebrew line goes, one instant scroll keeps the month in view where it was under the bar
OK  #21 without IntersectionObserver (Ruling 7): the near months are the month in view and its two neighbours, from the scroll measure
OK  #22 unmount lets go of everything: the scroll and resize listeners, the observer, the media listener and a pending frame
OK  #23 the list moves in the page while scrolled into it (a banner or the unavailable row comes or goes above the Month, the header's zone line): one instant scroll by as much keeps January where it was under the bar (iOS has no scroll anchoring); at the page's top, nothing scrolls; nothing moved, nothing scrolls
OK  #24 a sticky region above the bar (E8's header and tab bar, --ch-top-h): the bar sticks under it, and the opening scroll, the month in view and the Today button all read the bar where it sticks
OK  #25 a narrow screen with three overlapping bars, Alpha 5–7, Beta 6–8 and Gamma 7–9 October (E5's limitRow): the 9th shows Gamma, named, not "+1 more" under two empty lines; the 8th Beta and Gamma, both named; wide, the bars keep their lanes, and a bar hidden behind "+2 more" on the 12th is named on the 13th, back in its lane
OK  #26 React logged no warning

26/26 passed (process TZ=UTC)
exit 0
```

The zone in the summary line follows the clock (`Asia/Jerusalem`); every other line is the same. Node may print its `module.register()` deprecation warning first; it is tsx's, not the smoke's.

- [ ] **Step 5: Run the regression smokes**

```bash
for s in smoke-calendar-month smoke-calendar-home-tabs smoke-calendar-grid smoke-hebrew-date smoke-calendar-home-render smoke-initdata-header smoke-auth-leftovers smoke-auth-identity; do
  for tz in UTC Asia/Jerusalem; do
    out=$(TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/$s.ts 2>&1); code=$?
    echo "$s $tz: $(echo "$out" | tail -1) exit $code"
  done
done
TZ=UTC DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/check-i18n-parity.ts > /dev/null; echo "parity exit $?"
```

Expected, the same as before this task (shown for UTC; Asia/Jerusalem gives the same counts, with its own zone in the lines that print one):

```
smoke-calendar-month UTC: 26/26 passed (process TZ=UTC) exit 0
smoke-calendar-home-tabs UTC: 11/11 passed (process TZ=UTC) exit 0
smoke-calendar-grid UTC: 11/11 passed (process TZ=UTC) exit 0
smoke-hebrew-date UTC: 22/22 passed (process TZ=UTC) exit 0
smoke-calendar-home-render UTC: 42/42 passed (process TZ=UTC) exit 0
smoke-initdata-header UTC: 9/9 passed exit 0
smoke-auth-leftovers UTC: 9/9 passed exit 0
smoke-auth-identity UTC: 26/26 passed exit 0
parity exit 0
```

No existing file changes. The scans in `smoke-initdata-header`, `smoke-auth-leftovers` and `smoke-auth-identity` find nothing in the two new files.

- [ ] **Step 6: Type-check and lint**

```bash
npx tsc --noEmit; echo "tsc exit $?"
npx eslint "app/[locale]/dashboard/MonthBrowse.tsx" scripts/smoke-calendar-month-browse.ts; echo "eslint exit $?"
```

Expected: no output from either tool, then `tsc exit 0` and `eslint exit 0`.

- [ ] **Step 7: Commit**

```bash
git add "app/[locale]/dashboard/MonthBrowse.tsx" scripts/smoke-calendar-month-browse.ts
git commit -F - <<'EOF'
feat(calendar-home): the Month's browse layout

MonthBrowse draws the Month's window, 12 months back to 18 ahead, stacked
vertically under a sticky bar, iOS style. The bar sits under the safe
areas and whatever sticks above it (the container's header and tab bar,
--ch-top-h), and shows the month in view with its year and Hebrew months, a
Today button while no part of today's month is on screen, and the
weekday row in week-start order. Every month renders at its known
height, so nothing above the viewport ever moves (WKWebView has no
scroll anchoring). The months near the screen draw their grids; the
rest are their title and an empty box of the same height.

A cell shows the Gregorian day with the Hebrew day at the head line's
end, the Hebrew month's short name on Hebrew day 1 and the month's
first cell, and three slots of one-line chips and bars, or two and
"+N" (two at most on a 360 px screen), as month.ts's limitRow fits each
week row, so no cell shows an empty line over "+N". Daily reminders aren't drawn
(R11). A loading day shows a placeholder and a failed one is dimmed,
so no day looks free before it is answered. A month's failure is a
pill over its cells and a partial answer a pill at its top; neither
changes its height. Each day is one button whose label reads the
whole cell.

On mount the start month's title goes under the bar, with half a week
row of the month before above it. A passive scroll listener reports
the month in view once a frame, one IntersectionObserver reports the
months near the screen, and the month in view stays put when the
window's first month, the week start or the Hebrew line changes, and
when content above the list changes height while it is scrolled (iOS
has no scroll anchoring). Nothing renders it yet.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
EOF
```

---

### Task 7 (E7): Month picked (spec §7.4 "Tap a day → picked", §7.7, §7.8; Rulings R11 and R12; Plan E Rulings 4, 5, 6 and 8)

> **INTERFACE NOTE VERSUS THE SPLIT (read this first; E6 and E8 build on it). `MonthPickedProps` and `MonthPicked` are the split's, verbatim. ONE ADDITION: `MonthPicked.tsx` also exports `MONTH_PICKED_CSS: string`, its style sheet, as `AgendaView.tsx` exports `AGENDA_CSS` and E4's `HomeTabs.tsx` exports `TABS_CSS`. The smoke checks it, and E8's "no `overflow: hidden` above the Month" check can read it. Nothing is renamed. These points the split left open are now binding:**
> 1. **MonthPicked renders D's `AGENDA_CSS` itself** (imported from `AgendaView.tsx`), before its own sheet. D's rows (`ItemRow`), the placeholders (`PlaceholderRows`), the state rows and the item sheet are all styled there, and the Agenda isn't mounted on the Month tab. So E8's `ItemSheet` over picked is styled while picked shows. E8 adds no style sheet for it.
> 2. **The day button's label** is E1's recipe, and E6's browse cells must build theirs the same way. The parts are joined with ", ":
>    - `formatDayLong(day, locale)`;
>    - then, when `hebrewDates`, `hebrewDayLabel(day, locale, genitive)`, with `genitive` = `t.raw('hebrewMonthGenitive')` in Russian only;
>    - then, when `count > 0`, `month.cellItems {count}`, followed by `month.cellFromPartner {count: fromPartner, name: model.partner}` only when `fromPartner > 0` and `model.partner` is set;
>    - then, whatever the count, `month.cellLoading` (loading) or `month.cellFailed` (failed), or `month.cellNothing` for an answered day with nothing drawn.
>
>    This is E6's order (its note 8), so a day reads the same in browse and in picked. A day with items drawn that another source hasn't answered, or that failed, still says so ("…, 4 items, 1 from Noa, couldn't load"): in picked its state otherwise shows only as the number's colour (§7.7).
>
>    A Google user's store has no partner, so a spouse-labelled calendar's items are counted but not named. The smoke's `expectedLabel` is the recipe in code.
> 3. **Notices** are rows between the nav and the weekday row, so a notice that appears never moves the chevrons. They use D's state-row classes (`ch-states`, `ch-state`, `role="status"`). The mapping:
>    - `partial` → `state.partial`, with Retry for `notice.source`;
>    - `failed` with `calendarsGone` → `state.calendarsGone`, with Choose again;
>    - `failed` with `busy` → `state.busy`, with Retry;
>    - `failed` with `error` or no failure → `month.failed` ("Couldn't load this month"), with Retry;
>    - a `reconnect` never makes a row. month.ts already leaves it out, and the view drops one anyway, since `MonthNotice`'s type allows it.
> 4. **No cell looks free unless it is answered** (spec §5). A loading cell with nothing drawn shows a pulsing placeholder where the dots go (`is-loading`, `.ch-mp-ghost`). A failed cell is `is-failed`: its number reads `--ch-muted` and it has no dots. Its label says "loading" or "couldn't load".
> 5. **`onSelectDay` is never called with the selected day**, as E4's `onTab` is never called with the tab on screen.
> 6. **Scroll and focus.** On mount the page goes to the top, then the selected day gets `focus({ preventScroll: true })`. On a short screen "the top" is as far down as shows the day's header and its first row, never past this layout's bar (review patch): one `window.scrollTo(0, top)`, `top` being E5's `pickedScrollTop` from where the layout (less its `scroll-margin-block-start`, the safe areas) and the day's header (`h3#ch-mp-day`) measure in the document, and `innerHeight`. Where nothing can be measured (no `getBoundingClientRect`, as in this smoke's fake DOM until #13) it is `scrollTo(0, 0)`, as before. After that, focus stays where the user left it. Two exceptions move it to the selected day: a tap on the Today pill (the pill goes away), and a chevron tap that leaves that chevron disabled at the window's end. **E8 renders one MonthPicked for as long as picked shows and never keys it by month or day.** Otherwise every chevron would scroll the page to the top again. **E8's render smoke must give its fake `window` a `scrollTo`**, because D's fake has none.
> 7. **Geometry.** The weekday row and the grid share a 6 px inline inset, the browse grid's. The mockup's 16 px would make a cell 41 px wide on a 320 px screen, so the 44 px floor wins, and the weekday letters line up over the cells. A cell is `PICKED_CELL_PX` (48) tall: a 1 px top line, 2 px, the 24 px day, the 12 px Hebrew line, 1 px, then the 8 px marks. The title is the month's `h2`, so the day header under the grid is an `h3`. Russian's lower-case weekday there is capitalised by `::first-letter`, as D's header does it. The list ends with `padding-block-end: calc(24px + max(env(safe-area-inset-bottom, 0px), var(--tg-safe-area-inset-bottom, 0px)))`, which is AgendaView's form and holds the spec's `var(--tg-safe-area-inset-bottom, 0px)`.
>
> **Verified against stand-ins: none.** E7 reads E1, E2, E4 (its tokens) and E5, all applied as written, and nothing of E6.

**What and why.** A tap on a day in browse (E6) opens picked, the second half of the iOS-style Month (Owner decision 8, spec §7.4, `MonthPicked.dc.html`). Only that month stays, compact, with the day's list under it. This task writes the layout as a presentational component. MonthView (E8) holds the layout and the selection, and passes the props the split names: the model from `monthModels`, the day's `dayRows` and `dayStatus`, and `canStep` for the chevrons. From top to bottom:
- **The bar:** "All months" (a back chevron, flipped in RTL) returns to browse. The Today pill shows while the selected day isn't today (Ruling 6).
- **The nav:** previous and next chevrons, 44 × 44 px, labelled, and disabled at the window's ends (12 months back, 18 ahead). Between them is the month's title with its year and, when it's on, its Hebrew months ("October 2026", "Tishrei – Cheshvan 5787"), inside `aria-live="polite"`, so a chevron's month is read out.
- **The month's notices** as rows, with Retry or Choose again (Ruling 4's notices; picked has no overlay to keep a height for).
- **The weekday row** from the week start, then **the compact grid**: one 48 px button per day of the month. Each shows the Gregorian day, the Hebrew day at 11 px (with the short month name on Hebrew day 1 and on the 1st), and up to 3 dots, filled for the viewer's items and a ring for the partner's, then "+N". Daily reminders are never dotted or counted (R11, Ruling 5). The selected day has `aria-pressed="true"` and today `aria-current="date"`. The days of the months around it are blank and `aria-hidden` (R12).
- **The day:** "Today · Thursday, 15 October" on today, otherwise "Friday, 16 October", with the Hebrew day muted beside it. Then come D's `ItemRow`s for the day's rows, daily reminders included. "Nothing planned" shows only once the day is answered and empty. Placeholders show while it loads, and nothing shows when it failed.
- **On mount:** the page scrolls to the top, so the header, the tabs, the bar, the month and the start of the list fit in one screen, and focus goes to the selected day (Ruling 6, spec §7.7). Where they don't fit (a 6-row month under the trial and location banners on a 375 × 667 phone, review patch), the page scrolls only as far down as shows the day's header and its first row, and never past the bar.

Nothing renders MonthPicked yet: E8's MonthView does. No user sees a change, and the switch is unchanged.

**Files** (the state this task starts from: 0064e8f with E1, E2, E3, E4 and E5 applied):
- Prerequisites:
  - E1's `calendarHome.month.*` and `hebrewMonthShort`;
  - E2's `grid.ts`, `hebrewMonthHeader` and `hebrewCellLabel`, and `formatMonthTitle` and `formatWeekdayHeader`;
  - E4's tokens in `home-theme.ts`;
  - E5's `month.ts`.

  E6 is not needed: E7 reads nothing of it.
- Create: `app/[locale]/dashboard/MonthPicked.tsx`
- Create (test): `scripts/smoke-calendar-month-picked.ts`
- Modify: none. No existing file changes.
- Test: `scripts/smoke-calendar-month-picked.ts` under `TZ=UTC` and `TZ=Asia/Jerusalem`. It buckets no days, but Step 4 also runs it under `Pacific/Kiritimati` and `America/Los_Angeles` to show that the device's zone moves nothing.
- Regression (unchanged, both clocks):
  - `smoke-initdata-header` (9), `smoke-auth-leftovers` (9) and `smoke-auth-identity` (26), which scan `app/`, `src/` and `scripts/`;
  - `smoke-calendar-home-render` (42): AgendaView, DayList and ItemRow, which E7 imports;
  - `smoke-calendar-month` (26): the model;
  - `smoke-calendar-home-tabs` (11): the tokens;
  - `smoke-calendar-home-copy` (18) and `check-i18n-parity` (1013 keys): the copy.

**Interfaces:**
- Consumes (line numbers as of the starting state):
  - from E5, `src/lib/calendar-view/month.ts`:
    - `PICKED_CELL_PX` (48, `:76`);
    - `limitDots(dots: readonly boolean[]): { shown: boolean[]; more: number }` (`:504`): `PICKED_DOTS` (3) shown, then the rest as `more`;
    - the types `MonthModel` (`:201`; `{ month; weeks: MonthCell[][]; status; notices: MonthNotice[]; partner: string | null }`) and `MonthCell` (`:173`; `{ day; inMonth; today; status; slots; dots: boolean[]; count; fromPartner; hebrewMonthStart }`);
    - (review patch) `pickedScrollTop(layoutTop, dayHeadBottom, viewport): number` (`:518`), and in the smoke `PICKED_FIRST_ROW_PX` (64, `:89`);
    - in the smoke also `PICKED_DOTS`, `monthModels` (`:434`), `dayRows` (`:525`), `initialMonthUi`, `pickDay`, `canStep` (`:569`), `stepMonth`, `pickToday` and the type `MonthUi`.

    A blank cell (`inMonth: false`) carries nothing (E5 note 6), so the view reads only `day` and `inMonth` on it. `hebrewMonthStart` is Hebrew day 1 or the month's first day (`:391`). The dots, `count` and `fromPartner` already leave daily reminders out (`:271`), and `dayRows` keeps them (`:525-528`).
  - from E2:
    - `src/lib/calendar-view/grid.ts`: `type MonthKey` (`:17`), `weekdayOrder(weekStart: WeekStart): WeekStart[]` (`:134`); in the smoke `monthWindow` (`:106`);
    - `src/lib/calendar-view/hebrew-date.ts`: `hebrewMonthHeader(month: MonthKey, lang: string): string` (`:145`), `hebrewCellLabel(dayKey: DayKey, lang: string, withMonth: boolean, shortMonths?: readonly string[]): string` (`:171`);
    - `src/lib/calendar-view/format.ts`: `formatMonthTitle(month: MonthKey, locale: string, withYear: boolean): string` (`:204`), `formatWeekdayHeader(weekday: WeekStart, locale: string): string` (`:217`).
  - from D2, `hebrewDayLabel(dayKey: DayKey, lang: string, genitive?: readonly string[]): string` (`hebrew-date.ts:108`). From D5, `formatDayLong(day: DayKey, locale: string): string` (`format.ts:106`).
  - from D3 and E3, `src/lib/calendar-view/store.ts`: the type `DayStatus` (`:103`). In the smoke also `emptyStore`, `reduceStore` (`:273`), `dayStatus` (`:294`), `daysInWindow`, and the types `CalendarStore` and `StoreAction`. From D3, `agenda.ts`: the type `AgendaRow` (`:58`).
  - from D5:
    - `AGENDA_CSS` (`app/[locale]/dashboard/AgendaView.tsx:178`): `.ch-states`, `.ch-state*`, `.ch-list`, `.ch-row*`, `.ch-ghosts`, `@keyframes ch-pulse` and the sheet's rules;
    - `PlaceholderRows({ count }: { count: number })` (`DayList.tsx:25`);
    - `ItemRow({ row, day, tz, onOpen }: ItemRowProps)` (`ItemRow.tsx:92`).

    `.ch-home[dir='rtl'] .ch-flip { transform: scaleX(-1); }` is `home-shell.ts:34`.
  - the tokens, from D5 (`home-theme.ts`): `--ch-accent`, `--ch-text`, `--ch-muted`, `--ch-separator`, `--ch-surface`, `--ch-outline`. From E4: `--ch-dot-mine`, `--ch-dot-partner`, `--ch-today`, `--ch-today-text`, `--ch-selected`, `--ch-selected-text`, `--ch-pill-bg`, `--ch-pill-line`, `--ch-pill-text`, `--ch-disabled`. Nothing else.
  - the copy (`calendarHome`):
    - from E1: `month.allMonths`, `month.today`, `month.previous`, `month.next`, `month.dayToday {date}`, `month.moreShort {count}`, `month.cellItems {count}`, `month.cellFromPartner {count} {name}`, `month.cellNothing`, `month.cellLoading`, `month.cellFailed`, `month.failed`, and `hebrewMonthShort` (`t.raw`, all three languages);
    - from D: `agenda.nothingPlanned`, `state.partial`, `state.busy`, `state.calendarsGone`, `actions.retry`, `actions.chooseAgain`, and `hebrewMonthGenitive` (`t.raw`, Russian only).
  - next-intl 4.6.1 (`useTranslations`, `useLocale`; `NextIntlClientProvider` and `createTranslator` in the smoke). React 19.2 (`useEffect`, `useRef`; `react-dom/server` and `react-dom/client` in the smoke).
- Produces, `app/[locale]/dashboard/MonthPicked.tsx`:
  - `export interface MonthPickedProps { model: MonthModel; selected: DayKey; today: DayKey; tz: string; weekStart: WeekStart; hebrewDates: boolean; canPrev: boolean; canNext: boolean; rows: AgendaRow[]; dayStatus: DayStatus; onSelectDay: (day: DayKey) => void; onPrev: () => void; onNext: () => void; onToday: () => void; onAllMonths: () => void; onOpenItem: (row: AgendaRow) => void; onRetryMonth: (month: MonthKey, source: SourceName) => void; onChooseCalendars: () => void }`, the split's, verbatim.
  - `export function MonthPicked(props: MonthPickedProps)` returns `<section className="ch-mp" dir={he ? 'rtl' : 'ltr'}>`. Inside, in order: `<style>{AGENDA_CSS}</style>`, `<style>{MONTH_PICKED_CSS}</style>`, the bar, the nav, the notices, the weekday row, the grid and `<section className="ch-mp-list">`.
  - `export const MONTH_PICKED_CSS: string` (**the addition**), with the classes `.ch-mp`, `.ch-mp-bar`, `.ch-mp-back`, `.ch-mp-today`, `.ch-mp-today-pill`, `.ch-mp-nav`, `.ch-mp-chev`, `.ch-mp-title`, `.ch-mp-month`, `.ch-mp-range`, `.ch-mp-states`, `.ch-mp-weekdays`, `.ch-mp-grid`, `.ch-mp-cell` (`is-today`, `is-loading`, `is-failed`), `.ch-mp-blank`, `.ch-mp-num`, `.ch-mp-heb`, `.ch-mp-marks`, `.ch-mp-dot` (`is-mine`, `is-partner`), `.ch-mp-more`, `.ch-mp-ghost`, `.ch-mp-list`, `.ch-mp-day`, `.ch-mp-day-label`, `.ch-mp-day-hebrew` and `.ch-mp-nothing`.
  - **How E8 renders it** (the smoke's `PickedHost` and `propsFor` do exactly this). With `ui` picked, `const model = getMonth(ui.month)`. When the model isn't null:
    - `<MonthPicked model={model} selected={ui.selected} today={today} tz={tz} weekStart={weekStart} hebrewDates={hebrewDates} canPrev={canStep(ui, -1, today)} canNext={canStep(ui, 1, today)} rows={dayRows(ui.selected)} dayStatus={dayStatus(store, ui.selected)} … />`;
    - `onSelectDay` → `onUi(pickDay(ui, day))`;
    - `onPrev` / `onNext` → `stepMonth(ui, ∓1, today)`;
    - `onToday` → `pickToday(ui, today)`;
    - `onAllMonths` → `backToBrowse(ui)`;
    - `onOpenItem` → `onSelect(row)`;
    - `onRetryMonth` and `onChooseCalendars` are passed through.

**Findings that shaped the code** (line numbers as of the starting state):
- **The model decides; the view lays out.** E5 has already worked out each cell's dots in slot order (bars first, then all-day, then by time), `count` and `fromPartner` without daily reminders, the cells' status, `hebrewMonthStart`, and at most one notice per kind and source with no reconnect (`month.ts:365-425`). MonthPicked formats and draws them. `limitDots` gives the 3 dots and the "+N" (`:504-506`).
- **The rows are D's, with D's styles.** `ItemRow` takes the day it is listed on (`ItemRow.tsx:92`), and its times, spans and snooze badge are read for that day (`:88-90`). So the rows get `day={selected}`, never today. The smoke's #2 shows a snooze that ends the same day reading "until 15:30", not "Wed 15:30". The row, state-row and placeholder classes live in `AGENDA_CSS` (`AgendaView.tsx:178-516`), which only AgendaView renders. The Month tab doesn't mount AgendaView, so MonthPicked renders the sheet too. A second copy of the same rules while both are mounted changes nothing. The notices reuse D's state-row markup (`AgendaView.tsx:54-73`, module-private there, so it is copied: the icon, `ch-state`, `role="status"`).
- **"Empty means answered"** (spec §5), as D's `Day` does it (`DayList.tsx:63-80`): "Nothing planned" only for `answered` with no rows; `PlaceholderRows` while `loading` (one under the rows, two with none); nothing for `failed`. The list's section carries `aria-busy` while loading. A day with only a daily reminder lists it and doesn't say "Nothing planned", yet its cell reads "nothing planned" and has no dot (Ruling 5: a count matches what's drawn).
- **The look follows `MonthPicked.dc.html`,** with the 11 px floor and the 44 px floor over the mockup's shortcuts:
  - the Hebrew line goes from 10 to 11 px, and "+N" from 9 to 11 px;
  - the 36 px Today pill sits inside a 44 px button, as E4's tab pill does;
  - the chevrons are 44 × 44;
  - the selected day is a 24 px circle in `--ch-selected` / `--ch-selected-text`, and on today `--ch-today` / `--ch-today-text`;
  - today's number as plain text reads `--ch-accent` (E4 note 3);
  - the dots are a filled `--ch-dot-mine` or a 1.5 px `--ch-dot-partner` ring (E4 note 2), so whose an item is never rests on colour;
  - a disabled chevron reads `--ch-disabled`;
  - the weekday row's bottom line and the cells' top lines are the mockup's.
- **The cell's height budget** is exactly 48 px (note 7). "+N" at 11 px has an 8 px line box: the glyphs overhang it by about 1.5 px each way, into the cell's spare pixel and the Hebrew line's leading. Without Hebrew dates the column is centred. The Hebrew line ellipsises (`overflow: hidden` on that leaf only, never on an ancestor). E1 flagged Russian's longest month-start label, "22 адара II" (about 65 px at 11 px), which would ellipsise in a 46 px cell. That happens only on the 1st of a month in Adar II. The device check decides whether it reads well enough.
- **Scroll and focus** (Ruling 6, spec §7.7):
  - The mount effect runs one `window.scrollTo(0, top)` first (note 6). Then `focus({ preventScroll: true })` puts focus on the selected day without a second scroll.
  - A ref (`refocus`) remembers a tap on the Today pill or a chevron. An effect keyed on `[selected, canPrev, canNext]` moves focus to the selected day when that control went away or was disabled. A button that becomes disabled or unmounts loses focus to the page (HTML's focus fix-up), where a screen reader would lose its place.
  - A tap on a day leaves focus on it: cells are keyed by day, so it is the same node.
  - On iOS a tap doesn't focus a button at all, so these moves are harmless there.
  - React's own effects run twice under StrictMode in development. That only repeats the scroll and the focus.
- **Review patch: a short screen.** From the CSS (the smoke's #13 sums them): the bar 50 px (6 + 44), the nav 46 (44 + 2), the weekday row 27 (6 + 16 + 4 + 1), 48 a row, and the day's header 37 (16 + 19 + 2). With D's header (75 with the Hebrew line) and E4's tab bar (48) above, a 6-row month's day header ends at 571 px, at 695 px under the trial and location banners. Under Telegram's header a 375 × 667 phone has about 560-590 px, a 320 × 568 one about 470, so "fits one screen" (Ruling 6) failed there, and the day's list started below the screen (the review's sum). Measuring the DOM, rather than summing constants, keeps a notice row, a two-line title or a bigger font honest; the safe areas come from the layout's own `scroll-margin-block-start`. The scroll stops at the layout's top, so the bar ("All months", Today) stays on screen; the header, the tabs and the banners are a short scroll up, and Telegram's BackButton shows in picked anyway.
- **React and disabled buttons:** React never calls `onClick` on a disabled `<button>` (its `shouldPreventMouseEvent`), as browsers don't, so the smoke's second tap on a disabled chevron proves nothing is called.
- **The weekday row** is `weekdayOrder(weekStart).map(formatWeekdayHeader)`: "S M T W T F S", "א׳ … ש׳", "Пн … Вс" (Ruling 8). It is `aria-hidden`, since every day button names its weekday. The title always carries the year (Ruling 8).
- **The smoke's harness** is copied from `smoke-calendar-home-render.ts` (`renderToString`, the fake DOM, `mount`), as the split asks. It adds two things to the fake DOM: `focus(options)` logs its options, and `window.scrollTo` logs its call, in one ordered page log. Answers go through the real reducer, and the props come from month.ts as E8 will compute them. The smoke's #1 walks `require.cache` from MonthPicked, as the render smoke's #1 does. The view is imported first, so its graph is its own.
- **Verified** (on a copy of 0064e8f with E1–E5 applied by `dapply.py` from their task texts; Node 26.11.1):
  - **Before:** with the smoke written and the component absent, the smoke exits 1 with `Error: Cannot find module '../app/[locale]/dashboard/MonthPicked'` under both clocks. `tsc` exits 2 with the TS2307 and the twelve TS7006 errors of Step 2.
  - **After:**
    - 14/14 under `TZ=UTC`, `TZ=Asia/Jerusalem`, `TZ=Pacific/Kiritimati` and `TZ=America/Los_Angeles` (13/13 before the review patch, which adds #13 and renumbers the warning check #14);
    - `tsc` and `eslint .` are clean;
    - the regression smokes print the same lines before and after under both clocks.
  - **Mutations:** the smoke catches all 57 planted bugs under UTC. They were:
    - the Today pill always shown, or inverted;
    - a chevron never disabled, the labels swapped, no `.ch-flip`;
    - no `aria-live`, no year, no Hebrew range, the weekday row from Sunday;
    - `aria-pressed` or `aria-current` never set;
    - the label without "from Noa", loading or failed read as "nothing planned", no genitive in Russian, no short month on Hebrew day 1;
    - every dot shown, the dots inverted, no "+N";
    - a reconnect row, calendars gone retrying, Retry for FamCal only, busy read as an error, partial dropped, no notices, the notices under the grid;
    - no "Today ·", "Nothing planned" when loading or failed, no placeholders, placeholders when failed;
    - no scroll to the top, a focus that scrolls, no focus on mount, no refocus after Today or at an end, refocus after every tap;
    - `onSelectDay` for the selected day;
    - 10 px Hebrew, 40 px chevrons, `margin-left`, 52 px cells, `overflow: hidden` on the frame, no safe area;
    - no loading placeholder, no `is-failed`, no `AGENDA_CSS`, blanks not `aria-hidden`, no `dir="rtl"`, the Hebrew line with Hebrew dates off;
    - a filled ring, an unknown token, a hover rule, today's number in `--ch-today`;
    - rows read for today instead of the selected day;
    - All months calling `onToday`, a row tap calling nothing;
    - review patch (`erev/mut/m-e78.py`, each caught by #13): always `scrollTo(0, 0)`, the scroll margin ignored, and no `scroll-margin-block-start` in the CSS.
  - **The task text was replayed:** on a fresh 0064e8f copy, `dapply.py` applied E1–E5 and then this task. The two files came out byte-identical to the verified ones, and Steps 4 and 7 ran there as written.
  - **Not verified:** `next build` (nothing imports MonthPicked until E8; the controller's fresh-clone build after E8 covers it), Node 22, real WebViews (the Hebrew line's width, the pill and the chevrons on Telegram's themes, VoiceOver and TalkBack reading the live title).
  - **Checked at integration:** E6's labels against note 2's recipe. With E1-E7 applied, browse and picked were rendered from the same models (9 stores, the mixed FamCal + Google ones included, in en, he and ru) and all 837 picked labels appear in browse. As first drafted, picked dropped the state word after the items, and 9 October days per language disagreed; note 2 now follows E6, and #9 pins the two mixed cases.

- [ ] **Step 1: Write the failing smoke `scripts/smoke-calendar-month-picked.ts`**

It renders MonthPicked in en, he and ru with answers through the real store, and drives it in real React on a small fake DOM. Create `scripts/smoke-calendar-month-picked.ts` with exactly this content:

```ts
// Smoke test for the Month's picked layout (Plan E, Task E7; spec §7.4 "Tap a day →
// picked", §7.7, §7.8; Rulings R11 and R12; Plan E Rulings 4, 5, 6 and 8):
// MonthPicked (app/[locale]/dashboard/MonthPicked.tsx), fed the way MonthView (E8) feeds
// it: range answers go through the real store (reduceStore), and the model, the rows,
// the day's status and the chevrons come from month.ts (monthModels, dayRows,
// dayStatus, canStep). It checks:
//  - client-safe imports: no server module, no @hebcal/core, no date-fns-tz;
//  - en, he and ru: the bar ("All months", the Today pill), the nav (the chevrons'
//    labels, the title with its year and Hebrew months in aria-live="polite"), the
//    weekday row from the week start, the blanks, one button per day with browse's label
//    (E1's parts), aria-pressed and aria-current, the Hebrew day at 11 px with the short
//    month on Hebrew day 1 and the 1st, the day header and D's rows; RTL in Hebrew;
//  - the dots: filled for the viewer's, a ring for the partner's, at most 3, then
//    month.moreShort's "+N";
//  - daily reminders listed under the day but never dotted or counted (Ruling 5);
//  - the chevrons at the window's ends (12 months back, 18 ahead);
//  - the Today pill only while the selected day isn't today;
//  - the notices as rows (failed, busy, calendars gone, partial; never a reconnect), and
//    the day's states: "Nothing planned" only when answered and empty, placeholders while
//    loading, nothing when failed; cells never look free unless answered;
//  - in real React (react-dom/client with act on a small fake DOM): every callback; on
//    mount the page scrolls to the top and focus goes to the selected day without a
//    scroll; when the Today pill or a chevron goes away or is disabled, focus moves to
//    the selected day;
//  - a short screen (Ruling 6): entering picked scrolls only as far down as shows the
//    day's header and first row, never past the bar, from E7's fixed heights for 6 rows
//    with and without two banners on 375 × 667 and 320 × 568, and in real React from
//    where the layout and the day header measure;
//  - the CSS: nothing under 11 px, taps of 44 px, PICKED_CELL_PX cells, logical
//    properties only, no hover, the bottom safe area, only defined tokens.
// React must log no warning. No network, no DB, no Redis.
//
// Run with the fake env from the task brief (no dotenv), under two clocks:
//   TZ=UTC npx tsx scripts/smoke-calendar-month-picked.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-calendar-month-picked.ts

// The view first: the import check walks what it loads.
import { MONTH_PICKED_CSS, MonthPicked, type MonthPickedProps } from '../app/[locale]/dashboard/MonthPicked';
import { AGENDA_CSS } from '../app/[locale]/dashboard/AgendaView';
import { HOME_THEME_CSS } from '../app/[locale]/dashboard/home-theme';
import { HOME_SHELL_CSS } from '../app/[locale]/dashboard/home-shell';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import React, { createElement, type ComponentProps, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import {
  PICKED_CELL_PX,
  PICKED_DOTS,
  PICKED_FIRST_ROW_PX,
  canStep,
  dayRows,
  initialMonthUi,
  monthModels,
  pickDay,
  pickToday,
  pickedScrollTop,
  stepMonth,
  type MonthCell,
  type MonthUi,
} from '../src/lib/calendar-view/month';
import { monthWindow } from '../src/lib/calendar-view/grid';
import { formatDayLong } from '../src/lib/calendar-view/format';
import { hebrewDayLabel } from '../src/lib/calendar-view/hebrew-date';
import { daysInWindow, dayStatus, emptyStore, reduceStore, type CalendarStore, type StoreAction } from '../src/lib/calendar-view/store';
import { compareItems, type CalendarDTO, type DayKey, type ItemCalendarDTO, type ItemDTO, type ItemReminderDTO, type RangeResponse, type WeekStart } from '../src/lib/calendar-view/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const ROOT = path.resolve(__dirname, '..');
const nodeRequire = createRequire(__filename);
const LOCALES = ['en', 'he', 'ru'] as const;
type Locale = (typeof LOCALES)[number];

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

const show = (value: unknown) => JSON.stringify(value);
const noop = () => undefined;
const messages: Record<Locale, Row> = {
  en: JSON.parse(fs.readFileSync(path.join(ROOT, 'messages/en.json'), 'utf8')),
  he: JSON.parse(fs.readFileSync(path.join(ROOT, 'messages/he.json'), 'utf8')),
  ru: JSON.parse(fs.readFileSync(path.join(ROOT, 'messages/ru.json'), 'utf8')),
};

// ---- React must not warn ----

const reactWarnings: string[] = [];
for (const level of ['error', 'warn'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    const text = args.map(String).join(' ');
    if (text.startsWith('[telegram-ui]')) return original(...args);
    // Node's own warnings (tsx's module.register() deprecation on Node 26 lands here, at a time that varies) aren't React's.
    if (text.startsWith('(node:')) return original(...args);
    reactWarnings.push(text.slice(0, 300));
  };
}

// ---- Fixtures: an Israeli FamCal user paired with Noa, on Thursday 15 October 2026 ----

const TZ = 'Asia/Jerusalem';
const TODAY: DayKey = '2026-10-15';
const OCTOBER = '2026-10';
/** A wall-clock time in Israel on an October day, as UTC ISO (IDT, UTC+3, until 25 October; then IST, UTC+2). */
function at(day: DayKey, hhmm: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const [h, min] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, h - (day < '2026-10-25' ? 3 : 2), min)).toISOString();
}

const MY_CAL: ItemCalendarDTO = { id: 'native:cal_me_7f3a', name: 'Family', color: '#039BE5', mine: true, inLegend: true };
const NOA_CAL: ItemCalendarDTO = { id: 'native:cal_noa_91b2', name: 'Noa and the kids', color: '#F4511E', mine: false, ownerName: 'Noa', inLegend: true };
const LEGEND: CalendarDTO[] = [
  { id: 'native:cal_me_7f3a', source: 'famcal', name: 'Family', color: '#039BE5', mine: true },
  { id: 'native:cal_noa_91b2', source: 'famcal', name: 'Noa and the kids', color: '#F4511E', mine: false, ownerName: 'Noa' },
];

function item(id: string, o: Partial<ItemDTO> & { start: string }): ItemDTO {
  return {
    key: `${o.source ?? 'famcal'}|${id}`,
    source: 'famcal',
    readOnly: false,
    id,
    seriesId: null,
    originalStart: o.start,
    kind: 'event',
    title: id,
    end: o.start,
    allDay: false,
    tz: TZ,
    recurring: false,
    repeatsDaily: false,
    span: null,
    calendar: MY_CAL,
    location: null,
    description: null,
    ...o,
  };
}
function rem(o: Partial<ItemReminderDTO> = {}): ItemReminderDTO {
  return { done: false, doneAt: null, snoozedUntil: null, open: false, openSince: null, ownerIsViewer: true, creatorIsViewer: true, ...o };
}

/** The daily reminder, listed on its day (Ruling 5: listed, never dotted or counted). */
const vitamins = (day: DayKey, done = false): ItemDTO =>
  item(`vitamins-${day}`, { kind: 'reminder', title: 'Take vitamins', start: at(day, '08:00'), recurring: true, repeatsDaily: true, reminder: rem({ done, doneAt: done ? at(day, '08:10') : null }) });

const PILATES = item('pilates', { title: 'Pilates', start: at('2026-10-05', '19:00'), end: at('2026-10-05', '20:00'), calendar: NOA_CAL });
const HAIRCUT = item('haircut', { title: 'Haircut', start: at('2026-10-06', '12:00'), end: at('2026-10-06', '12:45') });
const CALL_MOM = item('call-mom', { kind: 'reminder', title: 'Call Mom', start: at('2026-10-06', '20:00'), reminder: rem({ done: true, doneAt: at('2026-10-06', '20:05') }) });
const DENTIST = item('dentist', { title: 'Dentist', start: at(TODAY, '09:30'), end: at(TODAY, '10:30'), location: 'Clinic on Herzl St' });
const FORM = item('form', { kind: 'reminder', title: 'Send the school form', start: at(TODAY, '13:00'), reminder: rem({ open: true }) });
const FOOTBALL = item('football', { title: 'Football practice', start: at(TODAY, '17:00'), end: at(TODAY, '18:00'), calendar: NOA_CAL });
const MOVIE = item('movie', { title: 'Movie night', start: at(TODAY, '20:30'), end: at(TODAY, '22:30') });
const GRANDMA = item('grandma', { title: 'Grandma visits', start: '2026-10-16', end: '2026-10-17', allDay: true, tz: null, calendar: NOA_CAL });
const CHALLAH = item('challah', { kind: 'reminder', title: 'Buy challah', start: at('2026-10-16', '10:00'), reminder: rem({ creatorIsViewer: false, creatorName: 'Noa' }) });
const BUSY_DAY = ['Standup', 'Review', 'Swim class', 'Lunch', 'Call the bank'].map((title, i) =>
  item(`busy-${i}`, { title, start: at('2026-10-20', `${String(8 + i).padStart(2, '0')}:00`), end: at('2026-10-20', `${String(8 + i).padStart(2, '0')}:30`), calendar: i === 2 ? NOA_CAL : MY_CAL }),
);
/** Snoozed until later the same day: its row reads the time alone on that day ("until 15:30"), not a weekday and time. */
const BANK = item('bank', { kind: 'reminder', title: 'Call the bank', start: at('2026-10-21', '14:00'), reminder: rem({ snoozedUntil: at('2026-10-21', '15:30') }) });
const TRIP = (span: ItemDTO['span']): ItemDTO => item('trip', { title: 'Eilat trip', start: '2026-10-22', end: '2026-10-25', allDay: true, tz: null, span });

/** October 2026's days with items (the rest are answered and empty). */
const OCTOBER_ITEMS: Record<DayKey, ItemDTO[]> = {
  '2026-10-05': [PILATES],
  '2026-10-06': [HAIRCUT, CALL_MOM],
  [TODAY]: [vitamins(TODAY, true), DENTIST, FORM, FOOTBALL, MOVIE],
  '2026-10-16': [GRANDMA, vitamins('2026-10-16'), CHALLAH],
  '2026-10-17': [vitamins('2026-10-17')],
  '2026-10-20': BUSY_DAY,
  '2026-10-21': [BANK],
  '2026-10-22': [TRIP('endsLater')],
  '2026-10-23': [TRIP('spansDay')],
  '2026-10-24': [TRIP('spansDay')],
};

function answer(o: Partial<RangeResponse> & { items?: Record<DayKey, ItemDTO[]> } = {}): RangeResponse {
  const { from, to } = monthWindow(OCTOBER);
  const window = { from: o.from ?? from, to: o.to ?? to };
  const items = o.items ?? {};
  const { items: _items, ...rest } = o;
  return {
    tz: TZ,
    today: TODAY,
    weekStart: 0,
    hebrewDates: true,
    sources: { famcal: { status: 'ok' } },
    partner: { name: 'Noa' },
    calendars: LEGEND,
    ...rest,
    ...window,
    days: daysInWindow(window.from, window.to).map((date) => ({ date, items: [...(items[date] ?? [])].sort(compareItems) })),
  };
}

const storeOf = (actions: StoreAction[]): CalendarStore => actions.reduce(reduceStore, emptyStore());
const ok = (response: RangeResponse): StoreAction => ({ type: 'response', response, epoch: 0 });
/** October answered, as a month window's answer. */
const octoberStore = (o: Partial<RangeResponse> = {}) => storeOf([ok(answer({ items: OCTOBER_ITEMS, ...o }))]);
/** Only the Agenda's first week answered ([today, today+7)): the rest of October still loading. */
const AGENDA_WEEK = { from: TODAY, to: '2026-10-22' };
const weekItems = Object.fromEntries(Object.entries(OCTOBER_ITEMS).filter(([d]) => d >= AGENDA_WEEK.from && d < AGENDA_WEEK.to));
const weekOnlyStore = () => storeOf([ok(answer({ ...AGENDA_WEEK, items: weekItems }))]);
/** The Agenda's week answered, then October's window failed (500 or 429). */
const failedStore = (kind: 'busy' | 'error') =>
  storeOf([ok(answer({ ...AGENDA_WEEK, items: weekItems })), { type: 'windowFailed', ...monthWindow(OCTOBER), sources: ['famcal'], kind, epoch: 0 }]);
/** A Google user (no partner in the store), October answered with `google`. */
const googleStore = (google: NonNullable<RangeResponse['sources']['google']>) =>
  storeOf([ok(answer({ sources: { google }, partner: null, calendars: [{ id: 'family@group.calendar.google.com', source: 'google', name: 'Family', color: null, mine: true }] }))]);

/** Picked on `day`, as a tap in browse leaves it. */
const picked = (day: DayKey): MonthUi => pickDay(initialMonthUi(null, TODAY), day);

/** MonthPicked's props for a store and a UI, as MonthView (E8) computes them. */
function propsFor(store: CalendarStore, ui: MonthUi, o: Partial<MonthPickedProps> = {}): MonthPickedProps {
  const facts = store.facts;
  assert(facts, 'the store has no facts');
  const model = monthModels(store)(ui.month);
  assert(model && ui.selected, `no model for ${ui.month}`);
  return {
    model,
    selected: ui.selected,
    today: facts.today,
    tz: facts.tz,
    weekStart: facts.weekStart,
    hebrewDates: facts.hebrewDates,
    canPrev: canStep(ui, -1, facts.today),
    canNext: canStep(ui, 1, facts.today),
    rows: dayRows(store, ui.selected),
    dayStatus: dayStatus(store, ui.selected),
    onSelectDay: noop,
    onPrev: noop,
    onNext: noop,
    onToday: noop,
    onAllMonths: noop,
    onOpenItem: noop,
    onRetryMonth: noop,
    onChooseCalendars: noop,
    ...o,
  };
}

// ---- Rendering ----

/** CalendarHome's frame: the theme root with its tokens and the shell's styles, inside next-intl's provider. */
function inHome(locale: Locale, el: ReactElement): ReactElement {
  // The provider's props type makes children required; createElement takes them as its third argument.
  const provider = { locale, messages: messages[locale], timeZone: TZ } as ComponentProps<typeof NextIntlClientProvider>;
  return createElement(
    NextIntlClientProvider,
    provider,
    createElement(
      'div',
      { className: 'ch-home', 'data-theme': 'light', dir: locale === 'he' ? 'rtl' : 'ltr' },
      createElement('style', null, HOME_THEME_CSS),
      createElement('style', null, HOME_SHELL_CSS),
      el,
    ),
  );
}

const render = (locale: Locale, props: MonthPickedProps) => renderToString(inHome(locale, createElement(MonthPicked, props)));

const decode = (s: string) =>
  s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** The text a reader sees: style sheets, tags and React's text separators out, entities decoded, spaces collapsed. */
const textOf = (html: string) =>
  decode(
    html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/g, ' ')
      .replace(/<!-- -->/g, '')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();

/** The markup without the style sheets (their class names would match anything). */
const markup = (html: string) => html.replace(/<style[^>]*>[\s\S]*?<\/style>/g, '');

/** An attribute of one opening tag, decoded, or null. */
const attr = (tag: string, name: string) => {
  const m = new RegExp(` ${name}="([^"]*)"`).exec(tag);
  return m ? decode(m[1]) : null;
};

type CellHtml = { label: string | null; pressed: string | null; current: string | null; className: string; num: string; heb: string | null; dots: string[]; more: string | null; ghost: boolean };

/** The grid's cells in order: blanks as null, each day's button parsed. */
function gridOf(html: string): (CellHtml | null)[] {
  const body = markup(html);
  const start = body.indexOf('<div class="ch-mp-grid">');
  const end = body.indexOf('<section class="ch-mp-list"', start);
  assert(start >= 0 && end > start, 'no grid in the markup');
  const grid = body.slice(start, end);
  const out: (CellHtml | null)[] = [];
  for (const m of grid.matchAll(/<span class="ch-mp-cell ch-mp-blank" aria-hidden="true"><\/span>|<button([^>]*)>([\s\S]*?)<\/button>/g)) {
    if (!m[1]) {
      out.push(null);
      continue;
    }
    const open = m[1];
    const inner = m[2];
    out.push({
      label: attr(open, 'aria-label'),
      pressed: attr(open, 'aria-pressed'),
      current: attr(open, 'aria-current'),
      className: attr(open, 'class') ?? '',
      num: /<span class="ch-mp-num" aria-hidden="true">(\d+)<\/span>/.exec(inner)?.[1] ?? '',
      heb: /<span class="ch-mp-heb" aria-hidden="true">([^<]*)<\/span>/.exec(inner)?.[1] ?? null,
      dots: [...inner.matchAll(/class="ch-mp-dot (is-mine|is-partner)"/g)].map((d) => d[1]),
      more: /<span class="ch-mp-more" dir="ltr">([^<]*)<\/span>/.exec(inner)?.[1] ?? null,
      ghost: inner.includes('class="ch-mp-ghost"'),
    });
  }
  return out;
}
const days = (html: string) => gridOf(html).filter((c): c is CellHtml => c !== null);
const cellOn = (html: string, day: number) => {
  const cell = days(html).find((c) => Number(c.num) === day);
  assert(cell, `no cell for day ${day}`);
  return cell;
};

/** Browse's label recipe (E1's top note), from the copy itself: the weekday and date, the Hebrew day, then the counts or the state. */
function expectedLabel(locale: Locale, cell: MonthCell, partner: string | null, hebrewDates: boolean): string {
  const t = nodeRequire('next-intl').createTranslator({ locale, messages: messages[locale], namespace: 'calendarHome' });
  const genitive = locale === 'ru' ? messages.ru.calendarHome.hebrewMonthGenitive : undefined;
  const parts = [formatDayLong(cell.day, locale)];
  if (hebrewDates) parts.push(hebrewDayLabel(cell.day, locale, genitive));
  if (cell.count > 0) {
    parts.push(t('month.cellItems', { count: cell.count }));
    if (cell.fromPartner > 0 && partner) parts.push(t('month.cellFromPartner', { count: cell.fromPartner, name: partner }));
  }
  if (cell.status !== 'answered') parts.push(t(cell.status === 'loading' ? 'month.cellLoading' : 'month.cellFailed'));
  else if (cell.count === 0) parts.push(t('month.cellNothing'));
  return parts.join(', ');
}

/** The day header's text, the Today pill and the chevrons, from the markup. */
function chrome(html: string) {
  const body = markup(html);
  const buttons = [...body.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)];
  const byClass = (cls: string) => buttons.filter((b) => attr(b[1], 'class') === cls);
  const chevrons = byClass('ch-mp-chev').map((b) => ({ label: attr(b[1], 'aria-label'), disabled: / disabled=""/.test(b[1]), flip: /<svg class="ch-flip"[^>]*aria-hidden="true"/.test(b[2]) }));
  const back = byClass('ch-mp-back').map((b) => ({ text: textOf(b[2]), flip: /<svg class="ch-flip"[^>]*aria-hidden="true"/.test(b[2]) }));
  const today = byClass('ch-mp-today').map((b) => textOf(b[2]));
  const title = /<h2 class="ch-mp-title" aria-live="polite">([\s\S]*?)<\/h2>/.exec(body);
  const month = title ? /<span class="ch-mp-month">([^<]*)<\/span>/.exec(title[1])?.[1] ?? null : null;
  const range = title ? /<span class="ch-mp-range">([^<]*)<\/span>/.exec(title[1])?.[1] ?? null : null;
  const weekdays = /<div class="ch-mp-weekdays" aria-hidden="true">([\s\S]*?)<\/div>/.exec(body);
  const head = /<h3 class="ch-mp-day" id="ch-mp-day">([\s\S]*?)<\/h3>/.exec(body);
  const dayLabel = head ? textOf(/<span class="ch-mp-day-label">([\s\S]*?)<\/span>/.exec(head[1])?.[1] ?? '') : null;
  const dayHebrew = head ? /<span class="ch-mp-day-hebrew">([^<]*)<\/span>/.exec(head[1])?.[1] ?? null : null;
  const list = body.slice(body.indexOf('<section class="ch-mp-list"'));
  const rows = [...list.matchAll(/<span class="ch-title" dir="auto">([^<]*)<\/span>/g)].map((m) => decode(m[1]));
  const notices = [...body.matchAll(/<div class="ch-state" role="status">([\s\S]*?)<\/div>/g)].map((m) => textOf(m[1]));
  return {
    chevrons,
    back,
    today,
    month: month && decode(month),
    range: range && decode(range),
    weekdays: weekdays ? [...weekdays[1].matchAll(/<span>([^<]*)<\/span>/g)].map((m) => m[1]) : null,
    dayLabel,
    dayHebrew,
    rows,
    notices,
    nothing: list.includes('class="ch-mp-nothing"'),
    ghosts: list.includes('class="ch-ghosts"'),
    busy: / aria-busy="true"/.test(list.slice(0, list.indexOf('>') + 1)),
  };
}

// ---- A small fake DOM for react-dom/client (no jsdom in node_modules), as in smoke-calendar-home-render.ts ----

const HTML_NS = 'http://www.w3.org/1999/xhtml';
type Listener = { type: string; capture: boolean; fn: (event: Row) => void };
/** What the page did, in order: scrollTo calls and focus calls (with their options). */
const pageLog: string[] = [];

class FakeNode {
  parentNode: FakeNode | null = null;
  childNodes: FakeNode[] = [];
  listeners: Listener[] = [];
  constructor(
    public nodeType: number,
    public nodeName: string,
  ) {}
  get ownerDocument(): Row {
    return fakeDocument;
  }
  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }
  get lastChild(): FakeNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }
  get nextSibling(): FakeNode | null {
    const siblings = this.parentNode?.childNodes ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
  get parentElement(): FakeNode | null {
    return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
  }
  appendChild(child: FakeNode): FakeNode {
    child.parentNode?.removeChild(child);
    this.childNodes.push(child);
    child.parentNode = this;
    return child;
  }
  insertBefore(child: FakeNode, before: FakeNode | null): FakeNode {
    if (!before) return this.appendChild(child);
    child.parentNode?.removeChild(child);
    this.childNodes.splice(this.childNodes.indexOf(before), 0, child);
    child.parentNode = this;
    return child;
  }
  removeChild(child: FakeNode): FakeNode {
    const i = this.childNodes.indexOf(child);
    if (i >= 0) this.childNodes.splice(i, 1);
    child.parentNode = null;
    return child;
  }
  get textContent(): string {
    return this.childNodes.map((c) => c.textContent).join('');
  }
  set textContent(value: string) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    if (value) this.appendChild(new FakeText(String(value)));
  }
  addEventListener(type: string, fn: (event: Row) => void, options?: boolean | { capture?: boolean }) {
    const capture = typeof options === 'boolean' ? options : !!options?.capture;
    this.listeners.push({ type, capture, fn });
  }
  removeEventListener(type: string, fn: (event: Row) => void) {
    this.listeners = this.listeners.filter((l) => l.type !== type || l.fn !== fn);
  }
}

class FakeText extends FakeNode {
  constructor(public data: string) {
    super(3, '#text');
  }
  get nodeValue(): string {
    return this.data;
  }
  set nodeValue(value: string) {
    this.data = String(value);
  }
  get textContent(): string {
    return this.data;
  }
  set textContent(value: string) {
    this.data = String(value);
  }
}

class FakeElement extends FakeNode {
  tagName: string;
  attributes = new Map<string, string>();
  style: Row = { setProperty(k: string, v: string) { this[k] = v; }, removeProperty(k: string) { delete this[k]; } };
  constructor(
    public localName: string,
    public namespaceURI: string,
  ) {
    super(1, namespaceURI === HTML_NS ? localName.toUpperCase() : localName);
    this.tagName = this.nodeName;
  }
  setAttribute(name: string, value: unknown) {
    this.attributes.set(name, String(value));
  }
  setAttributeNS(_ns: string | null, name: string, value: unknown) {
    this.setAttribute(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  removeAttributeNS(_ns: string | null, name: string) {
    this.attributes.delete(name);
  }
  get className(): string {
    return this.getAttribute('class') ?? '';
  }
  set className(value: string) {
    this.setAttribute('class', value);
  }
  focus(options?: { preventScroll?: boolean }) {
    pageLog.push(`focus ${this.getAttribute('aria-label') ?? this.getAttribute('class')} ${show(options ?? null)}`);
    fakeDocument.activeElement = this;
  }
  blur() {
    if (fakeDocument.activeElement === this) fakeDocument.activeElement = fakeDocument.body;
  }
}

const fakeDocument: Row = {
  nodeType: 9,
  nodeName: '#document',
  documentElement: { nodeType: 1, nodeName: 'HTML' },
  createElement: (tag: string) => new FakeElement(String(tag).toLowerCase(), HTML_NS),
  createElementNS: (ns: string, tag: string) => new FakeElement(tag, ns),
  createTextNode: (text: string) => new FakeText(text),
  addEventListener: noop,
  removeEventListener: noop,
};
fakeDocument.body = new FakeElement('body', HTML_NS);
fakeDocument.activeElement = fakeDocument.body;

const fakeWindow: Row = {
  document: fakeDocument,
  HTMLIFrameElement: class {},
  addEventListener: noop,
  removeEventListener: noop,
  location: { hash: '' },
  sessionStorage: { getItem: () => null, setItem: noop },
  scrollTo: (...args: unknown[]) => void pageLog.push(`scrollTo ${show(args)}`),
};
fakeDocument.defaultView = fakeWindow;

function installWindow() {
  const g = globalThis as Row;
  g.window = fakeWindow;
  g.document = fakeDocument;
  g.IS_REACT_ACT_ENVIRONMENT = true;
}

type Mounted = {
  container: FakeElement;
  click: (el: FakeNode) => void;
  unmount: () => void;
};

function mount(el: ReactElement): Mounted {
  const { createRoot } = nodeRequire('react-dom/client');
  const container = new FakeElement('div', HTML_NS);
  const root = createRoot(container);
  React.act(() => root.render(el));
  const dispatch = (target: FakeNode, type: string) => {
    const event: Row = {
      type,
      target,
      srcElement: target,
      bubbles: true,
      cancelable: true,
      defaultPrevented: false,
      isTrusted: true,
      timeStamp: Date.now(),
      button: 0,
      buttons: 0,
      detail: 1,
      preventDefault() {
        event.defaultPrevented = true;
      },
      stopPropagation: noop,
      stopImmediatePropagation: noop,
    };
    React.act(() => {
      fakeWindow.event = event;
      for (const capture of [true, false]) {
        for (const l of container.listeners.filter((x) => x.type === type && x.capture === capture)) l.fn(event);
      }
      fakeWindow.event = undefined;
    });
  };
  return {
    container,
    click: (target) => dispatch(target, 'click'),
    unmount: () => React.act(() => root.unmount()),
  };
}

function elements(node: FakeNode, out: FakeElement[] = []): FakeElement[] {
  for (const c of node.childNodes) {
    if (c instanceof FakeElement) {
      out.push(c);
      elements(c, out);
    }
  }
  return out;
}
const byClass = (node: FakeNode, cls: string) => elements(node).filter((e) => e.className.split(' ').includes(cls));
const one = (node: FakeNode, cls: string) => {
  const found = byClass(node, cls);
  assert(found.length === 1, `${found.length} elements with class ${cls}`);
  return found[0];
};
/** The day's button, by its date (the first part of its label). */
const cellFor = (m: Mounted, day: DayKey, locale: Locale = 'en') => {
  const date = formatDayLong(day, locale);
  const cell = byClass(m.container, 'ch-mp-cell').find((e) => e.tagName === 'BUTTON' && (e.getAttribute('aria-label') ?? '').startsWith(`${date},`));
  assert(cell, `no cell for ${day}`);
  return cell;
};
const pressedDays = (m: Mounted) => byClass(m.container, 'ch-mp-cell').filter((e) => e.getAttribute('aria-pressed') === 'true').map((e) => e.getAttribute('aria-label'));
const titleOf = (m: Mounted) => one(m.container, 'ch-mp-month').textContent;

/**
 * MonthPicked as MonthView (E8) holds it: the UI in state, moved with month.ts's
 * helpers; `seen` records each callback.
 */
function PickedHost({ store, start, seen }: { store: CalendarStore; start: MonthUi; seen: string[] }) {
  const [ui, setUi] = React.useState<MonthUi>(start);
  const today = store.facts?.today ?? TODAY;
  return createElement(
    MonthPicked,
    propsFor(store, ui, {
      onSelectDay: (day) => {
        seen.push(`select ${day}`);
        setUi((u) => pickDay(u, day));
      },
      onPrev: () => {
        seen.push('prev');
        setUi((u) => stepMonth(u, -1, today));
      },
      onNext: () => {
        seen.push('next');
        setUi((u) => stepMonth(u, 1, today));
      },
      onToday: () => {
        seen.push('today');
        setUi((u) => pickToday(u, today));
      },
      onAllMonths: () => void seen.push('allMonths'),
      onOpenItem: (row) => void seen.push(`open ${row.item.key}`),
      onRetryMonth: (month, source) => void seen.push(`retry ${month} ${source}`),
      onChooseCalendars: () => void seen.push('choose'),
    }),
  );
}

// ---- The checks ----

async function main() {
  await check('#1 the view is client-safe: MonthPicked loads no server module (DB, Redis, services, date-fns-tz, @hebcal/core), and it does load the model, the Hebrew dates and D\'s rows', () => {
    const root = path.join(ROOT, 'app/[locale]/dashboard/MonthPicked.tsx');
    assert(require.cache[root] !== undefined, `${root} is not in require.cache: the check would be empty`);
    const loaded = new Set<string>();
    const walk = (id: string) => {
      for (const child of require.cache[id]?.children ?? []) {
        if (loaded.has(child.id)) continue;
        loaded.add(child.id);
        walk(child.id);
      }
    };
    walk(root);
    for (const want of ['src/lib/calendar-view/month.ts', 'src/lib/calendar-view/grid.ts', 'src/lib/calendar-view/hebrew-date.ts', 'src/lib/calendar-view/format.ts', 'app/[locale]/dashboard/ItemRow.tsx', 'app/[locale]/dashboard/DayList.tsx']) {
      assert(loaded.has(path.join(ROOT, want)), `${want} not among the loaded modules: the check would be empty`);
    }
    const forbidden = [...loaded].filter((p) =>
      /[\\/](src[\\/](services|utils|config)|@prisma|\.prisma|@upstash|date-fns-tz|@hebcal[\\/]core|googleapis|@googleapis)[\\/]|src[\\/]lib[\\/](page-data|api-auth|prisma)/.test(p),
    );
    assert(forbidden.length === 0, `server modules in the view's graph: ${show(forbidden.map((p) => path.relative(ROOT, p)))}`);
  });

  await check('#2 en (week from Sunday, 16 October picked): the bar, the nav and its live title, the weekday row, the blanks, one button per day with browse\'s label, aria-pressed and aria-current, the Hebrew day with the short month on Hebrew day 1 and the 1st, the day header and D\'s rows; no Hebrew at all when the route says so', () => {
    const store = octoberStore();
    const props = propsFor(store, picked('2026-10-16'));
    const html = render('en', props);
    const c = chrome(html);
    assert(/<section class="ch-mp" dir="ltr">/.test(html), 'the section is dir="ltr"');
    assert(show(c.back) === show([{ text: 'All months', flip: true }]), `All months: ${show(c.back)}`);
    assert(show(c.today) === show(['Today']), `the Today pill: ${show(c.today)}`);
    assert(
      show(c.chevrons) === show([{ label: 'Previous month', disabled: false, flip: true }, { label: 'Next month', disabled: false, flip: true }]),
      `the chevrons: ${show(c.chevrons)}`,
    );
    assert(c.month === 'October 2026' && c.range === 'Tishrei – Cheshvan 5787', `the title: ${c.month} / ${c.range}`);
    assert(show(c.weekdays) === show(['S', 'M', 'T', 'W', 'T', 'F', 'S']), `the weekday row: ${show(c.weekdays)}`);
    const grid = gridOf(html);
    // 1 October 2026 is a Thursday: four blanks, then 31 days, and 31 October is a Saturday.
    assert(grid.length === 35 && grid.slice(0, 4).every((x) => x === null) && grid.slice(4).every((x) => x !== null), `the grid: ${show(grid.map((x) => x?.num ?? '·'))}`);
    const cells = days(html);
    assert(show(cells.map((x) => Number(x.num))) === show(Array.from({ length: 31 }, (_, i) => i + 1)), 'one button per day, 1 … 31');
    assert(show(cells.filter((x) => x.pressed === 'true').map((x) => x.num)) === show(['16']) && cells.every((x) => x.pressed === 'true' || x.pressed === 'false'), 'aria-pressed on the 16th only, false on the rest');
    assert(show(cells.filter((x) => x.current !== null).map((x) => [x.num, x.current])) === show([['15', 'date']]), 'aria-current="date" on today only');
    assert(cellOn(html, 15).className === 'ch-mp-cell is-today' && cellOn(html, 16).className === 'ch-mp-cell', `classes: ${cellOn(html, 15).className} / ${cellOn(html, 16).className}`);
    const literal: [number, string][] = [
      [15, 'Thursday, 15 October, 4 Cheshvan, 4 items, 1 from Noa'],
      [16, 'Friday, 16 October, 5 Cheshvan, 2 items, 1 from Noa'],
      [17, 'Saturday, 17 October, 6 Cheshvan, nothing planned'],
      [6, 'Tuesday, 6 October, 25 Tishrei, 2 items'],
      [22, 'Thursday, 22 October, 11 Cheshvan, 1 item'],
    ];
    for (const [day, want] of literal) assert(cellOn(html, day).label === want, `day ${day}: ${cellOn(html, day).label}`);
    const modelCells = props.model.weeks.flat().filter((x) => x.inMonth);
    const wrong = modelCells.filter((x, i) => cells[i].label !== expectedLabel('en', x, 'Noa', true));
    assert(wrong.length === 0, `labels off the recipe: ${show(wrong.map((x) => x.day))}`);
    const heb = cells.map((x) => x.heb);
    assert(heb[0] === '20 Tish.' && heb[11] === '1 Chesh.' && heb[14] === '4' && heb[10] === '30', `the Hebrew days: ${show(heb)}`);
    assert(heb.filter((h) => /\D/.test(h ?? '')).length === 2, `the short month only on the 1st and Hebrew day 1: ${show(heb)}`);
    assert(c.dayLabel === 'Friday, 16 October' && c.dayHebrew === '5 Cheshvan', `the day header: ${c.dayLabel} / ${c.dayHebrew}`);
    assert(show(c.rows) === show(['Grandma visits', 'Take vitamins', 'Buy challah']), `the rows: ${show(c.rows)}`);
    assert(!c.nothing && !c.ghosts && c.notices.length === 0, 'no "Nothing planned", placeholders or notices');
    const text = textOf(html);
    assert(text.includes('From Noa') && text.includes('Reminder · every day') && text.includes('All day'), `D's rows: ${text.slice(0, 600)}`);
    assert(!/calendarHome\.|month\.|agenda\./.test(text), 'an untranslated key');
    // The rows are read for the selected day: a snooze that ends that day reads its time alone.
    const snoozed = textOf(render('en', propsFor(store, picked('2026-10-21'))));
    assert(snoozed.includes('Snoozed until 15:30') && !snoozed.includes('Wed 15:30'), `the 21st's snooze: ${snoozed.slice(-200)}`);
    // Hebrew dates off (the route says so): no range, no Hebrew line, no Hebrew in the labels or the header.
    const plain = render('en', propsFor(octoberStore({ hebrewDates: false }), picked('2026-10-16')));
    const p = chrome(plain);
    assert(p.range === null && p.dayHebrew === null && days(plain).every((x) => x.heb === null), 'no Hebrew when hebrewDates is off');
    assert(cellOn(plain, 15).label === 'Thursday, 15 October, 4 items, 1 from Noa', `the label without Hebrew: ${cellOn(plain, 15).label}`);
  });

  await check('#3 he: RTL, the Hebrew title and months, the weekday row "א׳ … ש׳", Hebrew labels with their plural forms, the Hebrew day in gematriya with the month on Hebrew day 1, the chevrons flipped, and "היום · …" on today', () => {
    const html = render('he', propsFor(octoberStore(), picked('2026-10-16')));
    const c = chrome(html);
    assert(/<section class="ch-mp" dir="rtl">/.test(html), 'the section is dir="rtl"');
    assert(c.back[0]?.text === 'כל החודשים' && c.back[0].flip && show(c.today) === show(['היום']), `the bar: ${show(c.back)} ${show(c.today)}`);
    assert(show(c.chevrons.map((x) => [x.label, x.flip])) === show([['החודש הקודם', true], ['החודש הבא', true]]), `the chevrons: ${show(c.chevrons)}`);
    assert(c.month === 'אוקטובר 2026' && c.range === 'תשרי – חשון תשפ״ז', `the title: ${c.month} / ${c.range}`);
    assert(show(c.weekdays) === show(['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳']), `the weekday row: ${show(c.weekdays)}`);
    assert(cellOn(html, 15).label === 'יום חמישי, 15 באוקטובר, ד׳ בחשון, 4 אירועים, 1 של Noa', `day 15: ${cellOn(html, 15).label}`);
    assert(cellOn(html, 5).label === 'יום שני, 5 באוקטובר, כ״ד בתשרי, אירוע אחד, 1 של Noa', `day 5: ${cellOn(html, 5).label}`);
    assert(cellOn(html, 6).label === 'יום שלישי, 6 באוקטובר, כ״ה בתשרי, שני אירועים', `day 6: ${cellOn(html, 6).label}`);
    assert(cellOn(html, 1).heb === 'כ׳ תשרי' && cellOn(html, 12).heb === 'א׳ חשון' && cellOn(html, 15).heb === 'ד׳', `the Hebrew days: ${cellOn(html, 1).heb} ${cellOn(html, 12).heb} ${cellOn(html, 15).heb}`);
    assert(c.dayLabel === 'יום שישי, 16 באוקטובר' && c.dayHebrew === 'ה׳ בחשון', `the day header: ${c.dayLabel} / ${c.dayHebrew}`);
    const onToday = chrome(render('he', propsFor(octoberStore(), picked(TODAY))));
    assert(onToday.dayLabel === 'היום · יום חמישי, 15 באוקטובר' && onToday.today.length === 0, `today: ${onToday.dayLabel} ${show(onToday.today)}`);
    assert(!/calendarHome\.|month\./.test(textOf(html)), 'an untranslated key');
  });

  await check('#4 ru (week from Monday): the nominative title and months, "Пн … Вс", the blanks, labels with the genitive Hebrew month and every plural form, the short month after a number, and "Сегодня · …" on today', () => {
    const store = octoberStore({ weekStart: 1 as WeekStart });
    const props = propsFor(store, picked('2026-10-16'));
    const html = render('ru', props);
    const c = chrome(html);
    assert(c.month === 'Октябрь 2026' && c.range === 'Тишрей – Хешван 5787', `the title: ${c.month} / ${c.range}`);
    assert(show(c.weekdays) === show(['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']), `the weekday row: ${show(c.weekdays)}`);
    const grid = gridOf(html);
    // From Monday: three blanks (Mon–Wed), 31 days, and one blank after Saturday the 31st.
    assert(grid.length === 35 && grid.slice(0, 3).every((x) => x === null) && grid[3] !== null && grid[34] === null, `the grid: ${show(grid.map((x) => x?.num ?? '·'))}`);
    assert(c.back[0]?.text === 'Все месяцы' && show(c.today) === show(['Сегодня']), `the bar: ${show(c.back)} ${show(c.today)}`);
    assert(show(c.chevrons.map((x) => x.label)) === show(['Предыдущий месяц', 'Следующий месяц']), `the chevrons: ${show(c.chevrons)}`);
    const literal: [number, string][] = [
      [15, 'четверг, 15 октября, 4 хешвана, 4 события, Noa: 1'],
      [5, 'понедельник, 5 октября, 24 тишрея, 1 событие, Noa: 1'],
      [6, 'вторник, 6 октября, 25 тишрея, 2 события'],
      [20, 'вторник, 20 октября, 9 хешвана, 5 событий, Noa: 1'],
      [17, 'суббота, 17 октября, 6 хешвана, ничего не запланировано'],
    ];
    for (const [day, want] of literal) assert(cellOn(html, day).label === want, `day ${day}: ${cellOn(html, day).label}`);
    const modelCells = props.model.weeks.flat().filter((x) => x.inMonth);
    const wrong = modelCells.filter((x, i) => days(html)[i].label !== expectedLabel('ru', x, 'Noa', true));
    assert(wrong.length === 0, `labels off the recipe: ${show(wrong.map((x) => x.day))}`);
    assert(cellOn(html, 1).heb === '20 тишр.' && cellOn(html, 12).heb === '1 хешв.', `the short months: ${cellOn(html, 1).heb} ${cellOn(html, 12).heb}`);
    assert(c.dayLabel === 'пятница, 16 октября' && c.dayHebrew === '5 хешвана', `the day header: ${c.dayLabel} / ${c.dayHebrew}`);
    const onToday = chrome(render('ru', propsFor(store, picked(TODAY))));
    assert(onToday.dayLabel === 'Сегодня · четверг, 15 октября' && onToday.dayHebrew === '4 хешвана', `today: ${onToday.dayLabel} / ${onToday.dayHebrew}`);
    assert(/\.ch-mp-day-label::first-letter \{\s*text-transform: uppercase;\s*\}/.test(MONTH_PICKED_CSS), 'the day header starts with a capital ("Пятница")');
  });

  await check(`#5 the dots: filled for the viewer's items, a ring for the partner's, in slot order (bars, then all-day, then by time), at most ${PICKED_DOTS}, then "+N" (month.moreShort) in each language; a day with nothing drawn has none`, () => {
    const store = octoberStore();
    const want: [number, string[], string | null][] = [
      [5, ['is-partner'], null],
      [6, ['is-mine', 'is-mine'], null],
      [15, ['is-mine', 'is-mine', 'is-partner'], '+1'],
      [16, ['is-partner', 'is-mine'], null],
      [20, ['is-mine', 'is-mine', 'is-partner'], '+2'],
      [22, ['is-mine'], null],
      [23, ['is-mine'], null],
      [3, [], null],
    ];
    for (const locale of LOCALES) {
      const html = render(locale, propsFor(store, picked('2026-10-16')));
      for (const [day, dots, more] of want) {
        const cell = cellOn(html, day);
        assert(show(cell.dots) === show(dots) && cell.more === more && !cell.ghost, `${locale} day ${day}: ${show(cell.dots)} ${cell.more}`);
      }
    }
  });

  await check('#6 Ruling 5: a daily reminder is listed under its day but never dotted or counted: the 17th (only the daily reminder) has no dot and reads "nothing planned", yet its list shows the reminder and no "Nothing planned"; the 16th counts 2 and lists 3', () => {
    const store = octoberStore();
    const html17 = render('en', propsFor(store, picked('2026-10-17')));
    const cell17 = cellOn(html17, 17);
    assert(cell17.dots.length === 0 && cell17.more === null && cell17.label === 'Saturday, 17 October, 6 Cheshvan, nothing planned', `the 17th: ${show(cell17)}`);
    const c17 = chrome(html17);
    assert(show(c17.rows) === show(['Take vitamins']) && !c17.nothing, `the 17th's list: ${show(c17.rows)} nothing=${c17.nothing}`);
    assert(textOf(html17).includes('Reminder · every day'), 'the daily reminder reads "Reminder · every day"');
    const html16 = render('en', propsFor(store, picked('2026-10-16')));
    assert(cellOn(html16, 16).dots.length === 2 && cellOn(html16, 16).label?.includes('2 items'), `the 16th: ${show(cellOn(html16, 16))}`);
    assert(chrome(html16).rows.length === 3, 'the 16th lists 3 rows');
    const html15 = render('en', propsFor(store, picked(TODAY)));
    assert(cellOn(html15, 15).label?.includes('4 items') && chrome(html15).rows[0] === 'Take vitamins' && chrome(html15).rows.length === 5, `today: ${show(chrome(html15).rows)}`);
  });

  await check('#7 the chevrons at the window\'s ends (12 months back, 18 ahead): October 2025 has no previous month and April 2028 no next one; in real React a tap that reaches an end disables that chevron, a second tap calls nothing, and focus moves to the selected day', () => {
    const store = octoberStore();
    const first = chrome(render('en', propsFor(store, picked('2025-10-01'))));
    assert(first.month === 'October 2025' && show(first.chevrons.map((x) => x.disabled)) === show([true, false]), `October 2025: ${show(first.chevrons)}`);
    const last = chrome(render('en', propsFor(store, picked('2028-04-01'))));
    assert(last.month === 'April 2028' && show(last.chevrons.map((x) => x.disabled)) === show([false, true]), `April 2028: ${show(last.chevrons)}`);
    installWindow();
    for (const [start, cls, call, wantTitle, wantDay] of [
      ['2025-11-03', 0, 'prev', 'October 2025', '2025-10-01'],
      ['2028-03-31', 1, 'next', 'April 2028', '2028-04-01'],
    ] as const) {
      const seen: string[] = [];
      const m = mount(inHome('en', createElement(PickedHost, { store, start: picked(start), seen })));
      try {
        const chevron = byClass(m.container, 'ch-mp-chev')[cls];
        chevron.focus();
        pageLog.length = 0;
        m.click(chevron);
        assert(show(seen) === show([call]) && titleOf(m) === wantTitle, `${call}: ${show(seen)} ${titleOf(m)}`);
        assert(chevron.hasAttribute('disabled'), `the ${call} chevron is disabled at the end`);
        const selected = cellFor(m, wantDay);
        assert(selected.getAttribute('aria-pressed') === 'true' && fakeDocument.activeElement === selected, `focus after the end: ${fakeDocument.activeElement?.getAttribute?.('aria-label')}`);
        assert(show(pageLog) === show([`focus ${selected.getAttribute('aria-label')} {"preventScroll":true}`]), `no scroll, one focus: ${show(pageLog)}`);
        m.click(chevron);
        assert(show(seen) === show([call]), `a tap on the disabled chevron: ${show(seen)}`);
      } finally {
        m.unmount();
      }
    }
    // A chevron that stays enabled keeps the focus.
    const seen: string[] = [];
    const m = mount(inHome('en', createElement(PickedHost, { store, start: picked('2026-10-16'), seen })));
    try {
      const next = byClass(m.container, 'ch-mp-chev')[1];
      next.focus();
      m.click(next);
      assert(titleOf(m) === 'November 2026' && fakeDocument.activeElement === next, `November: ${titleOf(m)} ${fakeDocument.activeElement?.getAttribute?.('aria-label')}`);
      assert(cellFor(m, '2026-11-01').getAttribute('aria-pressed') === 'true', 'a step selects the 1st');
    } finally {
      m.unmount();
    }
  });

  await check('#8 the Today pill shows only while the selected day isn\'t today, and the day header reads "Today · …" only on today; in real React a tap on it calls onToday, the pill goes, and focus moves to today\'s cell, also from another month', () => {
    const store = octoberStore();
    const on = chrome(render('en', propsFor(store, picked(TODAY))));
    assert(on.today.length === 0 && on.dayLabel === 'Today · Thursday, 15 October' && on.dayHebrew === '4 Cheshvan', `on today: ${show(on.today)} ${on.dayLabel}`);
    const off = chrome(render('en', propsFor(store, picked('2026-10-03'))));
    assert(show(off.today) === show(['Today']) && off.dayLabel === 'Saturday, 3 October', `off today: ${show(off.today)} ${off.dayLabel}`);
    const away = chrome(render('en', propsFor(store, picked('2026-12-10'))));
    assert(show(away.today) === show(['Today']) && away.month === 'December 2026', 'in another month');
    installWindow();
    for (const start of ['2026-10-03', '2026-12-10']) {
      const seen: string[] = [];
      const m = mount(inHome('en', createElement(PickedHost, { store, start: picked(start), seen })));
      try {
        const pill = one(m.container, 'ch-mp-today');
        pill.focus();
        pageLog.length = 0;
        m.click(pill.childNodes[0]);
        assert(show(seen) === show(['today']) && byClass(m.container, 'ch-mp-today').length === 0, `${start}: ${show(seen)}`);
        assert(titleOf(m) === 'October 2026' && show(pressedDays(m)) === show(['Thursday, 15 October, 4 Cheshvan, 4 items, 1 from Noa']), `${start}: ${titleOf(m)} ${show(pressedDays(m))}`);
        const todayCell = cellFor(m, TODAY);
        assert(fakeDocument.activeElement === todayCell && show(pageLog) === show([`focus ${todayCell.getAttribute('aria-label')} {"preventScroll":true}`]), `${start}: focus ${show(pageLog)}`);
        assert(one(m.container, 'ch-mp-day-label').textContent === 'Today · Thursday, 15 October', 'the header moves to today');
      } finally {
        m.unmount();
      }
    }
  });

  await check('#9 the notices as rows above the grid, and the day\'s states: a failed month ("Couldn\'t load this month · Retry"), busy, calendars gone (Choose again), partial (Retry), never a reconnect; failed cells dimmed with no dots, loading cells a placeholder, never "nothing planned" in a label unless answered; under the day "Nothing planned" only when answered and empty, placeholders while loading, nothing when failed', () => {
    // A FamCal 500 on October, after the Agenda's week answered: the week's days are live, the rest failed.
    const failed = render('en', propsFor(failedStore('error'), picked('2026-10-03')));
    const f = chrome(failed);
    assert(show(f.notices) === show(['Couldn’t load this month Retry']), `the failed notice: ${show(f.notices)}`);
    const nav = markup(failed).indexOf('class="ch-mp-nav"');
    const notice = markup(failed).indexOf('class="ch-states ch-mp-states"');
    const weekdays = markup(failed).indexOf('class="ch-mp-weekdays"');
    assert(nav < notice && notice < weekdays, 'the notices sit between the nav and the grid');
    const cell3 = cellOn(failed, 3);
    assert(cell3.className === 'ch-mp-cell is-failed' && cell3.dots.length === 0 && !cell3.ghost && cell3.label === 'Saturday, 3 October, 22 Tishrei, couldn’t load', `a failed cell: ${show(cell3)}`);
    assert(cellOn(failed, 15).className === 'ch-mp-cell is-today' && cellOn(failed, 15).dots.length === 3, 'the Agenda week\'s days stay live');
    assert(!f.nothing && !f.ghosts && f.rows.length === 0 && !f.busy, 'a failed day: nothing under its header');
    // 429: busy.
    const busy = chrome(render('en', propsFor(failedStore('busy'), picked('2026-10-03'))));
    assert(show(busy.notices) === show(['Busy right now, try again in a minute Retry']), `busy: ${show(busy.notices)}`);
    // Loading: only the Agenda's week answered.
    const loading = render('en', propsFor(weekOnlyStore(), picked('2026-10-03')));
    const l = chrome(loading);
    assert(l.notices.length === 0, `no notice while loading: ${show(l.notices)}`);
    const cellL = cellOn(loading, 3);
    assert(cellL.className === 'ch-mp-cell is-loading' && cellL.ghost && cellL.dots.length === 0 && cellL.label === 'Saturday, 3 October, 22 Tishrei, loading', `a loading cell: ${show(cellL)}`);
    assert(l.ghosts && !l.nothing && l.busy, `a loading day: placeholders ${l.ghosts}, nothing ${l.nothing}, aria-busy ${l.busy}`);
    const labels = days(loading).map((x) => x.label ?? '');
    assert(labels.filter((x) => x.endsWith('nothing planned')).every((x) => /1[5-9] October|2[01] October/.test(x)), 'only answered days read "nothing planned"');
    // A day with items while Google failed or hasn't answered: the label says so after the items, as browse's does.
    const mixed = (google: NonNullable<RangeResponse['sources']['google']>) => storeOf([ok(answer({ items: OCTOBER_ITEMS, sources: { famcal: { status: 'ok' }, google } }))]);
    const mixedFailed = cellOn(render('en', propsFor(mixed({ status: 'error', reason: 'transient' }), picked('2026-10-03'))), 15).label;
    assert(mixedFailed === 'Thursday, 15 October, 4 Cheshvan, 4 items, 1 from Noa, couldn’t load', `items, then couldn't load: ${mixedFailed}`);
    const mixedLoading = cellOn(render('en', propsFor(mixed({ status: 'pending' }), picked('2026-10-03'))), 15).label;
    assert(mixedLoading === 'Thursday, 15 October, 4 Cheshvan, 4 items, 1 from Noa, loading', `items, then loading: ${mixedLoading}`);
    // Answered and empty.
    const empty = chrome(render('en', propsFor(octoberStore(), picked('2026-10-03'))));
    assert(empty.nothing && !empty.ghosts && empty.rows.length === 0 && textOf(render('en', propsFor(octoberStore(), picked('2026-10-03')))).includes('Nothing planned'), 'an answered empty day: "Nothing planned"');
    // Google: calendars gone, partial, reconnect.
    const gone = render('en', propsFor(googleStore({ status: 'error', reason: 'calendars_gone' }), picked('2026-10-03')));
    assert(show(chrome(gone).notices) === show(['Your calendars aren’t available Choose again']), `calendars gone: ${show(chrome(gone).notices)}`);
    const partial = render('en', propsFor(googleStore({ status: 'ok', partial: { failed: 1, truncated: 0 } }), picked('2026-10-03')));
    assert(show(chrome(partial).notices) === show(['Some calendars didn’t load Retry']) && chrome(partial).nothing, `partial: ${show(chrome(partial).notices)}`);
    const reconnect = render('en', propsFor(googleStore({ status: 'reconnect', reason: 'token' }), picked('2026-10-03')));
    assert(chrome(reconnect).notices.length === 0 && !/class="ch-states/.test(markup(reconnect)), `a reconnect makes no row: ${show(chrome(reconnect).notices)}`);
    assert(cellOn(reconnect, 3).className === 'ch-mp-cell is-failed' && !chrome(reconnect).nothing, 'a reconnect still never looks free');
    // month.ts never makes a reconnect notice; the view drops one anyway (MonthNotice's type allows it).
    const base = propsFor(googleStore({ status: 'reconnect', reason: 'scopes' }), picked('2026-10-03'));
    const forged = { ...base.model, notices: [{ source: 'google' as const, kind: 'failed' as const, failure: { kind: 'reconnect' as const, source: 'google' as const, reason: 'scopes' as const } }] };
    assert(chrome(render('en', { ...base, model: forged })).notices.length === 0, 'a reconnect notice never makes a row');
    for (const locale of ['he', 'ru'] as const) {
      const text = chrome(render(locale, propsFor(failedStore('error'), picked('2026-10-03')))).notices[0];
      const copy = messages[locale].calendarHome;
      assert(text === `${copy.month.failed} ${copy.actions.retry}`, `${locale}: ${text}`);
    }
  });

  await check('#10 every callback, in real React: a tap on a day selects it (and a tap on the selected day calls nothing), the chevrons, Today, All months, a row opens its item, Retry asks the month again for its source, Choose again', () => {
    installWindow();
    const seen: string[] = [];
    const m = mount(inHome('en', createElement(PickedHost, { store: octoberStore(), start: picked('2026-10-16'), seen })));
    try {
      m.click(cellFor(m, '2026-10-20').childNodes[0]);
      assert(show(seen) === show(['select 2026-10-20']) && show(pressedDays(m)) === show(['Tuesday, 20 October, 9 Cheshvan, 5 items, 1 from Noa']), `a tap: ${show(seen)}`);
      m.click(cellFor(m, '2026-10-20'));
      assert(seen.length === 1, `a tap on the selected day: ${show(seen)}`);
      assert(show(byClass(m.container, 'ch-title').map((e) => e.textContent)) === show(BUSY_DAY.map((x) => x.title)), 'the 20th\'s rows');
      m.click(byClass(m.container, 'ch-row')[2]);
      assert(seen[1] === 'open famcal|busy-2', `a row: ${show(seen)}`);
      m.click(one(m.container, 'ch-mp-today'));
      m.click(one(m.container, 'ch-mp-back').childNodes[1]);
      assert(show(seen.slice(2)) === show(['today', 'allMonths']) && show(pressedDays(m)) === show(['Thursday, 15 October, 4 Cheshvan, 4 items, 1 from Noa']), `Today and All months: ${show(seen)}`);
      const [prev, next] = byClass(m.container, 'ch-mp-chev');
      m.click(next);
      assert(titleOf(m) === 'November 2026', `next: ${titleOf(m)}`);
      m.click(prev);
      assert(show(seen.slice(4)) === show(['next', 'prev']) && titleOf(m) === 'October 2026', `the chevrons: ${show(seen)}`);
    } finally {
      m.unmount();
    }
    for (const [store, want] of [
      [failedStore('error'), 'retry 2026-10 famcal'],
      [failedStore('busy'), 'retry 2026-10 famcal'],
      [googleStore({ status: 'ok', partial: { failed: 0, truncated: 2 } }), 'retry 2026-10 google'],
      [googleStore({ status: 'error', reason: 'transient' }), 'retry 2026-10 google'],
      [googleStore({ status: 'error', reason: 'calendars_gone' }), 'choose'],
    ] as const) {
      const got: string[] = [];
      const n = mount(inHome('en', createElement(PickedHost, { store, start: picked('2026-10-03'), seen: got })));
      try {
        n.click(one(n.container, 'ch-state-action'));
        assert(show(got) === show([want]), `the notice's action: ${show(got)}, want ${want}`);
      } finally {
        n.unmount();
      }
    }
  });

  await check('#11 on mount the page scrolls to the top, then focus goes to the selected day without a scroll (Ruling 6); later taps neither scroll nor move focus; each mount does it again', () => {
    installWindow();
    pageLog.length = 0;
    const seen: string[] = [];
    const m = mount(inHome('en', createElement(PickedHost, { store: octoberStore(), start: picked('2026-10-16'), seen })));
    try {
      const sixteenth = cellFor(m, '2026-10-16');
      assert(show(pageLog) === show(['scrollTo [0,0]', `focus ${sixteenth.getAttribute('aria-label')} {"preventScroll":true}`]), `on mount: ${show(pageLog)}`);
      assert(fakeDocument.activeElement === sixteenth, 'focus on the selected day');
      pageLog.length = 0;
      m.click(cellFor(m, '2026-10-20'));
      m.click(byClass(m.container, 'ch-mp-chev')[1]);
      m.click(cellFor(m, '2026-11-05'));
      assert(pageLog.length === 0 && fakeDocument.activeElement === sixteenth, `later taps: ${show(pageLog)}`);
    } finally {
      m.unmount();
    }
    pageLog.length = 0;
    const again = mount(inHome('ru', createElement(PickedHost, { store: octoberStore(), start: picked(TODAY), seen })));
    try {
      const today = cellFor(again, TODAY, 'ru');
      assert(show(pageLog) === show(['scrollTo [0,0]', `focus ${today.getAttribute('aria-label')} {"preventScroll":true}`]), `a new mount: ${show(pageLog)}`);
    } finally {
      again.unmount();
    }
  });

  await check(`#12 the CSS: nothing under 11 px (the Hebrew day and "+N" at 11), every size in px; All months, Today and the chevrons at least 44 × 44; cells PICKED_CELL_PX (${PICKED_CELL_PX}) tall, within 46–48; logical properties only; no hover; overflow: hidden only on the Hebrew line; the bottom safe area; dots filled or a 1.5 px ring; today, selected and disabled colours; only tokens the theme defines; the markup's buttons, icons and style sheets`, () => {
    const css = MONTH_PICKED_CSS;
    const rule = (selector: string) => {
      const m = new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(css);
      assert(m, `no rule ${selector}`);
      return m[1];
    };
    const sizes = [...css.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
    assert(sizes.length >= 8 && Math.min(...sizes) >= 11, `font sizes: ${show(sizes)}`);
    assert(!/font-size:\s*[\d.]+(?:em|rem|%)|font:\s/.test(css), 'every font size in px');
    assert(/font-size: 11px/.test(rule('.ch-mp-heb')) && /font-size: 11px/.test(rule('.ch-mp-more')), 'the Hebrew day and "+N" at 11 px');
    for (const selector of ['.ch-mp-back', '.ch-mp-today', '.ch-mp-chev']) {
      const r = rule(selector);
      assert(/min-height: 44px/.test(r) && /min-width: 44px/.test(r), `${selector}: ${r}`);
    }
    assert(/inline-size: 44px/.test(rule('.ch-mp-chev')) && /block-size: 44px/.test(rule('.ch-mp-chev')), 'the chevrons are 44 × 44');
    const cell = rule('.ch-mp-cell');
    assert(PICKED_CELL_PX >= 46 && PICKED_CELL_PX <= 48 && cell.includes(`block-size: ${PICKED_CELL_PX}px`) && /min-height: 44px/.test(cell), `the cell: ${cell}`);
    const physical = css.match(/(?:margin|padding|border)-(?:left|right|top|bottom)|(?:^|[\s;{])(?:left|right|top|bottom)\s*:|text-align:\s*(?:left|right)|float:|(?:^|[\s;{])(?:width|height)\s*:/g);
    assert(!physical, `physical properties: ${show(physical)}`);
    assert(!/:hover/.test(css), 'no hover styles');
    const hidden = [...css.matchAll(/\n([^\n{]+) \{[^}]*overflow:\s*hidden/g)].map((m) => m[1]);
    assert(show(hidden) === show(['.ch-mp-heb']), `overflow: hidden on ${show(hidden)}`);
    assert(rule('.ch-mp').includes('var(--tg-safe-area-inset-bottom, 0px)') && /padding-block-end:/.test(rule('.ch-mp')), `the bottom safe area: ${rule('.ch-mp')}`);
    assert(/background: var\(--ch-dot-mine\)/.test(rule('.ch-mp-dot.is-mine')) && /border: 1\.5px solid var\(--ch-dot-partner\)/.test(rule('.ch-mp-dot.is-partner')), 'filled dots and rings');
    assert(/color: var\(--ch-accent\)/.test(rule('.ch-mp-cell.is-today .ch-mp-num')), 'today\'s number as text reads --ch-accent (E4 note 3)');
    assert(/background: var\(--ch-selected\)/.test(rule(".ch-mp-cell[aria-pressed='true'] .ch-mp-num")) && /background: var\(--ch-today\)/.test(rule(".ch-mp-cell.is-today[aria-pressed='true'] .ch-mp-num")), 'the selected day and today selected');
    assert(/color: var\(--ch-disabled\)/.test(rule('.ch-mp-chev:disabled')) && /color: var\(--ch-muted\)/.test(rule('.ch-mp-cell.is-failed .ch-mp-num')), 'disabled and dimmed');
    assert(/background: var\(--ch-pill-bg\)/.test(rule('.ch-mp-today-pill')) && /color: var\(--ch-pill-text\)/.test(rule('.ch-mp-today-pill')), 'the pill');
    assert(/outline: 2px solid var\(--ch-accent\)/.test(css), 'a focus ring');
    assert(/\.ch-home\[dir='rtl'\] \.ch-flip \{\s*transform: scaleX\(-1\);/.test(HOME_SHELL_CSS), 'the shell flips .ch-flip in RTL');
    const defined = new Set([...(HOME_THEME_CSS + HOME_SHELL_CSS + AGENDA_CSS).matchAll(/(--ch-[\w-]+)\s*:/g)].map((m) => m[1]));
    const used = [...new Set([...css.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]))];
    const undefinedTokens = used.filter((n) => !n.startsWith('--tg-') && !defined.has(n));
    assert(used.length >= 15 && undefinedTokens.length === 0, `tokens read but not defined: ${show(undefinedTokens)}`);
    assert(/@keyframes ch-pulse/.test(AGENDA_CSS) && /prefers-reduced-motion: reduce/.test(HOME_THEME_CSS), 'the placeholder pulse is D\'s, and reduced motion stops it');
    const html = render('en', propsFor(octoberStore(), picked('2026-10-16')));
    const buttons = markup(html).match(/<button[^>]*>/g) ?? [];
    assert(buttons.length > 35 && buttons.every((b) => b.includes('type="button"')), `buttons: ${show(buttons.filter((b) => !b.includes('type="button"')))}`);
    const blocks = (markup(html).match(/<button[^>]*>(?:(?!<\/button>)[\s\S])*<\/button>/g) ?? []).filter((b) => /<(?:div|p|h\d|ul|li|section)[\s>]/.test(b));
    assert(blocks.length === 0, `block elements inside a button: ${show(blocks.slice(0, 2))}`);
    const svgs = markup(html).match(/<svg[^>]*>/g) ?? [];
    assert(svgs.length >= 3 && svgs.every((s) => s.includes('aria-hidden="true"')), 'icons are aria-hidden');
    assert(html.includes('.ch-row {') && html.includes('.ch-mp-cell {'), 'D\'s AGENDA_CSS and the picked CSS are both rendered');
  });

  await check('#13 a short screen (Ruling 6): entering picked goes to the top while the header, the tabs, the bar, the month and the day\'s first row fit; else only as far down as shows the day\'s header and its first row, never past the bar (pickedScrollTop): E7\'s fixed heights for 6 rows, with and without the trial and location banners, on 390 × 844, 375 × 667 and 320 × 568; in real React, one scroll to where the layout and its day header measure, less the layout\'s scroll margin (the safe areas)', () => {
    const css = MONTH_PICKED_CSS;
    const rule = (selector: string) => {
      const m = new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(css);
      assert(m, `no rule ${selector}`);
      return m[1];
    };
    const decl = (selector: string, prop: string) => (new RegExp(`(?:^|[\\s;])${prop}:\\s*([^;]+);`).exec(rule(selector))?.[1] ?? '').trim().split(/\s+/).map((v) => Number.parseFloat(v) || 0);
    // The layout's fixed heights down to the end of the day's header, from its CSS.
    const bar = decl('.ch-mp-bar', 'margin-block')[0] + decl('.ch-mp-back', 'min-height')[0];
    const nav = decl('.ch-mp-chev', 'block-size')[0] + decl('.ch-mp-nav', 'margin-block')[1];
    const weekdays = decl('.ch-mp-weekdays', 'padding-block').reduce((a, b) => a + b, 0) + decl('.ch-mp-weekdays', 'line-height')[0] + 1;
    const dayHead = decl('.ch-mp-day', 'margin-block').reduce((a, b) => a + b, 0) + Math.ceil(decl('.ch-mp-day', 'font-size')[0] * decl('.ch-mp-day', 'line-height')[0]);
    assert(show([bar, nav, weekdays, dayHead]) === show([50, 46, 27, 37]), `the bar, the nav, the weekday row and the day's header: ${show([bar, nav, weekdays, dayHead])}`);
    const head = (rows: number) => bar + nav + weekdays + rows * PICKED_CELL_PX + dayHead;
    // Above the layout (D's and E4's CSS): the header with its Hebrew line (16 + 27.5 + 19 + 12),
    // the tab bar (44 + 4), and the trial and location banners (4 + 56 + 8 + 56).
    const above = (banners: boolean) => 75 + 48 + (banners ? 124 : 0);
    const cases: [string, number, number, boolean, number][] = [
      ['390 × 844 (the mockups\' phone), 6 rows', 740, 6, false, 0],
      ['390 × 844, 6 rows, two banners', 740, 6, true, 19],
      ['375 × 667, 5 rows', 560, 5, false, 27],
      ['375 × 667, 6 rows', 560, 6, false, 75],
      ['375 × 667, 6 rows, two banners', 560, 6, true, 199],
      ['320 × 568, 6 rows', 470, 6, false, 123],
      ['320 × 568, 6 rows, two banners', 470, 6, true, 247],
    ];
    for (const [label, viewport, rows, banners, want] of cases) {
      const layoutTop = above(banners);
      const end = layoutTop + head(rows);
      const top = pickedScrollTop(layoutTop, end, viewport);
      assert(top === want, `${label}: ${top} (want ${want})`);
      assert(top <= layoutTop, `${label}: scrolled past the bar`);
      assert(end - top <= viewport, `${label}: the day's header is off screen`);
      if (top < layoutTop) assert(end + PICKED_FIRST_ROW_PX - top <= viewport, `${label}: the day's first row is off screen`);
    }
    // The layout stops under the safe areas when it goes to the top of the screen.
    assert(/scroll-margin-block-start: calc\(var\(--tg-safe-area-inset-top, 0px\) \+ var\(--tg-content-safe-area-inset-top, 0px\)\);/.test(rule('.ch-mp')), `the layout's scroll margin: ${rule('.ch-mp')}`);
    // In real React: the layout and its day header measure where the banners left them.
    installWindow();
    const proto = FakeElement.prototype as unknown as Row;
    const saved = { innerHeight: fakeWindow.innerHeight, scrollY: fakeWindow.scrollY, getComputedStyle: fakeWindow.getComputedStyle };
    const at = { layout: 0, dayHead: 0, margin: 0 };
    proto.getBoundingClientRect = function (this: FakeElement) {
      const y = Number(fakeWindow.scrollY) || 0;
      const top = this.className.split(' ').includes('ch-mp') ? at.layout : this.getAttribute('id') === 'ch-mp-day' ? at.dayHead - 37 : 0;
      const height = this.getAttribute('id') === 'ch-mp-day' ? 37 : 0;
      return { top: top - y, bottom: top - y + height, left: 0, right: 0, width: 0, height, x: 0, y: top - y };
    };
    fakeWindow.getComputedStyle = (el: FakeElement) => ({ scrollMarginBlockStart: el.className.split(' ').includes('ch-mp') ? `${at.margin}px` : '0px', scrollMarginTop: '0px' });
    try {
      const run = (layout: number, dayHeadBottom: number, viewport: number, margin: number) => {
        Object.assign(at, { layout, dayHead: dayHeadBottom, margin });
        fakeWindow.innerHeight = viewport;
        fakeWindow.scrollY = 0;
        pageLog.length = 0;
        const m = mount(inHome('en', createElement(PickedHost, { store: octoberStore(), start: picked('2026-10-16'), seen: [] })));
        try {
          return pageLog.filter((l) => l.startsWith('scrollTo'));
        } finally {
          m.unmount();
        }
      };
      const sixRows = 75 + 48 + 124 + head(6);
      assert(show(run(247, sixRows, 560, 0)) === show(['scrollTo [0,199]']), `375 × 667 with two banners: ${show(pageLog)}`);
      assert(show(run(247, sixRows, 470, 20)) === show(['scrollTo [0,227]']), `320 × 568 with two banners, a 20 px safe area: ${show(pageLog)}`);
      assert(show(run(247, sixRows, 800, 0)) === show(['scrollTo [0,0]']), `a tall screen: ${show(pageLog)}`);
    } finally {
      delete proto.getBoundingClientRect;
      Object.assign(fakeWindow, saved);
      if (!saved.getComputedStyle) delete fakeWindow.getComputedStyle;
    }
  });

  await check('#14 React logged no warning in any render (keys, nesting, attributes, act)', () => {
    assert(reactWarnings.length === 0, show(reactWarnings));
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Run it and see it fail; record the regression smokes' baseline**

```bash
cd /Users/razielgershoni/development/famcalbot
E="DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake"
for tz in UTC Asia/Jerusalem; do
  eval "env TZ=$tz $E npx tsx scripts/smoke-calendar-month-picked.ts" > /tmp/e7-picked-before.log 2>&1; echo "TZ=$tz exit $?"; grep -m1 'Cannot find module' /tmp/e7-picked-before.log
done
npx tsc --noEmit -p . 2>&1 | grep 'error TS'
for f in smoke-initdata-header smoke-auth-leftovers smoke-auth-identity smoke-calendar-home-render smoke-calendar-month smoke-calendar-home-tabs smoke-calendar-home-copy check-i18n-parity; do
  for tz in UTC Asia/Jerusalem; do
    eval "env TZ=$tz $E npx tsx scripts/$f.ts" > /tmp/e7-$f.log 2>&1; echo "$f TZ=$tz exit $?"
    grep -E '^(OK|FAIL)|passed|parity' /tmp/e7-$f.log > /tmp/e7-$f-${tz//\//_}.before; tail -1 /tmp/e7-$f-${tz//\//_}.before
  done
done
```

Expected for the new smoke, under each clock (tsx may also print `DEP0205` deprecation warnings on stderr; ignore them):
```
TZ=UTC exit 1
Error: Cannot find module '../app/[locale]/dashboard/MonthPicked'
TZ=Asia/Jerusalem exit 1
Error: Cannot find module '../app/[locale]/dashboard/MonthPicked'
```
Expected from `tsc` (exit 2). The TS7006 lines follow from the missing props type:
```
scripts/smoke-calendar-month-picked.ts(38,70): error TS2307: Cannot find module '../app/[locale]/dashboard/MonthPicked' or its corresponding type declarations.
scripts/smoke-calendar-month-picked.ts(632,21): error TS7006: Parameter 'day' implicitly has an 'any' type.
scripts/smoke-calendar-month-picked.ts(649,20): error TS7006: Parameter 'row' implicitly has an 'any' type.
scripts/smoke-calendar-month-picked.ts(650,22): error TS7006: Parameter 'month' implicitly has an 'any' type.
scripts/smoke-calendar-month-picked.ts(650,29): error TS7006: Parameter 'source' implicitly has an 'any' type.
scripts/smoke-calendar-month-picked.ts(710,57): error TS7006: Parameter 'x' implicitly has an 'any' type.
scripts/smoke-calendar-month-picked.ts(711,38): error TS7006: Parameter 'x' implicitly has an 'any' type.
scripts/smoke-calendar-month-picked.ts(711,41): error TS7006: Parameter 'i' implicitly has an 'any' type.
scripts/smoke-calendar-month-picked.ts(712,74): error TS7006: Parameter 'x' implicitly has an 'any' type.
scripts/smoke-calendar-month-picked.ts(770,57): error TS7006: Parameter 'x' implicitly has an 'any' type.
scripts/smoke-calendar-month-picked.ts(771,38): error TS7006: Parameter 'x' implicitly has an 'any' type.
scripts/smoke-calendar-month-picked.ts(771,41): error TS7006: Parameter 'i' implicitly has an 'any' type.
scripts/smoke-calendar-month-picked.ts(772,74): error TS7006: Parameter 'x' implicitly has an 'any' type.
```
Expected for the regression smokes: every run prints `exit 0`, with these last lines: `9/9 passed` (initdata-header), `9/9 passed` (auth-leftovers), `26/26 passed` (auth-identity), `42/42 passed (process TZ=…)` (home-render), `26/26 passed (process TZ=…)` (month), `11/11 passed (process TZ=…)` (home-tabs), `18/18 passed` (home-copy), `i18n parity OK (1013 keys)`. The `/tmp/e7-*.before` files are the baseline for Step 5.

- [ ] **Step 3: Create `app/[locale]/dashboard/MonthPicked.tsx`**

The component and its style sheet. Create `app/[locale]/dashboard/MonthPicked.tsx` with exactly this content:

```tsx
'use client';

// The Month's picked layout (spec §7.4 "Tap a day → picked", §7.7, §7.8; Rulings R11
// and R12; Plan E Rulings 4, 5, 6 and 8; the approved MonthPicked.dc.html): one month,
// compact, with the picked day's list under it. Presentational: MonthView (E8) holds
// the layout (month.ts's MonthUi), builds the model with monthModels, passes the day's
// rows (dayRows) and status (dayStatus), and owns Telegram's BackButton and the item
// sheet. From top to bottom:
// - the bar: "All months" (back to browse) and, while a day other than today is
//   selected, the Today pill;
// - the nav: the previous and next chevrons, disabled at the window's ends, around the
//   month's title with its year and, when on, its Hebrew months, read out when it
//   changes (aria-live="polite");
// - the month's notices as rows (failed, busy, calendars gone, partial), with Retry or
//   Choose again. Never a reconnect: the Reconnect banner says it;
// - the weekday row from the week start, then the compact grid: one 48 px button per
//   day of the month, with the Gregorian day, the Hebrew day at 11 px (with the month's
//   short name on Hebrew day 1 and on the month's first day), and up to 3 dots, filled
//   for the viewer's items and a ring for the partner's, then "+N". Daily reminders get
//   no dot (Ruling 5). A loading day shows a placeholder and a failed one is dimmed, so
//   a day looks free only once it is answered;
// - the day: "Today · Thursday, 15 October" (or the weekday and date) with the Hebrew
//   day, then the Agenda's rows (D's ItemRow), daily reminders included. "Nothing
//   planned" shows only once the day is answered and empty; placeholders while it
//   loads; nothing when it failed (the notice above says why).
//
// On mount the page scrolls to the top, so the header, the tabs, the bar, the month and
// the start of the list fit in one screen, and focus goes to the selected day (Ruling 6,
// spec §7.7). On a screen too short for all of that (a 6-row month under the trial and
// location banners on a 375 × 667 phone), it scrolls only as far down as shows the day's
// header and its first row, never past this layout's bar (month.ts's pickedScrollTop).
// When the control that had focus goes away (the Today pill once today is selected, a
// chevron that is disabled at the window's end), focus moves to the selected day as
// well, never to the page.
//
// Each day's button reads like browse's: "Thursday, 15 October, 4 Cheshvan, 3 items,
// 1 from Noa", or "nothing planned", "loading" or "couldn't load" in place of the counts
// (E1's parts, joined with ", "). aria-pressed marks the selected day and
// aria-current="date" today. Blank cells, the days of the months around it, are
// aria-hidden.
//
// Mobile Mini App rules: taps of 44 px or more, nothing under 11 px, logical properties
// only, the chevrons flipped in RTL (.ch-flip), no hover styles. The rows' styles are D's
// AGENDA_CSS, rendered here as well, because the Agenda isn't mounted on the Month tab
// (they also style the item sheet MonthView opens over this layout).

import { useEffect, useRef } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import type { AgendaRow } from '@/src/lib/calendar-view/agenda';
import { formatDayLong, formatMonthTitle, formatWeekdayHeader } from '@/src/lib/calendar-view/format';
import { weekdayOrder, type MonthKey } from '@/src/lib/calendar-view/grid';
import { hebrewCellLabel, hebrewDayLabel, hebrewMonthHeader } from '@/src/lib/calendar-view/hebrew-date';
import { PICKED_CELL_PX, limitDots, pickedScrollTop, type MonthCell, type MonthModel } from '@/src/lib/calendar-view/month';
import type { DayStatus } from '@/src/lib/calendar-view/store';
import type { DayKey, SourceName, WeekStart } from '@/src/lib/calendar-view/types';
import { AGENDA_CSS } from './AgendaView';
import { PlaceholderRows } from './DayList';
import { ItemRow } from './ItemRow';

export interface MonthPickedProps {
  /** The picked month's model (monthModels(store)(ui.month)). */
  model: MonthModel;
  /** The selected day: a day of model.month. */
  selected: DayKey;
  today: DayKey;
  tz: string;
  weekStart: WeekStart;
  hebrewDates: boolean;
  /** canStep(ui, -1, today) and canStep(ui, 1, today): false at the window's ends. */
  canPrev: boolean;
  canNext: boolean;
  /** The selected day's rows (dayRows: the Agenda's, daily reminders included) and its status (dayStatus). */
  rows: AgendaRow[];
  dayStatus: DayStatus;
  /** A tap on another day. Never called with the day already selected. */
  onSelectDay: (day: DayKey) => void;
  onPrev: () => void;
  onNext: () => void;
  /** The Today pill: today selected, in today's month. */
  onToday: () => void;
  /** "All months": back to browse, with this month under the bar. */
  onAllMonths: () => void;
  /** A tap on a row: open its item sheet. */
  onOpenItem: (row: AgendaRow) => void;
  /** Retry on a notice: ask the month again, for that source. */
  onRetryMonth: (month: MonthKey, source: SourceName) => void;
  /** "Choose again" (calendars gone): the existing select-calendars page. */
  onChooseCalendars: () => void;
}

/** A chevron: back (towards the start) or forward. Flipped in RTL by .ch-flip. */
function Chevron({ back }: { back: boolean }) {
  return (
    <svg className="ch-flip" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={back ? 'M15 18l-6-6 6-6' : 'M9 18l6-6-6-6'} />
    </svg>
  );
}

/** The notice's icon, as the Agenda's state rows draw it. */
function StateIcon() {
  return (
    <svg className="ch-icon ch-state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5.5M12 16.5v.01" />
    </svg>
  );
}

type NoticeRow = { key: string; text: string; action: string; onAction: () => void };

/**
 * The month's notices (Ruling 4) as the Agenda's state rows: failed with an error →
 * "Couldn't load this month", busy → "Busy…", calendars gone → "Your calendars aren't
 * available" with Choose again, partial → "Some calendars didn't load"; each of the
 * others with Retry for its source. A reconnect never makes a row.
 */
function NoticeRows({ model, onRetryMonth, onChooseCalendars }: Pick<MonthPickedProps, 'model' | 'onRetryMonth' | 'onChooseCalendars'>) {
  const t = useTranslations('calendarHome');
  const rows: NoticeRow[] = [];
  for (const notice of model.notices) {
    const retry = () => onRetryMonth(model.month, notice.source);
    const key = `${notice.kind}-${notice.source}`;
    if (notice.kind === 'partial') {
      rows.push({ key, text: t('state.partial'), action: t('actions.retry'), onAction: retry });
      continue;
    }
    const failure = notice.failure;
    if (failure?.kind === 'reconnect') continue;
    if (failure?.kind === 'calendarsGone') rows.push({ key, text: t('state.calendarsGone'), action: t('actions.chooseAgain'), onAction: onChooseCalendars });
    else if (failure?.kind === 'busy') rows.push({ key, text: t('state.busy'), action: t('actions.retry'), onAction: retry });
    else rows.push({ key, text: t('month.failed'), action: t('actions.retry'), onAction: retry });
  }
  if (rows.length === 0) return null;
  return (
    <div className="ch-states ch-mp-states">
      {rows.map((row) => (
        <div key={row.key} className="ch-state" role="status">
          <StateIcon />
          <span className="ch-state-text">{row.text}</span>
          <button type="button" className="ch-btn ch-state-action" onClick={row.onAction}>
            {row.action}
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * A day's accessible name, as browse's cells read (E1's parts joined with ", "): the
 * weekday and date, the Hebrew day when it's on, then the drawn items and how many are
 * the partner's, then "loading" / "couldn't load", or "nothing planned" when answered and empty.
 */
function useCellLabel(partner: string | null, hebrewDates: boolean): (cell: MonthCell) => string {
  const t = useTranslations('calendarHome');
  const locale = useLocale();
  // calendarHome.hebrewMonthGenitive: only Russian reads it (Ruling R9).
  const genitive = hebrewDates && locale === 'ru' ? (t.raw('hebrewMonthGenitive') as string[]) : undefined;
  return (cell) => {
    const parts = [formatDayLong(cell.day, locale)];
    if (hebrewDates) parts.push(hebrewDayLabel(cell.day, locale, genitive));
    if (cell.count > 0) {
      parts.push(t('month.cellItems', { count: cell.count }));
      if (cell.fromPartner > 0 && partner) parts.push(t('month.cellFromPartner', { count: cell.fromPartner, name: partner }));
    }
    if (cell.status !== 'answered') parts.push(cell.status === 'loading' ? t('month.cellLoading') : t('month.cellFailed'));
    else if (cell.count === 0) parts.push(t('month.cellNothing'));
    return parts.filter((part) => part !== '').join(', ');
  };
}

/** A day's marks: up to PICKED_DOTS dots (filled: the viewer's; a ring: the partner's), then "+N"; a placeholder while it loads. */
function Marks({ cell }: { cell: MonthCell }) {
  const t = useTranslations('calendarHome');
  if (cell.count === 0 && cell.status === 'loading') return <span className="ch-mp-ghost" />;
  const { shown, more } = limitDots(cell.dots);
  return (
    <>
      {shown.map((mine, i) => (
        <span key={i} className={`ch-mp-dot ${mine ? 'is-mine' : 'is-partner'}`} />
      ))}
      {more > 0 ? (
        <span className="ch-mp-more" dir="ltr">
          {t('month.moreShort', { count: more })}
        </span>
      ) : null}
    </>
  );
}

/** Which control a tap left focus on, if it may go away (the Today pill) or be disabled (a chevron at an end). */
type Refocus = 'today' | 'prev' | 'next' | null;

/**
 * Where entering picked scrolls the page (Ruling 6, pickedScrollTop): from where the
 * layout starts, less its scroll margin (the safe areas it stops under), and where the
 * day's header ends, in the document, and the screen's height. The top (0) wherever the
 * page can't be measured.
 */
function enterTop(layout: HTMLElement | null, dayHead: HTMLElement | null): number {
  try {
    if (!layout || !dayHead || typeof layout.getBoundingClientRect !== 'function' || typeof dayHead.getBoundingClientRect !== 'function') return 0;
    const y = window.scrollY || 0;
    let margin = 0;
    try {
      const style = window.getComputedStyle(layout);
      margin = Number.parseFloat(style.scrollMarginBlockStart || style.scrollMarginTop) || 0;
    } catch {
      // No scroll margin to read: the layout goes to the very top.
    }
    return pickedScrollTop(layout.getBoundingClientRect().top + y - margin, dayHead.getBoundingClientRect().bottom + y, window.innerHeight || 0);
  } catch {
    return 0;
  }
}

export function MonthPicked({
  model,
  selected,
  today,
  tz,
  weekStart,
  hebrewDates,
  canPrev,
  canNext,
  rows,
  dayStatus,
  onSelectDay,
  onPrev,
  onNext,
  onToday,
  onAllMonths,
  onOpenItem,
  onRetryMonth,
  onChooseCalendars,
}: MonthPickedProps) {
  const t = useTranslations('calendarHome');
  const locale = useLocale();
  const label = useCellLabel(model.partner, hebrewDates);
  const selectedCell = useRef<HTMLButtonElement | null>(null);
  const layout = useRef<HTMLElement | null>(null);
  const dayHead = useRef<HTMLHeadingElement | null>(null);
  const refocus = useRef<Refocus>(null);

  // Entering picked (Ruling 6, spec §7.7): the page to the top (or, on a short screen, as
  // far down as shows the day's header and first row), focus on the selected day.
  useEffect(() => {
    window.scrollTo(0, enterTop(layout.current, dayHead.current));
    selectedCell.current?.focus({ preventScroll: true });
  }, []);

  // After a tap on Today or a chevron: when that control is gone or disabled, focus goes
  // to the selected day rather than to the page.
  useEffect(() => {
    const from = refocus.current;
    refocus.current = null;
    if (from === 'today' || (from === 'prev' && !canPrev) || (from === 'next' && !canNext)) {
      selectedCell.current?.focus({ preventScroll: true });
    }
  }, [selected, canPrev, canNext]);

  // calendarHome.hebrewMonthGenitive (Russian only) and hebrewMonthShort (14 names each, D2's HEBREW_MONTHS order).
  const genitive = hebrewDates && locale === 'ru' ? (t.raw('hebrewMonthGenitive') as string[]) : undefined;
  const shortMonths = hebrewDates ? (t.raw('hebrewMonthShort') as string[]) : undefined;
  const range = hebrewDates ? hebrewMonthHeader(model.month, locale) : '';
  const date = formatDayLong(selected, locale);
  const dayTitle = selected === today ? t('month.dayToday', { date }) : date;
  const dayHebrew = hebrewDates ? hebrewDayLabel(selected, locale, genitive) : '';
  const loading = dayStatus === 'loading';

  return (
    <section className="ch-mp" dir={locale === 'he' ? 'rtl' : 'ltr'} ref={layout}>
      <style>{AGENDA_CSS}</style>
      <style>{MONTH_PICKED_CSS}</style>
      <div className="ch-mp-bar">
        <button type="button" className="ch-mp-back" onClick={onAllMonths}>
          <Chevron back />
          <span>{t('month.allMonths')}</span>
        </button>
        {selected !== today ? (
          <button
            type="button"
            className="ch-mp-today"
            onClick={() => {
              refocus.current = 'today';
              onToday();
            }}
          >
            <span className="ch-mp-today-pill">{t('month.today')}</span>
          </button>
        ) : null}
      </div>
      <div className="ch-mp-nav">
        <button
          type="button"
          className="ch-mp-chev"
          aria-label={t('month.previous')}
          disabled={!canPrev}
          onClick={() => {
            refocus.current = 'prev';
            onPrev();
          }}
        >
          <Chevron back />
        </button>
        <h2 className="ch-mp-title" aria-live="polite">
          <span className="ch-mp-month">{formatMonthTitle(model.month, locale, true)}</span>
          {range ? <span className="ch-mp-range">{range}</span> : null}
        </h2>
        <button
          type="button"
          className="ch-mp-chev"
          aria-label={t('month.next')}
          disabled={!canNext}
          onClick={() => {
            refocus.current = 'next';
            onNext();
          }}
        >
          <Chevron back={false} />
        </button>
      </div>
      <NoticeRows model={model} onRetryMonth={onRetryMonth} onChooseCalendars={onChooseCalendars} />
      <div className="ch-mp-weekdays" aria-hidden="true">
        {weekdayOrder(weekStart).map((weekday) => (
          <span key={weekday}>{formatWeekdayHeader(weekday, locale)}</span>
        ))}
      </div>
      <div className="ch-mp-grid">
        {model.weeks.flat().map((cell) => {
          if (!cell.inMonth) return <span key={`blank-${cell.day}`} className="ch-mp-cell ch-mp-blank" aria-hidden="true" />;
          const isSelected = cell.day === selected;
          const state = cell.status === 'loading' ? ' is-loading' : cell.status === 'failed' ? ' is-failed' : '';
          return (
            <button
              key={cell.day}
              ref={isSelected ? selectedCell : undefined}
              type="button"
              className={`ch-mp-cell${cell.today ? ' is-today' : ''}${state}`}
              aria-label={label(cell)}
              aria-pressed={isSelected}
              aria-current={cell.today ? 'date' : undefined}
              onClick={() => {
                if (!isSelected) onSelectDay(cell.day);
              }}
            >
              <span className="ch-mp-num" aria-hidden="true">
                {Number(cell.day.slice(8, 10))}
              </span>
              {hebrewDates ? (
                <span className="ch-mp-heb" aria-hidden="true">
                  {hebrewCellLabel(cell.day, locale, cell.hebrewMonthStart, shortMonths)}
                </span>
              ) : null}
              <span className="ch-mp-marks" aria-hidden="true">
                <Marks cell={cell} />
              </span>
            </button>
          );
        })}
      </div>
      <section className="ch-mp-list" aria-labelledby="ch-mp-day" aria-busy={loading || undefined}>
        <h3 className="ch-mp-day" id="ch-mp-day" ref={dayHead}>
          <span className="ch-mp-day-label">{dayTitle}</span>
          {dayHebrew ? (
            <>
              {' '}
              <span className="ch-mp-day-hebrew">{dayHebrew}</span>
            </>
          ) : null}
        </h3>
        {rows.length > 0 ? (
          <ul className="ch-list" role="list">
            {rows.map((row) => (
              <ItemRow key={row.item.key} row={row} day={selected} tz={tz} onOpen={onOpenItem} />
            ))}
          </ul>
        ) : null}
        {rows.length === 0 && dayStatus === 'answered' ? <p className="ch-mp-nothing">{t('agenda.nothingPlanned')}</p> : null}
        {loading ? <PlaceholderRows count={rows.length > 0 ? 1 : 2} /> : null}
      </section>
    </section>
  );
}

/**
 * The picked layout's styles. They read the tokens HOME_THEME_CSS (./home-theme.ts) puts
 * on .ch-home (D's, and E4's --ch-dot-*, --ch-today*, --ch-selected*, --ch-pill-* and
 * --ch-disabled), and D's AGENDA_CSS supplies the rows, the notices' state rows, the
 * placeholders and the pulse. A cell is PICKED_CELL_PX tall: its 1 px top line, 2 px,
 * the 24 px day, the 12 px Hebrew line and 1 px, then the 8 px marks. Logical properties
 * only; nothing under 11 px; every tap at least 44 px; no hover; overflow: hidden only on
 * the Hebrew line, a leaf, for its ellipsis.
 */
export const MONTH_PICKED_CSS = `
.ch-mp {
  padding-block-end: calc(24px + max(env(safe-area-inset-bottom, 0px), var(--tg-safe-area-inset-bottom, 0px)));
  scroll-margin-block-start: calc(var(--tg-safe-area-inset-top, 0px) + var(--tg-content-safe-area-inset-top, 0px));
}
.ch-mp-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-block: 6px 0;
  margin-inline: 8px;
}
.ch-mp-back {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  min-height: 44px;
  min-width: 44px;
  margin: 0;
  padding-block: 0;
  padding-inline: 4px 10px;
  border: 0;
  border-radius: 12px;
  background: transparent;
  color: var(--ch-accent);
  font-family: inherit;
  font-size: 15px;
  font-weight: 500;
  line-height: 1.2;
  cursor: pointer;
  touch-action: manipulation;
}
.ch-mp-today {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 44px;
  min-width: 44px;
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent;
  font-family: inherit;
  cursor: pointer;
  touch-action: manipulation;
}
.ch-mp-today-pill {
  display: inline-flex;
  align-items: center;
  block-size: 36px;
  padding-inline: 14px;
  border: 1px solid var(--ch-pill-line);
  border-radius: 18px;
  background: var(--ch-pill-bg);
  color: var(--ch-pill-text);
  font-size: 14px;
  font-weight: 500;
  line-height: 1.2;
}
.ch-mp-nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  margin-block: 0 2px;
  margin-inline: 8px;
}
.ch-mp-chev {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  inline-size: 44px;
  block-size: 44px;
  min-width: 44px;
  min-height: 44px;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: 12px;
  background: transparent;
  color: var(--ch-text);
  cursor: pointer;
  touch-action: manipulation;
}
.ch-mp-chev:disabled {
  color: var(--ch-disabled);
  cursor: default;
}
.ch-mp-back svg,
.ch-mp-chev svg {
  flex: none;
  inline-size: 22px;
  block-size: 22px;
}
.ch-mp-back:focus-visible,
.ch-mp-today:focus-visible,
.ch-mp-chev:focus-visible,
.ch-mp-cell:focus-visible {
  outline: 2px solid var(--ch-accent);
  outline-offset: -2px;
}
.ch-mp-title {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: 17px;
  font-weight: 400;
  text-align: center;
}
.ch-mp-month {
  display: block;
  font-size: 17px;
  font-weight: 600;
  line-height: 22px;
}
.ch-mp-range {
  display: block;
  font-size: 13px;
  line-height: 18px;
  color: var(--ch-muted);
}
.ch-mp-states {
  margin-block: 8px 4px;
}
.ch-mp-weekdays {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  padding-block: 6px 4px;
  padding-inline: 6px;
  border-block-end: 1px solid var(--ch-separator);
  font-size: 12px;
  line-height: 16px;
  color: var(--ch-muted);
  text-align: center;
}
.ch-mp-grid {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  margin-inline: 6px;
}
.ch-mp-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-width: 0;
  block-size: ${PICKED_CELL_PX}px;
  min-height: 44px;
  margin: 0;
  padding-block: 2px 0;
  padding-inline: 0;
  border: 0;
  border-block-start: 1px solid var(--ch-separator);
  background: transparent;
  color: var(--ch-text);
  font-family: inherit;
  cursor: pointer;
  touch-action: manipulation;
}
.ch-mp-blank {
  border-block-start-color: transparent;
  cursor: default;
}
.ch-mp-num {
  display: flex;
  align-items: center;
  justify-content: center;
  inline-size: 24px;
  block-size: 24px;
  border-radius: 12px;
  font-size: 14px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}
.ch-mp-cell.is-today .ch-mp-num {
  color: var(--ch-accent);
  font-weight: 600;
}
.ch-mp-cell.is-failed .ch-mp-num {
  color: var(--ch-muted);
}
.ch-mp-cell[aria-pressed='true'] .ch-mp-num {
  background: var(--ch-selected);
  color: var(--ch-selected-text);
  font-weight: 600;
}
.ch-mp-cell.is-today[aria-pressed='true'] .ch-mp-num {
  background: var(--ch-today);
  color: var(--ch-today-text);
}
.ch-mp-heb {
  display: block;
  max-inline-size: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  line-height: 12px;
  color: var(--ch-muted);
}
.ch-mp-marks {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  block-size: 8px;
  margin-block-start: 1px;
}
.ch-mp-dot {
  flex: none;
  inline-size: 6px;
  block-size: 6px;
  border-radius: 3px;
}
.ch-mp-dot.is-mine {
  background: var(--ch-dot-mine);
}
.ch-mp-dot.is-partner {
  border: 1.5px solid var(--ch-dot-partner);
}
.ch-mp-more {
  font-size: 11px;
  line-height: 8px;
  color: var(--ch-muted);
}
.ch-mp-ghost {
  inline-size: 16px;
  block-size: 6px;
  border-radius: 3px;
  background: var(--ch-outline);
  animation: ch-pulse 1.4s ease-in-out infinite;
}
.ch-mp-day {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0 8px;
  margin-block: 16px 2px;
  margin-inline: 16px;
  font-size: 14px;
  font-weight: 400;
  line-height: 1.35;
}
.ch-mp-day-label {
  font-weight: 600;
}
.ch-mp-day-label::first-letter {
  text-transform: uppercase;
}
.ch-mp-day-hebrew {
  color: var(--ch-muted);
}
.ch-mp-nothing {
  margin-block: 8px 0;
  margin-inline: 16px;
  padding: 14px;
  border-radius: 12px;
  background: var(--ch-surface);
  color: var(--ch-muted);
  font-size: 14px;
}
`;
```

- [ ] **Step 4: Run the smoke and see it pass**

```bash
cd /Users/razielgershoni/development/famcalbot
E="DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake"
for tz in UTC Asia/Jerusalem Pacific/Kiritimati America/Los_Angeles; do
  eval "env TZ=$tz $E npx tsx scripts/smoke-calendar-month-picked.ts" > /tmp/e7-picked.log 2>&1; echo "TZ=$tz exit $?"; grep -E '^FAIL|passed' /tmp/e7-picked.log
done
```
Expected (each run takes a few seconds), with no `FAIL` line:
```
TZ=UTC exit 0
14/14 passed (process TZ=UTC)
TZ=Asia/Jerusalem exit 0
14/14 passed (process TZ=Asia/Jerusalem)
TZ=Pacific/Kiritimati exit 0
14/14 passed (process TZ=Pacific/Kiritimati)
TZ=America/Los_Angeles exit 0
14/14 passed (process TZ=America/Los_Angeles)
```
If only #14 fails, React logged a warning, and the message names it. If #11 or #13 fails, look at the page log in its message: it lists every `scrollTo` and `focus` call in order.

- [ ] **Step 5: Run the regression smokes again**

```bash
cd /Users/razielgershoni/development/famcalbot
E="DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake"
for f in smoke-initdata-header smoke-auth-leftovers smoke-auth-identity smoke-calendar-home-render smoke-calendar-month smoke-calendar-home-tabs smoke-calendar-home-copy check-i18n-parity; do
  for tz in UTC Asia/Jerusalem; do
    eval "env TZ=$tz $E npx tsx scripts/$f.ts" > /tmp/e7-$f.log 2>&1; echo "$f TZ=$tz exit $?"
    grep -E '^(OK|FAIL)|passed|parity' /tmp/e7-$f.log > /tmp/e7-$f-${tz//\//_}.after
    cmp -s /tmp/e7-$f-${tz//\//_}.before /tmp/e7-$f-${tz//\//_}.after && echo "  same output as Step 2" || echo "  OUTPUT CHANGED"
  done
done
```
Expected: every run prints `exit 0` and `same output as Step 2`. `smoke-initdata-header`, `smoke-auth-leftovers` and `smoke-auth-identity` now also scan the two new files, and they stay green.

- [ ] **Step 6: Type-check and lint**

```bash
cd /Users/razielgershoni/development/famcalbot
npx tsc --noEmit -p . ; echo "tsc exit $?"
npm run -s lint ; echo "lint exit $?"
```
Expected: `tsc exit 0` and `lint exit 0`, with no other output.

- [ ] **Step 7: Commit**

```bash
cd /Users/razielgershoni/development/famcalbot
git add 'app/[locale]/dashboard/MonthPicked.tsx' scripts/smoke-calendar-month-picked.ts
git commit -m "$(cat <<'EOF'
feat(calendar-home): the Month's picked layout

A tap on a day in the Month keeps only that month, compact, with the
day's list under it (spec §7.4, the iOS-style Month). "All months" goes
back to browse, and a Today pill shows while another day is selected.
The chevrons are labelled, 44 px, and disabled at the window's ends. The
title carries the year and the Hebrew months, read out as it changes.
Each day is a 48 px button with browse's label, aria-pressed and
aria-current, the Hebrew day at 11 px, and up to 3 dots (filled for the
viewer's items, a ring for the partner's), then "+N". Daily reminders are
listed under the day but never dotted (R11). Failed, busy, calendars-gone
and partial notices are rows with Retry or Choose again, never a
reconnect. A day reads "Nothing planned" only once it is answered,
loading days show placeholders, and failed ones show nothing. On mount
the page scrolls to the top, or on a screen too short for the month and
the day's first row only as far as shows them, never past the bar, and
focus goes to the selected day. The rows
are D's ItemRow with D's styles. Logical CSS only, nothing under 11 px.
Nothing renders it until MonthView (E8), and the switch is unchanged.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
EOF
)"
```
Stage only these two paths. The working tree may show plan or spec files as modified; they aren't part of this task.

---

### Task 8 (E8): The container (spec §5's month windows, §7.1, §7.4, §7.6, §7.7; Rulings R11, R12 and R19; Plan E Rulings 1, 2, 4, 6, 7 and 9)

> **INTERFACE NOTE VERSUS THE SPLIT (read this first). No name or signature the split gives changes. `MonthView.tsx` exports `MonthViewProps` and `MonthView` only; `CalendarHome.tsx` adds one export, `HOME_TOP_CSS` (the review patch's sticky header, note 4).** The split names MonthViewProps' fields but not all their types. These are now binding:
> 1. **`dayRows` is the picked day's list as one value:** `dayRows: { rows: AgendaRow[]; status: DayStatus } | null`. It holds `dayRows(store, day)` and `dayStatus(store, day)` for `ui.selected`, and is `null` in browse. MonthPicked needs both, and the split lists no separate status field.
> 2. **The rest:** `today: DayKey; tz: string; weekStart: WeekStart; hebrewDates: boolean; months: readonly MonthKey[]; getMonth: (month: MonthKey) => MonthModel | null; ui: MonthUi; start: { month: MonthKey; peek: boolean }; unavailableCalendars: number; selected: AgendaRow | null; onSelect: (row: AgendaRow | null) => void; onUi: (ui: MonthUi) => void; onNearMonths: (months: MonthKey[]) => void; onMonthInView: (month: MonthKey) => void; onRetryMonth: (month: MonthKey, source: SourceName) => void; onChooseCalendars: () => void`. MonthView works out the next MonthUi with month.ts's `pickDay`, `stepMonth`, `pickToday` and `backToBrowse` and hands it to `onUi`. The container does the rest.
> 3. **The render smoke changes beyond the split's list.** The split names `scrollTo`, `scrollY`, `matchMedia`, `IntersectionObserver` and `localStorage`. MonthBrowse also needs `getBoundingClientRect` on the fake elements, `requestAnimationFrame` / `cancelAnimationFrame`, `innerHeight` and a `window.addEventListener` that keeps its listeners (it was a no-op), so those are added too. `fakeTelegramHome` gains recording `enableVerticalSwipes` / `disableVerticalSwipes`; without them every 8.0 fake in D's checks would log a TypeError from the swipe hook. #21 is unchanged; #43 walks the Month's modules. #22 flips, and #6 stays as it is. The review patch adds the header's wrapper to the fake layout (`LAYOUT.topH`), puts every other element at the document's top (picked's entering scroll measures), and lets the mounted root's `key` carry `shiftKey` (#59).
> 4. **The review patch** (binding for the landing):
>    - **The header and the tab bar stick over browse** (review focus 1). The approved MonthFlow keeps them on screen with an inner scroller; spec §7.1 wants document-level scroll and no inner scroller, so they sit in one wrapper, `.ch-home-top`, which is `position: sticky` under the safe areas while the Month shows browse (its loading included, as the swipe lock), above browse's bar (`z-index` 4 over 3) and under the sheets (50). Its height goes on `.ch-home` as `--ch-top-h` on every commit, in a layout effect of the wrapper, an earlier sibling of the panel, so it is there before browse's own layout effects in the same commit; a `ResizeObserver` catches a change outside a render. E6's bar sticks under it and its titles stop under both. Without it, today's month was 6,400 px down the list, and the header (Send, ⋯) and the tab bar were 12 months up (the review's offsets probe). On the Agenda and in picked the wrapper scrolls with the page, as before: the Agenda is a week, and in picked the month and the day's list need the height (E7's short-screen rule).
>    - **The Month's views are a chunk of their own** (switch-off leak 1). PageGate preloads CalendarHome's chunk on every /dashboard open (`PRELOAD.dashboard`), for the users the switch doesn't cover too, and E8 had made it 62 % bigger. CalendarHome reaches MonthView only through `import()` (`React.lazy`, in a `Suspense` whose fallback is the Month's loading state), fetches it once the first answer is in and the tab bar shows, so the first tap on Month rarely waits, and a chunk that fails reloads once through D's `HomeErrorBoundary`. month.ts, grid.ts and HomeTabs stay in the preload: the container keeps the Month's state across tab switches (§7.1) and computes the loader's wanted months.
>    - **The item sheet keeps focus** (coverage gap 6; Ruling 10's "not taken" focus trap, taken now): `BottomSheet` wraps Tab inside its controls, brings focus that lands outside back to the panel, and closes on Escape wherever focus is. A change of the picked day still closes the sheet.
>
> **Points the split left open, now binding** (the landing report and the device check build on them):
> - **The Month keeps the last pinned facts through a store drop** (midnight, other facts). It stays mounted where it is, with its cells loading, until the new answer: browse's months draw as loading, and picked draws a loading model of its month. Unmounting would jump the page, since iOS's WKWebView has no scroll anchoring. Before any answer at all (a reload on the Month tab), the Month tab shows D's placeholders.
> - **`monthUi`** starts from `initialMonthUi(readMonthLayout(user.id), today)` with the first pinned facts. When today moves, it is started again the same way while the Month hasn't been on screen yet and is untouched, so a restored picked still opens on today. Otherwise `clampMonthUi` keeps it inside the new window. The remembered layout is read once, on mount.
> - **In browse, `ui.month` is where browse opens next.** A tab switch away writes the month in view into it, and `backToBrowse` sets it to the picked month. `start` is `{ month: ui.month, peek: monthFresh }`. `monthFresh` stays true until the Month is first left or changed, so only the first opening peeks. MonthView mounts MonthBrowse only while browse shows, so each return to browse is a new mount that reads `start` (E6 note 6). MonthPicked is one element for as long as picked shows, never keyed (E7 note 6).
> - **Only the tab on screen is mounted.** The other tab's `role="tabpanel"` is rendered empty and `hidden`, so each tab's `aria-controls` names an element. The Agenda's week count and the Month's state live in the container, so they outlive a switch.
> - **The swipe lock reads the remembered layout before the first answer** (browse unless `'picked'`), so a reload on the Month's browse is locked from the start (Ruling 9: "its loading state included").
> - **A change of the picked day closes an open item sheet,** rather than showing a day that is no longer picked. Since the review patch the sheet keeps focus (note 4), so a keyboard no longer reaches the chevrons behind it, and the scrim takes a pointer's tap; the rule stays for any other change of day (the smoke's #47 taps the chevron behind the sheet directly).
>
> **Verified against stand-ins: none.** E8 reads E1-E7, all applied to 0064e8f with `dapply.py` from their task texts, in order.

**What and why.** Plan D's home has the Agenda only (R19). This task puts the Month in it behind a tab bar, and wires everything E1-E7 built into the container:
- **The tab bar** (E4's HomeTabs, `Main.dc.html`) sits under the header and above the banners. It shows only while a tab's panel can show: no card (busy, retry, switch-off), no block, and not a Google user still setting up (Ruling 1). The tab on screen is kept in sessionStorage for the session (Ruling 2). A switch closes any sheet and the item sheet, and the Agenda opens at the top.
- **The Month** (new `MonthView.tsx`) shows E6's browse or E7's picked as the container's `MonthUi` says. The unavailable-calendars row ("2 calendars aren't available · Choose again") shows once, above either layout (Ruling 4). A row tapped under the picked day opens D's ItemSheet, as the latest answer has it.
- **Where the Month opens** (spec §7.4): the first time, browse opens on today's month with a peek; after "All months" or the BackButton, on the picked month; after a tab switch, on the month that was in view. A restored picked layout opens on today. Each layout change is kept per device (`famcal:monthLayout:v1:{userId}`).
- **The Month's windows** (spec §5, Ruling 7): while the Month shows, the loader asks for `wantedMonths(ui, near, inView, today)`. In browse that is the months near the screen, in picked the picked month and its neighbours. Each window is a month's own days, `[1st, 1st of next month)` (R12), at most 2 in flight (E3's cap), and each is asked once per epoch. A return to the foreground and ⋯ → Refresh ask the Month's windows, not the Agenda's weeks. The Month's Retry asks one month again.
- **Telegram** (spec §7.6, Ruling 9): the one BackButton also shows while the Month is in picked. A tap closes the sheet on top, else the item sheet, else returns to browse. Vertical swipes are off while the Month shows browse, its loading included, and on everywhere else (Bot API 7.7+). The not_enabled reload lets both controls go first.
- **The header and the tab bar stay on screen over browse** (review patch, note 4), as the approved MonthFlow has them: at today's month, Send, ⋯ and the Agenda tab are a tap away.
- **The Month's views load as a chunk of their own** (review patch, note 4), so the chunk every /dashboard open preloads grows by much less.
- **The item sheet keeps focus** (review patch, note 4).

After this task the switch's admins see the tab bar and the Month. Users the switch doesn't cover see nothing new.

**Files** (the state this task starts from: 0064e8f with E1, E2, E3, E4, E5, E6 and E7 applied):
- Prerequisites, all from earlier waves:
  - E2's `grid.ts`;
  - E3's loader (`getMonths`, `agendaShowing`, `retryWindow`);
  - E4's `home-storage.ts`, `HomeTabs.tsx` and the swipe hook;
  - E5's `month.ts`;
  - E6's `MonthBrowse.tsx`;
  - E7's `MonthPicked.tsx`.
- Create: `app/[locale]/dashboard/MonthView.tsx`
- Modify: `app/[locale]/dashboard/CalendarHome.tsx` (351 lines; D's file, which E1-E7 leave alone): lines 1-61, 89-100, 108-150, 159-188, 235-250, 254-294, 295-308 and 311-333.
- Modify: `app/[locale]/dashboard/BottomSheet.tsx` (D's file; review patch): lines 11 and 27-42.
- Modify (test): `scripts/smoke-calendar-home-render.ts` (2298 lines after E3's #42): lines 52-57, 63, 83-89, 491-496, 506-519, 569, 610, 728-734, 754-759, 842-862, 1384-1390, 1409-1416 and 2283-2288.
- Test: `scripts/smoke-calendar-home-render.ts` under `TZ=UTC`, `TZ=Asia/Jerusalem` and `TZ=Pacific/Kiritimati`, and also `TZ=America/Los_Angeles` (its #15 already compares four process zones).
- Regression (unchanged, both clocks):
  - `smoke-miniapp-gate` (20) and `smoke-page-auth` (14): PageGate's dashboard branch, which loads CalendarHome;
  - `smoke-initdata-header` (9), `smoke-auth-leftovers` (9) and `smoke-auth-identity` (26), which scan `app/`, `src/` and `scripts/`;
  - E4-E7's smokes: `smoke-calendar-home-tabs` (11), `smoke-calendar-month-browse` (26), `smoke-calendar-month-picked` (14), `smoke-calendar-month` (26), `smoke-telegram-ui` (19);
  - `smoke-calendar-loader` (12): the loader E8 feeds;
  - `smoke-calendar-home-copy` (18) and `check-i18n-parity` (1013 keys).

**Interfaces:**
- Consumes (line numbers as of the starting state):
  - from E4:
    - `src/lib/calendar-view/home-storage.ts`: `type HomeTab = 'agenda' | 'month'` (`:15`), `readHomeTab(userId: number): HomeTab` (`:51`), `writeHomeTab(userId: number, tab: HomeTab): void` (`:56`), `readMonthLayout(userId: number): 'browse' | 'picked' | null` (`:61`), `writeMonthLayout(userId: number, layout: 'browse' | 'picked'): void` (`:67`); in the smoke `homeTabKey` (`:18`) and `monthLayoutKey` (`:23`). Every read and write is in try/catch there;
    - `app/[locale]/dashboard/HomeTabs.tsx`: `TAB_IDS` (`:27`), `PANEL_IDS` (`:29`), `HomeTabs({ tab, onTab }: HomeTabsProps)` (`:41`). It renders its own style sheet, and `onTab` is never called with the tab on screen (E4 note 1);
    - `src/lib/telegram-ui.ts`: `useTelegramVerticalSwipes(locked: boolean): void` (`:144`; it sets on mount and on each change, and enables on unmount), `releaseTelegramControls(): void` (`:159`). Still `useTelegramBackButton(active, onBack)` (`:89`; `onBack` through `useEffectEvent`, so the latest one runs).
  - from E5, `src/lib/calendar-view/month.ts`: `type MonthUi` (`:66`), `initialMonthUi(saved, today)` (`:550`), `pickDay(ui, day)` (`:556`), `backToBrowse(ui)` (`:564`), `canStep(ui, delta, today)` (`:569`), `stepMonth(ui, delta, today)` (`:576`), `pickToday(ui, today)` (`:583`), `clampMonthUi(ui, today)` (`:596`), `wantedMonths(ui, near, inView, today): RangeWindow[]` (`:626`), `monthModels(store)` (`:434`), `dayRows(store, day): AgendaRow[]` (`:525`), and the types `MonthModel` (`:201`) and `MonthCell` (`:173`). Each helper returns the same object when nothing changes (E5 note 9). In the smoke also `BROWSE_CELL_PX` (`:74`), `monthBarPx` (`:116`) and `monthOffsets` (`:127`).
  - from E2, `src/lib/calendar-view/grid.ts`: `type MonthKey` (`:17`), `monthOf` (`:82`), `monthFirstDay` (`:93`), `monthWindow(month): { from; to }` (`:106`), `monthGrid(month, weekStart)` (`:113`), `monthSpan(today): MonthKey[]` (`:122`). From E2 also `isHebrewMonthStart(dayKey)` (`hebrew-date.ts:151`).
  - from E3, `src/lib/calendar-view/home-loader.ts`: the host's optional `getMonths?(): readonly RangeWindow[]` (`:70`) and `agendaShowing?(): boolean` (`:72`), and `retryWindow(window, only?)` (`:79`). A window counts as a month's by its shape, so no flag is passed (E3 note 2), and `getMonths()` is read again whenever a month slot frees (E3 note 3). In the smoke `MONTH_INFLIGHT_MAX` (`:48`).
  - from E6, `MonthBrowse(props: MonthBrowseProps)` (`app/[locale]/dashboard/MonthBrowse.tsx:393`, props `:67`), which reads `--ch-top-h` (E6 note 11); in the smoke `MONTH_BROWSE_CSS` (#56). From E7, `MonthPicked(props: MonthPickedProps)` (`MonthPicked.tsx:218`, props `:60`). Both are used with the split's props, verbatim.
  - from D: `ItemSheet({ row, today, tz, onClose }: ItemSheetProps)` (`ItemSheet.tsx:89`), `AGENDA_CSS` (`AgendaView.tsx:178`, for the state-row and placeholder classes), `PlaceholderRows({ count })` (`DayList.tsx:25`), `dayStatus(state, day)` (`store.ts:294`), `homeNotices(state)` (`:331`), the type `StoreFacts` (`:37`), `formatDayLong(day, locale)` (`format.ts:106`, in the smoke).
  - the copy (`calendarHome`): from D, `state.unavailable {count}`, `actions.chooseAgain` and `shell.loading`. E8 adds no copy.
  - from D5, `BottomSheet` (`BottomSheet.tsx:28`), which the review patch edits (Step 5); its props don't change.
  - React 19.2 (`useState`, `useMemo`, `useRef`, `useEffect`, `useLayoutEffect`, `useCallback`, `lazy`, `Suspense`); next-intl 4.6.1 (`useTranslations`).
- Produces:
  - `app/[locale]/dashboard/MonthView.tsx`:
    - `export interface MonthViewProps { today: DayKey; tz: string; weekStart: WeekStart; hebrewDates: boolean; months: readonly MonthKey[]; getMonth: (month: MonthKey) => MonthModel | null; ui: MonthUi; start: { month: MonthKey; peek: boolean }; dayRows: { rows: AgendaRow[]; status: DayStatus } | null; unavailableCalendars: number; selected: AgendaRow | null; onSelect: (row: AgendaRow | null) => void; onUi: (ui: MonthUi) => void; onNearMonths: (months: MonthKey[]) => void; onMonthInView: (month: MonthKey) => void; onRetryMonth: (month: MonthKey, source: SourceName) => void; onChooseCalendars: () => void }`;
    - `export function MonthView(props: MonthViewProps)`. It returns a fragment: the unavailable row when the count is above 0 (in browse with D's `AGENDA_CSS`), then `<MonthBrowse>`, or `<MonthPicked>` and, for a selected row, `<ItemSheet>`.
  - `app/[locale]/dashboard/CalendarHome.tsx`: the exports are D's (`NOT_ENABLED_RELOAD_KEY`, `HomeDeps`, `CalendarHomeContainerProps`, `CalendarHomeContainer`, the default `CalendarHome`) and `export const HOME_TOP_CSS: string` (review patch). The root's children are now, in order:
    1. the three style sheets (`HOME_TOP_CSS` the third);
    2. `<div class="ch-home-top">` (`is-sticky` in browse) with HomeHeader and HomeTabs (while the bar shows);
    3. HomeBanners;
    4. the card, or the two tabpanels (`id={PANEL_IDS[tab]}`, `aria-labelledby={TAB_IDS[tab]}`, the other `hidden` and empty; the Month's in a `Suspense`), or, without the bar, the Agenda bare as in D;
    5. the send and menu sheets.
    `.ch-home` carries `--ch-top-h`, the wrapper's height in px.
  - `app/[locale]/dashboard/BottomSheet.tsx`: unchanged props; it keeps focus while open (note 4).

**Findings that shaped the code** (line numbers as of the starting state):
- **The loader reads the Month through refs.** `getMonths()` is called from `ensure()` and also when a month request settles (`home-loader.ts:205`, `:222`), outside React's render. So the container keeps `{ tab, ui, near, inView }` in `monthRef`, synced in D's sync effect (`CalendarHome.tsx:140-145`), and computes `wantedMonths` there with the store's today. The ensure effect (`:180-182`) also runs on the tab, the near months, the month in view and the UI, so a month coming near, a chevron or a tab switch asks at once, not at the next answer (#45 and #47 show both).
- **Ruling 1 needs `card` and `setupNeeded` before the effects.** D computes them after the callbacks (`:273-275`). The ensure deps and the loader's ref need the tab on screen, so the two lines move up to the state, with `tabsShown` and `activeTab`. `activeTab` is `'agenda'` whenever the bar is hidden, so a remembered Month under a setup banner or a card behaves exactly as D does.
- **A store drop empties the facts** (`store.ts:273-283`: `reset` → `emptyStore`), and `buildMonth` gives null before facts (`month.ts:401-403`). With the store's facts alone, the Month would unmount at midnight and remount at the new answer, and browse would jump. The container instead holds the last facts in state (`held`, updated during render as D's `selected` clear is, `:244`), and MonthView draws a model-less month as loading. `held` also holds the unavailable count, so that row doesn't vanish and come back above the viewport during a drop.
- **MonthBrowse reads `start` and measures on mount only** (`MonthBrowse.tsx:414-417`, `:480-483`; E6 note 6). MonthView renders MonthBrowse and MonthPicked at the same place in the tree with different types, so React unmounts one and mounts the other on each layout change. The browse that comes back reads the new `start`, and MonthPicked keeps its one mount while the month changes (`MonthPicked.tsx:248-251` scrolls on mount only).
- **The BackButton's `active` stays true when the item sheet opens over picked,** so `useTelegramBackButton`'s effect (`telegram-ui.ts:96-109`) doesn't run again: no offClick, hide, onClick or show. One tap runs `back`, which closes the sheet. The button stays for picked, and the next tap returns to browse. The smoke's #47 checks the calls.
- **The swipe hook belongs to one component** (`telegram-ui.ts:141-143`). The container calls it before its noCredential return, so the hook order never changes. A noCredential or a card gives `activeTab = 'agenda'`, which unlocks.
- **D's render smoke had no page to measure.** Its fake window had no `scrollTo`, `matchMedia` or animation frames, and a no-op `addEventListener` (`smoke-calendar-home-render.ts:510-521`), and its fake elements had no `getBoundingClientRect`. MonthBrowse calls all of them (`MonthBrowse.tsx:101-172`), and MonthPicked calls `scrollTo` (E7 note 6). The added layout is E6's: titles at the block sizes rendered, a sticky bar, no safe area. `fakeTelegramHome` (`:732-778`) had no swipe methods, and the hook would log a TypeError on every 8.0 fake. Every fake now records them, and only a 7.7+ fake has them called.
- **D's deferred list:** Ruling 10's "not taken" items stay deferred, but one: the BottomSheet focus trap is taken in the review patch (note 4), since the Month does make it worse. Behind D's ItemSheet over picked sit some 30 day buttons and two chevrons, and a keyboard reached each of them. The Month adds no second `useTelegramTheme` user.
- **Review patch: the header in browse.** `HomeTabs`' CSS has no sticky rule and the shell scrolls the document (`home-shell.ts`), so only `.ch-mb-bar` stuck: `monthOffsets` puts today's month 6,400 px into the list, and from browse the user had to scroll a year up, fetching each month passed, to reach the Agenda, Send or ⋯ (whose Refresh then asked the months near the top). The wrapper sticks the header and the tab bar instead, as the mockup shows them; the cost is their height over browse (about 126 px with the Hebrew line), the mockup's too. Layout effects run child before parent and sibling before sibling, so the wrapper's (it comes before the panel) publishes `--ch-top-h` before MonthBrowse's opening scroll reads the titles' margin in the same commit, the first answer's included, when the header's day line replaces its placeholder.
- **Review patch: the chunk.** Measured on fresh copies built with `npx prisma generate && npx next build` (fake env, `NODE_ENV=production`, Next 16.1.1 Turbopack), gzip at level 9. Before the patch the home's one chunk was 115,326 B (31,712 B gzip), from 71,146 B (20,511 B gzip) on E1-E7: +62 %. Now the preload is two chunks, CalendarHome's 45,298 B (13,766 B gzip) and one Turbopack splits off with the modules both chunks use (D's AgendaView, DayList, ItemRow, ItemSheet, BottomSheet, format.ts, hebrew-date.ts, agenda.ts, store.ts, telegram-ui.ts, month.ts and grid.ts), 47,478 B (14,859 B gzip): 92,776 B (28,625 B gzip) in all, 22,550 B (3,087 B gzip) less than before and 21,630 B (8,114 B gzip) more than E1-E7. The Month's own chunk (MonthView, MonthBrowse, MonthPicked) is 33,219 B (8,650 B gzip), fetched by the switch's users only. What stays in the preload over E1-E7 is the tab bar (HomeTabs), month.ts (7.6 KB), home-storage.ts and the container's Month state, which §7.1 wants kept across tab switches. All client chunks together: 1,560,663 → 1,571,688 B.
- **Review patch: the checks the review asked for.** #56 (the sticky wrapper, its CSS against the bar's and the sheets' z-index, `--ch-top-h` and the bar's and titles' use of it, and ⋯ → Refresh from 6,400 px down asking the months near October), #57 (from picked to the Agenda and back: offClick and hide, swipes left on, then picked on the same day with onClick and show, one scroll to the top and focus on the day), #58 (#49's foreground on Telegram's `activated`, an 8.0 fake) and #59 (the focus trap over picked: Tab and Shift+Tab, focus behind the sheet, Escape from outside, the listeners gone after). #43 now checks the chunk boundary. The geometry of the sticky region is E6's #24; this smoke's fake page doesn't model a sticky wrapper over the bar.
- **Verified** (a copy of 0064e8f with E1-E7 applied by `dapply.py`, Node 26.11.1):
  - **Before:** with Step 1's smoke and E7's container, the smoke gives 42/60 under UTC and Asia/Jerusalem: #22 and #43-#59 fail (Step 2), and `tsc` gives one TS2614 (`HOME_TOP_CSS` isn't exported yet).
  - **After:**
    - 60/60 under UTC, Asia/Jerusalem, Pacific/Kiritimati and America/Los_Angeles (56/56 before the review patch, which adds #56-#59, renumbers the warning check #60, and rewrites #43);
    - `tsc` and `eslint .` are clean;
    - the 13 regression smokes print the same lines before and after under both clocks.
  - **Mutations:** the smoke catches all 38 planted bugs. They were:
    - the tab switch keeping the item sheet or the menu, no scroll to the top, the tab not stored;
    - the bar during setup or over a card, the bar after the banners, a panel without `aria-labelledby`;
    - never or always peeking, the month in view not kept across a switch, back opening on today's month;
    - the layout not stored, picked keyed by month, the near months or the month in view not reset on back;
    - a BackButton tap that never leaves picked, or closes the sheet and leaves picked at once, no BackButton for picked, the item sheet over picked not closed by it;
    - swipes locked in picked too, or never;
    - not_enabled releasing the BackButton only;
    - the Agenda's weeks asked on the Month, no months, months asked on the Agenda;
    - the ensure effect blind to the near months or to the UI, Retry refetching everything;
    - no held facts, always restarting or always clamping `monthUi`;
    - the sheet showing the tapped row, no unavailable row, nothing before the first answer, no loading model, the sheet not closed when the day changes, an `overflow: hidden` on the panel, the sheet never rendered;
    - review patch (`erev/mut/m-e78.py`, 10, each caught under UTC): a static MonthView import (#43); the wrapper never sticky, sticky in picked too, no `--ch-top-h`, under the bar's z-index (#56); the sheet without its `focusin` trap, without Tab's wrap, without Shift+Tab from the panel, without the document's Escape, and its listeners kept after it closes (#59).
  - **Not verified:** `next build` on a fresh clone (the controller's, after E8); Node 22; the device check below. How the tab bar, the sticky bar and the BackButton behave in Telegram's own WebViews is only modelled by the fakes.

- [ ] **Step 1: Add the failing checks to `scripts/smoke-calendar-home-render.ts`**

Thirteen edits, in file order. Each Before block occurs exactly once in the file as it stands after E7.

**1a. The header comment** names the new checks. In `scripts/smoke-calendar-home-render.ts`, Before (lines 52-57):
```ts
// The midnight reset with a refetch in flight (Plan E, Task E3, #42): when that refetch
// fails after the reset, no retry card flashes before the new day's answer.
//
// React must log no warning. No network, no DB, no Redis.
//
// Run with the fake env from the task brief (no dotenv), under three clocks:
```
After:
```ts
// The midnight reset with a refetch in flight (Plan E, Task E3, #42): when that refetch
// fails after the reset, no retry card flashes before the new day's answer.
//
// The tabs and the Month through the container (Plan E, Task E8, #43-#60), in real React
// on a laid-out fake page (a fake scroll, frames, matchMedia, IntersectionObserver and
// localStorage): the Month's views in a chunk of their own; the tab bar under the header
// and above the banners, its tab kept for the session, and the header and tab bar
// sticking above browse; the Month opening on today's month with a peek; its windows, a month's own
// days, at most 2 in flight and each asked once; Telegram's swipes off in browse on a 7.7
// client and never touched on a 7.0 one; picked and its BackButton, with the item sheet
// over it closing first; the layout kept on the device, a restored picked opening on
// today; the foreground and Refresh asking the Month's windows; a failed month's Retry;
// midnight on the Month; no tab bar while a Google user sets up; not_enabled letting
// both controls go; no clipping ancestor above the Month; the unavailable-calendars row
// once above the Month; a tab switch from picked and back; Telegram's activated on the
// Month; the item sheet keeping focus over picked.
//
// React must log no warning. No network, no DB, no Redis.
//
// Run with the fake env from the task brief (no dotenv), under three clocks:
```

**1b. CalendarHome's import** adds `HOME_TOP_CSS`, the sticky header's style sheet (#56). In `scripts/smoke-calendar-home-render.ts`, Before (line 63):
```ts
import CalendarHome, { CalendarHomeContainer, NOT_ENABLED_RELOAD_KEY, type HomeDeps } from '../app/[locale]/dashboard/CalendarHome';
```
After:
```ts
import CalendarHome, { CalendarHomeContainer, HOME_TOP_CSS, NOT_ENABLED_RELOAD_KEY, type HomeDeps } from '../app/[locale]/dashboard/CalendarHome';
```

**1c. The imports:** `MONTH_INFLIGHT_MAX` from the loader, the tab and panel ids, the storage keys, the window helpers and the browse geometry from month.ts, and `formatDayLong` for the day buttons' labels. In `scripts/smoke-calendar-home-render.ts`, Before (lines 83-89):
```ts
import { HOME_SHELL_CSS } from '../app/[locale]/dashboard/home-shell';
import { menuEntries } from '../app/[locale]/dashboard/MenuSheet';
import { isChunkLoadError, isPastDay, msUntilAheadCheck, msUntilDayCheck, zoneDiffers } from '../src/lib/calendar-view/home-client';
import { ERROR_RETRY_MS, RANGE_TIMEOUT_MS, STALE_RETRY_MS } from '../src/lib/calendar-view/home-loader';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
```
After:
```ts
import { HOME_SHELL_CSS } from '../app/[locale]/dashboard/home-shell';
import { menuEntries } from '../app/[locale]/dashboard/MenuSheet';
import { isChunkLoadError, isPastDay, msUntilAheadCheck, msUntilDayCheck, zoneDiffers } from '../src/lib/calendar-view/home-client';
import { ERROR_RETRY_MS, MONTH_INFLIGHT_MAX, RANGE_TIMEOUT_MS, STALE_RETRY_MS } from '../src/lib/calendar-view/home-loader';
import { PANEL_IDS, TAB_IDS } from '../app/[locale]/dashboard/HomeTabs';
import { MONTH_BROWSE_CSS } from '../app/[locale]/dashboard/MonthBrowse';
import { homeTabKey, monthLayoutKey } from '../src/lib/calendar-view/home-storage';
import { monthSpan, monthWindow, type MonthKey } from '../src/lib/calendar-view/grid';
import { BROWSE_CELL_PX, monthBarPx, monthOffsets } from '../src/lib/calendar-view/month';
import { formatDayLong } from '../src/lib/calendar-view/format';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
```

**1d. A laid-out page.** Each fake element gets `getBoundingClientRect`, and the layout it reads: the list of months starts 400 px down the document, the sticky bar sticks at the top once the page scrolls past it, and each month's title sits at its block's top, from the block sizes MonthBrowse rendered (E6's smoke does the same). The header and tab bar's wrapper is `LAYOUT.topH` tall (0 unless a check says so, #56), and every other element sits at the document's top, 0 px tall (so picked's entering scroll, E7, measures 0). In `scripts/smoke-calendar-home-render.ts`, Before (lines 491-496):
```ts
  blur() {
    if (fakeDocument.activeElement === this) fakeDocument.activeElement = fakeDocument.body;
  }
}

const fakeDocument: Row = {
```
After:
```ts
  blur() {
    if (fakeDocument.activeElement === this) fakeDocument.activeElement = fakeDocument.body;
  }
  getBoundingClientRect() {
    return layoutRect(this);
  }
}

// The Month's page (Task E8): MonthBrowse measures it. The list of months starts
// LAYOUT.listTop px down the document (under the header, the tab bar and the sticky
// bar); the bar sticks at the top once the page scrolls past it (no safe area here);
// each month's title sits at its block's top, from the block sizes the view rendered.
// The header and tab bar's wrapper is LAYOUT.topH tall (0 unless a check says so).
// Everything else sits at the document's top, 0 px tall.
const LAYOUT = { listTop: 400, width: 390, topH: 0 };
const px = (value: unknown) => Number.parseFloat(String(value ?? '')) || 0;
function closestClass(el: FakeNode | null, cls: string): FakeElement | null {
  for (let n = el; n; n = n.parentNode) if (n instanceof FakeElement && n.className.split(' ').includes(cls)) return n;
  return null;
}
function rectAt(top: number, height: number) {
  return { top, bottom: top + height, left: 0, right: LAYOUT.width, width: LAYOUT.width, height, x: 0, y: top };
}
/** A month block's top in the list: the blocks rendered above it. */
function blockTop(section: FakeNode): number {
  let y = 0;
  for (const sibling of section.parentNode?.childNodes ?? []) {
    if (sibling === section) break;
    y += px((sibling as FakeElement).style?.blockSize);
  }
  return y;
}
function layoutRect(el: FakeElement) {
  const scrollY = Number(fakeWindow.scrollY) || 0;
  const classes = el.className.split(' ');
  if (classes.includes('ch-mb-months')) {
    return rectAt(LAYOUT.listTop - scrollY, el.childNodes.reduce((sum, s) => sum + px((s as FakeElement).style?.blockSize), 0));
  }
  if (classes.includes('ch-mb-bar')) {
    const bar = px(closestClass(el, 'ch-mb')?.style['--ch-mb-bar']);
    return rectAt(Math.max(0, LAYOUT.listTop - bar - scrollY), bar);
  }
  if (classes.includes('ch-mb-title') && el.parentNode) {
    return rectAt(LAYOUT.listTop + blockTop(el.parentNode) - scrollY, px(closestClass(el, 'ch-mb')?.style['--ch-mb-title']));
  }
  if (classes.includes('ch-home-top')) return rectAt(classes.includes('is-sticky') ? 0 : -scrollY, LAYOUT.topH);
  return rectAt(-scrollY, 0);
}

const fakeDocument: Row = {
```

**1e. The fake window** keeps its listeners (MonthBrowse's passive scroll and resize), records `scrollTo`, and gets `scrollY`, `innerHeight`, `matchMedia` (no query matches unless a check says so), animation frames that run only when a check flushes them, a fake `IntersectionObserver` that a check fires by hand, and a `localStorage`. In `scripts/smoke-calendar-home-render.ts`, Before (lines 506-519):
```ts
fakeDocument.body = new FakeElement('body', HTML_NS);
fakeDocument.activeElement = fakeDocument.body;

const openedWindows: string[] = [];
const fakeWindow: Row = {
  document: fakeDocument,
  HTMLIFrameElement: class {},
  addEventListener: noop,
  removeEventListener: noop,
  location: { hash: '' },
  sessionStorage: { getItem: () => null, setItem: noop },
  open: (url: string) => {
    openedWindows.push(url);
    return null;
```
After:
```ts
fakeDocument.body = new FakeElement('body', HTML_NS);
fakeDocument.activeElement = fakeDocument.body;

/** window.addEventListener's listeners (MonthBrowse's scroll and resize), with their options. */
const windowListeners: { type: string; fn: () => void; options: unknown }[] = [];
/** Every window.scrollTo: the top and the behaviour ('plain' for the two-number form). */
const scrollCalls: { top: number; behavior: string }[] = [];
/** The animation frames requested and not run yet. */
const frames = new Map<number, () => void>();
let nextFrameId = 1;
/** The media queries' answers (none match unless a check says so), and their listeners. */
const media = new Map<string, boolean>();
const mediaListeners = new Map<string, Set<() => void>>();

function fakeMediaList(query: string): Row {
  const set = () => {
    if (!mediaListeners.has(query)) mediaListeners.set(query, new Set());
    return mediaListeners.get(query) as Set<() => void>;
  };
  return {
    media: query,
    get matches() {
      return media.get(query) === true;
    },
    addEventListener: (_type: string, fn: () => void) => void set().add(fn),
    removeEventListener: (_type: string, fn: () => void) => void set().delete(fn),
    addListener: (fn: () => void) => void set().add(fn),
    removeListener: (fn: () => void) => void set().delete(fn),
  };
}

/** A fake IntersectionObserver: it records what it observes; a check fires its entries. */
class FakeIO {
  static all: FakeIO[] = [];
  observed = new Set<FakeElement>();
  constructor(
    public callback: (entries: Row[], observer: FakeIO) => void,
    public options: Row = {},
  ) {
    FakeIO.all.push(this);
  }
  observe(el: FakeElement) {
    this.observed.add(el);
  }
  unobserve(el: FakeElement) {
    this.observed.delete(el);
  }
  disconnect() {
    this.observed.clear();
  }
  takeRecords() {
    return [];
  }
  /** One callback with an entry for each observed month named in `states`. */
  fire(states: Record<MonthKey, boolean>) {
    const entries = [...this.observed]
      .filter((el) => (el.getAttribute('data-month') ?? '') in states)
      .map((el) => ({ target: el, isIntersecting: states[el.getAttribute('data-month') ?? ''] }));
    React.act(() => this.callback(entries, this));
  }
}

/** A Storage over a Map (sessionStorage, localStorage). */
function fakeStorage(): Row {
  const saved = new Map<string, string>();
  return {
    getItem: (k: string) => saved.get(k) ?? null,
    setItem: (k: string, v: string) => void saved.set(k, String(v)),
    removeItem: (k: string) => void saved.delete(k),
  };
}

const openedWindows: string[] = [];
const fakeWindow: Row = {
  document: fakeDocument,
  HTMLIFrameElement: class {},
  addEventListener: (type: string, fn: () => void, options?: unknown) => void windowListeners.push({ type, fn, options }),
  removeEventListener: (type: string, fn: () => void) => {
    const i = windowListeners.findIndex((l) => l.type === type && l.fn === fn);
    if (i >= 0) windowListeners.splice(i, 1);
  },
  location: { hash: '' },
  sessionStorage: { getItem: () => null, setItem: noop },
  localStorage: fakeStorage(),
  scrollY: 0,
  innerHeight: 800,
  scrollTo: (a: Row | number, b?: number) => {
    const call = typeof a === 'number' ? { top: b ?? 0, behavior: 'plain' } : { top: Number(a.top), behavior: String(a.behavior ?? 'auto') };
    scrollCalls.push(call);
    fakeWindow.scrollY = Math.max(0, call.top);
  },
  matchMedia: (query: string) => fakeMediaList(query),
  requestAnimationFrame: (fn: () => void) => {
    const id = nextFrameId++;
    frames.set(id, fn);
    return id;
  },
  cancelAnimationFrame: (id: number) => void frames.delete(id),
  IntersectionObserver: FakeIO,
  open: (url: string) => {
    openedWindows.push(url);
    return null;
```

**1f. The mounted root's `key`** takes the event's other fields too (#59's Shift+Tab). In `scripts/smoke-calendar-home-render.ts`, Before (line 569):
```ts
  key: (el: FakeNode, key: string) => void;
```
After:
```ts
  key: (el: FakeNode, key: string, extra?: Row) => void;
```

**1g. And `mount` passes them on.** In `scripts/smoke-calendar-home-render.ts`, Before (line 610):
```ts
    key: (target, key) => dispatch(target, 'keydown', { key }),
```
After:
```ts
    key: (target, key, extra = {}) => dispatch(target, 'keydown', { key, ...extra }),
```

**1h. `fakeTelegramHome`'s comment** says it records the swipes. In `scripts/smoke-calendar-home-render.ts`, Before (lines 728-734):
```ts
  };
}

/** A fake Telegram.WebApp for the home (Bot API 8.0 by default, so `activated` exists). BackButton handlers ride on backButtonClicked, as the SDK's do. */
function fakeTelegramHome(o: { version?: string; scheme?: 'light' | 'dark'; closeThrows?: boolean } = {}) {
  const calls: string[] = [];
  const events = new Map<string, Set<() => void>>();
```
After:
```ts
  };
}

/** A fake Telegram.WebApp for the home (Bot API 8.0 by default, so `activated` exists). BackButton handlers ride on backButtonClicked, as the SDK's do; the vertical swipes are recorded. */
function fakeTelegramHome(o: { version?: string; scheme?: 'light' | 'dark'; closeThrows?: boolean } = {}) {
  const calls: string[] = [];
  const events = new Map<string, Set<() => void>>();
```

**1i. The home's fake Telegram records the vertical swipes.** Every fake has the two methods, so a 7.0 fake proves the gate and an 8.0 fake no longer logs a TypeError from the swipe hook. In `scripts/smoke-calendar-home-render.ts`, Before (lines 754-759):
```ts
      calls.push('close()');
      if (o.closeThrows) throw new Error('close() failed in the smoke');
    },
    BackButton: {
      onClick: (h: () => void) => {
        calls.push('BackButton.onClick');
```
After:
```ts
      calls.push('close()');
      if (o.closeThrows) throw new Error('close() failed in the smoke');
    },
    // Bot API 7.7 (Task E8): recorded on every fake, called only where isVersionAtLeast('7.7') holds.
    enableVerticalSwipes: () => calls.push('enableVerticalSwipes()'),
    disableVerticalSwipes: () => calls.push('disableVerticalSwipes()'),
    BackButton: {
      onClick: (h: () => void) => {
        calls.push('BackButton.onClick');
```

**1j. `resetHome`** also empties localStorage, puts the page at the top, and clears the scroll calls, the frames, the media answers and the observers. In `scripts/smoke-calendar-home-render.ts`, Before (lines 842-862):
```ts
const fireDocument = (type: string) => React.act(() => docListeners.filter((l) => l.type === type).forEach((l) => l.fn({ type })));

const reloads: string[] = [];
/** A fresh slate for a home check: the fake fetch, no calls or pushes, an empty sessionStorage, reload() recorded, no Telegram. */
function resetHome() {
  (globalThis as Row).fetch = fakeFetch;
  fetchCalls.length = 0;
  pushes.length = 0;
  reloads.length = 0;
  const saved = new Map<string, string>();
  fakeWindow.sessionStorage = {
    getItem: (k: string) => saved.get(k) ?? null,
    setItem: (k: string, v: string) => void saved.set(k, String(v)),
    removeItem: (k: string) => void saved.delete(k),
  };
  fakeWindow.location = { hash: '', reload: () => reloads.push('reload') };
  fakeWindow.Telegram = undefined;
  fakeDocument.visibilityState = 'visible';
}

// ---- The checks ----
```
After:
```ts
const fireDocument = (type: string) => React.act(() => docListeners.filter((l) => l.type === type).forEach((l) => l.fn({ type })));

const reloads: string[] = [];
/**
 * A fresh slate for a home check: the fake fetch, no calls or pushes, an empty
 * sessionStorage and localStorage, reload() recorded, no Telegram; the page at the top,
 * no scroll call, no frame, no media query matching, a fresh observer class.
 */
function resetHome() {
  (globalThis as Row).fetch = fakeFetch;
  fetchCalls.length = 0;
  pushes.length = 0;
  reloads.length = 0;
  fakeWindow.sessionStorage = fakeStorage();
  fakeWindow.localStorage = fakeStorage();
  fakeWindow.location = { hash: '', reload: () => reloads.push('reload') };
  fakeWindow.Telegram = undefined;
  fakeWindow.scrollY = 0;
  fakeWindow.IntersectionObserver = FakeIO;
  fakeDocument.visibilityState = 'visible';
  scrollCalls.length = 0;
  frames.clear();
  media.clear();
  FakeIO.all = [];
}

// ---- The checks ----
```

**1k. #22's name: the tab bar is now present.** In `scripts/smoke-calendar-home-render.ts`, Before (lines 1384-1390):
```ts
    assert(forbidden.length === 0, `server modules in the home's graph: ${show(forbidden.map((p) => path.relative(ROOT, p)))}`);
  });

  await check('#22 CalendarHome (en, FamCal, in Telegram): one range request, no dates, the init data in the header only; placeholders, then the server\'s today, its Hebrew date and the Agenda; Telegram\'s theme and a hidden BackButton on mount; no tab bar', async () => {
    resetHome();
    const tg = fakeTelegramHome({ scheme: 'dark' });
    fakeWindow.Telegram = { WebApp: tg.webApp };
```
After:
```ts
    assert(forbidden.length === 0, `server modules in the home's graph: ${show(forbidden.map((p) => path.relative(ROOT, p)))}`);
  });

  await check('#22 CalendarHome (en, FamCal, in Telegram): one range request, no dates, the init data in the header only; placeholders, then the server\'s today, its Hebrew date and the Agenda; Telegram\'s theme and a hidden BackButton on mount; the tab bar (Plan E), with the Agenda selected', async () => {
    resetHome();
    const tg = fakeTelegramHome({ scheme: 'dark' });
    fakeWindow.Telegram = { WebApp: tg.webApp };
```

**1l. #22's assertions** flip from "no tab bar" to the bar with the Agenda selected. #6 stays as it is: AgendaView alone has no tabs. In `scripts/smoke-calendar-home-render.ts`, Before (lines 1409-1416):
```ts
      const after = m.html();
      assert(after.includes('<h1 class="ch-head-title">Thursday, 15 October</h1><p class="ch-head-sub">4 Cheshvan 5787</p>'), `the header: ${textOf(after).slice(0, 120)}`);
      assertHas(textOf(after), [`Today ${ref.dayShort('en-GB', day(0))} 4 Cheshvan`, 'Still open 5 reminders', '09:30 10:30 Dentist', 'Show next week'], 'the Agenda');
      assertLacks(after, ['role="tablist"', 'role="tab"', 'calendarHome.'], 'Plan D\'s shape (R19)');
      assertLacks(textOf(after), ['Month', 'Agenda', 'Open FamCal in Telegram'], 'no tabs; inside Telegram, no Telegram banner');
      assert(show(ranges()) === show(['famcal default']), `one request in all: ${show(ranges())}`);
    } finally {
      m.unmount();
```
After:
```ts
      const after = m.html();
      assert(after.includes('<h1 class="ch-head-title">Thursday, 15 October</h1><p class="ch-head-sub">4 Cheshvan 5787</p>'), `the header: ${textOf(after).slice(0, 120)}`);
      assertHas(textOf(after), [`Today ${ref.dayShort('en-GB', day(0))} 4 Cheshvan`, 'Still open 5 reminders', '09:30 10:30 Dentist', 'Show next week'], 'the Agenda');
      // Plan E: the tab bar under the header, the Agenda selected and its panel shown.
      assert(/<div class="ch-tabs" role="tablist" aria-label="Calendar view" dir="ltr">/.test(after), 'the tablist, named');
      const tabs = byRole(m.container, 'tab').map((e) => [e.getAttribute('id'), e.getAttribute('aria-selected'), e.textContent]);
      assert(show(tabs) === show([['ch-tab-agenda', 'true', 'Agenda'], ['ch-tab-month', 'false', 'Month']]), `the tabs: ${show(tabs)}`);
      const panels = byRole(m.container, 'tabpanel').map((e) => [e.getAttribute('id'), e.hasAttribute('hidden')]);
      assert(show(panels) === show([['ch-panel-agenda', false], ['ch-panel-month', true]]), `the panels: ${show(panels)}`);
      assert(after.indexOf('class="ch-head"') < after.indexOf('role="tablist"') && after.indexOf('role="tablist"') < after.indexOf('class="ch-agenda"'), 'the header, the tab bar, then the Agenda');
      assertLacks(after, ['calendarHome.'], 'no untranslated key');
      assertLacks(textOf(after), ['Open FamCal in Telegram'], 'inside Telegram, no Telegram banner');
      assert(show(ranges()) === show(['famcal default']), `one request in all: ${show(ranges())}`);
    } finally {
      m.unmount();
```

**1m. Checks #43-#60,** after #42. In `scripts/smoke-calendar-home-render.ts`, Before (lines 2283-2288):
```ts
    assert(reactWarnings.length === warned, `warnings: ${show(reactWarnings.slice(warned, warned + 5))}`);
  });

  let failed = 0;
  for (const r of results) {
    process.stdout.write(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}\n`);
```
After:
```ts
    assert(reactWarnings.length === warned, `warnings: ${show(reactWarnings.slice(warned, warned + 5))}`);
  });

  // ---- The tabs and the Month through the container (Plan E, Task E8) ----

  const warnedBeforeMonth = reactWarnings.length;
  /** The fixtures' window and each month's top in the browse list (Hebrew dates on, Sunday weeks). */
  const WINDOW = monthSpan(TODAY);
  const OFFSETS = monthOffsets(WINDOW, 0, true);
  const topOfMonth = (month: MonthKey) => OFFSETS[WINDOW.indexOf(month)];
  /** The page offset that puts `month`'s title just under the stuck bar, less `peek`. */
  const underBar = (month: MonthKey, peek = 0) => LAYOUT.listTop + topOfMonth(month) - monthBarPx(true) - peek;
  /** A scroll that reads `month` as the one in view (browse reads it half a week row under the bar). */
  const inViewAt = (month: MonthKey) => underBar(month, BROWSE_CELL_PX / 2) + 10;
  /** A month's window as ranges() writes it: "famcal 2026-10-01→2026-11-01". */
  const monthAsk = (month: MonthKey, o: { fresh?: boolean } = {}) => `famcal ${monthWindow(month).from}→${monthWindow(month).to}${o.fresh ? ' fresh' : ''}`;
  /** Runs the frames requested so far (and any they request), inside act. */
  const flushFrames = () =>
    React.act(() => {
      for (let round = 0; round < 5 && frames.size > 0; round++) {
        const batch = [...frames.values()];
        frames.clear();
        for (const run of batch) run();
      }
    });
  /** The user scrolls the page to `top`: the window gets a scroll event, and the next frame measures. */
  const scrollPageTo = (top: number) => {
    fakeWindow.scrollY = top;
    React.act(() => windowListeners.filter((l) => l.type === 'scroll').forEach((l) => l.fn()));
    flushFrames();
  };
  type Home = Awaited<ReturnType<typeof mountHome>>;
  const tabButton = (m: Home, id: 'agenda' | 'month') => {
    const found = elements(m.container).find((e) => e.getAttribute('id') === TAB_IDS[id]);
    assert(found, `no ${id} tab`);
    return found;
  };
  const panel = (m: Home, id: 'agenda' | 'month') => {
    const found = elements(m.container).find((e) => e.getAttribute('id') === PANEL_IDS[id]);
    assert(found, `no ${id} panel`);
    return found;
  };
  const browseShown = (m: Home) => byClass(m.container, 'ch-mb').length === 1;
  const pickedShown = (m: Home) => byClass(m.container, 'ch-mp').length === 1;
  const barMonth = (m: Home) => byClass(m.container, 'ch-mb-bar-month')[0]?.textContent ?? null;
  /** A day's button in browse (inside its month's block) or in picked, by its label's start. */
  const dayButton = (m: Home, dayKey: DayKey) => {
    const where = browseShown(m) ? byClass(byData(m.container, 'month', dayKey.slice(0, 7)), 'ch-mb-cell') : byClass(m.container, 'ch-mp-cell');
    const found = where.filter((e) => (e.getAttribute('aria-label') ?? '').startsWith(formatDayLong(dayKey, 'en')));
    assert(found.length === 1, `no day button for ${dayKey}`);
    return found[0];
  };
  /** A tap on the Month tab, then what follows: the answers, the first frame's measure, their effects. */
  const openMonth = async (m: Home) => {
    m.click(tabButton(m, 'month'));
    await settle();
    flushFrames();
    await settle();
  };
  const tap = async (m: Home, el: FakeNode) => {
    m.click(el);
    await settle();
    flushFrames();
    await settle();
  };
  const swipeCalls = (calls: string[]) => calls.filter((c) => /VerticalSwipes/.test(c));
  const backCalls = (calls: string[]) => calls.filter((c) => c.startsWith('BackButton'));

  await check('#43 the Month\'s parts are client-safe, and its views are a chunk of their own (every /dashboard open preloads CalendarHome\'s chunk, the users the switch doesn\'t cover included): CalendarHome loads HomeTabs, month.ts, grid.ts, home-storage.ts and hebrew-date.ts, and reaches MonthView only through one import(), never MonthBrowse or MonthPicked; MonthView loads both; neither graph has a server module or @hebcal/core', () => {
    const graph = (id: string) => {
      const loaded = new Set<string>();
      const walk = (at: string) => {
        for (const child of require.cache[at]?.children ?? []) {
          if (loaded.has(child.id)) continue;
          loaded.add(child.id);
          walk(child.id);
        }
      };
      walk(id);
      return loaded;
    };
    const dashboard = (f: string) => path.join(ROOT, 'app/[locale]/dashboard', f);
    const root = dashboard('CalendarHome.tsx');
    const home = graph(root);
    for (const want of [dashboard('HomeTabs.tsx'), ...['month.ts', 'grid.ts', 'home-storage.ts', 'hebrew-date.ts'].map((f) => path.join(ROOT, 'src/lib/calendar-view', f))]) {
      assert(home.has(want), `${path.relative(ROOT, want)} not among CalendarHome's modules`);
    }
    const views = ['MonthView.tsx', 'MonthBrowse.tsx', 'MonthPicked.tsx'].map(dashboard);
    assert(views.every((v) => !home.has(v)), `in CalendarHome's own chunk: ${show(views.filter((v) => home.has(v)).map((v) => path.relative(ROOT, v)))}`);
    const source = fs.readFileSync(root, 'utf8');
    assert((source.match(/import\('\.\/MonthView'\)/g) ?? []).length === 1, 'one import() of ./MonthView');
    assert(!/^import (?!type )[^;]*from '\.\/Month(?:View|Browse|Picked)';/m.test(source), 'a static import of a Month view');
    nodeRequire(views[0]);
    const view = graph(views[0]);
    assert(view.has(views[1]) && view.has(views[2]), 'MonthView loads MonthBrowse and MonthPicked');
    const forbidden = [...home, ...view].filter((p) =>
      /[\\/](src[\\/](services|utils|config)|@prisma|\.prisma|@upstash|date-fns-tz|@hebcal[\\/]core|googleapis|@googleapis)[\\/]|src[\\/]lib[\\/](page-data|api-auth|prisma)/.test(p),
    );
    assert(forbidden.length === 0, `server modules in the home's graph: ${show(forbidden.map((p) => path.relative(ROOT, p)))}`);
  });

  await check('#44 the tab bar (Rulings 1 and 2): under the header and above the banners; a tap on Month shows the Month panel, closes the item sheet and is kept for the session; back on the Agenda the page goes to the top; a remount in the session opens on the Month, a new session or another user on the Agenda; in Hebrew the bar runs right to left', async () => {
    resetHome();
    const tg = fakeTelegramHome();
    fakeWindow.Telegram = { WebApp: tg.webApp };
    answerFetch = (c) => answerFor(c, { items: WEEK });
    const clock = fakeClock('2026-10-15T07:00:00Z');
    const m = await mountHome('en', { trialDaysLeft: 5, hasLocation: true }, clock);
    try {
      const html = m.html();
      const order = ['class="ch-head"', 'role="tablist"', 'data-banner="trial"', 'role="tabpanel"'].map((s) => html.indexOf(s));
      assert(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1])), `the header, the tab bar, the banners, then the panel: ${show(order)}`);
      assert(panel(m, 'agenda').getAttribute('aria-labelledby') === TAB_IDS.agenda && panel(m, 'month').getAttribute('aria-labelledby') === TAB_IDS.month, 'each panel is labelled by its tab');
      assert(panel(m, 'month').hasAttribute('hidden') && panel(m, 'month').childNodes.length === 0, 'the Month panel is there for aria-controls, hidden and empty');
      m.click(button(m.container, 'Dentist'));
      assert(byRole(m.container, 'dialog').length === 1, 'the item sheet is open');
      await openMonth(m);
      assert(byRole(m.container, 'dialog').length === 0, 'the switch closed the item sheet');
      assert(tabButton(m, 'month').getAttribute('aria-selected') === 'true' && tabButton(m, 'agenda').getAttribute('aria-selected') === 'false', 'Month is selected');
      assert(!panel(m, 'month').hasAttribute('hidden') && panel(m, 'agenda').hasAttribute('hidden') && panel(m, 'agenda').childNodes.length === 0, 'the Month panel shows; the Agenda is unmounted');
      assert(browseShown(m) && byClass(m.container, 'ch-agenda').length === 0, 'MonthBrowse in the Month panel');
      assert(fakeWindow.sessionStorage.getItem(homeTabKey(5550001)) === 'month', 'the tab is kept for the session');
      assert(tg.backHandlers() === 0, `no BackButton in browse: ${show(backCalls(tg.calls))}`);
      m.click(byLabel(m.container, 'Menu'));
      assert(byRole(m.container, 'dialog').length === 1, 'the menu is open');
      scrollCalls.length = 0;
      m.click(tabButton(m, 'agenda'));
      await settle();
      assert(byRole(m.container, 'dialog').length === 0, 'the switch closed the menu');
      assert(show(scrollCalls) === show([{ top: 0, behavior: 'plain' }]), `the Agenda opens at the top: ${show(scrollCalls)}`);
      assertHas(m.text(), [`Today ${ref.dayShort('en-GB', day(0))} 4 Cheshvan`, 'Show next week'], 'the Agenda again');
      assert(fakeWindow.sessionStorage.getItem(homeTabKey(5550001)) === 'agenda', 'the Agenda is kept');
      m.click(tabButton(m, 'month'));
      await settle();
    } finally {
      m.unmount();
      fakeWindow.Telegram = undefined;
    }
    const again = await mountHome('en', {}, fakeClock('2026-10-15T07:00:00Z'));
    try {
      assert(tabButton(again, 'month').getAttribute('aria-selected') === 'true' && browseShown(again), 'a remount in the same session opens on the Month');
    } finally {
      again.unmount();
    }
    const other = await mountHome('en', GOOGLE_HOME, fakeClock('2026-10-15T07:00:00Z'));
    try {
      assert(tabButton(other, 'agenda').getAttribute('aria-selected') === 'true', 'another user on the device keeps their own tab');
    } finally {
      other.unmount();
    }
    resetHome();
    answerFetch = (c) => answerFor(c, { items: WEEK });
    const fresh = await mountHome('he', {}, fakeClock('2026-10-15T07:00:00Z'));
    try {
      assert(tabButton(fresh, 'agenda').getAttribute('aria-selected') === 'true' && !browseShown(fresh), 'a new session opens on the Agenda');
      assert(/<div class="ch-tabs" role="tablist" aria-label="תצוגת היומן" dir="rtl">/.test(fresh.html()), 'he: the tablist reads right to left');
      assertHas(textOf(htmlOf(byRole(fresh.container, 'tablist')[0])), ['סדר יום חודש'], 'he: the tab labels');
    } finally {
      fresh.unmount();
    }
  });

  await check('#45 the Month opens on today\'s month with a peek: placeholders and swipes off before the first answer; then one instant scroll puts October\'s title under the bar with half a week row of September above it; its windows are a month\'s own days ([2026-10-01, 2026-11-01) first), at most 2 in flight, each asked once; a month coming near is asked at once', async () => {
    resetHome();
    fakeWindow.sessionStorage.setItem(homeTabKey(5550001), 'month');
    const tg = fakeTelegramHome({ version: '7.7' });
    fakeWindow.Telegram = { WebApp: tg.webApp };
    const held: { call: FetchCall; resolve: (a: FetchAnswer) => void }[] = [];
    let first: (a: FetchAnswer) => void = noop;
    answerFetch = (c) =>
      new Promise<FetchAnswer>((resolve) => {
        if (c.query.has('from')) held.push({ call: c, resolve });
        else first = resolve;
      });
    const answerOne = async (month: MonthKey) => {
      const at = held.findIndex((h) => h.call.query.get('from') === monthWindow(month).from);
      assert(at >= 0, `${month} is not in flight: ${show(held.map((h) => h.call.query.get('from')))}`);
      const [h] = held.splice(at, 1);
      await React.act(async () => h.resolve(answerFor(h.call, { items: WEEK })));
      await settle();
      flushFrames();
      await settle();
    };
    const m = await mountHome('en', {}, fakeClock('2026-10-15T07:00:00Z'));
    try {
      assertHas(textOf(htmlOf(panel(m, 'month'))), ['Loading your calendar…'], 'before the first answer: the Month\'s placeholders');
      assert(!browseShown(m) && !/class="ch-mb-cell/.test(m.html()), 'no grid, so no free-looking day, before the facts');
      assert(show(swipeCalls(tg.calls)) === show(['disableVerticalSwipes()']), `swipes off while browse loads: ${show(swipeCalls(tg.calls))}`);
      await React.act(async () => first(answerFor({ query: new URLSearchParams() } as FetchCall, { items: WEEK })));
      await settle();
      assert(browseShown(m), 'the Month tab, kept for the session, opens in browse');
      assert(show(scrollCalls) === show([{ top: underBar('2026-10', BROWSE_CELL_PX / 2), behavior: 'instant' }]), `the opening scroll: ${show(scrollCalls)} (want ${underBar('2026-10', BROWSE_CELL_PX / 2)})`);
      assert(show(ranges()) === show(['famcal default', monthAsk('2026-10'), monthAsk('2026-11')]), `October, then November; September waits: ${show(ranges())}`);
      flushFrames();
      await settle();
      assert(barMonth(m) === 'October 2026', `the bar: ${barMonth(m)}`);
      assert(dayButton(m, TODAY).getAttribute('aria-current') === 'date', 'today\'s cell');
      FakeIO.all[0].fire({ '2026-08': false, '2026-09': true, '2026-10': true, '2026-11': true, '2026-12': true });
      flushFrames();
      await settle();
      assert(ranges().length === 3 && held.length === MONTH_INFLIGHT_MAX, `still 2 in flight: ${show(ranges())}`);
      await answerOne('2026-10');
      assert(show(ranges().slice(3)) === show([monthAsk('2026-09')]), `a slot frees: September, the nearest one waiting: ${show(ranges())}`);
      assert(held.length <= MONTH_INFLIGHT_MAX, `in flight: ${held.length}`);
      await answerOne('2026-11');
      assert(show(ranges().slice(3)) === show([monthAsk('2026-09'), monthAsk('2026-12')]), `then December: ${show(ranges())}`);
      await answerOne('2026-09');
      await answerOne('2026-12');
      FakeIO.all[0].fire({ '2026-09': true, '2026-12': false });
      flushFrames();
      await settle();
      scrollPageTo(fakeWindow.scrollY + 30);
      await settle();
      const asked = ranges();
      assert(new Set(asked).size === asked.length && asked.length === 5, `each window once: ${show(asked)}`);
      assert(!asked.some((r) => r.startsWith(`famcal ${day(0)}`)), 'the Agenda\'s week isn\'t asked again on the Month');
      const october = textOf(htmlOf(byData(m.container, 'month', '2026-10')));
      assertHas(october, ['October', 'Dentist', 'Grandma visits', 'Trip to Eilat'], 'October\'s chips');
      assert(!/loading/.test(dayButton(m, '2026-10-02').getAttribute('aria-label') ?? ''), 'an answered day reads answered');
      // January comes near (no answer has changed the store): it is asked at once.
      FakeIO.all[0].fire({ '2027-01': true });
      flushFrames();
      await settle();
      assert(show(ranges().slice(5)) === show([monthAsk('2027-01')]), `a month coming near: ${show(ranges())}`);
    } finally {
      m.unmount();
      fakeWindow.Telegram = undefined;
    }
  });

  await check('#46 swipes (Ruling 9): on a 7.7 client they go off in browse and on in picked, on the Agenda and on unmount, enabled on mount, isVerticalSwipesEnabled never read; a 7.0 client gets no swipe call', async () => {
    for (const version of ['7.7', '7.0']) {
      resetHome();
      const tg = fakeTelegramHome({ version });
      let reads = 0;
      Object.defineProperty(tg.webApp, 'isVerticalSwipesEnabled', {
        get() {
          reads++;
          throw new Error('isVerticalSwipesEnabled must never be read');
        },
      });
      fakeWindow.Telegram = { WebApp: tg.webApp };
      answerFetch = (c) => answerFor(c, { items: WEEK });
      const m = await mountHome('en', {}, fakeClock('2026-10-15T07:00:00Z'));
      const steps: string[][] = [];
      const step = () => {
        steps.push(swipeCalls(tg.calls));
        tg.calls.length = 0;
      };
      try {
        step(); // mount, on the Agenda
        await openMonth(m);
        step(); // browse
        await tap(m, dayButton(m, '2026-10-20'));
        assert(pickedShown(m), `${version}: picked`);
        step(); // picked
        React.act(() => tg.fire('backButtonClicked'));
        await settle();
        flushFrames();
        step(); // back in browse
        m.click(tabButton(m, 'agenda'));
        await settle();
        step(); // the Agenda
        await openMonth(m);
        tg.calls.length = 0;
      } finally {
        m.unmount();
        fakeWindow.Telegram = undefined;
      }
      step(); // unmount
      const want =
        version === '7.7'
          ? [['enableVerticalSwipes()'], ['disableVerticalSwipes()'], ['enableVerticalSwipes()'], ['disableVerticalSwipes()'], ['enableVerticalSwipes()'], ['enableVerticalSwipes()']]
          : [[], [], [], [], [], []];
      assert(show(steps) === show(want), `${version}: ${show(steps)}`);
      assert(reads === 0, `${version}: isVerticalSwipesEnabled was read ${reads} times`);
    }
  });

  await check('#47 picked (spec §7.4, §7.6): a tap on a day opens it, shows the BackButton and keeps "picked" on the device; with the item sheet over it one tap closes only the sheet, the next goes back to browse with the picked month under the bar; a tab switch brings browse back on the month that was in view', async () => {
    resetHome();
    const tg = fakeTelegramHome();
    fakeWindow.Telegram = { WebApp: tg.webApp };
    answerFetch = (c) => answerFor(c, { items: WEEK });
    const m = await mountHome('en', {}, fakeClock('2026-10-15T07:00:00Z'));
    try {
      await openMonth(m);
      tg.calls.length = 0;
      scrollCalls.length = 0;
      await tap(m, dayButton(m, TODAY));
      assert(pickedShown(m) && !browseShown(m), 'picked');
      assert(show(backCalls(tg.calls)) === show(['BackButton.onClick', 'BackButton.show()']), `the BackButton shows: ${show(backCalls(tg.calls))}`);
      assert(fakeWindow.localStorage.getItem(monthLayoutKey(5550001)) === 'picked', 'the layout is kept on the device');
      assert(show(scrollCalls) === show([{ top: 0, behavior: 'plain' }]), `picked starts at the top: ${show(scrollCalls)}`);
      assertHas(m.text(), ['All months', 'October 2026', 'Today · Thursday, 15 October', '09:30 10:30 Dentist'], 'the picked day and its rows');
      // The item sheet over picked: the button stays; one tap closes only the sheet.
      tg.calls.length = 0;
      m.click(button(m.container, 'Dentist'));
      assert(byRole(m.container, 'dialog').length === 1 && dialogText(m.container).includes('Clinic on Herzl St'), 'the item sheet over picked');
      assert(backCalls(tg.calls).length === 0 && tg.backHandlers() === 1, `the button was already there: ${show(backCalls(tg.calls))}`);
      // A refetch meanwhile: the sheet shows the row as the latest answer has it.
      const moved = item('dentist', { ...DENTIST, location: 'Clinic on Jaffa Rd' });
      answerFetch = (c) => answerFor(c, { items: { ...WEEK, [day(0)]: [VITAMINS, moved, FORM, SNOOZED, FOOTBALL, CONCERT] } });
      fireDocument('visibilitychange');
      await settle();
      assert(dialogText(m.container).includes('Clinic on Jaffa Rd'), `the sheet after a refetch: ${dialogText(m.container).slice(0, 200)}`);
      React.act(() => tg.fire('backButtonClicked'));
      await settle();
      assert(byRole(m.container, 'dialog').length === 0 && pickedShown(m), 'one tap closed only the sheet');
      assert(backCalls(tg.calls).length === 0 && tg.backHandlers() === 1, `the button stays for picked: ${show(backCalls(tg.calls))}`);
      // The next tap: browse, on the picked month. A chevron moves it to November first: the
      // same MonthPicked (no scroll to the top), December asked at once, and an item sheet
      // still open when the day changes (the check taps the chevron behind it; the sheet keeps
      // a keyboard's focus, #59) closes with the day it showed.
      answerFetch = (c) => answerFor(c, { items: WEEK });
      assert(!ranges().includes(monthAsk('2026-12')), 'December not asked yet');
      m.click(button(m.container, 'Dentist'));
      assert(byRole(m.container, 'dialog').length === 1, 'the sheet again');
      const picked = byClass(m.container, 'ch-mp')[0];
      scrollCalls.length = 0;
      m.click(byLabel(m.container, 'Next month'));
      await settle();
      assertHas(m.text(), ['November 2026'], 'the next month');
      assert(byClass(m.container, 'ch-mp')[0] === picked && scrollCalls.length === 0, `one MonthPicked, not keyed by month: ${show(scrollCalls)}`);
      assert(byRole(m.container, 'dialog').length === 0, 'the sheet closed with its day');
      assert(ranges().includes(monthAsk('2026-12')), `the chevron asks the month after November: ${show(ranges())}`);
      tg.calls.length = 0;
      React.act(() => tg.fire('backButtonClicked'));
      await settle();
      assert(browseShown(m) && !pickedShown(m), 'back in browse');
      assert(show(backCalls(tg.calls)) === show(['BackButton.offClick', 'BackButton.hide()']) && tg.backHandlers() === 0, `the button goes: ${show(backCalls(tg.calls))}`);
      assert(fakeWindow.localStorage.getItem(monthLayoutKey(5550001)) === 'browse', 'browse is kept');
      assert(show(scrollCalls) === show([{ top: underBar('2026-11'), behavior: 'instant' }]), `November under the bar, no peek: ${show(scrollCalls)}`);
      // Before browse's first frame reports, the Month's windows centre on November, not on what was in view before picked.
      const held: { call: FetchCall; resolve: (a: FetchAnswer) => void }[] = [];
      answerFetch = (c) => new Promise<FetchAnswer>((resolve) => held.push({ call: c, resolve }));
      fetchCalls.length = 0;
      fireDocument('visibilitychange');
      await settle();
      assert(show(ranges()) === show([monthAsk('2026-11'), monthAsk('2026-12')]), `centred on November: ${show(ranges())}`);
      for (const h of held.splice(0)) await React.act(async () => h.resolve(answerFor(h.call, { items: WEEK })));
      await settle();
      for (const h of held.splice(0)) await React.act(async () => h.resolve(answerFor(h.call, { items: WEEK })));
      answerFetch = (c) => answerFor(c, { items: WEEK });
      await settle();
      flushFrames();
      await settle();
      assert(barMonth(m) === 'November 2026', `the bar: ${barMonth(m)}`);
      // "All months" does the same.
      await tap(m, dayButton(m, '2026-11-03'));
      m.click(button(m.container, 'All months'));
      await settle();
      flushFrames();
      assert(browseShown(m) && barMonth(m) === 'November 2026', 'All months: browse on November');
      // The month in view is kept across a tab switch.
      scrollPageTo(inViewAt('2027-01'));
      await settle();
      assert(barMonth(m) === 'January 2027', `scrolled to January: ${barMonth(m)}`);
      m.click(tabButton(m, 'agenda'));
      await settle();
      scrollCalls.length = 0;
      await openMonth(m);
      assert(show(scrollCalls) === show([{ top: underBar('2027-01'), behavior: 'instant' }]), `browse comes back on January, no peek: ${show(scrollCalls)}`);
      assert(barMonth(m) === 'January 2027', `the bar: ${barMonth(m)}`);
    } finally {
      m.unmount();
      fakeWindow.Telegram = undefined;
    }
  });

  await check('#48 a restored picked layout opens on today with the BackButton shown, and asks the picked month, the one after, then the one before; its BackButton goes to browse on October', async () => {
    resetHome();
    fakeWindow.sessionStorage.setItem(homeTabKey(5550001), 'month');
    fakeWindow.localStorage.setItem(monthLayoutKey(5550001), 'picked');
    const tg = fakeTelegramHome();
    fakeWindow.Telegram = { WebApp: tg.webApp };
    answerFetch = (c) => answerFor(c, { items: WEEK });
    const m = await mountHome('en', {}, fakeClock('2026-10-15T07:00:00Z'));
    try {
      assert(pickedShown(m), 'picked');
      assert(dayButton(m, TODAY).getAttribute('aria-pressed') === 'true', 'today is the selected day');
      assertHas(m.text(), ['Today · Thursday, 15 October', 'Dentist'], 'today\'s list');
      assert(show(backCalls(tg.calls)) === show(['BackButton.hide()', 'BackButton.onClick', 'BackButton.show()']), `hidden on mount, then shown for picked: ${show(backCalls(tg.calls))}`);
      assert(show(ranges()) === show(['famcal default', monthAsk('2026-10'), monthAsk('2026-11'), monthAsk('2026-09')]), `the picked month, then its neighbours: ${show(ranges())}`);
      React.act(() => tg.fire('backButtonClicked'));
      await settle();
      flushFrames();
      assert(browseShown(m) && barMonth(m) === 'October 2026', `browse on October: ${barMonth(m)}`);
    } finally {
      m.unmount();
      fakeWindow.Telegram = undefined;
    }
    // Opened on the Agenda, with the Month not seen yet when midnight passes: it still opens on the new today.
    resetHome();
    fakeWindow.localStorage.setItem(monthLayoutKey(5550001), 'picked');
    const clock = fakeClock('2026-10-15T20:59:30Z'); // 23:59:30 in Israel, Thursday 15 October
    let serverToday = TODAY;
    answerFetch = (c) => (serverToday === TODAY ? answerFor(c, { items: WEEK }) : answerFor(c, { today: day(1), from: c.query.get('from') ?? day(1), to: c.query.get('to') ?? day(8), items: { [day(1)]: [GRANDMA] } }));
    const n = await mountHome('en', {}, clock);
    try {
      serverToday = day(1);
      await clock.advance(31_000);
      assert(n.html().includes('<h1 class="ch-head-title">Friday, 16 October</h1>'), 'the new day');
      await openMonth(n);
      assert(pickedShown(n) && dayButton(n, day(1)).getAttribute('aria-pressed') === 'true', 'picked opens on the new today');
      assertHas(n.text(), ['Today · Friday, 16 October', 'Grandma visits'], 'the new today\'s list');
    } finally {
      n.unmount();
    }
  });

  await check('#49 on the Month, a return to the foreground asks its windows again, not the Agenda\'s week, two at a time; ⋯ → Refresh sends fresh=1 on each; on the Agenda the same return asks only its week', async () => {
    resetHome();
    fakeWindow.sessionStorage.setItem(homeTabKey(5550001), 'month');
    answerFetch = (c) => answerFor(c, { items: WEEK });
    const m = await mountHome('en', {}, fakeClock('2026-10-15T07:00:00Z'));
    try {
      flushFrames();
      await settle();
      assert(show(ranges()) === show(['famcal default', monthAsk('2026-10'), monthAsk('2026-11'), monthAsk('2026-09')]), `the first asks: ${show(ranges())}`);
      const held: { call: FetchCall; resolve: (a: FetchAnswer) => void }[] = [];
      answerFetch = (c) => new Promise<FetchAnswer>((resolve) => held.push({ call: c, resolve }));
      const releaseAll = async () => {
        while (held.length > 0) {
          const h = held.shift() as (typeof held)[number];
          await React.act(async () => h.resolve(answerFor(h.call, { items: WEEK })));
          await settle();
        }
      };
      fetchCalls.length = 0;
      fireDocument('visibilitychange');
      await settle();
      assert(show(ranges()) === show([monthAsk('2026-10'), monthAsk('2026-11')]) && held.length === 2, `the foreground: the Month's windows, two in flight: ${show(ranges())}`);
      await releaseAll();
      assert(show(ranges()) === show([monthAsk('2026-10'), monthAsk('2026-11'), monthAsk('2026-09')]), `then the third: ${show(ranges())}`);
      fetchCalls.length = 0;
      m.click(byLabel(m.container, 'Menu'));
      m.click(byData(m.container, 'menu', 'refresh'));
      await settle();
      assert(byRole(m.container, 'dialog').length === 0, 'the menu closed');
      await releaseAll();
      assert(show(ranges()) === show(['2026-10', '2026-11', '2026-09'].map((mo) => monthAsk(mo, { fresh: true }))), `Refresh: fresh=1 on each: ${show(ranges())}`);
      fetchCalls.length = 0;
      answerFetch = (c) => answerFor(c, { items: WEEK });
      m.click(tabButton(m, 'agenda'));
      await settle();
      fetchCalls.length = 0;
      fireDocument('visibilitychange');
      await settle();
      assert(show(ranges()) === show([`famcal ${day(0)}→${day(7)}`]), `on the Agenda, only its week: ${show(ranges())}`);
    } finally {
      m.unmount();
    }
  });

  await check('#50 a month that fails (500) shows "Couldn\'t load this month · Retry" over dimmed cells that never look free; Retry asks that month\'s window again, and the answer clears it', async () => {
    resetHome();
    fakeWindow.sessionStorage.setItem(homeTabKey(5550001), 'month');
    let october: FetchAnswer = { status: 500, body: { error: 'internal_error' } };
    answerFetch = (c) => (c.query.get('from') === '2026-10-01' ? october : answerFor(c, { items: WEEK }));
    const m = await mountHome('en', {}, fakeClock('2026-10-15T07:00:00Z'));
    try {
      flushFrames();
      await settle();
      const block = () => byData(m.container, 'month', '2026-10');
      assertHas(textOf(htmlOf(block())), ['Couldn’t load this month Retry'], 'the pill');
      assert(/couldn’t load/.test(dayButton(m, '2026-10-02').getAttribute('aria-label') ?? '') && dayButton(m, '2026-10-02').className.includes('is-failed'), 'a failed day reads failed, dimmed');
      assert(!/nothing planned/.test(dayButton(m, '2026-10-02').getAttribute('aria-label') ?? ''), 'never free');
      assert(/nothing planned/.test(dayButton(m, '2026-10-17').getAttribute('aria-label') ?? ''), 'the Agenda\'s answered week stays answered');
      october = answerFor({ query: new URLSearchParams('from=2026-10-01&to=2026-11-01') } as FetchCall, { items: WEEK });
      fetchCalls.length = 0;
      await tap(m, button(block(), 'Retry'));
      assert(show(ranges()) === show([monthAsk('2026-10')]), `Retry: ${show(ranges())}`);
      assertLacks(textOf(htmlOf(block())), ['Couldn’t load this month'], 'the pill goes');
      assert(/nothing planned/.test(dayButton(m, '2026-10-02').getAttribute('aria-label') ?? ''), 'then the day is answered');
    } finally {
      m.unmount();
    }
  });

  await check('#51 midnight on the Month: browse stays where it is (no new opening scroll), its cells loading and never free until the new day\'s answer; then today moves to the 16th and the windows are asked again in the new epoch', async () => {
    resetHome();
    fakeWindow.sessionStorage.setItem(homeTabKey(5550001), 'month');
    const clock = fakeClock('2026-10-15T20:59:30Z'); // 23:59:30 in Israel, Thursday 15 October
    answerFetch = (c) => answerFor(c, { items: WEEK });
    const m = await mountHome('en', {}, clock);
    try {
      flushFrames();
      await settle();
      const browse = byClass(m.container, 'ch-mb')[0];
      assert(browse && scrollCalls.length === 1, `browse, opened once: ${show(scrollCalls)}`);
      let release: (a: FetchAnswer) => void = noop;
      answerFetch = (c) =>
        c.query.has('from') ? answerFor(c, { today: day(1), items: { [day(1)]: [GRANDMA] } }) : new Promise<FetchAnswer>((resolve) => (release = resolve));
      fetchCalls.length = 0;
      await clock.advance(31_000);
      flushFrames();
      assert(show(ranges()) === show(['famcal default']), `the new day's no-dates request: ${show(ranges())}`);
      assert(byClass(m.container, 'ch-mb')[0] === browse && scrollCalls.length === 1, 'browse stayed mounted, no new opening scroll');
      assert(/loading/.test(dayButton(m, '2026-10-17').getAttribute('aria-label') ?? ''), 'the cells read loading');
      assertLacks(textOf(htmlOf(byData(m.container, 'month', '2026-10'))), ['Dentist', 'nothing planned'], 'nothing of Thursday\'s, no free day');
      await React.act(async () => release(answerFor({ query: new URLSearchParams() } as FetchCall, { today: day(1), from: day(1), to: day(8), items: { [day(1)]: [GRANDMA] } })));
      await settle();
      flushFrames();
      await settle();
      assert(m.html().includes('<h1 class="ch-head-title">Friday, 16 October</h1>'), `the header: ${m.text().slice(0, 80)}`);
      assert(dayButton(m, day(1)).getAttribute('aria-current') === 'date' && dayButton(m, TODAY).getAttribute('aria-current') === null, 'today moved to the 16th');
      assert(show(ranges()) === show(['famcal default', monthAsk('2026-10'), monthAsk('2026-11'), monthAsk('2026-09')]), `the windows again: ${show(ranges())}`);
      assert(byClass(m.container, 'ch-mb')[0] === browse && scrollCalls.length === 1, 'still the same browse, still one opening scroll');
    } finally {
      m.unmount();
    }
    // Picked on Tuesday 20 October at midnight: picked stays on that day (clampMonthUi), mounted, loading, then answered.
    resetHome();
    fakeWindow.sessionStorage.setItem(homeTabKey(5550001), 'month');
    const late = fakeClock('2026-10-15T20:59:30Z');
    answerFetch = (c) => answerFor(c, { items: WEEK });
    const p = await mountHome('en', {}, late);
    try {
      flushFrames();
      await tap(p, dayButton(p, '2026-10-20'));
      const picked = byClass(p.container, 'ch-mp')[0];
      assert(picked && dayButton(p, '2026-10-20').getAttribute('aria-pressed') === 'true', 'picked on the 20th');
      let release: (a: FetchAnswer) => void = noop;
      answerFetch = (c) =>
        c.query.has('from') ? answerFor(c, { today: day(1), items: { [day(1)]: [GRANDMA] } }) : new Promise<FetchAnswer>((resolve) => (release = resolve));
      scrollCalls.length = 0;
      await late.advance(31_000);
      assert(byClass(p.container, 'ch-mp')[0] === picked && scrollCalls.length === 0, 'picked stayed mounted, no scroll to the top');
      assert(/loading/.test(dayButton(p, '2026-10-21').getAttribute('aria-label') ?? '') && dayButton(p, '2026-10-20').getAttribute('aria-pressed') === 'true', 'loading, the 20th still picked');
      assertLacks(textOf(htmlOf(picked)), ['Nothing planned'], 'never free while loading');
      await React.act(async () => release(answerFor({ query: new URLSearchParams() } as FetchCall, { today: day(1), from: day(1), to: day(8), items: { [day(1)]: [GRANDMA] } })));
      await settle();
      assert(dayButton(p, '2026-10-20').getAttribute('aria-pressed') === 'true' && dayButton(p, day(1)).getAttribute('aria-current') === 'date', 'the 20th stays picked; today is the 16th');
      assertHas(p.text(), ['Tuesday, 20 October', 'Nothing planned', 'Today'], 'the 20th answered, and the Today pill');
    } finally {
      p.unmount();
    }
  });

  await check('#52 a Google user still setting up (Ruling 1): no tab bar and no tab panel even with the Month remembered, which is left as it is; the Agenda\'s setup shape as in D, no month request, and swipes stay on', async () => {
    resetHome();
    fakeWindow.sessionStorage.setItem(homeTabKey(5550002), 'month');
    const tg = fakeTelegramHome({ version: '7.7' });
    fakeWindow.Telegram = { WebApp: tg.webApp };
    answerFetch = () => ok200(googleAnswer({ calendars: [] }));
    const m = await mountHome('en', { ...GOOGLE_HOME, needsCalendars: true });
    try {
      assertLacks(m.html(), ['role="tablist"', 'role="tab"', 'role="tabpanel"', 'class="ch-mb', 'class="ch-mp'], 'no tabs, no Month');
      assert(m.html().includes('data-banner="chooseCalendars"') && byClass(m.container, 'ch-agenda').length === 1, 'the banner and the (empty) Agenda');
      assert(show(ranges()) === show(['google default']), `one request: ${show(ranges())}`);
      assert(fakeWindow.sessionStorage.getItem(homeTabKey(5550002)) === 'month', 'the stored tab is left as it is');
      assert(show(swipeCalls(tg.calls)) === show(['enableVerticalSwipes()']), `swipes on: ${show(swipeCalls(tg.calls))}`);
    } finally {
      m.unmount();
      fakeWindow.Telegram = undefined;
    }
    // The busy card before any answer: no tab bar either.
    resetHome();
    fakeWindow.sessionStorage.setItem(homeTabKey(5550001), 'month');
    answerFetch = () => ({ status: 429, body: {} });
    const b = await mountHome('en');
    try {
      assertHas(b.text(), ['Busy right now, try again in a minute Retry'], 'the busy card');
      assertLacks(b.html(), ['role="tablist"', 'role="tabpanel"', 'Loading your calendar'], 'no tab bar over a card');
    } finally {
      b.unmount();
    }
  });

  await check('#53 404 not_enabled on the Month lets both of Telegram\'s controls go before the reload: the BackButton (offClick, hide), then swipes back on, then the reload', async () => {
    resetHome();
    fakeWindow.sessionStorage.setItem(homeTabKey(5550001), 'month');
    const tg = fakeTelegramHome({ version: '7.7' });
    fakeWindow.Telegram = { WebApp: tg.webApp };
    fakeWindow.location = { hash: '', reload: () => void tg.calls.push('location.reload()') };
    answerFetch = (c) => answerFor(c, { items: WEEK });
    const m = await mountHome('en', {}, fakeClock('2026-10-15T07:00:00Z'));
    try {
      flushFrames();
      assert(swipeCalls(tg.calls).at(-1) === 'disableVerticalSwipes()', `browse locked the swipes: ${show(swipeCalls(tg.calls))}`);
      m.click(byLabel(m.container, 'Menu'));
      assert(tg.backHandlers() === 1, 'the menu shows the BackButton');
      tg.calls.length = 0;
      answerFetch = () => ({ status: 404, body: { error: 'not_enabled' } });
      fireDocument('visibilitychange');
      await settle();
      const steps = tg.calls.filter((c) => c.startsWith('BackButton') || /VerticalSwipes/.test(c) || c === 'location.reload()');
      assert(show(steps.slice(0, 4)) === show(['BackButton.offClick', 'BackButton.hide()', 'enableVerticalSwipes()', 'location.reload()']), `before the reload: ${show(steps)}`);
      assert(tg.backHandlers() === 0, 'no handler left');
    } finally {
      m.unmount();
      fakeWindow.Telegram = undefined;
    }
  });

  await check('#54 no ancestor of the Month clips or transforms (spec §7.1): from the sticky bar and from picked up to the root, no rule or style sets overflow hidden, auto or scroll, a transform or a filter', async () => {
    resetHome();
    fakeWindow.sessionStorage.setItem(homeTabKey(5550001), 'month');
    answerFetch = (c) => answerFor(c, { items: WEEK });
    const m = await mountHome('en', { trialDaysLeft: 5 }, fakeClock('2026-10-15T07:00:00Z'));
    try {
      flushFrames();
      const css = elements(m.container)
        .filter((e) => e.localName === 'style')
        .map((e) => e.textContent)
        .join('\n');
      const bad = /(?:^|;|\{)\s*(?:overflow(?:-[xy])?\s*:\s*(?:hidden|auto|scroll)|transform\s*:|filter\s*:)/;
      // The last compound of each selector (".ch-home[dir='rtl'] .ch-flip" → ".ch-flip"), as tag and classes.
      const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
        .filter((r) => bad.test(`{${r[2]}`))
        .flatMap((r) => r[1].split(',').map((sel) => sel.trim().split(/[\s>+~]+/).pop() ?? ''))
        .map((last) => ({ last, tag: /^[a-z][\w-]*/.exec(last)?.[0] ?? null, classes: [...last.matchAll(/\.([\w-]+)/g)].map((x) => x[1]) }))
        .filter((r) => r.tag !== null || r.classes.length > 0);
      assert(rules.some((r) => r.classes.includes('ch-visually-hidden')), `the rule scan reads the sheets: ${show(rules.map((r) => r.last).slice(0, 8))}`);
      const ancestorsOf = (el: FakeElement) => {
        const out: FakeElement[] = [];
        for (let n = el.parentNode; n && n !== m.container; n = n.parentNode) if (n instanceof FakeElement) out.push(n);
        return out;
      };
      const offenders = (el: FakeElement) =>
        ancestorsOf(el).flatMap((a) => {
          const classes = a.className.split(' ').filter(Boolean);
          const byRule = rules.filter((r) => (r.tag === null || r.tag === a.localName) && r.classes.every((c) => classes.includes(c)) && (r.classes.length > 0 || r.tag === a.localName));
          const inline = ['overflow', 'overflowX', 'overflowY', 'transform', 'filter'].filter((k) => a.style[k] && !(k.startsWith('overflow') && a.style[k] === 'clip'));
          return [...byRule.map((r) => `${a.localName}.${classes.join('.')} ← ${r.last}`), ...inline.map((k) => `${a.localName}.${classes.join('.')} style.${k}`)];
        });
      const bar = byClass(m.container, 'ch-mb-bar')[0];
      assert(bar && ancestorsOf(bar).some((a) => a.className.includes('ch-home')) && ancestorsOf(bar).some((a) => a.getAttribute('role') === 'tabpanel'), 'the bar sits in the tab panel, in the home');
      assert(offenders(bar).length === 0, `browse: ${show(offenders(bar))}`);
      await tap(m, dayButton(m, '2026-10-20'));
      const picked = byClass(m.container, 'ch-mp')[0];
      assert(picked && offenders(picked).length === 0, `picked: ${show(picked ? offenders(picked) : 'no picked')}`);
    } finally {
      m.unmount();
    }
  });

  await check('#55 a Google user\'s calendars that are gone (Ruling 4): "2 calendars aren\'t available · Choose again" once, above the Month, in browse and in picked; Choose again opens select-calendars; the Month asks Google for its windows', async () => {
    resetHome();
    fakeWindow.sessionStorage.setItem(homeTabKey(5550002), 'month');
    const calendars: CalendarDTO[] = [
      { id: G_FAMILY.id as string, source: 'google', name: 'Family', color: '#7986CB', mine: true },
      { id: 'gone-1@group.calendar.google.com', source: 'google', name: 'Old', color: null, mine: true, unavailable: true },
      { id: 'gone-2@group.calendar.google.com', source: 'google', name: 'Older', color: null, mine: true, unavailable: true },
    ];
    answerFetch = (c) => ok200(googleAnswer({ from: c.query.get('from') ?? TODAY, to: c.query.get('to') ?? day(7), items: { [day(0)]: [DINNER] }, calendars }));
    const m = await mountHome('en', GOOGLE_HOME, fakeClock('2026-10-15T07:00:00Z'));
    try {
      flushFrames();
      await settle();
      const once = (where: string) => {
        const html = m.html();
        assert((textOf(html).match(/2 calendars aren’t available Choose again/g) ?? []).length === 1, `${where}: the row once: ${textOf(html).slice(0, 300)}`);
        assert(html.indexOf('2 calendars aren’t available') < html.indexOf(where === 'browse' ? 'class="ch-mb"' : 'class="ch-mp"'), `${where}: above the Month`);
      };
      assert(browseShown(m), 'browse');
      once('browse');
      assert(show(ranges()) === show(['google default', 'google 2026-10-01→2026-11-01', 'google 2026-11-01→2026-12-01', 'google 2026-09-01→2026-10-01']), `Google's month windows: ${show(ranges())}`);
      await tap(m, dayButton(m, TODAY));
      assert(pickedShown(m), 'picked');
      once('picked');
      m.click(button(m.container, 'Choose again'));
      assert(show(pushes) === show(['/en/select-calendars?user_id=5550002']), `Choose again: ${show(pushes)}`);
    } finally {
      m.unmount();
    }
  });

  await check('#56 browse keeps the header and the tab bar on screen, as the approved MonthFlow does: they sit in .ch-home-top, which sticks under the safe areas in browse only, above the Month\'s bar and under the sheets, and whose height goes on .ch-home as --ch-top-h for the bar\'s top and the titles\' scroll-margin-top; 6,400 px down at today\'s month, ⋯ → Refresh is a tap away and asks the months near October; on the Agenda and in picked it scrolls with the page', async () => {
    resetHome();
    const topH = LAYOUT.topH;
    LAYOUT.topH = 126;
    const tg = fakeTelegramHome();
    fakeWindow.Telegram = { WebApp: tg.webApp };
    answerFetch = (c) => answerFor(c, { items: WEEK });
    const m = await mountHome('en', { trialDaysLeft: 5 }, fakeClock('2026-10-15T07:00:00Z'));
    const top = () => {
      const found = closestClass(byRole(m.container, 'tablist')[0] ?? null, 'ch-home-top');
      assert(found, 'the tab bar is not in .ch-home-top');
      return found;
    };
    const sticky = () => top().className.split(' ').includes('is-sticky');
    const rule = (css: string, selector: string) => {
      const found = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((r) => r[1].trim() === selector);
      assert(found.length === 1, `${found.length} ${selector} rules`);
      return found[0][2];
    };
    const decl = (body: string, prop: string) => new RegExp(`(?:^|[\\s;])${prop}\\s*:\\s*([^;]+);`).exec(body)?.[1].trim() ?? null;
    try {
      assert(byClass(top(), 'ch-head').length === 1 && byRole(top(), 'tablist').length === 1 && byClass(top(), 'ch-banners').length === 0, 'the header and the tab bar, not the banners');
      assert(!sticky(), 'on the Agenda it scrolls with the page');
      await openMonth(m);
      assert(sticky(), 'browse: it sticks');
      const home = byClass(m.container, 'ch-home')[0];
      assert(home.style['--ch-top-h'] === '126px', `--ch-top-h on .ch-home: ${home.style['--ch-top-h']}`);
      const stuck = rule(HOME_TOP_CSS, '.ch-home-top.is-sticky');
      assert(decl(stuck, 'position') === 'sticky' && decl(stuck, 'top') === 'calc(var(--tg-safe-area-inset-top, 0px) + var(--tg-content-safe-area-inset-top, 0px))' && decl(stuck, 'background') === 'var(--ch-bg)', `the sticky rule: ${stuck}`);
      const z = Number(decl(stuck, 'z-index'));
      assert(z > Number(decl(rule(MONTH_BROWSE_CSS, '.ch-mb-bar'), 'z-index')) && z < Number(decl(rule(HOME_THEME_CSS, '.ch-sheet-layer'), 'z-index')), `z-index ${z}: above the Month's bar, under the sheets`);
      assert((decl(rule(MONTH_BROWSE_CSS, '.ch-mb-bar'), 'top') ?? '').includes('var(--ch-top-h, 0px)') && (decl(rule(MONTH_BROWSE_CSS, '.ch-mb-title'), 'scroll-margin-top') ?? '').includes('var(--ch-top-h, 0px)'), 'the bar\'s top and the titles\' scroll margin add --ch-top-h');
      assert(elements(m.container).some((e) => e.localName === 'style' && e.textContent === HOME_TOP_CSS), 'its styles are rendered');
      scrollPageTo(inViewAt('2026-10'));
      await settle();
      assert(barMonth(m) === 'October 2026' && Number(fakeWindow.scrollY) > 6000, `October, ${fakeWindow.scrollY} px down`);
      fetchCalls.length = 0;
      m.click(byLabel(m.container, 'Menu'));
      m.click(byData(m.container, 'menu', 'refresh'));
      await settle();
      assert(show(ranges()) === show(['2026-10', '2026-11', '2026-09'].map((mo) => monthAsk(mo, { fresh: true }))), `Refresh at October: ${show(ranges())}`);
      await tap(m, dayButton(m, '2026-10-20'));
      assert(pickedShown(m) && !sticky(), 'picked: it scrolls with the page');
      React.act(() => tg.fire('backButtonClicked'));
      await settle();
      flushFrames();
      assert(browseShown(m) && sticky(), 'back in browse: it sticks again');
      m.click(tabButton(m, 'agenda'));
      await settle();
      assert(!sticky(), 'the Agenda: in the page again');
    } finally {
      m.unmount();
      LAYOUT.topH = topH;
      fakeWindow.Telegram = undefined;
    }
  });

  await check('#57 a tab switch from picked and back (spec §7.1, §7.6): the Agenda lets the BackButton go (offClick, hide) and leaves swipes on; back on the Month, picked on the same day, the button again (onClick, show), one scroll to the top and focus on the selected day; its BackButton still goes to browse', async () => {
    resetHome();
    const tg = fakeTelegramHome({ version: '7.7' });
    fakeWindow.Telegram = { WebApp: tg.webApp };
    answerFetch = (c) => answerFor(c, { items: WEEK });
    const m = await mountHome('en', {}, fakeClock('2026-10-15T07:00:00Z'));
    try {
      await openMonth(m);
      await tap(m, dayButton(m, '2026-10-20'));
      assert(pickedShown(m) && tg.backHandlers() === 1 && swipeCalls(tg.calls).at(-1) === 'enableVerticalSwipes()', `picked: ${show(backCalls(tg.calls))} ${show(swipeCalls(tg.calls))}`);
      tg.calls.length = 0;
      m.click(tabButton(m, 'agenda'));
      await settle();
      assert(show(backCalls(tg.calls)) === show(['BackButton.offClick', 'BackButton.hide()']) && tg.backHandlers() === 0, `the Agenda: ${show(backCalls(tg.calls))}`);
      assert(!swipeCalls(tg.calls).includes('disableVerticalSwipes()'), `swipes stay on: ${show(swipeCalls(tg.calls))}`);
      tg.calls.length = 0;
      scrollCalls.length = 0;
      await openMonth(m);
      assert(pickedShown(m) && dayButton(m, '2026-10-20').getAttribute('aria-pressed') === 'true', 'picked on the 20th again');
      assert(show(backCalls(tg.calls)) === show(['BackButton.onClick', 'BackButton.show()']) && tg.backHandlers() === 1, `back on the Month: ${show(backCalls(tg.calls))}`);
      assert(!swipeCalls(tg.calls).includes('disableVerticalSwipes()'), `swipes stay on in picked: ${show(swipeCalls(tg.calls))}`);
      assert(show(scrollCalls) === show([{ top: 0, behavior: 'plain' }]), `one scroll to the top: ${show(scrollCalls)}`);
      assert(fakeDocument.activeElement === dayButton(m, '2026-10-20'), 'focus on the selected day');
      React.act(() => tg.fire('backButtonClicked'));
      await settle();
      flushFrames();
      assert(browseShown(m) && barMonth(m) === 'October 2026', `the BackButton goes to browse: ${barMonth(m)}`);
    } finally {
      m.unmount();
      fakeWindow.Telegram = undefined;
    }
  });

  await check('#58 Telegram\'s activated on an 8.0 client, as visibilitychange in #49 (spec §5 lists both): on the Month a return asks its windows again, not the Agenda\'s week, two at a time, then the third; on the Agenda only its week', async () => {
    resetHome();
    fakeWindow.sessionStorage.setItem(homeTabKey(5550001), 'month');
    const tg = fakeTelegramHome({ version: '8.0' });
    fakeWindow.Telegram = { WebApp: tg.webApp };
    answerFetch = (c) => answerFor(c, { items: WEEK });
    const m = await mountHome('en', {}, fakeClock('2026-10-15T07:00:00Z'));
    try {
      flushFrames();
      await settle();
      assert(tg.calls.includes('onEvent(activated)'), `listening for activated: ${show(tg.calls.filter((c) => c.startsWith('onEvent')))}`);
      assert(show(ranges()) === show(['famcal default', monthAsk('2026-10'), monthAsk('2026-11'), monthAsk('2026-09')]), `the first asks: ${show(ranges())}`);
      const held: { call: FetchCall; resolve: (a: FetchAnswer) => void }[] = [];
      answerFetch = (c) => new Promise<FetchAnswer>((resolve) => held.push({ call: c, resolve }));
      fetchCalls.length = 0;
      React.act(() => tg.fire('activated'));
      await settle();
      assert(show(ranges()) === show([monthAsk('2026-10'), monthAsk('2026-11')]) && held.length === 2, `activated: the Month's windows, two in flight: ${show(ranges())}`);
      while (held.length > 0) {
        const h = held.shift() as (typeof held)[number];
        await React.act(async () => h.resolve(answerFor(h.call, { items: WEEK })));
        await settle();
      }
      assert(show(ranges()) === show([monthAsk('2026-10'), monthAsk('2026-11'), monthAsk('2026-09')]), `then the third: ${show(ranges())}`);
      answerFetch = (c) => answerFor(c, { items: WEEK });
      m.click(tabButton(m, 'agenda'));
      await settle();
      fetchCalls.length = 0;
      React.act(() => tg.fire('activated'));
      await settle();
      assert(show(ranges()) === show([`famcal ${day(0)}→${day(7)}`]), `on the Agenda, only its week: ${show(ranges())}`);
    } finally {
      m.unmount();
      fakeWindow.Telegram = undefined;
    }
  });

  await check('#59 the item sheet over picked keeps focus (aria-modal, spec §7.7): Tab from its last control (Close) goes to its first ("Open in Google Calendar"), Shift+Tab from its first (or the panel) to its last; focus that lands behind it, on a day of the month, comes back to the sheet and picks nothing; Escape closes it wherever focus is; then focus goes back to the row and the trap lets go', async () => {
    resetHome();
    const tg = fakeTelegramHome();
    fakeWindow.Telegram = { WebApp: tg.webApp };
    answerFetch = (c) => ok200(googleAnswer({ from: c.query.get('from') ?? TODAY, to: c.query.get('to') ?? day(7), items: { [day(0)]: [DINNER] } }));
    const m = await mountHome('en', GOOGLE_HOME, fakeClock('2026-10-15T07:00:00Z'));
    const trap = () => docListeners.filter((l) => l.type === 'focusin' || l.type === 'keydown');
    const focusIn = (target: FakeNode) => React.act(() => docListeners.filter((l) => l.type === 'focusin').forEach((l) => l.fn({ type: 'focusin', target })));
    const docKey = (key: string, target: FakeNode) => React.act(() => docListeners.filter((l) => l.type === 'keydown').forEach((l) => l.fn({ type: 'keydown', key, target, preventDefault: noop })));
    const name = (n: unknown) => (n instanceof FakeElement ? `${n.localName}.${n.className} ${n.textContent.slice(0, 40)}` : String(n));
    try {
      await openMonth(m);
      await tap(m, dayButton(m, TODAY));
      assert(trap().length === 0, `listeners before any sheet: ${trap().length}`);
      const row = button(m.container, 'Dinner with the Cohens');
      row.focus();
      m.click(row);
      const dialog = byRole(m.container, 'dialog')[0];
      assert(dialog && fakeDocument.activeElement === dialog, `the sheet has focus: ${name(fakeDocument.activeElement)}`);
      const controls = elements(dialog).filter((e) => (e.localName === 'button' && !e.hasAttribute('disabled')) || (e.localName === 'a' && e.hasAttribute('href')));
      assert(controls.length >= 2 && controls[0].textContent === 'Open in Google Calendar' && controls[controls.length - 1].textContent === 'Close', `the sheet's controls: ${show(controls.map((c) => c.textContent))}`);
      const first = controls[0];
      const last = controls[controls.length - 1];
      last.focus();
      m.key(last, 'Tab');
      assert(fakeDocument.activeElement === first, `Tab from the last control: ${name(fakeDocument.activeElement)}`);
      m.key(first, 'Tab', { shiftKey: true });
      assert(fakeDocument.activeElement === last, `Shift+Tab from the first control: ${name(fakeDocument.activeElement)}`);
      dialog.focus();
      m.key(dialog, 'Tab', { shiftKey: true });
      assert(fakeDocument.activeElement === last, `Shift+Tab from the panel: ${name(fakeDocument.activeElement)}`);
      const behind = dayButton(m, '2026-10-20');
      behind.focus();
      focusIn(behind);
      assert(fakeDocument.activeElement === dialog, `focus behind the sheet: ${name(fakeDocument.activeElement)}`);
      assert(byRole(m.container, 'dialog').length === 1 && dayButton(m, TODAY).getAttribute('aria-pressed') === 'true', 'the sheet and the picked day stay');
      docKey('Escape', fakeDocument.body);
      await settle();
      assert(byRole(m.container, 'dialog').length === 0 && pickedShown(m), 'Escape from outside closed only the sheet');
      assert(fakeDocument.activeElement === row, `focus back on the row: ${name(fakeDocument.activeElement)}`);
      assert(trap().length === 0, `the trap's listeners left: ${trap().length}`);
    } finally {
      m.unmount();
      fakeWindow.Telegram = undefined;
    }
  });

  await check('#60 React logged no warning in #43-#59 (keys, nesting, attributes, act)', () => {
    assert(reactWarnings.length === warnedBeforeMonth, `warnings: ${show(reactWarnings.slice(warnedBeforeMonth, warnedBeforeMonth + 5))}`);
  });

  let failed = 0;
  for (const r of results) {
    process.stdout.write(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}\n`);
```

- [ ] **Step 2: Run it and see it fail; record the regression smokes' baseline**

```bash
cd /Users/razielgershoni/development/famcalbot
E="DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake"
for tz in UTC Asia/Jerusalem; do
  eval "env TZ=$tz $E npx tsx scripts/smoke-calendar-home-render.ts" > /tmp/e8-render-before.log 2>&1; echo "TZ=$tz exit $?"
  grep -oE '^FAIL  #[0-9]+' /tmp/e8-render-before.log | tr '\n' ' '; echo; grep passed /tmp/e8-render-before.log
done
npx tsc --noEmit -p . ; echo "tsc exit $?"
for f in smoke-miniapp-gate smoke-page-auth smoke-initdata-header smoke-auth-leftovers smoke-auth-identity smoke-calendar-home-tabs smoke-calendar-month-browse smoke-calendar-month-picked smoke-calendar-month smoke-calendar-loader smoke-calendar-home-copy smoke-telegram-ui check-i18n-parity; do
  for tz in UTC Asia/Jerusalem; do
    eval "env TZ=$tz $E npx tsx scripts/$f.ts" > /tmp/e8-$f.log 2>&1; echo "$f TZ=$tz exit $?"
    grep -E '^(OK|FAIL)|passed|parity' /tmp/e8-$f.log > /tmp/e8-$f-${tz//\//_}.before; tail -1 /tmp/e8-$f-${tz//\//_}.before
  done
done
```

Expected for the render smoke, under each clock (tsx may also print `DEP0205` deprecation warnings on stderr; ignore them):
```
TZ=UTC exit 1
FAIL  #22 FAIL  #43 FAIL  #44 FAIL  #45 FAIL  #46 FAIL  #47 FAIL  #48 FAIL  #49 FAIL  #50 FAIL  #51 FAIL  #52 FAIL  #53 FAIL  #54 FAIL  #55 FAIL  #56 FAIL  #57 FAIL  #58 FAIL  #59
42/60 passed (process TZ=UTC)
TZ=Asia/Jerusalem exit 1
FAIL  #22 FAIL  #43 FAIL  #44 FAIL  #45 FAIL  #46 FAIL  #47 FAIL  #48 FAIL  #49 FAIL  #50 FAIL  #51 FAIL  #52 FAIL  #53 FAIL  #54 FAIL  #55 FAIL  #56 FAIL  #57 FAIL  #58 FAIL  #59
42/60 passed (process TZ=Asia/Jerusalem)
```
The reasons, after the dash on each `FAIL` line:
- #22 `the tablist, named`;
- #43 `app/[locale]/dashboard/HomeTabs.tsx not among CalendarHome's modules`;
- #44 `the header, the tab bar, the banners, then the panel: [14009,-1,15001,-1]`;
- #45 `no month panel`;
- #46 and #47 `no month tab`;
- #48 `picked`;
- #49 `the first asks: ["famcal default"]`;
- #50 `no data-month="2026-10"`;
- #51 `browse, opened once: []`;
- #52 `swipes on: []`;
- #53 `browse locked the swipes: []`;
- #54 `the bar sits in the tab panel, in the home`;
- #55 `browse`;
- #56 `the tab bar is not in .ch-home-top`;
- #57 and #59 `no month tab`;
- #58 `the first asks: ["famcal default"]`.

#1-#21, #23-#42 and #60 pass. `tsc` exits 2 with one error, `scripts/smoke-calendar-home-render.ts(77,47): error TS2614: Module '"../app/[locale]/dashboard/CalendarHome"' has no exported member 'HOME_TOP_CSS'. …`; every other module the smoke imports exists already (E2's `grid.ts`, E4's `HomeTabs.tsx` and `home-storage.ts`, E5's `month.ts`, E6's `MonthBrowse.tsx`). Expected for the regression smokes: every run prints `exit 0`, and its last line is, in order (the `(process TZ=…)` suffix names the run's clock):
```
20/20 passed
14/14 passed
9/9 passed
9/9 passed
26/26 passed
11/11 passed (process TZ=UTC)
26/26 passed (process TZ=UTC)
14/14 passed (process TZ=UTC)
26/26 passed (process TZ=UTC)
12/12 passed (process TZ=UTC)
18/18 passed
19/19 passed (process TZ=UTC)
i18n parity OK (1013 keys)
```

- [ ] **Step 3: Create `app/[locale]/dashboard/MonthView.tsx`**

The Month tab: MonthBrowse or MonthPicked by `ui.layout`, the unavailable-calendars row once above them, and D's ItemSheet over picked. Create `app/[locale]/dashboard/MonthView.tsx` with exactly this content:
```tsx
'use client';

// The Month tab (spec §7.4, §7.5, §7.6; Rulings R11 and R12; Plan E Rulings 4 and 6):
// the browse layout (E6's MonthBrowse) or the picked one (E7's MonthPicked), as the
// container's MonthUi says. Presentational: CalendarHome owns the store, the fetches, the
// layout and its memory, and Telegram's BackButton and swipes. This file only turns the
// views' taps into the next MonthUi (month.ts's helpers) and hands it to onUi.
//
// - "N calendars aren't available · Choose again" shows once, above either layout
//   (Ruling 4), as the Agenda's state row does. In browse its styles come with it; in
//   picked MonthPicked already renders D's AGENDA_CSS.
// - Browse is mounted only while it shows, and again each time it comes back (back from
//   picked, a tab switch): MonthBrowse reads `start` and measures the page on mount.
// - Picked is one MonthPicked for as long as picked shows, never keyed by month or day:
//   a chevron must not scroll the page to the top again.
// - A row tapped under the picked day opens D's ItemSheet, as in AgendaView: the
//   container holds the selection (its BackButton closes the sheet), and the sheet shows
//   the row as the latest answer has it, else as it was tapped.
// - Until a month has a model (a store drop at midnight, or a model drawn under another
//   week start), picked draws it as loading, so a day never looks free before it is
//   answered (§5); browse does the same for each of its months.

import { useTranslations } from 'next-intl';
import type { AgendaRow } from '@/src/lib/calendar-view/agenda';
import { monthFirstDay, monthGrid, monthOf, type MonthKey } from '@/src/lib/calendar-view/grid';
import { isHebrewMonthStart } from '@/src/lib/calendar-view/hebrew-date';
import { backToBrowse, canStep, pickDay, pickToday, stepMonth, type MonthCell, type MonthModel, type MonthUi } from '@/src/lib/calendar-view/month';
import type { DayStatus } from '@/src/lib/calendar-view/store';
import type { DayKey, SourceName, WeekStart } from '@/src/lib/calendar-view/types';
import { AGENDA_CSS } from './AgendaView';
import { ItemSheet } from './ItemSheet';
import { MonthBrowse } from './MonthBrowse';
import { MonthPicked } from './MonthPicked';

export interface MonthViewProps {
  /** The facts the Month draws with: the pinned ones, or the last ones through a store drop. */
  today: DayKey;
  tz: string;
  weekStart: WeekStart;
  hebrewDates: boolean;
  /** The window, oldest first: monthSpan(today), memoized. */
  months: readonly MonthKey[];
  /** monthModels(store): a month's model, or null (it then draws as loading). */
  getMonth: (month: MonthKey) => MonthModel | null;
  /** Where the Month is: the layout, its month and, in picked, the selected day. */
  ui: MonthUi;
  /** Where browse opens when it mounts (MonthBrowse reads it then only). */
  start: { month: MonthKey; peek: boolean };
  /** The picked day's list: dayRows(store, day) and dayStatus(store, day). null in browse. */
  dayRows: { rows: AgendaRow[]; status: DayStatus } | null;
  /** homeNotices(store).unavailableCalendars: chosen Google calendars that are gone. */
  unavailableCalendars: number;
  /** The row whose item sheet is open (picked only), or null. The container holds it. */
  selected: AgendaRow | null;
  /** A tap on a row: open its sheet (the row), or close it (null). */
  onSelect: (row: AgendaRow | null) => void;
  /** The next MonthUi: a day picked, a chevron, Today, "All months". */
  onUi: (ui: MonthUi) => void;
  /** MonthBrowse's near months and month in view, for the container's wantedMonths. */
  onNearMonths: (months: MonthKey[]) => void;
  onMonthInView: (month: MonthKey) => void;
  /** Retry on a month's notice: the container asks that month's window again. */
  onRetryMonth: (month: MonthKey, source: SourceName) => void;
  /** "Choose again": the existing select-calendars page. */
  onChooseCalendars: () => void;
}

/** A month with no model yet: its own days loading, the rest blank (R12). */
function loadingModel(month: MonthKey, weekStart: WeekStart, today: DayKey): MonthModel {
  const first = monthFirstDay(month);
  const weeks = monthGrid(month, weekStart).map((row) =>
    row.map((day): MonthCell => {
      const inMonth = monthOf(day) === month;
      return {
        day,
        inMonth,
        today: inMonth && day === today,
        status: inMonth ? 'loading' : 'answered',
        slots: [],
        dots: [],
        count: 0,
        fromPartner: 0,
        hebrewMonthStart: inMonth && (day === first || isHebrewMonthStart(day)),
      };
    }),
  );
  return { month, weeks, status: 'loading', notices: [], partner: null };
}

/** The month's model when it fits this week start, else the loading one. */
function modelFor(getMonth: MonthViewProps['getMonth'], month: MonthKey, weekStart: WeekStart, today: DayKey): MonthModel {
  const model = getMonth(month);
  const first = monthGrid(month, weekStart)[0]?.[0];
  return model && first !== undefined && model.weeks[0]?.[0]?.day === first ? model : loadingModel(month, weekStart, today);
}

/** The open sheet's item as the picked day's latest rows have it (a refetch may have changed it), else as it was tapped. */
function latestRow(rows: readonly AgendaRow[], selected: AgendaRow): AgendaRow {
  return rows.find((row) => row.item.key === selected.item.key) ?? selected;
}

function StateIcon() {
  return (
    <svg className="ch-icon ch-state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5.5M12 16.5v.01" />
    </svg>
  );
}

/** "N calendars aren't available · Choose again", once above the Month (Ruling 4). */
function UnavailableRow({ count, withStyles, onChooseCalendars }: { count: number; withStyles: boolean; onChooseCalendars: () => void }) {
  const t = useTranslations('calendarHome');
  return (
    <>
      {withStyles ? <style>{AGENDA_CSS}</style> : null}
      <div className="ch-states">
        <div className="ch-state" role="status">
          <StateIcon />
          <span className="ch-state-text">{t('state.unavailable', { count })}</span>
          <button type="button" className="ch-btn ch-state-action" onClick={onChooseCalendars}>
            {t('actions.chooseAgain')}
          </button>
        </div>
      </div>
    </>
  );
}

export function MonthView({
  today,
  tz,
  weekStart,
  hebrewDates,
  months,
  getMonth,
  ui,
  start,
  dayRows,
  unavailableCalendars,
  selected,
  onSelect,
  onUi,
  onNearMonths,
  onMonthInView,
  onRetryMonth,
  onChooseCalendars,
}: MonthViewProps) {
  const picked = ui.layout === 'picked' && ui.selected !== null ? ui.selected : null;
  const unavailable =
    unavailableCalendars > 0 ? <UnavailableRow count={unavailableCalendars} withStyles={picked === null} onChooseCalendars={onChooseCalendars} /> : null;

  if (picked === null) {
    return (
      <>
        {unavailable}
        <MonthBrowse
          months={months}
          today={today}
          weekStart={weekStart}
          hebrewDates={hebrewDates}
          getMonth={getMonth}
          start={start}
          onNearMonths={onNearMonths}
          onMonthInView={onMonthInView}
          onPickDay={(day) => onUi(pickDay(ui, day))}
          onRetryMonth={onRetryMonth}
          onChooseCalendars={onChooseCalendars}
        />
      </>
    );
  }

  const list = dayRows ?? { rows: [], status: 'loading' as const };
  const sheetRow = selected ? latestRow(list.rows, selected) : null;
  return (
    <>
      {unavailable}
      <MonthPicked
        model={modelFor(getMonth, ui.month, weekStart, today)}
        selected={picked}
        today={today}
        tz={tz}
        weekStart={weekStart}
        hebrewDates={hebrewDates}
        canPrev={canStep(ui, -1, today)}
        canNext={canStep(ui, 1, today)}
        rows={list.rows}
        dayStatus={list.status}
        onSelectDay={(day) => onUi(pickDay(ui, day))}
        onPrev={() => onUi(stepMonth(ui, -1, today))}
        onNext={() => onUi(stepMonth(ui, 1, today))}
        onToday={() => onUi(pickToday(ui, today))}
        onAllMonths={() => onUi(backToBrowse(ui))}
        onOpenItem={onSelect}
        onRetryMonth={onRetryMonth}
        onChooseCalendars={onChooseCalendars}
      />
      {sheetRow ? <ItemSheet row={sheetRow} today={today} tz={tz} onClose={() => onSelect(null)} /> : null}
    </>
  );
}
```

- [ ] **Step 4: The tabs, the Month and Telegram in `app/[locale]/dashboard/CalendarHome.tsx`**

Eight edits, in file order. Each Before block occurs exactly once in the file as it stands after E7 (D's file at 0064e8f; E1-E7 don't touch it).

**4a. The header comment and the imports.** The comment gains the tabs, the Month, the swipes, the storage keys, the sticky header and the Month's chunk. The imports add `Suspense`, `lazy`, `useLayoutEffect` and `ReactNode`, grid, home-storage, month.ts, `dayStatus` and `StoreFacts`, `releaseTelegramControls` (in place of `releaseTelegramBackButton`) and `useTelegramVerticalSwipes`, `AGENDA_CSS` and `PlaceholderRows` (the Month's loading state), and HomeTabs. MonthView is not imported: after the imports, `loadMonthView` and a `lazy` MonthView make the Month's three views a chunk of their own. In `app/[locale]/dashboard/CalendarHome.tsx`, Before (lines 1-61):
```tsx
'use client';

// The calendar home (spec §5, §7.1, §7.2; Rulings R5, R6, R8, R19): what /dashboard shows
// the users the rollout switch covers. PageGate renders it with CalendarHomeProps once
// page-data says calendarHome; everyone else keeps today's DashboardClient. Plan D has
// the Agenda only, with no tab bar.
//
// The container owns the data and the Telegram calls; the parts are presentational:
// - the store (D3's reducer) and the loader (./home-loader): one range request per
//   applicable source on mount, no dates; "Show next week" adds a week; a store drop
//   (midnight in tz, other facts) refetches the visible weeks; a return to the
//   foreground (visibilitychange, Telegram's activated) refetches them; ⋯ → Refresh
//   sends fresh=1; a stale Google answer asks once more after about 3 s; a Google error
//   retries once after about 5 s;
// - the answers: 404 not_enabled reloads once (PageGate then shows today's dashboard);
//   401, 403 and any other 404 show PageGate's NoCredentialCard; 429 is busy and a 500
//   is a retry, as a state row once the facts are pinned, else as a card;
// - the shell: the theme (D4's useTelegramTheme: Telegram's bg_color for the header and
//   background, data-theme for the tokens), the direction, document-level scroll and
//   the safe areas (./home-shell), the header, the banners, AgendaView (D5), and the
//   send and menu sheets;
// - Telegram's one BackButton (spec §7.6): shown while the item sheet, the Send sheet or
//   the ⋯ menu is open, and a tap closes that sheet (Android's back gesture too), so the
//   item sheet's selection lives here; before a reload (not_enabled, a chunk-load error)
//   the button is let go, since a reload runs no cleanup and the client keeps it;
// - a return to the foreground after the day has ended in tz (iOS suspends the midnight
//   timer with the app) drops the store at once, rather than asking for yesterday's
//   windows and labelling yesterday "Today" until they answer;
// - a Google user still setting up (needsOAuth, needsCalendars) gets the setup banner and
//   no Agenda under it (an Agenda with nothing chosen would only say "Nothing planned");
// - an error boundary around all of it; a chunk-load error reloads once.
//
// user.id is the page's own user_id (a Telegram id or a DB id), sent as it is to the
// range route and execute-command, which resolve it with verifyUserAuth. It is never
// swapped for another id.

import { useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { buildAgenda, type AgendaRow } from '@/src/lib/calendar-view/agenda';
import { deviceTimeZone, homeSources, isPastDay, msUntilAheadCheck, msUntilDayCheck, reloadOnce, zoneDiffers } from '@/src/lib/calendar-view/home-client';
import { createHomeLoader, type HomeLoader } from '@/src/lib/calendar-view/home-loader';
import type { CalendarHomeProps } from '@/src/lib/calendar-view/home-props';
import { emptyStore, homeNotices, reduceStore } from '@/src/lib/calendar-view/store';
import type { SourceName } from '@/src/lib/calendar-view/types';
import { DEFAULT_BOT_USERNAME, DEFAULT_WA_NUMBER, type GateLinks } from '@/src/lib/gate-links';
import { isInTelegram, onTelegramEvent, releaseTelegramBackButton, useTelegramBackButton, useTelegramTheme } from '@/src/lib/telegram-ui';
import { NoCredentialCard } from '../PageGate';
import { AgendaView } from './AgendaView';
import { HomeBanners } from './HomeBanners';
import { HomeErrorBoundary } from './HomeErrorBoundary';
import { HomeHeader } from './HomeHeader';
import { HOME_SHELL_CSS } from './home-shell';
import { HOME_THEME_CSS } from './home-theme';
import { MenuSheet } from './MenuSheet';
import { SendSheet } from './SendSheet';

/** The reload-once guard for 404 not_enabled (the switch was turned back). */
export const NOT_ENABLED_RELOAD_KEY = 'famcal:calendarHome:notEnabledReload:v1';

/**
```
After:
```tsx
'use client';

// The calendar home (spec §5, §7.1, §7.2, §7.4, §7.6; Rulings R5, R6, R8, R19; Plan E
// Rulings 1, 2, 6, 7 and 9): what /dashboard shows the users the rollout switch covers.
// PageGate renders it with CalendarHomeProps once page-data says calendarHome; everyone
// else keeps today's DashboardClient. Plan E adds the tab bar and the Month.
//
// The container owns the data and the Telegram calls; the parts are presentational:
// - the store (D3's reducer) and the loader (./home-loader): one range request per
//   applicable source on mount, no dates; "Show next week" adds a week; a store drop
//   (midnight in tz, other facts) refetches the visible weeks; a return to the
//   foreground (visibilitychange, Telegram's activated) refetches them; ⋯ → Refresh
//   sends fresh=1; a stale Google answer asks once more after about 3 s; a Google error
//   retries once after about 5 s;
// - the answers: 404 not_enabled reloads once (PageGate then shows today's dashboard);
//   401, 403 and any other 404 show PageGate's NoCredentialCard; 429 is busy and a 500
//   is a retry, as a state row once the facts are pinned, else as a card;
// - the shell: the theme (D4's useTelegramTheme: Telegram's bg_color for the header and
//   background, data-theme for the tokens), the direction, document-level scroll and
//   the safe areas (./home-shell), the header, the tab bar, the banners, the tab on
//   screen (AgendaView, or the Month's MonthView), and the send and menu sheets;
// - the tabs (Ruling 1): the bar sits under the header and above the banners, and shows
//   only while a panel can show (no card, no block, not setupNeeded). The tab on screen
//   is kept in sessionStorage for the session (Ruling 2). A switch closes any sheet and
//   the item sheet, and the Agenda opens at the top. Only the tab on screen is mounted;
//   the other one's tabpanel is there, empty and hidden, for the tab's aria-controls.
//   While the Month shows browse, the header and the tab bar stick under the safe areas,
//   as in the approved MonthFlow (whose inner scroller the spec's document scroll
//   replaces): 6,400 px down at today's month, Send, ⋯ and the Agenda tab are still a tap
//   away. Their height goes on .ch-home as --ch-top-h, where browse's own bar sticks
//   under them. On the Agenda and in picked they scroll with the page;
// - the Month (spec §7.4): its MonthUi (month.ts) once the facts are pinned, from the
//   layout this device remembers (localStorage), kept inside the window when today
//   moves; browse opens on today's month with a peek the first time, on the picked
//   month after "All months", and on the month that was in view after a tab switch.
//   While the Month shows, the loader asks its windows (wantedMonths: the months near
//   the screen, or picked's month and its neighbours), at most 2 at a time; a return to
//   the foreground and Refresh ask the Month's windows, not the Agenda's weeks; Retry
//   asks one month again. Through a store drop the Month keeps the last facts, so it
//   stays where it is with its cells loading until the new answer;
// - Telegram's one BackButton (spec §7.6): shown while the item sheet, the Send sheet or
//   the ⋯ menu is open, or while the Month is in picked. A tap closes the sheet on top,
//   else the item sheet, else goes back to browse (Android's back gesture too). Vertical
//   swipes are off while the Month shows browse, its loading included (Ruling 9), and on
//   everywhere else. Before a reload (not_enabled, a chunk-load error) both are let go,
//   since a reload runs no cleanup and the client keeps them;
// - a return to the foreground after the day has ended in tz (iOS suspends the midnight
//   timer with the app) drops the store at once, rather than asking for yesterday's
//   windows and labelling yesterday "Today" until they answer;
// - a Google user still setting up (needsOAuth, needsCalendars) gets the setup banner, no
//   tab bar and no Agenda under it (an Agenda with nothing chosen would only say
//   "Nothing planned"); a remembered Month tab is left as it is;
// - the Month's views (MonthView, MonthBrowse, MonthPicked) are a chunk of their own
//   (import()): PageGate preloads this file's chunk on every /dashboard open, for the
//   users the switch doesn't cover too. The chunk is fetched once the first answer is in,
//   and the Month shows its placeholders until it is there;
// - an error boundary around all of it; a chunk-load error reloads once.
//
// user.id is the page's own user_id (a Telegram id or a DB id), sent as it is to the
// range route and execute-command, which resolve it with verifyUserAuth, and used as it
// is in the storage keys. It is never swapped for another id.

import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { buildAgenda, type AgendaRow } from '@/src/lib/calendar-view/agenda';
import { monthSpan, monthWindow, type MonthKey } from '@/src/lib/calendar-view/grid';
import { deviceTimeZone, homeSources, isPastDay, msUntilAheadCheck, msUntilDayCheck, reloadOnce, zoneDiffers } from '@/src/lib/calendar-view/home-client';
import { createHomeLoader, type HomeLoader } from '@/src/lib/calendar-view/home-loader';
import type { CalendarHomeProps } from '@/src/lib/calendar-view/home-props';
import { readHomeTab, readMonthLayout, writeHomeTab, writeMonthLayout, type HomeTab } from '@/src/lib/calendar-view/home-storage';
import { backToBrowse, clampMonthUi, dayRows, initialMonthUi, monthModels, wantedMonths, type MonthUi } from '@/src/lib/calendar-view/month';
import { dayStatus, emptyStore, homeNotices, reduceStore, type StoreFacts } from '@/src/lib/calendar-view/store';
import type { SourceName } from '@/src/lib/calendar-view/types';
import { DEFAULT_BOT_USERNAME, DEFAULT_WA_NUMBER, type GateLinks } from '@/src/lib/gate-links';
import { isInTelegram, onTelegramEvent, releaseTelegramControls, useTelegramBackButton, useTelegramTheme, useTelegramVerticalSwipes } from '@/src/lib/telegram-ui';
import { NoCredentialCard } from '../PageGate';
import { AGENDA_CSS, AgendaView } from './AgendaView';
import { PlaceholderRows } from './DayList';
import { HomeBanners } from './HomeBanners';
import { HomeErrorBoundary } from './HomeErrorBoundary';
import { HomeHeader } from './HomeHeader';
import { HomeTabs, PANEL_IDS, TAB_IDS } from './HomeTabs';
import { HOME_SHELL_CSS } from './home-shell';
import { HOME_THEME_CSS } from './home-theme';
import { MenuSheet } from './MenuSheet';
import { SendSheet } from './SendSheet';

/**
 * The Month's views, in a chunk of their own: PageGate preloads this file's chunk on
 * every /dashboard open (the users the switch doesn't cover included), so the Month's
 * three views come only when the home asks for them. A chunk that fails to load reloads
 * the page once (HomeErrorBoundary).
 */
const loadMonthView = () => import('./MonthView');
const MonthView = lazy(() => loadMonthView().then((m) => ({ default: m.MonthView })));

/** The reload-once guard for 404 not_enabled (the switch was turned back). */
export const NOT_ENABLED_RELOAD_KEY = 'famcal:calendarHome:notEnabledReload:v1';

/**
```

**4b. Two types, the sticky header and a helper** after `type Card`: the held facts, what the loader reads about the Month, `HOME_TOP_CSS` with `publishTopHeight` and `HomeTop` (the header and the tab bar's wrapper), and the scroll to the top. In `app/[locale]/dashboard/CalendarHome.tsx`, Before (lines 89-100):
```tsx
const assumeTelegram = () => true;
const noZone = () => null;

/** What stands in for the Agenda: busy or a retry before any answer, or the switch-off card. */
type Card = 'busy' | 'error' | 'disabled';

function HomeCard({ kind, onRetry }: { kind: Card; onRetry: () => void }) {
  const t = useTranslations('calendarHome');
  return (
    <div className="ch-home-card" role="status">
      {kind === 'busy' ? (
        <p className="ch-home-card-title">{t('state.busy')}</p>
```
After:
```tsx
const assumeTelegram = () => true;
const noZone = () => null;

/** What stands in for the Agenda: busy or a retry before any answer, or the switch-off card. */
type Card = 'busy' | 'error' | 'disabled';

/** The facts the Month last drew with, and the unavailable calendars then: kept through a store drop. */
type HeldFacts = { facts: StoreFacts; unavailable: number };

/** What the loader reads about the Month: the tab on screen and where the Month is. */
type MonthWants = { tab: HomeTab; ui: MonthUi | null; near: readonly MonthKey[]; inView: MonthKey | null };

/**
 * The header and the tab bar's wrapper. While the Month shows browse it sticks under the
 * safe areas, above browse's own bar (z-index 4 over 3) and under the sheets (50), on the
 * page's background, as the approved MonthFlow keeps them on screen.
 */
export const HOME_TOP_CSS = `
.ch-home-top.is-sticky {
  position: sticky;
  top: calc(var(--tg-safe-area-inset-top, 0px) + var(--tg-content-safe-area-inset-top, 0px));
  z-index: 4;
  background: var(--ch-bg);
}
`;

/** Puts the wrapper's height on .ch-home as --ch-top-h: browse's bar sticks under it, and its titles stop under both. */
function publishTopHeight(top: HTMLElement | null) {
  try {
    const home = top?.parentElement;
    if (!top || !home || typeof top.getBoundingClientRect !== 'function') return;
    const height = `${Math.round(top.getBoundingClientRect().height)}px`;
    if (home.style.getPropertyValue?.('--ch-top-h') !== height) home.style.setProperty('--ch-top-h', height);
  } catch {
    // Without it the bar sticks at the safe areas, as it would with nothing above it.
  }
}

/**
 * The header and the tab bar, sticky while `sticky` (browse). Its height is published on
 * every commit, in a layout effect: as an earlier sibling's, it runs before the Month's
 * own layout effects in the same commit (browse's opening scroll reads it), and a
 * ResizeObserver catches what changes it outside a render (fonts, a rotation).
 */
function HomeTop({ sticky, children }: { sticky: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => publishTopHeight(ref.current));
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof window.ResizeObserver !== 'function') return;
    let observer: ResizeObserver;
    try {
      observer = new window.ResizeObserver(() => publishTopHeight(el));
      observer.observe(el);
    } catch {
      return;
    }
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={ref} className={sticky ? 'ch-home-top is-sticky' : 'ch-home-top'}>
      {children}
    </div>
  );
}

/** The page to the top: the Agenda opens there after a tab switch. */
function scrollToTop() {
  try {
    window.scrollTo(0, 0);
  } catch {
    // The page stays where it is.
  }
}

function HomeCard({ kind, onRetry }: { kind: Card; onRetry: () => void }) {
  const t = useTranslations('calendarHome');
  return (
    <div className="ch-home-card" role="status">
      {kind === 'busy' ? (
        <p className="ch-home-card-title">{t('state.busy')}</p>
```

**4c. The Month's loading state, the new state, and the derived values moved up.** `MonthLoading` follows `HomeCard`. In the container, the tab (from `readHomeTab`), the remembered layout (read once), `monthUi`, `monthFresh`, the near months, the month in view and the held facts follow D's state. `facts`, `notices`, `card` and `setupNeeded` move up from below (4e, 4f), so Ruling 1's `tabsShown` and `activeTab` exist before the effects that read them. The render-time block then holds new facts and starts or clamps `monthUi`, and the loader's refs gain `monthRef`. In `app/[locale]/dashboard/CalendarHome.tsx`, Before (lines 108-150):
```tsx
        {t('actions.retry')}
      </button>
    </div>
  );
}

export type CalendarHomeContainerProps = CalendarHomeProps & { deps?: Partial<HomeDeps> };

/** The home without its error boundary; `deps` lets a smoke drive the clock and the timers. */
export function CalendarHomeContainer({ deps: depsIn, ...props }: CalendarHomeContainerProps) {
  const { user, locale, calendarSource, needsOAuth, needsCalendars, hints, trialDaysLeft, hasLocation } = props;
  const userId = user.id;
  const router = useRouter();
  const scheme = useTelegramTheme();
  const [deps] = useState<HomeDeps>(() => ({ ...REAL_DEPS, ...depsIn }));
  const [store, dispatch] = useReducer(reduceStore, undefined, () => emptyStore());
  const [weeks, setWeeks] = useState(1);
  const [sheet, setSheet] = useState<'send' | 'menu' | null>(null);
  /** The row whose item sheet is open (AgendaView renders it; the BackButton here closes it). */
  const [selected, setSelected] = useState<AgendaRow | null>(null);
  const [firstLoad, setFirstLoad] = useState<'busy' | 'error' | null>(null);
  const [blocked, setBlocked] = useState<'noCredential' | 'disabled' | null>(null);
  const inTelegram = useSyncExternalStore(subscribeNothing, isInTelegram, assumeTelegram);
  const deviceZone = useSyncExternalStore(subscribeNothing, deps.deviceTimeZone, noZone);

  // The loader reads the latest state through these; they are synced before it runs.
  const storeRef = useRef(store);
  const weeksRef = useRef(weeks);
  const blockedRef = useRef(blocked);
  const firstLoadRef = useRef(firstLoad);
  const loaderRef = useRef<HomeLoader | null>(null);
  const resetFor = useRef<string | null>(null);
  useEffect(() => {
    storeRef.current = store;
    weeksRef.current = weeks;
    blockedRef.current = blocked;
    firstLoadRef.current = firstLoad;
  });

  useEffect(() => {
    const loader = createHomeLoader({
      userId,
      sources: homeSources(calendarSource),
```
After:
```tsx
        {t('actions.retry')}
      </button>
    </div>
  );
}

/** The Month before the first answer (a reload on the Month tab): placeholders, never free days. */
function MonthLoading() {
  const t = useTranslations('calendarHome');
  return (
    <div className="ch-loading" role="status">
      <style>{AGENDA_CSS}</style>
      <span className="ch-visually-hidden">{t('shell.loading')}</span>
      <div className="ch-ghost-head" aria-hidden="true" />
      <PlaceholderRows count={3} />
    </div>
  );
}

export type CalendarHomeContainerProps = CalendarHomeProps & { deps?: Partial<HomeDeps> };

/** The home without its error boundary; `deps` lets a smoke drive the clock and the timers. */
export function CalendarHomeContainer({ deps: depsIn, ...props }: CalendarHomeContainerProps) {
  const { user, locale, calendarSource, needsOAuth, needsCalendars, hints, trialDaysLeft, hasLocation } = props;
  const userId = user.id;
  const router = useRouter();
  const scheme = useTelegramTheme();
  const [deps] = useState<HomeDeps>(() => ({ ...REAL_DEPS, ...depsIn }));
  const [store, dispatch] = useReducer(reduceStore, undefined, () => emptyStore());
  const [weeks, setWeeks] = useState(1);
  const [sheet, setSheet] = useState<'send' | 'menu' | null>(null);
  /** The row whose item sheet is open (AgendaView or the Month's picked renders it; the BackButton here closes it). */
  const [selected, setSelected] = useState<AgendaRow | null>(null);
  const [firstLoad, setFirstLoad] = useState<'busy' | 'error' | null>(null);
  const [blocked, setBlocked] = useState<'noCredential' | 'disabled' | null>(null);
  const inTelegram = useSyncExternalStore(subscribeNothing, isInTelegram, assumeTelegram);
  const deviceZone = useSyncExternalStore(subscribeNothing, deps.deviceTimeZone, noZone);
  /** The tab this session last showed (sessionStorage; Ruling 2). */
  const [tab, setTab] = useState<HomeTab>(() => readHomeTab(userId));
  /** The Month's layout as this device remembers it (localStorage), read once. */
  const [savedLayout] = useState(() => readMonthLayout(userId));
  /** Where the Month is (month.ts); null until the first answer pins the facts. In browse, its month is where browse opens next. */
  const [monthUi, setMonthUi] = useState<MonthUi | null>(null);
  /** True until the Month is first left or changed: browse's first opening peeks at the month before (spec §7.4). */
  const [monthFresh, setMonthFresh] = useState(true);
  /** MonthBrowse's reports: the months near the screen, and the month under its bar. */
  const [near, setNear] = useState<readonly MonthKey[]>([]);
  const [inView, setInView] = useState<MonthKey | null>(null);
  const [held, setHeld] = useState<HeldFacts | null>(null);

  const facts = store.facts;
  const notices = homeNotices(store);
  const card: Card | null = blocked === 'disabled' ? 'disabled' : !facts && firstLoad ? firstLoad : null;
  const setupNeeded = calendarSource === 'GOOGLE' && (needsOAuth || needsCalendars);
  // Ruling 1: the tab bar shows only while a panel can show. Otherwise the home is D's:
  // the Agenda (or the card), with no tab bar; the remembered tab is left as it is.
  const tabsShown = card === null && blocked === null && !setupNeeded;
  const activeTab: HomeTab = tabsShown ? tab : 'agenda';

  // New facts (the first answer, a hebrewDates change, the next answer after a drop):
  // the Month holds them. When today moved (or on the first answer), the Month's UI
  // starts from the remembered layout while the Month hasn't been on screen yet (a
  // restored picked opens on today, browse on today's month), else it stays inside
  // the new window (clampMonthUi).
  if (facts && (held === null || held.facts !== facts || held.unavailable !== notices.unavailableCalendars)) {
    setHeld({ facts, unavailable: notices.unavailableCalendars });
    if (held === null || held.facts.today !== facts.today) {
      setMonthUi(monthUi === null || (monthFresh && activeTab !== 'month') ? initialMonthUi(savedLayout, facts.today) : clampMonthUi(monthUi, facts.today));
    }
  }

  // The loader reads the latest state through these; they are synced before it runs.
  const storeRef = useRef(store);
  const weeksRef = useRef(weeks);
  const blockedRef = useRef(blocked);
  const firstLoadRef = useRef(firstLoad);
  const monthRef = useRef<MonthWants>({ tab: activeTab, ui: monthUi, near, inView });
  const loaderRef = useRef<HomeLoader | null>(null);
  const resetFor = useRef<string | null>(null);
  useEffect(() => {
    storeRef.current = store;
    weeksRef.current = weeks;
    blockedRef.current = blocked;
    firstLoadRef.current = firstLoad;
    monthRef.current = { tab: activeTab, ui: monthUi, near, inView };
  });

  useEffect(() => {
    const loader = createHomeLoader({
      userId,
      sources: homeSources(calendarSource),
```

**4d. The loader:** not_enabled lets both controls go, `getMonths` and `agendaShowing` read `monthRef`, and the ensure effect also runs on the tab on screen, the near months, the month in view and the UI. In `app/[locale]/dashboard/CalendarHome.tsx`, Before (lines 159-188):
```tsx
        setBlocked('noCredential');
        setSheet(null);
        setSelected(null);
      },
      onNotEnabled: () => {
        // PageGate renders today's dashboard after the reload, which keeps Telegram's
        // BackButton: let it go first. If the guard says it already reloaded, the card's
        // Retry reloads by hand.
        if (!reloadOnce(NOT_ENABLED_RELOAD_KEY, Date.now(), releaseTelegramBackButton)) setBlocked('disabled');
      },
      setTimer: deps.setTimer,
    });
    loaderRef.current = loader;
    return () => {
      loader.dispose();
      loaderRef.current = null;
    };
  }, [userId, calendarSource, deps]);

  // Every visible window a source hasn't answered in this epoch: the first load, "Show
  // next week", and the refetch after a drop.
  useEffect(() => {
    loaderRef.current?.ensure();
  }, [store, weeks, blocked, firstLoad]);

  // Back in the foreground: the visible windows again (FamCal is one query; a Google
  // cache hit is one MGET). No pull-to-refresh: in Telegram that gesture minimizes the app.
  // If the day has ended in tz meanwhile (iOS suspends the midnight timer with the app),
  // the store drops at once, as the timer would have: the loader starts over with the
  // server's new today, and yesterday never stays labelled "Today".
```
After:
```tsx
        setBlocked('noCredential');
        setSheet(null);
        setSelected(null);
      },
      onNotEnabled: () => {
        // PageGate renders today's dashboard after the reload, which keeps Telegram's
        // BackButton and swipe setting: let both go first. If the guard says it already
        // reloaded, the card's Retry reloads by hand.
        if (!reloadOnce(NOT_ENABLED_RELOAD_KEY, Date.now(), releaseTelegramControls)) setBlocked('disabled');
      },
      setTimer: deps.setTimer,
      // The Month's windows while the Month is on screen (Ruling 7), most wanted first.
      getMonths: () => {
        const month = monthRef.current;
        const today = storeRef.current.facts?.today;
        return month.tab === 'month' && month.ui && today ? wantedMonths(month.ui, month.near, month.inView, today) : [];
      },
      agendaShowing: () => monthRef.current.tab === 'agenda',
    });
    loaderRef.current = loader;
    return () => {
      loader.dispose();
      loaderRef.current = null;
    };
  }, [userId, calendarSource, deps]);

  // Every visible window a source hasn't answered in this epoch: the first load, "Show
  // next week", the refetch after a drop, and the Month's windows as it comes on screen,
  // scrolls, or changes layout or month.
  useEffect(() => {
    loaderRef.current?.ensure();
  }, [store, weeks, blocked, firstLoad, activeTab, near, inView, monthUi]);

  // Back in the foreground: the visible windows again (FamCal is one query; a Google
  // cache hit is one MGET). No pull-to-refresh: in Telegram that gesture minimizes the app.
  // If the day has ended in tz meanwhile (iOS suspends the midnight timer with the app),
  // the store drops at once, as the timer would have: the loader starts over with the
  // server's new today, and yesterday never stays labelled "Today".
```

**4e. The Month's memos** (`notices` moved up in 4c): the window around the held today, the models, and the picked day's list. In `app/[locale]/dashboard/CalendarHome.tsx`, Before (lines 235-250):
```tsx
    };
    arm();
    return () => cancel();
  }, [tz, today, deps]);

  const agenda = useMemo(() => buildAgenda(store, weeks), [store, weeks]);
  const notices = homeNotices(store);
  // A store drop (midnight, other facts) empties the model, and the item sheet closes for
  // good, so it doesn't open again by itself when the new answer arrives.
  if (agenda === null && selected !== null) setSelected(null);

  const closeSheet = useCallback(() => setSheet(null), []);
  const navigate = useCallback(
    (href: string) => {
      setSheet(null);
      router.push(href);
```
After:
```tsx
    };
    arm();
    return () => cancel();
  }, [tz, today, deps]);

  const agenda = useMemo(() => buildAgenda(store, weeks), [store, weeks]);
  // A store drop (midnight, other facts) empties the model, and the item sheet closes for
  // good, so it doesn't open again by itself when the new answer arrives.
  if (agenda === null && selected !== null) setSelected(null);

  // The Month: the window around the held today, each month's model (memoized per store),
  // and the picked day's list.
  const heldToday = held?.facts.today ?? null;
  const months = useMemo(() => (heldToday ? monthSpan(heldToday) : []), [heldToday]);
  const getMonth = useMemo(() => monthModels(store), [store]);
  const monthShown = activeTab === 'month' && held !== null && monthUi !== null;
  const pickedShown = monthShown && monthUi?.layout === 'picked';
  const pickedDay = pickedShown ? (monthUi?.selected ?? null) : null;
  const pickedList = useMemo(() => (pickedDay ? { rows: dayRows(store, pickedDay), status: dayStatus(store, pickedDay) } : null), [store, pickedDay]);

  const closeSheet = useCallback(() => setSheet(null), []);
  const navigate = useCallback(
    (href: string) => {
      setSheet(null);
      router.push(href);
```

**4f. `retryMonth`, the tab switch, the Month's UI changes, the BackButton and the swipes (`browsing`), the Month's chunk fetched once the first answer is in, the two panels' elements, and the root's start up to `HomeTop`** (`facts`, `card` and `setupNeeded` moved up in 4c). In `app/[locale]/dashboard/CalendarHome.tsx`, Before (lines 254-294):
```tsx
  const refresh = useCallback(() => {
    setSheet(null);
    loaderRef.current?.refetchVisible({ fresh: true });
  }, []);
  const showNextWeek = useCallback(() => setWeeks((w) => w + 1), []);
  const retrySource = useCallback((source: SourceName) => loaderRef.current?.refetchVisible({ only: source }), []);
  const chooseCalendars = useCallback(() => router.push(`/${locale}/select-calendars?user_id=${userId}`), [router, locale, userId]);
  const retryCard = useCallback(() => {
    if (blockedRef.current === 'disabled') {
      try {
        window.location.reload();
      } catch {
        // The card stays.
      }
      return;
    }
    setFirstLoad(null);
  }, []);

  const facts = store.facts;
  const card: Card | null = blocked === 'disabled' ? 'disabled' : !facts && firstLoad ? firstLoad : null;
  const setupNeeded = calendarSource === 'GOOGLE' && (needsOAuth || needsCalendars);
  // The one BackButton (§7.6): a tap closes the send or menu sheet, else the item sheet.
  const itemOpen = blocked === null && card === null && agenda !== null && selected !== null && !setupNeeded;
  const back = () => {
    if (sheet !== null) setSheet(null);
    else setSelected(null);
  };
  useTelegramBackButton(itemOpen || (blocked !== 'noCredential' && sheet !== null), back);

  if (blocked === 'noCredential') {
    return <NoCredentialCard look="telegram" inTelegram={inTelegram} links={CLIENT_GATE_LINKS} />;
  }

  const zone = facts && zoneDiffers(deviceZone, facts.tz) ? facts.tz : null;

  return (
    <div className="ch-home" data-theme={scheme} dir={locale === 'he' ? 'rtl' : 'ltr'} lang={locale}>
      <style>{HOME_THEME_CSS}</style>
      <style>{HOME_SHELL_CSS}</style>
      <HomeHeader
```
After:
```tsx
  const refresh = useCallback(() => {
    setSheet(null);
    loaderRef.current?.refetchVisible({ fresh: true });
  }, []);
  const showNextWeek = useCallback(() => setWeeks((w) => w + 1), []);
  const retrySource = useCallback((source: SourceName) => loaderRef.current?.refetchVisible({ only: source }), []);
  const retryMonth = useCallback((month: MonthKey, source: SourceName) => loaderRef.current?.retryWindow(monthWindow(month), source), []);
  const chooseCalendars = useCallback(() => router.push(`/${locale}/select-calendars?user_id=${userId}`), [router, locale, userId]);
  const retryCard = useCallback(() => {
    if (blockedRef.current === 'disabled') {
      try {
        window.location.reload();
      } catch {
        // The card stays.
      }
      return;
    }
    setFirstLoad(null);
  }, []);

  // A tab switch (Ruling 2): any sheet and the item sheet close; leaving browse keeps the
  // month in view for the next time; the Agenda opens at the top.
  const switchTab = (next: HomeTab) => {
    setSheet(null);
    setSelected(null);
    if (activeTab === 'month' && monthUi !== null && held !== null) {
      setMonthFresh(false);
      if (monthUi.layout === 'browse' && inView !== null && inView !== monthUi.month) setMonthUi({ ...monthUi, month: inView });
    }
    if (next === 'month') {
      setNear([]);
      setInView(null);
    }
    setTab(next);
    writeHomeTab(userId, next);
    if (next === 'agenda') scrollToTop();
  };
  // The Month's next UI (a day picked, a chevron, Today, "All months", the BackButton):
  // a layout change is remembered on this device, and browse comes back on its month.
  const changeUi = (next: MonthUi) => {
    if (monthUi === null || next === monthUi) return;
    setMonthUi(next);
    setMonthFresh(false);
    if (next.selected !== monthUi.selected) setSelected(null);
    if (next.layout !== monthUi.layout) {
      writeMonthLayout(userId, next.layout);
      if (next.layout === 'browse') {
        setNear([]);
        setInView(null);
      }
    }
  };

  // The one BackButton (§7.6): a tap closes the send or menu sheet, else the item sheet,
  // else takes picked back to browse.
  const itemOpen =
    selected !== null && (activeTab === 'agenda' ? blocked === null && card === null && agenda !== null && !setupNeeded : pickedShown);
  const back = () => {
    if (sheet !== null) setSheet(null);
    else if (itemOpen) setSelected(null);
    else if (pickedShown && monthUi !== null) changeUi(backToBrowse(monthUi));
  };
  useTelegramBackButton(itemOpen || pickedShown || (blocked !== 'noCredential' && sheet !== null), back);
  // Ruling 9: no swipe-down to minimize while the Month shows browse (its loading
  // included): there a drag down scrolls the months. The header and the tab bar stick
  // over browse at the same time.
  const monthLayout = monthUi?.layout ?? (savedLayout === 'picked' ? 'picked' : 'browse');
  const browsing = activeTab === 'month' && monthLayout === 'browse';
  useTelegramVerticalSwipes(browsing);

  // The Month's chunk, once the first answer is in and the tab bar shows, so the first
  // tap on Month rarely waits for it. A failed fetch is tried again by that tap.
  const monthPossible = tabsShown && facts !== null;
  useEffect(() => {
    if (monthPossible) loadMonthView().catch(() => {});
  }, [monthPossible]);

  if (blocked === 'noCredential') {
    return <NoCredentialCard look="telegram" inTelegram={inTelegram} links={CLIENT_GATE_LINKS} />;
  }

  const zone = facts && zoneDiffers(deviceZone, facts.tz) ? facts.tz : null;
  const agendaView = (
    <AgendaView
      agenda={agenda}
      hints={hints}
      setupNeeded={setupNeeded}
      selected={selected}
      onSelect={setSelected}
      onShowNextWeek={showNextWeek}
      onRetry={retrySource}
      onChooseCalendars={chooseCalendars}
    />
  );
  const monthView =
    monthShown && held !== null && monthUi !== null ? (
      <MonthView
        today={held.facts.today}
        tz={held.facts.tz}
        weekStart={held.facts.weekStart}
        hebrewDates={held.facts.hebrewDates}
        months={months}
        getMonth={getMonth}
        ui={monthUi}
        start={{ month: monthUi.month, peek: monthFresh }}
        dayRows={pickedList}
        unavailableCalendars={held.unavailable}
        selected={selected}
        onSelect={setSelected}
        onUi={changeUi}
        onNearMonths={setNear}
        onMonthInView={setInView}
        onRetryMonth={retryMonth}
        onChooseCalendars={chooseCalendars}
      />
    ) : (
      <MonthLoading />
    );

  return (
    <div className="ch-home" data-theme={scheme} dir={locale === 'he' ? 'rtl' : 'ltr'} lang={locale}>
      <style>{HOME_THEME_CSS}</style>
      <style>{HOME_SHELL_CSS}</style>
      <style>{HOME_TOP_CSS}</style>
      <HomeTop sticky={browsing}>
        <HomeHeader
```

**4g. The header's props, inside `HomeTop`, and the tab bar** between the header and the banners, at the wrapper's end. In `app/[locale]/dashboard/CalendarHome.tsx`, Before (lines 295-308):
```tsx
        today={facts?.today ?? null}
        hebrewDates={facts?.hebrewDates ?? false}
        zone={zone}
        sendOpen={sheet === 'send'}
        menuOpen={sheet === 'menu'}
        onSend={() => setSheet('send')}
        onMenu={() => setSheet('menu')}
      />
      <HomeBanners
        calendarSource={calendarSource}
        needsOAuth={needsOAuth}
        needsCalendars={needsCalendars}
        trialDaysLeft={trialDaysLeft}
        hasLocation={hasLocation}
```
After:
```tsx
          today={facts?.today ?? null}
          hebrewDates={facts?.hebrewDates ?? false}
          zone={zone}
          sendOpen={sheet === 'send'}
          menuOpen={sheet === 'menu'}
          onSend={() => setSheet('send')}
          onMenu={() => setSheet('menu')}
        />
        {tabsShown ? <HomeTabs tab={tab} onTab={switchTab} /> : null}
      </HomeTop>
      <HomeBanners
        calendarSource={calendarSource}
        needsOAuth={needsOAuth}
        needsCalendars={needsCalendars}
        trialDaysLeft={trialDaysLeft}
        hasLocation={hasLocation}
```

**4h. The panels:** with the bar shown, each tab's panel is a `role="tabpanel"` labelled by its tab, the hidden one empty, the Month's in a `Suspense` whose fallback is the Month's loading state; without it, D's Agenda as before. In `app/[locale]/dashboard/CalendarHome.tsx`, Before (lines 311-333):
```tsx
        userId={userId}
        locale={locale}
        onNavigate={navigate}
      />
      {card ? (
        <HomeCard kind={card} onRetry={retryCard} />
      ) : (
        <AgendaView
          agenda={agenda}
          hints={hints}
          setupNeeded={setupNeeded}
          selected={selected}
          onSelect={setSelected}
          onShowNextWeek={showNextWeek}
          onRetry={retrySource}
          onChooseCalendars={chooseCalendars}
        />
      )}
      {sheet === 'send' ? <SendSheet userId={userId} locale={locale} onClose={closeSheet} /> : null}
      {sheet === 'menu' ? (
        <MenuSheet
          calendarSource={calendarSource}
          isAdmin={user.isAdmin}
```
After:
```tsx
        userId={userId}
        locale={locale}
        onNavigate={navigate}
      />
      {card ? (
        <HomeCard kind={card} onRetry={retryCard} />
      ) : tabsShown ? (
        <>
          <div role="tabpanel" id={PANEL_IDS.agenda} aria-labelledby={TAB_IDS.agenda} hidden={tab !== 'agenda'}>
            {tab === 'agenda' ? agendaView : null}
          </div>
          <div role="tabpanel" id={PANEL_IDS.month} aria-labelledby={TAB_IDS.month} hidden={tab !== 'month'}>
            {tab === 'month' ? <Suspense fallback={<MonthLoading />}>{monthView}</Suspense> : null}
          </div>
        </>
      ) : (
        agendaView
      )}
      {sheet === 'send' ? <SendSheet userId={userId} locale={locale} onClose={closeSheet} /> : null}
      {sheet === 'menu' ? (
        <MenuSheet
          calendarSource={calendarSource}
          isAdmin={user.isAdmin}
```

- [ ] **Step 5: The item sheet keeps focus in `app/[locale]/dashboard/BottomSheet.tsx`**

Two edits, in file order (D's file at 0064e8f; E1-E7 don't touch it). The sheet is D's (D5); over the Month's picked layout the page behind it is some 30 day buttons and two chevrons, each of which changes the day (the review), so the sheet now keeps focus while it is open: Tab and Shift+Tab go round its own controls, focus that lands outside it comes back to the panel, and Escape closes it wherever focus is. The Agenda's sheet, the Send sheet and the menu get the same.

**5a. The header comment.** In `app/[locale]/dashboard/BottomSheet.tsx`, Before (line 11):
```tsx
// - Escape, a tap on the scrim and the Close button all call onClose.
```
After:
```tsx
// - It keeps focus while open (Plan E: over the Month's picked layout the page behind it
//   is some 30 day buttons and two chevrons, each of which would change the day): Tab
//   and Shift+Tab go round its own controls, and focus that lands outside it (a
//   keyboard's or a screen reader's) comes back to the panel.
// - Escape (wherever focus is), a tap on the scrim and the Close button all call onClose.
```

**5b. The trap:** the document's `focusin` and `keydown` listeners while the sheet is open (removed before focus goes back), and Tab's wrap in the panel's own `onKeyDown`. In `app/[locale]/dashboard/BottomSheet.tsx`, Before (lines 27-42):
```tsx

export function BottomSheet({ label, closeLabel, onClose, children }: BottomSheetProps) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement as Focusable | null;
    panel.current?.focus({ preventScroll: true });
    return () => {
      if (previous && typeof previous.focus === 'function') previous.focus({ preventScroll: true });
    };
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    onClose();
```
After:
```tsx
type TreeNode = { parentNode: TreeNode | null; childNodes?: ArrayLike<TreeNode>; nodeType?: number };

/** Whether `node` is `root` or inside it (a walk up the tree: the target of any event). */
function inside(root: TreeNode, node: unknown): boolean {
  for (let n = node as TreeNode | null; n; n = n.parentNode) if (n === root) return true;
  return false;
}

/** The panel's controls a keyboard reaches, in document order: enabled buttons, links, inputs, and anything with a tabindex of 0 or more. */
function controlsIn(root: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  const walk = (node: TreeNode) => {
    for (const child of Array.from(node.childNodes ?? [])) {
      if (child.nodeType !== 1) continue;
      const el = child as unknown as HTMLElement;
      const tag = el.localName;
      const tabIndex = el.getAttribute('tabindex');
      const reachable =
        tabIndex !== null
          ? Number(tabIndex) >= 0
          : (tag === 'button' || tag === 'input' || tag === 'select' || tag === 'textarea')
            ? !el.hasAttribute('disabled')
            : tag === 'a' && el.hasAttribute('href');
      if (reachable) out.push(el);
      walk(child);
    }
  };
  walk(root as unknown as TreeNode);
  return out;
}

export function BottomSheet({ label, closeLabel, onClose, children }: BottomSheetProps) {
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });

  // Focus in on open, out on close; while open, focus that lands outside comes back and
  // Escape closes the sheet wherever focus is. The listeners go before focus goes back.
  useEffect(() => {
    const previous = document.activeElement as Focusable | null;
    const el = panel.current;
    el?.focus({ preventScroll: true });
    const onFocusIn = (e: Event) => {
      if (el && !inside(el as unknown as TreeNode, e.target)) el.focus({ preventScroll: true });
    };
    const onDocumentKey = (e: Event) => {
      const key = (e as unknown as { key?: string }).key;
      if (key === 'Escape' && el && !inside(el as unknown as TreeNode, e.target)) close.current();
    };
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('keydown', onDocumentKey);
    return () => {
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('keydown', onDocumentKey);
      if (previous && typeof previous.focus === 'function') previous.focus({ preventScroll: true });
    };
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab' || !panel.current) return;
    // Tab goes round the sheet's own controls.
    const controls = controlsIn(panel.current);
    const active = document.activeElement;
    if (controls.length === 0) {
      e.preventDefault();
      return;
    }
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (e.shiftKey && (active === first || active === panel.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
```

- [ ] **Step 6: Run the smoke and see it pass**

```bash
cd /Users/razielgershoni/development/famcalbot
E="DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake"
for tz in UTC Asia/Jerusalem Pacific/Kiritimati America/Los_Angeles; do
  eval "env TZ=$tz $E npx tsx scripts/smoke-calendar-home-render.ts" > /tmp/e8-render.log 2>&1; echo "TZ=$tz exit $?"; grep -E '^FAIL|passed' /tmp/e8-render.log
done
```
Expected (each run takes a few seconds), with no `FAIL` line:
```
TZ=UTC exit 0
60/60 passed (process TZ=UTC)
TZ=Asia/Jerusalem exit 0
60/60 passed (process TZ=Asia/Jerusalem)
TZ=Pacific/Kiritimati exit 0
60/60 passed (process TZ=Pacific/Kiritimati)
TZ=America/Los_Angeles exit 0
60/60 passed (process TZ=America/Los_Angeles)
```
If only #60 fails, React logged a warning in #43-#59, and the message names it. If #45, #47 or #51 fails on a scroll, the message lists every `window.scrollTo` call with its behaviour, and the wanted top.

- [ ] **Step 7: Run the regression smokes again**

```bash
cd /Users/razielgershoni/development/famcalbot
E="DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake"
for f in smoke-miniapp-gate smoke-page-auth smoke-initdata-header smoke-auth-leftovers smoke-auth-identity smoke-calendar-home-tabs smoke-calendar-month-browse smoke-calendar-month-picked smoke-calendar-month smoke-calendar-loader smoke-calendar-home-copy smoke-telegram-ui check-i18n-parity; do
  for tz in UTC Asia/Jerusalem; do
    eval "env TZ=$tz $E npx tsx scripts/$f.ts" > /tmp/e8-$f.log 2>&1; echo "$f TZ=$tz exit $?"
    grep -E '^(OK|FAIL)|passed|parity' /tmp/e8-$f.log > /tmp/e8-$f-${tz//\//_}.after
    cmp -s /tmp/e8-$f-${tz//\//_}.before /tmp/e8-$f-${tz//\//_}.after && echo "  same output as Step 2" || echo "  OUTPUT CHANGED"
  done
done
```
Expected: every run prints `exit 0` and `same output as Step 2`. `smoke-initdata-header`, `smoke-auth-leftovers` and `smoke-auth-identity` now also scan `MonthView.tsx`, the new container and the sheet, and they stay green.

- [ ] **Step 8: Type-check and lint**

```bash
cd /Users/razielgershoni/development/famcalbot
npx tsc --noEmit -p . ; echo "tsc exit $?"
npm run -s lint ; echo "lint exit $?"
```
Expected: `tsc exit 0` and `lint exit 0`, with no other output.

- [ ] **Step 9: Commit**

```bash
cd /Users/razielgershoni/development/famcalbot
git add 'app/[locale]/dashboard/MonthView.tsx' 'app/[locale]/dashboard/CalendarHome.tsx' 'app/[locale]/dashboard/BottomSheet.tsx' scripts/smoke-calendar-home-render.ts
git commit -m "$(cat <<'EOF'
feat(calendar-home): the Month tab and the tab bar

The home gets its tab bar and the iOS-style Month (spec §7.1, §7.4).
The bar sits under the header, above the banners, and shows only while a
panel can: no card, no block, not a Google user still setting up. The
tab is kept for the session, a switch closes any sheet, and the Agenda
opens at the top. MonthView shows browse or picked, the unavailable
calendars row once above them, and D's item sheet over picked. Browse
opens on today's month with a peek, on the picked month after All
months, and on the month in view after a tab switch; a restored picked
opens on today, and the layout is kept per device. While the Month
shows, the loader asks its months, at most 2 at a time; the foreground
and Refresh ask the Month's windows; Retry asks one month. Through a
store drop the Month keeps the last facts and stays where it is, loading.
Telegram's BackButton also shows in picked (a tap closes the top sheet,
else the item sheet, else goes back to browse); swipes are off in browse
on 7.7+ clients; not_enabled lets both go before the reload. Over
browse the header and the tab bar stick under the safe areas, as the
approved MonthFlow keeps them on screen, so the Agenda, Send and the
menu are a tap away at today's month. The Month's three views are a
chunk of their own, fetched once the first answer is in, so the chunk
every /dashboard open preloads grows much less. The item sheet keeps
focus while it is open. Render smoke: #22 flips to the tab bar, #43-#60
cover the Month. The switch decides who sees it, as before.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
EOF
)"
```
Stage only these four paths. The working tree may show plan or spec files as modified; they aren't part of this task.

#### For the landing report (the controller)

**Spec edits in the plan commit** (Plan E Rulings 1-8, and the review patch's; the spec is final, so these are the owner-facing record):
- **§7.1 Shell, State:**
  - the tab bar sits under the header and above the banners, and shows only while a tab's panel can show: not blocked, no home card (busy, retry, switch-off) and not `setupNeeded`. While `setupNeeded` the home is D's (the Agenda, no bar), and the stored tab is left as it is (Ruling 1);
  - the tab memory key is `sessionStorage` `famcal:homeTab:v1:{userId}`, `'agenda' | 'month'`; anything else, or a throwing storage, reads `'agenda'`. A new session opens on the Agenda. A tab switch closes any sheet, the Agenda opens at the top, and the Month's browse comes back with the month that was in view (Ruling 2).
- **§7.1 Shell, Layout** (review patch): document-level scroll stays; while the Month shows browse, the header and the tab bar stick under the safe areas (the approved MonthFlow's look without its inner scroller), with browse's bar under them. On the Agenda and in picked they scroll with the page. The Month's views are a chunk of their own, so `PRELOAD.dashboard`'s chunk holds the Agenda, the tab bar and the Month's state, not its views.
- **§7.4 Month:**
  - **Cells (Ruling 3):** 92 px. The head line has the Gregorian day with the Hebrew day number at its end. A 13 px second line holds the Hebrew month's short name on Hebrew day 1 and on the month's first cell; it is the line kept for holidays. Then 3 slots of 18 px. A day with more items than fit shows 2 chips and "+N" in the third slot, and a 360 px or narrower screen shows at most 2 chips. Bars keep their lanes while a day's slots fit; a day that overflows first lets its one-day items into a bar's empty lanes, then moves its bars up, each one that leaves its lane with its title, so it never shows an empty line over "+N" (review patch).
  - **Notices overlay the grid (Ruling 4):** failed, busy and calendars gone as a pill centred over dimmed cells, partial as a pill at the grid's top. They never change a month's height. A reconnect dims the cells and adds no pill. "N calendars aren't available · Choose again" shows once, above the Month (in picked too). The Reconnect banner and that row hold for the session's store (until midnight or a facts change) once an answer shows them, and when content above browse does change height while it is scrolled, browse keeps the month in view where it was (review patch; iOS has no scroll anchoring).
  - **R11's counts (Ruling 5):** daily reminders are left out of the chips, the dots, "+N" and the cell's label count, and listed under the picked day.
  - **Today and picked (Ruling 6):** browse's Today button shows while no part of today's month is on screen, and scrolls smoothly, or instantly under reduced motion. Picked's Today pill shows while the selected day isn't today. Entering picked scrolls the page to the top and focuses the selected day; on a screen too short for the header, the tabs, the banners, the month and the day's first row (a 6-row month under two banners on a 375 × 667 phone), it scrolls only as far down as shows the day's header and first row, never past picked's bar (review patch). "All months", the BackButton and Android's back return to browse with the picked month under the bar.
  - **Titles (Ruling 8):** a month's `h2` has the year only outside today's year, then the Hebrew range; the sticky bar and picked's title always carry the year. Russian months are the capitalised standalone nominative, without "г.". The weekday row is en narrow, he narrow ("א׳ ב׳ …"), ru two-letter, in `weekStart` order.
  - **Memory:** a layout change is stored at once. A restored picked opens on today, also when the day has changed since the home opened and the Month wasn't shown yet.
- **§5 Month windows (Ruling 7):**
  - the 2-in-flight cap counts Month windows only, and every send for one goes through it (the first ask, a refetch, Retry, the stale and error follow-ups);
  - a queued month no longer wanted when its turn comes is dropped and isn't marked asked; a month's stale or error follow-up that falls due once the month is no longer wanted is dropped too (review patch);
  - a return to the foreground and ⋯ → Refresh ask again for the tab on screen: on the Agenda its weeks; on the Month in browse the months near the viewport, in picked the picked month and its neighbours;
  - without IntersectionObserver, "near" is the month in view and its two neighbours; the month in view's neighbours are fetched with the near months in any case (review patch: Telegram's web clients ignore the observer's margin).
- **§4 step 3** (review patch): `resolveUserTimezone` shares a lookup per user for its first 1.5 s; a later caller starts its own, so a lookup stuck on a call with no time limit holds nobody after that.

**Device check before `ALL`** (§10 plus Plan E's), on an iPhone and on Android with gesture navigation, light and dark, and in Hebrew (RTL):
- drag down at the top of browse with swipes off, and on a client older than 7.7;
- Android back in picked returns to browse; in browse it closes;
- the BackButton after a reload in picked, and after Settings from the ⋯ menu;
- with the item sheet over picked, one tap closes only the sheet;
- the sticky bar during momentum scroll and the top bounce;
- 11 px cell text and chips on a 360 px phone;
- the Hebrew Month: weekday order, chevrons, bars right to left;
- send-to-chat closes on a 2xx and stays open on a 429;
- a fling through 31 months stays under the rate limit, with no 429 notice;
- E8's own: a midnight with the Month open (browse stays put, cells load, today moves); the tab bar's pill and Telegram's button colours on its themes; Russian "22 адара II" in a 46 px picked cell (E1, E7);
- the review patch's:
  - from browse at today's month (October), reach the Agenda, ⋯ → Refresh and Send without scrolling: the header and the tab bar stay on screen, during momentum scroll and the top bounce too, and nothing shows through above them under the notch in fullscreen;
  - a 6-row picked month (August 2026) with the trial and location banners on a 375 × 667 phone and on a 320 × 568 one: entering picked shows the day's header and first row with the bar on screen ("fits one screen" holds only on a tall phone); 320 px browse cells with "+12 more" and the Russian short months;
  - a dead Google token while scrolling months, some cached and some not: the Reconnect banner appears once and stays, and the month in view doesn't jump when it does;
  - the first tap on Month after a fresh open on a slow network: the Month's placeholders, then browse, with no blank;
  - the item sheet over picked with a Bluetooth keyboard (Tab, Shift+Tab, Escape) and with VoiceOver and TalkBack: nothing behind it is reached.

**The home's chunks** (review patch): what every /dashboard open preloads (PageGate's `PRELOAD.dashboard`, for the users the switch doesn't cover too) is CalendarHome's chunk, 45,298 B (13,766 B gzip), and a chunk Turbopack splits off with the modules it shares with the Month's chunk, 47,478 B (14,859 B gzip): 92,776 B (28,625 B gzip), against 71,146 B (20,511 B gzip) on E1-E7 and 115,326 B (31,712 B gzip) with the Month's views inside. The Month's own chunk, 33,219 B (8,650 B gzip), is fetched by the switch's users only, once their first answer is in. Measured with `npx prisma generate && npx next build` (fake env, `NODE_ENV=production`) on a fresh copy, by finding the chunks that hold `famcal:calendarHome:notEnabledReload:v1`, `ch-agenda` and `ch-mb-bar`. Run the same on the fresh clone if a number is needed for the PR. The `calendarHome` copy on every page (E1 adds about 1 KB per language) is D's "For the PR" item, unchanged.

**Staying deferred for before `ALL`:** Ruling 10's "not taken" items but the focus trap, which the review patch takes (StillOpenCard's `aria-expanded`, `useTelegramTheme`'s shared handler, the page-data hint logging, the masked carry-over's empty name, the `linkText` scheme allowlist), and D Ruling 4's week dates on the Send sheet. E3 left one more: `timezone.ts` still sends `location` to Sentry in the warning's context (the line moved with E3's edit; it is the `ctx` of the default-zone warning). And one the review raised and the patch leaves: a user the switch covered and then didn't, who uses Telegram's own Reload Page while in browse, keeps vertical swipes off on today's dashboard until the app is closed (DashboardClient never enables them); a 7.7-gated `enableVerticalSwipes()` in PageGate would fix it for every switch-off user's start.

---

### Task 9: Verification and landing (run by the controller, not a subagent)

**Files:** none changed, unless a check fails.

- [ ] **Step 1: Run every smoke under both clocks, and the day-bucketing smokes under Kiritimati**

```bash
cd /Users/razielgershoni/development/famcalbot
E="DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake"
OUT=/private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/landing-E; mkdir -p $OUT
run() { eval "env TZ=$2 $E perl -e 'alarm shift; exec @ARGV' 300 npx tsx $1" > "$OUT/$(basename $1 .ts).$(echo $2 | tr / _).out" 2>&1; echo "$(basename $1) $2 exit=$? $(tail -1 "$OUT/$(basename $1 .ts).$(echo $2 | tr / _).out")"; }
for s in scripts/smoke-*.ts; do for tz in UTC Asia/Jerusalem; do run $s $tz; done; done
for s in locale-rules calendar-dto calendar-read-google calendar-range digest-adapters calendar-read-google-cancel summary-prompt-parity summary-seam calendar-home-rollout summary-retry week-lookahead week-commands digest-reader-parity google-map calendar-home-copy hebrew-date calendar-agenda calendar-home-render page-auth miniapp-gate calendar-grid calendar-loader timezone-inflight calendar-month calendar-month-browse calendar-month-picked; do run scripts/smoke-$s.ts Pacific/Kiritimati; done
for s in hebrew-date calendar-grid; do run scripts/smoke-$s.ts America/Santiago; done
run scripts/smoke-hebrew-date.ts America/Los_Angeles
eval "env $E npx tsx scripts/check-i18n-parity.ts"; echo "parity exit $?"
```

Expected: every line `exit=0` (71 smoke files under the two clocks; the Kiritimati, Los Angeles and Santiago runs above) and `i18n parity OK (1013 keys)`. The new and changed counts are calendar-home-copy 18, calendar-grid 11, hebrew-date 22, calendar-agenda 37, calendar-loader 12, timezone-inflight 7, telegram-ui 19, calendar-home-tabs 11, calendar-month 26, calendar-month-browse 26, calendar-month-picked 14 and calendar-home-render 60; calendar-range stays 24. A non-zero exit is a failure to fix before landing. macOS has no `timeout`; the `perl` alarm stands in for it.

- [ ] **Step 2: Type-check and lint the branch**

Run: `npx tsc --noEmit -p . && npm run -s lint; echo "exit $?"`
Expected: `exit 0`, no output before it.

- [ ] **Step 3: Build a fresh clone on Node 22, and run the home smokes there**

```bash
F=/private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/fresh-E
rm -rf $F && git clone -q --branch feat/calendar-home /Users/razielgershoni/development/famcalbot $F && cd $F
# E is the env prefix from Step 1.
npx -y node@22 "$(command -v npm)" ci --no-audit --no-fund > ../fresh-E-ci.log 2>&1; echo "ci exit $?"
npx -y node@22 node_modules/.bin/prisma generate > ../fresh-E-gen.log 2>&1; echo "generate exit $?"
npx -y node@22 node_modules/.bin/next build > ../fresh-E-build.log 2>&1; echo "build exit $?"; tail -5 ../fresh-E-build.log; grep -c "api/calendar/range" ../fresh-E-build.log
for s in calendar-home-copy calendar-grid hebrew-date calendar-agenda calendar-loader timezone-inflight telegram-ui calendar-home-tabs calendar-month calendar-month-browse calendar-month-picked calendar-home-render page-auth miniapp-gate calendar-range; do eval "env TZ=Asia/Jerusalem $E npx -y node@22 node_modules/.bin/tsx scripts/smoke-$s.ts" > ../fresh-E-$s.out 2>&1; echo "$s node22 exit=$? $(tail -1 ../fresh-E-$s.out)"; done
```

Expected: three `exit 0` lines, a finished build, a non-zero count of `api/calendar/range` in the route table, and every Node 22 smoke `exit=0`. The render smoke's expected date strings come from `Intl`; if a check fails on Node 22 only, compare the strings: an ICU formatting difference is a fixture problem to report, any other difference is a failure. Also check the build log: `npm ls @hebcal/hdate` in the clone shows one deduped 0.21.x, and the route table lists `/[locale]/dashboard`. `next build` here runs no migration: the clone has no `.env`, and `next build` is called directly rather than `npm run build`.

- [ ] **Step 4: Land on main and push**

The owner authorized landing ("you can proceed and ping me after push to main").

```bash
cd /Users/razielgershoni/development/famcalbot
git fetch -q origin
git checkout -q main && git pull -q --ff-only origin main
git merge --ff-only feat/calendar-home
git push -q origin main
git checkout -q feat/calendar-home && git push -q origin feat/calendar-home
git rev-parse --short main
```

Expected: a fast-forward with no merge commit. If `--ff-only` refuses, stop: `main` moved. Rebase the branch onto it, re-run Steps 1–3 and try again.

- [ ] **Step 5: Confirm the deploy**

Poll `gh api repos/raziel-gershoni/famcalbot/commits/<sha>/status --jq '.statuses[] | "\(.context) \(.state)"'` every few minutes, not in a tight loop. Wait until the context `famcalbot - famcalbot` (Railway) and the Vercel context both read `success`. Plan D has no migration; Railway's `npm ci` installs `@hebcal/hdate`. On `failure`, read the build log, fix on the branch and land again.

- [ ] **Step 6: Report to the owner**

Send a short ping that says what is live and what isn't:
- the Month tab and the tab bar are live for whoever the switch covers (`ADMINS` at most until the device check);
- what everyone gets anyway: the dashboard preload is about 93 KB (28.6 KB gzipped), up from D's, and the Month and tab copy reaches every page's messages;
- the UI rulings the owner may want to change: 3 (cell lines), 4 (notices over the grid), 6/12 (picked scrolling), 11 (sticky header and tabs in browse only), 13 (overflowing bars), 14 (banners held), 15 (lazy Month);
- the device check before `ALL` (the split's list, in the landing log): drag down at the top of browse with swipes off and on a client older than 7.7; Android back in picked and in browse; the BackButton after a reload in picked; the item sheet over picked; the sticky bar during momentum scroll and the top bounce; 11 px cells on a 360 px phone; the Hebrew Month; a fling through 31 months with no 429 notice; a 6-row picked month with both banners on a small phone;
- what stays deferred for before `ALL` (the hint logging, the masked carry-over's empty name, the `linkText` allowlist, `useTelegramTheme`'s shared handler, the Send sheet's week dates, `timezone.ts` sending the location in a Sentry context, and swipes after a rollback).

Production stays read-only.

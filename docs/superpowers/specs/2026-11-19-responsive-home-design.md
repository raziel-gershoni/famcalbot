# Responsive home, Daf Yomi and Hebrew months: design

Status: approved by the owner 2026-11-20 ("go"), without the pointer highlight (decision 6). The wording (§6, §8) was approved by the owner on 2026-11-20 ("go with your recommendation"): every recommended option of the translation list, namely "Даф йоми" (not "Йоми"); option A of the day's line ("דף יומי · ערכין ג׳", "Даф йоми · Арахин 3"); FamCal's own Russian tractate names as proposed (Брахот, Песахим, Бейца, Рош а-Шана, Таанит, Мегила, Евамот, Бава Кама, Бава Мециа, Бава Батра, Санхедрин, Авода Зара, …); hebcal's English spellings (Gitin, Midot, Baba Kamma, Rosh Hashana); and option A of the Months row (release 3). Release 1's plan is `docs/superpowers/plans/2026-11-20-daf-yomi.md`. Release 2 (owner 2026-11-26: "keep the order") is built; its plan file was deleted at ship (git history: `docs/superpowers/plans/2026-11-26-responsive-home-layouts.md`). Claude's calls while building it, reported to the owner: per-month problems (loading, failed, Google) are pills over their month; the selected day's month is always fetched, second after the month in view; "+" on the Month starts on the selected day; the header and tab bar never stick (the Month tab's page doesn't scroll); resting a lifted item on a chevron scrolls the pane a month, and drag never auto-scrolls the month pane; the bar is ‹ title › at the start and Today at the end, the space between kept for release 3's switch; the squares' size comes from the computed split height, settling 220 ms after a resize; v1 memory `'browse'` → grown, `'picked'` → split; the handle's touch area is 44 px, all of it below the bar; handle copy he "הגדלת החודש" / "הקטנת החודש", ru "Увеличить месяц" / "Уменьшить месяц"; a selection that was today follows to the new today at midnight; the editor stays a full-height drawer on short wide windows. Not built: §10's browser check (the repo has no browser runner; the owner's device pass in prod replaces it). Builds on the calendar home spec (`2026-10-16-calendar-home-design.md`, §7) and the editor upgrades spec (`2026-10-25-editor-upgrades-design.md`, §4, drag to move). Release 3 (Hebrew months, owner 2026-11-27 "proceed") is built; its plan file was deleted at ship (git history: `docs/superpowers/plans/2026-11-27-hebrew-months.md`). The owner's answer to its plan (2026-11-27, "A"): the switch is one 44 px "א" toggle before Today (lit while Hebrew months show; screen readers hear "Hebrew months", on or off), not the two words, which do not fit a 375 px bar with Today in en and ru; on a bar under 420 px the title's small ▾ hides. With it, as proposed: en and ru squares show the Hebrew day in digits (gematriya in he); the Russian month names are hebcal's standard ones (Тишрей … Элул), not a list of FamCal's own; a Hebrew square names the Gregorian month on the 1st and on the month's first square, and its line holds holidays only; the jump opens on its Hebrew wheels while Hebrew months show; a failed save keeps the choice for the visit and logs why. Claude's calls while building it: a month key can name a Hebrew month (`h5787-03`), so the span, windows, focus and loader take either kind; a Hebrew month's fetch is its own days (not 1st to 1st); switching keeps the selected day and opens its month in the other calendar; in Russian at 375 px with Today showing, the line under a Gregorian title that names two Hebrew months ends in "…" (the title itself is never cut).

## Intent

FamCal's home should use the screen it is on. A sideways phone, a laptop or an iPad shows the month and the selected day's list at the same time. The owner calls that landscape view "always perfect". A phone held upright gets the same idea, with the month above the day instead of beside it. That way, turning the phone or opening the laptop changes nothing the person has to learn. CalBrew (the owner's earlier app, measured at 19 window sizes on 2026-11-18) is the model for the wide layout. We copy its behaviour, not its code.

The work also adds a quiet Daf Yomi line to Jewish-culture accounts, and, last, a Hebrew-month mode for the Month.

## Goals

- One layout idea on every screen: the month and the selected day together. Side by side when the window is wide, one above the other when it is upright.
- The month never scrolls away with the day's list. The owner observed that today the tapped-day view scrolls as one page, so a long day pushes the month off the screen. In the new layouts only the list scrolls.
- Each day square shows what its own size allows: dots on a phone, event names on a laptop or an upright iPad.
- Daf Yomi as one quiet line in the day lists and the Agenda, for those who turn it on.
- A Hebrew/Gregorian month switch, saved on the account.

## Non-goals

- Other learning schedules: Daf Yomi only. The owner will discuss others later. Don't build a schedule picker.
- Learning in the month squares, the summaries, the voice notes, the bot's replies or the copy to Google.
- Any change to the Agenda's content apart from the Daf Yomi line (§6), and any change to the bot.
- Keeping today's two Month screens (All months / tapped day) as an option. The split replaces both (owner, 2026-11-19: "split"). The prototype's "two screens" switch is not built.

## Anti-goals

- Event names cut through the middle of a line (CalBrew's upright flaw).
- Learning labels that push family events out of a square (CalBrew's two orange labels per square).
- A count bubble that stops meaning anything (CalBrew's never drops below 2). FamCal's own dots replace it.
- Any hover effect on a touch screen.

## Owner decisions

Numbers 1–9 are the proposal of 2026-11-18. Each one's amendment is marked with its date.

1. **The window's shape picks the layout.**
   - **Wide** (`width ≥ 600 px` and `width > height`: a laptop, a landscape iPad, a phone turned sideways, a wide Telegram Desktop window): the month and the selected day side by side, the month taking two thirds, mirrored in Hebrew (the month on the right). When the window is short (`height ≤ 520 px`), the header shrinks to one line: the date, the Hebrew date, the temperature and the buttons.
   - **Upright** (everything else): the split, §3. *Amended 2026-11-19: was "stays as today".*
2. **Each month is exactly one pane tall** (the wide month pane, or the split's month area). Its weeks share that height, so a 5-week month has taller rows than a 6-week one. Scrolling goes on without end within the reach (January 1900 … December 2100, `MONTH_REACH`), but it stops on whole months. The bar keeps the arrows, Today and the jump to a date.
3. **Each day square decides what to show from its own size**, in every layout (§4). Multi-day events keep their single bar where names show. *Amended 2026-11-18: small squares show FamCal's dots (filled for yours, a ring for the partner's, in the calendar's colour), not CalBrew's count bubble.*
4. **The selected day's list** (the wide side panel, or the split's list) opens on today. It has the same rows and actions as today's tapped-day list. Tapping another day changes only the list.
5. **On wide windows, pop-ups become centred cards** instead of drawers that fill the width. Sheets are about 480 px wide, the editor about 640 px, and the Agenda tab a centred column up to about 720 px. On a phone they stay drawers.
6. ~~A light highlight under the mouse pointer~~. **Not now** (owner, 2026-11-20: "don't do hover for now"). None is built; the no-hover rule stands.
7. **Hebrew/Gregorian month switch** (release 3, §7), on the Month's bar, saved on the account. *Amended 2026-11-26: was a Menu (⋯) row; owner, on a screenshot of the bar: "where i marked red is plenty of space to put hebrew switch for the calendar type".*
8. **Daf Yomi** (release 1, §6). *Amended 2026-11-19: Daf Yomi only; was any of hebcal's 20 schedules.*
9. **Three releases, in this order:** 1. Daf Yomi (small). 2. The layouts, the size-aware squares and the centred pop-ups (large). 3. Hebrew months (large). Each release ships and goes live before the next starts.

Also decided 2026-11-19: upright = **split** (not two screens). The month stays fixed and only the list scrolls in every layout.

## 1. Layout selection

- The layout follows the window, live. It changes when Telegram expands or collapses, when the phone turns, or when a desktop window is resized. Read it from `matchMedia('(min-width: 600px) and (orientation: landscape)')`. Use a listener, not resize polling. Treat equal width and height as upright.
- It applies only to the Month tab. The Agenda keeps its single column, centred at up to about 720 px when wide (decision 5).
- The header and the tab bar stay at the top of the screen whenever the Month tab shows. Under them, the Month takes exactly the rest of the viewport (`var(--tg-viewport-stable-height, 100dvh)` minus the header, the tabs and the safe areas). This replaces "document-level scroll, with no inner scroller" (home spec §7.1) for the Month tab only. The month pane and the day list are two inner scrollers, each with `overscroll-behavior: contain`. The page itself does not scroll on the Month tab. *Amended 2026-11-26 (final review I2): minus the safe areas above only. The Month runs down to the screen's bottom edge: the day list scrolls under the home indicator and pads its own end by it, the wide pane's months end above it, and the grown split's 44 px peek stays clear of it.*
- **Banners and notices on the Month tab** (my call, checked by the review: today `HomeBanners` and the "N calendars aren't available" row sit above the Month and could leave the split's list no room on a small phone). In both layouts they move to the top of the day list's scroller, above the day header. They are the first thing under the month and scroll away with the list. The Agenda tab keeps them where they are.
- **When the upright space is short:**
  - the list keeps at least 120 px (the day header and one row);
  - the collapsed month's rows give way first, from the 44 px floor down to 36 px. Squares on a phone are about 53 px wide, so the tap area stays larger than 36×53;
  - below that, the list takes what is left.
- **The short header** (my call): when the window is short (`(max-height: 520px) and (orientation: landscape)`, whatever its width, on both tabs), the header is one line: the date, the Hebrew date, the temperature and the buttons, the zmanim button included.
  - It drops the header's holiday line (the day lists keep theirs), the two zman lines (the zmanim button still opens the zmanim sheet) and the weather's place, range and days.
  - "Times in <zone>" stays: it is a correctness warning. When it shows it is a second line.
  - *Amended 2026-11-26 (owner, "go recommended"): a short phone held upright (`(max-height: 700px) and (orientation: portrait)`, `SHORT_UPRIGHT_QUERY`) gets a one-line header on the Month tab only, so the split's day list keeps about 120 px (a 375×667 phone had about 76 px, a 360×640 one about 46). The line is the day's short form ("Thu 26 Nov"; "26 Nov" where the text column is under 140 px, so a cut never lands on the day's number) over the Hebrew date (cut with an ellipsis where it has no room), beside the buttons, so the header stays 56 px; the long day stays the heading for screen readers; the holiday, the zman lines, the parasha and countdown and the weather go. The other tabs keep the full header.*
- **Telegram swipes:** `disableVerticalSwipes()` while the Month tab shows, in either layout. This extends today's browse-only lock in `useTelegramVerticalSwipes`. `enableVerticalSwipes()` on the Agenda and on unmount. Clients older than Bot API 7.7 can still close the app by pulling down at the top of a scroller: an accepted limitation, listed in §9.

## 2. The wide layout

- **Grid:** `2fr 1fr`, month first in reading order, so it lands on the right in Hebrew because of RTL. Logical properties only.
- **Month pane:** the month bar (previous/next chevrons, the month's title as the jump to a date, Today when the selected day or the month in view isn't today's), then the weekday row, then the scroller.
  - The scroller holds the months stacked, each exactly the scroller's height (decision 2), with `scroll-snap-type: y mandatory` and each month `scroll-snap-align: start`.
  - The chevrons scroll the scroller by one month.
  - The span grows and the per-month fetch works as in today's browse (home spec §7.4 "Span" and "Fetching"). Reuse that code, don't write it again.
- **Side panel:** the selected day: the banners (§1), the day header ("Today · …" when it is today), the Daf Yomi line (§6) when on, then that day's rows, exactly as today's picked list. It scrolls on its own. *Amended 2026-11-26 (final review M2): a source that failed on the selected day adds picked's state row under the header ("Couldn't load this month" or busy with Retry, calendars gone with Choose again), since the month's pill may be out of view.*
  - That list is written inline in `MonthPicked.tsx` today (`LiftableRow` + `ItemRow`). Pull it out as the shared day-list component.
  - Don't use `DayList.tsx`: that is the Agenda's multi-day list, whose rows deliberately never lift, which keeps the drag library out of the Agenda's code.
- **Row height:** no floor in the wide layout. On a sideways phone inside Telegram a 6-week month's rows come out about 30 px tall, but about 75 px wide. The owner saw this view in the prototype and called it "always perfect". It is listed in §9.
- **Selection:** a tap on a square selects that day and changes only the panel. Scrolling the months or pressing a chevron does **not** change the selection (as in the prototype the owner tried). Today selects today and scrolls to its month. The jump to a date scrolls to the picked day's month and selects it.
  - My call: this differs from today's picked, where changing month selects the 1st. With the list always on screen, a selection that jumps as you browse would make the list jump too.
- **Squares:** by size (§4). On a laptop they are large and show names.

## 3. The upright layout: the split

- **Structure, top to bottom:**
  - the month area: the same bar, weekday row and snapping scroller as the wide pane (§2), one component used by both layouts;
  - the handle: a full-width bar 22 px tall with a 36×5 px pill and a touch area of 8 px extra above and below; *amended 2026-11-26 (final review M1): 22 px below the bar only, 44 px in all, so it never covers the month's last week row;*
  - the day list (§2's side panel), which fills the rest and scrolls on its own.
- **Split heights** (`h` = the Month's height from §1; `chrome` = the bar plus the weekday row):
  - **Collapsed** (the default): the month area is 6 rows, each `max(44, min(round(cellWidth × 0.9), floor((h × 0.6 − chrome) / 6)))` px. That gives near-square cells, using at most 60% of the height. On a phone the squares come out small (dots). On an upright iPad they are big enough for names, so a tablet gets names and the day together. Because each month is one pane tall (decision 2), a 5-week month spreads its 5 rows over the same height. *Amended 2026-11-26 (owner, "go recommended"): at 60% an upright iPad's six-week months got 77 px rows, medium squares with dots. When the squares are wide enough for names (`round(cellWidth × 0.9) ≥ 82`), the rows grow to 82 px, a large square's least height, as long as the list keeps a fifth of the region (an iPad mini's region of about 770 px grows too); phones are untouched.*
  - **Grown:** the month area is `h − chrome − handle − 44` px, leaving a 44 px peek of the day list's top. The squares get taller and show names (§4). This replaces All months.
- **The handle's gestures:**
  - a tap (movement under 12 px) toggles collapsed and grown;
  - a drag down past 12 px grows; a drag up past 12 px shrinks;
  - it uses pointer events with pointer capture and `touch-action: none` on the handle only;
  - it is a `<button>` with `aria-expanded`, labelled "Show the month bigger" / "Show the month smaller" in he/en/ru (exact copy at build). Enter and Space toggle it.
- **While grown:**
  - a tap on a day selects it and collapses, so the person sees that day's list;
  - a tap on the peek collapses;
  - the peek doesn't scroll.
- **Motion:** the height change animates (about 200 ms) unless `prefers-reduced-motion` is set.
- **Memory:** collapsed or grown is kept per device under a new key, `famcal:monthLayout:v2:{userId}` (`'split' | 'grown'`), in try/catch. The old v1 value `'browse'` maps to grown and `'picked'` to split once. A new visit selects today.
- **BackButton:** not used for collapsed or grown, because there is no back step between them. It still closes sheets, and it still cancels a lift (editor upgrades §4).

## 4. Size-aware squares

One sizing rule, given the square's measured height `h` and width `w` in CSS px:

- **Small** (`h < 60` or `w < 44`): the Gregorian day, the Hebrew day (the month name on Hebrew day 1 and the month's first square, as today) and the dots. Dots are filled for yours and a ring for the partner's, in the calendar's colour, as in today's picked month, with "+N" past what fits.
- **Medium** (`h < 82`): as small, plus the holiday line.
- **Large** (otherwise): the head line, the holiday line, and as many event-name lines as fit: `k = clamp(1, 7, floor((h − used) / slot))`. Slot is 18 px, or 21 px in big squares. When more items exist than fit, the last slot is "+N", as today's browse (Plan E Rulings 3 and 13).
  - **Big text** when `w ≥ 110` and `h ≥ 100`.
  - Multi-day items are bars across days, placed first, named on the first day and at each week-row start, as today.
- Daily-repeating reminders stay out of squares, dots and "+N", as today (R11).
- The size is measured, not guessed from the layout. One `ResizeObserver` on the scroller, not one per square. It recomputes when the pane resizes, including during the split's height animation: settle on the final size, don't re-render every frame.
- **Drag to move** (editor upgrades §4) keeps working:
  - chips in large squares lift as browse chips do today;
  - list rows (the split's list and the wide panel) lift as picked's rows do today, and drop on any visible square;
  - the month bar's chevrons take a drop to change month, as picked's do today;
  - a drag on the split's handle is never an item drag.
- **Accessibility:** one button per square with the existing translated label (home spec §7.7), `aria-current="date"` on today and `aria-pressed` on the selected day. Chips and dots are `aria-hidden`.

## 5. Pop-ups on wide windows

- **The home's sheets only** (my call: the proposal was about the home). That means the item sheet, the send sheet, the menu, the date picker, the time picker, the repeat and scope sheets, and the zmanim sheet.
  - `components/app-ui/BottomSheet.tsx` is shared with Settings, Calendars, Select calendars, Pair, the admin panel and the public website's `SiteMenu`. It gets an opt-in prop that the home's sheets pass. Every other page keeps its drawers.
- **The rule is width alone** (my call): at `width ≥ 600 px` in any orientation, so an upright iPad gets cards too. "On a phone they stay drawers" is what the owner read.
  - Sheets become centred cards about 480 px wide, with a max height of about 85% of the viewport, scrolling inside.
  - The editor becomes a centred panel about 640 px wide. *Amended 2026-11-26 (final review M9): only when the window is also 521 px tall or more; a phone held sideways keeps the full-height editor.*
  - The Agenda becomes a centred column up to about 720 px.
  - The scrim and the close behaviour stay the same.
- Below 600 px wide, nothing changes.

## 6. Release 1: Daf Yomi

- **Setting:** a "Daf Yomi" switch in Settings, shown only when the calendar setting is Jewish (`User.culture === 'jewish'`). It is off by default.
  - It is a new column `User.dafYomi Boolean @default(false)` with a migration, saved through the existing `app/api/settings/route.ts`.
  - Switching culture away from Jewish hides the line and the switch, but keeps the stored value.
- **To the home:** page-data adds `dafYomi: true` to the home props only when the setting is on and the culture is Jewish (next to `jewish`, `src/lib/calendar-view/home-props.ts`).
- **The source:** `@hebcal/learning`, pinned to exactly `6.13.1` (no caret; published 2026-11-01; 6.13.2 of 2026-11-15 is under two weeks old). Its dependencies (`@hebcal/core ^6.14.7`, `@hebcal/hdate ^0.23.1`, `quick-lru ^7.3.0`) are all met by the versions the repo already has (6.16.0, 0.23.1, 7.3.0), so the install adds no second copy; the builder confirms with `npm ls @hebcal/core`. `@hebcal/core` 6.16 has no Daf Yomi of its own (checked 2026-11-19).
  - It is computed in the browser from the day key, as the Hebrew dates are.
  - The browser imports only the subpaths that need nothing but `@hebcal/hdate`, which the home already loads: `@hebcal/learning/dafYomiBase` and its `DafPage`. Never the package's main entry, which imports `@hebcal/core`, kept out of the browser on purpose (`hebrew-date.ts`, `holidays-client.ts`, `picker-model.ts`).
  - The budget is about 15 KB gzipped added to the home's chunk; the builder measures it. Over budget, the range answer carries the day's daf instead.
  - Either way, there is one function from a day to its daf, used by every place that shows it.
- **Wording:** one line: a lucide `BookOpen` icon, then "Daf Yomi · <tractate> <page>".
  - Hebrew: "דף יומי · ברכות י״ב", with the page in gematriya.
  - English: "Daf Yomi · Berachot 12".
  - Russian: "Даф йоми · Брахот 12".
  - We write "Daf Yomi" ourselves in each language (i18n keys).
  - Tractate names come from FamCal's own table, in all three languages (owner, 2026-11-20: "small fixed lists that we can manage locally"), never from hebcal's translation files. hebcal only says which tractate and page (`DafPage.getName()`, `getBlatt()`); its English name is the table's key. The table's wording is the owner's review of the translation list (2026-11-20).
    - Why not hebcal's: its Russian translates four names into words ("Благословения" for Berachot, "Яйцо" for Beitzah, "Пост" for Taanit, "Свиток" for Megillah), and in the browser its Hebrew lacks Shabbat and Rosh Hashana (they live only in `@hebcal/core`, which the browser doesn't load), so they would show in English.
  - hebcal's `DafPage.render('he')` gives "ברכות דף י״ב". The line formats the name and the gematriya itself, so "דף" is not said twice.
- **Where it shows:**
  - under the day header of the selected day's list (today's picked list in release 1, the split list and the wide panel from release 2);
  - under each Agenda day header. Empty days that fold into one line ("Nothing planned Sat 17 – Sun 18") stay folded, without a daf (my call: the line is quiet and doesn't unfold days).
  - Nowhere else (non-goals).
  - It is muted, like the holiday line, and never pushes a row's actions.
- **Tests:** the day-to-daf function on known dates, including a cycle boundary; the setting's gate (shown only when Jewish, and the stored value kept across a culture switch); the name table covering, in all three languages, every tractate name hebcal can return (its 40 `bavli.json` keys).

## 7. Release 3: Hebrew months

- *Built 2026-11-27 as one "א" toggle (owner's answer to the plan, see Status).* A "Gregorian | Hebrew" switch on the Month's bar, in the empty space across from the month's name, beside Today when Today shows (owner 2026-11-26; it was a Menu row). Option A's wording stays for its two choices, and "Months" becomes its accessible name. It shows only for the Jewish calendar (Claude's call: with Hebrew dates off there is nothing Hebrew to switch to). It is saved on the account (new column `User.monthMode String @default("gregorian")`, `'gregorian' | 'hebrew'`), so the phone and the laptop match.
- In Hebrew mode:
  - each month pane is a Hebrew month, Tishrei to Elul, with Adar I and Adar II in leap years;
  - the big number is the Hebrew day in gematriya, with the Gregorian date small and the Gregorian month's name on its 1st;
  - the bar reads the Hebrew month and year ("כסלו תשפ״ז") over the Gregorian range ("נובמבר – דצמבר 2026");
  - scrolling, the chevrons, Today, the jump to a date (which already has Hebrew wheels) and drag's month change all follow Hebrew months;
  - the per-month fetch asks for the Gregorian days the Hebrew month covers.
- The reach stays January 1900 … December 2100. In Hebrew mode the first and last months are the Hebrew months that contain those ends.
- Week start, the Agenda and the day list are unchanged.
- Release 3 gets its own short plan when release 2 is live. This section is its brief.

## 8. Copy and i18n

All new copy goes in `messages/{he,en,ru}.json` under the home's existing namespaces: the handle's labels, the Daf Yomi label and setting, the Months row, and the tractate names (FamCal's own he/en/ru table, §6). The Russian Hebrew month names for release 3 are hebcal's standard ones (amended 2026-11-27, see Status). Hebrew is gender-neutral, Russian formal and natural. Lucide icons only.

## 9. Accepted limitations

- On a small upright phone (iPhone SE size, 375×667), the collapsed split's list shows about two events before it scrolls. The owner saw this on the proposal page.
- The names view is one handle-drag away instead of first.
- On Telegram clients older than Bot API 7.7, a pull down at the top of a scroller can close the app (no `disableVerticalSwipes`).
- On a sideways phone, a 6-week month's squares are about 30 px tall (§2): dots only, wide enough to tap.
- On a small upright phone with banners showing, the banners sit at the top of the list, so the day's first row may need a scroll (§1).

## 10. Testing

- Unit tests for the pure parts: the layout rule, the split heights, the sizing rule, the selection rules, the v1 → v2 memory mapping, and Hebrew-month spans (release 3).
- A browser check in the existing smoke style (puppeteer on a built page, fake env) for:
  - 390×844 upright, 375×667 upright, 844×390 sideways, 820×1180 iPad upright and 1280×800 laptop;
  - no horizontal overflow and no document scroll on the Month tab;
  - the month's top staying still while the list scrolls;
  - the handle's tap and drag;
  - a tap while grown;
  - Hebrew RTL mirroring.
- Never call the real Telegram API in tests.

## Left to the builder

- Component boundaries. One month-pane component serves the wide pane and the split's month area. Today's `MonthBrowse` and `MonthPicked` are replaced, and their shared pieces (cells, chips, dots, the span logic in `grid.ts`, the per-month fetch `wantedMonths`, drag) are reused, not copied. `MonthBrowse`'s scroll code works on the page's scroll, so it is rewritten for the inner scroller rather than reused.
- Exact transition timing, the handle's visual weight (follow the existing tokens) and the short header's exact CSS.
- Whether the 600 px threshold uses CSS media queries, JS, or both. The rule in §1 is fixed.

## Prototype

The owner reviewed the clickable prototype and screenshots on 2026-11-19 (the private proposal page). The session's prototype source, which is not committed, is `scratchpad/wide-mock/proto.src.html`. The numbers above are taken from it.

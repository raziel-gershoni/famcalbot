# Calendar Home, Plan D: Home and Agenda — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Mini App's calendar home for the users the rollout switch covers, with no tab bar (R19). It has a header with the Send sheet and the ⋯ menu, its banners, the Agenda (today, tomorrow and the week, the still-open card, the item sheet) and Hebrew dates. It reads Plan B's `GET /api/calendar/range`. Users the switch doesn't cover keep today's dashboard, apart from the spec §9 string fixes, the preloaded chunk and the messages payload named below. The switch stays `OFF` on deploy.

**Architecture:**
- Pure client modules live under `src/lib/calendar-view/`:
  - `hebrew-date.ts` on `@hebcal/hdate` (D2);
  - the store and the Agenda model, `store.ts` and `agenda.ts` (D3);
  - `format.ts`, `home-props.ts` (type-only), `home-client.ts`, `home-loader.ts` and `reload-guard.ts` (D5/D6).
- The Telegram glue is `src/lib/telegram-ui.ts` (BackButton, theme, links), and the send-to-chat call is `src/lib/command-client.ts` (D4).
- The view is `app/[locale]/dashboard/AgendaView.tsx` with its rows, sheets and cards (D5), inside the container `CalendarHome.tsx` with its header, sheets, banners and error boundary (D6).
- `src/lib/page-data.ts` asks the switch. `app/[locale]/PageGate.tsx` renders `CalendarHome` when the switch covers the user, else today's `DashboardClient` (D7).

**Tech Stack:** Next.js 16.1 (app router, `next/dynamic`) · React 19 · TypeScript · next-intl (en, he, ru; ICU plurals) · Telegram Web App 6.1+ APIs (gated) · `@hebcal/hdate` 0.21 · `Intl` · tsx smoke scripts with `react-dom/server` and real React rendering.

**Spec:** `docs/superpowers/specs/2026-10-16-calendar-home-design.md`:
- §5 (data flow and states);
- §7.1–§7.3 and §7.5–§7.7, with the Agenda only and no tab bar (R19);
- §7.8's library and day format;
- §9's home copy and string fixes;
- §10's Plan D smokes.

This is the fourth of the spec's five delivery plans (A → B → C ∥ D → E). It starts from `feat/calendar-home` after Plan C, once Plans A, B and C are on `main` (C by its Task 7's fast-forward, which brought `main` to the branch's 6dab367 on 2026-10-17; Ruling 9). Before Task 1, `git log --oneline main..feat/calendar-home` lists at most the commit that adds this plan. The approved mockups (layout A with the Send icon and ⋯ menu; the Send sheet; the menu; Hebrew RTL; dark) are the visual reference.

## Global Constraints

- The repo is PUBLIC. Never commit, print or hardcode secrets. Never read or print `.env*` files. Production is read-only; never call `/api/health`.
- **No test runner.** Tests are `tsx` smoke scripts in `scripts/`, printing `N/N passed` and exiting non-zero on failure. They stub through `require.cache` (and `Module.registerHooks` for `import()`), never touch the real DB, Redis, Google, Telegram or AI, and must type-check (`next build` type-checks `scripts/**`). Render smokes use `react-dom/server` (the `smoke-miniapp-gate.ts` pattern) and real React with a fake DOM where a step says so.
- **Every smoke run fakes every `.env` name first.** Use this prefix, with `TZ=Asia/Jerusalem` runs, and `TZ=Pacific/Kiritimati` (or `America/Los_Angeles`) runs where a step says so:
  ```bash
  TZ=UTC DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/<name>.ts; echo "exit $?"
  ```
- No schema change. Never run `prisma migrate dev`, `migrate deploy` or `db push` locally. D2's dependency step runs the real `npm install @hebcal/hdate@^0.21.1 --no-audit --no-fund`: never `--package-lock-only`, which rewrites unrelated lock entries.
- Every commit passes `npx tsc --noEmit -p .` and `npm run -s lint`, and its message ends with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
  ```
- Work on branch `feat/calendar-home`. Never push to `main` from a task, and never force-push. Task 8 (the controller) lands the plan.
- **The switch stays `OFF`.** Today's `DashboardClient` renders for everyone the switch doesn't cover, with exactly the props it gets today: PageGate strips `calendarHome` and `hints`. The hint checks and `webapp_opened` run only when the switch is on.
- **Client-safe imports:** client code imports `WeekStart` and every DTO type only from `src/lib/calendar-view/types.ts`, never from `src/utils/locale-rules.ts`, which is server-only and pulls in the zone table. `home-props.ts` and `reload-guard.ts` import nothing from the home, so PageGate's chunk never carries the home's code.
- **Mobile Mini App:**
  - no hover; every touch target is at least 44 px; no text under 11 px; zoom is locked;
  - document scroll and safe areas;
  - RTL for Hebrew;
  - times through `Intl` with `hourCycle: 'h23'`;
  - every Telegram call is gated with `isVersionAtLeast` and wrapped in try/catch.
- Translations sound natural and gender-neutral in each language, not literal.
- Never serialize the user row. Never refactor Telegram flows to swap `user.id` and `telegramId`. WhatsApp is secondary: in a browser the Send sheet's result is "Sent to WhatsApp" and the app stays open.
- **Fixed values:** the range request timeout is 15,000 ms (`RANGE_TIMEOUT_MS`). One stale re-request goes out about 3 s after a stale answer, per window. The Agenda is today plus 6 days, extended by 7 ("Show next week"). The still-open card shows 5 items (`STILL_OPEN_SHOWN`), then "N more". A chunk-load or `not_enabled` reload happens at most once per 60 s per guard key (`reloadOnce`).

## Review Focus

The five inputs most worth a reviewer's eye, most likely first. Each names the task that owns it and the check that pins it.

1. **A Google user who connected but hasn't chosen calendars** (every Google user on their first open; `needsCalendars` true, and the route answers `google: ok` with seven empty days, spec §2.5 step 2) sees the "Choose your calendars" banner and nothing under it: no "Nothing planned", no how-to-add hint, no fold line, no placeholders, no "Show next week". Before connecting (`needsOAuth`, the route answers `reconnect`), the "Connect Google Calendar" banner the same way, never Reconnect. The banner opens select-calendars (or `/refresh-token`) with the page's `user_id`. Pinned by D6, `smoke-calendar-home-render` #38 (en, he, and the Connect case through the container), and D5's #11 (AgendaView with `setupNeeded`, en/he/ru).
2. **The app minimized overnight and reopened** (iOS suspends timers, so the first `activated` or `visibilitychange` comes before the late midnight timer; clock moved from Thursday 21:00 to Friday 07:00 in Israel without running it) drops the store at once and sends one no-dates request, never yesterday's `[10-15, 10-22)` window; until it answers the home shows placeholders, never Thursday as "Today"; then the header reads "Friday, 16 October" and Today shows Friday's items, and the overdue timer resets nothing. A device clock ahead of the server resets once, then only refetches. Init data over a day old answers 401 and the home shows PageGate's "open this from the bot" card, asking nothing more (the intended behaviour: the Mini App can't refresh its own init data). Pinned by D6, `smoke-calendar-home-render` #39.
3. **Android's back gesture (or Telegram's BackButton) with the Send sheet, the ⋯ menu or the item sheet open** closes only that sheet: the button shows (`onClick`, `show()`) when a sheet opens, a tap closes it, then `offClick` and `hide()`, focus goes back where it was, and the home stays. A store drop with the item sheet open closes it for good and lets the button go. Spec §7.6 names only the item sheet; this follows Plan E's single call at the container and needs the owner's nod. Pinned by D6, `smoke-calendar-home-render` #37 (and D5's #16: AgendaView itself never touches the button). Device-check line: Android back with each sheet open.
4. **A range request that never settles** (a mobile network handover, iOS suspending the webview mid-request) is aborted after 15 s (`RANGE_TIMEOUT_MS`, on the deps' timer) and reads as no answer: before any answer, the retry card at 20 s, and the next return to the foreground sends a second request; once the facts are pinned, a hung refetch no longer dedupes the next return's request, and the data on screen stays. Pinned by D6, `smoke-calendar-home-render` #36.
5. **The switch turned back mid-session with the item sheet open** (say, after "Open in Google Calendar" and a return to the app): the foreground refetch answers 404 `not_enabled`, and `BackButton.offClick` and `hide()` run before `location.reload()`, so today's dashboard after the reload shows no back button that does nothing. Pinned by D6, `smoke-calendar-home-render` #28 (its added case). A chunk-load reload lets the button go the same way (`HomeErrorBoundary`), and PageGate's own boundary around the home's chunk is D7's `smoke-calendar-home-render` #40 and `smoke-miniapp-gate` #20.

## Planning Rulings

Decided while drafting, integrating and reviewing, and by the controller on the points the drafts left to the owner. The spec is updated to match (§7.2, §7.6) in the commit that adds this plan. Executors treat these as binding.

1. **BackButton covers every sheet** (D6). Telegram's BackButton shows while the item sheet, the Send sheet or the ⋯ menu is open, and a tap closes the sheet on top. *Why:* with the button on the item sheet only, Android's back gesture on the Send sheet or menu closes the whole Mini App. Plan E's single call at the container does the same. Spec §7.6 is widened to say so. *If wrong:* back closes a sheet where the owner expected it to leave the app.
2. **The setup banners** (D6; spec §7.2). The "existing Google setup card" is two banners: "Connect Google Calendar" while `needsOAuth`, and "Choose your calendars" while `needsCalendars`. While either shows, the Agenda shows nothing under it: no "Nothing planned", no hints, no fold line, no placeholders (`setupNeeded`). *Why:* a new Google user's empty answer is not an empty calendar. *If wrong:* copy only.
3. **The location banner shows only when the server can't know the timezone** (D6): no location and no Google token. *Why:* a Google user's timezone comes from Google, so asking for a location there is noise. *If wrong:* some users never see a prompt to add a location.
4. **The Send sheet's week lines are text, not dates** (D1). "Coming up this week" and "Coming up next week" replace the mockup's date ranges. The subtitle is "FamCal sends it to your chat". *Why:* the dates need the bot's week rule, including `lookaheadAlways7Days`, which the home doesn't receive. Plan E can add the dates with the Month's week facts. *If wrong:* a small departure from the approved mockup, listed for the owner.
5. **No "Couldn't refresh" row** (D3; spec §5 "Empty means answered"). A refetch that fails over earlier ok data keeps that data and shows no state row. The next return to the foreground or ⋯ → Refresh asks again, and the 15 s request limit means a hung refetch can't block that. *If wrong:* data hours old shows with nothing to say so; a row needs new copy in three languages.
6. **English dates are day-first, as in the mockups** (D5): "Thursday, 15 October", "Sat 17 – Sun 18 Oct". Hebrew uses the mockup's short weekday ("חמישי 15 באוק׳"). `formatDayRange` names a shared month once.
7. **The theme maps Telegram's tokens onto `globals.css`'s** (D5; spec §7.1): `var(--tg-theme-…, var(--globals-token))`. The mockups' shades are used only where `globals.css` has no token. `html:has(.ch-home)` takes the theme's background, so iOS's bounce shows no white canvas in dark mode.
8. **What everyone gets, whatever the switch says** (D7), named in the landing report:
   - the home's chunk is preloaded on every dashboard open (about 67 KB, 19.5 KB gzipped);
   - the `calendarHome` messages reach every page's payload (about 4.3/5.5/6.8 KB for en/he/ru), because the layout sends every namespace to every page;
   - PageGate's boundary is in place;
   - §9's string fixes apply (the Header aria-labels, "ADMIN", "Free", the dashboard loader).
9. **D was drafted on a scratch base and rebased** onto `feat/calendar-home` after Plan C. The first pass (the drafts, the integration, the review patch and every mutation run) ran on `wt/B-int` 63e7d4f (main + Plans A and B), which lacks Plan B's follow-ups (the linear `htmlToText`, the voice-dates stub, Plan B's doc) and all of Plan C. Of the files D1–D7 touch, only `messages/*.json` differ on the real branch (the spec differs too, at §2.5 item 8, but D's own spec edits, made in the commit that adds this plan, are at §7.2 and §7.6): Plan C adds its two `bot.errors` keys (`googleUnreachable`, `googleOutageNote`, `:511-512`), far below D1's two spots. D touches none of C's other files. The real base was verified in two states:
   - **2eb69df**, Plan C's reference chain on 716a4f8 (its Tasks 1–6, without the plan docs). D1–D7's diffs apply with no conflict, every Before block matches once, and replaying the texts in order reproduces the reference chain byte for byte. The task texts' counts (i18n parity 887 → 996 keys; `smoke-calendar-home-rollout` 35/35), results and line numbers are this chain's.
   - **6dab367**, the branch after Plan C, which its Task 7 fast-forwarded `main` to on 2026-10-17. Plan C's execution went past the reference chain: 8877ead moves the token, permissions and outage answers of the daily summary, /week and /nextweek into a new `src/services/telegram/google-read-errors.ts`, changing `commands.ts` and `summary.ts` and adding a comment to `smoke-week-commands.ts`; 13262a8 changes `smoke-google-map.ts`'s timing shapes, and 6dab367 lets `smoke-digest-reader-parity.ts`'s virtual clock wait longer for a timer (for Node 22). D touches none of these files, and `messages/*.json` are the same. There too every diff applies with no conflict, every Before block matches once, and each replayed task gives its reference tree plus those files. Each task's before, after and regression runs, `tsc` and lint print the same lines as on 2eb69df, and so does the whole suite at Task 7.

   Every line number the texts cite is the same in both states but one, in Plan C's `summary.ts`: `isOwn` and `isSpouse` sit at `:76-79` on 2eb69df and at `:77-80` from 8877ead on (D3 gives both). If the branch has moved past 6dab367 when this plan runs, check that the files D edits haven't changed: `git diff --stat 6dab367 feat/calendar-home -- messages package.json package-lock.json scripts/check-i18n-parity.ts scripts/smoke-page-auth.ts scripts/smoke-miniapp-gate.ts components/Layout/Header.tsx 'app/[locale]/PageGate.tsx' 'app/[locale]/dashboard/DashboardClient.tsx' 'app/[locale]/dashboard/TelegramDashboardRedirect.tsx' src/lib/page-data.ts src/types/telegram-webapp.d.ts` prints nothing. A file it prints gets its task's Before blocks checked against it before that task runs. A line cited in Plan C's files is found by the name next to it.
10. **No PR.** The plan lands by fast-forward (Task 8). D7's "For the PR" list goes into the landing report. The device check (spec §10: real Telegram on iOS and Android, light and dark, he RTL, Android back with each sheet) goes to the owner when the switch is set to `ADMINS`.

## File Structure

| File | Task | Change |
|---|---|---|
| `messages/{en,he,ru}.json`, `scripts/check-i18n-parity.ts`, `components/Layout/Header.tsx`, `app/[locale]/dashboard/{DashboardClient,TelegramDashboardRedirect}.tsx` | 1 | The `calendarHome` namespace and the §9 string fixes; parity also checks ICU arguments and plurals |
| `src/lib/calendar-view/hebrew-date.ts` (new), `package.json`, `package-lock.json` | 2 | Hebrew dates on `@hebcal/hdate` |
| `src/lib/calendar-view/store.ts`, `agenda.ts` (new) | 3 | The store and the Agenda model |
| `src/types/telegram-webapp.d.ts`, `src/lib/telegram-ui.ts` (new), `src/lib/command-client.ts` (new) | 4 | Telegram glue; the send-to-chat call |
| `app/[locale]/dashboard/{AgendaView,DayList,ItemRow,ItemSheet,StillOpenCard,BottomSheet}.tsx`, `home-theme.ts` (new); `src/lib/calendar-view/{format,home-props}.ts` (new) | 5 | The Agenda view |
| `app/[locale]/dashboard/{CalendarHome,HomeHeader,SendSheet,MenuSheet,HomeBanners,HomeErrorBoundary}.tsx`, `home-shell.ts` (new); `src/lib/calendar-view/{home-client,home-loader,reload-guard}.ts` (new); `src/lib/calendar-view/home-props.ts` (D5's), `src/lib/telegram-ui.ts` (D4's) | 6 | The container; the props' two optional fields and the BackButton's release |
| `src/lib/page-data.ts`, `app/[locale]/PageGate.tsx` | 7 | The switch, the hints, `CalendarHome` or `DashboardClient`, the chunk boundary |
| `scripts/smoke-calendar-home-copy.ts`, `smoke-hebrew-date.ts`, `smoke-calendar-agenda.ts`, `smoke-command-client.ts`, `smoke-telegram-ui.ts`, `smoke-calendar-home-render.ts` (all new) | 1–7 | One per module; the render smoke grows in 5, 6 and 7 |
| `scripts/smoke-page-auth.ts`, `smoke-miniapp-gate.ts` | 7 | The dashboard branch |

Tasks run in order 1 → 8. Each later task consumes the modules of earlier ones (each task's **Interfaces** block names them), and every task's line numbers are those of the real base (`feat/calendar-home` after Plan C, in the states Ruling 9 names) with the tasks before it landed, unless the task names another state. Inside the tasks, cross-references use the draft names: D*N* is Task *N* (D1 is Task 1, …, D7 is Task 7).

---

### Task 1 (D1): Copy (the calendarHome namespace, §9's string fixes, ICU parity)

> **Interface change versus the split: none.** The split's names stand. Additions the later tasks rely on:
> - **The Keys table below is the contract.** `scripts/smoke-calendar-home-copy.ts` holds the same list (`KEYS`) and fails when a language misses a key or has one more. A task that needs a new string adds it to all three files **and** to `KEYS`. Plan E will do this for the tabs and Month.
> - Two shared groups that the split doesn't name: `calendarHome.actions.*` (Retry, Choose again, Close, Reload) and `calendarHome.shell.*` (the loading text, "Times in {zone}").
> - `calendarHome.hebrewMonthGenitive` follows the order Task D2's draft fixes in its `HEBREW_MONTHS` export: the year from Tishrei, with a common year's Adar before a leap year's Adar I and Adar II. The Russian list is the one D2's box gives, entry for entry. See "The genitive list" below.
> - §9's fixes add `common.header.back|settings|adminPanel|adminBadge`. They reuse two keys that already exist: `subscription.plans.free.name` for "Free", and `pageGate.loading` for "Loading Dashboard...".
> - `scripts/check-i18n-parity.ts` takes an optional messages directory. It is also stricter: a message must be valid ICU, every select needs an `other` form, and every plural needs each form its language uses.
> - **For D6 and D7 to settle (not changed here):** the split's `CalendarHomeProps` carries neither trial days nor a location. So `banner.trial` and `banner.location` (spec §7.2) have no data behind them. One way: add `trialDaysLeft: number | null` and `hasLocation: boolean` to the props; page-data already has both (`trial`, `user.location`). The copy is ready either way.

**What and why:** The new home needs all its words in en, he and ru before D5 and D6 render anything, and D2–D7 are drafted in parallel. So this task fixes every key name now, in one table. The copy is natural in each language rather than translated word for word. Where it addresses the reader or names a person it is gender-neutral: Hebrew uses infinitives, impersonal plural and nouns; Russian uses "вы" (as `pageGate` does) and keeps names in the nominative ("От: Маша", "Кому: Маша", like the bot's `кому: {name}`). Counts are ICU plurals with every form each language needs (Russian one/few/many, Hebrew one/two/other).

Three smaller pieces ship with it:
- **Spec §9's string fixes, visible to everyone whatever the switch says** (Plan D's Delivery row): the Header's aria-labels and its "ADMIN" badge (`components/Layout/Header.tsx`, used by the old home, Subscription and Select calendars), "Free" on the old home's plan badge (`DashboardClient.tsx:752`), and the dashboard loader's "Loading Dashboard..." (`TelegramDashboardRedirect.tsx:91`).
- **`check-i18n-parity` compares ICU arguments** (spec §9), nested ones included. Until now it matched only `{word}`, so `{count, plural, …}` and anything inside a plural's forms went unchecked.
- **`calendarHome` is its own top-level object**, right after `dashboard` and before `admin`. That keeps it away from the `bot.errors` keys Plan C added (`googleUnreachable` and `googleOutageNote`, `:511-512` on the real base), so the two plans never edit neighbouring lines.

Nothing reads `calendarHome` yet. The switch ships `OFF`, and the only visible change is the translated Header, loader and badge.

**Files:**
- Modify: `messages/en.json`, `messages/he.json`, `messages/ru.json`. Two spots each, at the same line numbers in all three (the real base's):
  - after `:16` (`"no": …`, the last key of `common`, which spans `:2-17`): `common.header`;
  - between `:70` (the `},` that closes `dashboard`) and `:71` (`"admin": {`): the new top-level `calendarHome` object.
- Modify: `scripts/check-i18n-parity.ts:1-61` (the whole file is replaced).
- Modify: `components/Layout/Header.tsx` at `:1` (import), `:25` (translator), `:81` (badge CSS), `:109`, `:118`, `:124`, `:133`.
- Modify: `app/[locale]/dashboard/TelegramDashboardRedirect.tsx` at `:4-5` (import), `:17` (translator), `:91` (the heading).
- Modify: `app/[locale]/dashboard/DashboardClient.tsx:752` (the Free badge). Nothing else in that file changes; `:105-137`, the send call D4 copies, stays as it is.
- Test (create): `scripts/smoke-calendar-home-copy.ts`.

**Interfaces:**
- Consumes:
  - `next-intl` 4.6.1: `useTranslations` (Header, the loader), `createTranslator` and `NextIntlClientProvider` (the smoke);
  - the existing keys `pageGate.loading` (Loading… / בטעינה… / Загрузка…) and `subscription.plans.free.name` (Free / חינם / Бесплатный);
  - `tsx/cli`: the smoke runs the parity script in a child process.
- Produces (messages):
  - `calendarHome.*`: the Keys table below;
  - `common.header.back`, `common.header.settings`, `common.header.adminPanel`, `common.header.adminBadge`.
- Produces (how D5 and D6 read the copy):
  ```ts
  const t = useTranslations('calendarHome');
  t('agenda.today');                                   // "Today"
  t('stillOpen.count', { count: 3 });                  // "3 reminders" / "3 תזכורות" / "3 напоминания"
  t('stillOpen.sinceWeekday', { weekday: 'tue' });     // "Since Tuesday" / "מיום שלישי" / "Со вторника"
  t('person.from', { name: partnerName });             // "From Noa" / "מאת נועה" / "От: Noa"
  const genitive = t.raw('hebrewMonthGenitive') as string[];   // 14 names; D2's genitive argument
  ```
- Produces (`scripts/check-i18n-parity.ts`): `npx tsx scripts/check-i18n-parity.ts [messages-dir]`, the directory defaulting to `messages/`. It prints one line per problem, then `i18n parity FAILED (N problems)` with exit 1, or `i18n parity OK (N keys)` with exit 0. The problem lines are:
  - `<locale>: missing <key>` (as before);
  - `<locale>: <key> has arguments [<names>], en has [<names>]` (was `has placeholders`);
  - `<locale>: <key> is not valid ICU: <reason> (at character <n>)`;
  - `<locale>: <key> {<arg>, select} has no "other" form`;
  - `<locale>: <key> {<arg>, plural} lacks the "<form>" form`;
  - `<locale>: <key> {<arg>, plural} has a "<form>" form, which <locale> never uses`.

**Keys** (D2–D7 use these names verbatim; the full he and ru text is in Steps 7 and 8):

**HomeHeader (D6)**

| Key (`calendarHome.` +) | Args | English | Used by | When / notes |
|---|---|---|---|---|
| `header.send` | — | Send to chat | D6 HomeHeader | aria-label of the Send icon button |
| `header.menu` | — | Menu | D6 HomeHeader, MenuSheet | aria-label of the ⋯ button, and the menu sheet's dialog label |

**SendSheet (D6), results per Ruling R5**

| Key (`calendarHome.` +) | Args | English | Used by | When / notes |
|---|---|---|---|---|
| `send.title` | — | Send to chat | D6 SendSheet | sheet heading and its dialog label |
| `send.subtitle` | — | FamCal sends it to your chat | D6 SendSheet | line under the heading |
| `send.today` | — | Today’s summary | D6 SendSheet | option; command `summary` |
| `send.todayHint` | — | Events and reminders for today | D6 SendSheet | second line of that option |
| `send.tomorrow` | — | Tomorrow’s summary | D6 SendSheet | option; command `summary`, args `tmrw` |
| `send.tomorrowHint` | — | What’s coming up tomorrow | D6 SendSheet | second line |
| `send.thisWeek` | — | This week | D6 SendSheet | option; command `lookahead` |
| `send.thisWeekHint` | — | Coming up this week | D6 SendSheet | second line |
| `send.nextWeek` | — | Next week | D6 SendSheet | option; command `nextweek` |
| `send.nextWeekHint` | — | Coming up next week | D6 SendSheet | second line |
| `send.weather` | — | Weather | D6 SendSheet | option; command `weather` |
| `send.weatherHint` | — | Today’s forecast | D6 SendSheet | second line |
| `send.sending` | — | Sending… | D6 SendSheet | label/aria of the option whose call is in flight (D4) |
| `send.sent` | — | Sent. Check your chat | D6 SendSheet | Telegram 2xx when `close()` is missing or throws (R5) |
| `send.sentWhatsApp` | — | Sent to WhatsApp | D6 SendSheet | browser (no init data) 2xx (R5) |
| `send.busy` | — | Lots of requests right now. Try again in a minute. | D6 SendSheet | 429 (R5) |
| `send.failed` | — | Couldn’t send it. Try again. | D6 SendSheet | any other non-2xx |
| `send.signedOut` | — | Please reopen FamCal from the chat and try again. | D6 SendSheet | 401 or 403 |
| `send.offline` | — | No connection. Check your internet and try again. | D6 SendSheet | the fetch threw (no response) |

**MenuSheet (D6), Ruling R6**

| Key (`calendarHome.` +) | Args | English | Used by | When / notes |
|---|---|---|---|---|
| `menu.settings` | — | Settings | D6 MenuSheet | everyone (R6) |
| `menu.calendars` | — | Calendars | D6 MenuSheet | FamCal users only (R6) → `/calendars` |
| `menu.partner` | — | Partner | D6 MenuSheet | FamCal users only (R6) → `/pair` |
| `menu.chooseCalendars` | — | Choose calendars | D6 MenuSheet | Google users only (R6) → `/select-calendars` |
| `menu.reconnectGoogle` | — | Reconnect Google | D6 MenuSheet | Google users only (R6) → `/refresh-token` |
| `menu.subscription` | — | Subscription | D6 MenuSheet | everyone |
| `menu.refresh` | — | Refresh | D6 MenuSheet | everyone; `fresh=1` on every visible window |
| `menu.feedback` | — | Feedback | D6 MenuSheet | everyone → `/feedback` |
| `menu.admin` | — | Admin panel | D6 MenuSheet | admins only → `/admin-panel` |

**HomeBanners (D6), spec §7.2 and §5**

| Key (`calendarHome.` +) | Args | English | Used by | When / notes |
|---|---|---|---|---|
| `banner.trial` | `count` | {count, plural, one {# day left in your trial} other {# days left in your trial}} | D6 HomeBanners | during a trial; `count` = days left (number) |
| `banner.trialAction` | — | See plans | D6 HomeBanners | the trial banner's button → `/subscription` |
| `banner.location` | — | Set your location for the right times | D6 HomeBanners | no location set |
| `banner.locationAction` | — | Set location | D6 HomeBanners | its button → `/settings` |
| `banner.connectGoogle` | — | Connect Google Calendar | D6 HomeBanners | Google user with no token (`needsOAuth`): title |
| `banner.connectGoogleBody` | — | Your calendar shows up here once it’s connected. | D6 HomeBanners | its body; tap → `/refresh-token` |
| `banner.chooseCalendars` | — | Choose your calendars | D6 HomeBanners | Google user with no calendars chosen (`needsCalendars`): title; the old setup card's job |
| `banner.chooseCalendarsBody` | — | Pick the Google calendars to show here and in your summaries. | D6 HomeBanners | its body; tap → `/select-calendars` |
| `banner.reconnect` | — | Your Google connection expired | D6 HomeBanners | Google `reconnect`, reason `token`: title |
| `banner.reconnectBody` | — | Reconnect to see your Google calendar here again. | D6 HomeBanners | its body |
| `banner.reconnectScopes` | — | FamCal needs permission to read your calendar | D6 HomeBanners | Google `reconnect`, reason `scopes`: title (§5: says FamCal needs permission) |
| `banner.reconnectScopesBody` | — | Reconnect Google and allow access to your calendar. | D6 HomeBanners | its body |
| `banner.reconnectAction` | — | Reconnect Google | D6 HomeBanners | button of both reconnect banners → `/refresh-token` |
| `banner.openInTelegram` | — | Open FamCal in Telegram | D6 HomeBanners | in a browser (`readInitData() === ''`): title and link text |
| `banner.openInTelegramBody` | — | Reminders, voice summaries and more are waiting there. | D6 HomeBanners | its body |

**§5 state rows (D5 above the days, D6 for route answers) and the retry card**

| Key (`calendarHome.` +) | Args | English | Used by | When / notes |
|---|---|---|---|---|
| `state.partial` | — | Some calendars didn’t load | D5 AgendaView / D6 | Google `partial.failed` or `partial.truncated`; with `actions.retry` |
| `state.unavailable` | `count` | {count, plural, one {# calendar isn’t available} other {# calendars aren’t available}} | D5 AgendaView / D6 | N chosen calendars `unavailable`; `count` = N; with `actions.chooseAgain` |
| `state.googleError` | — | Couldn’t load Google Calendar | D5 AgendaView / D6 | Google `error` (transient, timeout, config, unknown); with `actions.retry` |
| `state.calendarsGone` | — | Your calendars aren’t available | D5 AgendaView / D6 | Google `error('calendars_gone')`; with `actions.chooseAgain` |
| `state.famcalError` | — | Couldn’t load your calendar | D5 AgendaView / D6 | FamCal `error`; with `actions.retry` |
| `state.busy` | — | Busy right now, try again in a minute | D6 | a 429 from the range route (or the limiter down) |
| `state.errorTitle` | — | Something went wrong | D6 | the retry card (500 / unexpected): title |
| `state.errorBody` | — | Your calendar didn’t load. Try again. | D6 | the retry card: body; with `actions.retry` |

**Shared buttons**

| Key (`calendarHome.` +) | Args | English | Used by | When / notes |
|---|---|---|---|---|
| `actions.retry` | — | Retry | D5, D6 | button on the state rows and the retry card |
| `actions.chooseAgain` | — | Choose again | D5, D6 | button → `/select-calendars` |
| `actions.close` | — | Close | D5 ItemSheet, D6 sheets | the in-page close button of every sheet (the browser's stand-in for BackButton) |
| `actions.reload` | — | Reload | D6 HomeErrorBoundary | the boundary's button |

**HomeErrorBoundary (D6)**

| Key (`calendarHome.` +) | Args | English | Used by | When / notes |
|---|---|---|---|---|
| `errorBoundary.title` | — | Something went wrong | D6 HomeErrorBoundary | title |
| `errorBoundary.body` | — | The calendar ran into a problem. Reloading usually fixes it. | D6 HomeErrorBoundary | body |

**CalendarHome shell (D6), spec §7.1**

| Key (`calendarHome.` +) | Args | English | Used by | When / notes |
|---|---|---|---|---|
| `shell.loading` | — | Loading your calendar… | D5, D6 | accessible text of the placeholder rows (`aria-busy` region) |
| `shell.timesIn` | `zone` | Times in {zone} | D6 | only when the device zone differs from `tz`; `zone` = the zone as D6 shows it |

**AgendaView and DayList (D5)**

| Key (`calendarHome.` +) | Args | English | Used by | When / notes |
|---|---|---|---|---|
| `agenda.today` | — | Today | D5 DayList | day header label for `today` |
| `agenda.tomorrow` | — | Tomorrow | D5 DayList | day header label for tomorrow |
| `agenda.nothingPlanned` | — | Nothing planned | D5 DayList | an answered, empty today or tomorrow (always shown, R8) |
| `agenda.nothingPlannedRange` | `range` | Nothing planned {range} | D5 DayList | the fold line; `range` = one day or a from–to range, formatted with Intl like the day headers (weekday short, day, month short). Hebrew prefixes ב to it. |
| `agenda.showNextWeek` | — | Show next week | D5 AgendaView | the button that adds 7 days (R8) |

**Still-open card (D5), spec §7.3**

| Key (`calendarHome.` +) | Args | English | Used by | When / notes |
|---|---|---|---|---|
| `stillOpen.title` | — | Still open | D5 still-open card | card heading |
| `stillOpen.count` | `count` | {count, plural, one {# reminder} other {# reminders}} | D5 still-open card | beside the heading; `count` = open reminders (number) |
| `stillOpen.more` | `count` | {count} more | D5 still-open card | after the first 5; `count` = the rest (number) |
| `stillOpen.sinceTime` | `time` | Since {time} | D5 still-open card | today's open reminder (`openSince` null); `time` = its time |
| `stillOpen.sinceYesterday` | — | Since yesterday | D5 still-open card | `openSince` = yesterday |
| `stillOpen.sinceWeekday` | `weekday` | {weekday, select, sun {Since Sunday} mon {Since Monday} tue {Since Tuesday} wed {Since Wednesday} thu {Since Thursday} fri {Since Friday} sat {Since Saturday} other {}} | D5 still-open card | `openSince` 2–6 days ago; `weekday` = `'sun'`…`'sat'` of that day |
| `stillOpen.sinceDate` | `date` | Since {date} | D5 still-open card | older; `date` = Intl day + month short |

**ItemRow (D5), spec §7.3**

| Key (`calendarHome.` +) | Args | English | Used by | When / notes |
|---|---|---|---|---|
| `row.allDay` | — | All day | D5 ItemRow, ItemSheet | time column of an all-day item |
| `row.until` | `when` | until {when} | D5 ItemRow | span `continues` (its end time) and `endsLater` (its end: a time, or a day and time); `when` pre-formatted |
| `row.continues` | — | continues | D5 ItemRow | span `spansDay`, under `row.allDay` |
| `row.noTitle` | — | (No title) | D5 ItemRow, ItemSheet | `title` null |
| `row.reminder` | — | Reminder | D5 ItemRow, ItemSheet | first meta segment of a reminder ("Reminder · done"); the sheet's kind line |
| `row.open` | — | Open | D5 ItemRow | the accent "Open" label of an open reminder (open circle icon) |
| `row.done` | — | done | D5 ItemRow | after `row.reminder` on a done one (check icon, title struck through) |
| `row.everyDay` | — | every day | D5 ItemRow | after `row.reminder` when `repeatsDaily` |
| `row.repeats` | — | repeats | D5 ItemRow | after `row.reminder` when `recurring` and not daily. Reminders only: the Hebrew agrees with תזכורת |
| `row.snoozedUntil` | `time` | until {time} | D5 ItemRow | the small snoozed badge (open circle icon); `time` = `snoozedUntil` |
| `row.snoozedLabel` | `time` | Snoozed until {time} | D5 ItemRow | that badge's aria-label |
| `row.birthday` | — | Birthday | D5 ItemRow, ItemSheet | Google item with `birthday: true` |
| `row.googleCalendar` | `calendar` | Google · {calendar} | D5 ItemRow | meta of a Google item; `calendar` = `calendar.name` |

**Whose an item is (D5), spec §7.3 and Ruling R7**

| Key (`calendarHome.` +) | Args | English | Used by | When / notes |
|---|---|---|---|---|
| `person.from` | `name` | From {name} | D5 ItemRow, still-open card, ItemSheet | chip of a reminder the partner set (`creatorIsViewer` false); `name` = `creatorName` (nominative, raw) |
| `person.for` | `name` | For {name} | D5 ItemRow, ItemSheet | chip of a reminder the viewer set for the partner (`ownerIsViewer` false); `name` = `ownerName`. A partner's event chip is the bare name (R7), no key |

**ItemSheet (D5), spec §7.5**

| Key (`calendarHome.` +) | Args | English | Used by | When / notes |
|---|---|---|---|---|
| `sheet.label` | — | Details | D5 ItemSheet | the sheet's dialog label |
| `sheet.calendar` | — | Calendar | D5 ItemSheet | label; value = `calendar.name`, or `sheet.partnerCalendar` when `calendar.id` is null (masked) |
| `sheet.partnerCalendar` | `name` | {name}’s calendar | D5 ItemSheet | masked calendar; `name` = `calendar.name` (the DTO puts the partner's name there) |
| `sheet.location` | — | Location | D5 ItemSheet | label |
| `sheet.notes` | — | Notes | D5 ItemSheet | label of the plain-text description |
| `sheet.repeats` | — | Repeats | D5 ItemSheet | `recurring`, not daily (events and reminders) |
| `sheet.everyDay` | — | Every day | D5 ItemSheet | `repeatsDaily` |
| `sheet.stateOpen` | — | Not done yet | D5 ItemSheet | reminder `open` |
| `sheet.stateDone` | — | Done | D5 ItemSheet | done, `doneAt` on another day |
| `sheet.stateDoneAt` | `time` | Done at {time} | D5 ItemSheet | done today; `time` = `doneAt` |
| `sheet.stateSnoozed` | `time` | Snoozed until {time} | D5 ItemSheet | `snoozedUntil` set; `time` |
| `sheet.stateLater` | — | Not due yet | D5 ItemSheet | not done, not open (the bell) |
| `sheet.openInGoogle` | — | Open in Google Calendar | D5 ItemSheet | Google item with `htmlLink`, via `openLink` (§7.5) |

**Empty state (D5), Ruling R10**

| Key (`calendarHome.` +) | Args | English | Used by | When / notes |
|---|---|---|---|---|
| `empty.title` | — | Nothing planned | D5 empty state | the whole window answered and empty (R10) |
| `empty.hintEvents` | — | To add an event, send the bot a voice message, forward it a message, or share a photo of an invitation. | D5 empty state | only when `hints.voiceEvents` |
| `empty.hintReminders` | — | For a reminder, just tell the bot, like “Remind me to call Grandma at 6”. | D5 empty state | only when `hints.reminders`; both false → no hint |

**Hebrew dates (D2), spec §7.8 and Ruling R9**

| Key (`calendarHome.` +) | Args | English | Used by | When / notes |
|---|---|---|---|---|
| `hebrewMonthGenitive` | — | 14 names (below) | D2 (argument), D5 and D6 (pass it) | array of 14 in D2's `HEBREW_MONTHS` order (from Tishrei), read with `t.raw`; only Russian uses it (R9). Order below |

**The genitive list** (`hebrewMonthGenitive`, Ruling R9). Every language holds 14 strings, so the parity check passes; only Russian reads them. en holds hebcal's own names (equal to D2's `HEBREW_MONTHS`), and he the Hebrew names without nikud, in the same order.

| Index | hebcal's name (`HDate#getMonthName()`, D2's `HEBREW_MONTHS`) | he | ru (genitive) |
|---|---|---|---|
| 0 | Tishrei | תשרי | тишрея |
| 1 | Cheshvan | חשון | хешвана |
| 2 | Kislev | כסלו | кислева |
| 3 | Tevet | טבת | тевета |
| 4 | Sh'vat | שבט | швата |
| 5 | Adar (a common year's month 12) | אדר | адара |
| 6 | Adar I (a leap year's month 12) | אדר א׳ | адара I |
| 7 | Adar II (a leap year's month 13) | אדר ב׳ | адара II |
| 8 | Nisan | ניסן | нисана |
| 9 | Iyyar | אייר | ияра |
| 10 | Sivan | סיון | сивана |
| 11 | Tamuz | תמוז | тамуза |
| 12 | Av | אב | ава |
| 13 | Elul | אלול | элула |

D2 looks a month up by its hebcal name (`HEBREW_MONTHS.indexOf(hd.getMonthName())`), and its smoke checks this Russian list against `HEBREW_MONTHS` (each entry must contain the Russian stem). The Russian nominative names come from `@hebcal/locales` 6.3.0 (Тишрей, Хешван, Кислев, Тевет, Шват, Адар, Адар I, Адар II, Нисан, Ияр, Сиван, Тамуз, Ав, Элул), and the genitive list matches their spelling.

**Rules for the tasks that use these keys:**
1. **The caller formats every value.** Times and dates are strings from `Intl.DateTimeFormat` with `timeZone: tz` and `hourCycle: 'h23'`. No key formats a date itself. `count` is a number. `weekday` is one of `'sun' 'mon' 'tue' 'wed' 'thu' 'fri' 'sat'`. `name` is the raw name from the DTO.
2. **Plain `t()` only, no rich-text tags.** next-intl's `t()` throws `FORMATTING_ERROR` on a message with `<chip>…</chip>` unless you call `t.rich`. A chip shows the whole formatted string: `person.from` gives "From Noa".
3. **Meta lines are segments that D5 joins with " · "**: `row.reminder` + `row.done` gives "Reminder · done"; `row.reminder` + `row.everyDay` gives "Reminder · every day"; then the location or note, the person chip, and `row.googleCalendar`.
4. **Spans** (suggested to D5): `endsLater` shows the start time with `row.until` and the end under it; `continues` shows `row.until` with the end time; `spansDay` shows `row.allDay` with `row.continues` under it.
5. **The messages are untyped** (there is no next-intl `AppConfig`), so a wrong key renders its path (`calendarHome.x`) at runtime and tsc can't catch it. D5's render smoke should assert that no `calendarHome.` text reaches the HTML.
6. **New copy stays gender-neutral**: smoke #6 rejects Hebrew slash forms (`את/ה`, `בן/בת`) and Russian bracket endings (`(а)`).

**Findings that shaped the code:**
- **No next-intl message types.** `i18n/request.ts` imports the JSON and nothing declares `AppConfig`. So `KEYS` in the smoke is the only guard for the key names, and it must stay equal to the table.
- **Every web page gets the full message tree.** `app/[locale]/layout.tsx:118` passes `getMessages()` to `NextIntlClientProvider`. So the Header (imported only by the `'use client'` `DashboardClient`, `SubscriptionClient` and `SelectCalendarsClient`) and `TelegramDashboardRedirect` can call `useTranslations`.
- **Plural forms per language** (Node's `Intl.PluralRules`): en one/other, he one/two/other, ru one/few/many/other. A Russian plural without `few` would print "2 напоминаний". The parity check now requires exactly these forms; `=N` forms are extra.
- **Russian weekdays need the genitive after "с"/"со"** ("со вторника"), which `Intl` never gives. So `stillOpen.sinceWeekday` is an ICU select over `sun`…`sat`. Older carry-overs use `stillOpen.sinceDate`, where `Intl`'s "13 окт." is already correct after "С".
- **Russian names stay nominative.** "для Маша" or "от Маша" would be ungrammatical, so the chips use the colon form the bot already uses (`bot.nativeReminders.card.forPartner`: "кому: {name}"). The zone line is "Часовой пояс: {zone}" for the same reason.
- **Hebrew fold line:** `Intl` (he) formats "שבת, 17 באוק׳" and "יום שבת, 17 באוק׳ – יום ראשון, 18 באוק׳". Both read naturally after "אין אירועים ב", as in the approved Hebrew mockup.
- **Other namespaces use slash forms** ("בן/בת זוג", "ספר/י"). `calendarHome` must not, and smoke #6 enforces it.
- **All 887 existing strings use only `{word}` placeholders** (Plan C's two `bot.errors` keys have none), plus one array (`howItWorksPage.noNeed`), and no apostrophe sits before a brace. So the new ICU reader sees exactly the names the old regex saw, and the count after this task is 996 keys (887 + 4 + 105). On the scratch base, without Plan C's pair, it was 885 → 994.
- **`DashboardClient` can't load under tsx**: it imports `@hebcal/core`, which has no require entry. The smoke checks the badge in its source, as `smoke-miniapp-gate` #14 does, and stubs the module the way `smoke-miniapp-gate` does, because `PageGate` (imported by `TelegramDashboardRedirect`) loads it with `dynamic()`.
- **The parity checks run the script in a child process** on fixture files. The old script ignores the directory argument, checks `messages/` and exits 0, so on today's code those checks fail cleanly instead of ending the smoke.
- **`TelegramDashboardRedirect` renders under `renderToString`** inside `AppRouterContext` (for `useRouter`), as in `smoke-page-auth`'s `renderHtml`. Its effects don't run on the server, so the loader is what renders.
- **The send results map to D4's outcomes** (R5): a Telegram 2xx closes the app with no text (`send.sent` only if `close()` is missing or throws); a browser 2xx gives `send.sentWhatsApp`; 429 → `send.busy`; 401/403 → `send.signedOut`; no response → `send.offline`; anything else → `send.failed`.

**Verified on a copy of the real base:**
- Base: `feat/calendar-home` after Plan C (verified on 2eb69df, Plan C's reference chain on 716a4f8, and again on 6dab367, the branch and `main` after Plan C, which differs from that chain only in files D doesn't touch). The first pass, with the mutations below, ran on the scratch base 63e7d4f (header, Planning Ruling 9); the results below hold on all three, the parity counts two keys lower on the scratch base.
- Before this task: the new smoke prints `0/14 passed` and exits 1 under `TZ=UTC` and `TZ=Asia/Jerusalem` (the lines are in Step 2).
- After: `14/14 passed` under `TZ=UTC`, `TZ=Asia/Jerusalem` and `TZ=Pacific/Kiritimati`; `check-i18n-parity` prints `i18n parity OK (996 keys)` (887 before).
- The regression smokes in Step 3 print the same counts before and after, under both clocks.
- `tsc` and lint are clean.
- Mutations caught (first pass, on the scratch base):
  - Russian `few` dropped from `stillOpen.count` → #10;
  - the parser not reading arguments inside forms → #12;
  - the form checks removed → #13, #14;
  - one Header aria-label back to "Settings" → #7;
  - `{name}` renamed `{nm}` in Hebrew → #3, #10;
  - a Hebrew slash form ("נסה/י") → #6;
  - an extra key in one language → #2, #10;
  - `calendarHome` moved to the end of `en.json` → #1;
  - the Russian list in a Nisan-first order → #5;
  - the three component edits not made → #7, #8, #9 (Step 2's run).
- The task text itself was replayed on a fresh copy of 2eb69df: every Before block matched once, and the result was byte-identical to D1's reference commit (smoke 14/14 under the three clocks, `tsc` and lint clean). The first pass replayed it on a fresh 63e7d4f copy the same way.

**Verified against stand-ins:** none needed. D1 consumes no other D task's export.

All smoke commands below use this fake environment (never `.env`):
```bash
E="DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake"
```

- [ ] **Step 1: Write the failing smoke `scripts/smoke-calendar-home-copy.ts`**

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
// Faked at the boundaries: the dashboard client (it imports @hebcal/core, which has no
// require entry, so it can't load under tsx; nothing here renders it). No DB, Redis or
// network.
//
// Run with the fake env from the task brief (no dotenv):
//   npx tsx scripts/smoke-calendar-home-copy.ts

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

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
const readSource = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const load = (rel: string): Promise<Row> => import(path.join(ROOT, rel));
const messagesOf = (locale: Locale): Row => JSON.parse(readSource(`messages/${locale}.json`));

// ---- The Keys table ----

/** Every calendarHome key, with the ICU arguments it takes (the task's Keys table). */
const KEYS: Record<string, readonly string[]> = {
  // HomeHeader (D6)
  'header.send': [],
  'header.menu': [],
  // SendSheet (D6), with the send results of Ruling R5 (D4's outcomes)
  'send.title': [],
  'send.subtitle': [],
  'send.today': [],
  'send.todayHint': [],
  'send.tomorrow': [],
  'send.tomorrowHint': [],
  'send.thisWeek': [],
  'send.thisWeekHint': [],
  'send.nextWeek': [],
  'send.nextWeekHint': [],
  'send.weather': [],
  'send.weatherHint': [],
  'send.sending': [],
  'send.sent': [],
  'send.sentWhatsApp': [],
  'send.busy': [],
  'send.failed': [],
  'send.signedOut': [],
  'send.offline': [],
  // MenuSheet (D6), Ruling R6
  'menu.settings': [],
  'menu.calendars': [],
  'menu.partner': [],
  'menu.chooseCalendars': [],
  'menu.reconnectGoogle': [],
  'menu.subscription': [],
  'menu.refresh': [],
  'menu.feedback': [],
  'menu.admin': [],
  // HomeBanners (D6), spec §7.2 and §5's Reconnect banner
  'banner.trial': ['count'],
  'banner.trialAction': [],
  'banner.location': [],
  'banner.locationAction': [],
  'banner.connectGoogle': [],
  'banner.connectGoogleBody': [],
  'banner.chooseCalendars': [],
  'banner.chooseCalendarsBody': [],
  'banner.reconnect': [],
  'banner.reconnectBody': [],
  'banner.reconnectScopes': [],
  'banner.reconnectScopesBody': [],
  'banner.reconnectAction': [],
  'banner.openInTelegram': [],
  'banner.openInTelegramBody': [],
  // §5's state rows and the retry card (D5 and D6)
  'state.partial': [],
  'state.unavailable': ['count'],
  'state.googleError': [],
  'state.calendarsGone': [],
  'state.famcalError': [],
  'state.busy': [],
  'state.errorTitle': [],
  'state.errorBody': [],
  // Buttons shared by the rows, cards, sheets and the error boundary
  'actions.retry': [],
  'actions.chooseAgain': [],
  'actions.close': [],
  'actions.reload': [],
  // HomeErrorBoundary (D6)
  'errorBoundary.title': [],
  'errorBoundary.body': [],
  // CalendarHome shell (D6)
  'shell.loading': [],
  'shell.timesIn': ['zone'],
  // AgendaView and DayList (D5)
  'agenda.today': [],
  'agenda.tomorrow': [],
  'agenda.nothingPlanned': [],
  'agenda.nothingPlannedRange': ['range'],
  'agenda.showNextWeek': [],
  // The still-open card (D5)
  'stillOpen.title': [],
  'stillOpen.count': ['count'],
  'stillOpen.more': ['count'],
  'stillOpen.sinceTime': ['time'],
  'stillOpen.sinceYesterday': [],
  'stillOpen.sinceWeekday': ['weekday'],
  'stillOpen.sinceDate': ['date'],
  // ItemRow (D5)
  'row.allDay': [],
  'row.until': ['when'],
  'row.continues': [],
  'row.noTitle': [],
  'row.reminder': [],
  'row.open': [],
  'row.done': [],
  'row.everyDay': [],
  'row.repeats': [],
  'row.snoozedUntil': ['time'],
  'row.snoozedLabel': ['time'],
  'row.birthday': [],
  'row.googleCalendar': ['calendar'],
  // Whose an item is (D5: rows, the still-open card, the item sheet), spec §7.3
  'person.from': ['name'],
  'person.for': ['name'],
  // ItemSheet (D5), spec §7.5
  'sheet.label': [],
  'sheet.calendar': [],
  'sheet.partnerCalendar': ['name'],
  'sheet.location': [],
  'sheet.notes': [],
  'sheet.repeats': [],
  'sheet.everyDay': [],
  'sheet.stateOpen': [],
  'sheet.stateDone': [],
  'sheet.stateDoneAt': ['time'],
  'sheet.stateSnoozed': ['time'],
  'sheet.stateLater': [],
  'sheet.openInGoogle': [],
  // The empty state (D5), Ruling R10
  'empty.title': [],
  'empty.hintEvents': [],
  'empty.hintReminders': [],
};
/** Keys whose value is an array (read with t.raw). */
const ARRAY_KEYS = ['hebrewMonthGenitive'];

/** A sample value per argument. count and weekday also run over several values. */
const SAMPLES: Record<string, string | number> = {
  name: 'Noa',
  calendar: 'Family',
  when: '02:00',
  time: '13:45',
  date: '12 Oct',
  range: 'Sat 17 – Sun 18 Oct',
  zone: 'Asia/Jerusalem',
  count: 5,
  weekday: 'tue',
};
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * hebcal's month names (HDate#getMonthName()) in the order of Task D2's HEBREW_MONTHS: the
 * year from Tishrei, a common year's Adar before a leap year's Adar I and Adar II. D2's
 * hebrew-date.ts looks a month up in that order; D1 lands first, so this is a copy.
 */
const HEBREW_MONTHS = ['Tishrei', 'Cheshvan', 'Kislev', 'Tevet', "Sh'vat", 'Adar', 'Adar I', 'Adar II', 'Nisan', 'Iyyar', 'Sivan', 'Tamuz', 'Av', 'Elul'];
/** Ruling R9: "4 хешвана". The genitive of @hebcal/locales' ru names (Тишрей, Хешван, …), in that order. */
const RU_GENITIVE = ['тишрея', 'хешвана', 'кислева', 'тевета', 'швата', 'адара', 'адара I', 'адара II', 'нисана', 'ияра', 'сивана', 'тамуза', 'ава', 'элула'];

/** Every leaf under a node, by its dot path; an array is one leaf. */
function leavesOf(node: unknown, prefix = '', out = new Map<string, unknown>()): Map<string, unknown> {
  if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
    for (const [key, value] of Object.entries(node)) leavesOf(value, prefix ? `${prefix}.${key}` : key, out);
  } else {
    out.set(prefix, node);
  }
  return out;
}

/** The part of next-intl's translator the checks call. */
type Translate = ((key: string, values?: Row) => string) & { raw: (key: string) => unknown };

/** next-intl's translator for calendarHome, as the home's useTranslations('calendarHome') gets it. */
function translator(locale: Locale, errors: string[]): Translate {
  const { createTranslator } = nodeRequire('next-intl');
  return createTranslator({
    locale,
    messages: messagesOf(locale),
    namespace: 'calendarHome',
    onError: (err: Error) => errors.push(err.message),
    getMessageFallback: ({ key }: { key: string }) => `[missing ${key}]`,
  });
}

/** The sample values for a key's arguments. */
const valuesFor = (args: readonly string[]): Row => Object.fromEntries(args.map(a => [a, SAMPLES[a]]));

// ---- Rendering (the providers the [locale] layout gives a client page) ----

const Module = nodeRequire('module');
const stubs: Record<string, Row> = {};
(globalThis as Row).__smokeStubs = stubs;
if (typeof Module.registerHooks !== 'function') throw new Error('This smoke needs Node 22.15+ (module.registerHooks)');
Module.registerHooks({
  load(url: string, context: unknown, nextLoad: (u: string, c: unknown) => unknown) {
    const file = url.startsWith('file:') ? fileURLToPath(url.split('?')[0]) : '';
    if (!(file in stubs)) return nextLoad(url, context);
    const names = Object.keys(stubs[file]).filter(n => n !== 'default' && /^[A-Za-z_$][\w$]*$/.test(n));
    const source = [
      `const s = globalThis.__smokeStubs[${JSON.stringify(file)}];`,
      ...names.map(n => `export const ${n} = s[${JSON.stringify(n)}];`),
      'export default (s.__esModule ? s.default : s);',
    ].join('\n');
    return { format: 'module', source, shortCircuit: true };
  },
});

function stub(rel: string, exports: Row) {
  const filename = path.join(ROOT, rel);
  stubs[filename] = exports;
  const mod = new Module(filename);
  Object.assign(mod, { filename, loaded: true, exports });
  Module._cache[filename] = mod;
}

/** Text as React writes it into HTML. */
const asHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');

function renderHtml(el: unknown, locale: Locale): string {
  const React = nodeRequire('react');
  const { renderToString } = nodeRequire('react-dom/server');
  const { NextIntlClientProvider } = nodeRequire('next-intl');
  const { AppRouterContext } = nodeRequire('next/dist/shared/lib/app-router-context.shared-runtime');
  const noop = () => undefined;
  const router = { push: noop, replace: noop, refresh: noop, prefetch: noop, back: noop, forward: noop };
  // <style jsx> is styled-jsx's; without its compiler React warns about the jsx attribute.
  const error = console.error;
  console.error = (...args: unknown[]) => {
    if (!args.some(a => typeof a === 'string' && a.includes('non-boolean attribute'))) error(...args);
  };
  try {
    return renderToString(
      React.createElement(AppRouterContext.Provider, { value: router },
        React.createElement(NextIntlClientProvider, { locale, messages: messagesOf(locale), timeZone: 'Asia/Jerusalem' }, el)),
    );
  } finally {
    console.error = error;
  }
}

// ---- check-i18n-parity on fixtures ----

const tempDirs: string[] = [];

/** Writes en.json, he.json and ru.json into a fresh temp directory. */
function fixture(files: Record<Locale, Row>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-parity-'));
  tempDirs.push(dir);
  for (const locale of LOCALES) fs.writeFileSync(path.join(dir, `${locale}.json`), JSON.stringify(files[locale]));
  return dir;
}

/** Runs scripts/check-i18n-parity.ts (on messages/, or on `dir`) and returns its exit code and stdout. */
function runParity(dir?: string): { code: number | null; out: string } {
  const script = path.join(ROOT, 'scripts', 'check-i18n-parity.ts');
  const res = spawnSync(process.execPath, [nodeRequire.resolve('tsx/cli'), script, ...(dir ? [dir] : [])], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  // stdout carries the problems and the verdict; stderr only tsx's own warnings.
  return { code: res.status, out: res.stdout ?? '' };
}

const GOOD_PLURALS: Record<Locale, string> = {
  en: '{count, plural, one {# item} other {# items}}',
  he: '{count, plural, one {פריט אחד} two {שני פריטים} other {# פריטים}}',
  ru: '{count, plural, one {# пункт} few {# пункта} many {# пунктов} other {# пункта}}',
};

async function main() {
  stub('app/[locale]/dashboard/DashboardClient.tsx', { __esModule: true, default: () => null });

  await check('#1 calendarHome is its own top-level object in en/he/ru, right after dashboard and before admin (away from bot.errors)', () => {
    const problems: string[] = [];
    for (const locale of LOCALES) {
      const messages = messagesOf(locale);
      const top = Object.keys(messages);
      const at = top.indexOf('calendarHome');
      if (at < 0) problems.push(`${locale}: no top-level calendarHome`);
      else if (top[at - 1] !== 'dashboard' || top[at + 1] !== 'admin') problems.push(`${locale}: calendarHome sits between ${top[at - 1]} and ${top[at + 1]}`);
      if (messages.bot && 'calendarHome' in messages.bot) problems.push(`${locale}: a calendarHome inside bot`);
    }
    assert(problems.length === 0, problems.join('; '));
  });

  await check('#2 each language holds exactly the Keys table under calendarHome: none missing, none extra', () => {
    const want = [...Object.keys(KEYS), ...ARRAY_KEYS].sort();
    const problems: string[] = [];
    for (const locale of LOCALES) {
      const have = [...leavesOf(messagesOf(locale).calendarHome ?? {}).keys()].sort();
      const missing = want.filter(k => !have.includes(k));
      const extra = have.filter(k => !want.includes(k));
      if (missing.length) problems.push(`${locale} lacks ${missing.length}: ${missing.slice(0, 6).join(', ')}${missing.length > 6 ? ', …' : ''}`);
      if (extra.length) problems.push(`${locale} has extra: ${extra.join(', ')}`);
    }
    assert(problems.length === 0, problems.join('; '));
  });

  await check('#3 every key formats through next-intl in each language with exactly its arguments: no error, nothing left unfilled, each argument shown', () => {
    const problems: string[] = [];
    for (const locale of LOCALES) {
      for (const [key, args] of Object.entries(KEYS)) {
        const errors: string[] = [];
        const t = translator(locale, errors);
        const out = t(key, valuesFor(args));
        if (errors.length) { problems.push(`${locale} ${key}: ${errors[0]}`); continue; }
        if (typeof out !== 'string' || !out.trim()) { problems.push(`${locale} ${key}: empty`); continue; }
        if (/[{}]/.test(out) || out.includes('calendarHome') || out.includes('[missing')) problems.push(`${locale} ${key}: "${out}"`);
        for (const arg of args) {
          if (arg === 'weekday') continue; // #4 runs every weekday
          if (!out.includes(String(SAMPLES[arg]))) problems.push(`${locale} ${key} never shows {${arg}}: "${out}"`);
        }
      }
    }
    assert(problems.length === 0, problems.slice(0, 8).join('; '));
  });

  await check('#4 plurals, the weekday select and the person chips read naturally (exact text in en/he/ru)', () => {
    const cases: [Locale, string, Row, string][] = [
      ['en', 'stillOpen.count', { count: 1 }, '1 reminder'],
      ['en', 'stillOpen.count', { count: 2 }, '2 reminders'],
      ['he', 'stillOpen.count', { count: 1 }, 'תזכורת אחת'],
      ['he', 'stillOpen.count', { count: 2 }, 'שתי תזכורות'],
      ['he', 'stillOpen.count', { count: 5 }, '5 תזכורות'],
      ['ru', 'stillOpen.count', { count: 1 }, '1 напоминание'],
      ['ru', 'stillOpen.count', { count: 3 }, '3 напоминания'],
      ['ru', 'stillOpen.count', { count: 5 }, '5 напоминаний'],
      ['ru', 'stillOpen.count', { count: 21 }, '21 напоминание'],
      ['en', 'stillOpen.more', { count: 3 }, '3 more'],
      ['he', 'stillOpen.more', { count: 1 }, 'ועוד אחת'],
      ['he', 'stillOpen.more', { count: 2 }, 'ועוד שתיים'],
      ['he', 'stillOpen.more', { count: 7 }, 'ועוד 7'],
      ['ru', 'stillOpen.more', { count: 7 }, 'Ещё 7'],
      ['en', 'banner.trial', { count: 1 }, '1 day left in your trial'],
      ['he', 'banner.trial', { count: 2 }, 'נשארו יומיים לתקופת הניסיון'],
      ['he', 'banner.trial', { count: 9 }, 'נשארו 9 ימים לתקופת הניסיון'],
      ['ru', 'banner.trial', { count: 1 }, 'До конца пробного периода 1 день'],
      ['ru', 'banner.trial', { count: 4 }, 'До конца пробного периода 4 дня'],
      ['ru', 'banner.trial', { count: 11 }, 'До конца пробного периода 11 дней'],
      ['en', 'state.unavailable', { count: 2 }, '2 calendars aren’t available'],
      ['he', 'state.unavailable', { count: 1 }, 'יומן אחד לא זמין'],
      ['ru', 'state.unavailable', { count: 1 }, '1 календарь недоступен'],
      ['ru', 'state.unavailable', { count: 2 }, '2 календаря недоступны'],
      ['ru', 'state.unavailable', { count: 12 }, '12 календарей недоступны'],
      ['en', 'stillOpen.sinceWeekday', { weekday: 'tue' }, 'Since Tuesday'],
      ['he', 'stillOpen.sinceWeekday', { weekday: 'sat' }, 'משבת'],
      ['ru', 'stillOpen.sinceWeekday', { weekday: 'mon' }, 'С понедельника'],
      ['ru', 'stillOpen.sinceWeekday', { weekday: 'tue' }, 'Со вторника'],
      ['ru', 'stillOpen.sinceWeekday', { weekday: 'wed' }, 'Со среды'],
      ['en', 'person.from', { name: 'Noa' }, 'From Noa'],
      ['he', 'person.for', { name: 'נועה' }, 'בשביל נועה'],
      ['ru', 'person.from', { name: 'Маша' }, 'От: Маша'],
      ['ru', 'person.for', { name: 'Маша' }, 'Кому: Маша'],
      ['he', 'agenda.nothingPlannedRange', { range: 'שבת, 17 באוק׳' }, 'אין אירועים בשבת, 17 באוק׳'],
    ];
    const problems: string[] = [];
    for (const [locale, key, values, want] of cases) {
      const errors: string[] = [];
      const got = translator(locale, errors)(key, values);
      if (errors.length || got !== want) problems.push(`${locale} ${key} ${show(values)}: ${show(got)}${errors.length ? ` (${errors[0]})` : ''}, want ${show(want)}`);
    }
    for (const locale of LOCALES) {
      const errors: string[] = [];
      const t = translator(locale, errors);
      const all = WEEKDAYS.map(weekday => t('stillOpen.sinceWeekday', { weekday }));
      if (errors.length || new Set(all).size !== 7 || all.some(s => !s.trim())) problems.push(`${locale} weekdays: ${show(all)} ${errors[0] ?? ''}`);
    }
    assert(problems.length === 0, problems.slice(0, 6).join('; '));
  });

  await check('#5 hebrewMonthGenitive: 14 names in each language in D2\'s HEBREW_MONTHS order (from Tishrei), genitive in Russian (R9), read whole by t.raw', () => {
    const problems: string[] = [];
    for (const locale of LOCALES) {
      const errors: string[] = [];
      const list = translator(locale, errors).raw('hebrewMonthGenitive');
      if (errors.length || !Array.isArray(list) || list.length !== 14 || list.some((s: unknown) => typeof s !== 'string' || !s.trim())) {
        problems.push(`${locale}: ${show(list)} ${errors[0] ?? ''}`);
      }
    }
    const en = messagesOf('en').calendarHome?.hebrewMonthGenitive;
    if (show(en) !== show(HEBREW_MONTHS)) problems.push(`en is not hebcal's names in HEBREW_MONTHS order: ${show(en)}`);
    const ru = messagesOf('ru').calendarHome?.hebrewMonthGenitive;
    if (show(ru) !== show(RU_GENITIVE)) problems.push(`ru: ${show(ru)}`);
    assert(problems.length === 0, problems.join('; '));
  });

  await check('#6 no slash or bracket gender forms in the Hebrew or Russian copy (calendarHome and common.header)', () => {
    const problems: string[] = [];
    const rules: [Locale, RegExp][] = [
      ['he', /[א-ת]\s?\/\s?[א-ת]/],
      ['ru', /[а-яё]\/[а-яё]|\((а|ла|ась|ен|на|ы)\)/i],
    ];
    for (const [locale, gendered] of rules) {
      const messages = messagesOf(locale);
      if (!messages.calendarHome) problems.push(`${locale}: no calendarHome`);
      if (!messages.common?.header) problems.push(`${locale}: no common.header`);
      const strings = [...leavesOf(messages.calendarHome ?? {}).entries(), ...leavesOf(messages.common?.header ?? {}).entries()];
      for (const [key, value] of strings) {
        for (const s of Array.isArray(value) ? value : [value]) {
          if (typeof s === 'string' && gendered.test(s)) problems.push(`${locale} ${key}: "${s}"`);
        }
      }
    }
    assert(problems.length === 0, problems.join('; '));
  });

  await check('#7 Header (old home, Subscription, Select calendars): translated aria-labels and admin badge in en/he/ru, no English left in he/ru', async () => {
    const React = nodeRequire('react');
    const Header = (await load('components/Layout/Header.tsx')).default;
    const noop = () => undefined;
    const problems: string[] = [];
    for (const locale of LOCALES) {
      const labels = messagesOf(locale).common?.header;
      if (!labels) { problems.push(`${locale}: no common.header`); continue; }
      const html = renderHtml(React.createElement(Header, {
        title: 'FamCal', userName: 'Dana', isAdmin: true, onBackClick: noop, onAdminClick: noop, onSettingsClick: noop,
      }), locale);
      for (const key of ['back', 'adminPanel', 'settings']) {
        if (!html.includes(`aria-label="${asHtml(labels[key])}"`)) problems.push(`${locale}: no aria-label for ${key}`);
      }
      if (!html.includes(`>${asHtml(labels.adminBadge)}</div>`)) problems.push(`${locale}: no ${labels.adminBadge} badge`);
      if (locale !== 'en') {
        for (const english of ['Go Back', 'Admin Panel', '"Settings"', '>ADMIN<']) {
          if (html.includes(english)) problems.push(`${locale}: still ${english}`);
        }
      }
      if (!html.includes('text-transform: uppercase')) problems.push(`${locale}: the badge is no longer upper-case`);
    }
    assert(problems.length === 0, problems.join('; '));
  });

  await check('#8 the dashboard loader (TelegramDashboardRedirect) says pageGate.loading in each language, not "Loading Dashboard..."', async () => {
    const React = nodeRequire('react');
    const Redirect = (await load('app/[locale]/dashboard/TelegramDashboardRedirect.tsx')).default;
    const links = { whatsapp: 'https://wa.me/972500000000?text=settings', telegram: 'https://t.me/test_bot?start=dashboard' };
    const problems: string[] = [];
    for (const locale of LOCALES) {
      const html = renderHtml(React.createElement(Redirect, { locale, links }), locale);
      const want = messagesOf(locale).pageGate.loading;
      if (!html.includes(`>${asHtml(want)}</h2>`)) problems.push(`${locale}: no "${want}" heading in ${html.slice(0, 120)}…`);
      if (html.includes('Loading Dashboard')) problems.push(`${locale}: still "Loading Dashboard..."`);
    }
    assert(problems.length === 0, problems.join('; '));
  });

  await check('#9 the old home\'s plan badge reads subscription.plans.free.name, not a hard-coded "Free"', () => {
    const src = readSource('app/[locale]/dashboard/DashboardClient.tsx');
    assert(src.includes(`<span className="subscription-badge free">{tSub('plans.free.name')}</span>`), 'the free badge does not read subscription.plans.free.name');
    assert(!/>\s*Free\s*</.test(src), 'a hard-coded "Free" is still in DashboardClient');
    const names = LOCALES.map(l => messagesOf(l).subscription?.plans?.free?.name);
    assert(names.every(n => typeof n === 'string' && n.trim()) && names[1] !== 'Free' && names[2] !== 'Free', `plans.free.name: ${show(names)}`);
  });

  await check('#10 check-i18n-parity passes messages/ and a fixture with well-formed plurals in each language', () => {
    const real = runParity();
    assert(real.code === 0 && /i18n parity OK \(\d+ keys\)/.test(real.out), `messages/: exit ${real.code}: ${real.out.trim().slice(-300)}`);
    const good = runParity(fixture({
      en: { x: { n: GOOD_PLURALS.en, who: 'Hi {name}' } },
      he: { x: { n: GOOD_PLURALS.he, who: 'שלום {name}' } },
      ru: { x: { n: GOOD_PLURALS.ru, who: 'Привет, {name}' } },
    }));
    assert(good.code === 0 && good.out.includes('i18n parity OK (2 keys)'), `fixture: exit ${good.code}: ${good.out.trim().slice(-300)}`);
  });

  await check('#11 check-i18n-parity fails an ICU argument renamed in one language ({n, plural} in ru where en has {count, plural})', () => {
    const res = runParity(fixture({
      en: { x: { n: GOOD_PLURALS.en } },
      he: { x: { n: GOOD_PLURALS.he } },
      ru: { x: { n: GOOD_PLURALS.ru.replace('{count,', '{n,') } },
    }));
    assert(res.code === 1 && res.out.includes('ru: x.n has arguments [n], en has [count]'), `exit ${res.code}: ${res.out.trim().slice(-300)}`);
  });

  await check('#12 check-i18n-parity fails an argument missing inside one language\'s plural forms ({name} in en, not in he)', () => {
    const res = runParity(fixture({
      en: { x: { n: '{count, plural, one {# from {name}} other {# from {name}}}' } },
      he: { x: { n: GOOD_PLURALS.he } },
      ru: { x: { n: '{count, plural, one {# от: {name}} few {# от: {name}} many {# от: {name}} other {# от: {name}}}' } },
    }));
    assert(res.code === 1 && res.out.includes('he: x.n has arguments [count], en has [count name]'), `exit ${res.code}: ${res.out.trim().slice(-300)}`);
    assert(!res.out.includes('ru: x.n'), `ru was flagged: ${res.out.trim()}`);
  });

  await check('#13 check-i18n-parity fails a plural missing a form its language uses (ru few) or giving one it never uses (he few)', () => {
    const res = runParity(fixture({
      en: { x: { n: GOOD_PLURALS.en } },
      he: { x: { n: '{count, plural, one {פריט אחד} two {שני פריטים} few {כמה} other {# פריטים}}' } },
      ru: { x: { n: '{count, plural, one {# пункт} many {# пунктов} other {# пункта}}' } },
    }));
    assert(res.code === 1, `exit ${res.code}: ${res.out.trim().slice(-300)}`);
    for (const line of ['ru: x.n {count, plural} lacks the "few" form', 'he: x.n {count, plural} has a "few" form, which he never uses']) {
      assert(res.out.includes(line), `no "${line}" in: ${res.out.trim().slice(-300)}`);
    }
  });

  await check('#14 check-i18n-parity fails a message ICU can\'t parse (an unclosed brace) and a select with no "other" form', () => {
    const res = runParity(fixture({
      en: { x: { n: GOOD_PLURALS.en, s: '{w, select, a {A} b {B}}' } },
      he: { x: { n: GOOD_PLURALS.he.slice(0, -1), s: '{w, select, a {א} other {ב}}' } },
      ru: { x: { n: GOOD_PLURALS.ru, s: '{w, select, a {А} other {Б}}' } },
    }));
    assert(res.code === 1, `exit ${res.code}: ${res.out.trim().slice(-300)}`);
    for (const line of ['he: x.n is not valid ICU:', 'en: x.s {w, select} has no "other" form']) {
      assert(res.out.includes(line), `no "${line}" in: ${res.out.trim().slice(-300)}`);
    }
    assert(!/he: x\.n has arguments/.test(res.out), `an unparsable message was also compared: ${res.out.trim()}`);
  });

  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Run it and see it fail**

```bash
for tz in UTC Asia/Jerusalem; do
  eval "env TZ=$tz $E npx tsx scripts/smoke-calendar-home-copy.ts"; echo "smoke-calendar-home-copy TZ=$tz exit $?"
done
```
Expected, in both timezones: `0/14 passed`, then `exit 1`. The first lines:
```
FAIL  #1 calendarHome is its own top-level object in en/he/ru, right after dashboard and before admin (away from bot.errors) — en: no top-level calendarHome; he: no top-level calendarHome; ru: no top-level calendarHome
FAIL  #2 each language holds exactly the Keys table under calendarHome: none missing, none extra — en lacks 105: actions.chooseAgain, actions.close, actions.reload, actions.retry, agenda.nothingPlanned, agenda.nothingPlannedRange, …; …
```
#3–#5 fail with `MISSING_MESSAGE: calendarHome (en)`, #6 and #7 with `no common.header`, #8 with `still "Loading Dashboard..."` and #9 with `the free badge does not read subscription.plans.free.name`. #10–#14 fail with `exit 0: i18n parity OK (887 keys)`: the old script ignores the directory and checks `messages/`. tsx may print `DEP0205` deprecation warnings on stderr; ignore them.

- [ ] **Step 3: Record the regression smokes' baseline**

```bash
L=$(mktemp -d)
for tz in UTC Asia/Jerusalem; do
  for s in check-i18n-parity smoke-miniapp-gate smoke-page-auth smoke-admin-panel-ssr smoke-calendar-home-rollout smoke-native-reminder-support smoke-native-reminder-buttons smoke-native-reminders smoke-native-reminder-create-flow smoke-native-reminder-creation smoke-native-reminder-edit smoke-native-reminder-typed smoke-google-connect smoke-oauth-weather smoke-account-merge smoke-digest-reader-parity smoke-summary-prompt-parity smoke-summary-retry smoke-summary-seam smoke-week-commands; do
    eval "env TZ=$tz $E npx tsx scripts/$s.ts" > "$L/$s.log" 2>&1; echo "$s TZ=$tz exit $? $(grep -E 'passed|parity' "$L/$s.log" | tail -1)"
  done
done
```
Expected, every one `exit 0`, in both timezones: `i18n parity OK (887 keys)`; `smoke-miniapp-gate` 15/15; `smoke-page-auth` 10/10; `smoke-admin-panel-ssr` 10/10; `smoke-calendar-home-rollout` 35/35; `smoke-native-reminder-support` 32/32; `smoke-native-reminder-buttons` 36/36; `smoke-native-reminders` 45/45; `smoke-native-reminder-create-flow` 56/56; `smoke-native-reminder-creation` 30/30; `smoke-native-reminder-edit` 18/18; `smoke-native-reminder-typed` 24/24; `smoke-google-connect` 30/30; `smoke-oauth-weather` 14/14; `smoke-account-merge` 50/50; `smoke-digest-reader-parity` 28/28; `smoke-summary-prompt-parity` 9/9; `smoke-summary-retry` 20/20; `smoke-summary-seam` 23/23; `smoke-week-commands` 7/7. These are the smokes that read `messages/*.json` or render or check the three components; the last five are Plan C's, which read its `bot` texts.

- [ ] **Step 4: Replace `scripts/check-i18n-parity.ts`**

The whole file (it was 61 lines):

```ts
// i18n parity: messages/en.json, he.json and ru.json must hold the same keys, and each
// key the same ICU arguments. A key missing from one locale reaches the user as its own
// path ("nativeReminders.done") through getBotMessage, or as English through the
// `t.voice?.x || 'English'` fallbacks; an argument missing from one locale drops the
// title or name from that language's message. An array counts as one key.
//
// The arguments are ICU's: {name}, and {count, plural, …} or {x, select, …} together with
// the arguments inside their forms. Only the names must match: a count can be a plain
// {count} in one language and a plural in another. Each message must also be one ICU can
// parse (next-intl formats every web message with it), every select needs an `other`
// form, and every plural gives exactly the forms its language uses (Intl.PluralRules:
// en one/other, he one/two/other, ru one/few/many/other; `=N` forms are extra). A Russian
// plural with no `few` form would print "2 напоминаний".
//
// Run: npx tsx scripts/check-i18n-parity.ts [messages-dir]
// The directory defaults to messages/; scripts/smoke-calendar-home-copy.ts passes fixtures.

import { readFileSync } from 'node:fs';
import path from 'node:path';

const LOCALES = ['en', 'he', 'ru'] as const;
type Locale = (typeof LOCALES)[number];

/** One ICU argument: its name, its type (null for a plain {name}) and, for plural and select, its forms. */
interface IcuArgument {
  name: string;
  type: string | null;
  forms: string[];
}

const PLURAL_TYPES = new Set(['plural', 'selectordinal']);
const STYLED_TYPES = new Set(['number', 'date', 'time']);

/** Every ICU argument in a message, nested ones included. Throws on a message ICU can't parse. */
function icuArguments(message: string): IcuArgument[] {
  const found: IcuArgument[] = [];
  let i = 0;
  const fail = (what: string): never => {
    throw new Error(`${what} (at character ${i})`);
  };
  const skipSpace = () => {
    while (i < message.length && /\s/.test(message[i])) i++;
  };
  const read = (pattern: RegExp): string => {
    const match = pattern.exec(message.slice(i));
    if (!match) return '';
    i += match[0].length;
    return match[0];
  };

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
          i++;
        }
      } else if (c === '{') {
        argument();
      } else if (c === '}') {
        if (inForm) return;
        fail('a "}" with no "{"');
      } else {
        i++;
      }
    }
    if (inForm) fail('a "{" with no "}"');
  };

  const argument = (): void => {
    i++; // the "{"
    skipSpace();
    const name = read(/^\w+/);
    if (!name) fail('an argument with no name');
    skipSpace();
    if (message[i] === '}') {
      i++;
      found.push({ name, type: null, forms: [] });
      return;
    }
    if (message[i] !== ',') fail(`"{${name}" followed by neither "}" nor ","`);
    i++;
    skipSpace();
    const type = read(/^\w+/);
    skipSpace();
    if (PLURAL_TYPES.has(type) || type === 'select') {
      if (message[i] !== ',') fail(`{${name}, ${type}} with no forms`);
      i++;
      const entry: IcuArgument = { name, type, forms: [] };
      found.push(entry);
      for (;;) {
        skipSpace();
        if (i >= message.length) fail(`{${name}, ${type}, …} never closes`);
        if (message[i] === '}') {
          i++;
          return;
        }
        const selector = read(/^[^\s{}]+/);
        if (!selector) fail(`a form of {${name}} with no name`);
        if (PLURAL_TYPES.has(type) && /^offset:\d+$/.test(selector)) continue;
        skipSpace();
        if (message[i] !== '{') fail(`the "${selector}" form of {${name}} has no message`);
        i++;
        text(true, type !== 'select');
        i++; // the form's "}"
        entry.forms.push(selector);
      }
    }
    if (STYLED_TYPES.has(type)) {
      // An optional style, up to the argument's "}".
      const close = message.indexOf('}', i);
      if (close < 0) fail(`{${name}, ${type}} never closes`);
      i = close + 1;
      found.push({ name, type, forms: [] });
      return;
    }
    fail(`{${name}, ${type || '…'}}: not an ICU argument type`);
  };

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
      for (const form of named) {
        if (!uses.includes(form)) problems.push(`${locale}: ${key} {${arg.name}, ${arg.type}} has a "${form}" form, which ${locale} never uses`);
      }
    }
  }
  return problems;
}

/** Every leaf of the message tree, by its dot path. */
function flatten(node: unknown, prefix: string, out: Map<string, unknown>): Map<string, unknown> {
  if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
    for (const [key, value] of Object.entries(node)) flatten(value, prefix ? `${prefix}.${key}` : key, out);
  } else {
    out.set(prefix, node);
  }
  return out;
}

const dir = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '../messages');

const leaves = Object.fromEntries(
  LOCALES.map(locale => {
    const file = path.join(dir, `${locale}.json`);
    return [locale, flatten(JSON.parse(readFileSync(file, 'utf8')), '', new Map())];
  })
) as Record<Locale, Map<string, unknown>>;

const allKeys = [...new Set(LOCALES.flatMap(locale => [...leaves[locale].keys()]))].sort();
const problems: string[] = [];

for (const locale of LOCALES) {
  for (const key of allKeys) {
    if (!leaves[locale].has(key)) problems.push(`${locale}: missing ${key}`);
  }
}

for (const key of allKeys) {
  if (!LOCALES.every(locale => leaves[locale].has(key))) continue;
  // Each locale's argument names, sorted; null where the message doesn't parse.
  const names = {} as Record<Locale, string | null>;
  for (const locale of LOCALES) {
    const value = leaves[locale].get(key);
    if (typeof value !== 'string') {
      names[locale] = '';
      continue;
    }
    try {
      const args = icuArguments(value);
      problems.push(...formProblems(locale, key, args));
      names[locale] = [...new Set(args.map(arg => arg.name))].sort().join(' ');
    } catch (err) {
      problems.push(`${locale}: ${key} is not valid ICU: ${err instanceof Error ? err.message : String(err)}`);
      names[locale] = null;
    }
  }
  const reference = names.en;
  if (reference === null) continue;
  for (const locale of LOCALES) {
    const got = names[locale];
    if (got !== null && got !== reference) problems.push(`${locale}: ${key} has arguments [${got}], en has [${reference}]`);
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.log(problem);
  console.log(`\ni18n parity FAILED (${problems.length} problem${problems.length === 1 ? '' : 's'})`);
  process.exit(1);
}
console.log(`i18n parity OK (${allKeys.length} keys)`);
```

- [ ] **Step 5: Add `common.header` to `messages/en.json`, `messages/he.json` and `messages/ru.json`**

In each file the Before block matches once, at `:16-18`.

`messages/en.json`, Before:
```json
    "no": "No"
  },
  "dashboard": {
```
After:
```json
    "no": "No",
    "header": {
      "back": "Back",
      "settings": "Settings",
      "adminPanel": "Admin panel",
      "adminBadge": "Admin"
    }
  },
  "dashboard": {
```

`messages/he.json`, Before:
```json
    "no": "לא"
  },
  "dashboard": {
```
After:
```json
    "no": "לא",
    "header": {
      "back": "חזרה",
      "settings": "הגדרות",
      "adminPanel": "פאנל ניהול",
      "adminBadge": "אדמין"
    }
  },
  "dashboard": {
```

`messages/ru.json`, Before:
```json
    "no": "Нет"
  },
  "dashboard": {
```
After:
```json
    "no": "Нет",
    "header": {
      "back": "Назад",
      "settings": "Настройки",
      "adminPanel": "Панель администратора",
      "adminBadge": "Админ"
    }
  },
  "dashboard": {
```

- [ ] **Step 6: Add the `calendarHome` namespace to `messages/en.json`**

Between `:70` and `:71` (as of the real base; Step 5 moved them down by 6 lines). The Before block matches once.

Before:
```json
      "tooLong": "Feedback must be less than 1000 characters."
    }
  },
  "admin": {
```
After:
```json
      "tooLong": "Feedback must be less than 1000 characters."
    }
  },
  "calendarHome": {
    "header": {
      "send": "Send to chat",
      "menu": "Menu"
    },
    "send": {
      "title": "Send to chat",
      "subtitle": "FamCal sends it to your chat",
      "today": "Today’s summary",
      "todayHint": "Events and reminders for today",
      "tomorrow": "Tomorrow’s summary",
      "tomorrowHint": "What’s coming up tomorrow",
      "thisWeek": "This week",
      "thisWeekHint": "Coming up this week",
      "nextWeek": "Next week",
      "nextWeekHint": "Coming up next week",
      "weather": "Weather",
      "weatherHint": "Today’s forecast",
      "sending": "Sending…",
      "sent": "Sent. Check your chat",
      "sentWhatsApp": "Sent to WhatsApp",
      "busy": "Lots of requests right now. Try again in a minute.",
      "failed": "Couldn’t send it. Try again.",
      "signedOut": "Please reopen FamCal from the chat and try again.",
      "offline": "No connection. Check your internet and try again."
    },
    "menu": {
      "settings": "Settings",
      "calendars": "Calendars",
      "partner": "Partner",
      "chooseCalendars": "Choose calendars",
      "reconnectGoogle": "Reconnect Google",
      "subscription": "Subscription",
      "refresh": "Refresh",
      "feedback": "Feedback",
      "admin": "Admin panel"
    },
    "banner": {
      "trial": "{count, plural, one {# day left in your trial} other {# days left in your trial}}",
      "trialAction": "See plans",
      "location": "Set your location for the right times",
      "locationAction": "Set location",
      "connectGoogle": "Connect Google Calendar",
      "connectGoogleBody": "Your calendar shows up here once it’s connected.",
      "chooseCalendars": "Choose your calendars",
      "chooseCalendarsBody": "Pick the Google calendars to show here and in your summaries.",
      "reconnect": "Your Google connection expired",
      "reconnectBody": "Reconnect to see your Google calendar here again.",
      "reconnectScopes": "FamCal needs permission to read your calendar",
      "reconnectScopesBody": "Reconnect Google and allow access to your calendar.",
      "reconnectAction": "Reconnect Google",
      "openInTelegram": "Open FamCal in Telegram",
      "openInTelegramBody": "Reminders, voice summaries and more are waiting there."
    },
    "state": {
      "partial": "Some calendars didn’t load",
      "unavailable": "{count, plural, one {# calendar isn’t available} other {# calendars aren’t available}}",
      "googleError": "Couldn’t load Google Calendar",
      "calendarsGone": "Your calendars aren’t available",
      "famcalError": "Couldn’t load your calendar",
      "busy": "Busy right now, try again in a minute",
      "errorTitle": "Something went wrong",
      "errorBody": "Your calendar didn’t load. Try again."
    },
    "actions": {
      "retry": "Retry",
      "chooseAgain": "Choose again",
      "close": "Close",
      "reload": "Reload"
    },
    "errorBoundary": {
      "title": "Something went wrong",
      "body": "The calendar ran into a problem. Reloading usually fixes it."
    },
    "shell": {
      "loading": "Loading your calendar…",
      "timesIn": "Times in {zone}"
    },
    "agenda": {
      "today": "Today",
      "tomorrow": "Tomorrow",
      "nothingPlanned": "Nothing planned",
      "nothingPlannedRange": "Nothing planned {range}",
      "showNextWeek": "Show next week"
    },
    "stillOpen": {
      "title": "Still open",
      "count": "{count, plural, one {# reminder} other {# reminders}}",
      "more": "{count} more",
      "sinceTime": "Since {time}",
      "sinceYesterday": "Since yesterday",
      "sinceWeekday": "{weekday, select, sun {Since Sunday} mon {Since Monday} tue {Since Tuesday} wed {Since Wednesday} thu {Since Thursday} fri {Since Friday} sat {Since Saturday} other {}}",
      "sinceDate": "Since {date}"
    },
    "row": {
      "allDay": "All day",
      "until": "until {when}",
      "continues": "continues",
      "noTitle": "(No title)",
      "reminder": "Reminder",
      "open": "Open",
      "done": "done",
      "everyDay": "every day",
      "repeats": "repeats",
      "snoozedUntil": "until {time}",
      "snoozedLabel": "Snoozed until {time}",
      "birthday": "Birthday",
      "googleCalendar": "Google · {calendar}"
    },
    "person": {
      "from": "From {name}",
      "for": "For {name}"
    },
    "sheet": {
      "label": "Details",
      "calendar": "Calendar",
      "partnerCalendar": "{name}’s calendar",
      "location": "Location",
      "notes": "Notes",
      "repeats": "Repeats",
      "everyDay": "Every day",
      "stateOpen": "Not done yet",
      "stateDone": "Done",
      "stateDoneAt": "Done at {time}",
      "stateSnoozed": "Snoozed until {time}",
      "stateLater": "Not due yet",
      "openInGoogle": "Open in Google Calendar"
    },
    "empty": {
      "title": "Nothing planned",
      "hintEvents": "To add an event, send the bot a voice message, forward it a message, or share a photo of an invitation.",
      "hintReminders": "For a reminder, just tell the bot, like “Remind me to call Grandma at 6”."
    },
    "hebrewMonthGenitive": ["Tishrei", "Cheshvan", "Kislev", "Tevet", "Sh'vat", "Adar", "Adar I", "Adar II", "Nisan", "Iyyar", "Sivan", "Tamuz", "Av", "Elul"]
  },
  "admin": {
```

- [ ] **Step 7: Add the `calendarHome` namespace to `messages/he.json`**

Same place. The Before block matches once.

Before:
```json
      "tooLong": "המשוב חייב להיות פחות מ-1000 תווים."
    }
  },
  "admin": {
```
After:
```json
      "tooLong": "המשוב חייב להיות פחות מ-1000 תווים."
    }
  },
  "calendarHome": {
    "header": {
      "send": "שליחה לצ׳אט",
      "menu": "תפריט"
    },
    "send": {
      "title": "שליחה לצ׳אט",
      "subtitle": "FamCal ישלח לך את זה בצ׳אט",
      "today": "הסיכום של היום",
      "todayHint": "האירועים והתזכורות של היום",
      "tomorrow": "הסיכום של מחר",
      "tomorrowHint": "מה מחכה מחר",
      "thisWeek": "השבוע",
      "thisWeekHint": "מה עוד מחכה השבוע",
      "nextWeek": "השבוע הבא",
      "nextWeekHint": "מה מתוכנן לשבוע הבא",
      "weather": "מזג אוויר",
      "weatherHint": "התחזית להיום",
      "sending": "שולחים…",
      "sent": "נשלח. אפשר להציץ בצ׳אט",
      "sentWhatsApp": "נשלח לוואטסאפ",
      "busy": "יש עומס כרגע. כדאי לנסות שוב בעוד דקה.",
      "failed": "השליחה לא הצליחה. כדאי לנסות שוב.",
      "signedOut": "צריך לפתוח את FamCal מחדש מהצ׳אט ולנסות שוב.",
      "offline": "אין חיבור לאינטרנט. כדאי לבדוק את החיבור ולנסות שוב."
    },
    "menu": {
      "settings": "הגדרות",
      "calendars": "יומנים",
      "partner": "שיתוף עם פרטנר",
      "chooseCalendars": "בחירת יומנים",
      "reconnectGoogle": "חיבור מחדש ל-Google",
      "subscription": "מנוי",
      "refresh": "רענון",
      "feedback": "משוב",
      "admin": "פאנל ניהול"
    },
    "banner": {
      "trial": "{count, plural, one {נשאר יום אחד לתקופת הניסיון} two {נשארו יומיים לתקופת הניסיון} other {נשארו # ימים לתקופת הניסיון}}",
      "trialAction": "לתוכניות",
      "location": "כדאי להגדיר מיקום כדי שהשעות יהיו נכונות",
      "locationAction": "להגדרת מיקום",
      "connectGoogle": "חיבור ליומן Google",
      "connectGoogleBody": "אחרי החיבור, היומן יופיע כאן.",
      "chooseCalendars": "בחירת יומנים",
      "chooseCalendarsBody": "אילו יומני Google להציג כאן ובסיכומים?",
      "reconnect": "פג התוקף של החיבור ל-Google",
      "reconnectBody": "צריך להתחבר מחדש כדי לראות כאן שוב את היומן של Google.",
      "reconnectScopes": "FamCal צריך הרשאה לקרוא את היומן",
      "reconnectScopesBody": "צריך להתחבר מחדש ל-Google ולאשר גישה ליומן.",
      "reconnectAction": "חיבור מחדש ל-Google",
      "openInTelegram": "לפתוח את FamCal בטלגרם",
      "openInTelegramBody": "שם מחכים תזכורות, סיכומים קוליים ועוד."
    },
    "state": {
      "partial": "חלק מהיומנים לא נטענו",
      "unavailable": "{count, plural, one {יומן אחד לא זמין} two {שני יומנים לא זמינים} other {# יומנים לא זמינים}}",
      "googleError": "לא הצלחנו לטעון את יומן Google",
      "calendarsGone": "היומנים שלך לא זמינים",
      "famcalError": "לא הצלחנו לטעון את היומן",
      "busy": "יש עומס כרגע, כדאי לנסות שוב בעוד דקה",
      "errorTitle": "משהו השתבש",
      "errorBody": "היומן לא נטען. כדאי לנסות שוב."
    },
    "actions": {
      "retry": "לנסות שוב",
      "chooseAgain": "לבחור שוב",
      "close": "סגירה",
      "reload": "לטעון מחדש"
    },
    "errorBoundary": {
      "title": "משהו השתבש",
      "body": "היומן נתקע. טעינה מחדש בדרך כלל עוזרת."
    },
    "shell": {
      "loading": "היומן נטען…",
      "timesIn": "השעות לפי {zone}"
    },
    "agenda": {
      "today": "היום",
      "tomorrow": "מחר",
      "nothingPlanned": "אין אירועים",
      "nothingPlannedRange": "אין אירועים ב{range}",
      "showNextWeek": "להציג את השבוע הבא"
    },
    "stillOpen": {
      "title": "עדיין פתוחות",
      "count": "{count, plural, one {תזכורת אחת} two {שתי תזכורות} other {# תזכורות}}",
      "more": "{count, plural, one {ועוד אחת} two {ועוד שתיים} other {ועוד #}}",
      "sinceTime": "מהשעה {time}",
      "sinceYesterday": "מאתמול",
      "sinceWeekday": "{weekday, select, sun {מיום ראשון} mon {מיום שני} tue {מיום שלישי} wed {מיום רביעי} thu {מיום חמישי} fri {מיום שישי} sat {משבת} other {}}",
      "sinceDate": "מ-{date}"
    },
    "row": {
      "allDay": "כל היום",
      "until": "עד {when}",
      "continues": "נמשך",
      "noTitle": "(ללא כותרת)",
      "reminder": "תזכורת",
      "open": "פתוחה",
      "done": "בוצעה",
      "everyDay": "כל יום",
      "repeats": "קבועה",
      "snoozedUntil": "עד {time}",
      "snoozedLabel": "נדחתה עד {time}",
      "birthday": "יום הולדת",
      "googleCalendar": "Google · {calendar}"
    },
    "person": {
      "from": "מאת {name}",
      "for": "בשביל {name}"
    },
    "sheet": {
      "label": "פרטים",
      "calendar": "יומן",
      "partnerCalendar": "היומן של {name}",
      "location": "מיקום",
      "notes": "הערות",
      "repeats": "חלק מסדרה",
      "everyDay": "בכל יום",
      "stateOpen": "עדיין לא בוצעה",
      "stateDone": "בוצעה",
      "stateDoneAt": "בוצעה ב-{time}",
      "stateSnoozed": "נדחתה עד {time}",
      "stateLater": "עוד לא הגיע הזמן",
      "openInGoogle": "פתיחה ביומן Google"
    },
    "empty": {
      "title": "אין אירועים",
      "hintEvents": "כדי להוסיף אירוע, אפשר לשלוח לבוט הודעה קולית, להעביר אליו הודעה או לשתף צילום של הזמנה.",
      "hintReminders": "לתזכורת, פשוט כותבים לבוט, למשל: \"תזכיר לי להתקשר לסבתא בשש\"."
    },
    "hebrewMonthGenitive": ["תשרי", "חשון", "כסלו", "טבת", "שבט", "אדר", "אדר א׳", "אדר ב׳", "ניסן", "אייר", "סיון", "תמוז", "אב", "אלול"]
  },
  "admin": {
```

- [ ] **Step 8: Add the `calendarHome` namespace to `messages/ru.json`**

Same place. The Before block matches once.

Before:
```json
      "tooLong": "Отзыв должен содержать менее 1000 символов."
    }
  },
  "admin": {
```
After:
```json
      "tooLong": "Отзыв должен содержать менее 1000 символов."
    }
  },
  "calendarHome": {
    "header": {
      "send": "Отправить в чат",
      "menu": "Меню"
    },
    "send": {
      "title": "Отправить в чат",
      "subtitle": "FamCal пришлёт это в ваш чат",
      "today": "Сводка на сегодня",
      "todayHint": "События и напоминания на сегодня",
      "tomorrow": "Сводка на завтра",
      "tomorrowHint": "Что ждёт завтра",
      "thisWeek": "Эта неделя",
      "thisWeekHint": "Что ещё впереди на этой неделе",
      "nextWeek": "Следующая неделя",
      "nextWeekHint": "Что запланировано на следующую неделю",
      "weather": "Погода",
      "weatherHint": "Прогноз на сегодня",
      "sending": "Отправляем…",
      "sent": "Отправлено, загляните в чат",
      "sentWhatsApp": "Отправлено в WhatsApp",
      "busy": "Сейчас много запросов. Попробуйте через минуту.",
      "failed": "Не получилось отправить. Попробуйте ещё раз.",
      "signedOut": "Откройте FamCal заново из чата и попробуйте ещё раз.",
      "offline": "Нет соединения. Проверьте интернет и попробуйте ещё раз."
    },
    "menu": {
      "settings": "Настройки",
      "calendars": "Календари",
      "partner": "Партнёр",
      "chooseCalendars": "Выбрать календари",
      "reconnectGoogle": "Переподключить Google",
      "subscription": "Подписка",
      "refresh": "Обновить",
      "feedback": "Обратная связь",
      "admin": "Панель администратора"
    },
    "banner": {
      "trial": "{count, plural, one {До конца пробного периода # день} few {До конца пробного периода # дня} many {До конца пробного периода # дней} other {До конца пробного периода # дня}}",
      "trialAction": "Тарифы",
      "location": "Укажите свой город, чтобы время было верным",
      "locationAction": "Указать",
      "connectGoogle": "Подключите Google Календарь",
      "connectGoogleBody": "После подключения календарь появится здесь.",
      "chooseCalendars": "Выберите календари",
      "chooseCalendarsBody": "Отметьте, какие календари Google показывать здесь и в сводках.",
      "reconnect": "Доступ к Google истёк",
      "reconnectBody": "Подключитесь заново, чтобы снова видеть здесь календарь Google.",
      "reconnectScopes": "FamCal нужен доступ к вашему календарю",
      "reconnectScopesBody": "Подключите Google заново и разрешите доступ к календарю.",
      "reconnectAction": "Переподключить Google",
      "openInTelegram": "Открыть FamCal в Telegram",
      "openInTelegramBody": "Там напоминания, голосовые сводки и многое другое."
    },
    "state": {
      "partial": "Часть календарей не загрузилась",
      "unavailable": "{count, plural, one {# календарь недоступен} few {# календаря недоступны} many {# календарей недоступны} other {# календаря недоступны}}",
      "googleError": "Не удалось загрузить Google Календарь",
      "calendarsGone": "Ваши календари недоступны",
      "famcalError": "Не удалось загрузить календарь",
      "busy": "Сейчас много запросов, попробуйте через минуту",
      "errorTitle": "Что-то пошло не так",
      "errorBody": "Календарь не загрузился. Попробуйте ещё раз."
    },
    "actions": {
      "retry": "Повторить",
      "chooseAgain": "Выбрать заново",
      "close": "Закрыть",
      "reload": "Перезагрузить"
    },
    "errorBoundary": {
      "title": "Что-то пошло не так",
      "body": "В календаре произошёл сбой. Обычно помогает перезагрузка."
    },
    "shell": {
      "loading": "Загружаем календарь…",
      "timesIn": "Часовой пояс: {zone}"
    },
    "agenda": {
      "today": "Сегодня",
      "tomorrow": "Завтра",
      "nothingPlanned": "Ничего не запланировано",
      "nothingPlannedRange": "Ничего не запланировано: {range}",
      "showNextWeek": "Показать следующую неделю"
    },
    "stillOpen": {
      "title": "Невыполненные",
      "count": "{count, plural, one {# напоминание} few {# напоминания} many {# напоминаний} other {# напоминания}}",
      "more": "Ещё {count}",
      "sinceTime": "С {time}",
      "sinceYesterday": "Со вчерашнего дня",
      "sinceWeekday": "{weekday, select, sun {С воскресенья} mon {С понедельника} tue {Со вторника} wed {Со среды} thu {С четверга} fri {С пятницы} sat {С субботы} other {}}",
      "sinceDate": "С {date}"
    },
    "row": {
      "allDay": "Весь день",
      "until": "до {when}",
      "continues": "продолжается",
      "noTitle": "(Без названия)",
      "reminder": "Напоминание",
      "open": "Не выполнено",
      "done": "выполнено",
      "everyDay": "каждый день",
      "repeats": "повторяется",
      "snoozedUntil": "до {time}",
      "snoozedLabel": "Отложено до {time}",
      "birthday": "День рождения",
      "googleCalendar": "Google · {calendar}"
    },
    "person": {
      "from": "От: {name}",
      "for": "Кому: {name}"
    },
    "sheet": {
      "label": "Подробности",
      "calendar": "Календарь",
      "partnerCalendar": "{name} (личный)",
      "location": "Место",
      "notes": "Заметки",
      "repeats": "Повторяется",
      "everyDay": "Каждый день",
      "stateOpen": "Ещё не выполнено",
      "stateDone": "Выполнено",
      "stateDoneAt": "Выполнено в {time}",
      "stateSnoozed": "Отложено до {time}",
      "stateLater": "Время ещё не пришло",
      "openInGoogle": "Открыть в Google Календаре"
    },
    "empty": {
      "title": "Ничего не запланировано",
      "hintEvents": "Чтобы добавить событие, отправьте боту голосовое сообщение, перешлите ему сообщение или пришлите фото приглашения.",
      "hintReminders": "Для напоминания просто напишите боту, например: «Напомни позвонить бабушке в шесть»."
    },
    "hebrewMonthGenitive": ["тишрея", "хешвана", "кислева", "тевета", "швата", "адара", "адара I", "адара II", "нисана", "ияра", "сивана", "тамуза", "ава", "элула"]
  },
  "admin": {
```

- [ ] **Step 9: Translate the Header (`components/Layout/Header.tsx`)**

Seven edits; each Before block matches once. The badge keeps its upper-case look through CSS, so the message can be "Admin" / "אדמין" / "Админ".

Edit 1. Before:
```tsx
import { Crown, Settings, ArrowLeft } from 'lucide-react';
```
After:
```tsx
import { useTranslations } from 'next-intl';
import { Crown, Settings, ArrowLeft } from 'lucide-react';
```

Edit 2. Before:
```tsx
}: HeaderProps) {
  const bgGradient = 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)';
```
After:
```tsx
}: HeaderProps) {
  const t = useTranslations('common.header');
  const bgGradient = 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)';
```

Edit 3. Before:
```tsx
          font-weight: 700;
          letter-spacing: 1px;
        }
```
After:
```tsx
          font-weight: 700;
          letter-spacing: 1px;
          text-transform: uppercase;
        }
```

Edit 4. Before:
```tsx
            aria-label="Go Back"
```
After:
```tsx
            aria-label={t('back')}
```

Edit 5. Before:
```tsx
        {isAdmin && <div className="admin-badge">ADMIN</div>}
```
After:
```tsx
        {isAdmin && <div className="admin-badge">{t('adminBadge')}</div>}
```

Edit 6. Before:
```tsx
            aria-label="Admin Panel"
```
After:
```tsx
            aria-label={t('adminPanel')}
```

Edit 7. Before:
```tsx
            aria-label="Settings"
```
After:
```tsx
            aria-label={t('settings')}
```

- [ ] **Step 10: Translate the dashboard loader (`app/[locale]/dashboard/TelegramDashboardRedirect.tsx`)**

Three edits; each Before block matches once. `useTranslations` goes before the early `if (gate)` return, with the other hooks.

Edit 1. Before:
```tsx
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
```
After:
```tsx
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
```

Edit 2. Before:
```tsx
  const router = useRouter();
  // No Telegram user to send on: PageGate's card, in a browser or inside Telegram
```
After:
```tsx
  const router = useRouter();
  const t = useTranslations('pageGate');
  // No Telegram user to send on: PageGate's card, in a browser or inside Telegram
```

Edit 3. Before:
```tsx
        <h2 style={{ fontSize: '24px', fontWeight: '500' }}>Loading Dashboard...</h2>
```
After:
```tsx
        <h2 style={{ fontSize: '24px', fontWeight: '500' }}>{t('loading')}</h2>
```

- [ ] **Step 11: Translate the old home's Free badge (`app/[locale]/dashboard/DashboardClient.tsx:752`)**

`tSub` is the file's existing `useTranslations('subscription')` (`:59`). The Before block matches once.

Before:
```tsx
                        <span className="subscription-badge free">Free</span>
```
After:
```tsx
                        <span className="subscription-badge free">{tSub('plans.free.name')}</span>
```

- [ ] **Step 12: Run the smoke under both clocks and see it pass**

```bash
for tz in UTC Asia/Jerusalem; do
  eval "env TZ=$tz $E npx tsx scripts/smoke-calendar-home-copy.ts"; echo "smoke-calendar-home-copy TZ=$tz exit $?"
done
```
Expected, in both timezones: 14 `OK` lines, `14/14 passed`, then `exit 0`.

- [ ] **Step 13: Run the regression smokes again**

Run Step 3's loop. Expected: the same counts, every one `exit 0`, except that `check-i18n-parity` now prints `i18n parity OK (996 keys)`.

- [ ] **Step 14: Type-check and lint**

```bash
npx tsc --noEmit -p .; echo "tsc exit $?"
npm run -s lint; echo "lint exit $?"
```
Expected: no output from either, then `tsc exit 0` and `lint exit 0`.

- [ ] **Step 15: Commit**

```bash
git add messages/en.json messages/he.json messages/ru.json scripts/check-i18n-parity.ts scripts/smoke-calendar-home-copy.ts components/Layout/Header.tsx 'app/[locale]/dashboard/TelegramDashboardRedirect.tsx' 'app/[locale]/dashboard/DashboardClient.tsx'
git commit -m "$(cat <<'EOF'
feat(calendar-home): the home's copy in en/he/ru, the translated Header and loader, ICU parity

A calendarHome namespace in messages/{en,he,ru}.json holds every string the
new home shows: the header, the send sheet and its results (R5), the menu (R6),
the states and banners of spec section 5, the Agenda's day labels and fold
lines, the still-open card, the rows, the item sheet, the empty state with its
plan-aware hints (R10), and the 14 Hebrew month names, genitive in Russian
(R9). The copy is natural and gender-neutral in each language, with ICU
plurals. It is its own top-level object between dashboard and admin. Nothing
reads it yet.

For everyone (spec section 9): the Header's aria-labels and admin badge (old
home, Subscription, Select calendars), the dashboard loader's "Loading
Dashboard..." and the old home's "Free" badge are now translated.

check-i18n-parity now compares ICU arguments, nested ones included, and fails
a message ICU can't parse, a select with no "other" form, and a plural that
lacks a form its language uses or gives one it never uses. It takes an
optional messages directory. smoke-calendar-home-copy pins the key list the
later tasks use.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
EOF
)"
```

---

### Task 2 (D2): Hebrew dates (spec §7.8: the library, the day-key rule and the day format)

> **Interface changes versus the split (read these first; D1, D5 and D6 depend on them):**
> 1. **`hebrewFullDate` takes the same optional `genitive` as `hebrewDayLabel`:** `hebrewFullDate(dayKey, lang, genitive?)`. The split lists `hebrewFullDate(dayKey, lang)`, but its own Russian example, "4 хешвана 5787", needs the genitive list, and that list lives in `messages/ru.json` (§7.8), which a pure module doesn't read. Without the list, Russian gets the nominative ("4 Хешван 5787"). D6's header passes the list.
> 2. **New export `HEBREW_MONTHS` fixes the order of `calendarHome.hebrewMonthGenitive`.** The split says "an array of 14 month names" but not in which order. This task sets it: Tishrei, Cheshvan, Kislev, Tevet, Sh'vat, Adar, Adar I, Adar II, Nisan, Iyyar, Sivan, Tamuz, Av, Elul (the year from Tishrei; the plain Adar of a common year before the leap year's Adar I and Adar II). **D1 must write all three lists in this order.** Russian: `["тишрея", "хешвана", "кислева", "тевета", "швата", "адара", "адара I", "адара II", "нисана", "ияра", "сивана", "тамуза", "ава", "элула"]`, or other natural genitives in the same order. This task's smoke checks D1's Russian list against `HEBREW_MONTHS`.
> 3. **`lang` is a `string`** (the page's locale). Anything other than `'he'` and `'ru'` reads English. Both functions return `''` for a key that isn't a real `yyyy-MM-dd` day; they never throw during a render.

**What and why:** The home shows the Hebrew date under its header ("Thursday, 15 October" over "4 Cheshvan 5787") and beside each Agenda day ("4 Cheshvan"), when the route's `hebrewDates` is true (B2's `hebrewDatesFor` decides that; this task doesn't). This task adds the pure, client-safe helper both use, `src/lib/calendar-view/hebrew-date.ts`, and the dependency it needs:
- **Per language (§7.8):** Hebrew gives the gematriya day, "ב" and the month without nikud, then the gematriya year ("ד׳ בחשון תשפ״ז"). English gives the number and hebcal's month name ("4 Cheshvan 5787"). Russian gives the genitive from `calendarHome.hebrewMonthGenitive` ("4 хешвана 5787", Ruling R9).
- **The day-key rule:** each `HDate` comes from `new Date(y, m - 1, d)` of a day key, never from an instant. So the device's clock can't move the date, and it is the daytime Hebrew date, with no sunset shift.
- **The dependency:** `@hebcal/hdate` becomes a direct dependency pinned to `^0.21.1`, the copy `@hebcal/core` 6.0.6 and `@hebcal/locales` 6.3.0 already resolve. A plain `npm i @hebcal/hdate` would take 0.23 and nest separate 0.21.1 copies under core and locales. `@hebcal/locales/ru` would then register Russian on a different `Locale`, and the bot's Russian Hebrew month names (`src/services/claude.ts:46`) would fall back to English.

The home's bundle gets `@hebcal/hdate` and the Russian names only, never `@hebcal/core`. Nothing renders this yet (D5 and D6 do), and the switch stays `OFF`. `DashboardClient` keeps its own `@hebcal/core` dates.

**Files:**
- Modify: `package.json:36-37`: one line, `"@hebcal/hdate": "^0.21.1",`, between `"@hebcal/core"` (`:36`) and `"@hebcal/locales"` (`:37`). npm writes it (Step 3).
- Modify: `package-lock.json:15-16`: the same line in the root package's `dependencies`, between `:15` and `:16`. npm writes it (Step 3).
- Create: `src/lib/calendar-view/hebrew-date.ts`
- Create (test): `scripts/smoke-hebrew-date.ts`
- Test: `scripts/smoke-hebrew-date.ts`
- Regression (unchanged): `scripts/smoke-weather-prompt.ts` and `scripts/smoke-weather-command.ts` (today's users of `@hebcal/hdate` and `@hebcal/core` under tsx), `scripts/check-i18n-parity.ts`

**Interfaces:**
- Consumes:
  - from B3, `src/lib/calendar-view/types.ts`: `export type DayKey = string;` ('yyyy-MM-dd' in the viewer's timezone);
  - `@hebcal/hdate` 0.21.1: `new HDate(date: Date)`, `getDate()`, `getMonthName(): MonthName`, `getFullYear()`, `Locale.lookupTranslation(id: string, locale?: string): string | undefined`, `Locale.gettext`, `Locale.hebrewStripNikkud`, `gematriya(num: number | string): string`, `type MonthName`;
  - `@hebcal/locales/ru`, for its side effect: `Locale.addLocale('ru', …)` on the shared `@hebcal/hdate`;
  - from D1: `calendarHome.hebrewMonthGenitive` in `messages/ru.json` (14 strings in `HEBREW_MONTHS` order). The module never reads messages. The callers pass the list, and the smoke reads the file.
- Produces (`src/lib/calendar-view/hebrew-date.ts`):
  - `export const HEBREW_MONTHS: readonly ['Tishrei', 'Cheshvan', 'Kislev', 'Tevet', "Sh'vat", 'Adar', 'Adar I', 'Adar II', 'Nisan', 'Iyyar', 'Sivan', 'Tamuz', 'Av', 'Elul']`
  - `export function hebrewDayLabel(dayKey: DayKey, lang: string, genitive?: readonly string[]): string`: "4 Cheshvan" / "ד׳ בחשון" / "4 хешвана"
  - `export function hebrewFullDate(dayKey: DayKey, lang: string, genitive?: readonly string[]): string`: "4 Cheshvan 5787" / "ד׳ בחשון תשפ״ז" / "4 хешвана 5787"
  - D5 and D6 call them like this, in client components with `const t = useTranslations('calendarHome')`:
    ```ts
    const genitive = t.raw('hebrewMonthGenitive') as string[];   // the pattern of app/[locale]/how-it-works/page.tsx:46
    // D6, the header, only when the RangeResponse's hebrewDates is true:
    hebrewFullDate(today, locale, genitive);       // "4 Cheshvan 5787"
    // D5, each Agenda day header, only when hebrewDates is true:
    hebrewDayLabel(day.date, locale, genitive);    // "4 Cheshvan"
    ```
    Pass the server's `today` and the store's day keys, never a `new Date()`. An empty string means "render nothing".

**Findings that shaped the code:**
- **The dependency step, measured.** In a full `node_modules` built with `npm ci` from the lock (blob 62d1f27, the same file on the scratch base 63e7d4f and on the real base; npm 11.20.0, Node 26.11.1), `npm install @hebcal/hdate@^0.21.1 --no-audit --no-fund` changed exactly one line in `package.json` and one in `package-lock.json`. `npm ls @hebcal/hdate` then showed one copy, deduped under core and locales. 0.21.1 is the newest 0.21 release; the newest overall is 0.23.1. Don't use `--package-lock-only`: without a `node_modules` it also rewrote unrelated optional entries (`"dev": true` on `@emnapi/*` and bundled entries under `@tailwindcss/oxide-wasm32-wasi`).
- **Already imported without being declared:** `src/services/weather/formatter.ts:7` imports `gematriya` from `@hebcal/hdate` today, through hoisting. The direct dependency covers that import too. It changes nothing at runtime, because the installed tree stays the same.
- **Where the names come from:**
  - `he` and `he-x-NoNikud` ship inside `@hebcal/hdate`: `Locale.lookupTranslation('Cheshvan', 'he-x-NoNikud')` is `'חשון'`.
  - `ru` exists only after `import '@hebcal/locales/ru'`, which gives `'Хешван'`.
  - English names are `getMonthName()`: "Sh'vat", "Iyyar", "Tamuz", "Adar I", "Adar II".
  - Hebrew Adar I and II without nikud are "אדר א׳" and "אדר ב׳".
  - `gematriya(5787)` is `'תשפ״ז'` (no thousands); 15 and 16 are `'ט״ו'` and `'ט״ז'`; 30 is `'ל׳'`.
- **A day key, never an instant:**
  - `new Date('2026-10-15')` is UTC midnight. That is still 14 October in Los Angeles, so the date would read "3 Cheshvan".
  - `new Date(y, m - 1, d)` is local midnight of the day, and `HDate` reads the local year, month and day back. In America/Santiago, 2026-09-06 has no 00:00 (DST starts at midnight); `new Date(2026, 8, 6)` is then 01:00 the same day, which is still right.
  - The smoke switches `process.env.TZ` inside the process (Node re-reads the zone on assignment) across five zones. It is also run under four clocks. UTC, Jerusalem and Kiritimati alone don't catch the instant mistake; Los Angeles does.
- **tsx and the `Locale` identity check:**
  - Under tsx, `await import('@hebcal/core')` gives a second `Locale` even with one copy installed. The script runs as CommonJS, so tsx compiles `@hebcal/hdate`'s ESM files into the require cache, while `import()` goes through Node's ESM loader.
  - The smoke loads core with `require` instead. The `_resolveFilename` redirect to `dist/esm/index.js` is the one other smokes use (`smoke-weather-prompt.ts:28-35`), so core and `hebrew-date.ts` share the require cache, and `core.Locale === Locale`.
  - A nested copy breaks it: under `@hebcal/core`, core gets its own `Locale`; under `@hebcal/locales`, `ru` lands on a copy the home never reads. The lock and `node_modules` checks look for nested copies directly too, because Railway installs from the lock.
- **The Russian fallback:** with no list, or a list that isn't 14 non-empty strings, Russian gets the nominative from `@hebcal/locales` ("4 Хешван"), which is what the bot prints today (`claude.ts:46`). A Russian reader never sees English, and nothing throws.
- **Bundle:** an esbuild browser bundle of the module, minified, is 28.0 KB (8.3 KB gzipped). Its 17 inputs all come from `@hebcal/hdate` and `@hebcal/locales/ru`. `@hebcal/locales` has no `"sideEffects": false`, so the bare import survives tree-shaking. `@hebcal/locales` ships no types, and a bare side-effect import type-checks anyway (TS 5.9.3; `noUncheckedSideEffectImports` is off).
- **Fixture years (from hebcal):**
  - 5784 is a deficient leap year (Cheshvan and Kislev both 29 days);
  - 5786 is regular (Cheshvan 29, Kislev 30; 354 days);
  - 5787 is a complete leap year (both 30; 385 days, with Adar I and Adar II);
  - 5788 is complete (355 days);
  - 15 October 2026 is 4 Cheshvan 5787, and 1 Tishrei 5787 is 12 September 2026.
- **Depends on D1** (execution order D1 → D2): check 11 reads `calendarHome.hebrewMonthGenitive` from `messages/ru.json`. If D1 isn't in, only that check fails, with "(Task D1 adds it)". The check accepts any natural genitive in `HEBREW_MONTHS` order: each entry must contain the month's Russian stem, and Adar I and Adar II must differ and come in order. It pins only "4 хешвана", Ruling R9's own example.
- **Verified:**
  - Base: `feat/calendar-home` after Plan C (verified on 2eb69df, Plan C's reference chain on 716a4f8, and again on 6dab367, the branch and `main` after Plan C, which differs from that chain only in files D doesn't touch; header, Planning Ruling 9), with D1's reference commit. The package lines apply there unchanged, and `npm ls @hebcal/hdate` shows one deduped 0.21.1.
  - The first pass, with the mutations below, ran on the scratch base 63e7d4f (header, Planning Ruling 9), plus a stand-in for D1: only `calendarHome.hebrewMonthGenitive` in the three message files, in `HEBREW_MONTHS` order (ru as in the box above). `check-i18n-parity` passed with it. The before and after results below hold on both.
  - Before: the smoke exits 1 with `Cannot find module '../src/lib/calendar-view/hebrew-date'` under all four clocks.
  - After: 14/14 under `TZ=UTC`, `Asia/Jerusalem`, `Pacific/Kiritimati` and `America/Los_Angeles`, and `tsc` and lint are clean. The two regression smokes printed the same lines before and after. `package.json` and `package-lock.json` matched the full-install result byte for byte.
  - Mutations caught (first pass): an instant (`Date.UTC`, or `new Date(dayKey)` under the Los Angeles clock); the Russian import removed; a Nisan-first `HEBREW_MONTHS`; nikud in Hebrew; no "ב"; a Gregorian year in Hebrew; the genitive read in English; a 13-entry list accepted; `2026-13-01` accepted; `@hebcal/core` imported by the module; the `package.json` line missing; a nested copy in the lock.

- [ ] **Step 1: Write the failing smoke `scripts/smoke-hebrew-date.ts`**

Create the file with exactly this content:

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
//
// It also guards the dependency. @hebcal/hdate is a direct dependency pinned to ^0.21.1,
// the one copy @hebcal/core and @hebcal/locales share. A second copy would register
// Russian on a different Locale, and the bot's Russian Hebrew month names
// (src/services/claude.ts:46) would fall back to English.
//
// Pure: no database, Redis, network or AI. Run it under four clocks:
//   TZ=UTC npx tsx scripts/smoke-hebrew-date.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-hebrew-date.ts
//   TZ=Pacific/Kiritimati npx tsx scripts/smoke-hebrew-date.ts
//   TZ=America/Los_Angeles npx tsx scripts/smoke-hebrew-date.ts

import fs from 'fs';
import path from 'path';
import Module from 'module';
import { HDate, Locale } from '@hebcal/hdate';
import { HEBREW_MONTHS, hebrewDayLabel, hebrewFullDate } from '../src/lib/calendar-view/hebrew-date';

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

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
}

/** A natural Russian genitive list in HEBREW_MONTHS order, so the checks don't depend on messages/ru.json. */
const RU_GENITIVE = [
  'тишрея', 'хешвана', 'кислева', 'тевета', 'швата', 'адара', 'адара I',
  'адара II', 'нисана', 'ияра', 'сивана', 'тамуза', 'ава', 'элула',
];

/** [day key, en, he, ru]: the day label in each language. */
type Row = [string, string, string, string];

function checkLabels(rows: Row[]) {
  for (const [key, en, he, ru] of rows) {
    assertEqual(hebrewDayLabel(key, 'en'), en, `${key} en`);
    assertEqual(hebrewDayLabel(key, 'he'), he, `${key} he`);
    assertEqual(hebrewDayLabel(key, 'ru', RU_GENITIVE), ru, `${key} ru`);
  }
}

function checkFull(rows: Row[]) {
  for (const [key, en, he, ru] of rows) {
    assertEqual(hebrewFullDate(key, 'en'), en, `${key} en`);
    assertEqual(hebrewFullDate(key, 'he'), he, `${key} he`);
    assertEqual(hebrewFullDate(key, 'ru', RU_GENITIVE), ru, `${key} ru`);
  }
}

/** The Gregorian day key of a Hebrew date, read the way hebcal hands it back (local midnight). */
function keyOf(hd: HDate): string {
  const d = hd.greg();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function main() {
  await check('15 October 2026 (a Thursday) is 4 Cheshvan 5787 in en, he and ru', () => {
    checkLabels([['2026-10-15', '4 Cheshvan', 'ד׳ בחשון', '4 хешвана']]);
    checkFull([['2026-10-15', '4 Cheshvan 5787', 'ד׳ בחשון תשפ״ז', '4 хешвана 5787']]);
  });

  await check("every month's name in each language, Adar I and Adar II 5787 and plain Adar 5786 included", () => {
    const rows: Row[] = [
      ['2026-09-12', '1 Tishrei', 'א׳ בתשרי', '1 тишрея'],
      ['2026-10-12', '1 Cheshvan', 'א׳ בחשון', '1 хешвана'],
      ['2026-11-11', '1 Kislev', 'א׳ בכסלו', '1 кислева'],
      ['2026-12-11', '1 Tevet', 'א׳ בטבת', '1 тевета'],
      ['2027-01-09', "1 Sh'vat", 'א׳ בשבט', '1 швата'],
      ['2026-02-18', '1 Adar', 'א׳ באדר', '1 адара'],
      ['2027-02-08', '1 Adar I', 'א׳ באדר א׳', '1 адара I'],
      ['2027-03-10', '1 Adar II', 'א׳ באדר ב׳', '1 адара II'],
      ['2027-04-08', '1 Nisan', 'א׳ בניסן', '1 нисана'],
      ['2027-05-08', '1 Iyyar', 'א׳ באייר', '1 ияра'],
      ['2027-06-06', '1 Sivan', 'א׳ בסיון', '1 сивана'],
      ['2027-07-06', '1 Tamuz', 'א׳ בתמוז', '1 тамуза'],
      ['2027-08-04', '1 Av', 'א׳ באב', '1 ава'],
      ['2027-09-03', '1 Elul', 'א׳ באלול', '1 элула'],
    ];
    checkLabels(rows);
    const reached = rows.map(([, en]) => en.replace(/^1 /, ''));
    assertEqual([...reached].sort(), [...HEBREW_MONTHS].sort(), 'the rows reach every entry of HEBREW_MONTHS once');
  });

  await check('Adar I and Adar II in 5787, a leap year: 30 days of Adar I, then Adar II, then Nisan; 5786 has one Adar', () => {
    checkFull([
      ['2027-03-09', '30 Adar I 5787', 'ל׳ באדר א׳ תשפ״ז', '30 адара I 5787'],
      ['2027-03-10', '1 Adar II 5787', 'א׳ באדר ב׳ תשפ״ז', '1 адара II 5787'],
      ['2027-03-23', '14 Adar II 5787', 'י״ד באדר ב׳ תשפ״ז', '14 адара II 5787'],
      ['2027-04-07', '29 Adar II 5787', 'כ״ט באדר ב׳ תשפ״ז', '29 адара II 5787'],
      ['2027-04-08', '1 Nisan 5787', 'א׳ בניסן תשפ״ז', '1 нисана 5787'],
      ['2026-03-03', '14 Adar 5786', 'י״ד באדר תשפ״ו', '14 адара 5786'],
    ]);
  });

  await check('Cheshvan and Kislev of 29 and 30 days (5786, 5787 and 5784)', () => {
    assert(HDate.daysInMonth(8, 5786) === 29 && HDate.daysInMonth(8, 5787) === 30, 'fixture: Cheshvan 5786 has 29 days, 5787 has 30');
    assert(HDate.daysInMonth(9, 5784) === 29 && HDate.daysInMonth(9, 5787) === 30, 'fixture: Kislev 5784 has 29 days, 5787 has 30');
    checkFull([
      ['2025-11-20', '29 Cheshvan 5786', 'כ״ט בחשון תשפ״ו', '29 хешвана 5786'],
      ['2025-11-21', '1 Kislev 5786', 'א׳ בכסלו תשפ״ו', '1 кислева 5786'],
      ['2026-11-10', '30 Cheshvan 5787', 'ל׳ בחשון תשפ״ז', '30 хешвана 5787'],
      ['2026-11-11', '1 Kislev 5787', 'א׳ בכסלו תשפ״ז', '1 кислева 5787'],
      ['2023-12-12', '29 Kislev 5784', 'כ״ט בכסלו תשפ״ד', '29 кислева 5784'],
      ['2023-12-13', '1 Tevet 5784', 'א׳ בטבת תשפ״ד', '1 тевета 5784'],
      ['2026-12-10', '30 Kislev 5787', 'ל׳ בכסלו תשפ״ז', '30 кислева 5787'],
      ['2026-12-11', '1 Tevet 5787', 'א׳ בטבת תשפ״ז', '1 тевета 5787'],
    ]);
  });

  await check('the Tishrei year boundary: 29 Elul 5786, then 1 Tishrei 5787', () => {
    checkFull([
      ['2026-09-11', '29 Elul 5786', 'כ״ט באלול תשפ״ו', '29 элула 5786'],
      ['2026-09-12', '1 Tishrei 5787', 'א׳ בתשרי תשפ״ז', '1 тишрея 5787'],
    ]);
  });

  await check('Hebrew days 15 and 16 are ט״ו and ט״ז', () => {
    assertEqual(hebrewDayLabel('2026-10-26', 'he'), 'ט״ו בחשון', '15 Cheshvan');
    assertEqual(hebrewDayLabel('2026-10-27', 'he'), 'ט״ז בחשון', '16 Cheshvan');
  });

  await check("every day from 1 Tishrei 5786 to 29 Elul 5788 matches hebcal's own calendar", () => {
    let hd = new HDate(1, 7, 5786);
    let days = 0;
    while (hd.getFullYear() <= 5788) {
      const key = keyOf(hd);
      const want = `${hd.getDate()} ${hd.getMonthName()} ${hd.getFullYear()}`;
      const got = hebrewFullDate(key, 'en');
      assert(got === want, `${key}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
      hd = hd.next();
      days++;
    }
    assert(days === 354 + 385 + 355, `walked ${days} days, want 1094 (5786: 354, 5787: 385, 5788: 355)`);
  });

  await check('the same labels on five device clocks: a day key is a calendar day, never an instant', () => {
    const keys = ['2026-10-15', '2026-09-11', '2026-09-12', '2027-03-10', '2026-03-27', '2026-11-01', '2026-09-06'];
    const labelsNow = () =>
      keys.flatMap(k => [hebrewFullDate(k, 'en'), hebrewFullDate(k, 'he'), hebrewFullDate(k, 'ru', RU_GENITIVE)]);
    const saved = process.env.TZ;
    try {
      process.env.TZ = 'UTC';
      const reference = labelsNow();
      assertEqual(reference.slice(0, 3), ['4 Cheshvan 5787', 'ד׳ בחשון תשפ״ז', '4 хешвана 5787'], 'reference under UTC');
      // Los Angeles is west of Greenwich (a UTC midnight is the day before there);
      // Kiritimati is UTC+14; Santiago has no 00:00 on 2026-09-06 (DST starts at midnight).
      for (const tz of ['Asia/Jerusalem', 'Pacific/Kiritimati', 'America/Los_Angeles', 'America/Santiago']) {
        process.env.TZ = tz;
        assertEqual(labelsNow(), reference, `labels with the clock in ${tz}`);
      }
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  });

  await check('Russian: the genitive list is read only in Russian; with no list or a broken one, the nominative', () => {
    for (const lang of ['en', 'he']) {
      assertEqual(hebrewDayLabel('2026-10-15', lang, RU_GENITIVE), hebrewDayLabel('2026-10-15', lang), `${lang} label ignores the list`);
      assertEqual(hebrewFullDate('2026-10-15', lang, RU_GENITIVE), hebrewFullDate('2026-10-15', lang), `${lang} full date ignores the list`);
    }
    // The nominative is today's bot wording (claude.ts:46), from @hebcal/locales.
    assertEqual(hebrewDayLabel('2026-10-15', 'ru'), '4 Хешван', 'ru without a list');
    assertEqual(hebrewFullDate('2026-10-15', 'ru'), '4 Хешван 5787', 'ru full date without a list');
    const broken: unknown[] = [RU_GENITIVE.slice(0, 13), RU_GENITIVE.map((s, i) => (i === 1 ? ' ' : s)), 'хешвана', {}, null];
    for (const list of broken) {
      assertEqual(hebrewDayLabel('2026-10-15', 'ru', list as string[]), '4 Хешван', `ru with ${JSON.stringify(list)}`);
    }
  });

  await check("an unknown language gets English; a day key that isn't a real day gets an empty string", () => {
    assertEqual(hebrewDayLabel('2026-10-15', 'de'), '4 Cheshvan', 'de');
    assertEqual(hebrewFullDate('2026-10-15', ''), '4 Cheshvan 5787', 'empty language');
    for (const key of ['', '2026-13-01', '2026-02-30', '2026-00-10', '15/10/2026', '2026-10-15T00:00', '0026-10-15']) {
      assertEqual(hebrewDayLabel(key, 'en'), '', `label of ${JSON.stringify(key)}`);
      assertEqual(hebrewFullDate(key, 'he'), '', `full date of ${JSON.stringify(key)}`);
    }
  });

  await check("messages/ru.json's calendarHome.hebrewMonthGenitive lines up with HEBREW_MONTHS (Task D1)", () => {
    const ru = readJson('messages/ru.json') as { calendarHome?: { hebrewMonthGenitive?: unknown } };
    const list = ru.calendarHome?.hebrewMonthGenitive;
    assert(Array.isArray(list), 'messages/ru.json has no calendarHome.hebrewMonthGenitive array (Task D1 adds it)');
    assert(list.length === 14, `the list has ${list.length} entries, want 14`);
    HEBREW_MONTHS.forEach((name, i) => {
      const entry = list[i];
      assert(typeof entry === 'string' && entry.trim() !== '', `entry ${i} (${name}) is empty`);
      // 'Тишрей' → 'тишре', 'Адар II' → 'адар': every genitive form starts from it.
      const nominative = Locale.lookupTranslation(name, 'ru') ?? '';
      const stem = nominative.split(' ')[0].toLowerCase().replace(/й$/, '');
      assert(stem !== '' && entry.toLowerCase().includes(stem), `entry ${i} is ${JSON.stringify(entry)}, not a form of ${nominative} (${name})`);
    });
    const [adar, adar1, adar2] = [list[5], list[6], list[7]];
    assert(new Set([adar, adar1, adar2]).size === 3, `Adar, Adar I and Adar II must differ: ${JSON.stringify([adar, adar1, adar2])}`);
    assert(/II|втор|бет/i.test(adar2) && !/II|втор|бет/i.test(adar1), `entry 6 must be Adar I and entry 7 Adar II: ${JSON.stringify([adar1, adar2])}`);
    assertEqual(hebrewDayLabel('2026-10-15', 'ru', list), '4 хешвана', 'the header day with the shipped list (R9)');
  });

  await check("one Locale: the Russian that hebrew-date.ts registers is what @hebcal/core sees ('Хешван')", () => {
    assertEqual(Locale.lookupTranslation('Cheshvan', 'ru'), 'Хешван', 'through @hebcal/hdate');
    // @hebcal/core ships ESM only with no require entry, and tsx loads this script as
    // CommonJS: load its ESM build through require, so it shares the require cache
    // (and @hebcal/hdate) with hebrew-date.ts. Nothing here imports @hebcal/locales itself.
    const internals = Module as unknown as { _resolveFilename: (request: string, parent: unknown, isMain: boolean) => string };
    const resolveFilename = internals._resolveFilename;
    internals._resolveFilename = function (request, parent, isMain) {
      if (request === '@hebcal/core') return path.join(ROOT, 'node_modules/@hebcal/core/dist/esm/index.js');
      return resolveFilename.call(this, request, parent, isMain);
    };
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const core = require('@hebcal/core') as typeof import('@hebcal/core');
      assert(core.Locale === Locale, '@hebcal/core has its own Locale: a second @hebcal/hdate is installed');
      assertEqual(core.Locale.lookupTranslation('Cheshvan', 'ru'), 'Хешван', 'through @hebcal/core');
    } finally {
      internals._resolveFilename = resolveFilename;
    }
  });

  await check('@hebcal/hdate is a direct dependency pinned to ^0.21.1, with one copy in the lock and in node_modules', () => {
    const pkg = readJson('package.json') as { dependencies?: Record<string, string> };
    assertEqual(pkg.dependencies?.['@hebcal/hdate'], '^0.21.1', 'package.json dependencies');
    const lock = readJson('package-lock.json') as { packages: Record<string, { version?: string; dependencies?: Record<string, string> }> };
    assertEqual(lock.packages['']?.dependencies?.['@hebcal/hdate'], '^0.21.1', 'package-lock.json root dependencies');
    const copies = Object.keys(lock.packages).filter(k => k.endsWith('node_modules/@hebcal/hdate'));
    assertEqual(copies, ['node_modules/@hebcal/hdate'], 'package-lock.json @hebcal/hdate entries');
    const locked = lock.packages['node_modules/@hebcal/hdate'].version ?? '';
    assert(/^0\.21\.([1-9]|\d{2,})$/.test(locked), `the lock has @hebcal/hdate ${locked}, want ^0.21.1`);
    const installed = (readJson('node_modules/@hebcal/hdate/package.json') as { version: string }).version;
    assertEqual(installed, locked, 'node_modules/@hebcal/hdate version');
    for (const owner of ['core', 'locales']) {
      const nested = path.join(ROOT, 'node_modules/@hebcal', owner, 'node_modules/@hebcal/hdate');
      assert(!fs.existsSync(nested), `@hebcal/${owner} has its own copy: ${nested}`);
    }
  });

  await check('hebrew-date.ts imports only @hebcal/hdate, @hebcal/locales/ru and the DTO types (no @hebcal/core on the home)', () => {
    const source = fs.readFileSync(path.join(ROOT, 'src/lib/calendar-view/hebrew-date.ts'), 'utf8');
    const imports = [...source.matchAll(/^import\s+(type\s+)?(?:[^'"]*?\s+from\s+)?'([^']+)';/gm)].map(m => `${m[1] ? 'type ' : ''}${m[2]}`);
    assertEqual(imports.sort(), ['@hebcal/hdate', '@hebcal/locales/ru', 'type ./types'], 'imports');
    assert(!/require\(|import\(/.test(source), 'no require() or import() in hebrew-date.ts');
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

- [ ] **Step 2: Run it and see it fail; record the regression smokes' baseline**

```bash
cd /Users/razielgershoni/development/famcalbot
for tz in UTC Asia/Jerusalem Pacific/Kiritimati America/Los_Angeles; do TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-hebrew-date.ts 2>&1 | grep '^Error'; echo "smoke-hebrew-date $tz exit=${pipestatus[1]}"; done
for f in smoke-weather-prompt smoke-weather-command; do for tz in UTC Asia/Jerusalem; do TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/$f.ts 2>&1 | grep -E '^(OK|FAIL)|passed' > /tmp/d2-$f-${tz//\//_}.before; echo "$f $tz exit=${pipestatus[1]} | $(tail -1 /tmp/d2-$f-${tz//\//_}.before)"; done; done
```
(Run it in zsh: `pipestatus` is zsh's; in bash it is `${PIPESTATUS[0]}`.)

Expected for the new smoke, under each clock:
```
Error: Cannot find module '../src/lib/calendar-view/hebrew-date'
smoke-hebrew-date UTC exit=1
```
and the same for `Asia/Jerusalem`, `Pacific/Kiritimati` and `America/Los_Angeles`. Why it fails: `hebrew-date.ts` doesn't exist yet, and the smoke imports it at the top, so no check runs.

Expected for the regression smokes: every run `exit=0`. `smoke-weather-prompt` ends `14/14 passed (process TZ=…)` and `smoke-weather-command` ends `10/10 passed`. The `/tmp/d2-*.before` files are the baseline for Step 5.

- [ ] **Step 3: Add `@hebcal/hdate` as a direct dependency**

`@hebcal/hdate` 0.21.1 is already installed at the top of `node_modules`, as a dependency of `@hebcal/core` and `@hebcal/locales`. This step only declares it. Pin the range on the command line: a bare `npm i @hebcal/hdate` would take 0.23.1 and nest a second copy.

```bash
cd /Users/razielgershoni/development/famcalbot
npm install @hebcal/hdate@^0.21.1 --no-audit --no-fund
git diff --stat package.json package-lock.json
git diff -U1 package.json package-lock.json | grep '^[+-] '
npm ls @hebcal/hdate
```
npm may print `EBADENGINE` warnings (`engines` asks for Node 22.x) and `install-scripts` warnings about other packages. They change nothing here.

Expected `git diff --stat`:
```
 package-lock.json | 1 +
 package.json      | 1 +
 2 files changed, 2 insertions(+)
```
Expected changed lines (the first from `package-lock.json:16`, the root package's `dependencies`; the second from `package.json:37`):
```
+        "@hebcal/hdate": "^0.21.1",
+    "@hebcal/hdate": "^0.21.1",
```
The exact `git diff package.json package-lock.json` it makes (recorded in Plan D's integration build, npm 11.20.0 and Node 26.11.1, on a fresh clone with the repo's `node_modules` cloned in; byte-identical to the hand edits below):
```diff
diff --git a/package-lock.json b/package-lock.json
index 62d1f27..d34d336 100644
--- a/package-lock.json
+++ b/package-lock.json
@@ -13,6 +13,7 @@
         "@google/genai": "^1.42.0",
         "@googleapis/calendar": "^9.7.9",
         "@hebcal/core": "^6.0.6",
+        "@hebcal/hdate": "^0.21.1",
         "@hebcal/locales": "^6.3.0",
         "@mdx-js/loader": "^3.1.1",
         "@mdx-js/react": "^3.1.1",
diff --git a/package.json b/package.json
index d69e04a..8e816f6 100644
--- a/package.json
+++ b/package.json
@@ -34,6 +34,7 @@
     "@google/genai": "^1.42.0",
     "@googleapis/calendar": "^9.7.9",
     "@hebcal/core": "^6.0.6",
+    "@hebcal/hdate": "^0.21.1",
     "@hebcal/locales": "^6.3.0",
     "@mdx-js/loader": "^3.1.1",
     "@mdx-js/react": "^3.1.1",
```
npm also printed `removed 5 packages, and changed 3 packages`: that `node_modules` held five optional wasm packages the lock doesn't install on macOS (`@emnapi/core`, `@emnapi/runtime`, `@emnapi/wasi-threads`, `@napi-rs/wasm-runtime`, `@tybys/wasm-util`). That touches `node_modules` only, never the two files.

Expected `npm ls @hebcal/hdate` (exit 0): one copy, deduped under core and locales:
```
famcalbot@1.0.0 /Users/razielgershoni/development/famcalbot
├─┬ @hebcal/core@6.0.6
│ └── @hebcal/hdate@0.21.1 deduped
├── @hebcal/hdate@0.21.1
└─┬ @hebcal/locales@6.3.0
  └── @hebcal/hdate@0.21.1 deduped
```
If `git diff --stat` shows anything else, or `npm ls` shows a second version, undo it with `git checkout -- package.json package-lock.json` and make the two one-line edits by hand, then run `npm ls @hebcal/hdate` again:

In `package.json` (`:36-37`), replace:
```json
    "@hebcal/core": "^6.0.6",
    "@hebcal/locales": "^6.3.0",
```
with:
```json
    "@hebcal/core": "^6.0.6",
    "@hebcal/hdate": "^0.21.1",
    "@hebcal/locales": "^6.3.0",
```
In `package-lock.json` (`:15-16`, the root package's `dependencies`), replace:
```json
        "@hebcal/core": "^6.0.6",
        "@hebcal/locales": "^6.3.0",
```
with:
```json
        "@hebcal/core": "^6.0.6",
        "@hebcal/hdate": "^0.21.1",
        "@hebcal/locales": "^6.3.0",
```
Each "replace" text appears exactly once in its file. The lock's `node_modules/@hebcal/hdate` entry (0.21.1) stays as it is.

- [ ] **Step 4: Create `src/lib/calendar-view/hebrew-date.ts`**

Create the file with exactly this content:

```ts
// Hebrew dates on the calendar home (spec §7.8): the full date under the header
// ("4 Cheshvan 5787") and the Hebrew date beside each Agenda day ("4 Cheshvan").
// Client-safe and pure. It uses @hebcal/hdate and the Russian month names only, never
// @hebcal/core, which would pull the holiday tables into the home's bundle.
//
// A day key is a calendar day in the viewer's timezone. Its Hebrew date is the daytime
// date of that day (no sunset shift), so it never depends on the device's clock.

import { HDate, Locale, gematriya, type MonthName } from '@hebcal/hdate';
// Adds Russian to @hebcal/hdate's Locale. package.json pins @hebcal/hdate to the one copy
// @hebcal/core and @hebcal/locales share, so this is the same Locale the bot reads.
import '@hebcal/locales/ru';
import type { DayKey } from './types';

/**
 * The 14 Hebrew month names, in the order of `calendarHome.hebrewMonthGenitive` in
 * messages/{en,he,ru}.json: the year from Tishrei, with the plain Adar of a common
 * year before the Adar I and Adar II of a leap year.
 */
export const HEBREW_MONTHS = [
  'Tishrei',
  'Cheshvan',
  'Kislev',
  'Tevet',
  "Sh'vat",
  'Adar',
  'Adar I',
  'Adar II',
  'Nisan',
  'Iyyar',
  'Sivan',
  'Tamuz',
  'Av',
  'Elul',
] as const satisfies readonly MonthName[];

type Lang = 'en' | 'he' | 'ru';

/** The home's languages; anything else reads English. */
function langOf(lang: string): Lang {
  return lang === 'he' || lang === 'ru' ? lang : 'en';
}

/** The Hebrew date of a day key, or null when the key isn't a real 'yyyy-MM-dd' day. */
function hebrewDateOf(dayKey: DayKey): HDate | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  // Local midnight of that calendar day, never an instant: HDate reads the local year,
  // month and day back, whatever the device's timezone. (A UTC midnight is still the day
  // before anywhere west of Greenwich.)
  const date = new Date(y, m - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
  return new HDate(date);
}

function isGenitiveList(list: readonly string[] | undefined): list is readonly string[] {
  return (
    Array.isArray(list) &&
    list.length === HEBREW_MONTHS.length &&
    list.every(entry => typeof entry === 'string' && entry.trim() !== '')
  );
}

/**
 * The month as a day label names it. Hebrew: without nikud ("חשון"). Russian: the
 * genitive from the list ("хешвана", Ruling R9), or the nominative ("Хешван") when the
 * list is missing or broken. English: hebcal's name ("Cheshvan").
 */
function monthLabel(hd: HDate, lang: Lang, genitive: readonly string[] | undefined): string {
  const name = hd.getMonthName();
  if (lang === 'he') {
    return Locale.lookupTranslation(name, 'he-x-NoNikud') ?? Locale.hebrewStripNikkud(Locale.gettext(name, 'he'));
  }
  if (lang === 'ru') {
    const index = (HEBREW_MONTHS as readonly string[]).indexOf(name);
    if (index >= 0 && isGenitiveList(genitive)) return genitive[index];
    return Locale.lookupTranslation(name, 'ru') ?? name;
  }
  return name;
}

function dayLabel(hd: HDate, lang: Lang, genitive: readonly string[] | undefined): string {
  const month = monthLabel(hd, lang, genitive);
  return lang === 'he' ? `${gematriya(hd.getDate())} ב${month}` : `${hd.getDate()} ${month}`;
}

/**
 * The Hebrew day and month of a day key: "4 Cheshvan", "ד׳ בחשון", "4 хешвана".
 * `genitive` is `calendarHome.hebrewMonthGenitive` (14 entries in HEBREW_MONTHS order);
 * only Russian reads it. Returns '' for a key that isn't a real day.
 */
export function hebrewDayLabel(dayKey: DayKey, lang: string, genitive?: readonly string[]): string {
  const hd = hebrewDateOf(dayKey);
  return hd ? dayLabel(hd, langOf(lang), genitive) : '';
}

/**
 * The Hebrew date with its year: "4 Cheshvan 5787", "ד׳ בחשון תשפ״ז", "4 хешвана 5787".
 * `genitive` as for hebrewDayLabel. Returns '' for a key that isn't a real day.
 */
export function hebrewFullDate(dayKey: DayKey, lang: string, genitive?: readonly string[]): string {
  const hd = hebrewDateOf(dayKey);
  if (!hd) return '';
  const l = langOf(lang);
  const year = l === 'he' ? gematriya(hd.getFullYear()) : String(hd.getFullYear());
  return `${dayLabel(hd, l, genitive)} ${year}`;
}
```

- [ ] **Step 5: Run the smoke and the regression smokes again**

```bash
cd /Users/razielgershoni/development/famcalbot
for tz in UTC Asia/Jerusalem Pacific/Kiritimati America/Los_Angeles; do TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-hebrew-date.ts; echo "smoke-hebrew-date $tz exit=$?"; done
for f in smoke-weather-prompt smoke-weather-command; do for tz in UTC Asia/Jerusalem; do TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/$f.ts 2>&1 | grep -E '^(OK|FAIL)|passed' > /tmp/d2-$f-${tz//\//_}.after; echo "$f $tz exit=${pipestatus[1]}"; cmp -s /tmp/d2-$f-${tz//\//_}.before /tmp/d2-$f-${tz//\//_}.after && echo "  same output as Step 2" || echo "  OUTPUT CHANGED"; done; done
npx tsx scripts/check-i18n-parity.ts; echo "check-i18n-parity exit=$?"
```
(zsh, as in Step 2. On Node 26, tsx prints a `DEP0205` deprecation warning about `module.register()` on stderr; it isn't part of the expected output.)

Expected for the new smoke, under each clock:
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
OK  messages/ru.json's calendarHome.hebrewMonthGenitive lines up with HEBREW_MONTHS (Task D1)
OK  one Locale: the Russian that hebrew-date.ts registers is what @hebcal/core sees ('Хешван')
OK  @hebcal/hdate is a direct dependency pinned to ^0.21.1, with one copy in the lock and in node_modules
OK  hebrew-date.ts imports only @hebcal/hdate, @hebcal/locales/ru and the DTO types (no @hebcal/core on the home)

14/14 passed (process TZ=UTC)
smoke-hebrew-date UTC exit=0
```
Then the same with `(process TZ=Asia/Jerusalem)`, `(process TZ=Pacific/Kiritimati)` and `(process TZ=America/Los_Angeles)`.

Every regression run prints `exit=0` and `same output as Step 2`. `check-i18n-parity` prints `i18n parity OK (996 keys)`, the count D1 left, and `exit=0`.

If only the D1 check fails, with "(Task D1 adds it)", D1 hasn't landed. Land it first; don't change the check. If it fails with "not a form of …", D1's list isn't in `HEBREW_MONTHS` order: fix the list in `messages/{en,he,ru}.json`, not `HEBREW_MONTHS`. If the Locale or dependency check fails, Step 3 left a second copy: redo Step 3.

- [ ] **Step 6: Type-check and lint**

```bash
cd /Users/razielgershoni/development/famcalbot
npx tsc --noEmit -p . && npm run -s lint; echo "exit $?"
```
Expected: no output from either, then `exit 0`. `next build` type-checks `scripts/**`, so the smoke is covered too.

- [ ] **Step 7: Commit**

```bash
cd /Users/razielgershoni/development/famcalbot
git add package.json package-lock.json src/lib/calendar-view/hebrew-date.ts scripts/smoke-hebrew-date.ts
git commit -m "$(cat <<'EOF'
feat(calendar-home): Hebrew dates for the header and the Agenda days

hebrew-date.ts turns a day key into its Hebrew date in the viewer's
language: "4 Cheshvan 5787", "ד׳ בחשון תשפ״ז" (gematriya, no nikud) and
"4 хешвана 5787" (the genitive from calendarHome.hebrewMonthGenitive,
Ruling R9). The date comes from the calendar day, never an instant, so
the device's clock can't move it. It uses @hebcal/hdate and the Russian
month names only, so the home never loads @hebcal/core.

@hebcal/hdate becomes a direct dependency pinned to ^0.21.1, the one copy
@hebcal/core and @hebcal/locales already share. A plain install would take
0.23 and nest a second copy, and the bot's Russian Hebrew month names
would fall back to English. Nothing renders this yet, and the switch
stays OFF.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
EOF
)"
```
Stage only these four paths.

---

### Task 3 (D3): Store and Agenda model (spec §5, §7.3; Rulings R8, R10)

> **INTERFACE CHANGE VERSUS THE SPLIT: no name or shape in the split changes, but the split gives D3 no signatures, so everything below is new and binding for D5, D6 and Plan E.** Five choices go beyond the split's description of D3. D5 and D6 must build on them:
> 1. **Every answer is dispatched with an `epoch`:** `{ type: 'response', response, epoch }`. D6 stamps each request with `store.epoch` when it sends it. A drop (facts that don't match, or `reset`) bumps the epoch. An answer from an older epoch is kept only while its facts still match the store's.
> 2. **The applicable sources are pinned too**, along with `tz`, `today` and `weekStart` (spec §5 names three). `hebrewDates` is not pinned. It follows the latest answer.
> 3. **Two more actions:** `reset`, for the midnight timer (spec §5), and `windowFailed`, for a 429, a 500 or a network failure on a window. Without `windowFailed`, that window's days would show placeholders forever.
> 4. **Reconnect is never an Agenda state row.** It is D6's Reconnect banner, read from `homeNotices(store).reconnect`. FamCal errors, Google errors, `calendars_gone` and busy are state rows (`AgendaModel.stateRows`). Partial answers and gone calendars are flags on the model (`partial`, `unavailableCalendars`).
> 5. **The "Still open" card applies the carry-overs' owner-or-creator rule (spec Appendix A, A-17) to today's reminders too.** Today's open reminder joins the card only when the viewer is its owner or its creator, the rule the carry-overs already follow. A partner's own reminder still shows as open in today's list, but not in the card.

**What and why.** The home needs a client store of days that the Agenda shares now and the Month shares in Plan E. It also needs a model of what the Agenda shows. This task writes both as pure TypeScript with no React:
- `src/lib/calendar-view/store.ts`: a `useReducer` reducer over `RangeResponse`s.
- `src/lib/calendar-view/agenda.ts`: `buildAgenda`, which turns the store into the Agenda's days, fold lines, state rows and "Still open" card, plus `whoseItem` and `reminderMark`.

Spec §5's rules are subtle: replace per ok source, "empty means answered", pinned facts, and the state row instead of empty lines. Putting them here lets a plain smoke prove them under three clocks, and D5 (the view) and D6 (the container) stay thin. Nothing imports these files yet. The rollout switch is still `OFF`, and no user sees a change.

**Findings that shaped the code** (line numbers as of the real base, `feat/calendar-home` after Plan C, verified on 2eb69df; the one that differs on 6dab367 gives both):
- **What the route sends** (`app/api/calendar/range/route.ts`):
  - `days` lists every day of `[from, to)` (`:214`, `toRangeDays`). Its items come only from sources whose read was ok, so a failed source sends empty days. The reducer therefore reads an answer's items only for the sources that are `ok` in it, and an empty day from a failed source never replaces anything.
  - `sources` has a key for each applicable source and no other (`:127-132`). A requested source carries its status; one that wasn't requested is `pending`. A FamCal user never gets a `google` key. The key set is stable for a user, which is why the store pins it. A user who connects Google switches source, and their FamCal calendars are soft-deleted (Owner decision 2), so their old FamCal items must go.
  - **Google statuses:**
    - not ok: `{ status, reason }` (`:135`). `calendars_gone` is an `error` with that reason, and `reconnect` carries `token` or `scopes`;
    - ok: `partial` only when a calendar failed or was cut short (`google.ts:244`), and `stale` (the route's `:139`).
  - **Fields that only some answers carry:**
    - `calendars` holds only ok sources' legends (`:200-203`);
    - `partner` is set only when FamCal is ok (`:212`);
    - `carryOvers` is sent only when FamCal is ok, the window holds today, and the carry-over read worked (`:191-198`).

    So each is updated only by an answer that carries it. A FamCal error answer's `partner: null` and `calendars: []` erase nothing.
  - The no-dates window is `[today, today+7)` (`:38`, `:99`), which is `agendaWeekWindow(today, 0)`.
- **Reminder state comes from the DTO:**
  - `open` is set only on today's items, when past due and not done; a snoozed reminder still counts (`dto.ts:102-105`);
  - `snoozedUntil` is sent only while the snooze is running (`dto.ts:57`).

  The model trusts both: `reminderMark` checks done, then snoozed, then open, and returns later otherwise.
- **Carry-overs** go only to the reminder's owner and its creator (A-17, `open-reminders.ts:121`), newest first. A repeating reminder that also occurs today is never one. The card lists today's open reminders that pass that rule in `compareItems` order, then the carry-overs in server order, the same order the summary prompt uses (A-15), deduped by key.
- **Whose an item is** follows the summaries:
  - `mine` follows `categorizeEvents` (its `isOwn` and `isSpouse`, `summary.ts:76-79` on 2eb69df, `:77-80` from 8877ead on, which adds an import at `:50`);
  - "for" and "from" follow `reminderAttribution` (`event-formatter.ts:32-38`). The smoke compares the two for all four owner/creator combinations.
  - Names: `ReminderInfo` carries `ownerName` and `creatorName` only for the partner (`native-provider.ts:136-139`). A masked calendar's name is the partner's name (`famcal.ts:48`). A spouse-labelled Google calendar has `ownerName` (`google.ts:99`). The fallback is the store's partner. With no name anywhere, the relation is dropped, so the home never shows "for undefined".
- **Facts and races:**
  - **`hebrewDates` can change with the other facts the same.** When the route's timezone lookup times out, it answers in Asia/Jerusalem with `tzKnown` false (`route.ts:159-167`). A later answer with the real Asia/Jerusalem has the same `tz` and, for Hebrew and English speakers, the same `weekStart` 0, but `hebrewDates` moves from the language rule to the Israel rule. Pinning it would drop the store with no data reason, so it follows the latest answer.
  - **The midnight race:** an answer sent before midnight that returns after `reset` would pin yesterday again. The epoch makes the store ignore it.
  - **The drop race:** an answer sent before a mismatch drop is kept when its facts match the new ones, for example a second window that was in flight.
  - **Old epochs:** after any drop, D6 refetches its visible windows, because their days are gone.
- **Client-safe:**
  - `store.ts` imports only `./types`, and `agenda.ts` imports only `./types` and `./store`.
  - Day keys use UTC arithmetic (`addDaysToKey`), equal to the server's `addDaysToDate` (`day-events.ts:35`). The client does not import that one, because `day-events.ts` pulls in `date-fns-tz`.
  - The smoke walks `require.cache` children to prove the import rule. A local-time `addDaysToKey` passes under UTC and Asia/Jerusalem and fails under Pacific/Kiritimati, which is why the third clock runs.
- **Pure reducer:**
  - React may call a reducer twice (Strict Mode), so this one never changes its input. The smoke snapshots answers and earlier states.
  - An action that changes nothing returns the same object, so React skips the render.
- **The split's parts handled elsewhere:**
  - "Times in {zone}", the day-label text and the Hebrew dates are D5's, through D1's copy and D2's `hebrewDayLabel`;
  - the midnight timer itself, the 5 s auto-retry and the 3 s stale re-request are D6's.

  The model hands them `today`, `tz`, `hebrewDates`, day keys and statuses.

**Verified:**
- **Base:** `feat/calendar-home` after Plan C (verified on 2eb69df, Plan C's reference chain on 716a4f8, and again on 6dab367, the branch and `main` after Plan C, which differs from that chain only in files D doesn't touch), with D1–D2's reference commits. The first pass, with the mutations below, ran on the scratch base, `wt/B-int` at 63e7d4f exported to `wt/draft-D3` (header, Planning Ruling 9). The results below hold on all three.
- **Before:** under each of the three clocks, the new smoke exits 1 with `Error: Cannot find module '../src/lib/calendar-view/store'`.
- **After:**
  - the smoke passes 33/33 under `TZ=UTC`, `Asia/Jerusalem` and `Pacific/Kiritimati`, with the same OK lines under each;
  - `npx tsc --noEmit -p .` and `npm run -s lint` are clean;
  - `scripts/smoke-calendar-dto.ts` passes 23/23 under each clock, unchanged.
- **Verified against stand-ins:** none. D3 consumes only B3's `src/lib/calendar-view/types.ts`, which is the same on both bases, and no other D task's export.
- **Mutations** (first pass): the smoke catches all 33, under UTC and Pacific/Kiritimati. The one exception is the local-time `addDaysToKey`, which is correct under UTC and caught only under Kiritimati. The mutations were:
  - the store: stray items of a failed source stored; a failure wiping earlier ok coverage; no dedupe; no sort; `weekStart` not pinned; sources not pinned; no epoch guard; carry-overs erased when an answer lacks them; the partner taken from any answer; the legend not replaced per source; a `pending` FamCal or Google status stored; `windowFailed` with no epoch guard, or wiping ok coverage; partial never set; scopes read as token; `reset` keeping the epoch; local-time day arithmetic;
  - the Agenda: loading days folded; failed days folded; a failed day not ending a fold run; reconnect as a state row; the partner's own reminder in the card; no cap of 5; carry-overs before today's reminders; open checked before snoozed; the partner's own reminder read as "for"; no partner-name fallback; a spouse's Google calendar with no person chip; `empty` ignoring the card; partial not reported; unavailable calendars not reported; a server import in `agenda.ts`.

**Files:**
- Create: `src/lib/calendar-view/store.ts`
- Create: `src/lib/calendar-view/agenda.ts`
- Create (test): `scripts/smoke-calendar-agenda.ts`
- Modify: none. `src/lib/calendar-view/types.ts` (B3) is read, not changed.
- Test: `scripts/smoke-calendar-agenda.ts` under `TZ=UTC`, `TZ=Asia/Jerusalem` and `TZ=Pacific/Kiritimati`. Regression (unchanged): `scripts/smoke-calendar-dto.ts`, which covers `compareItems` and the DTO the store holds, under the same three clocks.

**Interfaces:**
- Consumes:
  - from B3, `src/lib/calendar-view/types.ts`: `DayKey`, `SourceName`, `WeekStart`, `GoogleStatusReason`, `RangeResponse`, `CalendarDTO`, `ItemDTO` and `compareItems(a: ItemDTO, b: ItemDTO): number` (the smoke also uses `ItemReminderDTO`);
  - in the smoke only, as references: `addDaysToDate(day: string, days: number): string` (`src/utils/day-events.ts:35`) and `reminderAttribution(event: Pick<CalendarEvent, 'reminder'>): string | undefined` (`src/utils/event-formatter.ts:32`).
- Produces, `src/lib/calendar-view/store.ts` (client-safe):
  - `export const SOURCE_ORDER: readonly SourceName[]` (`['famcal', 'google']`)
  - `export type FamcalStatus = NonNullable<RangeResponse['sources']['famcal']>`, `export type GoogleStatus = NonNullable<RangeResponse['sources']['google']>`
  - `export interface StoreFacts { tz: string; today: DayKey; weekStart: WeekStart; hebrewDates: boolean; sources: SourceName[] }`
  - `export interface DayCoverage { ok: boolean; failed: boolean; partial: boolean }`
  - `export interface StoreDay { items: ItemDTO[]; coverage: Partial<Record<SourceName, DayCoverage>> }`
  - `export type SourceFailure = { kind: 'error'; source: SourceName; reason: GoogleStatusReason | null } | { kind: 'calendarsGone'; source: 'google' } | { kind: 'reconnect'; source: 'google'; reason: 'token' | 'scopes' } | { kind: 'busy'; source: SourceName }`
  - `export interface CalendarStore { epoch: number; facts: StoreFacts | null; days: Readonly<Record<DayKey, StoreDay>>; status: { famcal?: FamcalStatus; google?: GoogleStatus }; lastFailure: Partial<Record<SourceName, SourceFailure>>; calendars: CalendarDTO[]; partner: { name: string } | null; carryOvers: ItemDTO[] | null }`
  - `export type StoreAction = { type: 'response'; response: RangeResponse; epoch: number } | { type: 'windowFailed'; from: DayKey; to: DayKey; sources: readonly SourceName[]; kind: 'busy' | 'error'; epoch: number } | { type: 'reset' }`
  - `export type DayStatus = 'answered' | 'loading' | 'failed'`
  - `export interface HomeNotices { reconnect: 'token' | 'scopes' | null; unavailableCalendars: number }`
  - `export function addDaysToKey(day: DayKey, days: number): DayKey`
  - `export function daysInWindow(from: DayKey, to: DayKey): DayKey[]`
  - `export function emptyStore(epoch = 0): CalendarStore`
  - `export function reduceStore(state: CalendarStore, action: StoreAction): CalendarStore`
  - `export function dayItems(state: CalendarStore, day: DayKey): readonly ItemDTO[]`
  - `export function dayStatus(state: CalendarStore, day: DayKey): DayStatus`
  - `export function failedSources(state: CalendarStore, day: DayKey): SourceName[]`
  - `export function isPartialDay(state: CalendarStore, day: DayKey): boolean`
  - `export function homeNotices(state: CalendarStore): HomeNotices`
- Produces, `src/lib/calendar-view/agenda.ts` (client-safe):
  - `export const AGENDA_WEEK_DAYS = 7`, `export const STILL_OPEN_SHOWN = 5`
  - `export interface Whose { mine: boolean; person: string | null; relation: 'for' | 'from' | null }`
  - `export type ReminderMark = 'open' | 'done' | 'snoozed' | 'later'`
  - `export interface AgendaRow { item: ItemDTO; whose: Whose; mark: ReminderMark | null }`
  - `export interface AgendaDay { type: 'day'; date: DayKey; relative: 'today' | 'tomorrow' | null; status: DayStatus; rows: AgendaRow[] }`
  - `export interface AgendaFold { type: 'fold'; first: DayKey; last: DayKey }`, `export type AgendaEntry = AgendaDay | AgendaFold`
  - `export interface StillOpenRow extends AgendaRow { since: DayKey; carriedOver: boolean }`, `export interface StillOpenCard { shown: StillOpenRow[]; more: StillOpenRow[] }`
  - `export interface AgendaStateRow { source: SourceName; failure: Exclude<SourceFailure, { kind: 'reconnect' }> }`
  - `export interface AgendaModel { today: DayKey; tz: string; weekStart: WeekStart; hebrewDates: boolean; weeks: number; end: DayKey; stateRows: AgendaStateRow[]; partial: boolean; unavailableCalendars: number; stillOpen: StillOpenCard | null; entries: AgendaEntry[]; empty: boolean }`
  - `export function agendaWeekWindow(today: DayKey, week: number): { from: DayKey; to: DayKey }`
  - `export function whoseItem(item: ItemDTO, partnerName: string | null): Whose`
  - `export function reminderMark(item: ItemDTO): ReminderMark | null`
  - `export function buildAgenda(state: CalendarStore, weeks = 1): AgendaModel | null`
- **How D6 (CalendarHome) uses the store:**
  ```ts
  const [store, dispatch] = useReducer(reduceStore, undefined, () => emptyStore());
  const storeRef = useRef(store);
  storeRef.current = store;
  // Send: const epoch = storeRef.current.epoch; then, per answer:
  //   200          → dispatch({ type: 'response', response: (await res.json()) as RangeResponse, epoch })
  //   429          → dispatch({ type: 'windowFailed', ...win, sources: [source], kind: 'busy', epoch })
  //   500, network → dispatch({ type: 'windowFailed', ...win, sources: [source], kind: 'error', epoch })
  //                  (win = agendaWeekWindow(store.facts.today, n); before the first answer, store.facts is
  //                  null, the action is a no-op, and D6 shows its own busy or retry card instead)
  // Midnight in store.facts.tz → dispatch({ type: 'reset' }), then refetch.
  // store.epoch changed → refetch every visible window (a drop empties their days).
  // "Show next week" → setWeeks(w => w + 1) and fetch agendaWeekWindow(today, w) for each applicable source.
  const agenda = buildAgenda(store, weeks);      // null → the home's loading placeholders
  const { reconnect } = homeNotices(store);      // the Reconnect Google banner (§7.2)
  ```
- **How D5 (AgendaView) reads the model:**
  - `entries` in order:
    - a `day` gets "Today", "Tomorrow" or the weekday and date (plus the Hebrew date when `hebrewDates`), then its rows;
    - a `day` with no rows: `answered` → "Nothing planned"; `loading` → placeholder rows; `failed` → nothing below the header;
    - a `fold` → "Nothing planned {range}", from `first` to `last`.
  - Above the days:
    - one row per `stateRows` entry: `error` + `famcal` → "Couldn't load your calendar · Retry"; `error` + `google` → "Couldn't load Google · Retry"; `calendarsGone` → "Your calendars aren't available · Choose again"; `busy` → "Busy, try again in a minute";
    - `partial` → "Some calendars didn't load · Retry";
    - `unavailableCalendars > 0` → "N calendars aren't available · Choose again".
  - `stillOpen`: `shown`, then "N more" (`more.length`). Each row has `since` and `whose` ("from {name}" or "for {name}").
  - `empty` → Ruling R10's empty state, with its hints from `HomeHints`.
  - Row icons come from `mark`; the person chip and filled or outlined styling come from `whose`.

- [ ] **Step 1: Write the failing smoke `scripts/smoke-calendar-agenda.ts`**

Create the file with exactly this content:

```ts
// Smoke test for the calendar home's client store and Agenda model (spec §5, §7.3,
// Rulings R8 and R10): the reducer in src/lib/calendar-view/store.ts and buildAgenda in
// src/lib/calendar-view/agenda.ts.
//
// An ok answer replaces its source's items over its window and nothing else; an error,
// a reconnect or a pending source never wipes what an earlier ok answer brought. A
// change of timezone, today, week start or sources drops the store. Later empty days
// fold into one line only once every source has answered ok for them, and a source that
// failed with no earlier data shows its state row instead of empty lines. The
// "Still open" card holds today's open reminders and the carry-overs, 5 then the rest.
// Whose an item is follows the summaries' rules. Pure: no network, no DB, no React.
//
// Run under three clocks; the output must not depend on the process timezone:
//   TZ=UTC npx tsx scripts/smoke-calendar-agenda.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-calendar-agenda.ts
//   TZ=Pacific/Kiritimati npx tsx scripts/smoke-calendar-agenda.ts

import path from 'path';
import {
  addDaysToKey,
  dayItems,
  dayStatus,
  emptyStore,
  homeNotices,
  reduceStore,
  type CalendarStore,
  type StoreAction,
} from '../src/lib/calendar-view/store';
import {
  agendaWeekWindow,
  buildAgenda,
  reminderMark,
  whoseItem,
  type AgendaEntry,
  type AgendaModel,
} from '../src/lib/calendar-view/agenda';
import type { DayKey, ItemDTO, ItemReminderDTO, RangeResponse } from '../src/lib/calendar-view/types';

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

// ---- Fixtures: a FamCal user in Israel, Thursday 15 October 2026 ----

const IL = 'Asia/Jerusalem';
const TODAY = '2026-10-15';
/** The fixtures' own day arithmetic, so a broken addDaysToKey fails its check instead of the fixtures. */
const plusDays = (key: DayKey, n: number) => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const day = (n: number) => plusDays(TODAY, n);

const OWN_CAL = { id: 'native:cal-own', name: 'Raziel', color: '#039BE5', mine: true, inLegend: true };
const NOA_CAL = { id: 'native:cal-noa', name: 'Noa family', color: '#E67C73', mine: false, ownerName: 'Noa', inLegend: true };
const MASKED = { id: null, name: 'Noa', color: null, mine: false, inLegend: false };
const FAMILY_G = { id: 'family@group.calendar.google.com', name: 'Family', color: '#7986CB', mine: true, inLegend: true };
const SPOUSE_G = { id: 'dana@gmail.com', name: 'Dana', color: '#33B679', mine: false, ownerName: 'Dana', inLegend: true };

/** A FamCal event; start/end are UTC ISO, or yyyy-MM-dd for all-day. */
function ev(id: string, start: string, end: string, extra: Partial<ItemDTO> = {}): ItemDTO {
  return {
    key: `famcal|${id}`,
    source: 'famcal',
    readOnly: false,
    id,
    seriesId: id.split('#')[0],
    originalStart: start.includes('T') ? start : null,
    kind: 'event',
    title: id,
    start,
    end,
    allDay: !start.includes('T'),
    tz: IL,
    recurring: false,
    repeatsDaily: false,
    span: null,
    calendar: OWN_CAL,
    location: null,
    description: null,
    ...extra,
  };
}

/** A FamCal reminder at `start` (UTC ISO). Defaults: the viewer's own, not due yet. */
function rem(id: string, start: string, r: Partial<ItemReminderDTO> = {}, extra: Partial<ItemDTO> = {}): ItemDTO {
  return ev(id, start, start, {
    kind: 'reminder',
    reminder: {
      done: false,
      doneAt: null,
      snoozedUntil: null,
      open: false,
      openSince: null,
      ownerIsViewer: true,
      creatorIsViewer: true,
      ...r,
    },
    ...extra,
  });
}

function gev(id: string, start: string, end: string, extra: Partial<ItemDTO> = {}): ItemDTO {
  return ev(id, start, end, {
    key: `google|${FAMILY_G.id}|${id}`,
    source: 'google',
    readOnly: true,
    seriesId: null,
    originalStart: null,
    tz: null,
    calendar: FAMILY_G,
    birthday: false,
    htmlLink: `https://www.google.com/calendar/event?eid=${id}`,
    ...extra,
  });
}

type Answer = Omit<Partial<RangeResponse>, 'days'> & { days?: Record<DayKey, ItemDTO[]> };

/** A FamCal user's answer for [from, to) (default: the route's no-dates window), every day listed. */
function famcalAnswer(a: Answer = {}): RangeResponse {
  const from = a.from ?? TODAY;
  const to = a.to ?? plusDays(from, 7);
  const days: RangeResponse['days'] = [];
  for (let d = from; d < to; d = plusDays(d, 1)) days.push({ date: d, items: a.days?.[d] ?? [] });
  return {
    tz: a.tz ?? IL,
    today: a.today ?? TODAY,
    weekStart: a.weekStart ?? 0,
    hebrewDates: a.hebrewDates ?? true,
    from,
    to,
    sources: a.sources ?? { famcal: { status: 'ok' } },
    partner: a.partner === undefined ? { name: 'Noa' } : a.partner,
    calendars: a.calendars ?? [
      { id: OWN_CAL.id, source: 'famcal', name: OWN_CAL.name, color: OWN_CAL.color, mine: true },
      { id: NOA_CAL.id, source: 'famcal', name: NOA_CAL.name, color: NOA_CAL.color, mine: false, ownerName: 'Noa' },
    ],
    days,
    ...(a.carryOvers ? { carryOvers: a.carryOvers } : {}),
  };
}

/** A Google user's answer: no famcal key, no partner, the Google legend. */
function googleAnswer(a: Answer = {}): RangeResponse {
  return famcalAnswer({
    partner: null,
    calendars: [
      { id: FAMILY_G.id, source: 'google', name: 'Family', color: FAMILY_G.color, mine: true },
      { id: SPOUSE_G.id, source: 'google', name: 'Dana', color: SPOUSE_G.color, mine: false, ownerName: 'Dana' },
    ],
    sources: { google: { status: 'ok' } },
    ...a,
  });
}

const answer = (response: RangeResponse, epoch = 0): StoreAction => ({ type: 'response', response, epoch });
const run = (actions: StoreAction[], from: CalendarStore = emptyStore()) => actions.reduce(reduceStore, from);
const keys = (items: readonly ItemDTO[]) => items.map((i) => i.key);

/** The Agenda as short strings: "D 2026-10-15 today answered [famcal|a, …]" or "F 2026-10-17..2026-10-18". */
function shape(model: AgendaModel | null): string[] {
  assert(model !== null, 'no Agenda model');
  return model.entries.map((e: AgendaEntry) =>
    e.type === 'fold'
      ? `F ${e.first}..${e.last}`
      : `D ${e.date} ${e.relative ?? '-'} ${e.status} [${e.rows.map((r) => r.item.key).join(', ')}]`
  );
}

// A wall time in Israel n days from today, as UTC ISO, at UTC+3 throughout: the store
// never buckets by time (the server did), so the values only need to sort right.
const T = (n: number, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(2026, 9, 15 + n, h - 3, m)).toISOString();
};

async function main() {
  // ---------------- The store ----------------

  await check('an empty store has no facts, no Agenda, and every day is loading', () => {
    const s = emptyStore();
    assert(s.facts === null && s.epoch === 0, `facts ${JSON.stringify(s.facts)} epoch ${s.epoch}`);
    assert(buildAgenda(s) === null, 'an Agenda without facts');
    assert(dayStatus(s, TODAY) === 'loading', `today is ${dayStatus(s, TODAY)}`);
  });

  await check('the first answer pins tz, today, week start and the sources that apply', () => {
    const s = run([answer(famcalAnswer({ weekStart: 0, hebrewDates: true }))]);
    assertJson(s.facts, { tz: IL, today: TODAY, weekStart: 0, hebrewDates: true, sources: ['famcal'] }, 'facts');
    assert(s.epoch === 0, `epoch ${s.epoch}`);
    const g = run([answer(googleAnswer({ weekStart: 1 }))]);
    assertJson(g.facts?.sources, ['google'], 'a Google user\'s sources');
  });

  await check('a day\'s items are deduped by key and sorted with compareItems', () => {
    const late = ev('late', T(0, '18:00'), T(0, '19:00'));
    const early = ev('early', T(0, '09:00'), T(0, '10:00'));
    const allDay = ev('trip', TODAY, day(1));
    const s = run([answer(famcalAnswer({ days: { [TODAY]: [late, early, { ...early, title: 'dup' }, allDay] } }))]);
    assertJson(keys(dayItems(s, TODAY)), ['famcal|trip', 'famcal|early', 'famcal|late'], 'today');
  });

  await check('an ok answer replaces its source\'s items on every day of its window, and only there', () => {
    const a = ev('a', T(0, '09:00'), T(0, '10:00'));
    const b = ev('b', T(2, '09:00'), T(2, '10:00'));
    const c = ev('c', T(8, '09:00'), T(8, '10:00'));
    const w1 = agendaWeekWindow(TODAY, 1);
    let s = run([
      answer(famcalAnswer({ days: { [TODAY]: [a], [day(2)]: [b] } })),
      answer(famcalAnswer({ ...w1, days: { [day(8)]: [c] } })),
    ]);
    // b was deleted, d was added; week 1 is not in this window.
    const d = ev('d', T(3, '12:00'), T(3, '13:00'));
    s = reduceStore(s, answer(famcalAnswer({ days: { [TODAY]: [a], [day(3)]: [d] } })));
    assertJson(keys(dayItems(s, day(2))), [], 'day 2 after b was deleted');
    assertJson(keys(dayItems(s, day(3))), ['famcal|d'], 'day 3');
    assertJson(keys(dayItems(s, day(8))), ['famcal|c'], 'day 8, outside the window');
    assert(dayStatus(s, day(2)) === 'answered', `day 2 is ${dayStatus(s, day(2))}`);
  });

  await check('a multi-day item has one entry on each of its days', () => {
    const conf = (span: ItemDTO['span']) => ev('conf', T(1, '20:00'), T(3, '10:00'), { span });
    const s = run([
      answer(famcalAnswer({ days: { [day(1)]: [conf('endsLater')], [day(2)]: [conf('spansDay')], [day(3)]: [conf('continues')] } })),
    ]);
    const spans = [1, 2, 3].map((n) => dayItems(s, day(n)).map((i) => `${i.key}:${i.span}`).join());
    assertJson(spans, ['famcal|conf:endsLater', 'famcal|conf:spansDay', 'famcal|conf:continues'], 'spans');
    const model = buildAgenda(s);
    assertJson(shape(model).slice(1, 4), [
      `D ${day(1)} tomorrow answered [famcal|conf]`,
      `D ${day(2)} - answered [famcal|conf]`,
      `D ${day(3)} - answered [famcal|conf]`,
    ], 'Agenda days 1-3');
  });

  await check('an error or a reconnect keeps the earlier ok items, and the day stays answered', () => {
    const g = gev('dinner', T(0, '19:30'), T(0, '22:00'));
    let s = run([answer(googleAnswer({ days: { [TODAY]: [g] } }))]);
    s = reduceStore(s, answer(googleAnswer({ sources: { google: { status: 'error', reason: 'transient' } }, calendars: [] })));
    assertJson(keys(dayItems(s, TODAY)), [g.key], 'after an error');
    assert(dayStatus(s, TODAY) === 'answered', `today is ${dayStatus(s, TODAY)}`);
    assertJson(s.status.google, { status: 'error', reason: 'transient' }, 'status');
    assertJson(s.lastFailure.google, { kind: 'error', source: 'google', reason: 'transient' }, 'lastFailure');
    assert(s.calendars.length === 2, `the legend went with the error: ${s.calendars.length}`);
    s = reduceStore(s, answer(googleAnswer({ sources: { google: { status: 'reconnect', reason: 'token' } }, calendars: [] })));
    assertJson(keys(dayItems(s, TODAY)), [g.key], 'after a reconnect');
  });

  await check('a pending source changes nothing: not its status, not its days', () => {
    let s = run([answer(googleAnswer({ days: { [TODAY]: [gev('x', T(0, '09:00'), T(0, '10:00'))] } }))]);
    const before = JSON.stringify(s);
    s = reduceStore(s, answer(googleAnswer({ sources: { google: { status: 'pending' } }, calendars: [] })));
    assert(JSON.stringify(s) === before, 'a pending answer changed the store');
    const fresh = run([answer(googleAnswer({ sources: { google: { status: 'pending' } }, calendars: [] }))]);
    assert(dayStatus(fresh, TODAY) === 'loading', `pending reads as ${dayStatus(fresh, TODAY)}`);
    assert(fresh.status.google === undefined, 'pending was stored as a status');
  });

  await check('items of a source that is not ok are never stored', () => {
    const stray = ev('stray', T(0, '09:00'), T(0, '10:00'));
    const s = run([answer(famcalAnswer({ sources: { famcal: { status: 'error' } }, days: { [TODAY]: [stray] } }))]);
    assertJson(keys(dayItems(s, TODAY)), [], 'today');
    assert(dayStatus(s, TODAY) === 'failed', `today is ${dayStatus(s, TODAY)}`);
  });

  await check('with both sources, an answer replaces only its ok sources\' items and never stores a failed one\'s', () => {
    // Not in step 1 (sourcesFor gives one source); the store is ready for "Google becomes a connection".
    const legend: RangeResponse['calendars'] = [
      { id: FAMILY_G.id, source: 'google', name: 'Family', color: null, mine: true },
      { id: OWN_CAL.id, source: 'famcal', name: 'Raziel', color: null, mine: true },
    ];
    const both = (sources: RangeResponse['sources'], items: ItemDTO[]) => famcalAnswer({ sources, calendars: legend, days: { [TODAY]: items } });
    const f1 = ev('f1', T(0, '09:00'), T(0, '10:00'));
    const f2 = ev('f2', T(0, '11:00'), T(0, '12:00'));
    const g1 = gev('g1', T(0, '10:00'), T(0, '11:00'));
    const stray = gev('stray', T(0, '08:00'), T(0, '09:00'));
    let s = run([answer(both({ famcal: { status: 'ok' }, google: { status: 'pending' } }, [f1]))]);
    assert(dayStatus(s, TODAY) === 'loading', `FamCal only: today is ${dayStatus(s, TODAY)}`);
    assert(s.status.google === undefined, `a pending Google was stored: ${JSON.stringify(s.status.google)}`);
    s = reduceStore(s, answer(both({ famcal: { status: 'pending' }, google: { status: 'ok' } }, [g1])));
    assertJson(keys(dayItems(s, TODAY)), [f1.key, g1.key], 'after both answered');
    assertJson(s.status, { famcal: { status: 'ok' }, google: { status: 'ok' } }, 'a pending FamCal overwrote its status');
    assertJson(s.calendars.map((c) => c.source), ['famcal', 'google'], 'the legend, FamCal first');
    s = reduceStore(s, answer(both({ famcal: { status: 'ok' }, google: { status: 'error', reason: 'transient' } }, [f2, stray])));
    assertJson(keys(dayItems(s, TODAY)), [g1.key, f2.key], 'FamCal replaced, Google kept, the stray item dropped');
    assert(dayStatus(s, TODAY) === 'answered', `today is ${dayStatus(s, TODAY)}`);
    s = reduceStore(s, answer(both({ famcal: { status: 'ok' }, google: { status: 'pending' } }, [f2])));
    assertJson(s.status.google, { status: 'error', reason: 'transient' }, 'a pending Google overwrote its error');
  });

  await check('a different tz, today, week start or set of sources drops the store and bumps the epoch', () => {
    const base = run([
      answer(famcalAnswer({ days: { [TODAY]: [ev('a', T(0, '09:00'), T(0, '10:00'))] }, carryOvers: [rem('old', T(-2, '09:00'), { open: true, openSince: day(-2) })] })),
      answer(famcalAnswer({ ...agendaWeekWindow(TODAY, 1), days: { [day(8)]: [ev('c', T(8, '09:00'), T(8, '10:00'))] } })),
    ]);
    const cases: [string, RangeResponse][] = [
      ['tz', famcalAnswer({ tz: 'Europe/London' })],
      ['today', famcalAnswer({ today: day(1), from: day(1) })],
      ['weekStart', famcalAnswer({ weekStart: 1 })],
      ['sources', googleAnswer()],
    ];
    for (const [what, r] of cases) {
      const s = reduceStore(base, answer(r));
      assert(s.epoch === 1, `${what}: epoch ${s.epoch}`);
      assertJson([s.facts?.tz, s.facts?.today, s.facts?.weekStart, s.facts?.sources], [r.tz, r.today, r.weekStart, Object.keys(r.sources)], `${what}: facts`);
      assertJson(keys(dayItems(s, day(8))), [], `${what}: day 8 kept`);
      assert(s.carryOvers === null, `${what}: carry-overs kept`);
    }
  });

  await check('hebrewDates follows the latest answer, without a drop', () => {
    const a = ev('a', T(0, '09:00'), T(0, '10:00'));
    let s = run([answer(famcalAnswer({ hebrewDates: false, days: { [TODAY]: [a] } }))]);
    s = reduceStore(s, answer(famcalAnswer({ ...agendaWeekWindow(TODAY, 1), hebrewDates: true })));
    assert(s.facts?.hebrewDates === true && s.epoch === 0, `hebrewDates ${s.facts?.hebrewDates}, epoch ${s.epoch}`);
    assertJson(keys(dayItems(s, TODAY)), [a.key], 'today');
  });

  await check('an answer sent before the last drop is kept only when its facts still match', () => {
    const london = reduceStore(run([answer(famcalAnswer())]), answer(famcalAnswer({ tz: 'Europe/London' })));
    assert(london.epoch === 1, `epoch ${london.epoch}`);
    const stale = reduceStore(london, answer(famcalAnswer({ tz: IL, days: { [TODAY]: [ev('a', T(0, '09:00'), T(0, '10:00'))] } }), 0));
    assert(stale === london, 'a stale answer from epoch 0 was applied');
    const late = reduceStore(london, answer(famcalAnswer({ tz: 'Europe/London', days: { [TODAY]: [ev('b', T(0, '09:00'), T(0, '10:00'))] } }), 0));
    assertJson(keys(dayItems(late, TODAY)), ['famcal|b'], 'an epoch-0 answer with the same facts');
  });

  await check('reset (the midnight timer) empties the store; an answer sent before it is ignored', () => {
    const s = reduceStore(run([answer(famcalAnswer({ days: { [TODAY]: [ev('a', T(0, '09:00'), T(0, '10:00'))] } }))]), { type: 'reset' });
    assert(s.facts === null && s.epoch === 1 && Object.keys(s.days).length === 0, `after reset: ${JSON.stringify(s)}`);
    const before = reduceStore(s, answer(famcalAnswer(), 0));
    assert(before === s, 'an answer sent before midnight was applied');
    const after = reduceStore(s, answer(famcalAnswer({ today: day(1), from: day(1) }), 1));
    assert(after.facts?.today === day(1) && after.epoch === 1, `after: today ${after.facts?.today}, epoch ${after.epoch}`);
  });

  await check('the legend, the partner and the carry-overs come only from answers that carry them', () => {
    const co = [rem('old', T(-2, '09:00'), { open: true, openSince: day(-2) })];
    let s = run([answer(famcalAnswer({ carryOvers: co }))]);
    assertJson(s.calendars.map((c) => c.id), [OWN_CAL.id, NOA_CAL.id], 'legend');
    assert(s.partner?.name === 'Noa', 'partner');
    // A FamCal error answer: no legend, no partner, no carry-overs. Nothing is erased.
    s = reduceStore(s, answer(famcalAnswer({ sources: { famcal: { status: 'error' } }, partner: null, calendars: [] })));
    assertJson(s.calendars.map((c) => c.id), [OWN_CAL.id, NOA_CAL.id], 'legend after an error');
    assert(s.partner?.name === 'Noa', 'partner after an error');
    // Week 1 doesn't hold today: no carry-overs in it, and the old ones stay.
    s = reduceStore(s, answer(famcalAnswer({ ...agendaWeekWindow(TODAY, 1), calendars: [] })));
    assertJson(keys(s.carryOvers ?? []), ['famcal|old'], 'carry-overs after week 1');
    assertJson(s.calendars, [], 'an ok answer\'s empty legend replaces the old one');
    // Unpaired: an ok answer with partner null clears the partner.
    s = reduceStore(s, answer(famcalAnswer({ partner: null, carryOvers: [] })));
    assert(s.partner === null, 'partner after unpairing');
    assertJson(s.carryOvers, [], 'carry-overs replaced by an empty list');
  });

  await check('the reducer never changes its input', () => {
    const a = famcalAnswer({ days: { [TODAY]: [ev('b', T(0, '10:00'), T(0, '11:00')), ev('a', T(0, '09:00'), T(0, '10:00'))] }, carryOvers: [rem('old', T(-2, '09:00'), { open: true, openSince: day(-2) })] });
    const b = famcalAnswer({ days: { [TODAY]: [ev('c', T(0, '08:00'), T(0, '09:00'))] } });
    const s1 = run([answer(a)]);
    const snapshot = JSON.stringify([a, b, s1]);
    const s2 = reduceStore(s1, answer(b));
    reduceStore(s2, { type: 'windowFailed', ...agendaWeekWindow(TODAY, 1), sources: ['famcal'], kind: 'busy', epoch: 0 });
    reduceStore(s2, answer(famcalAnswer({ tz: 'Europe/London' })));
    reduceStore(s2, { type: 'reset' });
    assert(JSON.stringify([a, b, s1]) === snapshot, 'an answer or the earlier state was changed');
    assertJson(keys(a.days[0].items), ['famcal|b', 'famcal|a'], 'the answer\'s own order');
  });

  await check('a failed request marks only the days no ok answer covers', () => {
    const a = ev('a', T(0, '09:00'), T(0, '10:00'));
    const s0 = run([answer(famcalAnswer({ days: { [TODAY]: [a] } }))]);
    const s = reduceStore(s0, { type: 'windowFailed', from: TODAY, to: day(14), sources: ['famcal'], kind: 'busy', epoch: 0 });
    assert(dayStatus(s, TODAY) === 'answered' && dayStatus(s, day(9)) === 'failed', `today ${dayStatus(s, TODAY)}, day 9 ${dayStatus(s, day(9))}`);
    assertJson(keys(dayItems(s, TODAY)), [a.key], 'today');
    assertJson(s.lastFailure.famcal, { kind: 'busy', source: 'famcal' }, 'lastFailure');
    assert(reduceStore(emptyStore(), { type: 'windowFailed', from: TODAY, to: day(7), sources: ['famcal'], kind: 'error', epoch: 0 }).facts === null, 'a failure pinned facts');
    const old = reduceStore({ ...s0, epoch: 2 }, { type: 'windowFailed', from: TODAY, to: day(7), sources: ['famcal'], kind: 'error', epoch: 1 });
    assert(old.lastFailure.famcal === undefined, 'a failure from an older epoch was applied');
    const other = reduceStore(s0, { type: 'windowFailed', from: TODAY, to: day(7), sources: ['google'], kind: 'error', epoch: 0 });
    assert(other === s0, 'a failure of a source that does not apply changed the store');
  });

  await check('addDaysToKey matches the server\'s addDaysToDate across DST and year ends', async () => {
    const { addDaysToDate } = await import('../src/utils/day-events');
    for (const start of ['2026-10-24', '2026-03-27', '2026-12-30', '2028-02-28', '2026-10-31']) {
      for (const n of [-400, -8, -1, 0, 1, 2, 7, 13, 42, 366]) {
        assert(addDaysToKey(start, n) === addDaysToDate(start, n), `${start} ${n}: ${addDaysToKey(start, n)} vs ${addDaysToDate(start, n)}`);
      }
    }
  });

  // ---------------- The Agenda ----------------

  await check('the Agenda lists today and the next 6 days; today and tomorrow show even when empty', () => {
    const model = buildAgenda(run([answer(famcalAnswer({ days: { [day(3)]: [ev('x', T(3, '09:00'), T(3, '10:00'))] } }))]));
    assertJson(shape(model), [
      `D ${TODAY} today answered []`,
      `D ${day(1)} tomorrow answered []`,
      `F ${day(2)}..${day(2)}`,
      `D ${day(3)} - answered [famcal|x]`,
      `F ${day(4)}..${day(6)}`,
    ], 'entries');
    assert(model?.end === day(7) && model.weeks === 1, `end ${model?.end}, weeks ${model?.weeks}`);
    assertJson([model?.today, model?.tz, model?.weekStart, model?.hebrewDates], [TODAY, IL, 0, true], 'facts');
  });

  await check('Show next week adds 7 days, and a fold runs across the week boundary', () => {
    const s = run([
      answer(famcalAnswer({ days: { [day(4)]: [ev('x', T(4, '09:00'), T(4, '10:00'))] } })),
      answer(famcalAnswer({ ...agendaWeekWindow(TODAY, 1), days: { [day(10)]: [ev('y', T(10, '09:00'), T(10, '10:00'))] } })),
    ]);
    assertJson(shape(buildAgenda(s, 2)), [
      `D ${TODAY} today answered []`,
      `D ${day(1)} tomorrow answered []`,
      `F ${day(2)}..${day(3)}`,
      `D ${day(4)} - answered [famcal|x]`,
      `F ${day(5)}..${day(9)}`,
      `D ${day(10)} - answered [famcal|y]`,
      `F ${day(11)}..${day(13)}`,
    ], 'two weeks');
    assert(buildAgenda(s, 2)?.end === day(14), 'end');
  });

  await check('nothing reads as empty before every source has answered', () => {
    const s = run([answer(famcalAnswer({ days: { [day(4)]: [ev('x', T(4, '09:00'), T(4, '10:00'))] } }))]);
    const model = buildAgenda(s, 2);
    const week1 = shape(model).slice(-7);
    assertJson(week1, [7, 8, 9, 10, 11, 12, 13].map((n) => `D ${day(n)} - loading []`), 'week 1 before its answer');
    assert(model?.empty === false, 'empty while loading');
  });

  await check('a source that failed with no earlier ok data shows its state row once, and no empty line or fold', () => {
    const s = run([answer(googleAnswer({ sources: { google: { status: 'error', reason: 'timeout' } }, calendars: [] }))]);
    const model = buildAgenda(s);
    assertJson(shape(model), [`D ${TODAY} today failed []`, `D ${day(1)} tomorrow failed []`], 'entries');
    assertJson(model?.stateRows, [{ source: 'google', failure: { kind: 'error', source: 'google', reason: 'timeout' } }], 'state rows');
    assert(model?.empty === false, 'empty after a failure');
  });

  await check('an error after an ok answer shows the earlier data and no state row', () => {
    const g = gev('dinner', T(0, '19:30'), T(0, '22:00'));
    const s = run([
      answer(googleAnswer({ days: { [TODAY]: [g] } })),
      answer(googleAnswer({ sources: { google: { status: 'error', reason: 'transient' } }, calendars: [] })),
    ]);
    const model = buildAgenda(s);
    assertJson(model?.stateRows, [], 'state rows');
    assertJson(shape(model).slice(0, 3), [`D ${TODAY} today answered [${g.key}]`, `D ${day(1)} tomorrow answered []`, `F ${day(2)}..${day(6)}`], 'entries');
  });

  await check('reconnect is never a state row: the banner (homeNotices) carries it, and only for Google users', () => {
    const s = run([answer(googleAnswer({ sources: { google: { status: 'reconnect', reason: 'scopes' } }, calendars: [] }))]);
    assertJson(buildAgenda(s)?.stateRows, [], 'state rows');
    assertJson(homeNotices(s), { reconnect: 'scopes', unavailableCalendars: 0 }, 'notices');
    const famcal = run([answer(famcalAnswer({ sources: { famcal: { status: 'error' } } }))]);
    assertJson(homeNotices(famcal), { reconnect: null, unavailableCalendars: 0 }, 'a FamCal user\'s notices');
    const back = reduceStore(s, answer(googleAnswer()));
    assert(homeNotices(back).reconnect === null, 'the banner outlived an ok answer');
  });

  await check('calendars_gone, a FamCal error and a busy request each give their own state row', () => {
    const gone = run([answer(googleAnswer({ sources: { google: { status: 'error', reason: 'calendars_gone' } }, calendars: [] }))]);
    assertJson(buildAgenda(gone)?.stateRows, [{ source: 'google', failure: { kind: 'calendarsGone', source: 'google' } }], 'calendars_gone');
    const famcal = run([answer(famcalAnswer({ sources: { famcal: { status: 'error' } } }))]);
    assertJson(buildAgenda(famcal)?.stateRows, [{ source: 'famcal', failure: { kind: 'error', source: 'famcal', reason: null } }], 'FamCal error');
    const busy = reduceStore(run([answer(famcalAnswer())]), { type: 'windowFailed', ...agendaWeekWindow(TODAY, 1), sources: ['famcal'], kind: 'busy', epoch: 0 });
    const model = buildAgenda(busy, 2);
    assertJson(model?.stateRows, [{ source: 'famcal', failure: { kind: 'busy', source: 'famcal' } }], 'busy');
    assertJson(shape(model), [`D ${TODAY} today answered []`, `D ${day(1)} tomorrow answered []`, `F ${day(2)}..${day(6)}`], 'week 1 left out');
    assertJson(buildAgenda(busy, 1)?.stateRows, [], 'week 1 not shown: no row');
    // Week 2 answers: its empty days fold on their own; the failed week between ends the first run.
    const later = reduceStore(busy, answer(famcalAnswer(agendaWeekWindow(TODAY, 2))));
    assertJson(shape(buildAgenda(later, 3)), [
      `D ${TODAY} today answered []`,
      `D ${day(1)} tomorrow answered []`,
      `F ${day(2)}..${day(6)}`,
      `F ${day(14)}..${day(20)}`,
    ], 'weeks 0 and 2 answered, week 1 failed');
  });

  await check('a partial Google answer counts as answered and sets partial; unavailable calendars are counted', () => {
    const s = run([
      answer(googleAnswer({
        sources: { google: { status: 'ok', partial: { failed: 1, truncated: 0 } } },
        calendars: [
          { id: FAMILY_G.id, source: 'google', name: 'Family', color: null, mine: true },
          { id: 'gone@group.calendar.google.com', source: 'google', name: 'Old', color: null, mine: true, unavailable: true },
        ],
      })),
    ]);
    const model = buildAgenda(s);
    assert(model?.partial === true, 'partial');
    assertJson(shape(model), [`D ${TODAY} today answered []`, `D ${day(1)} tomorrow answered []`, `F ${day(2)}..${day(6)}`], 'entries');
    assert(homeNotices(s).unavailableCalendars === 1 && model?.unavailableCalendars === 1, 'unavailable');
    assert(buildAgenda(reduceStore(s, answer(googleAnswer())))?.partial === false, 'partial after a whole answer');
  });

  await check('agendaWeekWindow: week 0 is the route\'s no-dates window, each later week the next 7 days', () => {
    assertJson(agendaWeekWindow(TODAY, 0), { from: TODAY, to: '2026-10-22' }, 'week 0');
    assertJson(agendaWeekWindow(TODAY, 1), { from: '2026-10-22', to: '2026-10-29' }, 'week 1');
    assertJson(agendaWeekWindow('2026-12-28', 1), { from: '2027-01-04', to: '2027-01-11' }, 'across the year end');
  });

  await check('Still open: today\'s open reminders by time, then the carry-overs newest first; 5 shown, then the rest', () => {
    const todays = [rem('t2', T(0, '08:30'), { open: true }), rem('t1', T(0, '07:00'), { open: true }), rem('t3', T(0, '23:00'))];
    const carry = [1, 2, 3, 4, 5].map((n) => rem(`c${n}`, T(-n, '09:00'), { open: true, openSince: day(-n) }));
    const model = buildAgenda(run([answer(famcalAnswer({ days: { [TODAY]: todays }, carryOvers: carry }))]));
    const card = model?.stillOpen;
    assert(card != null, 'no card');
    assertJson(card.shown.map((r) => r.item.key), ['famcal|t1', 'famcal|t2', 'famcal|c1', 'famcal|c2', 'famcal|c3'], 'shown');
    assertJson(card.more.map((r) => r.item.key), ['famcal|c4', 'famcal|c5'], 'more');
    assertJson([...card.shown, ...card.more].map((r) => r.since), [TODAY, TODAY, day(-1), day(-2), day(-3), day(-4), day(-5)], 'since');
    assertJson(card.shown.map((r) => r.carriedOver), [false, false, true, true, true], 'carriedOver');
  });

  await check('Still open leaves out done reminders and the partner\'s own, and lists a key once', () => {
    const todays = [
      rem('done', T(0, '07:00'), { open: false, done: true, doneAt: T(0, '07:05') }),
      rem('noas', T(0, '07:30'), { open: true, ownerIsViewer: false, creatorIsViewer: false, ownerName: 'Noa', creatorName: 'Noa' }, { calendar: NOA_CAL }),
      rem('forNoa', T(0, '08:00'), { open: true, ownerIsViewer: false, ownerName: 'Noa' }),
      rem('fromNoa', T(0, '08:30'), { open: true, creatorIsViewer: false, creatorName: 'Noa' }, { calendar: MASKED }),
    ];
    const s = run([answer(famcalAnswer({ days: { [TODAY]: todays }, carryOvers: [rem('forNoa', T(0, '08:00'), { open: true, openSince: TODAY, ownerIsViewer: false, ownerName: 'Noa' })] }))]);
    const card = buildAgenda(s)?.stillOpen;
    assertJson(card?.shown.map((r) => r.item.key), ['famcal|forNoa', 'famcal|fromNoa'], 'shown');
    assertJson(card?.more, [], 'more');
    assert(buildAgenda(run([answer(famcalAnswer({ days: { [TODAY]: [todays[0]] } }))]))?.stillOpen === null, 'a card with nothing open');
  });

  await check('reminder marks: done, snoozed, open, later; events have none', () => {
    const marks = [
      rem('d', T(0, '07:00'), { done: true, doneAt: T(0, '07:01'), open: false }),
      rem('s', T(0, '07:00'), { open: true, snoozedUntil: T(0, '20:00') }),
      rem('o', T(0, '07:00'), { open: true }),
      rem('l', T(0, '23:00')),
      ev('e', T(0, '07:00'), T(0, '08:00')),
    ].map(reminderMark);
    assertJson(marks, ['done', 'snoozed', 'open', 'later', null], 'marks');
  });

  await check('whose: reminders go by ownerIsViewer and events by calendar.mine; "for" and "from" as the summaries say', async () => {
    const { reminderAttribution } = await import('../src/utils/event-formatter');
    const combos: [boolean, boolean][] = [[true, true], [true, false], [false, true], [false, false]];
    for (const [ownerIsViewer, creatorIsViewer] of combos) {
      const r = rem('r', T(0, '09:00'), {
        ownerIsViewer,
        creatorIsViewer,
        ...(ownerIsViewer ? {} : { ownerName: 'Noa' }),
        ...(creatorIsViewer ? {} : { creatorName: 'Noa' }),
      });
      const w = whoseItem(r, 'Noa');
      const said = reminderAttribution({ reminder: { ownerIsViewer, creatorIsViewer, ownerName: r.reminder?.ownerName, creatorName: r.reminder?.creatorName } });
      const ours = w.relation === null ? undefined : w.relation === 'from' ? `from ${w.person}` : `for ${w.person}, you asked`;
      assert(ours === said, `owner ${ownerIsViewer} creator ${creatorIsViewer}: ours ${ours}, the summary's ${said}`);
      assert(w.mine === ownerIsViewer, `owner ${ownerIsViewer} creator ${creatorIsViewer}: mine ${w.mine}`);
      assert((w.person === null) === (ownerIsViewer && creatorIsViewer), `owner ${ownerIsViewer} creator ${creatorIsViewer}: person ${w.person}`);
    }
    // A reminder for the viewer on the partner's calendar is the viewer's (not the calendar's).
    assert(whoseItem(rem('r', T(0, '09:00'), {}, { calendar: NOA_CAL }), 'Noa').mine === true, 'a reminder for me on Noa\'s calendar');
  });

  await check('whose: the person chip names the partner or the spouse calendar\'s person, with the partner as fallback', () => {
    const cases: [string, ItemDTO, string | null][] = [
      ['own event', ev('a', T(0, '09:00'), T(0, '10:00')), null],
      ['partner calendar', ev('b', T(0, '09:00'), T(0, '10:00'), { calendar: NOA_CAL }), 'Noa'],
      ['masked calendar', rem('c', T(0, '09:00'), { ownerIsViewer: false, creatorIsViewer: false }, { calendar: MASKED }), 'Noa'],
      ['Google family', gev('d', T(0, '09:00'), T(0, '10:00')), null],
      ['Google spouse', gev('e', T(0, '09:00'), T(0, '10:00'), { calendar: SPOUSE_G }), 'Dana'],
      ['from, name missing', rem('f', T(0, '09:00'), { creatorIsViewer: false }), 'Noa'],
    ];
    for (const [what, item, person] of cases) {
      const w = whoseItem(item, 'Noa');
      assert(w.person === person, `${what}: ${w.person}, want ${person}`);
    }
    const unpaired = whoseItem(rem('g', T(0, '09:00'), { creatorIsViewer: false }), null);
    assertJson(unpaired, { mine: true, person: null, relation: null }, 'no name anywhere');
    const rows = buildAgenda(run([answer(famcalAnswer({ days: { [TODAY]: [cases[1][1]] } }))]))?.entries[0];
    assert(rows?.type === 'day' && rows.rows[0].whose.person === 'Noa', 'the Agenda row\'s whose');
  });

  await check('the empty state shows only when every day answered and nothing is planned or open', () => {
    assert(buildAgenda(run([answer(famcalAnswer())]))?.empty === true, 'an empty week');
    assert(buildAgenda(run([answer(famcalAnswer({ carryOvers: [rem('old', T(-2, '09:00'), { open: true, openSince: day(-2) })] }))]))?.empty === false, 'with a carry-over');
    assert(buildAgenda(run([answer(famcalAnswer({ days: { [day(5)]: [ev('x', T(5, '09:00'), T(5, '10:00'))] } }))]))?.empty === false, 'with an event on day 5');
    assert(buildAgenda(run([answer(famcalAnswer())]), 2)?.empty === false, 'week 1 still loading');
  });

  await check('the model is client-safe: store.ts and agenda.ts load nothing outside src/lib/calendar-view', () => {
    const view = path.resolve(__dirname, '..', 'src', 'lib', 'calendar-view');
    const roots = [path.join(view, 'store.ts'), path.join(view, 'agenda.ts')];
    // Everything the two files required, and what that required in turn. They are the
    // smoke's first imports, so every module they need is loaded by them.
    const loaded = new Set<string>();
    const walk = (id: string) => {
      for (const child of require.cache[id]?.children ?? []) {
        if (loaded.has(child.id)) continue;
        loaded.add(child.id);
        walk(child.id);
      }
    };
    for (const id of roots) {
      assert(require.cache[id] !== undefined, `${id} is not in require.cache: the check would be empty`);
      walk(id);
    }
    assert(loaded.has(path.join(view, 'types.ts')), `types.ts not found among ${JSON.stringify([...loaded])}: the check would be empty`);
    assertJson([...loaded].filter((p) => !p.startsWith(view + path.sep)), [], 'modules outside src/lib/calendar-view');
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

- [ ] **Step 2: Run it and see it fail**

```bash
cd /Users/razielgershoni/development/famcalbot
for tz in UTC Asia/Jerusalem Pacific/Kiritimati; do TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-calendar-agenda.ts 2>&1 | grep '^Error:'; echo "smoke-calendar-agenda $tz exit=${pipestatus[1]}"; done
```
(Run it in zsh: `pipestatus` is zsh's. In bash, use `${PIPESTATUS[0]}`.)

Expected, under each clock:
```
Error: Cannot find module '../src/lib/calendar-view/store'
smoke-calendar-agenda UTC exit=1
```
(and the same two lines for `Asia/Jerusalem` and `Pacific/Kiritimati`). Why it fails: neither `store.ts` nor `agenda.ts` exists yet, so the smoke's first import stops it before any check runs.

- [ ] **Step 3: Create `src/lib/calendar-view/store.ts`**

Create the file with exactly this content:

```ts
// The calendar home's client store (spec §5): one store of days, fed by the answers of
// GET /api/calendar/range and shared by the Agenda (Plan D) and the Month (Plan E).
// A reducer for React's useReducer: pure, no fetch, no clock, no storage. It imports
// only the DTO types, so it is client-safe and the smoke runs it as it is.
//
// - An answer replaces, for each source whose status in it is `ok`, that source's items
//   on every day of its [from, to). Other days, and sources with any other status,
//   keep what they had. Within a day, items are deduped by key and sorted with
//   compareItems.
// - The first answer pins tz, today, week start and the sources that apply. A later
//   answer with other values drops the store and starts over; so does `reset` (the
//   midnight timer). Each drop bumps `epoch`, and an answer to a request sent under an
//   older epoch is kept only while its facts still match.
// - Each day remembers, per source, whether an ok answer covered it ("answered", spec
//   §5 "Empty means answered") and whether a failed one did. Only answered days may
//   read as empty.

import {
  compareItems,
  type CalendarDTO,
  type DayKey,
  type GoogleStatusReason,
  type ItemDTO,
  type RangeResponse,
  type SourceName,
  type WeekStart,
} from './types';

/** The order sources are listed in: FamCal before Google, as compareItems does. */
export const SOURCE_ORDER: readonly SourceName[] = ['famcal', 'google'];

export type FamcalStatus = NonNullable<RangeResponse['sources']['famcal']>;
export type GoogleStatus = NonNullable<RangeResponse['sources']['google']>;

/** What the server worked out for this user. Every answer carries them. */
export interface StoreFacts {
  tz: string;
  today: DayKey;
  weekStart: WeekStart;
  /** Not pinned: it follows the latest answer (no stored data depends on it). */
  hebrewDates: boolean;
  /** The sources that apply to this user (the keys of an answer's `sources`), in SOURCE_ORDER. */
  sources: SourceName[];
}

/** One source on one day. */
export interface DayCoverage {
  /** An ok answer covered the day: the source's items on it are the latest ok answer's. */
  ok: boolean;
  /** An error or reconnect answer, or a failed request, covered it while no ok answer had. */
  failed: boolean;
  /** The latest ok answer was partial (Google calendars that failed or were cut short). */
  partial: boolean;
}

export interface StoreDay {
  /** Every applicable source's items on the day, deduped by key, sorted with compareItems. */
  items: ItemDTO[];
  coverage: Partial<Record<SourceName, DayCoverage>>;
}

/** Why a source has no data for a day: what its state row says (spec §5 States). */
export type SourceFailure =
  | { kind: 'error'; source: SourceName; reason: GoogleStatusReason | null }
  | { kind: 'calendarsGone'; source: 'google' }
  | { kind: 'reconnect'; source: 'google'; reason: 'token' | 'scopes' }
  | { kind: 'busy'; source: SourceName };

export interface CalendarStore {
  /** Bumped by every drop. Stamp each request with it and pass it back with the answer. */
  epoch: number;
  /** null until the first answer, and after a drop by `reset`. */
  facts: StoreFacts | null;
  days: Readonly<Record<DayKey, StoreDay>>;
  /** Each source's status in the latest answer that asked for it (a `pending` one never overwrites it). */
  status: { famcal?: FamcalStatus; google?: GoogleStatus };
  /** Each source's latest failure, kept after a later ok answer for another window: the state row's copy. */
  lastFailure: Partial<Record<SourceName, SourceFailure>>;
  /** The legend from each source's latest ok answer, FamCal first. */
  calendars: CalendarDTO[];
  /** From the latest answer with FamCal ok. */
  partner: { name: string } | null;
  /** From the latest answer that carried them (FamCal ok and a window holding today), newest first; null before. */
  carryOvers: ItemDTO[] | null;
}

export type StoreAction =
  /** An answer (HTTP 200). `epoch` is the store's epoch when the request was sent. */
  | { type: 'response'; response: RangeResponse; epoch: number }
  /**
   * A request that got no answer to store: 429 (`busy`), 500 or a network error
   * (`error`). Its days that no ok answer covers read as failed, not loading. Needs
   * pinned facts: before the first answer the container shows its own retry card.
   */
  | { type: 'windowFailed'; from: DayKey; to: DayKey; sources: readonly SourceName[]; kind: 'busy' | 'error'; epoch: number }
  /** The midnight timer in tz: drop everything and start over. */
  | { type: 'reset' };

/** A day as the screens see it: every source answered ok, one still to answer, or none will. */
export type DayStatus = 'answered' | 'loading' | 'failed';

/** What the banners need from the store (spec §5 States, §7.2 Banners). */
export interface HomeNotices {
  /** Google asked for a reconnect in its latest answer. Never set for a FamCal user. */
  reconnect: 'token' | 'scopes' | null;
  /** Chosen Google calendars that are gone: "N calendars aren't available · Choose again". */
  unavailableCalendars: number;
}

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
/** A guard for the day loops: the route answers at most 42 days. */
const MAX_WINDOW_DAYS = 366;
const NO_ITEMS: readonly ItemDTO[] = Object.freeze([]);

/** Plus `days` calendar days to a yyyy-MM-dd key, in UTC arithmetic: the same as the server's addDaysToDate. */
export function addDaysToKey(day: DayKey, days: number): DayKey {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** The day keys in [from, to); none for a malformed window. */
export function daysInWindow(from: DayKey, to: DayKey): DayKey[] {
  if (!DAY_KEY.test(from) || !DAY_KEY.test(to)) return [];
  const out: DayKey[] = [];
  for (let d = from; d < to && out.length < MAX_WINDOW_DAYS; d = addDaysToKey(d, 1)) out.push(d);
  return out;
}

export function emptyStore(epoch = 0): CalendarStore {
  return { epoch, facts: null, days: {}, status: {}, lastFailure: {}, calendars: [], partner: null, carryOvers: null };
}

function factsOf(r: RangeResponse): StoreFacts {
  return {
    tz: r.tz,
    today: r.today,
    weekStart: r.weekStart,
    hebrewDates: r.hebrewDates,
    sources: SOURCE_ORDER.filter((s) => r.sources[s] !== undefined),
  };
}

/** The pinned facts: tz, today, week start and the sources. hebrewDates is not one of them. */
function samePinnedFacts(a: StoreFacts, b: StoreFacts): boolean {
  return a.tz === b.tz && a.today === b.today && a.weekStart === b.weekStart && a.sources.join() === b.sources.join();
}

function famcalFailure(s: FamcalStatus): SourceFailure | null {
  return s.status === 'error' ? { kind: 'error', source: 'famcal', reason: null } : null;
}

function googleFailure(s: GoogleStatus): SourceFailure | null {
  if (s.status === 'reconnect') return { kind: 'reconnect', source: 'google', reason: s.reason === 'scopes' ? 'scopes' : 'token' };
  if (s.status !== 'error') return null;
  if (s.reason === 'calendars_gone') return { kind: 'calendarsGone', source: 'google' };
  return { kind: 'error', source: 'google', reason: s.reason ?? null };
}

function isPartial(s: GoogleStatus): boolean {
  return s.status === 'ok' && !!s.partial && (s.partial.failed > 0 || s.partial.truncated > 0);
}

/** Deduped by key (the first one stays), then sorted with compareItems. A new array. */
function dedupeSorted(items: readonly ItemDTO[]): ItemDTO[] {
  const seen = new Set<string>();
  const out: ItemDTO[] = [];
  for (const item of items) {
    if (seen.has(item.key)) continue;
    seen.add(item.key);
    out.push(item);
  }
  return out.sort(compareItems);
}

const failedCoverage = (): DayCoverage => ({ ok: false, failed: true, partial: false });

/** Merges an answer whose facts match `state.facts` (already pinned). */
function merge(state: CalendarStore, r: RangeResponse): CalendarStore {
  const ok: SourceName[] = [];
  const failures: SourceFailure[] = [];
  const status = { ...state.status };
  let partial = false;
  const famcal = r.sources.famcal;
  if (famcal && famcal.status !== 'pending') {
    status.famcal = famcal;
    if (famcal.status === 'ok') ok.push('famcal');
    const f = famcalFailure(famcal);
    if (f) failures.push(f);
  }
  const google = r.sources.google;
  if (google && google.status !== 'pending') {
    status.google = google;
    if (google.status === 'ok') ok.push('google');
    partial = isPartial(google);
    const f = googleFailure(google);
    if (f) failures.push(f);
  }
  if (ok.length === 0 && failures.length === 0) {
    // Only pending sources: nothing to store (hebrewDates may still have moved).
    return state;
  }

  const lastFailure = { ...state.lastFailure };
  for (const f of failures) lastFailure[f.source] = f;

  const incoming = new Map<DayKey, readonly ItemDTO[]>();
  for (const d of r.days) incoming.set(d.date, d.items);
  const days: Record<DayKey, StoreDay> = { ...state.days };
  for (const date of daysInWindow(r.from, r.to)) {
    const prev = state.days[date];
    const coverage = { ...prev?.coverage };
    let items = prev ? prev.items : [];
    if (ok.length > 0) {
      // Only the ok sources' items are read from the answer, and only theirs are replaced.
      const kept = items.filter((i) => !ok.includes(i.source));
      const fresh = (incoming.get(date) ?? NO_ITEMS).filter((i) => ok.includes(i.source));
      items = dedupeSorted([...kept, ...fresh]);
      for (const s of ok) coverage[s] = { ok: true, failed: false, partial: s === 'google' && partial };
    }
    for (const f of failures) {
      if (!coverage[f.source]?.ok) coverage[f.source] = failedCoverage();
    }
    days[date] = { items, coverage };
  }

  const calendars =
    ok.length > 0
      ? SOURCE_ORDER.flatMap((s) => (ok.includes(s) ? r.calendars : state.calendars).filter((c) => c.source === s))
      : state.calendars;
  const partner = ok.includes('famcal') ? (r.partner ? { name: r.partner.name } : null) : state.partner;
  const carryOvers = r.carryOvers ? [...r.carryOvers] : state.carryOvers;
  return { ...state, days, status, lastFailure, calendars, partner, carryOvers };
}

function receive(state: CalendarStore, r: RangeResponse, epoch: number): CalendarStore {
  const facts = factsOf(r);
  let base: CalendarStore;
  if (state.facts && samePinnedFacts(state.facts, facts)) {
    base = state.facts.hebrewDates === facts.hebrewDates ? state : { ...state, facts: { ...state.facts, hebrewDates: facts.hebrewDates } };
  } else if (epoch < state.epoch) {
    // Asked before the last drop, and its facts are not the store's: it is stale.
    return state;
  } else {
    // The first answer pins the facts; a mismatch drops the store and pins the new ones.
    base = { ...emptyStore(state.facts ? state.epoch + 1 : state.epoch), facts };
  }
  return merge(base, r);
}

function markFailed(state: CalendarStore, a: Extract<StoreAction, { type: 'windowFailed' }>): CalendarStore {
  if (!state.facts || a.epoch < state.epoch) return state;
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
  }
  return { ...state, days, lastFailure };
}

/** The reducer. It never changes `state` or the answer; an action that changes nothing returns `state` itself. */
export function reduceStore(state: CalendarStore, action: StoreAction): CalendarStore {
  switch (action.type) {
    case 'reset':
      return emptyStore(state.epoch + 1);
    case 'response':
      return receive(state, action.response, action.epoch);
    case 'windowFailed':
      return markFailed(state, action);
  }
}

/** A day's items, every applicable source's, sorted with compareItems. */
export function dayItems(state: CalendarStore, day: DayKey): readonly ItemDTO[] {
  return state.days[day]?.items ?? NO_ITEMS;
}

/**
 * Whether a day may read as empty: `answered` once every applicable source answered ok
 * for it (partial included), now or earlier; `loading` while one has not answered yet;
 * `failed` when the rest failed (error, reconnect, a failed request) with no ok data.
 */
export function dayStatus(state: CalendarStore, day: DayKey): DayStatus {
  if (!state.facts) return 'loading';
  const coverage = state.days[day]?.coverage ?? {};
  let failed = false;
  for (const s of state.facts.sources) {
    const c = coverage[s];
    if (c?.ok) continue;
    if (c?.failed) {
      failed = true;
      continue;
    }
    return 'loading';
  }
  return failed ? 'failed' : 'answered';
}

/** The applicable sources that failed on a day with no ok data, in SOURCE_ORDER. */
export function failedSources(state: CalendarStore, day: DayKey): SourceName[] {
  if (!state.facts) return [];
  const coverage = state.days[day]?.coverage ?? {};
  return state.facts.sources.filter((s) => !coverage[s]?.ok && coverage[s]?.failed === true);
}

/** Whether the day's Google data came from a partial answer. */
export function isPartialDay(state: CalendarStore, day: DayKey): boolean {
  const c = state.days[day]?.coverage.google;
  return !!c?.ok && c.partial;
}

export function homeNotices(state: CalendarStore): HomeNotices {
  const g = state.status.google;
  return {
    reconnect: g?.status === 'reconnect' ? (g.reason === 'scopes' ? 'scopes' : 'token') : null,
    unavailableCalendars: state.calendars.filter((c) => c.source === 'google' && c.unavailable === true).length,
  };
}
```

- [ ] **Step 4: Create `src/lib/calendar-view/agenda.ts`**

Create the file with exactly this content:

```ts
// The Agenda's model (spec §7.3, Rulings R8 and R10): what the Agenda shows, worked out
// from the client store. Pure and client-safe: it imports only the store and the DTO
// types. The view (AgendaView, DayList, ItemRow) formats dates, times and copy; this
// file decides which days show, which fold, which state rows appear, what the
// "Still open" card holds and whose each item is.
//
// - Today and the next 6 days; each "Show next week" adds 7 (weeks = 2, 3, …).
// - Today and tomorrow always show. A later empty day folds into one line with its
//   empty neighbours, but only once every applicable source answered ok for it (§5).
// - A day a source failed for, with no earlier ok data, shows no empty line and no
//   fold; the source's state row shows once, above the days. A reconnect is the
//   Reconnect banner's (homeNotices, in the container), never a state row.
// - Still open: today's open reminders by time, then the carry-overs newest first;
//   5 shown, then the rest.

import type { DayKey, ItemDTO, SourceName, WeekStart } from './types';
import {
  SOURCE_ORDER,
  addDaysToKey,
  dayItems,
  dayStatus,
  failedSources,
  homeNotices,
  isPartialDay,
  type CalendarStore,
  type DayStatus,
  type SourceFailure,
} from './store';

/** Days in one Agenda week: today and the next 6 (Ruling R8), and each "Show next week". */
export const AGENDA_WEEK_DAYS = 7;
/** The "Still open" card shows this many, then "N more". */
export const STILL_OPEN_SHOWN = 5;

/**
 * Whose an item is (§7.3, Ruling R7). A reminder goes by `reminder.ownerIsViewer`, the
 * summaries' rule (categorizeEvents in src/services/telegram/summary.ts); an event by
 * `calendar.mine`. `mine` decides filled or outlined chips and filled or ring dots.
 */
export interface Whose {
  mine: boolean;
  /** The name on the person chip: the partner, or a spouse-labelled Google calendar's person. null on the viewer's own. */
  person: string | null;
  /**
   * Reminders only, as the summaries' reminderAttribution (src/utils/event-formatter.ts):
   * 'for' = the viewer set it for `person`; 'from' = `person` set it for the viewer.
   * null on the viewer's own and on one the partner set for themselves. Never set
   * without a name.
   */
  relation: 'for' | 'from' | null;
}

/** A reminder's icon (§7.3): open circle, check (title struck through), open circle with "until <time>", bell. */
export type ReminderMark = 'open' | 'done' | 'snoozed' | 'later';

export interface AgendaRow {
  item: ItemDTO;
  whose: Whose;
  /** null for events. */
  mark: ReminderMark | null;
}

export interface AgendaDay {
  type: 'day';
  date: DayKey;
  /** "Today", "Tomorrow", or null for the weekday and date. */
  relative: 'today' | 'tomorrow' | null;
  /**
   * With no rows: `answered` → "Nothing planned" (only today and tomorrow get here
   * empty); `loading` → placeholder rows; `failed` → nothing under the header (the
   * state row above says why). With rows, `loading` adds placeholders after them.
   */
  status: DayStatus;
  rows: AgendaRow[];
}

/** Later empty days, answered, in a run: "Nothing planned Sat 17 – Sun 18 Oct". first === last for one day. */
export interface AgendaFold {
  type: 'fold';
  first: DayKey;
  last: DayKey;
}

export type AgendaEntry = AgendaDay | AgendaFold;

export interface StillOpenRow extends AgendaRow {
  /** "since <day>": the carry-over's openSince, or today for today's. */
  since: DayKey;
  carriedOver: boolean;
}

export interface StillOpenCard {
  shown: StillOpenRow[];
  /** "N more" is more.length. */
  more: StillOpenRow[];
}

/** A source that has no data for some shown day, and why. */
export interface AgendaStateRow {
  source: SourceName;
  failure: Exclude<SourceFailure, { kind: 'reconnect' }>;
}

export interface AgendaModel {
  today: DayKey;
  tz: string;
  weekStart: WeekStart;
  hebrewDates: boolean;
  weeks: number;
  /** The day after the last one listed: the days are [today, end). */
  end: DayKey;
  /** At most one per source, in SOURCE_ORDER, above the days. */
  stateRows: AgendaStateRow[];
  /** A shown day's Google data came from a partial answer: "Some calendars didn't load · Retry". */
  partial: boolean;
  /** Chosen Google calendars that are gone: "N calendars aren't available · Choose again". */
  unavailableCalendars: number;
  /** null when nothing is open. */
  stillOpen: StillOpenCard | null;
  entries: AgendaEntry[];
  /** Every shown day answered, none has an item, and nothing is open: Ruling R10's empty state. */
  empty: boolean;
}

/**
 * The window week `week` of the Agenda reads: week 0 is [today, today+7), the route's
 * answer with no dates; week n is the n-th "Show next week".
 */
export function agendaWeekWindow(today: DayKey, week: number): { from: DayKey; to: DayKey } {
  return { from: addDaysToKey(today, week * AGENDA_WEEK_DAYS), to: addDaysToKey(today, (week + 1) * AGENDA_WEEK_DAYS) };
}

const VIEWERS_OWN: Whose = { mine: true, person: null, relation: null };

/** Whose an item is. `partnerName` (the store's partner) names the partner when the item doesn't. */
export function whoseItem(item: ItemDTO, partnerName: string | null): Whose {
  const r = item.reminder;
  if (item.kind === 'reminder' && r) {
    if (r.ownerIsViewer) {
      if (r.creatorIsViewer) return VIEWERS_OWN;
      const from = r.creatorName ?? partnerName;
      return from ? { mine: true, person: from, relation: 'from' } : VIEWERS_OWN;
    }
    const owner = r.ownerName ?? item.calendar.ownerName ?? partnerName;
    return { mine: false, person: owner ?? null, relation: r.creatorIsViewer && owner ? 'for' : null };
  }
  if (item.calendar.mine) return VIEWERS_OWN;
  // A masked calendar's name is the partner's name (never the calendar's own).
  const person = item.calendar.ownerName ?? (item.calendar.inLegend ? null : item.calendar.name || null);
  return { mine: false, person, relation: null };
}

/** A reminder's icon; null for events. A running snooze shows even though it is still open. */
export function reminderMark(item: ItemDTO): ReminderMark | null {
  const r = item.reminder;
  if (item.kind !== 'reminder' || !r) return null;
  if (r.done) return 'done';
  if (r.snoozedUntil) return 'snoozed';
  if (r.open) return 'open';
  return 'later';
}

function toRow(item: ItemDTO, partnerName: string | null): AgendaRow {
  return { item, whose: whoseItem(item, partnerName), mark: reminderMark(item) };
}

/** Today's reminders for the card: open, not done, and the viewer's to act on (its owner or its creator, as carry-overs: A-17). */
function isOpenForViewer(item: ItemDTO): boolean {
  const r = item.reminder;
  return item.kind === 'reminder' && !!r && r.open && !r.done && (r.ownerIsViewer || r.creatorIsViewer);
}

function stillOpenCard(state: CalendarStore, today: DayKey, partnerName: string | null): StillOpenCard | null {
  const rows: StillOpenRow[] = [];
  const seen = new Set<string>();
  for (const item of dayItems(state, today)) {
    if (!isOpenForViewer(item) || seen.has(item.key)) continue;
    seen.add(item.key);
    rows.push({ ...toRow(item, partnerName), since: today, carriedOver: false });
  }
  for (const item of state.carryOvers ?? []) {
    if (seen.has(item.key)) continue;
    seen.add(item.key);
    rows.push({ ...toRow(item, partnerName), since: item.reminder?.openSince ?? today, carriedOver: true });
  }
  if (rows.length === 0) return null;
  return { shown: rows.slice(0, STILL_OPEN_SHOWN), more: rows.slice(STILL_OPEN_SHOWN) };
}

/** The Agenda for `weeks` weeks (1 = today + 6 days); null until the first answer pins the facts. */
export function buildAgenda(state: CalendarStore, weeks = 1): AgendaModel | null {
  const facts = state.facts;
  if (!facts) return null;
  const count = Math.max(1, Math.floor(weeks)) * AGENDA_WEEK_DAYS;
  const partnerName = state.partner?.name ?? null;
  const { today } = facts;

  const entries: AgendaEntry[] = [];
  const failing = new Set<SourceName>();
  let fold: AgendaFold | null = null;
  let partial = false;
  let nothing = true;
  for (let i = 0; i < count; i++) {
    const date = addDaysToKey(today, i);
    const status = dayStatus(state, date);
    const rows = dayItems(state, date).map((item) => toRow(item, partnerName));
    for (const s of failedSources(state, date)) failing.add(s);
    if (isPartialDay(state, date)) partial = true;
    if (status !== 'answered' || rows.length > 0) nothing = false;
    const relative = i === 0 ? 'today' : i === 1 ? 'tomorrow' : null;
    if (relative === null && rows.length === 0 && status !== 'loading') {
      if (status === 'answered') {
        if (fold) fold.last = date;
        else {
          fold = { type: 'fold', first: date, last: date };
          entries.push(fold);
        }
      } else {
        // Failed with nothing to show: left out, and the run of empty days ends here.
        fold = null;
      }
      continue;
    }
    fold = null;
    entries.push({ type: 'day', date, relative, status, rows });
  }

  const stateRows: AgendaStateRow[] = [];
  for (const source of SOURCE_ORDER) {
    if (!failing.has(source)) continue;
    const failure: SourceFailure = state.lastFailure[source] ?? { kind: 'error', source, reason: null };
    if (failure.kind === 'reconnect') continue;
    stateRows.push({ source, failure });
  }

  const stillOpen = stillOpenCard(state, today, partnerName);
  return {
    today,
    tz: facts.tz,
    weekStart: facts.weekStart,
    hebrewDates: facts.hebrewDates,
    weeks: count / AGENDA_WEEK_DAYS,
    end: addDaysToKey(today, count),
    stateRows,
    partial,
    unavailableCalendars: homeNotices(state).unavailableCalendars,
    stillOpen,
    entries,
    empty: nothing && stillOpen === null,
  };
}
```

- [ ] **Step 5: Run the smoke under the three clocks, and the DTO smoke as the regression**

```bash
cd /Users/razielgershoni/development/famcalbot
for tz in UTC Asia/Jerusalem Pacific/Kiritimati; do TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-calendar-agenda.ts 2>&1 | grep -E -A2 '^FAIL|passed'; echo "smoke-calendar-agenda $tz exit=${pipestatus[1]}"; done
for tz in UTC Asia/Jerusalem Pacific/Kiritimati; do TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-calendar-dto.ts 2>&1 | tail -1; echo "smoke-calendar-dto $tz exit=${pipestatus[1]}"; done
```
(zsh, as in Step 2.)

Expected for the new smoke: no `FAIL` line. Under each clock you see:
```
33/33 passed (process TZ=UTC)
smoke-calendar-agenda UTC exit=0
```
and the same for `Asia/Jerusalem` and `Pacific/Kiritimati`. The full output under `TZ=UTC`, which the other two clocks repeat line for line except for the TZ name:
```
OK  an empty store has no facts, no Agenda, and every day is loading
OK  the first answer pins tz, today, week start and the sources that apply
OK  a day's items are deduped by key and sorted with compareItems
OK  an ok answer replaces its source's items on every day of its window, and only there
OK  a multi-day item has one entry on each of its days
OK  an error or a reconnect keeps the earlier ok items, and the day stays answered
OK  a pending source changes nothing: not its status, not its days
OK  items of a source that is not ok are never stored
OK  with both sources, an answer replaces only its ok sources' items and never stores a failed one's
OK  a different tz, today, week start or set of sources drops the store and bumps the epoch
OK  hebrewDates follows the latest answer, without a drop
OK  an answer sent before the last drop is kept only when its facts still match
OK  reset (the midnight timer) empties the store; an answer sent before it is ignored
OK  the legend, the partner and the carry-overs come only from answers that carry them
OK  the reducer never changes its input
OK  a failed request marks only the days no ok answer covers
OK  addDaysToKey matches the server's addDaysToDate across DST and year ends
OK  the Agenda lists today and the next 6 days; today and tomorrow show even when empty
OK  Show next week adds 7 days, and a fold runs across the week boundary
OK  nothing reads as empty before every source has answered
OK  a source that failed with no earlier ok data shows its state row once, and no empty line or fold
OK  an error after an ok answer shows the earlier data and no state row
OK  reconnect is never a state row: the banner (homeNotices) carries it, and only for Google users
OK  calendars_gone, a FamCal error and a busy request each give their own state row
OK  a partial Google answer counts as answered and sets partial; unavailable calendars are counted
OK  agendaWeekWindow: week 0 is the route's no-dates window, each later week the next 7 days
OK  Still open: today's open reminders by time, then the carry-overs newest first; 5 shown, then the rest
OK  Still open leaves out done reminders and the partner's own, and lists a key once
OK  reminder marks: done, snoozed, open, later; events have none
OK  whose: reminders go by ownerIsViewer and events by calendar.mine; "for" and "from" as the summaries say
OK  whose: the person chip names the partner or the spouse calendar's person, with the partner as fallback
OK  the empty state shows only when every day answered and nothing is planned or open
OK  the model is client-safe: store.ts and agenda.ts load nothing outside src/lib/calendar-view

33/33 passed (process TZ=UTC)
```
Expected for the regression: `23/23 passed (process TZ=…)` and `exit=0` under each clock. This task doesn't modify `src/lib/calendar-view/types.ts` or anything the DTO smoke loads.

If only the client-safety check fails, `store.ts` or `agenda.ts` imports something outside `src/lib/calendar-view/`. Remove that import; don't change the check. The home's client bundle must not pull in server code.

- [ ] **Step 6: Type-check and lint**

```bash
cd /Users/razielgershoni/development/famcalbot
npx tsc --noEmit -p . && npm run -s lint; echo "exit $?"
```
Expected: no output from either, then `exit 0`. `next build` type-checks `scripts/**`, so the smoke is covered too.

- [ ] **Step 7: Commit**

```bash
cd /Users/razielgershoni/development/famcalbot
git add src/lib/calendar-view/store.ts src/lib/calendar-view/agenda.ts scripts/smoke-calendar-agenda.ts
git commit -m "$(cat <<'EOF'
feat(calendar-home): the client store and the Agenda model

reduceStore keeps the home's days from GET /api/calendar/range answers.
An ok answer replaces its source's items over its window; an error, a
reconnect or a pending source never wipes what an earlier ok answer
brought; a new timezone, today, week start or set of sources, or the
midnight reset, drops the store. buildAgenda turns it into today and the
next 6 days (plus 7 per "Show next week"), folds later empty days only
once every source answered ok for them, shows a failed source's state
row instead of empty lines, fills the "Still open" card and says whose
each item is, by the summaries' rules. Pure and client-safe. Nothing
renders it yet, and the switch stays OFF.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
EOF
)"
```
Stage only these three paths. The working tree may show plan or spec files as modified; they aren't part of this task.

---

### Task 4 (D4): Telegram and send plumbing (spec §7.2's send path, Ruling R5, §7.1 Look, §7.6)

> **INTERFACE ADDITIONS versus the split (nothing in the split is renamed or removed):**
> 1. `src/lib/telegram-ui.ts` (the split's first choice of place) exports, besides the split's **`useTelegramBackButton(active, onBack)`**, the theme application as **`useTelegramTheme(): ColorScheme`**, plus **`onTelegramEvent`** (D6's Telegram `activated` refetch), **`openExternalLink`** (D5's "Open in Google Calendar"), **`isInTelegram`**, **`telegramSupports`**, **`telegramWebApp`** and **`applyTelegramColours`**. Each gated and wrapped as §7.6 asks, so D5 and D6 never call the SDK directly.
> 2. `command-client.ts`'s answer is a **`SendResult`** union: `closing` | `sent` (with `chat: 'whatsapp' | 'telegram'`) | `busy` | `failed` (with `status: number | null`). **`sent` with `chat: 'telegram'`** is the one case the split's copy list doesn't name: inside Telegram, a 2xx when the SDK can't close the app (script blocked, `close()` threw). The answer is then in the Telegram chat, so "Sent to WhatsApp" would be wrong. **D1 needs one more send result string for it** (e.g. "Sent. It's in your chat with FamCal"), and D6 maps it.
> 3. A second smoke, **`scripts/smoke-telegram-ui.ts`**, beside the split's `scripts/smoke-command-client.ts`: the BackButton and theme hooks run in real React there.

**What and why:** The new home needs two pieces of plumbing before any of its screens exist.
- **Send to chat (R5).** The old dashboard's call (`DashboardClient.tsx:105-137`) closes the Mini App in a `finally`, whatever the answer. A 429 or a 500 vanishes with the app. It also "closes" in a plain browser, because the SDK defines `Telegram.WebApp` there too. `src/lib/command-client.ts` makes the same POST to `/api/execute-command`, with the initData header and the body copy as the fallback. Inside Telegram (`readInitData()` non-empty) it closes only on a 2xx. A 429 answers `busy` ("try in a minute"), anything else `failed`, and the app stays open. In a browser it never closes: a 2xx is "Sent to WhatsApp". The old dashboard keeps its own call, unchanged.
- **Telegram calls (§7.6, §7.1 Look).** `src/lib/telegram-ui.ts`:
  - `useTelegramBackButton(active, onBack)`: `hide()` on mount, since the client keeps the button across reloads. While active: one handler, then `show()`. Whenever it stops being needed: `offClick(handler)`, then `hide()`.
  - `useTelegramTheme()`: on mount and on every `themeChanged`, `setHeaderColor('bg_color')` and `setBackgroundColor('bg_color')`. It returns the scheme to render: Telegram's `colorScheme` inside Telegram, `prefers-color-scheme` in a browser.
  - Every call is gated with `isVersionAtLeast` and wrapped in try/catch.
- `src/types/telegram-webapp.d.ts` gains the members §7.6 lists.

Nothing renders any of this yet: D5 and D6 do. The switch stays `OFF`, and no user sees a change.

**Files:**
- Modify: `src/types/telegram-webapp.d.ts`, two spots (as of the real base, where the file is still identical to `main@858886c`):
  - `:34-51`: the event-name type and the inset interface before `interface TelegramWebApp`, the newer theme colours, and `safeAreaInset` / `contentSafeAreaInset`;
  - `:60-61`: `isVersionAtLeast`, the vertical-swipe pair, `onEvent` / `offEvent`.
- Create: `src/lib/telegram-ui.ts`
- Create: `src/lib/command-client.ts`
- Create (test): `scripts/smoke-command-client.ts`
- Create (test): `scripts/smoke-telegram-ui.ts`
- Test: both new smokes, and `npx tsc --noEmit` (check #1 of `smoke-telegram-ui.ts` is compile-time)
- Regression (unchanged): `scripts/smoke-initdata-header.ts` (its #8 scans `src/**` for initData in URLs, so it reads the new files), `scripts/smoke-miniapp-gate.ts` (PageGate's own Telegram calls, which this task leaves alone)
- Unchanged on purpose: `app/[locale]/dashboard/DashboardClient.tsx` (the old home keeps its `executeCommand`; `smoke-command-client.ts` #11 guards that), `app/[locale]/PageGate.tsx`.

**Interfaces:**
- Consumes:
  - `readInitData(): string` and `INIT_DATA_HEADER = 'X-Telegram-Init-Data'` (`src/lib/read-init-data.ts:14`, `:35`);
  - `POST /api/execute-command` (`app/api/execute-command/route.ts`):
    - body `{ user_id, command, args?, initData? }`; initData is the header first, then a non-empty string in the body (`requestInitData`, `src/lib/request-init-data.ts:9-14`);
    - answers 200 `{ success: true }` at once and runs the command in `after()`;
    - 400 for missing parameters, `no_channel` or an unknown command; 401, 403, 404 and 429 from `verifyUserAuth`; 500;
  - React 19.2: `useEffect`, `useEffectEvent`, `useSyncExternalStore` (`useEffectEvent` is also in Next 16.1's vendored React);
  - the Telegram SDK that `app/[locale]/layout.tsx:102-105` loads before any page code.
  - No other D task's export. No stand-ins were needed.
- Produces, global types in `src/types/telegram-webapp.d.ts`:
  - `type TelegramWebAppEventType = 'themeChanged' | 'viewportChanged' | 'backButtonClicked' | 'mainButtonClicked' | 'settingsButtonClicked' | 'popupClosed' | 'invoiceClosed' | 'activated' | 'deactivated' | 'safeAreaChanged' | 'contentSafeAreaChanged'`
  - `interface TelegramWebAppSafeAreaInset { top: number; bottom: number; left: number; right: number }`
  - on `TelegramWebApp`:
    - `isVersionAtLeast(version: string): boolean`;
    - `enableVerticalSwipes()` and `disableVerticalSwipes()` (Plan E);
    - `onEvent(eventType, eventHandler)` and `offEvent(eventType, eventHandler)`;
    - `safeAreaInset` and `contentSafeAreaInset`;
    - `themeParams.header_bg_color`, `accent_text_color`, `section_bg_color`, `section_header_text_color`, `section_separator_color`, `subtitle_text_color` and `destructive_text_color`.
- Produces, `src/lib/telegram-ui.ts` (client components only):
  - `export function telegramWebApp(): TelegramWebApp | null`
  - `export function isInTelegram(): boolean`: `readInitData() !== ''`.
  - `export function telegramSupports(version: string): boolean`
  - `export function onTelegramEvent(event: TelegramWebAppEventType, handler: () => void): () => void`. It subscribes only when the client has the event (`activated` / `deactivated` / the safe-area events: 8.0; `backButtonClicked`: 6.1; the rest: 6.0). It returns the unsubscribe, a no-op when nothing subscribed.
  - `export function useTelegramBackButton(active: boolean, onBack: () => void): void`
  - `export type ColorScheme = 'light' | 'dark'`
  - `export function applyTelegramColours(): void`
  - `export function useTelegramTheme(): ColorScheme` (`'light'` on the server)
  - `export function openExternalLink(url: string): boolean`. It opens http(s) links only: `openLink` on a 6.1+ client, else `window.open(url, '_blank', 'noopener,noreferrer')`.
- Produces, `src/lib/command-client.ts`:
  - `export const SEND_ITEMS = ['today', 'tomorrow', 'thisWeek', 'nextWeek', 'weather'] as const` (the sheet's order) and `export type SendItem = (typeof SEND_ITEMS)[number]`
  - `export type SendCommand = { command: 'summary' | 'lookahead' | 'nextweek' | 'weather'; args?: 'tmrw' }`
  - `export const SEND_COMMANDS: Record<SendItem, SendCommand>`: today → `summary`; tomorrow → `summary` with `tmrw`; thisWeek → `lookahead`; nextWeek → `nextweek`; weather → `weather`. These are the old dashboard's five buttons.
  - `export type SendResult = { outcome: 'closing' } | { outcome: 'sent'; chat: 'whatsapp' | 'telegram' } | { outcome: 'busy' } | { outcome: 'failed'; status: number | null }`
  - `export async function sendToChat(userId: number, item: SendItem, locale: string): Promise<SendResult>`
- How D5 and D6 use them:
  - **D5, `ItemSheet`:**
    - `useTelegramBackButton(open, onClose)`. In Plan D the item sheet is the button's only owner. The SDK calls every registered handler, and any `hide()` hides the one button. So Plan E moves the single call up to `CalendarHome`, with `active = sheetOpen || picked`.
    - "Open in Google Calendar" is `openExternalLink(item.htmlLink)`, shown only when `item.source === 'google' && item.htmlLink`.
  - **D6, `CalendarHome`:**
    - `const scheme = useTelegramTheme()`, rendered as e.g. `data-theme={scheme}` on the home's root. The CSS reads the SDK's `--tg-theme-*` variables with per-scheme fallbacks (Findings).
    - `useEffect(() => onTelegramEvent('activated', refetchVisible), [refetchVisible])`, beside `visibilitychange`.
    - The "Open FamCal in Telegram" banner shows when `!isInTelegram()`, read in an effect after mount, as `DashboardClient.tsx:95-100` does.
  - **D6, `SendSheet`:** `SEND_ITEMS` in order; a tap runs `await sendToChat(props.user.id, item, props.locale)`, one send at a time.
    - `closing`: keep the spinner (the app is going away).
    - `sent`: reset the spinner, and show "Sent to WhatsApp" for `whatsapp`, or D1's Telegram string for `telegram`.
    - `busy`: "Busy, try again in a minute".
    - `failed`: the generic send failure. D6 may give `status: null` (no answer) its own "no connection" line if D1 has one.

**Findings (read before you start):**
- **The old call and why it isn't reused** (`DashboardClient.tsx:105-137`):
  - it reads `window.Telegram?.WebApp?.initData` and sends it only in the body;
  - it ignores the response;
  - it closes whenever `window.Telegram.WebApp` exists. The SDK defines that object in any browser (`layout.tsx:102-105`, the comment at `DashboardClient.tsx:93-94`), so a WhatsApp user in a browser gets a `close()` that does nothing and a spinner that never resets.

  The split keeps `DashboardClient.tsx` unchanged. `command-client.ts` is a fresh copy of the request, not a refactor.
- **Request shape:**
  - The route reads the header first, then a non-empty string `initData` in the body, and never the query (`execute-command/route.ts:20`, `request-init-data.ts:9-14`). Sending both is the "body fallback". The body copy is left out when initData is empty: the route would ignore `''` anyway.
  - `credentials: 'same-origin'` keeps the WhatsApp session cookie on the request.
  - `language` rides along as before; the route uses `user.language`.
  - The URL is exactly `/api/execute-command`, with no query.
- **`user_id`:** page-data hands the dashboard the URL's own `user_id` (`src/lib/page-data.ts:136`), a telegramId or a DB id. `verifyUserAuth` accepts either for the proved Telegram user, and the DB id for a session (`api-auth.ts:63-81`). `sendToChat` passes `props.user.id` through untouched; it never swaps it for a telegramId or a DB id.
- **Where a 2xx goes:**
  - `resolveCommandTarget` answers on WhatsApp for a session whose user has a WhatsApp chat id, else on Telegram (`command-target.ts:24-33`).
  - Magic links, the only way to get a session, are issued only over WhatsApp: `whatsapp-onboarding.ts:104`, `webhook-handlers.ts:818` and `:946`, `google-connect.ts:308`, and the WhatsApp branch of `telegram/commands.ts:58-60`. So the browser branch's `sent` is `chat: 'whatsapp'`.
  - The route's 200 doesn't name the platform, and changing the route is out of scope.
- **Telegram SDK facts the gating relies on** (telegram-web-app.js):
  - In a plain browser it defines `Telegram.WebApp` with `version` `'6.0'`, and `isVersionAtLeast` is the SDK's own method. So the 6.1 gates already stop every call there. `isInTelegram()` is still the test for "inside Telegram" (the theme's scheme, `command-client`'s branch).
  - BackButton, `setHeaderColor` / `setBackgroundColor` with the key `'bg_color'`, `openLink` and `backButtonClicked`: 6.1.
  - `themeChanged`: 6.0. Vertical swipes: 7.7. `activated`, `deactivated` and the safe-area events: 8.0.
  - Handlers are kept per event without duplicates, and the SDK calls every registered one.
  - `close()` is in every version.
- **PageGate and TelegramLayout:**
  - PageGate's loader sets the purple `#667eea` header and a white background for the dashboard (`PageGate.tsx:64-80`, `LOOK.dashboard` stays `'telegram'`). The home's mount effect replaces them with `bg_color`.
  - Every other page's `TelegramLayout` sets its purple again on mount (`components/Layout/TelegramLayout.tsx:20-28`). So nothing needs restoring when the home unmounts.
  - Re-applying `bg_color` on `themeChanged` is harmless when the SDK already re-resolves the key itself.
- **Look for D6:** the SDK writes the theme params, the viewport and the Bot API 8.0 insets as CSS variables on `<html>`: `--tg-theme-bg-color`, `--tg-theme-section-bg-color`, …, `--tg-viewport-stable-height`, `--tg-safe-area-inset-*`, `--tg-content-safe-area-inset-*`. D6's CSS reads them with fallbacks. This task maps no tokens.
- **Hooks:**
  - `useEffectEvent` hands the BackButton handler the latest `onBack` without registering it again on every render.
  - `useSyncExternalStore` gives the scheme with `'light'` as the server snapshot. That keeps D5's `renderToString` smoke deterministic, and it subscribes to `themeChanged` or the media query only while mounted.
  - Neither hook calls the SDK during a render.
- **Testing hooks without jsdom:** node_modules has no jsdom. `smoke-telegram-ui.ts` runs `react-dom/client` with `React.act` on a fake container, with probe components that render `null`. React needs only this much DOM:
  - `document.createElement()` returning an object with `setAttribute`;
  - a container with `nodeType`, `nodeName`, `tagName`, `namespaceURI` and `ownerDocument`;
  - `window.HTMLIFrameElement` and `document.activeElement`.

  The window object is installed once, before `react-dom` loads. Scenarios change `window.Telegram`, `location.hash` and `matchMedia` on it.
- **`smoke-initdata-header.ts` #8** scans `app/**` (not `app/api`), `components/**` and `src/**`. It flags the text `initData=`, a `URLSearchParams` with an `initData` key, and `.append` / `.set('initData')`. The new files must not contain any of that, comments included.
- **Verified:**
  - **Base:** `feat/calendar-home` after Plan C (verified on 2eb69df, Plan C's reference chain on 716a4f8, and again on 6dab367, the branch and `main` after Plan C, which differs from that chain only in files D doesn't touch), with D1–D3's reference commits. The first pass, with the mutations below, ran on the scratch base, `wt/B-int` at 63e7d4f copied with its node_modules (header, Planning Ruling 9). The results below hold on all three.
  - **Before this task:** `smoke-command-client.ts` is 1/11 (the [guard] passes) and `smoke-telegram-ui.ts` is 1/14 (#1 passes at runtime), both `exit 1` with "Cannot find module". `tsc` shows the 13 errors in Step 3.
  - **After:** 11/11 and 14/14 under `TZ=UTC` and `TZ=Asia/Jerusalem`. `tsc` and lint are clean. `smoke-initdata-header.ts` (9/9) and `smoke-miniapp-gate.ts` (15/15) print the same lines before and after. `Pacific/Kiritimati` was not run: nothing here buckets days.
  - **Mutations caught** in `command-client.ts` (first pass):
    - closing whatever the answer (6 checks fail);
    - the SDK object taken as Telegram (#6, #8);
    - no header (#2, #9);
    - an empty body initData (#6);
    - no busy (#3, #7);
    - no `credentials` (#2, #6).
  - **Mutations caught** in `telegram-ui.ts` (first pass):
    - no hide on mount (#2, #4, #7);
    - no offClick (#3, #4, #5, #7);
    - no version gate (#6, #9, #10, #12);
    - no try/catch (#7, #9, #13);
    - Telegram's scheme in a browser (#10);
    - a stale `onBack` (#3);
    - no protocol check (#13);
    - no re-apply on `themeChanged` (#8);
    - `activated` ungated (#12);
    - both colour calls in one try (#9).
  - **Stand-ins:** none. D4 consumes no other D task's export.
  - **Not verified:** `next build`. Turbopack rejects the scratch copy's symlinked node_modules, so the fresh-clone build before main covers it (the integration builds of D1–D7 passed on both bases). Real Telegram clients are the §10 device check (BackButton after a reload, send closes on a 2xx and stays on a 429).

- [ ] **Step 1: Write the failing smoke `scripts/smoke-command-client.ts`**

Create the file with exactly this content:

```ts
// Smoke test for send to chat on the calendar home (src/lib/command-client.ts, spec §7.2
// and Ruling R5).
//
// The old dashboard's call closes the Mini App whatever the answer (DashboardClient.tsx
// executeCommand: close() in a finally), so a 429 or a 500 vanishes with the app. It
// also closes in a plain browser, since the SDK defines Telegram.WebApp there. sendToChat
// treats a call as Telegram only when readInitData() is non-empty, closes only on a 2xx,
// answers busy on a 429 and failed otherwise, and in a browser stays open with "sent".
// The initData goes in the X-Telegram-Init-Data header, with the body copy as the
// fallback the route also reads.
//
// Faked at the boundaries: fetch (records each call, answers a set status or rejects)
// and the browser window (with and without the Telegram SDK). No network.
//
// The check named [guard] already passes before this task and must keep passing.
//
// Run with the fake env from the task brief (no dotenv):
//   npx tsx scripts/smoke-command-client.ts

import fs from 'fs';
import path from 'path';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

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

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

const show = (value: unknown) => JSON.stringify(value);
const readSource = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const load = (rel: string): Promise<Row> => import(path.join(ROOT, rel));
const client = () => load('src/lib/command-client.ts');

const INIT_DATA = 'query_id=AAE&user=%7B%22id%22%3A5550001%7D&auth_date=1792000000&hash=abc';
const USER_ID = 5550001;

type Sent = { url: string; init: Row; body: Row; headers: Record<string, string> };
type Env = { log: string[]; sent: Sent[]; errors: string[] };

/** A fake Telegram.WebApp; close() is recorded in `log` (and throws when asked to). */
function fakeWebApp(log: string[], initData: string, closeThrows = false): Row {
  return {
    initData,
    initDataUnsafe: {},
    version: initData ? '8.0' : '6.0',
    close: () => {
      log.push('close()');
      if (closeThrows) throw new Error('close: not now');
    },
  };
}

/**
 * Runs fn with a fake window (`webApp` null: no SDK at all) and a fake fetch that answers
 * `answer` (a status) or rejects ('reject'). console.error is collected, not printed.
 */
async function scenario(
  o: { webApp?: (log: string[]) => Row | null; hash?: string; answer: number | 'reject' },
  fn: (env: Env) => Promise<void>
): Promise<void> {
  const g = globalThis as Row;
  const env: Env = { log: [], sent: [], errors: [] };
  const had = 'window' in g;
  const prev = { window: g.window, fetch: g.fetch, error: console.error };
  const webApp = o.webApp ? o.webApp(env.log) : null;
  g.window = {
    location: { hash: o.hash ?? '' },
    sessionStorage: { getItem: () => null, setItem: () => undefined },
    ...(webApp ? { Telegram: { WebApp: webApp } } : {}),
  };
  g.fetch = async (input: unknown, init: Row = {}) => {
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, unknown>).map(([k, v]) => [k.toLowerCase(), String(v)])
    );
    env.sent.push({ url: String(input), init, body: JSON.parse(String(init.body ?? 'null')), headers });
    env.log.push('fetch');
    if (o.answer === 'reject') throw new TypeError('Failed to fetch');
    const noBody = [204, 205, 304].includes(o.answer);
    return new Response(noBody ? null : JSON.stringify({ success: o.answer < 300 }), {
      status: o.answer,
      headers: { 'content-type': 'application/json' },
    });
  };
  console.error = (...args: unknown[]) => {
    env.errors.push(args.map(a => (a instanceof Error ? a.message : String(a))).join(' '));
  };
  try {
    await fn(env);
  } finally {
    console.error = prev.error;
    g.fetch = prev.fetch;
    if (had) g.window = prev.window;
    else delete g.window;
  }
}

const inTelegram = (log: string[]) => fakeWebApp(log, INIT_DATA);
/** The SDK as it runs in a plain browser: Telegram.WebApp exists, with no initData. */
const browserSdk = (log: string[]) => fakeWebApp(log, '');

async function main() {
  await check('#1 the five send items, in the sheet\'s order, run exactly the old dashboard\'s five commands', async () => {
    const { SEND_ITEMS, SEND_COMMANDS } = await client();
    assert(show(SEND_ITEMS) === show(['today', 'tomorrow', 'thisWeek', 'nextWeek', 'weather']), `SEND_ITEMS: ${show(SEND_ITEMS)}`);
    const want = show({
      today: { command: 'summary' },
      tomorrow: { command: 'summary', args: 'tmrw' },
      thisWeek: { command: 'lookahead' },
      nextWeek: { command: 'nextweek' },
      weather: { command: 'weather' },
    });
    assert(show(SEND_COMMANDS) === want, `SEND_COMMANDS: ${show(SEND_COMMANDS)}`);
    const src = readSource('app/[locale]/dashboard/DashboardClient.tsx');
    const old = [...src.matchAll(/executeCommand\('(\w+)'(?:, '(\w+)')?\)/g)].map(m => (m[2] ? `${m[1]} ${m[2]}` : m[1]));
    const now = (SEND_ITEMS as string[]).map(i => {
      const c = SEND_COMMANDS[i];
      return c.args ? `${c.command} ${c.args}` : c.command;
    });
    assert(show([...old].sort()) === show([...now].sort()), `old dashboard ${show(old)}, home ${show(now)}`);
  });

  await check('#2 Telegram, 200 and 202: one POST to /api/execute-command with the initData header and the body copy, then close() once', async () => {
    const { sendToChat } = await client();
    for (const status of [200, 202]) {
      await scenario({ webApp: inTelegram, answer: status }, async env => {
        const result = await sendToChat(USER_ID, 'tomorrow', 'he');
        assert(show(result) === show({ outcome: 'closing' }), `${status}: ${show(result)}`);
        assert(show(env.log) === show(['fetch', 'close()']), `${status}: order ${show(env.log)}`);
        assert(env.sent.length === 1, `${status}: ${env.sent.length} requests`);
        const [req] = env.sent;
        assert(req.url === '/api/execute-command', `url ${req.url}`);
        assert(req.init.method === 'POST' && req.init.credentials === 'same-origin', `init ${show({ method: req.init.method, credentials: req.init.credentials })}`);
        assert(show(req.headers) === show({ 'content-type': 'application/json', 'x-telegram-init-data': INIT_DATA }), `headers ${show(req.headers)}`);
        assert(
          show(req.body) === show({ user_id: USER_ID, command: 'summary', args: 'tmrw', language: 'he', initData: INIT_DATA }),
          `body ${show(req.body)}`
        );
      });
    }
  });

  await check('#3 Telegram, 429: busy (try in a minute), and the app stays open', async () => {
    const { sendToChat } = await client();
    await scenario({ webApp: inTelegram, answer: 429 }, async env => {
      const result = await sendToChat(USER_ID, 'today', 'en');
      assert(show(result) === show({ outcome: 'busy' }), show(result));
      assert(!env.log.includes('close()'), `closed: ${show(env.log)}`);
    });
  });

  await check('#4 Telegram, 400 / 401 / 403 / 404 / 500 / 503: failed with the status, and the app stays open', async () => {
    const { sendToChat } = await client();
    const wrong: string[] = [];
    for (const status of [400, 401, 403, 404, 500, 503]) {
      await scenario({ webApp: inTelegram, answer: status }, async env => {
        const result = await sendToChat(USER_ID, 'weather', 'ru');
        if (show(result) !== show({ outcome: 'failed', status })) wrong.push(`${status}: ${show(result)}`);
        if (env.log.includes('close()')) wrong.push(`${status}: closed`);
      });
    }
    assert(wrong.length === 0, wrong.join('; '));
  });

  await check('#5 Telegram, no answer (fetch rejects): failed with status null, logged, and the app stays open', async () => {
    const { sendToChat } = await client();
    await scenario({ webApp: inTelegram, answer: 'reject' }, async env => {
      const result = await sendToChat(USER_ID, 'thisWeek', 'en');
      assert(show(result) === show({ outcome: 'failed', status: null }), show(result));
      assert(!env.log.includes('close()'), `closed: ${show(env.log)}`);
      assert(env.errors.some(e => e.includes('Failed to fetch')), `logged: ${show(env.errors)}`);
    });
  });

  await check('#6 a browser with the SDK loaded (initData \'\'): no header, no initData in the body, 200 → sent to WhatsApp, and close() is never called', async () => {
    const { sendToChat } = await client();
    await scenario({ webApp: browserSdk, answer: 200 }, async env => {
      const result = await sendToChat(42, 'nextWeek', 'en');
      assert(show(result) === show({ outcome: 'sent', chat: 'whatsapp' }), show(result));
      assert(show(env.log) === show(['fetch']), `calls: ${show(env.log)}`);
      const [req] = env.sent;
      assert(show(req.headers) === show({ 'content-type': 'application/json' }), `headers ${show(req.headers)}`);
      assert(show(req.body) === show({ user_id: 42, command: 'nextweek', language: 'en' }), `body ${show(req.body)}`);
      assert(req.init.credentials === 'same-origin', 'the session cookie would not ride along');
    });
  });

  await check('#7 a browser: 429 → busy, 500 → failed, no answer → failed (null); the page never closes', async () => {
    const { sendToChat } = await client();
    const wrong: string[] = [];
    const cases: [number | 'reject', Row][] = [
      [429, { outcome: 'busy' }],
      [500, { outcome: 'failed', status: 500 }],
      ['reject', { outcome: 'failed', status: null }],
    ];
    for (const [answer, want] of cases) {
      await scenario({ webApp: browserSdk, answer }, async env => {
        const result = await sendToChat(42, 'today', 'he');
        if (show(result) !== show(want)) wrong.push(`${answer}: ${show(result)}`);
        if (env.log.includes('close()')) wrong.push(`${answer}: closed`);
      });
    }
    assert(wrong.length === 0, wrong.join('; '));
  });

  await check('#8 a browser with no SDK at all: 200 → sent to WhatsApp', async () => {
    const { sendToChat } = await client();
    await scenario({ webApp: () => null, answer: 200 }, async env => {
      const result = await sendToChat(42, 'weather', 'en');
      assert(show(result) === show({ outcome: 'sent', chat: 'whatsapp' }), show(result));
      assert(env.sent.length === 1 && !('x-telegram-init-data' in env.sent[0].headers), `headers ${show(env.sent[0]?.headers)}`);
    });
  });

  await check('#9 Telegram with the SDK blocked (initData only in the launch hash): the header from the hash, 200 → sent to the Telegram chat, nothing to close', async () => {
    const { sendToChat } = await client();
    const hash = `#tgWebAppData=${encodeURIComponent(INIT_DATA)}&tgWebAppVersion=8.0`;
    await scenario({ webApp: () => null, hash, answer: 200 }, async env => {
      const result = await sendToChat(USER_ID, 'today', 'he');
      assert(show(result) === show({ outcome: 'sent', chat: 'telegram' }), show(result));
      assert(env.sent[0]?.headers['x-telegram-init-data'] === INIT_DATA, `header ${show(env.sent[0]?.headers)}`);
      assert(env.sent[0]?.body.initData === INIT_DATA, `body ${show(env.sent[0]?.body)}`);
    });
  });

  await check('#10 Telegram, a close() that throws: sent to the Telegram chat, logged, and sendToChat does not throw', async () => {
    const { sendToChat } = await client();
    await scenario({ webApp: log => fakeWebApp(log, INIT_DATA, true), answer: 200 }, async env => {
      const result = await sendToChat(USER_ID, 'today', 'en');
      assert(show(result) === show({ outcome: 'sent', chat: 'telegram' }), show(result));
      assert(show(env.log) === show(['fetch', 'close()']), `calls: ${show(env.log)}`);
      assert(env.errors.some(e => e.includes('close: not now')), `logged: ${show(env.errors)}`);
    });
  });

  await check('#11 [guard] the old dashboard keeps its own executeCommand, which closes in its finally, and does not use command-client', () => {
    const src = readSource('app/[locale]/dashboard/DashboardClient.tsx');
    assert(src.includes('const executeCommand = async (command: string, args?: string) => {'), 'executeCommand is gone');
    assert(src.includes("await fetch('/api/execute-command', {"), 'the old fetch is gone');
    assert(src.includes('window.Telegram.WebApp.close();'), 'the old close is gone');
    assert(!src.includes('command-client'), 'DashboardClient imports command-client');
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

- [ ] **Step 2: Write the failing smoke `scripts/smoke-telegram-ui.ts`**

Create the file with exactly this content:

```ts
// Smoke test for the calendar home's Telegram calls (src/lib/telegram-ui.ts, spec §7.1
// Look and §7.6), and the SDK members they need in src/types/telegram-webapp.d.ts.
//
// - useTelegramBackButton(active, onBack): hide() on mount, since the client keeps the
//   button across reloads; while active, one handler and show(); whenever it stops
//   being needed (inactive, unmount), offClick(that handler) and hide().
// - useTelegramTheme(): setHeaderColor('bg_color') and setBackgroundColor('bg_color') on
//   mount and on every themeChanged; the scheme follows Telegram's colorScheme inside
//   Telegram and prefers-color-scheme in a browser.
// - onTelegramEvent and openExternalLink, for the home's foreground refetch and
//   "Open in Google Calendar".
// Every SDK call is gated with isVersionAtLeast and wrapped in try/catch: a 6.0 client,
// a browser (the SDK defines Telegram.WebApp there too, at 6.0) or a throwing method
// never breaks the page.
//
// The hooks run in real React (react-dom/client with act), mounted into a fake container
// that renders nothing. Faked at the boundaries: the browser window (just enough DOM for
// React to mount a component that renders null) and the Telegram SDK (records every
// call, keeps event handlers as the SDK does). No network.
//
// Check #1 is compile-time: tsc fails on it until the d.ts additions land.
//
// Run with the fake env from the task brief (no dotenv):
//   npx tsx scripts/smoke-telegram-ui.ts

import path from 'path';
import { createRequire } from 'module';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const ROOT = path.resolve(__dirname, '..');
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

const show = (value: unknown) => JSON.stringify(value);
const load = (rel: string): Promise<Row> => import(path.join(ROOT, rel));
const ui = () => load('src/lib/telegram-ui.ts');

const INIT_DATA = 'query_id=AAE&user=%7B%22id%22%3A5550001%7D&auth_date=1792000000&hash=abc';

// ---- Compile-time: the SDK members the home uses are typed (spec §7.6) ----

function typedMembers(tg: TelegramWebApp): unknown[] {
  const event: TelegramWebAppEventType = 'activated';
  const inset: TelegramWebAppSafeAreaInset = tg.safeAreaInset;
  return [
    tg.isVersionAtLeast('8.0'),
    tg.disableVerticalSwipes,
    tg.enableVerticalSwipes,
    tg.onEvent,
    tg.offEvent,
    event,
    inset.top + inset.bottom + inset.left + inset.right,
    tg.contentSafeAreaInset.top,
    tg.themeParams.section_bg_color,
    tg.themeParams.section_header_text_color,
    tg.themeParams.section_separator_color,
    tg.themeParams.subtitle_text_color,
    tg.BackButton.offClick,
    tg.openLink,
  ];
}

// ---- The fake window: one object for the whole run (react-dom reads it when loaded) ----

const g = globalThis as Row;
const noop = () => undefined;
const fakeDocument: Row = {
  nodeType: 9,
  activeElement: null,
  documentElement: {},
  addEventListener: noop,
  removeEventListener: noop,
  createElement: () => ({ setAttribute: noop, style: {} }),
};
const fakeWindow: Row = {
  document: fakeDocument,
  HTMLIFrameElement: class {},
  addEventListener: noop,
  removeEventListener: noop,
  location: { hash: '' },
  sessionStorage: { getItem: () => null, setItem: noop },
};
fakeDocument.defaultView = fakeWindow;
g.window = fakeWindow;
g.document = fakeDocument;
g.IS_REACT_ACT_ENVIRONMENT = true;

const React = nodeRequire('react');
const { createRoot } = nodeRequire('react-dom/client');
const { renderToString } = nodeRequire('react-dom/server');

/** A React root in a container that never gets a DOM node (the probes render null). */
function mount(element: unknown) {
  const container: Row = {
    nodeType: 1,
    nodeName: 'DIV',
    tagName: 'DIV',
    namespaceURI: 'http://www.w3.org/1999/xhtml',
    ownerDocument: fakeDocument,
    firstChild: null,
    childNodes: [],
    textContent: '',
    addEventListener: noop,
    removeEventListener: noop,
    removeChild: noop,
  };
  const root = createRoot(container);
  React.act(() => root.render(element));
  return {
    render: (next: unknown) => React.act(() => root.render(next)),
    unmount: () => React.act(() => root.unmount()),
  };
}

const act = (fn: () => void) => React.act(fn);

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
    if (typeof a !== 'function') return String(a);
    if (!ids.has(a)) ids.set(a, `fn${ids.size + 1}`);
    return ids.get(a) as string;
  };
  const on = (type: string, h: () => void) => {
    if (!handlers.has(type)) handlers.set(type, new Set());
    handlers.get(type)?.add(h);
  };
  const off = (type: string, h: () => void) => handlers.get(type)?.delete(h);
  const rec = (name: string, effect?: (...args: Row[]) => void) => (...args: Row[]) => {
    calls.push(`${name}(${args.map(label).join(',')})`);
    if (o.throwOn?.includes(name)) throw new Error(`${name} threw`);
    effect?.(...args);
  };
  const webApp: Row = {
    initData: o.initData ?? INIT_DATA,
    initDataUnsafe: {},
    version: o.version,
    colorScheme: o.colorScheme ?? 'light',
    isVersionAtLeast: (v: string) => versionAtLeast(o.version, v),
    setHeaderColor: rec('setHeaderColor'),
    setBackgroundColor: rec('setBackgroundColor'),
    onEvent: rec('onEvent', (type, h) => on(String(type), h as unknown as () => void)),
    offEvent: rec('offEvent', (type, h) => off(String(type), h as unknown as () => void)),
    openLink: rec('openLink'),
    BackButton: {
      isVisible: false,
      onClick: rec('BackButton.onClick', h => on('backButtonClicked', h as unknown as () => void)),
      offClick: rec('BackButton.offClick', h => off('backButtonClicked', h as unknown as () => void)),
      show: rec('BackButton.show', () => { webApp.BackButton.isVisible = true; }),
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

/** A fake prefers-color-scheme query whose `matches` can change, with its listeners. */
function fakeMatchMedia(dark: boolean) {
  const listeners = new Set<() => void>();
  const query: Row = {
    matches: dark,
    addEventListener: (_t: string, l: () => void) => listeners.add(l),
    removeEventListener: (_t: string, l: () => void) => listeners.delete(l),
  };
  return {
    matchMedia: (q: string) => {
      assert(q === '(prefers-color-scheme: dark)', `matchMedia(${q})`);
      return query;
    },
    set: (next: boolean) => {
      query.matches = next;
      listeners.forEach(l => l());
    },
    count: () => listeners.size,
  };
}

/** Runs fn with this Telegram SDK (null: none), launch hash and matchMedia; console.warn collected. */
async function withEnv(
  o: { webApp?: Row | null; hash?: string; matchMedia?: (q: string) => Row },
  fn: (warnings: string[]) => void | Promise<void>
) {
  const warnings: string[] = [];
  const prevWarn = console.warn;
  if (o.webApp) fakeWindow.Telegram = { WebApp: o.webApp };
  else delete fakeWindow.Telegram;
  fakeWindow.location = { hash: o.hash ?? '' };
  if (o.matchMedia) fakeWindow.matchMedia = o.matchMedia;
  else delete fakeWindow.matchMedia;
  delete fakeWindow.open;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(a => (a instanceof Error ? a.message : String(a))).join(' '));
  };
  try {
    await fn(warnings);
  } finally {
    console.warn = prevWarn;
    delete fakeWindow.Telegram;
    delete fakeWindow.matchMedia;
    delete fakeWindow.open;
    fakeWindow.location = { hash: '' };
  }
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
    return null;
  }

  await check('#1 [types] isVersionAtLeast, vertical swipes, onEvent/offEvent, the safe-area insets and the section colours are typed', () => {
    const typed = typedMembers({
      isVersionAtLeast: () => true,
      safeAreaInset: { top: 0, bottom: 0, left: 0, right: 0 },
      contentSafeAreaInset: { top: 0, bottom: 0, left: 0, right: 0 },
      themeParams: {},
      BackButton: {},
    } as unknown as TelegramWebApp);
    assert(typed.length === 14, `${typed.length} members`);
  });

  await check('#2 BackButton (8.0 client): mounted inactive it only hides; active, one handler and show(); a tap calls onBack', async () => {
    await ui();
    const tg = fakeTelegram({ version: '8.0' });
    await withEnv({ webApp: tg.webApp }, () => {
      const taps: string[] = [];
      const view = mount(back(false, () => taps.push('a')));
      assert(show(tg.calls) === show(['BackButton.hide()']), `mounted inactive: ${show(tg.calls)}`);
      view.render(back(true, () => taps.push('a')));
      assert(show(tg.calls.slice(1)) === show(['BackButton.onClick(fn1)', 'BackButton.show()']), `active: ${show(tg.calls)}`);
      assert(tg.webApp.BackButton.isVisible && tg.count('backButtonClicked') === 1, `visible ${tg.webApp.BackButton.isVisible}, ${tg.count('backButtonClicked')} handlers`);
      act(() => tg.fire('backButtonClicked'));
      assert(show(taps) === show(['a']), `taps ${show(taps)}`);
      view.unmount();
    });
  });

  await check('#3 BackButton: a new onBack on re-render is used without re-registering; inactive → offClick(that handler), hide(), and a tap reaches nobody', async () => {
    await ui();
    const tg = fakeTelegram({ version: '7.10' });
    await withEnv({ webApp: tg.webApp }, () => {
      const taps: string[] = [];
      const view = mount(back(true, () => taps.push('first')));
      const before = tg.calls.length;
      view.render(back(true, () => taps.push('second')));
      assert(tg.calls.length === before, `re-render called ${show(tg.calls.slice(before))}`);
      act(() => tg.fire('backButtonClicked'));
      assert(show(taps) === show(['second']), `taps ${show(taps)}`);
      view.render(back(false, () => taps.push('third')));
      assert(show(tg.calls.slice(before)) === show(['BackButton.offClick(fn1)', 'BackButton.hide()']), `inactive: ${show(tg.calls)}`);
      assert(!tg.webApp.BackButton.isVisible && tg.count('backButtonClicked') === 0, 'still shown or still registered');
      act(() => tg.fire('backButtonClicked'));
      assert(show(taps) === show(['second']), `taps after: ${show(taps)}`);
      view.unmount();
    });
  });

  await check('#4 BackButton: mounted active → hide() first, then onClick + show(); unmount → offClick + hide()', async () => {
    await ui();
    const tg = fakeTelegram({ version: '6.1' });
    await withEnv({ webApp: tg.webApp }, () => {
      const view = mount(back(true, noop));
      assert(show(tg.calls) === show(['BackButton.hide()', 'BackButton.onClick(fn1)', 'BackButton.show()']), `mount: ${show(tg.calls)}`);
      view.unmount();
      assert(show(tg.calls.slice(3)) === show(['BackButton.offClick(fn1)', 'BackButton.hide()']), `unmount: ${show(tg.calls)}`);
      assert(!tg.webApp.BackButton.isVisible && tg.count('backButtonClicked') === 0, 'left shown or registered');
    });
  });

  await check('#5 BackButton under StrictMode (effects run twice): shown with exactly one handler; unmount leaves none', async () => {
    await ui();
    const tg = fakeTelegram({ version: '8.0' });
    await withEnv({ webApp: tg.webApp }, () => {
      const taps: string[] = [];
      const view = mount(React.createElement(React.StrictMode, null, back(true, () => taps.push('x'))));
      assert(tg.webApp.BackButton.isVisible && tg.count('backButtonClicked') === 1, `visible ${tg.webApp.BackButton.isVisible}, ${tg.count('backButtonClicked')} handlers: ${show(tg.calls)}`);
      act(() => tg.fire('backButtonClicked'));
      assert(show(taps) === show(['x']), `taps ${show(taps)}`);
      view.unmount();
      assert(!tg.webApp.BackButton.isVisible && tg.count('backButtonClicked') === 0, 'left shown or registered');
    });
  });

  await check('#6 BackButton on a 6.0 client and in a browser (SDK at 6.0, no initData): no SDK call at all; with no SDK nothing throws', async () => {
    await ui();
    for (const tg of [fakeTelegram({ version: '6.0' }), fakeTelegram({ version: '6.0', initData: '' })]) {
      await withEnv({ webApp: tg.webApp }, () => {
        const view = mount(back(false, noop));
        view.render(back(true, noop));
        view.render(back(false, noop));
        view.unmount();
        assert(tg.calls.length === 0, `${tg.webApp.initData ? '6.0 client' : 'browser'}: ${show(tg.calls)}`);
      });
    }
    await withEnv({ webApp: null }, () => {
      const view = mount(back(true, noop));
      view.render(back(false, noop));
      view.unmount();
    });
  });

  await check('#7 BackButton: a hide() that throws on mount still lets it show later; an offClick that throws still hides; both logged', async () => {
    await ui();
    const hides = fakeTelegram({ version: '8.0', throwOn: ['BackButton.hide'] });
    await withEnv({ webApp: hides.webApp }, warnings => {
      const view = mount(back(false, noop));
      view.render(back(true, noop));
      assert(hides.webApp.BackButton.isVisible, `not shown: ${show(hides.calls)}`);
      assert(warnings.some(w => w.includes('BackButton.hide threw')), `warnings ${show(warnings)}`);
      view.unmount();
    });
    const offs = fakeTelegram({ version: '8.0', throwOn: ['BackButton.offClick'] });
    await withEnv({ webApp: offs.webApp }, warnings => {
      const view = mount(back(true, noop));
      view.render(back(false, noop));
      assert(!offs.webApp.BackButton.isVisible, `still shown: ${show(offs.calls)}`);
      assert(warnings.some(w => w.includes('BackButton.offClick threw')), `warnings ${show(warnings)}`);
      view.unmount();
    });
  });

  await check('#8 theme (8.0 client): setHeaderColor(bg_color) and setBackgroundColor(bg_color) on mount; Telegram\'s colorScheme; themeChanged re-applies and re-renders; unmount unsubscribes', async () => {
    await ui();
    const tg = fakeTelegram({ version: '8.0', colorScheme: 'dark' });
    await withEnv({ webApp: tg.webApp }, () => {
      const seen: string[] = [];
      const view = mount(React.createElement(ThemeProbe, { seen }));
      const colours = () => tg.calls.filter(c => c.startsWith('set'));
      assert(show(colours()) === show(['setHeaderColor(bg_color)', 'setBackgroundColor(bg_color)']), `mount: ${show(tg.calls)}`);
      assert(seen[seen.length - 1] === 'dark', `scheme ${show(seen)}`);
      assert(tg.count('themeChanged') === 2, `${tg.count('themeChanged')} themeChanged handlers (colours + scheme)`);
      tg.webApp.colorScheme = 'light';
      act(() => tg.fire('themeChanged'));
      assert(seen[seen.length - 1] === 'light', `after themeChanged: ${show(seen)}`);
      assert(colours().length === 4, `colours after themeChanged: ${show(colours())}`);
      view.unmount();
      assert(tg.count('themeChanged') === 0, `${tg.count('themeChanged')} handlers left`);
    });
  });

  await check('#9 theme on a 6.0 client: no colour call (the scheme still follows colorScheme); a setHeaderColor that throws still lets setBackgroundColor run', async () => {
    await ui();
    const old = fakeTelegram({ version: '6.0', colorScheme: 'dark' });
    await withEnv({ webApp: old.webApp }, () => {
      const seen: string[] = [];
      const view = mount(React.createElement(ThemeProbe, { seen }));
      assert(!old.calls.some(c => c.startsWith('set')), `6.0: ${show(old.calls)}`);
      assert(seen[seen.length - 1] === 'dark', `6.0 scheme ${show(seen)}`);
      view.unmount();
    });
    const throws = fakeTelegram({ version: '6.1', throwOn: ['setHeaderColor'] });
    await withEnv({ webApp: throws.webApp }, warnings => {
      const view = mount(React.createElement(ThemeProbe, { seen: [] }));
      assert(throws.calls.includes('setBackgroundColor(bg_color)'), `after a throw: ${show(throws.calls)}`);
      assert(warnings.some(w => w.includes('setHeaderColor threw')), `warnings ${show(warnings)}`);
      view.unmount();
    });
  });

  await check('#10 theme in a browser (SDK at 6.0, no initData): prefers-color-scheme and its changes, never Telegram\'s colorScheme; unmount removes the listener', async () => {
    await ui();
    const tg = fakeTelegram({ version: '6.0', initData: '', colorScheme: 'dark' });
    const media = fakeMatchMedia(false);
    await withEnv({ webApp: tg.webApp, matchMedia: media.matchMedia }, () => {
      const seen: string[] = [];
      const view = mount(React.createElement(ThemeProbe, { seen }));
      assert(seen[seen.length - 1] === 'light', `browser light: ${show(seen)}`);
      assert(media.count() === 1, `${media.count()} media listeners`);
      act(() => media.set(true));
      assert(seen[seen.length - 1] === 'dark', `browser dark: ${show(seen)}`);
      view.unmount();
      assert(media.count() === 0, `${media.count()} media listeners left`);
      assert(!tg.calls.some(c => c.startsWith('set')), `colour calls in a browser: ${show(tg.calls)}`);
    });
    await withEnv({ webApp: null }, () => {
      const seen: string[] = [];
      const view = mount(React.createElement(ThemeProbe, { seen }));
      assert(seen[seen.length - 1] === 'light', `no SDK, no matchMedia: ${show(seen)}`);
      view.unmount();
    });
  });

  await check('#11 server render: the theme is light and neither hook calls the SDK while rendering', async () => {
    await ui();
    const tg = fakeTelegram({ version: '8.0', colorScheme: 'dark' });
    await withEnv({ webApp: tg.webApp }, () => {
      const seen: string[] = [];
      renderToString(React.createElement(React.Fragment, null, React.createElement(ThemeProbe, { seen }), back(true, noop)));
      assert(show(seen) === show(['light']), `server scheme ${show(seen)}`);
      assert(tg.calls.length === 0, `calls during a server render: ${show(tg.calls)}`);
    });
  });

  await check('#12 onTelegramEvent: activated needs Bot API 8.0 (7.10: no subscription, a no-op unsubscribe); on 8.0 the same handler on and off', async () => {
    const { onTelegramEvent } = await ui();
    const old = fakeTelegram({ version: '7.10' });
    await withEnv({ webApp: old.webApp }, () => {
      const off = onTelegramEvent('activated', noop);
      off();
      assert(old.calls.length === 0, `7.10: ${show(old.calls)}`);
    });
    const tg = fakeTelegram({ version: '8.0' });
    await withEnv({ webApp: tg.webApp }, () => {
      let hits = 0;
      const off = onTelegramEvent('activated', () => { hits++; });
      tg.fire('activated');
      off();
      tg.fire('activated');
      assert(show(tg.calls) === show(['onEvent(activated,fn1)', 'offEvent(activated,fn1)']), `8.0: ${show(tg.calls)}`);
      assert(hits === 1, `${hits} hits`);
    });
  });

  await check('#13 openExternalLink: Telegram → openLink; a browser → a new tab; javascript: and relative links refused; a throwing openLink falls back to a tab', async () => {
    const { openExternalLink } = await ui();
    const link = 'https://www.google.com/calendar/event?eid=abc123';
    const tg = fakeTelegram({ version: '8.0' });
    await withEnv({ webApp: tg.webApp }, () => {
      const opened: string[] = [];
      fakeWindow.open = (...a: unknown[]) => { opened.push(a.join(' ')); return null; };
      assert(openExternalLink(link) === true, 'not opened');
      assert(show(tg.calls) === show([`openLink(${link})`]) && opened.length === 0, `telegram: ${show(tg.calls)} ${show(opened)}`);
      assert(openExternalLink('javascript:alert(1)') === false && openExternalLink('/en/settings') === false, 'a bad link was accepted');
      assert(tg.calls.length === 1 && opened.length === 0, `bad links opened: ${show(tg.calls)} ${show(opened)}`);
    });
    const browser = fakeTelegram({ version: '6.0', initData: '' });
    await withEnv({ webApp: browser.webApp }, () => {
      const opened: string[] = [];
      fakeWindow.open = (...a: unknown[]) => { opened.push(a.join(' ')); return null; };
      assert(openExternalLink(link) === true, 'not opened');
      assert(show(opened) === show([`${link} _blank noopener,noreferrer`]) && browser.calls.length === 0, `browser: ${show(opened)} ${show(browser.calls)}`);
    });
    const throws = fakeTelegram({ version: '8.0', throwOn: ['openLink'] });
    await withEnv({ webApp: throws.webApp }, () => {
      const opened: string[] = [];
      fakeWindow.open = (...a: unknown[]) => { opened.push(a.join(' ')); return null; };
      assert(openExternalLink(link) === true && opened.length === 1, `after a throw: ${show(opened)}`);
    });
  });

  await check('#14 isInTelegram: the SDK alone is not Telegram; initData from the SDK or the launch hash is', async () => {
    const { isInTelegram } = await ui();
    const got: Row = {};
    await withEnv({ webApp: fakeTelegram({ version: '6.0', initData: '' }).webApp }, () => { got.browserSdk = isInTelegram(); });
    await withEnv({ webApp: null }, () => { got.noSdk = isInTelegram(); });
    await withEnv({ webApp: fakeTelegram({ version: '8.0' }).webApp }, () => { got.sdk = isInTelegram(); });
    await withEnv({ webApp: null, hash: `#tgWebAppData=${encodeURIComponent(INIT_DATA)}` }, () => { got.hash = isInTelegram(); });
    assert(show(got) === show({ browserSdk: false, noSdk: false, sdk: true, hash: true }), show(got));
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

- [ ] **Step 3: Run both smokes and the type-check and see them fail; record the regression smokes' baseline**

```bash
cd /Users/razielgershoni/development/famcalbot
for f in smoke-command-client smoke-telegram-ui; do for tz in UTC Asia/Jerusalem; do TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/$f.ts 2>&1 | grep -E '^OK|passed'; echo "$f $tz exit=${pipestatus[1]}"; done; done
npx tsc --noEmit -p .; echo "tsc exit $?"
for f in smoke-initdata-header smoke-miniapp-gate; do for tz in UTC Asia/Jerusalem; do TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/$f.ts 2>&1 | grep -E '^(OK|FAIL)|passed' > /tmp/d4-$f-${tz//\//_}.before; echo "$f $tz exit=${pipestatus[1]} | $(tail -1 /tmp/d4-$f-${tz//\//_}.before)"; done; done
```
(Run it in zsh: `pipestatus` is zsh's; in bash it is `${PIPESTATUS[0]}`.)

Expected for the two new smokes, under each clock: only the check that needs no new module passes, and every other check is a FAIL line ending in "Cannot find module '/Users/razielgershoni/development/famcalbot/src/lib/command-client.ts' imported from …" (or `telegram-ui.ts`):
```
OK  #11 [guard] the old dashboard keeps its own executeCommand, which closes in its finally, and does not use command-client
1/11 passed (process TZ=UTC)
smoke-command-client UTC exit=1
```
```
OK  #1 [types] isVersionAtLeast, vertical swipes, onEvent/offEvent, the safe-area insets and the section colours are typed
1/14 passed (process TZ=UTC)
smoke-telegram-ui UTC exit=1
```
Then the same with `(process TZ=Asia/Jerusalem)`.

Expected from `tsc` (check #1's teeth: the SDK members aren't typed yet):
```
scripts/smoke-telegram-ui.ts(60,16): error TS2304: Cannot find name 'TelegramWebAppEventType'.
scripts/smoke-telegram-ui.ts(61,16): error TS2304: Cannot find name 'TelegramWebAppSafeAreaInset'.
scripts/smoke-telegram-ui.ts(61,49): error TS2339: Property 'safeAreaInset' does not exist on type 'TelegramWebApp'.
scripts/smoke-telegram-ui.ts(63,8): error TS2339: Property 'isVersionAtLeast' does not exist on type 'TelegramWebApp'.
scripts/smoke-telegram-ui.ts(64,8): error TS2339: Property 'disableVerticalSwipes' does not exist on type 'TelegramWebApp'.
scripts/smoke-telegram-ui.ts(65,8): error TS2339: Property 'enableVerticalSwipes' does not exist on type 'TelegramWebApp'.
scripts/smoke-telegram-ui.ts(66,8): error TS2339: Property 'onEvent' does not exist on type 'TelegramWebApp'.
scripts/smoke-telegram-ui.ts(67,8): error TS2339: Property 'offEvent' does not exist on type 'TelegramWebApp'.
scripts/smoke-telegram-ui.ts(70,8): error TS2339: Property 'contentSafeAreaInset' does not exist on type 'TelegramWebApp'.
scripts/smoke-telegram-ui.ts(71,20): error TS2551: Property 'section_bg_color' does not exist on type '{ bg_color?: string | undefined; text_color?: string | undefined; hint_color?: string | undefined; link_color?: string | undefined; button_color?: string | undefined; button_text_color?: string | undefined; secondary_bg_color?: string | undefined; }'. Did you mean 'secondary_bg_color'?
scripts/smoke-telegram-ui.ts(72,20): error TS2339: Property 'section_header_text_color' does not exist on type '{ bg_color?: string | undefined; text_color?: string | undefined; hint_color?: string | undefined; link_color?: string | undefined; button_color?: string | undefined; button_text_color?: string | undefined; secondary_bg_color?: string | undefined; }'.
scripts/smoke-telegram-ui.ts(73,20): error TS2339: Property 'section_separator_color' does not exist on type '{ bg_color?: string | undefined; text_color?: string | undefined; hint_color?: string | undefined; link_color?: string | undefined; button_color?: string | undefined; button_text_color?: string | undefined; secondary_bg_color?: string | undefined; }'.
scripts/smoke-telegram-ui.ts(74,20): error TS2339: Property 'subtitle_text_color' does not exist on type '{ bg_color?: string | undefined; text_color?: string | undefined; hint_color?: string | undefined; link_color?: string | undefined; button_color?: string | undefined; button_text_color?: string | undefined; secondary_bg_color?: string | undefined; }'.
tsc exit 2
```
Why they fail: neither module exists yet, and the d.ts lacks the §7.6 members. The smokes load their modules inside each check, so every check reports on its own.

Expected for the regression smokes: every run `exit=0`. On the real base with D1–D3 in (none of them touches these two smokes), the last lines are `9/9 passed` (`smoke-initdata-header`) and `15/15 passed` (`smoke-miniapp-gate`). The `/tmp/d4-*.before` files are the baseline for Step 7.

- [ ] **Step 4: Add the §7.6 members to `src/types/telegram-webapp.d.ts`**

Make two edits. Each quoted text appears exactly once in the file.

Edit 4a, lines 34-51. Replace:

```ts
interface TelegramWebApp {
  initDataUnsafe: TelegramWebAppInitData;
  initData: string;
  version: string;
  platform: string;
  colorScheme: 'light' | 'dark';
  themeParams: {
    bg_color?: string;
    text_color?: string;
    hint_color?: string;
    link_color?: string;
    button_color?: string;
    button_text_color?: string;
    secondary_bg_color?: string;
  };
  isExpanded: boolean;
  viewportHeight: number;
  viewportStableHeight: number;
```

with:

```ts
/** Mini App events (activated, deactivated and the two safe-area events need Bot API 8.0). */
type TelegramWebAppEventType =
  | 'themeChanged'
  | 'viewportChanged'
  | 'backButtonClicked'
  | 'mainButtonClicked'
  | 'settingsButtonClicked'
  | 'popupClosed'
  | 'invoiceClosed'
  | 'activated'
  | 'deactivated'
  | 'safeAreaChanged'
  | 'contentSafeAreaChanged';

/** Insets in px (Bot API 8.0); the SDK also sets them as --tg-safe-area-inset-* and --tg-content-safe-area-inset-*. */
interface TelegramWebAppSafeAreaInset {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

interface TelegramWebApp {
  initDataUnsafe: TelegramWebAppInitData;
  initData: string;
  version: string;
  platform: string;
  colorScheme: 'light' | 'dark';
  /** The colours newer clients add (header, accent, section, subtitle, destructive) may be missing on older ones. */
  themeParams: {
    bg_color?: string;
    text_color?: string;
    hint_color?: string;
    link_color?: string;
    button_color?: string;
    button_text_color?: string;
    secondary_bg_color?: string;
    header_bg_color?: string;
    accent_text_color?: string;
    section_bg_color?: string;
    section_header_text_color?: string;
    section_separator_color?: string;
    subtitle_text_color?: string;
    destructive_text_color?: string;
  };
  isExpanded: boolean;
  viewportHeight: number;
  viewportStableHeight: number;
  safeAreaInset: TelegramWebAppSafeAreaInset;
  contentSafeAreaInset: TelegramWebAppSafeAreaInset;
```

Edit 4b, lines 60-61. Replace:

```ts
  enableClosingConfirmation: () => void;
  disableClosingConfirmation: () => void;
```

with:

```ts
  enableClosingConfirmation: () => void;
  disableClosingConfirmation: () => void;
  /** Whether the client supports Bot API `version`. The SDK reports 6.0 in a plain browser. */
  isVersionAtLeast: (version: string) => boolean;
  /** Bot API 7.7+. Never read isVerticalSwipesEnabled: it is wrong after a reload. */
  enableVerticalSwipes: () => void;
  disableVerticalSwipes: () => void;
  onEvent: (eventType: TelegramWebAppEventType, eventHandler: (...args: never[]) => void) => void;
  offEvent: (eventType: TelegramWebAppEventType, eventHandler: (...args: never[]) => void) => void;
```

Nothing else in the file changes. `BackButton` (`:105-111`) and `openLink` (`:62`) are already typed.

- [ ] **Step 5: Create `src/lib/telegram-ui.ts`**

Create the file with exactly this content:

```ts
/**
 * The Telegram Mini App calls the calendar home makes (spec §7.1 Look, §7.6). Every SDK
 * call is gated with isVersionAtLeast and wrapped in try/catch, so a 6.0 client, a plain
 * browser (the SDK defines Telegram.WebApp there too, at version 6.0) or a method that
 * throws never breaks the page; in a browser the in-page buttons do the same jobs.
 *
 * Client components only. Nothing here touches window at import, and while rendering on
 * the server the hooks make no call (the theme is 'light').
 */

import { useEffect, useEffectEvent, useSyncExternalStore } from 'react';
import { readInitData } from './read-init-data';

/** The Bot API version each call needs. */
const BACK_BUTTON = '6.1';
const COLOURS = '6.1';
const OPEN_LINK = '6.1';

/** Events newer than the first SDK (6.0). */
const EVENT_VERSION: Partial<Record<TelegramWebAppEventType, string>> = {
  backButtonClicked: '6.1',
  activated: '8.0',
  deactivated: '8.0',
  safeAreaChanged: '8.0',
  contentSafeAreaChanged: '8.0',
};

/** The SDK object once telegram-web-app.js has run, else null (server, script blocked). */
export function telegramWebApp(): TelegramWebApp | null {
  if (typeof window === 'undefined') return null;
  return window.Telegram?.WebApp ?? null;
}

/** Inside Telegram: the launch carried signed initData. The SDK object alone proves nothing. */
export function isInTelegram(): boolean {
  return readInitData() !== '';
}

/** Whether this client supports Bot API `version`. False with no SDK, or when the check throws. */
export function telegramSupports(version: string): boolean {
  const tg = telegramWebApp();
  if (!tg || typeof tg.isVersionAtLeast !== 'function') return false;
  try {
    return tg.isVersionAtLeast(version) === true;
  } catch {
    return false;
  }
}

/** Runs `call` when the client supports `version`. A throw is logged, never raised. True when it ran. */
function tgCall(version: string, what: string, call: (tg: TelegramWebApp) => void): boolean {
  const tg = telegramWebApp();
  if (!tg || !telegramSupports(version)) return false;
  try {
    call(tg);
    return true;
  } catch (err) {
    console.warn(`[telegram-ui] ${what} failed:`, err);
    return false;
  }
}

/**
 * Subscribes `handler` to a Telegram event when the client has that event (activated and
 * deactivated need Bot API 8.0). Returns the unsubscribe, a no-op when nothing subscribed.
 */
export function onTelegramEvent(event: TelegramWebAppEventType, handler: () => void): () => void {
  const version = EVENT_VERSION[event] ?? '6.0';
  if (!tgCall(version, `onEvent(${event})`, (tg) => tg.onEvent(event, handler))) return () => {};
  return () => {
    tgCall(version, `offEvent(${event})`, (tg) => tg.offEvent(event, handler));
  };
}

/**
 * Telegram's BackButton (Bot API 6.1+) while `active`; a tap calls the latest `onBack`.
 * - On mount it hides the button: the client keeps it across reloads.
 * - While active: one handler (onClick), then show().
 * - Whenever it stops being needed (`active` turns false, or unmount): offClick(that
 *   handler), then hide(), each on its own so a throw in one still runs the other.
 * The SDK calls every registered handler and any hide() hides the one button, so one
 * component owns it: the home's single call decides what a tap does.
 */
export function useTelegramBackButton(active: boolean, onBack: () => void): void {
  const back = useEffectEvent(onBack);

  useEffect(() => {
    tgCall(BACK_BUTTON, 'BackButton.hide', (tg) => tg.BackButton.hide());
  }, []);

  useEffect(() => {
    if (!active) return;
    const handler = () => back();
    tgCall(BACK_BUTTON, 'BackButton.show', (tg) => {
      tg.BackButton.onClick(handler);
      tg.BackButton.show();
    });
    return () => {
      tgCall(BACK_BUTTON, 'BackButton.offClick', (tg) => tg.BackButton.offClick(handler));
      tgCall(BACK_BUTTON, 'BackButton.hide', (tg) => tg.BackButton.hide());
    };
  }, [active]);
}

export type ColorScheme = 'light' | 'dark';

const DARK_QUERY = '(prefers-color-scheme: dark)';

/** Telegram's colorScheme inside Telegram, else prefers-color-scheme. */
function colorSchemeNow(): ColorScheme {
  const tg = telegramWebApp();
  if (tg && isInTelegram()) return tg.colorScheme === 'dark' ? 'dark' : 'light';
  try {
    return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

function subscribeColorScheme(onChange: () => void): () => void {
  if (telegramWebApp() && isInTelegram()) return onTelegramEvent('themeChanged', onChange);
  try {
    const query = window.matchMedia(DARK_QUERY);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  } catch {
    return () => {};
  }
}

const serverColorScheme = (): ColorScheme => 'light';

/** Telegram's header and the area behind the page in the theme's bg_color (6.1+), each call on its own. */
export function applyTelegramColours(): void {
  tgCall(COLOURS, "setHeaderColor('bg_color')", (tg) => tg.setHeaderColor('bg_color'));
  tgCall(COLOURS, "setBackgroundColor('bg_color')", (tg) => tg.setBackgroundColor('bg_color'));
}

/**
 * The home's look (spec §7.1). On mount, and again on every themeChanged, Telegram's
 * header and background take the theme's bg_color (PageGate's loader set the purple
 * ones). Returns the scheme to render: Telegram's colorScheme, following themeChanged,
 * inside Telegram; prefers-color-scheme in a browser; 'light' on the server.
 */
export function useTelegramTheme(): ColorScheme {
  useEffect(() => {
    applyTelegramColours();
    return onTelegramEvent('themeChanged', applyTelegramColours);
  }, []);
  return useSyncExternalStore(subscribeColorScheme, colorSchemeNow, serverColorScheme);
}

/**
 * Opens an http(s) link outside the Mini App (an event in Google Calendar): Telegram's
 * openLink on a 6.1+ client, else a new tab (a browser's SDK reports 6.0). Any other
 * link is refused. Returns whether it opened something.
 */
export function openExternalLink(url: string): boolean {
  let href: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    href = parsed.href;
  } catch {
    return false;
  }
  if (tgCall(OPEN_LINK, 'openLink', (tg) => tg.openLink(href))) return true;
  try {
    window.open(href, '_blank', 'noopener,noreferrer');
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 6: Create `src/lib/command-client.ts`**

Create the file with exactly this content:

```ts
/**
 * Send to chat from the calendar home (spec §7.2, Ruling R5): POST /api/execute-command,
 * and the bot posts the answer in the user's chat. The old dashboard keeps its own call
 * (DashboardClient.tsx executeCommand), unchanged.
 *
 * - The call is a Telegram one only when readInitData() is non-empty: the SDK defines
 *   Telegram.WebApp in any browser. The initData goes in the X-Telegram-Init-Data header,
 *   and in the JSON body as the fallback the route also reads.
 * - Inside Telegram the app closes only on a 2xx. Any other answer, or none, keeps it
 *   open, and the caller says why (429: try again in a minute).
 * - In a browser (the WhatsApp magic-link session cookie) the page always stays. A 2xx
 *   there means the answer went to WhatsApp, where every magic link comes from.
 *
 * No imports beyond read-init-data, so it stays a small client module.
 */

import { INIT_DATA_HEADER, readInitData } from './read-init-data';

/** The send sheet's items, in its order. */
export const SEND_ITEMS = ['today', 'tomorrow', 'thisWeek', 'nextWeek', 'weather'] as const;
export type SendItem = (typeof SEND_ITEMS)[number];

export type SendCommand = { command: 'summary' | 'lookahead' | 'nextweek' | 'weather'; args?: 'tmrw' };

/** What /api/execute-command runs for each item: the old dashboard's five buttons. */
export const SEND_COMMANDS: Record<SendItem, SendCommand> = {
  today: { command: 'summary' },
  tomorrow: { command: 'summary', args: 'tmrw' },
  thisWeek: { command: 'lookahead' },
  nextWeek: { command: 'nextweek' },
  weather: { command: 'weather' },
};

/**
 * - closing: Telegram answered 2xx and the app was asked to close. Keep the spinner.
 * - sent: a 2xx and the page stays. `chat` is where the answer went: WhatsApp in a
 *   browser; Telegram when the SDK couldn't close the app (blocked script, a throw).
 * - busy: 429, try again in a minute.
 * - failed: any other status, or null when no answer came (offline, blocked request).
 */
export type SendResult =
  | { outcome: 'closing' }
  | { outcome: 'sent'; chat: 'whatsapp' | 'telegram' }
  | { outcome: 'busy' }
  | { outcome: 'failed'; status: number | null };

/**
 * Asks the bot to post `item` in the user's chat. `userId` is the page's own user_id as
 * page-data hands it to the dashboard (a telegramId or a DB id; the route accepts either
 * for the proved user). `locale` rides along as the old call sent it.
 */
export async function sendToChat(userId: number, item: SendItem, locale: string): Promise<SendResult> {
  const initData = readInitData();
  const { command, args } = SEND_COMMANDS[item];

  let status: number;
  try {
    const res = await fetch('/api/execute-command', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...(initData ? { [INIT_DATA_HEADER]: initData } : {}) },
      body: JSON.stringify({ user_id: userId, command, args, language: locale, ...(initData ? { initData } : {}) }),
    });
    status = res.status;
  } catch (err) {
    console.error('[command-client] The send got no answer:', err);
    return { outcome: 'failed', status: null };
  }

  if (status === 429) return { outcome: 'busy' };
  if (status < 200 || status > 299) return { outcome: 'failed', status };
  if (!initData) return { outcome: 'sent', chat: 'whatsapp' };

  try {
    const tg = window.Telegram?.WebApp;
    if (tg && typeof tg.close === 'function') {
      tg.close();
      return { outcome: 'closing' };
    }
  } catch (err) {
    console.error('[command-client] Could not close the Mini App:', err);
  }
  return { outcome: 'sent', chat: 'telegram' };
}
```

- [ ] **Step 7: Run both smokes and the regression smokes again**

```bash
cd /Users/razielgershoni/development/famcalbot
for f in smoke-command-client smoke-telegram-ui; do for tz in UTC Asia/Jerusalem; do TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/$f.ts; echo "$f $tz exit=$?"; done; done
for f in smoke-initdata-header smoke-miniapp-gate; do for tz in UTC Asia/Jerusalem; do TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/$f.ts 2>&1 | grep -E '^(OK|FAIL)|passed' > /tmp/d4-$f-${tz//\//_}.after; echo "$f $tz exit=${pipestatus[1]}"; cmp -s /tmp/d4-$f-${tz//\//_}.before /tmp/d4-$f-${tz//\//_}.after && echo "  same output as Step 3" || echo "  OUTPUT CHANGED"; done; done
```
(zsh, as in Step 3.)

Expected for `smoke-command-client.ts`, under each clock:
```
OK  #1 the five send items, in the sheet's order, run exactly the old dashboard's five commands
OK  #2 Telegram, 200 and 202: one POST to /api/execute-command with the initData header and the body copy, then close() once
OK  #3 Telegram, 429: busy (try in a minute), and the app stays open
OK  #4 Telegram, 400 / 401 / 403 / 404 / 500 / 503: failed with the status, and the app stays open
OK  #5 Telegram, no answer (fetch rejects): failed with status null, logged, and the app stays open
OK  #6 a browser with the SDK loaded (initData ''): no header, no initData in the body, 200 → sent to WhatsApp, and close() is never called
OK  #7 a browser: 429 → busy, 500 → failed, no answer → failed (null); the page never closes
OK  #8 a browser with no SDK at all: 200 → sent to WhatsApp
OK  #9 Telegram with the SDK blocked (initData only in the launch hash): the header from the hash, 200 → sent to the Telegram chat, nothing to close
OK  #10 Telegram, a close() that throws: sent to the Telegram chat, logged, and sendToChat does not throw
OK  #11 [guard] the old dashboard keeps its own executeCommand, which closes in its finally, and does not use command-client

11/11 passed (process TZ=UTC)
smoke-command-client UTC exit=0
```
Expected for `smoke-telegram-ui.ts`, under each clock:
```
OK  #1 [types] isVersionAtLeast, vertical swipes, onEvent/offEvent, the safe-area insets and the section colours are typed
OK  #2 BackButton (8.0 client): mounted inactive it only hides; active, one handler and show(); a tap calls onBack
OK  #3 BackButton: a new onBack on re-render is used without re-registering; inactive → offClick(that handler), hide(), and a tap reaches nobody
OK  #4 BackButton: mounted active → hide() first, then onClick + show(); unmount → offClick + hide()
OK  #5 BackButton under StrictMode (effects run twice): shown with exactly one handler; unmount leaves none
OK  #6 BackButton on a 6.0 client and in a browser (SDK at 6.0, no initData): no SDK call at all; with no SDK nothing throws
OK  #7 BackButton: a hide() that throws on mount still lets it show later; an offClick that throws still hides; both logged
OK  #8 theme (8.0 client): setHeaderColor(bg_color) and setBackgroundColor(bg_color) on mount; Telegram's colorScheme; themeChanged re-applies and re-renders; unmount unsubscribes
OK  #9 theme on a 6.0 client: no colour call (the scheme still follows colorScheme); a setHeaderColor that throws still lets setBackgroundColor run
OK  #10 theme in a browser (SDK at 6.0, no initData): prefers-color-scheme and its changes, never Telegram's colorScheme; unmount removes the listener
OK  #11 server render: the theme is light and neither hook calls the SDK while rendering
OK  #12 onTelegramEvent: activated needs Bot API 8.0 (7.10: no subscription, a no-op unsubscribe); on 8.0 the same handler on and off
OK  #13 openExternalLink: Telegram → openLink; a browser → a new tab; javascript: and relative links refused; a throwing openLink falls back to a tab
OK  #14 isInTelegram: the SDK alone is not Telegram; initData from the SDK or the launch hash is

14/14 passed (process TZ=UTC)
smoke-telegram-ui UTC exit=0
```
Then the same two with `(process TZ=Asia/Jerusalem)`. Neither smoke prints anything else: the warnings and errors the code logs on purpose are collected and asserted, not printed.

Every regression run prints `exit=0` and `same output as Step 3`.

- [ ] **Step 8: Type-check and lint**

```bash
cd /Users/razielgershoni/development/famcalbot
npx tsc --noEmit -p . && npm run -s lint; echo "exit $?"
```
Expected: no output from either, then `exit 0`. `next build` type-checks `scripts/**`, so both smokes are covered too. Check #1's members now resolve.

- [ ] **Step 9: Commit**

```bash
cd /Users/razielgershoni/development/famcalbot
git add src/types/telegram-webapp.d.ts src/lib/telegram-ui.ts src/lib/command-client.ts scripts/smoke-command-client.ts scripts/smoke-telegram-ui.ts
git commit -m "$(cat <<'EOF'
feat(calendar-home): Telegram calls and send to chat for the new home

telegram-ui.ts holds the calendar home's Telegram calls: the BackButton
hook (hidden on mount, offClick and hide whenever it stops being needed),
the theme (bg_color header and background, colorScheme and themeChanged,
prefers-color-scheme in a browser), a gated event subscription and an
external link opener. Each call is gated with isVersionAtLeast and wrapped
in try/catch. command-client.ts sends Today, Tomorrow, This week, Next week
and Weather to the chat with the initData header and the body fallback;
inside Telegram it closes the app only on a 2xx (R5), says busy on a 429,
and in a browser stays open. The SDK types gain isVersionAtLeast, vertical
swipes, onEvent/offEvent, the safe-area insets and the section colours.
Nothing renders them yet; the old dashboard is unchanged.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
EOF
)"
```
Stage only these five paths.

---

### Task 5 (D5): Agenda view (spec §7.3, §7.5, §7.7 and §5's states; Rulings R7, R8, R10, R19)

> **INTERFACE CHANGES VERSUS THE SPLIT (read these first; D6 builds on them). Nothing the split names is renamed or removed.**
> 1. **`AgendaViewProps`**, which the split leaves to D5, is `{ agenda: AgendaModel | null; hints: HomeHints; setupNeeded: boolean; selected: AgendaRow | null; onSelect: (row: AgendaRow | null) => void; onShowNextWeek: () => void; onRetry: (source: SourceName) => void; onChooseCalendars: () => void }`. D6 owns the store, the fetches and the week count, and passes `buildAgenda(store, weeks)`. `null` means no answer yet, and the view shows placeholders. `setupNeeded` is true for a Google user with no connection or no calendars chosen (D6 passes `calendarSource === 'GOOGLE' && (needsOAuth || needsCalendars)`): the Agenda then shows no days, no placeholders, no empty state, no fold and no "Show next week", because D6's setup banner is the call to action and an Agenda read with nothing chosen would only say "Nothing planned" (review patch).
> 2. **The container owns Telegram's BackButton and the item sheet's selection** (review patch; it was AgendaView's). AgendaView renders the sheet for `selected` and reports taps through `onSelect(row)` and closes through `onSelect(null)`; it never calls the BackButton. D6 calls `useTelegramBackButton(itemSheetOpen || sendOrMenuOpen, close)` once, at its root, so the button's hide-on-mount runs on the home's first render after a reload, and one tap closes whichever sheet is open (spec §7.6 has one button; Android's back gesture is the same button). D6 also clears the selection when a store drop empties the model.
> 3. **Four files beyond the split's four** (AgendaView, DayList, ItemRow, ItemSheet), plus the split's own `home-props.ts`:
>    - `StillOpenCard.tsx`: the card the split lists under D5.
>    - `BottomSheet.tsx`: the sheet frame (scrim, panel, grab bar, Close, focus, Escape). D6's SendSheet and MenuSheet should use it too.
>    - `home-theme.ts`: `HOME_THEME_CSS`, the colour tokens mapped onto Telegram's theme params, with `globals.css`'s own brand tokens as the fallbacks (spec §7.1 Look) and the page's root painted in the theme while the home is mounted. **D6's root must be `<div className="ch-home" data-theme={useTelegramTheme()} dir={…}>` with `<style>{HOME_THEME_CSS}</style>` inside it, and AgendaView goes inside that root.** No ancestor of the home may set `transform` or `filter`, because the sheet is `position: fixed` and rendered in place.
>    - `src/lib/calendar-view/format.ts`: the Intl helpers. **D6's header uses `formatDayLong(today, locale)` with D2's `hebrewFullDate`.**
>    - `src/lib/calendar-view/home-props.ts`: the split's props contract, created verbatim.
> 4. **The smoke renders `AgendaView`, not `CalendarHome`.** The split's D5 smoke names CalendarHome, which D6 writes. The Agenda gets its data the way D6 will feed it: answers go through D3's real reducer and `buildAgenda`. **D6 adds its CalendarHome cases to the same `scripts/smoke-calendar-home-render.ts`.**
> 5. **English dates are day-first** (`en-GB`: "Thu 15 Oct"), as in the approved mockups. The header's long date is "Thursday, 15 October": en-GB writes no comma after the weekday, so `formatDayLong` adds the one spec §7.2 and the mockups show (he-IL and ru-RU already have it). Hebrew uses `he-IL` and Russian `ru-RU`. **The Agenda's day forms follow the mockups, not Intl's defaults** (review patch): a range in one month names the month once, "Sat 17 – Sun 18 Oct" (spec §7.3's own example; `formatRange` writes "Sat 17 Oct – Sun 18 Oct"), and Hebrew labels read "חמישי 15 באוק׳" as the Hebrew mockup does, not he-IL's short "יום ה׳, 15 באוק׳" (the Hebrew fold line: "אין אירועים בשבת 17 – ראשון 18 באוק׳"). Russian keeps Intl's "чт, 15 окт." ("сб, 17 – вс, 18 окт.").
> 6. **No new copy.** Every string is a D1 key, used verbatim.

**What and why:** Plan D's home is the Agenda alone, with no tab bar (Ruling R19). This task writes what the Agenda shows, top to bottom:
- **State rows** (§5 States), each with Retry or Choose again:
  - a source that failed with no earlier data;
  - a partial Google answer;
  - chosen Google calendars that are gone.
- **The "Still open" card:** today's past-due reminders and the carry-overs. It shows 5, then "N more", and each row says since when the reminder has been open and who set it.
- **Today and the next 6 days** (Ruling R8):
  - day headers with the Hebrew date when it is on;
  - rows with the time or "All day", spans, reminder icons, the person chip (Ruling R7) and "Google · <calendar>";
  - later empty days folded into one line, but only once every source has answered;
  - or, when the window is empty, Ruling R10's empty state, with only the hints the user's plan allows.
- **"Show next week"**.
- **The item sheet** (§7.5): a view-only bottom sheet. The container's Telegram BackButton closes it. Google items add "Open in Google Calendar".
- **A Google user still setting up** (no connection, or no calendars chosen) gets none of the above: D6's banner says what to do.

The view is presentational. D3's model has already decided which days show, which fold, which rows appear and whose each item is. The view formats and lays out. Times are in the route's timezone and 24-hour, set `dir="ltr"`. Titles and names are isolated for bidi. Logical CSS only, nothing under 11 px, taps at least 44 px.

Nothing renders AgendaView yet: D6's CalendarHome does, behind D7's PageGate branch. The switch stays `OFF`, and no user sees a change.

**Files:**
- Prerequisite: Tasks D1–D4 are in. D5 reads D1's `calendarHome` keys, D2's `hebrew-date.ts`, D3's `store.ts` and `agenda.ts`, and D4's `telegram-ui.ts`. None of these exist on the base.
- Create: `src/lib/calendar-view/home-props.ts` (the split's props contract)
- Create: `src/lib/calendar-view/format.ts`
- Create: `app/[locale]/dashboard/home-theme.ts`
- Create: `app/[locale]/dashboard/BottomSheet.tsx`
- Create: `app/[locale]/dashboard/ItemRow.tsx`
- Create: `app/[locale]/dashboard/DayList.tsx`
- Create: `app/[locale]/dashboard/StillOpenCard.tsx`
- Create: `app/[locale]/dashboard/ItemSheet.tsx`
- Create: `app/[locale]/dashboard/AgendaView.tsx`
- Create (test): `scripts/smoke-calendar-home-render.ts`
- Modify: none. The `app/[locale]/dashboard/` and `src/lib/calendar-view/` folders exist on the base. `DashboardClient.tsx`, `page.tsx` and `PageGate.tsx` are untouched.
- Test: `scripts/smoke-calendar-home-render.ts` under `TZ=UTC`, `TZ=Asia/Jerusalem` and `TZ=Pacific/Kiritimati`. Its #15 also renders under `America/Los_Angeles`, in child processes.
- Regression (unchanged):
  - `scripts/smoke-initdata-header.ts` (#8 scans `app/**` and `src/**`);
  - `scripts/smoke-auth-leftovers.ts` (scans `app/`, `src/` and `scripts/`);
  - `scripts/smoke-miniapp-gate.ts`;
  - D1–D4's smokes: `smoke-calendar-home-copy`, `smoke-hebrew-date`, `smoke-calendar-agenda`, `smoke-telegram-ui`, `smoke-command-client`;
  - `scripts/check-i18n-parity.ts`.

**Interfaces:**
- Consumes:
  - from D1, `messages/{en,he,ru}.json` `calendarHome`:
    - `agenda.today|tomorrow|nothingPlanned|showNextWeek`, `agenda.nothingPlannedRange {range}`;
    - `stillOpen.title`, `stillOpen.count {count}`, `stillOpen.more {count}`, `stillOpen.sinceTime {time}`, `stillOpen.sinceYesterday`, `stillOpen.sinceWeekday {weekday}`, `stillOpen.sinceDate {date}`;
    - `row.allDay|continues|noTitle|reminder|open|done|everyDay|repeats|birthday`, `row.until {when}`, `row.snoozedUntil {time}`, `row.snoozedLabel {time}`, `row.googleCalendar {calendar}`;
    - `person.from {name}`, `person.for {name}`;
    - `sheet.label|calendar|location|notes|repeats|everyDay|stateOpen|stateDone|stateLater|openInGoogle`, `sheet.partnerCalendar {name}`, `sheet.stateDoneAt {time}`, `sheet.stateSnoozed {time}`;
    - `empty.title|hintEvents|hintReminders`;
    - `state.partial|googleError|calendarsGone|famcalError|busy`, `state.unavailable {count}`;
    - `actions.retry|chooseAgain|close`, `shell.loading`;
    - `hebrewMonthGenitive` (14 strings, read with `t.raw`).
  - from D2, `src/lib/calendar-view/hebrew-date.ts`: `hebrewDayLabel(dayKey: DayKey, lang: string, genitive?: readonly string[]): string`.
  - from D3, `src/lib/calendar-view/agenda.ts`:
    - the types `AgendaModel`, `AgendaEntry`, `AgendaDay`, `AgendaRow`, `ReminderMark`, `Whose`, `StillOpenCard`, `StillOpenRow`;
    - in the smoke, `buildAgenda(state: CalendarStore, weeks = 1): AgendaModel | null`.
  - from D3, `src/lib/calendar-view/store.ts`: `addDaysToKey(day: DayKey, days: number): DayKey`. In the smoke also `emptyStore`, `reduceStore`, `daysInWindow`, and the types `CalendarStore` and `StoreAction`.
  - from D4, `src/lib/telegram-ui.ts`: `openExternalLink(url: string): boolean` (the smoke's fake Telegram also proves AgendaView makes no BackButton call).
  - from B3, `src/lib/calendar-view/types.ts`: `DayKey`, `SourceName`, `ItemDTO`, `ItemCalendarDTO`, `ItemReminderDTO`, `CalendarDTO`, `RangeResponse`, `compareItems`.
  - `next-intl` 4.6.1: `useTranslations`, `useLocale`, `NextIntlClientProvider` (smoke); React 19.2: `useState`, `useCallback`, `useEffect`, `useRef`, `react-dom/server` and `react-dom/client` (smoke).
- Produces:
  - `src/lib/calendar-view/home-props.ts`, exactly the split's contract. It imports nothing.
    - `export type HomeHints = { reminders: boolean; voiceEvents: boolean }`
    - `export type CalendarHomeProps = { user: { id: number; name: string; isAdmin: boolean }; locale: string; calendarSource: 'GOOGLE' | 'NATIVE'; needsOAuth: boolean; needsCalendars: boolean; hints: HomeHints }`
  - `app/[locale]/dashboard/AgendaView.tsx`:
    - `export interface AgendaViewProps { agenda: AgendaModel | null; hints: HomeHints; setupNeeded: boolean; selected: AgendaRow | null; onSelect: (row: AgendaRow | null) => void; onShowNextWeek: () => void; onRetry: (source: SourceName) => void; onChooseCalendars: () => void }`
    - `export function AgendaView(props: AgendaViewProps): JSX.Element`
    - `export const AGENDA_CSS: string`
  - `app/[locale]/dashboard/DayList.tsx`:
    - `export interface DayListProps { entries: AgendaEntry[]; tz: string; hebrewDates: boolean; onOpen: (row: AgendaRow) => void }`
    - `export function DayList(props: DayListProps)`
    - `export function PlaceholderRows({ count }: { count: number })`
  - `app/[locale]/dashboard/ItemRow.tsx`:
    - `export interface ItemRowProps { row: AgendaRow; day: DayKey; tz: string; onOpen: (row: AgendaRow) => void }`
    - `export function ItemRow(props: ItemRowProps)`
    - `export function ReminderIcon({ mark }: { mark: ReminderMark })`
    - `export function PersonChip({ whose }: { whose: Whose })`
    - `export function usePersonText(whose: Whose): string | null`
    - `export function useItemTitle(item: ItemDTO): string`
  - `app/[locale]/dashboard/StillOpenCard.tsx`:
    - `export interface StillOpenCardProps { card: StillOpenCard; today: DayKey; tz: string; onOpen: (row: AgendaRow) => void }`. Here `StillOpenCard` is D3's type, imported as `StillOpenModel`.
    - `export function StillOpenCard(props: StillOpenCardProps)`
  - `app/[locale]/dashboard/ItemSheet.tsx`:
    - `export interface ItemSheetProps { row: AgendaRow; today: DayKey; tz: string; onClose: () => void }`
    - `export function ItemSheet(props: ItemSheetProps)`
  - `app/[locale]/dashboard/BottomSheet.tsx`:
    - `export interface BottomSheetProps { label: string; closeLabel: string; onClose: () => void; children: ReactNode }`
    - `export function BottomSheet(props: BottomSheetProps)`
  - `app/[locale]/dashboard/home-theme.ts`: `export const HOME_THEME_CSS: string`, which also paints `html:has(.ch-home)`. Its tokens are `--ch-bg`, `--ch-text`, `--ch-hint`, `--ch-muted`, `--ch-accent`, `--ch-surface`, `--ch-section`, `--ch-separator`, `--ch-button`, `--ch-button-text`, `--ch-danger`, `--ch-card`, `--ch-card-separator`, `--ch-done`, `--ch-chip-bg`, `--ch-chip-text`, `--ch-outline`, `--ch-scrim` and `--ch-sheet-shadow`. Its shared classes are `.ch-home`, `.ch-visually-hidden`, `.ch-btn`, `.ch-btn-primary`, `.ch-chip`, `.ch-chip-outline`, `.ch-tap` and `.ch-sheet-*`.
  - `src/lib/calendar-view/format.ts` (client-safe, Intl only):
    - `export type WeekdayId = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat'`
    - `export function intlLocale(locale: string): string` (en → `en-GB`, he → `he-IL`, ru → `ru-RU`, anything else English)
    - `export function formatDayShort(day: DayKey, locale: string): string` ("Thu 15 Oct", "חמישי 15 באוק׳", "чт, 15 окт.")
    - `export function formatDayLong(day: DayKey, locale: string): string` ("Thursday, 15 October", for D6's header)
    - `export function formatDayMonth(day: DayKey, locale: string): string` ("6 Oct")
    - `export function formatDayRange(first: DayKey, last: DayKey, locale: string): string` ("Sat 17 – Sun 18 Oct"; "Sat 31 Oct – Sun 1 Nov" across months)
    - `export function formatTime(value: string | null | undefined, tz: string, locale: string): string` ("09:30")
    - `export function formatWeekdayTime(value: string | null | undefined, tz: string, locale: string): string` ("Fri 02:00")
    - `export function formatDayTime(value: string | null | undefined, tz: string, locale: string): string` ("Thu 15 Oct, 22:00")
    - `export function instantDay(value: string | null | undefined, tz: string): DayKey | null`
    - `export function weekdayOf(day: DayKey): WeekdayId | null`
    - `export function daysBetween(from: DayKey, to: DayKey): number`
    - `export function allDayLastDay(item: Pick<ItemDTO, 'start' | 'end'>): DayKey`
  - **How D6 renders it:**
    - `const agenda = useMemo(() => buildAgenda(store, weeks), [store, weeks])`, then `<AgendaView agenda={agenda} hints={props.hints} setupNeeded={…} selected={selected} onSelect={setSelected} onShowNextWeek={…} onRetry={…} onChooseCalendars={…} />`;
    - **`selected` / `onSelect`**: the container's state; its one `useTelegramBackButton` is active while the item sheet (or its own send or menu sheet) is open, and a store drop (`agenda` null) clears the selection;
    - **`onShowNextWeek`**: `setWeeks(w => w + 1)`, then fetch `agendaWeekWindow(today, w)` for each applicable source;
    - **`onRetry(source)`**: refetch that source's visible windows. For the partial row the source is `'google'`;
    - **`onChooseCalendars`**: ``router.push(`/${locale}/select-calendars?user_id=${user.id}`)``, as `DashboardClient.tsx:157` does;
    - **the header**: `formatDayLong(today, locale)`, and `hebrewFullDate(today, locale, genitive)` when `hebrewDates`.

**Findings that shaped the code** (line numbers as of the real base plus D1–D4):
- **The view only lays out D3's model.** `buildAgenda` already decides which days show, which fold, which state rows appear, the card's order and cap, and whose each item is (`agenda.ts:136-251`). The view maps:
  - `stateRows[]`:
    - `error` + `famcal` → `state.famcalError`;
    - `error` + `google` → `state.googleError`;
    - `calendarsGone` → `state.calendarsGone` with Choose again;
    - `busy` → `state.busy`.
    The first, second and fourth get Retry. Busy gets one too, so a reader isn't left waiting with no button.
  - `partial` → `state.partial` with Retry (`'google'`); `unavailableCalendars > 0` → `state.unavailable`;
  - a `day` with no rows: `answered` → "Nothing planned", `loading` → placeholders, `failed` → nothing under the header;
  - a `fold` → `agenda.nothingPlannedRange` with `formatDayRange(first, last)`;
  - `empty` → R10's empty state *instead of* the day list. Otherwise "Today · Nothing planned", "Tomorrow · Nothing planned" and a fold would repeat the same news three times.
  - A reconnect is never a row. It is D6's banner (`homeNotices`, D3 finding 4).
- **The time column holds what happens on this day; spans go to the meta line.** The column is 56 px:
  - a timed item: the start, with the end under it;
  - `continues` (timed): "until 10:00";
  - `spansDay`, or any all-day item: "All day".
  
  `endsLater` and `spansDay` add "until Fri 02:00" / "until Thu 22 Oct" or "continues" as the meta line's first segment. Russian "продолжается" (about 82 px at 13 px) would overflow the column, and "Весь день" already wraps to two lines.
- **Intl facts the code relies on** (checked on Node 26.11.1):
  - `en` alone formats US-style ("Thu, Oct 15"); `en-GB` gives the mockups' day-first "Thu 15 Oct".
  - `he-IL`'s `formatRange` drops the two-digit hour inside a time range ("9:30–10:30"). So the sheet builds "09:30 – 10:30" from two `formatTime` calls.
  - `formatRange` on days repeats the month ("Sat 17 Oct – Sun 18 Oct") and, in Hebrew, switches to the long weekday ("יום שבת, 17 באוק׳ – יום ראשון, 18 באוק׳", long at 320–375 px). So `formatDayRange` builds the range itself: the first day cut after its `day` part when both days are in one month, then " – " and the second day.
  - `he-IL`'s short weekday is "יום ה׳" (and "שבת" for Saturday); the Hebrew mockup writes "חמישי". So Hebrew labels take the long weekday without its "יום " prefix, then Intl's "15 באוק׳". `formatWeekdayTime` and `formatDayTime` do the same in Hebrew ("שישי 02:00", "שישי 16 באוק׳, 02:00").
  - The smoke compares text with spaces normalized (Intl's own strings carry narrow and thin spaces).
  - Formatters take the process zone when they are built, and `format.ts` caches them. So a day key is formatted as UTC noon in `timeZone: 'UTC'`, and every time has `timeZone: tz`. #15 has to compare whole child processes, because switching `process.env.TZ` inside one process leaves cached formatters as they were. A mutation that formats day keys in the device's zone passes under UTC, Jerusalem and Kiritimati, and is caught only by #15's Los Angeles child.
- **Bidi** (§7.1):
  - Times and time ranges carry `dir="ltr"`, so "09:30 – 10:30" never flips in Hebrew.
  - Mixed strings like "עד 10:00" and "כל היום" follow the text direction. Forcing them to LTR would put the Hebrew word on the wrong side.
  - Titles are `dir="auto"`. Locations and notes are `<bdi>`. Chips are `dir="auto"`, because a Hebrew name can sit in an English chip.
  - A range across days is two `<bdi>` halves around " – ".
- **Accessible names:**
  - Every tap is a `<button type="button">` holding only phrasing content (spans), because block elements inside a button are invalid. The row's name is its own text: time, title and meta.
  - Icons are `aria-hidden`, and state is always text too: "Open", "done", "Reminder" and the snooze.
  - The snooze badge is `aria-hidden`, with a visually hidden "Snoozed until 15:30" beside it. An `aria-label` on a plain span is not reliably read into a button's name.
  - The sheet is `role="dialog"` with `aria-modal` and D1's `sheet.label`. Focus moves into it on open and back to the row on close.
- **The BackButton is the container's** (review patch). D4's hook hides the button on mount, because the client keeps it across reloads, and the SDK has one button for every handler. D6 owns it at the home's root, where it also covers the send and menu sheets, so AgendaView takes the selection as props (`selected`, `onSelect`):
  - In a browser, the sheet's Close button, Escape and a tap on the scrim do the same job, through `onSelect(null)`.
  - **With no model** (before the first answer, or after a store drop, D3) no sheet renders, whatever the container holds; the container clears its selection on a drop, so the sheet doesn't pop open again when the next answer arrives.
  - **While the sheet is open**, it shows the latest copy of its item (`latestRow`), so a foreground refetch updates it, for example a reminder the partner ticked off.
- **The setup state** (review patch). A Google user who connected but hasn't chosen calendars gets an `ok` answer with seven empty days (spec §2.5 step 2), which `buildAgenda` reads as `empty`: without `setupNeeded`, every new Google user would be told "Nothing planned" with the how-to-add hints under D6's "Choose your calendars" banner. With it the Agenda renders nothing (no placeholders either), and the banner's copy ("Your calendar shows up here once it's connected" / "Pick the Google calendars to show here…") explains the space.
- **"Open in Google Calendar" is a button that calls `openExternalLink`, never an `<a href>`.** Inside Telegram a plain link would navigate the Mini App's own webview away. In a browser the helper opens a new tab.
- **Privacy:**
  - No calendar id reaches the markup.
  - A FamCal row never names its calendar. The person chip and the accent do that job (R7).
  - The sheet names a masked calendar with `sheet.partnerCalendar` ("Noa's calendar"). The route puts the partner's name in a masked calendar's `name` (B5, `famcal.ts:48`).
  - The colour swatch is drawn only for a plain hex colour.
- **Styles:**
  - A plain `<style>` element with `ch-`-prefixed classes, as `PageGate.tsx:49` does. styled-jsx needs Next's SWC transform, which tsx doesn't run. A CSS module can't be loaded under tsx.
  - The sheet is rendered in place, not in a portal, so it inherits the home's tokens and `dir`.
  - Colours: Telegram's `--tg-theme-*`, falling back to `app/globals.css`'s brand tokens (`--bg-white`, `--text-primary`, `--brand-primary-dark`, and `--brand-primary` for the dark button), so the brand palette lives in one place (spec §7.1 Look; review patch). The shades globals.css has no token for (the hint, surfaces, separators, the danger colour and the dark palette) are the mockups', local to the home. `app/[locale]/layout.tsx` imports globals.css on every page.
  - The root: `html:has(.ch-home)` takes `--tg-theme-bg-color` (the dark fallback in a dark theme, with `color-scheme: dark`). The home scrolls the document, and globals.css paints neither html nor body, so an iOS bounce in Telegram's dark theme would show a white canvas (review patch; a §10 device-check line). Without `:has()` (iOS before 15.4) the root stays as it is today.
  - `color-mix` (inside `@supports`) pulls the hint colour a quarter towards the text, as a contrast floor (§7.7). It also tints the card from the theme's accent.
  - `prefers-reduced-motion` turns the sheet's slide and the placeholder pulse off.
- **The smoke's fake DOM:** node_modules has no jsdom. React 19.2's client renderer needs only this much:
  - `createElement` and `createElementNS` returning nodes with attributes, `style.setProperty` and child lists (`appendChild`, `insertBefore`, `removeChild`, `firstChild`, `nextSibling`, `textContent`);
  - text nodes with `nodeValue`;
  - `addEventListener` on the root container;
  - `focus()` setting `document.activeElement`.

  A tap is a native-like event object passed to the root's capture and bubble listeners inside `act`. React finds the fiber through the node's own expando key.
- **Smoke loading:** the view and the provider are static imports, so tsx compiles them into one require cache and the components share the smoke's `next-intl` and `react`. `react-dom/client` is required only after the fake `window` is installed, as `smoke-telegram-ui.ts` does. `renderToString` puts `<!-- -->` between adjacent text nodes, so the checks read `textOf(html)`.
- **A wrong key** makes next-intl log an error and render the key's path. #6 rejects `calendarHome.` in the markup, and #21 rejects any console warning.
- **Verified:**
  - **Base:** `feat/calendar-home` after Plan C (verified on 2eb69df, Plan C's reference chain on 716a4f8, and again on 6dab367, the branch and `main` after Plan C, which differs from that chain only in files D doesn't touch), with D1–D4's reference commits. D1–D4's smokes pass there: 14/14, 14/14, 33/33, 11/11, 14/14. The first pass, the mutations and the review patch ran on the scratch base (header, Planning Ruling 9): 63e7d4f with D1–D4 applied from their drafts by `bapply.py`, D2's two package lines by hand with no npm run (node_modules already held `@hebcal/hdate` 0.21.1). The before and after results below hold on all three.
  - **Before:** with the smoke written and the source files absent, it exits 1 with `Error: Cannot find module '../app/[locale]/dashboard/AgendaView'` under all three clocks. `tsc` shows the 5 TS2307 errors of Step 2.
  - **After:**
    - 21/21 under `TZ=UTC`, `TZ=Asia/Jerusalem` and `TZ=Pacific/Kiritimati`;
    - `npx tsc --noEmit -p .` and `npm run -s lint` are clean;
    - the regression smokes print the same lines before and after under UTC and Jerusalem: `smoke-initdata-header` 9/9, `smoke-auth-leftovers` 9/9, `smoke-miniapp-gate` 15/15, `smoke-calendar-home-copy` 14/14, `smoke-hebrew-date` 14/14, `smoke-calendar-agenda` 33/33, `smoke-telegram-ui` 14/14, `smoke-command-client` 11/11, `check-i18n-parity` OK (996 keys).
  - **Mutations** (first pass): the smoke catches all 33 under UTC. They were:
    - en-US dates; times in the process zone; day keys in the device's zone (#15's Los Angeles child);
    - a loading day, or a failed day, saying "Nothing planned";
    - no BackButton hook; the button always on; no focus restore; no Escape (the first two before the review patch moved the button to D6);
    - a masked calendar named raw; a calendar id in the markup; FamCal rows naming their calendar;
    - the plan hints ignored; no `dir` on the root; times without `dir="ltr"`;
    - no Russian genitive; Hebrew dates always on;
    - "N more" not expanding; the wrong weekday; carry-overs read as today's;
    - 10 px text; a 40 px tap; `padding-left`; a wrong key;
    - the span ignored; the Google button on every item; snoozed without its badge; done not struck through;
    - busy shown as an error; the partial row retrying FamCal;
    - the sheet surviving a drop; the sheet keeping the tapped copy;
    - a `<div>` inside a button.
  - **Review patch** (the patched smoke, still 21 checks, run against the pre-patch sources): 13/21, with #2, #4, #5 and #13 failing on the date forms (Intl's "Sat 17 Oct – Sun 18 Oct", he-IL's "יום ה׳, 15 באוק׳"), #11 on the setup state ("Nothing planned" and the hints under a setup banner), #14 on the colours (no globals.css token read, no root rule), #16 on the selection (no `onSelect`) and #20 on a sheet the container holds open. Each new assertion was also seen to fail on its own mutation: a range naming its month twice, he-IL's short weekday back, `setupNeeded` ignored, a hex fallback instead of `var(--text-primary)`, the `html:has` rule dropped, AgendaView calling `useTelegramBackButton` again. The patched smoke passes 21/21 under UTC, Jerusalem and Kiritimati on Node 26.11.1, and under UTC and Jerusalem on Node 22.23.3 (production's major), so the pinned Hebrew and Russian strings hold on both ICUs.
  - **The task text itself was replayed** on a fresh copy of 2eb69df with D1–D4's texts applied first. Every block applied once, and the tree came out byte-identical to D5's reference commit, where Steps 2, 12, 13 and 14 printed the expected output below. (First pass: replayed the same way on a fresh 63e7d4f copy, and after the review patch into `wt/D-int`.)
- **Verified against stand-ins:** none. D1–D4 were applied from their drafts as written, not stubbed, and `home-props.ts` is this task's own file.

All smoke commands below use this fake environment (never `.env`):
```bash
E="DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake"
```

- [ ] **Step 1: Write the failing smoke `scripts/smoke-calendar-home-render.ts`**

Create the file with exactly this content:

```ts
// Smoke test for the calendar home's Agenda view (spec §7.3, §7.5, §7.7, §5 States;
// Rulings R7, R8, R10, R19; Plan D, Task D5): AgendaView and its parts (DayList, ItemRow,
// StillOpenCard, ItemSheet, BottomSheet) in app/[locale]/dashboard/, and the date and
// time helpers in src/lib/calendar-view/format.ts.
//
// The Agenda is built the way CalendarHome (D6) builds it: range answers go through the
// real store (D3's reduceStore) and buildAgenda, and AgendaView renders the model in
// en, he and ru through next-intl with the real messages. It checks:
//  - the copy each language shows: day labels, the Hebrew date (R9's genitive in
//    Russian), the fold line, the "Still open" card with its "since" lines, the rows'
//    times (24-hour, in the user's timezone, whatever the process clock), spans,
//    reminder states and person chips (R7), the Google chip, the empty state's hints
//    (R10), the §5 state rows;
//  - "Empty means answered": no "Nothing planned" and no fold before every source
//    answered, or after an error or a reconnect;
//  - privacy: no calendar id in the markup; a masked partner calendar reads "Noa's calendar";
//  - Plan D's shape (R19): no tab bar; dir="rtl" in Hebrew; no untranslated key;
//  - accessibility: buttons for every tap, icons hidden, times dir="ltr", titles
//    dir="auto", the sheet a modal dialog; the CSS has no text under 11 px, no tap
//    target under 44 px, logical properties only and a reduced-motion rule;
//  - the item sheet's details (§7.5), and, in real React (react-dom/client with act on a
//    small fake DOM), that a tap selects the row through the container's onSelect and
//    the sheet opens, AgendaView never touches Telegram's BackButton (the container's
//    one button, D6), the Close button, Escape and the scrim close it, focus goes back
//    to the row, "Open in Google Calendar" calls openLink, and the buttons call the
//    container's callbacks;
//  - the mockups' day forms: a fold line in one month names it once ("Sat 17 – Sun 18
//    Oct"), and Hebrew labels read "חמישי 15 באוק׳";
//  - a Google user still setting up (setupNeeded) gets no Agenda: no "Nothing planned",
//    no hint, no fold, no placeholders;
//  - the colours: the brand fallbacks are globals.css's tokens, and the page's root takes
//    the theme's background while the home is mounted.
// React must log no warning. No network, no DB, no Redis.
//
// Run with the fake env from the task brief (no dotenv), under three clocks:
//   TZ=UTC npx tsx scripts/smoke-calendar-home-render.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-calendar-home-render.ts
//   TZ=Pacific/Kiritimati npx tsx scripts/smoke-calendar-home-render.ts

// The view first: the import-rule check walks what these load.
import { AgendaView, AGENDA_CSS, type AgendaViewProps } from '../app/[locale]/dashboard/AgendaView';
import { ItemSheet } from '../app/[locale]/dashboard/ItemSheet';
import { HOME_THEME_CSS } from '../app/[locale]/dashboard/home-theme';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { createRequire } from 'module';
import React, { createElement, type ComponentProps, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { buildAgenda, type AgendaModel, type AgendaRow } from '../src/lib/calendar-view/agenda';
import { addDaysToKey, daysInWindow, emptyStore, reduceStore, type CalendarStore, type StoreAction } from '../src/lib/calendar-view/store';
import { compareItems, type CalendarDTO, type DayKey, type ItemCalendarDTO, type ItemDTO, type ItemReminderDTO, type RangeResponse } from '../src/lib/calendar-view/types';
import type { HomeHints } from '../src/lib/calendar-view/home-props';
import { formatDayRange, formatDayShort } from '../src/lib/calendar-view/format';

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
    reactWarnings.push(text.slice(0, 300));
  };
}

// ---- Fixtures: an Israeli FamCal user paired with Noa, on Thursday 15 October 2026 ----

const TZ = 'Asia/Jerusalem';
const TODAY: DayKey = '2026-10-15';
const day = (n: number): DayKey => addDaysToKey(TODAY, n);
/** A wall-clock time in Israel on day n, as UTC ISO (IDT, UTC+3, until 25 October). */
function at(n: number, hhmm: string): string {
  const [y, m, d] = day(n).split('-').map(Number);
  const [h, min] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, h - 3, min)).toISOString();
}

const MY_CAL: ItemCalendarDTO = { id: 'native:cal_me_7f3a', name: 'Family', color: '#039BE5', mine: true, inLegend: true };
const NOA_CAL: ItemCalendarDTO = { id: 'native:cal_noa_91b2', name: 'Noa and the kids', color: '#F4511E', mine: false, ownerName: 'Noa', inLegend: true };
/** A partner's private calendar on a reminder-for-me: masked by the route (id null, the partner's name). */
const MASKED: ItemCalendarDTO = { id: null, name: 'Noa', color: null, mine: false, inLegend: false };
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

const VITAMINS = item('vitamins', { kind: 'reminder', title: 'Take vitamins', start: at(0, '08:00'), recurring: true, repeatsDaily: true, reminder: rem({ done: true, doneAt: at(0, '08:10') }) });
const DENTIST = item('dentist', { title: 'Dentist', start: at(0, '09:30'), end: at(0, '10:30'), location: 'Clinic on Herzl St', description: 'Bring the X-rays\nAsk about the night guard' });
const FORM = item('form', { kind: 'reminder', title: 'Send the school form', start: at(0, '13:00'), reminder: rem({ open: true }) });
const SNOOZED = item('snoozed', { kind: 'reminder', title: 'Call the bank', start: at(0, '14:00'), reminder: rem({ open: true, snoozedUntil: at(0, '15:30') }) });
const FOOTBALL = item('football', { title: 'Football practice', start: at(0, '17:00'), end: at(0, '18:00'), calendar: NOA_CAL });
const CONCERT = item('concert', { title: 'Concert', start: at(0, '22:00'), end: at(1, '02:00'), span: 'endsLater' });
const GRANDMA = item('grandma', { title: 'Grandma visits', start: day(1), end: day(2), allDay: true, tz: null, calendar: NOA_CAL });
const CHALLAH = item('challah', { kind: 'reminder', title: 'Buy challah', start: at(1, '10:00'), reminder: rem({ creatorIsViewer: false, creatorName: 'Noa' }) });
const PARCEL = item('parcel', { kind: 'reminder', title: 'Pick up the parcel', start: at(1, '12:00'), calendar: MASKED, reminder: rem({ creatorIsViewer: false, creatorName: 'Noa' }) });
const FOR_NOA = item('for-noa', { kind: 'reminder', title: 'Book the plumber', start: at(1, '18:00'), calendar: NOA_CAL, reminder: rem({ ownerIsViewer: false, ownerName: 'Noa' }) });
const MEETING = item('meeting', { title: 'Parent–teacher meeting', start: at(4, '08:15'), end: at(4, '09:00'), calendar: NOA_CAL });
const RECYCLING = item('recycling', { kind: 'reminder', title: 'Take out the recycling', start: at(4, '21:00'), recurring: true, reminder: rem() });
const TRIP = (n: 5 | 6): ItemDTO =>
  item('trip', { title: 'Trip to Eilat', start: day(5), end: day(8), allDay: true, tz: null, span: n === 5 ? 'endsLater' : 'spansDay' });
const SLEEPOVER = (n: 5 | 6): ItemDTO =>
  item('sleepover', { title: 'Sleepover at Dana’s', start: at(5, '20:00'), end: at(6, '10:00'), span: n === 5 ? 'endsLater' : 'continues' });

const CARRY_BILL = item('bill', { kind: 'reminder', title: 'Pay the electricity bill', start: at(-2, '09:00'), reminder: rem({ open: true, openSince: day(-2) }) });
const CARRY_PLUMBER = item('plumber', { kind: 'reminder', title: 'Call the plumber', start: at(-1, '11:00'), reminder: rem({ open: true, openSince: day(-1), creatorIsViewer: false, creatorName: 'Noa' }) });
const CARRY_OLD = item('old', { kind: 'reminder', title: 'Renew the passport', start: at(-9, '10:00'), reminder: rem({ open: true, openSince: day(-9) }) });

const WEEK: Record<DayKey, ItemDTO[]> = {
  [day(0)]: [VITAMINS, DENTIST, FORM, SNOOZED, FOOTBALL, CONCERT],
  [day(1)]: [GRANDMA, CHALLAH, PARCEL, FOR_NOA],
  [day(4)]: [MEETING, RECYCLING],
  [day(5)]: [TRIP(5), SLEEPOVER(5)],
  [day(6)]: [TRIP(6), SLEEPOVER(6)],
};

function answer(o: Partial<RangeResponse> & { items?: Record<DayKey, ItemDTO[]> } = {}): RangeResponse {
  const from = o.from ?? TODAY;
  const to = o.to ?? day(7);
  const items = o.items ?? {};
  const { items: _items, ...rest } = o;
  return {
    tz: TZ,
    today: TODAY,
    weekStart: 0,
    hebrewDates: true,
    from,
    to,
    sources: { famcal: { status: 'ok' } },
    partner: { name: 'Noa' },
    calendars: LEGEND,
    days: daysInWindow(from, to).map((date) => ({ date, items: [...(items[date] ?? [])].sort(compareItems) })),
    ...rest,
  };
}

function storeOf(actions: StoreAction[]): CalendarStore {
  return actions.reduce(reduceStore, emptyStore());
}
const ok = (response: RangeResponse): StoreAction => ({ type: 'response', response, epoch: 0 });
function model(actions: StoreAction[], weeks = 1): AgendaModel {
  const m = buildAgenda(storeOf(actions), weeks);
  assert(m, 'buildAgenda gave null: the fixture pinned no facts');
  return m;
}

const famcalWeek = () => model([ok(answer({ items: WEEK, carryOvers: [CARRY_PLUMBER, CARRY_BILL, CARRY_OLD] }))]);

// A Google user: their Family calendar, the birthdays calendar and a spouse-labelled one.
const G_FAMILY: ItemCalendarDTO = { id: 'family-6c1d@group.calendar.google.com', name: 'Family', color: '#7986CB', mine: true, inLegend: true };
const G_BIRTHDAYS: ItemCalendarDTO = { id: 'addressbook#contacts@group.v.calendar.google.com', name: 'Birthdays', color: '#33B679', mine: true, inLegend: true };
const G_NOA: ItemCalendarDTO = { id: 'noa.k@example.com', name: 'Noa', color: '#E67C73', mine: false, ownerName: 'Noa', inLegend: true };
const HTML_LINK = 'https://www.google.com/calendar/event?eid=ZGlubmVy';
const DINNER = item('dinner', { source: 'google', readOnly: true, tz: null, title: 'Dinner with the Cohens', start: '2026-10-15T19:30:00+03:00', end: '2026-10-15T22:00:00+03:00', calendar: G_FAMILY, htmlLink: HTML_LINK, birthday: false });
const BIRTHDAY = item('bday', { source: 'google', readOnly: true, tz: null, title: 'Noa’s birthday', start: day(1), end: day(2), allDay: true, calendar: G_BIRTHDAYS, birthday: true, htmlLink: null });
const YOGA = item('yoga', { source: 'google', readOnly: true, tz: null, title: 'Yoga', start: '2026-10-16T18:00:00+03:00', end: '2026-10-16T19:00:00+03:00', calendar: G_NOA, htmlLink: 'https://www.google.com/calendar/event?eid=eW9nYQ' });

function googleAnswer(o: Partial<RangeResponse> & { items?: Record<DayKey, ItemDTO[]> } = {}): RangeResponse {
  return answer({
    sources: { google: { status: 'ok' } },
    partner: null,
    calendars: [
      { id: G_FAMILY.id as string, source: 'google', name: 'Family', color: '#7986CB', mine: true },
      { id: G_BIRTHDAYS.id as string, source: 'google', name: 'Birthdays', color: '#33B679', mine: true },
      { id: G_NOA.id as string, source: 'google', name: 'Noa', color: '#E67C73', mine: false, ownerName: 'Noa' },
    ],
    ...o,
  });
}
const googleWeek = () => model([ok(googleAnswer({ items: { [day(0)]: [DINNER], [day(1)]: [BIRTHDAY, YOGA] } }))]);

const HINTS_ALL: HomeHints = { reminders: true, voiceEvents: true };
const noop = () => undefined;

// ---- Rendering ----

/** CalendarHome's frame (D6): the theme root and its tokens, inside next-intl's provider. */
function inHome(locale: Locale, el: ReactElement): ReactElement {
  // The provider's props type makes children required; createElement takes them as its third argument.
  const provider = { locale, messages: messages[locale], timeZone: TZ } as ComponentProps<typeof NextIntlClientProvider>;
  return createElement(
    NextIntlClientProvider,
    provider,
    createElement('div', { className: 'ch-home', 'data-theme': 'light' }, createElement('style', null, HOME_THEME_CSS), el),
  );
}

function agendaProps(agenda: AgendaModel | null, o: Partial<AgendaViewProps> = {}): AgendaViewProps {
  return { agenda, hints: HINTS_ALL, setupNeeded: false, selected: null, onSelect: noop, onShowNextWeek: noop, onRetry: noop, onChooseCalendars: noop, ...o };
}

function renderAgenda(locale: Locale, agenda: AgendaModel | null, o: Partial<AgendaViewProps> = {}): string {
  return renderToString(inHome(locale, createElement(AgendaView, agendaProps(agenda, o))));
}

type Interactive = Partial<AgendaViewProps> & { seen?: (string | null)[] };

/**
 * AgendaView as the container holds it (D6 keeps the selected row): a tap opens the sheet.
 * `seen` records each onSelect: the row's key, or null for a close.
 */
function AgendaWithSelection({ seen, ...props }: AgendaViewProps & { seen?: (string | null)[] }) {
  const [selected, setSelected] = React.useState<AgendaRow | null>(props.selected);
  const onSelect = (row: AgendaRow | null) => {
    seen?.push(row ? row.item.key : null);
    setSelected(row);
  };
  return createElement(AgendaView, { ...props, selected, onSelect });
}

/** The Agenda for the real-React checks: in the home's frame, with the selection kept. */
function interactive(locale: Locale, agenda: AgendaModel | null, o: Interactive = {}): ReactElement {
  return inHome(locale, createElement(AgendaWithSelection, agendaProps(agenda, o)));
}

function renderSheet(locale: Locale, row: AgendaRow, today = TODAY): string {
  return renderToString(inHome(locale, createElement(ItemSheet, { row, today, tz: TZ, onClose: noop })));
}

/** The text a reader sees: tags and React's text separators out, entities decoded, spaces collapsed. */
function textOf(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/g, ' ')
    .replace(/<!-- -->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Intl joins ranges with thin and narrow spaces; textOf turns every space into a plain one. */
const spaces = (s: string) => s.replace(/\s+/g, ' ');

/** The markup without the style sheets (their class names would match anything). */
const markup = (html: string) => html.replace(/<style[^>]*>[\s\S]*?<\/style>/g, '');

function assertHas(text: string, wanted: string[], where: string) {
  const missing = wanted.filter((w) => !text.includes(spaces(w)));
  assert(missing.length === 0, `${where}: missing ${show(missing)} in ${show(text.slice(0, 1500))}`);
}
function assertLacks(text: string, unwanted: string[], where: string) {
  const found = unwanted.filter((w) => text.includes(spaces(w)));
  assert(found.length === 0, `${where}: should not show ${show(found)}`);
}

/** The row for a fixture item in a model (first day it is on). */
function rowOf(agenda: AgendaModel, key: string): AgendaRow {
  for (const e of agenda.entries) {
    if (e.type !== 'day') continue;
    const r = e.rows.find((x) => x.item.key === key);
    if (r) return r;
  }
  const open = [...(agenda.stillOpen?.shown ?? []), ...(agenda.stillOpen?.more ?? [])].find((x) => x.item.key === key);
  assert(open, `${key} is not in the model`);
  return open;
}

/** Reference formatting, to compare the view's dates with (the same Intl options the task names). */
const ref = {
  dayShort: (l: string, d: DayKey) => new Intl.DateTimeFormat(l, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${d}T12:00:00Z`)),
  dayMonth: (l: string, d: DayKey) => new Intl.DateTimeFormat(l, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${d}T12:00:00Z`)),
  dayTime: (l: string, iso: string) =>
    new Intl.DateTimeFormat(l, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: TZ }).format(new Date(iso)),
  weekdayTime: (l: string, iso: string) =>
    new Intl.DateTimeFormat(l, { weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: TZ }).format(new Date(iso)),
};

// ---- A small fake DOM for react-dom/client (no jsdom in node_modules) ----

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
  },
};
fakeDocument.defaultView = fakeWindow;

function installWindow() {
  const g = globalThis as Row;
  g.window = fakeWindow;
  g.document = fakeDocument;
  g.IS_REACT_ACT_ENVIRONMENT = true;
}

/** A fake Telegram.WebApp (Bot API 7.0) that records calls and keeps BackButton handlers, as the SDK does. */
function fakeTelegram() {
  const calls: string[] = [];
  const back = new Set<() => void>();
  const ids = new Map<unknown, string>();
  const label = (a: unknown) => {
    if (typeof a !== 'function') return String(a);
    if (!ids.has(a)) ids.set(a, `fn${ids.size + 1}`);
    return ids.get(a) as string;
  };
  const rec =
    (name: string, effect?: (arg: unknown) => void) =>
    (arg?: unknown) => {
      calls.push(`${name}(${arg === undefined ? '' : label(arg)})`);
      effect?.(arg);
    };
  const webApp: Row = {
    initData: 'query_id=AAE&user=%7B%22id%22%3A5550001%7D&auth_date=1792000000&hash=abc',
    version: '7.0',
    colorScheme: 'light',
    isVersionAtLeast: (v: string) => Number(v) <= 7,
    openLink: rec('openLink'),
    onEvent: rec('onEvent'),
    offEvent: rec('offEvent'),
    BackButton: {
      onClick: rec('BackButton.onClick', (h) => back.add(h as () => void)),
      offClick: rec('BackButton.offClick', (h) => back.delete(h as () => void)),
      show: rec('BackButton.show'),
      hide: rec('BackButton.hide'),
    },
  };
  return { webApp, calls, pressBack: () => [...back].forEach((h) => h()), handlers: () => back.size };
}

type Mounted = {
  container: FakeElement;
  render: (el: ReactElement) => void;
  click: (el: FakeNode) => void;
  key: (el: FakeNode, key: string) => void;
  unmount: () => void;
};

function mount(el: ReactElement): Mounted {
  const { createRoot } = nodeRequire('react-dom/client');
  const container = new FakeElement('div', HTML_NS);
  const root = createRoot(container);
  React.act(() => root.render(el));
  const dispatch = (target: FakeNode, type: string, extra: Row) => {
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
  };
  return {
    container,
    render: (next) => React.act(() => root.render(next)),
    click: (target) => dispatch(target, 'click', {}),
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
function button(node: FakeNode, text: string): FakeElement {
  const found = elements(node).filter((e) => e.localName === 'button' && e.textContent.includes(text));
  assert(found.length > 0, `no button with ${show(text)} in ${show(node.textContent.slice(0, 600))}`);
  return found[0];
}
const byClass = (node: FakeNode, cls: string) => elements(node).filter((e) => e.className.split(' ').includes(cls));

// ---- The checks ----

/** The markup #15 compares across process zones: the Agenda and two sheets, in each language. */
function dumpMarkup(): string {
  const week = famcalWeek();
  return LOCALES.map((l) => renderAgenda(l, week) + renderSheet(l, rowOf(week, 'famcal|concert')) + renderSheet(l, rowOf(week, 'famcal|trip')) + renderSheet(l, rowOf(week, 'famcal|vitamins'))).join('\n');
}

async function main() {
  if (process.env.SMOKE_HOME_RENDER_DUMP === '1') {
    // #15's child: a digest of the markup (a pipe would cut a long write at exit).
    const html = dumpMarkup();
    process.stdout.write(`${html.length} ${createHash('sha256').update(html).digest('hex')} ${html.includes('Take vitamins')}\n`);
    return;
  }

  await check('#1 the view is client-safe: AgendaView and ItemSheet load no server module (DB, Redis, services, date-fns-tz, @hebcal/core)', () => {
    const roots = [path.join(ROOT, 'app/[locale]/dashboard/AgendaView.tsx'), path.join(ROOT, 'app/[locale]/dashboard/ItemSheet.tsx')];
    const loaded = new Set<string>();
    const walk = (id: string) => {
      for (const child of require.cache[id]?.children ?? []) {
        if (loaded.has(child.id)) continue;
        loaded.add(child.id);
        walk(child.id);
      }
    };
    for (const id of roots) {
      assert(require.cache[id] !== undefined, `${id} is not in require.cache: the check would be empty`);
      walk(id);
    }
    for (const want of ['app/[locale]/dashboard/DayList.tsx', 'app/[locale]/dashboard/ItemRow.tsx', 'src/lib/calendar-view/format.ts', 'src/lib/telegram-ui.ts']) {
      assert(loaded.has(path.join(ROOT, want)), `${want} not among the loaded modules: the check would be empty`);
    }
    const forbidden = [...loaded].filter((p) =>
      /[\\/](src[\\/](services|utils|config)|@prisma|\.prisma|@upstash|date-fns-tz|@hebcal[\\/]core|googleapis|@googleapis)[\\/]|src[\\/]lib[\\/](page-data|api-auth|prisma)/.test(p),
    );
    assert(forbidden.length === 0, `server modules in the view's graph: ${show(forbidden.map((p) => path.relative(ROOT, p)))}`);
  });

  await check('#2 en: day labels, the Hebrew date, the fold line, times in Israel (24-hour), spans, reminder states and the person chips', () => {
    const text = textOf(renderAgenda('en', famcalWeek()));
    assertHas(
      text,
      [
        `Today ${ref.dayShort('en-GB', day(0))} 4 Cheshvan`,
        `Tomorrow ${ref.dayShort('en-GB', day(1))} 5 Cheshvan`,
        'Nothing planned Sat 17 – Sun 18 Oct',
        `${ref.dayShort('en-GB', day(4))} 8 Cheshvan`,
        '08:00 Take vitamins Reminder · done · every day',
        '09:30 10:30 Dentist Clinic on Herzl St',
        '13:00 Send the school form Open Reminder',
        '14:00 Call the bank Reminder until 15:30 Snoozed until 15:30',
        '17:00 18:00 Football practice Noa',
        `22:00 Concert until ${ref.weekdayTime('en-GB', at(1, '02:00'))}`,
        'All day Grandma visits Noa',
        '10:00 Buy challah Reminder From Noa',
        '12:00 Pick up the parcel Reminder From Noa',
        '18:00 Book the plumber Reminder For Noa',
        '21:00 Take out the recycling Reminder · repeats',
        `All day Trip to Eilat until ${ref.dayShort('en-GB', day(7))}`,
        `20:00 Sleepover at Dana’s until ${ref.weekdayTime('en-GB', at(6, '10:00'))}`,
        'All day Trip to Eilat continues',
        'until 10:00 Sleepover at Dana’s',
        'Show next week',
      ],
      'en',
    );
    assert(ref.dayShort('en-GB', day(0)).includes('15') && ref.dayShort('en-GB', day(0)).includes('Oct'), 'en-GB day label');
    assertLacks(text, ['9:30 AM', '10:00 PM', 'Nothing planned Tomorrow', 'Sat 17 Oct – Sun 18 Oct'], 'en');
    // Spec §7.3 and the mockups: one month is named once; across months, each day has its own.
    const forms = [formatDayRange(day(16), day(17), 'en'), formatDayRange(day(2), day(2), 'en'), formatDayRange('2026-12-31', '2027-01-01', 'en')];
    assert(show(forms) === show(['Sat 31 Oct – Sun 1 Nov', 'Sat 17 Oct', 'Thu 31 Dec – Fri 1 Jan']), `en ranges: ${show(forms)}`);
    const html = markup(renderAgenda('en', famcalWeek()));
    assert(/<button type="button" class="ch-row ch-tap is-done">(?:(?!<\/button>).)*Take vitamins/.test(html), 'a done reminder\'s row is struck through (is-done)');
    assert(!/<button type="button" class="ch-row ch-tap is-done">(?:(?!<\/button>).)*Send the school form/.test(html), 'an open one is not');
  });

  await check('#3 the "Still open" card: today\'s open reminders, then the carry-overs, each with "since", and who set it', () => {
    const agenda = famcalWeek();
    assert(agenda.stillOpen?.shown.length === 5, `5 open: ${show(agenda.stillOpen?.shown.map((r) => r.item.key))}`);
    const expected: Record<Locale, string[]> = {
      en: ['Still open 5 reminders', 'Send the school form Since 13:00', 'Call the bank Since 14:00', 'Call the plumber Since yesterday From Noa', 'Pay the electricity bill Since Tuesday', `Renew the passport Since ${ref.dayMonth('en-GB', day(-9))}`],
      he: ['עדיין פתוחות 5 תזכורות', 'Send the school form מהשעה 13:00', 'Call the plumber מאתמול מאת Noa', 'Pay the electricity bill מיום שלישי', `Renew the passport מ-${ref.dayMonth('he-IL', day(-9))}`],
      ru: ['Невыполненные 5 напоминаний', 'Send the school form С 13:00', 'Call the plumber Со вчерашнего дня От: Noa', 'Pay the electricity bill Со вторника', `Renew the passport С ${ref.dayMonth('ru-RU', day(-9))}`],
    };
    for (const locale of LOCALES) {
      const html = renderAgenda(locale, agenda);
      const card = html.slice(html.indexOf('class="ch-card"'), html.indexOf('class="ch-days"'));
      assert(card.length > 0, `${locale}: no card`);
      assertHas(textOf(card), expected[locale], `${locale} card`);
      assertLacks(textOf(card), ['Take vitamins', 'Book the plumber', 'Buy challah'], `${locale} card (done, the partner's, not due)`);
    }
  });

  await check('#4 he: dir="rtl", the Hebrew mockup\'s labels ("חמישי 15 באוק׳") and fold line ("אין אירועים בשבת 17 – ראשון 18 באוק׳"), Hebrew dates, times set dir="ltr"', () => {
    const html = renderAgenda('he', famcalWeek());
    assert(/<section class="ch-agenda" dir="rtl"/.test(html), 'the Agenda root is dir="rtl"');
    const text = textOf(html);
    assertHas(
      text,
      [
        'היום חמישי 15 באוק׳ ד׳ בחשון',
        'מחר שישי 16 באוק׳ ה׳ בחשון',
        'אין אירועים בשבת 17 – ראשון 18 באוק׳',
        'שני 19 באוק׳ ח׳ בחשון',
        'Take vitamins תזכורת · בוצעה · כל יום',
        'Send the school form פתוחה תזכורת',
        'Buy challah תזכורת מאת Noa',
        'Book the plumber תזכורת בשביל Noa',
        'כל היום Grandma visits Noa',
        'להציג את השבוע הבא',
      ],
      'he',
    );
    assert(html.includes('<span class="ch-time-main" dir="ltr">09:30</span>'), 'a time is dir="ltr"');
    assert(html.includes('<span class="ch-time-sub" dir="ltr">10:30</span>'), 'an end time is dir="ltr"');
    assert(/<span class="ch-time-main">כל היום<\/span>/.test(html), '"All day" follows the text direction');
    assert(html.includes('<span class="ch-title" dir="auto">Dentist</span>'), 'titles are dir="auto"');
    assertLacks(text, ['יום ה׳', 'יום שבת,'], 'he: not he-IL\'s short weekday');
    const forms = [formatDayShort(day(2), 'he'), formatDayRange(day(16), day(17), 'he')];
    assert(show(forms) === show(['שבת 17 באוק׳', 'שבת 31 באוק׳ – ראשון 1 בנוב׳']), `he forms: ${show(forms)}`);
  });

  await check('#5 ru: Russian labels, plural forms and the genitive Hebrew month (Ruling R9)', () => {
    const text = textOf(renderAgenda('ru', famcalWeek()));
    assertHas(
      text,
      [
        `Сегодня ${ref.dayShort('ru-RU', day(0))} 4 хешвана`,
        `Завтра ${ref.dayShort('ru-RU', day(1))} 5 хешвана`,
        'Ничего не запланировано: сб, 17 – вс, 18 окт.',
        'Buy challah Напоминание От: Noa',
        'Book the plumber Напоминание Кому: Noa',
        'Весь день',
        'Показать следующую неделю',
      ],
      'ru',
    );
    assertLacks(text, ['Хешван'], 'ru (the nominative belongs in headers, not day labels)');
  });

  await check('#6 Plan D\'s shape: no tab bar, no Month, no untranslated key, in each language', () => {
    for (const locale of LOCALES) {
      const html = renderAgenda(locale, famcalWeek());
      assertLacks(html, ['role="tablist"', 'role="tab"', 'calendarHome.'], locale);
      if (locale !== 'he') assert(/<section class="ch-agenda" dir="ltr"/.test(html), `${locale}: dir="ltr"`);
    }
    assertLacks(textOf(renderAgenda('en', famcalWeek())), ['Month', 'Agenda'], 'en');
  });

  await check('#7 privacy: no calendar id reaches the markup, and a masked partner calendar reads "Noa\'s calendar"', () => {
    const ids = [MY_CAL.id, NOA_CAL.id, G_FAMILY.id, G_BIRTHDAYS.id, G_NOA.id].map(String);
    for (const locale of LOCALES) {
      const html = renderAgenda(locale, famcalWeek()) + renderAgenda(locale, googleWeek());
      assertLacks(html, [...ids, 'native:', 'cal_'], `${locale} Agenda`);
      for (const key of ['famcal|parcel', 'famcal|football', 'famcal|dentist']) {
        assertLacks(renderSheet(locale, rowOf(famcalWeek(), key)), [...ids, 'native:'], `${locale} sheet ${key}`);
      }
    }
    const masked = textOf(renderSheet('en', rowOf(famcalWeek(), 'famcal|parcel')));
    assertHas(masked, ['Calendar Noa’s calendar', 'From Noa'], 'the masked sheet');
    assertHas(textOf(renderSheet('he', rowOf(famcalWeek(), 'famcal|parcel'))), ['היומן של Noa'], 'he masked sheet');
    assertHas(textOf(renderSheet('en', rowOf(famcalWeek(), 'famcal|football'))), ['Calendar Noa and the kids'], 'a shared partner calendar keeps its name');
    // A FamCal row never names its calendar (the colour and the person chip do the job, R7).
    assertLacks(textOf(renderAgenda('en', famcalWeek())), ['Family', 'Noa and the kids'], 'FamCal rows');
  });

  await check('#8 Google items: "Google · <calendar>", the birthday label, the spouse\'s chip, partial and unavailable rows', () => {
    const store = storeOf([
      ok(
        googleAnswer({
          items: { [day(0)]: [DINNER], [day(1)]: [BIRTHDAY, YOGA] },
          sources: { google: { status: 'ok', partial: { failed: 1, truncated: 0 } } },
          calendars: [
            { id: G_FAMILY.id as string, source: 'google', name: 'Family', color: '#7986CB', mine: true },
            { id: 'gone-1@group.calendar.google.com', source: 'google', name: 'Old', color: null, mine: true, unavailable: true },
            { id: 'gone-2@group.calendar.google.com', source: 'google', name: 'Older', color: null, mine: true, unavailable: true },
          ],
        }),
      ),
    ]);
    const agenda = buildAgenda(store);
    assert(agenda, 'model');
    const text = textOf(renderAgenda('en', agenda));
    assertHas(
      text,
      [
        'Some calendars didn’t load Retry',
        '2 calendars aren’t available Choose again',
        '19:30 22:00 Dinner with the Cohens Google · Family',
        'All day Noa’s birthday Birthday Google · Birthdays',
        '18:00 19:00 Yoga Noa Google · Noa',
      ],
      'en Google',
    );
    assertLacks(text, ['Still open'], 'no FamCal card for a Google user');
    assertHas(textOf(renderAgenda('ru', agenda)), ['2 календаря недоступны Выбрать заново', 'Google · Family'], 'ru Google');
    assertHas(textOf(renderAgenda('he', agenda)), ['שני יומנים לא זמינים לבחור שוב', 'חלק מהיומנים לא נטענו לנסות שוב'], 'he Google');
  });

  await check('#9 "Empty means answered": a FamCal error, a Google reconnect or calendars_gone show no "Nothing planned" and no fold, and the right state row', () => {
    const famcalError = model([ok(answer({ sources: { famcal: { status: 'error' } }, partner: null, calendars: [] }))]);
    const t1 = textOf(renderAgenda('en', famcalError));
    assertHas(t1, ['Couldn’t load your calendar Retry', 'Today', 'Tomorrow'], 'FamCal error');
    assertLacks(t1, ['Nothing planned', 'Still open'], 'FamCal error');

    const reconnect = model([ok(googleAnswer({ sources: { google: { status: 'reconnect', reason: 'token' } }, calendars: [] }))]);
    const t2 = textOf(renderAgenda('en', reconnect));
    assertLacks(t2, ['Nothing planned', 'Couldn’t load', 'Retry', 'Reconnect'], 'reconnect is the banner\'s (D6), never a row');
    assertHas(t2, ['Today', 'Tomorrow'], 'reconnect');

    const gone = model([ok(googleAnswer({ sources: { google: { status: 'error', reason: 'calendars_gone' } }, calendars: [] }))]);
    const t3 = textOf(renderAgenda('en', gone));
    assertHas(t3, ['Your calendars aren’t available Choose again'], 'calendars_gone');
    assertLacks(t3, ['Nothing planned', 'Retry'], 'calendars_gone');

    const googleError = model([ok(googleAnswer({ sources: { google: { status: 'error', reason: 'timeout' } }, calendars: [] }))]);
    assertHas(textOf(renderAgenda('he', googleError)), ['לא הצלחנו לטעון את יומן Google לנסות שוב'], 'Google error (he)');
  });

  await check('#10 loading: placeholders and the loading text before the first answer, and for a week still on its way; never free days', () => {
    const before = renderAgenda('en', null);
    assert(before.includes('aria-busy="true"') && before.includes('class="ch-ghost"'), 'placeholders, aria-busy');
    assertHas(textOf(before), ['Loading your calendar…'], 'loading');
    assertLacks(textOf(before), ['Nothing planned', 'Show next week', 'Today'], 'loading');
    // Week 0 answered; "Show next week" asked for week 1, which hasn't answered.
    const twoWeeks = model([ok(answer({ items: WEEK }))], 2);
    const html = renderAgenda('en', twoWeeks);
    const nextWeek = html.slice(html.indexOf(`id="ch-day-${day(7)}"`));
    assert(nextWeek.length > 0 && html.includes(`id="ch-day-${day(13)}"`), 'week 1\'s days are listed');
    assert(/aria-busy="true"/.test(nextWeek) && nextWeek.includes('class="ch-ghost"'), 'week 1 shows placeholders');
    assertLacks(textOf(nextWeek), ['Nothing planned'], 'week 1 is not empty yet');
    // The same week after a 429: the busy row, still no fold.
    const busy = model([ok(answer({ items: WEEK })), { type: 'windowFailed', from: day(7), to: day(14), sources: ['famcal'], kind: 'busy', epoch: 0 }], 2);
    const busyText = textOf(renderAgenda('en', busy));
    assertHas(busyText, ['Busy right now, try again in a minute Retry'], 'busy');
    assert((busyText.match(/Nothing planned/g) ?? []).length === 1, `only week 0's fold: ${busyText}`);
  });

  await check('#11 the empty state (Ruling R10) names only the ways this user can add things; a Google user still setting up (setupNeeded) gets no Agenda at all', () => {
    const empty = model([ok(answer())]);
    assert(empty.empty, 'the fixture week is empty');
    const all = textOf(renderAgenda('en', empty, { hints: { reminders: true, voiceEvents: true } }));
    assertHas(all, ['Nothing planned', 'send the bot a voice message', 'Remind me to call Grandma at 6', 'Show next week'], 'both hints');
    assertLacks(all, ['Today', 'Tomorrow'], 'the empty state replaces the empty days');
    const remindersOnly = textOf(renderAgenda('en', empty, { hints: { reminders: true, voiceEvents: false } }));
    assertHas(remindersOnly, ['Remind me to call Grandma at 6'], 'reminders only');
    assertLacks(remindersOnly, ['voice message'], 'reminders only');
    const none = renderAgenda('ru', empty, { hints: { reminders: false, voiceEvents: false } });
    assertHas(textOf(none), ['Ничего не запланировано'], 'no hints');
    assert(!markup(none).includes('ch-empty-hint'), 'no hint at all when the plan allows neither');
    assertHas(textOf(renderAgenda('he', empty)), ['אין אירועים', 'הודעה קולית', 'תזכיר לי'], 'he hints');
    // Connected to Google with no calendars chosen: the route answers ok with nothing (spec §2.5 step 2).
    const unchosen = model([ok(googleAnswer({ calendars: [] }))]);
    assert(unchosen.empty, 'to the model, an ok answer with nothing chosen is empty');
    const setup = renderAgenda('en', unchosen, { setupNeeded: true });
    assertLacks(textOf(setup), ['Nothing planned', 'voice message', 'Remind me', 'Show next week', 'Today', 'Tomorrow'], 'setup');
    assert(!/ch-(?:fold|ghost|empty|day-head)/.test(markup(setup)), 'setup: no fold, no placeholder, no empty state, no day');
    assertLacks(textOf(renderAgenda('he', unchosen, { setupNeeded: true })), ['אין אירועים', 'היום'], 'he setup');
    assertLacks(textOf(renderAgenda('ru', unchosen, { setupNeeded: true })), ['Ничего не запланировано', 'Сегодня'], 'ru setup');
    const before = renderAgenda('en', null, { setupNeeded: true });
    assert(!before.includes('aria-busy') && !markup(before).includes('ch-ghost'), 'no placeholders before the answer either');
  });

  await check('#12 Hebrew dates show only when the route says so', () => {
    const off = model([ok(answer({ items: WEEK, hebrewDates: false }))]);
    for (const locale of LOCALES) {
      const html = markup(renderAgenda(locale, off));
      assert(!html.includes('ch-day-hebrew'), `${locale}: no Hebrew date`);
    }
    assertLacks(textOf(renderAgenda('en', off)), ['Cheshvan'], 'en off');
  });

  await check('#13 the item sheet (§7.5): title, time range, calendar, location, notes, who set it, the reminder\'s state; Google adds "Open in Google Calendar"', () => {
    const week = famcalWeek();
    const dentist = renderSheet('en', rowOf(week, 'famcal|dentist'));
    assert(/role="dialog" aria-modal="true" aria-label="Details"/.test(dentist), 'a modal dialog labelled Details');
    assertHas(
      textOf(dentist),
      [`Dentist ${ref.dayShort('en-GB', day(0))} 09:30 – 10:30`, 'Calendar Family', 'Location Clinic on Herzl St', 'Notes Bring the X-rays Ask about the night guard', 'Close'],
      'dentist',
    );
    assert(dentist.includes('class="ch-when-time" dir="ltr">09:30 – 10:30<'), 'the time range is dir="ltr"');
    assert(dentist.includes('Bring the X-rays\nAsk about the night guard'), 'the notes keep their line break');
    assertLacks(textOf(dentist), ['Open in Google Calendar', 'Reminder'], 'dentist');
    assertHas(textOf(renderSheet('en', rowOf(week, 'famcal|vitamins'))), ['Reminder · Every day', 'Done at 08:10'], 'done today');
    assertHas(textOf(renderSheet('en', rowOf(week, 'famcal|vitamins'), day(1))), ['Done'], 'done another day');
    assertLacks(textOf(renderSheet('en', rowOf(week, 'famcal|vitamins'), day(1))), ['Done at'], 'done another day');
    assertHas(textOf(renderSheet('en', rowOf(week, 'famcal|snoozed'))), ['Snoozed until 15:30'], 'snoozed');
    assertHas(textOf(renderSheet('en', rowOf(week, 'famcal|form'))), ['Not done yet'], 'open');
    assertHas(textOf(renderSheet('ru', rowOf(week, 'famcal|challah'))), ['Время ещё не пришло', 'От: Noa'], 'later (ru)');
    assertHas(textOf(renderSheet('en', rowOf(week, 'famcal|for-noa'))), ['For Noa'], 'for the partner');
    assertHas(textOf(renderSheet('en', rowOf(week, 'famcal|concert'))), [`${ref.dayTime('en-GB', at(0, '22:00'))} – ${ref.dayTime('en-GB', at(1, '02:00'))}`], 'across midnight');
    assertHas(textOf(renderSheet('en', rowOf(week, 'famcal|trip'))), ['Tue 20 – Thu 22 Oct All day'], 'all-day, three days');
    assertHas(textOf(renderSheet('he', rowOf(week, 'famcal|dentist'))), ['יומן Family', 'מיקום Clinic on Herzl St', 'הערות', 'סגירה'], 'he sheet');
    const dinner = renderSheet('en', rowOf(googleWeek(), 'google|dinner'));
    assertHas(textOf(dinner), ['Calendar Google · Family', 'Open in Google Calendar'], 'Google sheet');
    assertLacks(dinner, [HTML_LINK], 'the link is opened through Telegram, never written into the page');
    assertHas(textOf(renderSheet('ru', rowOf(googleWeek(), 'google|dinner'))), ['Открыть в Google Календаре'], 'ru Google sheet');
    assertLacks(textOf(renderSheet('en', rowOf(googleWeek(), 'google|bday'))), ['Open in Google Calendar'], 'no link, no button');
  });

  await check('#14 accessibility in the markup: every tap a type="button", every icon hidden, no text under 11 px, no tap under 44 px, logical properties only, reduced motion; the colours fall back to globals.css\'s brand tokens, and the page root takes the theme\'s background', () => {
    const html = renderAgenda('en', famcalWeek()) + renderSheet('en', rowOf(famcalWeek(), 'famcal|dentist'));
    const buttons = html.match(/<button[^>]*>/g) ?? [];
    assert(buttons.length > 20 && buttons.every((b) => b.includes('type="button"')), `buttons: ${show(buttons.filter((b) => !b.includes('type="button"')))}`);
    const blocks = (html.match(/<button[^>]*>(?:(?!<\/button>)[\s\S])*<\/button>/g) ?? []).filter((b) => /<(?:div|p|h\d|ul|li|section|dl)[\s>]/.test(b));
    assert(blocks.length === 0, `block elements inside a button (only phrasing content is valid): ${show(blocks.slice(0, 2))}`);
    const svgs = html.match(/<svg[^>]*>/g) ?? [];
    assert(svgs.length > 5 && svgs.every((s) => s.includes('aria-hidden="true"')), 'icons are aria-hidden');
    const css = HOME_THEME_CSS + AGENDA_CSS;
    const sizes = [...css.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
    assert(sizes.length > 10 && Math.min(...sizes) >= 11, `font sizes: ${show(sizes)}`);
    assert(!/font-size:\s*[\d.]+(?:em|rem|%)|font:\s/.test(css), 'every font size in px (so the floor is checkable)');
    const rule = (selector: string) => {
      const m = new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(css);
      assert(m, `no rule ${selector}`);
      return m[1];
    };
    for (const selector of ['.ch-btn', '.ch-row', '.ch-more', '.ch-sheet-close', '.ch-sheet-action']) {
      const min = /min-height:\s*(\d+)px/.exec(rule(selector));
      assert(min && Number(min[1]) >= 44, `${selector} min-height ${min?.[1]}`);
    }
    assert(/min-width:\s*44px/.test(rule('.ch-btn')), '.ch-btn min-width 44px');
    const physical = css.match(/(?:margin|padding|border)-(?:left|right)|(?:^|[\s;{])(?:left|right)\s*:|text-align:\s*(?:left|right)|float:/g);
    assert(!physical, `physical properties: ${show(physical)}`);
    assert(/@media \(prefers-reduced-motion: reduce\)/.test(css), 'a reduced-motion rule');
    assert(!/:hover/.test(css), 'no hover styles');
    // §7.1 Look: Telegram's theme params over globals.css's tokens, so the brand palette lives in one place.
    const globals = fs.readFileSync(path.join(ROOT, 'app/globals.css'), 'utf8');
    const defined = new Set([...globals.matchAll(/^\s*(--[\w-]+):/gm)].map((m) => m[1]));
    const read = [...new Set([...HOME_THEME_CSS.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]))].filter((n) => !/^--(?:tg|ch)-/.test(n));
    assert(read.length >= 4 && read.every((n) => defined.has(n)), `the fallbacks read ${show(read)}, globals.css defines ${show(read.filter((n) => defined.has(n)))}`);
    for (const [token, brand] of [['--ch-bg', '--bg-white'], ['--ch-text', '--text-primary'], ['--ch-accent', '--brand-primary-dark'], ['--ch-button', '--brand-primary-dark']]) {
      assert(new RegExp(`${token}: var\\(--tg-theme-[\\w-]+, (?:var\\(--tg-theme-[\\w-]+, )?var\\(${brand}\\)\\)`).test(HOME_THEME_CSS), `${token} falls back to ${brand}`);
    }
    assert(/\.ch-home\[data-theme='dark'\] \{[^}]*--ch-button: var\(--tg-theme-button-color, var\(--brand-primary\)\);/.test(HOME_THEME_CSS), 'the dark button falls back to --brand-primary');
    // The home scrolls the document: the root behind an iOS bounce takes the theme's background.
    assert(/\nhtml:has\(\.ch-home\) \{\s*background-color: var\(--tg-theme-bg-color, var\(--bg-white\)\);\s*\}/.test(HOME_THEME_CSS), 'the root, light');
    assert(/\nhtml:has\(\.ch-home\[data-theme='dark'\]\) \{\s*background-color: var\(--tg-theme-bg-color, #15151d\);\s*color-scheme: dark;\s*\}/.test(HOME_THEME_CSS), 'the root, dark');
  });

  await check('#15 every date and time follows the route\'s timezone, never the device clock (the same markup in four process zones, Los Angeles included)', () => {
    // Child processes: Intl formatters take the process zone when they are built, and
    // the view caches them, so switching TZ inside this process would prove nothing.
    const outputs = new Map<string, string>();
    for (const zone of ['UTC', 'Asia/Jerusalem', 'Pacific/Kiritimati', 'America/Los_Angeles']) {
      const run = spawnSync(process.execPath, [nodeRequire.resolve('tsx/cli'), __filename], {
        cwd: ROOT,
        env: { ...process.env, TZ: zone, SMOKE_HOME_RENDER_DUMP: '1' },
        encoding: 'utf8',
        timeout: 120_000,
      });
      assert(run.status === 0 && /^\d+ [0-9a-f]{64} true\n$/.test(run.stdout), `the ${zone} run failed: ${show((run.stderr || run.stdout).slice(0, 300))}`);
      outputs.set(zone, run.stdout.trim());
    }
    const distinct = new Set(outputs.values());
    assert(distinct.size === 1, `the markup changed with the process zone: ${show([...outputs.entries()])}`);
  });

  // ---- Real React: taps, the sheet, focus ----

  installWindow();

  await check('#16 a tap selects the row through the container\'s onSelect and opens the sheet; closing hands back null and focus returns to the row; AgendaView never touches Telegram\'s BackButton (the container\'s one button)', () => {
    const tg = fakeTelegram();
    fakeWindow.Telegram = { WebApp: tg.webApp };
    const seen: (string | null)[] = [];
    const m = mount(interactive('en', famcalWeek(), { seen }));
    try {
      const dentist = button(m.container, 'Dentist');
      dentist.focus();
      m.click(dentist);
      assert(show(seen) === show(['famcal|dentist']), `onSelect: ${show(seen)}`);
      const dialogs = byRole(m.container, 'dialog');
      assert(dialogs.length === 1 && dialogs[0].getAttribute('aria-modal') === 'true', 'one modal dialog');
      assert(dialogs[0].textContent.includes('Clinic on Herzl St'), 'the dentist\'s details');
      assert(fakeDocument.activeElement === dialogs[0], 'focus moved into the sheet');
      m.click(button(dialogs[0], 'Close'));
      assert(show(seen) === show(['famcal|dentist', null]), `closing: ${show(seen)}`);
      assert(byRole(m.container, 'dialog').length === 0, 'the sheet closed');
      assert(fakeDocument.activeElement === dentist, 'focus is back on the row');
      assert(!tg.calls.some((c) => c.startsWith('BackButton')), `AgendaView made BackButton calls: ${show(tg.calls)}`);
    } finally {
      m.unmount();
      fakeWindow.Telegram = undefined;
    }
  });

  await check('#17 in a browser, the Close button, Escape and a tap on the scrim each close the sheet', () => {
    fakeWindow.Telegram = undefined;
    const m = mount(interactive('he', famcalWeek()));
    try {
      m.click(button(m.container, 'Dentist'));
      assert(byRole(m.container, 'dialog').length === 1, 'open');
      m.click(button(byRole(m.container, 'dialog')[0], 'סגירה'));
      assert(byRole(m.container, 'dialog').length === 0, 'Close closed it');
      m.click(button(m.container, 'Football practice'));
      m.key(byRole(m.container, 'dialog')[0], 'Escape');
      assert(byRole(m.container, 'dialog').length === 0, 'Escape closed it');
      m.click(button(m.container, 'Send the school form'));
      const scrim = byClass(m.container, 'ch-sheet-backdrop');
      assert(scrim.length === 1, 'a scrim');
      m.click(scrim[0]);
      assert(byRole(m.container, 'dialog').length === 0, 'the scrim closed it');
    } finally {
      m.unmount();
    }
  });

  await check('#18 "Open in Google Calendar" goes through Telegram\'s openLink; outside Telegram, a new tab', () => {
    const tg = fakeTelegram();
    fakeWindow.Telegram = { WebApp: tg.webApp };
    const m = mount(interactive('en', googleWeek()));
    try {
      m.click(button(m.container, 'Dinner with the Cohens'));
      m.click(button(byRole(m.container, 'dialog')[0], 'Open in Google Calendar'));
      assert(tg.calls.includes(`openLink(${HTML_LINK})`), `calls: ${show(tg.calls)}`);
    } finally {
      m.unmount();
      fakeWindow.Telegram = undefined;
    }
    const b = mount(interactive('en', googleWeek()));
    try {
      b.click(button(b.container, 'Yoga'));
      b.click(button(byRole(b.container, 'dialog')[0], 'Open in Google Calendar'));
      assert(show(openedWindows) === show(['https://www.google.com/calendar/event?eid=eW9nYQ']), `window.open: ${show(openedWindows)}`);
    } finally {
      b.unmount();
    }
  });

  await check('#19 the buttons call the container: Show next week, Retry with its source, Choose again; "N more" opens the rest of the card', () => {
    const calls: string[] = [];
    const props = {
      onShowNextWeek: () => calls.push('nextWeek'),
      onRetry: (s: string) => calls.push(`retry:${s}`),
      onChooseCalendars: () => calls.push('choose'),
    };
    const extra = ['a', 'b', 'c', 'd'].map((k, i) =>
      item(`old-${k}`, { kind: 'reminder', title: `Old reminder ${k}`, start: at(-3 - i, '09:00'), reminder: rem({ open: true, openSince: day(-3 - i) }) }),
    );
    const famcalError = model([ok(answer({ sources: { famcal: { status: 'error' } }, partner: null, calendars: [] }))]);
    const m = mount(interactive('en', famcalError, props));
    try {
      m.click(button(m.container, 'Retry'));
      m.click(button(m.container, 'Show next week'));
    } finally {
      m.unmount();
    }
    const gone = model([ok(googleAnswer({ sources: { google: { status: 'error', reason: 'calendars_gone' } }, calendars: [] }))]);
    const g = mount(interactive('en', gone, props));
    try {
      g.click(button(g.container, 'Choose again'));
    } finally {
      g.unmount();
    }
    const partial = model([ok(googleAnswer({ items: { [day(0)]: [DINNER] }, sources: { google: { status: 'ok', partial: { failed: 0, truncated: 1 } } } }))]);
    const p = mount(interactive('en', partial, props));
    try {
      p.click(button(p.container, 'Retry'));
    } finally {
      p.unmount();
    }
    assert(show(calls) === show(['retry:famcal', 'nextWeek', 'choose', 'retry:google']), `calls: ${show(calls)}`);

    const seven = model([ok(answer({ items: WEEK, carryOvers: [CARRY_PLUMBER, CARRY_BILL, ...extra] }))]);
    assert(seven.stillOpen?.shown.length === 5 && seven.stillOpen.more.length === 3, 'the fixture has 8 open');
    const c = mount(interactive('ru', seven));
    try {
      const card = byClass(c.container, 'ch-card')[0];
      assert(byClass(card, 'ch-row-li').length === 5, '5 shown');
      const more = button(card, 'Ещё 3');
      assert(more.getAttribute('aria-expanded') === 'false', 'aria-expanded');
      c.click(more);
      assert(byClass(card, 'ch-row-li').length === 8, `all 8 after "Ещё 3": ${byClass(card, 'ch-row-li').length}`);
      assert(!card.textContent.includes('Ещё 3'), 'the button is gone');
    } finally {
      c.unmount();
    }
  });

  await check('#20 an open sheet shows the latest copy of its item after a refetch; with no model (a store drop) there is no sheet, whatever the container still holds', () => {
    const week = famcalWeek();
    const form = rowOf(week, 'famcal|form');
    const view = (agenda: AgendaModel | null) => inHome('en', createElement(AgendaView, agendaProps(agenda, { selected: form })));
    const m = mount(view(week));
    try {
      assert(byRole(m.container, 'dialog')[0]?.textContent.includes('Not done yet'), 'open: not done yet');
      // A foreground refetch: the partner ticked it off meanwhile.
      const done = item('form', { ...FORM, reminder: rem({ done: true, doneAt: at(0, '13:20') }) });
      m.render(view(model([ok(answer({ items: { ...WEEK, [day(0)]: [VITAMINS, DENTIST, done, SNOOZED, FOOTBALL, CONCERT] } }))])));
      assert(byRole(m.container, 'dialog')[0]?.textContent.includes('Done at 13:20'), `after the refetch: ${show(byRole(m.container, 'dialog')[0]?.textContent)}`);
      // Midnight, or other facts: the store drops and the model is null until the next answer.
      m.render(view(null));
      assert(byRole(m.container, 'dialog').length === 0, 'no model, no sheet');
    } finally {
      m.unmount();
    }
  });

  await check('#21 React logged no warning in any render (keys, nesting, attributes)', () => {
    assert(reactWarnings.length === 0, `warnings: ${show(reactWarnings.slice(0, 5))}`);
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
  process.stdout.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
```

- [ ] **Step 2: Run it and see it fail; record the regression smokes' baseline**

```bash
cd /Users/razielgershoni/development/famcalbot
for tz in UTC Asia/Jerusalem Pacific/Kiritimati; do
  eval "env TZ=$tz $E npx tsx scripts/smoke-calendar-home-render.ts" > /tmp/d5-render-before.log 2>&1; echo "TZ=$tz exit $?"; grep -m1 'Cannot find module' /tmp/d5-render-before.log
done
npx tsc --noEmit -p . 2>&1 | grep 'error TS'
for f in smoke-initdata-header smoke-auth-leftovers smoke-miniapp-gate smoke-calendar-home-copy smoke-hebrew-date smoke-calendar-agenda smoke-telegram-ui smoke-command-client check-i18n-parity; do
  for tz in UTC Asia/Jerusalem; do
    eval "env TZ=$tz $E npx tsx scripts/$f.ts" > /tmp/d5-$f.log 2>&1; echo "$f TZ=$tz exit $?"
    grep -E '^(OK|FAIL)|passed|parity' /tmp/d5-$f.log > /tmp/d5-$f-${tz//\//_}.before; tail -1 /tmp/d5-$f-${tz//\//_}.before
  done
done
```

Expected for the new smoke, under each clock (tsx may also print `DEP0205` deprecation warnings on stderr; ignore them):
```
TZ=UTC exit 1
Error: Cannot find module '../app/[locale]/dashboard/AgendaView'
```
Expected from `tsc` (exit 2):
```
scripts/smoke-calendar-home-render.ts(41,62): error TS2307: Cannot find module '../app/[locale]/dashboard/AgendaView' or its corresponding type declarations.
scripts/smoke-calendar-home-render.ts(42,27): error TS2307: Cannot find module '../app/[locale]/dashboard/ItemSheet' or its corresponding type declarations.
scripts/smoke-calendar-home-render.ts(43,32): error TS2307: Cannot find module '../app/[locale]/dashboard/home-theme' or its corresponding type declarations.
scripts/smoke-calendar-home-render.ts(55,32): error TS2307: Cannot find module '../src/lib/calendar-view/home-props' or its corresponding type declarations.
scripts/smoke-calendar-home-render.ts(56,48): error TS2307: Cannot find module '../src/lib/calendar-view/format' or its corresponding type declarations.
```
Expected for the regression smokes, every run `exit 0`, with these last lines: `9/9 passed` (initdata-header), `9/9 passed` (auth-leftovers), `15/15 passed` (miniapp-gate), `14/14 passed` (home-copy), `14/14 passed (process TZ=…)` (hebrew-date), `33/33 passed (process TZ=…)` (agenda), `14/14 passed (process TZ=…)` (telegram-ui), `11/11 passed (process TZ=…)` (command-client), `i18n parity OK (996 keys)`. The `/tmp/d5-*.before` files are the baseline for Step 13.

- [ ] **Step 3: Create `src/lib/calendar-view/home-props.ts`**

The split's props contract, verbatim. D7's page-data and PageGate and D6's CalendarHome import it. Create the file with exactly this content:

```ts
// The calendar home's props: what the dashboard's page-data hands PageGate, and PageGate
// hands CalendarHome, when the rollout switch covers the user (Plan D). Type-only and
// client-safe: it imports nothing, so page-data, PageGate and the home's client bundle
// can all read it.

/**
 * Which ways of adding things this user can use, for the empty Agenda's hint (Ruling
 * R10). page-data computes them: `reminders` from getReminderSupport (a FamCal calendar,
 * Telegram and the native-reminders switch), `voiceEvents` from the voice_events feature.
 */
export type HomeHints = { reminders: boolean; voiceEvents: boolean };

export type CalendarHomeProps = {
  user: { id: number; name: string; isAdmin: boolean };
  locale: string;
  calendarSource: 'GOOGLE' | 'NATIVE';
  needsOAuth: boolean;
  needsCalendars: boolean;
  hints: HomeHints;
};
```

- [ ] **Step 4: Create `src/lib/calendar-view/format.ts`**

Create the file with exactly this content:

```ts
// Dates and times on the calendar home (spec §7.1 Times, §7.3). Intl only; client-safe
// and pure (it imports only the store's day arithmetic and the DTO types).
//
// - Times are in the viewer's timezone (the route's `tz`), 24-hour with two-digit hours
//   (hourCycle 'h23'): "09:30", never "9:30 AM".
// - A day key is a calendar day. It is formatted as UTC noon of that day in UTC, so the
//   device's clock can never move it to the day before or after.
// - English is day-first, as in the approved mockups ("Thu 15 Oct", "Thursday, 15 October").
// - Hebrew day labels name the weekday as the Hebrew mockup does, "חמישי 15 באוק׳", not
//   he-IL's short "יום ה׳, 15 באוק׳"; the long header keeps Intl's "יום חמישי, 15 באוקטובר".
// - A range of days in one month names the month once, as spec §7.3 and the mockups do:
//   "Sat 17 – Sun 18 Oct", "שבת 17 – ראשון 18 באוק׳", "сб, 17 – вс, 18 окт.".
// - Nothing here throws during a render: a bad value gives '' (or null), and a timezone
//   the device's Intl doesn't know falls back to the device's own zone.

import { addDaysToKey } from './store';
import type { DayKey, ItemDTO } from './types';

/** The weekday of a day key, as calendarHome.stillOpen.sinceWeekday's select names it. */
export type WeekdayId = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat';

const WEEKDAYS: readonly WeekdayId[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const INTL_LOCALES: Readonly<Record<string, string>> = { en: 'en-GB', he: 'he-IL', ru: 'ru-RU' };

/** The Intl locale for a page locale: en-GB (day-first English), he-IL, ru-RU; anything else reads English. */
export function intlLocale(locale: string): string {
  return INTL_LOCALES[locale] ?? INTL_LOCALES.en;
}

const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** UTC noon of a real 'yyyy-MM-dd' day, else null. */
function keyDate(day: DayKey): Date | null {
  const m = DAY_KEY.exec(day);
  if (!m) return null;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
  return date.toISOString().slice(0, 10) === day ? date : null;
}

function instant(value: string | null | undefined): Date | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t);
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** A cached formatter. A timezone the device's Intl rejects falls back to the device's zone. */
function formatter(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let f = formatters.get(key);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat(intlLocale(locale), options);
    } catch {
      const { timeZone: _ignored, ...rest } = options;
      f = new Intl.DateTimeFormat(intlLocale(locale), rest);
    }
    formatters.set(key, f);
  }
  return f;
}

const SHORT_DAY: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' };
const LONG_DAY: Intl.DateTimeFormatOptions = { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' };
const DAY_MONTH: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', timeZone: 'UTC' };

function timeOptions(tz: string): Intl.DateTimeFormatOptions {
  return { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz };
}

const isHebrew = (locale: string) => intlLocale(locale) === INTL_LOCALES.he;

/** A Hebrew weekday as the mockup's labels write it: the long name without "יום " ("חמישי", "שבת"). */
function hebrewWeekday(d: Date, timeZone: string): string {
  return formatter('he', { weekday: 'long', timeZone }).format(d).replace(/^יום\s+/, '');
}

/** "Thu 15 Oct" / "חמישי 15 באוק׳" / "чт, 15 окт.": the Agenda's day labels. */
export function formatDayShort(day: DayKey, locale: string): string {
  const d = keyDate(day);
  if (!d) return '';
  if (isHebrew(locale)) return `${hebrewWeekday(d, 'UTC')} ${formatter(locale, DAY_MONTH).format(d)}`;
  return formatter(locale, SHORT_DAY).format(d);
}

/** A day label without its month, for the first day of a range in one month: "Sat 17" / "שבת 17" / "сб, 17". */
function dayWithoutMonth(d: Date, locale: string): string {
  if (isHebrew(locale)) return `${hebrewWeekday(d, 'UTC')} ${d.getUTCDate()}`;
  const parts = formatter(locale, SHORT_DAY).formatToParts(d);
  const dayAt = parts.findIndex((p) => p.type === 'day');
  return dayAt < 0 ? formatter(locale, SHORT_DAY).format(d) : parts.slice(0, dayAt + 1).map((p) => p.value).join('');
}

/**
 * "Thursday, 15 October" / "יום חמישי, 15 באוקטובר" / "четверг, 15 октября": the home's header
 * (D6). en-GB writes no comma after the weekday; spec §7.2 and the mockups have one, as he-IL
 * and ru-RU do, so English gets it here.
 */
export function formatDayLong(day: DayKey, locale: string): string {
  const d = keyDate(day);
  if (!d) return '';
  const f = formatter(locale, LONG_DAY);
  if (intlLocale(locale) !== INTL_LOCALES.en) return f.format(d);
  return f
    .formatToParts(d)
    .map((part, i, parts) =>
      part.type === 'literal' && parts[i - 1]?.type === 'weekday' && !part.value.includes(',') ? `,${part.value}` : part.value
    )
    .join('');
}

/** "6 Oct" / "6 באוק׳" / "6 окт.": an older carry-over's "since". */
export function formatDayMonth(day: DayKey, locale: string): string {
  const d = keyDate(day);
  return d ? formatter(locale, DAY_MONTH).format(d) : '';
}

/**
 * One day, or `first` to `last`: "Sat 17 Oct"; "Sat 17 – Sun 18 Oct" in one month (spec
 * §7.3's fold line, "שבת 17 – ראשון 18 באוק׳", "сб, 17 – вс, 18 окт."); "Sat 31 Oct – Sun
 * 1 Nov" across months. The fold line's {range}, and the dates of a multi-day all-day item.
 */
export function formatDayRange(first: DayKey, last: DayKey, locale: string): string {
  const a = keyDate(first);
  const b = keyDate(last);
  if (!a) return '';
  if (!b || last <= first) return formatDayShort(first, locale);
  const start = first.slice(0, 7) === last.slice(0, 7) ? dayWithoutMonth(a, locale) : formatDayShort(first, locale);
  return `${start} – ${formatDayShort(last, locale)}`;
}

/** "09:30": an instant's time in `tz`; '' when the value isn't an instant. */
export function formatTime(value: string | null | undefined, tz: string, locale: string): string {
  const d = instant(value);
  return d ? formatter(locale, timeOptions(tz)).format(d) : '';
}

/** "Fri 02:00" / "שישי 02:00": an instant's weekday and time in `tz`, for an end or a snooze on another day. */
export function formatWeekdayTime(value: string | null | undefined, tz: string, locale: string): string {
  const d = instant(value);
  if (!d) return '';
  if (isHebrew(locale)) return `${hebrewWeekday(d, tz)} ${formatTime(value, tz, locale)}`;
  return formatter(locale, { weekday: 'short', ...timeOptions(tz) }).format(d);
}

/** "Thu 15 Oct, 22:00" / "חמישי 15 באוק׳, 22:00": an instant's day and time in `tz`, for a range across days. */
export function formatDayTime(value: string | null | undefined, tz: string, locale: string): string {
  const d = instant(value);
  if (!d) return '';
  const day = isHebrew(locale) ? instantDay(value, tz) : null;
  if (day) return `${formatDayShort(day, locale)}, ${formatTime(value, tz, locale)}`;
  return formatter(locale, { weekday: 'short', day: 'numeric', month: 'short', ...timeOptions(tz) }).format(d);
}

/** The day key an instant falls on in `tz`, or null when the value isn't an instant. */
export function instantDay(value: string | null | undefined, tz: string): DayKey | null {
  const d = instant(value);
  if (!d) return null;
  const parts = formatter('en', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: tz }).formatToParts(d);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  const key = `${part('year')}-${part('month')}-${part('day')}`;
  return DAY_KEY.test(key) ? key : null;
}

/** The weekday of a day key, or null for a key that isn't a real day. */
export function weekdayOf(day: DayKey): WeekdayId | null {
  const d = keyDate(day);
  return d ? WEEKDAYS[d.getUTCDay()] : null;
}

/** Whole calendar days from `from` to `to` (negative when `to` is earlier); NaN for a bad key. */
export function daysBetween(from: DayKey, to: DayKey): number {
  const a = keyDate(from);
  const b = keyDate(to);
  return a && b ? Math.round((b.getTime() - a.getTime()) / 86_400_000) : Number.NaN;
}

/** An all-day item's last day: its end date is exclusive; a missing or non-advancing end means one day (as daySpanOf). */
export function allDayLastDay(item: Pick<ItemDTO, 'start' | 'end'>): DayKey {
  return DAY_KEY.test(item.end) && item.end > item.start ? addDaysToKey(item.end, -1) : item.start;
}
```

- [ ] **Step 5: Create `app/[locale]/dashboard/home-theme.ts`**

Create the file with exactly this content:

```ts
// The calendar home's look (spec §7.1 Look, §7.7): the colour tokens, mapped onto
// Telegram's theme params with fallbacks, plus the pieces every part of the home shares
// (buttons, chips, the bottom sheet).
//
// The fallbacks: the brand colours are app/globals.css's own tokens (--bg-white,
// --text-primary, --brand-primary-dark, --brand-primary), so the palette lives in one
// place; the layout imports globals.css on every page. The neutral shades globals.css has
// no token for (the hint, surfaces, separators, the danger colour, the whole dark
// palette) are the approved mockups' and belong to the home alone.
//
// The home's root carries it (D6, CalendarHome):
//   <div className="ch-home" data-theme={useTelegramTheme()} dir={…}>
//     <style>{HOME_THEME_CSS}</style>
//     …
// Inside Telegram the SDK writes --tg-theme-* on <html>, so the tokens follow the
// user's Telegram theme, light or dark. In a browser there are no --tg-theme-* values,
// and the fallbacks follow data-theme (prefers-color-scheme).
//
// The page's root takes the same background while the home is mounted (html:has(.ch-home)):
// the home scrolls the document, and on iOS the bounce past either end shows the root,
// which globals.css leaves unpainted (white under a dark theme otherwise).
//
// Rules: nothing smaller than 11 px; every tap target at least 44 px; logical
// properties only, so RTL needs no overrides; no hover styles (touch only).

export const HOME_THEME_CSS = `
.ch-home {
  --ch-bg: var(--tg-theme-bg-color, var(--bg-white));
  --ch-text: var(--tg-theme-text-color, var(--text-primary));
  --ch-hint: var(--tg-theme-hint-color, #5e5e78);
  --ch-muted: var(--ch-hint);
  --ch-accent: var(--tg-theme-accent-text-color, var(--tg-theme-link-color, var(--brand-primary-dark)));
  --ch-surface: var(--tg-theme-secondary-bg-color, #f3f2f8);
  --ch-section: var(--tg-theme-section-bg-color, var(--tg-theme-bg-color, var(--bg-white)));
  --ch-separator: var(--tg-theme-section-separator-color, #eceaf3);
  --ch-button: var(--tg-theme-button-color, var(--brand-primary-dark));
  --ch-button-text: var(--tg-theme-button-text-color, var(--bg-white));
  --ch-danger: var(--tg-theme-destructive-text-color, #c62828);
  --ch-card: #f5f2ff;
  --ch-card-separator: #e4defa;
  --ch-done: #8a8aa0;
  --ch-chip-bg: #ffebd9;
  --ch-chip-text: #8a3d00;
  --ch-outline: #d4d2e0;
  --ch-scrim: rgba(18, 18, 32, 0.45);
  --ch-sheet-shadow: 0 -8px 24px rgba(18, 18, 32, 0.18);
  color-scheme: light;
  background: var(--ch-bg);
  color: var(--ch-text);
  font-family: system-ui, -apple-system, 'Segoe UI', Roboto, Heebo, Inter, sans-serif;
  font-size: 16px;
  line-height: 1.4;
  -webkit-text-size-adjust: 100%;
  text-size-adjust: 100%;
  -webkit-tap-highlight-color: transparent;
}
.ch-home[data-theme='dark'] {
  --ch-bg: var(--tg-theme-bg-color, #15151d);
  --ch-text: var(--tg-theme-text-color, #f1f0f7);
  --ch-hint: var(--tg-theme-hint-color, #a6a6be);
  --ch-accent: var(--tg-theme-accent-text-color, var(--tg-theme-link-color, #bba8ff));
  --ch-surface: var(--tg-theme-secondary-bg-color, #22222e);
  --ch-section: var(--tg-theme-section-bg-color, var(--tg-theme-bg-color, #1e1e29));
  --ch-separator: var(--tg-theme-section-separator-color, #2a2a38);
  --ch-button: var(--tg-theme-button-color, var(--brand-primary));
  --ch-danger: var(--tg-theme-destructive-text-color, #ff8a80);
  --ch-card: #221d3a;
  --ch-card-separator: #332b55;
  --ch-done: #7c7c94;
  --ch-chip-bg: #3d2715;
  --ch-chip-text: #ffc796;
  --ch-outline: #3e3e52;
  --ch-scrim: rgba(0, 0, 0, 0.6);
  --ch-sheet-shadow: 0 -8px 24px rgba(0, 0, 0, 0.5);
  color-scheme: dark;
}
@supports (color: color-mix(in srgb, red 50%, blue)) {
  .ch-home,
  .ch-home[data-theme='dark'] {
    /* A contrast floor over the theme's hint colour (§7.7): pulled a quarter towards the text. */
    --ch-muted: color-mix(in srgb, var(--ch-hint) 75%, var(--ch-text));
    --ch-card: color-mix(in srgb, var(--ch-accent) 8%, var(--ch-bg));
    --ch-card-separator: color-mix(in srgb, var(--ch-accent) 18%, var(--ch-bg));
    --ch-done: color-mix(in srgb, var(--ch-hint) 80%, var(--ch-bg));
    --ch-outline: color-mix(in srgb, var(--ch-hint) 45%, var(--ch-bg));
  }
}
html:has(.ch-home) {
  background-color: var(--tg-theme-bg-color, var(--bg-white));
}
html:has(.ch-home[data-theme='dark']) {
  background-color: var(--tg-theme-bg-color, #15151d);
  color-scheme: dark;
}
.ch-home *,
.ch-home *::before,
.ch-home *::after {
  box-sizing: border-box;
}
.ch-visually-hidden {
  position: absolute;
  inline-size: 1px;
  block-size: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}
.ch-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 44px;
  min-width: 44px;
  padding: 0 14px;
  border: 0;
  border-radius: 12px;
  background: var(--ch-surface);
  color: var(--ch-accent);
  font-family: inherit;
  font-size: 15px;
  font-weight: 500;
  line-height: 1.2;
  text-align: center;
  cursor: pointer;
  touch-action: manipulation;
}
.ch-btn:focus-visible,
.ch-tap:focus-visible {
  outline: 2px solid var(--ch-accent);
  outline-offset: 2px;
}
.ch-btn-primary {
  background: var(--ch-button);
  color: var(--ch-button-text);
}
.ch-chip {
  display: inline-block;
  max-inline-size: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border-radius: 6px;
  padding: 1px 7px;
  font-size: 12px;
  font-weight: 500;
  line-height: 18px;
  background: var(--ch-chip-bg);
  color: var(--ch-chip-text);
}
.ch-chip-outline {
  background: transparent;
  color: var(--ch-muted);
  border: 1px solid var(--ch-outline);
  padding: 0 6px;
  font-weight: 400;
}
.ch-sheet-layer {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
}
.ch-sheet-backdrop {
  position: absolute;
  inset: 0;
  background: var(--ch-scrim);
  touch-action: none;
}
.ch-sheet {
  position: relative;
  max-block-size: 88vh;
  overflow-y: auto;
  overscroll-behavior: contain;
  background: var(--ch-section);
  color: var(--ch-text);
  border-start-start-radius: 20px;
  border-start-end-radius: 20px;
  box-shadow: var(--ch-sheet-shadow);
  padding: 8px 16px calc(16px + max(env(safe-area-inset-bottom, 0px), var(--tg-safe-area-inset-bottom, 0px)));
  animation: ch-sheet-in 180ms ease-out;
  outline: none;
}
.ch-sheet-grab {
  inline-size: 40px;
  block-size: 5px;
  border-radius: 3px;
  background: var(--ch-outline);
  margin: 2px auto 14px;
}
.ch-sheet-close {
  display: flex;
  inline-size: 100%;
  min-height: 48px;
  margin-block-start: 16px;
  color: var(--ch-text);
}
@keyframes ch-sheet-in {
  from { transform: translateY(24px); opacity: 0; }
  to { transform: none; opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .ch-home *,
  .ch-home *::before,
  .ch-home *::after {
    animation: none !important;
    transition: none !important;
    scroll-behavior: auto !important;
  }
}
`;
```

- [ ] **Step 6: Create `app/[locale]/dashboard/BottomSheet.tsx`**

Create the file with exactly this content:

```tsx
'use client';

// The home's bottom sheet (the approved mockups' sheet): a scrim, a panel from the
// bottom with a grab bar, and a Close button at its end, which is the browser's stand-in
// for Telegram's BackButton. Used by the item sheet (D5); D6's send sheet and menu can
// use it too. It doesn't touch Telegram's BackButton itself: one owner decides what that
// button does (the container, CalendarHome).
//
// - A dialog (role="dialog", aria-modal) with its own label. Focus moves into the panel
//   when it opens and back to whatever had it (the tapped row) when it closes.
// - Escape, a tap on the scrim and the Close button all call onClose.
// - Rendered in place, not in a portal, so it inherits the home's tokens and direction.
//   It is position: fixed: no ancestor of the home may set transform or filter.

import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';

export interface BottomSheetProps {
  /** The dialog's accessible name. */
  label: string;
  /** The Close button's text. */
  closeLabel: string;
  onClose: () => void;
  children: ReactNode;
}

type Focusable = { focus?: (options?: { preventScroll?: boolean }) => void };

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
  };

  return (
    <div className="ch-sheet-layer">
      <div className="ch-sheet-backdrop" aria-hidden="true" onClick={onClose} />
      <div ref={panel} className="ch-sheet" role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} onKeyDown={onKeyDown}>
        <div className="ch-sheet-grab" aria-hidden="true" />
        {children}
        <button type="button" className="ch-btn ch-sheet-close" onClick={onClose}>
          {closeLabel}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 7: Create `app/[locale]/dashboard/ItemRow.tsx`**

Create the file with exactly this content:

```tsx
'use client';

// One Agenda row (spec §7.3): the time or "All day", the title, and a meta line (the
// span, the reminder's kind and state, the location or note, the person chip, and
// "Google · <calendar>" for Google items). A tap opens the item sheet.
//
// - Times are in the route's tz, 24-hour, and set dir="ltr"; titles and names are
//   isolated (dir="auto" / <bdi>), so Hebrew and English mix cleanly.
// - Reminder state is an icon plus text, never colour alone: an open circle and "Open";
//   a check, the title struck through and "done"; an open circle and an "until <time>"
//   badge while snoozed; a bell for later ones.
// - The person chip carries the partner's name (Ruling R7): "From Noa", "For Noa", or
//   the bare name on a partner's event. Calendar ids never reach the markup.

import { Fragment } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import type { AgendaRow, ReminderMark, Whose } from '@/src/lib/calendar-view/agenda';
import type { DayKey, ItemDTO } from '@/src/lib/calendar-view/types';
import { allDayLastDay, formatDayShort, formatTime, formatWeekdayTime, instantDay } from '@/src/lib/calendar-view/format';

export interface ItemRowProps {
  row: AgendaRow;
  /** The day the row is listed on (its span and times are read for this day). */
  day: DayKey;
  tz: string;
  onOpen: (row: AgendaRow) => void;
}

/** The reminder's icon (decorative: the state is also in text beside it). */
export function ReminderIcon({ mark }: { mark: ReminderMark }) {
  if (mark === 'done') {
    return (
      <svg className="ch-icon ch-icon-done" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
        <circle cx="12" cy="12" r="9" />
        <path d="M8 12.5l2.5 2.5L16 9.5" />
      </svg>
    );
  }
  if (mark === 'later') {
    return (
      <svg className="ch-icon ch-icon-later" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
        <path d="M6 9a6 6 0 1 1 12 0c0 5 2 6.5 2 6.5H4S6 14 6 9" />
        <path d="M10 19a2 2 0 0 0 4 0" />
      </svg>
    );
  }
  // open and snoozed: an open circle (a snoozed one adds its "until" badge in the meta line)
  return (
    <svg className="ch-icon ch-icon-open" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="9" />
    </svg>
  );
}

/** The person chip's text, or null for the viewer's own item. */
export function usePersonText(whose: Whose): string | null {
  const t = useTranslations('calendarHome');
  if (!whose.person) return null;
  if (whose.relation === 'from') return t('person.from', { name: whose.person });
  if (whose.relation === 'for') return t('person.for', { name: whose.person });
  return whose.person;
}

export function PersonChip({ whose }: { whose: Whose }) {
  const text = usePersonText(whose);
  if (!text) return null;
  return (
    <span className="ch-chip" dir="auto">
      {text}
    </span>
  );
}

/** The item's title, or "(No title)". */
export function useItemTitle(item: ItemDTO): string {
  const t = useTranslations('calendarHome');
  return item.title && item.title.trim() !== '' ? item.title : t('row.noTitle');
}

/** The first non-empty line of a plain-text description. */
function firstLine(text: string | null): string | null {
  if (!text) return null;
  const line = text.split('\n').find((l) => l.trim() !== '');
  return line ? line.trim() : null;
}

/** A snooze or an end shown on `day`: its time, or its weekday and time when it falls on another day. */
function timeOn(value: string | null, day: DayKey, tz: string, locale: string): string {
  return instantDay(value, tz) === day ? formatTime(value, tz, locale) : formatWeekdayTime(value, tz, locale);
}

export function ItemRow({ row, day, tz, onOpen }: ItemRowProps) {
  const t = useTranslations('calendarHome');
  const locale = useLocale();
  const { item, whose, mark } = row;
  const title = useItemTitle(item);

  // The time column: what happens on this day.
  let main: string;
  let mainIsTime = false;
  let sub: string | null = null;
  if (item.allDay || item.span === 'spansDay') {
    main = t('row.allDay');
  } else if (item.span === 'continues') {
    main = t('row.until', { when: formatTime(item.end, tz, locale) });
  } else {
    main = formatTime(item.start, tz, locale);
    mainIsTime = true;
    if (item.span !== 'endsLater' && Date.parse(item.end) > Date.parse(item.start)) sub = formatTime(item.end, tz, locale);
  }

  // The meta line's text, joined with " · ".
  const segments: { text: string; user?: boolean }[] = [];
  if (item.span === 'endsLater') {
    const when = item.allDay ? formatDayShort(allDayLastDay(item), locale) : timeOn(item.end, day, tz, locale);
    segments.push({ text: t('row.until', { when }) });
  } else if (item.span === 'spansDay') {
    segments.push({ text: t('row.continues') });
  }
  if (item.kind === 'reminder') {
    segments.push({ text: t('row.reminder') });
    if (mark === 'done') segments.push({ text: t('row.done') });
    if (item.repeatsDaily) segments.push({ text: t('row.everyDay') });
    else if (item.recurring) segments.push({ text: t('row.repeats') });
  }
  if (item.birthday) segments.push({ text: t('row.birthday') });
  const note = item.location && item.location.trim() !== '' ? item.location.trim() : firstLine(item.description);
  if (note) segments.push({ text: note, user: true });

  const snoozeTime = mark === 'snoozed' ? timeOn(item.reminder?.snoozedUntil ?? null, day, tz, locale) : '';
  const hasMeta = mark === 'open' || segments.length > 0 || !!snoozeTime || !!whose.person || item.source === 'google';

  return (
    <li className="ch-row-li">
      <button type="button" className={`ch-row ch-tap${mark === 'done' ? ' is-done' : ''}`} onClick={() => onOpen(row)}>
        <span className="ch-time">
          <span className="ch-time-main" dir={mainIsTime ? 'ltr' : undefined}>
            {main}
          </span>
          {sub ? (
            <span className="ch-time-sub" dir="ltr">
              {sub}
            </span>
          ) : null}
        </span>
        <span className="ch-body">
          <span className="ch-title-line">
            {mark ? <ReminderIcon mark={mark} /> : null}
            <span className="ch-title" dir="auto">
              {title}
            </span>
          </span>
          {hasMeta ? (
            <span className={`ch-meta${mark ? ' ch-indent' : ''}`}>
              {mark === 'open' ? <span className="ch-open">{t('row.open')}</span> : null}
              {segments.length > 0 ? (
                <span className="ch-meta-text">
                  {segments.map((s, i) => (
                    <Fragment key={i}>
                      {i > 0 ? ' · ' : null}
                      {s.user ? <bdi>{s.text}</bdi> : s.text}
                    </Fragment>
                  ))}
                </span>
              ) : null}
              {snoozeTime ? (
                <>
                  <span className="ch-badge" aria-hidden="true">
                    {t('row.snoozedUntil', { time: snoozeTime })}
                  </span>
                  <span className="ch-visually-hidden">{t('row.snoozedLabel', { time: snoozeTime })}</span>
                </>
              ) : null}
              <PersonChip whose={whose} />
              {item.source === 'google' ? (
                <span className="ch-chip ch-chip-outline" dir="auto">
                  {t('row.googleCalendar', { calendar: item.calendar.name })}
                </span>
              ) : null}
            </span>
          ) : null}
        </span>
      </button>
    </li>
  );
}
```

- [ ] **Step 8: Create `app/[locale]/dashboard/DayList.tsx`**

Create the file with exactly this content:

```tsx
'use client';

// The Agenda's days (spec §7.3, §5 "Empty means answered"; Ruling R8), in the order
// buildAgenda gives them:
// - a day: its header ("Today" / "Tomorrow" / the weekday and date, plus the Hebrew
//   date when it's on), then its rows. With no rows: "Nothing planned" once every
//   source answered; placeholders while one is still loading; nothing when it failed
//   (the state row above the days says why). A loading day with rows adds a placeholder.
// - a fold: later empty days, answered, in one line ("Nothing planned Sat 17 – Sun 18 Oct").

import { useLocale, useTranslations } from 'next-intl';
import type { AgendaDay, AgendaEntry, AgendaRow } from '@/src/lib/calendar-view/agenda';
import { formatDayRange, formatDayShort } from '@/src/lib/calendar-view/format';
import { hebrewDayLabel } from '@/src/lib/calendar-view/hebrew-date';
import { ItemRow } from './ItemRow';

export interface DayListProps {
  entries: AgendaEntry[];
  tz: string;
  hebrewDates: boolean;
  onOpen: (row: AgendaRow) => void;
}

/** Grey rows that stand in for a day's items until its sources answer. */
export function PlaceholderRows({ count }: { count: number }) {
  return (
    <div className="ch-ghosts" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="ch-ghost" />
      ))}
    </div>
  );
}

/** The Hebrew-date settings a day header reads: on or off, and Russian's genitive month names (Ruling R9). */
type HebrewDates = { on: boolean; genitive?: readonly string[] };

function DayHeader({ day, hebrew }: { day: AgendaDay; hebrew: HebrewDates }) {
  const t = useTranslations('calendarHome');
  const locale = useLocale();
  const date = formatDayShort(day.date, locale);
  const hebrewLabel = hebrew.on ? hebrewDayLabel(day.date, locale, hebrew.genitive) : '';
  const relative = day.relative === 'today' ? t('agenda.today') : day.relative === 'tomorrow' ? t('agenda.tomorrow') : null;
  return (
    <h2 className="ch-day-head" id={`ch-day-${day.date}`}>
      <span className="ch-day-label">{relative ?? date}</span>
      {relative ? (
        <>
          {' '}
          <span className="ch-day-date">{date}</span>
        </>
      ) : null}
      {hebrewLabel ? (
        <>
          {' '}
          <span className="ch-day-hebrew">{hebrewLabel}</span>
        </>
      ) : null}
    </h2>
  );
}

function Day({ day, tz, hebrew, onOpen }: { day: AgendaDay; tz: string; hebrew: HebrewDates; onOpen: DayListProps['onOpen'] }) {
  const t = useTranslations('calendarHome');
  const loading = day.status === 'loading';
  return (
    <section className="ch-day" aria-labelledby={`ch-day-${day.date}`} aria-busy={loading || undefined}>
      <DayHeader day={day} hebrew={hebrew} />
      {day.rows.length > 0 ? (
        <ul className="ch-list" role="list">
          {day.rows.map((row) => (
            <ItemRow key={row.item.key} row={row} day={day.date} tz={tz} onOpen={onOpen} />
          ))}
        </ul>
      ) : null}
      {day.rows.length === 0 && day.status === 'answered' ? <p className="ch-nothing">{t('agenda.nothingPlanned')}</p> : null}
      {loading ? <PlaceholderRows count={day.rows.length > 0 ? 1 : 2} /> : null}
    </section>
  );
}

export function DayList({ entries, tz, hebrewDates, onOpen }: DayListProps) {
  const t = useTranslations('calendarHome');
  const locale = useLocale();
  // calendarHome.hebrewMonthGenitive: 14 names in D2's HEBREW_MONTHS order; only Russian reads them.
  const hebrew: HebrewDates = {
    on: hebrewDates,
    genitive: hebrewDates && locale === 'ru' ? (t.raw('hebrewMonthGenitive') as string[]) : undefined,
  };
  return (
    <div className="ch-days">
      {entries.map((entry) =>
        entry.type === 'fold' ? (
          <p key={`fold-${entry.first}`} className="ch-fold">
            {t('agenda.nothingPlannedRange', { range: formatDayRange(entry.first, entry.last, locale) })}
          </p>
        ) : (
          <Day key={entry.date} day={entry} tz={tz} hebrew={hebrew} onOpen={onOpen} />
        ),
      )}
    </div>
  );
}
```

- [ ] **Step 9: Create `app/[locale]/dashboard/StillOpenCard.tsx`**

Create the file with exactly this content:

```tsx
'use client';

// The "Still open" card (spec §7.3): today's past-due reminders and the carry-overs, as
// buildAgenda orders them. It shows 5, then "N more", which opens the rest in place. Each
// row says since when it is open, and who set it when that wasn't the viewer ("From
// Noa"), or whom the viewer set it for ("For Noa"). A tap opens the item sheet.

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import type { AgendaRow, StillOpenCard as StillOpenModel, StillOpenRow } from '@/src/lib/calendar-view/agenda';
import type { DayKey } from '@/src/lib/calendar-view/types';
import { daysBetween, formatDayMonth, formatTime, weekdayOf } from '@/src/lib/calendar-view/format';
import { PersonChip, ReminderIcon, useItemTitle } from './ItemRow';

export interface StillOpenCardProps {
  card: StillOpenModel;
  today: DayKey;
  tz: string;
  onOpen: (row: AgendaRow) => void;
}

/** "Since 13:00" (today's), "Since yesterday", "Since Tuesday" (2–6 days), "Since 6 Oct" (older). */
function useSinceText(row: StillOpenRow, today: DayKey, tz: string): string {
  const t = useTranslations('calendarHome');
  const locale = useLocale();
  if (!row.carriedOver) {
    return row.item.allDay ? t('agenda.today') : t('stillOpen.sinceTime', { time: formatTime(row.item.start, tz, locale) });
  }
  const ago = daysBetween(row.since, today);
  if (ago === 1) return t('stillOpen.sinceYesterday');
  const weekday = weekdayOf(row.since);
  if (ago >= 2 && ago <= 6 && weekday) return t('stillOpen.sinceWeekday', { weekday });
  return t('stillOpen.sinceDate', { date: formatDayMonth(row.since, locale) });
}

function OpenRow({ row, today, tz, onOpen }: { row: StillOpenRow } & Omit<StillOpenCardProps, 'card'>) {
  const title = useItemTitle(row.item);
  const since = useSinceText(row, today, tz);
  const mark = row.mark ?? 'open';
  return (
    <li className="ch-row-li">
      <button type="button" className="ch-row ch-tap ch-row-open" onClick={() => onOpen(row)}>
        <span className="ch-body">
          <span className="ch-title-line">
            <ReminderIcon mark={mark} />
            <span className="ch-title" dir="auto">
              {title}
            </span>
          </span>
          <span className="ch-meta ch-indent">
            <span className="ch-meta-text">{since}</span>
            <PersonChip whose={row.whose} />
          </span>
        </span>
      </button>
    </li>
  );
}

export function StillOpenCard({ card, today, tz, onOpen }: StillOpenCardProps) {
  const t = useTranslations('calendarHome');
  const [expanded, setExpanded] = useState(false);
  const rows = expanded ? [...card.shown, ...card.more] : card.shown;
  const total = card.shown.length + card.more.length;
  return (
    <section className="ch-card" aria-labelledby="ch-still-open">
      <div className="ch-card-head">
        <h2 id="ch-still-open" className="ch-card-title">
          {t('stillOpen.title')}
        </h2>
        <span className="ch-card-count">{t('stillOpen.count', { count: total })}</span>
      </div>
      <ul className="ch-list" role="list">
        {rows.map((row) => (
          <OpenRow key={row.item.key} row={row} today={today} tz={tz} onOpen={onOpen} />
        ))}
      </ul>
      {!expanded && card.more.length > 0 ? (
        <button type="button" className="ch-btn ch-card-more" aria-expanded="false" onClick={() => setExpanded(true)}>
          {t('stillOpen.more', { count: card.more.length })}
        </button>
      ) : null}
    </section>
  );
}
```

- [ ] **Step 10: Create `app/[locale]/dashboard/ItemSheet.tsx`**

Create the file with exactly this content:

```tsx
'use client';

// An item's details (spec §7.5): a view-only bottom sheet with the title and time range,
// the calendar (masked for a partner's private calendar), the location, the description
// as plain text, whose it is or who set it, and the reminder's state. Google items add
// "Open in Google Calendar" (Telegram's openLink, through D4's openExternalLink).
//
// Telegram's BackButton closes it: the container owns the button (useTelegramBackButton)
// and the selection, so this sheet only renders. In a browser, the Close button, a tap on
// the scrim and Escape do the same.

import { useLocale, useTranslations } from 'next-intl';
import type { AgendaRow } from '@/src/lib/calendar-view/agenda';
import type { DayKey, ItemDTO } from '@/src/lib/calendar-view/types';
import {
  allDayLastDay,
  formatDayRange,
  formatDayShort,
  formatDayTime,
  formatTime,
  formatWeekdayTime,
  instantDay,
} from '@/src/lib/calendar-view/format';
import { openExternalLink } from '@/src/lib/telegram-ui';
import { BottomSheet } from './BottomSheet';
import { PersonChip, ReminderIcon, useItemTitle } from './ItemRow';

/** A calendar's colour is only an accent (Ruling R7), and only a plain hex one is drawn. */
const HEX_COLOUR = /^#[0-9a-f]{3,8}$/i;

export interface ItemSheetProps {
  row: AgendaRow;
  today: DayKey;
  tz: string;
  onClose: () => void;
}

/** When it happens: a date line, and a time line for a timed item that starts and ends on one day. */
function When({ item, tz }: { item: ItemDTO; tz: string }) {
  const t = useTranslations('calendarHome');
  const locale = useLocale();
  if (item.allDay) {
    return (
      <p className="ch-when">
        <span className="ch-when-date">{formatDayRange(item.start, allDayLastDay(item), locale)}</span>
        <span className="ch-when-time">{t('row.allDay')}</span>
      </p>
    );
  }
  const startDay = instantDay(item.start, tz);
  const endDay = instantDay(item.end, tz);
  const hasEnd = Date.parse(item.end) > Date.parse(item.start);
  if (!hasEnd || startDay === endDay) {
    const range = hasEnd ? `${formatTime(item.start, tz, locale)} – ${formatTime(item.end, tz, locale)}` : formatTime(item.start, tz, locale);
    return (
      <p className="ch-when">
        <span className="ch-when-date">{startDay ? formatDayShort(startDay, locale) : ''}</span>
        <span className="ch-when-time" dir="ltr">
          {range}
        </span>
      </p>
    );
  }
  return (
    <p className="ch-when">
      <span className="ch-when-date">
        <bdi>{formatDayTime(item.start, tz, locale)}</bdi> – <bdi>{formatDayTime(item.end, tz, locale)}</bdi>
      </span>
    </p>
  );
}

/** The reminder's state, as text beside its icon. */
function useReminderState(item: ItemDTO, mark: AgendaRow['mark'], today: DayKey, tz: string): string | null {
  const t = useTranslations('calendarHome');
  const locale = useLocale();
  const r = item.reminder;
  if (!r || !mark) return null;
  const timeAround = (value: string | null) =>
    instantDay(value, tz) === today ? formatTime(value, tz, locale) : formatWeekdayTime(value, tz, locale);
  if (mark === 'done') {
    return r.doneAt && instantDay(r.doneAt, tz) === today ? t('sheet.stateDoneAt', { time: formatTime(r.doneAt, tz, locale) }) : t('sheet.stateDone');
  }
  if (mark === 'snoozed') return t('sheet.stateSnoozed', { time: timeAround(r.snoozedUntil) });
  if (mark === 'open') return t('sheet.stateOpen');
  return t('sheet.stateLater');
}

export function ItemSheet({ row, today, tz, onClose }: ItemSheetProps) {
  const t = useTranslations('calendarHome');
  const { item, whose, mark } = row;
  const title = useItemTitle(item);
  const state = useReminderState(item, mark, today, tz);

  const tags: string[] = [];
  if (item.kind === 'reminder') tags.push(t('row.reminder'));
  if (item.birthday) tags.push(t('row.birthday'));
  if (item.repeatsDaily) tags.push(t('sheet.everyDay'));
  else if (item.recurring) tags.push(t('sheet.repeats'));

  // A masked calendar (a partner's private one) has no id; the DTO puts the partner's name in its name.
  const calendarName =
    item.calendar.id === null
      ? t('sheet.partnerCalendar', { name: item.calendar.name })
      : item.source === 'google'
        ? t('row.googleCalendar', { calendar: item.calendar.name })
        : item.calendar.name;
  const location = item.location && item.location.trim() !== '' ? item.location.trim() : null;
  const notes = item.description && item.description.trim() !== '' ? item.description.trim() : null;
  const googleLink = item.source === 'google' && item.htmlLink ? item.htmlLink : null;
  const swatch = item.calendar.color && HEX_COLOUR.test(item.calendar.color) ? item.calendar.color : null;

  return (
    <BottomSheet label={t('sheet.label')} closeLabel={t('actions.close')} onClose={onClose}>
      <div className={`ch-sheet-head${mark === 'done' ? ' is-done' : ''}`}>
        {mark ? <ReminderIcon mark={mark} /> : null}
        <h2 className="ch-sheet-title" dir="auto">
          {title}
        </h2>
      </div>
      <When item={item} tz={tz} />
      {tags.length > 0 || whose.person ? (
        <p className="ch-sheet-tags">
          {tags.length > 0 ? <span>{tags.join(' · ')}</span> : null}
          <PersonChip whose={whose} />
        </p>
      ) : null}
      {state ? <p className="ch-sheet-state">{state}</p> : null}
      <dl className="ch-facts">
        <div className="ch-fact">
          <dt>{t('sheet.calendar')}</dt>
          <dd>
            {swatch ? <span className="ch-swatch" style={{ background: swatch }} aria-hidden="true" /> : null}
            <bdi>{calendarName}</bdi>
          </dd>
        </div>
        {location ? (
          <div className="ch-fact">
            <dt>{t('sheet.location')}</dt>
            <dd>
              <bdi>{location}</bdi>
            </dd>
          </div>
        ) : null}
        {notes ? (
          <div className="ch-fact">
            <dt>{t('sheet.notes')}</dt>
            <dd className="ch-notes" dir="auto">
              {notes}
            </dd>
          </div>
        ) : null}
      </dl>
      {googleLink ? (
        <button type="button" className="ch-btn ch-btn-primary ch-sheet-action" onClick={() => openExternalLink(googleLink)}>
          {t('sheet.openInGoogle')}
        </button>
      ) : null}
    </BottomSheet>
  );
}
```

- [ ] **Step 11: Create `app/[locale]/dashboard/AgendaView.tsx`**

Create the file with exactly this content:

```tsx
'use client';

// The Agenda (spec §7.3, §5, §7.5, §7.7; Rulings R8 and R10): the whole calendar home in
// Plan D, under D6's header. Presentational: CalendarHome (D6) owns the store, the
// fetches and the number of weeks, builds the model with buildAgenda (D3) and hands it
// here. From top to bottom:
// - the state rows (§5 States): a source that failed with no earlier data, a partial
//   Google answer, chosen calendars that are gone; each with Retry or Choose again;
// - the "Still open" card;
// - the days and fold lines (DayList), or Ruling R10's empty state, with only the hints
//   this user's plan allows;
// - "Show next week", which adds 7 days (Ruling R8).
// Until the first answer (agenda null) it shows placeholders. A Google user who hasn't
// finished the setup (no connection, or no calendars chosen) gets none of it: HomeBanners'
// Connect or Choose card is the call to action, and an Agenda read with nothing chosen
// would only say "Nothing planned".
//
// A tap on any row opens the item sheet. The container holds the selection (`selected`,
// `onSelect`), because it owns the home's one Telegram BackButton (spec §7.6), which
// closes this sheet and the send and menu sheets alike. AgendaView never touches it.

import { useCallback } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import type { AgendaModel, AgendaRow } from '@/src/lib/calendar-view/agenda';
import type { HomeHints } from '@/src/lib/calendar-view/home-props';
import type { SourceName } from '@/src/lib/calendar-view/types';
import { DayList, PlaceholderRows } from './DayList';
import { ItemSheet } from './ItemSheet';
import { StillOpenCard } from './StillOpenCard';

export interface AgendaViewProps {
  /** buildAgenda(store, weeks); null until the first answer pins the facts (placeholders). */
  agenda: AgendaModel | null;
  /** CalendarHomeProps.hints: which ways of adding things the empty state may name (Ruling R10). */
  hints: HomeHints;
  /**
   * A Google user with no connection or no calendars chosen (needsOAuth, needsCalendars):
   * no days, no placeholders, no empty state, no fold and no "Show next week". The setup
   * banner above says what to do.
   */
  setupNeeded: boolean;
  /** The row whose item sheet is open, or null. The container holds it (its BackButton closes the sheet). */
  selected: AgendaRow | null;
  /** A tap on a row: open its sheet (the row), or close it (null). */
  onSelect: (row: AgendaRow | null) => void;
  /** "Show next week": the container adds a week and fetches agendaWeekWindow(today, weeks). */
  onShowNextWeek: () => void;
  /** Retry on a state row or the partial row: refetch that source's visible windows. */
  onRetry: (source: SourceName) => void;
  /** "Choose again" (calendars gone or unavailable): the existing select-calendars page. */
  onChooseCalendars: () => void;
}

function StateIcon() {
  return (
    <svg className="ch-icon ch-state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5.5M12 16.5v.01" />
    </svg>
  );
}

function StateRow({ text, action, onAction }: { text: string; action: string; onAction: () => void }) {
  return (
    <div className="ch-state" role="status">
      <StateIcon />
      <span className="ch-state-text">{text}</span>
      <button type="button" className="ch-btn ch-state-action" onClick={onAction}>
        {action}
      </button>
    </div>
  );
}

function StateRows({ agenda, onRetry, onChooseCalendars }: { agenda: AgendaModel } & Pick<AgendaViewProps, 'onRetry' | 'onChooseCalendars'>) {
  const t = useTranslations('calendarHome');
  const rows = agenda.stateRows.map(({ source, failure }) => {
    if (failure.kind === 'calendarsGone') {
      return <StateRow key="calendars-gone" text={t('state.calendarsGone')} action={t('actions.chooseAgain')} onAction={onChooseCalendars} />;
    }
    const text = failure.kind === 'busy' ? t('state.busy') : source === 'famcal' ? t('state.famcalError') : t('state.googleError');
    return <StateRow key={`${failure.kind}-${source}`} text={text} action={t('actions.retry')} onAction={() => onRetry(source)} />;
  });
  if (agenda.partial) {
    rows.push(<StateRow key="partial" text={t('state.partial')} action={t('actions.retry')} onAction={() => onRetry('google')} />);
  }
  if (agenda.unavailableCalendars > 0) {
    rows.push(
      <StateRow
        key="unavailable"
        text={t('state.unavailable', { count: agenda.unavailableCalendars })}
        action={t('actions.chooseAgain')}
        onAction={onChooseCalendars}
      />,
    );
  }
  return rows.length > 0 ? <div className="ch-states">{rows}</div> : null;
}

/** Ruling R10: "Nothing planned", and only the ways of adding things this user can use. */
function EmptyState({ hints }: { hints: HomeHints }) {
  const t = useTranslations('calendarHome');
  return (
    <div className="ch-empty">
      <svg className="ch-empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
        <rect x="3" y="5" width="18" height="16" rx="3" />
        <path d="M3 10h18M8 3v4M16 3v4" />
      </svg>
      <h2 className="ch-empty-title">{t('empty.title')}</h2>
      {hints.voiceEvents ? <p className="ch-empty-hint">{t('empty.hintEvents')}</p> : null}
      {hints.reminders ? <p className="ch-empty-hint">{t('empty.hintReminders')}</p> : null}
    </div>
  );
}

/** The open sheet's item as the latest model has it (a refetch may have changed it), else as it was tapped. */
function latestRow(agenda: AgendaModel, selected: AgendaRow): AgendaRow {
  for (const entry of agenda.entries) {
    if (entry.type !== 'day') continue;
    const row = entry.rows.find((r) => r.item.key === selected.item.key);
    if (row) return row;
  }
  const open = agenda.stillOpen ? [...agenda.stillOpen.shown, ...agenda.stillOpen.more] : [];
  return open.find((r) => r.item.key === selected.item.key) ?? selected;
}

/** Before the first answer: placeholders, never free days (§5 States). */
function AgendaLoading() {
  const t = useTranslations('calendarHome');
  return (
    <div className="ch-loading" role="status">
      <span className="ch-visually-hidden">{t('shell.loading')}</span>
      <div className="ch-ghost-head" aria-hidden="true" />
      <PlaceholderRows count={3} />
      <div className="ch-ghost-head" aria-hidden="true" />
      <PlaceholderRows count={2} />
    </div>
  );
}

export function AgendaView({ agenda, hints, setupNeeded, selected, onSelect, onShowNextWeek, onRetry, onChooseCalendars }: AgendaViewProps) {
  const t = useTranslations('calendarHome');
  const locale = useLocale();
  const openSheet = useCallback((row: AgendaRow) => onSelect(row), [onSelect]);
  const closeSheet = useCallback(() => onSelect(null), [onSelect]);
  // No model (before the first answer, or after a store drop): no sheet. The container
  // clears the selection on a drop, so the sheet doesn't open again by itself.
  const sheetRow = agenda && selected && !setupNeeded ? latestRow(agenda, selected) : null;

  return (
    <section className="ch-agenda" dir={locale === 'he' ? 'rtl' : 'ltr'} aria-busy={(agenda === null && !setupNeeded) || undefined}>
      <style>{AGENDA_CSS}</style>
      {setupNeeded ? null : agenda === null ? (
        <AgendaLoading />
      ) : (
        <>
          <StateRows agenda={agenda} onRetry={onRetry} onChooseCalendars={onChooseCalendars} />
          {agenda.stillOpen ? <StillOpenCard card={agenda.stillOpen} today={agenda.today} tz={agenda.tz} onOpen={openSheet} /> : null}
          {agenda.empty ? (
            <EmptyState hints={hints} />
          ) : (
            <DayList entries={agenda.entries} tz={agenda.tz} hebrewDates={agenda.hebrewDates} onOpen={openSheet} />
          )}
          <button type="button" className="ch-btn ch-more" onClick={onShowNextWeek}>
            {t('agenda.showNextWeek')}
          </button>
        </>
      )}
      {agenda && sheetRow ? <ItemSheet row={sheetRow} today={agenda.today} tz={agenda.tz} onClose={closeSheet} /> : null}
    </section>
  );
}

/**
 * The Agenda's own styles. They read the tokens HOME_THEME_CSS (./home-theme.ts) puts on
 * the home's root. Logical properties only; nothing under 11 px; taps at least 44 px.
 */
export const AGENDA_CSS = `
.ch-agenda {
  padding-block-end: calc(24px + max(env(safe-area-inset-bottom, 0px), var(--tg-safe-area-inset-bottom, 0px)));
}
.ch-states {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 12px 16px 0;
}
.ch-state {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 52px;
  padding-block: 4px;
  padding-inline: 12px 4px;
  border-radius: 12px;
  background: var(--ch-surface);
  font-size: 14px;
  line-height: 1.35;
}
.ch-state-icon {
  color: var(--ch-danger);
}
.ch-state-text {
  flex: 1;
  min-width: 0;
}
.ch-state-action {
  flex: none;
  background: transparent;
}
.ch-card {
  margin: 12px 16px 0;
  padding: 4px 14px;
  border-radius: 16px;
  background: var(--ch-card);
}
.ch-card-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
  padding: 10px 0 2px;
}
.ch-card-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}
.ch-card-count {
  font-size: 13px;
  color: var(--ch-muted);
}
.ch-card .ch-list {
  padding: 0;
}
.ch-card .ch-row-li {
  border-block-end: 1px solid var(--ch-card-separator);
}
.ch-card .ch-row-li:last-child {
  border-block-end: 0;
}
.ch-card-more {
  display: flex;
  inline-size: 100%;
  margin: 0 0 6px;
  background: transparent;
}
.ch-day-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0 8px;
  margin: 22px 16px 2px;
  font-size: 14px;
  font-weight: 400;
  line-height: 1.35;
}
.ch-day-label {
  font-weight: 600;
}
.ch-day-hebrew {
  color: var(--ch-muted);
}
.ch-list {
  list-style: none;
  margin: 0;
  padding: 0 16px;
}
.ch-row-li {
  border-block-end: 1px solid var(--ch-separator);
}
.ch-row {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 12px;
  inline-size: 100%;
  min-height: 44px;
  margin: 0;
  padding: 11px 0;
  border: 0;
  background: transparent;
  color: inherit;
  font-family: inherit;
  font-size: 16px;
  text-align: start;
  cursor: pointer;
  touch-action: manipulation;
}
.ch-time {
  flex: none;
  inline-size: 56px;
  font-size: 14px;
  line-height: 20px;
  font-variant-numeric: tabular-nums;
  overflow-wrap: break-word;
}
.ch-time-main,
.ch-time-sub {
  display: block;
}
.ch-time-sub {
  font-size: 13px;
  color: var(--ch-muted);
}
.ch-body {
  display: block;
  flex: 1;
  min-width: 0;
}
.ch-title-line {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.ch-icon {
  flex: none;
  inline-size: 20px;
  block-size: 20px;
}
.ch-icon-open {
  color: var(--ch-accent);
}
.ch-icon-done,
.ch-icon-later {
  color: var(--ch-muted);
}
.ch-title {
  display: block;
  min-width: 0;
  font-size: 16px;
  line-height: 20px;
  overflow-wrap: anywhere;
}
.is-done .ch-title,
.is-done .ch-sheet-title {
  color: var(--ch-done);
  text-decoration: line-through;
}
.ch-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 6px;
  margin-block-start: 3px;
  font-size: 13px;
  line-height: 18px;
  color: var(--ch-muted);
}
.ch-indent {
  padding-inline-start: 28px;
}
.ch-meta-text {
  min-width: 0;
  max-inline-size: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ch-open {
  color: var(--ch-accent);
  font-weight: 600;
}
.ch-badge {
  padding: 0 6px;
  border-radius: 6px;
  font-size: 12px;
  line-height: 18px;
  background: var(--ch-surface);
  color: var(--ch-text);
}
.ch-nothing {
  margin: 0 16px;
  padding: 10px 0;
  font-size: 14px;
  color: var(--ch-muted);
}
.ch-fold {
  margin: 18px 16px 0;
  padding: 12px 14px;
  border-radius: 12px;
  background: var(--ch-surface);
  font-size: 14px;
  color: var(--ch-muted);
}
.ch-ghosts {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px 16px 0;
}
.ch-ghost,
.ch-ghost-head {
  border-radius: 12px;
  background: var(--ch-surface);
  animation: ch-pulse 1.4s ease-in-out infinite;
}
.ch-ghost {
  block-size: 48px;
}
.ch-ghost-head {
  block-size: 18px;
  inline-size: 40%;
  margin: 22px 16px 0;
  border-radius: 6px;
}
@keyframes ch-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.55; }
}
.ch-empty {
  margin: 24px 16px 0;
  padding: 24px 16px;
  border-radius: 16px;
  background: var(--ch-surface);
  text-align: center;
}
.ch-empty-icon {
  inline-size: 32px;
  block-size: 32px;
  color: var(--ch-accent);
}
.ch-empty-title {
  margin: 8px 0 0;
  font-size: 17px;
  font-weight: 600;
}
.ch-empty-hint {
  margin: 8px 0 0;
  font-size: 14px;
  color: var(--ch-muted);
}
.ch-more {
  display: flex;
  inline-size: calc(100% - 32px);
  min-height: 48px;
  margin: 24px 16px 8px;
  border: 1px solid var(--ch-outline);
  background: transparent;
}
.ch-sheet-head {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}
.ch-sheet-head .ch-icon {
  margin-block-start: 4px;
}
.ch-sheet-title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  line-height: 1.3;
  overflow-wrap: anywhere;
}
.ch-when {
  margin: 8px 0 0;
  font-size: 15px;
}
.ch-when-date,
.ch-when-time {
  display: block;
}
.ch-when-time {
  color: var(--ch-muted);
}
.ch-sheet-tags {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin: 10px 0 0;
  font-size: 14px;
  color: var(--ch-muted);
}
.ch-sheet-state {
  margin: 10px 0 0;
  font-size: 14px;
  font-weight: 500;
}
.ch-facts {
  margin: 14px 0 0;
}
.ch-fact {
  padding: 10px 0;
  border-block-start: 1px solid var(--ch-separator);
}
.ch-fact dt {
  font-size: 12px;
  color: var(--ch-muted);
}
.ch-fact dd {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 2px 0 0;
  font-size: 15px;
  overflow-wrap: anywhere;
}
.ch-fact dd.ch-notes {
  display: block;
  white-space: pre-wrap;
}
.ch-swatch {
  flex: none;
  inline-size: 10px;
  block-size: 10px;
  border-radius: 50%;
}
.ch-sheet-action {
  display: flex;
  inline-size: 100%;
  min-height: 48px;
  margin-block-start: 16px;
}
`;
```

- [ ] **Step 12: Run the smoke under the three clocks and see it pass**

```bash
cd /Users/razielgershoni/development/famcalbot
for tz in UTC Asia/Jerusalem Pacific/Kiritimati; do
  eval "env TZ=$tz $E npx tsx scripts/smoke-calendar-home-render.ts" > /tmp/d5-render.log 2>&1; echo "TZ=$tz exit $?"; grep -E '^FAIL|passed' /tmp/d5-render.log
done
```
Expected (each run takes about 15 s; #15 starts four child renders), with no `FAIL` line:
```
TZ=UTC exit 0
21/21 passed (process TZ=UTC)
TZ=Asia/Jerusalem exit 0
21/21 passed (process TZ=Asia/Jerusalem)
TZ=Pacific/Kiritimati exit 0
21/21 passed (process TZ=Pacific/Kiritimati)
```
If #15 fails, a date or time is being formatted in the device's zone. The failure lists each zone's markup digest. If only #21 fails, React logged a warning, and the message names it.

- [ ] **Step 13: Run the regression smokes again**

```bash
cd /Users/razielgershoni/development/famcalbot
for f in smoke-initdata-header smoke-auth-leftovers smoke-miniapp-gate smoke-calendar-home-copy smoke-hebrew-date smoke-calendar-agenda smoke-telegram-ui smoke-command-client check-i18n-parity; do
  for tz in UTC Asia/Jerusalem; do
    eval "env TZ=$tz $E npx tsx scripts/$f.ts" > /tmp/d5-$f.log 2>&1; echo "$f TZ=$tz exit $?"
    grep -E '^(OK|FAIL)|passed|parity' /tmp/d5-$f.log > /tmp/d5-$f-${tz//\//_}.after
    cmp -s /tmp/d5-$f-${tz//\//_}.before /tmp/d5-$f-${tz//\//_}.after && echo "  same output as Step 2" || echo "  OUTPUT CHANGED"
  done
done
```
Expected: every run prints `exit 0` and `same output as Step 2`. `smoke-initdata-header` #8 and `smoke-auth-leftovers` now also scan the new files, and they stay green.

- [ ] **Step 14: Type-check and lint**

```bash
cd /Users/razielgershoni/development/famcalbot
npx tsc --noEmit -p . ; echo "tsc exit $?"
npm run -s lint ; echo "lint exit $?"
```
Expected: `tsc exit 0` and `lint exit 0`, with no output from either.

- [ ] **Step 15: Commit**

```bash
cd /Users/razielgershoni/development/famcalbot
git add src/lib/calendar-view/home-props.ts src/lib/calendar-view/format.ts 'app/[locale]/dashboard/home-theme.ts' 'app/[locale]/dashboard/BottomSheet.tsx' 'app/[locale]/dashboard/ItemRow.tsx' 'app/[locale]/dashboard/DayList.tsx' 'app/[locale]/dashboard/StillOpenCard.tsx' 'app/[locale]/dashboard/ItemSheet.tsx' 'app/[locale]/dashboard/AgendaView.tsx' scripts/smoke-calendar-home-render.ts
git commit -m "$(cat <<'EOF'
feat(calendar-home): the Agenda view and the item sheet

AgendaView renders D3's Agenda model in en, he and ru: the state rows
with Retry or Choose again, the "Still open" card (5, then "N more",
each with since when and who set it), today and the next 6 days with
the Hebrew date when it is on, folded empty days only once every source
answered, Ruling R10's empty state with only the hints the plan allows,
and "Show next week". Rows show the time in the user's timezone (24-hour,
dir="ltr"), spans, reminder icons with text, the partner's name (R7) and
"Google · <calendar>". A tap opens a view-only sheet (spec §7.5) through the container's
selection, whose Telegram BackButton closes it, and Google items open in
Google Calendar through openLink. A Google user still choosing calendars
gets no Agenda under the setup banner. Day labels and fold lines follow
the mockups ("Sat 17 – Sun 18 Oct", "חמישי 15 באוק׳"). No tab bar (R19), no calendar ids in
the markup, nothing under 11 px, taps of 44 px or more, logical CSS only.
Adds the props contract the page hands the home, the Intl helpers and the
home's theme tokens over globals.css's brand colours. Nothing renders it yet, and the switch stays OFF.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
EOF
)"
```
Stage only these ten paths. The working tree may show plan or spec files as modified; they aren't part of this task.

---

### Task 6 (D6): CalendarHome container (spec §5, §7.1, §7.2; Rulings R5, R6, R8, R19)

> **INTERFACE CHANGES VERSUS THE SPLIT (read these first; D7 depends on the first one):**
> 1. **`CalendarHomeProps` gains two OPTIONAL fields**, in D5's `src/lib/calendar-view/home-props.ts`: `trialDaysLeft?: number | null` and `hasLocation?: boolean`. Spec §7.2's trial and location banners need them, and the split's props carry neither (D1's and D7's drafts both left this to D6). They are optional, so an object of the split's exact shape is still a `CalendarHomeProps`: **D7 applies and passes as written** (checked on the scratch base: 63e7d4f + D1–D6 + D7, `smoke-page-auth` 14/14, `smoke-miniapp-gate` 19/19, 20/20 with the review patch's #20, `tsc` and lint clean). Absent means "unknown", and those two banners stay hidden. **To show them, D7 needs four more lines, two in each of two files**, also checked (14/14, 19/19, `tsc` and lint clean):
>    - in `calendarHomeProps` (D7's Step 5), after the `hints:` line: `trialDaysLeft: !p.isEarlyAdopter && p.trial.isTrialing && p.trial.daysRemaining > 0 ? p.trial.daysRemaining : null,` and `hasLocation: Boolean(p.user.location),` (the old home's own trial rule, `DashboardClient.tsx:761`);
>    - in `smoke-miniapp-gate.ts` #16's `want`, after its `hints:` line: `trialDaysLeft: 5,` and `hasLocation: true,` (the fixture is trialing with 5 days and lives in Tel Aviv).
>    - **Integration:** D7's draft now carries these four lines, plus a #18 assertion that an early adopter with no location gets `trialDaysLeft: null` and `hasLocation: false`.
> 2. **Exports beyond the split's default export.** `CalendarHome.tsx` also exports `CalendarHomeContainer` (the home without its error boundary, taking an optional `deps` for a smoke's clock and timers), `HomeDeps` and `NOT_ENABLED_RELOAD_KEY`. Two client modules hold the data flow: `src/lib/calendar-view/home-client.ts` and `src/lib/calendar-view/home-loader.ts`. A third, `src/lib/calendar-view/reload-guard.ts`, holds the reload-once guard and the chunk-load test as a leaf with no imports, for D7's boundary in PageGate (home-client re-exports both, so nothing else moves). The shell's CSS is `HOME_SHELL_CSS` in `app/[locale]/dashboard/home-shell.ts`. The parts export pure helpers the smoke checks: `homeBanners`, `menuEntries`, `sendResultKey`.
> 3. **D5's smoke grows from 21 to 40 checks** (D5 asked D6 to add its CalendarHome cases there). Three small edits touch D5's own helpers: the console capture lets Node's `(node:…)` warning lines and the app's `[command-client]` / `[calendar-home]` log lines through (they are not React warnings); `mount()` takes the root's options; and D5's last check, "React logged no warning", moves from #21 to #40 so it also covers the home's renders.
> 4. **No new copy.** Every string is a D1 key, used verbatim. D4's `sent` with `chat: 'telegram'` maps to D1's `send.sent`.
> 5. **Review patch** (each item has its own check, #28 and #36–#39):
>    - **Telegram's one BackButton is the container's**, for the item sheet (D5 now takes the selection as `selected` / `onSelect`), the Send sheet and the ⋯ menu: Android's back gesture is that button, and with only the item sheet on it, back with the Send or ⋯ sheet open closed the whole Mini App. **This goes past spec §7.6's letter** ("shown while the item sheet is open…; Plan D uses it for the item sheet only"), which named the only sheet D had when it was written; Plan E moves the call to the container anyway. Listed for the owner to confirm.
>    - **A range request has a time limit** (`RANGE_TIMEOUT_MS`, 15 s, on the deps' timer). One that never settled (a network handover, iOS suspending the webview mid-request) kept its in-flight key, so every foreground refetch of that window was deduped behind it, and a first load showed placeholders until ⋯ → Refresh.
>    - **A return to the foreground checks the day first.** iOS suspends the midnight timer with the app; on the first return after a night the home asked for yesterday's windows and labelled yesterday "Today" until they answered. Now it drops the store at once, as the timer would have (once per server day, as the timer does).
>    - **404 `not_enabled` lets the BackButton go before its reload** (`reloadOnce`'s new `beforeReload`, D4's hook's new `releaseTelegramBackButton()` in `src/lib/telegram-ui.ts`): a reload runs no React cleanup and the client keeps the button, so a user the switch no longer covers saw a back button that did nothing on today's dashboard. The chunk-load reload does the same.
>    - **A Google user still setting up gets no Agenda** under the Connect or Choose banner (D5's `setupNeeded`): the route answers `ok` with seven empty days when no calendars are chosen, which read as "Nothing planned" plus the how-to-add hints, for every new Google user.
> 6. **Rulings this task makes** (the spec doesn't; for the owner to confirm): the location banner shows only when the server can't know the timezone (no location and no Google token: `tzKnownFor`'s rule), not "when no location is set" (§7.2), because a connected Google user's times follow Google's own settings; and "the existing Google setup card" (§7.2) is two banners, Connect Google Calendar (no token) and Choose your calendars (none chosen), in the home's look rather than the old home's card.

**What and why:** D5's Agenda is presentational. This task writes the container that makes it the home: `CalendarHome`, the default export PageGate renders with `CalendarHomeProps` once D7 lands, for the users the rollout switch covers. Plan D has the Agenda only and no tab bar (Ruling R19). The container owns:
- **The data (spec §5).** D3's store, fed by one range request per applicable source with no dates on mount. "Show next week" adds a week. A store drop (midnight in `tz`, or facts that changed) refetches the visible weeks. A return to the foreground (`visibilitychange`, Telegram's `activated`) refetches them, or, when the day has ended meanwhile, drops the store at once; ⋯ → Refresh sends `fresh=1` on each. A stale Google answer asks once more after about 3 s, and a Google error retries once after about 5 s. A request that hasn't settled in 15 s is aborted and reads as no answer.
- **The answers.** 404 `not_enabled` lets Telegram's BackButton go and reloads the page once, so PageGate shows today's dashboard. 401, 403 and any other 404 show PageGate's `NoCredentialCard`. A 429 is busy and a 500 is a retry: a state row once the facts are pinned, else a card in the Agenda's place.
- **Telegram's BackButton (§7.6).** One call, at the root: shown while the item sheet, the Send sheet or the ⋯ menu is open; a tap (Android's back gesture too) closes that sheet.
- **The shell (§7.1).** D4's theme (Telegram's `bg_color` for the header and background, `data-theme` for D5's tokens), the direction, document-level scroll, the stable viewport height and both safe-area families, and "Times in <zone>" only when the device is in another zone.
- **The header, send sheet, menu and banners (§7.2, Rulings R5 and R6).** A Google user still setting up gets the setup banner and no Agenda under it.
- **An error boundary** around all of it; a chunk-load error reloads once.

Nothing renders `CalendarHome` until D7's PageGate branch. The switch stays `OFF`, and no user sees a change.

**Files** (line numbers as of the real base plus D1–D5; the two modified files are D4's and D5's, which don't exist on the base):
- Modify: `src/lib/calendar-view/home-props.ts:18-20`: two optional fields after `hints`.
- Modify: `src/lib/telegram-ui.ts:75-103` (D4's): the BackButton hook remembers its live handler, and `releaseTelegramBackButton()` lets it go outside React.
- Create: `src/lib/calendar-view/reload-guard.ts`
- Create: `src/lib/calendar-view/home-client.ts`
- Create: `src/lib/calendar-view/home-loader.ts`
- Create: `app/[locale]/dashboard/home-shell.ts`
- Create: `app/[locale]/dashboard/HomeHeader.tsx`
- Create: `app/[locale]/dashboard/HomeBanners.tsx`
- Create: `app/[locale]/dashboard/SendSheet.tsx`
- Create: `app/[locale]/dashboard/MenuSheet.tsx`
- Create: `app/[locale]/dashboard/HomeErrorBoundary.tsx`
- Create: `app/[locale]/dashboard/CalendarHome.tsx`
- Modify (test): `scripts/smoke-calendar-home-render.ts`, seven spots: `:31-33` (header), `:40-41` (first import), `:55-56` (imports), `:91-99` (console capture), `:535-538` (`mount`), `:594-596` (the home's helpers), `:1095` (checks #21–#39; the last check becomes #40).
- Test: `scripts/smoke-calendar-home-render.ts` under `TZ=UTC`, `TZ=Asia/Jerusalem` and `TZ=Pacific/Kiritimati` (#15 still also runs Los Angeles in child processes).
- Regression (unchanged): `scripts/smoke-initdata-header.ts` (#8 scans `app/**` and `src/**` for init data in URLs), `scripts/smoke-auth-leftovers.ts`, `scripts/smoke-miniapp-gate.ts` (PageGate, which `CalendarHome` imports `NoCredentialCard` from), D1–D4's smokes (`smoke-calendar-home-copy`, `smoke-hebrew-date`, `smoke-calendar-agenda`, `smoke-telegram-ui`, `smoke-command-client`), `scripts/check-i18n-parity.ts`.
- Unchanged on purpose: `app/[locale]/PageGate.tsx` and `src/lib/page-data.ts` (D7's), `DashboardClient.tsx`, D5's view files, `messages/*.json`.

**Interfaces:**
- Consumes:
  - D1, `calendarHome.*`: `header.send|menu`; `send.title|subtitle|today|todayHint|tomorrow|tomorrowHint|thisWeek|thisWeekHint|nextWeek|nextWeekHint|weather|weatherHint|sending|sent|sentWhatsApp|busy|failed|signedOut|offline`; `menu.*` (all nine); `banner.trial {count}`, `banner.trialAction|location|locationAction|connectGoogle|connectGoogleBody|chooseCalendars|chooseCalendarsBody|reconnect|reconnectBody|reconnectScopes|reconnectScopesBody|reconnectAction|openInTelegram|openInTelegramBody`; `state.busy|errorTitle|errorBody`; `actions.retry|close|reload`; `errorBoundary.title|body`; `shell.timesIn {zone}`; `hebrewMonthGenitive` (`t.raw`, Russian only). PageGate's card reads `pageGate.*` itself.
  - D2: `hebrewFullDate(dayKey: DayKey, lang: string, genitive?: readonly string[]): string`.
  - D3: `reduceStore`, `emptyStore`, `homeNotices`, `daysInWindow`, `type CalendarStore`, `type StoreAction` (`store.ts`); `buildAgenda(state, weeks)`, `agendaWeekWindow(today, week)` (`agenda.ts`). Each request is stamped with `store.epoch` when it leaves, as D3 asks.
  - D4: `useTelegramTheme(): ColorScheme`, `onTelegramEvent(event, handler): () => void`, `isInTelegram(): boolean`, `useTelegramBackButton(active, onBack)` (`telegram-ui.ts`), plus this task's `releaseTelegramBackButton()` there; `SEND_ITEMS`, `sendToChat(userId, item, locale): Promise<SendResult>`, `type SendItem`, `type SendResult` (`command-client.ts`).
  - D5: `AgendaView` with exactly `AgendaViewProps` (`{ agenda, hints, setupNeeded, selected, onSelect, onShowNextWeek, onRetry, onChooseCalendars }`), `type AgendaRow` (D3's), `BottomSheet`, `HOME_THEME_CSS`, `formatDayLong`, `instantDay`, `intlLocale`, and `CalendarHomeProps` / `HomeHints` from `home-props.ts`.
  - B and today's code: `GET /api/calendar/range?user_id=&sources=[&from=&to=][&fresh=1]` and its answers (`app/api/calendar/range/route.ts`); `RangeResponse`, `SourceName`, `DayKey` (`src/lib/calendar-view/types.ts`); `initDataHeaders()` (`src/lib/read-init-data.ts:38`); `DEFAULT_BOT_USERNAME`, `DEFAULT_WA_NUMBER`, `type GateLinks` (`src/lib/gate-links.ts`); `NoCredentialCard({ look, inTelegram, links })` (`app/[locale]/PageGate.tsx`); `useRouter` (`next/navigation`).
- Produces:
  - `src/lib/calendar-view/home-props.ts`: `CalendarHomeProps` plus `trialDaysLeft?: number | null` and `hasLocation?: boolean`.
  - `app/[locale]/dashboard/CalendarHome.tsx`:
    - `export default function CalendarHome(props: CalendarHomeProps)` (the split's), the container inside `HomeErrorBoundary`;
    - `export function CalendarHomeContainer(props: CalendarHomeContainerProps)`, with `export type CalendarHomeContainerProps = CalendarHomeProps & { deps?: Partial<HomeDeps> }`;
    - `export interface HomeDeps { now: () => number; setTimer: (run: () => void, ms: number) => () => void; deviceTimeZone: () => string | null }`;
    - `export const NOT_ENABLED_RELOAD_KEY = 'famcal:calendarHome:notEnabledReload:v1'`.
  - `src/lib/calendar-view/home-client.ts`: `interface RangeWindow { from: DayKey; to: DayKey }`; `type RangeOutcome = { kind: 'ok'; response: RangeResponse } | { kind: 'notEnabled' } | { kind: 'noCredential'; status: number } | { kind: 'busy' } | { kind: 'error'; status: number | null }`; `homeSources(calendarSource): SourceName[]`; `rangeUrl(userId, source, window | null, fresh): string`; `interface RangeTimeLimit { ms: number; setTimer(run, ms): () => void }`; `fetchRange(userId, source, window | null, fresh, limit?: RangeTimeLimit): Promise<RangeOutcome>` (never throws; past `limit.ms` it aborts and answers `{ kind: 'error', status: null }`); `msUntilDayCheck(nowMs, tz): number`; `isPastDay(nowMs, tz, today): boolean`; `deviceTimeZone(): string | null`; `zoneDiffers(device: string | null, tz): boolean`; `zoneLabel(tz, locale): string`; and, re-exported from reload-guard, `isChunkLoadError` and `reloadOnce`.
  - `src/lib/calendar-view/reload-guard.ts` (a leaf, no imports): `CHUNK_RELOAD_KEY = 'famcal:calendarHome:chunkReload:v1'`; `isChunkLoadError(error: unknown): boolean`; `reloadOnce(key, nowMs = Date.now(), beforeReload?: () => void): boolean` (`beforeReload` runs only when it reloads, right before).
  - `src/lib/telegram-ui.ts`: `releaseTelegramBackButton(): void` (offClick of the hook's live handler, then hide; each gated and caught as the hook's calls are).
  - `src/lib/calendar-view/home-loader.ts`: `STALE_RETRY_MS = 3000`, `ERROR_RETRY_MS = 5000`, `RANGE_TIMEOUT_MS = 15_000`; `interface LoaderHost` (see the file); `interface HomeLoader { ensure(): void; refetchVisible(o?: { fresh?: boolean; only?: SourceName }): void; dispose(): void }`; `createHomeLoader(host: LoaderHost): HomeLoader`.
  - `app/[locale]/dashboard/home-shell.ts`: `HOME_SHELL_CSS: string` (adds the token `--ch-accent-soft`).
  - `app/[locale]/dashboard/HomeHeader.tsx`: `HomeHeaderProps { today: DayKey | null; hebrewDates: boolean; zone: string | null; sendOpen: boolean; menuOpen: boolean; onSend: () => void; onMenu: () => void }`, `HomeHeader`, `SendIcon`.
  - `app/[locale]/dashboard/HomeBanners.tsx`: `type BannerId`, `interface BannerFacts`, `homeBanners(f: BannerFacts): BannerId[]`, `OPEN_IN_TELEGRAM_URL`, `HomeBannersProps` (`BannerFacts` plus `userId`, `locale`, `onNavigate(href)`), `HomeBanners`.
  - `app/[locale]/dashboard/SendSheet.tsx`: `SendSheetProps { userId: number; locale: string; onClose: () => void }`, `sendResultKey(result: SendResult): { key: string; problem: boolean } | null`, `SendSheet`.
  - `app/[locale]/dashboard/MenuSheet.tsx`: `type MenuEntryId`, `interface MenuEntry { id: MenuEntryId; href: string | null }`, `menuEntries(o: { calendarSource; isAdmin; locale; userId }): MenuEntry[]`, `MenuSheetProps`, `MenuSheet`.
  - `app/[locale]/dashboard/HomeErrorBoundary.tsx`: `CHUNK_RELOAD_KEY` (reload-guard's, re-exported), `HomeCrash`, `class HomeErrorBoundary`.
- **What D7 hands over** (unchanged from the split, plus the two optional fields above): `user.id` is the page's own `?user_id` (a Telegram id or a DB id). The home sends it as `user_id` to the range route and to `execute-command`, which resolve it with `verifyUserAuth`. It is never swapped for another id.

**Findings that shaped the code** (line numbers as of the real base plus D1–D5):
- **What the range route answers** (`app/api/calendar/range/route.ts`, `src/lib/api-auth.ts:48-105`):
  - 200 with a `RangeResponse`;
  - 404 `{ error: 'not_enabled' }` when the switch doesn't cover the user (`route.ts:154`), but also 404 `{ error: 'User not found' }` from `verifyUserAuth`, so the body decides;
  - 401, 403 (suspended) and 400 (no `user_id`) from `verifyUserAuth`;
  - 429 from the limiter, and also when its Redis is down: `checkRateLimit` fails closed (`src/lib/rate-limit.ts:69-73`). So 429 alone covers spec §5's "429, or the limiter's Redis down";
  - 500 `internal_error`.

  A 400 or any other status reads as an error (the home builds its dates with `agendaWeekWindow`, so it never sends a bad one). So does a 200 whose body isn't a `RangeResponse`, or no answer at all.
- **Which windows are asked.** The first request per source has no dates (the server's `[today, today+7)`, spec §5). After that every window is explicit, from `agendaWeekWindow(today, week)`. `ensure()` runs after every store change and asks each visible window whose days a source hasn't covered (ok or failed, D3's `coverage`) in this epoch, at most once per epoch. That one rule covers "Show next week", the refetch after a drop (D3: the days are gone), and a second source that failed before any facts existed. It never re-asks the window whose answer caused a mismatch drop, because that answer is already merged in the new epoch.
- **Requests in flight are not sent twice.** Telegram's `activated` and the webview's `visibilitychange` can both fire on one return, which would send the same windows twice. The key is epoch, source, window and `fresh`. A Refresh (`fresh=1`) is its own key, and the server limits it anyway (§2.6).
- **Every request has a time limit** (review patch). A fetch that never settles (a network handover, or iOS suspending the webview mid-request) would keep its in-flight key forever, so every later return for that window was deduped. `fetchRange` races the answer, body included, against a 15 s timer on the deps' `setTimer` (so the smoke drives it), aborts the request and answers `{ kind: 'error', status: null }`, which already means "no answer": the retry card before any facts, a failed window after. The race doesn't rely on the fetch honouring the abort.
- **The follow-ups are bounded.** A stale answer gets one re-request (a stale re-request gets none); a Google error other than `calendars_gone` gets one retry (a retry gets none). Each follow-up is dropped when the epoch has moved on, for example a stale answer at 23:59:58 whose re-request would ask for a day that has ended.
- **Before any facts there is no state row to show**, so a 429 or a failure shows a card in the Agenda's place. `ensure()` stays quiet while the card is up, which keeps a failing request from looping. The card's Retry clears it, and `ensure()` asks again.
- **Midnight.** The timer re-checks at most an hour ahead (`msUntilDayCheck`). A DST change on the way then moves the check by minutes, not an hour. Chile's 00:00 that doesn't exist on 6 September 2026 is checked at 01:00, which is already the new day. The check resets once per server day (`resetFor`). Otherwise a device clock that runs ahead would reset, the server would pin the same today again, and the timer would loop.
- **A return to the foreground checks the day first** (review patch). iOS suspends timers with the app, so after a night the first `visibilitychange` or `activated` comes before the late midnight timer: it would ask for yesterday's explicit windows and show yesterday as "Today" until they answered. The foreground handler now runs the timer's own test (`isPastDay` against the server's today, once per server day through `resetFor`) and drops the store; the loader starts over with a no-dates request. The old timer goes with the old facts, so it resets nothing when it finally runs. If the init data is over a day old by then (`INIT_DATA_MAX_AGE_SEC`), the route answers 401 and the home shows PageGate's card, as for any 401: the Mini App can't refresh its own init data, and the card's button goes back to the chat, whose buttons reopen it with fresh data (#39 records this).
- **404 `not_enabled` reloads once.** The guard is a timestamp in `sessionStorage`, held for a minute (longer than the switch's 30 s memo). Without storage (blocked, or private mode) it never reloads, so it can't loop, and the card's Retry reloads by hand. Right before the reload it lets Telegram's BackButton go (review patch): the client keeps the button across a reload, which runs no React cleanup, and neither PageGate nor DashboardClient ever hides it. `reloadOnce` takes that as `beforeReload`, run only when it does reload.
- **401, 403 and any other 404 show PageGate's `NoCredentialCard`**, as PageGate does, and nothing more is fetched (the loader's one guard is in `send()`). The card's browser links need the server's env, which the client doesn't have. So the home passes gate-links' public defaults, the number and bot the landing pages link to. Inside Telegram the card only closes the app.
- **"Open FamCal in Telegram"** links to `t.me/<bot>?start=connect`, the old home's link (`DashboardClient.tsx:773`). The bot answers it by linking a WhatsApp account to Telegram (`src/services/telegram/commands.ts:164-170`). It shows only in a browser, `readInitData() === ''` (`isInTelegram`), and comes last: WhatsApp stays secondary to Telegram.
- **The banners' rules:**
  - trial: only `trialDaysLeft > 0`, as the old home (`DashboardClient.tsx:761`);
  - location: when the server can't know the timezone, which is `tzKnownFor`'s rule (`!!location || !!googleRefreshToken`): no location, and a FamCal user or a Google user with no token. A connected Google user's times follow Google's own settings;
  - the Google setup card: Connect when there is no token (`needsOAuth`), else Choose your calendars (`needsCalendars`);
  - Reconnect: the store's `homeNotices().reconnect`, with the scopes copy for `scopes`, never with Connect, and never for a FamCal user. A FamCal user never gets a `google` key from the route either (`route.ts:127-132`).
- **"Times in <zone>"** compares canonical zone names, so `Asia/Tel_Aviv` is `Asia/Jerusalem`, and ICU's `Asia/Calcutta` is `Asia/Kolkata`. The name is Intl's `longGeneric`: "Israel Time" / "שעון ישראל" / "Израиль", which read naturally in D1's three phrasings. The fallback is the zone's city, never a GMT offset. The device zone and `isInTelegram()` are read through `useSyncExternalStore` with a server snapshot, as D4's theme hook is, so a server render and the first client render agree.
- **The header** is the server's `today` through D5's `formatDayLong` ("Thursday, 15 October"), with D2's `hebrewFullDate` under it when the route says `hebrewDates`; Russian passes the genitive list ("4 хешвана 5787"). Intl writes Russian lower case ("четверг, 15 октября"), and `::first-letter` capitalizes it on screen only. Until the first answer the header shows a placeholder bar, never a guessed day.
- **The BackButton is the container's** (review patch; it was AgendaView's). The one `useTelegramBackButton` call sits at the root, active while the item sheet, the Send sheet or the ⋯ menu is open; a tap closes the Send or menu sheet if one is open, else the item sheet. The root mounts first, so the hide-on-mount runs at once after a reload, also when a card later replaces the Agenda. The item sheet's selection lives here too (AgendaView takes `selected` / `onSelect`): a store drop clears it ("adjust state while rendering"), so the sheet doesn't reopen when the next answer comes. A 401 clears both sheets with the card. Only the boundary's card can show without the root having mounted, so `HomeCrash` calls `useTelegramBackButton(false, …)` itself. The SDK has one button for all handlers, so there is only ever this one call.
- **The Google setup state** (review patch). `setupNeeded = calendarSource === 'GOOGLE' && (needsOAuth || needsCalendars)` goes to AgendaView, which then shows nothing under the Connect or Choose banner. The request still goes out, for the header's day and Hebrew date.
- **React 19.2's hook rules (eslint-plugin-react-hooks 7):**
  - the refs the loader reads are synced in an effect, never written during render;
  - the loader is created in an effect and disposed in its cleanup. Under Strict Mode a dev open sends its first request twice, and the first answer is dropped;
  - no state is set synchronously in an effect body.
- **`useRouter` needs `AppRouterContext`.** PageGate's tree has it, and the smoke provides it, as `smoke-calendar-home-copy` does.
- **Testability.** `CalendarHomeContainer` takes `deps` (the clock, the timers and the device's zone), so the smoke drives 3 s, 5 s, 15 s and midnight without waiting, and can move the clock without running timers (`jump`, an iOS suspension). The default export uses the real ones. The smoke fakes `fetch` itself, so the real `fetchRange` and `sendToChat` run.
- **D5's console capture caught a Node warning.** On Node 26, tsx's `module.register()` deprecation (DEP0205) is printed at a moment that varies with the import graph. With CalendarHome's graph it landed after the capture began, and the last check (#36 then, #40 now) read it as a React warning. Lines starting `(node:` now go to the real console.
- **Privacy:** the home logs no title and no id. Its requests carry `user_id`, `sources`, the dates and `fresh`, and the init data only in the `X-Telegram-Init-Data` header (`smoke-initdata-header` #8 scans the new files).

**Verified:**
- **Base:** `feat/calendar-home` after Plan C (verified on 2eb69df, Plan C's reference chain on 716a4f8, and again on 6dab367, the branch and `main` after Plan C, which differs from that chain only in files D doesn't touch), with D1–D5's reference commits. D1–D5's smokes pass there: 14/14, 14/14, 33/33, 11/11 and 14/14, and 21/21 for D5's. The first pass, the mutations and the review patch ran on the scratch base (header, Planning Ruling 9): 63e7d4f with D1–D5 applied from their drafts by `bapply.py` (D1's Step 1 smoke and D2's two package lines by hand, since `bapply` doesn't pick those blocks up), matching D5's verified copy file for file. The before and after results below hold on all three.
- **Before** (the smoke edited, no D6 source): the smoke exits 1 with `Error: Cannot find module '../app/[locale]/dashboard/CalendarHome'` under all three clocks, and `tsc` shows the 13 errors of Step 2.
- **After:**
  - 40/40 under `TZ=UTC`, `TZ=Asia/Jerusalem` and `TZ=Pacific/Kiritimati`, with the same OK lines under each;
  - `npx tsc --noEmit -p .` and `npm run -s lint` are clean;
  - the regression smokes print the same lines before and after under UTC and Jerusalem: `smoke-initdata-header` 9/9, `smoke-auth-leftovers` 9/9, `smoke-miniapp-gate` 15/15, `smoke-calendar-home-copy` 14/14, `smoke-hebrew-date` 14/14, `smoke-calendar-agenda` 33/33, `smoke-telegram-ui` 14/14, `smoke-command-client` 11/11, `check-i18n-parity` OK (996 keys).
- **D7 on top** (first pass), in a separate copy: D7's draft applies as written, `smoke-page-auth` 14/14 and `smoke-miniapp-gate` 19/19 under UTC, `tsc` and lint clean. With the four lines of interface change 1, the same results under UTC and Jerusalem. (After the review patch D7's draft also adds a check to each smoke: 14/14, 20/20, and this smoke 41/41.)
- **Mutations** (first pass): the smoke catches all 49 tried, each under UTC:
  - the requests: dates on the first request; no init-data header; the user id changed; no in-flight dedupe; Show next week asking nothing;
  - the follow-ups: the stale re-request repeated, or missing; no Google error retry; `calendars_gone` retried; a follow-up after a drop;
  - the answers: a stale answer dropped; not_enabled read as no credential; 401 read as an error; 429 read as an error; a blocked home still fetching; a first-load failure looping; the busy row shown as a card;
  - reloads and the clock: no reload guard; no midnight reset; a 24-hour day check; the header from the device's clock;
  - the foreground: visibilitychange ignored, or a hidden page counted as a return; `activated` not watched; Refresh without `fresh`;
  - the menu and banners: Google entries for a FamCal user; no Admin entry; Reconnect next to Connect; Reconnect for a FamCal user; the location banner for every Google user; the Telegram banner inside Telegram;
  - the zone line always shown; aliases read as different zones;
  - the send sheet: the spinner reset while closing; parallel sends; `signedOut` never shown;
  - the shell: the root always `dir="ltr"`; no Telegram theme; the nominative month in Russian; the Hebrew date always on; 10 px text; a 40 px header button; `overflow: hidden`; a physical padding; no RTL flip;
  - the boundary: an unguarded chunk reload; every error reloading; no boundary at all.
- **Review patch mutations**, each caught under UTC by the check named: no time limit, or a limit that never aborts → #36; the BackButton for the item sheet only, a back tap that always closes the item sheet, a drop that keeps the selection → #37; no setup gate → #38 (and D5's #11); no day check on the foreground → #39, the check without its once-per-day guard → #39 (the device clock ahead); `not_enabled` reloading without letting the button go, a release that hides without offClick, a hook that never records its live handler, `beforeReload` run after the reload → #28. All 12 are caught; the once-per-day guard was missed at first, and #39 gained its device-clock-ahead case for it.
- **The task text itself was replayed** on a fresh copy of 2eb69df with D1–D5's texts applied first: every block applied once, and the tree came out byte-identical to D6's reference commit. (First pass: the same on 63e7d4f + D1–D5.)

**Verified against stand-ins:** none. D1–D5 were applied from their drafts as written. D7 was applied on top in a separate copy, as a check, not as part of this task.

**Not verified:** a real browser, device or Telegram client (the layout, `color-mix`, `100dvh`, the safe areas, `::first-letter`, the real `activated` and BackButton, and send closing on a 2xx are the §10 device check). **Device-check lines this patch adds:** Android's back gesture with the item sheet, the Send sheet and the ⋯ menu open each closes only that sheet; after a night with the app minimized, the first return shows today, never yesterday as "Today"; in Telegram's dark theme on iOS, the bounce above and below the home shows the theme's background, not white; with the item sheet open, turning the switch back and returning to the app leaves no back button on today's dashboard; `next build`, because the scratch copy's node_modules are symlinked (the integration builds of D1–D7 passed on both bases); Intl's zone names and dates in a webview's ICU (Node 26.11.1 and, in integration, Node 22.23.3 were run). #33's strings would move with a different ICU, and the code would still work.

All smoke commands below use this fake environment (never `.env`):
```bash
E="DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake"
```

- [ ] **Step 1: Add the failing CalendarHome checks to `scripts/smoke-calendar-home-render.ts`**

Seven edits in `scripts/smoke-calendar-home-render.ts` (D5's smoke). Each Before block appears exactly once in the file.

Edit 1 of 7, the header comment (`scripts/smoke-calendar-home-render.ts:31-33`). Before:
```ts
//  - the colours: the brand fallbacks are globals.css's tokens, and the page's root takes
//    the theme's background while the home is mounted.
// React must log no warning. No network, no DB, no Redis.
```
After:
```ts
//  - the colours: the brand fallbacks are globals.css's tokens, and the page's root takes
//    the theme's background while the home is mounted.
//
// CalendarHome (Task D6, #21-#39), the container around the Agenda, in real React with
// a fake fetch (spec §5, §7.1, §7.2, §7.6; Rulings R5, R6, R19): one range request per
// applicable source, with no dates and the init data in the header only; the header
// (the server's today, its Hebrew date, "Times in <zone>" only when the device is
// elsewhere); RTL; "Show next week", the foreground refetch, ⋯ → Refresh with fresh=1,
// the stale re-request and the Google error retry; midnight, also when the app comes
// back after a night with its timers suspended; a range request that never settles
// timing out; 404 not_enabled reloading once, with Telegram's BackButton let go first;
// 401/403/404 on PageGate's card; the busy and retry cards; the send sheet's answers
// (R5); the menu (R6); the banners (§7.2), with no Agenda under a Google setup banner;
// Telegram's BackButton for the item, send and menu sheets; the shell's CSS; the error
// boundary.
// React must log no warning. No network, no DB, no Redis.
```

Edit 2 of 7, the first import (`scripts/smoke-calendar-home-render.ts:40-41`): CalendarHome loads first, so the import check walks its graph. Before:
```ts
// The view first: the import-rule check walks what these load.
import { AgendaView, AGENDA_CSS, type AgendaViewProps } from '../app/[locale]/dashboard/AgendaView';
```
After:
```ts
// The views first: the import-rule checks walk what these load.
import CalendarHome, { CalendarHomeContainer, NOT_ENABLED_RELOAD_KEY, type HomeDeps } from '../app/[locale]/dashboard/CalendarHome';
import { AgendaView, AGENDA_CSS, type AgendaViewProps } from '../app/[locale]/dashboard/AgendaView';
```

Edit 3 of 7, the props type and the new imports (`scripts/smoke-calendar-home-render.ts:55-56`). Before:
```ts
import type { HomeHints } from '../src/lib/calendar-view/home-props';
import { formatDayRange, formatDayShort } from '../src/lib/calendar-view/format';
```
After:
```ts
import type { CalendarHomeProps, HomeHints } from '../src/lib/calendar-view/home-props';
import { formatDayRange, formatDayShort } from '../src/lib/calendar-view/format';
import { CHUNK_RELOAD_KEY, HomeErrorBoundary } from '../app/[locale]/dashboard/HomeErrorBoundary';
import { homeBanners, type BannerFacts } from '../app/[locale]/dashboard/HomeBanners';
import { HOME_SHELL_CSS } from '../app/[locale]/dashboard/home-shell';
import { menuEntries } from '../app/[locale]/dashboard/MenuSheet';
import { isChunkLoadError, isPastDay, msUntilDayCheck, zoneDiffers } from '../src/lib/calendar-view/home-client';
import { ERROR_RETRY_MS, RANGE_TIMEOUT_MS, STALE_RETRY_MS } from '../src/lib/calendar-view/home-loader';
```

Edit 4 of 7, the console capture (`scripts/smoke-calendar-home-render.ts:91-99`). Node's own warning lines and the app's prefixed log lines are not React warnings. Before:
```ts
const reactWarnings: string[] = [];
for (const level of ['error', 'warn'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    const text = args.map(String).join(' ');
    if (text.startsWith('[telegram-ui]')) return original(...args);
    reactWarnings.push(text.slice(0, 300));
  };
}
```
After:
```ts
const reactWarnings: string[] = [];
/** The app's own log lines (sendToChat's, the error boundary's): some checks expect them; they are never React's. */
const appLogs: string[] = [];
for (const level of ['error', 'warn'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    const text = args.map(String).join(' ');
    if (text.startsWith('[telegram-ui]')) return original(...args);
    // Node's own warnings (tsx's module.register() deprecation on Node 26 lands here, at a time that varies) aren't React's.
    if (text.startsWith('(node:')) return original(...args);
    if (text.startsWith('[command-client]') || text.startsWith('[calendar-home]')) {
      appLogs.push(text.slice(0, 300));
      return;
    }
    reactWarnings.push(text.slice(0, 300));
  };
}
```

Edit 5 of 7, `mount()` takes the root's options (`scripts/smoke-calendar-home-render.ts:535-538`), for the error-boundary check. Before:
```ts
function mount(el: ReactElement): Mounted {
  const { createRoot } = nodeRequire('react-dom/client');
  const container = new FakeElement('div', HTML_NS);
  const root = createRoot(container);
```
After:
```ts
function mount(el: ReactElement, rootOptions?: Row): Mounted {
  const { createRoot } = nodeRequire('react-dom/client');
  const container = new FakeElement('div', HTML_NS);
  const root = createRoot(container, rootOptions);
```

Edit 6 of 7, the home's test helpers, right before the checks (`scripts/smoke-calendar-home-render.ts:594-596`). Before:
```ts
// ---- The checks ----

/** The markup #15 compares across process zones: the Agenda and two sheets, in each language. */
```
After:
```ts
// ---- CalendarHome (D6): a fake fetch, a fake clock, a fake Telegram, the fake DOM as HTML ----

/** One request the home made: the range route or execute-command. */
type FetchCall = {
  url: string;
  path: string;
  query: URLSearchParams;
  method: string;
  headers: Record<string, string>;
  body: Row | null;
  credentials?: string;
  cache?: string;
  /** The request's AbortSignal (fetchRange's time limit). */
  signal?: { aborted: boolean };
};
type FetchAnswer = { status: number; body?: unknown } | 'throw';
const fetchCalls: FetchCall[] = [];
/** What the fake fetch answers; each check sets it. A promise holds the answer back. */
let answerFetch: (call: FetchCall) => FetchAnswer | Promise<FetchAnswer> = () => ({ status: 500, body: { error: 'no answer set' } });

async function fakeFetch(input: unknown, init: Row = {}): Promise<Row> {
  const url = String(input);
  const parsed = new URL(url, 'https://famcal.test');
  const call: FetchCall = {
    url,
    path: parsed.pathname,
    query: parsed.searchParams,
    method: String(init.method ?? 'GET'),
    headers: { ...(init.headers ?? {}) },
    body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
    credentials: init.credentials,
    cache: init.cache,
    signal: init.signal,
  };
  fetchCalls.push(call);
  const reply = await answerFetch(call);
  if (reply === 'throw') throw new TypeError('Failed to fetch (smoke)');
  return { status: reply.status, ok: reply.status >= 200 && reply.status < 300, json: async () => reply.body };
}
const rangeCalls = () => fetchCalls.filter((c) => c.path === '/api/calendar/range');
const sendCalls = () => fetchCalls.filter((c) => c.path === '/api/execute-command');
/** A range call as "<source> <from>→<to>[ fresh]", or "<source> default" with no dates. */
const describeRange = (c: FetchCall) =>
  `${c.query.get('sources')} ${c.query.has('from') ? `${c.query.get('from')}→${c.query.get('to')}` : 'default'}${c.query.get('fresh') === '1' ? ' fresh' : ''}`;
const ranges = () => rangeCalls().map(describeRange);
const ok200 = (body: unknown): FetchAnswer => ({ status: 200, body });
/** The answer to a range call for its own window (the no-dates one is week 0). */
const answerFor = (c: FetchCall, o: Partial<RangeResponse> & { items?: Record<DayKey, ItemDTO[]> } = {}) =>
  ok200(answer({ from: c.query.get('from') ?? TODAY, to: c.query.get('to') ?? day(7), ...o }));

/** Lets every pending promise, and the renders and effects they cause, run inside act. */
async function settle() {
  await React.act(async () => {
    for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve));
  });
}

/** A clock for CalendarHomeContainer's deps: its timers run only on advance(). */
function fakeClock(startIso: string, deviceZone: string | null = TZ) {
  let now = Date.parse(startIso);
  let seq = 0;
  const timers: { id: number; at: number; run: () => void }[] = [];
  const deps: HomeDeps = {
    now: () => now,
    setTimer: (run, ms) => {
      const id = ++seq;
      timers.push({ id, at: now + ms, run });
      return () => {
        const i = timers.findIndex((t) => t.id === id);
        if (i >= 0) timers.splice(i, 1);
      };
    },
    deviceTimeZone: () => deviceZone,
  };
  return {
    deps,
    /** Moves the clock on, running each timer that falls due, in order. */
    advance: async (ms: number) => {
      const end = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at || a.id - b.id);
        const next = timers[0];
        if (!next || next.at > end) break;
        timers.shift();
        now = next.at;
        await React.act(async () => next.run());
        await settle();
      }
      now = end;
    },
    /** Moves the clock on without running any timer, as iOS does while the app is suspended. */
    jump: (ms: number) => {
      now += ms;
    },
    /** The pending timers' delays from now, shortest first. */
    pending: () => timers.map((t) => t.at - now).sort((a, b) => a - b),
  };
}

/** A fake Telegram.WebApp for the home (Bot API 8.0 by default, so `activated` exists). BackButton handlers ride on backButtonClicked, as the SDK's do. */
function fakeTelegramHome(o: { version?: string; scheme?: 'light' | 'dark'; closeThrows?: boolean } = {}) {
  const calls: string[] = [];
  const events = new Map<string, Set<() => void>>();
  const version = o.version ?? '8.0';
  const webApp: Row = {
    initData: 'query_id=AAE&user=%7B%22id%22%3A5550001%7D&auth_date=1792000000&hash=abc',
    version,
    colorScheme: o.scheme ?? 'light',
    isVersionAtLeast: (v: string) => Number(v) <= Number(version),
    setHeaderColor: (c: string) => calls.push(`setHeaderColor(${c})`),
    setBackgroundColor: (c: string) => calls.push(`setBackgroundColor(${c})`),
    onEvent: (e: string, h: () => void) => {
      calls.push(`onEvent(${e})`);
      if (!events.has(e)) events.set(e, new Set());
      events.get(e)?.add(h);
    },
    offEvent: (e: string, h: () => void) => {
      calls.push(`offEvent(${e})`);
      events.get(e)?.delete(h);
    },
    openLink: (url: string) => calls.push(`openLink(${url})`),
    close: () => {
      calls.push('close()');
      if (o.closeThrows) throw new Error('close() failed in the smoke');
    },
    BackButton: {
      onClick: (h: () => void) => {
        calls.push('BackButton.onClick');
        if (!events.has('backButtonClicked')) events.set('backButtonClicked', new Set());
        events.get('backButtonClicked')?.add(h);
      },
      offClick: (h: () => void) => {
        calls.push('BackButton.offClick');
        events.get('backButtonClicked')?.delete(h);
      },
      show: () => calls.push('BackButton.show()'),
      hide: () => calls.push('BackButton.hide()'),
    },
  };
  return {
    webApp,
    calls,
    fire: (e: string) => [...(events.get(e) ?? [])].forEach((h) => h()),
    /** BackButton handlers still registered. */
    backHandlers: () => events.get('backButtonClicked')?.size ?? 0,
  };
}

/** The fake DOM as HTML, so textOf and the markup checks read it as they read renderToString's. */
function htmlOf(node: FakeNode): string {
  if (node instanceof FakeText) return node.data.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inner = node.childNodes.map(htmlOf).join('');
  if (!(node instanceof FakeElement)) return inner;
  const attrs = [...node.attributes].map(([k, v]) => ` ${k}="${v.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`).join('');
  return `<${node.localName}${attrs}>${inner}</${node.localName}>`;
}
/** A mounted root's markup: its children, as renderToString would give them. */
const innerHtml = (node: FakeNode) => node.childNodes.map(htmlOf).join('');
function byLabel(node: FakeNode, label: string): FakeElement {
  const found = elements(node).filter((e) => e.getAttribute('aria-label') === label);
  assert(found.length > 0, `nothing labelled ${show(label)}`);
  return found[0];
}
function byData(node: FakeNode, name: string, value: string): FakeElement {
  const found = elements(node).filter((e) => e.getAttribute(`data-${name}`) === value);
  assert(found.length > 0, `no data-${name}=${show(value)}`);
  return found[0];
}
const dialogText = (node: FakeNode) => textOf(htmlOf(byRole(node, 'dialog')[0] ?? new FakeElement('div', HTML_NS)));
/** The header's day line as Intl writes it (the server's today, formatted as UTC noon). */
const dayLong = (l: string, d: DayKey) =>
  new Intl.DateTimeFormat(l, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${d}T12:00:00Z`));

const pushes: string[] = [];
const fakeRouter = { push: (href: string) => pushes.push(href), replace: noop, refresh: noop, prefetch: noop, back: noop, forward: noop };

/** What PageGate gives the home: the app router and next-intl. CalendarHome makes its own .ch-home root. */
function inApp(locale: Locale, el: ReactElement): ReactElement {
  const { AppRouterContext } = nodeRequire('next/dist/shared/lib/app-router-context.shared-runtime');
  const provider = { locale, messages: messages[locale], timeZone: TZ } as ComponentProps<typeof NextIntlClientProvider>;
  return createElement(AppRouterContext.Provider, { value: fakeRouter }, createElement(NextIntlClientProvider, provider, el));
}

/** A FamCal user on Telegram (the page's user_id is their Telegram id), and a Google admin. */
const FAMCAL_HOME: CalendarHomeProps = {
  user: { id: 5550001, name: 'Dana', isAdmin: false },
  locale: 'en',
  calendarSource: 'NATIVE',
  needsOAuth: false,
  needsCalendars: false,
  hints: HINTS_ALL,
};
const GOOGLE_HOME: CalendarHomeProps = { ...FAMCAL_HOME, user: { id: 5550002, name: 'Avi', isAdmin: true }, calendarSource: 'GOOGLE' };

/** Mounts the home (the default export, or the container on a fake clock) and lets its first effects run. */
async function mountHome(locale: Locale, props: Partial<CalendarHomeProps> = {}, clock?: ReturnType<typeof fakeClock>) {
  const all: CalendarHomeProps = { ...FAMCAL_HOME, ...props, locale };
  const el = clock ? createElement(CalendarHomeContainer, { ...all, deps: clock.deps }) : createElement(CalendarHome, all);
  const m = mount(inApp(locale, el));
  await settle();
  return { ...m, html: () => innerHtml(m.container), text: () => textOf(innerHtml(m.container)) };
}

/** document's own listeners (visibilitychange), which the fake DOM dropped until now. */
const docListeners: { type: string; fn: (event: Row) => void }[] = [];
fakeDocument.addEventListener = (type: string, fn: (event: Row) => void) => docListeners.push({ type, fn });
fakeDocument.removeEventListener = (type: string, fn: (event: Row) => void) => {
  const i = docListeners.findIndex((l) => l.type === type && l.fn === fn);
  if (i >= 0) docListeners.splice(i, 1);
};
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

/** The markup #15 compares across process zones: the Agenda and two sheets, in each language. */
```

Edit 7 of 7, checks #21-#39, before the last check, which becomes #40 (`scripts/smoke-calendar-home-render.ts:1095`). Before:
```ts
  await check('#21 React logged no warning in any render (keys, nesting, attributes)', () => {
```
After:
```ts
  // ---- CalendarHome (Task D6): the container, in real React with a fake fetch ----

  await check('#21 the container is client-safe: CalendarHome and its parts load no server module', () => {
    const root = path.join(ROOT, 'app/[locale]/dashboard/CalendarHome.tsx');
    assert(require.cache[root] !== undefined, 'CalendarHome is not in require.cache: the check would be empty');
    const loaded = new Set<string>();
    const walk = (id: string) => {
      for (const child of require.cache[id]?.children ?? []) {
        if (loaded.has(child.id)) continue;
        loaded.add(child.id);
        walk(child.id);
      }
    };
    walk(root);
    const parts = ['HomeHeader.tsx', 'HomeBanners.tsx', 'SendSheet.tsx', 'MenuSheet.tsx', 'HomeErrorBoundary.tsx', 'home-shell.ts', 'AgendaView.tsx'].map((f) => `app/[locale]/dashboard/${f}`);
    for (const want of [...parts, 'app/[locale]/PageGate.tsx', 'src/lib/calendar-view/home-loader.ts', 'src/lib/calendar-view/home-client.ts', 'src/lib/command-client.ts']) {
      assert(loaded.has(path.join(ROOT, want)), `${want} not among the loaded modules: the check would be empty`);
    }
    const forbidden = [...loaded].filter((p) =>
      /[\\/](src[\\/](services|utils|config)|@prisma|\.prisma|@upstash|date-fns-tz|@hebcal[\\/]core|googleapis|@googleapis)[\\/]|src[\\/]lib[\\/](page-data|api-auth|prisma)/.test(p),
    );
    assert(forbidden.length === 0, `server modules in the home's graph: ${show(forbidden.map((p) => path.relative(ROOT, p)))}`);
  });

  await check('#22 CalendarHome (en, FamCal, in Telegram): one range request, no dates, the init data in the header only; placeholders, then the server\'s today, its Hebrew date and the Agenda; Telegram\'s theme and a hidden BackButton on mount; no tab bar', async () => {
    resetHome();
    const tg = fakeTelegramHome({ scheme: 'dark' });
    fakeWindow.Telegram = { WebApp: tg.webApp };
    let release: (a: FetchAnswer) => void = noop;
    answerFetch = () => new Promise<FetchAnswer>((resolve) => (release = resolve));
    const m = await mountHome('en');
    try {
      const [first, ...more] = rangeCalls();
      assert(first && more.length === 0 && first.url === '/api/calendar/range?user_id=5550001&sources=famcal', `requests: ${show(rangeCalls().map((c) => c.url))}`);
      assert(first.headers['X-Telegram-Init-Data'] === tg.webApp.initData && !/hash=|auth_date|query_id/.test(first.url), 'the init data in the header, never in the URL');
      assert(first.method === 'GET' && first.credentials === 'same-origin' && first.cache === 'no-store', `request: ${show({ method: first.method, credentials: first.credentials, cache: first.cache })}`);
      const before = m.html();
      assert(/^<div class="ch-home" data-theme="dark" dir="ltr" lang="en">/.test(before), `the root: ${before.slice(0, 120)}`);
      assert(before.includes('class="ch-head-ghost"') && before.includes('aria-busy="true"') && !before.includes('<h1'), 'placeholders until the answer, no made-up day');
      byLabel(m.container, 'Send to chat');
      byLabel(m.container, 'Menu');
      for (const call of ['BackButton.hide()', 'setHeaderColor(bg_color)', 'setBackgroundColor(bg_color)', 'onEvent(themeChanged)']) {
        assert(tg.calls.includes(call), `no ${call} on mount: ${show(tg.calls)}`);
      }
      await React.act(async () => release(ok200(answer({ items: WEEK, carryOvers: [CARRY_PLUMBER, CARRY_BILL, CARRY_OLD] }))));
      await settle();
      const after = m.html();
      assert(after.includes('<h1 class="ch-head-title">Thursday, 15 October</h1><p class="ch-head-sub">4 Cheshvan 5787</p>'), `the header: ${textOf(after).slice(0, 120)}`);
      assertHas(textOf(after), [`Today ${ref.dayShort('en-GB', day(0))} 4 Cheshvan`, 'Still open 5 reminders', '09:30 10:30 Dentist', 'Show next week'], 'the Agenda');
      assertLacks(after, ['role="tablist"', 'role="tab"', 'calendarHome.'], 'Plan D\'s shape (R19)');
      assertLacks(textOf(after), ['Month', 'Agenda', 'Open FamCal in Telegram'], 'no tabs; inside Telegram, no Telegram banner');
      assert(show(ranges()) === show(['famcal default']), `one request in all: ${show(ranges())}`);
    } finally {
      m.unmount();
    }
  });

  await check('#23 he and ru: the root dir="rtl" and the Hebrew header and labels; the Russian header with the genitive Hebrew month (R9); the send icon flips in RTL', async () => {
    resetHome();
    answerFetch = () => ok200(answer({ items: WEEK }));
    const he = await mountHome('he');
    try {
      const html = he.html();
      assert(/^<div class="ch-home" data-theme="light" dir="rtl" lang="he">/.test(html), `the he root: ${html.slice(0, 120)}`);
      assertHas(textOf(html), [`${dayLong('he-IL', TODAY)} ד׳ בחשון תשפ״ז`, 'היום חמישי 15 באוק׳', 'להציג את השבוע הבא'], 'he');
      byLabel(he.container, 'שליחה לצ׳אט');
      byLabel(he.container, 'תפריט');
      assert(html.includes('<svg class="ch-flip"') && /\.ch-home\[dir='rtl'\] \.ch-flip \{\s*transform: scaleX\(-1\);/.test(HOME_SHELL_CSS), 'the send icon flips in RTL');
    } finally {
      he.unmount();
    }
    const ru = await mountHome('ru');
    try {
      const text = ru.text();
      assertHas(text, [`${dayLong('ru-RU', TODAY)} 4 хешвана 5787`, `Сегодня ${ref.dayShort('ru-RU', day(0))}`, 'Показать следующую неделю'], 'ru');
      assertLacks(text, ['Хешван'], 'ru: the genitive, not the nominative');
      byLabel(ru.container, 'Отправить в чат');
      byLabel(ru.container, 'Меню');
    } finally {
      ru.unmount();
    }
    answerFetch = () => ok200(answer({ items: WEEK, hebrewDates: false }));
    const off = await mountHome('en');
    try {
      assert(off.html().includes('<h1 class="ch-head-title">Thursday, 15 October</h1>') && !markup(off.html()).includes('class="ch-head-sub"'), 'no Hebrew date when the route says hebrewDates false');
      assertLacks(off.text(), ['Cheshvan'], 'en, Hebrew dates off');
    } finally {
      off.unmount();
    }
  });

  await check('#24 privacy through the container: no calendar id anywhere in the home, sheet open or not, and a masked partner calendar reads as the partner\'s', async () => {
    resetHome();
    answerFetch = () => ok200(answer({ items: WEEK, carryOvers: [CARRY_PLUMBER, CARRY_BILL, CARRY_OLD] }));
    const m = await mountHome('en');
    try {
      const ids = [MY_CAL.id, NOA_CAL.id].map(String);
      assertLacks(m.html(), [...ids, 'native:', 'cal_'], 'the home');
      m.click(button(m.container, 'Pick up the parcel'));
      assertLacks(m.html(), [...ids, 'native:', 'cal_'], 'the masked item\'s sheet');
      assertHas(dialogText(m.container), ['Calendar Noa’s calendar', 'From Noa'], 'the masked sheet');
    } finally {
      m.unmount();
    }
  });

  await check('#25 Google (fake clock): sources=google with the page\'s user_id; a stale answer asks that window once more after about 3 s, once; a Google error retries once after about 5 s; calendars_gone never retries', async () => {
    const google = (status: NonNullable<RangeResponse['sources']['google']>) => googleAnswer({ items: { [day(0)]: [DINNER] }, sources: { google: status } });
    resetHome();
    const clock = fakeClock('2026-10-15T07:00:00Z');
    answerFetch = () => ok200(google({ status: 'ok', stale: true }));
    const m = await mountHome('en', GOOGLE_HOME, clock);
    try {
      assert(show(ranges()) === show(['google default']) && rangeCalls()[0].query.get('user_id') === '5550002', `first: ${show(rangeCalls().map((c) => c.url))}`);
      assertHas(m.text(), ['Dinner with the Cohens'], 'the stale data shows meanwhile');
      await clock.advance(STALE_RETRY_MS - 100);
      assert(ranges().length === 1, 'not before about 3 s');
      await clock.advance(200);
      assert(show(ranges()) === show(['google default', `google ${day(0)}→${day(7)}`]), `the stale re-request: ${show(ranges())}`);
      await clock.advance(60_000);
      assert(ranges().length === 2, `stale again: it waits for the foreground or Refresh: ${show(ranges())}`);
    } finally {
      m.unmount();
    }

    resetHome();
    const c2 = fakeClock('2026-10-15T07:00:00Z');
    answerFetch = () => ok200(google({ status: 'error', reason: 'transient' }));
    const e = await mountHome('en', GOOGLE_HOME, c2);
    try {
      assertHas(e.text(), ['Couldn’t load Google Calendar Retry'], 'the error row');
      await c2.advance(ERROR_RETRY_MS - 100);
      assert(ranges().length === 1, 'not before about 5 s');
      await c2.advance(200);
      assert(show(ranges()) === show(['google default', `google ${day(0)}→${day(7)}`]), `one automatic retry: ${show(ranges())}`);
      await c2.advance(60_000);
      assert(ranges().length === 2, `and only one: ${show(ranges())}`);
      e.click(button(e.container, 'Retry'));
      await settle();
      assert(show(ranges().slice(2)) === show([`google ${day(0)}→${day(7)}`]), `Retry asks again: ${show(ranges())}`);
    } finally {
      e.unmount();
    }

    resetHome();
    const c3 = fakeClock('2026-10-15T07:00:00Z');
    answerFetch = () => ok200(google({ status: 'error', reason: 'calendars_gone' }));
    const g = await mountHome('en', GOOGLE_HOME, c3);
    try {
      await c3.advance(60_000);
      assert(ranges().length === 1, `calendars_gone: no retry: ${show(ranges())}`);
      assertHas(g.text(), ['Your calendars aren’t available Choose again'], 'its row');
      g.click(button(g.container, 'Choose again'));
      assert(show(pushes) === show(['/en/select-calendars?user_id=5550002']), `Choose again: ${show(pushes)}`);
    } finally {
      g.unmount();
    }
  });

  await check('#26 "Show next week" asks [today+7, today+14); a return to the foreground (visibilitychange, Telegram\'s activated) asks every visible window once; ⋯ → Refresh sends fresh=1 on each and closes the menu', async () => {
    resetHome();
    const tg = fakeTelegramHome();
    fakeWindow.Telegram = { WebApp: tg.webApp };
    answerFetch = (c) => answerFor(c, { items: WEEK });
    // The fixtures' Thursday: a return to the foreground first checks whether that day has ended (#39).
    const m = await mountHome('en', {}, fakeClock('2026-10-15T07:00:00Z'));
    const both = [`famcal ${day(0)}→${day(7)}`, `famcal ${day(7)}→${day(14)}`];
    try {
      assert(tg.calls.includes('onEvent(activated)'), `activated is watched on an 8.0 client: ${show(tg.calls)}`);
      m.click(button(m.container, 'Show next week'));
      await settle();
      assert(show(ranges()) === show(['famcal default', both[1]]), `next week: ${show(ranges())}`);
      assertHas(m.text(), ['Nothing planned Thu 22 – Wed 28 Oct'], 'the second week, answered and empty, folds');
      assert(!m.html().includes('class="ch-ghost"'), 'no placeholders left');

      const held: ((a: FetchAnswer) => void)[] = [];
      answerFetch = () => new Promise<FetchAnswer>((resolve) => held.push(resolve));
      /** Answers the held requests, then forgets every call so far. */
      const release = async () => {
        const calls = rangeCalls();
        await React.act(async () => held.splice(0).forEach((resolve, i) => resolve(answerFor(calls[i], { items: WEEK }))));
        await settle();
        fetchCalls.length = 0;
      };
      fetchCalls.length = 0;
      fakeDocument.visibilityState = 'hidden';
      fireDocument('visibilitychange');
      assert(ranges().length === 0, 'going to the background asks nothing');
      fakeDocument.visibilityState = 'visible';
      fireDocument('visibilitychange');
      assert(show(ranges()) === show(both), `visibilitychange: every visible window: ${show(ranges())}`);
      await release();
      React.act(() => tg.fire('activated'));
      assert(show(ranges()) === show(both), `Telegram's activated: every visible window: ${show(ranges())}`);
      await release();
      fireDocument('visibilitychange');
      React.act(() => tg.fire('activated'));
      assert(show(ranges()) === show(both), `both at once: each window once: ${show(ranges())}`);
      await release();

      fetchCalls.length = 0;
      answerFetch = (c) => answerFor(c, { items: WEEK });
      m.click(byLabel(m.container, 'Menu'));
      assert(byRole(m.container, 'dialog').length === 1, 'the menu is open');
      m.click(byData(m.container, 'menu', 'refresh'));
      await settle();
      assert(show(ranges()) === show(both.map((w) => `${w} fresh`)), `Refresh: ${show(ranges())}`);
      assert(byRole(m.container, 'dialog').length === 0, 'the menu closed');
    } finally {
      m.unmount();
      fakeWindow.Telegram = undefined;
    }
    assert(tg.calls.includes('offEvent(activated)'), 'activated is let go on unmount');
  });

  await check('#27 midnight in the user\'s timezone: the store starts over with a no-dates request and the header moves to the new day; a stale re-request for the day that ended is dropped; the day check never waits more than an hour, and lands after a midnight that DST skips', async () => {
    resetHome();
    const clock = fakeClock('2026-10-15T20:59:30Z'); // 23:59:30 in Israel, Thursday 15 October
    let serverToday = TODAY;
    answerFetch = () => ok200(serverToday === TODAY ? answer({ items: WEEK }) : answer({ today: day(1), from: day(1), to: day(8), items: { [day(1)]: [GRANDMA] } }));
    const m = await mountHome('en', {}, clock);
    try {
      assert(m.html().includes('<h1 class="ch-head-title">Thursday, 15 October</h1>'), 'Thursday');
      const wait = clock.pending()[0];
      assert(wait > 30_000 && wait <= 31_000, `the check waits until just after midnight: ${wait} ms`);
      serverToday = day(1);
      await clock.advance(31_000);
      assert(show(ranges()) === show(['famcal default', 'famcal default']), `after midnight: ${show(ranges())}`);
      assert(m.html().includes('<h1 class="ch-head-title">Friday, 16 October</h1>'), `the header moved on: ${m.text().slice(0, 80)}`);
      assertHas(m.text(), [`Today ${ref.dayShort('en-GB', day(1))}`, 'All day Grandma visits'], 'the new today');
      assert(clock.pending().length > 0 && clock.pending().every((ms) => ms <= 3_600_000), `pending: ${show(clock.pending())}`);
    } finally {
      m.unmount();
    }
    // A stale Google answer two seconds before midnight: its re-request is for a day that has gone, so it is dropped.
    resetHome();
    const late = fakeClock('2026-10-15T20:59:58Z');
    let googleToday = TODAY;
    answerFetch = () =>
      ok200(googleToday === TODAY ? googleAnswer({ sources: { google: { status: 'ok', stale: true } } }) : googleAnswer({ today: day(1), from: day(1), to: day(8) }));
    const g = await mountHome('en', GOOGLE_HOME, late);
    try {
      googleToday = day(1);
      await late.advance(STALE_RETRY_MS + 1000);
      assert(show(ranges()) === show(['google default', 'google default']), `only the new day's request: ${show(ranges())}`);
    } finally {
      g.unmount();
    }
    assert(msUntilDayCheck(Date.parse('2026-10-15T07:00:00Z'), TZ) === 3_600_000, 'at 10:00 the check waits an hour');
    assert(isPastDay(Date.parse('2026-10-15T21:00:01Z'), TZ, TODAY) && !isPastDay(Date.parse('2026-10-15T20:59:59Z'), TZ, TODAY), 'midnight in Israel');
    // Chile skips 00:00 on 6 September 2026: from 23:30 the check lands at 01:00, the new day.
    const santiago = Date.parse('2026-09-06T03:30:00Z');
    const delay = msUntilDayCheck(santiago, 'America/Santiago');
    assert(delay > 30 * 60_000 && delay <= 31 * 60_000 && isPastDay(santiago + delay, 'America/Santiago', '2026-09-05'), `Santiago: ${delay} ms`);
  });

  await check('#28 404 not_enabled reloads once (PageGate then shows today\'s dashboard), and with the item sheet open Telegram\'s BackButton is let go (offClick, hide) before the reload; within the guard, the retry card, whose Retry reloads by hand; 401, 403 and any other 404 show PageGate\'s card and nothing more is asked', async () => {
    resetHome();
    answerFetch = () => ({ status: 404, body: { error: 'not_enabled' } });
    const a = await mountHome('en');
    a.unmount();
    assert(show(reloads) === show(['reload']) && fakeWindow.sessionStorage.getItem(NOT_ENABLED_RELOAD_KEY) !== null, `one reload, guarded: ${show(reloads)}`);
    const b = await mountHome('en');
    try {
      assert(show(reloads) === show(['reload']), `no second reload within the minute: ${show(reloads)}`);
      assertHas(b.text(), ['Something went wrong Your calendar didn’t load. Try again. Retry'], 'the card');
      b.click(button(b.container, 'Retry'));
      assert(show(reloads) === show(['reload', 'reload']), 'Retry reloads by hand');
    } finally {
      b.unmount();
    }

    // The switch turned back while the item sheet is open (say, back from "Open in Google
    // Calendar"): a reload runs no cleanup and the client keeps the button, so it goes first.
    resetHome();
    const open = fakeTelegramHome();
    fakeWindow.Telegram = { WebApp: open.webApp };
    fakeWindow.location = { hash: '', reload: () => void open.calls.push('location.reload()') };
    answerFetch = (c) => answerFor(c, { items: WEEK });
    const o = await mountHome('en', {}, fakeClock('2026-10-15T07:00:00Z'));
    try {
      o.click(button(o.container, 'Dentist'));
      assert(open.calls.includes('BackButton.show()') && open.backHandlers() === 1, `the sheet shows the BackButton: ${show(open.calls)}`);
      open.calls.length = 0;
      answerFetch = () => ({ status: 404, body: { error: 'not_enabled' } });
      fireDocument('visibilitychange');
      await settle();
      const steps = open.calls.filter((c) => c.startsWith('BackButton') || c === 'location.reload()');
      assert(show(steps.slice(0, 3)) === show(['BackButton.offClick', 'BackButton.hide()', 'location.reload()']), `before the reload: ${show(steps)}`);
      assert(open.backHandlers() === 0, 'no handler left');
    } finally {
      o.unmount();
      fakeWindow.Telegram = undefined;
    }

    for (const [status, error] of [[401, 'Unauthorized'], [403, 'Account suspended'], [404, 'User not found']] as const) {
      resetHome();
      const tg = fakeTelegramHome();
      fakeWindow.Telegram = { WebApp: tg.webApp };
      answerFetch = () => ({ status, body: { error } });
      const m = await mountHome('en');
      try {
        assertHas(m.text(), ['Please open this from the bot', 'Back to the chat'], `${status} in Telegram`);
        assertLacks(m.text(), ['Show next week', 'Today'], `${status}: no Agenda`);
        m.click(button(m.container, 'Back to the chat'));
        assert(tg.calls.includes('close()'), `${status}: its button closes the Mini App`);
        fireDocument('visibilitychange');
        React.act(() => tg.fire('activated'));
        await settle();
        assert(ranges().length === 1 && reloads.length === 0, `${status}: nothing more is asked: ${show(ranges())}`);
      } finally {
        m.unmount();
      }
    }
    resetHome();
    answerFetch = () => ({ status: 401, body: { error: 'Unauthorized' } });
    const web = await mountHome('he');
    try {
      const html = web.html();
      assert(html.includes('href="https://wa.me/972548524687?text=settings"') && html.includes('href="https://t.me/family_calendar_telegram_bot?start=dashboard"'), `the browser card's links: ${textOf(html).slice(0, 160)}`);
    } finally {
      web.unmount();
    }
  });

  await check('#29 before any answer, a 429 shows the busy card and a 500, no answer or a body that isn\'t a RangeResponse the retry card, with no loop; Retry asks again. Once the facts are pinned, a 429 on the next week is that window\'s busy row', async () => {
    const cases: [string, FetchAnswer, string][] = [
      ['429', { status: 429, body: { error: 'Too many requests. Please wait a minute.' } }, 'Busy right now, try again in a minute Retry'],
      ['500', { status: 500, body: { error: 'internal_error' } }, 'Something went wrong Your calendar didn’t load. Try again. Retry'],
      ['no answer', 'throw', 'Something went wrong Your calendar didn’t load. Try again. Retry'],
      ['not a RangeResponse', { status: 200, body: { hello: 'world' } }, 'Something went wrong Your calendar didn’t load. Try again. Retry'],
    ];
    for (const [name, failure, card] of cases) {
      resetHome();
      answerFetch = () => failure;
      const m = await mountHome('en');
      try {
        assertHas(m.text(), [card], name);
        assertLacks(m.text(), ['Show next week', 'Loading your calendar'], `${name}: the card, not placeholders`);
        assert(ranges().length === 1, `${name}: asked once, no loop: ${show(ranges())}`);
        answerFetch = () => ok200(answer({ items: WEEK }));
        m.click(button(m.container, 'Retry'));
        await settle();
        assert(show(ranges()) === show(['famcal default', 'famcal default']), `${name}: Retry: ${show(ranges())}`);
        assertHas(m.text(), ['Today', 'Dentist'], `${name}: then the Agenda`);
      } finally {
        m.unmount();
      }
    }
    resetHome();
    answerFetch = (c) => (c.query.has('from') ? { status: 429, body: {} } : ok200(answer({ items: WEEK })));
    const m = await mountHome('en');
    try {
      m.click(button(m.container, 'Show next week'));
      await settle();
      assertHas(m.text(), ['Busy right now, try again in a minute Retry', 'Dentist'], 'the busy row above the days');
    } finally {
      m.unmount();
    }
  });

  await check('#30 the send sheet (R5): five options in order; a tap posts its command for the page\'s user_id; in Telegram a 2xx closes the app with the spinner kept, one send at a time; in a browser "Sent to WhatsApp"; 429, 403, no answer and a 500 each say why, and the sheet stays', async () => {
    resetHome();
    const tg = fakeTelegramHome();
    fakeWindow.Telegram = { WebApp: tg.webApp };
    let hold: (a: FetchAnswer) => void = noop;
    answerFetch = (c) => (c.path === '/api/execute-command' ? new Promise<FetchAnswer>((resolve) => (hold = resolve)) : ok200(answer({ items: WEEK })));
    const m = await mountHome('en');
    try {
      m.click(byLabel(m.container, 'Send to chat'));
      const dialog = byRole(m.container, 'dialog')[0];
      assert(dialog?.getAttribute('aria-label') === 'Send to chat' && dialog.getAttribute('aria-modal') === 'true', 'a modal dialog labelled Send to chat');
      assertHas(
        dialogText(m.container),
        ['Send to chat FamCal sends it to your chat', 'Today’s summary Events and reminders for today', 'Tomorrow’s summary What’s coming up tomorrow', 'This week Coming up this week', 'Next week Coming up next week', 'Weather Today’s forecast', 'Close'],
        'the options',
      );
      const order = elements(dialog).filter((e) => e.hasAttribute('data-send')).map((e) => e.getAttribute('data-send'));
      assert(show(order) === show(['today', 'tomorrow', 'thisWeek', 'nextWeek', 'weather']), `order: ${show(order)}`);
      m.click(byData(dialog, 'send', 'today'));
      const [sent, ...extra] = sendCalls();
      assert(sent && extra.length === 0 && sent.method === 'POST' && sent.body?.user_id === 5550001 && sent.body?.command === 'summary', `the call: ${show(sendCalls().map((c) => c.body))}`);
      assert(sent.headers['X-Telegram-Init-Data'] === tg.webApp.initData && sent.body?.initData === tg.webApp.initData, 'the init data header, and the body copy as the fallback');
      assertHas(dialogText(m.container), ['Today’s summary Sending…'], 'the spinner');
      assert(byData(dialog, 'send', 'weather').getAttribute('aria-disabled') === 'true', 'the other options wait');
      m.click(byData(dialog, 'send', 'weather'));
      assert(sendCalls().length === 1, 'one send at a time');
      await React.act(async () => hold({ status: 200, body: { success: true } }));
      await settle();
      assert(tg.calls.includes('close()'), 'a 2xx closes the Mini App');
      assertHas(dialogText(m.container), ['Today’s summary Sending…'], 'the spinner stays while it closes');
    } finally {
      m.unmount();
    }

    const replies: [string, FetchAnswer, 'today' | 'tomorrow' | 'weather', string, Row][] = [
      ['browser 200', { status: 200, body: { success: true } }, 'tomorrow', 'Sent to WhatsApp', { command: 'summary', args: 'tmrw' }],
      ['429', { status: 429, body: {} }, 'weather', 'Lots of requests right now. Try again in a minute.', { command: 'weather' }],
      ['403', { status: 403, body: {} }, 'today', 'Please reopen FamCal from the chat and try again.', { command: 'summary' }],
      ['no answer', 'throw', 'today', 'No connection. Check your internet and try again.', { command: 'summary' }],
      ['500', { status: 500, body: {} }, 'today', 'Couldn’t send it. Try again.', { command: 'summary' }],
    ];
    for (const [name, reply, item, line, body] of replies) {
      resetHome();
      answerFetch = (c) => (c.path === '/api/execute-command' ? reply : ok200(answer({ items: WEEK })));
      const b = await mountHome('en');
      try {
        b.click(byLabel(b.container, 'Send to chat'));
        b.click(byData(b.container, 'send', item));
        await settle();
        const call = sendCalls()[0];
        assert(call && call.body?.command === body.command && call.body?.args === body.args && call.body?.user_id === 5550001 && !('initData' in (call.body ?? {})), `${name}: ${show(call?.body)}`);
        assert(byRole(b.container, 'dialog').length === 1, `${name}: the sheet stays open`);
        assertHas(dialogText(b.container), [line], name);
        assert(byData(b.container, 'send', 'today').getAttribute('aria-disabled') === null, `${name}: ready for another try`);
      } finally {
        b.unmount();
      }
    }

    resetHome();
    const stuck = fakeTelegramHome({ closeThrows: true });
    fakeWindow.Telegram = { WebApp: stuck.webApp };
    answerFetch = (c) => (c.path === '/api/execute-command' ? { status: 200, body: { success: true } } : ok200(answer({ items: WEEK })));
    const s = await mountHome('he');
    try {
      s.click(byLabel(s.container, 'שליחה לצ׳אט'));
      s.click(byData(s.container, 'send', 'nextWeek'));
      await settle();
      assert(sendCalls()[0]?.body?.command === 'nextweek', 'nextweek');
      assertHas(dialogText(s.container), ['נשלח. אפשר להציץ בצ׳אט'], 'Telegram couldn\'t close the app: the answer is in the chat');
    } finally {
      s.unmount();
    }
  });

  await check('#31 the ⋯ menu (R6): FamCal users get Calendars and Partner, Google users Choose calendars and Reconnect Google, admins the Admin panel; each opens its page with the page\'s user_id, and the sheet closes', async () => {
    const famcal = menuEntries({ calendarSource: 'NATIVE', isAdmin: false, locale: 'en', userId: 5550001 });
    assert(show(famcal.map((e) => e.id)) === show(['settings', 'calendars', 'partner', 'subscription', 'refresh', 'feedback']), `FamCal: ${show(famcal)}`);
    const google = menuEntries({ calendarSource: 'GOOGLE', isAdmin: true, locale: 'ru', userId: 5550002 });
    const want = [
      ['settings', '/ru/settings?user_id=5550002'],
      ['chooseCalendars', '/ru/select-calendars?user_id=5550002'],
      ['reconnectGoogle', '/refresh-token?user_id=5550002'],
      ['subscription', '/ru/subscription?user_id=5550002'],
      ['refresh', null],
      ['feedback', '/ru/feedback?user_id=5550002'],
      ['admin', '/ru/admin-panel?user_id=5550002'],
    ];
    assert(show(google.map((e) => [e.id, e.href])) === show(want), `Google admin: ${show(google)}`);

    resetHome();
    answerFetch = () => ok200(answer({ items: WEEK }));
    const m = await mountHome('en');
    try {
      m.click(byLabel(m.container, 'Menu'));
      assert(byRole(m.container, 'dialog')[0]?.getAttribute('aria-label') === 'Menu', 'a dialog labelled Menu');
      assertHas(dialogText(m.container), ['Settings Calendars Partner Subscription Refresh Feedback Close'], 'the FamCal menu');
      assertLacks(dialogText(m.container), ['Choose calendars', 'Reconnect Google', 'Admin panel'], 'no Google entry, no admin entry');
      m.click(byData(m.container, 'menu', 'partner'));
      assert(show(pushes) === show(['/en/pair?user_id=5550001']), `push: ${show(pushes)}`);
      assert(byRole(m.container, 'dialog').length === 0, 'the menu closed');
    } finally {
      m.unmount();
    }
    resetHome();
    answerFetch = () => ok200(googleAnswer({ items: { [day(0)]: [DINNER] } }));
    const g = await mountHome('ru', GOOGLE_HOME);
    try {
      g.click(byLabel(g.container, 'Меню'));
      assertHas(dialogText(g.container), ['Настройки Выбрать календари Переподключить Google Подписка Обновить Обратная связь Панель администратора'], 'the Google admin\'s menu (ru)');
      g.click(byData(g.container, 'menu', 'admin'));
      assert(show(pushes) === show(['/ru/admin-panel?user_id=5550002']), `push: ${show(pushes)}`);
    } finally {
      g.unmount();
    }
  });

  await check('#32 the banners (§7.2), in order: trial, location, the Google setup card, Reconnect (token or scopes; never with Connect, never for FamCal) and, in a browser, Open FamCal in Telegram; each opens its page', async () => {
    const base: BannerFacts = { calendarSource: 'NATIVE', needsOAuth: false, needsCalendars: false, reconnect: null, inTelegram: true };
    const cases: [Partial<BannerFacts>, string[]][] = [
      [{}, []],
      [{ trialDaysLeft: 5, hasLocation: false, inTelegram: false }, ['trial', 'location', 'openInTelegram']],
      [{ trialDaysLeft: 0, hasLocation: true }, []],
      [{ trialDaysLeft: null }, []],
      [{ reconnect: 'token' }, []],
      [{ calendarSource: 'GOOGLE', hasLocation: false }, []],
      [{ calendarSource: 'GOOGLE', needsOAuth: true, needsCalendars: true, hasLocation: false, reconnect: 'token' }, ['location', 'connectGoogle']],
      [{ calendarSource: 'GOOGLE', needsCalendars: true }, ['chooseCalendars']],
      [{ calendarSource: 'GOOGLE', reconnect: 'token' }, ['reconnect']],
      [{ calendarSource: 'GOOGLE', reconnect: 'scopes', inTelegram: false }, ['reconnectScopes', 'openInTelegram']],
    ];
    for (const [facts, want] of cases) {
      const got = homeBanners({ ...base, ...facts });
      assert(show(got) === show(want), `${show(facts)}: ${show(got)}, want ${show(want)}`);
    }

    resetHome();
    answerFetch = () => ok200(answer({ items: WEEK }));
    const m = await mountHome('en', { trialDaysLeft: 5, hasLocation: false });
    try {
      assertHas(m.text(), ['5 days left in your trial See plans Set your location for the right times Set location Open FamCal in Telegram Reminders, voice summaries and more are waiting there.'], 'en, in a browser');
      const link = byData(m.container, 'banner', 'openInTelegram');
      assert(link.localName === 'a' && link.getAttribute('href') === 'https://t.me/family_calendar_telegram_bot?start=connect' && link.getAttribute('target') === '_blank', `the Telegram link: ${htmlOf(link).slice(0, 160)}`);
      m.click(byData(m.container, 'banner', 'trial'));
      m.click(byData(m.container, 'banner', 'location'));
      assert(show(pushes) === show(['/en/subscription?user_id=5550001', '/en/settings?user_id=5550001']), `pushes: ${show(pushes)}`);
    } finally {
      m.unmount();
    }
    resetHome();
    const tg = fakeTelegramHome();
    fakeWindow.Telegram = { WebApp: tg.webApp };
    answerFetch = () => ok200(googleAnswer({ sources: { google: { status: 'reconnect', reason: 'scopes' } }, calendars: [] }));
    const g = await mountHome('he', { ...GOOGLE_HOME, trialDaysLeft: 2 });
    try {
      assertHas(g.text(), ['נשארו יומיים לתקופת הניסיון', 'FamCal צריך הרשאה לקרוא את היומן צריך להתחבר מחדש ל-Google ולאשר גישה ליומן. חיבור מחדש ל-Google'], 'he: the trial (two days) and the scopes banner');
      assertLacks(g.text(), ['לפתוח את FamCal בטלגרם', 'Nothing planned'], 'inside Telegram: no Telegram banner; a reconnect is never "nothing planned"');
      g.click(byData(g.container, 'banner', 'reconnectScopes'));
      assert(show(pushes) === show(['/refresh-token?user_id=5550002']), `pushes: ${show(pushes)}`);
    } finally {
      g.unmount();
    }
  });

  await check('#33 "Times in <zone>" shows only when the device is in another zone than the route\'s (an alias is the same zone)', async () => {
    const cases: [Locale, string | null, string | null][] = [
      ['en', 'Europe/London', 'Times in Israel Time'],
      ['he', 'America/New_York', 'השעות לפי שעון ישראל'],
      ['ru', 'Europe/Moscow', 'Часовой пояс: Израиль'],
      ['en', 'Asia/Jerusalem', null],
      ['en', 'Asia/Tel_Aviv', null],
      ['en', null, null],
    ];
    for (const [locale, device, want] of cases) {
      resetHome();
      answerFetch = () => ok200(answer({ items: WEEK }));
      const m = await mountHome(locale, {}, fakeClock('2026-10-15T07:00:00Z', device));
      try {
        if (want) assertHas(m.text(), [want], `${locale} on ${device}`);
        else assert(!markup(m.html()).includes('class="ch-head-zone"'), `${device}: no zone line`);
      } finally {
        m.unmount();
      }
    }
    assert(!zoneDiffers('Asia/Kolkata', 'Asia/Calcutta') && zoneDiffers('UTC', TZ) && !zoneDiffers(null, TZ), 'zoneDiffers');
  });

  await check('#34 the shell\'s CSS (§7.1): nothing under 11 px, taps at least 44 px, logical properties only, no hover, overflow-x: clip (never hidden), the stable viewport height, both safe-area families with 0 fallbacks, no transform or filter on the frame', () => {
    const css = HOME_SHELL_CSS;
    const sizes = [...css.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
    assert(sizes.length > 10 && Math.min(...sizes) >= 11, `font sizes: ${show(sizes)}`);
    assert(!/font-size:\s*[\d.]+(?:em|rem|%)|font:\s/.test(css), 'every font size in px');
    const rule = (selector: string) => {
      const m = new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(css);
      assert(m, `no rule ${selector}`);
      return m[1];
    };
    for (const selector of ['.ch-icon-btn', '.ch-banner', '.ch-option', '.ch-option-compact', '.ch-home-card-action']) {
      const min = /min-height:\s*(\d+)px/.exec(rule(selector));
      assert(min && Number(min[1]) >= 44, `${selector} min-height ${min?.[1]}`);
    }
    assert(/min-width:\s*44px/.test(rule('.ch-icon-btn')), '.ch-icon-btn min-width 44px');
    const physical = css.match(/(?:margin|padding|border)-(?:left|right)|(?:^|[\s;{])(?:left|right)\s*:|text-align:\s*(?:left|right)|float:/g);
    assert(!physical, `physical properties: ${show(physical)}`);
    assert(!/:hover/.test(css), 'no hover styles');
    const frame = rule('.ch-home');
    assert(!/overflow:\s*hidden/.test(css) && /overflow-x:\s*clip/.test(frame), 'overflow-x: clip, never overflow: hidden');
    assert(frame.includes('min-height: var(--tg-viewport-stable-height, 100dvh)'), 'the stable viewport height');
    for (const v of ['--tg-safe-area-inset-top, 0px', '--tg-content-safe-area-inset-top, 0px', '--tg-safe-area-inset-left, 0px', '--tg-content-safe-area-inset-left, 0px', '--tg-safe-area-inset-right, 0px', '--tg-content-safe-area-inset-right, 0px']) {
      assert(frame.includes(`var(${v})`), `no var(${v}) on the frame`);
    }
    assert(!/\b(?:transform|filter)\s*:/.test(frame), 'no transform or filter on the frame (the sheets are position: fixed)');
  });

  await check('#35 the error boundary (§5): a render error shows the Reload card in the home\'s look and language; a chunk-load error reloads once by itself, never twice in a minute', async () => {
    assert(
      isChunkLoadError(Object.assign(new Error('Loading chunk 123 failed.'), { name: 'ChunkLoadError' })) &&
        isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: https://famcal.bot/_next/static/chunks/x.js')) &&
        isChunkLoadError(new TypeError('Importing a module script failed.')) &&
        !isChunkLoadError(new TypeError('x is undefined')),
      'isChunkLoadError',
    );
    const el = CalendarHome(FAMCAL_HOME) as ReactElement;
    assert(el.type === HomeErrorBoundary, 'the default export wraps the home in the boundary');
    const crash = (locale: Locale, error: Error) => {
      const Thrower = () => {
        throw error;
      };
      return mount(inApp(locale, createElement(HomeErrorBoundary, null, createElement(Thrower))), { onCaughtError: noop, onUncaughtError: noop });
    };
    resetHome();
    appLogs.length = 0;
    const a = crash('he', new TypeError('x is undefined'));
    try {
      const html = innerHtml(a.container);
      assert(/^<div class="ch-home" data-theme="light" dir="rtl" lang="he">/.test(html), `the card's root: ${html.slice(0, 120)}`);
      assertHas(textOf(html), ['משהו השתבש היומן נתקע. טעינה מחדש בדרך כלל עוזרת. לטעון מחדש'], 'the he card');
      assert(reloads.length === 0, 'a plain error never reloads by itself');
      a.click(button(a.container, 'לטעון מחדש'));
      assert(show(reloads) === show(['reload']), 'Reload reloads');
      assert(appLogs.some((l) => l.startsWith('[calendar-home] The home failed to render')), `logged: ${show(appLogs)}`);
    } finally {
      a.unmount();
    }
    resetHome();
    const chunk = Object.assign(new Error('Loading chunk 77 failed.'), { name: 'ChunkLoadError' });
    crash('en', chunk).unmount();
    assert(show(reloads) === show(['reload']) && fakeWindow.sessionStorage.getItem(CHUNK_RELOAD_KEY) !== null, `a chunk-load error reloads once: ${show(reloads)}`);
    const c = crash('en', chunk);
    try {
      assert(show(reloads) === show(['reload']), `not twice within a minute: ${show(reloads)}`);
      assertHas(textOf(innerHtml(c.container)), ['Something went wrong The calendar ran into a problem. Reloading usually fixes it. Reload'], 'the card instead');
    } finally {
      c.unmount();
    }
    appLogs.length = 0;
  });

  await check('#36 a range request that never settles is aborted after about 15 s and counts as no answer: before any answer, the retry card, and the next return to the foreground asks again; once the facts are pinned, a hung refetch no longer holds back the next one', async () => {
    resetHome();
    const clock = fakeClock('2026-10-15T07:00:00Z');
    answerFetch = () => new Promise<FetchAnswer>(() => undefined);
    const m = await mountHome('en', {}, clock);
    try {
      assert(show(ranges()) === show(['famcal default']), `first: ${show(ranges())}`);
      assert(clock.pending().includes(RANGE_TIMEOUT_MS), `a ${RANGE_TIMEOUT_MS} ms limit on the request: ${show(clock.pending())}`);
      await clock.advance(RANGE_TIMEOUT_MS - 1000);
      assertHas(m.text(), ['Loading your calendar…'], 'still loading after 14 s');
      await clock.advance(6000);
      assert(rangeCalls()[0].signal?.aborted === true, 'the request was aborted');
      assertHas(m.text(), ['Something went wrong Your calendar didn’t load. Try again. Retry'], 'after 20 s, the retry card');
      assert(ranges().length === 1, `no loop: ${show(ranges())}`);
      answerFetch = (c) => answerFor(c, { items: WEEK });
      fireDocument('visibilitychange');
      await settle();
      assert(show(ranges()) === show(['famcal default', 'famcal default']), `the foreground asks again: ${show(ranges())}`);
      assertHas(m.text(), ['Today', 'Dentist'], 'then the Agenda');
      // The facts are pinned: a refetch that hangs is let go too.
      answerFetch = () => new Promise<FetchAnswer>(() => undefined);
      fireDocument('visibilitychange');
      fireDocument('visibilitychange');
      assert(show(ranges().slice(2)) === show([`famcal ${day(0)}→${day(7)}`]), `in flight, a second return is deduped: ${show(ranges())}`);
      await clock.advance(20_000);
      answerFetch = (c) => answerFor(c, { items: WEEK });
      fireDocument('visibilitychange');
      await settle();
      assert(show(ranges().slice(2)) === show([`famcal ${day(0)}→${day(7)}`, `famcal ${day(0)}→${day(7)}`]), `past the limit, the next return asks again: ${show(ranges())}`);
      assertHas(m.text(), ['Dentist'], 'the data stays meanwhile');
      assertLacks(m.text(), ['Something went wrong'], 'no card once the facts are pinned');
    } finally {
      m.unmount();
    }
  });

  await check('#37 Telegram\'s BackButton is the container\'s one (§7.6): hidden on mount; shown while the item sheet, the Send sheet or the ⋯ menu is open; a tap (also Android\'s back gesture) closes only that sheet, then offClick and hide; a store drop closes the item sheet for good', async () => {
    resetHome();
    const tg = fakeTelegramHome();
    fakeWindow.Telegram = { WebApp: tg.webApp };
    const clock = fakeClock('2026-10-15T20:59:30Z'); // 23:59:30 in Israel, Thursday 15 October
    let serverToday = TODAY;
    answerFetch = () => ok200(serverToday === TODAY ? answer({ items: WEEK }) : answer({ today: day(1), from: day(1), to: day(8), items: { [day(1)]: [GRANDMA] } }));
    const m = await mountHome('en', {}, clock);
    const back = () => tg.calls.filter((c) => c.startsWith('BackButton'));
    try {
      assert(show(back()) === show(['BackButton.hide()']), `on mount: ${show(back())}`);
      const dentist = button(m.container, 'Dentist');
      dentist.focus();
      const sheets: [string, () => FakeElement][] = [
        ['the item sheet', () => dentist],
        ['the Send sheet', () => byLabel(m.container, 'Send to chat')],
        ['the menu', () => byLabel(m.container, 'Menu')],
      ];
      for (const [name, opener] of sheets) {
        const target = opener();
        target.focus();
        tg.calls.length = 0;
        m.click(target);
        assert(byRole(m.container, 'dialog').length === 1, `${name} is open`);
        assert(show(back()) === show(['BackButton.onClick', 'BackButton.show()']), `${name} open: ${show(back())}`);
        tg.calls.length = 0;
        React.act(() => tg.fire('backButtonClicked'));
        assert(byRole(m.container, 'dialog').length === 0, `the BackButton closed ${name}`);
        assert(show(back()) === show(['BackButton.offClick', 'BackButton.hide()']), `${name} closed: ${show(back())}`);
        assert(tg.backHandlers() === 0, `${name}: no handler left`);
        assert(fakeDocument.activeElement === target, `${name}: focus is back where it was`);
        assertHas(m.text(), ['Thursday, 15 October', 'Dentist', 'Show next week'], `only ${name} closed`);
      }
      // Midnight with the sheet open: the store drops, the sheet closes for good, the button goes.
      m.click(button(m.container, 'Send the school form'));
      tg.calls.length = 0;
      serverToday = day(1);
      await clock.advance(31_000);
      assert(show(back()) === show(['BackButton.offClick', 'BackButton.hide()']), `the drop let the button go: ${show(back())}`);
      assertHas(m.text(), ['Friday, 16 October', 'Grandma visits'], 'the new day');
      assert(byRole(m.container, 'dialog').length === 0 && tg.backHandlers() === 0, 'the next answer does not open it again');
    } finally {
      m.unmount();
      fakeWindow.Telegram = undefined;
    }
  });

  await check('#38 a Google user who connected but hasn\'t chosen calendars (the route answers ok with 7 empty days): the Choose your calendars banner, and under it no "Nothing planned", no hint, no fold, no "Show next week"; before connecting, the Connect banner the same way', async () => {
    const cases: [Locale, Partial<CalendarHomeProps>, RangeResponse, string, string, string[]][] = [
      ['en', { needsCalendars: true }, googleAnswer({ calendars: [] }), 'chooseCalendars', 'Choose your calendars Pick the Google calendars to show here and in your summaries.', ['Nothing planned', 'voice message', 'Remind me', 'Show next week', 'Today', 'Tomorrow']],
      ['he', { needsCalendars: true }, googleAnswer({ calendars: [] }), 'chooseCalendars', 'בחירת יומנים אילו יומני Google להציג כאן ובסיכומים?', ['אין אירועים', 'הודעה קולית', 'תזכיר לי', 'להציג את השבוע הבא', 'היום', 'מחר']],
      ['en', { needsOAuth: true, needsCalendars: true }, googleAnswer({ sources: { google: { status: 'reconnect', reason: 'token' } }, calendars: [] }), 'connectGoogle', 'Connect Google Calendar Your calendar shows up here once it’s connected.', ['Nothing planned', 'Reconnect', 'Show next week', 'Today', 'Tomorrow']],
    ];
    for (const [locale, setup, reply, banner, title, absent] of cases) {
      resetHome();
      answerFetch = () => ok200(reply);
      const m = await mountHome(locale, { ...GOOGLE_HOME, ...setup });
      try {
        assertHas(m.text(), [title], `${locale} ${banner}`);
        assert(m.html().includes(`data-banner="${banner}"`), `${locale}: the ${banner} banner`);
        assertLacks(m.text(), absent, `${locale} ${banner}: no Agenda under the banner`);
        assert(!/class="ch-(?:fold|ghost|empty|day-head|more)\b/.test(markup(m.html())), `${locale} ${banner}: no fold, placeholder, empty state, day or button`);
        assert(show(ranges()) === show(['google default']), `${locale}: one request: ${show(ranges())}`);
        m.click(byData(m.container, 'banner', banner));
        const want = banner === 'chooseCalendars' ? `/${locale}/select-calendars?user_id=5550002` : '/refresh-token?user_id=5550002';
        assert(show(pushes) === show([want]), `${banner} opens ${want}: ${show(pushes)}`);
      } finally {
        m.unmount();
      }
    }
  });

  await check('#39 back in the foreground after the night, the midnight timer not yet run (iOS suspends timers): the store starts over at once with a no-dates request, the header and Today move to the new day, yesterday\'s items are never labelled Today, and the late timer resets nothing; a device clock that runs ahead resets once, then only refetches; with init data over a day old the route answers 401 and the home shows PageGate\'s card', async () => {
    const overnight = async (reply: (today: DayKey) => FetchAnswer | Promise<FetchAnswer>) => {
      resetHome();
      const tg = fakeTelegramHome();
      fakeWindow.Telegram = { WebApp: tg.webApp };
      const clock = fakeClock('2026-10-15T18:00:00Z'); // 21:00 Thursday in Israel
      answerFetch = () => ok200(answer({ items: WEEK }));
      const m = await mountHome('en', {}, clock);
      assert(m.html().includes('<h1 class="ch-head-title">Thursday, 15 October</h1>'), 'Thursday');
      assert(clock.pending().some((ms) => ms <= 3_600_000), `the day check is armed: ${show(clock.pending())}`);
      clock.jump(10 * 3_600_000); // 07:00 Friday in Israel; the timer never ran
      answerFetch = () => reply(day(1));
      fetchCalls.length = 0;
      return { tg, clock, m };
    };

    let release: (a: FetchAnswer) => void = noop;
    const { tg, clock, m } = await overnight(() => new Promise<FetchAnswer>((resolve) => (release = resolve)));
    try {
      React.act(() => tg.fire('activated'));
      await settle();
      assert(show(ranges()) === show(['famcal default']), `one no-dates request, not yesterday's window: ${show(ranges())}`);
      assertLacks(m.text(), ['Thursday, 15 October', 'Dentist', 'Today'], 'until the answer: placeholders, never yesterday as Today');
      await React.act(async () => release(ok200(answer({ today: day(1), from: day(1), to: day(8), items: { [day(1)]: [GRANDMA] } }))));
      await settle();
      assert(m.html().includes('<h1 class="ch-head-title">Friday, 16 October</h1>'), `the header: ${m.text().slice(0, 80)}`);
      assertHas(m.text(), [`Today ${ref.dayShort('en-GB', day(1))}`, 'All day Grandma visits'], 'the new Today');
      assertLacks(m.text(), ['Dentist', 'Send the school form'], 'nothing of Thursday\'s');
      // The suspended timer is due now; it was dropped with the old day and resets nothing.
      await clock.advance(0);
      assert(clock.pending().every((ms) => ms > 0), `no timer left overdue: ${show(clock.pending())}`);
      assert(show(ranges()) === show(['famcal default']) && m.text().includes('Friday, 16 October'), `no second reset: ${show(ranges())}`);
    } finally {
      m.unmount();
      fakeWindow.Telegram = undefined;
    }

    // A device clock that runs ahead (the server still says Thursday): one reset, then plain refetches.
    const ahead = await overnight(() => ok200(answer({ items: WEEK })));
    try {
      React.act(() => ahead.tg.fire('activated'));
      await settle();
      React.act(() => ahead.tg.fire('activated'));
      await settle();
      assert(show(ranges()) === show(['famcal default', `famcal ${day(0)}→${day(7)}`]), `one reset, then a refetch: ${show(ranges())}`);
      assertHas(ahead.m.text(), ['Thursday, 15 October', 'Dentist'], 'the server\'s day stands');
    } finally {
      ahead.m.unmount();
      fakeWindow.Telegram = undefined;
    }

    // Init data older than a day: the route proves no one (401), and the home shows PageGate's card, asking nothing more.
    const stale = await overnight(() => ({ status: 401, body: { error: 'Unauthorized' } }));
    try {
      React.act(() => stale.tg.fire('activated'));
      await settle();
      assertHas(stale.m.text(), ['Please open this from the bot', 'Back to the chat'], '401: PageGate\'s card');
      assertLacks(stale.m.text(), ['Dentist', 'Today'], '401: no stale Agenda');
      React.act(() => stale.tg.fire('activated'));
      fireDocument('visibilitychange');
      await settle();
      assert(show(ranges()) === show(['famcal default']), `401: nothing more is asked: ${show(ranges())}`);
    } finally {
      stale.m.unmount();
      fakeWindow.Telegram = undefined;
    }
  });

  await check('#40 React logged no warning in any render, CalendarHome\'s included (keys, nesting, attributes, act)', () => {
```

- [ ] **Step 2: Run it and see it fail; record the regression smokes' baseline**

```bash
cd /Users/razielgershoni/development/famcalbot
for tz in UTC Asia/Jerusalem Pacific/Kiritimati; do
  eval "env TZ=$tz $E npx tsx scripts/smoke-calendar-home-render.ts" > /tmp/d6-render-before.log 2>&1; echo "TZ=$tz exit $?"; grep -m1 'Cannot find module' /tmp/d6-render-before.log
done
npx tsc --noEmit -p . 2>&1 | grep 'error TS'
for f in smoke-initdata-header smoke-auth-leftovers smoke-miniapp-gate smoke-calendar-home-copy smoke-hebrew-date smoke-calendar-agenda smoke-telegram-ui smoke-command-client check-i18n-parity; do
  for tz in UTC Asia/Jerusalem; do
    eval "env TZ=$tz $E npx tsx scripts/$f.ts" > /tmp/d6-$f.log 2>&1; echo "$f TZ=$tz exit $?"
    grep -E '^(OK|FAIL)|passed|parity' /tmp/d6-$f.log > /tmp/d6-$f-${tz//\//_}.before; tail -1 /tmp/d6-$f-${tz//\//_}.before
  done
done
```
(zsh or bash.) Expected for the smoke, under each clock (tsx may also print `DEP0205` deprecation warnings on stderr; ignore them):
```
TZ=UTC exit 1
Error: Cannot find module '../app/[locale]/dashboard/CalendarHome'
```
Expected from `tsc` (exit 2):
```
scripts/smoke-calendar-home-render.ts(54,92): error TS2307: Cannot find module '../app/[locale]/dashboard/CalendarHome' or its corresponding type declarations.
scripts/smoke-calendar-home-render.ts(71,53): error TS2307: Cannot find module '../app/[locale]/dashboard/HomeErrorBoundary' or its corresponding type declarations.
scripts/smoke-calendar-home-render.ts(72,47): error TS2307: Cannot find module '../app/[locale]/dashboard/HomeBanners' or its corresponding type declarations.
scripts/smoke-calendar-home-render.ts(73,32): error TS2307: Cannot find module '../app/[locale]/dashboard/home-shell' or its corresponding type declarations.
scripts/smoke-calendar-home-render.ts(74,29): error TS2307: Cannot find module '../app/[locale]/dashboard/MenuSheet' or its corresponding type declarations.
scripts/smoke-calendar-home-render.ts(75,75): error TS2307: Cannot find module '../src/lib/calendar-view/home-client' or its corresponding type declarations.
scripts/smoke-calendar-home-render.ts(76,66): error TS2307: Cannot find module '../src/lib/calendar-view/home-loader' or its corresponding type declarations.
scripts/smoke-calendar-home-render.ts(686,16): error TS7006: Parameter 'run' implicitly has an 'any' type.
scripts/smoke-calendar-home-render.ts(686,21): error TS7006: Parameter 'ms' implicitly has an 'any' type.
scripts/smoke-calendar-home-render.ts(1791,29): error TS7006: Parameter 'e' implicitly has an 'any' type.
scripts/smoke-calendar-home-render.ts(1802,29): error TS7006: Parameter 'e' implicitly has an 'any' type.
scripts/smoke-calendar-home-render.ts(1852,39): error TS2353: Object literal may only specify known properties, and 'trialDaysLeft' does not exist in type 'Partial<CalendarHomeProps>'.
scripts/smoke-calendar-home-render.ts(1867,55): error TS2353: Object literal may only specify known properties, and 'trialDaysLeft' does not exist in type 'Partial<CalendarHomeProps>'.
```
Expected for the regression smokes, every run `exit 0`, with these last lines: `9/9 passed` (initdata-header), `9/9 passed` (auth-leftovers), `15/15 passed` (miniapp-gate), `14/14 passed` (home-copy), `14/14 passed (process TZ=…)` (hebrew-date), `33/33 passed (process TZ=…)` (agenda), `14/14 passed (process TZ=…)` (telegram-ui), `11/11 passed (process TZ=…)` (command-client), `i18n parity OK (996 keys)`. The `/tmp/d6-*.before` files are the baseline for Step 14.

- [ ] **Step 3: Add the two optional fields to `src/lib/calendar-view/home-props.ts`, and the BackButton's release to `src/lib/telegram-ui.ts`**

Lines 18-20 of `src/lib/calendar-view/home-props.ts`. Before:
```ts
  needsCalendars: boolean;
  hints: HomeHints;
};
```
After:
```ts
  needsCalendars: boolean;
  hints: HomeHints;
  /**
   * The trial's days left, for the home's trial banner (spec §7.2); null when there is no
   * trial (or the user is an early adopter). Absent means unknown: no banner.
   */
  trialDaysLeft?: number | null;
  /**
   * Whether a location is set, for "Set your location for the right times" (spec §7.2).
   * Absent means unknown: no banner.
   */
  hasLocation?: boolean;
};
```

Then D4's BackButton hook in `src/lib/telegram-ui.ts` (`:75-103`): it remembers the handler it put on the button, and `releaseTelegramBackButton()` takes the button down outside React (offClick of that handler, then hide), for a reload, which runs no cleanup while the client keeps the button. The hook's behaviour is unchanged (D4's `smoke-telegram-ui` still passes 14/14). Before:
```ts
/**
 * Telegram's BackButton (Bot API 6.1+) while `active`; a tap calls the latest `onBack`.
 * - On mount it hides the button: the client keeps it across reloads.
 * - While active: one handler (onClick), then show().
 * - Whenever it stops being needed (`active` turns false, or unmount): offClick(that
 *   handler), then hide(), each on its own so a throw in one still runs the other.
 * The SDK calls every registered handler and any hide() hides the one button, so one
 * component owns it: the home's single call decides what a tap does.
 */
export function useTelegramBackButton(active: boolean, onBack: () => void): void {
  const back = useEffectEvent(onBack);

  useEffect(() => {
    tgCall(BACK_BUTTON, 'BackButton.hide', (tg) => tg.BackButton.hide());
  }, []);

  useEffect(() => {
    if (!active) return;
    const handler = () => back();
    tgCall(BACK_BUTTON, 'BackButton.show', (tg) => {
      tg.BackButton.onClick(handler);
      tg.BackButton.show();
    });
    return () => {
      tgCall(BACK_BUTTON, 'BackButton.offClick', (tg) => tg.BackButton.offClick(handler));
      tgCall(BACK_BUTTON, 'BackButton.hide', (tg) => tg.BackButton.hide());
    };
  }, [active]);
}

```
After:
```ts
/** The handler useTelegramBackButton has on the button now, for releaseTelegramBackButton. */
let liveBackHandler: (() => void) | null = null;

/**
 * Telegram's BackButton (Bot API 6.1+) while `active`; a tap calls the latest `onBack`.
 * - On mount it hides the button: the client keeps it across reloads.
 * - While active: one handler (onClick), then show().
 * - Whenever it stops being needed (`active` turns false, or unmount): offClick(that
 *   handler), then hide(), each on its own so a throw in one still runs the other.
 * The SDK calls every registered handler and any hide() hides the one button, so one
 * component owns it: the home's single call decides what a tap does.
 */
export function useTelegramBackButton(active: boolean, onBack: () => void): void {
  const back = useEffectEvent(onBack);

  useEffect(() => {
    tgCall(BACK_BUTTON, 'BackButton.hide', (tg) => tg.BackButton.hide());
  }, []);

  useEffect(() => {
    if (!active) return;
    const handler = () => back();
    tgCall(BACK_BUTTON, 'BackButton.show', (tg) => {
      tg.BackButton.onClick(handler);
      tg.BackButton.show();
    });
    liveBackHandler = handler;
    return () => {
      if (liveBackHandler === handler) liveBackHandler = null;
      tgCall(BACK_BUTTON, 'BackButton.offClick', (tg) => tg.BackButton.offClick(handler));
      tgCall(BACK_BUTTON, 'BackButton.hide', (tg) => tg.BackButton.hide());
    };
  }, [active]);
}

/**
 * Lets the BackButton go at once, outside React: offClick(the live handler, if any), then
 * hide(). For a page reload (spec §5: 404 not_enabled, a chunk-load error), which runs no
 * React cleanup while the client keeps the button across it (§7.6): otherwise the page
 * after the reload would show a back button that does nothing.
 */
export function releaseTelegramBackButton(): void {
  const handler = liveBackHandler;
  liveBackHandler = null;
  if (handler) tgCall(BACK_BUTTON, 'BackButton.offClick', (tg) => tg.BackButton.offClick(handler));
  tgCall(BACK_BUTTON, 'BackButton.hide', (tg) => tg.BackButton.hide());
}

```

- [ ] **Step 4: Create `src/lib/calendar-view/reload-guard.ts` and `src/lib/calendar-view/home-client.ts`**

First the reload-once guard and the chunk-load test, as a leaf with no imports: D7's boundary in PageGate reads it, and PageGate's chunk loads on every page, so it must not pull in the home's code. Create `src/lib/calendar-view/reload-guard.ts` with exactly this content:

```ts
// The calendar home's reload-once guard (spec §5): a failed chunk load, or the rollout
// switch turned back (404 not_enabled), reloads the page once. A leaf with no imports, so
// PageGate's boundary around the home's chunk (D7) can use it without pulling the home's
// code into the chunk every page loads. Client components only; nothing here touches
// window at import.

/** The chunk-load guard's sessionStorage key, shared by PageGate's boundary and the home's own. */
export const CHUNK_RELOAD_KEY = 'famcal:calendarHome:chunkReload:v1';

/** A failed chunk load (a deploy replaced the files while the app was open). */
export function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === 'ChunkLoadError' ||
    /Loading (?:CSS )?chunk [\w-]+ failed|Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/i.test(error.message)
  );
}

/** How long a reload-once guard holds: longer than the switch's 30 s memo. */
const RELOAD_GUARD_MS = 60_000;

/**
 * Reloads the page, unless this guard already reloaded it in the last minute. Returns
 * whether it reloaded. With no sessionStorage (blocked, private mode) it never reloads,
 * so it can never loop. `beforeReload` runs just before the reload, only when it happens:
 * a reload runs no React cleanup, so whatever must be let go first (Telegram's
 * BackButton, which the client keeps across reloads) goes there.
 */
export function reloadOnce(key: string, nowMs: number = Date.now(), beforeReload?: () => void): boolean {
  try {
    const last = Number(window.sessionStorage.getItem(key));
    if (Number.isFinite(last) && last > 0 && nowMs - last < RELOAD_GUARD_MS) return false;
    window.sessionStorage.setItem(key, String(nowMs));
  } catch {
    return false;
  }
  try {
    beforeReload?.();
  } catch {
    // The reload matters more.
  }
  try {
    window.location.reload();
    return true;
  } catch {
    return false;
  }
}
```

Then the range request and how its answer reads (with its time limit), the midnight check and the zone rule; it re-exports the guard. Client-only; nothing touches `window` at import.

Create `src/lib/calendar-view/home-client.ts` with exactly this content:

```ts
// The calendar home's client plumbing (spec §5, §7.1): the range request and what its
// answer means for the screen, the midnight check, the "Times in <zone>" rule and the
// reload-once guard (re-exported from ./reload-guard, a leaf PageGate also reads).
// Client components only. Nothing here touches window at import.
//
// - One GET /api/calendar/range per source. The init data goes in the header only
//   (a GET has no body), never in the URL; in a browser the session cookie rides along.
// - The answer is read into one of five outcomes: ok (a RangeResponse), notEnabled (404
//   not_enabled: the switch was turned back), noCredential (401, 403, any other 404),
//   busy (429, also when the limiter's Redis is down) and error (500, any other status, a
//   body that isn't a RangeResponse, or no answer at all).
// - A request that hasn't settled within its time limit (a network handover, or iOS
//   suspending the webview mid-request) is aborted and reads as no answer, so it never
//   holds its place in the loader's in-flight set.

import { initDataHeaders } from '../read-init-data';
import { instantDay, intlLocale } from './format';
import type { DayKey, RangeResponse, SourceName } from './types';

export { isChunkLoadError, reloadOnce } from './reload-guard';

/** A window of days, [from, to). */
export interface RangeWindow {
  from: DayKey;
  to: DayKey;
}

export type RangeOutcome =
  | { kind: 'ok'; response: RangeResponse }
  | { kind: 'notEnabled' }
  | { kind: 'noCredential'; status: number }
  | { kind: 'busy' }
  | { kind: 'error'; status: number | null };

/** The sources the home asks for, from the user's calendar source (the server's sourcesFor). */
export function homeSources(calendarSource: 'GOOGLE' | 'NATIVE'): SourceName[] {
  return calendarSource === 'GOOGLE' ? ['google'] : ['famcal'];
}

/**
 * The range route's URL for one source. No window means no dates: the server's
 * [today, today+7). `fresh` asks the server to skip its Google cache (⋯ → Refresh).
 */
export function rangeUrl(userId: number, source: SourceName, window: RangeWindow | null, fresh: boolean): string {
  const query = new URLSearchParams({ user_id: String(userId), sources: source });
  if (window) {
    query.set('from', window.from);
    query.set('to', window.to);
  }
  if (fresh) query.set('fresh', '1');
  return `/api/calendar/range?${query.toString()}`;
}

/** The fields the store reads, so a body that isn't a RangeResponse is an error, not a crash. */
function isRangeResponse(value: unknown): value is RangeResponse {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.tz === 'string' &&
    typeof r.today === 'string' &&
    typeof r.from === 'string' &&
    typeof r.to === 'string' &&
    typeof r.weekStart === 'number' &&
    typeof r.hebrewDates === 'boolean' &&
    typeof r.sources === 'object' &&
    r.sources !== null &&
    Array.isArray(r.days) &&
    Array.isArray(r.calendars)
  );
}

async function bodyOf(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** A time limit for one request: after `ms` on the caller's timer, it is aborted and reads as no answer. */
export interface RangeTimeLimit {
  ms: number;
  setTimer: (run: () => void, ms: number) => () => void;
}

/**
 * Asks the range route for one source's window. `userId` is the page's own user_id,
 * exactly as CalendarHomeProps carries it (a Telegram id or a DB id); it is never swapped.
 * With `limit`, an answer that hasn't come (headers and body) within `limit.ms` is
 * aborted and reads as `{ kind: 'error', status: null }`, whether or not the fetch honours
 * the abort. Never throws.
 */
export async function fetchRange(
  userId: number,
  source: SourceName,
  window: RangeWindow | null,
  fresh: boolean,
  limit?: RangeTimeLimit,
): Promise<RangeOutcome> {
  if (!limit) return askRange(userId, source, window, fresh, undefined);
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let cancel = () => {};
  const timedOut = new Promise<RangeOutcome>((resolve) => {
    cancel = limit.setTimer(() => {
      try {
        controller?.abort();
      } catch {
        // The answer below is what counts.
      }
      resolve({ kind: 'error', status: null });
    }, limit.ms);
  });
  try {
    return await Promise.race([askRange(userId, source, window, fresh, controller?.signal), timedOut]);
  } finally {
    cancel();
  }
}

async function askRange(userId: number, source: SourceName, window: RangeWindow | null, fresh: boolean, signal: AbortSignal | undefined): Promise<RangeOutcome> {
  let res: Response;
  try {
    res = await fetch(rangeUrl(userId, source, window, fresh), {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: initDataHeaders(),
      ...(signal ? { signal } : {}),
    });
  } catch {
    return { kind: 'error', status: null };
  }
  if (res.status === 200) {
    const body = await bodyOf(res);
    return isRangeResponse(body) ? { kind: 'ok', response: body } : { kind: 'error', status: 200 };
  }
  if (res.status === 429) return { kind: 'busy' };
  if (res.status === 401 || res.status === 403) return { kind: 'noCredential', status: res.status };
  if (res.status === 404) {
    const body = await bodyOf(res);
    const notEnabled = !!body && typeof body === 'object' && (body as { error?: unknown }).error === 'not_enabled';
    return notEnabled ? { kind: 'notEnabled' } : { kind: 'noCredential', status: 404 };
  }
  return { kind: 'error', status: res.status };
}

const HOUR_MS = 3_600_000;

/**
 * How long to wait before checking whether the day has changed in `tz`: until just
 * after the next local midnight, but never more than an hour, so a DST change on the
 * way can move the check by minutes at most. At least one second.
 */
export function msUntilDayCheck(nowMs: number, tz: string): number {
  let sinceMidnight: number | null = null;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZone: tz }).formatToParts(new Date(nowMs));
    const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
    const [h, m, s] = [part('hour'), part('minute'), part('second')];
    if ([h, m, s].every(Number.isFinite)) sinceMidnight = ((h * 60 + m) * 60 + s) * 1000 + (nowMs % 1000);
  } catch {
    // A zone the device's Intl doesn't know: check again in an hour.
  }
  if (sinceMidnight === null) return HOUR_MS;
  return Math.min(HOUR_MS, Math.max(1000, 24 * HOUR_MS - sinceMidnight + 500));
}

/** Whether the day in `tz` is already later than `today` (the server's). */
export function isPastDay(nowMs: number, tz: string, today: DayKey): boolean {
  const day = instantDay(new Date(nowMs).toISOString(), tz);
  return day !== null && day > today;
}

/** The device's own timezone, or null when Intl doesn't say. */
export function deviceTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

function canonicalZone(zone: string): string | null {
  try {
    return new Intl.DateTimeFormat('en', { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** "Times in <zone>" shows only when the device's zone isn't the one the times are in (aliases count as the same). */
export function zoneDiffers(device: string | null, tz: string): boolean {
  if (!device) return false;
  const a = canonicalZone(device);
  const b = canonicalZone(tz);
  return a !== null && b !== null && a !== b;
}

/** A zone's name for people: "Israel Time" / "שעון ישראל" / "Израиль"; else its city ("New York"). */
export function zoneLabel(tz: string, locale: string): string {
  for (const style of ['longGeneric', 'long'] as const) {
    try {
      const name = new Intl.DateTimeFormat(intlLocale(locale), { timeZone: tz, timeZoneName: style })
        .formatToParts(new Date())
        .find((p) => p.type === 'timeZoneName')?.value;
      if (name && !/^(GMT|UTC)\b/.test(name.replace(/‎/g, ''))) return name;
    } catch {
      // Not supported by this Intl: try the next style, then the city.
    }
  }
  return (tz.split('/').pop() ?? tz).replace(/_/g, ' ');
}
```

- [ ] **Step 5: Create `src/lib/calendar-view/home-loader.ts`**

The data flow of spec §5 as a plain object with no React: which windows are asked, the in-flight dedupe, the stale re-request, the Google error retry and what each answer dispatches.

Create `src/lib/calendar-view/home-loader.ts` with exactly this content:

```ts
// The calendar home's data flow (spec §5): which range requests go out, and what each
// answer does to the store. CalendarHome (D6) creates one loader on mount and feeds it
// the latest store; the loader only fetches and dispatches. Client components only;
// no React in here, so the rules read in one place:
//
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
import { daysInWindow, type CalendarStore, type StoreAction } from './store';
import { fetchRange, type RangeOutcome, type RangeWindow } from './home-client';
import type { SourceName } from './types';

/** A stale answer's one re-request (spec §5 Freshness). */
export const STALE_RETRY_MS = 3000;
/** A Google error's one automatic retry (spec §5 States). */
export const ERROR_RETRY_MS = 5000;
/** A range request's time limit: past it, the request is aborted and reads as no answer. */
export const RANGE_TIMEOUT_MS = 15_000;

export interface LoaderHost {
  /** The page's own user_id, exactly as CalendarHomeProps carries it. */
  userId: number;
  /** The sources that apply before any answer (the user's calendar source). */
  sources: readonly SourceName[];
  /** The latest store and week count. */
  getStore(): CalendarStore;
  getWeeks(): number;
  dispatch(action: StoreAction): void;
  /** The home shows a no-credential card or the switch-off card: nothing more is fetched. */
  isBlocked(): boolean;
  /** No answer yet and the first load failed: the host's busy or retry card is up. */
  firstLoadFailed(): boolean;
  /** An answer arrived (the first-load card goes). */
  onAnswer(): void;
  onFirstLoadFailed(kind: 'busy' | 'error'): void;
  onNoCredential(): void;
  onNotEnabled(): void;
  setTimer(run: () => void, ms: number): () => void;
}

export interface HomeLoader {
  ensure(): void;
  refetchVisible(o?: { fresh?: boolean; only?: SourceName }): void;
  dispose(): void;
}

type Ask = { source: SourceName; window: RangeWindow | null; fresh?: boolean; followUp?: 'stale' | 'retry' };

/** Whether some day of the window has no answer (ok or failed) from `source` yet. */
function uncovered(store: CalendarStore, source: SourceName, window: RangeWindow): boolean {
  return daysInWindow(window.from, window.to).some((day) => {
    const c = store.days[day]?.coverage[source];
    return !c || (!c.ok && !c.failed);
  });
}

export function createHomeLoader(host: LoaderHost): HomeLoader {
  /** `${epoch}|${source}|${from or 'default'}`: asked by ensure() in that epoch. */
  const issued = new Set<string>();
  /** The same plus `|fresh` or `|plain`: on its way now. */
  const inflight = new Set<string>();
  const timers = new Set<() => void>();
  let live = true;

  const later = (run: () => void, ms: number) => {
    const cancel = host.setTimer(() => {
      timers.delete(cancel);
      if (live) run();
    }, ms);
    timers.add(cancel);
  };

  const visibleWindows = (today: string): RangeWindow[] =>
    Array.from({ length: Math.max(1, Math.floor(host.getWeeks())) }, (_, week) => agendaWeekWindow(today, week));

  function handle(outcome: RangeOutcome, ask: Ask, epoch: number, where: string) {
    const { source, window } = ask;
    switch (outcome.kind) {
      case 'ok': {
        const response = outcome.response;
        host.onAnswer();
        host.dispatch({ type: 'response', response, epoch });
        const google = response.sources.google;
        const answered: RangeWindow = { from: response.from, to: response.to };
        // A follow-up is for this epoch's window only: after a drop the loader starts over anyway.
        const again = (followUp: 'stale' | 'retry') => {
          if (host.getStore().epoch === epoch) send({ source, window: answered, followUp });
        };
        if (source === 'google' && google?.status === 'ok' && google.stale && ask.followUp === undefined) {
          later(() => again('stale'), STALE_RETRY_MS);
        }
        if (source === 'google' && google?.status === 'error' && google.reason !== 'calendars_gone' && ask.followUp !== 'retry') {
          later(() => again('retry'), ERROR_RETRY_MS);
        }
        return;
      }
      case 'notEnabled':
        host.onNotEnabled();
        return;
      case 'noCredential':
        host.onNoCredential();
        return;
      case 'busy':
      case 'error': {
        const facts = host.getStore().facts;
        const failed = window ?? (facts ? agendaWeekWindow(facts.today, 0) : null);
        if (facts && failed) {
          host.dispatch({ type: 'windowFailed', from: failed.from, to: failed.to, sources: [source], kind: outcome.kind, epoch });
          return;
        }
        // No facts to hang a state row on: the host's card, and ensure() may ask again after Retry.
        issued.delete(`${epoch}|${source}|${where}`);
        host.onFirstLoadFailed(outcome.kind);
      }
    }
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

  return {
    ensure() {
      if (!live) return;
      const store = host.getStore();
      const facts = store.facts;
      if (!facts) {
        if (host.firstLoadFailed()) return;
        for (const source of host.sources) {
          if (!issued.has(`${store.epoch}|${source}|default`)) send({ source, window: null });
        }
        return;
      }
      visibleWindows(facts.today).forEach((window, week) => {
        for (const source of facts.sources) {
          const asked = issued.has(`${store.epoch}|${source}|${window.from}`) || (week === 0 && issued.has(`${store.epoch}|${source}|default`));
          if (!asked && uncovered(store, source, window)) send({ source, window });
        }
      });
    },

    refetchVisible({ fresh = false, only }: { fresh?: boolean; only?: SourceName } = {}) {
      if (!live) return;
      const facts = host.getStore().facts;
      const sources = (facts ? facts.sources : host.sources).filter((s) => only === undefined || s === only);
      if (!facts) {
        for (const source of sources) send({ source, window: null, fresh });
        return;
      }
      for (const window of visibleWindows(facts.today)) {
        for (const source of sources) send({ source, window, fresh });
      }
    },

    dispose() {
      live = false;
      for (const cancel of timers) cancel();
      timers.clear();
    },
  };
}
```

- [ ] **Step 6: Create `app/[locale]/dashboard/home-shell.ts`**

The shell's styles: the frame (stable viewport height, safe areas, `overflow-x: clip`), the header, the banners, the sheets' options and the cards. Logical properties only, nothing under 11 px, taps of 44 px or more.

Create `app/[locale]/dashboard/home-shell.ts` with exactly this content:

```ts
// The calendar home's shell styles (spec §7.1 Layout, §7.2; the approved layout A): the
// page frame, the header, the banners, the send and menu sheets' options, and the cards
// that stand in for the Agenda (busy, retry, the error boundary). They read the tokens
// HOME_THEME_CSS (./home-theme.ts) sets on .ch-home, and add one: --ch-accent-soft.
//
// - Document-level scroll, no inner scroller; the frame is at least the viewport's
//   stable height; safe areas from --tg-safe-area-inset-* plus
//   --tg-content-safe-area-inset-* (Bot API 8.0), 0 without them.
// - overflow-x: clip (never overflow: hidden), and no transform or filter on the frame:
//   the sheets are position: fixed, and Plan E's Month bar is sticky.
// - Logical properties only; directional icons flip in RTL (.ch-flip); nothing under
//   11 px; every tap at least 44 px; no hover styles (touch only).

export const HOME_SHELL_CSS = `
.ch-home {
  --ch-accent-soft: #eee9ff;
  min-height: var(--tg-viewport-stable-height, 100dvh);
  padding-block-start: calc(var(--tg-safe-area-inset-top, 0px) + var(--tg-content-safe-area-inset-top, 0px));
  padding-inline: max(
    calc(var(--tg-safe-area-inset-left, 0px) + var(--tg-content-safe-area-inset-left, 0px)),
    calc(var(--tg-safe-area-inset-right, 0px) + var(--tg-content-safe-area-inset-right, 0px))
  );
  overflow-x: clip;
}
.ch-home[data-theme='dark'] {
  --ch-accent-soft: #2c2550;
}
@supports (color: color-mix(in srgb, red 50%, blue)) {
  .ch-home,
  .ch-home[data-theme='dark'] {
    --ch-accent-soft: color-mix(in srgb, var(--ch-accent) 14%, var(--ch-bg));
  }
}
.ch-home[dir='rtl'] .ch-flip {
  transform: scaleX(-1);
}
.ch-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 16px 12px;
}
.ch-head-text {
  flex: 1;
  min-width: 0;
}
.ch-head-title {
  margin: 0;
  font-size: 22px;
  font-weight: 600;
  line-height: 1.25;
}
.ch-head-title::first-letter {
  text-transform: uppercase;
}
.ch-head-sub {
  margin: 2px 0 0;
  font-size: 14px;
  color: var(--ch-muted);
}
.ch-head-zone {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--ch-muted);
}
.ch-head-ghost {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-block-start: 4px;
}
.ch-head-ghost-title,
.ch-head-ghost-sub {
  display: block;
  border-radius: 8px;
  background: var(--ch-surface);
  animation: ch-pulse 1.4s ease-in-out infinite;
}
.ch-head-ghost-title {
  block-size: 22px;
  inline-size: 70%;
}
.ch-head-ghost-sub {
  block-size: 14px;
  inline-size: 40%;
}
.ch-head-buttons {
  display: flex;
  flex: none;
  gap: 8px;
}
.ch-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  inline-size: 44px;
  block-size: 44px;
  min-width: 44px;
  min-height: 44px;
  padding: 0;
  border: 0;
  border-radius: 12px;
  background: var(--ch-surface);
  color: var(--ch-text);
  cursor: pointer;
  touch-action: manipulation;
}
.ch-icon-btn svg {
  inline-size: 22px;
  block-size: 22px;
}
.ch-icon-btn-accent {
  background: var(--ch-accent-soft);
  color: var(--ch-accent);
}
.ch-icon-btn:focus-visible {
  outline: 2px solid var(--ch-accent);
  outline-offset: 2px;
}
.ch-banners {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 4px 16px 0;
}
.ch-banner {
  display: flex;
  align-items: center;
  gap: 12px;
  inline-size: 100%;
  min-height: 56px;
  margin: 0;
  padding: 10px 14px;
  border: 0;
  border-radius: 14px;
  background: var(--ch-surface);
  color: var(--ch-text);
  font-family: inherit;
  font-size: 15px;
  text-align: start;
  text-decoration: none;
  cursor: pointer;
  touch-action: manipulation;
}
.ch-banner-accent,
.ch-banner-telegram {
  background: var(--ch-accent-soft);
}
.ch-banner-icon {
  flex: none;
  inline-size: 22px;
  block-size: 22px;
  color: var(--ch-accent);
}
.ch-banner-warn .ch-banner-icon {
  color: var(--ch-danger);
}
.ch-banner-text {
  display: block;
  flex: 1;
  min-width: 0;
}
.ch-banner-title {
  display: block;
  font-size: 15px;
  font-weight: 600;
  line-height: 1.3;
}
.ch-banner-body {
  display: block;
  margin-block-start: 2px;
  font-size: 13px;
  line-height: 1.35;
  color: var(--ch-muted);
}
.ch-banner-action {
  flex: none;
  max-inline-size: 40%;
  font-size: 14px;
  font-weight: 600;
  color: var(--ch-accent);
  text-align: end;
}
.ch-banner-chevron {
  flex: none;
  inline-size: 18px;
  block-size: 18px;
  color: var(--ch-muted);
}
.ch-sheet-heading {
  margin: 0 0 4px;
  font-size: 18px;
  font-weight: 600;
}
.ch-sheet-sub {
  margin: 0 0 10px;
  font-size: 14px;
  color: var(--ch-muted);
}
.ch-options {
  list-style: none;
  margin: 0;
  padding: 0;
}
.ch-option-li {
  border-block-end: 1px solid var(--ch-separator);
}
.ch-option-li:last-child {
  border-block-end: 0;
}
.ch-option {
  display: flex;
  align-items: center;
  gap: 14px;
  inline-size: 100%;
  min-height: 60px;
  margin: 0;
  padding: 8px 0;
  border: 0;
  background: transparent;
  color: inherit;
  font-family: inherit;
  font-size: 16px;
  text-align: start;
  cursor: pointer;
  touch-action: manipulation;
}
.ch-option[aria-disabled='true'] {
  opacity: 0.55;
  cursor: default;
}
.ch-option-compact {
  min-height: 52px;
  padding: 4px 0;
}
.ch-option-icon {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  inline-size: 40px;
  block-size: 40px;
  border-radius: 12px;
  background: var(--ch-surface);
  color: var(--ch-accent);
}
.ch-option-icon svg {
  inline-size: 22px;
  block-size: 22px;
}
.ch-option-icon-sm {
  inline-size: 34px;
  block-size: 34px;
  border-radius: 10px;
}
.ch-option-icon-sm svg {
  inline-size: 19px;
  block-size: 19px;
}
.ch-option-text {
  display: block;
  flex: 1;
  min-width: 0;
}
.ch-option-title {
  display: block;
  font-size: 16px;
  line-height: 1.3;
}
.ch-option-hint {
  display: block;
  margin-block-start: 2px;
  font-size: 13px;
  color: var(--ch-muted);
}
.ch-send-result {
  margin: 12px 0 0;
  padding: 10px 12px;
  border-radius: 12px;
  background: var(--ch-surface);
  font-size: 14px;
}
.ch-send-result.is-problem {
  color: var(--ch-danger);
}
.ch-spin {
  animation: ch-spin 0.9s linear infinite;
}
@keyframes ch-spin {
  to { transform: rotate(360deg); }
}
@keyframes ch-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.55; }
}
.ch-home-card {
  margin: 24px 16px 0;
  padding: 24px 16px;
  border-radius: 16px;
  background: var(--ch-surface);
  text-align: center;
}
.ch-home-card-title {
  margin: 0;
  font-size: 17px;
  font-weight: 600;
}
.ch-home-card-body {
  margin: 8px 0 0;
  font-size: 14px;
  color: var(--ch-muted);
}
.ch-home-card-action {
  min-height: 48px;
  margin-block-start: 16px;
  padding-inline: 24px;
}
`;
```

- [ ] **Step 7: Create `app/[locale]/dashboard/HomeHeader.tsx`**

The header: the server's today, its Hebrew date when on, "Times in <zone>" when the device is elsewhere, and the Send and ⋯ buttons (44 px, labelled, `aria-expanded`).

Create `app/[locale]/dashboard/HomeHeader.tsx` with exactly this content:

```tsx
'use client';

// The calendar home's header (spec §7.2, the approved layout A): the day and, when the
// route says so, its Hebrew date ("Thursday, 15 October" over "4 Cheshvan 5787"), both
// from the server's today, never the device's clock; "Times in <zone>" when the device
// is in another zone (§7.1); and two 44 px buttons: Send to chat, and the ⋯ menu.
// Until the first answer the day is a placeholder bar.

import { useLocale, useTranslations } from 'next-intl';
import { formatDayLong } from '@/src/lib/calendar-view/format';
import { hebrewFullDate } from '@/src/lib/calendar-view/hebrew-date';
import { zoneLabel } from '@/src/lib/calendar-view/home-client';
import type { DayKey } from '@/src/lib/calendar-view/types';

export interface HomeHeaderProps {
  /** The server's today; null until the first answer. */
  today: DayKey | null;
  hebrewDates: boolean;
  /** The zone the times are in, only when the device's zone differs; else null. */
  zone: string | null;
  sendOpen: boolean;
  menuOpen: boolean;
  onSend: () => void;
  onMenu: () => void;
}

export function SendIcon() {
  return (
    <svg className="ch-flip" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M22 2L11 13" />
      <path d="M22 2l-7 20-4-9-9-4 20-7z" />
    </svg>
  );
}

function MoreIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
      <circle cx="5" cy="12" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="19" cy="12" r="1.8" />
    </svg>
  );
}

export function HomeHeader({ today, hebrewDates, zone, sendOpen, menuOpen, onSend, onMenu }: HomeHeaderProps) {
  const t = useTranslations('calendarHome');
  const locale = useLocale();
  // calendarHome.hebrewMonthGenitive: only Russian reads it (Ruling R9).
  const genitive = locale === 'ru' ? (t.raw('hebrewMonthGenitive') as string[]) : undefined;
  const title = today ? formatDayLong(today, locale) : '';
  const hebrew = today && hebrewDates ? hebrewFullDate(today, locale, genitive) : '';

  return (
    <header className="ch-head">
      <div className="ch-head-text">
        {title ? (
          <h1 className="ch-head-title">{title}</h1>
        ) : (
          <div className="ch-head-ghost" aria-hidden="true">
            <span className="ch-head-ghost-title" />
            <span className="ch-head-ghost-sub" />
          </div>
        )}
        {hebrew ? <p className="ch-head-sub">{hebrew}</p> : null}
        {zone ? <p className="ch-head-zone">{t('shell.timesIn', { zone: zoneLabel(zone, locale) })}</p> : null}
      </div>
      <div className="ch-head-buttons">
        <button
          type="button"
          className="ch-icon-btn ch-icon-btn-accent"
          aria-label={t('header.send')}
          aria-haspopup="dialog"
          aria-expanded={sendOpen}
          onClick={onSend}
        >
          <SendIcon />
        </button>
        <button
          type="button"
          className="ch-icon-btn"
          aria-label={t('header.menu')}
          aria-haspopup="dialog"
          aria-expanded={menuOpen}
          onClick={onMenu}
        >
          <MoreIcon />
        </button>
      </div>
    </header>
  );
}
```

- [ ] **Step 8: Create `app/[locale]/dashboard/HomeBanners.tsx`**

The banners of spec §7.2, with the pure `homeBanners()` that decides which show and in which order.

Create `app/[locale]/dashboard/HomeBanners.tsx` with exactly this content:

```tsx
'use client';

// The banners under the home's header (spec §7.2, §5 States), stacked and non-blocking,
// in this order:
// - trial days left, during a trial (→ Subscription);
// - "Set your location for the right times", when the server can't know the user's
//   timezone: no location, and no Google connection to read it from (→ Settings);
// - the Google setup card: Connect Google Calendar (no token), else Choose your
//   calendars (none chosen); Google users only;
// - Reconnect Google, when the latest Google answer asked for it: a dead token, or
//   missing permission (the scopes copy); never with the Connect card, never for FamCal;
// - in a browser, "Open FamCal in Telegram" (WhatsApp stays secondary to Telegram).
// Each banner is one button (or, for Telegram, a link) with a 44 px or taller target.
// FamCal users never see a Google entry.

import { useTranslations } from 'next-intl';
import { DEFAULT_BOT_USERNAME } from '@/src/lib/gate-links';

export type BannerId = 'trial' | 'location' | 'connectGoogle' | 'chooseCalendars' | 'reconnect' | 'reconnectScopes' | 'openInTelegram';

export interface BannerFacts {
  calendarSource: 'GOOGLE' | 'NATIVE';
  needsOAuth: boolean;
  needsCalendars: boolean;
  /** Days left in a trial; null or absent: no trial banner. */
  trialDaysLeft?: number | null;
  /** false: no location set; absent: unknown, no location banner. */
  hasLocation?: boolean;
  /** The store's latest Google answer asked for a reconnect (homeNotices). */
  reconnect: 'token' | 'scopes' | null;
  /** readInitData() is non-empty. */
  inTelegram: boolean;
}

/** Which banners show, in order. */
export function homeBanners(f: BannerFacts): BannerId[] {
  const google = f.calendarSource === 'GOOGLE';
  const out: BannerId[] = [];
  if (typeof f.trialDaysLeft === 'number' && f.trialDaysLeft > 0) out.push('trial');
  if (f.hasLocation === false && (!google || f.needsOAuth)) out.push('location');
  if (google && f.needsOAuth) out.push('connectGoogle');
  else if (google && f.needsCalendars) out.push('chooseCalendars');
  if (google && !f.needsOAuth && f.reconnect) out.push(f.reconnect === 'scopes' ? 'reconnectScopes' : 'reconnect');
  if (!f.inTelegram) out.push('openInTelegram');
  return out;
}

/** The bot's /start connect link: it links a WhatsApp account to Telegram (telegram/commands.ts). */
export const OPEN_IN_TELEGRAM_URL = `https://t.me/${DEFAULT_BOT_USERNAME}?start=connect`;

export interface HomeBannersProps extends BannerFacts {
  /** The page's own user_id, as CalendarHomeProps carries it. */
  userId: number;
  locale: string;
  onNavigate: (href: string) => void;
}

type Tone = 'plain' | 'accent' | 'warn';

function BannerIcon({ id }: { id: BannerId }) {
  const common = { className: 'ch-banner-icon', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true, focusable: false };
  switch (id) {
    case 'trial':
      return (
        <svg {...common}>
          <path d="M12 3l2.7 5.5 6 .9-4.3 4.2 1 6L12 16.8 6.6 19.6l1-6L3.3 9.4l6-.9z" />
        </svg>
      );
    case 'location':
      return (
        <svg {...common}>
          <path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z" />
          <circle cx="12" cy="9.5" r="2.5" />
        </svg>
      );
    case 'reconnect':
    case 'reconnectScopes':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7.5v5.5M12 16.5v.01" />
        </svg>
      );
    case 'openInTelegram':
      return (
        <svg {...common} className="ch-banner-icon ch-flip">
          <path d="M22 2L11 13" />
          <path d="M22 2l-7 20-4-9-9-4 20-7z" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <rect x="3" y="5" width="18" height="16" rx="3" />
          <path d="M3 10h18M8 3v4M16 3v4" />
        </svg>
      );
  }
}

function Chevron() {
  return (
    <svg className="ch-banner-chevron ch-flip" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

function BannerContent({ id, title, body, action }: { id: BannerId; title: string; body?: string; action?: string }) {
  return (
    <>
      <BannerIcon id={id} />
      <span className="ch-banner-text">
        <span className="ch-banner-title">{title}</span>
        {body ? <span className="ch-banner-body">{body}</span> : null}
      </span>
      {action ? <span className="ch-banner-action">{action}</span> : <Chevron />}
    </>
  );
}

export function HomeBanners({ userId, locale, onNavigate, ...facts }: HomeBannersProps) {
  const t = useTranslations('calendarHome');
  const ids = homeBanners(facts);
  if (ids.length === 0) return null;

  const button = (id: BannerId, tone: Tone, href: string, title: string, body?: string, action?: string) => (
    <button key={id} type="button" className={`ch-banner ch-tap ch-banner-${tone}`} data-banner={id} onClick={() => onNavigate(href)}>
      <BannerContent id={id} title={title} body={body} action={action} />
    </button>
  );
  const page = (name: string) => `/${locale}/${name}?user_id=${userId}`;
  const refreshToken = `/refresh-token?user_id=${userId}`;

  return (
    <div className="ch-banners">
      {ids.map((id) => {
        switch (id) {
          case 'trial':
            return button(id, 'accent', page('subscription'), t('banner.trial', { count: facts.trialDaysLeft ?? 0 }), undefined, t('banner.trialAction'));
          case 'location':
            return button(id, 'plain', page('settings'), t('banner.location'), undefined, t('banner.locationAction'));
          case 'connectGoogle':
            return button(id, 'accent', refreshToken, t('banner.connectGoogle'), t('banner.connectGoogleBody'));
          case 'chooseCalendars':
            return button(id, 'accent', page('select-calendars'), t('banner.chooseCalendars'), t('banner.chooseCalendarsBody'));
          case 'reconnect':
            return button(id, 'warn', refreshToken, t('banner.reconnect'), t('banner.reconnectBody'), t('banner.reconnectAction'));
          case 'reconnectScopes':
            return button(id, 'warn', refreshToken, t('banner.reconnectScopes'), t('banner.reconnectScopesBody'), t('banner.reconnectAction'));
          case 'openInTelegram':
            return (
              <a key={id} className="ch-banner ch-tap ch-banner-telegram" data-banner={id} href={OPEN_IN_TELEGRAM_URL} target="_blank" rel="noopener noreferrer">
                <BannerContent id={id} title={t('banner.openInTelegram')} body={t('banner.openInTelegramBody')} />
              </a>
            );
        }
      })}
    </div>
  );
}
```

- [ ] **Step 9: Create `app/[locale]/dashboard/SendSheet.tsx`**

The send sheet (Ruling R5) on D5's `BottomSheet` and D4's `sendToChat`, with the pure `sendResultKey()`.

Create `app/[locale]/dashboard/SendSheet.tsx` with exactly this content:

```tsx
'use client';

// "Send to chat" (spec §7.2, Ruling R5, the approved SendSheet mockup): a bottom sheet
// with Today's summary, Tomorrow's summary, This week, Next week and Weather. A tap asks
// the bot to post it in the user's chat (D4's sendToChat), one send at a time:
// - Telegram, 2xx: the app closes, so the spinner stays until it does;
// - a 2xx where the page stays: "Sent to WhatsApp" in a browser, or "Sent. Check your
//   chat" when Telegram couldn't close the app;
// - 429: try again in a minute; 401/403: reopen from the chat; no answer: no connection;
//   anything else: couldn't send. The sheet stays open and says so.

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { SEND_ITEMS, sendToChat, type SendItem, type SendResult } from '@/src/lib/command-client';
import { BottomSheet } from './BottomSheet';

export interface SendSheetProps {
  /** The page's own user_id, as CalendarHomeProps carries it (never swapped). */
  userId: number;
  locale: string;
  onClose: () => void;
}

/** Each item's copy, under calendarHome.send. */
const COPY: Record<SendItem, { title: string; hint: string }> = {
  today: { title: 'send.today', hint: 'send.todayHint' },
  tomorrow: { title: 'send.tomorrow', hint: 'send.tomorrowHint' },
  thisWeek: { title: 'send.thisWeek', hint: 'send.thisWeekHint' },
  nextWeek: { title: 'send.nextWeek', hint: 'send.nextWeekHint' },
  weather: { title: 'send.weather', hint: 'send.weatherHint' },
};

/** The line the sheet shows for an answer, or null while the app is closing. */
export function sendResultKey(result: SendResult): { key: string; problem: boolean } | null {
  switch (result.outcome) {
    case 'closing':
      return null;
    case 'sent':
      return { key: result.chat === 'whatsapp' ? 'send.sentWhatsApp' : 'send.sent', problem: false };
    case 'busy':
      return { key: 'send.busy', problem: true };
    case 'failed':
      if (result.status === null) return { key: 'send.offline', problem: true };
      if (result.status === 401 || result.status === 403) return { key: 'send.signedOut', problem: true };
      return { key: 'send.failed', problem: true };
  }
}

function ItemIcon({ item }: { item: SendItem }) {
  if (item === 'weather') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" focusable="false">
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <rect x="3" y="5" width="18" height="16" rx="3" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg className="ch-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true" focusable="false">
      <path d="M12 3a9 9 0 1 1-9 9" />
    </svg>
  );
}

export function SendSheet({ userId, locale, onClose }: SendSheetProps) {
  const t = useTranslations('calendarHome');
  const [sending, setSending] = useState<SendItem | null>(null);
  const [result, setResult] = useState<{ key: string; problem: boolean } | null>(null);

  const send = async (item: SendItem) => {
    // One send at a time: the other options are aria-disabled meanwhile (they keep focus).
    if (sending) return;
    setSending(item);
    setResult(null);
    const answer = await sendToChat(userId, item, locale);
    const line = sendResultKey(answer);
    // Closing: keep the spinner; the app is going away.
    if (line === null) return;
    setSending(null);
    setResult(line);
  };

  return (
    <BottomSheet label={t('send.title')} closeLabel={t('actions.close')} onClose={onClose}>
      <h2 className="ch-sheet-heading">{t('send.title')}</h2>
      <p className="ch-sheet-sub">{t('send.subtitle')}</p>
      <ul className="ch-options" role="list">
        {SEND_ITEMS.map((item) => {
          const busy = sending === item;
          return (
            <li key={item} className="ch-option-li">
              <button
                type="button"
                className="ch-option ch-tap"
                data-send={item}
                aria-disabled={sending !== null && !busy ? true : undefined}
                aria-busy={busy || undefined}
                onClick={() => void send(item)}
              >
                <span className="ch-option-icon">{busy ? <Spinner /> : <ItemIcon item={item} />}</span>
                <span className="ch-option-text">
                  <span className="ch-option-title">{t(COPY[item].title)}</span>
                  <span className="ch-option-hint">{busy ? t('send.sending') : t(COPY[item].hint)}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <p className={result ? `ch-send-result${result.problem ? ' is-problem' : ''}` : 'ch-visually-hidden'} role="status">
        {result ? t(result.key) : ''}
      </p>
    </BottomSheet>
  );
}
```

- [ ] **Step 10: Create `app/[locale]/dashboard/MenuSheet.tsx`**

The ⋯ menu (Ruling R6) on D5's `BottomSheet`, with the pure `menuEntries()`.

Create `app/[locale]/dashboard/MenuSheet.tsx` with exactly this content:

```tsx
'use client';

// The ⋯ menu (spec §7.2, Ruling R6): a bottom sheet with Settings; Calendars and Partner
// for FamCal users; Choose calendars and Reconnect Google for Google users; Subscription;
// Refresh (fresh=1 on every visible window); Feedback; and Admin panel for admins.
// Calendars and Partner open the existing pages as they are. FamCal users never see a
// Google entry, so they can't be switched to Google by accident.

import { useTranslations } from 'next-intl';
import { BottomSheet } from './BottomSheet';

export type MenuEntryId = 'settings' | 'calendars' | 'partner' | 'chooseCalendars' | 'reconnectGoogle' | 'subscription' | 'refresh' | 'feedback' | 'admin';

export interface MenuEntry {
  id: MenuEntryId;
  /** Where it goes; null for Refresh, which stays on the home. */
  href: string | null;
}

/** The menu's entries, in order. `userId` is the page's own user_id (never swapped). */
export function menuEntries(o: { calendarSource: 'GOOGLE' | 'NATIVE'; isAdmin: boolean; locale: string; userId: number }): MenuEntry[] {
  const page = (name: string) => `/${o.locale}/${name}?user_id=${o.userId}`;
  const out: MenuEntry[] = [{ id: 'settings', href: page('settings') }];
  if (o.calendarSource === 'GOOGLE') {
    out.push({ id: 'chooseCalendars', href: page('select-calendars') }, { id: 'reconnectGoogle', href: `/refresh-token?user_id=${o.userId}` });
  } else {
    out.push({ id: 'calendars', href: page('calendars') }, { id: 'partner', href: page('pair') });
  }
  out.push({ id: 'subscription', href: page('subscription') }, { id: 'refresh', href: null }, { id: 'feedback', href: page('feedback') });
  if (o.isAdmin) out.push({ id: 'admin', href: page('admin-panel') });
  return out;
}

const ICONS: Record<MenuEntryId, string[]> = {
  settings: [
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  ],
  calendars: ['M6 5h12a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3z', 'M3 10h18M8 3v4M16 3v4'],
  chooseCalendars: ['M6 5h12a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3z', 'M3 10h18M8 3v4M16 3v4', 'M9 15l2 2 4-4'],
  partner: ['M9 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z', 'M2.5 20a6.5 6.5 0 0 1 13 0', 'M17 11.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z', 'M17 14.5a5 5 0 0 1 4.5 5'],
  reconnectGoogle: ['M21 12a9 9 0 0 1-15.4 6.4', 'M3 12a9 9 0 0 1 15.4-6.4', 'M18 2v4h-4', 'M6 22v-4h4'],
  subscription: ['M12 3l2.7 5.5 6 .9-4.3 4.2 1 6L12 16.8 6.6 19.6l1-6L3.3 9.4l6-.9z'],
  refresh: ['M20 12a8 8 0 1 1-2.3-5.7', 'M20 4v5h-5'],
  feedback: ['M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.9A8 8 0 1 1 21 12z'],
  admin: ['M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z', 'M9 12l2 2 4-4'],
};

const LABELS: Record<MenuEntryId, string> = {
  settings: 'menu.settings',
  calendars: 'menu.calendars',
  partner: 'menu.partner',
  chooseCalendars: 'menu.chooseCalendars',
  reconnectGoogle: 'menu.reconnectGoogle',
  subscription: 'menu.subscription',
  refresh: 'menu.refresh',
  feedback: 'menu.feedback',
  admin: 'menu.admin',
};

export interface MenuSheetProps {
  calendarSource: 'GOOGLE' | 'NATIVE';
  isAdmin: boolean;
  locale: string;
  userId: number;
  /** A page: the container closes the sheet and moves there. */
  onNavigate: (href: string) => void;
  /** Refresh: fresh=1 on every visible window. */
  onRefresh: () => void;
  onClose: () => void;
}

export function MenuSheet({ calendarSource, isAdmin, locale, userId, onNavigate, onRefresh, onClose }: MenuSheetProps) {
  const t = useTranslations('calendarHome');
  const entries = menuEntries({ calendarSource, isAdmin, locale, userId });
  return (
    <BottomSheet label={t('header.menu')} closeLabel={t('actions.close')} onClose={onClose}>
      <ul className="ch-options" role="list">
        {entries.map(({ id, href }) => (
          <li key={id} className="ch-option-li">
            <button
              type="button"
              className="ch-option ch-option-compact ch-tap"
              data-menu={id}
              onClick={() => (href === null ? onRefresh() : onNavigate(href))}
            >
              <span className="ch-option-icon ch-option-icon-sm">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
                  {ICONS[id].map((d) => (
                    <path key={d} d={d} />
                  ))}
                </svg>
              </span>
              <span className="ch-option-title">{t(LABELS[id])}</span>
            </button>
          </li>
        ))}
      </ul>
    </BottomSheet>
  );
}
```

- [ ] **Step 11: Create `app/[locale]/dashboard/HomeErrorBoundary.tsx`**

The error boundary and its card; a chunk-load error reloads once.

Create `app/[locale]/dashboard/HomeErrorBoundary.tsx` with exactly this content:

```tsx
'use client';

// The error boundary around the calendar home (spec §5): a render error shows a calm
// card with Reload instead of a blank Mini App. A failed chunk load (a deploy replaced
// the files while the app was open) reloads the page once by itself, letting Telegram's
// BackButton go first; the guard in sessionStorage keeps that from looping. The fallback
// carries the home's own look and hides a Telegram BackButton the client kept from
// before. The home's own chunk failing to load is PageGate's boundary's (D7): this one
// lives inside that chunk.

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { CHUNK_RELOAD_KEY, isChunkLoadError, reloadOnce } from '@/src/lib/calendar-view/reload-guard';
import { releaseTelegramBackButton, useTelegramBackButton, useTelegramTheme } from '@/src/lib/telegram-ui';
import { HOME_SHELL_CSS } from './home-shell';
import { HOME_THEME_CSS } from './home-theme';

/** The guard's sessionStorage key for the chunk-load reload (reload-guard's, shared with PageGate's boundary). */
export { CHUNK_RELOAD_KEY };

const noop = () => {};

function reloadPage() {
  try {
    window.location.reload();
  } catch {
    // Nothing else to do; the card stays.
  }
}

/** The boundary's card, in the home's look and the page's language. */
export function HomeCrash() {
  const t = useTranslations('calendarHome');
  const locale = useLocale();
  const scheme = useTelegramTheme();
  useTelegramBackButton(false, noop);
  return (
    <div className="ch-home" data-theme={scheme} dir={locale === 'he' ? 'rtl' : 'ltr'} lang={locale}>
      <style>{HOME_THEME_CSS}</style>
      <style>{HOME_SHELL_CSS}</style>
      <div className="ch-home-card ch-crash" role="alert">
        <h1 className="ch-home-card-title">{t('errorBoundary.title')}</h1>
        <p className="ch-home-card-body">{t('errorBoundary.body')}</p>
        <button type="button" className="ch-btn ch-btn-primary ch-home-card-action" onClick={reloadPage}>
          {t('actions.reload')}
        </button>
      </div>
    </div>
  );
}

interface State {
  failed: boolean;
}

export class HomeErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('[calendar-home] The home failed to render:', error, info.componentStack);
    if (isChunkLoadError(error)) reloadOnce(CHUNK_RELOAD_KEY, Date.now(), releaseTelegramBackButton);
  }

  render() {
    return this.state.failed ? <HomeCrash /> : this.props.children;
  }
}
```

- [ ] **Step 12: Create `app/[locale]/dashboard/CalendarHome.tsx`**

The container: the store, the loader, the Telegram calls, the shell, and the default export PageGate (D7) renders.

Create `app/[locale]/dashboard/CalendarHome.tsx` with exactly this content:

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
import { deviceTimeZone, homeSources, isPastDay, msUntilDayCheck, reloadOnce, zoneDiffers } from '@/src/lib/calendar-view/home-client';
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
 * The no-credential card's links. The server's env isn't in the browser, so these are
 * the public number and bot the landing pages link to (gate-links' defaults).
 */
const CLIENT_GATE_LINKS: GateLinks = {
  whatsapp: `https://wa.me/${DEFAULT_WA_NUMBER}?text=settings`,
  telegram: `https://t.me/${DEFAULT_BOT_USERNAME}?start=dashboard`,
};

/** The clock, the timers and the device's zone: the real ones, or a smoke's. */
export interface HomeDeps {
  now: () => number;
  setTimer: (run: () => void, ms: number) => () => void;
  deviceTimeZone: () => string | null;
}

const REAL_DEPS: HomeDeps = {
  now: () => Date.now(),
  setTimer: (run, ms) => {
    const id = setTimeout(run, ms);
    return () => clearTimeout(id);
  },
  deviceTimeZone,
};

/** Nothing to subscribe to: the value is read once on the client. */
const subscribeNothing = () => () => {};
/** On the server, and while hydrating, the home assumes Telegram (no browser banner). */
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
      ) : (
        <>
          <p className="ch-home-card-title">{t('state.errorTitle')}</p>
          <p className="ch-home-card-body">{t('state.errorBody')}</p>
        </>
      )}
      <button type="button" className="ch-btn ch-btn-primary ch-home-card-action" onClick={onRetry}>
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
      getStore: () => storeRef.current,
      getWeeks: () => weeksRef.current,
      dispatch,
      isBlocked: () => blockedRef.current !== null,
      firstLoadFailed: () => firstLoadRef.current !== null,
      onAnswer: () => setFirstLoad(null),
      onFirstLoadFailed: (kind) => setFirstLoad(kind),
      onNoCredential: () => {
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
  useEffect(() => {
    const foreground = () => {
      const facts = storeRef.current.facts;
      if (facts && isPastDay(deps.now(), facts.tz, facts.today) && resetFor.current !== facts.today) {
        resetFor.current = facts.today;
        dispatch({ type: 'reset' });
        return;
      }
      loaderRef.current?.refetchVisible();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') foreground();
    };
    document.addEventListener('visibilitychange', onVisibility);
    const offActivated = onTelegramEvent('activated', foreground);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      offActivated();
    };
  }, [deps]);

  // Midnight in the user's timezone drops the store (D3's reset), once per day the
  // server named; the loader then starts over.
  const tz = store.facts?.tz ?? null;
  const today = store.facts?.today ?? null;
  useEffect(() => {
    if (!tz || !today) return;
    let cancel = () => {};
    const arm = () => {
      cancel = deps.setTimer(() => {
        if (isPastDay(deps.now(), tz, today) && resetFor.current !== today) {
          resetFor.current = today;
          dispatch({ type: 'reset' });
          return;
        }
        arm();
      }, msUntilDayCheck(deps.now(), tz));
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
    },
    [router],
  );
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
        reconnect={notices.reconnect}
        inTelegram={inTelegram}
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
          locale={locale}
          userId={userId}
          onNavigate={navigate}
          onRefresh={refresh}
          onClose={closeSheet}
        />
      ) : null}
    </div>
  );
}

export default function CalendarHome(props: CalendarHomeProps) {
  return (
    <HomeErrorBoundary>
      <CalendarHomeContainer {...props} />
    </HomeErrorBoundary>
  );
}
```

- [ ] **Step 13: Run the smoke under the three clocks and see it pass**

```bash
cd /Users/razielgershoni/development/famcalbot
for tz in UTC Asia/Jerusalem Pacific/Kiritimati; do
  eval "env TZ=$tz $E npx tsx scripts/smoke-calendar-home-render.ts" 2>&1 | grep -E '^(OK|FAIL)|passed'; echo "TZ=$tz exit ${pipestatus[1]}"
done
```
(zsh: `pipestatus` is zsh's; in bash use `${PIPESTATUS[0]}`.) Expected under `TZ=UTC`:
```
OK  #1 the view is client-safe: AgendaView and ItemSheet load no server module (DB, Redis, services, date-fns-tz, @hebcal/core)
OK  #2 en: day labels, the Hebrew date, the fold line, times in Israel (24-hour), spans, reminder states and the person chips
OK  #3 the "Still open" card: today's open reminders, then the carry-overs, each with "since", and who set it
OK  #4 he: dir="rtl", the Hebrew mockup's labels ("חמישי 15 באוק׳") and fold line ("אין אירועים בשבת 17 – ראשון 18 באוק׳"), Hebrew dates, times set dir="ltr"
OK  #5 ru: Russian labels, plural forms and the genitive Hebrew month (Ruling R9)
OK  #6 Plan D's shape: no tab bar, no Month, no untranslated key, in each language
OK  #7 privacy: no calendar id reaches the markup, and a masked partner calendar reads "Noa's calendar"
OK  #8 Google items: "Google · <calendar>", the birthday label, the spouse's chip, partial and unavailable rows
OK  #9 "Empty means answered": a FamCal error, a Google reconnect or calendars_gone show no "Nothing planned" and no fold, and the right state row
OK  #10 loading: placeholders and the loading text before the first answer, and for a week still on its way; never free days
OK  #11 the empty state (Ruling R10) names only the ways this user can add things; a Google user still setting up (setupNeeded) gets no Agenda at all
OK  #12 Hebrew dates show only when the route says so
OK  #13 the item sheet (§7.5): title, time range, calendar, location, notes, who set it, the reminder's state; Google adds "Open in Google Calendar"
OK  #14 accessibility in the markup: every tap a type="button", every icon hidden, no text under 11 px, no tap under 44 px, logical properties only, reduced motion; the colours fall back to globals.css's brand tokens, and the page root takes the theme's background
OK  #15 every date and time follows the route's timezone, never the device clock (the same markup in four process zones, Los Angeles included)
OK  #16 a tap selects the row through the container's onSelect and opens the sheet; closing hands back null and focus returns to the row; AgendaView never touches Telegram's BackButton (the container's one button)
OK  #17 in a browser, the Close button, Escape and a tap on the scrim each close the sheet
OK  #18 "Open in Google Calendar" goes through Telegram's openLink; outside Telegram, a new tab
OK  #19 the buttons call the container: Show next week, Retry with its source, Choose again; "N more" opens the rest of the card
OK  #20 an open sheet shows the latest copy of its item after a refetch; with no model (a store drop) there is no sheet, whatever the container still holds
OK  #21 the container is client-safe: CalendarHome and its parts load no server module
OK  #22 CalendarHome (en, FamCal, in Telegram): one range request, no dates, the init data in the header only; placeholders, then the server's today, its Hebrew date and the Agenda; Telegram's theme and a hidden BackButton on mount; no tab bar
OK  #23 he and ru: the root dir="rtl" and the Hebrew header and labels; the Russian header with the genitive Hebrew month (R9); the send icon flips in RTL
OK  #24 privacy through the container: no calendar id anywhere in the home, sheet open or not, and a masked partner calendar reads as the partner's
OK  #25 Google (fake clock): sources=google with the page's user_id; a stale answer asks that window once more after about 3 s, once; a Google error retries once after about 5 s; calendars_gone never retries
OK  #26 "Show next week" asks [today+7, today+14); a return to the foreground (visibilitychange, Telegram's activated) asks every visible window once; ⋯ → Refresh sends fresh=1 on each and closes the menu
OK  #27 midnight in the user's timezone: the store starts over with a no-dates request and the header moves to the new day; a stale re-request for the day that ended is dropped; the day check never waits more than an hour, and lands after a midnight that DST skips
OK  #28 404 not_enabled reloads once (PageGate then shows today's dashboard), and with the item sheet open Telegram's BackButton is let go (offClick, hide) before the reload; within the guard, the retry card, whose Retry reloads by hand; 401, 403 and any other 404 show PageGate's card and nothing more is asked
OK  #29 before any answer, a 429 shows the busy card and a 500, no answer or a body that isn't a RangeResponse the retry card, with no loop; Retry asks again. Once the facts are pinned, a 429 on the next week is that window's busy row
OK  #30 the send sheet (R5): five options in order; a tap posts its command for the page's user_id; in Telegram a 2xx closes the app with the spinner kept, one send at a time; in a browser "Sent to WhatsApp"; 429, 403, no answer and a 500 each say why, and the sheet stays
OK  #31 the ⋯ menu (R6): FamCal users get Calendars and Partner, Google users Choose calendars and Reconnect Google, admins the Admin panel; each opens its page with the page's user_id, and the sheet closes
OK  #32 the banners (§7.2), in order: trial, location, the Google setup card, Reconnect (token or scopes; never with Connect, never for FamCal) and, in a browser, Open FamCal in Telegram; each opens its page
OK  #33 "Times in <zone>" shows only when the device is in another zone than the route's (an alias is the same zone)
OK  #34 the shell's CSS (§7.1): nothing under 11 px, taps at least 44 px, logical properties only, no hover, overflow-x: clip (never hidden), the stable viewport height, both safe-area families with 0 fallbacks, no transform or filter on the frame
OK  #35 the error boundary (§5): a render error shows the Reload card in the home's look and language; a chunk-load error reloads once by itself, never twice in a minute
OK  #36 a range request that never settles is aborted after about 15 s and counts as no answer: before any answer, the retry card, and the next return to the foreground asks again; once the facts are pinned, a hung refetch no longer holds back the next one
OK  #37 Telegram's BackButton is the container's one (§7.6): hidden on mount; shown while the item sheet, the Send sheet or the ⋯ menu is open; a tap (also Android's back gesture) closes only that sheet, then offClick and hide; a store drop closes the item sheet for good
OK  #38 a Google user who connected but hasn't chosen calendars (the route answers ok with 7 empty days): the Choose your calendars banner, and under it no "Nothing planned", no hint, no fold, no "Show next week"; before connecting, the Connect banner the same way
OK  #39 back in the foreground after the night, the midnight timer not yet run (iOS suspends timers): the store starts over at once with a no-dates request, the header and Today move to the new day, yesterday's items are never labelled Today, and the late timer resets nothing; a device clock that runs ahead resets once, then only refetches; with init data over a day old the route answers 401 and the home shows PageGate's card
OK  #40 React logged no warning in any render, CalendarHome's included (keys, nesting, attributes, act)
40/40 passed (process TZ=UTC)
TZ=UTC exit 0
```
Then the same 40 lines under `Asia/Jerusalem` and `Pacific/Kiritimati`, with that zone in the last line. #1–#20 are D5's checks, unchanged.

- [ ] **Step 14: Run the regression smokes again**

```bash
cd /Users/razielgershoni/development/famcalbot
for f in smoke-initdata-header smoke-auth-leftovers smoke-miniapp-gate smoke-calendar-home-copy smoke-hebrew-date smoke-calendar-agenda smoke-telegram-ui smoke-command-client check-i18n-parity; do
  for tz in UTC Asia/Jerusalem; do
    eval "env TZ=$tz $E npx tsx scripts/$f.ts" > /tmp/d6-$f.log 2>&1; echo "$f TZ=$tz exit $?"
    grep -E '^(OK|FAIL)|passed|parity' /tmp/d6-$f.log > /tmp/d6-$f-${tz//\//_}.after
    cmp -s /tmp/d6-$f-${tz//\//_}.before /tmp/d6-$f-${tz//\//_}.after && echo "  same output as Step 2" || echo "  OUTPUT CHANGED"
  done
done
```
Expected: every run prints `exit 0` and `same output as Step 2`. `smoke-initdata-header` #8 and `smoke-auth-leftovers` now also scan the new files, and they stay green.

- [ ] **Step 15: Type-check and lint**

```bash
cd /Users/razielgershoni/development/famcalbot
npx tsc --noEmit -p . ; echo "tsc exit $?"
npm run -s lint ; echo "lint exit $?"
```
Expected: `tsc exit 0` and `lint exit 0`, with no output from either. `next build` type-checks `scripts/**`, so the smoke is covered too.

- [ ] **Step 16: Commit**

```bash
cd /Users/razielgershoni/development/famcalbot
git add src/lib/calendar-view/home-props.ts src/lib/telegram-ui.ts src/lib/calendar-view/reload-guard.ts src/lib/calendar-view/home-client.ts src/lib/calendar-view/home-loader.ts 'app/[locale]/dashboard/home-shell.ts' 'app/[locale]/dashboard/HomeHeader.tsx' 'app/[locale]/dashboard/HomeBanners.tsx' 'app/[locale]/dashboard/SendSheet.tsx' 'app/[locale]/dashboard/MenuSheet.tsx' 'app/[locale]/dashboard/HomeErrorBoundary.tsx' 'app/[locale]/dashboard/CalendarHome.tsx' scripts/smoke-calendar-home-render.ts
git commit -m "$(cat <<'EOF'
feat(calendar-home): the CalendarHome container

CalendarHome is the home PageGate renders for the users the rollout
switch covers: the Agenda under a header with the server's today and
its Hebrew date, the Send to chat sheet (R5) and the menu (R6), with no
tab bar (R19). On mount it asks the range route once per source with no
dates; Show next week adds a week; midnight in the user's timezone, a
change of facts, a return to the foreground and Refresh (fresh=1) ask
the visible weeks again, each window once at a time; a return after the
day has ended starts over at once. A stale Google answer asks once more
after about 3 s, a Google error retries once after about 5 s, and a
request that hangs is aborted after 15 s. 404 not_enabled lets
Telegram's BackButton go and reloads once, so PageGate shows today's
dashboard; 401, 403 and other 404s show PageGate's card; 429 and 500
become a state row, or a card before the first answer. Telegram's one
BackButton closes the item sheet, the send sheet or the menu. Banners: trial,
location, the Google setup card (with no Agenda under it), Reconnect
and, in a browser, Open FamCal in Telegram. An error boundary wraps the home, and a chunk-load
error reloads once. The theme, safe areas, document scroll, RTL and
"Times in <zone>" follow spec section 7.1. CalendarHomeProps gains two
optional fields for the trial and location banners. Nothing renders the
home until the PageGate change, and the switch stays OFF.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
EOF
)"
```
Stage only these thirteen paths. The working tree may show plan or spec files as modified; they aren't part of this task.

---

### Task 7 (D7): page-data and PageGate (spec §7.1's `/dashboard`, §7.3's hints, §5's loading; edits 13 and 14)

> **INTERFACE CHANGE VERSUS THE SPLIT: none.** `DashboardPageProps` gains exactly `calendarHome: boolean` and `hints?: HomeHints`, and PageGate hands `CalendarHome` exactly the split's `CalendarHomeProps`, with D6's two optional fields filled (`trialDaysLeft`, `hasLocation`; D6's interface change 1). Three additions that later work may rely on:
> 1. **`renderPage` is now exported from `app/[locale]/PageGate.tsx`**, so `smoke-miniapp-gate.ts` can render the dashboard branch. Nothing else imports it.
> 2. **A failed voice-events check reads as `voiceEvents: false`** and captures a warning under the context `calendar-home-hints`. The page still answers. `getReminderSupport` already fails closed the same way. The split doesn't say what a failed check does; this keeps the hints from ever failing the page or promising a feature (R10).
> 3. **`DashboardClient` never sees the two new fields.** PageGate takes `calendarHome` and `hints` off before it spreads the rest, so the old home gets byte-for-byte the props it always had.
> 4. **PageGate wraps `CalendarHome` in its own boundary, `HomeChunkBoundary`** (exported for the smokes; review patch). Spec §5's error boundary is D6's `HomeErrorBoundary`, which lives inside the home's chunk, so it can't catch that chunk failing to load, the likeliest chunk-load error (a deploy landing between the HTML and the chunk's fetch), and the app has no `error.tsx`: the user got Next's blank client-exception screen. The boundary reloads once on a chunk-load error, with the home's own guard key from D6's leaf `reload-guard.ts`, behind the purple loader; within the guard, or for any other error, it shows the gate's error card, whose button reloads. Only the users the switch covers render it; `DashboardClient` gets no boundary.
>
> **For the PR, visible to everyone whatever the switch says** (switch-off costs the review named; Plan D's Delivery row doesn't list them, so the PR must):
> - `PRELOAD.dashboard` downloads and runs the calendar home's chunk on every dashboard open, as spec §7.1 asks (in the integration builds, `wt/D-build` on the scratch base and `wt/D-real-build` on the real base: one 66.9 KB chunk, 19.5 KB gzipped, plus the `@hebcal/hdate` and Russian-locale chunks it shares). Nothing in it runs unless the switch covers the user.
> - Every page's message payload carries the `calendarHome` namespace (`app/[locale]/layout.tsx` hands all messages to `NextIntlClientProvider`, as it does every other namespace): about 4.3 KB (en), 5.5 KB (he) and 6.8 KB (ru) of raw JSON per page view.
> - PageGate's own chunk, which every page loads, gains the boundary and the leaf guard, and none of the home's code (`smoke-miniapp-gate` #20 checks its imports; in the build, `/api/calendar/range` appears only in the home's chunk).
>
> **Settled with D6 (D1's note):** D6 added two optional fields to `CalendarHomeProps` in `src/lib/calendar-view/home-props.ts`, `trialDaysLeft?: number | null` and `hasLocation?: boolean`, for spec §7.2's trial and location banners. `calendarHomeProps` in Step 5 fills both from fields page-data already sends: `trialDaysLeft` with the old home's trial rule (`DashboardClient.tsx:761`: not an early adopter, trialing, more than 0 days left; else `null`), and `hasLocation` as `Boolean(user.location)`. `smoke-miniapp-gate` #16 and #18 check both. Without them the two banners would never show, which spec §7.2 asks for.

**What and why:** This is the last step of Plan D. It turns the new home on for the users the rollout switch covers, and only for them. The home itself (D5's Agenda and D6's container) already exists but nothing renders it. Two edits from spec §2.1:
- **Edit 13, `src/lib/page-data.ts` (dashboard):** the dashboard's props gain `calendarHome: await isCalendarHomeOn(user)`. Only when it is true, page-data also works out the empty state's how-to-add hints (§7.3, R10): `reminders` is `getReminderSupport(user).supported` and `voiceEvents` is `checkFeatureAccess(user.id, 'voice_events').allowed`. It also logs one `webapp_opened` activity for that open (§7.1). The switch read joins the existing `Promise.all`, so it costs no extra round trip. Users the switch doesn't cover never run the two checks and log nothing.
- **Edit 14, `app/[locale]/PageGate.tsx`:** when `calendarHome` is true, PageGate renders `CalendarHome` with `CalendarHomeProps`, inside `HomeChunkBoundary` (a chunk that fails to load reloads once, else the gate's error card). Otherwise it renders today's `DashboardClient`, which stays as the fallback. `PRELOAD.dashboard` starts both chunks while the data is in flight, because only the data says which one is needed. `LOOK.dashboard` stays `'telegram'`: the purple loader shows until the data and the chunk arrive, and `CalendarHome` applies its own look on mount (D4's `useTelegramTheme`).

The switch ships `OFF`, so nobody's screen changes when this lands. Admins get the home once an admin sets the switch to `ADMINS`, and everyone else keeps today's dashboard.

**Files** (line numbers as of the real base; D1–D4 leave these four files unchanged, and the split gives them to this task alone):
- Modify: `src/lib/page-data.ts`, six spots:
  - `:12-13`: the header comment;
  - `:23-24`: three service imports and `checkFeatureAccess`;
  - `:32`: the `HomeHints` type import;
  - `:47-50`: `DashboardPageProps`;
  - `:121-126` (inside `dashboard()`, `:113-152`): the switch joins the `Promise.all`;
  - `:148-152`: the props' new fields, the open, and the new `calendarHomeFor` right after `dashboard()`.
- Modify: `app/[locale]/PageGate.tsx`, seven spots:
  - `:6-10`: the header comment, and React's `Component`;
  - `:15`: the `CalendarHomeProps` / `HomeHints` type import;
  - `:17`: the reload guard from D6's `src/lib/calendar-view/reload-guard.ts`;
  - `:85-86`: the `CalendarHome` dynamic component;
  - `:94-95`: `PRELOAD.dashboard`;
  - `:103-109`: `calendarHomeProps` and the exported `renderPage`'s dashboard case, inside `HomeChunkBoundary`;
  - `:136`: `HomeChunkBoundary` and its card, before the notices' context.
- Modify (test): `scripts/smoke-page-auth.ts` (`:14-17` header, `:264-266` recorders, `:333-334` stubs, `:369-372` seed, `:601-604` new checks #11–#14).
- Modify (test): `scripts/smoke-miniapp-gate.ts` (`:20-23` header, `:110-113` placeholders, `:423-427` new checks #16–#20).
- Modify (test): `scripts/smoke-calendar-home-render.ts` (D5's smoke with D6's checks; `:45-46` header, `:71-72` import, `:2148` the new #40 before the last check, which becomes #41).
- Regression (unchanged): `scripts/smoke-calendar-home-copy.ts` (renders `TelegramDashboardRedirect`, which imports PageGate), `scripts/smoke-oauth-weather.ts` (reads PageGate's source), `scripts/smoke-initdata-header.ts` (its #8 scans `app/**` outside `app/api`, `components/**` and `src/**` for initData in URLs), `scripts/smoke-calendar-home-rollout.ts` (the switch), `scripts/smoke-native-reminder-support.ts` (`getReminderSupport`), `scripts/smoke-auth-identity.ts` (verifyUserAuth and the page routes), `scripts/check-i18n-parity.ts`.

**Interfaces:**
- Consumes:
  - from B1, `src/services/calendar-read/rollout.ts`: `isCalendarHomeOn(user: { isAdmin?: boolean | null }): Promise<boolean>`. It never throws (both stores failing reads as `OFF`), and it memoizes for 30 s on `globalThis.__calendarHomeRolloutMemo` (since Plan C, an `OFF` that neither store answered is kept for 5 s);
  - `getReminderSupport(user: { id: number; calendarSource: string; telegramId?: bigint | number | string | null }): Promise<ReminderSupport>` (`src/services/native-reminders/support.ts:87-105`). It never throws;
  - `checkFeatureAccess(userId: number, feature: FeatureType): Promise<FeatureAccessResult>` (`src/services/subscription-service.ts:671`). It can throw on a cache miss whose DB read fails;
  - `trackActivityAsync(userId: number, action: ActivityAction, metadata?): void` (`src/services/analytics-service.ts:215`). `'webapp_opened'` is already an `ActivityAction` (`:49`) that nothing logs yet;
  - `captureError(error, context, extra?, severity?)` (`src/lib/error-capture.ts:21`);
  - from D5, `src/lib/calendar-view/home-props.ts` (type-only, client-safe):
    ```ts
    export type HomeHints = { reminders: boolean; voiceEvents: boolean };
    export type CalendarHomeProps = {
      user: { id: number; name: string; isAdmin: boolean };
      locale: string;
      calendarSource: 'GOOGLE' | 'NATIVE';
      needsOAuth: boolean;
      needsCalendars: boolean;
      hints: HomeHints;
      trialDaysLeft?: number | null;   // D6's addition: the trial banner
      hasLocation?: boolean;           // D6's addition: the location banner
    };
    ```
  - from D6, `app/[locale]/dashboard/CalendarHome.tsx`: `export default function CalendarHome(props: CalendarHomeProps)`;
  - from D6, `src/lib/calendar-view/reload-guard.ts` (a leaf with no imports): `CHUNK_RELOAD_KEY`, `isChunkLoadError(error: unknown): boolean`, `reloadOnce(key, nowMs?, beforeReload?): boolean`.
- Produces:
  - `src/lib/page-data.ts`:
    ```ts
    export type DashboardPageProps = Omit<DashboardProps, 'trial'> & {
      trial: Omit<DashboardProps['trial'], 'trialEndsAt'> & { trialEndsAt: string | null };
      calendarHome: boolean;
      hints?: HomeHints;          // set exactly when calendarHome is true
    };
    ```
    On the wire, `POST /api/page-data` with `page: 'dashboard'` answers `{ kind: 'props', props }` where `props` is today's nine fields plus `calendarHome`, and plus `hints` only when `calendarHome` is true.
  - `app/[locale]/PageGate.tsx`: `export function renderPage(page: PageName, props: PagePropsMap[PageName])`, which returns the page's element (it was private; the return type stays inferred). The dashboard case returns `<HomeChunkBoundary><CalendarHome {...CalendarHomeProps} /></HomeChunkBoundary>` when `calendarHome` is true, else `<Dashboard …/>` with exactly today's props.
  - `app/[locale]/PageGate.tsx`: `export class HomeChunkBoundary extends Component<{ children: ReactNode }, { failed: boolean; reloading: boolean }>`.
  - What `CalendarHome` receives, field by field:

    | `CalendarHomeProps` | From the dashboard props |
    |---|---|
    | `user.id` | `user.id`: the page's `?user_id` (a Telegram id or a DB id), exactly as `DashboardClient` gets it. D6 sends it as `user_id` to the range route and to `execute-command`, which both resolve it with `verifyUserAuth`. Never the DB id, never swapped. |
    | `user.name`, `user.isAdmin` | the same fields |
    | `locale` | `locale` |
    | `calendarSource` | `calendarSource`, `'NATIVE'` when absent (the column's default; page-data always sets it) |
    | `needsOAuth`, `needsCalendars` | the same fields (both false for FamCal users) |
    | `hints` | `hints`, `{ reminders: false, voiceEvents: false }` when absent |
    | `trialDaysLeft` (D6, optional) | `trial.daysRemaining` when `!isEarlyAdopter && trial.isTrialing && trial.daysRemaining > 0` (the old home's rule, `DashboardClient.tsx:761`), else `null` |
    | `hasLocation` (D6, optional) | `Boolean(user.location)` |

**Findings that shaped the code:**
- **page-data's user is the fresh DB row.** `app/api/page-data/route.ts:31-41` hands `loadPageData` the row `verifyUserAuth` just loaded, so `isCalendarHomeOn(user)` sees the current `isAdmin`, as spec §1 asks of every call site. A locale mismatch returns its redirect (`page-data.ts:91-95`) before `dashboard()` runs, so a redirect reads no switch, runs no hint check and logs no open.
- **The switch read is cheap and never throws.** `getCalendarHomeRollout` answers from a 30 s in-process memo, then Redis, then the DB, and reads `OFF` when both fail, keeping that `OFF` for 5 s with one warning (`rollout.ts:52-96`; the 5 s memo is Plan C's). So it goes inside the existing `Promise.all`, and the hint checks run after it only when it is on.
- **The hint checks.** `getReminderSupport` checks the source, then Telegram, then the native-reminders switch (Redis, then DB), then `checkFeatureAccess(user.id, 'reminders')`, and fails closed on a throw (`support.ts:87-105`). A Google user gets `not_native` before any Redis read. `checkFeatureAccess` answers from its 24 h Redis cache; on a miss `computeFeatureAccess` can throw on a DB error, and it logs `feature_blocked` only then (`subscription-service.ts:671-805`). The voice-events check is wrapped to fail closed too, so no hint can fail the page.
- **`webapp_opened` is the existing action**, declared in `ActivityAction` and never logged before. `trackActivityAsync` writes `userActivity` under the DB id (`user.id`), like every other activity. It is fire and forget, and it runs after the `Promise.all` resolves, so a page that fails to load logs no open. A retry from the error card is a new load and logs again. In development, React's StrictMode runs PageGate's fetch effect twice, so a dev open can log two rows. Production logs one.
- **The URL's user id stays the client's id.** `dashboard()` sets `user.id` to `urlUserId` (`page-data.ts:136`), the `?user_id` the page was opened with. `DashboardClient` posts it to `execute-command`. `CalendarHome` gets the same value, never `user.id` from the row (the user-id rule for Telegram flows).
- **`DashboardClient`'s props stay exactly as they were.** `DashboardPageProps` is `ComponentProps<typeof DashboardClient>` reshaped, and PageGate spread all of it into `<Dashboard>`. With the two new fields, PageGate destructures them off first, so the old home's props are unchanged. `smoke-miniapp-gate` #17 checks the key set.
- **`next/dynamic` under tsx is the pages-router loadable** (`next/dist/shared/lib/loadable.shared-runtime.js`). On the server, the first render of a dynamic component starts its `import()` and renders its `loading`. Once the import has resolved, the next render renders the component. So the gate smoke renders `renderPage(...)` once, which shows the purple loader, and again until a placeholder records its props. No `preloadAll()`: that would load all six pages' real chunks, and `SettingsClient` and the others can't load under tsx.
- **Both homes are placeholders in the gate smoke.** `DashboardClient` imports `@hebcal/core`, which has no `require` entry (the existing stub). The real `CalendarHome` is D5's render smoke's job (`scripts/smoke-calendar-home-render.ts`). Here a placeholder at the real path records its props, which also proves PageGate imports `./dashboard/CalendarHome`.
- **The page-auth smoke runs the real gates.** It wraps `checkFeatureAccess` and `getReminderSupport` in recorders and runs the real ones inside. The support module loads after the wrapped subscription service, so its own `'reminders'` check goes through the recorder too. The answers come from the Redis feature cache the smoke fills (`REDIS_KEYS.featureAccess`) and from the native-reminders switch. `seed()` also clears the rollout memo, so each check starts from its own `AdminSettings` row.
- **`PRELOAD` is checked in the source**, like `smoke-miniapp-gate`'s other PageGate checks (#1, #9). Its loader only matters in a browser.
- **The home's chunk needs a boundary outside it** (review patch). `HomeErrorBoundary` is inside the chunk `dynamic(() => import('./dashboard/CalendarHome'))` loads, and the app router's `next/dynamic` is `React.lazy` in `Suspense`, so a rejected import throws to the nearest boundary above, of which there was none. `HomeChunkBoundary` sits in PageGate's dashboard branch, for switch-covered users only:
  - `getDerivedStateFromError` decides the look at once (a chunk-load error shows the loader, anything else the card), so a reload never flashes the card first;
  - `componentDidCatch` reloads with `reloadOnce(CHUNK_RELOAD_KEY)`, the home's own key, so PageGate's and the home's boundaries reload once a minute between them; when the guard holds it back (or there is no sessionStorage) it switches to the card, whose button reloads by hand (React.lazy keeps a rejected import, so only a reload can help);
  - it logs under `[calendar-home]`, the home's prefix;
  - the guard comes from D6's leaf `reload-guard.ts`, never `home-client.ts`: PageGate's chunk loads on every page, and the leaf keeps the home's store, format and loader code out of it.
- **Where its smoke runs.** Under tsx, `next/dynamic` is the pages-router loadable: a failed import renders its `loading` with an `error` prop and never throws, so the gate smoke can't make the placeholder's import reject the production way. It checks the structure instead (#20: the boundary wraps the home, not `DashboardClient`; the imports). The behaviour is `smoke-calendar-home-render` #40, which has real React: `React.lazy` in `Suspense` with an import that rejects, as the app router builds it.
- **The purple chrome stays until the home mounts.** PageGate's `startMiniApp('telegram')` (`PageGate.tsx:64-80`) still sets the `#667eea` header and the white background on its first mount, which suits the purple loader. `CalendarHome` then applies the Telegram theme on its own mount (D4's `useTelegramTheme`: `setHeaderColor('bg_color')`, `setBackgroundColor('bg_color')`). Nothing here changes `startMiniApp`, so the other pages and `smoke-miniapp-gate` #2 are untouched.

**Verified:**
- Base: `feat/calendar-home` after Plan C (verified on 2eb69df, Plan C's reference chain on 716a4f8, and again on 6dab367, the branch and `main` after Plan C, which differs from that chain only in files D doesn't touch; header, Planning Ruling 9), with D1–D6's reference commits; the results below are the same on both.
- First pass (header, Planning Ruling 9): commit 63e7d4f, with Tasks D1–D4 applied from their drafts exactly as written (D2's `package.json` and `package-lock.json` lines by hand, since `npm install` is not run in the scratch copy), plus the two stand-ins listed below.
- Before this task: `smoke-page-auth` prints `10/14 passed` (#11–#14 fail), `smoke-miniapp-gate` prints `15/20 passed` (#16–#20 fail) and `smoke-calendar-home-render` prints `40/41 passed` (#40 fails), all exit 1, under `TZ=UTC`, `TZ=Asia/Jerusalem` and `TZ=Pacific/Kiritimati`; `tsc` shows the one TS2614 of Step 3. The failure lines are in Step 3.
- After: `14/14 passed`, `20/20 passed` and `41/41 passed` under `TZ=UTC`, `TZ=Asia/Jerusalem` and `TZ=Pacific/Kiritimati`.
- The regression smokes in Step 3 print the same lines before and after, under both clocks.
- `tsc` and lint are clean.
- Mutations caught (first pass, each run under `TZ=UTC`):
  - the switch check removed, so `calendarHome` is always true → page-auth #11, #12;
  - the hints computed before the switch check → #11, #12, #14;
  - the open logged for everyone → #11, #12; logged twice → #12, #13;
  - the open logged under the URL's Telegram id → #12, #13;
  - `voiceEvents` read from the `'reminders'` check → #12, #13, #14;
  - the voice-events failure left to throw → #14;
  - PageGate never rendering `CalendarHome` → gate #16, #18;
  - `calendarHome` and `hints` passed on to `DashboardClient` → #17;
  - `user.id` taken from another field → #16;
  - `hints` defaulting to `true` → #18;
  - (added in integration) `trialDaysLeft` or `hasLocation` missing → #16; the early-adopter rule dropped → #18;
  - `PRELOAD.dashboard` without `CalendarHome` → #19;
  - the new home behind the light loader → #16;
  - (review patch) no boundary around the home → gate #20; the boundary rendering nothing → render #40; every error reloading → #40; its own guard key → #40; the guard imported from `home-client.ts` → gate #20 and render #40; the loader forever within the guard → #40.
- The task text itself was replayed on a fresh copy of 2eb69df with D1–D6's texts applied first: every Before block matched once, and the result was byte-identical to D7's reference commit. (First pass: the same on 63e7d4f + D1–D4 + the stand-ins.)

**Verified against stand-ins** (in the scratch copy only; not part of this task):
- `src/lib/calendar-view/home-props.ts` (D5): the split's `HomeHints` and `CalendarHomeProps`, verbatim (the block under Interfaces).
- `app/[locale]/dashboard/CalendarHome.tsx` (D6): `'use client'` and `export default function CalendarHome(props: CalendarHomeProps) { return <main data-stand-in="calendar-home">{props.user.name}</main>; }`. Neither smoke loads it (the gate smoke puts a placeholder at its path), so only `tsc` and lint read it. With D6's real file, `tsc` checks PageGate against D6's real default export.
- Integration (`wt/D-int`, D1–D6 applied from their drafts, no stand-ins), and again on the real base (`wt/D-real`, D1–D6's reference commits): Steps 3 and 6 print exactly the lines below under each listed clock, and `tsc` and lint are clean.

All smoke commands below use this fake environment (never `.env`):
```bash
E="DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake"
```

- [ ] **Step 1: Add the failing dashboard-branch checks to `scripts/smoke-page-auth.ts`**

Five edits in `scripts/smoke-page-auth.ts`.

The header comment (`:14-17`). Before:
```ts
// Review fix (#9): the dead /oauth-success route looked a user up by the URL's Telegram
// id with no credential and showed their name.
//
// Every check here fails until the fix lands. Numbers follow the design's smoke list.
```
After:
```ts
// Review fix (#9): the dead /oauth-success route looked a user up by the URL's Telegram
// id with no credential and showed their name.
//
// The dashboard branch (calendar-home spec §7.1, §7.3; Plan D, Task D7; #11-#14): the
// dashboard's props gain calendarHome from the rollout switch and, only when it is on,
// the empty state's hints and one webapp_opened activity. The switch, the two hint gates
// (getReminderSupport, checkFeatureAccess) and the activity log run for real over the
// fakes. The gates are wrapped in recorders, so a check can see they never run while the
// switch is off.
//
// Every check here fails until the fix lands. Numbers follow the design's smoke list.
```

The recorders (`:264-266`). Before:
```ts
const googleCalls: string[] = [];
/** When set, the stubbed Google calendar list throws this message (#10). */
let googleListError: string | null = null;
```
After:
```ts
const googleCalls: string[] = [];
/** When set, the stubbed Google calendar list throws this message (#10). */
let googleListError: string | null = null;
/** The calendar home's hint gates as called: `<feature>(<user id>)`, and getReminderSupport's user ids (#11-#14). */
const featureChecks: string[] = [];
const supportChecks: number[] = [];
/** When set, checkFeatureAccess throws for this feature (#14). */
let featureError: string | null = null;
```

The wrapped gates, after the dashboard client's stub (`:333-334`). Before:
```ts
  const DashboardClient = () => null;
  stub('app/[locale]/dashboard/DashboardClient.tsx', { __esModule: true, default: DashboardClient });
```
After:
```ts
  const DashboardClient = () => null;
  stub('app/[locale]/dashboard/DashboardClient.tsx', { __esModule: true, default: DashboardClient });
  // The calendar home's hint gates run for real inside recorders. The support module loads
  // after the wrapped subscription service, so its own 'reminders' check is recorded too.
  const subscriptionService = nodeRequire(path.join(ROOT, 'src/services/subscription-service.ts'));
  stub('src/services/subscription-service.ts', {
    ...subscriptionService,
    checkFeatureAccess: async (userId: number, feature: string) => {
      featureChecks.push(`${feature}(${userId})`);
      if (featureError === feature) throw new Error(`feature check failed in smoke: ${feature}`);
      return subscriptionService.checkFeatureAccess(userId, feature);
    },
  });
  const reminderSupport = nodeRequire(path.join(ROOT, 'src/services/native-reminders/support.ts'));
  stub('src/services/native-reminders/support.ts', {
    ...reminderSupport,
    getReminderSupport: async (user: Row) => {
      supportChecks.push(Number(user.id));
      return reminderSupport.getReminderSupport(user);
    },
  });
```

`seed()` resets the recorders and the switch's memo (`:369-372`). Before:
```ts
  googleCalls.length = 0;
  googleListError = null;
  sent.length = 0;
  captured.length = 0;
```
After:
```ts
  googleCalls.length = 0;
  googleListError = null;
  featureChecks.length = 0;
  supportChecks.length = 0;
  featureError = null;
  // The rollout switch's 30 s memo lives on globalThis: each check starts from its own row
  delete (globalThis as Row).__calendarHomeRolloutMemo;
  sent.length = 0;
  captured.length = 0;
```

The four new checks, after #10 (`:601-604`). Before:
```ts
    assert(body.includes('"/refresh-token?user_id=8880004"'), `the redirect is not to /refresh-token?user_id=8880004: ${await bodyOf(res)}`);
  });

  let failed = 0;
```
After:
```ts
    assert(body.includes('"/refresh-token?user_id=8880004"'), `the redirect is not to /refresh-token?user_id=8880004: ${await bodyOf(res)}`);
  });

  // ---- The dashboard branch: the calendar home's switch, hints and open (spec §7.1, §7.3) ----

  const { REDIS_KEYS } = await load('src/config/redis-keys.ts');
  const show = (value: unknown) => JSON.stringify(value);
  /** The dashboard's props as page-data sent them before the calendar home. */
  const TODAY_KEYS = ['user', 'calendarAssignments', 'locale', 'calendarSource', 'needsOAuth', 'needsCalendars', 'subscription', 'trial', 'isEarlyAdopter'];
  const keysOf = (value: Row) => Object.keys(value).sort().join(',');
  const hintsOf = (props: Row) => `reminders=${props.hints?.reminders} voiceEvents=${props.hints?.voiceEvents}`;
  const rollout = (value: string) => {
    DB.adminSettings = [{ id: 'global', calendarHomeRollout: value, nativeRemindersEnabled: true }];
  };
  /** A feature check's answer in the 24 h cache checkFeatureAccess reads first. */
  const cacheFeature = (userId: number, feature: string, allowed: boolean) => {
    redisStore.set(REDIS_KEYS.featureAccess(userId, feature), JSON.stringify({ allowed }));
  };
  /** The users whose webapp_opened rows landed (trackActivityAsync is fire and forget). */
  const opens = async (): Promise<number[]> => {
    await new Promise(resolve => setTimeout(resolve, 20));
    return (DB.userActivity ?? []).filter((r: Row) => r.action === 'webapp_opened').map((r: Row) => Number(r.userId));
  };
  /** page-data's dashboard props for a Telegram user, opened with their own initData. */
  const dashboardFor = async (tgId: number, locale: string): Promise<Row> => {
    const res = await pageData({ page: 'dashboard', user_id: tgId, locale, initData: initDataFor(tgId) });
    const body = res.status === 200 ? await res.clone().json() : null;
    assert(body?.kind === 'props', `${tgId}: status ${res.status} ${await bodyOf(res)}`);
    return body.props as Row;
  };

  await check('#11 dashboard with the switch OFF (no row): today\'s props plus calendarHome false, no hints; no hint check runs and no open is logged', async () => {
    seed();
    (DB.user.find((u: Row) => u.id === 1) as Row).isAdmin = true; // an admin too: only the switch decides
    const problems: string[] = [];
    for (const [tgId, locale] of [[5550001, 'he'], [8880004, 'en']] as const) {
      const props = await dashboardFor(tgId, locale);
      const want = [...TODAY_KEYS, 'calendarHome'].sort().join(',');
      if (keysOf(props) !== want) problems.push(`${tgId}: keys ${keysOf(props)} (want ${want})`);
      if (props.calendarHome !== false) problems.push(`${tgId}: calendarHome ${show(props.calendarHome)}`);
    }
    if (featureChecks.length || supportChecks.length) problems.push(`hint checks ran: ${show({ featureChecks, supportChecks })}`);
    const opened = await opens();
    if (opened.length) problems.push(`webapp_opened for ${show(opened)}`);
    assert(problems.length === 0, problems.join('; '));
  });

  await check('#12 the switch at ADMINS: a non-admin keeps today\'s dashboard with no hint check; an admin gets calendarHome, the hints and one webapp_opened under the DB id', async () => {
    seed();
    rollout('ADMINS');
    (DB.user.find((u: Row) => u.id === 4) as Row).isAdmin = true;
    cacheFeature(4, 'voice_events', true);
    const problems: string[] = [];
    const dana = await dashboardFor(5550001, 'he');
    if (dana.calendarHome !== false || 'hints' in dana) problems.push(`non-admin: calendarHome ${show(dana.calendarHome)}, hints ${show(dana.hints)}`);
    if (featureChecks.length || supportChecks.length) problems.push(`hint checks ran for the non-admin: ${show({ featureChecks, supportChecks })}`);
    const gina = await dashboardFor(8880004, 'en');
    const want = [...TODAY_KEYS, 'calendarHome', 'hints'].sort().join(',');
    if (gina.calendarHome !== true || keysOf(gina) !== want) problems.push(`admin: calendarHome ${show(gina.calendarHome)}, keys ${keysOf(gina)} (want ${want})`);
    // A Google user: getReminderSupport answers not_native before any feature check
    if (hintsOf(gina) !== 'reminders=false voiceEvents=true' || keysOf(gina.hints ?? {}) !== 'reminders,voiceEvents') problems.push(`admin hints ${show(gina.hints)}`);
    if (show(featureChecks) !== show(['voice_events(4)']) || show(supportChecks) !== show([4])) problems.push(`hint checks ${show({ featureChecks, supportChecks })}`);
    const opened = await opens();
    if (show(opened) !== show([4])) problems.push(`webapp_opened for ${show(opened)} (want [4]: the DB id, once)`);
    assert(problems.length === 0, problems.join('; '));
  });

  await check('#13 the hints are the real gates (R10): a FamCal user on Telegram with reminders and no voice events; the native-reminders switch off clears reminders; ALL covers non-admins; one open per load', async () => {
    seed();
    rollout('ALL');
    cacheFeature(1, 'reminders', true);
    cacheFeature(1, 'voice_events', false);
    const problems: string[] = [];
    const first = await dashboardFor(5550001, 'he');
    if (first.calendarHome !== true) problems.push(`calendarHome ${show(first.calendarHome)}`);
    if (hintsOf(first) !== 'reminders=true voiceEvents=false') problems.push(`hints ${hintsOf(first)}`);
    if (!featureChecks.includes('reminders(1)') || !featureChecks.includes('voice_events(1)')) problems.push(`feature checks ${show(featureChecks)}`);
    redisStore.set(REDIS_KEYS.NATIVE_REMINDERS_ENABLED, 'false');
    const second = await dashboardFor(5550001, 'he');
    if (hintsOf(second) !== 'reminders=false voiceEvents=false') problems.push(`with native reminders off: ${hintsOf(second)}`);
    const opened = await opens();
    if (show(opened) !== show([1, 1])) problems.push(`webapp_opened for ${show(opened)} (want [1,1]: once per load)`);
    assert(problems.length === 0, problems.join('; '));
  });

  await check('#14 a failing voice-events check reads as no hint: the page still answers, voiceEvents false, with a warning', async () => {
    seed();
    rollout('ALL');
    cacheFeature(1, 'reminders', true);
    featureError = 'voice_events';
    const props = await dashboardFor(5550001, 'he');
    assert(props.calendarHome === true && hintsOf(props) === 'reminders=true voiceEvents=false',
      `calendarHome ${show(props.calendarHome)}, ${hintsOf(props)}`);
    assert(captured.some(c => c.startsWith('calendar-home-hints: ') && c.includes('voice_events')), `captured: ${show(captured)}`);
  });

  let failed = 0;
```

- [ ] **Step 2: Add the failing dashboard-branch checks to `scripts/smoke-miniapp-gate.ts`, and the chunk-boundary check to `scripts/smoke-calendar-home-render.ts`**

Three edits in `scripts/smoke-miniapp-gate.ts`.

The header comment (`:20-23`). Before:
```ts
// The pages, PageGate's cards, the magic-link route and its service run for real. Faked
// at the boundaries: Redis (in memory), Prisma (the one user lookup the magic route
// makes), the dashboard client (it cannot load under tsx), and the browser window. No
// network, no DB.
```
After:
```ts
// The dashboard's two homes (calendar-home spec §7.1; Plan D, Task D7; #16-#20): the
// props' calendarHome picks CalendarHome or today's DashboardClient, each with exactly the
// props it takes. The new home loads behind the dashboard's purple loader, and both
// chunks start loading while the data is in flight. The new home's chunk sits inside
// PageGate's own boundary (spec §5); what it does with a failed import is the render
// smoke's #40, in real React (next/dynamic under tsx is the pages-router loadable, which
// never throws on a failed import).
//
// The pages, PageGate's cards and its dashboard branch, the magic-link route and its
// service run for real. Faked at the boundaries: Redis (in memory), Prisma (the one user
// lookup the magic route makes), the two dashboard homes (placeholders that record their
// props; DashboardClient cannot load under tsx), and the browser window. No network, no DB.
```

The two placeholders (`:110-113`). Before:
```ts
function installStubs() {
  // DashboardClient imports @hebcal/core, which ships ESM only with no require entry, so
  // it cannot load under tsx. Nothing here renders it.
  stub('app/[locale]/dashboard/DashboardClient.tsx', { __esModule: true, default: () => null });
```
After:
```ts
/** What PageGate's dashboard branch rendered: each home's placeholder records its props (#16-#18). */
const rendered: { home: 'DashboardClient' | 'CalendarHome'; props: Row }[] = [];

function installStubs() {
  // DashboardClient imports @hebcal/core, which ships ESM only with no require entry, so
  // it cannot load under tsx. It and the calendar home are placeholders at their real
  // paths: each records the props PageGate hands it and renders one marker line.
  stub('app/[locale]/dashboard/DashboardClient.tsx', {
    __esModule: true,
    default: function DashboardClient(props: Row) {
      rendered.push({ home: 'DashboardClient', props });
      return 'smoke:DashboardClient';
    },
  });
  stub('app/[locale]/dashboard/CalendarHome.tsx', {
    __esModule: true,
    default: function CalendarHome(props: Row) {
      rendered.push({ home: 'CalendarHome', props });
      return 'smoke:CalendarHome';
    },
  });
```

The five new checks, after #15 (`:423-427`). Before:
```ts
    const forged = await call(`${payload}.forged`);
    assert(forged.to === '/he/dashboard', `forged session: ${forged.to}`);
  });

  let failed = 0;
```
After:
```ts
    const forged = await call(`${payload}.forged`);
    assert(forged.to === '/he/dashboard', `forged session: ${forged.to}`);
  });

  // ---- The dashboard's two homes (spec §7.1) ----

  /** The dashboard's props as page-data sends them before the calendar home (the trial end as an ISO string). */
  const DASHBOARD: Row = {
    user: { id: 5550001, name: 'Dana', location: 'Tel Aviv', calendarsCount: 0, isAdmin: true },
    calendarAssignments: [],
    locale: 'he',
    calendarSource: 'NATIVE',
    needsOAuth: false,
    needsCalendars: false,
    subscription: { plan: 'FREE', status: 'TRIALING', effectivePlan: 'PRO' },
    trial: { isTrialing: true, daysRemaining: 5, trialEndsAt: '2026-10-21T12:00:00.000Z' },
    isEarlyAdopter: false,
  };
  /** JSON with sorted keys, so a comparison ignores key order. */
  const canon = (value: unknown): string => JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v as Row).sort().map(k => [k, (v as Row)[k]]))
      : v);
  /**
   * renderPage('dashboard', props), server-rendered once the chosen home's dynamic() chunk
   * has loaded. The first pass starts the import and shows the loader while the chunk is
   * not in yet; later passes wait for a placeholder to record its props.
   */
  const renderDashboard = async (props: Row): Promise<{ first: string; html: string }> => {
    const { renderPage } = await load('app/[locale]/PageGate.tsx');
    assert(typeof renderPage === 'function', 'PageGate exports no renderPage');
    rendered.length = 0;
    const el = renderPage('dashboard', props);
    const first = renderHtml(el, 'he');
    let html = first;
    for (let i = 0; i < 200 && rendered.length === 0; i++) {
      await new Promise(resolve => setTimeout(resolve, 5));
      html = renderHtml(el, 'he');
    }
    return { first, html };
  };

  await check('#16 calendarHome true: the purple dashboard loader while the new home loads, then CalendarHome with exactly CalendarHomeProps (user.id is the page\'s user_id), never DashboardClient', async () => {
    // The first check that renders the new home, so its chunk is not loaded yet
    const { first, html } = await renderDashboard({ ...DASHBOARD, calendarHome: true, hints: { reminders: true, voiceEvents: false } });
    assert(first.includes('linear-gradient(135deg, #667eea 0%, #764ba2 100%)') && !first.includes('smoke:'), `the first pass: ${first.slice(0, 200)}`);
    assert(html.includes('smoke:CalendarHome'), `rendered: ${html.slice(0, 200)}`);
    assert(rendered.every(r => r.home === 'CalendarHome'), `rendered ${show(rendered.map(r => r.home))}`);
    const want = {
      user: { id: 5550001, name: 'Dana', isAdmin: true },
      locale: 'he',
      calendarSource: 'NATIVE',
      needsOAuth: false,
      needsCalendars: false,
      hints: { reminders: true, voiceEvents: false },
      trialDaysLeft: 5,
      hasLocation: true,
    };
    assert(canon(rendered[0]?.props) === canon(want), `CalendarHome got ${canon(rendered[0]?.props)}`);
  });

  await check('#17 calendarHome false: today\'s DashboardClient with exactly today\'s props (the trial end back as a Date), never CalendarHome', async () => {
    const { html } = await renderDashboard({ ...DASHBOARD, calendarHome: false });
    assert(html.includes('smoke:DashboardClient'), `rendered: ${html.slice(0, 200)}`);
    assert(rendered.every(r => r.home === 'DashboardClient'), `rendered ${show(rendered.map(r => r.home))}`);
    const got = rendered[0].props;
    assert(Object.keys(got).sort().join(',') === Object.keys(DASHBOARD).sort().join(','), `DashboardClient's props: ${Object.keys(got).sort().join(',')}`);
    assert(got.trial.trialEndsAt instanceof Date && got.trial.trialEndsAt.toISOString() === DASHBOARD.trial.trialEndsAt, `trial: ${show(got.trial)}`);
    assert(canon({ ...got, trial: { ...got.trial, trialEndsAt: DASHBOARD.trial.trialEndsAt } }) === canon(DASHBOARD), `DashboardClient got ${canon(got)}`);
  });

  await check('#18 a Google user\'s home: calendarSource and the setup flags pass through, no hints promise nothing (R10), and an early adopter with no location gets no trial days and hasLocation false', async () => {
    const { html } = await renderDashboard({
      ...DASHBOARD, calendarSource: 'GOOGLE', needsOAuth: true, needsCalendars: true, calendarHome: true,
      user: { ...DASHBOARD.user, location: '' }, isEarlyAdopter: true,
    });
    assert(html.includes('smoke:CalendarHome'), `rendered: ${html.slice(0, 200)}`);
    const got = rendered[0].props;
    assert(got.calendarSource === 'GOOGLE' && got.needsOAuth === true && got.needsCalendars === true, `CalendarHome got ${canon(got)}`);
    assert(canon(got.hints) === canon({ reminders: false, voiceEvents: false }), `hints ${canon(got.hints)}`);
    assert(got.trialDaysLeft === null && got.hasLocation === false, `trialDaysLeft ${show(got.trialDaysLeft)}, hasLocation ${show(got.hasLocation)}`);
  });

  await check('#19 PRELOAD.dashboard starts both homes\' chunks, and LOOK.dashboard stays telegram (the loader\'s look)', () => {
    const src = readSource('app/[locale]/PageGate.tsx');
    const block = (name: string) => {
      const at = src.indexOf(`const ${name}`);
      return at < 0 ? '' : src.slice(at, src.indexOf('\n};', at));
    };
    const preload = block('PRELOAD');
    const entry = preload.slice(preload.indexOf('dashboard:'), preload.indexOf('settings:'));
    for (const chunk of ["import('./dashboard/DashboardClient')", "import('./dashboard/CalendarHome')"]) {
      assert(entry.includes(chunk), `no ${chunk} in PRELOAD.dashboard: ${entry.trim() || '(not found)'}`);
    }
    assert(/\n\s*dashboard: 'telegram',/.test(block('LOOK')), `LOOK: ${block('LOOK')}`);
  });

  await check('#20 the calendar home\'s chunk sits inside PageGate\'s own boundary (the home\'s boundary lives inside that chunk), which reads the reload guard from the leaf reload-guard, never the home\'s code; DashboardClient gets no boundary', async () => {
    const { renderPage, HomeChunkBoundary } = await load('app/[locale]/PageGate.tsx');
    assert(typeof HomeChunkBoundary === 'function', 'PageGate exports no HomeChunkBoundary');
    const on = renderPage('dashboard', { ...DASHBOARD, calendarHome: true, hints: { reminders: true, voiceEvents: false } });
    assert(on?.type === HomeChunkBoundary, `the switch on: the root is ${on?.type?.name ?? show(on?.type)}`);
    const home = on.props.children;
    assert(home?.props?.user?.id === 5550001 && home.props.hints?.reminders === true, `inside it, the home with its props: ${canon(home?.props)}`);
    const off = renderPage('dashboard', { ...DASHBOARD, calendarHome: false });
    assert(!elementsIn(off).some(e => e.type === HomeChunkBoundary), 'the switch off: no boundary around DashboardClient');
    const src = readSource('app/[locale]/PageGate.tsx');
    assert(src.includes("from '@/src/lib/calendar-view/reload-guard'"), 'the guard does not come from reload-guard');
    assert(!/calendar-view\/(?:home-client|home-loader|store|format)'|dashboard\/HomeErrorBoundary'/.test(src), 'PageGate imports the home\'s client code, which every page would then load');
    const leaf = readSource('src/lib/calendar-view/reload-guard.ts');
    assert(!/^import /m.test(leaf), 'reload-guard imports something');
  });

  let failed = 0;
```

Then three edits in `scripts/smoke-calendar-home-render.ts` (D5's smoke, with D6's checks), for PageGate's boundary around the home's chunk. It needs real React, which that smoke has and this one doesn't: `next/dynamic` under tsx is the pages-router loadable, which renders its `loading` with an `error` prop when the import fails and never throws. So the check builds what the app router's `next/dynamic` is, `React.lazy` inside `Suspense`, with an import that rejects.

The header comment (`scripts/smoke-calendar-home-render.ts:45-46`). Before:
```ts
// boundary.
// React must log no warning. No network, no DB, no Redis.
```
After:
```ts
// boundary.
//
// PageGate's boundary around the home's chunk (Task D7, #40), in real React: an import
// that rejects with a ChunkLoadError, as after a deploy, reloads once behind the loader;
// within the guard, or for any other error, the gate's error card.
// React must log no warning. No network, no DB, no Redis.
```

The import, after the home's error boundary (`scripts/smoke-calendar-home-render.ts:71-72`). Before:
```ts
import { CHUNK_RELOAD_KEY, HomeErrorBoundary } from '../app/[locale]/dashboard/HomeErrorBoundary';
import { homeBanners, type BannerFacts } from '../app/[locale]/dashboard/HomeBanners';
```
After:
```ts
import { CHUNK_RELOAD_KEY, HomeErrorBoundary } from '../app/[locale]/dashboard/HomeErrorBoundary';
import { HomeChunkBoundary } from '../app/[locale]/PageGate';
import { homeBanners, type BannerFacts } from '../app/[locale]/dashboard/HomeBanners';
```

The new check #40, before the last one, which becomes #41 (`scripts/smoke-calendar-home-render.ts:2148`). Before:
```ts
  await check('#40 React logged no warning in any render, CalendarHome\'s included (keys, nesting, attributes, act)', () => {
```
After:
```ts
  await check('#40 PageGate\'s boundary around the home\'s chunk (spec §5): an import that rejects with a ChunkLoadError reloads the page once, with the home\'s guard, behind the loader; within the guard, the gate\'s error card, whose button reloads; any other error, the card and no reload; never an empty tree', async () => {
    assert(typeof HomeChunkBoundary === 'function', 'PageGate exports no HomeChunkBoundary');
    const gate = messages.he.pageGate;
    /** What next/dynamic is in the app router: React.lazy inside Suspense, here with an import that rejects. */
    const failing = (error: Error) => {
      const Home = React.lazy(() => Promise.reject(error));
      const loading = createElement('p', null, 'loading the chunk');
      const el = inApp('he', createElement(HomeChunkBoundary, null, createElement(React.Suspense, { fallback: loading }, createElement(Home))));
      return mount(el, { onCaughtError: noop, onUncaughtError: noop });
    };
    const chunkError = () => Object.assign(new Error('Loading chunk 4471 failed.'), { name: 'ChunkLoadError' });
    resetHome();
    appLogs.length = 0;
    const a = failing(chunkError());
    await settle();
    try {
      assert(show(reloads) === show(['reload']) && fakeWindow.sessionStorage.getItem(CHUNK_RELOAD_KEY) !== null, `one reload, with the home's guard key: ${show(reloads)}`);
      assert(innerHtml(a.container).includes('pagegate-spin'), `the loader while the page reloads: ${textOf(innerHtml(a.container)).slice(0, 120)}`);
      assert(appLogs.some((l) => l.startsWith('[calendar-home] The home did not load')), `logged: ${show(appLogs)}`);
    } finally {
      a.unmount();
    }
    const b = failing(chunkError());
    await settle();
    try {
      assert(show(reloads) === show(['reload']), `not twice within a minute: ${show(reloads)}`);
      assertHas(textOf(innerHtml(b.container)), [gate.errorTitle, gate.errorBody, gate.retry], 'within the guard, the gate\'s error card');
      b.click(button(b.container, gate.retry));
      assert(show(reloads) === show(['reload', 'reload']), 'its button reloads');
    } finally {
      b.unmount();
    }
    resetHome();
    const c = failing(new TypeError('x is undefined'));
    await settle();
    try {
      assert(reloads.length === 0, 'another error never reloads by itself');
      assertHas(textOf(innerHtml(c.container)), [gate.errorTitle, gate.retry], 'the card');
    } finally {
      c.unmount();
    }
    appLogs.length = 0;
  });

  await check('#41 React logged no warning in any render, CalendarHome\'s included (keys, nesting, attributes, act)', () => {
```

- [ ] **Step 3: Run the three smokes and see them fail; record the regression smokes' baseline**

```bash
cd /Users/razielgershoni/development/famcalbot
npx tsc --noEmit -p . 2>&1 | grep 'error TS'
for s in smoke-page-auth smoke-miniapp-gate smoke-calendar-home-render; do for tz in UTC Asia/Jerusalem; do
  eval "env TZ=$tz $E npx tsx scripts/$s.ts" 2>&1 | grep -E '^FAIL|passed'; echo "$s TZ=$tz exit ${pipestatus[1]}"
done; done
L=/tmp/d7-baseline; mkdir -p $L
for s in smoke-calendar-home-copy smoke-oauth-weather smoke-initdata-header smoke-calendar-home-rollout smoke-native-reminder-support smoke-auth-identity check-i18n-parity; do for tz in UTC Asia/Jerusalem; do
  eval "env TZ=$tz $E npx tsx scripts/$s.ts" 2>&1 | grep -E '^(OK|FAIL)|passed|parity' > "$L/$s-${tz//\//_}.before"; echo "$s TZ=$tz exit ${pipestatus[1]} | $(tail -1 "$L/$s-${tz//\//_}.before")"
done; done
```
(Run it in zsh: `pipestatus` is zsh's.)

Expected for `smoke-page-auth`, under each clock: `10/14 passed`, `exit 1`. The lines, shown for UTC (the other clock prints the same with its name):
```
FAIL  #11 dashboard with the switch OFF (no row): today's props plus calendarHome false, no hints; no hint check runs and no open is logged — 5550001: keys calendarAssignments,calendarSource,isEarlyAdopter,locale,needsCalendars,needsOAuth,subscription,trial,user (want calendarAssignments,calendarHome,calendarSource,isEarlyAdopter,locale,needsCalendars,needsOAuth,subscription,trial,user); 5550001: calendarHome undefined; 8880004: keys calendarAssignments,calendarSource,isEarlyAdopter,locale,needsCalendars,needsOAuth,subscription,trial,user (want calendarAssignments,calendarHome,calendarSource,isEarlyAdopter,locale,needsCalendars,needsOAuth,subscription,trial,user); 8880004: calendarHome undefined
FAIL  #12 the switch at ADMINS: a non-admin keeps today's dashboard with no hint check; an admin gets calendarHome, the hints and one webapp_opened under the DB id — non-admin: calendarHome undefined, hints undefined; admin: calendarHome undefined, keys calendarAssignments,calendarSource,isEarlyAdopter,locale,needsCalendars,needsOAuth,subscription,trial,user (want calendarAssignments,calendarHome,calendarSource,hints,isEarlyAdopter,locale,needsCalendars,needsOAuth,subscription,trial,user); admin hints undefined; hint checks {"featureChecks":[],"supportChecks":[]}; webapp_opened for [] (want [4]: the DB id, once)
FAIL  #13 the hints are the real gates (R10): a FamCal user on Telegram with reminders and no voice events; the native-reminders switch off clears reminders; ALL covers non-admins; one open per load — calendarHome undefined; hints reminders=undefined voiceEvents=undefined; feature checks []; with native reminders off: reminders=undefined voiceEvents=undefined; webapp_opened for [] (want [1,1]: once per load)
FAIL  #14 a failing voice-events check reads as no hint: the page still answers, voiceEvents false, with a warning — calendarHome undefined, reminders=undefined voiceEvents=undefined
10/14 passed
smoke-page-auth TZ=UTC exit 1
```
Expected from `tsc` (exit 2):
```
scripts/smoke-calendar-home-render.ts(76,10): error TS2614: Module '"../app/[locale]/PageGate"' has no exported member 'HomeChunkBoundary'. Did you mean to use 'import HomeChunkBoundary from "../app/[locale]/PageGate"' instead?
```
Expected for `smoke-miniapp-gate`, under each clock: `15/20 passed`, `exit 1`. The lines, shown for UTC:
```
FAIL  #16 calendarHome true: the purple dashboard loader while the new home loads, then CalendarHome with exactly CalendarHomeProps (user.id is the page's user_id), never DashboardClient — PageGate exports no renderPage
FAIL  #17 calendarHome false: today's DashboardClient with exactly today's props (the trial end back as a Date), never CalendarHome — PageGate exports no renderPage
FAIL  #18 a Google user's home: calendarSource and the setup flags pass through, no hints promise nothing (R10), and an early adopter with no location gets no trial days and hasLocation false — PageGate exports no renderPage
FAIL  #19 PRELOAD.dashboard starts both homes' chunks, and LOOK.dashboard stays telegram (the loader's look) — no import('./dashboard/CalendarHome') in PRELOAD.dashboard: dashboard: () => import('./dashboard/DashboardClient'),
FAIL  #20 the calendar home's chunk sits inside PageGate's own boundary (the home's boundary lives inside that chunk), which reads the reload guard from the leaf reload-guard, never the home's code; DashboardClient gets no boundary — PageGate exports no HomeChunkBoundary
15/20 passed
smoke-miniapp-gate TZ=UTC exit 1
```
Expected for `smoke-calendar-home-render`, under each clock: `40/41 passed`, `exit 1` (about 20 s). The lines, shown for UTC:
```
FAIL  #40 PageGate's boundary around the home's chunk (spec §5): an import that rejects with a ChunkLoadError reloads the page once, with the home's guard, behind the loader; within the guard, the gate's error card, whose button reloads; any other error, the card and no reload; never an empty tree — PageGate exports no HomeChunkBoundary
40/41 passed (process TZ=UTC)
smoke-calendar-home-render TZ=UTC exit 1
```
Why they fail: page-data sends no `calendarHome` and never runs the hint checks or logs an open; PageGate has no exported `renderPage`, no `CalendarHome`, a one-chunk `PRELOAD.dashboard` and no `HomeChunkBoundary`. #1–#10, #1–#15 and #1–#39 still pass: the recorders and placeholders wrap the real code without changing it. tsx may print `DEP0205` deprecation warnings on stderr; the `grep` drops them.

Expected for the regression smokes, every one `exit 0` under both clocks: `smoke-calendar-home-copy` 14/14, `smoke-oauth-weather` 14/14, `smoke-initdata-header` 9/9, `smoke-calendar-home-rollout` 35/35, `smoke-native-reminder-support` 32/32, `smoke-auth-identity` 26/26, and `i18n parity OK (996 keys)` (D1's count). The `.before` files are the baseline for Step 6.

- [ ] **Step 4: Edit 13: the dashboard branch in `src/lib/page-data.ts`**

Six edits in `src/lib/page-data.ts`.

The header comment (`:12-13`). Before:
```ts
 * - dashboard's trial end date travels as an ISO string; PageGate revives the Date.
 * The props are otherwise exactly what each page passed to its client component.
```
After:
```ts
 * - dashboard's trial end date travels as an ISO string; PageGate revives the Date;
 * - dashboard adds calendarHome and, when it is on, the calendar home's hints. PageGate
 *   picks the home with them and hands DashboardClient the rest.
 * The props are otherwise exactly what each page passed to its client component.
```

The service imports (`:23-24`). Before:
```ts
import { updateUserById } from '@/src/services/user-service';
import { getSubscriptionWithUsage, getTrialStatus, checkEarlyAdopterAccess } from '@/src/services/subscription-service';
```
After:
```ts
import { updateUserById } from '@/src/services/user-service';
import { getSubscriptionWithUsage, getTrialStatus, checkEarlyAdopterAccess, checkFeatureAccess } from '@/src/services/subscription-service';
import { isCalendarHomeOn } from '@/src/services/calendar-read/rollout';
import { getReminderSupport } from '@/src/services/native-reminders/support';
import { trackActivityAsync } from '@/src/services/analytics-service';
import { captureError } from '@/src/lib/error-capture';
```

The hints type (`:32`). Before:
```ts
import type { CalendarAssignment, CalendarLabel, UserConfig } from '@/src/types';
```
After:
```ts
import type { CalendarAssignment, CalendarLabel, UserConfig } from '@/src/types';
import type { HomeHints } from '@/src/lib/calendar-view/home-props';
```

`DashboardPageProps` (`:47-50`). Before:
```ts
/** Dashboard props on the wire: the trial end date is an ISO string. */
export type DashboardPageProps = Omit<DashboardProps, 'trial'> & {
  trial: Omit<DashboardProps['trial'], 'trialEndsAt'> & { trialEndsAt: string | null };
};
```
After:
```ts
/**
 * Dashboard props on the wire: the trial end date is an ISO string, and calendarHome says
 * which home PageGate renders (calendar-home spec §7.1). DashboardClient never gets the
 * two new fields.
 */
export type DashboardPageProps = Omit<DashboardProps, 'trial'> & {
  trial: Omit<DashboardProps['trial'], 'trialEndsAt'> & { trialEndsAt: string | null };
  /** isCalendarHomeOn(user): CalendarHome instead of DashboardClient. */
  calendarHome: boolean;
  /** Set exactly when calendarHome is true: the empty state's how-to-add hints (Ruling R10). */
  hints?: HomeHints;
};
```

The switch in the dashboard's `Promise.all` (`:121-126`). Before:
```ts
  // Fetch subscription data
  const [subWithUsage, trialStatus, isEarlyAdopter] = await Promise.all([
    getSubscriptionWithUsage(user.id),
    getTrialStatus(user.id),
    checkEarlyAdopterAccess(user.id),
  ]);
```
After:
```ts
  // Fetch subscription data, and whether the calendar home covers this user
  const [subWithUsage, trialStatus, isEarlyAdopter, home] = await Promise.all([
    getSubscriptionWithUsage(user.id),
    getTrialStatus(user.id),
    checkEarlyAdopterAccess(user.id),
    calendarHomeFor(user),
  ]);
```

The props' new fields, the open, and `calendarHomeFor` after `dashboard()` (`:148-152`). Before:
```ts
    trial: { ...trialStatus, trialEndsAt: trialStatus.trialEndsAt?.toISOString() ?? null },
    isEarlyAdopter,
  };
  return { kind: 'props', props };
}
```
After:
```ts
    trial: { ...trialStatus, trialEndsAt: trialStatus.trialEndsAt?.toISOString() ?? null },
    isEarlyAdopter,
    ...home,
  };
  // One open of the calendar home (spec §7.1), under the DB id like every activity
  if (home.calendarHome) trackActivityAsync(user.id, 'webapp_opened');
  return { kind: 'props', props };
}

/**
 * Whether the calendar home covers this user (the rollout switch, spec §1) and, only
 * then, its empty state's how-to-add hints (spec §7.3, Ruling R10). Users the switch
 * doesn't cover never run the two checks. Both are cheap: the feature checks are cached
 * for 24 h in Redis, and the native-reminders switch is read through Redis.
 * getReminderSupport already fails closed; a failed voice-events check does too, so a
 * hint never promises what the plan may lack and never fails the page.
 */
async function calendarHomeFor(
  user: UserConfig
): Promise<{ calendarHome: false } | { calendarHome: true; hints: HomeHints }> {
  if (!(await isCalendarHomeOn(user))) return { calendarHome: false };
  const [reminders, voiceEvents] = await Promise.all([
    getReminderSupport(user).then((support) => support.supported),
    checkFeatureAccess(user.id, 'voice_events').then(
      (access) => access.allowed,
      (error) => {
        captureError(error, 'calendar-home-hints', { user_id: user.id }, 'warning');
        return false;
      }
    ),
  ]);
  return { calendarHome: true, hints: { reminders, voiceEvents } };
}
```

- [ ] **Step 5: Edit 14: the calendar home in `app/[locale]/PageGate.tsx`**

Seven edits in `app/[locale]/PageGate.tsx`.

The header comment and React's `Component`, for the boundary (`:6-10`). Before:
```tsx
// own client component with the same props it always had. A locale mismatch becomes a
// router.replace, a notice renders the page's static notice, and 401/403/404 show the
// pageGate card instead of anyone's data, with a way back to the chat.

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
```
After:
```tsx
// own client component with the same props it always had. A locale mismatch becomes a
// router.replace, a notice renders the page's static notice, and 401/403/404 show the
// pageGate card instead of anyone's data, with a way back to the chat. The dashboard has
// two homes: the props' calendarHome picks CalendarHome (the users the calendar home's
// rollout switch covers), inside its own chunk-load boundary, or today's DashboardClient.

import { Component, createContext, useContext, useEffect, useState, type ReactNode } from 'react';
```

The props types (`:15`). Before:
```tsx
import type { PageDataResult, PageName, PageNotice, PagePropsMap } from '@/src/lib/page-data';
```
After:
```tsx
import type { PageDataResult, PageName, PageNotice, PagePropsMap } from '@/src/lib/page-data';
import type { CalendarHomeProps, HomeHints } from '@/src/lib/calendar-view/home-props';
```

The reload guard (`:17`), from D6's leaf reload-guard and never from home-client, because PageGate's chunk loads on every page. Before:
```tsx
import { readInitData } from '@/src/lib/read-init-data';
```
After:
```tsx
import { readInitData } from '@/src/lib/read-init-data';
import { CHUNK_RELOAD_KEY, isChunkLoadError, reloadOnce } from '@/src/lib/calendar-view/reload-guard';
```

The calendar home's chunk (`:85-86`). Before:
```tsx
// Each page's existing client component, loaded only once its data has arrived.
const Dashboard = dynamic(() => import('./dashboard/DashboardClient'), { loading: telegramLoader });
```
After:
```tsx
// Each page's existing client component, loaded only once its data has arrived.
const Dashboard = dynamic(() => import('./dashboard/DashboardClient'), { loading: telegramLoader });
// The calendar home (spec §7.1), behind the dashboard's own loader; it applies its look on mount.
const CalendarHome = dynamic(() => import('./dashboard/CalendarHome'), { loading: telegramLoader });
```

Both chunks for the dashboard (`:94-95`). Before:
```tsx
const PRELOAD: Record<PageName, () => Promise<unknown>> = {
  dashboard: () => import('./dashboard/DashboardClient'),
```
After:
```tsx
const PRELOAD: Record<PageName, () => Promise<unknown>> = {
  // Only the data says which home the dashboard shows, so both start loading
  dashboard: () => Promise.all([import('./dashboard/DashboardClient'), import('./dashboard/CalendarHome')]),
```

The dashboard case, and `renderPage` exported (`:103-109`). Before:
```tsx
/** The JSON props back in the shapes the client components take (Date, Set, Map). */
function renderPage(page: PageName, props: PagePropsMap[PageName]) {
  switch (page) {
    case 'dashboard': {
      const p = props as PagePropsMap['dashboard'];
      return <Dashboard {...p} trial={{ ...p.trial, trialEndsAt: p.trial.trialEndsAt ? new Date(p.trial.trialEndsAt) : null }} />;
    }
```
After:
```tsx
/**
 * The calendar home's props from the dashboard's (spec §7.1). user.id stays the page's
 * ?user_id, exactly as DashboardClient gets it. page-data always sends hints with
 * calendarHome; without them no hint is promised (Ruling R10). The trial's days left follow
 * the old home's trial line, and hasLocation feeds the location banner (spec §7.2).
 */
function calendarHomeProps(
  p: Omit<PagePropsMap['dashboard'], 'calendarHome' | 'hints'>,
  hints: HomeHints | undefined
): CalendarHomeProps {
  return {
    user: { id: p.user.id, name: p.user.name, isAdmin: p.user.isAdmin },
    locale: p.locale,
    calendarSource: p.calendarSource ?? 'NATIVE',
    needsOAuth: p.needsOAuth,
    needsCalendars: p.needsCalendars,
    hints: hints ?? { reminders: false, voiceEvents: false },
    trialDaysLeft: !p.isEarlyAdopter && p.trial.isTrialing && p.trial.daysRemaining > 0 ? p.trial.daysRemaining : null,
    hasLocation: Boolean(p.user.location),
  };
}

/** The JSON props back in the shapes the client components take (Date, Set, Map). Exported for the smokes. */
export function renderPage(page: PageName, props: PagePropsMap[PageName]) {
  switch (page) {
    case 'dashboard': {
      // calendarHome picks the home; DashboardClient gets exactly the props it always had
      const { calendarHome, hints, ...p } = props as PagePropsMap['dashboard'];
      if (calendarHome) {
        return (
          <HomeChunkBoundary>
            <CalendarHome {...calendarHomeProps(p, hints)} />
          </HomeChunkBoundary>
        );
      }
      return <Dashboard {...p} trial={{ ...p.trial, trialEndsAt: p.trial.trialEndsAt ? new Date(p.trial.trialEndsAt) : null }} />;
    }
```

The boundary around the home's chunk, before the notices' context (`:136`). Spec §5's error boundary is D6's `HomeErrorBoundary`, but it lives inside the home's chunk, so it can't catch that chunk failing to load (a deploy landing between the HTML and the chunk's fetch); this one can. Before:
```tsx
const NoticeDetailContext = createContext<string | null>(null);
```
After:
```tsx
function reloadPage() {
  try {
    window.location.reload();
  } catch {
    // The card stays.
  }
}

/** A calendar home that didn't load: the gate's error card, whose button reloads the page. */
function HomeLoadFailed() {
  const t = useTranslations('pageGate');
  return (
    <GateCard
      look="telegram"
      title={t('errorTitle')}
      lines={[t('errorBody')]}
      action={
        <GateActions look="telegram">
          <GateAction look="telegram" primary onClick={reloadPage}>{t('retry')}</GateAction>
        </GateActions>
      }
    />
  );
}

/**
 * Around the calendar home's chunk (spec §5). The home's own boundary lives inside that
 * chunk, so it can't catch the chunk itself failing to load, for example after a deploy
 * lands between the HTML and the chunk's fetch. A chunk-load error reloads the page once,
 * with the home's guard key (so the two boundaries reload once between them), behind the
 * loader; within the guard, or for any other error, the gate's error card, whose button
 * reloads. Never an empty tree. Only the users the switch covers render it. Exported for
 * the smokes.
 */
export class HomeChunkBoundary extends Component<{ children: ReactNode }, { failed: boolean; reloading: boolean }> {
  state = { failed: false, reloading: false };

  static getDerivedStateFromError(error: unknown) {
    return { failed: true, reloading: isChunkLoadError(error) };
  }

  componentDidCatch(error: unknown) {
    console.error('[calendar-home] The home did not load:', error);
    if (isChunkLoadError(error) && !reloadOnce(CHUNK_RELOAD_KEY)) this.setState({ reloading: false });
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return this.state.reloading ? <PageLoader look="telegram" /> : <HomeLoadFailed />;
  }
}

const NoticeDetailContext = createContext<string | null>(null);
```

- [ ] **Step 6: Run both smokes and the regression smokes again**

```bash
cd /Users/razielgershoni/development/famcalbot
for s in smoke-page-auth smoke-miniapp-gate smoke-calendar-home-render; do for tz in UTC Asia/Jerusalem Pacific/Kiritimati; do
  eval "env TZ=$tz $E npx tsx scripts/$s.ts" 2>&1 | grep -E '^(OK|FAIL)|passed'; echo "$s TZ=$tz exit ${pipestatus[1]}"
done; done
L=/tmp/d7-baseline
for s in smoke-calendar-home-copy smoke-oauth-weather smoke-initdata-header smoke-calendar-home-rollout smoke-native-reminder-support smoke-auth-identity check-i18n-parity; do for tz in UTC Asia/Jerusalem; do
  eval "env TZ=$tz $E npx tsx scripts/$s.ts" 2>&1 | grep -E '^(OK|FAIL)|passed|parity' > "$L/$s-${tz//\//_}.after"; echo "$s TZ=$tz exit ${pipestatus[1]}"
  cmp -s "$L/$s-${tz//\//_}.before" "$L/$s-${tz//\//_}.after" && echo "  same output as Step 3" || echo "  OUTPUT CHANGED"
done; done
```
(zsh, as in Step 3.)

Expected for `smoke-page-auth`, under each clock:
```
OK  #1 /he/pair?user_id=1 with no credential: neither the props nor the HTML carry the invite token or the partner
OK  #2 dashboard, settings, calendars, select-calendars, subscription: no private data, no Prisma or Google call
OK  #3 page-data pair with no credential is 401
OK  #4 page-data pair with the owner's initData is 200 and carries the invite token
OK  #5 page-data pair with another user's initData and user_id=1 is 401
OK  #6 page-data settings on the WA cookie: the props carry row 42's location
OK  #7 page-data settings in the wrong locale: a redirect to /ru/settings?user_id=42, no props
OK  #8 page-data calendars for a GOOGLE user: notice notNative, no calendars
OK  #9 /oauth-success?user_id=<Telegram id> shows no one's name (the dead route is gone, or renders no user)
OK  #10 select-calendars with missing Google scopes (Hebrew user): redirect to /refresh-token with no locale prefix
OK  #11 dashboard with the switch OFF (no row): today's props plus calendarHome false, no hints; no hint check runs and no open is logged
OK  #12 the switch at ADMINS: a non-admin keeps today's dashboard with no hint check; an admin gets calendarHome, the hints and one webapp_opened under the DB id
OK  #13 the hints are the real gates (R10): a FamCal user on Telegram with reminders and no voice events; the native-reminders switch off clears reminders; ALL covers non-admins; one open per load
OK  #14 a failing voice-events check reads as no hint: the page still answers, voiceEvents false, with a warning

14/14 passed
smoke-page-auth TZ=UTC exit 0
```
Then the same under `Asia/Jerusalem` and `Pacific/Kiritimati`.
Expected for `smoke-miniapp-gate`, under each clock:
```
OK  #1 PageGate calls ready() and expand() in an effect declared before its /api/page-data fetch effect
OK  #2 startMiniApp: ready + expand always; purple pages also get the purple header and white background, each surviving a throw
OK  #3 share-story keeps ready() alone: no expand() anywhere in it
OK  #4 the global menu button path (TelegramDashboardRedirect) expands with ready() and sets the purple header
OK  #5 gateLinks: wa.me with "settings" and t.me/<bot>?start=dashboard from env; both fall back to the public number and bot the landing pages use
OK  #6 every gated page hands PageGate the links from the server, and /dashboard with no user_id hands them to TelegramDashboardRedirect
OK  #7 the browser card (he): the WhatsApp link first, then the Telegram one labelled for Telegram users
OK  #8 the in-Telegram card: its action closes the Mini App (back to the chat), and it links nowhere
OK  #9 PageGate's gate outcome renders the shared card with the page's links
OK  #10 the browser title no longer says the link expired (en/he/ru), and the new labels exist in all three
OK  #11 a stale or used magic link lands on /<locale>/dashboard (the link's locale, else Accept-Language among en/he/ru), with no user_id and no cookie
OK  #12 a fresh magic link carries its locale, and still signs in: /<its locale>/dashboard?user_id=<id> with the session cookie
OK  #13 TelegramDashboardRedirect shows the shared card when there is no Telegram user (no hard-coded English), and keeps pushing Telegram users on
OK  #14 the dashboard's "open in Telegram" banner keys on readInitData() === '', not on window.Telegram.WebApp
OK  #15 a stale or used magic link in a browser still signed in (valid famcal_session) goes to that user's dashboard; a bad cookie still gets the card
OK  #16 calendarHome true: the purple dashboard loader while the new home loads, then CalendarHome with exactly CalendarHomeProps (user.id is the page's user_id), never DashboardClient
OK  #17 calendarHome false: today's DashboardClient with exactly today's props (the trial end back as a Date), never CalendarHome
OK  #18 a Google user's home: calendarSource and the setup flags pass through, no hints promise nothing (R10), and an early adopter with no location gets no trial days and hasLocation false
OK  #19 PRELOAD.dashboard starts both homes' chunks, and LOOK.dashboard stays telegram (the loader's look)
OK  #20 the calendar home's chunk sits inside PageGate's own boundary (the home's boundary lives inside that chunk), which reads the reload guard from the leaf reload-guard, never the home's code; DashboardClient gets no boundary
20/20 passed
smoke-miniapp-gate TZ=UTC exit 0
```
Then the same under `Asia/Jerusalem` and `Pacific/Kiritimati`.
Expected for `smoke-calendar-home-render`, under each clock: its 41 OK lines (D6's Step 13 lists #1–#39), ending:
```
OK  #40 PageGate's boundary around the home's chunk (spec §5): an import that rejects with a ChunkLoadError reloads the page once, with the home's guard, behind the loader; within the guard, the gate's error card, whose button reloads; any other error, the card and no reload; never an empty tree
OK  #41 React logged no warning in any render, CalendarHome's included (keys, nesting, attributes, act)
41/41 passed (process TZ=UTC)
smoke-calendar-home-render TZ=UTC exit 0
```
Then the same under `Asia/Jerusalem` and `Pacific/Kiritimati`.
Every regression run prints `exit 0` and `same output as Step 3`.

- [ ] **Step 7: Type-check and lint**

```bash
cd /Users/razielgershoni/development/famcalbot
npx tsc --noEmit -p . && npm run -s lint; echo "exit $?"
```
Expected: no output from either, then `exit 0`. `next build` type-checks `scripts/**`, so both smokes are covered too. `tsc` also checks `<CalendarHome {...calendarHomeProps(p, hints)} />` against D6's real default export and `HomeHints` against D5's real file.

- [ ] **Step 8: Commit**

```bash
cd /Users/razielgershoni/development/famcalbot
git add src/lib/page-data.ts 'app/[locale]/PageGate.tsx' scripts/smoke-page-auth.ts scripts/smoke-miniapp-gate.ts scripts/smoke-calendar-home-render.ts
git commit -m "$(cat <<'EOF'
feat(calendar-home): the dashboard shows the calendar home behind the switch

page-data's dashboard props gain calendarHome from the rollout switch,
read inside the existing Promise.all. Only when it is on, they also carry
the empty state's hints (getReminderSupport and the voice_events feature
check, both cached, the second failing closed) and log one webapp_opened.
PageGate renders CalendarHome with exactly CalendarHomeProps (the
trial's days left and whether a location is set included) when
calendarHome is true, inside its own boundary (the home's own boundary
lives in the chunk, so a chunk that fails to load after a deploy now
reloads once, else shows the gate's error card), and today's
DashboardClient with exactly its old props otherwise. PRELOAD.dashboard
starts both chunks, and the purple loader stays. The switch ships OFF,
so nobody's screen changes on deploy.

For everyone, whatever the switch says: every dashboard open downloads
the home's chunk (about 19.5 KB gzipped, spec section 7.1's preload),
and every page's messages carry the calendarHome namespace (4-7 KB of
raw JSON).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
EOF
)"
```
Stage only these five paths.

---

### Task 8: Verification and landing (run by the controller, not a subagent)

**Files:** none changed, unless a check fails.

- [ ] **Step 1: Run every smoke under both clocks, and the day-bucketing smokes under Kiritimati**

```bash
cd /Users/razielgershoni/development/famcalbot
E="DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake"
OUT=/private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/landing-D; mkdir -p $OUT
run() { eval "env TZ=$2 $E perl -e 'alarm shift; exec @ARGV' 300 npx tsx $1" > "$OUT/$(basename $1 .ts).$(echo $2 | tr / _).out" 2>&1; echo "$(basename $1) $2 exit=$? $(tail -1 "$OUT/$(basename $1 .ts).$(echo $2 | tr / _).out")"; }
for s in scripts/smoke-*.ts; do for tz in UTC Asia/Jerusalem; do run $s $tz; done; done
for s in locale-rules calendar-dto calendar-read-google calendar-range digest-adapters calendar-read-google-cancel summary-prompt-parity summary-seam calendar-home-rollout summary-retry week-lookahead week-commands digest-reader-parity google-map calendar-home-copy hebrew-date calendar-agenda calendar-home-render page-auth miniapp-gate; do run scripts/smoke-$s.ts Pacific/Kiritimati; done
run scripts/smoke-hebrew-date.ts America/Los_Angeles
eval "env $E npx tsx scripts/check-i18n-parity.ts"; echo "parity exit $?"
```

Expected: every line `exit=0` (64 smoke files: 128 runs under the two clocks, 20 under Kiritimati, 1 under Los Angeles) and `i18n parity OK (996 keys)`. The counts Plans B, C and D added or changed: admin-panel-ssr 10, calendar-home-rollout 35, locale-rules 19, calendar-dto 23, google-map 45, calendar-read-famcal 21, calendar-read-google 34, calendar-read-google-cache 42, calendar-read-google-cancel 5, calendar-range 24, initdata-header 9, week-lookahead 42, week-commands 7, digest-adapters 23, digest-reader-parity 28, summary-prompt-parity 9, summary-seam 23, summary-retry 20, calendar-home-copy 14, hebrew-date 14, calendar-agenda 33, command-client 11, telegram-ui 14, calendar-home-render 41, page-auth 14 and miniapp-gate 20. A non-zero exit is a failure to fix before landing. macOS has no `timeout`; the `perl` alarm stands in for it.

- [ ] **Step 2: Type-check and lint the branch**

Run: `npx tsc --noEmit -p . && npm run -s lint; echo "exit $?"`
Expected: `exit 0`, no output before it.

- [ ] **Step 3: Build a fresh clone on Node 22, and run the home smokes there**

```bash
F=/private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/fresh-D
rm -rf $F && git clone -q --branch feat/calendar-home /Users/razielgershoni/development/famcalbot $F && cd $F
# E is the env prefix from Step 1.
npx -y node@22 "$(command -v npm)" ci --no-audit --no-fund > ../fresh-D-ci.log 2>&1; echo "ci exit $?"
npx -y node@22 node_modules/.bin/prisma generate > ../fresh-D-gen.log 2>&1; echo "generate exit $?"
npx -y node@22 node_modules/.bin/next build > ../fresh-D-build.log 2>&1; echo "build exit $?"; tail -5 ../fresh-D-build.log; grep -c "api/calendar/range" ../fresh-D-build.log
for s in calendar-home-copy hebrew-date calendar-agenda command-client telegram-ui calendar-home-render page-auth miniapp-gate summary-prompt-parity digest-reader-parity; do eval "env TZ=Asia/Jerusalem $E npx -y node@22 node_modules/.bin/tsx scripts/smoke-$s.ts" > ../fresh-D-$s.out 2>&1; echo "$s node22 exit=$? $(tail -1 ../fresh-D-$s.out)"; done
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
- the switch is still `OFF`: everyone keeps today's dashboard;
- what everyone gets anyway (Ruling 8): the preloaded chunk, the messages payload, the §9 string fixes;
- the rulings the owner may want to change: 1 (BackButton on every sheet), 2 and 3 (the banners), 4 (the Send sheet's week lines are text, not the mockup's dates), 5 (no "Couldn't refresh" row);
- with Plans C and D on `main`, the owner can set the switch to `ADMINS` (Admin → Features) and do the device check: real Telegram on iOS and Android, light and dark, Hebrew RTL, Android back with each sheet open, Send to chat, an item sheet's "Open in Google Calendar". Plan C's live check (its Task 6 Step 10) runs on the owner's next summaries.

Production stays read-only.

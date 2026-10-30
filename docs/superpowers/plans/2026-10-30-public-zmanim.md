# Public zmanim pages (item 6a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A public, no-account page per listed city on famcal.bot (and a city index with "Near me"), in Hebrew, English and Russian, showing the day's zmanim, the Shabbat and Yom Tov ahead and the month with Hebrew dates, holidays and the parasha, computed by the bot's own zmanim code.

**Architecture:** The engine gains pure rest-day blocks and a place-based day list (`zmanDayForPlace`) that the bot's sun sheet and the new server-rendered pages share, plus an opt-in `{ il }` on the holiday functions. A committed 135-city table (Israeli heights built once by a script) feeds a pure view model (`buildCityView`) that a server component renders with the sun sheet's own `ZmanimRows`; the index adds a client-only "Near me" island. Chrome links, the sitemap and robots, an in-process per-address limit in the proxy and four legal sentences complete it.

**Tech Stack:** Next.js 16 (App Router server components, `proxy.ts`), React 19, next-intl, @hebcal/core, lucide-react, TypeScript smokes run by tsx (`scripts/ci-smokes.sh`), `geotiff` (dev dependency, the heights script only).

**Spec:** docs/superpowers/specs/2026-10-30-public-zmanim-design.md

---

## Global Constraints

- Repo rules (CLAUDE.md, the repo's and the global one) hold for every task; the lines below are the ones this work touches most.
- Wall time: read a zone's clock only with `instantToWallTime` and turn a wall time into an instant only with `wallTimeToInstant`; never `fromZonedTime` and never a local `Date` setter (`setHours`, `setDate`, ...).
- Never import `src/services/zmanim` into a `'use client'` file; the city page is a server component and "Near me" imports only the city table and `src/site/near-city.ts`.
- Every user-facing string lives in `messages/` in en, he and ru: Hebrew natural and gender-neutral, Russian formal "вы", a no-break space after a Russian one-letter word and before an em dash (smoke-site-truth T6); no hard-coded strings in TSX.
- UI: lucide icons only, no emoji, no hover, logical CSS properties, px sizes, token colours only, every tap target at least 44 px and on the tap-target lists, motion only under `prefers-reduced-motion: no-preference`.
- No silent failures: every caught error is logged, and sent to Sentry through the repo's `captureError` on the server; no artificial timeouts (the Geolocation API's own `timeout` option is not an app timer).
- Candle lighting is 20 minutes before sunset everywhere, with no per-city minutes; each city page's note says so.
- Default community: Sephardi in Israel, Ashkenazi abroad (`inIsrael(city.timeZone)`); no per-city default; visitors switch it with `?community=`.
- 135 cities (51 in Israel, 84 abroad), Israel first; a slug never changes after launch and cities are only added; an unknown slug gets the site's 404.
- The zone is the Israel flag: `inIsrael(city.timeZone)` decides the Yom Tov days, the height, the Sephardi end of Shabbat and the holidays' `{ il }`; every Israeli city is `Asia/Jerusalem` (never `Asia/Hebron`); zones are IANA names (`Europe/Kyiv`) and a zone ICU resolved is never compared without normalising.
- Parameters: only `?date=yyyy-MM-dd` and `?community=sephardi|ashkenazi|chabad`; the community is written only when it is not the city's default; a missing, repeated, malformed or out-of-range value is ignored (today, the default).
- Range: from one year before the city's today to three years after it (29 February maps to 28 February); at either end the previous or next link is left out.
- "Today" is the city's own: `instantToWallTime(now, city.timeZone)`, never the server's zone (prod runs in UTC).
- Near me: `OPEN_KM = 30` opens the nearest city by distance alone; `NEAR_KM = 100` names it only when its UTC offset right now is the device's; else none. The position never leaves the browser: no map, no reverse lookup, no third party.
- Request limit: 60 city-page requests per minute per `x-real-ip`, then 429 with `Retry-After` until the minute ends; logged as a count per minute, never with the address; no prefetch exemption.
- No storage: no cookie, no localStorage, no account or profile of a visitor; the community and the date live only in the URL; nothing about a visitor is logged.
- No Open-Meteo, at runtime or at build time; no third party is called at runtime (GeoNames, OpenStreetMap and Copernicus are read once by the heights script, and the values are committed).
- Copernicus notice, verbatim and in English on every zmanim page: "© DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved".
- One code path: every row is `zmanDayForPlace`'s (src/services/zmanim/day-list.ts); the public pages pass their own memo per page and `quiet: true`, never the process memo.
- Holidays follow the city (`holidaysInRange(..., { il })`): two-day Yom Tov abroad, the Israel schedule in Israel; the week starts on Sunday (`weekStartFor` with culture `jewish`); Hebrew dates in letters on Hebrew pages and in numerals on English and Russian ones (hebrew-date.ts).
- Links: day, month, cell and community links are plain `<a href rel="nofollow">`, never prefetched; the canonical URL is always the clean one; robots.txt disallows `/zmanim/*?`, `/he/zmanim/*?` and `/ru/zmanim/*?`; the sitemap lists `/zmanim` and every city in each language.
- Every page works without JavaScript except "Near me"; the city page ships no script of its own. Times are 24-hour hh:mm in the city's zone, each in `<bdi dir="ltr">`.
- Smokes are plain `scripts/smoke-*.ts`, run by `bash scripts/ci-smokes.sh` (fake env, TZ=Asia/Jerusalem); one smoke runs with the same env prefix (Running a smoke). Never `npm run build`; the gate is `npx tsc --noEmit && npm run lint && bash scripts/ci-smokes.sh && npx next build`, run by the controller's CI mirror before the push.
- TDD: each task writes or extends its smoke first, runs it red, implements, runs it green and commits; every commit message ends with the two lines `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31`.
- Work happens on branch `zmanim-public` in the worktree /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/zp-wt; its node_modules is a symlink to main's, so after smokes run there, run `npx prisma generate` in the main checkout.
- In the worktree, smoke-site-seo and smoke-site-pages fail at the base commit because node_modules is a symlink (estree-walker exports error); a step that expects them green is verified by the controller's CI mirror in a fresh clone, not in the worktree.

## Review Focus

a. A city page opened just after midnight in a far zone while the server runs in UTC (Sydney, now = 2026-11-02T13:30:00Z → 00:30 on 2026-11-03 local): today is the city's date, not the server's. Owner: Task 5.
b. A DST change day in the city's zone (New York 2026-11-01, Jerusalem 2026-10-25, Sydney 2026-10-04): the day list renders in order with no duplicated or shifted time, and prev/next day links neither skip nor repeat a day. Owner: Task 5.
c. The Hebrew page: every time sits in <bdi dir="ltr">, the previous/next arrows use the flipped icon the app uses for RTL, and the month grid reads right to left (Sunday at the start edge). Owner: Task 6.
d. Repeated or odd query values (?date=2026-11-01&date=2026-11-02, ?community[]=x, a 10,000-character date, ?date=2026-02-30): ignored, no throw, the page shows today / the default. Owner: Task 5 (readCityParams) and Task 6 (a page render with such a query).
e. Near me with a missing or odd device zone ('UTC' while physically in Tel Aviv, an empty or invalid zone string): within 30 km it still opens the city (distance alone decides that band); the 'near' band requires a valid matching offset, else 'none'; nothing throws. Owner: Task 3 (nearAnswer).

## Contract notes (binding)

These change or add to the contract's interfaces (scratchpad/6a/contract.md); the task code below is already written to them. They are the final names: where a task's prose and a note seem to disagree, the note wins.

**Engine (Tasks 1-2)**
1. `restDayBlocks(range, place, community): RestDayBlock[]` takes three arguments, no `options`: it never logs (a block with no edge is listed with `start`/`end` null, which is its point). Task 5 calls it with three arguments.
2. `halachicHourMs` is unchanged (no `options`): it logs nothing. `zmanInstant`, `zmanimForDay`, `exactZmanimForDay` and `shabbatYomTovWindows` gain the trailing `options: ZmanOptions = {}`.
3. day-list.ts also exports `type ZmanListOptions = { memo?: ZmanMemo; quiet?: boolean }` (the options of `zmanDayForPlace`, `instantAt` and `zmanRows`; `zmanDayForPlace`'s parameter is exactly the contract's `{ memo?, quiet? }`) and `lightsCandles(blocks: readonly RestDayBlock[], day: string): boolean` (the eve of a block, or a Friday inside one). `candleLightingDays` in reminder-times.ts switches from the complete windows to `restDayBlocks` + `lightsCandles`, so a reminder "at candle lighting" with no day said and the sun sheet agree in the far north too (spec §6.1, §8). In Israel and New York it is the same rule; smoke-zman-voice's candle-lighting check stays green.
4. day-list.ts's imports are exactly `./compute`, `./sets`, `./spec`, `../../lib/calendar-view/zman-spec` (type only: `ZmanSpecValue`, a file that imports nothing), `../../lib/calendar-view/zmanim-list` (type only) and `../../utils/day-events`; smoke-zmanim pins the list.
5. The day list places its window rows by the blocks' calendar days (`eve`, `last`), not by the local date of the instants. In Israel and New York this is identical (pinned row for row over 400 days, three sets). It also fixes an end of Shabbat after midnight, which spec §8 names: Riga, Ashkenazi, 19 June 2027 ends at 00:21 on Sunday, and the end row stays on the Saturday (the old code put a "not before" row on Saturday and a YOM_TOV_ENDS row on Sunday).
6. `restDayBlocks` lists every block whole (the old scan cut a block at the edges of its eight-day scan). `shabbatYomTovWindows`' output is unchanged, pinned against a frozen copy of the old function over 400 days in Israel, New York and Saint Petersburg, in all three sets, for four kinds of range, under three process zones.
7. smoke-zmanim-api's existing far-north assertions (Reykjavik and Svalbard, both on Sunday 2026-06-21) do not change: no rest-day block touches that day. A new check pins Reykjavik's Friday 2026-06-19 (candle lighting at 23:43) and Saturday 2026-06-20 (SHABBAT_ENDS with `at: null`).
8. Task 2: of the diaspora-only ids hebcal 6.0.6 produces from 2026 to 2030 (`pesachIi`, `pesachViii`, `shavuotI`, `shavuotIi`, `sukkotIi`, `simchatTorah`, `parashatChukatBalak`), only `pesachIi` and `pesachViii` need names (hebcal writes «Пэсах II» and «Восьмой день Пэсах»); every other id reads right in all three languages. smoke-hebrew-holidays' "every holidays.names entry is used" check widens to the diaspora schedule.

**City data and the shared rows (Tasks 3-4)**
9. `ZmanimRows`' `list` prop is `ZmanimRowsList = Pick<ZmanimListResponse, 'tz' | 'rows' | 'hours'>` (exported from components/app-ui/ZmanimRows.tsx), not `ZmanDayList | ZmanimListResponse`: naming `ZmanDayList` would import src/services into a component the client sheet bundles (CLAUDE.md; smoke-app-ui #6 rejects even a type import line). Both shapes fit structurally, so Task 6 passes either. It returns `ReactElement` (@types/react 19 has no global `JSX`).
10. `export type ZmanWordsT = (key: string, values?: Record<string, string | number>) => string` lives in `src/lib/calendar-view/zman-words.ts`. ZmanimRows, `components/site/zmanim/words.ts` (Task 6) and every other user import it from there, never from ZmanimRows.tsx (which does not re-export it).
11. `elevationGrid` and `Coordinates` move to the pure `src/services/zmanim/elevation-grid.ts` (one type import); `place.ts` imports and re-exports both, so smoke-zmanim's `place.elevationGrid` checks keep passing. `scripts/build-city-heights.ts` imports it from elevation-grid.ts and so loads no Prisma, Redis or error capture.
12. `src/site/near-city.ts` imports `instantToWallTime` from `src/utils/wall-time.ts` (a leaf with no imports) and nothing else; `utcOffsetMinutes` builds on it and throws RangeError for an unknown zone. `nearAnswer` never throws: a missing or unknown device zone gives no "near" answer, while the 30 km "open" band is by distance alone (review focus e).
13. All 51 Israeli rows carry `country: 'IL'`, even where GeoNames files the town under PS (maale-adumim 282993, beitar-illit 284375; Beitar Illit's only GeoNames record is named "Battir" but holds its names and point).
14. Two smokes outside the contract's list change: smoke-he-neutral's `ALLOWED` gains `cities.petah-tikva` ("פתח" is the city's name, not the imperative "open"); smoke-zman-reminders' server-only file list gains `components/app-ui/ZmanimRows.tsx` and `src/lib/calendar-view/zmanim-sheet-css.ts` (a plain component escapes smoke-zmanim's `'use client'` scan, yet the client sheet bundles it).

**The city view and the pages (Tasks 5-7)**
15. `buildCityView` never throws for one section (spec §6.5): `list: ZmanDayList | null`, `ahead: AheadWindow[] | null`, `month.weeks: MonthCell[][] | null`, `month.entries: MonthEntry[] | null` (null = that section failed), plus `failures: SectionFailure[]` (`{ section: 'day' | 'ahead' | 'month'; error: unknown }`). The view stays pure; the page calls `captureError` for each failure. `prevDay`, `nextDay`, `month.key`, `month.prevMonthDay` and `month.nextMonthDay` are plain date arithmetic, always there, so a failed section can still offer another day.
16. `month` also carries `weekStart: WeekStart`; `MonthCell` gains `inRange: boolean` (a cell outside the public range gets no link); `prevMonthDay` is clamped to the range's first day. New exports: `type CitySection`, `type SectionFailure`, `type MonthView` and `windowList(view, day, rows): ZmanDayList` (wraps window rows for `ZmanimRows`). `AheadWindow.holidays` is the window's Yom Tov days (kind `chag`), else its `cholHamoed` / `specialShabbat` days, de-duplicated by title.
17. `heightM` is the city's height only for Sephardi in Israel when it is above 0, else null (Tiberias's negative height counts as sea level in the engine, so its page shows the plain note).
18. `readCityParams` reads a parameter only when Next passes it as one string: a repeated one (an array), like a missing, malformed, out-of-range or default-equal value, is ignored, and the page shows today or the default (review focus d).
19. `src/site/zmanim/links.ts` exports `cityPath(slug, q?)`, `localeHref(locale, path)` (English unprefixed, as `localePrefix: 'as-needed'` writes it), `cityHref(locale, slug, q?)` and `type CityQuery`. `cityPath`'s community is typed `ZmanimListResponse['community']`, so links.ts imports nothing from src/services. Callers pass the community only when it is not the city's default.
20. Russian no-break spaces: Task 6 begins (Steps 1-6) by extending smoke-site-truth T6, through `RU_TYPOGRAPHY`, to the app strings the zmanim pages show (`calendarHome.zmanim.names`, `.opinions`, `.withOpinion`, `calendarHome.zmanimList`, `holidays`), fixing the four strings (`calendarHome.zmanim.names.MISHEYAKIR`, `calendarHome.zmanimList.shabbatYomTovEnds`, `noTime` and `failedBody`) and adding smoke-zmanim-sheet's `flat()` helper; its page smoke (Z8) runs T6 over the rendered Russian text and can only pass after them. Task 8 does not touch them. `calendarHome.zmanim.namesAfter.MISHEYAKIR` stays as it is (the site never renders it).
21. Near me's props: `cities: NearMeCity[]` with `NearMeCity = NearCity & { name: string; href: string }` (the page in the page's language, built on the server) and `words: NearMeWords`, built by `nearWords(t)` in the plain module `src/site/zmanim/near-words.ts`, which exports both types: a server page cannot call a function exported from a `'use client'` module. The site's client namespaces stay `['site']`.
22. `currentPosition()` (`src/lib/geolocation.ts`, with `type GeoResult` and `POSITION_OPTIONS`) logs nothing for denied, unavailable or unsupported: each caller logs the outcome in its own words (smoke-settings-render fails on any console line that does not start with "[settings]"). It logs only when `getCurrentPosition` itself throws.
23. Links and prefetch: the city list, the Near me link and every day, month, cell and community link are plain `<a href>` (a Next `<Link>` would prefetch, and a list of 135 dynamic city pages in view would spend a reader's 60-a-minute allowance). The request limit (Task 9) has no prefetch exemption: a request with `next-router-prefetch: 1` counts like any other, so no header buys a render past the limit.
24. The zmanim pages' metadata: both use `siteMetadata` (no `absoluteTitle`, so the layout's `'%s | FamCal'` template applies), and the city page's canonical is always the clean URL (its `generateMetadata` ignores `searchParams`). The keys: `zmanimSite.index.metaTitle`, `zmanimSite.index.description` (with `{count}`), `zmanimSite.city.metaTitle` and `zmanimSite.city.description` (with `{city}`, the `cities.<slug>` name). City titles per spec §6.3: en "Shabbat times and zmanim in {city}", he "זמני שבת וזמני היום ב{city}", ru "Время шаббата и зманим: {city}" (a no-break space after "и").
25. CSS: Task 6 adds `ZMANIM_SHEET_CSS` (Task 4's module) and `ZMANIM_PAGE_CSS` to `SITE_CSS`. The zmanim tap targets, each a rule written as `\n<selector> {` with a `min-block-size` of 44 px or more, on smoke-zmanim-pages' `TAPS` and on smoke-site-chrome H5's list: `.site-zm-arrow`, `.site-zm-today a`, `.site-zm-switch a`, `.site-zm-cell`, `.site-zm-sources a` (Task 6), `.site-zm-near-button`, `.site-zm-near-list`, `.site-zm-near-status a` and `.site-zm-cities a` (Task 7). The back link reuses `.site-back a` and the FamCal block `.site-start`, both already on H5's list. The day and month arrows carry the app's `ch-flip` icon class, flipped by `[dir='rtl'] .site-zm-arrow .ch-flip` (review focus c).
26. The city page exports `dynamic = 'force-dynamic'`, so today is always the city's today and no day is served from a cache. The FamCal block shows the landing's reminders-by-zman sentence with both its tags: "On Telegram" and the cheapest plan with reminders (`cheapestPlanWith('reminders')`); without the plan tag a paid feature would look free.

**The request limit and the legal texts (Tasks 9-10)**
27. The counting logic is the pure module `src/lib/page-limit.ts`: `CITY_PAGE_LIMIT` (60), `CITY_PAGE_WINDOW_MS` (60000), `type CityPageRequest = { path: string; address: string | null }`, `type CityPageVerdict = { ok: true } | { ok: false; retryAfterS: number }`, `type CityPageLimitState` and `cityPageVerdict(request, now, state?)`, with the process state on `globalThis.__zmanimPageLimit`. The log line names its minute: `[zmanim-limit] refused N requests in the minute from <ISO start of that minute>` (the proxy has no timer, so a minute is logged at the first request after it). A request without `x-real-ip` (local dev; Railway's edge always sets it) counts under the one key `none`.
28. The legal additions describe "Near me" without quoting its button label (Task 7's copy may change), and say "the zmanim pages" and "custom" (the landing's word for Sephardi, Ashkenazi or Chabad).

## Execution

- B1 = Tasks 1-2 (the engine core, holidays by place).
- B2 = Tasks 3-4 (the city data, the shared rows). Task 3 runs the network heights script once, on the controller's machine (Step 9): Nominatim at 1 request a second (about 51 requests) and the Copernicus GLO-90 tiles on AWS (no account); the values are committed.
- B3 = Tasks 5-7 (the city view, the city page, the index and Near me).
- B4 = Tasks 8-10 (the chrome and SEO, the request limit, the legal texts and docs). Task 8 ends with the controller's 960 px header check (Task 8 Step 11).
- After each batch: a task review of that batch's commits.
- After B4: the legal-text lawyer check (Task 10 Step 1, which the controller dispatches before the legal strings are committed), then one final whole-branch Opus review, then the CI mirror (a fresh clone with its own `npm ci`: `npx tsc --noEmit && npm run lint && bash scripts/ci-smokes.sh && npx next build`) and the push to main.
- Where the review focus is tested: (a), (b) and (d) in smoke-zmanim-public-view V13, V14 and V15 (Task 5 Step 1; `readCityParams` in Step 3); (c) and (d) in smoke-zmanim-pages Z12 and Z13 (Task 6 Step 7); (e) in smoke-cities (Task 3 Step 1; `nearAnswer` in Step 5).

## Running a smoke

- Every command runs from the worktree root, `/private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/zp-wt` (branch `zmanim-public`), unless it says otherwise. The worktree has no `.env` file, so no real value can be read.
- One smoke, the way `scripts/ci-smokes.sh` runs it (the fake env, TZ=Asia/Jerusalem), written out in full each time (in zsh a prefix kept in a variable is not split into words):
  ```bash
  env TZ=Asia/Jerusalem DATABASE_URL=postgresql://fake:fake@127.0.0.1:1/fake DIRECT_URL=postgresql://fake:fake@127.0.0.1:1/fake TELEGRAM_BOT_TOKEN=000000:fake WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 ENCRYPTION_KEY_PREVIOUS= NODE_ENV=development 'GOOGLE_TTS_CREDENTIALS={}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/<file>.ts
  ```
- `RUN scripts/<file>.ts` (Task 6 Steps 1-6, Tasks 8, 9 and 10) means exactly that command with that file.
- After smokes ran in the worktree: `cd /Users/razielgershoni/development/famcalbot && npx prisma generate` (node_modules is shared with main).
- Russian strings in this plan hold the no-break space itself (U+00A0, invisible here) wherever one is needed, as messages/ru.json does (275 of them today). Copy the bytes; never retype a Russian string by hand. In TypeScript a character class such as P7's `/ /g` is that character.

## Tasks

### Task 1: Engine core — rest-day blocks, the quiet option, and the pure day list

**Files:**
- Create: `src/services/zmanim/day-list.ts`
- Create: `scripts/smoke-zman-day-list.ts`
- Modify: `src/services/zmanim/compute.ts`: line 8 (the header row), after line 37 (new types), lines 77-81 (`logMissing`), lines 223-224 and 233 (`exactZmanimForDay`), lines 237-242 and 251 (`zmanimForDay`), lines 267-273, 286 and 294 (`zmanInstant`), lines 319-360 (`shabbatYomTovWindows` becomes `restDayBlocks` + `shabbatYomTovWindows`)
- Modify: `src/services/zmanim/reminder-times.ts`: the whole file, lines 1-234 (the memo, `instantAt`, `zmanRows` and the list body move to day-list.ts)
- Modify: `src/lib/calendar-view/zmanim-list.ts`: lines 12-14 (comment only)
- Modify: `scripts/smoke-zmanim.ts`: line 751 (the check's title) and lines 766-770 (the import list)
- Modify: `scripts/smoke-zmanim-api.ts`: line 21 (header), after line 303 (require day-list), after line 339 (`REYKJAVIK_PLACE`), lines 596-597 and 607-608 (comments), before line 607 (the far-north check), before line 619 (the one-code-path check)
- Test: `scripts/smoke-zman-day-list.ts`, `scripts/smoke-zmanim.ts`, `scripts/smoke-zmanim-api.ts`

**Interfaces:**
- Consumes: `Place`, `ZmanSpec`, `isRestDay`, `dayOf` (compute.ts); `zmanimSet`, `zmanimOfSet`, `communityCounting`, `ZMAN_KEYS` (sets.ts); `asZmanSpec` (spec.ts); `ZmanSpecValue` (lib/calendar-view/zman-spec.ts); `ZmanimListResponse`, `ZmanimListRow` (lib/calendar-view/zmanim-list.ts); `addDaysToDate`, `localDate`, `startOfLocalDay` (utils/day-events.ts)
- Produces: `ZmanOptions`, `RestDayBlock`, `restDayBlocks(range, place, community)`, `shabbatYomTovWindows(range, place, community, options?)` with unchanged output, the optional trailing `options` on `zmanInstant`, `zmanimForDay` and `exactZmanimForDay` (compute.ts); `ZmanMemo`, `ZmanDayList`, `ZmanListOptions`, `zmanDayForPlace(place, community, day, options?)`, `instantAt`, `zmanRows`, `lightsCandles`, `__resetZmanClockForTests` (day-list.ts); `zmanDayList(user, zone, day)` as the wrapper, and the re-export of `__resetZmanClockForTests` (reminder-times.ts)

- [ ] **Step 1: Write the failing smoke `scripts/smoke-zman-day-list.ts`**

Create the file with exactly this content. It holds frozen copies of the old `shabbatYomTovWindows` and of the old `zmanDayList` body, so the pins compare against the code as it is at HEAD.

```ts
// Smoke test for the day's zmanim list at a place with no person in it (src/services/zmanim/day-list.ts,
// zmanDayForPlace) and the rest-day blocks it reads (src/services/zmanim/compute.ts, restDayBlocks). Spec:
// docs/superpowers/specs/2026-10-30-public-zmanim-design.md §6.1 and §8; plan Task 1.
//
// What it pins:
//   - restDayBlocks: the calendar's blocks of rest days with the set's edges (the eve's SHKIA, the last day's
//     SHABBAT_ENDS), two-day Yom Tov abroad and one in Israel, and every block whole even where the scan starts or
//     stops inside it;
//   - the pause is unchanged: shabbatYomTovWindows gives exactly what the function gave before the blocks (a frozen
//     copy below) over 400 days in Israel, New York and Saint Petersburg, in the three sets, for one civil day, one UTC
//     day (the pause's own ask), one instant and one 14-month range;
//   - the bot's sun sheet is unchanged: zmanDayForPlace gives exactly the list the old zmanDayList body gave (a frozen
//     copy below) for 400 days in Harish and New York, in the three sets;
//   - the far north: an eve whose block the sun gives no end still lights its candles (the day's own time, or a dash
//     where the sun makes no sunset), the last day has its end row with no time, and the pause holds no such window;
//     an end that falls after midnight (Riga in June) stays on its own Saturday;
//   - a caller's own memo and quiet: the process memo is left untouched and no missing zman is logged, with the same
//     rows as the process path.
//
// Pure: no database, Redis, network or env. This file re-runs itself once per server zone (UTC, Asia/Jerusalem,
// America/New_York) as child processes, so one command covers all three; nothing here may depend on the one the
// process has:
//   npx tsx scripts/smoke-zman-day-list.ts

import { spawn } from 'node:child_process';
import Module from 'node:module';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const ZONES = ['UTC', 'Asia/Jerusalem', 'America/New_York'] as const;
const CHILD = 'ZMAN_DAY_LIST_SMOKE_CHILD';

// ---- The parent: one child per process zone ----

async function runChildren(): Promise<void> {
  const outputs = await Promise.all(
    ZONES.map(
      zone =>
        new Promise<{ zone: string; code: number; text: string }>(resolve => {
          // process.execArgv carries tsx's loader flags, so the child compiles TypeScript the same way.
          const child = spawn(process.execPath, [...process.execArgv, process.argv[1]], {
            env: { ...process.env, TZ: zone, [CHILD]: '1' },
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let text = '';
          child.stdout.on('data', chunk => (text += chunk));
          child.stderr.on('data', chunk => (text += chunk));
          child.on('close', code => resolve({ zone, code: code ?? 1, text }));
        })
    )
  );
  let failed = 0;
  for (const { zone, code, text } of outputs) {
    console.log(`\n===== process TZ=${zone} =====\n${text.trimEnd()}`);
    if (code !== 0) failed++;
  }
  console.log(`\n${ZONES.length - failed}/${ZONES.length} process zones passed (${ZONES.join(', ')})`);
  process.exit(failed === 0 ? 0 : 1);
}

// ---- Checks ----

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
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

const show = (value: unknown): string => JSON.stringify(value);

function assertSame(got: unknown, want: unknown, label: string): void {
  assert(show(got) === show(want), `${label}\n     got  ${show(got)}\n     want ${show(want)}`);
}

/** Console output the call made, and what it returned. */
function logged<T>(fn: () => T): { value: T; lines: string[] } {
  const lines: string[] = [];
  const kept = { log: console.log, warn: console.warn, info: console.info, error: console.error };
  const take = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  console.log = take; console.warn = take; console.info = take; console.error = take;
  try {
    return { value: fn(), lines };
  } finally {
    Object.assign(console, kept);
  }
}

// ---- @hebcal/core is ESM-only and tsx loads src/ as CommonJS: point it at its ESM build before the modules under test load ----

const internals = Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string };
const resolveFilename = internals._resolveFilename;
internals._resolveFilename = function (request: string, ...rest: unknown[]) {
  if (request === '@hebcal/core') return path.resolve(ROOT, 'node_modules/@hebcal/core/dist/esm/index.js');
  return resolveFilename.call(this, request, ...rest);
};

type Place = { latitude: number; longitude: number; elevationM: number | null; timeZone: string };
type Community = 'sephardi' | 'ashkenazi' | 'chabad';
type Range = { from: Date; to: Date };
type Block = { eve: string; last: string; start: Date | null; end: Date | null };
type Row = { key: string; opinion: string | null; at: string | null };
type List = { community: Community; day: string; tz: string; rows: Row[]; hours: Array<{ opinion: string; ms: number | null }> };
type Memo = Map<string, number | null>;
type Compute = {
  zmanimForDay: (date: string, place: Place, community: Community, options?: { quiet?: boolean }) => Record<string, Date | null | undefined>;
  zmanInstant: (date: string, spec: { zman: string; offsetMin: number }, place: Place, community: Community) => Date | null;
  halachicHourMs: (date: string, place: Place, community: Community) => { day: number | null; mga: number | null };
  isYomTovAt: (day: string, place: Place) => boolean;
  restDayBlocks: (range: Range, place: Place, community: Community) => Block[];
  shabbatYomTovWindows: (range: Range, place: Place, community: Community, options?: { quiet?: boolean }) => Array<[Date, Date]>;
  inIsrael: (zone: string) => boolean;
};
type DayList = {
  zmanDayForPlace: (place: Place, community: Community, day: string, options?: { memo?: Memo; quiet?: boolean }) => List;
  lightsCandles: (blocks: readonly Block[], day: string) => boolean;
  __resetZmanClockForTests: () => void;
};
type Sets = {
  zmanimOfSet: (community: Community) => string[];
  zmanimSet: (community: Community) => { mgaDay?: unknown; zmanim: Record<string, { opinion?: string } | undefined> };
  communityCounting: (zman: string, community: Community) => Community | null;
  ZMAN_KEYS: readonly string[];
};
type Hebcal = {
  HDate: new (abs: number) => unknown;
  HebrewCalendar: { getHolidaysOnDate: (date: unknown, il: boolean) => Array<{ getFlags(): number }> | undefined };
  flags: { CHAG: number };
};

/* eslint-disable @typescript-eslint/no-require-imports */
const compute = require('../src/services/zmanim/compute') as Compute;
const dayList = require('../src/services/zmanim/day-list') as DayList;
const sets = require('../src/services/zmanim/sets') as Sets;
const days = require('../src/utils/day-events') as { addDaysToDate: (day: string, n: number) => string; localDate: (at: Date, zone: string) => string; startOfLocalDay: (day: string, zone: string) => Date };
const wall = require('../src/utils/wall-time') as { instantToWallTime: (instant: Date, zone: string) => string };
const hebcal = require('@hebcal/core') as Hebcal;
/* eslint-enable @typescript-eslint/no-require-imports */

// ---- Places ----

const HARISH: Place = { latitude: 32.46182, longitude: 35.04555, elevationM: 270, timeZone: 'Asia/Jerusalem' };
const JERUSALEM: Place = { latitude: 31.778, longitude: 35.235, elevationM: 754, timeZone: 'Asia/Jerusalem' };
const NEW_YORK: Place = { latitude: 40.7127, longitude: -74.006, elevationM: 10, timeZone: 'America/New_York' };
const LONDON: Place = { latitude: 51.50853, longitude: -0.12574, elevationM: null, timeZone: 'Europe/London' };
const SAINT_PETERSBURG: Place = { latitude: 59.93863, longitude: 30.31413, elevationM: null, timeZone: 'Europe/Moscow' };
const RIGA: Place = { latitude: 56.946, longitude: 24.10589, elevationM: null, timeZone: 'Europe/Riga' };
const SVALBARD: Place = { latitude: 78.22, longitude: 15.65, elevationM: 0, timeZone: 'Arctic/Longyearbyen' };
const COMMUNITIES: Community[] = ['sephardi', 'ashkenazi', 'chabad'];
const DAY_MS = 86_400_000;
const MINUTE = 60_000;

/** The civil day n days after 2026-09-01. */
const dayFrom = (n: number): string => new Date(Date.UTC(2026, 8, 1 + n)).toISOString().slice(0, 10);
const weekdayOf = (day: string): number => new Date(`${day}T00:00:00Z`).getUTCDay();
const span = (blocks: Block[]): string[] => blocks.map(b => `${b.eve} -> ${b.last}`);
const isoPairs = (windows: Array<[Date, Date]>): string[][] => windows.map(([a, b]) => [a.toISOString(), b.toISOString()]);
const keysOf = (list: List): string[] => list.rows.map(r => r.key);
const rowOf = (list: List, key: string): Row => {
  const found = list.rows.find(r => r.key === key);
  assert(found, `${list.day}: no ${key} row in ${show(keysOf(list))}`);
  return found;
};
const processMemo = (): Memo => {
  const memo = (globalThis as { __zmanReminderAnswers?: Memo }).__zmanReminderAnswers;
  assert(memo instanceof Map, 'the process memo is on globalThis.__zmanReminderAnswers');
  return memo;
};

// ---- Frozen copies of the code before the blocks (HEAD ef987cc1): what the pause and the sun sheet must still give ----

/** compute.ts isRestDay, as it was. */
function legacyIsRestDay(day: string, il: boolean): boolean {
  if (weekdayOf(day) === 6) return true;
  const hdate = new hebcal.HDate(Math.floor(Date.parse(`${day}T00:00:00Z`) / DAY_MS) + 719_163);
  return (hebcal.HebrewCalendar.getHolidaysOnDate(hdate, il) ?? []).some(event => (event.getFlags() & hebcal.flags.CHAG) !== 0);
}

/** compute.ts shabbatYomTovWindows, as it was (without its log line). */
function legacyWindows(range: Range, place: Place, community: Community): Array<[Date, Date]> {
  const il = compute.inIsrael(place.timeZone);
  const fromDay = days.localDate(range.from, place.timeZone);
  const toDay = days.localDate(range.to, place.timeZone);
  const first = days.addDaysToDate(fromDay, -3);
  const last = days.addDaysToDate(toDay, 4);
  const windows: Array<[Date, Date]> = [];
  for (let day = first; day <= last; ) {
    if (!legacyIsRestDay(day, il)) {
      day = days.addDaysToDate(day, 1);
      continue;
    }
    let blockEnd = day;
    while (blockEnd < last && legacyIsRestDay(days.addDaysToDate(blockEnd, 1), il)) blockEnd = days.addDaysToDate(blockEnd, 1);
    const start = compute.zmanimForDay(days.addDaysToDate(day, -1), place, community, { quiet: true }).SHKIA ?? null;
    const end = compute.zmanimForDay(blockEnd, place, community, { quiet: true }).SHABBAT_ENDS ?? null;
    if (start && end && start.getTime() <= range.to.getTime() && end.getTime() > range.from.getTime()) windows.push([start, end]);
    day = days.addDaysToDate(blockEnd, 1);
  }
  return windows;
}

/** reminder-times.ts zmanDayList's body, as it was (the instants straight from zmanInstant, which the memo only remembers). */
function legacyList(place: Place, community: Community, day: string): List {
  const zone = place.timeZone;
  const set = sets.zmanimSet(community);
  const at = (zman: string): string | null => {
    const counting = sets.communityCounting(zman, community);
    return counting ? (compute.zmanInstant(day, { zman, offsetMin: 0 }, place, counting)?.toISOString() ?? null) : null;
  };
  const rows: Row[] = sets.zmanimOfSet(community).filter(key => key !== 'CANDLE_LIGHTING' && key !== 'SHABBAT_ENDS').map(key => ({ key, opinion: set.zmanim[key]?.opinion ?? null, at: at(key) }));
  const windows = legacyWindows({ from: days.startOfLocalDay(day, zone), to: days.startOfLocalDay(days.addDaysToDate(day, 1), zone) }, place, community);
  const weekday = weekdayOf(day);
  for (const [start, end] of windows) {
    const eve = days.localDate(start, zone);
    const last = days.localDate(end, zone);
    if (eve === day) rows.push({ key: 'CANDLE_LIGHTING', opinion: null, at: at('CANDLE_LIGHTING') });
    else if (eve < day && day < last) rows.push(weekday === 5 ? { key: 'CANDLE_LIGHTING', opinion: null, at: at('CANDLE_LIGHTING') } : { key: 'CANDLE_LIGHTING_NOT_BEFORE', opinion: null, at: at('SHABBAT_ENDS') });
    if (last === day) rows.push({ key: weekday !== 6 ? 'YOM_TOV_ENDS' : compute.isYomTovAt(day, place) ? 'SHABBAT_YOM_TOV_ENDS' : 'SHABBAT_ENDS', opinion: null, at: end.toISOString() });
  }
  const standsAt: Record<string, string> = { YOM_TOV_ENDS: 'SHABBAT_ENDS', SHABBAT_YOM_TOV_ENDS: 'SHABBAT_ENDS', CANDLE_LIGHTING_NOT_BEFORE: 'SHABBAT_ENDS' };
  const orderOf = (key: string) => sets.ZMAN_KEYS.indexOf(standsAt[key] ?? key);
  rows.sort((a, b) => orderOf(a.key) - orderOf(b.key));
  const hour = compute.halachicHourMs(day, place, community);
  const hours: List['hours'] = [{ opinion: set.zmanim.SOF_SHMA_GRA?.opinion ?? 'gra', ms: hour.day }];
  if (set.mgaDay) hours.push({ opinion: 'mga', ms: hour.mga });
  return { community, day, tz: zone, rows, hours };
}

async function runChecks(): Promise<void> {
  console.log(`process TZ=${process.env.TZ} (Intl: ${Intl.DateTimeFormat().resolvedOptions().timeZone})`);
  const noon = (from: string, to: string): Range => ({ from: new Date(`${from}T12:00:00Z`), to: new Date(`${to}T12:00:00Z`) });

  // ============ The blocks ============

  await check('restDayBlocks: the calendar\'s blocks with the set\'s edges, the eve\'s sunset row and the last day\'s end of Shabbat (Rosh Hashana 5787 with Shabbat as one block, then Shabbat Shuva and Yom Kippur)', () => {
    const blocks = compute.restDayBlocks(noon('2026-09-14', '2026-09-17'), JERUSALEM, 'sephardi');
    assertSame(span(blocks), ['2026-09-11 -> 2026-09-13', '2026-09-18 -> 2026-09-19', '2026-09-20 -> 2026-09-21'], 'the blocks');
    for (const block of blocks) {
      assert(block.start?.getTime() === compute.zmanimForDay(block.eve, JERUSALEM, 'sephardi').SHKIA?.getTime(), `${block.eve}: the start is the eve's SHKIA`);
      assert(block.end?.getTime() === compute.zmanimForDay(block.last, JERUSALEM, 'sephardi').SHABBAT_ENDS?.getTime(), `${block.last}: the end is the last day's SHABBAT_ENDS`);
    }
  });

  await check('restDayBlocks follows the place: Sukkot 2026 is one day in Jerusalem and two in New York', () => {
    assertSame(span(compute.restDayBlocks(noon('2026-09-24', '2026-09-24'), JERUSALEM, 'sephardi')), ['2026-09-20 -> 2026-09-21', '2026-09-25 -> 2026-09-26'], 'Jerusalem');
    assertSame(span(compute.restDayBlocks(noon('2026-09-24', '2026-09-24'), NEW_YORK, 'sephardi')), ['2026-09-20 -> 2026-09-21', '2026-09-25 -> 2026-09-27'], 'New York');
  });

  await check('a block is listed whole where the scan starts or stops inside it: Pesach 2027 in New York (Thursday, Friday and Shabbat) from a range that starts on Monday the 26th (the scan begins on the Friday) and from one that ends on Sunday the 18th (the scan stops on the Thursday)', () => {
    assertSame(span(compute.restDayBlocks(noon('2027-04-26', '2027-04-26'), NEW_YORK, 'sephardi')), ['2027-04-21 -> 2027-04-24', '2027-04-27 -> 2027-04-29'], 'the scan starts inside it');
    assertSame(span(compute.restDayBlocks(noon('2027-04-18', '2027-04-18'), NEW_YORK, 'sephardi')), ['2027-04-16 -> 2027-04-17', '2027-04-21 -> 2027-04-24'], 'the scan stops inside it');
  });

  // ============ The pause is unchanged ============

  for (const [label, place] of [['Israel', HARISH], ['New York', NEW_YORK], ['Saint Petersburg', SAINT_PETERSBURG]] as const) {
    await check(`the pause's windows are what they were, over 400 days from 2026-09-01 in ${label}, in the three sets: one civil day, one UTC day (as the pause asks), one instant, and one 14-month range`, () => {
      for (const community of COMMUNITIES) {
        for (let n = 0; n < 400; n++) {
          const day = dayFrom(n);
          const ranges: Range[] = [
            { from: days.startOfLocalDay(day, place.timeZone), to: days.startOfLocalDay(days.addDaysToDate(day, 1), place.timeZone) },
            { from: new Date(Date.parse(`${day}T00:00:00Z`)), to: new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS - 1) },
            { from: new Date(`${day}T17:30:00Z`), to: new Date(`${day}T17:30:00Z`) },
          ];
          for (const range of ranges) {
            const now = logged(() => compute.shabbatYomTovWindows(range, place, community)).value;
            assertSame(isoPairs(now), isoPairs(legacyWindows(range, place, community)), `${community} ${day} ${range.from.toISOString()}`);
          }
        }
        const long: Range = { from: new Date(Date.UTC(2026, 7, 28)), to: new Date(Date.UTC(2027, 10, 5)) };
        assertSame(isoPairs(logged(() => compute.shabbatYomTovWindows(long, place, community)).value), isoPairs(legacyWindows(long, place, community)), `${community}: 14 months`);
      }
    });
  }

  // ============ The sun sheet is unchanged ============

  for (const [label, place] of [['Harish', HARISH], ['New York', NEW_YORK]] as const) {
    await check(`the day list is what the sun sheet gave before, row for row, over 400 days from 2026-09-01 in ${label}, in the three sets`, () => {
      for (const community of COMMUNITIES) {
        for (let n = 0; n < 400; n++) {
          const day = dayFrom(n);
          assertSame(dayList.zmanDayForPlace(place, community, day, { memo: new Map() }), legacyList(place, community, day), `${community} ${day}`);
        }
      }
    });
  }

  await check('lightsCandles is the list\'s candle row: over 400 days in Harish and New York, a day has CANDLE_LIGHTING exactly when the blocks light candles on it, and every Friday does', () => {
    for (const place of [HARISH, NEW_YORK]) {
      for (let n = 0; n < 400; n++) {
        const day = dayFrom(n);
        const blocks = compute.restDayBlocks({ from: days.startOfLocalDay(day, place.timeZone), to: days.startOfLocalDay(days.addDaysToDate(day, 1), place.timeZone) }, place, 'sephardi');
        const lit = keysOf(dayList.zmanDayForPlace(place, 'sephardi', day, { memo: new Map() })).includes('CANDLE_LIGHTING');
        assert(lit === dayList.lightsCandles(blocks, day), `${place.timeZone} ${day}: the row ${lit}, the blocks ${dayList.lightsCandles(blocks, day)}`);
        if (weekdayOf(day) === 5) assert(lit, `${place.timeZone} ${day}: a Friday without candles`);
      }
    }
  });

  // ============ The far north ============

  await check('Saint Petersburg in June 2027 (Ashkenazi, 8.5 degrees never reached): Friday the 18th lights its candles at its own time, 20 minutes before the sunset row; Saturday the 19th has its end of Shabbat with no time, once, where the end stands; the pause holds no window it cannot end and says so, unless quiet', () => {
    const friday = dayList.zmanDayForPlace(SAINT_PETERSBURG, 'ashkenazi', '2027-06-18', { memo: new Map(), quiet: true });
    const own = compute.zmanimForDay('2027-06-18', SAINT_PETERSBURG, 'ashkenazi', { quiet: true });
    assert(rowOf(friday, 'CANDLE_LIGHTING').at === own.CANDLE_LIGHTING?.toISOString(), `the Friday's own candle lighting: ${rowOf(friday, 'CANDLE_LIGHTING').at}`);
    assert(Date.parse(rowOf(friday, 'SHKIA').at ?? '') - Date.parse(rowOf(friday, 'CANDLE_LIGHTING').at ?? '') === 20 * MINUTE, '20 minutes before the sunset row');
    assert(keysOf(friday).indexOf('CANDLE_LIGHTING') === keysOf(friday).indexOf('SHKIA') - 1, `in the order of the day: ${show(keysOf(friday))}`);
    const saturday = dayList.zmanDayForPlace(SAINT_PETERSBURG, 'ashkenazi', '2027-06-19', { memo: new Map(), quiet: true });
    assert(rowOf(saturday, 'SHABBAT_ENDS').at === null && keysOf(saturday).filter(k => k === 'SHABBAT_ENDS').length === 1, 'the end, with no time');
    assertSame(keysOf(saturday).slice(-2), ['SHABBAT_ENDS', 'CHATZOT_HALAYLA'], 'where the end stands');
    assert(!keysOf(saturday).includes('CANDLE_LIGHTING_NOT_BEFORE') && !keysOf(saturday).includes('CANDLE_LIGHTING'), `nothing else on the Saturday: ${show(keysOf(saturday))}`);
    const range = noon('2027-06-18', '2027-06-19');
    const said = logged(() => compute.shabbatYomTovWindows(range, SAINT_PETERSBURG, 'ashkenazi'));
    assertSame(said.value, [], 'no window');
    assertSame(said.lines, ['[zmanim] no end of Shabbat for the rest days 2027-06-19 to 2027-06-19: that window is left out'], 'logged');
    const quiet = logged(() => compute.shabbatYomTovWindows(range, SAINT_PETERSBURG, 'ashkenazi', { quiet: true }));
    assert(quiet.value.length === 0 && quiet.lines.length === 0, `quiet: ${show(quiet.lines)}`);
  });

  await check('Shavuot 2027 in Saint Petersburg (abroad: Thursday evening to Shabbat, no end): the eve lights, the Friday inside lights the Shabbat\'s candles, and the Saturday ends Shabbat and Yom Tov together with no time', () => {
    const at = (day: string) => dayList.zmanDayForPlace(SAINT_PETERSBURG, 'ashkenazi', day, { memo: new Map(), quiet: true });
    assert(typeof rowOf(at('2027-06-10'), 'CANDLE_LIGHTING').at === 'string', 'the eve');
    assert(typeof rowOf(at('2027-06-11'), 'CANDLE_LIGHTING').at === 'string' && !keysOf(at('2027-06-11')).includes('CANDLE_LIGHTING_NOT_BEFORE'), 'the Friday');
    assert(rowOf(at('2027-06-12'), 'SHABBAT_YOM_TOV_ENDS').at === null, 'the end');
  });

  await check('no sunset at all (Svalbard, June 2026): the Friday still has its candle row and the Saturday its end row, both a dash', () => {
    const friday = dayList.zmanDayForPlace(SVALBARD, 'sephardi', '2026-06-19', { memo: new Map(), quiet: true });
    const saturday = dayList.zmanDayForPlace(SVALBARD, 'sephardi', '2026-06-20', { memo: new Map(), quiet: true });
    assertSame(friday.rows.filter(r => r.key === 'CANDLE_LIGHTING'), [{ key: 'CANDLE_LIGHTING', opinion: null, at: null }], 'Friday');
    assertSame(saturday.rows.filter(r => r.key === 'SHABBAT_ENDS'), [{ key: 'SHABBAT_ENDS', opinion: null, at: null }], 'Saturday');
  });

  await check('an end after midnight stays on its own Saturday: Riga, Ashkenazi, 19 June 2027 ends at 00:21 on Sunday; the Saturday carries the end of Shabbat (not the candles "not before") and the Sunday carries no end', () => {
    const saturday = dayList.zmanDayForPlace(RIGA, 'ashkenazi', '2027-06-19', { memo: new Map(), quiet: true });
    const sunday = dayList.zmanDayForPlace(RIGA, 'ashkenazi', '2027-06-20', { memo: new Map(), quiet: true });
    const end = rowOf(saturday, 'SHABBAT_ENDS').at;
    assert(end !== null && wall.instantToWallTime(new Date(end), RIGA.timeZone).startsWith('2027-06-20T00:21'), `the end ${end}`);
    assert(!keysOf(saturday).includes('CANDLE_LIGHTING_NOT_BEFORE'), `Saturday ${show(keysOf(saturday))}`);
    assert(!keysOf(sunday).some(k => ['SHABBAT_ENDS', 'YOM_TOV_ENDS', 'SHABBAT_YOM_TOV_ENDS', 'CANDLE_LIGHTING_NOT_BEFORE'].includes(k)), `Sunday ${show(keysOf(sunday))}`);
    const windows = compute.shabbatYomTovWindows(noon('2027-06-18', '2027-06-20'), RIGA, 'ashkenazi');
    assert(windows.length === 1 && windows[0][1].toISOString() === end, 'the same instant the pause ends at');
  });

  // ============ The memo and the logs ============

  await check('a caller\'s own memo and quiet (the public pages): London on 21 June 2027 (Ashkenazi, no 16.1 degree dawn) leaves the process memo empty and logs nothing, with the same rows as the process path, which remembers and logs', () => {
    dayList.__resetZmanClockForTests();
    const own: Memo = new Map();
    const page = logged(() => dayList.zmanDayForPlace(LONDON, 'ashkenazi', '2027-06-21', { memo: own, quiet: true }));
    assert(processMemo().size === 0, `the process memo has ${processMemo().size} answers`);
    assert(own.size > 0, 'the page\'s memo has the answers');
    assertSame(page.lines, [], 'nothing logged');
    assert(rowOf(page.value, 'ALOT').at === null, 'dawn is a dash');
    const bot = logged(() => dayList.zmanDayForPlace(LONDON, 'ashkenazi', '2027-06-21'));
    assertSame(bot.value, page.value, 'the same list');
    assert(processMemo().size > 0, 'the process path remembers');
    assert(bot.lines.some(l => l.startsWith('[zmanim] no ALOT')), `the process path logs: ${show(bot.lines)}`);
    dayList.__resetZmanClockForTests();
    assert(processMemo().size === 0, 'reset');
  });

  report();
}

function report(): void {
  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  process.exit(failed === 0 ? 0 : 1);
}

if (process.env[CHILD] !== '1') {
  runChildren();
} else {
  runChecks().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
```

- [ ] **Step 2: Extend smoke-zmanim's server-only check to the day list**

In `scripts/smoke-zmanim.ts`, replace line 751:

```ts
  await check('server only: no client component or Mini App module imports src/services/zmanim, and the module loads nothing client-side (hebcal, the day and wall-time helpers, no React)', () => {
```

with:

```ts
  await check('server only: no client component or Mini App module imports src/services/zmanim, and the module loads nothing client-side (hebcal, the day and wall-time helpers, no React); the day list (day-list.ts) imports only pure modules', () => {
```

Then replace lines 766-770:

```ts
    for (const file of ['sets.ts', 'compute.ts']) {
      const text = readFileSync(path.join(ROOT, 'src/services/zmanim', file), 'utf8');
      assert(!/from ['"](react|next|@prisma|@upstash)/.test(text) && !/utils\/(prisma|redis)/.test(text), `${file} imports no database, Redis or React`);
    }
    assert(!/fromZonedTime|\.set(Hours|Date|Month|FullYear|Minutes|Seconds)\(/.test(readFileSync(path.join(ROOT, 'src/services/zmanim/compute.ts'), 'utf8')), 'compute.ts builds no instant from local fields');
```

with:

```ts
    for (const file of ['sets.ts', 'compute.ts', 'day-list.ts']) {
      const text = readFileSync(path.join(ROOT, 'src/services/zmanim', file), 'utf8');
      assert(!/from ['"](react|next|@prisma|@upstash)/.test(text) && !/utils\/(prisma|redis)/.test(text), `${file} imports no database, Redis or React`);
    }
    // The day list is what the public pages import: only the calculator, the sets, the spec reader, the day helpers and
    // the client-safe list types, never the place lookups (place.ts: Prisma, Redis, Nominatim) or the reminder clock.
    const dayListImports = [...readFileSync(path.join(ROOT, 'src/services/zmanim/day-list.ts'), 'utf8').matchAll(/^import .* from '([^']+)';$/gm)].map(m => m[1]);
    assertSame(dayListImports, ['./compute', './sets', './spec', '../../lib/calendar-view/zman-spec', '../../lib/calendar-view/zmanim-list', '../../utils/day-events'], 'day-list.ts imports');
    for (const file of ['compute.ts', 'day-list.ts']) {
      assert(!/fromZonedTime|\.set(Hours|Date|Month|FullYear|Minutes|Seconds)\(/.test(readFileSync(path.join(ROOT, 'src/services/zmanim', file), 'utf8')), `${file} builds no instant from local fields`);
    }
```

- [ ] **Step 3: Extend smoke-zmanim-api: the far north through the sheet, and one code path**

In `scripts/smoke-zmanim-api.ts`:

(a) Replace line 21:

```ts
//   - a polar day: null times and a null hour, never a failure;
```

with:

```ts
//   - a polar day: null times and a null hour, never a failure; in the far north an eve whose window the sun gives no
//     end still lights its candles and the last day has its end row with no time (the pause still holds no such window);
//   - one code path: the sheet's list is day-list.ts zmanDayForPlace at the person's point, height and community, plus
//     the place label;
```

(b) Insert the following immediately before line 303 (`const route = (await import(path.join(ROOT, 'app/api/zmanim/route.ts'))) as Row;`):

```ts
  const dayList = nodeRequire(path.join(ROOT, 'src/services/zmanim/day-list.ts')) as {
    zmanDayForPlace: (place: Row, community: string, day: string, options?: { memo?: Map<string, number | null>; quiet?: boolean }) => Row;
  };
```

(c) After line 339 (`const NY_PLACE = ...`) insert:

```ts
  const REYKJAVIK_PLACE = { latitude: 64.1466, longitude: -21.9426, elevationM: 20, timeZone: 'Atlantic/Reykjavik' };
```

(d) In the Reykjavik check (line 596), insert these two comment lines as the first lines of its body, before `seed();` (line 597):

```ts
    // 2026-06-21 is a Sunday that no rest-day block touches, so the far-north fix (the rest-day blocks, 6a) leaves its
    // 13 rows as they were; the Friday and the Saturday around it are pinned in the next check.
```

(e) Insert this new check immediately before the Svalbard check (line 607):

```ts
  await check('the far north (6a): Reykjavik on Friday 2026-06-19 (Ashkenazi: a sunset, no 8.5 degree nightfall) lights its candles at the day\'s own time, before the sunset row; Saturday the 20th has its end of Shabbat with no time; the pause\'s windows hold neither day, as before', async () => {
    seed();
    const friday = await listOf(TG.polar, '2026-06-19');
    const saturday = await listOf(TG.polar, '2026-06-20');
    assert(rowOf(friday, 'CANDLE_LIGHTING').at === compute.zmanimForDay('2026-06-19', REYKJAVIK_PLACE, 'ashkenazi').CANDLE_LIGHTING!.toISOString(), 'the Friday\'s own candle lighting');
    assert(keysOf(friday).indexOf('CANDLE_LIGHTING') === keysOf(friday).indexOf('SHKIA') - 1 && keysOf(friday).length === 14, `Friday ${show(keysOf(friday))}`);
    assertSame(rowsOf(saturday).filter((r) => END_KEYS.includes(r.key) || r.key.startsWith('CANDLE')), [{ key: 'SHABBAT_ENDS', opinion: null, at: null }], 'Saturday: the end, no time');
    assertSame(keysOf(saturday).slice(-2), ['SHABBAT_ENDS', 'CHATZOT_HALAYLA'], 'where the end stands');
    assertSame(compute.shabbatYomTovWindows({ from: new Date('2026-06-19T00:00:00Z'), to: new Date('2026-06-21T00:00:00Z') }, REYKJAVIK_PLACE, 'ashkenazi'), [], 'no window for the pause');
  });

```

(f) In the Svalbard check, insert as the first line of its body, before its `seed();` (line 608):

```ts
    // A Sunday, as above: no rest-day row, unchanged by the far-north fix.
```

(g) Insert immediately before line 619 (`// ================= The communities =================`):

```ts
  // ================= One code path =================

  await check('the sheet\'s list is day-list.ts zmanDayForPlace at the person\'s point, height and community, with only the place label added: Harish on a Wednesday, a Friday, a Saturday and Sukkot, New York on the two days of Shemini Atzeret and Simchat Torah', async () => {
    seed();
    const cases: Array<[number, Row, string, string]> = [
      [TG.harish, HARISH_PLACE, 'sephardi', '2026-10-28'], [TG.harish, HARISH_PLACE, 'sephardi', '2026-10-30'], [TG.harish, HARISH_PLACE, 'sephardi', '2026-10-31'],
      [TG.harish, HARISH_PLACE, 'sephardi', '2026-09-26'], [TG.ny, NY_PLACE, 'sephardi', '2026-10-03'], [TG.ny, NY_PLACE, 'sephardi', '2026-10-04'],
    ];
    for (const [tg, place, community, date] of cases) {
      const list = await listOf(tg, date);
      const { place: label, ...rest } = list;
      assert(label && typeof label === 'object', `${date}: a place label`);
      assertSame(rest, dayList.zmanDayForPlace(place, community, date, { memo: new Map() }), `${date}`);
    }
  });

```

- [ ] **Step 4: Run the three smokes red**

```bash
env TZ=Asia/Jerusalem DATABASE_URL=postgresql://fake:fake@127.0.0.1:1/fake DIRECT_URL=postgresql://fake:fake@127.0.0.1:1/fake TELEGRAM_BOT_TOKEN=000000:fake WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 ENCRYPTION_KEY_PREVIOUS= NODE_ENV=development 'GOOGLE_TTS_CREDENTIALS={}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-zman-day-list.ts
env TZ=Asia/Jerusalem DATABASE_URL=postgresql://fake:fake@127.0.0.1:1/fake DIRECT_URL=postgresql://fake:fake@127.0.0.1:1/fake TELEGRAM_BOT_TOKEN=000000:fake WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 ENCRYPTION_KEY_PREVIOUS= NODE_ENV=development 'GOOGLE_TTS_CREDENTIALS={}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-zmanim.ts
env TZ=Asia/Jerusalem DATABASE_URL=postgresql://fake:fake@127.0.0.1:1/fake DIRECT_URL=postgresql://fake:fake@127.0.0.1:1/fake TELEGRAM_BOT_TOKEN=000000:fake WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 ENCRYPTION_KEY_PREVIOUS= NODE_ENV=development 'GOOGLE_TTS_CREDENTIALS={}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-zmanim-api.ts
```

Expected (verified on a scratch copy of HEAD):
- smoke-zman-day-list: exits 1. Each child dies with `Error: Cannot find module '../src/services/zmanim/day-list'`.
- smoke-zmanim: exits 1, `41/42 passed` in each zone. The FAIL is `server only: ... the day list (day-list.ts) imports only pure modules — ENOENT: no such file or directory, open '.../src/services/zmanim/day-list.ts'`, and the last line is `0/3 process zones passed`.
- smoke-zmanim-api: exits 1. Each child dies with `Error: Cannot find module '.../src/services/zmanim/day-list.ts'`, and the last line is `0/3 process zones passed`.

- [ ] **Step 5: compute.ts — the quiet option, the blocks, and the windows as the complete blocks**

In `src/services/zmanim/compute.ts`:

(a) Replace line 8:

```ts
 *   shabbatYomTovWindows   when Shabbat and Yom Tov hold, from sunset on the eve to the end of the day
```

with:

```ts
 *   restDayBlocks          every run of Shabbat and Yom Tov days, with its eve, its last day and its edges (null where the sun makes none)
 *   shabbatYomTovWindows   when Shabbat and Yom Tov hold, from sunset on the eve to the end of the day: the complete blocks
```

(b) After line 37 (`export type ZmanimDay = Partial<Record<ZmanKey, Date | null>>;`) insert:

```ts

/**
 * What a caller asks of the calculator besides the answer. `quiet`: no console.warn for a zman the sun does not make
 * that day, nor for a block of rest days left out of the windows; for a caller that shows the gap itself (the public
 * zmanim pages, where a dash and a note say why). A rule, an offset or a number of hours that is not one is still logged.
 */
export type ZmanOptions = { quiet?: boolean };

/**
 * A run of rest days next to each other (Shabbat, Yom Tov, or both: Yom Tov on a Friday into Shabbat, Rosh Hashana's two
 * days). `eve` (yyyy-MM-dd in the place's zone) is the day whose sunset starts it, `last` its last rest day; `start` is
 * the eve's sunset (the set's SHKIA) and `end` the last day's end of Shabbat (the set's SHABBAT_ENDS), each null where
 * the sun does not make it that day (the far north in summer). The calendar gives the days, the sun only the edges.
 */
export type RestDayBlock = { eve: string; last: string; start: Date | null; end: Date | null };
```

(c) Replace lines 77-79:

```ts
/** Where the zman could not be found: one log line a call, never one per zman. */
function logMissing(day: string, place: Place, keys: string[]): void {
  if (keys.length === 0) return;
```

with:

```ts
/** Where the zman could not be found: one log line a call, never one per zman, and none for a quiet caller. */
function logMissing(day: string, place: Place, keys: string[], options: ZmanOptions = {}): void {
  if (keys.length === 0 || options.quiet) return;
```

(d) Line 224 becomes:

```ts
export function exactZmanimForDay(date: string, place: Place, community: ZmanimCommunity, options: ZmanOptions = {}): ZmanimDay {
```

and its line 233 becomes `  logMissing(date, place, missing, options);`.

(e) Line 240 (` * day (the sun never reaches that angle at a polar place) is null, and the call logs it once.`) becomes:

```ts
 * day (the sun never reaches that angle at a polar place) is null, and the call logs it once (unless quiet).
```

Line 242 becomes:

```ts
export function zmanimForDay(date: string, place: Place, community: ZmanimCommunity, options: ZmanOptions = {}): ZmanimDay {
```

and its line 251 becomes `  logMissing(date, place, missing, options);`.

(f) Replace lines 270-273:

```ts
 * offset. Null, and logged, where the zman does not exist that day, the set has no such zman, or
 * the spec is not one.
 */
export function zmanInstant(date: string, spec: ZmanSpec, place: Place, community: ZmanimCommunity): Date | null {
```

with:

```ts
 * offset. Null, and logged, where the zman does not exist that day (unless quiet), the set has no
 * such zman, or the spec is not one.
 */
export function zmanInstant(date: string, spec: ZmanSpec, place: Place, community: ZmanimCommunity, options: ZmanOptions = {}): Date | null {
```

Line 286 becomes `    if (base === null) logMissing(date, place, [spec.zman], options);`, and line 294 becomes ``    if (base === null) logMissing(date, place, [`${spec.halachicHours} halachic hours after sunrise`], options);``. The three other warnings in `zmanInstant` (an offset that is no number, a set without the zman, hours out of range) stay unconditional: they are real errors.

(g) Replace lines 319-360 (the doc comment and the whole of `shabbatYomTovWindows`) with:

```ts
/**
 * The blocks of rest days at the place for the days around `range` (two instants): every block with a rest day from
 * three days before the range's first civil day to four days after its last, in order, each whole (a block the scan
 * starts or stops inside is still listed from its first rest day to its last). So every block whose window overlaps
 * the range is among them, with a few around it; a caller picks by day (the day list) or by instant (the windows).
 * Yom Tov follows the Israel schedule in Israel and the diaspora's elsewhere, by the place's zone. A block is listed
 * even where the sun makes no edge: its `start` or `end` is null then. Logs nothing.
 */
export function restDayBlocks(range: { from: Date; to: Date }, place: Place, community: ZmanimCommunity): RestDayBlock[] {
  const il = inIsrael(place.timeZone);
  const fromDay = localDate(range.from, place.timeZone);
  const toDay = localDate(range.to, place.timeZone);
  // A window is at most three rest days (Thursday and Friday Yom Tov with Shabbat), and one
  // starting on the evening of `toDay` has its first rest day the day after.
  const first = addDaysToDate(fromDay, -3);
  const last = addDaysToDate(toDay, 4);

  const blocks: RestDayBlock[] = [];
  let day = first;
  // A block that began before the scan is listed from its own first rest day.
  while (isRestDay(day, il) && isRestDay(addDaysToDate(day, -1), il)) day = addDaysToDate(day, -1);
  while (day <= last) {
    if (!isRestDay(day, il)) {
      day = addDaysToDate(day, 1);
      continue;
    }
    // A block of rest days, day to blockEnd (past the scan's last day too: a block is never cut).
    let blockEnd = day;
    while (isRestDay(addDaysToDate(blockEnd, 1), il)) blockEnd = addDaysToDate(blockEnd, 1);
    const eve = addDaysToDate(day, -1);
    blocks.push({ eve, last: blockEnd, start: dayOf(eve, place, community).shown('SHKIA'), end: dayOf(blockEnd, place, community).shown('SHABBAT_ENDS') });
    day = addDaysToDate(blockEnd, 1);
  }
  return blocks;
}

/**
 * When Shabbat and Yom Tov hold at the place, for the days that touch `range`: each window runs
 * from sunset on the evening before the first rest day (the set's SHKIA, the sunset its list shows
 * as the plain sunset row, 20 minutes after its candle lighting: the owner's ruling, 2026-10-28) to
 * the end of the last one (the set's end of Shabbat, rounded later), and rest days next to each
 * other make one window (Yom Tov on a Friday into Shabbat, Shabbat into a Yom Tov on Sunday, the
 * two days of Rosh Hashana). Yom Tov follows the Israel schedule in Israel and the diaspora's
 * elsewhere. A window is the half-open [start, end): at its start the pause holds, at its end it
 * no longer does. The windows are the complete blocks of restDayBlocks: a block whose sunset or end
 * does not exist (polar) is left out and logged (unless quiet).
 *
 * `range` is two instants; the windows returned are those that overlap it.
 */
export function shabbatYomTovWindows(range: { from: Date; to: Date }, place: Place, community: ZmanimCommunity, options: ZmanOptions = {}): Array<[Date, Date]> {
  const windows: Array<[Date, Date]> = [];
  for (const { eve, last, start, end } of restDayBlocks(range, place, community)) {
    if (start && end) {
      if (start.getTime() <= range.to.getTime() && end.getTime() > range.from.getTime()) windows.push([start, end]);
    } else if (!options.quiet) {
      console.warn(`[zmanim] no ${start ? 'end of Shabbat' : 'sunset'} for the rest days ${addDaysToDate(eve, 1)} to ${last}: that window is left out`);
    }
  }
  return windows;
}
```

The warning's text is the old one, word for word (`addDaysToDate(eve, 1)` is the block's first rest day, the old `day`). smoke-zmanim's "left out and logged" check matches on it.

- [ ] **Step 6: Create `src/services/zmanim/day-list.ts`**

```ts
/**
 * A day's zmanim list at a place, with no person in it: the home's sun sheet (reminder-times.ts zmanDayList, at the
 * person's place) and the public zmanim pages (at a listed city) both read this one function, so for the same place,
 * height, community and day they show the same rows. Spec: docs/superpowers/specs/2026-10-30-public-zmanim-design.md §6.1.
 *
 *   zmanDayForPlace   the rows and the halachic hours of a civil day at a place
 *   instantAt         a reminder's rule as an instant at a place on a day, through the memo (the one way a list reads a zman)
 *   zmanRows          a set's zmanim on a day as list rows, each from instantAt
 *   lightsCandles     whether a day lights candles by the rest-day blocks (the eve of one, or a Friday inside one)
 *
 * An answer is remembered (keyed by the place, the community that counts it, the day and the rule) in a memo: the
 * process's own by default (on globalThis: Next 16 gives the scheduler and the routes separate module instances), so a
 * pass that ticks every minute does not count the same zman again; a caller that must not touch it (a public page,
 * which a crawler could open by the thousand) passes its own.
 *
 * Pure: no database, Redis, network or React (smoke-zmanim pins its imports). Server only, as compute.ts is.
 */

import { halachicHourMs, isYomTovAt, restDayBlocks, zmanInstant, type Place, type RestDayBlock } from './compute';
import { ZMAN_KEYS, communityCounting, zmanimOfSet, zmanimSet, type ZmanKey, type ZmanimCommunity } from './sets';
import { asZmanSpec } from './spec';
import type { ZmanSpecValue } from '../../lib/calendar-view/zman-spec';
import type { ZmanimListResponse, ZmanimListRow } from '../../lib/calendar-view/zmanim-list';
import { addDaysToDate, startOfLocalDay } from '../../utils/day-events';

/** Answers by key: epoch ms, or null where the zman does not exist that day. */
export type ZmanMemo = Map<string, number | null>;

/** A day's list without the person's place label (zmanDayList adds it for the sun sheet). */
export type ZmanDayList = Omit<ZmanimListResponse, 'place'>;

/** `memo`: where answers are kept (the process's by default). `quiet`: no log for a zman the sun does not make (compute.ts ZmanOptions). */
export type ZmanListOptions = { memo?: ZmanMemo; quiet?: boolean };

/** The answers kept in a memo; past this it starts over (a few thousand small entries, never a leak). */
const MAX_ANSWERS = 5000;

const shared = globalThis as { __zmanReminderAnswers?: ZmanMemo };
const answers: ZmanMemo = (shared.__zmanReminderAnswers ??= new Map());

/** Smoke scripts only: back to a fresh process. */
export function __resetZmanClockForTests(): void {
  answers.clear();
}

/** A reminder's rule as an instant at the place on `day`, counted by the reader's community (or the nearest set that has the zman). */
export function instantAt(place: Place, community: ZmanimCommunity, day: string, spec: ZmanSpecValue, options: ZmanListOptions = {}): Date | null {
  const valid = asZmanSpec(spec);
  if (!valid) {
    console.warn(`[zmanim] a reminder's rule is not one this build knows (${JSON.stringify(spec)}): no time`);
    return null;
  }
  // A zman the reader's own set lacks is counted by the nearest set that has it (sets.ts communityCounting).
  const counting = 'zman' in valid ? communityCounting(valid.zman, community) : community;
  if (!counting) {
    console.warn(`[zmanim] no set has ${'zman' in valid ? valid.zman : 'this rule'}: no time`);
    return null;
  }
  const memo = options.memo ?? answers;
  const key = [place.latitude, place.longitude, place.elevationM ?? '', place.timeZone, counting, day, JSON.stringify(valid)].join('|');
  if (memo.has(key)) {
    const known = memo.get(key) ?? null;
    return known === null ? null : new Date(known);
  }
  const at = zmanInstant(day, valid, place, counting, { quiet: options.quiet });
  if (memo.size >= MAX_ANSWERS) memo.clear();
  memo.set(key, at ? at.getTime() : null);
  return at;
}

/**
 * The zmanim of a community's set on a day, as a list reads them: each key, the opinion the set names it with, and its
 * instant as an ISO string (null where the sun does not make it that day, or where there is no place). The editor's
 * block and the day list both read this one list, so the instants come from instantAt and nothing else.
 */
export function zmanRows(place: Place | null, community: ZmanimCommunity, day: string, keys: readonly ZmanKey[], options: ZmanListOptions = {}): ZmanimListRow[] {
  const set = zmanimSet(community);
  return keys.map((key) => ({
    key,
    opinion: set.zmanim[key]?.opinion ?? null,
    at: place ? (instantAt(place, community, day, { zman: key, offsetMin: 0 }, options)?.toISOString() ?? null) : null,
  }));
}

/** The weekday of a civil date (0 = Sunday), the same on a server in any zone. */
const weekdayOf = (day: string): number => new Date(`${day}T00:00:00Z`).getUTCDay();

/**
 * Whether `day` lights candles by the rest-day blocks: the eve of a block, or a Friday inside a longer one (a Yom Tov on a
 * Friday: the Shabbat's candles). By the calendar alone, so an eve whose block the sun gives no end (the far north in
 * summer) still lights them. The day list's candle row and the reminder's "candle lighting" day (reminder-times.ts
 * candleLightingDays) both ask it.
 */
export function lightsCandles(blocks: readonly RestDayBlock[], day: string): boolean {
  const friday = weekdayOf(day) === 5;
  return blocks.some((block) => block.eve === day || (friday && block.eve < day && day < block.last));
}

/** The zmanim a day's list does not take from the set's own order: the rest-day blocks give them. */
const FROM_WINDOWS: readonly ZmanKey[] = ['CANDLE_LIGHTING', 'SHABBAT_ENDS'];

/** The window rows that stand where a set zman does in the order of the day: every kind of end, and the candles "not before", stand where the end of Shabbat does. */
const STANDS_AT: Record<string, ZmanKey> = { YOM_TOV_ENDS: 'SHABBAT_ENDS', SHABBAT_YOM_TOV_ENDS: 'SHABBAT_ENDS', CANDLE_LIGHTING_NOT_BEFORE: 'SHABBAT_ENDS' };

/** Where a row stands in the day: its key's place in the order of the day. */
const orderOf = (key: string): number => ZMAN_KEYS.indexOf((STANDS_AT[key] ?? key) as ZmanKey);

/**
 * `day` (a civil date in the place's zone) at the place under the community's set.
 *   rows   the set's zmanim in the order of the day, and among them the rows of the Shabbat and Yom Tov blocks
 *          (restDayBlocks says on which day each falls; the pause's windows are the complete ones; WINDOW_ROW_KEYS names
 *          them). The pause begins at the eve's sunset, the set's plain sunset row (SHKIA), and ends at the end row; the
 *          candle lighting is not the window's edge, it is the day's own time, 20 minutes before that sunset:
 *          - the candle lighting on the day a block begins (the eve) and on every Friday inside one (lightsCandles):
 *            that day's own time, the Shabbat's candles;
 *          - on any other rest day inside a block and before its last (the Saturday before a Yom Tov on Sunday, the
 *            first day of a two-day Yom Tov) the candle lighting "not before" that day's own end;
 *          - on the day a block ends, its end: of Shabbat (a Saturday), of Shabbat and Yom Tov together (a Saturday that
 *            is also a Yom Tov) or of Yom Tov (any other day); null (a dash) where the sun makes no end that night.
 *          The days come from the calendar and only the times from the sun, so where the sun makes no end (the far
 *          north in summer) the eve still has its candle lighting and the last day its end row, with no time.
 *   hours  the halachic hour: the GRA's and the Magen Avraham's, or the Baal HaTanya's for Chabad.
 */
export function zmanDayForPlace(place: Place, community: ZmanimCommunity, day: string, options: ZmanListOptions = {}): ZmanDayList {
  const zone = place.timeZone;
  const set = zmanimSet(community);

  const rows = zmanRows(place, community, day, zmanimOfSet(community).filter((key) => !FROM_WINDOWS.includes(key)), options);
  const blocks = restDayBlocks({ from: startOfLocalDay(day, zone), to: startOfLocalDay(addDaysToDate(day, 1), zone) }, place, community);
  const weekday = weekdayOf(day);
  /** The day's own instant of a zman, as a row carries it (the set's rows come from the same instantAt). */
  const ownAt = (zman: ZmanKey): string | null => instantAt(place, community, day, { zman, offsetMin: 0 }, options)?.toISOString() ?? null;
  // The block begins at the eve's sunset (a row of the set, in the rows above): the candle lighting is the eve's own time, not the start.
  if (lightsCandles(blocks, day)) rows.push({ key: 'CANDLE_LIGHTING', opinion: null, at: ownAt('CANDLE_LIGHTING') });
  // A rest day inside a block that is not its last nor a Friday: the second night's candles, after the day's own end.
  else if (blocks.some((block) => block.eve < day && day < block.last)) rows.push({ key: 'CANDLE_LIGHTING_NOT_BEFORE', opinion: null, at: ownAt('SHABBAT_ENDS') });
  const ending = blocks.find((block) => block.last === day);
  if (ending) {
    const key = weekday !== 6 ? 'YOM_TOV_ENDS' : isYomTovAt(day, place) ? 'SHABBAT_YOM_TOV_ENDS' : 'SHABBAT_ENDS';
    rows.push({ key, opinion: null, at: ending.end?.toISOString() ?? null });
  }
  rows.sort((a, b) => orderOf(a.key) - orderOf(b.key));

  const hour = halachicHourMs(day, place, community);
  const hours: ZmanDayList['hours'] = [{ opinion: set.zmanim.SOF_SHMA_GRA?.opinion ?? 'gra', ms: hour.day }];
  if (set.mgaDay) hours.push({ opinion: 'mga', ms: hour.mga });

  return { community, day, tz: zone, rows, hours };
}
```

- [ ] **Step 7: reminder-times.ts becomes the person's wrapper**

Replace the whole of `src/services/zmanim/reminder-times.ts` (lines 1-234) with:

```ts
/**
 * The heavy half of the zman clock (reminder-clock.ts is the light one): the person's place and the
 * calculator, behind one function per use. Plan: docs/superpowers/plans/2026-10-28-zmanim-reminders.md (Task 3).
 *
 *   buildZmanClock    the clock the pass, the home and the digests read a reminder's due time from
 *   zmanEditorInfo    what the editor offers: the community's zmanim and today's time of each
 *   candleLightingDays  the days a person lights candles, from the rest-day blocks (day-list.ts lightsCandles)
 *   zmanDayList       the home's sun sheet: day-list.ts zmanDayForPlace at the person's place, with the place's label
 *
 * The one function that turns a zman rule into an instant is compute.ts zmanInstant; everything here only finds the
 * place to count it at: the person's own (saved coordinates, filled once from a place name), else their zone's main
 * city (the pause's fallback, pause-windows.ts), logged once a day per person. A zone with no main city has no place:
 * no clock.
 *
 * A reminder is written under its writer's community but read under each recipient's, and the sets do not hold the same
 * zmanim: a zman the recipient's own set lacks is counted by the nearest set that has it (sets.ts communityCounting) at the
 * recipient's own place and named with that set's opinion, so it is never silent for them.
 *
 * An answer is remembered for the process (day-list.ts instantAt, on globalThis: Next 16 gives the scheduler and the
 * routes separate module instances), keyed by the place, the community, the day and the rule, so a pass that ticks every
 * minute does not count the same zman again, and a zman that does not exist that day is logged once, not once a tick.
 */

import { ensureUserCoordinates, placeWithHeightRetry, type PlaceUser } from './place';
import { mainCityPlace } from './pause-windows';
import { restDayBlocks, type Place } from './compute';
import { communityCounting, isZmanKey, zmanimSet } from './sets';
import { communityOfUser, reminderZmanim } from './spec';
import { instantAt, lightsCandles, zmanDayForPlace, zmanRows } from './day-list';
import type { ZmanClock, ZmanSpecValue, ZmanimInfo } from '../../lib/calendar-view/zman-spec';
import type { ZmanimListResponse } from '../../lib/calendar-view/zmanim-list';
import { addDaysToDate, startOfLocalDay } from '../../utils/day-events';
import type { ZmanUser } from './reminder-clock';
import { warnOnceADay } from './once';

// Smoke scripts reset the process memo through here, as they did before it moved to day-list.ts.
export { __resetZmanClockForTests } from './day-list';

function placeUserOf(user: ZmanUser): PlaceUser {
  return {
    id: user.id,
    location: user.location ?? '',
    latitude: user.latitude ?? null,
    longitude: user.longitude ?? null,
    elevationM: user.elevationM ?? null,
    googleRefreshToken: user.googleRefreshToken,
  };
}

/**
 * Where to count the person's zmanim, and whether that is their own place; null where there is no place at all.
 * `background`: a place name with no coordinates is looked up without being waited for, and the zone's main city
 * stands in for this one call (the editor's info, which must not be held up by it).
 */
async function placeFor(user: ZmanUser, zone: string, background = false): Promise<{ place: Place; source: 'saved' | 'zone' } | null> {
  const placeUser = placeUserOf(user);
  const coordinates = await ensureUserCoordinates(placeUser, { background });
  const own = coordinates ? placeWithHeightRetry(placeUser, coordinates, zone) : null;
  if (own) return { place: own, source: 'saved' };
  const city = mainCityPlace(zone);
  if (!city) {
    warnOnceADay(`${user.id}|nocity`, `[zmanim] user ${user.id} has no usable location and ${zone} has no main city to count zmanim from: reminders by zman are skipped`);
    return null;
  }
  warnOnceADay(`${user.id}|city`, `[zmanim] user ${user.id} has no usable location: counting zmanim by the main city of ${zone}`);
  return { place: city, source: 'zone' };
}

/** The person's zman clock for `zone`, or null where there is no place to count from. */
export async function buildZmanClock(user: ZmanUser, zone: string): Promise<ZmanClock | null> {
  const found = await placeFor(user, zone);
  if (!found) return null;
  const community = communityOfUser(user);
  return {
    source: found.source,
    instant: (day, spec) => instantAt(found.place, community, day, spec),
    // The opinion of the set that counts it for this reader (their own, else the nearest that has it).
    opinion: (zman) => {
      const counting = isZmanKey(zman) ? communityCounting(zman, community) : null;
      return isZmanKey(zman) && counting ? (zmanimSet(counting).zmanim[zman]?.opinion ?? null) : null;
    },
  };
}

/**
 * The civil days (yyyy-MM-dd in `zone`) from `fromDay` for `spanDays` days on which the person lights candles: the day a
 * Shabbat or Yom Tov block begins and, inside a longer block, each Friday (the Shabbat's candles). The blocks are the
 * pause's own (restDayBlocks; the pause's windows are the complete ones) and the rule for a day is the sun sheet's
 * (day-list.ts lightsCandles), so a reminder "at candle lighting" made with no day said lands on a day that has candles,
 * in the far north too. Empty where there is no place at all.
 */
export async function candleLightingDays(user: ZmanUser, zone: string, fromDay: string, spanDays: number): Promise<string[]> {
  const found = await placeFor(user, zone);
  if (!found) return [];
  const community = communityOfUser(user);
  const end = addDaysToDate(fromDay, spanDays);
  const blocks = restDayBlocks({ from: startOfLocalDay(fromDay, zone), to: startOfLocalDay(end, zone) }, found.place, community);
  const days: string[] = [];
  for (let day = fromDay; day < end; day = addDaysToDate(day, 1)) {
    if (lightsCandles(blocks, day)) days.push(day);
  }
  return days;
}

/** The editor's zmanim block: the community's zmanim a reminder may be set to, and today's time of each. */
export async function zmanEditorInfo(user: ZmanUser, zone: string, today: string): Promise<ZmanimInfo> {
  const community = communityOfUser(user);
  // Not waited for: a person whose place is still to be looked up gets the zone's main city for this load (the next one has theirs).
  const found = await placeFor(user, zone, true);
  const at = (spec: ZmanSpecValue) => (found ? (instantAt(found.place, community, today, spec)?.toISOString() ?? null) : null);
  return {
    community,
    place: found ? found.source : 'none',
    day: today,
    zmanim: zmanRows(found?.place ?? null, community, today, reminderZmanim(community)),
    hours: Array.from({ length: 12 }, (_, i) => at({ halachicHours: i + 1, offsetMin: 0 })),
  };
}

/**
 * The home's sun sheet: `day` (a civil date in `zone`) at the person's place under their community's set, as
 * day-list.ts zmanDayForPlace lists it (the rows, among them the Shabbat and Yom Tov rows the rest-day blocks give, and
 * the halachic hours), with where the times are counted. The place is the editor info's (placeFor in the background):
 * the sheet never waits on a lookup. A person with no place at all (a zone with no main city and no saved location) gets
 * `place: null` and no rows. Server only; the client words it.
 */
export async function zmanDayList(user: ZmanUser, zone: string, day: string): Promise<ZmanimListResponse> {
  const community = communityOfUser(user);
  const found = await placeFor(user, zone, true);
  if (!found) return { day, tz: zone, community, place: null, rows: [], hours: [] };
  const list = zmanDayForPlace(found.place, community, day);
  return {
    community: list.community,
    day: list.day,
    tz: list.tz,
    place: found.source === 'saved' ? { source: 'saved', name: (user.location ?? '').trim() } : { source: 'zone' },
    rows: list.rows,
    hours: list.hours,
  };
}
```

The changes from the old file:
- the memo (`MAX_ANSWERS`, `answers`), `instantAt`, `zmanRows`, `FROM_WINDOWS`, `STANDS_AT`, `orderOf` and the list body move to day-list.ts unchanged;
- `__resetZmanClockForTests` is re-exported, so smoke-native-reminders, smoke-zman-reminders and smoke-zmanim keep importing it from here;
- `candleLightingDays` reads `restDayBlocks` + `lightsCandles`;
- `zmanDayList` keeps its JSON key order (community, day, tz, place, rows, hours), so the route's body is byte-identical.

- [ ] **Step 8: zmanim-list.ts — the comment names the blocks**

In `src/lib/calendar-view/zmanim-list.ts`, replace lines 12-14:

```ts
 * The rows a day's list carries besides the set's own zmanim: the Shabbat and Yom Tov windows (the pause's, from
 * shabbatYomTovWindows) say on which days they fall, so the list and the pause agree on the days. The sheet draws them in
 * the accent. The pause begins at the eve's sunset (the set's plain sunset row) and ends at the end row; the candle
```

with:

```ts
 * The rows a day's list carries besides the set's own zmanim: the Shabbat and Yom Tov blocks (restDayBlocks, whose
 * complete ones are the pause's windows) say on which days they fall, so the list and the pause agree on the days; where
 * the sun makes no end (the far north in summer) the rows are still there and the end has no time. The sheet draws them in
 * the accent. The pause begins at the eve's sunset (the set's plain sunset row) and ends at the end row; the candle
```

(Comment only. The file stays client-safe and imports nothing new.)

- [ ] **Step 9: Run green, then the smokes that pin the moved code, the types and the lint**

Run the three commands from Step 4 again. Expected:
- smoke-zman-day-list: `14/14 passed` in each zone, then `3/3 process zones passed` (about 7 s).
- smoke-zmanim: `42/42 passed` in each zone, then `3/3 process zones passed`.
- smoke-zmanim-api: `24/24 passed` in each zone, then `3/3 process zones passed`.

Then run the smokes that use the moved code, each with the same `env ...` prefix: `scripts/smoke-zman-reminders.ts` (29/29 x3), `scripts/smoke-zman-voice.ts`, `scripts/smoke-native-reminders.ts` (92/92), `scripts/smoke-pause.ts` (19/19 x3), `scripts/smoke-dst.ts` (58/58), `scripts/smoke-zman-cards.ts`, `scripts/smoke-zmanim-sheet.ts` (23/23 x3), `scripts/smoke-native-reminder-digest.ts` (43/43), `scripts/smoke-zman-model.ts` (27/27) and `scripts/smoke-pause-subscription.ts` (5/5). Each exits 0. None needs an edit: the import paths they use (`reminder-times`' `__resetZmanClockForTests`, compute's functions) still resolve.

Then:

```bash
npx tsc --noEmit
npx eslint src/services/zmanim/compute.ts src/services/zmanim/day-list.ts src/services/zmanim/reminder-times.ts src/lib/calendar-view/zmanim-list.ts scripts/smoke-zman-day-list.ts scripts/smoke-zmanim.ts scripts/smoke-zmanim-api.ts
```

Both print nothing. Delete the `tsconfig.tsbuildinfo` that tsc writes if git shows it untracked.

Mutation checks that were run on the scratch copy (the controller may repeat them, then revert):
- dropping blocks with no end in `restDayBlocks` fails the three far-north checks;
- removing the back-extension loop fails "a block is listed whole";
- placing the end row by `localDate(block.end)` fails the Riga check;
- passing `{}` in place of `{ quiet: options.quiet }` in `instantAt` fails the memo-and-quiet check.

- [ ] **Step 10: Commit**

```bash
git add src/services/zmanim/compute.ts src/services/zmanim/day-list.ts src/services/zmanim/reminder-times.ts src/lib/calendar-view/zmanim-list.ts scripts/smoke-zman-day-list.ts scripts/smoke-zmanim.ts scripts/smoke-zmanim-api.ts
git commit -m "$(cat <<'EOF'
feat(zmanim): rest-day blocks and a pure day list at a place (6a Task 1)

compute.ts lists every Shabbat and Yom Tov block with its edges, null where the sun makes none (restDayBlocks); the
pause's windows are the complete blocks, unchanged (pinned against the old function over 400 days in Israel, New York
and Saint Petersburg). A quiet option stops the missing-zman warnings for callers that show the gap themselves.

day-list.ts holds the sun sheet's list with no person in it (zmanDayForPlace) and the memo, which a caller may replace
with its own; zmanDayList is the person's wrapper, row for row the same in Israel and New York. In the far north an eve
whose block has no end now lights its candles and the last day shows its end with no time, and an end after midnight
stays on its Saturday; candleLightingDays reads the same blocks.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
EOF
)"
```

CLAUDE.md's zmanim sentence ("its window rows come from `shabbatYomTovWindows`") is updated in Task 10, as the contract assigns. Until then it describes the complete blocks, which is still true of the pause.

### Task 2: Holidays by place — the `{ il }` option and the diaspora names

**Files:**
- Create: `scripts/smoke-holidays-by-place.ts`
- Modify: `src/services/hebrew-holidays.ts`: lines 1-6 (header), before line 21 (`HolidayOptions`), lines 180-185 and 193 (`holidaysInRange`), lines 232-236 and 247 (`nextHoliday`)
- Modify: `messages/en.json`, `messages/he.json`, `messages/ru.json`: after line 2580 (`pesachI`) and after line 2582 (`pesachVii`), in `holidays.names`
- Modify: `scripts/smoke-hebrew-holidays.ts`: lines 264-268 (the names-used check covers both schedules)
- Test: `scripts/smoke-holidays-by-place.ts`, `scripts/smoke-hebrew-holidays.ts`

**Interfaces:**
- Consumes: hebcal's `HebrewCalendar.calendar({ il })` (each event carries its IL_ONLY or CHUL_ONLY flag, and hebcal filters by `il` itself); the module's `holidayNameKey` slug rule
- Produces: `HolidayOptions = { il?: boolean }` (default true); `holidaysInRange(from, to, lang, options?)`; `nextHoliday(after, lang, maxDays?, options?)`; `holidays.names.pesachIi` and `holidays.names.pesachViii` in en, he and ru. Task 5 calls `holidaysInRange(first, last, locale, { il: inIsrael(city.timeZone) })`.

- [ ] **Step 1: Write the failing smoke `scripts/smoke-holidays-by-place.ts`**

The SHA-256 pins were taken at HEAD ef987cc1 by running the current module. They are the same under TZ=UTC, Asia/Jerusalem and America/New_York.

```ts
// Smoke test for the holidays by place (src/services/hebrew-holidays.ts, the { il } option of holidaysInRange and
// nextHoliday). Spec: docs/superpowers/specs/2026-10-30-public-zmanim-design.md §6.2; plan Task 2.
//
// What it pins:
//   - the default is the Israel schedule, byte for byte what it was before the option (SHA-256 of every day 2026-2030 in
//     en, he and ru, and of nextHoliday for every day of 2026-2027, taken at HEAD ef987cc1), and { il: true } is the same;
//   - { il: false } is the diaspora schedule: the second days of Sukkot 2026, Pesach 2027 and Shavuot 2027 are Yom Tov,
//     Simchat Torah is its own day, chol hamoed starts a day later, the four national days still show, and the summer
//     2027 portions diverge (Shavuot II on Shabbat, then Nasso a week later, through Chukat-Balak);
//   - the names: every holiday of both schedules 2026-2030 reads in Hebrew and Russian, the Russian never "Пэсах" and
//     never a Latin word of hebcal's (roman numerals aside); the two names FamCal writes for the diaspora days
//     (holidays.names.pesachIi, pesachViii) read "Песах" in Russian and mirror hebcal's own wording in en and he.
//
// Pure: no database, Redis, network or env, and nothing is stubbed. The day keys must not depend on the server's zone:
//   TZ=UTC npx tsx scripts/smoke-holidays-by-place.ts
//   TZ=Pacific/Kiritimati npx tsx scripts/smoke-holidays-by-place.ts

import crypto from 'node:crypto';
import Module from 'node:module';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');

// @hebcal/core is ESM-only and tsx loads src/ as CommonJS, so point it at its ESM build before the module under test loads.
const internals = Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string };
const resolveFilename = internals._resolveFilename;
internals._resolveFilename = function (request: string, ...rest: unknown[]) {
  if (request === '@hebcal/core') return path.resolve(ROOT, 'node_modules/@hebcal/core/dist/esm/index.js');
  return resolveFilename.call(this, request, ...rest);
};

type Holiday = { title: string; brief: string; chag: boolean; kind: string };
type Options = { il?: boolean };
type Mod = {
  holidaysInRange: (from: string, to: string, lang: string, options?: Options) => Record<string, Holiday[]>;
  nextHoliday: (after: string, lang: string, maxDays?: number, options?: Options) => { day: string; name: string } | null;
  holidayNameKey: (desc: string, locale: string) => { id: string; args: Record<string, string> };
};
type HebcalEvent = { getDesc(): string; render(locale: string): string; getDate(): { greg(): Date } };
/* eslint-disable @typescript-eslint/no-require-imports */
const { holidaysInRange, nextHoliday, holidayNameKey } = require('../src/services/hebrew-holidays') as Mod;
const { HebrewCalendar } = require('@hebcal/core') as { HebrewCalendar: { calendar: (options: object) => HebcalEvent[] } };
const messages = { en: require('../messages/en.json'), he: require('../messages/he.json'), ru: require('../messages/ru.json') } as Record<string, { holidays: { names: Record<string, string> } }>;
/* eslint-enable @typescript-eslint/no-require-imports */

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

const ABROAD: Options = { il: false };
const LANGS = ['en', 'he', 'ru'] as const;
const sha = (value: unknown): string => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** [title, kind] of each holiday on a day. */
const on = (day: string, lang: string, options?: Options): Array<[string, string]> => (holidaysInRange(day, day, lang, options)[day] ?? []).map(h => [h.title, h.kind]);
/** The portion's brief on a Saturday, or '' when that Shabbat has none. */
const portion = (day: string, lang: string, options?: Options): string => (holidaysInRange(day, day, lang, options)[day] ?? []).filter(h => h.kind === 'parasha').map(h => h.brief).join();

/** Taken at HEAD ef987cc1 (before the option): holidaysInRange('2026-01-01', '2030-12-31', lang), and nextHoliday(day, lang) for every day of 2026-2027. */
const HEAD_RANGE: Record<string, string> = {
  en: '6fcaa938e22e87c5d5dab2e65aabcbf9d1757dce9bfb5757e224ebb7c17c824e',
  he: '4fbbd7b8bf9db3605be177da8234a51a40f35ce520e718e7346a41ff33ab7066',
  ru: '8d307508a3ed48a68e6f59bcfa4e2bcd54e06cf5b0537171448f4fa7f88ae31f',
};
const HEAD_NEXT: Record<string, string> = {
  en: 'e52eac4a045371ceed7266ec63dbd0ff90d960bb5a4480a88ad1d4f87129417f',
  he: '8b96b36f98dcee69b976e849bdd7a36f7f75a6d0f0f18dc7aa7c980e005d4fd7',
  ru: '4639b9cfa63982c675432cff929470eb7242a2c745dbf0334ce70af428d2d8e2',
};

async function main() {
  await check('the default is the Israel schedule, byte for byte what it was (every day 2026-2030, and the next holiday from every day of 2026-2027, in en, he and ru), and { il: true } is the same', () => {
    for (const lang of LANGS) {
      const range = holidaysInRange('2026-01-01', '2030-12-31', lang);
      assertEqual(sha(range), HEAD_RANGE[lang], `${lang} holidaysInRange`);
      assertEqual(sha(holidaysInRange('2026-01-01', '2030-12-31', lang, { il: true })), HEAD_RANGE[lang], `${lang} { il: true }`);
      const nexts: unknown[] = [];
      for (let t = Date.UTC(2026, 0, 1); t <= Date.UTC(2027, 11, 31); t += 86_400_000) nexts.push(nextHoliday(new Date(t).toISOString().slice(0, 10), lang));
      assertEqual(sha(nexts), HEAD_NEXT[lang], `${lang} nextHoliday`);
    }
  });

  await check('Sukkot 2026 abroad: the second day (Sunday the 27th) is Yom Tov, and chol hamoed starts on the 28th with day III; in Israel the 27th is chol hamoed', () => {
    assertEqual(on('2026-09-26', 'en', ABROAD), [['Sukkot I', 'chag']], 'the first day');
    assertEqual(on('2026-09-27', 'en', ABROAD), [['Sukkot II', 'chag']], 'the second day');
    assertEqual(on('2026-09-27', 'he', ABROAD), [['סוכות ב׳', 'chag']], 'he');
    assertEqual(on('2026-09-27', 'ru', ABROAD), [['Суккот II', 'chag']], 'ru');
    assertEqual(on('2026-09-28', 'en', ABROAD), [['Sukkot III (CH’’M)', 'cholHamoed']], 'chol hamoed');
    assertEqual(on('2026-09-27', 'en'), [['Sukkot II (CH’’M)', 'cholHamoed']], 'Israel');
  });

  await check('Simchat Torah abroad is its own Yom Tov the day after Shemini Atzeret (Sunday 2026-10-04), and it is the next holiday after the Saturday; in Israel the day is plain and the next holiday is Chanukah', () => {
    assertEqual(on('2026-10-03', 'en', ABROAD), [['Shmini Atzeret', 'chag']], 'Shemini Atzeret');
    assertEqual(on('2026-10-04', 'en', ABROAD), [['Simchat Torah', 'chag']], 'en');
    assertEqual(on('2026-10-04', 'he', ABROAD), [['שמחת תורה', 'chag']], 'he');
    assertEqual(on('2026-10-04', 'ru', ABROAD), [['Симхат Тора', 'chag']], 'ru');
    assertEqual(on('2026-10-04', 'en'), [], 'Israel');
    assertEqual(nextHoliday('2026-10-03', 'en', undefined, ABROAD), { day: '2026-10-04', name: 'Simchat Torah' }, 'next abroad');
    assertEqual(nextHoliday('2026-10-03', 'en'), { day: '2026-12-05', name: 'Chanukah' }, 'next in Israel');
  });

  await check('Pesach 2027 abroad: the second day (Friday the 23rd) and the eighth (Thursday the 29th) are Yom Tov, named "Песах" in Russian; in Israel the 23rd is chol hamoed and the 29th is plain', () => {
    assertEqual(on('2027-04-23', 'en', ABROAD), [['Pesach II', 'chag']], 'en II');
    assertEqual(on('2027-04-23', 'he', ABROAD), [['פסח ב׳', 'chag']], 'he II');
    assertEqual(on('2027-04-23', 'ru', ABROAD), [['Песах II', 'chag']], 'ru II');
    assertEqual(on('2027-04-29', 'en', ABROAD), [['Pesach VIII', 'chag']], 'en VIII');
    assertEqual(on('2027-04-29', 'he', ABROAD), [['פסח ח׳', 'chag']], 'he VIII');
    assertEqual(on('2027-04-29', 'ru', ABROAD), [['Песах VIII', 'chag']], 'ru VIII');
    assertEqual(on('2027-04-24', 'en', ABROAD), [['Pesach III (CH’’M)', 'cholHamoed']], 'chol hamoed starts on Shabbat the 24th');
    assertEqual(on('2027-04-23', 'ru'), [['Песах II (холь а-моэд)', 'cholHamoed']], 'Israel: chol hamoed');
    assertEqual(on('2027-04-29', 'en'), [], 'Israel: the eighth day is plain');
    assertEqual(nextHoliday('2027-04-28', 'ru', undefined, ABROAD), { day: '2027-04-29', name: 'Песах' }, 'the countdown\'s base name');
  });

  await check('Shavuot 2027 abroad is two days (Friday the 11th and Shabbat the 12th, which has no portion); in Israel it is one day and Shabbat reads Nasso', () => {
    assertEqual(on('2027-06-11', 'en', ABROAD), [['Shavuot I', 'chag']], 'the first day');
    assertEqual(on('2027-06-12', 'en', ABROAD), [['Shavuot II', 'chag']], 'the second day, no portion');
    assertEqual(on('2027-06-12', 'he', ABROAD), [['שבועות ב׳', 'chag']], 'he');
    assertEqual(on('2027-06-12', 'ru', ABROAD), [['Шавуот II', 'chag']], 'ru');
    assertEqual(on('2027-06-11', 'en'), [['Shavuot', 'chag']], 'Israel');
    assertEqual(on('2027-06-12', 'en'), [['Parashat Nasso', 'parasha']], 'Israel reads Nasso');
  });

  await check('the summer 2027 portions diverge abroad after Shavuot II and meet again with Chukat-Balak on 17 July', () => {
    const saturdays: Array<[string, string, string]> = [
      ['2027-06-12', 'Nasso', ''],
      ['2027-06-19', 'Beha’alotcha', 'Nasso'],
      ['2027-06-26', 'Sh’lach', 'Beha’alotcha'],
      ['2027-07-03', 'Korach', 'Sh’lach'],
      ['2027-07-10', 'Chukat', 'Korach'],
      ['2027-07-17', 'Balak', 'Chukat-Balak'],
      ['2027-07-24', 'Pinchas', 'Pinchas'],
    ];
    for (const [day, israel, abroad] of saturdays) {
      assertEqual(portion(day, 'en'), israel, `${day} Israel`);
      assertEqual(portion(day, 'en', ABROAD), abroad, `${day} abroad`);
    }
    assertEqual(portion('2027-07-17', 'he', ABROAD), 'חוקת-בלק', 'he');
    assertEqual(portion('2027-07-17', 'ru', ABROAD), 'Хукат-Балак', 'ru');
  });

  await check('the four national days show abroad too (spec §2.9), and no other modern day does', () => {
    assertEqual(on('2027-05-04', 'en', ABROAD), [['Yom HaShoah', 'modern']], 'Yom HaShoah');
    assertEqual(on('2027-05-11', 'en', ABROAD), [['Yom HaZikaron', 'modern']], 'Yom HaZikaron');
    assertEqual(on('2027-05-12', 'en', ABROAD), [['Yom HaAtzma’ut', 'modern']], 'Yom HaAtzma\'ut');
    assertEqual(on('2027-06-04', 'en', ABROAD), [['Yom Yerushalayim', 'modern']], 'Yom Yerushalayim');
    const modern = Object.values(holidaysInRange('2026-01-01', '2030-12-31', 'en', ABROAD)).flat().filter(h => h.kind === 'modern').map(h => h.title);
    assertEqual([...new Set(modern)].sort(), ['Yom HaAtzma’ut', 'Yom HaShoah', 'Yom HaZikaron', 'Yom Yerushalayim'], 'only the four');
  });

  await check('every holiday title and brief of both schedules, 2026-2030, reads in Hebrew and Russian: no Latin word of hebcal\'s (roman numerals aside), and no Russian "Пэсах"', () => {
    const left: string[] = [];
    for (const options of [{ il: true }, ABROAD]) {
      for (const lang of ['he', 'ru']) {
        for (const [day, list] of Object.entries(holidaysInRange('2026-01-01', '2030-12-31', lang, options))) {
          for (const h of list) {
            for (const text of [h.title, h.brief]) {
              if (/[A-Za-z]/.test(text.replace(/\b[IVX]+\b/g, '')) || /Пэсах/.test(text)) left.push(`${options.il === false ? 'abroad' : 'Israel'} ${lang} ${day}: ${text}`);
            }
          }
        }
      }
    }
    assertEqual([...new Set(left)], [], 'titles that are not Hebrew or Russian');
  });

  await check('the diaspora days FamCal names (holidays.names.pesachIi, pesachViii) mirror hebcal\'s own wording in en and he, and are the ids the module\'s slug rule gives', () => {
    const wanted = new Map([['Pesach II', 'pesachIi'], ['Pesach VIII', 'pesachViii']]);
    const events = HebrewCalendar.calendar({ start: new Date(2027, 3, 20), end: new Date(2027, 3, 30), il: false }).filter(ev => wanted.has(ev.getDesc()));
    assertEqual(events.map(ev => ev.getDesc()), ['Pesach II', 'Pesach VIII'], 'hebcal has both');
    for (const ev of events) {
      const id = wanted.get(ev.getDesc()) ?? '';
      assertEqual(holidayNameKey(ev.getDesc(), 'en').id, id, `${ev.getDesc()} id`);
      assertEqual(messages.en.holidays.names[id], ev.render('en'), `en.${id}`);
      assertEqual(messages.he.holidays.names[id], ev.render('he-x-NoNikud'), `he.${id}`);
      assert(/^Песах /.test(messages.ru.holidays.names[id] ?? ''), `ru.${id}: ${messages.ru.holidays.names[id]}`);
    }
  });

  await check('the day keys abroad are the same under UTC, Asia/Jerusalem and Pacific/Kiritimati', () => {
    const original = process.env.TZ;
    try {
      const snapshots = ['UTC', 'Asia/Jerusalem', 'Pacific/Kiritimati'].map(zone => {
        process.env.TZ = zone;
        return JSON.stringify(LANGS.map(lang => holidaysInRange('2026-09-01', '2027-09-30', lang, ABROAD)));
      });
      assertEqual(snapshots[1] === snapshots[0] && snapshots[2] === snapshots[0], true, 'the same in every zone');
    } finally {
      if (original === undefined) delete process.env.TZ; else process.env.TZ = original;
    }
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

- [ ] **Step 2: Widen smoke-hebrew-holidays' names-used check to both schedules**

In `scripts/smoke-hebrew-holidays.ts`, replace lines 264-268:

```ts
  await check('every holidays.names entry is used by some holiday of the year, and en, he and ru hold the same ids', () => {
    // The countdown's base names (nextHoliday) read the same table: by the base name's id, or "<id>Base".
    // The portions and special Shabbatot too, over several years (the doubled weeks move with the year).
    const portions = [2026, 2027, 2028, 2029, 2030].flatMap(year => HebrewCalendar.calendar({ year, isHebrewYear: false, il: true, sedrot: true }).filter(ev => ev.getFlags() & (flags.PARSHA_HASHAVUA | flags.SPECIAL_SHABBAT)));
    const used = new Set([...hebcalYear(), ...portions].flatMap(ev => {
```

with:

```ts
  await check('every holidays.names entry is used by some holiday of the year (on either schedule), and en, he and ru hold the same ids', () => {
    // The countdown's base names (nextHoliday) read the same table: by the base name's id, or "<id>Base".
    // The portions and special Shabbatot too, over several years (the doubled weeks move with the year).
    const portions = [2026, 2027, 2028, 2029, 2030].flatMap(year => HebrewCalendar.calendar({ year, isHebrewYear: false, il: true, sedrot: true }).filter(ev => ev.getFlags() & (flags.PARSHA_HASHAVUA | flags.SPECIAL_SHABBAT)));
    // The diaspora's days too (holidaysInRange with { il: false }, the public zmanim pages abroad): Pesach II and VIII.
    const diaspora = [2026, 2027, 2028, 2029, 2030].flatMap(year => HebrewCalendar.calendar({ year, isHebrewYear: false, il: false, sedrot: true }));
    const used = new Set([...hebcalYear(), ...portions, ...diaspora].flatMap(ev => {
```

Without this change, Step 5's two new ids make the check fail with `ids no holiday uses: got ["pesachIi","pesachViii"]`.

- [ ] **Step 3: Run red**

```bash
env TZ=Asia/Jerusalem DATABASE_URL=postgresql://fake:fake@127.0.0.1:1/fake DIRECT_URL=postgresql://fake:fake@127.0.0.1:1/fake TELEGRAM_BOT_TOKEN=000000:fake WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 ENCRYPTION_KEY_PREVIOUS= NODE_ENV=development 'GOOGLE_TTS_CREDENTIALS={}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-holidays-by-place.ts
env TZ=Asia/Jerusalem DATABASE_URL=postgresql://fake:fake@127.0.0.1:1/fake DIRECT_URL=postgresql://fake:fake@127.0.0.1:1/fake TELEGRAM_BOT_TOKEN=000000:fake WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 ENCRYPTION_KEY_PREVIOUS= NODE_ENV=development 'GOOGLE_TTS_CREDENTIALS={}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-hebrew-holidays.ts
```

Expected (verified on a scratch copy of HEAD):
- smoke-holidays-by-place: exits 1 with `4/10 passed`. The option is ignored, so these six fail: Sukkot (`the second day: got [["Sukkot II (CH’’M)","cholHamoed"]]`), Simchat Torah (`en: got []`), Pesach (`en II: got [["Pesach II (CH’’M)","cholHamoed"]]`), Shavuot (`the first day: got [["Shavuot","chag"]]`), the portions (`2027-06-12 abroad: got "Nasso", want ""`) and the names (`en.pesachIi: got undefined`). The pins, the national days, the scan and the zones pass.
- smoke-hebrew-holidays: `21/21 passed` (the widened check holds before the names exist too).

- [ ] **Step 4: hebrew-holidays.ts — the option**

In `src/services/hebrew-holidays.ts`:

(a) Replace lines 1-6:

```ts
/**
 * The holidays of a day, computed in-process on @hebcal/core with the Israel schedule.
 *
 * One definition serves the bot's summaries (getHolidaysForDate) and the calendar home
 * (holidaysInRange, behind GET /api/calendar/holidays). Spec:
 * docs/superpowers/specs/2026-10-19-hebrew-holidays-design.md
```

with:

```ts
/**
 * The holidays of a day, computed in-process on @hebcal/core with the Israel schedule, or the
 * diaspora's where a caller asks for it ({ il: false }: the public zmanim pages of a city abroad,
 * docs/superpowers/specs/2026-10-30-public-zmanim-design.md §6.2).
 *
 * One definition serves the bot's summaries (getHolidaysForDate) and the calendar home
 * (holidaysInRange, behind GET /api/calendar/holidays), both on the Israel schedule. Spec:
 * docs/superpowers/specs/2026-10-19-hebrew-holidays-design.md
```

(b) Insert immediately before line 21 (`export type HolidayKind = ...`):

```ts
/**
 * Which schedule: `il` true (the default) is the Israel one, false the diaspora's (the second days of
 * Pesach, Shavuot and Sukkot, Simchat Torah, and the portions that follow from them).
 */
export type HolidayOptions = { il?: boolean };

```

(c) Replace lines 180-185:

```ts
/**
 * The holidays of each day from `from` to `to` (inclusive, yyyy-MM-dd, civil days), in a language.
 * Only days with a holiday have a key; a day's holidays are sorted by kind priority, then in
 * hebcal's order. A bad or reversed range gives {}.
 */
export function holidaysInRange(from: string, to: string, lang: string): Record<string, Holiday[]> {
```

with:

```ts
/**
 * The holidays of each day from `from` to `to` (inclusive, yyyy-MM-dd, civil days), in a language,
 * on the Israel schedule unless `options.il` is false. Only days with a holiday have a key; a day's
 * holidays are sorted by kind priority, then in hebcal's order. A bad or reversed range gives {}.
 */
export function holidaysInRange(from: string, to: string, lang: string, options: HolidayOptions = {}): Record<string, Holiday[]> {
```

and line 193 becomes:

```ts
  for (const ev of HebrewCalendar.calendar({ start: new HDate(start), end: new HDate(end), il: options.il ?? true, sedrot: true })) {
```

(d) Replace lines 232-236:

```ts
 * Chanukah, Purim, Tu BiShvat, Lag BaOmer, Tu B'Av or one of the four national days, on
 * the Israel schedule, looking ahead at most `maxDays` days. null when there is none, or
 * for a bad date.
 */
export function nextHoliday(after: string, lang: string, maxDays: number = NEXT_HOLIDAY_DAYS): NextHoliday | null {
```

with:

```ts
 * Chanukah, Purim, Tu BiShvat, Lag BaOmer, Tu B'Av or one of the four national days, on
 * the Israel schedule unless `options.il` is false, looking ahead at most `maxDays` days.
 * null when there is none, or for a bad date.
 */
export function nextHoliday(after: string, lang: string, maxDays: number = NEXT_HOLIDAY_DAYS, options: HolidayOptions = {}): NextHoliday | null {
```

and line 247 becomes:

```ts
  for (const ev of HebrewCalendar.calendar({ start: new HDate(start), end: new HDate(end), il: options.il ?? true })) {
```

`getHolidaysForDate`, `weekParashaFor` and `app/api/calendar/holidays/route.ts` are not touched: they pass nothing and keep the Israel schedule.

- [ ] **Step 5: The two diaspora names, in en, he and ru**

In each file's `holidays.names` (all three have `pesachI` at line 2580 and `pesachVii` at line 2582), add one line after `pesachI` and one after `pesachVii`:

`messages/en.json` (mirrors hebcal's own wording, as the module's en names do):

```json
      "pesachI": "Pesach I",
      "pesachIi": "Pesach II",
      "pesachSheni": "Pesach Sheni",
      "pesachVii": "Pesach VII",
      "pesachViii": "Pesach VIII",
```

`messages/he.json` (mirrors hebcal; the mark after the letter is the geresh U+05F3, as in `pesachI`):

```json
      "pesachI": "פסח א׳",
      "pesachIi": "פסח ב׳",
      "pesachSheni": "פסח שני",
      "pesachVii": "פסח ז׳",
      "pesachViii": "פסח ח׳",
```

`messages/ru.json` (hebcal writes «Пэсах II» and «Восьмой день Пэсах»; FamCal writes «Песах» with Roman numerals, as for I and VII):

```json
      "pesachI": "Песах I",
      "pesachIi": "Песах II",
      "pesachSheni": "Песах шени",
      "pesachVii": "Песах VII",
      "pesachViii": "Песах VIII",
```

None of the strings has a one-letter word or an em dash, so smoke-site-truth T6 asks no no-break space of them. No other diaspora id needs a name (Contract note 8).

- [ ] **Step 6: Run green, then the holiday smokes, the zones, the types and the lint**

Run the two commands from Step 3 again. Expected:
- smoke-holidays-by-place: `10/10 passed`.
- smoke-hebrew-holidays: `21/21 passed`.

Then run the new smoke under two more process zones. Each prints `10/10 passed`:

```bash
TZ=UTC npx tsx scripts/smoke-holidays-by-place.ts
TZ=Pacific/Kiritimati npx tsx scripts/smoke-holidays-by-place.ts
```

Then run, with the full `env ...` prefix: `scripts/smoke-parasha.ts` (14/14), `scripts/smoke-next-holiday.ts` (11/11), `scripts/smoke-calendar-home-copy.ts` (17/17), `scripts/smoke-summary-prompt-parity.ts` (17/17) and `scripts/smoke-digest-reader.ts` (30/30). All exit 0.

Then run these three. The first prints `i18n parity OK`, and the other two print nothing:

```bash
npx tsx scripts/check-i18n-parity.ts
npx tsc --noEmit
npx eslint src/services/hebrew-holidays.ts scripts/smoke-holidays-by-place.ts scripts/smoke-hebrew-holidays.ts
```

- [ ] **Step 7: Commit**

```bash
git add src/services/hebrew-holidays.ts messages/en.json messages/he.json messages/ru.json scripts/smoke-holidays-by-place.ts scripts/smoke-hebrew-holidays.ts
git commit -m "$(cat <<'EOF'
feat(holidays): the diaspora schedule on request (6a Task 2)

holidaysInRange and nextHoliday take an optional { il }, true by default: every existing caller passes nothing and gets
byte-identical output (pinned by hash over 2026-2030 in en, he and ru). With { il: false } the second days of Pesach,
Shavuot and Sukkot are Yom Tov, Simchat Torah is its own day and the summer portions follow the diaspora (Chukat-Balak
in 2027). Pesach II and VIII get FamCal's names: Russian «Песах», not hebcal's «Пэсах».

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
EOF
)"
```

> Every diff below is exact against HEAD `ef987cc1`; each one was applied (`git apply --check`) and its smokes run green in a throwaway copy of the repo. The full `bash scripts/ci-smokes.sh` there passed 157/159. The two failures, smoke-site-pages P2/P5 and smoke-site-seo S1 (`No "exports" main defined in …estree-walker`), happen the same way in an untouched copy of HEAD with node_modules symlinked, and both pass in the main checkout. Tasks 1 and 2 land first. Task 2 also edits `messages/*.json`, but only inside `holidays`, so Task 3's anchors (the `ui` block at the end of each file) still hold. If an earlier task has touched a hunk, make the same replacement by hand: every anchor is quoted.

### Task 3: City data (table, names, heights, Near me distance)

**Files:**
- Create: `src/site/cities.ts`, `src/site/near-city.ts`, `src/services/zmanim/elevation-grid.ts`, `scripts/build-city-heights.ts`, `scripts/smoke-cities.ts`
- Modify: `src/services/zmanim/place.ts` (lines 14-17 header comment, 26 import, 30-43 constants and `Coordinates`, 63-87 `elevationGrid`), `messages/en.json`, `messages/he.json`, `messages/ru.json` (the last 4 lines of each file: the end of `ui`), `scripts/smoke-he-neutral.ts` (lines 61-63, `ALLOWED`), `package.json` / `package-lock.json` (devDependency `geotiff`)
- Test: `scripts/smoke-cities.ts` (new); `scripts/smoke-zmanim.ts` (unchanged; its elevation-grid check, lines 790-831, goes through the re-export), `scripts/smoke-he-neutral.ts`, `scripts/smoke-ru-formal.ts`, `scripts/check-i18n-parity.ts`, `scripts/smoke-site-truth.ts`, `scripts/smoke-calendar-home-copy.ts`

**Interfaces:**
- Consumes: `inIsrael` (`src/utils/locale-rules.ts`), `instantToWallTime` (`src/utils/wall-time.ts`), `BoundingBox` type (`src/lib/timezone.ts`), `SELLER.email` (`src/lib/seller.ts`), `SITE_URL` (`src/site/config.ts`).
- Produces: `type City`, `CITIES: readonly City[]` (135 rows, Israel first), `cityBySlug(slug)`; `type NearCity`, `type NearAnswer`, `OPEN_KM = 30`, `NEAR_KM = 100`, `haversineKm(a, b)`, `utcOffsetMinutes(timeZone, at)` (throws RangeError for an unknown zone), `nearAnswer(position, deviceZone, at, cities)` (never throws: a missing or unknown device zone gives no "near" answer); messages `cities.<slug>` and `countries.<CC>` (40 codes) in en/he/ru; `elevationGrid`/`Coordinates` from `src/services/zmanim/elevation-grid.ts` (re-exported by `place.ts`).

- [ ] **Step 1: Write the failing smoke `scripts/smoke-cities.ts`.** It is pure (no database, Redis, network or env) and uses the repo's local `check()` / `assert()` harness, the same as smoke-zmanim-sheet's:

```ts
// Smoke test for the public zmanim pages' city data (spec docs/superpowers/specs/2026-10-30-public-zmanim-design.md §5,
// §4.1 and §9 "The city table"; plan docs/superpowers/plans/2026-10-30-public-zmanim.md, Task 3):
//   - src/site/cities.ts: the 135 rows of Appendix A, Israel first; unique lowercase ASCII slugs that no route takes;
//     a name for every slug and every country in en, he and ru (messages cities.* and countries.*); the zone is the
//     Israel flag (IL <=> inIsrael) and every zone is one Intl knows; an integer height in every Israeli row (written by
//     scripts/build-city-heights.ts) and none abroad; coordinates in range, at most 4 decimals;
//   - src/site/near-city.ts: the haversine distance, the UTC offset read from the zone's clock, and the three answers of
//     "Near me" (open within 30 km, near within 100 km in the same offset, else none) at concrete points, and with a
//     missing or odd device zone (review focus e: 30 km still opens by distance alone, and nothing throws);
//   - the layering: cities.ts imports nothing, near-city.ts only the pure clock reader, and the bot's elevationGrid lives
//     in the pure src/services/zmanim/elevation-grid.ts that place.ts re-exports (the heights script loads no database).
// Pure: no database, Redis, network or env.
//   npx tsx scripts/smoke-cities.ts

import fs from 'node:fs';
import path from 'node:path';
import { CITIES, cityBySlug, type City } from '../src/site/cities';
import { NEAR_KM, OPEN_KM, haversineKm, nearAnswer, utcOffsetMinutes } from '../src/site/near-city';
import { inIsrael } from '../src/utils/locale-rules';

const ROOT = path.resolve(__dirname, '..');
const LOCALES = ['en', 'he', 'ru'] as const;
type Locale = (typeof LOCALES)[number];
type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
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

const show = (value: unknown): string => JSON.stringify(value);
const readSource = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const messages = Object.fromEntries(LOCALES.map((l) => [l, JSON.parse(readSource(`messages/${l}.json`))])) as Record<Locale, { cities?: Record<string, unknown>; countries?: Record<string, unknown> }>;
/** The import lines of a file (comments dropped). */
const importsOf = (rel: string): string[] =>
  readSource(rel)
    .split('\n')
    .filter((l) => /^\s*(import|export)\b.*\bfrom\s+['"]/.test(l));
const city = (slug: string): City => {
  const found = cityBySlug(slug);
  assert(found, `no city ${slug}`);
  return found;
};
const at = (lat: number, lon: number) => ({ latitude: lat, longitude: lon });
const WINTER = new Date('2026-12-01T10:00:00Z');
const SUMMER = new Date('2026-07-01T10:00:00Z');
/** Degrees of latitude for `km` along a meridian, on near-city's Earth radius. */
const degreesFor = (km: number): number => ((km / 6371.0088) * 180) / Math.PI;

async function main() {
  await check('the table: 135 rows, the 51 Israeli cities first and then the 84 abroad, in the spec\'s order (Jerusalem first, Hong Kong last)', () => {
    assert(CITIES.length === 135, `${CITIES.length} rows`);
    const firstAbroad = CITIES.findIndex((c) => c.country !== 'IL');
    assert(firstAbroad === 51, `the first city abroad is row ${firstAbroad}`);
    assert(CITIES.slice(51).every((c) => c.country !== 'IL'), 'an Israeli row after the first city abroad');
    assert(CITIES[0].slug === 'jerusalem' && CITIES[50].slug === 'zichron-yaakov' && CITIES[51].slug === 'new-york' && CITIES[134].slug === 'hong-kong', show([CITIES[0].slug, CITIES[50].slug, CITIES[51].slug, CITIES[134].slug]));
  });

  await check('slugs: unique, lowercase ASCII words joined by single hyphens, never a locale or a route of the app (en, he, ru, dashboard, settings, admin); cityBySlug finds each row and nothing else', () => {
    const slugs = CITIES.map((c) => c.slug);
    assert(new Set(slugs).size === slugs.length, `duplicates: ${show(slugs.filter((s, i) => slugs.indexOf(s) !== i))}`);
    const bad = slugs.filter((s) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s));
    assert(bad.length === 0, `not lowercase ASCII: ${show(bad)}`);
    const reserved = slugs.filter((s) => ['en', 'he', 'ru', 'dashboard', 'settings', 'admin'].includes(s));
    assert(reserved.length === 0, `reserved: ${show(reserved)}`);
    for (const c of CITIES) assert(cityBySlug(c.slug) === c, `cityBySlug(${c.slug})`);
    for (const other of ['', 'Jerusalem', 'jerusalem ', 'brooklyn', 'toString', '__proto__']) assert(cityBySlug(other) === undefined, `cityBySlug(${show(other)}) found a city`);
  });

  await check('names: messages cities.* holds exactly the slugs and countries.* exactly the country codes, in en, he and ru, each a real name (Hebrew letters in he, Cyrillic in ru, no Latin letter in either)', () => {
    const slugs = CITIES.map((c) => c.slug).sort();
    const codes = [...new Set(CITIES.map((c) => c.country))].sort();
    assert(codes.length === 40, `${codes.length} countries`);
    const problems: string[] = [];
    for (const l of LOCALES) {
      for (const [ns, want] of [['cities', slugs], ['countries', codes]] as const) {
        const table = messages[l][ns] ?? {};
        const have = Object.keys(table).sort();
        if (show(have) !== show(want)) problems.push(`${l} ${ns}: missing ${show(want.filter((k) => !have.includes(k)))}, extra ${show(have.filter((k) => !want.includes(k)))}`);
        for (const [key, name] of Object.entries(table)) {
          if (typeof name !== 'string' || name.trim() !== name || name === '') problems.push(`${l} ${ns}.${key}: ${show(name)}`);
          else if (l === 'he' && (!/\p{Script=Hebrew}/u.test(name) || /[A-Za-z]/.test(name))) problems.push(`he ${ns}.${key} is not Hebrew: ${name}`);
          else if (l === 'ru' && (!/\p{Script=Cyrillic}/u.test(name) || /[A-Za-z]/.test(name))) problems.push(`ru ${ns}.${key} is not Russian: ${name}`);
          else if (l === 'en' && !/^[\p{Script=Latin} .,’-]+$/u.test(name)) problems.push(`en ${ns}.${key}: ${name}`);
        }
      }
    }
    assert(problems.length === 0, problems.join('; '));
    assert(messages.he.cities?.tiberias === 'טבריה' && messages.ru.cities?.tiberias === 'Тверия' && messages.ru.cities?.tzfat === 'Цфат' && messages.ru.cities?.['beer-sheva'] === 'Беэр-Шева', 'the Israeli names as Israelis write them');
  });

  await check('the zone is the Israel flag: country IL <=> inIsrael(zone), every Israeli row is Asia/Jerusalem (Judea and Samaria too), and no row uses an old spelling', () => {
    const wrong = CITIES.filter((c) => (c.country === 'IL') !== inIsrael(c.timeZone)).map((c) => c.slug);
    assert(wrong.length === 0, `IL and inIsrael disagree: ${show(wrong)}`);
    const notJerusalem = CITIES.filter((c) => c.country === 'IL' && c.timeZone !== 'Asia/Jerusalem').map((c) => c.slug);
    assert(notJerusalem.length === 0, show(notJerusalem));
    const old = CITIES.filter((c) => ['Europe/Kiev', 'Asia/Hebron', 'Asia/Gaza', 'Asia/Tel_Aviv', 'Israel', 'America/Buenos_Aires', 'Asia/Calcutta'].includes(c.timeZone)).map((c) => c.slug);
    assert(old.length === 0, `old spellings: ${show(old)}`);
    assert(city('kyiv').timeZone === 'Europe/Kyiv' && city('maale-adumim').timeZone === 'Asia/Jerusalem' && city('ariel').country === 'IL', 'Kyiv, Ma\'ale Adumim, Ariel');
  });

  await check('every zone is one Intl knows: new Intl.DateTimeFormat("en", { timeZone }) accepts it', () => {
    const refused: string[] = [];
    for (const c of CITIES) {
      try {
        new Intl.DateTimeFormat('en', { timeZone: c.timeZone });
      } catch {
        refused.push(`${c.slug}: ${c.timeZone}`);
      }
    }
    assert(refused.length === 0, show(refused));
  });

  await check('heights: every Israeli row has a whole number of metres from the heights script (Tiberias may be below sea level), no row abroad has one', () => {
    const missing = CITIES.filter((c) => c.country === 'IL' && !(Number.isInteger(c.elevationM) && (c.elevationM as number) >= -430 && (c.elevationM as number) <= 1200)).map((c) => `${c.slug}: ${c.elevationM}`);
    assert(missing.length === 0, `Israeli rows without a height (run npx tsx scripts/build-city-heights.ts): ${show(missing)}`);
    const abroad = CITIES.filter((c) => c.country !== 'IL' && c.elevationM !== null).map((c) => c.slug);
    assert(abroad.length === 0, `heights abroad: ${show(abroad)}`);
  });

  await check('coordinates: latitude in [-90, 90], longitude in [-180, 180], at most 4 decimals; the Israeli rows inside Israel\'s box; GeoNames ids are unique positive integers', () => {
    const bad: string[] = [];
    for (const c of CITIES) {
      if (!(c.latitude >= -90 && c.latitude <= 90) || !(c.longitude >= -180 && c.longitude <= 180)) bad.push(`${c.slug}: out of range`);
      if (Math.round(c.latitude * 1e4) / 1e4 !== c.latitude || Math.round(c.longitude * 1e4) / 1e4 !== c.longitude) bad.push(`${c.slug}: more than 4 decimals`);
      if (c.country === 'IL' && !(c.latitude > 29.4 && c.latitude < 33.4 && c.longitude > 34.2 && c.longitude < 35.9)) bad.push(`${c.slug}: outside Israel`);
      if (!Number.isInteger(c.geonameId) || c.geonameId <= 0) bad.push(`${c.slug}: geonameId ${c.geonameId}`);
    }
    assert(bad.length === 0, bad.join('; '));
    assert(new Set(CITIES.map((c) => c.geonameId)).size === CITIES.length, 'a GeoNames id is used twice');
    assert(show(city('jerusalem')) === show({ slug: 'jerusalem', geonameId: 281184, country: 'IL', latitude: 31.769, longitude: 35.2163, timeZone: 'Asia/Jerusalem', elevationM: city('jerusalem').elevationM }), `Jerusalem: ${show(city('jerusalem'))}`);
    assert(city('new-york').geonameId === 5128581 && city('saint-petersburg').latitude === 59.9386, 'New York and Saint Petersburg from GeoNames');
  });

  await check('the haversine distance: 0 from a point to itself, the same both ways, Jerusalem to Tel Aviv 53.8 km, New York to Lakewood 70.8 km', () => {
    const j = city('jerusalem');
    const t = city('tel-aviv');
    assert(haversineKm(j, j) === 0, 'to itself');
    assert(Math.abs(haversineKm(j, t) - haversineKm(t, j)) < 1e-9, 'both ways');
    assert(Math.abs(haversineKm(j, t) - 53.79) < 0.05, `Jerusalem to Tel Aviv: ${haversineKm(j, t)}`);
    assert(Math.abs(haversineKm(city('new-york'), city('lakewood')) - 70.84) < 0.05, `New York to Lakewood: ${haversineKm(city('new-york'), city('lakewood'))}`);
  });

  await check('the UTC offset is read from the zone\'s clock: Israel 120 in winter and 180 in summer, switching at 2026-10-24T23:00Z; New York -300, Kolkata 330, Kathmandu 345, St John\'s -210, Sydney 660 in December; an unknown zone throws RangeError', () => {
    const want: Array<[string, Date, number]> = [
      ['Asia/Jerusalem', WINTER, 120],
      ['Asia/Jerusalem', SUMMER, 180],
      ['Asia/Jerusalem', new Date('2026-10-24T22:59:59Z'), 180],
      ['Asia/Jerusalem', new Date('2026-10-24T23:00:00Z'), 120],
      ['America/New_York', WINTER, -300],
      ['Asia/Kolkata', WINTER, 330],
      ['Asia/Kathmandu', WINTER, 345],
      ['America/St_Johns', WINTER, -210],
      ['Australia/Sydney', WINTER, 660],
      ['Asia/Amman', WINTER, 180],
      ['Europe/Kyiv', WINTER, 120],
      ['UTC', new Date('2026-12-01T10:00:00.999Z'), 0],
    ];
    const wrong = want.filter(([zone, when, minutes]) => utcOffsetMinutes(zone, when) !== minutes).map(([zone, when, minutes]) => `${zone} ${when.toISOString()}: ${utcOffsetMinutes(zone, when)}, want ${minutes}`);
    assert(wrong.length === 0, wrong.join('; '));
    let thrown: unknown = null;
    try {
      utcOffsetMinutes('Not/AZone', WINTER);
    } catch (error) {
      thrown = error;
    }
    assert(thrown instanceof RangeError, `an unknown zone: ${String(thrown)}`);
  });

  await check('"Near me": within 30 km it opens the city (central Jerusalem); within 100 km and the same offset it names the city and the km (Mitzpe Ramon: Dimona, 56; Princeton: Lakewood, 48); far away it is none (Reykjavik); no city at all is none', () => {
    assert(OPEN_KM === 30 && NEAR_KM === 100, `${OPEN_KM} and ${NEAR_KM}`);
    assert(show(nearAnswer(at(31.778, 35.235), 'Asia/Jerusalem', WINTER, CITIES)) === show({ kind: 'open', slug: 'jerusalem' }), 'central Jerusalem');
    assert(show(nearAnswer(at(30.6094, 34.8011), 'Asia/Jerusalem', WINTER, CITIES)) === show({ kind: 'near', slug: 'dimona', km: 56 }), `Mitzpe Ramon: ${show(nearAnswer(at(30.6094, 34.8011), 'Asia/Jerusalem', WINTER, CITIES))}`);
    assert(show(nearAnswer(at(40.3573, -74.6672), 'America/New_York', WINTER, CITIES)) === show({ kind: 'near', slug: 'lakewood', km: 48 }), `Princeton: ${show(nearAnswer(at(40.3573, -74.6672), 'America/New_York', WINTER, CITIES))}`);
    assert(show(nearAnswer(at(64.1466, -21.9426), 'Atlantic/Reykjavik', WINTER, CITIES)) === show({ kind: 'none' }), 'Reykjavik');
    assert(show(nearAnswer(at(0, 0), 'UTC', WINTER, [])) === show({ kind: 'none' }), 'an empty list');
  });

  await check('"Near me" at the edges, south of Eilat (no other city near): 29.9 km opens it, 30.1 km and 99.9 km name it (30 and 100 km), 100.1 km is none', () => {
    const eilat = city('eilat');
    const south = (km: number) => at(eilat.latitude - degreesFor(km), eilat.longitude);
    const answers = [29.9, 30.1, 99.9, 100.1].map((km) => nearAnswer(south(km), 'Asia/Jerusalem', WINTER, CITIES));
    assert(
      show(answers) === show([{ kind: 'open', slug: 'eilat' }, { kind: 'near', slug: 'eilat', km: 30 }, { kind: 'near', slug: 'eilat', km: 100 }, { kind: 'none' }]),
      show(answers),
    );
  });

  await check('"Near me" in another offset is none: Amman (Asia/Amman, UTC+3 all year) is 64 km from Ma\'ale Adumim, none in December while Israel is on UTC+2, near in July when both are on UTC+3', () => {
    const amman = at(31.9552, 35.945);
    assert(show(nearAnswer(amman, 'Asia/Amman', WINTER, CITIES)) === show({ kind: 'none' }), `December: ${show(nearAnswer(amman, 'Asia/Amman', WINTER, CITIES))}`);
    assert(show(nearAnswer(amman, 'Asia/Amman', SUMMER, CITIES)) === show({ kind: 'near', slug: 'maale-adumim', km: 64 }), `July: ${show(nearAnswer(amman, 'Asia/Amman', SUMMER, CITIES))}`);
  });

  await check('"Near me" with a missing or odd device zone (review focus e: UTC while in Tel Aviv, empty, unknown, none at all): within 30 km it still opens the city, by distance alone; the near band needs a known zone in the city\'s offset, else none; nothing throws', () => {
    const telAviv = at(32.0809, 34.7806);
    const mitzpeRamon = at(30.6094, 34.8011);
    const reykjavik = at(64.1466, -21.9426);
    for (const zone of ['UTC', '', 'Not/AZone', 'garbage zone', undefined as unknown as string]) {
      let answers: unknown[] = [];
      try {
        answers = [nearAnswer(telAviv, zone, WINTER, CITIES), nearAnswer(mitzpeRamon, zone, WINTER, CITIES), nearAnswer(reykjavik, zone, WINTER, CITIES)];
      } catch (error) {
        throw new Error(`the device zone ${show(zone)} threw: ${String(error)}`);
      }
      assert(show(answers) === show([{ kind: 'open', slug: 'tel-aviv' }, { kind: 'none' }, { kind: 'none' }]), `the device zone ${show(zone)}: ${show(answers)}`);
    }
    assert(show(nearAnswer(mitzpeRamon, 'Asia/Jerusalem', WINTER, CITIES)) === show({ kind: 'near', slug: 'dimona', km: 56 }), 'a known zone in the city\'s offset still names it');
  });

  await check('the layering: cities.ts imports nothing; near-city.ts imports only the pure clock reader; elevation-grid.ts only a type; place.ts re-exports elevationGrid from it and defines none of its own', () => {
    assert(importsOf('src/site/cities.ts').length === 0, `cities.ts imports: ${show(importsOf('src/site/cities.ts'))}`);
    const near = importsOf('src/site/near-city.ts');
    assert(show(near) === show(["import { instantToWallTime } from '../utils/wall-time';"]), `near-city.ts imports: ${show(near)}`);
    assert(importsOf('src/utils/wall-time.ts').length === 0, 'wall-time.ts gained an import');
    const grid = importsOf('src/services/zmanim/elevation-grid.ts');
    assert(grid.length === 1 && /^import type \{ BoundingBox \} from '\.\.\/\.\.\/lib\/timezone';$/.test(grid[0]), `elevation-grid.ts imports: ${show(grid)}`);
    const place = readSource('src/services/zmanim/place.ts');
    assert(/export \{ elevationGrid, type Coordinates \} from '\.\/elevation-grid';/.test(place) && !/function elevationGrid\(/.test(place) && !/const GRID_SIDE/.test(place), 'place.ts still defines the grid');
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Run it red.**

```bash
env TZ=Asia/Jerusalem DATABASE_URL=postgresql://fake:fake@127.0.0.1:1/fake DIRECT_URL=postgresql://fake:fake@127.0.0.1:1/fake TELEGRAM_BOT_TOKEN=000000:fake WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 ENCRYPTION_KEY_PREVIOUS= NODE_ENV=development 'GOOGLE_TTS_CREDENTIALS={}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-cities.ts
```
Expected: the process exits 1 before any check runs, with `Error: Cannot find module '../src/site/cities'` (thrown from `scripts/smoke-cities.ts`).

- [ ] **Step 3: Move the elevation grid into a pure module.** Create `src/services/zmanim/elevation-grid.ts`. The code is moved verbatim from `place.ts` lines 31-43 and 63-87:

```ts
// Where a place's height is read: the bot's rule for "the highest point in the place" (Rav Ovadia's), a 5 x 5 grid over
// the place's Nominatim bounding box, each edge pulled in to at most 3 km from the centre. Pure, with a type-only
// import, so the bot (place.ts, which re-exports it) and the one-off scripts/build-city-heights.ts count it the same
// way without loading the database or Redis.

import type { BoundingBox } from '../../lib/timezone';

/** The grid is this many points on a side: 5 x 5 = 25, well under Open-Meteo's 100 per request. */
const GRID_SIDE = 5;
/** The grid reaches at most this far from the place's centre, in metres. */
const MAX_REACH_M = 3000;
const METRES_PER_DEGREE_LATITUDE = 111_320;

export interface Coordinates {
  latitude: number;
  longitude: number;
}

/**
 * The 25 points to ask the elevation of: a 5 x 5 grid over the place's bounding box, each edge
 * pulled in to at most 3 km from the centre. Just the centre where Nominatim sent no box.
 */
export function elevationGrid(centre: Coordinates, box: BoundingBox | null): Coordinates[] {
  if (!box) return [centre];
  const reachLatitude = MAX_REACH_M / METRES_PER_DEGREE_LATITUDE;
  const reachLongitude = MAX_REACH_M / (METRES_PER_DEGREE_LATITUDE * Math.max(Math.cos((centre.latitude * Math.PI) / 180), 0.01));
  const south = Math.max(box[0], centre.latitude - reachLatitude);
  const north = Math.min(box[1], centre.latitude + reachLatitude);
  const west = Math.max(box[2], centre.longitude - reachLongitude);
  const east = Math.min(box[3], centre.longitude + reachLongitude);
  if (!(south <= north && west <= east)) return [centre];
  const points: Coordinates[] = [];
  for (let row = 0; row < GRID_SIDE; row++) {
    for (let column = 0; column < GRID_SIDE; column++) {
      points.push({
        latitude: south + ((north - south) * row) / (GRID_SIDE - 1),
        longitude: west + ((east - west) * column) / (GRID_SIDE - 1),
      });
    }
  }
  return points;
}
```

Then edit `src/services/zmanim/place.ts`. It drops the `BoundingBox` import (nothing else there uses it), the three grid constants, `Coordinates` and `elevationGrid`, and imports and re-exports both from the new module. `RETRY_AFTER_MS` stays:

```diff
--- a/src/services/zmanim/place.ts
+++ b/src/services/zmanim/place.ts
@@ -12,8 +12,8 @@
  *   getUserPlace           a Place for compute.ts: coordinates (filled if need be) + the person's zone
  *
  * The elevation is the highest point in the place (Rav Ovadia's rule): a 5 x 5 grid over the
- * place's Nominatim bounding box, capped at 3 km around the centre, sampled with Open-Meteo's free
- * elevation API in one request; the highest of the 25 is kept. A failure of that request is
+ * place's Nominatim bounding box, capped at 3 km around the centre (elevationGrid, in the pure
+ * elevation-grid.ts), sampled with Open-Meteo's free elevation API in one request; the highest of the 25 is kept. A failure of that request is
  * logged and leaves the elevation null: it never blocks saving the place.
  *
  * The lookups are resolveLocation's (src/lib/timezone.ts) and the same 3 s, no-retry policy.
@@ -23,25 +23,19 @@
 import { redis } from '../../utils/redis';
 import { REDIS_KEYS } from '../../config/redis-keys';
 import { captureError, captureWarning } from '../../lib/error-capture';
-import { LOOKUP_TIMEOUT_MS, TIMEZONE_CACHE_TTL, resolveLocation, resolveUserTimezone, type BoundingBox } from '../../lib/timezone';
+import { LOOKUP_TIMEOUT_MS, TIMEZONE_CACHE_TTL, resolveLocation, resolveUserTimezone } from '../../lib/timezone';
 import { fetchWithTimeout } from '../weather/geocoding';
 import { invalidateDueGate } from '../native-reminders/due-gate';
 import { inIsrael } from '../../utils/locale-rules';
 import type { Place } from './compute';
+import { elevationGrid, type Coordinates } from './elevation-grid';
 
-/** The grid is this many points on a side: 5 x 5 = 25, well under Open-Meteo's 100 per request. */
-const GRID_SIDE = 5;
-/** The grid reaches at most this far from the place's centre, in metres. */
-const MAX_REACH_M = 3000;
-const METRES_PER_DEGREE_LATITUDE = 111_320;
+// The grid lives in the pure elevation-grid.ts, so scripts/build-city-heights.ts counts the public cities' heights by the same rule.
+export { elevationGrid, type Coordinates } from './elevation-grid';
+
 /** After a lazy fill finds nothing, the same person and place are not looked up again for this long. */
 const RETRY_AFTER_MS = 60 * 60 * 1000;
 
-export interface Coordinates {
-  latitude: number;
-  longitude: number;
-}
-
 /** The fields of a user the place is read from. `UserConfig` has all of them. */
 export interface PlaceUser {
   id: number;
@@ -61,31 +55,6 @@
 }
 
 /**
- * The 25 points to ask the elevation of: a 5 x 5 grid over the place's bounding box, each edge
- * pulled in to at most 3 km from the centre. Just the centre where Nominatim sent no box.
- */
-export function elevationGrid(centre: Coordinates, box: BoundingBox | null): Coordinates[] {
-  if (!box) return [centre];
-  const reachLatitude = MAX_REACH_M / METRES_PER_DEGREE_LATITUDE;
-  const reachLongitude = MAX_REACH_M / (METRES_PER_DEGREE_LATITUDE * Math.max(Math.cos((centre.latitude * Math.PI) / 180), 0.01));
-  const south = Math.max(box[0], centre.latitude - reachLatitude);
-  const north = Math.min(box[1], centre.latitude + reachLatitude);
-  const west = Math.max(box[2], centre.longitude - reachLongitude);
-  const east = Math.min(box[3], centre.longitude + reachLongitude);
-  if (!(south <= north && west <= east)) return [centre];
-  const points: Coordinates[] = [];
-  for (let row = 0; row < GRID_SIDE; row++) {
-    for (let column = 0; column < GRID_SIDE; column++) {
-      points.push({
-        latitude: south + ((north - south) * row) / (GRID_SIDE - 1),
-        longitude: west + ((east - west) * column) / (GRID_SIDE - 1),
-      });
-    }
-  }
-  return points;
-}
-
-/**
  * The highest ground among `points`, in whole metres, from one Open-Meteo request
  * (https://api.open-meteo.com/v1/elevation?latitude=a,b&longitude=x,y answers {"elevation":[m, m]}).
  * Null, and logged, when the request fails or answers no numbers.
```

Run `env TZ=Asia/Jerusalem DATABASE_URL=postgresql://fake:fake@127.0.0.1:1/fake DIRECT_URL=postgresql://fake:fake@127.0.0.1:1/fake TELEGRAM_BOT_TOKEN=000000:fake WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 ENCRYPTION_KEY_PREVIOUS= NODE_ENV=development 'GOOGLE_TTS_CREDENTIALS={}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-zmanim.ts`. Expected: `3/3 process zones passed` (42/42 in each). The check "the elevation grid: 5 x 5 over the bounding box…" still requires `place.elevationGrid`.

- [ ] **Step 4: Create `src/site/cities.ts`.** The values come from the GeoNames dump `cities5000.txt` (downloaded 2026-10-30): `geonameId`, latitude and longitude rounded to 4 decimals, and the zone. The 4 decimals are written out (31.7690), and smoke-cities compares them as numbers. Every Israeli row has `Asia/Jerusalem` and `country: 'IL'`, and every `elevationM` stays `null` until Step 9:

```ts
// The cities of the public zmanim pages (spec docs/superpowers/specs/2026-10-30-public-zmanim-design.md §5.1 and
// Appendix A): one row per city, Israel first, then the other countries in the spec's order. Plain data, client-safe: it
// imports nothing, so the "Near me" island can ship it.
//
// - slug: lowercase ASCII English, the same in every language. A slug never changes after launch, and rows are only
//   added (scripts/smoke-cities.ts pins the count).
// - geonameId, latitude and longitude (4 decimals) and timeZone: from the GeoNames dump (cities5000, 2026-10-30;
//   CC BY 4.0, credited on the zmanim pages). Every Israeli city has Asia/Jerusalem, Judea and Samaria included (never
//   Asia/Hebron): the zone is the engine's Israel flag (inIsrael), for the Yom Tov days, the height and the Sephardi end
//   of Shabbat. Zones are IANA names (Europe/Kyiv): compare a zone ICU resolved only after normalising it, since Node's
//   ICU may answer Europe/Kiev.
// - country: the ISO 3166 code; 'IL' for every Israeli city (GeoNames files Ma'ale Adumim and Beitar Illit under PS).
// - elevationM: the highest ground in an Israeli town, in whole metres, written by scripts/build-city-heights.ts by the
//   bot's own rule (elevationGrid over the town's OpenStreetMap box, read from the Copernicus DEM GLO-90). Null abroad,
//   where every set counts at sea level. A negative height (Tiberias) is kept as read; the engine clamps it to 0.
//
// The names are in messages: cities.<slug> and countries.<country>, in en, he and ru.

export type City = {
  slug: string;
  geonameId: number;
  country: string;
  latitude: number;
  longitude: number;
  timeZone: string;
  elevationM: number | null;
};

export const CITIES: readonly City[] = [
  // Israel (51)
  { slug: 'jerusalem', geonameId: 281184, country: 'IL', latitude: 31.7690, longitude: 35.2163, timeZone: 'Asia/Jerusalem', elevationM: null },
  { slug: 'tel-aviv', geonameId: 293397, country: 'IL', latitude: 32.0809, longitude: 34.7806, timeZone: 'Asia/Jerusalem', elevationM: null },
  { slug: 'haifa', geonameId: 294801, country: 'IL', latitude: 32.8130, longitude: 34.9993, timeZone: 'Asia/Jerusalem', elevationM: null },
  { slug: 'rishon-lezion', geonameId: 293703, country: 'IL', latitude: 31.9710, longitude: 34.7894, timeZone: 'Asia/Jerusalem', elevationM: null },
  { slug: 'petah-tikva', geonameId: 293918, country: 'IL', latitude: 32.0888, longitude: 34.8867, timeZone: 'Asia/Jerusalem', elevationM: null },
  { slug: 'ashdod', geonameId: 295629, country: 'IL', latitude: 31.7921, longitude: 34.6497, timeZone: 'Asia/Jerusalem', elevationM: null },
  { slug: 'netanya', geonameId: 294071, country: 'IL', latitude: 32.3329, longitude: 34.8592, timeZone: 'Asia/Jerusalem', elevationM: null },
  { slug: 'beer-sheva', geonameId: 295530, country: 'IL', latitude: 31.2518, longitude: 34.7913, timeZone: 'Asia/Jerusalem', elevationM: null },
  { slug: 'bnei-brak', geonameId: 295514, country: 'IL', latitude: 32.0807, longitude: 34.8338, timeZone: 'Asia/Jerusalem', elevationM: null },
  { slug: 'holon', geonameId: 294751, country: 'IL', latitude: 32.0122, longitude: 34.7783, timeZone: 'Asia/Jerusalem', elevationM: null },
  { slug: 'ramat-gan', geonameId: 293788, country: 'IL', latitude: 32.0823, longitude: 34.8107, timeZone: 'Asia/Jerusalem', elevationM: null },
  { slug: 'ashkelon', geonameId: 295620, country: 'IL', latitude: 31.6693, longitude: 34.5715, timeZone: 'Asia/Jerusalem', elevationM: null },
  { slug: 'rehovot', geonameId: 293725, country: 'IL', latitude: 31.8941, longitude: 34.8095, timeZone: 'Asia/Jerusalem', elevationM: null },
  { slug: 'bat-yam', geonameId: 295548, country: 'IL', latitude: 32.0180, longitude: 34.7500, timeZone: 'Asia/Jerusalem', elevationM: null },
  { slug: 'beit-shemesh', geonameId: 295432, country: 'IL', latitude: 31.7307, longitude: 34.9929, timeZone: 'Asia/Jerusalem', elevationM: null },
  { slug: 'kfar-saba', geonameId: 294514, country: 'IL', latitude: 32.1750, longitude: 34.9069, timeZone: 'Asia/Jerusalem', elevationM: null },
  { slug: 'herzliya', geonameId: 294778, country: 'IL', latitude: 32.1663, longitude: 34.8254, timeZone: 'Asia/Jerusalem', elevationM: null },
  { slug: 'hadera', geonameId: 294946, country: 'IL', latitude: 32.4419, longitude: 34.9039, timeZone: 'Asia/Jerusalem', elevationM: null },
  { slug: 'modiin', geonameId: 282926, country: 'IL', latitude: 31.8939, longitude: 35.0150, timeZone: 'Asia/Jerusalem', elevationM: null },
  { slug: 'lod', geonameId: 294421, country: 'IL', latitude: 31.9526, longitude: 34.8917, timeZone: 'Asia/Jerusalem', elevationM: null },
  { slug: 'ramla', geonameId: 293768, country: 'IL', latitude: 31.9262, longitude: 34.8635, timeZone: 'Asia/Jerusalem', elevationM: null },
  { slug: 'raanana', geonameId: 293807, country: 'IL', latitude: 32.1836, longitude: 34.8739, timeZone: 'Asia/Jerusalem', elevationM: null },
  { slug: 'nof-hagalil', geonameId: 294097, country: 'IL', latitude: 32.7082, longitude: 35.3247, timeZone: 'Asia/Jerusalem', elevationM: null },
  { slug: 'rosh-haayin', geonameId: 293690, country: 'IL', latitude: 32.0955, longitude: 34.9544, timeZone: 'Asia/Jerusalem', elevationM: null },
  { slug: 'afula', geonameId: 295740, country: 'IL', latitude: 32.6091, longitude: 35.2892, timeZone: 'Asia/Jerusalem', elevationM: null },
  { slug: 'kiryat-gat', geonameId: 293842, country: 'IL', latitude: 31.6100, longitude: 34.7642, timeZone: 'Asia/Jerusalem', elevationM: null },
  { slug: 'nahariya', geonameId: 294117, country: 'IL', latitude: 33.0089, longitude: 35.0981, timeZone: 'Asia/Jerusalem', elevationM: null },
  { slug: 'eilat', geonameId: 295277, country: 'IL', latitude: 29.5581, longitude: 34.9482, timeZone: 'Asia/Jerusalem', elevationM: null },
  { slug: 'tiberias', geonameId: 293322, country: 'IL', latitude: 32.7940, longitude: 35.5315, timeZone: 'Asia/Jerusalem', elevationM: null },
  { slug: 'tzfat', geonameId: 293100, country: 'IL', latitude: 32.9646, longitude: 35.4960, timeZone: 'Asia/Jerusalem', elevationM: null },
  { slug: 'karmiel', geonameId: 294577, country: 'IL', latitude: 32.9095, longitude: 35.2977, timeZone: 'Asia/Jerusalem', elevationM: null },
  { slug: 'akko', geonameId: 295721, country: 'IL', latitude: 32.9281, longitude: 35.0765, timeZone: 'Asia/Jerusalem', elevationM: null },
  { slug: 'maale-adumim', geonameId: 282993, country: 'IL', latitude: 31.7774, longitude: 35.2987, timeZone: 'Asia/Jerusalem', elevationM: null },
  { slug: 'modiin-illit', geonameId: 8199378, country: 'IL', latitude: 31.9322, longitude: 35.0442, timeZone: 'Asia/Jerusalem', elevationM: null },
  { slug: 'beitar-illit', geonameId: 284375, country: 'IL', latitude: 31.7000, longitude: 35.1167, timeZone: 'Asia/Jerusalem', elevationM: null },
  { slug: 'elad', geonameId: 8428480, country: 'IL', latitude: 32.0511, longitude: 34.9570, timeZone: 'Asia/Jerusalem', elevationM: null },
  { slug: 'dimona', geonameId: 295328, country: 'IL', latitude: 31.0708, longitude: 35.0327, timeZone: 'Asia/Jerusalem', elevationM: null },
  { slug: 'hod-hasharon', geonameId: 294760, country: 'IL', latitude: 32.1591, longitude: 34.8928, timeZone: 'Asia/Jerusalem', elevationM: null },
  { slug: 'nes-ziona', geonameId: 294074, country: 'IL', latitude: 31.9293, longitude: 34.7987, timeZone: 'Asia/Jerusalem', elevationM: null },
  { slug: 'kiryat-shmona', geonameId: 293825, country: 'IL', latitude: 33.2120, longitude: 35.5704, timeZone: 'Asia/Jerusalem', elevationM: null },
  { slug: 'ariel', geonameId: 8199394, country: 'IL', latitude: 32.1065, longitude: 35.1845, timeZone: 'Asia/Jerusalem', elevationM: null },
  { slug: 'kiryat-ata', geonameId: 293845, country: 'IL', latitude: 32.8115, longitude: 35.1132, timeZone: 'Asia/Jerusalem', elevationM: null },
  { slug: 'kiryat-motzkin', geonameId: 293831, country: 'IL', latitude: 32.8371, longitude: 35.0776, timeZone: 'Asia/Jerusalem', elevationM: null },
  { slug: 'kiryat-bialik', geonameId: 293844, country: 'IL', latitude: 32.8275, longitude: 35.0858, timeZone: 'Asia/Jerusalem', elevationM: null },
  { slug: 'kiryat-yam', geonameId: 293822, country: 'IL', latitude: 32.8497, longitude: 35.0697, timeZone: 'Asia/Jerusalem', elevationM: null },
  { slug: 'givatayim', geonameId: 294999, country: 'IL', latitude: 32.0722, longitude: 34.8125, timeZone: 'Asia/Jerusalem', elevationM: null },
  { slug: 'yavne', geonameId: 293222, country: 'IL', latitude: 31.8781, longitude: 34.7398, timeZone: 'Asia/Jerusalem', elevationM: null },
  { slug: 'netivot', geonameId: 294068, country: 'IL', latitude: 31.4230, longitude: 34.5891, timeZone: 'Asia/Jerusalem', elevationM: null },
  { slug: 'sderot', geonameId: 293619, country: 'IL', latitude: 31.5250, longitude: 34.5969, timeZone: 'Asia/Jerusalem', elevationM: null },
  { slug: 'harish', geonameId: 8141842, country: 'IL', latitude: 32.4618, longitude: 35.0455, timeZone: 'Asia/Jerusalem', elevationM: null },
  { slug: 'zichron-yaakov', geonameId: 293067, country: 'IL', latitude: 32.5688, longitude: 34.9543, timeZone: 'Asia/Jerusalem', elevationM: null },
  // Abroad (84)
  { slug: 'new-york', geonameId: 5128581, country: 'US', latitude: 40.7143, longitude: -74.0060, timeZone: 'America/New_York', elevationM: null },
  { slug: 'monsey', geonameId: 5127315, country: 'US', latitude: 41.1112, longitude: -74.0685, timeZone: 'America/New_York', elevationM: null },
  { slug: 'lakewood', geonameId: 5100280, country: 'US', latitude: 40.0979, longitude: -74.2176, timeZone: 'America/New_York', elevationM: null },
  { slug: 'boston', geonameId: 4930956, country: 'US', latitude: 42.3584, longitude: -71.0598, timeZone: 'America/New_York', elevationM: null },
  { slug: 'philadelphia', geonameId: 4560349, country: 'US', latitude: 39.9524, longitude: -75.1636, timeZone: 'America/New_York', elevationM: null },
  { slug: 'baltimore', geonameId: 4347778, country: 'US', latitude: 39.2904, longitude: -76.6122, timeZone: 'America/New_York', elevationM: null },
  { slug: 'washington-dc', geonameId: 4140963, country: 'US', latitude: 38.8951, longitude: -77.0364, timeZone: 'America/New_York', elevationM: null },
  { slug: 'cleveland', geonameId: 5150529, country: 'US', latitude: 41.4995, longitude: -81.6954, timeZone: 'America/New_York', elevationM: null },
  { slug: 'detroit', geonameId: 4990729, country: 'US', latitude: 42.3314, longitude: -83.0457, timeZone: 'America/Detroit', elevationM: null },
  { slug: 'chicago', geonameId: 4887398, country: 'US', latitude: 41.8500, longitude: -87.6500, timeZone: 'America/Chicago', elevationM: null },
  { slug: 'atlanta', geonameId: 4180439, country: 'US', latitude: 33.7490, longitude: -84.3880, timeZone: 'America/New_York', elevationM: null },
  { slug: 'miami', geonameId: 4164138, country: 'US', latitude: 25.7743, longitude: -80.1937, timeZone: 'America/New_York', elevationM: null },
  { slug: 'boca-raton', geonameId: 4148411, country: 'US', latitude: 26.3587, longitude: -80.0831, timeZone: 'America/New_York', elevationM: null },
  { slug: 'dallas', geonameId: 4684888, country: 'US', latitude: 32.7831, longitude: -96.8067, timeZone: 'America/Chicago', elevationM: null },
  { slug: 'houston', geonameId: 4699066, country: 'US', latitude: 29.7633, longitude: -95.3633, timeZone: 'America/Chicago', elevationM: null },
  { slug: 'denver', geonameId: 5419384, country: 'US', latitude: 39.7392, longitude: -104.9847, timeZone: 'America/Denver', elevationM: null },
  { slug: 'phoenix', geonameId: 5308655, country: 'US', latitude: 33.4484, longitude: -112.0740, timeZone: 'America/Phoenix', elevationM: null },
  { slug: 'los-angeles', geonameId: 5368361, country: 'US', latitude: 34.0522, longitude: -118.2437, timeZone: 'America/Los_Angeles', elevationM: null },
  { slug: 'san-francisco', geonameId: 5391959, country: 'US', latitude: 37.7749, longitude: -122.4194, timeZone: 'America/Los_Angeles', elevationM: null },
  { slug: 'toronto', geonameId: 6167865, country: 'CA', latitude: 43.7064, longitude: -79.3986, timeZone: 'America/Toronto', elevationM: null },
  { slug: 'montreal', geonameId: 6077243, country: 'CA', latitude: 45.5088, longitude: -73.5878, timeZone: 'America/Toronto', elevationM: null },
  { slug: 'ottawa', geonameId: 6094817, country: 'CA', latitude: 45.4112, longitude: -75.6981, timeZone: 'America/Toronto', elevationM: null },
  { slug: 'vancouver', geonameId: 6173331, country: 'CA', latitude: 49.2497, longitude: -123.1193, timeZone: 'America/Vancouver', elevationM: null },
  { slug: 'buenos-aires', geonameId: 3435910, country: 'AR', latitude: -34.6131, longitude: -58.3772, timeZone: 'America/Argentina/Buenos_Aires', elevationM: null },
  { slug: 'sao-paulo', geonameId: 3448439, country: 'BR', latitude: -23.5475, longitude: -46.6361, timeZone: 'America/Sao_Paulo', elevationM: null },
  { slug: 'rio-de-janeiro', geonameId: 3451190, country: 'BR', latitude: -22.9064, longitude: -43.1822, timeZone: 'America/Sao_Paulo', elevationM: null },
  { slug: 'santiago', geonameId: 3871336, country: 'CL', latitude: -33.4569, longitude: -70.6483, timeZone: 'America/Santiago', elevationM: null },
  { slug: 'montevideo', geonameId: 3441575, country: 'UY', latitude: -34.9033, longitude: -56.1882, timeZone: 'America/Montevideo', elevationM: null },
  { slug: 'mexico-city', geonameId: 3530597, country: 'MX', latitude: 19.4285, longitude: -99.1277, timeZone: 'America/Mexico_City', elevationM: null },
  { slug: 'panama-city', geonameId: 3703443, country: 'PA', latitude: 8.9936, longitude: -79.5197, timeZone: 'America/Panama', elevationM: null },
  { slug: 'london', geonameId: 2643743, country: 'GB', latitude: 51.5085, longitude: -0.1257, timeZone: 'Europe/London', elevationM: null },
  { slug: 'manchester', geonameId: 2643123, country: 'GB', latitude: 53.4809, longitude: -2.2374, timeZone: 'Europe/London', elevationM: null },
  { slug: 'gateshead', geonameId: 2648773, country: 'GB', latitude: 54.9621, longitude: -1.6017, timeZone: 'Europe/London', elevationM: null },
  { slug: 'paris', geonameId: 2988507, country: 'FR', latitude: 48.8534, longitude: 2.3488, timeZone: 'Europe/Paris', elevationM: null },
  { slug: 'marseille', geonameId: 2995469, country: 'FR', latitude: 43.2970, longitude: 5.3811, timeZone: 'Europe/Paris', elevationM: null },
  { slug: 'lyon', geonameId: 2996944, country: 'FR', latitude: 45.7491, longitude: 4.8479, timeZone: 'Europe/Paris', elevationM: null },
  { slug: 'nice', geonameId: 2990440, country: 'FR', latitude: 43.7031, longitude: 7.2661, timeZone: 'Europe/Paris', elevationM: null },
  { slug: 'strasbourg', geonameId: 2973783, country: 'FR', latitude: 48.5839, longitude: 7.7455, timeZone: 'Europe/Paris', elevationM: null },
  { slug: 'berlin', geonameId: 2950159, country: 'DE', latitude: 52.5244, longitude: 13.4105, timeZone: 'Europe/Berlin', elevationM: null },
  { slug: 'frankfurt', geonameId: 2925533, country: 'DE', latitude: 50.1155, longitude: 8.6842, timeZone: 'Europe/Berlin', elevationM: null },
  { slug: 'munich', geonameId: 2867714, country: 'DE', latitude: 48.1374, longitude: 11.5755, timeZone: 'Europe/Berlin', elevationM: null },
  { slug: 'vienna', geonameId: 2761369, country: 'AT', latitude: 48.2085, longitude: 16.3721, timeZone: 'Europe/Vienna', elevationM: null },
  { slug: 'budapest', geonameId: 3054643, country: 'HU', latitude: 47.4984, longitude: 19.0404, timeZone: 'Europe/Budapest', elevationM: null },
  { slug: 'prague', geonameId: 3067696, country: 'CZ', latitude: 50.0880, longitude: 14.4208, timeZone: 'Europe/Prague', elevationM: null },
  { slug: 'warsaw', geonameId: 756135, country: 'PL', latitude: 52.2298, longitude: 21.0118, timeZone: 'Europe/Warsaw', elevationM: null },
  { slug: 'amsterdam', geonameId: 2759794, country: 'NL', latitude: 52.3740, longitude: 4.8897, timeZone: 'Europe/Amsterdam', elevationM: null },
  { slug: 'brussels', geonameId: 2800866, country: 'BE', latitude: 50.8505, longitude: 4.3488, timeZone: 'Europe/Brussels', elevationM: null },
  { slug: 'antwerp', geonameId: 2803138, country: 'BE', latitude: 51.2205, longitude: 4.4003, timeZone: 'Europe/Brussels', elevationM: null },
  { slug: 'zurich', geonameId: 2657896, country: 'CH', latitude: 47.3667, longitude: 8.5500, timeZone: 'Europe/Zurich', elevationM: null },
  { slug: 'milan', geonameId: 3173435, country: 'IT', latitude: 45.4643, longitude: 9.1895, timeZone: 'Europe/Rome', elevationM: null },
  { slug: 'rome', geonameId: 3169070, country: 'IT', latitude: 41.8919, longitude: 12.5113, timeZone: 'Europe/Rome', elevationM: null },
  { slug: 'madrid', geonameId: 3117735, country: 'ES', latitude: 40.4165, longitude: -3.7026, timeZone: 'Europe/Madrid', elevationM: null },
  { slug: 'istanbul', geonameId: 745044, country: 'TR', latitude: 41.0138, longitude: 28.9497, timeZone: 'Europe/Istanbul', elevationM: null },
  { slug: 'moscow', geonameId: 524901, country: 'RU', latitude: 55.7520, longitude: 37.6178, timeZone: 'Europe/Moscow', elevationM: null },
  { slug: 'saint-petersburg', geonameId: 498817, country: 'RU', latitude: 59.9386, longitude: 30.3141, timeZone: 'Europe/Moscow', elevationM: null },
  { slug: 'kazan', geonameId: 551487, country: 'RU', latitude: 55.7887, longitude: 49.1221, timeZone: 'Europe/Moscow', elevationM: null },
  { slug: 'nizhny-novgorod', geonameId: 520555, country: 'RU', latitude: 56.3287, longitude: 44.0020, timeZone: 'Europe/Moscow', elevationM: null },
  { slug: 'rostov-on-don', geonameId: 501175, country: 'RU', latitude: 47.2200, longitude: 39.7077, timeZone: 'Europe/Moscow', elevationM: null },
  { slug: 'yekaterinburg', geonameId: 1486209, country: 'RU', latitude: 56.8573, longitude: 60.6153, timeZone: 'Asia/Yekaterinburg', elevationM: null },
  { slug: 'novosibirsk', geonameId: 1496747, country: 'RU', latitude: 55.0226, longitude: 82.9317, timeZone: 'Asia/Novosibirsk', elevationM: null },
  { slug: 'kyiv', geonameId: 703448, country: 'UA', latitude: 50.4547, longitude: 30.5238, timeZone: 'Europe/Kyiv', elevationM: null },
  { slug: 'dnipro', geonameId: 709930, country: 'UA', latitude: 48.4666, longitude: 35.0407, timeZone: 'Europe/Kyiv', elevationM: null },
  { slug: 'odesa', geonameId: 698740, country: 'UA', latitude: 46.4857, longitude: 30.7438, timeZone: 'Europe/Kyiv', elevationM: null },
  { slug: 'kharkiv', geonameId: 706483, country: 'UA', latitude: 49.9818, longitude: 36.2548, timeZone: 'Europe/Kyiv', elevationM: null },
  { slug: 'lviv', geonameId: 702550, country: 'UA', latitude: 49.8383, longitude: 24.0232, timeZone: 'Europe/Kyiv', elevationM: null },
  { slug: 'minsk', geonameId: 625144, country: 'BY', latitude: 53.9002, longitude: 27.5665, timeZone: 'Europe/Minsk', elevationM: null },
  { slug: 'riga', geonameId: 456172, country: 'LV', latitude: 56.9460, longitude: 24.1059, timeZone: 'Europe/Riga', elevationM: null },
  { slug: 'vilnius', geonameId: 593116, country: 'LT', latitude: 54.6892, longitude: 25.2798, timeZone: 'Europe/Vilnius', elevationM: null },
  { slug: 'chisinau', geonameId: 618426, country: 'MD', latitude: 47.0090, longitude: 28.8594, timeZone: 'Europe/Chisinau', elevationM: null },
  { slug: 'tbilisi', geonameId: 611717, country: 'GE', latitude: 41.6914, longitude: 44.8341, timeZone: 'Asia/Tbilisi', elevationM: null },
  { slug: 'baku', geonameId: 587084, country: 'AZ', latitude: 40.3777, longitude: 49.8920, timeZone: 'Asia/Baku', elevationM: null },
  { slug: 'almaty', geonameId: 1526384, country: 'KZ', latitude: 43.2525, longitude: 76.9115, timeZone: 'Asia/Almaty', elevationM: null },
  { slug: 'tashkent', geonameId: 1512569, country: 'UZ', latitude: 41.2647, longitude: 69.2163, timeZone: 'Asia/Tashkent', elevationM: null },
  { slug: 'sydney', geonameId: 2147714, country: 'AU', latitude: -33.8678, longitude: 151.2073, timeZone: 'Australia/Sydney', elevationM: null },
  { slug: 'melbourne', geonameId: 2158177, country: 'AU', latitude: -37.8140, longitude: 144.9633, timeZone: 'Australia/Melbourne', elevationM: null },
  { slug: 'perth', geonameId: 2063523, country: 'AU', latitude: -31.9522, longitude: 115.8614, timeZone: 'Australia/Perth', elevationM: null },
  { slug: 'johannesburg', geonameId: 993800, country: 'ZA', latitude: -26.2023, longitude: 28.0436, timeZone: 'Africa/Johannesburg', elevationM: null },
  { slug: 'cape-town', geonameId: 3369157, country: 'ZA', latitude: -33.9258, longitude: 18.4232, timeZone: 'Africa/Johannesburg', elevationM: null },
  { slug: 'casablanca', geonameId: 2553604, country: 'MA', latitude: 33.5883, longitude: -7.6114, timeZone: 'Africa/Casablanca', elevationM: null },
  { slug: 'limassol', geonameId: 146384, country: 'CY', latitude: 34.6841, longitude: 33.0379, timeZone: 'Asia/Nicosia', elevationM: null },
  { slug: 'bangkok', geonameId: 1609350, country: 'TH', latitude: 13.7540, longitude: 100.5014, timeZone: 'Asia/Bangkok', elevationM: null },
  { slug: 'tokyo', geonameId: 1850147, country: 'JP', latitude: 35.6895, longitude: 139.6917, timeZone: 'Asia/Tokyo', elevationM: null },
  { slug: 'dubai', geonameId: 292223, country: 'AE', latitude: 25.0772, longitude: 55.3093, timeZone: 'Asia/Dubai', elevationM: null },
  { slug: 'hong-kong', geonameId: 1819729, country: 'HK', latitude: 22.2783, longitude: 114.1747, timeZone: 'Asia/Hong_Kong', elevationM: null },
];

const BY_SLUG: ReadonlyMap<string, City> = new Map(CITIES.map((city) => [city.slug, city]));

/** The city a URL names; undefined for any other slug (the page answers the site's 404). */
export function cityBySlug(slug: string): City | undefined {
  return BY_SLUG.get(slug);
}
```

Source notes (no action, for the reviewer). The Israeli ids are the populated GeoNames records: Tel Aviv 293397, Petah Tikva 293918 ("Petaẖ Tiqva"), Beer Sheva 295530 ("Beersheba"), Modi'in 282926 ("Modi‘in Makkabbim Re‘ut"), Nof HaGalil 294097 ("Naẕerat ‘Illit"), Akko 295721 ("Acre"), Tzfat 293100 ("Safed"), Ma'ale Adumim 282993 (filed PS), Beitar Illit 284375 (filed PS, named "Battir", the only record with Beitar Illit's names). Abroad: New York 5128581 ("New York City"), Washington 4140963, Lakewood 5100280 (NJ), Frankfurt 2925533 ("Frankfurt am Main"), Nizhny Novgorod 520555 ("Nizhniy Novgorod"). Detroit has its own IANA zone, `America/Detroit`, and Buenos Aires the canonical `America/Argentina/Buenos_Aires`. Kyiv is `Europe/Kyiv` (Node 26's ICU resolves it to `Europe/Kiev`, so code never compares a resolved name against the table).

- [ ] **Step 5: Create `src/site/near-city.ts`:**

```ts
// "Near me" (spec docs/superpowers/specs/2026-10-30-public-zmanim-design.md §4.1): the nearest listed city to a position,
// found on the device. Client-safe: besides types it imports only the repo's pure clock reader (src/utils/wall-time.ts,
// itself import-free), so the island ships it with the city table, and the position never leaves the browser.
//
// The answer by distance to the nearest city:
//   - within OPEN_KM: that city's page opens;
//   - within NEAR_KM, and only when the city's UTC offset right now is the device's: the page names the city and how far
//     it is;
//   - otherwise none. A city near by in another offset (Amman runs an hour ahead of Israel in winter) is no answer: its
//     times would be read on the wrong clock. A device with no zone, or one Intl does not know, gets no "near" answer
//     either (its offset is unknown); the OPEN_KM band is by distance alone, and nothing here throws for an odd zone.

import { instantToWallTime } from '../utils/wall-time';

export type NearCity = { slug: string; latitude: number; longitude: number; timeZone: string };
export type NearAnswer = { kind: 'open'; slug: string } | { kind: 'near'; slug: string; km: number } | { kind: 'none' };

export const OPEN_KM = 30;
export const NEAR_KM = 100;
/** The mean Earth radius (IUGG), in km. */
const EARTH_RADIUS_KM = 6371.0088;

const radians = (degrees: number): number => (degrees * Math.PI) / 180;

/** The great-circle distance between two points in km, by the haversine formula on the mean Earth radius. */
export function haversineKm(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const dLatitude = radians(b.latitude - a.latitude);
  const dLongitude = radians(b.longitude - a.longitude);
  const h = Math.sin(dLatitude / 2) ** 2 + Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(dLongitude / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * `timeZone`'s offset from UTC at `at`, in minutes east (Israel: 120 in winter, 180 in summer; New York: -300 in winter),
 * read from the zone's clock by instantToWallTime. Throws RangeError for a zone Intl does not know.
 */
export function utcOffsetMinutes(timeZone: string, at: Date): number {
  const wall = instantToWallTime(at, timeZone);
  const [year, month, day, hour, minute, second] = wall.split(/[-T:]/).map(Number);
  const wholeSecond = at.getTime() - (((at.getTime() % 1000) + 1000) % 1000);
  return Math.round((Date.UTC(year, month - 1, day, hour, minute, second) - wholeSecond) / 60_000);
}

/**
 * The device zone's offset at `at`, or null where the browser gave no zone or one Intl does not know (an old or odd
 * browser): then no city is "near" by offset. Logged in the browser's own console, without the zone.
 */
function deviceOffset(deviceZone: string, at: Date): number | null {
  if (!deviceZone) return null;
  try {
    return utcOffsetMinutes(deviceZone, at);
  } catch (error) {
    console.warn('[near-me] the device\'s time zone is not one Intl knows: no "near" answer by offset', error instanceof Error ? error.name : 'unknown error');
    return null;
  }
}

/**
 * What "Near me" answers for `position`: the nearest of `cities` by haversine distance, then the bands above. `deviceZone`
 * is the browser's own zone (Intl.DateTimeFormat().resolvedOptions().timeZone) and `at` the moment of the tap; a missing
 * or unknown one gives no "near" answer, never a throw. `km` is rounded to whole kilometres. No city at all is none.
 */
export function nearAnswer(position: { latitude: number; longitude: number }, deviceZone: string, at: Date, cities: readonly NearCity[]): NearAnswer {
  let nearest: NearCity | null = null;
  let nearestKm = Infinity;
  for (const city of cities) {
    const km = haversineKm(position, city);
    if (km < nearestKm) {
      nearest = city;
      nearestKm = km;
    }
  }
  if (!nearest) return { kind: 'none' };
  if (nearestKm <= OPEN_KM) return { kind: 'open', slug: nearest.slug };
  const device = nearestKm <= NEAR_KM ? deviceOffset(deviceZone, at) : null;
  if (device !== null && utcOffsetMinutes(nearest.timeZone, at) === device) {
    return { kind: 'near', slug: nearest.slug, km: Math.round(nearestKm) };
  }
  return { kind: 'none' };
}
```

- [ ] **Step 6: Add the names to the messages.** Each file ends with the `ui` namespace. Append two top-level namespaces after it, leaving the rest of the file byte-identical: the arrays stay inline, so never rewrite a file through `JSON.stringify`. The Hebrew is as Israelis write it (קריית with two yods, as the spec lists it). The Russian is as Russian-speaking Israelis write it (Тверия, Цфат, Беэр-Шева, Киев, Кишинёв). No Russian name has a one-letter word or an em dash, so T6 needs no no-break space.

In `messages/en.json`, replace

```json
    "done": "Done",
    "cancel": "Cancel"
  }
}
```

with

```json
    "done": "Done",
    "cancel": "Cancel"
  },
  "cities": {
    "jerusalem": "Jerusalem",
    "tel-aviv": "Tel Aviv",
    "haifa": "Haifa",
    "rishon-lezion": "Rishon LeZion",
    "petah-tikva": "Petah Tikva",
    "ashdod": "Ashdod",
    "netanya": "Netanya",
    "beer-sheva": "Beer Sheva",
    "bnei-brak": "Bnei Brak",
    "holon": "Holon",
    "ramat-gan": "Ramat Gan",
    "ashkelon": "Ashkelon",
    "rehovot": "Rehovot",
    "bat-yam": "Bat Yam",
    "beit-shemesh": "Beit Shemesh",
    "kfar-saba": "Kfar Saba",
    "herzliya": "Herzliya",
    "hadera": "Hadera",
    "modiin": "Modi’in",
    "lod": "Lod",
    "ramla": "Ramla",
    "raanana": "Ra’anana",
    "nof-hagalil": "Nof HaGalil",
    "rosh-haayin": "Rosh HaAyin",
    "afula": "Afula",
    "kiryat-gat": "Kiryat Gat",
    "nahariya": "Nahariya",
    "eilat": "Eilat",
    "tiberias": "Tiberias",
    "tzfat": "Tzfat",
    "karmiel": "Karmiel",
    "akko": "Akko",
    "maale-adumim": "Ma’ale Adumim",
    "modiin-illit": "Modi’in Illit",
    "beitar-illit": "Beitar Illit",
    "elad": "Elad",
    "dimona": "Dimona",
    "hod-hasharon": "Hod HaSharon",
    "nes-ziona": "Nes Ziona",
    "kiryat-shmona": "Kiryat Shmona",
    "ariel": "Ariel",
    "kiryat-ata": "Kiryat Ata",
    "kiryat-motzkin": "Kiryat Motzkin",
    "kiryat-bialik": "Kiryat Bialik",
    "kiryat-yam": "Kiryat Yam",
    "givatayim": "Givatayim",
    "yavne": "Yavne",
    "netivot": "Netivot",
    "sderot": "Sderot",
    "harish": "Harish",
    "zichron-yaakov": "Zichron Ya’akov",
    "new-york": "New York",
    "monsey": "Monsey",
    "lakewood": "Lakewood",
    "boston": "Boston",
    "philadelphia": "Philadelphia",
    "baltimore": "Baltimore",
    "washington-dc": "Washington, D.C.",
    "cleveland": "Cleveland",
    "detroit": "Detroit",
    "chicago": "Chicago",
    "atlanta": "Atlanta",
    "miami": "Miami",
    "boca-raton": "Boca Raton",
    "dallas": "Dallas",
    "houston": "Houston",
    "denver": "Denver",
    "phoenix": "Phoenix",
    "los-angeles": "Los Angeles",
    "san-francisco": "San Francisco",
    "toronto": "Toronto",
    "montreal": "Montreal",
    "ottawa": "Ottawa",
    "vancouver": "Vancouver",
    "buenos-aires": "Buenos Aires",
    "sao-paulo": "São Paulo",
    "rio-de-janeiro": "Rio de Janeiro",
    "santiago": "Santiago",
    "montevideo": "Montevideo",
    "mexico-city": "Mexico City",
    "panama-city": "Panama City",
    "london": "London",
    "manchester": "Manchester",
    "gateshead": "Gateshead",
    "paris": "Paris",
    "marseille": "Marseille",
    "lyon": "Lyon",
    "nice": "Nice",
    "strasbourg": "Strasbourg",
    "berlin": "Berlin",
    "frankfurt": "Frankfurt",
    "munich": "Munich",
    "vienna": "Vienna",
    "budapest": "Budapest",
    "prague": "Prague",
    "warsaw": "Warsaw",
    "amsterdam": "Amsterdam",
    "brussels": "Brussels",
    "antwerp": "Antwerp",
    "zurich": "Zurich",
    "milan": "Milan",
    "rome": "Rome",
    "madrid": "Madrid",
    "istanbul": "Istanbul",
    "moscow": "Moscow",
    "saint-petersburg": "Saint Petersburg",
    "kazan": "Kazan",
    "nizhny-novgorod": "Nizhny Novgorod",
    "rostov-on-don": "Rostov-on-Don",
    "yekaterinburg": "Yekaterinburg",
    "novosibirsk": "Novosibirsk",
    "kyiv": "Kyiv",
    "dnipro": "Dnipro",
    "odesa": "Odesa",
    "kharkiv": "Kharkiv",
    "lviv": "Lviv",
    "minsk": "Minsk",
    "riga": "Riga",
    "vilnius": "Vilnius",
    "chisinau": "Chișinău",
    "tbilisi": "Tbilisi",
    "baku": "Baku",
    "almaty": "Almaty",
    "tashkent": "Tashkent",
    "sydney": "Sydney",
    "melbourne": "Melbourne",
    "perth": "Perth",
    "johannesburg": "Johannesburg",
    "cape-town": "Cape Town",
    "casablanca": "Casablanca",
    "limassol": "Limassol",
    "bangkok": "Bangkok",
    "tokyo": "Tokyo",
    "dubai": "Dubai",
    "hong-kong": "Hong Kong"
  },
  "countries": {
    "IL": "Israel",
    "US": "United States",
    "CA": "Canada",
    "AR": "Argentina",
    "BR": "Brazil",
    "CL": "Chile",
    "UY": "Uruguay",
    "MX": "Mexico",
    "PA": "Panama",
    "GB": "United Kingdom",
    "FR": "France",
    "DE": "Germany",
    "AT": "Austria",
    "HU": "Hungary",
    "CZ": "Czechia",
    "PL": "Poland",
    "NL": "Netherlands",
    "BE": "Belgium",
    "CH": "Switzerland",
    "IT": "Italy",
    "ES": "Spain",
    "TR": "Turkey",
    "RU": "Russia",
    "UA": "Ukraine",
    "BY": "Belarus",
    "LV": "Latvia",
    "LT": "Lithuania",
    "MD": "Moldova",
    "GE": "Georgia",
    "AZ": "Azerbaijan",
    "KZ": "Kazakhstan",
    "UZ": "Uzbekistan",
    "AU": "Australia",
    "ZA": "South Africa",
    "MA": "Morocco",
    "CY": "Cyprus",
    "TH": "Thailand",
    "JP": "Japan",
    "AE": "United Arab Emirates",
    "HK": "Hong Kong"
  }
}
```

In `messages/he.json`, replace

```json
    "done": "סיום",
    "cancel": "ביטול"
  }
}
```

with

```json
    "done": "סיום",
    "cancel": "ביטול"
  },
  "cities": {
    "jerusalem": "ירושלים",
    "tel-aviv": "תל אביב",
    "haifa": "חיפה",
    "rishon-lezion": "ראשון לציון",
    "petah-tikva": "פתח תקווה",
    "ashdod": "אשדוד",
    "netanya": "נתניה",
    "beer-sheva": "באר שבע",
    "bnei-brak": "בני ברק",
    "holon": "חולון",
    "ramat-gan": "רמת גן",
    "ashkelon": "אשקלון",
    "rehovot": "רחובות",
    "bat-yam": "בת ים",
    "beit-shemesh": "בית שמש",
    "kfar-saba": "כפר סבא",
    "herzliya": "הרצליה",
    "hadera": "חדרה",
    "modiin": "מודיעין",
    "lod": "לוד",
    "ramla": "רמלה",
    "raanana": "רעננה",
    "nof-hagalil": "נוף הגליל",
    "rosh-haayin": "ראש העין",
    "afula": "עפולה",
    "kiryat-gat": "קריית גת",
    "nahariya": "נהריה",
    "eilat": "אילת",
    "tiberias": "טבריה",
    "tzfat": "צפת",
    "karmiel": "כרמיאל",
    "akko": "עכו",
    "maale-adumim": "מעלה אדומים",
    "modiin-illit": "מודיעין עילית",
    "beitar-illit": "ביתר עילית",
    "elad": "אלעד",
    "dimona": "דימונה",
    "hod-hasharon": "הוד השרון",
    "nes-ziona": "נס ציונה",
    "kiryat-shmona": "קריית שמונה",
    "ariel": "אריאל",
    "kiryat-ata": "קריית אתא",
    "kiryat-motzkin": "קריית מוצקין",
    "kiryat-bialik": "קריית ביאליק",
    "kiryat-yam": "קריית ים",
    "givatayim": "גבעתיים",
    "yavne": "יבנה",
    "netivot": "נתיבות",
    "sderot": "שדרות",
    "harish": "חריש",
    "zichron-yaakov": "זכרון יעקב",
    "new-york": "ניו יורק",
    "monsey": "מונסי",
    "lakewood": "לייקווד",
    "boston": "בוסטון",
    "philadelphia": "פילדלפיה",
    "baltimore": "בולטימור",
    "washington-dc": "וושינגטון",
    "cleveland": "קליבלנד",
    "detroit": "דטרויט",
    "chicago": "שיקגו",
    "atlanta": "אטלנטה",
    "miami": "מיאמי",
    "boca-raton": "בוקה רטון",
    "dallas": "דאלאס",
    "houston": "יוסטון",
    "denver": "דנבר",
    "phoenix": "פיניקס",
    "los-angeles": "לוס אנג׳לס",
    "san-francisco": "סן פרנסיסקו",
    "toronto": "טורונטו",
    "montreal": "מונטריאול",
    "ottawa": "אוטווה",
    "vancouver": "ונקובר",
    "buenos-aires": "בואנוס איירס",
    "sao-paulo": "סאו פאולו",
    "rio-de-janeiro": "ריו דה ז׳נרו",
    "santiago": "סנטיאגו",
    "montevideo": "מונטווידאו",
    "mexico-city": "מקסיקו סיטי",
    "panama-city": "פנמה סיטי",
    "london": "לונדון",
    "manchester": "מנצ׳סטר",
    "gateshead": "גייטסהד",
    "paris": "פריז",
    "marseille": "מרסיי",
    "lyon": "ליון",
    "nice": "ניס",
    "strasbourg": "שטרסבורג",
    "berlin": "ברלין",
    "frankfurt": "פרנקפורט",
    "munich": "מינכן",
    "vienna": "וינה",
    "budapest": "בודפשט",
    "prague": "פראג",
    "warsaw": "ורשה",
    "amsterdam": "אמסטרדם",
    "brussels": "בריסל",
    "antwerp": "אנטוורפן",
    "zurich": "ציריך",
    "milan": "מילאנו",
    "rome": "רומא",
    "madrid": "מדריד",
    "istanbul": "איסטנבול",
    "moscow": "מוסקבה",
    "saint-petersburg": "סנקט פטרבורג",
    "kazan": "קזאן",
    "nizhny-novgorod": "ניז׳ני נובגורוד",
    "rostov-on-don": "רוסטוב על הדון",
    "yekaterinburg": "יקטרינבורג",
    "novosibirsk": "נובוסיבירסק",
    "kyiv": "קייב",
    "dnipro": "דניפרו",
    "odesa": "אודסה",
    "kharkiv": "חרקוב",
    "lviv": "לבוב",
    "minsk": "מינסק",
    "riga": "ריגה",
    "vilnius": "וילנה",
    "chisinau": "קישינב",
    "tbilisi": "טביליסי",
    "baku": "באקו",
    "almaty": "אלמטי",
    "tashkent": "טשקנט",
    "sydney": "סידני",
    "melbourne": "מלבורן",
    "perth": "פרת׳",
    "johannesburg": "יוהנסבורג",
    "cape-town": "קייפטאון",
    "casablanca": "קזבלנקה",
    "limassol": "לימסול",
    "bangkok": "בנגקוק",
    "tokyo": "טוקיו",
    "dubai": "דובאי",
    "hong-kong": "הונג קונג"
  },
  "countries": {
    "IL": "ישראל",
    "US": "ארצות הברית",
    "CA": "קנדה",
    "AR": "ארגנטינה",
    "BR": "ברזיל",
    "CL": "צ׳ילה",
    "UY": "אורוגוואי",
    "MX": "מקסיקו",
    "PA": "פנמה",
    "GB": "בריטניה",
    "FR": "צרפת",
    "DE": "גרמניה",
    "AT": "אוסטריה",
    "HU": "הונגריה",
    "CZ": "צ׳כיה",
    "PL": "פולין",
    "NL": "הולנד",
    "BE": "בלגיה",
    "CH": "שווייץ",
    "IT": "איטליה",
    "ES": "ספרד",
    "TR": "טורקיה",
    "RU": "רוסיה",
    "UA": "אוקראינה",
    "BY": "בלארוס",
    "LV": "לטביה",
    "LT": "ליטא",
    "MD": "מולדובה",
    "GE": "גאורגיה",
    "AZ": "אזרבייג׳ן",
    "KZ": "קזחסטן",
    "UZ": "אוזבקיסטן",
    "AU": "אוסטרליה",
    "ZA": "דרום אפריקה",
    "MA": "מרוקו",
    "CY": "קפריסין",
    "TH": "תאילנד",
    "JP": "יפן",
    "AE": "איחוד האמירויות",
    "HK": "הונג קונג"
  }
}
```

In `messages/ru.json`, replace

```json
    "done": "Готово",
    "cancel": "Отмена"
  }
}
```

with

```json
    "done": "Готово",
    "cancel": "Отмена"
  },
  "cities": {
    "jerusalem": "Иерусалим",
    "tel-aviv": "Тель-Авив",
    "haifa": "Хайфа",
    "rishon-lezion": "Ришон-ле-Цион",
    "petah-tikva": "Петах-Тиква",
    "ashdod": "Ашдод",
    "netanya": "Нетания",
    "beer-sheva": "Беэр-Шева",
    "bnei-brak": "Бней-Брак",
    "holon": "Холон",
    "ramat-gan": "Рамат-Ган",
    "ashkelon": "Ашкелон",
    "rehovot": "Реховот",
    "bat-yam": "Бат-Ям",
    "beit-shemesh": "Бейт-Шемеш",
    "kfar-saba": "Кфар-Саба",
    "herzliya": "Герцлия",
    "hadera": "Хадера",
    "modiin": "Модиин",
    "lod": "Лод",
    "ramla": "Рамла",
    "raanana": "Раанана",
    "nof-hagalil": "Ноф-ха-Галиль",
    "rosh-haayin": "Рош-ха-Аин",
    "afula": "Афула",
    "kiryat-gat": "Кирьят-Гат",
    "nahariya": "Нахария",
    "eilat": "Эйлат",
    "tiberias": "Тверия",
    "tzfat": "Цфат",
    "karmiel": "Кармиэль",
    "akko": "Акко",
    "maale-adumim": "Маале-Адумим",
    "modiin-illit": "Модиин-Илит",
    "beitar-illit": "Бейтар-Илит",
    "elad": "Элад",
    "dimona": "Димона",
    "hod-hasharon": "Ход-ха-Шарон",
    "nes-ziona": "Нес-Циона",
    "kiryat-shmona": "Кирьят-Шмона",
    "ariel": "Ариэль",
    "kiryat-ata": "Кирьят-Ата",
    "kiryat-motzkin": "Кирьят-Моцкин",
    "kiryat-bialik": "Кирьят-Бялик",
    "kiryat-yam": "Кирьят-Ям",
    "givatayim": "Гиватаим",
    "yavne": "Явне",
    "netivot": "Нетивот",
    "sderot": "Сдерот",
    "harish": "Хариш",
    "zichron-yaakov": "Зихрон-Яаков",
    "new-york": "Нью-Йорк",
    "monsey": "Монси",
    "lakewood": "Лейквуд",
    "boston": "Бостон",
    "philadelphia": "Филадельфия",
    "baltimore": "Балтимор",
    "washington-dc": "Вашингтон",
    "cleveland": "Кливленд",
    "detroit": "Детройт",
    "chicago": "Чикаго",
    "atlanta": "Атланта",
    "miami": "Майами",
    "boca-raton": "Бока-Ратон",
    "dallas": "Даллас",
    "houston": "Хьюстон",
    "denver": "Денвер",
    "phoenix": "Финикс",
    "los-angeles": "Лос-Анджелес",
    "san-francisco": "Сан-Франциско",
    "toronto": "Торонто",
    "montreal": "Монреаль",
    "ottawa": "Оттава",
    "vancouver": "Ванкувер",
    "buenos-aires": "Буэнос-Айрес",
    "sao-paulo": "Сан-Паулу",
    "rio-de-janeiro": "Рио-де-Жанейро",
    "santiago": "Сантьяго",
    "montevideo": "Монтевидео",
    "mexico-city": "Мехико",
    "panama-city": "Панама",
    "london": "Лондон",
    "manchester": "Манчестер",
    "gateshead": "Гейтсхед",
    "paris": "Париж",
    "marseille": "Марсель",
    "lyon": "Лион",
    "nice": "Ницца",
    "strasbourg": "Страсбург",
    "berlin": "Берлин",
    "frankfurt": "Франкфурт",
    "munich": "Мюнхен",
    "vienna": "Вена",
    "budapest": "Будапешт",
    "prague": "Прага",
    "warsaw": "Варшава",
    "amsterdam": "Амстердам",
    "brussels": "Брюссель",
    "antwerp": "Антверпен",
    "zurich": "Цюрих",
    "milan": "Милан",
    "rome": "Рим",
    "madrid": "Мадрид",
    "istanbul": "Стамбул",
    "moscow": "Москва",
    "saint-petersburg": "Санкт-Петербург",
    "kazan": "Казань",
    "nizhny-novgorod": "Нижний Новгород",
    "rostov-on-don": "Ростов-на-Дону",
    "yekaterinburg": "Екатеринбург",
    "novosibirsk": "Новосибирск",
    "kyiv": "Киев",
    "dnipro": "Днепр",
    "odesa": "Одесса",
    "kharkiv": "Харьков",
    "lviv": "Львов",
    "minsk": "Минск",
    "riga": "Рига",
    "vilnius": "Вильнюс",
    "chisinau": "Кишинёв",
    "tbilisi": "Тбилиси",
    "baku": "Баку",
    "almaty": "Алматы",
    "tashkent": "Ташкент",
    "sydney": "Сидней",
    "melbourne": "Мельбурн",
    "perth": "Перт",
    "johannesburg": "Йоханнесбург",
    "cape-town": "Кейптаун",
    "casablanca": "Касабланка",
    "limassol": "Лимасол",
    "bangkok": "Бангкок",
    "tokyo": "Токио",
    "dubai": "Дубай",
    "hong-kong": "Гонконг"
  },
  "countries": {
    "IL": "Израиль",
    "US": "США",
    "CA": "Канада",
    "AR": "Аргентина",
    "BR": "Бразилия",
    "CL": "Чили",
    "UY": "Уругвай",
    "MX": "Мексика",
    "PA": "Панама",
    "GB": "Великобритания",
    "FR": "Франция",
    "DE": "Германия",
    "AT": "Австрия",
    "HU": "Венгрия",
    "CZ": "Чехия",
    "PL": "Польша",
    "NL": "Нидерланды",
    "BE": "Бельгия",
    "CH": "Швейцария",
    "IT": "Италия",
    "ES": "Испания",
    "TR": "Турция",
    "RU": "Россия",
    "UA": "Украина",
    "BY": "Беларусь",
    "LV": "Латвия",
    "LT": "Литва",
    "MD": "Молдова",
    "GE": "Грузия",
    "AZ": "Азербайджан",
    "KZ": "Казахстан",
    "UZ": "Узбекистан",
    "AU": "Австралия",
    "ZA": "ЮАР",
    "MA": "Марокко",
    "CY": "Кипр",
    "TH": "Таиланд",
    "JP": "Япония",
    "AE": "ОАЭ",
    "HK": "Гонконг"
  }
}
```

Then hold the Petah Tikva name in `scripts/smoke-he-neutral.ts`: its matcher reads "פתח" as the masculine imperative "open":

```diff
--- a/scripts/smoke-he-neutral.ts
+++ b/scripts/smoke-he-neutral.ts
@@ -60,6 +60,7 @@
  */
 const ALLOWED: Record<string, string> = {
   'bot.imageEvent.partsUnreadable': '"השאר" is the noun "the rest" ("עברתי על השאר", I went over the rest), not the imperative "leave"',
+  'cities.petah-tikva': '"פתח" is the first word of the city\'s name, Petah Tikva, not the imperative "open"',
 };
 
 const H = '\\u05D0-\\u05EA';
```

- [ ] **Step 7: Run the smoke; only the heights fail.**

```bash
env TZ=Asia/Jerusalem DATABASE_URL=postgresql://fake:fake@127.0.0.1:1/fake DIRECT_URL=postgresql://fake:fake@127.0.0.1:1/fake TELEGRAM_BOT_TOKEN=000000:fake WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 ENCRYPTION_KEY_PREVIOUS= NODE_ENV=development 'GOOGLE_TTS_CREDENTIALS={}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-cities.ts
```
Expected: `13/14 passed`. The one FAIL is `heights: every Israeli row has a whole number of metres…`, with `Israeli rows without a height (run npx tsx scripts/build-city-heights.ts): ["jerusalem: null","tel-aviv: null",…`. Also run `npx tsx scripts/check-i18n-parity.ts` (expected `i18n parity OK (…keys)`), `env TZ=Asia/Jerusalem DATABASE_URL=postgresql://fake:fake@127.0.0.1:1/fake DIRECT_URL=postgresql://fake:fake@127.0.0.1:1/fake TELEGRAM_BOT_TOKEN=000000:fake WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 ENCRYPTION_KEY_PREVIOUS= NODE_ENV=development 'GOOGLE_TTS_CREDENTIALS={}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-he-neutral.ts` (expected `4/4 passed`) and `env TZ=Asia/Jerusalem DATABASE_URL=postgresql://fake:fake@127.0.0.1:1/fake DIRECT_URL=postgresql://fake:fake@127.0.0.1:1/fake TELEGRAM_BOT_TOKEN=000000:fake WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 ENCRYPTION_KEY_PREVIOUS= NODE_ENV=development 'GOOGLE_TTS_CREDENTIALS={}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-ru-formal.ts` (expected `2/2 passed`).

- [ ] **Step 8: Add `geotiff` and write `scripts/build-city-heights.ts`.** `geotiff` is MIT-licensed. The current release on npm is 3.0.5 (checked 2026-10-30), and its package exports a `require` build, so tsx loads it as CommonJS. `tsc` checks `scripts/**` (tsconfig `include: **/*.ts`), so it must be a real devDependency:

```bash
npm install --save-dev geotiff@^3.0.5
```
Expected: `package.json` `devDependencies` gains `"geotiff": "^3.0.5"` (between `eslint-config-next` and `prettier`), and `package-lock.json` changes with it. Then create the script:

```ts
// The heights of the Israeli cities in src/site/cities.ts (spec docs/superpowers/specs/2026-10-30-public-zmanim-design.md
// §5.2), by the bot's own rule for "the highest point in the place": elevationGrid (src/services/zmanim/elevation-grid.ts)
// over the town's OpenStreetMap box, held to 3 km around the city's point, and the highest of those points, rounded.
//
// Run once, on a developer machine, never in CI or at runtime; the diff it makes to src/site/cities.ts is committed:
//   npx tsx scripts/build-city-heights.ts
//
// - The box: one Nominatim search per city (the city's Hebrew name from messages/he.json, then its English name), held
//   to a box around the city's GeoNames point and to settlements, taking the first result that is the town itself (a
//   search can rank a neighbourhood first), at one request a second with FamCal's User-Agent, as Nominatim's usage
//   policy asks (about 51 requests).
// - The heights: the Copernicus DEM GLO-90 tiles in AWS's public bucket (no account; a tile per whole degree,
//   Copernicus_DSM_COG_30_N<lat>_00_E<lon>_00_DEM), read by `geotiff` with range requests: one window per tile a town's
//   points fall in, and each point's own pixel.
// - A network step that fails (a reset, a closed socket) is tried again after 2, 4 and 8 s, and logged.
// - It stops with nothing written when a city is not found, is found more than 10 km from its point, or reads no height.
//   Only elevationM values of Israeli rows change; rows abroad keep null.

import fs from 'node:fs';
import path from 'node:path';
import { fromUrl, type GeoTIFFImage } from 'geotiff';
import { CITIES, type City } from '../src/site/cities';
import { haversineKm } from '../src/site/near-city';
import { SELLER } from '../src/lib/seller';
import { SITE_URL } from '../src/site/config';
import { elevationGrid, type Coordinates } from '../src/services/zmanim/elevation-grid';
import type { BoundingBox } from '../src/lib/timezone';

const ROOT = path.resolve(__dirname, '..');
const TABLE = path.join(ROOT, 'src/site/cities.ts');
const USER_AGENT = `FamCal/1.0 (${SITE_URL}; ${SELLER.email})`;
/** Nominatim's policy: at most one request a second. */
const NOMINATIM_GAP_MS = 1100;
/** How far a found town may be from the city's GeoNames point. */
const MAX_DRIFT_KM = 10;
/** The search box around the city's point, in degrees each way. */
const SEARCH_REACH_DEG = 0.15;
const TILES = 'https://copernicus-dem-90m.s3.amazonaws.com';
/** The kinds of result that are the town itself: a search may rank one of its neighbourhoods first (Kiryat Ata's). */
const TOWN_TYPES: ReadonlySet<string> = new Set(['city', 'town', 'village', 'municipality']);

type Names = { cities: Record<string, string> };
const names = (locale: 'en' | 'he'): Record<string, string> =>
  (JSON.parse(fs.readFileSync(path.join(ROOT, `messages/${locale}.json`), 'utf8')) as Names).cities;

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Nominatim's `boundingbox` ([south, north, west, east] as strings), or null when it is missing or not four numbers. */
function readBox(raw: unknown): BoundingBox | null {
  if (!Array.isArray(raw) || raw.length !== 4) return null;
  const box = raw.map((value) => parseFloat(String(value)));
  return box.every(Number.isFinite) ? (box as BoundingBox) : null;
}

let lastSearch = 0;

/** The town's box from one Nominatim search for `query` near the city: its first result that is a town. Null when there is none. */
async function searchBox(city: City, query: string): Promise<{ box: BoundingBox | null; driftKm: number; name: string } | null> {
  const wait = lastSearch + NOMINATIM_GAP_MS - Date.now();
  if (wait > 0) await pause(wait);
  lastSearch = Date.now();
  const viewbox = [city.longitude - SEARCH_REACH_DEG, city.latitude + SEARCH_REACH_DEG, city.longitude + SEARCH_REACH_DEG, city.latitude - SEARCH_REACH_DEG].join(',');
  const url = `https://nominatim.openstreetmap.org/search?${new URLSearchParams({ q: query, format: 'jsonv2', limit: '10', featureType: 'settlement', viewbox, bounded: '1' })}`;
  const response = await withRetry(`searching ${city.slug}`, () => fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'he' } }));
  if (!response.ok) throw new Error(`Nominatim answered ${response.status} for ${city.slug}`);
  const results = (await response.json()) as Array<{ lat: string; lon: string; addresstype?: string; boundingbox?: unknown; display_name?: string }>;
  const town = Array.isArray(results) ? results.find((result) => TOWN_TYPES.has(result.addresstype ?? '')) : undefined;
  if (!town) return null;
  const found = { latitude: parseFloat(town.lat), longitude: parseFloat(town.lon) };
  if (!Number.isFinite(found.latitude) || !Number.isFinite(found.longitude)) throw new Error(`Nominatim sent coordinates that are not numbers for ${city.slug}`);
  return { box: readBox(town.boundingbox), driftKm: haversineKm(city, found), name: `${town.display_name ?? ''} (${town.addresstype})` };
}

/** A network step that failed for no fault of the request (a reset, a closed socket): tried again after 2, 4 and 8 s. */
async function withRetry<T>(what: string, step: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await step();
    } catch (error) {
      if (attempt === 4) throw error;
      console.warn(`[city-heights] ${what} failed (attempt ${attempt}), trying again:`, error instanceof Error ? error.message : error);
      await pause(1000 * 2 ** attempt);
    }
  }
}

const tiles = new Map<string, GeoTIFFImage>();

/** The name of the GLO-90 tile that holds `point` (Israel only: north and east). */
function tileName(point: Coordinates): string {
  if (point.latitude < 0 || point.longitude < 0) throw new Error(`no tile rule for ${point.latitude},${point.longitude}`);
  return `Copernicus_DSM_COG_30_N${String(Math.floor(point.latitude)).padStart(2, '0')}_00_E${String(Math.floor(point.longitude)).padStart(3, '0')}_00_DEM`;
}

async function tile(name: string): Promise<GeoTIFFImage> {
  const known = tiles.get(name);
  if (known) return known;
  const image = await withRetry(`opening ${name}`, async () => (await fromUrl(`${TILES}/${name}/${name}.tif`)).getImage());
  tiles.set(name, image);
  return image;
}

/** The model's height at each point, in metres (the pixel that holds it): one window read per tile the points touch. */
async function heightsAt(points: Coordinates[]): Promise<number[]> {
  const byTile = new Map<string, number[]>();
  points.forEach((point, index) => byTile.set(tileName(point), [...(byTile.get(tileName(point)) ?? []), index]));
  const heights: number[] = new Array(points.length).fill(NaN);
  for (const [name, indexes] of byTile) {
    const image = await tile(name);
    const [originX, originY] = image.getOrigin();
    const [resolutionX, resolutionY] = image.getResolution();
    const pixel = (index: number) => ({
      x: Math.min(image.getWidth() - 1, Math.max(0, Math.floor((points[index].longitude - originX) / resolutionX))),
      y: Math.min(image.getHeight() - 1, Math.max(0, Math.floor((points[index].latitude - originY) / resolutionY))),
    });
    const pixels = indexes.map(pixel);
    const left = Math.min(...pixels.map((p) => p.x));
    const top = Math.min(...pixels.map((p) => p.y));
    const width = Math.max(...pixels.map((p) => p.x)) - left + 1;
    const height = Math.max(...pixels.map((p) => p.y)) - top + 1;
    const [band] = (await withRetry(`reading ${name}`, () => image.readRasters({ window: [left, top, left + width, top + height] }))) as unknown as [ArrayLike<number>];
    indexes.forEach((index, i) => {
      heights[index] = band[(pixels[i].y - top) * width + (pixels[i].x - left)];
    });
  }
  return heights;
}

async function heightOf(city: City, he: Record<string, string>, en: Record<string, string>): Promise<number> {
  const found = (await searchBox(city, he[city.slug])) ?? (await searchBox(city, en[city.slug]));
  if (!found) throw new Error(`Nominatim found no ${city.slug} near ${city.latitude},${city.longitude}`);
  if (found.driftKm > MAX_DRIFT_KM) throw new Error(`${city.slug}: Nominatim's ${found.name} is ${found.driftKm.toFixed(1)} km from the city's point`);
  const points = elevationGrid(city, found.box);
  const heights = (await heightsAt(points)).filter((m) => Number.isFinite(m) && m > -1000);
  if (heights.length === 0) throw new Error(`${city.slug}: the model read no height`);
  const highest = Math.round(Math.max(...heights));
  console.log(`[city-heights] ${city.slug}: ${highest} m (${points.length} points over ${found.box ? found.box.join(',') : 'no box'}; ${found.name})`);
  return highest;
}

async function main(): Promise<void> {
  const he = names('he');
  const en = names('en');
  const israel = CITIES.filter((city) => city.country === 'IL');
  const heights = new Map<string, number>();
  for (const city of israel) heights.set(city.slug, await heightOf(city, he, en));

  let table = fs.readFileSync(TABLE, 'utf8');
  for (const [slug, metres] of heights) {
    const row = new RegExp(`(\\{ slug: '${slug}',[^\\n]*elevationM: )(?:null|-?\\d+)( \\})`);
    if (!row.test(table)) throw new Error(`no row for ${slug} in src/site/cities.ts`);
    table = table.replace(row, `$1${metres}$2`);
  }
  fs.writeFileSync(TABLE, table);
  console.log(`[city-heights] wrote ${heights.size} heights to src/site/cities.ts`);
}

main().catch((error: unknown) => {
  console.error('[city-heights] stopped, nothing written:', error);
  process.exit(1);
});
```

Facts behind the script, verified 2026-10-30:
- `HEAD https://copernicus-dem-90m.s3.amazonaws.com/Copernicus_DSM_COG_30_N31_00_E035_00_DEM/Copernicus_DSM_COG_30_N31_00_E035_00_DEM.tif` answers 200, and so does the N29 E034 tile (Eilat). `COG_30` is the 90 m set (`COG_10` is 30 m). Israel's tiles are 1200 x 1200 pixels of 3 arc-seconds.
- A pixel read at a GeoNames point matches GeoNames' own `dem`: Jerusalem 791.8 m against 786, Safed 782.1 against 779, Beersheba 284.2 against 285.
- Nominatim's `jsonv2` search with `featureType=settlement`, a bounded `viewbox` and `limit=10` finds all 51 towns as `city` or `town` within 10 km of their points. Kiryat Ata's first hit is a neighbourhood (`קריית בנימין`, `suburb`), so the script takes the first result whose `addresstype` is a town.
- The repo's own Nominatim calls send `User-Agent: FamilyCalendarBot/1.0` (`src/lib/timezone.ts:59`). This script names FamCal and the contact the repo publishes (`SELLER.email`, privacy@famcal.bot), as Nominatim's policy asks.

- [ ] **Step 9: Run the heights script once.** The controller runs this step, on its own machine (Execution, B2). It needs the network: about 51 Nominatim requests at 1 a second, plus 6 tiles' range reads, so 1 to 2 minutes:

```bash
npx tsx scripts/build-city-heights.ts
```
Expected: 51 lines of `[city-heights] <slug>: <m> m (25 points over <box>; <town> (city|town))`, then `[city-heights] wrote 51 heights to src/site/cities.ts`. A line with `(1 points over no box…)` or any thrown error means nothing was written. Read the error, fix the cause, and run again. Check `git diff src/site/cities.ts`: exactly 51 lines change, each only `elevationM: null` turning into an integer, and the 84 rows abroad stay `null`. A test run on 2026-10-30 wrote the values below. OpenStreetMap edits can move a town's box, so a few metres of difference is normal. Look at that city's log line (which town it found) before you commit a value more than about 10 m away:

| slug | m |
|---|---|
| jerusalem | 828 |
| tel-aviv | 65 |
| haifa | 296 |
| rishon-lezion | 71 |
| petah-tikva | 76 |
| ashdod | 32 |
| netanya | 46 |
| beer-sheva | 372 |
| bnei-brak | 65 |
| holon | 54 |
| ramat-gan | 59 |
| ashkelon | 56 |
| rehovot | 78 |
| bat-yam | 42 |
| beit-shemesh | 528 |
| kfar-saba | 74 |
| herzliya | 81 |
| hadera | 34 |
| modiin | 300 |
| lod | 81 |
| ramla | 98 |
| raanana | 76 |
| nof-hagalil | 505 |
| rosh-haayin | 163 |
| afula | 167 |
| kiryat-gat | 159 |
| nahariya | 37 |
| eilat | 372 |
| tiberias | 211 |
| tzfat | 885 |
| karmiel | 475 |
| akko | 17 |
| maale-adumim | 644 |
| modiin-illit | 351 |
| beitar-illit | 786 |
| elad | 166 |
| dimona | 645 |
| hod-hasharon | 75 |
| nes-ziona | 69 |
| kiryat-shmona | 758 |
| ariel | 648 |
| kiryat-ata | 102 |
| kiryat-motzkin | 13 |
| kiryat-bialik | 12 |
| kiryat-yam | 12 |
| givatayim | 74 |
| yavne | 45 |
| netivot | 164 |
| sderot | 118 |
| harish | 155 |
| zichron-yaakov | 160 |

These are the bot's own rule: the highest of 25 points over the town's box, clipped to 3 km. That is why Eilat (372), Dimona (645), Kiryat Shmona (758) and Tiberias (211, Upper Tiberias) read high. Tiberias is positive here because the box reaches the upper town. A negative value, if one ever appears, is kept as read.

- [ ] **Step 10: Run green.**

```bash
env TZ=Asia/Jerusalem DATABASE_URL=postgresql://fake:fake@127.0.0.1:1/fake DIRECT_URL=postgresql://fake:fake@127.0.0.1:1/fake TELEGRAM_BOT_TOKEN=000000:fake WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 ENCRYPTION_KEY_PREVIOUS= NODE_ENV=development 'GOOGLE_TTS_CREDENTIALS={}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-cities.ts
```
Expected: `14/14 passed (process TZ=Asia/Jerusalem)` (the odd-zone check prints its `[near-me]` warnings; that is its expected log). Then run, each expected green as it was before the task: `env TZ=Asia/Jerusalem DATABASE_URL=postgresql://fake:fake@127.0.0.1:1/fake DIRECT_URL=postgresql://fake:fake@127.0.0.1:1/fake TELEGRAM_BOT_TOKEN=000000:fake WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 ENCRYPTION_KEY_PREVIOUS= NODE_ENV=development 'GOOGLE_TTS_CREDENTIALS={}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-zmanim.ts` (3/3 zones), `env TZ=Asia/Jerusalem DATABASE_URL=postgresql://fake:fake@127.0.0.1:1/fake DIRECT_URL=postgresql://fake:fake@127.0.0.1:1/fake TELEGRAM_BOT_TOKEN=000000:fake WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 ENCRYPTION_KEY_PREVIOUS= NODE_ENV=development 'GOOGLE_TTS_CREDENTIALS={}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-he-neutral.ts` (4/4), `env TZ=Asia/Jerusalem DATABASE_URL=postgresql://fake:fake@127.0.0.1:1/fake DIRECT_URL=postgresql://fake:fake@127.0.0.1:1/fake TELEGRAM_BOT_TOKEN=000000:fake WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 ENCRYPTION_KEY_PREVIOUS= NODE_ENV=development 'GOOGLE_TTS_CREDENTIALS={}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-ru-formal.ts` (2/2), `env TZ=Asia/Jerusalem DATABASE_URL=postgresql://fake:fake@127.0.0.1:1/fake DIRECT_URL=postgresql://fake:fake@127.0.0.1:1/fake TELEGRAM_BOT_TOKEN=000000:fake WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 ENCRYPTION_KEY_PREVIOUS= NODE_ENV=development 'GOOGLE_TTS_CREDENTIALS={}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-site-truth.ts` (6/6), `env TZ=Asia/Jerusalem DATABASE_URL=postgresql://fake:fake@127.0.0.1:1/fake DIRECT_URL=postgresql://fake:fake@127.0.0.1:1/fake TELEGRAM_BOT_TOKEN=000000:fake WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 ENCRYPTION_KEY_PREVIOUS= NODE_ENV=development 'GOOGLE_TTS_CREDENTIALS={}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-calendar-home-copy.ts` (17/17), `env TZ=Asia/Jerusalem DATABASE_URL=postgresql://fake:fake@127.0.0.1:1/fake DIRECT_URL=postgresql://fake:fake@127.0.0.1:1/fake TELEGRAM_BOT_TOKEN=000000:fake WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 ENCRYPTION_KEY_PREVIOUS= NODE_ENV=development 'GOOGLE_TTS_CREDENTIALS={}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-dst.ts` (3/3 zones), `npx tsc --noEmit` (no output), and `npx eslint src/site/cities.ts src/site/near-city.ts src/services/zmanim/elevation-grid.ts src/services/zmanim/place.ts scripts/build-city-heights.ts scripts/smoke-cities.ts scripts/smoke-he-neutral.ts` (no output). No other smoke reads these files, so nothing else needs updating.

- [ ] **Step 11: Commit.**

```bash
git add src/site/cities.ts src/site/near-city.ts src/services/zmanim/elevation-grid.ts src/services/zmanim/place.ts scripts/build-city-heights.ts scripts/smoke-cities.ts scripts/smoke-he-neutral.ts messages/en.json messages/he.json messages/ru.json package.json package-lock.json
git commit -m "$(cat <<'EOF'
feat(zmanim): the public pages' 135 cities, their names, Israeli heights and the Near me distance

src/site/cities.ts holds the spec's Appendix A from GeoNames (Israel first, every Israeli row Asia/Jerusalem),
with the Israeli heights from scripts/build-city-heights.ts (the bot's elevationGrid over each town's OpenStreetMap
box, read from Copernicus GLO-90). Names in cities.* and countries.* (en, he, ru). src/site/near-city.ts finds the
nearest city on the device: open within 30 km, near within 100 km in the same UTC offset, else none. elevationGrid
moves to the pure elevation-grid.ts, which place.ts re-exports.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
EOF
)"
```

(After running smokes in the worktree, run `npx prisma generate` in the main checkout: Running a smoke.)

### Task 4: Shared rows (ZmanimRows, the sheet's CSS in a plain module)

**Files:**
- Create: `components/app-ui/ZmanimRows.tsx`, `src/lib/calendar-view/zmanim-sheet-css.ts`
- Modify: `app/[locale]/(app)/dashboard/ZmanimSheet.tsx` (lines 21-22 header, 27 format import, 32-36 imports, 53-143 the CSS, 183-197 `rowText`/`isKey`, 242-268 the rows), `src/lib/calendar-view/zman-words.ts` (lines 9-12 the translator type, 15 and 25 the parameters), `scripts/smoke-zmanim-sheet.ts` (lines 1-3 and 22 header, 34 and 37 imports, 199 helpers, a new check before line 637), `scripts/smoke-zman-cards.ts` (lines 461-464), `scripts/smoke-zman-reminders.ts` (lines 616-617)
- Test: `scripts/smoke-zmanim-sheet.ts`, `scripts/smoke-zman-cards.ts`, `scripts/smoke-zman-reminders.ts`, `scripts/smoke-app-ui.ts` (unchanged)

**Interfaces:**
- Consumes: `formatTime` (`src/lib/calendar-view/format.ts`), `WINDOW_ROW_KEYS`, `formatHalachicHour`, `ZmanimListResponse`, `ZmanimListRow` (`src/lib/calendar-view/zmanim-list.ts`), `zmanName` (`src/lib/calendar-view/zman-words.ts`).
- Produces: `ZmanimRows({ list, locale, t }): ReactElement`, `type ZmanimRowsList`, `type ZmanimRowsProps` (`components/app-ui/ZmanimRows.tsx`); `ZMANIM_SHEET_CSS` (`src/lib/calendar-view/zmanim-sheet-css.ts`, still re-exported by `ZmanimSheet.tsx`); `export type ZmanWordsT = (key: string, values?: Record<string, string | number>) => string` (`zman-words.ts`). Task 6 renders `<ZmanimRows list={view.list} locale={locale} t={await getTranslations({ locale, namespace: 'calendarHome' })} />` and includes `ZMANIM_SHEET_CSS` in the site's stylesheet.

Which smoke lines read the moved code:
- `scripts/smoke-app-ui.ts:84` `import { ZMANIM_SHEET_CSS } from '../app/[locale]/(app)/dashboard/ZmanimSheet';` and `:867` (the class-clash map) stay **unchanged**, because the sheet re-exports the string. Its #6 (`:395-409`) now also scans `ZmanimRows.tsx`, whose imports (`react`, `@/src/lib/calendar-view/*`) are allowed.
- `scripts/smoke-zmanim-sheet.ts:37` `import { ZMANIM_SHEET_CSS, ZmanimSheet } from '../app/[locale]/(app)/dashboard/ZmanimSheet';` stays, and its CSS check (`:637-652`) reads the same string.
- `scripts/smoke-zman-cards.ts:461-464` reads `app/[locale]/(app)/dashboard/${file}.tsx` for `['EditorSheet', 'ItemRow', 'ItemSheet', 'ZmanimSheet']` and requires each to import `@/src/lib/calendar-view/zman-words`. The sheet no longer imports it, so the list names `components/app-ui/ZmanimRows.tsx` in its place.
- `scripts/smoke-zman-reminders.ts:616-617` (the server-only list) gains `ZmanimRows.tsx` and `zmanim-sheet-css.ts`.

- [ ] **Step 1: Write the failing smokes.** In `scripts/smoke-zmanim-sheet.ts`, add the imports, a markup serializer for the fake DOM, and a new check. The check renders `ZmanimRows` on the "server" with `createTranslator` (the shape `getTranslations` returns) and compares it with the mounted sheet's markup, in en, he and ru:

```diff
--- a/scripts/smoke-zmanim-sheet.ts
+++ b/scripts/smoke-zmanim-sheet.ts
@@ -1,5 +1,6 @@
 // Smoke test for the home's sun sheet (the zmanim list): the header's sun button (HomeHeader), the sheet
-// (app/[locale]/(app)/dashboard/ZmanimSheet.tsx) and its request (src/lib/calendar-view/zmanim-list.ts), with the real
+// (app/[locale]/(app)/dashboard/ZmanimSheet.tsx, its rows drawn by components/app-ui/ZmanimRows.tsx and its CSS in
+// src/lib/calendar-view/zmanim-sheet-css.ts) and its request (src/lib/calendar-view/zmanim-list.ts), with the real
 // messages in en, he (RTL) and ru, in real React (react-dom/client with act on scripts/lib/fake-dom.ts). The route behind
 // it is smoke-zmanim-api.ts's; the container's gate (the button only for the Jewish calendar, the sheet opened from it) is
 // smoke-calendar-home-render.ts's #126-#128.
@@ -19,6 +20,8 @@
 //   - the states: a request that fails (an answer, a network error, a thrown error) says so with Retry, which asks again;
 //     no saved place shows the editor's note with its way to Settings; no place at all shows the other note and no rows;
 //   - the request: the URL, the init data in the header only, and every way it can fail read as `failed` and logged;
+//   - the rows are one plain component (no 'use client', no hook), shared with the public city pages: rendered with a
+//     server's translator it gives the sheet's own markup, and the sheet re-exports the CSS module's string;
 //   - the sheet's CSS: nothing under 11 px, logical properties only, no hover, no colour literal, and only the contrast
 //     pairs the app's design smoke already holds; the header's room: the usual three buttons beside the day from 320 px.
 // React must log no warning. No network, no DB. Run under three process zones (this file re-runs itself as child
@@ -31,10 +34,13 @@
 import path from 'node:path';
 import React, { createElement, type ComponentProps, type ReactElement } from 'react';
 import { renderToString } from 'react-dom/server';
-import { NextIntlClientProvider } from 'next-intl';
+import { NextIntlClientProvider, createTranslator } from 'next-intl';
 import { HomeHeader } from '../app/[locale]/(app)/dashboard/HomeHeader';
 import { HOME_SHELL_CSS } from '../app/[locale]/(app)/dashboard/home-shell';
 import { ZMANIM_SHEET_CSS, ZmanimSheet } from '../app/[locale]/(app)/dashboard/ZmanimSheet';
+import { ZmanimRows } from '../components/app-ui/ZmanimRows';
+import { ZMANIM_SHEET_CSS as PLAIN_SHEET_CSS } from '../src/lib/calendar-view/zmanim-sheet-css';
+import type { ZmanWordsT } from '../src/lib/calendar-view/zman-words';
 import { APP_THEME_CSS } from '../components/app-ui/theme';
 import { APP_SCREEN_CSS } from '../components/app-ui/screen';
 import { formatDayLong } from '../src/lib/calendar-view/format';
@@ -196,6 +202,15 @@
   return { m: Object.assign(m, { closed, settings }) as Sheet, ...l };
 }
 const rowsOf = (m: Mounted) => byClass(m.container, 'ch-zl-row');
+/** React's escaping in renderToString, for text and attribute values. */
+const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
+/** A mounted node as markup, in the form renderToString writes it (attributes in the order React set them). */
+const markupOfNode = (node: FakeNode): string => {
+  if (node.nodeType === 3) return escapeHtml(node.textContent);
+  const e = node as FakeElement;
+  const attributes = [...e.attributes].map(([name, value]) => ` ${name}="${escapeHtml(value)}"`).join('');
+  return `<${e.localName}${attributes}>${e.childNodes.map(markupOfNode).join('')}</${e.localName}>`;
+};
 const rowKeys = (m: Mounted) => rowsOf(m).map((r) => r.getAttribute('data-zman'));
 const dateLine = (m: Mounted) => textOf(byClass(m.container, 'ch-zl-date')[0]);
 const titleOf = (m: Mounted) => textOf(elements(m.container).filter((e) => e.localName === 'h2')[0]);
@@ -632,6 +647,31 @@
     assert(messages.he.calendarHome.zmanimList.community.chabad === 'חב״ד' && messages.he.settings.zmanim.chabad === 'חב״ד', 'Hebrew Chabad');
     assert(messages.ru.settings.zmanim.sephardi.startsWith(messages.ru.calendarHome.zmanimList.community.sephardi) && messages.he.settings.zmanim.sephardi.startsWith(messages.he.calendarHome.zmanimList.community.sephardi), 'Sephardi');
     assert(messages.en.settings.zmanim.ashkenazi.startsWith(messages.en.calendarHome.zmanimList.community.ashkenazi), 'Ashkenazi');
+  });
+
+  await check('the rows are one plain component, shared with the public city pages: components/app-ui/ZmanimRows.tsx has no "use client", no hook and no next-intl import, the sheet draws its rows only through it, the CSS lives in src/lib/calendar-view/zmanim-sheet-css.ts (the sheet re-exports the same string), and rendered on a server with createTranslator over calendarHome it gives the markup the sheet shows (a window row, a dash, the hour line) in en, he and ru', async () => {
+    const plain = fs.readFileSync(path.join(ROOT, 'components/app-ui/ZmanimRows.tsx'), 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
+    assert(!/['"]use client['"]/.test(plain) && !/\buse[A-Z]\w*\(/.test(plain) && !/from 'next-intl'/.test(plain), 'ZmanimRows is not a plain component');
+    const sheet = fs.readFileSync(path.join(ROOT, 'app/[locale]/(app)/dashboard/ZmanimSheet.tsx'), 'utf8');
+    assert(/<ZmanimRows list=\{current\.list\} locale=\{locale\} t=\{t\} \/>/.test(sheet), 'the sheet does not draw ZmanimRows');
+    assert(!/ch-zl-rows|ch-zl-row\b|ch-zl-hours|zmanName\(/.test(sheet) && !/`\n\.ch-zl-/.test(sheet), 'the sheet still draws rows or holds CSS of its own');
+    assert(ZMANIM_SHEET_CSS === PLAIN_SHEET_CSS && PLAIN_SHEET_CSS.includes('.ch-zl-row {'), 'the sheet re-exports another string');
+    const friday = '2026-10-30';
+    const list = harish(friday, { rows: [row(friday, 'ALOT', null), row(friday, 'SOF_SHMA_GRA', '08:37', 'gra'), row(friday, 'CANDLE_LIGHTING', '16:33'), row(friday, 'SHKIA', '16:53')] });
+    for (const locale of LOCALES) {
+      const t = createTranslator({ locale, messages: messages[locale], namespace: 'calendarHome' }) as unknown as ZmanWordsT;
+      const server = renderToString(createElement(ZmanimRows, { list, locale, t })).replace(/<!-- -->/g, '');
+      const { m } = await openSheet(locale, () => ok(list), friday);
+      try {
+        const rows = byClass(m.container, 'ch-zl-rows')[0];
+        const hours = byClass(m.container, 'ch-zl-hours')[0];
+        const mounted = markupOfNode(rows) + markupOfNode(hours);
+        assert(server === mounted, `${locale}: the server's rows differ from the sheet's:\n${server}\n${mounted}`);
+        assert(/data-zman="CANDLE_LIGHTING"/.test(server) && /is-none/.test(server) && /ch-zl-hours/.test(server), `${locale}: the probe lacks a window row, a dash or the hour line`);
+      } finally {
+        m.unmount();
+      }
+    }
   });
 
   await check('the sheet\'s CSS: nothing under 11 px, every size in px, logical properties only, no hover, no colour literal; every colour is a theme token that exists, and its text pairs are ones the design smoke holds to 4.5:1', () => {
```

In `scripts/smoke-zman-cards.ts`:

```diff
--- a/scripts/smoke-zman-cards.ts
+++ b/scripts/smoke-zman-cards.ts
@@ -458,8 +458,9 @@
     let gone = false;
     try { readFileSync(path.join(ROOT, 'app/[locale]/(app)/dashboard/zman-words.ts'), 'utf8'); } catch { gone = true; }
     assert(gone, 'app/[locale]/(app)/dashboard/zman-words.ts is still there');
-    for (const file of ['EditorSheet', 'ItemRow', 'ItemSheet', 'ZmanimSheet']) {
-      const text = readFileSync(path.join(ROOT, `app/[locale]/(app)/dashboard/${file}.tsx`), 'utf8');
+    // The sun sheet's rows moved into components/app-ui/ZmanimRows.tsx (shared with the public city pages): it is the one that words them
+    for (const file of ['app/[locale]/(app)/dashboard/EditorSheet.tsx', 'app/[locale]/(app)/dashboard/ItemRow.tsx', 'app/[locale]/(app)/dashboard/ItemSheet.tsx', 'components/app-ui/ZmanimRows.tsx']) {
+      const text = readFileSync(path.join(ROOT, file), 'utf8');
       assert(text.includes("@/src/lib/calendar-view/zman-words") && !text.includes("'./zman-words'"), `${file} imports the old path`);
     }
     // One words path in the services: only the view helper builds a rule's words
```

In `scripts/smoke-zman-reminders.ts`:

```diff
--- a/scripts/smoke-zman-reminders.ts
+++ b/scripts/smoke-zman-reminders.ts
@@ -614,7 +614,8 @@
 
   await check('server only: no file the Mini App bundles imports the zmanim module (the client gets computed times in the DTO)', () => {
     const files = ['app/[locale]/(app)/dashboard/EditorSheet.tsx', 'app/[locale]/(app)/dashboard/ItemRow.tsx', 'app/[locale]/(app)/dashboard/ItemSheet.tsx', 'src/lib/calendar-view/zman-words.ts', 'app/[locale]/(app)/dashboard/CalendarHome.tsx',
-      'src/lib/calendar-view/editor-model.ts', 'src/lib/calendar-view/editor-types.ts', 'src/lib/calendar-view/editor-client.ts', 'src/lib/calendar-view/types.ts', 'src/lib/calendar-view/zman-spec.ts'];
+      'src/lib/calendar-view/editor-model.ts', 'src/lib/calendar-view/editor-types.ts', 'src/lib/calendar-view/editor-client.ts', 'src/lib/calendar-view/types.ts', 'src/lib/calendar-view/zman-spec.ts',
+      'components/app-ui/ZmanimRows.tsx', 'src/lib/calendar-view/zmanim-sheet-css.ts'];
     for (const file of files) {
       const text = readFileSync(path.join(ROOT, file), 'utf8');
       assert(!/services\/zmanim|@hebcal/.test(text.split('\n').filter((l) => /^\s*(import|export)\b.*from/.test(l)).join('\n')), `${file} imports the zmanim module`);
```

- [ ] **Step 2: Run them red.**

```bash
env TZ=Asia/Jerusalem DATABASE_URL=postgresql://fake:fake@127.0.0.1:1/fake DIRECT_URL=postgresql://fake:fake@127.0.0.1:1/fake TELEGRAM_BOT_TOKEN=000000:fake WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 ENCRYPTION_KEY_PREVIOUS= NODE_ENV=development 'GOOGLE_TTS_CREDENTIALS={}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-zmanim-sheet.ts
```
Expected: each of the three process zones fails at load with `Error: Cannot find module '../components/app-ui/ZmanimRows'`, ending `0/3 process zones passed (UTC, Asia/Jerusalem, America/New_York)`.

```bash
env TZ=Asia/Jerusalem DATABASE_URL=postgresql://fake:fake@127.0.0.1:1/fake DIRECT_URL=postgresql://fake:fake@127.0.0.1:1/fake TELEGRAM_BOT_TOKEN=000000:fake WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 ENCRYPTION_KEY_PREVIOUS= NODE_ENV=development 'GOOGLE_TTS_CREDENTIALS={}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-zman-cards.ts
```
Expected: `FAIL  the words moved to src/lib/calendar-view/zman-words.ts: …` with `ENOENT: no such file or directory, open '…/components/app-ui/ZmanimRows.tsx'`, in each zone. `env TZ=Asia/Jerusalem DATABASE_URL=postgresql://fake:fake@127.0.0.1:1/fake DIRECT_URL=postgresql://fake:fake@127.0.0.1:1/fake TELEGRAM_BOT_TOKEN=000000:fake WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 ENCRYPTION_KEY_PREVIOUS= NODE_ENV=development 'GOOGLE_TTS_CREDENTIALS={}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-zman-reminders.ts` fails the same way, at `server only: no file the Mini App bundles imports the zmanim module…`.

- [ ] **Step 3: Widen the translator type in `src/lib/calendar-view/zman-words.ts`.** Behaviour is unchanged. `useTranslations('calendarHome')`, `getTranslations({ locale, namespace: 'calendarHome' })` and zman-view.ts's `createTranslator` (typed as `Parameters<typeof zmanRuleWords>[0]`) all fit, and `tsc` agrees:

```diff
--- a/src/lib/calendar-view/zman-words.ts
+++ b/src/lib/calendar-view/zman-words.ts
@@ -6,13 +6,16 @@
 //
 // Client-safe and pure apart from the translation function it is given.
 
-import type { useTranslations } from 'next-intl';
 import type { ZmanOpinion, ZmanSpecValue } from './zman-spec';
 
-type CalendarHomeT = ReturnType<typeof useTranslations<'calendarHome'>>;
+/**
+ * A translator over calendarHome, by its shape: useTranslations('calendarHome') in the Mini App, getTranslations({ locale,
+ * namespace: 'calendarHome' }) on a server page and createTranslator in the bot all fit.
+ */
+export type ZmanWordsT = (key: string, values?: Record<string, string | number>) => string;
 
 /** A zman's name with the opinion it is counted by, as a list names it. */
-export function zmanName(t: CalendarHomeT, key: string, opinion: ZmanOpinion | null, afterOffset = false): string {
+export function zmanName(t: ZmanWordsT, key: string, opinion: ZmanOpinion | null, afterOffset = false): string {
   const name = t(afterOffset ? `zmanim.namesAfter.${key}` : `zmanim.names.${key}`);
   return opinion ? t('zmanim.withOpinion', { name, opinion: t(`zmanim.opinions.${opinion}`) }) : name;
 }
@@ -22,7 +25,7 @@
  * "2 halachic hours after sunrise". `opinion` is the one the person's set names the zman with (the DTO's and the
  * editor info's); it is ignored for halachic hours.
  */
-export function zmanRuleWords(t: CalendarHomeT, spec: ZmanSpecValue, opinion: ZmanOpinion | null): string {
+export function zmanRuleWords(t: ZmanWordsT, spec: ZmanSpecValue, opinion: ZmanOpinion | null): string {
   const minutes = Math.abs(spec.offsetMin);
   if (minutes === 0) return 'zman' in spec ? zmanName(t, spec.zman, opinion) : t('zmanim.hours', { count: spec.halachicHours });
   const name = 'zman' in spec ? zmanName(t, spec.zman, opinion, true) : t('zmanim.hoursAfter', { count: spec.halachicHours });
```

- [ ] **Step 4: Create `src/lib/calendar-view/zmanim-sheet-css.ts`.** The string is moved verbatim from `ZmanimSheet.tsx` lines 53-143:

```ts
// The sun sheet's CSS (the .ch-zl-* classes): the sheet's frame and the rows ZmanimRows draws
// (components/app-ui/ZmanimRows.tsx). A plain module, outside the 'use client' sheet, so a server page can include it too
// (the public city pages, spec docs/superpowers/specs/2026-10-30-public-zmanim-design.md §6.1). ZmanimSheet.tsx
// re-exports it, so the smokes that import it from the sheet still read the same string.

export const ZMANIM_SHEET_CSS = `
.ch-zl-place {
  margin: 0;
  font-size: 14px;
  color: var(--ch-muted);
}
.ch-zl-nav {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-block: 12px 4px;
}
.ch-zl-date {
  flex: 1;
  min-inline-size: 0;
  text-align: center;
}
.ch-zl-day {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  line-height: 1.3;
}
.ch-zl-day::first-letter {
  text-transform: uppercase;
}
.ch-zl-hebrew {
  margin: 2px 0 0;
  font-size: 14px;
  color: var(--ch-muted);
}
.ch-zl-note {
  margin-block: 8px 4px;
}
.ch-zl-note .ch-notice {
  background: var(--ch-surface);
}
.ch-zl-rows {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
}
.ch-zl-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  min-block-size: 44px;
  padding-block: 6px;
  border-block-end: 1px solid var(--ch-separator);
}
.ch-zl-row:last-child {
  border-block-end: 0;
}
.ch-zl-name {
  flex: 1;
  min-inline-size: 0;
  font-size: 15px;
  line-height: 1.3;
}
.ch-zl-time {
  flex: none;
  font-size: 16px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.ch-zl-row.is-key .ch-zl-name,
.ch-zl-row.is-key .ch-zl-time {
  color: var(--ch-accent);
  font-weight: 600;
}
.ch-zl-row.is-none .ch-zl-time {
  color: var(--ch-muted);
  font-weight: 400;
}
.ch-zl-hours {
  margin: 12px 0 0;
  font-size: 14px;
  color: var(--ch-muted);
}
.ch-zl-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  min-block-size: 280px;
  color: var(--ch-accent);
}
.ch-zl .ch-home-card {
  margin: 8px 0 0;
}
`;
```

- [ ] **Step 5: Create `components/app-ui/ZmanimRows.tsx`.** The markup is the sheet's lines 244-266, and `rowText` is its lines 183-196:

```tsx
// The rows of a day's zmanim (spec docs/superpowers/specs/2026-10-30-public-zmanim-design.md §6.1): the one drawing the
// sun sheet (app/[locale]/(app)/dashboard/ZmanimSheet.tsx) and the public city pages share, so both show the same words,
// accent and dash.
//
// - each row is the set's zman named with its opinion (zman-words.ts, the editor's words), or a window row (WINDOW_ROW_KEYS:
//   the candle lighting, the candle lighting "not before", the end of Shabbat, of Yom Tov or of both) in the accent
//   (is-key); its time in 24 hours in the list's zone, left to right inside Hebrew;
// - a zman the sun does not make that day shows a dash, with "No time this day" for a reader (is-none);
// - under the rows, the halachic hour under each opinion the set counts by, when the list has any.
//
// A plain component: no 'use client', no hooks and no next-intl import. The caller gives it calendarHome's translator
// (useTranslations in the sheet, getTranslations on a server page) and a list in the shape both the Mini App's answer
// (ZmanimListResponse) and the engine's day list have. Its CSS is ZMANIM_SHEET_CSS (src/lib/calendar-view/zmanim-sheet-css.ts).

import type { ReactElement } from 'react';
import { formatTime } from '@/src/lib/calendar-view/format';
import { zmanName, type ZmanWordsT } from '@/src/lib/calendar-view/zman-words';
import { WINDOW_ROW_KEYS, formatHalachicHour, type ZmanimListResponse, type ZmanimListRow } from '@/src/lib/calendar-view/zmanim-list';

/** What the rows read of a day's list: the zone, the rows and the hours (ZmanimListResponse and the engine's ZmanDayList both fit). */
export type ZmanimRowsList = Pick<ZmanimListResponse, 'tz' | 'rows' | 'hours'>;

export interface ZmanimRowsProps {
  list: ZmanimRowsList;
  locale: string;
  /** calendarHome's translator. */
  t: ZmanWordsT;
}

/** A row's name: a window row by its own message, any other zman by its name and opinion. */
function rowText(t: ZmanWordsT, row: ZmanimListRow): string {
  switch (row.key) {
    case 'SHABBAT_ENDS':
      return t('zmanimList.shabbatEnds');
    case 'YOM_TOV_ENDS':
      return t('zmanimList.yomTovEnds');
    case 'SHABBAT_YOM_TOV_ENDS':
      return t('zmanimList.shabbatYomTovEnds');
    case 'CANDLE_LIGHTING_NOT_BEFORE':
      return t('zmanimList.candlesNotBefore');
    default:
      return zmanName(t, row.key, row.opinion);
  }
}

export function ZmanimRows({ list, locale, t }: ZmanimRowsProps): ReactElement {
  return (
    <>
      <ul className="ch-zl-rows" role="list">
        {list.rows.map((row) => (
          <li key={row.key} className={`ch-zl-row${WINDOW_ROW_KEYS.includes(row.key) ? ' is-key' : ''}${row.at === null ? ' is-none' : ''}`} data-zman={row.key}>
            <span className="ch-zl-name">{rowText(t, row)}</span>
            <span className="ch-zl-time">
              {row.at === null ? (
                <>
                  <span aria-hidden="true">—</span>
                  <span className="ch-visually-hidden">{t('zmanimList.noTime')}</span>
                </>
              ) : (
                <bdi dir="ltr">{formatTime(row.at, list.tz, locale)}</bdi>
              )}
            </span>
          </li>
        ))}
      </ul>
      {list.hours.length > 0 ? (
        <p className="ch-zl-hours">
          {t('zmanimList.hourLabel')}{' '}
          {list.hours.map((hour) => t('zmanim.withOpinion', { name: formatHalachicHour(hour.ms), opinion: t(`zmanim.opinions.${hour.opinion}`) })).join(' · ')}
        </p>
      ) : null}
    </>
  );
}
```

- [ ] **Step 6: Make the sheet use them.** In `app/[locale]/(app)/dashboard/ZmanimSheet.tsx`:

```diff
--- a/app/[locale]/(app)/dashboard/ZmanimSheet.tsx
+++ b/app/[locale]/(app)/dashboard/ZmanimSheet.tsx
@@ -18,22 +18,25 @@
 //   is also a Yom Tov;
 // - the halachic hour at the bottom, as minutes and seconds under each opinion the set counts by.
 //
-// The server counts and sends instants; every word and format is here. Client component: it never imports the zmanim
-// service (the list's shapes are src/lib/calendar-view/zmanim-list.ts).
+// The server counts and sends instants; every word and format is here, and the rows and the hour line are ZmanimRows
+// (components/app-ui/ZmanimRows.tsx, shared with the public city pages). Client component: it never imports the zmanim
+// service (the list's shapes are src/lib/calendar-view/zmanim-list.ts). Its CSS lives in
+// src/lib/calendar-view/zmanim-sheet-css.ts and is re-exported here.
 
 import { useEffect, useState } from 'react';
 import { useTranslations } from 'next-intl';
 import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
-import { formatDayLong, formatTime } from '@/src/lib/calendar-view/format';
+import { formatDayLong } from '@/src/lib/calendar-view/format';
 import { hebrewFullDate } from '@/src/lib/calendar-view/hebrew-date';
 import { zoneLabel } from '@/src/lib/calendar-view/home-client';
 import { addDaysToKey } from '@/src/lib/calendar-view/store';
 import type { DayKey } from '@/src/lib/calendar-view/types';
-import { WINDOW_ROW_KEYS, formatHalachicHour, type ZmanimApi, type ZmanimListResponse, type ZmanimListRow } from '@/src/lib/calendar-view/zmanim-list';
+import type { ZmanimApi, ZmanimListResponse } from '@/src/lib/calendar-view/zmanim-list';
+import { ZMANIM_SHEET_CSS } from '@/src/lib/calendar-view/zmanim-sheet-css';
 import { BottomSheet } from '@/components/app-ui/BottomSheet';
 import { Notice } from '@/components/app-ui/Notice';
 import { StateCard } from '@/components/app-ui/StateCard';
-import { zmanName } from '@/src/lib/calendar-view/zman-words';
+import { ZmanimRows } from '@/components/app-ui/ZmanimRows';
 
 export interface ZmanimSheetProps {
   /** The page's own user_id, as CalendarHomeProps carries it (never swapped). */
@@ -50,97 +53,7 @@
 
 type Load = { status: 'loading' } | { status: 'failed' } | { status: 'ok'; list: ZmanimListResponse };
 
-export const ZMANIM_SHEET_CSS = `
-.ch-zl-place {
-  margin: 0;
-  font-size: 14px;
-  color: var(--ch-muted);
-}
-.ch-zl-nav {
-  display: flex;
-  align-items: center;
-  gap: 8px;
-  margin-block: 12px 4px;
-}
-.ch-zl-date {
-  flex: 1;
-  min-inline-size: 0;
-  text-align: center;
-}
-.ch-zl-day {
-  margin: 0;
-  font-size: 16px;
-  font-weight: 600;
-  line-height: 1.3;
-}
-.ch-zl-day::first-letter {
-  text-transform: uppercase;
-}
-.ch-zl-hebrew {
-  margin: 2px 0 0;
-  font-size: 14px;
-  color: var(--ch-muted);
-}
-.ch-zl-note {
-  margin-block: 8px 4px;
-}
-.ch-zl-note .ch-notice {
-  background: var(--ch-surface);
-}
-.ch-zl-rows {
-  list-style: none;
-  margin: 8px 0 0;
-  padding: 0;
-}
-.ch-zl-row {
-  display: flex;
-  align-items: center;
-  justify-content: space-between;
-  gap: 16px;
-  min-block-size: 44px;
-  padding-block: 6px;
-  border-block-end: 1px solid var(--ch-separator);
-}
-.ch-zl-row:last-child {
-  border-block-end: 0;
-}
-.ch-zl-name {
-  flex: 1;
-  min-inline-size: 0;
-  font-size: 15px;
-  line-height: 1.3;
-}
-.ch-zl-time {
-  flex: none;
-  font-size: 16px;
-  font-weight: 600;
-  font-variant-numeric: tabular-nums;
-}
-.ch-zl-row.is-key .ch-zl-name,
-.ch-zl-row.is-key .ch-zl-time {
-  color: var(--ch-accent);
-  font-weight: 600;
-}
-.ch-zl-row.is-none .ch-zl-time {
-  color: var(--ch-muted);
-  font-weight: 400;
-}
-.ch-zl-hours {
-  margin: 12px 0 0;
-  font-size: 14px;
-  color: var(--ch-muted);
-}
-.ch-zl-loading {
-  display: flex;
-  align-items: center;
-  justify-content: center;
-  min-block-size: 280px;
-  color: var(--ch-accent);
-}
-.ch-zl .ch-home-card {
-  margin: 8px 0 0;
-}
-`;
+export { ZMANIM_SHEET_CSS };
 
 export function ZmanimSheet({ userId, locale, today, load, onOpenSettings, onClose }: ZmanimSheetProps) {
   const t = useTranslations('calendarHome');
@@ -180,22 +93,6 @@
   const genitive = locale === 'ru' ? (t.raw('hebrewMonthGenitive') as string[]) : undefined;
   const hebrew = hebrewFullDate(day, locale, genitive);
 
-  const rowText = (row: ZmanimListRow): string => {
-    switch (row.key) {
-      case 'SHABBAT_ENDS':
-        return t('zmanimList.shabbatEnds');
-      case 'YOM_TOV_ENDS':
-        return t('zmanimList.yomTovEnds');
-      case 'SHABBAT_YOM_TOV_ENDS':
-        return t('zmanimList.shabbatYomTovEnds');
-      case 'CANDLE_LIGHTING_NOT_BEFORE':
-        return t('zmanimList.candlesNotBefore');
-      default:
-        return zmanName(t, row.key, row.opinion);
-    }
-  };
-  const isKey = (row: ZmanimListRow) => WINDOW_ROW_KEYS.includes(row.key);
-
   // The place and the set, from the latest list (they do not change from day to day).
   const place = last?.place ?? null;
   const placeName = place?.source === 'saved' && place.name !== '' ? place.name : last ? zoneLabel(last.tz, locale) : '';
@@ -239,33 +136,7 @@
         {current.status === 'failed' ? (
           <StateCard title={t('zmanimList.failedTitle')} body={t('zmanimList.failedBody')} action={{ label: t('actions.retry'), onClick: retry }} />
         ) : null}
-        {current.status === 'ok' ? (
-          <>
-            <ul className="ch-zl-rows" role="list">
-              {current.list.rows.map((row) => (
-                <li key={row.key} className={`ch-zl-row${isKey(row) ? ' is-key' : ''}${row.at === null ? ' is-none' : ''}`} data-zman={row.key}>
-                  <span className="ch-zl-name">{rowText(row)}</span>
-                  <span className="ch-zl-time">
-                    {row.at === null ? (
-                      <>
-                        <span aria-hidden="true">—</span>
-                        <span className="ch-visually-hidden">{t('zmanimList.noTime')}</span>
-                      </>
-                    ) : (
-                      <bdi dir="ltr">{formatTime(row.at, current.list.tz, locale)}</bdi>
-                    )}
-                  </span>
-                </li>
-              ))}
-            </ul>
-            {current.list.hours.length > 0 ? (
-              <p className="ch-zl-hours">
-                {t('zmanimList.hourLabel')}{' '}
-                {current.list.hours.map((hour) => t('zmanim.withOpinion', { name: formatHalachicHour(hour.ms), opinion: t(`zmanim.opinions.${hour.opinion}`) })).join(' · ')}
-              </p>
-            ) : null}
-          </>
-        ) : null}
+        {current.status === 'ok' ? <ZmanimRows list={current.list} locale={locale} t={t} /> : null}
       </div>
     </BottomSheet>
   );
```

- [ ] **Step 7: Run green.**

```bash
env TZ=Asia/Jerusalem DATABASE_URL=postgresql://fake:fake@127.0.0.1:1/fake DIRECT_URL=postgresql://fake:fake@127.0.0.1:1/fake TELEGRAM_BOT_TOKEN=000000:fake WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 ENCRYPTION_KEY_PREVIOUS= NODE_ENV=development 'GOOGLE_TTS_CREDENTIALS={}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-zmanim-sheet.ts
```
Expected: `24/24 passed` in each zone, then `3/3 process zones passed`. That is 23 existing checks plus the new one, and no React warning.

Then run, each expected green: `env TZ=Asia/Jerusalem DATABASE_URL=postgresql://fake:fake@127.0.0.1:1/fake DIRECT_URL=postgresql://fake:fake@127.0.0.1:1/fake TELEGRAM_BOT_TOKEN=000000:fake WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 ENCRYPTION_KEY_PREVIOUS= NODE_ENV=development 'GOOGLE_TTS_CREDENTIALS={}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-zman-cards.ts` (36/36 in each of 3 zones; the `[zman-voice] … zone read failed` line is an existing check's expected log), `env TZ=Asia/Jerusalem DATABASE_URL=postgresql://fake:fake@127.0.0.1:1/fake DIRECT_URL=postgresql://fake:fake@127.0.0.1:1/fake TELEGRAM_BOT_TOKEN=000000:fake WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 ENCRYPTION_KEY_PREVIOUS= NODE_ENV=development 'GOOGLE_TTS_CREDENTIALS={}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-zman-reminders.ts` (29/29, 3 zones), `env TZ=Asia/Jerusalem DATABASE_URL=postgresql://fake:fake@127.0.0.1:1/fake DIRECT_URL=postgresql://fake:fake@127.0.0.1:1/fake TELEGRAM_BOT_TOKEN=000000:fake WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 ENCRYPTION_KEY_PREVIOUS= NODE_ENV=development 'GOOGLE_TTS_CREDENTIALS={}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-app-ui.ts` (37/37), `env TZ=Asia/Jerusalem DATABASE_URL=postgresql://fake:fake@127.0.0.1:1/fake DIRECT_URL=postgresql://fake:fake@127.0.0.1:1/fake TELEGRAM_BOT_TOKEN=000000:fake WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 ENCRYPTION_KEY_PREVIOUS= NODE_ENV=development 'GOOGLE_TTS_CREDENTIALS={}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-zmanim.ts` (42/42, 3 zones), `env TZ=Asia/Jerusalem DATABASE_URL=postgresql://fake:fake@127.0.0.1:1/fake DIRECT_URL=postgresql://fake:fake@127.0.0.1:1/fake TELEGRAM_BOT_TOKEN=000000:fake WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 ENCRYPTION_KEY_PREVIOUS= NODE_ENV=development 'GOOGLE_TTS_CREDENTIALS={}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-calendar-home-render.ts`, `npx tsc --noEmit` (no output), and `npx eslint components/app-ui/ZmanimRows.tsx "app/[locale]/(app)/dashboard/ZmanimSheet.tsx" src/lib/calendar-view/zmanim-sheet-css.ts src/lib/calendar-view/zman-words.ts scripts/smoke-zmanim-sheet.ts scripts/smoke-zman-cards.ts scripts/smoke-zman-reminders.ts` (no output).

- [ ] **Step 8: Commit.**

```bash
git add components/app-ui/ZmanimRows.tsx src/lib/calendar-view/zmanim-sheet-css.ts "app/[locale]/(app)/dashboard/ZmanimSheet.tsx" src/lib/calendar-view/zman-words.ts scripts/smoke-zmanim-sheet.ts scripts/smoke-zman-cards.ts scripts/smoke-zman-reminders.ts
git commit -m "$(cat <<'EOF'
refactor(zmanim): the sun sheet's rows as one plain component, its CSS in a plain module

components/app-ui/ZmanimRows.tsx draws the rows, the accent, the dash and the halachic hour with no hook and no
next-intl import, so the sheet and the public city pages render the same markup; the sheet uses it and re-exports
ZMANIM_SHEET_CSS from src/lib/calendar-view/zmanim-sheet-css.ts. zman-words takes any calendarHome translator
(ZmanWordsT). smoke-zmanim-sheet pins that a server translator gives the sheet's own markup in en, he and ru.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
EOF
)"
```

---

Tasks 5-7 depend on Tasks 1-4 as the contract and the Contract notes give them:
- `zmanDayForPlace`, `ZmanMemo`, `ZmanDayList` in src/services/zmanim/day-list.ts;
- `restDayBlocks` (three arguments) and `ZmanOptions` in compute.ts;
- `holidaysInRange(..., { il })`;
- `City`, `CITIES` and `cityBySlug` in src/site/cities.ts, and the `cities.*` / `countries.*` messages;
- `NearCity`, `nearAnswer`, `haversineKm`, `utcOffsetMinutes`, `OPEN_KM` and `NEAR_KM` in src/site/near-city.ts;
- `ZmanimRows` in components/app-ui/ZmanimRows.tsx, `ZmanWordsT` in src/lib/calendar-view/zman-words.ts, and `ZMANIM_SHEET_CSS` in src/lib/calendar-view/zmanim-sheet-css.ts.

---

### Task 5: City view model

**Files:**
- Create: `src/site/zmanim/city-view.ts`
- Test: `scripts/smoke-zmanim-public-view.ts` (new; picked up by ci-smokes.sh by its name)

**Interfaces:**
- Consumes:
  - `City` (src/site/cities.ts);
  - `Place`, `inIsrael`, `restDayBlocks(range, place, community)` (three arguments: it never logs) and `RestDayBlock` (src/services/zmanim/compute.ts);
  - `zmanDayForPlace(place, community, day, { memo, quiet: true })`, `ZmanMemo` and `ZmanDayList` (src/services/zmanim/day-list.ts);
  - `holidaysInRange(from, to, lang, { il })` and `Holiday` (src/services/hebrew-holidays.ts);
  - `isCommunity` and `ZmanimCommunity` (sets.ts);
  - `monthGrid`, `monthOf`, `addMonths`, `monthFirstDay` and `monthLastDay` (src/lib/calendar-view/grid.ts);
  - `WINDOW_ROW_KEYS` and `ZmanimListRow` (zmanim-list.ts);
  - `weekStartFor` (src/utils/locale-rules.ts), `instantToWallTime` (src/utils/wall-time.ts), and `addDaysToDate` and `startOfLocalDay` (src/utils/day-events.ts).
- Produces:
  - `cityPlace`, `defaultCommunity`, `cityToday`, `publicRange`;
  - `CityParams`, `readCityParams`;
  - `AheadDay`, `AheadWindow`, `MonthCell` (+`inRange`), `MonthEntry`, `MonthView`, `CitySection`, `SectionFailure`, `CityView` (as in Contract notes 15-18);
  - `buildCityView(city, params, locale)`, `windowList(view, day, rows)`.

- [ ] **Step 1: Write the failing smoke.** Create `scripts/smoke-zmanim-public-view.ts`:

```ts
// Smoke test for a city's zmanim page as data, src/site/zmanim/city-view.ts (plan 6a Task 5; spec
// 2026-10-30-public-zmanim §4.2, §4.3, §6.1, §6.2).
//
//  - V1 a city's place, its default community, its today in its own zone (summer time too), the public range (and 29 February);
//  - V2 the parameters: a good date and community kept; a repeated, bad, out-of-range or default-equal one dropped;
//  - V3 Jerusalem, Sephardi: the day's list is zmanDayForPlace's for the city's point and height, and the height counts;
//  - V4 a Friday: candle lighting in the day, the coming Shabbat named by its parasha, its rows the day lists' own;
//  - V5 New York, Ashkenazi: Pesach 2027's two days of Yom Tov abroad ("not before" on the first night), against Jerusalem's one;
//  - V6 Rosh Hashana: the second night's candles "not before" the first day's end, then the end of Yom Tov;
//  - V7 London in June: dawn has no time and the view says so (hasDash); Moscow in June: tallit and tefillin too;
//  - V8 Saint Petersburg on a June 2027 Friday: candle lighting, and the Shabbat's end has no time (endMissing);
//  - V9 the range's edges: no previous or next day or month past them; the previous month's link clamped to the range;
//  - V10 the month: Sunday-first weeks, today and the day shown marked, a mark for each holiday (a parasha is none), the
//    list of every holiday, fast and Rosh Chodesh and every Shabbat with its parasha and rows; Israel and abroad differ
//    on 3 and 4 October 2026;
//  - V11 the names follow the page's language;
//  - V12 the bot's process memo is untouched, and a quiet build logs no missing zman (where an unquiet one does);
//  - V13 (review focus a) just after midnight in a far zone (Sydney at 00:30 on 3 November while UTC is still on the 2nd):
//    today, the day shown, its links, the range and the month are the city's;
//  - V14 (review focus b) a summer/winter time change day in the city's zone (New York 2026-11-01, Jerusalem 2026-10-25,
//    Sydney 2026-10-04): the rows in the order of the day, none twice and none an hour off, and the previous and next
//    days neither skip nor repeat a day;
//  - V15 (review focus d) repeated or odd query values are ignored, and nothing throws.
//
// The whole smoke runs twice: first as a child under TZ=UTC (prod's zone, review focus a), then in the zone it was started
// in (ci-smokes.sh: Asia/Jerusalem). Nothing here may read the process's own zone.
//
// Pure: no DB, Redis or network. Run with the fake env (never the real one), from the repo root, as ci-smokes.sh does.

import { execFileSync } from 'node:child_process';
import { assert, check, finish, load, show, type Row } from './lib/site-harness';

if (process.env.TZ !== 'UTC') {
  // A failing run under UTC throws here, so the smoke exits 1 with that run's output above.
  execFileSync(process.execPath, [...process.execArgv, __filename], { env: { ...process.env, TZ: 'UTC' }, stdio: 'inherit' });
}

/** Friday 30 October 2026, 11:00 in Jerusalem. */
const NOW = new Date('2026-10-30T09:00:00Z');
const WINDOW = ['CANDLE_LIGHTING', 'CANDLE_LIGHTING_NOT_BEFORE', 'SHABBAT_ENDS', 'YOM_TOV_ENDS', 'SHABBAT_YOM_TOV_ENDS'];

async function main() {
  const { cityBySlug } = await load('src/site/cities.ts');
  const v = await load('src/site/zmanim/city-view.ts');
  const { zmanDayForPlace } = await load('src/services/zmanim/day-list.ts');
  const { holidaysInRange } = await load('src/services/hebrew-holidays.ts');
  const { ZMAN_KEYS } = await load('src/services/zmanim/sets.ts');
  const { instantToWallTime } = await load('src/utils/wall-time.ts');
  const { addDaysToDate } = await load('src/utils/day-events.ts');

  const city = (slug: string): Row => {
    const found = cityBySlug(slug);
    assert(found, `no city ${slug} in the table`);
    return found;
  };
  const build = (slug: string, search: Row = {}, locale = 'en', now = NOW): Row => {
    const c = city(slug);
    return v.buildCityView(c, v.readCityParams(c, search, now), locale);
  };
  const fresh = (slug: string, community: string, day: string): Row => zmanDayForPlace(v.cityPlace(city(slug)), community, day, { memo: new Map(), quiet: true });
  const windowRows = (slug: string, community: string, day: string) => fresh(slug, community, day).rows.filter((r: Row) => WINDOW.includes(r.key));
  const keysOf = (w: Row) => w.days.map((d: Row) => d.rows.map((r: Row) => r.key));
  const spans = (view: Row) => view.ahead.map((w: Row) => [w.eve, w.last]);
  const row = (view: Row, key: string): Row | undefined => view.list.rows.find((r: Row) => r.key === key);
  const cell = (view: Row, day: string): Row => view.month.weeks.flat().find((c: Row) => c.day === day);
  const entry = (view: Row, day: string): Row | undefined => view.month.entries.find((e: Row) => e.day === day);
  const ok = (view: Row, where: string) => assert(view.failures.length === 0, `${where}: failed sections ${show(view.failures.map((f: Row) => `${f.section}: ${String(f.error)}`))}`);

  await check('V1 a city\'s place, default community, today in its own zone (summer time too) and the public range (29 February too)', () => {
    const jlm = city('jerusalem');
    assert(show(v.cityPlace(jlm)) === show({ latitude: jlm.latitude, longitude: jlm.longitude, elevationM: jlm.elevationM, timeZone: 'Asia/Jerusalem' }), `the place ${show(v.cityPlace(jlm))}`);
    assert(v.defaultCommunity(jlm) === 'sephardi' && v.defaultCommunity(city('new-york')) === 'ashkenazi' && v.defaultCommunity(city('moscow')) === 'ashkenazi', 'the default community');
    const late = new Date('2026-10-30T22:30:00Z');
    assert(v.cityToday(jlm, NOW) === '2026-10-30' && v.cityToday(jlm, late) === '2026-10-31', `Jerusalem's today ${v.cityToday(jlm, late)}`);
    assert(v.cityToday(city('new-york'), late) === '2026-10-30', 'New York is still on the 30th (summer time until 1 November)');
    assert(v.cityToday(city('sydney'), new Date('2026-10-30T14:00:00Z')) === '2026-10-31', 'Sydney is already on the 31st');
    assert(show(v.publicRange(jlm, NOW)) === show({ first: '2025-10-30', last: '2029-10-30' }), `the range ${show(v.publicRange(jlm, NOW))}`);
    assert(show(v.publicRange(jlm, new Date('2028-02-29T10:00:00Z'))) === show({ first: '2027-02-28', last: '2031-02-28' }), 'the range from a 29 February');
  });

  await check('V2 the parameters: a good date and community kept; a repeated, bad, out-of-range or default-equal one dropped', () => {
    const jlm = city('jerusalem');
    const read = (search: Row, c: Row = jlm) => v.readCityParams(c, search, NOW);
    const none = read({});
    assert(none.day === '2026-10-30' && none.today === '2026-10-30' && none.community === 'sephardi' && !none.dayFromParam && !none.communityFromParam, show(none));
    const good = read({ date: '2026-11-03', community: 'chabad' });
    assert(good.day === '2026-11-03' && good.dayFromParam && good.community === 'chabad' && good.communityFromParam, show(good));
    assert(read({ date: ['2026-11-03', '2026-11-04'] }).day === '2026-10-30' && !read({ date: ['2026-11-03', '2026-11-04'] }).dayFromParam, 'a repeated date is not ignored');
    for (const bad of ['2026-13-45', '2026-02-30', 'tomorrow', '', '20261103', '2026-11-3']) {
      const p = read({ date: bad });
      assert(p.day === '2026-10-30' && !p.dayFromParam, `${bad}: ${show(p)}`);
    }
    for (const [date, kept] of [['2025-10-29', false], ['2025-10-30', true], ['2029-10-30', true], ['2029-10-31', false]] as const) {
      const p = read({ date });
      assert(p.dayFromParam === kept && p.day === (kept ? date : '2026-10-30'), `${date}: ${show(p)}`);
    }
    assert(read({ community: 'sephardi' }).community === 'sephardi' && !read({ community: 'sephardi' }).communityFromParam, 'Jerusalem\'s default, named, is dropped');
    assert(read({ community: 'reform' }).community === 'sephardi' && !read({ community: 'reform' }).communityFromParam, 'an unknown community');
    const ny = city('new-york');
    assert(!read({ community: 'ashkenazi' }, ny).communityFromParam && read({ community: 'sephardi' }, ny).community === 'sephardi' && read({ community: 'sephardi' }, ny).communityFromParam, 'New York\'s');
  });

  await check('V3 Jerusalem, Sephardi: the list is zmanDayForPlace\'s for the city\'s point and height; the height counts and is named only for Sephardi in Israel', () => {
    const jlm = city('jerusalem');
    assert(Number.isInteger(jlm.elevationM) && jlm.elevationM > 100, `Jerusalem's height ${jlm.elevationM}`);
    const view = build('jerusalem', { date: '2026-10-28' });
    ok(view, 'Jerusalem');
    assert(view.community === 'sephardi' && view.isDefaultCommunity && view.il && view.heightM === jlm.elevationM && !view.hasDash, show({ community: view.community, heightM: view.heightM, hasDash: view.hasDash }));
    assert(show(view.list) === show(fresh('jerusalem', 'sephardi', '2026-10-28')), 'the list is not zmanDayForPlace\'s');
    const sea = zmanDayForPlace({ ...v.cityPlace(jlm), elevationM: 0 }, 'sephardi', '2026-10-28', { memo: new Map(), quiet: true });
    assert(row(view, 'SHKIA')?.at !== sea.rows.find((r: Row) => r.key === 'SHKIA')?.at, 'the height does not count');
    assert(build('jerusalem', { date: '2026-10-28', community: 'chabad' }).heightM === null && build('jerusalem', { date: '2026-10-28', community: 'ashkenazi' }).heightM === null, 'a height named for a set that does not use it');
    assert(build('london', { date: '2026-10-28', community: 'sephardi' }).heightM === null, 'a height named abroad');
  });

  await check('V4 a Friday: candle lighting in the day; the coming Shabbat named by its parasha, its rows the day lists\' own', () => {
    const view = build('jerusalem');
    ok(view, 'Friday');
    assert(view.isToday && view.day === '2026-10-30' && view.prevDay === '2026-10-29' && view.nextDay === '2026-10-31', show({ day: view.day, prev: view.prevDay, next: view.nextDay }));
    const candle = row(view, 'CANDLE_LIGHTING');
    assert(candle && candle.at, 'no candle lighting on the Friday');
    assert(show(spans(view)) === show([['2026-10-30', '2026-10-31'], ['2026-11-06', '2026-11-07']]), `the windows ${show(spans(view))}`);
    const [shabbat] = view.ahead;
    assert(shabbat.parasha?.title === 'Parashat Vayera' && shabbat.holidays.length === 0 && !shabbat.endMissing, show(shabbat));
    assert(show(keysOf(shabbat)) === show([['CANDLE_LIGHTING'], ['SHABBAT_ENDS']]), show(keysOf(shabbat)));
    for (const d of shabbat.days) assert(show(d.rows) === show(windowRows('jerusalem', 'sephardi', d.day)), `${d.day}: not the day list's window rows`);
    assert(candle.at === shabbat.days[0].rows[0].at, 'the day and the window disagree on the candles');
  });

  await check('V5 New York, Ashkenazi: Pesach 2027\'s two days of Yom Tov abroad, against Jerusalem\'s one', () => {
    const ny = build('new-york', { date: '2027-04-21' });
    ok(ny, 'New York');
    assert(!ny.il && ny.community === 'ashkenazi', 'New York\'s schedule');
    assert(show(spans(ny)) === show([['2027-04-21', '2027-04-24'], ['2027-04-27', '2027-04-29']]), `New York's windows ${show(spans(ny))}`);
    assert(show(keysOf(ny.ahead[0])) === show([['CANDLE_LIGHTING'], ['CANDLE_LIGHTING_NOT_BEFORE'], ['CANDLE_LIGHTING'], ['SHABBAT_ENDS']]), show(keysOf(ny.ahead[0])));
    assert(ny.ahead[0].holidays.length === 2 && ny.ahead[0].holidays.every((h: Row) => h.chag) && ny.ahead[0].parasha === null, show(ny.ahead[0].holidays));
    assert(show(keysOf(ny.ahead[1])) === show([['CANDLE_LIGHTING'], ['CANDLE_LIGHTING_NOT_BEFORE'], ['YOM_TOV_ENDS']]), show(keysOf(ny.ahead[1])));
    for (const w of ny.ahead) for (const d of w.days) assert(show(d.rows) === show(windowRows('new-york', 'ashkenazi', d.day)), `New York ${d.day}: not the day list's rows`);
    const jlm = build('jerusalem', { date: '2027-04-21' });
    ok(jlm, 'Jerusalem at Pesach');
    assert(show(spans(jlm)) === show([['2027-04-21', '2027-04-22'], ['2027-04-23', '2027-04-24'], ['2027-04-27', '2027-04-28']]), `Jerusalem's windows ${show(spans(jlm))}`);
    assert(show(keysOf(jlm.ahead[0])) === show([['CANDLE_LIGHTING'], ['YOM_TOV_ENDS']]), show(keysOf(jlm.ahead[0])));
    assert(show(jlm.ahead[1].holidays.map((h: Row) => h.kind)) === show(['cholHamoed']), 'Shabbat chol hamoed is named by its day');
    assert(cell(ny, '2027-04-23').yomTov && !cell(jlm, '2027-04-23').yomTov, 'the second day is Yom Tov abroad only');
  });

  await check('V6 Rosh Hashana: the second night\'s candles "not before" the first day\'s end, then the end of Yom Tov', () => {
    const view = build('jerusalem', { date: '2026-09-10' });
    ok(view, 'Rosh Hashana');
    const [rh] = view.ahead;
    assert(rh.eve === '2026-09-11' && rh.last === '2026-09-13' && rh.parasha === null, show([rh.eve, rh.last, rh.parasha]));
    assert(show(keysOf(rh)) === show([['CANDLE_LIGHTING'], ['CANDLE_LIGHTING_NOT_BEFORE'], ['YOM_TOV_ENDS']]), show(keysOf(rh)));
    assert(rh.holidays.length === 2 && rh.holidays.every((h: Row) => h.chag), show(rh.holidays));
    const notBefore = rh.days[1].rows[0];
    assert(notBefore.at !== null && notBefore.at === fresh('jerusalem', 'sephardi', '2026-09-12').rows.find((r: Row) => r.key === 'CANDLE_LIGHTING_NOT_BEFORE')?.at, 'the "not before" is not the day list\'s');
  });

  await check('V7 London in June: dawn has no time and the view says so; Moscow in June: tallit and tefillin too', () => {
    const london = build('london', { date: '2027-06-21' });
    ok(london, 'London');
    assert(london.community === 'ashkenazi' && london.hasDash, 'London has no dash');
    assert(row(london, 'ALOT')?.at === null && row(london, 'NETZ')?.at, `London's dawn ${show(row(london, 'ALOT'))}`);
    assert(show(london.list) === show(fresh('london', 'ashkenazi', '2027-06-21')), 'London\'s list is not zmanDayForPlace\'s');
    const moscow = build('moscow', { date: '2027-06-21' });
    ok(moscow, 'Moscow');
    assert(row(moscow, 'MISHEYAKIR')?.at === null && moscow.hasDash, `Moscow's tallit and tefillin ${show(row(moscow, 'MISHEYAKIR'))}`);
    assert(!build('jerusalem', { date: '2027-06-21' }).hasDash, 'Jerusalem in June has a dash');
  });

  await check('V8 Saint Petersburg on a June 2027 Friday: candle lighting, and the Shabbat\'s end has no time', () => {
    const spb = build('saint-petersburg', { date: '2027-06-18' });
    ok(spb, 'Saint Petersburg');
    const candle = row(spb, 'CANDLE_LIGHTING');
    assert(candle && candle.at !== null, 'no candle lighting on the Friday');
    const [shabbat] = spb.ahead;
    assert(shabbat.eve === '2027-06-18' && shabbat.last === '2027-06-19' && shabbat.endMissing, show([shabbat.eve, shabbat.last, shabbat.endMissing]));
    assert(show(keysOf(shabbat)) === show([['CANDLE_LIGHTING'], ['SHABBAT_ENDS']]), show(keysOf(shabbat)));
    assert(shabbat.days[0].rows[0].at === candle.at && shabbat.days[1].rows[0].at === null, show(shabbat.days));
  });

  await check('V9 the range\'s edges: no previous or next day or month past them; the previous month\'s link clamped to the range', () => {
    const first = build('jerusalem', { date: '2025-10-30' });
    assert(first.prevDay === null && first.nextDay === '2025-10-31' && first.month.key === '2025-10' && first.month.prevMonthDay === null && first.month.nextMonthDay === '2025-11-01', show([first.prevDay, first.month]));
    assert(!cell(first, '2025-10-29').inRange && cell(first, '2025-10-30').inRange, 'the cells outside the range');
    assert(build('jerusalem', { date: '2025-11-15' }).month.prevMonthDay === '2025-10-30', 'the previous month is not clamped to the range');
    const last = build('jerusalem', { date: '2029-10-30' });
    assert(last.nextDay === null && last.prevDay === '2029-10-29' && last.month.nextMonthDay === null && last.month.prevMonthDay === '2029-09-01', show([last.nextDay, last.month.prevMonthDay, last.month.nextMonthDay]));
  });

  await check('V10 the month: Sunday-first weeks, today and the day shown, a mark per holiday (none for a parasha), the list of holidays and Shabbatot; Israel and abroad differ on 3 and 4 October 2026', () => {
    const jlm = build('jerusalem', { date: '2026-10-28' });
    const ny = build('new-york', { date: '2026-10-28' });
    for (const [slug, view] of [['jerusalem', jlm], ['moscow', build('moscow', { date: '2026-10-28' })], ['new-york', ny]] as [string, Row][]) {
      ok(view, slug);
      assert(view.month.weekStart === 0 && view.month.weeks.length >= 4 && view.month.weeks.every((w: Row[]) => w.length === 7 && new Date(`${w[0].day}T00:00:00Z`).getUTCDay() === 0), `${slug}: not Sunday-first`);
    }
    const cells = jlm.month.weeks.flat();
    assert(jlm.month.key === '2026-10' && cells.filter((c: Row) => c.inMonth).length === 31, 'October\'s days');
    assert(cells.filter((c: Row) => c.isToday).map((c: Row) => c.day).join() === '2026-10-30' && cells.filter((c: Row) => c.isShown).map((c: Row) => c.day).join() === '2026-10-28', 'today and the day shown');
    assert(cell(jlm, '2026-10-03').yomTov && cell(jlm, '2026-10-11').holidays.some((h: Row) => h.kind === 'roshChodesh') && cell(jlm, '2026-10-31').holidays.length === 0, 'the marks');
    assert(cells.filter((c: Row) => !c.inMonth).every((c: Row) => c.holidays.length === 0), 'a mark outside the month');
    const all = holidaysInRange('2026-10-01', '2026-10-31', 'en', { il: true });
    const want = [...new Set([...Object.keys(all).filter((d) => all[d].some((h: Row) => h.kind !== 'parasha')), '2026-10-03', '2026-10-10', '2026-10-17', '2026-10-24', '2026-10-31'])].sort();
    assert(show(jlm.month.entries.map((e: Row) => e.day)) === show(want), `the list ${show(jlm.month.entries.map((e: Row) => e.day))}`);
    const sat = entry(jlm, '2026-10-31');
    assert(sat?.shabbat?.parasha?.title === 'Parashat Vayera', show(sat));
    assert(show(sat.shabbat.rows) === show([...windowRows('jerusalem', 'sephardi', '2026-10-30'), ...windowRows('jerusalem', 'sephardi', '2026-10-31')]), 'the Shabbat\'s rows are not the day lists\'');
    const oct3 = (view: Row) => entry(view, '2026-10-03')?.shabbat;
    assert(show(oct3(jlm)?.rows.map((r: Row) => r.key)) === show(['CANDLE_LIGHTING', 'SHABBAT_YOM_TOV_ENDS']) && oct3(jlm)?.parasha === null, `Jerusalem, 3 October ${show(oct3(jlm))}`);
    assert(show(oct3(ny)?.rows.map((r: Row) => r.key)) === show(['CANDLE_LIGHTING', 'CANDLE_LIGHTING_NOT_BEFORE']), `New York, 3 October ${show(oct3(ny))}`);
    assert(entry(ny, '2026-10-04')?.holidays.some((h: Row) => h.chag) && cell(ny, '2026-10-04').yomTov && !cell(jlm, '2026-10-04').yomTov, 'Simchat Torah is Yom Tov abroad only');
  });

  await check('V11 the names follow the page\'s language', () => {
    const he = build('jerusalem', { date: '2026-10-28' }, 'he');
    const ru = build('jerusalem', { date: '2026-10-28' }, 'ru');
    assert(entry(he, '2026-10-31')?.shabbat?.parasha?.title === 'פרשת וירא' && entry(ru, '2026-10-31')?.shabbat?.parasha?.title === 'Глава Ваера', 'the parasha\'s name');
    assert(build('jerusalem', {}, 'ru').ahead[0].parasha?.title === 'Глава Ваера', 'the window\'s name');
  });

  await check('V12 the bot\'s process memo is untouched, and a quiet build logs no missing zman (where an unquiet one does)', () => {
    const shared = globalThis as { __zmanReminderAnswers?: Map<string, number | null> };
    // The bot's path (no memo given) fills the process memo, as the sun sheet does
    zmanDayForPlace(v.cityPlace(city('haifa')), 'sephardi', '2026-10-28');
    const before = show([...(shared.__zmanReminderAnswers ?? new Map()).entries()]);
    assert(before !== '[]', 'the process memo is not on globalThis.__zmanReminderAnswers');
    const warned: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => void warned.push(args.map(String).join(' '));
    try {
      build('london', { date: '2027-06-21' });
      build('moscow', { date: '2027-06-21' });
      build('saint-petersburg', { date: '2027-06-18' });
      build('jerusalem', { date: '2026-10-28' });
    } finally {
      console.warn = warn;
    }
    assert(show([...(shared.__zmanReminderAnswers ?? new Map()).entries()]) === before, 'a public view wrote the process memo');
    assert(warned.filter((line) => line.includes('[zmanim]')).length === 0, `a quiet build logged ${show(warned)}`);
    // The same day, asked as the bot asks it, does log: the check above means something
    const loud: string[] = [];
    console.warn = (...args: unknown[]) => void loud.push(args.map(String).join(' '));
    try {
      zmanDayForPlace(v.cityPlace(city('london')), 'ashkenazi', '2027-06-21', { memo: new Map() });
    } finally {
      console.warn = warn;
    }
    assert(loud.some((line) => line.includes('[zmanim]')), 'an unquiet list for London in June logs nothing');
  });

  await check('V13 (review focus a) just after midnight in a far zone, the smoke also running under TZ=UTC: at 2026-11-02T13:30:00Z it is 00:30 on 3 November in Sydney and still the 2nd in UTC, so today, the day shown, its links, the range and the month are Sydney\'s', () => {
    const syd = city('sydney');
    const now = new Date('2026-11-02T13:30:00Z');
    assert(instantToWallTime(now, 'Australia/Sydney').startsWith('2026-11-03T00:30') && instantToWallTime(now, 'UTC').startsWith('2026-11-02'), 'the fixture');
    const p = v.readCityParams(syd, {}, now);
    assert(v.cityToday(syd, now) === '2026-11-03' && p.today === '2026-11-03' && p.day === '2026-11-03' && !p.dayFromParam, show(p));
    assert(show(v.publicRange(syd, now)) === show({ first: '2025-11-03', last: '2029-11-03' }), `the range ${show(v.publicRange(syd, now))}`);
    const view = v.buildCityView(syd, p, 'en');
    ok(view, 'Sydney');
    assert(view.isToday && view.list.day === '2026-11-03' && view.list.tz === 'Australia/Sydney' && view.prevDay === '2026-11-02' && view.nextDay === '2026-11-04', show([view.list.day, view.prevDay, view.nextDay]));
    assert(view.month.key === '2026-11' && view.month.weeks.flat().filter((c: Row) => c.isToday).map((c: Row) => c.day).join() === '2026-11-03', 'today\'s cell');
    assert(!v.buildCityView(syd, v.readCityParams(syd, { date: '2026-11-02' }, now), 'en').isToday, 'the server\'s date is taken for Sydney\'s today');
  });

  await check('V14 (review focus b) a summer/winter time change day in the city\'s zone (New York 2026-11-01, Jerusalem 2026-10-25, Sydney 2026-10-04, Simchat Torah there): the rows in the order of the day, each key once, each time on the city\'s clock within 3 minutes of the next day\'s (never an hour off), the hour unchanged; the previous and next days are the calendar\'s neighbours, none skipped or repeated', () => {
    const STANDS_AT: Record<string, string> = { YOM_TOV_ENDS: 'SHABBAT_ENDS', SHABBAT_YOM_TOV_ENDS: 'SHABBAT_ENDS', CANDLE_LIGHTING_NOT_BEFORE: 'SHABBAT_ENDS' };
    const orderOf = (key: string): number => ZMAN_KEYS.indexOf(STANDS_AT[key] ?? key);
    const minutesOf = (at: string, zone: string): number => {
      const [h, m] = instantToWallTime(new Date(at), zone).slice(11, 16).split(':').map(Number);
      return h * 60 + m;
    };
    for (const [slug, day] of [['new-york', '2026-11-01'], ['jerusalem', '2026-10-25'], ['sydney', '2026-10-04']] as const) {
      const c = city(slug);
      const where = `${slug} ${day}`;
      const view = build(slug, { date: day });
      ok(view, where);
      assert(show(view.list) === show(fresh(slug, view.community, day)), `${where}: not zmanDayForPlace's list`);
      const keys: string[] = view.list.rows.map((r: Row) => r.key);
      assert(new Set(keys).size === keys.length, `${where}: a row twice ${show(keys)}`);
      assert(keys.every((k, i) => i === 0 || orderOf(keys[i - 1]) <= orderOf(k)), `${where}: not in the order of the day ${show(keys)}`);
      const atOf = (key: string): string | null => view.list.rows.find((r: Row) => r.key === key)?.at ?? null;
      const chain = ['ALOT', 'NETZ', 'CHATZOT', 'SHKIA', 'TZEIT'].map(atOf).filter((x): x is string => x !== null).map((x) => Date.parse(x));
      assert(chain.length >= 4 && chain.every((t, i) => i === 0 || chain[i - 1] < t), `${where}: dawn, sunrise, midday, sunset and nightfall out of order`);
      const next = fresh(slug, view.community, addDaysToDate(day, 1));
      for (const row of view.list.rows) {
        if (row.at === null) continue;
        const wallDay = instantToWallTime(new Date(row.at), c.timeZone).slice(0, 10);
        const late = row.key === 'CHATZOT_HALAYLA' || row.key === 'SHABBAT_ENDS' || row.key in STANDS_AT;
        assert(wallDay === day || (late && wallDay === addDaysToDate(day, 1)), `${where}: ${row.key} falls on ${wallDay}`);
        const twin = next.rows.find((r: Row) => r.key === row.key);
        if (!twin?.at) continue;
        const gap = Math.abs(minutesOf(row.at, c.timeZone) - minutesOf(twin.at, c.timeZone));
        assert(Math.min(gap, 1440 - gap) <= 3, `${where}: ${row.key} is ${Math.min(gap, 1440 - gap)} minutes from the next day's on the city's clock`);
      }
      assert(Math.abs(view.list.hours[0].ms - next.hours[0].ms) < 60_000, `${where}: the halachic hour jumps`);
      assert(view.prevDay === addDaysToDate(day, -1) && view.nextDay === addDaysToDate(day, 1), `${where}: ${show([view.prevDay, view.nextDay])}`);
      assert(build(slug, { date: view.prevDay }).nextDay === day && build(slug, { date: view.nextDay }).prevDay === day, `${where}: the neighbours do not point back`);
      const walked: string[] = [addDaysToDate(day, -2)];
      for (let i = 0; i < 4; i++) walked.push(build(slug, { date: walked[walked.length - 1] }).nextDay);
      assert(show(walked) === show([-2, -1, 0, 1, 2].map((n) => addDaysToDate(day, n))), `${where}: the next-day links walk ${show(walked)}`);
    }
    assert(build('sydney', { date: '2026-10-04' }).list.rows.some((r: Row) => r.key === 'YOM_TOV_ENDS'), 'Sydney\'s Simchat Torah has no end of Yom Tov');
  });

  await check('V15 (review focus d) repeated or odd values are ignored and nothing throws: a repeated date or community, community[]=x, date[]=..., a 10,000-character date, 30 February', () => {
    const jlm = city('jerusalem');
    const odd: Array<Record<string, string | string[] | undefined>> = [
      { date: ['2026-11-01', '2026-11-02'] },
      { community: ['chabad', 'ashkenazi'] },
      { 'community[]': 'x' },
      { 'date[]': '2026-11-01' },
      { date: '2'.repeat(10_000) },
      { date: `2026-11-01${'0'.repeat(9_990)}` },
      { date: '2026-02-30' },
      { date: undefined, community: undefined },
    ];
    for (const search of odd) {
      const label = show(search).slice(0, 60);
      let p: Row = {};
      try {
        p = v.readCityParams(jlm, search, NOW);
      } catch (error) {
        throw new Error(`${label} threw: ${String(error)}`);
      }
      assert(p.day === '2026-10-30' && p.today === '2026-10-30' && !p.dayFromParam && p.community === 'sephardi' && !p.communityFromParam, `${label}: ${show(p)}`);
      ok(v.buildCityView(jlm, p, 'en'), label);
    }
  });

  finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Run it red.**
```
cd /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/zp-wt && env TZ=Asia/Jerusalem DATABASE_URL=postgresql://fake:fake@127.0.0.1:1/fake DIRECT_URL=postgresql://fake:fake@127.0.0.1:1/fake TELEGRAM_BOT_TOKEN=000000:fake WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 ENCRYPTION_KEY_PREVIOUS= NODE_ENV=development 'GOOGLE_TTS_CREDENTIALS={}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-zmanim-public-view.ts
```
Expected: exit 1 before any check: the TZ=UTC run prints `Cannot find module '.../src/site/zmanim/city-view.ts'` (main's catch prints it), and the parent stops on that run's failure.

- [ ] **Step 3: Implement.** Create `src/site/zmanim/city-view.ts`:

```ts
// A city's zmanim page as data (spec 2026-10-30-public-zmanim §4.2, §4.3, §6.1, §6.2): the parameters the URL may carry,
// the day's list, the Shabbat and Yom Tov ahead, and the month. The page words and draws it (app/[locale]/(site)/zmanim/
// [city]/page.tsx); the Hebrew dates are written there too (hebrew-date.ts), never stored here.
//
// - One code path with the bot: every row is zmanDayForPlace's (src/services/zmanim/day-list.ts), at the city's point and
//   height under the community's set, so the page and the sun sheet show the same times.
// - Each view has its own memo and asks quietly: a crawler can never flush the bot's process memo, and a zman the sun does
//   not make is shown as a dash, not logged.
// - Holidays follow the city: il = inIsrael(city.timeZone), the same flag the engine's windows read, for the labels too.
// - "Today" is the city's own (instantToWallTime: the repo's wall-time rule), and the range a URL may ask for is a year
//   back to three years ahead of it.
// - A section that fails (a hebcal error) is caught and returned as a failure: the page logs it and words it, and the
//   rest of the page still renders.
//
// Server only by import discipline (it reads src/services/zmanim and @hebcal/core through the holiday module). Pure:
// no database, Redis, network or clock (the page hands it `now`).

import { addMonths, monthFirstDay, monthGrid, monthLastDay, monthOf } from '@/src/lib/calendar-view/grid';
import type { WeekStart } from '@/src/lib/calendar-view/types';
import { WINDOW_ROW_KEYS, type ZmanimListRow } from '@/src/lib/calendar-view/zmanim-list';
import { holidaysInRange, type Holiday } from '@/src/services/hebrew-holidays';
import { inIsrael, restDayBlocks, type Place } from '@/src/services/zmanim/compute';
import { zmanDayForPlace, type ZmanDayList, type ZmanMemo } from '@/src/services/zmanim/day-list';
import { isCommunity, type ZmanimCommunity } from '@/src/services/zmanim/sets';
import type { City } from '@/src/site/cities';
import { addDaysToDate, startOfLocalDay } from '@/src/utils/day-events';
import { weekStartFor } from '@/src/utils/locale-rules';
import { instantToWallTime } from '@/src/utils/wall-time';

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** A Shabbat or Yom Tov listed ahead begins at most this many days after the day shown (spec §4.2.3). */
const AHEAD_DAYS = 8;

/** The most rest days in a row (a Yom Tov on Thursday and Friday, then Shabbat): how far a block reaches past its eve. */
const LONGEST_BLOCK = 3;

export type CityParams = { day: string; community: ZmanimCommunity; today: string; dayFromParam: boolean; communityFromParam: boolean };

/** One day of a window: only its window rows (WINDOW_ROW_KEYS), as the day list gives them. */
export type AheadDay = { day: string; rows: ZmanimListRow[] };

export type AheadWindow = {
  /** The day whose sunset begins it (yyyy-MM-dd in the city's zone). */
  eve: string;
  /** Its last rest day. */
  last: string;
  /** Its Yom Tov days' names, or, with none, its chol hamoed or special Shabbat's. */
  holidays: Holiday[];
  parasha: Holiday | null;
  days: AheadDay[];
  /** The sun does not make its end (the far north in summer): the end row is a dash. */
  endMissing: boolean;
};

export type MonthCell = { day: string; inMonth: boolean; inRange: boolean; holidays: Holiday[]; yomTov: boolean; isToday: boolean; isShown: boolean };

export type MonthEntry = { day: string; holidays: Holiday[]; shabbat: { parasha: Holiday | null; rows: ZmanimListRow[] } | null };

export type MonthView = {
  key: string;
  weekStart: WeekStart;
  prevMonthDay: string | null;
  nextMonthDay: string | null;
  /** null: the month could not be computed (failures says why). */
  weeks: MonthCell[][] | null;
  entries: MonthEntry[] | null;
};

export type CitySection = 'day' | 'ahead' | 'month';
export type SectionFailure = { section: CitySection; error: unknown };

export type CityView = {
  city: City;
  community: ZmanimCommunity;
  isDefaultCommunity: boolean;
  day: string;
  today: string;
  isToday: boolean;
  prevDay: string | null;
  nextDay: string | null;
  /** null: the day could not be computed. */
  list: ZmanDayList | null;
  /** A row of the day has no time (a dash), so the page explains it. */
  hasDash: boolean;
  /** null: the windows could not be computed. */
  ahead: AheadWindow[] | null;
  month: MonthView;
  il: boolean;
  /** The height the times count from, named in the note: Sephardi in Israel above sea level only. */
  heightM: number | null;
  failures: SectionFailure[];
};

/** The city as the engine reads a place. */
export function cityPlace(city: City): Place {
  return { latitude: city.latitude, longitude: city.longitude, elevationM: city.elevationM, timeZone: city.timeZone };
}

/** The owner's rule (spec §2.6): Sephardi in Israel, Ashkenazi abroad. */
export function defaultCommunity(city: City): ZmanimCommunity {
  return inIsrael(city.timeZone) ? 'sephardi' : 'ashkenazi';
}

/** Today in the city, yyyy-MM-dd, by the city's own clock. */
export function cityToday(city: City, now: Date): string {
  return instantToWallTime(now, city.timeZone).slice(0, 10);
}

function isRealDay(day: string): boolean {
  if (!DAY_KEY.test(day)) return false;
  const ms = Date.parse(`${day}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === day;
}

/** The same month and day `years` years on; 29 February is 28 February in a year without one. */
function yearsOn(day: string, years: number): string {
  const year = String(Number(day.slice(0, 4)) + years).padStart(4, '0');
  const moved = `${year}${day.slice(4)}`;
  return isRealDay(moved) ? moved : `${year}-02-28`;
}

function rangeOf(today: string): { first: string; last: string } {
  return { first: yearsOn(today, -1), last: yearsOn(today, 3) };
}

/** The days a URL may ask for: a year before today to three years after it, in the city (spec §4.3). */
export function publicRange(city: City, now: Date): { first: string; last: string } {
  return rangeOf(cityToday(city, now));
}

/** A parameter Next passes as one string; a repeated one (?date=a&date=b reaches the page as an array) is no value. */
const single = (value: string | string[] | undefined): string | undefined => (typeof value === 'string' ? value : undefined);

/**
 * The day and community a city page shows. `?date=yyyy-MM-dd` inside the range, else today; `?community=` one of the three
 * sets, else the city's default. A value that is missing, repeated, malformed, out of range or the default itself is
 * dropped (review focus d): the page shows today or the default, and nothing throws.
 */
export function readCityParams(city: City, search: Record<string, string | string[] | undefined>, now: Date): CityParams {
  const today = cityToday(city, now);
  const range = rangeOf(today);
  const asked = single(search.date);
  const day = asked !== undefined && isRealDay(asked) && asked >= range.first && asked <= range.last ? asked : null;
  const fallback = defaultCommunity(city);
  const wanted = single(search.community);
  const community = isCommunity(wanted) && wanted !== fallback ? wanted : null;
  return { day: day ?? today, community: community ?? fallback, today, dayFromParam: day !== null, communityFromParam: community !== null };
}

/** The days from `first` to `last`, both included. */
function daysFrom(first: string, last: string): string[] {
  const out: string[] = [];
  for (let day = first; day <= last; day = addDaysToDate(day, 1)) out.push(day);
  return out;
}

const weekdayOf = (day: string): number => new Date(`${day}T00:00:00Z`).getUTCDay();

function uniqueByTitle(holidays: Holiday[]): Holiday[] {
  const seen = new Set<string>();
  return holidays.filter((h) => (seen.has(h.title) ? false : (seen.add(h.title), true)));
}

/** Rows a list component draws, for one day's window rows (the hours line stays off: hours []). */
export function windowList(view: CityView, day: string, rows: ZmanimListRow[]): ZmanDayList {
  return { day, tz: view.city.timeZone, community: view.community, rows, hours: [] };
}

/** The view of `city` for `params`, in `locale`'s words: one memo, quiet, every section on its own. */
export function buildCityView(city: City, params: CityParams, locale: string): CityView {
  const place = cityPlace(city);
  const il = inIsrael(city.timeZone);
  const { day, community, today } = params;
  const range = rangeOf(today);
  const memo: ZmanMemo = new Map();
  const listOf = (d: string): ZmanDayList => zmanDayForPlace(place, community, d, { memo, quiet: true });
  const windowRows = (d: string): ZmanimListRow[] => listOf(d).rows.filter((row) => WINDOW_ROW_KEYS.includes(row.key));

  const failures: SectionFailure[] = [];
  const attempt = <T>(section: CitySection, build: () => T): T | null => {
    try {
      return build();
    } catch (error) {
      failures.push({ section, error });
      return null;
    }
  };

  const list = attempt('day', () => listOf(day));

  const ahead = attempt('ahead', (): AheadWindow[] => {
    const until = addDaysToDate(day, AHEAD_DAYS);
    const blocks = restDayBlocks(
      { from: startOfLocalDay(addDaysToDate(day, -LONGEST_BLOCK), city.timeZone), to: startOfLocalDay(addDaysToDate(until, LONGEST_BLOCK + 1), city.timeZone) },
      place,
      community,
    )
      // The one under way on the day shown (it ends on it or later), and every one that begins within AHEAD_DAYS
      .filter((block) => block.last >= day && block.eve <= until)
      .sort((a, b) => (a.eve < b.eve ? -1 : a.eve > b.eve ? 1 : 0));
    if (blocks.length === 0) return [];
    const holidays = holidaysInRange(blocks[0].eve, blocks[blocks.length - 1].last, locale, { il });
    return blocks.map((block) => {
      const found = daysFrom(addDaysToDate(block.eve, 1), block.last).flatMap((d) => holidays[d] ?? []);
      const chag = found.filter((h) => h.chag);
      return {
        eve: block.eve,
        last: block.last,
        holidays: uniqueByTitle(chag.length > 0 ? chag : found.filter((h) => h.kind === 'cholHamoed' || h.kind === 'specialShabbat')),
        parasha: found.find((h) => h.kind === 'parasha') ?? null,
        days: daysFrom(block.eve, block.last).map((d) => ({ day: d, rows: windowRows(d) })),
        endMissing: block.end === null,
      };
    });
  });

  const key = monthOf(day);
  const weekStart = weekStartFor({ culture: 'jewish', language: locale, tz: city.timeZone, tzKnown: true });
  const prevKey = addMonths(key, -1);
  const nextFirst = monthFirstDay(addMonths(key, 1));
  const prevFirst = monthFirstDay(prevKey);
  const prevMonthDay = monthLastDay(prevKey) >= range.first ? (prevFirst < range.first ? range.first : prevFirst) : null;
  const nextMonthDay = nextFirst <= range.last ? nextFirst : null;
  const body = attempt('month', () => {
    const firstDay = monthFirstDay(key);
    const lastDay = monthLastDay(key);
    const holidays = holidaysInRange(firstDay, lastDay, locale, { il });
    // A cell marks a holiday, not the weekly portion or its special Shabbat (they are no holiday: hebrew-holidays.ts)
    const marked = (d: string) => (holidays[d] ?? []).filter((h) => h.kind !== 'parasha' && h.kind !== 'specialShabbat');
    const weeks: MonthCell[][] = monthGrid(key, weekStart).map((week) =>
      week.map((d) => {
        const inMonth = d.slice(0, 7) === key;
        const marks = inMonth ? marked(d) : [];
        return { day: d, inMonth, inRange: d >= range.first && d <= range.last, holidays: marks, yomTov: marks.some((h) => h.chag), isToday: d === today, isShown: d === day };
      }),
    );
    const entries: MonthEntry[] = [];
    for (const d of daysFrom(firstDay, lastDay)) {
      const named = (holidays[d] ?? []).filter((h) => h.kind !== 'parasha');
      const saturday = weekdayOf(d) === 6;
      if (!saturday && named.length === 0) continue;
      entries.push({
        day: d,
        holidays: named,
        // The Shabbat's own rows: the Friday's candles, and the Saturday's end (or its "not before", into a Yom Tov)
        shabbat: saturday ? { parasha: (holidays[d] ?? []).find((h) => h.kind === 'parasha') ?? null, rows: [...windowRows(addDaysToDate(d, -1)), ...windowRows(d)] } : null,
      });
    }
    return { weeks, entries };
  });

  return {
    city,
    community,
    isDefaultCommunity: community === defaultCommunity(city),
    day,
    today,
    isToday: day === today,
    prevDay: day > range.first ? addDaysToDate(day, -1) : null,
    nextDay: day < range.last ? addDaysToDate(day, 1) : null,
    list,
    hasDash: list?.rows.some((row) => row.at === null) ?? false,
    ahead,
    month: { key, weekStart, prevMonthDay, nextMonthDay, weeks: body?.weeks ?? null, entries: body?.entries ?? null },
    il,
    heightM: community === 'sephardi' && il && city.elevationM !== null && city.elevationM > 0 ? city.elevationM : null,
    failures,
  };
}
```

- [ ] **Step 4: Run it green.** Run the same command as Step 2. Expected: two runs, each ending `15/15 passed` (the TZ=UTC child first), exit 0. If V5 or V6 fails on the windows, print `restDayBlocks` for that range before touching the filter. The filter reads only `eve` and `last`, so a mismatch means Task 1's blocks do not list every block whose days fall in the range: fix that in Task 1, not here.

- [ ] **Step 5: Run the other smokes the view leans on**, so nothing upstream moved under it: `scripts/smoke-zmanim.ts`, `scripts/smoke-zmanim-api.ts`, `scripts/smoke-hebrew-holidays.ts`, `scripts/smoke-dst.ts` and `scripts/smoke-site-landing.ts`. Run each with the env prefix of Step 2, in place of `scripts/smoke-zmanim-public-view.ts`. Expected: each ends `N/N passed`. smoke-dst walks src/ for `fromZonedTime` and local-field setters, and city-view.ts has none.

- [ ] **Step 6: Typecheck and lint the two files.**
```
cd /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/zp-wt && npx tsc --noEmit && npx eslint src/site/zmanim/city-view.ts scripts/smoke-zmanim-public-view.ts
```
Expected: no output, exit 0.

- [ ] **Step 7: Commit.**
```
cd /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/zp-wt && git add src/site/zmanim/city-view.ts scripts/smoke-zmanim-public-view.ts && git commit -m "feat(zmanim-site): a city's page as data: today, the Shabbat and Yom Tov ahead, the month

One memo per view and quiet, so a public page never touches the bot's process memo or
logs; holidays by the city's own schedule; each section caught on its own.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31"
```

---

### Task 6: City page

**Design plan (frontend-design, within the site's look; no new palette, no new font):**
- **Colour:** only the site's tokens.
  - `--ch-card` for the day's card.
  - `--ch-surface` for the windows, the countries and the segmented switch's track.
  - `--ch-accent` for the window rows (as the sheet does), today's outline, Yom Tov digits and links.
  - `--ch-accent-soft` for the chosen community and the day shown.
  - `--ch-muted` for the method line, the notes and the Hebrew numerals.
  - Every text pair is one landing G7 holds to 4.5:1: text, muted or accent on bg, surface, section, card or accent-soft, and button-text on button.
- **Type:** the site's system stack and its scale. `.site-h1` 36/44 px, `.site-h2` 28 px, `.site-h3` 19 px, body 17 px, the rows 15/16 px with tabular numerals (the sheet's own), and nothing under 13 px.
- **Layout:** one column, `.site-narrow` (760 px), aligned to the start (right in Hebrew):
```
< All cities
Zmanim and Shabbat times in Jerusalem           (h1)
+--------------------------------------------+
| [<]   Friday, 30 October 2026        [>]   |  the sun sheet's own nav, links in place of buttons
|        19 Cheshvan 5787                    |
|              Back to today                 |
| [ Sephardi | Ashkenazi | Chabad ]          |  segmented, current filled
| As Zmanei Yosef (Ohr HaChaim)...           |
| Dawn (alot hashachar) ............ 04:44   |  ZmanimRows (the app's rows, accent for windows)
| ...                                        |
| Halachic hour: 55:24 (GRA) · 66:29 (MGA)   |
+--------------------------------------------+
Shabbat and Yom Tov ahead                      (h2)
 [ Parashat Vayera                     ]       surface block per window
 [ Fri 30 Oct   Candle lighting  16:20 ]
 [ Sat 31 Oct   Shabbat ends     17:24 ]
October 2026                       [<] [>]     (h2 + month arrows)
Tishrei – Cheshvan 5787
 S  M  T  W  T  F  S                           <table>, th scope=col
 1  2  3 ...  (Hebrew day under, dot for a holiday, accent for Yom Tov, outline today, fill for the day shown)
 Holidays and Shabbat this month               (h3 + list with the rows)
note · FamCal block (.site-cta) · Sources
```
- **Principles:** the one bold element is the day's card, the app's sun sheet set on the page as a card. Everything else stays quiet: plain blocks, one dot per holiday, no decoration, no motion. Structure carries meaning: the accent means a Shabbat or Yom Tov time, the outline means today, and the fill means the day you are looking at.
- **Review against the brief:** the default treatment here would be a stats hero or a card per zman. Both are rejected for the app's own row list, which is the thing the page promises to match. The month is a real table, not a CSS grid of divs, for accessible names and column headers.

**Files:**
- Create: `app/[locale]/(site)/zmanim/[city]/page.tsx`
- Create: `components/site/zmanim/words.ts`, `components/site/zmanim/DayCard.tsx`, `components/site/zmanim/CommunitySwitch.tsx`, `components/site/zmanim/AheadCard.tsx`, `components/site/zmanim/MonthGrid.tsx`, `components/site/zmanim/MonthList.tsx`, `components/site/zmanim/PageNote.tsx`, `components/site/zmanim/Sources.tsx`, `components/site/zmanim/FamCalBlock.tsx`
- Create: `src/site/zmanim/links.ts`, `src/site/zmanim/sources.ts`
- Modify: `src/site/site-css.ts`
  - line 13, the header comment's motion line;
  - lines 16-18, the imports: add `ZMANIM_SHEET_CSS`;
  - lines 1345-1346: a new `ZMANIM_PAGE_CSS` block before the `SITE_CSS` line, and `SITE_CSS` gains `+ ZMANIM_SHEET_CSS + ZMANIM_PAGE_CSS`.
- Modify: `messages/en.json`, `messages/he.json`, `messages/ru.json`: a new top-level `zmanimSite`, inserted just before the line containing the top-level `  "ui": {` (no longer the last namespace once Task 3 appended `cities` and `countries`).
- Modify (Steps 1-6, first): `scripts/smoke-site-truth.ts` (`RU_TYPOGRAPHY` after `SITE_NAMESPACES`, the T6 check and its header comment); `messages/ru.json`, the four no-break-space fixes (`calendarHome.zmanim.names.MISHEYAKIR`, `calendarHome.zmanimList.shabbatYomTovEnds`, `calendarHome.zmanimList.noTime`, `calendarHome.zmanimList.failedBody`); `scripts/smoke-zmanim-sheet.ts` (a `flat()` helper and the two lines that compare `noTime` and `failedBody`).
- Test: `scripts/smoke-site-truth.ts` (T6, Steps 1-6), `scripts/smoke-zmanim-pages.ts` (new)

**Interfaces:**
- Consumes:
  - from Task 5: `buildCityView`, `readCityParams`, `cityPlace`, `cityToday`, `publicRange`, `defaultCommunity`, `windowList`, `CityView`, `AheadWindow`, `MonthCell`;
  - `cityBySlug` and `CITIES` (Task 3);
  - `ZmanimRows` (components/app-ui/ZmanimRows.tsx), `ZmanWordsT` (src/lib/calendar-view/zman-words.ts) and `ZMANIM_SHEET_CSS` (src/lib/calendar-view/zmanim-sheet-css.ts), all from Task 4;
  - `siteMetadata` and `pageUrl` (src/site/seo.ts), and `SitePage`, `StartButtons`, `HonestLine` and `startWords`;
  - `cheapestPlanWith` (src/site/plans.ts), `captureError` (src/lib/error-capture.ts) and `joinTitles` (src/lib/join-titles.ts);
  - from format.ts: `formatDayFull`, `formatDayShort`, `formatMonthTitle`, `formatWeekdayHeader` and `intlLocale`;
  - from hebrew-date.ts: `hebrewFullDate`, `hebrewDayLabel`, `hebrewCellLabel`, `hebrewCellMonth`, `hebrewMonthHeader` and `isHebrewMonthStart`;
  - `weekdayOrder` (grid.ts) and `COMMUNITIES` (sets.ts).
- Produces:
  - `cityPath(slug, q?)`, `localeHref(locale, path)`, `cityHref(locale, slug, q?)` and `CityQuery` (src/site/zmanim/links.ts);
  - `COPERNICUS_NOTICE` (src/site/zmanim/sources.ts);
  - `ZMANIM_PAGE_CSS` (src/site/site-css.ts);
  - the messages namespace `zmanimSite.*`;
  - the route `/[locale]/zmanim/[city]`.

Steps 1-6 come first (Contract note 20): they hold the app strings the zmanim pages show to Russian typography (smoke-site-truth T6) and fix the four Russian strings, because Step 14 runs T6 (Z8) over the rendered Russian page.

- [ ] **Step 1: Extend T6 in `scripts/smoke-site-truth.ts`.** Add, right after the line `const SITE_NAMESPACES = ['site', 'landing', 'legal', 'blog', 'share'];`:

```ts
/**
 * What T6 holds to Russian typography: the site's namespaces, and the app's strings the zmanim pages show on the site
 * (spec 2026-10-30-public-zmanim §6.3): the zmanim's names and opinions, the day list's words and the holidays.
 */
const RU_TYPOGRAPHY = [...SITE_NAMESPACES, 'calendarHome.zmanim.names', 'calendarHome.zmanim.opinions', 'calendarHome.zmanim.withOpinion', 'calendarHome.zmanimList', 'holidays'];
```

Replace the whole T6 check (from `await check('T6 Russian typography:` to its closing `});`) with:

```ts
  await check('T6 Russian typography: in every Russian site and legal string (the site\'s namespaces) and in the app\'s strings the zmanim pages show (the zmanim\'s names and opinions, the day list\'s words, the holidays), no one-letter word (в, с, к, о, у, и, а, я) is followed by a plain space and no plain space comes before an em dash "—": a no-break space (U+00A0) binds them, so a line never ends on the word or starts with the dash', () => {
    const found: string[] = [];
    for (const at of RU_TYPOGRAPHY) {
      const node = at.split('.').reduce<unknown>((n, k) => (n && typeof n === 'object' ? (n as Row)[k] : undefined), messages.ru);
      assert(node !== undefined, `no ${at} in the Russian messages`);
      for (const [key, text] of leaves(node, at)) {
        const loose = text.match(/(?<![^\s«(„"—*])[вскоуиая] /giu);
        if (loose) found.push(`${key}: ${show(loose.map((x) => x.trim()))}`);
        if (text.includes(' —')) found.push(`${key}: a plain space before "—": ${show(text.slice(Math.max(0, text.indexOf(' —') - 12), text.indexOf(' —') + 3))}`);
      }
    }
    assert(found.length === 0, show(found));
  });
```

In the header comment, replace these three lines:

```ts
//  - T6 Russian site and legal strings (site, landing, share, blog, legal) bind a one-letter word (в, с, к, о, у, и, а, я)
//    to the next with a no-break space, so none ends a line, and put a no-break space, never a plain one, before an em
//    dash "—", so none starts a line.
```

with:

```ts
//  - T6 Russian site and legal strings (the site's namespaces), and the app's strings the zmanim pages show (the
//    zmanim's names and opinions, the day list's words, the holidays), bind a one-letter word (в, с, к, о, у, и, а, я)
//    to the next with a no-break space, so none ends a line, and put a no-break space, never a plain one, before an em
//    dash "—", so none starts a line.
```

- [ ] **Step 2: Run it red.** `RUN scripts/smoke-site-truth.ts`. Expected: `FAIL  T6 Russian typography: ...` with exactly these four keys (checked against HEAD with the T6 regex):

```
calendarHome.zmanim.names.MISHEYAKIR: ["и"]
calendarHome.zmanimList.shabbatYomTovEnds: ["и"]
calendarHome.zmanimList.noTime: ["В"]
calendarHome.zmanimList.failedBody: ["и"]
```

and `5/6 passed`. Task 2's two names (`pesachIi`, `pesachViii`) have no one-letter word, so they are not listed; if any `holidays.*` key is, bind it the same way in Step 3 (held to the same rule). `calendarHome.zmanim.namesAfter.MISHEYAKIR` ("времени талита и тфилин") is not on the pages (it is the name after "before"/"after" in a reminder rule), so it is not in the list and stays as it is (spec §8 names four strings).

- [ ] **Step 3: Fix the four strings in `messages/ru.json`.** Each is one Edit (the old line is unique):
  - `calendarHome.zmanim.names.MISHEYAKIR`: `"MISHEYAKIR": "Время талита и тфилин",` -> `"MISHEYAKIR": "Время талита и тфилин",`
  - `calendarHome.zmanimList.shabbatYomTovEnds`: `"shabbatYomTovEnds": "Исход Шаббата и праздника",` -> `"shabbatYomTovEnds": "Исход Шаббата и праздника",`
  - `calendarHome.zmanimList.noTime`: `"noTime": "В этот день такого времени нет",` -> `"noTime": "В этот день такого времени нет",`
  - `calendarHome.zmanimList.failedBody`: `"failedBody": "Проверьте подключение и попробуйте ещё раз."` -> `"failedBody": "Проверьте подключение и попробуйте ещё раз."`

  (It is the one under `"names": {`; the text under `"namesAfter": {` reads "времени талита и тфилин", lower-case, and is not touched.)

- [ ] **Step 4: Update `scripts/smoke-zmanim-sheet.ts`, which reads the sheet's text with whitespace folded (`\s` takes in U+00A0) and compares it to the raw message.** Find the line `const textOf = (node: FakeNode): string => node.textContent.replace(/\s+/g, ' ').trim();` (Task 4 moved it down) and add after it:

```ts
/** A message as textOf reads the page: Russian's no-break spaces (smoke-site-truth T6) read as plain ones. */
const flat = (text: string): string => text.replace(/\s+/g, ' ').trim();
```

  In the line that contains it, replace `textOf(spoken) === messages[locale].calendarHome.zmanimList.noTime` with `textOf(spoken) === flat(messages[locale].calendarHome.zmanimList.noTime)`.
  In the line that contains it, replace `textOf(card).includes(copy.zmanimList.failedTitle) && textOf(card).includes(copy.zmanimList.failedBody)` with `textOf(card).includes(flat(copy.zmanimList.failedTitle)) && textOf(card).includes(flat(copy.zmanimList.failedBody))`.
  The existing expected `'Исход Шаббата и праздника'` (the window row's name check) stays: it is compared to `textOf(...)`, which folds the new no-break space to a plain one.

- [ ] **Step 5: Run green.** `RUN scripts/smoke-site-truth.ts` (expected `6/6 passed`), `RUN scripts/smoke-zmanim-sheet.ts` (all pass), `RUN scripts/smoke-calendar-home-copy.ts` (all pass), `RUN scripts/smoke-ru-formal.ts` (all pass). Then the whole set, since bot replies and voice scripts read these names: `cd /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/zp-wt && bash scripts/ci-smokes.sh` (expected every smoke file to pass except smoke-site-seo and smoke-site-pages, which fail in the worktree at the base commit too: Global Constraints; the controller's CI mirror runs them). A smoke that compares a folded text to one of the four raw strings fails here; fix it the same way as Step 4 (fold the message), never by reverting the string. Then `cd /Users/razielgershoni/development/famcalbot && npx prisma generate`.

- [ ] **Step 6: Commit.**

```bash
cd /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/zp-wt
git add scripts/smoke-site-truth.ts messages/ru.json scripts/smoke-zmanim-sheet.ts
git commit -F - <<'EOF'
fix(copy): the Russian zmanim words the public pages show keep their no-break spaces

T6 now also holds the zmanim's names and opinions, the day list's words and
the holidays, which the zmanim pages show on the site. Four strings bind
their one-letter word: MISHEYAKIR, shabbatYomTovEnds, noTime, failedBody.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
EOF
```

- [ ] **Step 7: Write the failing smoke.** Create `scripts/smoke-zmanim-pages.ts`:

```ts
// Smoke test for the public zmanim pages (plan 6a Tasks 6 and 7; spec 2026-10-30-public-zmanim §4, §6.3, §6.5, §9).
//
//  - Z1 a city's page in en, he and ru: the day's rows are zmanDayForPlace's for the city (Jerusalem Sephardi with its
//    height, London in June with dawn's dash and the note, Moscow in June with tallit and tefillin's dash), its date in
//    both calendars, the community's method line, and the note (the height and 20 minutes, or the plain one);
//  - Z2 the windows ahead: Saint Petersburg's June Friday has candle lighting and an end with no time (and its line);
//    New York's next Pesach shows the two days of Yom Tov by name and the "not before" line;
//  - Z3 the metadata: the titles of §6.3, the description, the clean canonical and the four languages; none for an
//    unknown city;
//  - Z4 the links: every day, month, cell and community link is a plain anchor with rel="nofollow"; the day links keep
//    the community, the community links keep the date, Today keeps the community; the language links are the clean URL;
//    the month is a table with seven column headers, each cell link named by its full Gregorian and Hebrew date (and its
//    holiday), today carries aria-current="date" and the day shown is filled;
//  - Z5 bad and out-of-range parameters show today and the default community; at the range's ends the previous or next
//    links are left out;
//  - Z6 an unknown city: notFound(), so the site's 404;
//  - Z7 a section that fails is logged (captureError, with the city, the day and the community) and says so, and the rest
//    of the page renders;
//  - Z8 every rendered page passes the truth list, the no-emoji rule, the raw-key check and, in Russian, T6;
//  - Z9 the CSS: the kit's lint, every tap target at least 44 px, no hover, motion only under no-preference; the sheet's
//    rows and the page's CSS are each in the site's sheet once;
//  - Z10 no request leaves the server while a page renders; no file under app/[locale]/(site) or components/site calls
//    fetch, loads a script by src or imports next/script; and no component of the city page is a client one (only Near
//    me is);
//  - Z12 (review focus c) the Hebrew page: every time of day in <bdi dir="ltr">, the arrows with the app's RTL-flipped
//    icon, and the month grid from Sunday at the start (right) edge;
//  - Z13 (review focus d) repeated or odd query values are ignored without a throw: today and the default community.
//
// The pages run as Next runs them on the server (next-intl's server API over the real messages). No network, no DB.
// Run with the fake env (never the real one), from the repo root, as ci-smokes.sh does.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createElement as h, type ReactElement } from 'react';
import { lintCss } from './lib/css-lint';
import { assert, check, decodeEntities, EMOJI, finish, LOCALES, load, messages, OFF_SITE, readSource, request, render, ROOT, show, stub, stubIntlServer, textOf, UNTRUE, type Locale, type Row } from './lib/site-harness';

const nodeRequire = createRequire(__filename);
const { NextIntlClientProvider } = nodeRequire('next-intl');
const { AppRouterContext } = nodeRequire('next/dist/shared/lib/app-router-context.shared-runtime');
const { HDate } = nodeRequire('@hebcal/hdate');
const router = { push() {}, replace() {}, prefetch() {}, back() {}, forward() {}, refresh() {} };

const attrs = (html: string, tag: string) => [...html.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, 'g'))].map((m) => m[1]);
const attr = (a: string, name: string) => new RegExp(`(?:^|\\s)${name}="([^"]*)"`, 'i').exec(a)?.[1];
const prefix = (l: Locale) => (l === 'en' ? '' : `/${l}`);
/** A message key left in the text, for every namespace the zmanim pages read. */
const RAW_KEY = /\b(?:landing|site|blog|share|legal|ui|zmanimSite|cities|countries|calendarHome|holidays|zmanim)\.[a-z]+[A-Za-z.]*\b/;
/** smoke-site-truth's T6: a one-letter Russian word followed by a plain space. */
const T6_LOOSE = /(?<![^\s«(„"—*])[вскоуиая] /iu;
/** The tap targets the zmanim pages add; Task 7 adds Near me's and the city list's. */
const TAPS = ['.site-zm-arrow', '.site-zm-today a', '.site-zm-switch a', '.site-zm-cell', '.site-zm-sources a'];

async function main() {
  stubIntlServer();
  class NotFound extends Error {}
  stub(nodeRequire.resolve('next/navigation'), { ...nodeRequire('next/navigation'), notFound: () => { throw new NotFound('NEXT_NOT_FOUND'); } });
  const captured: Row[] = [];
  stub('src/lib/error-capture.ts', {
    captureError: (error: unknown, context: string, extra: Row) => void captured.push({ error, context, extra }),
    captureWarning: () => undefined,
    captureInfo: () => undefined,
  });
  // The holidays and the day list as they are, with a switch that makes one section fail (spec §6.5)
  const fail = { holidays: false, day: '' };
  const realHolidays = nodeRequire(path.join(ROOT, 'src/services/hebrew-holidays.ts'));
  stub('src/services/hebrew-holidays.ts', {
    ...realHolidays,
    holidaysInRange: (...args: unknown[]) => {
      if (fail.holidays) throw new Error('hebcal failed (smoke)');
      return realHolidays.holidaysInRange(...args);
    },
  });
  const realDayList = nodeRequire(path.join(ROOT, 'src/services/zmanim/day-list.ts'));
  stub('src/services/zmanim/day-list.ts', {
    ...realDayList,
    zmanDayForPlace: (place: Row, community: string, day: string, options?: Row) => {
      if (day === fail.day) throw new Error('the day failed (smoke)');
      return realDayList.zmanDayForPlace(place, community, day, options);
    },
  });
  const fetched: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    fetched.push(String(input));
    throw new Error('no network in this smoke');
  }) as typeof fetch;

  const { default: CityPage, generateMetadata } = await load('app/[locale]/(site)/zmanim/[city]/page.tsx');
  const v = await load('src/site/zmanim/city-view.ts');
  const { cityBySlug } = await load('src/site/cities.ts');
  const { formatDayFull, formatTime } = await load('src/lib/calendar-view/format.ts');
  const { hebrewFullDate, dayKeyOfHDate } = await load('src/lib/calendar-view/hebrew-date.ts');
  const { addDaysToDate } = await load('src/utils/day-events.ts');
  const { pageUrl } = await load('src/site/seo.ts');

  const wrap = (locale: Locale, el: ReactElement) =>
    render(h(AppRouterContext.Provider, { value: router }, h(NextIntlClientProvider, { locale, timeZone: 'Asia/Jerusalem', messages: { site: messages[locale].site } } as never, el) as unknown as ReactElement));
  const cityPage = async (locale: Locale, slug: string, search: Row = {}) => {
    request.locale = locale;
    const el = (await CityPage({ params: Promise.resolve({ locale, city: slug }), searchParams: Promise.resolve(search) })) as ReactElement;
    return wrap(locale, el);
  };
  const common = (locale: Locale, html: string, where: string) => {
    assert(html.includes('class="site-header"') && html.includes('class="site-footer"'), `${where} ${locale}: not in the site's chrome`);
    assert(!EMOJI.test(html.replace(/https:\/\/wa\.me\/[^"\s]+/g, '')), `${where} ${locale}: an emoji: ${html.match(EMOJI)?.[0]}`);
    const text = decodeEntities(html);
    for (const [claim, pattern] of [...UNTRUE, ...OFF_SITE]) assert(!pattern.test(text), `${where} ${locale}: ${claim}: ${text.match(pattern)?.[0]}`);
    const visible = decodeEntities(textOf(html)).replace(/famcal\.bot|t\.me\/\S+|wa\.me\/\S+/g, '');
    assert(!RAW_KEY.test(visible), `${where} ${locale}: a raw key: ${visible.match(RAW_KEY)?.[0]}`);
    if (locale === 'ru') {
      const loose = visible.match(new RegExp(`.{0,24}(?:${T6_LOOSE.source}| —).{0,24}`, 'iu'))?.[0];
      assert(!T6_LOOSE.test(visible) && !visible.includes(' —'), `${where} ru: not bound by a no-break space: ${show(loose)}`);
    }
  };
  const between = (html: string, from: string, to?: string) => {
    const a = html.indexOf(from);
    assert(a >= 0, `no ${from}`);
    const b = to ? html.indexOf(to, a + from.length) : -1;
    return html.slice(a, b < 0 ? undefined : b);
  };
  const rowsOf = (html: string) =>
    [...html.matchAll(/<li\b([^>]*)>([\s\S]*?)<\/li>/g)]
      .filter((m) => attr(m[1], 'data-zman'))
      .map((m) => ({ key: attr(m[1], 'data-zman'), time: /<bdi dir="ltr">([^<]*)<\/bdi>/.exec(m[2])?.[1] ?? null }));
  const wantRows = (list: Row, locale: Locale) => list.rows.map((r: Row) => ({ key: r.key, time: r.at === null ? null : formatTime(r.at, list.tz, locale) }));
  const dayCard = (html: string) => between(html, '<section class="site-zm-card"', '</section>');
  const real = (slug: string, community: string, day: string): Row => realDayList.zmanDayForPlace(v.cityPlace(cityBySlug(slug)), community, day, { memo: new Map(), quiet: true });
  const todayOf = (slug: string): string => v.cityToday(cityBySlug(slug), new Date());
  const genitive = (locale: Locale) => (locale === 'ru' ? messages.ru.calendarHome.hebrewMonthGenitive : undefined);
  /** The year of the next 21 June that is at least a week away. */
  const juneYear = (day: string) => Number(day.slice(0, 4)) + (day.slice(5) > '06-14' ? 1 : 0);
  const fridayOnOrBefore = (day: string) => addDaysToDate(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() + 2) % 7));
  /** The next Pesach whose eve is after `today`: its eve and its first day. */
  const nextPesach = (today: string) => {
    for (let year = new HDate(new Date(`${today}T12:00:00`)).getFullYear(); ; year++) {
      const first: string = dayKeyOfHDate(new HDate(15, 'Nisan', year));
      if (addDaysToDate(first, -1) > today) return { eve: addDaysToDate(first, -1), first };
    }
  };
  const anchorsOf = (html: string) =>
    attrs(html, 'a').map((a) => ({ href: decodeEntities(attr(a, 'href') ?? ''), rel: attr(a, 'rel'), hreflang: attr(a, 'hreflang'), current: attr(a, 'aria-current'), label: attr(a, 'aria-label') ? decodeEntities(attr(a, 'aria-label') as string) : undefined, cls: attr(a, 'class') }));
  const query = (href: string) => new URLSearchParams(href.split('?')[1] ?? '');

  await check('Z1 a city\'s page in en, he and ru: the rows are zmanDayForPlace\'s (Jerusalem with its height, London\'s and Moscow\'s June dashes and the note), the date in both calendars, the method line and the note', async () => {
    const y = juneYear(todayOf('london'));
    const cases: [string, Row, string, string][] = [
      ['jerusalem', {}, 'sephardi', todayOf('jerusalem')],
      ['london', { date: `${y}-06-21` }, 'ashkenazi', `${y}-06-21`],
      ['moscow', { date: `${y}-06-21` }, 'ashkenazi', `${y}-06-21`],
    ];
    for (const locale of LOCALES) {
      const z = messages[locale].zmanimSite;
      for (const [slug, search, community, day] of cases) {
        const html = await cityPage(locale, slug, search);
        common(locale, html, slug);
        const name = messages[locale].cities[slug];
        const text = decodeEntities(textOf(html));
        assert(decodeEntities(html).includes(`<h1 class="site-h1 site-page-title">${z.city.heading.replace('{city}', name)}</h1>`), `${locale} ${slug}: the heading`);
        const card = dayCard(html);
        const list = real(slug, community, day);
        assert(show(rowsOf(card)) === show(wantRows(list, locale)), `${locale} ${slug}: the rows ${show(rowsOf(card))}, want ${show(wantRows(list, locale))}`);
        const cardText = decodeEntities(textOf(card));
        assert(cardText.includes(formatDayFull(day, locale)) && cardText.includes(hebrewFullDate(day, locale, genitive(locale))), `${locale} ${slug}: the date`);
        assert(cardText.includes(z.day.method[community === 'sephardi' ? 'sephardi' : 'ashkenazi']), `${locale} ${slug}: the method line`);
        const dashed = list.rows.some((r: Row) => r.at === null);
        assert(cardText.includes(z.day.dashNote) === dashed, `${locale} ${slug}: the dash note (a dash: ${dashed})`);
        if (slug === 'london') assert(rowsOf(card).find((r) => r.key === 'ALOT')?.time === null, `${locale}: London's dawn has a time`);
        if (slug === 'moscow') assert(rowsOf(card).find((r) => r.key === 'MISHEYAKIR')?.time === null, `${locale}: Moscow's tallit and tefillin have a time`);
        const height = cityBySlug(slug).elevationM;
        const note = slug === 'jerusalem' ? z.note.height.replace('{city}', name).replace('{height}', String(height)) : z.note.plain.replace('{city}', name);
        assert(text.includes(note), `${locale} ${slug}: the note`);
      }
    }
  });

  await check('Z2 the windows ahead: Saint Petersburg\'s June Friday has candle lighting and an end with no time; New York\'s next Pesach names its two days of Yom Tov and shows "not before"', async () => {
    const friday = fridayOnOrBefore(`${juneYear(todayOf('saint-petersburg'))}-06-21`);
    const { eve, first } = nextPesach(todayOf('new-york'));
    for (const locale of LOCALES) {
      const z = messages[locale].zmanimSite;
      const spb = await cityPage(locale, 'saint-petersburg', { date: friday });
      common(locale, spb, 'saint-petersburg');
      assert(rowsOf(dayCard(spb)).find((r) => r.key === 'CANDLE_LIGHTING')?.time, `${locale}: no candle lighting on ${friday}`);
      const spbWindow = between(between(spb, 'aria-labelledby="ahead-title"', 'aria-labelledby="month-title"'), '<section class="site-zm-window"', '</section>');
      const rows = rowsOf(spbWindow);
      const end = rows[rows.length - 1];
      assert(rows[0]?.key === 'CANDLE_LIGHTING' && rows[0].time && end?.key === 'SHABBAT_ENDS' && end.time === null, `${locale}: Saint Petersburg's window ${show(rows)}`);
      assert(decodeEntities(textOf(spbWindow)).includes(z.ahead.noEnd), `${locale}: no line for the missing end`);
      const ny = await cityPage(locale, 'new-york', { date: eve });
      common(locale, ny, 'new-york');
      const window = between(between(ny, 'aria-labelledby="ahead-title"', 'aria-labelledby="month-title"'), '<section class="site-zm-window"', '</section>');
      assert(rowsOf(window).some((r) => r.key === 'CANDLE_LIGHTING_NOT_BEFORE' && r.time), `${locale}: no "not before" in ${show(rowsOf(window))}`);
      const days = realHolidays.holidaysInRange(first, addDaysToDate(first, 1), locale, { il: false }) as Record<string, Row[]>;
      const chag = Object.values(days).flat().filter((x) => x.chag).map((x) => x.title as string);
      const heading = decodeEntities(textOf(between(window, '<h3', '</h3>')));
      assert(chag.length === 2 && chag.every((title) => heading.includes(title)), `${locale}: the window's name ${heading}, want ${show(chag)}`);
    }
  });

  await check('Z3 the metadata: the titles of §6.3, the description, the clean canonical and the four languages; none for an unknown city', async () => {
    const want: Record<Locale, string> = { en: 'Shabbat times and zmanim in Jerusalem', he: 'זמני שבת וזמני היום בירושלים', ru: 'Время шаббата и зманим: Иерусалим' };
    for (const locale of LOCALES) {
      request.locale = locale;
      const meta = await generateMetadata({ params: Promise.resolve({ locale, city: 'jerusalem' }) });
      assert(meta.title === want[locale], `${locale}: the title ${show(meta.title)}`);
      assert(meta.description === messages[locale].zmanimSite.city.description.replace('{city}', messages[locale].cities.jerusalem), `${locale}: the description`);
      assert(meta.alternates.canonical === pageUrl(locale, '/zmanim/jerusalem') && !String(meta.alternates.canonical).includes('?'), `${locale}: the canonical ${meta.alternates.canonical}`);
      assert(show(Object.keys(meta.alternates.languages).sort()) === show(['en', 'he', 'ru', 'x-default']), `${locale}: the languages`);
      assert(show(await generateMetadata({ params: Promise.resolve({ locale, city: 'atlantis' }) })) === '{}', `${locale}: metadata for an unknown city`);
    }
  });

  await check('Z4 the links: plain anchors with rel="nofollow"; the date and the community kept; the clean language links; the month as a table with named cells, today and the day shown', async () => {
    const today = todayOf('jerusalem');
    const date = addDaysToDate(today, 10);
    let year = new HDate(new Date(`${today}T12:00:00`)).getFullYear();
    let roshHashana: string = dayKeyOfHDate(new HDate(1, 'Tishrei', year));
    while (roshHashana <= today) roshHashana = dayKeyOfHDate(new HDate(1, 'Tishrei', ++year));
    for (const locale of LOCALES) {
      const z = messages[locale].zmanimSite;
      const base = `${prefix(locale)}/zmanim/jerusalem`;
      const html = await cityPage(locale, 'jerusalem', { date, community: 'chabad' });
      common(locale, html, 'jerusalem chabad');
      const anchors = anchorsOf(html);
      const isLanguage = (a: Row) => Boolean(a.hreflang) || (a.current === 'true' && a.href === base);
      const own = anchors.filter((a) => a.href.startsWith(base) && !isLanguage(a));
      assert(own.length > 30 && own.every((a) => a.rel === 'nofollow'), `${locale}: links without nofollow ${show(own.filter((a) => a.rel !== 'nofollow'))}`);
      const dayLinks = own.filter((a) => a.label === z.day.previous || a.label === z.day.next);
      assert(dayLinks.length === 2 && dayLinks.every((a) => query(a.href).get('community') === 'chabad' && query(a.href).get('date')), `${locale}: the day links ${show(dayLinks)}`);
      const switches = attrs(between(html, '<ul class="site-zm-switch"', '</ul>'), 'a').map((a) => ({ href: decodeEntities(attr(a, 'href') ?? ''), current: attr(a, 'aria-current') }));
      assert(show(switches.map((a) => a.href)) === show([`${base}?date=${date}`, `${base}?date=${date}&community=ashkenazi`, `${base}?date=${date}&community=chabad`]), `${locale}: the community links ${show(switches)}`);
      assert(switches[2].current === 'true' && !switches[0].current && !switches[1].current, `${locale}: the current community`);
      const todayLink = own.find((a) => !query(a.href).get('date') && query(a.href).get('community') === 'chabad');
      assert(todayLink, `${locale}: no Today link keeping the community`);
      const kept = own.filter((a) => !switches.some((s) => s.href === a.href));
      assert(kept.every((a) => query(a.href).get('community') === 'chabad'), `${locale}: a link drops the community ${show(kept.filter((a) => query(a.href).get('community') !== 'chabad'))}`);
      const languages = anchors.filter(isLanguage);
      for (const l of LOCALES) assert(languages.some((a) => a.href === (l === locale ? base : `/${l}/zmanim/jerusalem`)), `${locale}: no clean link to ${l} in ${show(languages)}`);
      assert(languages.every((a) => !a.href.includes('?')), `${locale}: a language link carries the parameters`);
      const grid = between(html, '<table class="site-zm-grid"', '</table>');
      assert((grid.match(/<th scope="col">/g) ?? []).length === 7, `${locale}: the column headers`);
      const cell = anchorsOf(grid).find((a) => query(a.href).get('date') === date);
      assert(cell && cell.label?.startsWith(formatDayFull(date, locale)) && cell.label.includes(hebrewFullDate(date, locale, genitive(locale))) && /\bis-shown\b/.test(cell.cls ?? ''), `${locale}: the shown day's cell ${show(cell)}`);
      // Today's cell, on today's month with no parameters
      const plain = await cityPage(locale, 'jerusalem');
      const current = anchorsOf(between(plain, '<table class="site-zm-grid"', '</table>')).filter((a) => a.current === 'date');
      assert(current.length === 1 && query(current[0].href).get('date') === today, `${locale}: today's cell ${show(current)}`);
      // A holiday's name in its cell's name
      const rh = await cityPage(locale, 'jerusalem', { date: roshHashana });
      const rhCell = anchorsOf(between(rh, '<table class="site-zm-grid"', '</table>')).find((a) => query(a.href).get('date') === roshHashana);
      const title = (realHolidays.holidaysInRange(roshHashana, roshHashana, locale, { il: true })[roshHashana] as Row[]).find((x) => x.chag)?.title;
      assert(title && rhCell?.label?.includes(title), `${locale}: Rosh Hashana's cell ${show(rhCell)} lacks ${title}`);
    }
  });

  await check('Z5 bad and out-of-range parameters show today and the default community; at the range\'s ends the previous or next links are left out', async () => {
    const today = todayOf('jerusalem');
    const range = v.publicRange(cityBySlug('jerusalem'), new Date());
    for (const locale of LOCALES) {
      const z = messages[locale].zmanimSite;
      const sephardi = messages[locale].calendarHome.zmanimList.community.sephardi;
      for (const search of [{ date: '2026-13-45', community: 'reform' }, { date: addDaysToDate(range.last, 1) }, { date: addDaysToDate(range.first, -1) }, { date: 'tomorrow' }]) {
        const html = await cityPage(locale, 'jerusalem', search);
        const shown = decodeEntities(textOf(between(html, '<p class="ch-zl-day">', '</p>')));
        assert(shown === formatDayFull(today, locale), `${locale} ${show(search)}: shows ${shown}`);
        const current = /aria-current="true">([^<]+)</.exec(between(html, '<ul class="site-zm-switch"', '</ul>'))?.[1];
        assert(current === sephardi, `${locale} ${show(search)}: the community ${current}`);
      }
      const labels = (html: string) => anchorsOf(html).map((a) => a.label);
      const first = await cityPage(locale, 'jerusalem', { date: range.first });
      assert(!labels(first).includes(z.day.previous) && labels(first).includes(z.day.next) && !labels(first).includes(z.month.previous), `${locale}: the first day's links`);
      const last = await cityPage(locale, 'jerusalem', { date: range.last });
      assert(!labels(last).includes(z.day.next) && labels(last).includes(z.day.previous) && !labels(last).includes(z.month.next), `${locale}: the last day's links`);
    }
  });

  await check('Z6 an unknown city: the page calls notFound(), so the site\'s 404', async () => {
    for (const locale of LOCALES) {
      let thrown: unknown = null;
      try {
        await CityPage({ params: Promise.resolve({ locale, city: 'atlantis' }), searchParams: Promise.resolve({}) });
      } catch (err) {
        thrown = err;
      }
      assert(thrown instanceof NotFound, `${locale}: no notFound() for an unknown city`);
    }
  });

  await check('Z7 a section that fails is logged with the city, the day and the community, and says so; the rest of the page renders', async () => {
    // A Wednesday that no window holds, so only the day's own list asks for it
    let date = addDaysToDate(todayOf('jerusalem'), 2);
    for (;;) {
      const c = cityBySlug('jerusalem');
      const view = v.buildCityView(c, v.readCityParams(c, { date }, new Date()), 'en');
      if (new Date(`${date}T00:00:00Z`).getUTCDay() === 3 && !view.ahead.some((w: Row) => w.eve <= date && date <= w.last)) break;
      date = addDaysToDate(date, 1);
    }
    try {
      fail.holidays = true;
      captured.length = 0;
      for (const locale of LOCALES) {
        const z = messages[locale].zmanimSite;
        const html = await cityPage(locale, 'jerusalem', { date });
        const text = decodeEntities(textOf(html));
        assert(text.includes(z.ahead.failed) && text.includes(z.month.failed) && !text.includes(z.day.failed) && rowsOf(dayCard(html)).length > 0, `${locale}: the holidays failing`);
      }
      assert(captured.length === 6 && captured.every((c) => c.context === 'zmanim-site' && c.extra.slug === 'jerusalem' && c.extra.day === date && c.extra.community === 'sephardi'), `captured ${show(captured.map((c) => [c.context, c.extra]))}`);
      assert(show(captured.slice(0, 2).map((c) => c.extra.section)) === show(['ahead', 'month']), 'the sections named');
      fail.holidays = false;
      fail.day = date;
      captured.length = 0;
      for (const locale of LOCALES) {
        const z = messages[locale].zmanimSite;
        const html = await cityPage(locale, 'jerusalem', { date });
        const text = decodeEntities(textOf(html));
        assert(text.includes(z.day.failed) && !text.includes(z.ahead.failed) && !text.includes(z.month.failed) && html.includes('<table class="site-zm-grid"'), `${locale}: the day failing`);
      }
      assert(captured.length === 3 && captured.every((c) => c.extra.section === 'day'), `captured ${show(captured.map((c) => c.extra))}`);
    } finally {
      fail.holidays = false;
      fail.day = '';
    }
  });

  await check('Z12 (review focus c) the Hebrew page: every time of day sits in <bdi dir="ltr">, the previous and next arrows carry the app\'s RTL-flipped icon (.ch-flip, flipped under [dir=rtl]), and the month grid starts each row with Sunday, which the page\'s dir="rtl" puts at the start (right) edge', async () => {
    const friday = fridayOnOrBefore(addDaysToDate(todayOf('jerusalem'), 7));
    const html = await cityPage('he', 'jerusalem', { date: friday });
    common('he', html, 'jerusalem he');
    // Times of day: none outside a <bdi dir="ltr"> (the halachic hour line is a length, minutes:seconds, not a time of day)
    const times = [...html.matchAll(/<bdi dir="ltr">([^<]*)<\/bdi>/g)].map((m) => m[1]);
    assert(times.length >= 15 && times.every((x) => /^\d{1,2}:\d{2}$/.test(x)), `he: the times in <bdi> ${show(times)}`);
    const outside = decodeEntities(textOf(html.replace(/<bdi dir="ltr">[^<]*<\/bdi>/g, ' ').replace(/<p class="ch-zl-hours">[\s\S]*?<\/p>/g, ' '))).match(/\d{1,2}:\d{2}/g);
    assert(!outside, `he: a time outside <bdi dir="ltr">: ${show(outside)}`);
    // The arrows: the sun sheet's own icons (ChevronLeft for previous, ChevronRight for next, each with .ch-flip), flipped in RTL
    const z = messages.he.zmanimSite;
    const arrows = [...html.matchAll(/<a class="site-zm-arrow"([^>]*)>([\s\S]*?)<\/a>/g)];
    for (const [label, icon] of [[z.day.previous, 'chevron-left'], [z.day.next, 'chevron-right'], [z.month.previous, 'chevron-left'], [z.month.next, 'chevron-right']] as const) {
      const arrow = arrows.find((m) => decodeEntities(attr(m[1], 'aria-label') ?? '') === label);
      assert(arrow && new RegExp(`<svg[^>]*class="[^"]*\\blucide-${icon}\\b[^"]*\\bch-flip\\b`).test(arrow[2]), `he: the arrow "${label}": ${show(arrow?.[2].slice(0, 200))}`);
    }
    const { ZMANIM_PAGE_CSS } = await load('src/site/site-css.ts');
    assert(/\n\[dir='rtl'\] \.site-zm-arrow \.ch-flip \{\s*transform: scaleX\(-1\);\s*\}/.test(ZMANIM_PAGE_CSS), 'no RTL flip for the arrows\' icons');
    assert(/dir=\{locale === 'he' \? 'rtl' : 'ltr'\}/.test(readSource('app/[locale]/(site)/layout.tsx')), 'the site layout does not set dir="rtl" for Hebrew');
    // The month: no direction of its own, Sunday's column first, each week's dates in weekday order from Sunday
    const grid = between(html, '<table class="site-zm-grid"', '</table>');
    assert(!/\bdir="/.test(grid.slice(0, grid.indexOf('>'))) && !/direction\s*:/.test(ZMANIM_PAGE_CSS), 'the grid sets a direction of its own');
    const sunday = new Intl.DateTimeFormat('he', { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 9, 18, 12)));
    const firstHeader = decodeEntities(textOf(between(grid, '<th scope="col">', '</th>')));
    assert(firstHeader.includes(sunday), `he: the first column is ${firstHeader}, not ${sunday}`);
    const weeks = [...between(grid, '<tbody', '</tbody>').matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map((row) =>
      [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((cell) => query(decodeEntities(attr(attrs(cell[1], 'a')[0] ?? '', 'href') ?? '')).get('date')),
    );
    assert(weeks.length >= 4 && weeks.every((w) => w.length === 7 && w.every((d, i) => d === null || new Date(`${d}T00:00:00Z`).getUTCDay() === i)), `he: a week not from Sunday ${show(weeks)}`);
  });

  await check('Z13 (review focus d) repeated or odd query values (a repeated date or community, community[]=x, a 10,000-character date, 30 February) are ignored without a throw: the page shows today and the default community', async () => {
    const today = todayOf('jerusalem');
    const odd: Row[] = [
      { date: ['2026-11-01', '2026-11-02'] },
      { 'community[]': 'x' },
      { community: ['chabad', 'ashkenazi'] },
      { date: '2'.repeat(10_000) },
      { date: `${today}${'0'.repeat(9_990)}` },
      { date: '2026-02-30' },
    ];
    for (const locale of LOCALES) {
      const sephardi = messages[locale].calendarHome.zmanimList.community.sephardi;
      for (const search of odd) {
        const label = `${locale} ${show(search).slice(0, 60)}`;
        const html = await cityPage(locale, 'jerusalem', search);
        common(locale, html, label);
        const shown = decodeEntities(textOf(between(html, '<p class="ch-zl-day">', '</p>')));
        assert(shown === formatDayFull(today, locale), `${label}: shows ${shown}`);
        const current = /aria-current="true">([^<]+)</.exec(between(html, '<ul class="site-zm-switch"', '</ul>'))?.[1];
        assert(current === sephardi, `${label}: the community ${current}`);
        assert(!html.includes('2222222222') && !html.includes('0000000000'), `${label}: the odd value is written into the page`);
      }
    }
  });

  await check('Z9 the CSS: the kit\'s lint, every tap target at least 44 px, no hover, motion only under no-preference; the sheet\'s rows and the page\'s CSS each in the site\'s sheet once', async () => {
    const { SITE_CSS, ZMANIM_PAGE_CSS } = await load('src/site/site-css.ts');
    const { ZMANIM_SHEET_CSS } = await load('src/lib/calendar-view/zmanim-sheet-css.ts');
    const problems = lintCss(ZMANIM_PAGE_CSS);
    assert(problems.length === 0, show(problems));
    assert(SITE_CSS.split(ZMANIM_SHEET_CSS).length === 2 && SITE_CSS.split(ZMANIM_PAGE_CSS).length === 2, 'the sheet\'s rows or the page\'s CSS are not in the site\'s sheet exactly once');
    const rule = (selector: string) => new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(ZMANIM_PAGE_CSS)?.[1];
    for (const selector of TAPS) {
      const body = rule(selector);
      const min = body ? /min-block-size:\s*(\d+)px/.exec(body) : null;
      assert(min && Number(min[1]) >= 44, `${selector}: ${body?.trim().replace(/\s+/g, ' ')}`);
    }
    assert(!/hover/.test(ZMANIM_PAGE_CSS), 'a hover rule');
    const outside = ZMANIM_PAGE_CSS.replace(/@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*?\n\}/g, '');
    assert(![...outside.matchAll(/animation:\s*([^;]+);/g)].some((m) => m[1].trim() !== 'none'), 'an animation outside the no-preference block');
  });

  await check('Z10 no request leaves the server while a page renders; no file under app/[locale]/(site) or components/site calls fetch, loads a script by src or imports next/script; no component of the city page is a client one (only Near me is)', () => {
    assert(fetched.length === 0, `requests: ${show(fetched)}`);
    const walk = (rel: string): string[] =>
      fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(`${rel}/${entry.name}`) : /\.(?:tsx?|mdx?)$/.test(entry.name) ? [`${rel}/${entry.name}`] : []));
    const siteFiles = [...walk('app/[locale]/(site)'), ...walk('components/site')];
    assert(['app/[locale]/(site)/page.tsx', 'app/[locale]/(site)/zmanim/[city]/page.tsx', 'components/site/SiteHeader.tsx'].every((f) => siteFiles.includes(f)), `the walk missed the site: ${show(siteFiles)}`);
    for (const file of siteFiles) {
      const text = readSource(file);
      assert(!/\bfetch\s*\(/.test(text), `${file} calls fetch`);
      assert(!/<script\b[^>]*\bsrc\s*=/i.test(text), `${file} loads a script by src`);
      assert(!/['"]next\/script['"]/.test(text), `${file} imports next/script`);
    }
    for (const file of fs.readdirSync(path.join(ROOT, 'components/site/zmanim'))) {
      const client = /^\s*['"]use client['"]/m.test(readSource(`components/site/zmanim/${file}`));
      assert(client === (file === 'NearMe.tsx'), `${file}: ${client ? 'a client component' : 'Near me is not a client component'}`);
    }
    assert(!/['"]use client['"]/.test(readSource('app/[locale]/(site)/zmanim/[city]/page.tsx')), 'the city page is a client component');
  });

  finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```
(Z8 is the `common()` helper that every rendering check above calls. Z11 is added in Task 7.)

- [ ] **Step 8: Run it red.**
```
cd /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/zp-wt && env TZ=Asia/Jerusalem DATABASE_URL=postgresql://fake:fake@127.0.0.1:1/fake DIRECT_URL=postgresql://fake:fake@127.0.0.1:1/fake TELEGRAM_BOT_TOKEN=000000:fake WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 ENCRYPTION_KEY_PREVIOUS= NODE_ENV=development 'GOOGLE_TTS_CREDENTIALS={}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-zmanim-pages.ts
```
Expected: exit 1 before the checks, with `Cannot find module '.../app/[locale]/(site)/zmanim/[city]/page.tsx'`.

- [ ] **Step 9: Write the links and the notice.** Create `src/site/zmanim/links.ts`:

```ts
// The zmanim pages' addresses (spec 2026-10-30-public-zmanim §4.3): a city's path with the day and the community in the
// query, and a path in a language (English unprefixed, as i18n/routing.ts's 'as-needed' prefix writes it). The pages draw
// their day, month and community links as plain <a href> with these (never prefetched: the request limit counts city
// pages), and the city list and Near me link the clean address. Client-safe: it imports the routing table and a type.

import { routing } from '@/i18n/routing';
import type { ZmanimListResponse } from '@/src/lib/calendar-view/zmanim-list';

export type CityQuery = { date?: string; community?: ZmanimListResponse['community'] };

/** '/zmanim/<slug>', then ?date= and community= when given. A caller passes the community only when it is not the city's default. */
export function cityPath(slug: string, q: CityQuery = {}): string {
  const query = new URLSearchParams();
  if (q.date) query.set('date', q.date);
  if (q.community) query.set('community', q.community);
  const search = query.toString();
  return `/zmanim/${slug}${search ? `?${search}` : ''}`;
}

/** A path in a language: English as it is, Hebrew and Russian under their prefix. */
export function localeHref(locale: string, path: string): string {
  return locale === routing.defaultLocale ? path : `/${locale}${path}`;
}

/** A city's page in a language, with its query. */
export function cityHref(locale: string, slug: string, q: CityQuery = {}): string {
  return localeHref(locale, cityPath(slug, q));
}
```

Create `src/site/zmanim/sources.ts`:

```ts
// The credit the Copernicus DEM's licence requires wherever data derived from it is shown (spec 2026-10-30-public-zmanim
// §5.3; License-COPDEM-30, Article 6): the city heights come from it. Its wording is the licence's own and stays in
// English on every page, so it is a constant, never a message to translate; the words around it are messages
// (zmanimSite.sources). Client-safe: no import.

export const COPERNICUS_NOTICE =
  '© DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved';
```

- [ ] **Step 10: Write the components.** Create `components/site/zmanim/words.ts`:

```ts
// The zmanim pages' translators and small shared words (spec 2026-10-30-public-zmanim §4.2): the site's whole catalogue
// (t) and calendarHome (tc, the words of the app's sun sheet, which ZmanimRows reads), the Russian month genitives, a
// weekday's full name for a column header, a window's name, and the community a link keeps. Server only by import
// discipline (the city view reads src/services).

import type { ReactNode } from 'react';
import type { ZmanWordsT } from '@/src/lib/calendar-view/zman-words';
import { intlLocale } from '@/src/lib/calendar-view/format';
import type { WeekStart } from '@/src/lib/calendar-view/types';
import { joinTitles } from '@/src/lib/join-titles';
import type { AheadWindow, CityView } from '@/src/site/zmanim/city-view';
import type { CityQuery } from '@/src/site/zmanim/links';

export type SiteT = ((key: string, values?: Record<string, string | number>) => string) & {
  raw: (key: string) => unknown;
  rich: (key: string, values: Record<string, (chunks: ReactNode) => ReactNode>) => ReactNode;
};
export type CalendarT = ZmanWordsT & { raw: (key: string) => unknown };

export interface CityViewProps {
  view: CityView;
  locale: string;
  t: SiteT;
  tc: CalendarT;
}

/** calendarHome.hebrewMonthGenitive for Russian ("4 хешвана"); the other languages need none. */
export function genitiveOf(tc: CalendarT, locale: string): string[] | undefined {
  return locale === 'ru' ? (tc.raw('hebrewMonthGenitive') as string[]) : undefined;
}

/** The full name of a weekday (0 = Sunday), for a column header's spoken name. */
export function weekdayName(weekday: WeekStart, locale: string): string {
  // 18 October 2026 is a Sunday
  return new Intl.DateTimeFormat(intlLocale(locale), { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 9, 18 + weekday, 12)));
}

/** A window's name: its parasha, then its holidays ("Parashat Tetzave, Shabbat Zachor", "Pesach I, Pesach II"), else Shabbat. */
export function windowName(window: AheadWindow, t: SiteT): string {
  const names = [...(window.parasha ? [window.parasha.title] : []), ...window.holidays.map((h) => h.title)];
  return names.length > 0 ? joinTitles(names) : t('zmanimSite.ahead.shabbat');
}

/** The query every day, month and Today link keeps: the community, when it is not the city's default. */
export function keptQuery(view: CityView): CityQuery {
  return { community: view.isDefaultCommunity ? undefined : view.community };
}
```

Create `components/site/zmanim/CommunitySwitch.tsx`:

```tsx
import { COMMUNITIES } from '@/src/services/zmanim/sets';
import { defaultCommunity } from '@/src/site/zmanim/city-view';
import { cityHref } from '@/src/site/zmanim/links';
import type { CityViewProps } from './words';

// The community switch (spec §4.2.2): the three sets as plain links that keep the day shown, the current one marked. The
// city's default is written without ?community, so its link is the clean address on today.
export function CommunitySwitch({ view, locale, t, tc }: CityViewProps) {
  const date = view.isToday ? undefined : view.day;
  const fallback = defaultCommunity(view.city);
  return (
    <nav aria-label={t('zmanimSite.day.communityLabel')}>
      <ul className="site-zm-switch">
        {COMMUNITIES.map((community) => (
          <li key={community}>
            <a href={cityHref(locale, view.city.slug, { date, community: community === fallback ? undefined : community })} rel="nofollow" aria-current={community === view.community ? 'true' : undefined}>
              {tc(`zmanimList.community.${community}`)}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
```

Create `components/site/zmanim/DayCard.tsx`:

```tsx
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { ZmanimRows } from '@/components/app-ui/ZmanimRows';
import { formatDayFull } from '@/src/lib/calendar-view/format';
import { hebrewFullDate } from '@/src/lib/calendar-view/hebrew-date';
import { cityHref } from '@/src/site/zmanim/links';
import { CommunitySwitch } from './CommunitySwitch';
import { genitiveOf, keptQuery, type CityViewProps } from './words';

// The day (spec §4.2.2): the app's sun sheet set on the page as a card. The day between the previous and next day's
// arrows (the sheet's own nav and icons, flipped in RTL by .ch-flip; links here), Today when another day is shown, the community switch and the line saying how
// that set counts, then the sheet's rows (ZmanimRows: the same words, opinions, order, accent and dash) and the halachic
// hour. A row with no time gets one note under the rows. A day that could not be computed says so.
export function DayCard({ view, locale, t, tc }: CityViewProps) {
  const hebrew = hebrewFullDate(view.day, locale, genitiveOf(tc, locale));
  const kept = keptQuery(view);
  const method = view.community === 'sephardi' && !view.il ? 'sephardiAbroad' : view.community;
  return (
    <section className="site-zm-card" aria-labelledby="day-title">
      <h2 id="day-title" className="ch-visually-hidden">
        {t('zmanimSite.day.title')}
      </h2>
      <nav className="ch-zl-nav" aria-label={t('zmanimSite.day.navLabel')}>
        {view.prevDay ? (
          <a className="site-zm-arrow" href={cityHref(locale, view.city.slug, { ...kept, date: view.prevDay })} rel="nofollow" aria-label={t('zmanimSite.day.previous')}>
            <ChevronLeft className="ch-flip" aria-hidden="true" focusable="false" />
          </a>
        ) : (
          <span className="site-zm-arrow" aria-hidden="true" />
        )}
        <div className="ch-zl-date">
          <p className="ch-zl-day">{formatDayFull(view.day, locale)}</p>
          {hebrew ? <p className="ch-zl-hebrew">{hebrew}</p> : null}
        </div>
        {view.nextDay ? (
          <a className="site-zm-arrow" href={cityHref(locale, view.city.slug, { ...kept, date: view.nextDay })} rel="nofollow" aria-label={t('zmanimSite.day.next')}>
            <ChevronRight className="ch-flip" aria-hidden="true" focusable="false" />
          </a>
        ) : (
          <span className="site-zm-arrow" aria-hidden="true" />
        )}
      </nav>
      {view.isToday ? null : (
        <p className="site-zm-today">
          <a href={cityHref(locale, view.city.slug, kept)} rel="nofollow">
            {t('zmanimSite.day.today')}
          </a>
        </p>
      )}
      <CommunitySwitch view={view} locale={locale} t={t} tc={tc} />
      <p className="site-zm-method">{t(`zmanimSite.day.method.${method}`)}</p>
      {view.list ? (
        <>
          <ZmanimRows list={view.list} locale={locale} t={tc} />
          {view.hasDash ? <p className="site-zm-dash">{t('zmanimSite.day.dashNote')}</p> : null}
        </>
      ) : (
        <p className="site-zm-failed" role="status">
          {t('zmanimSite.day.failed')}
        </p>
      )}
    </section>
  );
}
```

Create `components/site/zmanim/AheadCard.tsx`:

```tsx
import { ZmanimRows } from '@/components/app-ui/ZmanimRows';
import { formatDayShort } from '@/src/lib/calendar-view/format';
import { windowList } from '@/src/site/zmanim/city-view';
import { windowName, type CityViewProps } from './words';

// Shabbat and Yom Tov ahead (spec §4.2.3): the window under way and every one that begins within 8 days, each named by
// its parasha or holidays, with one line per day: the eve's candle lighting, "not before" on a middle night, and the end
// (the day lists' own rows, in the accent). A window whose end the sun doesn't make keeps its candles; its end is a dash,
// with its own line. Windows that could not be computed say so.
export function AheadCard({ view, locale, t, tc }: CityViewProps) {
  return (
    <section className="site-zm-section" aria-labelledby="ahead-title">
      <h2 id="ahead-title" className="site-h2">
        {t('zmanimSite.ahead.title')}
      </h2>
      {view.ahead === null ? (
        <p className="site-zm-failed" role="status">
          {t('zmanimSite.ahead.failed')}
        </p>
      ) : (
        view.ahead.map((window) => {
          const dashed = window.days.some((d) => d.rows.some((r) => r.at === null));
          return (
            <section key={window.eve} className="site-zm-window" aria-labelledby={`window-${window.eve}`}>
              <h3 id={`window-${window.eve}`} className="site-h3">
                {windowName(window, t)}
              </h3>
              {window.days.map((d) =>
                d.rows.length > 0 ? (
                  <div key={d.day} className="site-zm-wday">
                    <p className="site-zm-wdate">{formatDayShort(d.day, locale)}</p>
                    <ZmanimRows list={windowList(view, d.day, d.rows)} locale={locale} t={tc} />
                  </div>
                ) : null,
              )}
              {window.endMissing ? <p className="site-zm-dash">{t('zmanimSite.ahead.noEnd')}</p> : dashed ? <p className="site-zm-dash">{t('zmanimSite.day.dashNote')}</p> : null}
            </section>
          );
        })
      )}
    </section>
  );
}
```

Create `components/site/zmanim/MonthGrid.tsx`:

```tsx
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { formatDayFull, formatMonthTitle, formatWeekdayHeader } from '@/src/lib/calendar-view/format';
import { weekdayOrder } from '@/src/lib/calendar-view/grid';
import { hebrewCellLabel, hebrewCellMonth, hebrewFullDate, hebrewMonthHeader, isHebrewMonthStart } from '@/src/lib/calendar-view/hebrew-date';
import { joinTitles } from '@/src/lib/join-titles';
import type { MonthCell } from '@/src/site/zmanim/city-view';
import { cityHref } from '@/src/site/zmanim/links';
import { genitiveOf, keptQuery, weekdayName, type CityViewProps } from './words';

// The month (spec §4.2.4): the Gregorian month and the Hebrew months it spans, with the previous and next month's links
// (left out at the range's ends), then a <table> from Sunday with its weekday headers. Each cell shows the day, the Hebrew
// day (and the Hebrew month's short name on its first day and on the 1st) and a dot for a holiday; Yom Tov is in the
// accent, today is outlined and carries aria-current="date", the day shown is filled. Each cell links to its day, named by
// the full Gregorian date, the Hebrew date and the holiday; a day outside the range is not a link.
export function MonthGrid({ view, locale, t, tc }: CityViewProps) {
  const { month } = view;
  const title = formatMonthTitle(month.key, locale, true);
  const kept = keptQuery(view);
  const shortMonths = tc.raw('hebrewMonthShort') as string[];
  const genitive = genitiveOf(tc, locale);

  const cell = (c: MonthCell) => {
    const monthName = isHebrewMonthStart(c.day) || c.day.endsWith('-01') ? hebrewCellMonth(c.day, locale, shortMonths) : '';
    const names = joinTitles(c.holidays.map((h) => h.title));
    const className = ['site-zm-cell', c.yomTov ? 'is-yomtov' : '', c.isToday ? 'is-today' : '', c.isShown ? 'is-shown' : '', c.inRange ? '' : 'is-out'].filter(Boolean).join(' ');
    const inner = (
      <>
        <span className="site-zm-gday">{Number(c.day.slice(8))}</span>
        <span className="site-zm-hday">{hebrewCellLabel(c.day, locale, false)}</span>
        {monthName ? <span className="site-zm-hmonth">{monthName}</span> : null}
        {c.holidays.length > 0 ? <span className="site-zm-mark" /> : null}
      </>
    );
    if (!c.inRange) return <span className={className}>{inner}</span>;
    const label = t(names ? 'zmanimSite.month.cellHoliday' : 'zmanimSite.month.cell', { date: formatDayFull(c.day, locale), hebrew: hebrewFullDate(c.day, locale, genitive), holidays: names });
    return (
      <a className={className} href={cityHref(locale, view.city.slug, { ...kept, date: c.day })} rel="nofollow" aria-label={label} aria-current={c.isToday ? 'date' : undefined}>
        {inner}
      </a>
    );
  };

  return (
    <>
      <div className="site-zm-month-head">
        <h2 id="month-title" className="site-h2">
          {title}
        </h2>
        <nav className="site-zm-month-nav" aria-label={t('zmanimSite.month.navLabel')}>
          {month.prevMonthDay ? (
            <a className="site-zm-arrow" href={cityHref(locale, view.city.slug, { ...kept, date: month.prevMonthDay })} rel="nofollow" aria-label={t('zmanimSite.month.previous')}>
              <ChevronLeft className="ch-flip" aria-hidden="true" focusable="false" />
            </a>
          ) : null}
          {month.nextMonthDay ? (
            <a className="site-zm-arrow" href={cityHref(locale, view.city.slug, { ...kept, date: month.nextMonthDay })} rel="nofollow" aria-label={t('zmanimSite.month.next')}>
              <ChevronRight className="ch-flip" aria-hidden="true" focusable="false" />
            </a>
          ) : null}
        </nav>
      </div>
      <p className="site-zm-hmonths">{hebrewMonthHeader(month.key, locale)}</p>
      {month.weeks ? (
        <table className="site-zm-grid" aria-labelledby="month-title">
          <thead>
            <tr>
              {weekdayOrder(month.weekStart).map((weekday) => (
                <th key={weekday} scope="col">
                  <span aria-hidden="true">{formatWeekdayHeader(weekday, locale)}</span>
                  <span className="ch-visually-hidden">{weekdayName(weekday, locale)}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {month.weeks.map((week) => (
              <tr key={week[0].day}>
                {week.map((c) => (
                  <td key={c.day}>{c.inMonth ? cell(c) : null}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="site-zm-failed" role="status">
          {t('zmanimSite.month.failed')}
        </p>
      )}
    </>
  );
}
```

Create `components/site/zmanim/MonthList.tsx`:

```tsx
import { ZmanimRows } from '@/components/app-ui/ZmanimRows';
import { formatDayShort } from '@/src/lib/calendar-view/format';
import { hebrewDayLabel } from '@/src/lib/calendar-view/hebrew-date';
import { joinTitles } from '@/src/lib/join-titles';
import { windowList } from '@/src/site/zmanim/city-view';
import { genitiveOf, type CityViewProps } from './words';

// The month's list, under the grid (spec §4.2.4): every holiday, fast and Rosh Chodesh, and every Shabbat with its
// parasha, candle lighting and end, at this city in this community (the day lists' own rows).
export function MonthList({ view, locale, t, tc }: CityViewProps) {
  const entries = view.month.entries;
  if (!entries || entries.length === 0) return null;
  const genitive = genitiveOf(tc, locale);
  const dashed = entries.some((e) => e.shabbat?.rows.some((r) => r.at === null));
  return (
    <section className="site-zm-sub" aria-labelledby="month-list-title">
      <h3 id="month-list-title" className="site-h3">
        {t('zmanimSite.month.listTitle')}
      </h3>
      <ul className="site-zm-mlist">
        {entries.map((entry) => {
          const names = joinTitles([...(entry.shabbat?.parasha ? [entry.shabbat.parasha.title] : []), ...entry.holidays.map((h) => h.title)]);
          return (
            <li key={entry.day} className="site-zm-entry">
              <p className="site-zm-entry-date">
                {formatDayShort(entry.day, locale)}
                <span className="site-zm-entry-hebrew">{hebrewDayLabel(entry.day, locale, genitive)}</span>
              </p>
              {names ? <p className="site-zm-entry-names">{names}</p> : null}
              {entry.shabbat && entry.shabbat.rows.length > 0 ? <ZmanimRows list={windowList(view, entry.day, entry.shabbat.rows)} locale={locale} t={tc} /> : null}
            </li>
          );
        })}
      </ul>
      {dashed ? <p className="site-zm-dash">{t('zmanimSite.day.dashNote')}</p> : null}
    </section>
  );
}
```

Create `components/site/zmanim/PageNote.tsx`:

```tsx
import type { CityView } from '@/src/site/zmanim/city-view';
import type { SiteT } from './words';

// The note under the month (spec §4.2.5): the times are for the city's centre (and, for Sephardi in Israel, at its
// height), candle lighting is 20 minutes before sunset, and a halachic time that matters is checked with a reliable source.
export function PageNote({ view, t }: { view: CityView; t: SiteT }) {
  const city = t(`cities.${view.city.slug}`);
  return <p className="site-zm-note">{view.heightM !== null ? t('zmanimSite.note.height', { city, height: view.heightM }) : t('zmanimSite.note.plain', { city })}</p>;
}
```

Create `components/site/zmanim/FamCalBlock.tsx`:

```tsx
import { HonestLine, StartButtons, startWords } from '@/components/site/StartButtons';
import { cheapestPlanWith } from '@/src/site/plans';
import type { SiteT } from './words';

// FamCal on a city's page (spec §4.2.6): the landing's own sentence on reminders by zman with its two tags (On Telegram,
// and the cheapest plan that has reminders), then the site's two start buttons and the honest line, unchanged.
export function FamCalBlock({ t }: { t: SiteT }) {
  const plan = cheapestPlanWith('reminders');
  return (
    <aside className="site-cta" aria-labelledby="famcal-title">
      <h2 id="famcal-title" className="site-h3">
        {t('zmanimSite.famcal.title')}
      </h2>
      <p className="site-cta-text">
        {t('landing.features.jewish.zmanReminders')} <span className="site-tag">{t('landing.features.telegramTag')}</span>
        {plan && plan !== 'FREE' ? (
          <>
            {' '}
            <span className="site-tag">{t(`landing.plans.${plan.toLowerCase()}.name`)}</span>
          </>
        ) : null}
      </p>
      <StartButtons words={startWords(t)} />
      <HonestLine text={t('site.cta.honest')} />
    </aside>
  );
}
```

Create `components/site/zmanim/Sources.tsx`:

```tsx
import type { ReactNode } from 'react';
import { COPERNICUS_NOTICE } from '@/src/site/zmanim/sources';
import type { SiteT } from './words';

// The credits at the bottom of the zmanim pages (spec §5.3): GeoNames (CC BY 4.0) with a link, the OpenStreetMap
// contributors for the town outlines behind the heights, and the Copernicus DEM with its required notice, in English on
// every page (src/site/zmanim/sources.ts).
export function Sources({ t }: { t: SiteT }) {
  const link = (href: string) => (chunks: ReactNode) => <a href={href}>{chunks}</a>;
  return (
    <section className="site-zm-sources" aria-labelledby="sources-title">
      <h2 id="sources-title" className="site-h3">
        {t('zmanimSite.sources.title')}
      </h2>
      <ul>
        <li>{t.rich('zmanimSite.sources.geonames', { link: link('https://www.geonames.org/') })}</li>
        <li>{t.rich('zmanimSite.sources.osm', { link: link('https://www.openstreetmap.org/copyright') })}</li>
        <li>
          {t('zmanimSite.sources.copernicus')}{' '}
          <span lang="en" dir="ltr">
            {COPERNICUS_NOTICE}
          </span>
        </li>
      </ul>
    </section>
  );
}
```

- [ ] **Step 11: Write the page.** Create `app/[locale]/(site)/zmanim/[city]/page.tsx`:

```tsx
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { SitePage } from '@/components/site/SitePage';
import { AheadCard } from '@/components/site/zmanim/AheadCard';
import { DayCard } from '@/components/site/zmanim/DayCard';
import { FamCalBlock } from '@/components/site/zmanim/FamCalBlock';
import { MonthGrid } from '@/components/site/zmanim/MonthGrid';
import { MonthList } from '@/components/site/zmanim/MonthList';
import { PageNote } from '@/components/site/zmanim/PageNote';
import { Sources } from '@/components/site/zmanim/Sources';
import { Link } from '@/i18n/navigation';
import { captureError } from '@/src/lib/error-capture';
import { cityBySlug } from '@/src/site/cities';
import { siteMetadata } from '@/src/site/seo';
import { buildCityView, readCityParams } from '@/src/site/zmanim/city-view';
import { cityPath } from '@/src/site/zmanim/links';

// One city's zmanim page (spec 2026-10-30-public-zmanim §4.2): the day's zmanim, the Shabbat and Yom Tov ahead, the
// month, the note, FamCal and the sources. Computed on each request (the city's today; ?date and ?community from the URL,
// read by readCityParams), from the same engine as the bot's sun sheet, with no database and no network. The canonical
// URL and the language links are always the clean one. A section that fails is logged with the city, the day and the
// community, and says so; the rest of the page renders. The page ships no script of its own.

export const dynamic = 'force-dynamic';

type Props = {
  params: Promise<{ locale: string; city: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, city: slug } = await params;
  const city = cityBySlug(slug);
  if (!city) return {};
  const t = await getTranslations({ locale });
  const name = t(`cities.${city.slug}`);
  return siteMetadata({ locale, path: cityPath(city.slug), title: t('zmanimSite.city.metaTitle', { city: name }), description: t('zmanimSite.city.description', { city: name }), imageAlt: t('landing.meta.ogImageAlt') });
}

export default async function CityZmanimPage({ params, searchParams }: Props) {
  const { locale, city: slug } = await params;
  setRequestLocale(locale);
  const city = cityBySlug(slug);
  if (!city) notFound();
  const view = buildCityView(city, readCityParams(city, await searchParams, new Date()), locale);
  for (const failure of view.failures) {
    captureError(failure.error, 'zmanim-site', { service: 'zmanim-site', slug: city.slug, day: view.day, community: view.community, section: failure.section });
  }
  const t = await getTranslations({ locale });
  const tc = await getTranslations({ locale, namespace: 'calendarHome' });
  return (
    <SitePage locale={locale} path={cityPath(city.slug)}>
      <main id="main" className="site-section site-page-main">
        <div className="site-wrap site-narrow">
          <p className="site-back">
            <Link href="/zmanim">{t('zmanimSite.city.back')}</Link>
          </p>
          <h1 className="site-h1 site-page-title">{t('zmanimSite.city.heading', { city: t(`cities.${city.slug}`) })}</h1>
          <DayCard view={view} locale={locale} t={t} tc={tc} />
          <AheadCard view={view} locale={locale} t={t} tc={tc} />
          <section className="site-zm-section" aria-labelledby="month-title">
            <MonthGrid view={view} locale={locale} t={t} tc={tc} />
            <MonthList view={view} locale={locale} t={t} tc={tc} />
          </section>
          <PageNote view={view} t={t} />
          <FamCalBlock t={t} />
          <Sources t={t} />
        </div>
      </main>
    </SitePage>
  );
}
```

- [ ] **Step 12: Add the CSS.** In `src/site/site-css.ts`:
  - Line 13 now reads `// - One motion on the whole site, the hero's (its own rules); prefers-reduced-motion stops it.` Replace it with `// - One motion on the whole site, the hero's (its own rules), and Near me's loading spinner (the zmanim index); prefers-reduced-motion stops both.`
  - After line 18 (`import { APP_THEME_CSS } from '@/components/app-ui/theme';`), add `import { ZMANIM_SHEET_CSS } from '@/src/lib/calendar-view/zmanim-sheet-css';`.
  - Insert the block below just before line 1345 (`/** The whole style sheet: ...`).
  - Change line 1346 to `export const SITE_CSS = APP_THEME_CSS + TOKENS_CSS + BASE_CSS + CHROME_CSS + LANDING_CSS + PAGES_CSS + ZMANIM_SHEET_CSS + ZMANIM_PAGE_CSS;`.

The kit lint rules this block passes (scripts/lib/css-lint.ts): "every font size is in px and at least 11", "logical properties only (no margin-left, padding-right, left:, text-align: left, float ...)", "no :hover (touch only)", "no hex, rgb() or hsl() outside a token block". Chrome H5 adds:
- no `overflow-x: hidden|clip`;
- each tap rule written as `\n<selector> {` with a `min-block-size` of 44 px or more.

Landing G7 bans the word "hover" anywhere in the sheet, and wants every `animation:` inside `@media (prefers-reduced-motion: no-preference) {`. The block uses only token colours, and only the fg/bg pairs G7 checks.

```ts
/**
 * The zmanim pages (spec 2026-10-30-public-zmanim §4, §6.3): a city's day card (the sun sheet's own rows and nav,
 * ZMANIM_SHEET_CSS, set on the page as a card), the community switch, the Shabbat and Yom Tov ahead, the month's table and
 * list, the note and the sources. Token colours only, logical properties, nothing under 13 px, every link 44 px.
 */
export const ZMANIM_PAGE_CSS = `
.site-zm-card {
  margin-block-start: 24px;
  padding: 8px 20px 20px;
  border-radius: 20px;
  background: var(--ch-card);
}
.site-zm-arrow {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  min-block-size: 44px;
  min-inline-size: 44px;
  border-radius: 12px;
  color: var(--ch-accent);
  text-decoration: none;
}
.site-zm-arrow svg {
  inline-size: 22px;
  block-size: 22px;
}
[dir='rtl'] .site-zm-arrow .ch-flip {
  transform: scaleX(-1);
}
.site-zm-today {
  text-align: center;
}
.site-zm-today a {
  display: inline-flex;
  align-items: center;
  min-block-size: 44px;
  padding-inline: 12px;
  color: var(--ch-accent);
  font-size: 15px;
  font-weight: 600;
}
.site-zm-switch {
  display: flex;
  gap: 4px;
  margin-block-start: 12px;
  padding: 4px;
  border-radius: 14px;
  background: var(--ch-surface);
}
.site-zm-switch li {
  flex: 1;
  min-inline-size: 0;
}
.site-zm-switch a {
  display: flex;
  align-items: center;
  justify-content: center;
  min-block-size: 44px;
  padding-inline: 6px;
  border-radius: 10px;
  color: var(--ch-text);
  font-size: 15px;
  font-weight: 600;
  line-height: 1.2;
  text-align: center;
  text-decoration: none;
}
.site-zm-switch a[aria-current='true'] {
  background: var(--ch-accent-soft);
  color: var(--ch-accent);
}
.site-zm-method {
  margin-block-start: 10px;
  color: var(--ch-muted);
  font-size: 15px;
  line-height: 1.45;
}
.site-zm-dash,
.site-zm-failed {
  margin-block-start: 12px;
  color: var(--ch-muted);
  font-size: 15px;
  line-height: 1.45;
}
.site-zm-section {
  margin-block-start: 48px;
}
.site-zm-window {
  margin-block-start: 16px;
  padding: 4px 20px 16px;
  border-radius: 18px;
  background: var(--ch-surface);
}
.site-zm-window .site-h3 {
  padding-block: 14px 2px;
}
.site-zm-wdate {
  margin-block-start: 10px;
  color: var(--ch-muted);
  font-size: 14px;
  font-weight: 600;
}
.site-zm-wday .ch-zl-rows {
  margin-block-start: 0;
}
.site-zm-month-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.site-zm-month-nav {
  display: flex;
  gap: 4px;
}
.site-zm-hmonths {
  margin-block-start: 4px;
  color: var(--ch-muted);
  font-size: 16px;
}
.site-zm-grid {
  inline-size: 100%;
  margin-block-start: 16px;
  border-collapse: separate;
  border-spacing: 2px;
  table-layout: fixed;
}
.site-zm-grid th {
  padding-block: 6px;
  color: var(--ch-muted);
  font-size: 13px;
  font-weight: 600;
  text-align: center;
}
.site-zm-grid td {
  padding: 0;
  vertical-align: top;
}
.site-zm-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
  min-block-size: 56px;
  padding-block: 6px 4px;
  border-radius: 12px;
  color: var(--ch-text);
  text-decoration: none;
}
.site-zm-cell.is-out {
  color: var(--ch-muted);
}
.site-zm-cell.is-shown {
  background: var(--ch-accent-soft);
}
.site-zm-cell.is-today {
  box-shadow: inset 0 0 0 2px var(--ch-accent);
}
.site-zm-gday {
  font-size: 16px;
  font-weight: 600;
  line-height: 1.2;
  font-variant-numeric: tabular-nums;
}
.site-zm-cell.is-yomtov .site-zm-gday {
  color: var(--ch-accent);
}
.site-zm-hday,
.site-zm-hmonth {
  max-inline-size: 100%;
  overflow: hidden;
  color: var(--ch-muted);
  font-size: 13px;
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.site-zm-mark {
  inline-size: 6px;
  block-size: 6px;
  margin-block-start: 2px;
  border-radius: 50%;
  background: var(--ch-muted);
}
.site-zm-cell.is-yomtov .site-zm-mark {
  background: var(--ch-accent);
}
.site-zm-sub {
  margin-block-start: 28px;
}
.site-zm-mlist {
  margin-block-start: 8px;
}
.site-zm-entry {
  padding-block: 12px;
  border-block-start: 1px solid var(--ch-separator);
}
.site-zm-entry:first-child {
  border-block-start: 0;
}
.site-zm-entry-date {
  font-size: 16px;
  font-weight: 650;
}
.site-zm-entry-hebrew {
  margin-inline-start: 8px;
  color: var(--ch-muted);
  font-weight: 400;
}
.site-zm-entry-names {
  margin-block-start: 2px;
  font-size: 16px;
}
.site-zm-entry .ch-zl-rows {
  margin-block-start: 4px;
}
.site-zm-note {
  margin-block-start: 40px;
  color: var(--ch-muted);
  font-size: 15px;
  line-height: 1.5;
}
.site-zm-sources {
  margin-block-start: 40px;
  color: var(--ch-muted);
  font-size: 14px;
}
.site-zm-sources ul {
  display: grid;
  gap: 6px;
  margin-block-start: 8px;
}
.site-zm-sources a {
  display: inline-flex;
  align-items: center;
  min-block-size: 44px;
  color: var(--ch-accent);
  text-decoration: underline;
  text-underline-offset: 3px;
}
`;
```

- [ ] **Step 13: Add the words.** In each of `messages/en.json`, `messages/he.json` and `messages/ru.json`, find the line containing the top-level `  "ui": {` (two-space indent, unique at that indent; Task 3 appended `cities` and `countries` after it, so it is no longer the last namespace) and insert the block for that language immediately before it. Each block ends with `},`. The Russian block holds literal no-break spaces (U+00A0) after one-letter words and before the dash, as messages/ru.json does: copy the bytes, never retype them.

en:
```json
  "zmanimSite": {
    "index": {
      "metaTitle": "Shabbat times and zmanim by city",
      "description": "Candle lighting, the end of Shabbat and Yom Tov, the week’s parasha, the Hebrew calendar and the day’s zmanim for {count, plural, one {# city} other {# cities}} in Israel and around the world.",
      "title": "Zmanim and Shabbat times",
      "lead": "Today’s zmanim, Shabbat and Yom Tov times and the month’s holidays for {count, plural, one {# city} other {# cities}}, by Sephardi, Ashkenazi or Chabad custom.",
      "listTitle": "Cities"
    },
    "near": {
      "title": "Near me",
      "button": "Find the nearest city",
      "locating": "Finding your city…",
      "privacy": "Your position stays in your browser. Only the city’s page is opened.",
      "opening": "Opening {city}…",
      "near": "The nearest city we list is {city}, {km} km away. Times there can differ from yours by a few minutes.",
      "none": "We don’t list a city near you yet. Pick a city from the list.",
      "denied": "This site isn’t allowed to see your location. To find the nearest city, allow location for famcal.bot in your browser’s site settings, or pick a city from the list.",
      "unavailable": "Your device couldn’t find its position. Pick a city from the list.",
      "unsupported": "This browser can’t share a position. Pick a city from the list.",
      "toList": "Go to the list of cities"
    },
    "city": {
      "metaTitle": "Shabbat times and zmanim in {city}",
      "description": "Candle lighting, the end of Shabbat and Yom Tov, the week’s parasha and the Hebrew calendar in {city}, with the day’s zmanim by Sephardi, Ashkenazi or Chabad custom.",
      "heading": "Zmanim and Shabbat times in {city}",
      "back": "All cities"
    },
    "day": {
      "title": "The day’s zmanim",
      "navLabel": "Choose a day",
      "previous": "Previous day",
      "next": "Next day",
      "today": "Back to today",
      "communityLabel": "Custom",
      "method": {
        "sephardi": "As Zmanei Yosef (Ohr HaChaim) counts them, at the city’s height.",
        "sephardiAbroad": "As Zmanei Yosef (Ohr HaChaim) counts them, at sea level.",
        "ashkenazi": "At sea level, with dawn at 16.1° and nightfall at 8.5°.",
        "chabad": "As the Baal HaTanya counts them."
      },
      "dashNote": "A dash means the sun doesn’t go deep enough below the horizon here at this time of year for that zman. Follow your community’s fixed times.",
      "failed": "The zmanim for this day couldn’t be computed. Try another day."
    },
    "ahead": {
      "title": "Shabbat and Yom Tov ahead",
      "shabbat": "Shabbat",
      "noEnd": "This time the sun doesn’t go deep enough below the horizon here to mark the end. Follow your community’s fixed time.",
      "failed": "The Shabbat and Yom Tov times couldn’t be computed. Try another day."
    },
    "month": {
      "navLabel": "Choose a month",
      "previous": "Previous month",
      "next": "Next month",
      "cell": "{date}, {hebrew}",
      "cellHoliday": "{date}, {hebrew}: {holidays}",
      "listTitle": "Holidays and Shabbat this month",
      "failed": "This month’s calendar couldn’t be computed. Try another month."
    },
    "note": {
      "height": "Times are computed for the centre of {city}, at a height of {height} m. Candle lighting is 20 minutes before sunset. For a halachic time that matters, check a reliable source.",
      "plain": "Times are computed for the centre of {city}. Candle lighting is 20 minutes before sunset. For a halachic time that matters, check a reliable source."
    },
    "famcal": {
      "title": "Reminders by zman in FamCal"
    },
    "sources": {
      "title": "Sources",
      "geonames": "City positions: <link>GeoNames</link>, under CC BY 4.0.",
      "osm": "Town outlines for the heights: © <link>OpenStreetMap</link> contributors.",
      "copernicus": "Heights: Copernicus DEM GLO-90."
    }
  },
```

he:
```json
  "zmanimSite": {
    "index": {
      "metaTitle": "זמני שבת וזמני היום לפי עיר",
      "description": "הדלקת נרות, צאת השבת והחג, פרשת השבוע, הלוח העברי וזמני היום ב־{count, plural, one {עיר אחת} two {שתי ערים} other {# ערים}} בישראל ובעולם.",
      "title": "זמני היום וזמני שבת",
      "lead": "זמני היום, זמני השבת והחג וחגי החודש ב־{count, plural, one {עיר אחת} two {שתי ערים} other {# ערים}}, לפי מנהג ספרדי, אשכנזי או חב״ד.",
      "listTitle": "ערים"
    },
    "near": {
      "title": "קרוב אליי",
      "button": "מציאת העיר הקרובה",
      "locating": "מחפשים את העיר הקרובה…",
      "privacy": "המיקום נשאר בדפדפן. נפתח רק הדף של העיר.",
      "opening": "פותחים את הדף של {city}…",
      "near": "העיר הקרובה ביותר ברשימה היא {city}, במרחק {km} ק״מ. הזמנים שם יכולים להיות שונים בכמה דקות.",
      "none": "עדיין אין ברשימה עיר קרובה למיקום הזה. אפשר לבחור עיר מהרשימה.",
      "denied": "לאתר הזה אין הרשאה למיקום. כדי למצוא את העיר הקרובה, אפשר לאשר מיקום ל־famcal.bot בהגדרות האתר בדפדפן, או לבחור עיר מהרשימה.",
      "unavailable": "המכשיר לא הצליח למצוא את המיקום. אפשר לבחור עיר מהרשימה.",
      "unsupported": "הדפדפן הזה לא משתף מיקום. אפשר לבחור עיר מהרשימה.",
      "toList": "לרשימת הערים"
    },
    "city": {
      "metaTitle": "זמני שבת וזמני היום ב{city}",
      "description": "הדלקת נרות, צאת השבת והחג, פרשת השבוע והלוח העברי ב{city}, עם זמני היום לפי מנהג ספרדי, אשכנזי או חב״ד.",
      "heading": "זמני היום וזמני שבת ב{city}",
      "back": "כל הערים"
    },
    "day": {
      "title": "זמני היום",
      "navLabel": "בחירת יום",
      "previous": "היום הקודם",
      "next": "היום הבא",
      "today": "חזרה להיום",
      "communityLabel": "מנהג",
      "method": {
        "sephardi": "לפי זמני יוסף (אור החיים), בגובה העיר.",
        "sephardiAbroad": "לפי זמני יוסף (אור החיים), בגובה פני הים.",
        "ashkenazi": "בגובה פני הים, עלות השחר ב־16.1° וצאת הכוכבים ב־8.5°.",
        "chabad": "לפי שיטת אדמו״ר הזקן (בעל התניא)."
      },
      "dashNote": "קו במקום שעה: בתקופה הזו של השנה השמש לא יורדת כאן מספיק עמוק מתחת לאופק בשביל הזמן הזה. כדאי לנהוג לפי הזמנים הקבועים של הקהילה.",
      "failed": "לא הצלחנו לחשב את זמני היום הזה. אפשר לנסות יום אחר."
    },
    "ahead": {
      "title": "השבת והחג הקרובים",
      "shabbat": "שבת",
      "noEnd": "הפעם השמש לא יורדת כאן מספיק עמוק מתחת לאופק בשביל צאת השבת או החג. כדאי לנהוג לפי הזמן הקבוע של הקהילה.",
      "failed": "לא הצלחנו לחשב את זמני השבת והחג. אפשר לנסות יום אחר."
    },
    "month": {
      "navLabel": "בחירת חודש",
      "previous": "החודש הקודם",
      "next": "החודש הבא",
      "cell": "{date}, {hebrew}",
      "cellHoliday": "{date}, {hebrew}: {holidays}",
      "listTitle": "חגים ושבתות בחודש",
      "failed": "לא הצלחנו לחשב את הלוח של החודש הזה. אפשר לנסות חודש אחר."
    },
    "note": {
      "height": "הזמנים מחושבים למרכז {city}, בגובה {height} מ׳. הדלקת הנרות 20 דקות לפני השקיעה. לזמן הלכתי שחשוב לכם, כדאי לבדוק במקור מוסמך.",
      "plain": "הזמנים מחושבים למרכז {city}. הדלקת הנרות 20 דקות לפני השקיעה. לזמן הלכתי שחשוב לכם, כדאי לבדוק במקור מוסמך."
    },
    "famcal": {
      "title": "תזכורות לפי זמני היום ב־FamCal"
    },
    "sources": {
      "title": "מקורות",
      "geonames": "מיקומי הערים: <link>GeoNames</link>, ברישיון CC BY 4.0.",
      "osm": "גבולות היישובים לחישוב הגובה: © התורמים של <link>OpenStreetMap</link>.",
      "copernicus": "גובה: Copernicus DEM GLO-90."
    }
  },
```

ru:
```json
  "zmanimSite": {
    "index": {
      "metaTitle": "Время шаббата и зманим по городам",
      "description": "Зажигание свечей, исход Шаббата и праздников, недельная глава, еврейский календарь и зманим на день для {count, plural, one {# города} few {# городов} many {# городов} other {# города}} в Израиле и по всему миру.",
      "title": "Зманим и время Шаббата",
      "lead": "Зманим на день, время Шаббата и праздников и праздники месяца для {count, plural, one {# города} few {# городов} many {# городов} other {# города}} — по сефардскому, ашкеназскому или хабадскому обычаю.",
      "listTitle": "Города"
    },
    "near": {
      "title": "Рядом со мной",
      "button": "Найти ближайший город",
      "locating": "Ищем ближайший город…",
      "privacy": "Ваше местоположение остаётся в браузере. Открывается только страница города.",
      "opening": "Открываем страницу города {city}…",
      "near": "Ближайший город в нашем списке — {city}, в {km} км от вас. Время там может отличаться от вашего на несколько минут.",
      "none": "Рядом с вами пока нет города из нашего списка. Выберите город в списке.",
      "denied": "Этому сайту не разрешено видеть ваше местоположение. Чтобы найти ближайший город, разрешите доступ к местоположению для famcal.bot в настройках сайта в браузере или выберите город в списке.",
      "unavailable": "Устройству не удалось определить местоположение. Выберите город в списке.",
      "unsupported": "Этот браузер не передаёт местоположение. Выберите город в списке.",
      "toList": "К списку городов"
    },
    "city": {
      "metaTitle": "Время шаббата и зманим: {city}",
      "description": "Зажигание свечей, исход Шаббата и праздников, недельная глава и еврейский календарь: {city}. Зманим на день по сефардскому, ашкеназскому или хабадскому обычаю.",
      "heading": "Зманим и время Шаббата: {city}",
      "back": "Все города"
    },
    "day": {
      "title": "Зманим на день",
      "navLabel": "Выбор дня",
      "previous": "Предыдущий день",
      "next": "Следующий день",
      "today": "Вернуться к сегодняшнему дню",
      "communityLabel": "Обычай",
      "method": {
        "sephardi": "По «Зманей Йосеф» (Ор а-Хаим), с учётом высоты города.",
        "sephardiAbroad": "По «Зманей Йосеф» (Ор а-Хаим), на уровне моря.",
        "ashkenazi": "На уровне моря: алот ха-шахар при 16,1°, выход звёзд при 8,5°.",
        "chabad": "По расчётам Баал а-Тании."
      },
      "dashNote": "Прочерк означает, что в это время года солнце здесь не опускается под горизонт достаточно глубоко для этого змана. Следуйте постоянным временам вашей общины.",
      "failed": "Не удалось рассчитать зманим на этот день. Выберите другой день."
    },
    "ahead": {
      "title": "Ближайшие Шаббат и праздники",
      "shabbat": "Шаббат",
      "noEnd": "На этот раз солнце здесь не опускается под горизонт достаточно глубоко, чтобы отметить исход. Следуйте постоянному времени вашей общины.",
      "failed": "Не удалось рассчитать время Шаббата и праздников. Выберите другой день."
    },
    "month": {
      "navLabel": "Выбор месяца",
      "previous": "Предыдущий месяц",
      "next": "Следующий месяц",
      "cell": "{date}, {hebrew}",
      "cellHoliday": "{date}, {hebrew}: {holidays}",
      "listTitle": "Праздники и Шаббаты месяца",
      "failed": "Не удалось рассчитать календарь на этот месяц. Выберите другой месяц."
    },
    "note": {
      "height": "Время рассчитано для центра города {city} на высоте {height} м. Свечи зажигают за 20 минут до заката. Если время важно с точки зрения галахи, сверьтесь с надёжным источником.",
      "plain": "Время рассчитано для центра города {city}. Свечи зажигают за 20 минут до заката. Если время важно с точки зрения галахи, сверьтесь с надёжным источником."
    },
    "famcal": {
      "title": "Напоминания по зманим в FamCal"
    },
    "sources": {
      "title": "Источники",
      "geonames": "Координаты городов: <link>GeoNames</link>, лицензия CC BY 4.0.",
      "osm": "Границы населённых пунктов для расчёта высоты: © участники <link>OpenStreetMap</link>.",
      "copernicus": "Высоты: Copernicus DEM GLO-90."
    }
  },
```

- [ ] **Step 14: Run it green.** Run the same command as Step 8. Expected: `11/11 passed` (Z1-Z7, Z9, Z10, Z12, Z13; Z8 is the `common()` inside them).
  - If Z8's Russian check names a holiday title (Task 2's diaspora names), fix that name in `holidays.names` (ru) with a no-break space. Do not loosen the check.
  - If Z4 finds the link order differs, check `cityPath`'s `date`-then-`community` order before changing the smoke.

- [ ] **Step 15: Run every smoke this touches**, each with the env prefix of Step 8, in place of the smoke file:
  - `scripts/smoke-zmanim-public-view.ts` and `scripts/smoke-zmanim-sheet.ts` (Steps 1-6 changed the four ru strings);
  - `scripts/smoke-calendar-home-copy.ts`, `scripts/smoke-zman-cards.ts`, `scripts/smoke-zman-reminders.ts`, `scripts/smoke-zman-voice.ts` and `scripts/smoke-zman-model.ts`: they read `calendarHome.zmanim.names`, so check none compares a rendered Russian MISHEYAKIR against an unflattened message;
  - the site smokes: `scripts/smoke-site-truth.ts` (T3 reads the new TSX; T5 parity), `scripts/smoke-site-chrome.ts` (H5 lints the whole sheet), `scripts/smoke-site-landing.ts` (G7 over the sheet), `scripts/smoke-site-layouts.ts`, `scripts/smoke-site-seo.ts` and `scripts/smoke-site-pages.ts`;
  - `scripts/smoke-ru-formal.ts`, `scripts/smoke-he-neutral.ts`, `scripts/smoke-zmanim.ts` (its 'use client' scan) and `scripts/smoke-dst.ts`.

  Expected: each `N/N passed`. smoke-site-seo's sitemap check (S2) still passes, because Task 8 adds the city pages to the sitemap and to S2 together. In the worktree smoke-site-seo's S1 and smoke-site-pages' P2 and P5 fail for the estree-walker reason (Global Constraints): read their other checks here; the controller's CI mirror runs them whole.

- [ ] **Step 16: Typecheck and lint.**
```
cd /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/zp-wt && npx tsc --noEmit && npx eslint "app/[locale]/(site)/zmanim" components/site/zmanim src/site/zmanim src/site/site-css.ts scripts/smoke-zmanim-pages.ts scripts/smoke-zmanim-sheet.ts && npx tsx scripts/check-i18n-parity.ts
```
Expected: no tsc or eslint output, and `i18n parity OK`. If tsc rejects passing `getTranslations`' translator as `SiteT`, the cause is next-intl's generic key type. In that case type `t` as `Awaited<ReturnType<typeof getTranslations>>` in words.ts, instead of casting at the call site.

- [ ] **Step 17: Commit.**
```
cd /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/zp-wt && git add "app/[locale]/(site)/zmanim/[city]/page.tsx" components/site/zmanim/words.ts components/site/zmanim/DayCard.tsx components/site/zmanim/CommunitySwitch.tsx components/site/zmanim/AheadCard.tsx components/site/zmanim/MonthGrid.tsx components/site/zmanim/MonthList.tsx components/site/zmanim/PageNote.tsx components/site/zmanim/Sources.tsx components/site/zmanim/FamCalBlock.tsx src/site/zmanim/links.ts src/site/zmanim/sources.ts src/site/site-css.ts messages/en.json messages/he.json messages/ru.json scripts/smoke-zmanim-pages.ts && git commit -m "feat(zmanim-site): a page per city with the day, the Shabbat and Yom Tov ahead and the month

The sun sheet's own rows on a public page, with the community switch, a month table
and its list, the note, FamCal and the sources; plain nofollow links, a clean
canonical, a failed section logged and worded.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31"
```

---

### Task 7: Index page and "Near me"

**Files:**
- Create: `src/lib/geolocation.ts`, `src/site/zmanim/near-words.ts`, `src/site/zmanim/city-groups.ts`, `components/site/zmanim/NearMe.tsx`, `app/[locale]/(site)/zmanim/page.tsx`
- Modify: `app/[locale]/(app)/settings/location-lookup.ts`: header lines 1-6, and remove lines 68-77 (`devicePosition`)
- Modify: `app/[locale]/(app)/settings/LocationSheet.tsx`: line 14 (the import) and lines 38-56 (`useCurrent`)
- Modify: `src/site/site-css.ts`: append the index and Near me rules to `ZMANIM_PAGE_CSS` (Task 6's block), before its closing backtick
- Modify: `scripts/smoke-zmanim-pages.ts`: `TAPS` gains the Task 7 selectors, and a new check Z11 is inserted before `finish()`
- Test: `scripts/smoke-zmanim-near-me.ts` (new)

**Interfaces:**
- Consumes:
  - `NearCity`, `nearAnswer`, `haversineKm`, `utcOffsetMinutes`, `OPEN_KM` and `NEAR_KM` (src/site/near-city.ts, Task 3), and `CITIES` (Task 3);
  - `cityPath` and `localeHref` (Task 6), and `Sources` (Task 6);
  - `siteMetadata`, `intlLocale` and `SitePage`.
- Produces:
  - `GeoResult`, `currentPosition()` and `POSITION_OPTIONS` (src/lib/geolocation.ts);
  - `NearMeWords`, `NearMeCity` and `nearWords(t)` (src/site/zmanim/near-words.ts);
  - `cityGroups(...)` and `CityGroup` (src/site/zmanim/city-groups.ts);
  - `NearMe({ cities, words })` ('use client');
  - the route `/[locale]/zmanim`.

- [ ] **Step 1: Write the failing Near me smoke.** Create `scripts/smoke-zmanim-near-me.ts`:

```ts
// Smoke test for "Near me" on /zmanim and the shared position helper (plan 6a Task 7; spec 2026-10-30-public-zmanim
// §4.1.2, §9).
//
//  - N1 currentPosition asks with the Settings lookup's options and answers a position, a refusal, an unavailable or
//    timed-out position, or no geolocation at all, as data;
//  - N2 Near me in real React on the fake DOM, in en, he and ru: within 30 km it opens that city's page; from 30 to 100 km
//    in the device's own UTC offset it names the city and its distance with a link; further away, or in another offset,
//    "no city near you"; a refusal says where to allow location; an unavailable or missing position says so; each failure
//    points to the list;
//  - N3 while waiting the button shows its loading state, and an answer clears it;
//  - N4 no request carries the position: no fetch at all, and the page opened is the city's own clean address.
//
// The device's zone is the process's: this smoke runs itself under TZ=Asia/Jerusalem (as ci-smokes.sh does) if it isn't.

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createElement as h } from 'react';
import { elements, fakeWindow, installWindow, mount, type FakeElement } from './lib/fake-dom';
import { assert, check, finish, LOCALES, load, messages, show, type Row } from './lib/site-harness';

if (process.env.TZ !== 'Asia/Jerusalem') {
  execFileSync(process.execPath, [...process.execArgv, __filename], { env: { ...process.env, TZ: 'Asia/Jerusalem' }, stdio: 'inherit' });
  process.exit(0);
}

const nodeRequire = createRequire(__filename);
const React = nodeRequire('react');
const { createTranslator } = nodeRequire('next-intl');
const setNavigator = (value: Row) => Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });

async function main() {
  const navigatorBefore = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const restoreNavigator = () => {
    if (navigatorBefore) Object.defineProperty(globalThis, 'navigator', navigatorBefore);
  };
  const { currentPosition, POSITION_OPTIONS } = await load('src/lib/geolocation.ts');
  const { CITIES } = await load('src/site/cities.ts');
  const { haversineKm, utcOffsetMinutes, OPEN_KM, NEAR_KM } = await load('src/site/near-city.ts');
  const { cityPath, localeHref } = await load('src/site/zmanim/links.ts');
  const { nearWords } = await load('src/site/zmanim/near-words.ts');
  const { NearMe } = await load('components/site/zmanim/NearMe.tsx');
  const settle = () => React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

  await check('N1 currentPosition: the Settings lookup\'s options; a position, a refusal, an unavailable or timed-out position, no geolocation', async () => {
    try {
      let asked: Row | null = null;
      setNavigator({ geolocation: { getCurrentPosition: (ok: (p: Row) => void, _fail: unknown, options: Row) => { asked = options; ok({ coords: { latitude: 31.77, longitude: 35.21 } }); } } });
      assert(show(await currentPosition()) === show({ kind: 'ok', latitude: 31.77, longitude: 35.21 }), 'a position');
      assert(show(asked) === show({ enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 }) && show(POSITION_OPTIONS) === show(asked), `the options ${show(asked)}`);
      for (const [code, kind] of [[1, 'denied'], [2, 'unavailable'], [3, 'unavailable'], [undefined, 'unavailable']] as const) {
        setNavigator({ geolocation: { getCurrentPosition: (_ok: unknown, fail: (e: Row) => void) => fail({ code }) } });
        const got = await currentPosition();
        assert(got.kind === kind, `code ${code}: ${show(got)}`);
      }
      setNavigator({});
      assert((await currentPosition()).kind === 'unsupported', 'no geolocation');
    } finally {
      restoreNavigator();
    }
  });

  installWindow();
  const assigned: string[] = [];
  fakeWindow.location.assign = (href: string) => void assigned.push(href);
  const fetched: unknown[] = [];
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = (async (...args: unknown[]) => {
    fetched.push(args);
    throw new Error('no network in this smoke');
  }) as typeof fetch;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = new Date();
  const nearest = (point: Row) => CITIES.map((c: Row) => ({ c, km: haversineKm(point, c) })).sort((a: Row, b: Row) => a.km - b.km)[0];
  const sameOffset = (c: Row) => utcOffsetMinutes(c.timeZone, now) === utcOffsetMinutes(zone, now);
  const JERUSALEM = CITIES.find((c: Row) => c.slug === 'jerusalem');
  const MITZPE_RAMON = { latitude: 30.6103, longitude: 34.8015 };
  const MID_SEA = { latitude: 34.0, longitude: 25.0 };
  const OXFORD = { latitude: 51.752, longitude: -1.2577 };

  try {
    await check('N2 Near me in en, he and ru: open within 30 km, the near city and its distance from 30 to 100 km in the same offset, "no city near you" further or in another offset, and each failure\'s line with the way to the list', async () => {
      assert(zone === 'Asia/Jerusalem', `the device's zone ${zone}`);
      const band = nearest(MITZPE_RAMON);
      assert(band.km > OPEN_KM && band.km <= NEAR_KM && sameOffset(band.c), `the near fixture: ${band.c.slug} at ${band.km} km`);
      assert(nearest(MID_SEA).km > NEAR_KM, 'the far fixture is near a city');
      const oxford = nearest(OXFORD);
      assert(oxford.km > OPEN_KM && oxford.km <= NEAR_KM && !sameOffset(oxford.c), `the other-offset fixture: ${oxford.c.slug} at ${oxford.km} km`);
      for (const locale of LOCALES) {
        const words = nearWords(createTranslator({ locale, messages: messages[locale] }));
        assert(words.near.includes('{city}') && words.near.includes('{km}') && words.opening.includes('{city}'), `${locale}: the templates`);
        const cities = CITIES.map((c: Row) => ({ slug: c.slug, latitude: c.latitude, longitude: c.longitude, timeZone: c.timeZone, name: messages[locale].cities[c.slug], href: localeHref(locale, cityPath(c.slug)) }));
        const byslug = (slug: string) => cities.find((c: Row) => c.slug === slug);
        const tap = async (geolocation: Row | undefined) => {
          setNavigator(geolocation === undefined ? {} : { geolocation });
          const m = mount(h(NearMe, { cities, words }));
          m.click(elements(m.container).find((e) => e.localName === 'button') as FakeElement);
          await settle();
          return m;
        };
        const at = (point: Row) => ({ getCurrentPosition: (ok: (p: Row) => void) => ok({ coords: point }) });
        const refused = (code: number) => ({ getCurrentPosition: (_ok: unknown, fail: (e: Row) => void) => fail({ code }) });
        const statusOf = (m: Row) => elements(m.container).find((e) => e.getAttribute('role') === 'status') as FakeElement;
        const toList = (m: Row) => elements(statusOf(m)).find((e) => e.localName === 'a' && e.getAttribute('href') === '#cities');

        assigned.length = 0;
        let m = await tap(at({ latitude: JERUSALEM.latitude, longitude: JERUSALEM.longitude }));
        assert(show(assigned) === show([byslug('jerusalem').href]), `${locale}: opened ${show(assigned)}`);
        assert(statusOf(m).textContent === words.opening.replace('{city}', byslug('jerusalem').name), `${locale}: ${statusOf(m).textContent}`);
        m.unmount();

        m = await tap(at(MITZPE_RAMON));
        const city = byslug(band.c.slug);
        const link = elements(statusOf(m)).find((e) => e.localName === 'a');
        assert(statusOf(m).textContent === words.near.replace('{city}', city.name).replace('{km}', String(Math.round(band.km))), `${locale}: the near line ${statusOf(m).textContent}`);
        assert(link?.getAttribute('href') === city.href && link.textContent === city.name, `${locale}: the near city's link`);
        m.unmount();

        for (const [where, point] of [['far away', MID_SEA], ['another offset', OXFORD]] as const) {
          m = await tap(at(point));
          assert(statusOf(m).textContent?.includes(words.none) && toList(m)?.textContent === words.toList, `${locale} ${where}: ${statusOf(m).textContent}`);
          m.unmount();
        }
        for (const [what, geolocation, line] of [['refused', refused(1), words.denied], ['unavailable', refused(2), words.unavailable], ['timed out', refused(3), words.unavailable], ['no geolocation', undefined, words.unsupported]] as const) {
          m = await tap(geolocation);
          assert(statusOf(m).textContent?.includes(line) && toList(m)?.textContent === words.toList, `${locale} ${what}: ${statusOf(m).textContent}`);
          m.unmount();
        }
        assert(assigned.length === 1, `${locale}: a page opened without a city within 30 km: ${show(assigned)}`);
      }
    });

    await check('N3 while waiting the button shows its loading state, and an answer clears it', async () => {
      for (const locale of LOCALES) {
        const words = nearWords(createTranslator({ locale, messages: messages[locale] }));
        let answer: ((e: Row) => void) | null = null;
        setNavigator({ geolocation: { getCurrentPosition: (_ok: unknown, fail: (e: Row) => void) => { answer = fail; } } });
        const m = mount(h(NearMe, { cities: [], words }));
        const button = () => elements(m.container).find((e) => e.localName === 'button') as FakeElement;
        assert(button().textContent === words.button && !button().hasAttribute('disabled'), `${locale}: the button at first`);
        m.click(button());
        assert(button().hasAttribute('disabled') && button().textContent === words.locating && button().getAttribute('aria-busy') === 'true', `${locale}: no loading state`);
        await React.act(async () => {
          answer?.({ code: 2 });
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
        assert(!button().hasAttribute('disabled') && button().textContent === words.button && button().getAttribute('aria-busy') === 'false', `${locale}: the loading state stays`);
        m.unmount();
      }
    });

    await check('N4 no request carries the position: no fetch, and the page opened is the city\'s own clean address', () => {
      assert(fetched.length === 0, `requests: ${show(fetched)}`);
      assert(assigned.every((href) => /^(?:\/(?:he|ru))?\/zmanim\/[a-z-]+$/.test(href)), `opened ${show(assigned)}`);
    });
  } finally {
    restoreNavigator();
    globalThis.fetch = fetchBefore;
  }

  finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

In `scripts/smoke-zmanim-pages.ts`, change the `TAPS` line to:
```ts
const TAPS = ['.site-zm-arrow', '.site-zm-today a', '.site-zm-switch a', '.site-zm-cell', '.site-zm-sources a', '.site-zm-near-button', '.site-zm-near-list', '.site-zm-near-status a', '.site-zm-cities a'];
```
Then insert this check just before its `finish();`:
```ts
  await check('Z11 /zmanim in en, he and ru: the title and its line, Near me\'s button and privacy line, every city once (Israel first, then the countries by name, each country\'s cities by name in the page\'s language), plain links to the clean pages; the metadata', async () => {
    const { default: IndexPage, generateMetadata: indexMetadata } = await load('app/[locale]/(site)/zmanim/page.tsx');
    const { CITIES } = await load('src/site/cities.ts');
    const { intlLocale } = await load('src/lib/calendar-view/format.ts');
    for (const locale of LOCALES) {
      request.locale = locale;
      const html = await wrap(locale, (await IndexPage({ params: Promise.resolve({ locale }) })) as ReactElement);
      common(locale, html, 'index');
      const z = messages[locale].zmanimSite;
      const t = nodeRequire('next-intl').createTranslator({ locale, messages: messages[locale] });
      const text = decodeEntities(textOf(html));
      assert(text.includes(z.index.title) && text.includes(t('zmanimSite.index.lead', { count: CITIES.length })), `${locale}: the title and its line`);
      assert(text.includes(z.near.button) && text.includes(z.near.privacy), `${locale}: Near me`);
      const collator = new Intl.Collator(intlLocale(locale));
      const groups = [...html.matchAll(/<section class="site-zm-country"[^>]*>([\s\S]*?)<\/section>/g)].map((m) => ({
        name: decodeEntities(textOf(between(m[1], '<h3', '</h3>'))),
        hrefs: attrs(m[1], 'a').map((a) => decodeEntities(attr(a, 'href') ?? '')),
        names: [...m[1].matchAll(/<a [^>]*>([^<]*)<\/a>/g)].map((x) => decodeEntities(x[1])),
      }));
      assert(groups[0]?.name === messages[locale].countries.IL, `${locale}: the first group is ${groups[0]?.name}`);
      const rest = groups.slice(1).map((g) => g.name);
      assert(show(rest) === show([...rest].sort(collator.compare)), `${locale}: the countries' order ${show(rest)}`);
      for (const g of groups) assert(show(g.names) === show([...g.names].sort(collator.compare)), `${locale}: ${g.name}'s cities ${show(g.names)}`);
      const hrefs = groups.flatMap((g) => g.hrefs);
      assert(show([...hrefs].sort()) === show(CITIES.map((c: Row) => `${prefix(locale)}/zmanim/${c.slug}`).sort()), `${locale}: the city links`);
      assert(html.includes('id="cities"'), `${locale}: the list has no anchor for Near me`);
      const meta = await indexMetadata({ params: Promise.resolve({ locale }) });
      assert(meta.title === z.index.metaTitle && meta.alternates.canonical === pageUrl(locale, '/zmanim'), `${locale}: the metadata ${show([meta.title, meta.alternates?.canonical])}`);
    }
  });
```

- [ ] **Step 2: Run both red.**
```
cd /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/zp-wt && env TZ=Asia/Jerusalem DATABASE_URL=postgresql://fake:fake@127.0.0.1:1/fake DIRECT_URL=postgresql://fake:fake@127.0.0.1:1/fake TELEGRAM_BOT_TOKEN=000000:fake WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 ENCRYPTION_KEY_PREVIOUS= NODE_ENV=development 'GOOGLE_TTS_CREDENTIALS={}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-zmanim-near-me.ts
```
Expected: exit 1, `Cannot find module '.../src/lib/geolocation.ts'`.

Then run the same prefix with `scripts/smoke-zmanim-pages.ts`. Expected: `FAIL  Z9 ...` (no rule for `.site-zm-near-button`), `FAIL  Z11 ...` (`Cannot find module '.../app/[locale]/(site)/zmanim/page.tsx'`) and `11/13 passed`.

- [ ] **Step 3: Write the position helper.** Create `src/lib/geolocation.ts`:

```ts
// The device's position, asked of the browser: Settings' "Use my current location" and the zmanim index's "Near me"
// (spec 2026-10-30-public-zmanim §4.1.2, §6.3). One request with one set of options, and its outcome as data, so each
// caller words and logs it its own way (a refusal is the person's choice, not an error). The timeout is the
// Geolocation API's own option, not an app timer. The position goes back to the caller only; this file sends nothing.
// Client-safe: no import.

export type GeoResult = { kind: 'ok'; latitude: number; longitude: number } | { kind: 'denied' } | { kind: 'unavailable' } | { kind: 'unsupported' };

/** No high accuracy, the browser's own 10 s timeout, and a position up to 5 minutes old. */
export const POSITION_OPTIONS: PositionOptions = { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 };

/** GeolocationPositionError.PERMISSION_DENIED (the constant isn't on every browser's error object). */
const PERMISSION_DENIED = 1;

/** The device's position, or why there is none. Never rejects. */
export function currentPosition(): Promise<GeoResult> {
  const geolocation = typeof navigator === 'undefined' ? undefined : navigator.geolocation;
  if (!geolocation) return Promise.resolve({ kind: 'unsupported' });
  return new Promise<GeoResult>((resolve) => {
    try {
      geolocation.getCurrentPosition(
        (position) => resolve({ kind: 'ok', latitude: position.coords.latitude, longitude: position.coords.longitude }),
        (error) => resolve({ kind: error?.code === PERMISSION_DENIED ? 'denied' : 'unavailable' }),
        POSITION_OPTIONS,
      );
    } catch (error) {
      console.warn('[geolocation] the browser refused to ask for the position:', error);
      resolve({ kind: 'unavailable' });
    }
  });
}
```

- [ ] **Step 4: Switch Settings to it.** In `app/[locale]/(app)/settings/location-lookup.ts`, the header lines 1-6 now read:
```ts
// Settings' location: checking a typed place, and finding the place the device is in.
// - The typed place is checked by our server (POST /api/location/check), so OpenStreetMap sees our server's address and
//   never the person's; the answer's meaning is src/lib/location-place.ts's, shared with the server.
// - "Use my location" asks OpenStreetMap's reverse lookup from the browser: the Privacy Policy promises the device's
//   position never reaches our servers, and names OpenStreetMap's receipt of the browser's IP address for it.
// A failure is logged.
```
Replace them with:
```ts
// Settings' location: checking a typed place, and naming the place the device is in.
// - The typed place is checked by our server (POST /api/location/check), so OpenStreetMap sees our server's address and
//   never the person's; the answer's meaning is src/lib/location-place.ts's, shared with the server.
// - "Use my location" takes the device's position from src/lib/geolocation.ts (shared with the zmanim pages' Near me) and
//   asks OpenStreetMap's reverse lookup from the browser: the Privacy Policy promises the device's position never reaches
//   our servers, and names OpenStreetMap's receipt of the browser's IP address for it.
// A failure is logged.
```
Then delete lines 68-77, the whole `devicePosition` function:
```ts
/** The device's position (browser geolocation; rejects when it is refused, unavailable or slow). */
export function devicePosition(): Promise<GeolocationPosition> {
  return new Promise<GeolocationPosition>((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: false,
      timeout: 10000,
      maximumAge: 300000, // 5 minutes cache
    });
  });
}
```

In `app/[locale]/(app)/settings/LocationSheet.tsx`:
- line 14, `import { devicePosition, reverseLookup } from './location-lookup';`, becomes two lines:
```ts
import { currentPosition } from '@/src/lib/geolocation';
import { reverseLookup } from './location-lookup';
```
- lines 38-56 (`const useCurrent = async () => { ... };`) are replaced by:
```ts
  const useCurrent = async () => {
    setLocating(true);
    setDeviceProblem(null);
    try {
      const found = await currentPosition();
      if (found.kind === 'unsupported') {
        setDeviceProblem('noDeviceLocation');
        return;
      }
      if (found.kind !== 'ok') {
        console.error(`[settings] current location failed: the position is ${found.kind}`);
        setDeviceProblem('deviceFailed');
        return;
      }
      const place = await reverseLookup(found.latitude, found.longitude);
      if (place) onDraft(place);
      else setDeviceProblem('deviceFailed');
    } catch (error) {
      console.error('[settings] current location failed:', error);
      setDeviceProblem('deviceFailed');
    } finally {
      setLocating(false);
    }
  };
```
(The same outcomes as today:
- no geolocation gives `noDeviceLocation`;
- a refusal or a failure gives `deviceFailed`, logged under "[settings] current location failed";
- a reverse lookup that throws is caught.)

- [ ] **Step 5: Write Near me.** Create `src/site/zmanim/near-words.ts`:

```ts
// What Near me needs from the server (spec 2026-10-30-public-zmanim §6.3): each city's point, zone, name and page, and
// its words, already in the page's language, as props, so the site's client namespaces stay ['site'] (src/site/
// messages.ts). The templates keep their {city} and {km}: the island fills them. A plain module, so the server page can
// call nearWords (a function exported from a 'use client' file can't be called on the server). Client-safe: types only.

import type { NearCity } from '@/src/site/near-city';

export type NearMeCity = NearCity & { name: string; href: string };

export interface NearMeWords {
  button: string;
  locating: string;
  privacy: string;
  /** With {city}. */
  opening: string;
  /** With {city} and {km}. */
  near: string;
  none: string;
  denied: string;
  unavailable: string;
  unsupported: string;
  toList: string;
}

const KEYS: readonly (keyof NearMeWords)[] = ['button', 'locating', 'privacy', 'opening', 'near', 'none', 'denied', 'unavailable', 'unsupported', 'toList'];

/** Near me's words from zmanimSite.near, raw (the templates' arguments stay for the island). */
export function nearWords(t: { raw: (key: string) => unknown }): NearMeWords {
  return Object.fromEntries(KEYS.map((key) => [key, String(t.raw(`zmanimSite.near.${key}`))])) as unknown as NearMeWords;
}
```

Create `components/site/zmanim/NearMe.tsx`:

```tsx
'use client';

// "Near me" (spec 2026-10-30-public-zmanim §4.1.2), the zmanim index's only script. A tap asks the browser for the
// position (src/lib/geolocation.ts, the Settings lookup's options), finds the nearest listed city on the device
// (src/site/near-city.ts, haversine) and answers by distance: within 30 km it opens that city's page; from 30 to 100 km,
// in the device's own UTC offset, it names the city and the distance, with a link; further away, or in another offset, it
// says no city is near yet and points to the list. A refusal, an unavailable position or a browser with no geolocation
// says so and points to the list (a refusal also says where to allow location). The button shows a loading state until
// any answer. Nothing is sent anywhere: no map, no lookup, no request; only the city's page is opened. It imports nothing
// from src/services (CLAUDE.md).

import { useState, type ReactNode } from 'react';
import { Loader2, MapPin } from 'lucide-react';
import { currentPosition } from '@/src/lib/geolocation';
import { nearAnswer } from '@/src/site/near-city';
import type { NearMeCity, NearMeWords } from '@/src/site/zmanim/near-words';

type State =
  | { kind: 'idle' }
  | { kind: 'locating' }
  | { kind: 'opening'; city: NearMeCity }
  | { kind: 'near'; city: NearMeCity; km: number }
  | { kind: 'none' | 'denied' | 'unavailable' | 'unsupported' };

/** A template's {name}s filled in. */
function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole);
}

export function NearMe({ cities, words }: { cities: NearMeCity[]; words: NearMeWords }) {
  const [state, setState] = useState<State>({ kind: 'idle' });

  const find = async () => {
    setState({ kind: 'locating' });
    try {
      const found = await currentPosition();
      if (found.kind !== 'ok') {
        console.warn(`[near-me] no position: ${found.kind}`);
        setState({ kind: found.kind });
        return;
      }
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const answer = nearAnswer({ latitude: found.latitude, longitude: found.longitude }, zone, new Date(), cities);
      const city = answer.kind === 'none' ? undefined : cities.find((c) => c.slug === answer.slug);
      if (answer.kind === 'open' && city) {
        setState({ kind: 'opening', city });
        window.location.assign(city.href);
        return;
      }
      if (answer.kind === 'near' && city) {
        setState({ kind: 'near', city, km: Math.round(answer.km) });
        return;
      }
      setState({ kind: 'none' });
    } catch (error) {
      console.error('[near-me] the nearest city could not be found:', error);
      setState({ kind: 'unavailable' });
    }
  };

  const busy = state.kind === 'locating';
  const toList = (
    <p>
      <a className="site-zm-near-list" href="#cities">
        {words.toList}
      </a>
    </p>
  );
  let answer: ReactNode = null;
  if (state.kind === 'opening') answer = <p>{fill(words.opening, { city: state.city.name })}</p>;
  else if (state.kind === 'near') {
    const [before, after = ''] = words.near.split('{city}');
    const km = String(state.km);
    answer = (
      <p>
        {fill(before, { km })}
        <a href={state.city.href}>{state.city.name}</a>
        {fill(after, { km })}
      </p>
    );
  } else if (state.kind === 'none' || state.kind === 'denied' || state.kind === 'unavailable' || state.kind === 'unsupported') {
    answer = (
      <>
        <p>{words[state.kind]}</p>
        {toList}
      </>
    );
  }

  return (
    <div className="site-zm-near-body">
      <button type="button" className="site-zm-near-button" onClick={find} disabled={busy} aria-busy={busy}>
        {busy ? <Loader2 className="site-icon site-zm-spin" aria-hidden="true" focusable="false" /> : <MapPin className="site-icon" aria-hidden="true" focusable="false" />}
        {busy ? words.locating : words.button}
      </button>
      <p className="site-zm-near-privacy">{words.privacy}</p>
      <div className="site-zm-near-status" role="status" aria-live="polite">
        {answer}
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Write the index page.** Create `src/site/zmanim/city-groups.ts`:

```ts
// The zmanim index's list (spec 2026-10-30-public-zmanim §4.1.3): the cities by country, Israel first, then the other
// countries by name, each country's cities by name, in the page's language (Intl.Collator; names from messages, never
// Intl.DisplayNames). Pure.

import type { City } from '@/src/site/cities';

const ISRAEL = 'IL';

export type CityGroup = { country: string; name: string; cities: { slug: string; name: string }[] };

export function cityGroups(cities: readonly City[], cityName: (slug: string) => string, countryName: (code: string) => string, collator: Intl.Collator): CityGroup[] {
  const byCountry = new Map<string, CityGroup>();
  for (const city of cities) {
    const group = byCountry.get(city.country) ?? { country: city.country, name: countryName(city.country), cities: [] };
    group.cities.push({ slug: city.slug, name: cityName(city.slug) });
    byCountry.set(city.country, group);
  }
  const groups = [...byCountry.values()];
  for (const group of groups) group.cities.sort((a, b) => collator.compare(a.name, b.name));
  return groups.sort((a, b) => (a.country === ISRAEL ? -1 : b.country === ISRAEL ? 1 : collator.compare(a.name, b.name)));
}
```

Create `app/[locale]/(site)/zmanim/page.tsx`:

```tsx
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { SitePage } from '@/components/site/SitePage';
import { NearMe } from '@/components/site/zmanim/NearMe';
import { Sources } from '@/components/site/zmanim/Sources';
import { intlLocale } from '@/src/lib/calendar-view/format';
import { CITIES } from '@/src/site/cities';
import { siteMetadata } from '@/src/site/seo';
import { cityGroups } from '@/src/site/zmanim/city-groups';
import { cityPath, localeHref } from '@/src/site/zmanim/links';
import { nearWords } from '@/src/site/zmanim/near-words';

// The zmanim index (spec 2026-10-30-public-zmanim §4.1): the title and one line, Near me (the page's only script), and the
// city list: Israel first, then the countries, each sorted by name in the page's language, each city a 44 px link to its
// clean page (a plain anchor: a prefetching list of city pages would spend a reader's request allowance). Static per
// locale. The sources at the bottom, as on a city's page.

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale });
  return siteMetadata({ locale, path: '/zmanim', title: t('zmanimSite.index.metaTitle'), description: t('zmanimSite.index.description', { count: CITIES.length }), imageAlt: t('landing.meta.ogImageAlt') });
}

export default async function ZmanimIndexPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale });
  const cityName = (slug: string) => t(`cities.${slug}`);
  const groups = cityGroups(CITIES, cityName, (code) => t(`countries.${code}`), new Intl.Collator(intlLocale(locale)));
  const near = CITIES.map((c) => ({ slug: c.slug, latitude: c.latitude, longitude: c.longitude, timeZone: c.timeZone, name: cityName(c.slug), href: localeHref(locale, cityPath(c.slug)) }));
  return (
    <SitePage locale={locale} path="/zmanim">
      <main id="main" className="site-section site-page-main">
        <div className="site-wrap site-narrow">
          <h1 className="site-h1 site-page-title">{t('zmanimSite.index.title')}</h1>
          <p className="site-lead">{t('zmanimSite.index.lead', { count: CITIES.length })}</p>
          <section className="site-zm-near" aria-labelledby="near-title">
            <h2 id="near-title" className="site-h3">
              {t('zmanimSite.near.title')}
            </h2>
            <NearMe cities={near} words={nearWords(t)} />
          </section>
          <section id="cities" className="site-zm-section" aria-labelledby="cities-title">
            <h2 id="cities-title" className="site-h2">
              {t('zmanimSite.index.listTitle')}
            </h2>
            <div className="site-zm-countries">
              {groups.map((group) => (
                <section key={group.country} className="site-zm-country" aria-labelledby={`country-${group.country}`}>
                  <h3 id={`country-${group.country}`} className="site-h3">
                    {group.name}
                  </h3>
                  <ul className="site-zm-cities">
                    {group.cities.map((city) => (
                      <li key={city.slug}>
                        <a href={localeHref(locale, cityPath(city.slug))}>{city.name}</a>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          </section>
          <Sources t={t} />
        </div>
      </main>
    </SitePage>
  );
}
```

- [ ] **Step 7: Add the index CSS.** In `src/site/site-css.ts`, append these rules at the end of `ZMANIM_PAGE_CSS`, just before its closing backtick. They follow the same lint rules as Task 6's block:
- the spinner's only `animation:` sits in the reduced-motion no-preference block, with its inner rules indented, so G7's lazy `\n}` match ends at the block's own brace;
- the button is `--ch-button-text` on `--ch-button`, a pair G7 holds;
- inputs aren't used, so there is no 16 px rule to add.

```css
.site-zm-near {
  margin-block-start: 32px;
  padding: 20px 24px;
  border-radius: 20px;
  background: var(--ch-card);
}
.site-zm-near-body {
  margin-block-start: 12px;
}
.site-zm-near-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-block-size: 48px;
  padding-inline: 18px;
  border: 0;
  border-radius: 14px;
  background: var(--ch-button);
  color: var(--ch-button-text);
  font-family: inherit;
  font-size: 16px;
  font-weight: 650;
  cursor: pointer;
  touch-action: manipulation;
}
.site-zm-near-button:disabled {
  cursor: progress;
}
.site-zm-near-privacy {
  margin-block-start: 10px;
  color: var(--ch-muted);
  font-size: 15px;
}
.site-zm-near-status p {
  margin-block-start: 12px;
  font-size: 16px;
}
.site-zm-near-status a {
  display: inline-flex;
  align-items: center;
  min-block-size: 44px;
  color: var(--ch-accent);
  font-weight: 600;
  text-decoration: underline;
  text-underline-offset: 3px;
}
.site-zm-near-list {
  display: inline-flex;
  align-items: center;
  min-block-size: 44px;
}
.site-zm-countries {
  display: grid;
  gap: 16px;
  margin-block-start: 20px;
}
.site-zm-country {
  padding: 6px 20px 12px;
  border-radius: 18px;
  background: var(--ch-surface);
}
.site-zm-country .site-h3 {
  padding-block: 12px 4px;
}
.site-zm-cities {
  columns: 2;
  column-gap: 16px;
}
.site-zm-cities li {
  break-inside: avoid;
}
.site-zm-cities a {
  display: flex;
  align-items: center;
  min-block-size: 44px;
  color: var(--ch-text);
  text-decoration: none;
  overflow-wrap: anywhere;
}
@media (min-width: 720px) {
  .site-zm-countries {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .site-zm-country:first-child {
    grid-column: 1 / -1;
  }
  .site-zm-country:first-child .site-zm-cities {
    columns: 3;
  }
}
@media (prefers-reduced-motion: no-preference) {
  .site-zm-spin {
    animation: site-zm-turn 900ms linear infinite;
  }
}
@keyframes site-zm-turn {
  to {
    transform: rotate(360deg);
  }
}
```

- [ ] **Step 8: Run both green.** Run Step 2's two commands again.
  - `scripts/smoke-zmanim-near-me.ts`: expected `4/4 passed`.
  - `scripts/smoke-zmanim-pages.ts`: expected `13/13 passed`. Z10 now finds `NearMe.tsx` as the one client component, and Z11 covers the index.
  - If N2's fixture checks fail on the city table (a city near Mitzpe Ramon within 30 km, or none within 100 km of Oxford), pick fixture points that sit in the stated bands of Task 3's table. Never widen the bands.

- [ ] **Step 9: Run every smoke this touches**, each with Step 2's env prefix, in place of the smoke file:
  - `scripts/smoke-settings-render.ts` (the location sheet: no geolocation, a position with its reverse lookup, a refusal logged as "[settings] current location failed");
  - `scripts/smoke-location-timezone.ts`;
  - the site smokes: `scripts/smoke-site-truth.ts` (T3 reads NearMe.tsx and the index), `scripts/smoke-site-chrome.ts`, `scripts/smoke-site-landing.ts`, `scripts/smoke-site-layouts.ts`, `scripts/smoke-site-pages.ts` and `scripts/smoke-site-seo.ts` (in the worktree smoke-site-seo's S1 and smoke-site-pages' P2 and P5 fail for the estree-walker reason in Global Constraints; the controller's CI mirror runs them whole);
  - `scripts/smoke-zmanim.ts` ('use client' files import no src/services/zmanim), `scripts/smoke-ru-formal.ts`, `scripts/smoke-he-neutral.ts` and `scripts/smoke-dst.ts`.

  Expected: each `N/N passed`.

- [ ] **Step 10: Typecheck and lint.**
```
cd /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/zp-wt && npx tsc --noEmit && npx eslint src/lib/geolocation.ts src/site/zmanim "app/[locale]/(site)/zmanim" components/site/zmanim "app/[locale]/(app)/settings/location-lookup.ts" "app/[locale]/(app)/settings/LocationSheet.tsx" src/site/site-css.ts scripts/smoke-zmanim-near-me.ts scripts/smoke-zmanim-pages.ts
```
Expected: no output, exit 0. tsc confirms nothing else imported `devicePosition`. At HEAD only LocationSheet.tsx did.

- [ ] **Step 11: Commit.**
```
cd /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/zp-wt && git add src/lib/geolocation.ts src/site/zmanim/near-words.ts src/site/zmanim/city-groups.ts components/site/zmanim/NearMe.tsx "app/[locale]/(site)/zmanim/page.tsx" "app/[locale]/(app)/settings/location-lookup.ts" "app/[locale]/(app)/settings/LocationSheet.tsx" src/site/site-css.ts scripts/smoke-zmanim-near-me.ts scripts/smoke-zmanim-pages.ts && git commit -m "feat(zmanim-site): the city list and Near me, the device's position shared with Settings

/zmanim lists every city (Israel first, then the countries, sorted in the page's
language); Near me finds the nearest listed city in the browser and sends nothing.
Settings' current location reads the same position helper.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31"
```

---

### Task 8: Chrome and SEO

**Files:**
- Modify: `scripts/smoke-site-truth.ts` (the `SITE_NAMESPACES` line; Task 6 Steps 1-6 already extended T6 through `RU_TYPOGRAPHY`)
- Modify: `messages/en.json`, `messages/he.json`, `messages/ru.json` (`site.nav`, after its `"blog"` line; `landing.features.jewish`, after its `"pause"` line)
- Modify: `components/site/SiteHeader.tsx` (lines 8-11 comment, lines 23-27 nav)
- Modify: `components/site/SiteMenu.tsx` (lines 10-13 comment, lines 40-45 list)
- Modify: `components/site/SiteFooter.tsx` (lines 6-9 comment, lines 28-30 list)
- Modify: `components/site/LandingSections.tsx` (lines 2-27 icon import, lines 155-166 the list)
- Modify: `src/site/site-css.ts` (LANDING_CSS, right after the `.site-list-icon` rule)
- Modify: `app/sitemap.ts` (whole file, 29 lines), `app/robots.ts` (whole file, 15 lines), `src/site/config.ts` (line 9)
- Test: `scripts/smoke-site-chrome.ts` (lines 4-19 comment, 59, 72, 107, 109, 152, 165-168, 182), `scripts/smoke-site-landing.ts` (header comment, new G13 after G12), `scripts/smoke-site-layouts.ts` (line 30), `scripts/smoke-site-seo.ts` (lines 1-18, 29-62, 70, 86-93), `scripts/smoke-site-pages.ts` (line 71)

**Interfaces:**
- Consumes: `CITIES`, `type City` (Task 3, `src/site/cities.ts`); `cities.<slug>` messages (Task 3); `app/[locale]/(site)/zmanim/page.tsx` (Task 7) and `app/[locale]/(site)/zmanim/[city]/page.tsx` (Task 6) with the metadata keys `zmanimSite.index.metaTitle`, `zmanimSite.index.description`, `zmanimSite.city.metaTitle` and `zmanimSite.city.description` (Contract note 24); the `.site-zm-*` tap-target rules in `SITE_CSS` (Tasks 6, 7; Contract note 25).
- Produces: `site.nav.zmanim` (en/he/ru); `landing.features.jewish.zmanimPages` (en/he/ru); the header, menu and footer link to `/zmanim`; the landing row; sitemap entries for `/zmanim` and `/zmanim/<slug>` for every `CITIES` row in each language; robots `disallow` `'/zmanim/*?'`, `'/he/zmanim/*?'`, `'/ru/zmanim/*?'`; `SITE_CONTENT_UPDATED` = the ship day.

- [ ] **Step 1: Truth lists gain the new namespaces.** In `scripts/smoke-site-truth.ts`, the line `const SITE_NAMESPACES = ['site', 'landing', 'legal', 'blog', 'share'];` becomes:

```ts
const SITE_NAMESPACES = ['site', 'landing', 'legal', 'blog', 'share', 'zmanimSite', 'cities', 'countries'];
```

(T1 the truth list, T2 no emoji and, through `RU_TYPOGRAPHY` (Task 6 Step 1), T6 now walk `zmanimSite`, `cities` and `countries`.) In the header comment, line 6 `string in en, he and ru: the site's namespaces, the bot's WhatsApp welcome and greeting, the WhatsApp onboarding` stays; it says "the site's namespaces" already.

- [ ] **Step 2: Write the failing smoke changes.**

`scripts/smoke-site-chrome.ts`:
- Header comment: line 4 `//  - H1 the header in en, he and ru: the logo to the home, How it works and Plans to the landing's sections, Blog, the` -> `//  - H1 the header in en, he and ru: the logo to the home, How it works and Plans to the landing's sections, Blog, Zmanim, the`; line 11 `//  - H3 the footer: How it works, Plans, Blog, Privacy, Terms, Cancel a payment (the Terms' #cancel) and Contact (the` -> `//  - H3 the footer: How it works, Plans, Blog, Zmanim, Privacy, Terms, Cancel a payment (the Terms' #cancel) and Contact (the`; line 14 `//    moves into it, and Escape, the scrim, the Close button and a link each close it with focus back on the button;` -> `//    moves into it, and Escape, the scrim, the Close button and a link (Plans, and Zmanim to another page) each close it with focus back on the button;`; line 17 `//    blocks), every tap target (the chrome's and the pages' links and buttons) at least 44 px, the wide and phone parts` -> `//    blocks), every tap target (the chrome's, the landing's zmanim row and the pages' links and buttons, the zmanim pages' too) at least 44 px, the wide and phone parts`.
- Line 59 becomes:

```ts
      for (const want of [p || '/', `${p || '/'}#how`, `${p || '/'}#plans`, `${p}/blog`, `${p}/zmanim`, `${p || '/'}#start`]) assert(hrefs.includes(want), `${locale}: no link to ${want} in ${show(hrefs)}`);
```

- Line 72 becomes:

```ts
      for (const word of [site.nav.howItWorks, site.nav.plans, site.nav.blog, site.nav.zmanim, site.cta.telegramShort, site.cta.whatsappShort, site.header.start]) assert(text.includes(word), `${locale}: no "${word}" in ${text}`);
```

- Line 107 becomes:

```ts
      for (const want of [`${p || '/'}#how`, `${p || '/'}#plans`, `${p}/blog`, `${p}/zmanim`, `${p}/privacy`, `${p}/terms`, `${p}/terms#cancel`, 'https://t.me/family_calendar_telegram_bot?start=feedback']) assert(hrefs.includes(want), `${locale}: no ${want} in ${show(hrefs)}`);
```

- Line 109 becomes:

```ts
      for (const word of [site.nav.zmanim, site.footer.privacy, site.footer.terms, site.footer.cancel, site.footer.contact, site.footer.madeIn]) assert(text.includes(word), `${locale}: no "${word}"`);
```

- Line 152 becomes:

```ts
      for (const want of [`${p || '/'}#how`, `${p || '/'}#plans`, `${p}/blog`, `${p}/zmanim`, '/en/blog', '/he/blog', '/ru/blog'].filter((href) => href !== `/${locale}/blog`)) assert(hrefs.includes(want), `${locale}: the sheet has no ${want}: ${show(hrefs)}`);
```

- After line 168 (`      closed('a link');`) add:

```ts
      step = 'zmanim link';
      d = open();
      m.click(elements(d).find((e) => e.localName === 'a' && e.textContent === site.nav.zmanim) as FakeElement);
      closed('the Zmanim link');
```

- Line 182 becomes (the zmanim pages' tap targets from Tasks 6 and 7, Contract note 25, and the landing row's link):

```ts
    for (const selector of ['.site-logo', '.site-nav a', '.site-langs a', '.site-jump', '.site-start', '.site-starts-compact .site-start', '.site-menu-list a', '.site-footer-links a', '.site-cancel-link', '.site-back a', '.site-post-card a', '.site-more a', '.site-copy', '.site-list-link', '.site-zm-arrow', '.site-zm-today a', '.site-zm-switch a', '.site-zm-cell', '.site-zm-sources a', '.site-zm-near-button', '.site-zm-near-list', '.site-zm-near-status a', '.site-zm-cities a']) {
```

`scripts/smoke-site-landing.ts`:
- Header comment, after the G9 lines (lines 22-24) add:

```ts
//  - G13 the Jewish calendar group's list ends with a row that links to the zmanim pages (/zmanim in the page's
//    language), in its own words, right before the Settings line (G11's anchor holds).
```

- After the G12 check (it ends before `finish();`), add:

```ts
  await check('G13 the Jewish calendar group\'s list ends with a row that links to the zmanim pages (/zmanim in the page\'s language) in its own words, right before the Settings line', () => {
    for (const locale of LOCALES) {
      const html = pages[locale];
      const group = html.slice(html.indexOf('<h3 id="features-jewish"'), html.indexOf('<h3 id="features-adding"'));
      const row = /<li class="site-list-row site-list-row-link">((?:(?!<\/li>)[\s\S])*)<\/li><\/ul><p class="site-group-note">/.exec(group)?.[1];
      assert(row !== undefined, `${locale}: no zmanim row at the end of the list`);
      const link = attrs(row, 'a').find((a) => attr(a, 'class') === 'site-list-link');
      const want = `${locale === 'en' ? '' : `/${locale}`}/zmanim`;
      assert(link && decodeEntities(attr(link, 'href') ?? '') === want, `${locale}: the row's link ${link}`);
      assert(textOf(row) === messages[locale].landing.features.jewish.zmanimPages, `${locale}: the row's words ${textOf(row)}`);
    }
  });
```

`scripts/smoke-site-layouts.ts` line 30 becomes:

```ts
const SITE_PAGES = ['page.tsx', 'blog', 'privacy', 'terms', 'share', 'zmanim'];
```

`scripts/smoke-site-pages.ts` line 71 becomes (the raw-key check knows the zmanim pages' namespaces; a country code is upper case):

```ts
    assert(!/\b(?:(?:landing|site|blog|share|legal|ui|zmanimSite|cities|calendarHome|holidays|zmanim)\.[a-z]+[A-Za-z.]*|countries\.[A-Z]{2})\b/.test(textOf(html).replace(/famcal\.bot|t\.me\/\S+|wa\.me\/\S+/g, '')), `${where} ${locale}: a raw key`);
```

`scripts/smoke-site-seo.ts`:
- Header comment lines 4-10 become:

```ts
//  - S1 every public page in en, he and ru has a canonical URL, its other languages and x-default, English unprefixed
//    and never /en; the title and description from messages; the share image of its language with its alt text, for
//    Open Graph and X; the landing's title stands alone; the share page stays noindex, with no canonical or languages;
//    a zmanim city page with a day and a community in its query still names the clean URL.
//  - S2 the sitemap: every indexed page in every language at the URL it is served at (no /en, no how-it-works, no
//    share page, no Mini App), Privacy and Terms included, the zmanim index and every city of src/site/cities.ts, each
//    with its languages and x-default, and the day its content changed, never the build's "now".
//  - S3 robots: the API and the Google connect pages kept out, no /admin, the zmanim pages with a query kept out in
//    every language while the clean ones stay open, the sitemap at the site's URL.
```

- Line 18 becomes two lines:

```ts
import { createRequire } from 'node:module';
import { assert, check, finish, LOCALES, load, messages, show, stubIntlServer, stubMdx, type Locale, type Row } from './lib/site-harness';
```

- After line 22 (`const POST = '/blog/why-i-built-famcal';`) add:

```ts
const CITY = 'jerusalem';
const { createTranslator } = createRequire(__filename)('next-intl');
/** A message with its arguments, as the page's translator words it. */
const word = (l: Locale, key: string, values: Record<string, string | number> = {}): string => createTranslator({ locale: l, messages: messages[l] })(key, values);
```

- Lines 30-41 (the `pages` array through the `generateMetadata` call) become:

```ts
    const { CITIES } = await load('src/site/cities.ts');
    const pages: { rel: string; path: string; title: (l: Locale) => string; description: (l: Locale) => string; params?: Row }[] = [
      { rel: 'app/[locale]/(site)/page.tsx', path: '/', title: (l) => messages[l].landing.meta.title, description: (l) => messages[l].landing.meta.description },
      { rel: 'app/[locale]/(site)/blog/page.tsx', path: '/blog', title: (l) => messages[l].site.meta.blog.title, description: (l) => messages[l].site.meta.blog.description },
      { rel: 'app/[locale]/(site)/blog/[slug]/page.tsx', path: POST, params: { slug: 'why-i-built-famcal' }, title: (l) => getPostBySlug('why-i-built-famcal', l).title, description: (l) => getPostBySlug('why-i-built-famcal', l).description },
      { rel: 'app/[locale]/(site)/privacy/page.tsx', path: '/privacy', title: (l) => messages[l].site.meta.privacy.title, description: (l) => messages[l].site.meta.privacy.description },
      { rel: 'app/[locale]/(site)/terms/page.tsx', path: '/terms', title: (l) => messages[l].site.meta.terms.title, description: (l) => messages[l].site.meta.terms.description },
      { rel: 'app/[locale]/(site)/share/page.tsx', path: '/share', title: (l) => messages[l].site.meta.share.title, description: (l) => messages[l].site.meta.share.description },
      { rel: 'app/[locale]/(site)/zmanim/page.tsx', path: '/zmanim', title: (l) => word(l, 'zmanimSite.index.metaTitle'), description: (l) => word(l, 'zmanimSite.index.description', { count: CITIES.length }) },
      { rel: 'app/[locale]/(site)/zmanim/[city]/page.tsx', path: `/zmanim/${CITY}`, params: { city: CITY }, title: (l) => word(l, 'zmanimSite.city.metaTitle', { city: messages[l].cities[CITY] }), description: (l) => word(l, 'zmanimSite.city.description', { city: messages[l].cities[CITY] }) },
    ];
    for (const page of pages) {
      const { generateMetadata } = await load(page.rel);
      for (const locale of LOCALES) {
        const m: Row = await generateMetadata({ params: Promise.resolve({ locale, ...(page.params ?? {}) }), searchParams: Promise.resolve({}) });
```

- Before the closing `});` of S1 (after the `for (const page of pages)` loop, line 61) add:

```ts
    // A day and a community travel in the query; the canonical, the languages and og:url stay the clean city URL
    const { generateMetadata: cityMetadata } = await load('app/[locale]/(site)/zmanim/[city]/page.tsx');
    for (const locale of LOCALES) {
      const m: Row = await cityMetadata({ params: Promise.resolve({ locale, city: CITY }), searchParams: Promise.resolve({ date: '2027-04-22', community: 'chabad' }) });
      const urls = [m.alternates?.canonical, ...Object.values(m.alternates?.languages ?? {}), m.openGraph?.url];
      assert(m.alternates?.canonical === url(locale, `/zmanim/${CITY}`) && urls.every((u) => typeof u === 'string' && !u.includes('?')), `${locale}: a city page with a query names ${show(urls)}`);
    }
```

- In the S1 check's name (line 29), append `; a zmanim city page with a query names the clean URL` before the closing quote.
- Line 70 becomes:

```ts
    const { CITIES } = await load('src/site/cities.ts');
    const want = ['/', '/blog', POST, '/privacy', '/terms', '/zmanim', ...CITIES.map((c: Row) => `/zmanim/${c.slug}`)].flatMap((p) => LOCALES.map((l) => url(l, p)));
```

- In the S2 check's name (line 64) replace `Privacy and Terms in,` with `Privacy and Terms in, the zmanim index and every city,`.
- Lines 86-93 (S3) become:

```ts
  await check('S3 robots: the API and the Google connect pages kept out, no /admin, the zmanim pages with a query kept out in every language and the clean ones open, the sitemap at the site\'s URL', async () => {
    const { default: robots } = await load('app/robots.ts');
    const r: Row = robots();
    const disallow: string[] = r.rules.disallow;
    for (const path of ['/api/', '/oauth-callback', '/oauth-complete', '/refresh-token', '/zmanim/*?', '/he/zmanim/*?', '/ru/zmanim/*?']) assert(disallow.includes(path), `${path} is not kept out`);
    assert(!disallow.some((p) => p.startsWith('/admin')), `robots names /admin: ${show(disallow)}`);
    // A rule as a crawler reads it: a prefix of the path and query, * for any run of characters
    const blocks = (rule: string, target: string) => new RegExp(`^${rule.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}`).test(target);
    for (const target of ['/zmanim/jerusalem?date=2027-04-22', '/he/zmanim/haifa?community=chabad', '/ru/zmanim/moscow?date=2027-06-11&community=ashkenazi']) assert(disallow.some((p) => blocks(p, target)), `${target} is open to crawlers`);
    for (const target of ['/zmanim', '/zmanim/jerusalem', '/he/zmanim', '/he/zmanim/jerusalem', '/ru/zmanim/moscow']) assert(!disallow.some((p) => blocks(p, target)), `${target} is kept out: ${show(disallow)}`);
    assert(r.sitemap === `${SITE}/sitemap.xml`, `the sitemap ${r.sitemap}`);
  });
```

- [ ] **Step 3: Run them red.**
  - `RUN scripts/smoke-site-chrome.ts`: expected `FAIL  H1 ... — en: no link to /zmanim in [...]`, `FAIL  H3 ... — en: no /zmanim in [...]`, `FAIL  H4 ... — en at open: the sheet has no /zmanim: [...]`, `FAIL  H5 ... — no rule .site-list-link` (the `.site-zm-*` rules exist since Tasks 6 and 7), `1/5 passed`.
  - `RUN scripts/smoke-site-landing.ts`: expected `FAIL  G13 ... — en: no zmanim row at the end of the list`, every other check OK.
  - `RUN scripts/smoke-site-seo.ts`: expected `FAIL  S2 ... — the URLs [...]` (no zmanim URL in the sitemap) and `FAIL  S3 ... — /zmanim/*? is not kept out`; S4 OK. S1 fails in the worktree with the estree-walker error, at the base commit too (Global Constraints): it is read in the controller's CI mirror, where it must pass (the keys are Task 6's and 7's, Contract note 24).
  - `RUN scripts/smoke-site-truth.ts`, `RUN scripts/smoke-site-layouts.ts`, `RUN scripts/smoke-site-pages.ts`: expected all OK (they widen coverage; a failure here is a real copy fault in Tasks 3, 6 or 7 to fix in their files), except smoke-site-pages' P2 and P5 in the worktree, for the estree-walker reason.

- [ ] **Step 4: Messages.** `site.nav` in each file, after its `"blog"` line (in en the line `      "blog": "Blog",`, unique in the file):
  - en: `"blog": "Blog",` -> `"blog": "Blog",` + new line `      "zmanim": "Zmanim",`
  - he: `"blog": "בלוג",` -> `"blog": "בלוג",` + new line `      "zmanim": "זמני היום",`
  - ru: `"blog": "Блог",` -> `"blog": "Блог",` + new line `      "zmanim": "Зманим",`

  `landing.features.jewish`, after its `"pause"` line, a new key `zmanimPages` (the row's link words):
  - en: `        "zmanimPages": "Zmanim and Shabbat times for cities in Israel and abroad, right here on the site, with no sign-up.",`
  - he: `        "zmanimPages": "זמני היום וזמני שבת לערים בישראל ובעולם, כאן באתר, בלי הרשמה.",`
  - ru: `        "zmanimPages": "Зманим и время Шаббата для городов Израиля и всего мира — прямо на сайте, без регистрации.",`

  (Each checked against T6 and the Hebrew neutral matcher with a throwaway run: all pass. The nav words follow the site's tone: one or two plain words, like "Blog" / "בלוג" / "Блог".)

- [ ] **Step 5: The header, the menu and the footer.**

`components/site/SiteHeader.tsx` lines 8-11 become:

```tsx
// The header of every public page (spec 2026-10-28-public-website §3.1): the logo; How it works, Plans, Blog and Zmanim
// (spec 2026-10-30-public-zmanim §6.3); the language switcher; and the two start buttons, compact and equal. On a phone
// the links and the switcher sit behind the menu button (SiteMenu), and one Start button jumps to the landing's start
// section. Every tap target is 44 px. The end of the row has room for a later "Sign in" (spec §3.1, item 6b); nothing
// is built for it.
```

lines 23-27 become:

```tsx
        <nav className="site-nav site-wide-only" aria-label={t('site.nav.label')}>
          <Link href={{ pathname: '/', hash: 'how' }}>{t('site.nav.howItWorks')}</Link>
          <Link href={{ pathname: '/', hash: 'plans' }}>{t('site.nav.plans')}</Link>
          <Link href="/blog">{t('site.nav.blog')}</Link>
          <Link href="/zmanim">{t('site.nav.zmanim')}</Link>
        </nav>
```

`components/site/SiteMenu.tsx` lines 10-13 become:

```tsx
// The phone's menu (spec 2026-10-28-public-website §3.1): a 44 px button that opens the app's own bottom sheet with the
// site's links (How it works, Plans, Blog, Zmanim) and the language switcher. The sheet is the kit's BottomSheet, so it
// behaves as every sheet in the app does: focus moves into it and back to this button, Tab stays inside, and Escape, a
// tap on the scrim and its Close button close it. A link closes it too (a link to a section of the same page would leave
// it open over the page).
```

lines 40-45 become:

```tsx
              <li>
                <Link href="/blog" onClick={close}>
                  {t('nav.blog')}
                </Link>
              </li>
              <li>
                <Link href="/zmanim" onClick={close}>
                  {t('nav.zmanim')}
                </Link>
              </li>
            </ul>
```

`components/site/SiteFooter.tsx` lines 6-9 become:

```tsx
// The footer of every public page (spec 2026-10-28-public-website §3.4): How it works, Plans, Blog, Zmanim (spec
// 2026-10-30-public-zmanim §6.3), Privacy, Terms, Cancel a payment (the Terms' cancellation part, Consumer Protection
// Law s.14I) and Contact (the bot's feedback chat), the language switcher, "Made in Israel" and the years. The years
// stay left to right in Hebrew (<bdi dir="ltr">).
```

lines 28-30 become:

```tsx
            <li>
              <Link href="/blog">{t('site.nav.blog')}</Link>
            </li>
            <li>
              <Link href="/zmanim">{t('site.nav.zmanim')}</Link>
            </li>
```

- [ ] **Step 6: The landing row.** `components/site/LandingSections.tsx`: in the lucide import (lines 2-27) add `MapPin,` between `Link2,` and `Mic,`. Replace lines 155-166:

```tsx
              <ul className="site-list">
                {items.map((item) => (
                  <li key={item.key} className="site-list-row">
                    {icon(item.icon, 'site-icon site-list-icon')}
                    <span>
                      {t(`landing.features.${group}.${item.key}`)}
                      {item.telegram ? <> {tag}</> : null}
                      {planTag(item.plan) ? <> {planTag(item.plan)}</> : null}
                    </span>
                  </li>
                ))}
              </ul>
```

with:

```tsx
              <ul className="site-list">
                {items.map((item) => (
                  <li key={item.key} className="site-list-row">
                    {icon(item.icon, 'site-icon site-list-icon')}
                    <span>
                      {t(`landing.features.${group}.${item.key}`)}
                      {item.telegram ? <> {tag}</> : null}
                      {planTag(item.plan) ? <> {planTag(item.plan)}</> : null}
                    </span>
                  </li>
                ))}
                {/* The public zmanim pages (spec 2026-10-30-public-zmanim §2.13): the list's last row, so the Settings line still follows the list (G11) */}
                {group === 'jewish' ? (
                  <li className="site-list-row site-list-row-link">
                    {icon(MapPin, 'site-icon site-list-icon')}
                    <Link href="/zmanim" className="site-list-link">
                      {t('landing.features.jewish.zmanimPages')}
                    </Link>
                  </li>
                ) : null}
              </ul>
```

`src/site/site-css.ts`, in LANDING_CSS right after the `.site-list-icon` rule (before the `/* What a group needs in Settings` comment) add:

```css
/* The Jewish calendar group's last row: a link to the public zmanim pages, the whole row tall */
.site-list-row-link {
  align-items: center;
  padding-block: 0;
}
.site-list-link {
  display: inline-flex;
  align-items: center;
  min-block-size: 48px;
  padding-block: 8px;
  color: var(--ch-accent);
  font-weight: 600;
  text-decoration: underline;
  text-underline-offset: 3px;
}
```

(Accent text on `--ch-section` is one of the pairs G7 already holds to 4.5:1 in both themes; no "hover" anywhere, so G7's grep stays clean.)

- [ ] **Step 7: Sitemap, robots, the content date.** `app/sitemap.ts` becomes:

```ts
import type { MetadataRoute } from 'next';
import { routing } from '@/i18n/routing';
import { getAllSlugs } from '@/src/lib/blog';
import { CITIES } from '@/src/site/cities';
import { SITE_CONTENT_UPDATED } from '@/src/site/config';
import { LEGAL_UPDATED } from '@/src/site/legal';
import { languageAlternates, pageUrl } from '@/src/site/seo';

// The public site's sitemap (spec 2026-10-28-public-website §6.4): every indexed page in every language, at the URL it
// is served at (English unprefixed, never a redirect), each with its other languages and x-default, and the day its
// content last changed (never "now"). The share page is noindex and the Mini App is private: neither is listed.
// The zmanim pages (spec 2026-10-30-public-zmanim §4.3) are the index and every city of src/site/cities.ts, at their
// clean URLs only (robots.txt keeps out a day or a community in the query). Their times change daily, their content
// with the site's, so they carry SITE_CONTENT_UPDATED.

export default function sitemap(): MetadataRoute.Sitemap {
  const pages: { path: string; lastModified: string; changeFrequency: 'daily' | 'weekly' | 'monthly' | 'yearly'; priority: number }[] = [
    { path: '/', lastModified: SITE_CONTENT_UPDATED, changeFrequency: 'weekly', priority: 1 },
    { path: '/blog', lastModified: SITE_CONTENT_UPDATED, changeFrequency: 'monthly', priority: 0.7 },
    ...getAllSlugs().map((slug) => ({ path: `/blog/${slug}`, lastModified: SITE_CONTENT_UPDATED, changeFrequency: 'monthly' as const, priority: 0.7 })),
    { path: '/zmanim', lastModified: SITE_CONTENT_UPDATED, changeFrequency: 'monthly', priority: 0.8 },
    ...CITIES.map((city) => ({ path: `/zmanim/${city.slug}`, lastModified: SITE_CONTENT_UPDATED, changeFrequency: 'daily' as const, priority: 0.6 })),
    { path: '/privacy', lastModified: LEGAL_UPDATED.privacy, changeFrequency: 'yearly', priority: 0.3 },
    { path: '/terms', lastModified: LEGAL_UPDATED.terms, changeFrequency: 'yearly', priority: 0.3 },
  ];
  return pages.flatMap((page) =>
    routing.locales.map((locale) => ({
      url: pageUrl(locale, page.path),
      lastModified: page.lastModified,
      changeFrequency: page.changeFrequency,
      priority: page.priority,
      alternates: { languages: languageAlternates(page.path) },
    })),
  );
}
```

`app/robots.ts` becomes:

```ts
import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/src/site/config';

// Search engines read the public site and nothing behind it: not the API, and not the Google connect pages. The Mini
// App's pages say noindex themselves (app/[locale]/(app)/layout.tsx). A zmanim city page with a day or a community in
// its query is kept out in every language (spec 2026-10-30-public-zmanim §4.3): a calendar is an endless set of URLs,
// and each such page names its clean URL as canonical.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: ['/api/', '/oauth-callback', '/oauth-complete', '/refresh-token', '/zmanim/*?', '/he/zmanim/*?', '/ru/zmanim/*?'],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
```

`src/site/config.ts` line 9: set `SITE_CONTENT_UPDATED` to the day this task is committed, as `TZ=Asia/Jerusalem date +%F` prints it (for a commit on 2026-10-30: `export const SITE_CONTENT_UPDATED = '2026-10-30';`). The constant dates the landing and blog sitemap entries too; that is right, since the landing gains its row and every page's header and footer gain a link.

- [ ] **Step 8: Run green.** `RUN scripts/smoke-site-chrome.ts` (`5/5 passed`), `RUN scripts/smoke-site-landing.ts` (all pass, G13 included), `RUN scripts/smoke-site-seo.ts` (S2, S3 and S4 pass in the worktree; S1, and so `4/4 passed`, in the controller's CI mirror), `RUN scripts/smoke-site-layouts.ts`, `RUN scripts/smoke-site-pages.ts` (all but P2 and P5 in the worktree, as above), `RUN scripts/smoke-site-truth.ts`, `RUN scripts/smoke-auth-leftovers.ts` (its #1 reads robots' disallow list), `RUN scripts/smoke-he-neutral.ts`, `RUN scripts/smoke-ru-formal.ts`: all pass. Then in the worktree `npx tsc --noEmit && npx eslint components/site app/sitemap.ts app/robots.ts src/site scripts/smoke-site-*.ts scripts/smoke-zmanim-sheet.ts`: no output. Then `cd /Users/razielgershoni/development/famcalbot && npx prisma generate`.

- [ ] **Step 9: The whole set.** `cd /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/zp-wt && bash scripts/ci-smokes.sh`: expected every smoke file to pass except smoke-site-seo and smoke-site-pages (the worktree caveat in Global Constraints); the controller's CI mirror runs the full set before the push. Then `cd /Users/razielgershoni/development/famcalbot && npx prisma generate`.

- [ ] **Step 10: Commit.**

```bash
cd /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/zp-wt
git add messages/en.json messages/he.json messages/ru.json components/site/SiteHeader.tsx components/site/SiteMenu.tsx components/site/SiteFooter.tsx components/site/LandingSections.tsx src/site/site-css.ts src/site/config.ts app/sitemap.ts app/robots.ts scripts/smoke-site-chrome.ts scripts/smoke-site-landing.ts scripts/smoke-site-layouts.ts scripts/smoke-site-seo.ts scripts/smoke-site-pages.ts scripts/smoke-site-truth.ts
git commit -F - <<'EOF'
feat(site): a Zmanim link in the header, menu and footer; the landing row; the sitemap and robots for the city pages

The header, the phone menu (the link closes the sheet) and the footer link to
/zmanim, and the Jewish calendar group's list ends with a row to it. The
sitemap lists the index and every city in each language; robots keeps out the
city pages with a day or a community in the query. The truth smoke now walks
zmanimSite, cities and countries, and the raw-key check knows their names.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
EOF
```

- [ ] **Step 11: Header width at 960 px (the controller, after this task's commit).** The spec's check that the header still fits on one row at 960 px in all three languages (§6.3, §10) runs on the built site in a headless browser, not in the worktree (its symlinked node_modules can't build the MDX pages):
  1. In the controller's CI-mirror fresh clone of the branch (its own `npm ci`, no `.env` file, so nothing real is reachable), after its `npx next build`, start the built site with the fake env (the site pages read no database; the scheduler's errors against the fake database are expected and touch nothing real):
     ```bash
     env TZ=Asia/Jerusalem DATABASE_URL=postgresql://fake:fake@127.0.0.1:1/fake DIRECT_URL=postgresql://fake:fake@127.0.0.1:1/fake TELEGRAM_BOT_TOKEN=000000:fake WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 ENCRYPTION_KEY_PREVIOUS= NODE_ENV=development 'GOOGLE_TTS_CREDENTIALS={}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx next start -p 3100
     ```
  2. With the server up, screenshot each page's header in headless Chrome at 960 px and at 1100 px:
     ```bash
     CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
     OUT=/private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/6a/header-shots
     mkdir -p "$OUT"
     for w in 960 1100; do for p in zmanim he/zmanim ru/zmanim zmanim/jerusalem; do
       "$CHROME" --headless=new --disable-gpu --hide-scrollbars --window-size=$w,240 --screenshot="$OUT/$w-${p//\//-}.png" "http://localhost:3100/$p"
     done; done
     ```
     Read each image: the logo, the four links (How it works, Plans, Blog, Zmanim), the language switcher and the two compact buttons sit on one row; nothing wraps, overlaps or is cut off.
  3. If a header doesn't fit, add the fallback below to CHROME_CSS in `src/site/site-css.ts` in the worktree, after the `.site-nav a` rule, run `RUN scripts/smoke-site-chrome.ts` and `RUN scripts/smoke-site-landing.ts` there, commit it (`fix(site): the header's four links fit at 960 px`, with the trailer), pull it into the CI-mirror clone, rebuild and screenshot again. If it still doesn't fit, stop and ask the owner for a shorter label (spec §10).
     ```css
     @media (min-width: 960px) and (max-width: 1099.98px) {
       .site-nav a {
         padding-inline: 8px;
       }
     }
     ```
  4. Stop the server and delete the screenshots folder.

  If no headless browser is available on the controller's machine, the controller does the same check on the deployed site right after the push (famcal.bot `/zmanim`, `/he/zmanim` and `/ru/zmanim` at a 960 px wide window) and reports what it saw to the owner.

---

### Task 9: Request limit in the proxy

Facts this task rests on (read in node_modules/next 16.1.1): the proxy always runs on the Node.js runtime ("Proxy always runs on Node.js runtime", next/dist/build/analysis/get-page-static-info.js:552; the local build's functions-config-manifest.json has `/_middleware` with `runtime: 'nodejs'`), and next-server loads it with a plain `require` of `.next/server/middleware.js` into the server process (next/dist/server/next-server.js:1105-1112, called at :1222), not a sandbox, so state on globalThis lives as long as the process. famcal.bot answers from Railway's edge directly (`server: railway-hikari`, `x-railway-edge`, an A record on Railway, no Cloudflare proxy, checked 2026-10-30), so `x-real-ip` is the visitor's address.

**Files:**
- Create: `src/lib/page-limit.ts`
- Modify: `proxy.ts` (the whole file, 8 lines)
- Test: `scripts/smoke-zmanim-limit.ts` (new)

**Interfaces:**
- Consumes: `routing` (`i18n/routing.ts`), `createMiddleware` (next-intl), `NextResponse` / `NextRequest` (next/server).
- Produces: `CITY_PAGE_LIMIT`, `CITY_PAGE_WINDOW_MS`, `type CityPageRequest`, `type CityPageVerdict`, `type CityPageLimitState`, `cityPageVerdict(request, now, state?)` (Contract note 27); the proxy's 429 with `Retry-After` and `Cache-Control: no-store`; the log line `[zmanim-limit] refused N requests in the minute from <ISO>`; process state on `globalThis.__zmanimPageLimit`.

- [ ] **Step 1: Write the smoke `scripts/smoke-zmanim-limit.ts`** (run green against this task's code in a throwaway copy of the tree, 2026-10-30):

```ts
// Smoke test for the zmanim city pages' request limit (spec 2026-10-30-public-zmanim §6.4; plan Task 9):
//
//  - Z1 the count: 60 city pages a minute from one address pass and the 61st gets Retry-After until the minute ends;
//    another address and any other page are not touched; the next minute starts over; requests with no address are
//    counted under one key.
//  - Z2 the paths it counts: a city page in en, he and ru (with or without a trailing slash); never the index, another
//    page, the /en address next-intl redirects, or a deeper path.
//  - Z3 the log: a minute with refusals is one line at the first request after it, with the count and the minute, and
//    never the address; a minute with none logs nothing.
//  - Z4 the proxy: the 61st city page from one address is a 429 with Retry-After and no-store, empty, before next-intl;
//    a router prefetch (next-router-prefetch: 1) counts like any other request; the same address still gets the blog,
//    another address still gets the city, and the count is on globalThis.
//
// Pure code and the real proxy (next-intl's middleware over i18n/routing.ts). No network, no DB.
//
// Run with the fake env (never the real one), from the repo root, as ci-smokes.sh does.

import { assert, check, finish, load, show, type Row } from './lib/site-harness';

const ADDRESS = '203.0.113.7';
const OTHER = '198.51.100.20';
// 12:00:20 UTC: 40 seconds are left in its minute
const T0 = Date.UTC(2026, 10, 6, 12, 0, 20);

async function main() {
  const { cityPageVerdict, CITY_PAGE_LIMIT, CITY_PAGE_WINDOW_MS } = await load('src/lib/page-limit.ts');
  const fresh = () => ({ window: -1, counts: new Map<string, number>(), refused: 0 });
  const city = (address: string | null, path = '/zmanim/jerusalem') => ({ path, address });
  /** Runs `fn` with console.warn caught, and gives back what it returned and the lines it logged. */
  const quiet = <T>(fn: () => T): { value: T; lines: string[] } => {
    const lines: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      return { value: fn(), lines };
    } finally {
      console.warn = warn;
    }
  };

  await check('Z1 the count: 60 city pages a minute from one address, the 61st refused with Retry-After to the minute\'s end; other addresses and other pages untouched; the next minute starts over; no address is one key', () => {
    assert(CITY_PAGE_LIMIT === 60 && CITY_PAGE_WINDOW_MS === 60_000, `the limit ${CITY_PAGE_LIMIT} per ${CITY_PAGE_WINDOW_MS} ms`);
    const state = fresh();
    quiet(() => {
      for (let i = 1; i <= 60; i++) assert(cityPageVerdict(city(ADDRESS), T0 + i, state).ok, `request ${i} refused`);
      const refused = cityPageVerdict(city(ADDRESS), T0 + 100, state);
      assert(!refused.ok && refused.retryAfterS === 40, `the 61st: ${show(refused)}`);
      assert(cityPageVerdict(city(OTHER), T0 + 101, state).ok, 'another address refused');
      for (const path of ['/blog', '/zmanim', '/he', '/privacy']) assert(cityPageVerdict(city(ADDRESS, path), T0 + 102, state).ok, `${path} refused`);
      assert(!cityPageVerdict(city(ADDRESS, '/ru/zmanim/haifa'), T0 + 104, state).ok, 'another city in Russian passed: the count is per address, not per page');
      const late = cityPageVerdict(city(ADDRESS), T0 + 39_600, state);
      assert(!late.ok && late.retryAfterS === 1, `0.4 s before the minute ends: ${show(late)}`);
      assert(cityPageVerdict(city(ADDRESS), T0 + 40_000, state).ok, 'the next minute did not start over');
      for (let i = 1; i <= 60; i++) assert(cityPageVerdict(city(null), T0 + 40_000 + i, state).ok, `no address, request ${i} refused`);
      assert(!cityPageVerdict(city(null), T0 + 40_100, state).ok, 'requests with no address are not counted together');
    });
  });

  await check('Z2 the paths: a city page in en, he and ru (a trailing slash too) is counted; the index, other pages, /en (a redirect) and deeper paths are not', () => {
    const counted = (path: string) => {
      const state = fresh();
      return quiet(() => {
        for (let i = 0; i < CITY_PAGE_LIMIT; i++) cityPageVerdict(city(ADDRESS, path), T0, state);
        return !cityPageVerdict(city(ADDRESS, path), T0, state).ok;
      }).value;
    };
    for (const path of ['/zmanim/jerusalem', '/he/zmanim/jerusalem', '/ru/zmanim/new-york', '/zmanim/beer-sheva/', '/zmanim/no-such-city']) assert(counted(path), `${path} is not counted`);
    for (const path of ['/zmanim', '/he/zmanim', '/ru/zmanim/', '/', '/blog/why-i-built-famcal', '/en/zmanim/jerusalem', '/zmanim/jerusalem/extra', '/zmanimx/jerusalem', '/dashboard']) assert(!counted(path), `${path} is counted`);
  });

  await check('Z3 the log: one line per minute with refusals, at the first request after it, with the count and the minute and no address; nothing for a minute without', () => {
    const state = fresh();
    const first = quiet(() => {
      for (let i = 0; i < 65; i++) cityPageVerdict(city(ADDRESS), T0 + i, state);
      for (let i = 0; i < 62; i++) cityPageVerdict(city(OTHER), T0 + 100 + i, state);
    });
    assert(first.lines.length === 0, `logged inside the minute: ${show(first.lines)}`);
    const next = quiet(() => {
      cityPageVerdict(city(OTHER, '/blog'), T0 + 50_000, state);
      cityPageVerdict(city(OTHER, '/blog'), T0 + 50_001, state);
    });
    assert(show(next.lines) === show(['[zmanim-limit] refused 7 requests in the minute from 2026-11-06T12:00:00.000Z']), `the log ${show(next.lines)}`);
    assert(!next.lines.some((line) => line.includes(ADDRESS) || line.includes(OTHER)), 'an address in the log');
    const calm = quiet(() => cityPageVerdict(city(ADDRESS), T0 + 120_000, state));
    assert(calm.lines.length === 0, `a minute with no refusal logged ${show(calm.lines)}`);
  });

  await check('Z4 the proxy: the 61st city page from one address is a 429 with Retry-After and no-store, empty, before next-intl; a router prefetch counts like any other request; the same address still gets the blog, another address still gets the city; the count is on globalThis', async () => {
    delete (globalThis as Row).__zmanimPageLimit;
    const { default: proxy, config } = await load('proxy.ts');
    const { NextRequest } = await import('next/server');
    const get = (path: string, address: string, headers: Record<string, string> = {}) =>
      proxy(new NextRequest(`https://famcal.bot${path}`, { headers: { 'x-real-ip': address, ...headers } })) as Promise<Response>;
    assert(show(config.matcher) === show(['/((?!api|_next|_vercel|refresh-token|oauth-callback|oauth-complete|.*\\..*).*)']), `the matcher ${show(config.matcher)}`);
    // The proxy reads the clock: held still, so the 61 requests fall in one minute however long they take
    const realNow = Date.now;
    Date.now = () => T0;
    try {
      for (let i = 1; i <= 59; i++) {
        const res = await get(i % 2 ? '/zmanim/jerusalem' : '/he/zmanim/haifa', ADDRESS);
        assert(res.status !== 429, `request ${i}: ${res.status}`);
      }
      // A router prefetch counts like any other request (a header is the client's to set): the 60th passes, the 61st is refused
      const prefetch = await get('/zmanim/eilat', ADDRESS, { 'next-router-prefetch': '1' });
      assert(prefetch.status !== 429, `the 60th, a prefetch: ${prefetch.status}`);
      const overPrefetch = await get('/zmanim/eilat', ADDRESS, { 'next-router-prefetch': '1', rsc: '1' });
      assert(overPrefetch.status === 429, `the 61st, a prefetch, was not counted: ${overPrefetch.status}`);
      const refused = await get('/zmanim/jerusalem', ADDRESS);
      assert(refused.status === 429 && refused.headers.get('retry-after') === '40', `the 62nd: ${refused.status}, Retry-After ${refused.headers.get('retry-after')}`);
      assert(refused.headers.get('cache-control') === 'no-store' && (await refused.text()) === '', 'the 429 is cached or has a body');
      assert(refused.headers.get('x-middleware-rewrite') === null, 'next-intl ran on a refused request');
      const blog = await get('/blog', ADDRESS);
      assert(blog.status === 200 && blog.headers.get('x-middleware-rewrite') === 'https://famcal.bot/en/blog', `the blog for a limited address: ${blog.status}`);
      const other = await get('/zmanim/jerusalem', OTHER);
      assert(other.status === 200 && other.headers.get('x-middleware-rewrite') === 'https://famcal.bot/en/zmanim/jerusalem', `another address: ${other.status}`);
    } finally {
      Date.now = realNow;
    }
    const state = (globalThis as Row).__zmanimPageLimit;
    assert(state && state.counts.get(ADDRESS) === 62 && state.counts.get(OTHER) === 1, `the shared count ${show(state && [...state.counts])}`);
  });

  finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Run it red.** `RUN scripts/smoke-zmanim-limit.ts`. Expected: it exits 1 before any check with `Error: Cannot find module '<WT>/src/lib/page-limit.ts'` (code `ERR_MODULE_NOT_FOUND`).

- [ ] **Step 3: Create `src/lib/page-limit.ts`.**

```ts
// The zmanim city pages' request limit (spec 2026-10-30-public-zmanim §6.4). The pages are rendered on each request in
// the one Railway process the bot's webhooks and cron run in, so one client address gets CITY_PAGE_LIMIT city pages a
// minute; past that the proxy answers 429 with Retry-After until the minute ends. No person reading pages comes near it.
//
// - The address is the x-real-ip header Railway's edge sets (famcal.bot is behind no proxy that sets another one).
// - The count lives in this process's memory, on globalThis (Next 16 gives the proxy and the routes separate module
//   instances, src/lib/timezone.ts), in fixed one-minute windows: it holds one minute of addresses at most, and a
//   restart starts it over.
// - Every city-page request counts, a router prefetch (next-router-prefetch: 1) too: a header is the client's to set, so
//   none buys a render past the limit. The zmanim pages link city pages with plain <a href>, which is never prefetched.
// - Nothing about the visitor is logged: a minute with refusals is logged as a count, once, at the first request after
//   it, with the minute it was.
// Pure: no import.

/** City pages one address may open in a minute. */
export const CITY_PAGE_LIMIT = 60;
export const CITY_PAGE_WINDOW_MS = 60 * 1000;

/** A city page in any language, as the proxy sees the path: /zmanim/<slug>, /he/zmanim/<slug>, /ru/zmanim/<slug>. */
const CITY_PAGE = /^\/(?:he\/|ru\/)?zmanim\/[^/]+\/?$/;

export type CityPageLimitState = { window: number; counts: Map<string, number>; refused: number };
export type CityPageRequest = { path: string; address: string | null };
export type CityPageVerdict = { ok: true } | { ok: false; retryAfterS: number };

/** The process's count, read on each call (a smoke starts it over by deleting globalThis.__zmanimPageLimit). */
function sharedState(): CityPageLimitState {
  const shared = globalThis as { __zmanimPageLimit?: CityPageLimitState };
  return (shared.__zmanimPageLimit ??= { window: -1, counts: new Map(), refused: 0 });
}

/**
 * Counts one page request (every request the proxy sees, so a new minute starts on time) and says whether it may go on:
 * any page but a city page always may; a city page (a prefetch of one too) may while its address has opened at most
 * CITY_PAGE_LIMIT of them this minute. `now` is epoch milliseconds.
 */
export function cityPageVerdict(request: CityPageRequest, now: number, state: CityPageLimitState = sharedState()): CityPageVerdict {
  const window = Math.floor(now / CITY_PAGE_WINDOW_MS);
  if (window !== state.window) {
    if (state.refused > 0) {
      console.warn(`[zmanim-limit] refused ${state.refused} requests in the minute from ${new Date(state.window * CITY_PAGE_WINDOW_MS).toISOString()}`);
    }
    state.window = window;
    state.counts.clear();
    state.refused = 0;
  }
  if (!CITY_PAGE.test(request.path)) return { ok: true };
  const key = request.address ?? 'none';
  const count = (state.counts.get(key) ?? 0) + 1;
  state.counts.set(key, count);
  if (count <= CITY_PAGE_LIMIT) return { ok: true };
  state.refused += 1;
  return { ok: false, retryAfterS: Math.max(1, Math.ceil(((window + 1) * CITY_PAGE_WINDOW_MS - now) / 1000)) };
}
```

- [ ] **Step 4: Run it, still red on the proxy.** `RUN scripts/smoke-zmanim-limit.ts`. Expected: `OK` for Z1, Z2, Z3 and `FAIL  Z4 ... — the 61st, a prefetch, was not counted: 200`, `3/4 passed`.

- [ ] **Step 5: The proxy.** `proxy.ts` becomes:

```ts
import createMiddleware from 'next-intl/middleware';
import { NextResponse, type NextRequest } from 'next/server';
import { routing } from './i18n/routing';
import { cityPageVerdict } from './src/lib/page-limit';

// Every page request passes here: first the zmanim city pages' request limit (src/lib/page-limit.ts: 60 city pages a
// minute from one address, then 429 with Retry-After until the minute ends), then next-intl's locale handling.

const intl = createMiddleware(routing);

export default function proxy(request: NextRequest) {
  const verdict = cityPageVerdict(
    {
      path: request.nextUrl.pathname,
      address: request.headers.get('x-real-ip'),
    },
    Date.now(),
  );
  if (!verdict.ok) {
    return new NextResponse(null, { status: 429, headers: { 'Retry-After': String(verdict.retryAfterS), 'Cache-Control': 'no-store' } });
  }
  return intl(request);
}

export const config = {
  matcher: ['/((?!api|_next|_vercel|refresh-token|oauth-callback|oauth-complete|.*\\..*).*)',],
};
```

(The 429 has no body: no person meets it, and a body would be copy outside messages. The matcher is unchanged; smoke-auth-leftovers #2 pins it.)

- [ ] **Step 6: Run green.** `RUN scripts/smoke-zmanim-limit.ts` (expected `4/4 passed`), `RUN scripts/smoke-auth-leftovers.ts` (loads `proxy.ts`'s config), `RUN scripts/smoke-dead-columns.ts` (scans `proxy.ts`), `RUN scripts/smoke-dst.ts` (walks `src/`: the module sets no local Date field), `RUN scripts/smoke-pause.ts` (walks `src/` for senders; the module sends nothing): all pass. Then in the worktree `npx tsc --noEmit && npx eslint proxy.ts src/lib/page-limit.ts scripts/smoke-zmanim-limit.ts`: no output. Then `cd /Users/razielgershoni/development/famcalbot && npx prisma generate`.

- [ ] **Step 7: Commit.**

```bash
cd /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/zp-wt
git add src/lib/page-limit.ts proxy.ts scripts/smoke-zmanim-limit.ts
git commit -F - <<'EOF'
feat(site): a per-address limit on the zmanim city pages in the proxy

60 city pages a minute from one x-real-ip, then 429 with Retry-After until the
minute ends, counted in process memory on globalThis. Other pages are not
counted; a router prefetch of a city page counts like any request. A minute
with refusals is logged as a count, never with the address.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
EOF
```

- [ ] **Step 8: After the push (the controller, read-only on the live site).** Once Railway serves the new build, confirm the address is the visitor's and can't be forged: (1) `for i in $(seq 1 61); do curl -s -o /dev/null -w '%{http_code}\n' https://famcal.bot/zmanim/jerusalem; done | sort | uniq -c` should print `60 200` and `1 429`; (2) within the same minute, `curl -s -o /dev/null -w '%{http_code}\n' -H 'X-Real-IP: 192.0.2.55' https://famcal.bot/zmanim/haifa` should print `429` (Railway's edge overwrites a forged header). If (2) prints `200`, the header is forgeable: report it to the owner before anything else (the fix is to key on the address Railway's edge appends, which needs Railway's documentation checked first). 62 GETs of a public page write nothing.

---

### Task 10: Legal additions and docs

**Files:**
- Modify: `messages/en.json`, `messages/he.json`, `messages/ru.json`: `legal.terms.sections.eligibility.blocks[0]`, `legal.terms.sections.ai.blocks[3]`, `legal.privacy.sections.keep.blocks[19][1]`, `legal.privacy.sections.notKeep.blocks[0][3]` (each an existing string, changed in place; no block is added, so P3's shapes hold)
- Modify: `src/site/legal.ts` (line 6 `LEGAL_UPDATED`)
- Test: `scripts/smoke-site-pages.ts` (header comment lines 1-24, new P7 after P6)
- Modify: `CLAUDE.md` (line 8), `README.md` (after line 36; line 57), `docs/superpowers/specs/2026-10-28-public-website-design.md` (line 45, line 103, line 249)

**Interfaces:**
- Consumes: the zmanim pages' words "zmanim pages" (Task 6/7 pages exist at `/zmanim`); `restDayBlocks`, `zmanDayForPlace`, `ZmanOptions` (Task 1) and `inIsrael` for the CLAUDE.md sentence; `scripts/build-city-heights.ts` (Task 3) for the README.
- Produces: the four legal additions in en/he/ru; `LEGAL_UPDATED` = the ship day for privacy and terms; the docs.

Smokes that pin the legal texts' shape or words, and what this task does to each (none needs a change; P7 is new):
- `smoke-site-pages` P3: section ids (`PRIVACY_SECTIONS`, `TERMS_SECTIONS`), the same block shapes in he and ru as in en, the seller arguments per string as in en, no raw mark, "Privacy Policy" linked exactly twice in the Terms, Hebrew `הגדרת ״זמנים״` exactly 4 times and no `שיטה`/`שיטת` in he legal, the date line from `LEGAL_UPDATED`. The changes edit four strings in place, add no link, no argument, no `שיטה` and keep the one `הגדרת ״זמנים״` already in `ai.blocks[3]`.
- `smoke-site-truth` T1 (UNTRUE patterns; OFF_SITE is skipped for legal), T2 (no emoji), T5 (i18n parity: same keys), T6 (Russian no-break spaces): the new Russian sentences were run through the T6 regex and pass.
- `smoke-he-neutral` and `smoke-ru-formal` (every message): the new Hebrew and Russian sentences were run through the Hebrew matcher and are formal "вы".
- `smoke-google-connect` #42 S2 and `smoke-google-disconnect-ui` (privacy sentences about Google; `LEGAL_UPDATED.privacy >= '2026-10-01'`), `smoke-location-check` (the OpenStreetMap processor line), `smoke-terms-plans` (the plans section): untouched sections.
- `smoke-site-seo` S2: the sitemap's Privacy and Terms dates are `LEGAL_UPDATED`'s, whatever they are.

- [ ] **Step 1: Lawyer-agent check (the controller dispatches it, as for the last legal update).** One Opus agent, high effort, read-only, with this prompt:

```
You are checking four short additions to FamCal's Privacy Policy and Terms (famcal.bot), in English, Hebrew and Russian, before they ship. FamCal is a family-calendar Telegram/WhatsApp bot run by an individual in Israel, selling monthly plans via Telegram Stars; the site now adds public zmanim (halachic times) pages per city that anyone can read without an account. The pages keep no cookie or storage, call no third party, and "Near me" computes the nearest listed city in the browser (the position never leaves the device; only the city's page is then requested). City data are committed files (GeoNames CC BY 4.0, OpenStreetMap outlines, Copernicus DEM heights), not services.

Read the current texts: /Users/razielgershoni/development/famcalbot/messages/{en,he,ru}.json, keys legal.terms.sections.eligibility, legal.terms.sections.ai, legal.privacy.sections.keep (blocks[18] and [19]), legal.privacy.sections.notKeep, legal.privacy.sections.cookies, legal.privacy.sections.processors. The spec is /Users/razielgershoni/development/famcalbot/docs/superpowers/specs/2026-10-30-public-zmanim-design.md §7. Background on Israeli consumer-law points: /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/seller-details-answer.md.

The four changed strings (the new sentences are the additions):
1. Terms, who can use FamCal (legal.terms.sections.eligibility.blocks[0], the whole string; "To use the bots or the web app," and the last sentence are new):
   en: To use the bots or the web app, you must be 18 or older, and you need your own Telegram or WhatsApp account. A partner you link with needs their own account, and must be 18 or older too. Anyone may use famcal.bot’s public pages, such as the zmanim pages, without an account.
   he: כדי להשתמש בבוטים או באפליקציית הרשת צריך להיות בגיל 18 ומעלה, ולהחזיק חשבון טלגרם או וואטסאפ משלכם. גם בן או בת הזוג שאתם מקושרים אליהם צריכים חשבון משלהם, וגם הם צריכים להיות בגיל 18 ומעלה. הדפים הציבוריים של famcal.bot, כמו דפי זמני היום, פתוחים לכולם, גם בלי חשבון.
   ru: Чтобы пользоваться ботами или веб-приложением, вам должно быть не меньше 18 лет, и у вас должен быть собственный аккаунт Telegram или WhatsApp. Партнёру, с которым вы связываете аккаунт, нужен свой аккаунт, и ему тоже должно быть не меньше 18 лет. Публичными страницами famcal.bot, например страницами зманим, может пользоваться любой, и аккаунт для этого не нужен.
2. Terms, the halachic clause (legal.terms.sections.ai.blocks[3], from the sentence before the new one to the end of the string; the middle sentence is new):
   en: They can be off, for example when your place is set wrong. On famcal.bot’s zmanim pages, they are computed for the centre of each city, so they can differ from the times where you are. **For a halachic time that matters, check a reliable source.**
   he: הם עלולים לסטות, למשל כשהמקום מוגדר לא נכון. בדפי זמני היום ב־famcal.bot הם מחושבים למרכז של כל עיר, ולכן הם עלולים להיות שונים מהזמנים במקום שבו אתם נמצאים. **זמן הלכתי שחשוב לכם, בדקו מול מקור אמין.**
   ru: Они могут быть неточными, например если место указано неверно. На страницах зманим на famcal.bot они рассчитываются для центра каждого города, поэтому могут отличаться от времени там, где вы находитесь. **Важное галахическое время проверяйте по надёжному источнику.**
3. Privacy, server logs (legal.privacy.sections.keep.blocks[19][1], the whole string; the last two sentences are new):
   en: When you open famcal.bot or the web app, our host receives your request, with your IP address and browser, as any website does. The request includes the page’s address: on the zmanim pages, that is the city, and any day or custom you pick there. Visiting the site creates no account or profile.
   he: כשפותחים את famcal.bot או את אפליקציית הרשת, ספק האחסון שלנו מקבל את הבקשה, עם כתובת ה־IP והדפדפן שלכם, כמו בכל אתר. הבקשה כוללת את כתובת הדף: בדפי זמני היום זו העיר, וגם היום או המנהג שבחרתם שם. ביקור באתר לא יוצר חשבון או פרופיל.
   ru: Когда вы открываете famcal.bot или веб-приложение, наш хостинг получает ваш запрос с вашим IP-адресом и данными о браузере, как и любой сайт. В запросе есть адрес страницы: на страницах зманим это город, а также день или обычай, если вы их выбрали. Посещение сайта не создаёт ни аккаунта, ни профиля.
4. Privacy, your device's location (legal.privacy.sections.notKeep.blocks[0][3], from the sentence before the new one to the end of the string; the last sentence is new):
   en: We keep only the place name. On the zmanim pages, the city nearest you is found on your device, and your device’s position isn’t sent to us.
   he: אנחנו שומרים רק את שם המקום. בדפי זמני היום, העיר הקרובה אליכם מחושבת במכשיר שלכם, והמיקום של המכשיר לא נשלח אלינו.
   ru: Мы храним только название места. На страницах зманим ближайший к вам город определяется на вашем устройстве, и координаты устройства нам не отправляются.

Check, and answer in at most 400 words, a numbered list of findings each with: the exact string, the problem, the exact replacement in all three languages (or "none"):
1. Accuracy: is each sentence true for what the pages do (above)? Nothing promised that the code doesn't do; nothing done that isn't said (an IP address with a page URL and query reaches the host's logs; logs are deleted after 90 days).
2. Israel's Privacy Protection Law (with Amendment 13, in force 14 August 2025: the duty to inform at collection) and GDPR Art. 13 for EU/UK visitors: does the policy, with these additions, tell a visitor of the public pages what is collected (IP and page address in the host's logs), why, by whom and for how long? Is anything missing that the rest of the policy doesn't already say?
3. The Terms: is "the age and account rules apply to the bots and the web app; anyone may use the public pages" consistent with the rest of the Terms (who they bind, minors reading public pages, the halachic disclaimer), and does the halachic clause now cover a city page's times (computed for the city's centre)?
4. Consumer Protection Law: the city pages show the two start buttons but no price or buy button; does anything in these additions turn the site into a marketing page that needs the seller's ID number (the owner keeps it off the website)?
5. The Hebrew and Russian say the same as the English, read as natively written, Hebrew gender-neutral (plural "you", no masculine singular), Russian formal "вы" with a no-break space after one-letter words.
Do not rewrite anything beyond the four strings. No legal advice disclaimers; this is a check.
```

  Apply every valid finding to the strings of Step 4 (in all three languages at once), and to Step 2's P7 sentences with them, before Step 2. If a finding changes the meaning beyond §7's four points, stop and show the owner the English before going on (CLAUDE.md: the meaning changes only on the owner's word).

- [ ] **Step 2: Write the failing check P7 in `scripts/smoke-site-pages.ts`.** Header comment, after the P6 lines (lines 23-24) add:

```ts
//  - P7 the Privacy Policy and the Terms cover the public zmanim pages (spec 2026-10-30-public-zmanim §7), in en, he and
//    ru: anyone may use the public pages; a city page's times are for the city's centre; a page's address (its city,
//    day and custom) reaches the host with the IP address, and a visit makes no account or profile; the nearest city is
//    found on the device.
```

After the P6 check (before `finish();`) add:

```ts
  await check('P7 the Privacy Policy and the Terms cover the public zmanim pages in en, he and ru: anyone may use the public pages; a city page\'s times are for its centre; a page\'s address reaches the host with the IP address and a visit makes no profile; the nearest city is found on the device', () => {
    const all = (node: unknown): string[] => (typeof node === 'string' ? [node] : node && typeof node === 'object' ? Object.values(node).flatMap(all) : []);
    // Russian binds its one-letter words with a no-break space (smoke-site-truth T6): read here as a plain one
    const read = (locale: Locale, doc: 'privacy' | 'terms', section: string) => all(messages[locale].legal[doc].sections[section]).join(' ').replace(/ /g, ' ');
    const want: Record<Locale, ['privacy' | 'terms', string, string][]> = {
      en: [
        ['terms', 'eligibility', 'To use the bots or the web app, you must be 18 or older'],
        ['terms', 'eligibility', 'Anyone may use famcal.bot’s public pages, such as the zmanim pages, without an account.'],
        ['terms', 'ai', 'On famcal.bot’s zmanim pages, they are computed for the centre of each city, so they can differ from the times where you are. **For a halachic time that matters, check a reliable source.**'],
        ['privacy', 'keep', 'The request includes the page’s address: on the zmanim pages, that is the city, and any day or custom you pick there. Visiting the site creates no account or profile.'],
        ['privacy', 'notKeep', 'On the zmanim pages, the city nearest you is found on your device, and your device’s position isn’t sent to us.'],
      ],
      he: [
        ['terms', 'eligibility', 'כדי להשתמש בבוטים או באפליקציית הרשת צריך להיות בגיל 18 ומעלה'],
        ['terms', 'eligibility', 'הדפים הציבוריים של famcal.bot, כמו דפי זמני היום, פתוחים לכולם, גם בלי חשבון.'],
        ['terms', 'ai', 'בדפי זמני היום ב־famcal.bot הם מחושבים למרכז של כל עיר, ולכן הם עלולים להיות שונים מהזמנים במקום שבו אתם נמצאים. **זמן הלכתי שחשוב לכם, בדקו מול מקור אמין.**'],
        ['privacy', 'keep', 'הבקשה כוללת את כתובת הדף: בדפי זמני היום זו העיר, וגם היום או המנהג שבחרתם שם. ביקור באתר לא יוצר חשבון או פרופיל.'],
        ['privacy', 'notKeep', 'בדפי זמני היום, העיר הקרובה אליכם מחושבת במכשיר שלכם, והמיקום של המכשיר לא נשלח אלינו.'],
      ],
      ru: [
        ['terms', 'eligibility', 'Чтобы пользоваться ботами или веб-приложением, вам должно быть не меньше 18 лет'],
        ['terms', 'eligibility', 'Публичными страницами famcal.bot, например страницами зманим, может пользоваться любой, и аккаунт для этого не нужен.'],
        ['terms', 'ai', 'На страницах зманим на famcal.bot они рассчитываются для центра каждого города, поэтому могут отличаться от времени там, где вы находитесь. **Важное галахическое время проверяйте по надёжному источнику.**'],
        ['privacy', 'keep', 'В запросе есть адрес страницы: на страницах зманим это город, а также день или обычай, если вы их выбрали. Посещение сайта не создаёт ни аккаунта, ни профиля.'],
        ['privacy', 'notKeep', 'На страницах зманим ближайший к вам город определяется на вашем устройстве, и координаты устройства нам не отправляются.'],
      ],
    };
    for (const locale of LOCALES) {
      for (const [doc, section, sentence] of want[locale]) assert(read(locale, doc, section).includes(sentence), `${locale} ${doc}.${section}: no "${sentence}"`);
    }
  });
```

- [ ] **Step 3: Run it red.** `RUN scripts/smoke-site-pages.ts`. Expected: `FAIL  P7 ... — en terms.eligibility: no "To use the bots or the web app, you must be 18 or older"`, every other check OK (in the worktree P2 and P5 fail too, for the estree-walker reason in Global Constraints).

- [ ] **Step 4: The four strings, in place, in all three files.** Each is one Edit replacing the whole current string (quoted in full; the old strings are unique in their file).

`legal.terms.sections.eligibility.blocks[0]`:
- en: old `"You must be 18 or older, and you need your own Telegram or WhatsApp account. A partner you link with needs their own account, and must be 18 or older too."` new `"To use the bots or the web app, you must be 18 or older, and you need your own Telegram or WhatsApp account. A partner you link with needs their own account, and must be 18 or older too. Anyone may use famcal.bot’s public pages, such as the zmanim pages, without an account."`
- he: old `"כדי להשתמש ב־FamCal צריך להיות בגיל 18 ומעלה, ולהחזיק חשבון טלגרם או וואטסאפ משלכם. גם בן או בת הזוג שאתם מקושרים אליהם צריכים חשבון משלהם, וגם הם צריכים להיות בגיל 18 ומעלה."` new `"כדי להשתמש בבוטים או באפליקציית הרשת צריך להיות בגיל 18 ומעלה, ולהחזיק חשבון טלגרם או וואטסאפ משלכם. גם בן או בת הזוג שאתם מקושרים אליהם צריכים חשבון משלהם, וגם הם צריכים להיות בגיל 18 ומעלה. הדפים הציבוריים של famcal.bot, כמו דפי זמני היום, פתוחים לכולם, גם בלי חשבון."`
- ru: old `"Вам должно быть не меньше 18 лет, и у вас должен быть собственный аккаунт Telegram или WhatsApp. Партнёру, с которым вы связываете аккаунт, нужен свой аккаунт, и ему тоже должно быть не меньше 18 лет."` new `"Чтобы пользоваться ботами или веб-приложением, вам должно быть не меньше 18 лет, и у вас должен быть собственный аккаунт Telegram или WhatsApp. Партнёру, с которым вы связываете аккаунт, нужен свой аккаунт, и ему тоже должно быть не меньше 18 лет. Публичными страницами famcal.bot, например страницами зманим, может пользоваться любой, и аккаунт для этого не нужен."`

`legal.terms.sections.ai.blocks[3]` (insert one sentence before the bold one):
- en: old `They can be off, for example when your place is set wrong. **For a halachic time that matters, check a reliable source.**` new `They can be off, for example when your place is set wrong. On famcal.bot’s zmanim pages, they are computed for the centre of each city, so they can differ from the times where you are. **For a halachic time that matters, check a reliable source.**`
- he: old `הם עלולים לסטות, למשל כשהמקום מוגדר לא נכון. **זמן הלכתי שחשוב לכם, בדקו מול מקור אמין.**` new `הם עלולים לסטות, למשל כשהמקום מוגדר לא נכון. בדפי זמני היום ב־famcal.bot הם מחושבים למרכז של כל עיר, ולכן הם עלולים להיות שונים מהזמנים במקום שבו אתם נמצאים. **זמן הלכתי שחשוב לכם, בדקו מול מקור אמין.**`
- ru: old `Они могут быть неточными, например если место указано неверно. **Важное галахическое время проверяйте по надёжному источнику.**` new `Они могут быть неточными, например если место указано неверно. На страницах зманим на famcal.bot они рассчитываются для центра каждого города, поэтому могут отличаться от времени там, где вы находитесь. **Важное галахическое время проверяйте по надёжному источнику.**`

`legal.privacy.sections.keep.blocks[19][1]` (the "Server logs and error reports" list's second item; append two sentences):
- en: old `"When you open famcal.bot or the web app, our host receives your request, with your IP address and browser, as any website does."` new `"When you open famcal.bot or the web app, our host receives your request, with your IP address and browser, as any website does. The request includes the page’s address: on the zmanim pages, that is the city, and any day or custom you pick there. Visiting the site creates no account or profile."`
- he: old `"כשפותחים את famcal.bot או את אפליקציית הרשת, ספק האחסון שלנו מקבל את הבקשה, עם כתובת ה־IP והדפדפן שלכם, כמו בכל אתר."` new `"כשפותחים את famcal.bot או את אפליקציית הרשת, ספק האחסון שלנו מקבל את הבקשה, עם כתובת ה־IP והדפדפן שלכם, כמו בכל אתר. הבקשה כוללת את כתובת הדף: בדפי זמני היום זו העיר, וגם היום או המנהג שבחרתם שם. ביקור באתר לא יוצר חשבון או פרופיל."`
- ru: old `"Когда вы открываете famcal.bot или веб-приложение, наш хостинг получает ваш запрос с вашим IP-адресом и данными о браузере, как и любой сайт."` new `"Когда вы открываете famcal.bot или веб-приложение, наш хостинг получает ваш запрос с вашим IP-адресом и данными о браузере, как и любой сайт. В запросе есть адрес страницы: на страницах зманим это город, а также день или обычай, если вы их выбрали. Посещение сайта не создаёт ни аккаунта, ни профиля."`

`legal.privacy.sections.notKeep.blocks[0][3]` (the device-location item; append one sentence):
- en: old `We keep only the place name.",` new `We keep only the place name. On the zmanim pages, the city nearest you is found on your device, and your device’s position isn’t sent to us.",` (the old text is unique: it ends the "**Your device’s location.**" item)
- he: old `אנחנו שומרים רק את שם המקום.",` new `אנחנו שומרים רק את שם המקום. בדפי זמני היום, העיר הקרובה אליכם מחושבת במכשיר שלכם, והמיקום של המכשיר לא נשלח אלינו.",`
- ru: old `Мы храним только название места.",` new `Мы храним только название места. На страницах зманим ближайший к вам город определяется на вашем устройстве, и координаты устройства нам не отправляются.",`

  Before each Edit, confirm the old text occurs once in its file (`grep -c` with a distinctive part of it prints 1).

- [ ] **Step 5: The date.** `src/site/legal.ts` line 6 becomes the commit day for both pages, as `TZ=Asia/Jerusalem date +%F` prints it (for a commit on 2026-10-31: `export const LEGAL_UPDATED = { privacy: '2026-10-31', terms: '2026-10-31' } as const;`). If that day is still 2026-10-30, the value is already right and the line stays (the date is the day the text last changed).

- [ ] **Step 6: Run green.** `RUN scripts/smoke-site-pages.ts` (all pass, P7 included; P2 and P5 only in the controller's CI mirror), `RUN scripts/smoke-site-truth.ts`, `RUN scripts/smoke-he-neutral.ts`, `RUN scripts/smoke-ru-formal.ts`, `RUN scripts/smoke-site-seo.ts` (S1 in the CI mirror), `RUN scripts/smoke-google-connect.ts`, `RUN scripts/smoke-google-disconnect-ui.ts`, `RUN scripts/smoke-location-check.ts`, `RUN scripts/smoke-terms-plans.ts`: all pass. Then `cd /Users/razielgershoni/development/famcalbot && npx prisma generate`.

- [ ] **Step 7: Commit the legal change.**

```bash
cd /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/zp-wt
git add messages/en.json messages/he.json messages/ru.json src/site/legal.ts scripts/smoke-site-pages.ts
git commit -F - <<'EOF'
docs(legal): the Privacy Policy and the Terms cover the public zmanim pages

Four additions in en, he and ru (spec 2026-10-30-public-zmanim §7), checked by
the lawyer agent: the age and account rules are for the bots and the web app,
anyone may use the public pages; a city page's times are for the city's centre;
a page's address, with its city, day and custom, reaches the host with the IP
address, and a visit makes no profile; the nearest city is found on the device.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
EOF
```

- [ ] **Step 8: CLAUDE.md.** Replace line 8 (the bullet that starts `- A reminder by zman (`NativeEvent.zmanSpec`, date-only)`) with:

```md
- A reminder by zman (`NativeEvent.zmanSpec`, date-only) is due at its zman at each recipient's own place. Every reader gets a reminder's due time from `dueAtForOccurrence` / `reminderDueAt` (`src/services/native-reminders/due.ts`) given the person's `ZmanClock` (`zmanClockFor` in `src/services/zmanim/reminder-clock.ts`, which asks `zmanInstant` and nothing else): the pass, the home, the digests and the summaries. Never store the computed time in `startsAt`, never count a zman anywhere else, and never import `src/services/zmanim` into a `'use client'` file: the Mini App gets the times in the DTO, in the editor info and in the sun sheet's list (`GET /api/zmanim`, `zmanDayList` in `src/services/zmanim/reminder-times.ts`, the person's wrapper over `zmanDayForPlace` in `src/services/zmanim/day-list.ts`). The list shares the editor info's rows (`zmanRows`), and its window rows come from `restDayBlocks` (`compute.ts`: every Shabbat and Yom Tov block, its start or end null where the sun makes none); the pause reads `shabbatYomTovWindows`, which is the complete blocks. The ends are the blocks' ends, the candle lighting is always the day's own `instantAt` (20 minutes before the plain sunset row), also on an eve whose block has no end (its end row is a dash), and the pause starts at the eve's sunset, so the list and the pause never disagree (a Friday or a rest day inside a longer block takes its own day's time from the same `instantAt`). The public zmanim pages (`app/[locale]/(site)/zmanim`) call the same `zmanDayForPlace` with a memo of their own per page and `quiet: true`, never the process memo, and a city's zone is its Israel flag (`inIsrael`; every Israeli city is `Asia/Jerusalem`): it decides the Yom Tov days, the height, the Sephardi end of Shabbat and the holidays' `{ il }`.
```

- [ ] **Step 9: README.** After line 36 (the `- **Public website** — ...` bullet) add:

```md
- **Public zmanim pages** — `famcal.bot/zmanim` and a page per city (135 cities, 51 of them in Israel) in Hebrew, English and Russian, with no account: the day's zmanim by Sephardi, Ashkenazi or Chabad custom, the coming Shabbat and Yom Tov times, and the month with Hebrew dates, holidays and the parasha (two-day Yom Tov abroad). Each page is computed when it is opened, by the bot's own zmanim code (`zmanDayForPlace`), with no database and no call to anyone; the day and the custom travel in the URL. "Near me" finds the nearest listed city in the browser, and the position never leaves it. The proxy allows one address 60 city pages a minute (`src/lib/page-limit.ts`), so a scraper can't slow the bot that shares the process.
```

  In "How it works", after the "**Delivery correctness.**" paragraph (it ends with `encoded from PCM to OGG/Opus.`), add:

```md
**City data, built once.** `src/site/cities.ts` holds each city's GeoNames id, coordinates and IANA zone (from [GeoNames](https://www.geonames.org/), CC BY 4.0), and for an Israeli city its height. `scripts/build-city-heights.ts` makes the heights on a developer machine, once (`npx tsx scripts/build-city-heights.ts`): for each Israeli city it asks OpenStreetMap's Nominatim for the town's outline (one request a second; © OpenStreetMap contributors, ODbL), runs the bot's own `elevationGrid` over it (`src/services/zmanim/elevation-grid.ts`), reads the 25 heights from the Copernicus DEM GLO-90 tiles in AWS's public bucket (© DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved) and keeps the highest. The values are committed: nothing reads these sources at runtime or in CI, and the zmanim pages credit all three.
```

  Line 57 becomes:

```md
- **Integrations:** Google Calendar API, Open-Meteo (weather/air quality), Hebcal (Hebrew dates/holidays, zmanim), `rrule` (RFC-5545 recurrence); GeoNames, OpenStreetMap and Copernicus DEM for the public pages' city table (built once, never called at runtime).
```

- [ ] **Step 10: The public-website spec.** In `docs/superpowers/specs/2026-10-28-public-website-design.md`:
  - line 45: `- **Links:** How it works (`#how`), Plans (`#plans`), Blog.` -> `- **Links:** How it works (`#how`), Plans (`#plans`), Blog, Zmanim (`/zmanim`, added by `2026-10-30-public-zmanim-design.md` §6.3; the phone menu has it too).`
  - line 103: `Links (How it works, Plans, Blog, Privacy, Terms, Contact), the language switcher, "Made in Israel" (no emoji), and the copyright years.` -> `Links (How it works, Plans, Blog, Zmanim, Privacy, Terms, Cancel a payment, Contact), the language switcher, "Made in Israel" (no emoji), and the copyright years. Zmanim was added by `2026-10-30-public-zmanim-design.md` §6.3; Cancel a payment by the Terms' cancellation part.`
  - line 249: `- Web login, and anonymous access to the calendar or zmanim (item 6).` -> `- Web login (item 6b). Anonymous access to the zmanim and the Jewish calendar is no longer a non-goal: item 6a built it as public city pages (`2026-10-30-public-zmanim-design.md`), with no account, cookie or storage.`

- [ ] **Step 11: Check and commit the docs.** `grep -n "restDayBlocks" CLAUDE.md` prints line 8; `grep -c "Public zmanim pages" README.md` prints 1. Then:

```bash
cd /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/zp-wt
git add CLAUDE.md README.md docs/superpowers/specs/2026-10-28-public-website-design.md
git commit -F - <<'EOF'
docs: the public zmanim pages in CLAUDE.md, the README and the website spec

CLAUDE.md's zmanim rule names the rest-day blocks, zmanDayForPlace with the
public pages' own memo, and a city's zone as its Israel flag. The README
describes the pages, the request limit, the city data and its credits, and the
heights script. The public-website spec gains the Zmanim link and drops the
anonymous-zmanim non-goal.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
EOF
```

- [ ] **Step 12: Report the final four English sentences to the controller verbatim.** In the task report, quote the four English additions exactly as committed, after the lawyer check: (1) the eligibility change (the opening "To use the bots or the web app," and the sentence "Anyone may use famcal.bot’s public pages, …"); (2) the halachic sentence ("On famcal.bot’s zmanim pages, …"); (3) the server-logs sentences ("The request includes the page’s address: …" and "Visiting the site creates no account or profile."); (4) the location sentence ("On the zmanim pages, the city nearest you is found on your device, …"). The controller shows them to the owner (CLAUDE.md: the legal texts' meaning changes only on the owner's word).

## Risks

**From Tasks 3-4:**
- The heights follow OpenStreetMap's boxes, so a later run can differ by a few metres from the table above. Harish reads 155 m here, while `scripts/smoke-zmanim-api.ts:239` uses 270 m as a fixture for a Harish user. The fixture is not a measurement. If the owner wants the two to agree, a read-only look at the real Harish user's `elevationM` is the check; it does not block this task.
- The Mini App's layout (`app/[locale]/(app)/layout.tsx:40,57`) hands every message to the client, so the two new namespaces add about 180 short strings (roughly 5-6 KB per locale) to its payload. Leaving them out would mean a `pickMessages` change in the app layout, outside Tasks 3-4.
- The heights script needs Nominatim and S3 on the implementer's machine. A transient failure is retried three times (2, 4, 8 s), and anything else stops the run before anything is written.

**From Tasks 5-7** (written before Tasks 1-2 were drafted; 1 and 2 are answered by Contract notes 1, 6 and 8):
1. **Task 1's block selection.** `restDayBlocks` must return every block whose days fall in the range, including blocks whose start or end is null. Task 5 filters by `eve` and `last` and passes a wide range (day − 3 to day + 12). V5, V6 and V8 fail if Task 1 drops blocks that have no instants.
2. **Task 2's diaspora names in Russian.** The names for `pesachIi`, `simchatTorah` and the rest must pass T6. Z8 renders them and fails on a plain space after a one-letter word.
3. **Translator typing.** It is unproven that `getTranslations`' translator assigns to `SiteT` and `CalendarT` (it should: LandingSections passes the same structural type). Step 16 of Task 6 gives the fallback.
4. **Proxy stubs in Z7.** Requiring the real `hebrew-holidays` and `day-list` before stubbing them relies on tsx resolving `@/src/...` to the same `.ts` filename as the stub key. If Z7 shows that the failure switch has no effect, key the stub with `nodeRequire.resolve('@/src/services/hebrew-holidays')`.
5. **Russian capitalisation.** The spec's Russian title uses lower-case "шаббата", and the app writes "Шаббат" everywhere else. The body copy follows the app; the meta titles follow the spec. The owner may want one form.
6. **The 404 in production.** Under the two root layouts, an unknown slug should get the site's 404 (via `notFound()` in the page, as the blog does). This needs one runtime check after the first deploy, the same open point as the blog's.

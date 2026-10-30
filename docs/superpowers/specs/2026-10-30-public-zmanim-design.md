# Public zmanim and Jewish calendar (item 6a)

Status: approved by the owner, 2026-10-30. Item 6 is split into 6a (this spec: a public tool, no account), 6b (web sign-in) and 6c (FamCal without a messenger); the owner approved the split and its decisions on 2026-10-30 ("go"). The two open questions were answered the same day (§2.5, §2.6). Reviewed by two independent readers (code facts; product, halachic and SEO), whose valid findings are folded in.

## 1. Why

The owner wants famcal.bot to be a public tool: a visitor with no account sees the zmanim and the Jewish calendar for their city, in Hebrew, English or Russian. Today every zmanim and calendar screen sits behind the Telegram or WhatsApp sign-in.

**Goal:** a page per city with the day's zmanim, the coming Shabbat or Yom Tov times, and the month with Hebrew dates, holidays and the parasha, computed by the same code the bot uses.

**Success:**
- For the same place, height, community and day, the page and the bot's sun sheet show the same times (one code path, §6.1).
- Holidays and the parasha follow the city: two-day Yom Tov abroad, the Israel schedule in Israel. The bot's users see no change, beyond the fixes named in §8.
- No visitor account or profile is kept, no device position reaches the server, and no third party is called at runtime beyond the error reports every page already sends to Sentry. The public pages send Sentry no performance traces (§7).
- Every page works without JavaScript, except "Near me".
- Search engines see one clean URL per city per language, titled with what people search for: Shabbat times.

## 2. Decisions

Approved by the owner (2026-10-30):
1. **Order:** 6a, then 6b, then 6c. This spec is 6a only.
2. **Places:** a fixed list of cities, each with its own page in he, en and ru. "Near me" picks the nearest listed city inside the browser. No free-text search.
   - **Size:** "about 100" was approved; the review argues for 135. The rule is that a place people search for by name gets a page: the whole Krayot, Harish, Yavne, Netivot, Russia east of Moscow, Cyprus, the US Mountain zone, Perth. A page costs one table row and three names.
3. **Community:** a Sephardi / Ashkenazi / Chabad switch, using the bot's three sets. The default is Sephardi in Israel and Ashkenazi abroad (§2.6). Holidays follow the place.
4. **Open-Meteo:** its free API is for non-commercial use only, so 6a adds no Open-Meteo call at runtime or at build time. Replacing it in the bot is a separate task.

Answered by the owner (2026-10-30):

5. **Candle lighting: 20 minutes before sunset everywhere, as the bot does** (option A).
   - The local customs differ: Jerusalem and Petah Tikva light 40 minutes before sunset, Haifa and Zikhron Ya'akov 30, and abroad 18 is usual. Hebcal uses 40 for Jerusalem, 30 for Haifa and Zikhron Ya'akov, and 18 elsewhere.
   - Each page names its minutes in the note (§4.2.5), so the basis is visible.
   - A per-custom choice can come later as its own task, for the bot and the site together.
6. **Default community: the simple rule** (Sephardi in Israel, Ashkenazi abroad). Visitors switch it themselves. There is no per-city default.

Rulings (small choices made here; the owner can change any of them):

7. **Rendered on each request.** A city page is computed when it is opened, so "today" is always today in the city. The date and community travel in the URL as plain links (§4.3): no client-side data fetching and no stale cached day.
   - The cost is a few milliseconds per page, with no database and no network.
   - Two guards keep this off the bot's back, since it shares the one Railway process: a bounded date range, and a per-address request limit (§6.4).
8. **No storage.** The chosen community and date live only in the URL, with no cookie and no localStorage.
9. **National days abroad.** The four approved national days (Yom HaShoah, HaZikaron, HaAtzma'ut, Yerushalayim) show abroad too, as Hebcal's diaspora calendar shows them.
10. **Week start:** Sunday, as the app's rule gives for the Jewish calendar (`weekStartFor` with culture `jewish`).
11. **Hebrew dates:** in letters on Hebrew pages, in numerals on English and Russian pages, as the app writes them (`hebrew-date.ts`).
12. **Heights:** an Israeli city's height is found by the bot's own rule: `elevationGrid` over the town's OpenStreetMap box, clipped to 3 km, keeping the highest point (§5.2). Abroad every set uses sea level, so no height is stored.
13. **Discoverability:**
    - a "Zmanim" link in the header, the phone menu and the footer;
    - a row in the landing's Jewish-calendar list linking to `/zmanim`.
14. **Titles:** search-facing titles lead with Shabbat times (§6.3); the page's heading names zmanim and Shabbat times.

## 3. Pages

| URL (en; he and ru add `/he`, `/ru`) | What | Rendering |
|---|---|---|
| `/zmanim` | The city list and "Near me" | static |
| `/zmanim/<city>` | One city: the day, Shabbat and Yom Tov ahead, the month | on each request |

- Slugs are lowercase ASCII English (`jerusalem`, `beer-sheva`, `new-york`, `saint-petersburg`), the same in every language.
- A slug never changes after launch, and cities are only added.
- An unknown slug gets the site's 404.

## 4. What the visitor sees

### 4.1 `/zmanim`

1. **The title and one line:** "Zmanim and Shabbat times", and a line saying the page covers today's zmanim, Shabbat times and the month's holidays for N cities, by Sephardi, Ashkenazi or Chabad custom.
2. **Near me**, the page's only script.
   - **What happens on a tap.** The browser asks for the position, with the same options as the Settings lookup. Its timeout is the Geolocation API's own option, not an app timer. The nearest listed city is found on the device, by haversine distance. A line says so: the position stays in the browser, and only the city's page is opened.
   - **The answer by distance:**
     - Within 30 km, it opens that city's page.
     - From 30 to 100 km, and in the same UTC offset right now, it says: "The nearest city we list is Haifa, 42 km away. Times there can differ from yours by a few minutes." The city name is a link.
     - Further away, or in another offset, it says: "We don't list a city near you yet." Then it points to the list, with no suggestion.
   - **When it fails** (refused, unavailable, or the browser has no geolocation), a line says so and points to the list. On a refusal, the line also says that location is allowed for the site in the browser's settings.
   - **While waiting**, the button shows a loading state, and the state clears on any answer.
   - **No third party:** no map, no reverse lookup, and no call to OpenStreetMap or anyone else.
3. **The list:** Israel first, then the other countries. Countries and cities are each sorted by name in the page's language. Country names are written by hand in messages (`countries.<CC>`); `Intl.DisplayNames` gives forms such as "Соединенные Штаты". Each city is a 44 px link.

### 4.2 `/zmanim/<city>`

From top to bottom:

1. **The top:** a back link to all cities; the heading ("Zmanim and Shabbat times in Jerusalem"); the date of the day shown, Gregorian and Hebrew.
2. **The day.**
   - **Day links:** previous and next day, and "Today" when another day is shown.
   - **The community switch:** three links, with the current one marked. Under it, one line says how that set counts:
     - Sephardi: as Zmanei Yosef (Ohr HaChaim), using the city's height in Israel.
     - Ashkenazi: sea level, dawn at 16.1°, nightfall at 8.5°.
     - Chabad: the Baal HaTanya.
   - **The rows:** the same rows, names, opinions, order and accent as the bot's sun sheet. Candle lighting and the end of Shabbat or Yom Tov are drawn in the accent. Times are 24-hour, in the city's zone.
   - **A zman the sun doesn't make that day** (dawn in London in June, for example) shows a dash. One note under the rows explains: at this time of year the sun doesn't go deep enough here for that zman, so follow your community's fixed times.
   - **The halachic hour** is at the bottom, under each opinion the set counts by.
3. **Shabbat and Yom Tov ahead.**
   - **Which windows:** the window under way or the next one, plus any other window that starts within 8 days of the day shown.
   - **Each window** is named by its parasha or holiday, with one line per day: the eve's candle lighting, "not before" on a middle night, and the end. These are the same rows the day list shows for those days.
   - **A window whose end the sun doesn't make** (Saint Petersburg for weeks around June) still shows its candle lighting. Its end shows a dash with the same note.
4. **The month.**
   - **Heading:** the Gregorian month and the Hebrew months it spans, with previous and next month links.
   - **The grid** is a `<table>` starting on Sunday, with weekday column headers.
   - **Each cell** shows the day, the Hebrew day and a mark for a holiday. Yom Tov is drawn in the accent. Today is outlined and carries `aria-current="date"`; the day shown is filled.
   - **Each cell links to that day.** The link's accessible name is the full Gregorian date, the Hebrew date and the holiday.
   - **The month's list,** under the grid: every holiday, fast and Rosh Chodesh, and every Shabbat with its parasha, candle lighting and end, at this city in this community.
5. **A note:** the times are computed for the city's centre (and, for Sephardi in Israel, at N m), and candle lighting is 20 minutes before sunset. For a halachic time that matters, check a reliable source.
6. **FamCal:** the landing's own sentence on reminders by zman, with its "On Telegram" tag, followed by the site's two start buttons and the honest line. All three are unchanged from the landing.
7. **Sources:** the credit lines for the data (§5.3).

Every part works without JavaScript; the page ships no script of its own.

### 4.3 Links and parameters

- **`?date=yyyy-MM-dd`** picks the day, and the month shown is that day's month. The month links go to the 1st of the other month.
  - The allowed range is from one year before today to three years after, in the city.
  - At either end of the range, the previous or next link is left out.
- **`?community=sephardi|ashkenazi|chabad`** picks the set. It is written only when it isn't the city's default, and every day, month and Today link keeps it.
- **The language links** in the site's header, menu and footer go to the clean city URL in the other language.
- **A missing, malformed or out-of-range value** is ignored: the page shows today, or the default community.
- **Day, month and community links** are plain `<a href>` elements, so they are never prefetched.
- **For search engines:**
  - The canonical URL is always the clean one, without parameters.
  - robots.txt disallows the parameter URLs (`/zmanim/*?` in each language), and the day and month links carry `rel="nofollow"`. Otherwise a calendar is an endless set of URLs for a crawler.
  - The sitemap lists `/zmanim` and every city page in each language.

## 5. Data

### 5.1 The city table

A committed, client-safe file of plain data, `src/site/cities.ts`. Each city row holds:
- the slug;
- the GeoNames id;
- the country code;
- the latitude and longitude, from GeoNames;
- the IANA zone;
- the height in metres (Israel only).

The names are written by hand in messages, in en, he and ru: `cities.<slug>` and `countries.<CC>`. GeoNames' alternate names are unreliable for Hebrew and Russian.

**The zone is the Israel flag.** The engine decides Israel or abroad from the zone alone (`inIsrael`), for the Yom Tov days, the height and the Sephardi end of Shabbat.
- Every Israeli city has `Asia/Jerusalem`, including Judea and Samaria (never `Asia/Hebron`). A smoke pins `country === 'IL'` ⇔ `inIsrael(zone)`.
- Zones are stored by their IANA name (`Europe/Kyiv`). Code never compares a zone that ICU has resolved without normalising it first: Node's ICU may still answer `Europe/Kiev`.

The list (draft in Appendix A) has 135 cities:
- 51 in Israel;
- 84 abroad, including 20 in the former Soviet Union for Russian speakers.

The owner can add or drop cities before the build. After launch, cities are only added.

### 5.2 Heights

`scripts/build-city-heights.ts` runs once, on a developer machine. For each Israeli city:
1. It asks Nominatim for the town's box, at one request a second with FamCal's User-Agent: about 51 requests, within Nominatim's usage policy.
2. It runs the bot's own `elevationGrid(point, box)` (`src/services/zmanim/place.ts`): a 5 x 5 grid over the box, clipped to 3 km from the point.
3. It reads those 25 heights from the Copernicus DEM GLO-90 tiles in the public AWS bucket (no account), using `geotiff` (MIT) as a dev dependency.
4. It writes the highest point, rounded, into the table.

The table keeps only the height, not the box. Nothing reads the script's sources at runtime or in CI.

- A negative height (Tiberias) is stored as it is read, and the engine clamps it to 0, as it does for the bot.
- The bot keeps its own Open-Meteo lookup for now. Replacing it is the separate task, and that task can reuse this script.

### 5.3 Credits

At the bottom of the zmanim pages:
- **GeoNames** (CC BY 4.0), with a link;
- **OpenStreetMap contributors**, for the town outlines used for the heights;
- **Copernicus DEM**, with its required notice verbatim: "© DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved". The notice stays in English on every page; the words around it are translated.

The README names the sources and the script.

## 6. Structure

### 6.1 One code path for the zmanim

- **The core.** The day list's body moves out of `zmanDayList` (`src/services/zmanim/reminder-times.ts`) into a pure module, `src/services/zmanim/day-list.ts`.
  - The new function is `zmanDayForPlace(place, community, day, options)`. It returns the rows and the hours.
  - Its imports are only pure modules: `compute`, `sets`, `spec`, `utils/day-events` and the client-safe list types. It joins smoke-zmanim's "imports no database, Redis or React" list.
  - `zmanDayList` becomes the user wrapper: `placeFor`, then `zmanDayForPlace`, then the `place` label.
  - `reminder-times` keeps re-exporting `__resetZmanClockForTests`.
- **Rest-day blocks.** `compute` gains a pure `restDayBlocks(range, place, community)`, which lists every Shabbat and Yom Tov block. A block's start or end may be null where the sun doesn't make it.
  - `shabbatYomTovWindows`, which the pause reads, is the complete blocks. It is unchanged, and a smoke pins that.
  - The day list reads the blocks. An eve whose block has no computable end still gets its own candle lighting, and the end row shows a dash. This fixes the same gap for the bot's users in the far north (§8).
- **The memo and the logs on the public path.** The public pages pass their own memo for each page, so a crawler can never flush the bot's process memo (`answers`: 5,000 entries, cleared when full). They also ask the engine not to warn about a missing zman: there it is expected, and the page shows it. Real errors are still logged (§6.5).
- **The rows' look.** The sun sheet's rows (words, accent, dash, halachic hour) become one plain component with no hooks, `ZmanimRows`.
  - The CSS moves out of the `'use client'` file into a plain module, which the site's stylesheet includes. The sheet re-exports `ZMANIM_SHEET_CSS`, so `smoke-zmanim-sheet` and `smoke-app-ui` keep their imports.
  - `smoke-zman-cards`' file list names the `ZmanimRows` file in place of the sheet for the `zman-words` import.
  - The sheet (client) and the city page (server) both render `ZmanimRows`.
- **The `'use client'` rule** stays: nothing in the browser imports `src/services/zmanim`. The city page is a server component, and the "Near me" island imports only the city table and its distance function.

### 6.2 Holidays by place

- **The `{ il }` option.** `holidaysInRange` and `nextHoliday` (`src/services/hebrew-holidays.ts`) get an optional `{ il }`, defaulting to `true`. Every existing caller passes nothing and gets byte-identical output.
- **One flag for labels and times.** The city page passes `il = inIsrael(city.zone)`, the same flag the windows use, so the labels and the times never disagree.
- **What changes abroad:**
  - the second days of Pesach, Shavuot and Sukkot are added, and so is Simchat Torah;
  - the parasha differs for some weeks (Chukat-Balak is combined in 2027).
- **Names.**
  - Names are keyed by the module's slug rule: `pesachIi`, `pesachViii`, `shavuotI`, `shavuotIi`, `sukkotIi` and `simchatTorah`, plus any other id the diaspora schedule produces.
  - They are written in en, he and ru wherever Hebcal's own wording is wrong or unnatural. At least the Russian forms need it: Hebcal writes "Пэсах", and FamCal writes "Песах".
- **The holidays route.** The public route `/api/calendar/holidays` is not changed; the city page computes on the server.

### 6.3 Pages, words and chrome

- **Pages.** They live in `app/[locale]/(site)/zmanim/`. They use `SitePage` and `siteMetadata` for the canonical and the alternates, and the site's per-language share image.
- **Titles,** written in `zmanimSite`:
  - en: "Shabbat times and zmanim in {city}";
  - he: "זמני שבת וזמני היום ב{city}";
  - ru: "Время шаббата и зманим: {city}".

  Each description names candle lighting, the end of Shabbat, the parasha and the Hebrew calendar.
- **Words.**
  - The page's words are in a new server-only namespace `zmanimSite`, and the names are in `cities` and `countries`. All three join the truth smoke's namespace lists.
  - The page tests also run the truth list, the no-emoji rule and the Russian typography rule (T6) over the rendered text. That covers the `calendarHome` and `holidays` strings the page shows. Four current Russian strings get their no-break spaces: `shabbatYomTovEnds`, `noTime`, `failedBody` and `MISHEYAKIR`.
  - The raw-key check learns `zmanimSite`, `cities`, `countries`, `calendarHome`, `holidays` and `zmanim`.
- **"Near me".** It receives its words and `{slug, name, lat, lon, zone}` as props, so the client namespaces (`site` only) don't change. The position call is a small client-safe helper shared with the Settings lookup, without the lookup's reverse geocoding.
- **The month** is a new server component built from `grid.ts`, `hebrew-date.ts` and `holidaysInRange`. The Mini App's `MonthBrowse` is not reused: it is about 1,000 lines of store and drag code.
- **CSS.** A new block in `src/site/site-css.ts`, under the kit's lint:
  - px sizes;
  - logical properties;
  - no hover;
  - 44 px targets, each on the tap-target list;
  - token colours only;
  - motion only under `prefers-reduced-motion: no-preference`.
- **"Today"** is read with `instantToWallTime(now, city.zone)`, the repo's DST rule, never from the server's own zone.
- **Header.** "Zmanim" goes into the nav after Blog (`site.nav.zmanim`), and into the phone menu, where the link closes the sheet, and the footer. The build checks at 960 px, in all three languages, that the header still fits on one row.
- **Landing.** One row in the Jewish group's list, before `</ul>`, so G11's anchor on the Settings note still holds.
- **Updated with it:**
  - the public-website spec (§3.1, §3.4, and the §8 non-goal "anonymous access to the calendar or zmanim");
  - `SITE_CONTENT_UPDATED`;
  - the README;
  - CLAUDE.md. Its zmanim sentence is updated: the list's window rows come from the rest-day blocks (the pause reads the complete ones); the public pages use `zmanDayForPlace` with their own memo; a city's zone is its Israel flag.

### 6.4 Guards for the shared process

- **The date range** (§4.3) bounds the distinct pages.
- **A request limit.** The proxy counts city-page requests per client address (`x-real-ip`; famcal.bot is not behind a proxy that sets another header) in process memory. Past 60 requests in a minute, it answers 429 with `Retry-After`.
  - No person reading pages comes near that. A scraper that ignores robots.txt can't hold up the bot's webhooks and cron.
  - The limit is logged as a count per minute, never with the address.

### 6.5 Errors and logs

- **A section that fails** to compute (a Hebcal error) is logged and sent to Sentry with the slug, day and community. That section says the times could not be computed and suggests another day; the rest of the page renders.
- **Nothing about a visitor** is logged: no position, no address and no city chosen by "Near me".

## 7. Privacy and Terms

Five short changes keep the texts true for a public tool. They go into all three languages at once, with a new `LEGAL_UPDATED`, after the lawyer agent's check, as the last legal update did. The wording below was revised by that check (2026-10-30):

1. **Terms, who can use FamCal:** the age and account rules apply to the bot and the web app; anyone may read famcal.bot's public pages.
2. **Terms, the halachic clause:** on a city's page, the times are computed for that city's centre, so "check a reliable source" covers it too.
3. **Privacy, server logs:** the address of a page you open reaches our host's logs with your IP address, as it already says, including a city's page and any day or community you pick there. To keep automated overuse off the site, the server counts each address's requests to these pages, in memory only and for one minute (§6.4). FamCal keeps no account or profile of visitors.
4. **Privacy, your device's location:** on the public zmanim pages, "Near me" finds the nearest city on your device, and your position isn't sent to us; we receive only the request for that city's page.
5. **Privacy, children:** "You must be 18 or older to use it" becomes "to use the bots or the web app", matching the Terms change in point 1.

**Sentry on the public pages (code, not text).** The site's pages already load Sentry's browser SDK, which sent a performance trace with the page address on 1 load in 100, and a count-only client report when the tab closed. The policy says Sentry gets error reports. So on every public site page (`<html data-surface="site">`, set by the site layout), the browser SDK samples no traces and sends no client reports, and the server samples no trace for a zmanim page request. Sentry then gets only error reports from these pages, as the policy says. The Mini App and the API keep their current 1% sampling.

There are no new cookies, no storage and no new processor: the city and height data are committed files, not services. 6c rewrites the texts for accounts without a messenger.

## 8. Non-goals

- **Out of the tool:**
  - free-text place search, times for the visitor's exact position, and a map;
  - remembering the visitor's city or community.
- **Out of the pages:**
  - per-city share images and JSON-LD for cities;
  - an API or widget for other sites, iCal, RSS and print;
  - pages for single holidays, the Omer count, daf yomi and the like;
  - the start and end times of fasts (which nightfall ends a fast, per community, is a ruling the bot hasn't made). On a fast day, the day's own dawn and nightfall rows show as usual.
- **Changes to the bot.** None, except these, each pinned by a smoke:
  - the opt-in `{ il }` on the holiday functions (no behaviour change);
  - candle lighting on an eve whose window has no computable end, in the list and for reminders at candle lighting (a fix for the far north; the pause is unchanged);
  - an end of Shabbat or Yom Tov that falls after midnight (Riga in June) shown on its block's last day, not on the next day;
  - the no-break spaces in four Russian strings.
- **Separate tasks:**
  - replacing Open-Meteo in the bot (a separate task, approved);
  - sign-in (6b);
  - accounts without a messenger and the full legal update (6c).

## 9. Tests

- **The core.**
  - Every existing zmanim smoke keeps its assertions (import paths that move are re-exported). That includes the Harish golden check and the three process zones.
  - `zmanDayForPlace` for a city equals the bot's list for a person with the same point and height.
  - A city page leaves the process memo untouched and logs no missing-zman warning.
  - The pause's windows are unchanged over 400 days in Israel and New York.
  - Saint Petersburg on a June Friday has candle lighting and a dashed end.
- **The city table.**
  - Slugs are unique, lowercase ASCII, and never `en`, `he`, `ru`, `dashboard`, `settings` or `admin`.
  - Every slug has a name in en, he and ru, and every country code has a name in all three.
  - `IL` ⇔ `inIsrael(zone)`.
  - Every zone is accepted by `new Intl.DateTimeFormat('en', { timeZone })`.
  - Every Israeli city has an integer height, and no city abroad has one.
  - Latitudes and longitudes are in range.
- **Holidays.**
  - With `il: false`, Sukkot 2026, Pesach 2027 and Shavuot 2027 have their second days, and Simchat Torah is there.
  - The 2027 summer parasha diverges (Chukat-Balak).
  - The default is unchanged: the existing holiday, parasha and next-holiday smokes pass.
  - Every holiday of both schedules from 2026 to 2030 has a name in he and ru, and no Russian name contains "Пэсах".
- **Pages,** rendered as Next renders them, in en, he and ru.
  - **The index** lists every city, grouped and sorted.
  - **The cities and dates:**
    - Jerusalem: Sephardi, with its height.
    - New York: Ashkenazi, with two-day Yom Tov.
    - London in June: dawn shows a dash, with the note.
    - Moscow in June: the earliest time for tallit and tefillin shows a dash.
    - Saint Petersburg on a June Friday.

    Each shows the rows `zmanDayForPlace` gives.
  - **Windows:** a Friday shows candle lighting, and a two-day Yom Tov shows its "not before" line.
  - **Links and parameters:**
    - The community links keep the date, and the date links keep the community.
    - The language links go to the clean URL.
    - Bad and out-of-range parameters show today.
    - The previous and next links disappear at the ends of the range.
  - **404:** an unknown city gets the site's 404.
  - **Metadata and crawling:**
    - The titles follow §6.3.
    - The canonical URL has no parameters, and robots.txt disallows the parameter URLs.
    - The sitemap has every city in every language.
    - Day links are plain anchors with `rel="nofollow"`.
  - **The month grid:**
    - It is a `<table>` with column headers.
    - Its cell links have full accessible names.
    - Today carries `aria-current="date"`.
  - **The chrome:** the header, the menu (the link closes the sheet) and the footer carry the Zmanim link, and the landing has its row.
  - **Copy:** the rendered text passes the truth list, the no-emoji rule, T6 and the raw-key check.
  - **No external requests:** no page under `(site)` fetches anything or loads a third-party script.
- **The request limit:** the 61st city-page request in a minute from one address gets 429, and other addresses and the other site pages are unaffected.
- **"Near me"** (fake DOM):
  - The nearest city is found, and each of the three distance bands gives its answer.
  - A point in another UTC offset gets "no city near you".
  - A refused or unavailable position shows its line and clears the loading state.
  - No request carries the position.
- **Rules that now cover the new files:**
  - the CSS lint and the tap-target list;
  - the truth list;
  - i18n parity;
  - formal Russian and gender-neutral Hebrew;
  - no hard-coded strings in TSX;
  - the `'use client'` import rule;
  - `smoke-dst`.

## 10. Risks

- **Halachic trust on a public page.** Everything the times rest on is visible on the page: each set's method line, the height, the 20 candle minutes, the dash note and "check a reliable source". The rows are the bot's own, already checked against Zmanei Yosef. Fast times are left out rather than improvised.
- **Heights.** A value read from a 90 m model is approximate. It follows the bot's own rule over the same OpenStreetMap box, so a page and a bot user at the same point agree.
- **Load on the shared process.** Each page is rendered fresh, in milliseconds, with no external call. Three things keep crawlers and scrapers from slowing the bot's webhooks and cron: robots.txt and nofollow, the bounded range, and the per-address limit.
- **Header width** with a fourth link at 960 px, in Russian. The build checks it, and the fallback is a shorter label.
- **The far north.** About a dozen listed cities have no dawn (and Saint Petersburg no 8.5° nightfall) for weeks around June. The page shows a dash and says why, rather than inventing a time.

## Appendix A: the cities (draft)

Names are given in he and ru, with the slug standing for the English name. Coordinates and GeoNames ids are filled in from the GeoNames dump when the table is built.

**Israel** (`IL`, `Asia/Jerusalem`; 51):

| Slug | Hebrew | Russian |
|---|---|---|
| jerusalem | ירושלים | Иерусалим |
| tel-aviv | תל אביב | Тель-Авив |
| haifa | חיפה | Хайфа |
| rishon-lezion | ראשון לציון | Ришон-ле-Цион |
| petah-tikva | פתח תקווה | Петах-Тиква |
| ashdod | אשדוד | Ашдод |
| netanya | נתניה | Нетания |
| beer-sheva | באר שבע | Беэр-Шева |
| bnei-brak | בני ברק | Бней-Брак |
| holon | חולון | Холон |
| ramat-gan | רמת גן | Рамат-Ган |
| ashkelon | אשקלון | Ашкелон |
| rehovot | רחובות | Реховот |
| bat-yam | בת ים | Бат-Ям |
| beit-shemesh | בית שמש | Бейт-Шемеш |
| kfar-saba | כפר סבא | Кфар-Саба |
| herzliya | הרצליה | Герцлия |
| hadera | חדרה | Хадера |
| modiin | מודיעין | Модиин |
| lod | לוד | Лод |
| ramla | רמלה | Рамла |
| raanana | רעננה | Раанана |
| nof-hagalil | נוף הגליל | Ноф-ха-Галиль |
| rosh-haayin | ראש העין | Рош-ха-Аин |
| afula | עפולה | Афула |
| kiryat-gat | קריית גת | Кирьят-Гат |
| nahariya | נהריה | Нахария |
| eilat | אילת | Эйлат |
| tiberias | טבריה | Тверия |
| tzfat | צפת | Цфат |
| karmiel | כרמיאל | Кармиэль |
| akko | עכו | Акко |
| maale-adumim | מעלה אדומים | Маале-Адумим |
| modiin-illit | מודיעין עילית | Модиин-Илит |
| beitar-illit | ביתר עילית | Бейтар-Илит |
| elad | אלעד | Элад |
| dimona | דימונה | Димона |
| hod-hasharon | הוד השרון | Ход-ха-Шарон |
| nes-ziona | נס ציונה | Нес-Циона |
| kiryat-shmona | קריית שמונה | Кирьят-Шмона |
| ariel | אריאל | Ариэль |
| kiryat-ata | קריית אתא | Кирьят-Ата |
| kiryat-motzkin | קריית מוצקין | Кирьят-Моцкин |
| kiryat-bialik | קריית ביאליק | Кирьят-Бялик |
| kiryat-yam | קריית ים | Кирьят-Ям |
| givatayim | גבעתיים | Гиватаим |
| yavne | יבנה | Явне |
| netivot | נתיבות | Нетивот |
| sderot | שדרות | Сдерот |
| harish | חריש | Хариш |
| zichron-yaakov | זכרון יעקב | Зихрон-Яаков |

**Abroad** (84):

- **USA** (19): new-york, monsey, lakewood, boston, philadelphia, baltimore, washington-dc, cleveland, detroit, chicago, atlanta, miami, boca-raton, dallas, houston, denver, phoenix, los-angeles, san-francisco.
- **Canada** (4): toronto, montreal, ottawa, vancouver.
- **Latin America** (7): buenos-aires, sao-paulo, rio-de-janeiro, santiago, montevideo, mexico-city, panama-city.
- **Europe** (23): london, manchester, gateshead, paris, marseille, lyon, nice, strasbourg, berlin, frankfurt, munich, vienna, budapest, prague, warsaw, amsterdam, brussels, antwerp, zurich, milan, rome, madrid, istanbul.
- **Former Soviet Union** (20): moscow, saint-petersburg, kazan, nizhny-novgorod, rostov-on-don, yekaterinburg, novosibirsk, kyiv, dnipro, odesa, kharkiv, lviv, minsk, riga, vilnius, chisinau, tbilisi, baku, almaty, tashkent.
- **Elsewhere** (11): sydney, melbourne, perth, johannesburg, cape-town, casablanca, limassol, bangkok, tokyo, dubai, hong-kong.

Left out on purpose: Brooklyn (one New York page), and Arab towns.

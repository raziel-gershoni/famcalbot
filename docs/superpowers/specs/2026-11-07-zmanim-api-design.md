# Jewish times API (v1) — design

**Status:** SHIPPED 2026-11-07. Approved by the owner 2026-11-07 ("ok for jewish time api recommendations"); open points A (the height at the exact point) and B (300 requests a minute per key) took the recommendations.

## 1. Goal and decisions

FamCal already counts Shabbat, Yom Tov and every zman for the bot, the Mini App and the public zmanim pages. The owner's other apps get the same answers over HTTP as JSON. The first app needs Shabbat times; more apps and endpoints come later.

The owner, 2026-11-07:

1. **Only the owner's apps call it**, each with its own key, so one app can be switched off without touching the others. Public or paid access may come later (not in this spec).
2. **Keys live in the admin panel** (the admin Mini App), in a small **API keys** section: create a key with an app name (the key is shown once, to copy), list the keys, revoke one. Nothing goes in Railway. A request makes **no database query in the steady state**. Only a hash of each key is stored. A key can be locked to a list of web origins (CORS) for an app that calls from a browser.
3. **A place** is a city from FamCal's city list (`src/site/cities.ts`, the public pages' list) or coordinates. In Israel the times use the stored heights and `Asia/Jerusalem`. Abroad the zone comes from `zoneForCoords`, and no zone means a clear 400. One code path with the pages: `zmanDayForPlace` with its own memo and `quiet: true`, and `restDayBlocks`. Candle lighting is 20 minutes before sunset everywhere (the owner's rule; a per-custom candle lighting was declined and is never offered). No coordinates or place names go in any log line or Sentry field.
4. **Community per request** (`sephardi`, `ashkenazi`, `chabad`). The default follows the place, as on the site: Sephardi in Israel, Ashkenazi abroad.
5. **v1 has two endpoints** under `/api/v1/`: (a) Shabbat and Yom Tov for a date range; (b) one day. Names come in he, en or ru by a `lang` parameter. Each time is given both as a full ISO instant with its offset and as the place's local 24h `hh:mm`.
6. **A per-key rate limit**, and `Cache-Control` for an hour (the same inputs always give the same answer).

My rulings (small choices, open to the owner's veto):

7. **Rate limit: 300 requests a minute per key**, counted in the process's memory. A browser app shares one key among all its visitors, which is why the limit is this high. One request costs a few milliseconds of hebcal work.
8. **Dates from 2000-01-01 to 2099-12-31.** A range is at most 366 days. The bounds are fixed, not "from today", so an answer never depends on the day it is asked.
9. **Coordinates in Israel use the height at the point itself** (the stored map at that point), not a grid. The bot's grid is "the highest point in the town" and needs the town's outline from Nominatim, which a bare point doesn't have. An app that wants the town rule passes the city. (Open point A.)
10. **Credits travel with the answer** (§3.8): the Copernicus notice when a height counts, GeoNames for a city's position, OpenStreetMap (ODbL) for a zone found from coordinates. The other app shows them wherever it shows the times, as the zmanim pages do.
11. **`private, max-age=3600`**, not `public`. The answer is not secret, but `private` keeps a shared cache (Cloudflare, a proxy) from serving it to a caller with no key.
12. **No change to the Privacy Policy or the Terms.** They cover FamCal's users. The API serves the owner's own apps, stores nothing about a request and logs no place. The other app's own policy names FamCal as the service that counts its times.

## 2. What the owner and the other app see

### 2.1 The admin panel

- The Overview gets a row, **API keys** (with the count of active keys), under the existing rows. It opens a view.
- **The view** lists each key: the app name, the key's first characters (`fcj_3kQ9x…`, to tell keys apart), the allowed origins (or "Any caller"), and the date it was made. A revoked key stays in the list, greyed, with "Revoked <date>".
- **New key**: a sheet with an app name (required, up to 40 characters) and, optionally, allowed origins, one per line (`https://shabbat.example.com`). Each origin is checked as `https://host[:port]` (or `http://localhost:port`). **Create** shows the key once in a box with **Copy** and the line "Copy it now: it is not shown again." Closing the sheet forgets the key.
- **Revoke**: on each active key, behind a confirm ("Revoke the key of <app>? That app stops working at once."). Revoked is final: to restore access, create a new key.
- No edit. To change an app's name or origins, create a new key and revoke the old one.
- All words are in `messages/{en,he,ru}.json` under `admin.apiKeys.*`, written natively in each language.

### 2.2 The other app

It sends `Authorization: Bearer <key>` with each GET. Nothing else is set up anywhere. The API reference (§5) is the document handed to it.

### 2.3 What the owner does

1. Admin panel → **API keys** → **New key** → app name (and origins if the app calls from a browser) → **Copy**.
2. Paste the key into the other app's own secret store (its env var, say `FAMCAL_API_KEY`).

Nothing in Railway, no env var on FamCal's side, no migration to run (it applies on deploy).

## 3. How it works

### 3.1 The endpoints

Both are `GET`. Shared parameters:

| Parameter | Meaning |
|---|---|
| `city` | A slug from the city list (`jerusalem`, `new-york`, …). Exactly one of `city` or `lat`+`lon`. |
| `lat`, `lon` | Decimal degrees, rounded to 4 places on arrival (about 11 m). |
| `community` | `sephardi`, `ashkenazi` or `chabad`. Default: Sephardi where the place's zone is Israel's, Ashkenazi elsewhere (`defaultCommunity`'s rule). |
| `lang` | `en` (default), `he` or `ru`: the names of zmanim, holidays, the parasha and the Hebrew date. |

Any other parameter, a repeated one, or a malformed one is a 400 (it catches a typo in the other app at once).

**(a) `GET /api/v1/shabbat?city=jerusalem&from=2026-11-13&to=2026-11-20`**

`from` and `to` are civil days in the place's zone, both included. Default: `from` is today at the place and `to` is `from` + 7 days (this week's Shabbat and any Yom Tov in it). The answer lists every block of rest days (a Shabbat, a Yom Tov, or several in a row: Rosh Hashana, Yom Tov into Shabbat) whose eve falls in the range, plus a block already under way on `from`. The selection is the city page's "ahead" filter (§3.3).

```json
{
  "place": { "city": "jerusalem", "timeZone": "Asia/Jerusalem", "inIsrael": true, "elevationM": 828 },
  "community": "sephardi",
  "lang": "en",
  "from": "2026-11-13",
  "to": "2026-11-20",
  "blocks": [
    {
      "eve": "2026-11-13",
      "last": "2026-11-14",
      "candleLighting": { "at": "2026-11-13T16:25:00+02:00", "local": "16:25" },
      "start": { "at": "2026-11-13T16:45:00+02:00", "local": "16:45" },
      "end": { "key": "SHABBAT_ENDS", "name": "Shabbat ends", "at": "2026-11-14T17:16:00+02:00", "local": "17:16" },
      "parasha": { "title": "Parashat Toldot", "brief": "Toldot" },
      "holidays": [],
      "days": [
        { "date": "2026-11-13", "rows": [{ "key": "CANDLE_LIGHTING", "name": "Candle lighting", "at": "2026-11-13T16:25:00+02:00", "local": "16:25" }] },
        { "date": "2026-11-14", "rows": [{ "key": "SHABBAT_ENDS", "name": "Shabbat ends", "at": "2026-11-14T17:16:00+02:00", "local": "17:16" }] }
      ]
    }
  ],
  "credits": [
    { "source": "copernicus-dem", "text": "Produced using Copernicus WorldDEM™-90 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved. The organisations in charge of the Copernicus programme by law or by delegation do not incur any liability for any use of the Copernicus WorldDEM™-90." },
    { "source": "geonames", "text": "City positions: GeoNames, under CC BY 4.0.", "url": "https://www.geonames.org/" }
  ]
}
```

(The times are what the engine gives today for Jerusalem at 828 m, Sephardi.)

- `candleLighting`: the eve's own `CANDLE_LIGHTING` row, 20 minutes before the plain sunset row.
- `start`: the block's `start`, the eve's sunset (the pause's start).
- `end`: the last day's end row: `SHABBAT_ENDS`, `YOM_TOV_ENDS` or `SHABBAT_YOM_TOV_ENDS`, as the day list names it.
- `days`: each day from the eve to the last day, with only its window rows (`WINDOW_ROW_KEYS`: the candle lighting, the "candle lighting after" of a second night, the ends). This is the city page's "ahead" section, row for row. A two-day Yom Tov's second-night candles are here.
- `parasha`: the block's portion, or null. `holidays`: its Yom Tov days' names, or, with none, its chol hamoed or special Shabbat (the city page's rule).
- Where the sun makes no time (the far north in summer), `at` and `local` are null. The block is still listed (`restDayBlocks` lists it with a null edge).

**(b) `GET /api/v1/day?lat=40.7128&lon=-74.0060&date=2026-11-14&lang=he`**

`date` defaults to today at the place.

```json
{
  "place": { "latitude": 40.7128, "longitude": -74.006, "timeZone": "America/New_York", "inIsrael": false, "elevationM": null },
  "community": "ashkenazi",
  "lang": "he",
  "date": "2026-11-14",
  "hebrewDate": { "text": "ד׳ בכסלו תשפ״ז", "gematriya": "ד׳ בכסלו תשפ״ז", "day": 4, "month": "Kislev", "year": 5787 },
  "holidays": [{ "title": "פרשת תולדות", "brief": "תולדות", "kind": "parasha", "chag": false }],
  "rows": [
    { "key": "ALOT", "opinion": null, "name": "עלות השחר", "at": "2026-11-14T05:17:00-05:00", "local": "05:17" },
    { "key": "SOF_SHMA_MGA", "opinion": "mga", "name": "סוף זמן קריאת שמע (מג״א)", "at": "2026-11-14T08:28:00-05:00", "local": "08:28" },
    "…",
    { "key": "SHABBAT_ENDS", "opinion": null, "name": "צאת השבת", "at": "2026-11-14T17:22:00-05:00", "local": "17:22" }
  ],
  "hours": [{ "opinion": "gra", "name": "גר״א", "ms": 2985250, "text": "49:45" }, { "opinion": "mga", "name": "מג״א", "ms": 3830083, "text": "63:50" }],
  "credits": [{ "source": "openstreetmap", "text": "Time zone map © OpenStreetMap contributors, under ODbL.", "url": "https://www.openstreetmap.org/copyright" }]
}
```

(Real engine values for New York, Ashkenazi; `"…"` stands for the rows left out here.)

- `rows`: `zmanDayForPlace(...).rows` as they are: the set's zmanim in the order of the day, with the window rows of that day among them. `name` is the list's own wording (`zmanRowName`, §3.4).
- `hours`: the halachic hour under each opinion the set counts by, as the sun sheet shows it (`formatHalachicHour`).
- `hebrewDate`: the Hebrew date of the civil day's daytime (no sunset shift), as the home and the site show it (`hebrewFullDate`, with the Russian genitive month from `calendarHome.hebrewMonthGenitive`). `text` is in `lang`; `gematriya` is always the Hebrew text with the day and year in letters. `month` is hebcal's English month name, for a program to read.
- `holidays`: `holidaysInRange(date, date, lang, { il })`, with `il` from the place's zone.

**Both endpoints:** `local` is `instantToWallTime(at, zone).slice(11, 16)`. `at` is the same reading plus the zone's offset at that instant (`+02:00`), computed with epoch arithmetic from `instantToWallTime`, never through the server's zone and never with `formatInTimeZone` (CLAUDE.md, the wall-time rule).

### 3.2 The place

`resolveApiPlace(params)` in `src/lib/api-v1/place.ts`:

- **A city:** `cityBySlug` and `cityPlace` (the city's stored point, height and zone; every Israeli city is `Asia/Jerusalem`). An unknown slug is `UNKNOWN_CITY`.
- **Coordinates:** checked as finite numbers in range first (`INVALID_COORDINATES`, before any lookup), rounded to 4 decimals, then `zoneForCoords`. Null (the open sea, no zone) is `NO_TIME_ZONE`. `zoneForCoords` reports that case to Sentry as a warning with no coordinates; the per-key rate limit caps how many can arrive. With an Israeli zone, the height is `highestHeight([point])` (ruling 9). A failure to read the map is logged under `api-v1` and the place counts at sea level, as `fetchHighestElevation` does for the bot. Abroad the height is null (no set uses it there).
- `inIsrael(place.timeZone)` then decides everything the site decides by it: the Yom Tov days, the height, the Sephardi end of Shabbat, the holidays' `{ il }`, the default community. As in the app, a point whose zone is `Asia/Hebron` or `Asia/Gaza` counts as abroad.

### 3.3 One code path with the pages

- Each request makes one `ZmanMemo` (`new Map()`) and calls `zmanDayForPlace(place, community, day, { memo, quiet: true })`, as `buildCityView` does. It never touches the process memo.
- **The blocks** come from a function moved out of `buildCityView`'s "ahead" section into `src/services/zmanim/rest-blocks-view.ts`: `restBlocksBetween(place, community, first, until, lang, il, memo)`. It holds `restDayBlocks`, the "under way or begins by `until`" filter, the holiday and parasha picking, and each day's window rows. `buildCityView` calls it with `(day, day + AHEAD_DAYS)` and the API with `(from, to)`, so the page and the API cannot drift. `smoke-zmanim-public-view` keeps passing unchanged.
- **The day** for (b) is `zmanDayForPlace` for the rows and hours, `holidaysInRange` for the holidays, and `hebrewFullDate` for the date.
- `src/services/zmanim/api-view.ts` (server only, pure: no DB, Redis or network) turns those into the JSON shapes above. Only route handlers import it, never a `'use client'` file.

### 3.4 Names in three languages

- The words are the app's own: `calendarHome.zmanim.*` and `calendarHome.zmanimList.*` through `createTranslator` (the pattern of `native-reminders/zman-view.ts`: one translator per language, kept in a module map).
- `rowText` in `components/app-ui/ZmanimRows.tsx` moves to `src/lib/calendar-view/zman-words.ts` as `zmanRowName(t, row)`. The component and the API both call it, so a row is named one way everywhere.
- The holiday and parasha names are `holidaysInRange`'s `title` and `brief` in `lang` (hebcal plus `holidays.names` overrides, gematriya years in Hebrew).
- No new user-facing string is added for the API's data. Error `message`s are English developer text, not shown to people.

### 3.5 Keys

**Table** (migration `prisma/migrations/20261107000000_api_keys`):

```prisma
model ApiKey {
  id        Int       @id @default(autoincrement())
  appName   String
  keyHash   String    @unique // SHA-256 of the key, hex
  prefix    String    // "fcj_" + its first 6 characters, for the list
  origins   String[]  @default([])
  createdAt DateTime  @default(now())
  createdBy Int       // the admin's user id
  revokedAt DateTime?
}
```

- **A key** is `fcj_` + 32 random bytes in base64url (`crypto.randomBytes`), 47 characters. It has 256 bits of randomness, so a plain SHA-256 is enough (no slow hash: nobody can guess one). The key itself is returned once, by the create call, and is never stored, logged or cached.
- **`src/services/api-keys/store.ts`** is the only file that reads or writes `prisma.apiKey` (the smoke fences it): `createApiKey(appName, origins, adminId)`, `revokeApiKey(id)`, `listApiKeys()`. After each write it rebuilds the **mirror**: the active keys as one Redis value, `REDIS_KEYS.API_KEYS` = `api:keys:v1`, JSON `[{ id, app, hash, origins }]`, with no TTL. Then it puts the same list in process memory.
- **`src/services/api-keys/lookup.ts`**, `findApiKey(rawKey)`: hashes the key and looks the hash up in the process's copy (on `globalThis.__apiKeys`: Next 16 gives routes and the scheduler separate module instances). The copy holds every active key, so an unknown key is a miss in memory, with no Redis or DB call.
  - **Fresh copy (under 5 minutes old):** memory only. This is the steady state.
  - **Older:** the request is served from the copy, and one Redis GET refreshes it in the background (at most one at a time). At most one Redis command per 5 minutes, and only while requests come.
  - **No copy (a restart, a deploy):** one Redis GET before answering.
  - **Redis has no mirror** (never written, flushed): one DB read rebuilds it and writes it back, logged `[api-keys] rebuilt the key list from the database`. This is the only DB read on the request path, and it never happens in the steady state.
  - **Redis fails:** a copy, even an old one, keeps serving (logged once per failure). With no copy, the DB is read as above. If that fails too, the answer is 503 `KEYS_UNAVAILABLE`, reported to Sentry.
- **Revoke takes effect at once** in the process that handled it (Railway runs one process). Another instance (the old one during a zero-downtime deploy) stops accepting the key within 5 minutes. The order is DB, then the Redis mirror, then memory. If the Redis write fails, the store deletes the mirror (the next cold read then rebuilds from the DB). If the delete fails too, the route answers `MIRROR_FAILED` and the panel says "Revoked, but the cache was not updated. Try again." Revoke is idempotent.
- **Admin route** `app/api/admin/api-keys/route.ts`, in the blocklist route's pattern (`verifyAdminAccess`, initData in the header and the body):
  - `GET` returns `{ success, keys: [{ id, appName, prefix, origins, createdAt, revokedAt }] }`, newest first.
  - `POST { action: 'create', appName, origins }` returns `{ success, key, id, prefix }`.
  - `POST { action: 'revoke', id }` returns `{ success }`.
  - Errors are codes: `INVALID_NAME`, `INVALID_ORIGIN`, `NOT_FOUND`, `MIRROR_FAILED`. At most 50 active keys (`TOO_MANY_KEYS`), a guard and not a product limit.
  - These are admin actions, so their DB use is fine. No hash, key or origin goes in a log line; the line is `[api-keys] key <id> created by admin <id>` or `… revoked`.
- **Panel:** `views/ApiKeysView.tsx`, `data/use-api-keys.ts` (through `admin-api.ts`), `AdminView` gains `{ kind: 'apiKeys' }`, and a row in `Overview.tsx`. The tokens and parts are the panel's own (`ListRow`, `SectionLabel`, its sheets), and the frontend-design skill is used when it is built.

### 3.6 Each request

`src/lib/api-v1/handle.ts`, `handleApiV1(request, endpoint)`, runs in this order:

1. **Key:** `Authorization: Bearer fcj_…`. Missing is 401 `MISSING_KEY`; unknown or revoked is 401 `INVALID_KEY` (the same code for both, so a caller can't learn which).
2. **Origin:** for a key with origins, a request whose `Origin` header is not in the list is 403 `ORIGIN_NOT_ALLOWED`. A request with no `Origin` (a server) is allowed. The lock only stops another website from using the key in a browser: anyone who reads the key out of a browser app can call from a server. The reference says so in one line.
3. **Rate:** `src/lib/api-v1/rate.ts`, a fixed one-minute window per key id in process memory (the pattern of `src/lib/page-limit.ts`: on `globalThis`, cleared by an unref'd timer at the window's end). Over 300 is 429 `RATE_LIMITED` with `Retry-After`. Every answer carries `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset`. It uses no Redis: Railway runs one process, and Upstash would cost a command per request. A restart resets the counts, which is fine for the owner's own apps.
4. **Parameters**, then the place (§3.2), then the answer (§3.3).

**CORS:** `OPTIONS` (the browser's preflight carries no key) answers 204 with `Access-Control-Allow-Origin` set to the request's origin only when some active key lists it, plus `Allow-Methods: GET`, `Allow-Headers: Authorization` and `Max-Age: 600`. Otherwise it answers 204 with no CORS headers, so the browser refuses the call. A GET from a listed origin echoes `Access-Control-Allow-Origin` and sends `Vary: Origin`. A key with no origins gets no CORS headers: it is a server key.

**Proxy:** `proxy.ts`'s matcher already leaves out `/api`, so the city pages' per-address limit and next-intl never touch `/api/v1/*`. Nothing changes there. The smoke pins that `/api/v1/shabbat` does not match it.

**Headers:**
- 200: `Cache-Control: private, max-age=3600`. When a date was left to its default ("today"), `max-age` is the smaller of 3600 and the seconds until the place's next midnight, so a cached "today" never outlives the day.
- Every error: `Cache-Control: no-store`.
- Always: `Content-Type: application/json; charset=utf-8`.

**Logging:** one line per request, `[api] key <id> <endpoint> <status> <ms> ms`, with no query, place, origin or key. A refused key is logged as `[api] 401 <code>`. A thrown error is `captureError(error, 'api-v1', { endpoint, key_id })`, and the answer is 500 `INTERNAL`.

**Sentry:** `Authorization` is already dropped (`SECRET_HEADERS`). `lat`, `lon` and `city` are added to the query scrub (`SECRET_PARAM_NAMES` and `SECRET_PARAM` in `src/lib/sentry-scrub.ts`), so an error event's URL and query string carry no place. One caveat: Railway's own HTTP log may show a request's path with its query. That is the platform's log, outside the app's console and Sentry.

### 3.7 Errors and versioning

Every error has one shape: `{ "error": { "code": "INVALID_DATE", "message": "date must be a real day, yyyy-MM-dd" } }`.

| Status | Codes |
|---|---|
| 400 | `INVALID_PLACE` (neither or both of city and coordinates), `UNKNOWN_CITY`, `INVALID_COORDINATES`, `NO_TIME_ZONE`, `INVALID_DATE`, `INVALID_RANGE` (`to` before `from`, or over 366 days), `OUT_OF_RANGE` (outside 2000-01-01 to 2099-12-31), `INVALID_COMMUNITY`, `INVALID_LANG`, `UNKNOWN_PARAMETER` |
| 401 | `MISSING_KEY`, `INVALID_KEY` |
| 403 | `ORIGIN_NOT_ALLOWED` |
| 404 | `NOT_FOUND` (any other path under `/api/v1/`, from a catch-all `app/api/v1/[...rest]/route.ts`) |
| 429 | `RATE_LIMITED` |
| 500 | `INTERNAL` |
| 503 | `KEYS_UNAVAILABLE` |

**Versioning:** `/api/v1/` keeps its fields and their meaning. New fields and new endpoints are added to v1 (callers ignore fields they don't know). A rename, a removal or a change of meaning is `/api/v2/`, served beside v1 until the owner's apps have moved.

### 3.8 Credits

The licences ask for credit where derived data is shown. The zmanim pages carry it (`COPERNICUS_NOTICE`, the GeoNames line), and the API's answers are the same data:

- `copernicus-dem` (`COPERNICUS_NOTICE`, `src/site/zmanim/sources.ts`): when a height counted, meaning a Sephardi answer in Israel with a height above 0 (the `heightM` rule of `buildCityView`), or any answer that returns an `elevationM`.
- `geonames`: when a city was named. Its position and zone are GeoNames data (NOTICE item 2).
- `openstreetmap`: when coordinates were given. The zone comes from timezone-boundary-builder's map (© OpenStreetMap contributors, ODbL), which the site footer credits.

The texts are English constants in `src/lib/api-v1/credits.ts`, beside the site's (licence text is never translated). hebcal is code, not data, and needs no credit in an answer. The API reference tells the other app to show `credits` beside the times.

### 3.9 Neon and Redis

- **Steady state:** zero DB queries and zero Redis commands per request (the memory copy, the in-memory limiter, pure computation). The only extra Redis use is one GET per 5 minutes while requests come.
- **A cold start:** one Redis GET. One DB read only if the mirror is missing.
- **Admin actions:** one DB write and one Redis SET each, a few times a year.
- No cron, timer or gate is added. The rate limiter's cleanup timer is unref'd and touches nothing outside memory.

## 4. Testing (offline smokes, run with the fake env)

**`scripts/smoke-api-v1.ts`**: the routes, the handler, the place, the views and the engine run for real over a faked Prisma, Redis and Sentry capture, which count every call. It re-runs itself under the process zones UTC, Asia/Jerusalem and America/New_York, as `smoke-zmanim-api` does.

1. **One code path:** for Jerusalem, Haifa (Ashkenazi too) and New York over 400 days, every `blocks[]` entry equals `buildCityView`'s ahead windows, row for row and instant for instant. Every `/day` answer's rows and hours equal `zmanDayForPlace` with its own memo. The candle lighting is the eve's `CANDLE_LIGHTING` and exactly 20 minutes before that day's `SHKIA`. `start` equals `restDayBlocks`' start.
2. **Golden:** Jerusalem, 2026-11-13 to 14, Sephardi, as in §3.1 (16:25, 16:45, 17:16, Toldot). Yom Kippur, Shavuot on a Friday in Israel, Pesach and Sukkot abroad (two days, the second-night "candle lighting after" row), and a polar eve with a null end.
3. **Times:** `local` equals `instantToWallTime(at).slice(11, 16)`. Each `at` carries the zone's offset on both sides of a clock change (Israel and New York, spring and autumn). The answers are the same under all three process zones.
4. **Place:** a city, coordinates in Israel (an Israeli zone and the point's height), coordinates abroad (no height), coordinates at sea (400 `NO_TIME_ZONE`), Hebron (counted as abroad), an out-of-range value (400 before any zone lookup), and the default community by place.
5. **Languages:** names in en, he and ru. The Hebrew date has gematriya day and year (`ד׳ בכסלו תשפ״ז`). Russian uses the genitive month.
6. **Errors:** every code in §3.7 with its status, the one error shape, `no-store` on errors, `UNKNOWN_PARAMETER`, a repeated parameter, the date bounds and the 366-day range.
7. **Headers:** `private, max-age=3600` with explicit dates. With a defaulted date, the max-age runs to the place's midnight (a fixed `now`).
8. **No DB once warm:** after the first request (one Redis GET, zero Prisma calls), 50 requests across both endpoints and both keys make **zero Prisma calls and zero Redis commands**. After 5 minutes (fake clock), one request triggers exactly one Redis GET. With the mirror missing, exactly one Prisma read and one SET, then none.
9. **Keys:** a revoked key is refused on the next request in the same process. An old copy refuses it after its refresh. An unknown key costs no Redis or DB call.
10. **Rate:** the 301st request in a minute is 429 with `Retry-After`. The next window is fresh. Keys count separately.
11. **CORS:** the preflight from a listed origin and from an unlisted one, a GET from an unlisted origin (403), a server call with no `Origin`, and a server key (no CORS headers).
12. **No place in logs:** every console line and every captured Sentry message or field during the run contains none of the coordinates, city slugs or city names used, and no key or hash.
13. **The proxy:** `config.matcher` does not match `/api/v1/shabbat`.

**`scripts/smoke-api-keys.ts`:**

- Create returns a `fcj_` key of 47 characters. Only its SHA-256 and the prefix reach the fake table and the mirror. The key appears in no console line.
- Revoke updates the DB, the mirror and memory, in that order.
- A failed mirror write deletes the mirror, and if that fails too the answer is `MIRROR_FAILED`.
- The admin route refuses a non-admin (403) and no initData (401), and checks the name and origin rules and `TOO_MANY_KEYS`.
- **The fence:** a scan of `src/`, `app/` and `scripts/` finds `prisma.apiKey` only in `src/services/api-keys/store.ts`.

**Also:**
- `smoke-sentry-scrub` gains the `lat`, `lon` and `city` cases.
- `smoke-zmanim-public-view` and `smoke-zmanim-sheet` run unchanged after the moves (`restBlocksBetween`, `zmanRowName`).
- The gate: `npx tsc --noEmit`, `npm run lint`, every smoke, then `npx next build` in a fresh clone (never `npm run build`).

## 5. Docs

- **`docs/api/jewish-times-v1.md`**: the reference handed to another app. It covers the key header, both endpoints with every parameter, the example answers, the fields, the error table, the limits (rate, dates, range), caching, CORS and its limit, the credits to show, the versioning promise, and the list of city slugs (generated from `CITIES` by a check in `smoke-api-v1` that fails when the doc's list and the table differ).
- **README:** a short "Jewish times API" section: what it is, where keys are made, and a link to the reference.
- **CLAUDE.md:** one rule. `/api/v1/*` answers come only from `zmanDayForPlace` (own memo, quiet) and `restBlocksBetween`. Keys are read only through `findApiKey` and written only in `api-keys/store.ts`. A request makes no DB query in the steady state. No place, key or origin reaches a log or Sentry.

## 6. Non-goals

- Public or paid access, sign-up for keys, usage statistics or a "last used" date (each would need writes per request).
- A per-custom candle lighting (Jerusalem's 40 minutes, 18 or 30 minutes): declined by the owner. It is never offered and there is no parameter for it.
- Events by zman, an endpoint for the city list, a key's origins edited in place, POST bodies, webhooks.
- Weather or dust over the API.
- Any message to a FamCal chat.

## 7. Open points for the owner

- **A. Height for coordinates in Israel** (ruling 9): (a) the height at the point itself (recommended: simple, exact for the point given; the city gives the town rule); (b) the bot's 5 × 5 grid over a 3 km square around the point, which may overstate the height in hilly places next to a ridge.
- **B. The rate limit of 300 a minute per key** (ruling 7). Lower it if the first app calls from a server and caches.

## 8. Files touched (for the plan)

- New:
  - `prisma/migrations/20261107000000_api_keys/migration.sql`
  - `src/services/api-keys/{store,lookup}.ts`
  - `src/lib/api-v1/{handle,place,rate,respond,credits,params}.ts`
  - `src/services/zmanim/{api-view,rest-blocks-view}.ts`
  - `app/api/v1/{shabbat,day}/route.ts` and `app/api/v1/[...rest]/route.ts`
  - `app/api/admin/api-keys/route.ts`
  - `app/[locale]/(app)/admin-panel/views/ApiKeysView.tsx` and `data/use-api-keys.ts`
  - `scripts/smoke-api-v1.ts` and `scripts/smoke-api-keys.ts`
  - `docs/api/jewish-times-v1.md`
- Changed:
  - `prisma/schema.prisma`
  - `src/config/redis-keys.ts`
  - `src/site/zmanim/city-view.ts` (calls `restBlocksBetween`)
  - `components/app-ui/ZmanimRows.tsx` and `src/lib/calendar-view/zman-words.ts` (`zmanRowName`)
  - `src/lib/sentry-scrub.ts` and `scripts/smoke-sentry-scrub.ts`
  - `app/[locale]/(app)/admin-panel/{navigation.tsx,views/Overview.tsx,AdminPanel.tsx}`
  - `messages/{en,he,ru}.json` (`admin.apiKeys.*`)
  - `README.md` and `CLAUDE.md`

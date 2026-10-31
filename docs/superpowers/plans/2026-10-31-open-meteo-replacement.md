# Replacing Open-Meteo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Owner overrides (binding):** ONE implementer per task (Sonnet, medium effort; Task 3 at high effort), one reviewer per task (Sonnet), then ONE final whole-branch review (Opus, high effort). The legal check in Task 5 goes to the lawyer agent (Opus) as for the 2026-10-30 policy. No execution-method question: once the plan is saved, the controller proceeds autonomously (plan → build → verify → commit → merge → push → ping the owner).

**Goal:** Stop using Open-Meteo's free API (non-commercial only) for all four uses: forecast from MET Norway, dust from Open-Meteo's public CAMS files on S3, time zones from geo-tz on our server, heights in Israel from a stored GLO-90 map; add the credit lines and the Privacy Policy change the owner approved.

**Architecture:** Four replacements behind the existing seams, so callers barely move: `fetchWeather(location, timezone)` (now `src/services/weather/forecast.ts`, one MET mapper), `fetchAirQuality(location, timezone)` (rewritten on `@openmeteo/file-reader`), `zoneForCoords(lat, lon)` (one local lookup replacing two network ones), `fetchHighestElevation` (reads a committed brotli height file). Then credits, the policy text, a guard smoke and the docs.

**Tech Stack:** Next.js 16 (Turbopack, `output: 'standalone'`, Railway runs `next start`), TypeScript, Upstash Redis, Sentry (`captureError`/`captureWarning`), `@hebcal/core`, `geo-tz` 8.1.x, `lru-cache` 11.x, `@openmeteo/file-reader` 0.0.21, `geotiff` (dev only), smokes in `scripts/smoke-*.ts` run by `scripts/ci-smokes.sh` with tsx.

**Spec:** `docs/superpowers/specs/2026-10-31-open-meteo-replacement-design.md` (approved 2026-10-31, every recommendation in §3 including the Privacy Policy sentences in decision 4). The dust spike's report (scratchpad `om/spike/report.md`, verdict GO) adds binding rulings R1–R8, folded into Task 4 and the Global Constraints.

## Global Constraints

- One code path per piece of logic, shared by the scheduled and user-invoked flows (summaries, /weather, the share image, the AI's weather lines).
- Wall time ↔ instant only with `wallTimeToInstant` / `instantToWallTime` (`src/utils/wall-time.ts`); never `fromZonedTime`, never `setHours`/`setDate`/`getHours` on a Date built for that purpose; read a wall hour from the text (`'yyyy-MM-ddTHH:mm'.slice(11, 13)`).
- No artificial timeouts in app code. Retry 429, 5xx and no-answer with backoff, honouring `Retry-After`; a `Retry-After` over 10 s gives up at once.
- Every caught failure is logged with `captureError` / `captureWarning` (`src/lib/error-capture.ts`). Never a place name or coordinates in a Sentry message or tag.
- No inline user-facing strings: new words go in `messages/{en,he,ru}.json`, Hebrew gender-neutral (plural "you", as the existing strings), Russian formal (вы), and in the site and legal namespaces Russian one-letter words (в, с, к, о, у, и, а, я) bind to the next word with U+00A0 and a U+00A0 comes before every "—" (`smoke-site-truth` T6).
- `legal.*` changes only as spec decision 4 says, in all three languages at once, with a new `LEGAL_UPDATED.privacy` (`src/site/legal.ts`); the Terms do not change.
- Smokes: `scripts/smoke-*.ts`, fake env, no network, run on Node 22 (the CI's major). Time code runs under `TZ=UTC` and `TZ=Asia/Jerusalem`.
- Gate before every commit: `npx tsc --noEmit`, `npm run lint`, `bash scripts/ci-smokes.sh` (Node 22), `npx next build`. **Never `npm run build`** (it migrates prod).
- Never import `src/services/zmanim`, `src/services/weather`, `src/lib/timezone.ts`, `src/lib/zone-for-coords.ts`, `geo-tz` or `@openmeteo/file-reader` into a `'use client'` file, the proxy or the edge runtime.
- MET: User-Agent exactly `FamCal/1.0 (+https://famcal.bot)`; coordinates rounded to 2 decimals; no request before `Expires`; `If-Modified-Since` on a refetch; the `complete` endpoint.
- Dependencies: `geo-tz` `^8.1.10` (its default "1970" data set), `lru-cache` `^11.5.3`, `@openmeteo/file-reader` pinned to exactly `0.0.21` (GPL-2.0, server only), `geotiff` stays a devDependency. Flag no other upgrades.
- What users see changes as the spec §2 says, with one number updated by the spike: dust alerts look **about 5 days** ahead (cams_global's 120 h), not 7 (the spec said 4.5). The forecast is 9 days (today included), hourly for about 2.5 days, then 6-hourly.
- Work happens on the short-lived branch `open-meteo`, one commit per task, fast-forwarded to `main` after the final review (owner's rule: the branch is never the destination). Every commit message ends with:

  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
  ```

## Review Focus

1. A Hebrew message with a rain range: "14:00–17:00" must read in that order inside a right-to-left line (each range isolated left to right, U+2066…U+2069), never as "17:00–14:00". Test: Task 3, `smoke-bug-batch-words` (the weather-only message in he on a rainy day).
2. A real MET answer has holes (no UV after about 2.5 days, a last step with no period, a step missing a field, an unknown symbol, no apparent temperature): the mapped forecast must hold no NaN, Infinity or undefined anywhere. Test: Task 3, `smoke-met-weather` "[gaps]".
3. A day forecast in 6-hour steps that rains all day must read "02:00–24:00" with its total, never "02:00–02:00". Test: Task 3, `smoke-met-weather` (6 Nov in the Tel Aviv fixture).
4. A place whose zone can't be found (at sea, or the zone data missing) must never get Israel's clock: the geocode path answers no zone, /weather gives its error reply, the share image fails loudly. Tests: Task 1 `smoke-location-timezone` (u)(v); Task 3 `smoke-weather-command` check 11.
5. A place where the sun does not rise that day (Murmansk in December, Russian users) must show "—" for sunrise and sunset, not an empty label or a crash. Tests: Task 3, `smoke-met-weather` "[polar]" and `smoke-bug-batch-words` (the fallback text).

---

## Before Task 1 (controller)

- [ ] **Step 0.1: Commit this plan on main** (the approved spec is already committed, 99b5f268).

```bash
cd /Users/razielgershoni/development/famcalbot
git add docs/superpowers/plans/2026-10-31-open-meteo-replacement.md
git commit -m "docs(plan): replacing Open-Meteo

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31"
git switch -c open-meteo
```

- [ ] **Step 0.2: Create the two scratch helpers** (scratchpad, never committed). `SCRATCH=/private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/om`.

`$SCRATCH/om-smoke.sh` runs named smokes with `ci-smokes.sh`'s fake env (and every `.env*` name blanked, so Prisma/dotenv can't read a real value) on Node 22:

```bash
#!/usr/bin/env bash
# usage: om-smoke.sh scripts/smoke-a.ts [scripts/smoke-b.ts ...]   (TZ_OVERRIDE=UTC to run under UTC)
set -u
cd /Users/razielgershoni/development/famcalbot || exit 2
FAKES=(
  'DATABASE_URL=postgresql://fake:fake@127.0.0.1:1/fake' 'DIRECT_URL=postgresql://fake:fake@127.0.0.1:1/fake'
  'TELEGRAM_BOT_TOKEN=000000:fake' 'WHATSAPP_ACCESS_TOKEN=fake' 'WHATSAPP_PHONE_NUMBER_ID=' 'WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake'
  'GOOGLE_CLIENT_ID=fake' 'GOOGLE_CLIENT_SECRET=fake' 'GOOGLE_REFRESH_TOKEN=fake' 'CRON_SECRET=fake'
  'ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000' 'ENCRYPTION_KEY_PREVIOUS='
  'NODE_ENV=development' 'GOOGLE_TTS_CREDENTIALS={}' 'TELEGRAM_WEBHOOK_SECRET=fake' 'GEMINI_API_KEY=fake'
)
ENV_ARGS=(TZ="${TZ_OVERRIDE:-Asia/Jerusalem}" "${FAKES[@]}")
for f in .env .env.*; do
  [ -f "$f" ] || continue
  while IFS= read -r name; do
    [ -z "$name" ] && continue
    skip=0; for e in "${ENV_ARGS[@]}"; do [ "${e%%=*}" = "$name" ] && skip=1 && break; done
    [ "$skip" -eq 0 ] && ENV_ARGS+=("$name=")
  done < <(sed -nE 's/^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=.*/\2/p' "$f")
done
NODE22_DIR="$(dirname "$(npx -y node@22 -p process.execPath)")"
status=0
for file in "$@"; do
  echo "== $file (TZ=${TZ_OVERRIDE:-Asia/Jerusalem})"
  env PATH="$NODE22_DIR:$PATH" "${ENV_ARGS[@]}" npx tsx "$file" || status=1
done
exit $status
```

`$SCRATCH/fresh-build.sh` builds a fresh clone of the branch the way Railway does and checks the standalone output (memory: "fresh-clone build before main"). It deletes only its own previous clone in `$SCRATCH/fresh`:

```bash
#!/usr/bin/env bash
# usage: fresh-build.sh   (after a commit on the open-meteo branch)
set -euo pipefail
SCRATCH=/private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/om
REPO=/Users/razielgershoni/development/famcalbot
DIR="$SCRATCH/fresh"
rm -rf "$DIR"   # this script's own previous clone, nothing else
git clone --quiet --branch "$(git -C "$REPO" rev-parse --abbrev-ref HEAD)" "$REPO" "$DIR"
cd "$DIR"
export PATH="$(dirname "$(npx -y node@22 -p process.execPath)"):$PATH"
node --version
FAKE_ENV=(DATABASE_URL=postgresql://fake:fake@127.0.0.1:1/fake DIRECT_URL=postgresql://fake:fake@127.0.0.1:1/fake TELEGRAM_BOT_TOKEN=000000:fake WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 ENCRYPTION_KEY_PREVIOUS= 'GOOGLE_TTS_CREDENTIALS={}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake)
npm ci --no-audit --no-fund
env "${FAKE_ENV[@]}" npx prisma generate
env "${FAKE_ENV[@]}" npx next build
S=.next/standalone
echo "-- geo-tz data in the standalone output:"; ls "$S/node_modules/geo-tz/data/"
test -f "$S/node_modules/geo-tz/data/timezones-1970.geojson.geo.dat"
if ls "$S/node_modules/geo-tz/data/" | grep -E 'timezones-now|timezones\.geojson'; then echo "FAIL: an unused geo-tz data set was traced"; exit 1; fi
(cd "$S" && node -e "const z=require('geo-tz').find(32.106,35.174); if (z[0]!=='Asia/Jerusalem') { console.error(z); process.exit(1) } console.log('geo-tz from standalone:', z)")
if [ -f "$DIR/data/israel-heights-3s.i16.br" ]; then test -f "$S/data/israel-heights-3s.i16.br" && echo "-- height map traced: $(ls -l "$S/data/israel-heights-3s.i16.br")"; fi
if [ -d node_modules/@openmeteo/file-reader ]; then echo "-- wasm assets:"; find .next -name '*.wasm' | head; test -n "$(find .next -name '*.wasm' | head -1)"; fi
echo "FRESH BUILD OK"
cd "$SCRATCH" && rm -rf "$DIR"   # leave no clone behind
```

`chmod +x` both. They are referred to below as `om-smoke.sh` and `fresh-build.sh`.

---

## File map

| File | Task | Responsibility |
|---|---|---|
| `src/lib/zone-for-coords.ts` (new) | 1 | `zoneForCoords`, `pickZone` (West Bank rule), the bounded tile cache. Leaf module: geocoding.ts and timezone.ts both import it (timezone.ts imports geocoding.ts, so the function cannot live in timezone.ts without a cycle; timezone.ts re-exports it). |
| `src/lib/timezone.ts` | 1 | `resolveLocation` uses `zoneForCoords`; `lookUpZone` and the Open-Meteo request go. |
| `src/services/weather/geocoding.ts` | 1 | `geocodeLocation` zone from `zoneForCoords` (null, never Asia/Jerusalem); `getTimezone` rejects a null zone. |
| `next.config.js` | 1, 2 | `geo-tz` external + the two data sets excluded; the height file traced. |
| `src/services/zmanim/height-map.ts` (new) | 2 | The height file's binary layout: encode, decode, `heightAt`. Pure. |
| `src/services/zmanim/heights.ts` (new) | 2 | Loads the file once (globalThis), `highestHeight(points)`. |
| `scripts/lib/glo90.ts` (new) | 2 | The GLO-90 tile reader moved out of `build-city-heights.ts`, shared by both build scripts. |
| `scripts/build-israel-heights.ts` (new), `data/israel-heights-3s.i16.br` (new) | 2 | The dev script and its committed output. |
| `src/services/zmanim/place.ts` | 2 | `fetchHighestElevation` reads the map; heights only for Israeli zones. |
| `src/services/zmanim/compute.ts` | 3 | `seaLevelSun(date, place)`: the weather's sunrise and sunset. |
| `src/services/weather/forecast.ts` (new, replaces `open-meteo.ts`) | 3 | MET fetch, cache, retries, the one mapper, the WMO helpers. |
| `src/services/weather/rain.ts` (new) | 3 | Rain words shared by every surface (prompt text, person's text, mm in the person's numerals). |
| `src/types.ts` | 3, 4 | `RainSpell`, `WeatherDaySummary`, `WeatherDay`; no rain %, no visibility; `AirQualityData` without pm2_5. |
| `formatter.ts`, `infographic.tsx`, `dust-storm.ts`, `sharav.ts`, `claude.ts`, `telegram/summary.ts`, `telegram/commands.ts`, `app/api/weather-image/sign/route.ts` | 3 | Callers move to rain amount and hours; the zone is passed. |
| `src/services/weather/air-quality.ts` | 4 | CAMS dust and pm10 from S3, the API's `auto` domains. |
| `scripts/record-cams-fixture.ts` (new), `scripts/fixtures/cams-tel-aviv.json` (new) | 4 | One-off recorder and the replayed S3 exchanges. |
| `src/site/data-sources.ts` (new), `components/site/SiteFooter.tsx`, `src/site/site-css.ts` | 5 | The site's "Data sources" line. |
| `messages/{en,he,ru}.json`, `src/site/legal.ts` | 3, 5 | New words, credits, the policy sentences, `LEGAL_UPDATED`. |
| `scripts/smoke-met-weather.ts`, `scripts/smoke-air-quality.ts`, `scripts/smoke-no-open-meteo.ts` (new) | 3, 4, 5 | New smokes. |
| `README.md`, `CLAUDE.md`, `prisma/schema.prisma` (comment) | 2, 5 | Docs. |

---

### Task 1: Time zone on our own server (geo-tz)

**Files:**
- Create: `src/lib/zone-for-coords.ts`
- Modify: `src/lib/timezone.ts:1-110`, `src/services/weather/geocoding.ts:1-124`, `next.config.js:10-11`, `package.json`, `package-lock.json`
- Test: `scripts/smoke-location-timezone.ts` (rewritten in part), `scripts/smoke-zmanim.ts`, `scripts/smoke-pause.ts:131-135`, `scripts/smoke-zmanim-api.ts:152-156`, `scripts/smoke-calendar-range.ts:837`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces:
  - `zoneForCoords(latitude: number, longitude: number): string | null` (sync, never throws, logs every null) — exported from `src/lib/zone-for-coords.ts` and re-exported by `src/lib/timezone.ts`.
  - `pickZone(zones: readonly string[]): string | null`.
  - `TILE_CACHE_MAX = 32`, `tileCacheStats(): { size: number; stored: number }`.
  - `GeoLocation.timezone: string | null` (geocoding.ts); `getTimezone(location): Promise<string>` **rejects** when the place has no zone (Task 3's callers rely on this).
  - `ResolvedLocation.timezone` (timezone.ts) is `zoneForCoords`'s answer (Task 2's Israel gate reads it).

- [ ] **Step 1.1: Install the libraries**

```bash
cd /Users/razielgershoni/development/famcalbot
npm install geo-tz@^8.1.10 lru-cache@^11.5.3
```

Expected: both appear under `dependencies` in `package.json`; `node -e "console.log(require('geo-tz').find(32.106,35.174))"` prints `[ 'Asia/Jerusalem', 'Asia/Hebron' ]`.

- [ ] **Step 1.2: Write the failing checks in `scripts/smoke-location-timezone.ts`**

Edit the existing smoke as follows (it keeps driving the real settings route; the geocoding module stays faked, so only Nominatim's request remains).

Header comment, first paragraph: replace "one Nominatim request, one Open-Meteo request for the zone and one for the highest ground (zmanim), 3 s each, no retries" with "one Nominatim request (3 s, no retry), the zone from our own map (zoneForCoords, geo-tz) and the highest ground (zmanim)"; add after the paragraph: "The zone map runs for real: the spec's places (Ariel, Ma'ale Adumim, Eilat, Katzrin, Hebron, Gaza, Kyiv, a sea point), the West Bank rule, the bounded tile cache, and (in a child process) the map's data file missing."

Fakes (replace the `answers` declaration, `fakeFetchWithTimeout` and `PLACES`):

```ts
/** How each host answers a request in the current scenario: a Response, or a thrown error. */
let answers: { nominatim: (url: URL) => Response; elevation: (url: URL) => Response } = {
  nominatim: () => { throw new Error('no scenario'); },
  elevation: () => { throw new Error('no scenario'); },
};
async function fakeFetchWithTimeout(url: string, options?: unknown, timeoutMs?: unknown, maxRetries?: unknown): Promise<Response> {
  requests.push({ url, options, timeoutMs, maxRetries });
  const parsed = new URL(url);
  if (parsed.host === 'nominatim.openstreetmap.org') {
    await held.get(parsed.searchParams.get('q') ?? '');
    return answers.nominatim(parsed);
  }
  // Task 2 removes the elevation request (the height comes from the stored map)
  if (parsed.host === 'api.open-meteo.com' && parsed.pathname === '/v1/elevation') return answers.elevation(parsed);
  throw new Error(`unexpected request: ${url}`);
}
/** The places the fake geocoder knows: Nominatim's coordinates, and the zone the real zone map gives them (null: none). */
const PLACES: Record<string, { lat: string; lon: string; zone: string | null }> = {
  'New York': { lat: '40.7127281', lon: '-74.0060152', zone: 'America/New_York' },
  'London': { lat: '51.5074456', lon: '-0.1277653', zone: 'Europe/London' },
  'Tel Aviv': { lat: '32.0852997', lon: '34.7818064', zone: 'Asia/Jerusalem' },
  'תל אביב': { lat: '32.0852997', lon: '34.7818064', zone: 'Asia/Jerusalem' },
  'Москва': { lat: '55.7505412', lon: '37.6174782', zone: 'Europe/Moscow' },
  // 35 km off Haifa: the zone map answers Etc/GMT-2, which is no one's zone
  'Out at sea': { lat: '33.0', lon: '34.5', zone: null },
};
```

In `seed()`, drop the `openMeteo` answer. Replace `FULL_LOOKUP` with:

```ts
  /** The requests a full lookup makes: the place (3 s, no retry) and its highest ground; the zone is local. Task 2 drops the second. */
  const FULL_LOOKUP = ['nominatim.openstreetmap.org 3000/0', 'api.open-meteo.com/elevation 3000/0'];
```

Existing checks, changed:
- (a) "the lookup": rename to "(a) the lookup: one Nominatim request (3 s, no retry), no zone request, no geocode cache"; delete the three lines that read `requests[1]` as Open-Meteo's forecast URL.
- (b) both "Open-Meteo fails" and "Open-Meteo answers 503": replace with one check:

```ts
  await check('(b) the zone map has no zone for the place (Nominatim\'s point is at sea): the cached zone stays, nothing is written to tz:user, one warning under location-lookup without the place\'s name; the coordinates are still saved', async () => {
    seed();
    await save({ location: 'Out at sea' });
    await drainAfter();
    assert(redisStore.get(TZ_KEY) === OLD_ZONE && redisSets.length === 0, `zone ${show(redisStore.get(TZ_KEY))}, sets ${show(redisSets)}`);
    assert(userRow.latitude === 33 && userRow.longitude === 34.5, `the place is kept: ${show([userRow.latitude, userRow.longitude])}`);
    const lookups = captured.filter(c => c.context === 'location-lookup');
    assert(lookups.length === 1 && lookups[0].severity === 'warning' && lookups[0].message.includes('Etc/GMT-2') && !lookups[0].message.includes('Out at sea'), `captured ${show(captured)}`);
  });
```

- (c) unchanged except its expected shape stays `['nominatim.openstreetmap.org 3000/0']`.
- (d) "a zone Intl does not know" and (e) "no zone": delete (the real map can't answer either; `pickZone` and the sea are covered by (b), (r) and (s)).
- (i): keep the New York and the two Nominatim-failure cases; replace the `answers.openMeteo = () => json({ timezone: '' })` case with `seed(); assert(await resolveTimezoneForLocation('Out at sea') === null, 'a place at sea');`.
- (j): the expected `asked` becomes `['place Tel Aviv', 'place London', 'elevation', 'elevation']` (no zone requests); in the `asked` mapper drop the `zone ${...}` branch.
- (k), (l): `requests.length === 3` becomes `requests.length === 2`.
- (p): drop the three "zone ..." cases and add `['the place is at sea', a => { a.nominatim = () => json([{ lat: '33.0', lon: '34.5' }]); }]`; the assertion stays "one capture under location-lookup, a warning, without 'New York'".

New checks, added before the summary loop:

```ts
  const zones = nodeRequire(path.join(ROOT, 'src/lib/zone-for-coords.ts')) as {
    zoneForCoords: (latitude: number, longitude: number) => string | null;
    pickZone: (zones: readonly string[]) => string | null;
    tileCacheStats: () => { size: number; stored: number };
    TILE_CACHE_MAX: number;
  };

  await check('(r) the zone map on the spec\'s places: Ariel, Ma\'ale Adumim, Eilat and Katzrin are Asia/Jerusalem (the first two are over the Green Line, where the map also lists Hebron), Hebron and Gaza keep their own zones, Kyiv is Europe/Kyiv (not the "now" data set\'s Europe/Athens), and the open sea is no zone', () => {
    const SPEC_PLACES: Array<[string, number, number, string | null]> = [
      ['Ariel', 32.106, 35.174, 'Asia/Jerusalem'],
      ["Ma'ale Adumim", 31.777, 35.298, 'Asia/Jerusalem'],
      ['Eilat', 29.557, 34.952, 'Asia/Jerusalem'],
      ['Katzrin', 32.993, 35.692, 'Asia/Jerusalem'],
      ['Hebron', 31.532, 35.099, 'Asia/Hebron'],
      ['Gaza', 31.5017, 34.4668, 'Asia/Gaza'],
      ['Kyiv', 50.45, 30.5236, 'Europe/Kyiv'],
      ['New York', 40.7127, -74.006, 'America/New_York'],
      ['the sea off Haifa', 33.0, 34.5, null],
    ];
    captured.length = 0;
    for (const [name, lat, lon, want] of SPEC_PLACES) {
      const got = zones.zoneForCoords(lat, lon);
      assert(got === want, `${name}: ${show(got)}, want ${show(want)}`);
    }
    assert(captured.length === 1 && captured[0].context === 'location-lookup' && captured[0].severity === 'warning', `only the sea is logged: ${show(captured)}`);
  });

  await check('(s) the West Bank rule: Asia/Jerusalem when the map lists it, wherever it is in the list; otherwise the first; nothing for no answer', () => {
    assert(zones.pickZone(['Asia/Jerusalem', 'Asia/Hebron']) === 'Asia/Jerusalem', 'Jerusalem first');
    assert(zones.pickZone(['Asia/Hebron', 'Asia/Jerusalem']) === 'Asia/Jerusalem', 'Jerusalem second');
    assert(zones.pickZone(['Asia/Hebron', 'Asia/Gaza']) === 'Asia/Hebron', 'no Jerusalem: the first');
    assert(zones.pickZone(['Asia/Gaza']) === 'Asia/Gaza', 'one zone');
    assert(zones.pickZone([]) === null, 'no zone');
  });

  await check('(t) the zone map\'s tile cache stays bounded: lookups over the whole world store more tiles than the bound, and at most TILE_CACHE_MAX stay in memory', () => {
    const before = captured.length;
    for (let lat = -60; lat <= 70; lat += 5) for (let lon = -175; lon <= 175; lon += 5) zones.zoneForCoords(lat, lon);
    captured.length = before; // the open-sea warnings are expected here
    const stats = zones.tileCacheStats();
    assert(stats.stored > zones.TILE_CACHE_MAX, `only ${stats.stored} tiles were read: the bound was never reached`);
    assert(stats.size > 0 && stats.size <= zones.TILE_CACHE_MAX, `${stats.size} tiles kept (max ${zones.TILE_CACHE_MAX})`);
  });

  await check('(u) the zone map\'s data file missing from the image (GEO_TZ_DATA_PATH at an empty folder, in a child process): the lookup answers null and reports an error under location-lookup, never a default zone', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'geo-tz-empty-'));
    try {
      // process.execArgv carries tsx's loader flags, so the child compiles TypeScript the same way (as smoke-dst.ts does)
      const run = spawnSync(process.execPath, [...process.execArgv, process.argv[1]], {
        env: { ...process.env, [MISSING_DATA_CHILD]: '1', GEO_TZ_DATA_PATH: empty },
        encoding: 'utf8',
      });
      const last = run.stdout.trim().split('\n').pop() ?? '';
      const out = JSON.parse(last) as { zone: unknown; captured: { context: string; severity: string }[] };
      assert(out.zone === null, `zone ${show(out.zone)}`);
      assert(show(out.captured) === show([{ context: 'location-lookup', severity: 'error' }]), `captured ${show(out.captured)} (stderr ${run.stderr.slice(0, 300)})`);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  await check('(v) the cached path (geocodeLocation / getTimezone, the summaries\' and /weather\'s) takes its zone from the same map with no Asia/Jerusalem fallback: Ariel is Jerusalem, a point at sea has none, and getTimezone rejects it', async () => {
    const Module = nodeRequire('module');
    const file = path.join(ROOT, 'src/services/weather/geocoding.ts');
    const stubbed = Module._cache[file];
    delete Module._cache[file];
    const realFetch = globalThis.fetch;
    let place = { lat: '32.106', lon: '35.174' };
    globalThis.fetch = (async () => json([place])) as typeof fetch;
    const log = console.log;
    console.log = () => {};
    try {
      const real = nodeRequire(file) as {
        geocodeLocation: (location: string) => Promise<{ timezone: string | null }>;
        getTimezone: (location: string) => Promise<string>;
        clearGeocodeCache: () => void;
      };
      real.clearGeocodeCache();
      assert((await real.geocodeLocation('Ariel')).timezone === 'Asia/Jerusalem', 'Ariel');
      place = { lat: '33.0', lon: '34.5' };
      assert((await real.geocodeLocation('Out at sea')).timezone === null, 'the sea point got a zone');
      let rejected = false;
      try { await real.getTimezone('Out at sea'); } catch { rejected = true; }
      assert(rejected, 'getTimezone answered a zone for a place with none');
    } finally {
      console.log = log;
      globalThis.fetch = realFetch;
      delete Module._cache[file];
      Module._cache[file] = stubbed;
    }
  });
```

At the top of the file add the imports and the child mode, and run `main()` only in the parent:

```ts
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

/** Set in the child that runs with the zone map's data folder empty (check u). */
const MISSING_DATA_CHILD = 'ZONE_SMOKE_MISSING_DATA';

/** The child: zoneForCoords with geo-tz pointed at an empty folder. Prints one JSON line: the zone and what was captured. */
function missingDataChild(): void {
  const Module = nodeRequire('module');
  const got: { context: string; severity: string }[] = [];
  const filename = path.join(ROOT, 'src/lib/error-capture.ts');
  const mod = new Module(filename);
  Object.assign(mod, {
    filename, loaded: true, exports: {
      captureError: (_e: unknown, context: string, _x?: unknown, severity: string = 'error') => { got.push({ context, severity }); },
      captureWarning: (_m: string, context: string) => { got.push({ context, severity: 'warning' }); },
      captureInfo: () => {},
    },
  });
  Module._cache[filename] = mod;
  const { zoneForCoords } = nodeRequire(path.join(ROOT, 'src/lib/zone-for-coords.ts')) as { zoneForCoords: (a: number, b: number) => string | null };
  console.log(JSON.stringify({ zone: zoneForCoords(32.0853, 34.7818), captured: got }));
}
```

and replace the closing `main().catch(...)` with:

```ts
if (process.env[MISSING_DATA_CHILD] === '1') {
  missingDataChild();
} else {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
```

(`missingDataChild` uses `nodeRequire` and `ROOT`, already declared at the top of the file; declare it after them.)

- [ ] **Step 1.3: Run the smoke and see it fail**

Run: `$SCRATCH/om-smoke.sh scripts/smoke-location-timezone.ts`
Expected: FAIL, first with `Cannot find module .../src/lib/zone-for-coords.ts` (checks r–u), and (b)/(v) failing because the real code still asks Open-Meteo / defaults to Asia/Jerusalem.

- [ ] **Step 1.4: Write `src/lib/zone-for-coords.ts`**

```ts
/**
 * A place's IANA time zone from its coordinates, on our own server: geo-tz (MIT) over timezone-boundary-builder's map
 * (© OpenStreetMap contributors, ODbL), its default "1970" data set (the "now" set calls Ariel Asia/Gaza and Kyiv
 * Europe/Athens). No network. Spec docs/superpowers/specs/2026-10-31-open-meteo-replacement-design.md §5 (time zone);
 * plan docs/superpowers/plans/2026-10-31-open-meteo-replacement.md, Task 1.
 *
 * - The map overlaps over the Green Line: Ariel and Ma'ale Adumim get Jerusalem, then Hebron. pickZone: Asia/Jerusalem
 *   when it is among the answers, else the first. Hebron, Ramallah and Gaza keep their own zones.
 * - The open sea answers Etc/GMT±n, and a lookup throws when the data file is missing from the image: each is logged
 *   under location-lookup and answers null, never a default zone. No coordinates in a log.
 * - geo-tz caches the map tiles it reads; the cache holds at most TILE_CACHE_MAX of them (the server has 1 GB).
 *
 * Its own leaf module: geocoding.ts and timezone.ts both use it, and timezone.ts imports geocoding.ts (timezone.ts
 * re-exports it). Server only (it reads its data from disk): never in a 'use client' file, the proxy or the edge.
 * next.config.js keeps geo-tz out of the bundle (serverExternalPackages) and its two unused data sets out of the image.
 */

import { find, setCache } from 'geo-tz';
import { LRUCache } from 'lru-cache';
import { captureError, captureWarning } from './error-capture';

/** The most zone-map tiles kept in memory at once: FamCal's places fall in a handful of them. */
export const TILE_CACHE_MAX = 32;

const tiles = new LRUCache<string, object>({ max: TILE_CACHE_MAX });
let stored = 0;
// geo-tz takes any store with get and set (CacheOptions.store); set at load, before any lookup.
setCache({
  store: {
    get: (key: string) => tiles.get(key),
    set: (key: string, value: object) => {
      stored++;
      tiles.set(key, value);
    },
  },
});

/** The tiles in memory now, and how many were ever read from disk (the smoke's memory bound). */
export function tileCacheStats(): { size: number; stored: number } {
  return { size: tiles.size, stored };
}

/** True when Intl accepts `zone` as an IANA zone. */
function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false; // Intl's RangeError is the answer, not a failure to report
  }
}

/** The zone the West Bank rule picks from the map's answers: Asia/Jerusalem when listed, else the first; null for none. */
export function pickZone(zones: readonly string[]): string | null {
  if (zones.includes('Asia/Jerusalem')) return 'Asia/Jerusalem';
  return zones[0] ?? null;
}

/**
 * The IANA zone at the coordinates, or null (logged under location-lookup) when the map throws (an error: its data is
 * missing), has no zone, puts the place at sea (Etc/…) or answers a zone Intl does not know (warnings). Sync and local.
 */
export function zoneForCoords(latitude: number, longitude: number): string | null {
  const context = { service: 'timezone' };
  let zones: string[];
  try {
    zones = find(latitude, longitude);
  } catch (error) {
    captureError(error, 'location-lookup', context);
    return null;
  }
  const zone = pickZone(zones);
  if (zone === null) {
    captureWarning('The zone map has no zone for the place', 'location-lookup', context);
    return null;
  }
  if (zone.startsWith('Etc/')) {
    captureWarning(`The zone map puts the place at sea (${zone}): no zone`, 'location-lookup', context);
    return null;
  }
  if (!isValidTimeZone(zone)) {
    captureWarning(`The zone map's ${zone} is not a zone Intl knows`, 'location-lookup', context);
    return null;
  }
  return zone;
}
```

- [ ] **Step 1.5: Move `src/lib/timezone.ts` onto it**

Imports and constants (lines 6-26) become:

```ts
import { redis } from '@/src/utils/redis';
import { TIMEZONE } from '../config/constants';
import { REDIS_KEYS } from '../config/redis-keys';
import { getUserCalendarTimezone } from '../services/calendar';
import { fetchWithTimeout, geocodeLocation } from '../services/weather/geocoding';
import { captureError, captureInfo, captureWarning } from './error-capture';
import { zoneForCoords } from './zone-for-coords';

// A place's zone from its coordinates: one function, in a leaf module so geocoding.ts can use it without importing this
// file (which imports geocoding.ts). Re-exported here.
export { pickZone, zoneForCoords } from './zone-for-coords';

/** How long a resolved zone stays in Redis (resolveUserTimezone, and a saved location's). */
export const TIMEZONE_CACHE_TTL = 24 * 60 * 60; // 24 hours in seconds
/** Nominatim's lookup of a place waits this long, with no retry (spec 2026-10-31 §7 leaves it as it is). */
export const LOOKUP_TIMEOUT_MS = 3000;
```

(Delete `isValidTimeZone`: it moved to the leaf.) `ResolvedLocation.timezone`'s doc: `/** The zone our map gives the coordinates (zoneForCoords); null when it has none (at sea) or its data is missing, logged there. */`. `resolveLocation`'s doc:

```ts
/**
 * A place looked up fresh: one Nominatim request for the place (its coordinates and bounding box, 3 s, no retry), and
 * its zone from our own map (zoneForCoords). Unlike geocodeLocation it neither reads nor fills the in-process geocode
 * cache. Null when Nominatim fails or does not find the place; the zone alone is null when the map has none, as the
 * coordinates are good without it. Every failure is logged (never with the place's name). Never throws.
 */
```

In its body, `const timezone = await lookUpZone(latitude, longitude);` becomes `const timezone = zoneForCoords(latitude, longitude);`. Delete `lookUpZone` (lines 84-101). `resolveTimezoneForLocation`'s doc: "Null when Nominatim fails, the place is not found, or the map has no zone for it." `TZ_LOOKUP_MS`'s doc: replace "asks Nominatim and Open-Meteo, or Google's settings" with "asks Nominatim, or Google's settings".

- [ ] **Step 1.6: Move `src/services/weather/geocoding.ts` onto it**

Header comment: "Converts location strings to coordinates and timezone. Uses Nominatim (OpenStreetMap) for the coordinates and our own zone map (zoneForCoords) for the zone." Add `import { zoneForCoords } from '../../lib/zone-for-coords';`. Then:

```ts
export interface GeoLocation extends Coordinates {
  /** The zone our map gives the coordinates (zoneForCoords); null when it has none, logged there. Never a default. */
  timezone: string | null;
}
```

In `geocodeLocation` replace the Open-Meteo comment and call with:

```ts
    // The zone from our own map; null (logged there) for a point at sea, never Asia/Jerusalem by default
    const timezone = zoneForCoords(latitude, longitude);
```

Delete `getTimezoneFromCoords` (lines 97-116). Replace `getTimezone`:

```ts
/**
 * The zone of a location (geocodeLocation's). Rejects when the place has none (the zone lookup logged why): a caller
 * never falls back to another zone's clock.
 */
export async function getTimezone(location: string): Promise<string> {
  const { timezone } = await geocodeLocation(location);
  if (!timezone) throw new Error('No time zone for the place (the zone lookup logged why)');
  return timezone;
}
```

(`commands.ts` and the sign route still swallow this with an Asia/Jerusalem default until Task 3 removes those two catches.)

- [ ] **Step 1.7: Keep geo-tz out of the bundle (`next.config.js`)**

Replace lines 10-11 with:

```js
  // Kept out of the bundle: opusscript loads a .wasm binary from disk at runtime, and geo-tz reads its zone map from its
  // own data/ folder (bundled, it looks in the wrong folder and throws ENOENT)
  serverExternalPackages: ['opusscript', '@resvg/resvg-js', 'geo-tz'],

  // geo-tz ships three zone maps; FamCal reads only the default "1970" one (src/lib/zone-for-coords.ts), so the other two
  // (46 MB) stay out of the image
  outputFileTracingExcludes: {
    '/*': ['./node_modules/geo-tz/data/timezones-now.*', './node_modules/geo-tz/data/timezones.geojson.*'],
  },
```

- [ ] **Step 1.8: Drop the zone stubs from the other smokes**

- `scripts/smoke-zmanim.ts`: in `Answers` drop `zone`; in `seedAnswers` drop `zone: …`; in `fakeFetchWithTimeout` delete `if (parsed.host === 'api.open-meteo.com') return answers.zone();`. The saved-location check (line ~839): name "one Nominatim and one elevation request, the zone from our map"; `shape()` expected `['nominatim.openstreetmap.org 3000/0', 'api.open-meteo.com/elevation 3000/0']`. Every `nRequests() === 3` for one full lookup becomes `=== 2` (lines ~917-937, ~979-996). The check "the zone request failing still saves…" (line ~875) becomes:

```ts
  await check('a place the zone map puts at sea still saves its coordinates and leaves the cached zone alone; Nominatim finding nothing writes nothing and asks for no elevation', async () => {
    resetWorld();
    userRow(7, 'Harish, Israel');
    stubbed.redis.set('tz:user:7', 'Europe/London');
    answers.nominatim = () => json([{ lat: '33.0', lon: '34.5', boundingbox: HARISH_BOX }]);
    const saved = await place.saveUserPlace(7, 'Harish, Israel');
    assert(saved !== null && saved.timeZone === null && saved.latitude === 33, `saved ${show(saved)}`);
    assert(nWrites() === 1 && nRedisSets() === 0 && stubbed.redis.get('tz:user:7') === 'Europe/London', 'coordinates written, zone untouched');
    // …the old check's second half ("Nominatim finding nothing", from its second resetWorld()) unchanged
  });
```

(`userRow`, `resetWorld`, `logged`, `nWrites`, `nRedisSets` are the file's own helpers.)
- `scripts/smoke-pause.ts:135` and `scripts/smoke-zmanim-api.ts:156`: delete the `if (parsed.host === 'api.open-meteo.com') return json({ timezone: … })` line (Harish's coordinates give Asia/Jerusalem from the real map). Keep their `/v1/elevation` branch until Task 2.
- `scripts/smoke-calendar-range.ts:837`: delete the `api.open-meteo.com` line (Nominatim's Moscow point gives Europe/Moscow from the real map); in its header comment (line 13) replace "Nominatim and Open-Meteo for the timezone resolver" with "Nominatim for the timezone resolver".

- [ ] **Step 1.9: Run the smokes and see them pass**

Run: `$SCRATCH/om-smoke.sh scripts/smoke-location-timezone.ts scripts/smoke-zmanim.ts scripts/smoke-pause.ts scripts/smoke-zmanim-api.ts scripts/smoke-calendar-range.ts scripts/smoke-timezone-inflight.ts scripts/smoke-reminders.ts`
Then: `TZ_OVERRIDE=UTC $SCRATCH/om-smoke.sh scripts/smoke-location-timezone.ts scripts/smoke-zmanim.ts`
Expected: every file prints `N/N passed`; (u) shows the child's zone null with one error.

- [ ] **Step 1.10: Prove the new checks bite** (verification-before-completion): temporarily change `pickZone` to `return zones[0] ?? null;` → (r) and (s) fail on Ariel/Ma'ale Adumim; restore. Temporarily change `geocodeLocation` to `zoneForCoords(...) ?? 'Asia/Jerusalem'` → (v) fails; restore. Temporarily set `max: 100000` on the LRU → (t) fails; restore.

- [ ] **Step 1.11: Gate and fresh build**

```bash
npx tsc --noEmit && npm run lint && bash scripts/ci-smokes.sh && npx next build
```
(`ci-smokes.sh` under Node 22: `PATH="$(dirname "$(npx -y node@22 -p process.execPath)"):$PATH" bash scripts/ci-smokes.sh`.) Expected: all pass. Then commit (Step 1.12) and run `$SCRATCH/fresh-build.sh`: expected `geo-tz from standalone: [ 'Asia/Jerusalem', 'Asia/Hebron' ]`, only `timezones-1970.*` under `geo-tz/data`, `FRESH BUILD OK`. If `outputFileTracingExcludes` with `'/*'` leaves an unused set in, change the key to `'/**/*'` and rebuild.

- [ ] **Step 1.12: Commit**

```bash
git add package.json package-lock.json next.config.js src/lib/zone-for-coords.ts src/lib/timezone.ts src/services/weather/geocoding.ts scripts/smoke-location-timezone.ts scripts/smoke-zmanim.ts scripts/smoke-pause.ts scripts/smoke-zmanim-api.ts scripts/smoke-calendar-range.ts
git commit -m "feat(zone): a place's zone from geo-tz on our server, no Open-Meteo, no Jerusalem fallback

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31"
```

---

### Task 2: Heights in Israel from a stored map

**Files:**
- Create: `src/services/zmanim/height-map.ts`, `src/services/zmanim/heights.ts`, `scripts/lib/glo90.ts`, `scripts/build-israel-heights.ts`, `data/israel-heights-3s.i16.br` (generated)
- Modify: `scripts/build-city-heights.ts:19-101` (its tile reader moves to `scripts/lib/glo90.ts`), `src/services/zmanim/place.ts:1-124`, `src/services/zmanim/elevation-grid.ts:8`, `next.config.js`, `prisma/schema.prisma:62` (comment only, no migration)
- Test: `scripts/smoke-zmanim.ts`, `scripts/smoke-location-timezone.ts`, `scripts/smoke-pause.ts`, `scripts/smoke-zmanim-api.ts`

**Interfaces:**
- Consumes: `ResolvedLocation.timezone` from `zoneForCoords` (Task 1) for the Israel gate; `inIsrael` (`src/utils/locale-rules.ts`).
- Produces:
  - `NO_HEIGHT = -32768`, `interface HeightMap { rows; cols; north; west; cell; heights: Int16Array }`, `encodeHeightMap(map): Buffer`, `decodeHeightMap(raw: Buffer): HeightMap`, `heightAt(map, latitude, longitude): number | null` (height-map.ts).
  - `HEIGHT_MAP_PATH`, `highestHeight(points: readonly Coordinates[]): number | null` (throws when the file can't be read), `heightMapLoads(): number` (heights.ts).
  - `fetchHighestElevation(points, userId): number | null` (place.ts, now sync).

- [ ] **Step 2.1: Write the failing checks in `scripts/smoke-zmanim.ts`**

Stub the loader for the flow checks (in `installStubs()`), so the save-place checks keep their fake terrain:

```ts
  // The stored height map, for the flow checks: rising ground, the highest of N points is 265 + N (290 for 25).
  stub('src/services/zmanim/heights.ts', {
    highestHeight: (points: unknown[]) => {
      heightReads.push(points.length);
      return terrain(points);
    },
  });
```

with, near the other world state:

```ts
/** The points of each height read the flow checks made. */
const heightReads: number[] = [];
/** What the stored map answers in a flow check: rising ground by default, or a scenario's null or throw. */
let terrain: (points: unknown[]) => number | null = points => 265 + points.length;
```

(`resetWorld()` empties `heightReads` and resets `terrain` to the default.) Delete the `/v1/elevation` branch of `fakeFetchWithTimeout` and `answers.elevation`.

Changed checks:
- The saved-location check: name "one Nominatim request (3 s, no retry), the zone from our map, the height from the stored map: the HIGHEST of the 25 points is stored once…"; `shape()` expected `['nominatim.openstreetmap.org 3000/0']`; replace the two `elevationRequest()` lines with `assertSame(heightReads, [25], 'one read of the 25 points');`. The rest (290, the write, the zone cached, the log) stays.
- "the elevation request failing never blocks saving the place": becomes

```ts
  await check('the height map failing never blocks saving the place: no point on the map (a warning) or the file unreadable (an error) each keeps the coordinates with a null elevation, caches the zone and logs under zmanim-elevation', async () => {
    for (const [name, answer, kind] of [
      ['no point on the map', () => null, 'warning'],
      ['the file unreadable', () => { throw new Error('ENOENT: no such file or directory'); }, 'error'],
    ] as const) {
      resetWorld();
      userRow(7, 'Harish, Israel');
      terrain = answer;
      const saved = await place.saveUserPlace(7, 'Harish, Israel');
      assertSame(saved, { latitude: 32.46182, longitude: 35.04555, elevationM: null, timeZone: 'Asia/Jerusalem' }, `${name}: the place is kept`);
      assertSame(writes.map(w => w.data), [{ latitude: 32.46182, longitude: 35.04555, elevationM: null }], `${name}: coordinates written with a null elevation`);
      assert(nRedisSets() === 1, `${name}: the zone is still cached`);
      assert(nCaptured() === 1 && captured[0].kind === kind && captured[0].context === 'zmanim-elevation', `${name}: logged ${show(captured)}`);
    }
  });
```

- The sea-point check from Task 1: its place is not Israeli, so `saved.elevationM === null` and `heightReads.length === 0` ("no height is read where it is not used").
- Every `nRequests() === 2` for one full lookup becomes `=== 1`; the retry check ("a place saved in Israel without a height … looked up again") sets `terrain = () => null` where it set `answers.elevation = () => json({ error: true }, 503)`, and `terrain = points => 265 + points.length` where it let the elevation answer again; its request counts drop by one per lookup.

New checks:

```ts
  /** The real module behind a stubbed one: loaded around the stub, which is put back. */
  const loadReal = <T>(rel: string): T => {
    const file = path.join(ROOT, rel);
    const stubbedModule = internals._cache[file];
    delete internals._cache[file];
    try {
      return nodeRequire(file) as T;
    } finally {
      internals._cache[file] = stubbedModule;
    }
  };

  await check('the height file\'s layout: a small map round-trips through encode and decode (sea, the Dead Sea, a hilltop, and row deltas that wrap 16 bits), and heightAt reads the cell that holds a point, null off the map or on a cell with no height', () => {
    const hm = nodeRequire(path.join(ROOT, 'src/services/zmanim/height-map.ts')) as typeof import('../src/services/zmanim/height-map');
    const map = { rows: 3, cols: 4, north: 33, west: 35, cell: 0.5, heights: Int16Array.from([hm.NO_HEIGHT, 0, -430, 32767, 32767, hm.NO_HEIGHT, 741, 1, -32767, 32767, 12, 13]) };
    const back = hm.decodeHeightMap(hm.encodeHeightMap(map));
    assertSame([back.rows, back.cols, back.north, back.west, back.cell, Array.from(back.heights)], [3, 4, 33, 35, 0.5, Array.from(map.heights)], 'round trip');
    assertSame(hm.heightAt(back, 32.99, 36.99), 32767, 'the north-east cell');
    assertSame(hm.heightAt(back, 32.4, 36.1), 741, 'row 1, column 2');
    assertSame(hm.heightAt(back, 32.9, 35.1), null, 'a cell with no height');
    assertSame(hm.heightAt(back, 33.01, 35.1), null, 'north of the map');
    assertSame(hm.heightAt(back, 31.4, 35.1), null, 'south of the map');
    assertSame(hm.heightAt(back, 32.9, 37.01), null, 'east of the map');
    let refused = false;
    try { hm.decodeHeightMap(Buffer.from('not a height map at all, really')); } catch { refused = true; }
    assert(refused, 'decoded a file that is not a height map');
  });

  await check('the Israel height map (data/israel-heights-3s.i16.br, Copernicus GLO-90): Jerusalem 741 m, 32.8 N 35.5 E 41 m and 31.2 N 35.1 E 467 m as Open-Meteo read the same pixels; points off the map, in the sea\'s missing tile and no points read nothing; the file is read from disk once', () => {
    const real = loadReal<{ highestHeight: (points: { latitude: number; longitude: number }[]) => number | null; heightMapLoads: () => number }>('src/services/zmanim/heights.ts');
    assertSame(real.highestHeight([{ latitude: 31.7768, longitude: 35.2358 }]), 741, 'Jerusalem');
    assertSame(real.highestHeight([{ latitude: 32.8, longitude: 35.5 }]), 41, '32.8 N 35.5 E');
    assertSame(real.highestHeight([{ latitude: 31.2, longitude: 35.1 }]), 467, '31.2 N 35.1 E');
    assertSame(real.highestHeight([{ latitude: 40.7127, longitude: -74.006 }]), null, 'New York');
    assertSame(real.highestHeight([{ latitude: 33.3, longitude: 34.5 }]), null, 'the sea tile N33 E034 GLO-90 does not have');
    assertSame(real.highestHeight([]), null, 'no points');
    assertSame(real.highestHeight([{ latitude: 40.7127, longitude: -74.006 }, { latitude: 31.7768, longitude: 35.2358 }]), 741, 'a point off the map is skipped');
    assertSame(real.heightMapLoads(), 1, 'reads of the file');
  });
```

(`internals` and `nodeRequire` are the file's own; if `nodeRequire` is not declared there, add `const nodeRequire = createRequire(__filename);` with `import { createRequire } from 'node:module';`.)

- [ ] **Step 2.2: Run it and see it fail**

Run: `$SCRATCH/om-smoke.sh scripts/smoke-zmanim.ts`
Expected: FAIL: `Cannot find module …/height-map.ts`, the saved-location check still sees the elevation request.

- [ ] **Step 2.3: Write `src/services/zmanim/height-map.ts`**

```ts
// The Israel height map's file layout (data/israel-heights-3s.i16.br): written once by scripts/build-israel-heights.ts,
// read by heights.ts. Pure (node:buffer only), so the script, the loader and the smoke share one encoder and decoder.
// Plan docs/superpowers/plans/2026-10-31-open-meteo-replacement.md, Task 2.
//
// The file is brotli over: a 36-byte header, then rows x cols heights in whole metres (int16, little-endian), row by
// row from the north-west corner, each row stored as its difference from the row above (wrapping at 16 bits; the first
// row as it is), which brotli packs far better than plain heights.
//   offset  0  'FCHM'          magic
//   offset  4  uint16  1       version
//   offset  6  uint16  rows
//   offset  8  uint16  cols
//   offset 10  uint16  0       reserved
//   offset 12  float64 north   the north edge of row 0, in degrees (a GLO-90 pixel edge)
//   offset 20  float64 west    the west edge of column 0, in degrees (a GLO-90 pixel edge)
//   offset 28  float64 cell    a cell's side in degrees (1/1200: GLO-90's 3 arc-seconds)
// NO_HEIGHT marks a cell with no height: the sea where GLO-90 has no tile, or a void pixel.

/** A cell with no height. */
export const NO_HEIGHT = -32768;
const MAGIC = 'FCHM';
const VERSION = 1;
export const HEADER_BYTES = 36;

export interface HeightMap {
  rows: number;
  cols: number;
  /** The north edge of row 0 and the west edge of column 0, in degrees. */
  north: number;
  west: number;
  /** A cell's side in degrees. */
  cell: number;
  /** rows x cols whole metres, row-major from the north-west corner; NO_HEIGHT where there is none. */
  heights: Int16Array;
}

/** The file's bytes before brotli: the header, then the row-delta heights. */
export function encodeHeightMap(map: HeightMap): Buffer {
  const { rows, cols, heights } = map;
  if (heights.length !== rows * cols) throw new Error(`[heights] ${heights.length} heights for a ${rows} x ${cols} map`);
  const out = Buffer.alloc(HEADER_BYTES + rows * cols * 2);
  out.write(MAGIC, 0, 'latin1');
  out.writeUInt16LE(VERSION, 4);
  out.writeUInt16LE(rows, 6);
  out.writeUInt16LE(cols, 8);
  out.writeUInt16LE(0, 10);
  out.writeDoubleLE(map.north, 12);
  out.writeDoubleLE(map.west, 20);
  out.writeDoubleLE(map.cell, 28);
  for (let i = 0; i < rows * cols; i++) {
    const above = i >= cols ? heights[i - cols] : 0;
    out.writeInt16LE(((heights[i] - above) << 16) >> 16, HEADER_BYTES + i * 2);
  }
  return out;
}

/** The map from the file's bytes after brotli. Throws on bytes that are not one. */
export function decodeHeightMap(raw: Buffer): HeightMap {
  if (raw.length < HEADER_BYTES || raw.toString('latin1', 0, 4) !== MAGIC) throw new Error('[heights] not a FamCal height map');
  const version = raw.readUInt16LE(4);
  if (version !== VERSION) throw new Error(`[heights] height map version ${version}, this code reads ${VERSION}`);
  const rows = raw.readUInt16LE(6);
  const cols = raw.readUInt16LE(8);
  if (raw.length !== HEADER_BYTES + rows * cols * 2) throw new Error(`[heights] ${raw.length} bytes for a ${rows} x ${cols} map`);
  const heights = new Int16Array(rows * cols);
  for (let i = 0; i < rows * cols; i++) {
    const delta = raw.readInt16LE(HEADER_BYTES + i * 2);
    heights[i] = i >= cols ? ((delta + heights[i - cols]) << 16) >> 16 : delta;
  }
  return { rows, cols, north: raw.readDoubleLE(12), west: raw.readDoubleLE(20), cell: raw.readDoubleLE(28), heights };
}

/** The height of the cell that holds the point, in metres; null off the map or on a cell with none. */
export function heightAt(map: HeightMap, latitude: number, longitude: number): number | null {
  const row = Math.floor((map.north - latitude) / map.cell);
  const col = Math.floor((longitude - map.west) / map.cell);
  if (!(row >= 0 && row < map.rows && col >= 0 && col < map.cols)) return null;
  const metres = map.heights[row * map.cols + col];
  return metres === NO_HEIGHT ? null : metres;
}
```

- [ ] **Step 2.4: Write `src/services/zmanim/heights.ts`**

```ts
// The highest ground of a place in Israel from the stored height map (data/israel-heights-3s.i16.br): the Copernicus
// DEM GLO-90 pixels Open-Meteo's elevation API read, so the answers are what they were, to the metre. Read from disk on
// first use and kept for the process on globalThis (Next 16 gives the scheduler and the routes separate module
// instances): about 21 MB, outside the JS heap. No network. Server only. Plan Task 2.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { decodeHeightMap, heightAt, type HeightMap } from './height-map';
import type { Coordinates } from './elevation-grid';

/** Where the map is: the repo's data/ folder (next.config.js traces it into the standalone image). */
export const HEIGHT_MAP_PATH = path.join(process.cwd(), 'data', 'israel-heights-3s.i16.br');

const shared = globalThis as { __israelHeightMap?: HeightMap; __israelHeightMapLoads?: number };

function heightMap(): HeightMap {
  if (!shared.__israelHeightMap) {
    const started = performance.now();
    const map = decodeHeightMap(zlib.brotliDecompressSync(fs.readFileSync(HEIGHT_MAP_PATH)));
    shared.__israelHeightMap = map;
    shared.__israelHeightMapLoads = (shared.__israelHeightMapLoads ?? 0) + 1;
    console.log(`[heights] the Israel height map is loaded: ${map.rows} x ${map.cols} cells in ${Math.round(performance.now() - started)} ms`);
  }
  return shared.__israelHeightMap;
}

/**
 * The highest of the points' heights on the map, in whole metres; a point off the map or over the sea is skipped, and
 * null when none is left. Throws what reading or decoding the file throws (the caller logs it).
 */
export function highestHeight(points: readonly Coordinates[]): number | null {
  const map = heightMap();
  let highest: number | null = null;
  for (const point of points) {
    const metres = heightAt(map, point.latitude, point.longitude);
    if (metres !== null && (highest === null || metres > highest)) highest = metres;
  }
  return highest;
}

/** How many times this process read the map from disk (1 after any use). */
export function heightMapLoads(): number {
  return shared.__israelHeightMapLoads ?? 0;
}
```

- [ ] **Step 2.5: Share the GLO-90 tile reader (`scripts/lib/glo90.ts`)**

Move `TILES`, `pause`, `withRetry`, `tiles`, `tileName` and `tile` (build-city-heights.ts lines 38, 46, 74-101) into `scripts/lib/glo90.ts` unchanged except: the log prefix becomes `[glo90]`, `tile` is exported as `openTile`, and add `openTileOrNull`:

```ts
// The Copernicus DEM GLO-90 tiles in AWS's public bucket (no account; one 1 x 1 degree COG per tile,
// Copernicus_DSM_COG_30_N<lat>_00_E<lon>_00_DEM), read with geotiff (a devDependency: scripts only, never the app).
// Shared by scripts/build-city-heights.ts and scripts/build-israel-heights.ts.

import { fromUrl, type GeoTIFFImage } from 'geotiff';
import type { Coordinates } from '../../src/services/zmanim/elevation-grid';

export const TILES = 'https://copernicus-dem-90m.s3.amazonaws.com';

export const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A network step that failed for no fault of the request (a reset, a closed socket): tried again after 2, 4 and 8 s. */
export async function withRetry<T>(what: string, step: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await step();
    } catch (error) {
      if (attempt === 4) throw error;
      console.warn(`[glo90] ${what} failed (attempt ${attempt}), trying again:`, error instanceof Error ? error.message : error);
      await pause(1000 * 2 ** attempt);
    }
  }
}

const tiles = new Map<string, GeoTIFFImage>();

/** The name of the GLO-90 tile that holds `point` (north and east only). */
export function tileName(point: Coordinates): string {
  if (point.latitude < 0 || point.longitude < 0) throw new Error(`no tile rule for ${point.latitude},${point.longitude}`);
  return `Copernicus_DSM_COG_30_N${String(Math.floor(point.latitude)).padStart(2, '0')}_00_E${String(Math.floor(point.longitude)).padStart(3, '0')}_00_DEM`;
}

/** A tile, opened once. */
export async function openTile(name: string): Promise<GeoTIFFImage> {
  const known = tiles.get(name);
  if (known) return known;
  const image = await withRetry(`opening ${name}`, async () => (await fromUrl(`${TILES}/${name}/${name}.tif`)).getImage());
  tiles.set(name, image);
  return image;
}

/** A tile, or null where GLO-90 has none (all sea: the bucket answers 404). */
export async function openTileOrNull(name: string): Promise<GeoTIFFImage | null> {
  const head = await withRetry(`asking for ${name}`, () => fetch(`${TILES}/${name}/${name}.tif`, { method: 'HEAD' }));
  if (head.status === 404) return null;
  if (!head.ok) throw new Error(`${name}: the bucket answered ${head.status}`);
  return openTile(name);
}
```

In `build-city-heights.ts` delete the moved code and import it: `import { openTile, tileName, withRetry } from './lib/glo90';` (`pause` too, for `searchBox`); `heightsAt` calls `openTile(name)` where it called `tile(name)`. Behaviour unchanged; it is a dev script (no CI run), so check it type-checks only.

- [ ] **Step 2.6: Write `scripts/build-israel-heights.ts`**

```ts
// The Israel height map, data/israel-heights-3s.i16.br (spec 2026-10-31-open-meteo-replacement §5, "Height"): every
// Copernicus DEM GLO-90 pixel over Israel, 29.4-33.5 N and 34.2-35.95 E (Eilat to the Hermon and the Golan): the pixels
// Open-Meteo's elevation API read, so the bot's heights stay what they were, to the metre. Layout: height-map.ts.
//
// Run once, on a developer machine, never in CI or at runtime; the file it writes is committed:
//   npx tsx scripts/build-israel-heights.ts
//
// - The 10 tiles N29-N33 x E034-E035, each read whole (a few MB each); N33 E034 is all sea and does not exist (404), so
//   its cells have no height.
// - The map's edges are GLO-90 pixel edges (read from the tiles' own origin), so each cell is exactly one pixel and a
//   point falls in the cell of the pixel that holds it, as build-city-heights.ts and Open-Meteo read it.
// - It stops with nothing written when a tile is not 1200 x 1200 at 3 arc-seconds, the round trip differs, or a check
//   point reads another height than Open-Meteo answered (the research's parity probe: Jerusalem 741 m, 32.8 N 35.5 E
//   41 m, 31.2 N 35.1 E 467 m).

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { NO_HEIGHT, decodeHeightMap, encodeHeightMap, heightAt } from '../src/services/zmanim/height-map';
import { openTileOrNull, tileName, withRetry } from './lib/glo90';

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'data/israel-heights-3s.i16.br');
const BOX = { south: 29.4, north: 33.5, west: 34.2, east: 35.95 };
const CELL = 1 / 1200;
const SIDE = 1200;
const CHECKS = [
  { latitude: 31.7768, longitude: 35.2358, metres: 741 },
  { latitude: 32.8, longitude: 35.5, metres: 41 },
  { latitude: 31.2, longitude: 35.1, metres: 467 },
];

type Tile = { originX: number; originY: number; band: ArrayLike<number> };

async function main(): Promise<void> {
  const tiles = new Map<string, Tile | null>();
  for (let lat = Math.floor(BOX.south); lat <= Math.floor(BOX.north); lat++) {
    for (let lon = Math.floor(BOX.west); lon <= Math.floor(BOX.east); lon++) {
      const name = tileName({ latitude: lat + 0.5, longitude: lon + 0.5 });
      const image = await openTileOrNull(name);
      if (!image) {
        tiles.set(name, null);
        console.log(`[israel-heights] ${name}: none (sea)`);
        continue;
      }
      const [resX, resY] = image.getResolution();
      if (image.getWidth() !== SIDE || image.getHeight() !== SIDE || Math.abs(resX - CELL) > 1e-12 || Math.abs(resY + CELL) > 1e-12) {
        throw new Error(`${name} is ${image.getWidth()} x ${image.getHeight()} at ${resX}, ${resY}: not GLO-90's 3 arc-seconds`);
      }
      const [originX, originY] = image.getOrigin();
      const [band] = (await withRetry(`reading ${name}`, () => image.readRasters())) as unknown as [ArrayLike<number>];
      tiles.set(name, { originX, originY, band });
      console.log(`[israel-heights] ${name}: read`);
    }
  }

  // Every tile's pixel grid sits the same fraction of a pixel off the whole degree: the map's edges follow it.
  const first = [...tiles.values()].find((t): t is Tile => t !== null);
  if (!first) throw new Error('no tile was read');
  const offsetY = first.originY - Math.round(first.originY);
  const offsetX = first.originX - Math.round(first.originX);
  const north = Math.ceil((BOX.north - offsetY) / CELL) * CELL + offsetY;
  const west = Math.floor((BOX.west - offsetX) / CELL) * CELL + offsetX;
  const rows = Math.ceil((north - BOX.south) / CELL);
  const cols = Math.ceil((BOX.east - west) / CELL);

  /**
   * The height of the pixel that holds a point: in its own degree's tile, or a neighbouring one where the grid's
   * sub-pixel offset puts it there. Null over the sea (a tile GLO-90 does not have) or on a void pixel.
   */
  const pixel = (latitude: number, longitude: number): number | null => {
    for (const dLat of [0, -1, 1]) {
      for (const dLon of [0, -1, 1]) {
        const t = tiles.get(tileName({ latitude: Math.floor(latitude) + dLat + 0.5, longitude: Math.floor(longitude) + dLon + 0.5 }));
        if (!t) continue; // not one of the tiles read, or a tile GLO-90 does not have
        const x = Math.floor((longitude - t.originX) / CELL);
        const y = Math.floor((t.originY - latitude) / CELL);
        if (x < 0 || x >= SIDE || y < 0 || y >= SIDE) continue;
        const m = t.band[y * SIDE + x];
        return Number.isFinite(m) && m > -1000 ? Math.round(m) : null;
      }
    }
    return null;
  };

  const heights = new Int16Array(rows * cols).fill(NO_HEIGHT);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const metres = pixel(north - (r + 0.5) * CELL, west + (c + 0.5) * CELL);
      if (metres !== null) heights[r * cols + c] = metres;
    }
  }
  const map = { rows, cols, north, west, cell: CELL, heights };
  const raw = encodeHeightMap(map);
  const packed = zlib.brotliCompressSync(raw, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
      [zlib.constants.BROTLI_PARAM_LGWIN]: 24,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
    },
  });
  const back = decodeHeightMap(zlib.brotliDecompressSync(packed));
  if (back.rows !== rows || back.cols !== cols || !back.heights.every((m, i) => m === heights[i])) throw new Error('the round trip differs');
  for (const check of CHECKS) {
    const got = heightAt(back, check.latitude, check.longitude);
    if (got !== check.metres) throw new Error(`${check.latitude},${check.longitude} reads ${got} m, Open-Meteo answered ${check.metres} m`);
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, packed);
  console.log(`[israel-heights] wrote ${path.relative(ROOT, OUT)}: ${rows} x ${cols} cells, ${(packed.length / 1e6).toFixed(2)} MB (north ${north}, west ${west})`);
}

main().catch((error: unknown) => {
  console.error('[israel-heights] stopped, nothing written:', error);
  process.exit(1);
});
```

- [ ] **Step 2.7: Build the file**

Run: `npx tsx scripts/build-israel-heights.ts` (downloads ~10 public tiles from AWS; dev step, not a test).
Expected: `wrote data/israel-heights-3s.i16.br: 4920 x 2100 cells` (± one row or column from the grid offset), about 5.2 MB. If a check point is off by a pixel, do not loosen the check: inspect the tiles' `getOrigin()` and fix the edge formula.

- [ ] **Step 2.8: Read the map in `src/services/zmanim/place.ts`**

Header comment: replace "sampled with Open-Meteo's free elevation API in one request; the highest of the 25 is kept. A failure of that request is logged and leaves the elevation null" with "read from the stored Israel height map (heights.ts, Copernicus GLO-90); the highest of the 25 is kept. It is read only for a place whose zone is Israel's, the only places whose height is used (compute.ts); a failure is logged and leaves the elevation null"; replace "The lookups are resolveLocation's (src/lib/timezone.ts) and the same 3 s, no-retry policy." with "The place lookup is resolveLocation's (src/lib/timezone.ts): Nominatim, 3 s, no retry; the zone and the height are local." Imports: drop `LOOKUP_TIMEOUT_MS` and the `fetchWithTimeout` import; add `import { highestHeight } from './heights';`. Replace `fetchHighestElevation`:

```ts
/**
 * The highest ground among `points`, in whole metres, from the stored Israel height map (heights.ts). Null, and logged
 * under zmanim-elevation, when no point is on the map (a warning) or the map can't be read (an error): the place is
 * kept without an elevation.
 */
export function fetchHighestElevation(points: Coordinates[], userId: number): number | null {
  const context = { service: 'zmanim', user_id: userId };
  try {
    const metres = highestHeight(points);
    if (metres === null) captureWarning('No point of the place is on the Israel height map: the place is kept without an elevation', 'zmanim-elevation', context);
    return metres;
  } catch (error) {
    captureError(error, 'zmanim-elevation', context);
    return null;
  }
}
```

In `saveUserPlace` replace the two lines `const points = …; const elevationM = await fetchHighestElevation(points, userId);` with:

```ts
  // The height is read only where it is used: the Sephardi times in Israel (compute.ts). Abroad the place has none.
  const israeli = resolved.timezone !== null && inIsrael(resolved.timezone);
  const points = israeli ? elevationGrid(resolved, resolved.boundingBox) : [];
  const elevationM = israeli ? fetchHighestElevation(points, userId) : null;
```

and the log line's height part with `${israeli ? `${elevationM === null ? 'unknown' : `${elevationM} m`} over ${points.length} point(s)` : 'not read (abroad)'}`. `retryMissingElevation` stays as it is (spec: the hourly fill stays).

`src/services/zmanim/elevation-grid.ts:8`: the comment becomes `/** The grid is this many points on a side: 5 x 5 = 25 lookups in the stored height map. */`. `prisma/schema.prisma:62`: the comment becomes `// Highest point in the place, metres (the Israel height map, Copernicus GLO-90); null = unknown or abroad, read as sea level` (comment only: no migration).

- [ ] **Step 2.9: Trace the file (`next.config.js`)**, after `outputFileTracingExcludes`:

```js
  // The Israel height map (src/services/zmanim/heights.ts reads it from data/ at run time): traced into the standalone image
  outputFileTracingIncludes: {
    '/*': ['./data/israel-heights-3s.i16.br'],
  },
```

- [ ] **Step 2.10: Move the other smokes onto the heights stub**

- `scripts/smoke-location-timezone.ts`: delete `elevation` from `answers` and its host branch; add `stub('src/services/zmanim/heights.ts', { highestHeight: (points: { latitude: number; longitude: number }[]) => { heightReads.push(points); return ELEVATION_MAX; } });` with `const heightReads: { latitude: number; longitude: number }[][] = [];` (emptied in `seed()`). `FULL_LOOKUP` becomes `['nominatim.openstreetmap.org 3000/0']`; (j)'s `asked` becomes `['place Tel Aviv', 'place London']`; (k)/(l) `requests.length === 1`. The New York saves now store `elevationM: null` (abroad: no height read): in (a)'s cache-sync check and (m) the expected New York `elevationM` becomes `null` and `heightReads.length === 0`. Move (m)'s "25 points within 3 km" assertions to a Tel Aviv save, reading the points from `heightReads[0]` instead of the URL:

```ts
    seed();
    await save({ location: 'Tel Aviv' });
    await drainAfter();
    assert(heightReads.length === 1 && heightReads[0].length === 25, `height reads ${show(heightReads.map(p => p.length))}`);
    assert(heightReads[0].every(p => Math.abs(p.latitude - 32.0852997) * 111_320 <= 3000.5), 'held to 3 km north-south');
    assert(heightReads[0].every(p => Math.abs(p.longitude - 34.7818064) * 111_320 * Math.cos((32.0852997 * Math.PI) / 180) <= 3000.5), 'held to 3 km east-west');
    assert(userRow.elevationM === ELEVATION_MAX, `Tel Aviv's height ${show(userRow.elevationM)}`);
```

- `scripts/smoke-pause.ts`: delete the `/v1/elevation` branch (lines 131-134); stub `src/services/zmanim/heights.ts` with `highestHeight: () => { heightReads++; return 290; }` (a `let heightReads = 0` reset with the other state); line ~515's `requests.filter(r => r.includes('/v1/elevation')).length === 1` becomes `heightReads === 1`.
- `scripts/smoke-zmanim-api.ts`: delete the `/v1/elevation` branch (lines 152-155); stub `src/services/zmanim/heights.ts` with `highestHeight: () => 270`.

- [ ] **Step 2.11: Run the smokes and see them pass**

Run: `$SCRATCH/om-smoke.sh scripts/smoke-zmanim.ts scripts/smoke-location-timezone.ts scripts/smoke-pause.ts scripts/smoke-zmanim-api.ts scripts/smoke-zmanim-near-me.ts scripts/smoke-zman-reminders.ts` and `TZ_OVERRIDE=UTC $SCRATCH/om-smoke.sh scripts/smoke-zmanim.ts`.
Expected: all pass. Bite check: make `heightAt` use `Math.round` instead of `Math.floor` for the row → the Jerusalem check fails; restore.

- [ ] **Step 2.12: Gate, commit, fresh build**

```bash
npx tsc --noEmit && npm run lint && PATH="$(dirname "$(npx -y node@22 -p process.execPath)"):$PATH" bash scripts/ci-smokes.sh && npx next build
git add data/israel-heights-3s.i16.br src/services/zmanim/height-map.ts src/services/zmanim/heights.ts src/services/zmanim/place.ts src/services/zmanim/elevation-grid.ts scripts/lib/glo90.ts scripts/build-israel-heights.ts scripts/build-city-heights.ts next.config.js prisma/schema.prisma scripts/smoke-zmanim.ts scripts/smoke-location-timezone.ts scripts/smoke-pause.ts scripts/smoke-zmanim-api.ts
git commit -m "feat(zmanim): heights in Israel from a stored GLO-90 map, none abroad, no Open-Meteo

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31"
$SCRATCH/fresh-build.sh
```
Expected: `height map traced: … data/israel-heights-3s.i16.br` and `FRESH BUILD OK`. If the file is missing from the standalone output, change the include key to `'/**/*'`, rebuild, and amend.

---

### Task 3: The forecast on MET Norway

**Files:**
- Create: `src/services/weather/forecast.ts` (replaces `src/services/weather/open-meteo.ts`, deleted with `git rm`), `src/services/weather/rain.ts`, `scripts/smoke-met-weather.ts`, `scripts/fixtures/met-tel-aviv.json` (copy of the research's live answer, `$SCRATCH/met-tlv.json`)
- Modify: `src/types.ts:137-191`, `src/services/zmanim/compute.ts` (add `seaLevelSun`), `src/config/redis-keys.ts`, `src/services/weather/formatter.ts`, `src/services/weather/infographic.tsx`, `src/services/weather/dust-storm.ts`, `src/services/weather/sharav.ts:1-7`, `src/services/claude.ts:268-320`, `src/services/telegram/summary.ts:731-809`, `src/services/telegram/commands.ts:357-372`, `app/api/weather-image/sign/route.ts:64-77`, `messages/{en,he,ru}.json` (`bot.weatherOnly`, `bot.weatherFallback`)
- Test: `scripts/smoke-met-weather.ts` (new), `scripts/smoke-weather-command.ts`, `scripts/smoke-image-link.ts`, `scripts/smoke-bug-batch-words.ts`, `scripts/fixtures/weather-en-dust-storm.json`, `scripts/fixtures/weather-he-sharav-heatwave.json`

**Interfaces:**
- Consumes: `getTimezone(location): Promise<string>` rejecting on no zone, `geocodeLocation` (Task 1).
- Produces:
  - Types (`src/types.ts`): `RainSpell { start: string; end: string; mm: number }`, `WeatherDaySummary`, `WeatherDay`, `WeatherData` without `precipitationProbability` / `precipitation_probability` / `visibility`.
  - `fetchWeather(location: string, timezone: string): Promise<WeatherData>` (the zone is required: no default).
  - `mapMetForecast(input: { location; forecast: MetForecast; timezone; now: Date; sun: SunOf; warn: (m: string) => void }): WeatherData`, `sunFor(latitude, longitude, timezone): SunOf`, `wmoForSymbol(symbol, warn): number`, `MET_SYMBOLS`, `roundedCoordinate(value): string`, `FORECAST_DAYS = 9`, `MET_USER_AGENT`, `MET_URL`, `__useMetForTests(seam)`; and, moved unchanged: `getWeatherDescription`, `describeWeather`, `getWindDirectionLabel`, `getWeatherEmoji`.
  - `rain.ts`: `hasRain(day)`, `rainHoursForModel(spells)`, `rainForModel(day)`, `rainHoursForPerson(spells)`, `formatRainMm(mm, language)`, `rainPhrase(day, t, language)`.
  - `seaLevelSun(date, place): { sunrise: Date | null; sunset: Date | null }` (compute.ts).
  - `detectDustStorm(airQuality: AirQualityData | null): DustStormDay[]` (no `weather` argument, no `minVisibility`).
  - Message keys `bot.weatherOnly.mm`, `bot.weatherOnly.noRain`, `bot.weatherOnly.rainPhrase`, `bot.weatherFallback.rain` (Task 5 adds `bot.weatherCredit`).

- [ ] **Step 3.1: The fixture**

```bash
cp "$SCRATCH/met-tlv.json" scripts/fixtures/met-tel-aviv.json   # MET's live complete answer for 32.08,34.78, 2026-10-31 17:17Z (CC BY 4.0, MET Norway)
```

- [ ] **Step 3.2: Write the failing `scripts/smoke-met-weather.ts`**

```ts
// Smoke test for the forecast on MET Norway (src/services/weather/forecast.ts; plan
// docs/superpowers/plans/2026-10-31-open-meteo-replacement.md, Task 3): the 41 symbols, the units, a real Tel Aviv
// answer mapped onto Israel's days, UTC to the place's wall clock across both clock changes, the days in the place's own
// zone, MET's rules (User-Agent, 2 decimals, Expires, If-Modified-Since), the retries, Redis down, and the holes a real
// answer has. Faked: Redis (in memory), error capture, the geocoder, fetch (scenarios), the waits and the clock
// (forecast.ts's test seam). @hebcal/core runs for the sun times. No network.
//
// Run under both clocks:
//   TZ=UTC npx tsx scripts/smoke-met-weather.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-met-weather.ts

import fs from 'node:fs';
import path from 'node:path';
import Module, { createRequire } from 'node:module';

type Row = Record<string, unknown>;
const ROOT = path.resolve(__dirname, '..');
const nodeRequire = createRequire(__filename);
const results: { name: string; ok: boolean; reason?: string }[] = [];
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

// @hebcal/core is ESM-only and tsx loads src/ as CommonJS (see smoke-weather-command.ts): point it at its ESM build.
const internals = Module as unknown as {
  _resolveFilename: (request: string, parent: unknown, isMain: boolean) => string;
  _cache: Record<string, unknown>;
};
const resolveFilename = internals._resolveFilename;
internals._resolveFilename = function (request, parent, isMain) {
  if (request === '@hebcal/core') return path.join(ROOT, 'node_modules/@hebcal/core/dist/esm/index.js');
  return resolveFilename.call(this, request, parent, isMain);
};

// ---- Fakes ----

const redisStore = new Map<string, unknown>();
let redisDown = false;
const fakeRedis = {
  get: async (key: string) => {
    if (redisDown) throw new Error('redis down');
    return redisStore.has(key) ? structuredClone(redisStore.get(key)) : null;
  },
  set: async (key: string, value: unknown) => {
    if (redisDown) throw new Error('redis down');
    redisStore.set(key, structuredClone(value));
    return 'OK';
  },
};
const captured: { kind: 'error' | 'warning'; context: string; message: string }[] = [];

const requests: { url: string; headers: Record<string, string>; signal: unknown }[] = [];
let answer: (n: number) => Response = () => { throw new Error('no scenario'); };
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  requests.push({ url: String(input), headers: Object.fromEntries(new Headers(init?.headers).entries()), signal: init?.signal });
  return answer(requests.length);
}) as typeof fetch;

const MET_TLV = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/fixtures/met-tel-aviv.json'), 'utf8'));
const LAST_MODIFIED = 'Sat, 31 Oct 2026 17:17:31 GMT';
const metOk = (body: unknown, expires = 'Sat, 31 Oct 2026 18:00:00 GMT') =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', expires, 'last-modified': LAST_MODIFIED } });

/** The clock and the waits forecast.ts reads through its seam. */
let clock = Date.parse('2026-10-31T17:30:00Z');
const waits: number[] = [];

function reset(): void {
  redisStore.clear();
  redisDown = false;
  requests.length = 0;
  waits.length = 0;
  captured.length = 0;
  clock = Date.parse('2026-10-31T17:30:00Z');
}

function installStubs(): void {
  const stub = (rel: string, exports: Row) => {
    const filename = path.join(ROOT, rel);
    const mod = new (Module as unknown as new (id: string) => Row)(filename);
    Object.assign(mod, { filename, loaded: true, exports });
    internals._cache[filename] = mod;
  };
  stub('src/utils/redis.ts', { redis: fakeRedis });
  stub('src/lib/error-capture.ts', {
    captureError: (e: unknown, context: string) => { captured.push({ kind: 'error', context, message: e instanceof Error ? e.message : String(e) }); },
    captureWarning: (message: string, context: string) => { captured.push({ kind: 'warning', context, message }); },
    captureInfo: () => {},
  });
  stub('src/services/weather/geocoding.ts', {
    geocodeLocation: async (location: string) =>
      location === 'Antimeridian' ? { latitude: -0.004, longitude: 179.996, timezone: 'Pacific/Fiji' } : { latitude: 32.0853, longitude: 34.7818, timezone: 'Asia/Jerusalem' },
  });
}

/** A step of MET's answer: an hour of fine weather unless the scenario says otherwise. */
const step = (time: string, over: { temperature?: number; mm?: number; symbol?: string } = {}) => ({
  time,
  data: {
    instant: { details: { air_temperature: over.temperature ?? 20, apparent_air_temperature: over.temperature ?? 20, relative_humidity: 50, wind_speed: 2, wind_from_direction: 90, ultraviolet_index_clear_sky: 1 } },
    next_1_hours: { summary: { symbol_code: over.symbol ?? 'clearsky_day' }, details: { precipitation_amount: over.mm ?? 0 } },
  },
});
const body = (...steps: unknown[]) => ({ type: 'Feature', properties: { timeseries: steps } });

async function main(): Promise<void> {
  installStubs();
  const met = nodeRequire(path.join(ROOT, 'src/services/weather/forecast.ts')) as typeof import('../src/services/weather/forecast');
  met.__useMetForTests({ now: () => clock, sleep: async (ms: number) => { waits.push(ms); }, random: () => 0.5 });
  const warnings: string[] = [];
  const map = (forecast: unknown, timezone = 'Asia/Jerusalem', now = new Date(clock)) =>
    met.mapMetForecast({ location: 'Tel Aviv', forecast: forecast as never, timezone, now, sun: met.sunFor(32.0853, 34.7818, timezone), warn: m => warnings.push(m) });

  await check('the 41 symbols of MET\'s legend each map to a WMO code FamCal draws, with their _day, _night and _polartwilight forms and MET\'s two "lightss" spellings; an unknown one is shown as overcast with one warning naming it', () => {
    const legend = Object.keys(met.MET_SYMBOLS);
    assert(legend.length === 41, `${legend.length} symbols`);
    const drawn = new Set([0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99]);
    const warn: string[] = [];
    for (const symbol of legend) {
      const code = met.wmoForSymbol(symbol, m => warn.push(m));
      assert(drawn.has(code), `${symbol} -> ${code}`);
      for (const variant of ['_day', '_night', '_polartwilight']) assert(met.wmoForSymbol(symbol + variant, m => warn.push(m)) === code, `${symbol}${variant}`);
    }
    assert(met.wmoForSymbol('lightssleetshowersandthunder', m => warn.push(m)) === 95 && met.wmoForSymbol('lightssnowshowersandthunder_day', m => warn.push(m)) === 95, 'the lightss spellings');
    const spot: Record<string, number> = { clearsky_day: 0, fair_night: 1, partlycloudy_day: 2, cloudy: 3, fog: 45, lightrain: 61, rain: 63, heavyrain: 65, lightrainshowers_day: 80, rainshowers_night: 81, heavyrainshowers_day: 82, lightsleet: 66, heavysleet: 67, lightsnow: 71, snow: 73, heavysnow: 75, snowshowers_day: 85, heavysnowshowers_day: 86, rainandthunder: 95 };
    for (const [symbol, code] of Object.entries(spot)) assert(met.wmoForSymbol(symbol, m => warn.push(m)) === code, `${symbol} -> ${met.wmoForSymbol(symbol, () => {})}, want ${code}`);
    assert(warn.length === 0, `warnings ${show(warn)}`);
    assert(met.wmoForSymbol('purplerain_day', m => warn.push(m)) === 3 && warn.length === 1 && warn[0].includes('purplerain_day'), `unknown: ${show(warn)}`);
  });

  await check('MET\'s Tel Aviv answer at 17:30 UTC on 2026-10-31 (19:30 in Israel): the units (m/s to km/h), the current hour, nine days from today in Israel\'s days, the clear-sky UV gone after about 2.5 days, the rain of 6-hour steps', () => {
    warnings.length = 0;
    const w = map(MET_TLV);
    assert(show(w.current) === show({ temperature: 23, feelsLike: 23, humidity: 66, weatherCode: 1, windSpeed: 19, windDirection: 7, uvIndex: 0 }), `current ${show(w.current)}`);
    assert(w.hourly!.time[0] === '2026-10-31T19:00' && w.hourly!.time.length === 88, `hourly ${w.hourly!.time[0]} x${w.hourly!.time.length}`);
    assert(show(w.daily!.map(d => d.date)) === show(['2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08']), `days ${show(w.daily!.map(d => d.date))}`);
    const nov1 = w.daily![1];
    assert(nov1.tempMax === 25 && nov1.tempMin === 17 && nov1.uvIndexMax === 5.1 && nov1.windSpeedMax === 14 && nov1.humidity === 71 && nov1.weatherCode === 2 && nov1.precipitation === 0 && nov1.rainHours.length === 0, `1 Nov ${show(nov1)}`);
    const nov3 = w.daily![3];
    assert(nov3.tempMax === 26 && nov3.tempMin === 20 && nov3.precipitation === 0.8 && nov3.weatherCode === 80 && nov3.uvIndexMax === 1.2 && show(nov3.rainHours) === show([{ start: '20:00', end: '24:00', mm: 0.8 }]), `3 Nov ${show(nov3)}`);
    assert(w.daily!.slice(4).every(d => d.uvIndexMax === null), `UV past 2.5 days ${show(w.daily!.map(d => d.uvIndexMax))}`);
    assert(show(w.daily![5].rainHours) === show([{ start: '08:00', end: '14:00', mm: 0.2 }, { start: '20:00', end: '24:00', mm: 0.1 }]), `5 Nov ${show(w.daily![5].rainHours)}`);
    assert(w.today.tempMax === 23 && w.today.tempMin === 20 && w.today.uvIndexMax === 0 && w.tomorrow?.tempMax === 25, `today ${show(w.today)}, tomorrow ${show(w.tomorrow)}`);
    // Israel is on winter time (UTC+2) since 25 Oct: sunrise about 05:56, sunset about 16:52
    assert(/^2026-10-31T05:5\d$/.test(w.today.sunrise) && /^2026-10-31T16:[45]\d$/.test(w.today.sunset), `sun ${w.today.sunrise} ${w.today.sunset}`);
    assert(warnings.length === 0, `warnings ${show(warnings)}`);
  });

  await check('[6-hour rain] a day that rains in every 6-hour step reads 02:00–24:00 with its total, never 02:00–02:00', () => {
    const w = map(MET_TLV);
    assert(w.daily![6].precipitation === 4.5 && show(w.daily![6].rainHours) === show([{ start: '02:00', end: '24:00', mm: 4.5 }]), `6 Nov ${show(w.daily![6])}`);
    assert(w.daily![7].precipitation === 9.9 && show(w.daily![7].rainHours) === show([{ start: '02:00', end: '24:00', mm: 9.9 }]), `7 Nov ${show(w.daily![7])}`);
  });

  await check('UTC to Israel\'s wall clock across both clock changes: the autumn night repeats 01:00 (one rain spell over both, 01:00–02:00), the spring night skips 02:00', () => {
    const autumn = map(body(step('2026-10-24T21:00:00Z'), step('2026-10-24T22:00:00Z', { mm: 0.4 }), step('2026-10-24T23:00:00Z', { mm: 0.6 }), step('2026-10-25T00:00:00Z')), 'Asia/Jerusalem', new Date('2026-10-24T21:30:00Z'));
    assert(show(autumn.hourly!.time) === show(['2026-10-25T00:00', '2026-10-25T01:00', '2026-10-25T01:00', '2026-10-25T02:00']), `autumn ${show(autumn.hourly!.time)}`);
    assert(show(autumn.today.rainHours) === show([{ start: '01:00', end: '02:00', mm: 1 }]), `autumn rain ${show(autumn.today.rainHours)}`);
    const spring = map(body(step('2026-03-26T23:00:00Z'), step('2026-03-27T00:00:00Z'), step('2026-03-27T01:00:00Z')), 'Asia/Jerusalem', new Date('2026-03-26T23:10:00Z'));
    assert(show(spring.hourly!.time) === show(['2026-03-27T01:00', '2026-03-27T03:00', '2026-03-27T04:00']), `spring ${show(spring.hourly!.time)}`);
  });

  await check('the days are the place\'s own: the same ten UTC hours are 31 Oct 22:00 to 1 Nov 07:00 in Israel and 31 Oct 16:00 to 1 Nov 01:00 in New York, and each zone\'s highs follow its own midnight', () => {
    const steps = Array.from({ length: 10 }, (_, i) => step(new Date(Date.parse('2026-10-31T20:00:00Z') + i * 3_600_000).toISOString().replace('.000', ''), { temperature: i }));
    const israel = map(body(...steps), 'Asia/Jerusalem', new Date('2026-10-31T20:10:00Z'));
    const newYork = map(body(...steps), 'America/New_York', new Date('2026-10-31T20:10:00Z'));
    assert(show(israel.daily!.map(d => [d.date, d.tempMin, d.tempMax])) === show([['2026-10-31', 0, 1], ['2026-11-01', 2, 9]]), `Israel ${show(israel.daily!.map(d => [d.date, d.tempMin, d.tempMax]))}`);
    assert(show(newYork.daily!.map(d => [d.date, d.tempMin, d.tempMax])) === show([['2026-10-31', 0, 7], ['2026-11-01', 8, 9]]), `New York ${show(newYork.daily!.map(d => [d.date, d.tempMin, d.tempMax]))}`);
  });

  await check('the coordinates MET gets: 2 decimals, never "-0.00"', () => {
    assert(met.roundedCoordinate(32.0853) === '32.09' && met.roundedCoordinate(-74.006) === '-74.01' && met.roundedCoordinate(-0.004) === '0.00' && met.roundedCoordinate(51.5) === '51.50', 'rounding');
  });

  await check('MET\'s rules: one request with FamCal\'s User-Agent, the place at 2 decimals and no timeout of our own; none while the answer is fresh (Expires); after it, If-Modified-Since with its Last-Modified, and a 304 keeps the stored answer with its new Expires; one Redis key per rounded place', async () => {
    reset();
    answer = () => metOk(MET_TLV, 'Sat, 31 Oct 2026 18:00:00 GMT');
    const first = await met.fetchWeather('Tel Aviv', 'Asia/Jerusalem');
    assert(requests.length === 1, `${requests.length} requests`);
    const url = new URL(requests[0].url);
    assert(url.origin + url.pathname === 'https://api.met.no/weatherapi/locationforecast/2.0/complete' && url.searchParams.get('lat') === '32.09' && url.searchParams.get('lon') === '34.78' && [...url.searchParams.keys()].length === 2, `url ${requests[0].url}`);
    assert(requests[0].headers['user-agent'] === 'FamCal/1.0 (+https://famcal.bot)' && !('if-modified-since' in requests[0].headers), `headers ${show(requests[0].headers)}`);
    assert(requests[0].signal === undefined, 'the request carries a signal: a timeout of our own');
    assert(show([...redisStore.keys()]) === show(['weather:met:32.09,34.78']), `keys ${show([...redisStore.keys()])}`);
    clock = Date.parse('2026-10-31T17:59:00Z');
    await met.fetchWeather('Tel Aviv', 'Asia/Jerusalem');
    assert(requests.length === 1, 'asked MET again before Expires');
    clock = Date.parse('2026-10-31T18:01:00Z');
    answer = () => new Response(null, { status: 304, headers: { expires: 'Sat, 31 Oct 2026 18:30:00 GMT' } });
    const again = await met.fetchWeather('Tel Aviv', 'Asia/Jerusalem');
    assert(requests.length === 2 && requests[1].headers['if-modified-since'] === LAST_MODIFIED, `refetch headers ${show(requests[1]?.headers)}`);
    assert(again.daily!.length === first.daily!.length, 'the 304 lost the stored answer');
    clock = Date.parse('2026-10-31T18:20:00Z');
    await met.fetchWeather('Tel Aviv', 'Asia/Jerusalem');
    assert(requests.length === 2, 'the 304\'s new Expires was not kept');
    assert(captured.length === 0, `captured ${show(captured)}`);
  });

  await check('retries: a 503 then 200 waits once (backoff) and answers; a 429 waits its Retry-After; no answer (a network error) is retried; four 503s give up after 3 retries; a 429 asking over 10 s and a 403 are not retried; each failure is logged once under weather-forecast and fetchWeather throws', async () => {
    const run = async (answers: Array<Response | Error>): Promise<'ok' | 'threw'> => {
      reset();
      answer = n => {
        const a = answers[Math.min(n, answers.length) - 1];
        if (a instanceof Error) throw a;
        return a.clone();
      };
      try {
        await met.fetchWeather('Tel Aviv', 'Asia/Jerusalem');
        return 'ok';
      } catch {
        return 'threw';
      }
    };
    const status = (s: number, headers: Record<string, string> = {}) => new Response('busy', { status: s, headers });
    assert(await run([status(503), metOk(MET_TLV)]) === 'ok' && requests.length === 2 && show(waits) === show([250]) && captured.length === 0, `503 then 200: ${requests.length} requests, waits ${show(waits)}, captured ${show(captured)}`);
    assert(await run([status(429, { 'retry-after': '2' }), metOk(MET_TLV)]) === 'ok' && show(waits) === show([2000]), `429 Retry-After 2: waits ${show(waits)}`);
    assert(await run([new TypeError('fetch failed'), metOk(MET_TLV)]) === 'ok' && requests.length === 2, `network error: ${requests.length} requests`);
    assert(await run([status(503), status(503), status(503), status(503)]) === 'threw' && requests.length === 4 && show(waits) === show([250, 500, 1000]) && captured.length === 1 && captured[0].context === 'weather-forecast', `4 x 503: ${requests.length} requests, waits ${show(waits)}, captured ${show(captured)}`);
    assert(await run([status(429, { 'retry-after': '60' })]) === 'threw' && requests.length === 1 && waits.length === 0 && captured.length === 1, `429 Retry-After 60: ${requests.length} requests, ${show(captured)}`);
    assert(await run([status(403)]) === 'threw' && requests.length === 1 && captured.length === 1, `403: ${requests.length} requests`);
  });

  await check('Redis down: the forecast still comes, straight from MET, and both Redis failures are logged as warnings', async () => {
    reset();
    redisDown = true;
    answer = () => metOk(MET_TLV);
    const w = await met.fetchWeather('Tel Aviv', 'Asia/Jerusalem');
    redisDown = false;
    assert(w.daily!.length === 9 && requests.length === 1, `days ${w.daily?.length}, requests ${requests.length}`);
    assert(captured.filter(c => c.context === 'weather-forecast' && c.kind === 'error').length === 2, `captured ${show(captured)}`);
  });

  await check('[gaps] a forecast with holes (no UV after about 2.5 days, a last step with no period, a step without humidity, an unknown symbol, no apparent temperature) maps with no NaN, Infinity or undefined anywhere; the bad step is dropped with one warning', () => {
    const holes = structuredClone(MET_TLV);
    const series = holes.properties.timeseries as Array<{ data: { instant: { details: Row }; next_1_hours?: { summary: { symbol_code: string } } } }>;
    delete series[3].data.instant.details.relative_humidity;
    series[5].data.next_1_hours!.summary.symbol_code = 'purplerain_day';
    for (const s of series) delete s.data.instant.details.apparent_air_temperature;
    warnings.length = 0;
    const w = map(holes);
    const bad: string[] = [];
    const walk = (v: unknown, at: string): void => {
      if (v === undefined || (typeof v === 'number' && !Number.isFinite(v))) bad.push(at);
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${at}.${k}`);
    };
    walk(w, 'weather');
    assert(bad.length === 0, `not numbers: ${show(bad.slice(0, 10))}`);
    assert(w.hourly!.time.length === 87, `${w.hourly!.time.length} steps kept`);
    assert(w.current.feelsLike === w.current.temperature, 'feels like without the apparent temperature');
    assert(warnings.length === 2 && warnings.some(m => m.includes('purplerain_day')) && warnings.some(m => m.includes('1 step')), `warnings ${show(warnings)}`);
  });

  await check('[polar] where the sun does not rise that day (Murmansk, 20 Dec) sunrise and sunset are empty; Tel Aviv at midsummer has both, in Israel\'s summer time', () => {
    const polar = met.sunFor(68.97, 33.08, 'Europe/Moscow')('2026-12-20');
    assert(polar.sunrise === '' && polar.sunset === '', `Murmansk ${show(polar)}`);
    const summer = met.sunFor(32.0853, 34.7818, 'Asia/Jerusalem')('2026-06-21');
    assert(/^2026-06-21T05:[2-4]\d$/.test(summer.sunrise) && /^2026-06-21T19:[4-5]\d$/.test(summer.sunset), `Tel Aviv midsummer ${show(summer)}`);
  });

  await check('a forecast with no step for today at the place, or no timeseries, is refused (the caller logs it), never shown as today', () => {
    let refused = 0;
    for (const bad of [body(step('2026-11-05T10:00:00Z')), { properties: {} }]) {
      try { map(bad); } catch { refused++; }
    }
    assert(refused === 2, `${refused} of 2 refused`);
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

(The "Antimeridian" geocoder answer is spare for a reviewer's own probes; delete it if unused at the end.)

- [ ] **Step 3.3: Run it and see it fail**

Run: `$SCRATCH/om-smoke.sh scripts/smoke-met-weather.ts`
Expected: FAIL with `Cannot find module …/src/services/weather/forecast.ts`.

- [ ] **Step 3.4: The types (`src/types.ts:137-191`)**

```ts
/** A stretch of a day when rain falls, read on the place's clock, and how much falls in it. */
export interface RainSpell {
  /** 'HH:mm': when the first wet step starts. */
  start: string;
  /** 'HH:mm': when the last wet step ends; '24:00' when it runs past the day's midnight. */
  end: string;
  /** Millimetres in the stretch, to one decimal. */
  mm: number;
}

/** What a forecast says of one day, as the place's clock divides the days. */
export interface WeatherDaySummary {
  tempMax: number;
  tempMin: number;
  /** Millimetres of rain (snow as its water) in the day, to one decimal. MET gives no rain chance outside the Nordics. */
  precipitation: number;
  rainHours: RainSpell[];
  weatherCode: number;
  /** 'yyyy-MM-ddTHH:mm' at the place; '' where the sun does not rise (or set) that day. */
  sunrise: string;
  sunset: string;
  /** The clear-sky UV index (MET's), so it reads high on cloudy days. */
  uvIndexMax: number;
}

/** One day of the forecast's list. */
export interface WeatherDay extends Omit<WeatherDaySummary, 'uvIndexMax'> {
  date: string;
  /** The clear-sky UV; null past MET's UV horizon (about 2.5 days ahead). */
  uvIndexMax: number | null;
  windSpeedMax: number;
  windDirection: number;
  humidity: number;
}

export interface WeatherData {
  location: string;  // "Harish, Israel"
  current: {
    temperature: number;
    feelsLike: number;
    humidity: number;
    weatherCode: number;
    windSpeed: number;
    windDirection: number;
    uvIndex: number;
  };
  today: WeatherDaySummary;
  tomorrow?: WeatherDaySummary;
  /** MET's steps: hourly for about 2.5 days, then 6-hourly; the times are 'yyyy-MM-ddTHH:mm' at the place. */
  hourly?: {
    time: string[];
    temperature: number[];
    /** Millimetres in the step. */
    precipitation: number[];
    weatherCode: number[];
    windSpeed: number[];
    humidity: number[];
    windDirection: number[];
  };
  /** Up to 9 days, today first. */
  daily?: WeatherDay[];
  summary?: string;  // AI-generated summary
}
```

`AirQualityData` stays as it is until Task 4.

- [ ] **Step 3.5: The sun times (`src/services/zmanim/compute.ts`)**

Add to the header's list: `seaLevelSun   the plain sea-level sunrise and sunset of a day: the forecast's sun times (MET sends none)`. Add after `exactZmanimForDay`:

```ts
/**
 * The plain sea-level sunrise and sunset of a civil day at a place: the forecast's sun times (MET sends none). No set
 * and no height: hebcal's seaLevelSunrise and seaLevelSunset, as Open-Meteo's sunrise and sunset were. Null where the
 * sun does not rise or set that day.
 */
export function seaLevelSun(date: string, place: Pick<Place, 'latitude' | 'longitude' | 'timeZone'>): { sunrise: Date | null; sunset: Date | null } {
  const sun = new Zmanim(new GeoLocation(null, place.latitude, place.longitude, 0, place.timeZone), hdateOf(date), false);
  const rise = msOf(sun.seaLevelSunrise());
  const set = msOf(sun.seaLevelSunset());
  return { sunrise: rise === null ? null : new Date(rise), sunset: set === null ? null : new Date(set) };
}
```

- [ ] **Step 3.6: The Redis key (`src/config/redis-keys.ts`)**, next to `storyImage`:

```ts
  // MET Norway's forecast of a rounded place (2 decimals) with its Expires and Last-Modified (src/services/weather/forecast.ts)
  metForecast: (lat: string, lon: string) => `weather:met:${lat},${lon}`,
```

- [ ] **Step 3.7: Write `src/services/weather/forecast.ts`** (then `git rm src/services/weather/open-meteo.ts`)

```ts
/**
 * The forecast: MET Norway's Locationforecast 2.0, `complete` (https://docs.api.met.no/doc/locationforecast/HowTO),
 * NLOD 2.0 and CC BY 4.0, commercial use allowed. It replaced Open-Meteo's free API, which forbids commercial use. Spec
 * docs/superpowers/specs/2026-10-31-open-meteo-replacement-design.md §5; plan Task 3.
 *
 *   fetchWeather     the one way the app gets a forecast: the place (geocodeLocation), MET (cached), the mapper
 *   mapMetForecast   MET's UTC steps onto WeatherData on the place's wall clock: the units, the days in the place's own
 *                    zone, the 41 symbols as the WMO codes the icons, texts and gradients read, the rain stretches
 *   getWeatherDescription, describeWeather, getWindDirectionLabel, getWeatherEmoji   the WMO helpers (moved unchanged)
 *
 * MET's terms, kept here: a User-Agent naming the app (MET_USER_AGENT); at most 4 decimals (we send 2, about 1 km:
 * roundedCoordinate; MET's model grid is about 9 km); no request before the answer's Expires; If-Modified-Since on a
 * refetch (one Redis key per rounded place). Failure: no timeout of our own; 429, 5xx and no answer retried with backoff
 * (Retry-After honoured; one over 10 s gives up at once); every failure logged; fetchWeather throws and each caller does
 * as before (a summary without weather, /weather's error reply).
 *
 * MET sends no rain chance outside the Nordic countries and no visibility: a day carries its rain amount and the hours
 * it rains. It sends UTC and no past hours: today covers the hours left in it. Server only.
 */

import type { RainSpell, WeatherData, WeatherDay } from '../../types';
import { geocodeLocation } from './geocoding';
import type { BotMessages } from '../../lib/bot-messages';
import { redis } from '../../utils/redis';
import { REDIS_KEYS } from '../../config/redis-keys';
import { captureError, captureWarning } from '../../lib/error-capture';
import { instantToWallTime, wallTimeToInstant } from '../../utils/wall-time';
import { addDaysToDate } from '../../utils/day-events';
import { retryAfterMs } from '../calendar-read/google-map';
import { seaLevelSun } from '../zmanim/compute';

export const MET_URL = 'https://api.met.no/weatherapi/locationforecast/2.0/complete';
/** MET refuses a request without a User-Agent that names the app and a contact. */
export const MET_USER_AGENT = 'FamCal/1.0 (+https://famcal.bot)';
/** Days in the forecast, today included: MET forecasts about nine days ahead. */
export const FORECAST_DAYS = 9;
/** How long a place's answer stays in Redis after a fetch: past its Expires, for If-Modified-Since. */
const CACHE_KEEP_S = 12 * 60 * 60;
/** Used only when MET sends no Expires we can read (it always does): its own half hour. */
const FALLBACK_FRESH_MS = 30 * 60 * 1000;
const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 500;
/** The longest Retry-After waited out inside a request; a longer one fails at once (the caller goes on without weather). */
const RETRY_AFTER_CAP_MS = 10_000;
const HOUR_MS = 3_600_000;
const LOG = '[weather-forecast]';

// ---- MET's answer ----

type MetDetails = Partial<Record<string, number>>;
interface MetPeriod {
  summary?: { symbol_code?: string };
  details?: MetDetails;
}
export interface MetStep {
  time: string;
  data: { instant: { details: MetDetails }; next_1_hours?: MetPeriod; next_6_hours?: MetPeriod; next_12_hours?: MetPeriod };
}
export interface MetForecast {
  properties: { timeseries: MetStep[] };
}
interface CachedForecast {
  body: MetForecast;
  /** Epoch ms of the answer's Expires: no request before it. */
  expiresAt: number;
  lastModified: string | null;
}

// ---- The test seam: the waits, the jitter and the clock ----

interface Seam {
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  now: () => number;
}
const seamState = globalThis as { __metForTests?: Partial<Seam> | null };
/** Tests only: replaces the waits, the jitter and the clock. */
export function __useMetForTests(seam: Partial<Seam> | null): void {
  seamState.__metForTests = seam;
}
const seam = (): Seam => ({ sleep: ms => new Promise(resolve => setTimeout(resolve, ms)), random: Math.random, now: () => Date.now(), ...seamState.__metForTests });

// ---- The symbols ----

/**
 * MET's symbol codes (github.com/metno/weathericons, weather/legend.csv; the _day, _night and _polartwilight forms cut)
 * as the WMO codes FamCal draws. MET has no drizzle, freezing drizzle, snow grains or hail; sleet takes the freezing
 * rain codes and sleet showers the snow-shower ones.
 */
export const MET_SYMBOLS: Readonly<Record<string, number>> = {
  clearsky: 0, fair: 1, partlycloudy: 2, cloudy: 3, fog: 45,
  lightrain: 61, rain: 63, heavyrain: 65,
  lightrainshowers: 80, rainshowers: 81, heavyrainshowers: 82,
  lightsleet: 66, sleet: 66, heavysleet: 67,
  lightsleetshowers: 85, sleetshowers: 85, heavysleetshowers: 86,
  lightsnow: 71, snow: 73, heavysnow: 75,
  lightsnowshowers: 85, snowshowers: 85, heavysnowshowers: 86,
  lightrainandthunder: 95, rainandthunder: 95, heavyrainandthunder: 95,
  lightrainshowersandthunder: 95, rainshowersandthunder: 95, heavyrainshowersandthunder: 95,
  lightsleetandthunder: 95, sleetandthunder: 95, heavysleetandthunder: 95,
  lightsleetshowersandthunder: 95, sleetshowersandthunder: 95, heavysleetshowersandthunder: 95,
  lightsnowandthunder: 95, snowandthunder: 95, heavysnowandthunder: 95,
  lightsnowshowersandthunder: 95, snowshowersandthunder: 95, heavysnowshowersandthunder: 95,
};

/** The WMO code of a MET symbol ('rainshowers_day'); MET's two "lightss…" spellings read as "lights…". An unknown one is logged and shown as overcast (3). */
export function wmoForSymbol(symbol: string, warn: (message: string) => void): number {
  const base = symbol.replace(/_(day|night|polartwilight)$/, '').replace(/^lightss/, 'lights');
  const code = MET_SYMBOLS[base];
  if (code !== undefined) return code;
  warn(`MET sent the symbol "${symbol}", which FamCal does not know: shown as overcast`);
  return 3;
}

// ---- The mapper ----

/** The day's sea-level sunrise and sunset at the place, as wall times ('yyyy-MM-ddTHH:mm'), '' where there is none. */
export type SunOf = (date: string) => { sunrise: string; sunset: string };

/** The one source of the forecast's sun times: compute.ts's sea-level sunrise and sunset, on the place's clock. */
export function sunFor(latitude: number, longitude: number, timezone: string): SunOf {
  return date => {
    const { sunrise, sunset } = seaLevelSun(date, { latitude, longitude, timeZone: timezone });
    const wall = (at: Date | null) => (at ? instantToWallTime(at, timezone).slice(0, 16) : '');
    return { sunrise: wall(sunrise), sunset: wall(sunset) };
  };
}

/** A MET step read once. */
interface Step {
  at: number;
  /** 'yyyy-MM-ddTHH:mm' at the place. */
  wall: string;
  /** The step's length in hours: 1 for an hourly step, else up to the next step (at most 6). */
  hours: number;
  temperature: number;
  feelsLike: number;
  humidity: number;
  windKmh: number;
  windFrom: number;
  uv: number | undefined;
  code: number;
  /** Millimetres in the step: next_1_hours, or next_6_hours prorated to the step's length. */
  mm: number;
  /** A 6-hour step's own highest and lowest temperature. */
  max: number | undefined;
  min: number | undefined;
}

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const round1 = (value: number) => Math.round(value * 10) / 10;

/** MET's steps that FamCal can read, in order. A step missing a core field is dropped (one warning); a last step with no period is expected. */
function readSteps(series: readonly MetStep[], timezone: string, warn: (message: string) => void): Step[] {
  const steps: Step[] = [];
  let dropped = 0;
  for (let i = 0; i < series.length; i++) {
    const s = series[i];
    const at = Date.parse(s?.time ?? '');
    const d = s?.data?.instant?.details ?? {};
    const period = s?.data?.next_1_hours ?? s?.data?.next_6_hours;
    const symbol = period?.summary?.symbol_code;
    if (!symbol) continue; // the answer's last step has no period: nothing to show for it
    if (!Number.isFinite(at) || !isNumber(d.air_temperature) || !isNumber(d.relative_humidity) || !isNumber(d.wind_speed) || !isNumber(d.wind_from_direction)) {
      dropped++;
      continue;
    }
    const hourly = s.data.next_1_hours !== undefined;
    const nextAt = i + 1 < series.length ? Date.parse(series[i + 1].time) : NaN;
    const hours = hourly ? 1 : Math.min(6, Math.max(1, Number.isFinite(nextAt) ? (nextAt - at) / HOUR_MS : 6));
    const amount = period?.details?.precipitation_amount;
    const six = s.data.next_6_hours?.details;
    steps.push({
      at,
      wall: instantToWallTime(new Date(at), timezone).slice(0, 16),
      hours,
      temperature: d.air_temperature,
      feelsLike: isNumber(d.apparent_air_temperature) ? d.apparent_air_temperature : d.air_temperature,
      humidity: d.relative_humidity,
      windKmh: d.wind_speed * 3.6,
      windFrom: d.wind_from_direction,
      uv: isNumber(d.ultraviolet_index_clear_sky) ? d.ultraviolet_index_clear_sky : undefined,
      code: wmoForSymbol(symbol, warn),
      mm: isNumber(amount) ? (hourly ? amount : (amount * hours) / 6) : 0,
      max: hourly || !isNumber(six?.air_temperature_max) ? undefined : six.air_temperature_max,
      min: hourly || !isNumber(six?.air_temperature_min) ? undefined : six.air_temperature_min,
    });
  }
  if (dropped > 0) warn(`${dropped} step${dropped === 1 ? '' : 's'} of MET's answer lacked a temperature, humidity or wind: skipped`);
  return steps;
}

/** The day's wet stretches: back-to-back steps with rain, 'HH:mm' at the place; one that runs past midnight ends at 24:00. */
function rainSpells(steps: readonly Step[], dayEnd: number, timezone: string): RainSpell[] {
  const spells: RainSpell[] = [];
  let open: { start: string; endAt: number; mm: number } | null = null;
  const close = (): void => {
    if (open) spells.push({ start: open.start, end: open.endAt >= dayEnd ? '24:00' : instantToWallTime(new Date(open.endAt), timezone).slice(11, 16), mm: round1(open.mm) });
    open = null;
  };
  for (const step of steps) {
    if (step.mm <= 0) {
      close();
      continue;
    }
    const endAt = step.at + step.hours * HOUR_MS;
    if (open !== null && open.endAt === step.at) {
      open.endAt = endAt;
      open.mm += step.mm;
    } else {
      close();
      open = { start: step.wall.slice(11, 16), endAt, mm: step.mm };
    }
  }
  close();
  return spells;
}

/** The day's main wind direction: the speed-weighted mean of its steps' directions (350° and 10° make 0°, not 180°). */
function mainDirection(steps: readonly Step[]): number {
  let east = 0;
  let north = 0;
  for (const s of steps) {
    const rad = (s.windFrom * Math.PI) / 180;
    east += s.windKmh * Math.sin(rad);
    north += s.windKmh * Math.cos(rad);
  }
  if (east === 0 && north === 0) return Math.round(steps[0]?.windFrom ?? 0);
  return Math.round(((Math.atan2(east, north) * 180) / Math.PI + 360) % 360);
}

/** One day from its steps (all on the place's clock): highs and lows, rain, the most severe code, wind, humidity, UV, sun. */
function buildDay(date: string, steps: readonly Step[], timezone: string, sun: SunOf): WeatherDay {
  const temps = steps.flatMap(s => [s.temperature, s.max, s.min]).filter(isNumber);
  const uv = steps.map(s => s.uv).filter(isNumber);
  const dayEnd = wallTimeToInstant(`${addDaysToDate(date, 1)}T00:00`, timezone).getTime();
  const { sunrise, sunset } = sun(date);
  return {
    date,
    tempMax: Math.round(Math.max(...temps)),
    tempMin: Math.round(Math.min(...temps)),
    precipitation: round1(steps.reduce((sum, s) => sum + s.mm, 0)),
    rainHours: rainSpells(steps, dayEnd, timezone),
    // Open-Meteo's daily code was the day's most severe; the WMO codes rise with severity, so it is the highest.
    weatherCode: Math.max(...steps.map(s => s.code)),
    sunrise,
    sunset,
    uvIndexMax: uv.length > 0 ? round1(Math.max(...uv)) : null,
    windSpeedMax: Math.round(Math.max(...steps.map(s => s.windKmh))),
    windDirection: mainDirection(steps),
    humidity: Math.round(steps.reduce((sum, s) => sum + s.humidity, 0) / steps.length),
  };
}

export interface MapInput {
  location: string;
  forecast: MetForecast;
  timezone: string;
  now: Date;
  sun: SunOf;
  warn: (message: string) => void;
}

/**
 * MET's answer as WeatherData at the place: the current step (the last one not after `now`), today and up to eight more
 * days as the place's clock divides them, and every step on the place's wall clock. Throws when the answer has no
 * timeseries or no step for today at the place (the caller logs it): never another day shown as today.
 */
export function mapMetForecast({ location, forecast, timezone, now, sun, warn }: MapInput): WeatherData {
  const series = forecast?.properties?.timeseries;
  if (!Array.isArray(series)) throw new Error('MET sent no timeseries');
  const steps = readSteps(series, timezone, warn);
  const today = instantToWallTime(now, timezone).slice(0, 10);
  const byDay = new Map<string, Step[]>();
  for (const step of steps) {
    const date = step.wall.slice(0, 10);
    if (date < today) continue;
    if (!byDay.has(date)) {
      if (byDay.size === FORECAST_DAYS) break;
      byDay.set(date, []);
    }
    byDay.get(date)!.push(step);
  }
  if (!byDay.has(today)) throw new Error("MET's forecast has no step for today at the place");
  const daily = [...byDay].map(([date, daySteps]) => buildDay(date, daySteps, timezone, sun));
  const nowMs = now.getTime();
  const current = steps.reduce((found, step) => (step.at <= nowMs ? step : found), steps[0]);
  // MET's UV reaches about 60 hours ahead, which always covers today and tomorrow: 0 only for a gap in the answer.
  const summary = (day: WeatherDay) => ({
    tempMax: day.tempMax, tempMin: day.tempMin, precipitation: day.precipitation, rainHours: day.rainHours,
    weatherCode: day.weatherCode, sunrise: day.sunrise, sunset: day.sunset, uvIndexMax: day.uvIndexMax ?? 0,
  });
  return {
    location,
    current: {
      temperature: Math.round(current.temperature),
      feelsLike: Math.round(current.feelsLike),
      humidity: Math.round(current.humidity),
      weatherCode: current.code,
      windSpeed: Math.round(current.windKmh),
      windDirection: Math.round(current.windFrom),
      uvIndex: round1(current.uv ?? 0),
    },
    today: summary(daily[0]),
    tomorrow: daily[1]?.date === addDaysToDate(today, 1) ? summary(daily[1]) : undefined,
    hourly: {
      time: steps.map(s => s.wall),
      temperature: steps.map(s => round1(s.temperature)),
      precipitation: steps.map(s => round1(s.mm)),
      weatherCode: steps.map(s => s.code),
      windSpeed: steps.map(s => round1(s.windKmh)),
      humidity: steps.map(s => Math.round(s.humidity)),
      windDirection: steps.map(s => Math.round(s.windFrom)),
    },
    daily,
  };
}

// ---- MET's requests ----

/** Coordinates as MET gets them and the cache keys them: 2 decimals (about 1 km), never "-0.00". */
export function roundedCoordinate(value: number): string {
  return (Math.round(value * 100) / 100 + 0).toFixed(2);
}

/**
 * One request to MET with the retries: 429, 5xx and no answer are retried up to 3 times after max(Retry-After,
 * full-jitter backoff from 500 ms); a Retry-After over 10 s, a 403 or another refusal fails at once. Answers a 2xx or a
 * 304; a failure is logged once (status and retries, never the place) and thrown. No timeout of our own.
 */
async function metRequest(url: string, headers: Record<string, string>): Promise<Response> {
  for (let retried = 0; ; retried++) {
    let response: Response | null = null;
    let failure: unknown = null;
    try {
      response = await fetch(url, { headers });
    } catch (error) {
      failure = error;
    }
    if (response && (response.ok || response.status === 304)) return response;
    const status = response?.status;
    const retryable = response === null || status === 429 || (status !== undefined && status >= 500);
    const asked = response ? retryAfterMs({ response: { headers: response.headers } }, seam().now()) : undefined;
    const why = !retryable ? 'not retried' : retried === MAX_RETRIES ? `gave up after ${retried} retries` : asked !== undefined && asked > RETRY_AFTER_CAP_MS ? `Retry-After ${asked} ms is over the cap` : null;
    if (why !== null) {
      const error = failure ?? new Error(`MET answered ${status} (${why})`);
      captureError(error, 'weather-forecast', { service: 'weather', status, retried, why }, 'warning');
      throw error;
    }
    const waitMs = Math.max(asked ?? 0, Math.round(seam().random() * BACKOFF_BASE_MS * 2 ** retried));
    console.warn(`${LOG} MET ${response ? `answered ${status}` : 'gave no answer'}; retry ${retried + 1} of ${MAX_RETRIES} in ${waitMs} ms`);
    await seam().sleep(waitMs);
  }
}

/** The answer's Expires as epoch ms; MET always sends it, and a missing one is logged and read as its half hour. */
function expiresOf(response: Response, now: number): number {
  const at = Date.parse(response.headers.get('expires') ?? '');
  if (Number.isFinite(at)) return at;
  console.warn(`${LOG} MET sent no Expires FamCal can read: the answer is kept for 30 minutes`);
  return now + FALLBACK_FRESH_MS;
}

/** MET's answer for a rounded place: the stored one while it is fresh, else asked again (If-Modified-Since when one is stored). */
async function metForecast(lat: string, lon: string): Promise<MetForecast> {
  const key = REDIS_KEYS.metForecast(lat, lon);
  let cached: CachedForecast | null = null;
  try {
    cached = await redis.get<CachedForecast>(key);
  } catch (error) {
    captureError(error, 'weather-forecast', { service: 'weather', step: 'cache-read' }, 'warning');
  }
  const now = seam().now();
  if (cached && now < cached.expiresAt) return cached.body;

  const headers: Record<string, string> = { 'User-Agent': MET_USER_AGENT };
  if (cached?.lastModified) headers['If-Modified-Since'] = cached.lastModified;
  const response = await metRequest(`${MET_URL}?lat=${lat}&lon=${lon}`, headers);
  const expiresAt = expiresOf(response, now);
  let fresh: CachedForecast;
  if (response.status === 304) {
    if (!cached) throw new Error('MET answered 304 to a request with no If-Modified-Since');
    fresh = { ...cached, expiresAt };
  } else {
    const body = (await response.json()) as MetForecast;
    if (!Array.isArray(body?.properties?.timeseries)) throw new Error('MET answered 200 with no timeseries');
    fresh = { body, expiresAt, lastModified: response.headers.get('last-modified') };
  }
  try {
    await redis.set(key, fresh, { ex: CACHE_KEEP_S });
  } catch (error) {
    captureError(error, 'weather-forecast', { service: 'weather', step: 'cache-write' }, 'warning');
  }
  return fresh.body;
}

/**
 * The forecast for a location in its zone (`timezone`, the place's own: getTimezone's): MET's answer for the rounded
 * place, mapped. Throws when the place, MET or the mapping fails; each caller logs it and does as before.
 */
export async function fetchWeather(location: string, timezone: string): Promise<WeatherData> {
  const { latitude, longitude } = await geocodeLocation(location);
  const forecast = await metForecast(roundedCoordinate(latitude), roundedCoordinate(longitude));
  const weather = mapMetForecast({
    location,
    forecast,
    timezone,
    now: new Date(seam().now()),
    sun: sunFor(latitude, longitude, timezone),
    warn: message => captureWarning(message, 'weather-forecast', { service: 'weather' }),
  });
  console.log(`${LOG} forecast ready: ${weather.daily?.length ?? 0} days in ${timezone}`);
  return weather;
}
```

Then append the four helpers **unchanged** from `open-meteo.ts` lines 155-244 (`getWeatherDescription`, `WEATHER_CONDITION_KEYS`, `describeWeather`, `getWindDirectionLabel`, `getWeatherEmoji`), changing only the doc link of `getWeatherDescription` from `https://open-meteo.com/en/docs` to "WMO 4677 codes, the subset the forecast maps MET's symbols onto". (The `BotMessages` type import above is theirs.)

- [ ] **Step 3.8: The rain words (`src/services/weather/rain.ts`)**

```ts
// A day's rain in words, the one source for every surface: the model's prompts (plain), and the person's messages and
// the infographic (in their language and numerals, each time range isolated left to right so a Hebrew line keeps
// 14:00–17:00 in that order). Pure. Plan Task 3.

import type { RainSpell } from '../../types';
import type { BotMessages } from '../../lib/bot-messages';
import { isolateLtr } from '../../lib/bidi-isolate';

type RainDay = { precipitation: number; rainHours: readonly RainSpell[] };

/** Whether the day has rain worth a word: some millimetres, in some hours. */
export function hasRain(day: RainDay): boolean {
  return day.precipitation > 0 && day.rainHours.length > 0;
}

/** The wet stretches for the model: '14:00–17:00 (3 mm), 20:00–24:00 (0.4 mm)'. */
export function rainHoursForModel(spells: readonly RainSpell[]): string {
  return spells.map(s => `${s.start}–${s.end} (${s.mm} mm)`).join(', ');
}

/** A day's rain for the model in a few words: 'no rain', or 'rain 14:00–17:00 (3 mm)'. */
export function rainForModel(day: RainDay): string {
  return hasRain(day) ? `rain ${rainHoursForModel(day.rainHours)}` : 'no rain';
}

/** The wet stretches for a person: '⁦14:00–17:00⁩, ⁦20:00–24:00⁩'. */
export function rainHoursForPerson(spells: readonly RainSpell[]): string {
  return spells.map(s => isolateLtr(`${s.start}–${s.end}`)).join(', ');
}

/** Millimetres in the person's numerals, at most one decimal ('3', '0.4', '0,4' in Russian). */
export function formatRainMm(mm: number, language: string): string {
  const locale = language === 'he' ? 'he-IL' : language === 'ru' ? 'ru-RU' : 'en-US';
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(mm);
}

/** A day's rain in one phrase of the person's message: "no rain", or "rain 14:00–17:00, 3 mm". */
export function rainPhrase(day: RainDay, t: BotMessages, language: string): string {
  if (!hasRain(day)) return t.weatherOnly.noRain;
  return t.weatherOnly.rainPhrase.replace('{hours}', rainHoursForPerson(day.rainHours)).replace('{mm}', formatRainMm(day.precipitation, language));
}
```

- [ ] **Step 3.9: The new words (`messages/{en,he,ru}.json`)**

In `bot.weatherOnly`: delete `"rain"`; add after `"windSpeed"`:

| key | en | he | ru |
|---|---|---|---|
| `mm` | `mm` | `מ״מ` | `мм` |
| `noRain` | `no rain` | `בלי גשם` | `без дождя` |
| `rainPhrase` | `rain {hours}, {mm} mm` | `גשם {hours}, {mm} מ״מ` | `дождь {hours}, {mm} мм` |

In `bot.weatherFallback`: replace `"rainProbability"` (`Rain probability` / `סיכוי לגשם` / its ru) with `"rain"`: `Rain` / `גשם` / `Дождь`. (Hebrew uses the gershayim ״, as `קמ״ש` does.)

- [ ] **Step 3.10: The callers**

`src/services/weather/dust-storm.ts`: header becomes

```ts
/**
 * Dust storm detection from Copernicus CAMS air quality (air-quality.ts). Separate from thermal sharav: catches Saharan
 * dust transport events that arrive via upper-level winds with moderate temperatures. The peak dust or PM10 alone sets
 * the severity: the forecast has no visibility since MET Norway replaced Open-Meteo.
 */
```

drop the `WeatherData` import, `minVisibility` from `DustStormDay`, `computeMinVisibility`, the `weather` parameter (`detectDustStorm(airQuality: AirQualityData | null)`) and the "Check visibility" block; the rest unchanged.

`src/services/weather/sharav.ts`: `import { getWindDirectionLabel } from './forecast';`; header line 3 becomes "Uses temperature, wind direction and humidity from the forecast (forecast.ts)."

`src/services/weather/formatter.ts`:
- line 13: `import { describeWeather, getWeatherDescription, getWeatherEmoji, getWindDirectionLabel } from './forecast';` and add `import { formatRainMm, rainHoursForModel, rainHoursForPerson } from './rain';` and `import type { WeatherDay } from '../../types';` (with `AirQualityData, WeatherData`).
- delete `RainHours`, `extractRainHours`, `formatRainHours` (lines 20-105).
- `formatTime` (line 118-124):

```ts
/**
 * HH:MM of a forecast time, a wall time at the place ('yyyy-MM-ddTHH:mm'): read from the text, never through a Date
 * parsed in the server's zone. A dash where there is none (no sunrise or sunset that day, in the far north).
 */
function formatTime(isoString: string): string {
  return isoString === '' ? '—' : isoString.slice(11, 16);
}
```

- `buildWeatherAIPayload` (lines 129-200): delete the `todayDate`/`tomorrowDate`/`…RainHours` lines; the day summary becomes

```ts
  const buildDaySummary = (day: WeatherDay, withHours: boolean) => {
    const result: Record<string, unknown> = {
      day: new Date(day.date).toLocaleDateString('en-US', { weekday: 'long' }),
      date: day.date,
      high: day.tempMax,
      low: day.tempMin,
      rainMm: day.precipitation,
      condition: getWeatherDescription(day.weatherCode),
      sunrise: formatTime(day.sunrise),
      sunset: formatTime(day.sunset),
      windMax: day.windSpeedMax,
      windDir: getWindDirectionLabel(day.windDirection),
    };
    if (day.uvIndexMax !== null) result.uvMax = day.uvIndexMax;
    if (withHours && day.rainHours.length > 0) result.rainHours = rainHoursForModel(day.rainHours);
    return result;
  };
```

with `today: daily[0] ? buildDaySummary(daily[0], true) : null`, `tomorrow: daily[1] ? buildDaySummary(daily[1], true) : null`, `thisWeek: daily.slice(2, 7).map(d => buildDaySummary(d, false))`, `extended: daily.slice(7).map(d => buildDaySummary(d, false))`; `detectDustStorm(airQuality ?? null)` and drop the `minVisibility` spread.
- the prompt: the rule line "Mention rain timing when relevant (use rainHours data if available)" becomes "- Mention rain timing and amount when relevant (rainHours and rainMm, in millimetres). The data has no chance of rain, so never give one as a percentage"; "2-3 sentences on the general trend for days 8-16." becomes "2-3 sentences on the general trend for days 8 and 9.".
- `formatWeatherDetailed`, today (lines 405-416):

```ts
  if (weather.today.precipitation > 0) {
    output += `🌧️ ${f.rain}: ${formatRainMm(weather.today.precipitation, language)} ${w.mm}\n`;
  }
  if (weather.today.rainHours.length > 0) {
    output += `⏰ ${f.rainExpected}: ${rainHoursForPerson(weather.today.rainHours)}\n`;
  }
```

tomorrow (lines 462-475) the same with `weather.tomorrow`; the next 12 hours: `const precip = weather.hourly.precipitation[i];` and `if (precip > 0) output += ` 💧${formatRainMm(precip, language)} ${w.mm}`;`; the 7 days: `if (day.precipitation > 0) output += ` 💧${formatRainMm(day.precipitation, language)} ${w.mm}`;` and `if (day.uvIndexMax !== null && day.uvIndexMax >= 7)`. Comment at line 421: "The forecast's times are wall times at the place ('yyyy-MM-ddTHH:mm', in the person's zone), so they compare with the place's own clock".

`src/services/weather/infographic.tsx`:
- imports: `import { describeWeather, FORECAST_DAYS, getWindDirectionLabel } from './forecast';`, `import { formatRainMm } from './rain';`, `import { getBotMessages, type BotMessages } from '../../lib/bot-messages';`.
- `computeRows(config: InfographicConfig, t: BotMessages)`: `(config.weather.daily || []).slice(0, FORECAST_DAYS)`, `detectDustStorm(config.airQuality ?? null)`, `rain: d.precipitation > 0 ? `${formatRainMm(d.precipitation, config.language)} ${t.weatherOnly.mm}` : ''`, `uvIndex: d.uvIndexMax === null ? '' : `${d.uvIndexMax}``.
- `buildInfographicJsx(config, rows, globalMin, globalMax, conditionText, rainToday: string)`; the stats row's precipitation text `{config.weather.today.precipitationProbability}%` becomes `{isRTL ? toVisualOrder(rainToday) : rainToday}`.
- the condition column: `width: 60` → `width: 84`; its rain text `fontSize: 26` → `fontSize: 22` and `{row.rain ? (isRTL ? toVisualOrder(row.rain) : row.rain) : ' '}`.
- the UV column: the icon only when there is a value (`{row.uvIndex ? getUvIcon(30, getUvColor(parseFloat(row.uvIndex))) : null}`), the text `{row.uvIndex || ' '}`.
- `generateWeatherInfographic`: `const t = await getBotMessages(config.language);` first, then `computeRows(config, t)`, `const conditionText = describeWeather(config.weather.current.weatherCode, t);`, `const rainToday = `${formatRainMm(config.weather.today.precipitation, config.language)} ${t.weatherOnly.mm}`;`.

`src/services/claude.ts` (lines 268-320):

```ts
      const { fetchWeather, getWeatherDescription, getWindDirectionLabel } = await import('./weather/forecast');
      const { rainForModel } = await import('./weather/rain');
```

the two lines of `weatherSummary` become `Today: High ${weatherData.today.tempMax}°C, Low ${weatherData.today.tempMin}°C, ${rainForModel(weatherData.today)}` and the same for tomorrow; `detectDustStorm(airQualityData)`.

`src/services/telegram/summary.ts` (lines 731-809): import `fetchWeather, describeWeather, getWindDirectionLabel` from `'../weather/forecast'` and `const { rainPhrase } = await import('../weather/rain');`; `detectDustStorm(airQualityData)`; the today and tomorrow lines end with `, ${rainPhrase(weatherData.today, t, user.language || 'en')}` and `, ${rainPhrase(weatherData.tomorrow, t, user.language || 'en')}` in place of `${…precipitationProbability}% ${t.weatherOnly?.rain || 'rain'}`.

`src/services/telegram/commands.ts` (lines 357-372):

```ts
      const { fetchWeather } = await import('../weather/forecast');
      const { fetchAirQuality } = await import('../weather/air-quality');
      const { getTimezone } = await import('../weather/geocoding');
      // The place's own zone, for the forecast's hours and dates. No zone (the lookup logged why) is the error reply,
      // never Israel's clock.
      const timezone = await getTimezone(user.location);

      const [weatherData, airQualityData] = await Promise.all([
        fetchWeather(user.location, timezone),
        fetchAirQuality(user.location, timezone).catch(() => null),
      ]);
```

(the `TIMEZONE` import and the empty catch go).

`app/api/weather-image/sign/route.ts` (lines 64-77): import `fetchWeather` from `'@/src/services/weather/forecast'`; drop the `TIMEZONE` import; `const timezone = await getTimezone(user.location); // no zone: the route fails (Sentry via onRequestError), never Israel's clock`; `fetchWeather(user.location, timezone)`.

- [ ] **Step 3.11: The other smokes and the fixtures**

Fixtures: run once (scratch script, not committed) `node $SCRATCH/convert-weather-fixtures.cjs scripts/fixtures/weather-en-dust-storm.json scripts/fixtures/weather-he-sharav-heatwave.json`:

```js
// Moves the weather fixtures to MET's shape: no rain chance and no visibility, a rain amount and rain hours per day,
// nine days. They keep their compact one-line JSON.
const fs = require('fs');
for (const file of process.argv.slice(2)) {
  const fx = JSON.parse(fs.readFileSync(file, 'utf8'));
  const w = fx.weather;
  const dry = { precipitation: 0, rainHours: [] };
  for (const day of [w.today, w.tomorrow].filter(Boolean)) { delete day.precipitationProbability; Object.assign(day, dry); }
  w.daily = w.daily.slice(0, 9).map(d => { delete d.precipitationProbability; return { ...d, ...dry }; });
  delete w.hourly.precipitation_probability;
  delete w.hourly.visibility;
  fx.description = fx.description.replace(', visibility 800 m', '');
  fs.writeFileSync(file, JSON.stringify(fx));
}
```

`scripts/smoke-weather-command.ts`:
- `WEATHER` (lines 116-135) to the new shape: `today: { tempMax: 18, tempMin: 11, precipitation: 0, rainHours: [], weatherCode: 3, sunrise: '2026-10-13T07:05', sunset: '2026-10-13T18:20', uvIndexMax: 3 }`, `tomorrow: { tempMax: 17, tempMin: 10, precipitation: 4.2, rainHours: [{ start: '06:00', end: '12:00', mm: 4.2 }], weatherCode: 61, sunrise: '2026-10-14T07:06', sunset: '2026-10-14T18:19', uvIndexMax: 2 }`, `hourly.precipitation: Array.from({ length: 48 }, (_, h) => (h >= 30 && h < 36 ? 0.7 : 0))` with no `precipitation_probability`, and each daily row `precipitation: d === 14 ? 4.2 : 0, rainHours: d === 14 ? [{ start: '06:00', end: '12:00', mm: 4.2 }] : []` in place of `precipitationProbability`.
- the stubs: `[`${SRC}/services/weather/forecast.ts`]: real => ({ ...real, fetchWeather: async (location: string, zone: string) => { weatherCalls.push({ location, zone }); return WEATHER; } })` and `[`${SRC}/services/weather/geocoding.ts`]: real => ({ ...real, getTimezone: async () => { if (zoneFails) throw new Error('No time zone for the place (the zone lookup logged why)'); return USER_TZ; } })`, with `let weatherCalls: { location: string; zone: string }[] = [];` and `let zoneFails = false;`, `weatherCalls` emptied where `runWeather` empties `forecastCalls`.
- new checks, before "nothing left running":

```ts
  await check('10. the forecast is asked in the place\'s own zone (getTimezone\'s), as the air quality is: never Israel\'s by default', async () => {
    await runWeather({ voice: false });
    assert(weatherCalls.length === 1 && weatherCalls[0].zone === USER_TZ && weatherCalls[0].location === 'Brooklyn', `forecast calls ${JSON.stringify(weatherCalls)}`);
  });

  await check('11. the place has no zone (the lookup found none): the error reply goes out, and no forecast is asked on another zone\'s clock', async () => {
    zoneFails = true;
    try {
      await runWeather({ voice: false });
      await sleep(100);
    } finally {
      zoneFails = false;
    }
    assert(weatherCalls.length === 0, `forecast asked anyway: ${JSON.stringify(weatherCalls)}`);
    assert(sentBy('sendPhoto').length === 0 && sentBy('sendMessage').length === 1, `replies ${JSON.stringify(sentBy('sendMessage').map(r => r.text))}`);
  });
```

`scripts/smoke-image-link.ts`: line 139 becomes `stub('src/services/weather/forecast.ts', { fetchWeather: async (_location: string, zone: string) => { builds.push(`fetchWeather ${zone}`); return {}; } });`; `fetchAirQuality: async (_location: string, zone: string) => { builds.push(`fetchAirQuality ${zone}`); return null; }`; `getTimezone` returns `'Europe/Kyiv'`. New check before the summary:

```ts
  await check('#8 a fresh image asks the forecast and the air in the place\'s own zone (getTimezone\'s), never Israel\'s by default', async () => {
    resetState();
    const res = await quiet(() => sign('user_id=9&source=fresh'));
    assert(res.status === 200, `sign: ${res.status}`);
    assert(builds.includes('fetchWeather Europe/Kyiv') && builds.includes('fetchAirQuality Europe/Kyiv'), `builds ${show(builds)}`);
  });
```

`scripts/smoke-bug-batch-words.ts`:
- line 355: the stub path becomes `${SRC}/services/weather/forecast.ts`; line 725: `await import('../src/services/weather/forecast')`.
- `ENGLISH_WORDS` (line 492) gains `|\bmm\b|no rain`.
- `forecast()`: after reading the fixture, `if (rainyToday) Object.assign(weather.today as object, { precipitation: 3, rainHours: [{ start: '14:00', end: '17:00', mm: 3 }] });` with `let rainyToday = false;` declared beside `noCalendars`.
- new checks in `fix4()`:

```ts
  await check('4: [bidi] the weather-only message in Hebrew on a rainy day says the rain\'s hours left to right inside the line (14:00–17:00, isolated), with its millimetres in Hebrew', async () => {
    const { uid, tg } = PEOPLE.he;
    Object.assign(userRow(uid), { location: 'Beersheba', weatherEnabled: true });
    noCalendars = true;
    scheduled = [uid];
    const mine = () => sentTo('telegram').filter(s => String(s.chatId) === String(tg));
    const before = mine().length;
    rainyToday = true;
    try {
      const { sendDailySummaryToAll } = await import('../src/services/telegram/summary');
      await withLogs(() => sendDailySummaryToAll());
    } finally {
      rainyToday = false;
    }
    const out = mine().slice(before);
    assert(out.length === 1, `expected one weather message, got ${out.length}`);
    assert(out[0].text.includes('גשם ⁦14:00–17:00⁩, 3 מ״מ'), `the rain line:\n${out[0].text}`);
  });

  await check('4: [polar] the fallback forecast for a place where the sun does not rise that day shows a dash for sunrise and sunset, in every language', async () => {
    const { formatWeatherAI } = await import('../src/services/weather/formatter');
    for (const lang of LANGS) {
      const weather = forecast();
      Object.assign(weather.today as object, { sunrise: '', sunset: '' });
      Object.assign(weather.tomorrow as object, { sunrise: '', sunset: '' });
      const result = await withLogs(() => formatWeatherAI(weather as never, lang, 'Dana', 'Europe/Moscow', 'default', false, false, null, new Date()));
      const rise = `${botText(lang, 'weatherFallback.sunrise')}: —`;
      const set = `${botText(lang, 'weatherFallback.sunset')}: —`;
      assert(result.brief.includes(rise) && result.brief.includes(set), `${lang}:\n${result.brief}`);
    }
  });
```

- [ ] **Step 3.12: Run and see everything pass**

```bash
$SCRATCH/om-smoke.sh scripts/smoke-met-weather.ts scripts/smoke-weather-command.ts scripts/smoke-image-link.ts scripts/smoke-bug-batch-words.ts scripts/smoke-weather-prompt.ts scripts/smoke-share-story.ts scripts/smoke-oauth-weather.ts scripts/smoke-summary-prompt-parity.ts scripts/smoke-he-neutral.ts scripts/smoke-ru-formal.ts scripts/smoke-site-truth.ts
TZ_OVERRIDE=UTC $SCRATCH/om-smoke.sh scripts/smoke-met-weather.ts scripts/smoke-weather-command.ts scripts/smoke-weather-prompt.ts
```
Expected: all pass. Any other smoke that now loads `forecast.ts` (and so `@hebcal/core`) and fails with `ERR_REQUIRE_ESM` gets the same `_resolveFilename` redirect `smoke-weather-command.ts` uses. Bite checks: remove the 24:00 clip → "[6-hour rain]" fails; make `fetchWeather` default its zone to `'Asia/Jerusalem'` and drop the argument in commands.ts → `tsc` fails and check 10 fails; drop `isolateLtr` → the [bidi] check fails. Restore each.

- [ ] **Step 3.13: Look at the infographic** (frontend-design skill: invoke it for the rain cell and the empty UV cell). Write `$SCRATCH/render-infographic.ts`:

```ts
// Renders the infographic from MET's Tel Aviv fixture in en, he and ru to $SCRATCH/shots (dev check, not a test).
import fs from 'node:fs';
import path from 'node:path';
import Module, { createRequire } from 'node:module';

const ROOT = '/Users/razielgershoni/development/famcalbot';
const OUT = '/private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/om/shots';
const nodeRequire = createRequire(path.join(ROOT, 'scripts/render.ts'));
const internals = Module as unknown as { _resolveFilename: (r: string, p: unknown, m: boolean) => string; _cache: Record<string, unknown> };
const resolve = internals._resolveFilename;
internals._resolveFilename = function (request, parent, isMain) {
  if (request === '@hebcal/core') return path.join(ROOT, 'node_modules/@hebcal/core/dist/esm/index.js');
  return resolve.call(this, request, parent, isMain);
};
const stub = (rel: string, exports: Record<string, unknown>) => {
  const filename = path.join(ROOT, rel);
  const mod = new (Module as unknown as new (id: string) => Record<string, unknown>)(filename);
  Object.assign(mod, { filename, loaded: true, exports });
  internals._cache[filename] = mod;
};
stub('src/utils/redis.ts', { redis: { get: async () => null, set: async () => 'OK' } });
stub('src/services/weather/geocoding.ts', { getLocalizedLocationName: async (l: string) => l, geocodeLocation: async () => ({ latitude: 32.0853, longitude: 34.7818, timezone: 'Asia/Jerusalem' }) });
const met = nodeRequire(path.join(ROOT, 'src/services/weather/forecast.ts'));
const { buildInfographicConfig } = nodeRequire(path.join(ROOT, 'src/services/weather/formatter.ts'));
const { generateWeatherInfographic } = nodeRequire(path.join(ROOT, 'src/services/weather/infographic.tsx'));
const forecast = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/fixtures/met-tel-aviv.json'), 'utf8'));
const now = new Date('2026-10-31T17:30:00Z');
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  for (const lang of ['en', 'he', 'ru']) {
    const weather = met.mapMetForecast({ location: 'Tel Aviv, Israel', forecast, timezone: 'Asia/Jerusalem', now, sun: met.sunFor(32.0853, 34.7818, 'Asia/Jerusalem'), warn: console.warn });
    const png = await generateWeatherInfographic(buildInfographicConfig(weather, lang, 'Asia/Jerusalem', 'jewish', null, now));
    fs.writeFileSync(path.join(OUT, `infographic-${lang}.png`), png);
  }
  console.log('rendered to', OUT);
})();
```

Run `$SCRATCH/om-smoke.sh $SCRATCH/render-infographic.ts` (from the repo root, for the fonts), then Read the three PNGs: 9 rows, "0.8 mm" / "0.8 מ״מ" / "0,8 мм" fit their cell, rows 5-9 have an empty UV cell, the hero row shows today's "0 mm". Adjust only the widths and sizes named in Step 3.10 if a cell clips.

- [ ] **Step 3.14: Gate and commit**

```bash
npx tsc --noEmit && npm run lint && PATH="$(dirname "$(npx -y node@22 -p process.execPath)"):$PATH" bash scripts/ci-smokes.sh && npx next build
git rm src/services/weather/open-meteo.ts
git add src/types.ts src/config/redis-keys.ts src/services/zmanim/compute.ts src/services/weather/forecast.ts src/services/weather/rain.ts src/services/weather/formatter.ts src/services/weather/infographic.tsx src/services/weather/dust-storm.ts src/services/weather/sharav.ts src/services/claude.ts src/services/telegram/summary.ts src/services/telegram/commands.ts app/api/weather-image/sign/route.ts messages/en.json messages/he.json messages/ru.json scripts/smoke-met-weather.ts scripts/fixtures/met-tel-aviv.json scripts/fixtures/weather-en-dust-storm.json scripts/fixtures/weather-he-sharav-heatwave.json scripts/smoke-weather-command.ts scripts/smoke-image-link.ts scripts/smoke-bug-batch-words.ts
git commit -m "feat(weather): the forecast from MET Norway, rain as amount and hours, in the place's own zone

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31"
```

---

### Task 4: Dust from Open-Meteo's open data (CAMS on S3)

Binding spike rulings: R1 the rolling `data/<model>/{dust,pm10}/chunk_N.om` layout; R2 the API's default `auto` (cams_europe inside its grid for its hours, cams_global elsewhere and after, no cross-fade); R3 about 5 days ahead; R4 a cache per (model, cell, run), readers keyed on `last_run_modification_time`, any read error drops the readers, refreshes the meta and retries; R5 `@openmeteo/file-reader` exactly 0.0.21, server only, plain `OmHttpBackend`, never `LruBlockCache`; R6 our own retry and backoff, the library at one attempt, a warning when the run is over 36 h old; R7 recorded S3 range responses replayed through a mocked fetch; R8 the attribution (Task 5).

**Files:**
- Rewrite: `src/services/weather/air-quality.ts`
- Create: `scripts/record-cams-fixture.ts` (dev, run once), `scripts/fixtures/cams-tel-aviv.json` (recorded), `scripts/smoke-air-quality.ts`
- Modify: `package.json`, `package-lock.json`, `next.config.js` (`serverExternalPackages`), `src/types.ts:193-200`, `scripts/fixtures/weather-*.json` and `scripts/smoke-weather-command.ts:136` (no `pm2_5`)

**Interfaces:**
- Consumes: `geocodeLocation` (Task 1), `detectDustStorm(airQuality)` (Task 3), `instantToWallTime` / `wallTimeToInstant`.
- Produces: `fetchAirQuality(location: string, timezone: string): Promise<AirQualityData | null>` (never throws); `AirQualityData = { hourly: { time: string[]; pm10: (number | null)[]; dust: (number | null)[] } }` (times are `'yyyy-MM-ddTHH:mm'` at the place, from today's 00:00 to cams_global's end); pure `cellOf(meta, model, dims, latitude, longitude)` and `mergeAuto(europe, global)`; `OPEN_DATA`, `FETCH_CEILING_MS`, `__useAirForTests(seam)`, `__resetAirForTests()`.

- [ ] **Step 4.1: Install the reader, pinned**

```bash
npm install --save-exact @openmeteo/file-reader@0.0.21
```

Expected: `"@openmeteo/file-reader": "0.0.21"` (no caret) in `dependencies`. In `next.config.js` add both packages to `serverExternalPackages` (so production loads them from node_modules exactly as the smoke does; the spike found bundling works too, so this is the safer of two working paths):

```js
  serverExternalPackages: ['opusscript', '@resvg/resvg-js', 'geo-tz', '@openmeteo/file-reader', '@openmeteo/file-format-wasm'],
```

with the comment line: "and the CAMS reader loads its WebAssembly from its own package folder (GPL-2.0: it stays on the server)".

- [ ] **Step 4.2: The type (`src/types.ts:193-200`)**

```ts
/** Copernicus CAMS air quality at the place (air-quality.ts): hourly from today's 00:00 at the place, µg/m³. */
export interface AirQualityData {
  hourly: {
    /** 'yyyy-MM-ddTHH:mm' at the place. */
    time: string[];
    pm10: (number | null)[];
    dust: (number | null)[];
  };
}
```

(pm2_5 goes: nothing read it.) In both weather fixtures delete `airQuality.hourly.pm2_5`, keeping their compact JSON:

```bash
node -e "const fs=require('fs');for(const f of process.argv.slice(1)){const x=JSON.parse(fs.readFileSync(f,'utf8'));delete x.airQuality.hourly.pm2_5;fs.writeFileSync(f,JSON.stringify(x))}" scripts/fixtures/weather-en-dust-storm.json scripts/fixtures/weather-he-sharav-heatwave.json
```

In `smoke-weather-command.ts` `AIR` loses `pm2_5: [6]`.

- [ ] **Step 4.3: Write `src/services/weather/air-quality.ts`**

```ts
/**
 * Air quality for the dust alerts: Copernicus CAMS dust and pm10 from Open-Meteo's public open data on S3 (CC BY 4.0,
 * https://github.com/open-meteo/open-data): the same hourly series Open-Meteo's API serves, with its default "auto"
 * domains: cams_europe (0.1°) inside its grid for its hours (about 4 days), cams_global (0.4°) elsewhere and after, no
 * cross-fade. About 5 days ahead. No user data leaves the server: the files are public and the cell is found here.
 * Spec 2026-10-31-open-meteo-replacement §5; the dust spike's rulings R1-R8; plan Task 4.
 *
 * - The rolling layout data/<model>/<variable>/chunk_N.om, hourly, overwritten in place at each run.
 * - meta.json per model (chunk length, grid, data end, run times), read at most every 10 minutes.
 * - An open reader belongs to one run (last_run_modification_time): a new run retires the old readers. A stale reader
 *   reads S3's 412 as a short read, so any read error retires the readers, refreshes the meta and retries.
 * - A point's series is cached per (model, variable, cell, run, window), never per user, on globalThis: the scheduler and
 *   the routes are separate bundles, each with its own WebAssembly.
 * - @openmeteo/file-reader 0.0.21 (GPL-2.0: server only, never a 'use client' file): its plain HTTP backend at one
 *   attempt, our retry around the whole read, never its LruBlockCache.
 * - Failure: logged, null, and no dust alert goes out. A run over 36 h old is a warning (the alerts read old data).
 */

import { OmDataType, OmFileReader, OmHttpBackend } from '@openmeteo/file-reader';
import type { AirQualityData } from '../../types';
import { geocodeLocation } from './geocoding';
import { captureError, captureWarning } from '../../lib/error-capture';
import { instantToWallTime, wallTimeToInstant } from '../../utils/wall-time';

export const OPEN_DATA = 'https://openmeteo.s3.amazonaws.com';
type Model = 'cams_europe' | 'cams_global';
type Variable = 'dust' | 'pm10';
const META_TTL_MS = 10 * 60 * 1000;
const RUN_AGE_WARN_MS = 36 * 3_600_000;
/**
 * The library races each request against this many ms (a race that never aborts, so no timeout of ours): Node's fetch
 * gives up on headers after 300 s, so the race never fires first.
 */
export const FETCH_CEILING_MS = 300_000;
const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 500;
const SERIES_CACHE_MAX = 512;
const LOG = '[air-quality]';

/** The fields of a model's static/meta.json FamCal reads (times in unix seconds). */
export interface ModelMeta {
  chunk_time_length: number;
  crs_wkt: string;
  data_end_time: number;
  last_run_initialisation_time: number;
  last_run_modification_time: number;
}

interface ReaderEntry {
  reader: Promise<OmFileReader>;
  users: number;
  retired: boolean;
  disposed: boolean;
}
interface AirState {
  metas: Map<Model, { at: number; meta: ModelMeta }>;
  metaLoads: Map<Model, Promise<ModelMeta>>;
  readers: Map<string, ReaderEntry>;
  series: Map<string, number[] | null>;
  warnedRun: Map<Model, number>;
}
const shared = globalThis as { __famcalAir?: AirState };
const state: AirState = (shared.__famcalAir ??= { metas: new Map(), metaLoads: new Map(), readers: new Map(), series: new Map(), warnedRun: new Map() });

interface Seam {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
}
const seamState = globalThis as { __airForTests?: Partial<Seam> | null };
/** Tests only: replaces the clock, the waits and the jitter. */
export function __useAirForTests(seam: Partial<Seam> | null): void {
  seamState.__airForTests = seam;
}
/** Tests only: forgets every meta, reader and series. */
export function __resetAirForTests(): void {
  retireAllReaders();
  state.metas.clear();
  state.metaLoads.clear();
  state.series.clear();
  state.warnedRun.clear();
}
const seam = (): Seam => ({ now: () => Date.now(), sleep: ms => new Promise(resolve => setTimeout(resolve, ms)), random: Math.random, ...seamState.__airForTests });

// ---- meta.json ----

async function loadMeta(model: Model): Promise<ModelMeta> {
  const response = await fetch(`${OPEN_DATA}/data/${model}/static/meta.json`);
  if (!response.ok) throw new Error(`${model} meta.json answered ${response.status}`);
  const meta = (await response.json()) as ModelMeta;
  if (!Number.isFinite(meta?.chunk_time_length) || !Number.isFinite(meta?.data_end_time) || typeof meta?.crs_wkt !== 'string') {
    throw new Error(`${model} meta.json is not one FamCal can read`);
  }
  return meta;
}

/** A model's meta: the stored one for 10 minutes, else read once for every caller waiting on it. */
async function modelMeta(model: Model): Promise<ModelMeta> {
  const now = seam().now();
  const hit = state.metas.get(model);
  if (hit && now - hit.at < META_TTL_MS) return hit.meta;
  let loading = state.metaLoads.get(model);
  if (!loading) {
    loading = loadMeta(model).finally(() => state.metaLoads.delete(model));
    state.metaLoads.set(model, loading);
  }
  const meta = await loading;
  state.metas.set(model, { at: now, meta });
  const age = now - meta.last_run_initialisation_time * 1000;
  if (age > RUN_AGE_WARN_MS && state.warnedRun.get(model) !== meta.last_run_initialisation_time) {
    state.warnedRun.set(model, meta.last_run_initialisation_time);
    captureWarning(`The ${model} run on Open-Meteo's open data is ${Math.round(age / 3_600_000)} h old: the dust alerts read an old forecast`, 'air-quality', { service: 'weather', model });
  }
  return meta;
}

// ---- The grid ----

/**
 * The nearest cell to the point in a model's grid (the API's cell_selection=nearest): the grid from the file's own
 * dimensions and the BBOX in meta.crs_wkt (the centres of the first and last cells; Europe's rows run north to south).
 * cams_global wraps in longitude. Null where the point is outside the grid (south of cams_europe: Eilat, the Arava).
 */
export function cellOf(meta: Pick<ModelMeta, 'crs_wkt'>, model: Model, dims: readonly number[], latitude: number, longitude: number): { iy: number; ix: number } | null {
  const [ny, nx] = dims;
  const box = /BBOX\[([^\]]+)\]/.exec(meta.crs_wkt);
  if (!box) throw new Error(`${model}: no BBOX in crs_wkt`);
  const [lat0, lon0, lat1, lon1] = box[1].split(',').map(Number);
  const dy = (lat1 - lat0) / (ny - 1);
  const dx = (lon1 - lon0) / (nx - 1);
  const iy = Math.round((latitude - lat0) / dy);
  let ix = Math.round((longitude - lon0) / dx);
  if (model === 'cams_global') ix = ((ix % nx) + nx) % nx;
  return iy >= 0 && iy < ny && ix >= 0 && ix < nx ? { iy, ix } : null;
}

/** The API's "auto": cams_europe's value where it has one, cams_global's for the rest, null where neither has. No cross-fade. */
export function mergeAuto(europe: readonly number[] | null, global: readonly number[]): (number | null)[] {
  return global.map((g, i) => {
    const e = europe?.[i];
    const value = e !== undefined && Number.isFinite(e) ? e : g;
    return Number.isFinite(value) ? value : null;
  });
}

// ---- Readers, one per chunk file and run ----

function dispose(entry: ReaderEntry): void {
  if (entry.disposed) return;
  entry.disposed = true;
  // A reader that failed to open has nothing to free; its failure reached the read that awaited it.
  entry.reader.then(reader => reader.dispose(), () => undefined);
}

function retire(key: string, entry: ReaderEntry): void {
  if (state.readers.get(key) === entry) state.readers.delete(key);
  entry.retired = true;
  if (entry.users === 0) dispose(entry);
}

function retireAllReaders(): void {
  for (const [key, entry] of [...state.readers]) retire(key, entry);
}

/** Runs `fn` with the open reader of a chunk for this run (opened once); a failed read retires the reader. */
async function withChunk<T>(meta: ModelMeta, model: Model, variable: Variable, idx: number, fn: (reader: OmFileReader) => T | Promise<T>): Promise<T> {
  const url = `${OPEN_DATA}/data/${model}/${variable}/chunk_${idx}.om`;
  const key = `${url}@${meta.last_run_modification_time}`;
  let entry = state.readers.get(key);
  if (!entry) {
    for (const [k, e] of [...state.readers]) if (k.startsWith(`${url}@`)) retire(k, e); // an older run's reader
    entry = { reader: OmFileReader.create(new OmHttpBackend({ url, retries: 1, timeoutMs: FETCH_CEILING_MS })), users: 0, retired: false, disposed: false };
    state.readers.set(key, entry);
  }
  entry.users++;
  try {
    return await fn(await entry.reader);
  } catch (error) {
    retire(key, entry);
    throw error;
  } finally {
    entry.users--;
    if (entry.retired && entry.users === 0) dispose(entry);
  }
}

// ---- A point's series ----

function remember(key: string, values: number[] | null): void {
  state.series.set(key, values);
  if (state.series.size > SERIES_CACHE_MAX) state.series.delete(state.series.keys().next().value as string);
}

/**
 * A variable's hourly values at the point in one model, for [fromSec, toSec) (hour-aligned unix seconds): NaN for an hour
 * the model does not have (after its data_end_time). Null where the point is outside the model's grid.
 */
async function modelSeries(model: Model, variable: Variable, latitude: number, longitude: number, fromSec: number, toSec: number): Promise<number[] | null> {
  const meta = await modelMeta(model);
  const chunkSec = meta.chunk_time_length * 3600;
  const end = Math.min(toSec, meta.data_end_time); // never ask for a chunk that does not exist yet
  const out: number[] = new Array((toSec - fromSec) / 3600).fill(NaN);
  if (end <= fromSec) return out;
  const first = Math.floor(fromSec / chunkSec);
  const last = Math.floor((end - 1) / chunkSec);
  const cell = await withChunk(meta, model, variable, first, reader => cellOf(meta, model, reader.getDimensions(), latitude, longitude));
  const key = `${model}|${variable}|${cell ? `${cell.iy},${cell.ix}` : 'outside'}|${meta.last_run_modification_time}|${fromSec}|${toSec}`;
  if (state.series.has(key)) return state.series.get(key)!;
  if (!cell) {
    remember(key, null);
    return null;
  }
  await Promise.all(
    Array.from({ length: last - first + 1 }, (_, k) => first + k).map(idx =>
      withChunk(meta, model, variable, idx, async reader => {
        const nt = reader.getDimensions()[2];
        const t0 = idx * chunkSec;
        const a = Math.max(fromSec, t0);
        const b = Math.min(end, t0 + nt * 3600);
        if (b <= a) return;
        const values = (await reader.read({
          type: OmDataType.FloatArray,
          ranges: [{ start: cell.iy, end: cell.iy + 1 }, { start: cell.ix, end: cell.ix + 1 }, { start: (a - t0) / 3600, end: (b - t0) / 3600 }],
        })) as Float32Array;
        values.forEach((v, i) => { out[(a - fromSec) / 3600 + i] = v; });
      }),
    ),
  );
  remember(key, out);
  return out;
}

/** A variable at the point, the API's "auto" way, from fromSec to cams_global's end. */
async function autoSeries(variable: Variable, latitude: number, longitude: number, fromSec: number): Promise<(number | null)[]> {
  const global = await modelMeta('cams_global');
  const toSec = global.data_end_time;
  if (toSec <= fromSec) throw new Error('cams_global ends before the day starts');
  const [g, e] = await Promise.all([
    modelSeries('cams_global', variable, latitude, longitude, fromSec, toSec),
    modelSeries('cams_europe', variable, latitude, longitude, fromSec, toSec),
  ]);
  if (!g) throw new Error('cams_global does not cover the point');
  return mergeAuto(e, g);
}

/** The whole read, retried: any failure retires the readers and the metas (a new run replaces the files), then backs off. */
async function readWithRetry<T>(step: () => Promise<T>): Promise<T> {
  for (let retried = 0; ; retried++) {
    try {
      return await step();
    } catch (error) {
      if (retried === MAX_RETRIES) throw error;
      retireAllReaders();
      state.metas.clear();
      const waitMs = Math.round(seam().random() * BACKOFF_BASE_MS * 2 ** retried);
      console.warn(`${LOG} the read failed (${error instanceof Error ? error.message : String(error)}); retry ${retried + 1} of ${MAX_RETRIES} in ${waitMs} ms`);
      await seam().sleep(waitMs);
    }
  }
}

/**
 * CAMS dust and pm10 at a location, hourly from today's 00:00 at the place (`timezone`) to cams_global's end (about 5
 * days), as wall times at the place. Null, and logged, on any failure: no dust alert goes out. Never throws.
 */
export async function fetchAirQuality(location: string, timezone: string): Promise<AirQualityData | null> {
  let latitude: number;
  let longitude: number;
  try {
    ({ latitude, longitude } = await geocodeLocation(location));
  } catch {
    // geocodeLocation's error names the place: not in the log. The forecast for the same place logs the lookup.
    captureWarning('The place lookup failed: no air quality', 'air-quality', { service: 'weather' });
    return null;
  }
  try {
    const now = seam().now();
    const today = instantToWallTime(new Date(now), timezone).slice(0, 10);
    const fromSec = Math.floor(wallTimeToInstant(`${today}T00:00`, timezone).getTime() / 3_600_000) * 3600;
    const [dust, pm10] = await readWithRetry(() => Promise.all([autoSeries('dust', latitude, longitude, fromSec), autoSeries('pm10', latitude, longitude, fromSec)]));
    let hours = Math.min(dust.length, pm10.length);
    while (hours > 0 && dust[hours - 1] === null && pm10[hours - 1] === null) hours--;
    if (hours === 0) {
      captureWarning("Open-Meteo's open data has no dust or pm10 for the place", 'air-quality', { service: 'weather' });
      return null;
    }
    const time = Array.from({ length: hours }, (_, i) => instantToWallTime(new Date((fromSec + i * 3600) * 1000), timezone).slice(0, 16));
    return { hourly: { time, pm10: pm10.slice(0, hours), dust: dust.slice(0, hours) } };
  } catch (error) {
    captureError(error, 'air-quality', { service: 'weather' }, 'warning');
    return null;
  }
}
```

- [ ] **Step 4.4: Write and run the recorder (`scripts/record-cams-fixture.ts`)**

```ts
// Records the S3 exchanges of one air-quality read (Tel Aviv, Asia/Jerusalem) for scripts/smoke-air-quality.ts, which
// replays them through a mocked fetch (the dust spike's ruling R7). It reads Open-Meteo's public open data (no key, no
// user data). Run once on a developer machine, never in CI; the fixture it writes is committed. Re-record after a
// change to the reader's reads:
//   npx tsx scripts/record-cams-fixture.ts
// It stops with nothing written on any failure.

import fs from 'node:fs';
import path from 'node:path';
import Module, { createRequire } from 'node:module';

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'scripts/fixtures/cams-tel-aviv.json');
const PLACE = { latitude: 32.0853, longitude: 34.7818 };
const ZONE = 'Asia/Jerusalem';
const KEPT_HEADERS = ['content-length', 'content-range', 'content-type', 'etag', 'last-modified', 'accept-ranges'];
type Exchange = { method: string; url: string; range: string | null; status: number; headers: Record<string, string>; body: string };

const nodeRequire = createRequire(__filename);
const exchanges: Exchange[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  const method = init?.method ?? 'GET';
  const range = new Headers(init?.headers).get('range');
  const response = await realFetch(input, init);
  const body = method === 'HEAD' ? '' : Buffer.from(await response.clone().arrayBuffer()).toString('base64');
  const headers = Object.fromEntries([...response.headers.entries()].filter(([name]) => KEPT_HEADERS.includes(name)));
  exchanges.push({ method, url, range, status: response.status, headers, body });
  return response;
}) as typeof fetch;

const internals = Module as unknown as { _cache: Record<string, unknown> };
const stub = (rel: string, exports: Record<string, unknown>) => {
  const filename = path.join(ROOT, rel);
  const mod = new (Module as unknown as new (id: string) => Record<string, unknown>)(filename);
  Object.assign(mod, { filename, loaded: true, exports });
  internals._cache[filename] = mod;
};
stub('src/services/weather/geocoding.ts', { geocodeLocation: async () => ({ ...PLACE, timezone: ZONE }) });
stub('src/lib/error-capture.ts', {
  captureError: (e: unknown) => { throw e instanceof Error ? e : new Error(String(e)); },
  captureWarning: (m: string) => { throw new Error(m); },
  captureInfo: () => {},
});

async function main(): Promise<void> {
  const air = nodeRequire(path.join(ROOT, 'src/services/weather/air-quality.ts')) as typeof import('../src/services/weather/air-quality');
  const recordedAt = Date.now();
  air.__useAirForTests({ now: () => recordedAt });
  const expected = await air.fetchAirQuality('Tel Aviv', ZONE);
  if (!expected) throw new Error('the read gave nothing');
  const bytes = exchanges.reduce((sum, e) => sum + e.body.length, 0);
  fs.writeFileSync(OUT, `${JSON.stringify({ recordedAt, place: PLACE, zone: ZONE, exchanges, expected })}\n`);
  console.log(`[cams-fixture] ${exchanges.length} exchanges, ${Math.round(bytes / 1024)} KB of base64, ${expected.hourly.time.length} hours, to ${path.relative(ROOT, OUT)}`);
  process.exit(0);
}

main().catch(error => {
  console.error('[cams-fixture] stopped, nothing written:', error);
  process.exit(1);
});
```

Run: `npx tsx scripts/record-cams-fixture.ts`. Expected: about 20–30 exchanges (spike: 22 cold), under 100 KB, 96–144 hours, both `cams_europe` and `cams_global` chunk URLs among them. Sanity-look at the expected series: dust and pm10 numbers in µg/m³ (tens, a few hundred during an event), no `NaN` (JSON shows `null` only after the end).

- [ ] **Step 4.5: Write `scripts/smoke-air-quality.ts`**

```ts
// Smoke test for the dust alerts' air quality from Open-Meteo's open data on S3 (src/services/weather/air-quality.ts;
// plan docs/superpowers/plans/2026-10-31-open-meteo-replacement.md, Task 4; the dust spike's rulings R1-R8). The real
// reader (@openmeteo/file-reader and its WebAssembly) reads S3 exchanges recorded once for Tel Aviv
// (scripts/fixtures/cams-tel-aviv.json, by scripts/record-cams-fixture.ts) and replayed through a mocked fetch: the
// recorded series again, today's 00:00 first, the API's "auto" domains, the cell and run caches, a new run, S3's 412 on
// a replaced file, the retries, a stale run, and each failure as null with a log. Faked: fetch (the replay), the
// geocoder, error capture, the clock and the waits (the module's seam). No network.
//
//   TZ=UTC npx tsx scripts/smoke-air-quality.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-air-quality.ts

import fs from 'node:fs';
import path from 'node:path';
import Module, { createRequire } from 'node:module';

type Row = Record<string, unknown>;
type Request = { method: string; url: string; range: string | null };
type Exchange = Request & { status: number; headers: Record<string, string>; body: string };
const ROOT = path.resolve(__dirname, '..');
const nodeRequire = createRequire(__filename);
const results: { name: string; ok: boolean; reason?: string }[] = [];
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

const FIXTURE = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/fixtures/cams-tel-aviv.json'), 'utf8')) as {
  recordedAt: number; place: { latitude: number; longitude: number }; zone: string; exchanges: Exchange[];
  expected: { hourly: { time: string[]; pm10: (number | null)[]; dust: (number | null)[] } };
};

// ---- The replay ----

const asked: Request[] = [];
/** A scenario's change: a Response to send in place of the recording's, or undefined for the recording. */
let override: (request: Request, n: number) => Response | undefined = () => undefined;
const recorded = (request: Request): Response => {
  const e = FIXTURE.exchanges.find(x => x.method === request.method && x.url === request.url && x.range === request.range);
  if (!e) throw new Error(`not in the recording: ${request.method} ${request.url} ${request.range ?? ''}`);
  return new Response(request.method === 'HEAD' ? null : Buffer.from(e.body, 'base64'), { status: e.status, headers: e.headers });
};
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const request = { method: init?.method ?? 'GET', url: String(input instanceof globalThis.Request ? input.url : input), range: new Headers(init?.headers).get('range') };
  asked.push(request);
  return override(request, asked.length) ?? recorded(request);
}) as typeof fetch;

const metaOf = (model: string) => JSON.parse(Buffer.from(FIXTURE.exchanges.find(x => x.url.endsWith(`/data/${model}/static/meta.json`))!.body, 'base64').toString('utf8')) as Row;
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

// ---- Fakes ----

const captured: { kind: 'error' | 'warning'; context: string; message: string }[] = [];
const internals = Module as unknown as { _cache: Record<string, unknown> };
const stub = (rel: string, exports: Row) => {
  const filename = path.join(ROOT, rel);
  const mod = new (Module as unknown as new (id: string) => Row)(filename);
  Object.assign(mod, { filename, loaded: true, exports });
  internals._cache[filename] = mod;
};
stub('src/lib/error-capture.ts', {
  captureError: (e: unknown, context: string) => { captured.push({ kind: 'error', context, message: e instanceof Error ? e.message : String(e) }); },
  captureWarning: (message: string, context: string) => { captured.push({ kind: 'warning', context, message }); },
  captureInfo: () => {},
});
stub('src/services/weather/geocoding.ts', {
  geocodeLocation: async (location: string) => {
    if (location === 'Nowhere') throw new Error('Could not geocode location: Nowhere');
    return { ...FIXTURE.place, timezone: FIXTURE.zone };
  },
});

async function main(): Promise<void> {
  const air = nodeRequire(path.join(ROOT, 'src/services/weather/air-quality.ts')) as typeof import('../src/services/weather/air-quality');
  const { instantToWallTime } = nodeRequire(path.join(ROOT, 'src/utils/wall-time.ts')) as typeof import('../src/utils/wall-time');
  const { detectDustStorm } = nodeRequire(path.join(ROOT, 'src/services/weather/dust-storm.ts')) as typeof import('../src/services/weather/dust-storm');
  let clock = FIXTURE.recordedAt;
  const waits: number[] = [];
  air.__useAirForTests({ now: () => clock, sleep: async (ms: number) => { waits.push(ms); }, random: () => 0.5 });
  const quietly = async <T>(fn: () => Promise<T>): Promise<T> => {
    const warn = console.warn;
    console.warn = () => {};
    try { return await fn(); } finally { console.warn = warn; }
  };
  const fresh = () => {
    air.__resetAirForTests();
    asked.length = 0;
    waits.length = 0;
    captured.length = 0;
    override = () => undefined;
    clock = FIXTURE.recordedAt;
  };
  const read = () => quietly(() => air.fetchAirQuality('Tel Aviv', FIXTURE.zone));
  const today = instantToWallTime(new Date(FIXTURE.recordedAt), FIXTURE.zone).slice(0, 10);

  await check('the replay gives the recorded series: hourly from today\'s 00:00 in Israel to cams_global\'s end (about 5 days), both models read (the API\'s "auto" in Tel Aviv), dayIndex 0 is today, a few dozen small requests, nothing logged', async () => {
    fresh();
    const got = await read();
    assert(show(got) === show(FIXTURE.expected), `differs from the recording: ${show(got).slice(0, 300)}`);
    assert(got!.hourly.time[0] === `${today}T00:00`, `first hour ${got!.hourly.time[0]}`);
    assert(got!.hourly.time.length >= 96 && got!.hourly.time.length <= 144, `${got!.hourly.time.length} hours`);
    assert(asked.some(r => r.url.includes('/data/cams_europe/')) && asked.some(r => r.url.includes('/data/cams_global/')), 'not both models');
    assert(asked.length <= 40 && asked.every(r => r.method === 'HEAD' || r.url.endsWith('meta.json') || r.range !== null), `requests ${asked.length}, a whole-file read among them: ${show(asked.filter(r => r.method === 'GET' && !r.range && !r.url.endsWith('meta.json')))}`);
    assert(detectDustStorm(got).every(d => d.date >= today), 'a dust day before today');
    assert(captured.length === 0, `captured ${show(captured)}`);
  });

  await check('the grid: Tel Aviv, Jerusalem and Eilat in cams_global are cells [305,537], [304,538] and [299,537] (the API\'s nearest); cams_europe holds Tel Aviv and not Eilat (south of 30.05 N); cams_global wraps at the antimeridian', () => {
    const global = { crs_wkt: 'GEOGCRS[…BBOX[-90.0,-180.0,90.0,179.6]]' };
    const europe = { crs_wkt: 'GEOGCRS[…BBOX[71.95,-24.95,30.049995,44.95]]' };
    assert(show(air.cellOf(global, 'cams_global', [451, 900, 1], 32.0853, 34.7818)) === show({ iy: 305, ix: 537 }), 'Tel Aviv');
    assert(show(air.cellOf(global, 'cams_global', [451, 900, 1], 31.7768, 35.2358)) === show({ iy: 304, ix: 538 }), 'Jerusalem');
    assert(show(air.cellOf(global, 'cams_global', [451, 900, 1], 29.557, 34.952)) === show({ iy: 299, ix: 537 }), 'Eilat');
    assert(air.cellOf(europe, 'cams_europe', [420, 700, 1], 32.0853, 34.7818) !== null, 'Tel Aviv in Europe\'s grid');
    assert(air.cellOf(europe, 'cams_europe', [420, 700, 1], 29.557, 34.952) === null, 'Eilat in Europe\'s grid');
    assert(show(air.cellOf(global, 'cams_global', [451, 900, 1], 0, 179.9)) === show({ iy: 225, ix: 0 }), 'the antimeridian');
  });

  await check('"auto" with no cross-fade: cams_europe\'s value where it has one, cams_global\'s after its end or outside its grid, null where neither has', () => {
    assert(show(air.mergeAuto([1, NaN, 3, NaN], [10, 20, 30, NaN])) === show([1, 20, 3, null]), 'with Europe');
    assert(show(air.mergeAuto(null, [10, NaN])) === show([10, null]), 'outside Europe');
  });

  await check('the caches: a second read within 10 minutes asks S3 nothing (meta, readers and the cell\'s series all kept per run)', async () => {
    fresh();
    await read();
    asked.length = 0;
    clock += 5 * 60 * 1000;
    const again = await read();
    assert(asked.length === 0 && show(again) === show(FIXTURE.expected), `${asked.length} requests: ${show(asked.slice(0, 5))}`);
  });

  await check('a new run of cams_global (its last_run_modification_time moves): after the meta\'s 10 minutes its readers are opened again (HEAD) and its series read again; cams_europe\'s, of the same run, stay', async () => {
    fresh();
    await read();
    const bumped = { ...metaOf('cams_global'), last_run_modification_time: Number(metaOf('cams_global').last_run_modification_time) + 60 };
    override = request => (request.url.endsWith('/data/cams_global/static/meta.json') ? json(bumped) : undefined);
    asked.length = 0;
    clock += 11 * 60 * 1000;
    const again = await read();
    assert(show(again) === show(FIXTURE.expected), 'the series changed');
    assert(asked.some(r => r.method === 'HEAD' && r.url.includes('/data/cams_global/')), 'cams_global\'s readers were not opened again');
    assert(!asked.some(r => r.method === 'HEAD' && r.url.includes('/data/cams_europe/')), 'cams_europe\'s readers were opened again');
  });

  await check('S3\'s 412 (a file replaced mid-read by a new run) on one range: the read retires its readers, reads the meta again and succeeds on the retry after one backoff wait, with nothing captured', async () => {
    fresh();
    let failedOnce = false;
    override = request => {
      if (!failedOnce && request.method === 'GET' && request.range && request.url.includes('/data/cams_global/dust/')) {
        failedOnce = true;
        return new Response('<Error><Code>PreconditionFailed</Code></Error>', { status: 412 });
      }
      return undefined;
    };
    const got = await read();
    assert(failedOnce && show(got) === show(FIXTURE.expected), 'no recovery from the 412');
    assert(show(waits) === show([250]) && captured.length === 0, `waits ${show(waits)}, captured ${show(captured)}`);
  });

  await check('S3 down (meta.json answering 503): three retries with backoff, then null, one capture under air-quality; no throw', async () => {
    fresh();
    override = request => (request.url.endsWith('meta.json') ? new Response('slow down', { status: 503 }) : undefined);
    const got = await read();
    assert(got === null, `got ${show(got)}`);
    assert(show(waits) === show([250, 500, 1000]), `waits ${show(waits)}`);
    assert(captured.length === 1 && captured[0].context === 'air-quality', `captured ${show(captured)}`);
  });

  await check('a run over 36 h old: one warning under air-quality naming its age, not repeated for the same run', async () => {
    fresh();
    const old = (model: string) => ({ ...metaOf(model), last_run_initialisation_time: Math.floor(FIXTURE.recordedAt / 1000) - 40 * 3600 });
    override = request => (request.url.endsWith('/data/cams_global/static/meta.json') ? json(old('cams_global')) : undefined);
    await read();
    clock += 11 * 60 * 1000;
    await read();
    const stale = captured.filter(c => c.context === 'air-quality' && c.message.includes('40 h old'));
    assert(stale.length === 1, `captured ${show(captured)}`);
  });

  await check('the place lookup failing: null and one warning that does not name the place', async () => {
    fresh();
    const got = await quietly(() => air.fetchAirQuality('Nowhere', FIXTURE.zone));
    assert(got === null && captured.length === 1 && captured[0].kind === 'warning' && !captured[0].message.includes('Nowhere'), `captured ${show(captured)}`);
  });

  await check('the reader as the spike ruled: the plain HTTP backend at one attempt with the library\'s race at Node\'s own ceiling, never its LruBlockCache, and @openmeteo/file-reader pinned to 0.0.21', () => {
    const code = fs.readFileSync(path.join(ROOT, 'src/services/weather/air-quality.ts'), 'utf8');
    assert(/new OmHttpBackend\(\{ url, retries: 1, timeoutMs: FETCH_CEILING_MS \}\)/.test(code) && !/LruBlockCache|OmHttpBackendPool/.test(code), 'the backend options');
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert(pkg.dependencies['@openmeteo/file-reader'] === '0.0.21', `pinned ${pkg.dependencies['@openmeteo/file-reader']}`);
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  // The library's request races leave timers for up to FETCH_CEILING_MS: exit now
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
```

(Expected cell for `(0, 179.9)`: `iy = round(90/0.4) = 225`, `ix = round(359.9/0.4) = 900 → 0`.) The 412 check relies on the reader asking at least one range of a `cams_global/dust` chunk; if the recording shows the first such range is answered from a reader opened earlier, keep the override as is (it fails the first GET with a range on that path, whatever it is).

- [ ] **Step 4.6: Run it: fail first, then pass**

Before Step 4.3's code exists the smoke fails (`Cannot find …` or the old module's shape); after: `$SCRATCH/om-smoke.sh scripts/smoke-air-quality.ts` and `TZ_OVERRIDE=UTC $SCRATCH/om-smoke.sh scripts/smoke-air-quality.ts` pass. Bite checks: drop `retireAllReaders()` from `readWithRetry` → the 412 check fails; remove the 36 h warning → its check fails; make `mergeAuto` prefer global → the merge check fails. Restore.

- [ ] **Step 4.7: Gate, commit, fresh build**

```bash
npx tsc --noEmit && npm run lint && PATH="$(dirname "$(npx -y node@22 -p process.execPath)"):$PATH" bash scripts/ci-smokes.sh && npx next build
git add package.json package-lock.json next.config.js src/types.ts src/services/weather/air-quality.ts scripts/record-cams-fixture.ts scripts/fixtures/cams-tel-aviv.json scripts/smoke-air-quality.ts scripts/fixtures/weather-en-dust-storm.json scripts/fixtures/weather-he-sharav-heatwave.json scripts/smoke-weather-command.ts
git commit -m "feat(dust): CAMS dust and pm10 from Open-Meteo's open data on S3, the API's auto domains, no API call

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31"
$SCRATCH/fresh-build.sh
```
Expected: `FRESH BUILD OK`, with `om_file_format.node.wasm` listed (from `node_modules/@openmeteo/file-format-wasm/dist` in the standalone output, as the package is external). If the wasm is missing from `.next/standalone`, add `'./node_modules/@openmeteo/file-format-wasm/dist/om_file_format.node.wasm'` to `outputFileTracingIncludes['/*']` and rebuild.

---

### Task 5: Credits, the Privacy Policy, the guard and the docs

**Files:**
- Create: `src/site/data-sources.ts`, `scripts/smoke-no-open-meteo.ts`
- Modify: `messages/{en,he,ru}.json` (`bot.weatherCredit`, `site.footer.dataSources`, `zmanimSite.sources.osm`, `legal.privacy.sections.processors.blocks[1][10]` and `[3][3]`), `src/site/legal.ts:6`, `src/services/weather/infographic.tsx`, `src/services/telegram/commands.ts` (the text reply), `components/site/SiteFooter.tsx`, `src/site/site-css.ts:439-446`, `README.md:32,60`, `CLAUDE.md`
- Test: `scripts/smoke-weather-command.ts` (check 3), `scripts/smoke-site-chrome.ts` (H3 and the tap-target list), `scripts/smoke-no-open-meteo.ts` (new), the site and copy guards (`smoke-site-truth`, `smoke-he-neutral`, `smoke-ru-formal`, `smoke-site-pages`, `smoke-site-seo`, `smoke-location-check`)

**Interfaces:**
- Consumes: every earlier task (the guard requires that no Open-Meteo API host is left).
- Produces: `bot.weatherCredit`; `OPEN_METEO_CREDIT`, `camsNotice(year: number): string` (`src/site/data-sources.ts`, client-safe, no import); `LEGAL_UPDATED.privacy = '2026-10-31'` (or the day the commit lands).

- [ ] **Step 5.1: Write the failing guard `scripts/smoke-no-open-meteo.ts`**

```ts
// Guard: Open-Meteo's free API forbids commercial use (spec docs/superpowers/specs/2026-10-31-open-meteo-replacement-design.md
// §1), so no file in src/ or app/ names one of its API hosts (each ends in api.open-meteo.com: api., air-quality-api.,
// geocoding-api., customer-api., ...). Allowed: its public open data on S3 (openmeteo.s3.amazonaws.com, the dust) and the
// credit its licence requires ("Weather data by Open-Meteo.com", linking https://open-meteo.com/). Also: the server-only
// lookups never reach a 'use client' file, next.config.js keeps what they need, the Policy names MET Norway and no longer
// Open-Meteo, and the credits exist in every language. Nothing is faked: it reads files. No network.

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const results: { name: string; ok: boolean; reason?: string }[] = [];
function check(name: string, fn: () => void) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
}
function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}
const show = (v: unknown) => JSON.stringify(v);
const files = (dir: string): string[] =>
  fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap(e => {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : files(rel);
    return [rel];
  });
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const OPEN_METEO_API = /[\w.-]*api\.open-meteo\.com/i;

check('no file in src/ or app/ names an Open-Meteo API host (the scanner finds them in probes and lets the open data and the credit be)', () => {
  for (const host of ['https://api.open-meteo.com/v1/forecast', 'https://air-quality-api.open-meteo.com/v1/air-quality', 'https://customer-api.open-meteo.com/v1/forecast', 'https://geocoding-api.open-meteo.com/v1/search']) {
    assert(OPEN_METEO_API.test(host), `the scanner misses ${host}`);
  }
  for (const allowed of ['https://openmeteo.s3.amazonaws.com/data/cams_global/static/meta.json', 'https://open-meteo.com/', 'Weather data by Open-Meteo.com']) {
    assert(!OPEN_METEO_API.test(allowed), `the scanner flags ${allowed}`);
  }
  const hits = [...files('src'), ...files('app')].filter(f => OPEN_METEO_API.test(read(f)));
  assert(hits.length === 0, `Open-Meteo API hosts in ${show(hits)}`);
});

check('no \'use client\' file imports the weather, the zmanim, the zone lookup, geo-tz or the CAMS reader', () => {
  const FORBIDDEN = /from\s+['"][^'"]*(services\/weather\/|services\/zmanim\/|lib\/timezone|lib\/zone-for-coords|geo-tz|@openmeteo\/)/;
  const clients = [...files('app'), ...files('components'), ...files('src')].filter(f => /\.(t|j)sx?$/.test(f) && /^\s*['"]use client['"]/m.test(read(f)));
  assert(clients.length > 0, 'found no client file: the scanner is broken');
  const bad = clients.filter(f => read(f).split('\n').some(line => FORBIDDEN.test(line) && !/^\s*import\s+type\b/.test(line)));
  assert(bad.length === 0, `client files importing server-only code: ${show(bad)}`);
});

check('next.config.js keeps geo-tz and the CAMS reader external, leaves geo-tz\'s two unused data sets out and traces the height map', () => {
  const config = read('next.config.js');
  for (const pkg of ['geo-tz', '@openmeteo/file-reader', '@openmeteo/file-format-wasm']) assert(config.includes(`'${pkg}'`), `${pkg} is not external`);
  assert(config.includes('geo-tz/data/timezones-now.*') && config.includes('geo-tz/data/timezones.geojson.*'), 'the unused data sets are traced');
  assert(config.includes('./data/israel-heights-3s.i16.br'), 'the height map is not traced');
  const size = fs.statSync(path.join(ROOT, 'data/israel-heights-3s.i16.br')).size;
  assert(size > 3e6 && size < 8e6, `the height map is ${size} bytes`);
});

check('the dependencies: geo-tz, lru-cache and the pinned @openmeteo/file-reader in dependencies; geotiff only in devDependencies', () => {
  const pkg = JSON.parse(read('package.json'));
  assert(pkg.dependencies['geo-tz'] && pkg.dependencies['lru-cache'] && pkg.dependencies['@openmeteo/file-reader'] === '0.0.21', show(pkg.dependencies));
  assert(!pkg.dependencies.geotiff && pkg.devDependencies.geotiff, 'geotiff moved');
});

check('the Privacy Policy in en, he and ru: MET Norway gets the place\'s position rounded to about 1 km, Open-Meteo is gone from the legal texts, and the page is dated', () => {
  const ROUNDED: Record<string, string> = { en: 'rounded to about 1 km', he: 'מעוגל לדיוק של קילומטר בערך', ru: 'с точностью около 1 км' };
  for (const lang of ['en', 'he', 'ru']) {
    const m = JSON.parse(read(`messages/${lang}.json`));
    const legal = JSON.stringify(m.legal);
    assert(!legal.includes('Open-Meteo'), `${lang}: the legal texts still name Open-Meteo`);
    const line = (m.legal.privacy.sections.processors.blocks[1] as unknown[]).find(x => typeof x === 'string' && x.startsWith('**MET Norway:**')) as string | undefined;
    assert(line && line.includes(ROUNDED[lang]), `${lang}: the MET Norway line ${show(line)}`);
    assert((m.legal.privacy.sections.processors.blocks[3] as unknown[]).some(x => typeof x === 'string' && x.includes('MET Norway')), `${lang}: "only what's listed above" does not name MET Norway`);
    assert(typeof m.bot.weatherCredit === 'string' && m.bot.weatherCredit.includes('MET Norway') && m.bot.weatherCredit.includes('Copernicus'), `${lang}: bot.weatherCredit ${show(m.bot.weatherCredit)}`);
    assert(typeof m.site.footer.dataSources === 'string' && m.site.footer.dataSources.includes('{omCredit}'), `${lang}: site.footer.dataSources`);
  }
  assert(/privacy: '2026-1[01]-\d\d'/.test(read('src/site/legal.ts')) && !read('src/site/legal.ts').includes("privacy: '2026-10-30'"), 'LEGAL_UPDATED.privacy was not moved');
});

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
```

Run: `$SCRATCH/om-smoke.sh scripts/smoke-no-open-meteo.ts`. Expected: FAIL on the Policy check (and, if any comment in src/ still names a host, the first check: fix those comments, e.g. `getWeatherDescription`'s old doc link).

- [ ] **Step 5.2: The in-product credit (spec decision 3)**

`messages/*.json`, in `bot` beside `weatherOnly`:

| key | en | he | ru |
|---|---|---|---|
| `weatherCredit` | `Weather: MET Norway · Dust: Copernicus` | `מזג האוויר: MET Norway · אבק: Copernicus` | `Погода: MET Norway · Пыль: Copernicus` |

`src/services/weather/infographic.tsx`: `buildInfographicJsx` takes `credit: string` (from `t.weatherCredit` in `generateWeatherInfographic`) and draws it at the foot of the content column, after the forecast rows (this covers the /weather photo and the share image, which is the same image):

```tsx
        {/* The data sources' credit (spec decision 3), small, at the foot */}
        <div style={{ display: 'flex', justifyContent: 'center', fontSize: 22, opacity: 0.55, marginTop: 12 }}>
          {isRTL ? toVisualOrder(credit) : credit}
        </div>
```

`src/services/telegram/commands.ts`, the text reply (when the photo failed) in `onSuccess`:

```ts
      } else if (result.brief) {
        const t = await getBotMessages(userLanguage);
        // The credit MET Norway's and Copernicus's licences ask for, under the text reply (the photo has it drawn)
        await messagingService.sendMessage(chatId, `${result.brief}\n\n<i>${escapeHtml(t.weatherCredit)}</i>`, { format: MessageFormat.HTML });
      }
```

(import `escapeHtml` from `'../../utils/html'` and `getBotMessages` if the file lacks them). Nothing in the morning and evening summaries. `scripts/smoke-weather-command.ts` check 3: the reply is `${forecastCalls[0].result?.brief}\n\n<i>Weather: MET Norway · Dust: Copernicus</i>`. Re-render the infographic (Step 3.13's script) and look at the foot in en/he/ru.

- [ ] **Step 5.3: The site's "Data sources" line** (invoke the frontend-design skill for it; mirror the footer's tokens, no new colours)

`src/site/data-sources.ts`:

```ts
// The credits the data's licences require in their own words (spec 2026-10-31-open-meteo-replacement, decision 3; the
// dust spike's ruling R8): Open-Meteo's credit for its open-data files (CC BY 4.0) and the Copernicus Atmosphere
// Monitoring Service's notice for modified CAMS information. Licence text, so it stays in English on every page, a
// constant and never a message; the words around it are site.footer.dataSources. Client-safe: no import.

/** Open-Meteo's required credit (https://open-meteo.com/en/licence), for the CAMS files FamCal reads. */
export const OPEN_METEO_CREDIT = 'Weather data by Open-Meteo.com';

/** Where each tag of site.footer.dataSources links: the sources and their licences. */
export const SOURCE_LINKS = {
  met: 'https://api.met.no/',
  nlod: 'https://data.norge.no/nlod/en/2.0',
  ccby: 'https://creativecommons.org/licenses/by/4.0/',
  cams: 'https://atmosphere.copernicus.eu/',
  om: 'https://open-meteo.com/',
  osm: 'https://www.openstreetmap.org/copyright',
  odbl: 'https://opendatacommons.org/licenses/odbl/1-0/',
} as const;

/** The Copernicus notice for modified CAMS information, with the year of the information shown. */
export function camsNotice(year: number): string {
  return `Contains modified Copernicus Atmosphere Monitoring Service information ${year}. Neither the European Commission nor ECMWF is responsible for any use that may be made of the information it contains.`;
}
```

Before committing, check the notice against the official wording (https://apps.ecmwf.int/datasets/licences/copernicus/ and https://atmosphere.copernicus.eu/how-cite-cams-products-or-data, with WebFetch) and use the official sentence if it differs.

`messages/*.json`, `site.footer.dataSources` (rich text; `<met>`, `<nlod>`, `<ccby>`, `<cams>`, `<om>`, `<osm>`, `<odbl>` are links; `{omCredit}` is `OPEN_METEO_CREDIT`):

- en: `Data sources: weather from <met>MET Norway</met> (<nlod>NLOD 2.0</nlod> and <ccby>CC BY 4.0</ccby>); dust from the <cams>Copernicus Atmosphere Monitoring Service</cams>, <om>{omCredit}</om> (<ccby>CC BY 4.0</ccby>); time zones © <osm>OpenStreetMap</osm> contributors (<odbl>ODbL</odbl>). FamCal changes the data: units, local times and daily figures.`
- he: `מקורות המידע: מזג האוויר מ־<met>MET Norway</met> (<nlod>NLOD 2.0</nlod> ו־<ccby>CC BY 4.0</ccby>); האבק מ־<cams>Copernicus Atmosphere Monitoring Service</cams>, <om>{omCredit}</om> (<ccby>CC BY 4.0</ccby>); אזורי הזמן © התורמים של <osm>OpenStreetMap</osm> (<odbl>ODbL</odbl>). הנתונים עובדו ב־FamCal: יחידות, שעון מקומי וסיכומים יומיים.`
- ru (U+00A0 before each "—" and after "и"): `Источники данных: погода — <met>MET Norway</met> (<nlod>NLOD 2.0</nlod> и <ccby>CC BY 4.0</ccby>); пыль — <cams>Copernicus Atmosphere Monitoring Service</cams>, <om>{omCredit}</om> (<ccby>CC BY 4.0</ccby>); часовые пояса — © участники <osm>OpenStreetMap</osm> (<odbl>ODbL</odbl>). FamCal обрабатывает эти данные: единицы измерения, местное время и сводки по дням.`

`zmanimSite.sources.osm` gains "and time zones": en `Town outlines for the heights, and time zones: © <link>OpenStreetMap</link> contributors.`; he `גבולות היישובים לחישוב הגובה, ואזורי הזמן: © התורמים של <link>OpenStreetMap</link>.`; ru `Границы населённых пунктов для расчёта высоты и часовые пояса: © участники <link>OpenStreetMap</link>.` (U+00A0 after "и").

`components/site/SiteFooter.tsx`, after the language links (comment line in the header: "…, the data sources and their licences (spec 2026-10-31-open-meteo-replacement, decision 3)"):

```tsx
import type { ReactNode } from 'react';
import { OPEN_METEO_CREDIT, SOURCE_LINKS, camsNotice } from '@/src/site/data-sources';

/** The data-sources line's tags as links (the addresses live in src/site/data-sources.ts, not in this TSX). */
const sourceLinks = Object.fromEntries(
  Object.entries(SOURCE_LINKS).map(([tag, href]) => [tag, (chunks: ReactNode) => <a href={href}>{chunks}</a>]),
);
```

```tsx
        <p className="site-footer-sources">
          {t.rich('site.footer.dataSources', { omCredit: OPEN_METEO_CREDIT, ...sourceLinks })}{' '}
          <span lang="en" dir="ltr">
            {camsNotice(new Date().getFullYear())}
          </span>
        </p>
```

(The guard flags only Open-Meteo's API hosts: the licence's link to open-meteo.com is a credit, not a call.) `src/site/site-css.ts`, after `.site-footer-meta p + p`:

```css
.site-footer-sources {
  margin-block-start: 16px;
  color: var(--ch-muted);
  font-size: 13px;
  line-height: 1.5;
}
.site-footer-sources a {
  display: inline-flex;
  align-items: center;
  min-block-size: 44px;
  color: inherit;
  text-decoration: underline;
  text-underline-offset: 3px;
}
```

`scripts/smoke-site-chrome.ts`: add `'.site-footer-sources a'` to the tap-target selector list (line ~201); in H3 assert, per locale, that the footer's hrefs include `https://api.met.no/`, `https://creativecommons.org/licenses/by/4.0/`, `https://opendatacommons.org/licenses/odbl/1-0/` and `https://open-meteo.com/`, and that its text includes `Weather data by Open-Meteo.com` and `Contains modified Copernicus Atmosphere Monitoring Service information`. Render the footer at 375 px in en/he/ru (the site harness the site smokes use) and look at it: no horizontal overflow, readable in light and dark.

- [ ] **Step 5.4: The Privacy Policy (spec decision 4, exactly)**

`legal.privacy.sections.processors.blocks[1][10]` (replaces the Open-Meteo line):
- en: `**MET Norway:** your place’s map position, rounded to about 1 km, to get the weather.`
- he: `**MET Norway:** המיקום של המקום שלכם על המפה, מעוגל לדיוק של קילומטר בערך, כדי לקבל את מזג האוויר.`
- ru: `**MET Norway:** координаты вашего места с точностью около 1 км — чтобы получить погоду.` (U+00A0 after "с", between "1" and "км", and before "—")

`legal.privacy.sections.processors.blocks[3][3]`:
- en: `OpenStreetMap and MET Norway get only what’s listed above.`
- he: `OpenStreetMap ו־MET Norway מקבלים רק את מה שמפורט למעלה.`
- ru: `OpenStreetMap и MET Norway получают только то, что перечислено выше.` (U+00A0 after "и")

(Typographic apostrophes ’ as the existing English.) `src/site/legal.ts:6`: `export const LEGAL_UPDATED = { privacy: '2026-10-31', terms: '2026-10-30' } as const;` (the day the text changes: if the commit lands on a later day, that day). The Terms are untouched.

**Legal check (controller):** send the three-language diff of `legal.privacy` to the lawyer agent (Opus), as for the 2026-10-30 policy, with the spec's decision 4 and the rule that the Hebrew and Russian bind their readers as the English does; apply its corrections in all three languages before the commit, and re-run `smoke-no-open-meteo`, `smoke-site-truth`, `smoke-he-neutral`, `smoke-ru-formal`.

- [ ] **Step 5.5: The docs**

`README.md` line 32: `- **Weather in context** — MET Norway forecasts woven into the daily briefing, with Copernicus dust-storm and regional heatwave (sharav) awareness.`; line 60's integrations: `MET Norway (forecast), Copernicus CAMS via Open-Meteo's open data on S3 (dust; read with @openmeteo/file-reader, GPL-2.0, server only), geo-tz (time zones, © OpenStreetMap contributors, ODbL), the Copernicus DEM GLO-90 (heights in Israel, data/israel-heights-3s.i16.br, rebuilt with scripts/build-israel-heights.ts)`. Add one line under deployment: "Dev-only data scripts: `scripts/build-israel-heights.ts` (the height map), `scripts/build-city-heights.ts` (the public cities), `scripts/record-cams-fixture.ts` (the dust smoke's recording); none runs in CI." Nothing about MET needs an env var.

`CLAUDE.md`, one new rule after the Google retry rule, in the file's style:

```markdown
- The app reads no Open-Meteo API (its free API forbids commercial use; `scripts/smoke-no-open-meteo.ts` fails on one of its API hosts, `…api.open-meteo.com`, in `src/` or `app/`; its open data on S3 and the credit link are allowed). A forecast comes only from `fetchWeather(location, timezone)` (`src/services/weather/forecast.ts`, MET Norway's Locationforecast `complete`) with the place's own zone, never a default one: its User-Agent `FamCal/1.0 (+https://famcal.bot)`, coordinates at 2 decimals, no request before the stored answer's `Expires` and `If-Modified-Since` after it (one Redis key per rounded place), 429, 5xx and no answer retried with backoff honouring `Retry-After`, and one mapper (`mapMetForecast`) for units, the place's days and MET's symbols. A day's rain is its millimetres and hours (`RainSpell`), worded only by `src/services/weather/rain.ts`. Dust comes only from `fetchAirQuality` (CAMS from Open-Meteo's open data on S3, the API's `auto` domains, `@openmeteo/file-reader` pinned and server only). A place's zone comes only from `zoneForCoords` (`src/lib/zone-for-coords.ts`, re-exported by `src/lib/timezone.ts`: geo-tz's default 1970 map, Asia/Jerusalem where it is among the answers, the open sea and a failed lookup null and logged, never defaulted), and its height in Israel only from the stored map (`highestHeight`, `src/services/zmanim/heights.ts`). None of them reaches a `'use client'` file, and the weather credit (`bot.weatherCredit`, the site's `site.footer.dataSources`) stays wherever weather is drawn.
```

- [ ] **Step 5.6: Run, gate, commit**

```bash
$SCRATCH/om-smoke.sh scripts/smoke-no-open-meteo.ts scripts/smoke-site-chrome.ts scripts/smoke-site-truth.ts scripts/smoke-site-pages.ts scripts/smoke-site-seo.ts scripts/smoke-he-neutral.ts scripts/smoke-ru-formal.ts scripts/smoke-location-check.ts scripts/smoke-terms-plans.ts scripts/smoke-weather-command.ts scripts/smoke-zmanim-pages.ts
npx tsc --noEmit && npm run lint && PATH="$(dirname "$(npx -y node@22 -p process.execPath)"):$PATH" bash scripts/ci-smokes.sh && npx next build
git add messages/en.json messages/he.json messages/ru.json src/site/legal.ts src/site/data-sources.ts src/site/site-css.ts components/site/SiteFooter.tsx src/services/weather/infographic.tsx src/services/telegram/commands.ts scripts/smoke-no-open-meteo.ts scripts/smoke-site-chrome.ts scripts/smoke-weather-command.ts README.md CLAUDE.md
git commit -m "feat(credits): data sources and licences, the Policy names MET Norway, a guard against Open-Meteo's API

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31"
```
Bite check: put `https://api.open-meteo.com/v1/forecast` in a comment in `src/` → the guard fails; restore.

---

## Final: review, land, ship (controller)

- [ ] **F.1 Whole-branch review (Opus, high effort):** `git diff main...open-meteo` against the spec, this plan's Global Constraints and Review Focus, the spike's R1–R8, and the repo rules (wall time, no silent failures, no artificial timeouts, one code path, i18n, legal). Fix every valid finding (not just high severity), each with its test seen failing first; verify the reviewer's claims yourself.
- [ ] **F.2 Gate and fresh build** on the final branch: the gate above, then `$SCRATCH/fresh-build.sh` (`FRESH BUILD OK` with geo-tz, the height map and the wasm).
- [ ] **F.3 Land:** `git switch main && git merge --ff-only open-meteo && git push origin main && git branch -d open-meteo`. Watch `gh api repos/raziel-gershoni/famcalbot/commits/<sha>/status` until the Railway context "famcalbot - famcalbot" reads success, then send the owner the push notification with what changed for users (§2 of the spec, with the dust horizon at about 5 days).
- [ ] **F.4 Data:** no stored data needs fixing (the heights are the same pixels; the cached zones are the same zones; places abroad keep an unused height). Report that, and nothing to delete.
- [ ] **F.5 After the deploy is confirmed:** delete this plan file in a follow-up commit (`chore: remove the shipped Open-Meteo plan`), as with the 6a plan; update the memory note "Item 6 … Open-Meteo replacement pending" to "replaced 2026-10-31".

# Replacing Open-Meteo (design, 2026-10-31)

**Approved by the owner on 2026-10-31 ("Open-Meteo go"): every recommendation in §3, including the Privacy Policy sentences in decision 4.**

The owner's queue, after item 6a. The direction was approved on 2026-10-30 ("go"): sources that are free for commercial use, namely MET Norway for the weather, a time-zone library on our own server, and stored heights. This spec covers all four uses, what the research found, and the one new fork it found.

Research reports (scratch, not committed): the call inventory, weather, air quality, time zone, elevation and Open-Meteo pricing.

## 1. Why

- **Licence.** Open-Meteo's free API: "You may only use the free API services for non-commercial purposes", and "websites or apps that have subscriptions" are commercial (https://open-meteo.com/en/terms). FamCal sells plans.
- **Four uses:**
  - the forecast (summaries, /weather, the infographic and share image, the AI's weather lines, the sharav line);
  - air quality (dust-storm alerts);
  - a place's time zone (two separate lookups today);
  - a place's height (the Sephardi zmanim in Israel).
- **Credit owed today.** Open-Meteo's data is CC BY 4.0, which requires a credit even on a paid plan. FamCal shows none today.

## 2. What changes for users (option 1A)

**Stays the same:**
- temperature, "feels like", humidity, wind and its direction, UV, conditions and their icons, sunrise and sunset, the infographic, the sharav line;
- dust alerts from the same Copernicus data (if decision 2 holds);
- zmanim heights in Israel, to the metre (the same height map Open-Meteo reads);
- time zones.

**Lost or different:**
- **Rain chance (%)**: MET Norway gives none outside the Nordic countries (checked live for Tel Aviv on 2026-10-31). In its place, lines show the rain amount and the hours it rains ("Rain 14:00–17:00, 3 mm"). This covers:
  - the summary's rain line;
  - its rain-hours window, which today opens at 40% or more;
  - the day list's 💧 lines;
  - the infographic's big number;
  - the AI's prompt.
- **Forecast length**: 16 days become 9. The infographic shows up to 9 days instead of 12.
- **Hourly detail**: hourly for about 2.5 days, then every 3 hours, then every 6.
- **UV** is the clear-sky value, so it reads high on cloudy days.
- **Dust alerts**: they look about 4.5 days ahead instead of 7. "Visibility under 1 km makes it severe" goes, because MET gives no visibility. The dust level alone sets the severity.
- **New credit lines** (decision 3).

**Fixed along the way:**
- **Zone bug:** /weather and the share image ask for the forecast in Israel's time for everyone. They will use the person's zone.
- **Silent fallback:** a failed zone lookup falls back to Asia/Jerusalem and keeps that for 24 hours. That fallback goes.

## 3. Decisions (recommendation first)

1. **Free switch, or pay Open-Meteo.**
   - **A (rec):** the free switch described here. Cost: $0, plus the losses in §2.
   - **B:** Open-Meteo Standard, about €29/month (their 2023 announcement; the live price only shows at checkout). It keeps every field, with almost no code change: a key and another host.
   - **Trade-off:** A saves about €350 a year but loses rain chance. B is the opposite, and you would subscribe and paste a key.
   - Under B, §4 shrinks to the key, the credit lines and the two bug fixes.
2. **Dust under A.** No free API offers a dust forecast for commercial use, but the Copernicus data is free.
   - **Rec:** read it from Open-Meteo's public copies on Amazon (CC BY 4.0), with their reader library. It gives the same numbers as today, and no user's position leaves our server.
   - **Spike first:** a one-hour test of whether one place costs only a few small reads, and whether its values match today's. If it fails, I come back to you.
   - **Risks:**
     - The files come with no guarantee: a failure goes to Sentry, and the alert just doesn't show.
     - The reader is young (0.0.21) and licensed GPL-2.0. GPL asks nothing of a program we only run on our own server, but it would be the first GPL package in this MIT repo.
   - **Alternative:** drop the dust alerts.
3. **Credit lines.**
   - **Rec:**
     - one short line under the /weather reply ("Weather: MET Norway · Dust: Copernicus"), and on the infographic and the share image;
     - a "Data sources" line in the site footer, with the licences and "modified" (CC BY asks for both);
     - nothing in the morning and evening summaries.
   - **Alternative:** a line in every message with weather, the strictest reading of CC BY.
4. **The Privacy Policy** (needs your word; en/he/ru at once, new `LEGAL_UPDATED`):
   - Now: "**Open-Meteo:** your place's map position, to get the weather, air quality, the place's height and its time zone."
   - Proposed: "**MET Norway:** your place's map position, rounded to about 1 km, to get the weather."
   - Now: "OpenStreetMap and Open-Meteo get only what's listed above."
   - Proposed: "OpenStreetMap and MET Norway get only what's listed above."
   - Air quality, the zone and the height then send no user data anywhere, so they leave the list. The Terms don't change. Under B, nothing here changes.

## 4. Rulings I made (any can be undone)

- **West Bank zones.** The zone library returns two zones for Israeli towns over the Green Line (Ariel, Ma'ale Adumim: Jerusalem, then Hebron), because its map has overlapping areas. Rule: if Asia/Jerusalem is among the answers, use it; otherwise use the first. Hebron, Ramallah and Gaza keep their own zones.
- **Height map in full detail:** 5.2 MB in the repo, giving the same answers as today. A coarser 0.76 MB file reads about 12 m high on average, which is about 2 s of sunset.
- **Rounding for MET:** coordinates rounded to 2 decimals (about 1 km; MET's model grid is about 9 km). The cache keys on the rounded point.
- **Sunrise and sunset** come from our own hebcal code, not another call.
- **Daily values** (highs, lows, max wind, main direction, mean humidity, the day's condition) are summed up in the place's own zone.
- **User-Agent:** `FamCal/1.0 (+https://famcal.bot)`, as MET requires.

## 5. How it works

**Weather: MET Norway Locationforecast 2.0** (NLOD 2.0 / CC BY 4.0, commercial use allowed; the same source as Home Assistant's default weather).
- **Module:** `src/services/weather/forecast.ts` replaces `open-meteo.ts`. It keeps `fetchWeather` and the `WeatherData` shape, and the weather-code helpers move with it unchanged.
- **One mapper:**
  - m/s to km/h;
  - UTC to the place's wall time with `instantToWallTime`;
  - the daily values (§4);
  - MET's 41 symbols to the WMO codes the icons, texts and gradients use today (the table in the weather report).
- **MET's rules:**
  - the User-Agent;
  - at most 4 decimals (we send 2);
  - no request before the `Expires` header;
  - `If-Modified-Since` on a refetch, held in one Redis key per rounded place.
- **Failure:**
  - no artificial timeout;
  - 429, 5xx and network errors retried with backoff, honouring `Retry-After`;
  - every failure goes to `captureError` / `captureWarning`;
  - callers behave as today: a summary goes out without weather, and /weather gives its error reply.
- **Types:** `src/types.ts` drops `precipitationProbability` and `visibility`, and gains the rain hours.
- **Files:**
  - `formatter.ts`, `infographic.tsx`, `claude.ts` and `telegram/summary.ts` move to the rain amount and hours;
  - `commands.ts` and `app/api/weather-image/sign/route.ts` pass the zone.

**Air quality: Copernicus CAMS global** (0.4°, hourly, a run every 12 h), from `s3://openmeteo`.
- **Module:** `src/services/weather/air-quality.ts` is rewritten. `fetchAirQuality` keeps returning `{ time, pm10, dust }`, so `dust-storm.ts` keeps its logic minus the visibility upgrade.
- **Cache:** the nearest grid cell of the latest run, one entry per cell per run.
- **Failure:** logged to Sentry; it returns null and no alert goes out, as today.

**Time zone: `geo-tz` 8.1** (MIT; its data is © OpenStreetMap contributors, ODbL). No network call.
- **One function:** `zoneForCoords(lat, lon)` in `src/lib/timezone.ts` replaces `getTimezoneFromCoords` (`geocoding.ts`) and `lookUpZone`.
  - It applies the West Bank rule and checks the answer with `isValidTimeZone`.
  - A null or `Etc/…` (open sea) answer is logged to Sentry, never defaulted.
- **Data:** the "1970" data set, as the library uses by default. Its "now" set labels Ariel as Asia/Gaza and Kyiv as Europe/Athens.
- **`next.config.js`:**
  - `geo-tz` joins `serverExternalPackages` (bundled, it looks in the wrong folder and throws);
  - The package with its three data sets (about 75 MB) sits in `node_modules`, which is what `next start` on Railway runs from; the 1970 set is the one read. No `outputFileTracingExcludes`: Turbopack keeps every set in the instrumentation trace, so it would remove nothing.
- **Memory:** its tile cache gets a bounded store, since RAM is 1 GB.
- **Client code:** never imported into a `'use client'` file.
- **Build check:** a fresh-clone build confirms the data file is in the standalone output.

**Height: a stored Israel height map** (Copernicus DEM GLO-90, free for commercial use; the same pixels Open-Meteo reads, and the same source as the public city heights).
- **The file:** `data/israel-heights-3s.i16.br`, built by a new dev script, `scripts/build-israel-heights.ts`. It reuses the tile reader of `build-city-heights.ts`; `geotiff` stays dev-only.
- **One loader:** `src/services/zmanim/heights.ts`, called by `fetchHighestElevation` (`place.ts`).
  - The `elevationGrid` rule is unchanged: the highest of 25 points over the place's box.
  - It runs only for Israeli places, the only ones whose height is used.
  - The file is listed in `outputFileTracingIncludes`.
  - A point outside the map gives null, logged (sea level, as today).
- **Saved heights:** none needs a fix, as it is the same data. The hourly fill for missing heights stays.

**Attribution:**
- The site's Sources already credit OpenStreetMap for the town outlines; they add "and time zones".
- The credit lines of decision 3 go in all three languages, in messages.

## 6. Tests

- **Rewritten:**
  - `smoke-location-timezone`: the library on Ariel, Ma'ale Adumim, Eilat, Katzrin, Hebron, Gaza and Kyiv, a sea point, the West Bank rule, and a failure when the data file is missing;
  - `smoke-zmanim`: the file lookup instead of the `/v1/elevation` URL, Jerusalem at 741 m;
  - `smoke-weather-command`, `smoke-image-link`, `smoke-bug-batch-words`, and the `weather-*.json` fixtures (no rain % and no visibility; rain hours).
- **Stubs dropped:** `smoke-pause`, `smoke-calendar-range` and `smoke-zmanim-api` lose their api.open-meteo.com stubs.
- **New, `smoke-met-weather`:**
  - all 41 symbols mapped, and the units;
  - UTC to wall time across a clock change, and the daily values in the place's zone;
  - `Expires` and `If-Modified-Since`, the User-Agent, the rounding;
  - retries on 429 and 5xx, and the zone passed on every path.
- **New, `smoke-air-quality`:** the reader on a stub file, and the failure path.
- **Guard:** no `open-meteo.com` host is left anywhere in `src/` or `app/`.

## 7. Not included

- Nominatim (place search) and its 5 s timeout: unchanged, a separate fix.
- Heights abroad (still sea level, as the zmanim spec says), the sharav rule, the Israel Meteorological Service (no API it licenses for this), and running our own Open-Meteo server (it needs 8–16 GB of RAM).

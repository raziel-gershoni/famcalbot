# FamCal Jewish times API, v1

FamCal's Shabbat, Yom Tov and zmanim times as JSON, for the owner's own apps. The times are the ones FamCal's bot, Mini App and public zmanim pages show: the same engine, the same rules.

Base URL: `https://famcal.bot/api/v1/`

## Authentication

Every request is a `GET` with the app's key:

```
Authorization: Bearer fcj_…
```

Each app has its own key, made in FamCal's admin panel (API keys, New key). The key is shown once: keep it in the app's own secret store (an environment variable such as `FAMCAL_API_KEY`). A revoked key stops working at once; to restore access, a new key is made.

A key may be locked to the web origins of an app that calls from a browser (`https://shabbat.example.com`). A browser on any other website is then refused. The lock only stops other websites from using the key in a browser: anyone who reads the key out of a browser app can call the API from a server with it.

## The place and the shared parameters

| Parameter | Meaning |
|---|---|
| `city` | A slug of the city list below (`jerusalem`, `new-york`, …), lower case. Exactly one of `city` or `lat` and `lon`. |
| `lat`, `lon` | Decimal degrees with a dot (`31.7683`, `-74.006`), rounded to 4 places on arrival (about 11 m). |
| `community` | `sephardi`, `ashkenazi` or `chabad`. Default: Sephardi where the place's time zone is Israel's, Ashkenazi elsewhere. |
| `lang` | `en` (default), `he` or `ru`: the names of the zmanim, the holidays, the parasha and the Hebrew date. |

Any other parameter, a repeated one, or a malformed one is a 400, so a typo shows at once.

- A city has its stored position, height and time zone. Every Israeli city is `Asia/Jerusalem`.
- Coordinates get their time zone from a map of the world's zones. A point at sea has none: 400 `NO_TIME_ZONE`. In Israel's zone the height counted is the height of the ground at that exact point; for the height of a whole town (the highest point in it), pass the city.
- A point in the zones `Asia/Hebron` or `Asia/Gaza` counts as abroad (two days of Yom Tov, the Ashkenazi default).
- Candle lighting is 20 minutes before sunset everywhere.

## GET /shabbat

The Shabbat and Yom Tov blocks of a range of days. A block is one run of rest days: a Shabbat, a Yom Tov, or several in a row (Rosh Hashana, Yom Tov into Shabbat).

| Parameter | Meaning |
|---|---|
| `from` | A civil day at the place, `yyyy-MM-dd`. Default: today at the place. |
| `to` | A civil day at the place, included. Default: `from` plus 7 days. At most 366 days after `from`. |

The answer lists every block whose eve (the day whose sunset begins it) is from `from` to `to`, plus a block already under way on `from`.

`GET /api/v1/shabbat?city=jerusalem&from=2026-11-13&to=2026-11-14`

```json
{
  "place": { "city": "jerusalem", "timeZone": "Asia/Jerusalem", "inIsrael": true, "elevationM": 828 },
  "community": "sephardi",
  "lang": "en",
  "from": "2026-11-13",
  "to": "2026-11-14",
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
        { "date": "2026-11-13", "rows": [{ "key": "CANDLE_LIGHTING", "opinion": null, "name": "Candle lighting", "at": "2026-11-13T16:25:00+02:00", "local": "16:25" }] },
        { "date": "2026-11-14", "rows": [{ "key": "SHABBAT_ENDS", "opinion": null, "name": "Shabbat ends", "at": "2026-11-14T17:16:00+02:00", "local": "17:16" }] }
      ]
    }
  ],
  "credits": [
    { "source": "copernicus-dem", "text": "Produced using Copernicus WorldDEM™-90 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved. The organisations in charge of the Copernicus programme by law or by delegation do not incur any liability for any use of the Copernicus WorldDEM™-90." },
    { "source": "geonames", "text": "City positions: GeoNames, under CC BY 4.0.", "url": "https://www.geonames.org/" }
  ]
}
```

| Field | Meaning |
|---|---|
| `eve`, `last` | The day whose sunset begins the block, and its last rest day. |
| `candleLighting` | The eve's candle lighting: 20 minutes before sunset. |
| `start` | Sunset on the eve: the block begins. |
| `end` | The last day's end row: `SHABBAT_ENDS`, `YOM_TOV_ENDS` or `SHABBAT_YOM_TOV_ENDS` (a Saturday that is also a Yom Tov), with its name. |
| `parasha` | The block's weekly portion (`title`, `brief`), or `null`. |
| `holidays` | Its Yom Tov days' names, or, with none, its chol hamoed or special Shabbat: `{ title, brief, kind, chag }`. |
| `days` | Each day from the eve to the last day with its candle lighting and end rows. On the first night of a two-day Yom Tov the second night's candles are `CANDLE_LIGHTING_NOT_BEFORE` ("Candle lighting after"): not before that day's own end. |

## GET /day

One day's zmanim, halachic hours, holidays and Hebrew date.

| Parameter | Meaning |
|---|---|
| `date` | A civil day at the place, `yyyy-MM-dd`. Default: today at the place. |

`GET /api/v1/day?lat=40.7128&lon=-74.0060&date=2026-11-14&lang=he`

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
    { "key": "SHABBAT_ENDS", "opinion": null, "name": "צאת השבת", "at": "2026-11-14T17:22:00-05:00", "local": "17:22" }
  ],
  "hours": [{ "opinion": "gra", "name": "גר״א", "ms": 2985250, "text": "49:45" }, { "opinion": "mga", "name": "מג״א", "ms": 3830083, "text": "63:50" }],
  "credits": [{ "source": "openstreetmap", "text": "Time zone map © OpenStreetMap contributors, under ODbL.", "url": "https://www.openstreetmap.org/copyright" }]
}
```

(Three of the day's fourteen rows are shown.)

| Field | Meaning |
|---|---|
| `rows` | The community's zmanim in the order of the day, with the day's candle lighting and end rows among them. `key` is stable (`ALOT`, `NETZ`, `SOF_SHMA_GRA`, `CHATZOT`, `SHKIA`, `TZEIT`, …); `opinion` names the opinion a zman is counted by (`gra`, `mga`, `halachaBerura`, `yalkutYosef`, `baalHatanya`) or is `null`; `name` is in `lang`. |
| `hours` | The halachic hour under each opinion the community counts the day by: `ms` and `text` (minutes:seconds), `null` where the day has no sunrise or sunset. |
| `hebrewDate` | The Hebrew date of the civil day's daytime. `text` is in `lang` (the day and year in letters in Hebrew); `gematriya` is always the Hebrew text; `month` is the English month name, for a program to read. |
| `holidays` | The day's holidays, fasts, Rosh Chodesh and the weekly portion: `{ title, brief, kind, chag }`, `kind` one of `chag`, `fast`, `erev`, `cholHamoed`, `minor`, `modern`, `roshChodesh`, `parasha`, `specialShabbat`. |

## Times

Every time has two forms:

- `at`: the instant, as ISO 8601 with the place's offset at that instant (`2026-11-13T16:25:00+02:00`).
- `local`: the place's own clock, `hh:mm` in 24 hours.

Where the sun makes no such time that day (the far north in summer), both are `null`; the row, and a block, are still there.

## Errors

Every error has one shape:

```json
{ "error": { "code": "INVALID_DATE", "message": "date must be a real day, yyyy-MM-dd" } }
```

The `message` is for the developer, in English; a program reads `code`.

| Status | Codes |
|---|---|
| 400 | `INVALID_PLACE` (neither or both of city and coordinates, or only one of lat and lon), `UNKNOWN_CITY`, `INVALID_COORDINATES`, `NO_TIME_ZONE`, `INVALID_DATE`, `INVALID_RANGE` (`to` before `from`, or more than 366 days after it), `OUT_OF_RANGE` (outside 2000-01-01 to 2099-12-31), `INVALID_COMMUNITY`, `INVALID_LANG`, `UNKNOWN_PARAMETER` (an unknown or repeated parameter) |
| 401 | `MISSING_KEY`, `INVALID_KEY` (unknown or revoked: the same code for both) |
| 403 | `ORIGIN_NOT_ALLOWED` |
| 404 | `NOT_FOUND` (any other path under `/api/v1/`) |
| 429 | `RATE_LIMITED` (with `Retry-After`) |
| 500 | `INTERNAL` |
| 503 | `KEYS_UNAVAILABLE` (with `Retry-After: 60`) |

## Limits

- 300 requests a minute per key, in fixed one-minute windows. Every answer to a known key carries `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset` (the window's end, in Unix seconds). Over the limit: 429 with `Retry-After` in seconds.
- Dates from 2000-01-01 to 2099-12-31. A `/shabbat` range is at most 366 days; a default `to` stops at 2099-12-31.

## Caching

The same inputs always give the same answer. A 200 is `Cache-Control: private, max-age=3600`; when a date was left to its default ("today"), `max-age` runs at most to the place's next midnight. Every error is `no-store`. Cache on your side by the full URL.

## Browsers (CORS)

For a key locked to origins, a browser on one of them may call the API: the preflight is answered for it, and each answer carries `Access-Control-Allow-Origin` and exposes the rate headers. A key with no origins is a server key and gets no CORS headers. A call with no `Origin` header (from a server) is allowed with either kind of key.

## Credits

Show the `credits` of an answer wherever you show its times, as FamCal's zmanim pages do:

- `copernicus-dem`: wherever an answer gives a height (`elevationM`): the heights are derived from the Copernicus DEM.
- `geonames`: for a city: its position and time zone come from GeoNames.
- `openstreetmap`: for coordinates: their time zone comes from a map built from OpenStreetMap.

Licence texts are given in English and are not translated.

## Versioning

`/api/v1/` keeps its fields and their meaning. New fields and new endpoints are added to v1: ignore the fields you do not know. A rename, a removal or a change of meaning comes as `/api/v2/`, served beside v1 until the apps have moved.

## City slugs

<!-- cities:start -->
- `jerusalem` (IL, Asia/Jerusalem)
- `tel-aviv` (IL, Asia/Jerusalem)
- `haifa` (IL, Asia/Jerusalem)
- `rishon-lezion` (IL, Asia/Jerusalem)
- `petah-tikva` (IL, Asia/Jerusalem)
- `ashdod` (IL, Asia/Jerusalem)
- `netanya` (IL, Asia/Jerusalem)
- `beer-sheva` (IL, Asia/Jerusalem)
- `bnei-brak` (IL, Asia/Jerusalem)
- `holon` (IL, Asia/Jerusalem)
- `ramat-gan` (IL, Asia/Jerusalem)
- `ashkelon` (IL, Asia/Jerusalem)
- `rehovot` (IL, Asia/Jerusalem)
- `bat-yam` (IL, Asia/Jerusalem)
- `beit-shemesh` (IL, Asia/Jerusalem)
- `kfar-saba` (IL, Asia/Jerusalem)
- `herzliya` (IL, Asia/Jerusalem)
- `hadera` (IL, Asia/Jerusalem)
- `modiin` (IL, Asia/Jerusalem)
- `lod` (IL, Asia/Jerusalem)
- `ramla` (IL, Asia/Jerusalem)
- `raanana` (IL, Asia/Jerusalem)
- `nof-hagalil` (IL, Asia/Jerusalem)
- `rosh-haayin` (IL, Asia/Jerusalem)
- `afula` (IL, Asia/Jerusalem)
- `kiryat-gat` (IL, Asia/Jerusalem)
- `nahariya` (IL, Asia/Jerusalem)
- `eilat` (IL, Asia/Jerusalem)
- `tiberias` (IL, Asia/Jerusalem)
- `tzfat` (IL, Asia/Jerusalem)
- `karmiel` (IL, Asia/Jerusalem)
- `akko` (IL, Asia/Jerusalem)
- `maale-adumim` (IL, Asia/Jerusalem)
- `modiin-illit` (IL, Asia/Jerusalem)
- `beitar-illit` (IL, Asia/Jerusalem)
- `elad` (IL, Asia/Jerusalem)
- `dimona` (IL, Asia/Jerusalem)
- `hod-hasharon` (IL, Asia/Jerusalem)
- `nes-ziona` (IL, Asia/Jerusalem)
- `kiryat-shmona` (IL, Asia/Jerusalem)
- `ariel` (IL, Asia/Jerusalem)
- `kiryat-ata` (IL, Asia/Jerusalem)
- `kiryat-motzkin` (IL, Asia/Jerusalem)
- `kiryat-bialik` (IL, Asia/Jerusalem)
- `kiryat-yam` (IL, Asia/Jerusalem)
- `givatayim` (IL, Asia/Jerusalem)
- `yavne` (IL, Asia/Jerusalem)
- `netivot` (IL, Asia/Jerusalem)
- `sderot` (IL, Asia/Jerusalem)
- `harish` (IL, Asia/Jerusalem)
- `zichron-yaakov` (IL, Asia/Jerusalem)
- `new-york` (US, America/New_York)
- `monsey` (US, America/New_York)
- `lakewood` (US, America/New_York)
- `boston` (US, America/New_York)
- `philadelphia` (US, America/New_York)
- `baltimore` (US, America/New_York)
- `washington-dc` (US, America/New_York)
- `cleveland` (US, America/New_York)
- `detroit` (US, America/Detroit)
- `chicago` (US, America/Chicago)
- `atlanta` (US, America/New_York)
- `miami` (US, America/New_York)
- `boca-raton` (US, America/New_York)
- `dallas` (US, America/Chicago)
- `houston` (US, America/Chicago)
- `denver` (US, America/Denver)
- `phoenix` (US, America/Phoenix)
- `los-angeles` (US, America/Los_Angeles)
- `san-francisco` (US, America/Los_Angeles)
- `toronto` (CA, America/Toronto)
- `montreal` (CA, America/Toronto)
- `ottawa` (CA, America/Toronto)
- `vancouver` (CA, America/Vancouver)
- `buenos-aires` (AR, America/Argentina/Buenos_Aires)
- `sao-paulo` (BR, America/Sao_Paulo)
- `rio-de-janeiro` (BR, America/Sao_Paulo)
- `santiago` (CL, America/Santiago)
- `montevideo` (UY, America/Montevideo)
- `mexico-city` (MX, America/Mexico_City)
- `panama-city` (PA, America/Panama)
- `london` (GB, Europe/London)
- `manchester` (GB, Europe/London)
- `gateshead` (GB, Europe/London)
- `paris` (FR, Europe/Paris)
- `marseille` (FR, Europe/Paris)
- `lyon` (FR, Europe/Paris)
- `nice` (FR, Europe/Paris)
- `strasbourg` (FR, Europe/Paris)
- `berlin` (DE, Europe/Berlin)
- `frankfurt` (DE, Europe/Berlin)
- `munich` (DE, Europe/Berlin)
- `vienna` (AT, Europe/Vienna)
- `budapest` (HU, Europe/Budapest)
- `prague` (CZ, Europe/Prague)
- `warsaw` (PL, Europe/Warsaw)
- `amsterdam` (NL, Europe/Amsterdam)
- `brussels` (BE, Europe/Brussels)
- `antwerp` (BE, Europe/Brussels)
- `zurich` (CH, Europe/Zurich)
- `milan` (IT, Europe/Rome)
- `rome` (IT, Europe/Rome)
- `madrid` (ES, Europe/Madrid)
- `istanbul` (TR, Europe/Istanbul)
- `moscow` (RU, Europe/Moscow)
- `saint-petersburg` (RU, Europe/Moscow)
- `kazan` (RU, Europe/Moscow)
- `nizhny-novgorod` (RU, Europe/Moscow)
- `rostov-on-don` (RU, Europe/Moscow)
- `yekaterinburg` (RU, Asia/Yekaterinburg)
- `novosibirsk` (RU, Asia/Novosibirsk)
- `kyiv` (UA, Europe/Kyiv)
- `dnipro` (UA, Europe/Kyiv)
- `odesa` (UA, Europe/Kyiv)
- `kharkiv` (UA, Europe/Kyiv)
- `lviv` (UA, Europe/Kyiv)
- `minsk` (BY, Europe/Minsk)
- `riga` (LV, Europe/Riga)
- `vilnius` (LT, Europe/Vilnius)
- `chisinau` (MD, Europe/Chisinau)
- `tbilisi` (GE, Asia/Tbilisi)
- `baku` (AZ, Asia/Baku)
- `almaty` (KZ, Asia/Almaty)
- `tashkent` (UZ, Asia/Tashkent)
- `sydney` (AU, Australia/Sydney)
- `melbourne` (AU, Australia/Melbourne)
- `perth` (AU, Australia/Perth)
- `johannesburg` (ZA, Africa/Johannesburg)
- `cape-town` (ZA, Africa/Johannesburg)
- `casablanca` (MA, Africa/Casablanca)
- `limassol` (CY, Asia/Nicosia)
- `bangkok` (TH, Asia/Bangkok)
- `tokyo` (JP, Asia/Tokyo)
- `dubai` (AE, Asia/Dubai)
- `hong-kong` (HK, Asia/Hong_Kong)
<!-- cities:end -->

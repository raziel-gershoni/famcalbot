# Hebrew holidays in-process, and a holidays layer in the home

Status: designed 2026-10-19 under the owner's delegation ("you can proceed with development"). This is roadmap step 4 under the calendar UI: "a Hebrew holidays layer in-process (ends the dependency on CalBrew's API)". The research notes are in session scratchpad next/facts-hebrew-holidays.md.

Shipped 2026-10-19 on `feat/holidays`, with these deviations from the design:
- `holidaysInRange` is synchronous, so the natural-name overrides (`holidays.names.<id>`, Russian mostly) are read from `messages/{en,he,ru}.json` by static import, not through the async bot-messages loader. en and he mirror hebcal's wording; a smoke pins that for a whole year.
- An override is a plain `{arg}` template (`{year}`, `{month}`, `{n}`), not ICU plural; Hanukkah's candle counts keep hebcal's own Russian wording ("Ханука: 3 Свечи").
- On the month's first Gregorian cell, when it is not Hebrew day 1, a holiday takes the second line from the month name (only a real Hebrew day 1 keeps its name, unless it is a yom tov).
- The holidays hook (`useHolidays`) is called by each view that shows them (header, day list, picked day, each mounted month), and `holidays-client.ts` keeps one cache and one request per language and month.

## 1. Scope

**In:**
- **Holidays computed in-process.** `src/services/hebrew-holidays.ts` computes them with `@hebcal/core`, which is already a dependency. The CalBrew API call, its token, the 5-second timeout, the Redis cache and the Rosh-Chodesh-only fallback (with its empty catch) all go.
- **One definition of "the holidays of a day"**, shared by the bot's summaries and the home.
- **The home shows holidays:**
  - in Month cells (the line the calendar-home spec reserved for them);
  - under the day headers in Agenda and in a picked Month day;
  - in the header's today line.

**Out:**
- parashot;
- special Shabbatot;
- the Omer;
- candle lighting;
- Isru Chag (CalBrew computes it; hebcal doesn't);
- diaspora schedules. Israel schedule always, per the owner's rule "Israel schedule for parashot/holidays", which is also what CalBrew did.

## 2. Which holidays

The set is every hebcal event whose flags include one of:
- `CHAG`: yom tov days;
- `CHOL_HAMOED`, which includes Hoshana Raba;
- `EREV`: the eves;
- `MINOR_HOLIDAY`: Hanukkah days, Purim, Shushan Purim, Tu BiShvat, Lag BaOmer, Tu B'Av;
- `MAJOR_FAST` and `MINOR_FAST`;
- `MODERN_HOLIDAY`: Yom HaShoah, Yom HaZikaron, Yom HaAtzma'ut, Yom Yerushalayim and the other Knesset days hebcal lists;
- `ROSH_CHODESH`.

The schedule is always `il: true`.

**Change for the summaries:** they used CalBrew's narrower set (yom tov, minor holidays, Rosh Chodesh). Jewish-culture summaries now also name chol hamoed, eves, fasts and Israel's national days, which is the context a family plans around. The gate stays `culture === 'jewish'` for the bot (calendar-home Ruling R16).

**Priority** (for the one-line Month cell), highest first:
1. CHAG
2. fasts
3. EREV
4. CHOL_HAMOED
5. MINOR_HOLIDAY
6. MODERN_HOLIDAY
7. ROSH_CHODESH

Within a rank, hebcal's order.

## 3. Names
- The locales: en is `render('en')`, he is `render('he-x-NoNikud')` (the home's month names already use it) and ru is `render('ru')`.
- **Hebrew years.** A year inside a Hebrew title ("Rosh Hashana 5787") is written in gematriya, as the CLAUDE.md rule asks.
- **The ru locale.** `hebrew-holidays.ts` imports `@hebcal/locales/ru` itself, since bundles don't share module state. A smoke pins that ru differs from en.
- **Russian names** are reviewed for naturalness during the build.
  - Where hebcal's wording isn't how Russian-speaking Israelis say it (for example "День Раскаяния" for Yom Kippur), a `holidays.names.<id>` entry in messages (en/he/ru, the same keys in all three) overrides it.
  - `<id>` is a stable slug made from hebcal's English description, without the year or candle count.
  - Variable parts (the candle count, the month, the year) go in as ICU arguments.
- Each holiday carries a `title` (full) and a `brief` (`renderBrief`, for Month cells).

## 4. Server
- **`holidaysInRange(from: DayKey, to: DayKey, lang): Record<DayKey, Holiday[]>`**, where `Holiday = { title, brief, chag: boolean }`.
  - It's pure, synchronous and in-process: one `HebrewCalendar.calendar({ start, end, il: true })` call, then the flag filter.
  - The day keys come from the HDate's own y/m/d. They're never computed through ISO or UTC.
- **`getHolidaysForDate(date, language, timezone): Promise<string[]>`** stays as the summary's entry point, with the same signature and caller (claude.ts). It turns the date into the user's local day and returns that day's titles.
- **`GET /api/calendar/holidays?from&to&lang`** returns `{ days: Record<DayKey, Holiday[]> }`.
  - At most 100 days per request; bad input gives 400 `invalid`.
  - It's public data (no user data, no auth), sent with `Cache-Control: public, max-age=86400`.
- **Bundle discipline.** `@hebcal/core` stays out of the home's client bundle: the home gets holidays as data from the route.
- **Leftovers to remove:**
  - `REDIS_KEYS.holidays` and the `calbrew-holidays` Sentry tag;
  - the `CALBREW_API_TOKEN` read. The owner can remove that variable from Railway.

## 5. The home

Holidays show only when the home already shows Hebrew dates (`hebrewDates`). Without Hebrew dates there's no context for them.

- **Loading.** A small client cache, `holidays-client.ts`, fetches the holidays one month at a time, for the months in view. It runs alongside the range loads, never blocking them, and only when `hebrewDates` is on. A failure logs and shows nothing, because holidays are decoration and never an error state. A failed month is asked again on the next month change.
- **Month cell.** The reserved second line (`.ch-mb-hmonth`) holds the highest-priority holiday's `brief`. It's one line with an ellipsis, `dir="auto"`, and the aria label gains the full titles.
  - On a Hebrew month's first day, the month name keeps the line, since Rosh Chodesh is implied. A CHAG there takes the line instead: 1 Tishrei shows Rosh Hashana.
  - The cell height doesn't change, so the browse math stays exact.
- **Day headers** (Agenda and the picked Month day). After the Hebrew date comes `<span class="ch-day-holiday">`, with the day's titles joined by the locale's list format (`Intl.ListFormat`, unit style).
- **Header.** The today line adds today's titles the same way.
- **Look.** No new colours.
  - Yom tov titles (`chag: true`) use `--ch-accent`, so a day off reads at a glance. All other holidays use `--ch-muted`.
  - The size is that of the Hebrew date beside it.
  - Holidays are never items: no row, no tap target and no actions, and they don't appear in counts or "nothing planned".
- **RTL.** Titles are bidi-isolated (`<bdi>` in headers; `dir="auto"` in cells).

## 6. Tests
- **smoke-hebrew-holidays.** Each check runs in he, en and ru, under UTC, Asia/Jerusalem and Pacific/Kiritimati. It needs no network and no env:
  - Rosh Hashana 5787 (2026-09-12) with a gematriya year in he;
  - Erev Yom Kippur;
  - Sukkot chol hamoed (Israel days);
  - Shmini Atzeret;
  - the Hanukkah days, with Rosh Chodesh Tevet on the same day;
  - Rosh Chodesh Adar I/II and Purim in Adar II (5787 is a leap year);
  - Yom HaZikaron and Yom HaAtzma'ut;
  - Tish'a B'Av;
  - the priority order;
  - ru ≠ en;
  - day keys stable across server zones.
- **The summary smokes** (digest-reader, summary-prompt-parity) keep their stubs, so the golden summaries stay byte-identical. A new check calls the real `getHolidaysForDate` for one fixed date.
- **Route:** the bounds, 400s and the headers.
- **Render checks:**
  - the Month line (holiday vs month name vs CHAG on day 1);
  - the header lines;
  - the accent for CHAG;
  - nothing shown without `hebrewDates`;
  - nothing on failure;
  - en/he/ru copy;
  - the CSS rules (logical properties, ≥ 11 px).

### Known limitations (shipped on purpose)
- Israel schedule for everyone, so diaspora second days are not shown.
- No parashot, special Shabbatot or Isru Chag.

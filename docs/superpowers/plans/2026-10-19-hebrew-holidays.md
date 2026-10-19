# Hebrew holidays in-process — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Holidays come from `@hebcal/core` in-process. The bot's summaries and the home share one definition of the holidays of a day, and the home shows them in Month cells, day headers and the header.

**Architecture:**
- **Server:** a pure server module, `src/services/hebrew-holidays.ts`, rewritten around `holidaysInRange`. A public route serves it to the home.
- **Client:** a small client cache, `src/lib/calendar-view/holidays-client.ts`, feeds MonthBrowse, MonthPicked/DayList and HomeHeader.

**Tech stack:** `@hebcal/core` 6.0.6 (ESM-only), `@hebcal/locales` (ru), `@hebcal/hdate` 0.21.1 (pinned; don't reinstall), Next.js 16 routes, React 19, next-intl.

**Spec:** docs/superpowers/specs/2026-10-19-hebrew-holidays-design.md

## Global constraints
- Israel schedule always (`il: true`). Kinds, from hebcal flags, and their priority (highest first; an event's kind is the first one its flags match): chag (CHAG), fast (MAJOR_FAST|MINOR_FAST), erev (EREV), cholHamoed (CHOL_HAMOED), minor (MINOR_HOLIDAY), modern (MODERN_HOLIDAY), roshChodesh (ROSH_CHODESH). Every other hebcal event is dropped.
- Hebrew titles come from `render('he-x-NoNikud')`, with any 4-digit Hebrew year (`\b5\d{3}\b`) replaced by `gematriya(year)` from `@hebcal/hdate`. ru comes from `render('ru')`, after `import '@hebcal/locales/ru'` in this module.
- Day keys come from the HDate's Gregorian y/m/d (`hd.greg()` read with getFullYear/getMonth/getDate). Never use `toISOString`.
- `@hebcal/core` must never be imported by a client file (anything under app/[locale]/dashboard or src/lib/calendar-view).
- No inline user-facing strings: copy lives in messages/{en,he,ru}.json, with the same keys in all three (scripts/check-i18n-parity.ts). Hebrew is gender-neutral; Russian uses the formal вы where a sentence addresses the user.
- No silent failures: every caught error logs (and, on the server, goes through `captureError`). No empty catches, no artificial timeouts.
- CSS follows the home's rules (render check #86): logical properties only, no `:hover`, nothing under 11 px, tap targets ≥ 44 px.
- The tests never reach the network. Smokes run with the fake env from scratchpad landing-H1.sh line 2.

## Review focus
1. A server whose TZ isn't the user's: a holiday must land on the right day key under UTC, Asia/Jerusalem and Pacific/Kiritimati.
2. The Month cell line: on a Hebrew month's first day the month name keeps the line, except under a CHAG (1 Tishrei shows Rosh Hashana).
3. The Russian names read naturally. Any override goes in messages under `holidays.names.<id>`, present in en/he/ru.
4. The summaries' golden fixture stays byte-identical (the stubs remain). The real function returns the wider set.
5. A failed holidays fetch shows nothing and logs; it never blanks or delays the calendar.

---

### Task 1: Holidays core and the summary entry point

**Files:**
- Rewrite `src/services/hebrew-holidays.ts`.
- Modify `src/config/redis-keys.ts` (drop `holidays`).
- Create `scripts/smoke-hebrew-holidays.ts`.

**Produces:**
```ts
export type HolidayKind = 'chag' | 'fast' | 'erev' | 'cholHamoed' | 'minor' | 'modern' | 'roshChodesh';
export interface Holiday { title: string; brief: string; chag: boolean; kind: HolidayKind }
export function holidaysInRange(from: string /* yyyy-MM-dd */, to: string, lang: string): Record<string, Holiday[]>; // sorted by priority, then hebcal order
export async function getHolidaysForDate(date: Date, language: string, timezone: string): Promise<string[]>; // titles of the user's local day
```

- [ ] Write the smoke first. Use fixed days, checked against hebcal output you print once while writing it:
  - Rosh Hashana 5787: he has the gematriya year תשפ״ז, and the kind is chag.
  - Erev Yom Kippur.
  - A Sukkot chol hamoed day.
  - Shmini Atzeret.
  - A Hanukkah day that is also Rosh Chodesh Tevet: two holidays, minor before roshChodesh.
  - Rosh Chodesh Adar I and II, and Purim in Adar II, for 5787 (a leap year).
  - Yom HaZikaron and Yom HaAtzma'ut (modern).
  - Tish'a B'Av (fast).
  - A plain day returns [].
  - The ru title differs from the en title for Yom Kippur.
  - `holidaysInRange` gives the same keys under `TZ=UTC`, `Asia/Jerusalem` and `Pacific/Kiritimati`.
  - `getHolidaysForDate(new Date('2026-09-11T22:30:00Z'), 'he', 'Asia/Jerusalem')` is Rosh Hashana, since it is the 12th locally.
  - No env var is needed, and nothing touches Redis or the network. Stub nothing.
- [ ] Run it and see it fail.
- [ ] Implement:
  - One `HebrewCalendar.calendar({ start: HDate|Date, end, il: true })` call.
  - Filter by `ev.getFlags()` against the kinds.
  - Rank, then render. Locale map: en → 'en', he → 'he-x-NoNikud', ru → 'ru', anything else → 'en'.
  - `brief` from `ev.renderBrief(locale)`, with the same year rule.
  - Remove the CalBrew fetch, the token read, the Redis cache, the timeout, the fallback and its empty catch.
  - `getHolidaysForDate` computes the local day with `date.toLocaleDateString('en-CA', { timeZone })` and returns `holidaysInRange(d, d, language)[d]?.map(h => h.title) ?? []`. Keep it async, because claude.ts awaits it.
- [ ] Run it and see it pass under the three zones.
- [ ] Commit.

### Task 2: Natural names (ru, and a check of he and en)

**Files:**
- `messages/{en,he,ru}.json` (a new `holidays.names` section, only if overrides are needed).
- `src/services/hebrew-holidays.ts` (the override lookup).
- The smoke.

- [ ] Print every distinct title and brief for one full Hebrew year (5787) in ru, he and en.
- [ ] Judge the ru list as a native Russian speaker living in Israel would say it. Common usage is "Йом Кипур", "Рош а-Шана", "Суккот", "Ханука", "Пурим", "Песах", "Шавуот", "Рош ходеш …".
- [ ] For each unnatural title, add an override keyed by a stable slug of hebcal's English `getDesc()`, with the year, candle count and month stripped into ICU args (`{year}`, `{count}`, `{month}`). Write natural he and en values for the same keys; en/he can mirror hebcal's own wording.
- [ ] The lookup reads the JSON through the repo's existing server-side message loader (find how getBotMessage in src/lib/bot-messages.ts loads messages, and reuse that).
- [ ] Extend the smoke so the overridden ru titles are what the messages say.
- [ ] Commit.

### Task 3: The route

**Files:**
- Create `app/api/calendar/holidays/route.ts`.
- Extend the smoke, or add the route checks to it.

- [ ] Write `GET ?from=yyyy-MM-dd&to=yyyy-MM-dd&lang=en|he|ru`:
  - Validate real dates, from ≤ to and ≤ 100 days. Otherwise 400 `{ error: 'invalid', field }`.
  - An unknown lang reads as en.
  - 200 `{ days }` with `Cache-Control: public, max-age=86400, s-maxage=86400`.
  - No auth, since the data is public and has no user data. Check that the repo's middleware doesn't require auth on /api/calendar/*. If it does, add the route to its public list the way other public routes are listed.
- [ ] Add the smoke checks: the bounds, the 400s, the headers, and a known day.
- [ ] Commit.

### Task 4: The home

**Files:**
- Create `src/lib/calendar-view/holidays-client.ts`.
- Modify `app/[locale]/dashboard/CalendarHome.tsx` (or the loader that owns months in view), `MonthBrowse.tsx` (Cell), `MonthPicked.tsx` / `DayList.tsx` (DayHeader), `HomeHeader.tsx`, and messages if any copy is needed (the aria label join uses `Intl.ListFormat`, so no copy).
- Test: `scripts/smoke-calendar-home-render.ts` (append numbered checks after the last one, before the final print loop, following the file's own `check('#N …')` style and its React-warning baseline pattern).

- [ ] `holidays-client.ts`:
  - A per-(lang, month) cache: `holidaysFor(month: 'yyyy-MM', lang): Promise<Record<day, Holiday[]>>`, with one in-flight request per key.
  - On failure: `console.error` with the month and status, return {}, and don't cache the failure.
  - A React hook `useHolidays(months: string[], lang, on: boolean)` that returns a merged map and re-renders when months land.
  - Only fetch when `on` (= `hebrewDates`).
  - The `Holiday` type is a client copy, `{ title, brief, chag, kind }`, defined in `src/lib/calendar-view/types.ts` next to the other wire types, so the client never imports the server module.
- [ ] MonthBrowse Cell:
  - The `.ch-mb-hmonth` line shows the first holiday's `brief`. When the cell already shows a Hebrew month name, the name stays unless the first holiday is `chag`.
  - Add the full titles to the aria label (`parts`).
  - Add a class `has-chag` when the shown holiday is chag (colour `--ch-accent`); otherwise `--ch-muted`.
  - Use `dir="auto"`, one line, ellipsis.
  - The cell height constants must not change.
- [ ] DayHeader (Agenda and the picked day): after the Hebrew date, add `<span class="ch-day-holiday"><bdi>…</bdi></span>`, joined with `new Intl.ListFormat(locale, { style: 'long', type: 'unit' })`. Add `.ch-day-holiday.is-chag` for the accent.
- [ ] HomeHeader: today's titles, the same way, after the Hebrew date line.
- [ ] Render checks:
  - a Month cell with a holiday;
  - the month name vs Rosh Chodesh on day 1;
  - a CHAG on day 1 replacing the month name;
  - the accent class;
  - day header titles in he with `<bdi>`;
  - the header line;
  - nothing rendered and no fetch when `hebrewDates` is off;
  - a failed fetch renders nothing and logs;
  - en/he/ru.
  - The fake fetch answers `/api/calendar/holidays`.
- [ ] Run the whole render smoke and the editor smokes. Commit.

### Task 5: Leftovers
- [ ] Grep for `CALBREW`, `calbrew-holidays` and `REDIS_KEYS.holidays`, and remove the leftovers. The summary smokes keep their `getHolidaysForDate` stubs.
- [ ] Add one check in `scripts/smoke-digest-reader.ts` (or the new smoke) that the real `getHolidaysForDate` for 2026-09-12 'en' returns a Rosh Hashana title.
- [ ] Update `CLAUDE.md` or README only if they mention CalBrew holidays (grep).
- [ ] Commit.

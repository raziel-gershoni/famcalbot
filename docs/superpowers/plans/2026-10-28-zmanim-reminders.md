# Zmanim: reminders by zman, and a Shabbat and Yom Tov pause, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- A reminder's time can be a zman plus an offset ("10 minutes before sof zman Shema (GRA)", "at plag hamincha", "3 halachic hours after sunrise"), computed every day for each person from their own location.
- One Settings switch pauses all scheduled messages on Shabbat and Yom Tov.

**Owner decisions (2026-10-28):**
1. **One "community" setting:**
   - Sephardi / Zmanei Yosef (the default): the Ohr HaChaim calendar method;
   - Israeli Ashkenazi;
   - Chabad.
2. **Opinions as separate zmanim:** GRA and Magen Avraham, and the two plags, are separate zmanim in the list, not a setting.
3. **Sunrise:** it follows the set (elevation in Israel for Sephardi; sea level for Ashkenazi). No visible sunrise.
4. **Candle lighting:** 20 minutes before sunset, fixed.
5. **Reminders only.** Events by zman are left out for now, and nothing is copied to Google; reminders are never copied anyway.
6. **The offset is in ordinary clock minutes.**
7. **A switch, "Pause messages on Shabbat and Yom Tov":**
   - on by default for the "Jewish" calendar setting, and it can be turned off;
   - it covers reminders of every kind and summaries, from candle lighting to nightfall at the person's location;
   - the summaries' day chips stay as they are.
8. **Creating these by voice or text** is nice to have, for later. The Gemini prompt does not change, so there is no eval.

**Research:** `<S>/zmanim-report.md` (definitions, the Zmanei Yosef formulas from its open code, the library comparison, and how it fits FamCal). It was checked against the owner's Zmanei Yosef screenshot: Harish, 2026-10-28, elevation on. The hebcal-based formulas give every row within one minute at about 270 m. The rest is the app's per-zman rounding direction.

`<S>` = /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad

**Library:** `@hebcal/core` (already installed, 6.0.6), server-only, plus our own module. No new dependency. Zmanei Yosef's repos have no license: read its formulas from the report, do not copy code.

## Global Constraints
- **Wall time:** every wall time becomes an instant only through `wallTimeToInstant` (CLAUDE.md). Zmanim are instants from hebcal; display them through `instantToWallTime`, 24-hour.
- **Server only:** zmanim code never enters the Mini App browser bundle. The client gets computed times in the DTO.
- **One code path:** the reminder pass, the home, the digests and the summaries all get a zman reminder's time from one function.
- **Copy:** every user-facing string is in en/he/ru, with gender-neutral Hebrew and formal Russian. Zman names follow the luach terms the owner uses (the screenshot's Hebrew names). Every displayed zman names its opinion, for example "סוף זמן שמע (גר״א)".
- **No silent failures.** A missing location never crashes a pass: it falls back as stated and logs.
- **Gate:** `npx prisma generate && npx tsc --noEmit && npx eslint . && PATH=<node22 bin>:$PATH bash scripts/ci-smokes.sh && npx tsx scripts/check-i18n-parity.ts`, with the smokes on Node 22.23.4. Never run a build or touch a database; migrations apply on deploy.
- **Tests:** every new check is shown to fail with its fix removed.

## Review Focus
1. **Harish, 2026-10-28 (32.46182, 35.04555, elevation 270 m), the Sephardi set.** Every zman in the owner's screenshot is within one minute after our rounding:

   | Zman | Time |
   |---|---|
   | עלות | 4:44 |
   | טלית ותפילין | 4:56 |
   | הנץ מישור | 5:53 |
   | שמע מג״א | 8:04 |
   | שמע גר״א | 8:37 |
   | ברכות שמע | 9:32 |
   | חצות | 11:23 |
   | מנחה גדולה | 11:54 |
   | מנחה קטנה | 14:38 |
   | פלג הלכה ברורה | 15:47 |
   | פלג ילקוט יוסף | 15:59 |
   | שקיעה | 16:56 |
   | צאת | 17:09 |
   | צאת לחומרא | 17:14 |
   | חצות הלילה | 23:24 |
   | שעה זמנית גר״א | 55:25 |
   | שעה זמנית מג״א | 66:30 |

2. **The pause window:**
   - Friday from candle lighting to Saturday's nightfall;
   - a two-day Yom Tov abroad and in Israel (by location);
   - Yom Tov next to Shabbat (one continuous window);
   - Rosh Hashana's two days in Israel.

   Inside the window: no reminder ping, no event alert, no summary. Just outside it, they send.
3. **A zman reminder across days and places:**
   - each day's time differs, and each partner of a "both" reminder gets their own location's time;
   - the DST days are right (the resolver);
   - a zman that does not exist (polar) is skipped and logged.
4. **Existing users:**
   - "Jewish" calendar users get the pause on, all others off;
   - changing the calendar setting sets the switch the same way the day chips reset, and the person can still turn it off;
   - users with only a place name get coordinates filled in once (one geocode, logged), with no crash meanwhile.
5. **Hebrew RTL and copy:**
   - the editor's zman picker, the offset and the preview line;
   - Settings' community row and the switch;
   - the home row's "(08:27)" preview stays LTR.

---

### Task 1: Coordinates, elevation and the zmanim module
**Files:**
- `prisma/schema.prisma` and a migration (additive, idempotent):
  - `User.latitude Float?`, `User.longitude Float?`, `User.elevationM Int?`;
  - `User.zmanimCommunity String @default("sephardi")`, one of `sephardi | ashkenazi | chabad`;
  - `User.pauseOnShabbat Boolean @default(false)`. The migration sets it true where the user's culture is `jewish`.
- Location save (`/api/settings` and its location helpers, `src/lib/timezone.ts` `resolveTimezoneForLocation`): store the coordinates the lookup already finds.
  - The elevation is the highest point in the place (Rav Ovadia's rule). Sample a 5×5 grid over the place's Nominatim bounding box (capped at 3 km around the centre) with the free Open-Meteo elevation API in one call, and take the maximum. Log the centre and the maximum.
  - On a failure, keep the place, store the coordinates with a null elevation, and log.
- Lazy fill: a user with a place name but no coordinates gets them on first need (zman reminder, pause window), once, cached in the DB, and logged.
- `src/services/zmanim/`, server-only:
  - **`sets.ts`:** the three community sets as data: sunrise kind, and each zman's formula and rounding direction.
  - **`compute.ts`:**
    - `zmanimForDay(date, place, set)` returns the named instants;
    - `zmanInstant(date, spec, place, set)` where `spec = { zman, offsetMin } | { halachicHours, offsetMin }`;
    - `shabbatYomTovWindows(range, place, set)` returns `[start, end]` pairs.
  - **The Sephardi set** (the Zmanei Yosef / Ohr HaChaim method, Israel), from the report:
    - the hour is elevation sunrise to sunset, divided by 12;
    - alot is sunrise − 72 halachic minutes (each 1/60 of the hour);
    - misheyakir is sunrise − 60 halachic minutes;
    - sof Shema GRA is sunrise + 3h, and MGA is alot + 3 MGA-hours (alot to tzeit at 72 halachic minutes);
    - sof tefila is sunrise + 4h;
    - chatzot;
    - mincha gedola is chatzot + max(30 min, ½h);
    - mincha ketana is sunrise + 9.5h;
    - plag (Halacha Berura) is sunset − 1.25h, and plag (Yalkut Yosef) is tzeit − 1.25h;
    - sunset;
    - tzeit is sunset + 13.5 halachic minutes, and tzeit l'chumra is sunset + 20 halachic minutes. Verify both against the screenshot;
    - chatzot halayla;
    - candle lighting is sunset − 20 min (owner);
    - Shabbat ends 30 min after sunset;
    - abroad, use sea level as Zmanei Yosef does.
  - **The Ashkenazi set:**
    - sea level;
    - alot 16.1°;
    - misheyakir 11.5°;
    - MGA on 16.1°;
    - tzeit 8.5°;
    - Shabbat ends 8.5°;
    - candle lighting 20 min (owner).
  - **The Chabad set:** the report's Baal HaTanya column, as far as hebcal 6.0.6 allows, computed with `timeAtAngle` where hebcal lacks a method. Candle lighting is 20 min (owner).
  - **Rounding:** each zman's direction is in the set. Do as the Zmanei Yosef code does (read the formula notes in the report, and ROYZmanim.js for the rule only). "Ends" round earlier and "starts" round later; any exception is documented per zman.
  - **Yom Tov:** hebcal holidays with the Yom Tov flag, Israel or abroad by the location's country. A window runs from candle lighting on the eve to nightfall at the end; adjacent days merge.
- **Test:** `scripts/smoke-zmanim.ts`, with no network: the Open-Meteo and Nominatim calls are stubbed.
  - Review Focus 1, Harish, as a golden table.
  - Jerusalem and Bnei Brak, each against the report's probe table to the second, for the unrounded values.
  - Each set's formula on one day.
  - The windows in Review Focus 2, including the 2026 and 2027 dates.
  - The DST days through the resolver.
  - A polar day gives null and a log.
  - The location save stores the coordinates and the maximum elevation.
  - Lazy fill happens once.
  - Run under TZ=UTC and Asia/Jerusalem, on Node 22.
- **Commit:** `feat(zmanim): coordinates and elevation per person, and a zmanim module on hebcal with the three community sets and the Shabbat and Yom Tov windows`.

### Task 2: The Shabbat and Yom Tov pause
**Files:**
- **`isPaused(user, at)`** in the zmanim module, cached per user per day. It answers whether `pauseOnShabbat` is on and `at` falls inside a window for the person's location.
  - With no usable location, it falls back to the timezone's main city (Asia/Jerusalem gives Jerusalem), logged once a day per user.
- **Every scheduled send checks it before sending:**
  - the native reminder pass: per recipient, a paused recipient's ping is not sent and the occurrence stays open;
  - the event-alert pass;
  - the daily and tomorrow summaries (text and voice);
  - the setup nudges.
  
  Log each skipped send (`[pause] skipped <kind> for <userId>`).
- **Not paused:** replies to the person's own actions, such as answers to their messages and buttons.
- **The reminder pass:** a ping skipped by the pause is not re-sent after the window. The occurrence shows as open, and the next summary carries it, as today.
- **Settings:** a SwitchRow "Pause messages on Shabbat and Yom Tov" in the Summaries section (or wherever the plan's executor finds it reads best; document the choice), with a hint, saved through `/api/settings`. Changing the calendar culture sets the switch the same way the day chips reset (jewish gives on; other gives off), and the person can then change it.
- **Copy:**

  | Key | en | he | ru |
  |---|---|---|---|
  | settings.pause.label | Pause messages on Shabbat and Yom Tov | השהיית הודעות בשבת ובחג | Пауза в Шаббат и праздники |
  | settings.pause.hint | Nothing is sent from candle lighting until nightfall | לא נשלחות הודעות מהדלקת נרות ועד צאת השבת או החג | С зажигания свечей до выхода звёзд ничего не приходит |

- **Test:** extend the reminder, alert and summary smokes:
  - a paused window skips, and the minute after the window sends;
  - the switch off sends;
  - the culture change resets the switch;
  - the Settings render and the request body.
- **Commit:** `feat(pause): one switch pauses every scheduled message on Shabbat and Yom Tov, on by default for the Jewish calendar`.

### Task 3: Reminders by zman (the server and the editor)
**Files:**
- **The NativeEvent migration** (additive): `zmanSpec Json?`, holding `{ zman: ZmanKey, offsetMin: number } | { halachicHours: number, offsetMin: number }`. It is only allowed on `kind: REMINDER`, with date-only occurrences (the reminder has no wall time of its own).
- **The due time:** `dueAtForOccurrence` / `reminderDueAt` (`src/services/native-reminders/due.ts`) use `zmanInstant` for the recipient's location and set when `zmanSpec` is present. The pass, the home DTO, the digests and the summaries read it from there. Never store the computed time in `startsAt`.
- **The write path:**
  - the editor body gains `timeMode: 'time' | 'zman'` plus the spec;
  - the validate allow-lists;
  - item info returns them;
  - a series change uses the existing scope rules;
  - moving one occurrence makes it a fixed-time override.
- **The editor** (EditorSheet): for a reminder, the When card offers "At a set time" / "By zman".
  - "By zman" shows a ValueRow listing the community set's zmanim (named with their opinion), "halachic hours after sunrise" with a stepper, and an offset (before or after, in minutes, a StepperRow in steps of 5).
  - A live line shows today's time at the person's location.
  - With no location, a Notice says "Set your location in Settings to use zmanim", with a link.
- **Settings:** a "Zmanim" ValueRow for the community set (Sephardi, as in Zmanei Yosef / Ashkenazi / Chabad) in the Language and place card, under Location.
- **The home and the digests:** a zman reminder's row shows its rule and today's time, for example "10 דק׳ לפני סוף זמן שמע (גר״א) · 08:27" (the time LTR).
- **Copy:** the zman names in en/he/ru (the Hebrew from the screenshot's terms), the editor strings and the Settings row. The executor writes them under the copy rules; the controller reads he/ru before the push.
- **Test:**
  - the store and editor API (create, read back, edit scope, refused on an event);
  - the due time per recipient (two partners in different cities get two times);
  - the pass on a zman reminder;
  - the home render (preview and RTL);
  - the Settings community row;
  - the no-location Notice;
  - the screenshots `<S>/zmanim-shots/`: the editor he light, the home row he dark, Settings he light.
- **Commit:** `feat(reminders): a reminder's time can be a zman and an offset, computed daily for each person`.

## After the build (controller)
- One Opus review, including the he/ru copy and the Harish golden table.
- One fix round.
- Spot checks.
- The CI mirror on Node 22.
- Push.
- Spec and memory notes.
- Delete this plan.
- The owner's phone checks:
  - the switch in Settings;
  - a "10 minutes before sof zman Shema" reminder, compared with Zmanei Yosef the same day.

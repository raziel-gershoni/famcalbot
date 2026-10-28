# Zmanim: reminders by zman, and the Shabbat and Yom Tov pause

Shipped 2026-10-28. This file holds the owner's decisions and the rules the code follows. The code's own rules for agents are in CLAUDE.md (the pause check, and the one way to get a zman reminder's time).

## What people get
- **Reminders by zman.** A reminder's time can be a zman plus an offset ("10 min before sof zman Shema (GRA)"), or N halachic hours after sunrise. It is computed every day for each recipient at their own place: in a reminder for both partners, each gets their own city's time.
- **The pause.** Settings has "Pause messages on Shabbat and Yom Tov". Nothing scheduled is sent from candle lighting to nightfall at the person's place, neither reminders, nor alerts, nor summaries, nor nudges.
  - It is on by default for the Jewish calendar, and switching the calendar setting resets it.
  - A reminder that falls inside the window is not sent late. It stays open in the app, and the next summary carries it.
- **A "Zmanim" setting** for the community set:
  - Sephardi as in Zmanei Yosef (the default);
  - Ashkenazi (Israel);
  - Chabad.

## Owner decisions (2026-10-28)
1. **One community setting** picks the set. The baseline is the Zmanei Yosef app (Ohr HaChaim method).
2. **Opinions are separate zmanim** in the list, not a setting: GRA and Magen Avraham, and the two plags (Halacha Berura and Yalkut Yosef). A zman the reader's own set lacks is counted by the nearest set that has it.
3. **Sunrise follows the set.** The Sephardi set uses elevation in Israel, with the place's highest point sampled from Open-Meteo; abroad and in the other sets it uses sea level. There is no visible sunrise.
4. **Candle lighting is 20 minutes before sunset**, fixed.
5. **Reminders only.** Events by zman are left out for now, and nothing is copied to Google.
6. **The offset is in clock minutes.**
7. **The pause switch** covers reminders and summaries as described above.
8. **Creating these by voice or text is for later.** The Gemini prompt is unchanged.

## How it is computed
- `@hebcal/core` with our own sets in `src/services/zmanim/`:
  - `sets.ts` holds the three sets as data;
  - `compute.ts` has `zmanimForDay`, `zmanInstant` and `shabbatYomTovWindows`;
  - `pause.ts` has `isPaused`.

  Zmanei Yosef's code has no license; only its formulas were used.
- **Sephardi in Israel:**
  - the hour runs from elevation sunrise to sunset, divided by 12;
  - alot is 72 halachic minutes before sunrise, misheyakir 60;
  - tzeit is 13.5 halachic minutes after sunset, and l'chumra 20;
  - Shabbat ends 30 minutes after sunset in Israel, and at 7.165° abroad.
- **Golden check:** Harish, 2026-10-28, the owner's Zmanei Yosef screenshot. Every row is within one minute (`scripts/smoke-zmanim.ts`). The one-minute differences come from Zmanei Yosef's own sun calculation, not from rounding.
- **Place:**
  - the coordinates and the elevation are saved with the location (one writer, `saveUserPlace`);
  - a user with only a place name gets them filled once, lazily;
  - a failed elevation lookup in Israel is retried hourly;
  - with no usable place, the pause falls back to the timezone's main city, and this is logged.
- **Israel or abroad** (for Yom Tov days and the Sephardi rules) is read from the timezone.

## Today's zmanim sheet (owner decisions, 2026-10-28)
A sun button in the home's header, next to + and Send, opens a bottom sheet with the day's zmanim, like the list in the Zmanei Yosef app.
- **Who:** only the Jewish calendar setting (`culture === 'jewish'`). The home gets it as the `jewish` prop; Hebrew language or an Israeli zone alone do not show it.
- **The sheet:**
  - the Gregorian and the Hebrew date between two arrows (the previous day and the next; it opens on today in the person's zone), the place and the community ("חריש · ספרדי"), and the set's zmanim in the order of the day, each named with its opinion;
  - the title is "Today's zmanim" on today and "Zmanim" on another day;
  - times are 24-hour in the person's zone. A zman the sun does not make that day shows a dash;
  - at the bottom, the halachic hour as mm:ss under each opinion the set counts by (GRA and Magen Avraham; the Baal HaTanya's for Chabad);
  - it is a plain list: no row creates anything.
- **Candle lighting and the end:** the candle lighting appears on the day a Shabbat or Yom Tov window begins (a Friday, the eve of a Yom Tov) and the end of Shabbat (a Saturday) or of Yom Tov (any other day) on the day one ends. Both are the pause's own windows (`shabbatYomTovWindows`), so the list and the pause cannot disagree. A Friday inside a longer window (a Yom Tov on Thursday and Friday) therefore has no candle row: the window began earlier. The set's other days carry no candle lighting or end.
- **No saved place:** the zone's main city, with the editor's own note and its link to Settings. The place is never waited for (the editor info's background fill).
- **Server:** `GET /api/zmanim?date=yyyy-MM-dd` (the editor's auth), answered by `zmanDayList`; the client words everything.

## Known limits
- An event alert due in the last 5 minutes of a window is dropped. The pass reads the pause at its run time.
- A last-day renewal reminder that falls on Shabbat is dropped. The expiry notice still goes out after the window.
- Far north in midsummer, the Sephardi end of Shabbat abroad (7.165°) never happens. That window is then skipped and logged; the Ashkenazi and Chabad sets already behave the same way there.
- A pause check that fails (a bad zone, a hebcal error) sends as usual and is logged.

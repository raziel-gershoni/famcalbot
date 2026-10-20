# Hebrew-date repeats

Status: shipped 2026-10-19/20, on main. Designed 2026-10-19 under the owner's delegation, then revised after an adversarial review (session scratchpad next/review-repeats.md, which includes hebcal probes). This is roadmap step 5 under the calendar UI: "Hebrew-date repeats (birthday/yahrzeit rules from hebcal)". It builds on editing 3b (docs/superpowers/specs/2026-10-19-home-editing-3b-design.md). The research notes are in next/facts-hebrew-repeats.md.

## 1. Scope

**In:**
- **Two yearly rules** for FamCal events and reminders, both following the anchor's Hebrew date (§2). Days are daytime dates, with no sunset shift, which is the home's rule.
  - **Every year on the Hebrew date** uses hebcal's birthday rules (`getBirthdayOrAnniversary`). It suits birthdays, anniversaries and anything yearly.
  - **Yahrzeit** uses hebcal's yahrzeit rules (`getYahrzeit`). The series' start date is the date of death, which is the first (past) occurrence.
- **Where the two kinds differ.** The probes verified each case:

  | Anchor date | Read in | Every year on the Hebrew date | Yahrzeit |
  | --- | --- | --- | --- |
  | 30 Cheshvan or 30 Kislev | a year where that day doesn't exist | 1st of the next month | follows the first anniversary year |
  | Adar, in a common year | a leap year | Adar II | Adar I |
  | 30 Adar I | a common year | 1 Nisan | 30 Shvat |

  The confirmation card and the item sheet name the kind, so the rule a family follows is visible.
- **The home's editor** offers both choices on create and edit when the home shows Hebrew dates **and** the item's calendar, or the create target, is a FamCal calendar (§4). On edit, 3b's rules apply: from the opened occurrence on, with every guard.
- **The bot** understands "every year on the Hebrew date", "Hebrew birthday" and "yahrzeit" in he, en and ru (§5).

**Out:**
- monthly Hebrew rules;
- Rosh Chodesh repeats;
- an evening-before alert;
- an anniversary count in the title;
- Google: a Google calendar can't hold these rules. Hebrew series don't move to Google (connection spec).

## 2. Storage
- **Two new nullable columns**, added by a Prisma migration and applied on deploy:
  - `NativeEvent.hebrewRule String?`: 'anniversary' | 'yahrzeit'.
  - `NativeEvent.hebrewAnchor String?`: 'yyyy-MM-dd', the anchor's civil date in the series' zone.
- **The rule is the pair.** When `hebrewRule` is set, `rrule` is `FREQ=YEARLY` with at most INTERVAL ≥ 1, UNTIL or COUNT, and no BY* parts (so `fixesDays` stays false). `hebrewAnchor` is set, and `rrule` null implies both columns null. `assertStorableRule(rule, hebrewRule)` enforces all of it, both ways.
- **Why `rrule` stays a real yearly rule.** Every check that only asks "is this a series" keeps working (the ~25 `Boolean(series.rrule)` sites and the SQL filters). Week-lookahead classifies it as yearly. Code that misses the columns degrades to the Gregorian date instead of crashing.
- **The pair travels together.**
  - `CreateNativeEventInput` and `UpdateNativeEventInput` gain `hebrewRule?` and `hebrewAnchor?`.
  - Every place that copies, splits, moves or rewrites a series copies them with `rrule`: the 'following' tail creates (ee:743, ee:875) and every create 3b adds (stop to one-off, calendar-move split, recipient split).
  - A stop writes `rrule`, `hebrewRule` and `hebrewAnchor` as null together.
  - The route sends the pair on every repeat change. 'yearly' sends `hebrewRule: null` explicitly.
- **The anchor.**
  - It's set at create from the start's local date in the series' zone.
  - A split's tail copies it unchanged, so a 30 Cheshvan birthday stays one even when a tail starts on a year where it fell on 1 Kislev.
  - Only an edit that moves the series' (or tail's) start to another civil day replaces it. 'all' shifts it by the same civil delta; a tail uses its new start's date.
  - Candidates before `startsAt` are dropped, because a tail's anchor year can precede its start.

## 3. Expansion
- **The branch point.** `expandSeries` branches when `hebrewRule` is set, before any `RRule` call, so the rrule library never sees a Hebrew series.
- **Candidates:**
  - **The years.** Occurrence k (0-based) is in Hebrew year `Y0 + k * INTERVAL`, where `Y0` is the anchor's Hebrew year. COUNT admits k < COUNT. The window picks the years arithmetically, padded by one Hebrew year each side, so a window far from the start still counts right.
  - **The day.** For Y0 it's the anchor date itself, for both kinds (hebcal returns nothing for the anchor year of a yahrzeit). For later years it's `getBirthdayOrAnniversary(y, fresh)` or `getYahrzeit(y, fresh)`. Here `fresh` is a new `{ yy, mm, dd }` from the anchor on every call, because `getYahrzeit` mutates the date it's given and must never share one. The result is a JS Date at local midnight, and its civil y/m/d come from `getFullYear/getMonth/getDate`.
  - **The time.** The anchor's wall-clock time (from `startsAt` in the series' zone) is placed on that civil date in the zone with `fromZonedTime`.
  - **UNTIL** is compared with the candidate's floating wall time (`toFloating`), not its instant. A date-only UNTIL reads as 23:59:59; a date-time, with or without Z, reads as a wall time.
- **What it reuses.** The candidates go through `expandSeries`'s existing overlap filter, `buildInstance` (exdates, cancellations, overrides) and orphan-override loop, so keys come out in the same form. They're deterministic across releases.
- **Helpers that branch on the columns:**
  - `slotsBefore` (3b's COUNT split) counts Hebrew candidates;
  - `classifyRule` returns 'hebrew' or 'yahrzeit' only with INTERVAL absent or 1 and nothing else; otherwise 'custom' with words ("Every 2 years on 15 Shvat");
  - `repeatInfo` / `repeatWords` give "Every year on 15 Shvat", worded from the stored anchor (never from the opened occurrence, which may be a rolled day);
  - `fixesDays` returns false;
  - `latestOccurrenceBefore` needs no change (its 400-day step covers the longest 385-day gap).

  The read-side types (`famcal.ts:64`'s Pick, `ReadItem`, item-info's series) carry both columns.

## 4. Editor and routes
- **The choices** are "Every year on <Hebrew date>" and "Yahrzeit, every year on <Hebrew date>". They show only when Hebrew dates are on and the calendar is FamCal, and they're worded from the anchor (on create, from the form's start date).
  - he: "כל שנה בט״ו בשבט" and "יארצייט, כל שנה בט״ו בשבט", with gematriya.
  - ru: "Каждый год 15 швата" and "Йорцайт, каждый год 15 швата".
- **`RepeatChoice`** gains 'hebrew' | 'yahrzeit'. Create and PATCH accept them for FamCal targets only. For a Google key or a non-native `calendarId`, they return 400 invalid `repeat`.
- **3b's end carry.** A switch between Gregorian yearly and Hebrew yearly (either way) carries a COUNT as the remaining COUNT (original minus slots before the cut, at least 1) instead of converting it to an UNTIL, because the dates shift by up to a month. A date UNTIL is carried unchanged.
- **Edit info** reports the choice and the anchor. The item sheet's repeat tag (in place of the generic "Repeats"), like the editor's Repeat row, uses the same words and names the kind.
- **Switching the kind** (birthday to yahrzeit or back) from an occurrence where the two kinds fall on different days (an Adar anchor in a leap year, a 30 Cheshvan or 30 Kislev year that rolled) is refused: the tail keeps the stored anchor, so its first day under the new kind is not the opened one. The store throws `NativeHebrewKindError` (a `NativeRuleError`), the route answers 400 invalid `repeatKind`, and the editor shows `editor.repeat.kindDay` in en/he/ru ("make the change from an occurrence where both fall on the same day") instead of "Couldn't save". The cut occurrence is never moved silently. From the first occurrence the whole series changes in place and the two kinds always agree there.
- **Who sees the choices.** They show only with Hebrew dates. An item that already has a Hebrew rule shows its words to anyone who opens it.

## 5. Bot
- **Parsing.** The prompts (voice, text, image, forward share `buildEventExtractionPrompt`) gain:
  - `recurrence.calendar: 'hebrew'` and `recurrence.hebrewKind: 'anniversary' | 'yahrzeit'`;
  - `hebrewDate: { day, month, year? }`, with month names that keep Adar I and Adar II distinct.

  Triggers and examples go into the existing three-language example list: "יום הולדת עברי", "לפי התאריך העברי", "יארצייט", "Hebrew birthday", "on the Hebrew date", "по еврейскому календарю", "йорцайт".
- **Resolving the date.** When the user speaks a Hebrew date, server code resolves the start with hebcal: the given year, or, with no year, the next occurrence on or after today. The LLM never converts. `calendar: 'hebrew'` is honoured only with frequency 'yearly'; otherwise it's dropped and logged. A yahrzeit with no year anchors on its next occurrence, and the card says so.
- **One helper,** `recurrenceFields(user, target, ev)`, returns `{ recurrence, hebrewRule, hebrewAnchor, notice? }`. It's used by all five create sites: webhook-handlers.ts:1067, :1156, :1285; voice/bulk-confirmations.ts:219; voice/callbacks.ts:102. `CreateEventInput` gains the two fields.
- **A Google target** gets no recurrence and a notice. The event is created once, on the date. The confirmation card shows the notice before Confirm: "Google Calendar can't repeat by the Hebrew date, so this is added once". The copy is new, in en/he/ru.
- **The confirmation line** gives the Hebrew date (gematriya in he, transliterated in en/ru) and the kind.
- **As built (H3).**
  - **Six create sites, not five.** `voice/auto-create.ts` also builds a rule from a parse. It never sees a repeat today (the handlers skip auto-create for recurring events), but it goes through `recurrenceFields` like the rest, and the smoke pins all six.
  - **The helper.** `recurrenceFields(user, target, ev)` is async (the anchor is the start's day in the user's zone); `target` is the provider name. It returns only the keys that apply, so an ordinary event's create input is unchanged; the sites spread `repeatInput(...)`, which leaves out the card's `notice`. The Google provider also refuses a create that carries `hebrewRule`.
  - **The date.** The model returns `hebrewDate: { day, month, year? }` on the event; `src/services/hebrew-date-resolve.ts` validates it and resolves it with hebcal. Plain "Adar" is Adar II in a leap year. A date that does not exist (30 Cheshvan in a short year, Adar I in a common year) is logged and ignored, or skipped when searching for the next occurrence. A three-digit year (786) reads as 5786.
  - **The "no year" note** travels on the recurrence as `hebrewNoYear` (yahrzeit only), so the pending card keeps it.
  - **The cards.** The Hebrew line replaces "Yearly" on the single card, the reminder card, the created messages and the WhatsApp card; the bulk card keeps its repeat mark and gets the Google notice once. Copy is `bot.hebrewRepeat` in messages/{en,he,ru}.json.
  - **The prompt snapshot.** `scripts/fixtures/extraction-prompts.json` was retaken: the Hebrew repeats are in every user's base prompt.

## 6. Tests
- **smoke-hebrew-repeats** (new), under UTC, Asia/Jerusalem, Pacific/Kiritimati and America/Los_Angeles:
  - every case in §1's table, for both kinds, with both expected dates;
  - the yahrzeit anchor year as an occurrence, and the key returned by create;
  - INTERVAL, COUNT (including a window 20 years from the start) and UNTIL in each stored form;
  - an override and an exdate on a Hebrew occurrence;
  - one expansion over many years matching per-year calls (the mutation regression);
  - the anchor read in the event's zone;
  - week-lookahead keeping the item;
  - `assertStorableRule` both ways.
- **The pair across edits:** the columns kept through 'following', 'all' at the first occurrence, calendar-move and recipient splits; cleared on stop; and the anchor unchanged across a split whose tail starts on a rolled day.
- **A Hebrew reminder** through the pass and the open list.
- **Editor-api:** create and edit with both choices, the Google refusals, and the end carry between kinds.
- **Render:** the choices by Hebrew dates and calendar kind, words from the anchor, en/he/ru with gematriya.
- **Bot:**
  - parse examples in three languages, with the Hebrew date resolved server-side;
  - every create site through `recurrenceFields` (each site pinned);
  - the Google notice on the card;
  - the voice smokes still green.

### Known limitations (shipped on purpose)
- Yearly only, with no sunset shift and no count in the title.
- Google calendars can't hold these rules.

# Zman reminders by voice and text, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The bot creates a reminder by zman from a voice note or typed text, for example "Remind me 10 minutes before sof zman Shema", "תזכיר לי חצי שעה לפני השקיעה" or "напомни за 10 минут до конца времени Шма". It is the same reminder the Mini App editor makes, timed daily at each recipient's own place.

**Architecture:**
- The extraction prompt gains one optional `zman` field on a reminder. It holds either a name with an optional opinion plus an offset, or a number of halachic hours plus an offset.
- A pure server mapper turns that field into the stored `ZmanSpecValue` under the person's community set. When the name has several opinions in the set and none was said, the mapper returns the choices instead.
- The resolver times each candidate through the one zman clock (`zmanClockFor` + `reminderDueAt`).
- The card shows the rule and its time. When there are choices, the card shows one button per opinion, each with its time, and a tap creates the reminder.
- No schema change is needed: `NativeEvent.zmanSpec`, the user's place columns and `zmanimCommunity` already exist.

**Tech stack:**
- Gemini extraction (`gemini-voice.ts`), with the model and the MEDIUM thinking unchanged.
- The native reminder resolver and store.
- The Telegram inline keyboard and WhatsApp reply buttons.
- next-intl `createTranslator` for the words.

**Spec:** `docs/superpowers/specs/2026-10-28-zmanim-design.md`. This plan supersedes its decision 8 ("for later; prompt unchanged").

**Research, with file:line evidence for every step:** `<S>/zv/research.md` (`<S>` = /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad). Read sections 1, 2, 3 and 5 before any task. Where this plan and the research disagree, this plan wins: the research's §2.4 default opinion and its §5.6 pause window are superseded below.

## Owner decisions (2026-10-28)
1. **Ambiguity gets buttons** (owner: "when there is ambiguity put several buttons for several").
   - When the person names a zman that has more than one opinion in their set, and says no opinion, nothing is defaulted. The card offers one button per opinion, each with its time.
   - Today this applies to:
     - SOF_SHMA in the Sephardi and Ashkenazi sets: GRA, MGA;
     - PLAG in the Sephardi set: Halacha Berura, Yalkut Yosef.
   - Ashkenazi plag, Chabad Shema and Chabad plag have one key each, so they get no buttons.
   - The rule is generic: "more than one key of that name in the set", read from the set, not from a list.
   - A named opinion is used as said.
2. **The pause starts at sunset on the eve** (owner: "candle lightning is 20min before sunset, the pause should be from sunset").
   - This ships as its own change before this plan (branch `pause-sunset`, `shabbatYomTovWindows` starts at the eve's SHKIA).
   - Consequences here:
     - "at candle lighting" on a Friday is sent;
     - a reminder at or after sunset on a Friday or a Yom Tov eve, or during Shabbat or Yom Tov, falls inside the window.
   - A one-off whose time falls inside a window, while the recipient's pause is on, gets a one-line card note: it will not be sent.
3. **The paid eval is approved** (about $0.96 in total, an estimate):
   - first a 15 to 18 case `zman` slice, with `EVAL_FAIL_FAST=1`;
   - then one regression run of the 56 existing cases.
4. **Defaults accepted** ("all the rest ok"):
   - zman reminders always get a card and are never auto-created (on WhatsApp too);
   - with no day said, the next time that has not passed;
   - a bare "midnight" / "בחצות" / "в полночь" is the clock's 00:00, while "חצות היום", "חצות הלילה", "halachic midnight" and "chatzot" are zmanim;
   - "partner" shows the partner's time at their place, and "both" shows yours plus "each at your own place";
   - a correction keeps the rule on a day change and drops it when a clock time is given, with no voice editing of the offset;
   - offsets are any whole minute up to 12 hours;
   - WhatsApp typed reminders stay out, and WhatsApp voice is in;
   - a named opinion the set lacks is refused with one line naming what the set offers;
   - with no place at all, or no such time that day for a one-off, the bot refuses with a question and never creates silently.

## The opinion choice, in detail (decision 1)
- **The mapper's result** (`readZmanFromModel(modelZman, community)` in `src/services/zmanim/spec.ts`) is one of:
  - `{ kind: 'spec', spec }`;
  - `{ kind: 'choose', specs }`, with 2 or more specs in the set's own order (`ZMAN_KEYS` order);
  - `{ kind: 'refuse', reason: 'not_offered' | 'unknown' | 'bad_offset' }`.
- **The pending event** carries `zmanChoices: ZmanSpecValue[]` and no `zmanSpec`.
  - Each choice gets its own next occurrence by the §5.2 rule (today if its time at the recipient's place is still ahead, else tomorrow), unless the person said a day. A said day applies to every choice.
- **Telegram card:**
  - the rule's words without an opinion, then a line "Which opinion?" (he "לפי איזו שיטה?", ru "По какому мнению?");
  - one inline button per choice: "<opinion> · <hh:mm>", plus the day word only when that choice's day is not the card's day;
  - a tap creates the reminder with that spec through the normal create path, and the reply names the opinion;
  - the callback data carries the pending event's id and the choice index, within Telegram's 64 bytes;
  - Cancel and the Day quick button stay; the Time quick button (a clock time) clears the rule, as for a single spec.
- **Bulk ("Confirm all"):** an intent with choices never goes into the bulk list. It is sent as its own card right after the bulk card, the way anchor questions are.
- **WhatsApp voice card:** reply buttons, one per choice, titled with the opinion's name alone (≤ 20 characters, WhatsApp's limit), plus Cancel. Each choice's time is a line in the body.
  - WhatsApp allows at most 3 reply buttons. A smoke asserts that no name in any set has more than 2 keys, so a future set with 3 fails the smoke rather than WhatsApp.
- **A correction** (a reply to the card) keeps the choices, and a correction that names an opinion resolves them.
- **A repeating reminder** gets the same buttons.
- **"Partner"** shows times at the partner's place. **"Both"** shows the creator's times plus "each at your own place".

## Global Constraints
- **One code path:**
  - zman instants only via `zmanClockFor` / `zmanInstant` (CLAUDE.md);
  - model output becomes a spec only via `readZmanFromModel`;
  - words only from the moved `zman-words.ts`;
  - every create site uses `reminderCreateFields`.
- **Prompt:**
  - the Gemini model and MEDIUM thinking do not change;
  - the prompt is generic, with no user facts, and the user's text is data;
  - the no-reminder prompt snapshot (`scripts/fixtures/extraction-prompts.json`) stays byte-identical.
- **Copy:**
  - every string is in en/he/ru, under `bot.nativeReminders` or `calendarHome.zmanim`;
  - Hebrew is gender-neutral and natural, Russian formal and natural;
  - times are 24-hour, in the recipient's zone, LTR inside Hebrew;
  - a plain (non-zman) reminder's card and reply stay byte-identical.
- **No silent failures:** a refused or skipped zman is logged (`[zman-voice]`) and told to the person.
- **Gate:** `npx prisma generate && npx tsc --noEmit && npx eslint . && bash scripts/ci-smokes.sh` on Node 22, then `npx tsx scripts/check-i18n-parity.ts`. Never `npm run build` or `next build` in a task; the controller runs the fresh-clone CI mirror.
- **The paid eval** runs only from the controller: the slice first, stopping on the first error.

## Review Focus
1. **"10 min before sof zman Shema"** in he/en/ru, voice and typed, for a Sephardi person in Harish on 2026-10-28:
   - two buttons, "גר״א · 08:27" and "מג״א · 07:53";
   - a tap on GRA creates `SOF_SHMA_GRA`, -10;
   - "לפי הגר״א" said aloud creates it directly with no buttons;
   - for Chabad, no buttons (one key).
2. **"Every day 30 minutes before shkia":**
   - a daily repeat;
   - the Friday occurrence comes before the window (sunset) and is sent;
   - "at candle lighting" on a Friday is sent;
   - "at shkia" on a Friday is a one-off inside the window, so its card carries the note.
3. **A printed "candle lighting 18:12"** in forwarded text stays a plain 18:12 time.
4. **A "both" reminder:** each partner is timed at their own place, and the card says so; with choices, the buttons show the creator's times.
5. **No place, a polar day, and an opinion the set lacks:** each is refused with a clear line, and nothing is created.

---

## Tasks
Each task follows research §6, with the changes the decisions above make.

1. **Docs:**
   - supersede decision 8 in the zmanim spec with this plan's decisions 1 and 4 (decision 2 is the pause change's own doc edit);
   - one README sentence;
   - one CLAUDE.md line: the bot maps model output to a spec only through `readZmanFromModel`, with the clock only via `zmanClockFor`, and several opinions become buttons, never a default.
2. **The mapper** `readZmanFromModel` in `spec.ts`:
   - the three results above;
   - names → keys from the set data;
   - `not_offered`, `unknown`, and the offset and hours bounds.

   Smoke:
   - every key of every set is reachable;
   - the choices per community (Sephardi Shema 2, plag 2; Ashkenazi Shema 2, plag 1; Chabad 1 and 1);
   - no name has more than 2 keys in any set;
   - a named opinion the set lacks is `not_offered`.
3. **The parser:**
   - `ParsedEvent.zman` (the model level) is read in `parseReminderCreate`;
   - it forces `allDay: true` and a null start time;
   - a bad shape, an anchor, an event kind, or a clock time alongside the zman is warned about and refused.
4. **The prompt:**
   - the rule, the schema line and 3 examples (he/en/ru, partner-free) inside `buildReminderRules`;
   - the opinion is null unless said;
   - the forwarded rule renumbered;
   - the creation smoke assertions updated (research §3);
   - proof that the no-reminder fixture is unchanged.
5. **Resolve (Opus):**
   - map with the writer's community;
   - the recipient's clock, with the place fields on `PartnerSummary`;
   - the day pick per spec or per choice;
   - `timeNotice` with the rule (the 09:00 bug, research §5.1);
   - the pause note for a one-off inside a window when the recipient's pause is on, read through the pause's own function, never a second window rule;
   - new failures `zman_not_offered`, `zman_no_place` and `zman_no_time`;
   - `zmanChoices` on the pending event.
6. **The create path:**
   - `CreateEventInput.zmanSpec`, `reminderCreateFields` and the `native-provider` pass-through;
   - the store's `offeredIn` check on this path too;
   - analytics `by_zman`.
7. **Cards and replies:**
   - move `zman-words.ts` to `src/lib/calendar-view/`;
   - one `{ words, at, source }` helper used by every card and reply line, the bulk list, the TTS outcome line and the WhatsApp card;
   - the copy keys.
8. **The opinion buttons and the gates:**
   - the Telegram choice row and its callback, which sets the spec and creates through the normal path;
   - bulk sends a choice intent as its own card;
   - the WhatsApp reply buttons and their handler;
   - corrections carry or clear the rule and the choices;
   - no auto-create of a zman reminder on Telegram or WhatsApp.
9. **Smokes:**
   - `scripts/smoke-zman-voice.ts` under 3 process zones: parse → map → resolve with a fake clock → card words and buttons → tap → create fields → reply, in en/he/ru;
   - the create-flow, typed, correction, bulk and WhatsApp smokes extended.
10. **The eval:**
    - zman expectations, with the choices: when the opinion is unsaid the model must return null;
    - 15 to 18 `zman:` cases, plus controls;
    - the "differs from the prompt's examples" check;
    - `--dry-run`.

    The paid runs are the controller's.
11. **Review and ship (Opus):**
    - an independent review and an end-to-end flow probe;
    - fixes;
    - the CI mirror on Node 22;
    - push, then ping.

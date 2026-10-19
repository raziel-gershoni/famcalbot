# Hebrew-date repeats — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** FamCal events and reminders can repeat every year on their Hebrew date, with birthday rules or yahrzeit rules, from the home's editor and from the bot.

**Architecture:**
- **Storage.** Two nullable columns on NativeEvent, `hebrewRule` and `hebrewAnchor`, next to a plain `FREQ=YEARLY` rrule.
- **Expansion.** `expandSeries` branches to a Hebrew expander built on `@hebcal/hdate` before any rrule call.
- **Shared paths.** The store, routes, editor and bot all go through the shared paths 3b built.

**Tech stack:** Prisma (migration auto-applied on deploy), `@hebcal/hdate` 0.21.1 (pinned), rrule 2.8, Next.js 16, React 19, next-intl.

**Spec:** docs/superpowers/specs/2026-10-19-hebrew-repeats-design.md. It's the authority; section numbers below refer to it. Research and review notes are in the session scratchpad: next/facts-hebrew-repeats.md and next/review-repeats.md (the hebcal probes are in next/probe/).

## Global constraints
- `getYahrzeit` mutates its argument. Pass a fresh `{ yy, mm, dd }` on every call, and never share an HDate.
- A civil day comes from a Date's local getters, never `toISOString`. Wall times are placed with `fromZonedTime` in the series' zone.
- `rrule`, `hebrewRule` and `hebrewAnchor` travel together through every create, split, move and stop.
- No inline user-facing strings: messages/{en,he,ru}.json, with matching keys and ICU args. Hebrew dates are in gematriya in Hebrew. Hebrew copy is gender-neutral; Russian uses the formal вы.
- Migration file: `prisma/migrations/<YYYYMMDD000000>_hebrew_rule/migration.sql`, written by hand (no interactive `migrate dev`). Never run a build that migrates.
- Smokes run with `bash <scratchpad>/run-smoke.sh scripts/<name>.ts <TZ>` from the worktree root, under UTC, Asia/Jerusalem, Pacific/Kiritimati and America/Los_Angeles for the expander.

## Review focus
1. A Hebrew series that someone edits "from here on" keeps its Hebrew day in later years: the anchor is copied, not re-derived.
2. A yahrzeit's start is an occurrence, and the key create returns opens the sheet.
3. A window far from the start (COUNT, `yieldsSlots`) counts years arithmetically.
4. No Google path ever sends a Hebrew rule as a Gregorian yearly series.
5. Every bot create site goes through the one helper.

---

### Task H1: Storage and expansion (§2, §3)

**Files:**
- `prisma/schema.prisma`, plus the migration
- `src/services/native-calendar/recurrence.ts`
- `src/services/native-calendar/event-store.ts` (input types, the pair carried in every create and split, the stop clearing it, candidate selection carrying the columns)
- `src/services/calendar-read/famcal.ts` (types)
- `src/services/calendar-write/item-info.ts` (`repeatInfo` / `classifyRule` with the columns)
- Tests: new `scripts/smoke-hebrew-repeats.ts`, plus `smoke-calendar-editor-api.ts` additions for the pair across edits

**Produces:**
```ts
// recurrence.ts
export function hebrewCandidates(series: { startsAt: Date; timeZone: string | null; rrule: string; hebrewRule: 'anniversary' | 'yahrzeit'; hebrewAnchor: string }, window: { from: Date; to: Date }): Date[]
export function assertStorableRule(rule: string, hebrewRule?: 'anniversary' | 'yahrzeit' | null): void   // both-ways rules of §2
// classifyRule gains 'hebrew' | 'yahrzeit'; slotsBefore and yieldsSlots branch on the columns
```

- [ ] Write the failing smoke-hebrew-repeats checks from spec §6, first bullet (every table case for both kinds, with both expected dates; the anchor-year occurrence; INTERVAL/COUNT/UNTIL forms; the mutation regression; zones; week-lookahead; `assertStorableRule`). Watch them fail.
- [ ] Add the migration and schema columns. Build `hebrewCandidates`, with the years computed arithmetically from Y0 and the anchor-year occurrence equal to `startsAt`. Branch `expandSeries` before `buildRuleSet`. The candidates feed the same overlap, `buildInstance` and orphan loop.
- [ ] Branch the helpers: `slotsBefore`, `yieldsSlots`, `classifyRule`, `repeatInfo` and `fixesDays` (false). Have the read-side types carry the columns.
- [ ] Store: `CreateNativeEventInput` / `UpdateNativeEventInput` gain the pair. Every create in the 'following' branches, the stop, and the 3b splits copies it. A stop nulls all three. The anchor is replaced only on a civil-day move of the series' or the tail's start.
- [ ] Add editor-api checks for the pair across 'following', first-occurrence 'all', calendar-move and recipient splits, and stop; for the anchor kept across a split whose tail starts on a rolled day; and for a Hebrew reminder through the pass and the open list.
- [ ] Run the new smoke in four zones, plus editor-api, every `smoke-native-*`, `smoke-reminder-*`, the voice smokes, digest-reader, week-lookahead, tsc and lint. Commit per step.

### Task H2: Routes and the editor (§4)

**Files:**
- `src/services/calendar-write/{validate.ts,write.ts,item-info.ts}`
- `src/lib/calendar-view/{editor-types.ts,editor-model.ts}`
- `app/[locale]/dashboard/EditorSheet.tsx`
- `messages/*.json`
- Tests: editor-api and render

- [ ] Write failing checks:
  - editor-api: create and edit with 'hebrew' and 'yahrzeit'; 400 for a Google key or a non-native `calendarId`; the COUNT carry between kinds.
  - render: the choices only with Hebrew dates and a FamCal calendar; words from the anchor; en/he/ru with gematriya; the sheet's repeat line naming the kind.
- [ ] `RepeatChoice` gains the two values. The route builds `FREQ=YEARLY` plus the pair and refuses non-FamCal targets. The end carry handles a switch between kinds (remaining COUNT, UNTIL unchanged). The item info reports `choice` and `anchor`.
- [ ] Close the gap H1 left between the server and the client, before any Hebrew row can exist: since H1 the item info sends `series.rule.choice` 'hebrew' / 'yahrzeit', but `isItemInfoExtras` in `src/lib/calendar-view/editor-client.ts` allows only none/daily/weekly/monthly/yearly/custom, so the client rejects the whole edit info and the sheet can't open a Hebrew item. Add the two values there, give `EditorSheet` a Repeat option for a stored Hebrew choice, and pass the pair to `classifyRule` in `write.ts` (`repeatChanges(..., classifyRule(series.rrule, series.startsAt, itemTz).choice)` still classifies a Hebrew series as 'yearly'). Add an editor-api check that opens and edits a Hebrew item.
- [ ] Editor: the two choices in the Repeat row (create and edit), shown under §4's rules and worded from the anchor. Copy in en, he and ru.
- [ ] Editor: an 'all' day move from a rolled occurrence (a year with no 30 Cheshvan, an Adar case) is refused by the store as `NativeFixedDaysError` (400 `field: 'start'`), and so is one on a series whose own start is a rolled year. Show the day note there, as for fixed days.
- [ ] Run editor-api, the full render smoke, copy, parity, tsc and lint. Commit.

### Task H3: The bot (§5)

**Files:**
- `src/services/event-parser.ts`
- `src/services/voice/gemini-voice.ts` (the shared extraction prompt and the parse)
- `src/services/calendar.ts` (`buildRecurrenceRule` stays Gregorian)
- a new `src/services/recurrence-fields.ts`
- the five create sites (webhook-handlers.ts:1067, :1156, :1285; voice/bulk-confirmations.ts:219; voice/callbacks.ts:102)
- `src/services/calendar-provider/{types.ts,native-provider.ts}`
- `src/services/voice/confirmations.ts`
- `messages/*.json`
- Tests: a new `scripts/smoke-hebrew-repeats-bot.ts`, plus the voice smokes

- [ ] Write failing checks:
  - parse examples in he, en and ru, with the Hebrew date resolved server-side (with a year, and without one, which gives the next occurrence);
  - `calendar: 'hebrew'` with a non-yearly frequency dropped and logged;
  - every create site pinned to `recurrenceFields`;
  - the Google target: no recurrence, plus the notice on the card before Confirm;
  - the confirmation line with the Hebrew date and kind.
- [ ] Prompt: add `recurrence.calendar`, `recurrence.hebrewKind` and `hebrewDate` to the schema, and the triggers and examples to the existing three-language list. Don't change the model or the thinking level.
- [ ] Add `recurrenceFields(user, target, ev)`, and `CreateEventInput.hebrewRule` / `hebrewAnchor`. nativeProvider stores them, and googleProvider never receives a Hebrew recurrence.
- [ ] Confirmation card line and notice copy, in en/he/ru.
- [ ] Run the new smoke, every voice smoke, the WA webhook smokes, tsc and lint. Commit.

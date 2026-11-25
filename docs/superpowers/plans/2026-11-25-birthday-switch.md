# Birthday switch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Birthday switch on a yearly all-day FamCal event: a cake on the calendar screen, "birthday" (with the age) in the summaries, the age for civil-date birthdays too.

**Architecture:** Two columns on `NativeEvent` (`birthday`, `birthYear`), set and checked only in the event store. The native provider turns a birthday series into `eventType: 'birthday'`, so the summaries and Ask FamCal in a chat reuse their Google-birthday handling; `anniversaryOf` counts a civil birthday from `birthYear` (or the series' start year). The editor follows the alert's series-level pattern.

**Tech Stack:** Next.js 16, Prisma 7, next-intl, lucide-react 1.71, tsx smokes.

**Spec:** `docs/superpowers/specs/2026-11-25-birthday-switch-design.md`

## Global Constraints

- Eligible series: kind EVENT, `allDay`, a FREQ=YEARLY rule with no INTERVAL or INTERVAL=1 (civil, or with `hebrewRule: 'anniversary'`), on a FamCal calendar.
- The switch is series-level: never on one occurrence (`scope: 'single'` on a series → 400 field `scope`).
- Icon: lucide `Cake`; no emoji, no `:hover`, RTL-safe, light/dark.
- Copy in en/he/ru, Hebrew gender-neutral, Russian formal; "Birthday" reuses `calendarHome.row.birthday`.
- The Google copy (`toGoogleEvent`, `toGoogleHebrewSingles`) does not change.
- FamCal events are written only through the event store's four writes.
- Never `npm run build`; smokes with the fake env (`run-env.sh`); the CI mirror before the push.

## Review Focus

1. Turning the switch on from a later occurrence with "This one and after" splits the series: the tail is the birthday, and its civil age continues from the original year (not 1). Pinned in Task 1.
2. A birthday whose repeat is changed to weekly, or turned timed, or stopped, stops being a birthday (no cake, no "(Birthday)", busy again). Pinned in Task 1.
3. The bot's and the Google side's writes never carry `birthday` (a Google calendar target is 400 field `birthday`). Pinned in Task 4.
4. A Hebrew birthday's count is unchanged by the switch; a non-birthday civil yearly event gets no count. Pinned in Task 2.
5. The year-count guideline reaches the prompt for a civil birthday with a count (it is included only when a line carries the marker). Pinned in Task 3.

---

### Task 1: Store: the two columns, the eligibility rule, create, update and split

**Files:**
- Create: `prisma/migrations/20261125000000_native_event_birthday/migration.sql`
- Modify: `prisma/schema.prisma` (NativeEvent)
- Create: `src/lib/birthday.ts` (pure, client-safe)
- Modify: `src/services/native-calendar/event-store.ts` (CreateNativeEventInput, UpdateNativeEventInput, writeNewNativeEvent, checkSeriesFields, the in-place series update, both 'following' tail creates, the stop-to-one-off writes)
- Test: `scripts/smoke-calendar-editor-api.ts` (new checks, through the routes, after Task 4) and `scripts/smoke-birthday.ts` (new, pure)

**Interfaces:**
- Produces: `NativeEvent.birthday Boolean @default(false)`, `NativeEvent.birthYear Int?`.
- Produces (`src/lib/birthday.ts`): `isEveryYearRule(rrule: string | null): boolean` (FREQ=YEARLY, INTERVAL absent or 1); `canBeBirthday(s: { kind: string; allDay: boolean; rrule: string | null }): boolean`; `birthYearOf(s: { birthYear: number | null; startsAt: Date; timeZone: string }): number` (the stored year, else the start's civil year in its zone).
- Produces (store): `CreateNativeEventInput.birthday?: boolean`, `UpdateNativeEventInput.birthday?: boolean`; refusals `NativeScopeError('birthday')`.

- [ ] **Step 1: Write `scripts/smoke-birthday.ts` checks for `src/lib/birthday.ts`**: `isEveryYearRule('FREQ=YEARLY')` true, `'FREQ=YEARLY;INTERVAL=1'` true, `'FREQ=YEARLY;INTERVAL=2'` false, `'FREQ=WEEKLY'` false, `null` false, `'FREQ=YEARLY;UNTIL=20300101'` true; `canBeBirthday` false for a REMINDER, a timed event, a one-off; `birthYearOf` reads 1985 for a start of 1985-03-03T00:00 in Asia/Jerusalem stored as 1985-03-02T22:00Z, and the stored year when set.
- [ ] **Step 2: Run it** (`TZ=UTC npx tsx scripts/smoke-birthday.ts` under run-env.sh); expect FAIL (module missing).
- [ ] **Step 3: Schema, migration (`ALTER TABLE "NativeEvent" ADD COLUMN "birthday" BOOLEAN NOT NULL DEFAULT false, ADD COLUMN "birthYear" INTEGER;`), `src/lib/birthday.ts`; `npx prisma generate`.**
- [ ] **Step 4: Store rules.** Create: `birthday: true` on a series `canBeBirthday` refuses → `NativeScopeError('birthday')`; stored as given otherwise. Update: `birthday` joins `checkSeriesFields`' `seriesLevel` list (so 'single' on a series is refused); the row the edit leaves gets `birthday = (input.birthday ?? series.birthday) && canBeBirthday(itsShape)`, and an explicit `birthday: true` on a shape that can't be one refuses before anything is written. A 'following' tail gets the same rule on its own shape, and `birthYear = birthYearOf(series)` when its rule is civil every-year (no `hebrewRule`), else null. A stop to a one-off writes `birthday: false`. `birthYear` is never cleared elsewhere (read only for a civil birthday).
- [ ] **Step 5: Run smoke-birthday (PASS), `npx tsc --noEmit`, and the store smokes that exercise these paths** (`smoke-calendar-editor-api`, `smoke-hebrew-repeats`, `smoke-native-reminder-store`, `smoke-calendar-move`) green.
- [ ] **Step 6: Commit** `feat(birthday): NativeEvent.birthday and birthYear, kept by the event store only on a yearly all-day event`.

### Task 2: Readers: the birthday event type and the civil age

**Files:**
- Modify: `src/lib/hebrew-anniversary.ts` (`anniversaryOf`)
- Modify: `src/services/calendar-provider/native-provider.ts` (`toUnifiedEvent`'s series Pick and `eventType`)
- Modify: `src/services/calendar-read/famcal.ts`, `src/services/calendar-read/types.ts`, `src/services/calendar-read/dto.ts`, `src/lib/calendar-view/types.ts` (ItemDTO.birthday doc)
- Test: `scripts/smoke-hebrew-anniversary.ts`, `scripts/smoke-ask-in-chat-busy.ts`

**Interfaces:**
- Consumes: Task 1's columns and `birthYearOf`, `isEveryYearRule`.
- Produces: `anniversaryOf(series: { hebrewRule?; hebrewAnchor?; birthday?: boolean; birthYear?: number | null; rrule?: string | null; startsAt?: Date; timeZone?: string }, start: string, zone: string): number | null` — the Hebrew count as today; for `birthday && !hebrewRule && isEveryYearRule(rrule)`, the occurrence's civil year minus `birthYearOf(series)`, null below 1.
- Produces: `toUnifiedEvent` gives `eventType: 'birthday'` for a birthday series (a REMINDER stays 'reminder'); `ItemDTO.birthday` true for a FamCal birthday (absent otherwise, so existing DTOs are unchanged).

- [ ] **Step 1: Failing checks** in smoke-hebrew-anniversary: a civil birthday started 1985-03-03 counts 41 on 2026-03-03 and null on 1985-03-03; the same series without the switch, null; a tail with `birthYear: 1985` started 2026-03-03 counts 41; a Hebrew birthday's count equals the same series without the switch; `toUnifiedEvent` of a birthday series has `eventType: 'birthday'` and its line from `formatEventForPrompt` reads `(Birthday) [Year 41 since the original date]`; `toItemDto` of a FamCal birthday has `birthday: true`, of a plain FamCal event no `birthday` key. In smoke-ask-in-chat-busy: a FamCal all-day birthday is not busy, the same event without the switch is. In smoke-birthday: `toGoogleEvent` of a civil birthday series and `toGoogleHebrewSingles` of a Hebrew one equal the same series' mapping without the switch (the Google copy is unchanged).
- [ ] **Step 2: Run both; expect FAIL.**
- [ ] **Step 3: Implement** (the series is read with all columns already; widen the Picks; `dto.birthday = true` when `isBirthdayEvent(item.event)` on a FamCal item).
- [ ] **Step 4: Run both plus `smoke-calendar-dto`, `smoke-calendar-read-famcal`, `smoke-native-provider-reminders`, `smoke-digest-reader`; PASS.**
- [ ] **Step 5: Commit** `feat(birthday): a FamCal birthday reads as a birthday everywhere (summaries, Ask FamCal), with its civil age`.

### Task 3: The year-count guideline names a birthday

**Files:**
- Modify: `src/prompts/calendar-summary/{en,he,ru}.ts`, `src/prompts/week-lookahead/{en,he,ru}.ts` (`buildAnniversaryGuideline`)
- Test: `scripts/smoke-hebrew-anniversary.ts`

- [ ] **Step 1: Failing check:** each of the six guidelines no longer says the event repeats "on its Hebrew date" only (en: "repeats every year"), and says a "(Birthday)" mark makes clear what is counted (en text: `but only when the title, or a "(Birthday)" mark, makes clear what is being counted`); he/ru carry the same meaning in their own words.
- [ ] **Step 2: Run; FAIL. Step 3: edit the six. Step 4: run it and `smoke-voice-calm` (the show golden must stay byte-identical: the show's prompts are not touched; if it differs, stop and re-check before any re-record). PASS.**
- [ ] **Step 5: Commit** `feat(birthday): the summaries' year-count rule counts a birthday's age, on a civil date too`.

### Task 4: API and editor: the switch

**Files:**
- Modify: `src/services/calendar-write/validate.ts` (create and update `birthday`), `src/services/calendar-write/write.ts` (pass it; series-level like `alert`), `src/services/calendar-write/google-item.ts` (refuse), `src/services/calendar-write/item-info.ts` (`birthday` in the edit info), `src/lib/calendar-view/editor-types.ts`, `src/lib/calendar-view/editor-model.ts`, `app/[locale]/(app)/dashboard/EditorSheet.tsx`, `messages/{en,he,ru}.json`
- Test: `scripts/smoke-calendar-editor-api.ts`, the editor-model smoke that covers `scopePlan` (find it with `grep -l scopePlan scripts/`)

**Interfaces:**
- Produces: create body `birthday?: true`; update `changes.birthday?: boolean`; `ItemEditInfoResponse.birthday?: boolean` (a FamCal event only); `EditorForm.birthday: boolean`; `showsBirthday(form: EditorForm): boolean` (event, all-day, repeat spec freq 'yearly' or 'hebrew' with interval 1, FamCal calendar).
- Copy: `calendarHome.editor.birthday` = "Birthday" / "יום הולדת" / "День рождения"; the hint under it for a civil birthday is the existing `editor.repeat.hebrewCountHint` text.

- [ ] **Step 1: Failing API checks:** create a yearly all-day event with `birthday: true` → stored true; with a weekly repeat, a timed event, a reminder, or a Google calendar → 400 field `birthday` and nothing written; edit a series' switch with 'single' → 400 `scope`, 'all' → the row, 'following' from a later occurrence → the tail is the birthday with `birthYear` of the head's start year, the head not; a repeat change to weekly from the first occurrence clears it; a stop to a one-off clears it; the item info reads `birthday` back. Failing model checks: `scopePlan` offers `['following', 'all']` with note 'series' for a switch change on a series; `createBody` sends `birthday: true` only when `showsBirthday`; `updateBody` sends `changes.birthday` only when it changed and shows.
- [ ] **Step 2: Run; FAIL. Step 3: implement**, the switch row under Repeat (the form-kit switch the editor's other switches use), shown by `showsBirthday`, with the count hint under it for a civil birthday (the Hebrew hint stays where it is). **Step 4: run both smokes and `smoke-hebrew-anniversary`'s editor check; PASS.**
- [ ] **Step 5: Commit** `feat(birthday): the editor's Birthday switch on a yearly all-day FamCal event`.

### Task 5: The cake on the calendar screen

**Files:**
- Modify: `app/[locale]/(app)/dashboard/ItemRow.tsx` (a `BirthdayIcon` before the title; the meta's "Birthday" word goes), `ItemSheet.tsx` (the icon before the title; its tag stays), the month chip if it shows the reminder icon (`MonthBrowse.tsx` `Slot`), their CSS
- Test: `scripts/smoke-birthday.ts` (render checks with `renderToString`, as smoke-hebrew-anniversary renders ItemRow)

- [ ] **Step 1: Failing render checks:** a row with `birthday: true` (FamCal or Google) has the Cake svg before the title, a visually hidden "Birthday" in en/he/ru, and no "Birthday" in its meta line; a row without it has no Cake; the sheet has the icon and keeps its tag; the icon's CSS uses the home tokens and no physical left/right.
- [ ] **Step 2: Run; FAIL. Step 3: implement. Step 4: run with `smoke-hebrew-anniversary` and the home render smokes; PASS.**
- [ ] **Step 5: Commit** `feat(birthday): a cake before a birthday's title on the calendar screen`.

### Finish

- [ ] CI mirror on a fresh clone (all smokes, tsc, lint, next build); one final whole-branch review (most capable model); fix its valid findings; push to main; `wait-deploy.sh <full sha>`; delete this plan file; memory note.

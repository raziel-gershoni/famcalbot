# Editing step 3b — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the home, the repeat, the calendar and a reminder's recipient can change. Google-calendar users can add, edit, delete, re-repeat and move their Google events. The shared bot paths get the store and Google fixes the spec lists.

**Architecture:**
- FamCal's series-level changes go through the one store function `updateNativeEvent`, with three new optional fields. Scope semantics live in the store and are shared with the bot.
- Google writes go through `calendar-provider/google-provider.ts` → `src/services/calendar.ts`, also shared with the bot.
- The routes under app/api/calendar/{editor,item,items} dispatch on the key's source.
- The client extends EditorSheet, editor-model, ScopeSheet, CalendarHome and ItemSheet.

**Tech stack:** Next.js 16, React 19, Prisma, rrule 2.8, `@googleapis/calendar` 9.8, next-intl. Tests are tsx smoke scripts with in-memory fakes.

**Spec:** docs/superpowers/specs/2026-10-19-home-editing-3b-design.md. It is the authority, and every section number below refers to it. The research notes are in the session scratchpad: next/facts-store-3b.md, facts-ui-3b.md, facts-google-write.md, facts-critic.md, review-3b-*.md.

## Global constraints
- One code path. The bot and the home call the same store and provider functions. Never call `events.*` from a route.
- No silent failures: every catch logs, and server catches use `captureError`. No titles in logs (write.ts's rule). No empty catches. No artificial timeouts.
- No inline user-facing strings. Copy lives in messages/{en,he,ru}.json, with the same keys and ICU args in all three (`scripts/check-i18n-parity.ts`). Hebrew is gender-neutral; Russian uses the formal вы.
- Times are stored and computed DST-aware in the item's zone. Wall times are on the user's clock (3a's rule).
- The home's CSS follows render check #86: logical properties, no `:hover`, ≥ 44 px targets, ≥ 11 px text.
- Tests never reach the network. Run smokes with `bash <scratchpad>/run-smoke.sh scripts/<name>.ts <TZ>` from the worktree root; it carries the fake env. Run every touched smoke under UTC and Asia/Jerusalem.
- The fake Prisma in smoke-calendar-editor-api throws on an operator it doesn't know. Extend `matches()` when the store adds a query shape.

## Review focus
1. **A bot edit that worked before still works.** The voice smokes still pass, and the bot's Google 'all' edit no longer drops earlier occurrences.
2. **Stored-rule safety.** A rule written by any path parses and can't hang the process, and a bad stored rule never blanks a whole read.
3. **Reminders.** No ping goes to the wrong person, and no orphan override pings as a ghost.
4. **Google.** No 'following' write ever sends UNTIL and COUNT together. The tail starts exactly at the cut.
5. **The client.** It never shows a scope choice the server will refuse.

---

### Task A: FamCal store and its routes (spec §3.1, §3.3 FamCal half)

**Files:**
- `src/services/native-calendar/event-store.ts`
- `src/services/native-calendar/recurrence.ts`
- `src/services/calendar-write/{validate.ts,write.ts,item-info.ts}`
- `src/lib/calendar-view/editor-types.ts`
- `src/services/native-reminders/{open-reminders.ts,actions.ts,pass.ts,moved-pings.ts}`
- `src/services/calendar-provider/native-provider.ts` (error mapping, `wouldRefuseFixedDays` logging)
- `messages/*.json` (`nativeReminders.reassigned` only)
- Tests: `scripts/smoke-calendar-editor-api.ts`, and a new `scripts/smoke-native-rule-guards.ts` (read guards plus the pass race)

**Produces:**
```ts
// event-store.ts
export interface UpdateNativeEventInput { /* existing */ rrule?: string | null; calendarId?: string; forUserId?: number | null }
export class NativeScopeError extends Error { field: 'scope' | 'calendarId' }
export class NativeRuleError extends Error {}
export class NativeRecipientError extends Error {}
export class NativeDestinationError extends Error {}
// updateNativeEvent's result gains: key?: { seriesId: string; slot: Date | null }, reassignedPings: ClearedPing[], changedPings: ClearedPing[]
//   (clearedPings stays the time-moved list; changedPings are deleted occurrences, which take the `changed` copy)
// recurrence.ts
export function assertStorableRule(rule: string): void        // throws NativeRuleError; parsed keys whitelist, INTERVAL/COUNT integer >= 1
export function classifyRule(rule: string | null, start: Date, zone: string): { choice: 'none'|'daily'|'weekly'|'monthly'|'yearly'|'custom'; until?: Date } // spec §2.1
export function slotsBefore(series: { rrule: string; startsAt: Date; timeZone: string | null }, cut: Date): number // rule slots, exdates and overrides ignored
export function endCarriedRule(newFreqRule: string | null, oldRule: string, series: …): string | null // §2.1 ends
```

- [ ] **A1.** Write the failing editor-api checks for §3.1 in the spec's §7 list, FamCal part. Cover each new field, every scope rule, the first occurrence as 'all' (edit and delete), the COUNT split in slots, `assertStorableRule` (INTERVAL=-1, COUNT=0, an unknown key, the `RRULE:` prefix accepted), and the end carry. Watch them fail.
- [ ] **A2.** Implement `assertStorableRule` and call it in `createNativeEvent` and every rule write. Map `NativeRuleError`: native-provider → UNKNOWN_ERROR with a log of the ids; write.ts `refusal` → 400 invalid `repeat`. Implement `classifyRule`, `slotsBefore` and `endCarriedRule`.
- [ ] **A3.** In the existing 'following' branches (event and reminder):
  - the COUNT split in slots (the parent gets only UNTIL; the tail gets the remainder, at least 1);
  - the first-occurrence → 'all' conversion (times resolved as following, rows shifted as all, fields cleared as following, the key returned);
  - delete-following from the first occurrence deletes the series.

  Don't change behaviour otherwise. The bot's voice smokes must still pass: run every `scripts/smoke-*voice*`, `smoke-native-*` and `smoke-reminder-*`.
- [ ] **A4.** Implement the new rule ('following' only), stop repeating ('following' and first occurrence), one-off → series, the calendar move and the recipient change, exactly as §3.1 says:
  - read `input.rrule !== undefined ? input.rrule : series.rrule` everywhere the rule places times;
  - `moveInstances` validation in every branch;
  - state re-key only for an unchanged time;
  - delete before re-key;
  - `armedAt` rules;
  - `reassignedPings` / `changedPings` / `clearedPings`;
  - the private-destination filter;
  - `NativeDestinationError`.
- [ ] **A5.** Read guards (per-series try/catch, `captureError`, skip) in `expandCandidates`, `selectOpenReminderItems`, `loadItem` (not_found) and `liveOccurrenceTitle` (changed). Log in `repeatInfo`'s and `wouldRefuseFixedDays`'s catches. Smoke: a series with an unparseable rule beside a good one, through each reader.
- [ ] **A6.** The pass race (§3.1 "Recipient race"): after a successful claim, re-read `forUserId`, `isDeleted` and `updatedAt`; if any changed, undo the claim and skip. Smoke: interleave an edit between the pass's read and its claim, using the fake Prisma's hooks or a wrapped claim.
- [ ] **A7.** Routes, FamCal half:
  - `parseUpdate` accepts `repeat`, `calendarId` and `forPartner`;
  - `updateItem` passes them, forcing 'following' for a repeat change on a series, refusing 'single' for series-level fields, and sending the effective occurrence values on a stop;
  - `itemEditInfo` adds `series.rule`, `series.first`, `canMoveCalendar`, `moveTargets`, `canChangeRecipient`, `forPartner` and `source: 'famcal'`;
  - PATCH returns `key` always;
  - `stripMovedPings` takes three lists: moved → the "moved" copy, changed → `nativeReminders.changed`, and reassigned → `nativeReminders.reassigned` with the new recipient's name, each in the reader's language;
  - `clearCaches` covers every user touched;
  - analytics `changed_fields`.
- [ ] **A8.** Run editor-api, smoke-native-rule-guards, all `smoke-native-*`, `smoke-reminder-*`, the voice smokes, digest-reader, calendar-read*, tsc and lint under UTC and Asia/Jerusalem. Commit per sub-step (A1-A7).

### Task B: Google path and routes (spec §3.2, §3.3 Google half)

**Files:**
- `src/services/calendar.ts`
- `src/services/calendar-provider/{google-provider.ts,types.ts,index.ts}`
- `src/services/calendar-read/{google-map.ts,google.ts}` (`classifyGoogleError` forbidden; reading mask fields only if needed by item-info)
- `src/services/calendar-write/{google-item.ts (new),write.ts,item-info.ts,validate.ts}`
- `src/services/voice/{callbacks.ts,handler.ts}` (the FORBIDDEN branches; the instance id passed down)
- `src/services/calendar-provider/native-provider.ts` (`wouldRefuseFixedDays` dispatch)
- `messages/*.json` if a bot string is needed (reuse `nativeReminders.permissionDenied`)
- Tests: a new `scripts/smoke-google-write.ts` (a fake `@googleapis/calendar` installed through the same module-loader stub pattern smoke-calendar-editor-api uses), plus the existing voice and calendar smokes

**Produces:**
```ts
// types.ts
type ProviderErrorCode = … | 'FORBIDDEN'; interface ProviderResult { …; retryable?: boolean }
interface UpdateEventInput { …; instanceId?: string; rrule?: string | null; toCalendarId?: string }
interface CalendarProvider { …; moveEvent(user, a: { eventId: string; fromCalendarId: string; toCalendarId: string }): Promise<ProviderResult> }
// google-item.ts (server, used by item-info/write for google| keys)
export function parseGoogleKey(key: string): { calendarId: string; eventId: string } | null
export async function googleEditInfo(user, key): Promise<ItemEditInfoResponse | 'not_found'>
export async function googleEditorCalendars(user): Promise<EditorCalendar[]>
```

- [ ] **B1.** Build the fake Google client and the failing smoke-google-write checks, covering everything in spec §7 "A new smoke-google-write". The error classes use a real `GaxiosError` shape (construct one from the installed gaxios package). Watch them fail.
- [ ] **B2.** Errors: `classifyGoogleError` gets `forbidden`; FORBIDDEN and `retryable` are added; the status reads `err.status ?? err.response?.status ?? err.code`; every write helper in calendar.ts maps through it, instead of `isTokenError`/string matching; the bot's three call sites and `deleteThisAndFollowing` get FORBIDDEN → `nativeReminders.permissionDenied`. PERMISSION_DENIED (scopes) is unchanged. Add a bot smoke for both branches.
- [ ] **B3.** Zone: the event's own zone, and new events in the user's zone, replacing `TIMEZONE` in Google writes only. Then the 'all' master shift: read the instance, base on `originalStartTime`, delta from the displayed start, wall clock for timed, whole days for all-day. The bot passes `instanceId` (callbacks.ts already holds `originalEvent.eventId`).
- [ ] **B4.** Rewrite `updateThisAndFollowing` and `deleteThisAndFollowing` per §3.2 'following':
  - the cut is `originalStartTime`;
  - single UNTIL in UTC Z or as a date;
  - the tail's end (UNTIL, else COUNT minus slots, else none; never both);
  - EXDATE/RDATE split;
  - tail fields from the cut instance;
  - the destination calendar for a move;
  - first slot → 'all';
  - stray cleanup via `events.instances(timeMin = cut)`.

  `formatRecurrenceForAPI` passthrough. Fixed days via the shared `fixesDays`; `wouldRefuseFixedDays` answers for Google ids by reading the master, and logs and doesn't block on error.
- [ ] **B5.** Repeat change, replacing from the cut (later occurrence: truncate, insert, clean up; first slot: insert, then delete the master), and one-off → series. `moveEvent` through `events.move` inside `writeThenStamp`, with the order and failure branches of §3.2.
- [ ] **B6.** Routes for Google keys:
  - `parseGoogleKey` (the calendar id must be in the user's assignments);
  - `googleEditInfo`: `calendarList.get` + `events.get` (instance) + master, eligibility (§2.4 exact rules), `series.rule` from the master via `classifyRule`, `series.first`, notes as plain text, `editableInGoogleOnly`;
  - `googleEditorCalendars` (live `calendarList.list` roles ∩ chosen assignments; `main` = primary);
  - `createItem` / `updateItem` / `deleteItem` dispatch to the Google path (only changed fields; notes only when changed; repeat forces 'following'; the move first);
  - error → outcome mapping, including `reconnect` for TOKEN_EXPIRED and scopes;
  - `writeThenStamp` everywhere.
- [ ] **B7.** Run smoke-google-write, the voice smokes, calendar-read-google*, google-map, digest-reader, editor-api, tsc and lint. Commit per sub-step.

### Task C: The client (spec §2, §4, §5)

**Files:**
- `app/[locale]/dashboard/{EditorSheet.tsx,ScopeSheet.tsx,CalendarHome.tsx,ItemSheet.tsx,form-kit.tsx if needed}`
- `src/lib/calendar-view/{editor-model.ts,editor-client.ts,editor-types.ts}`
- `messages/*.json`
- Test: `scripts/smoke-calendar-home-render.ts` (update #81/#82; append new numbered checks before the final print, with their own React-warning baseline and closing check, in the file's style)

- [ ] **C1.** Write the failing render checks from spec §7 "smoke-calendar-home-render". Watch them fail.
- [ ] **C2.** editor-model:
  - `editItemForm` seeds repeat, calendarId and forPartner from the info;
  - `updateBody` sends each only when changed, and the effective values on a stop;
  - a pure `scopePlan(form, initial, info)` returns `{ kind: 'none' | 'following' | 'sheet', choices?, note? } | { kind: 'refuse', note: 'dayMoveAlone' }` per spec §4.
- [ ] **C3.** EditorSheet:
  - the Repeat row on edit (current and until labels, the "from here" line), the Calendar row (`moveTargets`), the For row (`canChangeRecipient`, with take-back);
  - follow `scopePlan`;
  - the inline day-alone note.

  ScopeSheet gets `choices` and `note`, with neutral labels for series-level sheets.
- [ ] **C4.** CalendarHome:
  - editor and item info for Google users (open the two NATIVE-only gates);
  - "+" for Google users;
  - refresh the item's source after a write;
  - a `reconnect` SubmitError, which raises the reconnect notice;
  - follow across keys.

  ItemSheet adds the googleOnly line. editor-client guards accept the new optional fields.
- [ ] **C5.** Copy (spec §5) in en, he and ru, natural for each. Run check-i18n-parity.
- [ ] **C6.** Run the full render smoke, calendar-home-copy, editor-api, tsc and lint. Commit per sub-step.

### Task D: Docs
- [ ] Update the 3b spec's status and "Known limitations" to what shipped. In the 3a spec, point the "Out until 3b" line at the 3b spec. Commit.

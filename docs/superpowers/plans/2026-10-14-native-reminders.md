# Native Reminders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Built-in-calendar users can create reminders: events with no duration, made by voice, forwarded text or typed text. FamCal pings the person a reminder is for, with ✅ Done / 💤 Snooze buttons, and keeps it in the daily digests until it is done.

**Architecture:** A reminder is a `NativeEvent` with `kind = REMINDER` and zero length, plus an optional `forUserId`. Per-occurrence state (done, snoozed, last ping) lives in a new `NativeReminderState` table, keyed like `NativeEventInstance`.
- **Reading:** reminders flow through the existing native provider → `CalendarEvent` pipeline, carrying `eventType: 'reminder'` and a `reminder` info object, so summaries, week views and the edit/delete matcher see them like events.
- **Firing:** a separate 1-minute cron pass, gated by an in-process "next due" memo, claims each due occurrence atomically in SQL and sends a Telegram ping with buttons.
- **New code location:** everything new lives in `src/services/native-reminders/`.

**Tech Stack:** Next.js 16.1 (standalone output, Turbopack `next build`) · TypeScript · Prisma 5 + Neon Postgres · Upstash Redis · node-cron · node-telegram-bot-api · Gemini 3.8 Flash (MEDIUM thinking) · next-intl JSON messages (en/he/ru) · tsx smoke scripts (no test runner).

**Spec:** `docs/superpowers/specs/2026-10-14-native-reminders-design.md` (read it before any task; section numbers below refer to it).

## Global Constraints

- The repo is PUBLIC. Never commit, print or hardcode secrets or API keys. Production is read-only: never write to the production DB or Redis, and never call `/api/health`.
- **No test runner.** Tests are `tsx` smoke scripts in `scripts/`, run with `npx tsx scripts/<name>.ts`. They use the existing `check()`/`assert()` style, print a final `N/N passed` line, and exit non-zero on failure. Time-dependent scripts run under both `TZ=UTC` and `TZ=Asia/Jerusalem`. Smoke scripts never call Gemini, Telegram or the real DB; they stub modules through `require.cache` the way `scripts/smoke-week-lookahead.ts` and `scripts/smoke-reminders.ts` do.
- Every commit passes `npx tsc --noEmit -p .` and `npm run -s lint`.
- Every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
  ```
- Work on branch `feat/native-reminders`. Never push to `main` from a task, and never force-push.
- **Naming** (spec §1): new code lives in `src/services/native-reminders/`. The table is `NativeReminderState`, the Prisma enum is `NativeEventKind { EVENT REMINDER }`, the callback prefix is `nr:` and the log tag is `[NativeReminders]`. Add no Redis keys under `reminder:` or `reminders:`. "reminder" alone in existing code means **event alerts**; don't rename existing event-alert identifiers.
- **Provider layer vocabulary:** lowercase `kind: 'event' | 'reminder'` in TypeScript provider and parser types; uppercase `'EVENT' | 'REMINDER'` only in Prisma.
- **i18n:** all new user-facing bot copy lives in `messages/{en,he,ru}.json` under `bot.nativeReminders.*`. All keys are added in Task 4. Later tasks only read them through `getBotMessages`/`getBotMessage`. Copy is natural and conversational, never literal. It is gender-neutral where it names a person: no gendered verbs, and use the "from: Name" / "Done by Name" style.
- **HTML:** Telegram messages use `parse_mode: 'HTML'`. Every user-supplied string (titles, names) is escaped with `escapeHtml`. Task 4 moves it to a new leaf module `src/utils/html.ts` (no imports) and re-exports it from `src/services/voice/confirmations.ts`. Non-voice modules (event alerts, ping, callbacks, moved-pings) import it from `src/utils/html.ts`, so the cron passes never load the voice UI chain.
- **Cross-bundle state:** Next 16 compiles `instrumentation.ts` (scheduler → cron handlers) and the route handlers (webhook, admin, manual cron routes) into separate module instances. Any in-process state that both sides touch (the due gate, the cron's running flag and alert throttle) lives on `globalThis`, the way `src/utils/prisma.ts` keeps `global.prisma`. Module-level `let`s are only for state one side owns.
- **Unchanged behaviour:** Google-calendar users behave exactly as before. WhatsApp-only users (no `telegramId`) never get reminder prompt rules or reminders. Never refactor Telegram flows to swap `user.id` and `telegramId`. Don't change the TTS remote/local pattern or the Gemini thinking level (MEDIUM everywhere).
- **Migrations:** hand-written, idempotent SQL (`ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `DO $$ … EXCEPTION WHEN duplicate_object THEN null; END $$;` for types and constraints), with a leading comment. Never run `prisma migrate dev`. After a schema change, run `npx prisma generate`.
- **Fixed constants:**
  - `REMINDER_MORNING_HOUR = 9`
  - `PING_LOOKBACK_MS = 60 * 60 * 1000`
  - `ARMED_GRACE_MS = 15 * 60 * 1000`
  - `DUE_GATE_CEILING_MS = 60 * 60 * 1000`
  - `OPEN_REMINDERS_DIGEST_CAP = 5`
  - `MAX_PING_ATTEMPTS = 3`
  - snooze options `s15` = 15 min, `s60` = 60 min, `st` = tomorrow 09:00 recipient-local (00:00–04:00 local means today 09:00)
- CalBrew (another repo) is read-only. Don't touch it.

## Review Focus

1. **A reminder near a DST change, at 00:00 exactly, or for a partner in another timezone.** It must ping at the intended wall-clock time and appear on the right digest day. Pinned by Task 3 (00:00 shaping, DST expansion) and Task 8 (`dueAtForOccurrence` across timezones and a DST day).
2. **A tap on a ping after the reminder was moved, deleted, marked done by the partner, or after unpairing.** It must get a short "changed / already done / not yours" answer, and never a 500, which Telegram would redeliver in a loop. Pinned by Task 9 (stale-button and double-tap cases).
3. **Hebrew or Russian titles containing `<`, `>` or `&`.** Card, ping, done notice and digest must still render under `parse_mode: 'HTML'`. Pinned by Task 8 (ping escaping) and Task 11 (card escaping).
4. **A daily reminder ignored for two weeks.** The digest shows one "open since" line for it, not fourteen, and the edit/delete matcher sees one candidate. Pinned by Task 7 (carry-over suppression and collapse) and Task 13 (matcher collapse).
5. **A partner reminder after the pair unlinks, or after the partner switches to Google.** It reverts to the creator everywhere: digest attribution, ping recipient and button authorization. Pinned by Task 1 (`effectiveOwnerId`), Task 8 (recipient) and Task 9 (ex-partner tap).

## Planning Rulings

Decided while drafting, after a cross-task reconcile. The spec is updated to match. Executors treat these as binding.

1. **Due-gate and cron state live on `globalThis`.** The gate gets a `writtenSinceGate` flag, so a write that lands during a pass is never hidden by that pass's `setNextDue`. *Why:* Next 16 gives the scheduler and the routes separate module instances, so a module-level gate would let a write's `invalidateDueGate()` miss the scheduler, and pings could run up to 60 min late. *If wrong:* an extra property on `globalThis`, harmless.
2. **`ownership.ts` reads `Pairing` itself and never imports event-store.** *Why:* the two files would otherwise import each other, and that cycle breaks partial store stubs in smoke scripts. *If wrong:* the pairing logic is duplicated in two places.
3. **`escapeHtml` moves to the leaf `src/utils/html.ts`.** `confirmations.ts` re-exports it. *Why:* otherwise the 1-minute pass and the alert cron load the whole voice and AI SDK chain. *If wrong:* none.
4. **Repeating carry-over is bounded at `series.armedAt - ARMED_GRACE_MS`; one-offs are not bounded.** *Why:* an occurrence that was never armed (its time was before the series was created or last re-timed) was never pinged and has no state, so showing it as "open since" would be a phantom. *If wrong:* after a series-level time change, a missed occurrence from before the change no longer carries over.
5. **`getReminderSupport` is uncached and computed once per message.** The `feature_blocked` analytics event it can log is not new, because the event-alert cron already checks the same `'reminders'` key per user (`src/services/reminders.ts:360`), and the result is cached for 24 h.
6. **The created reply uses relative wording.** It says "today at 17:00" or "tomorrow at 17:00" and "today" or "tomorrow" when it can, and otherwise "on Thu, Oct 15 at 10:00". Task 4 adds the `when.*` keys and Task 11's `formatReminderWhen` uses them. *Why:* "I'll remind you Thu, Oct 15, 10:00." reads like a machine wrote it.
7. **Self reminders have no "for" part on the card** (§3.3 wins over §3.2's "for you").
8. **Unreachable detection uses the codebase's narrow `isUnreachableError`.** Only a 403 with a known description, such as "bot was blocked by the user", marks the user unreachable. Any other 403 keeps the claim and goes to `captureError`.
9. **R8 spouse fill-in applies only to partner calendars that relabel to `spouse`.** Partner `kids`/`birthdays` calendars without a person name stay unnamed. *Why:* filling them would turn the partner into a "Child".
10. **A forwarded message is always the forwarder's reminder.** The prompt gets no partner names (`withPartner: false`) and resolution runs with `selfOnly: true`.
11. **A reminder whose partner is not on Telegram never auto-creates,** so that the card can ask "Keep as mine?".
12. **The native PERMISSION_DENIED copy covers create, edit and delete** (Task 13 covers all three callbacks).
13. **The `UNTIL=YYYYMMDD` inclusive-read fix stays.** Task 14 counts the legacy rows it could affect: series west of UTC that were split between 2026-05-06 and 2026-09-17. It reports the count read-only.
14. **Not fixed here (reported only):**
    - a "done" statement such as "I did it" gets the generic "didn't understand" reply;
    - suspended users' callback queries go unanswered (the moderation gate is pre-existing).

## File Structure

New files (all under `src/services/native-reminders/` unless noted):

| File | Task | Responsibility |
|---|---|---|
| `ownership.ts` | 1 | `PartnerSummary`, `ViewerContext`, `loadViewerContext`, `getActivePartnerSummary`, `effectiveOwnerId`, `effectiveOwnerForViewer` (reads `Pairing` itself; never imports event-store) |
| `due-gate.ts` | 1 | "Next due" memo on `globalThis`: `invalidateDueGate`, `shouldRunPass`, `setNextDue` |
| `prisma/migrations/20261014000000_native_reminders/migration.sql` | 1 | Schema migration |
| `src/utils/html.ts` | 4 | `escapeHtml` (leaf module, no imports) |
| `support.ts` | 4 | `getReminderSupport(user)`, `isNativeRemindersEnabled()`, `setNativeRemindersEnabled()` |
| `open-reminders.ts` | 7 | `fetchOpenReminders` and the digest carry-over helpers |
| `due.ts` | 8 | Pure due-time and eligibility math |
| `claim.ts` | 8 | Atomic SQL claim and release |
| `ping.ts` | 8 | Ping text, keyboard, `sendPing`, `stripPingButtons` |
| `pass.ts` | 8 | `runNativeReminderPass` (candidate query, expansion, recipient checks, claim, send) |
| `app/api/native-reminders/route.ts` | 8 | Manual trigger for the pass (CRON_SECRET-guarded, like the other cron routes) |
| `callbacks.ts` | 9 | `nr:` button handler |
| `resolve.ts` | 11 | Creation-time resolution: calendar, target, anchor, `resolveReminderIntents` |
| `typed-route.ts` | 12 | Keyword filter and typed-text handling |
| `moved-pings.ts` | 13 | `stripMovedPings`, `movedWhen`: edits a live ping when its reminder moves |
| `scripts/smoke-native-reminder-ownership.ts` | 1 | Ownership rules, partner summary queries, due gate |
| `scripts/smoke-native-reminder-store.ts` | 2 | Store shape rules, permissions, split copy, re-arm (fake Prisma) |
| `scripts/check-i18n-parity.ts` | 4 | Fails when the en/he/ru key sets differ |
| `scripts/smoke-native-reminder-support.ts` | 4 | Support gate, admin flag |
| `scripts/smoke-native-provider-reminders.ts` | 5 | Provider: reminder info, supplementary partner fetch, state lookup, alerts skip reminders |
| `scripts/smoke-partner-labels.ts` | 6 | R8 viewer-side labels and spouse info |
| `scripts/smoke-native-reminder-digest.ts` | 7 | Day shaping, carry-over, digest prompt blocks, week views |
| `scripts/smoke-native-reminders.ts` | 8 | Firing pass, due math, claim, ping text |
| `scripts/smoke-native-reminder-buttons.ts` | 9 | Button handler |
| `scripts/smoke-native-reminder-creation.ts` | 10 | Extraction: prompt snapshot, parser, multi-intent, forward bulk card |
| `scripts/fixtures/extraction-prompts.json` | 10 | Byte-identical prompt snapshots for the no-reminders path |
| `scripts/eval-native-reminders.ts` | 10 | Live Gemini check at MEDIUM (paid; run once in Task 14) |
| `scripts/smoke-native-reminder-create-flow.ts` | 11 | Resolution, card, created reply, quick fix, correction, bulk |
| `scripts/smoke-native-reminder-typed.ts` | 12 | Typed keyword filter and typed route |
| `scripts/smoke-native-reminder-edit.ts` | 13 | Matcher tags and collapse, zero-length edits, moved pings, cancel-that, permission copy |

Modified files, by task: see each task's **Files** block.

## Shared Interfaces (the contract every task codes against)

```ts
// src/types.ts — Task 5
export interface ReminderInfo {
  ownerIsViewer: boolean;   // the reminder is for the viewer (effective owner === viewer)
  creatorIsViewer: boolean; // the viewer created it
  ownerName?: string;       // effective owner's display name, set when the owner is not the viewer
  creatorName?: string;     // creator's display name, set when the creator is not the viewer
  done?: boolean;           // this occurrence has doneAt set
  snoozed?: boolean;        // this occurrence has snoozedUntil in the future
  open?: boolean;           // set by the summary: due earlier on the summary day, still undone
  openSince?: string;       // 'yyyy-MM-dd' in the viewer's tz, set only on carried-over items
}
// CalendarEvent gains:  reminder?: ReminderInfo;   // present iff eventType === 'reminder'

// src/utils/event-formatter.ts — Task 7
export function isReminderEvent(event: Pick<CalendarEvent, 'eventType'>): boolean; // eventType === 'reminder'

// src/services/native-reminders/ownership.ts — Task 1
export interface PartnerSummary {
  id: number; name: string; englishName: string /* '' when unset: use ||, not ?? */; gender: string;
  calendarSource: 'GOOGLE' | 'NATIVE'; telegramId: bigint | null; language: string;
}
export interface ViewerContext { viewerId: number; partner: PartnerSummary | null } // partner = ACTIVE partner
export async function getActivePartnerSummary(userId: number, pairingId: string | null): Promise<PartnerSummary | null>;
export async function loadViewerContext(user: { id: number; pairingId: string | null }): Promise<ViewerContext>;
/** forUserId counts only while it is the creator's ACTIVE partner and that partner is NATIVE; otherwise the creator. */
export function effectiveOwnerId(
  series: { creatorUserId: number; forUserId: number | null },
  creatorPartner: { id: number; calendarSource: string } | null
): number;
/** effectiveOwnerId seen from a viewer: creator===viewer → creatorPartner = ctx.partner;
 *  creator===ctx.partner.id → creatorPartner = { id: ctx.viewerId, calendarSource: 'NATIVE' }; else null. */
export function effectiveOwnerForViewer(series: { creatorUserId: number; forUserId: number | null }, ctx: ViewerContext): number;

// src/services/native-reminders/due-gate.ts — Task 1
// State lives on globalThis: { nextDueAt: number; writtenSinceGate: boolean } under __nativeReminderDueGate.
export const DUE_GATE_CEILING_MS: number;            // 60 min
export function invalidateDueGate(): void;            // nextDueAt = 0, writtenSinceGate = true
export function shouldRunPass(now: Date): boolean;    // now >= nextDueAt; when it returns true it clears writtenSinceGate (= pass start)
export function setNextDue(next: Date | null, now: Date): void; // no-op while writtenSinceGate; else nextDueAt = min(next ?? +inf, now + ceiling)
export function __resetDueGateForTests(): void;
// Cron handler order: check its running flag BEFORE shouldRunPass; call setNextDue only after a successful pass.

// src/services/native-calendar/event-store.ts — Task 2 (+ Task 5 reads)
export interface CreateNativeEventInput { /* existing */ kind?: 'EVENT' | 'REMINDER'; forUserId?: number | null }
export function normalizeReminderTimes(startsAt: Date, allDay: boolean, timeZone: string): { startsAt: Date; endsAt: Date };
export async function getMainNativeCalendar(userId: number): Promise<NativeCalendar>;
export interface ClearedPing { chatId: bigint; messageId: number }
// updateNativeEvent now resolves to { canonicalEventId: string; clearedPings: ClearedPing[] } (clearedPings: [] on every event path)
// deleteNativeEvent unchanged signature; resolves to void
// Task 5:
export interface NativeEventRow { calendar: NativeCalendar; series: NativeEvent; instance: VirtualInstance }
export async function fetchEventsInCalendars(calendarCuids: string[], range: FetchRange): Promise<NativeEventRow[]>; // same rows as before
export async function fetchRemindersForUserInRange(forUserId: number, creatorUserId: number, range: FetchRange): Promise<NativeEventRow[]>;
export interface ReminderStateRow { seriesEventId: string; originalStartsAt: Date; doneAt: Date | null; snoozedUntil: Date | null }
export async function fetchReminderStates(occurrences: { seriesEventId: string; originalStartsAt: Date }[]): Promise<ReminderStateRow[]>;
// Smoke scripts never fake part of event-store with an object spread; use a Proxy over the real module (Task 2's fakeOver).

// src/services/native-calendar/recurrence.ts — Task 3
export function latestOccurrenceBefore(event: NativeEvent, overrides: NativeEventInstance[], at: Date): VirtualInstance | null;

// src/utils/html.ts — Task 4 (re-exported from src/services/voice/confirmations.ts)
export function escapeHtml(text: string): string;

// src/services/native-reminders/support.ts — Task 4
export type ReminderSupportReason = 'not_native' | 'no_telegram' | 'disabled' | 'no_access';
export interface ReminderSupport { supported: boolean; reason?: ReminderSupportReason }
export async function isNativeRemindersEnabled(): Promise<boolean>; // Redis 'nrem:enabled' → DB → default true
export async function setNativeRemindersEnabled(enabled: boolean): Promise<void>; // Redis write + invalidateDueGate() (DB written by the admin route)
export async function getReminderSupport(user: { id: number; calendarSource: string; telegramId?: bigint | number | string | null }): Promise<ReminderSupport>;
//   Not cached: callers compute it once per message and pass it down. Fails closed ('no_access') if checkFeatureAccess throws.

// src/services/calendar-provider/types.ts — Task 5 (+ Task 13)
// CreateEventInput gains (native-only; Google ignores):  kind?: 'event' | 'reminder'; forUserId?: number | null;
// UpdateEventResult gains (Task 13, native only, key present only when non-empty):  clearedPings?: ClearedPing[];

// src/services/calendar-provider/native-provider.ts — Task 5
export function toUnifiedEvent(calendar, instance, series?: Pick<NativeEvent, 'kind'>, info?: ReminderInfo): CalendarEvent;
//   REMINDER series with no info → reminder: { ownerIsViewer: true, creatorIsViewer: true }
export function reminderInfoFor(series: { creatorUserId: number; forUserId: number | null },
  state: Pick<ReminderStateRow, 'doneAt' | 'snoozedUntil'> | undefined, ctx: ViewerContext, now: Date): ReminderInfo;
//   Names come from ctx.partner.name only (a visible reminder is always the viewer's or the partner's).

// src/services/calendar-provider/user-calendars.ts and friends — Task 6
export function labelsFromViewerSide(labels: CalendarLabel[]): CalendarLabel[]; // yours→spouse, primary dropped; primary alone → spouse
// getSpouseInfo(user, assignments?: CalendarAssignment[])
// generateWeekLookahead(..., calendars?: CalendarAssignment[]) and generateNextWeekSummary(..., calendars?: CalendarAssignment[])
// buildShowContext(summary, user, kind, isNextWeek = false, calendars = user.calendarAssignments ?? [])
export async function resolveShowCalendars(user: UserConfig): Promise<CalendarAssignment[] | undefined>; // voice-show/context.ts
// A reminder's calendarId may be outside the viewer's assignments (partner's PRIVATE calendar),
// so categorizing a reminder goes by reminder.ownerIsViewer, never by its calendar's label.

// src/services/native-reminders/due.ts — Task 8
export const REMINDER_MORNING_HOUR = 9;
export const PING_LOOKBACK_MS: number; export const ARMED_GRACE_MS: number; export const MAX_PING_ATTEMPTS = 3;
export function dueAtForOccurrence(occ: { startsAt: Date; allDay: boolean; timeZone: string }, recipientTz: string): Date;
export function tomorrowMorning(now: Date, tz: string): Date;
export function isEligible(a: { due: Date; now: Date; armedAt: Date | null; snoozed: boolean; lastPingedAt: Date | null; doneAt: Date | null }): boolean;

// src/services/native-reminders/claim.ts — Task 8
// NativeReminderState ids are crypto.randomUUID() (fits the 64-byte callback_data with the 'nr:st:' prefix).
export interface Claim { id: string; claimedAt: Date; previousLastPingedAt: Date | null; pingAttempts: number }
export async function claimOccurrence(seriesEventId: string, originalStartsAt: Date, due: Date, now?: Date): Promise<Claim | null>;
export async function releaseClaim(claim: Claim): Promise<void>;
// A snooze writes snoozedUntil and resets pingAttempts to 0 (each re-ping gets its own retry budget); never lastPingedAt.

// src/services/native-reminders/ping.ts — Task 8
export function buildPingText(a: { title: string; creatorName?: string; language: string }): Promise<string>;
export function buildPingKeyboard(stateId: string, language: string): Promise<TelegramBot.InlineKeyboardMarkup>;
export async function sendPing(chatId: bigint, text: string, keyboard: TelegramBot.InlineKeyboardMarkup): Promise<number>; // message_id
export async function stripPingButtons(chatId: bigint | number, messageId: number, text: string): Promise<void>; // swallows "not modified"/"not found"

// src/services/native-reminders/pass.ts — Task 8
export interface NativeReminderPassResult { sent: number; skipped: number; failed: number; nextDue: Date | null }
export async function runNativeReminderPass(now?: Date): Promise<NativeReminderPassResult>;
// src/cron/handlers.ts — Task 8 (running flag and alert throttle on globalThis)
export async function handleNativeReminders(): Promise<void>;

// src/services/native-reminders/callbacks.ts — Task 9
export const NATIVE_REMINDER_CALLBACK_PREFIX = 'nr:';
export function parseNativeReminderCallback(data: string): { op: 'd' | 's15' | 's60' | 'st'; stateId: string } | null;
export async function handleNativeReminderCallback(query: TelegramBot.CallbackQuery, now?: Date): Promise<void>;

// src/services/native-reminders/open-reminders.ts — Task 7
export const OPEN_REMINDERS_DIGEST_CAP = 5;
export async function fetchOpenReminders(
  user: UserConfig, ctx: ViewerContext, cutoff: Date, summaryDay: string /* yyyy-MM-dd */, timezone: string,
  cap: number = OPEN_REMINDERS_DIGEST_CAP /* Infinity = all (Task 13's matcher) */
): Promise<{ events: CalendarEvent[]; moreCount: number }>;
// Repeating series: only the latest occurrence before cutoff, only if undone, never one due before
// series.armedAt - ARMED_GRACE_MS, and none when the series occurs on summaryDay. One-offs: no armedAt bound.

// src/services/event-parser.ts — Task 10 (+ Task 11)
// ParsedEvent gains (Task 10): kind?: 'event' | 'reminder' (the parser sets it ONLY on reminders; events never carry kind — always test kind === 'reminder');
//   forPerson?: 'self' | 'partner'; anchor?: { description: string; offsetMinutes: number };
// ParsedEvent gains (Task 11, written only by resolveReminderIntents):
//   forUserId?: number | null; forName?: string; reminderNotice?: 'partner_not_on_telegram' | 'no_time_set';
// src/services/voice/gemini-voice.ts — Task 10
export interface ReminderPromptContext { userName: string; userEnglishName?: string | null; partnerName?: string | null; partnerEnglishName?: string | null }
// buildEventExtractionPrompt(language, calendars, timezone, mode, recentEventsBlock?, reminders?: ReminderPromptContext)
//   reminders undefined → prompt byte-identical to today's.
// parseGeminiEventResponse(parsed, calendars, timezone, remindersOn = false)
// extractIntents(parsed, calendars, timezone, remindersOn = false)   — the photo path passes 3 args, so it never yields reminders (R10)
export function buildReminderTimes(startDate, startTime, allDay, timezone, now?): { start: Date; allDay: boolean };
// processVoiceWithGemini(..., recentEventsBlock?, priorAudioBuffer?, reminders?: ReminderPromptContext)  — reminders is the 7th parameter
// src/services/forward-event/gemini-text.ts — Task 10 (+ Task 12)
export type TextSource = 'forwarded' | 'typed';
// processTextWithGemini(text, language, calendars, timezone, reminders?: ReminderPromptContext, source: TextSource = 'forwarded')
//   resolves to { intentResult, intentResults: VoiceIntentResult[], metrics }   (intentResult === intentResults[0])

// src/services/native-reminders/resolve.ts — Task 11
export type ResolvedReminder =
  | { ok: true; calendarId: string; forUserId: number | null; startTime: Date; endTime: Date; allDay: boolean;
      notice?: 'partner_not_on_telegram' | 'no_time_set' }
  | { ok: false; error: 'anchor_not_found' | 'anchor_ambiguous' | 'anchor_needs_time' };
export async function resolveReminderForCreate(user: UserConfig, event: ParsedEvent, timezone: string, now?: Date): Promise<ResolvedReminder>;
export interface ReminderFailure { error: 'anchor_not_found' | 'anchor_ambiguous' | 'anchor_needs_time'; description: string }
export async function resolveReminderIntents(user: UserConfig, intents: VoiceIntentResult[], timezone: string,
  options?: { selfOnly?: boolean; now?: Date }): Promise<{ intents: VoiceIntentResult[]; failures: ReminderFailure[] }>;
//   EVERY create path (voice, forward, typed, WhatsApp) resolves through this; it is the only writer of forName/forUserId/reminderNotice.
export function refreshReminderNotice(event: ParsedEvent, timezone: string, now?: Date): ParsedEvent;
export function anchorCandidates(events: CalendarEvent[], now: Date, timezone: string): CalendarEvent[];
export function reminderTimeFromAnchor(anchorEvent: CalendarEvent, offsetMinutes: number, timezone: string):
  { ok: true; startTime: Date; allDay: boolean } | { ok: false; error: 'anchor_needs_time' };
export async function reminderPromptContext(user: UserConfig, options?: { withPartner?: boolean }): Promise<ReminderPromptContext>;
export function reminderCreateFields(event: ParsedEvent): Partial<Pick<CreateEventInput, 'kind' | 'forUserId' | 'endTime'>>;
// src/services/voice/confirmations.ts — Task 11
export function formatReminderWhen(event: Pick<ParsedEvent, 'startTime' | 'allDay'>, language: string, timezone: string): string; // plain short date+time: card 📆 line, bulk lines
export async function formatReminderRelativeWhen(event: Pick<ParsedEvent, 'startTime' | 'allDay'>, language: string, timezone: string): Promise<string>; // when.* keys: created reply only
export async function formatReminderCard(event: ParsedEvent, language: string, timezone: string, markup?: 'html' | 'whatsapp'): Promise<string>;
export async function reminderCreatedLine(event: ParsedEvent, language: string, timezone: string, html?: boolean): Promise<string>;
export async function formatReminderCreated(event: ParsedEvent, language: string, timezone: string): Promise<string>;
export function anchorQuestion(failure: ReminderFailure, language: string, html?: boolean): Promise<string>;
export async function sendAnchorQuestions(chatId: number | string, failures: ReminderFailure[], language: string, service: IMessagingService): Promise<void>;
// src/services/voice/tts-outcome.ts — Task 11
export async function formatReminderOutcomeLine(event: ParsedEvent, language: string, timezone: string): Promise<string>;
// src/services/voice/event-resolution.ts — Task 11 (+ Task 13)
export interface MatchOptions {
  eligible?: (events: CalendarEvent[]) => CalendarEvent[];   // Task 11 (anchors)
  request?: string; openReminders?: boolean;                 // Task 13 (edit/delete matcher)
}
// findMatchingEvent(user, calendarIds, reference, language, now?: Date, options: MatchOptions = {}): Promise<MatchResult>
//   matchInRange applies `eligible` after merging open reminders and before collapsing series.

// src/services/native-reminders/typed-route.ts — Task 12
export function hasReminderKeyword(text: string): boolean;
export async function handleTypedReminderText(user: UserConfig, chatId: number, text: string, messageId: number): Promise<void>;

// src/services/native-reminders/moved-pings.ts — Task 13
export async function stripMovedPings(pings: ClearedPing[], original: CalendarEvent, updates: UpdateEventData, editor: UserConfig): Promise<void>; // never throws
export function movedWhen(startsAt: Date, allDay: boolean, language: string, readerZone: string, ownZone: string): string;
```

### i18n keys (added in Task 4, used by later tasks)

Every key exists in `messages/en.json`, `messages/he.json` and `messages/ru.json` under `bot.nativeReminders`. `{param}` placeholders are interpolated by `getBotMessage`.

```
ping.from               "from: {name}"
buttons.done            "✅ Done"
buttons.snooze15        "💤 15 min"
buttons.snooze60        "💤 1 hour"
buttons.snoozeTomorrow  "💤 Tomorrow"
done                    "✅ {title}"
snoozedUntil            "💤 {title} · until {time}"
alreadyDone             "Already done 👍"
notYours                "This reminder isn't yours."
changed                 "This reminder changed or no longer exists."
doneBy                  "✅ Done by {name}: {title}"
moved                   "⏰ {title} · moved to {when}"
card.title              "⏰ {title}"
card.forPartner         "for {name}"
card.noTimeSet          "No time set; it'll be in your summaries."
card.partnerNotOnTelegram "{name} isn't on Telegram, so I can't ping them. Keep it as yours?"
card.keepAsMine         "Keep as mine"
created.self            "⏰ I'll remind you {when}."
created.partner         "⏰ I'll remind {name} {when}."
created.dateOnly        "⏰ Reminder set for {when}."
when.todayAt            "today at {time}"
when.tomorrowAt         "tomorrow at {time}"
when.dateAt             "on {date} at {time}"
when.today              "today"
when.tomorrow           "tomorrow"
when.date               "{date}"
typed.processing        "⏰ On it…"
typed.notUnderstood     "I couldn't find a reminder in that. Try: “remind me to call mom tomorrow at 5”."
anchor.notFound         "I couldn't find “{description}” in your calendar. When should I remind you?"
anchor.ambiguous        "I found more than one “{description}”. Which one, or what time?"
anchor.needsTime        "“{description}” is all day. What time should I remind you?"
permissionDenied        "You can't change this one."
```

(The English values above are the reference copy. The Hebrew and Russian values are natural, gender-neutral equivalents, not literal translations.)

---

<!-- TASKS: each "### Task N" section below is the complete brief for one implementer. -->

### Task 1: Schema, migration, ownership and due-gate helpers

**Files:**
- Modify: `prisma/schema.prisma:81-87` — `User` gains the back-relations `nativeRemindersFor` ("NativeRemindersFor") and `nativeRemindersDone` ("NativeRemindersDone").
- Modify: `prisma/schema.prisma:133-135` — `AdminSettings.nativeRemindersEnabled Boolean @default(true)`.
- Modify: `prisma/schema.prisma:158-161` — new `enum NativeEventKind { EVENT REMINDER }` after `NativeEventInstanceStatus`.
- Modify: `prisma/schema.prisma:186-211` — `NativeEvent` gains `kind`, `forUserId` + `forUser` (SetNull), `armedAt`, `states`, `@@index([kind, isDeleted, startsAt])`, `@@index([forUserId])`.
- Modify: `prisma/schema.prisma:228-230` — new `model NativeReminderState` after `NativeEventInstance`, exactly as spec §1.
- Create: `prisma/migrations/20261014000000_native_reminders/migration.sql` — hand-written, idempotent SQL: Prisma's own diff for this change, guarded.
- Create: `src/services/native-reminders/ownership.ts` — `PartnerSummary`, `ViewerContext`, `getActivePartnerSummary`, `loadViewerContext`, `effectiveOwnerId`, `effectiveOwnerForViewer`. It reads `Pairing` itself and never imports `event-store.ts` (Planning Ruling 2).
- Create: `src/services/native-reminders/due-gate.ts` — `DUE_GATE_CEILING_MS`, `invalidateDueGate`, `shouldRunPass`, `setNextDue`, `__resetDueGateForTests`. Its state lives on `globalThis` (Planning Ruling 1).
- Modify: `scripts/smoke-recurrence.ts:56` — `makeSeries` builds a full `NativeEvent` literal. `tsconfig.json` includes `scripts/**`, so the three new required columns would break `tsc` without this.
- Test: `scripts/smoke-native-reminder-ownership.ts` (new).

**Interfaces:**
- Consumes (existing code, unchanged): `prisma` from `src/utils/prisma.ts`, through `prisma.pairing.findUnique` and `prisma.user.findUnique`. `ownership.ts` repeats the ACTIVE-partner rule of `getPartnerUserId` (`src/services/native-calendar/event-store.ts:64-72`) instead of importing it, because Task 2 makes `event-store.ts` import `ownership.ts` (Planning Ruling 2).
- Produces (exactly as in the Shared Interfaces contract):
  ```ts
  // src/services/native-reminders/ownership.ts
  export interface PartnerSummary {
    id: number; name: string; englishName: string /* '' when unset: use ||, not ?? */; gender: string;
    calendarSource: 'GOOGLE' | 'NATIVE'; telegramId: bigint | null; language: string;
  }
  export interface ViewerContext { viewerId: number; partner: PartnerSummary | null } // partner = ACTIVE partner
  export async function getActivePartnerSummary(userId: number, pairingId: string | null): Promise<PartnerSummary | null>;
  export async function loadViewerContext(user: { id: number; pairingId: string | null }): Promise<ViewerContext>;
  /** forUserId counts only while it is the creator's ACTIVE partner and that partner is NATIVE; otherwise the creator. */
  export function effectiveOwnerId(
    series: { creatorUserId: number; forUserId: number | null },
    creatorPartner: { id: number; calendarSource: string } | null
  ): number;
  /** effectiveOwnerId seen from a viewer: creator===viewer → creatorPartner = ctx.partner;
   *  creator===ctx.partner.id → creatorPartner = { id: ctx.viewerId, calendarSource: 'NATIVE' }; else null. */
  export function effectiveOwnerForViewer(series: { creatorUserId: number; forUserId: number | null }, ctx: ViewerContext): number;

  // src/services/native-reminders/due-gate.ts
  // State lives on globalThis: { nextDueAt: number; writtenSinceGate: boolean } under __nativeReminderDueGate.
  export const DUE_GATE_CEILING_MS: number;            // 60 min
  export function invalidateDueGate(): void;            // nextDueAt = 0, writtenSinceGate = true
  export function shouldRunPass(now: Date): boolean;    // now >= nextDueAt; when it returns true it clears writtenSinceGate (= pass start)
  export function setNextDue(next: Date | null, now: Date): void; // no-op while writtenSinceGate; else nextDueAt = min(next ?? +inf, now + ceiling)
  export function __resetDueGateForTests(): void;
  // Cron handler order: check its running flag BEFORE shouldRunPass; call setNextDue only after a successful pass.
  ```
- `PartnerSummary.englishName` is `''` when unset (Prisma's `String @default("")`), never `null`. Consumers fall back with `||`, not `??`.
- Produces (Prisma, after `npx prisma generate`): enum `NativeEventKind` (`'EVENT' | 'REMINDER'`); `NativeEvent.kind: NativeEventKind`, `NativeEvent.forUserId: number | null`, `NativeEvent.armedAt: Date | null`; the `prisma.nativeReminderState` delegate with `id, seriesEventId, originalStartsAt, doneAt, doneByUserId, snoozedUntil, lastPingedAt, pingAttempts, pingChatId (bigint | null), pingMessageId, createdAt, updatedAt` and the compound unique `seriesEventId_originalStartsAt`; `AdminSettings.nativeRemindersEnabled: boolean`.
- Due-gate rule (Planning Ruling 1; Task 8 codes the cron handler against it): `shouldRunPass` returning true marks the start of a pass. An `invalidateDueGate()` that lands after that, while the pass is still reading, keeps the gate open through that pass's `setNextDue`, so the next tick reads the write. The cron handler must therefore check its `running` flag **before** it calls `shouldRunPass`, and call `setNextDue` only after a successful pass. The gate's state is on `globalThis`, so a write made from a route bundle (webhook, admin) clears the memo the scheduler bundle reads.

- [ ] **Step 1: Write the failing test**

Create `scripts/smoke-native-reminder-ownership.ts`:

```ts
// Smoke test for the native reminders' ownership rules and due gate:
// src/services/native-reminders/ownership.ts and due-gate.ts. A reminder's forUserId
// counts only while that user is the creator's ACTIVE partner and on the built-in
// calendar, so unlinking or a switch to Google hands it back to the creator with no
// write. The due gate lets the 1-minute pass skip the database until something may be
// due, without sleeping through a write. Prisma is faked. No network, no DB.
//
// Run under both clocks; the output must not depend on the server's timezone:
//   TZ=UTC npx tsx scripts/smoke-native-reminder-ownership.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-native-reminder-ownership.ts

import path from 'path';
import {
  __resetDueGateForTests,
  DUE_GATE_CEILING_MS,
  invalidateDueGate,
  setNextDue,
  shouldRunPass,
} from '../src/services/native-reminders/due-gate';
import type { PartnerSummary, ViewerContext } from '../src/services/native-reminders/ownership';

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
}

function assert(cond: boolean, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

/** JSON that can show a BigInt telegramId. */
const show = (value: unknown) => JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? `${v}n` : v));

function assertSame(got: unknown, want: unknown) {
  assert(show(got) === show(want), `\n     got  ${show(got)}\n     want ${show(want)}`);
}

// ---- Fake Prisma: users and pairings ----

type Row = Record<string, unknown>;
const USERS: Row[] = [
  { id: 1, name: 'רזיאל', englishName: 'Raziel', gender: 'male', calendarSource: 'NATIVE', telegramId: BigInt(1001), language: 'he', pairingId: 'pair-1', location: 'Tel Aviv' },
  { id: 2, name: 'Dana', englishName: 'Dana', gender: 'female', calendarSource: 'NATIVE', telegramId: null, language: 'en', pairingId: 'pair-1', location: '' },
  { id: 3, name: 'Noa', englishName: '', gender: 'female', calendarSource: 'GOOGLE', telegramId: BigInt(1003), language: 'ru', pairingId: 'pair-2', location: '' },
  { id: 4, name: 'Ari', englishName: 'Ari', gender: 'male', calendarSource: 'NATIVE', telegramId: BigInt(1004), language: 'en', pairingId: 'pair-2', location: '' },
];
const PAIRINGS: Row[] = [
  { id: 'pair-1', status: 'ACTIVE', inviterUserId: 1, inviteeUserId: 2 },
  { id: 'pair-2', status: 'ACTIVE', inviterUserId: 3, inviteeUserId: 4 },
  { id: 'pair-old', status: 'UNLINKED', inviterUserId: 5, inviteeUserId: 1 },
  { id: 'pair-pending', status: 'PENDING', inviterUserId: 6, inviteeUserId: null },
];

/** Every query, to see which reads a lookup made. */
const queries: string[] = [];

/** Prisma returns only the selected columns, so a column the code forgets to select is missing. */
const pick = (row: Row | undefined, select?: Record<string, boolean>) =>
  !row ? null : !select ? row : Object.fromEntries(Object.keys(select).filter(k => select[k]).map(k => [k, row[k]]));

type FindUnique = { where: { id: unknown }; select?: Record<string, boolean> };
const fakePrisma = {
  pairing: {
    findUnique: async ({ where, select }: FindUnique) => {
      queries.push(`pairing ${where.id}`);
      return pick(PAIRINGS.find(p => p.id === where.id), select);
    },
  },
  user: {
    findUnique: async ({ where, select }: FindUnique) => {
      queries.push(`user ${where.id}`);
      return pick(USERS.find(u => u.id === where.id), select);
    },
  },
};

// ---- Viewers ----

const partnerSummary = (id: number, calendarSource: 'GOOGLE' | 'NATIVE' = 'NATIVE'): PartnerSummary =>
  ({ id, name: `User ${id}`, englishName: '', gender: 'female', calendarSource, telegramId: null, language: 'en' });
const viewer = (viewerId: number, partner: PartnerSummary | null): ViewerContext => ({ viewerId, partner });

/** A reminder by `creatorUserId`, for `forUserId` (null = the creator). */
const reminder = (creatorUserId: number, forUserId: number | null) => ({ creatorUserId, forUserId });

async function main() {
  // The stubs go into require's cache before the modules that import them load.
  const Module = (await import('module')).default as unknown as {
    new (id: string): { filename: string; loaded: boolean; exports: unknown };
    _cache: Record<string, unknown>;
  };
  const stub = (file: string, exports: Record<string, unknown>) => {
    const filename = path.resolve(__dirname, '../src', file);
    const mod = new Module(filename);
    Object.assign(mod, { filename, loaded: true, exports });
    Module._cache[filename] = mod;
  };
  stub('utils/prisma.ts', { prisma: fakePrisma });

  const { effectiveOwnerForViewer, effectiveOwnerId, getActivePartnerSummary, loadViewerContext } =
    await import('../src/services/native-reminders/ownership');

  // ---- getActivePartnerSummary / loadViewerContext ----

  await check('partner summary: the inviter gets the invitee, with exactly the fields reminders need', async () => {
    assertSame(await getActivePartnerSummary(1, 'pair-1'), {
      id: 2, name: 'Dana', englishName: 'Dana', gender: 'female', calendarSource: 'NATIVE', telegramId: null, language: 'en',
    });
  });

  await check('partner summary: the invitee gets the inviter', async () => {
    assertSame(await getActivePartnerSummary(2, 'pair-1'), {
      id: 1, name: 'רזיאל', englishName: 'Raziel', gender: 'male', calendarSource: 'NATIVE', telegramId: BigInt(1001), language: 'he',
    });
  });

  await check('partner summary: no pairing is null, without a query', async () => {
    queries.length = 0;
    assert((await getActivePartnerSummary(1, null)) === null, 'got a partner');
    assert(queries.length === 0, `queried ${queries.join(', ')}`);
  });

  await check('partner summary: an UNLINKED or PENDING pairing is null, and no user is read', async () => {
    queries.length = 0;
    assert((await getActivePartnerSummary(1, 'pair-old')) === null, 'unlinked pairing gave a partner');
    assert((await getActivePartnerSummary(6, 'pair-pending')) === null, 'pending pairing gave a partner');
    assertSame(queries, ['pairing pair-old', 'pairing pair-pending']);
  });

  await check('loadViewerContext: the viewer and their ACTIVE partner, a Google one included', async () => {
    const ctx = await loadViewerContext({ id: 4, pairingId: 'pair-2' });
    assert(ctx.viewerId === 4, `viewerId ${ctx.viewerId}`);
    assert(ctx.partner?.id === 3 && ctx.partner.calendarSource === 'GOOGLE', `partner ${show(ctx.partner)}`);
    const alone = await loadViewerContext({ id: 1, pairingId: null });
    assertSame(alone, { viewerId: 1, partner: null });
  });

  // ---- effectiveOwnerId ----

  await check('owner: no forUserId is the creator', () => {
    assert(effectiveOwnerId(reminder(1, null), partnerSummary(2)) === 1, 'not the creator');
  });

  await check('owner: forUserId = the ACTIVE NATIVE partner is the partner', () => {
    assert(effectiveOwnerId(reminder(1, 2), partnerSummary(2)) === 2, 'not the partner');
  });

  await check('owner: a partner who switched to Google hands it back to the creator', () => {
    assert(effectiveOwnerId(reminder(1, 2), partnerSummary(2, 'GOOGLE')) === 1, 'still the partner');
  });

  await check('owner: after unlinking (no partner) it is the creator\'s', () => {
    assert(effectiveOwnerId(reminder(1, 2), null) === 1, 'still the ex-partner');
  });

  await check('owner: forUserId of a stranger, or of the creator, is the creator', () => {
    assert(effectiveOwnerId(reminder(1, 9), partnerSummary(2)) === 1, 'a stranger owns it');
    assert(effectiveOwnerId(reminder(1, 1), partnerSummary(2)) === 1, 'self-target not the creator');
  });

  // ---- effectiveOwnerForViewer ----

  const raziel = viewer(1, partnerSummary(2));
  const dana = viewer(2, partnerSummary(1));

  await check('viewer is the creator: their own reminder is theirs, one for the partner is the partner\'s', () => {
    assert(effectiveOwnerForViewer(reminder(1, null), raziel) === 1, 'own reminder');
    assert(effectiveOwnerForViewer(reminder(1, 2), raziel) === 2, 'reminder for Dana');
  });

  await check('viewer is the partner: one made for them is theirs, the creator\'s own stays the creator\'s', () => {
    assert(effectiveOwnerForViewer(reminder(1, 2), dana) === 2, 'reminder for Dana, seen by Dana');
    assert(effectiveOwnerForViewer(reminder(1, null), dana) === 1, 'Raziel\'s own, seen by Dana');
    assert(effectiveOwnerForViewer(reminder(1, 1), dana) === 1, 'Raziel\'s self-target, seen by Dana');
  });

  await check('viewer is a third party: the creator\'s, whatever forUserId says', () => {
    assert(effectiveOwnerForViewer(reminder(7, 2), raziel) === 7, 'third party\'s reminder for Dana');
    assert(effectiveOwnerForViewer(reminder(7, 1), raziel) === 7, 'third party\'s reminder for the viewer');
  });

  await check('viewer after unlinking: both sides read the creator', () => {
    assert(effectiveOwnerForViewer(reminder(1, 2), viewer(1, null)) === 1, 'creator still sees the ex-partner as owner');
    assert(effectiveOwnerForViewer(reminder(1, 2), viewer(2, null)) === 1, 'ex-partner still owns it');
  });

  await check('viewer whose partner switched to Google: the creator\'s', () => {
    assert(effectiveOwnerForViewer(reminder(1, 2), viewer(1, partnerSummary(2, 'GOOGLE'))) === 1, 'Google partner owns it');
  });

  // ---- Due gate ----

  const t0 = new Date('2026-10-14T09:00:00Z');
  const plus = (ms: number) => new Date(t0.getTime() + ms);
  const MIN = 60 * 1000;

  await check('gate: a fresh process reads the database on its first tick', () => {
    __resetDueGateForTests();
    assert(shouldRunPass(t0), 'closed at start');
  });

  await check('gate: sleeps until the earliest due, then opens', () => {
    __resetDueGateForTests();
    assert(shouldRunPass(t0), 'closed at start');
    setNextDue(plus(10 * MIN), t0);
    assert(!shouldRunPass(plus(10 * MIN - 1)), 'open before the due time');
    assert(shouldRunPass(plus(10 * MIN)), 'closed at the due time');
  });

  await check('gate: never sleeps past the 60-minute ceiling', () => {
    assert(DUE_GATE_CEILING_MS === 60 * MIN, `ceiling ${DUE_GATE_CEILING_MS}`);
    __resetDueGateForTests();
    setNextDue(plus(3 * 60 * MIN), t0);
    assert(!shouldRunPass(plus(60 * MIN - 1)), 'open before the ceiling');
    assert(shouldRunPass(plus(60 * MIN)), 'closed at the ceiling');
  });

  await check('gate: nothing upcoming wakes at the ceiling', () => {
    __resetDueGateForTests();
    setNextDue(null, t0);
    assert(!shouldRunPass(plus(60 * MIN - 1)), 'open before the ceiling');
    assert(shouldRunPass(plus(60 * MIN)), 'closed at the ceiling');
  });

  await check('gate: a reminder write opens it at once', () => {
    __resetDueGateForTests();
    setNextDue(plus(30 * MIN), t0);
    invalidateDueGate();
    assert(shouldRunPass(plus(1)), 'closed after the write');
  });

  await check('gate: a write during a pass is not closed over by that pass\'s answer', () => {
    __resetDueGateForTests();
    assert(shouldRunPass(t0), 'closed at start');
    invalidateDueGate(); // the write lands while the pass is reading
    setNextDue(plus(3 * 60 * MIN), t0);
    assert(shouldRunPass(plus(MIN)), 'the next tick skips the write');
    // That next pass has read the write, so its answer counts.
    setNextDue(plus(3 * 60 * MIN), plus(MIN));
    assert(!shouldRunPass(plus(2 * MIN)), 'open after a clean pass');
  });

  await check('gate: a write before a pass starts is read by it, so the pass\'s answer counts', () => {
    __resetDueGateForTests();
    setNextDue(plus(30 * MIN), t0);
    invalidateDueGate();
    assert(shouldRunPass(plus(MIN)), 'closed after the write');
    setNextDue(plus(30 * MIN), plus(MIN));
    assert(!shouldRunPass(plus(2 * MIN)), 'open after the pass that read the write');
    assert(shouldRunPass(plus(30 * MIN)), 'closed at the due time');
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `TZ=UTC npx tsx scripts/smoke-native-reminder-ownership.ts; echo "exit=$?"`

Expected: it crashes before any check runs, with `Error: Cannot find module '../src/services/native-reminders/due-gate'` (code `MODULE_NOT_FOUND`), then `exit=1`.

- [ ] **Step 3: Add the User back-relations**

In `prisma/schema.prisma`, find (lines 81-87):

```prisma
  // Native calendar relations
  ownedNativeCalendars   NativeCalendar[] @relation("OwnedNativeCalendars")
  createdNativeEvents    NativeEvent[]    @relation("CreatedNativeEvents")
  pairingsInvited        Pairing[]        @relation("PairingsInvited")
  pairingsAccepted       Pairing[]        @relation("PairingsAccepted")
  pairingInvitesCreated  PairingInvite[]  @relation("PairingInvitesCreated")
  pairingInvitesAccepted PairingInvite[]  @relation("PairingInvitesAccepted")
```

Replace with (this is `prisma format` output, so the column alignment changes on every line):

```prisma
  // Native calendar relations
  ownedNativeCalendars   NativeCalendar[]      @relation("OwnedNativeCalendars")
  createdNativeEvents    NativeEvent[]         @relation("CreatedNativeEvents")
  nativeRemindersFor     NativeEvent[]         @relation("NativeRemindersFor")
  nativeRemindersDone    NativeReminderState[] @relation("NativeRemindersDone")
  pairingsInvited        Pairing[]             @relation("PairingsInvited")
  pairingsAccepted       Pairing[]             @relation("PairingsAccepted")
  pairingInvitesCreated  PairingInvite[]       @relation("PairingInvitesCreated")
  pairingInvitesAccepted PairingInvite[]       @relation("PairingInvitesAccepted")
```

- [ ] **Step 4: Add the admin switch**

In `prisma/schema.prisma`, find (lines 133-135):

```prisma
  voiceTtsOutcome         Boolean  @default(false) // Speak the outcome line back when input was voice
  updatedAt               DateTime @updatedAt
}
```

Replace with:

```prisma
  voiceTtsOutcome         Boolean  @default(false) // Speak the outcome line back when input was voice
  nativeRemindersEnabled  Boolean  @default(true) // Built-in calendar reminders: the extraction rules and the 1-minute ping pass
  updatedAt               DateTime @updatedAt
}
```

- [ ] **Step 5: Add the `NativeEventKind` enum**

In `prisma/schema.prisma`, find (lines 158-161):

```prisma
enum NativeEventInstanceStatus {
  OVERRIDE // This occurrence has modified fields (rescheduled, retitled, etc.)
  CANCELLED // This occurrence is removed (alternative to series-level exdates)
}
```

Replace with:

```prisma
enum NativeEventInstanceStatus {
  OVERRIDE // This occurrence has modified fields (rescheduled, retitled, etc.)
  CANCELLED // This occurrence is removed (alternative to series-level exdates)
}

enum NativeEventKind {
  EVENT // Has a duration (every event before reminders)
  REMINDER // No duration: endsAt = startsAt; all-day = start of its local day
}
```

- [ ] **Step 6: Extend `NativeEvent`**

In `prisma/schema.prisma`, replace the whole `model NativeEvent { … }` block (lines 186-211, from `model NativeEvent {` through the `@@index([creatorUserId])` line and its closing `}`) with:

```prisma
model NativeEvent {
  id              String          @id @default(cuid())
  calendarId      String
  calendar        NativeCalendar  @relation(fields: [calendarId], references: [id], onDelete: Cascade)
  creatorUserId   Int
  creator         User            @relation("CreatedNativeEvents", fields: [creatorUserId], references: [id], onDelete: Restrict)
  title           String
  description     String?         @db.Text
  location        String?
  startsAt        DateTime // For recurring: dtstart
  endsAt          DateTime
  allDay          Boolean         @default(false)
  timeZone        String // IANA tz, snapshot at creation
  rrule           String? // RFC-5545 RRULE on series; null = single event
  exdates         DateTime[]      @default([]) // Cancelled instance start times (UTC)
  reminderMinutes Int? // Overrides user default
  kind            NativeEventKind @default(EVENT)
  forUserId       Int? // REMINDER target; null = the creator. Meaningful only for REMINDER
  forUser         User?           @relation("NativeRemindersFor", fields: [forUserId], references: [id], onDelete: SetNull)
  armedAt         DateTime? // REMINDER: when its time was last set (create or time change); bounds the ping lookback
  isDeleted       Boolean         @default(false)
  createdAt       DateTime        @default(now())
  updatedAt       DateTime        @updatedAt

  instances NativeEventInstance[]
  states    NativeReminderState[]

  @@index([calendarId, startsAt])
  @@index([calendarId, isDeleted])
  @@index([creatorUserId])
  @@index([kind, isDeleted, startsAt])
  @@index([forUserId])
}
```

- [ ] **Step 7: Add `NativeReminderState`**

In `prisma/schema.prisma`, find the end of `NativeEventInstance` (lines 228-230; the `@@index` line is unique in the file):

```prisma
  @@unique([seriesEventId, originalStartsAt])
  @@index([seriesEventId, originalStartsAt])
}
```

Replace with:

```prisma
  @@unique([seriesEventId, originalStartsAt])
  @@index([seriesEventId, originalStartsAt])
}

// Per-occurrence state of a REMINDER, keyed like NativeEventInstance. No row means
// pending; a row appears once the occurrence is pinged, snoozed or marked done.
model NativeReminderState {
  id               String      @id @default(cuid())
  seriesEventId    String
  seriesEvent      NativeEvent @relation(fields: [seriesEventId], references: [id], onDelete: Cascade)
  originalStartsAt DateTime // occurrence key, exactly expandSeries' instanceStartsAt (one-off: startsAt)
  doneAt           DateTime?
  doneByUserId     Int?
  doneBy           User?       @relation("NativeRemindersDone", fields: [doneByUserId], references: [id], onDelete: SetNull)
  snoozedUntil     DateTime?
  lastPingedAt     DateTime?
  pingAttempts     Int         @default(0)
  pingChatId       BigInt? // the live ping message, so later edits can strip its buttons
  pingMessageId    Int?
  createdAt        DateTime    @default(now())
  updatedAt        DateTime    @updatedAt

  @@unique([seriesEventId, originalStartsAt])
  @@index([snoozedUntil])
}
```

- [ ] **Step 8: Format, validate and generate**

These commands read the schema only. None of them connects to a database. Do **not** run `prisma migrate dev`, `prisma migrate deploy` or `prisma db push` in this task (the DEV-database pass is Task 14).

Run:
```bash
npx prisma format && git diff --stat prisma/schema.prisma
npx prisma validate
npx prisma generate
```

Expected:
- `Formatted prisma/schema.prisma in …ms 🚀`. The schema was written pre-formatted, so formatting changes nothing: `git diff --stat` shows `1 file changed, 52 insertions(+), 15 deletions(-)` before and after it.
- `The schema at prisma/schema.prisma is valid 🚀`
- `✔ Generated Prisma Client (v5.22.0) to ./node_modules/@prisma/client in …ms`

- [ ] **Step 9: Write the migration**

Create `prisma/migrations/20261014000000_native_reminders/migration.sql`:

```sql
-- Native reminders (docs/superpowers/specs/2026-10-14-native-reminders-design.md §1).
-- A reminder is a NativeEvent of kind REMINDER with no duration. forUserId names the
-- creator's partner when it is for them (SET NULL on delete: it reverts to the creator).
-- armedAt bounds the ping lookback. Per-occurrence state (pinged, snoozed, done) lives in
-- NativeReminderState, keyed like NativeEventInstance. AdminSettings gets the launch
-- switch, on by default. Existing rows become kind EVENT, so no event changes.
--
-- Hand-written and idempotent, like the other recent migrations: these are the
-- statements Prisma's diff produces for this schema change, guarded so a re-run is a
-- no-op (CREATE TYPE and ADD CONSTRAINT have no IF NOT EXISTS, hence the DO blocks).

DO $$ BEGIN
  CREATE TYPE "NativeEventKind" AS ENUM ('EVENT', 'REMINDER');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

ALTER TABLE "AdminSettings" ADD COLUMN IF NOT EXISTS "nativeRemindersEnabled" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "NativeEvent" ADD COLUMN IF NOT EXISTS "kind" "NativeEventKind" NOT NULL DEFAULT 'EVENT';
ALTER TABLE "NativeEvent" ADD COLUMN IF NOT EXISTS "forUserId" INTEGER;
ALTER TABLE "NativeEvent" ADD COLUMN IF NOT EXISTS "armedAt" TIMESTAMP(3);

-- The ping pass's candidate scan (kind = REMINDER, not deleted, by start) and the
-- "reminders for me" read across a partner's calendars, whatever their privacy.
CREATE INDEX IF NOT EXISTS "NativeEvent_kind_isDeleted_startsAt_idx" ON "NativeEvent"("kind", "isDeleted", "startsAt");
CREATE INDEX IF NOT EXISTS "NativeEvent_forUserId_idx" ON "NativeEvent"("forUserId");

CREATE TABLE IF NOT EXISTS "NativeReminderState" (
    "id" TEXT NOT NULL,
    "seriesEventId" TEXT NOT NULL,
    "originalStartsAt" TIMESTAMP(3) NOT NULL,
    "doneAt" TIMESTAMP(3),
    "doneByUserId" INTEGER,
    "snoozedUntil" TIMESTAMP(3),
    "lastPingedAt" TIMESTAMP(3),
    "pingAttempts" INTEGER NOT NULL DEFAULT 0,
    "pingChatId" BIGINT,
    "pingMessageId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NativeReminderState_pkey" PRIMARY KEY ("id")
);

-- The unique key is also the ON CONFLICT target of the pass's atomic claim.
CREATE UNIQUE INDEX IF NOT EXISTS "NativeReminderState_seriesEventId_originalStartsAt_key" ON "NativeReminderState"("seriesEventId", "originalStartsAt");
CREATE INDEX IF NOT EXISTS "NativeReminderState_snoozedUntil_idx" ON "NativeReminderState"("snoozedUntil");

-- Foreign keys
DO $$ BEGIN
  ALTER TABLE "NativeEvent" ADD CONSTRAINT "NativeEvent_forUserId_fkey"
    FOREIGN KEY ("forUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "NativeReminderState" ADD CONSTRAINT "NativeReminderState_seriesEventId_fkey"
    FOREIGN KEY ("seriesEventId") REFERENCES "NativeEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "NativeReminderState" ADD CONSTRAINT "NativeReminderState_doneByUserId_fkey"
    FOREIGN KEY ("doneByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
```

Check it against Prisma's own DDL for the schema change. This uses two schema files and no database:

```bash
git show HEAD:prisma/schema.prisma > "${TMPDIR:-/tmp}/schema.before.prisma"
npx prisma migrate diff --from-schema-datamodel "${TMPDIR:-/tmp}/schema.before.prisma" --to-schema-datamodel prisma/schema.prisma --script
```

Expected: the same statements, unguarded: `CREATE TYPE "NativeEventKind" AS ENUM ('EVENT', 'REMINDER');`, `ALTER TABLE "AdminSettings" ADD COLUMN "nativeRemindersEnabled" BOOLEAN NOT NULL DEFAULT true;`, the three `NativeEvent` columns (`armedAt TIMESTAMP(3)`, `forUserId INTEGER`, `kind "NativeEventKind" NOT NULL DEFAULT 'EVENT'`), `CREATE TABLE "NativeReminderState"` with the same columns, the indexes `NativeReminderState_snoozedUntil_idx`, `NativeReminderState_seriesEventId_originalStartsAt_key` (UNIQUE), `NativeEvent_kind_isDeleted_startsAt_idx` and `NativeEvent_forUserId_idx`, and the FKs `NativeEvent_forUserId_fkey` (SET NULL), `NativeReminderState_seriesEventId_fkey` (CASCADE) and `NativeReminderState_doneByUserId_fkey` (SET NULL), all `ON UPDATE CASCADE`. Any name or type that differs from the migration file is a bug in the file.

- [ ] **Step 10: Keep `smoke-recurrence.ts` type-correct**

`makeSeries` returns a complete `NativeEvent`, which now has three more required columns. In `scripts/smoke-recurrence.ts`, find (lines 56-57):

```ts
    reminderMinutes: null,
    isDeleted: false,
```

Replace with:

```ts
    reminderMinutes: null,
    kind: 'EVENT',
    forUserId: null,
    armedAt: null,
    isDeleted: false,
```

- [ ] **Step 11: Create the due gate**

Create `src/services/native-reminders/due-gate.ts`:

```ts
// In-process "next due" memo for the native reminder pass (spec §4.1, ruling R7).
//
// The pass ticks every minute but reads the database only when something may be
// due: after a pass the memo holds the earliest upcoming due time, capped an hour
// out so a write this process never saw is still picked up. Every reminder write
// and every snooze clears it.
//
// The memo is per process, shared by the scheduler bundle and the route bundles.
// Next 16 compiles instrumentation.ts (scheduler → cron handler) and the route
// handlers (webhook, admin, manual cron routes) into separate module instances, so
// a module-level variable would give each bundle its own memo, and a write made in
// a route would never wake the scheduler. The state therefore lives on globalThis,
// the way src/utils/prisma.ts keeps global.prisma. Railway runs one instance; a
// second replica would need the memo in Redis.

export const DUE_GATE_CEILING_MS = 60 * 60 * 1000;

type GateState = {
  /** Epoch ms; the pass reads the database once now reaches it. 0 = on the next tick. */
  nextDueAt: number;
  /**
   * A write landed after the running pass went through the gate. That pass read the
   * database before the write, so its answer must not close the gate over it.
   */
  writtenSinceGate: boolean;
};

const g = globalThis as { __nativeReminderDueGate?: GateState };
const gate = (g.__nativeReminderDueGate ??= { nextDueAt: 0, writtenSinceGate: false });

/** Clear the memo: the next shouldRunPass() returns true. */
export function invalidateDueGate(): void {
  gate.nextDueAt = 0;
  gate.writtenSinceGate = true;
}

/** True when the pass should read the database. Call it only right before running the pass. */
export function shouldRunPass(now: Date): boolean {
  if (now.getTime() < gate.nextDueAt) return false;
  gate.writtenSinceGate = false;
  return true;
}

/** After a successful pass: sleep until the earliest upcoming due, or the ceiling, whichever is sooner. */
export function setNextDue(next: Date | null, now: Date): void {
  if (gate.writtenSinceGate) return; // stays open, so the next tick reads that write
  const ceiling = now.getTime() + DUE_GATE_CEILING_MS;
  gate.nextDueAt = next ? Math.min(next.getTime(), ceiling) : ceiling;
}

/** Smoke scripts only: back to the state of a fresh process. Resets the shared object in place. */
export function __resetDueGateForTests(): void {
  gate.nextDueAt = 0;
  gate.writtenSinceGate = false;
}
```

- [ ] **Step 12: Create the ownership helpers**

Create `src/services/native-reminders/ownership.ts`:

```ts
// Who a native reminder belongs to (spec §2, ruling R2).
//
// The effective owner is worked out on every read, never stored: forUserId counts
// only while that user is still the creator's ACTIVE partner and still on the
// built-in calendar. Unlinking, a switch to Google or a deleted account (forUserId
// goes null) all hand the reminder back to its creator with no write, and
// re-pairing with the same person restores the link.
//
// This file reads Pairing itself and never imports event-store.ts: event-store
// imports this file, and a cycle between the two breaks partial store stubs in the
// smoke scripts (Planning Ruling 2).

import { prisma } from '../../utils/prisma';

/** The ACTIVE partner, with what reminders need to name, ping and gate them. */
export interface PartnerSummary {
  id: number;
  name: string;
  /** '' when unset (Prisma's String @default("")), so fall back with ||, not ??. */
  englishName: string;
  gender: string;
  calendarSource: 'GOOGLE' | 'NATIVE';
  telegramId: bigint | null;
  language: string;
}

/** Whoever is reading reminders, and their ACTIVE partner (null when unpaired). */
export interface ViewerContext {
  viewerId: number;
  partner: PartnerSummary | null;
}

/**
 * The other member of the user's ACTIVE pairing, or null. The pairing rule is
 * event-store's getPartnerUserId, repeated here so the two files never import each other.
 */
export async function getActivePartnerSummary(userId: number, pairingId: string | null): Promise<PartnerSummary | null> {
  if (!pairingId) return null;
  const pair = await prisma.pairing.findUnique({
    where: { id: pairingId },
    select: { status: true, inviterUserId: true, inviteeUserId: true },
  });
  if (!pair || pair.status !== 'ACTIVE') return null;
  const partnerId = pair.inviterUserId === userId ? pair.inviteeUserId : pair.inviterUserId;
  if (partnerId == null) return null;
  return prisma.user.findUnique({
    where: { id: partnerId },
    select: { id: true, name: true, englishName: true, gender: true, calendarSource: true, telegramId: true, language: true },
  });
}

/** Load once per fetch or digest; every ownership check for this viewer reads it. */
export async function loadViewerContext(user: { id: number; pairingId: string | null }): Promise<ViewerContext> {
  return { viewerId: user.id, partner: await getActivePartnerSummary(user.id, user.pairingId ?? null) };
}

/** forUserId counts only while it is the creator's ACTIVE partner and that partner is NATIVE; otherwise the creator. */
export function effectiveOwnerId(
  series: { creatorUserId: number; forUserId: number | null },
  creatorPartner: { id: number; calendarSource: string } | null
): number {
  if (series.forUserId == null || !creatorPartner) return series.creatorUserId;
  if (series.forUserId !== creatorPartner.id || creatorPartner.calendarSource !== 'NATIVE') return series.creatorUserId;
  return creatorPartner.id;
}

/**
 * effectiveOwnerId seen from a viewer, with no extra query. The viewer's ACTIVE
 * partner is the creator's partner when the viewer created it, and the viewer is
 * the creator's partner when the partner created it (the viewer reads the built-in
 * calendar, so is NATIVE). Anyone else's reminder stays its creator's.
 */
export function effectiveOwnerForViewer(series: { creatorUserId: number; forUserId: number | null }, ctx: ViewerContext): number {
  const creatorPartner =
    series.creatorUserId === ctx.viewerId
      ? ctx.partner
      : ctx.partner && series.creatorUserId === ctx.partner.id
        ? { id: ctx.viewerId, calendarSource: 'NATIVE' }
        : null;
  return effectiveOwnerId(series, creatorPartner);
}
```

- [ ] **Step 13: Run tests to verify they pass**

Run:
```bash
TZ=UTC npx tsx scripts/smoke-native-reminder-ownership.ts
TZ=Asia/Jerusalem npx tsx scripts/smoke-native-reminder-ownership.ts
TZ=UTC npx tsx scripts/smoke-recurrence.ts | tail -1
TZ=Asia/Jerusalem npx tsx scripts/smoke-recurrence.ts | tail -1
npx tsc --noEmit -p .
npm run -s lint
```

Expected:
- The ownership smoke prints 22 `OK` lines, then `22/22 passed (process TZ=UTC)` and `22/22 passed (process TZ=Asia/Jerusalem)`, exit 0.
- `smoke-recurrence.ts` prints `24/24 passed` under both clocks.
- `tsc` prints nothing and exits 0. (Without Step 10 it fails with `scripts/smoke-recurrence.ts(43,3): error TS2322 … Types of property 'kind' are incompatible`.)
- `lint` prints nothing and exits 0.

- [ ] **Step 14: Commit**

The working tree also holds the uncommitted spec and plan docs. Stage only this task's files:

```bash
git add prisma/schema.prisma \
  prisma/migrations/20261014000000_native_reminders/migration.sql \
  src/services/native-reminders/ownership.ts \
  src/services/native-reminders/due-gate.ts \
  scripts/smoke-native-reminder-ownership.ts \
  scripts/smoke-recurrence.ts
git commit -F - <<'EOF'
feat(reminders): schema, ownership and due-gate helpers

A reminder is a NativeEvent of kind REMINDER, optionally for the creator's
partner (forUserId), with per-occurrence state in NativeReminderState. The
effective owner is worked out on every read, so unlinking or a switch to
Google hands a partner's reminder back to its creator with no write. The
due gate lets the 1-minute pass skip the database until something may be
due, and a write during a pass keeps it open. Its state lives on globalThis,
so the scheduler and the route bundles share it. The migration is
hand-written and idempotent.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
EOF
```

---

### Task 2: Event store reminder rules

**Files:**
- Modify: `src/services/native-calendar/event-store.ts:16-17` — imports: the day helpers, the due gate, the ownership helpers, onboarding
- Modify: `src/services/native-calendar/event-store.ts:118-119` — add `getMainNativeCalendar` after `listVisibleCalendars`
- Modify: `src/services/native-calendar/event-store.ts:210-214` — `CreateNativeEventInput` gains `kind` and `forUserId`; add `normalizeReminderTimes`
- Modify: `src/services/native-calendar/event-store.ts:241-259` — `createNativeEvent` stores a reminder zero-length and armed, then clears the due gate
- Modify: `src/services/native-calendar/event-store.ts:281-409` — `updateNativeEvent`: the creator may change a reminder, `ClearedPing`, the `clearedPings` result, and the reminder path (`reminderTimeEdit`, `clearReminderStates`, `updateNativeReminder`)
- Modify: `src/services/native-calendar/event-store.ts:446-449` — `deleteNativeEvent`: the creator or the effective owner may delete a reminder (`mayDeleteReminder`); the write half moves to `deleteOccurrences`; the due gate is cleared
- Modify: `scripts/smoke-reminders.ts:155,186-187` — the partial fake of the event store becomes a Proxy (`fakeOver`) that reads the real module lazily, so the fake survives import cycles
- Create: `scripts/smoke-native-reminder-store.ts` — the store's reminder rules against an in-memory Prisma
- Test: `scripts/smoke-native-reminder-store.ts`; regressions in `scripts/smoke-native-reminder-ownership.ts`, `scripts/smoke-reminders.ts`, `scripts/smoke-recurrence.ts`, `scripts/smoke-day-shaping.ts`, `scripts/smoke-voice-dates.ts`, `scripts/smoke-week-lookahead.ts`

**Interfaces:**
- Consumes (Task 1):
  - `src/services/native-reminders/due-gate.ts`: `invalidateDueGate(): void`, `shouldRunPass(now: Date): boolean`, `setNextDue(next: Date | null, now: Date): void`, `__resetDueGateForTests(): void` (the last three only in the test). The gate's state lives on `globalThis` (`__nativeReminderDueGate`). `invalidateDueGate()` sets `nextDueAt = 0` and `writtenSinceGate = true`; `shouldRunPass()` clears the flag when it returns true; `setNextDue()` is a no-op while the flag is set.
  - `src/services/native-reminders/ownership.ts`: `getActivePartnerSummary(userId: number, pairingId: string | null): Promise<PartnerSummary | null>` and `effectiveOwnerId(series: { creatorUserId: number; forUserId: number | null }, creatorPartner: { id: number; calendarSource: string } | null): number`.
  - The generated Prisma client: `NativeEvent.kind` (`'EVENT' | 'REMINDER'`), `NativeEvent.forUserId: number | null`, `NativeEvent.armedAt: Date | null`, and `prisma.nativeReminderState` with `seriesEventId`, `originalStartsAt`, `pingChatId: bigint | null`, `pingMessageId: number | null` and the unique key `(seriesEventId, originalStartsAt)`.
- Produces (`src/services/native-calendar/event-store.ts`):
  ```ts
  export interface CreateNativeEventInput { /* existing fields */ kind?: 'EVENT' | 'REMINDER'; forUserId?: number | null }
  export function normalizeReminderTimes(startsAt: Date, allDay: boolean, timeZone: string): { startsAt: Date; endsAt: Date };
  export async function getMainNativeCalendar(userId: number): Promise<NativeCalendar>;
  export interface ClearedPing { chatId: bigint; messageId: number }
  export async function updateNativeEvent(input: UpdateNativeEventInput): Promise<{ canonicalEventId: string; clearedPings: ClearedPing[] }>;
  export async function deleteNativeEvent(input: DeleteNativeEventInput): Promise<void>; // signature unchanged
  ```
- Behaviour later tasks rely on:
  - **Create:** `kind: 'REMINDER'` stores `endsAt = startsAt`, with a date-only reminder at 00:00 of its local day in `input.timeZone`. It sets `armedAt` to now, stores `forUserId` as given (`null` = the creator) and calls `invalidateDueGate()`. An EVENT write is unchanged and never stores `forUserId`.
  - **Update of a REMINDER:**
    - It is always zero-length; any `endsAt` passed in is ignored.
    - A change of start or `allDay` re-arms it inside the write's transaction:
      - `single` on a series: the state row of that occurrence is deleted;
      - a one-off, `all`, or `following` with no occurrence: every state row of the series is deleted;
      - a `following` split: the parent's rows at or after the cut are deleted.
    - The series' `armedAt` becomes now on a series-level time change. A moved single occurrence leaves the series' `armedAt` alone, so the pass (Task 8) uses the override's `updatedAt`.
    - A title- or location-only change deletes nothing. For a `following` rename, the parent's rows at or after the cut move to the new series, keeping their ids.
    - `clearedPings` lists the deleted rows that had both `pingChatId` and `pingMessageId`. Event writes return `clearedPings: []`.
    - A `following` split copies `kind`, `forUserId` and the parent's `creatorUserId`.
    - After an `all` or `following` time change, earlier occurrence keys move and have no state rows. Task 7 can bound carry-over at the series' `armedAt`.
  - **Permissions:**
    - Update: calendar write access, or the reminder's creator.
    - Delete: calendar write access, the creator, or the effective owner (`effectiveOwnerId` with the creator's ACTIVE partner).
    - Everything else throws `NativePermissionDeniedError` as before.
  - **Due gate:** `invalidateDueGate()` runs after every successful REMINDER create, update and delete, and never after an EVENT write.
  - **`getMainNativeCalendar`:**
    - It returns the user's own non-deleted calendar labelled `primary` (oldest first), else their oldest own non-deleted calendar, else the one `ensurePrimaryNativeCalendar` creates.
    - It throws `NativeNotFoundError('User has no native calendar')` when none can exist, which is the case for a non-NATIVE user.

- [ ] **Step 1: Write the failing test**

Create `scripts/smoke-native-reminder-store.ts`:

```ts
// Smoke test for the reminder rules in src/services/native-calendar/event-store.ts, the
// one place every native write goes through. A reminder is an event with no length
// (spec §1): it must stay zero-length however an edit sends its end, a change of its
// time must re-arm it (its done/snoozed/pinged state goes, and its live pings come
// back so their buttons can be stripped), a "from now on" split must keep it the
// creator's reminder for the same person, and its creator and the person it is for get
// the rights the calendar alone would not give them. Events must behave as before.
// Prisma is an in-memory stand-in; the due gate and the ownership helpers are real.
// No network, no database.
//
// Run under both clocks; the output must not depend on the server's timezone:
//   TZ=UTC npx tsx scripts/smoke-native-reminder-store.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-native-reminder-store.ts

import path from 'path';
import { fromZonedTime } from 'date-fns-tz';
import { __resetDueGateForTests, setNextDue, shouldRunPass } from '../src/services/native-reminders/due-gate';

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
}

function assert(cond: boolean, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

const IL = 'Asia/Jerusalem';
const NY = 'America/New_York';
/** A wall-clock time in `tz`, e.g. '2026-10-14 08:00'. */
const at = (local: string, tz = IL) => fromZonedTime(`${local}:00`, tz);
const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : String(d));

// ---- Prisma, in memory ----
// Just what the store, onboarding and the ownership helpers ask of it: the where
// operators they use, compound unique keys, select, orderBy, Prisma's column defaults,
// and a $transaction that rolls back when its callback throws.

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

const tables: Record<string, Row[]> = {};
const COMPOUND_KEYS: Record<string, string[]> = { seriesEventId_originalStartsAt: ['seriesEventId', 'originalStartsAt'] };
const DEFAULTS: Record<string, () => Row> = {
  nativeCalendar: () => ({ color: '#039BE5', labels: [], personName: null, personEnglishName: null, personGender: null, rules: [], privacy: 'PRIVATE', isDeleted: false }),
  nativeEvent: () => ({ description: null, location: null, allDay: false, rrule: null, exdates: [], reminderMinutes: null, isDeleted: false, kind: 'EVENT', forUserId: null, armedAt: null }),
  nativeEventInstance: () => ({ title: null, description: null, location: null, startsAt: null, endsAt: null, allDay: null }),
  nativeReminderState: () => ({ doneAt: null, doneByUserId: null, snoozedUntil: null, lastPingedAt: null, pingAttempts: 0, pingChatId: null, pingMessageId: null }),
};
let nextId = 0;

const same = (a: unknown, b: unknown) => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : (a ?? null) === (b ?? null));

function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as Where[]).some((w) => matches(row, w));
    if (key === 'AND') return (cond as Where[]).every((w) => matches(row, w));
    if (key in COMPOUND_KEYS) return matches(row, cond as Where);
    const value = row[key];
    if (cond === null || typeof cond !== 'object' || cond instanceof Date) return same(value, cond);
    return Object.entries(cond as Where).every(([op, arg]) => {
      switch (op) {
        case 'in': return (arg as unknown[]).some((a) => same(value, a));
        case 'not': return !same(value, arg);
        case 'lt': return value != null && (value as Date) < (arg as Date);
        case 'lte': return value != null && (value as Date) <= (arg as Date);
        case 'gt': return value != null && (value as Date) > (arg as Date);
        case 'gte': return value != null && (value as Date) >= (arg as Date);
        default: throw new Error(`stand-in Prisma does not know '${op}'`);
      }
    });
  });
}

/** Prisma returns only the selected columns, so a column the code forgets to select is missing. */
const pick = (row: Row | undefined, select?: Record<string, boolean>) =>
  !row ? null : select ? Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]])) : { ...row };

/** Prisma skips undefined fields and appends on { push }. */
function apply(row: Row, data: Row) {
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    const push = value !== null && typeof value === 'object' && Object.hasOwn(value, 'push');
    row[key] = push ? [...(row[key] as unknown[]), (value as { push: unknown }).push] : value;
  }
  row.updatedAt = new Date();
}

function table(name: string) {
  const find = (where?: Where) => tables[name].filter((r) => !where || matches(r, where));
  const insert = (data: Row) => {
    const row: Row = { id: `${name}-${++nextId}`, ...DEFAULTS[name]?.(), createdAt: new Date() };
    apply(row, data);
    tables[name].push(row);
    return { ...row };
  };
  type Args = { where?: Where; select?: Record<string, boolean>; orderBy?: Array<Record<string, 'asc' | 'desc'>>; data?: Row; create?: Row; update?: Row };
  return {
    findUnique: async ({ where, select }: Args) => pick(find(where)[0], select),
    findFirst: async ({ where, select }: Args) => pick(find(where)[0], select),
    findMany: async ({ where, select, orderBy = [] }: Args = {}) => {
      const rows = [...find(where)];
      for (const order of [...orderBy].reverse()) {
        const [[key, dir]] = Object.entries(order);
        rows.sort((a, b) => ((a[key] as Date) > (b[key] as Date) ? 1 : (a[key] as Date) < (b[key] as Date) ? -1 : 0) * (dir === 'desc' ? -1 : 1));
      }
      return rows.map((r) => pick(r, select));
    },
    create: async ({ data }: Args) => insert(data!),
    update: async ({ where, data }: Args) => {
      const row = find(where)[0];
      if (!row) throw new Error(`stand-in ${name}.update: no row matches ${JSON.stringify(where)}`);
      apply(row, data!);
      return { ...row };
    },
    upsert: async ({ where, create, update }: Args) => {
      const row = find(where)[0];
      if (!row) return insert(create!);
      apply(row, update!);
      return { ...row };
    },
    updateMany: async ({ where, data }: Args) => {
      const rows = find(where);
      rows.forEach((r) => apply(r, data!));
      return { count: rows.length };
    },
    deleteMany: async ({ where }: Args) => {
      const before = tables[name].length;
      tables[name] = tables[name].filter((r) => !where || !matches(r, where));
      return { count: before - tables[name].length };
    },
  };
}

const fakePrisma: Record<string, unknown> = {
  $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
    const snapshot = structuredClone(tables);
    try {
      return await fn(fakePrisma);
    } catch (err) {
      Object.assign(tables, snapshot);
      throw err;
    }
  },
};
for (const name of ['user', 'pairing', 'nativeCalendar', 'nativeEvent', 'nativeEventInstance', 'nativeReminderState']) {
  tables[name] = [];
  fakePrisma[name] = table(name);
}

// ---- The family ----
// Raziel (1) and Dana (2) are paired. Noa (4) and Avi (5) were, until they unlinked
// (unlinking clears both pairingIds). Lior (6) is paired with Maya (7), who moved to
// Google and keeps the ACTIVE pairing. The stranger (3) knows nobody.

const OLD_ARMED = new Date('2026-10-01T06:00:00Z');
let testStarted = 0;
/** Set by this write: not before the check began. */
const fresh = (d: unknown) => d instanceof Date && d.getTime() >= testStarted;

function user(id: number, name: string, pairingId: string | null, calendarSource = 'NATIVE'): Row {
  return { id, name, englishName: name, gender: 'female', language: 'en', calendarSource, telegramId: BigInt(1000 + id), pairingId };
}

function calendar(id: string, ownerUserId: number, privacy: string, labels: string[], createdAt = '2026-01-01T00:00:00Z'): Row {
  return { ...DEFAULTS.nativeCalendar(), id, ownerUserId, name: id, privacy, labels, createdAt: new Date(createdAt), updatedAt: new Date(createdAt) };
}

/** A NativeEvent row as an earlier write left it: an hour-long event, or a reminder armed on Oct 1. */
function seedEvent(id: string, fields: Row): Row {
  const row: Row = { ...DEFAULTS.nativeEvent(), id, timeZone: IL, createdAt: OLD_ARMED, updatedAt: OLD_ARMED, ...fields };
  if (row.kind === 'REMINDER') row.armedAt ??= OLD_ARMED;
  row.endsAt ??= row.kind === 'REMINDER' ? row.startsAt : new Date((row.startsAt as Date).getTime() + 60 * 60_000);
  tables.nativeEvent.push(row);
  return row;
}

/** A state row: an occurrence that was pinged, snoozed or done, with its ping message when one was sent. */
function seedState(seriesEventId: string, originalStartsAt: Date, pingMessageId: number | null, fields: Row = {}) {
  tables.nativeReminderState.push({
    ...DEFAULTS.nativeReminderState(), id: `state-${++nextId}`, seriesEventId, originalStartsAt,
    lastPingedAt: originalStartsAt, pingAttempts: 1,
    pingChatId: pingMessageId === null ? null : 5001n, pingMessageId,
    createdAt: originalStartsAt, updatedAt: originalStartsAt, ...fields,
  });
}

function reset() {
  tables.user = [
    user(1, 'Raziel', 'p1'), user(2, 'Dana', 'p1'), user(3, 'Stranger', null),
    user(4, 'Noa', null), user(5, 'Avi', null), user(6, 'Lior', 'p3'), user(7, 'Maya', 'p3', 'GOOGLE'),
  ];
  tables.pairing = [
    { id: 'p1', status: 'ACTIVE', inviterUserId: 1, inviteeUserId: 2 },
    { id: 'p2', status: 'UNLINKED', inviterUserId: 4, inviteeUserId: 5 },
    { id: 'p3', status: 'ACTIVE', inviterUserId: 6, inviteeUserId: 7 },
  ];
  tables.nativeCalendar = [
    calendar('raziel', 1, 'SHARED_EDITOR', ['primary', 'yours']),
    calendar('dana', 2, 'PRIVATE', ['primary', 'yours']),
    calendar('dana-view', 2, 'SHARED_VIEWER', ['kids']),
    calendar('avi', 5, 'PRIVATE', ['primary', 'yours']),
    calendar('lior', 6, 'PRIVATE', ['primary', 'yours']),
  ];
  tables.nativeEvent = [];
  tables.nativeEventInstance = [];
  tables.nativeReminderState = [];
  testStarted = Date.now();
}

const eventRow = (id: string) => tables.nativeEvent.find((r) => r.id === id)!;
const stateKeys = (seriesId: string) =>
  tables.nativeReminderState.filter((r) => r.seriesEventId === seriesId).map((r) => iso(r.originalStartsAt)).sort();
const pings = (cleared: Array<{ chatId: bigint; messageId: number }>) => cleared.map((p) => `${p.chatId}/${p.messageId}`).sort().join(', ');

/** Close the due gate as a pass would leave it, so a write that clears it shows. */
function closeGate() {
  __resetDueGateForTests();
  setNextDue(new Date(Date.now() + 30 * 60_000), new Date());
  assert(!shouldRunPass(new Date()), 'the due gate did not close');
}
const gateCleared = () => shouldRunPass(new Date());

async function refused(what: string, write: () => Promise<unknown>) {
  const outcome = await write().then(() => 'allowed', (err: Error) => err.name);
  assert(outcome === 'NativePermissionDeniedError', `${what}: ${outcome}`);
}

async function main() {
  // The store reads src/utils/prisma; the stand-in goes into require's cache before the
  // store loads, as smoke-week-lookahead.ts does for its stubs.
  const Module = (await import('module')).default as unknown as {
    new (id: string): { filename: string; loaded: boolean; exports: unknown };
    _cache: Record<string, unknown>;
  };
  const prismaFile = path.resolve(__dirname, '../src/utils/prisma.ts');
  const prismaModule = new Module(prismaFile);
  Object.assign(prismaModule, { filename: prismaFile, loaded: true, exports: { prisma: fakePrisma } });
  Module._cache[prismaFile] = prismaModule;

  const store = await import('../src/services/native-calendar/event-store');
  const { normalizeReminderTimes, createNativeEvent, updateNativeEvent, deleteNativeEvent, getMainNativeCalendar, encodeEventId } = store;

  // ---- normalizeReminderTimes ----

  await check('normalize: a timed reminder starts and ends at the same instant', async () => {
    const t = at('2026-10-20 17:30');
    const r = normalizeReminderTimes(t, false, IL);
    assert(iso(r.startsAt) === iso(t) && iso(r.endsAt) === iso(t), `got ${iso(r.startsAt)} - ${iso(r.endsAt)}`);
  });

  await check('normalize: a date-only reminder sits at 00:00 of its own local day, not the UTC one', async () => {
    const cases: Array<[string, string, string, string]> = [
      ['Jerusalem afternoon', IL, '2026-10-20 15:00', '2026-10-19T21:00:00.000Z'],
      ['Jerusalem 00:30 (still the 19th in UTC)', IL, '2026-10-20 00:30', '2026-10-19T21:00:00.000Z'],
      ['New York 22:30 (already the 21st in UTC)', NY, '2026-10-20 22:30', '2026-10-20T04:00:00.000Z'],
      ['already at local midnight', NY, '2026-10-20 00:00', '2026-10-20T04:00:00.000Z'],
    ];
    for (const [label, tz, local, want] of cases) {
      const r = normalizeReminderTimes(at(local, tz), true, tz);
      assert(iso(r.startsAt) === want && iso(r.endsAt) === want, `${label}: got ${iso(r.startsAt)} - ${iso(r.endsAt)}, want ${want}`);
    }
  });

  await check('normalize: DST days (Jerusalem 25h and 23h, New York 25h) start at their own 00:00', async () => {
    const cases: Array<[string, string, string, string]> = [
      ['Jerusalem 2026-10-25 (clocks back)', IL, '2026-10-25 23:30', '2026-10-24T21:00:00.000Z'],
      ['Jerusalem 2027-03-26 (clocks forward)', IL, '2027-03-26 20:00', '2027-03-25T22:00:00.000Z'],
      ['New York 2026-11-01 (clocks back)', NY, '2026-11-01 22:00', '2026-11-01T04:00:00.000Z'],
    ];
    for (const [label, tz, local, want] of cases) {
      const r = normalizeReminderTimes(at(local, tz), true, tz);
      assert(iso(r.startsAt) === want && iso(r.endsAt) === want, `${label}: got ${iso(r.startsAt)}, want ${want}`);
    }
  });

  // ---- createNativeEvent ----

  await check('create: a reminder is zero-length, armed, for its person, and clears the due gate', async () => {
    reset();
    closeGate();
    const created = await createNativeEvent({
      calendarCuid: 'raziel', creatorUserId: 1, title: 'Call the plumber',
      startsAt: at('2026-10-15 10:00'), endsAt: at('2026-10-15 11:00'), timeZone: IL,
      kind: 'REMINDER', forUserId: 2,
    });
    const row = eventRow(created.id);
    assert(row.kind === 'REMINDER', `kind ${row.kind}`);
    assert(iso(row.startsAt) === iso(at('2026-10-15 10:00')) && iso(row.endsAt) === iso(row.startsAt), `times ${iso(row.startsAt)} - ${iso(row.endsAt)}`);
    assert(row.forUserId === 2, `forUserId ${row.forUserId}`);
    assert(fresh(row.armedAt), `armedAt ${iso(row.armedAt)}`);
    assert(gateCleared(), 'the due gate is still closed');
  });

  await check('create: a date-only reminder saved as the bot saves all-day (00:00 to 23:59) is zero-length at 00:00', async () => {
    reset();
    const created = await createNativeEvent({
      calendarCuid: 'raziel', creatorUserId: 1, title: 'Buy milk', allDay: true,
      startsAt: at('2026-10-16 00:00'), endsAt: at('2026-10-16 23:59'), timeZone: IL, kind: 'REMINDER',
    });
    const row = eventRow(created.id);
    assert(iso(row.startsAt) === iso(at('2026-10-16 00:00')) && iso(row.endsAt) === iso(row.startsAt), `times ${iso(row.startsAt)} - ${iso(row.endsAt)}`);
    assert(row.allDay === true && row.forUserId === null, `allDay ${row.allDay}, forUserId ${row.forUserId}`);
  });

  await check('create: an event is stored as before, is for no one, and leaves the due gate alone', async () => {
    reset();
    closeGate();
    const created = await createNativeEvent({
      calendarCuid: 'raziel', creatorUserId: 1, title: 'Dentist',
      startsAt: at('2026-10-15 10:00'), endsAt: at('2026-10-15 11:00'), timeZone: IL, forUserId: 2,
    });
    const row = eventRow(created.id);
    assert(row.kind === 'EVENT' && row.forUserId === null && row.armedAt === null, `kind ${row.kind}, forUserId ${row.forUserId}, armedAt ${row.armedAt}`);
    assert(iso(row.endsAt) === iso(at('2026-10-15 11:00')), `end ${iso(row.endsAt)}`);
    assert(!gateCleared(), 'an event cleared the due gate');
  });

  // ---- updateNativeEvent: zero length and re-arm ----

  const daily = () => seedEvent('daily', { kind: 'REMINDER', calendarId: 'raziel', creatorUserId: 1, title: 'Water the plants', startsAt: at('2026-10-10 08:00'), rrule: 'FREQ=DAILY' });

  await check('single occurrence moved: zero-length, only its state row goes, its ping comes back, the series keeps its armedAt', async () => {
    reset();
    daily();
    const occ = at('2026-10-14 08:00');
    seedState('daily', at('2026-10-13 08:00'), 11, { doneAt: at('2026-10-13 08:05') });
    seedState('daily', occ, 12);
    closeGate();
    const result = await updateNativeEvent({
      seriesCuid: 'daily', instanceStartsAt: occ, scope: 'single', actingUserId: 1,
      startsAt: at('2026-10-14 12:00'), endsAt: at('2026-10-14 13:00'),
    });
    const override = tables.nativeEventInstance.find((r) => same(r.originalStartsAt, occ))!;
    assert(iso(override.startsAt) === iso(at('2026-10-14 12:00')) && iso(override.endsAt) === iso(override.startsAt), `override ${iso(override.startsAt)} - ${iso(override.endsAt)}`);
    assert(pings(result.clearedPings) === '5001/12', `cleared ${pings(result.clearedPings)}`);
    assert(stateKeys('daily').join() === iso(at('2026-10-13 08:00')), `states left ${stateKeys('daily').join()}`);
    assert(iso(eventRow('daily').armedAt) === iso(OLD_ARMED), `series armedAt ${iso(eventRow('daily').armedAt)}`);
    assert(result.canonicalEventId === encodeEventId('daily', occ), `id ${result.canonicalEventId}`);
    assert(gateCleared(), 'the due gate is still closed');
  });

  await check('one-off moved: zero-length, its state row goes with its ping, re-armed now', async () => {
    reset();
    seedEvent('once', { kind: 'REMINDER', calendarId: 'raziel', creatorUserId: 1, title: 'Call mom', startsAt: at('2026-10-14 10:00') });
    seedState('once', at('2026-10-14 10:00'), 21, { snoozedUntil: at('2026-10-14 10:15') });
    const result = await updateNativeEvent({
      seriesCuid: 'once', scope: 'single', actingUserId: 1, startsAt: at('2026-10-14 17:00'), endsAt: at('2026-10-14 18:00'),
    });
    const row = eventRow('once');
    assert(iso(row.startsAt) === iso(at('2026-10-14 17:00')) && iso(row.endsAt) === iso(row.startsAt), `times ${iso(row.startsAt)} - ${iso(row.endsAt)}`);
    assert(pings(result.clearedPings) === '5001/21' && stateKeys('once').length === 0, `cleared ${pings(result.clearedPings)}, left ${stateKeys('once').join()}`);
    assert(fresh(row.armedAt), `armedAt ${iso(row.armedAt)}`);
  });

  await check('a date-only reminder moved to another day as the edit path sends it (00:00 to 23:59) stays zero-length', async () => {
    reset();
    seedEvent('milk', { kind: 'REMINDER', calendarId: 'raziel', creatorUserId: 1, title: 'Buy milk', allDay: true, startsAt: at('2026-10-14 00:00') });
    await updateNativeEvent({ seriesCuid: 'milk', scope: 'single', actingUserId: 1, startsAt: at('2026-10-16 00:00'), endsAt: at('2026-10-16 23:59') });
    const row = eventRow('milk');
    assert(iso(row.startsAt) === iso(at('2026-10-16 00:00')) && iso(row.endsAt) === iso(row.startsAt), `times ${iso(row.startsAt)} - ${iso(row.endsAt)}`);
  });

  await check('every occurrence moved: every state row goes, only rows with a ping message come back, overrides drop', async () => {
    reset();
    daily();
    seedState('daily', at('2026-10-12 08:00'), 31);
    seedState('daily', at('2026-10-13 08:00'), null); // passed over without a send
    seedState('daily', at('2026-10-14 08:00'), 33);
    tables.nativeEventInstance.push({ ...DEFAULTS.nativeEventInstance(), id: 'ov', seriesEventId: 'daily', originalStartsAt: at('2026-10-13 08:00'), status: 'OVERRIDE', title: 'Just today' });
    const result = await updateNativeEvent({
      seriesCuid: 'daily', scope: 'all', actingUserId: 1, startsAt: at('2026-10-10 09:00'), endsAt: at('2026-10-10 10:00'),
    });
    const row = eventRow('daily');
    assert(iso(row.startsAt) === iso(at('2026-10-10 09:00')) && iso(row.endsAt) === iso(row.startsAt), `times ${iso(row.startsAt)} - ${iso(row.endsAt)}`);
    assert(pings(result.clearedPings) === '5001/31, 5001/33', `cleared ${pings(result.clearedPings)}`);
    assert(stateKeys('daily').length === 0 && tables.nativeEventInstance.length === 0, `left ${stateKeys('daily').length} states, ${tables.nativeEventInstance.length} overrides`);
    assert(fresh(row.armedAt), `armedAt ${iso(row.armedAt)}`);
  });

  await check('following, by the partner: rows from the cut go, earlier ones stay; the new series keeps kind, person and creator', async () => {
    reset();
    seedEvent('daily', { kind: 'REMINDER', calendarId: 'raziel', creatorUserId: 1, forUserId: 2, title: 'Feed the cat', startsAt: at('2026-10-10 08:00'), rrule: 'FREQ=DAILY' });
    const cut = at('2026-10-14 08:00');
    seedState('daily', at('2026-10-12 08:00'), 41);
    seedState('daily', cut, 42);
    seedState('daily', at('2026-10-15 08:00'), 43);
    tables.nativeEventInstance.push({ ...DEFAULTS.nativeEventInstance(), id: 'ov', seriesEventId: 'daily', originalStartsAt: at('2026-10-16 08:00'), status: 'CANCELLED' });
    // Dana edits Raziel's reminder for her, on his SHARED_EDITOR calendar.
    const result = await updateNativeEvent({
      seriesCuid: 'daily', instanceStartsAt: cut, scope: 'following', actingUserId: 2,
      startsAt: at('2026-10-14 07:30'), endsAt: at('2026-10-14 08:30'),
    });
    assert(pings(result.clearedPings) === '5001/42, 5001/43', `cleared ${pings(result.clearedPings)}`);
    assert(stateKeys('daily').join() === iso(at('2026-10-12 08:00')), `parent states left ${stateKeys('daily').join()}`);
    assert(String(eventRow('daily').rrule).includes('UNTIL=20261014T075959'), `parent rrule ${eventRow('daily').rrule}`);
    assert(tables.nativeEventInstance.length === 0, 'the override after the cut is still there');
    const split = eventRow(result.canonicalEventId);
    assert(split && split.id !== 'daily', `canonical id ${result.canonicalEventId}`);
    assert(split.kind === 'REMINDER' && split.forUserId === 2 && split.creatorUserId === 1, `kind ${split.kind}, forUserId ${split.forUserId}, creator ${split.creatorUserId}`);
    assert(iso(split.startsAt) === iso(at('2026-10-14 07:30')) && iso(split.endsAt) === iso(split.startsAt), `times ${iso(split.startsAt)} - ${iso(split.endsAt)}`);
    assert(split.rrule === 'FREQ=DAILY' && fresh(split.armedAt), `rrule ${split.rrule}, armedAt ${iso(split.armedAt)}`);
  });

  await check('a title-only change deletes nothing and keeps armedAt; a "from now on" rename takes the state along', async () => {
    reset();
    daily();
    seedState('daily', at('2026-10-13 08:00'), 51, { doneAt: at('2026-10-13 08:01') });
    seedState('daily', at('2026-10-15 08:00'), 52, { doneAt: at('2026-10-15 08:01') });
    const all = await updateNativeEvent({ seriesCuid: 'daily', scope: 'all', actingUserId: 1, title: 'Water the garden' });
    const single = await updateNativeEvent({ seriesCuid: 'daily', instanceStartsAt: at('2026-10-13 08:00'), scope: 'single', actingUserId: 1, title: 'Just today' });
    assert(all.clearedPings.length === 0 && single.clearedPings.length === 0, 'a rename cleared pings');
    assert(stateKeys('daily').length === 2, `states left ${stateKeys('daily').length}`);
    assert(iso(eventRow('daily').armedAt) === iso(OLD_ARMED), `armedAt ${iso(eventRow('daily').armedAt)}`);
    const override = tables.nativeEventInstance[0];
    assert(override.title === 'Just today' && override.startsAt === null && override.endsAt === null, `override ${JSON.stringify(override)}`);
    // The same time sent again, with the edit path's extra hour, moves nothing.
    const again = await updateNativeEvent({ seriesCuid: 'daily', scope: 'all', actingUserId: 1, startsAt: at('2026-10-10 08:00'), endsAt: at('2026-10-10 09:00') });
    assert(again.clearedPings.length === 0 && stateKeys('daily').length === 2, 'the same time re-armed it');
    assert(iso(eventRow('daily').endsAt) === iso(at('2026-10-10 08:00')), `end ${iso(eventRow('daily').endsAt)}`);
    const following = await updateNativeEvent({ seriesCuid: 'daily', instanceStartsAt: at('2026-10-14 08:00'), scope: 'following', actingUserId: 1, title: 'Water the trees' });
    assert(following.clearedPings.length === 0, `cleared ${pings(following.clearedPings)}`);
    const splitId = following.canonicalEventId;
    assert(stateKeys('daily').join() === iso(at('2026-10-13 08:00')), `parent states ${stateKeys('daily').join()}`);
    assert(stateKeys(splitId).join() === iso(at('2026-10-15 08:00')), `new series states ${stateKeys(splitId).join()}`);
    assert(iso(eventRow(splitId).armedAt) === iso(OLD_ARMED), `new series armedAt ${iso(eventRow(splitId).armedAt)}`);
  });

  await check('following on an event is unchanged: the editor becomes the creator, the length is kept, nothing is for anyone', async () => {
    reset();
    seedEvent('standup', { calendarId: 'raziel', creatorUserId: 1, title: 'Standup', startsAt: at('2026-10-10 09:00'), rrule: 'FREQ=DAILY' });
    closeGate();
    const result = await updateNativeEvent({
      seriesCuid: 'standup', instanceStartsAt: at('2026-10-14 09:00'), scope: 'following', actingUserId: 2,
      startsAt: at('2026-10-14 10:00'),
    });
    const split = eventRow(result.canonicalEventId);
    assert(split.creatorUserId === 2 && split.kind === 'EVENT' && split.forUserId === null && split.armedAt === null, `creator ${split.creatorUserId}, kind ${split.kind}, forUserId ${split.forUserId}, armedAt ${split.armedAt}`);
    assert(iso(split.endsAt) === iso(at('2026-10-14 11:00')), `end ${iso(split.endsAt)}`);
    assert(result.clearedPings.length === 0 && !gateCleared(), 'an event edit touched reminder state');
  });

  // ---- Permissions ----

  await check('the creator may change and delete a reminder on a calendar they can only view; not an event', async () => {
    reset();
    // Dana's kids calendar was SHARED_EDITOR when Raziel put these on it; it is view-only now.
    seedEvent('pickup', { kind: 'REMINDER', calendarId: 'dana-view', creatorUserId: 1, title: 'Bring the permission slip', startsAt: at('2026-10-15 07:30') });
    seedEvent('school', { calendarId: 'dana-view', creatorUserId: 1, title: 'School play', startsAt: at('2026-10-15 17:00') });
    await updateNativeEvent({ seriesCuid: 'pickup', scope: 'single', actingUserId: 1, title: 'Sign the permission slip' });
    assert(eventRow('pickup').title === 'Sign the permission slip', 'the creator could not rename it');
    closeGate();
    await deleteNativeEvent({ seriesCuid: 'pickup', scope: 'all', actingUserId: 1 });
    assert(eventRow('pickup').isDeleted === true && gateCleared(), `deleted ${eventRow('pickup').isDeleted}, gate cleared ${gateCleared()}`);
    await refused('the creator updating an event', () => updateNativeEvent({ seriesCuid: 'school', scope: 'single', actingUserId: 1, title: 'x' }));
    await refused('the creator deleting an event', () => deleteNativeEvent({ seriesCuid: 'school', scope: 'all', actingUserId: 1 }));
  });

  await check('the person a reminder is for may delete it ("stop reminding me") but not change it', async () => {
    reset();
    seedEvent('for-raziel', { kind: 'REMINDER', calendarId: 'dana', creatorUserId: 2, forUserId: 1, title: 'Renew the passport', startsAt: at('2026-10-15 09:00') });
    await refused('the person it is for updating it', () => updateNativeEvent({ seriesCuid: 'for-raziel', scope: 'single', actingUserId: 1, startsAt: at('2026-10-15 12:00') }));
    await deleteNativeEvent({ seriesCuid: 'for-raziel', scope: 'all', actingUserId: 1 });
    assert(eventRow('for-raziel').isDeleted === true, 'not deleted');
  });

  await check('a stranger, an ex-partner and a partner now on Google are refused', async () => {
    reset();
    seedEvent('mine', { kind: 'REMINDER', calendarId: 'dana', creatorUserId: 2, forUserId: 1, title: 'Call the bank', startsAt: at('2026-10-15 09:00') });
    seedEvent('for-noa', { kind: 'REMINDER', calendarId: 'avi', creatorUserId: 5, forUserId: 4, title: 'Pick up the bike', startsAt: at('2026-10-15 09:00') });
    seedEvent('for-maya', { kind: 'REMINDER', calendarId: 'lior', creatorUserId: 6, forUserId: 7, title: 'Book the vet', startsAt: at('2026-10-15 09:00') });
    await refused('a stranger updating', () => updateNativeEvent({ seriesCuid: 'mine', scope: 'single', actingUserId: 3, title: 'x' }));
    await refused('a stranger deleting', () => deleteNativeEvent({ seriesCuid: 'mine', scope: 'all', actingUserId: 3 }));
    await refused('an ex-partner deleting', () => deleteNativeEvent({ seriesCuid: 'for-noa', scope: 'all', actingUserId: 4 }));
    await refused('a partner on Google deleting', () => deleteNativeEvent({ seriesCuid: 'for-maya', scope: 'all', actingUserId: 7 }));
    assert(tables.nativeEvent.every((r) => r.isDeleted === false && r.title !== 'x'), 'a refused write still landed');
  });

  await check('deleting one occurrence of a reminder clears the gate; deleting an event does not', async () => {
    reset();
    daily();
    seedEvent('dentist', { calendarId: 'raziel', creatorUserId: 1, title: 'Dentist', startsAt: at('2026-10-15 10:00') });
    closeGate();
    await deleteNativeEvent({ seriesCuid: 'dentist', scope: 'single', actingUserId: 1 });
    assert(!gateCleared(), 'an event delete cleared the gate');
    await deleteNativeEvent({ seriesCuid: 'daily', instanceStartsAt: at('2026-10-14 08:00'), scope: 'single', actingUserId: 1 });
    assert(iso((eventRow('daily').exdates as Date[])[0]) === iso(at('2026-10-14 08:00')) && gateCleared(), 'the occurrence was not skipped or the gate not cleared');
  });

  // ---- getMainNativeCalendar ----

  await check("main calendar: the user's own primary, not the partner's older one", async () => {
    reset();
    tables.nativeCalendar = [
      calendar('dana', 2, 'SHARED_EDITOR', ['primary', 'yours'], '2025-06-01T00:00:00Z'),
      calendar('raziel-kids', 1, 'PRIVATE', ['kids'], '2026-02-01T00:00:00Z'),
      calendar('raziel', 1, 'SHARED_EDITOR', ['primary', 'yours'], '2026-03-01T00:00:00Z'),
    ];
    const main = await getMainNativeCalendar(1);
    assert(main.id === 'raziel', `got ${main.id}`);
  });

  await check('main calendar: no primary → the oldest own calendar, skipping a deleted one', async () => {
    reset();
    tables.nativeCalendar = [
      { ...calendar('old', 1, 'PRIVATE', ['primary', 'yours'], '2025-01-01T00:00:00Z'), isDeleted: true },
      calendar('raziel-work', 1, 'PRIVATE', [], '2026-04-01T00:00:00Z'),
      calendar('raziel-kids', 1, 'PRIVATE', ['kids'], '2026-02-01T00:00:00Z'),
    ];
    const main = await getMainNativeCalendar(1);
    assert(main.id === 'raziel-kids', `got ${main.id}`);
  });

  await check('main calendar: none at all → the primary calendar onboarding creates', async () => {
    reset();
    tables.nativeCalendar = [];
    const main = await getMainNativeCalendar(1);
    assert(main.ownerUserId === 1 && (main.labels as string[]).join() === 'primary,yours', `got ${JSON.stringify(main)}`);
    assert(tables.nativeCalendar.length === 1, `${tables.nativeCalendar.length} calendars`);
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
TZ=UTC npx tsx scripts/smoke-native-reminder-store.ts; echo "exit=$?"
```

Expected: the last lines are `2/20 passed (process TZ=UTC)` and `exit=1`. Only two checks pass, because today's code already does what they check:
- `create: an event is stored as before, is for no one, and leaves the due gate alone`
- `a stranger, an ex-partner and a partner now on Google are refused`

The others fail with one of these messages:
- `normalizeReminderTimes is not a function` (the three normalize checks);
- `getMainNativeCalendar is not a function` (the three main-calendar checks);
- `kind EVENT` (reminder create);
- `times 2026-10-15T21:00:00.000Z - 2026-10-16T20:59:00.000Z` and similar non-zero lengths;
- `Cannot read properties of undefined (reading 'map')` / `(reading 'length')` (there is no `clearedPings` yet);
- `Permission denied for native calendar operation` (the creator and effective-owner rights).

- [ ] **Step 3: Import the helpers the store now uses**

In `src/services/native-calendar/event-store.ts`, lines 16-17:

Find:

```ts
import { prisma } from '../../utils/prisma';
import { expandSeries, truncateRruleBefore, VirtualInstance } from './recurrence';
```

Replace with:

```ts
import { prisma } from '../../utils/prisma';
import { TIMEZONE } from '../../config/constants';
import { localDate, startOfLocalDay } from '../../utils/day-events';
import { invalidateDueGate } from '../native-reminders/due-gate';
import { effectiveOwnerId, getActivePartnerSummary } from '../native-reminders/ownership';
import { ensurePrimaryNativeCalendar } from './onboarding';
import { expandSeries, truncateRruleBefore, VirtualInstance } from './recurrence';
```

`onboarding.ts` imports only `../../utils/prisma`, so the static import makes no cycle. Don't load it with `import()`: under tsx, `import()` goes through the ES module loader, which skips the `require` hooks the smoke scripts use for their fakes (see the comment in `scripts/smoke-voice-dates.ts`).

- [ ] **Step 4: Make smoke-reminders' partial fake of the store a Proxy**

`scripts/smoke-reminders.ts` fakes part of the store by spreading the real module (`{ ...real }`), which copies the exports eagerly. Make it a Proxy that reads the real module lazily, so it survives import cycles. `scripts/smoke-voice-dates.ts` already does this for `ai-provider`.

Check first: `TZ=UTC npx tsx scripts/smoke-reminders.ts` prints `20/20 passed` now, and must print `20/20 passed` after this change too.

In `scripts/smoke-reminders.ts`, line 155:

Find:

```ts
/** Modules replaced by fakes, by package name or file path; a function fakes part of the real module. */
```

Replace with:

```ts
/**
 * Part of a module faked, the rest read through to the real one. A proxy, not a copy:
 * it reads the real module lazily, so it survives import cycles.
 */
const fakeOver = (real: Record<string, unknown>, fakes: Record<string, unknown>) =>
  new Proxy(real, { get: (target, key) => (typeof key === 'string' && key in fakes ? fakes[key] : Reflect.get(target, key)) });

/** Modules replaced by fakes, by package name or file path; a function fakes part of the real module. */
```

and lines 186-187:

Find:

```ts
  [`${SRC}/services/native-calendar/event-store.ts`]: real => ({
    ...real,
```

Replace with:

```ts
  [`${SRC}/services/native-calendar/event-store.ts`]: real => fakeOver(real, {
```

The rest of that stub, from `listVisibleCalendars:` through the closing `}),`, stays exactly as it is.

- [ ] **Step 5: Add `getMainNativeCalendar`**

In `src/services/native-calendar/event-store.ts`, find the end of `listVisibleCalendars` (lines 118-119):

Find:

```ts
  return prisma.nativeCalendar.findMany({ where, orderBy: [{ createdAt: 'asc' }] });
}
```

Replace with:

```ts
  return prisma.nativeCalendar.findMany({ where, orderBy: [{ createdAt: 'asc' }] });
}

/**
 * The calendar a user's reminders go on: their own calendar labelled primary, else
 * their oldest own calendar, else the one onboarding creates. Never the partner's:
 * a partner's calendar keeps its owner's 'primary' label and listVisibleCalendars
 * orders both partners' calendars together, so neither can tell them apart.
 */
export async function getMainNativeCalendar(userId: number): Promise<NativeCalendar> {
  const findOwn = async () => {
    const own = await prisma.nativeCalendar.findMany({
      where: { ownerUserId: userId, isDeleted: false },
      orderBy: [{ createdAt: 'asc' }],
    });
    return own.find((c) => c.labels.includes('primary')) ?? own[0];
  };
  const existing = await findOwn();
  if (existing) return existing;
  await ensurePrimaryNativeCalendar(userId);
  const created = await findOwn();
  if (!created) throw new NativeNotFoundError('User has no native calendar');
  return created;
}
```

- [ ] **Step 6: `CreateNativeEventInput` gains `kind` and `forUserId`; add `normalizeReminderTimes`**

Lines 210-214:

Find:

```ts
  rrule?: string | null;
  reminderMinutes?: number | null;
}

export class NativePermissionDeniedError extends Error {
```

Replace with:

```ts
  rrule?: string | null;
  reminderMinutes?: number | null;
  // A reminder is an event with no length (spec §1). forUserId is the partner it
  // is for; null means the creator. Ignored for an EVENT.
  kind?: 'EVENT' | 'REMINDER';
  forUserId?: number | null;
}

/**
 * A reminder starts and ends at the same instant. A date-only one sits at the start
 * of its local day in the event's timezone, so it stays on that day whatever the
 * caller sent as its end (the bot saves an all-day event until 23:59).
 */
export function normalizeReminderTimes(
  startsAt: Date,
  allDay: boolean,
  timeZone: string
): { startsAt: Date; endsAt: Date } {
  if (!allDay) return { startsAt, endsAt: new Date(startsAt.getTime()) };
  const tz = timeZone || TIMEZONE;
  const dayStart = startOfLocalDay(localDate(startsAt, tz), tz);
  return { startsAt: dayStart, endsAt: new Date(dayStart.getTime()) };
}

export class NativePermissionDeniedError extends Error {
```

`localDate` and `startOfLocalDay` come from `src/utils/day-events.ts`. `startOfLocalDay` already handles the zones where 00:00 doesn't exist on a DST day.

- [ ] **Step 7: `createNativeEvent` stores a reminder zero-length and armed**

Lines 241-259:

Find:

```ts
  const access = await getCalendarAccess(creator, calendar);
  if (!canWriteAccess(access)) throw new NativePermissionDeniedError();

  return prisma.nativeEvent.create({
    data: {
      calendarId: input.calendarCuid,
      creatorUserId: input.creatorUserId,
      title: input.title,
      description: input.description,
      location: input.location,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      allDay: input.allDay ?? false,
      timeZone: input.timeZone,
      rrule: input.rrule ?? null,
      reminderMinutes: input.reminderMinutes ?? null,
    },
  });
}
```

Replace with:

```ts
  const access = await getCalendarAccess(creator, calendar);
  if (!canWriteAccess(access)) throw new NativePermissionDeniedError();

  const isReminder = input.kind === 'REMINDER';
  const times = isReminder
    ? normalizeReminderTimes(input.startsAt, input.allDay ?? false, input.timeZone)
    : { startsAt: input.startsAt, endsAt: input.endsAt };
  const event = await prisma.nativeEvent.create({
    data: {
      calendarId: input.calendarCuid,
      creatorUserId: input.creatorUserId,
      title: input.title,
      description: input.description,
      location: input.location,
      startsAt: times.startsAt,
      endsAt: times.endsAt,
      allDay: input.allDay ?? false,
      timeZone: input.timeZone,
      rrule: input.rrule ?? null,
      reminderMinutes: input.reminderMinutes ?? null,
      // armedAt bounds how far back the ping pass looks, so a reminder created for a
      // time long gone doesn't ping (spec §4.2).
      ...(isReminder
        ? { kind: 'REMINDER' as const, forUserId: input.forUserId ?? null, armedAt: new Date() }
        : {}),
    },
  });
  if (isReminder) invalidateDueGate();
  return event;
}
```

For an EVENT, the spread adds nothing, so the create call writes exactly the fields it writes today. Prisma's defaults give `kind = EVENT`, `forUserId = null` and `armedAt = null`.

- [ ] **Step 8: `updateNativeEvent`: creator permission, `clearedPings`, and the reminder path**

Replace all of `updateNativeEvent`, lines 281-409. That is from its doc comment `/**` / ` * Update an event with scope semantics that mirror the GCal flow.` down to its closing `}` just above `// --- Events: delete ---`. The event path below the `if (isReminder)` block is today's code, unchanged except that each of its six `return` statements gains `clearedPings: []`. The three helpers that follow it are new.

Find:

```ts
/**
 * Update an event with scope semantics that mirror the GCal flow.
 * Returns the canonical id the caller should reference afterwards (the series
 * cuid for scope=all/following, or the instance composite id for scope=single).
 */
export async function updateNativeEvent(input: UpdateNativeEventInput): Promise<{ canonicalEventId: string }> {
  const series = await prisma.nativeEvent.findUnique({ where: { id: input.seriesCuid } });
  if (!series || series.isDeleted) throw new NativeNotFoundError();

  const calendar = await prisma.nativeCalendar.findUnique({ where: { id: series.calendarId } });
  if (!calendar || calendar.isDeleted) throw new NativeNotFoundError('Calendar not found');

  const actor = await prisma.user.findUnique({
    where: { id: input.actingUserId },
    select: { id: true, pairingId: true },
  });
  if (!actor) throw new NativeNotFoundError('Actor user not found');

  const access = await getCalendarAccess(actor, calendar);
  if (!canWriteAccess(access)) throw new NativePermissionDeniedError();

  // Field update bag for series-level changes
  const seriesUpdate: Prisma.NativeEventUpdateInput = {};
  if (input.title !== undefined) seriesUpdate.title = input.title;
  if (input.description !== undefined) seriesUpdate.description = input.description;
  if (input.location !== undefined) seriesUpdate.location = input.location;
  if (input.startsAt !== undefined) seriesUpdate.startsAt = input.startsAt;
  if (input.endsAt !== undefined) seriesUpdate.endsAt = input.endsAt;
  if (input.allDay !== undefined) seriesUpdate.allDay = input.allDay;

  // Single occurrence (recurring): write/upsert NativeEventInstance OVERRIDE
  if (input.scope === 'single' && series.rrule && input.instanceStartsAt) {
    const occ = input.instanceStartsAt;
    await prisma.nativeEventInstance.upsert({
      where: {
        seriesEventId_originalStartsAt: { seriesEventId: series.id, originalStartsAt: occ },
      },
      create: {
        seriesEventId: series.id,
        originalStartsAt: occ,
        status: 'OVERRIDE',
        title: input.title,
        description: input.description ?? null,
        location: input.location ?? null,
        startsAt: input.startsAt ?? null,
        endsAt: input.endsAt ?? null,
        allDay: input.allDay ?? null,
      },
      update: {
        status: 'OVERRIDE',
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.location !== undefined ? { location: input.location } : {}),
        ...(input.startsAt !== undefined ? { startsAt: input.startsAt } : {}),
        ...(input.endsAt !== undefined ? { endsAt: input.endsAt } : {}),
        ...(input.allDay !== undefined ? { allDay: input.allDay } : {}),
      },
    });
    return { canonicalEventId: encodeEventId(series.id, occ) };
  }

  // Single occurrence on a non-recurring event: act on the series itself.
  if (input.scope === 'single' && !series.rrule) {
    await prisma.nativeEvent.update({ where: { id: series.id }, data: seriesUpdate });
    return { canonicalEventId: encodeEventId(series.id) };
  }

  // 'all': update the series. If startsAt changes we wipe orphan overrides
  // (matches GCal behavior; documented in the plan).
  if (input.scope === 'all') {
    await prisma.$transaction(async (tx) => {
      await tx.nativeEvent.update({ where: { id: series.id }, data: seriesUpdate });
      if (input.startsAt !== undefined) {
        await tx.nativeEventInstance.deleteMany({ where: { seriesEventId: series.id } });
      }
    });
    return { canonicalEventId: encodeEventId(series.id) };
  }

  // 'following': truncate the original series and create a new one starting
  // from the targeted instance.
  if (input.scope === 'following') {
    if (!series.rrule || !input.instanceStartsAt) {
      // Fallback: nothing to truncate; treat as 'all'
      await prisma.nativeEvent.update({ where: { id: series.id }, data: seriesUpdate });
      return { canonicalEventId: encodeEventId(series.id) };
    }
    const newSeriesId = await prisma.$transaction(async (tx) => {
      // 1. Truncate parent rrule
      await tx.nativeEvent.update({
        where: { id: series.id },
        data: { rrule: truncateRruleBefore(series.rrule!, input.instanceStartsAt!, series.timeZone) },
      });
      // 2. Insert new series starting from the instance, with overrides applied
      const newStarts = input.startsAt ?? input.instanceStartsAt!;
      const newEnds = input.endsAt ?? new Date(newStarts.getTime() + (series.endsAt.getTime() - series.startsAt.getTime()));
      const newSeries = await tx.nativeEvent.create({
        data: {
          calendarId: series.calendarId,
          creatorUserId: input.actingUserId,
          title: input.title ?? series.title,
          description: input.description ?? series.description,
          location: input.location ?? series.location,
          startsAt: newStarts,
          endsAt: newEnds,
          allDay: input.allDay ?? series.allDay,
          timeZone: series.timeZone,
          rrule: series.rrule,
          reminderMinutes: series.reminderMinutes,
        },
      });
      // 3. Migrate overrides at-or-after the cut point to the new series and
      //    rebase their originalStartsAt onto the new series' rrule cycle.
      //    Simplest correct behavior: drop those overrides — the new series
      //    already carries the new defaults from the cut point. (Edits to
      //    individual instances post-cut can be reapplied later.)
      await tx.nativeEventInstance.deleteMany({
        where: {
          seriesEventId: series.id,
          originalStartsAt: { gte: input.instanceStartsAt! },
        },
      });
      return newSeries.id;
    });
    return { canonicalEventId: encodeEventId(newSeriesId) };
  }

  return { canonicalEventId: encodeEventId(series.id) };
}
```

Replace with:

```ts
/** A ping message whose buttons a reminder's time change made stale. */
export interface ClearedPing {
  chatId: bigint;
  messageId: number;
}

/**
 * Update an event with scope semantics that mirror the GCal flow.
 * Returns the canonical id the caller should reference afterwards (the series
 * cuid for scope=all/following, or the instance composite id for scope=single),
 * and, for a reminder whose time changed, the live pings to strip the buttons from.
 */
export async function updateNativeEvent(
  input: UpdateNativeEventInput
): Promise<{ canonicalEventId: string; clearedPings: ClearedPing[] }> {
  const series = await prisma.nativeEvent.findUnique({ where: { id: input.seriesCuid } });
  if (!series || series.isDeleted) throw new NativeNotFoundError();

  const calendar = await prisma.nativeCalendar.findUnique({ where: { id: series.calendarId } });
  if (!calendar || calendar.isDeleted) throw new NativeNotFoundError('Calendar not found');

  const actor = await prisma.user.findUnique({
    where: { id: input.actingUserId },
    select: { id: true, pairingId: true },
  });
  if (!actor) throw new NativeNotFoundError('Actor user not found');

  const access = await getCalendarAccess(actor, calendar);
  // A reminder's creator may always change it, even on a calendar they can only view.
  const isReminder = series.kind === 'REMINDER';
  if (!canWriteAccess(access) && !(isReminder && series.creatorUserId === actor.id)) {
    throw new NativePermissionDeniedError();
  }
  if (isReminder) {
    const result = await updateNativeReminder(series, input);
    invalidateDueGate();
    return result;
  }

  // Field update bag for series-level changes
  const seriesUpdate: Prisma.NativeEventUpdateInput = {};
  if (input.title !== undefined) seriesUpdate.title = input.title;
  if (input.description !== undefined) seriesUpdate.description = input.description;
  if (input.location !== undefined) seriesUpdate.location = input.location;
  if (input.startsAt !== undefined) seriesUpdate.startsAt = input.startsAt;
  if (input.endsAt !== undefined) seriesUpdate.endsAt = input.endsAt;
  if (input.allDay !== undefined) seriesUpdate.allDay = input.allDay;

  // Single occurrence (recurring): write/upsert NativeEventInstance OVERRIDE
  if (input.scope === 'single' && series.rrule && input.instanceStartsAt) {
    const occ = input.instanceStartsAt;
    await prisma.nativeEventInstance.upsert({
      where: {
        seriesEventId_originalStartsAt: { seriesEventId: series.id, originalStartsAt: occ },
      },
      create: {
        seriesEventId: series.id,
        originalStartsAt: occ,
        status: 'OVERRIDE',
        title: input.title,
        description: input.description ?? null,
        location: input.location ?? null,
        startsAt: input.startsAt ?? null,
        endsAt: input.endsAt ?? null,
        allDay: input.allDay ?? null,
      },
      update: {
        status: 'OVERRIDE',
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.location !== undefined ? { location: input.location } : {}),
        ...(input.startsAt !== undefined ? { startsAt: input.startsAt } : {}),
        ...(input.endsAt !== undefined ? { endsAt: input.endsAt } : {}),
        ...(input.allDay !== undefined ? { allDay: input.allDay } : {}),
      },
    });
    return { canonicalEventId: encodeEventId(series.id, occ), clearedPings: [] };
  }

  // Single occurrence on a non-recurring event: act on the series itself.
  if (input.scope === 'single' && !series.rrule) {
    await prisma.nativeEvent.update({ where: { id: series.id }, data: seriesUpdate });
    return { canonicalEventId: encodeEventId(series.id), clearedPings: [] };
  }

  // 'all': update the series. If startsAt changes we wipe orphan overrides
  // (matches GCal behavior; documented in the plan).
  if (input.scope === 'all') {
    await prisma.$transaction(async (tx) => {
      await tx.nativeEvent.update({ where: { id: series.id }, data: seriesUpdate });
      if (input.startsAt !== undefined) {
        await tx.nativeEventInstance.deleteMany({ where: { seriesEventId: series.id } });
      }
    });
    return { canonicalEventId: encodeEventId(series.id), clearedPings: [] };
  }

  // 'following': truncate the original series and create a new one starting
  // from the targeted instance.
  if (input.scope === 'following') {
    if (!series.rrule || !input.instanceStartsAt) {
      // Fallback: nothing to truncate; treat as 'all'
      await prisma.nativeEvent.update({ where: { id: series.id }, data: seriesUpdate });
      return { canonicalEventId: encodeEventId(series.id), clearedPings: [] };
    }
    const newSeriesId = await prisma.$transaction(async (tx) => {
      // 1. Truncate parent rrule
      await tx.nativeEvent.update({
        where: { id: series.id },
        data: { rrule: truncateRruleBefore(series.rrule!, input.instanceStartsAt!, series.timeZone) },
      });
      // 2. Insert new series starting from the instance, with overrides applied
      const newStarts = input.startsAt ?? input.instanceStartsAt!;
      const newEnds = input.endsAt ?? new Date(newStarts.getTime() + (series.endsAt.getTime() - series.startsAt.getTime()));
      const newSeries = await tx.nativeEvent.create({
        data: {
          calendarId: series.calendarId,
          creatorUserId: input.actingUserId,
          title: input.title ?? series.title,
          description: input.description ?? series.description,
          location: input.location ?? series.location,
          startsAt: newStarts,
          endsAt: newEnds,
          allDay: input.allDay ?? series.allDay,
          timeZone: series.timeZone,
          rrule: series.rrule,
          reminderMinutes: series.reminderMinutes,
        },
      });
      // 3. Migrate overrides at-or-after the cut point to the new series and
      //    rebase their originalStartsAt onto the new series' rrule cycle.
      //    Simplest correct behavior: drop those overrides — the new series
      //    already carries the new defaults from the cut point. (Edits to
      //    individual instances post-cut can be reapplied later.)
      await tx.nativeEventInstance.deleteMany({
        where: {
          seriesEventId: series.id,
          originalStartsAt: { gte: input.instanceStartsAt! },
        },
      });
      return newSeries.id;
    });
    return { canonicalEventId: encodeEventId(newSeriesId), clearedPings: [] };
  }

  return { canonicalEventId: encodeEventId(series.id), clearedPings: [] };
}

/**
 * Where a reminder occurrence lands after an edit, zero-length, or null when the edit
 * leaves its time alone. Any end the caller computed is ignored (the edit path adds an
 * hour to a timed event and stretches an all-day one to 23:59). `changed` is whether
 * the start or allDay actually moved, which is what re-arms the reminder.
 */
function reminderTimeEdit(
  current: { startsAt: Date; allDay: boolean },
  input: Pick<UpdateNativeEventInput, 'startsAt' | 'allDay'>,
  timeZone: string
): { startsAt: Date; endsAt: Date; allDay: boolean; changed: boolean } | null {
  if (input.startsAt === undefined && input.allDay === undefined) return null;
  const allDay = input.allDay ?? current.allDay;
  const times = normalizeReminderTimes(input.startsAt ?? current.startsAt, allDay, timeZone);
  const changed = times.startsAt.getTime() !== current.startsAt.getTime() || allDay !== current.allDay;
  return { ...times, allDay, changed };
}

/**
 * Delete the state rows (done, snoozed, last ping) of the occurrences a time change
 * moved, so each pings again at its new time. Returns their live ping messages, whose
 * buttons now point at nothing.
 */
async function clearReminderStates(
  tx: Prisma.TransactionClient,
  where: Prisma.NativeReminderStateWhereInput
): Promise<ClearedPing[]> {
  const rows = await tx.nativeReminderState.findMany({
    where,
    select: { pingChatId: true, pingMessageId: true },
  });
  if (rows.length === 0) return [];
  await tx.nativeReminderState.deleteMany({ where });
  return rows.flatMap((r) =>
    r.pingChatId !== null && r.pingMessageId !== null ? [{ chatId: r.pingChatId, messageId: r.pingMessageId }] : []
  );
}

/**
 * updateNativeEvent for a REMINDER, with the same scopes. Every write keeps it
 * zero-length, and a change of time or allDay re-arms it in the same transaction
 * (spec §7): the moved occurrences lose their state rows and the series' armedAt is
 * reset. A title or location change keeps the state.
 */
async function updateNativeReminder(
  series: NativeEvent,
  input: UpdateNativeEventInput
): Promise<{ canonicalEventId: string; clearedPings: ClearedPing[] }> {
  const text = {
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.location !== undefined ? { location: input.location } : {}),
  };

  // One occurrence of a repeating reminder: an OVERRIDE row. armedAt stays on the
  // series; the pass arms a moved occurrence from the override's updatedAt.
  if (input.scope === 'single' && series.rrule && input.instanceStartsAt) {
    const key = { seriesEventId: series.id, originalStartsAt: input.instanceStartsAt };
    const clearedPings = await prisma.$transaction(async (tx) => {
      const existing = await tx.nativeEventInstance.findUnique({ where: { seriesEventId_originalStartsAt: key } });
      const edit = reminderTimeEdit(
        { startsAt: existing?.startsAt ?? key.originalStartsAt, allDay: existing?.allDay ?? series.allDay },
        input,
        series.timeZone
      );
      const times = edit ? { startsAt: edit.startsAt, endsAt: edit.endsAt, allDay: edit.allDay } : {};
      await tx.nativeEventInstance.upsert({
        where: { seriesEventId_originalStartsAt: key },
        create: {
          ...key,
          status: 'OVERRIDE',
          title: input.title,
          description: input.description ?? null,
          location: input.location ?? null,
          ...times,
        },
        update: { status: 'OVERRIDE', ...text, ...times },
      });
      return edit?.changed ? clearReminderStates(tx, key) : [];
    });
    return { canonicalEventId: encodeEventId(series.id, key.originalStartsAt), clearedPings };
  }

  // 'following' from an occurrence: cut the series there and start a new one. The new
  // series stays the creator's reminder for the same person, whoever made the edit.
  if (input.scope === 'following' && series.rrule && input.instanceStartsAt) {
    const cut = input.instanceStartsAt;
    const edit = reminderTimeEdit({ startsAt: cut, allDay: series.allDay }, input, series.timeZone);
    const target = edit ?? { startsAt: cut, endsAt: cut, allDay: series.allDay, changed: false };
    const { newSeriesId, clearedPings } = await prisma.$transaction(async (tx) => {
      await tx.nativeEvent.update({
        where: { id: series.id },
        data: { rrule: truncateRruleBefore(series.rrule!, cut, series.timeZone) },
      });
      const newSeries = await tx.nativeEvent.create({
        data: {
          calendarId: series.calendarId,
          creatorUserId: series.creatorUserId,
          title: input.title ?? series.title,
          description: input.description ?? series.description,
          location: input.location ?? series.location,
          startsAt: target.startsAt,
          endsAt: target.endsAt,
          allDay: target.allDay,
          timeZone: series.timeZone,
          rrule: series.rrule,
          reminderMinutes: series.reminderMinutes,
          kind: 'REMINDER',
          forUserId: series.forUserId,
          armedAt: target.changed ? new Date() : series.armedAt,
        },
      });
      const fromCut = { seriesEventId: series.id, originalStartsAt: { gte: cut } };
      await tx.nativeEventInstance.deleteMany({ where: fromCut });
      if (target.changed) {
        return { newSeriesId: newSeries.id, clearedPings: await clearReminderStates(tx, fromCut) };
      }
      // Unmoved, the new series' occurrences keep the same instants, so their
      // done/snoozed state follows them to it.
      await tx.nativeReminderState.updateMany({ where: fromCut, data: { seriesEventId: newSeries.id } });
      return { newSeriesId: newSeries.id, clearedPings: [] };
    });
    return { canonicalEventId: encodeEventId(newSeriesId), clearedPings };
  }

  // The series itself: a one-off reminder, every occurrence ('all'), or 'following'
  // with nothing to cut. 'single' on a series with no occurrence given changes
  // nothing, as for an event.
  if (input.scope === 'single' && series.rrule) {
    return { canonicalEventId: encodeEventId(series.id), clearedPings: [] };
  }
  const edit = reminderTimeEdit({ startsAt: series.startsAt, allDay: series.allDay }, input, series.timeZone);
  const clearedPings = await prisma.$transaction(async (tx) => {
    await tx.nativeEvent.update({
      where: { id: series.id },
      data: {
        ...text,
        ...(edit ? { startsAt: edit.startsAt, endsAt: edit.endsAt, allDay: edit.allDay } : {}),
        ...(edit?.changed ? { armedAt: new Date() } : {}),
      },
    });
    if (!edit?.changed) return [];
    // Moving every occurrence orphans the overrides, as for an event.
    if (input.scope === 'all') {
      await tx.nativeEventInstance.deleteMany({ where: { seriesEventId: series.id } });
    }
    return clearReminderStates(tx, { seriesEventId: series.id });
  });
  return { canonicalEventId: encodeEventId(series.id), clearedPings };
}
```

Notes on the reminder path:
- `reminderTimeEdit` returns `null` when the edit sends neither `startsAt` nor `allDay`. The times are then not rewritten at all. A rename can't re-arm, and it doesn't rewrite a start that might not be normalized.
- An edit that sends the same time again (plus the edit path's extra hour) writes zero-length times, but deletes nothing. `changed` compares the normalized start and `allDay` with the current ones.
- `current` for a single occurrence is the override's start if the occurrence was moved before, else its original slot. For `following`, it is the cut, because the new series starts from the original slot, as for events.

- [ ] **Step 9: `deleteNativeEvent`: the creator or the person it is for may delete a reminder**

Lines 446-449. This puts the permission check, then `deleteOccurrences` and the gate, in place of today's single check. Today's branch code becomes the body of `deleteOccurrences`, unchanged.

Find:

```ts
  const access = await getCalendarAccess(actor, calendar);
  if (!canWriteAccess(access)) throw new NativePermissionDeniedError();

  // Single occurrence on recurring: prefer EXDATE (cheap), but if there's an
```

Replace with:

```ts
  const access = await getCalendarAccess(actor, calendar);
  if (!canWriteAccess(access) && !(await mayDeleteReminder(series, actor.id))) {
    throw new NativePermissionDeniedError();
  }

  await deleteOccurrences(series, input);
  if (series.kind === 'REMINDER') invalidateDueGate();
}

/**
 * Whether someone without write access to the calendar may still delete a reminder:
 * its creator, or the person it is for ("stop reminding me"). That person is worked out
 * on every read (spec R2), so an ex-partner or a partner now on Google can't.
 */
async function mayDeleteReminder(series: NativeEvent, actorId: number): Promise<boolean> {
  if (series.kind !== 'REMINDER') return false;
  if (series.creatorUserId === actorId) return true;
  if (series.forUserId !== actorId) return false;
  const creator = await prisma.user.findUnique({
    where: { id: series.creatorUserId },
    select: { pairingId: true },
  });
  if (!creator) return false;
  const creatorPartner = await getActivePartnerSummary(series.creatorUserId, creator.pairingId);
  return effectiveOwnerId(series, creatorPartner) === actorId;
}

/** The write half of deleteNativeEvent, once the actor may delete. */
async function deleteOccurrences(series: NativeEvent, input: DeleteNativeEventInput): Promise<void> {
  // Single occurrence on recurring: prefer EXDATE (cheap), but if there's an
```

`mayDeleteReminder` returns early for an EVENT and for the creator, so the extra queries run only when someone other than the creator is the reminder's `forUserId`.

- [ ] **Step 10: Run tests to verify they pass**

```bash
for tz in UTC Asia/Jerusalem; do
  for s in smoke-native-reminder-store smoke-reminders smoke-recurrence smoke-day-shaping smoke-voice-dates smoke-week-lookahead smoke-native-reminder-ownership; do
    printf '%-28s %-15s ' "$s" "$tz"; TZ=$tz npx tsx scripts/$s.ts | tail -1
  done
done
npx tsc --noEmit -p .
npm run -s lint
```

Expected: every line ends `N/N passed`. Against Task 1's tree the counts are:
- `smoke-native-reminder-store`: 20/20
- `smoke-reminders`: 20/20
- `smoke-recurrence`: 24/24
- `smoke-day-shaping`: 24/24
- `smoke-voice-dates`: 66/66
- `smoke-week-lookahead`: 18/18
- `smoke-native-reminder-ownership`: Task 1's total (its ownership.ts to event-store.ts load order changes now that the store imports ownership, onboarding and the due gate)

If Task 1 added cases, its totals apply, but every line must still pass in full. `npx tsc --noEmit -p .` and `npm run -s lint` print nothing and exit 0.

- [ ] **Step 11: Commit**

```bash
git add src/services/native-calendar/event-store.ts scripts/smoke-native-reminder-store.ts scripts/smoke-reminders.ts
git commit -F - <<'EOF'
feat(reminders): event store keeps reminders zero-length and re-arms them

The store writes a reminder with no length, and arms it, on create, on every
edit scope and on the "from now on" split. That split keeps the original creator,
the person it is for and the kind.

A change of time deletes the moved occurrences' state rows in the same
transaction and hands back their live pings. The creator may change or delete a
reminder; the person it is for may delete it. getMainNativeCalendar picks the
user's own calendar, never the partner's. smoke-reminders fakes the store through
a Proxy that reads the real module lazily.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
EOF
```

---

### Task 3: Recurrence helper, UNTIL and day-shaping fixes

**Files:**
- Modify: `src/services/native-calendar/recurrence.ts:40-55`: `buildRuleSet` reads a date-only `UNTIL=YYYYMMDD` as `UNTIL=YYYYMMDDT235959` through a new private `withInclusiveUntil`.
- Modify: `src/services/native-calendar/recurrence.ts`, inserted after `expandSeries` (after line 234, before the `truncateRruleBefore` doc comment): new exported `latestOccurrenceBefore`, plus the private `LOOKBACK_STEPS_DAYS` and `DAY_MS` constants.
- Modify: `src/utils/day-events.ts:72-74` (`daySpanOf`, timed branch): a zero-length timed item belongs to a day iff `dayStart <= start < dayEnd`.
- Modify: `scripts/smoke-recurrence.ts`:
  - lines 12-13: imports;
  - insert a block before line 421 (`// --- fetchEventsInCalendars: …`): 9 `latestOccurrenceBefore` checks and 2 UNTIL checks;
- Modify: `scripts/smoke-day-shaping.ts`:
  - line 11: import `daySpanOf`;
  - insert 4 checks before line 220 (`let failed = 0;`).
- Test: `scripts/smoke-recurrence.ts`, `scripts/smoke-day-shaping.ts`. The regression check also runs `scripts/smoke-week-lookahead.ts`, `scripts/smoke-voice-dates.ts`, `scripts/smoke-reminders.ts`, `scripts/smoke-native-reminder-ownership.ts` and `scripts/smoke-native-reminder-store.ts`.

**Interfaces:**
- Consumes:
  - `NativeEvent`, `NativeEventInstance` from `@prisma/client`. Task 1 adds `kind`, `forUserId` and `armedAt` to `NativeEvent` and updates the `makeSeries` literal in `scripts/smoke-recurrence.ts` to match (Task 1 Step 10). This task doesn't read them.
  - The existing `expandSeries(event, range, overrides)` and `VirtualInstance` in `recurrence.ts`.
  - Nothing else from earlier tasks.
- Produces:
  - `export function latestOccurrenceBefore(event: NativeEvent, overrides: NativeEventInstance[], at: Date): VirtualInstance | null;` in `src/services/native-calendar/recurrence.ts`. Task 7 (`fetchOpenReminders`) and Task 13 (the matcher's "latest missed occurrence") use it. It returns:
    - the occurrence with the greatest **effective** `startsAt` strictly before `at`;
    - with `instanceStartsAt` = the occurrence key (the original slot; for a one-off, its `startsAt`);
    - `isOverridden: true` for a moved occurrence, and `isRecurringInstance: false` for a one-off;
    - `null` when there is none, or when the latest one lies more than 4000 days back.
  - `daySpanOf(event, day, tz)`: a zero-length timed event (`end === start` as instants, or no `end`) returns `undefined` on the day its instant falls in and `null` on every other day. Task 7 relies on a 00:00 reminder surviving `shapeEventsForDay`.
  - Every `expandSeries` caller reads a date-only UNTIL as covering its whole last day: the native provider fetchers, the Task 7 open-reminders fetch, the Task 8 firing pass and the Task 13 matcher.

- [ ] **Step 1: Write the failing tests**

**1. `scripts/smoke-recurrence.ts`: imports.** Find (lines 12-13):

```ts
import { expandSeries, truncateRruleBefore, VirtualInstance } from '../src/services/native-calendar/recurrence';
import { nextDate, startOfLocalDay } from '../src/utils/day-events';
```

Replace with:

```ts
import { expandSeries, latestOccurrenceBefore, truncateRruleBefore, VirtualInstance } from '../src/services/native-calendar/recurrence';
import { localDate, nextDate, startOfLocalDay } from '../src/utils/day-events';
```

**2. `scripts/smoke-recurrence.ts`: new checks.** Insert the block below immediately **before** this existing line (line 421):

```ts
// --- fetchEventsInCalendars: the SQL filter must take overlap too ------------
```

The block uses the existing helpers `at`, `JLM`, `jlm`, `makeSeries`, `makeOverride`, `check` and `assert`, all defined above that line.

```ts
// --- latestOccurrenceBefore: the last occurrence before a cutoff -------------
// A digest carries an undone repeating reminder over as "open since <day>", so it
// needs the occurrence that came last before the cutoff, as expandSeries shows it:
// exdates and CANCELLED gone, a moved occurrence counted where it moved to.

/** The effective start of the latest occurrence before `cutoff`, or 'none'. */
const latestStart = (series: NativeEvent, cutoff: Date, overrides: NativeEventInstance[] = []) =>
  latestOccurrenceBefore(series, overrides, cutoff)?.startsAt.toISOString() ?? 'none';
const iso = (local: string) => at(local).toISOString();

// A daily 08:00 reminder in Jerusalem from Monday 2026-11-02, saved the way
// reminders are: zero length. 2026-11-10 is a Tuesday.
const dailyPills = (fields: Partial<NativeEvent> = {}) => jlm({
  title: 'Pills', startsAt: at('2026-11-02 08:00'), endsAt: at('2026-11-02 08:00'), rrule: 'FREQ=DAILY', ...fields,
});

check('latest before: a one-off counts only when it starts before the cutoff', () => {
  const call = jlm({ title: 'Call the plumber', startsAt: at('2026-11-10 10:00'), endsAt: at('2026-11-10 10:00') });
  const found = latestOccurrenceBefore(call, [], at('2026-11-10 12:00'));
  assert(found !== null && found.startsAt.toISOString() === iso('2026-11-10 10:00'), `got ${found?.startsAt.toISOString()}`);
  assert(!found.isRecurringInstance && found.instanceStartsAt.getTime() === call.startsAt.getTime(), 'keyed as a one-off');
  assert(latestStart(call, at('2026-11-10 10:00')) === 'none', 'one starting exactly at the cutoff is not before it');
  assert(latestStart(call, at('2026-11-09 12:00')) === 'none', 'one still to come is not before it');
});

check('latest before: a daily series gives its last occurrence strictly before the cutoff', () => {
  const found = latestOccurrenceBefore(dailyPills(), [], at('2026-11-10 12:00'));
  assert(found !== null && found.startsAt.toISOString() === iso('2026-11-10 08:00'), `got ${found?.startsAt.toISOString()}`);
  assert(found.isRecurringInstance && found.instanceStartsAt.getTime() === found.startsAt.getTime(), 'keyed by its own slot');
  const atEight = latestStart(dailyPills(), at('2026-11-10 08:00'));
  assert(atEight === iso('2026-11-09 08:00'), `an occurrence at the cutoff is not before it: got ${atEight}`);
  assert(latestStart(dailyPills(), at('2026-11-02 08:00')) === 'none', 'nothing comes before the first occurrence');
});

check('latest before: an exdated latest occurrence gives the one before it', () => {
  const got = latestStart(dailyPills({ exdates: [at('2026-11-10 08:00')] }), at('2026-11-10 12:00'));
  assert(got === iso('2026-11-09 08:00'), `got ${got}`);
});

check('latest before: a CANCELLED latest occurrence gives the one before it', () => {
  const cancelled = [makeOverride('series-1', at('2026-11-10 08:00'), { status: 'CANCELLED' })];
  const got = latestStart(dailyPills(), at('2026-11-10 12:00'), cancelled);
  assert(got === iso('2026-11-09 08:00'), `got ${got}`);
});

check('latest before: an occurrence moved past the cutoff no longer counts', () => {
  const moved = [makeOverride('series-1', at('2026-11-10 08:00'), { startsAt: at('2026-11-10 18:00'), endsAt: at('2026-11-10 18:00') })];
  const got = latestStart(dailyPills(), at('2026-11-10 12:00'), moved);
  assert(got === iso('2026-11-09 08:00'), `got ${got}`);
});

check('latest before: a later occurrence moved before the cutoff counts, keyed by its own slot', () => {
  // Friday's occurrence, three days past the cutoff, moved to Tuesday 10:00.
  const moved = [makeOverride('series-1', at('2026-11-13 08:00'), { startsAt: at('2026-11-10 10:00'), endsAt: at('2026-11-10 10:00') })];
  const found = latestOccurrenceBefore(dailyPills(), moved, at('2026-11-10 12:00'));
  assert(found !== null && found.startsAt.toISOString() === iso('2026-11-10 10:00'), `got ${found?.startsAt.toISOString()}`);
  assert(found.isOverridden && found.instanceStartsAt.toISOString() === iso('2026-11-13 08:00'), `key ${found.instanceStartsAt.toISOString()}`);
});

check('latest before: it reaches back as far as the series needs', () => {
  // Weekly on Tuesdays, ended on Tuesday 2026-03-10: eight months back.
  const ended = dailyPills({ startsAt: at('2026-01-06 08:00'), endsAt: at('2026-01-06 08:00'), rrule: 'FREQ=WEEKLY;BYDAY=TU;UNTIL=20260310T235959' });
  assert(latestStart(ended, at('2026-11-10 12:00')) === iso('2026-03-10 08:00'), `ended weekly got ${latestStart(ended, at('2026-11-10 12:00'))}`);
  const yearly = dailyPills({ startsAt: at('2024-03-01 08:00'), endsAt: at('2024-03-01 08:00'), rrule: 'FREQ=YEARLY' });
  assert(latestStart(yearly, at('2026-11-10 12:00')) === iso('2026-03-01 08:00'), `yearly got ${latestStart(yearly, at('2026-11-10 12:00'))}`);
  const longGone = dailyPills({ startsAt: at('2021-05-01 08:00'), endsAt: at('2021-05-01 08:00'), rrule: 'FREQ=DAILY;COUNT=3' });
  assert(latestStart(longGone, at('2026-11-10 12:00')) === iso('2021-05-03 08:00'), `five years back got ${latestStart(longGone, at('2026-11-10 12:00'))}`);
});

check('latest before: a daily 08:00 stays 08:00 local across the DST change (Jerusalem)', () => {
  const series = dailyPills({ startsAt: at('2026-10-19 08:00'), endsAt: at('2026-10-19 08:00') });
  // Sunday 2026-10-25 is the first day on winter time. A rule held in UTC would put
  // that morning's occurrence at 07:00, before a 07:59 cutoff.
  const early = latestStart(series, at('2026-10-25 07:59'));
  assert(early === iso('2026-10-24 08:00'), `Sun 07:59 got ${early}`);
  const late = latestStart(series, at('2026-10-25 08:01'));
  assert(late === iso('2026-10-25 08:00'), `Sun 08:01 got ${late}`);
  // A weekly date-only reminder sits at local midnight, which moves an hour in UTC.
  const weekly = jlm({ title: 'Pay the nanny', allDay: true, startsAt: at('2026-10-04 00:00'), endsAt: at('2026-10-04 00:00'), rrule: 'FREQ=WEEKLY;BYDAY=SU' });
  const afterMidnight = latestStart(weekly, at('2026-11-01 00:30'));
  assert(afterMidnight === iso('2026-11-01 00:00'), `Sun 00:30 got ${afterMidnight}`);
  const atMidnight = latestStart(weekly, at('2026-11-01 00:00'));
  assert(atMidnight === iso('2026-10-25 00:00'), `Sun 00:00 got ${atMidnight}`);
});

check('latest before: a daily 08:00 stays 08:00 local across the DST change (New York)', () => {
  const NY = 'America/New_York';
  const atNY = (local: string) => fromZonedTime(`${local}:00`, NY);
  // Sunday 2026-11-01 is New York's first day on winter time.
  const series = makeSeries({ title: 'Walk the dog', timeZone: NY, startsAt: atNY('2026-10-26 08:00'), endsAt: atNY('2026-10-26 08:00'), rrule: 'FREQ=DAILY' });
  const early = latestStart(series, atNY('2026-11-01 07:59'));
  assert(early === atNY('2026-10-31 08:00').toISOString(), `Sun 07:59 got ${early}`);
  const late = latestStart(series, atNY('2026-11-01 08:01'));
  assert(late === atNY('2026-11-01 08:00').toISOString(), `Sun 08:01 got ${late}`);
});

// --- UNTIL as a bare date: the whole last day ---------------------------------
// The bot writes "until the 20th" as UNTIL=20261020 (calendar.ts
// buildRecurrenceRule). rrule reads that as 00:00 on the 20th, so a timed series
// lost its last day.

/** The local days a series occurs on, 2026-10-01 to 2026-11-01. */
const occurrenceDays = (series: NativeEvent) =>
  expandSeries(series, { from: at('2026-10-01 00:00'), to: at('2026-11-01 00:00') }).map((i) => localDate(i.startsAt, JLM)).join(',');

check('UNTIL as a bare date keeps the last day, wherever it sits in the rule', () => {
  const daily = jlm({ title: 'Pills', startsAt: at('2026-10-17 08:00'), endsAt: at('2026-10-17 08:00'), rrule: 'FREQ=DAILY;UNTIL=20261020' });
  assert(occurrenceDays(daily) === '2026-10-17,2026-10-18,2026-10-19,2026-10-20', `daily got [${occurrenceDays(daily)}]`);
  // 2026-10-06 and 2026-10-20 are Tuesdays.
  const weekly = jlm({ title: 'Swim', startsAt: at('2026-10-06 18:00'), endsAt: at('2026-10-06 19:00'), rrule: 'RRULE:FREQ=WEEKLY;UNTIL=20261020;BYDAY=TU' });
  assert(occurrenceDays(weekly) === '2026-10-06,2026-10-13,2026-10-20', `weekly got [${occurrenceDays(weekly)}]`);
});

check('UNTIL with a time, and all-day series, are unchanged', () => {
  // A floating date-time UNTIL, as truncateRruleBefore writes it, is inclusive as written.
  const cut = jlm({ title: 'Pills', startsAt: at('2026-10-17 08:00'), endsAt: at('2026-10-17 08:00'), rrule: 'FREQ=DAILY;UNTIL=20261019T080000' });
  assert(occurrenceDays(cut) === '2026-10-17,2026-10-18,2026-10-19', `date-time UNTIL got [${occurrenceDays(cut)}]`);
  // An all-day series starts at 00:00, so a bare-date UNTIL always kept its last day.
  const allDay = jlm({ title: 'Pay bills', allDay: true, startsAt: at('2026-10-17 00:00'), endsAt: at('2026-10-17 00:00'), rrule: 'FREQ=DAILY;UNTIL=20261020' });
  assert(occurrenceDays(allDay) === '2026-10-17,2026-10-18,2026-10-19,2026-10-20', `all-day got [${occurrenceDays(allDay)}]`);
});

```

**3. `scripts/smoke-day-shaping.ts`: import.** Find (line 11):

```ts
import { localDate, OVERNIGHT_CUTOFF_HOUR, shapeEventsForDay } from '../src/utils/day-events';
```

Replace with:

```ts
import { daySpanOf, localDate, OVERNIGHT_CUTOFF_HOUR, shapeEventsForDay } from '../src/utils/day-events';
```

**4. `scripts/smoke-day-shaping.ts`: new checks.** Insert the block below immediately **before** these existing lines (line 220):

```ts
let failed = 0;
for (const r of results) {
```

The checks assert on `daySpanOf` and `shapeEventsForDay` directly, not on the formatted line, so Task 7's reminder labels can't break them. They use the existing `ev`, `TZ`, `party` and `toUnifiedEvent`.

```ts
// Reminders are saved with no length. One at exactly 00:00 ended where its day began,
// so the overlap test put it on no day at all.
check('a zero-length item at 00:00 belongs to its own day, not the day before', () => {
  const pills = ev('Pills', '2026-10-13T00:00:00+03:00', '2026-10-13T00:00:00+03:00');
  assert(daySpanOf(pills, '2026-10-13', TZ) === undefined, `Tue ${daySpanOf(pills, '2026-10-13', TZ)}`);
  assert(daySpanOf(pills, '2026-10-12', TZ) === null, `Mon ${daySpanOf(pills, '2026-10-12', TZ)}`);
  assert(shapeEventsForDay([pills], '2026-10-13', TZ).length === 1, 'dropped from Tuesday');
  assert(shapeEventsForDay([pills], '2026-10-12', TZ).length === 0, 'kept on Monday');
  // The 25-hour DST day in Israel, and another timezone.
  const dst = ev('Pills', '2026-10-25T00:00:00+03:00', '2026-10-25T00:00:00+03:00');
  assert(daySpanOf(dst, '2026-10-25', TZ) === undefined && daySpanOf(dst, '2026-10-24', TZ) === null, 'DST day');
  const ny = ev('Pills', '2026-11-01T00:00:00-04:00', '2026-11-01T00:00:00-04:00');
  const nyDays = [daySpanOf(ny, '2026-10-31', 'America/New_York'), daySpanOf(ny, '2026-11-01', 'America/New_York')];
  assert(nyDays[0] === null && nyDays[1] === undefined, `New York ${nyDays.join(',')}`);
});

check('a zero-length item at 23:59 stays on its day', () => {
  const lock = ev('Lock the door', '2026-10-13T23:59:00+03:00', '2026-10-13T23:59:00+03:00');
  assert(daySpanOf(lock, '2026-10-13', TZ) === undefined, `Tue ${daySpanOf(lock, '2026-10-13', TZ)}`);
  assert(daySpanOf(lock, '2026-10-14', TZ) === null, `Wed ${daySpanOf(lock, '2026-10-14', TZ)}`);
});

check('a native zero-length occurrence at 00:00, as the store saves a reminder, is on its day', () => {
  // 2026-10-13 00:00 in Israel is 2026-10-12T21:00Z.
  const midnight = new Date('2026-10-12T21:00:00Z');
  const native = toUnifiedEvent({ id: 'cal1', name: 'Family' }, {
    title: 'Pills', startsAt: midnight, endsAt: midnight, allDay: false, timeZone: TZ,
    seriesEventId: 'e1', instanceStartsAt: midnight, isRecurringInstance: false,
  }) as CalendarEvent;
  assert(shapeEventsForDay([native], '2026-10-13', TZ).length === 1, 'dropped from Tuesday');
  assert(shapeEventsForDay([native], '2026-10-12', TZ).length === 0, 'kept on Monday');
});

check('events with a length keep their spans', () => {
  assert(daySpanOf(party, '2026-10-12', TZ) === 'endsLater', `party Mon ${daySpanOf(party, '2026-10-12', TZ)}`);
  assert(daySpanOf(party, '2026-10-13', TZ) === null, `party Tue ${daySpanOf(party, '2026-10-13', TZ)}`);
  const dinner = ev('Dinner', '2026-10-12T20:00:00+03:00', '2026-10-13T00:00:00+03:00');
  assert(daySpanOf(dinner, '2026-10-12', TZ) === undefined && daySpanOf(dinner, '2026-10-13', TZ) === null, 'dinner until midnight');
  const flight = ev('Flight', '2026-10-13T00:00:00+03:00', '2026-10-13T03:00:00+03:00');
  assert(daySpanOf(flight, '2026-10-13', TZ) === undefined && daySpanOf(flight, '2026-10-12', TZ) === null, 'flight from midnight');
});

```

- [ ] **Step 2: Run them to verify they fail**

```bash
TZ=UTC npx tsx scripts/smoke-recurrence.ts | grep -v '^OK'
TZ=Asia/Jerusalem npx tsx scripts/smoke-recurrence.ts | grep -v '^OK'
TZ=UTC npx tsx scripts/smoke-day-shaping.ts | grep -v '^OK'
TZ=Asia/Jerusalem npx tsx scripts/smoke-day-shaping.ts | grep -v '^OK'
```

Expected output, the same under both clocks. `smoke-recurrence.ts` prints **25/35 passed** (24 existing checks plus 11 new) and exits 1. Its 10 failures:
- the nine `latest before: …` checks, each with `— (0 , import_recurrence.latestOccurrenceBefore) is not a function`;
- `FAIL  UNTIL as a bare date keeps the last day, wherever it sits in the rule — daily got [2026-10-17,2026-10-18,2026-10-19]`.

`UNTIL with a time, and all-day series, are unchanged` already passes. It pins behaviour that must not change.

`smoke-day-shaping.ts` prints **26/28 passed** and exits 1:

```
FAIL  a zero-length item at 00:00 belongs to its own day, not the day before — Tue null
FAIL  a native zero-length occurrence at 00:00, as the store saves a reminder, is on its day — dropped from Tuesday
```

The 23:59 check and the "keep their spans" check already pass. They pin unchanged behaviour.

- [ ] **Step 3: Read a date-only UNTIL as the end of its day**

In `src/services/native-calendar/recurrence.ts`, find (lines 40-50):

```ts
/**
 * Parse an RRULE string into an RRuleSet, anchored at a dtstart.
 * Accepts either a bare rule like "FREQ=WEEKLY;BYDAY=MO" or one with the
 * "RRULE:" prefix. Building via RRule.parseString + the constructor (rather
 * than rrulestr with a `dtstart` option) is the only way to reliably anchor
 * occurrences at the series's actual start time — `rrulestr` ignores the
 * `dtstart` option when the RRULE string doesn't include its own DTSTART.
 */
function buildRuleSet(rrule: string, dtstart: Date): RRuleSet {
  const trimmed = rrule.startsWith('RRULE:') ? rrule.slice('RRULE:'.length) : rrule;
  const opts = RRule.parseString(trimmed);
```

Replace with:

```ts
/**
 * Read a date-only UNTIL as the end of that day. The bot writes "until the 20th"
 * as UNTIL=20261020 (calendar.ts buildRecurrenceRule), which rrule takes as 00:00
 * on the 20th in the floating time expansion runs in, so a timed series lost its
 * last day. Done when the rule is read, so rules already stored are fixed too. A
 * date-time UNTIL, as truncateRruleBefore writes it, is left alone.
 */
function withInclusiveUntil(rule: string): string {
  return rule.replace(/(^|;)UNTIL=(\d{8})(?=;|$)/, '$1UNTIL=$2T235959');
}

/**
 * Parse an RRULE string into an RRuleSet, anchored at a dtstart.
 * Accepts either a bare rule like "FREQ=WEEKLY;BYDAY=MO" or one with the
 * "RRULE:" prefix. Building via RRule.parseString + the constructor (rather
 * than rrulestr with a `dtstart` option) is the only way to reliably anchor
 * occurrences at the series's actual start time — `rrulestr` ignores the
 * `dtstart` option when the RRULE string doesn't include its own DTSTART.
 */
function buildRuleSet(rrule: string, dtstart: Date): RRuleSet {
  const trimmed = rrule.startsWith('RRULE:') ? rrule.slice('RRULE:'.length) : rrule;
  const opts = RRule.parseString(withInclusiveUntil(trimmed));
```

rrule 2.8.1 reads `UNTIL=20261020T235959` (no `Z`) into a Date's UTC fields, which is the same floating representation `toFloating` gives `dtstart`. This was verified in node.

- [ ] **Step 4: Add `latestOccurrenceBefore`**

In `src/services/native-calendar/recurrence.ts`, find the end of `expandSeries` and the start of the `truncateRruleBefore` doc comment:

```ts
  // Sort by effective start time
  instances.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  return instances;
}

/**
 * Truncate a recurring series' RRULE so it ends before a given instance.
```

Replace with:

```ts
  // Sort by effective start time
  instances.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  return instances;
}

/**
 * How far back latestOccurrenceBefore looks, in days, widening a step at a time:
 * a daily series is found in the first window, a yearly one by the fourth, and
 * one that ended years ago by the last.
 */
const LOOKBACK_STEPS_DAYS = [2, 14, 62, 400, 4000];
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The occurrence with the latest effective start strictly before `at`, or null.
 * Exdates, CANCELLED and moved OVERRIDEs apply as in expandSeries: an occurrence
 * moved past `at` doesn't count, and a later one moved before it does, keyed by
 * its original slot. A digest uses it for a repeating reminder's last occurrence
 * before its cutoff ("open since").
 */
export function latestOccurrenceBefore(
  event: NativeEvent,
  overrides: NativeEventInstance[],
  at: Date
): VirtualInstance | null {
  if (!event.rrule) {
    // A one-off has one occurrence; its effective start decides, as for a series.
    const [only] = expandSeries(event, { from: event.startsAt, to: at }, overrides);
    return only && only.startsAt < at ? only : null;
  }

  for (const days of LOOKBACK_STEPS_DAYS) {
    const from = new Date(at.getTime() - days * DAY_MS);
    // Only occurrences that start in [from, at). One that started earlier and is
    // still running at `from` may not be the latest; a wider window decides it.
    const started = expandSeries(event, { from, to: at }, overrides).filter((i) => i.startsAt >= from);
    if (started.length > 0) return started[started.length - 1];
    // The window already reaches the series' first occurrence.
    if (from <= event.startsAt) break;
  }
  return null;
}

/**
 * Truncate a recurring series' RRULE so it ends before a given instance.
```

Notes for the implementer:
- `expandSeries` already returns instances sorted by effective `startsAt`, all with `startsAt < at` (the window is half-open). The last element is therefore the latest.
- The `.filter((i) => i.startsAt >= from)` matters only for series whose occurrences overlap one another. It keeps the result exact for them.
- Moved overrides need no special handling. `expandSeries`'s second loop renders an override whose original slot lies outside the candidate range but which moved into the window (the "moved from Friday to Tuesday" test).

- [ ] **Step 5: Keep a zero-length timed item on the day of its instant**

In `src/utils/day-events.ts` (`daySpanOf`, timed branch), find (lines 72-74):

```ts
  const start = new Date(event.start);
  const end = new Date(event.end || event.start);
  if (end <= dayStart || start >= dayEnd) return null;
```

Replace with:

```ts
  const start = new Date(event.start);
  const end = new Date(event.end || event.start);
  // A zero-length item (a reminder) is an instant, so it belongs to the day it falls
  // in. The overlap test below would put one at exactly 00:00 on no day: it ends
  // where its own day begins.
  if (end.getTime() === start.getTime()) return start >= dayStart && start < dayEnd ? undefined : null;
  if (end <= dayStart || start >= dayEnd) return null;
```

Only zero-length timed items at exactly local midnight change: before, they were on no day; now they are on their own day. Every other zero-length time already returned `undefined` on its day and `null` elsewhere. Items with a length are unchanged. The other callers stay safe:
- `event-formatter.ts:49` coerces `null` to `undefined` anyway.
- `week-lookahead.ts:280` only asks about events that started before the first day.
- `voice/event-resolution.ts:415` only asks when `lastDay > startDate`, which a zero-length item never has.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
TZ=UTC npx tsx scripts/smoke-recurrence.ts | tail -1
TZ=Asia/Jerusalem npx tsx scripts/smoke-recurrence.ts | tail -1
TZ=UTC npx tsx scripts/smoke-day-shaping.ts | tail -1
TZ=Asia/Jerusalem npx tsx scripts/smoke-day-shaping.ts | tail -1
```

Expected:

```
35/35 passed
35/35 passed
28/28 passed (process TZ=UTC)
28/28 passed (process TZ=Asia/Jerusalem)
```

The regression check runs the other offline scripts that go through `expandSeries`, `daySpanOf` or `shapeEventsForDay`, including the two native-reminder scripts whose store feeds on `recurrence.ts`:

```bash
for tz in UTC Asia/Jerusalem; do for s in smoke-week-lookahead smoke-voice-dates smoke-reminders smoke-native-reminder-ownership smoke-native-reminder-store; do TZ=$tz npx tsx scripts/$s.ts 2>&1 | tail -1; done; done
```

Expected: every line reads `N/N passed (process TZ=…)`, with no failures. At the time of writing that is 18/18, 66/66 and 20/20 for the first three under each clock; the two native-reminder scripts keep whatever totals their own tasks set. The `[Upstash Redis] … missing` warnings are harmless.

Then:

```bash
npx tsc --noEmit -p .
npm run -s lint
```

Expected: both print nothing and exit 0. If `tsc` reports `scripts/smoke-recurrence.ts` `makeSeries` missing `kind`, `forUserId` or `armedAt`, Task 1 Step 10 was not applied; apply it first.

- [ ] **Step 7: Commit**

```bash
git add src/services/native-calendar/recurrence.ts src/utils/day-events.ts scripts/smoke-recurrence.ts scripts/smoke-day-shaping.ts
git commit -m "$(cat <<'EOF'
fix(native): latest-occurrence helper, inclusive UNTIL dates, keep 00:00 zero-length items

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
EOF
)"
```

---

### Task 4: Admin switch, reminder support gate, i18n keys

Adds the one R3 gate (`getReminderSupport`) and the admin switch it reads, wires the switch into the admin settings route and the admin panel, moves `escapeHtml` to the leaf module `src/utils/html.ts` (Planning Ruling 3), and adds every `bot.nativeReminders.*` key in en/he/ru, the `when.*` wording of the created reply included (Planning Ruling 6). It also adds a parity check for the three message files, and renames the settings page's event-alert copy to "Event alerts" (R9). Nothing here changes behaviour for anyone yet: later tasks call `getReminderSupport`.

**Files:**
- Create: `src/services/native-reminders/support.ts`: `isNativeRemindersEnabled`, `setNativeRemindersEnabled`, `getReminderSupport`.
- Create: `src/utils/html.ts`: `escapeHtml`, moved verbatim from `confirmations.ts`. A leaf module with no imports.
- Create: `scripts/check-i18n-parity.ts`: fails when en/he/ru differ in keys or in `{param}` placeholders.
- Modify: `src/config/redis-keys.ts:92-94`: add `NATIVE_REMINDERS_ENABLED: 'nrem:enabled'`.
- Modify: `src/services/voice/confirmations.ts:16-22`: drop the local `escapeHtml`; import it from `../../utils/html` and re-export it.
- Modify: `app/api/admin/settings/route.ts:12, 36-37, 51, 66-67, 90-93, 98, 112-116, 123-124`: GET returns `nativeRemindersEnabled` (default `true`); POST accepts it as a partial update (DB upsert, then `setNativeRemindersEnabled`).
- Modify: `app/[locale]/admin-panel/page.tsx:141-142`: pass `nativeRemindersEnabled` (default `true`).
- Modify: `app/[locale]/admin-panel/AdminPanelClient.tsx:19-21, 139, 148, 323-326, 2142-2150`: prop, state, toggle handler, and a toggle row right under "Event alerts".
- Modify: `messages/en.json`, `messages/he.json`, `messages/ru.json`:
  - lines 96-102: `admin.features`, adding `nativeReminders` and `nativeRemindersDescription`, and renaming the event-alert switch to "Event alerts";
  - lines 298-305 and 313: the `settings` event-alert values (R9). Only the values change; the keys stay;
  - lines 733-735: add `bot.nativeReminders` (with its `when.*` keys) after `bot.whatsapp`.
- Test: `scripts/smoke-native-reminder-support.ts` (new). Also run `scripts/check-i18n-parity.ts` and the existing `scripts/smoke-admin-settings-auth.ts`.

**Interfaces:**
- Consumes:
  - Task 1: `invalidateDueGate(): void` (sets `nextDueAt = 0` and `writtenSinceGate = true` on the `globalThis.__nativeReminderDueGate` state), and in the test only `__resetDueGateForTests()`, `setNextDue(next: Date | null, now: Date)` and `shouldRunPass(now: Date): boolean`, all from `src/services/native-reminders/due-gate.ts`.
  - Task 1: `AdminSettings.nativeRemindersEnabled Boolean @default(true)` in `prisma/schema.prisma`, with `npx prisma generate` already run, so `prisma.adminSettings` has the field.
  - Existing: `checkFeatureAccess(userId: number, feature: FeatureType): Promise<FeatureAccessResult>` (`src/services/subscription-service.ts:671`).
- Produces:
  ```ts
  // src/services/native-reminders/support.ts
  export type ReminderSupportReason = 'not_native' | 'no_telegram' | 'disabled' | 'no_access';
  export interface ReminderSupport { supported: boolean; reason?: ReminderSupportReason }
  export async function isNativeRemindersEnabled(): Promise<boolean>;            // Redis 'nrem:enabled' → DB → default true
  export async function setNativeRemindersEnabled(enabled: boolean): Promise<void>; // Redis write + invalidateDueGate() (DB written by the admin route)
  export async function getReminderSupport(user: { id: number; calendarSource: string; telegramId?: bigint | number | string | null }): Promise<ReminderSupport>;
  //   Not cached: callers compute it once per message and pass it down. Fails closed ('no_access') if checkFeatureAccess throws.
  // src/utils/html.ts (leaf module, no imports; re-exported from src/services/voice/confirmations.ts)
  export function escapeHtml(text: string): string;
  // src/config/redis-keys.ts
  REDIS_KEYS.NATIVE_REMINDERS_ENABLED === 'nrem:enabled'
  ```
  - Every `bot.nativeReminders.*` key in the plan's i18n list, in all three locales, with the same placeholders: 32 keys, the six `when.*` keys (`todayAt`, `tomorrowAt`, `dateAt`, `today`, `tomorrow`, `date`) included.
  - `admin.features.nativeReminders` and `admin.features.nativeRemindersDescription`.
  - `GET /api/admin/settings` returns `nativeRemindersEnabled`. `POST /api/admin/settings` accepts `{ nativeRemindersEnabled: boolean }` alone.
- **Notes for later tasks:**
  - Non-voice modules (event alerts in `reminders.ts`, `ping.ts`, `callbacks.ts`, `moved-pings.ts`) import `escapeHtml` from `src/utils/html.ts`. Voice modules may keep importing it from `confirmations.ts`.
  - `getBotMessage` does **not** HTML-escape. Pass `escapeHtml(title)` and `escapeHtml(name)` as params.
  - `{when}` in `created.self` and `created.partner` is a timed `when.*` value (`todayAt`, `tomorrowAt` or `dateAt`), and in `created.dateOnly` a date-only one (`today`, `tomorrow` or `date`). `{time}` is `HH:mm`, and `{date}` is the short Intl date in the user's language (`weekday: 'short', month: 'short', day: 'numeric'`): "Thu, Oct 15", "יום ה׳, 15 באוק׳", "чт, 15 окт.". The values are lowercase, for the middle of a sentence.
  - In Hebrew, `when.dateAt` glues `ב` to `{date}` and `created.dateOnly` glues `ל` to `{when}`, so a date must start with a Hebrew word; the he-IL short date does (`יום ה׳`).
  - In Russian, no preposition comes right before `{date}` (so a Tuesday never needs "во вт"), and `created.dateOnly` and `moved` put "на" before `{when}`. The copy is written so that `{name}` never needs declension.
  - A param that is an empty string is left as `{param}` by `getBotMessage` (`params[key] || …`).

- [ ] **Step 1: Write the failing test**

Create `scripts/smoke-native-reminder-support.ts`. It stubs Redis, Prisma, `subscription-service` and `admin-auth` through `require`'s cache (the `smoke-week-lookahead.ts` pattern), and uses Task 1's real due gate:

```ts
// Smoke test for the native reminders gate (spec R3) and its admin switch: which users get
// reminders and in which order the reasons apply, the switch read through Redis with the
// DB behind it (on by default, as the column is), the admin settings route writing it,
// escapeHtml in its leaf module, the bot.nativeReminders copy every later task reads (the
// created reply's when wording read as whole sentences in en, he and ru), and the settings
// page's event-alert copy renamed (R9). Redis, Prisma, the feature check and the admin
// check are faked; the due gate is the real one. The voice chain is never loaded: the
// confirmations.ts re-export is checked in its source. No network, no clock.
//
// Run: npx tsx scripts/smoke-native-reminder-support.ts

import Module from 'node:module';
import path from 'node:path';
import { readFileSync } from 'node:fs';

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
}

function assert(cond: boolean, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

// ---- Environment: fakes only, set before anything under test loads ----

process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.GEMINI_API_KEY = 'test-key';
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.UPSTASH_REDIS_REST_URL = 'https://redis.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
process.env.DATABASE_URL = 'postgresql://test@db.invalid/test';

/** Any request that slips past the fakes is refused and counted. */
const networkAttempts: string[] = [];
globalThis.fetch = (async (input: unknown) => {
  networkAttempts.push(String(input));
  throw new Error('network is blocked in this smoke test');
}) as typeof fetch;

// ---- Fakes ----

/** Every Redis and DB write, in order, so a test can tell which came first. */
const writes: string[] = [];

/** Redis as Upstash behaves: values round-trip through JSON. `down` makes every call throw. */
const store = new Map<string, string>();
const redisState = { down: false, reads: 0, failWrites: false };
const fakeRedis = {
  get: async (key: string) => {
    redisState.reads++;
    if (redisState.down) throw new Error('redis is down');
    return store.has(key) ? JSON.parse(store.get(key)!) : null;
  },
  set: async (key: string, value: unknown) => {
    if (redisState.down || redisState.failWrites) throw new Error('redis is down');
    writes.push(`redis ${key}=${JSON.stringify(value)}`);
    store.set(key, JSON.stringify(value));
    return 'OK';
  },
  del: async (key: string) => (store.delete(key) ? 1 : 0),
};

/** The AdminSettings singleton. Prisma returns only the selected columns and applies column defaults on create. */
const COLUMN_DEFAULTS = { remindersEnabled: false, earlyAdoptionMode: true, voiceAutoCreateHighConf: false, voiceTtsOutcome: false, nativeRemindersEnabled: true };
const db = { row: null as Record<string, unknown> | null, down: false, reads: 0 };
const upserts: { update: Record<string, unknown>; create: Record<string, unknown> }[] = [];
const fakePrisma = {
  adminSettings: {
    findUnique: async ({ select }: { where: { id: string }; select?: Record<string, boolean> }) => {
      db.reads++;
      if (db.down) throw new Error('db is down');
      if (!db.row) return null;
      const row = db.row;
      return select ? Object.fromEntries(Object.keys(select).map(k => [k, row[k]])) : { ...row };
    },
    upsert: async ({ update, create }: { where: { id: string }; update: Record<string, unknown>; create: Record<string, unknown> }) => {
      if (db.down) throw new Error('db is down');
      upserts.push({ update, create });
      writes.push(`db ${JSON.stringify(db.row ? update : create)}`);
      db.row = db.row ? { ...db.row, ...update } : { ...COLUMN_DEFAULTS, ...create };
      return { ...db.row };
    },
  },
};

/** checkFeatureAccess('reminders') per user id: true, false, or an error it throws. */
const access: Record<number, boolean | Error> = {};
const accessChecks: string[] = [];
const fakeSubscriptionService = {
  checkFeatureAccess: async (userId: number, feature: string) => {
    accessChecks.push(`${userId}:${feature}`);
    const allowed = access[userId];
    if (allowed instanceof Error) throw allowed;
    return allowed ? { allowed: true } : { allowed: false, reason: 'upgrade_required' };
  },
  invalidateAllFeatureAccessCaches: async () => {},
};

/** The admin check: initData 'admin' is an admin, anything else is refused. */
const fakeAdminAuth = {
  verifyAdminAccess: async (initData: string | undefined) =>
    initData === 'admin' ? { authorized: true, adminId: 1 } : { authorized: false, error: 'Unauthorized' },
};

// The stubs go into require's cache before the modules that import them load.
const SRC = path.resolve(__dirname, '../src');
const ModuleWithCache = Module as unknown as {
  new (id: string): { filename: string; loaded: boolean; exports: unknown };
  _cache: Record<string, unknown>;
};
function stub(file: string, exports: Record<string, unknown>) {
  const filename = path.join(SRC, file);
  const mod = new ModuleWithCache(filename);
  Object.assign(mod, { filename, loaded: true, exports });
  ModuleWithCache._cache[filename] = mod;
}
stub('utils/redis.ts', { redis: fakeRedis });
stub('utils/prisma.ts', { prisma: fakePrisma });
stub('services/subscription-service.ts', fakeSubscriptionService);
stub('lib/admin-auth.ts', fakeAdminAuth);
stub('lib/error-capture.ts', { captureError: () => {}, captureWarning: () => {}, captureInfo: () => {} });

function reset() {
  store.clear();
  writes.length = 0;
  upserts.length = 0;
  accessChecks.length = 0;
  Object.assign(redisState, { down: false, reads: 0, failWrites: false });
  Object.assign(db, { row: null, down: false, reads: 0 });
  for (const id of Object.keys(access)) delete access[Number(id)];
}

const FLAG = 'nrem:enabled';

/** Every key the later tasks read, as listed in the plan. */
const COPY_KEYS = [
  'ping.from', 'buttons.done', 'buttons.snooze15', 'buttons.snooze60', 'buttons.snoozeTomorrow',
  'done', 'snoozedUntil', 'alreadyDone', 'notYours', 'changed', 'doneBy', 'moved',
  'card.title', 'card.forPartner', 'card.noTimeSet', 'card.partnerNotOnTelegram', 'card.keepAsMine',
  'created.self', 'created.partner', 'created.dateOnly',
  'when.todayAt', 'when.tomorrowAt', 'when.dateAt', 'when.today', 'when.tomorrow', 'when.date',
  'typed.processing', 'typed.notUnderstood',
  'anchor.notFound', 'anchor.ambiguous', 'anchor.needsTime', 'permissionDenied',
];
const PARAMS: Record<string, string> = {
  name: 'Dana', title: 'Buy milk', time: '15:40', when: 'Thu 10:00', date: 'Thu, Oct 15', description: 'dentist',
};

async function main() {
  const { getReminderSupport, isNativeRemindersEnabled, setNativeRemindersEnabled } = await import('../src/services/native-reminders/support');
  const { __resetDueGateForTests, setNextDue, shouldRunPass } = await import('../src/services/native-reminders/due-gate');
  const { GET, POST } = await import('../app/api/admin/settings/route');
  const { NextRequest } = await import('next/server');
  const { escapeHtml } = await import('../src/utils/html');
  const { getBotMessage } = await import('../src/lib/bot-messages');

  // The code under test logs its Redis and DB failures; keep the output to the results.
  const quiet = { log: console.log, error: console.error, warn: console.warn };
  Object.assign(console, { log: () => {}, error: () => {}, warn: () => {} });

  const post = (body: Record<string, unknown>) =>
    POST(new NextRequest('http://localhost/api/admin/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }));
  const get = () => GET(new NextRequest('http://localhost/api/admin/settings?initData=admin'));

  // ---- getReminderSupport: the reasons, in order ----

  await check('a Google user is not_native, with no Redis read and no feature check', async () => {
    reset();
    access[1] = true;
    const support = await getReminderSupport({ id: 1, calendarSource: 'GOOGLE', telegramId: 1001 });
    assert(!support.supported && support.reason === 'not_native', JSON.stringify(support));
    assert(redisState.reads === 0 && accessChecks.length === 0, `redis reads ${redisState.reads}, feature checks ${accessChecks}`);
  });

  await check('the first failing reason wins: a Google user with no Telegram and the switch off is not_native', async () => {
    reset();
    store.set(FLAG, 'false');
    const support = await getReminderSupport({ id: 2, calendarSource: 'GOOGLE', telegramId: null });
    assert(support.reason === 'not_native', JSON.stringify(support));
  });

  await check('a WhatsApp-only built-in user is no_telegram, with no Redis read', async () => {
    reset();
    access[3] = true;
    for (const telegramId of [null, undefined]) {
      const support = await getReminderSupport({ id: 3, calendarSource: 'NATIVE', telegramId });
      assert(!support.supported && support.reason === 'no_telegram', `${telegramId}: ${JSON.stringify(support)}`);
    }
    assert(redisState.reads === 0 && accessChecks.length === 0, `redis reads ${redisState.reads}, feature checks ${accessChecks}`);
  });

  await check('switch off: disabled, and the feature is not checked', async () => {
    reset();
    store.set(FLAG, 'false');
    access[4] = true;
    const support = await getReminderSupport({ id: 4, calendarSource: 'NATIVE', telegramId: 1004 });
    assert(!support.supported && support.reason === 'disabled', JSON.stringify(support));
    assert(accessChecks.length === 0, `feature checks ${accessChecks}`);
  });

  await check('no Pro, trial, override or early adoption: no_access, from the reminders feature', async () => {
    reset();
    access[5] = false;
    const support = await getReminderSupport({ id: 5, calendarSource: 'NATIVE', telegramId: 1005 });
    assert(!support.supported && support.reason === 'no_access', JSON.stringify(support));
    assert(accessChecks.join() === '5:reminders', `feature checks ${accessChecks}`);
  });

  await check('everything holds: supported with no reason, whatever type the Telegram id has', async () => {
    reset();
    access[6] = true;
    for (const telegramId of [1006, BigInt(1006), '1006']) {
      const support = await getReminderSupport({ id: 6, calendarSource: 'NATIVE', telegramId });
      assert(support.supported && support.reason === undefined, `${typeof telegramId}: ${JSON.stringify(support)}`);
    }
  });

  await check('a failing feature check fails closed as no_access instead of throwing', async () => {
    reset();
    access[7] = new Error('db is down');
    const support = await getReminderSupport({ id: 7, calendarSource: 'NATIVE', telegramId: 1007 });
    assert(!support.supported && support.reason === 'no_access', JSON.stringify(support));
  });

  // ---- isNativeRemindersEnabled: Redis first, the DB behind it, on by default ----

  await check('no Redis value and no settings row: on, and Redis now holds it', async () => {
    reset();
    assert((await isNativeRemindersEnabled()) === true, 'read as off');
    assert(store.get(FLAG) === 'true', `redis holds ${store.get(FLAG)}`);
  });

  await check('no Redis value and the row says off: off, cached so the next read skips the DB', async () => {
    reset();
    db.row = { ...COLUMN_DEFAULTS, nativeRemindersEnabled: false };
    assert((await isNativeRemindersEnabled()) === false, 'first read is on');
    assert((await isNativeRemindersEnabled()) === false, 'second read is on');
    assert(db.reads === 1, `${db.reads} DB reads`);
  });

  await check('Redis says off: off, with no DB read', async () => {
    reset();
    store.set(FLAG, 'false');
    db.row = { ...COLUMN_DEFAULTS, nativeRemindersEnabled: true };
    assert((await isNativeRemindersEnabled()) === false, 'read as on');
    assert(db.reads === 0, `${db.reads} DB reads`);
  });

  await check('Redis down: the DB value, and nothing thrown', async () => {
    reset();
    redisState.down = true;
    db.row = { ...COLUMN_DEFAULTS, nativeRemindersEnabled: false };
    assert((await isNativeRemindersEnabled()) === false, 'read as on');
  });

  await check('Redis and the DB both down: on', async () => {
    reset();
    redisState.down = true;
    db.down = true;
    assert((await isNativeRemindersEnabled()) === true, 'read as off');
  });

  await check('a failed cache write still returns the DB value', async () => {
    reset();
    redisState.failWrites = true;
    db.row = { ...COLUMN_DEFAULTS, nativeRemindersEnabled: false };
    assert((await isNativeRemindersEnabled()) === false, 'read as on');
  });

  // ---- setNativeRemindersEnabled: Redis, then the due gate ----

  await check('setting the switch writes nrem:enabled and reopens the due gate', async () => {
    reset();
    __resetDueGateForTests();
    const now = new Date('2026-10-14T10:00:00Z');
    setNextDue(null, now);
    assert(!shouldRunPass(now), 'the gate was open before the switch changed');
    await setNativeRemindersEnabled(true);
    assert(store.get(FLAG) === 'true', `redis holds ${store.get(FLAG)}`);
    assert(shouldRunPass(now), 'the gate stayed closed');
  });

  await check('a failed Redis write is swallowed and still reopens the due gate', async () => {
    reset();
    __resetDueGateForTests();
    const now = new Date('2026-10-14T10:00:00Z');
    setNextDue(null, now);
    redisState.failWrites = true;
    await setNativeRemindersEnabled(false);
    assert(shouldRunPass(now), 'the gate stayed closed');
  });

  await check('the switch adds no Redis key under reminder: or reminders:', async () => {
    reset();
    await isNativeRemindersEnabled();
    await setNativeRemindersEnabled(true);
    const keys = [...store.keys()];
    assert(keys.length > 0 && keys.every(k => k.startsWith('nrem:')), `keys ${keys}`);
  });

  // ---- The admin settings route ----

  await check('POST with only nativeRemindersEnabled: the DB, then Redis, then the answer', async () => {
    reset();
    db.row = { ...COLUMN_DEFAULTS };
    const res = await post({ nativeRemindersEnabled: false, initData: 'admin' });
    const body = await res.json();
    assert(res.status === 200, `status ${res.status}: ${JSON.stringify(body)}`);
    assert(body.nativeRemindersEnabled === false, `answered ${JSON.stringify(body)}`);
    assert(JSON.stringify(upserts[0]?.update) === '{"nativeRemindersEnabled":false}', `update ${JSON.stringify(upserts[0]?.update)}`);
    assert(writes.join(' | ') === 'db {"nativeRemindersEnabled":false} | redis nrem:enabled=false', `writes ${writes.join(' | ')}`);
  });

  await check('POST on a fresh database creates the row with the switch', async () => {
    reset();
    const res = await post({ nativeRemindersEnabled: false, initData: 'admin' });
    assert(res.status === 200, `status ${res.status}`);
    assert(JSON.stringify(upserts[0]?.create) === '{"id":"global","nativeRemindersEnabled":false}', `create ${JSON.stringify(upserts[0]?.create)}`);
    assert(db.row?.nativeRemindersEnabled === false, `row ${JSON.stringify(db.row)}`);
  });

  await check('POST of another toggle leaves the native switch alone', async () => {
    reset();
    db.row = { ...COLUMN_DEFAULTS };
    const res = await post({ voiceTtsOutcome: true, initData: 'admin' });
    const body = await res.json();
    assert(res.status === 200, `status ${res.status}`);
    assert(!('nativeRemindersEnabled' in upserts[0].update), `update ${JSON.stringify(upserts[0].update)}`);
    assert(!store.has(FLAG), 'nrem:enabled was written');
    assert(body.nativeRemindersEnabled === true, `answered ${JSON.stringify(body)}`);
  });

  await check('POST with no known field is still a 400, and a non-boolean switch is no field', async () => {
    reset();
    for (const body of [{ initData: 'admin' }, { nativeRemindersEnabled: 'no', initData: 'admin' }]) {
      const res = await post(body);
      assert(res.status === 400, `${JSON.stringify(body)}: status ${res.status}`);
    }
    assert(upserts.length === 0, `${upserts.length} upserts`);
  });

  await check('POST without admin initData is refused and writes nothing', async () => {
    reset();
    const res = await post({ nativeRemindersEnabled: false, initData: 'someone' });
    assert(res.status === 401, `status ${res.status}`);
    assert(writes.length === 0, `writes ${writes}`);
  });

  await check('GET returns the switch: on with no settings row, off when the row says so', async () => {
    reset();
    const fresh = await (await get()).json();
    assert(fresh.nativeRemindersEnabled === true, `no row: ${JSON.stringify(fresh)}`);
    db.row = { ...COLUMN_DEFAULTS, nativeRemindersEnabled: false };
    const off = await (await get()).json();
    assert(off.nativeRemindersEnabled === false, `row off: ${JSON.stringify(off)}`);
  });

  // ---- escapeHtml ----

  await check('escapeHtml escapes &, < and > in any language', () => {
    assert(escapeHtml('<b>Tom & Jerry</b>') === '&lt;b&gt;Tom &amp; Jerry&lt;/b&gt;', escapeHtml('<b>Tom & Jerry</b>'));
    assert(escapeHtml('תור <רופא> & בדיקה') === 'תור &lt;רופא&gt; &amp; בדיקה', escapeHtml('תור <רופא> & בדיקה'));
    assert(escapeHtml('Купить <молоко> & хлеб') === 'Купить &lt;молоко&gt; &amp; хлеб', escapeHtml('Купить <молоко> & хлеб'));
  });

  await check('escapeHtml lives in the leaf src/utils/html.ts, and confirmations.ts re-exports it', () => {
    const leaf = readFileSync(path.resolve(__dirname, '../src/utils/html.ts'), 'utf8');
    assert(!/^\s*import\b|\brequire\(/m.test(leaf), 'src/utils/html.ts imports something');
    const confirmations = readFileSync(path.resolve(__dirname, '../src/services/voice/confirmations.ts'), 'utf8');
    assert(/^export \{ escapeHtml \} from '\.\.\/\.\.\/utils\/html';$/m.test(confirmations), 'confirmations.ts does not re-export it');
    assert(!/function escapeHtml\b/.test(confirmations), 'confirmations.ts still has its own escapeHtml');
  });

  // ---- Copy ----

  await check('every bot.nativeReminders key the later tasks read exists in en, he and ru', async () => {
    const missing: string[] = [];
    for (const locale of ['en', 'he', 'ru']) {
      for (const key of COPY_KEYS) {
        const text = await getBotMessage(locale, `nativeReminders.${key}`);
        if (typeof text !== 'string' || text === `nativeReminders.${key}` || !text.trim()) missing.push(`${locale}:${key}`);
      }
    }
    assert(missing.length === 0, `missing ${missing.join(', ')}`);
  });

  await check('every key fills in all its placeholders in every locale', async () => {
    const bad: string[] = [];
    for (const locale of ['en', 'he', 'ru']) {
      for (const key of COPY_KEYS) {
        const english = await getBotMessage('en', `nativeReminders.${key}`);
        const wanted = [...english.matchAll(/\{(\w+)\}/g)].map(m => m[1]);
        const text = await getBotMessage(locale, `nativeReminders.${key}`, PARAMS);
        if (/\{\w+\}/.test(text) || wanted.some(p => !text.includes(PARAMS[p]))) bad.push(`${locale}:${key} → ${text}`);
      }
    }
    assert(bad.length === 0, bad.join('\n     '));
  });

  await check('the created reply reads as one sentence with every when form, in en, he and ru', async () => {
    // {date} as Task 11's formatReminderWhen passes it: the short Intl date in each language.
    const samples: Record<string, { name: string; date: string; want: string[] }> = {
      en: {
        name: 'Dana',
        date: 'Thu, Oct 15',
        want: [
          "⏰ I'll remind you today at 17:00.",
          "⏰ I'll remind you tomorrow at 17:00.",
          "⏰ I'll remind you on Thu, Oct 15 at 17:00.",
          "⏰ I'll remind Dana today at 17:00.",
          "⏰ I'll remind Dana tomorrow at 17:00.",
          "⏰ I'll remind Dana on Thu, Oct 15 at 17:00.",
          '⏰ Reminder set for today.',
          '⏰ Reminder set for tomorrow.',
          '⏰ Reminder set for Thu, Oct 15.',
        ],
      },
      he: {
        name: 'דנה',
        date: 'יום ה׳, 15 באוק׳',
        want: [
          '⏰ אזכיר לך היום ב-17:00.',
          '⏰ אזכיר לך מחר ב-17:00.',
          '⏰ אזכיר לך ביום ה׳, 15 באוק׳, ב-17:00.',
          '⏰ אזכיר ל-דנה היום ב-17:00.',
          '⏰ אזכיר ל-דנה מחר ב-17:00.',
          '⏰ אזכיר ל-דנה ביום ה׳, 15 באוק׳, ב-17:00.',
          '⏰ התזכורת נקבעה להיום.',
          '⏰ התזכורת נקבעה למחר.',
          '⏰ התזכורת נקבעה ליום ה׳, 15 באוק׳.',
        ],
      },
      ru: {
        name: 'Дана',
        date: 'чт, 15 окт.',
        want: [
          '⏰ Напомню тебе сегодня в 17:00.',
          '⏰ Напомню тебе завтра в 17:00.',
          '⏰ Напомню тебе чт, 15 окт. в 17:00.',
          '⏰ Дана получит напоминание сегодня в 17:00.',
          '⏰ Дана получит напоминание завтра в 17:00.',
          '⏰ Дана получит напоминание чт, 15 окт. в 17:00.',
          '⏰ Напоминание на сегодня поставлено.',
          '⏰ Напоминание на завтра поставлено.',
          '⏰ Напоминание на чт, 15 окт. поставлено.',
        ],
      },
    };
    const bad: string[] = [];
    for (const [locale, { name, date, want }] of Object.entries(samples)) {
      const when = (key: string) => getBotMessage(locale, `nativeReminders.when.${key}`, { time: '17:00', date });
      const timed = [await when('todayAt'), await when('tomorrowAt'), await when('dateAt')];
      const dated = [await when('today'), await when('tomorrow'), await when('date')];
      const got: string[] = [];
      for (const w of timed) got.push(await getBotMessage(locale, 'nativeReminders.created.self', { when: w }));
      for (const w of timed) got.push(await getBotMessage(locale, 'nativeReminders.created.partner', { name, when: w }));
      for (const w of dated) got.push(await getBotMessage(locale, 'nativeReminders.created.dateOnly', { when: w }));
      got.forEach((line, i) => {
        if (line !== want[i]) bad.push(`${locale}: "${line}", want "${want[i]}"`);
      });
    }
    assert(bad.length === 0, bad.join('\n     '));
  });

  await check('the settings page calls event alerts alerts (R9), with its keys unchanged', () => {
    const want: Record<string, { title: string; old: RegExp }> = {
      en: { title: 'Event alerts', old: /remind/i },
      he: { title: 'התראות על אירועים', old: /תזכור/ },
      ru: { title: 'Уведомления о событиях', old: /напомина/i },
    };
    const keys = ['remindersSection', 'remindersEnabled', 'remindersEnabledDescription', 'remindersBetaDescription', 'defaultReminderMinutes',
      'defaultReminderMinutesHelp', 'pickupRemindersEnabled', 'pickupRemindersDescription', 'remindersProRequired'];
    for (const [locale, { title, old }] of Object.entries(want)) {
      const settings = JSON.parse(readFileSync(path.resolve(__dirname, '../messages', `${locale}.json`), 'utf8')).settings;
      assert(settings.remindersSection === title, `${locale} section: ${settings.remindersSection}`);
      for (const key of keys) {
        assert(typeof settings[key] === 'string', `${locale}: settings.${key} is gone`);
        assert(!old.test(settings[key]), `${locale}: settings.${key} still says "${settings[key]}"`);
      }
    }
  });

  await check('the admin panel has a label and a description for the switch in every locale', () => {
    for (const locale of ['en', 'he', 'ru']) {
      const features = JSON.parse(readFileSync(path.resolve(__dirname, '../messages', `${locale}.json`), 'utf8')).admin.features;
      assert(typeof features.nativeReminders === 'string' && features.nativeReminders.trim() !== '', `${locale}: no label`);
      assert(typeof features.nativeRemindersDescription === 'string' && features.nativeRemindersDescription.trim() !== '', `${locale}: no description`);
    }
  });

  await check('no network', () => {
    assert(networkAttempts.length === 0, `network attempts: ${networkAttempts.join(', ')}`);
  });

  Object.assign(console, quiet);
  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
```

Create `scripts/check-i18n-parity.ts`:

```ts
// i18n parity: messages/en.json, he.json and ru.json must hold the same keys, and each
// key the same {param} placeholders. A key missing from one locale reaches the user as
// its own path ("nativeReminders.done") through getBotMessage, or as English through the
// `t.voice?.x || 'English'` fallbacks; a placeholder missing from one locale drops the
// title or name from that language's message. An array counts as one key.
//
// Run: npx tsx scripts/check-i18n-parity.ts

import { readFileSync } from 'node:fs';
import path from 'node:path';

const LOCALES = ['en', 'he', 'ru'] as const;
type Locale = (typeof LOCALES)[number];

/** Every leaf of the message tree, by its dot path. */
function flatten(node: unknown, prefix: string, out: Map<string, unknown>): Map<string, unknown> {
  if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
    for (const [key, value] of Object.entries(node)) flatten(value, prefix ? `${prefix}.${key}` : key, out);
  } else {
    out.set(prefix, node);
  }
  return out;
}

/** The {param} names getBotMessage would fill in, sorted. ICU plurals don't match the pattern. */
function placeholders(value: unknown): string {
  if (typeof value !== 'string') return '';
  return [...new Set(value.match(/\{\w+\}/g) ?? [])].sort().join(' ');
}

const leaves = Object.fromEntries(
  LOCALES.map(locale => {
    const file = path.resolve(__dirname, '../messages', `${locale}.json`);
    return [locale, flatten(JSON.parse(readFileSync(file, 'utf8')), '', new Map())];
  })
) as Record<Locale, Map<string, unknown>>;

const allKeys = [...new Set(LOCALES.flatMap(locale => [...leaves[locale].keys()]))].sort();
const problems: string[] = [];

for (const locale of LOCALES) {
  for (const key of allKeys) {
    if (!leaves[locale].has(key)) problems.push(`${locale}: missing ${key}`);
  }
}

for (const key of allKeys) {
  if (!LOCALES.every(locale => leaves[locale].has(key))) continue;
  const reference = placeholders(leaves.en.get(key));
  for (const locale of LOCALES) {
    const got = placeholders(leaves[locale].get(key));
    if (got !== reference) problems.push(`${locale}: ${key} has placeholders [${got}], en has [${reference}]`);
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.log(problem);
  console.log(`\ni18n parity FAILED (${problems.length} problem${problems.length === 1 ? '' : 's'})`);
  process.exit(1);
}
console.log(`i18n parity OK (${allKeys.length} keys)`);
```

- [ ] **Step 2: Run them to verify the smoke test fails**

```bash
npx tsx scripts/smoke-native-reminder-support.ts; echo "exit=$?"
npx tsx scripts/check-i18n-parity.ts
```

Expected:
- The smoke test fails with `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/src/services/native-reminders/support' imported from …/scripts/smoke-native-reminder-support.ts` and `exit=1`.
- The parity check prints the baseline, `i18n parity OK (818 keys)`. tsx may also print a `DEP0205` deprecation warning on stderr; ignore it.

- [ ] **Step 3: Add the Redis key**

Find in `src/config/redis-keys.ts`:

```ts
  // Voice frictionlessness — admin toggles cached from AdminSettings
  VOICE_AUTO_CREATE_HIGH_CONF: 'admin:voice_auto_create_high_conf',
  VOICE_TTS_OUTCOME: 'admin:voice_tts_outcome',
```

Replace with:

```ts
  // Voice frictionlessness — admin toggles cached from AdminSettings
  VOICE_AUTO_CREATE_HIGH_CONF: 'admin:voice_auto_create_high_conf',
  VOICE_TTS_OUTCOME: 'admin:voice_tts_outcome',

  // Native reminders — the admin switch cached from AdminSettings. Its own prefix:
  // "reminder:" and "reminders:" belong to event alerts.
  NATIVE_REMINDERS_ENABLED: 'nrem:enabled',
```

- [ ] **Step 4: Create the support module**

Create `src/services/native-reminders/support.ts`:

```ts
/**
 * Native reminders: the admin switch and the one gate for who gets reminders (spec R3).
 *
 * A user gets reminders only on the built-in calendar, with a Telegram account (the ping
 * and its buttons live there), while the admin switch is on, and with access to the
 * 'reminders' feature (Pro, trial, admin override or early adoption). When any of these
 * fails, the extraction prompt has no reminder rules, typed text keeps today's route, and
 * the pass skips that creator's reminders.
 */

import { redis } from '../../utils/redis';
import { prisma } from '../../utils/prisma';
import { REDIS_KEYS } from '../../config/redis-keys';
import { captureError } from '../../lib/error-capture';
import { checkFeatureAccess } from '../subscription-service';
import { invalidateDueGate } from './due-gate';

const FLAG_KEY = REDIS_KEYS.NATIVE_REMINDERS_ENABLED;

export type ReminderSupportReason = 'not_native' | 'no_telegram' | 'disabled' | 'no_access';

export interface ReminderSupport {
  supported: boolean;
  reason?: ReminderSupportReason;
}

/**
 * The admin switch AdminSettings.nativeRemindersEnabled, read through Redis. It defaults
 * to on, as the column does: no settings row reads as on, and so does Redis and the DB
 * both failing. When only Redis fails, the DB value is used.
 */
export async function isNativeRemindersEnabled(): Promise<boolean> {
  let redisUp = true;
  try {
    const cached = await redis.get<boolean>(FLAG_KEY);
    if (typeof cached === 'boolean') return cached;
  } catch (error) {
    redisUp = false;
    console.error('[NativeReminders] Redis read of the admin switch failed:', error);
    captureError(error, 'native-reminders-flag', {}, 'warning');
  }

  try {
    const settings = await prisma.adminSettings.findUnique({
      where: { id: 'global' },
      select: { nativeRemindersEnabled: true },
    });
    const value = settings?.nativeRemindersEnabled ?? true;
    if (redisUp) {
      await redis.set(FLAG_KEY, value).catch(error => captureError(error, 'native-reminders-flag', {}, 'warning'));
    }
    return value;
  } catch (error) {
    console.error('[NativeReminders] DB read of the admin switch failed:', error);
    captureError(error, 'native-reminders-flag', {}, 'warning');
    return true;
  }
}

/**
 * Writes the admin switch to Redis (the admin route has already written the DB) and
 * reopens the due gate, so switching on pings due reminders at the next minute instead
 * of after the gate's hour.
 */
export async function setNativeRemindersEnabled(enabled: boolean): Promise<void> {
  try {
    await redis.set(FLAG_KEY, enabled);
    console.log(`[NativeReminders] Set the admin switch to ${enabled}`);
  } catch (error) {
    console.error('[NativeReminders] Redis write of the admin switch failed:', error);
    captureError(error, 'native-reminders-flag', {}, 'warning');
  }
  invalidateDueGate();
}

function hasTelegram(telegramId: bigint | number | string | null | undefined): boolean {
  return telegramId !== null && telegramId !== undefined && String(telegramId) !== '';
}

/**
 * Whether this user gets reminders and, if not, the first reason why. The checks run
 * cheapest first, so a Google or WhatsApp-only user costs no Redis read. checkFeatureAccess
 * caches its answer in Redis for 24h; a caller that needs the answer more than once per
 * message keeps the result. An error in the feature check fails closed: without
 * reminders the user gets today's behaviour.
 */
export async function getReminderSupport(user: {
  id: number;
  calendarSource: string;
  telegramId?: bigint | number | string | null;
}): Promise<ReminderSupport> {
  if (user.calendarSource !== 'NATIVE') return { supported: false, reason: 'not_native' };
  if (!hasTelegram(user.telegramId)) return { supported: false, reason: 'no_telegram' };
  if (!(await isNativeRemindersEnabled())) return { supported: false, reason: 'disabled' };

  try {
    const access = await checkFeatureAccess(user.id, 'reminders');
    if (!access.allowed) return { supported: false, reason: 'no_access' };
  } catch (error) {
    console.error(`[NativeReminders] Feature check failed for user ${user.id}:`, error);
    captureError(error, 'native-reminders-support', { user_id: user.id }, 'warning');
    return { supported: false, reason: 'no_access' };
  }
  return { supported: true };
}
```

Note: `setNativeRemindersEnabled` runs in the admin route's bundle, and the scheduler's cron runs in the `instrumentation.ts` bundle. Its `invalidateDueGate()` reaches the scheduler only because Task 1 keeps the gate's state on `globalThis` (Planning Ruling 1). Nothing in this file has to change for that.

- [ ] **Step 5: Move `escapeHtml` to `src/utils/html.ts`**

Create `src/utils/html.ts`, with the function moved verbatim from `confirmations.ts`:

```ts
/**
 * HTML escaping for Telegram's parse_mode 'HTML'. Every user-supplied string (titles,
 * names, places) goes through escapeHtml before it is put into a message.
 *
 * A leaf module with no imports, so the cron passes (event alerts, native reminder
 * pings) can escape text without loading the voice confirmation chain.
 */

/** Escapes &, < and > for parse_mode 'HTML'. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
```

Then find in `src/services/voice/confirmations.ts`:

```ts
import { daysBetween, describeEdit, EditSpan } from './event-resolution';

const PENDING_TTL_SECONDS = 600; // 10 minutes

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
```

Replace with:

```ts
import { daysBetween, describeEdit, EditSpan } from './event-resolution';
import { escapeHtml } from '../../utils/html';

// Voice modules import escapeHtml from here; anything outside voice imports src/utils/html.
export { escapeHtml } from '../../utils/html';

const PENDING_TTL_SECONDS = 600; // 10 minutes
```

The three existing callers in `confirmations.ts` (lines ~347, ~448, ~523) keep calling `escapeHtml` unchanged.

- [ ] **Step 6: Admin settings route accepts and returns the switch**

The toggle-sync pattern is: the DB upsert first, then the Redis write (`setNativeRemindersEnabled`, which also reopens the due gate). GET defaults to `true`, as the column does. Apply these eight edits to `app/api/admin/settings/route.ts`:

Find in `app/api/admin/settings/route.ts`:

```ts
import { invalidateAllFeatureAccessCaches } from '@/src/services/subscription-service';
```

Replace with:

```ts
import { invalidateAllFeatureAccessCaches } from '@/src/services/subscription-service';
import { setNativeRemindersEnabled } from '@/src/services/native-reminders/support';
```

Find in `app/api/admin/settings/route.ts`:

```ts
      voiceTtsOutcome: adminSettings?.voiceTtsOutcome ?? false,
    });
```

Replace with:

```ts
      voiceTtsOutcome: adminSettings?.voiceTtsOutcome ?? false,
      nativeRemindersEnabled: adminSettings?.nativeRemindersEnabled ?? true,
    });
```

Find in `app/api/admin/settings/route.ts`:

```ts
    const { remindersEnabled, earlyAdoptionMode, voiceAutoCreateHighConf, voiceTtsOutcome, initData } = body;
```

Replace with:

```ts
    const { remindersEnabled, earlyAdoptionMode, voiceAutoCreateHighConf, voiceTtsOutcome, nativeRemindersEnabled, initData } = body;
```

Find in `app/api/admin/settings/route.ts`:

```ts
    const hasVoiceTts = typeof voiceTtsOutcome === 'boolean';
    if (!hasReminders && !hasEarlyAdoption && !hasVoiceAutoCreate && !hasVoiceTts) {
```

Replace with:

```ts
    const hasVoiceTts = typeof voiceTtsOutcome === 'boolean';
    const hasNativeReminders = typeof nativeRemindersEnabled === 'boolean';
    if (!hasReminders && !hasEarlyAdoption && !hasVoiceAutoCreate && !hasVoiceTts && !hasNativeReminders) {
```

Find in `app/api/admin/settings/route.ts`:

```ts
      if (hasVoiceTts) {
        updateData.voiceTtsOutcome = voiceTtsOutcome;
        createData.voiceTtsOutcome = voiceTtsOutcome;
      }
```

Replace with:

```ts
      if (hasVoiceTts) {
        updateData.voiceTtsOutcome = voiceTtsOutcome;
        createData.voiceTtsOutcome = voiceTtsOutcome;
      }
      if (hasNativeReminders) {
        updateData.nativeRemindersEnabled = nativeRemindersEnabled;
        createData.nativeRemindersEnabled = nativeRemindersEnabled;
      }
```

Find in `app/api/admin/settings/route.ts`:

```ts
        create: createData as { id: string; remindersEnabled?: boolean; earlyAdoptionMode?: boolean; voiceAutoCreateHighConf?: boolean; voiceTtsOutcome?: boolean },
```

Replace with:

```ts
        create: createData as { id: string; remindersEnabled?: boolean; earlyAdoptionMode?: boolean; voiceAutoCreateHighConf?: boolean; voiceTtsOutcome?: boolean; nativeRemindersEnabled?: boolean },
```

Find in `app/api/admin/settings/route.ts`:

```ts
      if (hasVoiceTts) {
        await setVoiceTtsOutcome(voiceTtsOutcome);
      }

      console.log(`[admin-settings] Admin ${auth.adminId} updated settings:`, { remindersEnabled, earlyAdoptionMode, voiceAutoCreateHighConf, voiceTtsOutcome });
```

Replace with:

```ts
      if (hasVoiceTts) {
        await setVoiceTtsOutcome(voiceTtsOutcome);
      }
      if (hasNativeReminders) {
        await setNativeRemindersEnabled(nativeRemindersEnabled);
      }

      console.log(`[admin-settings] Admin ${auth.adminId} updated settings:`, { remindersEnabled, earlyAdoptionMode, voiceAutoCreateHighConf, voiceTtsOutcome, nativeRemindersEnabled });
```

Find in `app/api/admin/settings/route.ts`:

```ts
        voiceTtsOutcome: settings.voiceTtsOutcome,
      });
```

Replace with:

```ts
        voiceTtsOutcome: settings.voiceTtsOutcome,
        nativeRemindersEnabled: settings.nativeRemindersEnabled,
      });
```

- [ ] **Step 7: Admin panel toggle row**

It matches the existing toggles: a full-row mobile switch, the label and description shown inline, no hover. It sits directly under the event-alerts switch.

Find in `app/[locale]/admin-panel/page.tsx`:

```tsx
      voiceTtsOutcome={adminSettings?.voiceTtsOutcome ?? false}
    />
```

Replace with:

```tsx
      voiceTtsOutcome={adminSettings?.voiceTtsOutcome ?? false}
      nativeRemindersEnabled={adminSettings?.nativeRemindersEnabled ?? true}
    />
```

Find in `app/[locale]/admin-panel/AdminPanelClient.tsx`:

```tsx
  voiceAutoCreateHighConf: boolean;
  voiceTtsOutcome: boolean;
}
```

Replace with:

```tsx
  voiceAutoCreateHighConf: boolean;
  voiceTtsOutcome: boolean;
  nativeRemindersEnabled: boolean;
}
```

Find in `app/[locale]/admin-panel/AdminPanelClient.tsx`:

```tsx
voiceTtsOutcome: initialVoiceTtsOutcome }: AdminPanelClientProps) {
```

Replace with:

```tsx
voiceTtsOutcome: initialVoiceTtsOutcome, nativeRemindersEnabled: initialNativeRemindersEnabled }: AdminPanelClientProps) {
```

Find in `app/[locale]/admin-panel/AdminPanelClient.tsx`:

```tsx
  const [voiceTtsOutcomeSaving, setVoiceTtsOutcomeSaving] = useState(false);
```

Replace with:

```tsx
  const [voiceTtsOutcomeSaving, setVoiceTtsOutcomeSaving] = useState(false);
  const [nativeRemindersEnabled, setNativeRemindersEnabled] = useState(initialNativeRemindersEnabled);
  const [nativeRemindersSaving, setNativeRemindersSaving] = useState(false);
```

Find in `app/[locale]/admin-panel/AdminPanelClient.tsx`:

```tsx
    } finally {
      setVoiceTtsOutcomeSaving(false);
    }
  };
```

Replace with:

```tsx
    } finally {
      setVoiceTtsOutcomeSaving(false);
    }
  };

  const toggleNativeReminders = async () => {
    setNativeRemindersSaving(true);
    try {
      const initData = typeof window !== 'undefined' ? window.Telegram?.WebApp?.initData : undefined;
      const response = await fetch('/api/admin/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nativeRemindersEnabled: !nativeRemindersEnabled, initData })
      });
      if (response.ok) {
        setNativeRemindersEnabled(!nativeRemindersEnabled);
      }
    } finally {
      setNativeRemindersSaving(false);
    }
  };
```

Find in `app/[locale]/admin-panel/AdminPanelClient.tsx`:

```tsx
                  if ((e.key === 'Enter' || e.key === ' ') && !remindersSaving) {
                    e.preventDefault();
                    toggleReminders();
                  }
                }}
              >
                <div className="toggle-slider" />
              </div>
            </div>
```

Replace with:

```tsx
                  if ((e.key === 'Enter' || e.key === ' ') && !remindersSaving) {
                    e.preventDefault();
                    toggleReminders();
                  }
                }}
              >
                <div className="toggle-slider" />
              </div>
            </div>
            <div className="toggle-row" style={{ marginTop: '12px' }}>
              <div className="toggle-info">
                <p className="toggle-label">{t('features.nativeReminders')}</p>
                <p className="toggle-description">{t('features.nativeRemindersDescription')}</p>
              </div>
              <div
                className={`toggle-switch ${nativeRemindersEnabled ? 'checked' : ''} ${nativeRemindersSaving ? 'disabled' : ''}`}
                onClick={() => !nativeRemindersSaving && toggleNativeReminders()}
                role="switch"
                aria-checked={nativeRemindersEnabled}
                tabIndex={0}
                onKeyDown={(e) => {
                  if ((e.key === 'Enter' || e.key === ' ') && !nativeRemindersSaving) {
                    e.preventDefault();
                    toggleNativeReminders();
                  }
                }}
              >
                <div className="toggle-slider" />
              </div>
            </div>
```

- [ ] **Step 8: English copy**

Find in `messages/en.json`:

```json
    "features": {
      "title": "Feature Toggles",
      "reminders": "Event Reminders",
      "remindersDescription": "Enable/disable reminders feature globally for all users",
      "earlyAdoption": "Early Adoption Mode",
      "earlyAdoptionDescription": "Give all users PRO access. Hides payment UI."
    },
```

Replace with:

```json
    "features": {
      "title": "Feature Toggles",
      "reminders": "Event alerts",
      "remindersDescription": "Turn event alerts (the heads-up before an event starts) on or off for everyone",
      "nativeReminders": "Reminders (built-in calendar)",
      "nativeRemindersDescription": "“Remind me…” for built-in calendar users on Telegram: made by voice or text, pinged with Done/Snooze, kept in summaries until done. Off: no new reminders and no pings.",
      "earlyAdoption": "Early Adoption Mode",
      "earlyAdoptionDescription": "Give all users PRO access. Hides payment UI."
    },
```

Find in `messages/en.json`:

```json
    "remindersSection": "Event Reminders",
    "remindersEnabled": "Enable Reminders",
    "remindersEnabledDescription": "Receive Telegram reminders before events start",
    "remindersBetaDescription": "Reminders are currently in beta (coming soon)",
    "defaultReminderMinutes": "Default Reminder Time",
    "defaultReminderMinutesHelp": "Time before event to send reminder (used when event has no reminder set)",
    "pickupRemindersEnabled": "Pickup Reminders",
    "pickupRemindersDescription": "For kids' calendars, also receive reminders at event end time (pickup)",
```

Replace with:

```json
    "remindersSection": "Event alerts",
    "remindersEnabled": "Enable event alerts",
    "remindersEnabledDescription": "Get a Telegram alert before an event starts",
    "remindersBetaDescription": "Event alerts are in beta (coming soon)",
    "defaultReminderMinutes": "Default alert time",
    "defaultReminderMinutesHelp": "How long before an event to send the alert (when the event has no alert of its own)",
    "pickupRemindersEnabled": "Pickup alerts",
    "pickupRemindersDescription": "For kids' calendars, also get an alert when the event ends (pickup)",
```

Find in `messages/en.json`:

```json
    "remindersProRequired": "Reminders require a Pro plan.",
```

Replace with:

```json
    "remindersProRequired": "Event alerts need a Pro plan.",
```

Find in `messages/en.json`:

```json
      "startOn": "Start on WhatsApp"
    }
  },
```

Replace with:

```json
      "startOn": "Start on WhatsApp"
    },
    "nativeReminders": {
      "ping": {
        "from": "from: {name}"
      },
      "buttons": {
        "done": "✅ Done",
        "snooze15": "💤 15 min",
        "snooze60": "💤 1 hour",
        "snoozeTomorrow": "💤 Tomorrow"
      },
      "done": "✅ {title}",
      "snoozedUntil": "💤 {title} · until {time}",
      "alreadyDone": "Already done 👍",
      "notYours": "This reminder isn't yours.",
      "changed": "This reminder changed or no longer exists.",
      "doneBy": "✅ Done by {name}: {title}",
      "moved": "⏰ {title} · moved to {when}",
      "card": {
        "title": "⏰ {title}",
        "forPartner": "for {name}",
        "noTimeSet": "No time set; it'll be in your summaries.",
        "partnerNotOnTelegram": "{name} isn't on Telegram, so I can't ping them. Keep it as yours?",
        "keepAsMine": "Keep as mine"
      },
      "created": {
        "self": "⏰ I'll remind you {when}.",
        "partner": "⏰ I'll remind {name} {when}.",
        "dateOnly": "⏰ Reminder set for {when}."
      },
      "when": {
        "todayAt": "today at {time}",
        "tomorrowAt": "tomorrow at {time}",
        "dateAt": "on {date} at {time}",
        "today": "today",
        "tomorrow": "tomorrow",
        "date": "{date}"
      },
      "typed": {
        "processing": "⏰ On it…",
        "notUnderstood": "I couldn't find a reminder in that. Try: “remind me to call mom tomorrow at 5”."
      },
      "anchor": {
        "notFound": "I couldn't find “{description}” in your calendar. When should I remind you?",
        "ambiguous": "I found more than one “{description}”. Which one, or what time?",
        "needsTime": "“{description}” is all day. What time should I remind you?"
      },
      "permissionDenied": "You can't change this one."
    }
  },
```

- [ ] **Step 9: Hebrew copy** (gender-neutral: noun forms, the infinitive, "ע״י", and no gendered verbs about the user or the partner)

Find in `messages/he.json`:

```json
    "features": {
      "title": "מתגי תכונות",
      "reminders": "תזכורות לאירועים",
      "remindersDescription": "הפעל/השבת תזכורות באופן גלובלי לכל המשתמשים",
      "earlyAdoption": "מצב אימוץ מוקדם",
      "earlyAdoptionDescription": "תן לכל המשתמשים גישת PRO. מסתיר ממשק תשלום."
    },
```

Replace with:

```json
    "features": {
      "title": "מתגי תכונות",
      "reminders": "התראות על אירועים",
      "remindersDescription": "הפעלה או כיבוי של ההתראה לפני תחילת אירוע, לכל המשתמשים",
      "nativeReminders": "תזכורות (יומן מובנה)",
      "nativeRemindersDescription": "\"תזכיר לי…\" למשתמשי היומן המובנה בטלגרם: יצירה בקול או בטקסט, שליחה עם כפתורי בוצע/נודניק, והצגה בסיכומים עד הסימון כבוצע. כבוי: אין תזכורות חדשות ואין שליחות.",
      "earlyAdoption": "מצב אימוץ מוקדם",
      "earlyAdoptionDescription": "תן לכל המשתמשים גישת PRO. מסתיר ממשק תשלום."
    },
```

Find in `messages/he.json`:

```json
    "remindersSection": "תזכורות לאירועים",
    "remindersEnabled": "הפעל תזכורות",
    "remindersEnabledDescription": "קבל תזכורות בטלגרם לפני תחילת האירועים",
    "remindersBetaDescription": "תזכורות נמצאות כרגע בבטא (בקרוב)",
    "defaultReminderMinutes": "זמן תזכורת ברירת מחדל",
    "defaultReminderMinutesHelp": "זמן לפני אירוע לשליחת תזכורת (בשימוש כשאין תזכורת מוגדרת לאירוע)",
    "pickupRemindersEnabled": "תזכורות איסוף",
    "pickupRemindersDescription": "ליומנים של ילדים, קבל גם תזכורות בזמן סיום האירוע (איסוף)",
```

Replace with:

```json
    "remindersSection": "התראות על אירועים",
    "remindersEnabled": "הפעלת התראות על אירועים",
    "remindersEnabledDescription": "התראה בטלגרם לפני שאירוע מתחיל",
    "remindersBetaDescription": "התראות על אירועים עדיין בבטא (בקרוב)",
    "defaultReminderMinutes": "זמן התראה ברירת מחדל",
    "defaultReminderMinutesHelp": "כמה זמן לפני האירוע לשלוח התראה (כשלאירוע אין התראה משלו)",
    "pickupRemindersEnabled": "התראות איסוף",
    "pickupRemindersDescription": "ביומני ילדים, גם התראה בשעת סיום האירוע (איסוף)",
```

Find in `messages/he.json`:

```json
    "remindersProRequired": "תזכורות דורשות תוכנית Pro.",
```

Replace with:

```json
    "remindersProRequired": "התראות על אירועים זמינות בתוכנית Pro.",
```

Find in `messages/he.json`:

```json
      "startOn": "התחילו בוואטסאפ"
    }
  },
```

Replace with:

```json
      "startOn": "התחילו בוואטסאפ"
    },
    "nativeReminders": {
      "ping": {
        "from": "מאת: {name}"
      },
      "buttons": {
        "done": "✅ בוצע",
        "snooze15": "💤 עוד 15 דק׳",
        "snooze60": "💤 עוד שעה",
        "snoozeTomorrow": "💤 מחר"
      },
      "done": "✅ {title}",
      "snoozedUntil": "💤 {title} · עד {time}",
      "alreadyDone": "כבר בוצע 👍",
      "notYours": "התזכורת הזו לא שלך.",
      "changed": "התזכורת הזו השתנתה או שכבר לא קיימת.",
      "doneBy": "✅ בוצע ע״י {name}: {title}",
      "moved": "⏰ {title} · זמן חדש: {when}",
      "card": {
        "title": "⏰ {title}",
        "forPartner": "בשביל {name}",
        "noTimeSet": "בלי שעה מסוימת, אז זה יופיע בסיכומים היומיים.",
        "partnerNotOnTelegram": "{name} לא בטלגרם, אז אין לי איך לשלוח תזכורת. להשאיר אותה אצלך?",
        "keepAsMine": "להשאיר אצלי"
      },
      "created": {
        "self": "⏰ אזכיר לך {when}.",
        "partner": "⏰ אזכיר ל-{name} {when}.",
        "dateOnly": "⏰ התזכורת נקבעה ל{when}."
      },
      "when": {
        "todayAt": "היום ב-{time}",
        "tomorrowAt": "מחר ב-{time}",
        "dateAt": "ב{date}, ב-{time}",
        "today": "היום",
        "tomorrow": "מחר",
        "date": "{date}"
      },
      "typed": {
        "processing": "⏰ רגע…",
        "notUnderstood": "לא מצאתי פה תזכורת. אפשר לנסות למשל: \"תזכיר לי להתקשר לאמא מחר ב-5\"."
      },
      "anchor": {
        "notFound": "לא מצאתי את \"{description}\" ביומן. מתי להזכיר לך?",
        "ambiguous": "מצאתי כמה התאמות ל\"{description}\". איזו מהן, או באיזו שעה להזכיר?",
        "needsTime": "\"{description}\" הוא אירוע של יום שלם. באיזו שעה להזכיר לך?"
      },
      "permissionDenied": "אין לך הרשאה לשנות את זה."
    }
  },
```

- [ ] **Step 10: Russian copy** (gender-neutral: present tense, the impersonal, colon forms; `{name}` is never declined)

Find in `messages/ru.json`:

```json
    "features": {
      "title": "Переключатели функций",
      "reminders": "Напоминания о событиях",
      "remindersDescription": "Включить/отключить напоминания глобально для всех пользователей",
      "earlyAdoption": "Режим раннего доступа",
      "earlyAdoptionDescription": "Дать всем пользователям PRO-доступ. Скрывает интерфейс оплаты."
    },
```

Replace with:

```json
    "features": {
      "title": "Переключатели функций",
      "reminders": "Уведомления о событиях",
      "remindersDescription": "Включить или выключить уведомление перед началом события для всех",
      "nativeReminders": "Напоминания (встроенный календарь)",
      "nativeRemindersDescription": "«Напомни мне…» для пользователей встроенного календаря в Telegram: голосом или текстом, пинг с кнопками «Готово»/«Отложить», в сводках до отметки «готово». Выкл.: ни новых напоминаний, ни пингов.",
      "earlyAdoption": "Режим раннего доступа",
      "earlyAdoptionDescription": "Дать всем пользователям PRO-доступ. Скрывает интерфейс оплаты."
    },
```

Find in `messages/ru.json`:

```json
    "remindersSection": "Напоминания о событиях",
    "remindersEnabled": "Включить напоминания",
    "remindersEnabledDescription": "Получать напоминания в Telegram перед началом событий",
    "remindersBetaDescription": "Напоминания находятся в бета-тестировании (скоро)",
    "defaultReminderMinutes": "Время напоминания по умолчанию",
    "defaultReminderMinutesHelp": "Время до события для отправки напоминания (используется, если у события нет напоминания)",
    "pickupRemindersEnabled": "Напоминания о заборе",
    "pickupRemindersDescription": "Для детских календарей также получать напоминания в конце события",
```

Replace with:

```json
    "remindersSection": "Уведомления о событиях",
    "remindersEnabled": "Включить уведомления о событиях",
    "remindersEnabledDescription": "Уведомление в Telegram перед началом события",
    "remindersBetaDescription": "Уведомления о событиях пока в бете (скоро)",
    "defaultReminderMinutes": "Время уведомления по умолчанию",
    "defaultReminderMinutesHelp": "За сколько до события присылать уведомление (если у события нет своего)",
    "pickupRemindersEnabled": "Уведомления о заборе детей",
    "pickupRemindersDescription": "Для детских календарей ещё и уведомление в конце события (пора забирать)",
```

Find in `messages/ru.json`:

```json
    "remindersProRequired": "Напоминания требуют план Pro.",
```

Replace with:

```json
    "remindersProRequired": "Уведомления о событиях доступны в плане Pro.",
```

Find in `messages/ru.json`:

```json
      "startOn": "Начать в WhatsApp"
    }
  },
```

Replace with:

```json
      "startOn": "Начать в WhatsApp"
    },
    "nativeReminders": {
      "ping": {
        "from": "от: {name}"
      },
      "buttons": {
        "done": "✅ Готово",
        "snooze15": "💤 15 мин",
        "snooze60": "💤 1 час",
        "snoozeTomorrow": "💤 Завтра"
      },
      "done": "✅ {title}",
      "snoozedUntil": "💤 {title} · до {time}",
      "alreadyDone": "Уже сделано 👍",
      "notYours": "Это напоминание не для тебя.",
      "changed": "Это напоминание изменилось или его больше нет.",
      "doneBy": "✅ {name}: готово — {title}",
      "moved": "⏰ {title} · перенесено на {when}",
      "card": {
        "title": "⏰ {title}",
        "forPartner": "кому: {name}",
        "noTimeSet": "Без точного времени, зато будет в твоих сводках.",
        "partnerNotOnTelegram": "{name} не пользуется Telegram, так что напомнить не получится. Оставить напоминание себе?",
        "keepAsMine": "Оставить себе"
      },
      "created": {
        "self": "⏰ Напомню тебе {when}.",
        "partner": "⏰ {name} получит напоминание {when}.",
        "dateOnly": "⏰ Напоминание на {when} поставлено."
      },
      "when": {
        "todayAt": "сегодня в {time}",
        "tomorrowAt": "завтра в {time}",
        "dateAt": "{date} в {time}",
        "today": "сегодня",
        "tomorrow": "завтра",
        "date": "{date}"
      },
      "typed": {
        "processing": "⏰ Секунду…",
        "notUnderstood": "Не вижу тут напоминания. Попробуй так: «напомни мне позвонить маме завтра в 5»."
      },
      "anchor": {
        "notFound": "Не вижу «{description}» в календаре. Когда напомнить?",
        "ambiguous": "Нашлось несколько «{description}». Какое из них — или во сколько напомнить?",
        "needsTime": "«{description}» — на весь день. Во сколько напомнить?"
      },
      "permissionDenied": "Это изменить не получится."
    }
  },
```

- [ ] **Step 11: Run tests to verify they pass**

```bash
npx tsx scripts/smoke-native-reminder-support.ts
npx tsx scripts/check-i18n-parity.ts
TELEGRAM_BOT_TOKEN=test-token UPSTASH_REDIS_REST_URL=https://redis.invalid UPSTASH_REDIS_REST_TOKEN=test DATABASE_URL=postgresql://test@db.invalid/test npx tsx scripts/smoke-admin-settings-auth.ts
npx tsc --noEmit -p .
npm run -s lint
```

The smoke tests touch no clock, so one run is enough. The admin-auth smoke is run with fake env values instead of `-r dotenv/config`, so it can't reach a real database.

Expected:
- `smoke-native-reminder-support.ts`: 30 `OK` lines, then `30/30 passed`, exit 0.
- `check-i18n-parity.ts`: `i18n parity OK (852 keys)`, which is 818 + 32 `bot.nativeReminders` + 2 `admin.features` keys.
- `smoke-admin-settings-auth.ts`: `3/3 passed`. Its `[TelegramAuth] Hash mismatch` log line is expected.
- `tsc` and `lint`: no output, exit 0.

If `tsc` reports `Property 'nativeRemindersEnabled' does not exist`, Task 1's schema field or `npx prisma generate` is missing. Run `npx prisma generate`, then type-check again.

- [ ] **Step 12: Commit**

```bash
git add src/services/native-reminders/support.ts src/utils/html.ts src/config/redis-keys.ts src/services/voice/confirmations.ts \
  app/api/admin/settings/route.ts 'app/[locale]/admin-panel/page.tsx' 'app/[locale]/admin-panel/AdminPanelClient.tsx' \
  messages/en.json messages/he.json messages/ru.json \
  scripts/check-i18n-parity.ts scripts/smoke-native-reminder-support.ts
git commit -F - <<'EOF'
feat(reminders): admin switch, support gate and copy

getReminderSupport() is the one R3 gate: built-in calendar, a Telegram
account, the new admin switch and the creator's 'reminders' access,
checked cheapest first. The switch lives in AdminSettings, read through
Redis at nrem:enabled and on by default. The admin panel toggles it; the
settings route writes the DB, then Redis, and reopens the due gate.

Adds every bot.nativeReminders key in en/he/ru, the created reply's
today/tomorrow wording included, and a parity check for the three
message files. escapeHtml moves to the leaf src/utils/html.ts, so the
cron passes can escape without loading the voice chain; confirmations.ts
re-exports it. The settings page's event-alert copy now says "Event
alerts" (R9).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
EOF
```

---

### Task 5: Native provider carries reminders; event alerts skip them

**Files:**
- Modify: `src/types.ts:83-95` — `CalendarEvent.eventType` comment names `'reminder'`; `CalendarEvent` gains `reminder?: ReminderInfo`; new exported `ReminderInfo` interface right after `CalendarEvent`.
- Modify: `src/services/calendar-provider/types.ts:37-45` — `CreateEventInput` gains the native-only `kind?: 'event' | 'reminder'` and `forUserId?: number | null` (the Google provider maps its fields one by one at `google-provider.ts:85-95`, so it ignores both with no change).
- Modify: `src/services/native-calendar/event-store.ts:128-196` (the whole `fetchEventsInCalendars` function with its doc comment; Task 2 may shift the line numbers, it does not touch this function) — split into the private `rangeCandidates(range)` and `expandCandidates(series, calendarsById, range)` with identical queries and output, export the row type `NativeEventRow`, and add `fetchRemindersForUserInRange`, `ReminderStateRow` and `fetchReminderStates`.
- Modify: `src/services/calendar-provider/native-provider.ts:7-8, 20-37` (imports), `:52-100` (`toUnifiedEvent` takes `series?` and `info?`; new exported `reminderInfoFor` and private `occurrenceKey`, `rowEventId`, `mergeRows`, `toViewerEvents`, `fetchForViewer` after it), `:142-170` (the three fetchers go through `fetchForViewer`), `:197-210` (`createEvent` passes `kind` and `forUserId`).
- Modify: `src/services/reminders.ts:18-20` (imports, `escapeHtml` from `../utils/html`), `:172-176` (`getDueReminders` skips `eventType === 'reminder'`), `:252-290` (`formatReminderMessage` escapes title, calendar name and place), `:346-350` (`sendReminder` marks a 403 user unreachable).
- Modify: `scripts/smoke-reminders.ts` — the fake native store hands over `series` (with `kind`) and `fetchReminderStates`; the fake Prisma gets `user.updateMany`; the Telegram recorder can fail; `captureError` records its contexts; three new checks.
- Create: `scripts/smoke-native-provider-reminders.ts` — `toUnifiedEvent` and `reminderInfoFor` for reminders, and the provider's range fetch (supplementary partner reminders, dedupe, states, all viewer/creator/for combinations, unlink, Google partner, query cost) against the real store and ownership helpers over an in-memory Prisma.
- Test: `scripts/smoke-native-provider-reminders.ts`, `scripts/smoke-reminders.ts`.

**Interfaces:**
- Consumes:
  - Task 1, `src/services/native-reminders/ownership.ts`: `interface ViewerContext { viewerId: number; partner: PartnerSummary | null }`, `loadViewerContext(user: { id: number; pairingId: string | null }): Promise<ViewerContext>` (no query when `pairingId` is null), `effectiveOwnerForViewer(series: { creatorUserId: number; forUserId: number | null }, ctx: ViewerContext): number`. Prisma after Task 1: `NativeEvent.kind: 'EVENT' | 'REMINDER'`, `NativeEvent.forUserId: number | null`, `NativeEvent.armedAt: Date | null`, the `prisma.nativeReminderState` delegate, the `NativeReminderState` type.
  - Task 2, `src/services/native-calendar/event-store.ts`: `CreateNativeEventInput` has `kind?: 'EVENT' | 'REMINDER'; forUserId?: number | null`, and `createNativeEvent` writes `kind` (default `EVENT`) and `forUserId` (null unless REMINDER).
  - Task 4, `src/utils/html.ts`: `export function escapeHtml(text: string): string` (`src/services/voice/confirmations.ts` re-exports it). `reminders.ts` imports it from `../utils/html`, so the alert cron does not load the voice chain.
- Produces:
  ```ts
  // src/types.ts
  export interface ReminderInfo {
    ownerIsViewer: boolean; creatorIsViewer: boolean; ownerName?: string; creatorName?: string;
    done?: boolean; snoozed?: boolean; open?: boolean; openSince?: string;
  }
  // CalendarEvent gains:  reminder?: ReminderInfo;   // present iff eventType === 'reminder'

  // src/services/calendar-provider/types.ts
  // CreateEventInput gains (native-only; Google ignores):  kind?: 'event' | 'reminder'; forUserId?: number | null;

  // src/services/native-calendar/event-store.ts
  export interface NativeEventRow { calendar: NativeCalendar; series: NativeEvent; instance: VirtualInstance }
  export async function fetchEventsInCalendars(calendarCuids: string[], range: FetchRange): Promise<NativeEventRow[]>; // same rows as before
  export async function fetchRemindersForUserInRange(forUserId: number, creatorUserId: number, range: FetchRange): Promise<NativeEventRow[]>;
  export interface ReminderStateRow { seriesEventId: string; originalStartsAt: Date; doneAt: Date | null; snoozedUntil: Date | null }
  export async function fetchReminderStates(occurrences: Array<{ seriesEventId: string; originalStartsAt: Date }>): Promise<ReminderStateRow[]>;

  // src/services/calendar-provider/native-provider.ts
  export function toUnifiedEvent(
    calendar: { id: string; name: string },
    instance: { title; description?; location?; startsAt; endsAt; allDay; timeZone; seriesEventId; instanceStartsAt; isRecurringInstance },
    series?: Pick<NativeEvent, 'kind'>,
    info?: ReminderInfo   // REMINDER without info → { ownerIsViewer: true, creatorIsViewer: true }
  ): UnifiedEvent;
  export function reminderInfoFor(
    series: { creatorUserId: number; forUserId: number | null },
    state: Pick<ReminderStateRow, 'doneAt' | 'snoozedUntil'> | undefined,
    ctx: ViewerContext,
    now: Date
  ): ReminderInfo; // done and snoozed always set (booleans); ownerName/creatorName only when not the viewer
  ```
  Behaviour later tasks rely on:
  - A REMINDER occurrence comes out of `fetchTodayEvents` / `fetchTomorrowEvents` / `fetchEventsInRange` with `eventType: 'reminder'` and `reminder` set. A timed one has `end === start` (ISO). A date-only one has `start = 'yyyy-MM-dd'` and `end` = the next day.
  - A partner's reminder for the viewer is included even when its calendar is PRIVATE or not among the `calendarIds` passed in, so its `calendarId` can be a calendar that is not in the viewer's assignments. Task 7 must file reminders by `reminder.ownerIsViewer`, never by calendar label.
  - Non-reminder events are unchanged: same fields and no `reminder` key.
  - `getDueReminders` never returns an alert for an `eventType === 'reminder'` event. Task 7 may swap the literal check for `isReminderEvent`.

- [ ] **Step 1: Write the failing tests**

**1a. Extend `scripts/smoke-reminders.ts`.** Make these edits in order.

Find the end of the header comment:
```ts
// own day while the run fetched today. No network.
```
Replace with:
```ts
// own day while the run fetched today. A built-in calendar reminder got an alert as well
// as its own ping, a "<" or "&" in a title made Telegram refuse the alert, and a user who
// blocked the bot was retried every five minutes. No network.
```

Find the fake Prisma's `user` table:
```ts
const fakePrisma = {
  user: {
    findMany: async ({ where = {}, select }: { where?: Record<string, unknown>; select: Record<string, boolean> }) =>
      userRows
        .filter(row => Object.keys(where).every(k => where[k] !== null || row[k] == null))
        .map(row => Object.fromEntries(Object.keys(select).filter(k => select[k]).map(k => [k, row[k]]))),
  },
```
Replace with:
```ts
const fakePrisma = {
  user: {
    findMany: async ({ where = {}, select }: { where?: Record<string, unknown>; select: Record<string, boolean> }) =>
      userRows
        .filter(row => Object.keys(where).every(k => where[k] !== null || row[k] == null))
        .map(row => Object.fromEntries(Object.keys(select).filter(k => select[k]).map(k => [k, row[k]]))),
    // markUserUnreachable: the id, and the columns it requires to be null.
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const rows = userRows.filter(row => Object.keys(where).every(k => (where[k] === null ? row[k] == null : row[k] === where[k])));
      for (const row of rows) Object.assign(row, data);
      return { count: rows.length };
    },
  },
```

Find:
```ts
type GoogleEvent = { calendarId: string; id: string; summary: string; start: Date; end: Date; reminder?: number | number[] };
```
Replace with:
```ts
type GoogleEvent = { calendarId: string; id: string; summary: string; start: Date; end: Date; location?: string; reminder?: number | number[] };
```

Find (inside `fakeGoogle.events.list`):
```ts
              id: e.id, summary: e.summary, start: { dateTime: e.start.toISOString() }, end: { dateTime: e.end.toISOString() },
```
Replace with:
```ts
              id: e.id, summary: e.summary, start: { dateTime: e.start.toISOString() }, end: { dateTime: e.end.toISOString() }, location: e.location,
```

Find:
```ts
/** A native calendar event (one-off), as the event store hands it to the native provider. */
type NativeRow = { calendarId: string; id: string; title: string; startsAt: Date; endsAt: Date; timeZone: string };
```
Replace with:
```ts
/** A native calendar event (one-off), as the event store hands it to the native provider; a REMINDER has no length. */
type NativeRow = { calendarId: string; id: string; title: string; startsAt: Date; endsAt: Date; timeZone: string; kind?: 'EVENT' | 'REMINDER' };
```

Find:
```ts
type Sent = { at: number; chatId: number; text: string };
let sent: Sent[] = [];
const recorder = { sendMessage: async (chatId: number, text: string) => { sent.push({ at: clock, chatId, text }); } };
```
Replace with:
```ts
type Sent = { at: number; chatId: number; text: string };
let sent: Sent[] = [];
/** When set, every Telegram send fails with it, as for a user who blocked the bot. */
let sendError: Error | null = null;
let sendAttempts = 0;
const recorder = {
  sendMessage: async (chatId: number, text: string) => {
    sendAttempts++;
    if (sendError) throw sendError;
    sent.push({ at: clock, chatId, text });
  },
};
/** The contexts captureError was called with. */
let captured: string[] = [];
```

Find:
```ts
  [`${SRC}/lib/error-capture.ts`]: { captureError: () => {}, captureWarning: () => {}, captureInfo: () => {} },
```
Replace with:
```ts
  [`${SRC}/lib/error-capture.ts`]: {
    captureError: (_error: unknown, context: string) => { captured.push(context); },
    captureWarning: () => {},
    captureInfo: () => {},
  },
```

Find the fake store's `fetchEventsInCalendars` (the provider now reads each row's `series`). After Task 2 the stub opens with `real => fakeOver(real, {` rather than `...real,`; the lines below sit inside it unchanged, and `fetchReminderStates` goes in as one more fake beside `fetchEventsInCalendars`:
```ts
        .map(e => ({
          calendar: nativeCalendars.find(c => c.id === e.calendarId)!,
          instance: {
            title: e.title, startsAt: e.startsAt, endsAt: e.endsAt, allDay: false, timeZone: e.timeZone,
            seriesEventId: e.id, instanceStartsAt: e.startsAt, isRecurringInstance: false,
          },
        })),
  }),
```
Replace with:
```ts
        .map(e => ({
          calendar: nativeCalendars.find(c => c.id === e.calendarId)!,
          series: { id: e.id, kind: e.kind ?? 'EVENT', creatorUserId: 0, forUserId: null },
          instance: {
            title: e.title, startsAt: e.startsAt, endsAt: e.endsAt, allDay: false, timeZone: e.timeZone,
            seriesEventId: e.id, instanceStartsAt: e.startsAt, isRecurringInstance: false,
          },
        })),
    // Nothing done or snoozed.
    fetchReminderStates: async () => [],
  }),
```

Find:
```ts
function reset(row: Partial<UserRow> & { id: number }) {
  store.clear();
  sent = [];
```
Replace with:
```ts
function reset(row: Partial<UserRow> & { id: number }) {
  store.clear();
  sent = [];
  sendError = null;
  sendAttempts = 0;
  captured = [];
```

Find the results printout at the end of `main()`:
```ts
  let failed = 0;
  for (const r of results) {
```
Insert these three checks right before it (keep the two found lines after them):
```ts
  await check('a built-in calendar reminder gets no event alert, neither a start nor a pickup one', async () => {
    reset({ id: 17, calendarSource: 'NATIVE', googleRefreshToken: '', calendarAssignments: null });
    nativeCalendars = [{ id: 'cal17', name: 'Leo', labels: ['kids'] }];
    nativeEvents = [
      // It pings through its own pass; here it would get a start alert and, on a kids calendar, a pickup one.
      { calendarId: 'cal17', id: 'r17', kind: 'REMINDER', title: 'Call the plumber', startsAt: at('2026-10-13 08:00', IL), endsAt: at('2026-10-13 08:00', IL), timeZone: IL },
      { calendarId: 'cal17', id: 'n17', title: 'Swim', startsAt: at('2026-10-13 10:00', IL), endsAt: at('2026-10-13 11:00', IL), timeZone: IL },
    ];
    await syncCache(handlers, at('2026-10-13 07:00', IL));
    await runTicks(handlers, at('2026-10-13 07:00', IL), at('2026-10-13 12:00', IL));
    const lines = sentLines(IL);
    assert(lines.join(' | ') === '09:45 🤖 Auto-Reminder: Swim | 10:45 🤖🚗 Auto-Pickup Reminder: Leo', `got ${lines.join(' | ') || '(nothing)'}`);
  });

  await check('titles, calendar names and places are escaped for Telegram\'s HTML', async () => {
    reset({ id: 18, calendarAssignments: [{ calendarId: kidsCal, labels: ['kids'], name: 'Noa & Leo', color: '#f00' }] });
    await fakeRedis.set(REDIS_KEYS.userTimezone(18), IL);
    googleEvents = [{
      calendarId: kidsCal, id: 'k18', summary: 'Tom & Jerry <live>', location: 'Hall <B>',
      start: at('2026-10-13 10:00', IL), end: at('2026-10-13 11:00', IL),
    }];
    await syncCache(handlers, at('2026-10-13 09:00', IL));
    await runTicks(handlers, at('2026-10-13 09:00', IL), at('2026-10-13 12:00', IL));
    assert(sent.length === 2, `sent ${sent.length}: ${sentLines(IL).join(' | ')}`);
    assert(sent[0].text === '🤖 <b>Auto-Reminder: Tom &amp; Jerry &lt;live&gt;</b>\n📅 Noa &amp; Leo\n⏰ Starting at 10:00\n📍 Hall &lt;B&gt;', `start ${JSON.stringify(sent[0].text)}`);
    assert(sent[1].text.startsWith('🤖🚗 <b>Auto-Pickup Reminder: Noa &amp; Leo</b>'), `pickup ${JSON.stringify(sent[1].text)}`);
  });

  await check('a user who blocked the bot is marked unreachable, quietly, and the next sync leaves them out', async () => {
    reset({ id: 19 });
    await fakeRedis.set(REDIS_KEYS.userTimezone(19), IL);
    googleEvents = [{ calendarId: kidsCal, id: 'k19', summary: 'Kindergarten', start: at('2026-10-13 08:00', IL), end: at('2026-10-13 16:00', IL) }];
    sendError = Object.assign(new Error('ETELEGRAM: 403 Forbidden: bot was blocked by the user'), {
      code: 'ETELEGRAM',
      response: { body: { error_code: 403, description: 'Forbidden: bot was blocked by the user' } },
    });
    await syncCache(handlers, at('2026-10-13 07:00', IL));
    await runTicks(handlers, at('2026-10-13 07:40', IL), at('2026-10-13 07:50', IL));
    assert(sendAttempts === 1, `${sendAttempts} send attempts`);
    assert(userRows[0].unreachableSince instanceof RealDate, `unreachableSince ${String(userRows[0].unreachableSince)}`);
    assert(!captured.includes('reminders-send'), `captured ${captured.join(', ')}`);
    await syncCache(handlers, at('2026-10-13 08:00', IL));
    await runTicks(handlers, at('2026-10-13 08:00', IL), at('2026-10-13 17:00', IL));
    assert(sendAttempts === 1, `tried again: ${sendAttempts} send attempts`);
  });
```

**1b. Create `scripts/smoke-native-provider-reminders.ts`:**
```ts
// Smoke test for reminders in the native provider (src/services/calendar-provider/native-provider.ts).
// A reminder is a NativeEvent of kind REMINDER: the provider hands it on as eventType
// 'reminder' with the viewer's side of it (whose it is, who set it, done or snoozed). A
// partner's reminder for the viewer shows on its day even from the partner's PRIVATE
// calendar, and only once when the viewer can see that calendar too. The real event
// store and ownership helpers run against an in-memory Prisma. No network.
//
// Run under both clocks; the output must not depend on the server's timezone:
//   TZ=UTC npx tsx scripts/smoke-native-provider-reminders.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-native-provider-reminders.ts

import path from 'path';
import { fromZonedTime } from 'date-fns-tz';
import type { NativeCalendar, NativeEvent, NativeReminderState } from '@prisma/client';
import type { CalendarEvent, ReminderInfo, UserConfig } from '../src/types';
import type { ViewerContext } from '../src/services/native-reminders/ownership';

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
}

function assert(cond: boolean, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

function assertList(got: string[], want: string[]) {
  assert(JSON.stringify(got) === JSON.stringify(want), `\n     got  ${JSON.stringify(got, null, 1)}\n     want ${JSON.stringify(want, null, 1)}`);
}

const IL = 'Asia/Jerusalem';
const NY = 'America/New_York';
const at = (local: string, tz = IL) => fromZonedTime(local, tz);

// ---- In-memory Prisma: the where-clause operators the store and the ownership helpers use ----

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

const same = (a: unknown, b: unknown) => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b);

function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as Where[]).some((w) => matches(row, w));
    if (key === 'AND') return (cond as Where[]).every((w) => matches(row, w));
    const value = row[key];
    if (cond === null || typeof cond !== 'object' || cond instanceof Date) return same(value, cond);
    return Object.entries(cond as Where).every(([op, arg]) => {
      switch (op) {
        case 'in': return (arg as unknown[]).some((a) => same(a, value));
        case 'not': return !same(value, arg);
        case 'lt': return value != null && (value as Date) < (arg as Date);
        case 'lte': return value != null && (value as Date) <= (arg as Date);
        case 'gt': return value != null && (value as Date) > (arg as Date);
        case 'gte': return value != null && (value as Date) >= (arg as Date);
        default: throw new Error(`stand-in Prisma does not know '${op}'`);
      }
    });
  });
}

/** Prisma returns only the selected columns. */
const pick = (row: Row, select?: Record<string, boolean>) =>
  select ? Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]])) : { ...row };

/** Every query, as "<model>.<method>", to see what a fetch costs. */
const queries: string[] = [];

function table(name: string, rows: () => Row[]) {
  return {
    findMany: async ({ where = {}, select }: { where?: Where; select?: Record<string, boolean> } = {}) => {
      queries.push(`${name}.findMany`);
      return rows().filter((r) => matches(r, where)).map((r) => pick(r, select));
    },
    findUnique: async ({ where, select }: { where: Where; select?: Record<string, boolean> }) => {
      queries.push(`${name}.findUnique`);
      const row = rows().find((r) => matches(r, where));
      return row ? pick(row, select) : null;
    },
    create: async ({ data }: { data: Row }) => {
      queries.push(`${name}.create`);
      const row = { id: `${name}-${rows().length + 1}`, ...data };
      rows().push(row);
      return row;
    },
  };
}

const db = {
  users: [] as Row[],
  pairings: [] as Row[],
  calendars: [] as Row[],
  events: [] as Row[],
  instances: [] as Row[],
  states: [] as Row[],
};

const fakePrisma = {
  user: table('user', () => db.users),
  pairing: table('pairing', () => db.pairings),
  nativeCalendar: table('nativeCalendar', () => db.calendars),
  nativeEvent: table('nativeEvent', () => db.events),
  nativeEventInstance: table('nativeEventInstance', () => db.instances),
  nativeReminderState: table('nativeReminderState', () => db.states),
};

// ---- The household: Dana and Raziel, paired; Noam on his own ----

const DANA = 1;
const RAZIEL = 2;
const NOAM = 3;
const CREATED = at('2026-10-01 09:00');

function calendar(fields: Partial<NativeCalendar> & Pick<NativeCalendar, 'id' | 'ownerUserId' | 'name'>): NativeCalendar {
  return {
    color: '#039BE5', labels: ['yours'], personName: null, personEnglishName: null, personGender: null, rules: [],
    privacy: 'PRIVATE', isDeleted: false, createdAt: CREATED, updatedAt: CREATED,
    ...fields,
  };
}

function event(fields: Partial<NativeEvent> & Pick<NativeEvent, 'id' | 'calendarId' | 'creatorUserId' | 'title' | 'startsAt'>): NativeEvent {
  return {
    description: null, location: null, endsAt: fields.startsAt, allDay: false, timeZone: IL, rrule: null, exdates: [],
    reminderMinutes: null, isDeleted: false, createdAt: CREATED, updatedAt: CREATED,
    kind: 'EVENT', forUserId: null, armedAt: null,
    ...fields,
  };
}

/** A reminder has no length: it ends where it starts. */
const reminder = (fields: Parameters<typeof event>[0]) => event({ kind: 'REMINDER', armedAt: CREATED, ...fields, endsAt: fields.startsAt });

function state(fields: Partial<NativeReminderState> & Pick<NativeReminderState, 'seriesEventId' | 'originalStartsAt'>): NativeReminderState {
  return {
    id: `state-${fields.seriesEventId}-${fields.originalStartsAt.getTime()}`, doneAt: null, doneByUserId: null, snoozedUntil: null,
    lastPingedAt: null, pingAttempts: 0, pingChatId: null, pingMessageId: null, createdAt: CREATED, updatedAt: CREATED,
    ...fields,
  };
}

const user = (id: number, name: string, extra: Row = {}) =>
  ({ id, name, englishName: name, gender: 'female', calendarSource: 'NATIVE', telegramId: BigInt(1000 + id), language: 'en', pairingId: null, ...extra });

/** Each check starts from this household. */
function household() {
  db.users = [
    user(DANA, 'Dana', { pairingId: 'pair-1' }),
    user(RAZIEL, 'Raziel', { gender: 'male', pairingId: 'pair-1' }),
    user(NOAM, 'Noam', { gender: 'male' }),
  ];
  db.pairings = [{ id: 'pair-1', status: 'ACTIVE', inviterUserId: RAZIEL, inviteeUserId: DANA }];
  db.calendars = [
    calendar({ id: 'cal-dana', ownerUserId: DANA, name: 'Dana', labels: ['primary', 'yours'], privacy: 'SHARED_EDITOR' }),
    calendar({ id: 'cal-raz', ownerUserId: RAZIEL, name: 'Raziel', labels: ['primary', 'yours'] }),
    calendar({ id: 'cal-raz-family', ownerUserId: RAZIEL, name: 'Family', labels: ['kids'], privacy: 'SHARED_EDITOR' }),
    calendar({ id: 'cal-raz-old', ownerUserId: RAZIEL, name: 'Old', isDeleted: true }),
    calendar({ id: 'cal-noam', ownerUserId: NOAM, name: 'Noam' }),
  ];
  db.events = [
    event({ id: 'ev-dentist', calendarId: 'cal-dana', creatorUserId: DANA, title: 'Dentist', startsAt: at('2026-10-13 10:00'), endsAt: at('2026-10-13 11:00') }),
    reminder({ id: 'rem-plants', calendarId: 'cal-dana', creatorUserId: DANA, title: 'Water the plants', startsAt: at('2026-10-13 00:00'), allDay: true }),
    reminder({ id: 'rem-bank', calendarId: 'cal-dana', creatorUserId: DANA, forUserId: RAZIEL, title: 'Call the bank', startsAt: at('2026-10-13 15:00') }),
    // Raziel's, on his PRIVATE calendar: Dana sees only the ones for her.
    reminder({ id: 'rem-milk', calendarId: 'cal-raz', creatorUserId: RAZIEL, forUserId: DANA, title: 'Buy milk', startsAt: at('2026-10-13 17:00') }),
    reminder({ id: 'rem-raz-own', calendarId: 'cal-raz', creatorUserId: RAZIEL, title: 'Renew passport', startsAt: at('2026-10-13 12:00') }),
    reminder({
      id: 'rem-vitamins', calendarId: 'cal-raz', creatorUserId: RAZIEL, forUserId: DANA, title: 'Vitamins',
      startsAt: at('2026-10-10 08:00'), rrule: 'FREQ=DAILY',
    }),
    reminder({ id: 'rem-deleted', calendarId: 'cal-raz', creatorUserId: RAZIEL, forUserId: DANA, title: 'Deleted', startsAt: at('2026-10-13 09:30'), isDeleted: true }),
    reminder({ id: 'rem-yesterday', calendarId: 'cal-raz', creatorUserId: RAZIEL, forUserId: DANA, title: 'Yesterday', startsAt: at('2026-10-12 17:00') }),
    reminder({ id: 'rem-old-cal', calendarId: 'cal-raz-old', creatorUserId: RAZIEL, forUserId: DANA, title: 'On a deleted calendar', startsAt: at('2026-10-13 09:00') }),
    // On a calendar Dana can see: it comes back from both fetches.
    reminder({ id: 'rem-cake', calendarId: 'cal-raz-family', creatorUserId: RAZIEL, forUserId: DANA, title: 'Pick up the cake', startsAt: at('2026-10-13 18:00') }),
    event({ id: 'ev-noam', calendarId: 'cal-noam', creatorUserId: NOAM, title: 'Gym', startsAt: at('2026-10-13 07:00'), endsAt: at('2026-10-13 08:00') }),
  ] as unknown as Row[];
  db.instances = [];
  db.states = [
    state({ seriesEventId: 'rem-plants', originalStartsAt: at('2026-10-13 00:00'), doneAt: at('2026-10-13 09:10'), doneByUserId: DANA }),
    state({ seriesEventId: 'rem-milk', originalStartsAt: at('2026-10-13 17:00'), snoozedUntil: at('2099-01-01 09:00') }),
    // Yesterday's vitamins are done; today's are not.
    state({ seriesEventId: 'rem-vitamins', originalStartsAt: at('2026-10-12 08:00'), doneAt: at('2026-10-12 08:05') }),
  ] as unknown as Row[];
  queries.length = 0;
}

const viewer = (id: number) => db.users.find((u) => u.id === id) as unknown as UserConfig;
const DAY = [at('2026-10-13 00:00'), at('2026-10-14 00:00')] as const;

/** An event as one line: a reminder with whose it is, who set it, done and snoozed. */
function describe(e: CalendarEvent): string {
  if (e.eventType !== 'reminder') return e.summary;
  const r = e.reminder!;
  const flags = [
    r.ownerIsViewer ? 'mine' : `for ${r.ownerName}`,
    r.creatorIsViewer ? 'by me' : `by ${r.creatorName}`,
    r.done ? 'done' : '',
    r.snoozed ? 'snoozed' : '',
  ].filter(Boolean);
  return `${e.summary} (${flags.join(', ')})`;
}

async function main() {
  // The stubs go into require's cache before the modules that import them load. The
  // timezone resolver is reached through import(), so it stays real and finds the
  // user's timezone in the (fake) Redis cache, as it does after the first summary.
  const Module = (await import('module')).default as unknown as {
    new (id: string): { filename: string; loaded: boolean; exports: unknown };
    _cache: Record<string, unknown>;
  };
  const stub = (file: string, exports: Record<string, unknown>) => {
    const filename = path.resolve(__dirname, '../src', file);
    const mod = new Module(filename);
    Object.assign(mod, { filename, loaded: true, exports });
    Module._cache[filename] = mod;
  };
  stub('utils/prisma.ts', { prisma: fakePrisma });
  stub('utils/redis.ts', { redis: { get: async () => IL, set: async () => 'OK' } });

  const { nativeProvider, reminderInfoFor, toUnifiedEvent } = await import('../src/services/calendar-provider/native-provider');

  const fetchDay = (id: number, calendarIds: string[]) => nativeProvider.fetchEventsInRange(viewer(id), calendarIds, ...DAY);
  const instance = (fields: { startsAt: Date; endsAt: Date; allDay?: boolean; timeZone?: string }) => ({
    title: 'Call the plumber', allDay: false, timeZone: IL, seriesEventId: 'r1', instanceStartsAt: fields.startsAt, isRecurringInstance: false,
    ...fields,
  });
  const mine: ReminderInfo = { ownerIsViewer: true, creatorIsViewer: true, done: false, snoozed: false };

  await check('toUnifiedEvent: a timed reminder has no length and carries the viewer\'s side', () => {
    const e = toUnifiedEvent({ id: 'cal1', name: 'Dana' }, instance({ startsAt: at('2026-10-13 10:00'), endsAt: at('2026-10-13 10:00') }), { kind: 'REMINDER' }, mine);
    assert(e.eventType === 'reminder', `eventType ${e.eventType}`);
    assert(e.start === '2026-10-13T07:00:00.000Z' && e.end === e.start, `times ${e.start}..${e.end}`);
    assert(e.reminder === mine, `reminder ${JSON.stringify(e.reminder)}`);
    // A row stored with a length before the store kept reminders at zero still ends where it starts.
    const old = toUnifiedEvent({ id: 'cal1', name: 'Dana' }, instance({ startsAt: at('2026-10-13 10:00'), endsAt: at('2026-10-13 11:00') }), { kind: 'REMINDER' }, mine);
    assert(old.end === old.start, `old row ends ${old.end}`);
  });

  await check('toUnifiedEvent: a date-only reminder is its one day, on DST days too', () => {
    for (const [day, next, tz] of [['2026-10-13', '2026-10-14', IL], ['2026-10-25', '2026-10-26', IL], ['2026-11-01', '2026-11-02', NY]]) {
      const midnight = at(`${day} 00:00`, tz);
      const e = toUnifiedEvent({ id: 'cal1', name: 'Dana' }, instance({ startsAt: midnight, endsAt: midnight, allDay: true, timeZone: tz }), { kind: 'REMINDER' }, mine);
      assert(e.start === day && e.end === next && e.eventType === 'reminder', `${tz} ${day}: ${e.start}..${e.end} ${e.eventType}`);
    }
  });

  await check('toUnifiedEvent: an event is unchanged, given its series or not', () => {
    const inst = instance({ startsAt: at('2026-10-13 10:00'), endsAt: at('2026-10-13 11:00') });
    const before = toUnifiedEvent({ id: 'cal1', name: 'Dana' }, inst);
    const withSeries = toUnifiedEvent({ id: 'cal1', name: 'Dana' }, inst, { kind: 'EVENT' });
    assert(JSON.stringify(Object.entries(withSeries)) === JSON.stringify(Object.entries(before)), `${JSON.stringify(withSeries)} vs ${JSON.stringify(before)}`);
    assert(!('reminder' in withSeries) && withSeries.eventType === undefined, 'marked as a reminder');
  });

  await check('toUnifiedEvent: a reminder given no viewer side reads as the viewer\'s own', () => {
    const e = toUnifiedEvent({ id: 'cal1', name: 'Dana' }, instance({ startsAt: at('2026-10-13 10:00'), endsAt: at('2026-10-13 10:00') }), { kind: 'REMINDER' });
    assert(e.reminder?.ownerIsViewer === true && e.reminder.creatorIsViewer === true, `reminder ${JSON.stringify(e.reminder)}`);
  });

  await check('reminderInfoFor: done, snoozed, and a snooze that has run out', () => {
    const ctx: ViewerContext = { viewerId: DANA, partner: null };
    const series = { creatorUserId: DANA, forUserId: null };
    const now = at('2026-10-13 12:00');
    const done = reminderInfoFor(series, { doneAt: at('2026-10-13 09:00'), snoozedUntil: null }, ctx, now);
    assert(done.done === true && done.snoozed === false, `done ${JSON.stringify(done)}`);
    const snoozed = reminderInfoFor(series, { doneAt: null, snoozedUntil: at('2026-10-13 12:15') }, ctx, now);
    assert(snoozed.done === false && snoozed.snoozed === true, `snoozed ${JSON.stringify(snoozed)}`);
    const ranOut = reminderInfoFor(series, { doneAt: null, snoozedUntil: at('2026-10-13 11:45') }, ctx, now);
    assert(ranOut.snoozed === false, `ran out ${JSON.stringify(ranOut)}`);
    const pending = reminderInfoFor(series, undefined, ctx, now);
    assert(JSON.stringify(pending) === JSON.stringify({ ownerIsViewer: true, creatorIsViewer: true, done: false, snoozed: false }), `pending ${JSON.stringify(pending)}`);
  });

  await check('Dana\'s day: hers, and Raziel\'s for her from his PRIVATE calendar, once each, in order', async () => {
    household();
    const events = await fetchDay(DANA, ['native:cal-dana', 'native:cal-raz-family']);
    assertList(events.map(describe), [
      'Water the plants (mine, by me, done)',
      'Vitamins (mine, by Raziel)',
      'Dentist',
      'Call the bank (for Raziel, by me)',
      'Buy milk (mine, by Raziel, snoozed)',
      'Pick up the cake (mine, by Raziel)',
    ]);
    const vitamins = events.find((e) => e.summary === 'Vitamins')!;
    assert(vitamins.eventId === `rem-vitamins#${at('2026-10-13 08:00').toISOString()}` && vitamins.recurringEventId === 'rem-vitamins', `vitamins ${vitamins.eventId}`);
    const plants = events.find((e) => e.summary === 'Water the plants')!;
    assert(plants.start === '2026-10-13' && plants.end === '2026-10-14', `plants ${plants.start}..${plants.end}`);
    const milk = events.find((e) => e.summary === 'Buy milk')!;
    assert(milk.calendarId === 'native:cal-raz' && milk.start === milk.end, `milk ${milk.calendarId} ${milk.start}..${milk.end}`);
  });

  await check('Raziel\'s day: the other side of the same reminders', async () => {
    household();
    const events = await fetchDay(RAZIEL, ['native:cal-raz', 'native:cal-raz-family', 'native:cal-dana']);
    assertList(events.map(describe), [
      'Water the plants (for Dana, by Dana, done)',
      'Vitamins (for Dana, by me)',
      'Dentist',
      'Renew passport (mine, by me)',
      'Call the bank (mine, by Dana)',
      'Buy milk (for Dana, by me, snoozed)',
      'Pick up the cake (for Dana, by me)',
    ]);
  });

  await check('after unlinking, Raziel\'s reminder for Dana is gone and hers for him is hers again', async () => {
    household();
    db.pairings[0].status = 'UNLINKED';
    const events = await fetchDay(DANA, ['native:cal-dana']);
    assertList(events.map(describe), [
      'Water the plants (mine, by me, done)',
      'Dentist',
      'Call the bank (mine, by me)',
    ]);
  });

  await check('a partner who moved to Google: Dana\'s reminder for him is hers again', async () => {
    household();
    db.users.find((u) => u.id === RAZIEL)!.calendarSource = 'GOOGLE';
    const events = await fetchDay(DANA, ['native:cal-dana']);
    assert(events.map(describe).includes('Call the bank (mine, by me)'), events.map(describe).join(' | '));
  });

  await check('an unpaired user with no reminders: no partner, state or extra event queries', async () => {
    household();
    const events = await fetchDay(NOAM, ['native:cal-noam']);
    assertList(events.map(describe), ['Gym']);
    assertList(queries, ['nativeCalendar.findMany', 'nativeEvent.findMany', 'nativeEventInstance.findMany']);
  });

  await check('createEvent: a reminder reaches the store as a REMINDER for the partner, an event as before', async () => {
    household();
    const dana = viewer(DANA);
    const time = at('2026-10-15 10:00');
    const made = await nativeProvider.createEvent(dana, 'native:cal-dana', { title: 'Call the bank', startTime: time, endTime: time, kind: 'reminder', forUserId: RAZIEL });
    const row = db.events[db.events.length - 1];
    assert(made.success && made.eventId === row.id, `result ${JSON.stringify(made)}`);
    assert(row.kind === 'REMINDER' && row.forUserId === RAZIEL && row.creatorUserId === DANA, `reminder row ${JSON.stringify(row)}`);
    const end = at('2026-10-15 11:00');
    await nativeProvider.createEvent(dana, 'native:cal-dana', { title: 'Dentist', startTime: time, endTime: end });
    const eventRow = db.events[db.events.length - 1];
    assert(eventRow.kind === 'EVENT' && eventRow.forUserId === null, `event row ${JSON.stringify(eventRow)}`);
    assert((eventRow.endsAt as Date).getTime() === end.getTime(), `event ends ${String(eventRow.endsAt)}`);
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
TZ=UTC npx tsx scripts/smoke-reminders.ts
TZ=UTC npx tsx scripts/smoke-native-provider-reminders.ts
```
Expected for `smoke-reminders.ts`: the 20 existing checks still pass (today's provider ignores the fake's new `series`), and the three new ones fail. Exit code 1:
```
FAIL  a built-in calendar reminder gets no event alert, neither a start nor a pickup one — got 07:45 🤖 Auto-Reminder: Call the plumber | 07:45 🤖🚗 Auto-Pickup Reminder: Leo | 09:45 🤖 Auto-Reminder: Swim | 10:45 🤖🚗 Auto-Pickup Reminder: Leo
FAIL  titles, calendar names and places are escaped for Telegram's HTML — start "🤖 <b>Auto-Reminder: Tom & Jerry <live></b>\n📅 Noa & Leo\n⏰ Starting at 10:00\n📍 Hall <B>"
FAIL  a user who blocked the bot is marked unreachable, quietly, and the next sync leaves them out — unreachableSince undefined

20/23 passed (process TZ=UTC)
```
Expected for `smoke-native-provider-reminders.ts`: `2/11 passed (process TZ=UTC)`, exit code 1. Only "toUnifiedEvent: an event is unchanged, given its series or not" and "an unpaired user with no reminders: …" pass. The others fail with `eventType undefined`, `reminder undefined`, `reminderInfoFor is not a function`, plain titles where the `(mine, by …)` lines are wanted, and `reminder row {… no "kind":"REMINDER" …}` in the createEvent check.

(`npx tsc --noEmit -p .` also fails at this point, on `CreateEventInput` lacking `kind`/`forUserId`, the missing `ReminderInfo` export, `toUnifiedEvent`'s arity and the missing `reminderInfoFor`. The implementation steps fix all of them.)

- [ ] **Step 3: Implement — `ReminderInfo` on `CalendarEvent` (`src/types.ts`)**

Find:
```ts
  // For recurrence detection
  eventType?: string;         // 'default' | 'birthday' | etc
```
Replace with:
```ts
  // For recurrence detection
  eventType?: string;         // 'default' | 'birthday' | 'reminder' (native) | etc
```

Find (the end of `CalendarEvent`):
```ts
  // How the event sits on the summary day when it is not wholly inside it. Set by
  // shapeEventsForDay (src/utils/day-events.ts); unset means within the day.
  daySpan?: DaySpan;
}
```
Replace with:
```ts
  // How the event sits on the summary day when it is not wholly inside it. Set by
  // shapeEventsForDay (src/utils/day-events.ts); unset means within the day.
  daySpan?: DaySpan;
  // A built-in calendar reminder as the viewer sees it. Present iff eventType === 'reminder'.
  reminder?: ReminderInfo;
}

/**
 * A reminder (a NativeEvent of kind REMINDER) from the viewer's side. The owner is the
 * person it is for, worked out on every read (see src/services/native-reminders/ownership.ts).
 */
export interface ReminderInfo {
  ownerIsViewer: boolean;   // the reminder is for the viewer (effective owner === viewer)
  creatorIsViewer: boolean; // the viewer created it
  ownerName?: string;       // effective owner's display name, set when the owner is not the viewer
  creatorName?: string;     // creator's display name, set when the creator is not the viewer
  done?: boolean;           // this occurrence has doneAt set
  snoozed?: boolean;        // this occurrence has snoozedUntil in the future
  open?: boolean;           // set by the summary: due earlier on the summary day, still undone
  openSince?: string;       // 'yyyy-MM-dd' in the viewer's tz, set only on carried-over items
}
```

- [ ] **Step 4: Implement — `CreateEventInput` (`src/services/calendar-provider/types.ts`)**

Find:
```ts
  allDay?: boolean;
  recurrence?: string[]; // RFC-5545 RRULE strings
}
```
Replace with:
```ts
  allDay?: boolean;
  recurrence?: string[]; // RFC-5545 RRULE strings
  // Native only; the Google provider ignores both. A reminder has no length
  // (startTime === endTime), and forUserId is the partner it is for (null: the creator).
  kind?: 'event' | 'reminder';
  forUserId?: number | null;
}
```

- [ ] **Step 5: Implement — the store reads (`src/services/native-calendar/event-store.ts`)**

`fetchEventsInCalendars` keeps its queries and output exactly; its candidate filter and its expansion move into two private helpers, so the new reminder fetch uses the same ones. No import changes: `Prisma`, `NativeCalendar`, `NativeEvent`, `NativeEventInstance` and `VirtualInstance` are already imported.

Find the whole function, from its doc comment to its closing brace:
```ts
/**
 * Fetch all events (single + recurring expanded) across a set of calendars
 * that overlap a date range, the way Google's events.list returns them: a
 * Monday 22:00 to Tuesday 02:00 event comes back for both days, and the summary
 * shaping (src/utils/day-events.ts) decides how each day shows it. The caller
 * is responsible for permission filtering (typically by passing in calendars
 * from listVisibleCalendars).
 */
export async function fetchEventsInCalendars(
  calendarCuids: string[],
  range: FetchRange
): Promise<Array<{ calendar: NativeCalendar; series: NativeEvent; instance: VirtualInstance }>> {
  if (calendarCuids.length === 0) return [];

  const calendars = await prisma.nativeCalendar.findMany({
    where: { id: { in: calendarCuids }, isDeleted: false },
  });
  const calendarsById = new Map(calendars.map((c) => [c.id, c]));

  // Pull all candidate series — recurring (rrule != null) get filtered later by
  // expansion; one-offs are filtered cheaply at the SQL level by overlap, with
  // the same rule expandSeries applies.
  const series = await prisma.nativeEvent.findMany({
    where: {
      calendarId: { in: calendarCuids },
      isDeleted: false,
      OR: [
        // single-event: overlaps the range - starts before it ends and is still
        // running when it opens. One starting inside the range always counts,
        // whatever its end says.
        {
          rrule: null,
          startsAt: { lt: range.to },
          OR: [{ startsAt: { gte: range.from } }, { endsAt: { gt: range.from } }],
        },
        // recurring: include all whose dtstart is before range.to and (no UNTIL
        // filter at SQL level — rrule expansion handles bounded series).
        { rrule: { not: null }, startsAt: { lt: range.to } },
      ],
    },
  });

  if (series.length === 0) return [];

  const seriesIds = series.map((s) => s.id);
  const instances = await prisma.nativeEventInstance.findMany({
    where: { seriesEventId: { in: seriesIds } },
  });
  const instancesBySeries = new Map<string, NativeEventInstance[]>();
  for (const inst of instances) {
    const arr = instancesBySeries.get(inst.seriesEventId) ?? [];
    arr.push(inst);
    instancesBySeries.set(inst.seriesEventId, arr);
  }

  const out: Array<{ calendar: NativeCalendar; series: NativeEvent; instance: VirtualInstance }> = [];
  for (const s of series) {
    const calendar = calendarsById.get(s.calendarId);
    if (!calendar) continue;
    const overrides = instancesBySeries.get(s.id) ?? [];
    const expanded = expandSeries(s, range, overrides);
    for (const inst of expanded) {
      out.push({ calendar, series: s, instance: inst });
    }
  }

  out.sort((a, b) => a.instance.startsAt.getTime() - b.instance.startsAt.getTime());
  return out;
}
```
Replace with:
```ts
/** One occurrence as the store reads it: its calendar, its series row and the expanded instance. */
export interface NativeEventRow {
  calendar: NativeCalendar;
  series: NativeEvent;
  instance: VirtualInstance;
}

/**
 * The SQL candidate filter for a range. Recurring series (rrule != null) get
 * filtered later by expansion; one-offs are filtered cheaply at the SQL level
 * by overlap, with the same rule expandSeries applies.
 */
function rangeCandidates(range: FetchRange): Prisma.NativeEventWhereInput[] {
  return [
    // single-event: overlaps the range - starts before it ends and is still
    // running when it opens. One starting inside the range always counts,
    // whatever its end says.
    {
      rrule: null,
      startsAt: { lt: range.to },
      OR: [{ startsAt: { gte: range.from } }, { endsAt: { gt: range.from } }],
    },
    // recurring: include all whose dtstart is before range.to and (no UNTIL
    // filter at SQL level — rrule expansion handles bounded series).
    { rrule: { not: null }, startsAt: { lt: range.to } },
  ];
}

/**
 * Expand candidate series over a range with their overrides, keeping those whose
 * calendar is in `calendarsById` (the non-deleted ones), sorted by start.
 */
async function expandCandidates(
  series: NativeEvent[],
  calendarsById: Map<string, NativeCalendar>,
  range: FetchRange
): Promise<NativeEventRow[]> {
  const seriesIds = series.map((s) => s.id);
  const instances = await prisma.nativeEventInstance.findMany({
    where: { seriesEventId: { in: seriesIds } },
  });
  const instancesBySeries = new Map<string, NativeEventInstance[]>();
  for (const inst of instances) {
    const arr = instancesBySeries.get(inst.seriesEventId) ?? [];
    arr.push(inst);
    instancesBySeries.set(inst.seriesEventId, arr);
  }

  const out: NativeEventRow[] = [];
  for (const s of series) {
    const calendar = calendarsById.get(s.calendarId);
    if (!calendar) continue;
    const overrides = instancesBySeries.get(s.id) ?? [];
    const expanded = expandSeries(s, range, overrides);
    for (const inst of expanded) {
      out.push({ calendar, series: s, instance: inst });
    }
  }

  out.sort((a, b) => a.instance.startsAt.getTime() - b.instance.startsAt.getTime());
  return out;
}

/**
 * Fetch all events (single + recurring expanded) across a set of calendars
 * that overlap a date range, the way Google's events.list returns them: a
 * Monday 22:00 to Tuesday 02:00 event comes back for both days, and the summary
 * shaping (src/utils/day-events.ts) decides how each day shows it. The caller
 * is responsible for permission filtering (typically by passing in calendars
 * from listVisibleCalendars).
 */
export async function fetchEventsInCalendars(calendarCuids: string[], range: FetchRange): Promise<NativeEventRow[]> {
  if (calendarCuids.length === 0) return [];

  const calendars = await prisma.nativeCalendar.findMany({
    where: { id: { in: calendarCuids }, isDeleted: false },
  });
  const calendarsById = new Map(calendars.map((c) => [c.id, c]));

  const series = await prisma.nativeEvent.findMany({
    where: { calendarId: { in: calendarCuids }, isDeleted: false, OR: rangeCandidates(range) },
  });

  if (series.length === 0) return [];
  return expandCandidates(series, calendarsById, range);
}

/**
 * The reminders `creatorUserId` set for `forUserId` that occur in a range, on any
 * non-deleted calendar whatever its privacy: the person a reminder is for sees it on
 * its day even when it sits on the creator's PRIVATE calendar (spec §2). Same candidate
 * filter and row shape as fetchEventsInCalendars. Like it, no permission check: the
 * caller passes an active pair.
 */
export async function fetchRemindersForUserInRange(
  forUserId: number,
  creatorUserId: number,
  range: FetchRange
): Promise<NativeEventRow[]> {
  const series = await prisma.nativeEvent.findMany({
    where: { kind: 'REMINDER', forUserId, creatorUserId, isDeleted: false, OR: rangeCandidates(range) },
  });
  if (series.length === 0) return [];

  const calendars = await prisma.nativeCalendar.findMany({
    where: { id: { in: [...new Set(series.map((s) => s.calendarId))] }, isDeleted: false },
  });
  return expandCandidates(series, new Map(calendars.map((c) => [c.id, c])), range);
}

/** What the readers need of a reminder occurrence's NativeReminderState row. */
export interface ReminderStateRow {
  seriesEventId: string;
  originalStartsAt: Date;
  doneAt: Date | null;
  snoozedUntil: Date | null;
}

/**
 * The state rows of these reminder occurrences, in one query. An occurrence without
 * a row is still pending. A few extra rows can come back (another series' occurrence
 * at one of the same times), so callers look rows up by their exact key.
 */
export async function fetchReminderStates(
  occurrences: Array<{ seriesEventId: string; originalStartsAt: Date }>
): Promise<ReminderStateRow[]> {
  if (occurrences.length === 0) return [];
  return prisma.nativeReminderState.findMany({
    where: {
      seriesEventId: { in: [...new Set(occurrences.map((o) => o.seriesEventId))] },
      originalStartsAt: { in: occurrences.map((o) => o.originalStartsAt) },
    },
    select: { seriesEventId: true, originalStartsAt: true, doneAt: true, snoozedUntil: true },
  });
}
```

- [ ] **Step 6: Implement — provider imports (`src/services/calendar-provider/native-provider.ts`)**

Find:
```ts
import { format } from 'date-fns';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
```
Replace with:
```ts
import type { NativeEvent } from '@prisma/client';
import { format } from 'date-fns';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
```

Find:
```ts
import { UserConfig } from '../../types';
import {
  NativePermissionDeniedError,
  NativeNotFoundError,
  createNativeEvent,
  decodeCalendarId,
  decodeEventId,
  deleteNativeEvent,
  encodeCalendarId,
  encodeEventId,
  fetchEventsInCalendars,
  isNativeCalendarId,
  listVisibleCalendars,
  updateNativeEvent,
  UpdateScope,
} from '../native-calendar/event-store';
import { TIMEZONE } from '../../config/constants';
```
Replace with:
```ts
import { ReminderInfo, UserConfig } from '../../types';
import {
  FetchRange,
  NativeEventRow,
  NativePermissionDeniedError,
  NativeNotFoundError,
  ReminderStateRow,
  createNativeEvent,
  decodeCalendarId,
  decodeEventId,
  deleteNativeEvent,
  encodeCalendarId,
  encodeEventId,
  fetchEventsInCalendars,
  fetchReminderStates,
  fetchRemindersForUserInRange,
  isNativeCalendarId,
  listVisibleCalendars,
  updateNativeEvent,
  UpdateScope,
} from '../native-calendar/event-store';
import { effectiveOwnerForViewer, loadViewerContext, ViewerContext } from '../native-reminders/ownership';
import { TIMEZONE } from '../../config/constants';
```

- [ ] **Step 7: Implement — `toUnifiedEvent` and the viewer's side (`native-provider.ts`)**

Find:
```ts
 * downstream code already knows how to render. Date strings mirror GCal's
 * format: `YYYY-MM-DD` for all-day, ISO8601 for timed.
 */
```
Replace with:
```ts
 * downstream code already knows how to render. Date strings mirror GCal's
 * format: `YYYY-MM-DD` for all-day, ISO8601 for timed.
 *
 * Given a REMINDER series, the event is a reminder: eventType 'reminder', and `info`,
 * the viewer's side of it. Without `info` it reads as the viewer's own.
 */
```

Find:
```ts
    isRecurringInstance: boolean;
  }
): UnifiedEvent {
  // All-day dates follow Google: the start date and an exclusive end date, both in the
  // event's own timezone (on the server's clock a UTC server would shift them a day).
  // The bot saves an all-day event as 00:00 to 23:59 local on its last day, and a
  // recurring one keeps that duration, so count whole days rather than reading the
  // end's date: a DST day is 23 or 25 hours long.
  const start = instance.allDay
    ? formatInTimeZone(instance.startsAt, instance.timeZone, 'yyyy-MM-dd')
    : instance.startsAt.toISOString();
  const end = instance.allDay
    ? addDaysToDate(start, Math.max(1, Math.round((instance.endsAt.getTime() - instance.startsAt.getTime()) / 86_400_000)))
    : instance.endsAt.toISOString();
```
Replace with:
```ts
    isRecurringInstance: boolean;
  },
  series?: Pick<NativeEvent, 'kind'>,
  info?: ReminderInfo
): UnifiedEvent {
  const isReminder = series?.kind === 'REMINDER';
  // All-day dates follow Google: the start date and an exclusive end date, both in the
  // event's own timezone (on the server's clock a UTC server would shift them a day).
  // The bot saves an all-day event as 00:00 to 23:59 local on its last day, and a
  // recurring one keeps that duration, so count whole days rather than reading the
  // end's date: a DST day is 23 or 25 hours long. A date-only reminder has no length
  // and still counts as its one day. A timed reminder ends where it starts.
  const start = instance.allDay
    ? formatInTimeZone(instance.startsAt, instance.timeZone, 'yyyy-MM-dd')
    : instance.startsAt.toISOString();
  const end = instance.allDay
    ? addDaysToDate(start, Math.max(1, Math.round((instance.endsAt.getTime() - instance.startsAt.getTime()) / 86_400_000)))
    : isReminder ? start : instance.endsAt.toISOString();
```

Find:
```ts
    eventType: undefined,
```
Replace with:
```ts
    eventType: isReminder ? 'reminder' : undefined,
```

Find (the end of `toUnifiedEvent`):
```ts
    instanceStartsAt: instance.isRecurringInstance ? instance.instanceStartsAt.toISOString() : undefined,
    timeZone: instance.timeZone,
  };
}
```
Replace with:
```ts
    instanceStartsAt: instance.isRecurringInstance ? instance.instanceStartsAt.toISOString() : undefined,
    timeZone: instance.timeZone,
    ...(isReminder ? { reminder: info ?? { ownerIsViewer: true, creatorIsViewer: true } } : {}),
  };
}

/**
 * A reminder occurrence from the viewer's side: whose it is, who set it, and whether
 * it is done or snoozed. Names come from the pairing: a reminder the viewer can see
 * was set by the viewer or their partner, and is for one of the two.
 */
export function reminderInfoFor(
  series: { creatorUserId: number; forUserId: number | null },
  state: Pick<ReminderStateRow, 'doneAt' | 'snoozedUntil'> | undefined,
  ctx: ViewerContext,
  now: Date
): ReminderInfo {
  const ownerId = effectiveOwnerForViewer(series, ctx);
  const partnerName = (userId: number) => (ctx.partner?.id === userId ? ctx.partner.name : undefined);
  const info: ReminderInfo = {
    ownerIsViewer: ownerId === ctx.viewerId,
    creatorIsViewer: series.creatorUserId === ctx.viewerId,
    done: !!state?.doneAt,
    snoozed: !!state?.snoozedUntil && state.snoozedUntil > now,
  };
  const ownerName = info.ownerIsViewer ? undefined : partnerName(ownerId);
  const creatorName = info.creatorIsViewer ? undefined : partnerName(series.creatorUserId);
  if (ownerName) info.ownerName = ownerName;
  if (creatorName) info.creatorName = creatorName;
  return info;
}

/** The key a reminder occurrence's state is stored under: its series and original start. */
function occurrenceKey(seriesEventId: string, originalStartsAt: Date): string {
  return `${seriesEventId}|${originalStartsAt.getTime()}`;
}

/** The event id a row is listed under, as toUnifiedEvent encodes it. */
function rowEventId(instance: NativeEventRow['instance']): string {
  return encodeEventId(instance.seriesEventId, instance.isRecurringInstance ? instance.instanceStartsAt : undefined);
}

/**
 * Add the reminders fetched for the viewer to the calendar rows, skipping any already
 * there: a partner's reminder on a calendar the viewer can see comes back from both.
 */
function mergeRows(rows: NativeEventRow[], forViewer: NativeEventRow[]): NativeEventRow[] {
  const seen = new Set(rows.map((r) => rowEventId(r.instance)));
  const added = forViewer.filter((r) => !seen.has(rowEventId(r.instance)));
  if (added.length === 0) return rows;
  return [...rows, ...added].sort((a, b) => a.instance.startsAt.getTime() - b.instance.startsAt.getTime());
}

/** Store rows as the viewer's events. The reminders' states are read in one query. */
async function toViewerEvents(rows: NativeEventRow[], ctx: ViewerContext): Promise<UnifiedEvent[]> {
  const reminderRows = rows.filter((r) => r.series.kind === 'REMINDER');
  if (reminderRows.length === 0) return rows.map((r) => toUnifiedEvent(r.calendar, r.instance));

  const states = await fetchReminderStates(
    reminderRows.map((r) => ({ seriesEventId: r.series.id, originalStartsAt: r.instance.instanceStartsAt }))
  );
  const stateByKey = new Map(states.map((s) => [occurrenceKey(s.seriesEventId, s.originalStartsAt), s]));
  const now = new Date();
  return rows.map((r) => {
    if (r.series.kind !== 'REMINDER') return toUnifiedEvent(r.calendar, r.instance);
    const state = stateByKey.get(occurrenceKey(r.series.id, r.instance.instanceStartsAt));
    return toUnifiedEvent(r.calendar, r.instance, r.series, reminderInfoFor(r.series, state, ctx, now));
  });
}

/**
 * The viewer's events in a range: those on the given calendars, plus the reminders
 * their partner set for them, which they see on its day whatever the privacy of the
 * partner's calendar (spec §2).
 */
async function fetchForViewer(user: UserConfig, cuids: string[], range: FetchRange): Promise<UnifiedEvent[]> {
  const [ctx, rows] = await Promise.all([
    loadViewerContext({ id: user.id, pairingId: user.pairingId ?? null }),
    fetchEventsInCalendars(cuids, range),
  ]);
  const forViewer = ctx.partner ? await fetchRemindersForUserInRange(user.id, ctx.partner.id, range) : [];
  return toViewerEvents(mergeRows(rows, forViewer), ctx);
}
```

- [ ] **Step 8: Implement — the fetchers go through `fetchForViewer` (`native-provider.ts`)**

Find (in `fetchTodayEvents`):
```ts
    const range = ownDayBoundaries(0, tz);
    const rows = await fetchEventsInCalendars(cuids, range);
    return rows.map((r) => toUnifiedEvent(r.calendar, r.instance));
```
Replace with:
```ts
    const range = ownDayBoundaries(0, tz);
    return fetchForViewer(user, cuids, range);
```

Find (in `fetchTomorrowEvents`):
```ts
    const range = ownDayBoundaries(1, tz);
    const rows = await fetchEventsInCalendars(cuids, range);
    return rows.map((r) => toUnifiedEvent(r.calendar, r.instance));
```
Replace with:
```ts
    const range = ownDayBoundaries(1, tz);
    return fetchForViewer(user, cuids, range);
```

Find (in `fetchEventsInRange`):
```ts
    const rows = await fetchEventsInCalendars(cuids, { from: startDate, to: endDate });
    return rows.map((r) => toUnifiedEvent(r.calendar, r.instance));
```
Replace with:
```ts
    return fetchForViewer(user, cuids, { from: startDate, to: endDate });
```

Keep the `if (cuids.length === 0) return [];` guards above each: no calendars asked for means no events, as before.

- [ ] **Step 9: Implement — `createEvent` passes the kind and the target (`native-provider.ts`)**

Find:
```ts
        rrule: data.recurrence && data.recurrence.length > 0
          ? data.recurrence[0].replace(/^RRULE:/, '')
          : null,
      });
```
Replace with:
```ts
        rrule: data.recurrence && data.recurrence.length > 0
          ? data.recurrence[0].replace(/^RRULE:/, '')
          : null,
        kind: data.kind === 'reminder' ? 'REMINDER' : 'EVENT',
        forUserId: data.forUserId ?? null,
      });
```
The returned `eventId` stays `encodeEventId(event.id)`. The store (Task 2) applies the zero-length rule and nulls `forUserId` for an EVENT.

- [ ] **Step 10: Implement — event-alert imports (`src/services/reminders.ts`)**

Find:
```ts
import { captureError } from '../lib/error-capture';
import { isAllDayEvent } from '../utils/event-formatter';
import { localDate, nextDate, startOfLocalDay } from '../utils/day-events';
```
Replace with:
```ts
import { captureError } from '../lib/error-capture';
import { describeDeliveryError, isUnreachableError } from '../lib/delivery-errors';
import { markUserUnreachable } from '../lib/user-reachability';
import { isAllDayEvent } from '../utils/event-formatter';
import { localDate, nextDate, startOfLocalDay } from '../utils/day-events';
import { escapeHtml } from '../utils/html';
```

- [ ] **Step 11: Implement — event alerts skip reminders (`reminders.ts`, `getDueReminders`)**

Find:
```ts
  for (const event of events) {
    if (!event.eventId) continue;
```
Replace with:
```ts
  for (const event of events) {
    if (!event.eventId) continue;
    // A built-in calendar reminder pings through its own pass (src/services/native-reminders).
    // An alert here would ping it again, a pickup one on a kids calendar too, and for both partners.
    if (event.eventType === 'reminder') continue;
```

- [ ] **Step 12: Implement — escape the alert text (`reminders.ts`, `formatReminderMessage`)**

Find:
```ts
  const location = event.location ? `\n📍 ${event.location}` : '';

  // Get calendar name for start reminders
  const calendarName = reminder.calendarAssignment?.name || event.calendarName;
```
Replace with:
```ts
  // Titles and names are the user's own text inside HTML: a "<" or "&" in one made
  // Telegram refuse the whole message, and the alert was lost.
  const title = escapeHtml(event.summary);
  const location = event.location ? `\n📍 ${escapeHtml(event.location)}` : '';

  // Get calendar name for start reminders
  const calendarName = escapeHtml(reminder.calendarAssignment?.name || event.calendarName);
```
`childName` is `calendarName`, so the pickup lines are escaped too. Then, in the same function, replace every occurrence of `${event.summary}</b>` with `${title}</b>` (Edit with `replace_all: true`). There are exactly six, the `event` and `auto` start lines of `en`, `he` and `ru`. After it, `formatReminderMessage` must not mention `event.summary` at all.

- [ ] **Step 13: Implement — a blocked user is marked unreachable (`reminders.ts`, `sendReminder`)**

Find:
```ts
  } catch (error) {
    console.error(`[Reminders] Error sending reminder to user ${user.id}:`, error);
    captureError(error, 'reminders-send', { user_id: user.id });
    return false;
  }
```
Replace with:
```ts
  } catch (error) {
    // A 403 means the chat will never take our messages again. Record it, so the hourly
    // sync leaves the user out, instead of failing here every five minutes.
    if (isUnreachableError(error)) {
      await markUserUnreachable(user.id, describeDeliveryError(error));
      return false;
    }
    console.error(`[Reminders] Error sending reminder to user ${user.id}:`, error);
    captureError(error, 'reminders-send', { user_id: user.id });
    return false;
  }
```

- [ ] **Step 14: Run tests to verify they pass**

```bash
TZ=UTC npx tsx scripts/smoke-native-provider-reminders.ts
TZ=Asia/Jerusalem npx tsx scripts/smoke-native-provider-reminders.ts
TZ=UTC npx tsx scripts/smoke-reminders.ts
TZ=Asia/Jerusalem npx tsx scripts/smoke-reminders.ts
```
Expected: every line `OK`. The final lines are `11/11 passed (process TZ=UTC)`, `11/11 passed (process TZ=Asia/Jerusalem)`, `23/23 passed (process TZ=UTC)` and `23/23 passed (process TZ=Asia/Jerusalem)`. Each exits 0.

Regression: these scripts build or read native events through `toUnifiedEvent` and the store, so they must still pass with no FAIL line, under both clocks:
```bash
for tz in UTC Asia/Jerusalem; do
  for s in smoke-day-shaping smoke-voice-dates smoke-week-lookahead smoke-recurrence smoke-native-reminder-ownership smoke-native-reminder-store smoke-native-reminder-support; do
    echo "$tz $s: $(TZ=$tz npx tsx scripts/$s.ts | tail -1)"
  done
done
```
Expected: each line ends `N/N passed`, with smoke-recurrence 35, smoke-day-shaping 28, smoke-native-reminder-store 20, smoke-native-reminder-ownership 22 and smoke-native-reminder-support 30 (smoke-voice-dates and smoke-week-lookahead keep whatever they had). Then:
```bash
npx tsc --noEmit -p .
npm run -s lint
```
Expected: both print nothing and exit 0.

- [ ] **Step 15: Commit**

```bash
git add src/types.ts src/services/calendar-provider/types.ts src/services/native-calendar/event-store.ts \
  src/services/calendar-provider/native-provider.ts src/services/reminders.ts \
  scripts/smoke-reminders.ts scripts/smoke-native-provider-reminders.ts
git commit -F - <<'EOF'
feat(reminders): native provider carries reminders; event alerts skip them

A REMINDER occurrence now leaves the native provider as eventType 'reminder' with
the viewer's side of it: whose it is, who set it, done and snoozed. The fetchers
also read the reminders the viewer's partner set for them, from any calendar
privacy, and drop the copy a visible calendar already returned. createEvent passes
the kind and the target through to the store.

Event alerts skip reminders, which ping through their own pass. Alert titles,
calendar names and places are HTML-escaped, and a 403 marks the user unreachable
instead of failing every five minutes.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
EOF
```

---

### Task 6: Partner identity in built-in calendar digests (R8)

A NativeCalendar's labels are its owner's. Every primary calendar is created as `['primary', 'yours']` (`src/services/native-calendar/onboarding.ts:40`), and `getCalendarAssignmentsForUser` copies labels verbatim. So a paired built-in calendar user gets the partner's main calendar as `primary, yours`:
- `categorizeEvents` files the partner's events under "Your Schedule";
- `getSpouseInfo` reads the Google-only `user.calendarAssignments` and returns null;
- the week prompts (`claude.ts`) and the voice show context (`voice-show/context.ts`) read the same Google-only column, so they have no spouse and no kids for NATIVE users.

This task labels the partner's calendars from the viewer's side, names the partner's own calendar after the partner, and gives the resolved calendars to every reader. Google users stay byte-identical: for them `getCalendarAssignmentsForUser` returns `user.calendarAssignments ?? []`, the very list every changed reader used before.

**Files:**
- Modify: `src/services/calendar-provider/user-calendars.ts:9-36` — `getCalendarAssignmentsForUser` relabels the partner's calendars (`labelsFromViewerSide`) and fills `personName`/`personEnglishName`/`personGender` of the partner's own unnamed calendar from the owner, loading the owners in one query.
- Modify: `src/utils/calendar-helpers.ts:13-22` — `getSpouseInfo(user, assignments?)`.
- Modify: `src/services/telegram/summary.ts:121-122` — `prepareSummaryForUser` passes its resolved `assignments` to `getSpouseInfo`.
- Modify: `src/services/claude.ts:410-450` (helper + `buildWeekLookaheadPromptData`), `:542-551` (`generateWeekLookahead`), `:570-611` (`buildNextWeekPromptData`), `:705-714` (`generateNextWeekSummary`) — one `weekFamilyContext(calendars)` helper replaces the two copies of the spouse/kids block; both builders and both generators take the resolved calendars.
- Modify: `src/services/telegram/commands.ts:558-567`, `:658-667` — `/week` and `/nextweek` pass the calendars they already resolve.
- Modify: `src/services/voice-show/context.ts:1-36` — `buildShowContext(..., calendars?)` plus `resolveShowCalendars(user)`.
- Modify: `src/services/voice-show/produce.ts:11`, `:35` — the show resolves a NATIVE user's calendars.
- Test: `scripts/smoke-partner-labels.ts` (new).

**Interfaces:**
- Consumes: nothing from Tasks 1-5. It uses the existing `listVisibleCalendars(userId, pairingId)` and `encodeCalendarId(cuid)` from `src/services/native-calendar/event-store.ts` and `prisma` from `src/utils/prisma.ts`.
- Produces (Task 7 and later rely on these):
  ```ts
  // src/services/calendar-provider/user-calendars.ts
  export function labelsFromViewerSide(labels: CalendarLabel[]): CalendarLabel[];
  // getCalendarAssignmentsForUser(user): unchanged signature. For NATIVE users, a calendar whose
  // ownerUserId !== user.id has labels from the viewer's side (`primary`/`yours` → `spouse`,
  // `spouse` → `yours`, `kids`/`birthdays` kept, `primary` never present). The partner's own
  // calendar with no personName gets the owner's name/englishName/gender. Order is unchanged.

  // src/utils/calendar-helpers.ts
  export function getSpouseInfo(user: UserConfig, assignments?: CalendarAssignment[]): SpouseInfo | null;

  // src/services/claude.ts (new trailing optional parameter)
  export async function generateWeekLookahead(lookahead: WeekLookahead, user: UserConfig, language: string,
    modelId?: string, isAdmin?: boolean, onTextDelta?: AITextDelta, calendars?: CalendarAssignment[]): Promise<string>;
  export async function generateNextWeekSummary(lookahead: WeekLookahead, user: UserConfig, language: string,
    modelId?: string, isAdmin?: boolean, onTextDelta?: AITextDelta, calendars?: CalendarAssignment[]): Promise<string>;

  // src/services/voice-show/context.ts
  export function buildShowContext(summary: string, user: UserConfig, kind: ShowKind, isNextWeek?: boolean,
    calendars?: CalendarAssignment[] /* default user.calendarAssignments ?? [] */): ShowPromptContext;
  export async function resolveShowCalendars(user: UserConfig): Promise<CalendarAssignment[] | undefined>;
  ```
- After this task, `categorizeEvents(events, user, assignments)` puts events on the partner's own calendars in `spouseEvents`, events on the partner's `kids` calendars in `otherEvents` (as before), and events on calendars the partner labelled `spouse` (about the viewer) in `userEvents`. An event whose `calendarId` is not in `assignments` (for example a reminder fetched from the partner's PRIVATE calendar by Task 5's supplementary query) still lands in `otherEvents`. Task 7 must route reminders by `reminder.ownerIsViewer` before calling it.

- [ ] **Step 1: Write the failing test**

Create `scripts/smoke-partner-labels.ts`:

```ts
// Smoke test for the partner's calendars in a built-in (NATIVE) calendar user's digests:
// src/services/calendar-provider/user-calendars.ts and what the summary, the week views
// and the voice show read from it. A NativeCalendar's labels are its owner's, so the
// partner's own calendar reached the other partner as `primary, yours`: the partner's
// events were filed under "Your Schedule", getSpouseInfo read the Google-only column and
// found no spouse, and the week prompts and the show had no partner or kids at all.
//
// The native store, Prisma, the timezone lookup and the AI are stubbed. No network.
//
// Run under both clocks; the output must not depend on the server's timezone:
//   TZ=UTC npx tsx scripts/smoke-partner-labels.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-partner-labels.ts

import path from 'path';
import type { CalendarAssignment, CalendarEvent, UserConfig } from '../src/types';

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
}

function assert(cond: boolean, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

function assertList(got: unknown, want: unknown) {
  assert(JSON.stringify(got) === JSON.stringify(want), `\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`);
}

const IL = 'Asia/Jerusalem';

// Raziel (1) and Dana (2) are paired; Omer (3) is not; Noam (5) is paired with Lior (6),
// who has no English name; Tal (7) is paired with Gal (8), whose calendar names her.
type Row = {
  id: string; ownerUserId: number; name: string; labels: string[];
  personName?: string; personEnglishName?: string; personGender?: string;
};
const VISIBLE: Record<number, Row[]> = {
  1: [
    // Oldest first, as listVisibleCalendars orders them: Dana's main calendar predates Raziel's.
    { id: 'dana-main', ownerUserId: 2, name: 'Dana', labels: ['primary', 'yours'] },
    { id: 'raz-main', ownerUserId: 1, name: 'Raziel', labels: ['primary', 'yours'] },
    { id: 'raz-kids', ownerUserId: 1, name: 'Leo school', labels: ['kids'], personName: 'Leo', personGender: 'male' },
    { id: 'dana-kids', ownerUserId: 2, name: 'Mia', labels: ['kids'], personName: 'Mia', personGender: 'female' },
    { id: 'dana-about-raz', ownerUserId: 2, name: 'Raziel (Dana\'s)', labels: ['spouse'], personName: 'Raziel', personGender: 'male' },
    { id: 'dana-work', ownerUserId: 2, name: 'Dana work', labels: ['yours'], personName: 'Dana W.', personEnglishName: 'Dana W.', personGender: 'female' },
    { id: 'dana-bdays', ownerUserId: 2, name: 'Birthdays', labels: ['birthdays'] },
  ],
  3: [
    { id: 'omer-main', ownerUserId: 3, name: 'Omer', labels: ['primary', 'yours'] },
  ],
  5: [
    { id: 'noam-main', ownerUserId: 5, name: 'Noam', labels: ['primary', 'yours'] },
    { id: 'lior-main', ownerUserId: 6, name: 'Lior', labels: ['primary', 'yours'] },
  ],
  7: [
    { id: 'tal-main', ownerUserId: 7, name: 'Tal', labels: ['primary', 'yours'] },
    { id: 'gal-main', ownerUserId: 8, name: 'Gal', labels: ['primary', 'yours'], personName: 'Gal', personGender: 'female' },
  ],
};
const USERS = [
  { id: 2, name: 'דנה', englishName: 'Dana', gender: 'female' },
  { id: 6, name: 'ליאור', englishName: '', gender: 'male' },
];

/** Every listVisibleCalendars and prisma.user.findMany call, to count the queries. */
const storeCalls: number[] = [];
const userQueries: Array<{ where: { id: { in: number[] } }; select: Record<string, boolean> }> = [];
let failStore = false;

const fakePrisma = {
  user: {
    findMany: async (args: { where: { id: { in: number[] } }; select: Record<string, boolean> }) => {
      userQueries.push(args);
      return USERS.filter(u => args.where.id.in.includes(u.id));
    },
  },
};

const fakeStore = {
  encodeCalendarId: (cuid: string) => `native:${cuid}`,
  listVisibleCalendars: async (userId: number) => {
    storeCalls.push(userId);
    if (failStore) throw new Error('database unreachable');
    return (VISIBLE[userId] ?? []).map(r => ({
      color: '#039BE5', rules: [], privacy: 'SHARED_EDITOR', isDeleted: false,
      personName: null, personEnglishName: null, personGender: null, ...r,
    }));
  },
  getNativeSeriesRrule: async () => null,
};

const user = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  name: 'Raziel',
  englishName: 'Raziel',
  gender: 'male',
  language: 'en',
  culture: 'default',
  calendarSource: 'NATIVE',
  googleRefreshToken: '',
  pairingId: 'pair-1',
  includeWeeklyInLookahead: false,
  lookaheadAlways7Days: false,
  ...extra,
}) as unknown as UserConfig;

const raziel = user(1);
const omer = user(3, { name: 'Omer', englishName: 'Omer', pairingId: null });
const noam = user(5, { name: 'Noam', englishName: 'Noam', pairingId: 'pair-2' });
const tal = user(7, { name: 'Tal', englishName: 'Tal', pairingId: 'pair-3' });
const googleCalendars: CalendarAssignment[] = [
  { calendarId: 'me@example.com', labels: ['primary', 'yours'], name: 'Me', color: '#000' },
  { calendarId: 'noa@example.com', labels: ['spouse'], name: 'Noa', color: '#000', personName: 'Noa', personGender: 'female' },
  { calendarId: 'kids@group', labels: ['kids'], name: 'Kids', color: '#000', personName: 'Ido', personGender: 'male' },
];
const googleUser = user(4, { calendarSource: 'GOOGLE', googleRefreshToken: 'token', calendarAssignments: googleCalendars });

/** An event on one of Raziel's visible calendars, as the native provider hands it over. */
const ev = (summary: string, cuid: string, start = '2026-10-14T07:00:00.000Z', end = '2026-10-14T08:00:00.000Z'): CalendarEvent =>
  ({ summary, start, end, calendarName: VISIBLE[1].find(r => r.id === cuid)!.name, calendarId: `native:${cuid}` });

async function main() {
  // @hebcal/core is ESM-only and tsx loads src/ as CommonJS (see eval-voice-show.ts);
  // the stubs go into require's cache before the modules that import them load.
  const Module = (await import('module')).default as unknown as {
    new (id: string): { filename: string; loaded: boolean; exports: unknown };
    _resolveFilename: (request: string, ...rest: unknown[]) => string;
    _cache: Record<string, unknown>;
  };
  const resolveFilename = Module._resolveFilename;
  Module._resolveFilename = function (request: string, ...rest: unknown[]) {
    if (request === '@hebcal/core') return path.resolve(__dirname, '../node_modules/@hebcal/core/dist/esm/index.js');
    return resolveFilename.call(this, request, ...rest);
  };
  const stub = (file: string, exports: Record<string, unknown>) => {
    const filename = path.resolve(__dirname, '../src', file);
    const mod = new Module(filename);
    Object.assign(mod, { filename, loaded: true, exports });
    Module._cache[filename] = mod;
  };
  const prompts: string[] = [];
  stub('utils/prisma.ts', { prisma: fakePrisma });
  stub('utils/redis.ts', { redis: {} });
  stub('services/native-calendar/event-store.ts', fakeStore);
  stub('lib/timezone.ts', { resolveUserTimezone: async () => IL });
  stub('services/ai-provider.ts', {
    generateAICompletion: async (prompt: string) => {
      prompts.push(prompt);
      return { text: 'ok' };
    },
    streamAICompletion: async () => {
      throw new Error('not streamed in this test');
    },
  });

  const { getCalendarAssignmentsForUser, labelsFromViewerSide } = await import('../src/services/calendar-provider/user-calendars');

  // The week fetch goes through the provider; everything else in the index is the real thing.
  const WEEK_EVENTS: CalendarEvent[] = [
    ev('Pilates', 'dana-main', '2026-10-15T15:00:00.000Z', '2026-10-15T16:00:00.000Z'),
    ev('Ballet', 'dana-kids', '2026-10-16T13:00:00.000Z', '2026-10-16T14:00:00.000Z'),
    ev('Dentist', 'raz-main', '2026-10-17T07:00:00.000Z', '2026-10-17T08:00:00.000Z'),
  ];
  stub('services/calendar-provider/index.ts', {
    getProviderForUser: () => ({ fetchEventsInRange: async () => WEEK_EVENTS }),
    getCalendarAssignmentsForUser,
  });

  const { getSpouseInfo, getPrimaryCalendar } = await import('../src/utils/calendar-helpers');
  const { categorizeEvents } = await import('../src/services/telegram/summary');
  const { getWeekLookahead } = await import('../src/services/week-lookahead');
  const { generateWeekLookahead, generateNextWeekSummary } = await import('../src/services/claude');
  const { buildShowContext, resolveShowCalendars } = await import('../src/services/voice-show/context');

  storeCalls.length = 0;
  userQueries.length = 0;
  const razCalendars = await getCalendarAssignmentsForUser(raziel);
  const razQueries = [...userQueries];
  const byId = (id: string) => razCalendars.find(c => c.calendarId === `native:${id}`)!;

  await check('labelsFromViewerSide: the owner\'s own is the spouse\'s, the owner\'s spouse is yours, primary goes', () => {
    assertList(labelsFromViewerSide(['primary', 'yours']), ['spouse']);
    assertList(labelsFromViewerSide(['primary']), ['spouse']);
    assertList(labelsFromViewerSide(['yours']), ['spouse']);
    assertList(labelsFromViewerSide(['spouse']), ['yours']);
    assertList(labelsFromViewerSide(['kids']), ['kids']);
    assertList(labelsFromViewerSide(['birthdays']), ['birthdays']);
    assertList(labelsFromViewerSide([]), []);
  });

  await check('own calendars keep their labels and person, in the store\'s order', () => {
    assertList(razCalendars.map(c => c.calendarId), [
      'native:dana-main', 'native:raz-main', 'native:raz-kids', 'native:dana-kids',
      'native:dana-about-raz', 'native:dana-work', 'native:dana-bdays',
    ]);
    assertList(byId('raz-main').labels, ['primary', 'yours']);
    assert(byId('raz-main').personName === undefined, `own primary named ${byId('raz-main').personName}`);
    assertList(byId('raz-kids').labels, ['kids']);
    assert(byId('raz-kids').personName === 'Leo' && byId('raz-kids').personGender === 'male', 'own kids calendar lost its child');
  });

  await check('the partner\'s primary calendar is the spouse\'s, named after the partner', () => {
    const dana = byId('dana-main');
    assertList(dana.labels, ['spouse']);
    assertList([dana.personName, dana.personEnglishName, dana.personGender], ['דנה', 'Dana', 'female']);
    assert(dana.name === 'Dana', `name ${dana.name}`);
  });

  await check('the partner\'s kids and birthdays calendars keep their labels and are not named after the partner', () => {
    assertList(byId('dana-kids').labels, ['kids']);
    assertList([byId('dana-kids').personName, byId('dana-kids').personGender], ['Mia', 'female']);
    assertList(byId('dana-bdays').labels, ['birthdays']);
    assert(byId('dana-bdays').personName === undefined, `birthdays named ${byId('dana-bdays').personName}`);
  });

  await check('the partner\'s calendar about the user is the user\'s own; a named partner calendar keeps its name', () => {
    assertList(byId('dana-about-raz').labels, ['yours']);
    assertList(byId('dana-work').labels, ['spouse']);
    assertList([byId('dana-work').personName, byId('dana-work').personEnglishName], ['Dana W.', 'Dana W.']);
  });

  await check('the owners are read in one query, of the unnamed calendars\' owners only', () => {
    assert(razQueries.length === 1, `${razQueries.length} user queries`);
    assertList(razQueries[0].where.id.in, [2]);
    assertList(Object.keys(razQueries[0].select).sort(), ['englishName', 'gender', 'id', 'name']);
  });

  await check('an unpaired user, and a paired one whose partner calendars are all named, read no user', async () => {
    userQueries.length = 0;
    const omerCalendars = await getCalendarAssignmentsForUser(omer);
    assertList(omerCalendars.map(c => c.labels), [['primary', 'yours']]);
    assert(userQueries.length === 0, `${userQueries.length} user queries for an unpaired user`);
    const gal = (await getCalendarAssignmentsForUser(tal)).find(c => c.calendarId === 'native:gal-main')!;
    assertList([gal.labels, gal.personName, gal.personGender], [['spouse'], 'Gal', 'female']);
    assert(userQueries.length === 0, `${userQueries.length} user queries when every partner calendar is named`);
  });

  await check('a partner with no English name gets none, not an empty one', async () => {
    const lior = (await getCalendarAssignmentsForUser(noam)).find(c => c.calendarId === 'native:lior-main')!;
    assertList([lior.labels, lior.personName, lior.personGender], [['spouse'], 'ליאור', 'male']);
    assert(lior.personEnglishName === undefined, `English name ${JSON.stringify(lior.personEnglishName)}`);
  });

  await check('getPrimaryCalendar is the user\'s own, even when the partner\'s calendar is older', () => {
    assert(getPrimaryCalendar(razCalendars) === 'native:raz-main', `primary ${getPrimaryCalendar(razCalendars)}`);
  });

  await check('categorizeEvents: the partner\'s events are the spouse\'s, kids\' events stay other', () => {
    const events = [
      ev('Standup', 'raz-main'), ev('Pilates', 'dana-main'), ev('Offsite', 'dana-work'),
      ev('Haircut', 'dana-about-raz'), ev('Ballet', 'dana-kids'), ev('PTA', 'raz-kids'),
    ];
    const { userEvents, spouseEvents, otherEvents } = categorizeEvents(events, raziel, razCalendars);
    assertList(userEvents.map(e => e.summary), ['Standup', 'Haircut']);
    assertList(spouseEvents.map(e => e.summary), ['Pilates', 'Offsite']);
    assertList(otherEvents.map(e => e.summary), ['Ballet', 'PTA']);
  });

  await check('getSpouseInfo names the partner from the resolved calendars', () => {
    assertList(getSpouseInfo(raziel, razCalendars), { name: 'דנה', englishName: 'Dana', gender: 'female' });
    // The user row alone has no calendars for a NATIVE user, as before.
    assert(getSpouseInfo(raziel) === null, 'spouse found without the resolved calendars');
  });

  await check('Google users: calendars come from the user row untouched, spouse info is the same', async () => {
    storeCalls.length = 0;
    userQueries.length = 0;
    const resolved = await getCalendarAssignmentsForUser(googleUser);
    assert(resolved === googleCalendars, 'not the user row\'s own list');
    assert(storeCalls.length === 0 && userQueries.length === 0, 'Google user hit the native store');
    assertList(getSpouseInfo(googleUser, resolved), getSpouseInfo(googleUser));
    assertList(getSpouseInfo(googleUser), { name: 'Noa', gender: 'female' });
  });

  const lookahead = await getWeekLookahead(raziel, razCalendars, new Date('2026-10-14T09:00:00+03:00'));

  await check('week lookahead: the partner\'s events are labelled spouse, the user\'s yours', () => {
    assertList(lookahead.events.map(e => `${e.summary} ${e.calendarLabel}`), ['Pilates spouse', 'Ballet kids', 'Dentist yours']);
  });

  await check('/week and /nextweek prompts name the partner and the partner\'s kids when given the calendars', async () => {
    for (const generate of [generateWeekLookahead, generateNextWeekSummary]) {
      prompts.length = 0;
      await generate(lookahead, raziel, 'en', undefined, false, undefined, razCalendars);
      const prompt = prompts[0] ?? '';
      assert(prompt.includes('Belong to דנה'), `${generate.name}: no spouse context`);
      assert(prompt.includes('- Ballet (Child: Mia)'), `${generate.name}: no Child: prefix`);
      assert(prompt.includes('- Pilates (Dana)'), `${generate.name}: Pilates line missing`);
    }
  });

  await check('/week prompt for a Google user is the same with or without the calendars passed', async () => {
    prompts.length = 0;
    await generateWeekLookahead(lookahead, googleUser, 'en');
    await generateWeekLookahead(lookahead, googleUser, 'en', undefined, false, undefined, googleCalendars);
    assert(prompts.length === 2 && prompts[0] === prompts[1], 'prompts differ');
    assert(prompts[0].includes('Belong to Noa'), 'Google spouse context lost');
  });

  await check('voice show: the resolved calendars give the hosts the partner and the kids', () => {
    const c = buildShowContext('summary', raziel, 'daily', false, razCalendars);
    assertList(c.spouse, { name: 'דנה', gender: 'female' });
    assertList(c.kids, [{ name: 'Leo', gender: 'male' }, { name: 'Mia', gender: 'female' }]);
    assert(c.hasKidsCalendars, 'no kids calendars');
    assert(buildShowContext('summary', raziel, 'daily').spouse === undefined, 'spouse without calendars');
  });

  await check('voice show: resolveShowCalendars reads a NATIVE user\'s calendars, never a Google user\'s', async () => {
    storeCalls.length = 0;
    assert((await resolveShowCalendars(googleUser)) === undefined, 'Google user resolved');
    assert(storeCalls.length === 0, 'Google user hit the native store');
    const calendars = await resolveShowCalendars(raziel);
    assertList(calendars?.find(c => c.calendarId === 'native:dana-main')?.labels, ['spouse']);
    assertList(buildShowContext('s', googleUser, 'daily'), buildShowContext('s', googleUser, 'daily', false, googleCalendars));
  });

  await check('voice show: a failed lookup leaves the show without the family, not without a voice', async () => {
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(String(args[0])); };
    failStore = true;
    try {
      assert((await resolveShowCalendars(raziel)) === undefined, 'resolved while the store failed');
      assert(warnings.some(w => w.startsWith('[VoiceShow]')), `warnings ${JSON.stringify(warnings)}`);
    } finally {
      failStore = false;
      console.warn = warn;
    }
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `TZ=UTC npx tsx scripts/smoke-partner-labels.ts`

Expected: exit code 1, ending with `4/18 passed (process TZ=UTC)`. The four that already pass are "own calendars keep their labels…", "the partner's kids and birthdays calendars…", "Google users: calendars come from the user row untouched…" and "/week prompt for a Google user is the same…". The others fail with, among others:
```
FAIL  labelsFromViewerSide: … — labelsFromViewerSide is not a function
FAIL  the partner's primary calendar is the spouse's, named after the partner — 
     got  ["primary","yours"]
     want ["spouse"]
FAIL  the owners are read in one query, of the unnamed calendars' owners only — 0 user queries
FAIL  getPrimaryCalendar is the user's own, even when the partner's calendar is older — primary native:dana-main
FAIL  categorizeEvents: the partner's events are the spouse's, kids' events stay other — 
     got  ["Standup","Pilates","Offsite"]
     want ["Standup","Haircut"]
FAIL  getSpouseInfo names the partner from the resolved calendars — 
     got  null
FAIL  week lookahead: the partner's events are labelled spouse, the user's yours — 
     got  ["Pilates yours","Ballet kids","Dentist yours"]
FAIL  /week and /nextweek prompts name the partner and the partner's kids when given the calendars — generateWeekLookahead: no spouse context
FAIL  voice show: resolveShowCalendars reads a NATIVE user's calendars, never a Google user's — resolveShowCalendars is not a function
```

- [ ] **Step 3: Label the partner's calendars from the viewer's side**

In `src/services/calendar-provider/user-calendars.ts`, find (lines 9-36):

```ts
import type { UserConfig } from '../../types';
import type { CalendarAssignment, CalendarLabel } from '../../types';
import {
  encodeCalendarId,
  listVisibleCalendars,
} from '../native-calendar/event-store';

/**
 * Resolve the CalendarAssignment[] shape for a user regardless of provider.
 * Pure read; safe to call from voice handlers, reminders, summaries.
 */
export async function getCalendarAssignmentsForUser(user: UserConfig): Promise<CalendarAssignment[]> {
  if (user.calendarSource === 'NATIVE') {
    const calendars = await listVisibleCalendars(user.id, user.pairingId ?? null);
    return calendars.map((c) => ({
      calendarId: encodeCalendarId(c.id),
      labels: (c.labels as CalendarLabel[]) || [],
      name: c.name,
      color: c.color,
      personName: c.personName ?? undefined,
      personEnglishName: c.personEnglishName ?? undefined,
      personGender: (c.personGender as 'male' | 'female' | undefined) ?? undefined,
      rules: c.rules || undefined,
    }));
  }
  // GOOGLE: existing behavior — assignments are stored on User.calendarAssignments JSON
  return user.calendarAssignments ?? [];
}
```

Replace it with:

```ts
import type { NativeCalendar, User } from '@prisma/client';
import type { UserConfig } from '../../types';
import type { CalendarAssignment, CalendarLabel } from '../../types';
import { prisma } from '../../utils/prisma';
import {
  encodeCalendarId,
  listVisibleCalendars,
} from '../native-calendar/event-store';

type CalendarOwner = Pick<User, 'id' | 'name' | 'englishName' | 'gender'>;

/**
 * Resolve the CalendarAssignment[] shape for a user regardless of provider.
 * Pure read; safe to call from voice handlers, reminders, summaries.
 *
 * A NativeCalendar's labels are its owner's, so the partner's own calendar says
 * `primary, yours`. The user sees the partner's calendars labelled from their own
 * side (labelsFromViewerSide), and the partner's own calendar, when it names no
 * person, is named after the partner, so summaries file and name it as the spouse's.
 */
export async function getCalendarAssignmentsForUser(user: UserConfig): Promise<CalendarAssignment[]> {
  if (user.calendarSource === 'NATIVE') {
    const calendars = await listVisibleCalendars(user.id, user.pairingId ?? null);
    const owners = await loadUnnamedOwners(calendars, user.id);
    return calendars.map((c) => {
      const partnersCalendar = c.ownerUserId !== user.id;
      const owner = needsOwnerName(c, user.id) ? owners.get(c.ownerUserId) : undefined;
      return {
        calendarId: encodeCalendarId(c.id),
        labels: partnersCalendar ? labelsFromViewerSide(c.labels as CalendarLabel[]) : (c.labels as CalendarLabel[]) || [],
        name: c.name,
        color: c.color,
        personName: owner ? owner.name : c.personName ?? undefined,
        personEnglishName: owner ? owner.englishName || undefined : c.personEnglishName ?? undefined,
        personGender: ((owner ? owner.gender : c.personGender) as 'male' | 'female' | undefined) ?? undefined,
        rules: c.rules || undefined,
      };
    });
  }
  // GOOGLE: existing behavior — assignments are stored on User.calendarAssignments JSON
  return user.calendarAssignments ?? [];
}

/**
 * The labels of the partner's calendar as the other partner sees it: the owner's
 * own (`primary` or `yours`) is the spouse's, the owner's `spouse` is the viewer's
 * own (`yours`), and `kids` and `birthdays` stay. `primary` is dropped, since the
 * viewer's primary calendar is their own.
 */
export function labelsFromViewerSide(labels: CalendarLabel[]): CalendarLabel[] {
  const seen = new Set<CalendarLabel>();
  for (const label of labels) {
    if (label === 'primary' || label === 'yours') seen.add('spouse');
    else if (label === 'spouse') seen.add('yours');
    else seen.add(label);
  }
  return [...seen];
}

/** The partner's own calendar with no person on it, which is named after its owner. */
function needsOwnerName(calendar: NativeCalendar, viewerId: number): boolean {
  return calendar.ownerUserId !== viewerId
    && !calendar.personName?.trim()
    && labelsFromViewerSide(calendar.labels as CalendarLabel[]).includes('spouse');
}

/** The owners of the calendars needsOwnerName picks, in one query; none when it picks none. */
async function loadUnnamedOwners(calendars: NativeCalendar[], viewerId: number): Promise<Map<number, CalendarOwner>> {
  const ids = [...new Set(calendars.filter(c => needsOwnerName(c, viewerId)).map(c => c.ownerUserId))];
  if (ids.length === 0) return new Map();
  const owners = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true, englishName: true, gender: true },
  });
  return new Map(owners.map(o => [o.id, o]));
}
```

`hasUsableCalendar` (below it) is unchanged. An own calendar's assignment is exactly what it was. The owner query runs only when a partner calendar that becomes `spouse` has no `personName`, which every onboarding-created primary calendar does (`onboarding.ts:36-43` sets none).

- [ ] **Step 4: `getSpouseInfo` takes the resolved calendars, and the summary passes them**

In `src/utils/calendar-helpers.ts`, find:

```ts
/**
 * Get spouse info from calendar assignments
 * Returns null only if no spouse calendar exists
 * Returns partial info if spouse calendar exists but metadata is incomplete
 */
export function getSpouseInfo(user: UserConfig): SpouseInfo | null {
  // Find any spouse calendar (may or may not have metadata)
  const spouseCalendar = user.calendarAssignments?.find(
    a => a.labels.includes('spouse')
  );
```

Replace with:

```ts
/**
 * Get spouse info from calendar assignments
 * Returns null only if no spouse calendar exists
 * Returns partial info if spouse calendar exists but metadata is incomplete
 * @param assignments - Resolved assignments (getCalendarAssignmentsForUser). A NATIVE
 *   user has none on the user row, so without them there is never a spouse.
 */
export function getSpouseInfo(user: UserConfig, assignments?: CalendarAssignment[]): SpouseInfo | null {
  // Find any spouse calendar (may or may not have metadata)
  const spouseCalendar = (assignments ?? user.calendarAssignments)?.find(
    a => a.labels.includes('spouse')
  );
```

(`CalendarAssignment` is already imported on line 1.)

In `src/services/telegram/summary.ts`, find:

```ts
  // Get spouse info from calendar assignment or legacy fields
  const spouseInfo = getSpouseInfo(user);
```

Replace with:

```ts
  // Get spouse info from the resolved calendars: a NATIVE user's partner is named there
  const spouseInfo = getSpouseInfo(user, assignments);
```

`getSpouseInfo(` has no other caller (`grep -rn "getSpouseInfo(" src app` shows only this one and the definition).

- [ ] **Step 5: The week prompts read the resolved calendars**

In `src/services/claude.ts`, find:

```ts
/**
 * Build week lookahead prompt data from lookahead events and user info
 */
function buildWeekLookaheadPromptData(
  lookahead: WeekLookahead,
  user: UserConfig,
  language: string
): WeekLookaheadPromptData {
```

Replace with:

```ts
/**
 * The family a week prompt names, from the user's calendars: whether a spouse and kids
 * calendar exist, the spouse's name, and each kids calendar's child for the "Child:" prefix.
 */
function weekFamilyContext(calendars: CalendarAssignment[]) {
  const spouseCalendar = calendars.find(c => c.labels.includes('spouse'));
  const kidsCalendarIdMap = new Map<string, string>();
  for (const ca of calendars) {
    if (ca.labels.includes('kids') && ca.personName) {
      kidsCalendarIdMap.set(ca.calendarId, ca.personName);
    }
  }
  return {
    hasSpouseCalendar: !!spouseCalendar,
    hasKidsCalendars: calendars.some(c => c.labels.includes('kids')),
    spouseName: spouseCalendar?.personName,
    kidsCalendarIdMap,
  };
}

/**
 * Build week lookahead prompt data from lookahead events and user info
 * @param calendars - The user's resolved calendars; a NATIVE user's are not on the user row
 */
function buildWeekLookaheadPromptData(
  lookahead: WeekLookahead,
  user: UserConfig,
  language: string,
  calendars: CalendarAssignment[] = user.calendarAssignments ?? []
): WeekLookaheadPromptData {
```

Then find this block. It appears **twice**, in `buildWeekLookaheadPromptData` (lines 434-450) and in `buildNextWeekPromptData` (lines 595-611); replace both occurrences (Edit with `replace_all: true`):

```ts
  // Check for spouse and kids calendars
  const hasSpouseCalendar = user.calendarAssignments?.some(c => c.labels.includes('spouse')) ?? false;
  const hasKidsCalendars = user.calendarAssignments?.some(c => c.labels.includes('kids')) ?? false;

  // Get spouse name from calendar assignment
  const spouseCalendar = user.calendarAssignments?.find(c => c.labels.includes('spouse'));
  const spouseName = spouseCalendar?.personName;

  // Build kids calendar ID → personName map for Child: prefix annotation
  const kidsCalendarIdMap = new Map<string, string>();
  if (user.calendarAssignments) {
    for (const ca of user.calendarAssignments) {
      if (ca.labels.includes('kids') && ca.personName) {
        kidsCalendarIdMap.set(ca.calendarId, ca.personName);
      }
    }
  }
```

with:

```ts
  // Spouse and kids calendars, and the kids calendar ID → personName map for Child: prefix annotation
  const { hasSpouseCalendar, hasKidsCalendars, spouseName, kidsCalendarIdMap } = weekFamilyContext(calendars);
```

For the same calendars the helper gives the same four values the removed block did (`!!find` equals `some`, and the map is built the same way), so a Google user's prompt is unchanged.

Find:

```ts
  onTextDelta?: AITextDelta
): Promise<string> {
  // Build prompt data
  const promptData = buildWeekLookaheadPromptData(lookahead, user, language);
```

Replace with:

```ts
  onTextDelta?: AITextDelta,
  calendars?: CalendarAssignment[]
): Promise<string> {
  // Build prompt data
  const promptData = buildWeekLookaheadPromptData(lookahead, user, language, calendars);
```

Find:

```ts
/**
 * Build prompt data for next week summary
 */
function buildNextWeekPromptData(
  lookahead: WeekLookahead,
  user: UserConfig,
  language: string
): WeekLookaheadPromptData {
```

Replace with:

```ts
/**
 * Build prompt data for next week summary
 * @param calendars - The user's resolved calendars; a NATIVE user's are not on the user row
 */
function buildNextWeekPromptData(
  lookahead: WeekLookahead,
  user: UserConfig,
  language: string,
  calendars: CalendarAssignment[] = user.calendarAssignments ?? []
): WeekLookaheadPromptData {
```

Find:

```ts
  onTextDelta?: AITextDelta
): Promise<string> {
  // Build prompt data
  const promptData = buildNextWeekPromptData(lookahead, user, language);
```

Replace with:

```ts
  onTextDelta?: AITextDelta,
  calendars?: CalendarAssignment[]
): Promise<string> {
  // Build prompt data
  const promptData = buildNextWeekPromptData(lookahead, user, language, calendars);
```

(`CalendarAssignment` is already imported on line 3 of `claude.ts`. This step leaves the time-label blocks further down in both builders, which Task 7 edits, untouched. Only their line numbers move: the first block's `if (event.isBirthday) {` goes from line 479 to 486, the second from 640 to 635.)

- [ ] **Step 6: `/week` and `/nextweek` pass the calendars they resolve**

In `src/services/telegram/commands.ts`, find:

```ts
      const { getCalendarAssignmentsForUser } = await import('../calendar-provider');
      const lookahead = await getWeekLookahead(user, await getCalendarAssignmentsForUser(user));

      pushStage('composing');
      const { generateWeekLookahead } = await import('../claude');
      const onTextDelta = streamHandle
        ? (_delta: string, accumulated: string) => streamHandle.pushDelta(accumulated)
        : undefined;
      return generateWeekLookahead(lookahead, user, userLanguage, undefined, user.isAdmin, onTextDelta);
```

Replace with:

```ts
      const { getCalendarAssignmentsForUser } = await import('../calendar-provider');
      const calendars = await getCalendarAssignmentsForUser(user);
      const lookahead = await getWeekLookahead(user, calendars);

      pushStage('composing');
      const { generateWeekLookahead } = await import('../claude');
      const onTextDelta = streamHandle
        ? (_delta: string, accumulated: string) => streamHandle.pushDelta(accumulated)
        : undefined;
      return generateWeekLookahead(lookahead, user, userLanguage, undefined, user.isAdmin, onTextDelta, calendars);
```

Find:

```ts
      const { getCalendarAssignmentsForUser } = await import('../calendar-provider');
      const lookahead = await getNextWeekLookahead(user, await getCalendarAssignmentsForUser(user));

      pushStage('composing');
      const { generateNextWeekSummary } = await import('../claude');
      const onTextDelta = streamHandle
        ? (_delta: string, accumulated: string) => streamHandle.pushDelta(accumulated)
        : undefined;
      return generateNextWeekSummary(lookahead, user, userLanguage, undefined, user.isAdmin, onTextDelta);
```

Replace with:

```ts
      const { getCalendarAssignmentsForUser } = await import('../calendar-provider');
      const calendars = await getCalendarAssignmentsForUser(user);
      const lookahead = await getNextWeekLookahead(user, calendars);

      pushStage('composing');
      const { generateNextWeekSummary } = await import('../claude');
      const onTextDelta = streamHandle
        ? (_delta: string, accumulated: string) => streamHandle.pushDelta(accumulated)
        : undefined;
      return generateNextWeekSummary(lookahead, user, userLanguage, undefined, user.isAdmin, onTextDelta, calendars);
```

These are the only callers of the two generators (`grep -rn "generateWeekLookahead\|generateNextWeekSummary" src app`).

- [ ] **Step 7: The voice show knows the partner and the kids**

Replace the whole of `src/services/voice-show/context.ts` with:

```ts
/**
 * Builds the show writer's context from the user: who is listening, and the family
 * the hosts may mention, with genders where the calendars record them.
 */

import type { CalendarAssignment, UserConfig } from '../../types';
import type { ShowPerson, ShowPromptContext } from '../../prompts/voice-show/types';
import type { ShowKind } from './types';

/**
 * @param calendars - The user's resolved calendars (resolveShowCalendars); a Google
 *   user's are the ones on the user row.
 */
export function buildShowContext(
  summary: string,
  user: UserConfig,
  kind: ShowKind,
  isNextWeek = false,
  calendars: CalendarAssignment[] = user.calendarAssignments ?? [],
): ShowPromptContext {
  const spouse = calendars.find(cal => cal.labels.includes('spouse') && cal.personName?.trim());

  // A kid can have several calendars; name each kid once.
  const kids: ShowPerson[] = [];
  const seen = new Set<string>();
  for (const cal of calendars) {
    const name = cal.personName?.trim();
    if (!cal.labels.includes('kids') || !name || seen.has(name)) continue;
    seen.add(name);
    kids.push({ name, gender: cal.personGender });
  }

  return {
    kind,
    summary,
    locale: user.language || 'en',
    listener: { name: user.name, gender: user.gender === 'female' ? 'female' : 'male' },
    spouse: spouse ? { name: spouse.personName!.trim(), gender: spouse.personGender } : undefined,
    kids,
    hasKidsCalendars: calendars.some(cal => cal.labels.includes('kids')),
    culture: user.culture,
    globalRules: user.globalRules,
    isNextWeek: kind === 'weekly' ? isNextWeek : undefined,
  };
}

/**
 * A NATIVE user's calendars, which name the partner and the kids; they are not on the
 * user row. Undefined for a Google user, and when the lookup fails: the show then goes
 * on without the family's names rather than not at all.
 */
export async function resolveShowCalendars(user: UserConfig): Promise<CalendarAssignment[] | undefined> {
  if (user.calendarSource !== 'NATIVE') return undefined;
  try {
    const { getCalendarAssignmentsForUser } = await import('../calendar-provider/user-calendars');
    return await getCalendarAssignmentsForUser(user);
  } catch (err) {
    console.warn(`[VoiceShow] Could not resolve calendars for user ${user.id}:`, err);
    return undefined;
  }
}
```

In `src/services/voice-show/produce.ts`, find:

```ts
import { buildShowContext } from './context';
```

Replace with:

```ts
import { buildShowContext, resolveShowCalendars } from './context';
```

Find:

```ts
  const context = buildShowContext(summary, user, kind, isNextWeek);
```

Replace with:

```ts
  const context = buildShowContext(summary, user, kind, isNextWeek, await resolveShowCalendars(user));
```

The import is dynamic, so `scripts/smoke-voice-show-produce.ts` and `scripts/eval-voice-show.ts`, whose users are not NATIVE, still load no store or Prisma. The narrator fallback in `src/services/telegram/voice.ts:43-48` also reads `user.calendarAssignments`. It is left alone: it runs only for languages without show hosts, and en/he/ru all have them (`isShowLanguage`).

- [ ] **Step 8: Confirm no NATIVE flow relied on the partner's calendar being primary**

Run: `grep -rn "getPrimaryCalendar(\|includes('primary')" src --include='*.ts'`

Expected, and why each is safe:
- `src/utils/calendar-helpers.ts:49,52,65,71`: the definitions. `validateCalendarAssignments` is Google-only (`app/api/select-calendars/route.ts`).
- `src/services/telegram/summary.ts:119`: `getPrimaryCalendar(assignments)` is passed to `generateSummary` as `primaryCalendar`, which the body never reads (`claude.ts:243` is its only occurrence). It is now the viewer's own primary (pinned by the smoke check).
- `src/services/calendar-provider/native-provider.ts:178`: `listCalendars` reads raw `NativeCalendar.labels`, not assignments. It has no caller outside the provider interface.
- `src/services/week-lookahead.ts:182`: `getCalendarLabel` maps `primary` → `yours`. The partner's calendar now reaches it as `['spouse']` → `'spouse'`, and the viewer's own primary still maps to `'yours'` (pinned by the "week lookahead" smoke check). `calendarLabel` isn't printed in the week prompt.

The extraction fallback `matchedCalendar?.calendarId || calendars[0]?.calendarId || 'primary'` (`src/services/voice/gemini-voice.ts:363`) uses list order, which this task does not change. The prompt's calendar list (`gemini-voice.ts:32-34`, `voice/correction-handler.ts:33-35`) now shows the partner's main calendar as `labels: spouse` instead of `labels: primary, yours`. That is the intended side effect: the model no longer sees two "primary" calendars. Event alerts (`src/services/reminders.ts:112`) read only the `kids` label, which is unchanged.

- [ ] **Step 9: Run tests to verify they pass**

```bash
TZ=UTC npx tsx scripts/smoke-partner-labels.ts
TZ=Asia/Jerusalem npx tsx scripts/smoke-partner-labels.ts
```
Expected: `18/18 passed (process TZ=UTC)` and `18/18 passed (process TZ=Asia/Jerusalem)`, exit 0.

Regression scripts touched by the same modules:
```bash
for s in smoke-week-lookahead smoke-reminders smoke-day-shaping; do
  TZ=UTC npx tsx scripts/$s.ts | tail -1
  TZ=Asia/Jerusalem npx tsx scripts/$s.ts | tail -1
done
npx tsx scripts/smoke-voice-show-writer.ts | tail -1
npx tsx scripts/smoke-voice-show-produce.ts | tail -1
# Added by Tasks 5 and 7; a no-op for this task, and skipped when the file does not exist yet.
for s in smoke-native-provider-reminders smoke-native-reminder-digest; do
  [ -f scripts/$s.ts ] || continue
  TZ=UTC npx tsx scripts/$s.ts | tail -1
  TZ=Asia/Jerusalem npx tsx scripts/$s.ts | tail -1
done
```
Expected: every line reads `N/N passed`. At commit `40461c4` the first five were 18/18, 20/20, 24/24, 19/19 and 7/7. Tasks 3 and 5 add checks, so by the time this task runs `smoke-day-shaping` is `28/28` and `smoke-reminders` is `23/23`; `smoke-week-lookahead` (18/18), `smoke-voice-show-writer` (19/19) and `smoke-voice-show-produce` (7/7) are unchanged. The two later scripts, when present, pass with their own counts. `smoke-reminders` stubs `listVisibleCalendars` with `kids`-only calendars that carry no `ownerUserId`. Those count as the partner's, keep `['kids']`, and trigger no owner query, so the script is unaffected.

```bash
npx tsc --noEmit -p .
npm run -s lint
```
Expected: both print nothing and exit 0.

- [ ] **Step 10: Commit**

```bash
git add src/services/calendar-provider/user-calendars.ts src/utils/calendar-helpers.ts \
  src/services/telegram/summary.ts src/services/claude.ts src/services/telegram/commands.ts \
  src/services/voice-show/context.ts src/services/voice-show/produce.ts scripts/smoke-partner-labels.ts
git commit -m "$(cat <<'MSG'
fix(native): label the partner's calendars from the viewer's side

A NativeCalendar's labels are its owner's, so a paired built-in calendar
user got the partner's main calendar as "primary, yours": the partner's
events landed under "Your Schedule", getSpouseInfo read the Google-only
column and found no spouse, and the week prompts and the voice show had
no partner or kids at all.

getCalendarAssignmentsForUser now relabels the partner's calendars from
the viewer's side (yours/primary -> spouse, spouse -> yours, primary
dropped) and names the partner's own unnamed calendar after the partner,
loading the owners in one query. getSpouseInfo, the /week and /nextweek
prompts and the show context take the resolved calendars. Google users
are unchanged.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
MSG
)"
```

---

### Task 7: Summaries, week views and prompts show reminders

**Files:**
- Create: `src/services/native-reminders/open-reminders.ts` — `OPEN_REMINDERS_DIGEST_CAP`, `fetchOpenReminders` (contract), plus the pure helpers the digest and the smoke test use: `selectOpenReminders`, `shapeDayReminders`, `openRemindersCutoff`, `reminderDueAt`, and `addDigestReminders` (the one call `summary.ts` makes). It keeps two local constants, `MORNING_HOUR` and `ARMED_GRACE_MS`, that Task 8 Step 11 swaps for imports from `due.ts` (which does not exist yet).
- Modify: `src/utils/event-formatter.ts:16-19, 24, 39-40, 46-47, 87-89` — `isReminderEvent`, `reminderAttribution`, the reminder branch of `eventTimeLabel`, the attribution suffix in `formatEventForPrompt`.
- Modify: `src/services/telegram/summary.ts:19, 43-53, 109-111, 125-129` — imports; `categorizeEvents` files reminders by owner; `prepareSummaryForUser` runs `addDigestReminders` after `shapeEventsForDay` and passes the "N more" count in `userContext`.
- Modify: `src/services/claude.ts:7, 75-79, 185-188` — import; `SummaryUserContext.openRemindersMore`; `buildPromptData` sets `hasReminders` / `openRemindersMore`.
- Modify: `src/services/claude.ts:475, 484-493, 503-504` and the identical `636, 645-654, 664-665` — the two week builders' localized reminder label and note (each edit is `replace_all`, two hits).
- Modify: `src/services/week-lookahead.ts:6, 10, 36-39, 265-267, 333-336, 401-404` — `LookaheadEvent.reminder`, done reminders dropped, the `formatTomorrowLookahead` reminder line.
- Modify: `src/prompts/calendar-summary/types.ts:28`, `en.ts:63-65, 189`, `he.ts:64-66, 191`, `ru.ts:64-66, 193` — `hasReminders` / `openRemindersMore` and a reminders guideline that appears only when the lists hold reminders.
- Modify: `src/prompts/week-lookahead/types.ts:12`, `en.ts:41-46, 109-110`, `he.ts:41-46, 111-112`, `ru.ts:41-46, 109-110` — `isReminder` / `reminderNote`, the note on the line, a reminders guideline only for weeks with reminders.
- Modify: `src/prompts/voice-show/en.ts:15, 121-122`, `he.ts:15, 135-136`, `ru.ts:17, 132-133` — one reminders rule, added only when the summary contains ⏰.
- Test: `scripts/smoke-native-reminder-digest.ts` (new), `scripts/smoke-day-shaping.ts` (extend), `scripts/smoke-week-lookahead.ts` (extend).

Line numbers are those at `40461c4`; Tasks 1-6 land first and shift some of them. Every edit below quotes the exact text to find, which none of Tasks 1-6 touches.

**Interfaces:**
- Consumes:
  ```ts
  // src/types.ts — Task 5
  export interface ReminderInfo { ownerIsViewer: boolean; creatorIsViewer: boolean; ownerName?: string; creatorName?: string;
    done?: boolean; snoozed?: boolean; open?: boolean; openSince?: string }
  // CalendarEvent gains: reminder?: ReminderInfo;  // present iff eventType === 'reminder'
  // src/services/native-reminders/ownership.ts — Task 1
  export interface PartnerSummary { id: number; name: string; englishName: string /* '' when unset: use ||, not ?? */; gender: string;
    calendarSource: 'GOOGLE' | 'NATIVE'; telegramId: bigint | null; language: string }
  export interface ViewerContext { viewerId: number; partner: PartnerSummary | null }
  export async function loadViewerContext(user: { id: number; pairingId: string | null }): Promise<ViewerContext>;
  export function effectiveOwnerForViewer(series: { creatorUserId: number; forUserId: number | null }, ctx: ViewerContext): number;
  // src/services/native-calendar/recurrence.ts — Task 3
  export function latestOccurrenceBefore(event: NativeEvent, overrides: NativeEventInstance[], at: Date): VirtualInstance | null;
  // src/utils/day-events.ts — Task 3: daySpanOf keeps a zero-length timed item on day D when dayStart <= start < dayEnd
  // @prisma/client — Task 1: NativeEvent.kind/forUserId, NativeEvent.armedAt: Date | null;
  //   relations NativeEvent.calendar, .instances, .states; type NativeReminderState
  // src/services/calendar-provider/native-provider.ts — Task 5
  export function toUnifiedEvent(calendar: { id: string; name: string }, instance: VirtualInstance-like,
    series?: Pick<NativeEvent, 'kind'>, info?: ReminderInfo): UnifiedEvent;   // called here with two
  export function reminderInfoFor(series: { creatorUserId: number; forUserId: number | null },
    state: Pick<ReminderStateRow, 'doneAt' | 'snoozedUntil'> | undefined, ctx: ViewerContext, now: Date): ReminderInfo;
  //   done/snoozed always set; ownerName/creatorName from ctx.partner.name, only when not the viewer
  // Task 6: a reminder's calendarId may be outside the viewer's assignments (a partner's PRIVATE
  //   calendar), so categorizeEvents files a reminder by reminder.ownerIsViewer, never by its calendar.
  // src/services/native-reminders/due.ts — Task 8, NOT present yet: REMINDER_MORNING_HOUR = 9 and
  //   ARMED_GRACE_MS = 15 min. This task keeps local copies; Task 8 Step 11 swaps them for imports.
  ```
- Produces:
  ```ts
  // src/utils/event-formatter.ts
  export function isReminderEvent(event: Pick<CalendarEvent, 'eventType'>): boolean; // eventType === 'reminder'
  export function reminderAttribution(event: Pick<CalendarEvent, 'reminder'>): string | undefined;
  //   'from <creatorName>' when ownerIsViewer && !creatorIsViewer; 'for <ownerName>, you asked' when creatorIsViewer && !ownerIsViewer
  // eventTimeLabel(reminder) → 'Reminder HH:mm' | 'Reminder HH:mm (open)' | 'Reminder (all day)' | 'Reminder (all day, open)'
  //                         | 'Reminder (open since EEE d MMM)'   (never 'HH:mm - HH:mm')

  // src/services/native-reminders/open-reminders.ts
  export const OPEN_REMINDERS_DIGEST_CAP = 5;
  export async function fetchOpenReminders(
    user: UserConfig, ctx: ViewerContext, cutoff: Date, summaryDay: string /* yyyy-MM-dd */, timezone: string,
    cap: number = OPEN_REMINDERS_DIGEST_CAP   // Infinity = all; Task 13's matcher passes Infinity
  ): Promise<{ events: CalendarEvent[]; moreCount: number }>;
  //   The `cap` 6th parameter is part of the amended Shared Interfaces contract and lands here,
  //   so Task 13 Step 7 only verifies it.
  //   Repeating series: only the latest occurrence before cutoff, only if undone, never one due before
  //   series.armedAt - ARMED_GRACE_MS (plan ruling 4), and none when the series occurs on summaryDay.
  //   One-offs: no armedAt bound.
  export interface OpenReminderCandidate { series: NativeEvent; calendar: { id: string; name: string };
    overrides: NativeEventInstance[]; states: Pick<NativeReminderState, 'originalStartsAt' | 'doneAt' | 'snoozedUntil'>[] }
  export function selectOpenReminders(candidates: OpenReminderCandidate[], ctx: ViewerContext, cutoff: Date,
    summaryDay: string, timezone: string, now: Date, cap?: number): { events: CalendarEvent[]; moreCount: number };
  export function shapeDayReminders(events: CalendarEvent[], now: Date, timezone: string): CalendarEvent[];
  export function openRemindersCutoff(summaryDay: string, timezone: string, now: Date): Date; // min(now, start of summaryDay)
  export function reminderDueAt(event: Pick<CalendarEvent, 'start'>, timezone: string): Date; // timed: start; date-only: 09:00 local
  export async function addDigestReminders(user: UserConfig, dayEvents: CalendarEvent[], summaryDay: string,
    timezone: string, now?: Date): Promise<{ events: CalendarEvent[]; moreCount: number }>;

  // src/services/claude.ts
  // SummaryUserContext gains: openRemindersMore?: number;
  // src/prompts/calendar-summary/types.ts — SummaryPromptData gains: hasReminders?: boolean; openRemindersMore?: number;
  // src/services/week-lookahead.ts — LookaheadEvent gains: reminder?: ReminderInfo;
  // src/prompts/week-lookahead/types.ts — LookaheadEventData gains: isReminder?: boolean; reminderNote?: string;
  ```
- Carried-over events are `toUnifiedEvent(calendar, occurrence)` with `eventType: 'reminder'` and `reminder` = Task 5's exported `reminderInfoFor(series, state, ctx, now)` plus `openSince` (the due day, viewer tz). This file defines no `reminderInfoFor` of its own, so the attribution rules live in one place.

- [ ] **Step 1: Write the failing tests**

**1a.** Create `scripts/smoke-native-reminder-digest.ts`:

```ts
// Smoke test for built-in calendar reminders in the daily digests:
// src/services/native-reminders/open-reminders.ts, the reminder split in
// categorizeEvents (src/services/telegram/summary.ts) and the summary prompt claude.ts
// builds. A reminder stays in the digests until it is done: on its day a done one leaves
// the list and a past-due one is "(open)"; older undone ones are carried over as "open
// since <day>", to its owner and its creator only, newest first, five at most. A daily
// reminder ignored for two weeks shows once, not fourteen times, and a repeating one's
// occurrence from before it was armed (created or re-timed) is never carried. Reminders are filed by
// whose they are, never under "other" (that feeds the kid-name follow-up). Prisma and
// the AI are faked. No network, no DB.
//
// Run under both clocks; the output must not depend on the server's timezone:
//   TZ=UTC npx tsx scripts/smoke-native-reminder-digest.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-native-reminder-digest.ts

import path from 'path';
import { fromZonedTime } from 'date-fns-tz';
import type { NativeEvent, NativeEventInstance } from '@prisma/client';
import { startOfLocalDay } from '../src/utils/day-events';
import { formatEventForPrompt } from '../src/utils/event-formatter';
import type { CalendarAssignment, CalendarEvent, ReminderInfo, UserConfig } from '../src/types';
import type { OpenReminderCandidate } from '../src/services/native-reminders/open-reminders';
import type { PartnerSummary, ViewerContext } from '../src/services/native-reminders/ownership';

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
}

function assert(cond: boolean, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

function assertList(got: string[], want: string[]) {
  assert(JSON.stringify(got) === JSON.stringify(want), `\n     got  ${JSON.stringify(got, null, 1)}\n     want ${JSON.stringify(want, null, 1)}`);
}

// ---- Environment: fakes only, set before anything under test loads ----

process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.DATABASE_URL = 'postgresql://test@db.invalid/test';
process.env.UPSTASH_REDIS_REST_URL = 'https://redis.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.GEMINI_API_KEY = 'test-key';
globalThis.fetch = (async (input: unknown) => {
  throw new Error(`network is blocked in this smoke test: ${String(input)}`);
}) as typeof fetch;

const IL = 'Asia/Jerusalem';
/** Wall-clock time in Israel. */
const il = (local: string) => fromZonedTime(local, IL);

// ---- Viewers: Raziel (1) and his ACTIVE partner Dana (2), both on the built-in calendar ----

const dana: PartnerSummary = { id: 2, name: 'Dana', englishName: 'Dana', gender: 'female', calendarSource: 'NATIVE', telegramId: null, language: 'en' };
const razielCtx: ViewerContext = { viewerId: 1, partner: dana };

const OWN: ReminderInfo = { ownerIsViewer: true, creatorIsViewer: true };
const FROM_DANA: ReminderInfo = { ownerIsViewer: true, creatorIsViewer: false, creatorName: 'Dana' };
const FOR_DANA: ReminderInfo = { ownerIsViewer: false, creatorIsViewer: true, ownerName: 'Dana' };

// ---- Reminder series as the carry-over reads them ----

const CALENDAR = { id: 'cal-raziel', name: 'Raziel' };

/** A REMINDER series, by Raziel for himself unless `over` says otherwise. */
function series(title: string, startsAt: Date, over: Partial<NativeEvent> = {}): NativeEvent {
  return {
    id: title.toLowerCase().replace(/\W+/g, '-'),
    calendarId: CALENDAR.id,
    creatorUserId: 1,
    title,
    description: null,
    location: null,
    startsAt,
    endsAt: startsAt,
    allDay: false,
    timeZone: IL,
    rrule: null,
    exdates: [],
    reminderMinutes: null,
    kind: 'REMINDER',
    forUserId: null,
    armedAt: startsAt,
    isDeleted: false,
    createdAt: startsAt,
    updatedAt: startsAt,
    ...over,
  };
}

/** A date-only reminder: zero length at the start of its day in Israel. */
const dateOnly = (title: string, day: string, over: Partial<NativeEvent> = {}) =>
  series(title, startOfLocalDay(day, IL), { allDay: true, ...over });

type StateRow = OpenReminderCandidate['states'][number];
const done = (originalStartsAt: Date): StateRow => ({ originalStartsAt, doneAt: new Date(originalStartsAt.getTime() + 60_000), snoozedUntil: null });
const snoozed = (originalStartsAt: Date, until: Date): StateRow => ({ originalStartsAt, doneAt: null, snoozedUntil: until });

const candidate = (s: NativeEvent, states: StateRow[] = [], overrides: NativeEventInstance[] = []): OpenReminderCandidate =>
  ({ series: s, calendar: CALENDAR, overrides, states });

/** Seven open one-offs, Monday 5 Oct to Sunday 11 Oct at noon: two past the cap. */
const SEVEN_TASKS = [5, 6, 7, 8, 9, 10, 11].map(d => candidate(series(`Task ${d}`, il(`2026-10-${String(d).padStart(2, '0')} 12:00:00`))));

/** The summary prompt's line for each event, as the digest would list it. */
const linesOf = (events: CalendarEvent[], day: string) => events.map(e => formatEventForPrompt(e, 0, IL, day).slice(3));

// Wednesday 14 Oct 2026 in Israel: the morning digest at 08:00 covers Wednesday and
// carries over what is open from before Wednesday.
const WEDNESDAY = '2026-10-14';
const MORNING = il('2026-10-14 08:00:00');

// ---- Fake Prisma: reminder series, pairings and users ----

type Row = Record<string, unknown>;
const USERS: Row[] = [
  { id: 1, name: 'Raziel', englishName: 'Raziel', gender: 'male', calendarSource: 'NATIVE', telegramId: BigInt(1001), language: 'en', pairingId: 'pair-1' },
  { id: 2, name: 'Dana', englishName: 'Dana', gender: 'female', calendarSource: 'NATIVE', telegramId: null, language: 'en', pairingId: 'pair-1' },
];
const PAIRINGS: Row[] = [{ id: 'pair-1', status: 'ACTIVE', inviterUserId: 1, inviteeUserId: 2 }];
const pick = (row: Row | undefined, select?: Record<string, boolean>) =>
  !row ? null : !select ? row : Object.fromEntries(Object.keys(select).filter(k => select[k]).map(k => [k, row[k]]));

/** What nativeEvent.findMany hands back, and every query it was asked. */
let reminderRows: Row[] = [];
let findManyError: Error | null = null;
const findManyCalls: Row[] = [];
const fakePrisma = {
  pairing: { findUnique: async ({ where, select }: { where: { id: string }; select?: Record<string, boolean> }) => pick(PAIRINGS.find(p => p.id === where.id), select) },
  user: { findUnique: async ({ where, select }: { where: { id: number }; select?: Record<string, boolean> }) => pick(USERS.find(u => u.id === where.id), select) },
  nativeEvent: {
    findMany: async (args: Row) => {
      findManyCalls.push(args);
      if (findManyError) throw findManyError;
      return reminderRows;
    },
  },
};
/** A row as findMany returns it with its calendar, overrides and states included. */
const asRow = (c: OpenReminderCandidate): Row => ({ ...c.series, calendar: c.calendar, instances: c.overrides, states: c.states });

const captured: Array<{ context: string; severity?: string }> = [];
const prompts: string[] = [];

const user = (extra: Record<string, unknown>) =>
  ({ id: 1, name: 'Raziel', englishName: 'Raziel', gender: 'male', language: 'en', calendarSource: 'NATIVE', pairingId: 'pair-1', ...extra }) as unknown as UserConfig;
const raziel = user({});
const googleUser = user({ id: 7, calendarSource: 'GOOGLE', pairingId: null });

/** A reminder on the summary day as the native provider hands it over. */
const dayReminder = (summary: string, start: string, end: string, reminder: ReminderInfo): CalendarEvent =>
  ({ summary, start, end, calendarName: 'Raziel', calendarId: 'native:cal-raziel', eventType: 'reminder', reminder });

async function main() {
  // @hebcal/core is ESM-only and tsx loads src/ as CommonJS (see smoke-week-lookahead.ts);
  // the stubs go into require's cache before the modules that import them load.
  const Module = (await import('module')).default as unknown as {
    new (id: string): { filename: string; loaded: boolean; exports: unknown };
    _resolveFilename: (request: string, ...rest: unknown[]) => string;
    _cache: Record<string, unknown>;
  };
  const resolveFilename = Module._resolveFilename;
  Module._resolveFilename = function (request: string, ...rest: unknown[]) {
    if (request === '@hebcal/core') return path.resolve(__dirname, '../node_modules/@hebcal/core/dist/esm/index.js');
    return resolveFilename.call(this, request, ...rest);
  };
  const stub = (file: string, exports: Record<string, unknown>) => {
    const filename = path.resolve(__dirname, '../src', file);
    const mod = new Module(filename);
    Object.assign(mod, { filename, loaded: true, exports });
    Module._cache[filename] = mod;
  };
  stub('utils/prisma.ts', { prisma: fakePrisma });
  stub('lib/error-capture.ts', {
    captureError: (_error: unknown, context: string, _extra?: unknown, severity?: string) => { captured.push({ context, severity }); },
  });
  stub('services/ai-provider.ts', {
    generateAICompletion: async (prompt: string) => {
      prompts.push(prompt);
      return { text: 'ok' };
    },
    streamAICompletion: async () => {
      throw new Error('not streamed in this test');
    },
  });

  const { addDigestReminders, fetchOpenReminders, openRemindersCutoff, selectOpenReminders, shapeDayReminders, OPEN_REMINDERS_DIGEST_CAP } =
    await import('../src/services/native-reminders/open-reminders');
  const { categorizeEvents } = await import('../src/services/telegram/summary');
  const { generateSummary } = await import('../src/services/claude');
  const { buildCalendarSummaryPrompt } = await import('../src/prompts/calendar-summary');
  const { buildShowPrompt } = await import('../src/prompts/voice-show');

  const cutoff = openRemindersCutoff(WEDNESDAY, IL, MORNING);
  const select = (candidates: OpenReminderCandidate[], ctx = razielCtx, at = cutoff, day = WEDNESDAY, now = MORNING) =>
    selectOpenReminders(candidates, ctx, at, day, IL, now);

  // ---- The cutoff ----

  await check('cutoff: the morning digest carries what was due before its day began', () => {
    assert(cutoff.getTime() === startOfLocalDay(WEDNESDAY, IL).getTime(), `cutoff ${cutoff.toISOString()}`);
  });

  await check('cutoff: the evening digest for tomorrow carries what was due before now', () => {
    const evening = il('2026-10-14 20:00:00');
    assert(openRemindersCutoff('2026-10-15', IL, evening).getTime() === evening.getTime(), 'not now');
  });

  // ---- One-off reminders ----

  const plumber = series('Call the plumber', il('2026-10-12 10:00:00'));
  const gas = series('Pay the gas bill', il('2026-10-13 09:00:00'));

  await check('one-off: an undone one from Monday is open since Monday, dated', () => {
    const { events, moreCount } = select([candidate(plumber)]);
    assertList(linesOf(events, WEDNESDAY), ['Call the plumber (Reminder (open since Mon 12 Oct)) [Calendar: Raziel]']);
    assert(moreCount === 0, `moreCount ${moreCount}`);
    assert(events[0].reminder?.openSince === '2026-10-12' && events[0].eventType === 'reminder', JSON.stringify(events[0].reminder));
  });

  await check('one-off: a done one is not carried', () => {
    assert(select([candidate(gas, [done(gas.startsAt)])]).events.length === 0, 'carried a done reminder');
  });

  await check('one-off: a snoozed one is still open, and says so', () => {
    const { events } = select([candidate(gas, [snoozed(gas.startsAt, il('2026-10-14 09:00:00'))])]);
    assert(events.length === 1 && events[0].reminder?.snoozed === true, JSON.stringify(events[0]?.reminder));
  });

  await check('one-off: a date-only one from Tuesday is open since Tuesday', () => {
    const milk = dateOnly('Buy milk', '2026-10-13');
    assertList(linesOf(select([candidate(milk)]).events, WEDNESDAY), ['Buy milk (Reminder (open since Tue 13 Oct)) [Calendar: Raziel]']);
  });

  await check('one-off: one at or after the cutoff is the day\'s, not carried', () => {
    const today = series('Today', il('2026-10-14 00:00:00'));
    const later = series('Later', il('2026-10-14 10:00:00'));
    assert(select([candidate(today), candidate(later)]).events.length === 0, 'carried the summary day\'s own');
  });

  // ---- The evening digest (summary day = tomorrow, cutoff = now) ----

  await check('evening: what was due earlier today is open since today; tonight\'s is in neither list', () => {
    const evening = il('2026-10-14 20:00:00');
    const at = openRemindersCutoff('2026-10-15', IL, evening);
    const morningCall = series('Morning call', il('2026-10-14 10:00:00'));
    const tonight = series('Tonight', il('2026-10-14 21:00:00'));
    const bread = dateOnly('Buy bread', '2026-10-14');
    const { events } = select([candidate(morningCall), candidate(tonight), candidate(bread)], razielCtx, at, '2026-10-15', evening);
    assertList(linesOf(events, '2026-10-15'), [
      'Morning call (Reminder (open since Wed 14 Oct)) [Calendar: Raziel]',
      'Buy bread (Reminder (open since Wed 14 Oct)) [Calendar: Raziel]',
    ]);
  });

  await check('evening digest sent at 07:00: today\'s date-only reminder is not due yet, so not carried', () => {
    const early = il('2026-10-14 07:00:00');
    const bread = dateOnly('Buy bread', '2026-10-14');
    const at = openRemindersCutoff('2026-10-15', IL, early);
    assert(select([candidate(bread)], razielCtx, at, '2026-10-15', early).events.length === 0, 'carried before 09:00');
  });

  // ---- Repeating reminders ----

  // Mondays at 18:00 since 5 Oct: the latest before Wednesday is Monday the 12th.
  const plants = series('Water the plants', il('2026-10-05 18:00:00'), { rrule: 'FREQ=WEEKLY;BYDAY=MO' });

  await check('repeating: only its latest occurrence before the cutoff, when undone', () => {
    const { events } = select([candidate(plants)]);
    assertList(linesOf(events, WEDNESDAY), ['Water the plants (Reminder (open since Mon 12 Oct)) [Calendar: Raziel]']);
  });

  await check('repeating: the latest one done carries nothing, even with an older one undone', () => {
    assert(select([candidate(plants, [done(il('2026-10-12 18:00:00'))])]).events.length === 0, 'carried an older occurrence');
  });

  await check('repeating: a daily reminder ignored for two weeks is one line, and none when it also falls on the day', () => {
    const vitamins = series('Take vitamins', il('2026-09-30 08:00:00'), { rrule: 'FREQ=DAILY' });
    // It occurs on Wednesday too, so Wednesday's own occurrence speaks for it.
    assert(select([candidate(vitamins)]).events.length === 0, 'carried while it occurs on the summary day');
    // Ended on Tuesday: nothing on Wednesday, so the latest (Tuesday's) is carried, once.
    const ended = series('Take vitamins', il('2026-09-30 08:00:00'), { rrule: 'FREQ=DAILY;UNTIL=20261013T235959' });
    assertList(linesOf(select([candidate(ended)]).events, WEDNESDAY), ['Take vitamins (Reminder (open since Tue 13 Oct)) [Calendar: Raziel]']);
  });

  await check('repeating: an exdated latest occurrence leaves the one before it', () => {
    const exdated = series('Water the plants', il('2026-10-05 18:00:00'), { rrule: 'FREQ=WEEKLY;BYDAY=MO', exdates: [il('2026-10-12 18:00:00')] });
    assertList(linesOf(select([candidate(exdated)]).events, WEDNESDAY), ['Water the plants (Reminder (open since Mon 5 Oct)) [Calendar: Raziel]']);
  });

  // ---- Armed: a repeating reminder's occurrence from before it was armed was never pinged ----

  // Daily at 08:00, ended Tuesday: nothing on Wednesday, so Tuesday's is the latest.
  const stretch = (armedAt: Date) => series('Stretch', il('2026-09-30 08:00:00'), { rrule: 'FREQ=DAILY;UNTIL=20261013T235959', armedAt });

  await check('armed: a daily reminder armed three days ago and undone is open since yesterday, once', () => {
    assertList(linesOf(select([candidate(stretch(il('2026-10-11 08:00:00')))]).events, WEDNESDAY), ['Stretch (Reminder (open since Tue 13 Oct)) [Calendar: Raziel]']);
  });

  await check('armed: the same series re-armed today carries nothing (yesterday\'s was never pinged)', () => {
    assert(select([candidate(stretch(MORNING))]).events.length === 0, 'carried an occurrence from before it was armed');
  });

  await check('armed: a one-off is not bounded: one from two days ago, created today, is still carried', () => {
    const books = series('Return the books', il('2026-10-12 10:00:00'), { armedAt: MORNING, createdAt: MORNING });
    assertList(linesOf(select([candidate(books)]).events, WEDNESDAY), ['Return the books (Reminder (open since Mon 12 Oct)) [Calendar: Raziel]']);
  });

  // ---- Who sees a carried-over reminder (R1) ----

  await check('R1: the partner\'s reminder for themselves is not carried to the viewer', () => {
    const danasOwn = series('Dana\'s yoga', il('2026-10-12 07:00:00'), { creatorUserId: 2 });
    assert(select([candidate(danasOwn)]).events.length === 0, 'carried Dana\'s own reminder');
  });

  await check('R1: one Dana set for the viewer is the viewer\'s, "from Dana"; one the viewer set for Dana says so', () => {
    const fromDana = series('Book the vet', il('2026-10-12 11:00:00'), { creatorUserId: 2, forUserId: 1 });
    const forDana = series('Buy milk', il('2026-10-12 17:00:00'), { forUserId: 2 });
    const { events } = select([candidate(fromDana), candidate(forDana)]);
    assertList(linesOf(events, WEDNESDAY), [
      'Buy milk (Reminder (open since Mon 12 Oct)) (for Dana, you asked) [Calendar: Raziel]',
      'Book the vet (Reminder (open since Mon 12 Oct)) (from Dana) [Calendar: Raziel]',
    ]);
    assert(events[0].reminder?.ownerIsViewer === false && events[1].reminder?.ownerIsViewer === true, 'owners');
  });

  await check('R1: after unlinking, a reminder for the ex-partner reverts to its creator', () => {
    const forDana = series('Buy milk', il('2026-10-12 17:00:00'), { forUserId: 2 });
    const { events } = select([candidate(forDana)], { viewerId: 1, partner: null });
    assert(events.length === 1 && events[0].reminder?.ownerIsViewer === true, JSON.stringify(events[0]?.reminder));
    assertList(linesOf(events, WEDNESDAY), ['Buy milk (Reminder (open since Mon 12 Oct)) [Calendar: Raziel]']);
  });

  // ---- Order and cap ----

  await check(`cap: newest first, ${OPEN_REMINDERS_DIGEST_CAP} lines and how many more`, () => {
    const { events, moreCount } = select(SEVEN_TASKS);
    assertList(events.map(e => e.summary), ['Task 11', 'Task 10', 'Task 9', 'Task 8', 'Task 7']);
    assert(moreCount === 2, `moreCount ${moreCount}`);
    const all = selectOpenReminders(SEVEN_TASKS, razielCtx, cutoff, WEDNESDAY, IL, MORNING, Infinity);
    assert(all.events.length === 7 && all.moreCount === 0, `uncapped ${all.events.length}/${all.moreCount}`);
  });

  // ---- The read ----

  await check('fetch: one read of the viewer\'s and the partner\'s-for-the-viewer REMINDER series before the cutoff', async () => {
    findManyCalls.length = 0;
    reminderRows = [asRow(candidate(plumber))];
    const { events } = await fetchOpenReminders(raziel, razielCtx, cutoff, WEDNESDAY, IL);
    assertList(events.map(e => e.summary), ['Call the plumber']);
    assert(findManyCalls.length === 1, `${findManyCalls.length} reads`);
    assert(JSON.stringify(findManyCalls[0]) === JSON.stringify({
      where: {
        kind: 'REMINDER',
        isDeleted: false,
        startsAt: { lt: cutoff },
        calendar: { isDeleted: false },
        OR: [{ creatorUserId: 1 }, { creatorUserId: 2, forUserId: 1 }],
      },
      include: { calendar: true, instances: true, states: true },
    }), JSON.stringify(findManyCalls[0]));
  });

  await check('fetch: unpaired, only the viewer\'s own; a Google user is never read', async () => {
    findManyCalls.length = 0;
    reminderRows = [];
    await fetchOpenReminders(raziel, { viewerId: 1, partner: null }, cutoff, WEDNESDAY, IL);
    assert(JSON.stringify((findManyCalls[0]?.where as Row)?.OR) === '[{"creatorUserId":1}]', JSON.stringify(findManyCalls[0]));
    findManyCalls.length = 0;
    const none = await fetchOpenReminders(googleUser, { viewerId: 7, partner: null }, cutoff, WEDNESDAY, IL);
    assert(none.events.length === 0 && findManyCalls.length === 0, 'read for a Google user');
  });

  // ---- The summary day's own reminders ----

  const nine = dayReminder('Call mom', '2026-10-14T06:00:00.000Z', '2026-10-14T06:00:00.000Z', OWN); // 09:00 Israel
  const pills = dayReminder('Take pills', '2026-10-14T04:00:00.000Z', '2026-10-14T04:00:00.000Z', OWN); // 07:00
  const doneToday = dayReminder('Feed the cat', '2026-10-14T03:00:00.000Z', '2026-10-14T03:00:00.000Z', { ...OWN, done: true });
  const dateOnlyToday = dayReminder('Buy stamps', WEDNESDAY, '2026-10-15', OWN);
  const meeting: CalendarEvent = { summary: 'Standup', start: '2026-10-14T06:30:00.000Z', end: '2026-10-14T06:45:00.000Z', calendarName: 'Work', calendarId: 'native:work' };

  await check('day: a done reminder leaves the day; a past-due one is open; a later one and events are untouched', () => {
    const shaped = shapeDayReminders([pills, doneToday, nine, meeting, dateOnlyToday], MORNING, IL);
    assertList(linesOf(shaped, WEDNESDAY), [
      'Take pills (Reminder 07:00 (open)) [Calendar: Raziel]',
      'Call mom (Reminder 09:00) [Calendar: Raziel]',
      'Standup (09:30 - 09:45) [Calendar: Work]',
      'Buy stamps (Reminder (all day)) [Calendar: Raziel]',
    ]);
    assert(shaped[2] === meeting, 'the event was copied');
  });

  await check('day: a date-only reminder is open from 09:00 on its day', () => {
    const [before] = shapeDayReminders([dateOnlyToday], il('2026-10-14 08:59:00'), IL);
    const [after] = shapeDayReminders([dateOnlyToday], il('2026-10-14 09:01:00'), IL);
    assert(!before.reminder?.open && after.reminder?.open === true, `${before.reminder?.open} ${after.reminder?.open}`);
    assert(linesOf([after], WEDNESDAY)[0] === 'Buy stamps (Reminder (all day, open)) [Calendar: Raziel]', linesOf([after], WEDNESDAY)[0]);
  });

  await check('digest: a Google user\'s events come back as they were, with no read', async () => {
    findManyCalls.length = 0;
    const events = [meeting];
    const result = await addDigestReminders(googleUser, events, WEDNESDAY, IL, MORNING);
    assert(result.events === events && result.moreCount === 0 && findManyCalls.length === 0, 'touched a Google digest');
  });

  await check('digest: the day\'s reminders shaped, then the open ones after them, with the count past the cap', async () => {
    reminderRows = SEVEN_TASKS.map(asRow);
    const { events, moreCount } = await addDigestReminders(raziel, [pills, doneToday, meeting], WEDNESDAY, IL, MORNING);
    assertList(events.map(e => e.summary), ['Take pills', 'Standup', 'Task 11', 'Task 10', 'Task 9', 'Task 8', 'Task 7']);
    assert(moreCount === 2, `moreCount ${moreCount}`);
  });

  await check('digest: a failed carry-over still sends the day, and is reported as a warning', async () => {
    captured.length = 0;
    findManyError = new Error('connection reset');
    const { events, moreCount } = await addDigestReminders(raziel, [pills, meeting], WEDNESDAY, IL, MORNING);
    findManyError = null;
    assertList(linesOf(events, WEDNESDAY), ['Take pills (Reminder 07:00 (open)) [Calendar: Raziel]', 'Standup (09:30 - 09:45) [Calendar: Work]']);
    assert(moreCount === 0, `moreCount ${moreCount}`);
    assert(captured.length === 1 && captured[0].severity === 'warning', JSON.stringify(captured));
  });

  // ---- Categorizing: by whose it is, never "other" ----

  const assignments: CalendarAssignment[] = [
    { calendarId: 'native:mine', labels: ['primary', 'yours'], name: 'Raziel', color: '#000' },
    { calendarId: 'native:danas', labels: ['spouse'], name: 'Dana', color: '#000' },
    { calendarId: 'native:kids', labels: ['kids'], name: 'Noa', color: '#000' },
  ];
  const on = (calendarId: string, e: CalendarEvent): CalendarEvent => ({ ...e, calendarId });

  await check('categorize: reminders go by owner whatever their calendar; events by calendar as before', () => {
    const mineOnDanas = on('native:danas', dayReminder('From Dana', '2026-10-14T08:00:00.000Z', '2026-10-14T08:00:00.000Z', FROM_DANA));
    const danasOnMine = on('native:mine', dayReminder('For Dana', '2026-10-14T09:00:00.000Z', '2026-10-14T09:00:00.000Z', FOR_DANA));
    const mineOnKids = on('native:kids', dayReminder('Sign the form', '2026-10-14T10:00:00.000Z', '2026-10-14T10:00:00.000Z', OWN));
    const dentist = on('native:mine', { ...meeting, summary: 'Dentist' });
    const yoga = on('native:danas', { ...meeting, summary: 'Yoga' });
    const school = on('native:kids', { ...meeting, summary: 'School play' });
    const { userEvents, spouseEvents, otherEvents } = categorizeEvents(
      [mineOnDanas, danasOnMine, mineOnKids, dentist, yoga, school], raziel, assignments
    );
    assertList(userEvents.map(e => e.summary), ['From Dana', 'Sign the form', 'Dentist']);
    assertList(spouseEvents.map(e => e.summary), ['For Dana', 'Yoga']);
    assertList(otherEvents.map(e => e.summary), ['School play']);
  });

  // ---- The summary prompt ----

  const generate = async (userEvents: CalendarEvent[], spouseEvents: CalendarEvent[], openRemindersMore?: number) => {
    prompts.length = 0;
    await generateSummary(
      userEvents, spouseEvents, [], 'Raziel', 'Raziel', 'male', 'Dana', 'Dana', 'female', '',
      il('2026-10-14 12:00:00'), false, undefined, undefined, 'en',
      { calendarAssignments: assignments, openRemindersMore }, false, undefined, IL
    );
    assert(prompts.length === 1, `${prompts.length} prompts`);
    return prompts[0];
  };

  await check('prompt: reminder lines, the reminders guideline and the "N more open" line', async () => {
    const carried = select([candidate(plumber)]).events;
    const prompt = await generate(
      [...shapeDayReminders([pills], MORNING, IL), ...carried],
      [dayReminder('Buy milk', '2026-10-14T14:00:00.000Z', '2026-10-14T14:00:00.000Z', FOR_DANA)],
      3
    );
    assert(prompt.includes('1. Take pills (Reminder 07:00 (open)) [Calendar: Raziel]'), 'open line');
    assert(prompt.includes('2. Call the plumber (Reminder (open since Mon 12 Oct)) [Calendar: Raziel]'), 'carried line');
    assert(prompt.includes('1. Buy milk (Reminder 17:00) (for Dana, you asked) [Calendar: Raziel]'), 'partner line');
    assert(prompt.includes('- **Reminders**: Items marked "Reminder"'), 'guideline');
    assert(prompt.includes('and 3 more open reminders'), '"more" line');
    const ranged = prompt.split('\n').filter(line => line.includes('(Reminder') && /\d\d:\d\d - \d\d:\d\d/.test(line));
    assert(ranged.length === 0, `a reminder got a range: ${ranged.join(' | ')}`);
  });

  await check('prompt: a digest without reminders is unchanged, in every language', async () => {
    const prompt = await generate([meeting], []);
    assert(!prompt.includes('Reminder') && !prompt.includes('⏰'), 'reminder text in a reminder-free prompt');
    for (const language of ['en', 'he', 'ru']) {
      const data = {
        userName: 'Raziel', userEnglishName: 'Raziel', userGender: 'male' as const, hasSpouseCalendar: false,
        currentGregorianDate: 'Wednesday, October 14, 2026', summaryGregorianDate: 'Wednesday, October 14, 2026',
        summaryHebrewDate: '', greeting: 'Hi', userEventsText: 'None', spouseEventsText: 'None', otherEventsText: 'None', language,
      };
      const before = buildCalendarSummaryPrompt(data);
      assert(before === buildCalendarSummaryPrompt({ ...data, hasReminders: false, openRemindersMore: 0 }), `${language} changed`);
      assert(buildCalendarSummaryPrompt({ ...data, hasReminders: true }).length > before.length, `${language} has no guideline`);
    }
  });

  // ---- The voice show reads the finished summary ----

  await check('voice show: a summary with ⏰ reminders gets the reminders rule, in he/en/ru; one without is unchanged', () => {
    const rules: Record<string, string> = { en: 'Reminders (marked ⏰ in the summary)', he: 'תזכורות (מסומנות ⏰ בסיכום)', ru: 'Напоминания (в сводке они с ⏰)' };
    for (const locale of ['en', 'he', 'ru']) {
      const show = (summary: string) => buildShowPrompt({
        kind: 'daily', summary, locale, listener: { name: 'Raziel', gender: 'male' }, kids: [], hasKidsCalendars: false,
      });
      assert(show('<b>Your Schedule:</b>\n- 07:00 ⏰ Take pills (still open)').includes(rules[locale]), `${locale}: no rule`);
      assert(!show('<b>Your Schedule:</b>\n- 09:30-09:45 - Standup').includes(rules[locale]), `${locale}: rule without reminders`);
    }
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
```

**1b.** Extend `scripts/smoke-day-shaping.ts`.

Find (line 10):
```ts
import { formatEventForPrompt } from '../src/utils/event-formatter';
```
Replace with:
```ts
import { formatEventForPrompt, isReminderEvent } from '../src/utils/event-formatter';
```

Find (line 13):
```ts
import type { CalendarEvent } from '../src/types';
```
Replace with:
```ts
import type { CalendarEvent, ReminderInfo } from '../src/types';
```

Then insert this block immediately before the line `let failed = 0;` (it is unique in the file; the block uses `ev`, `onDay`, `party`, `nativeAllDay` and `TZ` from above it, and its own names live inside the braces so they cannot clash with checks Tasks 3 and 5 added):

```ts
// Built-in calendar reminders: one moment, never "10:00 - 10:00". The owner/creator
// flags are the viewer's side of it, as the native provider sets them.
{
  const ownReminder: ReminderInfo = { ownerIsViewer: true, creatorIsViewer: true };
  const reminderEv = (summary: string, start: string, end = start, reminder: ReminderInfo = ownReminder) =>
    ev(summary, start, end, { eventType: 'reminder', reminder });

  check('reminder: a timed one reads "Reminder 10:00", never a range', () => {
    const line = onDay(reminderEv('Call the plumber', '2026-10-13T07:00:00.000Z'), '2026-10-13');
    assert(line === '1. Call the plumber (Reminder 10:00) [Calendar: Family]', `got ${line}`);
    assert(isReminderEvent(reminderEv('x', '2026-10-13T07:00:00.000Z')) && !isReminderEvent(party), 'isReminderEvent');
  });

  check('reminder: a date-only one (zero length, as the store saves it) is "Reminder (all day)" on its day only', () => {
    // 2026-10-13 00:00 in Israel is 2026-10-12T21:00Z; start = end.
    const milk = { ...nativeAllDay('Buy milk', '2026-10-12T21:00:00Z', '2026-10-12T21:00:00Z'), eventType: 'reminder', reminder: ownReminder };
    assert(milk.start === '2026-10-13' && milk.end === '2026-10-14', `dates ${milk.start}..${milk.end}`);
    assert(onDay(milk, '2026-10-13') === '1. Buy milk (Reminder (all day)) [Calendar: Family]', `Tue ${onDay(milk, '2026-10-13')}`);
    assert(onDay(milk, '2026-10-12') === undefined && onDay(milk, '2026-10-14') === undefined, 'kept on another day');
  });

  check('reminder: at exactly 00:00 it is that day\'s "Reminder 00:00", not the day before\'s', () => {
    const pill = reminderEv('Night pill', '2026-10-13T00:00:00+03:00');
    assert(onDay(pill, '2026-10-13') === '1. Night pill (Reminder 00:00) [Calendar: Family]', `Tue ${onDay(pill, '2026-10-13')}`);
    assert(onDay(pill, '2026-10-12') === undefined, 'kept on Monday');
  });

  check('reminder: past due and not done is "(open)", timed or date-only', () => {
    const open = { ...ownReminder, open: true };
    assert(onDay(reminderEv('Call mom', '2026-10-13T07:00:00.000Z', undefined, open), '2026-10-13') === '1. Call mom (Reminder 10:00 (open)) [Calendar: Family]', 'timed');
    assert(onDay(reminderEv('Buy milk', '2026-10-13', '2026-10-14', open), '2026-10-13') === '1. Buy milk (Reminder (all day, open)) [Calendar: Family]', 'date-only');
  });

  check('reminder: carried over from an earlier day says since when, dated, with no time', () => {
    // Carried-over lines join after shaping (it would drop them), so format them directly.
    const carried = reminderEv('Pay the gas bill', '2026-10-06T06:00:00.000Z', undefined, { ...ownReminder, openSince: '2026-10-06' });
    assert(formatEventForPrompt(carried, 2, TZ, '2026-10-13') === '3. Pay the gas bill (Reminder (open since Tue 6 Oct)) [Calendar: Family]', formatEventForPrompt(carried, 2, TZ, '2026-10-13'));
    const dateOnly = reminderEv('Buy milk', '2026-10-12', '2026-10-13', { ...ownReminder, openSince: '2026-10-12' });
    assert(formatEventForPrompt(dateOnly, 0, TZ, '2026-10-13') === '1. Buy milk (Reminder (open since Mon 12 Oct)) [Calendar: Family]', 'date-only');
  });

  check('reminder: one the partner set for the viewer says "from", one the viewer set for the partner says "for ..., you asked"', () => {
    const fromDana = reminderEv('Book the vet', '2026-10-13T08:00:00.000Z', undefined, { ownerIsViewer: true, creatorIsViewer: false, creatorName: 'Dana' });
    assert(onDay(fromDana, '2026-10-13') === '1. Book the vet (Reminder 11:00) (from Dana) [Calendar: Family]', `from ${onDay(fromDana, '2026-10-13')}`);
    const forDana = reminderEv('Buy milk', '2026-10-13T14:00:00.000Z', undefined, { ownerIsViewer: false, creatorIsViewer: true, ownerName: 'Dana' });
    assert(onDay(forDana, '2026-10-13') === '1. Buy milk (Reminder 17:00) (for Dana, you asked) [Calendar: Family]', `for ${onDay(forDana, '2026-10-13')}`);
    // Dana's own reminder, on a calendar the viewer can see: her section says whose it is.
    const danasOwn = reminderEv('Yoga mat', '2026-10-13T05:00:00.000Z', undefined, { ownerIsViewer: false, creatorIsViewer: false, ownerName: 'Dana', creatorName: 'Dana' });
    assert(onDay(danasOwn, '2026-10-13') === '1. Yoga mat (Reminder 08:00) [Calendar: Family]', `own ${onDay(danasOwn, '2026-10-13')}`);
  });

  check('reminder: a name cannot break the line', () => {
    const odd = reminderEv('Call', '2026-10-13T08:00:00.000Z', undefined, { ownerIsViewer: true, creatorIsViewer: false, creatorName: 'Dana\n[urgent]' });
    assert(onDay(odd, '2026-10-13') === '1. Call (Reminder 11:00) (from Dana) [Calendar: Family]', `got ${onDay(odd, '2026-10-13')}`);
  });

  check('reminder: the line follows the user\'s timezone', () => {
    const ny = reminderEv('Call the plumber', '2026-10-13T14:00:00.000Z');
    assert(onDay(ny, '2026-10-13', 'America/New_York') === '1. Call the plumber (Reminder 10:00) [Calendar: Family]', `New York ${onDay(ny, '2026-10-13', 'America/New_York')}`);
  });
}

```

**1c.** Extend `scripts/smoke-week-lookahead.ts`.

Find (line 19):
```ts
import type { CalendarAssignment, CalendarEvent, UserConfig } from '../src/types';
```
Replace with:
```ts
import type { CalendarAssignment, CalendarEvent, ReminderInfo, UserConfig } from '../src/types';
```

Find (line 84):
```ts
const RRULES: Record<string, string> = { gym: 'RRULE:FREQ=DAILY', anniv: 'FREQ=YEARLY', standup: 'FREQ=DAILY' };
```
Replace with:
```ts
const RRULES: Record<string, string> = { gym: 'RRULE:FREQ=DAILY', anniv: 'FREQ=YEARLY', standup: 'FREQ=DAILY', vitamins: 'FREQ=DAILY' };
```

Find (line 94):
```ts
const TIMEZONES: Record<number, string> = { 1: IL, 2: NY, 3: NY, 4: NY };
```
Replace with:
```ts
// Built-in calendar reminders for an Israeli native user, as the provider hands them
// over: zero length, with whose they are from the viewer's side.
const nativeReminder = (summary: string, start: string, end: string, info: ReminderInfo, extra: Partial<CalendarEvent> = {}): CalendarEvent =>
  ({ summary, start, end, calendarName: 'Family', calendarId: 'native-family', eventType: 'reminder', reminder: info, ...extra });
const OWN_REMINDER: ReminderInfo = { ownerIsViewer: true, creatorIsViewer: true };
const NATIVE_REMINDERS: CalendarEvent[] = [
  nativeReminder('Renew passport', '2026-10-14T09:00:00.000Z', '2026-10-14T09:00:00.000Z', { ...OWN_REMINDER, done: true }),
  nativeReminder('Take vitamins', '2026-10-14T05:00:00.000Z', '2026-10-14T05:00:00.000Z', OWN_REMINDER, { recurringEventId: 'vitamins' }),
  nativeReminder('Call the plumber', '2026-10-15T07:00:00.000Z', '2026-10-15T07:00:00.000Z', OWN_REMINDER),
  { summary: 'Dentist', start: '2026-10-15T08:00:00.000Z', end: '2026-10-15T09:00:00.000Z', calendarName: 'Family', calendarId: 'native-family' },
  nativeReminder('Buy milk', '2026-10-16T14:00:00.000Z', '2026-10-16T14:00:00.000Z', { ownerIsViewer: false, creatorIsViewer: true, ownerName: 'Dana' }),
  nativeReminder('Pick up the cake', '2026-10-17', '2026-10-18', { ownerIsViewer: true, creatorIsViewer: false, creatorName: 'Dana' }),
];
const NATIVE_BY_USER: Record<number, CalendarEvent[]> = { 5: NATIVE_REMINDERS };

const TIMEZONES: Record<number, string> = { 1: IL, 2: NY, 3: NY, 4: NY, 5: IL };
```

Find (line 145):
```ts
const runningNewYorker = user(4, { culture: 'default', googleRefreshToken: 'token-running' });
```
Replace with:
```ts
const runningNewYorker = user(4, { culture: 'default', googleRefreshToken: 'token-running' });
const nativeIsraeli = user(5, { culture: 'default', googleRefreshToken: '', calendarSource: 'NATIVE' });
```

Find (line 181):
```ts
    getProviderForUser: () => ({ fetchEventsInRange: async () => NATIVE_EVENTS }),
```
Replace with (the second line keeps the stub whole if the week builders ever resolve assignments through the provider index):
```ts
    getProviderForUser: (u: { id: number }) => ({ fetchEventsInRange: async () => NATIVE_BY_USER[u.id] ?? NATIVE_EVENTS }),
    getCalendarAssignmentsForUser: async () => calendars,
```

Then insert this block inside `main()`, immediately before its `  let failed = 0;` line (after the last `(e)` check):

```ts
  // (f) built-in calendar reminders
  const reminderWeek = await getWeekLookahead(nativeIsraeli, calendars, new Date('2026-10-13T09:00:00+03:00'));

  await check('(f) /week: a reminder shows once, on its own day, as "Reminder HH:MM", with whose it is', async () => {
    // Renew passport is done and Take vitamins is daily: neither is coming up.
    assertList(daysOf(await promptFor(reminderWeek, nativeIsraeli)), [
      'Thursday, Oct 15 - In 2 days | Reminder 10:00 - Call the plumber (Family) | 11:00 - Dentist (Family)',
      'Friday, Oct 16 - In 3 days | Reminder 17:00 - Buy milk (Family) (for Dana, you asked)',
      'Saturday, Oct 17 - In 4 days | Reminder - Pick up the cake (Family) (from Dana)',
    ]);
  });

  await check('(f) /week: the reminders guideline comes only with reminders', async () => {
    assert((await promptFor(reminderWeek, nativeIsraeli)).includes('- **Reminders**: Times starting with "Reminder"'), 'no guideline');
    assert(!(await promptFor(nyWeek, newYorker)).includes('Reminder'), 'a Google week mentions reminders');
  });

  await check('(f) /week in Hebrew and Russian: the reminder label is the user\'s language', async () => {
    prompts.length = 0;
    await generateWeekLookahead(reminderWeek, nativeIsraeli, 'he');
    assert(prompts[0]?.includes('  - תזכורת 10:00 - Call the plumber (Family)'), 'Hebrew timed');
    assert(prompts[0]?.includes('  - תזכורת - Pick up the cake (Family) (from Dana)'), 'Hebrew date-only');
    assert(prompts[0]?.includes('- **תזכורות**:'), 'Hebrew guideline');
    prompts.length = 0;
    await generateWeekLookahead(reminderWeek, nativeIsraeli, 'ru');
    assert(prompts[0]?.includes('  - Напоминание 17:00 - Buy milk (Family) (for Dana, you asked)'), 'Russian timed');
    assert(prompts[0]?.includes('- **Напоминания**:'), 'Russian guideline');
  });

  await check('(f) the tomorrow summary\'s lookahead lists reminders with the daily summary\'s label', async () => {
    const lookahead = await getWeekLookahead(nativeIsraeli, calendars, fromZonedTime('2026-10-14 12:00:00', IL));
    assertList(formatTomorrowLookahead(lookahead).split('\n'), [
      'Thursday: Call the plumber (Reminder 10:00)',
      'Thursday: Dentist at 11:00 (Family)',
      'Friday: Buy milk (Reminder 17:00) (for Dana, you asked)',
      'Saturday: Pick up the cake (Reminder (all day)) (from Dana)',
    ]);
  });

```

- [ ] **Step 2: Run them to verify they fail**

```bash
TZ=UTC npx tsx scripts/smoke-native-reminder-digest.ts; echo "exit=$?"
TZ=UTC npx tsx scripts/smoke-day-shaping.ts | grep -v '^OK'
TZ=UTC npx tsx scripts/smoke-week-lookahead.ts 2>/dev/null | grep -v '^OK'
```

Expected:
- The digest smoke crashes before any check: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/src/services/native-reminders/open-reminders' imported from …/scripts/smoke-native-reminder-digest.ts`, then `exit=1`.
- `smoke-day-shaping`: the eight `reminder:` checks FAIL and every older check stays OK, e.g. `FAIL  reminder: a timed one reads "Reminder 10:00", never a range — got 1. Call the plumber (10:00 - 10:00) [Calendar: Family]` and `FAIL  reminder: at exactly 00:00 … — Tue 1. Night pill (00:00 - 00:00) [Calendar: Family]` (Task 3 already keeps it on its day; only the label is wrong). Final line `28/36 passed` (24 at `40461c4`, 4 from Task 3, 8 here).
- `smoke-week-lookahead`: the four `(f)` checks FAIL, e.g. the first shows `got [ "Wednesday, Oct 14 - Tomorrow | 12:00 - Renew passport (Family)", "Thursday, Oct 15 - In 2 days | 10:00 - Call the plumber (Family) | 11:00 - Dentist (Family)", "Friday, Oct 16 - In 3 days | 17:00 - Buy milk (Family)", "Saturday, Oct 17 - In 4 days | All day - Pick up the cake (Family)" ]`, and the last shows `Thursday: Call the plumber at 10:00 (Family)`. Final line `18/22 passed`.

- [ ] **Step 3: Reminder labels in the event formatter**

In `src/utils/event-formatter.ts`, find (lines 16-19):
```ts
/** Check if a CalendarEvent is a birthday event */
export function isBirthdayEvent(event: CalendarEvent): boolean {
  return event.eventType === 'birthday';
}
```
Replace with:
```ts
/** Check if a CalendarEvent is a birthday event */
export function isBirthdayEvent(event: CalendarEvent): boolean {
  return event.eventType === 'birthday';
}

/** Check if a CalendarEvent is a built-in calendar reminder: a moment, with no duration */
export function isReminderEvent(event: Pick<CalendarEvent, 'eventType'>): boolean {
  return event.eventType === 'reminder';
}

/**
 * Whose a reminder is, from the viewer's side, in English like the other prompt
 * markers: "from Dana" on one Dana set for the viewer, "for Dana, you asked" on one
 * the viewer set for Dana. Nothing on the viewer's own, nor on one the partner set
 * for themselves: the section it sits in already says whose it is.
 */
export function reminderAttribution(event: Pick<CalendarEvent, 'reminder'>): string | undefined {
  const info = event.reminder;
  if (!info) return undefined;
  if (info.ownerIsViewer && !info.creatorIsViewer) return `from ${sanitizeEventField(info.creatorName || 'your partner', 100)}`;
  if (info.creatorIsViewer && !info.ownerIsViewer) return `for ${sanitizeEventField(info.ownerName || 'your partner', 100)}, you asked`;
  return undefined;
}
```

Find (line 24):
```ts
const weekdayOfDate = (date: string, dated = false) => formatInTimeZone(new Date(`${date}T12:00:00Z`), 'UTC', dated ? 'EEE d' : 'EEE');
```
Replace with:
```ts
const weekdayOfDate = (date: string, dated = false) => formatInTimeZone(new Date(`${date}T12:00:00Z`), 'UTC', dated ? 'EEE d' : 'EEE');
// "Tue 12 Oct": an open reminder can be any age, so its day is always dated.
const fullDateOf = (date: string) => formatInTimeZone(new Date(`${date}T12:00:00Z`), 'UTC', 'EEE d MMM');
```

Find (lines 39-40, the head of `eventTimeLabel`'s comment):
```ts
/**
 * The time part of an event line. An event that crosses the summary day's edges says
```
Replace with:
```ts
/**
 * The time part of a reminder's line: one moment, never "10:00 - 10:00". "(open)"
 * marks one whose time has passed on the summary day and that is not done yet; one
 * carried over from an earlier day says since when it is open instead of a time.
 */
function reminderTimeLabel(event: CalendarEvent, timezone: string): string {
  const info = event.reminder;
  if (info?.openSince) return `Reminder (open since ${fullDateOf(info.openSince)})`;
  if (isAllDayEvent(event)) return info?.open ? 'Reminder (all day, open)' : 'Reminder (all day)';
  const label = `Reminder ${clock(event.start, timezone)}`;
  return info?.open ? `${label} (open)` : label;
}

/**
 * The time part of an event line. An event that crosses the summary day's edges says
```

Find:
```ts
export function eventTimeLabel(event: CalendarEvent, timezone: string, day?: string): string {
  // Shaped events carry their span; anything else is worked out here when the day is
```
Replace with:
```ts
export function eventTimeLabel(event: CalendarEvent, timezone: string, day?: string): string {
  if (isReminderEvent(event)) return reminderTimeLabel(event, timezone);
  // Shaped events carry their span; anything else is worked out here when the day is
```

Find (lines 87-89, in `formatEventForPrompt`):
```ts
  const summary = sanitizeEventField(event.summary);
  const calendarName = sanitizeEventField(event.calendarName);
  let eventStr = `${index + 1}. ${summary} (${timeStr}) [Calendar: ${calendarName}]`;
```
Replace with:
```ts
  const summary = sanitizeEventField(event.summary);
  const calendarName = sanitizeEventField(event.calendarName);
  const attribution = reminderAttribution(event);
  let eventStr = `${index + 1}. ${summary} (${timeStr})${attribution ? ` (${attribution})` : ''} [Calendar: ${calendarName}]`;
```

`event-formatter.ts` stays free of `event-store` imports: `smoke-week-lookahead.ts` stubs `event-store.ts` with one function, and `week-lookahead.ts` imports this file.

- [ ] **Step 4: Create the open-reminders module**

Create `src/services/native-reminders/open-reminders.ts`:

```ts
// Reminders in the daily digests (spec §6.1-6.2, rulings R1 and R5).
//
// A reminder stays in the digests until someone marks it done. On the summary day a
// done occurrence leaves the list and one whose time has passed is marked open. Older
// undone ones are carried over as "open since <day>", only to the two people
// responsible for them (its effective owner and its creator), newest first, at most
// OPEN_REMINDERS_DIGEST_CAP of them. A repeating reminder carries only its latest
// occurrence before the cutoff, and nothing when it also occurs on the summary day:
// that occurrence speaks for it. Nor when that occurrence came before the series was
// armed (created or re-timed): it was never pinged, so it is not open.

import { fromZonedTime } from 'date-fns-tz';
import type { NativeEvent, NativeEventInstance, NativeReminderState } from '@prisma/client';
import type { CalendarEvent, ReminderInfo, UserConfig } from '../../types';
import { prisma } from '../../utils/prisma';
import { captureError } from '../../lib/error-capture';
import { localDate, nextDate, startOfLocalDay } from '../../utils/day-events';
import { isReminderEvent } from '../../utils/event-formatter';
import { expandSeries, latestOccurrenceBefore } from '../native-calendar/recurrence';
import { reminderInfoFor, toUnifiedEvent } from '../calendar-provider/native-provider';
import { effectiveOwnerForViewer, loadViewerContext, type ViewerContext } from './ownership';

export const OPEN_REMINDERS_DIGEST_CAP = 5;

// A date-only reminder is due at this hour of its day. The same rule as the ping's
// (due.ts: REMINDER_MORNING_HOUR, dueAtForOccurrence); read it from there once it exists.
const MORNING_HOUR = 9;
// A repeating reminder's occurrence due more than this before the series was armed was
// never pinged. The same grace as the ping's (due.ts: ARMED_GRACE_MS, isEligible); read it
// from there once it exists.
const ARMED_GRACE_MS = 15 * 60 * 1000;

/** Stands in for a reminder whose info is missing: the viewer's own. */
const OWN_REMINDER: ReminderInfo = { ownerIsViewer: true, creatorIsViewer: true };

/**
 * When a reminder on a digest is due, in the viewer's timezone: its time, or
 * MORNING_HOUR on its date (an all-day start is already the event's own date).
 */
export function reminderDueAt(event: Pick<CalendarEvent, 'start'>, timezone: string): Date {
  if (event.start.includes('T')) return new Date(event.start);
  return fromZonedTime(`${event.start} ${String(MORNING_HOUR).padStart(2, '0')}:00:00`, timezone);
}

/**
 * Where the carry-over ends: the start of the summary day, or now when that comes
 * first. The evening digest is for tomorrow, so what was due earlier today is open,
 * and what is still to come tonight is in neither list: it will ping.
 */
export function openRemindersCutoff(summaryDay: string, timezone: string, now: Date): Date {
  const dayStart = startOfLocalDay(summaryDay, timezone);
  return now < dayStart ? now : dayStart;
}

/**
 * The summary day's own reminders: a done occurrence leaves the list, and one whose
 * time has passed is marked open (a snoozed one too: it is not done). Everything
 * else passes through untouched.
 */
export function shapeDayReminders(events: CalendarEvent[], now: Date, timezone: string): CalendarEvent[] {
  const shaped: CalendarEvent[] = [];
  for (const event of events) {
    if (!isReminderEvent(event)) {
      shaped.push(event);
      continue;
    }
    if (event.reminder?.done) continue;
    const open = reminderDueAt(event, timezone) < now;
    shaped.push(open ? { ...event, reminder: { ...(event.reminder ?? OWN_REMINDER), open: true } } : event);
  }
  return shaped;
}

/** A REMINDER series with what the carry-over reads: its calendar, overrides and state rows. */
export interface OpenReminderCandidate {
  series: NativeEvent;
  calendar: { id: string; name: string };
  overrides: NativeEventInstance[];
  states: Pick<NativeReminderState, 'originalStartsAt' | 'doneAt' | 'snoozedUntil'>[];
}

/**
 * Which reminders a digest carries over, without the database. Each series offers its
 * latest occurrence before `cutoff`; it is carried when it is due before the cutoff,
 * not done, the viewer is its effective owner or its creator (R1), and, for a
 * repeating one, the series has no occurrence on the summary day and the occurrence is
 * not due before `armedAt - ARMED_GRACE_MS`. A one-off has no armed bound: someone set
 * that one item, so it stays a to-do until done, even when its time had already passed.
 * Newest first; the first `cap`, and how many more there are.
 */
export function selectOpenReminders(
  candidates: OpenReminderCandidate[],
  ctx: ViewerContext,
  cutoff: Date,
  summaryDay: string,
  timezone: string,
  now: Date,
  cap: number = OPEN_REMINDERS_DIGEST_CAP
): { events: CalendarEvent[]; moreCount: number } {
  const summaryRange = { from: startOfLocalDay(summaryDay, timezone), to: startOfLocalDay(nextDate(summaryDay), timezone) };
  const open: Array<{ due: Date; event: CalendarEvent }> = [];
  for (const { series, calendar, overrides, states } of candidates) {
    // R1: carried over only to its effective owner and its creator
    if (effectiveOwnerForViewer(series, ctx) !== ctx.viewerId && series.creatorUserId !== ctx.viewerId) continue;
    const occurrence = latestOccurrenceBefore(series, overrides, cutoff);
    if (!occurrence) continue;
    if (series.rrule && expandSeries(series, summaryRange, overrides).length > 0) continue;
    const event = toUnifiedEvent(calendar, occurrence);
    const due = reminderDueAt(event, timezone);
    if (due >= cutoff) continue; // a date-only one whose morning has not come yet
    // Never armed: due before the series was created or re-timed, so never pinged and
    // with no state. Showing it as open would be a phantom.
    if (series.rrule && series.armedAt && due.getTime() < series.armedAt.getTime() - ARMED_GRACE_MS) continue;
    const key = occurrence.instanceStartsAt.getTime();
    const state = states.find(s => s.originalStartsAt.getTime() === key);
    if (state?.doneAt) continue;
    const info = reminderInfoFor(series, state, ctx, now);
    info.openSince = localDate(due, timezone);
    open.push({ due, event: { ...event, eventType: 'reminder', reminder: info } });
  }
  open.sort((a, b) => b.due.getTime() - a.due.getTime());
  return { events: open.slice(0, cap).map(o => o.event), moreCount: Math.max(0, open.length - cap) };
}

/**
 * The viewer's open reminders from before `cutoff` (see selectOpenReminders), in one
 * read: the REMINDER series they created, and those their ACTIVE partner made for
 * them, whatever the calendar's privacy, on calendars that still exist. The digest's
 * cap by default; pass Infinity for all of them.
 */
export async function fetchOpenReminders(
  user: UserConfig,
  ctx: ViewerContext,
  cutoff: Date,
  summaryDay: string,
  timezone: string,
  cap: number = OPEN_REMINDERS_DIGEST_CAP
): Promise<{ events: CalendarEvent[]; moreCount: number }> {
  if (user.calendarSource !== 'NATIVE') return { events: [], moreCount: 0 };
  const rows = await prisma.nativeEvent.findMany({
    where: {
      kind: 'REMINDER',
      isDeleted: false,
      startsAt: { lt: cutoff },
      calendar: { isDeleted: false },
      OR: [
        { creatorUserId: ctx.viewerId },
        ...(ctx.partner ? [{ creatorUserId: ctx.partner.id, forUserId: ctx.viewerId }] : []),
      ],
    },
    include: { calendar: true, instances: true, states: true },
  });
  const candidates = rows.map(row => ({ series: row, calendar: row.calendar, overrides: row.instances, states: row.states }));
  return selectOpenReminders(candidates, ctx, cutoff, summaryDay, timezone, new Date(), cap);
}

/**
 * A digest's reminders, for summary.ts after shapeEventsForDay: done ones leave the
 * day, past-due ones are marked open, and the viewer's older open ones follow the
 * day's own, with a count of those past the cap. Only built-in calendar users have
 * reminders; anyone else's events come back as they were. A failed carry-over costs
 * the digest its open lines, never the digest.
 */
export async function addDigestReminders(
  user: UserConfig,
  dayEvents: CalendarEvent[],
  summaryDay: string,
  timezone: string,
  now: Date = new Date()
): Promise<{ events: CalendarEvent[]; moreCount: number }> {
  if (user.calendarSource !== 'NATIVE') return { events: dayEvents, moreCount: 0 };
  const events = shapeDayReminders(dayEvents, now, timezone);
  try {
    const ctx = await loadViewerContext(user);
    const open = await fetchOpenReminders(user, ctx, openRemindersCutoff(summaryDay, timezone, now), summaryDay, timezone);
    return { events: [...events, ...open.events], moreCount: open.moreCount };
  } catch (error) {
    captureError(error, 'native-reminders-open', { user_id: user.id }, 'warning');
    return { events, moreCount: 0 };
  }
}
```

The "open" due time here is the viewer's (`timezone`), which is who reads the digest; the ping (Task 8) uses the recipient's. `captureError` logs to the console itself, so no separate `console.error`.

Whose a carried reminder is, and whether it is snoozed, comes from Task 5's exported `reminderInfoFor` (the same function the native provider uses for the day's own reminders), so this file has no copy of the attribution rules. The R1 filter calls `effectiveOwnerForViewer` directly, before any expansion, so a reminder the viewer may not see costs nothing.

`MORNING_HOUR` and `ARMED_GRACE_MS` are local because `due.ts` arrives in Task 8. Keep both declarations, with their comments, exactly as written above: Task 8 Step 11 finds that text and replaces it with imports from `./due`. The armed bound is the ping's (plan ruling 4): a repeating series' occurrence due before `armedAt - 15 min` was never pinged and has no state, so it is not carried. One-offs are not bounded.

- [ ] **Step 5: Digests carry reminders and file them by owner**

In `src/services/telegram/summary.ts`, find (line 19):
```ts
import { getCalendarsByLabel, getPrimaryCalendar, getSpouseInfo } from '../../utils/calendar-helpers';
```
Replace with:
```ts
import { getCalendarsByLabel, getPrimaryCalendar, getSpouseInfo } from '../../utils/calendar-helpers';
import { isReminderEvent } from '../../utils/event-formatter';
import { addDigestReminders } from '../native-reminders/open-reminders';
```

Find (lines 43-53, the body of `categorizeEvents`):
```ts
  const resolved = assignments ?? user.calendarAssignments ?? [];
  const ownCalendars = getCalendarsByLabel(resolved, 'yours');
  const spouseCalendars = getCalendarsByLabel(resolved, 'spouse');

  return {
    userEvents: events.filter(e => ownCalendars.includes(e.calendarId)),
    spouseEvents: events.filter(e => spouseCalendars.includes(e.calendarId)),
    otherEvents: events.filter(
      e => !ownCalendars.includes(e.calendarId) && !spouseCalendars.includes(e.calendarId)
    ),
  };
```
Replace with:
```ts
  const resolved = assignments ?? user.calendarAssignments ?? [];
  const ownCalendars = getCalendarsByLabel(resolved, 'yours');
  const spouseCalendars = getCalendarsByLabel(resolved, 'spouse');
  // A reminder goes by whose it is, not by its calendar: the viewer's own (set by them
  // or for them) are theirs, the partner's go to the partner. Never to otherEvents,
  // which feeds the kid-name follow-up.
  const isOwn = (e: CalendarEvent) =>
    isReminderEvent(e) ? e.reminder?.ownerIsViewer !== false : ownCalendars.includes(e.calendarId);
  const isSpouse = (e: CalendarEvent) =>
    isReminderEvent(e) ? e.reminder?.ownerIsViewer === false : spouseCalendars.includes(e.calendarId);

  return {
    userEvents: events.filter(isOwn),
    spouseEvents: events.filter(isSpouse),
    otherEvents: events.filter(e => !isOwn(e) && !isSpouse(e)),
  };
```
For anything that is not a reminder (every Google event) the three lists are exactly the old ones.

Find (lines 109-111, in `prepareSummaryForUser`):
```ts
  const dayNoon = fromZonedTime(`${day} 12:00:00`, userTimezone);
  const events = shapeEventsForDay(await fetchFunction(user, allCalendarIds, userTimezone), day, userTimezone);
  const calendarMs = Date.now() - tCalendar;
```
Replace with:
```ts
  const dayNoon = fromZonedTime(`${day} 12:00:00`, userTimezone);
  const dayEvents = shapeEventsForDay(await fetchFunction(user, allCalendarIds, userTimezone), day, userTimezone);
  // Built-in calendar reminders: done ones leave the day, past-due ones are marked
  // open, and older open ones join after the day's own (shaping would drop them).
  // Anyone else's events pass through as they are.
  const { events, moreCount: openRemindersMore } = await addDigestReminders(user, dayEvents, day, userTimezone);
  const calendarMs = Date.now() - tCalendar;
```

Find (lines 125-129):
```ts
  const userContext: SummaryUserContext = {
    culture: user.culture,
    globalRules: user.globalRules,
    calendarAssignments: assignments,
  };
```
Replace with:
```ts
  const userContext: SummaryUserContext = {
    culture: user.culture,
    globalRules: user.globalRules,
    calendarAssignments: assignments,
    openRemindersMore,
  };
```

- [ ] **Step 6: The summary prompt data and the week builders' labels (`claude.ts`)**

In `src/services/claude.ts`, find (line 7):
```ts
import { formatEventList } from '../utils/event-formatter';
```
Replace with:
```ts
import { formatEventList, isReminderEvent, reminderAttribution } from '../utils/event-formatter';
```

Find (lines 75-79):
```ts
export interface SummaryUserContext {
  culture?: string;
  globalRules?: string[];
  calendarAssignments?: CalendarAssignment[];
}
```
Replace with:
```ts
export interface SummaryUserContext {
  culture?: string;
  globalRules?: string[];
  calendarAssignments?: CalendarAssignment[];
  /** Open reminders past the digest's cap, left out of the event lists. */
  openRemindersMore?: number;
}
```

Find (lines 185-188, the end of `buildPromptData`; the week builders end differently, so this is unique):
```ts
    calendarRules,
    hasKidsCalendars,
  };
}
```
Replace with:
```ts
    calendarRules,
    hasKidsCalendars,
    hasReminders: [userEvents, spouseEvents, otherEvents].some(list => list.some(isReminderEvent)),
    openRemindersMore: userContext?.openRemindersMore,
  };
}
```

The two week builders (`buildWeekLookaheadPromptData` and `buildNextWeekPromptData`) hold identical time-label code. Make each of the next three edits with `replace_all: true`; each must replace exactly two occurrences.

Find (lines 475 and 636):
```ts
    const birthdayLabel = language === 'he' ? 'יום הולדת' : language === 'ru' ? 'День рождения' : 'Birthday';
```
Replace all with:
```ts
    const birthdayLabel = language === 'he' ? 'יום הולדת' : language === 'ru' ? 'День рождения' : 'Birthday';
    const reminderLabel = language === 'he' ? 'תזכורת' : language === 'ru' ? 'Напоминание' : 'Reminder';
```

Find (lines 484-493 and 645-654):
```ts
      } else if (event.isAllDay) {
        timeLabel = allDayLabel;
      } else {
        timeLabel = event.start.toLocaleTimeString(intlLocale, {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
          timeZone: timezone,
        });
      }
```
Replace all with:
```ts
      } else if (event.isAllDay) {
        // A date-only reminder has no time to show
        timeLabel = event.reminder ? reminderLabel : allDayLabel;
      } else {
        timeLabel = event.start.toLocaleTimeString(intlLocale, {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
          timeZone: timezone,
        });
        // A reminder is one moment: "Reminder 10:00", never a range
        if (event.reminder) timeLabel = `${reminderLabel} ${timeLabel}`;
      }
```

Find (lines 503-504 and 664-665):
```ts
        isBirthday: event.isBirthday || undefined,
      };
```
Replace all with:
```ts
        isBirthday: event.isBirthday || undefined,
        ...(event.reminder ? { isReminder: true, reminderNote: reminderAttribution(event) } : {}),
      };
```

Check: `grep -c "const reminderLabel" src/services/claude.ts` prints `2`, and `grep -c "isReminder: true" src/services/claude.ts` prints `2`.

- [ ] **Step 7: Week lookahead events carry the reminder**

In `src/services/week-lookahead.ts`, find (line 6):
```ts
import { CalendarEvent, CalendarAssignment, CalendarLabel, UserConfig } from '../types';
```
Replace with:
```ts
import { CalendarEvent, CalendarAssignment, CalendarLabel, ReminderInfo, UserConfig } from '../types';
```

Find (line 10):
```ts
import { eventTimeLabel, isAllDayEvent, isBirthdayEvent } from '../utils/event-formatter';
```
Replace with:
```ts
import { eventTimeLabel, isAllDayEvent, isBirthdayEvent, isReminderEvent, reminderAttribution } from '../utils/event-formatter';
```

Find (lines 36-39, the end of `LookaheadEvent`):
```ts
  daysFromNow: number;
  isAllDay: boolean;
  isBirthday: boolean;
}
```
Replace with:
```ts
  daysFromNow: number;
  isAllDay: boolean;
  isBirthday: boolean;
  /** Set on a built-in calendar reminder: whose it is, from the viewer's side. */
  reminder?: ReminderInfo;
}
```

Find (lines 265-267, in `filterAndBuildLookaheadEvents`):
```ts
  for (const event of events) {
    const birthday = isBirthdayEvent(event);
    const allDay = isAllDayEvent(event);
```
Replace with:
```ts
  for (const event of events) {
    const birthday = isBirthdayEvent(event);
    const allDay = isAllDayEvent(event);
    // A reminder is listed only on its own day: having no duration, it is never running
    // on the first day. One already done is not coming up.
    const reminder = isReminderEvent(event) ? event.reminder ?? { ownerIsViewer: true, creatorIsViewer: true } : undefined;
    if (reminder?.done) continue;
```

Find (lines 333-336):
```ts
      isAllDay: allDay,
      isBirthday: birthday,
      runningLabel,
    });
```
Replace with:
```ts
      isAllDay: allDay,
      isBirthday: birthday,
      runningLabel,
      ...(reminder ? { reminder } : {}),
    });
```

Find (lines 401-404, in `formatTomorrowLookahead`):
```ts
      if (e.isBirthday) {
        return `${dayName}: ${e.summary} (Birthday)`;
      }
      if (e.isAllDay) {
```
Replace with:
```ts
      if (e.isBirthday) {
        return `${dayName}: ${e.summary} (Birthday)`;
      }
      if (e.reminder) {
        // The daily summary's reminder label: one moment, with whose it is
        const label = e.isAllDay
          ? 'Reminder (all day)'
          : `Reminder ${e.start.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: timezone })}`;
        const attribution = reminderAttribution(e);
        return `${dayName}: ${e.summary} (${label})${attribution ? ` (${attribution})` : ''}`;
      }
      if (e.isAllDay) {
```

- [ ] **Step 8: The daily summary prompts (en/he/ru)**

In `src/prompts/calendar-summary/types.ts`, find (line 28):
```ts
  hasKidsCalendars?: boolean;  // Whether user has kids calendars configured
```
Replace with:
```ts
  hasKidsCalendars?: boolean;  // Whether user has kids calendars configured
  hasReminders?: boolean;      // Built-in calendar reminders are in the lists (adds the reminders guideline)
  openRemindersMore?: number;  // Open reminders past the digest's cap, not in the lists
```

In each of `src/prompts/calendar-summary/en.ts`, `he.ts` and `ru.ts` there are two edits: a guideline builder inserted before `buildCalendarSummaryPrompt`, and its call before the kids' pickup rules. Without reminders the builder returns `''`, so every Google and reminder-free prompt is byte-identical to today's. The markers stay English in every language, as the existing ones do ("(Birthday)", "next day").

`en.ts` — find (line 65):
```ts
export function buildCalendarSummaryPrompt(data: SummaryPromptData): string {
```
Replace with:
```ts
// Only digests with reminders get this, so every other prompt stays as it was.
function buildRemindersGuideline(data: SummaryPromptData): string {
  if (!data.hasReminders) return '';
  const n = data.openRemindersMore ?? 0;
  const more = n
    ? ` ${n === 1 ? '1 more open reminder is' : `${n} more open reminders are`} not in the lists: after the open ones, say so in one short line ("${n === 1 ? 'and 1 more open reminder' : `and ${n} more open reminders`}").`
    : '';
  return `- **Reminders**: Items marked "Reminder" are reminders: one moment, never a time range. Show each as "HH:MM ⏰ [task]", or "⏰ [task]" when it has no time ("all day"), in the section of the person it is for, with no end time. "(open)" means its time has passed and it isn't done yet: add "(still open)". "open since Tue 12 Oct" means it is still open from that earlier day: list it briefly after the day's own items, as "⏰ [task] (open since Tuesday)", never as happening on this day. "(from [Name])" means [Name] set it for the user: keep "(from [Name])". "(for [Name], you asked)" means the user set it for [Name]: show it in [Name]'s section with "(you asked)".${more}
`;
}

export function buildCalendarSummaryPrompt(data: SummaryPromptData): string {
```
`en.ts` — find (line 189):
```ts
${data.hasKidsCalendars ? `- **CRITICAL: Pickup Order MUST be sorted chronologically by time (earliest first)**
```
Replace with:
```ts
${buildRemindersGuideline(data)}${data.hasKidsCalendars ? `- **CRITICAL: Pickup Order MUST be sorted chronologically by time (earliest first)**
```

`he.ts` — find (line 66):
```ts
export function buildCalendarSummaryPrompt(data: SummaryPromptData): string {
```
Replace with:
```ts
// Only digests with reminders get this, so every other prompt stays as it was.
function buildRemindersGuideline(data: SummaryPromptData): string {
  if (!data.hasReminders) return '';
  const n = data.openRemindersMore ?? 0;
  const more = n
    ? ` ${n === 1 ? 'עוד תזכורת פתוחה אחת לא מופיעה' : `עוד ${n} תזכורות פתוחות לא מופיעות`} ברשימות: אחרי הפתוחות, ציין זאת בשורה קצרה אחת ("${n === 1 ? 'ועוד תזכורת פתוחה אחת' : `ועוד ${n} תזכורות פתוחות`}").`
    : '';
  return `- **תזכורות**: פריטים שמסומנים "Reminder" הם תזכורות: רגע אחד, לעולם לא טווח שעות. הצג כל אחת כ"HH:MM ⏰ [משימה]", או "⏰ [משימה]" כשאין לה שעה ("all day"), בחלק של מי שהיא בשבילו, בלי שעת סיום. "(open)" אומר שהשעה שלה עברה והיא עוד לא בוצעה: הוסף "(עדיין פתוחה)". "open since Tue 12 Oct" אומר שהיא פתוחה עוד מאותו יום: הצג אותה בקצרה אחרי פריטי היום, כ"⏰ [משימה] (פתוחה מיום שלישי)", ולעולם לא כאילו היא ביום הזה. "(from [שם])" אומר ש[שם] קבע/ה אותה למשתמש: הוסף "(מאת [שם])". "(for [שם], you asked)" אומר שהמשתמש קבע אותה ל[שם]: הצג אותה בחלק של [שם] עם "(לבקשתך)".${more}
`;
}

export function buildCalendarSummaryPrompt(data: SummaryPromptData): string {
```
`he.ts` — find (line 191):
```ts
${data.hasKidsCalendars ? `- **קריטי: סדר האיסוף חייב להיות ממוין כרונולוגית לפי שעה (הכי מוקדם קודם)**
```
Replace with:
```ts
${buildRemindersGuideline(data)}${data.hasKidsCalendars ? `- **קריטי: סדר האיסוף חייב להיות ממוין כרונולוגית לפי שעה (הכי מוקדם קודם)**
```

`ru.ts` (this prompt addresses the model and the user with "вы") — find (line 66):
```ts
export function buildCalendarSummaryPrompt(data: SummaryPromptData): string {
```
Replace with:
```ts
// Only digests with reminders get this, so every other prompt stays as it was.
function buildRemindersGuideline(data: SummaryPromptData): string {
  if (!data.hasReminders) return '';
  const n = data.openRemindersMore ?? 0;
  const more = n
    ? ` Не сделанных напоминаний, которые не вошли в списки: ${n}. После открытых скажите об этом одной короткой строкой (например: "и ещё ${n} не сделано", с правильным согласованием).`
    : '';
  return `- **Напоминания**: Пункты с пометкой "Reminder" — это напоминания: один момент, а не промежуток времени. Показывайте каждое как "HH:MM ⏰ [дело]" или "⏰ [дело]", если времени нет ("all day"), в разделе того, для кого оно, без времени окончания. "(open)" значит, что его время прошло, а оно ещё не сделано: добавьте "(ещё не сделано)". "open since Tue 12 Oct" значит, что оно не сделано с того дня: покажите его коротко после событий дня, как "⏰ [дело] (не сделано со вторника)", и никогда не подавайте как событие этого дня. "(from [Имя])" значит, что [Имя] поставил(а) это напоминание пользователю: добавьте "(от [Имя])". "(for [Имя], you asked)" значит, что пользователь поставил его для [Имя]: покажите его в разделе [Имя] с пометкой "(по вашей просьбе)".${more}
`;
}

export function buildCalendarSummaryPrompt(data: SummaryPromptData): string {
```
`ru.ts` — find (line 193):
```ts
${data.hasKidsCalendars ? `- **КРИТИЧНО: Порядок забора ДОЛЖЕН быть отсортирован хронологически (сначала самое раннее время)**
```
Replace with:
```ts
${buildRemindersGuideline(data)}${data.hasKidsCalendars ? `- **КРИТИЧНО: Порядок забора ДОЛЖЕН быть отсортирован хронологически (сначала самое раннее время)**
```

The ⏰ the digest prints on reminder lines is what the voice show keys its rule on (Step 10).

- [ ] **Step 9: The week prompts (en/he/ru)**

In `src/prompts/week-lookahead/types.ts`, find (line 12, in `LookaheadEventData`):
```ts
  isBirthday?: boolean;
}
```
Replace with:
```ts
  isBirthday?: boolean;
  isReminder?: boolean;      // A built-in calendar reminder: one moment; its time reads "Reminder 10:00"
  reminderNote?: string;     // Whose reminder, in English like the daily markers: "from Dana", "for Dana, you asked"
}
```

In each of `src/prompts/week-lookahead/en.ts`, `he.ts` and `ru.ts`, make three edits. The first two are the same text in all three files.

Edit 1 — find (line 41):
```ts
    return `  - ${event.time} - ${event.summary} (${event.calendarName})${recurNote}`;
```
Replace with:
```ts
    const reminderNote = event.reminderNote ? ` (${event.reminderNote})` : '';
    return `  - ${event.time} - ${event.summary} (${event.calendarName})${recurNote}${reminderNote}`;
```

Edit 2 — find (line 46):
```ts
function buildEventsSection(data: WeekLookaheadPromptData): string {
```
Replace with the builder for that file's language, followed by the same line:

`en.ts`:
```ts
// Only weeks with reminders get this, so every other prompt stays as it was.
function buildRemindersGuideline(data: WeekLookaheadPromptData): string {
  if (!data.eventsByDay.some(day => day.events.some(event => event.isReminder))) return '';
  return `- **Reminders**: Times starting with "Reminder" are reminders: one moment, never a range. Mention each briefly as a to-do, with ⏰ and its time ("⏰ call the plumber at 10:00"); one with no time is simply for that day. "(from [Name])" means [Name] set it for the user; "(for [Name], you asked)" means the user set it for [Name].
`;
}

function buildEventsSection(data: WeekLookaheadPromptData): string {
```
`he.ts`:
```ts
// Only weeks with reminders get this, so every other prompt stays as it was.
function buildRemindersGuideline(data: WeekLookaheadPromptData): string {
  if (!data.eventsByDay.some(day => day.events.some(event => event.isReminder))) return '';
  return `- **תזכורות**: זמנים שמתחילים ב"תזכורת" הם תזכורות: רגע אחד, לא טווח. הזכר כל אחת בקצרה כמשימה, עם ⏰ והשעה שלה ("⏰ להתקשר לאינסטלטור ב-10:00"); תזכורת בלי שעה היא פשוט לאותו יום. "(from [שם])" אומר ש[שם] קבע/ה אותה למשתמש; "(for [שם], you asked)" אומר שהמשתמש קבע אותה ל[שם].
`;
}

function buildEventsSection(data: WeekLookaheadPromptData): string {
```
`ru.ts` (this prompt uses "ты"):
```ts
// Only weeks with reminders get this, so every other prompt stays as it was.
function buildRemindersGuideline(data: WeekLookaheadPromptData): string {
  if (!data.eventsByDay.some(day => day.events.some(event => event.isReminder))) return '';
  return `- **Напоминания**: Время, начинающееся с "Напоминание", — это напоминания: один момент, а не промежуток. Упоминай каждое коротко, как дело, с ⏰ и временем ("⏰ позвонить сантехнику в 10:00"); напоминание без времени просто относится к этому дню. "(from [Имя])" значит, что [Имя] поставил(а) его пользователю; "(for [Имя], you asked)" — что пользователь поставил его для [Имя].
`;
}

function buildEventsSection(data: WeekLookaheadPromptData): string {
```

Edit 3 — call it right after the Birthdays guideline:

`en.ts`, find (lines 109-110):
```ts
- **Birthdays**: Events with time "Birthday" — present naturally with the person's name extracted from the title (e.g., "John's Birthday" → "It's John's birthday"). No time needed.
- **Format**: Use Telegram HTML tags: <b>bold</b>, <i>italic</i>
```
Replace with:
```ts
- **Birthdays**: Events with time "Birthday" — present naturally with the person's name extracted from the title (e.g., "John's Birthday" → "It's John's birthday"). No time needed.
${buildRemindersGuideline(data)}- **Format**: Use Telegram HTML tags: <b>bold</b>, <i>italic</i>
```
`he.ts`, find (lines 111-112):
```ts
- **ימי הולדת**: אירועים עם זמן "יום הולדת" — הצג בצורה טבעית עם שם האדם מהכותרת (לדוגמה: "יום ההולדת של יוחנן" → "יום הולדת של יוחנן"). אין צורך בשעה.
- **פורמט**: השתמש בתגי HTML של טלגרם: <b>מודגש</b>, <i>נטוי</i>
```
Replace with:
```ts
- **ימי הולדת**: אירועים עם זמן "יום הולדת" — הצג בצורה טבעית עם שם האדם מהכותרת (לדוגמה: "יום ההולדת של יוחנן" → "יום הולדת של יוחנן"). אין צורך בשעה.
${buildRemindersGuideline(data)}- **פורמט**: השתמש בתגי HTML של טלגרם: <b>מודגש</b>, <i>נטוי</i>
```
`ru.ts`, find (lines 109-110):
```ts
- **Дни рождения**: События со временем "День рождения" — представляй естественно с именем человека из названия (например: "День рождения Ивана" → "День рождения Ивана"). Время не нужно.
- **Форматирование**: Используй HTML-теги Telegram: <b>жирный</b>, <i>курсив</i>
```
Replace with:
```ts
- **Дни рождения**: События со временем "День рождения" — представляй естественно с именем человека из названия (например: "День рождения Ивана" → "День рождения Ивана"). Время не нужно.
${buildRemindersGuideline(data)}- **Форматирование**: Используй HTML-теги Telegram: <b>жирный</b>, <i>курсив</i>
```

None of the new text contains "Week Ahead", "end of week", "סוף השבוע" or "Конец недели", which `buildNextWeekPrompt` rewrites by regex.

- [ ] **Step 10: The voice show rule (en/he/ru)**

The show reads only the finished summary. The rule is added only when that summary has a ⏰ line, so a summary without reminders gets today's prompt byte for byte, and "Every event in the summary goes in, with its time" stays as it is for events.

In each of `src/prompts/voice-show/en.ts`, `he.ts`, `ru.ts`, find (line 15 in en/he, 17 in ru):
```ts
const SOUND_LIST = SOUND_TAGS.map(sound => `<${sound}>`).join(' ');
```
Replace with the same line plus that language's rule:

`en.ts`:
```ts
const SOUND_LIST = SOUND_TAGS.map(sound => `<${sound}>`).join(' ');

// The digests mark built-in calendar reminders with ⏰; only a summary that has one gets this rule.
const REMINDERS_RULE =
  'Reminders (marked ⏰ in the summary) go in too, one quick line each and never a segment of their own: the task, and its time if it has one. One the summary calls still open is said as still open (e.g. "still open since Tuesday"), never as one of the day\'s events.';
```
`he.ts`:
```ts
const SOUND_LIST = SOUND_TAGS.map(sound => `<${sound}>`).join(' ');

// The digests mark built-in calendar reminders with ⏰; only a summary that has one gets this rule.
const REMINDERS_RULE =
  'תזכורות (מסומנות ⏰ בסיכום) נכנסות גם הן, שורה קצרה לכל אחת ולעולם לא קטע משלהן: המשימה, והשעה אם יש לה. תזכורת שהסיכום אומר שהיא עדיין פתוחה נאמרת כפתוחה (למשל "עדיין פתוחה מיום שלישי"), ולעולם לא כאחד מאירועי היום.';
```
`ru.ts`:
```ts
const SOUND_LIST = SOUND_TAGS.map(sound => `<${sound}>`).join(' ');

// The digests mark built-in calendar reminders with ⏰; only a summary that has one gets this rule.
const REMINDERS_RULE =
  'Напоминания (в сводке они с ⏰) тоже входят, по одной короткой фразе на каждое и никогда не отдельным блоком: дело и время, если оно есть. Напоминание, которое в сводке ещё не сделано, так и называйте (например, "ещё не сделано со вторника"), и никогда не подавайте как одно из событий дня.';
```

Then in each of the three files, find (en 121-122, he 135-136, ru 132-133):
```ts
  const allContent = [
    ...content,
```
Replace with:
```ts
  const allContent = [
    ...content,
    ...(context.summary.includes('⏰') ? [REMINDERS_RULE] : []),
```

- [ ] **Step 11: Run the tests to verify they pass**

```bash
TZ=UTC npx tsx scripts/smoke-native-reminder-digest.ts | grep -v '^OK'
TZ=Asia/Jerusalem npx tsx scripts/smoke-native-reminder-digest.ts | grep -v '^OK'
TZ=UTC npx tsx scripts/smoke-day-shaping.ts | grep -v '^OK'
TZ=Asia/Jerusalem npx tsx scripts/smoke-day-shaping.ts | grep -v '^OK'
TZ=UTC npx tsx scripts/smoke-week-lookahead.ts 2>/dev/null | grep -v '^OK'
TZ=Asia/Jerusalem npx tsx scripts/smoke-week-lookahead.ts 2>/dev/null | grep -v '^OK'
for tz in UTC Asia/Jerusalem; do
  for s in smoke-reminders smoke-partner-labels smoke-native-provider-reminders smoke-recurrence smoke-native-reminder-ownership; do
    echo "$tz $s: $(TZ=$tz npx tsx scripts/$s.ts | tail -1)"
  done
done
npx tsx scripts/smoke-voice-show-writer.ts | tail -1
npx tsc --noEmit -p .
npm run -s lint
```

Expected:
- Digest smoke: only `[AI Summary Timing] …` log lines and `31/31 passed (process TZ=UTC)` / `31/31 passed (process TZ=Asia/Jerusalem)`, exit 0.
- `smoke-day-shaping`: no `FAIL` lines; `36/36 passed` under both clocks (24 at `40461c4`, 4 from Task 3, 8 here).
- `smoke-week-lookahead`: no `FAIL` lines; `22/22 passed` under both clocks (18 before, plus the four `(f)` checks).
- The loop, every line under both clocks: `smoke-reminders` `23/23 passed`; `smoke-partner-labels` `18/18 passed` (Task 6 always creates it; it calls `categorizeEvents` with plain events, whose filing is unchanged); `smoke-native-provider-reminders` `11/11 passed` (it shares `toUnifiedEvent` and `reminderInfoFor` with the carry-over); `smoke-recurrence` `35/35 passed`; `smoke-native-reminder-ownership` `22/22 passed`.
- `smoke-voice-show-writer`: `19/19 passed` (its summaries have no ⏰, so its prompts are unchanged).
- `tsc` prints nothing and exits 0; `lint` prints nothing and exits 0.

- [ ] **Step 12: Commit**

```bash
git add src/utils/event-formatter.ts \
  src/services/native-reminders/open-reminders.ts \
  src/services/telegram/summary.ts \
  src/services/claude.ts \
  src/services/week-lookahead.ts \
  src/prompts/calendar-summary/types.ts src/prompts/calendar-summary/en.ts src/prompts/calendar-summary/he.ts src/prompts/calendar-summary/ru.ts \
  src/prompts/week-lookahead/types.ts src/prompts/week-lookahead/en.ts src/prompts/week-lookahead/he.ts src/prompts/week-lookahead/ru.ts \
  src/prompts/voice-show/en.ts src/prompts/voice-show/he.ts src/prompts/voice-show/ru.ts \
  scripts/smoke-native-reminder-digest.ts scripts/smoke-day-shaping.ts scripts/smoke-week-lookahead.ts
git commit -F - <<'EOF'
feat(reminders): digests and week views show reminders and carry open ones

A reminder reads as one moment ("Reminder 10:00", never "10:00 - 10:00").
In the digests a done one leaves its day, a past-due one is open, and
older undone ones are carried over as "open since <day>" to their owner
and creator only: newest first, five at most, then "and N more". A
repeating reminder carries only its latest missed occurrence, and none
when it also falls on the summary day or came before the series was
armed (it was never pinged). Reminders are filed by whose they
are, never under "other". Week views and the tomorrow lookahead label
them too, and the prompts and the voice show get a reminders rule only
when reminders are present, so Google users' prompts are unchanged.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
EOF
```

---

### Task 8: The firing pass

**Files:**
- Create: `src/services/native-reminders/due.ts` — pure due-time and eligibility math (`REMINDER_MORNING_HOUR`, `PING_LOOKBACK_MS`, `ARMED_GRACE_MS`, `MAX_PING_ATTEMPTS`, `dueAtForOccurrence`, `tomorrowMorning`, `isEligible`).
- Create: `src/services/native-reminders/claim.ts` — the spec §4.3 conditional upsert (`claimOccurrence`) and `releaseClaim`.
- Create: `src/services/native-reminders/ping.ts` — ping text, keyboard, send, and `stripPingButtons`.
- Create: `src/services/native-reminders/pass.ts` — `runNativeReminderPass`: candidate query, expansion, recipient checks, claim, send.
- Create: `app/api/native-reminders/route.ts` — manual trigger behind `CRON_SECRET` (`withCronHandler`), like `app/api/reminders/route.ts`.
- Modify: `src/services/analytics-service.ts:36-37` — `ActivityAction` gains the four `native_reminder_*` values. (`importantActions` at :179 only feeds Sentry, and `featureActions` at :343 only an admin breakdown, so neither changes.)
- Modify: `src/cron/handlers.ts:199-204` — `handleNativeReminders()`, with its running flag and alert throttle on `globalThis`, inserted before the `handleSetupReminders` doc comment.
- Modify: `src/cron/scheduler.ts:25-27` and `:80` — a `* * * * *` job after the 5-minute event-alert job, and its line in the startup log.
- Modify: `src/services/native-reminders/open-reminders.ts` (Task 7) — its local `MORNING_HOUR` and `ARMED_GRACE_MS` constants give way to imports of `REMINDER_MORNING_HOUR` and `ARMED_GRACE_MS` from `due.ts`, as their own comments ask.
- Test: `scripts/smoke-native-reminders.ts` (new). Regression: `scripts/smoke-reminders.ts`, which runs the real `src/cron/handlers.ts`, and, because `open-reminders.ts` now imports `due.ts`, `scripts/smoke-native-reminder-ownership.ts`, `scripts/smoke-native-reminder-store.ts`, `scripts/smoke-native-reminder-support.ts`, `scripts/smoke-native-provider-reminders.ts` and `scripts/smoke-native-reminder-digest.ts`.

**Interfaces:**
- Consumes:
  - Task 1, `src/services/native-reminders/ownership.ts`: `getActivePartnerSummary(userId: number, pairingId: string | null): Promise<PartnerSummary | null>` and `effectiveOwnerId(series: { creatorUserId: number; forUserId: number | null }, creatorPartner: { id: number; calendarSource: string } | null): number`.
  - Task 1, `src/services/native-reminders/due-gate.ts`: `shouldRunPass(now: Date): boolean`, `setNextDue(next: Date | null, now: Date): void`, `invalidateDueGate(): void`, `__resetDueGateForTests(): void`. Its state (`nextDueAt`, `writtenSinceGate`) lives on `globalThis` under `__nativeReminderDueGate`, so the scheduler bundle and the route bundles share it. `invalidateDueGate()` sets `nextDueAt = 0` and `writtenSinceGate = true`; `shouldRunPass` clears the flag when it returns true (the start of a pass); `setNextDue` is a no-op while the flag is set. Task 1's rule applies: the handler checks its `running` flag (also on `globalThis`) before `shouldRunPass`, and calls `setNextDue` only after a successful pass.
  - Task 1, Prisma: `NativeEvent.kind` (`'EVENT' | 'REMINDER'`), `forUserId`, `armedAt`; `prisma.nativeReminderState` with the compound unique `seriesEventId_originalStartsAt`, `pingChatId: bigint | null`, `pingMessageId`, `pingAttempts`.
  - Task 2: the store writes every REMINDER zero-length with `armedAt` set, and deletes the affected state rows when a reminder's time changes. The pass therefore has no re-arm logic of its own.
  - Task 3: `expandSeries` reads a date-only `UNTIL` as covering its whole last day. The signature is unchanged.
  - Task 4, `src/services/native-reminders/support.ts`: `isNativeRemindersEnabled(): Promise<boolean>` and `getReminderSupport(user: { id: number; calendarSource: string; telegramId?: bigint | number | string | null }): Promise<ReminderSupport>`. Also `export function escapeHtml(text: string): string` in the leaf module `src/utils/html.ts` (Planning Ruling 3; `confirmations.ts` only re-exports it, and `ping.ts` imports the leaf so the pass never loads the voice chain), and the keys `bot.nativeReminders.ping.from` and `bot.nativeReminders.buttons.{done,snooze15,snooze60,snoozeTomorrow}` in en/he/ru.
  - Task 7, `src/services/native-reminders/open-reminders.ts`: its local `const MORNING_HOUR = 9;` and `const ARMED_GRACE_MS = 15 * 60 * 1000;`, with the comments Step 11 quotes, and the one use of `MORNING_HOUR` in `reminderDueAt`.
  - Existing:
    - `src/lib/delivery-errors.ts`: `isUnreachableError(error)` (:42) and `describeDeliveryError(error)` (:70).
    - `src/lib/user-reachability.ts`: `markUserUnreachable(userId, reason)` (:23).
    - `src/lib/user-moderation.ts`: `isIdentifierBlocked({ telegramId })` (:98).
    - `src/lib/timezone.ts`: `resolveUserTimezone({ id, location })` (:20).
    - `trackActivityAsync`; `getBot` from the `src/services/telegram` barrel; `getBotMessage`/`getBotMessages`.
    - `src/utils/day-events.ts`: `localDate`, `nextDate`, `startOfLocalDay`.
    - `src/lib/cron-handler.ts`: `withCronHandler`.
- Produces (the contract signatures):
  ```ts
  // src/services/native-reminders/due.ts
  export const REMINDER_MORNING_HOUR = 9;
  export const PING_LOOKBACK_MS: number;   // 60 min
  export const ARMED_GRACE_MS: number;     // 15 min
  export const MAX_PING_ATTEMPTS = 3;
  export function dueAtForOccurrence(occ: { startsAt: Date; allDay: boolean; timeZone: string }, recipientTz: string): Date;
  export function tomorrowMorning(now: Date, tz: string): Date;
  export function isEligible(a: { due: Date; now: Date; armedAt: Date | null; snoozed: boolean; lastPingedAt: Date | null; doneAt: Date | null }): boolean;

  // src/services/native-reminders/claim.ts
  // NativeReminderState ids are crypto.randomUUID() (fits the 64-byte callback_data with the 'nr:st:' prefix).
  export interface Claim { id: string; claimedAt: Date; previousLastPingedAt: Date | null; pingAttempts: number }
  export async function claimOccurrence(seriesEventId: string, originalStartsAt: Date, due: Date, now: Date = new Date()): Promise<Claim | null>;
  export async function releaseClaim(claim: Claim): Promise<void>;
  // A snooze writes snoozedUntil and resets pingAttempts to 0 (each re-ping gets its own retry budget); never lastPingedAt.

  // src/services/native-reminders/ping.ts
  export async function buildPingText(a: { title: string; creatorName?: string; language: string }): Promise<string>;
  export async function buildPingKeyboard(stateId: string, language: string): Promise<TelegramBot.InlineKeyboardMarkup>;
  export async function sendPing(chatId: bigint, text: string, keyboard: TelegramBot.InlineKeyboardMarkup): Promise<number>; // message_id
  export async function stripPingButtons(chatId: bigint | number, messageId: number, text: string): Promise<void>;

  // src/services/native-reminders/pass.ts
  export interface NativeReminderPassResult { sent: number; skipped: number; failed: number; nextDue: Date | null }
  export async function runNativeReminderPass(now?: Date): Promise<NativeReminderPassResult>;

  // src/cron/handlers.ts (running flag and alert throttle on globalThis, under __nativeRemindersCron)
  export async function handleNativeReminders(): Promise<void>;

  // src/services/analytics-service.ts: ActivityAction gains
  //   'native_reminder_created' | 'native_reminder_pinged' | 'native_reminder_done' | 'native_reminder_snoozed'
  ```
- Behaviour that Tasks 9, 13 and 14 rely on:
  - **State ids:** a state row's id is `crypto.randomUUID()` (36 chars). The callback data is `nr:d:<id>`, `nr:s15:<id>`, `nr:s60:<id>` or `nr:st:<id>`, at most 43 bytes.
  - **Snoozes (Task 9):** while `doneAt` is null, the pass takes a row's `snoozedUntil` as the occurrence's due time. It re-pings, on the same row with fresh buttons, once `lastPingedAt < snoozedUntil`. A snooze must therefore write `snoozedUntil` only and leave `lastPingedAt` alone.
  - **Ping message ids (Tasks 2 and 13):** `pingChatId` and `pingMessageId` are written right after a successful send.
  - **`stripPingButtons`:** it swallows only "message is not modified" and "message to edit not found" and rethrows anything else. Best-effort callers wrap it in their own try/catch.

**Prerequisite check** (Tasks 1, 4 and 7 must have landed). Every line must print something:
```bash
ls src/services/native-reminders/ownership.ts src/services/native-reminders/due-gate.ts src/services/native-reminders/support.ts
grep -n "__nativeReminderDueGate" src/services/native-reminders/due-gate.ts
grep -n "export function escapeHtml" src/utils/html.ts
grep -n "^const MORNING_HOUR = 9;\|^const ARMED_GRACE_MS = 15 \* 60 \* 1000;" src/services/native-reminders/open-reminders.ts
node -e "for (const l of ['en','he','ru']) { const r = require('./messages/' + l + '.json').bot.nativeReminders; console.log(l, r.ping.from, r.buttons.done, r.buttons.snooze15, r.buttons.snooze60, r.buttons.snoozeTomorrow); }"
grep -n "NativeReminderState\b" node_modules/.prisma/client/index.d.ts | head -1
```

- [ ] **Step 1: Write the failing test**

Create `scripts/smoke-native-reminders.ts`. The script has 40 checks: 9 on due-time math and eligibility, 14 on the pass, 10 on skips and send failures, 3 on the message, and 4 on `nextDue` and the gate.

How it is built:
- **Module stubs:** it follows `scripts/smoke-reminders.ts`. `Module._load` catches `require()`, and `Module.registerHooks` catches the `import()` calls that `handlers.ts` makes.
- **Clock:** a `ClockDate` drives every `new Date()`.
- **Fake Prisma:**
  - It evaluates the `where` shapes the pass uses: equality, null, `in`, `not`, ranges, `OR`, and the `calendar` relation.
  - Its `$queryRaw` runs the claim's ON CONFLICT semantics atomically, one call per statement.
  - It also checks that the claim's SQL reads every timestamp as UTC.
- **Real modules:** `ownership.ts`, `due-gate.ts`, `recurrence.ts` and `src/utils/html.ts` (for `escapeHtml`) are the real ones. `ping.ts` imports the leaf `html.ts`, not `confirmations.ts`, so the voice chain (and `@hebcal/core`) never loads and needs no stub.
- **Expected strings:** they are read from `messages/{en,he}.json`, so a copy tweak in Task 4 doesn't break the checks.

```ts
// Smoke test for the native reminder pass: src/services/native-reminders/due.ts,
// claim.ts, ping.ts and pass.ts, and the 1-minute cron handler handleNativeReminders.
// A reminder pings the person it is for at its time (a date-only one at 09:00 where
// they are), once, through an atomic claim two overlapping passes can't both win, with
// ✅ Done / 💤 Snooze buttons that carry the claimed state row. A failed send is given
// back for a later pass only when the failure may pass, and the cron reads the database
// only when its gate says something may be due.
//
// Prisma (with the claim's ON CONFLICT upsert), Telegram, the timezone lookup, the
// moderation checks and the admin switch are faked; the clock is stepped by hand. No
// network, no DB.
//
// Run under both clocks; the output must not depend on the server's timezone:
//   TZ=UTC npx tsx scripts/smoke-native-reminders.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-native-reminders.ts

import Module from 'node:module';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { fromZonedTime } from 'date-fns-tz';
import { startOfLocalDay } from '../src/utils/day-events';
import en from '../messages/en.json';
import he from '../messages/he.json';

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
}

// Not `asserts cond`: a check re-reads counters and rows that change between asserts,
// and a narrowed `sent.length === 0` would make the next `=== 1` a type error.
function assert(cond: boolean, message: string): void {
  if (!cond) throw new Error(message);
}

/** JSON that can show a BigInt telegramId. */
const show = (value: unknown) => JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? `${v}n` : v));

function assertSame(got: unknown, want: unknown) {
  assert(show(got) === show(want), `\n     got  ${show(got)}\n     want ${show(want)}`);
}

// ---- Clock: every argument-less new Date() and Date.now() reads `clock` ----

let clock = 0;
const RealDate = Date;
class ClockDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(clock);
    else super(...(args as [number, number, number, number, number, number, number]));
  }
  static now() {
    return clock;
  }
}
globalThis.Date = ClockDate as unknown as DateConstructor;

const ms = (value: unknown) => (value instanceof RealDate ? value.getTime() : value);

function assertTime(got: Date | null | undefined, want: Date, label = 'time') {
  assert(!!got && got.getTime() === want.getTime(), `${label}: got ${got ? got.toISOString() : got}, want ${want.toISOString()}`);
}

// ---- Fake Prisma ----

type Row = Record<string, unknown>;
const db = { users: [] as Row[], pairings: [] as Row[], calendars: [] as Row[], events: [] as Row[], instances: [] as Row[], states: [] as Row[] };
/** Every Prisma call, as "<model>.<method>", to see when a pass read the database. */
const queries: string[] = [];
/** Thrown by the next nativeEvent.findMany: the database going away. */
let failNextFind: Error | null = null;
/** Awaited by the next nativeEvent.findMany: a slow pass. */
let holdFind: Promise<void> | null = null;
/** Thrown by the next claim: a database blip in the middle of a pass. */
let failNextClaim: Error | null = null;

// The filters the pass and the claim use: equality, null, in, not, ranges, OR, and the
// event's calendar relation.
const relations: Record<string, (row: Row) => Row | undefined> = {
  calendar: (row) => db.calendars.find((c) => c.id === row.calendarId),
};

function fieldMatches(value: unknown, cond: unknown): boolean {
  if (cond === null) return value == null;
  if (cond instanceof RealDate || typeof cond !== 'object') return ms(value) === ms(cond);
  return Object.entries(cond as Row).every(([op, arg]) => {
    switch (op) {
      case 'in': return (arg as unknown[]).some((a) => ms(a) === ms(value));
      case 'not': return arg === null ? value != null : ms(value) !== ms(arg);
      case 'gte': return value != null && (ms(value) as number) >= (ms(arg) as number);
      case 'gt': return value != null && (ms(value) as number) > (ms(arg) as number);
      case 'lt': return value != null && (ms(value) as number) < (ms(arg) as number);
      case 'lte': return value != null && (ms(value) as number) <= (ms(arg) as number);
      default: throw new Error(`fake prisma: no operator ${op}`);
    }
  });
}

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as Row[]).some((w) => matches(row, w));
    if (key in relations) {
      const related = relations[key](row);
      return !!related && matches(related, cond as Row);
    }
    return fieldMatches(row[key], cond);
  });
}

/** Prisma returns only the selected columns, so a column the code forgets to select is missing. */
const pick = (row: Row | undefined, select?: Record<string, boolean>) =>
  !row ? null : !select ? { ...row } : Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]]));

type Args = { where?: Row; select?: Record<string, boolean>; data?: Row };
const fakePrisma = {
  user: {
    findUnique: async ({ where, select }: Args) => {
      queries.push('user.findUnique');
      return pick(db.users.find((u) => u.id === where!.id), select);
    },
  },
  pairing: {
    findUnique: async ({ where, select }: Args) => {
      queries.push('pairing.findUnique');
      return pick(db.pairings.find((p) => p.id === where!.id), select);
    },
  },
  nativeEvent: {
    findMany: async ({ where }: Args) => {
      queries.push('nativeEvent.findMany');
      if (holdFind) {
        const hold = holdFind;
        holdFind = null;
        await hold;
      }
      if (failNextFind) {
        const error = failNextFind;
        failNextFind = null;
        throw error;
      }
      return db.events.filter((e) => matches(e, where)).map((e) => ({ ...e }));
    },
  },
  nativeEventInstance: {
    findMany: async ({ where }: Args) => {
      queries.push('nativeEventInstance.findMany');
      return db.instances.filter((i) => matches(i, where)).map((i) => ({ ...i }));
    },
  },
  nativeReminderState: {
    findMany: async ({ where, select }: Args) => {
      queries.push('nativeReminderState.findMany');
      return db.states.filter((s) => matches(s, where)).map((s) => pick(s, select));
    },
    findUnique: async ({ where, select }: Args) => {
      queries.push('nativeReminderState.findUnique');
      const key = where!.seriesEventId_originalStartsAt as Row;
      return pick(db.states.find((s) => s.seriesEventId === key.seriesEventId && ms(s.originalStartsAt) === ms(key.originalStartsAt)), select);
    },
    update: async ({ where, data }: Args) => {
      queries.push('nativeReminderState.update');
      const row = db.states.find((s) => s.id === where!.id);
      if (!row) throw new Error('fake prisma: P2025 record not found');
      return Object.assign(row, data);
    },
    updateMany: async ({ where, data }: Args) => {
      queries.push('nativeReminderState.updateMany');
      const rows = db.states.filter((s) => matches(s, where));
      for (const row of rows) Object.assign(row, data);
      return { count: rows.length };
    },
  },
  // The claim: INSERT … ON CONFLICT (seriesEventId, originalStartsAt) DO UPDATE … WHERE
  // not done and not yet pinged for this due … RETURNING. One call is atomic here, as
  // one statement is in Postgres.
  $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    queries.push('$queryRaw');
    if (failNextClaim) {
      const error = failNextClaim;
      failNextClaim = null;
      throw error;
    }
    const sql = strings.join('$');
    assert(
      /INSERT INTO "NativeReminderState"[\s\S]*ON CONFLICT \("seriesEventId", "originalStartsAt"\) DO UPDATE[\s\S]*"doneAt" IS NULL[\s\S]*RETURNING/.test(sql),
      `unexpected claim SQL: ${sql}`
    );
    assert(sql.split("::timestamptz AT TIME ZONE 'UTC'").length === 5, 'every timestamp should be read as UTC');
    const [id, seriesEventId, occurrence, at] = values as string[];
    const due = new RealDate(values[values.length - 1] as string).getTime();
    const originalStartsAt = new RealDate(occurrence);
    const lastPingedAt = new RealDate(at);
    const row = db.states.find((s) => s.seriesEventId === seriesEventId && ms(s.originalStartsAt) === originalStartsAt.getTime());
    if (!row) {
      db.states.push({
        id, seriesEventId, originalStartsAt, doneAt: null, doneByUserId: null, snoozedUntil: null,
        lastPingedAt, pingAttempts: 1, pingChatId: null, pingMessageId: null,
      });
      return [{ id, lastPingedAt, pingAttempts: 1 }];
    }
    if (row.doneAt || (row.lastPingedAt && (ms(row.lastPingedAt) as number) >= due)) return [];
    Object.assign(row, { lastPingedAt, pingAttempts: (row.pingAttempts as number) + 1 });
    return [{ id: row.id, lastPingedAt, pingAttempts: row.pingAttempts }];
  },
};

// ---- Fake Telegram ----

type Keyboard = { inline_keyboard: { text: string; callback_data: string }[][] };
type Sent = { at: number; chatId: string; text: string; parseMode?: string; keyboard: Keyboard; messageId: number };
let sent: Sent[] = [];
/** Thrown by the next sends, in order. */
let sendFailures: unknown[] = [];
let sendCalls = 0;
let edits: { text: string; options: Row }[] = [];
let editFailure: unknown = null;
let nextMessageId = 100;
const fakeBot = {
  sendMessage: async (chatId: string, text: string, options: { parse_mode?: string; reply_markup: Keyboard }) => {
    sendCalls++;
    if (sendFailures.length) throw sendFailures.shift();
    const messageId = nextMessageId++;
    sent.push({ at: clock, chatId: String(chatId), text, parseMode: options.parse_mode, keyboard: options.reply_markup, messageId });
    return { message_id: messageId };
  },
  editMessageText: async (text: string, options: Row) => {
    if (editFailure) {
      const error = editFailure;
      editFailure = null;
      throw error;
    }
    edits.push({ text, options });
    return true;
  },
};

/** An error as node-telegram-bot-api throws it for an API refusal. */
const telegramError = (status: number, description: string) =>
  Object.assign(new Error(`ETELEGRAM: ${status} ${description}`), {
    code: 'ETELEGRAM',
    response: { statusCode: status, body: { ok: false, error_code: status, description } },
  });
/** No answer at all. */
const networkError = () => Object.assign(new Error('EFATAL: Error: socket hang up'), { code: 'EFATAL' });

// ---- The rest of the world ----

const IL = 'Asia/Jerusalem';
const NY = 'America/New_York';
const MSK = 'Europe/Moscow';
const MIN = 60_000;
const HOUR = 60 * MIN;

let timezones: Record<number, string> = {};
let tracked: { userId: number; action: string; meta: Row }[] = [];
let captured: { context: string; severity: string }[] = [];
let unreachable: number[] = [];
const adminNotices: string[] = [];
let blockedTelegramIds = new Set<string>();
let flagOn = true;
let noAccess = new Set<number>();

const SRC = path.resolve(__dirname, '../src');

/** Modules replaced by fakes, by package name or file path. */
const stubs: Record<string, object> = {
  [`${SRC}/utils/prisma.ts`]: { prisma: fakePrisma },
  [`${SRC}/utils/redis.ts`]: { redis: {} },
  [`${SRC}/lib/error-capture.ts`]: {
    captureError: (_error: unknown, context: string, _extra?: unknown, severity = 'error') => captured.push({ context, severity }),
    captureWarning: () => {},
    captureInfo: () => {},
  },
  [`${SRC}/lib/timezone.ts`]: { resolveUserTimezone: async (user: { id: number }) => timezones[user.id] ?? IL },
  [`${SRC}/lib/user-moderation.ts`]: {
    isIdentifierBlocked: async ({ telegramId }: { telegramId?: bigint | null }) => blockedTelegramIds.has(String(telegramId)),
  },
  [`${SRC}/lib/user-reachability.ts`]: { markUserUnreachable: async (userId: number) => { unreachable.push(userId); } },
  [`${SRC}/services/telegram/index.ts`]: { getBot: () => fakeBot },
  [`${SRC}/services/analytics-service.ts`]: {
    trackActivityAsync: (userId: number, action: string, meta: Row = {}) => tracked.push({ userId, action, meta }),
  },
  [`${SRC}/services/native-reminders/support.ts`]: {
    isNativeRemindersEnabled: async () => flagOn,
    getReminderSupport: async (user: { id: number }) =>
      noAccess.has(user.id) ? { supported: false, reason: 'no_access' } : { supported: true },
  },
  [`${SRC}/utils/error-notifier.ts`]: {
    notifyAdminError: async (_context: string, _error: unknown, info?: string) => { adminNotices.push(info ?? ''); },
  },
};

// Static imports compile to require() and pass through Module._load.
const ModuleInternals = Module as unknown as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  _resolveFilename: (request: string, parent: unknown, isMain: boolean) => string;
};
const realLoad = ModuleInternals._load;
ModuleInternals._load = function (request, parent, isMain) {
  let resolved = request;
  try {
    resolved = ModuleInternals._resolveFilename(request, parent, isMain);
  } catch {}
  const stub = stubs[request in stubs ? request : resolved];
  return stub ?? realLoad.call(this, request, parent, isMain);
};

// handlers.ts loads its services with import(), which may go through the ES module
// loader instead; a stubbed file gets the same fake, served as an ES module.
(globalThis as { smokeStubs?: typeof stubs }).smokeStubs = stubs;
Module.registerHooks({
  load(url, context, nextLoad) {
    const file = url.startsWith('file:') ? fileURLToPath(url) : '';
    const stub = stubs[file];
    if (!stub) return nextLoad(url, context);
    const names = Object.keys(stub).map((name) => `export const ${name} = fake.${name};`).join('\n');
    return { format: 'module', shortCircuit: true, source: `const fake = globalThis.smokeStubs[${JSON.stringify(file)}];\n${names}\n` };
  },
});

// ---- Scenario helpers ----

const at = (local: string, tz = IL) => fromZonedTime(local, tz);
const today = (hhmm: string, tz = IL) => at(`2026-10-15 ${hhmm}`, tz);

/** Raziel (he) and Dana (en) are paired on the built-in calendar; Noa (ru) is on her own. */
function reset() {
  db.users = [
    { id: 1, name: 'רזיאל', englishName: 'Raziel', gender: 'male', language: 'he', telegramId: BigInt(1001), location: 'Tel Aviv', calendarSource: 'NATIVE', pairingId: 'pair-1', suspendedAt: null, unreachableSince: null },
    { id: 2, name: 'Dana', englishName: 'Dana', gender: 'female', language: 'en', telegramId: BigInt(1002), location: 'Tel Aviv', calendarSource: 'NATIVE', pairingId: 'pair-1', suspendedAt: null, unreachableSince: null },
    { id: 3, name: 'Noa', englishName: 'Noa', gender: 'female', language: 'ru', telegramId: BigInt(1003), location: 'Moscow', calendarSource: 'NATIVE', pairingId: null, suspendedAt: null, unreachableSince: null },
  ];
  db.pairings = [{ id: 'pair-1', status: 'ACTIVE', inviterUserId: 1, inviteeUserId: 2 }];
  db.calendars = [
    { id: 'cal-1', ownerUserId: 1, isDeleted: false },
    { id: 'cal-3', ownerUserId: 3, isDeleted: false },
    { id: 'cal-gone', ownerUserId: 1, isDeleted: true },
  ];
  db.events = [];
  db.instances = [];
  db.states = [];
  queries.length = 0;
  sent = [];
  sendFailures = [];
  sendCalls = 0;
  edits = [];
  editFailure = null;
  failNextFind = null;
  holdFind = null;
  failNextClaim = null;
  timezones = { 1: IL, 2: IL, 3: MSK };
  tracked = [];
  captured = [];
  unreachable = [];
  blockedTelegramIds = new Set();
  flagOn = true;
  noAccess = new Set();
}

let seq = 0;
/** A REMINDER row as the store writes it: zero length, by Raziel, armed an hour before its time. */
function reminder(p: Row & { startsAt: Date }): Row {
  const row: Row = {
    id: `rem${++seq}`, calendarId: 'cal-1', creatorUserId: 1, forUserId: null, title: 'Call the plumber',
    description: null, location: null, endsAt: p.startsAt, allDay: false, timeZone: IL, rrule: null, exdates: [],
    reminderMinutes: null, kind: 'REMINDER', armedAt: new RealDate(p.startsAt.getTime() - HOUR), isDeleted: false,
    createdAt: new RealDate(p.startsAt.getTime() - HOUR), updatedAt: new RealDate(p.startsAt.getTime() - HOUR),
    ...p,
  };
  db.events.push(row);
  return row;
}

/** A date-only reminder: the start of `day` in the event's timezone, zero length, set the day before. */
function dateOnly(day: string, p: Row = {}, tz = IL): Row {
  const startsAt = startOfLocalDay(day, tz);
  return reminder({ startsAt, allDay: true, timeZone: tz, armedAt: new RealDate(startsAt.getTime() - 12 * HOUR), ...p });
}

function state(p: Row & { seriesEventId: unknown; originalStartsAt: Date }): Row {
  const row: Row = {
    id: `state-${db.states.length + 1}`, doneAt: null, doneByUserId: null, snoozedUntil: null,
    lastPingedAt: null, pingAttempts: 0, pingChatId: null, pingMessageId: null, ...p,
  };
  db.states.push(row);
  return row;
}

const stateOf = (seriesEventId: unknown, originalStartsAt: Date) =>
  db.states.find((s) => s.seriesEventId === seriesEventId && ms(s.originalStartsAt) === originalStartsAt.getTime());

async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const { log, warn } = console;
  console.log = () => {};
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    console.warn = warn;
  }
}

const sentLines = () => sent.map((s) => `${s.chatId}: ${s.text.replace(/\n/g, ' / ')}`).join(' | ') || '(nothing)';
const callbacks = (keyboard: Keyboard) => keyboard.inline_keyboard.flat().map((b) => b.callback_data);

async function main() {
  const due = await import('../src/services/native-reminders/due');
  const { buildPingKeyboard, buildPingText, stripPingButtons } = await import('../src/services/native-reminders/ping');
  const { runNativeReminderPass } = await import('../src/services/native-reminders/pass');
  const gate = await import('../src/services/native-reminders/due-gate');
  const { handleNativeReminders } = await import('../src/cron/handlers');
  const copy = { en: en.bot.nativeReminders, he: he.bot.nativeReminders };
  const fromLine = (language: 'en' | 'he', name: string) => copy[language].ping.from.replace('{name}', name);

  const pass = (when: Date) => {
    clock = when.getTime();
    return quiet(() => runNativeReminderPass(when));
  };
  const tick = (when: Date) => {
    clock = when.getTime();
    return quiet(() => handleNativeReminders());
  };

  // ---- Due times ----

  await check('due: a timed reminder is due at its start, wherever the recipient is', () => {
    const occ = { startsAt: today('17:30'), allDay: false, timeZone: IL };
    for (const tz of [IL, NY, MSK]) assertTime(due.dueAtForOccurrence(occ, tz), occ.startsAt, tz);
  });

  await check("due: a date-only reminder is due at 09:00 where the recipient is, on the date it has in the event's timezone", () => {
    assert(due.REMINDER_MORNING_HOUR === 9, `morning hour ${due.REMINDER_MORNING_HOUR}`);
    const occ = { startsAt: startOfLocalDay('2026-10-15', IL), allDay: true, timeZone: IL };
    assertTime(due.dueAtForOccurrence(occ, IL), at('2026-10-15 09:00', IL), 'Israel');
    // Thursday begins in Israel at 17:00 Wednesday in New York; it is still Thursday's reminder.
    assertTime(due.dueAtForOccurrence(occ, NY), at('2026-10-15 09:00', NY), 'New York, 7 hours behind');
    assertTime(due.dueAtForOccurrence(occ, MSK), at('2026-10-15 09:00', MSK), 'Moscow');
    const fromNewYork = { startsAt: startOfLocalDay('2026-10-15', NY), allDay: true, timeZone: NY };
    assertTime(due.dueAtForOccurrence(fromNewYork, MSK), at('2026-10-15 09:00', MSK), 'a New York reminder, read in Moscow');
  });

  await check('due: on the days the clocks go back, 09:00 is still 09:00 local (Israel Oct 25, New York Nov 1)', () => {
    const day = (d: string, tz: string) => ({ startsAt: startOfLocalDay(d, tz), allDay: true, timeZone: tz });
    assertTime(due.dueAtForOccurrence(day('2026-10-24', IL), IL), new RealDate('2026-10-24T06:00:00Z'), 'Israel, summer time');
    assertTime(due.dueAtForOccurrence(day('2026-10-25', IL), IL), new RealDate('2026-10-25T07:00:00Z'), 'Israel, winter time');
    assertTime(due.dueAtForOccurrence(day('2026-11-01', IL), NY), new RealDate('2026-11-01T14:00:00Z'), 'New York, winter time');
  });

  await check('tomorrowMorning: before 04:00 it is this morning at 09:00, from 04:00 tomorrow at 09:00', () => {
    assertTime(due.tomorrowMorning(today('02:00'), IL), today('09:00'), '02:00');
    assertTime(due.tomorrowMorning(today('03:59'), IL), today('09:00'), '03:59');
    assertTime(due.tomorrowMorning(today('04:00'), IL), at('2026-10-16 09:00'), '04:00');
    assertTime(due.tomorrowMorning(today('10:00'), IL), at('2026-10-16 09:00'), '10:00');
    assertTime(due.tomorrowMorning(today('23:30', NY), NY), at('2026-10-16 09:00', NY), 'New York 23:30');
  });

  await check('tomorrowMorning: the night before the clocks go back lands on 09:00 local', () => {
    assertTime(due.tomorrowMorning(at('2026-10-24 22:00'), IL), new RealDate('2026-10-25T07:00:00Z'), 'Israel');
    assertTime(due.tomorrowMorning(at('2026-10-31 21:00', NY), NY), new RealDate('2026-11-01T14:00:00Z'), 'New York');
  });

  // ---- Eligibility ----

  const now = today('10:00');
  const base = { due: now, now, armedAt: null, snoozed: false, lastPingedAt: null, doneAt: null };
  const plus = (d: Date, delta: number) => new RealDate(d.getTime() + delta);

  await check('eligible: due now yes, a millisecond ahead no', () => {
    assert(due.isEligible(base), 'due now');
    assert(!due.isEligible({ ...base, due: plus(now, 1) }), 'due ahead');
  });

  await check('eligible: up to 60 minutes late, not a millisecond more', () => {
    assert(due.PING_LOOKBACK_MS === HOUR, `lookback ${due.PING_LOOKBACK_MS}`);
    assert(due.isEligible({ ...base, due: plus(now, -HOUR) }), '60 minutes late');
    assert(!due.isEligible({ ...base, due: plus(now, -HOUR - 1) }), 'past the lookback');
  });

  await check('eligible: set at most 15 minutes after its time; a snooze, or no armedAt, skips that bound', () => {
    assert(due.ARMED_GRACE_MS === 15 * MIN, `grace ${due.ARMED_GRACE_MS}`);
    const d = plus(now, -20 * MIN);
    assert(due.isEligible({ ...base, due: d, armedAt: plus(d, 15 * MIN) }), 'armed 15 minutes after');
    assert(!due.isEligible({ ...base, due: d, armedAt: plus(d, 15 * MIN + 1) }), 'armed later than that');
    assert(due.isEligible({ ...base, due: d, armedAt: plus(d, 15 * MIN + 1), snoozed: true }), 'a snooze');
    assert(due.isEligible({ ...base, due: d, armedAt: null }), 'no armedAt');
  });

  await check('eligible: done, or already pinged for this due time, no; pinged before a later due (a snooze) yes', () => {
    assert(!due.isEligible({ ...base, doneAt: plus(now, -MIN) }), 'done');
    assert(!due.isEligible({ ...base, lastPingedAt: now }), 'pinged at the due time');
    assert(due.isEligible({ ...base, lastPingedAt: plus(now, -1) }), 'pinged before it');
  });

  // ---- The pass ----

  await check('pass: a due reminder pings its creator once, with Done and three snoozes on its state row', async () => {
    reset();
    const r = reminder({ startsAt: today('10:00') });
    const result = await pass(today('10:00'));
    assertSame(result, { sent: 1, skipped: 0, failed: 0, nextDue: null });
    assert(sent.length === 1 && sent[0].chatId === '1001' && sent[0].parseMode === 'HTML', sentLines());
    assert(sent[0].text === '⏰ <b>Call the plumber</b>', `text ${sent[0].text}`);
    const row = stateOf(r.id, today('10:00'))!;
    assertTime(row.lastPingedAt as Date, today('10:00'), 'lastPingedAt');
    assert(row.pingAttempts === 1 && row.pingChatId === BigInt(1001) && row.pingMessageId === sent[0].messageId, show(row));
    const b = copy.he.buttons;
    assertSame(sent[0].keyboard, {
      inline_keyboard: [
        [{ text: b.done, callback_data: `nr:d:${row.id}` }],
        [
          { text: b.snooze15, callback_data: `nr:s15:${row.id}` },
          { text: b.snooze60, callback_data: `nr:s60:${row.id}` },
          { text: b.snoozeTomorrow, callback_data: `nr:st:${row.id}` },
        ],
      ],
    });
    assert(tracked.some((t) => t.userId === 1 && t.action === 'native_reminder_pinged'), show(tracked));
    const again = await pass(today('10:01'));
    assert(sent.length === 1 && again.sent === 0, `next tick: ${sentLines()}`);
  });

  await check('pass: two passes at once send one ping', async () => {
    reset();
    reminder({ startsAt: today('10:00') });
    clock = today('10:00').getTime();
    const [a, b] = await quiet(() => Promise.all([runNativeReminderPass(today('10:00')), runNativeReminderPass(today('10:00'))]));
    assert(sent.length === 1, sentLines());
    assert(a.sent + b.sent === 1 && a.skipped + b.skipped === 1, `${show(a)} ${show(b)}`);
    assert(db.states.length === 1 && db.states[0].pingAttempts === 1, show(db.states));
  });

  await check("pass: a date-only reminder for the partner pings at 09:00 where she is, in her language, saying who set it", async () => {
    reset();
    timezones[2] = NY;
    dateOnly('2026-10-15', { forUserId: 2, title: 'Buy milk' });
    await pass(today('09:00', IL));
    await pass(today('08:59', NY));
    assert(sent.length === 0, `early: ${sentLines()}`);
    await pass(today('09:00', NY));
    assert(sent.length === 1 && sent[0].chatId === '1002', sentLines());
    assert(sent[0].text === `⏰ <b>Buy milk</b>\n${fromLine('en', 'רזיאל')}`, `text ${sent[0].text}`);
    assert(sent[0].keyboard.inline_keyboard[0][0].text === copy.en.buttons.done, 'buttons not in her language');
  });

  await check('pass: a daily 09:00 reminder pings at 09:00 local on the day the clocks go back', async () => {
    reset();
    const daily = reminder({ startsAt: at('2026-10-20 09:00'), rrule: 'FREQ=DAILY', armedAt: at('2026-10-19 12:00'), title: 'Pills' });
    await pass(new RealDate('2026-10-25T06:00:00Z')); // 08:00 in Israel's winter time
    assert(sent.length === 0, `an hour early: ${sentLines()}`);
    await pass(new RealDate('2026-10-25T07:00:00Z'));
    assert(sent.length === 1, sentLines());
    assert(!!stateOf(daily.id, new RealDate('2026-10-25T07:00:00Z')), `keyed ${show(db.states)}`);
  });

  await check('pass: after unlinking, a reminder for the ex-partner pings its creator, with no "from" line', async () => {
    reset();
    db.pairings[0].status = 'UNLINKED';
    for (const u of db.users) u.pairingId = null;
    reminder({ startsAt: today('10:00'), forUserId: 2 });
    await pass(today('10:00'));
    assert(sent.length === 1 && sent[0].chatId === '1001' && sent[0].text === '⏰ <b>Call the plumber</b>', sentLines());
  });

  await check('pass: a partner who moved to Google (the pairing still ACTIVE) hands it back to its creator', async () => {
    reset();
    db.users[1].calendarSource = 'GOOGLE';
    reminder({ startsAt: today('10:00'), forUserId: 2 });
    await pass(today('10:00'));
    assert(sent.length === 1 && sent[0].chatId === '1001', sentLines());
  });

  await check('pass: one live ping per series; a daily reminder snoozed into the next morning pings once, for the new day', async () => {
    reset();
    const daily = reminder({ startsAt: at('2026-10-10 09:00'), rrule: 'FREQ=DAILY', armedAt: at('2026-10-09 20:00'), title: 'Pills' });
    const yesterday = state({ seriesEventId: daily.id, originalStartsAt: at('2026-10-14 09:00'), lastPingedAt: at('2026-10-14 09:00'), pingAttempts: 1, snoozedUntil: today('09:00') });
    const result = await pass(today('09:00'));
    assert(sent.length === 1 && result.sent === 1 && result.skipped === 1, `${show(result)} ${sentLines()}`);
    const fresh = stateOf(daily.id, today('09:00'))!;
    assert(callbacks(sent[0].keyboard).every((c) => c.endsWith(`:${fresh.id}`)), `buttons ${callbacks(sent[0].keyboard)}`);
    assertTime(yesterday.lastPingedAt as Date, today('09:00'), "yesterday's claimed without a send");
    await pass(today('09:01'));
    assert(sent.length === 1, sentLines());
  });

  await check('pass: a snoozed ping comes back at snoozedUntil, a fresh message on the same state row', async () => {
    reset();
    const r = reminder({ startsAt: today('10:00') });
    await pass(today('10:00'));
    const row = stateOf(r.id, today('10:00'))!;
    row.snoozedUntil = today('10:15'); // 💤 15 min, tapped at 10:00
    await pass(today('10:14'));
    assert(sent.length === 1, `early: ${sentLines()}`);
    await pass(today('10:15'));
    assert(sent.length === 2 && sent[1].messageId !== sent[0].messageId, sentLines());
    assert(callbacks(sent[1].keyboard).every((c) => c.endsWith(`:${row.id}`)), 'new buttons on another row');
    assert(row.pingMessageId === sent[1].messageId && row.pingAttempts === 2, show(row));
  });

  await check('pass: a ping snoozed days after its time still comes back, though the occurrence is long past', async () => {
    reset();
    const r = reminder({ startsAt: at('2026-10-11 10:00') });
    state({ seriesEventId: r.id, originalStartsAt: at('2026-10-11 10:00'), lastPingedAt: at('2026-10-11 10:00'), pingAttempts: 1, snoozedUntil: today('09:00') });
    await pass(today('09:00'));
    assert(sent.length === 1 && sent[0].chatId === '1001', sentLines());
  });

  await check('pass: set after its time had passed: 10 minutes late still pings, 30 minutes late does not', async () => {
    reset();
    reminder({ startsAt: today('10:00'), armedAt: today('10:10'), title: 'Set at 10:10' });
    reminder({ startsAt: today('10:00'), armedAt: today('10:30'), title: 'Set at 10:30' });
    await pass(today('10:30'));
    assert(sentLines() === '1001: ⏰ <b>Set at 10:10</b>', sentLines());
  });

  await check('pass: a moved occurrence counts as set when it was moved', async () => {
    for (const [movedAt, pings] of [['10:58', true], ['11:30', false]] as const) {
      reset();
      const daily = reminder({ startsAt: at('2026-10-01 08:00'), rrule: 'FREQ=DAILY', armedAt: at('2026-09-30 12:00'), title: 'Walk' });
      db.instances.push({
        id: 'ov1', seriesEventId: daily.id, originalStartsAt: today('08:00'), status: 'OVERRIDE', title: null, description: null,
        location: null, startsAt: today('11:00'), endsAt: today('11:00'), allDay: null, createdAt: today(movedAt), updatedAt: today(movedAt),
      });
      await pass(today('08:00'));
      await pass(today(movedAt === '10:58' ? '11:00' : '11:30'));
      assert(sent.length === (pings ? 1 : 0), `moved at ${movedAt}: ${sentLines()}`);
      if (pings) assert(!!stateOf(daily.id, today('08:00')), 'not keyed by its original slot');
    }
  });

  await check('pass: done, deleted, on a deleted calendar, an event, or an exdated occurrence: no ping', async () => {
    reset();
    const done = reminder({ startsAt: today('10:00'), title: 'Done' });
    state({ seriesEventId: done.id, originalStartsAt: today('10:00'), doneAt: today('09:50') });
    reminder({ startsAt: today('10:00'), title: 'Deleted', isDeleted: true });
    reminder({ startsAt: today('10:00'), title: 'Deleted calendar', calendarId: 'cal-gone' });
    reminder({ startsAt: today('10:00'), title: 'An event', kind: 'EVENT', endsAt: today('11:00') });
    reminder({ startsAt: at('2026-10-14 10:00'), rrule: 'FREQ=DAILY', exdates: [today('10:00')], armedAt: at('2026-10-13 10:00'), title: 'Skipped today' });
    await pass(today('10:00'));
    assert(sent.length === 0, sentLines());
  });

  await check("pass: a series whose rule can't be read is reported, and the others still ping", async () => {
    reset();
    reminder({ startsAt: at('2026-10-14 10:00'), rrule: 'FREQ=SOMETIMES', title: 'Broken' });
    reminder({ startsAt: today('10:00'), title: 'Fine' });
    const result = await pass(today('10:00'));
    assert(sentLines() === '1001: ⏰ <b>Fine</b>', sentLines());
    assert(result.failed === 1 && captured.some((c) => c.context === 'native-reminders-series'), show(result));
    assert(result.nextDue === null, `a rule that fails every time made it retry: ${result.nextDue?.toISOString()}`);
  });

  await check('pass: a database blip on one series lets the others ping, and the next tick tries it again', async () => {
    reset();
    reminder({ startsAt: today('10:00'), title: 'Blip' });
    reminder({ startsAt: today('10:00'), title: 'Fine' });
    failNextClaim = new Error('Connection terminated unexpectedly');
    const result = await pass(today('10:00'));
    assert(sentLines() === '1001: ⏰ <b>Fine</b>' && result.failed === 1, `${show(result)} ${sentLines()}`);
    assertTime(result.nextDue, today('10:01'), 'nextDue');
    await pass(today('10:01'));
    assert(sentLines() === '1001: ⏰ <b>Fine</b> | 1001: ⏰ <b>Blip</b>', sentLines());
  });

  // ---- Skips and send failures ----

  const recipientStates: [string, () => void][] = [
    ['suspended', () => { db.users[1].suspendedAt = at('2026-10-01 12:00'); }],
    ['unreachable', () => { db.users[1].unreachableSince = at('2026-10-01 12:00'); }],
    ['banned', () => { blockedTelegramIds.add('1002'); }],
    ['not on Telegram', () => { db.users[1].telegramId = null; }],
  ];
  for (const [label, setUp] of recipientStates) {
    await check(`skip: a ${label} recipient gets no ping, and nothing is claimed`, async () => {
      reset();
      setUp();
      reminder({ startsAt: today('10:00'), forUserId: 2 });
      const result = await pass(today('10:00'));
      assert(sent.length === 0 && result.skipped === 1 && db.states.length === 0, `${show(result)} ${sentLines()}`);
    });
  }

  await check('skip: a creator without reminder access: no ping, for them or for the partner', async () => {
    reset();
    noAccess.add(1);
    reminder({ startsAt: today('10:00'), forUserId: 2 });
    reminder({ startsAt: today('10:00') });
    const result = await pass(today('10:00'));
    assert(sent.length === 0 && result.skipped === 2 && db.states.length === 0, `${show(result)} ${sentLines()}`);
  });

  await check('admin switch off: the pass does nothing and reads nothing', async () => {
    reset();
    flagOn = false;
    reminder({ startsAt: today('10:00') });
    const result = await pass(today('10:00'));
    assertSame(result, { sent: 0, skipped: 0, failed: 0, nextDue: null });
    assert(queries.length === 0 && sent.length === 0, `queried ${queries.join(', ')}`);
  });

  await check('send failure: a 429, a dropped connection and a 502 each give the claim back; the third attempt is the last', async () => {
    reset();
    assert(due.MAX_PING_ATTEMPTS === 3, `attempts ${due.MAX_PING_ATTEMPTS}`);
    const r = reminder({ startsAt: today('10:00') });
    sendFailures = [telegramError(429, 'Too Many Requests: retry after 5'), networkError(), telegramError(502, 'Bad Gateway')];
    const first = await pass(today('10:00'));
    const row = stateOf(r.id, today('10:00'))!;
    assert(first.failed === 1 && row.lastPingedAt === null && row.pingAttempts === 1, `${show(first)} ${show(row)}`);
    assertTime(first.nextDue, today('10:01'), 'retry on the next tick');
    await pass(today('10:01'));
    assert(row.lastPingedAt === null && row.pingAttempts === 2, show(row));
    await pass(today('10:02'));
    assertTime(row.lastPingedAt as Date, today('10:02'), 'third claim kept');
    assert(row.pingAttempts === 3 && captured.some((c) => c.context === 'native-reminders-send'), show(captured));
    await pass(today('10:03'));
    assert(sendCalls === 3 && sent.length === 0, `sends tried ${sendCalls}`);
  });

  await check('send failure: one passing failure, then the retry gets through', async () => {
    reset();
    const r = reminder({ startsAt: today('10:00') });
    sendFailures = [telegramError(502, 'Bad Gateway')];
    await pass(today('10:00'));
    await pass(today('10:01'));
    const row = stateOf(r.id, today('10:00'))!;
    assert(sent.length === 1 && row.pingAttempts === 2 && row.pingMessageId === sent[0].messageId, show(row));
  });

  await check('send failure: a user who blocked the bot is marked unreachable, and not retried', async () => {
    reset();
    const r = reminder({ startsAt: today('10:00') });
    sendFailures = [telegramError(403, 'Forbidden: bot was blocked by the user')];
    const result = await pass(today('10:00'));
    assert(result.failed === 1 && unreachable.join() === '1', `${show(result)} unreachable ${unreachable}`);
    assertTime(stateOf(r.id, today('10:00'))!.lastPingedAt as Date, today('10:00'), 'claim kept');
    await pass(today('10:01'));
    assert(sendCalls === 1, `sends tried ${sendCalls}`);
  });

  await check('send failure: any other refusal is reported and kept, not retried', async () => {
    reset();
    reminder({ startsAt: today('10:00') });
    sendFailures = [telegramError(400, "Bad Request: can't parse entities")];
    await pass(today('10:00'));
    await pass(today('10:01'));
    assert(sendCalls === 1 && unreachable.length === 0, `sends tried ${sendCalls}`);
    assert(captured.some((c) => c.context === 'native-reminders-send' && c.severity === 'error'), show(captured));
  });

  // ---- The message ----

  await check('ping: a title and a name with <, > and & are escaped for HTML', async () => {
    reset();
    db.users[0].name = 'Raz <&> Co';
    reminder({ startsAt: today('10:00'), forUserId: 2, title: '<script>alert("x")</script> & milk' });
    await pass(today('10:00'));
    const want = `⏰ <b>&lt;script&gt;alert("x")&lt;/script&gt; &amp; milk</b>\n${fromLine('en', 'Raz &lt;&amp;&gt; Co')}`;
    assert(sent.length === 1 && sent[0].text === want, `\n     got  ${sent[0]?.text}\n     want ${want}`);
    const hebrew = await buildPingText({ title: 'קניות <דחוף>', creatorName: 'Dana', language: 'he' });
    assert(hebrew === `⏰ <b>קניות &lt;דחוף&gt;</b>\n${fromLine('he', 'Dana')}`, hebrew);
  });

  await check("ping: every button's callback data fits Telegram's 64 bytes", async () => {
    const keyboard = await buildPingKeyboard(randomUUID(), 'ru');
    const data = callbacks(keyboard as Keyboard);
    assert(data.length === 4 && data.every((d) => Buffer.byteLength(d) <= 64), data.join(' '));
    assertSame(data.map((d) => d.split(':')[1]), ['d', 's15', 's60', 'st']);
  });

  await check('stripPingButtons: edits to the text with no buttons; a ping already edited or deleted is fine', async () => {
    reset();
    await stripPingButtons(BigInt(1001), 77, '⏰ Call · moved to Fri 10:00');
    assertSame(edits, [{ text: '⏰ Call · moved to Fri 10:00', options: { chat_id: '1001', message_id: 77, parse_mode: 'HTML' } }]);
    editFailure = telegramError(400, 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same');
    await stripPingButtons(1001, 77, 'same');
    editFailure = telegramError(400, 'Bad Request: message to edit not found');
    await stripPingButtons(1001, 77, 'gone');
    editFailure = telegramError(403, 'Forbidden: bot was blocked by the user');
    const thrown = await stripPingButtons(1001, 77, 'x').then(() => 'resolved', (e: Error) => e.message);
    assert(thrown.includes('403'), `a refusal: ${thrown}`);
  });

  // ---- nextDue and the gate ----

  await check('nextDue: the earliest due still ahead, a snooze and a date-only one in the recipient\'s timezone included', async () => {
    reset();
    reminder({ startsAt: today('10:40') });
    const snoozed = reminder({ startsAt: today('09:00'), title: 'Snoozed' });
    state({ seriesEventId: snoozed.id, originalStartsAt: today('09:00'), lastPingedAt: today('09:00'), pingAttempts: 1, snoozedUntil: today('10:15') });
    assertTime((await pass(today('10:00'))).nextDue, today('10:15'), 'with the snooze');
    reset();
    timezones[2] = NY;
    dateOnly('2026-10-16', { forUserId: 2 });
    assertTime((await pass(today('10:00'))).nextDue, at('2026-10-16 09:00', NY), "Dana's 09:00 tomorrow");
    reset();
    assert((await pass(today('10:00'))).nextDue === null, 'nothing in the window');
  });

  await check('handler: the first tick reads; later ones sleep until the next due or the 60-minute ceiling; a write wakes it', async () => {
    reset();
    gate.__resetDueGateForTests();
    reminder({ startsAt: today('10:20') });
    await tick(today('10:00'));
    assert(queries.includes('nativeEvent.findMany'), 'the first tick did not read');
    queries.length = 0;
    await tick(today('10:01'));
    await tick(today('10:19'));
    assert(queries.length === 0, `slept badly: ${queries.join(', ')}`);
    gate.invalidateDueGate(); // a reminder write
    await tick(today('10:02'));
    assert(queries.includes('nativeEvent.findMany'), 'a write did not wake it');
    await tick(today('10:20'));
    assert(sent.length === 1, sentLines());
    queries.length = 0;
    await tick(today('11:19')); // nothing ahead: wakes at the ceiling
    assert(queries.length === 0, `woke early: ${queries.join(', ')}`);
    await tick(today('11:20'));
    assert(queries.includes('nativeEvent.findMany'), 'did not wake at the ceiling');
  });

  await check('handler: a tick that finds the last pass still running skips', async () => {
    reset();
    gate.__resetDueGateForTests();
    reminder({ startsAt: today('10:00') });
    let release = () => {};
    holdFind = new Promise<void>((resolve) => (release = resolve));
    const first = tick(today('10:00'));
    await tick(today('10:00'));
    release();
    await first;
    assert(queries.filter((q) => q === 'nativeEvent.findMany').length === 1 && sent.length === 1, `${queries.join(', ')} ${sentLines()}`);
  });

  await check('handler: a failing pass throws nothing, leaves the gate open, and tells the admin at most once an hour', async () => {
    reset();
    gate.__resetDueGateForTests();
    failNextFind = new Error('Connection terminated unexpectedly');
    await tick(today('10:00'));
    assert(captured.some((c) => c.context === 'cron-native-reminders') && adminNotices.length === 1, `${show(captured)} ${adminNotices}`);
    queries.length = 0;
    failNextFind = new Error('Connection terminated unexpectedly');
    await tick(today('10:01'));
    assert(queries.includes('nativeEvent.findMany'), 'the gate closed after a failure');
    assert(adminNotices.length === 1, `told the admin again within the hour: ${adminNotices.length}`);
    failNextFind = new Error('Connection terminated unexpectedly');
    await tick(today('11:00'));
    assert(adminNotices.length === 2 && adminNotices[1] === 'Job: Native Reminders', show(adminNotices));
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `TZ=UTC npx tsx scripts/smoke-native-reminders.ts; echo "exit=$?"`

Expected: no check runs. It stops at the first dynamic import with `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/src/services/native-reminders/due' imported from …/scripts/smoke-native-reminders.ts`, then `exit=1`.

- [ ] **Step 3: Add the activity actions**

In `src/services/analytics-service.ts`, find (lines 36-37):

```ts
  // Reminder actions
  | 'reminder_sent'
```

Replace with:

```ts
  // Reminder actions
  | 'reminder_sent'
  // Native reminders (built-in calendar): reminder_sent above is event alerts
  | 'native_reminder_created'
  | 'native_reminder_pinged'
  | 'native_reminder_done'
  | 'native_reminder_snoozed'
```

- [ ] **Step 4: Create the due-time math**

Create `src/services/native-reminders/due.ts`:

```ts
// When a native reminder occurrence pings, and whether it may ping now (spec §4.2,
// ruling R6). Pure: no database, and no clock of its own.

import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { TIMEZONE } from '../../config/constants';
import { localDate, nextDate } from '../../utils/day-events';

/** Date-only reminders ping at this local hour, and 💤 Tomorrow wakes at it. */
export const REMINDER_MORNING_HOUR = 9;
/** How late a ping may still go out, after downtime or a slow tick. */
export const PING_LOOKBACK_MS = 60 * 60 * 1000;
/** A reminder set for a time that has just passed still pings when it is this recent. */
export const ARMED_GRACE_MS = 15 * 60 * 1000;
/** Sends tried for one occurrence before a passing failure stops being retried. */
export const MAX_PING_ATTEMPTS = 3;

// 💤 Tomorrow tapped before this local hour means this morning: it's still the night.
const SAME_MORNING_BEFORE_HOUR = 4;

/** REMINDER_MORNING_HOUR:00 on `day` (yyyy-MM-dd) in `tz`. */
function morningOf(day: string, tz: string): Date {
  return fromZonedTime(`${day} ${String(REMINDER_MORNING_HOUR).padStart(2, '0')}:00:00`, tz);
}

/**
 * When an occurrence pings. A timed one at its start. A date-only one at
 * REMINDER_MORNING_HOUR in the recipient's timezone, on the date it has in the event's
 * own timezone, so a partner abroad gets it at their 09:00 of that date.
 */
export function dueAtForOccurrence(occ: { startsAt: Date; allDay: boolean; timeZone: string }, recipientTz: string): Date {
  if (!occ.allDay) return occ.startsAt;
  return morningOf(localDate(occ.startsAt, occ.timeZone || TIMEZONE), recipientTz);
}

/** 💤 Tomorrow: 09:00 tomorrow in `tz`, or 09:00 today when tapped between 00:00 and 04:00. */
export function tomorrowMorning(now: Date, tz: string): Date {
  const today = localDate(now, tz);
  const hour = Number(formatInTimeZone(now, tz, 'H'));
  return morningOf(hour < SAME_MORNING_BEFORE_HOUR ? today : nextDate(today), tz);
}

/**
 * Whether an occurrence pings now: not done, due within the last PING_LOOKBACK_MS, not
 * set long after its own time had passed (armedAt, which a snooze ignores), and not yet
 * pinged for this due time.
 */
export function isEligible(a: {
  due: Date;
  now: Date;
  armedAt: Date | null;
  snoozed: boolean;
  lastPingedAt: Date | null;
  doneAt: Date | null;
}): boolean {
  if (a.doneAt) return false;
  const due = a.due.getTime();
  const now = a.now.getTime();
  if (due > now || due < now - PING_LOOKBACK_MS) return false;
  if (!a.snoozed && a.armedAt && due < a.armedAt.getTime() - ARMED_GRACE_MS) return false;
  return !a.lastPingedAt || a.lastPingedAt.getTime() < due;
}
```

- [ ] **Step 5: Create the claim**

The statement is spec §4.3, with three adjustments:
- **No `createdAt`:** it is left to the column's `DEFAULT CURRENT_TIMESTAMP`. `updatedAt` has no database default (Prisma's `@updatedAt` is client-side), so it is written explicitly.
- **Timestamps from JS:** `claimedAt` is the pass's `now`, so the release can match it exactly and the smoke clock controls it.
- **Timestamps as UTC:** each one goes in as an ISO string, cast with `::timestamptz AT TIME ZONE 'UTC'`. Prisma stores `DateTime` in `timestamp(3)` as UTC wall-clock time, and this cast gives the same value whatever the session's `TimeZone` is.

Task 14's DEV-database pass is the first run against real Postgres.

Create `src/services/native-reminders/claim.ts`:

```ts
// The atomic claim on a reminder occurrence before its ping is sent (spec §4.3).
//
// Overlapping ticks, a manual run, and the two processes Railway runs during a deploy
// can each find the same occurrence due. Only the one whose claim returns a row sends.
// The claim is one conditional upsert on the state row's (seriesEventId,
// originalStartsAt) key. Prisma's upsert can't carry the condition, hence the raw SQL.

import { randomUUID } from 'crypto';
import { prisma } from '../../utils/prisma';

export interface Claim {
  id: string; // the state row, which the ping's buttons carry
  claimedAt: Date; // the lastPingedAt this claim wrote
  previousLastPingedAt: Date | null; // what releaseClaim puts back
  pingAttempts: number; // claims made on this occurrence, this one included
}

/**
 * Claim one occurrence for a ping due at `due`. Null when it is done or something has
 * already pinged it for this due time. The row is created on the first claim: until
 * then the occurrence has no state, which means pending.
 *
 * Timestamps go in as ISO strings read as UTC, because Prisma keeps DateTime columns as
 * timestamp(3) holding UTC wall-clock time, whatever the session's timezone is.
 */
export async function claimOccurrence(
  seriesEventId: string,
  originalStartsAt: Date,
  due: Date,
  now: Date = new Date()
): Promise<Claim | null> {
  const previous = await prisma.nativeReminderState.findUnique({
    where: { seriesEventId_originalStartsAt: { seriesEventId, originalStartsAt } },
    select: { lastPingedAt: true },
  });
  const at = now.toISOString();
  const rows = await prisma.$queryRaw<Array<{ id: string; lastPingedAt: Date; pingAttempts: number }>>`
    INSERT INTO "NativeReminderState" ("id", "seriesEventId", "originalStartsAt", "lastPingedAt", "pingAttempts", "updatedAt")
    VALUES (${randomUUID()}, ${seriesEventId}, (${originalStartsAt.toISOString()}::timestamptz AT TIME ZONE 'UTC'),
            (${at}::timestamptz AT TIME ZONE 'UTC'), 1, (${at}::timestamptz AT TIME ZONE 'UTC'))
    ON CONFLICT ("seriesEventId", "originalStartsAt") DO UPDATE
      SET "lastPingedAt" = EXCLUDED."lastPingedAt",
          "pingAttempts" = "NativeReminderState"."pingAttempts" + 1,
          "updatedAt" = EXCLUDED."updatedAt"
      WHERE "NativeReminderState"."doneAt" IS NULL
        AND ("NativeReminderState"."lastPingedAt" IS NULL
             OR "NativeReminderState"."lastPingedAt" < (${due.toISOString()}::timestamptz AT TIME ZONE 'UTC'))
    RETURNING "id", "lastPingedAt", "pingAttempts"`;
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    claimedAt: row.lastPingedAt,
    previousLastPingedAt: previous?.lastPingedAt ?? null,
    pingAttempts: Number(row.pingAttempts),
  };
}

/**
 * Undo a claim whose send failed for a passing reason, so a later pass tries again.
 * It does nothing once anything else has written lastPingedAt since.
 */
export async function releaseClaim(claim: Claim): Promise<void> {
  await prisma.nativeReminderState.updateMany({
    where: { id: claim.id, lastPingedAt: claim.claimedAt },
    data: { lastPingedAt: claim.previousLastPingedAt },
  });
}
```

- [ ] **Step 6: Create the ping message**

Three choices here:
- **Sending:** it goes through `getBot().sendMessage`, not the messaging adapter. `IMessagingService.sendMessage` is typed `Promise<number | string>`, and the state row needs the numeric `message_id`.
- **Editing:** `stripPingButtons` edits through the bot directly, as `src/services/voice/callbacks.ts` does. Leaving out `reply_markup` removes the keyboard.
- **Escaping:** `escapeHtml` comes from the leaf `src/utils/html.ts` (Planning Ruling 3), so the 1-minute pass never loads the voice confirmation chain.

Create `src/services/native-reminders/ping.ts`:

```ts
// The Telegram message a native reminder pings with, and the edit that retires its
// buttons (spec §4.4).
//
// Each button's callback data is `nr:<op>:<stateId>`, where stateId is the occurrence's
// state row (a 36-character UUID, so `nr:s15:<id>` is 43 bytes of Telegram's 64). The
// row lives as long as the occurrence keeps its time, so an old ping's buttons still work.

import TelegramBot from 'node-telegram-bot-api';
import { getBot } from '../telegram';
import { getBotMessage, getBotMessages } from '../../lib/bot-messages';
import { escapeHtml } from '../../utils/html';

/** `⏰ <b>title</b>`, and a "from: <creator>" line when someone else set it. */
export async function buildPingText(a: { title: string; creatorName?: string; language: string }): Promise<string> {
  const head = `⏰ <b>${escapeHtml(a.title)}</b>`;
  if (!a.creatorName) return head;
  const from = await getBotMessage(a.language, 'nativeReminders.ping.from', { name: escapeHtml(a.creatorName) });
  return `${head}\n${from}`;
}

/** ✅ Done on its own row, the three snoozes under it. */
export async function buildPingKeyboard(stateId: string, language: string): Promise<TelegramBot.InlineKeyboardMarkup> {
  const buttons = (await getBotMessages(language)).nativeReminders.buttons;
  return {
    inline_keyboard: [
      [{ text: buttons.done, callback_data: `nr:d:${stateId}` }],
      [
        { text: buttons.snooze15, callback_data: `nr:s15:${stateId}` },
        { text: buttons.snooze60, callback_data: `nr:s60:${stateId}` },
        { text: buttons.snoozeTomorrow, callback_data: `nr:st:${stateId}` },
      ],
    ],
  };
}

/** Send a ping. Resolves to its message id, which the state row keeps for later edits. */
export async function sendPing(chatId: bigint, text: string, keyboard: TelegramBot.InlineKeyboardMarkup): Promise<number> {
  const message = await getBot().sendMessage(chatId.toString(), text, { parse_mode: 'HTML', reply_markup: keyboard });
  return message.message_id;
}

/**
 * Edit a ping to `text`, which is HTML, with no buttons. A ping that already reads so,
 * or that the user deleted, needs nothing; any other failure is the caller's.
 */
export async function stripPingButtons(chatId: bigint | number, messageId: number, text: string): Promise<void> {
  try {
    await getBot().editMessageText(text, { chat_id: chatId.toString(), message_id: messageId, parse_mode: 'HTML' });
  } catch (error) {
    const message = (error as { message?: string })?.message ?? '';
    if (message.includes('message is not modified') || message.includes('message to edit not found')) return;
    throw error;
  }
}
```

- [ ] **Step 7: Create the pass**

Notes on the design:
- **The window:** occurrences are expanded over `[now − 48h, now + 26h]`. A date-only reminder's due time depends on the recipient's timezone and can land up to about 35 hours after its date starts in the event's timezone.
- **Snoozes:** an undone snooze waking in the window pulls its series in, wherever its occurrence lies. `occurrencesOf` re-expands just that key through `expandSeries`, so an exdated or cancelled occurrence never comes back.
- **Errors:**
  - A rule that fails to parse is reported and skipped. It doesn't retry, since it fails the same way every time.
  - A database error inside one series is reported, and `nextDue` becomes `now + 1 min` so the next tick tries again.
  - A send released after a passing failure does the same.
- **The 403 rule:** only `isUnreachableError` 403s, which is the codebase's deliberately narrow rule, mark the user unreachable. Any other refusal keeps the claim and goes to `captureError`.

Create `src/services/native-reminders/pass.ts`:

```ts
// The native reminder pass (spec §4): find the reminder occurrences due now, claim each
// one, and ping the person it is for with ✅ Done and 💤 Snooze.
//
// A 1-minute cron runs it behind an in-process gate (due-gate.ts), so the database is
// read only when something may be due; the pass's nextDue says when that is. Due times
// are worked out here rather than in SQL: a date-only reminder pings at 09:00 in the
// recipient's timezone, which the query can't know, so it fetches a wide window.

import type { NativeEvent, NativeEventInstance, NativeReminderState, Prisma } from '@prisma/client';
import { prisma } from '../../utils/prisma';
import { captureError } from '../../lib/error-capture';
import { describeDeliveryError, isUnreachableError } from '../../lib/delivery-errors';
import { markUserUnreachable } from '../../lib/user-reachability';
import { isIdentifierBlocked } from '../../lib/user-moderation';
import { resolveUserTimezone } from '../../lib/timezone';
import { trackActivityAsync } from '../analytics-service';
import { expandSeries, VirtualInstance } from '../native-calendar/recurrence';
import { effectiveOwnerId, getActivePartnerSummary } from './ownership';
import { getReminderSupport, isNativeRemindersEnabled } from './support';
import { dueAtForOccurrence, isEligible, MAX_PING_ATTEMPTS, PING_LOOKBACK_MS } from './due';
import { Claim, claimOccurrence, releaseClaim } from './claim';
import { buildPingKeyboard, buildPingText, sendPing } from './ping';

const HOUR_MS = 60 * 60 * 1000;
// The window occurrences are expanded over. A date-only reminder pings at 09:00 in the
// recipient's timezone on its date in the event's timezone: up to about 35 hours after
// that date begins (an event at UTC+14, a recipient at UTC-12) or 17 hours before it.
const WINDOW_BACK_MS = 48 * HOUR_MS;
const WINDOW_AHEAD_MS = 26 * HOUR_MS;
// After a send fails for a passing reason, or a database blip cuts a series short, look
// again on the next tick.
const RETRY_AFTER_MS = 60 * 1000;

const USER_SELECT = {
  id: true,
  name: true,
  language: true,
  telegramId: true,
  location: true,
  calendarSource: true,
  pairingId: true,
  suspendedAt: true,
  unreachableSince: true,
} as const;
type PassUser = Prisma.UserGetPayload<{ select: typeof USER_SELECT }>;

/** One occurrence the pass may ping, with its due time and state. */
interface Candidate {
  occ: VirtualInstance;
  due: Date;
  snoozed: boolean;
  state: NativeReminderState | undefined;
}

type SendOutcome = 'sent' | 'lost' | 'retry' | 'failed';

export interface NativeReminderPassResult {
  sent: number;
  skipped: number;
  failed: number;
  nextDue: Date | null;
}

const occurrenceKey = (seriesEventId: string, originalStartsAt: Date) => `${seriesEventId}|${originalStartsAt.getTime()}`;

/** Load each key once per pass. */
function perPass<K, V>(load: (key: K) => Promise<V>): (key: K) => Promise<V> {
  const cache = new Map<K, Promise<V>>();
  return (key) => {
    let hit = cache.get(key);
    if (!hit) {
      hit = load(key);
      cache.set(key, hit);
    }
    return hit;
  };
}

function groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const group = out.get(keyOf(item));
    if (group) group.push(item);
    else out.set(keyOf(item), [item]);
  }
  return out;
}

/**
 * Reminder series that may have an occurrence due in the window: one-offs starting in
 * it, every repeating series that has begun by its end, and any series with an undone
 * snooze waking in it, whenever its occurrence was.
 */
async function loadCandidateSeries(now: Date, range: { from: Date; to: Date }) {
  const snoozes = await prisma.nativeReminderState.findMany({
    where: { doneAt: null, snoozedUntil: { gte: new Date(now.getTime() - PING_LOOKBACK_MS), lt: range.to } },
    select: { seriesEventId: true, originalStartsAt: true },
  });
  const snoozedSeriesIds = [...new Set(snoozes.map((s) => s.seriesEventId))];
  const series = await prisma.nativeEvent.findMany({
    where: {
      kind: 'REMINDER',
      isDeleted: false,
      calendar: { isDeleted: false },
      OR: [
        { rrule: null, startsAt: { gte: range.from, lt: range.to } },
        { rrule: { not: null }, startsAt: { lt: range.to } },
        ...(snoozedSeriesIds.length ? [{ id: { in: snoozedSeriesIds } }] : []),
      ],
    },
  });
  const overrides = series.length
    ? await prisma.nativeEventInstance.findMany({ where: { seriesEventId: { in: series.map((s) => s.id) } } })
    : [];
  return {
    series,
    overridesBySeries: groupBy(overrides, (o) => o.seriesEventId),
    snoozedKeysBySeries: groupBy(snoozes, (s) => s.seriesEventId),
  };
}

/**
 * A series' occurrences in the window, plus each snoozed one from outside it. Every
 * occurrence comes from expandSeries, so its key (instanceStartsAt) is the same one the
 * digests and the buttons use; exdated and cancelled occurrences never come back.
 */
function occurrencesOf(
  series: NativeEvent,
  overrides: NativeEventInstance[],
  range: { from: Date; to: Date },
  snoozedKeys: Date[]
): VirtualInstance[] {
  const occurrences = expandSeries(series, range, overrides);
  const seen = new Set(occurrences.map((o) => o.instanceStartsAt.getTime()));
  for (const key of snoozedKeys) {
    if (seen.has(key.getTime())) continue;
    // Expand just the stretch from the key to wherever an override moved it.
    const moved = overrides.find((o) => o.originalStartsAt.getTime() === key.getTime())?.startsAt ?? key;
    const around = {
      from: new Date(Math.min(key.getTime(), moved.getTime())),
      to: new Date(Math.max(key.getTime(), moved.getTime()) + 1),
    };
    const found = expandSeries(series, around, overrides).find((o) => o.instanceStartsAt.getTime() === key.getTime());
    if (found) {
      occurrences.push(found);
      seen.add(key.getTime());
    }
  }
  return occurrences;
}

/**
 * When this occurrence's time was last set: a moved occurrence when its override was
 * written, any other with its series.
 */
function armedAtOf(series: NativeEvent, occ: VirtualInstance, override: NativeEventInstance | undefined): Date | null {
  const moved = occ.startsAt.getTime() !== occ.instanceStartsAt.getTime() || occ.allDay !== series.allDay;
  return moved && override ? override.updatedAt : series.armedAt;
}

/** A send that may work on a later tick: Telegram's 429 and 5xx, or no answer at all. */
function isPassingFailure(error: unknown): boolean {
  const response = (error as { response?: { statusCode?: number; body?: { error_code?: number } } } | null)?.response;
  const status = response?.body?.error_code ?? response?.statusCode;
  return status === undefined || status === 429 || status >= 500;
}

/** Claim one occurrence and send its ping. */
async function pingOccurrence(
  series: NativeEvent,
  candidate: Candidate,
  creator: PassUser,
  recipient: PassUser & { telegramId: bigint },
  now: Date
): Promise<SendOutcome> {
  const claim = await claimOccurrence(series.id, candidate.occ.instanceStartsAt, candidate.due, now);
  if (!claim) return 'lost'; // another pass sent it, or it was just marked done

  let messageId: number;
  try {
    const text = await buildPingText({
      title: candidate.occ.title,
      creatorName: creator.id === recipient.id ? undefined : creator.name,
      language: recipient.language,
    });
    messageId = await sendPing(recipient.telegramId, text, await buildPingKeyboard(claim.id, recipient.language));
  } catch (error) {
    return handleSendFailure(error, claim, recipient);
  }

  try {
    await prisma.nativeReminderState.update({
      where: { id: claim.id },
      data: { pingChatId: recipient.telegramId, pingMessageId: messageId },
    });
  } catch (error) {
    // The ping went out; only a later edit to it (on a move) is lost.
    captureError(error, 'native-reminders-save-ping', { user_id: recipient.id }, 'warning');
  }
  trackActivityAsync(recipient.id, 'native_reminder_pinged', {
    for_partner: creator.id !== recipient.id,
    snoozed: candidate.snoozed,
    all_day: candidate.occ.allDay,
  });
  return 'sent';
}

/**
 * A chat that refuses us for good marks the user unreachable. A passing failure gives
 * the claim back for a later pass, up to MAX_PING_ATTEMPTS sends. Anything else keeps
 * the claim: a retry would be refused the same way.
 */
async function handleSendFailure(error: unknown, claim: Claim, recipient: PassUser): Promise<SendOutcome> {
  if (isUnreachableError(error)) {
    await markUserUnreachable(recipient.id, describeDeliveryError(error));
    return 'failed';
  }
  if (isPassingFailure(error) && claim.pingAttempts < MAX_PING_ATTEMPTS) {
    console.warn(`[NativeReminders] Ping to user ${recipient.id} failed (attempt ${claim.pingAttempts}), retrying: ${describeDeliveryError(error)}`);
    await releaseClaim(claim);
    return 'retry';
  }
  captureError(error, 'native-reminders-send', { user_id: recipient.id, attempts: claim.pingAttempts });
  return 'failed';
}

/**
 * Ping every reminder occurrence due now. Resolves to what it did and the earliest due
 * time still ahead (null when none is in the window), for the gate.
 */
export async function runNativeReminderPass(now: Date = new Date()): Promise<NativeReminderPassResult> {
  const result: NativeReminderPassResult = { sent: 0, skipped: 0, failed: 0, nextDue: null };
  if (!(await isNativeRemindersEnabled())) return result;

  const range = { from: new Date(now.getTime() - WINDOW_BACK_MS), to: new Date(now.getTime() + WINDOW_AHEAD_MS) };
  const { series, overridesBySeries, snoozedKeysBySeries } = await loadCandidateSeries(now, range);
  if (series.length === 0) return result;

  const expanded = series.flatMap((s) => {
    const overrides = overridesBySeries.get(s.id) ?? [];
    const snoozedKeys = (snoozedKeysBySeries.get(s.id) ?? []).map((k) => k.originalStartsAt);
    try {
      return [{ series: s, overrides, occurrences: occurrencesOf(s, overrides, range, snoozedKeys) }];
    } catch (error) {
      // A rule that can't be read fails the same way every time: report it, ping the rest.
      captureError(error, 'native-reminders-series', { series_id: s.id });
      result.failed++;
      return [];
    }
  });

  const keys = expanded.flatMap((e) => e.occurrences.map((o) => o.instanceStartsAt));
  const stateRows = keys.length
    ? await prisma.nativeReminderState.findMany({
        where: {
          seriesEventId: { in: expanded.map((e) => e.series.id) },
          originalStartsAt: { in: [...new Map(keys.map((k) => [k.getTime(), k])).values()] },
        },
      })
    : [];
  const states = new Map(stateRows.map((r) => [occurrenceKey(r.seriesEventId, r.originalStartsAt), r]));

  const users = perPass((id: number) => prisma.user.findUnique({ where: { id }, select: USER_SELECT }));
  const partnerOf = perPass(async (creatorId: number) => {
    const creator = await users(creatorId);
    return creator ? getActivePartnerSummary(creator.id, creator.pairingId) : null;
  });
  const timezoneOf = perPass(async (userId: number) => {
    const user = await users(userId);
    return resolveUserTimezone({ id: userId, location: user?.location ?? '' });
  });
  const isBlocked = perPass((telegramId: bigint) => isIdentifierBlocked({ telegramId }));
  const creatorSupported = perPass(async (creatorId: number) => {
    const creator = await users(creatorId);
    return !!creator && (await getReminderSupport(creator)).supported;
  });

  let retrySoon = false;
  for (const { series: s, overrides, occurrences } of expanded) {
    if (occurrences.length === 0) continue;
    try {
      const creator = await users(s.creatorUserId);
      if (!creator) continue;
      const ownerId = effectiveOwnerId(s, await partnerOf(creator.id));
      const recipient = ownerId === creator.id ? creator : await users(ownerId);
      if (!recipient) continue;
      const tz = await timezoneOf(recipient.id);

      const candidates: Candidate[] = [];
      for (const occ of occurrences) {
        const state = states.get(occurrenceKey(s.id, occ.instanceStartsAt));
        if (state?.doneAt) continue;
        const snoozed = !!state?.snoozedUntil;
        const due = state?.snoozedUntil ?? dueAtForOccurrence(occ, tz);
        if (due > now && (!result.nextDue || due < result.nextDue)) result.nextDue = due;
        candidates.push({ occ, due, snoozed, state });
      }

      const overrideAt = new Map(overrides.map((o) => [o.originalStartsAt.getTime(), o]));
      const eligible = candidates.filter((c) =>
        isEligible({
          due: c.due,
          now,
          armedAt: armedAtOf(s, c.occ, overrideAt.get(c.occ.instanceStartsAt.getTime())),
          snoozed: c.snoozed,
          lastPingedAt: c.state?.lastPingedAt ?? null,
          doneAt: c.state?.doneAt ?? null,
        })
      );
      if (eligible.length === 0) continue;

      const telegramId = recipient.telegramId;
      const reachable =
        telegramId != null &&
        !recipient.suspendedAt &&
        !recipient.unreachableSince &&
        !(await isBlocked(telegramId)) &&
        (await creatorSupported(creator.id));
      if (!reachable) {
        result.skipped += eligible.length;
        continue;
      }

      // One live ping per series: the newest due goes out. Older ones (a daily reminder
      // snoozed into the next day's) are claimed without a send, so they stay quiet.
      eligible.sort((a, b) => b.due.getTime() - a.due.getTime() || b.occ.instanceStartsAt.getTime() - a.occ.instanceStartsAt.getTime());
      const [newest, ...older] = eligible;
      for (const old of older) {
        await claimOccurrence(s.id, old.occ.instanceStartsAt, old.due, now);
        result.skipped++;
      }

      const outcome = await pingOccurrence(s, newest, creator, { ...recipient, telegramId }, now);
      if (outcome === 'sent') result.sent++;
      else if (outcome === 'lost') result.skipped++;
      else result.failed++;
      if (outcome === 'retry') retrySoon = true;
    } catch (error) {
      // A database blip on one series mustn't stop the others; the next tick tries it again.
      captureError(error, 'native-reminders-series', { series_id: s.id });
      result.failed++;
      retrySoon = true;
    }
  }

  if (retrySoon) {
    const retryAt = new Date(now.getTime() + RETRY_AFTER_MS);
    if (!result.nextDue || retryAt < result.nextDue) result.nextDue = retryAt;
  }
  return result;
}
```

- [ ] **Step 8: Add the cron handler**

The handler follows the contract order: it checks its running flag before `shouldRunPass` (which marks the start of a pass), and calls `setNextDue` only after a pass that succeeded. The running flag and the alert throttle live on `globalThis` (Global Constraints, cross-bundle state): the scheduler and the manual route in Step 10 load `handlers.ts` in separate bundles, so module-level `let`s would let a manual run overlap a scheduled one. The claim would still stop a double ping, but the gate and the alert throttle must be shared.

In `src/cron/handlers.ts` (`captureError` is already imported at line 7), find (lines 201-204):

```ts
/**
 * Setup reminders handler
 * Sends reminders to users who haven't completed their setup flow
 */
```

Replace with:

```ts
// The native reminder pass ticks every minute, so a tick that finds the last one still
// running skips, and a failing pass tells the admin at most once an hour. Both live on
// globalThis, like the due gate's memo: the scheduler (instrumentation.ts) and the
// manual route (app/api/native-reminders) load this file in separate bundles, and a
// module-level flag would let a manual run overlap a scheduled one.
const NATIVE_REMINDERS_ALERT_INTERVAL_MS = 60 * 60 * 1000;
type NativeRemindersCronState = { running: boolean; alertedAt: number };
const nativeRemindersCron = ((globalThis as { __nativeRemindersCron?: NativeRemindersCronState }).__nativeRemindersCron ??= {
  running: false,
  alertedAt: 0,
});

/**
 * Native reminders handler (built-in calendar reminders, not event alerts)
 * Pings the reminder occurrences due now. The database is read only when the in-process
 * due gate says something may be due; a pass that fails leaves the gate open, so the
 * next tick tries again.
 */
export async function handleNativeReminders(): Promise<void> {
  // The running flag first: shouldRunPass marks the start of a pass (due-gate.ts).
  if (nativeRemindersCron.running) return;
  nativeRemindersCron.running = true;
  const now = new Date();
  try {
    const { shouldRunPass, setNextDue } = await import('../services/native-reminders/due-gate');
    if (!shouldRunPass(now)) return;
    const { runNativeReminderPass } = await import('../services/native-reminders/pass');
    const result = await runNativeReminderPass(now);
    setNextDue(result.nextDue, now); // only after a pass that succeeded
    if (result.sent || result.skipped || result.failed) {
      console.log(`[NativeReminders] Sent ${result.sent}, skipped ${result.skipped}, failed ${result.failed}`);
    }
  } catch (error) {
    captureError(error, 'cron-native-reminders');
    if (now.getTime() - nativeRemindersCron.alertedAt >= NATIVE_REMINDERS_ALERT_INTERVAL_MS) {
      nativeRemindersCron.alertedAt = now.getTime();
      try {
        const { notifyAdminError } = await import('../utils/error-notifier');
        await notifyAdminError('Cron Job', error, 'Job: Native Reminders');
      } catch (notifyError) {
        captureError(notifyError, 'cron-admin-notify', { job: 'Native Reminders' }, 'warning');
      }
    }
  } finally {
    nativeRemindersCron.running = false;
  }
}

/**
 * Setup reminders handler
 * Sends reminders to users who haven't completed their setup flow
 */
```

- [ ] **Step 9: Schedule it every minute**

In `src/cron/scheduler.ts`, find (line 27):

```ts
  // Daily summary — every hour (filters by user preferred hour)
```

Replace with:

```ts
  // Native reminder pings — every minute. Separate from the event alerts above, which
  // return early when alerts are off; the pass reads the database only when its
  // in-process gate says something may be due, and handles its own errors.
  cron.schedule('* * * * *', async () => {
    try {
      const { handleNativeReminders } = await import('./handlers');
      await handleNativeReminders();
    } catch (error) {
      console.error('[Scheduler] Native reminders failed:', error);
      captureError(error, 'cron-native-reminders');
      notifyAdmin('Native Reminders', error);
    }
  });

  // Daily summary — every hour (filters by user preferred hour)
```

Then find (line 80):

```ts
  console.log('  */5 * * * *  Event reminders');
```

Replace with:

```ts
  console.log('  */5 * * * *  Event reminders');
  console.log('  * * * * *    Native reminders (gated: reads the DB only when one may be due)');
```

- [ ] **Step 10: Add the manual trigger**

Create `app/api/native-reminders/route.ts`:

```ts
import { NextRequest } from 'next/server';
import { withCronHandler } from '@/src/lib/cron-handler';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Manual trigger for the native reminder pass: opens the due gate, then runs one tick.
// The tick logs what it sent under [NativeReminders] and handles its own errors. The
// running flag and the gate are shared with the scheduler (globalThis), so if a
// scheduled pass is mid-run this tick skips, and the opened gate makes the next
// scheduled tick read.
export async function POST(request: NextRequest) {
  return withCronHandler(request, {
    jobName: 'Native Reminders',
    handler: async () => {
      const { invalidateDueGate } = await import('@/src/services/native-reminders/due-gate');
      const { handleNativeReminders } = await import('@/src/cron/handlers');
      invalidateDueGate();
      await handleNativeReminders();
      return { success: true, message: 'Native reminders pass ran' };
    },
  });
}
```

- [ ] **Step 11: Share the morning hour and the armed grace with the digest**

Task 7 computes a digest reminder's due time and armed bound before `due.ts` exists, so it keeps two local constants for this task to replace. In `src/services/native-reminders/open-reminders.ts`, find:

```ts
import { effectiveOwnerForViewer, loadViewerContext, type ViewerContext } from './ownership';
```

Replace with:

```ts
import { effectiveOwnerForViewer, loadViewerContext, type ViewerContext } from './ownership';
import { ARMED_GRACE_MS, REMINDER_MORNING_HOUR } from './due';
```

Then find:

```ts
export const OPEN_REMINDERS_DIGEST_CAP = 5;

// A date-only reminder is due at this hour of its day. The same rule as the ping's
// (due.ts: REMINDER_MORNING_HOUR, dueAtForOccurrence); read it from there once it exists.
const MORNING_HOUR = 9;
// A repeating reminder's occurrence due more than this before the series was armed was
// never pinged. The same grace as the ping's (due.ts: ARMED_GRACE_MS, isEligible); read it
// from there once it exists.
const ARMED_GRACE_MS = 15 * 60 * 1000;
```

Replace with:

```ts
export const OPEN_REMINDERS_DIGEST_CAP = 5;
```

Then find:

```ts
/**
 * When a reminder on a digest is due, in the viewer's timezone: its time, or
 * MORNING_HOUR on its date (an all-day start is already the event's own date).
 */
export function reminderDueAt(event: Pick<CalendarEvent, 'start'>, timezone: string): Date {
  if (event.start.includes('T')) return new Date(event.start);
  return fromZonedTime(`${event.start} ${String(MORNING_HOUR).padStart(2, '0')}:00:00`, timezone);
}
```

Replace with:

```ts
/**
 * When a reminder on a digest is due, in the viewer's timezone: its time, or
 * REMINDER_MORNING_HOUR (the ping's, due.ts) on its date (an all-day start is already
 * the event's own date).
 */
export function reminderDueAt(event: Pick<CalendarEvent, 'start'>, timezone: string): Date {
  if (event.start.includes('T')) return new Date(event.start);
  return fromZonedTime(`${event.start} ${String(REMINDER_MORNING_HOUR).padStart(2, '0')}:00:00`, timezone);
}
```

The armed bound in `selectOpenReminders` (`series.armedAt.getTime() - ARMED_GRACE_MS`) and its doc comment keep the same name, now the imported one. Check:

```bash
grep -n "MORNING_HOUR\|ARMED_GRACE_MS" src/services/native-reminders/open-reminders.ts
```

Expected: five lines, namely the `./due` import, the `reminderDueAt` doc comment and its `REMINDER_MORNING_HOUR` line, the `armedAt - ARMED_GRACE_MS` doc line, and the armed-bound `continue` line. No `const MORNING_HOUR` or `const ARMED_GRACE_MS` remains, and no bare `MORNING_HOUR` (each hit reads `REMINDER_MORNING_HOUR`).

`due.ts` imports nothing from `open-reminders.ts` (only `config/constants` and `utils/day-events`, which the digest already loads), so this adds no cycle. The digest compares due times in the viewer's timezone and the ping in the recipient's, so only the hour and the grace are shared, not `dueAtForOccurrence`.

- [ ] **Step 12: Run tests to verify they pass**

Run:
```bash
TZ=UTC npx tsx scripts/smoke-native-reminders.ts
TZ=Asia/Jerusalem npx tsx scripts/smoke-native-reminders.ts
for tz in UTC Asia/Jerusalem; do
  for s in smoke-reminders smoke-native-reminder-ownership smoke-native-reminder-store smoke-native-reminder-support smoke-native-provider-reminders smoke-native-reminder-digest; do
    printf '%-34s %-15s ' "$s" "$tz"; TZ=$tz npx tsx scripts/$s.ts 2>&1 | tail -1
  done
done
npx tsc --noEmit -p .
npm run -s lint
```

Expected:
- **The new smoke:** 40 `OK` lines, then `40/40 passed (process TZ=UTC)` and `40/40 passed (process TZ=Asia/Jerusalem)`, exit 0.
- **The regression loop:** every line ends `N/N passed (process TZ=…)` under both clocks, with the totals Tasks 1–7 left:
  - `smoke-reminders`: `23/23` (20 at the base commit, 3 from Task 5). It runs the real `handlers.ts`, so it also loads the new handler's `globalThis` state.
  - `smoke-native-reminder-ownership`: `22/22`
  - `smoke-native-reminder-store`: `20/20`
  - `smoke-native-reminder-support`: `30/30`
  - `smoke-native-provider-reminders`: `11/11`
  - `smoke-native-reminder-digest`: `31/31`. The hour is still 9 and the grace still 15 minutes, now read from `due.ts`.
- **`tsc` and `lint`:** each prints nothing and exits 0.

The new smoke, `smoke-reminders`, `tsc` and `lint` were checked against a scratch copy of the repo with Task 1's schema and helpers (its `globalThis` due gate), Task 4's `src/utils/html.ts`, and stand-ins for Task 4's `support.ts` and i18n keys. The other totals are the ones Tasks 1–7 report. Step 11's three edits were applied to Task 7's text of `open-reminders.ts`, and the check grep above matched.

- [ ] **Step 13: Commit**

```bash
git add src/services/native-reminders/due.ts \
  src/services/native-reminders/claim.ts \
  src/services/native-reminders/ping.ts \
  src/services/native-reminders/pass.ts \
  src/services/analytics-service.ts \
  src/cron/handlers.ts \
  src/cron/scheduler.ts \
  app/api/native-reminders/route.ts \
  src/services/native-reminders/open-reminders.ts \
  scripts/smoke-native-reminders.ts
git commit -F - <<'EOF'
feat(reminders): one-minute pass pings due reminders with Done/Snooze

A 1-minute cron runs the native reminder pass behind the in-process due
gate. It expands REMINDER series around now, works out each occurrence's
due time (09:00 in the recipient's timezone for a date-only one), and
pings the effective owner once: each send is preceded by an atomic
ON CONFLICT claim on the occurrence's state row, so overlapping ticks or
a second process during a deploy can't double-ping. The buttons carry
that row's id. A daily reminder snoozed into the next morning pings once.
Passing send failures give the claim back for up to three attempts; a
blocked chat marks the user unreachable. Event alerts are untouched.

The handler's running flag and alert throttle live on globalThis, shared
with the manual route's bundle like the due gate. The digest now reads
its morning hour and armed grace from due.ts.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
EOF
```

---

### Task 9: Done and Snooze buttons

**Files:**
- Create: `src/services/native-reminders/callbacks.ts` — the `nr:` button handler: parse, re-validate the occurrence, authorize the tapper, write Done or Snooze conditionally on `doneAt IS NULL`, edit the ping, tell the creator, and answer the tap exactly once without ever throwing.
- Modify: `src/services/webhook-handlers.ts:200-205` — the callback `if/else` chain routes `nr:` to `handleNativeReminderCallback`, and a final `else` answers any unknown prefix so its spinner stops (spec §11.8).
- Test: `scripts/smoke-native-reminder-buttons.ts` (new).

**Interfaces:**
- Consumes (from earlier tasks, exactly as in the contract):
  ```ts
  // Task 1: src/services/native-reminders/ownership.ts, due-gate.ts
  export async function getActivePartnerSummary(userId: number, pairingId: string | null): Promise<PartnerSummary | null>;
  export function effectiveOwnerId(series: { creatorUserId: number; forUserId: number | null }, creatorPartner: { id: number; calendarSource: string } | null): number;
  export function invalidateDueGate(): void;
  export function shouldRunPass(now: Date): boolean;                // test only
  export function setNextDue(next: Date | null, now: Date): void;   // test only
  export function __resetDueGateForTests(): void;                   // test only
  // Task 1 (Prisma): prisma.nativeReminderState, its seriesEvent relation, NativeEvent.kind / forUserId, NativeEvent.instances
  // Task 4: src/utils/html.ts (leaf module; confirmations.ts re-exports it)
  export function escapeHtml(text: string): string;
  // Task 4: messages/{en,he,ru}.json → bot.nativeReminders.{done, snoozedUntil, alreadyDone, notYours, changed, doneBy}
  // Task 8: src/services/native-reminders/due.ts, ping.ts, analytics-service.ts
  export function tomorrowMorning(now: Date, tz: string): Date;
  export function buildPingKeyboard(stateId: string, language: string): Promise<TelegramBot.InlineKeyboardMarkup>; // test only
  export async function stripPingButtons(chatId: bigint | number, messageId: number, text: string): Promise<void>;
  // ActivityAction gains 'native_reminder_done' | 'native_reminder_snoozed'
  ```
  Existing code, unchanged: `getUserByTelegramId(telegramId: number | bigint): Promise<UserConfig | null>` (`src/services/user-service.ts:18`), `getBotMessage(locale, keyPath, params?)` (`src/lib/bot-messages.ts:55`), `resolveUserTimezone(user)` (`src/lib/timezone.ts:20`), `expandSeries(event, range, overrides?)` (`src/services/native-calendar/recurrence.ts`), `isUnreachableError` / `describeDeliveryError` (`src/lib/delivery-errors.ts`), `markUserUnreachable(userId, reason)` (`src/lib/user-reachability.ts:23`), `getBot()` (`src/services/telegram/bot.ts:86`), `trackActivityAsync`, `captureError`.
- Produces (exactly as in the contract; `now` is an optional extra for smoke scripts, so a one-argument call is the contract's signature):
  ```ts
  // src/services/native-reminders/callbacks.ts
  export const NATIVE_REMINDER_CALLBACK_PREFIX = 'nr:';
  export function parseNativeReminderCallback(data: string): { op: 'd' | 's15' | 's60' | 'st'; stateId: string } | null;
  export async function handleNativeReminderCallback(query: TelegramBot.CallbackQuery, now?: Date): Promise<void>;
  ```
- Behaviour later tasks rely on:
  - Callback data is `nr:<op>:<stateId>` with `op ∈ d|s15|s60|st` and a state id of 1–57 characters from `[A-Za-z0-9_-]` (a cuid is 25, a UUID 36; the longest data, `nr:s15:<57>`, is 64 bytes).
  - The handler answers the callback exactly once, in a `finally`, so the toast can carry the outcome (spec §5 says "answer first"; see the note at Step 3). It never throws.
  - A stale tap (no state row; series deleted or no longer `REMINDER`; calendar deleted; occurrence cancelled, exdated or cut off) and an ex-owner's tap (the tapper is `forUserId` but no longer the effective owner) answer `changed` and drop the buttons with `editMessageReplyMarkup`, leaving the ping's text as it was. A tapper who is neither the effective owner nor the creator, and never was, answers `notYours` and changes nothing.
  - Done writes `doneAt = now`, `doneByUserId = tapper`. Snooze writes `snoozedUntil` and leaves `lastPingedAt` alone, so `lastPingedAt < snoozedUntil` and the pass pings again then. Both are conditional on `doneAt IS NULL`; a miss answers `alreadyDone` and shows the ping as done.

- [ ] **Step 1: Write the failing test**

Create `scripts/smoke-native-reminder-buttons.ts`:

```ts
// Smoke test for the ✅ Done / 💤 Snooze buttons on a native reminder ping:
// src/services/native-reminders/callbacks.ts, and the nr: branch and the unknown-prefix
// answer in src/services/webhook-handlers.ts. The buttons never expire, so a tap can
// come after the reminder was moved, deleted, done by the other person, or after the
// pair unlinked. Each such tap must get a short answer and never a throw: a throw fails
// the webhook with a 500, and Telegram redelivers the tap in a loop. Prisma, the bot,
// the user lookup and the timezone lookup are faked. No network, no DB.
//
// Run under both clocks; the output must not depend on the server's timezone:
//   TZ=UTC npx tsx scripts/smoke-native-reminder-buttons.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-native-reminder-buttons.ts

import path from 'path';
import type TelegramBot from 'node-telegram-bot-api';
import { __resetDueGateForTests, setNextDue, shouldRunPass } from '../src/services/native-reminders/due-gate';

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
}

function assert(cond: boolean, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

/** JSON that can show BigInt ids and Dates. */
const show = (value: unknown) => JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? `${v}n` : v));

/** Any request that slips past the fakes is refused and counted. */
const networkAttempts: string[] = [];
globalThis.fetch = (async (input: unknown) => {
  networkAttempts.push(String(input));
  throw new Error('network is blocked in this smoke test');
}) as typeof fetch;

// ---- The world: users, a pairing, a calendar, reminders and their state rows ----

type Row = Record<string, unknown>;
const RAZIEL = 1; // creator, Hebrew, Israel
const DANA = 2; // Raziel's partner, English, New York
const NOA = 3; // a stranger, Russian, Moscow
const TIMEZONES: Record<number, string> = { [RAZIEL]: 'Asia/Jerusalem', [DANA]: 'America/New_York', [NOA]: 'Europe/Moscow' };
const tg = (userId: number) => 1000 + userId;

// State row ids are cuids, 25 characters.
const MILK = 'cmilk00000000000000000001'; // Raziel's one-off "Buy milk" for Dana, pinged to Dana
const CALL = 'ccall00000000000000000002'; // Raziel's own one-off, pinged to Raziel
const PILLS = 'cpill00000000000000000003'; // Dana's own daily 08:00, today's occurrence
const MOVED = 'cmove00000000000000000004'; // Dana's daily, an occurrence moved to 18:30
const MILK_MSG = 501;
const CALL_MSG = 502;
const PILLS_MSG = 503;
const MOVED_MSG = 504;

const PILLS_TODAY = new Date('2026-10-14T12:00:00Z'); // Wed 08:00 in New York
const PILLS_FRIDAY = new Date('2026-10-16T12:00:00Z');

interface World { users: Row[]; pairings: Row[]; calendars: Row[]; events: Row[]; instances: Row[]; states: Row[] }
let world: World;

function freshWorld(): World {
  const event = (row: Row): Row => ({
    calendarId: 'cal-raziel', description: null, location: null, allDay: false, rrule: null, exdates: [],
    reminderMinutes: null, kind: 'REMINDER', forUserId: null, armedAt: new Date('2026-10-13T08:00:00Z'), isDeleted: false,
    createdAt: new Date('2026-10-13T08:00:00Z'), updatedAt: new Date('2026-10-13T08:00:00Z'),
    ...row,
    endsAt: row.startsAt,
  });
  const state = (row: Row): Row => ({
    doneAt: null, doneByUserId: null, snoozedUntil: null, lastPingedAt: new Date('2026-10-14T13:00:00Z'), pingAttempts: 1,
    createdAt: new Date('2026-10-14T13:00:00Z'), updatedAt: new Date('2026-10-14T13:00:00Z'), ...row,
  });
  return {
    users: [
      { id: RAZIEL, name: 'רזיאל', englishName: 'Raziel', gender: 'male', language: 'he', telegramId: BigInt(tg(RAZIEL)), calendarSource: 'NATIVE', pairingId: 'pair-1', location: 'Tel Aviv', suspendedAt: null, unreachableSince: null },
      { id: DANA, name: 'Dana', englishName: 'Dana', gender: 'female', language: 'en', telegramId: BigInt(tg(DANA)), calendarSource: 'NATIVE', pairingId: 'pair-1', location: 'New York', suspendedAt: null, unreachableSince: null },
      { id: NOA, name: 'Ноа', englishName: 'Noa', gender: 'female', language: 'ru', telegramId: BigInt(tg(NOA)), calendarSource: 'NATIVE', pairingId: null, location: 'Moscow', suspendedAt: null, unreachableSince: null },
    ],
    pairings: [{ id: 'pair-1', status: 'ACTIVE', inviterUserId: RAZIEL, inviteeUserId: DANA }],
    calendars: [
      { id: 'cal-raziel', ownerUserId: RAZIEL, privacy: 'PRIVATE', isDeleted: false },
      { id: 'cal-dana', ownerUserId: DANA, privacy: 'SHARED_VIEWER', isDeleted: false },
    ],
    events: [
      event({ id: 'ev-milk', creatorUserId: RAZIEL, forUserId: DANA, title: 'Buy milk', startsAt: new Date('2026-10-14T13:00:00Z'), timeZone: 'Asia/Jerusalem' }),
      event({ id: 'ev-call', creatorUserId: RAZIEL, title: 'Call the plumber', startsAt: new Date('2026-10-14T07:00:00Z'), timeZone: 'Asia/Jerusalem' }),
      event({ id: 'ev-pills', calendarId: 'cal-dana', creatorUserId: DANA, title: 'Pills', startsAt: new Date('2026-10-01T12:00:00Z'), timeZone: 'America/New_York', rrule: 'FREQ=DAILY' }),
    ],
    instances: [
      { id: 'ov-1', seriesEventId: 'ev-pills', originalStartsAt: PILLS_FRIDAY, status: 'OVERRIDE', title: 'Pills (late)', description: null, location: null, startsAt: new Date('2026-10-16T22:30:00Z'), endsAt: new Date('2026-10-16T22:30:00Z'), allDay: null, createdAt: new Date(), updatedAt: new Date() },
    ],
    states: [
      state({ id: MILK, seriesEventId: 'ev-milk', originalStartsAt: new Date('2026-10-14T13:00:00Z'), pingChatId: BigInt(tg(DANA)), pingMessageId: MILK_MSG }),
      state({ id: CALL, seriesEventId: 'ev-call', originalStartsAt: new Date('2026-10-14T07:00:00Z'), pingChatId: BigInt(tg(RAZIEL)), pingMessageId: CALL_MSG }),
      state({ id: PILLS, seriesEventId: 'ev-pills', originalStartsAt: PILLS_TODAY, pingChatId: BigInt(tg(DANA)), pingMessageId: PILLS_MSG }),
      state({ id: MOVED, seriesEventId: 'ev-pills', originalStartsAt: PILLS_FRIDAY, pingChatId: BigInt(tg(DANA)), pingMessageId: MOVED_MSG }),
    ],
  };
}

const user = (id: number) => world.users.find(u => u.id === id)!;
const stateRow = (id: string) => world.states.find(s => s.id === id)!;
const eventRow = (id: string) => world.events.find(e => e.id === id)!;

// ---- Fake Prisma ----

/** Prisma returns only the selected columns, so a column the code forgets to select is missing. */
const pick = (row: Row | undefined, select?: Record<string, boolean>) =>
  !row ? null : !select ? row : Object.fromEntries(Object.keys(select).filter(k => select[k]).map(k => [k, row[k]]));
/** A `where` of plain values, where null means "is null". */
const matches = (row: Row, where: Row) => Object.entries(where).every(([k, v]) => (v === null ? row[k] == null : row[k] === v));

let dbDown = false;
type FindUnique = { where: { id: unknown }; select?: Record<string, boolean> };
type Include = { seriesEvent: { include: { calendar: { select: Record<string, boolean> }; creator: { select: Record<string, boolean> }; instances: boolean } } };
const fakePrisma = {
  nativeReminderState: {
    findUnique: async ({ where, include }: { where: { id: string }; include: Include }) => {
      if (dbDown) throw new Error('Can\'t reach database server');
      const state = world.states.find(s => s.id === where.id);
      if (!state) return null;
      const series = eventRow(state.seriesEventId as string);
      const inc = include.seriesEvent.include;
      return {
        ...state,
        seriesEvent: {
          ...series,
          calendar: pick(world.calendars.find(c => c.id === series.calendarId), inc.calendar.select),
          creator: pick(user(series.creatorUserId as number), inc.creator.select),
          instances: world.instances.filter(i => i.seriesEventId === series.id),
        },
      };
    },
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      const rows = world.states.filter(s => matches(s, where));
      for (const row of rows) Object.assign(row, data);
      return { count: rows.length };
    },
  },
  pairing: {
    findUnique: async ({ where, select }: FindUnique) => pick(world.pairings.find(p => p.id === where.id), select),
  },
  user: {
    findUnique: async ({ where, select }: FindUnique) => pick(world.users.find(u => u.id === where.id), select),
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      const rows = world.users.filter(u => matches(u, where));
      for (const row of rows) Object.assign(row, data);
      return { count: rows.length };
    },
  },
};

// ---- Fake bot: records every answer, edit and send ----

type BotCall =
  | { kind: 'answer'; queryId: string; text?: string }
  | { kind: 'edit'; chatId: number; messageId: number; text: string; buttons: boolean; html: boolean }
  | { kind: 'markup'; chatId: number; messageId: number; buttons: boolean }
  | { kind: 'send'; chatId: number; text: string; silent: boolean; html: boolean };
let botCalls: BotCall[] = [];
const botFailures: { edit?: Error; markup?: Error; answer?: Error; send?: Error } = {};

/** A Telegram API error as node-telegram-bot-api throws it. */
const telegramError = (status: number, description: string) =>
  Object.assign(new Error(`ETELEGRAM: ${status} ${description}`), { code: 'ETELEGRAM', response: { body: { error_code: status, description } } });

/** Whether reply_markup (an object, or the JSON string the adapter sends) still has buttons. */
function hasButtons(markup: unknown): boolean {
  const parsed = typeof markup === 'string' ? JSON.parse(markup) : markup;
  return !!(parsed as TelegramBot.InlineKeyboardMarkup | undefined)?.inline_keyboard?.some(row => row.length > 0);
}

type EditOptions = { chat_id?: number | string; message_id?: number; parse_mode?: string; reply_markup?: unknown };
const fakeBot = {
  answerCallbackQuery: async (queryId: string, options?: { text?: string }) => {
    botCalls.push({ kind: 'answer', queryId, text: options?.text });
    if (botFailures.answer) throw botFailures.answer;
    return true;
  },
  editMessageText: async (text: string, options: EditOptions) => {
    botCalls.push({ kind: 'edit', chatId: Number(options.chat_id), messageId: Number(options.message_id), text, buttons: hasButtons(options.reply_markup), html: options.parse_mode === 'HTML' });
    if (botFailures.edit) throw botFailures.edit;
    return true;
  },
  editMessageReplyMarkup: async (markup: TelegramBot.InlineKeyboardMarkup, options: EditOptions) => {
    botCalls.push({ kind: 'markup', chatId: Number(options.chat_id), messageId: Number(options.message_id), buttons: hasButtons(markup) });
    if (botFailures.markup) throw botFailures.markup;
    return true;
  },
  sendMessage: async (chatId: number | string, text: string, options?: { parse_mode?: string; disable_notification?: boolean }) => {
    botCalls.push({ kind: 'send', chatId: Number(chatId), text, silent: options?.disable_notification === true, html: options?.parse_mode === 'HTML' });
    if (botFailures.send) throw botFailures.send;
    return { message_id: 900 };
  },
};

// ---- The other fakes ----

const captured: string[] = [];
const activity: { userId: number; action: string; meta?: Row }[] = [];

/** The UserConfig getUserByTelegramId returns: the row with a numeric telegramId. */
async function fakeGetUserByTelegramId(telegramId: number | bigint) {
  const row = world.users.find(u => u.telegramId === BigInt(telegramId));
  return row ? { ...row, telegramId: Number(row.telegramId) } : null;
}

// ---- Scenario helpers ----

let queryCount = 0;
/** A tap by `userId` on a button of message `messageId` in their own chat. */
function tap(userId: number, data: string, messageId: number): TelegramBot.CallbackQuery {
  queryCount++;
  return {
    id: `q${queryCount}`,
    from: { id: tg(userId), is_bot: false, first_name: 'Tapper' },
    chat_instance: 'ci',
    data,
    message: { message_id: messageId, date: 0, chat: { id: tg(userId), type: 'private' } },
  } as TelegramBot.CallbackQuery;
}

function reset() {
  world = freshWorld();
  botCalls = [];
  captured.length = 0;
  activity.length = 0;
  dbDown = false;
  for (const key of Object.keys(botFailures) as (keyof typeof botFailures)[]) delete botFailures[key];
}

const answersTo = (q: TelegramBot.CallbackQuery) =>
  botCalls.filter((c): c is Extract<BotCall, { kind: 'answer' }> => c.kind === 'answer' && c.queryId === q.id);
/** Every tap is answered exactly once; returns the toast. */
function toastOf(q: TelegramBot.CallbackQuery): string | undefined {
  const answers = answersTo(q);
  assert(answers.length === 1, `answered ${answers.length} times`);
  return answers[0].text;
}
const edits = () => botCalls.filter((c): c is Extract<BotCall, { kind: 'edit' }> => c.kind === 'edit');
const markups = () => botCalls.filter((c): c is Extract<BotCall, { kind: 'markup' }> => c.kind === 'markup');
const sends = () => botCalls.filter((c): c is Extract<BotCall, { kind: 'send' }> => c.kind === 'send');

/** The ping was edited to `text` with its buttons gone, and nothing else was edited. */
function assertEditedTo(chatId: number, messageId: number, text: string) {
  const all = edits();
  assert(all.length >= 1, 'the ping was not edited');
  assert(all.every(e => e.chatId === chatId && e.messageId === messageId), `edited ${show(all)}`);
  const last = all[all.length - 1];
  assert(last.text === text, `\n     text ${show(last.text)}\n     want ${show(text)}`);
  assert(last.html && !last.buttons, `html ${last.html}, buttons ${last.buttons}`);
}

/** The buttons came off message `messageId` and its text was left alone. */
function assertButtonsRemoved(chatId: number, messageId: number) {
  assert(edits().length === 0, `text edited: ${show(edits())}`);
  const removed = markups();
  assert(removed.length === 1 && removed[0].chatId === chatId && removed[0].messageId === messageId && !removed[0].buttons,
    `markup edits ${show(removed)}`);
}

function assertUntouched(id: string) {
  const row = stateRow(id);
  assert(row.doneAt === null && row.snoozedUntil === null, `state written: ${show(row)}`);
}

// 10:00 in New York, 17:00 in Israel, on Wednesday 14 Oct 2026.
const NOW = new Date('2026-10-14T14:00:00Z');
const MIN = 60 * 1000;

async function main() {
  // The stubs go into require's cache before the modules that import them load.
  const Module = (await import('module')).default as unknown as {
    new (id: string): { filename: string; loaded: boolean; exports: unknown };
    _cache: Record<string, unknown>;
  };
  const stub = (file: string, exports: Record<string, unknown>) => {
    const filename = path.resolve(__dirname, '../src', file);
    const mod = new Module(filename);
    Object.assign(mod, { filename, loaded: true, exports });
    Module._cache[filename] = mod;
  };
  // The ping module may edit through the bot or through the Telegram adapter; both reach fakeBot.
  let adapter: unknown = null;
  const telegram = { getBot: () => fakeBot, getMessagingService: () => adapter };
  stub('utils/prisma.ts', { prisma: fakePrisma });
  stub('utils/redis.ts', { redis: {} }); // nothing on this path may reach Redis
  stub('services/telegram/bot.ts', telegram);
  stub('services/telegram/index.ts', telegram);
  stub('services/user-service.ts', { getUserByTelegramId: fakeGetUserByTelegramId });
  stub('lib/timezone.ts', { resolveUserTimezone: async (u: { id: number }) => TIMEZONES[u.id] });
  stub('lib/error-capture.ts', {
    captureError: (err: unknown, context: string) => { captured.push(`${context}: ${err instanceof Error ? err.message : String(err)}`); },
    captureWarning: () => {},
    captureInfo: () => {},
  });
  stub('services/analytics-service.ts', {
    trackActivityAsync: (userId: number, action: string, meta?: Row) => { activity.push({ userId, action, meta }); },
    setUserContext: () => {},
    addBreadcrumb: () => {},
  });
  // What the webhook handler loads besides the callback branch.
  stub('services/voice/index.ts', {});
  stub('services/voice/speech-presence.ts', { NO_SPEECH: 'no_speech' });
  stub('services/payment-handler.ts', {});
  stub('lib/user-moderation.ts', { isIdentifierBlocked: async () => false, isUserSuspended: () => false });

  const { TelegramAdapter } = await import('../src/services/messaging/telegram-adapter');
  adapter = new TelegramAdapter(fakeBot as unknown as TelegramBot);
  const { handleNativeReminderCallback, parseNativeReminderCallback, NATIVE_REMINDER_CALLBACK_PREFIX } =
    await import('../src/services/native-reminders/callbacks');
  const { buildPingKeyboard } = await import('../src/services/native-reminders/ping');
  const { getBotMessage } = await import('../src/lib/bot-messages');
  /** Hebrew and Russian copy as messages/*.json has it; the English is the plan's reference copy. */
  const copy = (language: string, key: string, params?: Record<string, string>) =>
    getBotMessage(language, `nativeReminders.${key}`, params);
  const { handleTelegramWebhook } = await import('../src/services/webhook-handlers');

  // ---- Callback data ----

  await check('parse: each button\'s data names its op and state row', () => {
    for (const op of ['d', 's15', 's60', 'st'] as const) {
      assert(show(parseNativeReminderCallback(`nr:${op}:${MILK}`)) === show({ op, stateId: MILK }), `nr:${op}`);
    }
    assert(NATIVE_REMINDER_CALLBACK_PREFIX === 'nr:', `prefix ${NATIVE_REMINDER_CALLBACK_PREFIX}`);
  });

  await check('parse: anything else is not a reminder button', () => {
    for (const data of ['nr:x:abc', 'nr:d:', `nr:d:${MILK}:extra`, `nr:s30:${MILK}`, 'nr:d:a b', `event_create:${MILK}`, `nr:d:${'a'.repeat(58)}`, '']) {
      assert(parseNativeReminderCallback(data) === null, `parsed ${show(data)}`);
    }
  });

  await check('parse: the ping keyboard\'s data fits 64 bytes and parses back, for a cuid and a uuid', async () => {
    for (const stateId of [MILK, '0f8fad5b-d9cb-469f-a165-70867728950e']) {
      const keyboard = await buildPingKeyboard(stateId, 'he');
      const data = keyboard.inline_keyboard.flat().map(b => b.callback_data ?? '');
      assert(show(data) === show([`nr:d:${stateId}`, `nr:s15:${stateId}`, `nr:s60:${stateId}`, `nr:st:${stateId}`]), `data ${show(data)}`);
      for (const d of data) {
        assert(Buffer.byteLength(d, 'utf8') <= 64, `${d} is ${Buffer.byteLength(d, 'utf8')} bytes`);
        assert(parseNativeReminderCallback(d)?.stateId === stateId, `${d} does not parse back`);
      }
    }
  });

  // ---- Done: who may tap ----

  await check('Done by the owner: marked done by them, ping edited, creator told quietly in Hebrew', async () => {
    reset();
    const q = tap(DANA, `nr:d:${MILK}`, MILK_MSG);
    await handleNativeReminderCallback(q, NOW);
    assert(toastOf(q) === undefined, `toast ${toastOf(q)}`);
    const row = stateRow(MILK);
    assert(show(row.doneAt) === show(NOW) && row.doneByUserId === DANA, `state ${show(row)}`);
    assertEditedTo(tg(DANA), MILK_MSG, '✅ Buy milk');
    const notices = sends();
    assert(notices.length === 1, `sends ${show(notices)}`);
    assert(notices[0].chatId === tg(RAZIEL) && notices[0].silent && notices[0].html, `notice ${show(notices[0])}`);
    const notice = await copy('he', 'doneBy', { name: 'Dana', title: 'Buy milk' });
    assert(notices[0].text === notice, `notice text ${show(notices[0].text)}, want ${show(notice)}`);
    assert(show(activity) === show([{ userId: DANA, action: 'native_reminder_done', meta: { series_event_id: 'ev-milk' } }]), `activity ${show(activity)}`);
  });

  await check('Done twice: the second tap says "already done" and nobody is told again', async () => {
    reset();
    await handleNativeReminderCallback(tap(DANA, `nr:d:${MILK}`, MILK_MSG), NOW);
    const second = tap(DANA, `nr:d:${MILK}`, MILK_MSG);
    await handleNativeReminderCallback(second, new Date(NOW.getTime() + MIN));
    assert(toastOf(second) === 'Already done 👍', `toast ${toastOf(second)}`);
    assert(show(stateRow(MILK).doneAt) === show(NOW), `doneAt moved: ${show(stateRow(MILK).doneAt)}`);
    assert(sends().length === 1, `${sends().length} notices`);
    assert(activity.length === 1, `${activity.length} activities`);
  });

  await check('Done by the creator on their own reminder: no notice', async () => {
    reset();
    const q = tap(RAZIEL, `nr:d:${CALL}`, CALL_MSG);
    await handleNativeReminderCallback(q, NOW);
    assert(toastOf(q) === undefined, `toast ${toastOf(q)}`);
    assert(stateRow(CALL).doneByUserId === RAZIEL, `state ${show(stateRow(CALL))}`);
    assertEditedTo(tg(RAZIEL), CALL_MSG, '✅ Call the plumber');
    assert(sends().length === 0, `sends ${show(sends())}`);
  });

  await check('Done by the creator on the partner\'s reminder: allowed, no notice to themselves', async () => {
    reset();
    const q = tap(RAZIEL, `nr:d:${MILK}`, 777);
    await handleNativeReminderCallback(q, NOW);
    assert(toastOf(q) === undefined, `toast ${toastOf(q)}`);
    assert(stateRow(MILK).doneByUserId === RAZIEL, `state ${show(stateRow(MILK))}`);
    assert(sends().length === 0, `sends ${show(sends())}`);
  });

  await check('a stranger\'s tap: "not yours" in their language, nothing written or edited', async () => {
    reset();
    const q = tap(NOA, `nr:d:${MILK}`, 601);
    await handleNativeReminderCallback(q, NOW);
    assert(toastOf(q) === (await copy('ru', 'notYours')), `toast ${toastOf(q)}`);
    assertUntouched(MILK);
    assert(edits().length === 0 && markups().length === 0 && sends().length === 0, `bot calls ${show(botCalls)}`);
  });

  await check('a tap from someone with no account: "not yours", in English', async () => {
    reset();
    const q = { ...tap(NOA, `nr:d:${MILK}`, 601), from: { id: 4242, is_bot: false, first_name: 'Ghost' } };
    await handleNativeReminderCallback(q, NOW);
    assert(toastOf(q) === 'This reminder isn\'t yours.', `toast ${toastOf(q)}`);
    assertUntouched(MILK);
  });

  await check('after unlinking: the ex-partner\'s old ping says "changed" and loses its buttons', async () => {
    reset();
    world.pairings[0].status = 'UNLINKED';
    user(RAZIEL).pairingId = null;
    user(DANA).pairingId = null;
    const q = tap(DANA, `nr:d:${MILK}`, MILK_MSG);
    await handleNativeReminderCallback(q, NOW);
    assert(toastOf(q) === 'This reminder changed or no longer exists.', `toast ${toastOf(q)}`);
    assertUntouched(MILK);
    assertButtonsRemoved(tg(DANA), MILK_MSG);
    assert(sends().length === 0, `sends ${show(sends())}`);
  });

  await check('after unlinking: the creator can still mark it done', async () => {
    reset();
    world.pairings[0].status = 'UNLINKED';
    user(RAZIEL).pairingId = null;
    user(DANA).pairingId = null;
    const q = tap(RAZIEL, `nr:d:${MILK}`, 777);
    await handleNativeReminderCallback(q, NOW);
    assert(toastOf(q) === undefined, `toast ${toastOf(q)}`);
    assert(stateRow(MILK).doneByUserId === RAZIEL, `state ${show(stateRow(MILK))}`);
  });

  await check('the partner moved to Google: their old ping says "changed"', async () => {
    reset();
    user(DANA).calendarSource = 'GOOGLE';
    const q = tap(DANA, `nr:s15:${MILK}`, MILK_MSG);
    await handleNativeReminderCallback(q, NOW);
    assert(toastOf(q) === 'This reminder changed or no longer exists.', `toast ${toastOf(q)}`);
    assertUntouched(MILK);
    assertButtonsRemoved(tg(DANA), MILK_MSG);
  });

  // ---- Stale buttons ----

  const staleCases: [string, () => void, string, number][] = [
    ['the time changed (the re-arm deleted the state row)', () => { world.states = world.states.filter(s => s.id !== MILK); }, MILK, MILK_MSG],
    ['the reminder was deleted', () => { eventRow('ev-milk').isDeleted = true; }, MILK, MILK_MSG],
    ['its calendar was deleted', () => { world.calendars[0].isDeleted = true; }, MILK, MILK_MSG],
    ['it is no longer a reminder', () => { eventRow('ev-milk').kind = 'EVENT'; }, MILK, MILK_MSG],
    ['today\'s occurrence was skipped (exdate)', () => { eventRow('ev-pills').exdates = [PILLS_TODAY]; }, PILLS, PILLS_MSG],
    ['the occurrence was cancelled (override)', () => {
      world.instances.push({ id: 'ov-2', seriesEventId: 'ev-pills', originalStartsAt: PILLS_TODAY, status: 'CANCELLED', title: null, startsAt: null, endsAt: null, allDay: null });
    }, PILLS, PILLS_MSG],
    ['"delete from today on" cut the series before it', () => { eventRow('ev-pills').rrule = 'FREQ=DAILY;UNTIL=20261013T235959'; }, PILLS, PILLS_MSG],
  ];
  for (const [what, change, stateId, messageId] of staleCases) {
    await check(`stale: ${what} → "changed", buttons removed, nothing written`, async () => {
      reset();
      change();
      const q = tap(DANA, `nr:d:${stateId}`, messageId);
      await handleNativeReminderCallback(q, NOW);
      assert(toastOf(q) === 'This reminder changed or no longer exists.', `toast ${toastOf(q)}`);
      assertButtonsRemoved(tg(DANA), messageId);
      if (world.states.some(s => s.id === stateId)) assertUntouched(stateId);
      assert(sends().length === 0 && activity.length === 0, `side effects ${show({ sends: sends(), activity })}`);
    });
  }

  await check('an occurrence moved to another time is still found by its key, with its own title', async () => {
    reset();
    const q = tap(DANA, `nr:d:${MOVED}`, MOVED_MSG);
    await handleNativeReminderCallback(q, NOW);
    assert(toastOf(q) === undefined, `toast ${toastOf(q)}`);
    assert(stateRow(MOVED).doneByUserId === DANA, `state ${show(stateRow(MOVED))}`);
    assertEditedTo(tg(DANA), MOVED_MSG, '✅ Pills (late)');
  });

  await check('a daily reminder\'s live occurrence is marked done on its own row only', async () => {
    reset();
    const q = tap(DANA, `nr:d:${PILLS}`, PILLS_MSG);
    await handleNativeReminderCallback(q, NOW);
    assert(toastOf(q) === undefined, `toast ${toastOf(q)}`);
    assert(stateRow(PILLS).doneByUserId === DANA && stateRow(MOVED).doneAt === null, `states ${show(world.states)}`);
    assertEditedTo(tg(DANA), PILLS_MSG, '✅ Pills');
  });

  // ---- Snooze ----

  await check('snooze 15 min: snoozedUntil = now + 15, ping says until 10:15 New York time, gate opens', async () => {
    reset();
    __resetDueGateForTests();
    setNextDue(new Date(NOW.getTime() + 50 * MIN), NOW);
    assert(!shouldRunPass(new Date(NOW.getTime() + MIN)), 'gate open before the snooze');
    const q = tap(DANA, `nr:s15:${MILK}`, MILK_MSG);
    await handleNativeReminderCallback(q, NOW);
    assert(toastOf(q) === undefined, `toast ${toastOf(q)}`);
    assert(show(stateRow(MILK).snoozedUntil) === show(new Date(NOW.getTime() + 15 * MIN)), `snoozedUntil ${show(stateRow(MILK).snoozedUntil)}`);
    assert(stateRow(MILK).doneAt === null, 'marked done');
    assertEditedTo(tg(DANA), MILK_MSG, '💤 Buy milk · until 10:15');
    assert(shouldRunPass(new Date(NOW.getTime() + MIN)), 'gate still closed after the snooze');
    assert(show(activity) === show([{ userId: DANA, action: 'native_reminder_snoozed', meta: { snooze: 's15' } }]), `activity ${show(activity)}`);
  });

  await check('snooze 1 hour: now + 60', async () => {
    reset();
    const q = tap(DANA, `nr:s60:${MILK}`, MILK_MSG);
    await handleNativeReminderCallback(q, NOW);
    assert(show(stateRow(MILK).snoozedUntil) === show(new Date(NOW.getTime() + 60 * MIN)), `snoozedUntil ${show(stateRow(MILK).snoozedUntil)}`);
    assertEditedTo(tg(DANA), MILK_MSG, '💤 Buy milk · until 11:00');
  });

  await check('snooze tomorrow at 10:00 local: tomorrow 09:00 on the tapper\'s clock, with the weekday', async () => {
    reset();
    const q = tap(DANA, `nr:st:${MILK}`, MILK_MSG);
    await handleNativeReminderCallback(q, NOW);
    // Thursday 15 Oct, 09:00 in New York (EDT) is 13:00 UTC.
    assert(show(stateRow(MILK).snoozedUntil) === show(new Date('2026-10-15T13:00:00Z')), `snoozedUntil ${show(stateRow(MILK).snoozedUntil)}`);
    assertEditedTo(tg(DANA), MILK_MSG, '💤 Buy milk · until Thu 09:00');
  });

  await check('snooze tomorrow at 02:00 local: this morning at 09:00 (R6), in Hebrew', async () => {
    reset();
    // 02:00 on Wednesday in Israel (IDT) is 23:00 UTC on Tuesday.
    const q = tap(RAZIEL, `nr:st:${CALL}`, CALL_MSG);
    await handleNativeReminderCallback(q, new Date('2026-10-13T23:00:00Z'));
    assert(show(stateRow(CALL).snoozedUntil) === show(new Date('2026-10-14T06:00:00Z')), `snoozedUntil ${show(stateRow(CALL).snoozedUntil)}`);
    // "יום ד׳" is Wednesday, short, in Hebrew.
    assertEditedTo(tg(RAZIEL), CALL_MSG, await copy('he', 'snoozedUntil', { title: 'Call the plumber', time: 'יום ד׳ 09:00' }));
  });

  await check('snooze after it was done: "already done", no snooze, ping shows it done', async () => {
    reset();
    stateRow(MILK).doneAt = new Date('2026-10-14T13:30:00Z');
    stateRow(MILK).doneByUserId = RAZIEL;
    const q = tap(DANA, `nr:s60:${MILK}`, MILK_MSG);
    await handleNativeReminderCallback(q, NOW);
    assert(toastOf(q) === 'Already done 👍', `toast ${toastOf(q)}`);
    assert(stateRow(MILK).snoozedUntil === null, `snoozed: ${show(stateRow(MILK).snoozedUntil)}`);
    assertEditedTo(tg(DANA), MILK_MSG, '✅ Buy milk');
    assert(activity.length === 0, `activity ${show(activity)}`);
  });

  // ---- HTML ----

  await check('titles and names are escaped in the edited ping and the creator\'s notice', async () => {
    reset();
    eventRow('ev-milk').title = 'Pay <Dana> & co';
    user(DANA).name = 'D<a>na';
    const q = tap(DANA, `nr:d:${MILK}`, MILK_MSG);
    await handleNativeReminderCallback(q, NOW);
    assertEditedTo(tg(DANA), MILK_MSG, '✅ Pay &lt;Dana&gt; &amp; co');
    const notice = await copy('he', 'doneBy', { name: 'D&lt;a&gt;na', title: 'Pay &lt;Dana&gt; &amp; co' });
    assert(sends()[0]?.text === notice, `notice ${show(sends()[0]?.text)}, want ${show(notice)}`);
  });

  // ---- Nothing escapes ----

  await check('"message is not modified" on the edit: still done, answered once, no error reported', async () => {
    reset();
    botFailures.edit = telegramError(400, 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same');
    const q = tap(DANA, `nr:d:${MILK}`, MILK_MSG);
    await handleNativeReminderCallback(q, NOW);
    assert(toastOf(q) === undefined, `toast ${toastOf(q)}`);
    assert(stateRow(MILK).doneByUserId === DANA, 'not marked done');
    assert(captured.length === 0, `captured ${show(captured)}`);
  });

  await check('any other failed edit: still done, the creator is still told, answered once', async () => {
    reset();
    botFailures.edit = telegramError(400, 'Bad Request: can\'t parse entities');
    const q = tap(DANA, `nr:d:${MILK}`, MILK_MSG);
    await handleNativeReminderCallback(q, NOW);
    assert(toastOf(q) === undefined, `toast ${toastOf(q)}`);
    assert(stateRow(MILK).doneByUserId === DANA && sends().length === 1, `state ${show(stateRow(MILK))}, sends ${sends().length}`);
  });

  await check('"query is too old" when answering: the handler still returns quietly', async () => {
    reset();
    botFailures.answer = telegramError(400, 'Bad Request: query is too old and response timeout expired or query ID is invalid');
    const q = tap(DANA, `nr:d:${MILK}`, MILK_MSG);
    await handleNativeReminderCallback(q, NOW);
    assert(answersTo(q).length === 1, `answered ${answersTo(q).length} times`);
    assert(stateRow(MILK).doneByUserId === DANA, 'not marked done');
  });

  await check('the database is down: answered once with no toast, the error reported, nothing thrown', async () => {
    reset();
    dbDown = true;
    const q = tap(DANA, `nr:d:${MILK}`, MILK_MSG);
    await handleNativeReminderCallback(q, NOW);
    assert(toastOf(q) === undefined, `toast ${toastOf(q)}`);
    assert(captured.length === 1 && captured[0].startsWith('native-reminder-callback:'), `captured ${show(captured)}`);
  });

  await check('the creator blocked the bot: the notice marks them unreachable, the tap still succeeds', async () => {
    reset();
    botFailures.send = telegramError(403, 'Forbidden: bot was blocked by the user');
    const q = tap(DANA, `nr:d:${MILK}`, MILK_MSG);
    await handleNativeReminderCallback(q, NOW);
    assert(toastOf(q) === undefined, `toast ${toastOf(q)}`);
    assert(user(RAZIEL).unreachableSince instanceof Date, `unreachableSince ${show(user(RAZIEL).unreachableSince)}`);
  });

  // ---- The webhook ----

  type Response = { code: number; body: unknown };
  const webhook = async (callbackQuery: TelegramBot.CallbackQuery) => {
    const responses: Response[] = [];
    const res = { status: (code: number) => ({ json: (body: unknown) => { responses.push({ code, body }); } }) };
    await handleTelegramWebhook({ body: { update_id: 1, callback_query: callbackQuery } }, res);
    return responses;
  };

  await check('webhook: an nr: tap reaches the handler and gets a 200', async () => {
    reset();
    const q = tap(DANA, `nr:d:${MILK}`, MILK_MSG);
    const responses = await webhook(q);
    assert(show(responses) === show([{ code: 200, body: { ok: true } }]), `responses ${show(responses)}`);
    assert(stateRow(MILK).doneByUserId === DANA, `state ${show(stateRow(MILK))}`);
    assert(answersTo(q).length === 1, `answered ${answersTo(q).length} times`);
  });

  await check('webhook: a button with an unknown prefix is answered, so its spinner stops', async () => {
    reset();
    const q = tap(DANA, 'retired_button:42', 700);
    const responses = await webhook(q);
    assert(show(responses) === show([{ code: 200, body: { ok: true } }]), `responses ${show(responses)}`);
    assert(answersTo(q).length === 1 && answersTo(q)[0].text === undefined, `answers ${show(answersTo(q))}`);
  });

  await check('no network was touched', () => {
    assert(networkAttempts.length === 0, `requests: ${networkAttempts.join(', ')}`);
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `TZ=UTC npx tsx scripts/smoke-native-reminder-buttons.ts; echo "exit=$?"`

Expected: it stops before any check runs, with `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/src/services/native-reminders/callbacks' imported from …/scripts/smoke-native-reminder-buttons.ts`, then `exit=1`.

- [ ] **Step 3: Create the button handler**

Create `src/services/native-reminders/callbacks.ts`:

```ts
// ✅ Done and 💤 Snooze on a native reminder ping (spec §5).
//
// The buttons never expire. A tap can come days later, after the reminder was
// moved, deleted or marked done, or after the pair unlinked, so every tap reads
// the state row and its series afresh and checks who is tapping. Every tap is
// answered exactly once, and nothing here throws: an error would fail the
// webhook with a 500, and Telegram would deliver the same tap again and again.

import type TelegramBot from 'node-telegram-bot-api';
import { formatInTimeZone } from 'date-fns-tz';
import { prisma } from '../../utils/prisma';
import { getBot } from '../telegram/bot';
import { getUserByTelegramId } from '../user-service';
import { getBotMessage } from '../../lib/bot-messages';
import { resolveUserTimezone } from '../../lib/timezone';
import { captureError } from '../../lib/error-capture';
import { describeDeliveryError, isUnreachableError } from '../../lib/delivery-errors';
import { markUserUnreachable } from '../../lib/user-reachability';
import { trackActivityAsync } from '../analytics-service';
import { escapeHtml } from '../../utils/html';
import { expandSeries } from '../native-calendar/recurrence';
import { invalidateDueGate } from './due-gate';
import { tomorrowMorning } from './due';
import { effectiveOwnerId, getActivePartnerSummary } from './ownership';
import { stripPingButtons } from './ping';
import type { UserConfig } from '../../types';

export const NATIVE_REMINDER_CALLBACK_PREFIX = 'nr:';

type NativeReminderOp = 'd' | 's15' | 's60' | 'st';
type SnoozeOp = Exclude<NativeReminderOp, 'd'>;

// nr:<op>:<state row id>. Telegram caps callback data at 64 bytes, and `nr:s15:` leaves 57.
const CALLBACK_DATA = new RegExp(`^${NATIVE_REMINDER_CALLBACK_PREFIX}(d|s15|s60|st):([A-Za-z0-9_-]{1,57})$`);

const SNOOZE_MS = { s15: 15 * 60 * 1000, s60: 60 * 60 * 1000 } as const;

export function parseNativeReminderCallback(data: string): { op: NativeReminderOp; stateId: string } | null {
  const match = CALLBACK_DATA.exec(data);
  return match ? { op: match[1] as NativeReminderOp, stateId: match[2] } : null;
}

/**
 * Handle a tap on a ping's button. `now` is for smoke scripts. The toast carries
 * the outcome, so the callback is answered once the outcome is known, in a finally:
 * exactly once, whatever happens in between.
 */
export async function handleNativeReminderCallback(
  query: TelegramBot.CallbackQuery,
  now: Date = new Date()
): Promise<void> {
  let toast: string | undefined;
  try {
    toast = await handleTap(query, now);
  } catch (error) {
    captureError(error, 'native-reminder-callback', { user_id: query.from.id, callback_data: query.data });
  } finally {
    await answer(query.id, toast);
  }
}

type Say = (key: string, params?: Record<string, string>) => Promise<string>;
type PingMessage = { chatId: number; messageId: number };

/** What a tap does. Returns the toast, or undefined when the edited ping says it all. */
async function handleTap(query: TelegramBot.CallbackQuery, now: Date): Promise<string | undefined> {
  const parsed = parseNativeReminderCallback(query.data ?? '');
  const chatId = query.message?.chat.id;
  const messageId = query.message?.message_id;
  if (!parsed || chatId === undefined || messageId === undefined) return undefined;
  const ping: PingMessage = { chatId, messageId };

  const tapper = await getUserByTelegramId(query.from.id);
  const language = tapper?.language || 'en';
  const say: Say = (key, params) => getBotMessage(language, `nativeReminders.${key}`, params);

  const state = await loadTap(parsed.stateId);
  const title = state && liveOccurrenceTitle(state);
  if (!state || !title) {
    await removeButtons(ping);
    return say('changed');
  }

  // The effective owner or the creator may tap (spec §2).
  const series = state.seriesEvent;
  if (!tapper) return say('notYours');
  const creatorPartner = await getActivePartnerSummary(series.creatorUserId, series.creator.pairingId);
  if (tapper.id !== effectiveOwnerId(series, creatorPartner) && tapper.id !== series.creatorUserId) {
    // It was theirs when it pinged them. Since then the pair unlinked, or they moved
    // to Google, and it is the creator's again.
    if (tapper.id === series.forUserId) {
      await removeButtons(ping);
      return say('changed');
    }
    return say('notYours');
  }

  return parsed.op === 'd'
    ? markDone(state, title, tapper, ping, say, now)
    : snooze(state, title, parsed.op, tapper, ping, say, now);
}

/** The state row behind a button, with what re-validation and the replies need. */
function loadTap(stateId: string) {
  return prisma.nativeReminderState.findUnique({
    where: { id: stateId },
    include: {
      seriesEvent: {
        include: {
          calendar: { select: { isDeleted: true } },
          creator: {
            select: {
              id: true, name: true, language: true, pairingId: true,
              telegramId: true, suspendedAt: true, unreachableSince: true,
            },
          },
          instances: true,
        },
      },
    },
  });
}

type TapState = NonNullable<Awaited<ReturnType<typeof loadTap>>>;

/**
 * The title of the occurrence a state row names, or null when its buttons no longer
 * apply: the series was deleted or is no longer a reminder, its calendar was deleted,
 * or the occurrence was cancelled, exdated or cut off by a "following" edit. A time
 * change deletes the row itself (the event store's re-arm). The occurrence is looked
 * up by its key alone, so one moved to another time is still found.
 */
function liveOccurrenceTitle(state: TapState): string | null {
  const series = state.seriesEvent;
  if (series.isDeleted || series.calendar.isDeleted || series.kind !== 'REMINDER') return null;
  const key = state.originalStartsAt.getTime();
  const override = series.instances.find(o => o.originalStartsAt.getTime() === key);
  if (override?.status === 'CANCELLED') return null;
  const slot = expandSeries(series, { from: state.originalStartsAt, to: new Date(key + 1) });
  if (!slot.some(occurrence => occurrence.instanceStartsAt.getTime() === key)) return null;
  return override?.title ?? series.title;
}

/** ✅ Done, once. When the owner is not the creator, the creator hears about it. */
async function markDone(
  state: TapState, title: string, tapper: UserConfig, ping: PingMessage, say: Say, now: Date
): Promise<string | undefined> {
  const { count } = await prisma.nativeReminderState.updateMany({
    where: { id: state.id, doneAt: null },
    data: { doneAt: now, doneByUserId: tapper.id },
  });
  await editPing(ping, await say('done', { title: escapeHtml(title) }));
  if (count === 0) return say('alreadyDone');

  trackActivityAsync(tapper.id, 'native_reminder_done', { series_event_id: state.seriesEventId });
  if (tapper.id !== state.seriesEvent.creatorUserId) await notifyCreator(state.seriesEvent.creator, tapper, title);
  return undefined;
}

/** 💤 Snooze for 15 minutes, an hour, or until tomorrow 09:00 on the tapper's clock (R6). */
async function snooze(
  state: TapState, title: string, op: SnoozeOp, tapper: UserConfig, ping: PingMessage, say: Say, now: Date
): Promise<string | undefined> {
  const timeZone = await resolveUserTimezone(tapper);
  const until = op === 'st' ? tomorrowMorning(now, timeZone) : new Date(now.getTime() + SNOOZE_MS[op]);
  // lastPingedAt stays as it is: it is now before snoozedUntil, so the pass pings again then.
  const { count } = await prisma.nativeReminderState.updateMany({
    where: { id: state.id, doneAt: null },
    data: { snoozedUntil: until },
  });
  if (count === 0) {
    await editPing(ping, await say('done', { title: escapeHtml(title) }));
    return say('alreadyDone');
  }

  invalidateDueGate();
  const time = snoozeLabel(until, op, tapper.language || 'en', timeZone);
  await editPing(ping, await say('snoozedUntil', { title: escapeHtml(title), time }));
  trackActivityAsync(tapper.id, 'native_reminder_snoozed', { snooze: op });
  return undefined;
}

/** "15:40", or "Thu 09:00" for tomorrow morning, on the tapper's clock. */
function snoozeLabel(until: Date, op: SnoozeOp, language: string, timeZone: string): string {
  const time = formatInTimeZone(until, timeZone, 'HH:mm');
  if (op !== 'st') return time;
  const locale = language === 'he' ? 'he-IL' : language === 'ru' ? 'ru-RU' : 'en-US';
  return `${until.toLocaleDateString(locale, { weekday: 'short', timeZone })} ${time}`;
}

/** The creator's quiet "✅ Done by Dana: Buy milk". Telegram only (R12). */
async function notifyCreator(
  creator: TapState['seriesEvent']['creator'], doer: UserConfig, title: string
): Promise<void> {
  if (!creator.telegramId || creator.suspendedAt || creator.unreachableSince) return;
  const text = await getBotMessage(creator.language || 'en', 'nativeReminders.doneBy', {
    name: escapeHtml(doer.name),
    title: escapeHtml(title),
  });
  try {
    await getBot().sendMessage(Number(creator.telegramId), text, { parse_mode: 'HTML', disable_notification: true });
  } catch (error) {
    if (isUnreachableError(error)) await markUserUnreachable(creator.id, describeDeliveryError(error));
    else captureError(error, 'native-reminder-done-notice', { user_id: creator.id }, 'warning');
  }
}

/** Show the outcome on the ping and drop its buttons. A failed edit must not cost the answer. */
async function editPing(ping: PingMessage, text: string): Promise<void> {
  try {
    await stripPingButtons(ping.chatId, ping.messageId, text);
  } catch (error) {
    captureError(error, 'native-reminder-callback-edit', { chat_id: ping.chatId }, 'warning');
  }
}

/** Drop a stale ping's buttons and leave its text as it was. */
async function removeButtons(ping: PingMessage): Promise<void> {
  try {
    await getBot().editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: ping.chatId, message_id: ping.messageId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('message is not modified') || message.includes('message to edit not found')) return;
    captureError(error, 'native-reminder-callback-edit', { chat_id: ping.chatId }, 'warning');
  }
}

/** Answer the tap. It fails harmlessly when the tap waited too long ("query is too old"). */
async function answer(queryId: string, text?: string): Promise<void> {
  try {
    await getBot().answerCallbackQuery(queryId, text ? { text } : undefined);
  } catch (error) {
    console.warn('[NativeReminders] Could not answer a button tap:', error instanceof Error ? error.message : error);
  }
}
```

Notes on choices the spec leaves open:
- **Answering.** Spec §5 says to answer the callback first. The handler instead answers once the outcome is known, in a `finally`, so the toast can say "Already done 👍" or "This reminder isn't yours." The `finally` keeps what "first" was for: every tap is answered exactly once, even when the handler fails. A failed answer ("query is too old") is logged and swallowed.
- **Stale buttons** come off with `editMessageReplyMarkup({ inline_keyboard: [] })`, not a text edit. The text is left exactly as it was, bold title included. Telegram hands the handler only the plain text of the old message, so re-sending it as HTML would garble a title containing `<` or `&`.
- **The occurrence check** expands the series over `[key, key + 1 ms)` with no overrides, so it asks whether the rule still makes that slot. A moved occurrence is still found by its key, and its override's title is used. A `following` edit or delete truncates the RRULE without touching state rows, so this check is what turns those old pings stale.
- **The ex-owner case.** A tapper who is the reminder's `forUserId`, but no longer its effective owner (unlinked, or moved to Google), gets `changed` and loses the buttons, as spec §5 lists "the pairing is still ACTIVE". Anyone else who is neither the owner nor the creator gets `notYours`, with no edit.
- **"Tomorrow"** uses the tapper's timezone. Only the recipient's chat has the buttons, so the tapper is the recipient (R6).

- [ ] **Step 4: Route `nr:` taps and answer unknown buttons**

In `src/services/webhook-handlers.ts`, find (lines 200-205, the end of the callback `if/else` chain):

```ts
            const { handleQuickFixCallback } = await import('./voice/callbacks');
            await handleQuickFixCallback(chatId, messageId, queryId, field, pendingId);
          }
        }
      }
    }
```

Replace with:

```ts
            const { handleQuickFixCallback } = await import('./voice/callbacks');
            await handleQuickFixCallback(chatId, messageId, queryId, field, pendingId);
          }
        }
      } else if (data.startsWith('nr:')) {
        // Native reminder ping: ✅ Done / 💤 Snooze. The handler answers the tap itself.
        const { handleNativeReminderCallback } = await import('./native-reminders/callbacks');
        await handleNativeReminderCallback(callbackQuery);
      } else {
        // A button nothing here handles (a retired prefix): answer it, or its spinner hangs.
        try {
          await getBot().answerCallbackQuery(queryId);
        } catch {
          // The spinner times out by itself
        }
      }
    }
```

`getBot` is already imported at the top of the file (line 17, from `./telegram`). The import of the handler is lazy, like the other branches, so the webhook doesn't load the reminder code until a ping's button is tapped.

- [ ] **Step 5: Run tests to verify they pass**

Run:
```bash
TZ=UTC npx tsx scripts/smoke-native-reminder-buttons.ts
TZ=Asia/Jerusalem npx tsx scripts/smoke-native-reminder-buttons.ts
TZ=UTC npx tsx scripts/smoke-native-reminders.ts
TZ=Asia/Jerusalem npx tsx scripts/smoke-native-reminders.ts
npx tsc --noEmit -p .
npm run -s lint
```

Expected:
- Each run prints two log lines from the deliberate failure cases first: `[NativeReminders] Could not answer a button tap: ETELEGRAM: 400 Bad Request: query is too old …` and `[Reachability] User 1 is unreachable: Forbidden: bot was blocked by the user`. Then 35 `OK` lines, then `35/35 passed (process TZ=UTC)` and `35/35 passed (process TZ=Asia/Jerusalem)`, and exit 0. `scripts/smoke-native-reminders.ts` (Task 8; webhook routing and `ping.ts` are shared) passes all its checks under both clocks.
- `tsc` prints nothing and exits 0.
- `lint` prints nothing and exits 0.

If the Done-by-the-owner or snooze checks fail on an edit's `html` flag, check that Task 8's `stripPingButtons` edits with `parse_mode: 'HTML'` (or `format: MessageFormat.HTML` through the adapter): the ping's text is HTML, so its replacement must be too.

- [ ] **Step 6: Commit**

```bash
git add src/services/native-reminders/callbacks.ts \
  src/services/webhook-handlers.ts \
  scripts/smoke-native-reminder-buttons.ts
git commit -F - <<'EOF'
feat(reminders): Done and Snooze buttons

A ping's ✅ Done and 💤 Snooze buttons never expire, so every tap re-reads
the state row and its series. A tap after a move, a delete, a cancelled or
cut-off occurrence, or by an ex-partner after unlinking answers "changed"
and loses its buttons; a stranger gets "not yours". Done and Snooze write
only while the occurrence is undone, so a double tap answers "already
done". When the partner marks it done, the creator gets a quiet notice on
Telegram. Snooze clears the due gate, so the pass pings again on time.
Each tap is answered exactly once and the handler never throws, so
Telegram never redelivers it. The webhook now also answers buttons with an
unknown prefix, so their spinner stops.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
EOF
```

---

### Task 10: Extraction learns reminders

**Files:**
- Create: `scripts/smoke-native-reminder-creation.ts`. Extraction checks only (prompt snapshot, parser, multi-intent, forward bulk card), with a fake model, fake Telegram and module-stub harness. Tasks 11 and 12 ship their own scripts (`smoke-native-reminder-create-flow.ts`, `smoke-native-reminder-typed.ts`) and do not extend this one. Task 11 does edit this script's stubs (see Interfaces).
- Create: `scripts/fixtures/extraction-prompts.json`. A snapshot of today's extraction prompt for five argument shapes. The smoke script writes it with `--write-prompt-fixture` **before any source change**.
- Create: `scripts/eval-native-reminders.ts`. A live, paid Gemini eval: 44 he/en/ru cases at the production model and thinking level. Don't run it in this task. Task 14 runs it once.
- Modify: `src/services/event-parser.ts:66-81` (`ParsedEvent`). Adds `kind?`, `forPerson?` and `anchor?`.
- Modify: `src/services/voice/gemini-voice.ts`:
  - line 13: import `formatInTimeZone`;
  - lines 22-31: new exported `ReminderPromptContext`, and `buildEventExtractionPrompt` gets a 6th parameter `reminders?`;
  - line 73: `return \`${modeInstructions}` becomes `const prompt = \`${modeInstructions}`;
  - lines 253-255 (end of the builder): append the reminder rules for voice and text, plus the new private `spellings` and `buildReminderRules`;
  - lines 261-288: `extractIntents` gets a 4th parameter `remindersOn = false`;
  - after line 319 (the end of `buildEventTimes`): the new exported `buildReminderTimes`, and the private `readAnchor` and `parseReminderCreate`;
  - lines 321-345: `parseGeminiEventResponse` gets a 4th parameter `remindersOn = false` and an early reminder branch;
  - lines 451-461, 498 and 555: `processVoiceWithGemini` gets a 7th parameter `reminders?` and passes it on.
- Modify: `src/services/forward-event/gemini-text.ts`:
  - line 10: the import;
  - lines 28-43: the signature (5th parameter `reminders?`, and `intentResults` in the result) and the prompt call;
  - lines 86-93: `extractIntents` replaces `parseGeminiEventResponse`.
- Modify: `src/services/forward-event/handler.ts`:
  - lines 119-125: read `intentResults`;
  - lines 140-143: two or more valid creates go to the bulk card, as voice and photos already do.
- Test: `scripts/smoke-native-reminder-creation.ts`. The regression check also runs `scripts/smoke-voice-dates.ts`, the only other script that loads `gemini-voice.ts`.

**Interfaces:**
- Consumes: nothing from earlier tasks. This task reads only existing types (`CalendarAssignment`, `UserConfig`, `VoiceIntentResult`, `ParsedEvent`) and existing functions (`buildEventTimes`, `startOfLocalDay`, `showBulkConfirmation`). Tasks 1-9 don't touch any file this task modifies, so the line numbers above are those of `main` at `40461c4`.
- Produces (exactly as in the contract, plus the additions marked **new**):
  - `src/services/event-parser.ts`: `ParsedEvent` gains `kind?: 'event' | 'reminder'; forPerson?: 'self' | 'partner'; anchor?: { description: string; offsetMinutes: number };`.
    - `kind` is set **only** on reminders. An event's `ParsedEvent` has exactly the same keys as before, so `kind` is `undefined`, never `'event'`.
    - A reminder always has `endTime.getTime() === startTime.getTime()` and a `forPerson` (`'self'` unless the model said `'partner'`).
    - An anchored reminder has `anchor` set and **both times are Invalid Dates** (`new Date(NaN)`, which `JSON.stringify` writes as `null`). Task 11 must resolve it before showing a card or storing a pending payload.
    - `anchor.offsetMinutes` is an integer, measured from the anchor event's start; negative means before.
  - `src/services/voice/gemini-voice.ts`:
    - `export interface ReminderPromptContext { userName: string; userEnglishName?: string | null; partnerName?: string | null; partnerEnglishName?: string | null }`.
    - `buildEventExtractionPrompt(language, calendars, timezone, mode = 'voice', recentEventsBlock?, reminders?: ReminderPromptContext): string`.
      - With `reminders` undefined, or with `mode === 'image'`, the output is byte-identical to today's (pinned by the fixture).
      - Otherwise the reminder rules are appended at the very end of the prompt.
      - With no partner (`partnerName` and `partnerEnglishName` both empty), the rules say every reminder is for the user (`forPerson` always `"self"`).
    - **new** `parseGeminiEventResponse(parsed, calendars, timezone, remindersOn = false)` and `extractIntents(parsed, calendars, timezone, remindersOn = false)`.
      - Off (every existing caller, including the photo path), a `kind: "reminder"` from the model is ignored and the create is parsed exactly as today.
      - On, `kind: "reminder"` creates go through the reminder branch.
      - Any other `kind` value is an event.
    - **new** `export function buildReminderTimes(startDate: string | undefined, startTime: string | undefined, allDay: boolean, timezone: string, now?: Date): { start: Date; allDay: boolean }`. A reminder's single instant:
      - a date with no time gives the start of that local day, with the DST-midnight case handled as in `buildEventTimes`;
      - no date gives today in `timezone`;
      - an unreadable date or time gives an Invalid Date.
      - Task 11's correction handler and quick-fix should use it to rebuild a reminder's time.
    - `processVoiceWithGemini(audioBuffer, language, calendars, timezone, recentEventsBlock?, priorAudioBuffer?, reminders?: ReminderPromptContext)`. A caller with no prior audio passes `undefined` in the 6th position.
  - `src/services/forward-event/gemini-text.ts`: `processTextWithGemini(text, language, calendars, timezone, reminders?: ReminderPromptContext): Promise<{ intentResult; intentResults: VoiceIntentResult[]; metrics }>`.
    - `intentResults` is always present, and `intentResult === intentResults[0]`.
    - The prompt is the text-mode prompt followed by `\n\nFORWARDED MESSAGE:\n<text>`, as today.
  - `handleForwardedMessage`: when two or more valid creates come back, it calls `showBulkConfirmation(chatId, validBulk, user, messageText, t, messagingService, timezone)` and returns. Single intents follow today's path unchanged.
  - `scripts/smoke-native-reminder-creation.ts`: extraction checks only. Its harness (the `stubs` map, `fakeGemini` / `modelReply` / `modelPrompts`, `sent`, `cardCalls`, `bulkCalls`, `editCalls`, `user`, the fixtures `NATIVE_CALENDARS`, `PAIR`, `SOLO` and `USER`, and `check` / `assert` / `at` / `pinClock`) serves this script's own checks, and `main()` runs `extractionChecks()` then `summarize()`. Tasks 11 and 12 do not add parts to it.
  - **Task 11 edits this script's stubs.** Once Task 11 lands, the forwarded handler calls `getReminderSupport` and `sendAnchorQuestions`, so the forward checks here need stubs for them (Task 11 adds those stub entries and keeps this script's checks passing).

- [ ] **Step 1: Write the failing test**

Create `scripts/smoke-native-reminder-creation.ts` with exactly this content:

````ts
// Smoke test for creating native reminders.
// Part 1, extraction: the reminder rules in the extraction prompt, the reminder fields and
// times the parser reads, several reminders in one message, and a forwarded message with
// several events reaching the bulk card. The model, Telegram, the user lookup and the
// calendars are faked. No network, no database.
//
// Users without reminders must get exactly the prompt they got before reminders existed.
// scripts/fixtures/extraction-prompts.json is that prompt, taken from the builder before
// the reminder rules were added, with:
//   npx tsx scripts/smoke-native-reminder-creation.ts --write-prompt-fixture
// It refuses to overwrite the file. Take a new snapshot only when the prompt for users
// without reminders is meant to change: delete the file, then run it again.
//
// Run under both clocks; the output must not depend on the server's timezone:
//   TZ=UTC npx tsx scripts/smoke-native-reminder-creation.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-native-reminder-creation.ts

import Module from 'node:module';
import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { formatInTimeZone } from 'date-fns-tz';
import type { VoiceIntentResult } from '../src/services/event-parser';
import type { ReminderPromptContext } from '../src/services/voice/gemini-voice';
import type { CalendarAssignment, UserConfig } from '../src/types';

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
}

function assert(cond: boolean, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

// ---- Environment: fakes only, set before anything under test loads ----

process.env.NEXT_PUBLIC_APP_URL = 'https://famcal.test';
process.env.GEMINI_API_KEY = 'test-key';
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.UPSTASH_REDIS_REST_URL = 'https://redis.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
process.env.DATABASE_URL = 'postgresql://test@db.invalid/test';

/** Any request that slips past the fakes is refused and counted. */
const networkAttempts: string[] = [];
globalThis.fetch = (async (input: unknown) => {
  networkAttempts.push(String(input));
  throw new Error('network is blocked in this smoke test');
}) as typeof fetch;

// ---- Fixtures ----

const IL = 'Asia/Jerusalem';
const NY = 'America/New_York';
const color = '#4285f4';

/** A built-in calendar pair as the prompt lists it for the user: theirs, then the partner's. */
const NATIVE_CALENDARS: CalendarAssignment[] = [
  { calendarId: 'native:cmain00000000000000000001', name: 'רזיאל', labels: ['primary', 'yours'], color },
  { calendarId: 'native:cdana00000000000000000002', name: 'דנה', labels: ['spouse'], color, personName: 'דנה', personEnglishName: 'Dana', personGender: 'female' },
];
const GOOGLE_CALENDARS: CalendarAssignment[] = [
  { calendarId: 'raziel@example.com', name: 'Raziel', labels: ['primary', 'yours'], color },
  { calendarId: 'kids123@group.calendar.google.com', name: 'Kids', labels: ['kids'], color, rules: ['Noa has ballet on Tuesdays'] },
];
/** The voice prompt's recent-events context, as formatRecentEventsBlock writes it. */
const RECENT_BLOCK = [
  'RECENTLY TOUCHED EVENTS (most recent last) — the user may refer to these via "the lunch", "that meeting", "it", "yesterday\'s appointment", etc.:',
  '1. "רופא שיניים" on Oct 15 at 10:00 (calendar: native:cmain00000000000000000001, action: create)',
].join('\n');

/** The user and the partner, as the reminder rules name them. */
const PAIR: ReminderPromptContext = { userName: 'רזיאל', userEnglishName: 'Raziel', partnerName: 'דנה', partnerEnglishName: 'Dana' };
/** A user with no partner. */
const SOLO: ReminderPromptContext = { userName: 'Raziel', userEnglishName: null, partnerName: null, partnerEnglishName: null };

const USER = {
  id: 7, telegramId: 5551, name: 'רזיאל', englishName: 'Raziel', language: 'he', isAdmin: false, voiceInputEnabled: true,
  calendarSource: 'NATIVE', googleRefreshToken: '', pairingId: 'pair-1', suspendedAt: null,
} as unknown as UserConfig;

const FIXTURE = path.resolve(__dirname, 'fixtures/extraction-prompts.json');

/** The prompt with its clock line pinned, so a snapshot taken on another day still compares. */
const pinClock = (prompt: string) => prompt.replace(/^CURRENT DATE\/TIME: .*$/m, 'CURRENT DATE/TIME: <pinned>');

type PromptArgs = [language: string, calendars: CalendarAssignment[], timezone: string, mode?: 'voice' | 'text' | 'image', recentEventsBlock?: string];
/** Every argument shape the app builds the extraction prompt with, by name. */
const PROMPT_CASES: Record<string, PromptArgs> = {
  'voice-he-native-recent': ['he', NATIVE_CALENDARS, IL, 'voice', RECENT_BLOCK],
  'voice-ru-no-calendars-default-mode': ['ru', [], IL],
  'text-he-native': ['he', NATIVE_CALENDARS, IL, 'text'],
  'text-en-google': ['en', GOOGLE_CALENDARS, NY, 'text'],
  'image-he-native': ['he', NATIVE_CALENDARS, IL, 'image'],
};

/** Where two strings first differ, with a little of each, for a readable failure. */
function firstDifference(got: string, want: string | undefined): string {
  if (want === undefined) return 'missing from the snapshot';
  let i = 0;
  while (i < got.length && got[i] === want[i]) i++;
  return `character ${i}: got ${JSON.stringify(got.slice(i, i + 40))}, snapshot ${JSON.stringify(want.slice(i, i + 40))}`;
}

/** An instant on the user's clock, or 'invalid'. */
const at = (date: Date | undefined, tz: string) =>
  (date && !isNaN(date.getTime()) ? formatInTimeZone(date, tz, 'yyyy-MM-dd HH:mm') : 'invalid');

// ---- Fakes ----

/** The extraction model: answers `modelReply` as Gemini does (in a code block) and records every prompt. */
let modelReply: object = {};
const modelPrompts: string[] = [];
const fakeGemini = {
  models: {
    generateContent: async (request: { contents: Array<{ parts: Array<{ text?: string }> }> }) => {
      modelPrompts.push(request.contents[0].parts[0].text ?? '');
      return { text: '```json\n' + JSON.stringify(modelReply) + '\n```', usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 80 } };
    },
  },
};

/** Every message sent to the user, through the messaging service or the bot. */
const sent: Array<{ chatId: number | string; text: string }> = [];
const telegram = {
  sendMessage: async (chatId: number | string, text: string) => {
    sent.push({ chatId, text });
    return 1;
  },
  sendTypingIndicator: async () => {},
};
const fakeBot = {
  sendMessage: async (chatId: number | string, text: string) => {
    sent.push({ chatId, text });
    return { message_id: 1 };
  },
};

let user: UserConfig = USER;
const cardCalls: unknown[][] = [];
const bulkCalls: unknown[][] = [];
const editCalls: unknown[][] = [];

const SRC = path.resolve(__dirname, '../src');

/** Modules replaced by fakes, by file path; a function fakes part of the real module. */
const stubs: Record<string, object | ((real: Record<string, unknown>) => object)> = {
  [`${SRC}/services/ai-provider.ts`]: { getGemini: () => fakeGemini, extractionConfig: () => ({}) },
  [`${SRC}/services/voice/audio-level.ts`]: { isSilent: () => false },
  [`${SRC}/services/voice/speech-presence.ts`]: { NO_SPEECH: 'no_speech', detectSpeech: async () => true },
  [`${SRC}/services/telegram/index.ts`]: { getBot: () => fakeBot, getMessagingService: () => telegram },
  [`${SRC}/services/telegram/command-pipeline.ts`]: { startTypingInterval: () => () => {} },
  [`${SRC}/services/user-service.ts`]: { getUserByTelegramId: async () => user },
  [`${SRC}/services/subscription-service.ts`]: { checkFeatureAccess: async () => ({ allowed: true }) },
  [`${SRC}/services/analytics-service.ts`]: { trackActivityAsync: () => {}, addBreadcrumb: () => {}, setUserContext: () => {} },
  [`${SRC}/lib/error-capture.ts`]: { captureError: () => {}, captureWarning: () => {}, captureInfo: () => {} },
  [`${SRC}/lib/timezone.ts`]: { resolveUserTimezone: async () => IL },
  [`${SRC}/services/calendar-provider/index.ts`]: {
    hasUsableCalendar: async () => true,
    getCalendarAssignmentsForUser: async () => NATIVE_CALENDARS,
  },
  [`${SRC}/services/voice/confirmations.ts`]: {
    showEventConfirmation: async (...args: unknown[]) => { cardCalls.push(args); },
  },
  [`${SRC}/services/voice/bulk-confirmations.ts`]: {
    showBulkConfirmation: async (...args: unknown[]) => {
      bulkCalls.push(args);
      return 'bulk:1:abc123';
    },
  },
  [`${SRC}/services/voice/index.ts`]: {
    handleEditIntent: async (...args: unknown[]) => { editCalls.push(args); },
    handleDeleteIntent: async (...args: unknown[]) => { editCalls.push(args); },
  },
};

const ModuleInternals = Module as unknown as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  _resolveFilename: (request: string, parent: unknown, isMain: boolean) => string;
};

/** A partial fake is built once from the real module, then served to require() and import() alike. */
const built = new Map<string, object>();
const loadingReal = new Set<string>();
function fakeFor(file: string, loadReal: () => unknown): object {
  const stub = stubs[file];
  if (typeof stub !== 'function') return stub;
  if (!built.has(file)) {
    loadingReal.add(file);
    try {
      built.set(file, stub(loadReal() as Record<string, unknown>));
    } finally {
      loadingReal.delete(file);
    }
  }
  return built.get(file)!;
}

// Static imports compile to require() and pass through Module._load.
const realLoad = ModuleInternals._load;
ModuleInternals._load = function (request, parent, isMain) {
  let resolved = request;
  try {
    resolved = ModuleInternals._resolveFilename(request, parent, isMain);
  } catch {}
  if (!(resolved in stubs) || loadingReal.has(resolved)) return realLoad.call(this, request, parent, isMain);
  return fakeFor(resolved, () => realLoad.call(this, request, parent, isMain));
};

// The handlers load the calendar provider and the bulk card with import(), which goes
// through the ES module loader instead; it gets the same fake, served as an ES module.
(globalThis as { creationSmokeFake?: (file: string) => object }).creationSmokeFake = file =>
  fakeFor(file, () => realLoad.call(Module, file, null, false));
Module.registerHooks({
  load(url, context, nextLoad) {
    const file = url.startsWith('file:') ? fileURLToPath(url.split('?')[0]) : '';
    if (!(file in stubs) || loadingReal.has(file)) return nextLoad(url, context);
    const fake = (globalThis as unknown as { creationSmokeFake: (file: string) => object }).creationSmokeFake(file);
    const names = Object.keys(fake).map(name => `export const ${name} = fake.${name};`).join('\n');
    return { format: 'module', shortCircuit: true, source: `const fake = globalThis.creationSmokeFake(${JSON.stringify(file)});\n${names}\n` };
  },
});

// ---- Snapshot ----

async function writePromptFixture() {
  if (existsSync(FIXTURE)) {
    console.error(`${path.relative(process.cwd(), FIXTURE)} exists. Delete it first to take a new snapshot.`);
    process.exit(1);
  }
  const { buildEventExtractionPrompt } = await import('../src/services/voice/gemini-voice');
  const snapshot = Object.fromEntries(
    Object.entries(PROMPT_CASES).map(([name, args]) => [name, pinClock(buildEventExtractionPrompt(...args))])
  );
  mkdirSync(path.dirname(FIXTURE), { recursive: true });
  writeFileSync(FIXTURE, JSON.stringify(snapshot, null, 2) + '\n');
  console.log(`Wrote ${Object.keys(snapshot).length} prompts to ${path.relative(process.cwd(), FIXTURE)}`);
}

// ---- Part 1: extraction ----

async function extractionChecks() {
  const { buildEventExtractionPrompt, extractIntents, parseGeminiEventResponse, processVoiceWithGemini } =
    await import('../src/services/voice/gemini-voice');
  const { processTextWithGemini } = await import('../src/services/forward-event/gemini-text');
  const { handleForwardedMessage } = await import('../src/services/forward-event/handler');
  const { getBotMessages } = await import('../src/lib/bot-messages');
  assert(existsSync(FIXTURE), `${FIXTURE} is missing: take the snapshot first (see the header)`);
  const snapshot: Record<string, string> = JSON.parse(readFileSync(FIXTURE, 'utf8'));

  /** Only the reminder rules: what the prompt with reminders adds to the one without. */
  const rulesFor = (mode: 'voice' | 'text', reminders: ReminderPromptContext = PAIR) => {
    const base = pinClock(buildEventExtractionPrompt('he', NATIVE_CALENDARS, IL, mode));
    const prompt = pinClock(buildEventExtractionPrompt('he', NATIVE_CALENDARS, IL, mode, undefined, reminders));
    assert(prompt.startsWith(base) && prompt.length > base.length, `${mode}: the rules are not appended to the unchanged prompt`);
    return prompt.slice(base.length);
  };

  // (a) The prompt.

  await check('without reminders the prompt is byte-identical to the snapshot, in every mode', () => {
    assert(isDeepStrictEqual(Object.keys(snapshot), Object.keys(PROMPT_CASES)), `snapshot cases: ${Object.keys(snapshot).join(', ')}`);
    for (const [name, [language, calendars, timezone, mode, recent]] of Object.entries(PROMPT_CASES)) {
      const prompt = pinClock(buildEventExtractionPrompt(language, calendars, timezone, mode, recent, undefined));
      assert(prompt === snapshot[name], `${name} differs at ${firstDifference(prompt, snapshot[name])}`);
    }
  });

  await check('voice and text prompts gain the reminder rules after the unchanged prompt', () => {
    for (const mode of ['voice', 'text'] as const) {
      const rules = rulesFor(mode);
      for (const needle of ['REMINDERS', '"kind"', '"forPerson"', '"anchor"', '"offsetMinutes"']) {
        assert(rules.includes(needle), `${mode}: no ${needle}`);
      }
    }
  });

  await check('a photo never gets the reminder rules', () => {
    const base = pinClock(buildEventExtractionPrompt('he', NATIVE_CALENDARS, IL, 'image'));
    const prompt = pinClock(buildEventExtractionPrompt('he', NATIVE_CALENDARS, IL, 'image', undefined, PAIR));
    assert(prompt === base, `the image prompt changed at ${firstDifference(prompt, base)}`);
  });

  await check('the rules name the user and the partner, in both spellings', () => {
    const rules = rulesFor('voice');
    for (const name of ['רזיאל', 'Raziel', 'דנה', 'Dana']) assert(rules.includes(`"${name}"`), `no "${name}"`);
    assert(rules.includes('"forPerson": "partner"'), 'no partner example');
  });

  await check('without a partner every reminder is for the user', () => {
    const rules = rulesFor('text', SOLO);
    assert(rules.includes('"Raziel"'), 'no user name');
    assert(rules.includes('no linked partner'), 'no "no linked partner" rule');
    assert(!rules.includes('"forPerson": "partner"'), 'a partner example is still there');
  });

  await check('the rules carry the Hebrew, English and Russian phrasings', () => {
    const rules = rulesFor('text');
    const phrases = [
      'remind me', "don't forget", 'תזכיר לי', 'אל תשכח', 'напомни', 'не забудь',
      'I did it', 'סיימתי', 'сделал', 'Stop reminding me', 'תפסיק להזכיר', 'хватит напоминать', "Skip today's",
    ];
    for (const phrase of phrases) assert(rules.includes(phrase), `no "${phrase}"`);
  });

  await check('voice examples carry a transcription, text examples do not', () => {
    assert(rulesFor('voice').includes('"transcription": "Remind me to call the plumber'), 'voice');
    assert(!rulesFor('text').includes('"transcription"'), 'text');
  });

  // (b) The parser.

  const parse = (event: Record<string, unknown>, tz = IL, remindersOn = true) =>
    parseGeminiEventResponse(
      { intent: 'create', confidence: 'high', event: { title: 'Call the plumber', calendarId: 'primary', ...event } },
      NATIVE_CALENDARS, tz, remindersOn
    );

  await check('a timed reminder needs no end time: it ends where it starts', () => {
    for (const tz of [IL, NY]) {
      const { event, error } = parse({ kind: 'reminder', forPerson: 'self', startDate: '2026-10-15', startTime: '10:00', endDate: null, endTime: null, allDay: false }, tz);
      assert(!!event && !error, `${tz}: ${error}`);
      assert(at(event.startTime, tz) === '2026-10-15 10:00', `${tz}: start ${at(event.startTime, tz)}`);
      assert(event.endTime.getTime() === event.startTime.getTime(), `${tz}: end ${at(event.endTime, tz)}`);
      assert(event.kind === 'reminder' && event.forPerson === 'self' && !event.allDay && event.anchor === undefined, `${tz}: ${JSON.stringify(event)}`);
    }
  });

  await check('a date-only reminder starts at local midnight and has no length (no 23:59 end)', () => {
    for (const tz of [IL, NY]) {
      for (const fields of [{ allDay: true }, { allDay: true, startTime: '10:00' }, { allDay: false }]) {
        const { event } = parse({ kind: 'reminder', startDate: '2026-10-16', ...fields }, tz);
        assert(!!event && event.allDay, `${tz} ${JSON.stringify(fields)}: not all day`);
        assert(at(event.startTime, tz) === '2026-10-16 00:00' && event.endTime.getTime() === event.startTime.getTime(),
          `${tz} ${JSON.stringify(fields)}: ${at(event.startTime, tz)}..${at(event.endTime, tz)}`);
      }
    }
  });

  await check('a date-only reminder where daylight saving starts at midnight starts at 01:00', () => {
    const tz = 'America/Santiago';
    const { event } = parse({ kind: 'reminder', startDate: '2026-09-06', allDay: true }, tz);
    assert(!!event && at(event.startTime, tz) === '2026-09-06 01:00' && event.endTime.getTime() === event.startTime.getTime(),
      `${at(event?.startTime, tz)}..${at(event?.endTime, tz)}`);
  });

  await check('a reminder with no date is for today, on the user\'s clock', () => {
    for (const tz of [IL, NY]) {
      const today = formatInTimeZone(new Date(), tz, 'yyyy-MM-dd');
      const dateOnly = parse({ kind: 'reminder', allDay: true }, tz).event;
      assert(!!dateOnly && dateOnly.allDay && at(dateOnly.startTime, tz) === `${today} 00:00`, `${tz} date-only: ${at(dateOnly?.startTime, tz)}`);
      const timed = parse({ kind: 'reminder', startTime: '23:30' }, tz).event;
      assert(!!timed && !timed.allDay && at(timed.startTime, tz) === `${today} 23:30`, `${tz} timed: ${at(timed?.startTime, tz)}`);
    }
  });

  await check('a reminder for the partner says so; anything else is for the user', () => {
    const partner = parse({ kind: 'reminder', forPerson: 'partner', startDate: '2026-10-15', allDay: true }).event;
    assert(partner?.forPerson === 'partner', `partner → ${partner?.forPerson}`);
    for (const forPerson of [undefined, null, 'self', 'Dana', 'both']) {
      const got = parse({ kind: 'reminder', forPerson, startDate: '2026-10-15', allDay: true }).event?.forPerson;
      assert(got === 'self', `${forPerson} → ${got}`);
    }
  });

  await check('an anchored reminder keeps its anchor, and its times are left for the server', () => {
    const { event, error } = parse({ kind: 'reminder', title: 'Bring the forms', anchor: { description: 'dentist', offsetMinutes: -60 }, startDate: null, startTime: null });
    assert(!!event && !error, `error ${error}`);
    assert(isDeepStrictEqual(event.anchor, { description: 'dentist', offsetMinutes: -60 }), JSON.stringify(event.anchor));
    assert(isNaN(event.startTime.getTime()) && isNaN(event.endTime.getTime()), `${event.startTime}..${event.endTime}`);
    assert(event.kind === 'reminder' && event.title === 'Bring the forms', JSON.stringify(event));
    // A date next to an anchor is ignored: the anchor decides.
    const dated = parse({ kind: 'reminder', anchor: { description: ' רופא שיניים ', offsetMinutes: '-1440' }, startDate: '2026-10-15' }).event;
    assert(isDeepStrictEqual(dated?.anchor, { description: 'רופא שיניים', offsetMinutes: -1440 }), JSON.stringify(dated?.anchor));
    assert(!!dated && isNaN(dated.startTime.getTime()), `dated: ${at(dated?.startTime, IL)}`);
  });

  await check('a broken anchor with no date is reported, not guessed as today', () => {
    for (const anchor of [{ description: '' }, { description: 'dentist', offsetMinutes: 'an hour' }, 'dentist']) {
      const { event, error } = parse({ kind: 'reminder', anchor });
      assert(!event && error === 'Missing date/time fields', `${JSON.stringify(anchor)}: ${error}`);
    }
  });

  await check('an unknown kind is an event: it still needs its end time and gets no reminder fields', () => {
    const missingEnd = parse({ kind: 'task', startDate: '2026-10-15', startTime: '10:00' });
    assert(!missingEnd.event && missingEnd.error === 'Missing date/time fields', `got ${missingEnd.error}`);
    const { event } = parse({
      kind: 'task', forPerson: 'partner', anchor: { description: 'dentist', offsetMinutes: -60 },
      startDate: '2026-10-15', startTime: '10:00', endDate: '2026-10-15', endTime: '11:00',
    });
    assert(!!event && event.kind === undefined && event.forPerson === undefined && event.anchor === undefined, JSON.stringify(event));
    assert(at(event.endTime, IL) === '2026-10-15 11:00', `end ${at(event.endTime, IL)}`);
  });

  await check('an event parses exactly as before, with reminders on or off', () => {
    const json = {
      intent: 'create', confidence: 'high',
      event: { title: 'Dentist', startDate: '2026-10-15', startTime: '10:00', endDate: '2026-10-15', endTime: '11:00', allDay: false, calendarId: 'native:cmain00000000000000000001', calendarName: 'רזיאל', recurrence: null },
    };
    const before = parseGeminiEventResponse(json, NATIVE_CALENDARS, IL);
    const keys = ['title', 'startTime', 'endTime', 'location', 'description', 'allDay', 'calendarId', 'calendarName', 'confidence', 'recurrence'];
    assert(isDeepStrictEqual(Object.keys(before.event ?? {}), keys), `event fields: ${Object.keys(before.event ?? {}).join(', ')}`);
    const tagged = { ...json, event: { ...json.event, kind: 'event', forPerson: 'self', anchor: null } };
    for (const remindersOn of [true, false]) {
      const after = parseGeminiEventResponse(tagged, NATIVE_CALENDARS, IL, remindersOn);
      assert(isDeepStrictEqual(after, before), `reminders ${remindersOn ? 'on' : 'off'}: ${JSON.stringify(after)}`);
    }
  });

  await check('with reminders off, a reminder from the model is read as an event, as before', () => {
    const timed = parse({ kind: 'reminder', forPerson: 'partner', startDate: '2026-10-15', startTime: '10:00', allDay: false }, IL, false);
    assert(!timed.event && timed.error === 'Missing date/time fields', `timed: ${timed.error}`);
    const dateOnly = parse({ kind: 'reminder', forPerson: 'partner', startDate: '2026-10-15', allDay: true }, IL, false).event;
    assert(!!dateOnly && dateOnly.kind === undefined && dateOnly.forPerson === undefined && at(dateOnly.endTime, IL) === '2026-10-15 23:59',
      `date-only: ${JSON.stringify(dateOnly)}`);
  });

  await check('an unreadable reminder time is reported, not thrown', () => {
    const { event, error } = parse({ kind: 'reminder', startDate: '2026-10-15', startTime: 'ten' });
    assert(!event && error === 'Invalid date/time parsed', `got ${error}`);
  });

  await check('a repeating reminder keeps its recurrence and its first time', () => {
    const { event, error } = parse({ kind: 'reminder', title: 'Take out the trash', startDate: '2026-10-18', startTime: '08:00', recurrence: { frequency: 'weekly', daysOfWeek: ['SU'] } });
    assert(!!event, `error ${error}`);
    assert(event.recurrence?.frequency === 'weekly' && event.recurrence.daysOfWeek?.[0] === 'SU', JSON.stringify(event.recurrence));
    assert(at(event.startTime, IL) === '2026-10-18 08:00' && event.endTime.getTime() === event.startTime.getTime(), `${at(event.startTime, IL)}..${at(event.endTime, IL)}`);
  });

  // (c) Several reminders in one message.

  const multi = {
    intents: [
      { intent: 'create', confidence: 'high', event: { kind: 'reminder', forPerson: 'self', title: 'Call mom', startDate: '2026-10-15', startTime: '17:00', calendarId: 'primary' } },
      { intent: 'create', confidence: 'high', event: { kind: 'reminder', forPerson: 'partner', title: 'Buy milk', startDate: '2026-10-16', allDay: true, calendarId: 'primary' } },
      { intent: 'create', confidence: 'high', event: { kind: 'event', title: 'Dentist', startDate: '2026-10-17', startTime: '10:00', endDate: '2026-10-17', endTime: '11:00', allDay: false, calendarId: 'primary' } },
    ],
  };
  const describe = (r: VoiceIntentResult) =>
    (r.event ? `${r.event.kind ?? 'event'}/${r.event.forPerson ?? '-'} ${at(r.event.startTime, IL)}..${at(r.event.endTime, IL)}` : `error ${r.error}`);

  await check('several reminders in one message each come back with their own fields', () => {
    const got = extractIntents(multi, NATIVE_CALENDARS, IL, true).map(describe);
    const want = [
      'reminder/self 2026-10-15 17:00..2026-10-15 17:00',
      'reminder/partner 2026-10-16 00:00..2026-10-16 00:00',
      'event/- 2026-10-17 10:00..2026-10-17 11:00',
    ];
    assert(isDeepStrictEqual(got, want), got.join(' | '));
  });

  await check('with reminders off, the same message parses as it does today', () => {
    const got = extractIntents(multi, NATIVE_CALENDARS, IL).map(describe);
    const want = [
      'error Missing date/time fields',
      'event/- 2026-10-16 00:00..2026-10-16 23:59',
      'event/- 2026-10-17 10:00..2026-10-17 11:00',
    ];
    assert(isDeepStrictEqual(got, want), got.join(' | '));
  });

  // (d) The model calls.

  const dinner = { title: 'Dinner', startDate: '2026-10-16', startTime: '19:00', endDate: '2026-10-16', endTime: '21:00', allDay: false, calendarId: 'primary' };
  const dentist = { title: 'Dentist', startDate: '2026-10-17', startTime: '10:00', endDate: '2026-10-17', endTime: '11:00', allDay: false, calendarId: 'primary' };

  await check('forwarded text without reminders sends the snapshot prompt and the message, as before', async () => {
    modelPrompts.length = 0;
    modelReply = { intent: 'create', confidence: 'high', event: dinner };
    const { intentResult, intentResults } = await processTextWithGemini('Dinner Friday at 7?', 'he', NATIVE_CALENDARS, IL);
    const want = `${snapshot['text-he-native']}\n\nFORWARDED MESSAGE:\nDinner Friday at 7?`;
    assert(pinClock(modelPrompts[0]) === want, `prompt differs at ${firstDifference(pinClock(modelPrompts[0]), want)}`);
    assert(intentResults.length === 1 && intentResults[0] === intentResult && intentResult.event?.title === 'Dinner', JSON.stringify(intentResults));
  });

  await check('forwarded text with reminders sends the rules and returns every intent', async () => {
    modelPrompts.length = 0;
    modelReply = multi;
    const { intentResult, intentResults } = await processTextWithGemini('Remind me to call mom at 5 and Dana to buy milk tomorrow', 'he', NATIVE_CALENDARS, IL, PAIR);
    assert(modelPrompts[0].includes('"forPerson"') && modelPrompts[0].includes('"דנה"'), 'no reminder rules in the prompt');
    assert(intentResults.length === 3 && intentResult === intentResults[0], `${intentResults.length} intents`);
    assert(intentResults.map(describe)[1] === 'reminder/partner 2026-10-16 00:00..2026-10-16 00:00', intentResults.map(describe).join(' | '));
  });

  const spokenReminder = {
    transcription: 'תזכיר לי מחר בערב להתקשר לאמא', intent: 'create', confidence: 'high',
    event: { kind: 'reminder', forPerson: 'self', title: 'להתקשר לאמא', startDate: '2026-10-15', startTime: '20:00', calendarId: 'primary' },
  };

  await check('voice with reminders sends the rules, then the retry note, and reads the reminder', async () => {
    modelPrompts.length = 0;
    modelReply = spokenReminder;
    const audio = Buffer.from('OggS');
    const { intentResult, transcription } = await processVoiceWithGemini(audio, 'he', NATIVE_CALENDARS, IL, RECENT_BLOCK, audio, PAIR);
    const prompt = pinClock(modelPrompts[0]);
    const withRules = pinClock(buildEventExtractionPrompt('he', NATIVE_CALENDARS, IL, 'voice', RECENT_BLOCK, PAIR));
    assert(prompt.startsWith(withRules), `prompt differs at ${firstDifference(prompt, withRules)}`);
    assert(prompt.slice(withRules.length).startsWith('\n\nNOTE: The next attached audio is a PRIOR attempt'), 'no retry note after the rules');
    assert(transcription === spokenReminder.transcription, `transcription ${transcription}`);
    assert(describe(intentResult) === 'reminder/self 2026-10-15 20:00..2026-10-15 20:00', describe(intentResult));
  });

  await check('voice without reminders sends the snapshot prompt and ignores a stray reminder kind', async () => {
    modelPrompts.length = 0;
    modelReply = spokenReminder;
    const { intentResult } = await processVoiceWithGemini(Buffer.from('OggS'), 'he', NATIVE_CALENDARS, IL, RECENT_BLOCK);
    const want = snapshot['voice-he-native-recent'];
    assert(pinClock(modelPrompts[0]) === want, `prompt differs at ${firstDifference(pinClock(modelPrompts[0]), want)}`);
    assert(!intentResult.event && intentResult.error === 'Missing date/time fields', `got ${describe(intentResult)}`);
  });

  // (e) Forwarded messages: several events reach the bulk card.

  const FORWARDED = 'Dinner Friday at 7, and the dentist on Saturday at 10';
  const forward = async (reply: object) => {
    modelReply = reply;
    sent.length = 0;
    cardCalls.length = 0;
    bulkCalls.length = 0;
    editCalls.length = 0;
    user = USER;
    await handleForwardedMessage(5551, 5551, FORWARDED, { id: 5551, first_name: 'Raziel' });
  };

  await check('a forwarded message with two events gets one bulk card that quotes it', async () => {
    await forward({
      intents: [
        { intent: 'create', confidence: 'high', event: dinner },
        { intent: 'create', confidence: 'high', event: dentist },
      ],
    });
    assert(bulkCalls.length === 1 && cardCalls.length === 0 && sent.length === 0, `${bulkCalls.length} bulk, ${cardCalls.length} single, ${sent.length} sent`);
    const [chatId, intents, bulkUser, transcription, , , timezone] = bulkCalls[0] as [number, VoiceIntentResult[], UserConfig, string, unknown, unknown, string];
    assert(chatId === 5551 && bulkUser === USER && transcription === FORWARDED && timezone === IL, `args ${chatId} ${transcription} ${timezone}`);
    assert(isDeepStrictEqual(intents.map(i => i.event?.title), ['Dinner', 'Dentist']), JSON.stringify(intents));
  });

  await check('a forwarded message with one event still gets the single card, called as before', async () => {
    await forward({ intent: 'create', confidence: 'high', event: dinner });
    assert(cardCalls.length === 1 && bulkCalls.length === 0, `${cardCalls.length} single, ${bulkCalls.length} bulk`);
    const args = cardCalls[0];
    const event = args[2] as VoiceIntentResult['event'];
    assert(args.length === 6 && args[0] === 5551 && args[1] === undefined && args[3] === FORWARDED && args[4] === USER && args[5] === undefined,
      `args ${JSON.stringify(args.map((a, i) => (i === 4 ? 'user' : a)))}`);
    assert(event?.title === 'Dinner' && at(event.endTime, IL) === '2026-10-16 21:00', JSON.stringify(event));
  });

  await check('a forwarded edit still goes to the edit flow', async () => {
    await forward({ intent: 'edit', confidence: 'high', eventReference: { type: 'by_description', description: 'dinner' }, editRequest: { newStartTime: '20:00' } });
    assert(editCalls.length === 1 && cardCalls.length === 0 && bulkCalls.length === 0, `${editCalls.length} edit, ${cardCalls.length} single, ${bulkCalls.length} bulk`);
  });

  await check('a forwarded message with no event still says it found none', async () => {
    const t = await getBotMessages('he');
    await forward({ intent: 'none', confidence: 'high', error: 'No calendar event information found in this message.' });
    assert(cardCalls.length === 0 && bulkCalls.length === 0 && sent.length === 1 && sent[0].text === t.voice.forwardNotUnderstood,
      `sent ${JSON.stringify(sent)}`);
  });

  await check('nothing reached the network', () => {
    assert(networkAttempts.length === 0, networkAttempts.join(', '));
  });
}

/** The console's own log: the code under test logs every step, and only the results are shown. */
const print = console.log.bind(console);

function summarize() {
  let failed = 0;
  for (const r of results) {
    print(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  print(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  process.exit(failed ? 1 : 0);
}

async function main() {
  if (process.argv.includes('--write-prompt-fixture')) {
    await writePromptFixture();
    return;
  }
  console.log = () => {};
  console.warn = () => {};
  await extractionChecks();
  summarize();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
````

- [ ] **Step 2: Take the prompt snapshot, before touching any source file**

The fixture must come from today's builder, so take it first. Check that `src/` is untouched:

```bash
git status --short src/
```

Expected: no output. If `src/services/voice/gemini-voice.ts` shows as modified, stop and restore it (`git checkout -- src/services/voice/gemini-voice.ts`) before taking the snapshot. Then run:

```bash
npx tsx scripts/smoke-native-reminder-creation.ts --write-prompt-fixture
```

Expected: `Wrote 5 prompts to scripts/fixtures/extraction-prompts.json` (tsx may also print a `DEP0205` deprecation warning on stderr; ignore it). The file is about 61 KB. The snapshot pins the clock line as `CURRENT DATE/TIME: <pinned>`; everything else is byte-for-byte today's prompt. Running the command again prints `scripts/fixtures/extraction-prompts.json exists. Delete it first to take a new snapshot.` and exits 1. Never retake the snapshot after Step 4.

- [ ] **Step 3: Run it to verify it fails**

```bash
TZ=UTC npx tsx scripts/smoke-native-reminder-creation.ts
TZ=Asia/Jerusalem npx tsx scripts/smoke-native-reminder-creation.ts
```

Expected under both clocks: exit code 1 and `12/30 passed`. The 12 that pass are:
- the byte-identity check, the photo check, the broken-anchor check and the unknown-kind check;
- "an event parses exactly as before…" and both "reminders off" checks;
- "voice without reminders…";
- the single-card, edit and none forward checks;
- "nothing reached the network".

The 18 failures include:
- `voice and text prompts gain the reminder rules after the unchanged prompt — voice: the rules are not appended to the unchanged prompt`
- `a timed reminder needs no end time: it ends where it starts — Asia/Jerusalem: Missing date/time fields`
- `a date-only reminder starts at local midnight and has no length (no 23:59 end) — Asia/Jerusalem {"allDay":true}: 2026-10-16 00:00..2026-10-16 23:59`
- `forwarded text without reminders sends the snapshot prompt and the message, as before — Cannot read properties of undefined (reading 'length')`
- `a forwarded message with two events gets one bulk card that quotes it — 0 bulk, 0 single, 1 sent`

- [ ] **Step 4: `ParsedEvent` gains the reminder fields**

In `src/services/event-parser.ts`, find (lines 78-81):

```ts
  confidence: 'high' | 'medium' | 'low';
  ambiguities?: string[];
  recurrence?: RecurrencePattern;
}
```

Replace with:

```ts
  confidence: 'high' | 'medium' | 'low';
  ambiguities?: string[];
  recurrence?: RecurrencePattern;
  /** 'reminder' for a reminder: one moment, so endTime equals startTime. Unset on an event. */
  kind?: 'event' | 'reminder';
  /** Reminders only: who it is for, as a role. Resolution maps 'partner' to the user's partner. */
  forPerson?: 'self' | 'partner';
  /**
   * Reminders only, for "an hour before the dentist": the words naming that event and the
   * minutes from its start (negative is before). startTime and endTime are Invalid Dates
   * until resolution finds the event.
   */
  anchor?: { description: string; offsetMinutes: number };
}
```

- [ ] **Step 5: `ReminderPromptContext` and the builder's new parameter**

In `src/services/voice/gemini-voice.ts`, find (lines 12-31):

```ts
import { CalendarAssignment } from '../../types';
import { fromZonedTime } from 'date-fns-tz';
import { AI_MODEL_ID } from '../../config/ai-models';
import { startOfLocalDay } from '../../utils/day-events';

const VOICE_RETRY_CONFIG = {
  maxRetries: 1,
  baseDelayMs: 500,
} as const;

/**
 * Build the event extraction prompt (shared between voice and text modes)
 */
export function buildEventExtractionPrompt(
  language: string,
  calendars: CalendarAssignment[],
  timezone: string,
  mode: 'voice' | 'text' | 'image' = 'voice',
  recentEventsBlock?: string
): string {
```

Replace with:

```ts
import { CalendarAssignment } from '../../types';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { AI_MODEL_ID } from '../../config/ai-models';
import { startOfLocalDay } from '../../utils/day-events';

const VOICE_RETRY_CONFIG = {
  maxRetries: 1,
  baseDelayMs: 500,
} as const;

/**
 * Who a reminder can be for, as the extraction prompt names them. Each name comes as the
 * user wrote it and in English: a partner can be "דנה" to one of them and "Dana" to the other.
 */
export interface ReminderPromptContext {
  userName: string;
  userEnglishName?: string | null;
  partnerName?: string | null;
  partnerEnglishName?: string | null;
}

/**
 * Build the event extraction prompt (shared between voice and text modes)
 * With `reminders`, voice and text prompts also learn reminders (see buildReminderRules);
 * without it the prompt is exactly the one users without reminders always had.
 */
export function buildEventExtractionPrompt(
  language: string,
  calendars: CalendarAssignment[],
  timezone: string,
  mode: 'voice' | 'text' | 'image' = 'voice',
  recentEventsBlock?: string,
  reminders?: ReminderPromptContext
): string {
```

- [ ] **Step 6: Append the reminder rules for voice and text**

In the same file, find (line 73):

```ts
  return `${modeInstructions}

CURRENT DATE/TIME: ${currentDateStr} at ${currentTimeStr} (timezone: ${timezone})
```

Replace with:

```ts
  const prompt = `${modeInstructions}

CURRENT DATE/TIME: ${currentDateStr} at ${currentTimeStr} (timezone: ${timezone})
```

Then find the end of the builder (lines 253-255):

```ts
Image: a photo of a cat with no text.
Output: {"intent": "none", "confidence": "high", "error": "No event found in this image."}` : '');
}
```

Replace it with the lines below. The rules are appended after everything else, so a prompt built without `reminders` keeps every byte. The examples' JSON parses. The `"forPerson": "partner"` examples appear only when there is a partner.

```ts
Image: a photo of a cat with no text.
Output: {"intent": "none", "confidence": "high", "error": "No event found in this image."}` : '');

  // A photo never makes a reminder, so the image prompt never learns them.
  return reminders && mode !== 'image' ? prompt + buildReminderRules(mode, reminders) : prompt;
}

/** `"דנה" (in English: "Dana")`, or just `"Dana"` when both spellings are the same. */
function spellings(name: string, englishName?: string | null): string {
  return englishName && englishName.trim().toLowerCase() !== name.trim().toLowerCase()
    ? `"${name}" (in English: "${englishName}")`
    : `"${name}"`;
}

/**
 * The reminder rules appended to the voice and text prompts for users who have reminders.
 * They teach the "kind", "forPerson" and "anchor" event fields, a reminder's single time,
 * and the phrasings that must not become events or deletes, in Hebrew, English and Russian.
 * Examples follow the mode: a voice example repeats its words as the transcription.
 */
function buildReminderRules(mode: 'voice' | 'text', people: ReminderPromptContext): string {
  const partner = people.partnerName || people.partnerEnglishName;
  const partnerInEnglish = people.partnerEnglishName || partner;
  const example = (input: string, translation: string, output: string) => (mode === 'voice'
    ? `Input audio: "${input}"${translation ? ` (${translation})` : ''}\nOutput: {"transcription": "${input}", ${output}}`
    : `Input text: "${input}"${translation ? ` (${translation})` : ''}\nOutput: {${output}}`);
  const reminder = (fields: string) => `"intent": "create", "confidence": "high", "event": {"kind": "reminder", ${fields}}`;

  const peopleRules = partner
    ? `- The user: ${spellings(people.userName, people.userEnglishName)}
- The user's partner: ${spellings(partner, people.partnerEnglishName)}. Also called "my wife", "my husband", "my partner", "אשתי", "בעלי", "בן הזוג שלי", "בת הזוג שלי", "моя жена", "мой муж".`
    : `- The user: ${spellings(people.userName, people.userEnglishName)}
- The user has no linked partner, so every reminder is for the user.`;

  const whoRules = partner
    ? `2. WHO IT IS FOR - every reminder has "forPerson":
   - "partner" when it is for the user's partner, by name or by role: "remind ${partnerInEnglish} to...", "remind my wife to...", "תזכיר לבעלי...", "תזכירי לאשתי...", "напомни мужу...", "напомни жене...".
   - "self" for everything else: "remind me", "remind us", and a child or anyone else. Keep that person's name in the title: "Remind Noa to take her medicine" → title "Noa: take her medicine", "forPerson": "self".`
    : `2. WHO IT IS FOR - "forPerson" is always "self". Keep anyone else's name in the title: "Remind Noa to take her medicine" → title "Noa: take her medicine".`;

  const forwardedRule = mode === 'text'
    ? `\n\n8. FORWARDED MESSAGES - in a message the user forwarded, "me", "I", "לי" and "мне" mean the user who forwarded it, never whoever wrote it.`
    : '';

  const examples = [
    example('Remind me to call the plumber Thursday at 10', '',
      reminder('"forPerson": "self", "title": "Call the plumber", "startDate": "YYYY-MM-DD", "startTime": "10:00", "endDate": null, "endTime": null, "allDay": false, "recurrence": null, "anchor": null')),
    partner
      ? example(`Remind ${partnerInEnglish} to buy milk tomorrow`, '',
        reminder('"forPerson": "partner", "title": "Buy milk", "startDate": "YYYY-MM-DD", "startTime": null, "endDate": null, "endTime": null, "allDay": true, "recurrence": null, "anchor": null'))
      : example('Remind me to buy milk tomorrow', '',
        reminder('"forPerson": "self", "title": "Buy milk", "startDate": "YYYY-MM-DD", "startTime": null, "endDate": null, "endTime": null, "allDay": true, "recurrence": null, "anchor": null')),
    example('תזכיר לי בערב להתקשר לאמא', 'Hebrew: Remind me in the evening to call mom',
      reminder('"forPerson": "self", "title": "להתקשר לאמא", "startDate": "YYYY-MM-DD", "startTime": "20:00", "endDate": null, "endTime": null, "allDay": false, "recurrence": null, "anchor": null')),
    ...(partner
      ? [example('напомни мужу забрать детей в четыре', 'Russian: Remind my husband to pick up the kids at four',
        reminder('"forPerson": "partner", "title": "Забрать детей", "startDate": "YYYY-MM-DD", "startTime": "16:00", "endDate": null, "endTime": null, "allDay": false, "recurrence": null, "anchor": null'))]
      : []),
    example('напомни через 20 минут выключить духовку', 'Russian: Remind me in 20 minutes to turn off the oven; said at 18:40',
      reminder('"forPerson": "self", "title": "Выключить духовку", "startDate": "YYYY-MM-DD", "startTime": "19:00", "endDate": null, "endTime": null, "allDay": false, "recurrence": null, "anchor": null')),
    example('Remind me every Sunday at 8 to take out the trash', '',
      reminder('"forPerson": "self", "title": "Take out the trash", "startDate": "YYYY-MM-DD", "startTime": "08:00", "endDate": null, "endTime": null, "allDay": false, "recurrence": {"frequency": "weekly", "daysOfWeek": ["SU"]}, "anchor": null')),
    example('Remind me an hour before the dentist to bring the forms', '',
      reminder('"forPerson": "self", "title": "Bring the forms", "startDate": null, "startTime": null, "endDate": null, "endTime": null, "allDay": false, "recurrence": null, "anchor": {"description": "dentist", "offsetMinutes": -60}')),
    example('אל תשכח לשלם את חשבון החשמל', "Hebrew: Don't forget to pay the electricity bill",
      reminder('"forPerson": "self", "title": "לשלם את חשבון החשמל", "startDate": "YYYY-MM-DD", "startTime": null, "endDate": null, "endTime": null, "allDay": true, "recurrence": null, "anchor": null')),
    example('Dentist Thursday at 10', '',
      '"intent": "create", "confidence": "high", "event": {"kind": "event", "title": "Dentist", "startDate": "YYYY-MM-DD", "startTime": "10:00", "endDate": "YYYY-MM-DD", "endTime": "11:00", "allDay": false, "calendarId": "primary", "calendarName": "Primary", "recurrence": null}'),
    example('Move the plumber reminder to 5pm', '',
      '"intent": "edit", "confidence": "high", "eventReference": {"type": "by_description", "description": "plumber"}, "editRequest": {"newStartTime": "17:00"}'),
    example('Stop reminding me about the vitamins', '',
      '"intent": "delete", "confidence": "high", "scope": "all", "eventReference": {"type": "by_description", "description": "vitamins"}'),
    example('סיימתי', "Hebrew: I'm done",
      '"intent": "none", "confidence": "high", "error": "The user reported a finished task; there is nothing to change."'),
  ];

  return `

REMINDERS:
The user can also ask FamCal to remind someone of something. A reminder is a calendar item with a single moment and no duration; at that moment FamCal sends the person a reminder message. These rules come on top of the rules above and win wherever they disagree.

PEOPLE:
${peopleRules}

1. KIND - every "event" has "kind":
   - "reminder" ONLY when the user explicitly asks to be reminded, or not to forget something:
     * English: "remind me", "remind us", "remind <name>", "set a reminder", "reminder to", "don't forget to"
     * Hebrew: "תזכיר לי", "תזכירי לי", "תזכיר ל<name>", "תזכורת", "להזכיר", "אל תשכח", "אל תשכחי"
     * Russian: "напомни", "напомните", "напоминание", "не забудь", "не забыть"
   - "event" for everything else. An appointment stays an event: "Dentist Thursday at 10" is an event.
   - "Don't forget - <a meeting, class or party with its own time and place>" announces an event, so it stays an event. "Don't forget to <do something>" is a reminder.
   - The "forget" in "don't forget", "אל תשכח" or "не забудь" is never the DELETE keyword.

${whoRules}

3. TITLE - the bare task, in the language the user used: "Call the plumber", "להתקשר לאינסטלטור", "Позвонить сантехнику". Never "Remind <name> to...", "Reminder: ...", "תזכורת ל...", "Напоминание: ...".

4. TIME - a reminder has a start and nothing else:
   - Give "startDate", and "startTime" when there is a time. "endDate" and "endTime" are always null.
   - A date with no time: "allDay": true and no "startTime".
   - No date and no time: today's date, "allDay": true.
   - Parts of the day: morning, בבוקר, утром → 09:00. Noon, בצהריים, в обед, в полдень → 12:00. Afternoon, אחר הצהריים, после обеда, днём → 16:00. Evening, tonight, בערב, הערב, вечером, сегодня вечером → 20:00.
   - An hour with no date and no part of the day ("at 5", "בחמש", "в пять") is the next time the clock shows it: said at 14:00, "at 5" is 17:00 today; said at 21:00, "at 8" is 08:00 tomorrow. A full time that has already passed today ("at 13:00" said at 15:00) is tomorrow.
   - "In 20 minutes", "בעוד חצי שעה", "через 20 минут": the CURRENT DATE/TIME above plus that much, as "startDate" and "startTime".
   - Repeating reminders use "recurrence" as events do, with "startDate" the first time: "every Sunday at 8" → weekly, "daysOfWeek": ["SU"], "startTime": "08:00"; "every morning" → daily at 09:00.
   - Leave out "calendarId" and "calendarName": FamCal keeps a reminder on the user's own calendar, whoever it is for.

5. RELATIVE TO ANOTHER EVENT - "an hour before the dentist", "שעה לפני רופא השיניים", "за час до стоматолога":
   - Give "anchor": {"description": the words naming that event, "offsetMinutes": minutes from that event's start, negative for before}. Leave "startDate" and "startTime" null: FamCal finds the event and works out the time.
   - "An hour before" → -60. "Half an hour after" → 30. "The day before" → -1440. "On the day of" → 0.

6. CHANGING A REMINDER:
   - Moving a reminder ("move the reminder to 5", "תזיז את התזכורת לחמש", "перенеси напоминание на пять") sets "newStartDate" and/or "newStartTime" (or "newAllDay") only. "newEndDate" and "newEndTime" stay null: a reminder has one time, so never add an hour.
   - "Stop reminding me to...", "תפסיק להזכיר לי...", "хватит напоминать..." → intent "delete", "scope": "all".
   - "Skip today's reminder", "דלג על התזכורת של היום", "пропусти сегодняшнее напоминание" → intent "delete", "scope": "single", "timeHint": "today".

7. DONE - "I did it", "done", "I already called", "סיימתי", "עשיתי את זה", "כבר התקשרתי", "сделал", "сделала", "готово" report a finished task: intent "none", with nothing to create, edit or delete. "none" is allowed here in every mode.${forwardedRule}

REMINDER FIELDS (inside "event", and inside the "event" of each "intents" entry):
  "kind": "event" | "reminder",
  "forPerson": "self" | "partner" (reminders only),
  "anchor": {"description": "dentist", "offsetMinutes": -60} or null (reminders only)

REMINDER EXAMPLES:

${examples.join('\n\n')}`;
}
```

- [ ] **Step 7: `extractIntents` passes `remindersOn` through**

Find (lines 261-288):

```ts
/**
 * Multi-event support (PR 11): if Gemini returned `intents` as an array of 2+
 * entries, split each one through parseGeminiEventResponse. Otherwise return a
 * single-element array containing the parsed primary intent. Callers that
 * always expect a single intent can read `[0]`.
 *
 * Caps at 10 entries per the locked product decision.
 */
export function extractIntents(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw model JSON, read field by field
  parsed: any,
  calendars: CalendarAssignment[],
  timezone: string
): VoiceIntentResult[] {
  if (Array.isArray(parsed.intents) && parsed.intents.length > 1) {
    const capped = parsed.intents.slice(0, 10);
    return capped.map((it: unknown) =>
      parseGeminiEventResponse(
        // Each intents[i] entry is a sibling shape — splice it onto the top-level
        // shape parseGeminiEventResponse expects.
        { ...(it as object), transcription: parsed.transcription },
        calendars,
        timezone
      )
    );
  }
  return [parseGeminiEventResponse(parsed, calendars, timezone)];
}
```

Replace with:

```ts
/**
 * Multi-event support (PR 11): if Gemini returned `intents` as an array of 2+
 * entries, split each one through parseGeminiEventResponse. Otherwise return a
 * single-element array containing the parsed primary intent. Callers that
 * always expect a single intent can read `[0]`.
 *
 * Caps at 10 entries per the locked product decision.
 * `remindersOn` as in parseGeminiEventResponse.
 */
export function extractIntents(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw model JSON, read field by field
  parsed: any,
  calendars: CalendarAssignment[],
  timezone: string,
  remindersOn = false
): VoiceIntentResult[] {
  if (Array.isArray(parsed.intents) && parsed.intents.length > 1) {
    const capped = parsed.intents.slice(0, 10);
    return capped.map((it: unknown) =>
      parseGeminiEventResponse(
        // Each intents[i] entry is a sibling shape — splice it onto the top-level
        // shape parseGeminiEventResponse expects.
        { ...(it as object), transcription: parsed.transcription },
        calendars,
        timezone,
        remindersOn
      )
    );
  }
  return [parseGeminiEventResponse(parsed, calendars, timezone, remindersOn)];
}
```

- [ ] **Step 8: A reminder's time, its anchor, and the reminder branch of the parser**

Find the end of `buildEventTimes` and the head of `parseGeminiEventResponse` (lines 314-330):

```ts
  const midnight = fromZonedTime(`${startDate}T00:00:00`, timezone);
  return {
    start: isNaN(midnight.getTime()) ? midnight : startOfLocalDay(startDate, timezone),
    end: fromZonedTime(`${lastDate}T23:59:00`, timezone),
  };
}

/**
 * Parse Gemini JSON response into VoiceIntentResult
 * Shared between voice and text processing pipelines
 */
export function parseGeminiEventResponse(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw model JSON, validated field by field below
  parsed: any,
  calendars: CalendarAssignment[],
  timezone: string
): VoiceIntentResult {
```

Replace with:

```ts
  const midnight = fromZonedTime(`${startDate}T00:00:00`, timezone);
  return {
    start: isNaN(midnight.getTime()) ? midnight : startOfLocalDay(startDate, timezone),
    end: fromZonedTime(`${lastDate}T23:59:00`, timezone),
  };
}

/**
 * When a reminder is due in `timezone`. A reminder is one moment, so callers end it where it
 * starts. With a time it is that moment. A date with no time is all day, starting at the
 * first instant of that day as an all-day event does (buildEventTimes) but with no length,
 * where an event's 23:59 end would give it one. No date at all means today.
 * An unreadable date or time gives an Invalid Date.
 */
export function buildReminderTimes(
  startDate: string | undefined,
  startTime: string | undefined,
  allDay: boolean,
  timezone: string,
  now: Date = new Date()
): { start: Date; allDay: boolean } {
  const date = startDate || formatInTimeZone(now, timezone, 'yyyy-MM-dd');
  const dateOnly = allDay || !startTime;
  const { start } = buildEventTimes(date, startTime, undefined, startTime, dateOnly, timezone);
  return { start, allDay: dateOnly };
}

/** The model's anchor ("an hour before the dentist"), or undefined when it is missing or unreadable. */
function readAnchor(raw: unknown): ParsedEvent['anchor'] {
  if (!raw || typeof raw !== 'object') return undefined;
  const { description, offsetMinutes } = raw as { description?: unknown; offsetMinutes?: unknown };
  if (typeof description !== 'string' || !description.trim()) return undefined;
  const offset = Number(offsetMinutes ?? 0);
  return Number.isFinite(offset) ? { description: description.trim(), offsetMinutes: Math.round(offset) } : undefined;
}

/**
 * A reminder the model created. It ends where it starts (see buildReminderTimes). An
 * anchored one has no time of its own yet: both times stay Invalid Dates until resolution
 * finds the anchor event. It goes on the user's own calendar whatever the model picked, so
 * the model's pick is neither matched nor warned about.
 */
function parseReminderCreate(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw model JSON, read field by field
  parsed: any,
  calendars: CalendarAssignment[],
  timezone: string
): VoiceIntentResult {
  const eventData = parsed.event;
  const confidence = parsed.confidence || 'medium';
  const anchor = readAnchor(eventData.anchor);
  if (!anchor && eventData.anchor && !eventData.startDate) {
    return { intent: 'create', confidence: 'low', error: 'Missing date/time fields' };
  }

  const { start, allDay } = anchor
    ? { start: new Date(NaN), allDay: false }
    : buildReminderTimes(eventData.startDate, eventData.startTime, !!eventData.allDay, timezone);
  if (!anchor && isNaN(start.getTime())) {
    return { intent: 'create', confidence: 'low', error: 'Invalid date/time parsed' };
  }

  const own = calendars.find(c => c.labels.includes('primary')) ?? calendars[0];
  const event: ParsedEvent = {
    title: eventData.title,
    startTime: start,
    endTime: new Date(start.getTime()),
    location: eventData.location || undefined,
    description: eventData.description || undefined,
    allDay,
    calendarId: own?.calendarId || 'primary',
    calendarName: own?.name || 'Primary',
    confidence,
    recurrence: eventData.recurrence?.frequency ? eventData.recurrence : undefined,
    kind: 'reminder',
    forPerson: eventData.forPerson === 'partner' ? 'partner' : 'self',
    ...(anchor ? { anchor } : {}),
  };

  return {
    intent: 'create',
    confidence,
    event,
    error: parsed.error,
    needsClarification: parsed.needsClarification,
    clarificationQuestion: parsed.clarificationQuestion,
  };
}

/**
 * Parse Gemini JSON response into VoiceIntentResult
 * Shared between voice and text processing pipelines
 * `remindersOn`: the prompt had the reminder rules, so an event of kind "reminder" is read
 * as one. Off, every create is read as an event, exactly as before reminders existed.
 */
export function parseGeminiEventResponse(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw model JSON, validated field by field below
  parsed: any,
  calendars: CalendarAssignment[],
  timezone: string,
  remindersOn = false
): VoiceIntentResult {
```

Then find (lines 343-345):

```ts
  if (intent === 'create' && parsed.event) {
    const eventData = parsed.event;

    // Validate calendarId against user's actual calendars
```

Replace with:

```ts
  if (intent === 'create' && parsed.event) {
    if (remindersOn && parsed.event.kind === 'reminder') {
      return parseReminderCreate(parsed, calendars, timezone);
    }
    const eventData = parsed.event;

    // Validate calendarId against user's actual calendars
```

The rest of the create branch, and the edit, delete and none branches, stay exactly as they are. Events keep today's validation (an `endTime` is required unless `allDay`), today's 23:59 all-day end, and today's calendar matching and warning.

- [ ] **Step 9: `processVoiceWithGemini` takes the reminder context**

Find (lines 457-461):

```ts
  // PR 10 polish: optional prior-attempt audio for retry-mode parses. Sent
  // as a SEPARATE inlineData part so Gemini decodes both OGG containers
  // independently — byte-concat would produce an invalid OGG stream.
  priorAudioBuffer?: Buffer
): Promise<{ intentResult: VoiceIntentResult; intentResults?: VoiceIntentResult[]; transcription: string; metrics: VoiceProcessingMetrics }> {
```

Replace with:

```ts
  // PR 10 polish: optional prior-attempt audio for retry-mode parses. Sent
  // as a SEPARATE inlineData part so Gemini decodes both OGG containers
  // independently — byte-concat would produce an invalid OGG stream.
  priorAudioBuffer?: Buffer,
  // Given only for users who have reminders: the prompt learns them and the parser reads them.
  reminders?: ReminderPromptContext
): Promise<{ intentResult: VoiceIntentResult; intentResults?: VoiceIntentResult[]; transcription: string; metrics: VoiceProcessingMetrics }> {
```

Find (line 498):

```ts
      const promptText = buildEventExtractionPrompt(language, calendars, timezone, 'voice', recentEventsBlock) + retryNote;
```

Replace with:

```ts
      const promptText = buildEventExtractionPrompt(language, calendars, timezone, 'voice', recentEventsBlock, reminders) + retryNote;
```

Find (line 555):

```ts
      const intentResults = extractIntents(parsed, calendars, timezone);
      const intentResult = intentResults[0];

      // The extraction prompt fabricates commands for non-speech, so its answer only
```

Replace with:

```ts
      const intentResults = extractIntents(parsed, calendars, timezone, !!reminders);
      const intentResult = intentResults[0];

      // The extraction prompt fabricates commands for non-speech, so its answer only
```

The Telegram voice handler (`voice/handler.ts:338`) and WhatsApp voice (`webhook-handlers.ts:915`) are unchanged in this task. Neither passes `reminders` yet, so they behave exactly as before. Task 11 wires both.

- [ ] **Step 10: Forwarded text reads every intent and takes the reminder context**

In `src/services/forward-event/gemini-text.ts`, find (line 10):

```ts
import { buildEventExtractionPrompt, parseGeminiEventResponse } from '../voice/gemini-voice';
```

Replace with:

```ts
import { buildEventExtractionPrompt, extractIntents, ReminderPromptContext } from '../voice/gemini-voice';
```

Find (lines 28-43):

```ts
/**
 * Process forwarded message text with Gemini
 * Single API call: intent detection + event extraction
 */
export async function processTextWithGemini(
  text: string,
  language: string,
  calendars: CalendarAssignment[],
  timezone: string
): Promise<{ intentResult: VoiceIntentResult; metrics: TextProcessingMetrics }> {
  const startTime = Date.now();
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= TEXT_RETRY_CONFIG.maxRetries; attempt++) {
    try {
      const promptText = buildEventExtractionPrompt(language, calendars, timezone, 'text');
```

Replace with:

```ts
/**
 * Process forwarded message text with Gemini
 * Single API call: intent detection + event extraction
 * Several actions in one message come back as `intentResults`; `intentResult` is the first.
 * `reminders` is given only for users who have reminders: the prompt learns them and the
 * parser reads them.
 */
export async function processTextWithGemini(
  text: string,
  language: string,
  calendars: CalendarAssignment[],
  timezone: string,
  reminders?: ReminderPromptContext
): Promise<{ intentResult: VoiceIntentResult; intentResults: VoiceIntentResult[]; metrics: TextProcessingMetrics }> {
  const startTime = Date.now();
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= TEXT_RETRY_CONFIG.maxRetries; attempt++) {
    try {
      const promptText = buildEventExtractionPrompt(language, calendars, timezone, 'text', undefined, reminders);
```

Find (lines 86-93):

```ts
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const parsed: any = JSON.parse(jsonMatch[0]);
      const intentResult = parseGeminiEventResponse(parsed, calendars, timezone);

      return {
        intentResult,
        metrics: { model: AI_MODEL_ID, inputTokens, outputTokens, durationMs: duration },
      };
```

Replace with:

```ts
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const parsed: any = JSON.parse(jsonMatch[0]);
      const intentResults = extractIntents(parsed, calendars, timezone, !!reminders);
      const intentResult = intentResults[0];

      return {
        intentResult,
        intentResults,
        metrics: { model: AI_MODEL_ID, inputTokens, outputTokens, durationMs: duration },
      };
```

When the model answers with a single intent, `intentResults[0]` is exactly what `parseGeminiEventResponse(parsed, …)` returned before. Only an answer with two or more `intents` changes. It used to fall through to `'Unknown intent'`, so the user saw "couldn't find an event".

- [ ] **Step 11: A forwarded message with several events gets the bulk card**

In `src/services/forward-event/handler.ts`, find (lines 119-120):

```ts
    const timezone = await resolveUserTimezone(user);
    const { intentResult, metrics } = await processTextWithGemini(
```

Replace with:

```ts
    const timezone = await resolveUserTimezone(user);
    const { intentResult, intentResults, metrics } = await processTextWithGemini(
```

Find (lines 140-143):

```ts
    // Stop typing before sending confirmation UI
    stopTyping();

    if (intentResult.intent === 'create') {
```

Replace with:

```ts
    // Stop typing before sending confirmation UI
    stopTyping();

    // Several events in one message: one bulk card, as for voice notes and photos.
    const validBulk = intentResults.filter(r => r.intent === 'create' && r.event && !r.error);
    if (validBulk.length > 1) {
      const { showBulkConfirmation } = await import('../voice/bulk-confirmations');
      await showBulkConfirmation(chatId, validBulk, user, messageText, t, messagingService, timezone);
      return;
    }

    if (intentResult.intent === 'create') {
```

This is the same filter and call as `voice/handler.ts:371-378` and `image-event/handler.ts:138-143`. The single-event card call (`showEventConfirmation(chatId, undefined, intentResult.event, messageText, user, adminFooter)`) is untouched. Note: confirming a bulk card still hits the pre-existing Date-revival crash in `getPendingBatch` (spec §11.1). Task 11 fixes it, and both tasks land on `main` together.

- [ ] **Step 12: The live eval script (written now, run in Task 14)**

Create `scripts/eval-native-reminders.ts`:

```ts
// Live evaluation: does extraction recognise reminders in Hebrew, English and Russian, and
// leave everything else as it was?
//
// Runs a phrase table through processTextWithGemini() with the reminder rules on - the path
// forwarded and typed text take - on the production model and thinking level (MEDIUM).
// Voice notes get the same rules from the same prompt builder. Each case checks the parsed
// result: a reminder's kind, who it is for, its single time, recurrence and anchor; that
// near-misses stay events; that "I did it" creates nothing; that "stop reminding me"
// deletes the whole series; and that moving a reminder sets one time and no end.
//
// Expected: every case passes. Re-run after any change to the extraction prompt, the
// reminder rules, the parser or the model.
//
// COSTS MONEY: one Gemini call per case per run. It calls the model whenever the repo's
// .env holds a key, with or without -r dotenv/config: loading the app loads @prisma/client,
// which reads .env itself.
//
// Run:
//   NODE_OPTIONS='--conditions=import' npx tsx -r dotenv/config scripts/eval-native-reminders.ts
// Lists the cases and prompt sizes without calling the model:
//   NODE_OPTIONS='--conditions=import' npx tsx scripts/eval-native-reminders.ts --dry-run
// Options (env): EVAL_RUNS=1

import { formatInTimeZone } from 'date-fns-tz';
import type { ParsedEvent, VoiceIntentResult } from '../src/services/event-parser';
import type { ReminderPromptContext } from '../src/services/voice/gemini-voice';
import type { CalendarAssignment } from '../src/types';

const RUNS = Number(process.env.EVAL_RUNS || 1);
const TZ = 'Asia/Jerusalem';

type Language = 'en' | 'he' | 'ru';

/** The user and the partner, named as each user's own language would store them. */
const PEOPLE: Record<Language, ReminderPromptContext> = {
  en: { userName: 'Raziel', partnerName: 'Dana' },
  he: { userName: 'רזיאל', userEnglishName: 'Raziel', partnerName: 'דנה', partnerEnglishName: 'Dana' },
  ru: { userName: 'Разиэль', userEnglishName: 'Raziel', partnerName: 'Дана', partnerEnglishName: 'Dana' },
};

/** A built-in calendar pair, seen from the user's side. */
const CALENDARS: CalendarAssignment[] = [
  { calendarId: 'native:cmain00000000000000000001', name: 'Raziel', labels: ['primary', 'yours'], color: '#4285f4' },
  { calendarId: 'native:cdana00000000000000000002', name: 'Dana', labels: ['spouse'], color: '#e67c73', personName: 'Dana', personGender: 'female' },
];

const day = (d: Date) => formatInTimeZone(d, TZ, 'yyyy-MM-dd');
const clock = (d: Date) => formatInTimeZone(d, TZ, 'HH:mm');
const weekdayOf = (d: Date) => formatInTimeZone(d, TZ, 'EEE');
/** The local date `n` days after `now`'s, by the calendar, not by 24-hour steps. */
function dayFrom(now: Date, n: number): string {
  const [y, m, d] = day(now).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** A failure reason, or null when the result is right. */
type Expect = (results: VoiceIntentResult[], now: Date) => string | null;
type Case = { language: Language; label: string; text: string; expect: Expect };

const describeAll = (results: VoiceIntentResult[]) =>
  results.map(r => (r.event ? `${r.intent}:${r.event.kind ?? 'event'}` : `${r.intent}${r.error ? ` (${r.error})` : ''}`)).join(', ');

interface ReminderWant {
  forPerson?: 'self' | 'partner';
  /** Days after today, on the user's clock (0 = today). */
  inDays?: number;
  /** The weekday it falls on, within the coming week ('Thu'). */
  weekday?: string;
  /** A timed reminder at this local time. */
  time?: string;
  allDay?: boolean;
  /** Starts this many minutes from now, inclusive. */
  minutesFromNow?: [number, number];
  /** Repeats weekly on this day code. */
  weekly?: string;
  anchor?: { description: RegExp; offsetMinutes: number };
}

function checkReminder(ev: ParsedEvent, want: ReminderWant, now: Date): string | null {
  if (ev.kind !== 'reminder') return `kind ${ev.kind ?? 'event'}`;
  const problems: string[] = [];
  if (want.forPerson && ev.forPerson !== want.forPerson) problems.push(`forPerson ${ev.forPerson}`);
  if (want.anchor) {
    if (!ev.anchor) problems.push(`no anchor (starts ${isNaN(ev.startTime.getTime()) ? 'never' : `${day(ev.startTime)} ${clock(ev.startTime)}`})`);
    else {
      if (!want.anchor.description.test(ev.anchor.description)) problems.push(`anchor "${ev.anchor.description}"`);
      if (ev.anchor.offsetMinutes !== want.anchor.offsetMinutes) problems.push(`offset ${ev.anchor.offsetMinutes}`);
    }
    return problems.join('; ') || null;
  }
  if (ev.anchor) problems.push(`unexpected anchor ${JSON.stringify(ev.anchor)}`);
  if (isNaN(ev.startTime.getTime())) return [...problems, 'no time'].join('; ');
  if (ev.endTime.getTime() !== ev.startTime.getTime()) problems.push('has a duration');
  if (want.allDay !== undefined && ev.allDay !== want.allDay) problems.push(ev.allDay ? 'all day' : `timed ${clock(ev.startTime)}`);
  if (want.time && (ev.allDay || clock(ev.startTime) !== want.time)) problems.push(`time ${ev.allDay ? 'none' : clock(ev.startTime)}`);
  if (want.inDays !== undefined && day(ev.startTime) !== dayFrom(now, want.inDays)) problems.push(`date ${day(ev.startTime)}`);
  if (want.weekday) {
    const daysAhead = (ev.startTime.getTime() - now.getTime()) / 864e5;
    if (weekdayOf(ev.startTime) !== want.weekday || daysAhead < -1 || daysAhead > 8) problems.push(`date ${day(ev.startTime)} (${weekdayOf(ev.startTime)})`);
  }
  if (want.minutesFromNow) {
    const minutes = (ev.startTime.getTime() - now.getTime()) / 6e4;
    if (minutes < want.minutesFromNow[0] || minutes > want.minutesFromNow[1]) problems.push(`starts in ${Math.round(minutes)} min`);
  }
  if (want.weekly) {
    const r = ev.recurrence;
    if (r?.frequency !== 'weekly' || !r.daysOfWeek?.includes(want.weekly)) problems.push(`recurrence ${JSON.stringify(r ?? null)}`);
  } else if (ev.recurrence) {
    problems.push(`unexpected recurrence ${JSON.stringify(ev.recurrence)}`);
  }
  return problems.join('; ') || null;
}

/** One reminder is created, as wanted. */
const reminder = (want: ReminderWant): Expect => (results, now) => {
  const creates = results.filter(r => r.intent === 'create' && r.event);
  if (creates.length !== 1) return `${creates.length} creates: ${describeAll(results)}`;
  return checkReminder(creates[0].event!, want, now);
};

/** One ordinary event is created: not a reminder, and timed ones keep a duration. */
const staysEvent: Expect = results => {
  const creates = results.filter(r => r.intent === 'create' && r.event);
  if (creates.length !== 1) return `${creates.length} creates: ${describeAll(results)}`;
  const ev = creates[0].event!;
  if (ev.kind === 'reminder') return 'became a reminder';
  return !ev.allDay && ev.endTime <= ev.startTime ? 'no duration' : null;
};

/** Nothing is created, edited or deleted. */
const nothing: Expect = results =>
  (results.some(r => r.event || r.eventReference || r.editRequest) ? `acted: ${describeAll(results)}` : null);

/** The whole series is deleted. */
const deletesSeries = (description: RegExp): Expect => results => {
  const r = results[0];
  if (results.length !== 1 || r.intent !== 'delete') return describeAll(results);
  if (r.scope !== 'all') return `scope ${r.scope}`;
  return description.test(r.eventReference?.description ?? '') ? null : `description "${r.eventReference?.description}"`;
};

/** An edit that moves the start to `time` and leaves the end alone. */
const movesTo = (time: string): Expect => results => {
  const r = results[0];
  if (results.length !== 1 || r.intent !== 'edit') return describeAll(results);
  if (r.editRequest?.newStartTime !== time) return `newStartTime ${r.editRequest?.newStartTime}`;
  return r.editRequest.newEndTime || r.editRequest.newEndDate ? `end ${r.editRequest.newEndDate ?? ''} ${r.editRequest.newEndTime ?? ''}` : null;
};

/** Two reminders in one message, one for the user and one for the partner. */
const twoReminders: Expect = results => {
  const creates = results.filter(r => r.intent === 'create' && r.event);
  const got = creates.map(r => (r.event!.kind === 'reminder' ? r.event!.forPerson : 'event')).sort().join(',');
  return got === 'partner,self' ? null : `got [${got}]: ${describeAll(results)}`;
};

const CASES: Case[] = [
  // Timed, for the user.
  { language: 'en', label: 'timed', text: 'Remind me to call the plumber on Thursday at 10', expect: reminder({ forPerson: 'self', weekday: 'Thu', time: '10:00' }) },
  { language: 'he', label: 'timed', text: 'תזכיר לי להתקשר לאינסטלטור ביום חמישי בעשר', expect: reminder({ forPerson: 'self', weekday: 'Thu', time: '10:00' }) },
  { language: 'ru', label: 'timed', text: 'Напомни мне позвонить сантехнику в четверг в 10', expect: reminder({ forPerson: 'self', weekday: 'Thu', time: '10:00' }) },
  // For the partner, by name.
  { language: 'en', label: 'partner by name', text: 'Remind Dana to buy milk tomorrow', expect: reminder({ forPerson: 'partner', inDays: 1, allDay: true }) },
  { language: 'he', label: 'partner by name', text: 'תזכיר לדנה לקנות חלב מחר', expect: reminder({ forPerson: 'partner', inDays: 1, allDay: true }) },
  { language: 'ru', label: 'partner by name', text: 'Напомни Дане купить молоко завтра', expect: reminder({ forPerson: 'partner', inDays: 1, allDay: true }) },
  // For the partner, by role.
  { language: 'en', label: 'partner by role', text: 'Remind my wife to call the bank tomorrow at 9', expect: reminder({ forPerson: 'partner', inDays: 1, time: '09:00' }) },
  { language: 'he', label: 'partner by role', text: 'תזכיר לאשתי להתקשר לבנק מחר בתשע', expect: reminder({ forPerson: 'partner', inDays: 1, time: '09:00' }) },
  { language: 'ru', label: 'partner by role', text: 'Напомни жене позвонить в банк завтра в 9', expect: reminder({ forPerson: 'partner', inDays: 1, time: '09:00' }) },
  // A date with no time.
  { language: 'en', label: 'date only', text: 'Remind me on Friday to pay the electricity bill', expect: reminder({ forPerson: 'self', weekday: 'Fri', allDay: true }) },
  { language: 'he', label: 'date only', text: 'תזכיר לי ביום שישי לשלם את החשמל', expect: reminder({ forPerson: 'self', weekday: 'Fri', allDay: true }) },
  { language: 'ru', label: 'date only', text: 'Напомни в пятницу оплатить электричество', expect: reminder({ forPerson: 'self', weekday: 'Fri', allDay: true }) },
  // No date and no time: today.
  { language: 'en', label: 'no date', text: 'Remind me to buy batteries', expect: reminder({ forPerson: 'self', inDays: 0, allDay: true }) },
  { language: 'he', label: 'no date', text: 'תזכיר לי לקנות סוללות', expect: reminder({ forPerson: 'self', inDays: 0, allDay: true }) },
  { language: 'ru', label: 'no date', text: 'Напомни купить батарейки', expect: reminder({ forPerson: 'self', inDays: 0, allDay: true }) },
  // Part of the day.
  { language: 'en', label: 'part of day', text: 'Remind me tomorrow evening to pack the bags', expect: reminder({ inDays: 1, time: '20:00' }) },
  { language: 'he', label: 'part of day', text: 'תזכיר לי מחר בבוקר לקחת את התרופה', expect: reminder({ inDays: 1, time: '09:00' }) },
  { language: 'ru', label: 'part of day', text: 'Напомни завтра после обеда забрать посылку', expect: reminder({ inDays: 1, time: '16:00' }) },
  // Relative.
  { language: 'en', label: 'relative', text: 'Remind me in 20 minutes to take the laundry out', expect: reminder({ minutesFromNow: [15, 25] }) },
  { language: 'he', label: 'relative', text: 'תזכיר לי בעוד חצי שעה לכבות את התנור', expect: reminder({ minutesFromNow: [25, 35] }) },
  { language: 'ru', label: 'relative', text: 'Напомни через 20 минут выключить духовку', expect: reminder({ minutesFromNow: [15, 25] }) },
  // Repeating.
  { language: 'en', label: 'repeating', text: 'Remind me every Sunday at 8 to take out the trash', expect: reminder({ weekly: 'SU', time: '08:00' }) },
  { language: 'he', label: 'repeating', text: 'תזכיר לי כל יום ראשון בשמונה להוציא את הזבל', expect: reminder({ weekly: 'SU', time: '08:00' }) },
  { language: 'ru', label: 'repeating', text: 'Напоминай каждое воскресенье в 8 выносить мусор', expect: reminder({ weekly: 'SU', time: '08:00' }) },
  // Relative to another event.
  { language: 'en', label: 'anchor', text: 'Remind me an hour before the dentist to bring the forms', expect: reminder({ anchor: { description: /dentist/i, offsetMinutes: -60 } }) },
  { language: 'he', label: 'anchor', text: 'תזכיר לי שעה לפני רופא השיניים להביא את הטפסים', expect: reminder({ anchor: { description: /שיניים/, offsetMinutes: -60 } }) },
  { language: 'ru', label: 'anchor', text: 'Напомни за час до стоматолога взять документы', expect: reminder({ anchor: { description: /стоматолог/i, offsetMinutes: -60 } }) },
  // "Don't forget to..." is a reminder, not a delete.
  { language: 'en', label: "don't forget", text: "Don't forget to water the plants tomorrow", expect: reminder({ forPerson: 'self', inDays: 1, allDay: true }) },
  { language: 'he', label: "don't forget", text: 'אל תשכח להשקות את העציצים מחר', expect: reminder({ forPerson: 'self', inDays: 1, allDay: true }) },
  { language: 'ru', label: "don't forget", text: 'Не забудь полить цветы завтра', expect: reminder({ forPerson: 'self', inDays: 1, allDay: true }) },
  // Near-misses that must stay events.
  { language: 'en', label: 'stays an event', text: 'Dentist Thursday at 10', expect: staysEvent },
  { language: 'he', label: 'stays an event', text: 'רופא שיניים ביום חמישי בעשר', expect: staysEvent },
  { language: 'ru', label: 'stays an event', text: 'Стоматолог в четверг в 10', expect: staysEvent },
  { language: 'en', label: 'stays an event', text: "Don't forget - parent-teacher meeting next Tuesday at 16:30 in room 204", expect: staysEvent },
  // A finished task creates nothing.
  { language: 'en', label: 'done', text: 'I did it', expect: nothing },
  { language: 'he', label: 'done', text: 'סיימתי', expect: nothing },
  { language: 'ru', label: 'done', text: 'Сделал', expect: nothing },
  // "Stop reminding me" deletes the series.
  { language: 'en', label: 'stop reminding', text: 'Stop reminding me about the vitamins', expect: deletesSeries(/vitamin/i) },
  { language: 'he', label: 'stop reminding', text: 'תפסיק להזכיר לי על הוויטמינים', expect: deletesSeries(/ויטמינ/) },
  { language: 'ru', label: 'stop reminding', text: 'Хватит напоминать про витамины', expect: deletesSeries(/витамин/i) },
  // Moving a reminder sets one time.
  { language: 'en', label: 'move', text: 'Move the plumber reminder to 5pm', expect: movesTo('17:00') },
  { language: 'he', label: 'move', text: 'תזיז את התזכורת של האינסטלטור לחמש בערב', expect: movesTo('17:00') },
  { language: 'ru', label: 'move', text: 'Перенеси напоминание про сантехника на пять вечера', expect: movesTo('17:00') },
  // Two reminders in one message.
  { language: 'en', label: 'two reminders', text: 'Remind me to call mom at 5, and remind Dana to buy bread tomorrow', expect: twoReminders },
];

async function main() {
  const { AI_MODEL, AI_MODEL_ID, getExtractionThinkingLevel } = await import('../src/config/ai-models');
  const { buildEventExtractionPrompt } = await import('../src/services/voice/gemini-voice');
  const { processTextWithGemini } = await import('../src/services/forward-event/gemini-text');

  console.log(`\n=== ${AI_MODEL}, thinking ${getExtractionThinkingLevel(AI_MODEL_ID) ?? 'API default'}, ${CASES.length} cases, ${RUNS} run(s) each`);

  if (process.argv.includes('--dry-run')) {
    for (const language of ['en', 'he', 'ru'] as const) {
      const prompt = buildEventExtractionPrompt(language, CALENDARS, TZ, 'text', undefined, PEOPLE[language]);
      console.log(`  ${language} prompt: ${prompt.length} characters`);
    }
    for (const c of CASES) console.log(`  ${c.language}  ${c.label.padEnd(16)} ${c.text}`);
    // The app modules leave handles open (Redis, Sentry); nothing is pending.
    process.exit(0);
  }
  if (!process.env.GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY is not set. Run with -r dotenv/config.');
    process.exit(2);
  }

  let failures = 0;
  const passedBy: Record<Language, [number, number]> = { en: [0, 0], he: [0, 0], ru: [0, 0] };
  for (const c of CASES) {
    const problems: string[] = [];
    for (let run = 0; run < RUNS; run++) {
      const now = new Date();
      try {
        const { intentResults } = await processTextWithGemini(c.text, c.language, CALENDARS, TZ, PEOPLE[c.language]);
        const problem = c.expect(intentResults, now);
        if (problem) problems.push(problem);
      } catch (err) {
        problems.push(`error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const ok = problems.length === 0;
    if (!ok) failures++;
    passedBy[c.language][0] += ok ? 1 : 0;
    passedBy[c.language][1] += 1;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${c.language}  ${c.label.padEnd(16)} ${c.text}${ok ? '' : `\n          ${problems.join(' | ')}`}`);
  }

  console.log(`\n  by language: ${(['en', 'he', 'ru'] as const).map(l => `${l} ${passedBy[l][0]}/${passedBy[l][1]}`).join(', ')}`);
  console.log(failures === 0 ? '\nALL CASES PASSED' : `\n${failures} case(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
```

**Do not run it without `--dry-run` in this task.** Without the flag it calls Gemini once per case (44 calls). Leaving out `-r dotenv/config` doesn't prevent this: loading the app imports `@prisma/client`, which reads the repo's `.env` itself and sets `GEMINI_API_KEY`. That makes the script's key check pass whenever `.env` exists.

Task 14 runs the eval with exactly this command, from the repo root:

```bash
NODE_OPTIONS='--conditions=import' npx tsx -r dotenv/config scripts/eval-native-reminders.ts
```

Because `@prisma/client` loads the repo `.env`, an unset `GEMINI_API_KEY` in the shell is not a safety gate: the script calls the model whenever `.env` holds a key.

- [ ] **Step 13: Run the tests and checks**

```bash
TZ=UTC npx tsx scripts/smoke-native-reminder-creation.ts
TZ=Asia/Jerusalem npx tsx scripts/smoke-native-reminder-creation.ts
```

Expected: every line `OK`, ending `30/30 passed (process TZ=UTC)` and `30/30 passed (process TZ=Asia/Jerusalem)`, exit 0. tsx's `DEP0205` warning on stderr is harmless.

```bash
TZ=UTC npx tsx scripts/smoke-voice-dates.ts
TZ=Asia/Jerusalem npx tsx scripts/smoke-voice-dates.ts
```

Expected: unchanged. The last line reads `N/N passed`, with N the same count as before this task (66 at `40461c4`; Tasks 1-9 may have added checks), and exit 0.

```bash
NODE_OPTIONS='--conditions=import' npx tsx scripts/eval-native-reminders.ts --dry-run
```

Expected output, with no `[Forward Gemini]` line, which would mean a model call:
- two `[Upstash Redis] … missing` warnings;
- `=== gemini-3.8-flash, thinking MEDIUM, 44 cases, 1 run(s) each`;
- three `xx prompt: ~19200 characters` lines;
- one line per case;
- exit 0.

```bash
npx tsc --noEmit -p .
npm run -s lint
```

Expected: both print nothing and exit 0.

```bash
git status --short
```

Expected: exactly these 7 paths:
- `M src/services/event-parser.ts`
- `M src/services/forward-event/gemini-text.ts`
- `M src/services/forward-event/handler.ts`
- `M src/services/voice/gemini-voice.ts`
- `?? scripts/eval-native-reminders.ts`
- `?? scripts/fixtures/`
- `?? scripts/smoke-native-reminder-creation.ts`

- [ ] **Step 14: Commit**

```bash
git add src/services/event-parser.ts src/services/voice/gemini-voice.ts src/services/forward-event/gemini-text.ts src/services/forward-event/handler.ts scripts/smoke-native-reminder-creation.ts scripts/fixtures/extraction-prompts.json scripts/eval-native-reminders.ts
git commit -m "$(cat <<'EOF'
feat(reminders): extraction recognises reminders in he/en/ru

The voice and text extraction prompts learn reminders when given a
ReminderPromptContext: kind, who it is for (self or partner, by name or
role), a bare-task title, a single start time (date-only, part-of-day,
relative, repeating), an anchor ("an hour before the dentist"), "don't
forget" kept out of DELETE, "I did it" as none, and "stop reminding me"
as delete-all. Without the context the prompt is byte-identical to
before, pinned by scripts/fixtures/extraction-prompts.json; photos never
get the rules.

The parser reads kind/forPerson/anchor only when the rules were sent: a
reminder ends where it starts and a date-only one has no 23:59 end.
Forwarded text now uses extractIntents, so several events in one
message reach the bulk card. scripts/eval-native-reminders.ts is the
live he/en/ru check, run separately.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
EOF
)"
```

---

### Task 11: Creating reminders end to end

A reminder the model extracted becomes a real one here, from Telegram voice, forwarded text and WhatsApp voice. Before any card shows it, each reminder is resolved on the server (spec §3.2): it goes on the creator's main calendar whatever calendar the model picked; it is for the partner only when the partner can be pinged; and "an hour before the dentist" is placed from the calendar. The card, the confirm, auto-create, the bulk card, reply-to-correct and the ⏰ quick fix all carry the resolved fields through to `createEvent`. This task also fixes the bulk-confirm crash (spec §11.1) and escapes titles in the creation messages.

Google users, WhatsApp-only users and every non-reminder event behave exactly as before. Without support (R3) no reminder code runs and the prompt gets no reminder context. An event's provider input and messages are unchanged, except that `<`, `>` and `&` in a title, location or calendar name are now escaped (Telegram rejected them before).

**Files:**
- Create: `src/services/native-reminders/resolve.ts` — the contract's `resolveReminderForCreate`, plus what every create path shares: `resolveReminderIntents` (a message's intents resolved in place, failures out), `refreshReminderNotice`, the anchor helpers, `reminderPromptContext` and `reminderCreateFields`.
- Create: `scripts/smoke-native-reminder-create-flow.ts` — this task's tests (see the note in Step 1).
- Modify: `src/services/event-parser.ts:80` — `ParsedEvent` gains `forUserId`, `forName` and `reminderNotice`, written only by resolution.
- Modify: `src/services/voice/event-resolution.ts:275-316` — `MatchOptions` (with `eligible`, a candidate filter), taken by `findMatchingEvent` and `matchInRange`.
- Modify: `src/services/voice/confirmations.ts:13, 312-314, 332-365` — imports; `formatReminderWhen`, `formatReminderRelativeWhen`, `formatReminderCard`, `reminderCreatedLine`, `formatReminderCreated`, `anchorQuestion`, `sendAnchorQuestions`; the reminder card in `showEventConfirmation`; escaped titles.
- Modify: `src/services/voice/tts-outcome.ts:12-14, 90-91` — `formatReminderOutcomeLine`.
- Modify: `src/services/voice/callbacks.ts:15-25, 98-148` — the card's Create carries the reminder fields, replies with the reminder copy and tracks `native_reminder_created`.
- Modify: `src/services/voice/auto-create.ts:23-25, 103-106, 126-132, 150-156` — the same for auto-create.
- Modify: `src/services/voice/bulk-confirmations.ts:17-19, 43-46, 90-98, 186-190` — Date revival (§11.1), reminder lines, reminder fields.
- Modify: `src/services/voice/quick-correction.ts:43-48, 82-84, 137-138` — the ⏰ fix takes one time for a reminder.
- Modify: `src/services/voice/correction-handler.ts:17-18, 40-55, 161-188` — reply-to-correct keeps the reminder fields and zero length.
- Modify: `src/services/voice/handler.ts:20, 337-345, 376-378, 397-398, 414-423` — the support check, prompt context, resolution and anchor questions.
- Modify: `src/services/forward-event/handler.ts:15, 119-157` — the same for forwarded text, where every reminder is the forwarder's.
- Modify: `src/services/webhook-handlers.ts:27, 291-292, 914-1098, 1139-1162` — the quick fix's `allDay`; WhatsApp voice for users linked to Telegram. The reminder modules load lazily there; only a type import is static.
- Modify: `scripts/smoke-native-reminder-creation.ts` (Task 10's) — stubs for `getReminderSupport` and `sendAnchorQuestions`, which the forwarded-text handler now calls.
- Test: `scripts/smoke-native-reminder-create-flow.ts`. Also rerun, under both clocks, `scripts/smoke-voice-dates.ts`, `smoke-reminders.ts`, `smoke-day-shaping.ts`, `smoke-week-lookahead.ts`, Task 10's `smoke-native-reminder-creation.ts` and the reminder smokes of Tasks 1-9: `smoke-native-reminder-ownership.ts`, `smoke-native-reminder-store.ts`, `smoke-native-reminder-support.ts`, `smoke-native-provider-reminders.ts`, `smoke-partner-labels.ts`, `smoke-native-reminder-digest.ts`, `smoke-native-reminders.ts` and `smoke-native-reminder-buttons.ts`.

Line numbers are from today's `main`. Tasks 4, 9 and 10 shift some of them in `confirmations.ts`, `webhook-handlers.ts`, `event-parser.ts` and `forward-event/handler.ts`. Every Find block below is unique in its file.

**Interfaces:**
- Consumes:
  - Task 1, `src/services/native-reminders/ownership.ts`: `PartnerSummary`, `getActivePartnerSummary(userId: number, pairingId: string | null): Promise<PartnerSummary | null>`. With no `pairingId` it returns null without a query.
  - Task 2, `src/services/native-calendar/event-store.ts`: `getMainNativeCalendar(userId: number): Promise<NativeCalendar>`, `normalizeReminderTimes(startsAt: Date, allDay: boolean, timeZone: string): { startsAt: Date; endsAt: Date }`, and the existing `encodeCalendarId(cuid: string): string`. `createNativeEvent` stores a REMINDER zero-length with `forUserId`. Task 2 also turns `scripts/smoke-reminders.ts`'s partial store fake into a Proxy, because the store and `ownership.ts` import each other.
  - Task 4: `getReminderSupport(user: { id: number; calendarSource: string; telegramId?: bigint | number | string | null }): Promise<ReminderSupport>` (`support.ts`), not cached, so each handler calls it once per message; `escapeHtml(text: string): string` in `src/utils/html.ts`, which `src/services/voice/confirmations.ts` imports and re-exports (the voice modules here import it from `./confirmations`; no non-voice module in this task needs it); the keys `bot.nativeReminders.card.{title,forPartner,noTimeSet,partnerNotOnTelegram,keepAsMine}`, `created.{self,partner,dateOnly}`, `when.{todayAt,tomorrowAt,dateAt,today,tomorrow,date}` (params `{time}` and `{date}`) and `anchor.{notFound,ambiguous,needsTime}`. `getBotMessage` is async.
  - Task 5, `src/services/calendar-provider/types.ts`: `CreateEventInput` has `kind?: 'event' | 'reminder'; forUserId?: number | null`. The native provider maps them to `createNativeEvent`, and Google ignores them.
  - Task 7, `src/utils/event-formatter.ts`: `isReminderEvent(event: Pick<CalendarEvent, 'eventType'>): boolean`.
  - Task 8, `src/services/native-reminders/due.ts`: `dueAtForOccurrence(occ: { startsAt: Date; allDay: boolean; timeZone: string }, recipientTz: string): Date`; date-only means 09:00 in `recipientTz` on the occurrence's date. Task 8 also adds `'native_reminder_created'` to `ActivityAction`.
  - Task 10:
    - `ParsedEvent` has `kind?: 'reminder'` (set only on reminders; an event never carries `kind`, so test `kind === 'reminder'`), `forPerson?: 'self' | 'partner'` and `anchor?: { description: string; offsetMinutes: number }`. An anchored reminder's `startTime`/`endTime` are Invalid Date placeholders. A parsed reminder already has end = start, and a date-only one starts at `startOfLocalDay`.
    - `ReminderPromptContext` is exported from `src/services/voice/gemini-voice.ts`.
    - `processVoiceWithGemini(audioBuffer, language, calendars, timezone, recentEventsBlock?, priorAudioBuffer?, reminders?: ReminderPromptContext)`: `reminders` is the 7th parameter.
    - `processTextWithGemini(text, language, calendars, timezone, reminders?: ReminderPromptContext, source: TextSource = 'forwarded')` resolves to `{ intentResult, intentResults: VoiceIntentResult[], metrics }`. The forwarded handler leaves `source` at its default.
    - The forwarded-text handler takes an array of intents and has a multi-intent branch.
- Produces:

  ```ts
  // src/services/native-reminders/resolve.ts
  export type ResolvedReminder =
    | { ok: true; calendarId: string; forUserId: number | null; startTime: Date; endTime: Date; allDay: boolean;
        notice?: 'partner_not_on_telegram' | 'no_time_set' }
    | { ok: false; error: 'anchor_not_found' | 'anchor_ambiguous' | 'anchor_needs_time' };
  export async function resolveReminderForCreate(user: UserConfig, event: ParsedEvent, timezone: string, now?: Date): Promise<ResolvedReminder>;
  export interface ReminderFailure { error: 'anchor_not_found' | 'anchor_ambiguous' | 'anchor_needs_time'; description: string }
  export async function resolveReminderIntents(
    user: UserConfig, intents: VoiceIntentResult[], timezone: string, options?: { selfOnly?: boolean; now?: Date }
  ): Promise<{ intents: VoiceIntentResult[]; failures: ReminderFailure[] }>;
  //   EVERY create path (voice, forward, typed, WhatsApp) resolves through this; it is the only writer of forName/forUserId/reminderNotice.
  export function refreshReminderNotice(event: ParsedEvent, timezone: string, now?: Date): ParsedEvent;
  export function anchorCandidates(events: CalendarEvent[], now: Date, timezone: string): CalendarEvent[];
  export function reminderTimeFromAnchor(anchorEvent: CalendarEvent, offsetMinutes: number, timezone: string):
    { ok: true; startTime: Date; allDay: boolean } | { ok: false; error: 'anchor_needs_time' };
  export async function reminderPromptContext(user: UserConfig, options?: { withPartner?: boolean }): Promise<ReminderPromptContext>;
  // {} for an event; for a reminder also endTime = startTime. Assignable to the contract's Pick<CreateEventInput, 'kind' | 'forUserId'>.
  export function reminderCreateFields(event: ParsedEvent): Partial<Pick<CreateEventInput, 'kind' | 'forUserId' | 'endTime'>>;

  // src/services/event-parser.ts: ParsedEvent gains (written only by resolveReminderIntents)
  forUserId?: number | null; forName?: string; reminderNotice?: 'partner_not_on_telegram' | 'no_time_set';

  // src/services/voice/confirmations.ts
  // The card and bulk lines: the plain short date and time ("Thu, Oct 15, 10:00"), the date alone when date-only.
  export function formatReminderWhen(event: Pick<ParsedEvent, 'startTime' | 'allDay'>, language: string, timezone: string): string;
  // The created reply only (inside reminderCreatedLine): the when.* copy, "today at 17:00" / "tomorrow" / "on Fri, Oct 16 at 10:00".
  export async function formatReminderRelativeWhen(event: Pick<ParsedEvent, 'startTime' | 'allDay'>, language: string, timezone: string): Promise<string>;
  export async function formatReminderCard(event: ParsedEvent, language: string, timezone: string, markup?: 'html' | 'whatsapp'): Promise<string>;
  export async function reminderCreatedLine(event: ParsedEvent, language: string, timezone: string, html?: boolean): Promise<string>;
  export async function formatReminderCreated(event: ParsedEvent, language: string, timezone: string): Promise<string>;
  export function anchorQuestion(failure: ReminderFailure, language: string, html?: boolean): Promise<string>;
  export async function sendAnchorQuestions(chatId: number | string, failures: ReminderFailure[], language: string, service: IMessagingService): Promise<void>;

  // src/services/voice/tts-outcome.ts
  export async function formatReminderOutcomeLine(event: ParsedEvent, language: string, timezone: string): Promise<string>;

  // src/services/voice/event-resolution.ts (Task 13 adds request? and openReminders? to MatchOptions)
  export interface MatchOptions { eligible?: (events: CalendarEvent[]) => CalendarEvent[] }
  export async function findMatchingEvent(user: UserConfig, calendarIds: string[], reference: EventReference, language: string,
    now?: Date, options: MatchOptions = {}): Promise<MatchResult>;

  // src/services/voice/quick-correction.ts: FieldPatch gains allDay?: boolean
  ```

  Behaviour later tasks rely on:
  - **Rendering:**
    - `showEventConfirmation` renders the reminder card for `event.kind === 'reminder'`. It works the notice out again on every showing, and stores that refreshed event as the pending payload. Its Create button reads `card.keepAsMine` when the partner can't be pinged.
    - `showBulkConfirmation` renders reminder lines, and its confirm creates reminders.
  - **When a reminder fires** is said two ways:
    - `formatReminderWhen` (sync) is the card's `📆` line and the bulk card's lines: "Thu, Oct 15, 10:00" / "יום ה׳, 15 באוק׳, 10:00" / "чт, 15 окт., 10:00", and the date alone for a date-only reminder. It is never relative, so the card never reads "📆 on Thu, Oct 15 at 10:00".
    - `formatReminderRelativeWhen` (async) is the created reply's `{when}` only (`reminderCreatedLine`, so also `formatReminderCreated`, the spoken line and WhatsApp's created line). It uses the `when.*` copy, judged by the user's own day (`timezone`), never the server's. In English it gives "today at 17:00", "tomorrow at 10:00" or "on Fri, Oct 16 at 10:00", and "today", "tomorrow" or "Fri, Oct 16" when date-only. `{date}` is the same short Intl date and `{time}` is HH:mm.
  - **`resolveReminderIntents`:**
    - It replaces a reminder that can't be placed with `{ intent: 'create', confidence, error: <ReminderError> }` and no `event`, and returns it in `failures`.
    - It leaves every non-reminder intent untouched.
    - It resolves only intents whose `event.kind === 'reminder'`. Task 12 must coerce typed creates to `kind: 'reminder'` before calling it, and must not pass `selfOnly`, because typed text is the user's own words.
  - **Task 12's create path:** use `reminderPromptContext(user)` (with the partner), `resolveReminderIntents`, then `showBulkConfirmation` or `showEventConfirmation(chatId, undefined, event, text, user, undefined, 'text')`, and `sendAnchorQuestions`. Typed text never auto-creates.
  - **Task 13** extends `MatchOptions` with `request` and `openReminders` instead of declaring it again. It keeps applying `options.eligible` in `matchInRange`, after merging the open reminders and before collapsing the series. The anchor lookup passes only `{ eligible }`.

- [ ] **Step 1: Write the failing test**

Create `scripts/smoke-native-reminder-create-flow.ts`. It runs the real resolution, card, confirm, auto-create, bulk, correction, quick-fix and handler code. Everything else is faked through `require` and the ES module loader, the way `scripts/smoke-weather-command.ts` does it. That includes Telegram, Redis, Prisma, the AI matcher and Gemini, the calendar provider, the partner lookup, the main-calendar lookup, the support gate and the extraction calls. Partial fakes are Proxies over the real module, because the store and `ownership.ts` import each other (Task 2). The clock is fixed at Wednesday 2026-10-14 10:30 in Israel.

The plan's file table lists this script under Task 11. Task 10's `scripts/smoke-native-reminder-creation.ts` keeps its extraction checks only, and Task 12 ships `smoke-native-reminder-typed.ts`. Separate scripts keep each one's module fakes from colliding. Task 14 runs it with the others.

```ts
// Smoke test for creating native reminders end to end (spec §3.2-3.3): resolution (the
// creator's main calendar whatever the model picked, the partner as target only when
// they can be pinged, "an hour before the dentist" placed from the calendar, the no-time
// note after 09:00), the card's plain date and the created reply's "today at 17:00" /
// "tomorrow" / "on Fri, Oct 16 at 10:00" in three languages, the card, the confirm,
// auto-create, the bulk card (whose confirm threw after the first create: Redis hands
// its times back as strings), reply-to-correct and the quick time fix, and the voice
// and forwarded-text handlers that wire them.
// Events and Google users must come out as before.
//
// Telegram, Redis, Prisma, the AI, the calendar provider and the partner lookup are
// faked; the clock is set by hand. No network.
//
// Run under both clocks; the output must not depend on the server's timezone:
//   TZ=UTC npx tsx scripts/smoke-native-reminder-create-flow.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-native-reminder-create-flow.ts

import Module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromZonedTime } from 'date-fns-tz';
import type { CalendarAssignment, CalendarEvent, UserConfig } from '../src/types';
import type { ParsedEvent, VoiceIntentResult } from '../src/services/event-parser';
import type { PartnerSummary } from '../src/services/native-reminders/ownership';

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

async function check(name: string, fn: () => void | Promise<void>) {
  reset();
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
}

function assert(cond: boolean, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

// ---- Clock: every argument-less new Date() and Date.now() reads `clock` ----

let clock = 0;
const RealDate = Date;
class ClockDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(clock);
    else super(...(args as [number, number, number, number, number, number, number]));
  }
  static now() {
    return clock;
  }
}
globalThis.Date = ClockDate as unknown as DateConstructor;

const IL = 'Asia/Jerusalem';
const NY = 'America/New_York';
const at = (local: string, tz = IL) => fromZonedTime(local, tz);

// ---- Fakes ----

/** Redis as Upstash behaves: values round-trip through JSON, so Dates come back as strings. */
const store = new Map<string, string>();
const fakeRedis = {
  get: async (key: string) => (store.has(key) ? JSON.parse(store.get(key)!) : null),
  set: async (key: string, value: unknown) => {
    store.set(key, JSON.stringify(value));
    return 'OK';
  },
  exists: async (key: string) => (store.has(key) ? 1 : 0),
  del: async (key: string) => (store.delete(key) ? 1 : 0),
};

/** What Telegram was asked to send or edit. */
type Sent = { method: string; chatId?: number | string; text: string; opts?: Record<string, unknown> };
let botCalls: Sent[] = [];
const fakeBot = {
  sendMessage: async (chatId: number, text: string, opts?: Record<string, unknown>) => {
    botCalls.push({ method: 'sendMessage', chatId, text, opts });
    return { message_id: 700 + botCalls.length };
  },
  editMessageText: async (text: string, opts?: Record<string, unknown>) => {
    botCalls.push({ method: 'editMessageText', text, opts });
    return true;
  },
  answerCallbackQuery: async () => true,
};
let serviceCalls: Sent[] = [];
const fakeService = {
  sendMessage: async (chatId: number | string, text: string, opts?: Record<string, unknown>) => {
    serviceCalls.push({ method: 'sendMessage', chatId, text, opts });
    return { messageId: String(900 + serviceCalls.length) };
  },
  sendTypingIndicator: async () => {},
  sendVoice: async () => {},
};

const tracked: Array<{ userId: number; action: string; metadata?: Record<string, unknown> }> = [];
const flags = { autoCreate: false };
let support: { supported: boolean; reason?: string } = { supported: true };

const raziel: PartnerSummary = {
  id: 2, name: 'Raziel', englishName: 'Raziel', gender: 'male', calendarSource: 'NATIVE', telegramId: BigInt(1002), language: 'he',
};
let partner: PartnerSummary | null = raziel;
let partnerLookups = 0;
async function fakePartnerLookup(_userId: number, pairingId: string | null) {
  partnerLookups++;
  return pairingId ? partner : null;
}

const TIMEZONES: Record<number, string> = { 1: IL, 3: NY };
const CALENDARS: CalendarAssignment[] = [
  { calendarId: 'native:main-1', labels: ['primary', 'yours'], name: 'Dana', color: '#000000' },
  { calendarId: 'native:raziel-cal', labels: ['spouse'], name: 'Raziel', color: '#111111' },
];
const dana = {
  id: 1, name: 'Dana', englishName: 'Dana', language: 'en', telegramId: 1001, calendarSource: 'NATIVE',
  pairingId: 'pair-1', isAdmin: false, voiceInputEnabled: true, googleRefreshToken: '',
  // Two calendars, so an event card offers 📁 Cal and a reminder card must not
  calendarAssignments: CALENDARS,
} as unknown as UserConfig;
const nyUser = { ...dana, id: 3, pairingId: null } as unknown as UserConfig;
let currentUser: UserConfig = dana;

/** The events the provider holds in any range, and what it was asked to create. */
let rangeEvents: CalendarEvent[] = [];
let created: Array<{ calendarId: string; input: Record<string, unknown> }> = [];
const fakeProvider = {
  fetchEventsInRange: async () => rangeEvents,
  createEvent: async (_user: unknown, calendarId: string, input: Record<string, unknown>) => {
    created.push({ calendarId, input });
    return { success: true, eventId: `ev${created.length}` };
  },
  deleteEvent: async () => ({ success: true }),
};

/**
 * The AI matcher: the listed events whose title holds the user's description; one is a
 * match, two are "multiple". Every prompt is kept.
 */
let matcherPrompts: string[] = [];
async function fakeMatcher(prompt: string) {
  matcherPrompts.push(prompt);
  const description = (/User's description: "(.*)"/.exec(prompt)?.[1] ?? '').toLowerCase().replace(/^the /, '');
  const listed = prompt.split('Available events:\n')[1].split('\n\n')[0].split('\n');
  const hits = listed.flatMap((line, i) => (line.toLowerCase().includes(description) ? [i + 1] : []));
  const answer = hits.length === 0 ? { match: 'none' } : hits.length === 1 ? { match: 'single', eventIndex: hits[0] } : { match: 'multiple', matchedIndexes: hits };
  return { text: JSON.stringify(answer) };
}
/** Gemini for reply-to-correct and the quick fix: answers `geminiText`, keeps each prompt. */
let geminiText = '{}';
let geminiPrompts: string[] = [];
const fakeGemini = {
  models: {
    generateContent: async ({ contents }: { contents: Array<{ parts: Array<{ text?: string }> }> }) => {
      geminiPrompts.push(contents[0].parts.map(p => p.text ?? '').join(''));
      return { text: geminiText, usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } };
    },
  },
};

/** The voice and forwarded-text extraction: answers the set intents, keeps the arguments. */
let extracted: VoiceIntentResult[] = [];
let voiceCalls: unknown[][] = [];
async function fakeVoiceExtraction(...args: unknown[]) {
  voiceCalls.push(args);
  return {
    intentResult: extracted[0], intentResults: extracted, transcription: 'remind Raziel to call the plumber',
    metrics: { model: 'fake', inputTokens: 0, outputTokens: 0, durationMs: 0 },
  };
}
let textCalls: unknown[][] = [];
async function fakeTextExtraction(...args: unknown[]) {
  textCalls.push(args);
  return { intentResult: extracted[0], intentResults: extracted, metrics: { model: 'fake', inputTokens: 0, outputTokens: 0, durationMs: 0 } };
}

function reset() {
  clock = at('2026-10-14 10:30').getTime(); // Wednesday morning in Israel
  store.clear();
  botCalls = [];
  serviceCalls = [];
  tracked.length = 0;
  created = [];
  rangeEvents = [];
  matcherPrompts = [];
  geminiPrompts = [];
  geminiText = '{}';
  extracted = [];
  voiceCalls = [];
  textCalls = [];
  flags.autoCreate = false;
  support = { supported: true };
  partner = raziel;
  partnerLookups = 0;
  currentUser = dana;
}

// ---- Module fakes ----

const SRC = path.resolve(__dirname, '../src');

/** Part of a module faked, the rest read through to the real one (a proxy: the store and ownership import each other). */
const fakeOver = (real: Record<string, unknown>, fakes: Record<string, unknown>) =>
  new Proxy(real, { get: (target, key) => (typeof key === 'string' && key in fakes ? fakes[key] : Reflect.get(target, key)) });

/** Modules replaced by fakes, by package name or file path; a function fakes part of the real module. */
const stubs: Record<string, object | ((real: Record<string, unknown>) => object)> = {
  '@googleapis/calendar': { calendar: () => ({}), auth: { OAuth2: class {} } },
  [`${SRC}/utils/redis.ts`]: { redis: fakeRedis },
  [`${SRC}/utils/prisma.ts`]: { prisma: {}, withRetry: (fn: () => unknown) => fn() },
  [`${SRC}/lib/error-capture.ts`]: { captureError: () => {}, captureWarning: () => {}, captureInfo: () => {} },
  [`${SRC}/lib/timezone.ts`]: { resolveUserTimezone: async (u: { id: number }) => TIMEZONES[u.id] ?? IL },
  [`${SRC}/services/ai-provider.ts`]: { generateAICompletion: fakeMatcher, getGemini: () => fakeGemini, extractionConfig: () => ({}) },
  [`${SRC}/services/telegram/index.ts`]: { getBot: () => fakeBot, getMessagingService: () => fakeService },
  [`${SRC}/services/telegram/bot.ts`]: { getBot: () => fakeBot, getMessagingService: () => fakeService },
  [`${SRC}/services/analytics-service.ts`]: {
    trackActivityAsync: (userId: number, action: string, metadata?: Record<string, unknown>) => tracked.push({ userId, action, metadata }),
    addBreadcrumb: () => {},
    setUserContext: () => {},
  },
  [`${SRC}/services/subscription-service.ts`]: { checkFeatureAccess: async () => ({ allowed: true }), incrementUsage: async () => {} },
  [`${SRC}/services/user-service.ts`]: { getUserByTelegramId: async () => currentUser },
  [`${SRC}/services/reminder-cache.ts`]: { getVoiceAutoCreateHighConf: async () => flags.autoCreate, getVoiceTtsOutcome: async () => false },
  [`${SRC}/services/voice/recent-events-store.ts`]: {
    pushRecentEvent: async () => {}, removeRecentEvent: async () => {}, getRecentEvents: async () => [], formatRecentEventsBlock: () => '',
  },
  [`${SRC}/services/voice/audio-retry.ts`]: {
    isInRetryMode: async () => false, readRetryAudio: async () => null, clearRetryMode: async () => {}, stashFailedAudio: async () => {},
  },
  [`${SRC}/services/native-reminders/support.ts`]: { getReminderSupport: async () => support },
  [`${SRC}/services/calendar-provider/index.ts`]: {
    getProviderForUser: () => fakeProvider, hasUsableCalendar: async () => true, getCalendarAssignmentsForUser: async () => CALENDARS,
  },
  [`${SRC}/services/forward-event/gemini-text.ts`]: { processTextWithGemini: fakeTextExtraction },
  [`${SRC}/services/native-calendar/event-store.ts`]: real => fakeOver(real, { getMainNativeCalendar: async (userId: number) => ({ id: `main-${userId}` }) }),
  [`${SRC}/services/native-reminders/ownership.ts`]: real => fakeOver(real, { getActivePartnerSummary: fakePartnerLookup }),
  [`${SRC}/services/voice/gemini-voice.ts`]: real => fakeOver(real, { processVoiceWithGemini: fakeVoiceExtraction }),
  [`${SRC}/services/voice/event-resolution.ts`]: real => fakeOver(real, { downloadVoiceFile: async () => Buffer.from('OggS') }),
};

const ModuleInternals = Module as unknown as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  _resolveFilename: (request: string, parent: unknown, isMain: boolean) => string;
};
const resolveFilename = ModuleInternals._resolveFilename;
ModuleInternals._resolveFilename = function (request, parent, isMain) {
  if (request === '@hebcal/core') return path.resolve(__dirname, '../node_modules/@hebcal/core/dist/esm/index.js');
  return resolveFilename.call(this, request, parent, isMain);
};

/** A partial fake is built once from the real module, then served to require() and import() alike. */
const built = new Map<string, object>();
const loadingReal = new Set<string>();
function fakeFor(file: string, loadReal: () => unknown): object {
  const stub = stubs[file];
  if (typeof stub !== 'function') return stub;
  if (!built.has(file)) {
    loadingReal.add(file);
    try {
      built.set(file, stub(loadReal() as Record<string, unknown>));
    } finally {
      loadingReal.delete(file);
    }
  }
  return built.get(file)!;
}

// Static imports compile to require() and pass through Module._load.
const realLoad = ModuleInternals._load;
ModuleInternals._load = function (request, parent, isMain) {
  let resolved = request;
  try {
    resolved = ModuleInternals._resolveFilename(request, parent, isMain);
  } catch {}
  const key = request in stubs ? request : resolved;
  if (!(key in stubs) || loadingReal.has(key)) return realLoad.call(this, request, parent, isMain);
  return fakeFor(key, () => realLoad.call(this, request, parent, isMain));
};

// The handlers load some modules with import(), which goes through the ES module loader
// instead; it gets the same fake, served as an ES module.
(globalThis as { reminderSmokeFake?: (file: string) => object }).reminderSmokeFake = file =>
  fakeFor(file, () => realLoad.call(Module, file, null, false));
Module.registerHooks({
  load(url, context, nextLoad) {
    const file = url.startsWith('file:') ? fileURLToPath(url.split('?')[0]) : '';
    if (!(file in stubs) || loadingReal.has(file)) return nextLoad(url, context);
    const fake = (globalThis as unknown as { reminderSmokeFake: (file: string) => object }).reminderSmokeFake(file);
    const names = Object.keys(fake).map(name => `export const ${name} = fake.${name};`).join('\n');
    return { format: 'module', shortCircuit: true, source: `const fake = globalThis.reminderSmokeFake(${JSON.stringify(file)});\n${names}\n` };
  },
});

// ---- Fixtures ----

/** A reminder as the parser hands it over: the model picked the partner's calendar, as it does for "remind Raziel". */
const parsedReminder = (over: Partial<ParsedEvent> = {}): ParsedEvent => ({
  title: 'Call the plumber',
  startTime: at('2026-10-15 10:00'),
  endTime: at('2026-10-15 10:00'),
  allDay: false,
  calendarId: 'native:raziel-cal',
  calendarName: 'Raziel',
  confidence: 'high',
  kind: 'reminder',
  forPerson: 'self',
  ...over,
});
const dateOnly = (day: string, tz = IL) => ({ allDay: true, startTime: fromZonedTime(`${day} 00:00`, tz), endTime: fromZonedTime(`${day} 00:00`, tz) });
const anchored = (description: string, offsetMinutes: number) =>
  parsedReminder({ anchor: { description, offsetMinutes }, startTime: new Date(NaN), endTime: new Date(NaN) });
const createIntent = (event: ParsedEvent, confidence: 'high' | 'medium' | 'low' = 'medium'): VoiceIntentResult =>
  ({ intent: 'create', confidence, event });
const calendarEvent = (summary: string, start: string, end: string, extra: Partial<CalendarEvent> = {}): CalendarEvent =>
  ({ summary, start, end, calendarName: 'Dana', calendarId: 'native:main-1', ...extra });
const iso = (local: string) => at(local).toISOString();

const sameInstant = (a: unknown, b: Date) => a instanceof RealDate && a.getTime() === b.getTime();
const lastBot = () => botCalls[botCalls.length - 1];
const buttonsOf = (call: Sent) =>
  ((call.opts?.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }).inline_keyboard);
const pendingIdOf = (call: Sent, prefix: string) =>
  buttonsOf(call).flat().find(b => b.callback_data.startsWith(prefix))!.callback_data.slice(prefix.length);

async function main() {
  const { getBotMessage, getBotMessages } = await import('../src/lib/bot-messages');
  const resolve = await import('../src/services/native-reminders/resolve');
  const { resolveReminderForCreate, resolveReminderIntents, reminderCreateFields, anchorCandidates } = resolve;
  const confirmations = await import('../src/services/voice/confirmations');
  const { showEventConfirmation, formatEventDateTime, formatReminderWhen, formatReminderRelativeWhen, reminderCreatedLine } = confirmations;
  const { handleEventCallback } = await import('../src/services/voice/callbacks');
  const { autoCreateEvent } = await import('../src/services/voice/auto-create');
  const { showBulkConfirmation, handleBulkConfirmAll } = await import('../src/services/voice/bulk-confirmations');
  const { handleEventCorrection } = await import('../src/services/voice/correction-handler');
  const { extractFieldPatch } = await import('../src/services/voice/quick-correction');
  const { formatReminderOutcomeLine } = await import('../src/services/voice/tts-outcome');
  const { handleVoiceMessage } = await import('../src/services/voice/handler');
  const { handleForwardedMessage } = await import('../src/services/forward-event/handler');
  const t = await getBotMessages('en');

  /** A reminder resolved as the handlers resolve it, for the tests of what comes after. */
  const resolved = async (event: ParsedEvent) => {
    const { intents } = await resolveReminderIntents(dana, [createIntent(event)], IL);
    assert(!!intents[0].event, `not resolved: ${JSON.stringify(intents[0])}`);
    return intents[0].event;
  };
  const voice = { file_id: 'f1', file_unique_id: 'u1', duration: 4 };
  const from = { id: 1001, first_name: 'Dana' };

  // ---- resolveReminderForCreate: calendar and target ----

  await check('resolve: "remind me" goes on the creator\'s main calendar, not the one the model picked, with no length', async () => {
    const r = await resolveReminderForCreate(dana, parsedReminder(), IL);
    assert(r.ok, JSON.stringify(r));
    assert(r.calendarId === 'native:main-1', `calendar ${r.calendarId}`);
    assert(r.forUserId === null && r.notice === undefined, `target ${r.forUserId} notice ${r.notice}`);
    assert(sameInstant(r.startTime, at('2026-10-15 10:00')) && sameInstant(r.endTime, at('2026-10-15 10:00')), `times ${r.startTime.toISOString()} ${r.endTime.toISOString()}`);
    assert(partnerLookups === 0, 'looked the partner up for a self reminder');
  });

  await check('resolve: "remind Raziel" is the partner\'s when they are on the built-in calendar and Telegram', async () => {
    const r = await resolveReminderForCreate(dana, parsedReminder({ forPerson: 'partner' }), IL);
    assert(r.ok && r.forUserId === 2 && r.notice === undefined, JSON.stringify(r));
  });

  await check('resolve: a partner who isn\'t on Telegram leaves it the creator\'s, with a notice', async () => {
    partner = { ...raziel, telegramId: null };
    const r = await resolveReminderForCreate(dana, parsedReminder({ forPerson: 'partner' }), IL);
    assert(r.ok && r.forUserId === null && r.notice === 'partner_not_on_telegram', JSON.stringify(r));
  });

  await check('resolve: a partner on Google, or no partner, leaves it the creator\'s with no notice', async () => {
    partner = { ...raziel, calendarSource: 'GOOGLE' };
    const google = await resolveReminderForCreate(dana, parsedReminder({ forPerson: 'partner' }), IL);
    assert(google.ok && google.forUserId === null && google.notice === undefined, `google ${JSON.stringify(google)}`);
    partner = null;
    const unpaired = await resolveReminderForCreate(dana, parsedReminder({ forPerson: 'partner' }), IL);
    assert(unpaired.ok && unpaired.forUserId === null && unpaired.notice === undefined, `unpaired ${JSON.stringify(unpaired)}`);
  });

  // ---- resolveReminderForCreate: the no-time note ----

  await check('resolve: a date-only reminder for today notes "no time set" only after 09:00', async () => {
    const today = parsedReminder(dateOnly('2026-10-14'));
    const before = await resolveReminderForCreate(dana, today, IL, at('2026-10-14 08:59'));
    assert(before.ok && before.notice === undefined, `08:59: ${JSON.stringify(before)}`);
    const after = await resolveReminderForCreate(dana, today, IL, at('2026-10-14 09:30'));
    assert(after.ok && after.notice === 'no_time_set', `09:30: ${JSON.stringify(after)}`);
    assert(after.allDay && sameInstant(after.startTime, at('2026-10-14 00:00')) && sameInstant(after.endTime, after.startTime), `times ${after.startTime.toISOString()} ${after.endTime.toISOString()}`);
    const tomorrow = await resolveReminderForCreate(dana, parsedReminder(dateOnly('2026-10-15')), IL, at('2026-10-14 09:30'));
    assert(tomorrow.ok && tomorrow.notice === undefined, `tomorrow: ${JSON.stringify(tomorrow)}`);
  });

  await check('resolve: "after 09:00" is the creator\'s own 09:00 (New York), not Israel\'s', async () => {
    const today = parsedReminder(dateOnly('2026-10-14', NY));
    // 08:30 in New York is 15:30 in Israel
    const before = await resolveReminderForCreate(nyUser, today, NY, at('2026-10-14 08:30', NY));
    assert(before.ok && before.notice === undefined, `08:30 NY: ${JSON.stringify(before)}`);
    const after = await resolveReminderForCreate(nyUser, today, NY, at('2026-10-14 09:30', NY));
    assert(after.ok && after.notice === 'no_time_set', `09:30 NY: ${JSON.stringify(after)}`);
  });

  // ---- resolveReminderForCreate: anchors ----

  await check('anchor: "an hour before the dentist" is the dentist\'s start minus an hour', async () => {
    rangeEvents = [calendarEvent('Dentist', iso('2026-10-15 10:00'), iso('2026-10-15 11:00'))];
    const r = await resolveReminderForCreate(dana, anchored('the dentist', -60), IL);
    assert(r.ok && !r.allDay && sameInstant(r.startTime, at('2026-10-15 09:00')) && sameInstant(r.endTime, at('2026-10-15 09:00')), JSON.stringify(r));
  });

  await check('anchor: reminders and events already started are never the anchor', async () => {
    rangeEvents = [
      calendarEvent('Dentist', iso('2026-10-12 10:00'), iso('2026-10-12 11:00')),
      calendarEvent('Dentist', iso('2026-10-15 08:00'), iso('2026-10-15 08:00'), { eventType: 'reminder' }),
      calendarEvent('Dentist', iso('2026-10-16 10:00'), iso('2026-10-16 11:00')),
    ];
    const r = await resolveReminderForCreate(dana, anchored('the dentist', -60), IL);
    assert(r.ok && sameInstant(r.startTime, at('2026-10-16 09:00')), JSON.stringify(r));
    const listed = matcherPrompts[0].split('Available events:\n')[1].split('\n\n')[0].split('\n');
    assert(listed.length === 1 && listed[0].includes('Friday 2026-10-16'), `matcher saw ${JSON.stringify(listed)}`);
  });

  await check('anchor: a repeating event counts once, at its next occurrence', async () => {
    rangeEvents = [
      calendarEvent('Piano', iso('2026-10-22 16:00'), iso('2026-10-22 17:00'), { recurringEventId: 'piano' }),
      calendarEvent('Piano', iso('2026-10-15 16:00'), iso('2026-10-15 17:00'), { recurringEventId: 'piano' }),
    ];
    const r = await resolveReminderForCreate(dana, anchored('piano', -30), IL);
    assert(r.ok && sameInstant(r.startTime, at('2026-10-15 15:30')), JSON.stringify(r));
    const kept = anchorCandidates(rangeEvents, new RealDate(clock), IL);
    assert(kept.length === 1 && kept[0].start === iso('2026-10-15 16:00'), `candidates ${JSON.stringify(kept)}`);
  });

  await check('anchor: two different matching events ask which one; none asks for a time', async () => {
    rangeEvents = [
      calendarEvent('Dentist', iso('2026-10-15 10:00'), iso('2026-10-15 11:00')),
      calendarEvent('Dentist', iso('2026-10-19 10:00'), iso('2026-10-19 11:00')),
    ];
    const two = await resolveReminderForCreate(dana, anchored('the dentist', -60), IL);
    assert(!two.ok && two.error === 'anchor_ambiguous', JSON.stringify(two));
    rangeEvents = [calendarEvent('Gym', iso('2026-10-15 07:00'), iso('2026-10-15 08:00'))];
    const none = await resolveReminderForCreate(dana, anchored('the dentist', -60), IL);
    assert(!none.ok && none.error === 'anchor_not_found', JSON.stringify(none));
  });

  await check('anchor: an all-day event takes a whole-day offset (date-only) but asks about an hour one', async () => {
    rangeEvents = [calendarEvent('Noa\'s birthday', '2026-10-18', '2026-10-19')];
    const dayBefore = await resolveReminderForCreate(dana, anchored('birthday', -1440), IL);
    assert(dayBefore.ok && dayBefore.allDay && sameInstant(dayBefore.startTime, at('2026-10-17 00:00')), JSON.stringify(dayBefore));
    const hourBefore = await resolveReminderForCreate(dana, anchored('birthday', -60), IL);
    assert(!hourBefore.ok && hourBefore.error === 'anchor_needs_time', JSON.stringify(hourBefore));
  });

  // ---- resolveReminderIntents ----

  await check('intents: reminders are resolved in place, events and edits untouched, the partner looked up once', async () => {
    const event = parsedReminder({ kind: undefined, title: 'Dinner', forPerson: undefined });
    const edit: VoiceIntentResult = { intent: 'edit', confidence: 'high', eventReference: { type: 'last_created' } };
    const { intents, failures } = await resolveReminderIntents(dana, [
      createIntent(event),
      createIntent(parsedReminder({ forPerson: 'partner' })),
      createIntent(parsedReminder({ forPerson: 'partner', title: 'Buy milk', ...dateOnly('2026-10-16') })),
      createIntent(anchored('the dentist', -60)),
      edit,
    ], IL);
    assert(intents[0].event === event && intents[4] === edit, 'an event or an edit was changed');
    const r = intents[1].event!;
    assert(r.calendarId === 'native:main-1' && r.forUserId === 2 && r.forName === 'Raziel' && r.anchor === undefined, JSON.stringify(r));
    assert(intents[2].event!.allDay && intents[2].event!.forUserId === 2, JSON.stringify(intents[2]));
    assert(!intents[3].event && intents[3].error === 'anchor_not_found', JSON.stringify(intents[3]));
    assert(JSON.stringify(failures) === '[{"error":"anchor_not_found","description":"the dentist"}]', JSON.stringify(failures));
    assert(partnerLookups === 1, `${partnerLookups} partner lookups`);
  });

  await check('intents: forwarded text (selfOnly) keeps every reminder the forwarder\'s', async () => {
    const { intents } = await resolveReminderIntents(dana, [createIntent(parsedReminder({ forPerson: 'partner' }))], IL, { selfOnly: true });
    const r = intents[0].event!;
    assert(r.forPerson === 'self' && r.forUserId === null && r.forName === undefined, JSON.stringify(r));
    assert(partnerLookups === 0, `${partnerLookups} partner lookups`);
  });

  await check('create fields: nothing for an event; kind, target and a zero length for a reminder', async () => {
    assert(JSON.stringify(reminderCreateFields(parsedReminder({ kind: undefined }))) === '{}', 'an event (no kind) got fields');
    const fields = reminderCreateFields({ ...parsedReminder(), endTime: at('2026-10-15 11:00'), forUserId: 2 });
    assert(fields.kind === 'reminder' && fields.forUserId === 2 && sameInstant(fields.endTime, at('2026-10-15 10:00')), JSON.stringify(fields));
  });

  // ---- When it fires: the plain date on the card, today/tomorrow in the created reply ----

  await check('when, card: the short date and time in English, Hebrew and Russian, even for today', async () => {
    const plain = [
      { event: { startTime: at('2026-10-15 10:00'), allDay: false }, want: { en: 'Thu, Oct 15, 10:00', he: 'יום ה׳, 15 באוק׳, 10:00', ru: 'чт, 15 окт., 10:00' } },
      { event: { startTime: at('2026-10-14 17:00'), allDay: false }, want: { en: 'Wed, Oct 14, 17:00', he: 'יום ד׳, 14 באוק׳, 17:00', ru: 'ср, 14 окт., 17:00' } },
      { event: dateOnly('2026-10-16'), want: { en: 'Fri, Oct 16', he: 'יום ו׳, 16 באוק׳', ru: 'пт, 16 окт.' } },
    ];
    for (const { event, want } of plain) {
      for (const language of ['en', 'he', 'ru'] as const) {
        const got = formatReminderWhen(event, language, IL);
        assert(got === want[language], `${language} ${event.startTime.toISOString()}: ${got}`);
      }
    }
  });

  await check('when, created reply: today, tomorrow or the date, timed and date-only, in English, Hebrew and Russian', async () => {
    // Wednesday 10:30 in Israel
    const relative = [
      { event: { startTime: at('2026-10-14 17:00'), allDay: false }, want: { en: 'today at 17:00', he: 'היום ב-17:00', ru: 'сегодня в 17:00' } },
      { event: { startTime: at('2026-10-15 10:00'), allDay: false }, want: { en: 'tomorrow at 10:00', he: 'מחר ב-10:00', ru: 'завтра в 10:00' } },
      { event: { startTime: at('2026-10-16 10:00'), allDay: false }, want: { en: 'on Fri, Oct 16 at 10:00', he: 'ביום ו׳, 16 באוק׳, ב-10:00', ru: 'пт, 16 окт. в 10:00' } },
      { event: dateOnly('2026-10-14'), want: { en: 'today', he: 'היום', ru: 'сегодня' } },
      { event: dateOnly('2026-10-15'), want: { en: 'tomorrow', he: 'מחר', ru: 'завтра' } },
      { event: dateOnly('2026-10-16'), want: { en: 'Fri, Oct 16', he: 'יום ו׳, 16 באוק׳', ru: 'пт, 16 окт.' } },
    ];
    for (const { event, want } of relative) {
      for (const language of ['en', 'he', 'ru'] as const) {
        const got = await formatReminderRelativeWhen(event, language, IL);
        assert(got === want[language], `${language} ${event.allDay ? 'date-only ' : ''}${event.startTime.toISOString()}: ${got}`);
      }
    }
  });

  await check('when, created reply: "today" and "tomorrow" are the user\'s own days, not the server\'s', async () => {
    clock = at('2026-10-14 23:30').getTime(); // 20:30 UTC, 16:30 in New York
    const pastMidnight = await formatReminderRelativeWhen({ startTime: at('2026-10-15 00:30'), allDay: false }, 'en', IL);
    assert(pastMidnight === 'tomorrow at 00:30', `Israel: ${pastMidnight}`);
    // 20:00 in New York is already 03:00 on Thursday in Israel
    const evening = await formatReminderRelativeWhen({ startTime: at('2026-10-14 20:00', NY), allDay: false }, 'en', NY);
    assert(evening === 'today at 20:00', `New York: ${evening}`);
    const thursday = await formatReminderRelativeWhen(dateOnly('2026-10-15', NY), 'en', NY);
    assert(thursday === 'tomorrow', `New York, date-only: ${thursday}`);
  });

  // ---- The card ----

  await check('card: a timed reminder for the partner, with no end time and no 📁 Cal button', async () => {
    const event = await resolved(parsedReminder({ forPerson: 'partner' }));
    await showEventConfirmation(555, undefined, event, 'remind Raziel to call the plumber', dana);
    const card = lastBot();
    assert(card.text.startsWith('⏰ <b>Call the plumber</b>\n📆 Thu, Oct 15, 10:00 · for Raziel\n\n'), card.text);
    assert(!card.text.includes(' - ') && !card.text.includes('📁') && !card.text.includes(t.voice.confirmTitle), card.text);
    const buttons = buttonsOf(card);
    assert(buttons[0][0].text === t.voice.createButton, `create button ${buttons[0][0].text}`);
    assert(!buttons.flat().some(b => b.callback_data.startsWith('event_fix:cal:')), 'offers 📁 Cal');
    const pending = await fakeRedis.get(`voice:pending:event:${pendingIdOf(card, 'event_create:')}`);
    assert(pending?.event?.kind === 'reminder' && pending.event.forUserId === 2, `pending ${JSON.stringify(pending?.event)}`);
  });

  await check('card: a date-only reminder for today after 09:00 says it has no time', async () => {
    const event = await resolved(parsedReminder(dateOnly('2026-10-14')));
    await showEventConfirmation(555, undefined, event, 'remind me to call the plumber today', dana);
    const noTime = await getBotMessage('en', 'nativeReminders.card.noTimeSet');
    assert(lastBot().text.startsWith(`⏰ <b>Call the plumber</b>\n📆 Wed, Oct 14\n\n<i>${noTime}</i>`), lastBot().text);
  });

  await check('card: a partner who isn\'t on Telegram gets "keep as mine" on the button', async () => {
    partner = { ...raziel, telegramId: null };
    const event = await resolved(parsedReminder({ forPerson: 'partner' }));
    await showEventConfirmation(555, undefined, event, 'remind Raziel to call the plumber', dana);
    const notice = await getBotMessage('en', 'nativeReminders.card.partnerNotOnTelegram', { name: 'Raziel' });
    assert(lastBot().text.includes(`<i>${notice}</i>`) && !lastBot().text.includes('for Raziel'), lastBot().text);
    assert(buttonsOf(lastBot())[0][0].text === t.nativeReminders.card.keepAsMine, `button ${buttonsOf(lastBot())[0][0].text}`);
  });

  await check('card: titles with <, > and & are escaped, Hebrew too', async () => {
    const he = { ...dana, language: 'he' } as UserConfig;
    const event = await resolved(parsedReminder({ title: 'לקנות <חלב> & ביצים' }));
    await showEventConfirmation(555, undefined, event, 'x', he);
    assert(lastBot().text.includes('<b>לקנות &lt;חלב&gt; &amp; ביצים</b>') && !lastBot().text.includes('<חלב>'), lastBot().text);
  });

  await check('card: an event\'s card is as before, its title now escaped', async () => {
    const event: ParsedEvent = { title: 'Dentist', startTime: at('2026-10-15 10:00'), endTime: at('2026-10-15 11:00'), allDay: false, calendarId: 'native:main-1', calendarName: 'Dana', confidence: 'high' };
    await showEventConfirmation(555, undefined, event, 'dentist', dana);
    const when = formatEventDateTime(event, 'en', t.voice.allDay, IL);
    assert(lastBot().text === `${t.voice.confirmTitle}\n\n<b>Dentist</b>\n${when}\n📁 Dana\n\n<i>${t.voice.from} "dentist"</i>`, lastBot().text);
    assert(buttonsOf(lastBot()).flat().some(b => b.callback_data.startsWith('event_fix:cal:')), 'lost 📁 Cal');
    await showEventConfirmation(555, undefined, { ...event, title: 'R&D <sync>' }, 'x', dana);
    assert(lastBot().text.includes('<b>R&amp;D &lt;sync&gt;</b>'), lastBot().text);
  });

  await check('card: a date-only reminder given a time loses the no-time note when shown again', async () => {
    const event = await resolved(parsedReminder(dateOnly('2026-10-14')));
    assert(event.reminderNotice === 'no_time_set', `notice ${event.reminderNotice}`);
    const fixed = { ...event, allDay: false, startTime: at('2026-10-14 17:00'), endTime: at('2026-10-14 17:00') };
    await showEventConfirmation(555, undefined, fixed, 'x', dana);
    const noTime = await getBotMessage('en', 'nativeReminders.card.noTimeSet');
    assert(lastBot().text.startsWith('⏰ <b>Call the plumber</b>\n📆 Wed, Oct 14, 17:00\n\n') && !lastBot().text.includes(noTime), lastBot().text);
    const pending = await fakeRedis.get(`voice:pending:event:${pendingIdOf(lastBot(), 'event_create:')}`);
    assert(pending.event.reminderNotice === undefined, `pending notice ${pending.event.reminderNotice}`);
  });

  // ---- Confirm, auto-create, replies ----

  await check('confirm: creates a reminder for the partner on the main calendar and says so', async () => {
    const event = await resolved(parsedReminder({ forPerson: 'partner' }));
    await showEventConfirmation(555, undefined, event, 'remind Raziel to call the plumber', dana);
    await handleEventCallback(555, 701, 'q1', 'create', pendingIdOf(lastBot(), 'event_create:'));
    assert(created.length === 1 && created[0].calendarId === 'native:main-1', JSON.stringify(created));
    const input = created[0].input;
    assert(input.kind === 'reminder' && input.forUserId === 2, JSON.stringify(input));
    assert(sameInstant(input.startTime, at('2026-10-15 10:00')) && sameInstant(input.endTime, at('2026-10-15 10:00')), 'not zero-length');
    const line = await getBotMessage('en', 'nativeReminders.created.partner', { name: 'Raziel', when: 'tomorrow at 10:00' });
    assert(lastBot().text === `${line}\n\n<b>Call the plumber</b>`, lastBot().text);
    assert(tracked.some(e => e.action === 'native_reminder_created'), JSON.stringify(tracked));
  });

  await check('confirm: an event\'s create input is exactly what it was', async () => {
    const event: ParsedEvent = { title: 'Dentist', startTime: at('2026-10-15 10:00'), endTime: at('2026-10-15 11:00'), allDay: false, calendarId: 'native:main-1', calendarName: 'Dana', confidence: 'high' };
    await showEventConfirmation(555, undefined, event, 'dentist', dana);
    await handleEventCallback(555, 701, 'q1', 'create', pendingIdOf(lastBot(), 'event_create:'));
    assert(JSON.stringify(Object.keys(created[0].input)) === '["title","startTime","endTime","location","description","allDay","recurrence"]', JSON.stringify(created[0].input));
    assert(lastBot().text.startsWith(`${t.voice.created}\n\n<b>Dentist</b>\n`), lastBot().text);
    assert(!tracked.some(e => e.action === 'native_reminder_created'), 'tracked an event as a reminder');
  });

  await check('auto-create: a HIGH reminder is created with its fields and the reminder reply', async () => {
    flags.autoCreate = true;
    const event = await resolved(parsedReminder());
    const handled = await autoCreateEvent(dana, event, t, fakeService as never, 555);
    assert(handled && created[0].input.kind === 'reminder' && created[0].input.forUserId === null, JSON.stringify(created));
    const line = await getBotMessage('en', 'nativeReminders.created.self', { when: 'tomorrow at 10:00' });
    assert(serviceCalls[0].text === `${line}\n\n<b>Call the plumber</b>`, serviceCalls[0].text);
    assert(tracked.some(e => e.action === 'native_reminder_created' && e.metadata?.auto === true), JSON.stringify(tracked));
  });

  await check('replies: date-only, Hebrew and Russian lines fill every placeholder; the spoken line has no emoji', async () => {
    const event = await resolved(parsedReminder(dateOnly('2026-10-16')));
    const dateLine = await reminderCreatedLine(event, 'en', IL);
    assert(dateLine === await getBotMessage('en', 'nativeReminders.created.dateOnly', { when: 'Fri, Oct 16' }), dateLine);
    const forPartner = await resolved(parsedReminder({ forPerson: 'partner' }));
    for (const language of ['he', 'ru']) {
      const line = await reminderCreatedLine(forPartner, language, IL);
      assert(!line.includes('{') && line.includes('Raziel') && line.includes('10:00'), `${language}: ${line}`);
    }
    const spoken = await formatReminderOutcomeLine(forPartner, 'en', IL);
    assert(spoken === `${(await reminderCreatedLine(forPartner, 'en', IL)).replace('⏰ ', '')} Call the plumber.`, spoken);
  });

  // ---- Bulk ----

  await check('bulk: two reminders show as reminders and "Confirm all" creates both (dates revived from Redis)', async () => {
    const one = await resolved(parsedReminder({ forPerson: 'partner' }));
    const two = await resolved(parsedReminder({ title: 'Buy milk', ...dateOnly('2026-10-16') }));
    await showBulkConfirmation(555, [createIntent(one), createIntent(two)], dana, 'two reminders', t, fakeService as never, IL);
    const card = serviceCalls[0];
    assert(card.text.includes('1. ⏰ <b>Call the plumber</b> — Thu, Oct 15, 10:00 · for Raziel'), card.text);
    assert(card.text.includes('2. ⏰ <b>Buy milk</b> — Fri, Oct 16'), card.text);
    const pendingId = buttonsOf({ ...card, opts: { reply_markup: card.opts?.replyMarkup } })[0][0].callback_data.slice('bulk_confirm:'.length);
    const result = await handleBulkConfirmAll(pendingId);
    assert(result.successCount === 2 && result.failureCount === 0, JSON.stringify(result));
    assert(created.every(c => c.input.kind === 'reminder' && sameInstant(c.input.endTime, c.input.startTime as Date)), JSON.stringify(created));
    assert(created[0].input.forUserId === 2 && created[1].input.forUserId === null, JSON.stringify(created));
  });

  await check('bulk: a partner who can\'t be pinged is noted once under the list', async () => {
    partner = { ...raziel, telegramId: null };
    const one = await resolved(parsedReminder({ forPerson: 'partner' }));
    const two = await resolved(parsedReminder({ forPerson: 'partner', title: 'Buy milk' }));
    await showBulkConfirmation(555, [createIntent(one), createIntent(two)], dana, 'x', t, fakeService as never, IL);
    const notice = await getBotMessage('en', 'nativeReminders.card.partnerNotOnTelegram', { name: 'Raziel' });
    assert(serviceCalls[0].text.endsWith(`— Thu, Oct 15, 10:00\n\n<i>${notice}</i>`), serviceCalls[0].text);
  });

  await check('bulk: an event next to a reminder keeps its own input', async () => {
    const event: ParsedEvent = { title: 'Dentist', startTime: at('2026-10-15 10:00'), endTime: at('2026-10-15 11:00'), allDay: false, calendarId: 'native:main-1', confidence: 'high' };
    const reminder = await resolved(parsedReminder());
    await showBulkConfirmation(555, [createIntent(event), createIntent(reminder)], dana, 'x', t, fakeService as never, IL);
    const pendingId = (serviceCalls[0].opts?.replyMarkup as { inline_keyboard: Array<Array<{ callback_data: string }>> }).inline_keyboard[0][0].callback_data.slice('bulk_confirm:'.length);
    await handleBulkConfirmAll(pendingId);
    assert(!('kind' in created[0].input) && created[1].input.kind === 'reminder', JSON.stringify(created));
  });

  // ---- Reply-to-correct and the quick time fix ----

  await check('correction: a reminder keeps its target, calendar and zero length when the model adds an hour', async () => {
    const event = await resolved(parsedReminder({ forPerson: 'partner' }));
    await showEventConfirmation(555, undefined, event, 'remind Raziel to call the plumber', dana);
    const pendingId = pendingIdOf(lastBot(), 'event_create:');
    geminiText = JSON.stringify({ title: 'Call the plumber', startDate: '2026-10-15', startTime: '17:00', endDate: '2026-10-15', endTime: '18:00', allDay: false, calendarId: 'native:raziel-cal', calendarName: 'Raziel' });
    await handleEventCorrection(555, 1001, pendingId, 701, { text: 'make it 5pm' });
    assert(geminiPrompts[0].includes('This is a REMINDER'), 'prompt never said it is a reminder');
    const card = lastBot();
    assert(card.method === 'editMessageText' && card.text.includes('📆 Thu, Oct 15, 17:00 · for Raziel'), card.text);
    const pending = await fakeRedis.get(`voice:pending:event:${pendingIdOf(card, 'event_create:')}`);
    const e = pending.event;
    assert(e.kind === 'reminder' && e.forUserId === 2 && e.forName === 'Raziel' && e.calendarId === 'native:main-1', JSON.stringify(e));
    assert(e.startTime === at('2026-10-15 17:00').toISOString() && e.endTime === e.startTime, `times ${e.startTime} ${e.endTime}`);
  });

  await check('correction: an event\'s prompt has no reminder line', async () => {
    const event: ParsedEvent = { title: 'Dentist', startTime: at('2026-10-15 10:00'), endTime: at('2026-10-15 11:00'), allDay: false, calendarId: 'native:main-1', calendarName: 'Dana', confidence: 'high' };
    await showEventConfirmation(555, undefined, event, 'dentist', dana);
    geminiText = JSON.stringify({ title: 'Dentist', startDate: '2026-10-15', startTime: '17:00', endDate: '2026-10-15', endTime: '18:00', allDay: false, calendarId: 'native:main-1', calendarName: 'Dana' });
    await handleEventCorrection(555, 1001, pendingIdOf(lastBot(), 'event_create:'), 701, { text: 'make it 5pm' });
    assert(!geminiPrompts[0].includes('REMINDER') && geminiPrompts[0].includes('- All day: false\n\nUSER\'S CALENDARS:'), geminiPrompts[0]);
    assert(lastBot().text.includes('17:00 - 18:00'), lastBot().text);
  });

  await check('quick fix: a reminder\'s time is one time, and a date-only one becomes timed', async () => {
    const event = await resolved(parsedReminder(dateOnly('2026-10-16')));
    geminiText = '{"startTime": "17:00"}';
    const patch = await extractFieldPatch('time', null, '5pm', event, CALENDARS, 'en', IL);
    assert(geminiPrompts[0].includes('TIME of a reminder'), geminiPrompts[0]);
    assert(!!patch && sameInstant(patch.startTime, at('2026-10-16 17:00')) && sameInstant(patch.endTime, at('2026-10-16 17:00')) && patch.allDay === false, JSON.stringify(patch));
    geminiText = '{"startTime": "17:00", "endTime": "18:00"}';
    const eventPatch = await extractFieldPatch('time', null, '5pm', { ...event, kind: undefined, allDay: false }, CALENDARS, 'en', IL);
    assert(!!eventPatch && sameInstant(eventPatch.endTime, at('2026-10-16 18:00')) && eventPatch.allDay === undefined, JSON.stringify(eventPatch));
  });

  // ---- The handlers ----

  await check('voice: a supported user\'s prompt gets both names, and "remind Raziel" shows the reminder card', async () => {
    extracted = [createIntent(parsedReminder({ forPerson: 'partner' }))];
    await handleVoiceMessage(555, 1001, voice, from);
    const context = voiceCalls[0][6];
    assert(JSON.stringify(context) === '{"userName":"Dana","userEnglishName":"Dana","partnerName":"Raziel","partnerEnglishName":"Raziel"}', JSON.stringify(context));
    assert(lastBot()?.text.includes('📆 Thu, Oct 15, 10:00 · for Raziel'), JSON.stringify(botCalls));
  });

  await check('voice: an unsupported user gets no reminder context and the event flow as before', async () => {
    support = { supported: false, reason: 'no_access' };
    const event: ParsedEvent = { title: 'Dentist', startTime: at('2026-10-15 10:00'), endTime: at('2026-10-15 11:00'), allDay: false, calendarId: 'native:main-1', calendarName: 'Dana', confidence: 'medium' };
    extracted = [createIntent(event)];
    await handleVoiceMessage(555, 1001, voice, from);
    assert(voiceCalls[0].length === 7 && voiceCalls[0][6] === undefined, `args ${voiceCalls[0].length}: ${JSON.stringify(voiceCalls[0][6])}`);
    assert(lastBot()?.text.startsWith(t.voice.confirmTitle), JSON.stringify(botCalls));
  });

  await check('voice: an anchor it can\'t find asks for a time and shows no card', async () => {
    extracted = [createIntent(anchored('the dentist', -60))];
    await handleVoiceMessage(555, 1001, voice, from);
    const question = await getBotMessage('en', 'nativeReminders.anchor.notFound', { description: 'the dentist' });
    assert(serviceCalls.some(c => c.text === question), JSON.stringify(serviceCalls));
    assert(botCalls.length === 0 && created.length === 0, JSON.stringify(botCalls));
  });

  await check('voice: auto-create waits for "keep as mine" when the partner can\'t be pinged', async () => {
    flags.autoCreate = true;
    partner = { ...raziel, telegramId: null };
    extracted = [createIntent(parsedReminder({ forPerson: 'partner' }), 'high')];
    await handleVoiceMessage(555, 1001, voice, from);
    assert(created.length === 0, `auto-created ${JSON.stringify(created)}`);
    assert(buttonsOf(lastBot())[0][0].text === t.nativeReminders.card.keepAsMine, JSON.stringify(botCalls));
  });

  await check('voice: a HIGH reminder auto-creates like an event', async () => {
    flags.autoCreate = true;
    extracted = [createIntent(parsedReminder(), 'high')];
    await handleVoiceMessage(555, 1001, voice, from);
    assert(created.length === 1 && created[0].input.kind === 'reminder' && created[0].calendarId === 'native:main-1', JSON.stringify(created));
  });

  await check('forwarded text: no partner in the prompt, and "remind my husband" stays the forwarder\'s', async () => {
    extracted = [createIntent(parsedReminder({ forPerson: 'partner' }))];
    await handleForwardedMessage(555, 1001, 'remind my husband to call the plumber tomorrow at 10', from);
    assert(JSON.stringify(textCalls[0][4]) === '{"userName":"Dana","userEnglishName":"Dana","partnerName":null,"partnerEnglishName":null}', JSON.stringify(textCalls[0][4]));
    assert(partnerLookups === 0, `${partnerLookups} partner lookups`);
    assert(lastBot()?.text.startsWith('⏰ <b>Call the plumber</b>\n📆 Thu, Oct 15, 10:00\n'), JSON.stringify(botCalls));
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
TZ=UTC npx tsx scripts/smoke-native-reminder-create-flow.ts; echo "exit=$?"
```

Expected: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/src/services/native-reminders/resolve' imported from …/scripts/smoke-native-reminder-create-flow.ts`, then `exit=1`.

- [ ] **Step 3: ParsedEvent keeps a resolved reminder**

In `src/services/event-parser.ts`, `ParsedEvent` (line 80, after the fields Task 10 added). These three fields are written only by `resolveReminderIntents` and live in the pending card's Redis payload, so the card's confirm creates exactly what the card showed.

Find:

```ts
  recurrence?: RecurrencePattern;
```

Replace with:

```ts
  recurrence?: RecurrencePattern;
  // A reminder once resolved for creation (src/services/native-reminders/resolve.ts).
  // The pending card keeps them, so its confirm creates exactly what the card showed.
  forUserId?: number | null; // the partner it is for; null = the creator
  forName?: string; // that partner's name, for the card and the reply
  reminderNotice?: 'partner_not_on_telegram' | 'no_time_set';
```

`  recurrence?: RecurrencePattern;` occurs once in the file (inside `ParsedEvent`); Task 10's `kind`/`forPerson`/`anchor` lines stay where Task 10 put them.

- [ ] **Step 4: Let the matcher take options, starting with a candidate filter**

In `src/services/voice/event-resolution.ts`, add `MatchOptions` and pass it from `findMatchingEvent` (lines 275-300) to `matchInRange` (lines 302-316). Its one field for now, `eligible`, picks which of the fetched events may match. A reminder's anchor uses it to keep only upcoming events and never reminders. Every existing caller passes no options, so its behaviour is unchanged. Task 13 adds `request` and `openReminders` to the same interface.

Find:

```ts
/**
 * Find a matching event based on description and time hint
 * Uses AI to match event titles and returns the best match
 */
export async function findMatchingEvent(
  user: UserConfig,
  calendarIds: string[],
  reference: EventReference,
  language: string,
  now: Date = new Date()
): Promise<MatchResult> {
  const timezone = await resolveUserTimezone(user);
  const day = hintedDay(reference, now, timezone);
  const narrowed = await matchInRange(user, calendarIds, reference, language, now, timezone, day);
```

Replace with:

```ts
/** What a caller adds to the search. */
export interface MatchOptions {
  /** Which of the events in range may match (a reminder's anchor: upcoming events only, never reminders). */
  eligible?: (events: CalendarEvent[]) => CalendarEvent[];
}

/**
 * Find a matching event based on description and time hint
 * Uses AI to match event titles and returns the best match
 */
export async function findMatchingEvent(
  user: UserConfig,
  calendarIds: string[],
  reference: EventReference,
  language: string,
  now: Date = new Date(),
  options: MatchOptions = {}
): Promise<MatchResult> {
  const timezone = await resolveUserTimezone(user);
  const day = hintedDay(reference, now, timezone);
  const narrowed = await matchInRange(user, calendarIds, reference, language, now, timezone, day, options);
```

Find:

```ts
    return matchInRange(user, calendarIds, wide, language, now, timezone, undefined);
```

Replace with:

```ts
    return matchInRange(user, calendarIds, wide, language, now, timezone, undefined, options);
```

Find:

```ts
  day: string | undefined,
): Promise<MatchResult> {
  const { startDate, endDate } = matchSearchRange(reference, now, timezone);

  // Fetch events from all calendars
  const provider = getProviderForUser(user);
  const events = await provider.fetchEventsInRange(user, calendarIds, startDate, endDate);
```

Replace with:

```ts
  day: string | undefined,
  options: MatchOptions = {},
): Promise<MatchResult> {
  const { startDate, endDate } = matchSearchRange(reference, now, timezone);

  // Fetch events from all calendars
  const provider = getProviderForUser(user);
  const fetched = await provider.fetchEventsInRange(user, calendarIds, startDate, endDate);
  const events = options.eligible ? options.eligible(fetched) : fetched;
```

`MatchOptions` lands right after `type MatchResult = …` (line 273), and `CalendarEvent` is already imported (line 9). The filtered list goes through the rest of `matchInRange` unchanged, so an anchor with no upcoming candidates gets `no_events_found`, which resolution turns into `anchor_not_found`.

- [ ] **Step 5: Create the resolution module**

Create `src/services/native-reminders/resolve.ts`. It holds the contract's `resolveReminderForCreate`, plus what every create path shares: resolving a message's intents in place, the notice refresh, the prompt context and the provider fields. It has no UI; the card and its copy live in `confirmations.ts`, which imports this module (never the other way round, so there is no cycle).

```ts
// Creating a native reminder (spec §3.2): the calendar it goes on, who it is for and,
// for "an hour before the dentist", when it fires. The model's calendar pick is never
// used: for "remind Dana" it picks the calendar named Dana, which is the partner's. A
// reminder always goes on its creator's main calendar, with forUserId naming the
// partner. An anchored reminder keeps no link to its anchor (R11): moving the dentist
// doesn't move it.

import { getCalendarAssignmentsForUser } from '../calendar-provider';
import type { CreateEventInput } from '../calendar-provider/types';
import type { ParsedEvent, VoiceIntentResult } from '../event-parser';
import { encodeCalendarId, getMainNativeCalendar, normalizeReminderTimes } from '../native-calendar/event-store';
import { findMatchingEvent } from '../voice/event-resolution';
import type { ReminderPromptContext } from '../voice/gemini-voice';
import type { CalendarEvent, UserConfig } from '../../types';
import { addDaysToDate, localDate, startOfLocalDay } from '../../utils/day-events';
import { isAllDayEvent, isReminderEvent } from '../../utils/event-formatter';
import { dueAtForOccurrence } from './due';
import { getActivePartnerSummary } from './ownership';
import type { PartnerSummary } from './ownership';

export type ResolvedReminder =
  | { ok: true; calendarId: string; forUserId: number | null; startTime: Date; endTime: Date; allDay: boolean;
      notice?: 'partner_not_on_telegram' | 'no_time_set' }
  | { ok: false; error: 'anchor_not_found' | 'anchor_ambiguous' | 'anchor_needs_time' };

type ReminderError = Extract<ResolvedReminder, { ok: false }>['error'];

/** A reminder that can't be created as asked: the bot asks for a time instead of showing a card. */
export interface ReminderFailure {
  error: ReminderError;
  description: string; // the event it was anchored to, as the user named it
}

const MINUTES_PER_DAY = 24 * 60;

/**
 * Where a parsed reminder goes, for whom and when. `forPerson: 'partner'` makes it the
 * ACTIVE partner's when they are on the built-in calendar and on Telegram. A partner
 * who isn't on Telegram can't be pinged, so it stays the creator's and the card asks
 * about it. Unpaired, or a partner on Google: the creator's.
 */
export async function resolveReminderForCreate(
  user: UserConfig,
  event: ParsedEvent,
  timezone: string,
  now: Date = new Date()
): Promise<ResolvedReminder> {
  const partner = event.forPerson === 'partner' ? await getActivePartnerSummary(user.id, user.pairingId ?? null) : null;
  return resolveWithPartner(user, event, timezone, now, partner);
}

async function resolveWithPartner(
  user: UserConfig,
  event: ParsedEvent,
  timezone: string,
  now: Date,
  partner: PartnerSummary | null
): Promise<ResolvedReminder> {
  let { startTime, allDay } = event;
  if (event.anchor) {
    const anchored = await anchoredTime(user, event.anchor, timezone, now);
    if (!anchored.ok) return anchored;
    ({ startTime, allDay } = anchored);
  }
  const calendar = await getMainNativeCalendar(user.id);
  const target = targetFor(event, partner);
  const times = normalizeReminderTimes(startTime, allDay, timezone);
  const notice = target.notice ?? (missedMorning(times.startsAt, allDay, timezone, now) ? 'no_time_set' : undefined);
  return {
    ok: true,
    calendarId: encodeCalendarId(calendar.id),
    forUserId: target.forUserId,
    startTime: times.startsAt,
    endTime: times.endsAt,
    allDay,
    ...(notice ? { notice } : {}),
  };
}

/** Who "remind Dana…" is for: the partner only when they are on the built-in calendar and can be pinged. */
function targetFor(
  event: ParsedEvent,
  partner: PartnerSummary | null
): { forUserId: number | null; notice?: 'partner_not_on_telegram' } {
  if (event.forPerson !== 'partner' || !partner || partner.calendarSource !== 'NATIVE') return { forUserId: null };
  if (partner.telegramId === null) return { forUserId: null, notice: 'partner_not_on_telegram' };
  return { forUserId: partner.id };
}

/**
 * A date-only reminder for today made after its 09:00 ping: it won't ping, but it stays
 * in the summaries (spec §3.3).
 */
function missedMorning(startsAt: Date, allDay: boolean, timezone: string, now: Date): boolean {
  if (!allDay || localDate(startsAt, timezone) !== localDate(now, timezone)) return false;
  return now > dueAtForOccurrence({ startsAt, allDay: true, timeZone: timezone }, timezone);
}

/**
 * A resolved reminder with its card notice as of now. A quick fix or a reply can give a
 * date-only reminder a time, or move it to another day, so the card works the notice
 * out again each time it is shown. A partner who can't be pinged stays noted.
 */
export function refreshReminderNotice(event: ParsedEvent, timezone: string, now: Date = new Date()): ParsedEvent {
  const notice = event.reminderNotice === 'partner_not_on_telegram'
    ? event.reminderNotice
    : missedMorning(event.startTime, event.allDay, timezone, now) ? 'no_time_set' : undefined;
  return { ...event, reminderNotice: notice };
}

/**
 * The events a reminder's anchor can name: not reminders, not started yet, and a
 * repeating one only at its next occurrence, so "before piano" doesn't match every
 * lesson of the series.
 */
export function anchorCandidates(events: CalendarEvent[], now: Date, timezone: string): CalendarEvent[] {
  const today = localDate(now, timezone);
  const startOf = (e: CalendarEvent) => (isAllDayEvent(e) ? startOfLocalDay(e.start, timezone) : new Date(e.start)).getTime();
  const upcoming = events
    .filter(e => !isReminderEvent(e) && (isAllDayEvent(e) ? e.start >= today : new Date(e.start) >= now))
    .sort((a, b) => startOf(a) - startOf(b));
  const seen = new Set<string>();
  return upcoming.filter(e => {
    if (!e.recurringEventId) return true;
    if (seen.has(e.recurringEventId)) return false;
    seen.add(e.recurringEventId);
    return true;
  });
}

/**
 * When a reminder set relative to `anchorEvent` fires: its start plus the offset. An
 * all-day event has no hour to count from, so an offset in hours needs a time from the
 * user, and one in whole days gives a date-only reminder on that day.
 */
export function reminderTimeFromAnchor(
  anchorEvent: CalendarEvent,
  offsetMinutes: number,
  timezone: string
): { ok: true; startTime: Date; allDay: boolean } | { ok: false; error: 'anchor_needs_time' } {
  const offset = Number.isFinite(offsetMinutes) ? offsetMinutes : 0;
  if (!isAllDayEvent(anchorEvent)) {
    return { ok: true, startTime: new Date(new Date(anchorEvent.start).getTime() + offset * 60_000), allDay: false };
  }
  if (offset % MINUTES_PER_DAY !== 0) return { ok: false, error: 'anchor_needs_time' };
  const day = addDaysToDate(anchorEvent.start, offset / MINUTES_PER_DAY);
  return { ok: true, startTime: startOfLocalDay(day, timezone), allDay: true };
}

/** The time of an anchored reminder: the one upcoming event its anchor names, plus the offset. */
async function anchoredTime(
  user: UserConfig,
  anchor: NonNullable<ParsedEvent['anchor']>,
  timezone: string,
  now: Date
): Promise<{ ok: true; startTime: Date; allDay: boolean } | { ok: false; error: ReminderError }> {
  const calendars = await getCalendarAssignmentsForUser(user);
  const match = await findMatchingEvent(
    user,
    calendars.map(c => c.calendarId),
    { type: 'by_description', description: anchor.description },
    user.language || 'en',
    now,
    { eligible: events => anchorCandidates(events, now, timezone) }
  );
  if ('error' in match) return { ok: false, error: match.error === 'multiple_matches' ? 'anchor_ambiguous' : 'anchor_not_found' };
  return reminderTimeFromAnchor(match.event, anchor.offsetMinutes, timezone);
}

/**
 * A message's intents with each reminder resolved in place: the calendar, target and
 * time it will be created with, kept on the event so the card shows them and its
 * confirm creates exactly that. A reminder that can't be placed leaves the creates
 * (no card for it) and comes back as a failure to ask about. Other intents pass
 * through untouched. `selfOnly` is for forwarded text, where "me" is whoever
 * forwarded it, so every reminder is theirs (spec §3.1).
 */
export async function resolveReminderIntents(
  user: UserConfig,
  intents: VoiceIntentResult[],
  timezone: string,
  options: { selfOnly?: boolean; now?: Date } = {}
): Promise<{ intents: VoiceIntentResult[]; failures: ReminderFailure[] }> {
  const now = options.now ?? new Date();
  const isReminder = (i: VoiceIntentResult) => i.intent === 'create' && i.event?.kind === 'reminder';
  const asked = options.selfOnly
    ? intents.map(i => (isReminder(i) ? { ...i, event: { ...i.event!, forPerson: 'self' as const } } : i))
    : intents;
  const wantsPartner = asked.some(i => isReminder(i) && i.event!.forPerson === 'partner');
  const partner = wantsPartner ? await getActivePartnerSummary(user.id, user.pairingId ?? null) : null;

  const failures: ReminderFailure[] = [];
  const resolved: VoiceIntentResult[] = [];
  for (const intent of asked) {
    if (!isReminder(intent)) {
      resolved.push(intent);
      continue;
    }
    const event = intent.event!;
    const result = await resolveWithPartner(user, event, timezone, now, partner);
    if (!result.ok) {
      failures.push({ error: result.error, description: event.anchor?.description || event.title });
      resolved.push({ intent: 'create', confidence: intent.confidence, error: result.error });
      continue;
    }
    const named = result.forUserId !== null || result.notice === 'partner_not_on_telegram';
    resolved.push({
      ...intent,
      event: {
        ...event,
        calendarId: result.calendarId,
        calendarName: undefined,
        startTime: result.startTime,
        endTime: result.endTime,
        allDay: result.allDay,
        anchor: undefined,
        forUserId: result.forUserId,
        forName: named && partner ? partner.name : undefined,
        reminderNotice: result.notice,
      },
    });
  }
  return { intents: resolved, failures };
}

/**
 * The names the extraction prompt's reminder rules use to tell "remind me" from "remind
 * Dana": the user's and the ACTIVE partner's. `withPartner: false` leaves the partner
 * out, for forwarded text.
 */
export async function reminderPromptContext(
  user: UserConfig,
  options: { withPartner?: boolean } = {}
): Promise<ReminderPromptContext> {
  const partner = options.withPartner === false ? null : await getActivePartnerSummary(user.id, user.pairingId ?? null);
  return {
    userName: user.name,
    userEnglishName: user.englishName || null,
    partnerName: partner?.name ?? null,
    partnerEnglishName: partner?.englishName || null,
  };
}

/**
 * A reminder's part of a provider create, spread after the event's own fields. An
 * event gets nothing, so its input is unchanged. A reminder has one time: it ends
 * where it starts (the store enforces that too).
 */
export function reminderCreateFields(event: ParsedEvent): Partial<Pick<CreateEventInput, 'kind' | 'forUserId' | 'endTime'>> {
  if (event.kind !== 'reminder') return {};
  return { kind: 'reminder', forUserId: event.forUserId ?? null, endTime: event.startTime };
}
```

`import type { PartnerSummary } from './ownership'` is a separate type-only import, so nothing extra loads at runtime. `getCalendarAssignmentsForUser` comes from the `../calendar-provider` barrel on purpose: that is the module every caller and the smoke test stub.

- [ ] **Step 6: The reminder card, its copy and the anchor questions**

In `src/services/voice/confirmations.ts`, first the imports (line 13). The find is the one line, because Task 4 adds its `../../utils/html` import of `escapeHtml` nearby.

Find:

```ts
import { getBotMessages } from '../../lib/bot-messages';
```

Replace with:

```ts
import { getBotMessage, getBotMessages } from '../../lib/bot-messages';
import { formatInTimeZone } from 'date-fns-tz';
import { addDaysToDate, localDate } from '../../utils/day-events';
import { MessageFormat } from '../messaging/types';
import type { IMessagingService } from '../messaging/types';
import { refreshReminderNotice } from '../native-reminders/resolve';
import type { ReminderFailure } from '../native-reminders/resolve';
```

Find:

```ts
  const base = `📆 ${dateStr}\n🕐 ${startTimeStr} - ${endTimeStr}`;
  return recurrenceStr ? `${base}\n${recurrenceStr}` : base;
}
```

Replace with:

```ts
  const base = `📆 ${dateStr}\n🕐 ${startTimeStr} - ${endTimeStr}`;
  return recurrenceStr ? `${base}\n${recurrenceStr}` : base;
}

/**
 * When a reminder fires, as its card and the bulk card list it: the short date and time
 * in the user's language ("Thu, Oct 15, 10:00"), or the date alone for a date-only one.
 * No end: a reminder has no length. Never relative: "📆 on Thu, Oct 15 at 10:00" reads
 * wrong on a card. The created reply uses formatReminderRelativeWhen instead.
 */
export function formatReminderWhen(
  event: Pick<ParsedEvent, 'startTime' | 'allDay'>,
  language: string,
  timezone: string
): string {
  const locale = language === 'he' ? 'he-IL' : language === 'ru' ? 'ru-RU' : 'en-US';
  const date: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric', timeZone: timezone };
  return event.allDay
    ? event.startTime.toLocaleDateString(locale, date)
    : event.startTime.toLocaleString(locale, { ...date, hour: '2-digit', minute: '2-digit', hour12: false });
}

/**
 * When a reminder fires, as the created reply says it (plan ruling 6): "today at 17:00",
 * "tomorrow at 10:00" or "on Fri, Oct 16 at 10:00", and "today", "tomorrow" or "Fri,
 * Oct 16" for a date-only one, from the when.* copy. Today is the user's own day
 * (`timezone`), not the server's. `{date}` is formatReminderWhen's short date.
 */
export async function formatReminderRelativeWhen(
  event: Pick<ParsedEvent, 'startTime' | 'allDay'>,
  language: string,
  timezone: string
): Promise<string> {
  const day = localDate(event.startTime, timezone);
  const today = localDate(new Date(), timezone);
  const relative = day === today ? 'today' : day === addDaysToDate(today, 1) ? 'tomorrow' : 'date';
  const date = formatReminderWhen({ startTime: event.startTime, allDay: true }, language, timezone);
  if (event.allDay) return getBotMessage(language, `nativeReminders.when.${relative}`, { date });
  const time = formatInTimeZone(event.startTime, timezone, 'HH:mm');
  return getBotMessage(language, `nativeReminders.when.${relative}At`, { date, time });
}

/** Telegram's HTML or WhatsApp's own markup, for text both platforms show. */
const MARKUP = {
  html: { bold: (s: string) => `<b>${s}</b>`, italic: (s: string) => `<i>${s}</i>`, text: escapeHtml },
  whatsapp: { bold: (s: string) => `*${s}*`, italic: (s: string) => `_${s}_`, text: (s: string) => s },
};

/**
 * A reminder's card (spec §3.3): its title, when it fires and for whom, and anything
 * that keeps it from pinging. No end time and no calendar: a reminder has no length and
 * always goes on its creator's main calendar.
 */
export async function formatReminderCard(
  event: ParsedEvent,
  language: string,
  timezone: string,
  markup: keyof typeof MARKUP = 'html'
): Promise<string> {
  const m = MARKUP[markup];
  const t = await getBotMessages(language);
  const forPartner = event.forUserId != null && event.forName
    ? ` · ${await getBotMessage(language, 'nativeReminders.card.forPartner', { name: m.text(event.forName) })}`
    : '';
  const lines = [
    await getBotMessage(language, 'nativeReminders.card.title', { title: m.bold(m.text(event.title)) }),
    `📆 ${formatReminderWhen(event, language, timezone)}${forPartner}`,
  ];
  const recurrence = formatRecurrence(event.recurrence, language);
  if (recurrence) lines.push(recurrence);
  if (event.location) lines.push(`📍 ${m.text(event.location)}`);
  if (event.reminderNotice === 'no_time_set') {
    lines.push('', m.italic(t.nativeReminders.card.noTimeSet));
  } else if (event.reminderNotice === 'partner_not_on_telegram') {
    const name = m.text(event.forName || '');
    lines.push('', m.italic(await getBotMessage(language, 'nativeReminders.card.partnerNotOnTelegram', { name })));
  }
  return lines.join('\n');
}

/**
 * The line saying a reminder is set: for whom and when ("tomorrow at 10:00"), or just the
 * day for a date-only one. `html` escapes the partner's name for Telegram; WhatsApp and
 * speech take it as is.
 */
export async function reminderCreatedLine(
  event: ParsedEvent,
  language: string,
  timezone: string,
  html = true
): Promise<string> {
  const when = await formatReminderRelativeWhen(event, language, timezone);
  if (event.allDay) return getBotMessage(language, 'nativeReminders.created.dateOnly', { when });
  if (event.forUserId != null && event.forName) {
    const name = html ? escapeHtml(event.forName) : event.forName;
    return getBotMessage(language, 'nativeReminders.created.partner', { name, when });
  }
  return getBotMessage(language, 'nativeReminders.created.self', { when });
}

/** What a reminder's card says once the reminder is created (confirmed or auto-created). */
export async function formatReminderCreated(event: ParsedEvent, language: string, timezone: string): Promise<string> {
  const recurrence = formatRecurrence(event.recurrence, language);
  return `${await reminderCreatedLine(event, language, timezone)}\n\n<b>${escapeHtml(event.title)}</b>` +
    (recurrence ? `\n${recurrence}` : '');
}

const ANCHOR_QUESTIONS = { anchor_not_found: 'notFound', anchor_ambiguous: 'ambiguous', anchor_needs_time: 'needsTime' } as const;

/** What to ask when a reminder set relative to an event ("an hour before the dentist") can't be placed. */
export function anchorQuestion(failure: ReminderFailure, language: string, html = true): Promise<string> {
  return getBotMessage(language, `nativeReminders.anchor.${ANCHOR_QUESTIONS[failure.error]}`, {
    description: html ? escapeHtml(failure.description) : failure.description,
  });
}

/** Ask about each reminder in a message that couldn't be placed (Telegram). */
export async function sendAnchorQuestions(
  chatId: number | string,
  failures: ReminderFailure[],
  language: string,
  service: IMessagingService
): Promise<void> {
  for (const failure of failures) {
    await service.sendMessage(chatId, await anchorQuestion(failure, language), { format: MessageFormat.HTML });
  }
}
```

Find:

```ts
  const pendingId = `${chatId}:${Date.now()}`;

  // Store in Redis with TTL (survives serverless cold starts).
  // PR 12: inputModality threads through so callbacks know whether to voice
  // the outcome (preserves voice-in/voice-out for the same conversation).
  await redis.set(REDIS_KEYS.pendingEvent(pendingId), { event, user, transcription, inputModality }, { ex: PENDING_TTL_SECONDS });

  const dateTimeStr = formatEventDateTime(event, user.language || 'en', t.voice.allDay, timezone);
  const locationStr = event.location ? `\n📍 ${event.location}` : '';
  const calendarStr = event.calendarName ? `\n📁 ${event.calendarName}` : '';

  const confirmationMessage =
    `${t.voice.confirmTitle}\n\n` +
    `<b>${event.title}</b>\n` +
    `${dateTimeStr}${locationStr}${calendarStr}\n\n` +
    `<i>${t.voice.from} "${escapeHtml(transcription)}"</i>` +
    (adminFooter || '');

  // Quick-correction shortcut row (PR 10 polish): one tap re-prompts for just
  // one field of the pending event. Only show "Cal" when user has multiple
  // calendars to pick from — otherwise the button is meaningless.
  const calendarCount = (user.calendarAssignments?.length ?? 0);
  const quickRow: Array<{ text: string; callback_data: string }> = [
    { text: t.voice?.fixTime || '⏰ Time', callback_data: `event_fix:time:${pendingId}` },
    { text: t.voice?.fixDay || '📅 Day', callback_data: `event_fix:day:${pendingId}` },
  ];
  if (calendarCount > 1) {
    quickRow.push({ text: t.voice?.fixCal || '📁 Cal', callback_data: `event_fix:cal:${pendingId}` });
  }

  const replyMarkup = {
    inline_keyboard: [
      [
        { text: t.voice.createButton, callback_data: `event_create:${pendingId}` },
```

Replace with:

```ts
  const pendingId = `${chatId}:${Date.now()}`;

  // A reminder's notice is worked out again on every showing: a quick fix or a reply may
  // have given it a time since it was resolved.
  const reminder = event.kind === 'reminder';
  const shown = reminder ? refreshReminderNotice(event, timezone) : event;

  // Store in Redis with TTL (survives serverless cold starts).
  // PR 12: inputModality threads through so callbacks know whether to voice
  // the outcome (preserves voice-in/voice-out for the same conversation).
  await redis.set(REDIS_KEYS.pendingEvent(pendingId), { event: shown, user, transcription, inputModality }, { ex: PENDING_TTL_SECONDS });

  let body: string;
  if (reminder) {
    body = await formatReminderCard(shown, user.language || 'en', timezone);
  } else {
    const dateTimeStr = formatEventDateTime(event, user.language || 'en', t.voice.allDay, timezone);
    const locationStr = event.location ? `\n📍 ${escapeHtml(event.location)}` : '';
    const calendarStr = event.calendarName ? `\n📁 ${escapeHtml(event.calendarName)}` : '';
    body = `${t.voice.confirmTitle}\n\n<b>${escapeHtml(event.title)}</b>\n${dateTimeStr}${locationStr}${calendarStr}`;
  }

  const confirmationMessage =
    `${body}\n\n` +
    `<i>${t.voice.from} "${escapeHtml(transcription)}"</i>` +
    (adminFooter || '');

  // Quick-correction shortcut row (PR 10 polish): one tap re-prompts for just
  // one field of the pending event. Only show "Cal" when user has multiple
  // calendars to pick from — otherwise the button is meaningless. A reminder
  // never offers it: it always goes on the creator's main calendar.
  const calendarCount = (user.calendarAssignments?.length ?? 0);
  const quickRow: Array<{ text: string; callback_data: string }> = [
    { text: t.voice?.fixTime || '⏰ Time', callback_data: `event_fix:time:${pendingId}` },
    { text: t.voice?.fixDay || '📅 Day', callback_data: `event_fix:day:${pendingId}` },
  ];
  if (calendarCount > 1 && !reminder) {
    quickRow.push({ text: t.voice?.fixCal || '📁 Cal', callback_data: `event_fix:cal:${pendingId}` });
  }

  // A partner who can't be pinged: confirming keeps the reminder as the creator's
  const createLabel = shown.reminderNotice === 'partner_not_on_telegram'
    ? t.nativeReminders.card.keepAsMine
    : t.voice.createButton;

  const replyMarkup = {
    inline_keyboard: [
      [
        { text: createLabel, callback_data: `event_create:${pendingId}` },
```

The second find is the end of `formatEventDateTime` (lines 312-314); the new functions go right after it. `formatRecurrence` (line 248) is defined above them, and `escapeHtml` is the one Task 4 imports from `../../utils/html` (and re-exports). `getBotMessage` is async, which is why `formatReminderRelativeWhen` is; `formatReminderWhen` stays sync for the card and the bulk lines. The third find is `showEventConfirmation` from line 332 to the create button at line 365: the `pendingId` line is repeated in the edit and delete cards, so match the whole block.

An event's card is byte-identical to before unless its title, location or calendar name contains `<`, `>` or `&`. Those are now escaped; before, Telegram rejected the whole message (spec §11, minor).

- [ ] **Step 7: The spoken reply for a created reminder**

In `src/services/voice/tts-outcome.ts`, lines 12-14 and the end of `formatOutcomeLine` (lines 90-91):

Find:

```ts
import { UserConfig } from '../../types';
import type { IMessagingService } from '../messaging/types';
import { captureError } from '../../lib/error-capture';
```

Replace with:

```ts
import { UserConfig } from '../../types';
import type { IMessagingService } from '../messaging/types';
import type { ParsedEvent } from '../event-parser';
import { captureError } from '../../lib/error-capture';
import { reminderCreatedLine } from './confirmations';
```

Find:

```ts
  return `Done.`;
}
```

Replace with:

```ts
  return `Done.`;
}

/**
 * The spoken outcome for a created reminder: the reply's own line ("I'll remind Dana
 * tomorrow at 10:00"), read without its emoji, then what it is about.
 */
export async function formatReminderOutcomeLine(event: ParsedEvent, language: string, timezone: string): Promise<string> {
  const line = await reminderCreatedLine(event, language, timezone, false);
  return `${line.replace(/^⏰\s*/u, '')} ${event.title}.`;
}
```

- [ ] **Step 8: The card's Create creates a reminder**

In `src/services/voice/callbacks.ts`, the imports (lines 15-25) and `handleEventCallback`'s create branch (lines 98-148). The `resolveUserTimezone` call moves up, because the spoken reply now needs it too.

Find:

```ts
import { trackCreatedEvent } from './event-resolution';
import { resolveUserTimezone } from '../../lib/timezone';
import {
  getPendingEvent,
  removePendingEvent,
  getPendingEdit,
  removePendingEdit,
  getPendingDelete,
  removePendingDelete,
  formatEventDateTime,
} from './confirmations';
```

Replace with:

```ts
import { trackCreatedEvent } from './event-resolution';
import { resolveUserTimezone } from '../../lib/timezone';
import { reminderCreateFields } from '../native-reminders/resolve';
import {
  getPendingEvent,
  removePendingEvent,
  getPendingEdit,
  removePendingEdit,
  getPendingDelete,
  removePendingDelete,
  escapeHtml,
  formatEventDateTime,
  formatReminderCreated,
} from './confirmations';
```

Find:

```ts
        allDay: event.allDay,
        recurrence: buildRecurrenceRule(event.recurrence)
      }
    );

    if (result.success) {
```

Replace with:

```ts
        allDay: event.allDay,
        recurrence: buildRecurrenceRule(event.recurrence),
        ...reminderCreateFields(event),
      }
    );

    if (result.success) {
      const reminder = event.kind === 'reminder';
      const timezone = await resolveUserTimezone(user);
```

Find:

```ts
      if (pending.inputModality === 'voice') {
        const { speakOutcome, formatOutcomeLine } = await import('./tts-outcome');
        const { getMessagingService } = await import('../telegram/bot');
        const line = formatOutcomeLine('created', event.title, user.language || 'en');
        speakOutcome(chatId, line, user, getMessagingService()).catch(() => {});
      }

      trackActivityAsync(user.id, 'voice_event_created', {
        calendar_id: event.calendarId || 'primary',
      });
      incrementUsage(user.id, 'voiceEvents').catch(err =>
        console.error('[Subscription] Failed to increment voice events:', err)
      );

      const timezone = await resolveUserTimezone(user);
      const dateTimeStr = formatEventDateTime(event, user.language || 'en', t.voice.allDay, timezone);
      const linkButton = result.eventLink
        ? `\n\n<a href="${result.eventLink}">${t.voice.openInCalendar}</a>`
        : '';

      await bot.editMessageText(
        `${t.voice.created}\n\n` +
        `<b>${event.title}</b>\n` +
        `${dateTimeStr}${linkButton}`,
        {
```

Replace with:

```ts
      if (pending.inputModality === 'voice') {
        const { speakOutcome, formatOutcomeLine, formatReminderOutcomeLine } = await import('./tts-outcome');
        const { getMessagingService } = await import('../telegram/bot');
        const line = reminder
          ? await formatReminderOutcomeLine(event, user.language || 'en', timezone)
          : formatOutcomeLine('created', event.title, user.language || 'en');
        speakOutcome(chatId, line, user, getMessagingService()).catch(() => {});
      }

      trackActivityAsync(user.id, 'voice_event_created', {
        calendar_id: event.calendarId || 'primary',
      });
      if (reminder) {
        trackActivityAsync(user.id, 'native_reminder_created', {
          for_partner: event.forUserId != null,
          all_day: event.allDay,
          recurring: !!event.recurrence,
        });
      }
      incrementUsage(user.id, 'voiceEvents').catch(err =>
        console.error('[Subscription] Failed to increment voice events:', err)
      );

      const dateTimeStr = formatEventDateTime(event, user.language || 'en', t.voice.allDay, timezone);
      const linkButton = result.eventLink
        ? `\n\n<a href="${result.eventLink}">${t.voice.openInCalendar}</a>`
        : '';

      await bot.editMessageText(
        reminder
          ? await formatReminderCreated(event, user.language || 'en', timezone)
          : `${t.voice.created}\n\n` +
            `<b>${escapeHtml(event.title)}</b>\n` +
            `${dateTimeStr}${linkButton}`,
        {
```

For an event the input object gets nothing from `reminderCreateFields`, so the provider sees the same seven keys as before. The smoke test pins this.

- [ ] **Step 9: Auto-create carries a reminder and says so**

In `src/services/voice/auto-create.ts`, the imports (lines 23-25), the create input (lines 103-106), the reply (lines 126-132) and the end of `autoCreateEvent` (lines 150-156). The auto-create rules themselves stay in `handler.ts`.

Find:

```ts
import { pushRecentEvent } from './recent-events-store';
import { resolveUserTimezone } from '../../lib/timezone';
import { formatEventDateTime } from './confirmations';
```

Replace with:

```ts
import { pushRecentEvent } from './recent-events-store';
import { resolveUserTimezone } from '../../lib/timezone';
import { escapeHtml, formatEventDateTime, formatReminderCreated } from './confirmations';
import { reminderCreateFields } from '../native-reminders/resolve';
import { trackActivityAsync } from '../analytics-service';
```

Find:

```ts
    allDay: event.allDay,
    recurrence: buildRecurrenceRule(event.recurrence),
  });
  if (!result.success || !result.eventId) return false;
```

Replace with:

```ts
    allDay: event.allDay,
    recurrence: buildRecurrenceRule(event.recurrence),
    ...reminderCreateFields(event),
  });
  if (!result.success || !result.eventId) return false;
```

Find:

```ts
  const timezone = await resolveUserTimezone(user);
  const dateTimeStr = formatEventDateTime(event, user.language || 'en', t.voice?.allDay || 'All day', timezone);
  const locationStr = event.location ? `\n📍 ${event.location}` : '';
  const summary =
    `${t.voice?.created || '✅ Event created!'}` +
    `\n\n📅 <b>${event.title}</b>\n${dateTimeStr}${locationStr}`;
  const undoLabel = t.voice?.undo || '↩️ Undo (30s)';
```

Replace with:

```ts
  const timezone = await resolveUserTimezone(user);
  const reminder = event.kind === 'reminder';
  let summary: string;
  if (reminder) {
    summary = await formatReminderCreated(event, user.language || 'en', timezone);
  } else {
    const dateTimeStr = formatEventDateTime(event, user.language || 'en', t.voice?.allDay || 'All day', timezone);
    const locationStr = event.location ? `\n📍 ${escapeHtml(event.location)}` : '';
    summary =
      `${t.voice?.created || '✅ Event created!'}` +
      `\n\n📅 <b>${escapeHtml(event.title)}</b>\n${dateTimeStr}${locationStr}`;
  }
  const undoLabel = t.voice?.undo || '↩️ Undo (30s)';
```

Find:

```ts
      console.error('[AutoCreate] rollback deleteEvent also failed:', delErr);
    }
    return false;
  }

  return true;
}
```

Replace with:

```ts
      console.error('[AutoCreate] rollback deleteEvent also failed:', delErr);
    }
    return false;
  }

  if (reminder) {
    trackActivityAsync(user.id, 'native_reminder_created', {
      auto: true,
      for_partner: event.forUserId != null,
      all_day: event.allDay,
    });
  }
  return true;
}
```

Tracking runs only after the send succeeds, so a rolled-back reminder is not counted.

- [ ] **Step 10: The bulk card: reminders, and dates revived from Redis**

In `src/services/voice/bulk-confirmations.ts`, the imports (lines 17-19), `getPendingBatch` (lines 43-46, spec §11.1), the card lines (lines 90-98) and the create in `handleBulkConfirmAll` (lines 186-190).

Find:

```ts
import { pushRecentEvent } from './recent-events-store';
import { formatEventDateTime } from './confirmations';
import type { ParsedEvent, VoiceIntentResult } from '../event-parser';
```

Replace with:

```ts
import { pushRecentEvent } from './recent-events-store';
import { escapeHtml, formatEventDateTime, formatReminderWhen } from './confirmations';
import { reminderCreateFields } from '../native-reminders/resolve';
import { trackActivityAsync } from '../analytics-service';
import { getBotMessage } from '../../lib/bot-messages';
import type { ParsedEvent, VoiceIntentResult } from '../event-parser';
```

Find:

```ts
export async function getPendingBatch(pendingId: string): Promise<BulkPendingPayload | null> {
  const data = await redis.get<BulkPendingPayload>(REDIS_KEYS.pendingBatch(pendingId));
  return data ?? null;
}
```

Replace with:

```ts
export async function getPendingBatch(pendingId: string): Promise<BulkPendingPayload | null> {
  const data = await redis.get<BulkPendingPayload>(REDIS_KEYS.pendingBatch(pendingId));
  if (!data) return null;
  // Redis hands the batch back as JSON, its times as strings: confirming called
  // toISOString() on them after the first create and threw (spec §11.1).
  for (const intent of data.intents) {
    if (intent.event) {
      intent.event.startTime = new Date(intent.event.startTime);
      intent.event.endTime = new Date(intent.event.endTime);
    }
  }
  return data;
}
```

Find:

```ts
  const lines = creates.map((it, i) => {
    const ev = it.event as ParsedEvent;
    const when = formatEventDateTime(ev, user.language || 'en', t.voice?.allDay || 'All day', timezone);
    const recurringMark = ev.recurrence ? ' 🔁' : '';
    return `${i + 1}. <b>${ev.title}</b>${recurringMark} — ${when}`;
  });

  const heading = (t.voice?.bulkFound || '📋 Found {count} events. Confirm all?').replace('{count}', String(creates.length));
  const body = `${heading}\n\n${lines.join('\n')}`;
```

Replace with:

```ts
  const language = user.language || 'en';
  const lines = await Promise.all(creates.map(async (it, i) => {
    const ev = it.event as ParsedEvent;
    const recurringMark = ev.recurrence ? ' 🔁' : '';
    if (ev.kind === 'reminder') {
      const title = await getBotMessage(language, 'nativeReminders.card.title', { title: `<b>${escapeHtml(ev.title)}</b>` });
      const forPartner = ev.forUserId != null && ev.forName
        ? ` · ${await getBotMessage(language, 'nativeReminders.card.forPartner', { name: escapeHtml(ev.forName) })}`
        : '';
      return `${i + 1}. ${title}${recurringMark} — ${formatReminderWhen(ev, language, timezone)}${forPartner}`;
    }
    const when = formatEventDateTime(ev, language, t.voice?.allDay || 'All day', timezone);
    return `${i + 1}. <b>${escapeHtml(ev.title)}</b>${recurringMark} — ${when}`;
  }));

  // "Confirm all" keeps a reminder for a partner who can't be pinged as the creator's: say so
  const unreachable = await Promise.all(creates
    .filter((it) => it.event?.reminderNotice === 'partner_not_on_telegram')
    .map((it) => getBotMessage(language, 'nativeReminders.card.partnerNotOnTelegram', { name: escapeHtml(it.event?.forName || '') })));
  const notices = [...new Set(unreachable)].map((notice) => `<i>${notice}</i>`);

  const heading = (t.voice?.bulkFound || '📋 Found {count} events. Confirm all?').replace('{count}', String(creates.length));
  const body = `${heading}\n\n${lines.join('\n')}${notices.length > 0 ? `\n\n${notices.join('\n')}` : ''}`;
```

Find:

```ts
      allDay: ev.allDay,
      recurrence: buildRecurrenceRule(ev.recurrence),
    });
    if (result.success && result.eventId) {
      success++;
```

Replace with:

```ts
      allDay: ev.allDay,
      recurrence: buildRecurrenceRule(ev.recurrence),
      ...reminderCreateFields(ev),
    });
    if (result.success && result.eventId) {
      success++;
      if (ev.kind === 'reminder') {
        trackActivityAsync(pending.user.id, 'native_reminder_created', { bulk: true, for_partner: ev.forUserId != null, all_day: ev.allDay });
      }
```

`popEventFromBatch` (the ✏️ #N button) reads through `getPendingBatch` too, so the single card it opens now gets real Dates as well. Before, `formatEventDateTime` threw there on the strings.

- [ ] **Step 11: The ⏰ quick fix gives a reminder one time**

In `src/services/voice/quick-correction.ts`, `FieldPatch` (lines 43-48), the time hint (lines 82-84) and the time branch of `extractFieldPatch` (lines 137-138):

Find:

```ts
export interface FieldPatch {
  startTime?: Date;
  endTime?: Date;
  calendarId?: string;
  calendarName?: string;
}
```

Replace with:

```ts
export interface FieldPatch {
  startTime?: Date;
  endTime?: Date;
  allDay?: boolean; // a date-only reminder given a time becomes timed
  calendarId?: string;
  calendarName?: string;
}
```

Find:

```ts
  if (field === 'time') {
    fieldHint = `The user is correcting just the START TIME (and end time = start + duration). Return JSON: { "startTime": "HH:MM", "endTime": "HH:MM" }. The date stays the same as the current event.`;
  } else if (field === 'day') {
```

Replace with:

```ts
  if (field === 'time' && current.kind === 'reminder') {
    fieldHint = `The user is correcting just the TIME of a reminder, which has one time and no end. Return JSON: { "startTime": "HH:MM" }. The date stays the same as the current reminder.`;
  } else if (field === 'time') {
    fieldHint = `The user is correcting just the START TIME (and end time = start + duration). Return JSON: { "startTime": "HH:MM", "endTime": "HH:MM" }. The date stays the same as the current event.`;
  } else if (field === 'day') {
```

Find:

```ts
    const out: FieldPatch = {};
    if (field === 'time' && parsed.startTime && parsed.endTime) {
```

Replace with:

```ts
    const out: FieldPatch = {};
    if (field === 'time' && current.kind === 'reminder') {
      // One time on the reminder's own day, which a date-only reminder gets for the first time
      const datePart = formatInTimeZone(current.startTime, timezone, 'yyyy-MM-dd');
      const at = parsed.startTime ? fromZonedTime(`${datePart}T${parsed.startTime}:00`, timezone) : null;
      if (at && !isNaN(at.getTime())) {
        out.startTime = at;
        out.endTime = at;
        out.allDay = false;
      }
    } else if (field === 'time' && parsed.startTime && parsed.endTime) {
```

- [ ] **Step 12: Apply the quick fix's allDay**

The quick-fix patch is applied in `src/services/webhook-handlers.ts` (lines 291-292). Add `allDay` there; `showEventConfirmation` then works the card's notice out again.

Find:

```ts
            if (patch.startTime) pending.event.startTime = patch.startTime;
            if (patch.endTime) pending.event.endTime = patch.endTime;
```

Replace with:

```ts
            if (patch.startTime) pending.event.startTime = patch.startTime;
            if (patch.endTime) pending.event.endTime = patch.endTime;
            if (patch.allDay !== undefined) pending.event.allDay = patch.allDay;
```

- [ ] **Step 13: Reply-to-correct keeps a reminder a reminder**

In `src/services/voice/correction-handler.ts`, the imports (lines 17-18), the prompt (lines 37-58) and the rebuild (lines 161-188). For an event the prompt stays byte-identical: `reminderNote` is empty and takes the place of the blank line.

Find:

```ts
import { getPendingEvent, removePendingEvent, showEventConfirmation } from './confirmations';
import { buildEventTimes } from './gemini-voice';
```

Replace with:

```ts
import { getPendingEvent, removePendingEvent, showEventConfirmation } from './confirmations';
import { buildEventTimes } from './gemini-voice';
import { normalizeReminderTimes } from '../native-calendar/event-store';
```

Find:

```ts
  const endTimeStr = formatInTimeZone(event.endTime, timezone, 'HH:mm');

  return `You are correcting a calendar event based on user feedback.
```

Replace with:

```ts
  const endTimeStr = formatInTimeZone(event.endTime, timezone, 'HH:mm');
  // A reminder has one time: without this the model gives it the usual hour
  const reminderNote = event.kind === 'reminder'
    ? '\nThis is a REMINDER: it has one time and no end. Return endDate and endTime equal to startDate and startTime.\n'
    : '';

  return `You are correcting a calendar event based on user feedback.
```

Find:

```ts
- All day: ${event.allDay}

USER'S CALENDARS:
```

Replace with:

```ts
- All day: ${event.allDay}
${reminderNote}
USER'S CALENDARS:
```

Find:

```ts
    // Build corrected ParsedEvent
    const { start: startDateTime, end: endDateTime } = buildEventTimes(
      parsed.startDate, parsed.startTime, parsed.endDate, parsed.endTime, !!parsed.allDay, timezone
    );
```

Replace with:

```ts
    // Build corrected ParsedEvent. A reminder's end is its start, whatever the model sent.
    const reminder = event.kind === 'reminder';
    const { start: startDateTime, end: endDateTime } = buildEventTimes(
      parsed.startDate,
      parsed.startTime,
      reminder ? parsed.startDate : parsed.endDate,
      reminder ? parsed.startTime : parsed.endTime,
      !!parsed.allDay,
      timezone
    );
```

Find:

```ts
      confidence: 'high',
      recurrence: event.recurrence,
    };
```

Replace with:

```ts
      confidence: 'high',
      recurrence: event.recurrence,
    };
    if (reminder) {
      // A reminder keeps who it is for and its main calendar, and stays zero-length.
      // The card works its notice out again from the corrected time.
      const times = normalizeReminderTimes(startDateTime, correctedEvent.allDay, timezone);
      Object.assign(correctedEvent, {
        startTime: times.startsAt,
        endTime: times.endsAt,
        calendarId: event.calendarId,
        calendarName: event.calendarName,
        kind: event.kind,
        forPerson: event.forPerson,
        anchor: event.anchor,
        forUserId: event.forUserId,
        forName: event.forName,
        reminderNotice: event.reminderNotice,
      });
    }
```

- [ ] **Step 14: The Telegram voice handler**

In `src/services/voice/handler.ts`: the imports (line 20), the extraction (lines 337-345), the bulk branch (lines 376-378), the not-understood branch (line 397) and the auto-create/card branch (lines 414-423). Support is checked once per message (spec §9). An unsupported user gets `undefined` for the new argument, so their prompt is byte-identical to today's (Task 10), and no reminder code runs.

Find:

```ts
import { showEventConfirmation, showEditConfirmation, showDeleteConfirmation } from './confirmations';
```

Replace with:

```ts
import { sendAnchorQuestions, showEventConfirmation, showEditConfirmation, showDeleteConfirmation } from './confirmations';
import { getReminderSupport } from '../native-reminders/support';
import { reminderPromptContext, resolveReminderIntents } from '../native-reminders/resolve';
import type { ReminderFailure } from '../native-reminders/resolve';
```

Find:

```ts
    const recentBlock = formatRecentEventsBlock(recentEvents, timezone);
    const { intentResult, intentResults, transcription, metrics } = await processVoiceWithGemini(
      audioBuffer,
      user.language || 'en',
      userCalendars,
      timezone,
      recentBlock,
      priorAudio ?? undefined
    );
```

Replace with:

```ts
    const recentBlock = formatRecentEventsBlock(recentEvents, timezone);
    // Native reminders (spec R3), checked once per message. Without support the prompt
    // has no reminder rules and everything below runs as before.
    const support = await getReminderSupport(user);
    const extraction = await processVoiceWithGemini(
      audioBuffer,
      user.language || 'en',
      userCalendars,
      timezone,
      recentBlock,
      priorAudio ?? undefined,
      support.supported ? await reminderPromptContext(user) : undefined
    );
    const { transcription, metrics } = extraction;
    let { intentResult, intentResults } = extraction;
    // Each reminder gets its calendar, target and time before any card shows it
    let reminderFailures: ReminderFailure[] = [];
    if (support.supported) {
      const resolved = await resolveReminderIntents(user, intentResults ?? [intentResult], timezone);
      intentResults = resolved.intents;
      intentResult = resolved.intents[0];
      reminderFailures = resolved.failures;
    }
```

Find:

```ts
      await showBulkConfirmation(chatId, validBulk, user, transcription, t, messagingService, timezone);
      return;
    }
```

Replace with:

```ts
      await showBulkConfirmation(chatId, validBulk, user, transcription, t, messagingService, timezone);
      await sendAnchorQuestions(chatId, reminderFailures, user.language || 'en', messagingService);
      return;
    }
```

Find:

```ts
      if (!intentResult.event) {
        const safeTranscription = transcription.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
```

Replace with:

```ts
      if (!intentResult.event) {
        // A reminder anchored to an event that couldn't be found asks for a time instead
        if (reminderFailures.length > 0) {
          await sendAnchorQuestions(chatId, reminderFailures, user.language || 'en', messagingService);
          return;
        }
        const safeTranscription = transcription.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
```

Find:

```ts
      const { isAutoCreateEnabled, autoCreateEvent } = await import('./auto-create');
      if (
        intentResult.confidence === 'high' &&
        !intentResult.event.recurrence &&
        (await isAutoCreateEnabled())
      ) {
        const handled = await autoCreateEvent(user, intentResult.event, t, messagingService, chatId);
        if (handled) return;
      }
      await showEventConfirmation(chatId, undefined, intentResult.event, transcription, user, adminFooter, 'voice');
```

Replace with:

```ts
      const { isAutoCreateEnabled, autoCreateEvent } = await import('./auto-create');
      if (
        intentResult.confidence === 'high' &&
        !intentResult.event.recurrence &&
        // A reminder for a partner who can't be pinged waits for "keep as mine"
        intentResult.event.reminderNotice !== 'partner_not_on_telegram' &&
        (await isAutoCreateEnabled())
      ) {
        const handled = await autoCreateEvent(user, intentResult.event, t, messagingService, chatId);
        if (handled) {
          await sendAnchorQuestions(chatId, reminderFailures, user.language || 'en', messagingService);
          return;
        }
      }
      await showEventConfirmation(chatId, undefined, intentResult.event, transcription, user, adminFooter, 'voice');
      await sendAnchorQuestions(chatId, reminderFailures, user.language || 'en', messagingService);
```

`sendAnchorQuestions` sends nothing when the list is empty, which it always is for events and for unsupported users.

- [ ] **Step 15: The forwarded-text handler**

In `src/services/forward-event/handler.ts`, first the imports (line 15):

Find:

```ts
import { showEventConfirmation } from '../voice/confirmations';
```

Replace with:

```ts
import { sendAnchorQuestions, showEventConfirmation } from '../voice/confirmations';
import { getReminderSupport } from '../native-reminders/support';
import { reminderPromptContext, resolveReminderIntents } from '../native-reminders/resolve';
import type { ReminderFailure } from '../native-reminders/resolve';
```

Then replace everything from the line `const timezone = await resolveUserTimezone(user);` up to, but not including, the line `} catch (error) {` with:

```ts
    const timezone = await resolveUserTimezone(user);
    // Native reminders (spec R3). In forwarded text "me" is whoever forwarded it, so the
    // prompt names no partner and every reminder is the forwarder's own (spec §3.1).
    const support = await getReminderSupport(user);
    const extraction = await processTextWithGemini(
      messageText,
      user.language || 'en',
      userCalendars,
      timezone,
      support.supported ? await reminderPromptContext(user, { withPartner: false }) : undefined
    );
    const { metrics } = extraction;
    let { intentResult, intentResults } = extraction;
    let reminderFailures: ReminderFailure[] = [];
    if (support.supported) {
      const resolved = await resolveReminderIntents(user, intentResults ?? [intentResult], timezone, { selfOnly: true });
      intentResults = resolved.intents;
      intentResult = resolved.intents[0];
      reminderFailures = resolved.failures;
    }

    // Build admin footer from processing metrics
    const adminFooter = user.isAdmin
      ? `\n\n<i>📊 ${metrics.model} | ${metrics.inputTokens}→${metrics.outputTokens} tok | ${(metrics.durationMs / 1000).toFixed(1)}s</i>`
      : undefined;

    addBreadcrumb('forward_intent_detected', {
      intent: intentResult.intent,
      confidence: intentResult.confidence,
      has_event: !!intentResult.event,
    }, 'forward');

    console.log(`[Forward] Intent detected: ${intentResult.intent}, confidence: ${intentResult.confidence}`);

    // Stop typing before sending confirmation UI
    stopTyping();

    // Several events in one message: one card for all of them, as for voice
    const validBulk = (intentResults || []).filter(r => r.intent === 'create' && r.event && !r.error);
    if (validBulk.length > 1) {
      const { showBulkConfirmation } = await import('../voice/bulk-confirmations');
      await showBulkConfirmation(chatId, validBulk, user, messageText, t, messagingService, timezone);
      await sendAnchorQuestions(chatId, reminderFailures, user.language || 'en', messagingService);
      return;
    }

    if (intentResult.intent === 'create') {
      if (!intentResult.event) {
        // A reminder anchored to an event that couldn't be found asks for a time instead
        if (reminderFailures.length > 0) {
          await sendAnchorQuestions(chatId, reminderFailures, user.language || 'en', messagingService);
          return;
        }
        // No event found or low confidence
        await messagingService.sendMessage(chatId, t.voice.forwardNotUnderstood, { format: MessageFormat.HTML });
        return;
      }
      await showEventConfirmation(chatId, undefined, intentResult.event, messageText, user, adminFooter);
      await sendAnchorQuestions(chatId, reminderFailures, user.language || 'en', messagingService);

    } else if (intentResult.intent === 'edit') {
      await handleEditIntent(chatId, undefined, intentResult, messageText, user, t, adminFooter);

    } else if (intentResult.intent === 'delete') {
      await handleDeleteIntent(chatId, undefined, intentResult, messageText, user, t, adminFooter);
    }
```

Task 10 already reshaped this region: `processTextWithGemini` returns `intentResults`, and there is a multi-intent branch reusing the voice bulk card. Replace the whole region with this version, whatever Task 10 left there, rather than merging line by line. It keeps Task 10's multi-intent branch and adds the reminder resolution and the anchor questions. If Task 10 also changed the `../voice/confirmations` import line, add `sendAnchorQuestions` to whichever import of that module it left. Forwarded text never auto-creates, as before.

- [ ] **Step 16: WhatsApp voice: reminders for users linked to Telegram**

In `src/services/webhook-handlers.ts`, a type import (after line 27), then `handleWhatsAppVoice` (lines 914-1098) and `handleWhatsAppVoiceCallback`'s `event_create` branch (lines 1139-1162). A WhatsApp-only user fails the support check (no `telegramId`), so their prompt and every reply stay exactly as today. A user linked to Telegram can create reminders here; the ping goes to Telegram (spec §3.1).

The reminder modules load inside the two functions, with `await import(…)`, the way this file already loads everything its WhatsApp paths need. Static imports would pull `subscription-service`, the calendar-provider barrel, `event-resolution` and the AI SDKs into every load of this file, and Task 9's `smoke-native-reminder-buttons.ts` loads it with stubs for the callback path only. Only the type import is static; it is erased at runtime.

Find:

```ts
import { isIdentifierBlocked, isUserSuspended } from '../lib/user-moderation';
```

Replace with:

```ts
import { isIdentifierBlocked, isUserSuspended } from '../lib/user-moderation';
import type { ReminderFailure } from './native-reminders/resolve';
```

Find:

```ts
    const recentBlock = formatRecentEventsBlock(recentEvents, timezone);
    const { intentResult, intentResults, transcription } = await processVoiceWithGemini(
      audioBuffer,
      user.language || 'en',
      userCalendars,
      timezone,
      recentBlock
    );
```

Replace with:

```ts
    const recentBlock = formatRecentEventsBlock(recentEvents, timezone);
    // Native reminders (spec R3): only users linked to Telegram, where the ping goes
    const { getReminderSupport } = await import('./native-reminders/support');
    const { reminderPromptContext, resolveReminderIntents, reminderCreateFields, refreshReminderNotice } =
      await import('./native-reminders/resolve');
    const support = await getReminderSupport(user);
    const extraction = await processVoiceWithGemini(
      audioBuffer,
      user.language || 'en',
      userCalendars,
      timezone,
      recentBlock,
      undefined,
      support.supported ? await reminderPromptContext(user) : undefined
    );
    const { transcription } = extraction;
    let { intentResult, intentResults } = extraction;
    let reminderFailures: ReminderFailure[] = [];
    if (support.supported) {
      const resolved = await resolveReminderIntents(user, intentResults ?? [intentResult], timezone);
      intentResults = resolved.intents;
      intentResult = resolved.intents[0];
      reminderFailures = resolved.failures;
    }
    const askAboutReminders = async () => {
      if (reminderFailures.length === 0) return;
      const { anchorQuestion } = await import('./voice/confirmations');
      for (const failure of reminderFailures) {
        await waService.sendMessage(phone, await anchorQuestion(failure, user.language || 'en', false));
      }
    };
```

Find:

```ts
      const allHigh = validBulkWa.every(
        (r) => r.confidence === 'high' && !r.event!.recurrence
      );
```

Replace with:

```ts
      // A reminder for a partner who can't be pinged needs "keep as mine" first
      const allHigh = validBulkWa.every(
        (r) => r.confidence === 'high' && !r.event!.recurrence && r.event!.reminderNotice !== 'partner_not_on_telegram'
      );
```

Find:

```ts
          allDay: ev.allDay,
          recurrence: buildRecurrenceRule(ev.recurrence),
        });
        if (result.success && result.eventId) {
          successCount++;
          successTitles.push(ev.title);
```

Replace with:

```ts
          allDay: ev.allDay,
          recurrence: buildRecurrenceRule(ev.recurrence),
          ...reminderCreateFields(ev),
        });
        if (result.success && result.eventId) {
          successCount++;
          successTitles.push(ev.title);
          if (ev.kind === 'reminder') {
            trackActivityAsync(user.id, 'native_reminder_created', { platform: 'whatsapp', auto: true, bulk: true });
          }
```

Find:

```ts
          .replace('{errors}', failures.map((e) => `• ${e}`).join('\n'));
      }
      await waService.sendMessage(phone, summary);
      return;
    }
```

Replace with:

```ts
          .replace('{errors}', failures.map((e) => `• ${e}`).join('\n'));
      }
      await waService.sendMessage(phone, summary);
      await askAboutReminders();
      return;
    }
```

Find:

```ts
      if (intentResult.confidence === 'high' && !intentResult.event.recurrence) {
        // Auto-create directly. No confirmation, no Undo button (WhatsApp
        // template/button surface is constrained — see TG flow for full Undo).
        const { getProviderForUser } = await import('./calendar-provider');
        const { buildRecurrenceRule } = await import('./calendar');
        const provider = getProviderForUser(user);
        const result = await provider.createEvent(user, intentResult.event.calendarId || 'primary', {
          title: intentResult.event.title,
          startTime: intentResult.event.startTime,
          endTime: intentResult.event.endTime,
          location: intentResult.event.location,
          description: intentResult.event.description,
          allDay: intentResult.event.allDay,
          recurrence: buildRecurrenceRule(intentResult.event.recurrence),
        });
```

Replace with:

```ts
      const reminder = intentResult.event.kind === 'reminder';
      if (
        intentResult.confidence === 'high' &&
        !intentResult.event.recurrence &&
        intentResult.event.reminderNotice !== 'partner_not_on_telegram'
      ) {
        // Auto-create directly. No confirmation, no Undo button (WhatsApp
        // template/button surface is constrained — see TG flow for full Undo).
        const { getProviderForUser } = await import('./calendar-provider');
        const { buildRecurrenceRule } = await import('./calendar');
        const provider = getProviderForUser(user);
        const result = await provider.createEvent(user, intentResult.event.calendarId || 'primary', {
          title: intentResult.event.title,
          startTime: intentResult.event.startTime,
          endTime: intentResult.event.endTime,
          location: intentResult.event.location,
          description: intentResult.event.description,
          allDay: intentResult.event.allDay,
          recurrence: buildRecurrenceRule(intentResult.event.recurrence),
          ...reminderCreateFields(intentResult.event),
        });
```

Find:

```ts
          trackActivityAsync(user.id, 'voice_event_created', { platform: 'whatsapp', auto: true });
          incrementUsage(user.id, 'voiceEvents').catch((e) =>
            captureError(e, 'usage-increment', { user_id: user.id }, 'warning')
          );
          await waService.sendMessage(
            phone,
            `✅ ${t.voice?.created || 'Event created!'}\n\n*${intentResult.event.title}*`
          );
```

Replace with:

```ts
          trackActivityAsync(user.id, 'voice_event_created', { platform: 'whatsapp', auto: true });
          if (reminder) trackActivityAsync(user.id, 'native_reminder_created', { platform: 'whatsapp', auto: true });
          incrementUsage(user.id, 'voiceEvents').catch((e) =>
            captureError(e, 'usage-increment', { user_id: user.id }, 'warning')
          );
          const { reminderCreatedLine } = await import('./voice/confirmations');
          const createdLine = reminder
            ? await reminderCreatedLine(intentResult.event, user.language || 'en', timezone, false)
            : `✅ ${t.voice?.created || 'Event created!'}`;
          await waService.sendMessage(phone, `${createdLine}\n\n*${intentResult.event.title}*`);
```

Find:

```ts
      const pendingId = `wa:${phone}:${Date.now()}`;
      await redis.set(REDIS_KEYS.pendingEvent(pendingId), { event: intentResult.event, user, transcription }, { ex: 600 });

      const { formatEventDateTime } = await import('./voice/confirmations');
      const dateTimeStr = formatEventDateTime(intentResult.event, user.language || 'en', t.voice?.allDay || 'All day', timezone);
      const locationStr = intentResult.event.location ? `\n📍 ${intentResult.event.location}` : '';

      await waService.sendMessage(phone,
        `*${wa.createEvent || 'Create event?'}*\n\n*${intentResult.event.title}*\n${dateTimeStr}${locationStr}\n\n_"${transcription}"_`,
        {
          whatsappButtons: [
            { id: `event_create:${pendingId}`, title: wa.createButton || '✅ Create' },
```

Replace with:

```ts
      const pendingId = `wa:${phone}:${Date.now()}`;
      const pendingEvent = reminder ? refreshReminderNotice(intentResult.event, timezone) : intentResult.event;
      await redis.set(REDIS_KEYS.pendingEvent(pendingId), { event: pendingEvent, user, transcription }, { ex: 600 });

      const { formatEventDateTime, formatReminderCard } = await import('./voice/confirmations');
      let card: string;
      if (reminder) {
        card = await formatReminderCard(pendingEvent, user.language || 'en', timezone, 'whatsapp');
      } else {
        const dateTimeStr = formatEventDateTime(intentResult.event, user.language || 'en', t.voice?.allDay || 'All day', timezone);
        const locationStr = intentResult.event.location ? `\n📍 ${intentResult.event.location}` : '';
        card = `*${wa.createEvent || 'Create event?'}*\n\n*${intentResult.event.title}*\n${dateTimeStr}${locationStr}`;
      }
      // A partner who can't be pinged: confirming keeps the reminder as the creator's
      const createTitle = pendingEvent.reminderNotice === 'partner_not_on_telegram'
        ? t.nativeReminders.card.keepAsMine
        : wa.createButton || '✅ Create';

      await waService.sendMessage(phone,
        `${card}\n\n_"${transcription}"_`,
        {
          whatsappButtons: [
            { id: `event_create:${pendingId}`, title: createTitle },
```

Find:

```ts
    } else if (intentResult.error === NO_SPEECH) {
      // Silence or noise - there is no transcript to quote back.
```

Replace with:

```ts
    } else if (reminderFailures.length > 0) {
      // A reminder anchored to an event that couldn't be found asks for a time instead
      await askAboutReminders();
    } else if (intentResult.error === NO_SPEECH) {
      // Silence or noise - there is no transcript to quote back.
```

In `handleWhatsAppVoiceCallback`'s `event_create` branch, find (lines 1139-1141):

```ts
      const { buildRecurrenceRule } = await import('./calendar');
      const { getProviderForUser } = await import('./calendar-provider');
      const provider = getProviderForUser(pending.user);
```

Replace with:

```ts
      const { buildRecurrenceRule } = await import('./calendar');
      const { getProviderForUser } = await import('./calendar-provider');
      const { reminderCreateFields } = await import('./native-reminders/resolve');
      const provider = getProviderForUser(pending.user);
```

Find:

```ts
          allDay: pending.event.allDay,
          recurrence: buildRecurrenceRule(pending.event.recurrence),
        }
      );

      await removePendingEvent(pendingId);

      if (result.success) {
        await waService.sendMessage(phone, `✅ ${t.voice?.created || 'Event created!'}\n\n*${pending.event.title}*`);

        const { incrementUsage } = await import('./subscription-service');
        const { trackActivityAsync } = await import('./analytics-service');
        trackActivityAsync(pending.user.id, 'voice_event_created', { platform: 'whatsapp' });
```

Replace with:

```ts
          allDay: pending.event.allDay,
          recurrence: buildRecurrenceRule(pending.event.recurrence),
          ...reminderCreateFields(pending.event),
        }
      );

      await removePendingEvent(pendingId);

      if (result.success) {
        const reminder = pending.event.kind === 'reminder';
        let createdLine = `✅ ${t.voice?.created || 'Event created!'}`;
        if (reminder) {
          const { reminderCreatedLine } = await import('./voice/confirmations');
          const { resolveUserTimezone } = await import('../lib/timezone');
          const timezone = await resolveUserTimezone(pending.user);
          createdLine = await reminderCreatedLine(pending.event, pending.user.language || 'en', timezone, false);
        }
        await waService.sendMessage(phone, `${createdLine}\n\n*${pending.event.title}*`);

        const { incrementUsage } = await import('./subscription-service');
        const { trackActivityAsync } = await import('./analytics-service');
        trackActivityAsync(pending.user.id, 'voice_event_created', { platform: 'whatsapp' });
        if (reminder) trackActivityAsync(pending.user.id, 'native_reminder_created', { platform: 'whatsapp' });
```

For an event every WhatsApp message is byte-identical to before: the medium card is the same string, built in two parts; the created line is the same `✅ …`; and the button title is the same fallback chain. The bulk loop's `trackActivityAsync` is the one already imported above the loop (line 950). The WhatsApp paths have no smoke harness (the webhook needs the lock, the adapter and the media download), so type-check and lint cover them, and Task 14's dev-DB pass exercises one. The existing quirks stay as they are: a HIGH single event auto-creates without the admin flag, and the card's confirm drops `description`.

- [ ] **Step 17: Keep Task 10's extraction smoke standing**

The forwarded-text handler now calls `getReminderSupport`, and `sendAnchorQuestions` after the card and after the bulk card. Task 10's `scripts/smoke-native-reminder-creation.ts` stubs `confirmations.ts` with `showEventConfirmation` alone and leaves `support.ts` real. Without the edit below, two things break:
- the handler calls an undefined `sendAnchorQuestions` after the card, its catch sends an error, and the "single card" and "bulk card … `sent.length === 0`" checks fail;
- the real `support.ts` reads Upstash through the script's blocked `fetch`, and "nothing reached the network" fails.

Those checks pin the forwarded flow without reminder support, so the stub turns support off.

In `scripts/smoke-native-reminder-creation.ts`, find (in the `stubs` map):

```ts
  [`${SRC}/services/voice/confirmations.ts`]: {
    showEventConfirmation: async (...args: unknown[]) => { cardCalls.push(args); },
  },
```

Replace with:

```ts
  [`${SRC}/services/voice/confirmations.ts`]: {
    showEventConfirmation: async (...args: unknown[]) => { cardCalls.push(args); },
    sendAnchorQuestions: async () => {},
  },
  // Reminders off: these checks pin the forwarded flow without reminder support (Task 11)
  [`${SRC}/services/native-reminders/support.ts`]: { getReminderSupport: async () => ({ supported: false, reason: 'disabled' }) },
```

Run it:

```bash
for tz in UTC Asia/Jerusalem; do TZ=$tz npx tsx scripts/smoke-native-reminder-creation.ts | tail -1; done
```

Expected: the same `N/N passed` as at the end of Task 10, under both clocks.

- [ ] **Step 18: Run tests to verify they pass**

```bash
TZ=UTC npx tsx scripts/smoke-native-reminder-create-flow.ts
TZ=Asia/Jerusalem npx tsx scripts/smoke-native-reminder-create-flow.ts
for s in smoke-native-reminder-creation smoke-voice-dates smoke-reminders smoke-day-shaping smoke-week-lookahead \
  smoke-native-reminder-ownership smoke-native-reminder-store smoke-native-reminder-support smoke-native-provider-reminders \
  smoke-partner-labels smoke-native-reminder-digest smoke-native-reminders smoke-native-reminder-buttons; do
  for tz in UTC Asia/Jerusalem; do echo "$s TZ=$tz: $(TZ=$tz npx tsx scripts/$s.ts | tail -1)"; done
done
npx tsc --noEmit -p .
npm run -s lint
```

Expected:
- **`smoke-native-reminder-create-flow.ts`:** 39 `OK` lines, then `39/39 passed (process TZ=UTC)` and `39/39 passed (process TZ=Asia/Jerusalem)`, exit 0. The `[Voice] …`, `[Forward] …` and `[Correction] …` log lines in between come from the real handlers and are expected.
- **The other scripts:** each prints `N/N passed` with the same N as before this task, under both clocks.
  - On today's `main` the counts are `smoke-voice-dates` 66, `smoke-reminders` 20, `smoke-day-shaping` 24 and `smoke-week-lookahead` 18, plus whatever Tasks 3, 5, 7 and 10 added. The `smoke-native-*` and `smoke-partner-labels` counts are the ones Tasks 1-10 left.
  - `smoke-voice-dates` loads the changed `event-resolution.ts`; its matcher calls pass no options, so they are unchanged.
  - `smoke-native-reminder-buttons` loads `webhook-handlers.ts`, which this task changes. A drop there, or in `smoke-native-reminders`, is this task's to fix.
- **`tsc` and `lint`:** no output, exit 0.

If `smoke-reminders` shows `3/20 passed` with `Cannot access 'NATIVE_CALENDAR_ID_PREFIX' before initialization`, Task 2's Step 4 (its Proxy fake of the store) is missing. That failure is not this task's.

- [ ] **Step 19: Commit**

```bash
git add src/services/native-reminders/resolve.ts src/services/event-parser.ts \
  src/services/voice/event-resolution.ts src/services/voice/confirmations.ts src/services/voice/tts-outcome.ts \
  src/services/voice/callbacks.ts src/services/voice/auto-create.ts src/services/voice/bulk-confirmations.ts \
  src/services/voice/quick-correction.ts src/services/voice/correction-handler.ts src/services/voice/handler.ts \
  src/services/forward-event/handler.ts src/services/webhook-handlers.ts \
  scripts/smoke-native-reminder-create-flow.ts scripts/smoke-native-reminder-creation.ts
git commit -F - <<'EOF'
feat(reminders): create reminders from voice and forwarded text

Each reminder is resolved before its card shows: it goes on the creator's
main calendar whatever the model picked, it is the partner's only when the
partner can be pinged, and "an hour before the dentist" is placed from the
calendar (or asked about when it can't be). The card, the confirm,
auto-create, the bulk card, reply-to-correct and the quick time fix carry
it through to the provider as a zero-length reminder. Forwarded text keeps
every reminder the forwarder's, and WhatsApp voice creates them only for
users linked to Telegram. The card shows the date; the created reply says
"today at 17:00" or "tomorrow" when it can.

Also fixes the bulk confirm crash (dates came back from Redis as strings)
and escapes titles in the creation messages.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
EOF
```

---

### Task 12: Typed text route

Typed text that isn't a command is dropped today (`webhook-handlers.ts:466-476` only looks for `accept <token>`). This task routes a typed message that names a reminder (spec §3.1) to text-mode extraction, for users who pass the R3 gate, and turns every create it yields into a reminder card (R4). Edits and deletes go to the existing chat flows. Nobody else sees a change: Google users, users without the feature and ordinary chat stay ignored, and forwarded text keeps its exact prompt.

**Files:**
- Create: `src/services/native-reminders/typed-route.ts` — `REMINDER_KEYWORDS`, `hasReminderKeyword`, `asTypedReminder` and `handleTypedReminderText` (processing message, duplicate-delivery lock, extraction marked as typed, coercion to reminders, resolution through Task 11's `resolveReminderIntents`, card, bulk card, anchor questions, edit/delete flows, "not understood").
- Modify: `src/services/forward-event/gemini-text.ts:24-26, 31-37, 52` (line numbers before Task 10; the signature snippet quotes Task 10's `reminders` parameter, and Task 10 leaves the other two snippets alone; Task 11 doesn't touch this file) — add `TextSource` and an optional `source` parameter. Typed text gets a header saying the user typed it; forwarded text keeps `FORWARDED MESSAGE:` byte for byte.
- Modify: `src/services/webhook-handlers.ts:466-479` (line numbers of `main`; Task 9's `nr:` branch and Task 11's type import land above it, so the block moves down a few lines, but neither touches it) — the typed-text `else` calls a new `routeTypedReminderText` when there is no `accept` token; the new helper sits right after `handleTelegramWebhook`.
- Test: `scripts/smoke-native-reminder-typed.ts` (new). It is a separate script, not part of Task 10's `scripts/smoke-native-reminder-creation.ts` or Task 11's `scripts/smoke-native-reminder-create-flow.ts`: it has to fake `resolve.ts`, `confirmations.ts`, `bulk-confirmations.ts` and `ai-provider.ts` for the whole process, and Task 11's script tests those modules for real.

**Interfaces:**
- Consumes:
  - Task 4, `src/services/native-reminders/support.ts`: `getReminderSupport(user: { id: number; calendarSource: string; telegramId?: bigint | number | string | null }): Promise<ReminderSupport>`. Also the copy `bot.nativeReminders.typed.processing` and `typed.notUnderstood`, read through `getBotMessages` and sent with `MessageFormat.PLAIN`.
  - Task 10, `src/services/event-parser.ts`: `ParsedEvent.kind?: 'reminder'` (set only on reminders; an event never carries `kind`, so test `kind === 'reminder'`), `forPerson?: 'self' | 'partner'` and `anchor?: { description: string; offsetMinutes: number }`. With reminders on, the parser keeps an anchor reminder that has no start date as a create with `anchor` set and no `error`. A reminder with no `endTime` parses with end = start.
  - Task 10, `src/services/voice/gemini-voice.ts`: `ReminderPromptContext { userName; userEnglishName?; partnerName?; partnerEnglishName? }`. The prompt names the user and the partner when it is given.
  - Task 10, `src/services/forward-event/gemini-text.ts`: `processTextWithGemini(text, language, calendars, timezone, reminders?: ReminderPromptContext)`, where `reminders?: ReminderPromptContext` is the last parameter, right before `): Promise<`. It resolves to `{ intentResult, intentResults: VoiceIntentResult[], metrics: TextProcessingMetrics }` (`intentResults` from `extractIntents`, always at least one entry; `intentResult === intentResults[0]`). This task reads `intentResults` and `metrics`, and adds the `source` parameter.
  - Task 11, `src/services/native-reminders/resolve.ts`:
    - `reminderPromptContext(user: UserConfig, options?: { withPartner?: boolean }): Promise<ReminderPromptContext>`, called with no options, so the prompt names the user and the ACTIVE partner (typed text is the user's own words).
    - `ReminderFailure { error: 'anchor_not_found' | 'anchor_ambiguous' | 'anchor_needs_time'; description: string }` and `resolveReminderIntents(user: UserConfig, intents: VoiceIntentResult[], timezone: string, options?: { selfOnly?: boolean; now?: Date }): Promise<{ intents: VoiceIntentResult[]; failures: ReminderFailure[] }>`, called with no options (never `selfOnly`). It resolves only creates whose `event.kind === 'reminder'`, which is why the typed route coerces every create first. It is the only writer of `forUserId`, `forName` and `reminderNotice`. A reminder that can't be placed comes back as `{ intent: 'create', confidence, error }` with no `event`, plus a `failures` entry. Other intents pass through untouched.
  - Task 11, `src/services/event-parser.ts`: `ParsedEvent.forUserId?: number | null`, `forName?: string` and `reminderNotice?: 'partner_not_on_telegram' | 'no_time_set'`, written only by `resolveReminderIntents`. The card, its pending payload and its confirm read them; this task only passes the resolved event on.
  - Task 11, `src/services/voice/confirmations.ts`: `sendAnchorQuestions(chatId: number | string, failures: ReminderFailure[], language: string, service: IMessagingService): Promise<void>`. It sends one escaped HTML question per failure and nothing for an empty list.
  - Task 11, existing signatures with reminder support added: `showEventConfirmation(chatId, messageId, event, transcription, user, adminFooter?, inputModality?)` renders the reminder card when `event.kind === 'reminder'`. `showBulkConfirmation(chatId, intents, user, transcription, t, service, timezone)` renders and creates reminders.
  - Existing: `handleEditIntent` / `handleDeleteIntent` from `src/services/voice` (`(chatId, messageId | undefined, intentResult, transcription, user, t, adminFooter?)`), `acquireVoiceLock(key, ttlSeconds?)` from `src/utils/redis-lock.ts`, `startTypingInterval(chatId, service)` from `src/services/telegram/command-pipeline.ts`, and `hasUsableCalendar` / `getCalendarAssignmentsForUser` from `src/services/calendar-provider`.
- Produces:
  ```ts
  // src/services/native-reminders/typed-route.ts
  export const REMINDER_KEYWORDS: readonly string[];
  export function hasReminderKeyword(text: string): boolean;
  export function asTypedReminder(result: VoiceIntentResult): VoiceIntentResult; // create → kind 'reminder', end = start
  export async function handleTypedReminderText(user: UserConfig, chatId: number, text: string, messageId: number): Promise<void>; // never throws
  // src/services/forward-event/gemini-text.ts
  export type TextSource = 'forwarded' | 'typed';
  // processTextWithGemini(text, language, calendars, timezone, reminders?, source: TextSource = 'forwarded')
  ```
  - `messageId` is the user's Telegram message id. It keys a duplicate-delivery lock (`voice:lock:typed:<chatId>:<messageId>`, 120 s).
  - Typed creates never auto-create. A single reminder gets `showEventConfirmation(…, 'text')`, and two or more get `showBulkConfirmation`.
  - The event handed to either card is the one `resolveReminderIntents` returned: `kind: 'reminder'`, `calendarId`, `startTime`, `endTime`, `allDay`, `forUserId`, `forName` and `reminderNotice` set, `calendarName` and `anchor` cleared.
  - A reminder that can't be placed gets no card. After the card (or alone, when nothing else survived, and then with no "not understood"), `sendAnchorQuestions` asks about each failure.

- [ ] **Step 1: Write the failing test**

Create `scripts/smoke-native-reminder-typed.ts`:

```ts
// Smoke test for typed "remind me…" messages (spec §3.1, R4): the keyword filter, the
// Telegram webhook's typed-text branch and src/services/native-reminders/typed-route.ts.
// Typed text that isn't a command used to be dropped. Now a message with a reminder keyword,
// from a user who has native reminders, goes to text-mode extraction marked as typed; every
// create becomes a reminder card, edits and deletes take the chat flows, and nothing changes
// for anyone else. The webhook, the typed route and text extraction (gemini-text with the
// real prompt builder and parser) run for real; Gemini, Telegram, Redis, the user lookup, the
// support gate, reminder resolution (Task 11's resolve.ts), the cards and the anchor
// questions are faked. No network, no DB.
//
// Run under both clocks; the output must not depend on the server's timezone:
//   TZ=UTC npx tsx scripts/smoke-native-reminder-typed.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-native-reminder-typed.ts

import Module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromZonedTime } from 'date-fns-tz';
import type { ParsedEvent, VoiceIntentResult } from '../src/services/event-parser';
import type { UserConfig } from '../src/types';

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
}

function assert(cond: boolean, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

// ---- Environment: fakes only, set before anything under test loads ----

process.env.NEXT_PUBLIC_APP_URL = 'https://famcal.test';
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.GEMINI_API_KEY = 'test-key';
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.UPSTASH_REDIS_REST_URL = 'https://redis.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
process.env.DATABASE_URL = 'postgresql://test@db.invalid/test';

/** Any request that slips past the fakes is refused and counted. */
const networkAttempts: string[] = [];
globalThis.fetch = (async (input: unknown) => {
  networkAttempts.push(String(input));
  throw new Error('network is blocked in this smoke test');
}) as typeof fetch;

/** Intervals still running: the typing indicator must stop on every path. */
const liveIntervals = new Set<unknown>();
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
globalThis.setInterval = ((fn: (...args: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
  const handle = realSetInterval(fn, ms, ...rest);
  liveIntervals.add(handle);
  return handle;
}) as unknown as typeof setInterval;
globalThis.clearInterval = ((handle?: Parameters<typeof clearInterval>[0]) => {
  liveIntervals.delete(handle);
  realClearInterval(handle);
}) as typeof clearInterval;

// ---- Fixtures ----

const IL = 'Asia/Jerusalem';
const RAZIEL = 1001; // NATIVE, English, paired with Dana, has native reminders
const GOOGLE = 1003; // a Google-calendar user
const NO_ACCESS = 1004; // NATIVE, but without the reminders feature
const NOA = 1005; // NATIVE, Hebrew, unpaired
const STRANGER = 1009; // never registered

function makeUser(id: number, telegramId: number, extra: Record<string, unknown>): UserConfig {
  return {
    id, telegramId, name: 'Raziel', englishName: 'Raziel', gender: 'male', language: 'en',
    calendarSource: 'NATIVE', googleRefreshToken: '', pairingId: null, isAdmin: false,
    suspendedAt: null, unreachableSince: null, voiceInputEnabled: false,
    ...extra,
  } as unknown as UserConfig;
}

const USERS: Record<number, UserConfig> = {
  [RAZIEL]: makeUser(1, RAZIEL, { pairingId: 'pair-1' }),
  [GOOGLE]: makeUser(3, GOOGLE, { calendarSource: 'GOOGLE', googleRefreshToken: 'refresh-token' }),
  [NO_ACCESS]: makeUser(4, NO_ACCESS, {}),
  [NOA]: makeUser(5, NOA, { name: 'נועה', englishName: 'Noa', gender: 'female', language: 'he' }),
};
const DANA = { id: 2, name: 'Dana', englishName: 'Dana' }; // Raziel's partner, on Telegram
// Named so that neither person's name reaches the prompt through the calendar list.
const CALENDARS = [
  { calendarId: 'native:raziel-cal', labels: ['primary', 'yours'], name: 'Home', color: '#000' },
  { calendarId: 'native:dana-cal', labels: ['spouse'], name: 'Shared', color: '#111' },
];

// ---- Fakes ----

/** Gemini: each call takes the next scripted answer (model JSON, or an Error to throw). */
let geminiAnswers: Array<object | Error> = [];
let geminiPrompts: string[] = [];
const fakeGemini = {
  models: {
    generateContent: async (request: { contents: Array<{ parts: Array<{ text?: string }> }> }) => {
      geminiPrompts.push(request.contents[0].parts.map(p => p.text ?? '').join(''));
      const answer = geminiAnswers.shift();
      if (!answer) throw new Error('no scripted Gemini answer left');
      if (answer instanceof Error) throw answer;
      return { text: JSON.stringify(answer), usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } };
    },
  },
};

type Sent = { chatId: number | string; text: string; format?: string };
let sent: Sent[] = [];
let deleted: Array<number | string> = [];
let nextMessageId = 900;
const fakeService = {
  sendMessage: async (chatId: number | string, text: string, options?: { format?: string }) => {
    sent.push({ chatId, text, format: options?.format });
    return nextMessageId++;
  },
  deleteMessage: async (_chatId: number | string, messageId: number | string) => {
    deleted.push(messageId);
  },
  updateMessage: async () => {},
  sendTypingIndicator: async () => {},
};

type Card = { chatId: number; messageId: number | undefined; event: ParsedEvent; transcription: string; user: UserConfig; inputModality: string };
let cards: Card[] = [];
let bulkCards: Array<{ chatId: number | string; intents: VoiceIntentResult[]; transcription: string }> = [];
let changeFlows: Array<{ kind: 'edit' | 'delete'; chatId: number; messageId: number | undefined; result: VoiceIntentResult; transcription: string }> = [];
let pairAccepts: string[] = [];
let commands: string[] = [];
let supportChecks: number[] = [];
let resolveCalls: ParsedEvent[] = [];
let resolveOptions: Array<{ selfOnly?: boolean } | undefined> = [];
type Failure = { error: 'anchor_not_found' | 'anchor_ambiguous' | 'anchor_needs_time'; description: string };
/** sendAnchorQuestions calls, with how many cards were already shown at the time. */
let anchorCalls: Array<{ chatId: number | string; failures: Failure[]; language: string; service: unknown; cardsBefore: number }> = [];
let captured: string[] = [];
const locks = new Set<string>();

/**
 * Task 11's resolveReminderIntents as the typed route sees it. Each reminder create gets the
 * main calendar, the partner when asked for (and not selfOnly), its parsed time with end =
 * start, and "no time set" when date-only; an anchor is never found. Like the real one, it
 * resolves only `kind === 'reminder'` creates, swaps a failed one for an error intent with
 * no event, and passes every other intent through untouched.
 */
const fakeResolveIntents = async (
  _user: UserConfig, intents: VoiceIntentResult[], _timezone: string, options?: { selfOnly?: boolean }
) => {
  resolveOptions.push(options);
  const failures: Failure[] = [];
  const resolved = intents.map((intent): VoiceIntentResult => {
    const event = intent.event;
    if (intent.intent !== 'create' || event?.kind !== 'reminder') return intent;
    resolveCalls.push(event);
    if (event.anchor) {
      failures.push({ error: 'anchor_not_found', description: event.anchor.description });
      return { intent: 'create', confidence: intent.confidence, error: 'anchor_not_found' };
    }
    const forPartner = event.forPerson === 'partner' && !options?.selfOnly;
    return {
      ...intent,
      event: {
        ...event,
        calendarId: 'native:raziel-cal',
        calendarName: undefined,
        endTime: event.startTime,
        anchor: undefined,
        forUserId: forPartner ? DANA.id : null,
        forName: forPartner ? DANA.name : undefined,
        reminderNotice: event.allDay ? 'no_time_set' : undefined,
      },
    };
  });
  return { intents: resolved, failures };
};

/** Task 11's reminderPromptContext: Raziel and Dana, unless the caller leaves the partner out. */
const fakePromptContext = async (user: UserConfig, options?: { withPartner?: boolean }) => {
  const partner = user.id === 1 && options?.withPartner !== false ? DANA : null;
  return {
    userName: user.name,
    userEnglishName: user.englishName || null,
    partnerName: partner?.name ?? null,
    partnerEnglishName: partner?.englishName ?? null,
  };
};

const SRC = path.resolve(__dirname, '../src');
const noop = () => {};
const asyncNoop = async () => {};

/** Modules replaced by fakes, by file path. */
const stubs: Record<string, object> = {
  [`${SRC}/services/ai-provider.ts`]: {
    getGemini: () => fakeGemini,
    extractionConfig: () => ({}),
    getAnthropic: () => { throw new Error('no Anthropic in this test'); },
    generateAICompletion: async () => { throw new Error('no AI completion in this test'); },
    streamAICompletion: async () => { throw new Error('no AI stream in this test'); },
  },
  [`${SRC}/utils/redis.ts`]: { redis: { get: async () => null, set: async () => 'OK', del: async () => 0 } },
  [`${SRC}/utils/redis-lock.ts`]: {
    acquireVoiceLock: async (key: string) => (locks.has(key) ? false : (locks.add(key), true)),
    releaseVoiceLock: async (key: string) => { locks.delete(key); },
  },
  [`${SRC}/utils/prisma.ts`]: {
    prisma: new Proxy({}, { get: (_t, model) => { throw new Error(`the database was read (${String(model)})`); } }),
  },
  [`${SRC}/lib/error-capture.ts`]: {
    captureError: (_err: unknown, context: string) => { captured.push(context); },
    captureWarning: noop,
    captureInfo: noop,
  },
  [`${SRC}/lib/user-moderation.ts`]: { isIdentifierBlocked: async () => false, isUserSuspended: () => false },
  [`${SRC}/lib/timezone.ts`]: { resolveUserTimezone: async () => IL },
  [`${SRC}/services/analytics-service.ts`]: { setUserContext: noop, addBreadcrumb: noop, trackActivityAsync: noop, trackActivity: asyncNoop },
  [`${SRC}/services/payment-handler.ts`]: { handlePreCheckoutQuery: asyncNoop, handleSuccessfulPayment: asyncNoop },
  [`${SRC}/services/user-service.ts`]: {
    getUserByTelegramId: async (telegramId: number) => USERS[Number(telegramId)] ?? null,
    getOrCreateUser: async (telegramId: number) => USERS[Number(telegramId)],
    getUserByWhatsAppPhone: async () => null,
    getOrCreateUserByWhatsApp: async () => null,
  },
  [`${SRC}/services/telegram/index.ts`]: {
    getBot: () => ({}),
    getMessagingService: () => fakeService,
    handleStartCommand: async () => { commands.push('/start'); },
    handleSummaryCommand: async () => { commands.push('/summary'); },
    handleWeatherCommand: async () => { commands.push('/weather'); },
    handleFeedbackCommand: async () => { commands.push('/feedback'); },
    handleConnectCommand: async () => { commands.push('/connect'); },
  },
  [`${SRC}/services/telegram/pair-handler.ts`]: {
    parseAcceptCommand: (text: string) => text.trim().match(/^\/?accept\s+([a-fA-F0-9]{16,})\s*$/)?.[1] ?? null,
    handlePairAccept: async (_chatId: number, _userId: number, token: string) => { pairAccepts.push(token); },
  },
  [`${SRC}/services/voice/index.ts`]: {
    handleVoiceMessage: asyncNoop,
    handleEventCallback: asyncNoop,
    handleEditCallback: asyncNoop,
    handleDeleteCallback: asyncNoop,
    handleEditIntent: async (chatId: number, messageId: number | undefined, result: VoiceIntentResult, transcription: string) => {
      changeFlows.push({ kind: 'edit', chatId, messageId, result, transcription });
    },
    handleDeleteIntent: async (chatId: number, messageId: number | undefined, result: VoiceIntentResult, transcription: string) => {
      changeFlows.push({ kind: 'delete', chatId, messageId, result, transcription });
    },
  },
  [`${SRC}/services/voice/quick-correction.ts`]: { getQuickCorrection: async () => null, clearQuickCorrection: asyncNoop, extractFieldPatch: async () => null },
  [`${SRC}/services/voice/confirmations.ts`]: {
    escapeHtml: (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    showEventConfirmation: async (
      chatId: number, messageId: number | undefined, event: ParsedEvent, transcription: string, user: UserConfig,
      _adminFooter: string | undefined, inputModality: string
    ) => { cards.push({ chatId, messageId, event, transcription, user, inputModality }); },
    sendAnchorQuestions: async (chatId: number | string, failures: Failure[], language: string, service: unknown) => {
      anchorCalls.push({ chatId, failures, language, service, cardsBefore: cards.length + bulkCards.length });
    },
  },
  [`${SRC}/services/voice/bulk-confirmations.ts`]: {
    showBulkConfirmation: async (chatId: number | string, intents: VoiceIntentResult[], _user: UserConfig, transcription: string) => {
      bulkCards.push({ chatId, intents, transcription });
      return 'bulk:1';
    },
  },
  [`${SRC}/services/calendar-provider/index.ts`]: {
    hasUsableCalendar: async () => true,
    getCalendarAssignmentsForUser: async () => CALENDARS,
  },
  [`${SRC}/services/native-reminders/support.ts`]: {
    getReminderSupport: async (user: UserConfig) => {
      supportChecks.push(user.id);
      if (user.calendarSource !== 'NATIVE') return { supported: false, reason: 'not_native' };
      if (user.id === 4) return { supported: false, reason: 'no_access' };
      return { supported: true };
    },
  },
  [`${SRC}/services/native-reminders/resolve.ts`]: {
    resolveReminderIntents: fakeResolveIntents,
    reminderPromptContext: fakePromptContext,
  },
};

// Static imports compile to require() and pass through Module._load.
const ModuleInternals = Module as unknown as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  _resolveFilename: (request: string, parent: unknown, isMain: boolean) => string;
};
const realLoad = ModuleInternals._load;
ModuleInternals._load = function (request, parent, isMain) {
  let resolved = request;
  try {
    resolved = ModuleInternals._resolveFilename(request, parent, isMain);
  } catch {}
  return stubs[resolved] ?? realLoad.call(this, request, parent, isMain);
};

// The webhook and the typed route load some modules with import(), which goes through the
// ES module loader instead; it gets the same fake, served as an ES module.
(globalThis as { smokeStubs?: typeof stubs }).smokeStubs = stubs;
Module.registerHooks({
  load(url, context, nextLoad) {
    const file = url.startsWith('file:') ? fileURLToPath(url) : '';
    const stub = stubs[file];
    if (!stub) return nextLoad(url, context);
    const names = Object.keys(stub).map(name => `export const ${name} = fake.${name};`).join('\n');
    return { format: 'module', shortCircuit: true, source: `const fake = globalThis.smokeStubs[${JSON.stringify(file)}];\n${names}\n` };
  },
});

// ---- Scenario helpers ----

function reset() {
  geminiAnswers = [];
  geminiPrompts = [];
  sent = [];
  deleted = [];
  cards = [];
  bulkCards = [];
  changeFlows = [];
  pairAccepts = [];
  commands = [];
  supportChecks = [];
  resolveCalls = [];
  resolveOptions = [];
  anchorCalls = [];
  captured = [];
}

/** Every reminder the route asked about, across its sendAnchorQuestions calls. */
const askedAbout = () => anchorCalls.flatMap(c => c.failures);

let nextUpdateId = 1;
let nextUserMessageId = 1;

/** A private-chat text message, as Telegram posts it to the webhook. */
function textUpdate(fromId: number, text: string, messageId = nextUserMessageId++) {
  return {
    update_id: nextUpdateId++,
    message: { message_id: messageId, date: 0, text, from: { id: fromId, first_name: 'Raziel' }, chat: { id: fromId, type: 'private' } },
  };
}

/** Runs `fn` with the services' logs silenced. */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const { log, warn, error } = console;
  console.log = noop;
  console.warn = noop;
  console.error = noop;
  try {
    return await fn();
  } finally {
    Object.assign(console, { log, warn, error });
  }
}

/** Posts one update to the real webhook; returns the HTTP status it answered. */
async function deliver(update: object): Promise<number> {
  const { handleTelegramWebhook } = await import('../src/services/webhook-handlers');
  let status = 0;
  await quietly(() => handleTelegramWebhook({ body: update }, { status: code => { status = code; return { json: noop }; } }));
  return status;
}

/** Model JSON for one create, as the text prompt asks for it. */
function createAnswer(event: Record<string, unknown>) {
  return { intent: 'create', confidence: 'high', event: { calendarId: 'native:dana-cal', calendarName: 'Shared', allDay: false, recurrence: null, ...event } };
}

const at = (local: string) => fromZonedTime(local, IL);
const iso = (d: Date | undefined) => (d && !isNaN(d.getTime()) ? d.toISOString() : String(d));

/** Nothing reached the user, the model or the cards. */
function assertUntouched() {
  assert(geminiPrompts.length === 0, `Gemini was called ${geminiPrompts.length} time(s)`);
  assert(sent.length === 0, `sent ${JSON.stringify(sent.map(s => s.text))}`);
  assert(cards.length === 0 && bulkCards.length === 0 && changeFlows.length === 0, 'a card or flow was shown');
  assert(anchorCalls.length === 0, 'the anchor questions were reached');
}

async function main() {
  const { hasReminderKeyword, asTypedReminder } = await import('../src/services/native-reminders/typed-route');
  const { processTextWithGemini } = await import('../src/services/forward-event/gemini-text');
  const { getBotMessage } = await import('../src/lib/bot-messages');
  const copy = (locale: string, key: string, params?: Record<string, string>) => getBotMessage(locale, `nativeReminders.${key}`, params);

  // ---- The keyword filter ----

  await check('keywords: English, Hebrew and Russian phrasings match, whatever the case', () => {
    const positives = [
      'Remind me to call the plumber Thursday at 10',
      'REMINDER: pay the electricity bill',
      "don't forget the milk",
      'Dont forget to call grandma',
      'Don’t forget to water the plants', // the curly apostrophe phone keyboards type
      'תזכיר לי להתקשר לאינסטלטור מחר',
      'תזכירי לדנה לקנות חלב',
      'תזכורת: לשלם ארנונה',
      'תמחק את כל התזכורות של מחר',
      'אפשר להזכיר לי בערב?',
      'אל תשכח לקנות לחם',
      'אל תשכחי את המפתחות',
      'Напомни мне позвонить маме завтра в 5',
      'напоминание: оплатить интернет',
      'Не забудь купить молоко',
      'reminderless', // the substring rule is accepted (spec §3.1)
    ];
    const missed = positives.filter(text => !hasReminderKeyword(text));
    assert(missed.length === 0, `not matched: ${JSON.stringify(missed)}`);
  });

  await check('keywords: ordinary chat does not match', () => {
    const negatives = ['hello', 'Can you remember the milk?', 'forget it', 'what time is the dentist?', 'מה נשמע', 'שכחתי', 'привет', 'я забыл', ''];
    const matched = negatives.filter(text => hasReminderKeyword(text));
    assert(matched.length === 0, `matched: ${JSON.stringify(matched)}`);
  });

  // ---- Coercion ----

  await check('coercion: a create read as an event becomes a zero-length reminder; edits pass through', () => {
    const start = at('2026-10-15T17:00:00');
    const created: VoiceIntentResult = {
      intent: 'create', confidence: 'high',
      // An event carries no kind (Task 10 sets it only on reminders)
      event: { title: 'Dentist', startTime: start, endTime: at('2026-10-15T18:00:00'), allDay: false, confidence: 'high' },
    };
    const coerced = asTypedReminder(created);
    assert(coerced.event?.kind === 'reminder', `kind ${coerced.event?.kind}`);
    assert(iso(coerced.event?.endTime) === iso(start) && iso(coerced.event?.startTime) === iso(start), `${iso(coerced.event?.startTime)} - ${iso(coerced.event?.endTime)}`);
    assert(created.event?.kind === undefined && iso(created.event?.endTime) === iso(at('2026-10-15T18:00:00')), 'the input was changed');
    const edit: VoiceIntentResult = { intent: 'edit', confidence: 'high', eventReference: { type: 'by_description', description: 'dentist' } };
    assert(asTypedReminder(edit) === edit, 'an edit was rewritten');
  });

  // ---- Text extraction marks typed text ----

  await check('extraction: forwarded text keeps its exact header; typed text says it was typed by the user', async () => {
    reset();
    geminiAnswers = [{ intent: 'none' }, { intent: 'none' }];
    await quietly(() => processTextWithGemini('dinner Friday at 7', 'en', [], IL));
    await quietly(() => processTextWithGemini('remind me to call mom', 'en', [], IL, { userName: 'Raziel' }, 'typed'));
    const [forwarded, typed] = geminiPrompts;
    assert(forwarded.endsWith('\n\nFORWARDED MESSAGE:\ndinner Friday at 7'), `forwarded ends ${JSON.stringify(forwarded.slice(-60))}`);
    assert(!forwarded.includes('TYPED MESSAGE'), 'the forwarded prompt mentions typed text');
    assert(/\n\nTYPED MESSAGE \(the user typed this to you directly[^\n]*\):\nremind me to call mom$/.test(typed), `typed ends ${JSON.stringify(typed.slice(-160))}`);
    assert(!typed.includes('FORWARDED MESSAGE:'), 'the typed prompt calls itself forwarded');
  });

  // ---- The webhook: who goes to the typed route ----

  await check('webhook: a supported user typing a reminder gets "On it…", then a reminder card', async () => {
    reset();
    geminiAnswers = [createAnswer({ title: 'Call mom', startDate: '2026-10-15', startTime: '17:00', kind: 'reminder', forPerson: 'self' })];
    const text = 'Remind me to call mom tomorrow at 17:00';
    const status = await deliver(textUpdate(RAZIEL, text));
    assert(status === 200, `status ${status}`);
    assert(sent[0]?.text === (await copy('en', 'typed.processing')) && sent[0].chatId === RAZIEL, `first message ${JSON.stringify(sent[0])}`);
    assert(deleted.length === 1 && deleted[0] === 900, `deleted ${JSON.stringify(deleted)}`);
    assert(sent.length === 1, `also sent ${JSON.stringify(sent.slice(1).map(s => s.text))}`);
    assert(cards.length === 1, `${cards.length} cards`);
    const card = cards[0];
    assert(card.chatId === RAZIEL && card.messageId === undefined, `card at ${card.chatId}/${card.messageId}`);
    assert(card.transcription === text && card.inputModality === 'text', `card from ${card.inputModality}: ${card.transcription}`);
    assert(card.event.kind === 'reminder', `kind ${card.event.kind}`);
    assert(iso(card.event.startTime) === iso(at('2026-10-15T17:00:00')) && iso(card.event.endTime) === iso(card.event.startTime),
      `${iso(card.event.startTime)} - ${iso(card.event.endTime)}`);
    assert(card.event.calendarId === 'native:raziel-cal' && card.event.calendarName === undefined,
      `calendar ${card.event.calendarId} / ${card.event.calendarName}`);
    assert(card.event.forUserId === null && card.event.forName === undefined && card.event.reminderNotice === undefined,
      `for ${card.event.forUserId} (${card.event.forName}), notice ${card.event.reminderNotice}`);
    assert(askedAbout().length === 0, `asked about ${JSON.stringify(askedAbout())}`);
    assert(geminiPrompts.length === 1 && geminiPrompts[0].includes('TYPED MESSAGE (') && geminiPrompts[0].endsWith(text), 'not extracted as typed text');
    assert(liveIntervals.size === 0, `${liveIntervals.size} typing interval(s) still running`);
  });

  await check('webhook: the prompt carries the user and the partner, and the card says who it is for', async () => {
    reset();
    geminiAnswers = [createAnswer({ title: 'Buy milk', startDate: '2026-10-15', startTime: '09:00', kind: 'reminder', forPerson: 'partner' })];
    await deliver(textUpdate(RAZIEL, 'remind Dana to buy milk tomorrow morning'));
    // Only the rules above the message count: the message itself says "Dana".
    const rules = (geminiPrompts[0] ?? '').split('TYPED MESSAGE (')[0];
    assert(rules.includes('Raziel') && rules.includes('Dana'), 'the prompt lacks the names');
    assert(resolveCalls[0]?.forPerson === 'partner', `resolved for ${resolveCalls[0]?.forPerson}`);
    // Typed text is the user's own words: "remind Dana" may be for the partner
    assert(resolveOptions.length === 1 && !resolveOptions[0]?.selfOnly, `resolved with ${JSON.stringify(resolveOptions)}`);
    // forName is what the card's "for Dana" and the "I'll remind Dana" reply read
    const event = cards[0]?.event;
    assert(event?.forUserId === DANA.id && event.forName === 'Dana', `card for ${event?.forUserId} (${event?.forName})`);
  });

  await check('webhook: a Google user typing "remind me" is ignored as before', async () => {
    reset();
    const status = await deliver(textUpdate(GOOGLE, 'remind me to call mom at 5'));
    assert(status === 200, `status ${status}`);
    assertUntouched();
  });

  await check('webhook: a NATIVE user without the reminders feature is ignored as before', async () => {
    reset();
    await deliver(textUpdate(NO_ACCESS, 'remind me to call mom at 5'));
    assert(supportChecks.includes(4), 'support was not checked');
    assertUntouched();
  });

  await check('webhook: text with no keyword is ignored without a support check', async () => {
    reset();
    await deliver(textUpdate(RAZIEL, 'hello there'));
    assert(supportChecks.length === 0, `support checked for ${supportChecks.join(', ')}`);
    assertUntouched();
  });

  await check('webhook: an unregistered sender and an unknown command are ignored', async () => {
    reset();
    await deliver(textUpdate(STRANGER, 'remind me to call mom at 5'));
    await deliver(textUpdate(RAZIEL, '/remind me to call mom at 5'));
    assert(supportChecks.length === 0, `support checked for ${supportChecks.join(', ')}`);
    assertUntouched();
  });

  await check('webhook: "accept <token>" and commands still take their own branches', async () => {
    reset();
    await deliver(textUpdate(RAZIEL, 'accept 0123456789abcdef'));
    await deliver(textUpdate(RAZIEL, '/summary remind me'));
    assert(pairAccepts.join() === '0123456789abcdef', `pair accepts ${JSON.stringify(pairAccepts)}`);
    assert(commands.join() === '/summary', `commands ${JSON.stringify(commands)}`);
    assertUntouched();
  });

  await check('webhook: a redelivered update is handled once', async () => {
    reset();
    geminiAnswers = [createAnswer({ title: 'Call mom', startDate: '2026-10-15', startTime: '17:00', kind: 'reminder' })];
    const update = textUpdate(RAZIEL, 'remind me to call mom tomorrow at 17:00');
    await deliver(update);
    await deliver(update);
    assert(geminiPrompts.length === 1, `extracted ${geminiPrompts.length} times`);
    assert(cards.length === 1 && sent.length === 1, `${cards.length} cards, ${sent.length} messages`);
  });

  // ---- The typed route: what the extraction becomes ----

  await check('typed: a create the model read as an event still becomes a reminder card', async () => {
    reset();
    geminiAnswers = [createAnswer({ title: 'Parent-teacher meeting', startDate: '2026-10-20', startTime: '16:30', endDate: '2026-10-20', endTime: '17:30', kind: 'event' })];
    await deliver(textUpdate(RAZIEL, "Don't forget the parent-teacher meeting Tuesday at 16:30"));
    assert(resolveCalls[0]?.kind === 'reminder', `resolved a ${resolveCalls[0]?.kind}`);
    const event = cards[0]?.event;
    assert(event?.kind === 'reminder', `card kind ${event?.kind}`);
    assert(iso(event.startTime) === iso(at('2026-10-20T16:30:00')) && iso(event.endTime) === iso(event.startTime),
      `${iso(event.startTime)} - ${iso(event.endTime)}`);
  });

  await check('typed: a date-only reminder carries the resolution notice to the card', async () => {
    reset();
    geminiAnswers = [createAnswer({ title: 'Pay the bill', startDate: '2026-10-15', allDay: true, kind: 'reminder' })];
    await deliver(textUpdate(RAZIEL, 'remind me to pay the bill tomorrow'));
    const event = cards[0]?.event;
    assert(event?.allDay === true && event.reminderNotice === 'no_time_set', `allDay ${event?.allDay}, notice ${event?.reminderNotice}`);
  });

  await check('typed: two reminders in one message get the bulk card, both as reminders', async () => {
    reset();
    geminiAnswers = [{
      intents: [
        createAnswer({ title: 'Call mom', startDate: '2026-10-15', startTime: '17:00', kind: 'reminder' }),
        createAnswer({ title: 'Buy bread', startDate: '2026-10-15', startTime: '19:00', endDate: '2026-10-15', endTime: '20:00', kind: 'event' }),
      ],
    }];
    const text = 'remind me to call mom at 17:00 and to buy bread at 19:00 tomorrow';
    await deliver(textUpdate(RAZIEL, text));
    assert(cards.length === 0 && bulkCards.length === 1, `${cards.length} cards, ${bulkCards.length} bulk cards`);
    const bulk = bulkCards[0];
    assert(bulk.transcription === text && bulk.intents.length === 2, `${bulk.intents.length} intents`);
    for (const intent of bulk.intents) {
      const e = intent.event;
      assert(e?.kind === 'reminder' && iso(e.endTime) === iso(e.startTime) && e.calendarId === 'native:raziel-cal',
        `${e?.title}: ${e?.kind} ${iso(e?.startTime)} - ${iso(e?.endTime)} on ${e?.calendarId}`);
    }
  });

  await check('typed: an anchor that is not found gets only the question: no card, no "not understood"', async () => {
    reset();
    const description = 'dentist <Dr. Cohen & co>';
    geminiAnswers = [createAnswer({ title: 'Leave for the dentist', kind: 'reminder', anchor: { description, offsetMinutes: -60 } })];
    await deliver(textUpdate(RAZIEL, 'remind me an hour before the dentist <Dr. Cohen & co>'));
    assert(cards.length === 0 && bulkCards.length === 0, 'a card was shown');
    const asked = anchorCalls.filter(c => c.failures.length > 0);
    assert(asked.length === 1, `${asked.length} anchor question call(s)`);
    assert(asked[0].chatId === RAZIEL && asked[0].language === 'en' && asked[0].service === fakeService,
      `asked at ${asked[0].chatId} in ${asked[0].language}`);
    // The description goes over as typed; Task 11's sendAnchorQuestions escapes it for HTML.
    assert(JSON.stringify(asked[0].failures) === JSON.stringify([{ error: 'anchor_not_found', description }]),
      `asked about ${JSON.stringify(asked[0].failures)}`);
    // Only "On it…" was sent, and it went
    assert(sent.length === 1 && deleted.length === 1, `sent ${JSON.stringify(sent.map(s => s.text))}, deleted ${deleted.length}`);
  });

  await check('typed: a reminder next to an anchor that is not found gets its card, then the question', async () => {
    reset();
    geminiAnswers = [{
      intents: [
        createAnswer({ title: 'Call mom', startDate: '2026-10-15', startTime: '17:00', kind: 'reminder' }),
        createAnswer({ title: 'Leave for the dentist', kind: 'reminder', anchor: { description: 'dentist', offsetMinutes: -60 } }),
      ],
    }];
    await deliver(textUpdate(RAZIEL, 'remind me to call mom tomorrow at 17:00, and an hour before the dentist'));
    assert(cards.length === 1 && bulkCards.length === 0 && cards[0].event.title === 'Call mom',
      `${cards.length} cards (${cards.map(c => c.event.title).join(', ')}), ${bulkCards.length} bulk cards`);
    const asked = anchorCalls.filter(c => c.failures.length > 0);
    assert(asked.length === 1 && JSON.stringify(asked[0].failures) === JSON.stringify([{ error: 'anchor_not_found', description: 'dentist' }]),
      `asked about ${JSON.stringify(askedAbout())}`);
    assert(asked[0].cardsBefore === 1, 'the question came before the card');
    assert(sent.length === 1, `also sent ${JSON.stringify(sent.slice(1).map(s => s.text))}`);
  });

  await check('typed: "move the reminder…" goes to the edit flow with the typed text', async () => {
    reset();
    const edit = { intent: 'edit', confidence: 'high', eventReference: { type: 'by_description', description: 'call mom' }, editRequest: { newStartTime: '18:00' } };
    geminiAnswers = [edit];
    const text = 'move the call mom reminder to 18:00';
    await deliver(textUpdate(RAZIEL, text));
    assert(changeFlows.length === 1 && changeFlows[0].kind === 'edit', `flows ${JSON.stringify(changeFlows.map(f => f.kind))}`);
    const flow = changeFlows[0];
    assert(flow.chatId === RAZIEL && flow.messageId === undefined && flow.transcription === text, `edit at ${flow.chatId}/${flow.messageId}: ${flow.transcription}`);
    assert(flow.result.editRequest?.newStartTime === '18:00' && flow.result.eventReference?.description === 'call mom', 'the edit request was lost');
    assert(cards.length === 0 && resolveCalls.length === 0, 'an edit was treated as a create');
  });

  await check('typed: "stop reminding me…" goes to the delete flow with its scope', async () => {
    reset();
    geminiAnswers = [{ intent: 'delete', confidence: 'high', scope: 'all', eventReference: { type: 'by_description', description: 'water the plants' } }];
    await deliver(textUpdate(RAZIEL, 'stop reminding me to water the plants'));
    assert(changeFlows.length === 1 && changeFlows[0].kind === 'delete' && changeFlows[0].result.scope === 'all',
      `flows ${JSON.stringify(changeFlows.map(f => [f.kind, f.result.scope]))}`);
  });

  await check('typed: nothing usable gets the typed "not understood" copy', async () => {
    reset();
    geminiAnswers = [{ intent: 'none', confidence: 'high', error: 'No calendar event information found in this message.' }];
    await deliver(textUpdate(RAZIEL, 'I did the reminder thing already'));
    assert(cards.length === 0 && changeFlows.length === 0, 'a card or flow was shown');
    assert(sent.at(-1)?.text === (await copy('en', 'typed.notUnderstood')), `last message ${JSON.stringify(sent.at(-1)?.text)}`);
    assert(deleted.length === 1, 'the "On it…" message stayed');
  });

  await check('typed: an extraction failure answers "not understood", reports it and stops typing', async () => {
    reset();
    geminiAnswers = [new Error('503 overloaded'), new Error('503 overloaded')];
    const status = await deliver(textUpdate(RAZIEL, 'remind me to call mom'));
    assert(status === 200, `status ${status}`);
    assert(sent.at(-1)?.text === (await copy('en', 'typed.notUnderstood')), `last message ${JSON.stringify(sent.at(-1)?.text)}`);
    assert(captured.includes('native-reminders-typed'), `captured ${JSON.stringify(captured)}`);
    assert(deleted.length === 1, 'the "On it…" message stayed');
    assert(liveIntervals.size === 0, `${liveIntervals.size} typing interval(s) still running`);
  });

  await check('typed: a Hebrew user gets Hebrew copy and a card', async () => {
    reset();
    geminiAnswers = [createAnswer({ title: 'לקנות חלב', startDate: '2026-10-15', startTime: '09:00', kind: 'reminder' })];
    await deliver(textUpdate(NOA, 'תזכיר לי לקנות חלב מחר בבוקר'));
    assert(sent[0]?.text === (await copy('he', 'typed.processing')) && sent[0].text !== (await copy('en', 'typed.processing')),
      `first message ${JSON.stringify(sent[0]?.text)}`);
    assert(cards.length === 1 && cards[0].event.title === 'לקנות חלב', `${cards.length} cards`);
  });

  await check('no network was reached', () => {
    assert(networkAttempts.length === 0, `fetched ${networkAttempts.join(', ')}`);
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `TZ=UTC npx tsx scripts/smoke-native-reminder-typed.ts`

Expected: the script exits 1 before any check runs, with
`Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/src/services/native-reminders/typed-route' imported from …/scripts/smoke-native-reminder-typed.ts`.

- [ ] **Step 3: Create the typed route**

Create `src/services/native-reminders/typed-route.ts`:

```ts
/**
 * Typed "remind me…" messages (spec §3.1, R4).
 *
 * Typed text that isn't a command used to be ignored. A message that names a reminder now
 * goes to the same text-mode extraction as a forwarded one, marked as typed so "me" is the
 * user. Every create it yields is a reminder, resolved like a voice one, and always gets
 * the card (typed text never auto-creates); edits and deletes take the existing chat flows.
 * The webhook sends text here only for users who have native reminders, so nobody else
 * sees a change.
 */

import { getMessagingService } from '../telegram';
import { MessageFormat } from '../messaging/types';
import type { IMessagingService } from '../messaging/types';
import { getBotMessages } from '../../lib/bot-messages';
import { resolveUserTimezone } from '../../lib/timezone';
import { captureError } from '../../lib/error-capture';
import { acquireVoiceLock } from '../../utils/redis-lock';
import { addBreadcrumb } from '../analytics-service';
import { startTypingInterval } from '../telegram/command-pipeline';
import { processTextWithGemini } from '../forward-event/gemini-text';
import { handleEditIntent, handleDeleteIntent } from '../voice';
import { sendAnchorQuestions, showEventConfirmation } from '../voice/confirmations';
import { showBulkConfirmation } from '../voice/bulk-confirmations';
import type { ParsedEvent, VoiceIntentResult } from '../event-parser';
import type { UserConfig } from '../../types';
import { reminderPromptContext, resolveReminderIntents } from './resolve';

/**
 * Words that send typed text to extraction, matched as case-insensitive substrings
 * (spec §3.1). The Hebrew plural "תזכורות" is added because "תזכורת" isn't inside it.
 */
export const REMINDER_KEYWORDS: readonly string[] = [
  'remind', 'reminder', "don't forget", 'dont forget',
  'תזכיר', 'תזכירי', 'תזכורת', 'תזכורות', 'להזכיר', 'אל תשכח', 'אל תשכחי',
  'напомни', 'напомина', 'не забудь',
];

/** Phone keyboards type a curly apostrophe ("don’t"), so it counts as a straight one. */
const APOSTROPHES = /[‘’ʼ`´]/g;

export function hasReminderKeyword(text: string): boolean {
  const normalized = text.toLowerCase().replace(APOSTROPHES, "'");
  return REMINDER_KEYWORDS.some(keyword => normalized.includes(keyword));
}

/**
 * A create from typed text is always a reminder (R4): one the model read as an event
 * becomes a reminder at its start, with no duration. Edits and deletes pass through.
 */
export function asTypedReminder(result: VoiceIntentResult): VoiceIntentResult {
  if (result.intent !== 'create' || !result.event) return result;
  const event = result.event;
  return { ...result, event: { ...event, kind: 'reminder', endTime: new Date(event.startTime.getTime()) } };
}

type CreateResult = VoiceIntentResult & { event: ParsedEvent };

/** What every reply to one typed message needs. */
interface TypedContext {
  chatId: number;
  user: UserConfig;
  text: string;
  timezone: string;
  service: IMessagingService;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the bot message tree, as getBotMessages returns it
  t: any;
  adminFooter?: string;
}

/**
 * Answers with what extraction found: reminder cards (and a question for each reminder
 * that can't be placed), an edit or delete card, or "not understood". `results` are
 * already coerced by asTypedReminder, so every create is a reminder.
 */
async function routeTypedIntents(ctx: TypedContext, results: VoiceIntentResult[]): Promise<void> {
  // Each reminder's calendar, target and time, as for voice (Task 11). No selfOnly: typed
  // text is the user's own words, so "remind Dana…" may be for the partner. This is also
  // what sets forName, which the card's "for Dana" and the reply read.
  const { intents, failures } = await resolveReminderIntents(ctx.user, results, ctx.timezone);
  const creates = intents.filter((r): r is CreateResult => r.intent === 'create' && !!r.event && !r.error);
  if (creates.length > 0 || failures.length > 0) {
    if (creates.length > 1) {
      await showBulkConfirmation(ctx.chatId, creates, ctx.user, ctx.text, ctx.t, ctx.service, ctx.timezone);
    } else if (creates.length === 1) {
      await showEventConfirmation(ctx.chatId, undefined, creates[0].event, ctx.text, ctx.user, ctx.adminFooter, 'text');
    }
    // "an hour before the dentist" with no dentist found: ask for a time instead (sends
    // nothing when every reminder was placed). Asking is the answer, so no "not understood".
    await sendAnchorQuestions(ctx.chatId, failures, ctx.user.language || 'en', ctx.service);
    return;
  }

  const change = intents.find(r => r.intent === 'edit' || r.intent === 'delete');
  if (change?.intent === 'edit') {
    await handleEditIntent(ctx.chatId, undefined, change, ctx.text, ctx.user, ctx.t, ctx.adminFooter);
  } else if (change?.intent === 'delete') {
    await handleDeleteIntent(ctx.chatId, undefined, change, ctx.text, ctx.user, ctx.t, ctx.adminFooter);
  } else {
    await ctx.service.sendMessage(ctx.chatId, ctx.t.nativeReminders.typed.notUnderstood, { format: MessageFormat.PLAIN });
  }
}

/**
 * Handles one typed message that has a reminder keyword, for a user with native reminders.
 * `messageId` is the user's message, which keys the duplicate-delivery lock. Never throws.
 */
export async function handleTypedReminderText(user: UserConfig, chatId: number, text: string, messageId: number): Promise<void> {
  // Telegram redelivers an update it got no answer to, and extraction plus a match can take
  // most of a minute, so the same message would otherwise run twice. The lock expires.
  if (!(await acquireVoiceLock(`typed:${chatId}:${messageId}`))) {
    console.log(`[NativeReminders] Typed message ${chatId}:${messageId} already being handled - skipping duplicate`);
    return;
  }

  const service = getMessagingService();
  const t = await getBotMessages(user.language || 'en');
  let processingId: number | string | null = null;
  let stopTyping: (() => void) | null = null;

  // "On it…" stands in while the model reads, and goes once the answer is ready.
  const clearProcessing = async () => {
    stopTyping?.();
    stopTyping = null;
    if (processingId === null) return;
    const id = processingId;
    processingId = null;
    await service.deleteMessage(chatId, id).catch(() => {});
  };

  addBreadcrumb('typed_reminder_started', { user_id: user.id, text_length: text.length }, 'native_reminders');

  try {
    processingId = await service.sendMessage(chatId, t.nativeReminders.typed.processing, { format: MessageFormat.PLAIN });
    stopTyping = startTypingInterval(chatId, service);

    const { hasUsableCalendar, getCalendarAssignmentsForUser } = await import('../calendar-provider');
    if (!(await hasUsableCalendar(user))) {
      await clearProcessing();
      await service.sendMessage(chatId, t.voice.noCalendar, { format: MessageFormat.PLAIN });
      return;
    }
    const calendars = await getCalendarAssignmentsForUser(user);
    const timezone = await resolveUserTimezone(user);
    const reminders = await reminderPromptContext(user); // the user's and the ACTIVE partner's names

    const { intentResults, metrics } = await processTextWithGemini(
      text, user.language || 'en', calendars, timezone, reminders, 'typed'
    );
    const adminFooter = user.isAdmin
      ? `\n\n<i>📊 ${metrics.model} | ${metrics.inputTokens}→${metrics.outputTokens} tok | ${(metrics.durationMs / 1000).toFixed(1)}s</i>`
      : undefined;
    addBreadcrumb('typed_reminder_extracted', { intents: intentResults.map(r => r.intent).join(',') }, 'native_reminders');

    await clearProcessing();
    await routeTypedIntents({ chatId, user, text, timezone, service, t, adminFooter }, intentResults.map(asTypedReminder));
  } catch (error) {
    await clearProcessing();
    console.error('[NativeReminders] Typed reminder failed:', error);
    captureError(error, 'native-reminders-typed');
    await service.sendMessage(chatId, t.nativeReminders.typed.notUnderstood, { format: MessageFormat.PLAIN }).catch(() => {});
  }
}
```

- [ ] **Step 4: Mark typed text in text extraction**

In `src/services/forward-event/gemini-text.ts`, find:

```ts
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

Replace with:

```ts
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Where the text came from. In a forwarded message "me" is whoever wrote it; a typed one is
 * the user talking to us (spec §3.1). Forwarded text gets exactly the prompt it always had.
 */
export type TextSource = 'forwarded' | 'typed';

const MESSAGE_HEADERS: Record<TextSource, string> = {
  forwarded: 'FORWARDED MESSAGE:',
  typed: 'TYPED MESSAGE (the user typed this to you directly, it was not forwarded, so "me", "I" and "my" mean the user):',
};
```

Then find, in the `processTextWithGemini` signature (Task 10 added the `reminders` parameter):

```ts
  reminders?: ReminderPromptContext
): Promise<
```

Replace with:

```ts
  reminders?: ReminderPromptContext,
  source: TextSource = 'forwarded'
): Promise<
```

Then find:

```ts
              { text: promptText + '\n\nFORWARDED MESSAGE:\n' + text },
```

Replace with:

```ts
              { text: promptText + '\n\n' + MESSAGE_HEADERS[source] + '\n' + text },
```

- [ ] **Step 5: Route typed reminder text in the Telegram webhook**

In `src/services/webhook-handlers.ts`, find (the end of `handleTelegramWebhook`):

```ts
    if (token) {
      const { getOrCreateUser } = await import('./user-service');
      const user = await getOrCreateUser(textUserId, update.message.from);
      await handlePairAccept(chatId, user.id, token, user.language || 'en', MessagingPlatform.TELEGRAM);
    }
  }

  res.status(200).json({ ok: true });
}
```

Replace with:

```ts
    if (token) {
      const { getOrCreateUser } = await import('./user-service');
      const user = await getOrCreateUser(textUserId, update.message.from);
      await handlePairAccept(chatId, user.id, token, user.language || 'en', MessagingPlatform.TELEGRAM);
    } else {
      await routeTypedReminderText(chatId, textUserId, text, update.message.message_id);
    }
  }

  res.status(200).json({ ok: true });
}

/**
 * Typed text that names a reminder ("remind me…", spec §3.1) goes to the native reminders'
 * typed route, for users who have them (R3, R4). Other typed text is still ignored, and so
 * is this for everyone else. Never throws: Telegram would redeliver a failed update.
 */
async function routeTypedReminderText(chatId: number, telegramUserId: number, text: string, messageId: number): Promise<void> {
  if (text.startsWith('/')) return;
  try {
    const { hasReminderKeyword, handleTypedReminderText } = await import('./native-reminders/typed-route');
    if (!hasReminderKeyword(text)) return;
    const user = await getUserByTelegramId(telegramUserId);
    if (!user) return;
    const { getReminderSupport } = await import('./native-reminders/support');
    if (!(await getReminderSupport(user)).supported) return;

    addBreadcrumb('typed_reminder_received', { user_id: telegramUserId, text_length: text.length }, 'user_action');
    console.log(`[Webhook] Typed reminder text from user ${telegramUserId}, length: ${text.length}`);
    await handleTypedReminderText(user, chatId, text, messageId);
  } catch (error) {
    console.error('[Webhook] Error in typed reminder route:', error);
    captureError(error, 'typed-reminder-route');
  }
}
```

`getUserByTelegramId`, `addBreadcrumb` and `captureError` are already imported at the top of the file. The keyword test comes before the user lookup, so ordinary chat costs no database read. The `/` test keeps unknown commands such as `/remind` out ("non-command text", spec §3.1).

- [ ] **Step 6: Run the tests to verify they pass**

Run:
```bash
TZ=UTC npx tsx scripts/smoke-native-reminder-typed.ts
TZ=Asia/Jerusalem npx tsx scripts/smoke-native-reminder-typed.ts
```
Expected: 23 `OK` lines, then `23/23 passed (process TZ=UTC)` and `23/23 passed (process TZ=Asia/Jerusalem)`. No log lines appear between them.

Then run the regression checks. Forwarded text must keep its exact prompt (Task 10's creation smoke), Task 11's create flow runs the real resolution, cards and anchor questions this route now calls, and Task 9's button smoke loads the real `webhook-handlers.ts`:
```bash
TZ=UTC npx tsx scripts/smoke-native-reminder-creation.ts
TZ=Asia/Jerusalem npx tsx scripts/smoke-native-reminder-creation.ts
TZ=UTC npx tsx scripts/smoke-native-reminder-create-flow.ts
TZ=Asia/Jerusalem npx tsx scripts/smoke-native-reminder-create-flow.ts
TZ=UTC npx tsx scripts/smoke-native-reminder-buttons.ts
TZ=Asia/Jerusalem npx tsx scripts/smoke-native-reminder-buttons.ts
# Task 13's script, only when Task 13 has already landed
if [ -f scripts/smoke-native-reminder-edit.ts ]; then
  TZ=UTC npx tsx scripts/smoke-native-reminder-edit.ts
  TZ=Asia/Jerusalem npx tsx scripts/smoke-native-reminder-edit.ts
fi
npx tsx scripts/check-i18n-parity.ts
npx tsc --noEmit -p .
npm run -s lint
```
Expected: each smoke prints the same `N/N passed` line as before this task, under both clocks, and exits 0 (the button smoke still prints its two deliberate log lines first). The parity check prints `i18n parity OK (<n> keys)`. `tsc` and `lint` print nothing and exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/services/native-reminders/typed-route.ts src/services/forward-event/gemini-text.ts src/services/webhook-handlers.ts scripts/smoke-native-reminder-typed.ts
git commit -F - <<'EOF'
feat(reminders): typed "remind me…" messages

Typed text that names a reminder (remind / don't forget, תזכיר / תזכורת /
אל תשכח, напомни / не забудь) now goes to text-mode extraction, for users
with native reminders. It is marked as typed, so "me" is the user, and the
partner's names are in the prompt. Every create it yields is a reminder,
resolved like a voice one, and always gets the card; an anchor that can't
be found gets a question. Edits and deletes take the chat flows. Other
typed text, other users and forwarded text are unchanged.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
EOF
```

---

### Task 13: Edit and delete for reminders

**Files:**
- Create: `src/services/native-reminders/moved-pings.ts` — `stripMovedPings` and `movedWhen`: after a chat edit moves a reminder, each ping the re-arm cleared is edited to "⏰ <title> · moved to <when>" without buttons, in its reader's language and on their clock.
- Create: `scripts/smoke-native-reminder-edit.ts` — candidate tags and series collapse, open reminders as candidates, the event-over-reminder tie rule, "cancel that" by `recurringEventId`, the native permission-denied copy on create, edit and delete, moved pings, and the provider's `clearedPings` pass-through.
- Modify: `src/services/voice/event-resolution.ts`
  - `:19-20` imports;
  - `:111-115` adds `isLastCreatedEvent` after `getLastCreatedEvent`;
  - `:217-225` `describeEventForMatching` tags reminders. Adds `reminderTag`, `REMINDER_WORDS`, `asksForReminder`, `REMINDER_RULES` and `ReminderRule`;
  - `:232-271` `buildMatchPrompt` takes an optional `reminderRule`;
  - `:273-300` (Task 11's `MatchOptions` and `findMatchingEvent`) — `MatchOptions` gains `request` and `openReminders`; adds `MatchExtras`, `openReminderCandidates`, `withOpenReminders`, `startKey`, `isUpcoming`, `collapseReminderSeries` and `settleKindTie`;
  - `:303-341` `matchInRange` takes `MatchExtras` in place of Task 11's `options`, then merges, filters (`eligible`), collapses, picks the rule and settles ties;
  - `:428-429` adds `REMINDER_DEFAULT_TIME`;
  - `:501-586` `convertEditRequestToUpdates` hands reminders to the new `reminderUpdates`.
- Check (no change): `src/services/native-reminders/open-reminders.ts` (Task 7's file) — `fetchOpenReminders` already takes the trailing `cap` the matcher sets to `Infinity`.
- Modify: `src/services/voice/handler.ts:19, 83, 88-93, 176, 181-186` — "cancel that" uses `isLastCreatedEvent`, and both matches pass `{ request: transcription, openReminders: true }`.
- Modify: `src/services/calendar-provider/types.ts:7, 82-88` — `UpdateEventResult` gains the native-only `clearedPings?`.
- Modify: `src/services/calendar-provider/native-provider.ts:244` — `updateEvent` returns `clearedPings` when there are any.
- Modify: `src/services/voice/callbacks.ts:155, 312-316, 476-480` — after an edit, strip the moved pings; a native `PERMISSION_DENIED` on create, edit and delete shows `permissionDenied` (Planning Ruling 12).
- Modify: `src/services/webhook-handlers.ts:1201-1205` — the WhatsApp `edit_confirm` strips moved pings too.
- Modify: `src/services/voice/confirmations.ts:16, 182-186` — `formatCalendarEventDateTime` prints a reminder's single time. This is the "Current:" line of the edit and delete cards.
- Modify: `src/services/voice/auto-create.ts` (imports after Task 11's, `:106`) and `src/services/voice/bulk-confirmations.ts` (imports after Task 11's, `:191-192`) — a reminder created without a card is tracked for "cancel that" (spec §11.3).
- Test: `scripts/smoke-native-reminder-edit.ts` (new) and `scripts/smoke-voice-dates.ts` (extended).

Line numbers are at the base commit `40461c4`. Tasks 4, 5, 9, 11 and 12 edit some of these files first and shift lines, so match on the quoted snippets. Every find below quotes the text as Tasks 1-12 leave it.

**Interfaces:**
- Consumes:
  ```ts
  // Task 1: src/services/native-reminders/ownership.ts
  export interface ViewerContext { viewerId: number; partner: PartnerSummary | null }
  export async function loadViewerContext(user: { id: number; pairingId: string | null }): Promise<ViewerContext>;
  // Task 2: src/services/native-calendar/event-store.ts
  export interface ClearedPing { chatId: bigint; messageId: number }
  // updateNativeEvent resolves to { canonicalEventId: string; clearedPings: ClearedPing[] } (clearedPings: [] on every event path)
  // A refused create/update/delete throws NativePermissionDeniedError → provider error 'PERMISSION_DENIED'
  // Task 4: messages/{en,he,ru}.json → bot.nativeReminders.moved ("⏰ {title} · moved to {when}") and .permissionDenied ("You can't change this one.")
  // Task 4: src/utils/html.ts (leaf module, no imports; src/services/voice/confirmations.ts only re-exports it)
  export function escapeHtml(text: string): string;
  // Task 5: provider events — a reminder occurrence has eventType 'reminder' and reminder: ReminderInfo; a timed one
  //   has end === start (ISO), a date-only one start 'yyyy-MM-dd' and end the next date; timeZone is the event's own;
  //   a repeating one has recurringEventId = series cuid and eventId = '<cuid>#<ISO>'. fetchEventsInRange already
  //   includes the partner's reminders for the viewer (supplementary query).
  // Task 5: src/types.ts → ReminderInfo, CalendarEvent.reminder?
  // Task 7: src/utils/event-formatter.ts
  export function isReminderEvent(event: Pick<CalendarEvent, 'eventType'>): boolean;
  // Task 7: src/services/native-reminders/open-reminders.ts
  export const OPEN_REMINDERS_DIGEST_CAP = 5;
  export async function fetchOpenReminders(
    user: UserConfig, ctx: ViewerContext, cutoff: Date, summaryDay: string /* yyyy-MM-dd */, timezone: string,
    cap: number = OPEN_REMINDERS_DIGEST_CAP /* Infinity = all */
  ): Promise<{ events: CalendarEvent[]; moreCount: number }>;
  //   Carried items have eventType 'reminder' and reminder.openSince; a repeating series that occurs on summaryDay is left out.
  // Task 8: src/services/native-reminders/due.ts, ping.ts
  export const REMINDER_MORNING_HOUR = 9;
  export async function stripPingButtons(chatId: bigint | number, messageId: number, text: string): Promise<void>; // parse_mode HTML, no keyboard; swallows "not modified"/"not found", throws otherwise
  // Task 10: src/services/event-parser.ts → ParsedEvent.kind?: 'event' | 'reminder' (set only on reminders: test kind === 'reminder')
  // Task 11: src/services/voice/event-resolution.ts
  export interface MatchOptions { eligible?: (events: CalendarEvent[]) => CalendarEvent[] }
  export async function findMatchingEvent(user: UserConfig, calendarIds: string[], reference: EventReference, language: string,
    now: Date = new Date(), options: MatchOptions = {}): Promise<MatchResult>;
  //   matchInRange(…, day, options: MatchOptions = {}) filters the fetched events through options.eligible.
  //   Task 11's anchor lookup (resolve.ts) passes { eligible: events => anchorCandidates(events, now, timezone) }.
  // Task 11: auto-create.ts creates a reminder as `event` on `calendarId` (event.calendarId || 'primary'), and
  //   bulk-confirmations.ts as `ev` on `ev.calendarId || 'primary'`, both with ...reminderCreateFields(…):
  //   resolveReminderIntents already put the reminder's main calendar, start and end on the event.
  ```
- Produces:
  ```ts
  // src/services/voice/event-resolution.ts
  export function isLastCreatedEvent(event: CalendarEvent, last: Pick<CreatedEventTracker, 'eventId' | 'calendarId'>): boolean;
  export type ReminderRule = 'preferEvents' | 'preferReminders';
  export function buildMatchPrompt(reference: EventReference, language: string, eventList: string, now: Date, timezone: string, reminderRule?: ReminderRule): string; // undefined → byte-identical prompt
  export interface MatchOptions {
    eligible?: (events: CalendarEvent[]) => CalendarEvent[];   // Task 11 (anchors)
    request?: string; openReminders?: boolean;                 // this task (edit/delete matcher)
  }
  // findMatchingEvent(user, calendarIds, reference, language, now?: Date, options: MatchOptions = {}): Promise<MatchResult> (Task 11's signature)
  //   matchInRange applies `eligible` after merging the open reminders and before collapsing series.
  export function collapseReminderSeries(events: CalendarEvent[], now: Date, timezone: string): CalendarEvent[];
  // convertEditRequestToUpdates: unchanged signature; a reminder gets endTime === startTime whenever startTime is set
  // src/services/calendar-provider/types.ts
  // UpdateEventResult gains: clearedPings?: ClearedPing[];   // native only, present only when non-empty
  // src/services/native-reminders/moved-pings.ts
  export function movedWhen(startsAt: Date, allDay: boolean, language: string, readerZone: string, ownZone: string): string;
  export async function stripMovedPings(pings: ClearedPing[], original: CalendarEvent, updates: UpdateEventData, editor: UserConfig): Promise<void>; // never throws
  ```
- Behaviour later tasks rely on:
  - Without `openReminders`, `findMatchingEvent` fetches no open reminders, but it still tags reminders, collapses repeating ones and applies the tie rule. Task 11's anchor lookup passes only `{ eligible }`: no open reminders, and anchorCandidates removes reminders, so no rule is added.
  - A Google user's search never fetches open reminders. Their matcher prompt and candidate lines are unchanged byte for byte.

- [ ] **Step 1: Write the failing tests**

**1a.** Create `scripts/smoke-native-reminder-edit.ts`:

```ts
// Smoke test for moving and deleting native reminders from chat (spec §7): how the
// candidates read to the matcher (tagged, a repeating reminder once, open ones however
// old), which of an event and a reminder with the same title wins, "cancel that" after a
// repeating reminder, the built-in calendar's answer to a refused create, edit or delete,
// and the pings a move re-arms, which must say where the reminder went and lose their buttons.
// The calendar provider, the AI matcher, Redis, Telegram, the user lookup and the open
// reminders lookup are faked. No network, no database.
//
// Run under both clocks; the output must not depend on the server's timezone:
//   TZ=UTC npx tsx scripts/smoke-native-reminder-edit.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-native-reminder-edit.ts

import Module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromZonedTime } from 'date-fns-tz';
import { REDIS_KEYS } from '../src/config/redis-keys';
import type { ReminderInfo, UserConfig } from '../src/types';
import type { UnifiedEvent, UpdateEventResult } from '../src/services/calendar-provider/types';
import type { EventReference, VoiceIntentResult } from '../src/services/event-parser';

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
}

function assert(cond: boolean, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

const IL = 'Asia/Jerusalem';
const NY = 'America/New_York';
const at = (local: string, tz = IL) => fromZonedTime(local, tz);
/** Wednesday 2026-10-14, 12:00 in Israel. */
const NOW = at('2026-10-14T12:00:00');

// ---- People ----

const user = (fields: Partial<UserConfig>) => ({ isAdmin: false, voiceInputEnabled: true, googleRefreshToken: '', ...fields }) as UserConfig;
const raziel = user({ id: 1, name: 'Raziel', telegramId: 1001, language: 'en', calendarSource: 'NATIVE', pairingId: 'p1' });
const dana = user({ id: 2, name: 'Dana', telegramId: 1002, language: 'ru', calendarSource: 'NATIVE', pairingId: 'p1' });
const googleUser = user({ id: 3, name: 'Noa', telegramId: 1003, language: 'en', calendarSource: 'GOOGLE', googleRefreshToken: 'token' });
const PEOPLE = [raziel, dana, googleUser];
const TIMEZONES: Record<number, string> = { 1: IL, 2: NY, 3: IL };

// ---- Calendar items, as the native provider lists them ----

/** A reminder: a timed one ends where it starts, a date-only one runs to the next date. */
function reminder(title: string, start: string, fields: Partial<UnifiedEvent> & { info?: Partial<ReminderInfo> } = {}): UnifiedEvent {
  const { info, ...rest } = fields;
  return {
    summary: title, start, end: start.includes('T') ? start : nextDay(start), calendarName: 'Raziel', calendarId: 'native:c1',
    eventType: 'reminder', eventId: `${title.replace(/\W/g, '').toLowerCase()}-${start}`, provider: 'native', timeZone: IL,
    reminder: { ownerIsViewer: true, creatorIsViewer: true, ...info },
    ...rest,
  };
}

function event(title: string, start: string, end: string, fields: Partial<UnifiedEvent> = {}): UnifiedEvent {
  return {
    summary: title, start, end, calendarName: 'Raziel', calendarId: 'native:c1',
    eventId: `${title.replace(/\W/g, '').toLowerCase()}-${start}`, provider: 'native', timeZone: IL, ...fields,
  };
}

function nextDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** A daily 09:00 reminder's occurrences, `count` days from `firstDay`. */
function dailyCallMom(firstDay: string, count: number): UnifiedEvent[] {
  return Array.from({ length: count }, (_, i) => {
    const day = new Date(`${firstDay}T00:00:00Z`);
    day.setUTCDate(day.getUTCDate() + i);
    const start = at(`${day.toISOString().slice(0, 10)}T09:00:00`);
    return reminder('Call mom', start.toISOString(), {
      eventId: `daily1#${start.toISOString()}`, recurringEventId: 'daily1', instanceStartsAt: start.toISOString(),
    });
  });
}

// ---- Fakes ----

/** Redis as Upstash behaves: values round-trip through JSON. */
const store = new Map<string, string>();
const fakeRedis = {
  get: async (key: string) => (store.has(key) ? JSON.parse(store.get(key)!) : null),
  set: async (key: string, value: unknown) => {
    store.set(key, JSON.stringify(value));
    return 'OK';
  },
  del: async (key: string) => (store.delete(key) ? 1 : 0),
};

/** The calendar the provider reads, and what its writes answer. */
let calendar: UnifiedEvent[] = [];
let createResult: { success: boolean; eventId?: string; error?: string } = { success: true };
let updateResult: UpdateEventResult = { success: true };
let deleteResult: { success: boolean; error?: string } = { success: true };
const fakeProvider = {
  name: 'native',
  // Every item overlapping [from, to), a zero-length one when it starts inside it
  fetchEventsInRange: async (_user: UserConfig, _calendarIds: string[], from: Date, to: Date) =>
    calendar.filter(e => new Date(e.start) < to && (new Date(e.end) > from || new Date(e.start) >= from)),
  createEvent: async () => createResult,
  updateEvent: async () => updateResult,
  deleteEvent: async () => deleteResult,
};

/** The user's open reminders, as fetchOpenReminders would carry them over, and its calls. */
let openReminders: UnifiedEvent[] = [];
const openCalls: Array<{ viewerId: number; cutoff: string; summaryDay: string; timezone: string; cap: number }> = [];
const fakeOpenReminders = {
  OPEN_REMINDERS_DIGEST_CAP: 5,
  fetchOpenReminders: async (_user: UserConfig, ctx: { viewerId: number }, cutoff: Date, summaryDay: string, timezone: string, cap = 5) => {
    openCalls.push({ viewerId: ctx.viewerId, cutoff: cutoff.toISOString(), summaryDay, timezone, cap });
    return { events: openReminders.slice(0, cap), moreCount: Math.max(0, openReminders.length - cap) };
  },
};

/**
 * The AI matcher, faked: by default it picks the first listed item whose line has the
 * user's description in it. A test can script the answer. Every prompt is recorded.
 */
const matcherPrompts: string[] = [];
let matcherAnswer: ((lines: string[], description: string) => object) | undefined;
async function fakeMatcher(prompt: string) {
  matcherPrompts.push(prompt);
  const description = (/User's description: "(.*)"/.exec(prompt)?.[1] ?? '').toLowerCase();
  const lines = prompt.split('Available events:\n')[1].split('\n\n')[0].split('\n');
  if (matcherAnswer) return { text: JSON.stringify(matcherAnswer(lines, description)) };
  const index = lines.findIndex(line => line.toLowerCase().includes(description));
  return { text: JSON.stringify(index < 0 ? { match: 'none' } : { match: 'single', eventIndex: index + 1 }) };
}
const listedIn = (prompt: string) => prompt.split('Available events:\n')[1].split('\n\n')[0].split('\n');

/** Telegram, recorded. */
type Sent = { chatId: number; text: string; options?: { reply_markup?: unknown } };
let sent: Sent[] = [];
let edits: Sent[] = [];
const fakeBot = {
  sendMessage: async (chatId: number, text: string, options?: Sent['options']) => {
    sent.push({ chatId, text, options });
    return { message_id: 900 + sent.length };
  },
  editMessageText: async (text: string, options: { chat_id: number; reply_markup?: unknown }) => {
    edits.push({ chatId: options.chat_id, text, options });
    return true;
  },
  answerCallbackQuery: async () => true,
};
const fakeMessaging = {
  sendMessage: async (chatId: number, text: string) => {
    sent.push({ chatId, text });
    return { messageId: 900 + sent.length };
  },
};

/** Pings whose buttons were stripped, and one ping chat whose edit fails. */
let stripped: Array<{ chatId: string; messageId: number; text: string }> = [];
let failingPingChat: bigint | undefined;
const fakePing = {
  stripPingButtons: async (chatId: bigint | number, messageId: number, text: string) => {
    if (failingPingChat !== undefined && BigInt(chatId) === failingPingChat) throw new Error('Bad Request: chat not found');
    stripped.push({ chatId: String(chatId), messageId, text });
  },
};

/** What the native event store's update answers (for the provider's own check). */
let storeUpdate = { canonicalEventId: 'r1', clearedPings: [] as Array<{ chatId: bigint; messageId: number }> };

const captured: Array<{ context: string; severity?: string }> = [];

const SRC = path.resolve(__dirname, '../src');

/** A proxy over the real module, not a copy: the store and the ownership helpers import each other. */
const fakeOver = (real: Record<string, unknown>, fakes: Record<string, unknown>) =>
  new Proxy(real, { get: (target, key) => (typeof key === 'string' && key in fakes ? fakes[key] : Reflect.get(target, key)) });

/** Any database access is a bug in this test. */
const noDatabase = new Proxy({}, {
  get: (_target, key) => {
    if (typeof key !== 'string' || key === 'then') return undefined;
    throw new Error(`smoke test touched the database: prisma.${key}`);
  },
});

/** Modules replaced by fakes, by file path; a function fakes part of the real module. */
const stubs: Record<string, object | ((real: Record<string, unknown>) => object)> = {
  [`${SRC}/lib/timezone.ts`]: { resolveUserTimezone: async (u: { id: number }) => TIMEZONES[u.id] },
  [`${SRC}/services/ai-provider.ts`]: { generateAICompletion: fakeMatcher },
  [`${SRC}/utils/redis.ts`]: { redis: fakeRedis },
  [`${SRC}/utils/prisma.ts`]: { prisma: noDatabase },
  [`${SRC}/lib/error-capture.ts`]: {
    captureError: (_error: unknown, context: string, _extra?: unknown, severity?: string) => { captured.push({ context, severity }); },
    captureWarning: () => {},
    captureInfo: () => {},
  },
  [`${SRC}/services/telegram/index.ts`]: { getBot: () => fakeBot, getMessagingService: () => fakeMessaging },
  [`${SRC}/services/user-service.ts`]: {
    getUserByTelegramId: async (telegramId: number | bigint) => PEOPLE.find(p => p.telegramId === Number(telegramId)) ?? null,
  },
  [`${SRC}/services/analytics-service.ts`]: { trackActivityAsync: () => {}, addBreadcrumb: () => {}, setUserContext: () => {} },
  [`${SRC}/services/subscription-service.ts`]: { checkFeatureAccess: async () => ({ allowed: true }), incrementUsage: async () => {} },
  [`${SRC}/services/calendar-provider/index.ts`]: {
    getProviderForUser: () => fakeProvider,
    hasUsableCalendar: async () => true,
    getCalendarAssignmentsForUser: async () => [{ calendarId: 'native:c1', name: 'Raziel', labels: ['primary'], color: '#000' }],
  },
  [`${SRC}/services/voice/recent-events-store.ts`]: {
    pushRecentEvent: async () => {}, removeRecentEvent: async () => {}, getRecentEvents: async () => [], formatRecentEventsBlock: () => '',
  },
  [`${SRC}/services/native-reminders/open-reminders.ts`]: fakeOpenReminders,
  [`${SRC}/services/native-reminders/ping.ts`]: fakePing,
  [`${SRC}/services/native-reminders/ownership.ts`]: real => fakeOver(real, {
    loadViewerContext: async (u: { id: number }) => ({ viewerId: u.id, partner: null }),
  }),
  [`${SRC}/services/native-calendar/event-store.ts`]: real => fakeOver(real, {
    updateNativeEvent: async () => storeUpdate,
  }),
};

// Static imports compile to require() and pass through Module._load.
const ModuleInternals = Module as unknown as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  _resolveFilename: (request: string, parent: unknown, isMain: boolean) => string;
};
const realLoad = ModuleInternals._load;
const partialFakes = new Map<string, object>();
ModuleInternals._load = function (request, parent, isMain) {
  // src/services/claude.ts imports @hebcal/core, which ships ESM only; nothing here uses it
  if (request.startsWith('@hebcal/')) return {};
  let resolved = request;
  try {
    resolved = ModuleInternals._resolveFilename(request, parent, isMain);
  } catch {}
  const stub = stubs[resolved];
  if (!stub) return realLoad.call(this, request, parent, isMain);
  if (typeof stub !== 'function') return stub;
  if (!partialFakes.has(resolved)) partialFakes.set(resolved, stub(realLoad.call(this, request, parent, isMain) as Record<string, unknown>));
  return partialFakes.get(resolved);
};

// The voice handlers load some modules with import(), which goes through the ES module
// loader instead; those get the same fake, served as an ES module.
(globalThis as { smokeStubs?: typeof stubs }).smokeStubs = stubs;
Module.registerHooks({
  load(url, context, nextLoad) {
    const file = url.startsWith('file:') ? fileURLToPath(url) : '';
    const stub = stubs[file];
    if (!stub || typeof stub === 'function') return nextLoad(url, context);
    const names = Object.keys(stub).map(name => `export const ${name} = fake.${name};`).join('\n');
    return { format: 'module', shortCircuit: true, source: `const fake = globalThis.smokeStubs[${JSON.stringify(file)}];\n${names}\n` };
  },
});

function reset() {
  store.clear();
  calendar = [];
  openReminders = [];
  openCalls.length = 0;
  matcherPrompts.length = 0;
  matcherAnswer = undefined;
  sent = [];
  edits = [];
  stripped = [];
  failingPingChat = undefined;
  captured.length = 0;
  createResult = { success: true };
  updateResult = { success: true };
  deleteResult = { success: true };
  storeUpdate = { canonicalEventId: 'r1', clearedPings: [] };
}

async function main() {
  const {
    collapseReminderSeries, describeEventForMatching, findMatchingEvent, buildMatchPrompt, isLastCreatedEvent,
  } = await import('../src/services/voice/event-resolution');
  const { handleDeleteIntent } = await import('../src/services/voice/handler');
  const { handleEventCallback, handleEditCallback, handleDeleteCallback } = await import('../src/services/voice/callbacks');
  const { nativeProvider } = await import('../src/services/calendar-provider/native-provider');
  const { getBotMessages } = await import('../src/lib/bot-messages');

  const byDescription = (description: string, extra: Partial<EventReference> = {}): EventReference =>
    ({ type: 'by_description', description, ...extra });
  const picked = (result: Awaited<ReturnType<typeof findMatchingEvent>>) =>
    'event' in result ? `${result.event.summary} ${result.event.start}` : result.error;

  // (a) How the candidates read.

  await check('a reminder is tagged, with whose it is when it is the partner\'s; an event is not', () => {
    const mine = describeEventForMatching(reminder('Call mom', '2026-10-14T07:00:00.000Z'), 0, IL);
    assert(mine === '1. [reminder] "Call mom" on Wednesday 2026-10-14 at 10:00 (calendar: native:c1)', `mine: ${mine}`);
    const fromDana = describeEventForMatching(reminder('Pick up the cake', '2026-10-14T13:00:00.000Z', { info: { creatorIsViewer: false, creatorName: 'Dana' } }), 1, IL);
    assert(fromDana === '2. [reminder] "Pick up the cake" on Wednesday 2026-10-14 at 16:00 (calendar: native:c1)', `from Dana: ${fromDana}`);
    const forDana = describeEventForMatching(reminder('Buy milk', '2026-10-15', { info: { ownerIsViewer: false, ownerName: 'Dana' } }), 2, IL);
    assert(forDana === '3. [reminder for Dana] "Buy milk" on Thursday 2026-10-15 (all day) (calendar: native:c1)', `for Dana: ${forDana}`);
    const dentist = describeEventForMatching(event('Dentist', '2026-10-15T07:00:00.000Z', '2026-10-15T08:00:00.000Z'), 3, IL);
    assert(dentist === '4. "Dentist" on Thursday 2026-10-15 at 10:00 (calendar: native:c1)', `event: ${dentist}`);
  });

  await check('a daily reminder over three weeks is one candidate: its next occurrence, else its last', () => {
    const daily = dailyCallMom('2026-10-07', 21);
    const standup = [9, 10, 11].map(d => event('Standup', `2026-10-${d}T06:00:00.000Z`, `2026-10-${d}T06:15:00.000Z`, { recurringEventId: 'standup1', eventId: `standup1#${d}` }));
    const plumber = reminder('Call the plumber', '2026-10-13T08:00:00.000Z');
    const kept = collapseReminderSeries([plumber, ...standup, ...daily], NOW, IL);
    const next = at('2026-10-15T09:00:00').toISOString();
    assert(kept.length === 5 && kept[0] === plumber && kept.slice(1, 4).every((e, i) => e === standup[i]), `kept ${kept.map(e => e.summary).join(', ')}`);
    assert(kept[4].start === next, `the daily one: ${kept[4].start}, wanted ${next}`);
    const afterAll = collapseReminderSeries(daily, at('2026-10-28T12:00:00'), IL);
    assert(afterAll.length === 1 && afterAll[0].start === at('2026-10-27T09:00:00').toISOString(), `after all: ${afterAll.map(e => e.start).join(', ')}`);
    // A date-only occurrence is ahead all through its day
    const dateOnly = ['2026-10-13', '2026-10-14', '2026-10-15'].map(d => reminder('Water the plants', d, { recurringEventId: 'plants1', eventId: `plants1#${d}` }));
    const today = collapseReminderSeries(dateOnly, NOW, IL);
    assert(today.length === 1 && today[0].start === '2026-10-14', `date-only: ${today.map(e => e.start).join(', ')}`);
  });

  // (b) The search.

  await check('a voice edit of a daily reminder reaches the matcher as one line, and finds it', async () => {
    reset();
    calendar = [...dailyCallMom('2026-10-07', 21), event('Dentist', '2026-10-15T07:00:00.000Z', '2026-10-15T08:00:00.000Z')];
    const result = await findMatchingEvent(raziel, ['native:c1'], byDescription('call mom'), 'en', NOW, { openReminders: true });
    assert(picked(result) === `Call mom ${at('2026-10-15T09:00:00').toISOString()}`, `picked ${picked(result)}`);
    const lines = listedIn(matcherPrompts[0]);
    assert(lines.length === 2 && lines.filter(l => l.includes('Call mom')).length === 1, `listed ${JSON.stringify(lines)}`);
    assert(matcherPrompts[0].includes('\n6. Items tagged [reminder] are reminders'), 'no reminder rule in the prompt');
  });

  await check('open reminders of any age are offered, once each, to a native user\'s edit or delete only', async () => {
    reset();
    const plumber = reminder('Pay the plumber', '2026-09-20T07:00:00.000Z', { info: { openSince: '2026-09-20' } });
    const cake = reminder('Order the cake', '2026-10-12T07:00:00.000Z', { info: { openSince: '2026-10-12' } });
    calendar = [{ ...cake, reminder: { ownerIsViewer: true, creatorIsViewer: true } }];
    openReminders = [cake, plumber];
    const result = await findMatchingEvent(raziel, ['native:c1'], byDescription('plumber'), 'en', NOW, { openReminders: true });
    assert(picked(result) === 'Pay the plumber 2026-09-20T07:00:00.000Z', `picked ${picked(result)}`);
    const lines = listedIn(matcherPrompts[0]);
    assert(lines.length === 2 && lines.filter(l => l.includes('Order the cake')).length === 1, `listed ${JSON.stringify(lines)}`);
    const call = openCalls[0];
    assert(openCalls.length === 1 && call.viewerId === 1 && call.cutoff === NOW.toISOString() && call.summaryDay === '2026-10-14' && call.timezone === IL && call.cap === Infinity,
      `fetchOpenReminders called ${JSON.stringify(openCalls)} (cap ${call?.cap})`);

    // Without the option (an anchor lookup passes only `eligible`), and for a Google user, nothing is fetched
    openCalls.length = 0;
    const plain = await findMatchingEvent(raziel, ['native:c1'], byDescription('plumber'), 'en', NOW);
    const google = await findMatchingEvent(googleUser, ['primary'], byDescription('plumber'), 'en', NOW, { openReminders: true });
    assert(openCalls.length === 0 && picked(plain) === 'no_match' && picked(google) === 'no_match', `calls ${openCalls.length}, ${picked(plain)}, ${picked(google)}`);
  });

  await check('with nothing in the range, an open reminder is still found', async () => {
    reset();
    openReminders = [reminder('Renew the passport', '2026-08-01T07:00:00.000Z', { info: { openSince: '2026-08-01' } })];
    const result = await findMatchingEvent(raziel, ['native:c1'], byDescription('passport', { timeHint: 'today' }), 'en', NOW, { openReminders: true });
    assert(picked(result) === 'Renew the passport 2026-08-01T07:00:00.000Z', `picked ${picked(result)}`);
  });

  await check('a tie between an event and a reminder goes to the event, unless the user asks about the reminder', async () => {
    const dentistEvent = event('Dentist', '2026-10-15T07:00:00.000Z', '2026-10-15T08:00:00.000Z');
    const dentistReminder = reminder('Dentist', '2026-10-15T06:00:00.000Z');
    const tie = async (request: string, items: UnifiedEvent[] = [dentistReminder, dentistEvent]) => {
      reset();
      calendar = items;
      matcherAnswer = lines => ({ match: 'multiple', matchedIndexes: lines.map((_, i) => i + 1) });
      const result = await findMatchingEvent(raziel, ['native:c1'], byDescription('dentist'), 'en', NOW, { request, openReminders: true });
      const rule = matcherPrompts[0].split('\n').find(line => line.startsWith('6. ')) ?? '';
      return { picked: 'event' in result ? result.event : result.error, rule };
    };
    const plain = await tie('cancel the dentist');
    assert(plain.picked === dentistEvent && plain.rule.endsWith('choose the event'), `plain: ${JSON.stringify(plain)}`);
    for (const request of ['cancel the dentist reminder', 'תבטל את התזכורת לרופא שיניים', 'удали напоминание про стоматолога']) {
      const asked = await tie(request);
      assert(asked.picked === dentistReminder && asked.rule.endsWith('choose the reminder'), `${request}: ${JSON.stringify(asked)}`);
    }
    const twoEvents = await tie('cancel the dentist', [dentistEvent, { ...dentistEvent, eventId: 'dentist-2', start: '2026-10-16T07:00:00.000Z', end: '2026-10-16T08:00:00.000Z' }]);
    assert(twoEvents.picked === 'multiple_matches' && twoEvents.rule === '', `two events: ${JSON.stringify(twoEvents)}`);
  });

  await check('with no reminder among the candidates, the matcher\'s prompt is as before', async () => {
    const reference = byDescription('dentist', { timeHint: 'tomorrow' });
    const before = buildMatchPrompt(reference, 'en', '1. "Dentist" on Thursday 2026-10-15 at 10:00 (calendar: c1)', NOW, IL);
    const now = buildMatchPrompt(reference, 'en', '1. "Dentist" on Thursday 2026-10-15 at 10:00 (calendar: c1)', NOW, IL, undefined);
    assert(before === now && !before.includes('\n6. '), 'the prompt changed');
    reset();
    calendar = [event('Dentist', '2026-10-15T07:00:00.000Z', '2026-10-15T08:00:00.000Z')];
    await findMatchingEvent(googleUser, ['primary'], reference, 'en', NOW, { request: 'move the dentist reminder', openReminders: true });
    assert(matcherPrompts.length === 1 && !matcherPrompts[0].includes('\n6. ') && !matcherPrompts[0].includes('[reminder'), 'a Google prompt changed');
  });

  // (c) The chat flows around the match.

  await check('"cancel that" right after a repeating reminder finds its first occurrence; a Google id must still match exactly', async () => {
    reset();
    calendar = dailyCallMom('2026-10-15', 3);
    const first = calendar[0];
    await fakeRedis.set(REDIS_KEYS.lastCreatedEvent(1001), {
      eventId: 'daily1', calendarId: 'native:c1', title: 'Call mom', startTime: first.start, endTime: first.end, createdAt: NOW,
    });
    const t = await getBotMessages('en');
    const intent = { intent: 'delete', confidence: 'high', scope: 'single', eventReference: { type: 'last_created' } } as VoiceIntentResult;
    await handleDeleteIntent(1001, undefined, intent, 'cancel that', raziel, t);
    const pending = [...store.entries()].find(([key]) => key.startsWith('voice:pending:delete:'));
    assert(!!pending && JSON.parse(pending[1]).event.eventId === first.eventId, `pending delete ${pending?.[1]}`);
    assert(sent.length === 1 && sent[0].text.includes('Call mom'), `sent ${JSON.stringify(sent.map(s => s.text))}`);

    const googleInstance = { summary: 'Yoga', start: '', end: '', calendarName: 'Main', calendarId: 'primary', eventId: 'g1_20261015', recurringEventId: 'g1' };
    assert(!isLastCreatedEvent(googleInstance, { eventId: 'g1', calendarId: 'primary' }), 'a Google instance matched its series id');
    assert(isLastCreatedEvent({ ...googleInstance, eventId: 'g1' }, { eventId: 'g1', calendarId: 'primary' }), 'a Google event no longer matched its own id');
  });

  /** A pending create, edit or delete of `item` by `by`, then its confirm button. */
  async function confirm(kind: 'create' | 'edit' | 'delete', item: UnifiedEvent, by: UserConfig, updates: Record<string, unknown> = {}) {
    if (kind === 'create') {
      const event = {
        title: item.summary, startTime: new Date(item.start), endTime: new Date(item.end), allDay: false, calendarId: item.calendarId, confidence: 'high',
      };
      await fakeRedis.set(REDIS_KEYS.pendingEvent('p1'), { event, user: by, transcription: 'add it' });
      await handleEventCallback(77, 500, 'q1', 'create', 'p1');
      return edits[edits.length - 1];
    }
    const key = kind === 'edit' ? REDIS_KEYS.pendingEdit('p1') : REDIS_KEYS.pendingDelete('p1');
    await fakeRedis.set(key, kind === 'edit'
      ? { originalEvent: item, calendarId: item.calendarId, updates, user: by, transcription: 'move it', scope: 'single' }
      : { event: item, calendarId: item.calendarId, user: by, transcription: 'delete it', scope: 'single' });
    if (kind === 'edit') await handleEditCallback(77, 500, 'q1', 'confirm', 'p1');
    else await handleDeleteCallback(77, 500, 'q1', 'confirm', 'p1');
    return edits[edits.length - 1];
  }

  await check('a refused create, edit or delete on the built-in calendar says so, with no Google button; Google\'s is as before', async () => {
    const callMom = reminder('Call mom', '2026-10-15T06:00:00.000Z', { calendarId: 'native:c9' });
    const ru = await getBotMessages('ru');
    for (const kind of ['create', 'edit', 'delete'] as const) {
      reset();
      createResult = { success: false, error: 'PERMISSION_DENIED' };
      updateResult = { success: false, error: 'PERMISSION_DENIED' };
      deleteResult = { success: false, error: 'PERMISSION_DENIED' };
      const native = await confirm(kind, callMom, dana);
      assert(native.text === ru.nativeReminders.permissionDenied && !native.options?.reply_markup, `${kind} native: ${JSON.stringify(native)}`);
      const google = await confirm(kind, { ...callMom, calendarId: 'primary', eventType: undefined, reminder: undefined }, googleUser);
      const button = JSON.stringify(google.options?.reply_markup ?? '');
      assert(google.text.includes('Permission') && button.includes('web_app'), `${kind} Google: ${JSON.stringify(google)}`);
    }
  });

  await check('a moved reminder\'s pings say where it went, in their reader\'s language and clock, without buttons', async () => {
    reset();
    const callMom = reminder('Call <mom> & dad', '2026-10-14T07:00:00.000Z', { eventId: 'r1' });
    const fivePm = at('2026-10-15T17:00:00');
    updateResult = { success: true, eventId: 'r1', clearedPings: [{ chatId: 1002n, messageId: 12 }, { chatId: 1001n, messageId: 13 }] };
    await confirm('edit', callMom, raziel, { startTime: fivePm, endTime: fivePm });
    assert(edits.some(e => e.text.startsWith('✅')), `no success message: ${JSON.stringify(edits.map(e => e.text))}`);
    const pings = [...stripped];
    assert(pings.length === 2, `stripped ${JSON.stringify(pings)}`);
    const [forDana, forRaziel] = pings;
    // Dana reads Russian, in New York: 17:00 in Israel is 10:00 there
    assert(forDana.chatId === '1002' && forDana.messageId === 12 && forDana.text.startsWith('⏰ Call &lt;mom&gt; &amp; dad · перенесено на ')
      && forDana.text.includes('15') && forDana.text.endsWith(' 10:00'), `Dana's ping: ${forDana.text}`);
    assert(forRaziel.chatId === '1001' && forRaziel.messageId === 13 && forRaziel.text === '⏰ Call &lt;mom&gt; &amp; dad · moved to Thu, Oct 15 17:00',
      `Raziel's ping: ${forRaziel.text}`);

    // A date-only move reads its own day, whoever reads it
    reset();
    updateResult = { success: true, eventId: 'r1', clearedPings: [{ chatId: 1002n, messageId: 14 }] };
    const friday = at('2026-10-16T00:00:00');
    await confirm('edit', reminder('Buy milk', '2026-10-14', { eventId: 'r2' }), raziel, { startTime: friday, endTime: friday, allDay: true });
    const dateOnly = [...stripped];
    assert(dateOnly.length === 1 && dateOnly[0].text.startsWith('⏰ Buy milk · перенесено на ') && dateOnly[0].text.includes('16') && !/\d\d:\d\d/.test(dateOnly[0].text),
      `date-only: ${dateOnly[0]?.text}`);
  });

  await check('a ping that cannot be edited costs nothing else; an edit that clears none strips none', async () => {
    reset();
    failingPingChat = 1002n;
    updateResult = { success: true, eventId: 'r1', clearedPings: [{ chatId: 1002n, messageId: 12 }, { chatId: 1001n, messageId: 13 }] };
    const fivePm = at('2026-10-15T17:00:00');
    await confirm('edit', reminder('Call mom', '2026-10-14T07:00:00.000Z', { eventId: 'r1' }), raziel, { startTime: fivePm, endTime: fivePm });
    const survivors = [...stripped];
    assert(survivors.length === 1 && survivors[0].chatId === '1001', `stripped ${JSON.stringify(survivors)}`);
    assert(captured.some(c => c.context === 'native-reminder-moved-ping' && c.severity === 'warning'), `captured ${JSON.stringify(captured)}`);
    reset();
    updateResult = { success: true, eventId: 'r1' };
    await confirm('edit', reminder('Call mom', '2026-10-14T07:00:00.000Z', { eventId: 'r1' }), raziel, { title: 'Call grandma' });
    const renamed = [...stripped];
    assert(renamed.length === 0, `a rename stripped ${JSON.stringify(renamed)}`);
  });

  await check('the native provider hands back the pings a re-arm cleared, and nothing new for an event', async () => {
    reset();
    storeUpdate = { canonicalEventId: 'r1', clearedPings: [{ chatId: 1002n, messageId: 12 }] };
    const moved = await nativeProvider.updateEvent(raziel, 'native:c1', 'r1', { startTime: NOW, endTime: NOW, scope: 'single' });
    assert(moved.success && moved.clearedPings?.length === 1 && moved.clearedPings[0].chatId === 1002n && moved.clearedPings[0].messageId === 12,
      `moved: ${JSON.stringify(moved, (_k, v) => (typeof v === 'bigint' ? String(v) : v))}`);
    storeUpdate = { canonicalEventId: 'e1', clearedPings: [] };
    const plain = await nativeProvider.updateEvent(raziel, 'native:c1', 'e1', { title: 'Dentist', scope: 'single' });
    assert(JSON.stringify(plain) === '{"success":true,"eventId":"e1"}', `event: ${JSON.stringify(plain)}`);
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

**1b.** Extend `scripts/smoke-voice-dates.ts`. Insert this block just before the results loop at the end of `main()`. Find:

```ts
  let failed = 0;
  for (const r of results) {
```

Insert above it (the block ends with a blank line):

```ts
  // (d) Editing a reminder: one time and no length, whatever end the model sends (spec §7).

  /** A reminder as the native provider lists it: a timed one ends where it starts. */
  const reminderAt = (start: string, end = start, timeZone = IL): CalendarEvent =>
    ({
      ...ev('Call mom', start, end), calendarId: 'native:c1', eventType: 'reminder', timeZone,
      reminder: { ownerIsViewer: true, creatorIsViewer: true },
    }) as CalendarEvent;
  /** An edit's times as start..end on `tz`'s clock, and its allDay when it sets one. */
  const editSpan = (updates: { startTime?: Date; endTime?: Date; allDay?: boolean }, tz = IL) =>
    `${at(updates.startTime, tz)}..${at(updates.endTime, tz)}${updates.allDay === undefined ? '' : ` allDay=${updates.allDay}`}`;
  const callMomAt10 = reminderAt('2026-10-14T10:00:00+03:00');

  check('a timed reminder "moved to 17:00" is 17:00 to 17:00; the hour the model adds is dropped', () => {
    const moved = editSpan(convertEditRequestToUpdates({ newStartTime: '17:00', newEndTime: '18:00' }, callMomAt10, IL));
    assert(moved === '2026-10-14 17:00..2026-10-14 17:00', `got ${moved}`);
    const thursday = editSpan(convertEditRequestToUpdates({ newStartDate: '2026-10-15' }, callMomAt10, IL));
    assert(thursday === '2026-10-15 10:00..2026-10-15 10:00', `Thursday: got ${thursday}`);
    const endOnly = convertEditRequestToUpdates({ newEndTime: '11:00' }, callMomAt10, IL);
    assert(endOnly.startTime === undefined && endOnly.endTime === undefined, `an end alone moved it: ${editSpan(endOnly)}`);
  });

  check('a date-only reminder moved to Friday is 00:00 to 00:00 there, never 23:59, in its own timezone', () => {
    const friday = editSpan(convertEditRequestToUpdates({ newStartDate: '2026-10-16', newEndDate: '2026-10-16' }, reminderAt('2026-10-14', '2026-10-15'), IL));
    assert(friday === '2026-10-16 00:00..2026-10-16 00:00', `Israel: got ${friday}`);
    // A New York reminder edited from Israel keeps New York's day
    const newYork = convertEditRequestToUpdates({ newStartDate: '2026-10-16' }, reminderAt('2026-10-14', '2026-10-15', NY), IL);
    assert(editSpan(newYork, NY) === '2026-10-16 00:00..2026-10-16 00:00', `New York: got ${editSpan(newYork, NY)}`);
    const allDayTime = convertEditRequestToUpdates({ newAllDay: true, newStartTime: '10:00' }, reminderAt('2026-10-14', '2026-10-15'), IL);
    assert(allDayTime.startTime === undefined && allDayTime.endTime === undefined, `a time on a kept date-only one moved it: ${editSpan(allDayTime)}`);
  });

  check('a date-only reminder given a time becomes timed at it; made timed with none, it rings at 09:00', () => {
    const atFive = editSpan(convertEditRequestToUpdates({ newStartTime: '17:00' }, reminderAt('2026-10-14', '2026-10-15'), IL));
    assert(atFive === '2026-10-14 17:00..2026-10-14 17:00 allDay=false', `given a time: got ${atFive}`);
    const noTime = editSpan(convertEditRequestToUpdates({ newAllDay: false }, reminderAt('2026-10-14', '2026-10-15'), IL));
    assert(noTime === '2026-10-14 09:00..2026-10-14 09:00 allDay=false', `no time: got ${noTime}`);
  });

  check('a timed reminder made date-only starts and ends at 00:00 of its day', () => {
    const allDay = editSpan(convertEditRequestToUpdates({ newAllDay: true }, callMomAt10, IL));
    assert(allDay === '2026-10-14 00:00..2026-10-14 00:00 allDay=true', `got ${allDay}`);
  });

  check('a reminder renamed keeps its time; the same move on an event keeps the event\'s hour', () => {
    const renamed = convertEditRequestToUpdates({ newTitle: 'Call grandma' }, callMomAt10, IL);
    assert(JSON.stringify(renamed) === '{"title":"Call grandma"}', `renamed: ${JSON.stringify(renamed)}`);
    const dentist = ev('Dentist', '2026-10-14T10:00:00+03:00', '2026-10-14T11:00:00+03:00');
    const event = editSpan(convertEditRequestToUpdates({ newStartTime: '17:00' }, dentist, IL));
    assert(event === '2026-10-14 17:00..2026-10-14 18:00', `event: got ${event}`);
  });

  check('the edit card shows a reminder\'s one time and its move, never a range', () => {
    const current = formatCalendarEventDateTime(callMomAt10, 'en', 'All day', IL);
    assert(current === '📆 Wednesday, October 14\n🕐 10:00', `current: got ${JSON.stringify(current)}`);
    const changes = formatEditChanges(callMomAt10, convertEditRequestToUpdates({ newStartTime: '17:00', newEndTime: '18:00' }, callMomAt10, IL), 'en', IL, 'All day');
    assert(changes === '🕐 10:00 → 17:00', `changes: got ${JSON.stringify(changes)}`);
    const milk = reminderAt('2026-10-14', '2026-10-15');
    const friday = formatEditChanges(milk, convertEditRequestToUpdates({ newStartDate: '2026-10-16' }, milk, IL), 'en', IL, 'All day');
    assert(friday === '📆 Wed, Oct 14 → Fri, Oct 16', `date-only move: got ${JSON.stringify(friday)}`);
    const dentist = formatCalendarEventDateTime(ev('Dentist', '2026-10-14T10:00:00+03:00', '2026-10-14T11:00:00+03:00'), 'en', 'All day', IL);
    assert(dentist === '📆 Wednesday, October 14\n🕐 10:00 - 11:00', `event: got ${JSON.stringify(dentist)}`);
  });

```

`ev`, `at`, `IL`, `NY`, `check`, `assert`, `convertEditRequestToUpdates`, `formatEditChanges` and `formatCalendarEventDateTime` are already in scope there, and `CalendarEvent` is already imported.

- [ ] **Step 2: Run the tests and confirm they fail**

```bash
TZ=UTC npx tsx scripts/smoke-native-reminder-edit.ts; echo "exit=$?"
TZ=UTC npx tsx scripts/smoke-voice-dates.ts | grep -E '^FAIL|passed'
```

Expected:
- **`smoke-native-reminder-edit.ts`:** `1/12 passed (process TZ=UTC)`, `exit=1`. Only "with no reminder among the candidates, the matcher's prompt is as before" passes. The others fail, for example:
  - `mine: 1. "Call mom" on Wednesday …` (no tag);
  - `collapseReminderSeries is not a function`;
  - `picked Call mom 2026-10-08T06:00:00.000Z`;
  - `picked no_match`;
  - `picked no_events_found`;
  - `plain: {"picked":"multiple_matches","rule":""}`;
  - `pending delete undefined`;
  - `create native: …` with the Russian Google "Требуется разрешение" text and a `web_app` button for the native user;
  - `stripped []`;
  - `moved: {"success":true,"eventId":"r1"}`.
- **`smoke-voice-dates.ts`:** five `FAIL` lines and `67/72 passed` (66 checks before this task; no earlier task adds any to this script):
  - `a timed reminder "moved to 17:00" … — got 2026-10-14 17:00..2026-10-14 18:00`;
  - `a date-only reminder moved to Friday … — Israel: got 2026-10-16 00:00..2026-10-16 23:59`;
  - `a date-only reminder given a time … — given a time: got unset..unset`;
  - `a timed reminder made date-only … — got 2026-10-14 00:00..2026-10-14 23:59 allDay=true`;
  - `the edit card shows a reminder's one time … — current: got "📆 Wednesday, October 14\n🕐 10:00 - 10:00"`.

`npx tsc --noEmit -p .` also fails at this point, on the new script's use of `collapseReminderSeries`, `isLastCreatedEvent`, the `request` and `openReminders` options (Task 11's `MatchOptions` has only `eligible`) and `clearedPings`. The steps below fix it.

- [ ] **Step 3: Imports and `isLastCreatedEvent` (`event-resolution.ts`)**

Find (lines 19-20):
```ts
import { addDaysToDate, daySpanOf, localDate, nextDate, startOfLocalDay } from '../../utils/day-events';
import { isAllDayEvent } from '../../utils/event-formatter';
```
Replace with (no earlier task changes these two lines):
```ts
import { addDaysToDate, daySpanOf, localDate, nextDate, startOfLocalDay } from '../../utils/day-events';
import { isAllDayEvent, isReminderEvent } from '../../utils/event-formatter';
import { loadViewerContext } from '../native-reminders/ownership';
import { fetchOpenReminders } from '../native-reminders/open-reminders';
import { REMINDER_MORNING_HOUR } from '../native-reminders/due';
```

Find (the end of `getLastCreatedEvent`, lines 111-115):
```ts
    console.error('[Voice] Error getting last created event from Redis:', error);
    captureError(error, 'voice-event-resolution');
    return undefined;
  }
}
```
Replace with:
```ts
    console.error('[Voice] Error getting last created event from Redis:', error);
    captureError(error, 'voice-event-resolution');
    return undefined;
  }
}

/**
 * Whether a fetched event is the one created last. A repeating native item was created,
 * and tracked, as its series ("<cuid>"), while each of its fetched occurrences is
 * "<cuid>#<start>" with the series as its recurringEventId (spec §11.3).
 */
export function isLastCreatedEvent(event: CalendarEvent, last: Pick<CreatedEventTracker, 'eventId' | 'calendarId'>): boolean {
  if (event.eventId === last.eventId) return true;
  return isNativeCalendarId(last.calendarId) && event.recurringEventId === last.eventId;
}
```

Only native ids match by series. A Google instance still has to match exactly, as before.

- [ ] **Step 4: Tag reminders and add the tie rule (`event-resolution.ts`)**

Find (lines 224-225):
```ts
  return `${index + 1}. "${event.summary}" ${when} (calendar: ${event.calendarId})`;
}
```
Replace with:
```ts
  return `${index + 1}. ${reminderTag(event)}"${event.summary}" ${when} (calendar: ${event.calendarId})`;
}

/** "[reminder] ", or "[reminder for Dana] " when it is the partner's, before a reminder's title. */
function reminderTag(event: CalendarEvent): string {
  if (!isReminderEvent(event)) return '';
  const owner = event.reminder && !event.reminder.ownerIsViewer ? event.reminder.ownerName : undefined;
  return owner ? `[reminder for ${owner}] ` : '[reminder] ';
}

/**
 * Words that name a reminder in English, Hebrew and Russian: "reminder", "remind",
 * "תזכורת", "להזכיר", "תזכיר", "напоминание", "напомни".
 */
const REMINDER_WORDS = /remind|תזכור|הזכיר|תזכיר|напомин|напомн/i;

/** Whether the user's words ask about a reminder rather than an event. */
function asksForReminder(text: string): boolean {
  return REMINDER_WORDS.test(text);
}

/**
 * The matcher's tie rule when reminders are among the candidates (spec §7): an event
 * wins a tie with a reminder of the same title, unless the user asked about a reminder.
 */
const REMINDER_RULES = {
  preferEvents: '6. Items tagged [reminder] are reminders ("[reminder for Dana]" is one for Dana); the others are events. When an event and a reminder match equally, choose the event',
  preferReminders: '6. Items tagged [reminder] are reminders ("[reminder for Dana]" is one for Dana); the others are events. The user is asking about a reminder: when an event and a reminder match equally, choose the reminder',
} as const;

export type ReminderRule = keyof typeof REMINDER_RULES;
```

`REMINDER_WORDS` is deliberately not Task 12's `hasReminderKeyword`. That function decides whether a typed message is a reminder request, and it includes "don't forget". This regex only asks whether an edit or delete names a reminder. Importing `typed-route.ts` here would also close the cycle `event-resolution` → `typed-route` → `handler` → `event-resolution`.

Find (in `buildMatchPrompt`, lines 236-240):
```ts
  now: Date,
  timezone: string
): string {
  const day = hintedDay(reference, now, timezone);
  const today = `Today is ${withWeekday(localDate(now, timezone))}`;
```
Replace with:
```ts
  now: Date,
  timezone: string,
  reminderRule?: ReminderRule
): string {
  const day = hintedDay(reference, now, timezone);
  const today = `Today is ${withWeekday(localDate(now, timezone))}`;
```

Find (line 262, inside the template literal):
```ts
5. If no event matches the description, return "none"
```
Replace with:
```ts
5. If no event matches the description, return "none"${reminderRule ? `\n${REMINDER_RULES[reminderRule]}` : ''}
```

With no rule the prompt is byte-identical to today's.

- [ ] **Step 5: Open reminders, series collapse and tie settling in the search (`event-resolution.ts`)**

Task 11 Step 4 added `MatchOptions` (with `eligible`) and passes `options` from `findMatchingEvent` to `matchInRange`. This step adds two fields to that interface and replaces the pass-through with `MatchExtras`: what every round of one search shares, worked out once.

Find (lines 273-288 at the base; this is Task 11's text):
```ts
type MatchResult = { event: CalendarEvent; calendarId: string } | { error: string; multiple?: CalendarEvent[] };

/** What a caller adds to the search. */
export interface MatchOptions {
  /** Which of the events in range may match (a reminder's anchor: upcoming events only, never reminders). */
  eligible?: (events: CalendarEvent[]) => CalendarEvent[];
}

/**
 * Find a matching event based on description and time hint
 * Uses AI to match event titles and returns the best match
 */
export async function findMatchingEvent(
  user: UserConfig,
  calendarIds: string[],
  reference: EventReference,
  language: string,
  now: Date = new Date(),
  options: MatchOptions = {}
): Promise<MatchResult> {
  const timezone = await resolveUserTimezone(user);
  const day = hintedDay(reference, now, timezone);
  const narrowed = await matchInRange(user, calendarIds, reference, language, now, timezone, day, options);
```
Replace with:
```ts
type MatchResult = { event: CalendarEvent; calendarId: string } | { error: string; multiple?: CalendarEvent[] };

/** What a caller adds to the search. */
export interface MatchOptions {
  /** Which of the events in range may match (a reminder's anchor: upcoming events only, never reminders). */
  eligible?: (events: CalendarEvent[]) => CalendarEvent[];
  /** A chat edit or delete: the user's own words. Naming a reminder in them lets a reminder win a tie with an event. */
  request?: string;
  /** A chat edit or delete: offer the user's open reminders too, however old (built-in calendar only). */
  openReminders?: boolean;
}

/** What every round of one search shares: the open reminders, whether a reminder is meant, and the caller's filter. */
interface MatchExtras {
  open: CalendarEvent[];
  wantsReminder: boolean;
  eligible?: MatchOptions['eligible'];
}

/**
 * Find a matching event based on description and time hint
 * Uses AI to match event titles and returns the best match
 */
export async function findMatchingEvent(
  user: UserConfig,
  calendarIds: string[],
  reference: EventReference,
  language: string,
  now: Date = new Date(),
  options: MatchOptions = {}
): Promise<MatchResult> {
  const timezone = await resolveUserTimezone(user);
  const day = hintedDay(reference, now, timezone);
  const extras: MatchExtras = {
    open: options.openReminders ? await openReminderCandidates(user, now, timezone) : [],
    wantsReminder: asksForReminder(`${options.request ?? ''} ${reference.description ?? ''}`),
    eligible: options.eligible,
  };
  const narrowed = await matchInRange(user, calendarIds, reference, language, now, timezone, day, extras);
```

Find (lines 296-300 at the base; Task 11 added `options` to the call):
```ts
    const wide = { ...reference, originalDate: undefined, timeHint: undefined };
    return matchInRange(user, calendarIds, wide, language, now, timezone, undefined, options);
  }
  return narrowed;
}
```
Replace with:
```ts
    const wide = { ...reference, originalDate: undefined, timeHint: undefined };
    return matchInRange(user, calendarIds, wide, language, now, timezone, undefined, extras);
  }
  return narrowed;
}

/**
 * The user's open reminders, however old: an undone one stays in their digests ("open
 * since Monday") until it is done, so it must stay reachable by voice after the search's
 * week back. Only the built-in calendar has reminders. A failed lookup costs only these.
 */
async function openReminderCandidates(user: UserConfig, now: Date, timezone: string): Promise<CalendarEvent[]> {
  if (user.calendarSource !== 'NATIVE') return [];
  try {
    const ctx = await loadViewerContext({ id: user.id, pairingId: user.pairingId ?? null });
    const { events } = await fetchOpenReminders(user, ctx, now, localDate(now, timezone), timezone, Infinity);
    return events;
  } catch (error) {
    captureError(error, 'voice-event-resolution', { user_id: user.id }, 'warning');
    return [];
  }
}

/** The open reminders the search's range did not already bring, ahead of its events. */
function withOpenReminders(events: CalendarEvent[], open: CalendarEvent[]): CalendarEvent[] {
  const fetched = new Set(events.map(e => e.eventId));
  const added = open.filter(e => !fetched.has(e.eventId));
  return added.length > 0 ? [...added, ...events] : events;
}

/** yyyy-MM-dd HH:mm on the user's clock, which orders one series' occurrences. */
function startKey(event: CalendarEvent, timezone: string): string {
  const span = localSpan(event, timezone);
  return `${span.startDate} ${span.startTime}`;
}

/** Whether an occurrence is still ahead: a date-only one all through its day. */
function isUpcoming(event: CalendarEvent, now: Date, timezone: string): boolean {
  return isAllDayEvent(event) ? event.start >= localDate(now, timezone) : new Date(event.start) >= now;
}

/**
 * One candidate per repeating reminder: its nearest occurrence from now on, else its
 * latest one before now. A daily reminder would otherwise put three weeks of identical
 * lines before the matcher, which could only answer "multiple". Events, one-off
 * reminders and the order are left as they are.
 */
export function collapseReminderSeries(events: CalendarEvent[], now: Date, timezone: string): CalendarEvent[] {
  const seriesOf = (e: CalendarEvent) => (isReminderEvent(e) ? e.recurringEventId : undefined);
  const chosen = new Map<string, CalendarEvent>();
  for (const event of events) {
    const series = seriesOf(event);
    if (!series) continue;
    const current = chosen.get(series);
    if (!current) {
      chosen.set(series, event);
      continue;
    }
    const ahead = isUpcoming(event, now, timezone);
    if (ahead !== isUpcoming(current, now, timezone)) {
      if (ahead) chosen.set(series, event);
      continue;
    }
    const earlier = startKey(event, timezone) < startKey(current, timezone);
    // Ahead: the soonest. Behind: the latest.
    if (ahead === earlier) chosen.set(series, event);
  }
  return events.filter(e => {
    const series = seriesOf(e);
    return !series || chosen.get(series) === e;
  });
}

/**
 * When the matcher cannot choose between events and reminders, the event wins, unless the
 * user asked about a reminder (spec §7). A tie among events alone, or among reminders
 * alone, stays "multiple".
 */
function settleKindTie(result: MatchResult, wantsReminder: boolean): MatchResult {
  if (!('error' in result) || result.error !== 'multiple_matches' || !result.multiple) return result;
  const reminders = result.multiple.filter(isReminderEvent);
  if (reminders.length === 0 || reminders.length === result.multiple.length) return result;
  const preferred = wantsReminder ? reminders : result.multiple.filter(e => !isReminderEvent(e));
  return preferred.length === 1
    ? { event: preferred[0], calendarId: preferred[0].calendarId }
    : { error: 'multiple_matches', multiple: preferred };
}
```

In `matchInRange`, find (lines 309-316 at the base; this is Task 11's text):
```ts
  timezone: string,
  day: string | undefined,
  options: MatchOptions = {},
): Promise<MatchResult> {
  const { startDate, endDate } = matchSearchRange(reference, now, timezone);

  // Fetch events from all calendars
  const provider = getProviderForUser(user);
  const fetched = await provider.fetchEventsInRange(user, calendarIds, startDate, endDate);
  const events = options.eligible ? options.eligible(fetched) : fetched;
```
Replace with:
```ts
  timezone: string,
  day: string | undefined,
  extras: MatchExtras,
): Promise<MatchResult> {
  const { startDate, endDate } = matchSearchRange(reference, now, timezone);

  // Fetch events from all calendars
  const provider = getProviderForUser(user);
  const fetched = await provider.fetchEventsInRange(user, calendarIds, startDate, endDate);
  const merged = withOpenReminders(fetched, extras.open);
  const events = collapseReminderSeries(extras.eligible ? extras.eligible(merged) : merged, now, timezone);
```

Find (lines 335-339):
```ts
  for (const candidates of rounds) {
    const eventList = candidates.map((e, i) => describeEventForMatching(e, i, timezone)).join('\n');
    result = await askMatcher(buildMatchPrompt(reference, language, eventList, now, timezone), candidates);
    if (!('error' in result) || result.error !== 'no_match') break;
  }
```
Replace with:
```ts
  for (const candidates of rounds) {
    const eventList = candidates.map((e, i) => describeEventForMatching(e, i, timezone)).join('\n');
    const rule: ReminderRule | undefined = candidates.some(isReminderEvent)
      ? extras.wantsReminder ? 'preferReminders' : 'preferEvents'
      : undefined;
    const prompt = buildMatchPrompt(reference, language, eventList, now, timezone, rule);
    result = settleKindTie(await askMatcher(prompt, candidates), extras.wantsReminder);
    if (!('error' in result) || result.error !== 'no_match') break;
  }
```

Notes:
- The order is the contract's: merge the open reminders, then the caller's `eligible` filter, then the series collapse. Task 11's anchor filter (`anchorCandidates`) drops every reminder and keeps one occurrence per repeating event, so for an anchor search the collapse changes nothing, no rule is added and `settleKindTie` is a no-op. An anchor search passes no `openReminders`, so it fetches none.
- The open reminders come in before the `events.length === 0` check, so a user whose only match is an old open reminder doesn't get "no events found".
- The open reminders start before the hinted day, so the existing two rounds offer them only after the day's own items.
- `fetchOpenReminders` is called with `cutoff = now` and `summaryDay` = today. Task 7's rule suppresses a series that occurs today, because the range fetch already brings that occurrence.
- For Google users `collapseReminderSeries` returns the same items in the same order, `settleKindTie` is a no-op, and no rule is added.

- [ ] **Step 6: A reminder's edit keeps one time (`event-resolution.ts`)**

Find (lines 428-429):
```ts
/** How long an all-day event made timed lasts when not given an end. */
const DEFAULT_TIMED_LENGTH_MS = 60 * 60 * 1000;
```
Replace with:
```ts
/** How long an all-day event made timed lasts when not given an end. */
const DEFAULT_TIMED_LENGTH_MS = 60 * 60 * 1000;

/** When a date-only reminder made timed with no time given rings: the hour it pings at. */
const REMINDER_DEFAULT_TIME = `${String(REMINDER_MORNING_HOUR).padStart(2, '0')}:00`;
```

Find (in `convertEditRequestToUpdates`, lines 506-510):
```ts
  const updates: UpdateEventData = {};

  if (!editRequest) return updates;

  if (editRequest.newTitle) {
```
Replace with:
```ts
  const updates: UpdateEventData = {};

  if (!editRequest) return updates;
  if (isReminderEvent(originalEvent)) return reminderUpdates(editRequest, originalEvent, timezone);

  if (editRequest.newTitle) {
```

At the end of the file, after `convertEditRequestToUpdates`'s closing `}` (line 586), append:
```ts

/**
 * A reminder's edit. A reminder has one time and no length (spec §7): its end is its
 * start, a date-only one stays at 00:00 of its day, and an end the model sends out of
 * habit (an hour after the new start) is dropped. Given a time, a date-only reminder
 * becomes a timed one; made timed with no time, it rings at the reminder morning hour.
 */
function reminderUpdates(editRequest: EditRequest, originalEvent: CalendarEvent, timezone: string): UpdateEventData {
  const updates: UpdateEventData = {};
  if (editRequest.newTitle) updates.title = editRequest.newTitle;
  if (editRequest.newLocation) updates.location = editRequest.newLocation;

  const original = localSpan(originalEvent, timezone);
  const wasAllDay = isAllDayEvent(originalEvent);
  // The model sends null for what it leaves alone, and allDay is a required Boolean
  const newAllDay = typeof editRequest.newAllDay === 'boolean' ? editRequest.newAllDay : undefined;
  const allDay = newAllDay ?? (wasAllDay && !editRequest.newStartTime);
  const day = editRequest.newStartDate || original.startDate;

  if (allDay) {
    if (editRequest.newStartDate || !wasAllDay) {
      updates.startTime = startOfLocalDay(day, allDayZone(originalEvent, timezone));
    }
  } else if (wasAllDay || editRequest.newStartDate || editRequest.newStartTime) {
    const time = editRequest.newStartTime || (wasAllDay ? REMINDER_DEFAULT_TIME : original.startTime);
    updates.startTime = fromZonedTime(`${day}T${time}:00`, timezone);
  }
  if (updates.startTime) updates.endTime = updates.startTime;
  if (newAllDay !== undefined || allDay !== wasAllDay) updates.allDay = allDay;
  return updates;
}
```

The store forces zero length anyway (Task 2). This keeps the confirmation card honest and gives the store a start it can normalize. `describeEdit` reads a zero-length all-day end as its own first day: its `lastDay < firstDay ? firstDay` clamp handles it.

- [ ] **Step 7: Check that `fetchOpenReminders` takes a cap (`open-reminders.ts`, Task 7's file)**

Nothing to change here. Task 7 already gives `selectOpenReminders` and `fetchOpenReminders` a trailing `cap: number = OPEN_REMINDERS_DIGEST_CAP`, and cuts the list and the `moreCount` arithmetic at `cap`. The matcher passes `Infinity`: `slice(0, Infinity)` keeps everything, and `moreCount` comes out 0.

Check:
```bash
grep -n "cap: number = OPEN_REMINDERS_DIGEST_CAP" src/services/native-reminders/open-reminders.ts
```
Expected: two lines, one in `selectOpenReminders` and one in `fetchOpenReminders`. The digest's own call (in `addDigestReminders`, which `summary.ts` calls) passes no cap, so a digest still names at most 5.

- [ ] **Step 8: The handlers (`handler.ts`)**

Find (line 19):
```ts
import { downloadVoiceFile, getLastCreatedEvent, findMatchingEvent, convertEditRequestToUpdates } from './event-resolution';
```
Replace with:
```ts
import { downloadVoiceFile, getLastCreatedEvent, findMatchingEvent, convertEditRequestToUpdates, isLastCreatedEvent } from './event-resolution';
```

Replace both occurrences (lines 83 and 176) of:
```ts
    targetEvent = events.find(e => e.eventId === lastEvent.eventId);
```
with:
```ts
    targetEvent = events.find(e => isLastCreatedEvent(e, lastEvent));
```

Replace both occurrences (lines 88-93 in `handleEditIntent` and 181-186 in `handleDeleteIntent`) of:
```ts
    const matchResult = await findMatchingEvent(
      user,
      calendarIds,
      intentResult.eventReference,
      user.language || 'en'
    );
```
with:
```ts
    const matchResult = await findMatchingEvent(
      user,
      calendarIds,
      intentResult.eventReference,
      user.language || 'en',
      undefined,
      { request: transcription, openReminders: true }
    );
```

`transcription` is these functions' fourth parameter: the transcript, the forwarded text, or the typed text from Task 12's route. Voice, forwarded and typed edits all pass through here.

- [ ] **Step 9: The provider hands back cleared pings (`types.ts`, `native-provider.ts`)**

In `src/services/calendar-provider/types.ts`, find (line 7):
```ts
import { CalendarEvent, UserConfig } from '../../types';
```
Replace with:
```ts
import { CalendarEvent, UserConfig } from '../../types';
import type { ClearedPing } from '../native-calendar/event-store';
```

Find (lines 82-88):
```ts
export interface UpdateEventResult {
  success: boolean;
  eventId?: string;
  eventLink?: string;
  error?: ProviderErrorCode;
  errorMessage?: string;
}
```
Replace with:
```ts
export interface UpdateEventResult {
  success: boolean;
  eventId?: string;
  eventLink?: string;
  error?: ProviderErrorCode;
  errorMessage?: string;
  // Native only: the live pings of a reminder whose time changed, now without state
  // (re-armed), so the caller can strip their buttons. Absent when there are none.
  clearedPings?: ClearedPing[];
}
```

In `src/services/calendar-provider/native-provider.ts`, find (line 244, in `updateEvent`):
```ts
      return { success: true, eventId: result.canonicalEventId };
```
Replace with:
```ts
      return {
        success: true,
        eventId: result.canonicalEventId,
        ...(result.clearedPings.length > 0 ? { clearedPings: result.clearedPings } : {}),
      };
```

An event's update result keeps exactly its old shape, with no `clearedPings` key. The type-only import from `event-store.ts` adds no runtime dependency.

- [ ] **Step 10: Create `src/services/native-reminders/moved-pings.ts`**

```ts
// A reminder moved from chat (spec §7). The event store re-arms it: the state of the
// occurrences it moved is deleted, and their pings still on screen come back to the
// caller. Each of those pings is edited to say where the reminder went, without its
// buttons, which now point at a state row that no longer exists.

import { formatInTimeZone } from 'date-fns-tz';
import type { ClearedPing } from '../native-calendar/event-store';
import type { UpdateEventData } from '../calendar';
import type { CalendarEvent, UserConfig } from '../../types';
import type { UnifiedEvent } from '../calendar-provider/types';
import { getUserByTelegramId } from '../user-service';
import { getBotMessage } from '../../lib/bot-messages';
import { resolveUserTimezone } from '../../lib/timezone';
import { captureError } from '../../lib/error-capture';
import { escapeHtml } from '../../utils/html';
import { startOfLocalDay } from '../../utils/day-events';
import { isAllDayEvent } from '../../utils/event-formatter';
import { stripPingButtons } from './ping';

/**
 * Where a reminder now is, as its ping reads it: "Fri, Oct 16 10:00" on the reader's
 * clock, or "Fri, Oct 16" for a date-only one, whose day is its own (`ownZone`).
 */
export function movedWhen(startsAt: Date, allDay: boolean, language: string, readerZone: string, ownZone: string): string {
  const locale = language === 'he' ? 'he-IL' : language === 'ru' ? 'ru-RU' : 'en-US';
  const zone = allDay ? ownZone : readerZone;
  const day = startsAt.toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric', timeZone: zone });
  return allDay ? day : `${day} ${formatInTimeZone(startsAt, zone, 'HH:mm')}`;
}

/**
 * Edit each cleared ping to "⏰ <title> · moved to <when>", without buttons. A ping is
 * read by its recipient, who may be the partner: a private chat's id is its user's
 * Telegram id, so it is read in their language and on their clock, else the editor's.
 * Best-effort: the edit is already saved, so a failed ping edit is only logged.
 */
export async function stripMovedPings(
  pings: ClearedPing[],
  original: CalendarEvent,
  updates: UpdateEventData,
  editor: UserConfig
): Promise<void> {
  const editorZone = await resolveUserTimezone(editor);
  // A date-only reminder's day is read in its own timezone (native-provider toUnifiedEvent)
  const ownZone = (original as Partial<UnifiedEvent>).timeZone || editorZone;
  const allDay = updates.allDay ?? isAllDayEvent(original);
  const startsAt = updates.startTime
    ? new Date(updates.startTime)
    : isAllDayEvent(original) ? startOfLocalDay(original.start, ownZone) : new Date(original.start);
  const title = escapeHtml(updates.title || original.summary);

  for (const ping of pings) {
    try {
      const reader = (await getUserByTelegramId(ping.chatId)) ?? editor;
      const language = reader.language || 'en';
      const readerZone = reader === editor ? editorZone : await resolveUserTimezone(reader);
      const when = movedWhen(startsAt, allDay, language, readerZone, ownZone);
      const text = await getBotMessage(language, 'nativeReminders.moved', { title, when });
      await stripPingButtons(ping.chatId, ping.messageId, text);
    } catch (error) {
      captureError(error, 'native-reminder-moved-ping', { user_id: editor.id, chat_id: String(ping.chatId) }, 'warning');
    }
  }
}
```

`escapeHtml` comes from the leaf `src/utils/html.ts` (Task 4), not from `confirmations.ts`, so this module never loads the voice UI chain (Global Constraints, HTML).

The spec's example reads "moved to Fri 10:00". This copy adds the date ("Fri, Oct 16 10:00"), so a move of more than a week doesn't read as this week's Friday. A date-only reminder shows its date alone, read in the reminder's own timezone, the same way `toUnifiedEvent` reads it.

- [ ] **Step 11: The create, edit and delete callbacks (`callbacks.ts`)**

A native `PERMISSION_DENIED` gets the built-in calendar's own answer on all three (Planning Ruling 12, spec §11.4). `PERMISSION_DENIED` branches occur three times in this file (create ~155, edit ~316, delete ~480 at the base), so each find below takes enough of the branch before it to be unique.

In `handleEventCallback`, find (line 155 at the base, the end of the create success branch, as Task 11 leaves it):
```ts
          disable_web_page_preview: true
        }
      );
    } else if (result.error === 'PERMISSION_DENIED') {
      const upgradeUrl = buildUrl(`/refresh-token?user_id=${user.telegramId}&scope=write`);

      await bot.editMessageText(
        `${t.voice.permissionRequired}\n\n${t.voice.permissionMessage}`,
```
Replace with:
```ts
          disable_web_page_preview: true
        }
      );
    } else if (result.error === 'PERMISSION_DENIED' && user.calendarSource === 'NATIVE') {
      // On the built-in calendar no grant fixes this: the calendar is not theirs to add to
      await bot.editMessageText(t.nativeReminders?.permissionDenied || "You can't change this one.", {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'HTML'
      });
    } else if (result.error === 'PERMISSION_DENIED') {
      const upgradeUrl = buildUrl(`/refresh-token?user_id=${user.telegramId}&scope=write`);

      await bot.editMessageText(
        `${t.voice.permissionRequired}\n\n${t.voice.permissionMessage}`,
```

Find (lines 312-316, the end of the edit success branch):
```ts
        endsAt: (updates.endTime ?? new Date(originalEvent.end)).toISOString(),
        action: 'edit',
      });
    } else if (result.error === 'PERMISSION_DENIED') {
```
Replace with:
```ts
        endsAt: (updates.endTime ?? new Date(originalEvent.end)).toISOString(),
        action: 'edit',
      });

      // A reminder moved to another time was re-armed: its pings still on screen say
      // where it went, and lose their buttons (spec §7).
      if (result.clearedPings?.length) {
        const { stripMovedPings } = await import('../native-reminders/moved-pings');
        await stripMovedPings(result.clearedPings, originalEvent, updates, user);
      }
    } else if (result.error === 'PERMISSION_DENIED' && user.calendarSource === 'NATIVE') {
      // On the built-in calendar no grant fixes this: the item is not theirs to change
      await bot.editMessageText(t.nativeReminders?.permissionDenied || "You can't change this one.", {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'HTML'
      });
    } else if (result.error === 'PERMISSION_DENIED') {
```

Find (lines 476-480, the end of the delete success branch):
```ts
          action: 'delete',
        });
      }
    } else if (result.error === 'PERMISSION_DENIED') {
```
Replace with:
```ts
          action: 'delete',
        });
      }
    } else if (result.error === 'PERMISSION_DENIED' && user.calendarSource === 'NATIVE') {
      // On the built-in calendar no grant fixes this: the item is not theirs to delete
      await bot.editMessageText(t.nativeReminders?.permissionDenied || "You can't change this one.", {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'HTML'
      });
    } else if (result.error === 'PERMISSION_DENIED') {
```

The Google `PERMISSION_DENIED` branches below are untouched. `moved-pings` is imported lazily, like the other optional pieces in this file.

- [ ] **Step 11b: Escape titles in the edit and delete success messages (`callbacks.ts`)**

Review Focus 3. The edit and delete success messages put the title into HTML unescaped, so a title with `<`, `>` or `&` makes Telegram reject the message. Task 11 already imports `escapeHtml` into this file through `./confirmations`.

Find (the edit success message, one line):

```ts
        `📅 ${updates.title || originalEvent.summary}${linkButton}`,
```

Replace with:

```ts
        `📅 ${escapeHtml(updates.title || originalEvent.summary)}${linkButton}`,
```

Find (the delete success message, one line):

```ts
        `📅 <s>${event.summary}</s>`,
```

Replace with:

```ts
        `📅 <s>${escapeHtml(event.summary)}</s>`,
```

Then add this check to `scripts/smoke-native-reminder-edit.ts` with the other callback checks. It reuses that script's callback harness: the fake provider, the recorder of `editMessageText` texts and the pending edit/delete stubs. A pending edit whose new title is `Fix <sink> & tap`, confirmed, must produce a message containing `Fix &lt;sink&gt; &amp; tap` and not `<sink>`. A pending delete of an event titled `A & B`, confirmed, must produce a message containing `<s>A &amp; B</s>`. That adds 2 checks, so raise this script's expected total by 2 in Step 15.

- [ ] **Step 12: The WhatsApp edit confirm (`webhook-handlers.ts`)**

Find (lines 1201-1205, in `handleWhatsAppVoiceCallback`'s `edit_confirm` branch):
```ts
      await removePendingEdit(pendingId);
      await waService.sendMessage(phone, result.success
        ? `✅ ${wa.eventUpdated || 'Event updated!'}`
        : `❌ ${(wa.editFailed || 'Failed to update: {error}').replace('{error}', result.error || '')}`);
    } else if (action === 'edit_cancel') {
```
Replace with:
```ts
      await removePendingEdit(pendingId);
      await waService.sendMessage(phone, result.success
        ? `✅ ${wa.eventUpdated || 'Event updated!'}`
        : `❌ ${(wa.editFailed || 'Failed to update: {error}').replace('{error}', result.error || '')}`);
      // A moved reminder's pings are on Telegram, whichever chat moved it (spec §7)
      if (result.clearedPings?.length) {
        const { stripMovedPings } = await import('./native-reminders/moved-pings');
        await stripMovedPings(result.clearedPings, pending.originalEvent, pending.updates, pending.user);
      }
    } else if (action === 'edit_cancel') {
```

Nothing produces WhatsApp edit cards today, so this branch is unreachable for now. It is wired anyway so it can't drift from the Telegram one. It isn't exported, so the smoke script tests the Telegram callback only.

- [ ] **Step 13: The edit and delete cards show one time (`confirmations.ts`)**

Find (line 16; Task 4 adds its `escapeHtml` import and re-export right below it, Task 11 adds imports above it, and neither imports `isReminderEvent` here):
```ts
import { daysBetween, describeEdit, EditSpan } from './event-resolution';
```
Replace with:
```ts
import { daysBetween, describeEdit, EditSpan } from './event-resolution';
import { isReminderEvent } from '../../utils/event-formatter';
```

Find (lines 182-186, the end of `formatCalendarEventDateTime`):
```ts
    return `📆 ${day} (${allDayText})`;
  }

  return `📆 ${dateStr}\n🕐 ${startTimeStr} - ${endTimeStr}`;
}
```
Replace with:
```ts
    return `📆 ${day} (${allDayText})`;
  }

  // A reminder has one time, never a range
  if (isReminderEvent(event)) return `📆 ${dateStr}\n🕐 ${startTimeStr}`;

  return `📆 ${dateStr}\n🕐 ${startTimeStr} - ${endTimeStr}`;
}
```

`formatEditChanges` needs no change. A reminder's start and end move together, so its "🕐" line shows `10:00 → 17:00`.

- [ ] **Step 14: Track reminders created without a card (`auto-create.ts`, `bulk-confirmations.ts`)**

In `src/services/voice/auto-create.ts`, find (the last two imports, which Task 11 added after line 25):
```ts
import { reminderCreateFields } from '../native-reminders/resolve';
import { trackActivityAsync } from '../analytics-service';
```
Replace with:
```ts
import { reminderCreateFields } from '../native-reminders/resolve';
import { trackActivityAsync } from '../analytics-service';
import { trackCreatedEvent } from './event-resolution';
import { captureError } from '../../lib/error-capture';
```

Find (line 106 and the line after it; Task 11's `...reminderCreateFields(event)` is in the create call just above):
```ts
  if (!result.success || !result.eventId) return false;

  const token = await storeUndoToken({
```
Replace with:
```ts
  if (!result.success || !result.eventId) return false;

  // "Cancel that" reaches a reminder made without a card too (spec §11.3)
  if (event.kind === 'reminder' && user.telegramId != null) {
    trackCreatedEvent(user.telegramId, result.eventId, calendarId, event)
      .catch(err => captureError(err, 'voice-track-event', { user_id: user.id }, 'warning'));
  }

  const token = await storeUndoToken({
```

In `src/services/voice/bulk-confirmations.ts`, find (the `getBotMessage` import Task 11 added):
```ts
import { getBotMessage } from '../../lib/bot-messages';
```
Replace with:
```ts
import { getBotMessage } from '../../lib/bot-messages';
import { trackCreatedEvent } from './event-resolution';
import { captureError } from '../../lib/error-capture';
```

Find (lines 189-191 at the base, in `handleBulkConfirmAll`; Task 11 put its `if (ev.kind === 'reminder') { trackActivityAsync(…) }` block above these two lines):
```ts
      const calId = ev.calendarId || 'primary';
      await pushRecentEvent(pending.user.id, {
```
Replace with:
```ts
      const calId = ev.calendarId || 'primary';
      // "Cancel that" reaches the batch's last reminder, as after a card (spec §11.3)
      if (ev.kind === 'reminder' && pending.user.telegramId != null) {
        trackCreatedEvent(pending.user.telegramId, result.eventId, calId, ev)
          .catch(err => captureError(err, 'voice-track-event', { user_id: pending.user.id }, 'warning'));
      }
      await pushRecentEvent(pending.user.id, {
```

Notes:
- `trackCreatedEvent` takes the **telegramId**, the same key the card path uses (`callbacks.ts:105`). Don't swap it for `user.id`.
- The tracker holds what was actually created. `resolveReminderIntents` (Task 11) already put the reminder's main calendar, start and end on `event` / `ev`, and `calendarId` / `calId` are the calendar ids passed to `provider.createEvent`. So "cancel that" refetches the right calendar and time, never `'primary'` (which the native provider can't read) or an anchor reminder's placeholder time.
- Events keep today's behaviour: they still aren't tracked from these two paths.

- [ ] **Step 15: Run the tests and confirm they pass**

```bash
TZ=UTC npx tsx scripts/smoke-native-reminder-edit.ts
TZ=Asia/Jerusalem npx tsx scripts/smoke-native-reminder-edit.ts
TZ=UTC npx tsx scripts/smoke-voice-dates.ts | tail -1
TZ=Asia/Jerusalem npx tsx scripts/smoke-voice-dates.ts | tail -1
for s in smoke-day-shaping smoke-week-lookahead smoke-recurrence smoke-reminders smoke-native-reminder-ownership \
  smoke-native-reminder-store smoke-native-reminder-support smoke-native-provider-reminders smoke-partner-labels \
  smoke-native-reminder-digest smoke-native-reminders smoke-native-reminder-buttons smoke-native-reminder-creation \
  smoke-native-reminder-create-flow smoke-native-reminder-typed; do
  for tz in UTC Asia/Jerusalem; do echo "== $s $tz"; TZ=$tz npx tsx scripts/$s.ts | grep -E '^FAIL|passed'; done
done
npx tsc --noEmit -p .
npm run -s lint
```

Expected:
- `smoke-native-reminder-edit.ts`: twelve `OK` lines and `12/12 passed (process TZ=UTC)`, then `12/12 passed (process TZ=Asia/Jerusalem)`.
- `smoke-voice-dates.ts`: `72/72 passed` under both clocks (66 before this task, plus its six).
- The regression loop: no `FAIL` line, and each script's `passed` line shows all passed, with the counts Tasks 1-12 left.
- `tsc` and lint print nothing and exit 0.

Why these scripts: `event-resolution.ts` now loads `ownership.ts`, `open-reminders.ts` and `due.ts` at import (they touch the database only when called), and `auto-create.ts` and `bulk-confirmations.ts` now import `event-resolution.ts`.
- Task 11's `smoke-native-reminder-create-flow` runs the anchor lookup through `findMatchingEvent` with `{ eligible }`, which now goes through `MatchExtras`, and its auto-create and bulk checks now also write the last-created tracker to its fake Redis.
- Task 10's `smoke-native-reminder-creation` and Task 12's `smoke-native-reminder-typed` fake `handleEditIntent` / `handleDeleteIntent` (their `src/services/voice/index.ts` stub), so the open-reminder lookup never runs there; they only load the new imports.

- [ ] **Step 16: Commit**

```bash
git add src/services/voice/event-resolution.ts src/services/voice/handler.ts src/services/voice/callbacks.ts \
  src/services/voice/confirmations.ts src/services/voice/auto-create.ts src/services/voice/bulk-confirmations.ts \
  src/services/calendar-provider/types.ts src/services/calendar-provider/native-provider.ts \
  src/services/native-reminders/moved-pings.ts \
  src/services/webhook-handlers.ts scripts/smoke-native-reminder-edit.ts scripts/smoke-voice-dates.ts
git commit -m "$(cat <<'EOF'
feat(reminders): edit, move and delete reminders from chat

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
EOF
)"
```

---

### Task 14: Verification and landing (run by the controller, not a subagent)

**Files:**
- Test: every `scripts/smoke-*.ts`, `scripts/check-i18n-parity.ts`, `scripts/eval-native-reminders.ts`
- Create (scratch only, never committed): a throwaway DB check script and logs under the session scratchpad (`$SCRATCH` below)

**Interfaces:**
- Consumes: everything from Tasks 1–13.
- Produces: a verified branch, landed on `main`.

- [ ] **Step 1: Run the full offline suite with fake credentials**

`@prisma/client` loads the repo `.env`, and dotenv never overrides variables that are already set, so export fakes first. Otherwise a smoke script that misses a stub reaches real services.

```bash
cd /Users/razielgershoni/development/famcalbot
export DATABASE_URL=postgresql://test@db.invalid/test DIRECT_URL=postgresql://test@db.invalid/test \
  GEMINI_API_KEY=test OPENAI_API_KEY=test ANTHROPIC_API_KEY=test \
  UPSTASH_REDIS_REST_URL=https://redis.invalid UPSTASH_REDIS_REST_TOKEN=test \
  TELEGRAM_BOT_TOKEN=test ENCRYPTION_KEY=$(printf '0%.0s' {1..64})
for tz in UTC Asia/Jerusalem; do
  for f in scripts/smoke-*.ts; do
    TZ=$tz npx tsx "$f" > "$SCRATCH/smoke.log" 2>&1 || { echo "FAIL $tz $f"; tail -20 "$SCRATCH/smoke.log"; }
  done
done
npx tsx scripts/check-i18n-parity.ts && npx tsc --noEmit -p . && npm run -s lint && echo ALL-GREEN
```
Expected: no `FAIL` lines, then `i18n parity OK (...)` and `ALL-GREEN`.

Decide exclusions only from each script's header comment. Exclude a script only if its header says it calls a network service. `smoke-voice-show-writer.ts` and `smoke-tts.ts` say "No network", so they run. List every excluded script in the report.

- [ ] **Step 2: Live extraction eval at MEDIUM thinking**

Run (the plain `npx tsx` form can fail on the ESM-only `@hebcal/core`):

```bash
unset DATABASE_URL DIRECT_URL GEMINI_API_KEY OPENAI_API_KEY ANTHROPIC_API_KEY UPSTASH_REDIS_REST_URL UPSTASH_REDIS_REST_TOKEN TELEGRAM_BOT_TOKEN ENCRYPTION_KEY
NODE_OPTIONS='--conditions=import' npx tsx -r dotenv/config scripts/eval-native-reminders.ts
```

Expected: every row passes. Also run a few typed-mode phrases through `processTextWithGemini(…, 'typed')`, because the eval never exercises the typed header:
- "remind me to call mom tomorrow at 5"
- "תזכיר לי לקנות חלב"
- "напомни мне в пятницу"

For a miss, fix the reminder block in `buildEventExtractionPrompt`, then re-run. Never lower the thinking level, and never weaken an assertion. Commit the fix as `fix(reminders): <what the prompt now says>`. Any miss that remains after two prompt rounds goes in the final report, verbatim.

- [ ] **Step 3: Live digest wording check**

Generate one daily digest and one tomorrow digest per language (en/he/ru) through `generateSummary`. Use fixture events that include a timed reminder, a date-only reminder, an open-since reminder, a done reminder and a partner reminder. Read them and check:
- no reminder shows `HH:MM - HH:MM`;
- the done reminder is absent;
- "open since" reads naturally;
- partner attribution is by name;
- nothing reads as a literal translation.

If anything fails, fix the prompts, keeping MEDIUM. Also print the created-reply strings (`formatReminderCreated`) for today, tomorrow and next week, in all three languages, and read them for naturalness.

- [ ] **Step 4: Database pass on the DEV database**

1. **Confirm the target.** The local `.env` `DATABASE_URL` and `UPSTASH_REDIS_REST_URL` must both point at dev, not production. Compare each host with production's from Railway (`railway variables --kv` if the CLI is linked), printing only the hostnames and never a credential. If the database can't be confirmed as dev, skip this step and say so. If only Redis can't be confirmed, stub `src/utils/redis.ts` in the scratch script with an in-memory map.
2. Run `npx prisma migrate deploy` against dev.
3. Write `$SCRATCH/db-pass.ts`, using the real Prisma client, to run the following steps:
   1. **Set up.** Create two NATIVE users with fake telegramIds in the 9_000_000_000 range. Pair them (ACTIVE). Run `ensurePrimaryNativeCalendar` for both. Then set the creator's main calendar privacy to `PRIVATE`; onboarding makes it SHARED_EDITOR when paired, which would hide the supplementary-query path.
   2. **Create through `nativeProvider.createEvent`:**
      - (a) a timed reminder 1 minute ago, for the partner;
      - (b) a date-only reminder today, for self;
      - (c) a daily reminder `FREQ=DAILY;UNTIL=<yesterday yyyymmdd>`, starting 3 days ago at 10:00;
      - (d) a running daily reminder (no UNTIL), starting 3 days ago at 10:00.

      Backdate (c) and (d) with `prisma.nativeEvent.update({ data: { armedAt: <4 days ago> } })`. Creation arms at "now", and Planning Ruling 4 never carries over an occurrence from before `armedAt`.
   3. Run `runNativeReminderPass()` with the Telegram sender stubbed through `require.cache` so it records sends and returns increasing message ids.
   4. **Assert:**
      - (a) was sent to the partner's telegramId, and its claim row has `lastPingedAt` and `pingMessageId` set;
      - a second pass at the same `now` sends nothing;
      - `fetchOpenReminders` for the creator, with the summary day = today, returns exactly one event for (c) with `reminder.openSince` = yesterday, and none for (d), because it occurs today;
      - the partner sees (a) through `nativeProvider.fetchTodayEvents`, although the creator's calendar is PRIVATE;
      - `updateNativeEvent` on (a) with a new time deletes its state row and returns its ping in `clearedPings`.
   5. **Clean up.** In a `finally`, delete every row it created, in FK order: reminder states, instances, events, calendars, pairing, users. Print the counts deleted.
4. **Count the legacy rows Task 3 could affect** (Planning Ruling 13). This is a read-only count, against production only if the Railway CLI can supply its URL straight into the environment of a one-off `node -e` that runs a single `SELECT count(*)`. Never print the URL. Count `NativeEvent` rows whose `rrule ~ 'UNTIL=\d{8}(;|$)'` and whose `"timeZone"` has a negative UTC offset today. Report the number, or "not counted".

- [ ] **Step 5: Fresh-clone build**

```bash
git push -q -u origin feat/native-reminders
D="$SCRATCH/fc-reminders"; rm -rf "$D" && git clone -q --branch feat/native-reminders https://github.com/raziel-gershoni/famcalbot.git "$D" && cd "$D" \
  && npm ci --no-audit --no-fund > "$SCRATCH/fc-reminders-ci.log" 2>&1 && npx prisma generate > "$SCRATCH/fc-reminders-gen.log" 2>&1 \
  && npx -y node@22 node_modules/.bin/next build > "$SCRATCH/fc-reminders-build.log" 2>&1; echo "fresh-clone-build=$?"
grep -rl "__nativeReminderDueGate" "$D/.next/server" | head
```
Expected:
- `fresh-clone-build=0`;
- the grep lists at least one instrumentation chunk and one route chunk, which shows that both bundles reach the gate through `globalThis`.

- [ ] **Step 6: Land on main (the owner allowed it for this work)**

```bash
cd /Users/razielgershoni/development/famcalbot
git fetch -q origin && git merge-base --is-ancestor origin/main feat/native-reminders && git push -q origin feat/native-reminders:main
```
1. Poll `gh api repos/raziel-gershoni/famcalbot/commits/<sha>/status` every few minutes until "famcalbot - famcalbot" and "Vercel" are both `success`. Railway's build runs the migration.
2. Fast-forward local `main` and delete the local branch.
3. Ping the owner with a concise report:
   - what shipped;
   - the planning rulings that change behaviour (R5 cap, R6 snooze time, R8 partner labels, R9 copy rename, Planning Rulings 4, 6 and 11);
   - excluded scripts;
   - eval misses;
   - the legacy-row count.

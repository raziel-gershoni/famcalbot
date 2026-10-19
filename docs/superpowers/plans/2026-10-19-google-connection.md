# Google as a connection, plus the cross-source move — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every user has FamCal, and Google is an optional connection read beside it. Events can move between the two kinds from the editor's Calendar row.

**Architecture:**
- Gates key on facts: "has FamCal" (always, lazily) and "has a Google token, chosen calendars", never on `User.calendarSource`.
- Providers are chosen per calendar id.
- A single native↔Google mapper serves the move now and the sync later.

**Tech stack:** Next.js 16, Prisma, Upstash Redis (the NX lock), `@googleapis/calendar` 9.8, rrule 2.8, next-intl.

**Spec:** docs/superpowers/specs/2026-10-19-google-connection-design.md. It's the authority; section numbers below refer to it. Research and reviews: session scratchpad next/facts-connection.md, facts-google-write.md, review-connection-code.md and review-connection-product.md. Every file:line in the spec was verified at 89bde38. Re-find each one by grep, because 3b and Hebrew repeats have moved lines since.

## Global constraints
- **No migration.** `calendarSource` stays, unread; no code reads it after this plan except the admin "legacy" label, if any.
- **One code path.** The bot (TG and WA), the home and the cron share every function changed here.
- **No silent failures.** Every catch logs, and server catches go through `captureError`. No titles in logs. The move's lock fails closed.
- **No inline user-facing strings.** messages/{en,he,ru}.json, natural for each language: gender-neutral Hebrew, formal вы in Russian.
- **Tests never reach Google, Telegram or the DB.** Smokes use the fake env runner, under UTC and Asia/Jerusalem.

## Review focus
1. A Google-only user, the owner for one, sees no change in where their events go, and isn't pushed into FamCal.
2. A Google failure never hides FamCal: not in summaries, alerts or voice matching.
3. A partner's event never leaves the partner's view through a move.
4. A move never loses the only copy, through any failure order.
5. Every `calendarSource` read in src/ and app/ is gone or intended. Grep at the end.

---

### Task G1: The model switch (§1-§4, server)

**Files** (re-find each by grep):
- `src/services/calendar-read/{index.ts,famcal.ts,digest.ts}`
- `src/services/calendar-provider/user-calendars.ts`
- `src/services/native-calendar/onboarding.ts`
- `src/services/google-connect.ts`
- `src/services/pairing-service.ts`, `app/api/pair/route.ts`
- `app/api/native-calendars/route.ts` and `[id]/route.ts`
- `app/api/select-calendars/route.ts`
- `src/lib/page-data.ts`
- `src/services/subscription-service.ts` (`checkCalendarLimit`)
- `src/services/native-reminders/{support.ts,resolve.ts,ownership.ts,open-reminders.ts}`
- `src/services/calendar-write/item-info.ts` (the editor union), `src/services/voice/event-resolution.ts` (`openReminderCandidates`)
- `src/cron/handlers.ts`, `app/api/settings/route.ts`, `src/services/account-linking.ts`
- `src/utils/calendar-helpers.ts` (primary uniqueness), and a new `defaultCalendarFor` next to it
- the admin routes and stats
- Tests: a new `scripts/smoke-calendar-connection.ts`, plus the existing smokes

- [ ] Write the failing smoke-calendar-connection checks from spec §7, first bullet. Watch them fail.
- [ ] Switch `sourcesFor`, the `readFamcal` gate, the union in `getCalendarAssignmentsForUser`, `hasUsableCalendar` and `ensurePrimaryNativeCalendar` (§3's labels). Add `defaultCalendarFor(calendars)` (§3) and primary uniqueness "only when newly added" in the three save routes, plus the select-calendars note.
- [ ] Remove the either/or writes: `commitGoogleToken`'s flip and soft-delete, the pairing gates, native-calendars `native_only`, the page notices, the WA→TG merge rules (§4). Make reminder-cache eligibility and summary.ts `hasBackend`/assignments source-free.
- [ ] Native reminders for everyone (§4 Native reminders), plan and Telegram gates kept. The 3b editor info becomes the union: FamCal kinds and partner plus writable Google rows, where a failed `calendarList` drops only the Google rows.
- [ ] Calendar limit: a shared total that skips the FamCal main when Google is chosen; block only above the limit **and** when the total rises.
- [ ] Setup tracks: delete the oauth track (cron, admin send and reset); choose-calendars at any age; reconnect for a token that's dead or cleared while calendars are stored. Admin badges and stats by token.
- [ ] Run smoke-calendar-connection, page-auth, miniapp-gate, every `smoke-native-*`, pairing smokes, `smoke-reminder-*`, digest-reader, summary-*, the voice smokes, tsc and lint. Commit per step.

### Task G2: Providers by calendar id (§4 Providers, Gates, Summaries)

**Files:**
- `src/services/calendar-provider/{index.ts,types.ts}`
- every `getProviderForUser` call site (15, listed in spec §4)
- `src/services/voice/{callbacks.ts,handler.ts,auto-create.ts,bulk-confirmations.ts,event-resolution.ts,gemini-voice.ts}`
- `src/services/webhook-handlers.ts`, `src/services/reminders.ts`, `src/services/week-lookahead.ts`
- `src/services/claude.ts`, `src/services/telegram/{voice.ts,summary.ts}`
- `src/services/kid-name-detection.ts`, `src/services/kid-name-callbacks.ts`, `src/services/voice-show/context.ts`
- `src/services/calendar-read/digest.ts`
- Tests: the connection smoke, the voice smokes, digest-reader, week-lookahead, plus a reminders smoke for the split fetch (add one if none exists)

- [ ] Write failing checks:
  - routing by id;
  - the split fetch's `{ events, failed }`;
  - the legacy alerts with a failed Google half;
  - voice matching ("couldn't check Google");
  - the LLM "no match" → `defaultCalendarFor`, and the reminder pin to FamCal, with the plan fallback;
  - the target-keyed token and denied copy in callbacks;
  - week-lookahead with mixed ids;
  - digest: the FamCal half kept on reconnect (summary sent with the line) and on outage (FamCal only); FamCal-only users unaffected.
- [ ] Implement `providerForCalendar` and the split fetch, then switch the 15 call sites and the `'primary'` literal fallbacks (spec §3 list).
- [ ] The union in claude.ts, telegram/voice.ts, kid-name (with the `personName` write-back for FamCal) and voice-show.
- [ ] Summaries: change `throwForDigest`, the `googleOut` path and the week block; delete `googleWithoutToken`.
- [ ] Run the task's smokes, every voice smoke, the WA webhook smokes, summary-*, tsc and lint. Commit per step.

### Task G3: The client (§2)

**Files:**
- `src/lib/page-data.ts` (props: `sources`, `googleConnected`, `googleState`)
- `src/lib/calendar-view/{home-client.ts,home-props.ts}`
- `app/[locale]/dashboard/{CalendarHome.tsx,HomeBanners.tsx,MenuSheet.tsx,PageGate.tsx}` (re-find PageGate by grep)
- `messages/*.json`
- Test: `scripts/smoke-calendar-home-render.ts` (append numbered checks in the file's style)

- [ ] Write failing render checks:
  - banners and menu by Google state (spec §2 list);
  - both sources fetched for a connected user;
  - the "+" and reminders for Google users;
  - mixed calendar rows in the editor, with the default from `defaultCalendarFor`;
  - no tab-bar hiding for Google users without a token.
- [ ] Props and gates from facts. `homeSources` comes from props. Remove `calendarSource` from the client.
- [ ] Copy: Connect entry, select-calendars note. Run render, copy, page-auth, parity, tsc and lint. Commit.

### Task G4: The cross-source move (§5)

**Files:**
- `src/services/calendar-move/{mapper.ts,move.ts}` (new)
- `src/services/native-calendar/event-store.ts` (`createNativeSeries`)
- `src/services/calendar-write/{write.ts,item-info.ts,validate.ts}` (`moveTargets` across kinds, refusals, the "saved alone" rule)
- `src/services/analytics-service.ts` (`calendar_item_moved`)
- `src/lib/calendar-view/{store.ts,home-loader.ts}` (`dropItem`)
- `app/[locale]/dashboard/{EditorSheet.tsx,ScopeSheet.tsx,CalendarHome.tsx}`
- `messages/*.json`
- Tests: a new `scripts/smoke-calendar-move.ts` (fake Prisma + fake Google client, reusing smoke-google-write's fake), plus render checks

- [ ] Write the failing smoke-calendar-move checks from spec §7, second bullet. Watch them fail.
- [ ] Mapper both ways, with every UNTIL and EXDATE form, all-day ends, zones, the overrides via `events.instances({ originalStart })` and the iCalUID listing filter. `createNativeSeries` writes in one transaction.
- [ ] `move.ts`:
  - eligibility and refusals;
  - the fail-closed NX lock (its own key prefix, `set nx ex`, released in finally; a Redis error refuses the move);
  - copy-then-delete;
  - re-read before compensating;
  - the retry reuse and repair by `famcalMovedFrom` in the destination only;
  - logs with ids only;
  - analytics.
- [ ] Routes: PATCH with a cross-kind `calendarId` → move, with the "saved alone" rule. Item info: `moveTargets` across kinds, the reasons, and the "partner will see" flag.
- [ ] Client: the scope sheet (whole series only, with its line), the notes, the saved-alone note, `dropItem` and a follow across kinds. Copy in en/he/ru.
- [ ] Run smoke-calendar-move, editor-api, smoke-google-write, render, tsc and lint. Commit per step.

### Task G5: Finish
- [ ] Grep src/ and app/ for `calendarSource`. Every hit is a write of the legacy column or intended; list them in the commit message.
- [ ] Update the spec's status and Known limitations to match what shipped. Update CLAUDE.md or README where they describe FamCal-or-Google.
- [ ] Commit.

# Calendar Home, Plan B: Switch, Reader and Range Route — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the calendar home's server side behind a rollout switch that ships `OFF`. That means the switch and its admin control, the shared reader (FamCal half, Google half, Google cache and its stamp), the pure week-start and Hebrew-date rules, and `GET /api/calendar/range`. On deploy nothing changes for users except the stamp hook on Google writes.

**Architecture:**
- `src/services/calendar-read/` holds the reader:
  - `rollout.ts` is the switch;
  - `types.ts` and `dto.ts` are the shapes;
  - `famcal.ts` and `google.ts` are the two halves, with `google-map.ts` as Google's pure rules;
  - `index.ts` is `readRange`.
- `src/lib/calendar-view/types.ts` is the client-safe DTO, with no imports. `src/utils/locale-rules.ts` and `src/config/week-start-zones.ts` hold the week-start and Hebrew-date rules.
- The route authenticates the way every route does (`verifyUserAuth`), answers 404 `not_enabled` while the switch doesn't cover the user, computes the day facts on the server and returns the DTO.
- Nothing calls the reader from the summaries yet; that is Plan C.

**Tech Stack:** Next.js 16.1 (standalone, Turbopack `next build`, `after()` from `next/server`) · TypeScript · Prisma 5 + Neon Postgres · Upstash Redis · `@googleapis/calendar` 9.8 · tsx smoke scripts (no test runner).

**Spec:** `docs/superpowers/specs/2026-10-16-calendar-home-design.md`: §1, §2 (except `digest.ts`), §4, §6's pure rules and §10's Plan B smokes. This is the second of the spec's five delivery plans (A → B → C ∥ D → E); Plan A is on `main`.

## Global Constraints

- The repo is PUBLIC. Never commit, print or hardcode secrets. Never read or print `.env*` files. Production is read-only; never call `/api/health`.
- **No test runner.** Tests are `tsx` smoke scripts in `scripts/`, in the `check()`/`assert()` style of `scripts/smoke-week-lookahead.ts`, printing `N/N passed` and exiting non-zero on failure. They stub modules through `require.cache` (and a `Module.registerHooks` hook where a module is loaded with `import()`). They never touch the real DB, Redis, Google, Telegram or AI. They must type-check: `next build` type-checks `scripts/**`.
- **Every smoke run fakes every `.env` name first** (Prisma loads `.env` for any unset variable). Use this prefix, with `TZ=Asia/Jerusalem` runs, and `TZ=Pacific/Kiritimati` runs where a step says so:
  ```bash
  TZ=UTC DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/<name>.ts; echo "exit $?"
  ```
- **Prisma:** run `prisma format`, `prisma generate` and `prisma migrate diff` only. Never run `prisma migrate dev`, `migrate deploy` or `db push` locally. The migration is `prisma/migrations/20261016000000_calendar_home_rollout/migration.sql`, and production applies it in `npm run build` (`prisma generate && prisma migrate deploy && next build`).
- Every commit passes `npx tsc --noEmit -p .` and `npm run -s lint`.
- Every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
  ```
- Work on branch `feat/calendar-home`. Never push to `main` from a task, and never force-push. Task 10 (the controller) lands the plan.
- **The switch ships `OFF`.** On deploy, the range route answers 404 `not_enabled` to everyone and nothing user-visible changes. The one live change is the stamp hook (Task 7's "Say in the PR"). `scripts/smoke-native-provider-reminders.ts` and `scripts/smoke-reminders.ts` must pass unchanged. No summary path changes here: that is Plan C.
- **Cross-bundle state:** Next 16 compiles `instrumentation.ts` (the scheduler and cron handlers) and the route handlers into separate module instances. In-process state that both sides touch lives on `globalThis` (`__calendarHomeRollout`, `__gcalInflight`, `__gcalWritten`), the way `src/utils/prisma.ts` keeps `global.prisma`.
- **Client-safe types:** `src/lib/calendar-view/types.ts` imports nothing. Client code (Plans D and E) imports `WeekStart` and every DTO type only from there, never from `locale-rules.ts`, which pulls in the zone table.
- **Never serialize the user row** (it carries the Google token and the phone number). Error and warning contexts carry `{ user_id }` only, never event titles.
- Never refactor Telegram flows to swap `user.id` and `telegramId`. Don't change the TTS remote/local pattern or the Gemini thinking level.
- **Fixed values** (spec §1, §2, §4):
  - switch: enum `CalendarHomeRollout { OFF ADMINS ALL }`, default `OFF`; memo 30 s on `globalThis`; Redis `chome:rollout` with `EX 60`;
  - limiter: `calendarRateLimiter`, 60 per minute, prefix `ratelimit:calendar`;
  - route: window `[today, today+7)` by default, at most 42 days (compared as date strings), years within ±5 of today; `deadlineMs: 6000`; timezone wait 2,000 ms; `Cache-Control: private, no-store`;
  - Google: `maxResults: 2500`, `maxAttendees: 1`, a cap of 5,000 items per calendar;
  - Google cache: key `gcal:range:v1:{userId}:{setHash}:{tz}:{from}:{to}`, fresh under 3 min, stale from 3 to 30 min, `EX 1800`; `fresh=1` at most once per 30 s per user and window (`SET NX EX 30`); stamp `gcal:stamp:{userId}` with `EX 3600`;
  - `stampGoogleCache`: a separate Upstash client with retries off, raced against 750 ms, never throws;
  - `htmlToText(s, 500)`: a 500 code-point cut.

## Review Focus

1. **A plain-text Teams, Outlook or Zoom invite** (`Click here to join the meeting<https://teams.microsoft.com/…>`, `Organizer: Dana Levi <dana@corp.com>`, `<b.levi@corp.com>`, `Use the <Back> door`) comes back from `htmlToText` unchanged. Only real element names count as tags (`TAG_NAMES`, with `<html-blob>` and `<o:p>`), and `&lt;https://x.y&gt;` in HTML decodes to `<https://x.y>`. Pinned by Task 4, `smoke-google-map`, check "htmlToText: <…> around a link, an address or a word is text, not a tag (Teams, Outlook and Zoom invites)". It fails on the old `htmlToText` (40/41).
2. **One Google invite on two chosen calendars** (both parents invited, one calendar labelled spouse, same event id).
   - It is two items: `google|<own>|evt1` (mine) and `google|<spouse>|evt1` (not mine, with ownerName on that copy only).
   - On a cache hit both are rejoined by `event.calendarId`, and both are listed on the day in `compareItems` order.
   - A decline on the spouse's copy drops only that copy (R2).
   - Pinned by two checks:
     - Task 6, `smoke-calendar-read-google`: "one invite on two chosen calendars: an item per calendar, each with its own calendar, both on the day; a decline drops only that copy".
     - Task 7, `smoke-calendar-read-google-cache`: "one invite on two chosen calendars: both copies, each with its own calendar, also from a hit".
3. **"Move just this one" on a daily reminder.** The fixture: today's 08:00 Vitamins is moved to 10:30 tomorrow, and the done row is keyed by today's 08:00.
   - It reads as one item on tomorrow with `event.start` 10:30, `originalStart` today 08:00, key `famcal|rem-vitamins#<today 08:00>` and `doneAt` set.
   - Through `toRangeDays` it is listed on tomorrow, not today, beside tomorrow's own 08:00.
   - Pinned by Task 5, `smoke-calendar-read-famcal`: "readFamcal: today's Vitamins moved to 10:30 tomorrow ("just this one") is read on tomorrow, keyed and stated by today's 08:00 slot".
4. **A browser or WhatsApp user on the `famcal_session` cookie** (cookie for DB id N, `user_id=N`, no init-data header) gets 200 with their days, `Cache-Control: private, no-store` and the limiter keyed `u<N>`. The same cookie with another user's id gets 401, also with that user's init data in the query. Pinned by Task 8, `smoke-calendar-range` #23.
5. **A slow timezone lookup on the range route** no longer holds the answer. The case: no `tz:user` entry and Nominatim not answering, so the resolver alone takes about 48 s; or a stuck Google token endpoint.
   - After 2,000 ms the route answers in the fallback zone (Asia/Jerusalem) with `tzKnown` false. The language rule then applies: a Russian user gets Monday and no Hebrew dates.
   - It caches no zone and logs `calendar-range-timezone`.
   - A quick lookup is used as before.
   - Pinned by Task 8, `smoke-calendar-range` #24. It fails on the old route (no answer within 4 s).

## Planning Rulings

Decided while drafting and integrating. The spec is updated to match. Executors treat these as binding.

1. **The pure smoke is split by module.** Spec §10's pure checks are `smoke-locale-rules` (Task 2), `smoke-calendar-dto` (Task 3) and `smoke-google-map` (Task 4). The plan also adds `smoke-calendar-read-famcal` (Task 5) and `smoke-calendar-read-google-cache` (Task 7). *Why:* each task owns its test file and lands on its own. *If wrong:* five file names to merge later.
2. **`htmlToText` treats only real element names as tags** (Task 4; spec §2.5 item 8). *Why:* plain-text Teams, Outlook and Zoom invites put links and addresses in angle brackets, and an `<any letter…>` rule strips them. Plan C's parity smoke normalizes descriptions with this function. *If wrong:* a rare HTML tag outside `TAG_NAMES` shows as text.
3. **Only cached reads stamp; `'bypass'` never touches Redis** (Task 7; spec §2.6). *Why:* the summaries never read or write the cache (A-30). *If wrong:* a dead token a summary finds reaches the home up to 3 minutes later.
4. **The range route bounds the timezone wait at 2,000 ms.** Past that it uses `TIMEZONE` with `tzKnown` false (Task 8; spec §4 step 3, §11). *Why:* on a cache miss the resolver can take about 48 s, and a stuck Google token step has no timeout. *If wrong:* the one open after a slow lookup uses the language's week rules. The owner may veto this or change the bound.
5. **The admin control resends the choice it already shows** (Task 1; spec §1). *Why:* during a DB blip the GET shows `OFF`, and rollback must still be one tap. The fix is on the control, not the GET, because §1 has a missing value read as `OFF`. *If wrong:* a redundant save.
6. **One `WeekStart` type.** It is defined in the client-safe `calendar-view/types.ts`, and `locale-rules.ts` re-exports it (Task 3; spec §6). *Why:* a type import from `locale-rules.ts` must never pull the zone table into a client bundle. *If wrong:* none.
7. **Task 4's small readings of §2.5** (its "Spec notes"): plain text means no tag and no known entity; a `mailto:` or `tel:` link whose text is the address gives just the address; `&nbsp;` becomes a space; `keepGoogleEvent` treats a start with neither `date` nor `dateTime` as no start; `classifyGoogleError` reads the status from `response.status`, then `status`, then a numeric `code`.
8. **Plan A follow-ups come here** (Task 9). The recurrence cache gets a 5,000-entry bound, and `smoke-week-lookahead` gets the network-error and native failure checks that Plan A's review deferred.
9. **No PR.** The plan lands by fast-forward (Task 10). The "Say in the PR" blocks in Tasks 7 and 8 go into the landing report to the owner instead.

## File Structure

| File | Task | Change |
|---|---|---|
| `prisma/schema.prisma`, `prisma/migrations/20261016000000_calendar_home_rollout/migration.sql` (new) | 1 | `AdminSettings.calendarHomeRollout` and its enum |
| `src/config/redis-keys.ts` | 1, 6 | `CALENDAR_HOME_ROLLOUT`; the Google cache keys |
| `src/services/calendar-read/rollout.ts` (new) | 1 | The switch: memo, Redis, DB; `isCalendarHomeOn` |
| `app/api/admin/settings/route.ts`, `app/[locale]/admin-panel/AdminPanelClient.tsx`, `messages/{en,he,ru}.json` | 1 | The admin control and its six `admin.features` strings |
| `src/utils/locale-rules.ts` (new), `src/config/week-start-zones.ts` (new) | 2 (3) | Week start, Hebrew dates, week boundaries; the zone table |
| `src/lib/calendar-view/types.ts` (new) | 3 | The client-safe DTO, `DayKey`, `WeekStart`, `compareItems` |
| `src/services/calendar-read/types.ts` (new), `dto.ts` (new) | 3 | Reader types; `toRangeDays` and the DTO mappers |
| `src/services/native-reminders/due.ts`, `open-reminders.ts` | 3, 5 | `reminderDueAt` moves to `due.ts`; `OpenReminderItem` and `fetchOpenReminderItems` |
| `src/utils/html.ts` | 4 | `htmlToText` |
| `src/services/calendar-read/google-map.ts` (new) | 4 | `classifyGoogleError`, `keepGoogleEvent`, `mapGoogleEvent` |
| `src/services/calendar-provider/native-provider.ts` | 5 | `ViewerItem`, `toViewerItems`, `fetchViewerItems` |
| `src/services/calendar-read/famcal.ts` (new) | 5 | The FamCal half |
| `src/services/calendar.ts` | 6 | `getGoogleAuth` split out of `getCalendarClient` |
| `src/services/calendar-read/google.ts` (new) | 6, 7 | The Google half; then its cache and `stampGoogleCache` |
| `src/services/calendar-provider/google-provider.ts`, `src/services/google-connect.ts` | 7 | The stamp after every Google write and after a reconnect |
| `src/services/calendar-read/index.ts` (new), `app/api/calendar/range/route.ts` (new) | 8 | `readRange`; the route |
| `src/lib/rate-limit.ts`, `app/api/execute-command/route.ts` | 8 | `calendarRateLimiter`; the init-data header |
| `src/services/recurrence-cache.ts` | 9 | The 5,000-entry bound |
| `scripts/smoke-calendar-home-rollout.ts` (new), `smoke-admin-panel-ssr.ts` | 1 | Switch and control checks |
| `scripts/smoke-locale-rules.ts`, `smoke-calendar-dto.ts`, `smoke-google-map.ts`, `smoke-calendar-read-famcal.ts`, `smoke-calendar-read-google.ts`, `smoke-calendar-read-google-cache.ts`, `smoke-calendar-range.ts` (all new) | 2–8 | One per module |
| `scripts/smoke-initdata-header.ts` | 8 | The range route and `execute-command` cases |
| `scripts/smoke-week-lookahead.ts` | 9 | Cache bound and failure-path checks |

Tasks run in order 1 → 10. Each later task consumes the modules of earlier ones (each task's **Interfaces** block names them), and every task's line numbers assume the tasks before it have landed. Inside the tasks, cross-references use the draft names: B*N* is Task *N* (B1 is Task 1, …, B9 is Task 9).

---

### Task 1 (B1): Rollout switch

**What:** the admins-first switch the whole feature sits behind (spec §1). There is a new Prisma enum `CalendarHomeRollout { OFF ADMINS ALL }` and an `AdminSettings.calendarHomeRollout` column with default `OFF`, added by a hand-written idempotent migration. `src/services/calendar-read/rollout.ts` reads the switch through a 30 s memo on `globalThis`, then Redis `chome:rollout` (EX 60), then the DB. It answers `isCalendarHomeOn(user)` and saves the switch. The admin settings route reads and writes it. The admin panel gets a three-way Off / Admins / Everyone control next to the built-in reminders switch, with natural en/he/ru labels under `admin.features`.

**Why:** every later Plan B, C, D and E call site asks `await isCalendarHomeOn(user)`, and the owner must be able to turn it back without a redeploy (Owner decision 6). It ships `OFF`, so nothing a user sees changes: no call site reads it yet, and the admin control is admin-only.

**Interface change:** none against the split. Additions the later tasks may use:
- `rollout.ts` also exports `isCalendarHomeRolloutValue(value: unknown): value is CalendarHomeRolloutValue`. The route uses it for its 400.
- The POST answer always carries `propagated` when the rollout was sent: `true` when Redis took the value, `false` when it didn't. The split names only the `false` case.
- On a Redis miss, the read-through populate writes `SET chome:rollout <v> EX 60 NX`, so a reader can't overwrite a value a concurrent `setCalendarHomeRollout` just wrote. A Redis value that isn't one of the three is overwritten without `NX`. Spec §1 says only "writes EX 60"; this tightens it.
- A read that fails in both stores answers `OFF` and is **not** memoized, so the switch comes back as soon as a store answers.
- The control sends the choice it already shows, too: a tap on the selected button saves it again. The GET reads a failed settings query as no row (`.catch(() => null)`, kept as it is), so during a DB blip the panel shows `OFF` whatever the switch is, and the rollback tap on `OFF` must still go out. Saving the same value again is harmless (a DB upsert, then a Redis `SET`).

**Files:**
- Modify: `prisma/schema.prisma:125-138`, the `AdminSettings` model. The new enum goes right after it.
- Create: `prisma/migrations/20261016000000_calendar_home_rollout/migration.sql`
- Modify: `src/config/redis-keys.ts`, inserted after `:103` (`NATIVE_REMINDERS_ENABLED`)
- Create: `src/services/calendar-read/rollout.ts`
- Modify: `app/api/admin/settings/route.ts:1-152` (whole file replaced; the toggle block moves inside `if (hasToggle)`, unchanged)
- Modify: `app/[locale]/admin-panel/AdminPanelClient.tsx` at `:6` (import), `:28` (props), before `:147` (choices), `:181` (loader mapping), before `:190` (save helper and control), `:310` (props destructure), after `:321` (state), after `:505` (handler), after `:2340` (the row)
- Modify: `messages/en.json`, `messages/he.json`, `messages/ru.json`, six keys inserted after `:101` (`admin.features.nativeRemindersDescription`)
- Test (create): `scripts/smoke-calendar-home-rollout.ts`
- Test (modify): `scripts/smoke-admin-panel-ssr.ts` at `:15-17` (header), `:186-188` and `:201` (fake DB), `:215-219` (fake Redis), `:344` (seed reset), `:354-358` (fixture `'ADMINS'`), `:416-444` (client shim), after `:532` (checks #7–#10)

**Interfaces:**
- Consumes: `redis` (`src/utils/redis.ts`), `prisma` (`src/utils/prisma.ts`), `REDIS_KEYS` (`src/config/redis-keys.ts`), `captureError(error, context, extra?, severity?)` (`src/lib/error-capture.ts:21`), and `verifyAdminAccess(initData)` (`src/lib/admin-auth.ts`), which is unchanged.
- Produces (`src/services/calendar-read/rollout.ts`):
  ```ts
  export type CalendarHomeRolloutValue = 'OFF' | 'ADMINS' | 'ALL';
  export function isCalendarHomeRolloutValue(value: unknown): value is CalendarHomeRolloutValue;
  export function getCalendarHomeRollout(): Promise<CalendarHomeRolloutValue>;
  export function isCalendarHomeOn(user: { isAdmin?: boolean | null }): Promise<boolean>;   // UserConfig and the Prisma User row both fit
  export function setCalendarHomeRollout(value: CalendarHomeRolloutValue): Promise<boolean>; // true = Redis took it; rejects when the DB write fails
  ```
- Produces: `REDIS_KEYS.CALENDAR_HOME_ROLLOUT = 'chome:rollout'`; memo key `globalThis.__calendarHomeRolloutMemo: { value, at } | null`.
- Produces (route): GET adds `calendarHomeRollout: 'OFF' | 'ADMINS' | 'ALL'` (`'OFF'` with no row). POST accepts `calendarHomeRollout`:
  - any other value sent → 400 `{ error: 'calendarHomeRollout must be OFF, ADMINS or ALL' }`, after auth;
  - saved → 200 `{ success: true, calendarHomeRollout, propagated: boolean }`, plus today's five toggle fields when a toggle was sent too;
  - the DB write failed → 503, as today.
- Produces (`AdminPanelClient.tsx`):
  ```ts
  export interface RolloutSaveResult { value: CalendarHomeRolloutValue; delayed: boolean }
  export function saveCalendarHomeRollout(previous: CalendarHomeRolloutValue, next: CalendarHomeRolloutValue): Promise<RolloutSaveResult>;
  export function CalendarHomeRolloutControl(props: { value: CalendarHomeRolloutValue; saving: boolean; delayed: boolean; onChange: (next: CalendarHomeRolloutValue) => void }): React.JSX.Element;
  ```
  `AdminPanelInitial` and `AdminPanelProps` gain `calendarHomeRollout: CalendarHomeRolloutValue`.
- Produces (copy): `admin.features.calendarHome`, `calendarHomeDescription`, `calendarHomeOff`, `calendarHomeAdmins`, `calendarHomeAll`, `calendarHomeDelayed` in en/he/ru.

All smoke commands below use this fake environment (never `.env`):
```bash
E="DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake"
```

- [ ] **Step 1: Write the failing smoke `scripts/smoke-calendar-home-rollout.ts`**

Create the file with exactly this content:

```ts
// Smoke test for the calendar home's rollout switch (calendar-home spec §1).
// AdminSettings.calendarHomeRollout is OFF, ADMINS or ALL. getCalendarHomeRollout reads a
// 30 s memo on globalThis (shared by the scheduler's and the routes' bundles), then Redis
// chome:rollout, then the DB, and answers OFF for anything else. isCalendarHomeOn lets
// admins in under ADMINS and everyone under ALL. setCalendarHomeRollout writes the DB,
// then Redis with EX 60, deletes the key when that SET fails, clears the memo, and says
// whether Redis took the value. The admin settings route accepts only the three values,
// answers propagated: false when Redis missed, and 503 when the DB write failed. Also: the
// schema, the hand-written migration, the Redis key and the admin copy.
//
// Redis, Prisma, error capture, the admin check and the other toggles' setters are faked;
// Date.now is moved by hand. No network, no DB.
//
// Run with the fake env from the task brief:
//   npx tsx scripts/smoke-calendar-home-rollout.ts

import Module from 'node:module';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

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

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

// ---- Environment: fakes only, set before anything under test loads ----

process.env.UPSTASH_REDIS_REST_URL = 'https://redis.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';

const networkAttempts: string[] = [];
globalThis.fetch = (async (input: unknown) => {
  networkAttempts.push(String(input));
  throw new Error('network is blocked in this smoke test');
}) as typeof fetch;

/** The clock every memo check reads. */
let clock = Date.parse('2026-10-16T09:00:00Z');
Date.now = () => clock;

// ---- Fakes ----

/** Every Redis and DB call, in order. */
const log: string[] = [];

/** Upstash as it behaves: strings go in as they are, a read JSON-parses what it can. */
const store = new Map<string, string>();
const ttls = new Map<string, number>();
const redisState = { getDown: false, setDown: false, delDown: false };
const fakeRedis = {
  get: async (key: string) => {
    log.push(`redis get ${key}`);
    if (redisState.getDown) throw new Error('redis read failed');
    const raw = store.get(key);
    if (raw === undefined) return null;
    try { return JSON.parse(raw); } catch { return raw; }
  },
  set: async (key: string, value: unknown, opts?: { ex?: number; nx?: boolean }) => {
    log.push(`redis set ${key}=${String(value)}${opts?.ex ? ` ex${opts.ex}` : ''}${opts?.nx ? ' nx' : ''}`);
    if (redisState.setDown) throw new Error('redis write failed');
    if (opts?.nx && store.has(key)) return null;
    store.set(key, typeof value === 'string' ? value : JSON.stringify(value));
    if (opts?.ex) ttls.set(key, opts.ex); else ttls.delete(key);
    return 'OK';
  },
  del: async (key: string) => {
    log.push(`redis del ${key}`);
    if (redisState.delDown) throw new Error('redis del failed');
    ttls.delete(key);
    return store.delete(key) ? 1 : 0;
  },
};

/** The AdminSettings singleton. Prisma returns only the selected columns and fills column defaults on create. */
const COLUMN_DEFAULTS = {
  remindersEnabled: false, earlyAdoptionMode: true, voiceAutoCreateHighConf: false,
  voiceTtsOutcome: false, nativeRemindersEnabled: true, calendarHomeRollout: 'OFF',
};
const db = { row: null as Record<string, unknown> | null, down: false };
const fakePrisma = {
  adminSettings: {
    findUnique: async ({ select }: { where: { id: string }; select?: Record<string, boolean> }) => {
      log.push('db find');
      if (db.down) throw new Error('db is down');
      if (!db.row) return null;
      const row = db.row;
      return select ? Object.fromEntries(Object.keys(select).map(k => [k, row[k]])) : { ...row };
    },
    upsert: async ({ where, update, create }: { where: { id: string }; update: Record<string, unknown>; create: Record<string, unknown> }) => {
      log.push(`db upsert ${JSON.stringify(db.row ? update : create)}`);
      if (db.down) throw new Error('db is down');
      assert(where.id === 'global', `upsert where ${JSON.stringify(where)}`);
      db.row = db.row ? { ...db.row, ...update } : { ...COLUMN_DEFAULTS, ...create };
      return { ...db.row };
    },
  },
};

const captured: string[] = [];
const fakeErrorCapture = {
  captureError: (_e: unknown, context: string, _extra?: unknown, severity = 'error') => { captured.push(`${context}:${severity}`); },
  captureWarning: (_m: string, context: string) => { captured.push(`${context}:warning`); },
  captureInfo: () => {},
};

/** The admin check: initData 'admin' is an admin, 'user' a signed-in non-admin, anything else refused. */
const fakeAdminAuth = {
  verifyAdminAccess: async (initData: string | undefined) =>
    initData === 'admin' ? { authorized: true, adminId: 1 }
      : initData === 'user' ? { authorized: false, error: 'Admin access required' }
        : { authorized: false, error: 'Unauthorized' },
};

/** The other toggles' Redis setters: recorded, so a rollout POST can show it touched none of them. */
const toggleCalls: string[] = [];
const recordToggle = (name: string) => async (value: boolean) => { toggleCalls.push(`${name}=${value}`); };

const SRC = path.resolve(__dirname, '../src');
const ROOT = path.resolve(__dirname, '..');
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
stub('lib/error-capture.ts', fakeErrorCapture);
stub('lib/admin-auth.ts', fakeAdminAuth);
stub('services/reminder-cache.ts', {
  setGlobalRemindersEnabled: recordToggle('remindersEnabled'),
  setEarlyAdoptionMode: recordToggle('earlyAdoptionMode'),
  setVoiceAutoCreateHighConf: recordToggle('voiceAutoCreateHighConf'),
  setVoiceTtsOutcome: recordToggle('voiceTtsOutcome'),
});
stub('services/subscription-service.ts', { invalidateAllFeatureAccessCaches: async () => { toggleCalls.push('invalidateAllFeatureAccessCaches'); } });
stub('services/native-reminders/support.ts', { setNativeRemindersEnabled: recordToggle('nativeRemindersEnabled') });

const KEY = 'chome:rollout';
const MEMO = '__calendarHomeRolloutMemo';
const g = globalThis as unknown as Record<string, unknown>;

function reset() {
  store.clear();
  ttls.clear();
  log.length = 0;
  captured.length = 0;
  toggleCalls.length = 0;
  Object.assign(redisState, { getDown: false, setDown: false, delDown: false });
  Object.assign(db, { row: null, down: false });
  delete g[MEMO];
  clock = Date.parse('2026-10-16T09:00:00Z');
}

const reads = (prefix: string) => log.filter(l => l.startsWith(prefix)).length;

type RolloutModule = typeof import('../src/services/calendar-read/rollout');
const ROLLOUT_FILE = path.join(SRC, 'services/calendar-read/rollout.ts');

async function main() {
  const rollout: RolloutModule = await import('../src/services/calendar-read/rollout');
  const { getCalendarHomeRollout, isCalendarHomeOn, setCalendarHomeRollout, isCalendarHomeRolloutValue } = rollout;
  const { GET, POST } = await import('../app/api/admin/settings/route');
  const { NextRequest } = await import('next/server');
  const { REDIS_KEYS } = await import('../src/config/redis-keys');

  // The code under test logs its Redis and DB failures; keep the output to the results.
  const quiet = { log: console.log, error: console.error, warn: console.warn };
  Object.assign(console, { log: () => {}, error: () => {}, warn: () => {} });

  const post = (body: Record<string, unknown>) =>
    POST(new NextRequest('http://localhost/api/admin/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }));
  const get = () => GET(new NextRequest('http://localhost/api/admin/settings', { headers: { 'x-telegram-init-data': 'admin' } }));

  // ---- getCalendarHomeRollout: memo, Redis, DB, OFF ----

  await check('no settings row and nothing in Redis: OFF, and Redis now holds OFF for 60 s (only if still absent)', async () => {
    reset();
    assert((await getCalendarHomeRollout()) === 'OFF', 'not OFF');
    assert(store.get(KEY) === 'OFF' && ttls.get(KEY) === 60, `redis holds ${store.get(KEY)} ex ${ttls.get(KEY)}`);
    assert(log.includes(`redis set ${KEY}=OFF ex60 nx`), `log ${log.join(' | ')}`);
  });

  await check('the row says ADMINS: ADMINS, cached in Redis, and a second read within 30 s touches neither store', async () => {
    reset();
    db.row = { ...COLUMN_DEFAULTS, calendarHomeRollout: 'ADMINS' };
    assert((await getCalendarHomeRollout()) === 'ADMINS', 'first read');
    assert(store.get(KEY) === 'ADMINS', `redis holds ${store.get(KEY)}`);
    const before = log.length;
    clock += 29_999;
    assert((await getCalendarHomeRollout()) === 'ADMINS', 'second read');
    assert(log.length === before, `second read: ${log.slice(before).join(' | ')}`);
  });

  await check('Redis says ALL: ALL, with no DB read', async () => {
    reset();
    store.set(KEY, 'ALL');
    db.row = { ...COLUMN_DEFAULTS, calendarHomeRollout: 'OFF' };
    assert((await getCalendarHomeRollout()) === 'ALL', 'not ALL');
    assert(reads('db') === 0, `log ${log.join(' | ')}`);
  });

  await check('the memo lasts 30 s: at 30 s the next read goes back to Redis', async () => {
    reset();
    store.set(KEY, 'ADMINS');
    await getCalendarHomeRollout();
    store.set(KEY, 'ALL');
    clock += 29_999;
    assert((await getCalendarHomeRollout()) === 'ADMINS', 'memo ended early');
    clock += 1;
    assert((await getCalendarHomeRollout()) === 'ALL', 'memo outlived 30 s');
    assert(reads('redis get') === 2, `log ${log.join(' | ')}`);
  });

  await check('a value in Redis that is none of the three: the DB value, written over it', async () => {
    reset();
    for (const junk of ['admins', 'ON', '1']) {
      reset();
      store.set(KEY, junk);
      db.row = { ...COLUMN_DEFAULTS, calendarHomeRollout: 'ADMINS' };
      assert((await getCalendarHomeRollout()) === 'ADMINS', `${junk}: not the DB value`);
      assert(store.get(KEY) === 'ADMINS' && log.includes(`redis set ${KEY}=ADMINS ex60`), `${junk}: ${log.join(' | ')}`);
    }
  });

  await check('Redis read fails: the DB value, no Redis write, and a warning', async () => {
    reset();
    redisState.getDown = true;
    db.row = { ...COLUMN_DEFAULTS, calendarHomeRollout: 'ALL' };
    assert((await getCalendarHomeRollout()) === 'ALL', 'not the DB value');
    assert(reads('redis set') === 0, `log ${log.join(' | ')}`);
    assert(captured.includes('calendar-home-rollout:warning'), `captured ${captured}`);
  });

  await check('Redis and the DB both down: OFF, not remembered, so the next read after recovery sees the DB', async () => {
    reset();
    redisState.getDown = true;
    db.down = true;
    assert((await getCalendarHomeRollout()) === 'OFF', 'not OFF');
    redisState.getDown = false;
    db.down = false;
    db.row = { ...COLUMN_DEFAULTS, calendarHomeRollout: 'ADMINS' };
    assert((await getCalendarHomeRollout()) === 'ADMINS', 'the fallback was remembered');
  });

  await check('the DB holds a value outside the enum, or no column: OFF', async () => {
    for (const value of ['SOME', null, undefined]) {
      reset();
      db.row = { ...COLUMN_DEFAULTS, calendarHomeRollout: value };
      assert((await getCalendarHomeRollout()) === 'OFF', `${value}: not OFF`);
    }
  });

  await check('a failed cache write still returns the DB value', async () => {
    reset();
    redisState.setDown = true;
    db.row = { ...COLUMN_DEFAULTS, calendarHomeRollout: 'ALL' };
    assert((await getCalendarHomeRollout()) === 'ALL', 'not the DB value');
  });

  await check('the memo lives on globalThis: a second copy of the module (another bundle) reads it', async () => {
    reset();
    store.set(KEY, 'ADMINS');
    await getCalendarHomeRollout();
    const cached = ModuleWithCache._cache[ROLLOUT_FILE];
    delete ModuleWithCache._cache[ROLLOUT_FILE];
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const second = require(ROLLOUT_FILE) as RolloutModule;
      assert(second.getCalendarHomeRollout !== getCalendarHomeRollout, 'the module was not loaded again');
      store.set(KEY, 'ALL');
      const before = log.length;
      assert((await second.getCalendarHomeRollout()) === 'ADMINS', 'the second copy has its own memo');
      assert(log.length === before, `second copy: ${log.slice(before).join(' | ')}`);
      // and a set in one copy clears the memo for the other
      db.row = { ...COLUMN_DEFAULTS };
      await second.setCalendarHomeRollout('OFF');
      assert((await getCalendarHomeRollout()) === 'OFF', 'the first copy kept the old memo');
    } finally {
      ModuleWithCache._cache[ROLLOUT_FILE] = cached;
    }
  });

  // ---- isCalendarHomeOn ----

  await check('isCalendarHomeOn: OFF nobody, ADMINS only isAdmin === true, ALL everyone', async () => {
    const users: { isAdmin?: boolean | null }[] = [{ isAdmin: true }, { isAdmin: false }, { isAdmin: null }, {}];
    const want: Record<string, boolean[]> = {
      OFF: [false, false, false, false],
      ADMINS: [true, false, false, false],
      ALL: [true, true, true, true],
    };
    for (const [value, expected] of Object.entries(want)) {
      reset();
      store.set(KEY, value);
      const pending = isCalendarHomeOn(users[0]);
      assert(pending instanceof Promise, 'isCalendarHomeOn does not return a Promise');
      await pending;
      const got = await Promise.all(users.map(u => isCalendarHomeOn(u)));
      assert(JSON.stringify(got) === JSON.stringify(expected), `${value}: ${JSON.stringify(got)}`);
    }
  });

  await check('isCalendarHomeRolloutValue accepts exactly OFF, ADMINS and ALL', () => {
    const yes = ['OFF', 'ADMINS', 'ALL'].every(v => isCalendarHomeRolloutValue(v));
    const no = ['off', 'Admins', 'all', '', 'ON', null, undefined, 1, true, ['ALL'], {}].some(v => isCalendarHomeRolloutValue(v));
    assert(yes && !no, `yes ${yes}, no ${no}`);
  });

  // ---- setCalendarHomeRollout ----

  await check('set: the DB first, then Redis with EX 60, answers true, and this process reads the new value at once', async () => {
    reset();
    db.row = { ...COLUMN_DEFAULTS, calendarHomeRollout: 'ADMINS' };
    assert((await getCalendarHomeRollout()) === 'ADMINS', 'setup');
    log.length = 0;
    assert((await setCalendarHomeRollout('ALL')) === true, 'did not answer true');
    assert(log.join(' | ') === `db upsert {"calendarHomeRollout":"ALL"} | redis set ${KEY}=ALL ex60`, `log ${log.join(' | ')}`);
    assert(db.row?.calendarHomeRollout === 'ALL' && store.get(KEY) === 'ALL' && ttls.get(KEY) === 60, `db ${db.row?.calendarHomeRollout}, redis ${store.get(KEY)}`);
    assert((await getCalendarHomeRollout()) === 'ALL', 'the memo kept ADMINS');
  });

  await check('set on a fresh database creates the row with the value', async () => {
    reset();
    await setCalendarHomeRollout('ADMINS');
    assert(log[0] === 'db upsert {"id":"global","calendarHomeRollout":"ADMINS"}', `log ${log.join(' | ')}`);
    assert(db.row?.calendarHomeRollout === 'ADMINS', `row ${JSON.stringify(db.row)}`);
  });

  await check('set with the Redis SET failing: DEL, answers false, and the next read here comes from the DB', async () => {
    reset();
    db.row = { ...COLUMN_DEFAULTS, calendarHomeRollout: 'OFF' };
    store.set(KEY, 'OFF');
    await getCalendarHomeRollout();
    redisState.setDown = true;
    assert((await setCalendarHomeRollout('ADMINS')) === false, 'did not answer false');
    assert(log.includes(`redis del ${KEY}`) && !store.has(KEY), `log ${log.join(' | ')}`);
    assert((await getCalendarHomeRollout()) === 'ADMINS', 'not the DB value');
  });

  await check('set with SET and DEL both failing: answers false and does not throw', async () => {
    reset();
    db.row = { ...COLUMN_DEFAULTS };
    redisState.setDown = true;
    redisState.delDown = true;
    assert((await setCalendarHomeRollout('ALL')) === false, 'did not answer false');
    assert(db.row?.calendarHomeRollout === 'ALL', 'DB not written');
  });

  await check('set with the DB down: rejects, and Redis is not touched', async () => {
    reset();
    db.down = true;
    let threw = false;
    try { await setCalendarHomeRollout('ALL'); } catch { threw = true; }
    assert(threw, 'did not reject');
    assert(reads('redis') === 0, `log ${log.join(' | ')}`);
  });

  await check('set refuses a value outside the three before any write', async () => {
    reset();
    let threw = false;
    try { await setCalendarHomeRollout('EVERYONE' as never); } catch (e) { threw = e instanceof TypeError; }
    assert(threw, 'no TypeError');
    assert(log.length === 0, `log ${log.join(' | ')}`);
  });

  // ---- The admin settings route ----

  await check('GET: OFF with no settings row, the row value otherwise', async () => {
    reset();
    const fresh = await (await get()).json();
    assert(fresh.calendarHomeRollout === 'OFF', `no row: ${JSON.stringify(fresh)}`);
    db.row = { ...COLUMN_DEFAULTS, calendarHomeRollout: 'ALL' };
    const all = await (await get()).json();
    assert(all.calendarHomeRollout === 'ALL', `row ALL: ${JSON.stringify(all)}`);
  });

  await check('POST calendarHomeRollout ADMINS: 200 propagated, the DB and Redis hold it, no other toggle touched', async () => {
    reset();
    db.row = { ...COLUMN_DEFAULTS };
    const res = await post({ calendarHomeRollout: 'ADMINS', initData: 'admin' });
    const body = await res.json();
    assert(res.status === 200, `status ${res.status}: ${JSON.stringify(body)}`);
    assert(JSON.stringify(body) === '{"success":true,"calendarHomeRollout":"ADMINS","propagated":true}', `answered ${JSON.stringify(body)}`);
    assert(log.join(' | ') === `db upsert {"calendarHomeRollout":"ADMINS"} | redis set ${KEY}=ADMINS ex60`, `log ${log.join(' | ')}`);
    assert(toggleCalls.length === 0, `toggles ${toggleCalls}`);
  });

  await check('POST with a value outside the three is a 400 and writes nothing', async () => {
    for (const value of ['admins', 'ON', 'EVERYONE', '', null, true, 1, ['ALL'], {}]) {
      reset();
      db.row = { ...COLUMN_DEFAULTS, calendarHomeRollout: 'ADMINS' };
      const res = await post({ calendarHomeRollout: value, initData: 'admin' });
      assert(res.status === 400, `${JSON.stringify(value)}: status ${res.status}`);
      assert(log.length === 0, `${JSON.stringify(value)}: log ${log.join(' | ')}`);
    }
  });

  await check('POST with a bad value next to a good toggle is still a 400, and the toggle is not saved', async () => {
    reset();
    db.row = { ...COLUMN_DEFAULTS };
    const res = await post({ calendarHomeRollout: 'all', voiceTtsOutcome: true, initData: 'admin' });
    assert(res.status === 400, `status ${res.status}`);
    assert(log.length === 0 && toggleCalls.length === 0, `log ${log.join(' | ')}, toggles ${toggleCalls}`);
  });

  await check('POST when Redis does not take it: 200 with propagated false, the DB holds the new value', async () => {
    reset();
    db.row = { ...COLUMN_DEFAULTS, calendarHomeRollout: 'ADMINS' };
    redisState.setDown = true;
    const res = await post({ calendarHomeRollout: 'OFF', initData: 'admin' });
    const body = await res.json();
    assert(res.status === 200, `status ${res.status}`);
    assert(JSON.stringify(body) === '{"success":true,"calendarHomeRollout":"OFF","propagated":false}', `answered ${JSON.stringify(body)}`);
    assert(db.row?.calendarHomeRollout === 'OFF', `row ${JSON.stringify(db.row)}`);
  });

  await check('POST with the DB down: 503, and nothing reaches Redis', async () => {
    reset();
    db.down = true;
    const res = await post({ calendarHomeRollout: 'ALL', initData: 'admin' });
    assert(res.status === 503, `status ${res.status}`);
    assert(reads('redis') === 0, `log ${log.join(' | ')}`);
  });

  await check('POST from a non-admin or with no initData is refused before validation and writes nothing', async () => {
    reset();
    const user = await post({ calendarHomeRollout: 'ALL', initData: 'user' });
    const bad = await post({ calendarHomeRollout: 'nonsense', initData: 'user' });
    const none = await post({ calendarHomeRollout: 'ALL' });
    assert(user.status === 403 && bad.status === 403 && none.status === 401, `user ${user.status}, bad ${bad.status}, none ${none.status}`);
    assert(log.length === 0, `log ${log.join(' | ')}`);
  });

  await check('POST of another toggle answers as before and leaves the rollout alone', async () => {
    reset();
    db.row = { ...COLUMN_DEFAULTS, calendarHomeRollout: 'ADMINS' };
    const res = await post({ voiceTtsOutcome: true, initData: 'admin' });
    const body = await res.json();
    assert(res.status === 200, `status ${res.status}`);
    assert(JSON.stringify(Object.keys(body)) === '["success","remindersEnabled","earlyAdoptionMode","voiceAutoCreateHighConf","voiceTtsOutcome","nativeRemindersEnabled"]', `keys ${Object.keys(body)}`);
    assert(reads(`redis set ${KEY}`) === 0 && db.row?.calendarHomeRollout === 'ADMINS', `log ${log.join(' | ')}`);
  });

  await check('POST of a toggle and the rollout together saves both', async () => {
    reset();
    db.row = { ...COLUMN_DEFAULTS };
    const res = await post({ voiceTtsOutcome: true, calendarHomeRollout: 'ALL', initData: 'admin' });
    const body = await res.json();
    assert(res.status === 200 && body.voiceTtsOutcome === true && body.calendarHomeRollout === 'ALL' && body.propagated === true, `answered ${res.status} ${JSON.stringify(body)}`);
    assert(db.row?.voiceTtsOutcome === true && db.row?.calendarHomeRollout === 'ALL', `row ${JSON.stringify(db.row)}`);
  });

  await check('POST with no field at all is still a 400', async () => {
    reset();
    const res = await post({ initData: 'admin' });
    assert(res.status === 400, `status ${res.status}`);
  });

  // ---- Schema, migration, key, copy ----

  await check('schema: enum CalendarHomeRollout { OFF ADMINS ALL } and AdminSettings.calendarHomeRollout defaulting to OFF', () => {
    const schema = readFileSync(path.join(ROOT, 'prisma/schema.prisma'), 'utf8');
    const enumBody = schema.match(/enum CalendarHomeRollout \{([^}]*)\}/)?.[1] ?? '';
    const values = enumBody.split('\n').map(l => l.replace(/\/\/.*/, '').trim()).filter(Boolean);
    assert(JSON.stringify(values) === '["OFF","ADMINS","ALL"]', `enum values ${JSON.stringify(values)}`);
    const model = schema.match(/model AdminSettings \{([^}]*)\}/)?.[1] ?? '';
    assert(/^\s*calendarHomeRollout\s+CalendarHomeRollout\s+@default\(OFF\)/m.test(model), 'AdminSettings has no calendarHomeRollout defaulting to OFF');
  });

  await check('migration 20261016000000_calendar_home_rollout: the type and the column, both guarded for a re-run', () => {
    const file = path.join(ROOT, 'prisma/migrations/20261016000000_calendar_home_rollout/migration.sql');
    assert(existsSync(file), 'no migration file');
    const sql = readFileSync(file, 'utf8');
    assert(/DO \$\$ BEGIN\s+CREATE TYPE "CalendarHomeRollout" AS ENUM \('OFF', 'ADMINS', 'ALL'\);\s+EXCEPTION WHEN duplicate_object THEN null;\s+END \$\$;/.test(sql), 'the CREATE TYPE is not guarded');
    assert(/ALTER TABLE "AdminSettings" ADD COLUMN IF NOT EXISTS "calendarHomeRollout" "CalendarHomeRollout" NOT NULL DEFAULT 'OFF';/.test(sql), 'the ADD COLUMN is missing or unguarded');
  });

  await check('the Redis key is chome:rollout, outside the event-alert prefixes', () => {
    assert(REDIS_KEYS.CALENDAR_HOME_ROLLOUT === 'chome:rollout', REDIS_KEYS.CALENDAR_HOME_ROLLOUT);
  });

  await check('the rollout control copy is in admin.features in en, he and ru, translated', () => {
    const keys = ['calendarHome', 'calendarHomeDescription', 'calendarHomeOff', 'calendarHomeAdmins', 'calendarHomeAll', 'calendarHomeDelayed'];
    const problems: string[] = [];
    const read = (locale: string) => JSON.parse(readFileSync(path.join(ROOT, 'messages', `${locale}.json`), 'utf8')).admin?.features ?? {};
    const en = read('en');
    for (const locale of ['en', 'he', 'ru']) {
      const features = read(locale);
      for (const key of keys) {
        const text = features[key];
        if (typeof text !== 'string' || !text.trim()) problems.push(`${locale}: missing ${key}`);
        else if (locale !== 'en' && text === en[key]) problems.push(`${locale}: ${key} is the English text`);
      }
    }
    assert(problems.length === 0, problems.join(', '));
  });

  await check('nothing reached the network', () => {
    assert(networkAttempts.length === 0, `network ${networkAttempts}`);
  });

  Object.assign(console, quiet);
  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Extend `scripts/smoke-admin-panel-ssr.ts` with the rollout control**

Eight exact edits.

(a) Header, `:15-17`. Before:
```ts
// Every check fails until the fix lands, #3 too: the old GET /api/admin/settings read
// initData only from the query, so the header got 401.
//
```
After:
```ts
// Every check fails until the fix lands, #3 too: the old GET /api/admin/settings read
// initData only from the query, so the header got 401.
//
// #7-#10 cover the calendar home's rollout control (calendar-home spec §1): the loader's
// mapping, saves through the real POST route (a bad value refused, a propagated: false
// answer that still shows the new value with its note, a failed save keeping the old one),
// and a tap on the shown choice, which still sends it (OFF after a failed settings read).
//
```

(b) Fake DB state, `:186-188`. Before:
```ts
/** Every Prisma call, as model.method. `dbDown` makes every call fail, as an outage does. */
const prismaCalls: string[] = [];
const dbState = { down: false };
```
After:
```ts
/** Every Prisma call, as model.method. `down` makes every call fail, as an outage does; `failing` only one model's. */
const prismaCalls: string[] = [];
const dbState = { down: false, failing: '' };
```

(c) `:201`. Before:
```ts
        if (dbState.down) return Promise.reject(new Error('database is down'));
```
After:
```ts
        if (dbState.down || dbState.failing === prop) return Promise.reject(new Error('database is down'));
```

(d) Fake Redis, `:215-219`. Before:
```ts
const encode = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));
const redisImpl: Row = {
  get: async (k: string) => decode(redisStore.get(k)),
  set: async (k: string, v: unknown, o?: Row) => {
    if (o?.nx && redisStore.has(k)) return null;
```
After:
```ts
const encode = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));
/** `failSet` makes every SET throw, as a Redis blip during a save does. */
const redisState = { failSet: false };
const redisImpl: Row = {
  get: async (k: string) => decode(redisStore.get(k)),
  set: async (k: string, v: unknown, o?: Row) => {
    if (redisState.failSet) throw new Error('redis write failed');
    if (o?.nx && redisStore.has(k)) return null;
```

(e) `seed()`, `:344-345`. Before:
```ts
  dbState.down = false;
  DB.user = [
```
After:
```ts
  dbState.down = false;
  dbState.failing = '';
  redisState.failSet = false;
  DB.user = [
```

(f) Fixture, `:354-358`. The rollout is `'ADMINS'`, so the default `OFF` can't pass for the DB in #3 and #4. Before:
```ts
    voiceTtsOutcome: true, nativeRemindersEnabled: false,
  }];
}

const TOGGLES = { remindersEnabled: true, earlyAdoptionMode: true, voiceAutoCreateHighConf: true, voiceTtsOutcome: true, nativeRemindersEnabled: false };
```
After:
```ts
    voiceTtsOutcome: true, nativeRemindersEnabled: false, calendarHomeRollout: 'ADMINS',
  }];
}

const TOGGLES = { remindersEnabled: true, earlyAdoptionMode: true, voiceAutoCreateHighConf: true, voiceTtsOutcome: true, nativeRemindersEnabled: false, calendarHomeRollout: 'ADMINS' };
const ROLLOUT_KEY = 'chome:rollout';
```

(g) The client shim, `:416-444`. It now serves any method, records each status, and runs any client function. `runLoader` keeps its meaning for #4 and #5. Before:
```ts
  // The client's loader, run against the real routes. Records what each request carried.
  const requests: { url: string; headers: Record<string, string> }[] = [];
  const ROUTES: Record<string, string> = {
    '/api/admin/settings': 'app/api/admin/settings/route.ts',
    '/api/admin/stats': 'app/api/admin/stats/route.ts',
  };
  const runLoader = async (initData: string): Promise<Row> => {
    const g = globalThis as Row;
    const blocked = globalThis.fetch;
    requests.length = 0;
    g.window = { location: { hash: '' }, sessionStorage: { getItem: () => null }, ...(initData ? { Telegram: { WebApp: { initData } } } : {}) };
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      requests.push({ url: url.pathname + url.search, headers });
      const route = ROUTES[url.pathname];
      if (!route) throw new Error(`blocked in smoke: ${url.pathname}`);
      const { GET } = await load(route);
      return GET(new NextRequest(url.href, { headers }));
    }) as typeof fetch;
    try {
      const { loadAdminPanel } = await load('app/[locale]/admin-panel/AdminPanelClient.tsx');
      assert(typeof loadAdminPanel === 'function', 'AdminPanelClient exports no loadAdminPanel');
      return await loadAdminPanel();
    } finally {
      globalThis.fetch = blocked;
      delete g.window;
    }
  };
```
After:
```ts
  // The client's code, run against the real routes. Records what each request carried and its status.
  const requests: { url: string; method: string; headers: Record<string, string>; status?: number }[] = [];
  const ROUTES: Record<string, string> = {
    '/api/admin/settings': 'app/api/admin/settings/route.ts',
    '/api/admin/stats': 'app/api/admin/stats/route.ts',
  };
  const asClient = async <T>(initData: string, fn: (client: Row) => Promise<T>): Promise<T> => {
    const g = globalThis as Row;
    const blocked = globalThis.fetch;
    requests.length = 0;
    g.window = { location: { hash: '' }, sessionStorage: { getItem: () => null }, ...(initData ? { Telegram: { WebApp: { initData } } } : {}) };
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      const method = init?.method ?? 'GET';
      const request: (typeof requests)[number] = { url: url.pathname + url.search, method, headers };
      requests.push(request);
      const route = ROUTES[url.pathname];
      if (!route) throw new Error(`blocked in smoke: ${url.pathname}`);
      const handler = (await load(route))[method];
      if (typeof handler !== 'function') throw new Error(`blocked in smoke: ${method} ${url.pathname}`);
      const res: Response = await handler(new NextRequest(url.href, { method, headers, body: init?.body ?? undefined }));
      request.status = res.status;
      return res;
    }) as typeof fetch;
    try {
      return await fn(await load('app/[locale]/admin-panel/AdminPanelClient.tsx'));
    } finally {
      globalThis.fetch = blocked;
      delete g.window;
    }
  };
  const runLoader = (initData: string): Promise<Row> => asClient(initData, async ({ loadAdminPanel }) => {
    assert(typeof loadAdminPanel === 'function', 'AdminPanelClient exports no loadAdminPanel');
    return loadAdminPanel();
  });
  const saveRollout = (initData: string, previous: string, next: string): Promise<Row> => asClient(initData, async ({ saveCalendarHomeRollout }) => {
    assert(typeof saveCalendarHomeRollout === 'function', 'AdminPanelClient exports no saveCalendarHomeRollout');
    return saveCalendarHomeRollout(previous, next);
  });
  const rolloutCopy = (locale: string): Row =>
    JSON.parse(fs.readFileSync(path.join(ROOT, 'messages', `${locale}.json`), 'utf8')).admin.features;
  /** The status of the request the last client call made (a call, so no narrowing sticks to it). */
  const lastStatus = (): number | undefined => requests[requests.length - 1]?.status;
  /** The labels of the rendered radio buttons that are checked. */
  const checkedLabels = (html: string) =>
    [...html.matchAll(/<button[^>]*aria-checked="true"[^>]*>([^<]*)<\/button>/g)].map(m => m[1]);
```

(h) Checks #7–#10, after #6. Before (`:531-532`):
```ts
    assert(html.includes('>Unauthorized</h1>') && html.includes('This area is restricted to administrators only.'), html);
  });
```
After:
```ts
    assert(html.includes('>Unauthorized</h1>') && html.includes('This area is restricted to administrators only.'), html);
  });

  await check('#7 the loader maps the rollout: the DB\'s value, and OFF when the settings carry none', async () => {
    seed();
    (DB.adminSettings[0] as Row).calendarHomeRollout = 'ALL';
    const all = await runLoader(initDataFor(ADMIN_TG));
    seed();
    delete (DB.adminSettings[0] as Row).calendarHomeRollout;
    const none = await runLoader(initDataFor(ADMIN_TG));
    assert(all.initial?.calendarHomeRollout === 'ALL', `ALL row: ${show(all)}`);
    assert(none.initial?.calendarHomeRollout === 'OFF', `no value: ${show(none)}`);
  });

  await check('#8 the rollout control saves through the real route: ADMINS to ALL shows ALL; a bad value or a non-admin is refused and the old value stays', async () => {
    seed();
    const admin = initDataFor(ADMIN_TG);
    const saved = await saveRollout(admin, 'ADMINS', 'ALL');
    const sent = requests[requests.length - 1];
    assert(show(saved) === show({ value: 'ALL', delayed: false }), `saved ${show(saved)} ${captured.join(' | ')}`);
    assert(sent?.method === 'POST' && sent.status === 200 && !/initData/i.test(sent.url), `request ${show(sent)}`);
    assert(DB.adminSettings[0].calendarHomeRollout === 'ALL' && redisStore.get(ROLLOUT_KEY) === 'ALL',
      `DB ${DB.adminSettings[0].calendarHomeRollout}, Redis ${redisStore.get(ROLLOUT_KEY)}`);
    const bad = await saveRollout(admin, 'ALL', 'EVERYONE');
    assert(lastStatus() === 400, `bad value answered ${lastStatus()}`);
    assert(show(bad) === show({ value: 'ALL', delayed: false }), `bad value shows ${show(bad)}`);
    const user = await saveRollout(initDataFor(USER_TG), 'ALL', 'OFF');
    assert(lastStatus() === 403 && user.value === 'ALL', `a user: ${lastStatus()} ${show(user)}`);
    assert(DB.adminSettings[0].calendarHomeRollout === 'ALL', `DB now ${DB.adminSettings[0].calendarHomeRollout}`);
  });

  await check('#9 a propagated: false answer still shows the new value with the note; a 503 keeps the old value', async () => {
    seed();
    const admin = initDataFor(ADMIN_TG);
    redisState.failSet = true;
    const delayed = await saveRollout(admin, 'ADMINS', 'OFF');
    redisState.failSet = false;
    assert(lastStatus() === 200 && show(delayed) === show({ value: 'OFF', delayed: true }), `saved ${lastStatus()} ${show(delayed)}`);
    assert(DB.adminSettings[0].calendarHomeRollout === 'OFF' && !redisStore.has(ROLLOUT_KEY),
      `DB ${DB.adminSettings[0].calendarHomeRollout}, Redis ${redisStore.get(ROLLOUT_KEY)}`);

    const React = nodeRequire('react');
    const { CalendarHomeRolloutControl } = await load('app/[locale]/admin-panel/AdminPanelClient.tsx');
    assert(typeof CalendarHomeRolloutControl === 'function', 'AdminPanelClient exports no CalendarHomeRolloutControl');
    const problems: string[] = [];
    for (const locale of ['en', 'he', 'ru']) {
      const copy = rolloutCopy(locale);
      const html = renderHtml(React.createElement(CalendarHomeRolloutControl, { ...delayed, saving: false, onChange: () => undefined }), locale);
      if (show(checkedLabels(html)) !== show([copy.calendarHomeOff])) problems.push(`${locale}: checked ${show(checkedLabels(html))}`);
      if (!html.includes(copy.calendarHomeDelayed)) problems.push(`${locale}: no note in ${html}`);
      for (const label of [copy.calendarHomeOff, copy.calendarHomeAdmins, copy.calendarHomeAll]) {
        if (!html.includes(`>${label}</button>`)) problems.push(`${locale}: no ${label} button`);
      }
    }
    const en = rolloutCopy('en');
    const plain = renderHtml(React.createElement(CalendarHomeRolloutControl, { value: 'ADMINS', delayed: false, saving: false, onChange: () => undefined }), 'en');
    if (plain.includes(en.calendarHomeDelayed)) problems.push('the note shows after a save Redis took');
    if (show(checkedLabels(plain)) !== show([en.calendarHomeAdmins])) problems.push(`ADMINS: checked ${show(checkedLabels(plain))}`);
    assert(problems.length === 0, problems.join('; '));

    seed();
    dbState.failing = 'adminSettings';
    const kept = await saveRollout(admin, 'ADMINS', 'ALL');
    dbState.failing = '';
    assert(lastStatus() === 503 && show(kept) === show({ value: 'ADMINS', delayed: false }), `DB write failed: ${lastStatus()} ${show(kept)}`);
    assert(DB.adminSettings[0].calendarHomeRollout === 'ADMINS' && !redisStore.has(ROLLOUT_KEY), 'something was saved');
  });

  await check('#10 a DB blip on the settings read shows OFF while the switch is ALL; a tap on the shown OFF still sends it, through the real route', async () => {
    seed();
    const admin = initDataFor(ADMIN_TG);
    (DB.adminSettings[0] as Row).calendarHomeRollout = 'ALL';
    dbState.failing = 'adminSettings';
    const blip = await runLoader(admin);
    dbState.failing = '';
    assert(blip.kind === 'ready' && blip.initial?.calendarHomeRollout === 'OFF', `the premise: ${show(blip)}`);

    const React = nodeRequire('react');
    const { CalendarHomeRolloutControl } = await load('app/[locale]/admin-panel/AdminPanelClient.tsx');
    /** The control's buttons as it renders them, onClick included (called inside a render, so its hooks run). */
    const buttons = (props: Row): Row[] => {
      let tree: unknown = null;
      const Capture = () => {
        tree = CalendarHomeRolloutControl(props);
        return null;
      };
      renderHtml(React.createElement(Capture), 'en');
      const found: Row[] = [];
      const walk = (node: unknown): void => {
        if (Array.isArray(node)) {
          node.forEach(walk);
          return;
        }
        if (!node || typeof node !== 'object') return;
        const el = node as Row;
        if (el.type === 'button') found.push(el.props);
        walk(el.props?.children);
      };
      walk(tree);
      return found;
    };
    const taps: string[] = [];
    const shown = buttons({ value: 'OFF', saving: false, delayed: false, onChange: (v: string) => taps.push(v) });
    assert(shown.length === 3, `${shown.length} buttons`);
    for (const b of shown) b.onClick();
    for (const b of buttons({ value: 'OFF', saving: true, delayed: false, onChange: (v: string) => taps.push(`while saving: ${v}`) })) b.onClick();
    assert(show(taps) === show(['OFF', 'ADMINS', 'ALL']), `taps sent ${show(taps)}`);

    const resent = await saveRollout(admin, 'OFF', 'OFF');
    assert(lastStatus() === 200 && show(resent) === show({ value: 'OFF', delayed: false }), `resend: ${lastStatus()} ${show(resent)}`);
    assert(DB.adminSettings[0].calendarHomeRollout === 'OFF' && redisStore.get(ROLLOUT_KEY) === 'OFF',
      `DB ${DB.adminSettings[0].calendarHomeRollout}, Redis ${redisStore.get(ROLLOUT_KEY)}`);
  });
```

#10 reads the control's buttons by calling it inside a render (its `useTranslations` needs one) and pressing each `onClick`: the smoke has no DOM.

- [ ] **Step 3: Run both smokes and see them fail**

```bash
for tz in UTC Asia/Jerusalem; do
  eval "env TZ=$tz $E npx tsx scripts/smoke-calendar-home-rollout.ts"; echo "smoke-calendar-home-rollout TZ=$tz exit $?"
  eval "env TZ=$tz $E npx tsx scripts/smoke-admin-panel-ssr.ts"; echo "smoke-admin-panel-ssr TZ=$tz exit $?"
done
```
Expected:
- `smoke-calendar-home-rollout` stops at its import with `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/src/services/calendar-read/rollout'` and prints `exit 1`.
- `smoke-admin-panel-ssr` passes #1, #2, #5 and #6 and fails the rest:
  - #3 and #4: the toggles lack `calendarHomeRollout`;
  - #7: no `calendarHomeRollout` in `initial`;
  - #8 and #9: `AdminPanelClient exports no saveCalendarHomeRollout`;
  - #10: `the premise: …`, the loader's `initial` has no `calendarHomeRollout`.

  It prints `4/10 passed` and `exit 1`.

- [ ] **Step 4: Add the enum and the column to `prisma/schema.prisma`**

Replace `:125-138` (the whole `AdminSettings` model). The wider type column is what `prisma format` produces. Before:
```prisma
model AdminSettings {
  id                      String   @id @default("global")
  remindersEnabled        Boolean  @default(false)
  earlyAdoptionMode       Boolean  @default(true)
  // Unused: the AI and TTS models are fixed in src/config/ai-models.ts and
  // src/config/tts-models.ts. These three columns are kept only to avoid a migration.
  defaultAiModel          String?
  geminiThinkingLevel     String?
  ttsModel                String?
  voiceAutoCreateHighConf Boolean  @default(false) // Auto-create on HIGH-confidence voice CRUD (skip confirmation)
  voiceTtsOutcome         Boolean  @default(false) // Speak the outcome line back when input was voice
  nativeRemindersEnabled  Boolean  @default(true) // Built-in calendar reminders: the extraction rules and the 1-minute ping pass
  updatedAt               DateTime @updatedAt
}
```
After:
```prisma
model AdminSettings {
  id                      String              @id @default("global")
  remindersEnabled        Boolean             @default(false)
  earlyAdoptionMode       Boolean             @default(true)
  // Unused: the AI and TTS models are fixed in src/config/ai-models.ts and
  // src/config/tts-models.ts. These three columns are kept only to avoid a migration.
  defaultAiModel          String?
  geminiThinkingLevel     String?
  ttsModel                String?
  voiceAutoCreateHighConf Boolean             @default(false) // Auto-create on HIGH-confidence voice CRUD (skip confirmation)
  voiceTtsOutcome         Boolean             @default(false) // Speak the outcome line back when input was voice
  nativeRemindersEnabled  Boolean             @default(true) // Built-in calendar reminders: the extraction rules and the 1-minute ping pass
  calendarHomeRollout     CalendarHomeRollout @default(OFF) // The calendar home and the summary reader: off, admins only, or everyone
  updatedAt               DateTime            @updatedAt
}

// Who gets the calendar home and the summary reader (docs/superpowers/specs/2026-10-16-calendar-home-design.md §1)
enum CalendarHomeRollout {
  OFF // Nobody: the old home and today's summary path
  ADMINS // Users with isAdmin only
  ALL // Everyone
}
```

- [ ] **Step 5: Regenerate the Prisma client, check the format, and compare with Prisma's own diff**

```bash
npx prisma generate
npx prisma format && git diff --stat prisma/schema.prisma
D=$(mktemp -d) && git show HEAD:prisma/schema.prisma > "$D/before.prisma" && npx prisma migrate diff --from-schema-datamodel "$D/before.prisma" --to-schema-datamodel prisma/schema.prisma --script
```
Expected:
- `✔ Generated Prisma Client (v5.22.0)`.
- `prisma format` changes nothing beyond Step 4: the stat reads `1 file changed, 15 insertions(+), 7 deletions(-)`.
- The diff prints exactly these two statements, which Step 6 wraps in guards:
  - `CREATE TYPE "CalendarHomeRollout" AS ENUM ('OFF', 'ADMINS', 'ALL');`
  - `ALTER TABLE "AdminSettings" ADD COLUMN     "calendarHomeRollout" "CalendarHomeRollout" NOT NULL DEFAULT 'OFF';`

  None of these commands connects to a database.

- [ ] **Step 6: Create the migration `prisma/migrations/20261016000000_calendar_home_rollout/migration.sql`**

```sql
-- The calendar home's rollout switch (docs/superpowers/specs/2026-10-16-calendar-home-design.md §1).
-- OFF: nobody gets the new home or the summary reader; ADMINS: users with isAdmin; ALL:
-- everyone. Ships as OFF, so the deploy changes nothing anyone sees.
--
-- Hand-written and idempotent, like the other recent migrations: these are the
-- statements Prisma's diff produces for this schema change, guarded so a re-run is a
-- no-op (CREATE TYPE has no IF NOT EXISTS, hence the DO block).

DO $$ BEGIN
  CREATE TYPE "CalendarHomeRollout" AS ENUM ('OFF', 'ADMINS', 'ALL');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

ALTER TABLE "AdminSettings" ADD COLUMN IF NOT EXISTS "calendarHomeRollout" "CalendarHomeRollout" NOT NULL DEFAULT 'OFF';
```

- [ ] **Step 7: Add the Redis key to `src/config/redis-keys.ts`**

Before (`:101-103`):
```ts
  // Native reminders — the admin switch cached from AdminSettings. Its own prefix:
  // "reminder:" and "reminders:" belong to event alerts.
  NATIVE_REMINDERS_ENABLED: 'nrem:enabled',
```
After:
```ts
  // Native reminders — the admin switch cached from AdminSettings. Its own prefix:
  // "reminder:" and "reminders:" belong to event alerts.
  NATIVE_REMINDERS_ENABLED: 'nrem:enabled',

  // Calendar home — the rollout switch (OFF / ADMINS / ALL) cached from AdminSettings, EX 60
  CALENDAR_HOME_ROLLOUT: 'chome:rollout',
```

- [ ] **Step 8: Create `src/services/calendar-read/rollout.ts`**

```ts
/**
 * The calendar home's rollout switch (docs/superpowers/specs/2026-10-16-calendar-home-design.md §1).
 *
 * AdminSettings.calendarHomeRollout is OFF, ADMINS or ALL. It covers the new home and the
 * summaries' move onto the shared reader, so every call site asks
 * `await isCalendarHomeOn(user)` with a fresh DB user row.
 *
 * A read goes through a 30 s memo, then Redis (chome:rollout), then the DB. The memo lives
 * on globalThis: in Next 16 the scheduler and the routes get separate copies of this
 * module, and a set in one must clear the memo the other reads. Every Redis write expires
 * in 60 s and a failed one deletes the key, so the DB value always wins within about a
 * minute. Anything that is not one of the three values, both stores failing, or no row
 * reads as OFF: the old home and today's summary path.
 */

import { redis } from '../../utils/redis';
import { prisma } from '../../utils/prisma';
import { REDIS_KEYS } from '../../config/redis-keys';
import { captureError } from '../../lib/error-capture';

export type CalendarHomeRolloutValue = 'OFF' | 'ADMINS' | 'ALL';

const VALUES: readonly CalendarHomeRolloutValue[] = ['OFF', 'ADMINS', 'ALL'];
const KEY = REDIS_KEYS.CALENDAR_HOME_ROLLOUT;
const MEMO_MS = 30_000;
const REDIS_TTL_S = 60;
const CONTEXT = 'calendar-home-rollout';

type Memo = { value: CalendarHomeRolloutValue; at: number };
const shared = globalThis as typeof globalThis & { __calendarHomeRolloutMemo?: Memo | null };

export function isCalendarHomeRolloutValue(value: unknown): value is CalendarHomeRolloutValue {
  return typeof value === 'string' && (VALUES as readonly string[]).includes(value);
}

function remember(value: CalendarHomeRolloutValue): CalendarHomeRolloutValue {
  shared.__calendarHomeRolloutMemo = { value, at: Date.now() };
  return value;
}

function warn(error: unknown): void {
  captureError(error, CONTEXT, {}, 'warning');
}

/** The switch as this process sees it: the memo, then Redis, then the DB; OFF when nothing answers. */
export async function getCalendarHomeRollout(): Promise<CalendarHomeRolloutValue> {
  const memo = shared.__calendarHomeRolloutMemo;
  if (memo) {
    const age = Date.now() - memo.at;
    if (age >= 0 && age < MEMO_MS) return memo.value;
  }

  let redisUp = true;
  let cached: unknown = null;
  try {
    cached = await redis.get<string>(KEY);
    if (isCalendarHomeRolloutValue(cached)) return remember(cached);
  } catch (error) {
    redisUp = false;
    warn(error);
  }

  try {
    const settings = await prisma.adminSettings.findUnique({
      where: { id: 'global' },
      select: { calendarHomeRollout: true },
    });
    const stored: unknown = settings?.calendarHomeRollout;
    const value = isCalendarHomeRolloutValue(stored) ? stored : 'OFF';
    if (redisUp) {
      try {
        // On a miss, only fill the key if a set hasn't written it meanwhile; a value that
        // is none of the three is overwritten.
        if (cached === null) await redis.set(KEY, value, { ex: REDIS_TTL_S, nx: true });
        else await redis.set(KEY, value, { ex: REDIS_TTL_S });
      } catch (error) {
        warn(error);
      }
    }
    return remember(value);
  } catch (error) {
    warn(error);
    return 'OFF';
  }
}

/** Whether this user gets the calendar home and the summary reader. Always awaited. */
export async function isCalendarHomeOn(user: { isAdmin?: boolean | null }): Promise<boolean> {
  const rollout = await getCalendarHomeRollout();
  return rollout === 'ALL' || (rollout === 'ADMINS' && user.isAdmin === true);
}

/**
 * Saves the switch: the DB (a failure there rejects, and nothing is saved), then Redis
 * with EX 60, deleting the key if that write fails, then clears the memo. Answers whether
 * Redis took the value; false means other processes see it within about a minute.
 */
export async function setCalendarHomeRollout(value: CalendarHomeRolloutValue): Promise<boolean> {
  if (!isCalendarHomeRolloutValue(value)) {
    throw new TypeError(`Not a calendar home rollout value: ${String(value)}`);
  }
  await prisma.adminSettings.upsert({
    where: { id: 'global' },
    update: { calendarHomeRollout: value },
    create: { id: 'global', calendarHomeRollout: value },
  });

  let propagated = true;
  try {
    await redis.set(KEY, value, { ex: REDIS_TTL_S });
    console.log(`[CalendarHome] Set the rollout to ${value}`);
  } catch (error) {
    propagated = false;
    warn(error);
    try {
      await redis.del(KEY);
    } catch (delError) {
      warn(delError);
    }
  }
  shared.__calendarHomeRolloutMemo = null;
  return propagated;
}
```

- [ ] **Step 9: Replace `app/api/admin/settings/route.ts`**

The whole file, `:1-152`. Here is what changes. Everything else is today's code; the toggle block is re-indented under `if (hasToggle)`.
- The import of the rollout helpers.
- GET's `calendarHomeRollout`.
- POST:
  - reads `calendarHomeRollout` and refuses any value outside the three with a 400, after auth;
  - counts it in the at-least-one-field check;
  - runs the old upsert only when a toggle was sent;
  - calls `setCalendarHomeRollout`, whose DB failure lands in the existing 503;
  - answers `{ ...toggles, calendarHomeRollout, propagated }`.

```ts
/**
 * Admin Settings API
 * GET: Fetch admin settings (admin-only; the admin panel loads its toggles here)
 * POST: Update admin settings (admin-only)
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/src/utils/prisma';
import { verifyAdminAccess } from '@/src/lib/admin-auth';
import { requestInitData } from '@/src/lib/request-init-data';
import { captureError } from '@/src/lib/error-capture';
import { setGlobalRemindersEnabled, setEarlyAdoptionMode, setVoiceAutoCreateHighConf, setVoiceTtsOutcome } from '@/src/services/reminder-cache';
import { invalidateAllFeatureAccessCaches } from '@/src/services/subscription-service';
import { setNativeRemindersEnabled } from '@/src/services/native-reminders/support';
import { isCalendarHomeRolloutValue, setCalendarHomeRollout } from '@/src/services/calendar-read/rollout';

export const dynamic = 'force-dynamic';

// GET: Fetch admin settings (admin-only)
export async function GET(request: NextRequest) {
  const auth = await verifyAdminAccess(requestInitData(request));
  if (!auth.authorized) {
    return NextResponse.json(
      { error: auth.error },
      { status: auth.error === 'Admin access required' ? 403 : 401 }
    );
  }

  try {
    const adminSettings = await prisma.adminSettings.findUnique({
      where: { id: 'global' }
    }).catch(() => null); // Handle missing table gracefully

    return NextResponse.json({
      success: true,
      remindersEnabled: adminSettings?.remindersEnabled ?? false,
      earlyAdoptionMode: adminSettings?.earlyAdoptionMode ?? false,
      voiceAutoCreateHighConf: adminSettings?.voiceAutoCreateHighConf ?? false,
      voiceTtsOutcome: adminSettings?.voiceTtsOutcome ?? false,
      nativeRemindersEnabled: adminSettings?.nativeRemindersEnabled ?? true,
      calendarHomeRollout: adminSettings?.calendarHomeRollout ?? 'OFF',
    });
  } catch (error) {
    captureError(error, 'admin-settings-get', { api_route: '/api/admin/settings' });
    return NextResponse.json({
      success: true,
      remindersEnabled: false // Default to disabled on error
    });
  }
}

// POST: Update admin settings (admin-only)
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { remindersEnabled, earlyAdoptionMode, voiceAutoCreateHighConf, voiceTtsOutcome, nativeRemindersEnabled, calendarHomeRollout, initData } = body;

    // Verify admin access
    const auth = await verifyAdminAccess(initData);
    if (!auth.authorized) {
      return NextResponse.json(
        { error: auth.error },
        { status: auth.error === 'Admin access required' ? 403 : 401 }
      );
    }

    // The calendar home's rollout is one of three values; anything else sent is refused, not ignored
    const hasRollout = calendarHomeRollout !== undefined;
    if (hasRollout && !isCalendarHomeRolloutValue(calendarHomeRollout)) {
      return NextResponse.json(
        { error: 'calendarHomeRollout must be OFF, ADMINS or ALL' },
        { status: 400 }
      );
    }

    // Validate input - at least one field must be provided
    const hasReminders = typeof remindersEnabled === 'boolean';
    const hasEarlyAdoption = typeof earlyAdoptionMode === 'boolean';
    const hasVoiceAutoCreate = typeof voiceAutoCreateHighConf === 'boolean';
    const hasVoiceTts = typeof voiceTtsOutcome === 'boolean';
    const hasNativeReminders = typeof nativeRemindersEnabled === 'boolean';
    const hasToggle = hasReminders || hasEarlyAdoption || hasVoiceAutoCreate || hasVoiceTts || hasNativeReminders;
    if (!hasToggle && !hasRollout) {
      return NextResponse.json(
        { error: 'At least one setting field must be provided' },
        { status: 400 }
      );
    }

    // Upsert admin settings
    try {
      let toggles: Record<string, boolean> = {};
      if (hasToggle) {
        const updateData: Record<string, boolean> = {};
        const createData: Record<string, boolean | string> = { id: 'global' };
        if (hasReminders) {
          updateData.remindersEnabled = remindersEnabled;
          createData.remindersEnabled = remindersEnabled;
        }
        if (hasEarlyAdoption) {
          updateData.earlyAdoptionMode = earlyAdoptionMode;
          createData.earlyAdoptionMode = earlyAdoptionMode;
        }
        if (hasVoiceAutoCreate) {
          updateData.voiceAutoCreateHighConf = voiceAutoCreateHighConf;
          createData.voiceAutoCreateHighConf = voiceAutoCreateHighConf;
        }
        if (hasVoiceTts) {
          updateData.voiceTtsOutcome = voiceTtsOutcome;
          createData.voiceTtsOutcome = voiceTtsOutcome;
        }
        if (hasNativeReminders) {
          updateData.nativeRemindersEnabled = nativeRemindersEnabled;
          createData.nativeRemindersEnabled = nativeRemindersEnabled;
        }

        const settings = await prisma.adminSettings.upsert({
          where: { id: 'global' },
          update: updateData,
          create: createData as { id: string; remindersEnabled?: boolean; earlyAdoptionMode?: boolean; voiceAutoCreateHighConf?: boolean; voiceTtsOutcome?: boolean; nativeRemindersEnabled?: boolean },
        });

        // Sync to Redis cache
        if (hasReminders) {
          await setGlobalRemindersEnabled(remindersEnabled);
        }
        if (hasEarlyAdoption) {
          await setEarlyAdoptionMode(earlyAdoptionMode);
          await invalidateAllFeatureAccessCaches();
        }
        if (hasVoiceAutoCreate) {
          await setVoiceAutoCreateHighConf(voiceAutoCreateHighConf);
        }
        if (hasVoiceTts) {
          await setVoiceTtsOutcome(voiceTtsOutcome);
        }
        if (hasNativeReminders) {
          await setNativeRemindersEnabled(nativeRemindersEnabled);
        }

        toggles = {
          remindersEnabled: settings.remindersEnabled,
          earlyAdoptionMode: settings.earlyAdoptionMode,
          voiceAutoCreateHighConf: settings.voiceAutoCreateHighConf,
          voiceTtsOutcome: settings.voiceTtsOutcome,
          nativeRemindersEnabled: settings.nativeRemindersEnabled,
        };
      }

      // The rollout's setter writes the DB itself (a failure there is the 503 below), then
      // Redis. propagated: false means Redis missed it: other processes see the new value
      // within about a minute, and the panel says so.
      let rollout: { calendarHomeRollout: string; propagated: boolean } | null = null;
      if (hasRollout) {
        rollout = { calendarHomeRollout, propagated: await setCalendarHomeRollout(calendarHomeRollout) };
      }

      console.log(`[admin-settings] Admin ${auth.adminId} updated settings:`, { remindersEnabled, earlyAdoptionMode, voiceAutoCreateHighConf, voiceTtsOutcome, nativeRemindersEnabled, calendarHomeRollout });

      return NextResponse.json({
        success: true,
        ...toggles,
        ...rollout,
      });
    } catch (dbError) {
      // Table might not exist yet
      console.error('[admin-settings] Database error (table may not exist):', dbError);
      return NextResponse.json(
        { error: 'Feature not available yet - database migration pending' },
        { status: 503 }
      );
    }
  } catch (error) {
    captureError(error, 'admin-settings-post', { api_route: '/api/admin/settings' });
    return NextResponse.json(
      { error: 'Failed to update admin settings' },
      { status: 500 }
    );
  }
}
```

- [ ] **Step 10: Add the admin copy to `messages/en.json`, `messages/he.json`, `messages/ru.json`**

In each file, insert the six lines right after line 101, the `"nativeRemindersDescription": …,` line inside `admin.features`, and before `"earlyAdoption"`.

`messages/en.json`:
```json
      "calendarHome": "Calendar home",
      "calendarHomeDescription": "The new home that shows the calendar, with the daily and weekly summaries read the same way. Admins first, then everyone. Off: the current home and summaries.",
      "calendarHomeOff": "Off",
      "calendarHomeAdmins": "Admins",
      "calendarHomeAll": "Everyone",
      "calendarHomeDelayed": "Saved; takes effect within a minute",
```

`messages/he.json`:
```json
      "calendarHome": "מסך הבית של היומן",
      "calendarHomeDescription": "מסך הבית החדש שמציג את היומן, והסיכומים היומיים והשבועיים נבנים מאותם נתונים. קודם למנהלים, אחר כך לכולם. כבוי: מסך הבית והסיכומים הנוכחיים.",
      "calendarHomeOff": "כבוי",
      "calendarHomeAdmins": "מנהלים",
      "calendarHomeAll": "כולם",
      "calendarHomeDelayed": "נשמר. ייכנס לתוקף תוך דקה",
```

`messages/ru.json`:
```json
      "calendarHome": "Главный экран календаря",
      "calendarHomeDescription": "Новый главный экран с календарём; ежедневные и недельные сводки строятся по тем же данным. Сначала для админов, потом для всех. Выкл.: нынешние экран и сводки.",
      "calendarHomeOff": "Выкл.",
      "calendarHomeAdmins": "Админы",
      "calendarHomeAll": "Все",
      "calendarHomeDelayed": "Сохранено, заработает в течение минуты",
```

- [ ] **Step 11: Add the control to `app/[locale]/admin-panel/AdminPanelClient.tsx`**

Nine exact edits.

(a) `:6`. Before:
```tsx
import { initDataHeaders } from '@/src/lib/read-init-data';
```
After (a type-only import: nothing server-side reaches the client bundle):
```tsx
import { initDataHeaders } from '@/src/lib/read-init-data';
import type { CalendarHomeRolloutValue } from '@/src/services/calendar-read/rollout';
```

(b) `AdminPanelProps`, `:27-29`. Before:
```tsx
  voiceTtsOutcome: boolean;
  nativeRemindersEnabled: boolean;
}
```
After:
```tsx
  voiceTtsOutcome: boolean;
  nativeRemindersEnabled: boolean;
  calendarHomeRollout: CalendarHomeRolloutValue;
}
```

(c) Before `:147`. Before:
```tsx
/** What the panel starts from: the toggles and the user counts. */
```
After:
```tsx
/** The calendar home's rollout values, in the control's order (spec §1). */
const ROLLOUT_CHOICES: readonly CalendarHomeRolloutValue[] = ['OFF', 'ADMINS', 'ALL'];

function isRolloutChoice(value: unknown): value is CalendarHomeRolloutValue {
  return typeof value === 'string' && (ROLLOUT_CHOICES as readonly string[]).includes(value);
}

/** What the panel starts from: the toggles and the user counts. */
```

(d) `loadAdminPanel`, `:181`. Before:
```tsx
        nativeRemindersEnabled: settings.nativeRemindersEnabled ?? true,
      },
```
After:
```tsx
        nativeRemindersEnabled: settings.nativeRemindersEnabled ?? true,
        calendarHomeRollout: isRolloutChoice(settings.calendarHomeRollout) ? settings.calendarHomeRollout : 'OFF',
      },
```

(e) Before `:190`, the save helper and the control. They are separate components because the panel's `<style jsx>` (`:1089`) is scoped to `AdminPanel`, so they style themselves inline. Before:
```tsx
/** The white card on the purple gradient, as the page's own notices look. */
```
After:
```tsx
/** What the rollout control shows after a save. */
export interface RolloutSaveResult {
  value: CalendarHomeRolloutValue;
  /** Saved, but Redis missed it: the other processes take it up within about a minute. */
  delayed: boolean;
}

/**
 * Saves the calendar home's rollout through POST /api/admin/settings. A 200 shows the new
 * value, with the "takes effect within a minute" note when the answer says propagated:
 * false. Anything else (400, 401/403, 503, no network) keeps the old value: nothing was saved.
 */
export async function saveCalendarHomeRollout(
  previous: CalendarHomeRolloutValue,
  next: CalendarHomeRolloutValue,
): Promise<RolloutSaveResult> {
  try {
    const initData = typeof window !== 'undefined' ? window.Telegram?.WebApp?.initData : undefined;
    const response = await fetch('/api/admin/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ calendarHomeRollout: next, initData }),
    });
    if (!response.ok) return { value: previous, delayed: false };
    const body = await response.json().catch(() => ({}));
    return {
      value: isRolloutChoice(body.calendarHomeRollout) ? body.calendarHomeRollout : next,
      delayed: body.propagated === false,
    };
  } catch (error) {
    console.error('[AdminPanel] rollout save failed:', error);
    return { value: previous, delayed: false };
  }
}

/**
 * The calendar home's three-way rollout (Off / Admins / Everyone) and its note. It sits
 * inside the panel's toggle row, so its own styles are inline (the panel's CSS is scoped
 * to AdminPanel). Touch-sized buttons, no hover: the panel is a phone Mini App.
 */
export function CalendarHomeRolloutControl({ value, saving, delayed, onChange }: {
  value: CalendarHomeRolloutValue;
  saving: boolean;
  delayed: boolean;
  onChange: (next: CalendarHomeRolloutValue) => void;
}) {
  const t = useTranslations('admin');
  const labels: Record<CalendarHomeRolloutValue, string> = {
    OFF: t('features.calendarHomeOff'),
    ADMINS: t('features.calendarHomeAdmins'),
    ALL: t('features.calendarHomeAll'),
  };
  return (
    <>
      <div role="radiogroup" aria-label={t('features.calendarHome')} style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
        {ROLLOUT_CHOICES.map((choice) => {
          const selected = value === choice;
          return (
            <button
              key={choice}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={saving}
              style={{
                flex: '1 1 0',
                minHeight: '44px',
                padding: '0 8px',
                borderRadius: '10px',
                border: `2px solid ${selected ? '#667eea' : '#e5e7eb'}`,
                background: selected ? '#667eea' : 'white',
                color: selected ? 'white' : '#374151',
                fontSize: '14px',
                fontWeight: 600,
                cursor: saving ? 'not-allowed' : 'pointer',
                opacity: saving ? 0.6 : 1,
              }}
              onClick={() => {
                // The shown choice sends too: after a settings read that failed the panel
                // shows OFF whatever the switch is, and OFF must always be sendable.
                if (!saving) onChange(choice);
              }}
            >
              {labels[choice]}
            </button>
          );
        })}
      </div>
      {delayed && (
        <p role="status" style={{ fontSize: '13px', color: '#b45309', margin: '8px 0 0 0' }}>
          {t('features.calendarHomeDelayed')}
        </p>
      )}
    </>
  );
}

/** The white card on the purple gradient, as the page's own notices look. */
```

(f) `:310`. Before:
```tsx
function AdminPanel({ userId, locale, stats, remindersEnabled: initialRemindersEnabled, earlyAdoptionMode: initialEarlyAdoptionMode, voiceAutoCreateHighConf: initialVoiceAutoCreateHighConf, voiceTtsOutcome: initialVoiceTtsOutcome, nativeRemindersEnabled: initialNativeRemindersEnabled }: AdminPanelProps) {
```
After:
```tsx
function AdminPanel({ userId, locale, stats, remindersEnabled: initialRemindersEnabled, earlyAdoptionMode: initialEarlyAdoptionMode, voiceAutoCreateHighConf: initialVoiceAutoCreateHighConf, voiceTtsOutcome: initialVoiceTtsOutcome, nativeRemindersEnabled: initialNativeRemindersEnabled, calendarHomeRollout: initialCalendarHomeRollout }: AdminPanelProps) {
```

(g) After `:321`. Before:
```tsx
  const [nativeRemindersSaving, setNativeRemindersSaving] = useState(false);
```
After:
```tsx
  const [nativeRemindersSaving, setNativeRemindersSaving] = useState(false);
  const [calendarHomeRollout, setCalendarHomeRollout] = useState(initialCalendarHomeRollout);
  const [rolloutSaving, setRolloutSaving] = useState(false);
  const [rolloutDelayed, setRolloutDelayed] = useState(false);
```

(h) After `toggleNativeReminders`, `:500-505`. Before:
```tsx
        setNativeRemindersEnabled(!nativeRemindersEnabled);
      }
    } finally {
      setNativeRemindersSaving(false);
    }
  };
```
After:
```tsx
        setNativeRemindersEnabled(!nativeRemindersEnabled);
      }
    } finally {
      setNativeRemindersSaving(false);
    }
  };

  const changeCalendarHomeRollout = async (next: CalendarHomeRolloutValue) => {
    setRolloutSaving(true);
    try {
      const saved = await saveCalendarHomeRollout(calendarHomeRollout, next);
      setCalendarHomeRollout(saved.value);
      setRolloutDelayed(saved.delayed);
    } finally {
      setRolloutSaving(false);
    }
  };
```

(i) The row, right after the built-in reminders toggle row (`:2332-2340`). Before:
```tsx
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
After:
```tsx
                  if ((e.key === 'Enter' || e.key === ' ') && !nativeRemindersSaving) {
                    e.preventDefault();
                    toggleNativeReminders();
                  }
                }}
              >
                <div className="toggle-slider" />
              </div>
            </div>
            <div className="toggle-row" style={{ marginTop: '12px' }}>
              <div className="toggle-info">
                <p className="toggle-label">{t('features.calendarHome')}</p>
                <p className="toggle-description">{t('features.calendarHomeDescription')}</p>
                <CalendarHomeRolloutControl
                  value={calendarHomeRollout}
                  saving={rolloutSaving}
                  delayed={rolloutDelayed}
                  onChange={changeCalendarHomeRollout}
                />
              </div>
            </div>
```

- [ ] **Step 12: Run both smokes and see them pass**

```bash
for tz in UTC Asia/Jerusalem; do
  eval "env TZ=$tz $E npx tsx scripts/smoke-calendar-home-rollout.ts"; echo "smoke-calendar-home-rollout TZ=$tz exit $?"
  eval "env TZ=$tz $E npx tsx scripts/smoke-admin-panel-ssr.ts"; echo "smoke-admin-panel-ssr TZ=$tz exit $?"
done
```
Expected, in both timezones: `33/33 passed` with `exit 0`, then `10/10 passed` with `exit 0`.

- [ ] **Step 13: Run the neighbouring smokes and the i18n parity check, unchanged**

```bash
L=$(mktemp -d)
for s in smoke-native-reminder-support smoke-admin-settings-auth smoke-initdata-header smoke-page-auth smoke-miniapp-gate check-i18n-parity; do
  eval "env TZ=UTC $E npx tsx scripts/$s.ts" > "$L/$s.log" 2>&1; echo "$s exit $? $(grep -E 'passed|parity' "$L/$s.log" | tail -1)"
done
```
Expected, every one `exit 0`:
- `smoke-native-reminder-support`: 32/32. Its route checks still see today's toggle answer, and the `db … | redis nrem:enabled=false` write order.
- `smoke-admin-settings-auth`: 3/3.
- `smoke-initdata-header`: 9/9.
- `smoke-page-auth`: 10/10.
- `smoke-miniapp-gate`: 15/15.
- `check-i18n-parity`: `i18n parity OK (885 keys)` on main@858886c plus this task. The count is higher if earlier tasks added keys.

- [ ] **Step 14: Type-check and lint**

```bash
npx tsc --noEmit -p .; echo "tsc exit $?"
npm run -s lint; echo "lint exit $?"
```
Expected: no output from either, then `tsc exit 0` and `lint exit 0`. tsc sees the new column only after Step 5's `prisma generate`. The `eslint-disable-next-line @typescript-eslint/no-require-imports` in the smoke is needed: that check `require`s a second copy of `rollout.ts`.

- [ ] **Step 15: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20261016000000_calendar_home_rollout/migration.sql src/config/redis-keys.ts src/services/calendar-read/rollout.ts app/api/admin/settings/route.ts 'app/[locale]/admin-panel/AdminPanelClient.tsx' messages/en.json messages/he.json messages/ru.json scripts/smoke-calendar-home-rollout.ts scripts/smoke-admin-panel-ssr.ts
git commit -m "$(cat <<'EOF'
feat(calendar-home): the rollout switch, OFF by default, with its admin control

AdminSettings.calendarHomeRollout (OFF / ADMINS / ALL) behind a hand-written,
idempotent migration. rollout.ts reads it through a 30 s memo on globalThis,
then Redis chome:rollout (EX 60), then the DB, OFF on anything else.
isCalendarHomeOn lets admins in under ADMINS and everyone under ALL. The
setter writes the DB, then Redis, deletes the key if that fails, and says
whether Redis took it. The admin settings route reads and writes it (400 on
any other value, propagated: false when Redis missed, 503 as before), and the
admin panel gets an Off / Admins / Everyone control with en/he/ru copy.
Nothing reads the switch yet, so no user sees a change.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
EOF
)"
```

---

### Task 2 (B2): Locale rules: week start by country, Hebrew dates, week boundaries (spec §6, pure)

**What and why.** The home's Month grid and, in Plan C, the bot's This week / Next week need one week-start rule: Jewish culture → Sunday; else the country of a *known* timezone (CLDR: Sunday, Saturday, Friday or Monday); else the language (he/en → Sunday, ru → Monday, Ruling R15); else Monday. The home's Hebrew dates need the owner's gate: Jewish culture, Hebrew language, or a known Israel timezone. This task adds both as pure functions, plus the zone table they read and the two week-boundary functions Plan C swaps into `week-lookahead.ts`. It adds files only. No existing file changes and nothing calls the new code yet, so no user sees any change (the switch stays `OFF`).

**Interface change: none.** Two notes for later tasks:
- `nextWeekBoundary` and `nextWeekBoundaries` type `today` and their results as `string`, not `DayKey`. `DayKey` is B3's alias for `string` (`src/lib/calendar-view/types.ts`), and B2 lands before B3, so the types are identical and callers pass a `DayKey` unchanged.
- The module also exports the `WeekStart` type (`0|1|…|6`), the `LocaleFacts` type (the spec's `Facts`) and the `ISRAEL_ZONES` set. These are additions only. Server code (B8's route, Plan C's callers) types its week start as `WeekStart` from this module. Client code (Plans D and E) imports `WeekStart` only from `src/lib/calendar-view/types.ts`, never from here: this module pulls in the zone table. B3 adds that client-safe `WeekStart` and turns this one into a re-export of it, so there is a single definition.

**Findings (read before you start):**
- Today's private functions are `getNextWeekBoundary(culture, always7Days, today)` (`src/services/week-lookahead.ts:91-110` with Plan A in; `:80-99` at main@858886c) and `getNextWeekBoundaries(culture, today)` (`:483-499`; `:435-451` at main@858886c). The new functions take a week start `ws` in place of the culture. For `ws = legacyWeekStart(culture)` (jewish → 0, anything else → 1) they give today's results on every weekday, with and without `lookaheadAlways7Days`. The smoke holds them to verbatim copies of today's functions. Plan C replaces both bodies with calls. This task leaves `week-lookahead.ts` alone.
- `UserConfig.culture` and `.language` are `string | undefined` (`src/types.ts:27`, `:30`), and `location` and `googleRefreshToken` are `string`, with `''` when unset. None of them is validated on save (`app/api/settings/route.ts:48`, `:51`), so every comparison is strict (`'Jewish'` and `'HE'` don't match).
- `tzKnownFor` exists because `resolveUserTimezone` caches its `Asia/Jerusalem` fallback under the same key as a real answer (`src/lib/timezone.ts:78` vs `:35`). Without it, every location-less user would look Israeli. It mirrors the resolver's own `attemptedSource` (`timezone.ts:65`).
- **Intl at runtime:** none of the week data comes from Intl. Prod runs Node 22 (`package.json` engines `22.x`), which has only the `weekInfo` accessor. Node 24+ has `getWeekInfo()`. Node 26 dropped the accessor, and TypeScript 5.9's lib has neither. The one Intl call at runtime is `resolvedOptions().timeZone`, which maps old names to Intl's canonical name (Node 26: `Asia/Tel_Aviv` → `Asia/Jerusalem`, `US/Eastern` → `America/New_York`, `Universal` → `UTC`, but also `Asia/Kolkata` → `Asia/Calcutta`). That's why the table carries both spellings of a renamed zone, and why the lookup tries the name as given first and the canonical name second. On the production engine, Node 22.23.3 (ICU 78.3, the newest 22.x), `canon` gives the same four answers, and the smoke prints 19/19 with 1 SKIP (the Intl diff, Node 24+ only) under all three clocks. That run was made in the integration copy.
- **Country zone:** the spec says "not `Etc/*`, `UTC` or `GMT`, and accepted by `Intl`". The test is applied to both the name as given and its canonical name, so `Universal`, `Zulu` and `Etc/GMT` (canonical `UTC`) also go to the language rule. A name Intl rejects (`''`, `'Bogus/Zone'`, `'constructor'`) does too. The lookup uses `Object.hasOwn`, so `Object.prototype` keys can never match.
- **The table:** 160 zones: 145 Sunday, 14 Saturday, 1 Friday. That is tzdata `zone.tab`'s 154 non-Monday zones (macOS tzdata 2026c) under CLDR 48 `weekData.firstDay`, plus the 6 CLDR spellings Intl reports for renamed ones (`Asia/Calcutta`, `Asia/Katmandu`, `Asia/Rangoon`, `America/Coral_Harbour`, `America/Indianapolis`, `America/Louisville`). It was cross-checked on this machine against Node v26.11.1's Intl (ICU 78.3, CLDR 48.0, tzdata 2026a): every Intl zone and every table entry agree, with 0 differences. Intl's `1..7 = Mon..Sun` became `7 → 0`. `Asia/Hebron` and `Asia/Gaza` (Palestine, not listed in CLDR) are absent, so they start on Monday (§11).
- **Region enumeration in the smoke:** Intl has no list of regions, so the smoke tries every two-letter code and keeps those Intl doesn't remap (`new Intl.Locale('und-UK').region === 'GB'` is skipped, so deprecated codes such as SU, DD and NT don't double-count). On Node 26 that assigns 418 zones to countries, with no zone in two countries.

**Files:**
- Create: `src/utils/locale-rules.ts` (lines 1-108)
- Create: `src/config/week-start-zones.ts` (lines 1-178, generated table)
- Create (test): `scripts/smoke-locale-rules.ts` (lines 1-372)
- Test: `scripts/smoke-locale-rules.ts`, run under `TZ=UTC`, `TZ=Asia/Jerusalem` and `TZ=Pacific/Kiritimati`

**Interfaces:**
- Consumes:
  - `addDaysToDate(day: string, days: number): string` (`src/utils/day-events.ts:35-39`, unchanged)
  - `UserConfig` (`src/types.ts:22`, type only, in the smoke's compile-time check that a DB user fits `tzKnownFor`)
- Produces (`src/utils/locale-rules.ts`):
  - `export type WeekStart = 0 | 1 | 2 | 3 | 4 | 5 | 6;` (0 = Sunday, as `getUTCDay`)
  - `export type LocaleFacts = { culture?: string; language?: string; tz: string; tzKnown: boolean };`
  - `export const ISRAEL_ZONES: ReadonlySet<string>` (`'Asia/Jerusalem'`, `'Asia/Tel_Aviv'`, `'Israel'`)
  - `export function tzKnownFor(u: { location?: string | null; googleRefreshToken?: string | null }): boolean`
  - `export function legacyWeekStart(culture?: string): 0 | 1`
  - `export function weekStartFor(f: LocaleFacts): WeekStart`
  - `export function hebrewDatesFor(f: LocaleFacts): boolean`
  - `export function nextWeekBoundary(ws: WeekStart, always7: boolean | undefined, today: string): string` (This week's last day; Plan C passes `user.lookaheadAlways7Days`)
  - `export function nextWeekBoundaries(ws: WeekStart, today: string): { first: string; last: string }` (Next week)
- Produces (`src/config/week-start-zones.ts`):
  - `export const NON_MONDAY_ZONES: Readonly<Record<string, 0 | 5 | 6>>`
- Later consumers: B8's route computes `tzKnown = tzKnownFor(user)`, `weekStart = weekStartFor({ culture: user.culture, language: user.language, tz, tzKnown })` and `hebrewDates = hebrewDatesFor(...)` on the same facts. Plan C computes `ws = homeOn ? weekStartFor(...) : legacyWeekStart(user.culture)` and calls the two boundary functions. Import discipline: only server code imports this module, because the client must not bundle the zone table.

- [ ] **Step 1: Write the failing smoke `scripts/smoke-locale-rules.ts`**

Create `scripts/smoke-locale-rules.ts`:
```ts
// Smoke test for the week-start and Hebrew-date rules (spec §6): src/utils/locale-rules.ts
// and its zone table, src/config/week-start-zones.ts. This is the locale part of the
// spec's pure reader smoke.
//
// Today the bot's weeks have two shapes: Jewish culture runs Sunday to Saturday,
// everyone else Monday to Sunday (week-lookahead.ts:80-99 and :435-451). The new rule
// takes the week start from the country of the user's timezone, then the language, so a
// week can also start on Saturday (Egypt, Iran, ...) or Friday (the Maldives). The
// boundary functions take any week start and must give today's days for 0 and 1; the
// reference copies of today's functions below are what they are held to.
//
// Pure: no database, Redis, network or AI. Every input is a yyyy-MM-dd string, so the
// output must not depend on the server's timezone:
//   TZ=UTC npx tsx scripts/smoke-locale-rules.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-locale-rules.ts
//   TZ=Pacific/Kiritimati npx tsx scripts/smoke-locale-rules.ts

import {
  hebrewDatesFor,
  legacyWeekStart,
  nextWeekBoundaries,
  nextWeekBoundary,
  tzKnownFor,
  weekStartFor,
  type LocaleFacts,
  type WeekStart,
} from '../src/utils/locale-rules';
import { NON_MONDAY_ZONES } from '../src/config/week-start-zones';
import { addDaysToDate } from '../src/utils/day-events';
import type { UserConfig } from '../src/types';

type Result = { name: string; ok: boolean; skipped?: boolean; reason?: string };
const results: Result[] = [];

/** Thrown by a check that can't run on this Node; printed as SKIP, not counted as failed. */
class Skip extends Error {}

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    if (err instanceof Skip) results.push({ name, ok: true, skipped: true, reason: err.message });
    else results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
}

function assert(cond: boolean, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

function assertEqual<T>(got: T, want: T, label: string) {
  assert(JSON.stringify(got) === JSON.stringify(want), `${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

// ---- Today's functions, copied from src/services/week-lookahead.ts at main@858886c ----

function refWeekdayOf(day: string): number {
  return new Date(`${day}T00:00:00Z`).getUTCDay();
}

// week-lookahead.ts:80-99, getNextWeekBoundary
function refNextWeekBoundary(culture: string | undefined, always7Days: boolean | undefined, today: string): string {
  let daysUntilBoundary: number;

  if (always7Days) {
    daysUntilBoundary = 7;
  } else {
    const dayOfWeek = refWeekdayOf(today);

    if (culture === 'jewish') {
      daysUntilBoundary = (6 - dayOfWeek + 7) % 7;
    } else {
      daysUntilBoundary = (7 - dayOfWeek) % 7;
    }
  }

  return addDaysToDate(today, daysUntilBoundary);
}

// week-lookahead.ts:435-451, getNextWeekBoundaries
function refNextWeekBoundaries(culture: string | undefined, today: string): { first: string; last: string } {
  const dayOfWeek = refWeekdayOf(today);

  let daysUntilNextWeekStart: number;
  const weekLength: number = 7;

  if (culture === 'jewish') {
    daysUntilNextWeekStart = (7 - dayOfWeek) % 7 || 7;
  } else {
    daysUntilNextWeekStart = ((8 - dayOfWeek) % 7) || 7;
  }

  const first = addDaysToDate(today, daysUntilNextWeekStart);
  return { first, last: addDaysToDate(first, weekLength - 1) };
}

// ---- Fixtures ----

/** Two weeks in October 2026 (Sun 11th to Sat 24th), a year end, and a leap-day week. */
const DAYS: string[] = [
  ...Array.from({ length: 14 }, (_, i) => addDaysToDate('2026-10-11', i)),
  ...Array.from({ length: 14 }, (_, i) => addDaysToDate('2026-12-27', i)),
  ...Array.from({ length: 9 }, (_, i) => addDaysToDate('2028-02-25', i)),
];

const ALL_STARTS: WeekStart[] = [0, 1, 2, 3, 4, 5, 6];

/** Days from `a` to `b`, both yyyy-MM-dd. */
function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

const known = (tz: string, language: string, culture = 'default'): LocaleFacts => ({ culture, language, tz, tzKnown: true });
const unknown = (tz: string, language: string | undefined, culture = 'default'): LocaleFacts => ({ culture, language, tz, tzKnown: false });

/** Intl.Locale's week and zone methods (Node 24+); TypeScript's lib doesn't have them yet. */
type WeekLocale = Intl.Locale & {
  getWeekInfo?: () => { firstDay: number };
  getTimeZones?: () => string[] | undefined;
};

async function main() {
  // A fresh DB user row must fit tzKnownFor's parameter (compile-time check).
  const _acceptsUser: (u: Pick<UserConfig, 'location' | 'googleRefreshToken'>) => boolean = tzKnownFor;

  await check('tzKnownFor: a location or a Google token makes the timezone known', () => {
    assertEqual(tzKnownFor({ location: 'Haifa, Israel', googleRefreshToken: '' }), true, 'location');
    assertEqual(tzKnownFor({ location: '', googleRefreshToken: 'refresh-token' }), true, 'Google token');
    assertEqual(tzKnownFor({ location: '', googleRefreshToken: '' }), false, 'neither (empty strings)');
    assertEqual(tzKnownFor({ location: null, googleRefreshToken: null }), false, 'neither (null)');
    assertEqual(tzKnownFor({}), false, 'neither (absent)');
  });

  await check('legacyWeekStart: today\'s rule, jewish → Sunday, anything else → Monday', () => {
    assertEqual(legacyWeekStart('jewish'), 0, 'jewish');
    assertEqual(legacyWeekStart('default'), 1, 'default');
    assertEqual(legacyWeekStart(undefined), 1, 'undefined');
    assertEqual(legacyWeekStart('Jewish'), 1, 'compared strictly');
  });

  await check('weekStartFor: Jewish culture always starts on Sunday', () => {
    assertEqual(weekStartFor(known('Europe/London', 'en', 'jewish')), 0, 'London');
    assertEqual(weekStartFor(known('Africa/Cairo', 'ru', 'jewish')), 0, 'Cairo');
    assertEqual(weekStartFor(unknown('Asia/Jerusalem', 'ru', 'jewish')), 0, 'unknown timezone');
  });

  await check('weekStartFor: the country of a known timezone decides', () => {
    assertEqual(weekStartFor(known('Africa/Cairo', 'en')), 6, 'Cairo → Saturday');
    assertEqual(weekStartFor(known('Asia/Tehran', 'en')), 6, 'Tehran → Saturday');
    assertEqual(weekStartFor(known('Indian/Maldives', 'en')), 5, 'the Maldives → Friday');
    assertEqual(weekStartFor(known('America/New_York', 'ru')), 0, 'New York → Sunday, not Russian Monday');
    assertEqual(weekStartFor(known('Asia/Jerusalem', 'ru')), 0, 'Israel → Sunday');
    assertEqual(weekStartFor(known('Asia/Riyadh', 'en')), 0, 'Saudi Arabia → Sunday');
    assertEqual(weekStartFor(known('Europe/London', 'en')), 1, 'London → Monday, not English Sunday');
    assertEqual(weekStartFor(known('Europe/Moscow', 'he')), 1, 'Moscow → Monday, not Hebrew Sunday');
    assertEqual(weekStartFor(known('Asia/Dubai', 'he')), 1, 'the Emirates → Monday');
  });

  await check('weekStartFor: both Kolkata spellings, and Asia/Tel_Aviv through Intl\'s canonical name', () => {
    assertEqual(weekStartFor(known('Asia/Kolkata', 'ru')), 0, 'Asia/Kolkata');
    assertEqual(weekStartFor(known('Asia/Calcutta', 'ru')), 0, 'Asia/Calcutta');
    assert(!Object.hasOwn(NON_MONDAY_ZONES, 'Asia/Tel_Aviv'), 'Asia/Tel_Aviv is in the table, so this would not test the canonical lookup');
    assertEqual(weekStartFor(known('Asia/Tel_Aviv', 'ru')), 0, 'Asia/Tel_Aviv');
    assertEqual(weekStartFor(known('US/Eastern', 'ru')), 0, 'US/Eastern');
  });

  await check('weekStartFor: Asia/Hebron counts as Palestine → Monday, even in Hebrew', () => {
    assertEqual(weekStartFor(known('Asia/Hebron', 'he')), 1, 'Hebron');
    assertEqual(weekStartFor(known('Asia/Gaza', 'en')), 1, 'Gaza');
  });

  await check('weekStartFor: Etc/UTC and other non-country zones fall to the language rule', () => {
    for (const tz of ['Etc/UTC', 'UTC', 'GMT', 'Etc/GMT', 'Etc/GMT+5', 'Universal']) {
      assertEqual(weekStartFor(known(tz, 'he')), 0, `${tz} he`);
      assertEqual(weekStartFor(known(tz, 'en')), 0, `${tz} en`);
      assertEqual(weekStartFor(known(tz, 'ru')), 1, `${tz} ru`);
      assertEqual(weekStartFor(known(tz, 'fr')), 1, `${tz} fr`);
    }
  });

  await check('weekStartFor: a timezone Intl rejects falls to the language rule', () => {
    assertEqual(weekStartFor(known('Bogus/Zone', 'en')), 0, 'bogus en');
    assertEqual(weekStartFor(known('', 'en')), 0, 'empty en');
    assertEqual(weekStartFor(known('constructor', 'ru')), 1, 'an Object.prototype key');
    assertEqual(weekStartFor(known('toString', 'he')), 0, 'another Object.prototype key');
  });

  await check('weekStartFor: an unknown language → Monday', () => {
    assertEqual(weekStartFor(unknown('Asia/Jerusalem', 'fr')), 1, 'fr');
    assertEqual(weekStartFor(unknown('Asia/Jerusalem', 'HE')), 1, 'compared strictly');
    assertEqual(weekStartFor(unknown('Asia/Jerusalem', undefined)), 1, 'no language');
    assertEqual(weekStartFor(unknown('Asia/Jerusalem', '')), 1, 'empty language');
  });

  await check('weekStartFor: tzKnown false ignores the timezone (the Asia/Jerusalem fallback)', () => {
    assertEqual(weekStartFor(unknown('Asia/Jerusalem', 'he')), 0, 'he → Sunday');
    assertEqual(weekStartFor(unknown('Asia/Jerusalem', 'en')), 0, 'en → Sunday');
    assertEqual(weekStartFor(unknown('Asia/Jerusalem', 'ru')), 1, 'ru → Monday, not Israel\'s Sunday');
    assertEqual(weekStartFor(unknown('Africa/Cairo', 'ru')), 1, 'Cairo unknown → Russian Monday');
  });

  await check('hebrewDatesFor: Jewish culture, Hebrew language, or a known Israel timezone', () => {
    const cases: [LocaleFacts, boolean, string][] = [
      [known('Europe/London', 'en', 'jewish'), true, 'Jewish culture in London'],
      [unknown('Asia/Jerusalem', 'ru', 'jewish'), true, 'Jewish culture, timezone unknown'],
      [known('Europe/Berlin', 'he'), true, 'Hebrew in Berlin'],
      [unknown('Asia/Jerusalem', 'he'), true, 'Hebrew, timezone unknown'],
      [known('Asia/Jerusalem', 'ru'), true, 'Russian in Israel'],
      [known('Asia/Jerusalem', 'en'), true, 'English in Israel'],
      [known('Asia/Tel_Aviv', 'en'), true, 'Asia/Tel_Aviv'],
      [known('Israel', 'en'), true, 'Israel'],
      [unknown('Asia/Jerusalem', 'en'), false, 'English with the fallback timezone'],
      [unknown('Asia/Jerusalem', 'ru'), false, 'Russian with the fallback timezone'],
      [known('America/New_York', 'en'), false, 'English in New York'],
      [known('Europe/Moscow', 'ru'), false, 'Russian in Moscow'],
      [known('Asia/Hebron', 'en'), false, 'Hebron is not an Israel signal'],
      [known('Europe/London', 'en', 'Jewish'), false, 'culture compared strictly'],
      [known('Europe/London', 'HE'), false, 'language compared strictly'],
      [known('asia/jerusalem', 'en'), false, 'the Israel zones compared as given'],
    ];
    for (const [facts, want, label] of cases) assertEqual(hebrewDatesFor(facts), want, label);
  });

  await check('nextWeekBoundary equals today\'s getNextWeekBoundary for ws 0 and 1 on every weekday', () => {
    for (const day of DAYS) {
      for (const always7 of [true, false, undefined]) {
        assertEqual(nextWeekBoundary(0, always7, day), refNextWeekBoundary('jewish', always7, day), `ws 0 ${day} always7=${always7}`);
        assertEqual(nextWeekBoundary(1, always7, day), refNextWeekBoundary('default', always7, day), `ws 1 ${day} always7=${always7}`);
      }
    }
  });

  await check('nextWeekBoundaries equals today\'s getNextWeekBoundaries for ws 0 and 1 on every weekday', () => {
    for (const day of DAYS) {
      assertEqual(nextWeekBoundaries(0, day), refNextWeekBoundaries('jewish', day), `ws 0 ${day}`);
      assertEqual(nextWeekBoundaries(1, day), refNextWeekBoundaries('default', day), `ws 1 ${day}`);
    }
  });

  await check('legacyWeekStart fed to the boundaries gives today\'s days for any culture string', () => {
    for (const culture of ['jewish', 'default', undefined, 'Jewish', '']) {
      for (const day of DAYS) {
        assertEqual(nextWeekBoundaries(legacyWeekStart(culture), day), refNextWeekBoundaries(culture, day), `${culture} ${day}`);
        for (const always7 of [true, false, undefined]) {
          assertEqual(nextWeekBoundary(legacyWeekStart(culture), always7, day), refNextWeekBoundary(culture, always7, day), `${culture} ${day} ${always7}`);
        }
      }
    }
  });

  await check('ws 6 gives Saturday-to-Friday weeks', () => {
    // Wed 14 Oct 2026: this week ends Fri 16th; next week is Sat 17th to Fri 23rd.
    assertEqual(nextWeekBoundary(6, false, '2026-10-14'), '2026-10-16', 'this week from Wednesday');
    assertEqual(nextWeekBoundaries(6, '2026-10-14'), { first: '2026-10-17', last: '2026-10-23' }, 'next week from Wednesday');
    // Fri 16th is the week's last day: this week is just today; next week starts tomorrow.
    assertEqual(nextWeekBoundary(6, false, '2026-10-16'), '2026-10-16', 'this week from Friday');
    assertEqual(nextWeekBoundaries(6, '2026-10-16'), { first: '2026-10-17', last: '2026-10-23' }, 'next week from Friday');
    // Sat 17th is the first day: this week runs to Fri 23rd; next week is the one after.
    assertEqual(nextWeekBoundary(6, false, '2026-10-17'), '2026-10-23', 'this week from Saturday');
    assertEqual(nextWeekBoundaries(6, '2026-10-17'), { first: '2026-10-24', last: '2026-10-30' }, 'next week from Saturday');
    assertEqual(nextWeekBoundary(6, true, '2026-10-14'), '2026-10-21', 'always 7 days');
  });

  await check('ws 5 gives Friday-to-Thursday weeks', () => {
    assertEqual(nextWeekBoundary(5, false, '2026-10-14'), '2026-10-15', 'this week from Wednesday');
    assertEqual(nextWeekBoundaries(5, '2026-10-14'), { first: '2026-10-16', last: '2026-10-22' }, 'next week from Wednesday');
    assertEqual(nextWeekBoundary(5, false, '2026-10-15'), '2026-10-15', 'this week from Thursday');
    assertEqual(nextWeekBoundary(5, false, '2026-10-16'), '2026-10-22', 'this week from Friday');
    assertEqual(nextWeekBoundaries(5, '2026-10-16'), { first: '2026-10-23', last: '2026-10-29' }, 'next week from Friday');
  });

  await check('every week start: this week ends the day before a week start, next week is the following whole week', () => {
    for (const ws of ALL_STARTS) {
      for (const day of DAYS) {
        const end = nextWeekBoundary(ws, false, day);
        const toEnd = daysBetween(day, end);
        assert(toEnd >= 0 && toEnd <= 6, `ws ${ws} ${day}: this week ends ${toEnd} days on`);
        assertEqual(refWeekdayOf(end), (ws + 6) % 7, `ws ${ws} ${day}: this week's last weekday`);
        const { first, last } = nextWeekBoundaries(ws, day);
        assertEqual(refWeekdayOf(first), ws, `ws ${ws} ${day}: next week's first weekday`);
        assertEqual(first, addDaysToDate(end, 1), `ws ${ws} ${day}: next week starts the day after this week ends`);
        assertEqual(last, addDaysToDate(first, 6), `ws ${ws} ${day}: next week is 7 days`);
        assertEqual(nextWeekBoundary(ws, true, day), addDaysToDate(day, 7), `ws ${ws} ${day}: always 7 days`);
      }
    }
  });

  await check('NON_MONDAY_ZONES: Sunday, Saturday or Friday only, every name accepted by Intl, both spellings', () => {
    const bad: string[] = [];
    for (const [zone, day] of Object.entries(NON_MONDAY_ZONES)) {
      if (day !== 0 && day !== 5 && day !== 6) bad.push(`${zone}: ${day}`);
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: zone });
      } catch {
        bad.push(`${zone}: rejected by Intl`);
      }
    }
    assert(bad.length === 0, bad.join('; '));
    for (const [iana, cldr] of [
      ['Asia/Kolkata', 'Asia/Calcutta'],
      ['Asia/Kathmandu', 'Asia/Katmandu'],
      ['Asia/Yangon', 'Asia/Rangoon'],
      ['America/Atikokan', 'America/Coral_Harbour'],
      ['America/Indiana/Indianapolis', 'America/Indianapolis'],
      ['America/Kentucky/Louisville', 'America/Louisville'],
    ]) {
      assert(Object.hasOwn(NON_MONDAY_ZONES, iana) && Object.hasOwn(NON_MONDAY_ZONES, cldr), `${iana} / ${cldr}: a spelling is missing`);
    }
  });

  await check('NON_MONDAY_ZONES matches Intl\'s week data for every zone (Node 24 or newer)', () => {
    const probe = new Intl.Locale('und-US') as WeekLocale;
    if (typeof probe.getWeekInfo !== 'function' || typeof probe.getTimeZones !== 'function') {
      throw new Skip(`Node ${process.versions.node} has no Intl.Locale getWeekInfo/getTimeZones`);
    }
    // Every zone Intl assigns to a country, with that country's week start (0 = Sunday).
    const fromIntl = new Map<string, number>();
    const problems: string[] = [];
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    for (const a of letters) {
      for (const b of letters) {
        const region = a + b;
        const locale = new Intl.Locale(`und-${region}`) as WeekLocale;
        if (locale.region !== region) continue; // an old code Intl maps to a current one (UK → GB)
        const firstDay = locale.getWeekInfo!().firstDay % 7; // Intl counts 1 = Monday ... 7 = Sunday
        for (const zone of locale.getTimeZones!() ?? []) {
          const seen = fromIntl.get(zone);
          if (seen !== undefined && seen !== firstDay) problems.push(`${zone}: two countries, ${seen} and ${firstDay}`);
          fromIntl.set(zone, firstDay);
        }
      }
    }
    assert(fromIntl.size > 400, `Intl assigned only ${fromIntl.size} zones to countries`);
    for (const [zone, day] of fromIntl) {
      const listed = Object.hasOwn(NON_MONDAY_ZONES, zone) ? NON_MONDAY_ZONES[zone] : 1;
      if (listed !== day) problems.push(`${zone}: Intl ${day}, table ${listed}`);
      const ruled = weekStartFor({ language: 'xx', tz: zone, tzKnown: true });
      if (ruled !== day) problems.push(`${zone}: weekStartFor ${ruled}, Intl ${day}`);
    }
    for (const [zone, day] of Object.entries(NON_MONDAY_ZONES)) {
      const canonical = new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone;
      const intlDay = fromIntl.get(zone) ?? fromIntl.get(canonical);
      if (intlDay !== day) problems.push(`${zone} (${canonical}): table ${day}, Intl ${intlDay ?? 'no country'}`);
    }
    assert(
      problems.length === 0,
      `ICU ${process.versions.icu}, CLDR ${process.versions.cldr ?? '?'}, tz ${process.versions.tz ?? '?'}: ${problems.join('; ')}`,
    );
  });

  let failed = 0;
  let skipped = 0;
  for (const r of results) {
    if (r.skipped) {
      skipped++;
      console.log(`SKIP  ${r.name} — ${r.reason}`);
      continue;
    }
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(
    `\n${results.length - failed}/${results.length} passed${skipped ? ` (${skipped} skipped)` : ''} (process TZ=${process.env.TZ ?? 'unset'})`,
  );
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Run the smoke and see it fail**

Run:
```bash
TZ=UTC DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-locale-rules.ts; echo "exit=$?"
```
Expected: FAIL. The module doesn't exist yet:
```
Error: Cannot find module '../src/utils/locale-rules'
exit=1
```

- [ ] **Step 3: Create the zone table `src/config/week-start-zones.ts`**

Create `src/config/week-start-zones.ts` with exactly this content (generated, so don't reorder or reformat by hand):
```ts
// Generated; do not edit.
//
// Time zones whose country's week does not start on Monday, as 0 = Sunday, 6 = Saturday
// and 5 = Friday (Date.getUTCDay's numbering). A zone that isn't listed starts on Monday.
//
// Built once from tzdata's zone.tab (zone to country) and CLDR 48 weekData firstDay
// (country to day), with both spellings of a renamed zone: IANA's (Asia/Kolkata) and the
// one Intl reports (Asia/Calcutta). Cross-checked against Node 26's Intl (ICU 78.3, CLDR
// 48, tzdata 2026a) with no difference. scripts/smoke-locale-rules.ts rebuilds it from
// Intl on Node 24 or newer and lists every zone that differs.
//
// Read by weekStartFor in src/utils/locale-rules.ts, on the server only.

export const NON_MONDAY_ZONES: Readonly<Record<string, 0 | 5 | 6>> = {
  // Sunday (145)
  'Africa/Addis_Ababa': 0,
  'Africa/Gaborone': 0,
  'Africa/Harare': 0,
  'Africa/Johannesburg': 0,
  'Africa/Maputo': 0,
  'Africa/Nairobi': 0,
  'America/Adak': 0,
  'America/Anchorage': 0,
  'America/Antigua': 0,
  'America/Araguaina': 0,
  'America/Asuncion': 0,
  'America/Atikokan': 0,
  'America/Bahia': 0,
  'America/Bahia_Banderas': 0,
  'America/Belem': 0,
  'America/Belize': 0,
  'America/Blanc-Sablon': 0,
  'America/Boa_Vista': 0,
  'America/Bogota': 0,
  'America/Boise': 0,
  'America/Cambridge_Bay': 0,
  'America/Campo_Grande': 0,
  'America/Cancun': 0,
  'America/Caracas': 0,
  'America/Chicago': 0,
  'America/Chihuahua': 0,
  'America/Ciudad_Juarez': 0,
  'America/Coral_Harbour': 0,
  'America/Creston': 0,
  'America/Cuiaba': 0,
  'America/Dawson': 0,
  'America/Dawson_Creek': 0,
  'America/Denver': 0,
  'America/Detroit': 0,
  'America/Dominica': 0,
  'America/Edmonton': 0,
  'America/Eirunepe': 0,
  'America/El_Salvador': 0,
  'America/Fort_Nelson': 0,
  'America/Fortaleza': 0,
  'America/Glace_Bay': 0,
  'America/Goose_Bay': 0,
  'America/Guatemala': 0,
  'America/Halifax': 0,
  'America/Hermosillo': 0,
  'America/Indiana/Indianapolis': 0,
  'America/Indiana/Knox': 0,
  'America/Indiana/Marengo': 0,
  'America/Indiana/Petersburg': 0,
  'America/Indiana/Tell_City': 0,
  'America/Indiana/Vevay': 0,
  'America/Indiana/Vincennes': 0,
  'America/Indiana/Winamac': 0,
  'America/Indianapolis': 0,
  'America/Inuvik': 0,
  'America/Iqaluit': 0,
  'America/Jamaica': 0,
  'America/Juneau': 0,
  'America/Kentucky/Louisville': 0,
  'America/Kentucky/Monticello': 0,
  'America/Lima': 0,
  'America/Los_Angeles': 0,
  'America/Louisville': 0,
  'America/Maceio': 0,
  'America/Managua': 0,
  'America/Manaus': 0,
  'America/Matamoros': 0,
  'America/Mazatlan': 0,
  'America/Menominee': 0,
  'America/Merida': 0,
  'America/Metlakatla': 0,
  'America/Mexico_City': 0,
  'America/Moncton': 0,
  'America/Monterrey': 0,
  'America/Nassau': 0,
  'America/New_York': 0,
  'America/Nome': 0,
  'America/Noronha': 0,
  'America/North_Dakota/Beulah': 0,
  'America/North_Dakota/Center': 0,
  'America/North_Dakota/New_Salem': 0,
  'America/Ojinaga': 0,
  'America/Panama': 0,
  'America/Phoenix': 0,
  'America/Port_of_Spain': 0,
  'America/Porto_Velho': 0,
  'America/Puerto_Rico': 0,
  'America/Rankin_Inlet': 0,
  'America/Recife': 0,
  'America/Regina': 0,
  'America/Resolute': 0,
  'America/Rio_Branco': 0,
  'America/Santarem': 0,
  'America/Santo_Domingo': 0,
  'America/Sao_Paulo': 0,
  'America/Sitka': 0,
  'America/St_Johns': 0,
  'America/St_Thomas': 0,
  'America/Swift_Current': 0,
  'America/Tegucigalpa': 0,
  'America/Tijuana': 0,
  'America/Toronto': 0,
  'America/Vancouver': 0,
  'America/Whitehorse': 0,
  'America/Winnipeg': 0,
  'America/Yakutat': 0,
  'Asia/Aden': 0,
  'Asia/Bangkok': 0,
  'Asia/Calcutta': 0,
  'Asia/Dhaka': 0,
  'Asia/Hong_Kong': 0,
  'Asia/Jakarta': 0,
  'Asia/Jayapura': 0,
  'Asia/Jerusalem': 0,
  'Asia/Karachi': 0,
  'Asia/Kathmandu': 0,
  'Asia/Katmandu': 0,
  'Asia/Kolkata': 0,
  'Asia/Macau': 0,
  'Asia/Makassar': 0,
  'Asia/Manila': 0,
  'Asia/Phnom_Penh': 0,
  'Asia/Pontianak': 0,
  'Asia/Rangoon': 0,
  'Asia/Riyadh': 0,
  'Asia/Seoul': 0,
  'Asia/Singapore': 0,
  'Asia/Taipei': 0,
  'Asia/Thimphu': 0,
  'Asia/Tokyo': 0,
  'Asia/Vientiane': 0,
  'Asia/Yangon': 0,
  'Atlantic/Azores': 0,
  'Atlantic/Madeira': 0,
  'Atlantic/Reykjavik': 0,
  'Europe/Lisbon': 0,
  'Europe/Malta': 0,
  'Pacific/Apia': 0,
  'Pacific/Guam': 0,
  'Pacific/Honolulu': 0,
  'Pacific/Kwajalein': 0,
  'Pacific/Majuro': 0,
  'Pacific/Midway': 0,
  'Pacific/Pago_Pago': 0,
  'Pacific/Wake': 0,
  // Saturday (14)
  'Africa/Algiers': 6,
  'Africa/Cairo': 6,
  'Africa/Djibouti': 6,
  'Africa/Khartoum': 6,
  'Africa/Tripoli': 6,
  'Asia/Amman': 6,
  'Asia/Baghdad': 6,
  'Asia/Bahrain': 6,
  'Asia/Damascus': 6,
  'Asia/Kabul': 6,
  'Asia/Kuwait': 6,
  'Asia/Muscat': 6,
  'Asia/Qatar': 6,
  'Asia/Tehran': 6,
  // Friday (1)
  'Indian/Maldives': 5,
};
```

- [ ] **Step 4: Create the rules `src/utils/locale-rules.ts`**

Create `src/utils/locale-rules.ts`:
```ts
/**
 * Week start and Hebrew dates (spec §6), plus the bot's week boundaries for any week
 * start.
 *
 * Pure: no Prisma, Redis or network, and no Intl week data at runtime (Node 22 and newer
 * Node expose it through different APIs). Server-only by import discipline: the zone table
 * stays off the client, which receives a week-start number and a boolean.
 *
 * Culture and language are not validated when saved, so they are compared strictly.
 */

import { NON_MONDAY_ZONES } from '../config/week-start-zones';
import { addDaysToDate } from './day-events';

/** A week's first day: 0 = Sunday ... 6 = Saturday, as Date.getUTCDay counts. */
export type WeekStart = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/**
 * What the rules decide from: the user's culture and language, the timezone from
 * resolveUserTimezone, and whether that timezone came from the user (tzKnownFor).
 */
export type LocaleFacts = { culture?: string; language?: string; tz: string; tzKnown: boolean };

/** Israel's zone and its old spellings, compared as given. */
export const ISRAEL_ZONES: ReadonlySet<string> = new Set(['Asia/Jerusalem', 'Asia/Tel_Aviv', 'Israel']);

/**
 * Whether the user's timezone comes from them (a location, or Google's settings) rather
 * than the Asia/Jerusalem fallback. resolveUserTimezone caches the fallback like a real
 * answer, so the timezone alone can't tell.
 */
export function tzKnownFor(u: { location?: string | null; googleRefreshToken?: string | null }): boolean {
  return !!u.location || !!u.googleRefreshToken;
}

/** Today's rule for the bot's weeks: Jewish culture starts on Sunday, everyone else on Monday. */
export function legacyWeekStart(culture?: string): 0 | 1 {
  return culture === 'jewish' ? 0 : 1;
}

/** Intl's name for a zone (Asia/Tel_Aviv → Asia/Jerusalem), or null when Intl rejects it. */
function canonicalZone(tz: string): string | null {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** UTC, GMT and Etc/*: zones with no country. */
function isCountrylessZone(zone: string): boolean {
  return zone === 'UTC' || zone === 'GMT' || zone.startsWith('Etc/');
}

function listedStart(zone: string): WeekStart | undefined {
  return Object.hasOwn(NON_MONDAY_ZONES, zone) ? NON_MONDAY_ZONES[zone] : undefined;
}

/**
 * The user's week start, in this order:
 * 1. Jewish culture → Sunday.
 * 2. A known timezone of a country → that country's week start (Monday unless listed).
 * 3. The language: Hebrew and English → Sunday, Russian → Monday.
 * 4. Anything else → Monday.
 */
export function weekStartFor(f: LocaleFacts): WeekStart {
  if (f.culture === 'jewish') return 0;
  if (f.tzKnown && f.tz) {
    const canonical = canonicalZone(f.tz);
    if (canonical !== null && !isCountrylessZone(f.tz) && !isCountrylessZone(canonical)) {
      return listedStart(f.tz) ?? listedStart(canonical) ?? 1;
    }
  }
  if (f.language === 'he' || f.language === 'en') return 0;
  if (f.language === 'ru') return 1;
  return 1;
}

/** Hebrew dates for Jewish culture, the Hebrew language, or a known Israel timezone. */
export function hebrewDatesFor(f: LocaleFacts): boolean {
  return f.culture === 'jewish' || f.language === 'he' || (f.tzKnown && ISRAEL_ZONES.has(f.tz));
}

/** Day of the week of yyyy-MM-dd, 0 = Sunday. */
function weekdayOf(day: string): number {
  return new Date(`${day}T00:00:00Z`).getUTCDay();
}

/**
 * This week's last day (yyyy-MM-dd) for weeks starting on `ws`: the day before the next
 * week start, which is today on the week's last day. With `always7`, 7 days from today.
 * `today` is the user's day (a DayKey). For ws 0 and 1 this is week-lookahead.ts's
 * getNextWeekBoundary for Jewish and default culture.
 */
export function nextWeekBoundary(ws: WeekStart, always7: boolean | undefined, today: string): string {
  const daysUntilBoundary = always7 ? 7 : (((ws + 6) % 7) - weekdayOf(today) + 7) % 7;
  return addDaysToDate(today, daysUntilBoundary);
}

/**
 * Next week's first and last days (yyyy-MM-dd) for weeks starting on `ws`: the next week
 * start after today (a week on when today is one) and the 6 days after it. For ws 0 and 1
 * this is week-lookahead.ts's getNextWeekBoundaries for Jewish and default culture.
 */
export function nextWeekBoundaries(ws: WeekStart, today: string): { first: string; last: string } {
  const first = addDaysToDate(today, ((ws - weekdayOf(today) + 7) % 7) || 7);
  return { first, last: addDaysToDate(first, 6) };
}
```

- [ ] **Step 5: Run the smoke under three clocks and see it pass**

Run:
```bash
for tz in UTC Asia/Jerusalem Pacific/Kiritimati; do
  TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-locale-rules.ts; echo "TZ=$tz exit=$?"
done
```
Expected: each run ends with `19/19 passed (process TZ=<tz>)` and `exit=0`, and every line is `OK`, including the last one:
```
OK  NON_MONDAY_ZONES matches Intl's week data for every zone (Node 24 or newer)
```
On a Node without `Intl.Locale.prototype.getWeekInfo` (Node 22, the prod engine), that line reads `SKIP  … — Node 22.x has no Intl.Locale getWeekInfo/getTimeZones` and the total reads `19/19 passed (1 skipped)`, still `exit=0`. If the Intl check FAILs on a newer Node, its message lists every zone that differs, with the ICU, CLDR and tz versions. That means CLDR or tzdata moved: regenerate the table from them. Don't edit single entries.

- [ ] **Step 6: Type-check and lint**

Run:
```bash
npx tsc --noEmit -p .; echo "tsc exit=$?"
npm run -s lint; echo "lint exit=$?"
```
Expected: `tsc exit=0`; `lint exit=0` with no warnings in the three new files (`npx eslint --max-warnings 0 src/utils/locale-rules.ts src/config/week-start-zones.ts scripts/smoke-locale-rules.ts` exits 0).

- [ ] **Step 7: Commit**

```bash
git add src/utils/locale-rules.ts src/config/week-start-zones.ts scripts/smoke-locale-rules.ts
git commit -m "$(cat <<'MSG'
feat(locale): week start by country, the Hebrew-date rule and week boundaries for any start

Pure rules for the calendar home (spec §6), unused until the reader and the
summaries call them. weekStartFor: Jewish culture, then a known timezone's
country (generated CLDR 48 table, both spellings of renamed zones), then the
language. hebrewDatesFor: Jewish culture, Hebrew, or a known Israel zone.
nextWeekBoundary / nextWeekBoundaries take any week start and match today's
week-lookahead functions for legacyWeekStart. smoke-locale-rules checks the
table against Intl on Node 24+.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
MSG
)"
```

---

### Task 3 (B3): Reader types, the home's DTO and its day buckets

**What and why.** The shared reader and the range route need one set of types, and the home needs its wire format: the spec §4 DTO, built from the reader's items by pure code. This task adds:
- the client-safe DTO types and `compareItems` (`src/lib/calendar-view/types.ts`);
- the reader's server types (`src/services/calendar-read/types.ts`, spec §2.2);
- `src/services/calendar-read/dto.ts`, which buckets items into days with `daySpanOf` (the summaries' rule, through `shapeEventsForDay`), marks today's open reminders and builds the item, carry-over and legend DTOs.

`dto.ts` must stay free of Prisma. So `reminderDueAt` moves into the leaf `src/services/native-reminders/due.ts`, and `open-reminders.ts` re-exports it (edit 9, first half). Nothing calls the new code yet (B8 does), so nothing a user sees changes. The rollout switch is still `OFF`.

**Interface change:** none. The B3 signatures in the split hold as written. The parameters the split left open are settled as follows:
- `toItemDto(item, span: DaySpan | null, opts: ItemDtoOptions)` with `ItemDtoOptions = { now: Date; open: boolean; openSince: DayKey | null }`;
- `toCarryOverDto(item: ReadItem, tz: string, now: Date): ItemDTO`. A carry-over is passed in as a `ReadItem`;
- `isOpenOnDay` is exported as well.

**Findings (read before you start):**
- `src/services/native-reminders/due.ts` already exists, and it's a leaf. It imports only `date-fns-tz`, `config/constants` (which imports only `./ai-models`, and that file has no imports) and `utils/day-events`. Its private `morningOf(day, tz)` is exactly the `` fromZonedTime(`${day} 09:00:00`, tz) `` that `reminderDueAt` builds today (`open-reminders.ts:36`). So the moved function returns the same values. The move needs only a type import from `../../types`, which is erased at compile time.
- `reminderDueAt` has no importers outside `open-reminders.ts` (`git grep -n reminderDueAt`: only `:34`, `:62`, `:103`). `smoke-native-reminder-edit.ts:230` stubs the whole `open-reminders.ts` module, and none of its consumers read `reminderDueAt` from it. So the re-export is only there for future callers.
- `daySpanOf` (`src/utils/day-events.ts:58-86`) returns `undefined` when an item is wholly inside the day, a `DaySpan` when it crosses an edge, and `null` when the item isn't on that day. `toRangeDays` asks it only about each item's candidate days, from the day before its local start to the day after its local end. For an all-day item, the candidates are its dates. That superset leaves the decision with `daySpanOf`, so the home equals `shapeEventsForDay` by construction. The smoke proves it on the §10 fixtures, and mutating the candidate window makes the parity checks fail.
- `daySpanOf` returns `undefined` for an item with no `start`, so `shapeEventsForDay` would list it on every day. `toRangeDays` drops such items (spec §2.3: "an item without a start is dropped"; `readRange` drops them first).
- A day's items are sorted with `compareItems`, while `shapeEventsForDay` keeps input order. The parity check therefore compares each day's `id:span` lists after sorting both sides, then checks that each day is in `compareItems` order.
- FamCal one-offs have no `event.instanceStartsAt` (`native-provider.ts:111`). `ReadItem.originalStart` carries the occurrence (B5 sets it for days; B8 sets it for carry-overs), and the DTO copies it unchanged.
- **Decisions this task makes** (the spec doesn't decide them; record them in the PR):
  1. `reminder.snoozedUntil` is sent only while the snooze is still running (`> now`). This matches `ReminderInfo.snoozed` (`native-provider.ts:134`). Otherwise the Agenda's "until <time>" badge could show a time that has passed. A snoozed reminder is still open either way.
  2. `compareItems` compares titles by code unit, never `localeCompare`, so the server's and the client's ICU can't disagree. The key breaks any remaining tie, so the order is total and two sorts of the same items always agree.
  3. `ItemDTO.calendar.id` is `null` whenever `inLegend` is false, whatever the ref says. This is a second guard behind B5's masking. The DTO is built field by field and never reads `event.calendarName` or `event.calendarId`.
  4. `location` and `description` send `null` for an empty string as well.
  5. `ItemDTO.id` is `event.eventId`, falling back to the item's `key`. Both readers always set `eventId`, so the fallback only keeps the type a plain `string`.
  6. `toCalendarDto` throws on a masked ref (`id: null`), because only legend refs are legend entries. B8 maps `FamcalRead.calendars` and `GoogleRead.calendars`, which hold legend refs only.
- **For B5 and B8:**
  - A carry-over reaches `toCarryOverDto` as a `ReadItem` with:
    - `source: 'famcal'` and `kind: 'reminder'`;
    - `key: 'famcal|' + event.eventId`;
    - `originalStart` set to the occurrence's `instanceStartsAt` ISO;
    - `calendar` masked by the legend rule;
    - `state` from its state row.
  - `openSince` comes from `event.reminder.openSince` (`selectOpenReminders` sets it, `open-reminders.ts:112`). When that is missing, it falls back to the local date of `reminderDueAt`.
- **Plan A overlap:** none. Plan A widens the carry-over query in `fetchOpenReminders`, below this task's lines (`:12`, `:22`, `:29-37`), which it leaves as they are on main@858886c.
- **One `WeekStart`.** B2's `src/utils/locale-rules.ts` defines `WeekStart` for the server, and this task's client-safe `src/lib/calendar-view/types.ts` needs the same type for `RangeResponse.weekStart`. Step 3 makes B2's a re-export of this one. Client code (Plans D and E) imports it from `calendar-view/types` only: `locale-rules.ts` pulls in the zone table.
- The working tree may show plan or spec files as modified. They aren't part of this task: stage only the seven paths in Step 10.

**Files:**
- Create: `src/lib/calendar-view/types.ts` (DTO types, `DayKey`, `SourceName`, `compareItems`; no imports, client-safe)
- Create: `src/services/calendar-read/types.ts` (spec §2.2 types only)
- Create: `src/services/calendar-read/dto.ts` (`toRangeDays`, `toItemDto`, `toCarryOverDto`, `toCalendarDto`, `isOpenOnDay`)
- Modify: `src/services/native-reminders/due.ts:4-6` (one type import), insert after `:33` (`reminderDueAt`)
- Modify: `src/services/native-reminders/open-reminders.ts:12` (drop the `fromZonedTime` import), `:22` (import `reminderDueAt` from `./due` and re-export it), `:29-37` (remove the old definition)
- Modify: `src/utils/locale-rules.ts:12-16` (B2's file): `WeekStart` becomes a re-export of `calendar-view/types`' one
- Create (test): `scripts/smoke-calendar-dto.ts`
- Test: `scripts/smoke-calendar-dto.ts` under TZ=UTC, Asia/Jerusalem and Pacific/Kiritimati. Regression: `scripts/smoke-native-reminder-digest.ts`, `smoke-native-reminders.ts`, `smoke-native-reminder-edit.ts`, `smoke-day-shaping.ts`, `smoke-native-provider-reminders.ts`, `smoke-reminders.ts`, `smoke-week-lookahead.ts` (all unchanged)

**Interfaces:**
- Consumes:
  - `daySpanOf(event: CalendarEvent, day: string, timezone: string): DaySpan | undefined | null`, `localDate(date: Date, timezone: string): string`, `nextDate(day: string): string`, `addDaysToDate(day: string, days: number): string` (`src/utils/day-events.ts`)
  - `UnifiedEvent` (`src/services/calendar-provider/types.ts:16-21`), `ViewerContext` (`src/services/native-reminders/ownership.ts:28-31`), `CalendarEvent`, `ReminderInfo`, `DaySpan` (`src/types.ts:75-119`)
- Produces (binding for B4–B8 and Plans C–E):
  - `src/lib/calendar-view/types.ts`:
    - `type DayKey = string`, `type SourceName = 'famcal' | 'google'`, `type WeekStart = 0|1|2|3|4|5|6` (the only definition: `locale-rules.ts` re-exports it), `type ItemSpan = 'endsLater' | 'continues' | 'spansDay'`, `type GoogleStatusReason`;
    - `interface RangeResponse`, `CalendarDTO`, `ItemDTO`, `ItemCalendarDTO`, `ItemReminderDTO`, exactly as in spec §4 (the sub-objects get names; the shapes are the same);
    - `function compareItems(a: ItemDTO, b: ItemDTO): number`.
  - `src/services/calendar-read/types.ts`: re-exports `DayKey` and `SourceName`; defines `CalendarRef`, `ReadItem`, `ReadRangeOptions` (with `defer?: (task: () => Promise<void>) => void`), `FamcalRead`, `GoogleRead` and `RangeRead`, as in spec §2.2.
  - `src/services/calendar-read/dto.ts`:
    - `interface ItemDtoOptions { now: Date; open: boolean; openSince: DayKey | null }`
    - `toItemDto(item: ReadItem, span: DaySpan | null, opts: ItemDtoOptions): ItemDTO`
    - `isOpenOnDay(item: ReadItem, day: DayKey, today: DayKey, tz: string, now: Date): boolean`
    - `toRangeDays(items: ReadItem[], fromKey: DayKey, toKey: DayKey, tz: string, now: Date, today: DayKey): { date: DayKey; items: ItemDTO[] }[]`
    - `toCarryOverDto(item: ReadItem, tz: string, now: Date): ItemDTO`
    - `toCalendarDto(ref: CalendarRef): CalendarDTO` (throws on `id: null`)
  - `src/services/native-reminders/due.ts`: `reminderDueAt(event: Pick<CalendarEvent, 'start'>, timezone: string): Date`. `open-reminders.ts` re-exports the same function.

- [ ] **Step 1: Write the failing smoke `scripts/smoke-calendar-dto.ts`**

```ts
// Smoke test for the calendar home's DTO layer (spec §4, §10): the day buckets and item
// DTOs in src/services/calendar-read/dto.ts, compareItems in
// src/lib/calendar-view/types.ts, and reminderDueAt's move to the leaf
// src/services/native-reminders/due.ts. A day on the home must list exactly what the
// same day's summary lists (shapeEventsForDay), with the same spans, on overnight,
// multi-day, zero-length and DST fixtures. The JSON never carries a masked calendar's
// real name or id. Pure: no network, no database, no Redis.
//
// Run under three clocks; the output must not depend on the server's timezone:
//   TZ=UTC npx tsx scripts/smoke-calendar-dto.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-calendar-dto.ts
//   TZ=Pacific/Kiritimati npx tsx scripts/smoke-calendar-dto.ts

import path from 'path';
import { fromZonedTime } from 'date-fns-tz';
import { nextDate, shapeEventsForDay } from '../src/utils/day-events';
import { compareItems, type ItemDTO } from '../src/lib/calendar-view/types';
import { isOpenOnDay, toCalendarDto, toCarryOverDto, toItemDto, toRangeDays } from '../src/services/calendar-read/dto';
import { reminderDueAt } from '../src/services/native-reminders/due';
import type { CalendarRef, ReadItem } from '../src/services/calendar-read/types';
import type { UnifiedEvent } from '../src/services/calendar-provider/types';
import type { ReminderInfo } from '../src/types';

// What the static imports above loaded, before anything below can load more.
const LOADED_BY_DTO = Object.keys(require.cache);

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

function assertList(got: string[], want: string[], label = '') {
  assert(
    JSON.stringify(got) === JSON.stringify(want),
    `${label}\n     got  ${JSON.stringify(got, null, 1)}\n     want ${JSON.stringify(want, null, 1)}`
  );
}

const IL = 'Asia/Jerusalem';
const NY = 'America/New_York';
const SCL = 'America/Santiago';

/** A FamCal timed value: the UTC ISO string of a local wall time. */
const utc = (local: string, tz: string) => fromZonedTime(local, tz).toISOString();

// ---- Fixture builders ----

const OWN_CAL: CalendarRef = { id: 'native:cal-own', source: 'famcal', name: 'Raziel', color: '#039BE5', mine: true, inLegend: true };
const NOA_SHARED: CalendarRef = { id: 'native:cal-noa', source: 'famcal', name: 'Noa family', color: '#E67C73', mine: false, ownerName: 'Noa', inLegend: true };
const MASKED: CalendarRef = { id: null, source: 'famcal', name: 'Noa', color: null, mine: false, inLegend: false };
const GOOGLE_CAL: CalendarRef = { id: 'family@group.calendar.google.com', source: 'google', name: 'Family', color: '#7986CB', mine: true, inLegend: true };

type FamcalExtra = {
  kind?: 'event' | 'reminder';
  rrule?: string | null;
  state?: { doneAt: Date | null; snoozedUntil: Date | null };
  reminder?: ReminderInfo;
  tz?: string;
  calendar?: CalendarRef;
  calendarName?: string;
  calendarId?: string;
  originalStart?: string | null;
  description?: string;
  location?: string;
};

/** A FamCal ReadItem as readFamcal builds one: the provider's event plus the series facts. */
function famcal(eventId: string, title: string, start: string, end: string, extra: FamcalExtra = {}): ReadItem {
  const kind = extra.kind ?? 'event';
  const seriesId = eventId.split('#')[0];
  const event: UnifiedEvent = {
    summary: title,
    start,
    end,
    description: extra.description,
    location: extra.location,
    calendarName: extra.calendarName ?? (extra.calendar ?? OWN_CAL).name,
    calendarId: extra.calendarId ?? (extra.calendar ?? OWN_CAL).id ?? 'native:cal-own',
    eventType: kind === 'reminder' ? 'reminder' : undefined,
    recurringEventId: eventId.includes('#') ? seriesId : undefined,
    eventId,
    provider: 'native',
    instanceStartsAt: eventId.includes('#') ? eventId.split('#')[1] : undefined,
    timeZone: extra.tz ?? IL,
    ...(kind === 'reminder' ? { reminder: extra.reminder ?? { ownerIsViewer: true, creatorIsViewer: true } } : {}),
  };
  return {
    source: 'famcal',
    key: `famcal|${eventId}`,
    event,
    calendar: extra.calendar ?? OWN_CAL,
    title,
    kind,
    seriesId,
    originalStart: extra.originalStart !== undefined ? extra.originalStart : start.includes('T') ? start : null,
    recurring: !!extra.rrule,
    rrule: extra.rrule ?? null,
    ...(extra.state ? { state: extra.state } : {}),
  };
}

/** A Google ReadItem as mapGoogleEvent builds one (RFC 3339 times with the offset, or dates). */
function google(id: string, title: string | null, start: string, end: string, extra: { birthday?: boolean; htmlLink?: string | null } = {}): ReadItem {
  const event: UnifiedEvent = {
    summary: title ?? 'No title',
    start,
    end,
    calendarName: GOOGLE_CAL.name,
    calendarId: GOOGLE_CAL.id ?? '',
    eventType: extra.birthday ? 'birthday' : 'default',
    eventId: id,
    provider: 'google',
  };
  return {
    source: 'google',
    key: `google|${GOOGLE_CAL.id}|${id}`,
    event,
    calendar: GOOGLE_CAL,
    title,
    kind: 'event',
    seriesId: null,
    originalStart: null,
    recurring: false,
    rrule: null,
    google: { birthday: !!extra.birthday, htmlLink: extra.htmlLink ?? `https://www.google.com/calendar/event?eid=${id}` },
  };
}

const reminder = (eventId: string, title: string, at: string, extra: FamcalExtra = {}) =>
  famcal(eventId, title, at, at.includes('T') ? at : nextDate(at), { kind: 'reminder', ...extra });

// The clock the open marks are read at: Friday 16 October 2026, 10:30 in Israel.
const NOW = fromZonedTime('2026-10-16 10:30:00', IL);
const TODAY = '2026-10-16';

/** Each day as `id:span` ('-' within the day), in the DTO's order. */
function dayView(days: { date: string; items: ItemDTO[] }[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const day of days) out[day.date] = day.items.map(i => `${i.id}:${i.span ?? '-'}`);
  return out;
}

function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d < to; d = nextDate(d)) out.push(d);
  return out;
}

/**
 * toRangeDays against shapeEventsForDay, day by day: the same items with the same
 * spans (compared after sorting both, since a DTO day is sorted with compareItems),
 * every day present, and each day in compareItems order. Then the expected view.
 */
async function parity(name: string, items: ReadItem[], from: string, to: string, tz: string, want: Record<string, string[]>) {
  await check(`parity: ${name}`, () => {
    const days = toRangeDays(items, from, to, tz, NOW, TODAY);
    assertList(days.map(d => d.date), daysBetween(from, to), 'days');
    for (const day of days) {
      const expected = shapeEventsForDay(items.map(i => i.event), day.date, tz).map(e => `${e.eventId}:${e.daySpan ?? '-'}`).sort();
      const got = day.items.map(i => `${i.id}:${i.span ?? '-'}`).sort();
      assertList(got, expected, `${day.date} vs shapeEventsForDay`);
      for (let k = 1; k < day.items.length; k++) {
        assert(compareItems(day.items[k - 1], day.items[k]) < 0, `${day.date}: ${day.items[k - 1].id} before ${day.items[k].id} breaks compareItems`);
      }
    }
    const view = dayView(days);
    for (const date of Object.keys(want)) assertList(view[date] ?? [], want[date], date);
  });
}

async function main() {
  // ---- The module graph ----

  await check('dto.ts, calendar-view/types.ts and due.ts load no Prisma', () => {
    const prismaModules = LOADED_BY_DTO.filter(p => /[\\/]@prisma[\\/]|[\\/]\.prisma[\\/]|[\\/]src[\\/]utils[\\/]prisma\./.test(p));
    assert(LOADED_BY_DTO.some(p => p.endsWith(path.join('calendar-read', 'dto.ts'))), 'dto.ts not in require.cache: the check would be empty');
    assertList(prismaModules, []);
  });

  await check('reminderDueAt: a timed reminder is due at its time, a date-only one at 09:00 in the viewer\'s timezone', () => {
    assert(reminderDueAt({ start: '2026-10-16T05:00:00.000Z' }, IL).toISOString() === '2026-10-16T05:00:00.000Z', 'timed');
    assert(reminderDueAt({ start: '2026-10-16' }, IL).toISOString() === '2026-10-16T06:00:00.000Z', `IL ${reminderDueAt({ start: '2026-10-16' }, IL).toISOString()}`);
    assert(reminderDueAt({ start: '2026-10-16' }, NY).toISOString() === '2026-10-16T13:00:00.000Z', `NY ${reminderDueAt({ start: '2026-10-16' }, NY).toISOString()}`);
  });

  await check('reminderDueAt: open-reminders.ts re-exports the one in due.ts', async () => {
    // open-reminders.ts reads the database; a stand-in Prisma keeps it offline.
    const Module = (await import('module')).default as unknown as {
      new (id: string): { filename: string; loaded: boolean; exports: unknown };
      _cache: Record<string, unknown>;
    };
    const filename = path.resolve(__dirname, '../src/utils/prisma.ts');
    const mod = new Module(filename);
    Object.assign(mod, { filename, loaded: true, exports: { prisma: {} } });
    Module._cache[filename] = mod;
    const openReminders = await import('../src/services/native-reminders/open-reminders');
    assert(openReminders.reminderDueAt === reminderDueAt, 'not the same function');
  });

  // ---- toRangeDays equals shapeEventsForDay ----

  // Israel, Monday 12 to Sunday 18 October 2026 (the window ends before the 19th).
  await parity(
    'overnight, sleepover, multi-day all-day, New York all-day, zero-length at 00:00 and 23:59 (Israel)',
    [
      famcal('tail', 'Night shift', utc('2026-10-11 20:00', IL), utc('2026-10-12 08:00', IL)),
      famcal('short-tail', 'Late party', utc('2026-10-11 22:00', IL), utc('2026-10-12 05:00', IL)),
      famcal('party', 'Party at Dana', utc('2026-10-12 22:00', IL), utc('2026-10-13 02:00', IL)),
      google('sleepover', 'Maya sleepover', '2026-10-13T18:00:00+03:00', '2026-10-14T10:00:00+03:00'),
      famcal('trip', 'Eilat', '2026-10-14', '2026-10-17'),
      famcal('ny-allday', 'Grandma in town', '2026-10-15', '2026-10-16', { tz: NY }),
      reminder('r-0000', 'Midnight pill', utc('2026-10-16 00:00', IL)),
      reminder('r-2359', 'Lock the door', utc('2026-10-16 23:59', IL)),
      google('conf', 'Conference', '2026-10-17T09:00:00+03:00', '2026-10-19T17:00:00+03:00'),
      google('before', 'Last week', '2026-10-05T09:00:00+03:00', '2026-10-05T10:00:00+03:00'),
      google('after', 'Next week', '2026-10-20T09:00:00+03:00', '2026-10-20T10:00:00+03:00'),
    ],
    '2026-10-12',
    '2026-10-19',
    IL,
    {
      '2026-10-12': ['tail:continues', 'party:endsLater'],
      '2026-10-13': ['sleepover:endsLater'],
      '2026-10-14': ['trip:endsLater', 'sleepover:continues'],
      '2026-10-15': ['trip:spansDay', 'ny-allday:-'],
      '2026-10-16': ['trip:continues', 'r-0000:-', 'r-2359:-'],
      '2026-10-17': ['conf:endsLater'],
      '2026-10-18': ['conf:spansDay'],
    }
  );

  // Israel leaves summer time on Sunday 25 October 2026 at 02:00 (back to 01:00): a 25-hour day.
  await parity(
    'IL DST end 2026-10-25',
    [
      famcal('dst-night', 'Motzei Shabbat', '2026-10-24T20:00:00.000Z', '2026-10-25T01:00:00.000Z'),
      google('dst-day', 'Whole day', '2026-10-25T00:00:00+03:00', '2026-10-26T00:00:00+02:00'),
      google('dst-twice', 'The hour that happens twice', '2026-10-25T01:30:00+03:00', '2026-10-25T01:30:00+02:00'),
      reminder('dst-late', 'Bins out', utc('2026-10-25 23:30', IL)),
      famcal('dst-sleep', 'Sleepover', utc('2026-10-25 20:00', IL), utc('2026-10-26 09:00', IL)),
    ],
    '2026-10-24',
    '2026-10-27',
    IL,
    {
      '2026-10-24': ['dst-night:endsLater'],
      '2026-10-25': ['dst-day:-', 'dst-twice:-', 'dst-sleep:endsLater', 'dst-late:-'],
      '2026-10-26': ['dst-sleep:continues'],
    }
  );

  // New York leaves daylight time on Sunday 1 November 2026 at 02:00 (back to 01:00).
  await parity(
    'US DST end 2026-11-01 (New York)',
    [
      google('halloween', 'Halloween party', '2026-10-31T22:00:00-04:00', '2026-11-01T01:30:00-05:00'),
      google('us-day', 'Whole day', '2026-11-01T00:00:00-04:00', '2026-11-02T00:00:00-05:00'),
      google('us-sleep', 'Sleepover', '2026-11-01T20:00:00-05:00', '2026-11-02T09:00:00-05:00'),
      famcal('us-allday', 'Marathon', '2026-11-01', '2026-11-02', { tz: NY }),
      reminder('us-0000', 'Change the clocks', utc('2026-11-01 00:00', NY), { tz: NY }),
    ],
    '2026-10-31',
    '2026-11-03',
    NY,
    {
      '2026-10-31': ['halloween:endsLater'],
      '2026-11-01': ['us-allday:-', 'us-0000:-', 'us-day:-', 'us-sleep:endsLater'],
      '2026-11-02': ['us-sleep:continues'],
    }
  );

  // Chile starts summer time at midnight: 00:00 on Sunday 6 September 2026 doesn't exist,
  // the day starts at 01:00. It ends at midnight too: 23:00-24:00 on Saturday 4 April
  // 2026 happens twice.
  await parity(
    'Chile midnight DST start 2026-09-06',
    [
      reminder('scl-last', 'Last minute of Saturday', '2026-09-06T03:59:00.000Z', { tz: SCL }),
      reminder('scl-first', 'First minute of Sunday', '2026-09-06T04:00:00.000Z', { tz: SCL }),
      google('scl-night', 'Asado', '2026-09-05T22:00:00-04:00', '2026-09-06T02:00:00-03:00'),
      google('scl-day', 'Whole day', '2026-09-06T01:00:00-03:00', '2026-09-07T00:00:00-03:00'),
      famcal('scl-allday', 'Fiestas', '2026-09-06', '2026-09-08', { tz: SCL }),
    ],
    '2026-09-05',
    '2026-09-08',
    SCL,
    {
      '2026-09-05': ['scl-night:endsLater', 'scl-last:-'],
      '2026-09-06': ['scl-allday:endsLater', 'scl-first:-', 'scl-day:-'],
      '2026-09-07': ['scl-allday:continues'],
    }
  );

  await parity(
    'Chile midnight DST end 2026-04-05',
    [
      google('scl-twice', 'The hour that happens twice', '2026-04-04T23:30:00-03:00', '2026-04-04T23:30:00-04:00'),
      reminder('scl-0000', 'Sunday midnight', '2026-04-05T04:00:00.000Z', { tz: SCL }),
      famcal('scl-over', 'Overnight shift', utc('2026-04-04 22:00', SCL), utc('2026-04-05 07:00', SCL), { tz: SCL }),
    ],
    '2026-04-04',
    '2026-04-06',
    SCL,
    {
      '2026-04-04': ['scl-over:endsLater', 'scl-twice:-'],
      '2026-04-05': ['scl-over:continues', 'scl-0000:-'],
    }
  );

  await check('toRangeDays: every day comes back, empty ones too, and a start-less item is dropped', () => {
    const noStart = famcal('no-start', 'Broken', '', '');
    const days = toRangeDays([noStart], '2026-10-16', '2026-10-19', IL, NOW, TODAY);
    assertList(days.map(d => `${d.date}:${d.items.length}`), ['2026-10-16:0', '2026-10-17:0', '2026-10-18:0']);
    assert(toRangeDays([], '2026-10-16', '2026-10-16', IL, NOW, TODAY).length === 0, 'an empty window has days');
  });

  // ---- Open, done and snoozed ----

  const stateRow = (doneAt: string | null, snoozedUntil: string | null) => ({
    doneAt: doneAt ? new Date(doneAt) : null,
    snoozedUntil: snoozedUntil ? new Date(snoozedUntil) : null,
  });
  const openItems = [
    reminder('r-yesterday', 'Yesterday', utc('2026-10-15 08:00', IL), { state: stateRow(null, null) }),
    reminder('r-past', 'Past due', utc('2026-10-16 08:00', IL), { state: stateRow(null, null) }),
    reminder('r-future', 'Later today', utc('2026-10-16 12:00', IL)),
    reminder('r-done', 'Done', utc('2026-10-16 07:00', IL), {
      state: stateRow('2026-10-16T04:10:00.000Z', null),
      reminder: { ownerIsViewer: true, creatorIsViewer: true, done: true },
    }),
    reminder('r-snoozed', 'Snoozed', utc('2026-10-16 06:00', IL), {
      state: stateRow(null, '2026-10-16T09:00:00.000Z'),
      reminder: { ownerIsViewer: true, creatorIsViewer: true, snoozed: true },
    }),
    reminder('r-snooze-over', 'Snooze ran out', utc('2026-10-16 05:00', IL), { state: stateRow(null, '2026-10-16T06:00:00.000Z') }),
    reminder('r-dateonly', 'Call the bank', '2026-10-16'),
    reminder('r-tomorrow', 'Tomorrow', utc('2026-10-17 08:00', IL)),
    famcal('e-past', 'Breakfast', utc('2026-10-16 07:00', IL), utc('2026-10-16 08:00', IL)),
  ];
  const openDays = toRangeDays(openItems, '2026-10-15', '2026-10-18', IL, NOW, TODAY);
  const find = (id: string): ItemDTO => {
    for (const day of openDays) for (const item of day.items) if (item.id === id) return item;
    throw new Error(`${id} not listed`);
  };

  await check('open: only today\'s past-due reminders are open; earlier today\'s future one, yesterday\'s and tomorrow\'s are not', () => {
    const opens = openDays.flatMap(d => d.items.filter(i => i.reminder?.open).map(i => `${d.date}:${i.id}`));
    assertList(opens, ['r-dateonly', 'r-snooze-over', 'r-snoozed', 'r-past'].map(id => `2026-10-16:${id}`));
    assert(find('r-yesterday').reminder?.open === false, 'yesterday is open');
    assert(find('r-future').reminder?.open === false, 'later today is open');
    assert(find('r-tomorrow').reminder?.open === false, 'tomorrow is open');
  });

  await check('open: a date-only reminder opens at 09:00 in the viewer\'s timezone', () => {
    const item = openItems.find(i => i.key === 'famcal|r-dateonly');
    assert(item !== undefined, 'fixture');
    assert(isOpenOnDay(item, TODAY, TODAY, IL, fromZonedTime('2026-10-16 08:59:00', IL)) === false, 'open at 08:59');
    assert(isOpenOnDay(item, TODAY, TODAY, IL, fromZonedTime('2026-10-16 09:01:00', IL)) === true, 'not open at 09:01');
  });

  await check('done: a done reminder is kept, with doneAt, and is not open', () => {
    const done = find('r-done');
    assert(done.reminder?.done === true, 'not done');
    assert(done.reminder?.doneAt === '2026-10-16T04:10:00.000Z', `doneAt ${done.reminder?.doneAt}`);
    assert(done.reminder?.open === false, 'open');
  });

  await check('snoozed: still open, with snoozedUntil; a snooze that ran out sends no snoozedUntil', () => {
    const snoozed = find('r-snoozed');
    assert(snoozed.reminder?.open === true, 'snoozed is not open');
    assert(snoozed.reminder?.snoozedUntil === '2026-10-16T09:00:00.000Z', `snoozedUntil ${snoozed.reminder?.snoozedUntil}`);
    const over = find('r-snooze-over');
    assert(over.reminder?.open === true && over.reminder.snoozedUntil === null, JSON.stringify(over.reminder));
  });

  await check('events carry no reminder block; days never set openSince', () => {
    assert(find('e-past').reminder === undefined, 'an event has a reminder block');
    assert(openDays.every(d => d.items.every(i => !i.reminder || i.reminder.openSince === null)), 'openSince on a day item');
  });

  // ---- Carry-overs ----

  await check('carry-over: open with openSince, snoozed ones too, the occurrence as originalStart, no span', () => {
    const daily = reminder('ser-daily#2026-10-12T05:00:00.000Z', 'Vitamins', '2026-10-12T05:00:00.000Z', {
      rrule: 'FREQ=DAILY',
      originalStart: '2026-10-12T05:00:00.000Z',
      state: stateRow(null, '2026-10-16T09:00:00.000Z'),
      reminder: { ownerIsViewer: true, creatorIsViewer: true, snoozed: true, openSince: '2026-10-12' },
    });
    const dto = toCarryOverDto(daily, IL, NOW);
    assert(dto.reminder?.open === true, 'not open');
    assert(dto.reminder?.openSince === '2026-10-12', `openSince ${dto.reminder?.openSince}`);
    assert(dto.reminder?.snoozedUntil === '2026-10-16T09:00:00.000Z', 'snooze lost');
    assert(dto.originalStart === '2026-10-12T05:00:00.000Z', `originalStart ${dto.originalStart}`);
    assert(dto.span === null, `span ${dto.span}`);
    assert(dto.id === 'ser-daily#2026-10-12T05:00:00.000Z' && dto.seriesId === 'ser-daily', `${dto.id} ${dto.seriesId}`);
    assert(dto.recurring === true && dto.repeatsDaily === true, 'series facts');
  });

  await check('carry-over: a one-off keeps the occurrence it was given, and openSince falls back to its local due day', () => {
    // 00:30 on the 14th in Israel is still the 13th in UTC.
    const oneOff = reminder('one-off', 'Return the drill', '2026-10-13T21:30:00.000Z', { originalStart: '2026-10-13T21:30:00.000Z' });
    const dto = toCarryOverDto(oneOff, IL, NOW);
    assert(dto.originalStart === '2026-10-13T21:30:00.000Z', `originalStart ${dto.originalStart}`);
    assert(dto.reminder?.open === true && dto.reminder.openSince === '2026-10-14', JSON.stringify(dto.reminder));
    assert(dto.recurring === false && dto.repeatsDaily === false, 'one-off series facts');
  });

  // ---- Field sources ----

  await check('repeatsDaily: a daily reminder only', () => {
    const at = utc('2026-10-16 08:00', IL);
    const cases: Array<[ReadItem, boolean]> = [
      [reminder('a', 'a', at, { rrule: 'FREQ=DAILY' }), true],
      [reminder('b', 'b', at, { rrule: 'FREQ=DAILY;INTERVAL=2' }), true],
      [reminder('c', 'c', at, { rrule: 'FREQ=WEEKLY;BYDAY=MO' }), false],
      [reminder('d', 'd', at), false],
      [famcal('e', 'e', at, utc('2026-10-16 09:00', IL), { rrule: 'FREQ=DAILY' }), false],
    ];
    for (const [item, want] of cases) {
      const dto = toItemDto(item, null, { now: NOW, open: false, openSince: null });
      assert(dto.repeatsDaily === want, `${item.key} ${item.rrule}: ${dto.repeatsDaily}`);
    }
  });

  await check('readOnly, tz, id, allDay, location and description come from the read', () => {
    const fam = toItemDto(
      famcal('ser1#2026-10-16T05:00:00.000Z', 'Swim', '2026-10-16T05:00:00.000Z', '2026-10-16T06:00:00.000Z', {
        tz: NY,
        rrule: 'FREQ=WEEKLY',
        location: 'Pool',
        description: '',
      }),
      'endsLater',
      { now: NOW, open: false, openSince: null }
    );
    assert(fam.readOnly === false && fam.source === 'famcal', 'famcal readOnly');
    assert(fam.tz === NY, `famcal tz ${fam.tz}`);
    assert(fam.id === 'ser1#2026-10-16T05:00:00.000Z' && fam.seriesId === 'ser1', `famcal id ${fam.id}`);
    assert(fam.allDay === false && fam.span === 'endsLater' && fam.recurring === true, 'famcal shape');
    assert(fam.location === 'Pool' && fam.description === null, `location ${fam.location}, description ${JSON.stringify(fam.description)}`);
    assert(!('birthday' in fam) && !('htmlLink' in fam), 'famcal carries Google fields');

    const goo = toItemDto(google('g1', null, '2026-10-16', '2026-10-17', { birthday: true, htmlLink: 'https://calendar.google.com/x' }), null, {
      now: NOW,
      open: false,
      openSince: null,
    });
    assert(goo.readOnly === true && goo.source === 'google', 'google readOnly');
    assert(goo.tz === null, `google tz ${goo.tz}`);
    assert(goo.id === 'g1' && goo.key === 'google|family@group.calendar.google.com|g1', `google id ${goo.id} ${goo.key}`);
    assert(goo.allDay === true && goo.title === null, 'google all-day, raw null title');
    assert(goo.birthday === true && goo.htmlLink === 'https://calendar.google.com/x', 'google fields');
    assert(goo.reminder === undefined, 'google reminder block');
  });

  await check('reminder: whose it is and who set it pass through', () => {
    const dto = toItemDto(
      reminder('nr', 'Buy flowers', utc('2026-10-16 12:00', IL), {
        calendar: NOA_SHARED,
        reminder: { ownerIsViewer: false, creatorIsViewer: false, ownerName: 'Noa', creatorName: 'Noa' },
      }),
      null,
      { now: NOW, open: false, openSince: null }
    );
    assert(dto.reminder?.ownerIsViewer === false && dto.reminder.creatorIsViewer === false, 'flags');
    assert(dto.reminder?.ownerName === 'Noa' && dto.reminder.creatorName === 'Noa', 'names');
    assert(JSON.stringify(dto.calendar) === JSON.stringify({ id: 'native:cal-noa', name: 'Noa family', color: '#E67C73', mine: false, ownerName: 'Noa', inLegend: true }), JSON.stringify(dto.calendar));
  });

  // ---- Privacy ----

  await check('masked: a partner-private reminder-for-me never shows the calendar\'s real name or id, on a day or as a carry-over', () => {
    const secret = reminder('noa-private', 'Pick up the cake', utc('2026-10-16 08:00', IL), {
      calendar: MASKED,
      calendarName: 'Noa therapy',
      calendarId: 'native:cal-noa-private',
      reminder: { ownerIsViewer: true, creatorIsViewer: false, creatorName: 'Noa' },
    });
    const days = toRangeDays([secret], '2026-10-16', '2026-10-17', IL, NOW, TODAY);
    const carry = toCarryOverDto(secret, IL, NOW);
    for (const json of [JSON.stringify(days), JSON.stringify(carry)]) {
      assert(!json.includes('therapy'), 'the real name leaked');
      assert(!json.includes('cal-noa-private'), 'the real id leaked');
    }
    const want = JSON.stringify({ id: null, name: 'Noa', color: null, mine: false, inLegend: false });
    assert(JSON.stringify(days[0].items[0].calendar) === want, JSON.stringify(days[0].items[0].calendar));
    assert(JSON.stringify(carry.calendar) === want, JSON.stringify(carry.calendar));
  });

  await check('masked: a calendar outside the legend never sends its id, whatever the ref says', () => {
    const leaky: CalendarRef = { ...NOA_SHARED, id: 'native:cal-noa-private', inLegend: false };
    const dto = toItemDto(famcal('x', 'x', utc('2026-10-16 08:00', IL), utc('2026-10-16 09:00', IL), { calendar: leaky }), null, {
      now: NOW,
      open: false,
      openSince: null,
    });
    assert(dto.calendar.id === null, `id ${dto.calendar.id}`);
  });

  // ---- Legend ----

  await check('toCalendarDto: legend fields, ownerName and unavailable only when set, a masked ref throws', () => {
    assert(
      JSON.stringify(toCalendarDto(OWN_CAL)) === JSON.stringify({ id: 'native:cal-own', source: 'famcal', name: 'Raziel', color: '#039BE5', mine: true }),
      JSON.stringify(toCalendarDto(OWN_CAL))
    );
    const spouse: CalendarRef = { id: 'dana@gmail.com', source: 'google', name: 'Dana', color: null, mine: false, ownerName: 'Dana', inLegend: true, unavailable: true };
    assert(
      JSON.stringify(toCalendarDto(spouse)) ===
        JSON.stringify({ id: 'dana@gmail.com', source: 'google', name: 'Dana', color: null, mine: false, ownerName: 'Dana', unavailable: true }),
      JSON.stringify(toCalendarDto(spouse))
    );
    assert(!('unavailable' in toCalendarDto({ ...spouse, unavailable: false })), 'unavailable: false sent');
    let threw = false;
    try {
      toCalendarDto(MASKED);
    } catch {
      threw = true;
    }
    assert(threw, 'a masked ref became a legend entry');
  });

  // ---- compareItems ----

  await check('compareItems: all-day first, then start instant, end, FamCal before Google, title, key', () => {
    const dto = (item: ReadItem) => toItemDto(item, null, { now: NOW, open: false, openSince: null });
    const items = [
      dto(google('g-late', 'B', '2026-10-16T12:00:00+03:00', '2026-10-16T13:00:00+03:00')),
      dto(famcal('f-same-b', 'B', utc('2026-10-16 09:00', IL), utc('2026-10-16 10:00', IL))),
      dto(google('g-same', 'A', '2026-10-16T09:00:00+03:00', '2026-10-16T10:00:00+03:00')),
      dto(famcal('f-same-a', 'A', utc('2026-10-16 09:00', IL), utc('2026-10-16 10:00', IL))),
      dto(famcal('f-short', 'Z', utc('2026-10-16 09:00', IL), utc('2026-10-16 09:30', IL))),
      // 06:30 UTC is 09:30 in Israel: later than 09:00+03:00 even though it reads earlier.
      dto(famcal('f-utc', 'A', '2026-10-16T06:30:00.000Z', '2026-10-16T07:00:00.000Z')),
      dto(famcal('f-allday', 'Z', '2026-10-16', '2026-10-17')),
      dto(google('g-allday-earlier', 'Z', '2026-10-14', '2026-10-18')),
      dto(famcal('f-midnight', 'A', utc('2026-10-16 00:00', IL), utc('2026-10-16 00:00', IL))),
    ];
    const sorted = [...items].sort(compareItems).map(i => i.id);
    assertList(sorted, ['g-allday-earlier', 'f-allday', 'f-midnight', 'f-short', 'f-same-a', 'f-same-b', 'g-same', 'f-utc', 'g-late']);
    for (const a of items) {
      for (const b of items) {
        const ab = Math.sign(compareItems(a, b));
        const ba = Math.sign(compareItems(b, a));
        assert(ab === -ba, `not antisymmetric: ${a.id} ${b.id}`);
        assert((ab === 0) === (a.key === b.key), `ties without the same key: ${a.id} ${b.id}`);
      }
    }
    const twin = { ...items[3], key: 'famcal|f-same-a-2', id: 'f-same-a-2' };
    assert(compareItems(items[3], twin) < 0, 'the key does not break the last tie');
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

- [ ] **Step 2: Run the smoke and see it fail**

```bash
TZ=UTC DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-calendar-dto.ts; echo "exit $?"
```

Expected: `Error: Cannot find module '../src/lib/calendar-view/types'` and `exit 1`.

- [ ] **Step 3: Create `src/lib/calendar-view/types.ts`**

```ts
// The calendar home's wire format (spec §4): what GET /api/calendar/range answers and
// what the client keeps in its store. Client-safe: no imports, so the home's bundle
// never pulls in server code. The server builds these in
// src/services/calendar-read/dto.ts.

/** A calendar day, 'yyyy-MM-dd', in the viewer's timezone. */
export type DayKey = string;

/** Where an item comes from. */
export type SourceName = 'famcal' | 'google';

/** The first day of the week: 0 = Sunday … 6 = Saturday (as Date#getUTCDay). */
export type WeekStart = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/**
 * How an item sits on a day it is listed on when it crosses the day's edges (as
 * daySpanOf decides); null when it is wholly inside the day.
 */
export type ItemSpan = 'endsLater' | 'continues' | 'spansDay';

export type GoogleStatusReason = 'token' | 'scopes' | 'calendars_gone' | 'transient' | 'timeout' | 'config' | 'unknown';

export interface RangeResponse {
  tz: string;
  today: DayKey;
  weekStart: WeekStart;
  hebrewDates: boolean;
  from: DayKey;
  to: DayKey;
  sources: {
    famcal?: { status: 'ok' | 'pending' | 'error' };
    google?: {
      status: 'ok' | 'pending' | 'reconnect' | 'error';
      reason?: GoogleStatusReason;
      partial?: { failed: number; truncated: number };
      stale?: boolean;
    };
  };
  partner: { name: string } | null;
  /** The legend for the requested sources. */
  calendars: CalendarDTO[];
  /** Every day in [from, to), empty ones included, each sorted with compareItems. */
  days: { date: DayKey; items: ItemDTO[] }[];
  /** Newest first. */
  carryOvers?: ItemDTO[];
}

export interface CalendarDTO {
  id: string;
  source: SourceName;
  name: string;
  color: string | null;
  mine: boolean;
  ownerName?: string;
  unavailable?: boolean;
}

export interface ItemCalendarDTO {
  /** null when masked (a partner's private calendar). */
  id: string | null;
  name: string;
  color: string | null;
  mine: boolean;
  ownerName?: string;
  inLegend: boolean;
}

export interface ItemReminderDTO {
  done: boolean;
  doneAt: string | null;
  /** Set only while the snooze is still running. */
  snoozedUntil: string | null;
  /** Today's past-due undone reminders, and every carry-over. */
  open: boolean;
  /** 'yyyy-MM-dd'; carry-overs only. */
  openSince: string | null;
  ownerIsViewer: boolean;
  creatorIsViewer: boolean;
  ownerName?: string;
  creatorName?: string;
}

export interface ItemDTO {
  key: string;
  source: SourceName;
  readOnly: boolean;
  id: string;
  seriesId: string | null;
  originalStart: string | null;
  kind: 'event' | 'reminder';
  title: string | null;
  /**
   * Timed: an instant (FamCal UTC ISO, Google RFC 3339 with the user's offset).
   * All-day: 'yyyy-MM-dd', with an exclusive end.
   */
  start: string;
  end: string;
  allDay: boolean;
  /** The event's own timezone (FamCal only). */
  tz: string | null;
  recurring: boolean;
  repeatsDaily: boolean;
  span: ItemSpan | null;
  calendar: ItemCalendarDTO;
  location: string | null;
  /** Plain text. */
  description: string | null;
  reminder?: ItemReminderDTO;
  /** Google only. */
  birthday?: boolean;
  /** Google only. */
  htmlLink?: string | null;
}

/** An instant to sort by; an all-day 'yyyy-MM-dd' reads as UTC midnight, which keeps date order. */
function sortInstant(value: string, fallback: number): number {
  const t = Date.parse(value);
  return Number.isNaN(t) ? fallback : t;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The order of a day's items, the same on the server and the client: all-day first,
 * then start instant, then end, FamCal before Google, then title. The key breaks the
 * last ties, so the order is total and two sorts of the same items always agree.
 * Strings compare by code unit, never by locale.
 */
export function compareItems(a: ItemDTO, b: ItemDTO): number {
  if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
  const aStart = sortInstant(a.start, 0);
  const bStart = sortInstant(b.start, 0);
  if (aStart !== bStart) return aStart - bStart;
  const aEnd = sortInstant(a.end, aStart);
  const bEnd = sortInstant(b.end, bStart);
  if (aEnd !== bEnd) return aEnd - bEnd;
  if (a.source !== b.source) return a.source === 'famcal' ? -1 : 1;
  const byTitle = compareStrings(a.title ?? '', b.title ?? '');
  if (byTitle !== 0) return byTitle;
  return compareStrings(a.key, b.key);
}
```

Then make B2's `WeekStart` the re-export of this one, so there is one definition and client code never needs `src/utils/locale-rules.ts`, which pulls in the zone table. In `src/utils/locale-rules.ts`, replace:
```ts
import { NON_MONDAY_ZONES } from '../config/week-start-zones';
import { addDaysToDate } from './day-events';

/** A week's first day: 0 = Sunday ... 6 = Saturday, as Date.getUTCDay counts. */
export type WeekStart = 0 | 1 | 2 | 3 | 4 | 5 | 6;
```
with:
```ts
import { NON_MONDAY_ZONES } from '../config/week-start-zones';
import { addDaysToDate } from './day-events';
import type { WeekStart } from '../lib/calendar-view/types';

/**
 * A week's first day: 0 = Sunday ... 6 = Saturday, as Date.getUTCDay counts. Defined once,
 * in the client-safe src/lib/calendar-view/types.ts: client code imports it from there,
 * never from here, which would pull the zone table into the client bundle.
 */
export type { WeekStart };
```
`smoke-locale-rules.ts` (B2) imports `type WeekStart` from `locale-rules.ts` and still does. The import is type-only, so `locale-rules.ts` loads nothing new.

- [ ] **Step 4: Create `src/services/calendar-read/types.ts`**

```ts
// The shared reader's server types (spec §2.2). One read covers the calendar home and,
// for the users the rollout switch covers, the summaries. Types only.

import type { UnifiedEvent } from '../calendar-provider/types';
import type { ViewerContext } from '../native-reminders/ownership';
import type { SourceName } from '../../lib/calendar-view/types';

export type { DayKey, SourceName } from '../../lib/calendar-view/types';

/** What the UI may show about an item's calendar. */
export interface CalendarRef {
  /** 'native:<cuid>' or the Google id; null when masked. */
  id: string | null;
  source: SourceName;
  name: string;
  color: string | null;
  mine: boolean;
  /** The partner, or a spouse-labelled Google calendar's person. */
  ownerName?: string;
  inLegend: boolean;
  /** A chosen Google calendar that is gone. */
  unavailable?: boolean;
}

export interface ReadItem {
  source: SourceName;
  /** 'famcal|<eventId>' or 'google|<calendarId>|<id>'. */
  key: string;
  /** Exactly what the summaries consume today. */
  event: UnifiedEvent;
  /** For the DTO; the summaries never read it. */
  calendar: CalendarRef;
  /** The raw title; event.summary keeps 'No title'. */
  title: string | null;
  kind: 'event' | 'reminder';
  seriesId: string | null;
  /** FamCal instanceStartsAt (one-offs too) or Google originalStartTime. */
  originalStart: string | null;
  recurring: boolean;
  /** The FamCal series rrule; null for Google. */
  rrule: string | null;
  state?: { doneAt: Date | null; snoozedUntil: Date | null };
  google?: { birthday: boolean; htmlLink: string | null };
}

export interface ReadRangeOptions {
  /** The caller's resolveUserTimezone. */
  tz: string;
  /** Intersected with sourcesFor(user); absent = every applicable source. */
  sources?: readonly SourceName[];
  /** Summary callers only: the ids they already resolved. */
  calendarIds?: readonly string[];
  /** Clip the start to an instant (This week starts now). */
  notBefore?: Date;
  /** Default 'bypass'; only the route uses the cache. */
  googleCache?: 'use' | 'refresh' | 'bypass';
  /** Covers the whole Google half (spec §2.2 Deadlines). */
  deadlineMs: number;
  /** Runs the stale-entry refresh (spec §2.6); the route passes after(). */
  defer?: (task: () => Promise<void>) => void;
}

export type FamcalRead =
  | { status: 'ok'; ctx: ViewerContext; calendars: CalendarRef[]; partner: { name: string } | null }
  | { status: 'error'; cause: unknown };

export type GoogleRead =
  | {
      status: 'ok';
      calendars: CalendarRef[];
      goneIds: string[];
      partial: { failed: number; truncated: number } | null;
      stale: boolean;
    }
  | { status: 'reconnect'; reason: 'token' | 'scopes' }
  | { status: 'error'; reason: 'transient' | 'config' | 'timeout' | 'calendars_gone' | 'unknown'; cause?: unknown };

export interface RangeRead {
  window: { from: Date; to: Date };
  /** FamCal then Google, each in today's order; not bucketed into days. */
  items: ReadItem[];
  /** Absent when it doesn't apply or wasn't requested. */
  famcal?: FamcalRead;
  google?: GoogleRead;
}
```

- [ ] **Step 5: Move `reminderDueAt` into `src/services/native-reminders/due.ts`**

In `due.ts`, replace lines 4-6:

```ts
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { TIMEZONE } from '../../config/constants';
import { localDate, nextDate } from '../../utils/day-events';
```

with:

```ts
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import type { CalendarEvent } from '../../types';
import { TIMEZONE } from '../../config/constants';
import { localDate, nextDate } from '../../utils/day-events';
```

Then, between the end of `dueAtForOccurrence` (`:33`, `}`) and the `/** 💤 Tomorrow: …` doc comment of `tomorrowMorning` (`:35`), insert:

```ts
/**
 * When a reminder on a digest or the calendar home is due, in the viewer's timezone:
 * its time, or REMINDER_MORNING_HOUR (the ping's) on its date (an all-day start is
 * already the event's own date). Lives here, in this leaf, so the calendar home's pure
 * DTO code can use it without loading Prisma; open-reminders.ts re-exports it.
 */
export function reminderDueAt(event: Pick<CalendarEvent, 'start'>, timezone: string): Date {
  if (event.start.includes('T')) return new Date(event.start);
  return morningOf(event.start, timezone);
}

```

- [ ] **Step 6: Re-export it from `src/services/native-reminders/open-reminders.ts` and drop the old copy**

Line numbers are the file's before this step (main@858886c); match on the text.

Delete line 12:

```ts
import { fromZonedTime } from 'date-fns-tz';
```

Replace line 22:

```ts
import { ARMED_GRACE_MS, REMINDER_MORNING_HOUR } from './due';
```

with:

```ts
import { ARMED_GRACE_MS, reminderDueAt } from './due';

// reminderDueAt moved to the leaf due.ts (the calendar home's DTO code reads it); its
// callers keep importing it from here.
export { reminderDueAt };
```

Delete lines 29-38 (the old definition and the blank line after it):

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

Nothing else in the file changes. `CalendarEvent` is still used by `shapeDayReminders` and `selectOpenReminders`. `fromZonedTime` and `REMINDER_MORNING_HOUR` have no other uses: `grep -n "fromZonedTime\|REMINDER_MORNING_HOUR" src/services/native-reminders/open-reminders.ts` prints nothing.

- [ ] **Step 7: Create `src/services/calendar-read/dto.ts`**

```ts
// The calendar home's day buckets and DTOs (spec §4). Pure: no Prisma, no Redis and no
// clock of its own (`now` comes in), so the smokes run it without stubs.
//
// Day membership is daySpanOf's, the rule the summaries apply through
// shapeEventsForDay, so a day on the home and the same day's summary always list the
// same items. The DTO is built field by field from the ReadItem: nothing is spread, so
// event.calendarName and event.calendarId (the real name and id of a partner's private
// calendar behind a masked CalendarRef) never reach the JSON.

import type { DaySpan } from '../../types';
import { addDaysToDate, daySpanOf, localDate, nextDate } from '../../utils/day-events';
import { reminderDueAt } from '../native-reminders/due';
import {
  compareItems,
  type CalendarDTO,
  type DayKey,
  type ItemCalendarDTO,
  type ItemDTO,
  type ItemReminderDTO,
} from '../../lib/calendar-view/types';
import type { CalendarRef, ReadItem } from './types';

export interface ItemDtoOptions {
  now: Date;
  /** The caller decides: a past-due undone reminder on today's bucket, or a carry-over. */
  open: boolean;
  /** Carry-overs only; null elsewhere. */
  openSince: DayKey | null;
}

function isDone(item: ReadItem): boolean {
  return (item.state?.doneAt ?? null) !== null || item.event.reminder?.done === true;
}

/** The item's calendar as the UI may show it. A calendar outside the legend never shows its id. */
function itemCalendar(ref: CalendarRef): ItemCalendarDTO {
  return {
    id: ref.inLegend ? ref.id : null,
    name: ref.name,
    color: ref.color,
    mine: ref.mine,
    ...(ref.ownerName ? { ownerName: ref.ownerName } : {}),
    inLegend: ref.inLegend,
  };
}

function reminderDto(item: ReadItem, opts: ItemDtoOptions): ItemReminderDTO {
  // A FamCal reminder always carries its info (toUnifiedEvent); without it, it reads
  // as the viewer's own, as the summaries do.
  const info = item.event.reminder;
  const doneAt = item.state?.doneAt ?? null;
  const snoozedUntil = item.state?.snoozedUntil ?? null;
  return {
    done: isDone(item),
    doneAt: doneAt ? doneAt.toISOString() : null,
    // A snooze that has run out is no longer one: the badge would show a past time.
    snoozedUntil: snoozedUntil && snoozedUntil > opts.now ? snoozedUntil.toISOString() : null,
    open: opts.open,
    openSince: opts.openSince,
    ownerIsViewer: info?.ownerIsViewer ?? true,
    creatorIsViewer: info?.creatorIsViewer ?? true,
    ...(info?.ownerName ? { ownerName: info.ownerName } : {}),
    ...(info?.creatorName ? { creatorName: info.creatorName } : {}),
  };
}

/** One item as one day lists it (span is that day's daySpanOf, null when inside the day), or as a carry-over. */
export function toItemDto(item: ReadItem, span: DaySpan | null, opts: ItemDtoOptions): ItemDTO {
  const { event } = item;
  const dto: ItemDTO = {
    key: item.key,
    source: item.source,
    readOnly: item.source === 'google',
    id: event.eventId ?? item.key,
    seriesId: item.seriesId,
    originalStart: item.originalStart,
    kind: item.kind,
    title: item.title,
    start: event.start,
    end: event.end,
    allDay: !event.start.includes('T'),
    tz: item.source === 'famcal' ? (event.timeZone ?? null) : null,
    recurring: item.recurring,
    repeatsDaily: item.kind === 'reminder' && /FREQ=DAILY/.test(item.rrule ?? ''),
    span,
    calendar: itemCalendar(item.calendar),
    location: event.location || null,
    description: event.description || null,
  };
  if (item.kind === 'reminder') dto.reminder = reminderDto(item, opts);
  if (item.source === 'google') {
    dto.birthday = item.google?.birthday ?? false;
    dto.htmlLink = item.google?.htmlLink ?? null;
  }
  return dto;
}

/**
 * Whether a reminder listed on `day` shows as open: only on today, not done, and due
 * before now. A snoozed one is still open; past days are never open.
 */
export function isOpenOnDay(item: ReadItem, day: DayKey, today: DayKey, tz: string, now: Date): boolean {
  if (day !== today || item.kind !== 'reminder' || isDone(item)) return false;
  return reminderDueAt(item.event, tz) < now;
}

/**
 * The days daySpanOf could accept for an event, [lo, hi), so it isn't asked about
 * every day of a 42-day window. All-day: its dates, with the end daySpanOf uses. Timed:
 * a day either side of its local start and end dates; daySpanOf still decides.
 */
function candidateDays(event: ReadItem['event'], tz: string): [DayKey, DayKey] {
  if (!event.start.includes('T')) {
    const end = event.end && !event.end.includes('T') && event.end > event.start ? event.end : nextDate(event.start);
    return [event.start, end];
  }
  const a = localDate(new Date(event.start), tz);
  const b = event.end ? localDate(new Date(event.end), tz) : a;
  return [addDaysToDate(a < b ? a : b, -1), addDaysToDate(a < b ? b : a, 2)];
}

function hasReadableStart(event: ReadItem['event']): boolean {
  if (!event.start) return false;
  if (!event.start.includes('T')) return /^\d{4}-\d{2}-\d{2}$/.test(event.start);
  return !Number.isNaN(Date.parse(event.start)) && (!event.end || !Number.isNaN(Date.parse(event.end)));
}

/**
 * Every day in [fromKey, toKey), empty ones included. Each item is listed on every day
 * daySpanOf puts it on, with that day's span, and each day is sorted with
 * compareItems. Reminders are marked open only on `today` (isOpenOnDay); done ones are
 * kept. An item without a readable start is dropped (readRange drops those already).
 */
export function toRangeDays(
  items: ReadItem[],
  fromKey: DayKey,
  toKey: DayKey,
  tz: string,
  now: Date,
  today: DayKey
): { date: DayKey; items: ItemDTO[] }[] {
  const days: { date: DayKey; items: ItemDTO[] }[] = [];
  const byDate = new Map<DayKey, ItemDTO[]>();
  for (let d = fromKey; d < toKey; d = nextDate(d)) {
    const list: ItemDTO[] = [];
    days.push({ date: d, items: list });
    byDate.set(d, list);
  }
  for (const item of items) {
    if (!hasReadableStart(item.event)) continue;
    const [lo, hi] = candidateDays(item.event, tz);
    for (let d = lo < fromKey ? fromKey : lo; d < hi && d < toKey; d = nextDate(d)) {
      const span = daySpanOf(item.event, d, tz);
      if (span === null) continue;
      const list = byDate.get(d);
      if (!list) continue;
      list.push(toItemDto(item, span ?? null, { now, open: isOpenOnDay(item, d, today, tz, now), openSince: null }));
    }
  }
  for (const day of days) day.items.sort(compareItems);
  return days;
}

/**
 * A carry-over (an older open reminder) as the "Still open" card gets it: always open,
 * snoozed ones too, with openSince, the day it fell due (selectOpenReminders sets it;
 * worked out the same way when missing). No span: it isn't listed on a day. The
 * caller builds the ReadItem with the occurrence's instanceStartsAt as originalStart
 * and a CalendarRef masked by the legend rule.
 */
export function toCarryOverDto(item: ReadItem, tz: string, now: Date): ItemDTO {
  const openSince = item.event.reminder?.openSince ?? localDate(reminderDueAt(item.event, tz), tz);
  return toItemDto(item, null, { now, open: true, openSince });
}

/**
 * A legend entry. Only legend refs come here (FamcalRead.calendars, GoogleRead.calendars);
 * a masked ref has no id and is never a legend entry, so it throws.
 */
export function toCalendarDto(ref: CalendarRef): CalendarDTO {
  if (ref.id === null) throw new Error('toCalendarDto: a masked calendar is not a legend entry');
  return {
    id: ref.id,
    source: ref.source,
    name: ref.name,
    color: ref.color,
    mine: ref.mine,
    ...(ref.ownerName ? { ownerName: ref.ownerName } : {}),
    ...(ref.unavailable ? { unavailable: true } : {}),
  };
}
```

- [ ] **Step 8: Run the smoke under the three clocks**

```bash
for tz in UTC Asia/Jerusalem Pacific/Kiritimati; do
  env TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-calendar-dto.ts; echo "exit $? (TZ=$tz)"
done
```

Expected: each run ends with `23/23 passed (process TZ=…)` and `exit 0`.

- [ ] **Step 9: Run the regression smokes, then type-check and lint**

```bash
for s in smoke-native-reminder-digest smoke-native-reminders smoke-native-reminder-edit smoke-day-shaping smoke-native-provider-reminders smoke-reminders smoke-week-lookahead smoke-locale-rules; do
  for tz in UTC Asia/Jerusalem; do
    env TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/$s.ts > /dev/null 2>&1; echo "$s TZ=$tz exit $?"
  done
done
npx tsc --noEmit -p .; echo "tsc exit $?"
npm run -s lint; echo "lint exit $?"
```

Expected: every smoke exits 0 and prints the same N/N it printed before this task. On `main@858886c` that is digest 32/32, native-reminders 44/44, native-reminder-edit 18/18, day-shaping 36/36, native-provider-reminders 11/11, reminders 23/23 and week-lookahead 22/22. With Plan A in (this task's base) it is digest 33/33, native-reminders 45/45, native-reminder-edit 18/18, day-shaping 36/36, native-provider-reminders 11/11, reminders 23/23 and week-lookahead 29/29, in both timezones. `smoke-locale-rules` (B2's, whose module Step 3 touched) stays 19/19. `tsc exit 0` and `lint exit 0`.

- [ ] **Step 10: Commit**

```bash
git add src/lib/calendar-view/types.ts src/services/calendar-read/types.ts src/services/calendar-read/dto.ts src/services/native-reminders/due.ts src/services/native-reminders/open-reminders.ts src/utils/locale-rules.ts scripts/smoke-calendar-dto.ts
git commit -m "$(cat <<'EOF'
feat(calendar-read): reader types and the calendar home's DTO

The shared reader's server types (spec §2.2) and the home's wire format
(spec §4): client-safe DTO types with compareItems, and a pure dto.ts that
buckets items into days with daySpanOf (the summaries' rule), marks today's
open reminders, and builds item, carry-over and legend DTOs. A masked
calendar's real name and id never reach the JSON.

reminderDueAt moves to the leaf native-reminders/due.ts so dto.ts loads no
Prisma; open-reminders.ts re-exports it. locale-rules.ts re-exports the
client-safe WeekStart, so there is one. Nothing calls the new code yet and
the rollout switch is OFF, so nothing a user sees changes.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
EOF
)"
```

---

### Task 4 (B4): Google pure rules (classifier, filter, mapper, htmlToText)

**What and why:** the pure half of spec §2.5, so B6's `readGoogle` and Plan C's digest adapters share one copy of the rules. `classifyGoogleError` replaces the old `isTokenError` for the reader only. The old check calls every 403 (rate limits included) and every message containing "token" (a network error on `oauth2.googleapis.com/token`) a dead token, and it silently swallows a bad server secret (`invalid_client`). `keepGoogleEvent` drops non-events (Ruling R1) and the calendar owner's declines (Ruling R2). `mapGoogleEvent` is today's day mapper (`calendar.ts:116-134`) plus `provider: 'google'`, minus `reminders`, with the description run through the new `htmlToText`. Nothing calls these yet; the switch is OFF, so no user sees a change.

**Interface change:** none. These are the split's signatures. One additive export: `type GoogleErrorClass` (the classifier's union) from `google-map.ts`.

**Findings that shaped the code (verified against the installed library):**
- `@googleapis/calendar` 9.8.0 ships its **own** `gaxios` 6.7.1 and `google-auth-library` 9.15.1 under `node_modules/@googleapis/calendar/node_modules/`. The top-level gaxios 7 is not the one in use. gaxios 6.7.1 uses node-fetch 2.6.9.
- A wrapped fetch failure is a `GaxiosError` whose own `name` is `'Error'`. The node-fetch error sits on `.error`, so an abort looks like `{ name: 'Error', error: { name: 'AbortError' } }` and a timeout like `{ error: { type: 'request-timeout' } }`. That's why the classifier also reads `error.name`; a check of `e.name === 'AbortError'` alone misses the real abort (B6: don't re-check `e.name` alone).
- Token endpoint: `processError` sets `message = 'invalid_grant'`, `status = <HTTP>` and leaves `code` unset. `response.data.error` is the OAuth string. `invalid_client` and `unauthorized_client` come with HTTP 401, so the OAuth strings must be checked before the 401 rule.
- Calendar API errors: `code` is the numeric `error.code` and `errors` holds `[{ reason }]`. A 403 for missing scopes has the message "Insufficient Permission", which `isInsufficientScopesError` catches.

**Spec notes (small, deliberate readings; veto in review if unwanted):**
- `htmlToText`: plain text means no tag **and** no known entity. Such text comes back unchanged apart from the 500 code-point cut (no trim, no blank-line collapse). Text with `&amp;` but no tags is decoded.
- `htmlToText`: a tag is an HTML element's name (`TAG_NAMES`: the elements Google's editor, Outlook and Teams invites and pasted web text use, plus Google's `<html-blob>` and Word's `<o:p>`), ended by a space, `/` or `>`, in any case. Plain-text Teams, Outlook and Zoom invites put links and addresses in angle brackets (`Join<https://teams.microsoft.com/…>`, `Dana Levi <dana@corp.com>`), and any `<letter…>` rule strips them. The same name-ends rule guards the `<a>`, `<br>`, `<li>` and `<script>`/`<style>` patterns, so `<li.wang@corp.com>` is not a list item. Plan C's parity smoke normalizes C3 descriptions with this `htmlToText`, so this has to hold before Plan C.
- `htmlToText`: a `mailto:` or `tel:` link whose text is the address gives just the address (`dana@example.com`), not `dana@example.com (mailto:dana@example.com)`. Every other link follows the spec: `t (u)` when t ≠ u, else u.
- `htmlToText`: `&nbsp;` becomes a plain space. `<style>`/`<script>` blocks and `<!-- -->` comments go with their content. Raw newlines inside HTML are kept, as Google shows them.
- `keepGoogleEvent`: a `start` with neither `date` nor `dateTime` counts as no start (the mapper would give `start: ''`, which §2.3 drops anyway).
- `classifyGoogleError`: the status is read from `response.status`, then `status`, then a numeric `code`. So a plain `{ code: 403, message }` object reads as the old checks read it.

**Files:**
- Modify: `src/utils/html.ts:1-7` (header comment), and append after `:12` (new `htmlToText` and its private helpers). It stays a leaf module with no imports.
- Create: `src/services/calendar-read/google-map.ts`
- Create (test): `scripts/smoke-google-map.ts`
- Test: `scripts/smoke-google-map.ts` (B2/B3/B4 split §10's pure smoke by module; this is the Google part)

**Interfaces:**
- Consumes:
  - `ReadItem` from `src/services/calendar-read/types.ts` (Task B3; spec §2.2). B4 must land after B3.
  - `UnifiedEvent` (`src/services/calendar-provider/types.ts:16-21`), via `ReadItem.event`.
  - `isInsufficientScopesError(error: unknown): boolean` (`src/utils/errors.ts:30-44`, unchanged).
  - `calendar_v3.Schema$Event` (type-only import from `@googleapis/calendar`; nothing loads at run time).
  - Smoke only: `fetchTodayEvents(refreshToken: string, calendarIds: string[], timezone?: string): Promise<CalendarEvent[]>` (`src/services/calendar.ts:167-173`, unchanged), as the reference mapper.
- Produces:
  - `htmlToText(s: string | null | undefined, max = 500): string` in `src/utils/html.ts`
  - `type GoogleErrorClass = 'scopes' | 'token' | 'config' | 'gone' | 'transient' | 'unknown'`
  - `classifyGoogleError(e: unknown): GoogleErrorClass`
  - `keepGoogleEvent(raw: calendar_v3.Schema$Event): boolean`
  - `mapGoogleEvent(raw: calendar_v3.Schema$Event, calendarId: string, calendarName: string): Omit<ReadItem, 'calendar'>`
  - B6 uses all three `google-map.ts` exports. Plan C's parity smoke uses `htmlToText` (C3 normalization).

- [ ] **Step 1: Write the smoke `scripts/smoke-google-map.ts`**

It drives the **real** installed Google client and replaces only gaxios' HTTP adapter (`Gaxios.prototype._defaultAdapter`), so every error is the shape the library really throws. It refuses to run if the client, the auth library and googleapis-common don't share that one gaxios, and its last check asserts that every request was answered by the fake. The abort case calls the real node-fetch with an already-aborted signal, which rejects before opening a socket (and the URL points at `127.0.0.1:9` all the same). The parity check runs `calendar.ts`'s `fetchTodayEvents` (today's inline mapper) against the same fake answers. `error-capture` is stubbed in require's cache, so Sentry never loads.

```ts
// Smoke test for the calendar reader's pure Google rules (spec §2.5):
// src/services/calendar-read/google-map.ts (classifyGoogleError, keepGoogleEvent,
// mapGoogleEvent) and htmlToText in src/utils/html.ts.
//
// The errors are real: the installed Google client (@googleapis/calendar with its own
// google-auth-library and gaxios) runs for real, and only its HTTP adapter is replaced,
// so every error below is what that library throws for that answer from Google. The
// parity check runs calendar.ts's fetchTodayEvents (today's mapper) against the same
// fake answers. No network: a request to anything but the fake fails the smoke.
//
// Run under both clocks; the output must not depend on the server's timezone:
//   TZ=UTC npx tsx scripts/smoke-google-map.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-google-map.ts

import path from 'path';
import { createRequire } from 'module';
import type { calendar_v3 } from '@googleapis/calendar';
import type { CalendarEvent } from '../src/types';

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

function assertEq(got: unknown, want: unknown, what: string) {
  assert(JSON.stringify(got) === JSON.stringify(want), `${what}\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`);
}

// ---- The fake Google: the library's own HTTP adapter, replaced ----------------------

type GaxiosOpts = Record<string, unknown> & { url?: unknown };
type Answer = { status: number; data: unknown };
type Route = (opts: GaxiosOpts, real: (opts: GaxiosOpts) => Promise<unknown>) => Answer | Promise<Answer>;

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const TOKEN_OK: Answer = { status: 200, data: { access_token: 'fake-access', expires_in: 3600, token_type: 'Bearer' } };
const calls: string[] = [];
let route: Route = () => {
  throw new Error('no route set');
};

/** Google's JSON error body for a Calendar API call. */
const apiBody = (code: number, reason: string, message: string) => ({
  error: { code, message, errors: [{ domain: 'global', reason, message }] },
});

const calendarRequire = createRequire(require.resolve('@googleapis/calendar'));
const gaxiosModule = calendarRequire('gaxios') as {
  Gaxios: { prototype: { _defaultAdapter: (this: unknown, opts: GaxiosOpts) => Promise<unknown> } };
};
const nodeFetch = createRequire(calendarRequire.resolve('gaxios'))('node-fetch') as {
  FetchError: new (message: string, type: string, systemError?: { code: string }) => Error;
};

function installFakeGoogle(): void {
  // The calendar client, its auth library and their transports must all share the one
  // gaxios whose adapter is replaced; otherwise a request could reach the network.
  const authGaxios = createRequire(calendarRequire.resolve('google-auth-library'))('gaxios');
  const commonGaxios = createRequire(calendarRequire.resolve('googleapis-common'))('gaxios');
  if (authGaxios !== gaxiosModule || commonGaxios !== gaxiosModule) {
    console.error('FAIL  the Google client loads more than one gaxios; refusing to run without the fake');
    process.exit(1);
  }
  const real = gaxiosModule.Gaxios.prototype._defaultAdapter;
  gaxiosModule.Gaxios.prototype._defaultAdapter = async function (this: unknown, opts: GaxiosOpts) {
    const url = String(opts.url);
    calls.push(url);
    const answer = await route(opts, (o) => real.call(this, o));
    return { config: opts, data: answer.data, headers: {}, status: answer.status, statusText: String(answer.status), request: { responseURL: url } };
  };
}

/** The calendar id and resource of a Calendar API URL ('get' for calendars.get, 'events' for events.list). */
function apiTarget(url: string): { calendarId: string; resource: 'get' | 'events' } {
  const m = new URL(url).pathname.match(/^\/calendar\/v3\/calendars\/([^/]+)(\/events)?$/);
  if (!m) throw new Error(`unexpected URL ${url}`);
  return { calendarId: decodeURIComponent(m[1]), resource: m[2] ? 'events' : 'get' };
}

async function main() {
  installFakeGoogle();

  // calendar.ts loads Sentry through error-capture; the stub goes into require's cache first.
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
  stub('lib/error-capture.ts', { captureError: () => {} });

  const { auth, calendar: googleCalendar } = await import('@googleapis/calendar');
  const { classifyGoogleError, keepGoogleEvent, mapGoogleEvent } = await import('../src/services/calendar-read/google-map');
  const { htmlToText } = await import('../src/utils/html');
  const { fetchTodayEvents } = await import('../src/services/calendar');

  const newAuth = () => {
    const client = new auth.OAuth2('fake-client-id', 'fake-client-secret');
    client.setCredentials({ refresh_token: 'fake-refresh-token' });
    return client;
  };

  /** What the token step (auth.getAccessToken) throws when the token endpoint answers `answer`. */
  async function tokenStepError(answer: Answer | ((opts: GaxiosOpts) => never)): Promise<unknown> {
    route = (opts) => {
      if (String(opts.url) !== TOKEN_URL) throw new Error(`unexpected URL ${String(opts.url)}`);
      return typeof answer === 'function' ? answer(opts) : answer;
    };
    try {
      await newAuth().getAccessToken();
    } catch (e) {
      return e;
    }
    throw new Error('the token step did not fail');
  }

  /** What events.list throws when the token is fine and the Calendar API answers `api`. */
  async function listError(api: Route): Promise<unknown> {
    route = (opts, real) => (String(opts.url) === TOKEN_URL ? TOKEN_OK : api(opts, real));
    const cal = googleCalendar({ version: 'v3', auth: newAuth() });
    try {
      await cal.events.list(
        { calendarId: 'family@group.calendar.google.com', timeMin: '2026-10-16T00:00:00Z', timeMax: '2026-10-17T00:00:00Z', singleEvents: true },
        { retryConfig: { retry: 1, noResponseRetries: 0 } },
      );
    } catch (e) {
      return e;
    }
    throw new Error('events.list did not fail');
  }

  type Shape = {
    constructor?: { name?: string };
    message?: string;
    status?: number;
    code?: unknown;
    response?: { status?: number; data?: { error?: unknown } };
    error?: { name?: string; type?: string };
  };
  const shape = (e: unknown) => e as Shape;

  // ---- classifyGoogleError on the token step ------------------------------------------

  await check('token step: invalid_grant (HTTP 400) is a dead token', async () => {
    const e = await tokenStepError({ status: 400, data: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } });
    const s = shape(e);
    assert(s.constructor?.name === 'GaxiosError' && s.message === 'invalid_grant' && s.status === 400 && s.code === undefined, `shape ${JSON.stringify({ name: s.constructor?.name, message: s.message, status: s.status, code: s.code })}`);
    assertEq(classifyGoogleError(e), 'token', 'class');
  });

  await check('token step: invalid_grant needing re-auth (message rewritten to JSON) is a dead token', async () => {
    const e = await tokenStepError({ status: 400, data: { error: 'invalid_grant', error_description: 'reauth related error (invalid_rapt)' } });
    assert(shape(e).message?.startsWith('{') === true, `message ${shape(e).message}`);
    assertEq(classifyGoogleError(e), 'token', 'class');
  });

  await check('token step: admin_policy_enforced is a dead token', async () => {
    const e = await tokenStepError({ status: 400, data: { error: 'admin_policy_enforced', error_description: 'Blocked by the Workspace admin.' } });
    assertEq(classifyGoogleError(e), 'token', 'class');
  });

  for (const oauth of ['invalid_client', 'unauthorized_client']) {
    await check(`token step: ${oauth} (HTTP 401) is our server config, not the user's token`, async () => {
      const e = await tokenStepError({ status: 401, data: { error: oauth, error_description: 'Unauthorized' } });
      const s = shape(e);
      assert(s.status === 401 && s.response?.status === 401 && s.response?.data?.error === oauth, `shape ${JSON.stringify({ status: s.status, response: s.response?.status, error: s.response?.data?.error })}`);
      assertEq(classifyGoogleError(e), 'config', 'class');
    });
  }

  await check('token step: a bare 401 with no OAuth error string is a dead token', async () => {
    const e = await tokenStepError({ status: 401, data: 'Unauthorized' });
    assertEq(classifyGoogleError(e), 'token', 'class');
  });

  await check('token step: a network error on the /token URL is transient (the old check read "token" in the URL as a dead token)', async () => {
    const e = await tokenStepError((opts) => {
      throw new nodeFetch.FetchError(`request to ${String(opts.url)} failed, reason: getaddrinfo ENOTFOUND oauth2.googleapis.com`, 'system', { code: 'ENOTFOUND' });
    });
    const s = shape(e);
    assert(s.message?.includes('/token') === true && s.code === 'ENOTFOUND' && s.response === undefined, `shape ${JSON.stringify({ message: s.message, code: s.code })}`);
    assertEq(classifyGoogleError(e), 'transient', 'class');
  });

  // ---- classifyGoogleError on events.list ---------------------------------------------

  await check('events.list: a bare 401 (invalid credentials) is a dead token', async () => {
    const e = await listError(() => ({ status: 401, data: apiBody(401, 'authError', 'Invalid Credentials') }));
    assert(shape(e).status === 401 && shape(e).code === 401, `status ${shape(e).status} code ${String(shape(e).code)}`);
    assertEq(classifyGoogleError(e), 'token', 'class');
  });

  for (const reason of ['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded', 'dailyLimitExceeded']) {
    await check(`events.list: a 403 ${reason} is transient`, async () => {
      const e = await listError(() => ({ status: 403, data: apiBody(403, reason, 'Rate Limit Exceeded') }));
      assertEq(classifyGoogleError(e), 'transient', 'class');
    });
  }

  await check('events.list: a 403 for missing permissions is scopes', async () => {
    const e = await listError(() => ({ status: 403, data: apiBody(403, 'insufficientPermissions', 'Insufficient Permission') }));
    assertEq(classifyGoogleError(e), 'scopes', 'class');
  });

  await check('events.list: any other 403 is unknown, not a dead token', async () => {
    const e = await listError(() => ({ status: 403, data: apiBody(403, 'forbidden', 'Forbidden') }));
    assertEq(classifyGoogleError(e), 'unknown', 'class');
  });

  for (const [status, reason] of [[404, 'notFound'], [410, 'deleted']] as const) {
    await check(`events.list: ${status} means the calendar is gone`, async () => {
      const e = await listError(() => ({ status, data: apiBody(status, reason, 'Not Found') }));
      assertEq(classifyGoogleError(e), 'gone', 'class');
    });
  }

  for (const [status, data] of [
    [408, apiBody(408, 'requestTimeout', 'Request Timeout')],
    [429, apiBody(429, 'rateLimitExceeded', 'Rate Limit Exceeded')],
    [500, apiBody(500, 'backendError', 'Backend Error')],
    [503, '<html><body>Service Unavailable</body></html>'],
  ] as const) {
    await check(`events.list: ${status} is transient`, async () => {
      const e = await listError(() => ({ status, data }));
      assertEq(classifyGoogleError(e), 'transient', 'class');
    });
  }

  await check('events.list: ECONNRESET (no response, a string code) is transient', async () => {
    const e = await listError((opts) => {
      throw new nodeFetch.FetchError(`request to ${String(opts.url)} failed, reason: socket hang up`, 'system', { code: 'ECONNRESET' });
    });
    assert(shape(e).code === 'ECONNRESET' && shape(e).response === undefined, `code ${String(shape(e).code)}`);
    assertEq(classifyGoogleError(e), 'transient', 'class');
  });

  await check('events.list: a node-fetch request-timeout is transient', async () => {
    const e = await listError((opts) => {
      throw new nodeFetch.FetchError(`network timeout at: ${String(opts.url)}`, 'request-timeout');
    });
    assert(shape(e).error?.type === 'request-timeout' && shape(e).code === undefined, `error.type ${shape(e).error?.type}`);
    assertEq(classifyGoogleError(e), 'transient', 'class');
  });

  await check('events.list: an aborted request (node-fetch AbortError) is transient', async () => {
    // The real fetch, with a signal already aborted: it rejects before opening a socket
    // (and the URL is pointed at the local discard port all the same).
    const e = await listError(async (opts, real) => {
      await real({ ...opts, url: 'http://127.0.0.1:9/', agent: undefined, signal: AbortSignal.abort() });
      throw new Error('the aborted fetch answered');
    });
    assert(shape(e).error?.name === 'AbortError', `error.name ${shape(e).error?.name}`);
    assertEq(classifyGoogleError(e), 'transient', 'class');
  });

  await check('non-Google errors are unknown; a plain { code } object is read by its code', () => {
    assertEq(classifyGoogleError(new Error('boom')), 'unknown', 'Error');
    assertEq(classifyGoogleError(null), 'unknown', 'null');
    assertEq(classifyGoogleError(undefined), 'unknown', 'undefined');
    assertEq(classifyGoogleError('invalid_grant'), 'unknown', 'a string');
    assertEq(classifyGoogleError({ code: 403, message: 'Insufficient Permission' }), 'scopes', '{ code: 403 } scopes');
    assertEq(classifyGoogleError({ code: 503, message: 'Backend Error' }), 'transient', '{ code: 503 }');
  });

  // ---- keepGoogleEvent ----------------------------------------------------------------

  const timed = { dateTime: '2026-10-16T09:00:00+03:00' };
  const base = (extra: calendar_v3.Schema$Event = {}): calendar_v3.Schema$Event =>
    ({ id: 'e1', status: 'confirmed', summary: 'Dentist', start: timed, end: { dateTime: '2026-10-16T10:00:00+03:00' }, ...extra });

  await check('keepGoogleEvent: drops working location, out of office and focus time; keeps every other type', () => {
    for (const t of ['workingLocation', 'outOfOffice', 'focusTime']) assert(!keepGoogleEvent(base({ eventType: t })), `kept ${t}`);
    for (const t of ['default', 'birthday', 'fromGmail', 'someTypeGoogleAddsLater']) assert(keepGoogleEvent(base({ eventType: t })), `dropped ${t}`);
    assert(keepGoogleEvent(base()), 'dropped an event with no eventType');
  });

  await check('keepGoogleEvent: drops cancelled; keeps confirmed and tentative', () => {
    assert(!keepGoogleEvent(base({ status: 'cancelled' })), 'kept cancelled');
    assert(keepGoogleEvent(base({ status: 'tentative' })), 'dropped tentative');
    assert(keepGoogleEvent(base({ status: undefined })), 'dropped no status');
  });

  await check('keepGoogleEvent: drops an event with no start; keeps all-day and timed', () => {
    assert(!keepGoogleEvent(base({ start: undefined })), 'kept no start');
    assert(!keepGoogleEvent(base({ start: {} })), 'kept a start with neither date nor dateTime');
    assert(keepGoogleEvent(base({ start: { date: '2026-10-16' }, end: { date: '2026-10-17' } })), 'dropped all-day');
  });

  await check('keepGoogleEvent: drops what the calendar\'s owner declined, only that', () => {
    assert(!keepGoogleEvent(base({ attendees: [{ self: true, responseStatus: 'declined' }] })), 'kept declined by self');
    assert(keepGoogleEvent(base({ attendees: [{ self: true, responseStatus: 'accepted' }, { responseStatus: 'declined' }] })), 'dropped declined by another attendee');
    assert(keepGoogleEvent(base({ attendees: [{ responseStatus: 'declined' }] })), 'dropped a decline that is not self');
    for (const r of ['tentative', 'needsAction', 'accepted']) assert(keepGoogleEvent(base({ attendees: [{ self: true, responseStatus: r }] })), `dropped self ${r}`);
  });

  // ---- htmlToText ---------------------------------------------------------------------

  await check('htmlToText: a missing description is empty', () => {
    assertEq([htmlToText(undefined), htmlToText(null), htmlToText('')], ['', '', ''], 'empty');
  });

  await check('htmlToText: plain text passes through unchanged', () => {
    for (const s of ['Bring the cake\n\n\n\nand candles  ', 'a < b and c > d', 'Tom & Jerry', 'AT&T; call first', 'שלום, Привет 🎂']) assertEq(htmlToText(s), s, 'plain');
  });

  await check('htmlToText: entities are decoded once', () => {
    assertEq(htmlToText('Tom &amp; Jerry'), 'Tom & Jerry', '&amp;');
    assertEq(htmlToText('&lt;b&gt;not bold&lt;/b&gt;'), '<b>not bold</b>', 'escaped tags stay text');
    assertEq(htmlToText('&amp;lt;'), '&lt;', 'double-escaped');
    assertEq(htmlToText('&quot;Hi&quot; &apos;there&#39;'), '"Hi" \'there\'', 'quotes');
    assertEq(htmlToText('&#1513;&#1500;&#1493;&#1501; &#x1F382;'), 'שלום 🎂', 'numeric');
    assertEq(htmlToText('a&nbsp;b &ndash; c&hellip;'), 'a b – c…', 'named');
    assertEq(htmlToText('<b>x</b> &bogus; &#0; &#xD800;'), 'x &bogus; &#0; &#xD800;', 'unknown and invalid kept');
  });

  await check('htmlToText: line tags become newlines, list items bullets', () => {
    assertEq(htmlToText('One<br>Two<br/>Three<BR />Four'), 'One\nTwo\nThree\nFour', 'br');
    assertEq(htmlToText('<p>First</p><p>Second</p>'), 'First\nSecond', 'p');
    assertEq(htmlToText('<div>a</div><div><br></div><div>b</div>'), 'a\n\nb', 'div with a blank line');
    assertEq(htmlToText('<ul><li>milk</li><li>eggs</li></ul>'), '• milk\n• eggs', 'li');
  });

  await check('htmlToText: links keep their address', () => {
    assertEq(htmlToText('<a href="https://zoom.us/j/1">Join Zoom</a>'), 'Join Zoom (https://zoom.us/j/1)', 'text and address');
    assertEq(htmlToText('<a href="https://x.com/a?b=1&amp;c=2">https://x.com/a?b=1&amp;c=2</a>'), 'https://x.com/a?b=1&c=2', 'text is the address');
    assertEq(htmlToText("<a href='https://x.com'>https://x.com</a>"), 'https://x.com', 'single quotes');
    assertEq(htmlToText('<a href="https://x.com"><b>Site</b></a>'), 'Site (https://x.com)', 'tags inside the text');
    assertEq(htmlToText('<a href="https://x.com"></a>'), 'https://x.com', 'no text');
    assertEq(htmlToText('<a name="top">Top</a>'), 'Top', 'no href');
    assertEq(htmlToText('<a href="mailto:dana@example.com">dana@example.com</a>'), 'dana@example.com', 'mailto with the address as text');
  });

  await check('htmlToText: other tags are stripped, blank lines collapse, ends are trimmed', () => {
    assertEq(htmlToText('<b>Bold</b> and <span style="color:red">red</span>'), 'Bold and red', 'inline tags');
    assertEq(htmlToText('<style>p { color: red }</style><!-- note -->Hi'), 'Hi', 'style block and comment');
    assertEq(htmlToText('a<br><br><br><br>b'), 'a\n\nb', 'blank lines');
    assertEq(htmlToText('<br>Hi<br>'), 'Hi', 'trimmed');
    assertEq(htmlToText('<br>'), '', 'nothing left');
  });

  await check('htmlToText: a Google Calendar description reads as text', () => {
    const html = '<b>Agenda</b><br><ul><li>Budget</li><li>Trip</li></ul><br>Join: <a href="https://meet.google.com/abc-defg-hij">https://meet.google.com/abc-defg-hij</a>';
    assertEq(htmlToText(html), 'Agenda\n• Budget\n• Trip\n\nJoin: https://meet.google.com/abc-defg-hij', 'description');
  });

  await check('htmlToText: <…> around a link, an address or a word is text, not a tag (Teams, Outlook and Zoom invites)', () => {
    const teams = 'Click here to join the meeting<https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc>\nOrganizer: Dana Levi <dana@corp.com>';
    assertEq(htmlToText(teams), teams, 'a plain-text Teams invite');
    assertEq(htmlToText('Use the <Back> door'), 'Use the <Back> door', 'a word in angle brackets');
    const zoom = 'Zoom: <https://zoom.us/j/123?pwd=abc>\nHosts: Bo Levi <b.levi@corp.com>, Li Wang <li.wang@corp.com>, <a.cohen@corp.com>';
    assertEq(htmlToText(zoom), zoom, 'addresses that start like a tag name');
    assertEq(htmlToText('<p>Join: &lt;https://x.y&gt;</p>'), 'Join: <https://x.y>', 'an escaped link in HTML decodes to text');
    assertEq(
      htmlToText('<b>Microsoft Teams</b><br>Join<https://teams.microsoft.com/l/x><br>Li Wang <li.wang@corp.com>'),
      'Microsoft Teams\nJoin<https://teams.microsoft.com/l/x>\nLi Wang <li.wang@corp.com>',
      'raw <…> inside HTML stays',
    );
    assertEq(htmlToText('<html-blob><u>Notes</u><o:p></o:p></html-blob><H1>Agenda</H1>'), 'NotesAgenda', 'Google\'s and Outlook\'s own tags still go');
  });

  await check('htmlToText: the cut is 500 code points and never splits an emoji', () => {
    const cut = htmlToText('a'.repeat(499) + '😀😀');
    assertEq(cut, 'a'.repeat(499) + '😀', 'emoji at the edge');
    assertEq(Array.from(htmlToText('ש'.repeat(600))).length, 500, 'plain text is cut too');
    assertEq(htmlToText('<b>' + 'é'.repeat(600) + '</b>'), 'é'.repeat(500), 'the cut counts the text, not the tags');
    assertEq(htmlToText('abcdefghij', 5), 'abcde', 'max');
  });

  // ---- mapGoogleEvent -----------------------------------------------------------------

  const FAMILY = 'family@group.calendar.google.com';
  const DANA = 'dana@example.com';
  const LISTS: Record<string, { summary?: string; items: calendar_v3.Schema$Event[] }> = {
    [FAMILY]: {
      summary: 'Family',
      items: [
        { id: 'ev-dentist', summary: 'Dentist', start: { dateTime: '2026-10-16T09:00:00+03:00' }, end: { dateTime: '2026-10-16T10:00:00+03:00' }, location: 'Haifa', description: 'Bring the forms', htmlLink: 'https://www.google.com/calendar/event?eid=1' },
        { id: 'ev-trip', summary: 'Trip', start: { date: '2026-10-16' }, end: { date: '2026-10-19' }, description: '' },
        { id: 'ev-untitled', start: { dateTime: '2026-10-16T12:00:00+03:00' }, end: { dateTime: '2026-10-16T12:30:00+03:00' } },
        { id: 'ev-swim_20261016T150000Z', summary: 'Swim', recurringEventId: 'ev-swim', originalStartTime: { dateTime: '2026-10-16T18:00:00+03:00' }, start: { dateTime: '2026-10-16T18:30:00+03:00' }, end: { dateTime: '2026-10-16T19:30:00+03:00' }, reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 30 }] } },
      ],
    },
    [DANA]: {
      items: [
        { id: 'ev-bday', summary: 'Noa', eventType: 'birthday', recurringEventId: 'ev-bday-series', originalStartTime: { date: '2026-10-16' }, start: { date: '2026-10-16' }, end: { date: '2026-10-17' } },
        { id: 'ev-holiday', summary: 'Sukkot', eventType: 'default', start: { date: '2026-10-16' }, end: { date: '2026-10-17' }, reminders: { useDefault: true } },
      ],
    },
  };
  const calendarNameOf = (id: string) => LISTS[id].summary || id;

  /** Sorted keys, so the comparison is about values only. */
  const canon = (o: object) => JSON.stringify(o, Object.keys(o).sort());

  await check('mapGoogleEvent: event equals today\'s day mapper (calendar.ts fetchTodayEvents) plus provider, minus reminders', async () => {
    route = (opts) => {
      const url = String(opts.url);
      if (url === TOKEN_URL) return TOKEN_OK;
      const { calendarId, resource } = apiTarget(url);
      const list = LISTS[calendarId];
      if (!list) return { status: 404, data: apiBody(404, 'notFound', 'Not Found') };
      return resource === 'get' ? { status: 200, data: { id: calendarId, summary: list.summary } } : { status: 200, data: { items: list.items } };
    };
    const today: CalendarEvent[] = await fetchTodayEvents('fake-refresh-token', [FAMILY, DANA], 'Asia/Jerusalem');
    assertEq(today.length, 6, 'events from today\'s mapper');
    for (const old of today) {
      const raw = LISTS[old.calendarId].items.find((r) => r.id === old.eventId);
      assert(raw !== undefined, `no fixture for ${old.eventId}`);
      const want: Record<string, unknown> = { ...old, provider: 'google' };
      delete want.reminders;
      const got = mapGoogleEvent(raw, old.calendarId, calendarNameOf(old.calendarId)).event;
      assert(canon(got) === canon(want), `${old.eventId}\n     got  ${canon(got)}\n     want ${canon(want)}`);
    }
  });

  await check('mapGoogleEvent: the reader fields', () => {
    const [dentist, , untitled, swim] = LISTS[FAMILY].items;
    const [bday] = LISTS[DANA].items;
    const d = mapGoogleEvent(dentist, FAMILY, 'Family');
    assertEq(
      { source: d.source, key: d.key, title: d.title, kind: d.kind, seriesId: d.seriesId, originalStart: d.originalStart, recurring: d.recurring, rrule: d.rrule, google: d.google },
      { source: 'google', key: 'google|family@group.calendar.google.com|ev-dentist', title: 'Dentist', kind: 'event', seriesId: null, originalStart: null, recurring: false, rrule: null, google: { birthday: false, htmlLink: 'https://www.google.com/calendar/event?eid=1' } },
      'a one-off',
    );
    assert(!('calendar' in d) && !('state' in d), 'calendar or state set');
    const u = mapGoogleEvent(untitled, FAMILY, 'Family');
    assertEq([u.title, u.event.summary, u.google?.htmlLink], [null, 'No title', null], 'no title: raw null, the summary keeps "No title"');
    const s = mapGoogleEvent(swim, FAMILY, 'Family');
    assertEq([s.seriesId, s.originalStart, s.recurring], ['ev-swim', '2026-10-16T18:00:00+03:00', true], 'a moved recurring instance');
    const b = mapGoogleEvent(bday, DANA, DANA);
    assertEq([b.google?.birthday, b.originalStart, b.event.eventType, b.event.calendarName], [true, '2026-10-16', 'birthday', DANA], 'a birthday');
  });

  await check('mapGoogleEvent: an HTML description becomes text; one with no text is dropped', () => {
    const html = mapGoogleEvent({ id: 'h', summary: 'Call', start: timed, description: 'Dial in:<br><a href="https://meet.google.com/x">Meet</a>' }, FAMILY, 'Family');
    assertEq(html.event.description, 'Dial in:\nMeet (https://meet.google.com/x)', 'description');
    const empty = mapGoogleEvent({ id: 'h2', summary: 'Call', start: timed, description: '<br>' }, FAMILY, 'Family');
    assert(empty.event.description === undefined, `got ${JSON.stringify(empty.event.description)}`);
  });

  await check('the fake answered every request (nothing went past it)', () => {
    assert(calls.length > 0 && calls.every((u) => u === TOKEN_URL || u.startsWith('https://www.googleapis.com/calendar/v3/') || u === 'http://127.0.0.1:9/'), `calls ${JSON.stringify(calls)}`);
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
  console.error('FAIL  smoke crashed:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Run it on today's code and watch it fail**

```bash
cd /Users/razielgershoni/development/famcalbot
TZ=UTC DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-google-map.ts; echo "exit=$?"
```

Expected: `FAIL  smoke crashed: Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../src/services/calendar-read/google-map'` and `exit=1`.

- [ ] **Step 3: Add `htmlToText` to `src/utils/html.ts`**

Edit 3a, the header comment (lines 1-7). Replace:
```ts
/**
 * HTML escaping for Telegram's parse_mode 'HTML'. Every user-supplied string (titles,
 * names, places) goes through escapeHtml before it is put into a message.
 *
```
with:
```ts
/**
 * HTML escaping for Telegram's parse_mode 'HTML'. Every user-supplied string (titles,
 * names, places) goes through escapeHtml before it is put into a message. Also
 * htmlToText, which reads a Google event description (HTML) as plain text.
 *
```

Edit 3b: append after the end of `escapeHtml`, the end of the file (line 12 before Edit 3a, line 13 after it). Add one blank line, then:
```ts
/** The named entities Google descriptions use; anything else is left as written. */
const NAMED_ENTITIES = new Map<string, string>([
  ['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"], ['nbsp', ' '],
  ['ndash', '–'], ['mdash', '—'], ['hellip', '…'], ['bull', '•'], ['middot', '·'],
  ['lsquo', '‘'], ['rsquo', '’'], ['ldquo', '“'], ['rdquo', '”'], ['laquo', '«'], ['raquo', '»'],
  ['copy', '©'], ['reg', '®'], ['trade', '™'], ['euro', '€'], ['deg', '°'], ['times', '×'], ['shy', ''],
]);
const ENTITY = /&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/g;
/**
 * The elements descriptions are written with: Google's editor and its <html-blob>
 * wrapper, Outlook and Teams invites (Word's <o:p> too), pasted web text. Only these are
 * tags, and only where the name ends (a space, "/" or ">"), so the "<https://…>",
 * "<dana@corp.com>" and "<b.levi@corp.com>" of a plain-text invite, or a "<Back>", are text.
 */
const TAG_NAMES = [
  'a', 'abbr', 'b', 'big', 'blockquote', 'body', 'br', 'caption', 'center', 'cite', 'code', 'col', 'colgroup',
  'dd', 'del', 'div', 'dl', 'dt', 'em', 'font', 'h[1-6]', 'head', 'hr', 'html', 'html-blob', 'i', 'img', 'ins',
  'kbd', 'li', 'mark', 'meta', 'o:p', 'ol', 'p', 'pre', 'q', 's', 'samp', 'script', 'small', 'span', 'strike',
  'strong', 'style', 'sub', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'title', 'tr', 'tt', 'u', 'ul', 'wbr',
].join('|');
/** One tag, opening or closing, any case: a TAG_NAMES name, then its attributes up to ">". */
const TAG = `</?(?:${TAG_NAMES})(?=[\\s/>])[^>]*>`;
const HAS_TAG = new RegExp(`${TAG}|<!--`, 'i');
const HAS_ENTITY = new RegExp(`&(?:#\\d{1,7}|#[xX][0-9a-fA-F]{1,6}|${[...NAMED_ENTITIES.keys()].join('|')});`);
const ANY_TAG = new RegExp(TAG, 'gi');

/** Decodes each entity once, so '&amp;lt;' is '&lt;'. Unknown names and invalid code points stay. */
function decodeEntities(text: string): string {
  return text.replace(ENTITY, (whole, body: string) => {
    if (body[0] !== '#') return NAMED_ENTITIES.get(body) ?? whole;
    const cp = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    return cp > 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff) ? String.fromCodePoint(cp) : whole;
  });
}

/** An <a> as text: "t (u)", or u alone when the text is the address (mailto:/tel: aside). */
function linkText(attrs: string, inner: string): string {
  const href = attrs.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i);
  const url = (href?.[1] ?? href?.[2] ?? href?.[3] ?? '').trim();
  const text = inner.replace(ANY_TAG, '').trim();
  if (!url) return text;
  const shownText = decodeEntities(text);
  const shownUrl = decodeEntities(url);
  if (!shownText || shownText === shownUrl) return url;
  if (shownText === shownUrl.replace(/^(?:mailto|tel):/i, '')) return text;
  // Raw text and address: decodeEntities runs once on the whole result.
  return `${text} (${url})`;
}

function htmlToPlain(html: string): string {
  const text = html
    .replace(/\r\n?/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)(?=[\s/>])[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<a(?=[\s>])([^>]*)>((?:(?!<\/?a[\s>])[\s\S])*?)<\/a\s*>/gi, (_whole, attrs: string, inner: string) => linkText(attrs, inner))
    .replace(/<br(?=[\s/>])[^>]*>/gi, '\n')
    .replace(/<\/(?:p|div|li)\s*>/gi, '\n')
    .replace(/<li(?=[\s/>])[^>]*>/gi, '• ')
    .replace(ANY_TAG, '');
  return decodeEntities(text)
    .replace(/ /g, ' ')
    .replace(/[ \t]+$/gm, '')
    .replace(/^[ \t]+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * A Google event description as plain text. Google keeps descriptions as HTML ("Line
 * one<br>Line two", links, "&amp;"); the home shows the text and the summaries put it in
 * the prompt, so both read the same thing.
 * - <br>, </p>, </li> and </div> become a newline, <li> becomes "• ";
 * - <a href=u>t</a> becomes "t (u)", or u when the text is the address;
 * - other tags go (a <style> or <script> block with its content), entities are decoded;
 * - runs of blank lines collapse to one, and the ends are trimmed.
 * A tag is an HTML element's (TAG_NAMES): "<https://…>" or "<dana@corp.com>" is text.
 * Text with no tags and no entities passes through unchanged. The result is cut at `max`
 * code points, so an emoji is never split. A missing description is ''.
 */
export function htmlToText(s: string | null | undefined, max = 500): string {
  if (!s) return '';
  const text = HAS_TAG.test(s) || HAS_ENTITY.test(s) ? htmlToPlain(s) : s;
  const points = Array.from(text);
  return points.length > max ? points.slice(0, max).join('') : text;
}
```

- [ ] **Step 4: Create `src/services/calendar-read/google-map.ts`**

```ts
// The calendar reader's pure Google rules (spec §2.5): which error is which, which
// events are kept, and how a Google event becomes a ReadItem. No I/O and no Google
// client at run time (the calendar_v3 import is a type), so google.ts and the smokes
// share one copy of the rules.

import type { calendar_v3 } from '@googleapis/calendar';
import { htmlToText } from '../../utils/html';
import { isInsufficientScopesError } from '../../utils/errors';
import type { ReadItem } from './types';

/**
 * - scopes: the user unticked a permission on Google's consent screen;
 * - token: the refresh token is dead (revoked, expired, blocked by an admin);
 * - config: Google rejects our OAuth client, which breaks every user;
 * - gone: the calendar was deleted or unshared, or is on another account;
 * - transient: rate limits, timeouts, Google's own failures, the network;
 * - unknown: anything else.
 */
export type GoogleErrorClass = 'scopes' | 'token' | 'config' | 'gone' | 'transient' | 'unknown';

const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded', 'dailyLimitExceeded']);

/** What the Google client's errors carry (gaxios GaxiosError, after google-auth-library's processError). */
interface GoogleErrorShape {
  name?: unknown;
  code?: unknown;
  status?: unknown;
  type?: unknown;
  errors?: unknown;
  response?: { status?: unknown; data?: unknown } | null;
  error?: { name?: unknown; type?: unknown } | null;
}

/** The token endpoint's OAuth error ('invalid_grant', ...), when the body carries one. */
function oauthError(data: unknown): string | undefined {
  const error = data && typeof data === 'object' ? (data as { error?: unknown }).error : undefined;
  return typeof error === 'string' ? error : undefined;
}

/** The HTTP status: the response's, else the error's, else a numeric code (an API error body's). */
function httpStatus(err: GoogleErrorShape): number | undefined {
  for (const s of [err.response?.status, err.status, err.code]) if (typeof s === 'number') return s;
  return undefined;
}

/** The Calendar API's error reasons ('rateLimitExceeded', ...). */
function errorReasons(err: GoogleErrorShape): string[] {
  const data = err.response?.data;
  const body = data && typeof data === 'object' ? (data as { error?: { errors?: unknown } }).error : undefined;
  const list = Array.isArray(err.errors) ? err.errors : body && typeof body === 'object' && Array.isArray(body.errors) ? body.errors : [];
  return list.map((x: unknown) => (x && typeof x === 'object' ? (x as { reason?: unknown }).reason : undefined)).filter((r): r is string => typeof r === 'string');
}

/**
 * Sorts a Google error into the class that decides the source's status (spec §2.5).
 * The OAuth strings come before the status: Google's token endpoint sends invalid_client,
 * and often unauthorized_client, with HTTP 401. The old isTokenError stays for every
 * other path.
 */
export function classifyGoogleError(e: unknown): GoogleErrorClass {
  if (isInsufficientScopesError(e)) return 'scopes';
  if (!e || typeof e !== 'object') return 'unknown';
  const err = e as GoogleErrorShape;
  const oauth = oauthError(err.response?.data);
  if (oauth === 'invalid_grant' || oauth === 'admin_policy_enforced') return 'token';
  if (oauth === 'invalid_client' || oauth === 'unauthorized_client') return 'config';
  const status = httpStatus(err);
  if (status === 401) return 'token';
  if (status === 404 || status === 410) return 'gone';
  if (status === 403 && errorReasons(err).some((r) => RATE_LIMIT_REASONS.has(r))) return 'transient';
  if (status === 408 || status === 429 || (status !== undefined && status >= 500)) return 'transient';
  // gaxios keeps the fetch error it wraps on `error`: node-fetch's request-timeout and AbortError.
  const cause = err.error && typeof err.error === 'object' ? err.error : undefined;
  if (!err.response && (typeof err.code === 'string' || err.type === 'request-timeout' || cause?.type === 'request-timeout')) return 'transient';
  if (err.name === 'AbortError' || cause?.name === 'AbortError') return 'transient';
  return 'unknown';
}

/** Not events: Google's work-status blocks (Ruling R1). Every other type is kept, birthdays included. */
const DROPPED_EVENT_TYPES = new Set(['workingLocation', 'outOfOffice', 'focusTime']);

/**
 * Whether a listed Google event is shown. Drops cancelled ones, ones with no start, the
 * work-status types, and invites the calendar's owner declined (Ruling R2: `self` is the
 * calendar this copy sits on, so on a spouse's calendar it is the spouse's decline).
 */
export function keepGoogleEvent(raw: calendar_v3.Schema$Event): boolean {
  if (raw.status === 'cancelled') return false;
  if (!raw.start?.dateTime && !raw.start?.date) return false;
  if (raw.eventType && DROPPED_EVENT_TYPES.has(raw.eventType)) return false;
  if (raw.attendees?.some((a) => a.self && a.responseStatus === 'declined')) return false;
  return true;
}

/**
 * A Google event as the reader's item, without its calendar (google.ts joins that from
 * the assignment at read time). `event` is today's day mapper (calendar.ts fetchEvents)
 * plus the provider tag, without `reminders`, and with the description as plain text.
 */
export function mapGoogleEvent(raw: calendar_v3.Schema$Event, calendarId: string, calendarName: string): Omit<ReadItem, 'calendar'> {
  return {
    source: 'google',
    key: `google|${calendarId}|${raw.id ?? ''}`,
    event: {
      summary: raw.summary || 'No title',
      start: raw.start?.dateTime || raw.start?.date || '',
      end: raw.end?.dateTime || raw.end?.date || '',
      description: htmlToText(raw.description) || undefined,
      location: raw.location || undefined,
      calendarName,
      calendarId,
      eventType: raw.eventType || undefined,
      recurringEventId: raw.recurringEventId || undefined,
      eventId: raw.id || undefined,
      provider: 'google',
    },
    title: raw.summary ?? null,
    kind: 'event',
    seriesId: raw.recurringEventId ?? null,
    originalStart: raw.originalStartTime?.dateTime ?? raw.originalStartTime?.date ?? null,
    recurring: Boolean(raw.recurringEventId),
    rrule: null,
    google: { birthday: raw.eventType === 'birthday', htmlLink: raw.htmlLink ?? null },
  };
}
```

- [ ] **Step 5: Run the smoke under both clocks and expect PASS**

```bash
cd /Users/razielgershoni/development/famcalbot
for tz in UTC Asia/Jerusalem; do
  TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-google-map.ts; echo "exit=$? ($tz)"
done
```

Expected: every line `OK`, then `41/41 passed (process TZ=UTC)` / `exit=0 (UTC)` and `41/41 passed (process TZ=Asia/Jerusalem)` / `exit=0 (Asia/Jerusalem)`. It takes about 2 s: the token-step network case waits through the auth library's own two retries, 0.6 s.

`scripts/smoke-native-reminder-support.ts` also imports `src/utils/html.ts` (`escapeHtml` is unchanged). Run it with the same env under `TZ=UTC` and expect `32/32 passed`.

- [ ] **Step 6: Type-check and lint**

```bash
cd /Users/razielgershoni/development/famcalbot
npx tsc --noEmit -p .; echo "tsc=$?"
npm run -s lint; echo "lint=$?"
```

Expected: `tsc=0` and `lint=0`, with no output from either.

- [ ] **Step 7: Commit**

```bash
cd /Users/razielgershoni/development/famcalbot
git add src/utils/html.ts src/services/calendar-read/google-map.ts scripts/smoke-google-map.ts
git commit -m "$(cat <<'EOF'
feat(calendar-read): Google error classes, event filter and mapper, htmlToText

The reader's pure Google rules (spec §2.5). classifyGoogleError tells a dead token
from a rate limit, a network error on the token URL and a bad server secret, which
the old isTokenError lumps together; it stays for every other path. keepGoogleEvent
drops cancelled events, work-status blocks and the calendar owner's declines.
mapGoogleEvent is today's day mapper with the description as plain text. Nothing
calls them yet.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
EOF
)"
```

---

### Task 5 (B5): The FamCal half of the reader (spec §2.4, edits 1 and 9)

**What and why:** The reader's FamCal half turns a built-in calendar user's occurrences in a window into `ReadItem`s, with the legend the home may show. It reuses the native provider's own read, so a summary moved onto the reader in Plan C gets exactly today's events (A-1, A-4). It also masks the partner's PRIVATE calendar on a reminder-for-me and makes no query for a Google user. Three pieces:
- **Edit 1:** `native-provider.ts` splits its private `fetchForViewer` into an exported `fetchViewerItems`, which also returns each row, its reminder state row and the viewer context. `fetchForViewer` becomes `items.map(i => i.event)`. No behaviour change.
- **Edit 9, second half:** `open-reminders.ts` gains `fetchOpenReminderItems`, which returns each carry-over's series, calendar, occurrence `instanceStartsAt` and state row. `fetchOpenReminders` and `selectOpenReminders` keep their signatures and outputs. Both now go through one private loader, so the home's carry-overs always use the digest's exact query, Plan A's wider `where` included.
- **`src/services/calendar-read/famcal.ts`:** `readFamcal`, plus `carryOverReadItems` for the route.

Nothing calls these yet. The switch ships `OFF`, and no user sees a change.

**Interface additions (no signature in the split changes):**
- `famcal.ts` also exports **`carryOverReadItems(famcal, carryOvers)`**. B8 needs it to turn `fetchOpenReminderItems` results into `ReadItem`s, using the same legend and masking rule as the rows (spec §4 step 6). The rule then lives in one place. B8 should call it rather than re-mask.
- `native-provider.ts` exports the `ViewerItem` type, and `open-reminders.ts` exports `OpenReminderItem`.
- `fetchOpenReminderItems` returns **`{ items: OpenReminderItem[]; moreCount: number }`**, mirroring `fetchOpenReminders`' `{ events, moreCount }`. B8 reads `.items`.
- `readFamcal` for a user who isn't `NATIVE` returns `{ read: { status: 'error', cause }, items: [] }` and makes **no query**. `FamcalRead` has no "absent" case, and `readRange` (B8) never calls it for those users (`sourcesFor`). The guard is there so a wrong call fails loudly in a smoke and can never touch the DB.

**Findings (read before you start):**
- **Depends on:**
  - B3: `CalendarRef`, `ReadItem` and `FamcalRead` from `src/services/calendar-read/types.ts` (spec §2.2), and `reminderDueAt` moved into `due.ts` and re-exported from `open-reminders.ts`; the smoke also runs B3's `toRangeDays` (`dto.ts`) on a moved occurrence, to see which day lists it;
  - Plan A Task 2: Edit 3d widens `fetchOpenReminders`' `where`; Edit 3a widens `rangeCandidates`.

  This task's edits to `open-reminders.ts` never touch the text of the `where`. They move the `findMany` call, whatever its `where` says, into `loadOpenReminderCandidates`. They anchor on the lines just before and just after it (Step 4, Edits 4e and 4f). Those lines are the same on `main@858886c` and after Plan A Task 2. Both were checked.
- **Line numbers** below are `main@858886c`. In `open-reminders.ts`, B3's move of `reminderDueAt` (`:29-37`) and Plan A's Edit 3d (`:136-140`) shift what follows. Match on the quoted text, which is unique in the file (checked on both versions).
- **No behaviour change for today's callers:**
  - `toViewerItems` is `toViewerEvents` returning `{ row, state?, event }`, with the same queries in the same order.
  - `selectOpenReminders` is now `selectOpenReminderItems(...).items.map(i => i.event)`: the same loop, the same stable sort and the same slice.
- **Callers of the two refactored functions:**
  - `fetchForViewer`: `fetchTodayEvents`, `fetchTomorrowEvents` and `fetchEventsInRange` (`native-provider.ts:235-260`), which serve the summaries, `/week`, the event-alert pass and the voice matcher;
  - `fetchOpenReminders`: `addDigestReminders` (`open-reminders.ts:169`) and voice (`src/services/voice/event-resolution.ts:373-383`).

  Step 6 re-runs their smokes.
- **ReadItem rules** (for B3's DTO and B8's route):
  - `source: 'famcal'`;
  - `key: 'famcal|' + event.eventId`, the provider's id: `cuid` for a one-off, `cuid#ISO` for an occurrence;
  - `title`: the instance's title, which equals `event.summary`;
  - `kind`: from the series;
  - `seriesId`: the series id;
  - `originalStart`: the instance's `instanceStartsAt` as ISO, always, one-offs included (for carry-overs, the occurrence's original slot);
  - `recurring: rrule != null`, with `rrule` from the series;
  - `state`: on every reminder, `{ doneAt, snoozedUntil }`, nulls when the occurrence has no state row; absent on events;
  - no `google` key;
  - `event` is the provider's object, untouched. Its `calendarName` and `calendarId` stay real for the summaries (A-5, A-6). Only `calendar` (the `CalendarRef`) is for the home.
- **Legend and masking:**
  - Legend = `listVisibleCalendars(user.id, user.pairingId ?? null)`, ordered by `createdAt`, narrowed to `calendarIds` when given. Ids never come from anywhere else. An id the viewer can't see, e.g. another user's calendar, is dropped, even though the provider itself would read it.
  - A legend calendar becomes `{ id: 'native:<cuid>', source, name, color, mine, ownerName (partner's name when not mine), inLegend: true }`.
  - Any other calendar becomes `{ id: null, source: 'famcal', name: partner.name, color: null, mine: false, inLegend: false }`.
  - With no legend calendar, there are no items and no event query (the provider's empty-list rule). The read still loads the viewer context, because `FamcalRead.ok` carries `ctx` and the route's carry-overs need it.
- **Errors:** any throw becomes `{ status: 'error', cause }` with no items, and nothing is logged in `famcal.ts`. Plan C's digest rethrows the cause (A-28), and the route reports the status.
- **The smoke** runs the real store, provider, ownership, user-calendars and open-reminders code over an in-memory Prisma. That Prisma knows `AND`, `OR`, the `calendar` and `instances: { some }` relation filters, `include` and `orderBy`, so it reads both `main`'s and Plan A's queries.
  - One check, the last carry-over check, needs Plan A Task 2's wider carry-over read. Without it, only that check fails, with "Plan A's wider fetchOpenReminders read is missing".
- **Verified in a scratch copy:**
  - Base: `main@858886c` with Plan A Task 2 applied from its draft (all of edits 1a–1k and 3a–3e), plus minimal B3 stand-ins (the two type files and the `reminderDueAt` move).
  - Before this task: the new smoke exits 1 with `ERR_MODULE_NOT_FOUND`.
  - After: 21/21 under `TZ=UTC` and `TZ=Asia/Jerusalem`, and `tsc` and lint are clean.
  - The five regression smokes printed the same lines before and after.
  - Mutations caught: masking removed, the `calendarIds` intersection removed, the Google guard removed, the empty-legend rule removed, a state on events, the carry-over `originalStart` taken from the event, a lost state row, the carry-over read without Plan A's widening, and (the days path) an `originalStart` taken from the event's start, which a moved occurrence shows at once.

**Files:**
- Modify: `src/services/calendar-provider/native-provider.ts:164-193`: `toViewerEvents` (`:164-179`) and `fetchForViewer` (`:181-193`) become `ViewerItem`, `toViewerItems`, `fetchViewerItems` and `fetchForViewer`.
- Modify: `src/services/native-reminders/open-reminders.ts`, six spots:
  - `:20`: a type import;
  - `:73-74`: `OpenReminderItem` after `OpenReminderCandidate`;
  - `:93-96` and `:112-117`: `selectOpenReminders` delegates to `selectOpenReminderItems`;
  - `:132-134` and `:145-149`: `fetchOpenReminders` delegates to `loadOpenReminderCandidates`, and `fetchOpenReminderItems` is added.
- Create: `src/services/calendar-read/famcal.ts`
- Create (test): `scripts/smoke-calendar-read-famcal.ts`
- Test: `scripts/smoke-calendar-read-famcal.ts`
- Regression (unchanged): `scripts/smoke-native-provider-reminders.ts`, `scripts/smoke-reminders.ts`, `scripts/smoke-native-reminder-digest.ts`, `scripts/smoke-native-reminder-edit.ts`, `scripts/smoke-voice-dates.ts`

**Interfaces:**
- Consumes:
  - from B3, `src/services/calendar-read/types.ts`: `CalendarRef`, `ReadItem`, `FamcalRead` (spec §2.2, verbatim);
  - `listVisibleCalendars(userId: number, pairingId: string | null): Promise<NativeCalendar[]>` and `encodeCalendarId(cuid: string): string` (`event-store.ts:112`, `:31`);
  - `loadViewerContext(user: { id: number; pairingId: string | null }): Promise<ViewerContext>` (`ownership.ts:53`);
  - `fetchEventsInCalendars`, `fetchRemindersForUserInRange` and `fetchReminderStates` (unchanged; Plan A widens the first two's `rangeCandidates`);
  - Plan A Task 2's `fetchOpenReminders` `where` (moved, not edited).
- Produces:
  - `export interface ViewerItem { row: NativeEventRow; state?: ReminderStateRow; event: UnifiedEvent }` (`native-provider.ts`)
  - `export async function fetchViewerItems(user: UserConfig, cuids: string[], range: FetchRange): Promise<{ ctx: ViewerContext; items: ViewerItem[] }>` (`native-provider.ts`)
  - `export interface OpenReminderItem { event: UnifiedEvent; series: NativeEvent; calendar: { id: string; name: string }; instanceStartsAt: Date; state?: Pick<NativeReminderState, 'originalStartsAt' | 'doneAt' | 'snoozedUntil'> }` (`open-reminders.ts`)
  - `export async function fetchOpenReminderItems(user: UserConfig, ctx: ViewerContext, cutoff: Date, summaryDay: string, timezone: string, cap: number = OPEN_REMINDERS_DIGEST_CAP): Promise<{ items: OpenReminderItem[]; moreCount: number }>` (`open-reminders.ts`)
  - `export async function readFamcal(user: UserConfig, window: { from: Date; to: Date }, opts: { calendarIds?: readonly string[] }): Promise<{ read: FamcalRead; items: ReadItem[] }>` (`famcal.ts`)
  - `export function carryOverReadItems(famcal: Extract<FamcalRead, { status: 'ok' }>, carryOvers: readonly OpenReminderItem[]): ReadItem[]` (`famcal.ts`)
  - Unchanged: `fetchOpenReminders`, `selectOpenReminders`, `addDigestReminders`, `nativeProvider`, `toUnifiedEvent` and `reminderInfoFor`.
  - B8 uses them like this: `const famcal = range.famcal` (status `ok`), `const open = await fetchOpenReminderItems(user, famcal.ctx, openRemindersCutoff(today, tz, now), today, tz, Infinity)`, `carryOverReadItems(famcal, open.items)`, then B3's carry-over DTO. Each carry-over's `event.reminder.openSince` is set.

- [ ] **Step 1: Write the failing smoke `scripts/smoke-calendar-read-famcal.ts`**

Create the file with exactly this content:

```ts
// Smoke test for the FamCal half of the calendar reader (spec §2.4): readFamcal and
// carryOverReadItems (src/services/calendar-read/famcal.ts), the fetchViewerItems split
// of the native provider (src/services/calendar-provider/native-provider.ts) and
// fetchOpenReminderItems (src/services/native-reminders/open-reminders.ts).
//
// The reader hands the summaries exactly the events the provider reads today (A-1,
// A-4), never reads a calendar outside the viewer's legend, masks the partner's PRIVATE
// calendar on a reminder-for-me, and makes no query for a Google user. The real event
// store, provider, ownership and open-reminders code run against an in-memory Prisma.
// No network, no DB.
//
// Run under both clocks; the output must not depend on the server's timezone:
//   TZ=UTC npx tsx scripts/smoke-calendar-read-famcal.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-calendar-read-famcal.ts

import path from 'path';
import { fromZonedTime } from 'date-fns-tz';
import type { NativeCalendar, NativeEvent, NativeEventInstance, NativeReminderState } from '@prisma/client';
import type { UserConfig } from '../src/types';
import type { CalendarRef, ReadItem } from '../src/services/calendar-read/types';

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

/** JSON that also prints the partner's telegramId (a BigInt). */
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x));

function assertJson(got: unknown, want: unknown, what: string) {
  const g = json(got);
  const w = json(want);
  assert(g === w, `${what}\n     got  ${g}\n     want ${w}`);
}

globalThis.fetch = (async (input: unknown) => {
  throw new Error(`network is blocked in this smoke test: ${String(input)}`);
}) as typeof fetch;

const IL = 'Asia/Jerusalem';
const at = (local: string) => fromZonedTime(local, IL);

// ---- In-memory Prisma: the operators, relation filters, include and orderBy the code under test uses ----

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;
/** A model's relations: the row a row points at (to-one) or the rows it owns (to-many). */
type Relations = Record<string, (row: Row) => Row | Row[] | undefined>;
type FindArgs = {
  where?: Where;
  select?: Record<string, boolean>;
  include?: Record<string, boolean>;
  orderBy?: Record<string, 'asc' | 'desc'> | Array<Record<string, 'asc' | 'desc'>>;
};

const same = (a: unknown, b: unknown) => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b);

function matches(row: Row, where: Where, relations: Relations = {}): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as Where[]).some((w) => matches(row, w, relations));
    if (key === 'AND') return (Array.isArray(cond) ? (cond as Where[]) : [cond as Where]).every((w) => matches(row, w, relations));
    if (Object.hasOwn(relations, key)) {
      const target = relations[key](row);
      if (Array.isArray(target)) {
        const { some, ...rest } = cond as { some?: Where };
        if (!some || Object.keys(rest).length > 0) throw new Error(`stand-in Prisma only knows '${key}: { some }'`);
        return target.some((r) => matches(r, some));
      }
      return target !== undefined && matches(target, cond as Where);
    }
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

const sortKey = (row: Row, key: string) => {
  const v = row[key];
  return v instanceof Date ? v.getTime() : Number(v);
};

/** Every query, as "<model>.<method>", to see what a read costs. */
const queries: string[] = [];
/** The arguments of every nativeEvent.findMany, as JSON. */
const eventReads: string[] = [];
/** A query that throws, as "<model>.<method>", and what it throws. */
let failOn: string | null = null;
const failure = new Error('connection reset');

function table(name: string, rows: () => Row[], relations: Relations = {}) {
  const run = (method: string) => {
    queries.push(`${name}.${method}`);
    if (failOn === `${name}.${method}`) throw failure;
  };
  const shape = (row: Row, args: FindArgs) => {
    if (args.select) return Object.fromEntries(Object.keys(args.select).filter((k) => args.select![k]).map((k) => [k, row[k]]));
    const out: Row = { ...row };
    for (const [k, on] of Object.entries(args.include ?? {})) if (on) out[k] = relations[k](row);
    return out;
  };
  return {
    findMany: async (args: FindArgs = {}) => {
      run('findMany');
      if (name === 'nativeEvent') eventReads.push(json(args));
      const found = rows().filter((r) => matches(r, args.where ?? {}, relations));
      const orderBy = args.orderBy ? (Array.isArray(args.orderBy) ? args.orderBy : [args.orderBy]) : [];
      found.sort((a, b) => {
        for (const o of orderBy) {
          const [key, dir] = Object.entries(o)[0];
          const d = sortKey(a, key) - sortKey(b, key);
          if (d !== 0) return dir === 'asc' ? d : -d;
        }
        return 0;
      });
      return found.map((r) => shape(r, args));
    },
    findUnique: async (args: FindArgs & { where: Where }) => {
      run('findUnique');
      const row = rows().find((r) => matches(r, args.where, relations));
      return row ? shape(row, args) : null;
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
  nativeEvent: table('nativeEvent', () => db.events, {
    calendar: (r) => db.calendars.find((c) => c.id === r.calendarId),
    instances: (r) => db.instances.filter((i) => i.seriesEventId === r.id),
    states: (r) => db.states.filter((s) => s.seriesEventId === r.id),
  }),
  nativeEventInstance: table('nativeEventInstance', () => db.instances),
  nativeReminderState: table('nativeReminderState', () => db.states),
};

// ---- The household: Dana and Raziel, paired; Noam on his own; Gali on Google ----

const DANA = 1;
const RAZIEL = 2;
const NOAM = 3;
const GALI = 4;
const CREATED = at('2026-10-01 09:00');
const NEVER = at('2099-01-01 09:00');

function calendar(fields: Partial<NativeCalendar> & Pick<NativeCalendar, 'id' | 'ownerUserId' | 'name' | 'createdAt'>): NativeCalendar {
  return {
    color: '#039BE5', labels: ['yours'], personName: null, personEnglishName: null, personGender: null, rules: [],
    privacy: 'PRIVATE', isDeleted: false, updatedAt: CREATED,
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

function override(seriesEventId: string, originalStartsAt: Date, fields: Partial<NativeEventInstance>): NativeEventInstance {
  return {
    id: `inst-${seriesEventId}-${originalStartsAt.getTime()}`, seriesEventId, originalStartsAt, status: 'OVERRIDE',
    title: null, description: null, location: null, startsAt: null, endsAt: null, allDay: null, createdAt: CREATED, updatedAt: CREATED,
    ...fields,
  };
}

const user = (id: number, name: string, extra: Row = {}) => ({
  id, name, englishName: name, gender: 'female', calendarSource: 'NATIVE', telegramId: BigInt(1000 + id), language: 'en',
  pairingId: null, suspendedAt: null, googleRefreshToken: null, ...extra,
});

/** The name of Raziel's PRIVATE calendar: it must never reach a CalendarRef. */
const PRIVATE_NAME = 'Surprise party plans';

/** Each check starts from this household. The calendars are stored out of their creation order. */
function household() {
  db.users = [
    user(DANA, 'Dana', { pairingId: 'pair-1' }),
    user(RAZIEL, 'Raziel', { gender: 'male', pairingId: 'pair-1' }),
    user(NOAM, 'Noam', { gender: 'male' }),
    user(GALI, 'Gali', { calendarSource: 'GOOGLE', googleRefreshToken: 'fake-token' }),
  ];
  db.pairings = [{ id: 'pair-1', status: 'ACTIVE', inviterUserId: RAZIEL, inviteeUserId: DANA }];
  db.calendars = [
    calendar({ id: 'cal-raz-family', ownerUserId: RAZIEL, name: 'Family', labels: ['kids'], privacy: 'SHARED_VIEWER', color: '#33B679', createdAt: at('2026-09-03 09:00') }),
    calendar({ id: 'cal-dana', ownerUserId: DANA, name: 'Dana', labels: ['primary', 'yours'], privacy: 'SHARED_EDITOR', color: '#D50000', createdAt: at('2026-09-01 09:00') }),
    calendar({ id: 'cal-raz', ownerUserId: RAZIEL, name: PRIVATE_NAME, labels: ['primary', 'yours'], createdAt: at('2026-09-02 09:00') }),
    calendar({ id: 'cal-dana-kids', ownerUserId: DANA, name: 'Kids', labels: ['kids'], createdAt: at('2026-09-04 09:00') }),
    calendar({ id: 'cal-raz-old', ownerUserId: RAZIEL, name: 'Old', isDeleted: true, createdAt: at('2026-09-05 09:00') }),
    calendar({ id: 'cal-noam', ownerUserId: NOAM, name: 'Noam', createdAt: at('2026-09-06 09:00') }),
  ];
  db.events = [
    // Tuesday 2026-10-13, the day read.
    event({ id: 'ev-dentist', calendarId: 'cal-dana', creatorUserId: DANA, title: 'Dentist', startsAt: at('2026-10-13 10:00'), endsAt: at('2026-10-13 11:00') }),
    event({
      id: 'ev-swim', calendarId: 'cal-dana-kids', creatorUserId: DANA, title: 'Swim', startsAt: at('2026-10-06 16:00'), endsAt: at('2026-10-06 17:00'),
      rrule: 'FREQ=WEEKLY;BYDAY=TU',
    }),
    reminder({ id: 'rem-plants', calendarId: 'cal-dana', creatorUserId: DANA, title: 'Water the plants', startsAt: at('2026-10-13 00:00'), allDay: true }),
    reminder({ id: 'rem-bank', calendarId: 'cal-dana', creatorUserId: DANA, forUserId: RAZIEL, title: 'Call the bank', startsAt: at('2026-10-13 15:00') }),
    // Raziel's, on his PRIVATE calendar: Dana sees only the ones for her.
    reminder({ id: 'rem-milk', calendarId: 'cal-raz', creatorUserId: RAZIEL, forUserId: DANA, title: 'Buy milk', startsAt: at('2026-10-13 17:00') }),
    reminder({ id: 'rem-raz-own', calendarId: 'cal-raz', creatorUserId: RAZIEL, title: 'Renew passport', startsAt: at('2026-10-13 12:00') }),
    reminder({
      id: 'rem-vitamins', calendarId: 'cal-raz', creatorUserId: RAZIEL, forUserId: DANA, title: 'Vitamins',
      startsAt: at('2026-10-10 08:00'), rrule: 'FREQ=DAILY',
    }),
    // On his shared calendar: the reminder comes back from both reads, and is listed once.
    event({ id: 'ev-dinner', calendarId: 'cal-raz-family', creatorUserId: RAZIEL, title: 'Family dinner', startsAt: at('2026-10-13 19:00'), endsAt: at('2026-10-13 21:00') }),
    reminder({ id: 'rem-cake', calendarId: 'cal-raz-family', creatorUserId: RAZIEL, forUserId: DANA, title: 'Pick up the cake', startsAt: at('2026-10-13 18:00') }),
    event({ id: 'ev-noam', calendarId: 'cal-noam', creatorUserId: NOAM, title: 'Gym', startsAt: at('2026-10-13 07:00'), endsAt: at('2026-10-13 08:00') }),
    // Before Tuesday: the carry-overs.
    reminder({ id: 'rem-yesterday', calendarId: 'cal-raz', creatorUserId: RAZIEL, forUserId: DANA, title: 'Book the plumber', startsAt: at('2026-10-12 17:00') }),
    reminder({ id: 'rem-library', calendarId: 'cal-dana', creatorUserId: DANA, title: 'Return the library books', startsAt: at('2026-10-11 10:00') }),
    reminder({ id: 'rem-recycling', calendarId: 'cal-dana', creatorUserId: DANA, title: 'Recycling out', startsAt: at('2026-10-04 08:00'), rrule: 'FREQ=WEEKLY;BYDAY=SU' }),
    reminder({ id: 'rem-done', calendarId: 'cal-dana', creatorUserId: DANA, title: 'Pay the nanny', startsAt: at('2026-10-12 09:00') }),
  ] as unknown as Row[];
  db.instances = [];
  db.states = [
    state({ seriesEventId: 'rem-plants', originalStartsAt: at('2026-10-13 00:00'), doneAt: at('2026-10-13 09:10'), doneByUserId: DANA }),
    state({ seriesEventId: 'rem-milk', originalStartsAt: at('2026-10-13 17:00'), snoozedUntil: NEVER }),
    state({ seriesEventId: 'rem-vitamins', originalStartsAt: at('2026-10-12 08:00'), doneAt: at('2026-10-12 08:05') }),
    state({ seriesEventId: 'rem-library', originalStartsAt: at('2026-10-11 10:00'), snoozedUntil: NEVER }),
    state({ seriesEventId: 'rem-done', originalStartsAt: at('2026-10-12 09:00'), doneAt: at('2026-10-12 09:30') }),
  ] as unknown as Row[];
  queries.length = 0;
  eventReads.length = 0;
  failOn = null;
}

/**
 * A weekly reminder of Dana's that starts on Tuesday the 20th, whose first time was
 * moved to Monday the 12th, 09:00: only Plan A's wider read (spec §8.2) loads it
 * before the 20th.
 */
function addMovedReminder() {
  db.events.push(reminder({
    id: 'rem-moved', calendarId: 'cal-dana', creatorUserId: DANA, title: 'Renew the parking permit',
    startsAt: at('2026-10-20 09:00'), rrule: 'FREQ=WEEKLY;BYDAY=TU',
  }) as unknown as Row);
  db.instances.push(override('rem-moved', at('2026-10-20 09:00'), { startsAt: at('2026-10-12 09:00'), endsAt: at('2026-10-12 09:00') }) as unknown as Row);
}

const viewer = (id: number) => db.users.find((u) => u.id === id) as unknown as UserConfig;
const DAY = { from: at('2026-10-13 00:00'), to: at('2026-10-14 00:00') };
const CUTOFF = at('2026-10-13 00:00');

/** An item as one line: its title, kind, calendar ref and state. */
function line(i: ReadItem): string {
  const ref = i.calendar.id ?? `masked as ${i.calendar.name}`;
  const st = i.state ? ` ${i.state.doneAt ? 'done' : i.state.snoozedUntil ? 'snoozed' : 'pending'}` : '';
  return `${i.title} [${i.kind}${st}] @ ${ref}`;
}

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
  const captured: string[] = [];
  stub('utils/prisma.ts', { prisma: fakePrisma });
  const record = (_what: unknown, where: string) => { captured.push(where); };
  stub('lib/error-capture.ts', { captureError: record, captureWarning: record, captureInfo: record });

  const { nativeProvider, fetchViewerItems } = await import('../src/services/calendar-provider/native-provider');
  const { getCalendarAssignmentsForUser } = await import('../src/services/calendar-provider/user-calendars');
  const { fetchOpenReminders, fetchOpenReminderItems } = await import('../src/services/native-reminders/open-reminders');
  const { readFamcal, carryOverReadItems } = await import('../src/services/calendar-read/famcal');
  const { toRangeDays } = await import('../src/services/calendar-read/dto');

  /** The day exactly as a summary reads it today: the resolved ids, then the provider. */
  const providerDay = async (id: number) => {
    const ids = (await getCalendarAssignmentsForUser(viewer(id))).map((a) => a.calendarId);
    return { ids, events: await nativeProvider.fetchEventsInRange(viewer(id), ids, DAY.from, DAY.to) };
  };

  // ---- fetchViewerItems: the provider's read, with each row and state beside its event ----

  await check('fetchViewerItems: the provider\'s events, each with its row and state, from the same queries', async () => {
    household();
    const ids = ['native:cal-dana', 'native:cal-dana-kids', 'native:cal-raz-family'];
    const viaProvider = await nativeProvider.fetchEventsInRange(viewer(DANA), ids, DAY.from, DAY.to);
    const providerQueries = [...queries];
    household();
    const { ctx, items } = await fetchViewerItems(viewer(DANA), ['cal-dana', 'cal-dana-kids', 'cal-raz-family'], DAY);
    assertJson(items.map((i) => i.event), viaProvider, 'events');
    assertJson(queries, providerQueries, 'queries');
    assert(ctx.viewerId === DANA && ctx.partner?.id === RAZIEL && ctx.partner.name === 'Raziel', `ctx ${json(ctx)}`);
    for (const i of items) {
      assert(i.row.instance.title === i.event.summary, `${i.event.summary}: row ${i.row.instance.title}`);
      assert(i.row.series.kind === (i.event.eventType === 'reminder' ? 'REMINDER' : 'EVENT'), `${i.event.summary}: kind ${i.row.series.kind}`);
    }
    const stateOf = (title: string) => {
      const item = items.find((i) => i.event.summary === title);
      assert(item !== undefined, `no ${title}`);
      return 'state' in item ? item.state : 'no key';
    };
    const plants = stateOf('Water the plants');
    assert(plants !== 'no key' && plants?.doneAt?.getTime() === at('2026-10-13 09:10').getTime(), 'plants: its done row');
    const milk = stateOf('Buy milk');
    assert(milk !== 'no key' && milk?.snoozedUntil?.getTime() === NEVER.getTime(), 'milk: its snoozed row');
    assert(stateOf('Vitamins') === 'no key', 'vitamins: today has no row, so no state key');
    assert(stateOf('Dentist') === 'no key', 'an event has no state key');
  });

  // ---- readFamcal ----

  await check('readFamcal: Dana\'s events are exactly what her summary reads today (A-1, A-4), in its order', async () => {
    household();
    const today = await providerDay(DANA);
    household();
    const { read, items } = await readFamcal(viewer(DANA), DAY, {});
    assert(read.status === 'ok', `status ${read.status}`);
    assertJson(items.map((i) => i.event), today.events, 'events');
    household();
    const narrowed = await readFamcal(viewer(DANA), DAY, { calendarIds: today.ids });
    assertJson(narrowed.items.map((i) => i.event), today.events, 'events with the summary\'s ids');
  });

  await check('readFamcal: the legend is her own calendars of any privacy, then Raziel\'s shared one, with his name', async () => {
    household();
    const { read } = await readFamcal(viewer(DANA), DAY, {});
    assert(read.status === 'ok', `status ${read.status}`);
    const want: CalendarRef[] = [
      { id: 'native:cal-dana', source: 'famcal', name: 'Dana', color: '#D50000', mine: true, inLegend: true },
      { id: 'native:cal-raz-family', source: 'famcal', name: 'Family', color: '#33B679', mine: false, ownerName: 'Raziel', inLegend: true },
      { id: 'native:cal-dana-kids', source: 'famcal', name: 'Kids', color: '#039BE5', mine: true, inLegend: true },
    ];
    assertJson(read.calendars, want, 'calendars');
    assertJson(read.partner, { name: 'Raziel' }, 'partner');
    assert(read.ctx.viewerId === DANA && read.ctx.partner?.id === RAZIEL, `ctx ${json(read.ctx)}`);
  });

  await check('readFamcal: every item\'s fields', async () => {
    household();
    const { items } = await readFamcal(viewer(DANA), DAY, {});
    assertJson(items.map(line), [
      'Water the plants [reminder done] @ native:cal-dana',
      'Vitamins [reminder pending] @ masked as Raziel',
      'Dentist [event] @ native:cal-dana',
      'Call the bank [reminder pending] @ native:cal-dana',
      'Swim [event] @ native:cal-dana-kids',
      'Buy milk [reminder snoozed] @ masked as Raziel',
      'Pick up the cake [reminder pending] @ native:cal-raz-family',
      'Family dinner [event] @ native:cal-raz-family',
    ], 'items');
    const vitamins08 = at('2026-10-13 08:00').toISOString();
    const swim16 = at('2026-10-13 16:00').toISOString();
    const fields = (i: ReadItem) => ({
      source: i.source, key: i.key, title: i.title, kind: i.kind, seriesId: i.seriesId, originalStart: i.originalStart,
      recurring: i.recurring, rrule: i.rrule, state: i.state ?? 'none', google: i.google ?? 'none', summaryIsTitle: i.event.summary === i.title,
    });
    const byTitle = (t: string) => {
      const i = items.find((x) => x.title === t);
      assert(i !== undefined, `no ${t}`);
      return fields(i);
    };
    assertJson(byTitle('Vitamins'), {
      source: 'famcal', key: `famcal|rem-vitamins#${vitamins08}`, title: 'Vitamins', kind: 'reminder', seriesId: 'rem-vitamins',
      originalStart: vitamins08, recurring: true, rrule: 'FREQ=DAILY', state: { doneAt: null, snoozedUntil: null }, google: 'none', summaryIsTitle: true,
    }, 'Vitamins');
    assertJson(byTitle('Water the plants'), {
      source: 'famcal', key: 'famcal|rem-plants', title: 'Water the plants', kind: 'reminder', seriesId: 'rem-plants',
      originalStart: at('2026-10-13 00:00').toISOString(), recurring: false, rrule: null,
      state: { doneAt: at('2026-10-13 09:10'), snoozedUntil: null }, google: 'none', summaryIsTitle: true,
    }, 'Water the plants (a one-off has its originalStart too)');
    assertJson(byTitle('Buy milk').state, { doneAt: null, snoozedUntil: NEVER }, 'Buy milk state');
    assertJson(byTitle('Swim'), {
      source: 'famcal', key: `famcal|ev-swim#${swim16}`, title: 'Swim', kind: 'event', seriesId: 'ev-swim',
      originalStart: swim16, recurring: true, rrule: 'FREQ=WEEKLY;BYDAY=TU', state: 'none', google: 'none', summaryIsTitle: true,
    }, 'Swim');
    assertJson(byTitle('Dentist'), {
      source: 'famcal', key: 'famcal|ev-dentist', title: 'Dentist', kind: 'event', seriesId: 'ev-dentist',
      originalStart: at('2026-10-13 10:00').toISOString(), recurring: false, rrule: null, state: 'none', google: 'none', summaryIsTitle: true,
    }, 'Dentist');
  });

  await check('readFamcal: a reminder-for-me from Raziel\'s PRIVATE calendar never names that calendar', async () => {
    household();
    const { read, items } = await readFamcal(viewer(DANA), DAY, {});
    assert(read.status === 'ok', `status ${read.status}`);
    const masked: CalendarRef = { id: null, source: 'famcal', name: 'Raziel', color: null, mine: false, inLegend: false };
    for (const title of ['Buy milk', 'Vitamins']) {
      const item = items.find((i) => i.title === title);
      assertJson(item?.calendar, masked, `${title} calendar`);
      // The summaries still get the real calendar, as today (A-5, A-6).
      assert(item?.event.calendarName === PRIVATE_NAME && item.event.calendarId === 'native:cal-raz', `${title} event ${item?.event.calendarId}`);
    }
    const refs = json([read.calendars, items.map((i) => i.calendar)]);
    assert(!refs.includes(PRIVATE_NAME) && !refs.includes('"native:cal-raz"') && !refs.includes('"cal-raz"'), `refs ${refs}`);
    assert(!items.some((i) => i.title === 'Renew passport'), 'Raziel\'s own private reminder leaked');
  });

  await check('readFamcal: Raziel sees the other side, Dana\'s shared calendar named after her', async () => {
    household();
    const today = await providerDay(RAZIEL);
    household();
    const { read, items } = await readFamcal(viewer(RAZIEL), DAY, {});
    assert(read.status === 'ok', `status ${read.status}`);
    assertJson(items.map((i) => i.event), today.events, 'events');
    assertJson(read.calendars.map((c) => [c.id, c.mine, c.ownerName ?? null]), [
      ['native:cal-dana', false, 'Dana'],
      ['native:cal-raz', true, null],
      ['native:cal-raz-family', true, null],
    ], 'legend');
    assert(!items.some((i) => i.title === 'Swim'), 'Dana\'s PRIVATE Kids calendar leaked');
    assert(items.every((i) => i.calendar.inLegend), `masked: ${items.filter((i) => !i.calendar.inLegend).map(line).join(' | ')}`);
  });

  await check('readFamcal: calendarIds narrow the legend, and an id outside it is never read', async () => {
    household();
    const today = await nativeProvider.fetchEventsInRange(viewer(DANA), ['native:cal-dana'], DAY.from, DAY.to);
    household();
    const { read, items } = await readFamcal(viewer(DANA), DAY, { calendarIds: ['native:cal-dana', 'native:cal-noam'] });
    assert(read.status === 'ok', `status ${read.status}`);
    assertJson(read.calendars.map((c) => c.id), ['native:cal-dana'], 'legend');
    assertJson(items.map((i) => i.event), today, 'events, as the provider reads her one calendar');
    assert(!items.some((i) => i.title === 'Gym'), 'read Noam\'s calendar');
    // Off the narrowed legend, Raziel's reminder for her on his shared calendar is masked.
    assertJson(items.find((i) => i.title === 'Pick up the cake')?.calendar.id, null, 'cake ref id');
  });

  await check('readFamcal: no legend calendar, no items and no event read, as the provider', async () => {
    household();
    db.calendars.find((c) => c.id === 'cal-noam')!.isDeleted = true;
    const noam = await readFamcal(viewer(NOAM), DAY, {});
    assertJson(noam, { read: { status: 'ok', ctx: { viewerId: NOAM, partner: null }, calendars: [], partner: null }, items: [] }, 'Noam');
    assert(!queries.some((q) => q.startsWith('nativeEvent.')), `queries ${queries.join(', ')}`);
    household();
    const none = await readFamcal(viewer(DANA), DAY, { calendarIds: [] });
    assert(none.read.status === 'ok' && none.read.calendars.length === 0 && none.items.length === 0, json(none.read));
    assert(none.read.partner?.name === 'Raziel', 'the partner is still named');
    assert(!queries.some((q) => q.startsWith('nativeEvent.')), `queries ${queries.join(', ')}`);
  });

  await check('readFamcal: a Google user is never queried', async () => {
    household();
    const { read, items } = await readFamcal(viewer(GALI), DAY, {});
    assert(read.status === 'error' && items.length === 0, `read ${json(read)}`);
    assertJson(queries, [], 'queries');
  });

  await check('readFamcal: a database error is the half\'s error, with its cause', async () => {
    for (const where of ['nativeCalendar.findMany', 'nativeEvent.findMany', 'nativeReminderState.findMany', 'pairing.findUnique']) {
      household();
      failOn = where;
      const { read, items } = await readFamcal(viewer(DANA), DAY, {});
      assert(read.status === 'error' && read.cause === failure && items.length === 0, `${where}: ${json(read)}`);
    }
  });

  await check('readFamcal: Noam alone: his calendar, no partner', async () => {
    household();
    const { read, items } = await readFamcal(viewer(NOAM), DAY, {});
    assert(read.status === 'ok' && read.partner === null && read.ctx.partner === null, json(read));
    assertJson(items.map(line), ['Gym [event] @ native:cal-noam'], 'items');
    assertJson(read.calendars, [{ id: 'native:cal-noam', source: 'famcal', name: 'Noam', color: '#039BE5', mine: true, inLegend: true }], 'calendars');
  });

  await check('readFamcal: a suspended partner\'s items stay (R4)', async () => {
    household();
    const before = (await readFamcal(viewer(DANA), DAY, {})).items.map(line);
    household();
    db.users.find((u) => u.id === RAZIEL)!.suspendedAt = at('2026-10-12 12:00');
    const after = (await readFamcal(viewer(DANA), DAY, {})).items.map(line);
    assertJson(after, before, 'items');
  });

  await check('readFamcal: a partner who moved to Google: her own calendars only, the partner still named', async () => {
    household();
    const razielRow = db.users.find((u) => u.id === RAZIEL)!;
    razielRow.calendarSource = 'GOOGLE';
    for (const c of db.calendars) if (c.ownerUserId === RAZIEL) c.isDeleted = true;
    const today = await providerDay(DANA);
    const { read, items } = await readFamcal(viewer(DANA), DAY, {});
    assert(read.status === 'ok', `status ${read.status}`);
    assertJson(read.calendars.map((c) => c.id), ['native:cal-dana', 'native:cal-dana-kids'], 'legend');
    assertJson(read.partner, { name: 'Raziel' }, 'partner');
    assertJson(items.map((i) => i.event), today.events, 'events');
  });

  // ---- fetchOpenReminderItems and carryOverReadItems ----

  const cutoffDay = '2026-10-13';
  const danaCtx = async () => {
    const r = await readFamcal(viewer(DANA), DAY, {});
    assert(r.read.status === 'ok', 'Dana\'s read failed');
    return r.read;
  };

  await check('fetchOpenReminderItems: the same read as fetchOpenReminders, paired or not', async () => {
    household();
    const famcal = await danaCtx();
    for (const ctx of [famcal.ctx, { viewerId: DANA, partner: null }]) {
      eventReads.length = 0;
      await fetchOpenReminders(viewer(DANA), ctx, CUTOFF, cutoffDay, IL, Infinity);
      await fetchOpenReminderItems(viewer(DANA), ctx, CUTOFF, cutoffDay, IL, Infinity);
      assert(eventReads.length === 2 && eventReads[0] === eventReads[1], `reads\n     ${eventReads.join('\n     ')}`);
    }
  });

  await check('fetchOpenReminderItems: the same carry-overs, newest first, each with its occurrence and state row', async () => {
    household();
    const famcal = await danaCtx();
    const old = await fetchOpenReminders(viewer(DANA), famcal.ctx, CUTOFF, cutoffDay, IL, Infinity);
    const { items, moreCount } = await fetchOpenReminderItems(viewer(DANA), famcal.ctx, CUTOFF, cutoffDay, IL, Infinity);
    assertJson(items.map((i) => i.event), old.events, 'events');
    assert(moreCount === old.moreCount && moreCount === 0, `moreCount ${moreCount}`);
    assertJson(items.map((i) => [i.event.summary, i.series.id, i.calendar.id, i.instanceStartsAt.toISOString(), i.state ? i.state.snoozedUntil : 'none']), [
      ['Book the plumber', 'rem-yesterday', 'cal-raz', at('2026-10-12 17:00').toISOString(), 'none'],
      ['Return the library books', 'rem-library', 'cal-dana', at('2026-10-11 10:00').toISOString(), NEVER.toISOString()],
      ['Recycling out', 'rem-recycling', 'cal-dana', at('2026-10-11 08:00').toISOString(), 'none'],
    ], 'items');
    assert(items.every((i) => i.event.reminder?.openSince !== undefined), 'openSince missing');
  });

  await check('fetchOpenReminderItems: the cap and the count past it, as fetchOpenReminders', async () => {
    household();
    const famcal = await danaCtx();
    const old = await fetchOpenReminders(viewer(DANA), famcal.ctx, CUTOFF, cutoffDay, IL, 2);
    const { items, moreCount } = await fetchOpenReminderItems(viewer(DANA), famcal.ctx, CUTOFF, cutoffDay, IL, 2);
    assertJson(items.map((i) => i.event), old.events, 'events');
    assert(items.length === 2 && moreCount === 1 && old.moreCount === 1, `${items.length} items, moreCount ${moreCount}/${old.moreCount}`);
  });

  await check('fetchOpenReminderItems: a Google user is never read', async () => {
    household();
    const none = await fetchOpenReminderItems(viewer(GALI), { viewerId: GALI, partner: null }, CUTOFF, cutoffDay, IL, Infinity);
    assertJson(none, { items: [], moreCount: 0 }, 'result');
    assertJson(queries, [], 'queries');
  });

  await check('carryOverReadItems: masked off the legend, named on it; originalStart is the occurrence\'s', async () => {
    household();
    const famcal = await danaCtx();
    const { items } = await fetchOpenReminderItems(viewer(DANA), famcal.ctx, CUTOFF, cutoffDay, IL, Infinity);
    const read = carryOverReadItems(famcal, items);
    assertJson(read.map(line), [
      'Book the plumber [reminder pending] @ masked as Raziel',
      'Return the library books [reminder snoozed] @ native:cal-dana',
      'Recycling out [reminder pending] @ native:cal-dana',
    ], 'items');
    const recycling = read[2];
    const sunday = at('2026-10-11 08:00').toISOString();
    assertJson(
      [recycling.key, recycling.originalStart, recycling.seriesId, recycling.recurring, recycling.rrule, recycling.source],
      [`famcal|rem-recycling#${sunday}`, sunday, 'rem-recycling', true, 'FREQ=WEEKLY;BYDAY=SU', 'famcal'],
      'the weekly one',
    );
    const library = read[1];
    assertJson([library.key, library.originalStart, library.recurring, library.state], [
      'famcal|rem-library', at('2026-10-11 10:00').toISOString(), false, { doneAt: null, snoozedUntil: NEVER },
    ], 'the one-off');
    assert(read.every((r, i) => r.event === items[i].event), 'the event is not the carry-over\'s own');
    const refs = json(read.map((r) => r.calendar));
    assert(!refs.includes(PRIVATE_NAME) && !refs.includes('cal-raz"'), `refs ${refs}`);
  });

  await check('fetchOpenReminderItems: a first time moved before the series start is carried, keyed by its original slot (Plan A)', async () => {
    household();
    addMovedReminder();
    const famcal = await danaCtx();
    const old = await fetchOpenReminders(viewer(DANA), famcal.ctx, CUTOFF, cutoffDay, IL, Infinity);
    const { items } = await fetchOpenReminderItems(viewer(DANA), famcal.ctx, CUTOFF, cutoffDay, IL, Infinity);
    assertJson(items.map((i) => i.event), old.events, 'events');
    const slot = at('2026-10-20 09:00').toISOString();
    const moved = items.find((i) => i.series.id === 'rem-moved');
    assert(moved !== undefined, `not carried: [${items.map((i) => i.event.summary).join(', ')}]; Plan A's wider fetchOpenReminders read is missing`);
    assert(moved.instanceStartsAt.toISOString() === slot && moved.event.start === at('2026-10-12 09:00').toISOString(), `moved ${moved.instanceStartsAt.toISOString()} ${moved.event.start}`);
    const [asRead] = carryOverReadItems(famcal, [moved]);
    assertJson([asRead.key, asRead.originalStart], [`famcal|rem-moved#${slot}`, slot], 'its ReadItem');
  });

  await check('readFamcal: today\'s Vitamins moved to 10:30 tomorrow ("just this one") is read on tomorrow, keyed and stated by today\'s 08:00 slot', async () => {
    household();
    const slot = at('2026-10-13 08:00');
    const movedTo = at('2026-10-14 10:30');
    db.instances.push(override('rem-vitamins', slot, { startsAt: movedTo, endsAt: movedTo }) as unknown as Row);
    db.states.push(state({ seriesEventId: 'rem-vitamins', originalStartsAt: slot, doneAt: at('2026-10-13 09:30'), doneByUserId: DANA }) as unknown as Row);
    const { read, items } = await readFamcal(viewer(DANA), { from: at('2026-10-13 00:00'), to: at('2026-10-15 00:00') }, {});
    assert(read.status === 'ok', `status ${read.status}`);
    const vitamins = items.filter((i) => i.seriesId === 'rem-vitamins');
    const tomorrow08 = at('2026-10-14 08:00').toISOString();
    assertJson(vitamins.map((i) => [i.key, i.event.start, i.originalStart, i.state]), [
      [`famcal|rem-vitamins#${tomorrow08}`, tomorrow08, tomorrow08, { doneAt: null, snoozedUntil: null }],
      [`famcal|rem-vitamins#${slot.toISOString()}`, movedTo.toISOString(), slot.toISOString(), { doneAt: at('2026-10-13 09:30'), snoozedUntil: null }],
    ], 'the two Vitamins in the two days: tomorrow\'s own, then today\'s moved one');
    const days = toRangeDays(items, '2026-10-13', '2026-10-15', IL, at('2026-10-13 12:00'), '2026-10-13');
    const onDay = (date: string) => days.find((d) => d.date === date)?.items.filter((i) => i.seriesId === 'rem-vitamins') ?? [];
    assertJson(onDay('2026-10-13').map((i) => i.key), [], 'listed today');
    assertJson(onDay('2026-10-14').map((i) => [i.key, i.start, i.originalStart, i.reminder?.done, i.reminder?.open]), [
      [`famcal|rem-vitamins#${tomorrow08}`, tomorrow08, tomorrow08, false, false],
      [`famcal|rem-vitamins#${slot.toISOString()}`, movedTo.toISOString(), slot.toISOString(), true, false],
    ], 'listed tomorrow');
  });

  await check('nothing above reported an error', () => {
    assert(captured.length === 0, `captureError: ${captured.join(', ')}`);
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
- [ ] **Step 2: Run it and see it fail; record the regression smokes' baseline**

```bash
cd /Users/razielgershoni/development/famcalbot
for tz in UTC Asia/Jerusalem; do TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-calendar-read-famcal.ts 2>&1 | head -1; echo "smoke-calendar-read-famcal $tz exit=${pipestatus[1]}"; done
for f in smoke-native-provider-reminders smoke-reminders smoke-native-reminder-digest smoke-native-reminder-edit smoke-voice-dates; do for tz in UTC Asia/Jerusalem; do TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/$f.ts 2>&1 | grep -E '^(OK|FAIL)|passed' > /tmp/b5-$f-${tz//\//_}.before; echo "$f $tz exit=${pipestatus[1]} | $(tail -1 /tmp/b5-$f-${tz//\//_}.before)"; done; done
```
(Run it in zsh: `pipestatus` is zsh's, and in bash it is `${PIPESTATUS[0]}`. Only the OK/FAIL lines and the count are kept: `smoke-native-reminder-digest` also prints a timing line that changes from run to run.)

Expected for the new smoke, under each clock:
```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/razielgershoni/development/famcalbot/src/services/calendar-read/famcal' imported from /Users/razielgershoni/development/famcalbot/scripts/smoke-calendar-read-famcal.ts
smoke-calendar-read-famcal UTC exit=1
```
Why it fails: `famcal.ts` doesn't exist yet, and neither do `fetchViewerItems` and `fetchOpenReminderItems`. The smoke loads its modules after stubbing Prisma, so the missing module stops it before any check runs.

Expected for the regression smokes: every run `exit=0`. The last lines, on top of Plan A, are `11/11`, `23/23`, `33/33`, `18/18` and `77/77` (`smoke-native-reminder-digest` is `32/32` without Plan A Task 2). The `/tmp/b5-*.before` files are the baseline for Step 6.

- [ ] **Step 3: Split `fetchForViewer` in `src/services/calendar-provider/native-provider.ts` (edit 1)**

Lines 164-193. Replace:

```ts
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

with:

```ts
/**
 * One occurrence the viewer sees: its store row, the event the provider hands on for
 * it, and, for a reminder, the occurrence's state row when it has one (no row: pending).
 */
export interface ViewerItem {
  row: NativeEventRow;
  state?: ReminderStateRow;
  event: UnifiedEvent;
}

/** Store rows as the viewer's items. The reminders' states are read in one query. */
async function toViewerItems(rows: NativeEventRow[], ctx: ViewerContext): Promise<ViewerItem[]> {
  const reminderRows = rows.filter((r) => r.series.kind === 'REMINDER');
  if (reminderRows.length === 0) return rows.map((row) => ({ row, event: toUnifiedEvent(row.calendar, row.instance) }));

  const states = await fetchReminderStates(
    reminderRows.map((r) => ({ seriesEventId: r.series.id, originalStartsAt: r.instance.instanceStartsAt }))
  );
  const stateByKey = new Map(states.map((s) => [occurrenceKey(s.seriesEventId, s.originalStartsAt), s]));
  const now = new Date();
  return rows.map((row) => {
    if (row.series.kind !== 'REMINDER') return { row, event: toUnifiedEvent(row.calendar, row.instance) };
    const state = stateByKey.get(occurrenceKey(row.series.id, row.instance.instanceStartsAt));
    const event = toUnifiedEvent(row.calendar, row.instance, row.series, reminderInfoFor(row.series, state, ctx, now));
    return state ? { row, state, event } : { row, event };
  });
}

/**
 * The viewer's occurrences in a range: those on the given calendars, plus the reminders
 * their partner set for them, which they see on its day whatever the privacy of the
 * partner's calendar (spec §2). Each comes with its row and state row beside its event,
 * with the viewer context they were read under: the calendar reader
 * (src/services/calendar-read/famcal.ts) builds its items from them.
 */
export async function fetchViewerItems(
  user: UserConfig,
  cuids: string[],
  range: FetchRange
): Promise<{ ctx: ViewerContext; items: ViewerItem[] }> {
  const [ctx, rows] = await Promise.all([
    loadViewerContext({ id: user.id, pairingId: user.pairingId ?? null }),
    fetchEventsInCalendars(cuids, range),
  ]);
  const forViewer = ctx.partner ? await fetchRemindersForUserInRange(user.id, ctx.partner.id, range) : [];
  return { ctx, items: await toViewerItems(mergeRows(rows, forViewer), ctx) };
}

/** The viewer's events in a range: fetchViewerItems' events, in its order. */
async function fetchForViewer(user: UserConfig, cuids: string[], range: FetchRange): Promise<UnifiedEvent[]> {
  const { items } = await fetchViewerItems(user, cuids, range);
  return items.map((i) => i.event);
}
```

Nothing else in the file changes: the three fetch methods still call `fetchForViewer`, and the imports are already there (`NativeEventRow`, `ReminderStateRow`, `ViewerContext`, `FetchRange`).

- [ ] **Step 4: Add `fetchOpenReminderItems` to `src/services/native-reminders/open-reminders.ts` (edit 9, second half)**

Make six edits. Each quoted text appears exactly once. Line numbers are `main@858886c`. B3 and Plan A shift them, so match on the text. The `where` block between Edits 4e and 4f, as Plan A Task 2 left it, is not touched: it moves into `loadOpenReminderCandidates` unchanged.

Edit 4a: the type import, line 20. Replace:

```ts
import { reminderInfoFor, toUnifiedEvent } from '../calendar-provider/native-provider';
```

with:

```ts
import { reminderInfoFor, toUnifiedEvent } from '../calendar-provider/native-provider';
import type { UnifiedEvent } from '../calendar-provider/types';
```

Edit 4b: `OpenReminderItem`, after `OpenReminderCandidate` (lines 73-74). Replace:

```ts
  states: Pick<NativeReminderState, 'originalStartsAt' | 'doneAt' | 'snoozedUntil'>[];
}
```

with:

```ts
  states: Pick<NativeReminderState, 'originalStartsAt' | 'doneAt' | 'snoozedUntil'>[];
}

/**
 * A carried-over reminder with what the home needs beside its event (calendar home
 * spec §4 step 6): its series, its calendar, the occurrence's original start and its
 * state row. The calendar carries its real name: never hand it to the client.
 */
export interface OpenReminderItem {
  /** Exactly the event fetchOpenReminders lists for it: eventType 'reminder', with openSince. */
  event: UnifiedEvent;
  series: NativeEvent;
  calendar: { id: string; name: string };
  /** The occurrence's original start, which its state row is keyed by; a one-off's own start. */
  instanceStartsAt: Date;
  /** The occurrence's state row, when it has one (a snoozed one). Never a done one: those are not carried. */
  state?: Pick<NativeReminderState, 'originalStartsAt' | 'doneAt' | 'snoozedUntil'>;
}
```

Edit 4c: `selectOpenReminders` delegates; the head of `selectOpenReminderItems` (lines 93-96). Replace:

```ts
): { events: CalendarEvent[]; moreCount: number } {
  const summaryRange = { from: startOfLocalDay(summaryDay, timezone), to: startOfLocalDay(nextDate(summaryDay), timezone) };
  const open: Array<{ due: Date; event: CalendarEvent }> = [];
  for (const { series, calendar, overrides, states } of candidates) {
```

with:

```ts
): { events: CalendarEvent[]; moreCount: number } {
  const { items, moreCount } = selectOpenReminderItems(candidates, ctx, cutoff, summaryDay, timezone, now, cap);
  return { events: items.map(i => i.event), moreCount };
}

/** selectOpenReminders with each carry-over's OpenReminderItem: the same rules, order and cap. */
function selectOpenReminderItems(
  candidates: OpenReminderCandidate[],
  ctx: ViewerContext,
  cutoff: Date,
  summaryDay: string,
  timezone: string,
  now: Date,
  cap: number
): { items: OpenReminderItem[]; moreCount: number } {
  const summaryRange = { from: startOfLocalDay(summaryDay, timezone), to: startOfLocalDay(nextDate(summaryDay), timezone) };
  const open: Array<{ due: Date; item: OpenReminderItem }> = [];
  for (const { series, calendar, overrides, states } of candidates) {
```

Edit 4d: the tail of the loop builds items (lines 112-117). Replace:

```ts
    info.openSince = localDate(due, timezone);
    open.push({ due, event: { ...event, eventType: 'reminder', reminder: info } });
  }
  open.sort((a, b) => b.due.getTime() - a.due.getTime());
  return { events: open.slice(0, cap).map(o => o.event), moreCount: Math.max(0, open.length - cap) };
}
```

with:

```ts
    info.openSince = localDate(due, timezone);
    open.push({
      due,
      item: {
        event: { ...event, eventType: 'reminder', reminder: info },
        series,
        calendar,
        instanceStartsAt: occurrence.instanceStartsAt,
        ...(state ? { state } : {}),
      },
    });
  }
  open.sort((a, b) => b.due.getTime() - a.due.getTime());
  return { items: open.slice(0, cap).map(o => o.item), moreCount: Math.max(0, open.length - cap) };
}
```

Edit 4e: `fetchOpenReminders` delegates; `fetchOpenReminderItems` and the head of `loadOpenReminderCandidates` (lines 132-134). Replace:

```ts
): Promise<{ events: CalendarEvent[]; moreCount: number }> {
  if (user.calendarSource !== 'NATIVE') return { events: [], moreCount: 0 };
  const rows = await prisma.nativeEvent.findMany({
```

with:

```ts
): Promise<{ events: CalendarEvent[]; moreCount: number }> {
  if (user.calendarSource !== 'NATIVE') return { events: [], moreCount: 0 };
  const candidates = await loadOpenReminderCandidates(ctx, cutoff);
  return selectOpenReminders(candidates, ctx, cutoff, summaryDay, timezone, new Date(), cap);
}

/**
 * fetchOpenReminders' carry-overs as OpenReminderItems: the same read, rules, order and
 * cap, with each one's series, calendar, occurrence and state row. The calendar home's
 * range route passes Infinity.
 */
export async function fetchOpenReminderItems(
  user: UserConfig,
  ctx: ViewerContext,
  cutoff: Date,
  summaryDay: string,
  timezone: string,
  cap: number = OPEN_REMINDERS_DIGEST_CAP
): Promise<{ items: OpenReminderItem[]; moreCount: number }> {
  if (user.calendarSource !== 'NATIVE') return { items: [], moreCount: 0 };
  const candidates = await loadOpenReminderCandidates(ctx, cutoff);
  return selectOpenReminderItems(candidates, ctx, cutoff, summaryDay, timezone, new Date(), cap);
}

/** The one read behind fetchOpenReminders and fetchOpenReminderItems: each series with its calendar, overrides and state rows. */
async function loadOpenReminderCandidates(ctx: ViewerContext, cutoff: Date): Promise<OpenReminderCandidate[]> {
  const rows = await prisma.nativeEvent.findMany({
```

Edit 4f: the tail of `loadOpenReminderCandidates` (lines 145-149). Replace:

```ts
    include: { calendar: true, instances: true, states: true },
  });
  const candidates = rows.map(row => ({ series: row, calendar: row.calendar, overrides: row.instances, states: row.states }));
  return selectOpenReminders(candidates, ctx, cutoff, summaryDay, timezone, new Date(), cap);
}
```

with:

```ts
    include: { calendar: true, instances: true, states: true },
  });
  return rows.map(row => ({ series: row, calendar: row.calendar, overrides: row.instances, states: row.states }));
}
```

After the six edits, the read section has these, in order: `selectOpenReminders` (its body is now two lines), `selectOpenReminderItems`, `fetchOpenReminders` (its body is now three lines), `fetchOpenReminderItems`, `loadOpenReminderCandidates` (Plan A's `findMany` and the `rows.map`), then `addDigestReminders`, unchanged.

- [ ] **Step 5: Create `src/services/calendar-read/famcal.ts`**

```ts
// The FamCal half of the calendar reader (calendar home spec §2.4): the built-in
// calendar's occurrences in a window as ReadItems, with the legend the home may show.
//
// The events are the native provider's own (fetchViewerItems), so a summary on the
// reader reads exactly what it reads today (A-1, A-4). Only built-in calendar users are
// read: anyone else makes no query. Nothing here writes, so it never calls
// ensurePrimaryNativeCalendar, getMainNativeCalendar or hasUsableCalendar.
//
// What the home may say about an item's calendar is its CalendarRef, never the event.
// A reminder the partner set for the viewer can sit on the partner's PRIVATE calendar;
// its ref is masked to the partner's name with no id. event.calendarName keeps the real
// name for the summary prompt, as today (A-6); the DTO never reads it.

import type { NativeCalendar, NativeEvent } from '@prisma/client';
import type { UserConfig } from '../../types';
import type { UnifiedEvent } from '../calendar-provider/types';
import { fetchViewerItems } from '../calendar-provider/native-provider';
import { encodeCalendarId, listVisibleCalendars } from '../native-calendar/event-store';
import { loadViewerContext, type ViewerContext } from '../native-reminders/ownership';
import type { OpenReminderItem } from '../native-reminders/open-reminders';
import type { CalendarRef, FamcalRead, ReadItem } from './types';

type FamcalOk = Extract<FamcalRead, { status: 'ok' }>;
type Partner = { name: string } | null;

const partnerOf = (ctx: ViewerContext): Partner => (ctx.partner ? { name: ctx.partner.name } : null);

/** A legend calendar: the partner's carry the partner's name (Ruling R7). */
function legendRef(calendar: NativeCalendar, viewerId: number, partner: Partner): CalendarRef {
  const mine = calendar.ownerUserId === viewerId;
  return {
    id: encodeCalendarId(calendar.id),
    source: 'famcal',
    name: calendar.name,
    color: calendar.color,
    mine,
    ...(!mine && partner ? { ownerName: partner.name } : {}),
    inLegend: true,
  };
}

/**
 * The ref of an occurrence on calendar `cuid`: its legend entry, or masked when the
 * calendar is not in the legend (the partner's PRIVATE calendar, for a reminder the
 * partner set for the viewer).
 */
function refFor(cuid: string, legend: ReadonlyMap<string, CalendarRef>, partner: Partner): CalendarRef {
  return legend.get(encodeCalendarId(cuid)) ?? { id: null, source: 'famcal', name: partner?.name ?? '', color: null, mine: false, inLegend: false };
}

/** The legend's refs by calendar id ('native:<cuid>'). */
function legendById(calendars: readonly CalendarRef[]): Map<string, CalendarRef> {
  const byId = new Map<string, CalendarRef>();
  for (const c of calendars) if (c.id) byId.set(c.id, c);
  return byId;
}

/**
 * One occurrence as a ReadItem. `event` is the provider's, untouched. A reminder always
 * has `state` (nulls when the occurrence has no state row); an event has none.
 */
function toReadItem(
  parts: {
    series: Pick<NativeEvent, 'id' | 'kind' | 'rrule'>;
    title: string;
    instanceStartsAt: Date;
    state?: { doneAt: Date | null; snoozedUntil: Date | null };
    event: UnifiedEvent;
  },
  calendar: CalendarRef
): ReadItem {
  const kind = parts.series.kind === 'REMINDER' ? 'reminder' : 'event';
  return {
    source: 'famcal',
    key: `famcal|${parts.event.eventId ?? parts.series.id}`,
    event: parts.event,
    calendar,
    title: parts.title,
    kind,
    seriesId: parts.series.id,
    originalStart: parts.instanceStartsAt.toISOString(),
    recurring: parts.series.rrule != null,
    rrule: parts.series.rrule,
    ...(kind === 'reminder'
      ? { state: { doneAt: parts.state?.doneAt ?? null, snoozedUntil: parts.state?.snoozedUntil ?? null } }
      : {}),
  };
}

/**
 * The built-in calendar's occurrences in [window.from, window.to), and the legend.
 *
 * - Legend: listVisibleCalendars, the viewer's own calendars of any privacy and the
 *   ACTIVE partner's shared ones, narrowed to `calendarIds` when given (the summaries
 *   pass the ids they resolved). Calendar ids never come from anywhere else.
 * - No legend calendar: no items, as the native provider gives for an empty calendar list.
 * - Items: fetchViewerItems over the legend, in the provider's order, so
 *   items.map(i => i.event) is what the provider returns for the same calendars.
 * - Any error: { status: 'error', cause } and no items. Nothing is logged here: the
 *   summary rethrows the cause, and the route reports the status.
 * - A user not on the built-in calendar has no FamCal half (sourcesFor): an error,
 *   with no query.
 */
export async function readFamcal(
  user: UserConfig,
  window: { from: Date; to: Date },
  opts: { calendarIds?: readonly string[] }
): Promise<{ read: FamcalRead; items: ReadItem[] }> {
  if (user.calendarSource !== 'NATIVE') {
    return { read: { status: 'error', cause: new Error('readFamcal: not a built-in calendar user') }, items: [] };
  }
  try {
    const visible = await listVisibleCalendars(user.id, user.pairingId ?? null);
    const wanted = opts.calendarIds ? new Set(opts.calendarIds) : null;
    const legend = wanted ? visible.filter((c) => wanted.has(encodeCalendarId(c.id))) : visible;
    if (legend.length === 0) {
      const ctx = await loadViewerContext({ id: user.id, pairingId: user.pairingId ?? null });
      return { read: { status: 'ok', ctx, calendars: [], partner: partnerOf(ctx) }, items: [] };
    }
    const { ctx, items } = await fetchViewerItems(user, legend.map((c) => c.id), window);
    const partner = partnerOf(ctx);
    const calendars = legend.map((c) => legendRef(c, user.id, partner));
    const byId = legendById(calendars);
    return {
      read: { status: 'ok', ctx, calendars, partner },
      items: items.map(({ row, state, event }) =>
        toReadItem(
          { series: row.series, title: row.instance.title, instanceStartsAt: row.instance.instanceStartsAt, state, event },
          refFor(row.calendar.id, byId, partner)
        )
      ),
    };
  } catch (cause) {
    return { read: { status: 'error', cause }, items: [] };
  }
}

/**
 * Carried-over reminders (fetchOpenReminderItems) as ReadItems, under the rows' legend
 * rule: named when the calendar is in `famcal`'s legend, else masked. Each one's
 * originalStart is its occurrence's original start. For the range route (spec §4 step 6).
 */
export function carryOverReadItems(famcal: FamcalOk, carryOvers: readonly OpenReminderItem[]): ReadItem[] {
  const byId = legendById(famcal.calendars);
  return carryOvers.map((c) =>
    toReadItem(
      { series: c.series, title: c.event.summary, instanceStartsAt: c.instanceStartsAt, state: c.state, event: c.event },
      refFor(c.calendar.id, byId, famcal.partner)
    )
  );
}
```
- [ ] **Step 6: Run the smoke and the regression smokes again**

```bash
cd /Users/razielgershoni/development/famcalbot
for tz in UTC Asia/Jerusalem; do TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-calendar-read-famcal.ts; echo "smoke-calendar-read-famcal $tz exit=$?"; done
for f in smoke-native-provider-reminders smoke-reminders smoke-native-reminder-digest smoke-native-reminder-edit smoke-voice-dates; do for tz in UTC Asia/Jerusalem; do TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/$f.ts 2>&1 | grep -E '^(OK|FAIL)|passed' > /tmp/b5-$f-${tz//\//_}.after; echo "$f $tz exit=${pipestatus[1]}"; cmp -s /tmp/b5-$f-${tz//\//_}.before /tmp/b5-$f-${tz//\//_}.after && echo "  same output as Step 2" || echo "  OUTPUT CHANGED"; done; done
```
(zsh, as in Step 2.)
Expected for the new smoke, under each clock:
```
OK  fetchViewerItems: the provider's events, each with its row and state, from the same queries
OK  readFamcal: Dana's events are exactly what her summary reads today (A-1, A-4), in its order
OK  readFamcal: the legend is her own calendars of any privacy, then Raziel's shared one, with his name
OK  readFamcal: every item's fields
OK  readFamcal: a reminder-for-me from Raziel's PRIVATE calendar never names that calendar
OK  readFamcal: Raziel sees the other side, Dana's shared calendar named after her
OK  readFamcal: calendarIds narrow the legend, and an id outside it is never read
OK  readFamcal: no legend calendar, no items and no event read, as the provider
OK  readFamcal: a Google user is never queried
OK  readFamcal: a database error is the half's error, with its cause
OK  readFamcal: Noam alone: his calendar, no partner
OK  readFamcal: a suspended partner's items stay (R4)
OK  readFamcal: a partner who moved to Google: her own calendars only, the partner still named
OK  fetchOpenReminderItems: the same read as fetchOpenReminders, paired or not
OK  fetchOpenReminderItems: the same carry-overs, newest first, each with its occurrence and state row
OK  fetchOpenReminderItems: the cap and the count past it, as fetchOpenReminders
OK  fetchOpenReminderItems: a Google user is never read
OK  carryOverReadItems: masked off the legend, named on it; originalStart is the occurrence's
OK  fetchOpenReminderItems: a first time moved before the series start is carried, keyed by its original slot (Plan A)
OK  readFamcal: today's Vitamins moved to 10:30 tomorrow ("just this one") is read on tomorrow, keyed and stated by today's 08:00 slot
OK  nothing above reported an error

21/21 passed (process TZ=UTC)
smoke-calendar-read-famcal UTC exit=0
```
Then the same with `(process TZ=Asia/Jerusalem)`.

Every regression run prints `exit=0` and `same output as Step 2`. In particular, `smoke-native-provider-reminders.ts` and `smoke-reminders.ts` pass unchanged, as the spec requires. If only the `(Plan A)` check fails, with "Plan A's wider fetchOpenReminders read is missing", Plan A Task 2's Edit 3d hasn't landed. Land it first; don't change the check.

- [ ] **Step 7: Type-check and lint**

```bash
cd /Users/razielgershoni/development/famcalbot
npx tsc --noEmit -p . && npm run -s lint; echo "exit $?"
```
Expected: no output from either, then `exit 0`. `next build` type-checks `scripts/**`, so the smoke is covered too.

- [ ] **Step 8: Commit**

```bash
cd /Users/razielgershoni/development/famcalbot
git add src/services/calendar-provider/native-provider.ts src/services/native-reminders/open-reminders.ts src/services/calendar-read/famcal.ts scripts/smoke-calendar-read-famcal.ts
git commit -m "$(cat <<'EOF'
feat(calendar-read): the FamCal half of the reader

readFamcal reads a built-in calendar user's occurrences in a window as
ReadItems, with the legend the home may show. The events are the native
provider's own, through fetchViewerItems, split out of fetchForViewer with
no behaviour change. A reminder-for-me from the partner's PRIVATE calendar
is masked to the partner's name, a calendar outside the legend is never
read, and a Google user is never queried. fetchOpenReminderItems gives the
home the carry-overs with each one's occurrence and state row, from the
digest's own read. Nothing calls them yet, and the switch stays OFF.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
EOF
)"
```
Stage only these four paths.

---

### Task 6 (B6): The Google half of the reader, without its cache

**What and why.** The calendar home and, from Plan C, the summaries read Google through one function. It replaces today's three Google read paths (`calendar.ts:76-162`, `:445-518`, `week-lookahead.ts:202-254`), which have no timeout, read only Google's first 250 items, ask `calendars.get` for every calendar's name, let working-location blocks and declined invites through, and refresh the token inside the first request. That last point means a dead token, a stuck token server and a rate limit all end up as "token expired".

`readGoogle` reads the user's chosen calendars over a window (spec §2.5):
- the token step first, inside the read's deadline;
- one `events.list` per calendar, in parallel, with the exact field mask, `maxAttendees: 1`, the user's timezone, a request timeout and one retry;
- paging up to 5,000 items per calendar;
- B4's filter and mapper;
- the legend joined from `calendarAssignments`;
- one status for the half, with the deadline rules;
- logging: failures as Sentry warnings, gone calendars once a day, and a rejected OAuth client paging the admin once an hour.

This task has no cache. B7 wraps `readGoogleUncached` and swaps in its own `readGoogle`. Nothing calls the reader yet (B8 does), so nothing users see changes. The only live code touched is `getCalendarClient`, which now builds on the new `getGoogleAuth` with the same behaviour.

**Interface change:** none. The split's signatures are kept exactly:
- `readGoogle(user: UserConfig, window: { from: Date; to: Date }, opts: { tz: string; calendarIds?: readonly string[]; deadlineMs: number }): Promise<{ read: GoogleRead; items: ReadItem[] }>`;
- `getGoogleAuth(token)`;
- the five gcal keys.

The split didn't fix two key strings, so this task chooses them: `gcalGoneWarned` → `gcal:gone_warned:{userId}` and `gcalConfigAlert()` → `gcal:config_alert`. `gcalRange` and `gcalFresh` take `from`/`to` as plain strings, and B7 picks their format (the spec's key shows them after `tz`). The extra exports B7 and B8 rely on are listed under **Produces**.

**Findings (read before you start):**
- **calendar.ts.** `getCalendarClient` (`src/services/calendar.ts:17-28`) is the only builder that changes. `fetchEvents` (`:83-92`), `listUserCalendars` (`:204-213`) and `createEvent` (`:347-356`) build their own client inline and stay as they are: spec edit 2 says nothing else in `calendar.ts` changes. `fetchTodayEvents` keeps its inline client, so the smoke's parity check runs today's code unchanged.
- **Installed library.** `@googleapis/calendar` 9.8.0 bundles its own `gaxios` 6.7.1 and `google-auth-library` 9.15.1, under `node_modules/@googleapis/calendar/node_modules/`.
  - `getAccessToken()` refreshes once and stores the access token on the client. The lists that follow reuse it, so a read makes one token request.
  - Per-request `timeout` and `retryConfig` reach gaxios unchanged: googleapis-common only defaults `retry` (`apirequest.js:263`), and gaxios reads `retryConfig` (`retry.js:16-40`).
  - gaxios's default `errorRedactor` (`gaxios.js:464-466`) strips secrets and refresh tokens from an error's config before it reaches Sentry. Today's path already captures the same errors.
- **What the deadline does to requests in flight.** They are not aborted. Each is bounded by its own timeout (at most 10 s), and its late result is ignored: the outcome is a snapshot taken when the deadline fires, and `listCalendar` changes nothing after it.
- **Reporting is fire-and-forget.** The Redis gate and the admin notice never delay, change or fail a read. When Redis fails:
  - the gone warning still goes out (fails open: a lost warning hides a broken setup);
  - the config notice does not (fails closed: an outage of both must not page the admin once per read). The `captureError` at level error still goes out.
- **No stamping here.** Spec §2.6 has reads that end in `reconnect` or `calendars_gone` stamp the cache. B7's wrapper does that, for cached reads only: a `'bypass'` read (every summary's) never touches Redis.
- **No source check here.** `readGoogle` doesn't look at `calendarSource`; `sourcesFor` in B8 does. A NATIVE user has an empty token, so a stray call would answer `reconnect('token')`. B8 must never make it.
- **`notifyAdminError`** is loaded with `import()`, as every other caller does (`summary.ts:511`, `cron-handler.ts:60`), because it pulls in the bot.
- **Two smoke mechanics:**
  - Under tsx, a dynamic `import()` of a module served by a `Module._load` stub sees named exports only when the stub carries `__esModule: true`. Without it, the namespace has only `default`. So every stub in the smoke carries it. On Node 22 (production's engine) even that is not enough: the `import()` of the notifier sees no `notifyAdminError`, and the `invalid_client` check fails with "no admin notice". So `Module.registerHooks` (Node 22.15+) also serves the stubs to `import()`, as B7's smoke does. With it the smoke prints 34/34 on Node 22.23.3 and on Node 26.
  - `assert(list.length === n)` is an assertion function, so TypeScript narrows `.length` to the literal and rejects a later `=== n + 1` (TS2367). The smoke reads lengths through `count()`.
- **Depends on B3 and B4.** It needs `src/services/calendar-read/types.ts` (spec §2.2), `src/services/calendar-read/google-map.ts` and `htmlToText`. The smoke also runs B3's `toRangeDays` on one invite read from two calendars. It was verified against stand-ins written to the spec. If B4's `mapGoogleEvent` differs from today's mapper on plain-text fixtures, the parity check (#7) catches it.
- **Mutation-checked.** Each of these breaks at least one check: the field mask, `maxAttendees`, `retryConfig`, the timeout formula, the timezone, the cap, deadline truncation, scopes-over-token, the NX gates, the sort, `mine`, a token-step 404 read as `calendars_gone`, a missing token step, lists not raced against the deadline (the 60 s watchdog fails it), the outer catch, and an item key without its calendar id (one invite on two calendars).
- The working tree may show other plan or spec files as modified. Stage only the four paths in Step 9.

**Files:**
- Modify: `src/services/calendar.ts:14-28` (split `getCalendarClient` into `getGoogleAuth` + `getCalendarClient`)
- Modify: `src/config/redis-keys.ts`, insert after the `holidays` entry (`:81-82` on main@858886c; B1's `CALENDAR_HOME_ROLLOUT` lands elsewhere in the same object, keep both)
- Create: `src/services/calendar-read/google.ts`
- Create (test): `scripts/smoke-calendar-read-google.ts`
- Test: `scripts/smoke-calendar-read-google.ts`. Regression, unchanged: `scripts/smoke-reminders.ts` (real `calendar.ts` over a fake `@googleapis/calendar`), `scripts/smoke-week-lookahead.ts`, `scripts/smoke-google-connect.ts`, `scripts/smoke-oauth-weather.ts`, `scripts/smoke-voice-dates.ts`, `scripts/smoke-native-reminder-create-flow.ts`

**Interfaces:**
- Consumes:
  - B3, `src/services/calendar-read/types.ts`: `CalendarRef`, `ReadItem`, `GoogleRead` (spec §2.2).
  - B4, `src/services/calendar-read/google-map.ts`:
    - `classifyGoogleError(e: unknown): 'scopes' | 'token' | 'config' | 'gone' | 'transient' | 'unknown'`;
    - `keepGoogleEvent(raw: calendar_v3.Schema$Event): boolean`;
    - `mapGoogleEvent(raw: calendar_v3.Schema$Event, calendarId: string, calendarName: string): Omit<ReadItem, 'calendar'>`.
  - `captureError(error: unknown, context: string, extra?: ErrorContext, severity?: 'fatal' | 'error' | 'warning' | 'info'): void` and `captureWarning(message: string, context: string, extra?: ErrorContext): void` (`src/lib/error-capture.ts:21, :55`).
  - `notifyAdminError(context: string, error: unknown, additionalInfo?: string): Promise<void>` (`src/utils/error-notifier.ts:32`).
  - `redis.set(key, value, { nx: true, ex })`, which answers `'OK'` or `null` (`src/utils/redis.ts:3`, `@upstash/redis` 1.35.8).
  - `UserConfig` (`googleRefreshToken: string`, `calendarAssignments?: CalendarAssignment[]`, `id: number`) and `CalendarAssignment` (`src/types.ts:8-19, :22-44`).
- Produces:
  - `src/services/calendar.ts`:
    - `export function getGoogleAuth(refreshToken: string): InstanceType<typeof auth.OAuth2>`;
    - `getCalendarClient(refreshToken: string): calendar_v3.Calendar` keeps its signature and behaviour.
  - `src/config/redis-keys.ts`, `REDIS_KEYS`:
    - `gcalRange(userId: number, setHash: string, tz: string, from: string, to: string)` → `gcal:range:v1:${userId}:${setHash}:${tz}:${from}:${to}`;
    - `gcalStamp(userId: number)` → `gcal:stamp:${userId}`;
    - `gcalGoneWarned(userId: number)` → `gcal:gone_warned:${userId}`;
    - `gcalFresh(userId: number, from: string, to: string)` → `gcal:fresh:${userId}:${from}:${to}`;
    - `gcalConfigAlert()` → `gcal:config_alert`.
  - `src/services/calendar-read/google.ts`:
    - `export type GoogleItem = Omit<ReadItem, 'calendar'>`, the cache value's item type (B7);
    - `export interface GoogleReadOptions { tz: string; calendarIds?: readonly string[]; deadlineMs: number }`;
    - `export interface GoogleReadResult { read: GoogleRead; items: ReadItem[] }`, with `items` empty unless `read.status === 'ok'`;
    - `export function googleCalendarSet(user: Pick<UserConfig, 'calendarAssignments'>, calendarIds?: readonly string[]): CalendarAssignment[]`: the choices in their order, narrowed, deduped;
    - `export function googleCalendarRef(a: CalendarAssignment, goneIds: readonly string[]): CalendarRef`;
    - `export function attachGoogleCalendars(items: readonly GoogleItem[], set: readonly CalendarAssignment[], goneIds: readonly string[]): ReadItem[]`;
    - `export async function readGoogleUncached(user: UserConfig, window: { from: Date; to: Date }, opts: GoogleReadOptions): Promise<GoogleReadResult>`: the live read; never rejects;
    - `export function readGoogle(user: UserConfig, window: { from: Date; to: Date }, opts: GoogleReadOptions): Promise<GoogleReadResult>`: in B6 it only calls `readGoogleUncached`. B7 replaces its body and widens `opts` to `GoogleReadOptions & { googleCache?: 'use' | 'refresh' | 'bypass'; defer?: (task: () => Promise<void>) => void }`.
  - How B7 wraps it:
    - take `startedAt = Date.now()` before calling `readGoogleUncached`;
    - `setHash` comes from `googleCalendarSet(user, opts.calendarIds).map(a => a.calendarId)`;
    - the cache value's items are `items.map(({ calendar: _c, ...rest }) => rest)`;
    - on a hit, `items = attachGoogleCalendars(entry.items, set, entry.goneIds)` and `read = { status: 'ok', calendars: set.map(a => googleCalendarRef(a, entry.goneIds)), goneIds: entry.goneIds, partial: null, stale }`;
    - stamp when the read ends in `reconnect` or `error('calendars_gone')`.

- [ ] **Step 1: Write the failing smoke `scripts/smoke-calendar-read-google.ts`**

```ts
// Smoke test for the calendar home's Google half without its cache (spec §2.5, §10):
// src/services/calendar-read/google.ts. Today a Google read refreshes the token inside
// the first request, so a dead token, a stuck token server and a rate limit all look
// alike; it asks calendars.get for every calendar's name; it takes Google's first 250
// items and no more; it has no timeout; and it lets working-location blocks, declined
// invites and cancelled items through. The reader runs the token step first inside one
// deadline, lists each chosen calendar in parallel with a trimmed field mask, the user's
// timezone, a request timeout and one retry, pages up to 5,000 items, filters and maps
// each item, joins the calendar legend from the user's choices, and turns every outcome
// into one status for the half.
//
// calendar.ts's fetchTodayEvents (today's summary fetch) runs against the same fake list,
// so the reader's events are checked against what the summaries read now.
//
// Faked: @googleapis/calendar (its OAuth2 client, calendars.get and events.list), Redis
// (in memory, expiring on a stepped clock), error capture and the admin notifier
// (recorders). Error shapes are built with the installed gaxios and google-auth-library.
// No network. The route's cache, the stamps and the single-flight are checked in
// smoke-calendar-read-google-cache.ts.
//
// Run with the fake env from the task brief; the output must not depend on the server's
// timezone:
//   TZ=UTC npx tsx scripts/smoke-calendar-read-google.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-calendar-read-google.ts
//   TZ=Pacific/Kiritimati npx tsx scripts/smoke-calendar-read-google.ts

import Module, { createRequire } from 'node:module';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import type { calendar_v3 } from '@googleapis/calendar';
import { nextDate, startOfLocalDay } from '../src/utils/day-events';
import { toRangeDays } from '../src/services/calendar-read/dto';
import { REDIS_KEYS } from '../src/config/redis-keys';
import type { CalendarAssignment, CalendarEvent, UserConfig } from '../src/types';
import type { GoogleReadOptions, GoogleReadResult } from '../src/services/calendar-read/google';
import type { CalendarRef } from '../src/services/calendar-read/types';

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

function assert(cond: boolean, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

/** JSON with sorted keys and no undefined fields, so two shapes compare by content. */
function canon(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>)
            .filter(([, x]) => x !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : v,
  );
}

function assertSame(got: unknown, want: unknown, what: string) {
  assert(canon(got) === canon(want), `${what}\n     got  ${canon(got)}\n     want ${canon(want)}`);
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** A list's length read afresh: an assert on `.length` would narrow it for the checks after it. */
const count = (list: readonly unknown[]): number => list.length;

/** Waits until cond holds (background reporting is fire-and-forget), at most `ms`. */
async function until(cond: () => boolean, ms = 1000) {
  const start = performance.now();
  while (!cond() && performance.now() - start < ms) await sleep(5);
}

// ---- Clock: every argument-less new Date() and Date.now() reads `clock` ----

const BASE_CLOCK = Date.parse('2026-10-14T13:00:00Z'); // 09:00 in New York
let clock = BASE_CLOCK;
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

// ---- Fake Google ----

type Page = calendar_v3.Schema$Events;
type ListParams = calendar_v3.Params$Resource$Events$List;
type ListOptions = { timeout?: number; retryConfig?: { retry?: number; noResponseRetries?: number } };

/** A reply that comes after a delay (real time; the deadline runs on real timers). */
class Later {
  constructor(readonly afterMs: number, readonly reply: Page | Error) {}
}
/** What one events.list request does: answer with a page, fail, never answer, or answer later. */
type Reply = Page | Error | 'hang' | Later;
/** A calendar's replies by page (page n is asked for with pageToken `p<n>`); the last one repeats. */
type Script = Reply[] | ((pageIndex: number) => Reply);

const google = {
  /** The token step: what getAccessToken answers. */
  token: (): Promise<unknown> => Promise.resolve({ token: 'access-token' }),
  pages: {} as Record<string, Script>,
  calls: [] as { params: ListParams; options?: ListOptions }[],
  /** Requests in call order: 'token', 'get:<id>', 'list:<id>'. */
  log: [] as string[],
  clients: 0,
  credentials: [] as unknown[],
  factory: [] as { version?: string; auth?: unknown }[],
  inFlight: 0,
  maxInFlight: 0,
};

function answer(reply: Reply): Promise<{ data: Page }> {
  if (reply === 'hang') return new Promise(() => {});
  if (reply instanceof Error) return Promise.reject(reply);
  if (reply instanceof Later) {
    const later = reply;
    return new Promise((resolve, reject) =>
      setTimeout(() => (later.reply instanceof Error ? reject(later.reply) : resolve({ data: later.reply })), later.afterMs),
    );
  }
  return Promise.resolve({ data: reply });
}

function track<T>(promise: Promise<T>): Promise<T> {
  google.inFlight++;
  google.maxInFlight = Math.max(google.maxInFlight, google.inFlight);
  promise.then(() => { google.inFlight--; }, () => { google.inFlight--; });
  return promise;
}

class FakeOAuth2 {
  constructor(readonly clientId?: string, readonly clientSecret?: string) {
    google.clients++;
  }
  setCredentials(credentials: unknown) {
    google.credentials.push(credentials);
  }
  getAccessToken() {
    google.log.push('token');
    return google.token();
  }
}

const fakeGoogleModule = {
  __esModule: true,
  auth: { OAuth2: FakeOAuth2 },
  calendar: (options: { version?: string; auth?: unknown }) => {
    google.factory.push(options);
    return {
      calendars: {
        get: async ({ calendarId }: { calendarId: string }) => {
          google.log.push(`get:${calendarId}`);
          return { data: { summary: TITLES[calendarId] ?? calendarId } };
        },
      },
      events: {
        list: (params: ListParams, options?: ListOptions) => {
          google.calls.push({ params: { ...params }, options });
          google.log.push(`list:${params.calendarId}`);
          const script = google.pages[params.calendarId ?? ''] ?? [{ items: [] }];
          const index = params.pageToken ? Number(params.pageToken.slice(1)) - 1 : 0;
          const reply = typeof script === 'function' ? script(index) : script[Math.min(index, script.length - 1)];
          return track(answer(reply));
        },
      },
    };
  },
};

// ---- Real error shapes: gaxios's error, run through google-auth-library's processError ----

const calendarRequire = createRequire(require.resolve('@googleapis/calendar'));
const { GaxiosError } = calendarRequire('gaxios') as {
  GaxiosError: new (message: string, config: object, response?: object, error?: Error) => Error;
};
const { DefaultTransporter } = calendarRequire('google-auth-library') as {
  DefaultTransporter: new () => { processError(e: Error): Error };
};

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

function googleError(url: string, method: 'GET' | 'POST', status: number, data: unknown): Error {
  const config = { url, method };
  const response = { config, data, status, statusText: '', headers: {} };
  return new DefaultTransporter().processError(new GaxiosError(`Request failed with status code ${status}`, config, response));
}

/** The token step's failure: refreshAccessTokenAsync prefixes a 403 or 404 (oauth2client.js:336-342). */
function tokenError(status: number, data: unknown): Error {
  const err = googleError(TOKEN_URL, 'POST', status, data);
  if (status === 403 || status === 404) err.message = `Could not refresh access token: ${err.message}`;
  return err;
}

/** An events.list failure with Google's JSON error body. */
function apiError(calendarId: string, status: number, reason: string, message: string): Error {
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
  return googleError(url, 'GET', status, { error: { code: status, message, errors: [{ domain: 'global', reason, message }] } });
}

// ---- Fake Redis (Upstash round-trips values through JSON), recorders ----

let redisDown = false;
const redisStore = new Map<string, { value: unknown; expiresAt: number | null }>();
const redisSets: { key: string; opts?: { nx?: boolean; ex?: number } }[] = [];
function liveEntry(key: string) {
  const entry = redisStore.get(key);
  if (entry && entry.expiresAt !== null && entry.expiresAt <= clock) {
    redisStore.delete(key);
    return undefined;
  }
  return entry;
}
const fakeRedis = {
  set: async (key: string, value: unknown, opts?: { nx?: boolean; ex?: number }) => {
    if (redisDown) throw new Error('Upstash unreachable');
    redisSets.push({ key, opts });
    if (opts?.nx && liveEntry(key)) return null;
    redisStore.set(key, { value: JSON.parse(JSON.stringify(value)), expiresAt: opts?.ex ? clock + opts.ex * 1000 : null });
    return 'OK';
  },
  get: async (key: string) => {
    if (redisDown) throw new Error('Upstash unreachable');
    return liveEntry(key)?.value ?? null;
  },
  del: async (key: string) => {
    if (redisDown) throw new Error('Upstash unreachable');
    return redisStore.delete(key) ? 1 : 0;
  },
};

let captures: { error: unknown; context: string; extra?: Record<string, unknown>; severity: string }[] = [];
let warnings: { message: string; context: string; extra?: Record<string, unknown> }[] = [];
let adminAlerts: { context: string; error: unknown; info?: string }[] = [];
const unhandled: unknown[] = [];
process.on('unhandledRejection', reason => { unhandled.push(reason); });

const SRC = path.resolve(__dirname, '../src');
const stubs: Record<string, object> = {
  '@googleapis/calendar': fakeGoogleModule,
  [`${SRC}/utils/redis.ts`]: { __esModule: true, redis: fakeRedis },
  [`${SRC}/lib/error-capture.ts`]: {
    __esModule: true,
    captureError: (error: unknown, context: string, extra?: Record<string, unknown>, severity = 'error') => {
      captures.push({ error, context, extra, severity });
    },
    captureWarning: (message: string, context: string, extra?: Record<string, unknown>) => {
      warnings.push({ message, context, extra });
    },
    captureInfo: () => {},
  },
  // google.ts loads the notifier with import(); __esModule lets that see the named export.
  [`${SRC}/utils/error-notifier.ts`]: {
    __esModule: true,
    notifyAdminError: async (context: string, error: unknown, info?: string) => {
      adminAlerts.push({ context, error, info });
    },
    notifyAdminWarning: async () => {},
  },
};

const ModuleInternals = Module as unknown as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  _resolveFilename: (request: string, parent: unknown, isMain: boolean) => string;
};
const realLoad = ModuleInternals._load;
ModuleInternals._load = function (request, parent, isMain) {
  if (request in stubs) return stubs[request];
  let resolved = request;
  try {
    resolved = ModuleInternals._resolveFilename(request, parent, isMain);
  } catch {}
  return stubs[resolved] ?? realLoad.call(this, request, parent, isMain);
};
// google.ts loads the notifier with import(). On Node 22 that import goes past
// Module._load and sees no named export, so an ES module hook serves the same stub
// objects to import() (as smoke-calendar-read-google-cache does).
(globalThis as { smokeStubs?: typeof stubs }).smokeStubs = stubs;
Module.registerHooks({
  load(url, context, nextLoad) {
    const file = url.startsWith('file:') ? fileURLToPath(url.split('?')[0]) : '';
    const stub = stubs[file];
    if (!stub) return nextLoad(url, context);
    const names = Object.keys(stub).filter(name => name !== '__esModule').map(name => `export const ${name} = fake.${name};`).join('\n');
    return { format: 'module', shortCircuit: true, source: `const fake = globalThis.smokeStubs[${JSON.stringify(file)}];\n${names}\n` };
  },
});

// ---- Fixtures ----

const NY = 'America/New_York';
const DAY = '2026-10-14';
const DAY_WINDOW = { from: startOfLocalDay(DAY, NY), to: startOfLocalDay(nextDate(DAY), NY) };
const FIELDS =
  'summary,nextPageToken,items(id,status,summary,description,location,start,end,recurringEventId,originalStartTime,eventType,attendees(self,responseStatus),htmlLink)';

const DANA = 'dana@example.com';
const AVI = 'avi.cohen@example.com';
const KIDS = 'family0123@group.calendar.google.com';
/** Each calendar's title in Google (events.list's top-level summary, calendars.get's summary). */
const TITLES: Record<string, string> = { [DANA]: 'dana@example.com', [AVI]: 'Avi Cohen', [KIDS]: 'Family' };
/** The user's choices, as select-calendars saved them: their own names and colours. */
const ASSIGNMENTS: CalendarAssignment[] = [
  { calendarId: DANA, labels: ['primary', 'yours'], name: 'Dana', color: '#7986cb' },
  { calendarId: AVI, labels: ['spouse'], name: 'Avi (work)', color: '#33b679', personName: 'Avi' },
  { calendarId: KIDS, labels: ['kids'], name: 'Kids', color: '' },
];
const LEGEND: CalendarRef[] = [
  { id: DANA, source: 'google', name: 'Dana', color: '#7986cb', mine: true, inLegend: true },
  { id: AVI, source: 'google', name: 'Avi (work)', color: '#33b679', mine: false, ownerName: 'Avi', inLegend: true },
  { id: KIDS, source: 'google', name: 'Kids', color: null, mine: true, inLegend: true },
];

const user = (extra: Partial<UserConfig> = {}): UserConfig =>
  ({
    id: 7,
    telegramId: 7007,
    name: 'Dana',
    language: 'en',
    calendarSource: 'GOOGLE',
    googleRefreshToken: 'refresh-7',
    pairingId: null,
    calendarAssignments: ASSIGNMENTS,
    ...extra,
  }) as unknown as UserConfig;

type Raw = calendar_v3.Schema$Event;
const timed = (id: string, summary: string | undefined, start: string, end: string, extra: Raw = {}): Raw =>
  ({ id, status: 'confirmed', summary, start: { dateTime: start, timeZone: NY }, end: { dateTime: end, timeZone: NY }, ...extra });
const allDay = (id: string, summary: string, start: string, end: string, extra: Raw = {}): Raw =>
  ({ id, status: 'confirmed', summary, start: { date: start }, end: { date: end }, ...extra });

/** One New York day, plain-text descriptions only (spec §10: the mapping parity fixtures). */
const DAY_EVENTS: Record<string, Raw[]> = {
  [DANA]: [
    timed('school-run', 'School run', '2026-10-14T07:30:00-04:00', '2026-10-14T08:00:00-04:00', {
      location: 'Oak Street School',
      description: 'Bring the permission slip',
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 10 }] },
    }),
    timed('dentist', 'Dentist', '2026-10-14T09:00:00-04:00', '2026-10-14T10:00:00-04:00', { reminders: { useDefault: true } }),
    timed('untitled', undefined, '2026-10-14T12:00:00-04:00', '2026-10-14T12:30:00-04:00', {
      htmlLink: 'https://www.google.com/calendar/event?eid=dW50aXRsZWQ',
    }),
    timed('gym_20261014T220000Z', 'Gym', '2026-10-14T18:00:00-04:00', '2026-10-14T19:00:00-04:00', {
      recurringEventId: 'gym',
      originalStartTime: { dateTime: '2026-10-14T18:00:00-04:00' },
    }),
  ],
  [AVI]: [
    allDay('mom-birthday', "Mom's birthday", '2026-10-14', '2026-10-15', { eventType: 'birthday' }),
    timed('standup', 'Standup', '2026-10-14T09:00:00-04:00', '2026-10-14T09:15:00-04:00', { eventType: 'default' }),
    timed('flight', 'Flight to Boston', '2026-10-14T21:00:00-04:00', '2026-10-15T01:30:00-04:00', { eventType: 'fromGmail' }),
  ],
  [KIDS]: [timed('pickup', 'Pickup', '2026-10-14T15:00:00-04:00', '2026-10-14T15:30:00-04:00')],
};
const dayPage = (calendarId: string): Page => ({ summary: TITLES[calendarId], items: DAY_EVENTS[calendarId] });
const dayPages = (): Record<string, Script> => Object.fromEntries(Object.keys(DAY_EVENTS).map(id => [id, [dayPage(id)]]));

const bulk = (prefix: string, count: number): Raw[] =>
  Array.from({ length: count }, (_, k) => timed(`${prefix}-${k}`, 'Busy', '2026-10-14T10:00:00-04:00', '2026-10-14T10:30:00-04:00'));

function reset() {
  clock = BASE_CLOCK;
  google.token = () => Promise.resolve({ token: 'access-token' });
  google.pages = dayPages();
  google.calls = [];
  google.log = [];
  google.clients = 0;
  google.credentials = [];
  google.factory = [];
  google.inFlight = 0;
  google.maxInFlight = 0;
  redisDown = false;
  redisStore.clear();
  redisSets.length = 0;
  captures = [];
  warnings = [];
  adminAlerts = [];
}

async function check(name: string, fn: () => Promise<void>) {
  reset();
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
  // Let the read's fire-and-forget reporting finish before the next check resets the fakes.
  await sleep(30);
}

/** The read's status without its cause and legend (those are checked on their own). */
function statusOf(r: GoogleReadResult): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...r.read };
  delete copy.cause;
  delete copy.calendars;
  return copy;
}
const OK = { status: 'ok', goneIds: [], partial: null, stale: false };
const ids = (r: GoogleReadResult) => r.items.map(i => i.event.eventId);
const listedCalendars = () => google.calls.map(c => c.params.calendarId);
const withoutReminders = (e: CalendarEvent) => {
  const copy = { ...e };
  delete copy.reminders;
  return copy;
};

async function main() {
  // A read that never settles would end the process with nothing printed; fail loudly instead.
  setTimeout(() => {
    console.error('FAIL  the smoke did not finish within 60 s (a read never settled)');
    process.exit(1);
  }, 60_000);
  const calendar = await import('../src/services/calendar');
  const reader = await import('../src/services/calendar-read/google');
  const readGoogle: (u: UserConfig, w: { from: Date; to: Date }, o: GoogleReadOptions) => Promise<GoogleReadResult> = reader.readGoogle;
  const read = (u: UserConfig = user(), o: Partial<GoogleReadOptions> = {}) =>
    readGoogle(u, DAY_WINDOW, { tz: NY, deadlineMs: 6000, ...o });

  // ---- calendar.ts and the keys ----

  await check('getGoogleAuth builds the OAuth2 client getCalendarClient used to build inline; getCalendarClient wraps it', async () => {
    const auth = calendar.getGoogleAuth('refresh-a') as unknown as FakeOAuth2;
    assert(auth instanceof FakeOAuth2, 'getGoogleAuth did not return the OAuth2 client');
    assert(auth.clientId === process.env.GOOGLE_CLIENT_ID && auth.clientSecret === process.env.GOOGLE_CLIENT_SECRET, 'not built from the client env');
    assertSame(google.credentials, [{ refresh_token: 'refresh-a' }], 'credentials');
    assert(count(google.factory) === 0, 'getGoogleAuth built a calendar client');
    calendar.getCalendarClient('refresh-b');
    assertSame(google.credentials, [{ refresh_token: 'refresh-a' }, { refresh_token: 'refresh-b' }], 'credentials after getCalendarClient');
    assert(count(google.factory) === 1 && google.factory[0].version === 'v3', 'getCalendarClient did not build a v3 client');
    assert(google.factory[0].auth instanceof FakeOAuth2 && google.clients === 2, 'getCalendarClient did not use a fresh OAuth2 client');
  });

  await check('the gcal Redis keys have the spec formats', async () => {
    assert(REDIS_KEYS.gcalRange(7, '0123456789abcdef', 'Asia/Jerusalem', '2026-10-14', '2026-10-21') === 'gcal:range:v1:7:0123456789abcdef:Asia/Jerusalem:2026-10-14:2026-10-21', 'gcalRange');
    assert(REDIS_KEYS.gcalStamp(7) === 'gcal:stamp:7', 'gcalStamp');
    assert(REDIS_KEYS.gcalGoneWarned(7) === 'gcal:gone_warned:7', 'gcalGoneWarned');
    assert(REDIS_KEYS.gcalFresh(7, '2026-10-14', '2026-10-21') === 'gcal:fresh:7:2026-10-14:2026-10-21', 'gcalFresh');
    assert(REDIS_KEYS.gcalConfigAlert() === 'gcal:config_alert', 'gcalConfigAlert');
  });

  // ---- Request shape ----

  await check('request: token step first, then one events.list with the spec params and options, no calendars.get', async () => {
    const r = await read(user(), { calendarIds: [DANA] });
    assertSame(statusOf(r), OK, 'status');
    assertSame(google.log, ['token', `list:${DANA}`], 'request order');
    assertSame(google.credentials, [{ refresh_token: 'refresh-7' }], 'credentials');
    assertSame(google.calls[0].params, {
      calendarId: DANA,
      timeMin: '2026-10-14T04:00:00.000Z',
      timeMax: '2026-10-15T04:00:00.000Z',
      singleEvents: true,
      orderBy: 'startTime',
      timeZone: NY,
      maxResults: 2500,
      maxAttendees: 1,
      fields: FIELDS,
    }, 'params');
    assert(!('eventTypes' in google.calls[0].params), 'eventTypes was sent');
    assertSame(google.calls[0].options, { timeout: 5500, retryConfig: { retry: 1, noResponseRetries: 0 } }, 'options');
  });

  await check('request: the timeout is min(10 s, deadline - 500 ms)', async () => {
    await read(user(), { calendarIds: [DANA], deadlineMs: 30000 });
    assert(google.calls[0].options?.timeout === 10000, `timeout ${google.calls[0].options?.timeout} at a 30 s deadline`);
    google.calls = [];
    await read(user(), { calendarIds: [DANA], deadlineMs: 8000 });
    assert(google.calls[0].options?.timeout === 7500, `timeout ${google.calls[0].options?.timeout} at an 8 s deadline`);
  });

  await check('request: the calendars are listed in parallel, in the order of the choices', async () => {
    google.pages = Object.fromEntries(Object.keys(DAY_EVENTS).map(id => [id, [new Later(40, dayPage(id))]]));
    const r = await read();
    assertSame(statusOf(r), OK, 'status');
    assertSame(listedCalendars(), [DANA, AVI, KIDS], 'listed');
    assert(google.maxInFlight === 3, `${google.maxInFlight} lists in flight at once`);
  });

  await check('calendarIds narrows the choices and keeps their order; an id the user did not choose is not read', async () => {
    const r = await read(user(), { calendarIds: [KIDS, 'stranger@example.com', DANA] });
    assertSame(listedCalendars(), [DANA, KIDS], 'listed');
    assertSame(r.read.status === 'ok' ? r.read.calendars.map(c => c.id) : null, [DANA, KIDS], 'legend');
  });

  // ---- Mapping ----

  await check("mapping: the reader's events equal today's fetchTodayEvents on the same list, plus provider, minus reminders", async () => {
    const today = await calendar.fetchTodayEvents('refresh-7', [DANA, AVI, KIDS], NY);
    assert(today.length === 8 && today.some(e => e.reminders), 'the fixture did not reach fetchTodayEvents');
    assert(google.log.includes(`get:${DANA}`), "today's fetch did not ask calendars.get");
    google.log = [];
    const r = await read();
    assertSame(statusOf(r), OK, 'status');
    assertSame(r.items.map(i => i.event), today.map(e => ({ ...withoutReminders(e), provider: 'google' })), 'events');
    assert(!google.log.some(entry => entry.startsWith('get:')), 'the reader asked calendars.get');
  });

  await check('mapping: the legend and each item come from the choices; calendarName stays the Google title', async () => {
    const r = await read();
    assert(r.read.status === 'ok', `status ${r.read.status}`);
    assertSame(r.read.calendars, LEGEND, 'legend');
    const byId = new Map(r.items.map(i => [i.event.eventId, i]));
    for (const item of r.items) {
      const ref = LEGEND.find(c => c.id === item.event.calendarId);
      assertSame(item.calendar, ref, `calendar of ${item.event.eventId}`);
      assert(item.event.calendarName === TITLES[item.event.calendarId], `calendarName of ${item.event.eventId}: ${item.event.calendarName}`);
      assert(item.key === `google|${item.event.calendarId}|${item.event.eventId}`, `key ${item.key}`);
    }
    const untitled = byId.get('untitled');
    assert(untitled?.title === null && untitled.event.summary === 'No title', 'untitled item');
    assert(untitled.google?.htmlLink === 'https://www.google.com/calendar/event?eid=dW50aXRsZWQ', 'htmlLink');
    const gym = byId.get('gym_20261014T220000Z');
    assert(gym?.seriesId === 'gym' && gym.originalStart === '2026-10-14T18:00:00-04:00' && gym.recurring && gym.rrule === null, 'recurring instance');
    assert(byId.get('mom-birthday')?.google?.birthday === true && byId.get('standup')?.google?.birthday === false, 'birthday flag');
    assertSame(ids(r), ['mom-birthday', 'school-run', 'dentist', 'standup', 'untitled', 'pickup', 'gym_20261014T220000Z', 'flight'], 'order');
  });

  await check('filter: non-events, declined, cancelled and start-less items are dropped; unknown types kept', async () => {
    const at = (h: string) => `2026-10-14T${h}:00-04:00`;
    google.pages[DANA] = [{
      summary: TITLES[DANA],
      items: [
        timed('office', 'Office', at('08:00'), at('17:00'), { eventType: 'workingLocation' }),
        timed('away', 'Out of office', at('08:00'), at('17:00'), { eventType: 'outOfOffice' }),
        timed('focus', 'Focus time', at('10:00'), at('11:00'), { eventType: 'focusTime' }),
        timed('declined', 'Team dinner', at('19:00'), at('21:00'), { attendees: [{ self: true, responseStatus: 'declined' }] }),
        timed('cancelled', 'Cancelled call', at('11:00'), at('11:30'), { status: 'cancelled' }),
        { id: 'no-start', status: 'confirmed', summary: 'No start' },
        timed('accepted', 'Lunch', at('12:00'), at('13:00'), { attendees: [{ self: true, responseStatus: 'accepted' }] }),
        timed('future-type', 'Something new', at('14:00'), at('15:00'), { eventType: 'someFutureType' }),
      ],
    }];
    const r = await read(user(), { calendarIds: [DANA] });
    assertSame(ids(r), ['accepted', 'future-type'], 'kept');
  });

  await check('one invite on two chosen calendars: an item per calendar, each with its own calendar, both on the day; a decline drops only that copy', async () => {
    // Both parents are invited, so the event (one id) is on Dana's calendar and on Avi's, labelled spouse.
    const invite = (extra: Raw = {}) => timed('evt1', 'Parent-teacher meeting', '2026-10-14T17:00:00-04:00', '2026-10-14T18:00:00-04:00', extra);
    google.pages[DANA] = [{ summary: TITLES[DANA], items: [invite()] }];
    google.pages[AVI] = [{ summary: TITLES[AVI], items: [invite()] }];
    const r = await read(user(), { calendarIds: [DANA, AVI] });
    assertSame(statusOf(r), OK, 'status');
    const copies = (items: GoogleReadResult['items']) => items.map(i => [i.key, i.event.calendarId, i.calendar.mine, i.calendar.ownerName ?? null]);
    assertSame(copies(r.items), [
      [`google|${DANA}|evt1`, DANA, true, null],
      [`google|${AVI}|evt1`, AVI, false, 'Avi'],
    ], 'the two copies');
    // A cache hit joins each item's calendar again from the choices, by event.calendarId (B7).
    const rejoined = reader.attachGoogleCalendars(r.items.map(({ calendar: _calendar, ...item }) => item), ASSIGNMENTS, []);
    assertSame(copies(rejoined), copies(r.items), 'joined again from the choices');
    // The home lists both on the day, in compareItems order: same times and title, so by key.
    const [day] = toRangeDays(r.items, DAY, nextDate(DAY), NY, new Date(), DAY);
    assertSame(day.items.map(i => [i.key, i.calendar.mine, i.calendar.ownerName ?? null]), [
      [`google|${AVI}|evt1`, false, 'Avi'],
      [`google|${DANA}|evt1`, true, null],
    ], 'the day');
    // Avi declined on his calendar: only his copy goes (Ruling R2), Dana's stays.
    google.pages[AVI] = [{ summary: TITLES[AVI], items: [invite({ attendees: [{ self: true, responseStatus: 'declined' }] })] }];
    const declined = await read(user(), { calendarIds: [DANA, AVI] });
    assertSame(copies(declined.items), [[`google|${DANA}|evt1`, DANA, true, null]], 'after the spouse declined');
  });

  // ---- Paging ----

  await check('paging: follows nextPageToken through an empty page to the end', async () => {
    const at = (h: string) => `2026-10-14T${h}:00-04:00`;
    google.pages[DANA] = [
      { summary: TITLES[DANA], items: [timed('a', 'A', at('08:00'), at('09:00'))], nextPageToken: 'p2' },
      { summary: TITLES[DANA], items: [], nextPageToken: 'p3' },
      { summary: TITLES[DANA], items: [timed('b', 'B', at('10:00'), at('11:00')), timed('c', 'C', at('12:00'), at('13:00'))] },
    ];
    const r = await read(user(), { calendarIds: [DANA] });
    assertSame(statusOf(r), OK, 'status');
    assertSame(google.calls.map(c => c.params.pageToken), [undefined, 'p2', 'p3'], 'page tokens');
    assertSame(ids(r), ['a', 'b', 'c'], 'items');
    assert(google.calls.every(c => c.params.timeMin === google.calls[0].params.timeMin && c.params.fields === FIELDS), 'pages changed the query');
  });

  await check('paging: 5,000 items is the cap; more marks the calendar truncated', async () => {
    google.pages[DANA] = (index: number) => ({ summary: TITLES[DANA], items: bulk(`p${index}`, 2000), nextPageToken: `p${index + 2}` });
    const r = await read(user(), { calendarIds: [DANA] });
    assertSame(statusOf(r), { ...OK, partial: { failed: 0, truncated: 1 } }, 'status');
    assert(google.calls.length === 3, `${google.calls.length} pages asked for`);
    assert(r.items.length === 5000, `${r.items.length} items`);
  });

  await check('paging: exactly 5,000 items with nothing after them is complete', async () => {
    google.pages[DANA] = [
      { summary: TITLES[DANA], items: bulk('first', 2500), nextPageToken: 'p2' },
      { summary: TITLES[DANA], items: bulk('second', 2500) },
    ];
    const r = await read(user(), { calendarIds: [DANA] });
    assertSame(statusOf(r), OK, 'status');
    assert(r.items.length === 5000 && google.calls.length === 2, `${r.items.length} items, ${google.calls.length} pages`);
  });

  // ---- Outcomes ----

  await check('one calendar gone (404) and one ok: ok, with goneIds and the gone calendar marked unavailable', async () => {
    google.pages[AVI] = [apiError(AVI, 404, 'notFound', 'Not Found')];
    const r = await read(user(), { calendarIds: [DANA, AVI] });
    assertSame(statusOf(r), { ...OK, goneIds: [AVI] }, 'status');
    assertSame(r.read.status === 'ok' ? r.read.calendars : null, [LEGEND[0], { ...LEGEND[1], unavailable: true }], 'legend');
    assertSame(ids(r), ['school-run', 'dentist', 'untitled', 'gym_20261014T220000Z'], 'items');
  });

  await check('every chosen calendar gone: error calendars_gone', async () => {
    for (const id of [DANA, AVI, KIDS]) google.pages[id] = [apiError(id, 404, 'notFound', 'Not Found')];
    const r = await read();
    assertSame(statusOf(r), { status: 'error', reason: 'calendars_gone' }, 'status');
    assert(r.items.length === 0, 'items');
  });

  await check('gone calendars: one Sentry warning per user per day (gcalGoneWarned, NX, EX 86400)', async () => {
    google.pages[AVI] = [apiError(AVI, 404, 'notFound', 'Not Found')];
    await read();
    await until(() => warnings.length === 1);
    assert(count(warnings) === 1 && warnings[0].context === 'calendar-read-google' && warnings[0].extra?.user_id === 7, `warnings ${canon(warnings)}`);
    await read();
    await sleep(30);
    assert(count(warnings) === 1, `${warnings.length} warnings after the second read`);
    assert(redisSets.some(s => s.key === 'gcal:gone_warned:7' && s.opts?.nx === true && s.opts.ex === 86400), `sets ${canon(redisSets)}`);
    clock += 86_400_000 + 1000;
    await read();
    await until(() => warnings.length === 2);
    assert(count(warnings) === 2, `${warnings.length} warnings a day later`);
    assert(!captures.some(c => c.severity !== 'warning'), 'a gone calendar was reported as an error');
  });

  await check('missing scopes on one calendar: reconnect scopes, also over another calendar\'s 401', async () => {
    google.pages[AVI] = [apiError(AVI, 403, 'insufficientPermissions', 'Insufficient Permission')];
    google.pages[KIDS] = [apiError(KIDS, 401, 'authError', 'Invalid Credentials')];
    const r = await read();
    assertSame(statusOf(r), { status: 'reconnect', reason: 'scopes' }, 'status');
    assert(r.items.length === 0, 'items on reconnect');
  });

  await check('a 401 on one calendar after the token step: reconnect token', async () => {
    google.pages[KIDS] = [apiError(KIDS, 401, 'authError', 'Invalid Credentials')];
    const r = await read();
    assertSame(statusOf(r), { status: 'reconnect', reason: 'token' }, 'status');
  });

  await check('invalid_grant on the token step: reconnect token, no calendar listed', async () => {
    google.token = () => Promise.reject(tokenError(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }));
    const r = await read();
    assertSame(statusOf(r), { status: 'reconnect', reason: 'token' }, 'status');
    assert(google.calls.length === 0, `${google.calls.length} lists`);
  });

  await check('invalid_client (HTTP 401) on the token step: error config, an error capture, one admin notice per hour', async () => {
    google.token = () => Promise.reject(tokenError(401, { error: 'invalid_client', error_description: 'The OAuth client was not found.' }));
    const r = await read();
    assertSame(statusOf(r), { status: 'error', reason: 'config' }, 'status');
    assert(google.calls.length === 0, `${google.calls.length} lists`);
    assert(captures.some(c => c.context === 'calendar-read-google' && c.severity === 'error'), `captures ${canon(captures.map(c => c.severity))}`);
    await until(() => adminAlerts.length === 1);
    assert(count(adminAlerts) === 1, 'no admin notice');
    await read();
    await sleep(30);
    assert(count(adminAlerts) === 1, `${adminAlerts.length} admin notices within the hour`);
    assert(redisSets.some(s => s.key === 'gcal:config_alert' && s.opts?.nx === true && s.opts.ex === 3600), `sets ${canon(redisSets)}`);
    clock += 3_600_000 + 1000;
    await read();
    await until(() => adminAlerts.length === 2);
    assert(count(adminAlerts) === 2, `${adminAlerts.length} admin notices an hour later`);
  });

  await check('a 404 on the token step: error unknown, not calendars_gone', async () => {
    google.token = () => Promise.reject(tokenError(404, 'Not Found'));
    const r = await read();
    assertSame(statusOf(r), { status: 'error', reason: 'unknown' }, 'status');
    assert(google.calls.length === 0, `${google.calls.length} lists`);
  });

  await check('a network failure on the token URL: error transient, not "token expired"', async () => {
    const socketError = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    google.token = () =>
      Promise.reject(new GaxiosError(`request to ${TOKEN_URL} failed, reason: socket hang up`, { url: TOKEN_URL, method: 'POST' }, undefined, socketError));
    const r = await read();
    assertSame(statusOf(r), { status: 'error', reason: 'transient' }, 'status');
  });

  await check('500 on every calendar: error transient, with the first calendar\'s error as the cause', async () => {
    const errors = [DANA, AVI, KIDS].map(id => apiError(id, 500, 'backendError', 'Backend Error'));
    [DANA, AVI, KIDS].forEach((id, i) => { google.pages[id] = [errors[i]]; });
    const r = await read();
    assertSame(statusOf(r), { status: 'error', reason: 'transient' }, 'status');
    assert(r.read.status === 'error' && r.read.cause === errors[0], 'cause');
  });

  await check('a 403 rate limit on every calendar: error transient, not reconnect', async () => {
    for (const id of [DANA, AVI, KIDS]) google.pages[id] = [apiError(id, 403, 'rateLimitExceeded', 'Rate Limit Exceeded')];
    const r = await read();
    assertSame(statusOf(r), { status: 'error', reason: 'transient' }, 'status');
  });

  await check('500 on one calendar: ok with partial.failed 1, and a warning capture with the user id', async () => {
    google.pages[KIDS] = [apiError(KIDS, 500, 'backendError', 'Backend Error')];
    const r = await read();
    assertSame(statusOf(r), { ...OK, partial: { failed: 1, truncated: 0 } }, 'status');
    assert(!ids(r).includes('pickup') && r.items.length === 7, 'items');
    const capture = captures.find(c => c.context === 'calendar-read-google');
    assert(capture?.severity === 'warning' && capture.extra?.user_id === 7, `captures ${canon(captures.map(c => [c.context, c.severity, c.extra]))}`);
  });

  await check('an empty token: reconnect token with no Google call', async () => {
    const r = await read(user({ googleRefreshToken: '' }));
    assertSame(statusOf(r), { status: 'reconnect', reason: 'token' }, 'status');
    assert(google.clients === 0 && google.log.length === 0, 'Google was called');
  });

  await check('no chosen calendars: ok and empty, with no Google call', async () => {
    const r = await read(user({ calendarAssignments: undefined }));
    assertSame(statusOf(r), OK, 'status');
    assertSame(r.read.status === 'ok' ? r.read.calendars : null, [], 'legend');
    assert(r.items.length === 0 && google.clients === 0 && google.log.length === 0, 'Google was called');
  });

  await check('an unexpected throw inside the client: error unknown, an error capture, never a rejection', async () => {
    google.token = () => {
      throw new TypeError('client bug');
    };
    const r = await read();
    assertSame(statusOf(r), { status: 'error', reason: 'unknown' }, 'status');
    assert(captures.some(c => c.context === 'calendar-read-google' && c.severity === 'error'), 'not captured');
  });

  // ---- Deadline ----

  await check('deadline: a token server that never answers gives error timeout within the deadline', async () => {
    google.token = () => new Promise(() => {});
    const start = performance.now();
    const r = await read(user(), { deadlineMs: 600 });
    const took = performance.now() - start;
    assertSame(statusOf(r), { status: 'error', reason: 'timeout' }, 'status');
    assert(took >= 550 && took < 800, `took ${Math.round(took)} ms`);
    assert(google.calls.length === 0, 'listed after the token step timed out');
  });

  await check('deadline: one calendar stalls while another answers: ok with partial.failed 1', async () => {
    google.pages[DANA] = ['hang'];
    const start = performance.now();
    const r = await read(user(), { calendarIds: [DANA, AVI], deadlineMs: 600 });
    assert(performance.now() - start < 800, 'waited past the deadline');
    assertSame(statusOf(r), { ...OK, partial: { failed: 1, truncated: 0 } }, 'status');
    assertSame(ids(r), ['mom-birthday', 'standup', 'flight'], 'items');
    assert(captures.some(c => c.context === 'calendar-read-google' && c.severity === 'warning'), 'the stalled calendar was not reported');
  });

  await check('deadline: the only calendar mid-paging is truncated (ok, not timeout); a late page changes nothing', async () => {
    const at = (h: string) => `2026-10-14T${h}:00-04:00`;
    google.pages[DANA] = [
      { summary: TITLES[DANA], items: [timed('a', 'A', at('08:00'), at('09:00')), timed('b', 'B', at('10:00'), at('11:00'))], nextPageToken: 'p2' },
      new Later(900, { summary: TITLES[DANA], items: [timed('c', 'C', at('12:00'), at('13:00'))] }),
    ];
    const r = await read(user(), { calendarIds: [DANA], deadlineMs: 600 });
    assertSame(statusOf(r), { ...OK, partial: { failed: 0, truncated: 1 } }, 'status');
    assertSame(ids(r), ['a', 'b'], 'items');
    await sleep(450);
    assertSame(ids(r), ['a', 'b'], 'items after the late page');
  });

  await check('deadline: several calendars, none with a page: error timeout', async () => {
    for (const id of [DANA, AVI, KIDS]) google.pages[id] = ['hang'];
    const start = performance.now();
    const r = await read(user(), { deadlineMs: 600 });
    assert(performance.now() - start < 800, 'waited past the deadline');
    assertSame(statusOf(r), { status: 'error', reason: 'timeout' }, 'status');
  });

  // ---- Redis ----

  await check('Redis down: the read is unchanged; the gone warning still goes out, the admin notice does not', async () => {
    redisDown = true;
    google.pages[AVI] = [apiError(AVI, 404, 'notFound', 'Not Found')];
    const r = await read();
    assertSame(statusOf(r), { ...OK, goneIds: [AVI] }, 'status');
    await until(() => warnings.length === 1);
    assert(warnings.length === 1, 'the gone warning was lost');
    google.token = () => Promise.reject(tokenError(401, { error: 'invalid_client', error_description: 'The OAuth client was not found.' }));
    const config = await read();
    assertSame(statusOf(config), { status: 'error', reason: 'config' }, 'config status');
    await sleep(50);
    assert(adminAlerts.length === 0, 'paged the admin with no once-an-hour gate');
  });

  await check('no unhandled rejection anywhere above', async () => {
    assert(unhandled.length === 0, `unhandled: ${unhandled.map(String).join('; ')}`);
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n     ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed (TZ=${process.env.TZ ?? 'unset'})`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Run it and watch it fail**

From the repo root:

```bash
for z in UTC; do
  TZ=$z DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' \
  TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake \
  GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake \
  ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development \
  GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake \
  npx tsx scripts/smoke-calendar-read-google.ts; echo "exit $? (TZ=$z)"
done
```

Expected: no PASS lines. The error is `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/src/services/calendar-read/google' imported from …/scripts/smoke-calendar-read-google.ts`, followed by `exit 1 (TZ=UTC)`.

- [ ] **Step 3: Export `getGoogleAuth` from `src/services/calendar.ts` (lines 14-28)**

Before:

```ts
/**
 * Create a Google Calendar API client with OAuth credentials
 */
export function getCalendarClient(refreshToken: string): calendar_v3.Calendar {
  const oauth2Client = new auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );

  oauth2Client.setCredentials({
    refresh_token: refreshToken,
  });

  return googleCalendar({ version: 'v3', auth: oauth2Client });
}
```

After:

```ts
/**
 * The OAuth2 client for a user's refresh token, as getCalendarClient has always built it.
 * A fresh client holds no access token, so its first request refreshes one. The calendar
 * home's reader (calendar-read/google.ts) runs that refresh itself first, inside its
 * deadline, so a dead token or a stuck token server is one outcome for the whole read.
 */
export function getGoogleAuth(refreshToken: string): InstanceType<typeof auth.OAuth2> {
  const oauth2Client = new auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );

  oauth2Client.setCredentials({
    refresh_token: refreshToken,
  });

  return oauth2Client;
}

/**
 * Create a Google Calendar API client with OAuth credentials
 */
export function getCalendarClient(refreshToken: string): calendar_v3.Calendar {
  return googleCalendar({ version: 'v3', auth: getGoogleAuth(refreshToken) });
}
```

Nothing else in `calendar.ts` changes.

- [ ] **Step 4: Add the gcal keys to `src/config/redis-keys.ts`**

Before (`:81-82` on main@858886c):

```ts
  // Holiday cache (CalBrew API responses, 24h TTL)
  holidays: (date: string, lang: string) => `holidays:${date}:${lang}`,
```

After:

```ts
  // Holiday cache (CalBrew API responses, 24h TTL)
  holidays: (date: string, lang: string) => `holidays:${date}:${lang}`,

  // Calendar home, Google reader (src/services/calendar-read/google.ts): the route's range
  // cache, the per-user stamp that invalidates it after a write, the once-a-day "chosen
  // calendars are gone" warning, the per-window fresh=1 limit, and the once-an-hour admin
  // alert for an OAuth client Google rejects. from and to are the window's bounds as the
  // cache keys them.
  gcalRange: (userId: number, setHash: string, tz: string, from: string, to: string) =>
    `gcal:range:v1:${userId}:${setHash}:${tz}:${from}:${to}`,
  gcalStamp: (userId: number) => `gcal:stamp:${userId}`,
  gcalGoneWarned: (userId: number) => `gcal:gone_warned:${userId}`,
  gcalFresh: (userId: number, from: string, to: string) => `gcal:fresh:${userId}:${from}:${to}`,
  gcalConfigAlert: () => 'gcal:config_alert',
```

- [ ] **Step 5: Create `src/services/calendar-read/google.ts`**

```ts
/**
 * The calendar home's Google half (spec §2.5): one live read of the user's chosen Google
 * calendars over a window.
 *
 * - The token step runs first, inside the deadline. A dead token, missing scopes, a
 *   rejected OAuth client or a stuck token server is then one outcome for the whole half,
 *   and no calendar is listed.
 * - Each chosen calendar gets its own events.list, in parallel, with a trimmed field mask,
 *   the user's timezone, a request timeout and one retry. The response's top-level
 *   `summary` is the calendar's title, so there is no calendars.get.
 * - Pages are followed until done or 5,000 items per calendar.
 * - Items go through keepGoogleEvent and mapGoogleEvent (google-map.ts). The legend
 *   (CalendarRef) is joined from the user's choices at read time and is never cached.
 * - One deadline covers all of it. What settled keeps its outcome; a calendar that got a
 *   page by then is truncated, one that got none failed.
 *
 * readGoogleUncached is the live read. readGoogle is what readRange calls: the live read
 * here, with Task B7's route cache put in front of it later. Nothing here stamps the
 * cache; B7's wrapper does that for reads that end in reconnect or calendars_gone.
 */

import { calendar as googleCalendar } from '@googleapis/calendar';
import type { calendar_v3 } from '@googleapis/calendar';
import { getGoogleAuth } from '../calendar';
import { classifyGoogleError, keepGoogleEvent, mapGoogleEvent } from './google-map';
import { captureError, captureWarning } from '../../lib/error-capture';
import { redis } from '../../utils/redis';
import { REDIS_KEYS } from '../../config/redis-keys';
import type { CalendarAssignment, UserConfig } from '../../types';
import type { CalendarRef, GoogleRead, ReadItem } from './types';

/** A Google item before its calendar is joined. This is what B7's cache stores. */
export type GoogleItem = Omit<ReadItem, 'calendar'>;

export interface GoogleReadOptions {
  tz: string;                          // the user's resolveUserTimezone; Google writes times in it
  calendarIds?: readonly string[];     // summary callers: the ids they resolved, narrowed to the choices
  deadlineMs: number;                  // covers the token step, the lists and the paging (spec §2.2)
}

export interface GoogleReadResult {
  read: GoogleRead;
  items: ReadItem[];                   // empty unless read.status is 'ok'
}

type ErrorClass = ReturnType<typeof classifyGoogleError>;

const LOG_CONTEXT = 'calendar-read-google';
const FIELDS =
  'summary,nextPageToken,items(id,status,summary,description,location,start,end,recurringEventId,originalStartTime,eventType,attendees(self,responseStatus),htmlLink)';
const PAGE_SIZE = 2500;
const MAX_ITEMS_PER_CALENDAR = 5000;
const MAX_REQUEST_TIMEOUT_MS = 10_000;
const DEADLINE_MARGIN_MS = 500;
const GONE_WARNING_TTL_S = 86_400;
const CONFIG_ALERT_TTL_S = 3_600;

/**
 * The calendars a read covers: the user's choices (calendarAssignments, A-3) in their own
 * order, narrowed to calendarIds when given. Ids never come from the client. A repeated id
 * is read once.
 */
export function googleCalendarSet(
  user: Pick<UserConfig, 'calendarAssignments'>,
  calendarIds?: readonly string[],
): CalendarAssignment[] {
  const wanted = calendarIds ? new Set(calendarIds) : null;
  const seen = new Set<string>();
  return (user.calendarAssignments ?? []).filter(a => {
    if (!a?.calendarId || seen.has(a.calendarId) || (wanted && !wanted.has(a.calendarId))) return false;
    seen.add(a.calendarId);
    return true;
  });
}

/**
 * What the UI may show about a chosen calendar: its saved name and colour, whether it is
 * the user's own (not labelled spouse), the spouse's name, and whether it is gone. Per-event
 * colorId is ignored in step 1.
 */
export function googleCalendarRef(a: CalendarAssignment, goneIds: readonly string[]): CalendarRef {
  const spouse = (a.labels ?? []).includes('spouse');
  const ref: CalendarRef = {
    id: a.calendarId,
    source: 'google',
    name: a.name || a.calendarId,
    color: a.color || null,
    mine: !spouse,
    inLegend: true,
  };
  if (spouse && a.personName) ref.ownerName = a.personName;
  if (goneIds.includes(a.calendarId)) ref.unavailable = true;
  return ref;
}

/** Joins each item's CalendarRef from the set. An item whose calendar is not in the set is dropped. */
export function attachGoogleCalendars(
  items: readonly GoogleItem[],
  set: readonly CalendarAssignment[],
  goneIds: readonly string[],
): ReadItem[] {
  const refs = new Map(set.map(a => [a.calendarId, googleCalendarRef(a, goneIds)]));
  return items.flatMap(item => {
    const calendar = refs.get(item.event.calendarId);
    return calendar ? [{ ...item, calendar }] : [];
  });
}

interface Deadline {
  readonly reached: Promise<void>;
  expired(): boolean;
  clear(): void;
}

function startDeadline(ms: number): Deadline {
  let expired = false;
  let handle: ReturnType<typeof setTimeout> | undefined;
  const reached = new Promise<void>(resolve => {
    handle = setTimeout(() => {
      expired = true;
      resolve();
    }, ms);
  });
  return { reached, expired: () => expired, clear: () => clearTimeout(handle) };
}

/** One calendar's list, as far as it got. */
interface CalendarProgress {
  calendarId: string;
  pages: number;                       // pages received
  received: number;                    // raw items received, counted against the cap
  items: GoogleItem[];                 // kept and mapped
  truncated: boolean;                  // stopped at the cap with more to read
  failure: { cls: ErrorClass; error: unknown } | null;
  settled: boolean;
}

type Outcome =
  | { calendarId: string; kind: 'ok'; items: GoogleItem[]; truncated: boolean }
  | { calendarId: string; kind: 'failed'; cls: ErrorClass; error: unknown };
type Failure = Extract<Outcome, { kind: 'failed' }>;

/** Lists one calendar page by page. Never rejects; after the deadline it changes nothing. */
async function listCalendar(
  cal: calendar_v3.Calendar,
  p: CalendarProgress,
  window: { from: Date; to: Date },
  tz: string,
  timeoutMs: number,
  deadline: Deadline,
): Promise<void> {
  let pageToken: string | undefined;
  let calendarName: string | undefined;
  try {
    do {
      const res = await cal.events.list(
        {
          calendarId: p.calendarId,
          timeMin: window.from.toISOString(),
          timeMax: window.to.toISOString(),
          singleEvents: true,
          orderBy: 'startTime',
          timeZone: tz,
          maxResults: PAGE_SIZE,
          maxAttendees: 1,
          pageToken,
          fields: FIELDS,
        },
        { timeout: timeoutMs, retryConfig: { retry: 1, noResponseRetries: 0 } },
      );
      if (deadline.expired()) return;
      p.pages++;
      // The calendar's title in Google, as calendar.ts:113 takes it from calendars.get.
      calendarName ??= res.data.summary || p.calendarId;
      for (const raw of res.data.items ?? []) {
        if (p.received === MAX_ITEMS_PER_CALENDAR) {
          p.truncated = true;
          break;
        }
        p.received++;
        if (keepGoogleEvent(raw)) p.items.push(mapGoogleEvent(raw, p.calendarId, calendarName));
      }
      pageToken = res.data.nextPageToken || undefined;
      if (pageToken && p.received === MAX_ITEMS_PER_CALENDAR) p.truncated = true;
    } while (pageToken && !p.truncated);
    p.settled = true;
  } catch (error) {
    if (deadline.expired()) return;
    p.failure = { cls: classifyGoogleError(error), error };
    p.settled = true;
  }
}

/** A calendar's outcome when the lists end or the deadline fires. */
function outcomeOf(p: CalendarProgress, deadlineMs: number): Outcome {
  if (p.failure) return { calendarId: p.calendarId, kind: 'failed', ...p.failure };
  if (p.settled || p.pages > 0) {
    return { calendarId: p.calendarId, kind: 'ok', items: [...p.items], truncated: p.truncated || !p.settled };
  }
  return {
    calendarId: p.calendarId,
    kind: 'failed',
    cls: 'transient',
    error: new Error(`Google sent no page of this calendar within the ${deadlineMs} ms deadline`),
  };
}

function errorReason(cls: ErrorClass): 'transient' | 'config' | 'unknown' {
  return cls === 'transient' || cls === 'config' ? cls : 'unknown';
}

/** The token step's failure decides the whole half; a token-step 404 is not a gone calendar. */
function tokenStepRead(error: unknown): GoogleRead {
  const cls = classifyGoogleError(error);
  if (cls === 'scopes') return { status: 'reconnect', reason: 'scopes' };
  if (cls === 'token') return { status: 'reconnect', reason: 'token' };
  return { status: 'error', reason: errorReason(cls), cause: error };
}

/** Spec §2.5 "Source status", steps 2-5. `set` is in the same order as `outcomes`. */
function readOf(outcomes: Outcome[], set: readonly CalendarAssignment[]): GoogleRead {
  const failures = outcomes.filter((o): o is Failure => o.kind === 'failed');
  if (failures.some(f => f.cls === 'scopes')) return { status: 'reconnect', reason: 'scopes' };
  if (failures.some(f => f.cls === 'token')) return { status: 'reconnect', reason: 'token' };
  const goneIds = failures.filter(f => f.cls === 'gone').map(f => f.calendarId);
  if (goneIds.length === outcomes.length) return { status: 'error', reason: 'calendars_gone' };
  const failed = failures.filter(f => f.cls !== 'gone');
  if (failed.length === outcomes.length - goneIds.length) {
    return { status: 'error', reason: errorReason(failed[0].cls), cause: failed[0].error };
  }
  const truncated = outcomes.filter(o => o.kind === 'ok' && o.truncated).length;
  return {
    status: 'ok',
    calendars: set.map(a => googleCalendarRef(a, goneIds)),
    goneIds,
    partial: failed.length || truncated ? { failed: failed.length, truncated } : null,
    stale: false,
  };
}

/** Runs reporting off the read's path: it never delays, changes or fails a read. */
function inBackground(what: string, task: () => Promise<void>): void {
  task().catch(err => console.warn(`[${LOG_CONTEXT}] ${what} failed:`, err));
}

/**
 * A Sentry warning when chosen calendars are gone, at most once per user per day. Without
 * Redis it warns anyway: a lost warning hides a broken setup, an extra one costs nothing.
 */
function warnGoneOnce(userId: number, gone: number, chosen: number): void {
  inBackground('gone warning', async () => {
    let first = true;
    try {
      first = (await redis.set(REDIS_KEYS.gcalGoneWarned(userId), '1', { nx: true, ex: GONE_WARNING_TTL_S })) === 'OK';
    } catch (err) {
      console.warn(`[${LOG_CONTEXT}] gone-warning gate unavailable:`, err);
    }
    if (first) {
      captureWarning(
        `${gone} of ${chosen} chosen Google calendars are gone (deleted, unshared or on another account)`,
        LOG_CONTEXT,
        { user_id: userId, gone, chosen },
      );
    }
  });
}

/**
 * One admin notice an hour for an OAuth client Google rejects: a wrong server secret
 * breaks every Google user at once. Without Redis there is no notice (the error capture
 * still goes out), so an outage of both never pages the admin once per read.
 */
function alertConfigOnce(error: unknown): void {
  inBackground('config alert', async () => {
    const first = (await redis.set(REDIS_KEYS.gcalConfigAlert(), '1', { nx: true, ex: CONFIG_ALERT_TTL_S })) === 'OK';
    if (!first) return;
    const { notifyAdminError } = await import('../../utils/error-notifier');
    await notifyAdminError(
      'Google Calendar read',
      error,
      'Google rejected the OAuth client (invalid_client or unauthorized_client), so every Google user is affected. Check GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.',
    );
  });
}

/** Spec §2.5 "Logging": failures as warnings, config as an error plus the hourly notice, gone once a day. */
function report(userId: number, failures: readonly { cls: ErrorClass; error: unknown }[], chosen: number): void {
  let alerted = false;
  for (const f of failures) {
    if (f.cls === 'gone') continue;
    if (f.cls === 'config') {
      captureError(f.error, LOG_CONTEXT, { user_id: userId }, 'error');
      if (!alerted) alertConfigOnce(f.error);
      alerted = true;
    } else {
      captureError(f.error, LOG_CONTEXT, { user_id: userId }, 'warning');
    }
  }
  const gone = failures.filter(f => f.cls === 'gone').length;
  if (gone > 0) warnGoneOnce(userId, gone, chosen);
}

function timedOut(userId: number, deadlineMs: number, stage: 'token' | 'lists'): GoogleReadResult {
  captureError(
    new Error(`Google read passed its ${deadlineMs} ms deadline in the ${stage} step`),
    LOG_CONTEXT,
    { user_id: userId, stage },
    'warning',
  );
  return { read: { status: 'error', reason: 'timeout' }, items: [] };
}

/**
 * One live read of the user's chosen Google calendars over [window.from, window.to), with
 * no cache (spec §2.5). It never rejects: every outcome is a GoogleRead, and an unexpected
 * throw is error('unknown'). The caller decides whether Google applies (sourcesFor); this
 * only looks at the token and the choices.
 */
export async function readGoogleUncached(
  user: UserConfig,
  window: { from: Date; to: Date },
  opts: GoogleReadOptions,
): Promise<GoogleReadResult> {
  const token = user.googleRefreshToken;
  if (!token) return { read: { status: 'reconnect', reason: 'token' }, items: [] };
  const set = googleCalendarSet(user, opts.calendarIds);
  if (set.length === 0) {
    return { read: { status: 'ok', calendars: [], goneIds: [], partial: null, stale: false }, items: [] };
  }

  const deadline = startDeadline(opts.deadlineMs);
  try {
    const auth = getGoogleAuth(token);
    type Step = { kind: 'ok' } | { kind: 'failed'; error: unknown } | { kind: 'deadline' };
    const step: Step = await Promise.race([
      auth.getAccessToken().then(
        (): Step => ({ kind: 'ok' }),
        (error: unknown): Step => ({ kind: 'failed', error }),
      ),
      deadline.reached.then((): Step => ({ kind: 'deadline' })),
    ]);
    if (step.kind === 'deadline') return timedOut(user.id, opts.deadlineMs, 'token');
    if (step.kind === 'failed') {
      const cls = classifyGoogleError(step.error);
      // A 404 from the token endpoint is not a gone calendar: it is reported as any failure.
      report(user.id, [{ cls: cls === 'gone' ? 'unknown' : cls, error: step.error }], set.length);
      return { read: tokenStepRead(step.error), items: [] };
    }

    const cal = googleCalendar({ version: 'v3', auth });
    const timeoutMs = Math.min(MAX_REQUEST_TIMEOUT_MS, opts.deadlineMs - DEADLINE_MARGIN_MS);
    const progress: CalendarProgress[] = set.map(a => ({
      calendarId: a.calendarId,
      pages: 0,
      received: 0,
      items: [],
      truncated: false,
      failure: null,
      settled: false,
    }));
    await Promise.race([
      Promise.all(progress.map(p => listCalendar(cal, p, window, opts.tz, timeoutMs, deadline))),
      deadline.reached,
    ]);
    if (deadline.expired() && !progress.some(p => p.settled || p.pages > 0)) {
      return timedOut(user.id, opts.deadlineMs, 'lists');
    }

    const outcomes = progress.map(p => outcomeOf(p, opts.deadlineMs));
    report(user.id, outcomes.filter((o): o is Failure => o.kind === 'failed'), set.length);
    const read = readOf(outcomes, set);
    if (read.status !== 'ok') return { read, items: [] };

    // Calendars in the order of the choices, then a stable sort by start, as calendar.ts:159.
    const items = outcomes.flatMap(o => (o.kind === 'ok' ? o.items : []));
    items.sort((a, b) => new Date(a.event.start).getTime() - new Date(b.event.start).getTime());
    return { read, items: attachGoogleCalendars(items, set, read.goneIds) };
  } catch (error) {
    // Nothing above should throw; if something does, the half reports it and still answers.
    captureError(error, LOG_CONTEXT, { user_id: user.id }, 'error');
    return { read: { status: 'error', reason: 'unknown', cause: error }, items: [] };
  } finally {
    deadline.clear();
  }
}

/**
 * The Google half for readRange (spec §2.5). In this task it is the live read; Task B7 puts
 * the route's cache in front of it and adds opts.googleCache and opts.defer.
 */
export function readGoogle(
  user: UserConfig,
  window: { from: Date; to: Date },
  opts: GoogleReadOptions,
): Promise<GoogleReadResult> {
  return readGoogleUncached(user, window, opts);
}
```

- [ ] **Step 6: Run the smoke under the three clocks**

```bash
for z in UTC Asia/Jerusalem Pacific/Kiritimati; do
  TZ=$z DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' \
  TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake \
  GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake \
  ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development \
  GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake \
  npx tsx scripts/smoke-calendar-read-google.ts; echo "exit $? (TZ=$z)"
done
```

Expected, for each zone: 34 `PASS` lines, then `34/34 passed (TZ=<zone>)` and `exit 0 (TZ=<zone>)`. The whole run takes about 5 s per zone. The Redis-down check (#33) prints two expected console warnings with stacks:
- `[calendar-read-google] gone-warning gate unavailable: Error: Upstash unreachable`;
- `[calendar-read-google] config alert failed: Error: Upstash unreachable`.

tsx prints a `DEP0205` deprecation notice. Nothing else.

- [ ] **Step 7: Run the smokes that load `calendar.ts` or a fake `@googleapis/calendar`; they must pass unchanged**

```bash
for s in smoke-reminders smoke-week-lookahead smoke-google-connect smoke-oauth-weather smoke-voice-dates smoke-native-reminder-create-flow; do
  for z in UTC Asia/Jerusalem; do
    TZ=$z DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' \
  TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake \
  GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake \
  ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development \
  GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake \
    npx tsx scripts/$s.ts; echo "exit $? (TZ=$z)"
  done
done
```

Expected: every run ends in `N/N passed` and `exit 0`, with the same N it had before this task. On main@858886c the counts are: smoke-reminders 23, smoke-week-lookahead 22 (Plan A Task 3 adds checks), smoke-google-connect 30, smoke-oauth-weather 14, smoke-voice-dates 77, smoke-native-reminder-create-flow 56. On top of Plan A and B1-B5 they are the same except smoke-week-lookahead, which is 29 (checked in both zones, before and after this task).

- [ ] **Step 8: Type-check and lint**

```bash
npx tsc --noEmit -p .; echo "tsc exit $?"
npm run -s lint; echo "lint exit $?"
```

Expected: no output, then `tsc exit 0` and `lint exit 0`. `next build` type-checks `scripts/**` the same way.

- [ ] **Step 9: Commit**

```bash
git add src/services/calendar.ts src/config/redis-keys.ts src/services/calendar-read/google.ts scripts/smoke-calendar-read-google.ts
git commit -F - <<'EOF'
feat(calendar-read): the Google half of the reader, without its cache

One live read of a user's chosen Google calendars over a window: the
token step first inside one deadline; one events.list per calendar in
parallel, with a trimmed field mask, the user's timezone, a timeout and
one retry; paging to 5,000 items; the reader's filter and mapper; the
legend joined from the user's choices; and one status for the half.
Failures go to Sentry as warnings, gone calendars once a day, and a
rejected OAuth client pages the admin once an hour.

calendar.ts exports getGoogleAuth, which getCalendarClient now builds
on, with no change in behaviour. Nothing calls the reader yet; the
route's cache comes next.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
EOF
git show --stat HEAD | head -12
```

Expected: one commit with exactly the four files.

---

### Task 7 (B7): The Google cache and its stamp (spec §2.6)

**What and why.** The range route (B8) asks Google on every Mini App open, and an open often makes two requests. This task puts a short cache in front of B6's live read, for the route only:
- One entry per user, calendar set, timezone and window. It is served as it is for 3 minutes, then served stale with one background refresh (through `opts.defer`, which will be the route's `after()`) until 30 minutes.
- An entry counts only while its `startedAt` is later than the user's stamp. Every bot write to Google, every reconnect, and every cached read that ends in `reconnect` or `calendars_gone` moves the stamp to now.
- Reads in flight are shared through `globalThis`, so two requests make one Google read, and only the newest read writes.

The summaries keep `'bypass'` (the default) and never touch the cache.

**Visible to users:** nothing. Nothing calls `readGoogle` until B8, and the route is behind the switch, which ships `OFF`. What runs live on deploy is the stamp after each Google write and each reconnect: one Redis `SET` on its own client, at most 750 ms, never changing the write's result (A-33).

**Say in the PR (switch `OFF`):** the stamp hook is the one live change, and it does more than one Redis write:
- every Google write by every Google user (`google-provider.ts` `writeThenStamp`, and `commitGoogleToken` after a reconnect) now awaits `stampGoogleCache`: one Upstash round trip normally, up to 750 ms when Upstash is slow, and during a Redis blip one Sentry warning (`calendar-read-google-stamp`) per write;
- the stamp also calls `clearRecurrenceCacheForUser`, an in-process change. For users the switch doesn't cover, the next `/week`, `/nextweek` or tomorrow week block after any bot write asks Google again for each recurring master. If that lookup hits a transient failure, Plan A's 10-minute failure entry hides the series where the 6 h success entry would have served it. The spec allows this (§2.6, A-33), but it is the one non-Redis effect on users the switch doesn't cover.

**Interface change** (read this first):
1. **`readGoogle`'s options type.** `opts` becomes `GoogleHalfOptions extends GoogleReadOptions { googleCache?: ReadRangeOptions['googleCache']; defer?: ReadRangeOptions['defer'] }`. That is the split's "gains opts.googleCache and opts.defer", in the shape B6's task gives under "How B7 wraps it". B8 passes `{ tz, calendarIds, deadlineMs, googleCache, defer }` straight from its `ReadRangeOptions`.
2. **Where `clearRecurrenceCacheForUser` comes from.** This task imports it from `src/services/recurrence-cache.ts`, as PLAN A FACTS say. Plan A's task-3 draft still defines it in `week-lookahead.ts` and says Plan B imports it from there. That import would close a load-time cycle: `google.ts → week-lookahead → calendar-provider/index → google-provider → google.ts`. Plan A must ship the leaf module, and as landed it does: `src/services/recurrence-cache.ts` imports nothing, and `week-lookahead.ts` re-exports `clearRecurrenceCacheForUser` from it.
3. **Key strings (B6 left them to B7).** `from` and `to` are `window.from.toISOString()` and `window.to.toISOString()`, in both `gcalRange` and `gcalFresh`. `setHash` is `sha256(sortedIds.join('\n'))`, first 16 hex digits.
4. **`'bypass'` never touches Redis.** That includes the stamp: only reads made through the cache (`'use'`, `'refresh'`, and the background refresh) stamp when they end in `reconnect` or `calendars_gone`. This follows "the summaries never read or write the cache" (§2.6, A-30). A dead token found by a summary therefore shows on the home after at most 3 minutes, when the next stale refresh stamps it.

**Findings (read before you start):**
- **This task edits B6's `google.ts` as B6's task writes it.** The quoted "find" blocks below are copied from `task-B6.md`'s `google.ts` (identical to B6's verified scratch copy). If B6 lands with different text in those three places, apply the same replacement to B6's header paragraph about B7, B6's import block, and B6's `readGoogle`.
- **`@upstash/redis` 1.35.8** (`node_modules/@upstash/redis/nodejs.js`):
  - `retry: false` still makes two attempts. It sets `attempts: 1` (`:136-138`), and the loop runs `i <= attempts` (`:180`). `retry: { retries: 0 }` makes one, so the stamp's client uses that.
  - A function `signal` is called for each request (`:153`, `:163`), and an aborted request throws (`:185-186`). So `signal: () => AbortSignal.timeout(750)` frees a stuck socket. The 750 ms race is what bounds the promise.
  - Auto-pipelining is on by default (`:3673`), so the stamp goes out as a one-command batch to `/pipeline`. The smoke's fake Upstash endpoint answers both shapes.
- **B6's `readGoogleUncached` never rejects**: its outer catch turns a throw into `error('unknown')`. The cache's `.catch` on the background refresh and its `finally` on each read in flight are a second line of defence.
- **Why the cache code lives in `google.ts`.** The stamp is in `google.ts`, as §2.1 says. `google-provider.ts` and `google-connect.ts` import it from there. That creates no cycle: `google.ts` imports `../calendar`, `./google-map`, `../recurrence-cache`, Redis and error capture, and nothing that leads back to `calendar-provider`.
- **A side effect in other smokes.** `google-provider.ts` now loads `src/utils/redis.ts` and the stamp. Smokes that run Google writes with no `UPSTASH_REDIS_REST_URL` now log one `[calendar-read-google-stamp]` warning per write: `smoke-voice-dates.ts` logs 17 under `TZ=UTC`. Their pass counts are unchanged.
- **Smoke mechanics:**
  - `check()` has a 5 s watchdog. Without it, a promise that never settles would end the process quietly with nothing printed.
  - List-call counts are read through `listed()`, because `assert(x.length === 2)` narrows `.length` and makes a later `=== 4` a TS2367 error.
  - The stamp's `'stuck'` mode ignores the abort signal, so it tests the 750 ms race on its own.
  - A calendar given as `pages` is paged by the fake `events.list` (`pageToken` `p<n>`). The truncated check makes nearly every item cancelled, so its entry would be far under 512 KB: only `partial.truncated` keeps it out, and the same calendar cut to its first 5,000 items is written.
- **Mutation-checked.** Each of these mutations makes at least one check fail:
  - `retry: false`;
  - no newer-read check before a write;
  - no last-write check;
  - an unconditional `finally` delete;
  - joining a read that started before the stamp;
  - a refresh that joins any read;
  - a fire-and-forget stamp in the provider;
  - no `startedAt > stamp` check;
  - no 512 KB cap;
  - no race;
  - no signal;
  - a refresh that is not single-flight;
  - no guard around `defer`;
  - a truncated read written (only `partial.failed` checked);
  - a timed-out read's flight left in place.

**Files:**
- Modify: `src/services/calendar-read/google.ts` (B6's file). Header paragraph lines 17-19, the import block at 22-30, and B6's `readGoogle` at 387-397, which the cache section, the new `readGoogle` and `stampGoogleCache` replace. The file goes from 397 to 670 lines.
- Modify: `src/services/calendar-provider/google-provider.ts`:
  - `:1-3`: the header comment;
  - `:25`: the import;
  - before `:38`: the new `writeThenStamp`;
  - `:85-126`: the three writes.
- Modify: `src/services/google-connect.ts`:
  - `:24`: the import;
  - after `:154`: the stamp, after the reminder-cache block and before the admin notice at `:156`.
- Create (test): `scripts/smoke-calendar-read-google-cache.ts` (1025 lines).
- Test: the new smoke under `TZ=UTC` and `TZ=Asia/Jerusalem`. Regression:
  - `scripts/smoke-calendar-read-google.ts` (B6, 34/34);
  - `smoke-google-connect.ts` (30/30);
  - `smoke-reminders.ts` (23/23) and `smoke-native-provider-reminders.ts` (11/11), both unchanged;
  - `smoke-voice-dates.ts` (77/77);
  - `smoke-week-lookahead.ts` (the count Plan A left it at).

**Interfaces:**
- Consumes:
  - B6, `src/services/calendar-read/google.ts`:
    - `GoogleItem`, `GoogleReadOptions { tz; calendarIds?; deadlineMs }` and `GoogleReadResult { read: GoogleRead; items: ReadItem[] }`;
    - `googleCalendarSet(user, calendarIds?)`, `googleCalendarRef(a, goneIds)` and `attachGoogleCalendars(items, set, goneIds)`;
    - `readGoogleUncached(user, window, opts: GoogleReadOptions): Promise<GoogleReadResult>`, which never rejects;
    - the module's `redis`, `REDIS_KEYS` and `captureError` imports.
  - B6, `src/config/redis-keys.ts`: `gcalRange(userId: number, setHash: string, tz: string, from: string, to: string)`, `gcalStamp(userId: number)` and `gcalFresh(userId: number, from: string, to: string)`.
  - B3, `src/services/calendar-read/types.ts`: `ReadItem`, `GoogleRead`, and `ReadRangeOptions['googleCache' | 'defer']`.
  - Plan A, `src/services/recurrence-cache.ts`: `clearRecurrenceCacheForUser(userId: number): void`.
  - `new Redis({ url, token, retry, signal })` from `@upstash/redis` 1.35.8, and the shared `redis.mget` / `redis.set(key, v, { nx?, ex })`.
  - `gcalCreate` / `gcalUpdate` / `gcalDelete` (`src/services/calendar.ts`), unchanged.
- Produces (`src/services/calendar-read/google.ts`):
  - `export interface GoogleHalfOptions extends GoogleReadOptions { googleCache?: ReadRangeOptions['googleCache']; defer?: ReadRangeOptions['defer'] }`;
  - `export async function readGoogle(user: UserConfig, window: { from: Date; to: Date }, opts: GoogleHalfOptions): Promise<GoogleReadResult>`:
    - `'bypass'` (the default), an empty token, or no chosen calendar → `readGoogleUncached`, with no Redis;
    - otherwise the cache, as described in the code comments;
    - a joiner gets the same result object as the read it joined.
  - `export async function stampGoogleCache(userId: number): Promise<void>`. It never rejects and is back within about 750 ms. It also calls `clearRecurrenceCacheForUser(userId)`.
  - Redis:
    - `gcal:range:v1:{userId}:{setHash}:{tz}:{fromISO}:{toISO}` → JSON `{ startedAt, items: GoogleItem[], goneIds }`, `EX 1800`, never over 512 KB;
    - `gcal:stamp:{userId}` → ms, `EX 3600`;
    - `gcal:fresh:{userId}:{fromISO}:{toISO}` → `1`, `NX EX 30`.
  - `globalThis.__gcalInflight: Map<string, { startedAt: number; promise: Promise<GoogleReadResult> }>` and `globalThis.__gcalWritten: Map<string, number>`.
  - Warning contexts: `calendar-read-google-cache` and `calendar-read-google-stamp`.
- Produces (`google-provider.ts`): the private `writeThenStamp<T>(userId: number, write: () => Promise<T>): Promise<T>`.

- [ ] **Step 1: Write the failing smoke `scripts/smoke-calendar-read-google-cache.ts`**

Create `scripts/smoke-calendar-read-google-cache.ts`:

```ts
// Smoke test for the calendar home's Google cache and its stamp (spec §2.6):
// readGoogle's googleCache 'use' and 'refresh' (src/services/calendar-read/google.ts),
// stampGoogleCache, and the stamp after every bot write to Google
// (calendar-provider/google-provider.ts) and after a reconnect (google-connect.ts).
//
// Only the range route reads through the cache; the summaries pass 'bypass' and never
// touch it. An entry is { startedAt, items, goneIds } under
// gcal:range:v1:{userId}:{setHash}:{tz}:{from}:{to}. It is served for 3 minutes, then
// served stale with one background refresh until 30 minutes, and only while its startedAt
// is later than the user's stamp. The stamp moves after each bot write to Google, a
// reconnect, and a cached read that finds a dead token or no chosen calendar left; it never holds
// up or changes the write. Reads in flight are shared through globalThis, so two requests
// make one Google read, and only the newest read writes.
//
// The real google.ts (with B6's live read underneath), google-provider.ts and
// google-connect.ts run. Faked: Google (@googleapis/calendar and getGoogleAuth), the
// shared Redis client (in memory, TTLs on the smoke's clock), the HTTP under the stamp's
// own Upstash client (fetch answers as Upstash's REST API, into the same memory), the
// clock, error capture, the weekly recurrence cache, and google-connect's database, user
// service, reminder cache, messaging and admin notifier. No network, no DB.
//
// Checks named [guard] already pass before the cache lands and must keep passing.
//
// Run under both clocks; the output must not depend on the server's timezone:
//   TZ=UTC npx tsx scripts/smoke-calendar-read-google-cache.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-calendar-read-google-cache.ts

import Module from 'node:module';
import path from 'node:path';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import type { CalendarAssignment, UserConfig } from '../src/types';

// The stamp's own Upstash client reads these when it is first used. The fake fetch below
// is the only thing that answers them.
process.env.UPSTASH_REDIS_REST_URL = 'https://stamp-redis.smoke.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN = 'smoke-token';

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

/**
 * Lets the previous check's background work finish, then runs this one. A check still
 * waiting after 5 s fails: otherwise a promise that never settles would end the process
 * quietly, with nothing printed.
 */
async function check(name: string, fn: () => Promise<void>) {
  await flush();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stuck = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('still waiting after 5 s')), 5000);
  });
  try {
    await Promise.race([fn(), stuck]);
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  } finally {
    clearTimeout(timer);
  }
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

const show = (v: unknown) => JSON.stringify(v);
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

const unhandled: unknown[] = [];
process.on('unhandledRejection', reason => {
  unhandled.push(reason);
});

// ---- Clock: every argument-less new Date() and Date.now() reads `clock` ----

const T0 = Date.UTC(2026, 9, 17, 6, 0, 0); // 09:00 in Israel, Saturday 17 October 2026
let clock = T0;
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

/** Everything that happened, in order: Google writes, stamps, Redis commands, DB steps. */
const events: string[] = [];

// ---- The shared Redis client (src/utils/redis.ts): values round-trip through JSON, as Upstash's do ----

type Stored = { value: string; expiresAt: number | null };
const store = new Map<string, Stored>();
/** Every command the shared client got, with its keys. */
const redisLog: { cmd: string; key: string }[] = [];
/** Commands that throw while listed, as an Upstash outage does. */
const redisFaults = new Set<string>();

function live(key: string): Stored | undefined {
  const s = store.get(key);
  if (s && s.expiresAt !== null && s.expiresAt <= clock) {
    store.delete(key);
    return undefined;
  }
  return s;
}
function decode(raw: string | undefined): unknown {
  if (raw === undefined) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
function put(key: string, value: unknown, ex?: number) {
  store.set(key, { value: typeof value === 'string' ? value : JSON.stringify(value), expiresAt: ex ? clock + ex * 1000 : null });
}
function command(cmd: string, key: string) {
  redisLog.push({ cmd, key });
  events.push(`redis.${cmd} ${key}`);
  if (redisFaults.has(cmd)) throw new Error(`redis ${cmd} failed (smoke)`);
}
const fakeRedis = {
  mget: async (...keys: (string | string[])[]) => {
    const flat = keys.flat();
    command('mget', flat.join(' '));
    return flat.map(k => decode(live(k)?.value));
  },
  get: async (key: string) => {
    command('get', key);
    return decode(live(key)?.value);
  },
  set: async (key: string, value: unknown, opts?: { nx?: boolean; ex?: number }) => {
    command('set', key);
    if (opts?.nx && live(key)) return null;
    put(key, value, opts?.ex);
    return 'OK';
  },
  del: async (...keys: string[]) => {
    command('del', keys.join(' '));
    return keys.filter(k => store.delete(k)).length;
  },
};

// ---- The stamp's own Upstash client: its HTTP, answered as Upstash's REST API ----

/** ok: the command lands; throw: the network refuses; stuck: no answer ever, abort signal or not. */
let stampMode: 'ok' | 'throw' | 'stuck' = 'ok';
/** Each request the stamp's client sent: its commands, and whether it could be aborted. */
const stampRequests: { commands: unknown[][]; abortable: boolean }[] = [];
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith(process.env.UPSTASH_REDIS_REST_URL!)) throw new Error(`network blocked in smoke: ${url}`);
  // One command, or a list of them on /pipeline (the client batches commands of one tick)
  const body = JSON.parse(String(init?.body)) as unknown[];
  const pipeline = Array.isArray(body[0]);
  const commands = (pipeline ? body : [body]) as unknown[][];
  stampRequests.push({ commands, abortable: init?.signal instanceof AbortSignal });
  for (const c of commands) events.push(`stamp ${String(c[1])}`);
  if (stampMode === 'throw') throw new TypeError('fetch failed (smoke)');
  if (stampMode === 'stuck') return new Promise<Response>(() => {});
  for (const [name, key, value, ...rest] of commands as [string, string, unknown, ...unknown[]][]) {
    if (name.toLowerCase() !== 'set') throw new Error(`the stamp's client sent ${name}`);
    const ex = rest.findIndex(x => String(x).toLowerCase() === 'ex');
    put(key, String(value), ex >= 0 ? Number(rest[ex + 1]) : undefined);
  }
  const answer = pipeline ? commands.map(() => ({ result: 'OK' })) : { result: 'OK' };
  return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

// ---- Google: getGoogleAuth's client and events.list ----

type RawEvent = Record<string, unknown>;
/**
 * Each Google calendar: its title and events, its title and pages (page n + 1 is asked for
 * with pageToken `p<n>`), or the error its list throws. A missing one is a 404.
 */
let google: Record<string, { summary: string; items: RawEvent[] } | { summary: string; pages: RawEvent[][] } | { error: unknown }> = {};
/** What the token step throws, when set. */
let tokenFailure: unknown = null;
/** While set, the token step never answers, as a stuck token server. */
let tokenHangs = false;
/** How many token steps the reads made. */
let tokenSteps = 0;
/** While set, getGoogleAuth throws, as a bug in the read would: the read then rejects. */
let authThrows = false;
/** Each events.list call: the calendar, and the request timeout the read gave it. */
const listCalls: { calendarId: string; timeout?: number }[] = [];
/** While set, each list call waits until the smoke releases it (`held`, in call order). */
let holdLists = false;
const held: (() => void)[] = [];

/** An HTTP error as gaxios 6 throws it after google-auth-library's processError. */
function httpError(status: number, message: string, reason: string): Error {
  return Object.assign(new Error(message), {
    code: status,
    status,
    errors: [{ domain: 'global', reason, message }],
    response: { status, data: { error: { code: status, message, errors: [{ domain: 'global', reason, message }] } } },
  });
}
/** The token endpoint's answer for a revoked refresh token. */
function invalidGrant(): Error {
  return Object.assign(new Error('invalid_grant'), {
    status: 400,
    response: { status: 400, data: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } },
  });
}

const fakeAuth = {
  getAccessToken: async () => {
    tokenSteps++;
    if (tokenHangs) return new Promise<never>(() => {});
    if (tokenFailure) throw tokenFailure;
    return { token: 'access-token' };
  },
};
const fakeCalendarApi = {
  events: {
    list: async (params: { calendarId: string; pageToken?: string }, options?: { timeout?: number }) => {
      listCalls.push({ calendarId: params.calendarId, timeout: options?.timeout });
      if (holdLists) await new Promise<void>(resolve => held.push(resolve));
      const cal = google[params.calendarId];
      if (!cal) throw httpError(404, 'Not Found', 'notFound');
      if ('error' in cal) throw cal.error;
      if ('pages' in cal) {
        const page = params.pageToken ? Number(params.pageToken.slice(1)) : 0;
        const nextPageToken = page + 1 < cal.pages.length ? `p${page + 1}` : undefined;
        return { data: { summary: cal.summary, items: cal.pages[page] ?? [], nextPageToken } };
      }
      return { data: { summary: cal.summary, items: cal.items } };
    },
  },
};

/** How many list calls Google got (a function, so an assert on one count doesn't narrow the next). */
const listed = () => listCalls.length;

/** Lets the first n held list calls answer (all by default). */
function release(n = held.length) {
  for (const answer of held.splice(0, n)) answer();
}

// ---- Google writes (calendar.ts under google-provider.ts) ----

let writeOutcome: { kind: 'result'; value: unknown } | { kind: 'throw'; error: unknown } = { kind: 'result', value: { success: true } };
const fakeWrite = (kind: string) => async () => {
  events.push(`write ${kind}`);
  if (writeOutcome.kind === 'throw') throw writeOutcome.error;
  return writeOutcome.value;
};
const notInThisSmoke = (name: string) => async () => {
  throw new Error(`${name} is not part of this smoke`);
};

// ---- Error capture, the recurrence cache, google-connect's boundaries ----

const captured: { context: string; severity: string; message: string }[] = [];
const clearedRecurrence: number[] = [];

/** The user google-connect commits a token for: NATIVE with event reminders on. */
const CONNECT_USER = {
  id: 7, telegramId: 1007, name: 'Noa', calendarSource: 'NATIVE', remindersEnabled: true, calendarAssignments: undefined,
  pairingId: null, defaultReminderMinutes: 15, language: 'he', pickupRemindersEnabled: true, location: 'Tel Aviv',
};

// ---- Stubs: static imports go through Module._load, import() through the ES module hooks ----

const SRC = path.resolve(__dirname, '../src');
const stubs: Record<string, object> = {
  '@googleapis/calendar': { calendar: () => fakeCalendarApi },
  [`${SRC}/services/calendar.ts`]: {
    getGoogleAuth: () => {
      if (authThrows) throw new Error('auth exploded (smoke)');
      return fakeAuth;
    },
    createEvent: fakeWrite('create'),
    updateEvent: fakeWrite('update'),
    deleteEvent: fakeWrite('delete'),
    fetchTodayEvents: notInThisSmoke('fetchTodayEvents'),
    fetchTomorrowEvents: notInThisSmoke('fetchTomorrowEvents'),
    fetchEventsInRange: notInThisSmoke('fetchEventsInRange'),
    listUserCalendars: notInThisSmoke('listUserCalendars'),
  },
  [`${SRC}/utils/redis.ts`]: { redis: fakeRedis },
  [`${SRC}/lib/error-capture.ts`]: {
    captureError: (error: unknown, context: string, _extra?: unknown, severity = 'error') => {
      captured.push({ context, severity, message: error instanceof Error ? error.message : String(error) });
    },
    captureWarning: (message: string, context: string) => {
      captured.push({ context, severity: 'warning', message });
    },
    captureInfo: () => {},
  },
  [`${SRC}/services/recurrence-cache.ts`]: {
    clearRecurrenceCacheForUser: (userId: number) => {
      clearedRecurrence.push(userId);
    },
    clearRecurrenceCache: () => {},
  },
  [`${SRC}/lib/timezone.ts`]: { resolveUserTimezone: async () => 'Asia/Jerusalem' },
  [`${SRC}/utils/prisma.ts`]: {
    prisma: {
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        events.push('db.$transaction');
        return fn({ user: { update: async () => ({}) }, nativeCalendar: { updateMany: async () => ({ count: 1 }) } });
      },
    },
    withRetry: (fn: () => unknown) => fn(),
  },
  [`${SRC}/services/user-service.ts`]: {
    getUserById: async () => ({ ...CONNECT_USER }),
    getUserByTelegramId: async () => null,
    updateUserById: async () => {
      events.push('db.updateUserById');
    },
  },
  [`${SRC}/services/reminder-cache.ts`]: {
    updateUserInCache: async () => {
      events.push('reminderCache.update');
    },
  },
  [`${SRC}/services/messaging/index.ts`]: { getWhatsAppService: () => ({}), MessageFormat: { TEXT: 'text', HTML: 'html' } },
  [`${SRC}/utils/error-notifier.ts`]: {
    notifyAdminWarning: async () => {
      events.push('admin.notify');
    },
    notifyAdminError: async () => {},
  },
};

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
(globalThis as { smokeStubs?: typeof stubs }).smokeStubs = stubs;
Module.registerHooks({
  load(url, context, nextLoad) {
    const file = url.startsWith('file:') ? fileURLToPath(url.split('?')[0]) : '';
    const stub = stubs[file];
    if (!stub) return nextLoad(url, context);
    const names = Object.keys(stub).map(name => `export const ${name} = fake.${name};`).join('\n');
    return { format: 'module', shortCircuit: true, source: `const fake = globalThis.smokeStubs[${JSON.stringify(file)}];\n${names}\n` };
  },
});

// ---- Fixtures ----

const TZ = 'Asia/Jerusalem';
/** The home's default window for 17 October in Israel: [17 Oct, 24 Oct). */
const WEEK = { from: new RealDate('2026-10-16T21:00:00.000Z'), to: new RealDate('2026-10-23T21:00:00.000Z') };
const NEXT_WEEK = { from: WEEK.to, to: new RealDate('2026-10-30T22:00:00.000Z') };
const KIDS: CalendarAssignment = { calendarId: 'family.kids@group.calendar.google.com', labels: ['kids'], name: 'Kids', color: '#33b679' };
const SPOUSE: CalendarAssignment = { calendarId: 'dana.levi@gmail.com', labels: ['spouse'], name: 'Dana', color: '#f4511e', personName: 'Dana' };

function googleUser(o: Partial<UserConfig> = {}): UserConfig {
  return {
    id: 7, telegramId: 1007, name: 'Noa', calendarSource: 'GOOGLE', googleRefreshToken: 'refresh-token',
    calendarAssignments: [{ ...KIDS }, { ...SPOUSE }], ...o,
  } as unknown as UserConfig;
}

const event = (id: string, day: string, extra: RawEvent = {}): RawEvent => ({
  id, status: 'confirmed', summary: `Event ${id}`,
  start: { dateTime: `${day}T09:00:00+03:00` }, end: { dateTime: `${day}T10:00:00+03:00` },
  htmlLink: `https://www.google.com/calendar/event?eid=${id}`, ...extra,
});

/** The key the spec gives: the first 16 hex of sha256 over the sorted ids, joined by newlines. */
function keyFor(ids: string[], window: { from: Date; to: Date }, tz = TZ): string {
  const setHash = crypto.createHash('sha256').update([...ids].sort().join('\n')).digest('hex').slice(0, 16);
  return `gcal:range:v1:7:${setHash}:${tz}:${window.from.toISOString()}:${window.to.toISOString()}`;
}
const KEY = keyFor([KIDS.calendarId, SPOUSE.calendarId], WEEK);
const STAMP = 'gcal:stamp:7';

type Entry = { startedAt: number; items: Record<string, unknown>[]; goneIds: string[] };
const entryAt = (key: string) => decode(live(key)?.value) as Entry | null;
const rangeKeys = () => [...store.keys()].filter(k => k.startsWith('gcal:range:'));
const cacheWarned = () => captured.some(c => c.context === 'calendar-read-google-cache' && c.severity === 'warning');
const stampWarned = () => captured.some(c => c.context === 'calendar-read-google-stamp' && c.severity === 'warning');
const shared = () => globalThis as { __gcalInflight?: Map<string, unknown>; __gcalWritten?: Map<string, number> };

/** The tasks a route would hand to after(). */
const deferred: (() => Promise<void>)[] = [];
const recordDefer = (task: () => Promise<void>) => {
  deferred.push(task);
};

function reset() {
  clock = T0;
  events.length = 0;
  store.clear();
  redisLog.length = 0;
  redisFaults.clear();
  stampMode = 'ok';
  stampRequests.length = 0;
  google = {
    [KIDS.calendarId]: { summary: 'Family (kids)', items: [event('k1', '2026-10-18'), event('k2', '2026-10-20')] },
    [SPOUSE.calendarId]: { summary: 'dana.levi@gmail.com', items: [event('s1', '2026-10-19')] },
  };
  tokenFailure = null;
  tokenHangs = false;
  tokenSteps = 0;
  authThrows = false;
  listCalls.length = 0;
  holdLists = false;
  held.length = 0;
  writeOutcome = { kind: 'result', value: { success: true, eventId: 'g1' } };
  captured.length = 0;
  clearedRecurrence.length = 0;
  deferred.length = 0;
  shared().__gcalInflight?.clear();
  shared().__gcalWritten?.clear();
}

async function main() {
  const { readGoogle, stampGoogleCache } = await import('../src/services/calendar-read/google');
  const { googleProvider } = await import('../src/services/calendar-provider/google-provider');
  const { commitGoogleToken } = await import('../src/services/google-connect');

  type Options = Parameters<typeof readGoogle>[2];
  /** The range route's options: the cache, its 6,000 ms deadline and after(). */
  const route = (o: Partial<Options> = {}): Options => ({ tz: TZ, deadlineMs: 6000, googleCache: 'use', defer: recordDefer, ...o });
  const read = (user = googleUser(), o: Partial<Options> = {}, window = WEEK) => readGoogle(user, window, route(o));

  // ---- The modes ----

  await check('[guard] bypass, the default: Google on every read, and no Redis at all', async () => {
    reset();
    const a = await readGoogle(googleUser(), WEEK, { tz: TZ, deadlineMs: 6000 });
    const b = await readGoogle(googleUser(), WEEK, { tz: TZ, deadlineMs: 6000, googleCache: 'bypass', defer: recordDefer });
    assert(a.read.status === 'ok' && b.read.status === 'ok' && a.items.length === 3, `reads: ${show([a.read, b.read])}`);
    assert(listed() === 4, `${listed()} list calls for two reads of two calendars`);
    assert(redisLog.length === 0 && stampRequests.length === 0 && deferred.length === 0, `Redis: ${show(redisLog)} stamps: ${stampRequests.length}`);
  });

  await check('[guard] an empty token: reconnect, with no Redis and no Google', async () => {
    reset();
    const r = await read(googleUser({ googleRefreshToken: '' }));
    assert(r.read.status === 'reconnect' && r.read.reason === 'token', show(r.read));
    assert(redisLog.length === 0 && listed() === 0 && stampRequests.length === 0, `Redis: ${show(redisLog)}`);
  });

  await check('[guard] no chosen calendar: ok and empty, with no Redis', async () => {
    reset();
    const r = await read(googleUser({ calendarAssignments: [] }));
    assert(r.read.status === 'ok' && r.items.length === 0 && r.read.calendars.length === 0, show(r.read));
    assert(redisLog.length === 0 && listed() === 0, `Redis: ${show(redisLog)}`);
  });

  // ---- Misses, hits, stale ----

  await check('a miss lists each calendar once and writes one entry, EX 1800, without calendar refs', async () => {
    reset();
    const r = await read();
    assert(r.read.status === 'ok' && r.items.length === 3 && !r.read.stale, show(r.read));
    assert(listed() === 2 && listCalls.every(c => c.timeout === 5500), `list calls: ${show(listCalls)}`);
    assert(show(redisLog.map(c => c.cmd)) === '["mget","set"]' && redisLog[0].key === `${STAMP} ${KEY}`, `commands: ${show(redisLog)}`);
    assert(show(rangeKeys()) === show([KEY]), `keys: ${show(rangeKeys())}`);
    const e = entryAt(KEY)!;
    assert(e.startedAt === T0 && show(e.goneIds) === '[]', `entry: ${show({ startedAt: e.startedAt, goneIds: e.goneIds })}`);
    assert(e.items.length === 3 && e.items.every(i => !('calendar' in i)), 'items kept their calendar refs');
    assert(!live(KEY)!.value.includes('"Kids"'), 'the entry holds an assignment name');
    assert(store.get(KEY)!.expiresAt === T0 + 1_800_000, `expires at ${store.get(KEY)!.expiresAt}`);
  });

  await check('the key: 16 hex digits of sha256 over the sorted ids, in any order, naming no calendar', async () => {
    reset();
    await read(googleUser({ calendarAssignments: [{ ...SPOUSE }, { ...KIDS }] }));
    const [key] = rangeKeys();
    assert(key === KEY, `key ${key}, expected ${KEY}`);
    assert(/^gcal:range:v1:7:[0-9a-f]{16}:Asia\/Jerusalem:2026-10-16T21:00:00\.000Z:2026-10-23T21:00:00\.000Z$/.test(key), key);
    assert(!key.includes('@') && !key.includes('dana'), `a calendar id in the key: ${key}`);
  });

  await check('a hit under 3 minutes: no Google call, with the calendars joined from today\'s choices', async () => {
    reset();
    await read();
    clock += 3 * 60_000 - 1;
    const r = await read(googleUser({ calendarAssignments: [{ ...KIDS, name: 'School run' }, { ...SPOUSE }] }));
    assert(listed() === 2, `${listed()} list calls`);
    assert(r.read.status === 'ok' && !r.read.stale && r.read.partial === null && deferred.length === 0, show(r.read));
    assert(r.read.calendars.map(c => c.name).join() === 'School run,Dana', `legend: ${show(r.read.calendars)}`);
    const kids = r.items.filter(i => i.calendar.id === KIDS.calendarId);
    const spouse = r.items.find(i => i.calendar.id === SPOUSE.calendarId);
    assert(kids.length === 2 && kids.every(i => i.calendar.name === 'School run' && i.calendar.mine), `kids: ${show(kids.map(i => i.calendar))}`);
    assert(spouse?.calendar.mine === false && spouse.calendar.ownerName === 'Dana', `spouse: ${show(spouse?.calendar)}`);
    assert(r.items.map(i => i.event.eventId).join() === 'k1,s1,k2', `order: ${r.items.map(i => i.event.eventId).join()}`);
  });

  await check('one invite on two chosen calendars: both copies, each with its own calendar, also from a hit', async () => {
    reset();
    const invite = event('evt1', '2026-10-19', { summary: 'Parent-teacher meeting' });
    google[KIDS.calendarId] = { summary: 'Family (kids)', items: [{ ...invite }] };
    google[SPOUSE.calendarId] = { summary: 'dana.levi@gmail.com', items: [{ ...invite }] };
    const copies = (r: Awaited<ReturnType<typeof read>>) => r.items.map(i => [i.key, i.calendar.id, i.calendar.mine, i.calendar.ownerName ?? null]);
    const want = [
      [`google|${KIDS.calendarId}|evt1`, KIDS.calendarId, true, null],
      [`google|${SPOUSE.calendarId}|evt1`, SPOUSE.calendarId, false, 'Dana'],
    ];
    const miss = await read();
    assert(show(copies(miss)) === show(want), `miss: ${show(copies(miss))}`);
    assert(entryAt(KEY)?.items.length === 2, `entry: ${show(entryAt(KEY)?.items.map(i => i.key))}`);
    clock += 60_000;
    const hit = await read();
    assert(listed() === 2, `${listed()} list calls: not a hit`);
    assert(show(copies(hit)) === show(want), `hit: ${show(copies(hit))}`);
  });

  await check('3 to 30 minutes: stale, plus one background refresh handed to defer, with a 6,000 ms deadline', async () => {
    reset();
    await read();
    clock += 3 * 60_000;
    const r = await read(undefined, { deadlineMs: 10_000 });
    assert(r.read.status === 'ok' && r.read.stale === true && r.items.length === 3, show(r.read));
    assert(listed() === 2 && deferred.length === 1, `${listed()} list calls, ${deferred.length} deferred`);
    await deferred[0]();
    assert(listed() === 4 && listCalls.slice(2).every(c => c.timeout === 5500), `refresh calls: ${show(listCalls.slice(2))}`);
    assert(entryAt(KEY)?.startedAt === clock, `entry startedAt ${entryAt(KEY)?.startedAt}`);
    const again = await read();
    assert(again.read.status === 'ok' && !again.read.stale && listed() === 4, show(again.read));
  });

  await check('two stale hits before the refresh runs: one Google read', async () => {
    reset();
    await read();
    clock += 5 * 60_000;
    await read();
    await read();
    assert(deferred.length === 2, `${deferred.length} deferred`);
    await Promise.all(deferred.map(task => task()));
    assert(listed() === 4, `${listed()} list calls`);
  });

  await check('without defer the refresh runs on its own; one that fails keeps the entry and leaves nothing behind', async () => {
    reset();
    await read();
    clock += 5 * 60_000;
    const stale = await read(undefined, { defer: undefined });
    assert(stale.read.status === 'ok' && stale.read.stale, show(stale.read));
    await flush();
    assert(listed() === 4 && entryAt(KEY)?.startedAt === clock, `${listed()} list calls`);
    const refreshedAt = clock;
    clock += 5 * 60_000;
    authThrows = true;
    const again = await read(undefined, { defer: undefined });
    assert(again.read.status === 'ok' && again.read.stale, show(again.read));
    await flush();
    await flush();
    assert(captured.some(c => /auth exploded/.test(c.message)), `captured: ${show(captured)}`);
    assert(entryAt(KEY)?.startedAt === refreshedAt && !store.has(STAMP), 'the failed refresh changed the entry or stamped');
    assert(unhandled.length === 0, `unhandled: ${show(unhandled.map(String))}`);
    assert(shared().__gcalInflight?.size === 0, 'the failed refresh is still in flight');
  });

  await check('a defer that throws (after() outside a request): the refresh still runs, with a warning', async () => {
    reset();
    await read();
    clock += 5 * 60_000;
    const stale = await read(undefined, {
      defer: () => {
        throw new Error('after() was called outside a request scope (smoke)');
      },
    });
    assert(stale.read.status === 'ok' && stale.read.stale, show(stale.read));
    await flush();
    assert(listed() === 4 && entryAt(KEY)?.startedAt === clock, `${listed()} list calls`);
    assert(captured.some(c => c.context === 'calendar-read-google-cache' && /outside a request/.test(c.message)), `captured: ${show(captured)}`);
  });

  await check('30 minutes old is a miss, even while Redis still holds it', async () => {
    reset();
    await read();
    store.get(KEY)!.expiresAt = null;
    clock += 30 * 60_000;
    const r = await read();
    assert(r.read.status === 'ok' && !r.read.stale && listed() === 4 && deferred.length === 0, `${listed()} list calls`);
  });

  // ---- The stamp and reads in flight ----

  await check('a stamp after startedAt invalidates the entry', async () => {
    reset();
    await read();
    clock += 10_000;
    await stampGoogleCache(7);
    clock += 10_000;
    const r = await read();
    assert(r.read.status === 'ok' && !r.read.stale && listed() === 4, `${listed()} list calls`);
    assert(entryAt(KEY)?.startedAt === T0 + 20_000, `entry startedAt ${entryAt(KEY)?.startedAt}`);
  });

  await check('a stamp during a read in flight: later requests don\'t join it, and it writes nothing', async () => {
    reset();
    holdLists = true;
    const first = read();
    await flush();
    clock += 1000;
    await stampGoogleCache(7);
    clock += 1000;
    const second = read();
    await flush();
    assert(listed() === 4, `the second request joined the first: ${listed()} list calls`);
    release(2);
    await first;
    assert(rangeKeys().length === 0, 'the first read wrote although a newer one is in flight');
    release();
    await second;
    assert(entryAt(KEY)?.startedAt === T0 + 2000, `entry startedAt ${entryAt(KEY)?.startedAt}`);
  });

  await check('an older read never overwrites a newer one that already wrote', async () => {
    reset();
    holdLists = true;
    const first = read();
    await flush();
    clock += 1000;
    await stampGoogleCache(7);
    clock += 1000;
    holdLists = false;
    await read();
    assert(entryAt(KEY)?.startedAt === T0 + 2000, 'the newer read did not write');
    release();
    await first;
    assert(entryAt(KEY)?.startedAt === T0 + 2000, `the older read overwrote it: ${entryAt(KEY)?.startedAt}`);
  });

  await check('an older read\'s finally leaves a newer read\'s flight in place', async () => {
    reset();
    holdLists = true;
    const first = read();
    await flush();
    clock += 1000;
    await stampGoogleCache(7);
    clock += 1000;
    const second = read();
    await flush();
    release(2);
    await first;
    const third = read();
    await flush();
    assert(listed() === 4, `the third request started its own read: ${listed()} list calls`);
    release();
    const [two, three] = await Promise.all([second, third]);
    assert(three === two, 'the third request did not get the second read\'s result');
  });

  await check('two concurrent reads: one list call per calendar', async () => {
    reset();
    holdLists = true;
    const a = read();
    const b = read();
    await flush();
    assert(listed() === 2, `${listed()} list calls`);
    release();
    const [ra, rb] = await Promise.all([a, b]);
    assert(ra.read.status === 'ok' && rb === ra, 'the two requests got different reads');
  });

  // ---- Outcomes ----

  await check('a stale entry whose refresh finds a dead token: the next request says reconnect', async () => {
    reset();
    await read();
    clock += 5 * 60_000;
    const stale = await read();
    assert(stale.read.status === 'ok' && stale.read.stale && deferred.length === 1, show(stale.read));
    tokenFailure = invalidGrant();
    await deferred[0]();
    assert(Number(store.get(STAMP)?.value) === clock, `stamp: ${show(store.get(STAMP))}`);
    clock += 1000;
    const next = await read();
    assert(next.read.status === 'reconnect' && next.read.reason === 'token', `served: ${show(next.read)}`);
  });

  await check('a dead token on a miss: reconnect, the user\'s entries stamped for an hour, nothing written', async () => {
    reset();
    tokenFailure = invalidGrant();
    const r = await read();
    assert(r.read.status === 'reconnect' && r.read.reason === 'token', show(r.read));
    assert(rangeKeys().length === 0, `written: ${show(rangeKeys())}`);
    const stamp = store.get(STAMP);
    assert(Number(stamp?.value) === T0 && stamp?.expiresAt === T0 + 3_600_000, `stamp: ${show(stamp)}`);
  });

  await check('every chosen calendar gone: calendars_gone, stamped, nothing written', async () => {
    reset();
    google = {};
    const r = await read();
    assert(r.read.status === 'error' && r.read.reason === 'calendars_gone', show(r.read));
    assert(store.has(STAMP) && rangeKeys().length === 0, `stamp: ${store.has(STAMP)}, keys: ${show(rangeKeys())}`);
  });

  await check('one gone calendar: ok with goneIds, cached, and a hit marks that calendar unavailable', async () => {
    reset();
    delete google[SPOUSE.calendarId];
    const r = await read();
    assert(r.read.status === 'ok' && show(r.read.goneIds) === show([SPOUSE.calendarId]) && r.read.partial === null, show(r.read));
    assert(show(entryAt(KEY)?.goneIds) === show([SPOUSE.calendarId]) && !store.has(STAMP), `entry: ${show(entryAt(KEY)?.goneIds)}`);
    clock += 60_000;
    const hit = await read();
    assert(listed() === 2 && hit.read.status === 'ok', `${listed()} list calls`);
    assert(show(hit.read.goneIds) === show([SPOUSE.calendarId]), show(hit.read));
    const legend = Object.fromEntries(hit.read.calendars.map(c => [c.id, c.unavailable ?? false]));
    assert(legend[SPOUSE.calendarId] === true && legend[KIDS.calendarId] === false, `legend: ${show(legend)}`);
  });

  await check('a partial read (one calendar failing) is not cached', async () => {
    reset();
    google[SPOUSE.calendarId] = { error: httpError(500, 'Backend Error', 'backendError') };
    const r = await read();
    assert(r.read.status === 'ok' && r.read.partial?.failed === 1 && r.items.length === 2, show(r.read));
    assert(redisLog.some(c => c.cmd === 'mget'), 'the cache was never read');
    assert(rangeKeys().length === 0 && !store.has(STAMP), `keys: ${show(rangeKeys())}`);
  });

  await check('a truncated read (5,001 items over three pages) is not cached, and the next read lists again', async () => {
    reset();
    // Nearly all cancelled, so the entry would be small: only the truncation keeps it out.
    const cancelled = (from: number, n: number) => Array.from({ length: n }, (_, i) => event(`x${from + i}`, '2026-10-18', { status: 'cancelled' }));
    const pages = [[event('k1', '2026-10-18'), ...cancelled(0, 2499)], cancelled(2499, 2500), [event('k3', '2026-10-21')]];
    google[KIDS.calendarId] = { summary: 'Family (kids)', pages };
    const r = await read();
    assert(r.read.status === 'ok' && show(r.read.partial) === show({ failed: 0, truncated: 1 }), show(r.read));
    assert(r.items.map(i => i.event.eventId).join() === 'k1,s1', `items: ${r.items.map(i => i.event.eventId).join()}`);
    assert(listCalls.filter(c => c.calendarId === KIDS.calendarId).length === 2, `the cap did not stop the paging: ${show(listCalls)}`);
    assert(redisLog.some(c => c.cmd === 'mget'), 'the cache was never read');
    assert(rangeKeys().length === 0 && !store.has(STAMP), `keys: ${show(rangeKeys())}`);
    clock += 60_000;
    const again = await read();
    assert(again.read.status === 'ok' && listed() === 6, `the next read made ${listed() - 3} list calls`);
    // The first 5,000 with nothing after them are a whole read, and that one is written.
    reset();
    google[KIDS.calendarId] = { summary: 'Family (kids)', pages: pages.slice(0, 2) };
    const whole = await read();
    assert(whole.read.status === 'ok' && whole.read.partial === null, show(whole.read));
    assert(show(rangeKeys()) === show([KEY]), `keys: ${show(rangeKeys())}`);
  });

  await check('a failed read is neither cached nor stamped', async () => {
    reset();
    google[KIDS.calendarId] = { error: httpError(500, 'Backend Error', 'backendError') };
    google[SPOUSE.calendarId] = { error: httpError(503, 'Service Unavailable', 'backendError') };
    const r = await read();
    assert(r.read.status === 'error' && r.read.reason === 'transient', show(r.read));
    assert(redisLog.some(c => c.cmd === 'mget'), 'the cache was never read');
    assert(rangeKeys().length === 0 && !store.has(STAMP), `keys: ${show(rangeKeys())}`);
  });

  await check('an entry over 512 KB is not written', async () => {
    reset();
    const long = 'x'.repeat(500);
    google[KIDS.calendarId] = {
      summary: 'Kids',
      items: Array.from({ length: 1200 }, (_, i) => event(`big${i}`, '2026-10-18', { description: long, location: 'Community centre, hall B' })),
    };
    const r = await read();
    assert(r.read.status === 'ok' && r.items.length === 1201, `${r.items.length} items`);
    assert(redisLog.some(c => c.cmd === 'mget'), 'the cache was never read');
    assert(rangeKeys().length === 0, 'a value over 512 KB was written');
  });

  // ---- fresh=1 ----

  await check('fresh=1 twice within 30 s on one window: the second reads as use; another window is honoured', async () => {
    reset();
    await read();
    clock += 10_000;
    await read(undefined, { googleCache: 'refresh' });
    const freshKey = `gcal:fresh:7:${WEEK.from.toISOString()}:${WEEK.to.toISOString()}`;
    assert(listed() === 4, `the first refresh made ${listed() - 2} list calls`);
    assert(store.get(freshKey)?.expiresAt === clock + 30_000, `limit key: ${show(store.get(freshKey))}`);
    assert(entryAt(KEY)?.startedAt === clock, 'the refresh did not write');
    clock += 10_000;
    const second = await read(undefined, { googleCache: 'refresh' });
    assert(listed() === 4 && second.read.status === 'ok' && !second.read.stale, `the second refresh made ${listed() - 4} list calls`);
    await read(undefined, { googleCache: 'refresh' }, NEXT_WEEK);
    assert(listed() === 6, `another window: ${listed() - 4} list calls`);
    clock += 21_000;
    await read(undefined, { googleCache: 'refresh' });
    assert(listed() === 8, `31 s after the first: ${listed() - 6} list calls`);
  });

  await check('fresh=1 joins only a read that started after it arrived; later requests join the newest', async () => {
    reset();
    holdLists = true;
    const before = read();
    await flush();
    clock += 1000;
    const refresh = read(undefined, { googleCache: 'refresh' });
    await flush();
    assert(listed() === 4, `the refresh joined a read from before it arrived: ${listed()} list calls`);
    const after = read();
    await flush();
    assert(listed() === 4, `a later request started a third read: ${listed()} list calls`);
    release();
    const [, fresh, later] = await Promise.all([before, refresh, after]);
    assert(later === fresh, 'the later request did not join the refresh');
    assert(entryAt(KEY)?.startedAt === T0 + 1000, `entry startedAt ${entryAt(KEY)?.startedAt}`);
  });

  // ---- Redis failing ----

  await check('Redis down: an MGET error is a miss with no write, and a warning', async () => {
    reset();
    redisFaults.add('mget');
    const r = await read();
    assert(r.read.status === 'ok' && r.items.length === 3 && listed() === 2, show(r.read));
    assert(!redisLog.some(c => c.cmd === 'set'), `commands: ${show(redisLog)}`);
    assert(cacheWarned(), `captured: ${show(captured)}`);
  });

  await check('a failed write still answers with Google\'s read', async () => {
    reset();
    redisFaults.add('set');
    const r = await read();
    assert(r.read.status === 'ok' && r.items.length === 3, show(r.read));
    assert(cacheWarned(), `captured: ${show(captured)}`);
  });

  // ---- Shared state ----

  await check('reads in flight and last writes live on globalThis; a last write is forgotten after 30 minutes', async () => {
    reset();
    holdLists = true;
    const r = read();
    await flush();
    const state = shared();
    assert(state.__gcalInflight instanceof Map && state.__gcalInflight.has(KEY), 'no flight on globalThis');
    release();
    await r;
    assert(state.__gcalInflight.size === 0, 'the flight outlived its read');
    assert(state.__gcalWritten?.get(KEY) === T0, `last write: ${show([...(state.__gcalWritten ?? new Map()).entries()])}`);
    clock += 30 * 60_000 + 1;
    holdLists = false;
    await read(undefined, {}, NEXT_WEEK);
    assert(!state.__gcalWritten.has(KEY) && state.__gcalWritten.size === 1, `last writes: ${show([...state.__gcalWritten.keys()])}`);
  });

  await check('a read that fails unexpectedly leaves no flight and no entry behind', async () => {
    reset();
    authThrows = true;
    // The live read reports a throw as error('unknown'); a rejection must leave the same state.
    const outcome = await read().then(r => r.read.status, () => 'rejected');
    assert(outcome === 'error' || outcome === 'rejected', `outcome ${outcome}`);
    assert(shared().__gcalInflight?.size === 0, 'the failed read is still in flight');
    assert(rangeKeys().length === 0 && !store.has(STAMP), `keys: ${show(rangeKeys())}`);
    authThrows = false;
    const r = await read();
    assert(r.read.status === 'ok' && listed() === 2, `${listed()} list calls`);
  });

  await check('a token server that never answers: timeout within the deadline, no flight left, and the next read runs its own token step', async () => {
    reset();
    tokenHangs = true;
    const started = performance.now();
    const r = await read(undefined, { deadlineMs: 600 });
    const ms = performance.now() - started;
    assert(r.read.status === 'error' && r.read.reason === 'timeout', show(r.read));
    assert(ms >= 550 && ms < 900, `took ${Math.round(ms)} ms`);
    assert(shared().__gcalInflight?.size === 0 && !shared().__gcalInflight?.has(KEY), 'the timed-out read is still in flight');
    assert(rangeKeys().length === 0 && !store.has(STAMP) && listed() === 0, `keys: ${show(rangeKeys())}, ${listed()} list calls`);
    tokenHangs = false;
    const next = await read();
    assert(tokenSteps === 2, `${tokenSteps} token steps: the next read joined the hung one`);
    assert(next.read.status === 'ok' && listed() === 2, `${show(next.read)}, ${listed()} list calls`);
  });

  // ---- stampGoogleCache ----

  await check('stampGoogleCache sets gcal:stamp:<id> to now, EX 3600, through its own client', async () => {
    reset();
    clock = T0 + 5;
    await stampGoogleCache(7);
    assert(stampRequests.length === 1, `${stampRequests.length} requests`);
    assert(show(stampRequests[0].commands) === show([['set', STAMP, T0 + 5, 'ex', 3600]]), `sent ${show(stampRequests[0].commands)}`);
    assert(stampRequests[0].abortable, 'the request carries no abort signal');
    assert(redisLog.length === 0, `it went through the shared client: ${show(redisLog)}`);
    assert(store.get(STAMP)?.expiresAt === T0 + 5 + 3_600_000, `stamp: ${show(store.get(STAMP))}`);
  });

  await check('it drops that user\'s weekly recurrence answers', async () => {
    reset();
    await stampGoogleCache(7);
    assert(show(clearedRecurrence) === '[7]', `cleared: ${show(clearedRecurrence)}`);
  });

  await check('Redis refusing: one attempt, no throw, and a warning', async () => {
    reset();
    stampMode = 'throw';
    await stampGoogleCache(7);
    assert(stampRequests.length === 1, `${stampRequests.length} attempts`);
    assert(stampWarned(), `captured: ${show(captured)}`);
  });

  await check('Redis stuck: back within 750 ms, with a warning', async () => {
    reset();
    stampMode = 'stuck';
    const started = performance.now();
    await stampGoogleCache(7);
    const ms = performance.now() - started;
    assert(ms >= 700 && ms < 1000, `took ${Math.round(ms)} ms`);
    assert(stampWarned(), `captured: ${show(captured)}`);
  });

  // ---- The stamp after every bot write to Google ----

  const writer = googleUser();
  const startTime = new RealDate('2026-10-18T07:00:00.000Z');
  const endTime = new RealDate('2026-10-18T08:00:00.000Z');
  const writes: [string, () => Promise<unknown>][] = [
    ['create', () => googleProvider.createEvent(writer, 'primary', { title: 'Dentist', startTime, endTime })],
    ['update', () => googleProvider.updateEvent(writer, 'primary', 'g1', { title: 'Dentist, room 4' })],
    ['delete', () => googleProvider.deleteEvent(writer, 'primary', 'g1')],
  ];

  await check('create, update and delete stamp after the write, and return its result unchanged', async () => {
    for (const [kind, write] of writes) {
      reset();
      const value = { success: true, eventId: `g-${kind}` };
      writeOutcome = { kind: 'result', value };
      const got = await write();
      assert(got === value, `${kind} returned ${show(got)}`);
      assert(show(events) === show([`write ${kind}`, `stamp ${STAMP}`]), `${kind}: ${show(events)}`);
    }
  });

  await check('a failed write (TOKEN_EXPIRED) still stamps, and comes back as it was', async () => {
    for (const [kind, write] of writes) {
      reset();
      const value = { success: false, error: 'TOKEN_EXPIRED', errorMessage: 'Google Calendar token expired' };
      writeOutcome = { kind: 'result', value };
      const got = await write();
      assert(got === value, `${kind} returned ${show(got)}`);
      assert(show(events) === show([`write ${kind}`, `stamp ${STAMP}`]), `${kind}: ${show(events)}`);
    }
  });

  await check('a write that throws still stamps, and the same error is rethrown', async () => {
    for (const [kind, write] of writes) {
      reset();
      const error = new Error(`${kind} blew up (smoke)`);
      writeOutcome = { kind: 'throw', error };
      let thrown: unknown;
      try {
        await write();
      } catch (err) {
        thrown = err;
      }
      assert(thrown === error, `${kind} threw ${String(thrown)}`);
      assert(show(events) === show([`write ${kind}`, `stamp ${STAMP}`]), `${kind}: ${show(events)}`);
    }
  });

  await check('the stamp\'s Redis refusing or stuck: the write\'s result within 750 ms, nothing unhandled', async () => {
    for (const mode of ['throw', 'stuck'] as const) {
      reset();
      stampMode = mode;
      const value = { success: true, eventId: `g-${mode}` };
      writeOutcome = { kind: 'result', value };
      const started = performance.now();
      const got = await googleProvider.createEvent(writer, 'primary', { title: 'Dentist', startTime, endTime });
      const ms = performance.now() - started;
      assert(got === value, `${mode}: returned ${show(got)}`);
      assert(stampRequests.length === 1, `${mode}: ${stampRequests.length} stamp requests`);
      // Awaited, and bounded: a stuck Redis holds the write's answer for the stamp's 750 ms, no longer
      assert(ms < 1000 && (mode === 'throw' || ms >= 700), `${mode}: took ${Math.round(ms)} ms`);
    }
    await new Promise(resolve => setTimeout(resolve, 50));
    assert(unhandled.length === 0, `unhandled: ${show(unhandled.map(String))}`);
  });

  await check('[guard] no Google token: not connected, with no write and no stamp', async () => {
    reset();
    const got = await googleProvider.createEvent(googleUser({ googleRefreshToken: '' }), 'primary', { title: 'Dentist', startTime, endTime });
    assert(got.success === false && got.error === 'NOT_CONNECTED', show(got));
    assert(events.length === 0, show(events));
  });

  // ---- The stamp after a reconnect ----

  await check('commitGoogleToken stamps after the transaction and the reminder-cache update', async () => {
    reset();
    await commitGoogleToken(7, 'new-refresh-token');
    const at = (e: string) => events.indexOf(e);
    assert(at(`stamp ${STAMP}`) >= 0, `no stamp: ${show(events)}`);
    assert(at('db.$transaction') >= 0 && at(`stamp ${STAMP}`) > at('db.$transaction'), `order: ${show(events)}`);
    assert(at('reminderCache.update') >= 0 && at(`stamp ${STAMP}`) > at('reminderCache.update'), `order: ${show(events)}`);
  });

  // Free the loop of any read a failed check left waiting on Google
  release();
  await flush();

  let failed = 0;
  for (const r of results) {
    if (r.ok) console.log(`OK    ${r.name}`);
    else {
      failed++;
      console.log(`FAIL  ${r.name}\n      ${r.reason}`);
    }
  }
  console.log(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Run the smoke and see it fail**

```bash
for tz in UTC Asia/Jerusalem; do TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-calendar-read-google-cache.ts; echo "exit $?"; done
```

Expected under each clock: `4/42 passed (process TZ=…)` and then `exit 1`. The four `[guard]` checks pass. Every other check fails, for example:
- `a miss lists each calendar once …`: `commands: []`;
- `a stamp after startedAt invalidates the entry`: `stampGoogleCache is not a function`;
- `two concurrent reads: one list call per calendar`: `4 list calls`;
- `create, update and delete stamp after the write …`: `create: ["write create"]`;
- `commitGoogleToken stamps after …`: `no stamp: ["db.updateUserById","db.$transaction","reminderCache.update","admin.notify","redis.set googleConnected:7"]`.

Don't run `tsc` yet: `GoogleHalfOptions` and `stampGoogleCache` don't exist until Step 3. `tsx` doesn't type-check, so the smoke runs.

- [ ] **Step 3: Put the cache and the stamp in `src/services/calendar-read/google.ts`**

Line numbers are those of B6's `google.ts` (397 lines), before any edit in this step.

3a. The header paragraph. Find (lines 17-19):

```ts
 * readGoogleUncached is the live read. readGoogle is what readRange calls: the live read
 * here, with Task B7's route cache put in front of it later. Nothing here stamps the
 * cache; B7's wrapper does that for reads that end in reconnect or calendars_gone.
 */
```

Replace with:

```ts
 * readGoogleUncached is the live read. readGoogle is what readRange calls: the live read
 * for the summaries ('bypass'), and for the range route the cache in front of it (spec
 * §2.6, at the end of this file). stampGoogleCache invalidates a user's cached reads after
 * a write to Google, a reconnect, or a read that ends in reconnect or calendars_gone.
 */
```

3b. The imports. Find (lines 22-30):

```ts
import { calendar as googleCalendar } from '@googleapis/calendar';
import type { calendar_v3 } from '@googleapis/calendar';
import { getGoogleAuth } from '../calendar';
import { classifyGoogleError, keepGoogleEvent, mapGoogleEvent } from './google-map';
import { captureError, captureWarning } from '../../lib/error-capture';
import { redis } from '../../utils/redis';
import { REDIS_KEYS } from '../../config/redis-keys';
import type { CalendarAssignment, UserConfig } from '../../types';
import type { CalendarRef, GoogleRead, ReadItem } from './types';
```

Replace with:

```ts
import crypto from 'crypto';
import { calendar as googleCalendar } from '@googleapis/calendar';
import type { calendar_v3 } from '@googleapis/calendar';
import { Redis } from '@upstash/redis';
import { getGoogleAuth } from '../calendar';
import { clearRecurrenceCacheForUser } from '../recurrence-cache';
import { classifyGoogleError, keepGoogleEvent, mapGoogleEvent } from './google-map';
import { captureError, captureWarning } from '../../lib/error-capture';
import { redis } from '../../utils/redis';
import { REDIS_KEYS } from '../../config/redis-keys';
import type { CalendarAssignment, UserConfig } from '../../types';
import type { CalendarRef, GoogleRead, ReadItem, ReadRangeOptions } from './types';
```

3c. B6's `readGoogle`. Find (lines 387-397, the end of the file):

```ts
/**
 * The Google half for readRange (spec §2.5). In this task it is the live read; Task B7 puts
 * the route's cache in front of it and adds opts.googleCache and opts.defer.
 */
export function readGoogle(
  user: UserConfig,
  window: { from: Date; to: Date },
  opts: GoogleReadOptions,
): Promise<GoogleReadResult> {
  return readGoogleUncached(user, window, opts);
}
```

Replace with (to the end of the file):

```ts
// ---- The range route's cache (spec §2.6) ----
//
// One entry per user, calendar set, timezone and window: { startedAt, items, goneIds },
// the items without their calendar, which is joined from the user's choices on every
// read, so a relabel shows at once. An entry is valid only while its startedAt is later
// than the user's stamp. startedAt is taken before Google is asked, so a read that began
// before a write and landed after it is never served.
//
// The reads in flight and the last write per key live on globalThis: the scheduler and
// the routes are separate bundles (Next 16), each with its own module instances.
//
// Redis errors fail open: a miss, no write, a warning. The summaries never come here.

const CACHE_LOG_CONTEXT = 'calendar-read-google-cache';
const STAMP_LOG_CONTEXT = 'calendar-read-google-stamp';
/** An entry younger than this is served as it is. */
const FRESH_MS = 3 * 60_000;
/** Older than FRESH_MS and younger than this: served stale, with one background refresh. */
const STALE_MS = 30 * 60_000;
const ENTRY_TTL_S = 1_800;
/** Longer than any entry lives. */
const STAMP_TTL_S = 3_600;
const MAX_ENTRY_BYTES = 512 * 1024;
/** fresh=1 is honoured once per this, per user and window. */
const FRESH_LIMIT_S = 30;
const REFRESH_DEADLINE_MS = 6_000;
const STAMP_TIMEOUT_MS = 750;

/** readGoogle's options: the live read's, plus the cache's (ReadRangeOptions, spec §2.2). */
export interface GoogleHalfOptions extends GoogleReadOptions {
  googleCache?: ReadRangeOptions['googleCache'];   // default 'bypass'; only the range route passes 'use' or 'refresh'
  defer?: ReadRangeOptions['defer'];               // runs a stale entry's refresh; the route passes after()
}

/** What the cache keeps under a key. */
interface CacheEntry {
  startedAt: number;
  items: GoogleItem[];
  goneIds: string[];
}

/** A live read in flight for a key. */
interface Flight {
  startedAt: number;
  promise: Promise<GoogleReadResult>;
}

/** One cached read: who, which window, which calendars, under which key. */
interface CachedRead {
  user: UserConfig;
  window: { from: Date; to: Date };
  live: GoogleReadOptions;
  set: CalendarAssignment[];
  key: string;
  defer?: ReadRangeOptions['defer'];
}

const cacheState = globalThis as { __gcalInflight?: Map<string, Flight>; __gcalWritten?: Map<string, number> };
/** The newest read in flight per key. */
const inflight: Map<string, Flight> = (cacheState.__gcalInflight ??= new Map());
/** The startedAt of the last write per key, kept 30 minutes. */
const lastWrite: Map<string, number> = (cacheState.__gcalWritten ??= new Map());

/** The first 16 hex digits of sha256 over the sorted calendar ids, which are often email addresses. */
function calendarSetHash(calendarIds: readonly string[]): string {
  return crypto.createHash('sha256').update([...calendarIds].sort().join('\n')).digest('hex').slice(0, 16);
}

/** The stamp as Upstash returns it (a number, or a string). Unreadable invalidates everything. */
function stampValue(raw: unknown): number {
  if (raw === null || raw === undefined) return 0;
  const at = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(at) ? at : Number.POSITIVE_INFINITY;
}

/** An entry as Upstash returns it (parsed JSON, or a string); anything else is a miss. */
function entryValue(raw: unknown): CacheEntry | null {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object') return null;
  const e = value as Partial<CacheEntry>;
  return typeof e.startedAt === 'number' && Array.isArray(e.items) && Array.isArray(e.goneIds) ? (e as CacheEntry) : null;
}

/** A valid entry as a read, its calendars joined from today's choices. */
function fromEntry(entry: CacheEntry, set: readonly CalendarAssignment[], stale: boolean): GoogleReadResult {
  return {
    read: {
      status: 'ok',
      calendars: set.map(a => googleCalendarRef(a, entry.goneIds)),
      goneIds: entry.goneIds,
      partial: null,
      stale,
    },
    items: attachGoogleCalendars(entry.items, set, entry.goneIds),
  };
}

function withoutCalendar({ calendar: _calendar, ...item }: ReadItem): GoogleItem {
  return item;
}

function rememberWrite(key: string, startedAt: number): void {
  const cutoff = Date.now() - STALE_MS;
  for (const [k, at] of lastWrite) if (at < cutoff) lastWrite.delete(k);
  lastWrite.set(key, startedAt);
}

/**
 * After a live read: a dead token or no calendar left stamps the user's entries, so a
 * stale entry never hides it; a whole ok read (partial null) is written, gone calendars
 * and all. Only the newest read writes: none that started later may still be in flight
 * or have written already.
 */
async function afterRead(r: CachedRead, flight: Flight, result: GoogleReadResult): Promise<void> {
  const { read } = result;
  if (read.status === 'reconnect' || (read.status === 'error' && read.reason === 'calendars_gone')) {
    await stampGoogleCache(r.user.id);
    return;
  }
  if (read.status !== 'ok' || read.partial) return;
  const current = inflight.get(r.key);
  if (current && current !== flight && current.startedAt > flight.startedAt) return;
  const last = lastWrite.get(r.key);
  if (last !== undefined && last >= flight.startedAt) return;
  const entry: CacheEntry = { startedAt: flight.startedAt, items: result.items.map(withoutCalendar), goneIds: read.goneIds };
  const value = JSON.stringify(entry);
  if (Buffer.byteLength(value, 'utf8') > MAX_ENTRY_BYTES) return;
  rememberWrite(r.key, flight.startedAt);
  try {
    await redis.set(r.key, value, { ex: ENTRY_TTL_S });
  } catch (err) {
    captureError(err, CACHE_LOG_CONTEXT, { user_id: r.user.id }, 'warning');
  }
}

async function runFlight(r: CachedRead, flight: Flight, deadlineMs: number): Promise<GoogleReadResult> {
  try {
    const result = await readGoogleUncached(r.user, r.window, { ...r.live, deadlineMs });
    await afterRead(r, flight, result);
    return result;
  } finally {
    // A newer read for the key may have taken the slot; it is not this read's to remove.
    if (inflight.get(r.key) === flight) inflight.delete(r.key);
  }
}

/** Starts a live read and puts it in flight. Its first step awaits Google, so it is in the map before its finally runs. */
function startRead(r: CachedRead, deadlineMs: number): Promise<GoogleReadResult> {
  const flight = { startedAt: Date.now() } as Flight;
  flight.promise = runFlight(r, flight, deadlineMs);
  inflight.set(r.key, flight);
  return flight.promise;
}

/**
 * A stale entry's refresh, after the response when the caller can defer it. One at a time
 * per key: a read already in flight since the stamp will write. It never rejects.
 */
function refreshInBackground(r: CachedRead, stamp: number): void {
  const task = async () => {
    const flight = inflight.get(r.key);
    if (flight && flight.startedAt > stamp) return;
    await startRead(r, REFRESH_DEADLINE_MS);
  };
  const run = () => task().catch(err => captureError(err, CACHE_LOG_CONTEXT, { user_id: r.user.id }, 'warning'));
  if (!r.defer) {
    void run();
    return;
  }
  try {
    r.defer(run);
  } catch (err) {
    captureError(err, CACHE_LOG_CONTEXT, { user_id: r.user.id }, 'warning');
    void run();
  }
}

/**
 * The Google half for readRange (spec §2.5, §2.6). 'bypass', the default and every
 * summary's, is the live read. The range route passes 'use', or 'refresh' for fresh=1,
 * and reads through the cache. An empty token or no chosen calendar never reaches Google,
 * so it never reads the cache either (§2.5 steps 1 and 2).
 */
export async function readGoogle(
  user: UserConfig,
  window: { from: Date; to: Date },
  opts: GoogleHalfOptions,
): Promise<GoogleReadResult> {
  const live: GoogleReadOptions = { tz: opts.tz, calendarIds: opts.calendarIds, deadlineMs: opts.deadlineMs };
  const mode = opts.googleCache ?? 'bypass';
  const set = googleCalendarSet(user, opts.calendarIds);
  if (mode === 'bypass' || !user.googleRefreshToken || set.length === 0) return readGoogleUncached(user, window, live);

  const arrivedAt = Date.now();
  const from = window.from.toISOString();
  const to = window.to.toISOString();
  const key = REDIS_KEYS.gcalRange(user.id, calendarSetHash(set.map(a => a.calendarId)), opts.tz, from, to);
  const r: CachedRead = { user, window, live, set, key, defer: opts.defer };

  let refresh: boolean;
  let stamp: number;
  let entry: CacheEntry | null;
  try {
    // fresh=1 once per 30 s per user and window; past that it reads as 'use'.
    refresh = mode === 'refresh'
      && (await redis.set(REDIS_KEYS.gcalFresh(user.id, from, to), 1, { nx: true, ex: FRESH_LIMIT_S })) === 'OK';
    const [rawStamp, rawEntry] = await redis.mget<[unknown, unknown]>(REDIS_KEYS.gcalStamp(user.id), key);
    stamp = stampValue(rawStamp);
    entry = entryValue(rawEntry);
  } catch (err) {
    captureError(err, CACHE_LOG_CONTEXT, { user_id: user.id }, 'warning');
    return readGoogleUncached(user, window, live);
  }

  if (!refresh && entry && entry.startedAt > stamp) {
    const age = arrivedAt - entry.startedAt;
    if (age < FRESH_MS) return fromEntry(entry, set, false);
    if (age < STALE_MS) {
      refreshInBackground(r, stamp);
      return fromEntry(entry, set, true);
    }
  }

  // Join the read in flight unless a stamp came after it started; a refresh joins only a
  // read that started once it had arrived.
  const flight = inflight.get(key);
  if (flight && flight.startedAt > stamp && (!refresh || flight.startedAt >= arrivedAt)) return flight.promise;
  return startRead(r, opts.deadlineMs);
}

// ---- The stamp ----

let stampClient: Redis | undefined;

/**
 * The stamp's own client: one attempt per command (in @upstash/redis 1.35, `retry: false`
 * still makes two) and each request aborted at 750 ms, so a slow Redis can't hold up a
 * write to Google.
 */
function stampRedis(): Redis {
  stampClient ??= new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
    retry: { retries: 0 },
    signal: () => AbortSignal.timeout(STAMP_TIMEOUT_MS),
  });
  return stampClient;
}

/**
 * Invalidates every cached Google read of the user (spec §2.6) and drops their weekly
 * recurrence answers (§8.3). Called after each bot write to Google (google-provider.ts),
 * after a reconnect (google-connect.ts), and by a cached read ('use', 'refresh' or a
 * stale entry's refresh) that ends in reconnect or calendars_gone. A 'bypass' read, every
 * summary's, never stamps. It never throws or rejects, and takes at most 750 ms: a lost
 * stamp means at worst three minutes of pre-write data on the home.
 */
export async function stampGoogleCache(userId: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    clearRecurrenceCacheForUser(userId);
    const write = stampRedis().set(REDIS_KEYS.gcalStamp(userId), Date.now(), { ex: STAMP_TTL_S });
    const late = new Promise<'late'>(resolve => {
      timer = setTimeout(() => resolve('late'), STAMP_TIMEOUT_MS);
    });
    if ((await Promise.race([write, late])) === 'late') {
      captureError(new Error(`The Google cache stamp took over ${STAMP_TIMEOUT_MS} ms`), STAMP_LOG_CONTEXT, { user_id: userId }, 'warning');
    }
  } catch (err) {
    captureError(err, STAMP_LOG_CONTEXT, { user_id: userId }, 'warning');
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Stamp after every write in `src/services/calendar-provider/google-provider.ts`**

Line numbers are main@858886c's, before any edit in this step.

4a. The header. Find (lines 1-3):

```ts
// Google Calendar provider — adapter over the existing src/services/calendar.ts
// surface. Behavior is identical to the pre-abstraction direct calls; the only
// addition is the `provider: 'google'` tag on every returned event/calendar.
```

Replace with:

```ts
// Google Calendar provider — adapter over the existing src/services/calendar.ts
// surface. Behavior is identical to the pre-abstraction direct calls; the additions
// are the `provider: 'google'` tag on every returned event/calendar, and the calendar
// home's cache stamp after every write.
```

4b. The import. Find (line 25):

```ts
import { UserConfig } from '../../types';
```

Replace with:

```ts
import { UserConfig } from '../../types';
import { stampGoogleCache } from '../calendar-read/google';
```

4c. The helper. Find (line 38):

```ts
function notConnected(action: string): {
```

Replace with:

```ts
/**
 * Runs a write to Google, then stamps the user's calendar-home cache (spec §2.6) whatever
 * happened: a failed write may still have changed Google ("this and following" is two
 * calls). The stamp never throws and runs once the write's outcome is in hand, so the
 * caller gets the write's own result or error.
 */
async function writeThenStamp<T>(userId: number, write: () => Promise<T>): Promise<T> {
  let result: T;
  try {
    result = await write();
  } catch (err) {
    await stampGoogleCache(userId);
    throw err;
  }
  await stampGoogleCache(userId);
  return result;
}

function notConnected(action: string): {
```

4d. `createEvent`. Find (lines 86-97):

```ts
    if (!user.googleRefreshToken) return notConnected('create event');
    const result = await gcalCreate(user.googleRefreshToken, calendarId, {
      title: data.title,
      startTime: data.startTime,
      endTime: data.endTime,
      description: data.description,
      location: data.location,
      allDay: data.allDay,
      recurrence: data.recurrence,
      timeZone: data.allDay ? await allDayTimezone(user) : undefined,
    });
    return result;
```

Replace with:

```ts
    if (!user.googleRefreshToken) return notConnected('create event');
    const result = await writeThenStamp(user.id, async () => gcalCreate(user.googleRefreshToken, calendarId, {
      title: data.title,
      startTime: data.startTime,
      endTime: data.endTime,
      description: data.description,
      location: data.location,
      allDay: data.allDay,
      recurrence: data.recurrence,
      timeZone: data.allDay ? await allDayTimezone(user) : undefined,
    }));
    return result;
```

4e. `updateEvent`. Find (lines 101-102):

```ts
    if (!user.googleRefreshToken) return notConnected('update event');
    const result = await gcalUpdate(user.googleRefreshToken, calendarId, eventId, {
```

Replace with:

```ts
    if (!user.googleRefreshToken) return notConnected('update event');
    const result = await writeThenStamp(user.id, async () => gcalUpdate(user.googleRefreshToken, calendarId, eventId, {
```

Then find (lines 114-116):

```ts
      timeZone: data.startTime || data.endTime || data.allDay ? await allDayTimezone(user) : undefined,
    });
    return result;
```

Replace with:

```ts
      timeZone: data.startTime || data.endTime || data.allDay ? await allDayTimezone(user) : undefined,
    }));
    return result;
```

4f. `deleteEvent`. Find (lines 120-125):

```ts
    if (!user.googleRefreshToken) return notConnected('delete event');
    const result = await gcalDelete(user.googleRefreshToken, calendarId, eventId, {
      scope: options?.scope,
      recurringEventId: options?.recurringEventId,
    });
    return result;
```

Replace with:

```ts
    if (!user.googleRefreshToken) return notConnected('delete event');
    const result = await writeThenStamp(user.id, async () => gcalDelete(user.googleRefreshToken, calendarId, eventId, {
      scope: options?.scope,
      recurringEventId: options?.recurringEventId,
    }));
    return result;
```

A user with no token still gets `NOT_CONNECTED` with no stamp: nothing was written.

- [ ] **Step 5: Stamp after a reconnect in `src/services/google-connect.ts`**

5a. Find (line 24):

```ts
import { updateUserInCache } from './reminder-cache';
```

Replace with:

```ts
import { updateUserInCache } from './reminder-cache';
import { stampGoogleCache } from './calendar-read/google';
```

5b. Find (lines 152-156):

```ts
      location: user.location,
    });
  }

  // Notify admin of successful token refresh. It is sent with parse_mode HTML, and the
```

Replace with:

```ts
      location: user.location,
    });
  }

  // The calendar home's cached Google reads may be of the account this token replaced.
  // The stamp never throws.
  await stampGoogleCache(user.id);

  // Notify admin of successful token refresh. It is sent with parse_mode HTML, and the
```

- [ ] **Step 6: Run the smoke under both clocks and see it pass**

```bash
for tz in UTC Asia/Jerusalem; do TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-calendar-read-google-cache.ts; echo "exit $?"; done
```

Expected under each clock: 42 `OK` lines, `42/42 passed (process TZ=UTC)` or `(process TZ=Asia/Jerusalem)`, then `exit 0`. The run takes about 3 s: two checks wait about 750 ms each on the stuck Redis, and one 600 ms on a stuck token server. Node's `DEP0205` notice about `module.register()` comes from tsx and is harmless.

- [ ] **Step 7: Run the regression smokes**

```bash
for tz in UTC Asia/Jerusalem; do for s in smoke-calendar-read-google smoke-google-connect smoke-reminders smoke-native-provider-reminders smoke-voice-dates smoke-week-lookahead; do out=$(TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/$s.ts 2>&1); code=$?; echo "$tz $s exit $code :: $(echo "$out" | grep -aE '[0-9]+/[0-9]+ passed' | tail -1)"; done; done
```

Expected: every line is `exit 0`, with:
- `smoke-calendar-read-google`: 34/34;
- `smoke-google-connect`: 30/30;
- `smoke-reminders`: 23/23;
- `smoke-native-provider-reminders`: 11/11;
- `smoke-voice-dates`: 77/77;
- `smoke-week-lookahead`: unchanged from Plan A (29/29 on top of Plan A as landed; Plan A Task 3's draft said 28/28).

`smoke-reminders` and `smoke-native-provider-reminders` are unchanged files. `smoke-voice-dates` now prints `[calendar-read-google-stamp]` warnings, because the smoke env has no Upstash URL. That is expected, and its count holds.

- [ ] **Step 8: Type-check and lint**

```bash
npx tsc --noEmit -p . && npm run -s lint
```

Expected: both exit 0 with no output. `tsc` also checks `scripts/**`, the new smoke included.

- [ ] **Step 9: Commit**

```bash
git add src/services/calendar-read/google.ts src/services/calendar-provider/google-provider.ts src/services/google-connect.ts scripts/smoke-calendar-read-google-cache.ts
git commit -m "$(cat <<'MSG'
feat(calendar-read): cache the home's Google reads, stamped after every write

The range route reads Google through a short cache: one entry per user,
calendar set, timezone and window, served for 3 minutes, then stale with
one background refresh until 30. An entry counts only while it started
after the user's stamp. Every bot write to Google, a reconnect, and a
cached read that ends in reconnect or calendars_gone move the stamp to now.
Reads in flight are shared on globalThis and only the newest writes.
Redis errors fail open. The summaries keep bypassing the cache.

The stamp has its own Upstash client (one attempt, aborted and raced at
750 ms) and never changes a write's result. It also drops the user's
weekly recurrence answers.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
MSG
)"
```

**Notes for later tasks:**
- **B8:** pass `googleCache: fresh ? 'refresh' : 'use'`, `deadlineMs: 6000` and `defer: after` (from `next/server`) into `readRange`, which hands them to `readGoogle` unchanged. The `fresh=1` limit is enforced here, so the route doesn't check it again. A response that came from a joined read shares its result object with the other request: build the DTO without mutating `items`.
- **Plan C:** the digest adapters pass `googleCache: 'bypass'`, or leave it out. Either way they make no Redis command for Google, and they never stamp: a dead token or a lost calendar set that a summary finds reaches the home at the next stale refresh, within 3 minutes. Spec §2.6's "any read that ends in `reconnect` or `calendars_gone`" stamps means any **cached** read; the spec line should say so.

---

### Task 8 (B8): readRange and GET /api/calendar/range

**What and why.** This task joins the reader's two halves into one entry point and puts the calendar home's only endpoint in front of it.
- `src/services/calendar-read/index.ts` adds `sourcesFor` and `readRange` (spec §2.2-§2.3). They pick the sources, build the local-midnight window (with `notBefore`), run the FamCal and Google halves in parallel and apply the order rules. Plan C's summary adapters call `readRange` as well.
- `app/api/calendar/range/route.ts` is spec §4. It authenticates from the header only and returns 404 `not_enabled` when the switch is off. It works out the facts on the server, validates the window and reads with the route's cache modes and `after()`. It adds the carry-overs, masked, and builds the DTO field by field with `Cache-Control: private, no-store`.
- Edit 10 adds `calendarRateLimiter` (60 a minute, `ratelimit:calendar`).
- Edit 12 makes `execute-command` read init data with `requestInitData(request, body)`, so the header works there too (Plan D's send-to-chat call sends it).

The switch ships `OFF`, so the route answers 404 to everyone. Edit 12 is the only change to live behaviour: a request that sends the header is now accepted. A body `initData` is read as before, but only when it is a non-empty string.

**Interface change (read first):**
- **The route calls B5's `carryOverReadItems(famcal, open.items)`.** It doesn't re-mask the carry-overs itself. The split said "carry-overs via fetchOpenReminderItems with masking". B5 added this helper so the legend and masking rule lives in one place, and its draft asks B8 to use it.
- **`readRange` adds two behaviours the split didn't name:**
  - an empty window (`notBefore` at or after the window's end) throws a `RangeError`. That is always a caller's bug: Plan C's `readLookaheadEvents` always ends after `now`;
  - a half that rejects becomes `{ status: 'error', cause }` (FamCal) or `{ status: 'error', reason: 'unknown', cause }` (Google). So `readRange` itself never rejects because of a half.
- **The route's error bodies** (Plan D reads only the status, plus `not_enabled`):
  - 400 `{ error: 'bad_request', detail }`;
  - 404 `{ error: 'not_enabled' }`;
  - 500 `{ error: 'internal_error' }`.
  `verifyUserAuth`'s own 400/401/403/404/429 answers are unchanged, except that they also get `Cache-Control: private, no-store`.
- **The route logs:**
  - a FamCal `error` as a warning, `calendar-range-famcal`. `famcal.ts` logs nothing, and without this a DB outage on the home would be silent;
  - a carry-over failure as a warning, `calendar-range-carryovers`;
  - a timezone lookup past its 2,000 ms as a warning, `calendar-range-timezone`;
  - a 500 as `calendar-range`, at level error.
  Each context is `{ user_id }` only. Google failures are logged inside `google.ts` (B6).
- **The timezone wait is bounded (a spec decision, for the owner to veto).** Spec §4 says `tz = await resolveUserTimezone(user)`, and the 6 s budget covers only the Google half. On a `tz:user` miss, once a day per user (the resolver's `geocodeCache` is in-process and empties on deploy), a slow Nominatim costs 4 × 5 s plus backoff and the resolver tries again after 2 s: about 48 s. A stuck Google token endpoint in `getUserCalendarTimezone` has no timeout at all. So the route races the lookup against 2,000 ms (`TZ_LOOKUP_MS`). Past that it answers in the fallback zone (`TIMEZONE`, Asia/Jerusalem) with `tzKnown` false, so the week start and Hebrew dates follow the language (Ruling R15), and logs a warning. The lookup carries on and caches its answer as it always does, so the next open gets the real zone; the client drops its store when `tz` changes (§5). The route writes no zone itself. A lookup that fails within the bound is a 500, as before. Smoke #24 pins it.
- Everything else matches the split: `sourcesFor(user)`, `readRange(user, fromKey, toKey, opts: ReadRangeOptions): Promise<RangeRead>`, and `calendarRateLimiter`.

**Findings (read before you start):**
- **Depends on (all land before B8):**
  - Plan A Task 1: `verifyUserAuth` keys the limiter on `` `u${user.id}` ``. The smoke's check #18 relies on it.
  - B1: `isCalendarHomeOn` (`src/services/calendar-read/rollout.ts`).
  - B2: `tzKnownFor`, `weekStartFor` and `hebrewDatesFor` (`src/utils/locale-rules.ts`).
  - B3: the DTO types and `compareItems` (`src/lib/calendar-view/types.ts`), the reader types, and `toRangeDays`, `toCarryOverDto` and `toCalendarDto` (`dto.ts`).
  - B5: `readFamcal` and `carryOverReadItems` (`famcal.ts`), and `fetchOpenReminderItems` (`open-reminders.ts`).
  - B6/B7: `readGoogle(user, window, { tz, calendarIds?, deadlineMs, googleCache?, defer? })`. B6 alone has no `googleCache`/`defer` option, so `index.ts` type-checks only once B7 has widened it.
- **`after()` needs a live request scope.** Outside one it throws "`after` was called outside a request scope". Today `smoke-initdata-header.ts` never loads a route that calls it. Once `execute-command` is in its CASES, the header case answers 500 from that throw. That still passes "not 401/403", but only by accident. So the smoke turns `after` into a no-op, and the case then reaches 200. `smoke-calendar-range.ts` queues `after` tasks, as `smoke-auth-identity.ts:333-337` does.
- **`smoke-initdata-header.ts` now loads the real reader** through the route: B1's rollout, B5's half and B7's Google half. With its in-memory DB the switch reads `OFF`, so the calendar case answers 404 `not_enabled`. That comes after auth, which is all the check needs. An Upstash client built without env only warns, so B7's separate stamp client can't break the import.
- **The two halves are faked in `smoke-calendar-range.ts`.** `readFamcal` and `readGoogle` are recording fakes; their own smokes (B5, B6, B7) cover their behaviour. B5's real `carryOverReadItems` runs, so the carry-over privacy check covers the real masking.
  - The spec's "empty token → reconnect, with no Google call" case: the "no Google call" half is B6's check (smoke-calendar-read-google). Here the route is shown to pass `reconnect` through, with no FamCal read, no FamCal query and no network.
- **"Both halves in parallel"** is a `Promise.all`. In step 1 `sourcesFor` gives each user one source, so no call reaches two halves, and no check covers it.
- **The route's window check:**
  - `to <= addDaysToDate(from, 42)` compares date strings, so 42-day windows across 2026-10-25 (IL) and 2026-11-01 (US) pass;
  - the year check runs before it, so an extreme year never reaches `addDaysToDate`;
  - `isDayKey` checks the strict format and then a round trip, so `2026-02-30` is refused.
- **Next's route export rule:** `route.ts` exports only `GET`, `dynamic` and `runtime`. The helpers are module-private, because `next build` rejects any other export from a route file.
- **No Plan A overlap** in this task's files: Plan A Task 1 changes `src/lib/api-auth.ts` only. Line numbers below are `main@858886c`.
- **Verified in a scratch copy:** `main@858886c` + Plan A Task 1's `api-auth.ts` line, B2's and B3's files from their plans, B5's three files from its plan, and signature stand-ins for B1's `rollout.ts` and B7's `google.ts`.
  - Before: `smoke-calendar-range` exits 1 with `ERR_MODULE_NOT_FOUND`, and `smoke-initdata-header` prints 7/9.
  - With the route but before edit 12: 8/9, with `#4 … POST /api/execute-command -> 401`.
  - After: 24/24 under `TZ=UTC`, `TZ=Asia/Jerusalem` and `TZ=Pacific/Kiritimati`, and 9/9 for the header smoke. The neighbouring smokes exit 0, and `tsc` and lint are clean.
  - #23 (the `famcal_session` cookie) and #24 (a slow timezone lookup) were added in integration. #23 passes on the first route; #24 fails until the route bounds the lookup: with `await resolveUserTimezone(user)` it gives no answer within 4 s.
  - Mutations caught: init data read from the query; carry-overs unmasked; the carry-overs' today guard dropped; a 6-day default; a 43-day limit; `notBefore` ignored; the Google sort removed; `sources` not intersected inside `readRange`; the user row spread into the answer; the timezone lookup awaited with no bound.
- **Say in the PR (switch `OFF`):** nothing users see changes apart from the stamp hook (B7's PR notes say what it does beyond its Redis write). Checked and inert:
  - edit 12 (`execute-command` prefers the `X-Telegram-Init-Data` header) changes nothing today: `DashboardClient.tsx:115` sends `initData` only in the body;
  - the admin route and panel changes are admin-only. One difference: a POST with `calendarHomeRollout: null` now gets a 400 instead of being ignored;
  - the migration adds a column with a default and runs in `build` before `next build`;
  - edits 1, 2 and 9 and the open-reminders refactor are behaviour-neutral: their regression smokes print identical lines before and after;
  - the route answers 404 `not_enabled` to everyone while the switch is `OFF`.
- **Integration check (done by the planner):** the whole chain, Plan A + B1–B8, was applied verbatim to a scratch copy: every smoke passed under both clocks (Kiritimati where named), `smoke-initdata-header` 9/9 against B1's and B7's real code, tsc and lint clean, and `next build` passed in a fresh clone.

**Files:**
- Create: `src/services/calendar-read/index.ts` (lines 1-91)
- Create: `app/api/calendar/range/route.ts` (lines 1-223)
- Modify: `src/lib/rate-limit.ts`, inserting after `:37` (the end of `tokenPollRateLimiter`) (edit 10)
- Modify: `app/api/execute-command/route.ts:5` (an import) and `:17` (the init data read). `:38` keeps passing `initData` (edit 12)
- Modify (test): `scripts/smoke-initdata-header.ts`:
  - `:9-10` (header);
  - `:275` (the limiter stub);
  - after `:298` (`after` as a no-op);
  - `:367` (the CASES comment);
  - after `:390` (two CASES).
- Create (test): `scripts/smoke-calendar-range.ts`
- Test: `scripts/smoke-calendar-range.ts` and `scripts/smoke-initdata-header.ts` under `TZ=UTC`, `TZ=Asia/Jerusalem` and `TZ=Pacific/Kiritimati` (spec §10: Kiritimati for day bucketing; the range smoke covers the default window, `toRangeDays` through the route and the carry-overs' `from ≤ today < to` guard).
- Regression: `smoke-auth-identity`, `smoke-admin-panel-ssr`, `smoke-page-auth`, `smoke-oauth-weather`, `smoke-pairing-accept`, `smoke-google-connect`, `smoke-reminders`, `smoke-native-provider-reminders`, `smoke-calendar-read-famcal`, `smoke-calendar-read-google`, `smoke-calendar-read-google-cache` and `smoke-calendar-home-rollout`. All unchanged.

**Interfaces:**
- Consumes:
  - `verifyUserAuth(request: NextRequest, userId: string | null, initData: string | null | undefined, rateLimiter: Ratelimit, endpointName: string): Promise<AuthResult>` (`src/lib/api-auth.ts`; Plan A keys the bucket `u${user.id}`)
  - `requestInitData(request: Request, body?: unknown): string | undefined` (`src/lib/request-init-data.ts`)
  - `resolveUserTimezone(user): Promise<string>` (`src/lib/timezone.ts:20`) and its fallback zone `TIMEZONE` (`src/config/constants.ts:7`, `'Asia/Jerusalem'`)
  - `isCalendarHomeOn(user: { isAdmin?: boolean | null }): Promise<boolean>` (B1)
  - `tzKnownFor(u)`, `weekStartFor(f: LocaleFacts): WeekStart`, `hebrewDatesFor(f: LocaleFacts): boolean` (B2)
  - `toRangeDays(items, fromKey, toKey, tz, now, today)`, `toCarryOverDto(item, tz, now)`, `toCalendarDto(ref)`; `RangeResponse`, `ItemDTO`, `DayKey`, `SourceName`; `ReadItem`, `ReadRangeOptions`, `FamcalRead`, `GoogleRead`, `RangeRead` (B3)
  - `readFamcal(user, window, { calendarIds? })`, `carryOverReadItems(famcal: Extract<FamcalRead, { status: 'ok' }>, carryOvers: readonly OpenReminderItem[]): ReadItem[]` (B5, `famcal.ts`)
  - `fetchOpenReminderItems(user, ctx, cutoff, summaryDay, timezone, cap): Promise<{ items: OpenReminderItem[]; moreCount: number }>` (B5); `openRemindersCutoff(summaryDay, timezone, now): Date` (`open-reminders.ts`, unchanged)
  - `readGoogle(user, window, opts: { tz: string; calendarIds?: readonly string[]; deadlineMs: number; googleCache?: 'use' | 'refresh' | 'bypass'; defer?: (task: () => Promise<void>) => void }): Promise<{ read: GoogleRead; items: ReadItem[] }>` (B7's public signature)
  - `startOfLocalDay`, `localDate`, `addDaysToDate` (`src/utils/day-events.ts`)
- Produces:
  - `export function sourcesFor(user: Pick<UserConfig, 'calendarSource'>): SourceName[]`: NATIVE → `['famcal']`, GOOGLE → `['google']`
  - `export async function readRange(user: UserConfig, fromKey: DayKey, toKey: DayKey, opts: ReadRangeOptions): Promise<RangeRead>`. It throws a `RangeError` on an empty window and never rejects because of a half. The Google cache default is `'bypass'`.
  - `export const calendarRateLimiter: Ratelimit` (60 per `1 m`, prefix `ratelimit:calendar`)
  - `GET /api/calendar/range`:
    - 200 `RangeResponse`;
    - 400 `{ error: 'bad_request', detail }`;
    - 404 `{ error: 'not_enabled' }`;
    - 500 `{ error: 'internal_error' }`;
    - `verifyUserAuth`'s 400/401/403/404/429;
    - every answer has `Cache-Control: private, no-store`.
  - Plan C's adapters call `readRange(user, day, nextDate(day), { tz, calendarIds: ids, googleCache: 'bypass', deadlineMs })`, and with `notBefore` for This week.


- [ ] **Step 1: Write the failing smoke `scripts/smoke-calendar-range.ts`**

Create the file with exactly this content:

```ts
// Smoke test for the calendar home's range route, GET /api/calendar/range (calendar home
// spec §4), and the reader's entry point readRange (src/services/calendar-read/index.ts,
// §2.2-§2.3). The route answers only users the rollout switch covers, works its facts
// out on the server (timezone, today, week start, Hebrew dates), validates the window,
// reads each applicable source, and answers the days with each source's status. The
// JSON never carries the user row or a masked calendar's real name or id.
//
// The route, readRange, the DTO code, the carry-overs' masking (carryOverReadItems),
// api-auth, telegram-auth, user-service, the timezone resolver and the locale rules run
// for real. Faked at the boundaries: Prisma and Redis (in memory, every Prisma call
// recorded), the rate limiter (records each key), the rollout switch (a variable, with
// B1's rule), the reader's two halves readFamcal and readGoogle (recording fakes; their
// own smokes cover them), the carry-over query fetchOpenReminderItems, error capture,
// Next's after() (queued), and fetch (blocked and recorded; #24 answers or stalls
// Nominatim and Open-Meteo for the timezone resolver). No network, no DB.
//
// Until the route and readRange exist, the smoke stops at their import
// (ERR_MODULE_NOT_FOUND).
//
// Run with the fake env from the task brief (no dotenv), under three clocks (Kiritimati,
// UTC+14, for the day bucketing):
//   TZ=UTC npx tsx scripts/smoke-calendar-range.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-calendar-range.ts
//   TZ=Pacific/Kiritimati npx tsx scripts/smoke-calendar-range.ts

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const ROOT = path.resolve(__dirname, '..');
const nodeRequire = createRequire(__filename);

// Test values, used only when the fake env left them unset.
process.env.TELEGRAM_BOT_TOKEN ||= 'test';
process.env.SESSION_SECRET ||= 'test-session-secret';
process.env.CRON_SECRET ||= 'test-cron';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);

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

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

const show = (value: unknown) => JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v));

function assertSame(got: unknown, want: unknown, label: string) {
  assert(show(got) === show(want), `${label}\n     got  ${show(got)}\n     want ${show(want)}`);
}

// ---- Clock: every argument-less new Date() and Date.now() reads `clock` ----

const RealDate = Date;
let clock = RealDate.parse('2026-10-16T06:00:00Z'); // 09:00 in Israel, 02:00 in New York
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

// ---- Fake Prisma: in-memory rows, equality lookups, every call recorded ----

const DB: Record<string, Row[]> = {};
const prismaCalls: string[] = [];
const same = (a: unknown, b: unknown) =>
  typeof a === 'bigint' || typeof b === 'bigint' ? a != null && b != null && String(a) === String(b) : a === b;
const matches = (row: Row, where: Row = {}) => Object.entries(where).every(([k, v]) => v === undefined || same(row[k] ?? null, v));

function model(name: string): Row {
  const rows = () => (DB[name] ??= []);
  const record = <T>(method: string, fn: (a: Row) => T) => async (a: Row = {}) => {
    prismaCalls.push(`${name}.${method}`);
    return fn(a);
  };
  return new Proxy(
    {
      findUnique: record('findUnique', (a) => rows().find((r) => matches(r, a.where)) ?? null),
      findFirst: record('findFirst', (a) => rows().find((r) => matches(r, a.where)) ?? null),
      findMany: record('findMany', (a) => rows().filter((r) => matches(r, a.where))),
      count: record('count', (a) => rows().filter((r) => matches(r, a.where)).length),
    } as Row,
    { get: (t, p) => (typeof p !== 'string' || p === 'then' ? undefined : t[p] ?? record(p, () => null)) }
  );
}
const models: Record<string, Row> = {};
const fakePrisma: Row = new Proxy({} as Row, {
  get(_t, prop) {
    if (typeof prop !== 'string' || prop === 'then') return undefined;
    if (prop.startsWith('$')) return async () => [];
    return (models[prop] ??= model(prop));
  },
});

// ---- Fake Redis (Upstash parses JSON on read) ----

const redisStore = new Map<string, string>();
const decode = (raw: string | undefined) => {
  if (raw === undefined) return null;
  try { return JSON.parse(raw); } catch { return raw; }
};
const encode = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));
const redisImpl: Row = {
  get: async (k: string) => decode(redisStore.get(k)),
  set: async (k: string, v: unknown, o?: Row) => {
    if (o?.nx && redisStore.has(k)) return null;
    redisStore.set(k, encode(v));
    return 'OK';
  },
  del: async (...ks: unknown[]) => ks.flat().reduce((n: number, k) => n + (redisStore.delete(String(k)) ? 1 : 0), 0),
  mget: async (...ks: unknown[]) => ks.flat().map((k) => decode(redisStore.get(String(k)))),
  expire: async () => 1,
};
const fakeRedis = new Proxy(redisImpl, {
  get: (t, p) => (typeof p !== 'string' || p === 'then' ? undefined : t[p] ?? (async () => null)),
});

// ---- Recorders ----

/** Every limiter key, as "<limiter>:<identifier>". */
const rateChecks: string[] = [];
let rateAllow = true;
/** Every captureError / captureWarning: the context, the severity and the extras. */
const captured: { ctx: string; severity: string; extra: Row | undefined; message: string }[] = [];
/** The rollout switch, and every user the route asked it about. */
let rollout: 'OFF' | 'ADMINS' | 'ALL' = 'ALL';
let rolloutThrows = false;
const rolloutAsked: Row[] = [];
/** The reader halves' and the carry-over query's calls. */
const famcalCalls: { user: Row; window: { from: Date; to: Date }; opts: Row }[] = [];
const googleCalls: { user: Row; window: { from: Date; to: Date }; opts: Row }[] = [];
const carryCalls: { userId: number; ctx: Row; cutoff: Date; summaryDay: string; tz: string; cap: number }[] = [];
let famcalMode: 'ok' | 'error' | 'reject' = 'ok';
let googleMode: 'ok' | 'partialStale' | 'gone' | 'unsorted' | 'reject' = 'ok';
let carryMode: 'ok' | 'throw' = 'ok';
/** What readRange's caller handed after(). */
const afterQueue: (() => unknown)[] = [];
const fetched: string[] = [];

// ---- Boundaries: stubs in require's cache, served to import() by a load hook ----

const Module = nodeRequire('module');
const stubs: Record<string, Row> = {};
(globalThis as Row).__smokeStubs = stubs;
if (typeof Module.registerHooks !== 'function') throw new Error('This smoke needs Node 22.15+ (module.registerHooks)');
Module.registerHooks({
  load(url: string, context: unknown, nextLoad: (u: string, c: unknown) => unknown) {
    const file = url.startsWith('file:') ? fileURLToPath(url.split('?')[0]) : '';
    if (!(file in stubs)) return nextLoad(url, context);
    const names = Object.keys(stubs[file]).filter((n) => n !== 'default' && /^[A-Za-z_$][\w$]*$/.test(n));
    const source = [
      `const s = globalThis.__smokeStubs[${JSON.stringify(file)}];`,
      ...names.map((n) => `export const ${n} = s[${JSON.stringify(n)}];`),
      'export default (s.__esModule ? s.default : s);',
    ].join('\n');
    return { format: 'module', source, shortCircuit: true };
  },
});

function stub(rel: string, exports: Row) {
  const filename = path.join(ROOT, rel);
  stubs[filename] = exports;
  const mod = new Module(filename);
  Object.assign(mod, { filename, loaded: true, exports });
  Module._cache[filename] = mod;
}

const recorder = (): Row =>
  new Proxy({} as Row, { get: (_t, p) => (typeof p !== 'string' || p === 'then' ? undefined : async () => ({ message_id: 1 })) });

// ---- Fixtures ----

const IL = 'Asia/Jerusalem';
const NY = 'America/New_York';
const TG = { tal: 111111111, gil: 222222222, dana: 555555555, omer: 515151515, sus: 606060606, ny: 707070707 };
const PHONE = '+972501234567';
const PAIRING = 'pairing-9-42';
const TOKEN = 'refresh-SECRET-50';
/** The partner's PRIVATE calendar: neither its name nor its id may reach the JSON. */
const PRIVATE_NAME = 'Noa secret plans';
const PRIVATE_ID = 'native:cal-noa-private';
const TITLES = ['Dentist', 'Call the plumber', 'Family dinner', 'Return the library books', 'Water the plants', 'School pickup'];

const OWN = { id: 'native:cal-own', source: 'famcal', name: 'Tal', color: '#039BE5', mine: true, inLegend: true };
const NOA_SHARED = { id: 'native:cal-noa', source: 'famcal', name: 'Noa family', color: '#E67C73', mine: false, ownerName: 'Noa', inLegend: true };
const MASKED = { id: null, source: 'famcal', name: 'Noa', color: null, mine: false, inLegend: false };
const FAMILY = { id: 'family@group.calendar.google.com', source: 'google', name: 'Family', color: '#7986CB', mine: true, inLegend: true };
const SPOUSE = { id: 'dan@example.com', source: 'google', name: 'Dan', color: '#33B679', mine: false, ownerName: 'Dan', inLegend: true };

const PARTNER = { id: 42, name: 'Noa', englishName: '', gender: 'female', calendarSource: 'NATIVE', telegramId: BigInt(TG.gil), language: 'he' };

function baseUser(o: Row): Row {
  return {
    name: 'x', englishName: '', gender: 'male', language: 'en', location: 'Tel Aviv', culture: 'default',
    messagingPlatform: 'telegram', googleRefreshToken: '', calendarAssignments: null, calendarSource: 'NATIVE',
    pairingId: null, remindersEnabled: false, suspendedAt: null, unreachableSince: null, whatsappPhone: null,
    whatsappBsuid: null, telegramId: null, isAdmin: false, globalRules: [], voiceInputEnabled: true,
    textSummaryEnabled: true, voiceSummaryEnabled: false, weatherEnabled: true, locationForced: false,
    createdAt: new RealDate('2026-09-01T00:00:00Z'), updatedAt: new RealDate('2026-10-01T00:00:00Z'),
    ...o,
  };
}

/** A FamCal ReadItem as readFamcal builds one. */
function famcalItem(eventId: string, title: string, start: string, end: string, ref: Row, extra: Row = {}): Row {
  const kind = extra.kind ?? 'event';
  return {
    source: 'famcal',
    key: `famcal|${eventId}`,
    event: {
      summary: title, start, end, calendarName: extra.calendarName ?? ref.name, calendarId: extra.calendarId ?? ref.id,
      eventId, provider: 'native', timeZone: IL,
      ...(kind === 'reminder' ? { eventType: 'reminder', reminder: extra.reminder ?? { ownerIsViewer: true, creatorIsViewer: true } } : {}),
    },
    calendar: ref, title, kind, seriesId: eventId.split('#')[0], originalStart: start, recurring: false, rrule: null,
    ...(kind === 'reminder' ? { state: { doneAt: null, snoozedUntil: null } } : {}),
  };
}

/** Tal (9): today's dentist, the partner's reminder for Tal on her PRIVATE calendar (masked), tomorrow's dinner. */
function talFamcal(): Row[] {
  return [
    famcalItem('ev-dentist', 'Dentist', '2026-10-16T07:00:00.000Z', '2026-10-16T08:00:00.000Z', OWN),
    famcalItem('rem-plumber', 'Call the plumber', '2026-10-16T05:00:00.000Z', '2026-10-16T05:00:00.000Z', MASKED, {
      kind: 'reminder', calendarName: PRIVATE_NAME, calendarId: PRIVATE_ID,
      reminder: { ownerIsViewer: true, creatorIsViewer: false, creatorName: 'Noa' },
    }),
    famcalItem('ev-dinner', 'Family dinner', '2026-10-17T16:00:00.000Z', '2026-10-17T18:00:00.000Z', NOA_SHARED),
  ];
}

/** Tal's carry-overs as fetchOpenReminderItems answers them: newest first. */
function talCarryOvers(): Row[] {
  return [
    {
      event: {
        summary: 'Return the library books', start: '2026-10-15T06:00:00.000Z', end: '2026-10-15T06:00:00.000Z',
        calendarName: PRIVATE_NAME, calendarId: PRIVATE_ID, eventType: 'reminder', eventId: 'ser-lib', provider: 'native', timeZone: IL,
        reminder: { ownerIsViewer: true, creatorIsViewer: false, creatorName: 'Noa', openSince: '2026-10-15' },
      },
      series: { id: 'ser-lib', kind: 'REMINDER', rrule: null },
      calendar: { id: 'cal-noa-private', name: PRIVATE_NAME },
      instanceStartsAt: new RealDate('2026-10-15T06:00:00.000Z'),
    },
    {
      event: {
        summary: 'Water the plants', start: '2026-10-14T05:00:00.000Z', end: '2026-10-14T05:00:00.000Z',
        calendarName: 'Tal', calendarId: 'native:cal-own', eventType: 'reminder', eventId: 'ser-water#2026-10-14T05:00:00.000Z',
        recurringEventId: 'ser-water', instanceStartsAt: '2026-10-14T05:00:00.000Z', provider: 'native', timeZone: IL,
        reminder: { ownerIsViewer: true, creatorIsViewer: true, snoozed: true, openSince: '2026-10-14' },
      },
      series: { id: 'ser-water', kind: 'REMINDER', rrule: 'FREQ=DAILY' },
      calendar: { id: 'cal-own', name: 'Tal' },
      instanceStartsAt: new RealDate('2026-10-14T05:00:00.000Z'),
      state: { originalStartsAt: new RealDate('2026-10-14T05:00:00.000Z'), doneAt: null, snoozedUntil: new RealDate('2026-10-16T12:00:00.000Z') },
    },
  ];
}

function googleItem(calendar: Row, id: string, title: string, start: string, end: string): Row {
  return {
    source: 'google', key: `google|${calendar.id}|${id}`,
    event: { summary: title, start, end, calendarName: calendar.name, calendarId: calendar.id, eventType: 'default', eventId: id, provider: 'google' },
    calendar, title, kind: 'event', seriesId: null, originalStart: null, recurring: false, rrule: null,
    google: { birthday: false, htmlLink: null },
  };
}

function seed() {
  for (const k of Object.keys(DB)) delete DB[k];
  redisStore.clear();
  for (const list of [prismaCalls, rateChecks, captured, rolloutAsked, famcalCalls, googleCalls, carryCalls, afterQueue, fetched] as unknown[][]) list.length = 0;
  clock = RealDate.parse('2026-10-16T06:00:00Z');
  rateAllow = true;
  rollout = 'ALL';
  rolloutThrows = false;
  famcalMode = 'ok';
  googleMode = 'ok';
  carryMode = 'ok';
  const { encrypt } = nodeRequire(path.join(ROOT, 'src/utils/encryption.ts'));
  DB.user = [
    baseUser({ id: 9, name: 'Tal', telegramId: BigInt(TG.tal), isAdmin: true, language: 'he', pairingId: PAIRING, whatsappPhone: PHONE }),
    baseUser({ id: 42, name: 'Noa', telegramId: BigInt(TG.gil), language: 'ru', location: 'Moscow', pairingId: PAIRING }),
    baseUser({
      id: 50, name: 'Dana', telegramId: BigInt(TG.dana), isAdmin: true, location: '', calendarSource: 'GOOGLE',
      googleRefreshToken: encrypt(TOKEN),
      calendarAssignments: [
        { calendarId: FAMILY.id, labels: ['yours'], name: 'Family', color: '#7986CB' },
        { calendarId: SPOUSE.id, labels: ['spouse'], name: 'Dan', color: '#33B679', personName: 'Dan' },
      ],
    }),
    baseUser({ id: 51, name: 'Omer', telegramId: BigInt(TG.omer), isAdmin: true, calendarSource: 'GOOGLE' }),
    baseUser({ id: 60, name: 'Sus', telegramId: BigInt(TG.sus), isAdmin: true, suspendedAt: new RealDate('2026-10-10T00:00:00Z') }),
    baseUser({ id: 70, name: 'Ny', telegramId: BigInt(TG.ny), isAdmin: true, location: 'New York' }),
  ];
  for (const [id, tz] of [[9, IL], [42, 'Europe/Moscow'], [50, NY], [51, IL], [60, IL], [70, NY]] as const) {
    redisStore.set(`tz:user:${id}`, tz);
  }
}

function installStubs() {
  stub('src/utils/prisma.ts', { prisma: fakePrisma, withRetry: (fn: () => unknown) => fn() });
  stub('src/utils/redis.ts', { redis: fakeRedis });
  const capture = (severityOf: (args: unknown[]) => string) => (e: unknown, ctx: string, extra?: Row, ...rest: unknown[]) => {
    captured.push({ ctx, severity: severityOf(rest), extra, message: e instanceof Error ? e.message : String(e) });
  };
  stub('src/lib/error-capture.ts', {
    captureError: capture((rest) => String(rest[0] ?? 'error')),
    captureWarning: capture(() => 'warning'),
    captureInfo: () => undefined,
  });
  const telegram = { getBot: () => recorder(), initBot: () => recorder(), getMessagingService: () => recorder(), setUserMenuButton: async () => undefined };
  stub('src/services/telegram/index.ts', telegram);
  stub('src/services/telegram/bot.ts', telegram);
  const messaging = {
    ...nodeRequire(path.join(ROOT, 'src/services/messaging/types.ts')),
    getMessagingService: () => recorder(), getTelegramService: () => recorder(), getWhatsAppService: () => recorder(),
    detectPlatform: () => 'telegram',
  };
  stub('src/services/messaging/index.ts', messaging);
  stub('src/services/messaging/factory.ts', messaging);

  stub('src/lib/rate-limit.ts', {
    calendarRateLimiter: { name: 'calendar' },
    commandRateLimiter: { name: 'command' },
    settingsRateLimiter: { name: 'settings' },
    generalRateLimiter: { name: 'general' },
    tokenPollRateLimiter: { name: 'token-poll' },
    // The real checkRateLimit hands String(identifier) to limiter.limit(): record that key.
    checkRateLimit: async (limiter: Row, identifier: string | number) => {
      rateChecks.push(`${limiter?.name}:${String(identifier)}`);
      return rateAllow ? { success: true, remaining: 59, reset: 0 } : { success: false, remaining: 0, reset: 0 };
    },
    getRateLimitHeaders: () => ({}),
  });

  // B1's rule, on a variable: ALL, or ADMINS and an admin.
  stub('src/services/calendar-read/rollout.ts', {
    getCalendarHomeRollout: async () => rollout,
    isCalendarHomeOn: async (user: Row) => {
      rolloutAsked.push(user);
      if (rolloutThrows) throw new Error('rollout store exploded');
      return rollout === 'ALL' || (rollout === 'ADMINS' && user.isAdmin === true);
    },
    setCalendarHomeRollout: async () => true,
    isCalendarHomeRolloutValue: (v: unknown) => v === 'OFF' || v === 'ADMINS' || v === 'ALL',
  });

  // readFamcal is faked; carryOverReadItems (the carry-overs' masking) is the real one.
  const famcalHalf = nodeRequire(path.join(ROOT, 'src/services/calendar-read/famcal.ts'));
  stub('src/services/calendar-read/famcal.ts', {
    ...famcalHalf,
    readFamcal: async (user: Row, window: { from: Date; to: Date }, opts: Row) => {
      famcalCalls.push({ user, window, opts });
      if (famcalMode === 'reject') throw new Error('famcal half rejected');
      if (famcalMode === 'error') return { read: { status: 'error', cause: new Error('db down') }, items: [] };
      const tal = user.id === 9;
      return {
        read: {
          status: 'ok',
          ctx: { viewerId: user.id, partner: tal ? PARTNER : null },
          calendars: tal ? [OWN, NOA_SHARED] : [{ ...OWN, name: user.name }],
          partner: tal ? { name: 'Noa' } : null,
        },
        items: tal ? talFamcal() : [famcalItem('ev-solo', 'Dentist', '2026-10-16T07:00:00.000Z', '2026-10-16T08:00:00.000Z', OWN), { ...famcalItem('ev-nostart', 'Dentist', '', '', OWN) }],
      };
    },
  });

  stub('src/services/calendar-read/google.ts', {
    readGoogle: async (user: Row, window: { from: Date; to: Date }, opts: Row) => {
      googleCalls.push({ user, window, opts });
      // B6's first rule: an empty token is reconnect('token'), with no Google call.
      if (!user.googleRefreshToken) return { read: { status: 'reconnect', reason: 'token' }, items: [] };
      if (googleMode === 'reject') throw new Error('google half rejected');
      if (googleMode === 'gone') return { read: { status: 'error', reason: 'calendars_gone' }, items: [] };
      if (googleMode === 'partialStale') {
        opts.defer?.(async () => { fetched.push('background refresh ran'); });
        return {
          read: { status: 'ok', calendars: [FAMILY, { ...SPOUSE, unavailable: true }], goneIds: [SPOUSE.id], partial: { failed: 1, truncated: 0 }, stale: true },
          items: [googleItem(FAMILY, 'g-pickup', 'School pickup', '2026-10-16T15:00:00-04:00', '2026-10-16T15:30:00-04:00')],
        };
      }
      const items =
        googleMode === 'unsorted'
          ? [
              googleItem(FAMILY, 'g-late', 'Late', '2026-10-16T18:00:00-04:00', '2026-10-16T19:00:00-04:00'),
              googleItem(FAMILY, 'g-a', 'Same A', '2026-10-16T09:00:00-04:00', '2026-10-16T10:00:00-04:00'),
              googleItem(SPOUSE, 'g-b', 'Same B', '2026-10-16T13:00:00Z', '2026-10-16T14:00:00Z'),
              { ...googleItem(SPOUSE, 'g-nostart', 'No start', '', '') },
              googleItem(SPOUSE, 'g-allday', 'All day', '2026-10-16', '2026-10-17'),
            ]
          : [googleItem(FAMILY, 'g-pickup', 'School pickup', '2026-10-16T15:00:00-04:00', '2026-10-16T15:30:00-04:00')];
      return { read: { status: 'ok', calendars: [FAMILY, SPOUSE], goneIds: [], partial: null, stale: false }, items };
    },
    stampGoogleCache: async () => undefined,
  });

  // The carry-over query is faked; everything else in open-reminders.ts is the real one.
  const openReminders = nodeRequire(path.join(ROOT, 'src/services/native-reminders/open-reminders.ts'));
  stub('src/services/native-reminders/open-reminders.ts', {
    ...openReminders,
    fetchOpenReminderItems: async (user: Row, ctx: Row, cutoff: Date, summaryDay: string, tz: string, cap: number) => {
      carryCalls.push({ userId: user.id, ctx, cutoff, summaryDay, tz, cap });
      if (carryMode === 'throw') throw new Error('carry-over query failed');
      return user.id === 9 ? { items: talCarryOvers(), moreCount: 0 } : { items: [], moreCount: 0 };
    },
  });

  // Next's after() needs a live request scope; queue the task instead.
  const nextServer = nodeRequire('next/server');
  nextServer.after = (task: unknown) => {
    afterQueue.push(typeof task === 'function' ? (task as () => unknown) : () => task);
  };

  globalThis.fetch = (async (input: unknown) => {
    fetched.push(String(input instanceof Request ? input.url : input));
    throw new Error(`network blocked in smoke: ${String(input)}`);
  }) as typeof fetch;
}

/** Valid Telegram initData for a Telegram user id, signed with the bot token, dated by the clock. */
function initDataFor(tgId: number): string {
  const params: Record<string, string> = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: 'AAH-smoke',
    user: JSON.stringify({ id: tgId, first_name: 'Test' }),
  };
  const checkString = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(process.env.TELEGRAM_BOT_TOKEN ?? '').digest();
  const hash = crypto.createHmac('sha256', secret).update(checkString).digest('hex');
  return [...Object.entries(params), ['hash', hash]].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

const load = (rel: string): Promise<Row> => import(path.join(ROOT, rel));

async function main() {
  installStubs();
  seed();
  const { NextRequest } = nodeRequire('next/server');
  const { startOfLocalDay } = nodeRequire(path.join(ROOT, 'src/utils/day-events.ts'));
  const { openRemindersCutoff } = nodeRequire(path.join(ROOT, 'src/services/native-reminders/open-reminders.ts'));

  // The route logs refused attempts; keep the output to the results.
  const quiet = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  Object.assign(console, { log: () => {}, warn: () => {}, error: () => {}, info: () => {} });

  const route = await load('app/api/calendar/range/route.ts');
  const reader = await load('src/services/calendar-read/index.ts');

  type Call = { tg?: number; userId?: string; header?: boolean; queryInitData?: boolean; cookie?: string };
  /** GET the route as Telegram user `tg` (the header by default, a Cookie header too when given) with a query string. */
  const get = async (qs: string, o: Call = {}): Promise<{ status: number; body: Row; text: string; res: Response }> => {
    const tg = o.tg ?? TG.tal;
    const userId = o.userId ?? String(tg);
    const initQuery = o.queryInitData ? `&initData=${encodeURIComponent(initDataFor(tg))}` : '';
    const url = `http://localhost/api/calendar/range?user_id=${userId}${qs ? `&${qs}` : ''}${initQuery}`;
    const headers: Record<string, string> = o.header === false ? {} : { 'x-telegram-init-data': initDataFor(tg) };
    if (o.cookie) headers.cookie = o.cookie;
    const res: Response = await route.GET(new NextRequest(url, { headers }));
    const text = await res.clone().text();
    let body: Row = {};
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body, text, res };
  };
  const dates = (body: Row) => (body.days ?? []).map((d: Row) => d.date);
  const keysOn = (body: Row, date: string) => ((body.days ?? []).find((d: Row) => d.date === date)?.items ?? []).map((i: Row) => i.key);
  const iso = (d: Date) => new RealDate(d.getTime()).toISOString();

  await check('#1 401 without the header, and with valid init data in the query only; nothing is read', async () => {
    seed();
    const none = await get('', { header: false });
    const inQuery = await get('', { header: false, queryInitData: true });
    assert(none.status === 401 && inQuery.status === 401, `no header ${none.status}, query ${inQuery.status} ${inQuery.text}`);
    assert(none.res.headers.get('cache-control') === 'private, no-store', `401 cache-control: ${none.res.headers.get('cache-control')}`);
    assert(famcalCalls.length + googleCalls.length + rolloutAsked.length + rateChecks.length === 0, 'a refused request read or counted');
  });

  await check('#2 403 for a suspended user', async () => {
    seed();
    const r = await get('', { tg: TG.sus });
    assert(r.status === 403, `status ${r.status} ${r.text}`);
    assert(famcalCalls.length === 0, 'a suspended user was read');
  });

  await check('#3 429 when the limiter says no, with no store and no read', async () => {
    seed();
    rateAllow = false;
    const r = await get('');
    assert(r.status === 429, `status ${r.status} ${r.text}`);
    assert(r.res.headers.get('cache-control') === 'private, no-store', `cache-control: ${r.res.headers.get('cache-control')}`);
    assert(famcalCalls.length === 0 && rolloutAsked.length === 0, 'read after a 429');
  });

  await check('#4 404 not_enabled with the switch OFF, and for a non-admin under ADMINS; admins under ADMINS and everyone under ALL get 200', async () => {
    seed();
    const got: Row = {};
    rollout = 'OFF';
    got.offAdmin = await get('', { tg: TG.tal });
    rollout = 'ADMINS';
    got.adminsUser = await get('', { tg: TG.gil });
    got.adminsAdmin = await get('', { tg: TG.tal });
    rollout = 'ALL';
    got.allUser = await get('', { tg: TG.gil });
    const statuses = Object.fromEntries(Object.entries(got).map(([k, v]) => [k, v.status]));
    assertSame(statuses, { offAdmin: 404, adminsUser: 404, adminsAdmin: 200, allUser: 200 }, 'statuses');
    assertSame(got.offAdmin.body, { error: 'not_enabled' }, 'OFF body');
    assertSame(got.adminsUser.body, { error: 'not_enabled' }, 'ADMINS non-admin body');
    assertSame(rolloutAsked.map((u) => [u.id, u.isAdmin]), [[9, true], [42, false], [9, true], [42, false]], 'the switch is asked with the DB row');
    assertSame(famcalCalls.map((c) => c.user.id), [9, 42], 'only enabled requests read');
  });

  await check('#5 400 for a bad window or source, before any read', async () => {
    seed();
    const bad = [
      'from=2026-02-30&to=2026-03-02', 'from=2026-1-05&to=2026-01-09', 'from=tomorrow&to=2026-10-20', 'from=2026-10-16',
      'to=2026-10-20', 'from=2026-10-16&to=2026-10-16', 'from=2026-10-20&to=2026-10-16', 'from=2026-10-01&to=2026-11-13',
      'from=2020-01-01&to=2020-01-10', 'from=2031-12-20&to=2032-01-02', 'sources=outlook', 'sources=famcal,', 'sources=',
    ];
    const wrong: string[] = [];
    for (const qs of bad) {
      const r = await get(qs);
      if (r.status !== 400 || r.body.error !== 'bad_request') wrong.push(`${qs} -> ${r.status} ${r.text}`);
    }
    assert(wrong.length === 0, wrong.join('; '));
    assert(famcalCalls.length === 0, `read on a 400: ${famcalCalls.length}`);
    const edge = await get('from=2031-12-01&to=2031-12-10');
    assert(edge.status === 200, `5 years away is allowed: ${edge.status} ${edge.text}`);
  });

  await check('#6 200 for 42-day windows across 2026-10-25 in Israel and 2026-11-01 in New York, with local-midnight windows', async () => {
    seed();
    const il = await get('from=2026-10-01&to=2026-11-12', { tg: TG.tal });
    const ny = await get('from=2026-10-15&to=2026-11-26', { tg: TG.ny });
    assert(il.status === 200 && ny.status === 200, `statuses ${il.status} ${ny.status} ${il.text.slice(0, 200)}`);
    assert(dates(il.body).length === 42 && dates(il.body)[0] === '2026-10-01' && dates(il.body)[41] === '2026-11-11', `IL days ${show(dates(il.body))}`);
    assert(dates(ny.body).length === 42 && dates(ny.body)[0] === '2026-10-15' && dates(ny.body)[41] === '2026-11-25', `NY days ${show(dates(ny.body))}`);
    assertSame(famcalCalls.map((c) => [iso(c.window.from), iso(c.window.to)]), [
      ['2026-09-30T21:00:00.000Z', '2026-11-11T22:00:00.000Z'],
      ['2026-10-15T04:00:00.000Z', '2026-11-26T05:00:00.000Z'],
    ], 'windows');
    assert(il.body.from === '2026-10-01' && il.body.to === '2026-11-12', `IL from/to ${il.body.from} ${il.body.to}`);
  });

  await check('#7 the default window is [today, today+7) in the user\'s timezone: at 23:30 UTC an Israeli user is on the next day', async () => {
    seed();
    clock = RealDate.parse('2026-10-16T23:30:00Z');
    const il = await get('', { tg: TG.tal });
    const ny = await get('', { tg: TG.ny });
    assertSame([il.body.today, il.body.from, il.body.to, dates(il.body).length], ['2026-10-17', '2026-10-17', '2026-10-24', 7], 'Israel');
    assertSame([ny.body.today, ny.body.from, ny.body.to, dates(ny.body).length], ['2026-10-16', '2026-10-16', '2026-10-23', 7], 'New York');
    assertSame(famcalCalls.map((c) => iso(c.window.from)), ['2026-10-16T21:00:00.000Z', '2026-10-16T04:00:00.000Z'], 'window starts');
  });

  await check('#8 the facts come from the server: timezone, week start and Hebrew dates (a tz in the query is ignored)', async () => {
    seed();
    const tal = await get('tz=UTC', { tg: TG.tal }); // he, Israel
    const noa = await get('', { tg: TG.gil }); // ru, Moscow
    const dana = await get('', { tg: TG.dana }); // en, New York, known through her Google token
    const pick = (b: Row) => [b.tz, b.weekStart, b.hebrewDates];
    assertSame([pick(tal.body), pick(noa.body), pick(dana.body)], [[IL, 0, true], ['Europe/Moscow', 1, false], [NY, 0, false]], 'facts');
  });

  await check('#9 sources: a FamCal user has no google key; requested-but-not-applicable reads nothing; applicable-but-not-requested is pending', async () => {
    seed();
    const famcalUser = await get('', { tg: TG.tal });
    const famcalOnlyGoogle = await get('sources=google', { tg: TG.tal });
    const googleOnlyFamcal = await get('sources=famcal', { tg: TG.dana });
    const both = await get('sources=famcal,google', { tg: TG.dana });
    assertSame(famcalUser.body.sources, { famcal: { status: 'ok' } }, 'FamCal user');
    assertSame(famcalOnlyGoogle.body.sources, { famcal: { status: 'pending' } }, 'FamCal user on sources=google');
    assert(!('carryOvers' in famcalOnlyGoogle.body), 'carry-overs without a FamCal read');
    assertSame(googleOnlyFamcal.body.sources, { google: { status: 'pending' } }, 'Google user on sources=famcal');
    assertSame(both.body.sources, { google: { status: 'ok' } }, 'Google user on both');
    assertSame([famcalCalls.map((c) => c.user.id), googleCalls.map((c) => c.user.id)], [[9], [50]], 'reads');
    assert(famcalCalls[0].opts.calendarIds === undefined, `calendarIds from the route: ${show(famcalCalls[0].opts)}`);
  });

  await check('#10 a Google user with an empty token gets reconnect, with no FamCal read, no FamCal query and no network', async () => {
    seed();
    const r = await get('sources=google', { tg: TG.omer });
    assert(r.status === 200, `status ${r.status} ${r.text}`);
    assertSame(r.body.sources, { google: { status: 'reconnect', reason: 'token' } }, 'sources');
    assertSame([r.body.calendars, r.body.partner, 'carryOvers' in r.body], [[], null, false], 'legend, partner, carry-overs');
    assert(famcalCalls.length === 0 && carryCalls.length === 0, 'FamCal read for a Google user');
    assert(prismaCalls.every((c) => c.startsWith('user.')), `queries: ${show(prismaCalls)}`);
    assert(fetched.length === 0, `network: ${show(fetched)}`);
  });

  await check('#11 the Google read: cache "use" (fresh=1 "refresh"), 6,000 ms, the user\'s tz, after() as defer; partial, stale and unavailable carried', async () => {
    seed();
    googleMode = 'partialStale';
    const r = await get('', { tg: TG.dana });
    await get('fresh=1', { tg: TG.dana });
    await get('fresh=0', { tg: TG.dana });
    assertSame(googleCalls.map((c) => [c.opts.googleCache, c.opts.deadlineMs, c.opts.tz, c.opts.calendarIds, typeof c.opts.defer]), [
      ['use', 6000, NY, undefined, 'function'], ['refresh', 6000, NY, undefined, 'function'], ['use', 6000, NY, undefined, 'function'],
    ], 'readGoogle options');
    assertSame(r.body.sources, { google: { status: 'ok', partial: { failed: 1, truncated: 0 }, stale: true } }, 'sources');
    assertSame(r.body.calendars, [
      { id: FAMILY.id, source: 'google', name: 'Family', color: '#7986CB', mine: true },
      { id: SPOUSE.id, source: 'google', name: 'Dan', color: '#33B679', mine: false, ownerName: 'Dan', unavailable: true },
    ], 'legend');
    assertSame(keysOn(r.body, '2026-10-16'), [`google|${FAMILY.id}|g-pickup`], 'today');
    const item = r.body.days[0].items[0];
    assertSame([item.readOnly, item.start, item.tz, item.birthday], [true, '2026-10-16T15:00:00-04:00', null, false], 'Google item');
    assert(afterQueue.length === 3, `after() got ${afterQueue.length} tasks`);
    await afterQueue[0]();
    assert(fetched.includes('background refresh ran'), 'the deferred refresh did not run');
  });

  await check('#12 Google errors keep their reason; a FamCal error is reported and leaves the days unanswered', async () => {
    seed();
    googleMode = 'gone';
    const gone = await get('', { tg: TG.dana });
    famcalMode = 'error';
    const down = await get('', { tg: TG.tal });
    assertSame([gone.status, gone.body.sources, gone.body.calendars], [200, { google: { status: 'error', reason: 'calendars_gone' } }, []], 'calendars_gone');
    assertSame([down.status, down.body.sources, down.body.partner, 'carryOvers' in down.body], [200, { famcal: { status: 'error' } }, null, false], 'FamCal error');
    assert(down.body.days.every((d: Row) => d.items.length === 0) && down.body.days.length === 7, `days ${show(down.body.days)}`);
    assertSame(captured.map((c) => [c.ctx, c.severity, c.extra]), [['calendar-range-famcal', 'warning', { user_id: 9 }]], 'captured');
    assert(carryCalls.length === 0, 'carry-overs read after a FamCal error');
  });

  await check('#13 the days: every day in the window, daySpanOf placement, today\'s past-due reminder open, the legend and the partner', async () => {
    seed();
    const r = await get('', { tg: TG.tal });
    assertSame(dates(r.body), ['2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22'], 'dates');
    assertSame(keysOn(r.body, '2026-10-16'), ['famcal|rem-plumber', 'famcal|ev-dentist'], 'today');
    assertSame(keysOn(r.body, '2026-10-17'), ['famcal|ev-dinner'], 'tomorrow');
    const plumber = r.body.days[0].items[0];
    assertSame([plumber.reminder.open, plumber.reminder.creatorName, plumber.calendar], [true, 'Noa', { id: null, name: 'Noa', color: null, mine: false, inLegend: false }], 'masked reminder');
    assertSame(r.body.partner, { name: 'Noa' }, 'partner');
    assertSame(r.body.calendars.map((c: Row) => c.id), ['native:cal-own', 'native:cal-noa'], 'legend');
  });

  await check('#14 carry-overs for a window holding today: all of them (cap Infinity) at today\'s cutoff, open, openSince, the occurrence as originalStart, masked by the legend rule', async () => {
    seed();
    const r = await get('', { tg: TG.tal });
    const now = new RealDate(clock);
    assertSame(carryCalls.map((c) => [c.userId, c.summaryDay, c.tz, c.cap, iso(c.cutoff), c.ctx.partner?.name]), [
      [9, '2026-10-16', IL, Infinity, iso(openRemindersCutoff('2026-10-16', IL, now)), 'Noa'],
    ], 'fetchOpenReminderItems arguments');
    const got = (r.body.carryOvers ?? []).map((c: Row) => [
      c.key, c.reminder.open, c.reminder.openSince, c.originalStart, c.calendar.id, c.calendar.name, c.repeatsDaily, c.reminder.snoozedUntil,
    ]);
    assertSame(got, [
      ['famcal|ser-lib', true, '2026-10-15', '2026-10-15T06:00:00.000Z', null, 'Noa', false, null],
      ['famcal|ser-water#2026-10-14T05:00:00.000Z', true, '2026-10-14', '2026-10-14T05:00:00.000Z', 'native:cal-own', 'Tal', true, '2026-10-16T12:00:00.000Z'],
    ], 'carry-overs');
  });

  await check('#15 no carry-overs for a window without today; a failed carry-over query costs only the card', async () => {
    seed();
    const later = await get('from=2026-10-17&to=2026-10-24', { tg: TG.tal });
    const past = await get('from=2026-10-09&to=2026-10-16', { tg: TG.tal });
    const lastDay = await get('from=2026-10-10&to=2026-10-17', { tg: TG.tal });
    assertSame(['carryOvers' in later.body, 'carryOvers' in past.body, (lastDay.body.carryOvers ?? []).length], [false, false, 2], 'carry-overs by window');
    carryMode = 'throw';
    const failed = await get('', { tg: TG.tal });
    assert(failed.status === 200 && !('carryOvers' in failed.body) && failed.body.days.length === 7, `failed: ${failed.status} ${failed.text.slice(0, 200)}`);
    assertSame(captured.map((c) => [c.ctx, c.severity, c.extra]), [['calendar-range-carryovers', 'warning', { user_id: 9 }]], 'captured');
  });

  await check('#16 privacy: no private calendar name or id, no token, phone, pairing or Telegram id in the JSON; private, no-store on every answer', async () => {
    seed();
    const answers = [
      await get('', { tg: TG.tal }),
      await get('from=2026-10-10&to=2026-10-17', { tg: TG.tal }),
      await get('', { tg: TG.dana }),
      await get('from=bad&to=2026-10-20', { tg: TG.tal }),
    ];
    rollout = 'OFF';
    answers.push(await get('', { tg: TG.tal }));
    const forbidden = [PRIVATE_NAME, PRIVATE_ID, 'cal-noa-private', 'googleRefreshToken', TOKEN, PHONE, 'whatsappPhone', 'pairingId', PAIRING, String(TG.tal), String(TG.dana), 'telegramId'];
    const leaks = answers.flatMap((a, i) => forbidden.filter((f) => a.text.includes(f)).map((f) => `answer ${i}: ${f}`));
    assert(leaks.length === 0, leaks.join('; '));
    assert(answers[0].text.includes('Call the plumber') && answers[1].text.includes('Return the library books'), 'the fixtures were not in the answers');
    const cc = answers.map((a) => [a.status, a.res.headers.get('cache-control')]);
    assertSame(cc, [[200, 'private, no-store'], [200, 'private, no-store'], [200, 'private, no-store'], [400, 'private, no-store'], [404, 'private, no-store']], 'cache-control');
  });

  await check('#17 an unexpected error is a 500 with only the user id in the capture context; no capture anywhere names a title', async () => {
    seed();
    rolloutThrows = true;
    const r = await get('', { tg: TG.tal });
    assertSame([r.status, r.body], [500, { error: 'internal_error' }], 'answer');
    assertSame(captured.map((c) => [c.ctx, c.severity, c.extra]), [['calendar-range', 'error', { user_id: 9 }]], 'captured');
    rolloutThrows = false;
    famcalMode = 'error';
    await get('', { tg: TG.tal });
    famcalMode = 'ok';
    carryMode = 'throw';
    await get('', { tg: TG.tal });
    const named = captured.filter((c) => TITLES.some((t) => show(c.extra).includes(t) || c.message.includes(t)));
    assert(named.length === 0, `titles in captures: ${show(named)}`);
  });

  await check('#18 the rate-limit bucket is the calendar limiter keyed u<id>: "111111111" and "0111111111" share it', async () => {
    seed();
    await get('', { tg: TG.tal, userId: '111111111' });
    await get('', { tg: TG.tal, userId: '0111111111' });
    await get('', { tg: TG.tal, userId: '9' });
    assertSame(rateChecks, ['calendar:u9', 'calendar:u9', 'calendar:u9'], 'limiter keys');
  });

  await check('#19 calendarRateLimiter: 60 a minute under the prefix ratelimit:calendar', () => {
    // A fresh copy of the real module, beside the stub the route uses.
    const file = path.join(ROOT, 'src/lib/rate-limit.ts');
    const source = fs.readFileSync(file, 'utf8');
    const block = source.match(/export const calendarRateLimiter = new Ratelimit\(\{([\s\S]*?)\}\);/)?.[1] ?? '(not found)';
    assert(/limiter:\s*Ratelimit\.slidingWindow\(60,\s*'1 m'\)/.test(block), `limiter: ${block}`);
    const stubbed = Module._cache[file];
    delete Module._cache[file];
    try {
      const real = nodeRequire(file);
      assert(real.calendarRateLimiter?.prefix === 'ratelimit:calendar', `prefix ${real.calendarRateLimiter?.prefix}`);
    } finally {
      Module._cache[file] = stubbed;
    }
  });

  await check('#20 readRange: the local-midnight window, notBefore, Chile\'s midnight DST, and an empty window throws', async () => {
    seed();
    const tal = DB.user.find((u) => u.id === 9);
    const user = { ...tal, telegramId: TG.tal };
    const opts = { tz: IL, deadlineMs: 1000 };
    const plain = await reader.readRange(user, '2026-10-16', '2026-10-18', opts);
    const later = await reader.readRange(user, '2026-10-16', '2026-10-18', { ...opts, notBefore: new RealDate('2026-10-16T06:00:00Z') });
    const earlier = await reader.readRange(user, '2026-10-16', '2026-10-18', { ...opts, notBefore: new RealDate('2026-10-15T06:00:00Z') });
    const chile = await reader.readRange(user, '2026-09-06', '2026-09-07', { ...opts, tz: 'America/Santiago' });
    const win = (r: Row) => [iso(r.window.from), iso(r.window.to)];
    assertSame([win(plain), win(later), win(earlier), win(chile)], [
      ['2026-10-15T21:00:00.000Z', '2026-10-17T21:00:00.000Z'],
      ['2026-10-16T06:00:00.000Z', '2026-10-17T21:00:00.000Z'],
      ['2026-10-15T21:00:00.000Z', '2026-10-17T21:00:00.000Z'],
      [iso(startOfLocalDay('2026-09-06', 'America/Santiago')), '2026-09-07T03:00:00.000Z'],
    ], 'windows');
    assert(iso(chile.window.from) === '2026-09-06T04:00:00.000Z', `Chile's day starts at 01:00 local: ${iso(chile.window.from)}`);
    assertSame(famcalCalls.map((c) => iso(c.window.from)), [win(plain)[0], win(later)[0], win(earlier)[0], win(chile)[0]], 'the halves get the window');
    let threw = '';
    try {
      await reader.readRange(user, '2026-10-16', '2026-10-17', { ...opts, notBefore: new RealDate('2026-10-16T21:00:00Z') });
    } catch (err) {
      threw = err instanceof RangeError ? 'RangeError' : String(err);
    }
    assert(threw === 'RangeError', `empty window: ${threw || 'no throw'}`);
  });

  await check('#21 readRange: sources intersect sourcesFor; calendarIds and the cache default reach the halves; FamCal then Google order; no start dropped', async () => {
    seed();
    const toUser = (id: number) => ({ ...DB.user.find((u) => u.id === id), telegramId: null });
    assertSame([reader.sourcesFor({ calendarSource: 'NATIVE' }), reader.sourcesFor({ calendarSource: 'GOOGLE' })], [['famcal'], ['google']], 'sourcesFor');
    const none = await reader.readRange(toUser(9), '2026-10-16', '2026-10-17', { tz: IL, deadlineMs: 1000, sources: ['google'] });
    assertSame([Object.keys(none).sort(), none.items.length, famcalCalls.length, googleCalls.length], [['items', 'window'], 0, 0, 0], 'FamCal user, sources [google]');
    const solo = await reader.readRange(toUser(42), '2026-10-16', '2026-10-17', { tz: IL, deadlineMs: 1000, calendarIds: ['native:cal-own'] });
    assertSame([solo.items.map((i: Row) => i.key), famcalCalls[0].opts.calendarIds], [['famcal|ev-solo'], ['native:cal-own']], 'no-start item dropped; calendarIds passed');
    googleMode = 'unsorted';
    const g = await reader.readRange(toUser(50), '2026-10-16', '2026-10-17', { tz: NY, deadlineMs: 4321, calendarIds: [FAMILY.id] });
    assertSame(g.items.map((i: Row) => i.event.eventId), ['g-allday', 'g-a', 'g-b', 'g-late'], 'Google order: by start, ties in the order of the choices');
    assertSame([googleCalls[0].opts.googleCache, googleCalls[0].opts.deadlineMs, googleCalls[0].opts.calendarIds, googleCalls[0].opts.defer], ['bypass', 4321, [FAMILY.id], undefined], 'Google options');
    assert(!('famcal' in g), 'a Google user has no FamCal half');
  });

  await check('#22 readRange: a half that rejects reports error and the read still answers', async () => {
    seed();
    const toUser = (id: number) => ({ ...DB.user.find((u) => u.id === id), telegramId: null });
    famcalMode = 'reject';
    googleMode = 'reject';
    const f = await reader.readRange(toUser(9), '2026-10-16', '2026-10-17', { tz: IL, deadlineMs: 1000 });
    const g = await reader.readRange(toUser(50), '2026-10-16', '2026-10-17', { tz: NY, deadlineMs: 1000 });
    assertSame([f.famcal.status, f.famcal.cause?.message, f.items.length], ['error', 'famcal half rejected', 0], 'FamCal');
    assertSame([g.google.status, g.google.reason, g.google.cause?.message, g.items.length], ['error', 'unknown', 'google half rejected', 0], 'Google');
    const viaRoute = await get('', { tg: TG.tal });
    assertSame([viaRoute.status, viaRoute.body.sources], [200, { famcal: { status: 'error' } }], 'route');
  });

  await check('#23 the famcal_session cookie (WhatsApp, a browser): 200 for its own DB id with no header; 401 for another id, also with that user\'s init data in the query', async () => {
    seed();
    const { createSessionToken } = await load('src/lib/session-auth.ts');
    const cookie = `famcal_session=${createSessionToken(9)}`;
    const own = await get('', { userId: '9', header: false, cookie });
    assert(own.status === 200, `own id: ${own.status} ${own.text}`);
    assertSame(keysOn(own.body, '2026-10-16'), ['famcal|rem-plumber', 'famcal|ev-dentist'], 'today');
    assert(own.res.headers.get('cache-control') === 'private, no-store', `cache-control: ${own.res.headers.get('cache-control')}`);
    assertSame([rateChecks, famcalCalls.map((c) => c.user.id)], [['calendar:u9'], [9]], 'the limiter key and the read');
    const other = await get('', { userId: '42', header: false, cookie });
    const otherWithQuery = await get('', { tg: TG.gil, header: false, queryInitData: true, cookie });
    assertSame([other.status, otherWithQuery.status], [401, 401], 'another user\'s id');
    assertSame([rateChecks.length, famcalCalls.length], [1, 1], 'a refused request was counted or read');
  });

  await check('#24 a slow timezone lookup (no tz:user entry, Nominatim not answering): an answer within 2.6 s in the fallback zone, by the language rule; a quick lookup is used', async () => {
    seed();
    redisStore.delete('tz:user:42');
    const blocked = globalThis.fetch;
    /** While set, Nominatim never answers; each request ends only when its own timeout aborts it. */
    let slow = true;
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      fetched.push(url);
      if (url.startsWith('https://nominatim.openstreetmap.org/')) {
        if (!slow) return json([{ lat: '55.7558', lon: '37.6173' }]);
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        });
      }
      if (url.startsWith('https://api.open-meteo.com/')) return json({ timezone: 'Europe/Moscow' });
      throw new Error(`network blocked in smoke: ${url}`);
    }) as typeof fetch;
    try {
      const started = performance.now();
      const late = await Promise.race([get('', { tg: TG.gil }), new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000))]);
      const ms = performance.now() - started;
      assert(late !== null, 'no answer within 4 s: the route waits for the whole timezone lookup');
      assert(ms >= 1900 && ms < 2600, `answered after ${Math.round(ms)} ms`);
      // Asia/Jerusalem with tzKnown false: Noa's Russian gives Monday and no Hebrew dates.
      assertSame([late.status, late.body.tz, late.body.today, late.body.weekStart, late.body.hebrewDates], [200, IL, '2026-10-16', 1, false], 'the fallback facts');
      assert(fetched.some((u) => u.startsWith('https://nominatim.openstreetmap.org/')), `fetched ${show(fetched)}`);
      assert(!redisStore.has('tz:user:42'), `the route cached a zone: ${redisStore.get('tz:user:42')}`);
      assertSame(captured.map((c) => [c.ctx, c.severity, c.extra]), [['calendar-range-timezone', 'warning', { user_id: 42 }]], 'captured');
      seed();
      redisStore.delete('tz:user:42');
      slow = false;
      const quick = await get('', { tg: TG.gil });
      assertSame([quick.status, quick.body.tz, quick.body.weekStart, quick.body.hebrewDates], [200, 'Europe/Moscow', 1, false], 'a quick lookup');
      assert(redisStore.get('tz:user:42') === 'Europe/Moscow' && captured.length === 0, `tz:user:42 ${redisStore.get('tz:user:42')}, captured ${show(captured)}`);
    } finally {
      globalThis.fetch = blocked;
    }
  });

  Object.assign(console, quiet);
  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? '(unset)'})`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  // console may still be silenced: write the failure straight to stderr.
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
```

- [ ] **Step 2: Run it and see it fail**

```bash
run() { env TZ="$1" DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx "scripts/$2.ts"; }
run UTC smoke-calendar-range; echo "exit $?"
```

Expected: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/app/api/calendar/range/route.ts' imported from …/scripts/smoke-calendar-range.ts`, then `exit 1`.

- [ ] **Step 3: Add the range route and `execute-command` to `scripts/smoke-initdata-header.ts`**

Make five edits.

Edit 3a, the header (lines 9-10). Replace:
```ts
// The routes, admin-auth, api-auth, telegram-auth and the services behind them run for
// real. Faked at the boundaries: Prisma (in memory), Redis (in memory), the rate limiter
```
with:
```ts
// The calendar home's GET /api/calendar/range reads the header only, and
// /api/execute-command now reads the header too, then the body (it used to read only the
// body's initData).
//
// The routes, admin-auth, api-auth, telegram-auth and the services behind them run for
// real. Faked at the boundaries: Prisma (in memory), Redis (in memory), the rate limiter
```

Edit 3b, the limiter stub (line 275). Replace:
```ts
    settingsRateLimiter: {}, commandRateLimiter: {}, generalRateLimiter: {},
```
with:
```ts
    settingsRateLimiter: {}, commandRateLimiter: {}, generalRateLimiter: {}, calendarRateLimiter: {},
```

Edit 3c, `after()` (after line 298). Replace:
```ts
  stub('src/services/messaging/factory.ts', messaging);
  globalThis.fetch = (async (input: unknown) => {
```
with:
```ts
  stub('src/services/messaging/factory.ts', messaging);
  // Next's after() needs a live request scope. execute-command queues its command there;
  // the command itself is not what this smoke checks, so drop it.
  nodeRequire('next/server').after = () => undefined;
  globalThis.fetch = (async (input: unknown) => {
```

Edit 3d, the CASES comment (line 367). Replace:
```ts
/** Every route read of initData before the fix: 13 query-only, 8 body-then-query. */
```
with:
```ts
/**
 * Every route read of initData before the fix (13 query-only, 8 body-then-query), the
 * calendar range route (header only) and execute-command (header, then body).
 */
```

Edit 3e, two CASES (after line 390). Replace:
```ts
  { route: 'app/api/weather-image/sign/route.ts', method: 'GET', url: `/api/weather-image/sign?user_id=${TG_ID}&source=summary` },
];
```
with:
```ts
  { route: 'app/api/weather-image/sign/route.ts', method: 'GET', url: `/api/weather-image/sign?user_id=${TG_ID}&source=summary` },
  { route: 'app/api/calendar/range/route.ts', method: 'GET', url: `/api/calendar/range?user_id=${TG_ID}` },
  { route: 'app/api/execute-command/route.ts', method: 'POST', url: '/api/execute-command', body: { user_id: String(TG_ID), command: 'weather' } },
];
```

The checks themselves don't change. `#3` and `#4` iterate over CASES, so their names now say 23. `#5` covers `execute-command`'s body path, and it passes before and after.

- [ ] **Step 4: Run it and see #3 and #4 fail**

```bash
run() { env TZ="$1" DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx "scripts/$2.ts"; }
run UTC smoke-initdata-header; echo "exit $?"
```

Expected: `FAIL  #3 every one of the 23 route reads refuses …` and `FAIL  #4 every one of the 23 route reads accepts …`, both with `Cannot find module '…/app/api/calendar/range/route.ts'`; then `7/9 passed` and `exit 1`.

- [ ] **Step 5: Add `calendarRateLimiter` to `src/lib/rate-limit.ts` (edit 10)**

After `tokenPollRateLimiter` (lines 33-37), replace:
```ts
  prefix: 'ratelimit:token-poll',
});

export interface RateLimitResult {
```
with:
```ts
  prefix: 'ratelimit:token-poll',
});

// calendar/range: 60 requests per minute, on a budget of its own. The calendar home asks
// for each source's days on every open and every return to the foreground, and the Month
// tab fetches the month on screen and the ones next to it, which would soon use up the
// general limit
export const calendarRateLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(60, '1 m'),
  prefix: 'ratelimit:calendar',
});

export interface RateLimitResult {
```

Only `verifyUserAuth` calls a limiter. Plan A's guard check #27 in `smoke-auth-identity.ts` keeps it that way, and the route passes this limiter to `verifyUserAuth`.

- [ ] **Step 6: Create `src/services/calendar-read/index.ts`**

```ts
// The shared calendar reader (calendar home spec §2): one read over the sources that
// apply to a user, for the calendar home's range route and, once the rollout switch
// covers them, the summaries (Plan C).
//
// This file picks the sources, builds the window and runs the halves in parallel. The
// halves do the reading: famcal.ts (§2.4) and google.ts (§2.5, §2.6). Nothing here
// buckets into days: day membership is daySpanOf's, applied by the caller
// (shapeEventsForDay for a summary, toRangeDays for the home).

import type { UserConfig } from '../../types';
import { startOfLocalDay } from '../../utils/day-events';
import { readFamcal } from './famcal';
import { readGoogle } from './google';
import type { DayKey, FamcalRead, GoogleRead, RangeRead, ReadItem, ReadRangeOptions, SourceName } from './types';

/**
 * The sources that apply to a user: the one place that decides it. In step 1 a user
 * reads only their own kind (Owner decision 2, Ruling R3): a built-in calendar user
 * FamCal, a Google user Google, also while still paired with a FamCal partner. The
 * "Google becomes a connection" step changes only this function (plus the ownership
 * fixes).
 */
export function sourcesFor(user: Pick<UserConfig, 'calendarSource'>): SourceName[] {
  if (user.calendarSource === 'NATIVE') return ['famcal'];
  if (user.calendarSource === 'GOOGLE') return ['google'];
  return [];
}

type Half<R> = { read: R; items: ReadItem[] };

/**
 * The items of [fromKey, toKey) in `opts.tz`, with each read source's status.
 *
 * - Window: [max(startOfLocalDay(fromKey), notBefore), startOfLocalDay(toKey)),
 *   half-open, no padding. Both halves select by overlap with it. An empty window is a
 *   caller's bug and throws a RangeError.
 * - Sources: opts.sources ∩ sourcesFor(user); absent = every applicable one. A source
 *   that doesn't apply or wasn't asked for is left out of the result (no key, no read,
 *   no query).
 * - The halves run in parallel and never reject the read: one that throws reports
 *   `error` (FamCal with the cause; Google as 'unknown').
 * - Items: FamCal in the provider's order, then Google in the order of the choices,
 *   stably sorted by start as calendar.ts:159 sorts. An item without a start is
 *   dropped. A user has one source in step 1, so the concatenation never reorders.
 * - Only Google takes the cache options; the default is 'bypass' (summaries never use
 *   the cache).
 *
 * `user` must be a fresh DB row (verifyUserAuth's, or the summary's getAllUsers row),
 * never the reminder cache's rebuilt user, which defaults the source to GOOGLE.
 */
export async function readRange(user: UserConfig, fromKey: DayKey, toKey: DayKey, opts: ReadRangeOptions): Promise<RangeRead> {
  const dayStart = startOfLocalDay(fromKey, opts.tz);
  const from = opts.notBefore && opts.notBefore.getTime() > dayStart.getTime() ? new Date(opts.notBefore.getTime()) : dayStart;
  const to = startOfLocalDay(toKey, opts.tz);
  if (!(from.getTime() < to.getTime())) {
    throw new RangeError(`readRange: empty window [${from.toISOString()}, ${to.toISOString()}) for ${fromKey}..${toKey} in ${opts.tz}`);
  }
  const window = { from, to };

  const applicable = sourcesFor(user);
  const wanted = opts.sources ? applicable.filter((s) => opts.sources?.includes(s)) : applicable;

  const famcalP: Promise<Half<FamcalRead>> | null = wanted.includes('famcal')
    ? readFamcal(user, window, { calendarIds: opts.calendarIds }).catch(
        (cause: unknown): Half<FamcalRead> => ({ read: { status: 'error', cause }, items: [] })
      )
    : null;
  const googleP: Promise<Half<GoogleRead>> | null = wanted.includes('google')
    ? readGoogle(user, window, {
        tz: opts.tz,
        calendarIds: opts.calendarIds,
        deadlineMs: opts.deadlineMs,
        googleCache: opts.googleCache ?? 'bypass',
        defer: opts.defer,
      }).catch((cause: unknown): Half<GoogleRead> => ({ read: { status: 'error', reason: 'unknown', cause }, items: [] }))
    : null;
  const [famcal, google] = await Promise.all([famcalP, googleP]);

  const hasStart = (item: ReadItem) => !!item.event.start;
  // Array#sort is stable, so equal starts keep the order of the choices (calendar.ts:159).
  const googleItems = (google?.items ?? [])
    .filter(hasStart)
    .sort((a, b) => new Date(a.event.start).getTime() - new Date(b.event.start).getTime());

  return {
    window,
    items: [...(famcal?.items ?? []).filter(hasStart), ...googleItems],
    ...(famcal ? { famcal: famcal.read } : {}),
    ...(google ? { google: google.read } : {}),
  };
}
```

- [ ] **Step 7: Create `app/api/calendar/range/route.ts`**

```ts
/**
 * GET /api/calendar/range: the calendar home's days (calendar home spec §4).
 *
 *   ?user_id=<id>[&from=yyyy-MM-dd&to=yyyy-MM-dd][&sources=famcal|google|famcal,google][&fresh=1]
 *   X-Telegram-Init-Data: <initData>   (or the famcal_session cookie in a browser)
 *
 * Only for users the rollout switch covers; everyone else gets 404 not_enabled, and the
 * client then falls back to today's dashboard. The facts (timezone, today, week start,
 * Hebrew dates) are worked out here, never taken from the client, and so are the
 * calendars: the legend is the reader's. The answer is built field by field, so the
 * user row (Google token, phone, pairing) never reaches the JSON, and neither does a
 * masked calendar's real name or id.
 */

import { NextRequest, NextResponse, after } from 'next/server';
import { verifyUserAuth } from '@/src/lib/api-auth';
import { calendarRateLimiter } from '@/src/lib/rate-limit';
import { requestInitData } from '@/src/lib/request-init-data';
import { captureError } from '@/src/lib/error-capture';
import { resolveUserTimezone } from '@/src/lib/timezone';
import { TIMEZONE } from '@/src/config/constants';
import { isCalendarHomeOn } from '@/src/services/calendar-read/rollout';
import { readRange, sourcesFor } from '@/src/services/calendar-read';
import { carryOverReadItems } from '@/src/services/calendar-read/famcal';
import { toCalendarDto, toCarryOverDto, toRangeDays } from '@/src/services/calendar-read/dto';
import type { GoogleRead, RangeRead } from '@/src/services/calendar-read/types';
import { fetchOpenReminderItems, openRemindersCutoff } from '@/src/services/native-reminders/open-reminders';
import { hebrewDatesFor, tzKnownFor, weekStartFor } from '@/src/utils/locale-rules';
import { addDaysToDate, localDate } from '@/src/utils/day-events';
import type { DayKey, ItemDTO, RangeResponse, SourceName } from '@/src/lib/calendar-view/types';
import type { UserConfig } from '@/src/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = 'private, no-store';
/** The window with no from/to: today and the next 6 days (Ruling R8). */
const DEFAULT_DAYS = 7;
/** The longest window: a month grid's 6 weeks. */
const MAX_DAYS = 42;
const MAX_YEARS_AWAY = 5;
/** The whole Google half, cache miss included (spec §2.2 Deadlines). */
const GOOGLE_DEADLINE_MS = 6000;
/**
 * How long the answer waits for the user's timezone. A tz:user miss (once a day per user)
 * asks Nominatim and Open-Meteo, or Google's settings, with retries that take about 48 s
 * when those are slow. Past this the answer goes out in the fallback zone.
 */
const TZ_LOOKUP_MS = 2000;
const SOURCE_NAMES: readonly SourceName[] = ['famcal', 'google'];
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

type GoogleSource = NonNullable<RangeResponse['sources']['google']>;
type Query = { from: DayKey; to: DayKey; sources: SourceName[] | null; fresh: boolean };

/**
 * The user's timezone, or null when resolveUserTimezone takes longer than `ms`. The lookup
 * carries on and caches its answer for the next open, as it always does; the route caches
 * nothing. A lookup that fails within `ms` rejects, as before.
 */
async function timezoneWithin(user: UserConfig, ms: number): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([resolveUserTimezone(user), late]);
  } finally {
    clearTimeout(timer);
  }
}

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': NO_STORE } });
}

/** A strict yyyy-MM-dd that names a real date: 2026-02-30 and 2026-1-05 don't. */
function isDayKey(value: string): boolean {
  if (!DAY_KEY.test(value)) return false;
  const t = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === value;
}

function isSourceName(value: string): value is SourceName {
  return (SOURCE_NAMES as readonly string[]).includes(value);
}

const yearsApart = (a: DayKey, b: DayKey) => Math.abs(Number(a.slice(0, 4)) - Number(b.slice(0, 4)));

/**
 * The window and the sources asked for, or why the query is refused (a 400). from and to
 * come both or neither; to is at most 42 days after from, compared as dates, so a 42-day
 * window across a DST change is fine.
 */
function parseQuery(params: URLSearchParams, today: DayKey): Query | { error: string } {
  const fromParam = params.get('from');
  const toParam = params.get('to');
  let from = today;
  let to = addDaysToDate(today, DEFAULT_DAYS);
  if (fromParam !== null || toParam !== null) {
    if (fromParam === null || toParam === null) return { error: 'from and to come together' };
    if (!isDayKey(fromParam) || !isDayKey(toParam)) return { error: 'from and to are yyyy-MM-dd dates' };
    if (!(fromParam < toParam)) return { error: 'from must come before to' };
    if (yearsApart(fromParam, today) > MAX_YEARS_AWAY || yearsApart(toParam, today) > MAX_YEARS_AWAY) {
      return { error: `from and to are within ${MAX_YEARS_AWAY} years of today` };
    }
    if (toParam > addDaysToDate(fromParam, MAX_DAYS)) return { error: `at most ${MAX_DAYS} days` };
    from = fromParam;
    to = toParam;
  }
  let sources: SourceName[] | null = null;
  const sourcesParam = params.get('sources');
  if (sourcesParam !== null) {
    const names = sourcesParam.split(',');
    if (!names.every(isSourceName)) return { error: 'sources is famcal, google or both' };
    sources = names;
  }
  return { from, to, sources, fresh: params.get('fresh') === '1' };
}

/**
 * Each applicable source's status: what the read said for a requested one, 'pending' for
 * one that applies but wasn't requested. A source that doesn't apply has no key, so a
 * FamCal user can never be shown "Reconnect Google" (that flow would switch them to
 * Google and hide their calendars).
 */
function sourcesDto(applicable: readonly SourceName[], read: RangeRead): RangeResponse['sources'] {
  const out: RangeResponse['sources'] = {};
  if (applicable.includes('famcal')) out.famcal = { status: read.famcal ? read.famcal.status : 'pending' };
  if (applicable.includes('google')) out.google = read.google ? googleSource(read.google) : { status: 'pending' };
  return out;
}

function googleSource(google: GoogleRead): GoogleSource {
  if (google.status !== 'ok') return { status: google.status, reason: google.reason };
  return {
    status: 'ok',
    ...(google.partial ? { partial: { failed: google.partial.failed, truncated: google.partial.truncated } } : {}),
    ...(google.stale ? { stale: true } : {}),
  };
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  // A GET has no body: the init data comes from the header only, never the query.
  const auth = await verifyUserAuth(request, params.get('user_id'), requestInitData(request), calendarRateLimiter, 'calendar-range');
  if (!auth.success) {
    auth.response.headers.set('Cache-Control', NO_STORE);
    return auth.response;
  }
  const user = auth.user;

  try {
    if (!(await isCalendarHomeOn(user))) return json({ error: 'not_enabled' }, 404);

    const now = new Date();
    // A slow lookup costs this answer the user's zone, never the answer: the fallback zone
    // with tzKnown false, so the week start and Hebrew dates follow the language (R15).
    const resolved = await timezoneWithin(user, TZ_LOOKUP_MS);
    if (resolved === null) {
      captureError(new Error(`The timezone lookup took over ${TZ_LOOKUP_MS} ms`), 'calendar-range-timezone', { user_id: user.id }, 'warning');
    }
    const tz = resolved ?? TIMEZONE;
    const today = localDate(now, tz);
    const facts = { culture: user.culture, language: user.language, tz, tzKnown: resolved !== null && tzKnownFor(user) };
    const weekStart = weekStartFor(facts);
    const hebrewDates = hebrewDatesFor(facts);

    const query = parseQuery(params, today);
    if ('error' in query) return json({ error: 'bad_request', detail: query.error }, 400);
    const { from, to } = query;

    const applicable = sourcesFor(user);
    const requested = applicable.filter((s) => query.sources === null || query.sources.includes(s));
    const read = await readRange(user, from, to, {
      tz,
      sources: requested,
      googleCache: query.fresh ? 'refresh' : 'use',
      deadlineMs: GOOGLE_DEADLINE_MS,
      defer: (task) => after(task),
    });

    const famcal = read.famcal;
    if (famcal?.status === 'error') captureError(famcal.cause, 'calendar-range-famcal', { user_id: user.id }, 'warning');

    // The older open reminders, for a window that holds today, all of them, newest
    // first. carryOverReadItems masks them by the rows' legend rule: a calendar outside
    // the legend shows only the partner's name. A failed read costs the home its "Still
    // open" card, never the answer.
    let carryOvers: ItemDTO[] | undefined;
    if (famcal?.status === 'ok' && from <= today && today < to) {
      try {
        const open = await fetchOpenReminderItems(user, famcal.ctx, openRemindersCutoff(today, tz, now), today, tz, Infinity);
        carryOvers = carryOverReadItems(famcal, open.items).map((item) => toCarryOverDto(item, tz, now));
      } catch (err) {
        captureError(err, 'calendar-range-carryovers', { user_id: user.id }, 'warning');
      }
    }

    const legend = [
      ...(famcal?.status === 'ok' ? famcal.calendars : []),
      ...(read.google?.status === 'ok' ? read.google.calendars : []),
    ];
    const body: RangeResponse = {
      tz,
      today,
      weekStart,
      hebrewDates,
      from,
      to,
      sources: sourcesDto(applicable, read),
      partner: famcal?.status === 'ok' && famcal.partner ? { name: famcal.partner.name } : null,
      calendars: legend.map(toCalendarDto),
      days: toRangeDays(read.items, from, to, tz, now, today),
      ...(carryOvers ? { carryOvers } : {}),
    };
    return json(body);
  } catch (err) {
    // No titles in the context: the user id only.
    captureError(err, 'calendar-range', { user_id: user.id });
    return json({ error: 'internal_error' }, 500);
  }
}
```

- [ ] **Step 8: Run both smokes: the range smoke passes, and the header smoke now fails only on `execute-command`**

```bash
run() { env TZ="$1" DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx "scripts/$2.ts"; }
for tz in UTC Asia/Jerusalem Pacific/Kiritimati; do out=$(run $tz smoke-calendar-range 2>&1); code=$?; echo "$out" | tail -1; echo "exit $code (TZ=$tz)"; done
out=$(run UTC smoke-initdata-header 2>&1); code=$?; echo "$out" | grep -E 'FAIL|passed'; echo "exit $code"
```

Expected:
- `24/24 passed (process TZ=UTC)`, `24/24 passed (process TZ=Asia/Jerusalem)` and `24/24 passed (process TZ=Pacific/Kiritimati)`, each with `exit 0`;
- `FAIL  #4 every one of the 23 route reads accepts the X-Telegram-Init-Data header (not 401/403) — POST /api/execute-command -> 401`, then `8/9 passed` and `exit 1`.

- [ ] **Step 9: Read init data from the header in `app/api/execute-command/route.ts` (edit 12)**

Line 5. Replace:
```ts
import { verifyUserAuth, type AuthVia } from '@/src/lib/api-auth';
```
with:
```ts
import { verifyUserAuth, type AuthVia } from '@/src/lib/api-auth';
import { requestInitData } from '@/src/lib/request-init-data';
```

Line 17. Replace:
```ts
    const { user_id, command, args, secret, initData } = body;
```
with:
```ts
    const { user_id, command, args, secret } = body;
    // The X-Telegram-Init-Data header, else a string initData in the body
    const initData = requestInitData(request, body);
```

Line 38 (now 40), `verifyUserAuth(request, String(user_id), initData, commandRateLimiter, 'execute-command')`, stays as it is. Nothing else in the file changes. The `CRON_SECRET` operator path is untouched.

- [ ] **Step 10: Run both smokes under the three clocks**

```bash
run() { env TZ="$1" DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx "scripts/$2.ts"; }
for tz in UTC Asia/Jerusalem Pacific/Kiritimati; do
  out=$(run $tz smoke-calendar-range 2>&1); code=$?; echo "$out" | tail -1; echo "range exit $code (TZ=$tz)"
  out=$(run $tz smoke-initdata-header 2>&1); code=$?; echo "$out" | tail -1; echo "initdata exit $code (TZ=$tz)"
done
```

Expected: `24/24 passed (process TZ=…)` and `9/9 passed` for each of the three clocks, every one with exit 0. The range smoke takes about 3 s: #24 waits out the 2 s timezone bound.

- [ ] **Step 11: Run the regression smokes**

```bash
run() { env TZ="$1" DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx "scripts/$2.ts"; }
for s in smoke-auth-identity smoke-admin-panel-ssr smoke-page-auth smoke-oauth-weather smoke-pairing-accept smoke-google-connect smoke-reminders smoke-native-provider-reminders smoke-calendar-read-famcal smoke-calendar-read-google smoke-calendar-read-google-cache smoke-calendar-home-rollout; do
  run UTC $s > /dev/null 2>&1; echo "$s exit $?"
done
```

Expected: every line ends `exit 0`, and each smoke prints the same `N/N` it printed before this task. `smoke-reminders.ts` and `smoke-native-provider-reminders.ts` are unchanged. They stub or bypass everything this task adds.

- [ ] **Step 12: Type-check and lint**

```bash
npx tsc --noEmit -p .; echo "tsc exit $?"
npm run -s lint; echo "lint exit $?"
```

Expected: `tsc exit 0` and `lint exit 0`.

- [ ] **Step 13: Commit**

```bash
git add src/services/calendar-read/index.ts app/api/calendar/range/route.ts src/lib/rate-limit.ts app/api/execute-command/route.ts scripts/smoke-calendar-range.ts scripts/smoke-initdata-header.ts
git commit -m "$(cat <<'EOF'
feat(calendar-read): readRange and GET /api/calendar/range

readRange picks each user's sources (sourcesFor), builds the local-midnight
window with notBefore, runs the FamCal and Google halves in parallel and
keeps today's order. The range route answers only users the rollout switch
covers (404 not_enabled otherwise): header-only init data, its own 60/min
limiter, server-side facts (timezone, today, week start, Hebrew dates),
strict window checks, the Google cache with after() for stale refreshes,
masked carry-overs, and a DTO built field by field with private, no-store.
A timezone lookup slower than 2 s answers in the fallback zone with the
language rule instead of holding the answer for up to 48 s.
The user row and a masked calendar's name and id never reach the JSON.

execute-command now reads init data with requestInitData, so the
X-Telegram-Init-Data header works there too; a body initData still does.
The switch ships OFF, so the home changes nothing users see.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
EOF
)"
```

---

### Task 9 (B9): Recurrence cache bound and failure-path checks (Plan A follow-ups)

**What and why:** Plan A's final review left two minor items for Plan B. (1) `src/services/recurrence-cache.ts` never lets an entry go. One that ran out is only skipped on read, so the Map on `globalThis` grows for the life of the process, and Railway runs one long-lived process. This task caps it at `RECURRENCE_CACHE_MAX_ENTRIES = 5000`. Past the cap, a write first drops every entry that has run out by the written entry's `at`, then the oldest written until the cache is back at 5,000. A key written again moves to the newest place, so a refreshed answer is not the first to go. (2) Section (g) of `scripts/smoke-week-lookahead.ts` never tried two failure paths: a Google lookup cut off with no HTTP status (`ECONNRESET`), and a native user's series read (`getNativeSeriesRrule`) failing or answering. Both already work as intended (a failure is kept 10 minutes, an answer 6 hours). Three new checks pin that, and three more test the bound by calling the cache module directly.

**Visible to users:** nothing. A family's /week, /nextweek and tomorrow lookahead list the same events; the cap only acts once the cache holds more than 5,000 entries, and below that nothing changes.

**Findings (read before you start):**
- The only writer is `lookUpRecurrence` in `src/services/week-lookahead.ts:158-172`. It writes with `at` = the moment of the question, taken before the lookup, so "ran out by `entry.at`" is judged on the same clock as `readRecurrenceCache`.
- A Map iterates in the order its keys were first set, and `set` on an existing key keeps that place. That's why the write deletes the key first. Deleting entries while iterating a Map is safe in JavaScript: a deleted entry not reached yet is skipped.
- A write that keeps the size at or under the cap does no extra work. Past it, the write walks the Map once more (5,000 entries, well under a millisecond), so a full cache costs one walk per new series.
- `googleErrorStatus` (`week-lookahead.ts:128-136`) reads only numeric `status`, `response.status` and `code`. `ECONNRESET` is a string `code`, so it has no status and counts as a failure (10 minutes), not as gone.
- The smoke's native New York user (id 3) has three native events: Teacher day (single), Standup (`standup`, daily) and Anniversary (`anniv`, yearly). A failed read makes both series read as daily, so only Teacher day is listed; an answer lists Teacher day and Anniversary.
- `smoke-calendar-read-google-cache` replaces `recurrence-cache.ts` with a stub, and `smoke-google-connect` loads it through `calendar-read/google.ts`, which calls only `clearRecurrenceCacheForUser`. Neither count changes.

**Files:**
- Modify: `src/services/recurrence-cache.ts:16-18` (header comment, one sentence on the bound), `:24-25` (the new constant goes after the failure TTL), `:48-51` (`writeRecurrenceCache`). It stays a leaf: no imports.
- Modify (test): `scripts/smoke-week-lookahead.ts:10-12` (header comment), `:140-141` (native read state), `:240` (the native stub), `:252-253` (import of the cache module), `:489-493` (`nativeWeek`, `freshCache`), `:549` (three failure-path checks go before it), `:577-578` (three eviction checks go before the `finally`).
- Test: `scripts/smoke-week-lookahead.ts` (29 → 35 checks).

**Interfaces:**
- Consumes (Plan A, unchanged):
  - From `src/services/recurrence-cache.ts`: `type RecurrenceEntry = { value: string[] | null; at: number; ttlMs: number }`, `writeRecurrenceCache(key: string, entry: RecurrenceEntry): void`, `readRecurrenceCache(key: string, now: number): RecurrenceEntry | undefined`, `RECURRENCE_ANSWER_TTL_MS` (6 h), `RECURRENCE_GONE_TTL_MS` (6 h), `RECURRENCE_FAILURE_TTL_MS` (10 min), `clearRecurrenceCache(): void`, `clearRecurrenceCacheForUser(userId: number): void`. The Map lives on `globalThis.__recurrenceCache`; the smoke reads it to count entries.
  - `getNativeSeriesRrule(seriesCuid: string): Promise<string | null>` (`src/services/native-calendar/event-store.ts:743`), stubbed in the smoke.
  - `getWeekLookahead(user: UserConfig, calendars: CalendarAssignment[], referenceDate?: Date): Promise<WeekLookahead>` (`src/services/week-lookahead.ts:406-410`), unchanged.
- Produces:
  - `export const RECURRENCE_CACHE_MAX_ENTRIES = 5000` in `src/services/recurrence-cache.ts`. Nothing else is added and no signature changes. `writeRecurrenceCache` now keeps the cache at 5,000 entries at most and moves a key written again to the newest place.

- [ ] **Step 1: Add the failing checks to `scripts/smoke-week-lookahead.ts`**

Seven edits, in file order. Line numbers are those of the file before this step (615 lines).

Edit 1a, the header comment (lines 10-12) of `scripts/smoke-week-lookahead.ts`. Before:
```ts
// The series lookup behind the daily/weekly filter kept a failed lookup forever, under a
// key every user shared: one Google hiccup hid a monthly series from /week until the
// next deploy, for everyone with that calendar.
```
After:
```ts
// The series lookup behind the daily/weekly filter kept a failed lookup forever, under a
// key every user shared: one Google hiccup hid a monthly series from /week until the
// next deploy, for everyone with that calendar. Nor did it ever let an entry go: in
// Railway's one long-lived process it grew without end.
```

Edit 1b, the native read's state, after `masterTookMs` (lines 140-141). Before:
```ts
/** How far the cache's clock moves while events.get answers. */
let masterTookMs = 0;
```
After:
```ts
/** How far the cache's clock moves while events.get answers. */
let masterTookMs = 0;
/** Every native series read (getNativeSeriesRrule), by series id. */
const nativeCalls: string[] = [];
/** What getNativeSeriesRrule throws, while set: the database is out of reach. */
let nativeError: Error | undefined;
```

Edit 1c, the native stub (line 240). It records each read and throws `nativeError` while set; unset, it answers as before, so no existing check changes. Before:
```ts
  stub('services/native-calendar/event-store.ts', { getNativeSeriesRrule: async (id: string) => RRULES[id] ?? null });
```
After:
```ts
  stub('services/native-calendar/event-store.ts', {
    getNativeSeriesRrule: async (id: string) => {
      nativeCalls.push(id);
      if (nativeError) throw nativeError;
      return RRULES[id] ?? null;
    },
  });
```

Edit 1d, the cache module itself, imported after week-lookahead (lines 252-253). It's the instance week-lookahead uses (one file in require's cache, one Map on `globalThis`). Before:
```ts
  const { getWeekLookahead, getNextWeekLookahead, formatTomorrowLookahead, clearRecurrenceCache, clearRecurrenceCacheForUser } =
    await import('../src/services/week-lookahead');
```
After:
```ts
  const { getWeekLookahead, getNextWeekLookahead, formatTomorrowLookahead, clearRecurrenceCache, clearRecurrenceCacheForUser } =
    await import('../src/services/week-lookahead');
  const { RECURRENCE_CACHE_MAX_ENTRIES, RECURRENCE_ANSWER_TTL_MS, RECURRENCE_FAILURE_TTL_MS, writeRecurrenceCache } =
    await import('../src/services/recurrence-cache');
```

Edit 1e, a native twin of `seriesWeek`, and `freshCache` also clears `nativeError` (lines 489-493). Before:
```ts
  const freshCache = () => {
    clearRecurrenceCache();
    for (const token of Object.keys(masterErrors)) delete masterErrors[token];
    masterTookMs = 0;
  };
```
After:
```ts
  /** The same for the native New York user: what it lists | the native series it read. */
  const nativeWeek = async (at: number) => {
    clock = at;
    nativeCalls.length = 0;
    const lookahead = await getWeekLookahead(nativeNewYorker, calendars, seriesTuesday);
    return `${lookahead.events.map(e => e.summary).join(', ') || 'nothing'} | read ${nativeCalls.join(', ') || 'nothing'}`;
  };
  const freshCache = () => {
    clearRecurrenceCache();
    for (const token of Object.keys(masterErrors)) delete masterErrors[token];
    nativeError = undefined;
    masterTookMs = 0;
  };
```

Edit 1f, three failure-path checks, before the two-users check (line 549). Before:
```ts
    await check('(g) two users with the same calendar and series ids each get their own answer', async () => {
```
After:
```ts
    await check('(g) a lookup cut off with no HTTP status (ECONNRESET) is kept 10 minutes, then asked again', async () => {
      freshCache();
      masterErrors['token-series-6'] = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
      const got = [`0:00:00: ${await seriesWeek(seriesUser, T0)}`];
      delete masterErrors['token-series-6'];
      got.push(`0:09:59: ${await seriesWeek(seriesUser, T0 + 10 * MIN - 1000)}`);
      got.push(`0:10:00: ${await seriesWeek(seriesUser, T0 + 10 * MIN)}`);
      assertList(got, [
        `0:00:00: nothing | ${BOTH('token-series-6')}`,
        '0:09:59: nothing | asked nothing',
        `0:10:00: Book club | ${BOTH('token-series-6')}`,
      ]);
    });

    await check('(g) native: a failed series read is kept 10 minutes, then read again', async () => {
      freshCache();
      nativeError = new Error("Can't reach database server");
      const got = [`0:00:00: ${await nativeWeek(T0)}`];
      nativeError = undefined;
      got.push(`0:09:59: ${await nativeWeek(T0 + 10 * MIN - 1000)}`);
      got.push(`0:10:00: ${await nativeWeek(T0 + 10 * MIN)}`);
      assertList(got, [
        '0:00:00: Teacher day | read standup, anniv',
        '0:09:59: Teacher day | read nothing',
        '0:10:00: Teacher day, Anniversary | read standup, anniv',
      ]);
    });

    await check('(g) native: an answer is kept 6 hours, then read again', async () => {
      freshCache();
      const got = [`0:00:00: ${await nativeWeek(T0)}`];
      // Read again now, the series would fail: what shows is the kept answer.
      nativeError = new Error("Can't reach database server");
      got.push(`5:59:59: ${await nativeWeek(T0 + 6 * HOUR - 1000)}`);
      got.push(`6:00:00: ${await nativeWeek(T0 + 6 * HOUR)}`);
      assertList(got, [
        '0:00:00: Teacher day, Anniversary | read standup, anniv',
        '5:59:59: Teacher day, Anniversary | read nothing',
        '6:00:00: Teacher day | read standup, anniv',
      ]);
    });

    await check('(g) two users with the same calendar and series ids each get their own answer', async () => {
```

Edit 1g, three checks of the bound, before the `finally` (lines 577-578). They write to the cache directly and count what its Map holds. Before:
```ts
  } finally {
    Date.now = realNow;
```
After:
```ts
    // The bound, written to directly. The cap is written out (5,000, as the review asked), so
    // a changed constant fails the first check instead of moving the checks with it.
    const CAP = 5000;
    const answerAt = (at: number) => ({ value: ['RRULE:FREQ=MONTHLY'], at, ttlMs: RECURRENCE_ANSWER_TTL_MS });
    const failureAt = (at: number) => ({ value: null, at, ttlMs: RECURRENCE_FAILURE_TTL_MS });
    /** How many entries the cache's Map holds, then whether it still holds each of `keys`. */
    const holds = (keys: string[]) => {
      const map = (globalThis as { __recurrenceCache?: Map<string, unknown> }).__recurrenceCache;
      assert(!!map, 'no cache on globalThis.__recurrenceCache');
      return [`${map.size} held`, ...keys.map(key => `${key} ${map.has(key) ? 'kept' : 'gone'}`)];
    };

    await check('(g) past 5,000 entries, the ones that ran out go first; a live one stays, the oldest included', async () => {
      freshCache();
      writeRecurrenceCache('answer', answerAt(T0));
      for (let i = 1; i <= CAP - 2; i++) writeRecurrenceCache(`failed:${i}`, failureAt(T0));
      // A second younger: one second short of its 10 minutes when 'new' is written.
      writeRecurrenceCache('failed:late', failureAt(T0 + 1000));
      const atCap = holds(['answer']);
      writeRecurrenceCache('new', failureAt(T0 + 10 * MIN));
      assertList([`cap ${RECURRENCE_CACHE_MAX_ENTRIES}`, ...atCap, ...holds(['answer', 'failed:1', `failed:${CAP - 2}`, 'failed:late', 'new'])], [
        'cap 5000',
        '5000 held', 'answer kept',
        '3 held', 'answer kept', 'failed:1 gone', 'failed:4998 gone', 'failed:late kept', 'new kept',
      ]);
    });

    await check('(g) past 5,000 live entries, the oldest written goes, one per write', async () => {
      freshCache();
      for (let i = 1; i <= CAP + 1; i++) writeRecurrenceCache(`answer:${i}`, answerAt(T0 + i));
      const first = holds(['answer:1', 'answer:2', `answer:${CAP + 1}`]);
      writeRecurrenceCache(`answer:${CAP + 2}`, answerAt(T0 + CAP + 2));
      assertList([...first, ...holds(['answer:2', 'answer:3', `answer:${CAP + 2}`])], [
        '5000 held', 'answer:1 gone', 'answer:2 kept', 'answer:5001 kept',
        '5000 held', 'answer:2 gone', 'answer:3 kept', 'answer:5002 kept',
      ]);
    });

    await check('(g) a key written again counts as newest: a refreshed answer is not the first to go', async () => {
      freshCache();
      writeRecurrenceCache('answer:1', answerAt(T0));
      for (let i = 2; i <= CAP; i++) writeRecurrenceCache(`answer:${i}`, answerAt(T0 + HOUR));
      // Six hours on, answer:1 has run out and is asked again; then a new series comes.
      writeRecurrenceCache('answer:1', answerAt(T0 + 6 * HOUR));
      writeRecurrenceCache('new', answerAt(T0 + 6 * HOUR));
      assertList(holds(['answer:1', 'answer:2', 'answer:3', 'new']), ['5000 held', 'answer:1 kept', 'answer:2 gone', 'answer:3 kept', 'new kept']);
    });
  } finally {
    Date.now = realNow;
```

The `finally` runs `freshCache()`, so the synthetic keys don't reach the leaf check after it (that check runs in a fresh process anyway).

- [ ] **Step 2: Run it on today's cache and see the bound's checks fail**

```bash
for tz in UTC Asia/Jerusalem; do TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-week-lookahead.ts; echo "exit $?"; done
```

Expected under each clock: `32/35 passed (process TZ=UTC)` or `(process TZ=Asia/Jerusalem)`, then `exit 1`. The 29 old checks and the three new failure-path checks pass. The three bound checks fail:
- `FAIL  (g) past 5,000 entries, the ones that ran out go first; a live one stays, the oldest included`: got `"cap undefined"`, `"5001 held"`, `"failed:1 kept"`, `"failed:4998 kept"` where it wants `"cap 5000"`, `"3 held"` and both `gone`;
- `FAIL  (g) past 5,000 live entries, the oldest written goes, one per write`: got `"5001 held"`, `"answer:1 kept"`, then `"5002 held"`, `"answer:2 kept"`;
- `FAIL  (g) a key written again counts as newest: a refreshed answer is not the first to go`: got `"5001 held"`, `"answer:2 kept"`.

The two `[Upstash Redis]` lines at the top come from the fake env and were there before.

The three failure-path checks already pass on today's code: they pin what Plan A shipped untested. Step 4 lists a mutation that each of them catches.

Don't run `tsc` yet: `RECURRENCE_CACHE_MAX_ENTRIES` doesn't exist until Step 3. `tsx` doesn't type-check, so the smoke runs.

- [ ] **Step 3: Bound the cache in `src/services/recurrence-cache.ts`**

Three edits. Line numbers are those of the file before this step (69 lines).

Edit 3a, the header comment (lines 16-18) of `src/services/recurrence-cache.ts`. Before:
```ts
// An answer is kept 6 hours. A failed lookup is kept 10 minutes: kept for good, one
// Google hiccup hid a monthly series from /week until the next deploy. A series that is
// gone (404, 410) is an answer.
```
After:
```ts
// An answer is kept 6 hours. A failed lookup is kept 10 minutes: kept for good, one
// Google hiccup hid a monthly series from /week until the next deploy. A series that is
// gone (404, 410) is an answer. At most 5,000 entries are kept: past that, a write drops
// the entries that have run out, then the oldest written.
```

Edit 3b, the cap, after the failure TTL (lines 24-25). Before:
```ts
/** How long a failed lookup is kept, so a hiccup is asked about again soon. */
export const RECURRENCE_FAILURE_TTL_MS = 10 * 60 * 1000;
```
After:
```ts
/** How long a failed lookup is kept, so a hiccup is asked about again soon. */
export const RECURRENCE_FAILURE_TTL_MS = 10 * 60 * 1000;
/** The most entries kept: past it, a write makes room (writeRecurrenceCache). */
export const RECURRENCE_CACHE_MAX_ENTRIES = 5000;
```

Edit 3c, `writeRecurrenceCache` (lines 48-51). Before:
```ts
/** Keeps `entry` under `key`, replacing what was there. */
export function writeRecurrenceCache(key: string, entry: RecurrenceEntry): void {
  cache.set(key, entry);
}
```
After:
```ts
/**
 * Keeps `entry` under `key`, replacing what was there, as the newest entry. Past
 * RECURRENCE_CACHE_MAX_ENTRIES it makes room: first every entry that has run out by
 * `entry.at`, then the oldest written, until the cache is back at the cap.
 */
export function writeRecurrenceCache(key: string, entry: RecurrenceEntry): void {
  // A Map iterates in the order its keys were first set. Deleted first, a refreshed
  // answer moves to the end, so it is not the first to go.
  cache.delete(key);
  cache.set(key, entry);
  if (cache.size <= RECURRENCE_CACHE_MAX_ENTRIES) return;
  for (const [k, e] of cache) {
    if (entry.at - e.at >= e.ttlMs) cache.delete(k);
  }
  for (const k of cache.keys()) {
    if (cache.size <= RECURRENCE_CACHE_MAX_ENTRIES) break;
    cache.delete(k);
  }
}
```

- [ ] **Step 4: Run the smoke under both clocks and see it pass**

```bash
for tz in UTC Asia/Jerusalem; do TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-week-lookahead.ts; echo "exit $?"; done
```

Expected under each clock: 35 `OK` lines, `35/35 passed (process TZ=UTC)` or `(process TZ=Asia/Jerusalem)`, then `exit 0`. The run takes about 2 s; the three bound checks write about 15,000 entries in about 6 ms of it.

On this code, each new check catches a mutation (try it, then revert). In `fetchMasterEventRecurrence` (week-lookahead.ts):
- every failure kept 6 hours (`RECURRENCE_ANSWER_TTL_MS` in place of `RECURRENCE_FAILURE_TTL_MS` in both catches): 32/35, failing "a failed lookup is kept 10 minutes" (the 503), "a lookup cut off with no HTTP status (ECONNRESET)" and "native: a failed series read is kept 10 minutes";
- a failure with no HTTP status read as gone (`status === undefined || status === 404 || status === 410`): 34/35, only the ECONNRESET check;
- a native answer kept 10 minutes (`RECURRENCE_FAILURE_TTL_MS` in the native `try`): 34/35, only "native: an answer is kept 6 hours".

In `writeRecurrenceCache`:
- `cache.set` without the `cache.delete(key)` before it: 34/35, only "a key written again counts as newest";
- `>` in place of `>=` in the ran-out test: 34/35, only "past 5,000 entries, the ones that ran out go first";
- no ran-out pass (oldest written only): 34/35, the same check (the live `answer`, oldest written, goes);
- no oldest-written pass (ran-out only): 33/35, "past 5,000 live entries" and "a key written again".

- [ ] **Step 5: Run the regression smokes**

Both load the cache module: `smoke-calendar-read-google-cache` as a stub, `smoke-google-connect` through `calendar-read/google.ts` (`clearRecurrenceCacheForUser` only).

```bash
for tz in UTC Asia/Jerusalem; do for s in smoke-calendar-read-google-cache smoke-google-connect; do out=$(TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/$s.ts 2>&1); code=$?; echo "$tz $s exit $code :: $(echo "$out" | grep -aE '[0-9]+/[0-9]+ passed' | tail -1)"; done; done
```

Expected: four lines, each `exit 0`, with `42/42 passed` for `smoke-calendar-read-google-cache` and `30/30 passed` for `smoke-google-connect`, the same counts as before this task. The whole suite (all 51 `scripts/smoke-*.ts`, both clocks) also exits 0 everywhere; only `smoke-week-lookahead` changes count, 29 → 35.

- [ ] **Step 6: Type-check and lint**

```bash
npx tsc --noEmit -p .; echo "tsc=$?"
npm run -s lint; echo "lint=$?"
```

Expected: `tsc=0` and `lint=0`, with no output from either. `tsc` also checks `scripts/**`, so the smoke's import of `RECURRENCE_CACHE_MAX_ENTRIES` is checked here.

- [ ] **Step 7: Commit**

```bash
git add src/services/recurrence-cache.ts scripts/smoke-week-lookahead.ts
git commit -m "$(cat <<'MSG'
fix(week): the series lookup cache keeps at most 5,000 entries

An entry that ran out was only skipped on read, never dropped, so the
cache grew for as long as the process ran. Past 5,000 entries a write
now drops the entries that have run out, then the oldest written. A key
written again moves to the newest place, so a refreshed answer is not
the first to go.

The smoke also covers two failure paths: a Google lookup cut off with no
HTTP status, and a native series read. A failure is kept 10 minutes and
an answer 6 hours.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
MSG
)"
```

---

### Task 10: Verification and landing (run by the controller, not a subagent)

**Files:** none changed, unless a check fails.

- [ ] **Step 1: Run every smoke under both clocks, and the day-bucketing smokes under Kiritimati**

```bash
cd /Users/razielgershoni/development/famcalbot
E="DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake"
OUT=/private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/landing-B; mkdir -p $OUT
run() { eval "env TZ=$2 $E perl -e 'alarm shift; exec @ARGV' 300 npx tsx $1" > "$OUT/$(basename $1 .ts).$(echo $2 | tr / _).out" 2>&1; echo "$(basename $1) $2 exit=$? $(tail -1 "$OUT/$(basename $1 .ts).$(echo $2 | tr / _).out")"; }
for s in scripts/smoke-*.ts; do for tz in UTC Asia/Jerusalem; do run $s $tz; done; done
for s in locale-rules calendar-dto calendar-read-google calendar-range; do run scripts/smoke-$s.ts Pacific/Kiritimati; done
eval "env $E npx tsx scripts/check-i18n-parity.ts"; echo "parity exit $?"
```

Expected: every line `exit=0`. The new and changed counts are admin-panel-ssr 10, calendar-home-rollout 33, locale-rules 19, calendar-dto 23, google-map 41, calendar-read-famcal 21, calendar-read-google 34, calendar-read-google-cache 42, calendar-range 24, initdata-header 9 and week-lookahead 35. A non-zero exit is a failure to fix before landing. macOS has no `timeout`; the `perl` alarm stands in for it.

- [ ] **Step 2: Type-check and lint the branch**

Run: `npx tsc --noEmit -p . && npm run -s lint; echo "exit $?"`
Expected: `exit 0`, no output before it.

- [ ] **Step 3: Build a fresh clone on Node 22, and run the reader smokes there**

```bash
F=/private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/fresh-B
rm -rf $F && git clone -q --branch feat/calendar-home /Users/razielgershoni/development/famcalbot $F && cd $F
# E is the env prefix from Step 1.
npx -y node@22 "$(command -v npm)" ci --no-audit --no-fund > ../fresh-B-ci.log 2>&1; echo "ci exit $?"
npx -y node@22 node_modules/.bin/prisma generate > ../fresh-B-gen.log 2>&1; echo "generate exit $?"
npx -y node@22 node_modules/.bin/next build > ../fresh-B-build.log 2>&1; echo "build exit $?"; tail -5 ../fresh-B-build.log; grep -c "api/calendar/range" ../fresh-B-build.log
for s in locale-rules google-map calendar-dto calendar-read-famcal calendar-read-google calendar-read-google-cache calendar-range calendar-home-rollout admin-panel-ssr initdata-header; do eval "env TZ=Asia/Jerusalem $E npx -y node@22 node_modules/.bin/tsx scripts/smoke-$s.ts" > ../fresh-B-$s.out 2>&1; echo "$s node22 exit=$? $(tail -1 ../fresh-B-$s.out)"; done
```

Expected: three `exit 0` lines, a finished build, a non-zero count of `api/calendar/range` in the route table, and every Node 22 smoke `exit=0` (smoke-locale-rules prints 19/19 with 1 SKIP on Node 22). `next build` here runs no migration: the clone has no `.env`, and `next build` is called directly rather than `npm run build`.

- [ ] **Step 4: Land on main and push**

The owner authorized landing ("you can proceed and ping me after push to main").

```bash
cd /Users/razielgershoni/development/famcalbot
git fetch -q origin
git checkout -q main && git pull -q --ff-only origin main
git merge --ff-only feat/calendar-home
git push -q origin main
git checkout -q feat/calendar-home && git push -q origin feat/calendar-home
git rev-parse --short main
```

Expected: a fast-forward with no merge commit. If `--ff-only` refuses, stop: `main` moved. Rebase the branch onto it, re-run Steps 1–3 and try again.

- [ ] **Step 5: Confirm the deploy (it applies the migration)**

Poll `gh api repos/raziel-gershoni/famcalbot/commits/<sha>/status --jq '.statuses[] | "\(.context) \(.state)"'` every few minutes, not in a tight loop. Wait until the context `famcalbot - famcalbot` (Railway) and the Vercel context both read `success`. Railway's `npm run build` runs `prisma migrate deploy`, which adds `AdminSettings.calendarHomeRollout` (default `OFF`). On `failure`, read the build log, fix on the branch and land again.

- [ ] **Step 6: Report to the owner**

Send a short ping that says what is live and what isn't:
- the switch is `OFF`;
- the admin control is under Admin → Features;
- Task 7's and Task 8's "Say in the PR" points (the stamp hook's live effects; the inert changes);
- Planning Ruling 4 (the 2 s timezone bound) for the owner to keep or veto.

Then check Sentry for new `calendar-read-google-stamp` warnings over the first hours. Production stays read-only.

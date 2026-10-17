# Calendar Home, Plan C: Summaries on the Reader — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** For the users the rollout switch covers, move the daily and tomorrow summaries, the tomorrow summary's week block, `/week` and `/nextweek` onto Plan B's shared reader. Each gets its spec §3 failure handling: R13's text on demand, and on a schedule a 30 s wait, one retry, then an outage run. Users the switch doesn't cover get today's outputs byte for byte (A-33). The switch stays `OFF` on deploy.

**Architecture:**
- `src/services/calendar-read/digest.ts` (C1) is the summaries' only door into `readRange`. It holds the read kinds (`DigestRead`), the on-demand quick retry, and `throwForDigest`, which turns a reader outcome into the error codes the summaries already answer, plus `GOOGLE_FETCH_FAILED` with its `day`.
- The prompt builders gain one optional guideline line, `googleUnavailable` (C2). Without it every prompt is byte-identical to a fixture captured from main@858886c.
- `src/services/telegram/summary.ts` is the seam: the switch-aware fetch wrappers, `prepareSummaryForUser`'s `opts` and R13's text (C3). The batch then sets aside, waits, retries and runs the outage (C4).
- `src/services/week-lookahead.ts` and the `/week` and `/nextweek` commands read through the same adapters, with week boundaries from Plan B's `weekStartFor` for covered users (C5).
- `scripts/smoke-digest-reader-parity.ts` runs both paths over one in-memory database and one fake Google, and checks that they read the same (C6).

**Tech Stack:** Next.js 16.1 · TypeScript · Prisma 5 + Neon Postgres · Upstash Redis · `@googleapis/calendar` 9.8 (google-auth-library, gaxios) · next-intl messages · tsx smoke scripts (no test runner).

**Spec:** `docs/superpowers/specs/2026-10-16-calendar-home-design.md`:
- §3 (the summaries) and §2.2/§2.5's deadlines;
- the bot part of §6 (week boundaries);
- §9's two bot texts;
- §10's parity smoke and live check;
- Appendix A (A-28, A-30, A-33).

This is the third of the spec's five delivery plans (A → B → C ∥ D → E). Plans A and B are on `main`.

## Global Constraints

- The repo is PUBLIC. Never commit, print or hardcode secrets. Never read or print `.env*` files. Production is read-only; never call `/api/health`.
- **No test runner.** Tests are `tsx` smoke scripts in `scripts/`, in the `check()`/`assert()` style of `scripts/smoke-week-lookahead.ts`, printing `N/N passed` and exiting non-zero on failure. They stub modules through `require.cache` (and a `Module.registerHooks` hook where a module is loaded with `import()`). They never touch the real DB, Redis, Google, Telegram or AI. They must type-check: `next build` type-checks `scripts/**`.
- **Every smoke run fakes every `.env` name first** (Prisma loads `.env` for any unset variable). Use this prefix, with `TZ=Asia/Jerusalem` runs, and `TZ=Pacific/Kiritimati` runs where a step says so:
  ```bash
  TZ=UTC DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/<name>.ts; echo "exit $?"
  ```
- Prisma: no schema change in this plan. Never run `prisma migrate dev`, `migrate deploy` or `db push` locally.
- Every commit passes `npx tsc --noEmit -p .` and `npm run -s lint`.
- Every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
  ```
- Work on branch `feat/calendar-home`. Never push to `main` from a task, and never force-push. Task 7 (the controller) lands the plan.
- **The switch stays `OFF`.** Every new behaviour applies only where `await isCalendarHomeOn(user)` is true. For everyone else every prompt, delivered text, voice text, admin notice and dedup mark is unchanged. `scripts/smoke-native-provider-reminders.ts` and `scripts/smoke-reminders.ts` must pass unchanged. C2's prompt fixture pins the prompts.
- **Summary reads never touch Redis for Google.** They pass `googleCache: 'bypass'`, so they never read or write the cache and never stamp (Plan B Ruling 3, A-30). Don't add a stamp to the digest adapters.
- Cross-bundle in-process state lives on `globalThis` (Plan B's `__calendarHomeRollout*` keys). Never serialize the user row. Log and warning contexts carry `user_id` plus non-identifying counts and stage names, never titles. Never refactor Telegram flows to swap `user.id` and `telegramId`. Don't change the TTS remote/local pattern or the Gemini thinking level.
- WhatsApp is secondary. The outage line and R13's text go wherever the summary or command answer already goes; no new WhatsApp template.
- **Fixed values** (spec §2.2, §3):
  - read kinds: on demand `deadlineMs: 10_000`; scheduled `30_000`; the scheduled retry `15_000`;
  - the on-demand quick retry: a Google `error` other than `calendars_gone`, not a timeout, that ended within 5,000 ms of the read's start → a 1,000 ms pause → one more read with `deadlineMs: 8_000`;
  - the scheduled retry: wait until 30,000 ms have passed since the batch's first `GOOGLE_FETCH_FAILED`, retry each set-aside user once in order, and give a second failure the outage run;
  - the switch's both-stores-down `OFF` is kept 5,000 ms (beside the 30 s memo);
  - no Google request in a reader read gets a timeout under 1,000 ms;
  - bot texts `bot.errors.googleUnreachable` (R13) and `bot.errors.googleOutageNote` (the outage line, appended as `\n\n<i>…</i>`).

## Review Focus

The five inputs most worth a reviewer's eye, most likely first. Each names the task that owns it and the check that pins it.

1. **An Outlook or Teams HTML invite description** (table rows, `h1`-`h6`, a list whose items don't close) on a covered Google user's daily or tomorrow summary. Expected: the words stay apart. The reader's description keeps the block breaks ("Agenda Budget", then "Join", then "Room 4" on separate lines), and the prompt reads `Description: Agenda Budget Join Room 4`, never "AgendaBudget". The prompt's own sanitizer turns line breaks into spaces (A-13, unchanged). A block adds no line break where the text already has one (a newline, `<br>`, `</p>`, `</div>`, `</li>`). Blocks inside a link's text, and a block next to an encoded break (`&#10;`), are Ruling 1's two limits. **C6**: `smoke-digest-reader-parity` "(b) an Outlook/Teams HTML description …", and `smoke-google-map` "htmlToText: blocks (headings, paragraphs, tables, lists, quotes, pre, hr) …" plus its "Notes"/"Agenda" assertion.

2. **A covered built-in-calendar user with no location and no Google token** (`tzKnownFor` false; `resolveUserTimezone` falls back to Asia/Jerusalem). Expected: the week start comes from the language. On Thursday 22 October, `en` and `he` get `/week` through Saturday 24 and `/nextweek` Sunday 25 to Saturday 31; `ru` and `fr` get `/week` through Sunday 25 and `/nextweek` Monday 26 to Sunday 1 November. With the switch off, all four get Monday weeks. **C5**: `smoke-week-lookahead` "(h) switch on, no location and no Google token (tzKnown false) …".

3. **An on-demand tomorrow summary with its week block during per-user 429s.** Each read's first attempt is rate-limited after 4.9 s and answered on the quick retry after 7.4 s, with a 2 s first timezone lookup and a 20 s AI stream. Expected: `onSuccess` delivers it, with its WEEK LOOKAHEAD block, at 48.6 s: inside `executeCommand`'s 50 s race, with no OperationTimeoutError and no admin notice. A 22 s AI stream times it out. A quick retry answered after 7.9 s is past its 7.5 s request timeout and ends in R13's text. **C6**: `smoke-digest-reader-parity` "(d) on demand, the tomorrow summary with its week block …" and "(d) on demand, a quick retry answered after 7.9 s …", both on virtual time.

4. **A scheduled batch during a Google stall** (the token server never answers) for three covered Google users, with a covered FamCal user last. Expected:
   - each first read ends `error('timeout')` at its 30 s deadline and is set aside, and its token request is cancelled, not left open;
   - the FamCal user goes out at 90 s. There is no sleep, because the loop ends 60 s after the first failure;
   - each retry times out at 15 s and takes the outage run: the outage line, the guideline and a dedup mark;
   - the batch takes 135 s, logs its total and counts the set-aside users in Sentry once, and sends no admin notice. Users the switch doesn't cover would have gone first.

   **C6**: `smoke-digest-reader-parity` "(e) a Google stall …". **C1**: `smoke-calendar-read-google-cancel`, for the cancel. **C4**: `smoke-summary-retry`, for the order and the count.

5. **A tomorrow summary at a 23:00 evening hour whose retry lands after local midnight.** Batch at 23:59:20, first failure at 23:59:35, retry at 00:00:05. Expected: the dedup mark is written for the batch's date (`summary:dedup:tomorrow:{id}:2026-10-16`), so at 23:00 on 17 October `filterUsersForSummary` still finds the user eligible. **C4**: `smoke-summary-retry` "a 23:00 tomorrow summary retried after midnight is marked for the batch's date …".

## Planning Rulings

Decided while drafting, integrating and reviewing. The spec is updated where it changes (C6 edits §2.5 item 8). Executors treat these as binding.

1. **`htmlToText` breaks lines at blocks** (C6; spec §2.5 item 8). Opening and closing headings, `table`, `tr`, `ul`, `ol`, `blockquote` and `pre`, plus opening `p`, `div` and `hr`, start and end a line, adding a line break only where the text has none. A table cell is set apart by a space. Two limits stay, as in the reference it was fuzzed against: blocks inside a link's text still run together (the link's text is flattened first), and a block next to an encoded line break (`&#10;`) adds a blank line. *Why:* an Outlook or Teams invite's blocks ran words together ("AgendaBudget") in covered users' prompts. Opening tags count too, because Plan B's own "NotesAgenda" case has nothing but an opening `<H1>` between the words. *If wrong:* a description shows one more line break than its author meant.
2. **C was drafted on a scratch base; C6's `html.ts` edit targets the real branch.** C1–C5 were drafted and first verified on a scratch base, `wt/B-int` 63e7d4f, which differs from `feat/calendar-home` (716a4f8) only in docs, `smoke-voice-dates.ts`, `html.ts` and `smoke-google-map.ts`. Replayed in order on 716a4f8, every step as written, they give the trees their commits make and the counts they expect; their line numbers and Before blocks are 716a4f8's. C6's block rule is written into 716a4f8's linear `htmlToPlain` (`replaceTag` and the drop loops), so it stays linear. It was fuzzed against the regex version for identical output. *If wrong:* C6's Before block fails to match, and the task stops.
3. **The week block's own outage stays a degrade** (C3/C6; A-28). When the day read succeeds but the week block's read fails, the tomorrow summary goes out without its week block and without the outage line. *Why:* the line says the user's Google events are missing, which is false when the day read succeeded, and a new line would be copy beyond §9's two texts. *If wrong:* a user misses that the week block is absent; it is listed as open in the landing report.
4. **The scheduled retry is ordered and dated** (C4):
   - users the switch doesn't cover go first in the batch;
   - the retry and the outage run mark the dedup key for the batch's date, so a 23:00 summary retried past midnight doesn't skip the next evening's;
   - a retry asks the switch again, and a user it no longer covers takes today's path;
   - one `summary-google-retry` warning per batch counts the set-aside users;
   - the daily run's reminder-cache sync and OAuth clean-up run beside the batch, not after it.
   *If wrong:* an uncovered user's summary goes out a little earlier than before (not later).
5. **A deploy during the retry wait drops the set-aside users** (C4). They get no summary and no dedup mark, and the next hourly run skips them because their hour has passed. Only the count warning records it. *Why:* persisting the set-aside list is outside the spec. *If wrong:* during a Google outage that coincides with a deploy, a few covered users miss one summary; listed as open.
6. **The switch's both-stores-down `OFF` is kept 5 s with one warning per attempt** (C3, Plan B carry-over). *Why:* Plan C asks the switch per user in the hourly loop, so an unmemoized fallback cost every user two store attempts and two warnings during an outage. *If wrong:* a flip made during a joint Redis and DB outage takes 5 s longer to reach a process.
7. **A reader read leaves nothing running** (C1, Plan B carry-over). Every Google request of a read gets an abort signal that fires when the read answers; the token request's timeout is the deadline; no request timeout drops under 1 s. *Why:* a stalled token server left one open request per covered user per run.
8. **Gone calendars warn twice on purpose** (C1). The reader warns at most once a day per user; the digest adds one `calendar-read-digest` warning per summary read.
9. **The 1.4 s margin is accepted** (C6). An on-demand tomorrow summary with its week block, where every read is rate-limited and answered on the quick retry and the AI stream takes 20 s, is delivered at 48.6 s against `executeCommand`'s 50 s race. A slower retry ends in R13's text.
10. **`/week` and `/nextweek` keep `sendMessage` for the token and permission texts** even when a draft is open, as the daily does today (C5). Moving both to `streamHandle.cancel` is a follow-up.
11. **No PR.** The plan lands by fast-forward (Task 7). C6 Step 9's PR section goes into the landing report to the owner instead. C6 Step 10's live check runs when the owner sets the switch to `ADMINS`.

## File Structure

| File | Task | Change |
|---|---|---|
| `src/services/calendar-read/digest.ts` (new) | 1 | `DigestRead`, the three read kinds, `readDigestDay`, `readLookaheadEvents`, the quick retry, `throwForDigest` |
| `src/services/calendar-read/google.ts`, `src/services/calendar.ts` | 1 | The read's abort signal and request timeouts; `getGoogleAuth(refreshToken, transport?)` |
| `src/services/claude.ts`, `src/prompts/calendar-summary/{types,en,he,ru}.ts` | 2 | `googleUnavailable` and its guideline line |
| `messages/{en,he,ru}.json` | 2 | `bot.errors.googleUnreachable`, `bot.errors.googleOutageNote` |
| `scripts/fixtures/summary-prompts.json` (new) | 2 | 24 prompts captured from main@858886c |
| `src/services/telegram/summary.ts` | 3, 4 | The switch-aware fetch wrappers, `prepareSummaryForUser`'s `opts`, R13's text; the batch's retry and outage run |
| `src/services/calendar-read/rollout.ts` | 3 | The 5 s both-stores-down memo |
| `src/lib/summary-scheduling.ts`, `src/cron/handlers.ts` | 4 | `markSummarySent(…, sentFor?)`; housekeeping beside the batch |
| `src/services/week-lookahead.ts`, `src/services/telegram/commands.ts` | 5 | The lookahead on the reader, week boundaries by `weekStartFor`; `/week` and `/nextweek` answers |
| `src/utils/html.ts`, `docs/superpowers/specs/2026-10-16-calendar-home-design.md` | 6 | Blocks start and end a line; §2.5 item 8 |
| `scripts/smoke-digest-adapters.ts`, `smoke-calendar-read-google-cancel.ts` (new) | 1 | Adapters; the cancel |
| `scripts/smoke-summary-prompt-parity.ts` (new) | 2 | Prompt byte-identity and the one added line |
| `scripts/smoke-summary-seam.ts` (new), `smoke-calendar-home-rollout.ts` | 3 | The seam; the fallback memo |
| `scripts/smoke-summary-retry.ts` (new) | 4 | The batch |
| `scripts/smoke-week-lookahead.ts`, `smoke-week-commands.ts` (new) | 5 | Switch-on lookahead and week starts; the commands' answers |
| `scripts/smoke-digest-reader-parity.ts` (new), `smoke-google-map.ts` | 6 | The parity smoke; the block checks |

Tasks run in order 1 → 7. Each later task consumes the modules of earlier ones (each task's **Interfaces** block names them). Each task says which state of a file its line numbers refer to (mostly 716a4f8's); every Before block is matched by its text, which is unique in its file. Inside the tasks, cross-references use the draft names: C*N* is Task *N* (C1 is Task 1, …, C6 is Task 6).

---

### Task 1 (C1): The summaries' read adapters (spec §3.1 "Adapters", §2.2 Deadlines), and a Google read that leaves nothing running (§2.5 Deadline)

> **Interface change versus the split: none.** Every name and signature in `CD-split.md` C1 is kept. Three details the split left open are fixed here: `ids` is typed `readonly string[]` (a `string[]` passes); the three read kinds are `Object.freeze`d, still typed `DigestRead`; and `throwForDigest` is private to `digest.ts`, as the split lists no export for it.
>
> **One addition from the review (Plan B's carry-over to C):** two Plan B files change, so that the reader's Google half leaves nothing running once it has answered. `getGoogleAuth(refreshToken, transport?)` (`src/services/calendar.ts`) gains an optional second parameter, a request timeout and an abort signal for every request of the client. Without it the client is built exactly as before, so `getCalendarClient` and every provider read stay as they are (A-1). `readGoogleUncached` (`src/services/calendar-read/google.ts`) passes it, aborts the signal when the read answers, and gives no request a timeout under 1 s. A second smoke, `scripts/smoke-calendar-read-google-cancel.ts` (5 checks), pins it.

**What and why:** For the users the rollout switch covers, Plan C moves the daily and tomorrow summaries, the tomorrow summary's week block, `/week` and `/nextweek` onto the shared reader (`readRange`, Plan B). This task adds the one module those callers go through, `src/services/calendar-read/digest.ts`:
- **`readDigestDay(user, day, tz, ids, read)`** reads a summary's day over `[day, next day)`.
- **`readLookaheadEvents(user, start, end, tz, ids, read)`** reads a lookahead range over `[localDate(start), the day after localDate(end))`, clipped to `start`. That reads the same events as today's Google read (`timeMin: start, timeMax: end`).
- **The read kinds:** `DigestRead` carries a run's mode and Google deadline from the caller to the reader. There are three constants: on demand 10,000 ms, scheduled 30,000 ms, the scheduled retry 15,000 ms.
- **How a read ends** (`throwForDigest`, spec §3.1):
  - a dead token or missing scopes throw the codes the summaries already answer;
  - any other Google failure throws `GOOGLE_FETCH_FAILED` carrying the read's first day, which C3 answers with R13's text and C4 retries;
  - every chosen calendar gone gives no Google events and a Sentry warning (R18);
  - a FamCal error rethrows its own cause (A-28).
- **The quick retry** (Ruling R13), on demand only: a Google error other than `timeout` and `calendars_gone`, ended within 5,000 ms of the read's start, is read once more about 1 s later with an 8,000 ms deadline.
- **Nothing outlives a read** (`google.ts`, `calendar.ts`). The reader's deadline gave up on a token request that a stuck token server never answered, but never cancelled it, and the auth library could retry it. A scheduled batch during a token-server stall left one such request open per covered user per run, plus one per retry. Now every request of a read carries an abort signal, aborted when the read answers. The token request also gets a timeout equal to the deadline, and a list request never gets less than 1 s.

Every read passes `googleCache: 'bypass'` (B7's stamp scope, binding), so a summary never reads, writes or stamps the Google cache.

**Visible to users:** nothing. Nothing calls the adapters yet (C3 and C5 do), and the switch ships `OFF`. The reader's cancel also reaches the range route, which is behind the switch too. Its answers don't change.

**Findings that shaped the code:**
- **`readRange` never rejects for a source failure** (`src/services/calendar-read/index.ts:51-91`).
  - Each half reports a status: a FamCal throw becomes `{ status: 'error', cause }` (`famcal.ts:133-135`, and again `index.ts:64-66`); a Google throw becomes `error('unknown')` (`index.ts:75`).
  - A Google half that isn't `ok` contributes no items (`google.ts:376`). So after a Google `error`, `items.map(i => i.event)` is the FamCal half's events only. In step 1 a user has one source, so that is `[]` for a Google user.
  - The one throw is a `RangeError` for an empty window (`index.ts:55-57`), always a caller's bug. The adapters pass it on as it is, with no retry, so the pipeline's error path reports it.
- **Empty token.** The reader answers `reconnect('token')` for a Google user with no refresh token (`google.ts:328-329`). That would read as an expired token. Today's provider returns `[]` for that user (`google-provider.ts:74, :80, :86`; spec §2.5 item 1). So both adapters return `[]` first, with no read.
  - The split lists the rule for both adapters. `getWeekLookahead` and `getNextWeekLookahead` already return early for that user (`week-lookahead.ts:421`, `:522`), so in the lookahead it is a second guard.
- **No calendar ids** need no guard. Both halves answer `ok` with no items and make no Google call (`google.ts:331-333`; `famcal.ts` with an empty legend). That matches the provider's `calendarIds.length === 0 → []`.
- **Two warnings when every calendar is gone, on purpose:**
  - the reader's own, at most once a day per user and shared with the home (`warnGoneOnce`, `google.ts:254-270`), says the calendars are gone;
  - the digest's (context `calendar-read-digest`, extra `{ user_id, day, mode }`, no titles) says a summary went out without Google events. It is sent per read, as today's per-read `calendar-fetch-events` warning is (`calendar.ts:155-156`).
- **The reader's reporting gates touch Redis on summary reads too.** `warnGoneOnce` (`google.ts:258`) and `alertConfigOnce` (`google.ts:279`) do a `SET NX` on any read, `'bypass'` included. That is Plan B's code and is off the read's path (fire-and-forget; gone fails open, config fails closed). It is not the cache, and nothing here stamps. B7's note "they make no Redis command for Google" is true of the cache only.
- **The quick retry.**
  - **Timing:** it is measured with `Date.now()` around the first `readRange` call, and "within 5,000 ms" includes 5,000.
  - **Budget:** 5 s, a 1 s pause, then 8 s. With them, an on-demand read takes at most about 14 s of Google time. The tomorrow summary's day read plus its week block then stay under 30 s of `executeCommand`'s 50 s race (`command-pipeline.ts:10`; spec §2.2).
  - **Which result counts:** the second read's answer is final, and `throwForDigest` applies to it. A dead token found only on the retry is still `GOOGLE_TOKEN_EXPIRED`.
  - **Never retried:** `timeout` (it has used its time) and `calendars_gone` (a retry can't bring calendars back). `transient`, `config` and `unknown` are retried.
  - **Scheduled reads never retry here.** `sendSummaryToAll`'s queue does (C4, spec §3.3 C5).
- **The lookahead window.**
  - Today's Google read lists `timeMin: start, timeMax: end` (`week-lookahead.ts:271-272`). `end` is `endOfLocalDay`'s last millisecond of the last day (`:78-80`). Google's `timeMax` is exclusive and its times are whole seconds, so that is every event starting before the next local midnight.
  - `readRange`'s window is `[max(startOfLocalDay(fromKey), notBefore), startOfLocalDay(toKey))`. With `fromKey = localDate(start)`, `notBefore = start` and `toKey = nextDate(localDate(end))`, it is `[start, end + 1 ms)`, which ends at that same midnight.
  - The smoke checks this in New York, Kiritimati, on Israel's 25-hour 25 October and on Chile's midnight DST start (6 September 2026, when the day starts at 01:00).
  - The tomorrow block's `start` is the summary day's noon (`summary.ts:117, :153`), so its `fromKey` is the summary day.
- **`GOOGLE_FETCH_FAILED`'s day** is the read's first day in the user's timezone: `day` for the day read, `localDate(start, tz)` for a lookahead. At 22:30 UTC an Israeli user's day is already the next one, and the smoke checks that.
  - The error is a plain `Error` with an own enumerable `day`, built exactly as the split says: `Object.assign(new Error('GOOGLE_FETCH_FAILED'), { day })`.
  - It carries no `cause`: the reader has already sent each failed calendar to Sentry (`google.ts:291-305`).
- **For the tasks that consume this:**
  - **C3:** the wrappers call `readDigestDay(user, day, tz, calendarIds, read ?? DEFAULT_ON_DEMAND_READ)`. `tz` must be a defined string; `prepareSummaryForUser` always has `userTimezone`.
  - **C3 and C4** recognise the outage with `error.message === 'GOOGLE_FETCH_FAILED'` and read `(error as Error & { day: DayKey }).day`. The existing branches already match `'GOOGLE_TOKEN_EXPIRED'` and `'GOOGLE_INSUFFICIENT_SCOPES'` (`summary.ts:298`, `:318`, `:471`).
  - **C5:** `readLookaheadEvents` expects `end` to be `endOfLocalDay`'s inclusive last instant. An exclusive midnight would read one day too many. `start` must come before `end + 1 ms`, or `readRange` throws.
  - **None of this asks the switch.** The callers do (`await isCalendarHomeOn(user)`).
- **The token step's cancel** (`google.ts`, `calendar.ts`):
  - The reader raced `auth.getAccessToken()` against its deadline and walked away from it. The request went on. google-auth-library sends the refresh with `retry: true` (`OAuth2Client.RETRY_CONFIG`, `google-auth-library/build/src/auth/authclient.js:107-114`), and gaxios retries a request that got no response twice (`noResponseRetries`, `gaxios/build/src/retry.js:32-35`). So a stuck token server kept a request open, and later its retries, long after the read had answered.
  - Only an abort stops it. gaxios never retries an `AbortError` (`retry.js:96-99`), and node-fetch rejects a pending request as soon as its signal aborts. A timeout alone would not: a timed-out request has no response, so gaxios retries it.
  - How the signal gets there: `getGoogleAuth(token, { timeout, signal })` builds the client with `transporterOptions`. They become the defaults of every request the client sends (`authclient.js:47-50`), and gaxios merges each request's own options over them (`gaxios/build/src/gaxios.js:353`). The token refresh sets no timeout or signal of its own, so it gets both. Each list keeps its own timeout and retry config, and gets the signal.
  - The token request's timeout is the deadline itself, not less. The deadline's timer starts first, so it fires first, and the read still answers `error('timeout')`, as spec §10 says a token server that never answers must. A shorter timeout would turn the stall into a `transient` failure.
  - The signal is aborted in the read's `finally`, whatever the outcome. A read that answered in time has nothing left to cancel. After the deadline it cancels the token request, or the lists still waiting; `listCalendar` already ignores whatever ends after the deadline (`google.ts:175, :192`).
  - The floor is `Math.max(1_000, Math.min(10_000, deadlineMs - 500))`. It changes none of today's deadlines: the summaries' 8-30 s give 7,500 to 10,000 ms and the route's 6 s gives 5,500. Only a deadline under 1.5 s would have given a list less than 1 s, and the deadline still cuts that read off.
  - The fakes need no change. Every smoke that stubs `getGoogleAuth` takes the token alone and ignores a second argument, and C6's fake `auth.OAuth2` ignores its constructor's. B's `smoke-calendar-read-google.ts` checks `getGoogleAuth('refresh-a')`, with no transport, which still builds the client from the two positional arguments.
  - The cancel smoke runs the real client (google-auth-library 9.15.1 and gaxios 6.7.1, the copies under `@googleapis/calendar`), with only gaxios's HTTP adapter replaced, as `smoke-google-map.ts` does. Its fake hangs the way node-fetch does: until the signal aborts (an `AbortError`) or the request's own timeout passes (a `request-timeout` `FetchError`). "Nothing left" is checked two ways: no fake request is still waiting, and `process.getActiveResourcesInfo()` lists no more `Timeout`s than before the read. Timers are real, with deadlines of 0.9 and 1.5 s; the smoke takes about 3 s.
- **Smoke mechanics:**
  - `digest.ts` reads the clock only through `Date.now()`, so the smoke replaces `Date.now`, not the `Date` class. It pauses only through `setTimeout`, so the smoke swaps in a fake `setTimeout` once `digest.ts` is loaded. The fake moves the clock and fires on `setImmediate`. A watchdog on the real `setTimeout` fails a check that never settles.
  - `digest.ts` has no `import()`, so the `Module._load` stubs (for `index.ts` and `error-capture.ts`) are enough. No `Module.registerHooks` hook is needed.
  - On Node 26, tsx may print a `[DEP0205] DeprecationWarning: module.register()` line (and its `--trace-deprecation` hint) first. It is tsx's own: the trace points into `node_modules/tsx/dist/esm/index.mjs`.
- **Verified on a copy of `feat/calendar-home`:**
  - **Base:** 716a4f8 (Plans A and B as on `main` at c1558c6, plus Plan B's `htmlToText` follow-up), with this task's two files added. The first pass ran on the scratch base (header, Planning Ruling 2); the results below hold on both.
  - **Stand-ins:** none. C1 consumes only Plan B exports, all present at 716a4f8.
  - **Before:** the new smoke exits 1 with `ERR_MODULE_NOT_FOUND` under `TZ=UTC`, `Asia/Jerusalem` and `Pacific/Kiritimati`.
  - **After:** 23/23 under all three clocks, on Node 26.11.1 (and, in the first pass, on Node 22.23.3, production's engine). `tsc` and lint are clean.
  - **The cancel smoke, before Steps 7-8:** 1/5 under all three clocks, with the four FAIL lines of Step 6. **After:** 5/5 under all three.
  - **Plan B's smokes over the changed files** printed the same OK/FAIL lines and counts before and after, under `UTC` and `Asia/Jerusalem`: `smoke-calendar-read-google` 34, `smoke-calendar-read-google-cache` 42, `smoke-google-map` 44 (41 on the scratch base, which lacks c1558c6's and 716a4f8's checks), `smoke-calendar-range` 24, `smoke-week-lookahead` 35, `smoke-voice-dates` 77, `smoke-google-connect` 30, `smoke-calendar-read-famcal` 21.
  - **Real module graph:** `digest.ts` loads under the fake env (`digest → index → famcal/google → providers`, no stubs) and exports exactly `DEFAULT_ON_DEMAND_READ`, `SCHEDULED_READ`, `SCHEDULED_RETRY_READ`, `readDigestDay` and `readLookaheadEvents`.
  - **The task text itself** was replayed in a fresh copy of 716a4f8, step by step, every bash block run as written: the same before and after results, `tsc` and lint clean, and the tree this task's commit makes.
  - **Regression:** `digest.ts` is new; the two changed files are covered by Plan B's smokes above.
  - **Mutations caught** (first pass, on the scratch base, where every file they change is as at 716a4f8; each fails at least one check): `googleCache: 'use'`; no `notBefore`; `toKey` without `nextDate`; the quick retry also when scheduled; on `timeout`; on `calendars_gone`; `<` in place of `<=` at 5,000 ms; the 5,000 ms window raised to 50,000; the retry at the first read's deadline; no pause; the lookahead's day from `toISOString()`; no gone warning; `calendars_gone` thrown as an outage; the FamCal cause wrapped in a new `Error`; the empty-token guard removed; scopes and token swapped; the retry read kind not frozen; `calendarIds` not passed; `day` missing from `GOOGLE_FETCH_FAILED`. In the cancel smoke: the signal never aborted (checks 1, 2); the token request without the deadline's timeout (checks 1, 3); the 1 s floor removed (checks 2, 3); `getGoogleAuth` dropping its transport (checks 1-4).

**Files:**
- Create: `src/services/calendar-read/digest.ts`
- Modify: `src/services/calendar.ts:14-24` (`getGoogleAuth`, an optional `transport`)
- Modify: `src/services/calendar-read/google.ts`, four spots: the header comment (`:14-15`), the 1 s floor (`:57-58`), the abort signal and the token request's timeout (`:335-337`), the floor in use (`:355`) and the abort in `finally` (`:386-388`)
- Create (test): `scripts/smoke-digest-adapters.ts`, `scripts/smoke-calendar-read-google-cancel.ts`
- Test: `scripts/smoke-digest-adapters.ts` (23 checks), `scripts/smoke-calendar-read-google-cancel.ts` (5 checks)
- Regression (unchanged): Plan B's smokes over `google.ts` and `calendar.ts` (Step 6)

**Interfaces:**
- Consumes (Plan B, unchanged at 716a4f8):
  - `readRange(user: UserConfig, fromKey: DayKey, toKey: DayKey, opts: ReadRangeOptions): Promise<RangeRead>` (`src/services/calendar-read/index.ts:51`). The window is `[max(startOfLocalDay(fromKey, tz), notBefore), startOfLocalDay(toKey, tz))`, and an empty window throws a `RangeError`.
  - From `src/services/calendar-read/types.ts`: `DayKey` (re-exported), `ReadRangeOptions` (`{ tz; sources?; calendarIds?: readonly string[]; notBefore?: Date; googleCache?: 'use' | 'refresh' | 'bypass'; deadlineMs: number; defer? }`), `RangeRead` (`{ window; items: ReadItem[]; famcal?: FamcalRead; google?: GoogleRead }`), `GoogleRead` and `ReadItem` (the smoke builds fixtures from them).
  - `localDate(date: Date, timezone: string): string`, `nextDate(day: string): string` and (smoke only) `startOfLocalDay(day: string, timezone: string): Date` (`src/utils/day-events.ts:23, :28, :46`).
  - `captureWarning(message: string, context: string, extra?: ErrorContext): void` (`src/lib/error-capture.ts:55`).
  - `CalendarEvent`, `UserConfig` (`src/types.ts`), `UnifiedEvent` (smoke only, `src/services/calendar-provider/types.ts:16`), `ViewerContext` (smoke only, `src/services/native-reminders/ownership.ts:28`).
- Produces (`src/services/calendar.ts`, changed): `export function getGoogleAuth(refreshToken: string, transport?: { timeout: number; signal: AbortSignal }): InstanceType<typeof auth.OAuth2>`. With `transport`, every request the client sends, the token refresh included, gets `transport.timeout` unless it sets its own, and is cancelled when `transport.signal` aborts. Without it, unchanged.
- Changes (`src/services/calendar-read/google.ts`, no signature): `readGoogleUncached` passes `{ timeout: deadlineMs, signal }` and aborts the signal in its `finally`; each list request's timeout is `max(1000, min(10000, deadlineMs - 500))`.
- Produces (`src/services/calendar-read/digest.ts`):
  - `export type DigestRead = { mode: 'scheduled' | 'onDemand'; deadlineMs: number }`
  - `export const DEFAULT_ON_DEMAND_READ: DigestRead`: `{ mode: 'onDemand', deadlineMs: 10000 }`, frozen
  - `export const SCHEDULED_READ: DigestRead`: `{ mode: 'scheduled', deadlineMs: 30000 }`, frozen
  - `export const SCHEDULED_RETRY_READ: DigestRead`: `{ mode: 'scheduled', deadlineMs: 15000 }`, frozen
  - `export async function readDigestDay(user: UserConfig, day: DayKey, tz: string, ids: readonly string[], read: DigestRead): Promise<CalendarEvent[]>`
  - `export async function readLookaheadEvents(user: UserConfig, start: Date, end: Date, tz: string, ids: readonly string[], read: DigestRead): Promise<CalendarEvent[]>`
  - What they throw:
    - `new Error('GOOGLE_TOKEN_EXPIRED')`;
    - `new Error('GOOGLE_INSUFFICIENT_SCOPES')`;
    - `Object.assign(new Error('GOOGLE_FETCH_FAILED'), { day })`, with `day: DayKey`;
    - a FamCal error's own `cause`, unchanged;
    - `readRange`'s own throw (the empty-window `RangeError`), unchanged.
  - The events returned are the reader's `item.event` objects, in the reader's order, not copied.

- [ ] **Step 1: Write the failing smoke `scripts/smoke-digest-adapters.ts`**

Create the file with exactly this content:

```ts
// Smoke test for the summaries' calendar read (calendar home spec §3.1 "Adapters"):
// readDigestDay, readLookaheadEvents and the three read kinds in
// src/services/calendar-read/digest.ts.
//
// For the users the rollout switch covers, a summary reads its day, and the week block,
// /week and /nextweek their range, through the shared reader. The adapters must ask the
// reader for exactly today's window, never through the Google cache, and turn each way
// a read can end into what the summaries answer:
// - a dead token or missing scopes: GOOGLE_TOKEN_EXPIRED / GOOGLE_INSUFFICIENT_SCOPES;
// - any other Google failure: GOOGLE_FETCH_FAILED with the read's first day (C5, R13),
//   after one quick retry when an on-demand read failed fast;
// - every chosen calendar gone: no Google events and a warning (R18);
// - a FamCal error: its own cause, rethrown (A-28).
//
// readRange is a fake that answers from a script and moves a fake clock (Date.now) by
// the time each read takes. setTimeout is faked too, so the pause before a quick retry
// moves the same clock at once. Error capture is a recorder. No network, DB or Redis.
//
// Run under each clock; the output must not depend on the server's timezone:
//   TZ=UTC npx tsx scripts/smoke-digest-adapters.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-digest-adapters.ts
//   TZ=Pacific/Kiritimati npx tsx scripts/smoke-digest-adapters.ts

import Module from 'node:module';
import path from 'node:path';
import { formatInTimeZone } from 'date-fns-tz';
import { localDate, nextDate, startOfLocalDay } from '../src/utils/day-events';
import type { CalendarEvent, UserConfig } from '../src/types';
import type { UnifiedEvent } from '../src/services/calendar-provider/types';
import type { GoogleRead, RangeRead, ReadItem, ReadRangeOptions } from '../src/services/calendar-read/types';
import type { DigestRead } from '../src/services/calendar-read/digest';
import type { ViewerContext } from '../src/services/native-reminders/ownership';

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

function assert(cond: boolean, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

const show = (v: unknown) => JSON.stringify(v);

/** A list's length read afresh: an assert on `.length` would narrow it for the checks after it. */
const count = (list: readonly unknown[]): number => list.length;

globalThis.fetch = (async (input: unknown) => {
  throw new Error(`network is blocked in this smoke test: ${String(input)}`);
}) as typeof fetch;

// ---- Clock and sleep: Date.now reads `clock`; setTimeout moves it and fires at once ----

const BASE_CLOCK = Date.parse('2026-10-15T06:30:00.000Z'); // Thursday 09:30 in Israel
let clock = BASE_CLOCK;
Date.now = () => clock;

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
/** Every pause the adapters took: its length and the clock when it began. */
const sleeps: { ms: number; at: number }[] = [];
const fakeSetTimeout = ((callback: () => void, ms?: number) => {
  sleeps.push({ ms: ms ?? 0, at: clock });
  clock += ms ?? 0;
  setImmediate(callback);
  return 0;
}) as unknown as typeof setTimeout;

// ---- The fake reader ----

type Answer = { result: RangeRead | Error; takesMs?: number };
type Call = { user: UserConfig; fromKey: string; toKey: string; opts: ReadRangeOptions; at: number };

const reader = {
  /** Answered in order; the last one repeats. */
  answers: [] as Answer[],
  calls: [] as Call[],
  /** Every call of the whole run, for the last check. */
  allCalls: [] as Call[],
};

async function fakeReadRange(user: UserConfig, fromKey: string, toKey: string, opts: ReadRangeOptions): Promise<RangeRead> {
  const call = { user, fromKey, toKey, opts: { ...opts }, at: clock };
  reader.calls.push(call);
  reader.allCalls.push(call);
  const answer = reader.answers.length > 1 ? reader.answers.shift() : reader.answers[0];
  if (!answer) throw new Error('the smoke gave readRange no answer');
  await Promise.resolve();
  clock += answer.takesMs ?? 200;
  if (answer.result instanceof Error) throw answer.result;
  return answer.result;
}

// ---- Error capture ----

type Captured = { level: string; context: string; message: string; extra?: Record<string, unknown> };
const captured: Captured[] = [];

// ---- Stubs: the reader and error capture; day-events is the real one ----

const SRC = path.resolve(__dirname, '../src');
const stubs: Record<string, object> = {
  [`${SRC}/services/calendar-read/index.ts`]: {
    readRange: fakeReadRange,
    sourcesFor: () => {
      throw new Error('sourcesFor is not part of this smoke');
    },
  },
  [`${SRC}/lib/error-capture.ts`]: {
    captureError: (error: unknown, context: string, extra?: Record<string, unknown>, severity = 'error') => {
      captured.push({ level: severity, context, message: error instanceof Error ? error.message : String(error), extra });
    },
    captureWarning: (message: string, context: string, extra?: Record<string, unknown>) => {
      captured.push({ level: 'warning', context, message, extra });
    },
    captureInfo: () => {},
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

// ---- Fixtures ----

const IL = 'Asia/Jerusalem';
const DAY = '2026-10-15';
const TOMORROW = '2026-10-16';
const FAMCAL_IDS = ['native:cal-dana', 'native:cal-raziel-shared'];
const GOOGLE_IDS = ['family.kids@group.calendar.google.com', 'noa@gmail.com'];
const WINDOW = { from: new Date('2026-10-14T21:00:00.000Z'), to: new Date('2026-10-15T21:00:00.000Z') };

const famcalUser = {
  id: 11, telegramId: 1011, name: 'Dana', calendarSource: 'NATIVE', googleRefreshToken: '', pairingId: 'pair-1',
} as unknown as UserConfig;
const googleUser = {
  id: 12, telegramId: 1012, name: 'Noa', calendarSource: 'GOOGLE', googleRefreshToken: 'refresh-token', pairingId: null,
  calendarAssignments: [
    { calendarId: GOOGLE_IDS[0], labels: ['kids'], name: 'Kids', color: '#33b679' },
    { calendarId: GOOGLE_IDS[1], labels: ['yours'], name: 'Noa', color: '#039BE5' },
  ],
} as unknown as UserConfig;
const tokenlessGoogleUser = { ...googleUser, googleRefreshToken: '' } as UserConfig;

function famcalItem(id: string, summary: string, start: string, end: string, kind: 'event' | 'reminder' = 'event'): ReadItem {
  const event: UnifiedEvent = {
    summary, start, end, calendarName: 'Dana', calendarId: FAMCAL_IDS[0], eventId: id, provider: 'native',
    ...(kind === 'reminder' ? { eventType: 'reminder', reminder: { ownerIsViewer: true, creatorIsViewer: true } } : {}),
  };
  return {
    source: 'famcal', key: `famcal|${id}`, event,
    calendar: { id: FAMCAL_IDS[0], source: 'famcal', name: 'Dana', color: '#039BE5', mine: true, inLegend: true },
    title: summary, kind, seriesId: id, originalStart: start, recurring: false, rrule: null,
    ...(kind === 'reminder' ? { state: { doneAt: null, snoozedUntil: null } } : {}),
  };
}

function googleItem(id: string, summary: string, start: string, end: string, eventType?: string): ReadItem {
  const event: UnifiedEvent = {
    summary, start, end, calendarName: 'Family (kids)', calendarId: GOOGLE_IDS[0], eventId: id, provider: 'google',
    ...(eventType ? { eventType } : {}),
  };
  return {
    source: 'google', key: `google|${GOOGLE_IDS[0]}|${id}`, event,
    calendar: { id: GOOGLE_IDS[0], source: 'google', name: 'Kids', color: '#33b679', mine: true, inLegend: true },
    title: summary, kind: 'event', seriesId: null, originalStart: null, recurring: false, rrule: null,
    google: { birthday: eventType === 'birthday', htmlLink: null },
  };
}

const DENTIST = famcalItem('evt-dentist', 'Dentist', '2026-10-15T07:00:00.000Z', '2026-10-15T08:00:00.000Z');
const VITAMINS = famcalItem('rem-vitamins#2026-10-15T05:00:00.000Z', 'Vitamins', '2026-10-15T05:00:00.000Z', '2026-10-15T05:00:00.000Z', 'reminder');
const SWIM = googleItem('swim1', 'Swim practice', '2026-10-15T16:00:00+03:00', '2026-10-15T17:00:00+03:00');
const BIRTHDAY = googleItem('bday1', 'Dana birthday', '2026-10-15', '2026-10-16', 'birthday');

const CTX = { viewerId: 11, partner: null } as unknown as ViewerContext;
const famcalOk = (items: ReadItem[]): RangeRead => ({
  window: WINDOW, items, famcal: { status: 'ok', ctx: CTX, calendars: [], partner: null },
});
const famcalError = (cause: unknown): RangeRead => ({ window: WINDOW, items: [], famcal: { status: 'error', cause } });
const GOOGLE_OK: Extract<GoogleRead, { status: 'ok' }> = { status: 'ok', calendars: [], goneIds: [], partial: null, stale: false };
const googleRead = (google: GoogleRead, items: ReadItem[] = []): RangeRead => ({ window: WINDOW, items, google });
type ErrorReason = Extract<GoogleRead, { status: 'error' }>['reason'];
const googleError = (reason: ErrorReason) =>
  googleRead({ status: 'error', reason, cause: new Error(`${reason} (smoke)`) });
const reconnect = (reason: 'token' | 'scopes') => googleRead({ status: 'reconnect', reason });

/** week-lookahead.ts's endOfLocalDay: the inclusive last instant of `day` in `tz`. */
const endOfLocalDay = (day: string, tz: string) => new Date(startOfLocalDay(nextDate(day), tz).getTime() - 1);

/** What a failed adapter call threw, or a failure when it didn't. */
async function thrown(p: Promise<unknown>): Promise<Error & { day?: unknown }> {
  try {
    const got = await p;
    throw new Error(`expected a throw, got ${show(got)}`);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('expected a throw')) throw err;
    return err as Error & { day?: unknown };
  }
}

const eventsOf = (items: ReadItem[]) => items.map(i => i.event);
function assertSameEvents(got: CalendarEvent[], want: CalendarEvent[], what: string) {
  assert(got.length === want.length && got.every((e, i) => e === want[i]), `${what}: got ${show(got.map(e => e.summary))}, want ${show(want.map(e => e.summary))}`);
}

function assertOpts(call: Call, want: Record<string, unknown>, what: string) {
  const got: Record<string, unknown> = { ...call.opts };
  if (got.notBefore instanceof Date) got.notBefore = got.notBefore.toISOString();
  const keys = (o: Record<string, unknown>) => Object.keys(o).filter(k => o[k] !== undefined).sort();
  assert(show(keys(got)) === show(keys(want)), `${what}: option keys ${show(keys(got))}, want ${show(keys(want))}`);
  for (const k of keys(want)) assert(show(got[k]) === show(want[k]), `${what}: ${k} = ${show(got[k])}, want ${show(want[k])}`);
}

const warnings = () => captured.filter(c => c.level === 'warning' && c.context === 'calendar-read-digest');

function reset(...answers: Answer[]) {
  clock = BASE_CLOCK;
  reader.answers = answers;
  reader.calls.length = 0;
  sleeps.length = 0;
  captured.length = 0;
}

async function check(name: string, fn: () => Promise<void>) {
  reset();
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        watchdog = realSetTimeout(() => reject(new Error('did not settle within 5 s')), 5000);
      }),
    ]);
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  } finally {
    realClearTimeout(watchdog);
  }
}

async function main() {
  const { readDigestDay, readLookaheadEvents, DEFAULT_ON_DEMAND_READ, SCHEDULED_READ, SCHEDULED_RETRY_READ } = await import(
    '../src/services/calendar-read/digest'
  );
  globalThis.setTimeout = fakeSetTimeout;

  const ON_DEMAND: DigestRead = DEFAULT_ON_DEMAND_READ;
  const day = (user: UserConfig, read: DigestRead, d = DAY, ids = GOOGLE_IDS) => readDigestDay(user, d, IL, ids, read);

  await check('the read kinds: on demand 10,000 ms, scheduled 30,000 ms, the scheduled retry 15,000 ms, none changeable', async () => {
    assert(show(DEFAULT_ON_DEMAND_READ) === show({ mode: 'onDemand', deadlineMs: 10000 }), show(DEFAULT_ON_DEMAND_READ));
    assert(show(SCHEDULED_READ) === show({ mode: 'scheduled', deadlineMs: 30000 }), show(SCHEDULED_READ));
    assert(show(SCHEDULED_RETRY_READ) === show({ mode: 'scheduled', deadlineMs: 15000 }), show(SCHEDULED_RETRY_READ));
    for (const r of [DEFAULT_ON_DEMAND_READ, SCHEDULED_READ, SCHEDULED_RETRY_READ]) assert(Object.isFrozen(r), `${show(r)} is not frozen`);
  });

  await check("readDigestDay: a FamCal user's day is the reader's events in its order, read over [day, next day) on the summary's calendars, never through the Google cache", async () => {
    reset({ result: famcalOk([VITAMINS, DENTIST]) });
    const got = await day(famcalUser, ON_DEMAND, DAY, FAMCAL_IDS);
    assertSameEvents(got, eventsOf([VITAMINS, DENTIST]), 'events');
    assert(count(reader.calls) === 1, `${reader.calls.length} reads`);
    const [call] = reader.calls;
    assert(call.user === famcalUser, 'not the summary\'s own user row');
    assert(call.fromKey === DAY && call.toKey === TOMORROW, `window ${call.fromKey}..${call.toKey}`);
    assertOpts(call, { tz: IL, calendarIds: FAMCAL_IDS, googleCache: 'bypass', deadlineMs: 10000 }, 'options');
    assert(sleeps.length === 0 && captured.length === 0, `sleeps ${show(sleeps)}, captured ${show(captured)}`);
  });

  await check('readDigestDay: a scheduled tomorrow summary on 31 October reads [2026-10-31, 2026-11-01) with 30,000 ms; its retry with 15,000 ms', async () => {
    for (const [read, deadlineMs] of [[SCHEDULED_READ, 30000], [SCHEDULED_RETRY_READ, 15000]] as const) {
      reset({ result: famcalOk([DENTIST]) });
      const got = await day(famcalUser, read, '2026-10-31', FAMCAL_IDS);
      assertSameEvents(got, eventsOf([DENTIST]), 'events');
      const [call] = reader.calls;
      assert(call.fromKey === '2026-10-31' && call.toKey === '2026-11-01', `window ${call.fromKey}..${call.toKey}`);
      assertOpts(call, { tz: IL, calendarIds: FAMCAL_IDS, googleCache: 'bypass', deadlineMs }, `${deadlineMs} ms`);
    }
  });

  await check("readDigestDay: a Google user's day is what loaded, birthdays included, also when a calendar failed or is gone (A-11, A-26)", async () => {
    reset({ result: googleRead({ ...GOOGLE_OK, goneIds: ['old@group.calendar.google.com'], partial: { failed: 1, truncated: 1 } }, [BIRTHDAY, SWIM]) });
    const got = await day(googleUser, ON_DEMAND);
    assertSameEvents(got, eventsOf([BIRTHDAY, SWIM]), 'events');
    assert(count(reader.calls) === 1 && sleeps.length === 0, `${reader.calls.length} reads, sleeps ${show(sleeps)}`);
    assertOpts(reader.calls[0], { tz: IL, calendarIds: GOOGLE_IDS, googleCache: 'bypass', deadlineMs: 10000 }, 'options');
    assert(warnings().length === 0, show(captured));
  });

  await check('a dead token: GOOGLE_TOKEN_EXPIRED, with no retry, on demand and scheduled', async () => {
    for (const read of [ON_DEMAND, SCHEDULED_READ]) {
      reset({ result: reconnect('token'), takesMs: 300 });
      const err = await thrown(day(googleUser, read));
      assert(err instanceof Error && err.message === 'GOOGLE_TOKEN_EXPIRED', `${read.mode}: ${err.message}`);
      assert(count(reader.calls) === 1 && sleeps.length === 0, `${read.mode}: ${reader.calls.length} reads`);
    }
  });

  await check('missing scopes: GOOGLE_INSUFFICIENT_SCOPES, with no retry, on demand and scheduled', async () => {
    for (const read of [ON_DEMAND, SCHEDULED_READ]) {
      reset({ result: reconnect('scopes'), takesMs: 300 });
      const err = await thrown(day(googleUser, read));
      assert(err instanceof Error && err.message === 'GOOGLE_INSUFFICIENT_SCOPES', `${read.mode}: ${err.message}`);
      assert(count(reader.calls) === 1 && sleeps.length === 0, `${read.mode}: ${reader.calls.length} reads`);
    }
  });

  await check('a FamCal error rethrows its own cause, with no retry, so the pipeline answers as today (A-28)', async () => {
    for (const read of [ON_DEMAND, SCHEDULED_READ]) {
      const cause = new Error('Timed out fetching a new connection from the connection pool (smoke)');
      reset({ result: famcalError(cause), takesMs: 100 });
      const err = await thrown(day(famcalUser, read, DAY, FAMCAL_IDS));
      assert(err === cause, `${read.mode}: threw ${err.message}, not the cause`);
      assert(count(reader.calls) === 1 && sleeps.length === 0, `${read.mode}: ${reader.calls.length} reads`);
    }
  });

  await check('a Google user with no token reads nothing and gets no events, as the provider today', async () => {
    reset({ result: reconnect('token') });
    const dayGot = await day(tokenlessGoogleUser, ON_DEMAND);
    const weekGot = await readLookaheadEvents(tokenlessGoogleUser, new Date(clock), endOfLocalDay('2026-10-17', IL), IL, GOOGLE_IDS, SCHEDULED_READ);
    assert(dayGot.length === 0 && weekGot.length === 0, `${show(dayGot)} ${show(weekGot)}`);
    assert(reader.calls.length === 0, `${reader.calls.length} reads`);
  });

  await check('every chosen calendar gone: no events and one warning, with no retry and no outage code (R18)', async () => {
    for (const read of [ON_DEMAND, SCHEDULED_READ]) {
      reset({ result: googleError('calendars_gone'), takesMs: 300 });
      const got = await day(googleUser, read);
      assert(got.length === 0, `${read.mode}: ${show(got)}`);
      assert(count(reader.calls) === 1 && sleeps.length === 0, `${read.mode}: ${reader.calls.length} reads`);
      const w = warnings();
      assert(w.length === 1, `${read.mode}: warnings ${show(captured)}`);
      assert(w[0].extra?.user_id === 12 && w[0].extra?.day === DAY && w[0].extra?.mode === read.mode, `${read.mode}: extra ${show(w[0].extra)}`);
    }
  });

  await check("scheduled: a Google outage is GOOGLE_FETCH_FAILED carrying the read's day, after one read (C5 retries later)", async () => {
    for (const read of [SCHEDULED_READ, SCHEDULED_RETRY_READ]) {
      reset({ result: googleError('transient'), takesMs: 300 });
      const err = await thrown(day(googleUser, read, TOMORROW));
      assert(err instanceof Error && err.message === 'GOOGLE_FETCH_FAILED', `${read.deadlineMs}: ${err.message}`);
      assert(err.day === TOMORROW, `${read.deadlineMs}: day ${show(err.day)}`);
      assert(count(reader.calls) === 1 && sleeps.length === 0, `${read.deadlineMs}: ${reader.calls.length} reads, sleeps ${show(sleeps)}`);
      assert(reader.calls[0].opts.deadlineMs === read.deadlineMs, `deadline ${reader.calls[0].opts.deadlineMs}`);
    }
  });

  await check('on demand: a fast failure is read once more, 1 s later, with 8,000 ms, and that read is the answer (R13)', async () => {
    reset({ result: googleError('transient'), takesMs: 400 }, { result: googleRead(GOOGLE_OK, [SWIM]), takesMs: 600 });
    const got = await day(googleUser, ON_DEMAND);
    assertSameEvents(got, eventsOf([SWIM]), 'events');
    assert(count(reader.calls) === 2, `${reader.calls.length} reads`);
    const [first, second] = reader.calls;
    assertOpts(first, { tz: IL, calendarIds: GOOGLE_IDS, googleCache: 'bypass', deadlineMs: 10000 }, 'first read');
    assertOpts(second, { tz: IL, calendarIds: GOOGLE_IDS, googleCache: 'bypass', deadlineMs: 8000 }, 'second read');
    assert(second.fromKey === DAY && second.toKey === TOMORROW, `second window ${second.fromKey}..${second.toKey}`);
    assert(show(sleeps.map(s => s.ms)) === show([1000]), `pauses ${show(sleeps)}`);
    assert(second.at - first.at === 400 + 1000, `the second read began ${second.at - first.at} ms after the first`);
  });

  await check("on demand: a second failure is GOOGLE_FETCH_FAILED with the day, after exactly two reads", async () => {
    reset({ result: googleError('transient'), takesMs: 300 });
    const err = await thrown(day(googleUser, ON_DEMAND, TOMORROW));
    assert(err.message === 'GOOGLE_FETCH_FAILED' && err.day === TOMORROW, `${err.message} ${show(err.day)}`);
    assert(count(reader.calls) === 2 && sleeps.length === 1, `${reader.calls.length} reads, ${sleeps.length} pauses`);
  });

  await check('on demand: the quick retry is for a failure within 5,000 ms: one that took 5,000 ms is retried, 5,001 ms is not', async () => {
    reset({ result: googleError('transient'), takesMs: 5000 }, { result: googleRead(GOOGLE_OK, [SWIM]) });
    const got = await day(googleUser, ON_DEMAND);
    assertSameEvents(got, eventsOf([SWIM]), '5,000 ms');
    assert(count(reader.calls) === 2, `5,000 ms: ${reader.calls.length} reads`);
    reset({ result: googleError('transient'), takesMs: 5001 }, { result: googleRead(GOOGLE_OK, [SWIM]) });
    const err = await thrown(day(googleUser, ON_DEMAND));
    assert(err.message === 'GOOGLE_FETCH_FAILED', `5,001 ms: ${err.message}`);
    assert(count(reader.calls) === 1 && sleeps.length === 0, `5,001 ms: ${reader.calls.length} reads`);
  });

  await check('on demand: a timeout gets no quick retry, however fast it came back', async () => {
    for (const takesMs of [10000, 100]) {
      reset({ result: googleError('timeout'), takesMs }, { result: googleRead(GOOGLE_OK, [SWIM]) });
      const err = await thrown(day(googleUser, ON_DEMAND));
      assert(err.message === 'GOOGLE_FETCH_FAILED' && err.day === DAY, `${takesMs} ms: ${err.message}`);
      assert(count(reader.calls) === 1 && sleeps.length === 0, `${takesMs} ms: ${reader.calls.length} reads`);
    }
  });

  await check('on demand: every other failure is retried once: transient, config, unknown', async () => {
    for (const reason of ['transient', 'config', 'unknown'] as const) {
      reset({ result: googleError(reason), takesMs: 250 }, { result: googleRead(GOOGLE_OK, [SWIM]) });
      const got = await day(googleUser, ON_DEMAND);
      assertSameEvents(got, eventsOf([SWIM]), reason);
      assert(count(reader.calls) === 2, `${reason}: ${reader.calls.length} reads`);
    }
  });

  await check("on demand: the retry's own ending decides: a dead token, missing scopes, or every calendar gone", async () => {
    reset({ result: googleError('transient'), takesMs: 300 }, { result: reconnect('token') });
    assert((await thrown(day(googleUser, ON_DEMAND))).message === 'GOOGLE_TOKEN_EXPIRED', 'token');
    reset({ result: googleError('transient'), takesMs: 300 }, { result: reconnect('scopes') });
    assert((await thrown(day(googleUser, ON_DEMAND))).message === 'GOOGLE_INSUFFICIENT_SCOPES', 'scopes');
    reset({ result: googleError('transient'), takesMs: 300 }, { result: googleError('calendars_gone') });
    const got = await day(googleUser, ON_DEMAND);
    assert(got.length === 0 && warnings().length === 1 && count(reader.calls) === 2, `gone: ${show(got)}, ${show(captured)}, ${reader.calls.length} reads`);
  });

  await check('on demand: calendars gone on the first read are not retried', async () => {
    reset({ result: googleError('calendars_gone'), takesMs: 100 }, { result: googleRead(GOOGLE_OK, [SWIM]) });
    const got = await day(googleUser, ON_DEMAND);
    assert(got.length === 0 && count(reader.calls) === 1 && sleeps.length === 0, `${show(got)}, ${reader.calls.length} reads`);
  });

  await check('a reader that throws (a caller\'s empty window): the same error goes up, with no retry', async () => {
    const bug = new RangeError('readRange: empty window (smoke)');
    reset({ result: bug, takesMs: 0 });
    const err = await thrown(day(googleUser, ON_DEMAND));
    assert(err === bug && count(reader.calls) === 1 && sleeps.length === 0, `${err.message}, ${reader.calls.length} reads`);
  });

  await check("readLookaheadEvents: This week from now reads [today, the day after the last) clipped to now, which is today's [now, end of the last day]", async () => {
    const start = new Date(clock);
    const end = endOfLocalDay('2026-10-17', IL);
    reset({ result: googleRead(GOOGLE_OK, [SWIM, BIRTHDAY]) });
    const got = await readLookaheadEvents(googleUser, start, end, IL, GOOGLE_IDS, ON_DEMAND);
    assertSameEvents(got, eventsOf([SWIM, BIRTHDAY]), 'events');
    assert(count(reader.calls) === 1, `${reader.calls.length} reads`);
    const [call] = reader.calls;
    assert(call.user === googleUser, 'not the user row');
    assert(call.fromKey === DAY && call.toKey === '2026-10-18', `window ${call.fromKey}..${call.toKey}`);
    assertOpts(call, { tz: IL, calendarIds: GOOGLE_IDS, notBefore: start.toISOString(), googleCache: 'bypass', deadlineMs: 10000 }, 'options');
  });

  await check("readLookaheadEvents: the reader's window is exactly [start, end + 1 ms) in New York, Kiritimati, on Israel's 25 October change and Chile's midnight change", async () => {
    // Chile's clocks go from 00:00 to 01:00 on 6 September 2026: that day starts at 01:00.
    const santiagoStart = startOfLocalDay('2026-09-06', 'America/Santiago');
    assert(formatInTimeZone(santiagoStart, 'America/Santiago', 'yyyy-MM-dd HH:mm') === '2026-09-06 01:00', `fixture: Chile's day starts ${formatInTimeZone(santiagoStart, 'America/Santiago', 'yyyy-MM-dd HH:mm')}`);
    const cases: { tz: string; start: Date; last: string; what: string }[] = [
      { tz: 'America/New_York', start: new Date('2026-10-15T23:30:00.000Z'), last: '2026-10-18', what: 'New York this week, at 19:30' },
      { tz: 'Pacific/Kiritimati', start: new Date('2026-10-15T10:30:00.000Z'), last: '2026-10-18', what: 'Kiritimati this week, past midnight' },
      { tz: IL, start: startOfLocalDay('2026-10-25', IL), last: '2026-10-31', what: 'Israel next week from 25 October (25-hour day)' },
      { tz: IL, start: new Date('2026-10-24T09:00:00.000Z'), last: '2026-10-25', what: 'Israel this week through 25 October' },
      { tz: 'America/Santiago', start: santiagoStart, last: '2026-09-12', what: 'Chile next week from 6 September' },
      { tz: 'America/Santiago', start: new Date('2026-09-04T15:00:00.000Z'), last: '2026-09-05', what: 'Chile this week through 5 September' },
    ];
    for (const c of cases) {
      const end = endOfLocalDay(c.last, c.tz);
      reset({ result: googleRead(GOOGLE_OK, [SWIM]) });
      await readLookaheadEvents(googleUser, c.start, end, c.tz, GOOGLE_IDS, SCHEDULED_READ);
      const [call] = reader.calls;
      const from = Math.max(startOfLocalDay(call.fromKey, c.tz).getTime(), call.opts.notBefore?.getTime() ?? -Infinity);
      const to = startOfLocalDay(call.toKey, c.tz).getTime();
      assert(call.fromKey === localDate(c.start, c.tz) && call.toKey === nextDate(c.last), `${c.what}: ${call.fromKey}..${call.toKey}`);
      assert(from === c.start.getTime(), `${c.what}: the window starts ${new Date(from).toISOString()}, not ${c.start.toISOString()}`);
      assert(to === end.getTime() + 1, `${c.what}: the window ends ${new Date(to).toISOString()}, not ${new Date(end.getTime() + 1).toISOString()}`);
      assert(call.opts.tz === c.tz && call.opts.deadlineMs === 30000, `${c.what}: ${show(call.opts)}`);
    }
  });

  await check("readLookaheadEvents: GOOGLE_FETCH_FAILED carries the range's first day in the user's zone, not the server's", async () => {
    // 22:30 UTC on 15 October is 01:30 on 16 October in Israel.
    const start = new Date('2026-10-15T22:30:00.000Z');
    reset({ result: googleError('transient'), takesMs: 300 });
    const err = await thrown(readLookaheadEvents(googleUser, start, endOfLocalDay('2026-10-17', IL), IL, GOOGLE_IDS, SCHEDULED_READ));
    assert(err.message === 'GOOGLE_FETCH_FAILED' && err.day === TOMORROW, `${err.message} ${show(err.day)}`);
    assert(reader.calls[0].fromKey === TOMORROW, `fromKey ${reader.calls[0].fromKey}`);
  });

  await check('readLookaheadEvents: the endings of the day read: a quick retry over the same window, a dead token, every calendar gone', async () => {
    const start = new Date(clock);
    const end = endOfLocalDay('2026-10-17', IL);
    reset({ result: googleError('transient'), takesMs: 300 }, { result: googleRead(GOOGLE_OK, [SWIM]) });
    const got = await readLookaheadEvents(googleUser, start, end, IL, GOOGLE_IDS, ON_DEMAND);
    assertSameEvents(got, eventsOf([SWIM]), 'retry');
    assert(count(reader.calls) === 2, `retry: ${reader.calls.length} reads`);
    assertOpts(reader.calls[1], { tz: IL, calendarIds: GOOGLE_IDS, notBefore: start.toISOString(), googleCache: 'bypass', deadlineMs: 8000 }, 'retry options');
    assert(reader.calls[1].fromKey === DAY && reader.calls[1].toKey === '2026-10-18', 'retry window');

    reset({ result: reconnect('token') });
    const err = await thrown(readLookaheadEvents(googleUser, start, end, IL, GOOGLE_IDS, ON_DEMAND));
    assert(err.message === 'GOOGLE_TOKEN_EXPIRED' && count(reader.calls) === 1, `token: ${err.message}`);

    reset({ result: googleError('calendars_gone') });
    const gone = await readLookaheadEvents(googleUser, start, end, IL, GOOGLE_IDS, ON_DEMAND);
    assert(gone.length === 0 && warnings().length === 1, `gone: ${show(gone)} ${show(captured)}`);
  });

  await check('no summary read asks for the Google cache or hands the reader a background task', async () => {
    assert(reader.allCalls.length >= 30, `only ${reader.allCalls.length} reads were made above`);
    for (const c of reader.allCalls) {
      assert(c.opts.googleCache === 'bypass', `googleCache ${show(c.opts.googleCache)}`);
      assert(!('defer' in c.opts) && !('sources' in c.opts), `options ${show(Object.keys(c.opts))}`);
    }
  });

  globalThis.setTimeout = realSetTimeout;

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

- [ ] **Step 2: Run it and see it fail**

```bash
cd /Users/razielgershoni/development/famcalbot
for tz in UTC Asia/Jerusalem Pacific/Kiritimati; do TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-digest-adapters.ts 2>&1 | grep -m1 -E 'ERR_MODULE_NOT_FOUND|passed'; echo "smoke-digest-adapters $tz exit=${pipestatus[1]}"; done
```
(Run it in zsh: `pipestatus` is zsh's, and in bash it is `${PIPESTATUS[0]}`.)

Expected, under each clock:
```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/razielgershoni/development/famcalbot/src/services/calendar-read/digest' imported from /Users/razielgershoni/development/famcalbot/scripts/smoke-digest-adapters.ts
smoke-digest-adapters UTC exit=1
```
(then the same for `Asia/Jerusalem` and `Pacific/Kiritimati`).

Why it fails: `digest.ts` doesn't exist yet. The smoke loads it after installing its stubs, so the missing module stops it before any check runs.

- [ ] **Step 3: Create `src/services/calendar-read/digest.ts`**

```ts
// The summaries' calendar read (calendar home spec §3.1 "Adapters"): the day of a daily
// or tomorrow summary, and the range of the week block, /week and /nextweek, read
// through the shared reader for the users the rollout switch covers. The callers
// (telegram/summary.ts, week-lookahead.ts) ask the switch; nothing here does.
//
// The summary gets each item's event exactly as the reader carries it, in the reader's
// order, so its own shaping and prompts run as they do today (Appendix A). This file
// decides how a read ends:
// - a dead token or missing scopes throw the codes the summaries already answer,
//   GOOGLE_TOKEN_EXPIRED and GOOGLE_INSUFFICIENT_SCOPES;
// - any other Google failure throws GOOGLE_FETCH_FAILED with the read's first day, so
//   a scheduled run can retry that same day about 30 s later (spec §3.3 C5) and an
//   on-demand run can say Google couldn't be reached (Ruling R13);
// - before that, an on-demand read that failed fast gets one quick retry here, inside
//   the command's 50 s limit;
// - when every chosen calendar is gone, the day has no Google events and a warning
//   goes to Sentry, with no retry (Ruling R18);
// - a FamCal (database) error rethrows its own cause, so the pipeline's error texts
//   and admin notice stay as they are (A-28).
//
// Summary reads never use the Google cache ('bypass'), so they never read, write or
// stamp it (A-30).

import type { CalendarEvent, UserConfig } from '../../types';
import { captureWarning } from '../../lib/error-capture';
import { localDate, nextDate } from '../../utils/day-events';
import { readRange } from './index';
import type { DayKey, RangeRead, ReadRangeOptions } from './types';

/** A summary run's kind, and the Google deadline of its reads (spec §2.2 Deadlines). */
export type DigestRead = { mode: 'scheduled' | 'onDemand'; deadlineMs: number };

/** On demand: the daily and tomorrow summaries, the tomorrow week block, /week and /nextweek. */
export const DEFAULT_ON_DEMAND_READ: DigestRead = Object.freeze({ mode: 'onDemand', deadlineMs: 10_000 });
/** A scheduled run's first attempt: the day read and the week block. */
export const SCHEDULED_READ: DigestRead = Object.freeze({ mode: 'scheduled', deadlineMs: 30_000 });
/** A scheduled run's retry, about 30 s after the first failure (spec §3.3 C5): the day read and the week block. */
export const SCHEDULED_RETRY_READ: DigestRead = Object.freeze({ mode: 'scheduled', deadlineMs: 15_000 });

/** An on-demand read whose Google half failed within this time of its start is tried once more. */
const QUICK_RETRY_WITHIN_MS = 5_000;
/** The pause before that retry. */
const QUICK_RETRY_PAUSE_MS = 1_000;
/** The retry's deadline. With the two above, one on-demand read takes at most about 14 s of Google time. */
const QUICK_RETRY_DEADLINE_MS = 8_000;

const LOG_CONTEXT = 'calendar-read-digest';

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** The reader's window: [fromKey, toKey) in the user's timezone, clipped to notBefore. */
type DigestWindow = { fromKey: DayKey; toKey: DayKey; notBefore?: Date };

/**
 * A Google user with no refresh token gets no Google events, as the provider gives
 * today (google-provider.ts:74, :80, :86). The reader would answer reconnect('token'),
 * which reads as an expired token.
 */
function googleWithoutToken(user: UserConfig): boolean {
  return user.calendarSource === 'GOOGLE' && !user.googleRefreshToken;
}

/**
 * Worth one quick retry: the Google half failed, fast. A timeout has already used its
 * time, and a retry can't bring back calendars that are gone.
 */
function worthQuickRetry(result: RangeRead, tookMs: number): boolean {
  const google = result.google;
  return (
    google?.status === 'error' &&
    google.reason !== 'timeout' &&
    google.reason !== 'calendars_gone' &&
    tookMs <= QUICK_RETRY_WITHIN_MS
  );
}

/**
 * One summary read through the reader, never through the Google cache. On demand, a
 * Google failure within 5 s is read once more, about 1 s later, with an 8 s deadline;
 * the second result is the answer. A scheduled read never retries here; sendSummaryToAll's
 * retry queue does (spec §3.3 C5).
 */
async function readForDigest(
  user: UserConfig,
  window: DigestWindow,
  tz: string,
  ids: readonly string[],
  read: DigestRead
): Promise<RangeRead> {
  const optionsWith = (deadlineMs: number): ReadRangeOptions => ({
    tz,
    calendarIds: ids,
    ...(window.notBefore ? { notBefore: window.notBefore } : {}),
    googleCache: 'bypass',
    deadlineMs,
  });
  const startedAt = Date.now();
  const first = await readRange(user, window.fromKey, window.toKey, optionsWith(read.deadlineMs));
  if (read.mode !== 'onDemand' || !worthQuickRetry(first, Date.now() - startedAt)) return first;
  await pause(QUICK_RETRY_PAUSE_MS);
  return readRange(user, window.fromKey, window.toKey, optionsWith(QUICK_RETRY_DEADLINE_MS));
}

/**
 * A read as the summaries take it (spec §3.1, throwForDigest):
 *
 * | Read result                  | Result                                                |
 * |------------------------------|-------------------------------------------------------|
 * | FamCal error                 | rethrow the cause                                     |
 * | reconnect('scopes')          | GOOGLE_INSUFFICIENT_SCOPES                            |
 * | reconnect('token')           | GOOGLE_TOKEN_EXPIRED                                  |
 * | error('calendars_gone')      | no Google events, plus a warning                      |
 * | any other error              | GOOGLE_FETCH_FAILED, with `day`: the read's first day |
 * | ok (with or without partial) | what loaded, as today                                 |
 *
 * A Google half that isn't ok contributes no items, so what is returned then is the
 * FamCal half's (none, in step 1, where a user has one source).
 */
function throwForDigest(result: RangeRead, user: UserConfig, day: DayKey, read: DigestRead): CalendarEvent[] {
  if (result.famcal?.status === 'error') throw result.famcal.cause;
  const google = result.google;
  if (google?.status === 'reconnect') {
    throw new Error(google.reason === 'scopes' ? 'GOOGLE_INSUFFICIENT_SCOPES' : 'GOOGLE_TOKEN_EXPIRED');
  }
  if (google?.status === 'error') {
    if (google.reason !== 'calendars_gone') throw Object.assign(new Error('GOOGLE_FETCH_FAILED'), { day });
    captureWarning(
      'Every chosen Google calendar is gone (deleted, unshared or on another account); the summary has no Google events',
      LOG_CONTEXT,
      { user_id: user.id, day, mode: read.mode }
    );
  }
  return result.items.map(item => item.event);
}

/**
 * The events of `day` (yyyy-MM-dd in `tz`) for a daily or tomorrow summary:
 * readRange over [day, next day) on the calendars the summary resolved (`ids`). The
 * summary still shapes them (shapeEventsForDay), as it shapes the provider's today.
 * Throws as throwForDigest says; GOOGLE_FETCH_FAILED carries `day`.
 */
export async function readDigestDay(
  user: UserConfig,
  day: DayKey,
  tz: string,
  ids: readonly string[],
  read: DigestRead
): Promise<CalendarEvent[]> {
  if (googleWithoutToken(user)) return [];
  const result = await readForDigest(user, { fromKey: day, toKey: nextDate(day) }, tz, ids, read);
  return throwForDigest(result, user, day, read);
}

/**
 * The events of a lookahead range for the week block, /week and /nextweek: from the
 * instant `start` (This week starts now; the tomorrow block at the summary day's noon)
 * to `end`, the inclusive last instant of the range's last day (week-lookahead.ts's
 * endOfLocalDay). That is readRange over [start's day, the day after end's day),
 * clipped to start, so it covers [start, end] as today's Google read does. Throws as
 * throwForDigest says; GOOGLE_FETCH_FAILED carries start's day in `tz`.
 */
export async function readLookaheadEvents(
  user: UserConfig,
  start: Date,
  end: Date,
  tz: string,
  ids: readonly string[],
  read: DigestRead
): Promise<CalendarEvent[]> {
  if (googleWithoutToken(user)) return [];
  const firstDay = localDate(start, tz);
  const window = { fromKey: firstDay, toKey: nextDate(localDate(end, tz)), notBefore: start };
  const result = await readForDigest(user, window, tz, ids, read);
  return throwForDigest(result, user, firstDay, read);
}
```

- [ ] **Step 4: Run the smoke again**

```bash
cd /Users/razielgershoni/development/famcalbot
for tz in UTC Asia/Jerusalem Pacific/Kiritimati; do TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-digest-adapters.ts; echo "smoke-digest-adapters $tz exit=$?"; done
```

Expected under `TZ=UTC` (on Node 26 a tsx `DEP0205` deprecation line and its hint may come first; they are tsx's own):
```
OK    the read kinds: on demand 10,000 ms, scheduled 30,000 ms, the scheduled retry 15,000 ms, none changeable
OK    readDigestDay: a FamCal user's day is the reader's events in its order, read over [day, next day) on the summary's calendars, never through the Google cache
OK    readDigestDay: a scheduled tomorrow summary on 31 October reads [2026-10-31, 2026-11-01) with 30,000 ms; its retry with 15,000 ms
OK    readDigestDay: a Google user's day is what loaded, birthdays included, also when a calendar failed or is gone (A-11, A-26)
OK    a dead token: GOOGLE_TOKEN_EXPIRED, with no retry, on demand and scheduled
OK    missing scopes: GOOGLE_INSUFFICIENT_SCOPES, with no retry, on demand and scheduled
OK    a FamCal error rethrows its own cause, with no retry, so the pipeline answers as today (A-28)
OK    a Google user with no token reads nothing and gets no events, as the provider today
OK    every chosen calendar gone: no events and one warning, with no retry and no outage code (R18)
OK    scheduled: a Google outage is GOOGLE_FETCH_FAILED carrying the read's day, after one read (C5 retries later)
OK    on demand: a fast failure is read once more, 1 s later, with 8,000 ms, and that read is the answer (R13)
OK    on demand: a second failure is GOOGLE_FETCH_FAILED with the day, after exactly two reads
OK    on demand: the quick retry is for a failure within 5,000 ms: one that took 5,000 ms is retried, 5,001 ms is not
OK    on demand: a timeout gets no quick retry, however fast it came back
OK    on demand: every other failure is retried once: transient, config, unknown
OK    on demand: the retry's own ending decides: a dead token, missing scopes, or every calendar gone
OK    on demand: calendars gone on the first read are not retried
OK    a reader that throws (a caller's empty window): the same error goes up, with no retry
OK    readLookaheadEvents: This week from now reads [today, the day after the last) clipped to now, which is today's [now, end of the last day]
OK    readLookaheadEvents: the reader's window is exactly [start, end + 1 ms) in New York, Kiritimati, on Israel's 25 October change and Chile's midnight change
OK    readLookaheadEvents: GOOGLE_FETCH_FAILED carries the range's first day in the user's zone, not the server's
OK    readLookaheadEvents: the endings of the day read: a quick retry over the same window, a dead token, every calendar gone
OK    no summary read asks for the Google cache or hands the reader a background task

23/23 passed (process TZ=UTC)
smoke-digest-adapters UTC exit=0
```
Then the same 23 lines with `(process TZ=Asia/Jerusalem)` and `(process TZ=Pacific/Kiritimati)`, each `exit=0`. The checks pass every time zone to the adapters explicitly, so the server's clock changes nothing.

If only the Chile check fails, with "fixture: Chile's day starts …", the machine's time-zone data doesn't have Chile's 2026 rule (clocks go from 00:00 to 01:00 on 6 September). Update Node; don't change the check.

- [ ] **Step 5: Write the failing smoke `scripts/smoke-calendar-read-google-cancel.ts`**

Create the file with exactly this content:

```ts
// Smoke test for what the reader's Google half leaves running (calendar home spec §2.5
// "Deadline"; Plan C Task C1): src/services/calendar-read/google.ts on the real Google
// client.
//
// A summary reads Google with a deadline of 8 to 30 s. When the deadline fires, the read
// answers at once. The requests it gave up on are cancelled then: a token request that a
// stuck token server never answers, and lists still waiting. So nothing keeps running,
// retries or holds a timer after the answer, also in a scheduled batch during a stall. The
// token request also gets a timeout no longer than the deadline, and every list request a
// timeout of at least 1 s.
//
// The real google.ts, calendar.ts (getGoogleAuth), @googleapis/calendar, its
// google-auth-library and gaxios run, retries included. Only gaxios's HTTP adapter is
// replaced (as in smoke-google-map.ts), by a fake that answers as Google does, or hangs
// as node-fetch does: until the request is aborted (an AbortError) or its own timeout
// passes (a request-timeout FetchError). Redis and error capture are faked. Timers are
// real, with short deadlines. No network.
//
// Run under both clocks; the output must not depend on the server's timezone:
//   TZ=UTC npx tsx scripts/smoke-calendar-read-google-cancel.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-calendar-read-google-cancel.ts

import Module, { createRequire } from 'node:module';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { UserConfig } from '../src/types';
import type { GoogleReadOptions, GoogleReadResult } from '../src/services/calendar-read/google';

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

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

const show = (v: unknown) => JSON.stringify(v);

function assertEq(got: unknown, want: unknown, what: string) {
  assert(show(got) === show(want), `${what}\n     got  ${show(got)}\n     want ${show(want)}`);
}

/** Anything that slips past the fake adapter is refused and counted. */
const networkAttempts: string[] = [];
globalThis.fetch = (async (input: unknown) => {
  networkAttempts.push(String(input));
  throw new Error('network is blocked in this smoke test');
}) as typeof fetch;

// ---- The fake Google: gaxios's HTTP adapter, replaced ----

type GaxiosOpts = Record<string, unknown> & { url?: unknown; timeout?: number; signal?: AbortSignal };

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const calendarRequire = createRequire(require.resolve('@googleapis/calendar'));
const gaxiosModule = calendarRequire('gaxios') as {
  Gaxios: { prototype: { _defaultAdapter: (this: unknown, opts: GaxiosOpts) => Promise<unknown> } };
};
const nodeFetch = createRequire(calendarRequire.resolve('gaxios'))('node-fetch') as {
  FetchError: new (message: string, type: string) => Error;
};

/** How the fake answers a request: at once, or never (until aborted or timed out). */
type Behaviour = 'answer' | 'hang';
let tokenBehaviour: Behaviour = 'answer';
let listBehaviour: Behaviour = 'answer';

/** Every request the client made: what it was, its timeout, whether it carried a signal, and how it ended. */
type Request = { what: string; timeout: number | null; signal: boolean; ended: string };
let requests: Request[] = [];
/** Requests still waiting for an answer. */
let waiting = 0;

function abortError(): Error {
  // What node-fetch rejects with when the request's signal is aborted.
  return Object.assign(new Error('The user aborted a request.'), { name: 'AbortError', type: 'aborted' });
}

function installFakeGoogle(): void {
  // The calendar client and its auth library must share the one gaxios whose adapter is
  // replaced; otherwise a request could reach the network.
  const authGaxios = createRequire(calendarRequire.resolve('google-auth-library'))('gaxios');
  const commonGaxios = createRequire(calendarRequire.resolve('googleapis-common'))('gaxios');
  if (authGaxios !== gaxiosModule || commonGaxios !== gaxiosModule) {
    console.error('FAIL  the Google client loads more than one gaxios; refusing to run without the fake');
    process.exit(1);
  }
  gaxiosModule.Gaxios.prototype._defaultAdapter = async function (opts: GaxiosOpts) {
    const url = String(opts.url);
    const isToken = url === TOKEN_URL;
    const request: Request = {
      what: isToken ? 'token' : `list ${decodeURIComponent(new URL(url).pathname.split('/')[4] ?? '?')}`,
      timeout: typeof opts.timeout === 'number' && opts.timeout > 0 ? opts.timeout : null,
      signal: opts.signal !== undefined,
      ended: 'waiting',
    };
    requests.push(request);
    if (!isToken && !url.startsWith('https://www.googleapis.com/calendar/v3/')) throw new Error(`unexpected request ${url}`);
    const respond = (status: number, data: unknown) => {
      request.ended = 'answered';
      return { config: opts, data, headers: {}, status, statusText: String(status), request: { responseURL: url } };
    };
    if ((isToken ? tokenBehaviour : listBehaviour) === 'answer') {
      return isToken
        ? respond(200, { access_token: 'fake-access', expires_in: 3600, token_type: 'Bearer' })
        : respond(200, { summary: 'Family', items: [] });
    }
    waiting++;
    try {
      return await new Promise<never>((_resolve, reject) => {
        const signal = opts.signal;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const onAbort = () => {
          clearTimeout(timer);
          request.ended = 'aborted';
          reject(abortError());
        };
        if (signal?.aborted) return onAbort();
        signal?.addEventListener('abort', onAbort, { once: true });
        if (request.timeout !== null) {
          timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            request.ended = 'timed out';
            reject(new nodeFetch.FetchError(`network timeout at: ${url}`, 'request-timeout'));
          }, request.timeout);
        }
      });
    } finally {
      waiting--;
    }
  };
}

// ---- Fixtures ----

const NY = 'America/New_York';
const WINDOW = { from: new Date('2026-10-22T04:00:00.000Z'), to: new Date('2026-10-23T04:00:00.000Z') };
const user = {
  id: 7, telegramId: 1007, name: 'Gali', calendarSource: 'GOOGLE', googleRefreshToken: 'refresh-gali',
  calendarAssignments: [
    { calendarId: 'gali@example.com', labels: ['yours'], name: 'Gali', color: '#039BE5' },
    { calendarId: 'family@group.calendar.google.com', labels: [], name: 'Family', color: '#33b679' },
  ],
} as unknown as UserConfig;

/** Timers still pending in this process: the reader's deadline, a request timeout, a retry's backoff. */
const pendingTimers = () => process.getActiveResourcesInfo().filter(r => r === 'Timeout').length;
/** Let rejections and their handlers run out. */
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
};

const captured: string[] = [];

async function main() {
  installFakeGoogle();

  const SRC = path.resolve(__dirname, '../src');
  const cache = (Module as unknown as { _cache: Record<string, unknown> })._cache;
  const stub = (file: string, exports: Record<string, unknown>) => {
    const filename = path.join(SRC, file);
    const mod = new Module(filename);
    Object.assign(mod, { filename, loaded: true, exports });
    cache[filename] = mod;
  };
  stub('lib/error-capture.ts', {
    captureError: (error: unknown, context: string, _extra?: unknown, severity = 'error') => {
      captured.push(`${context} ${severity} ${error instanceof Error ? error.message : String(error)}`);
    },
    captureWarning: (message: string, context: string) => {
      captured.push(`${context} warning ${message}`);
    },
    captureInfo: () => {},
  });
  stub('utils/redis.ts', { redis: { get: async () => null, set: async () => 'OK', del: async () => 0, mget: async () => [] } });

  const { readGoogleUncached } = (await import('../src/services/calendar-read/google')) as {
    readGoogleUncached: (u: UserConfig, w: { from: Date; to: Date }, o: GoogleReadOptions) => Promise<GoogleReadResult>;
  };

  /** One read, timed, with what it left behind once its rejections have run out. */
  async function read(deadlineMs: number) {
    requests = [];
    captured.length = 0;
    const timersBefore = pendingTimers();
    const started = performance.now();
    const result = await readGoogleUncached(user, WINDOW, { tz: NY, deadlineMs });
    const ms = performance.now() - started;
    await settle();
    return { status: { ...result.read, cause: undefined }, ms, waiting, timersLeft: pendingTimers() - timersBefore };
  }

  await check('a token server that never answers: error timeout at the deadline; the token request is cancelled then, with no retry, no request and no timer left', async () => {
    tokenBehaviour = 'hang';
    listBehaviour = 'answer';
    const r = await read(1500);
    assertEq(r.status, { status: 'error', reason: 'timeout' }, 'the read');
    assert(r.ms >= 1450 && r.ms < 2000, `answered after ${r.ms.toFixed(0)} ms`);
    assertEq(requests, [{ what: 'token', timeout: 1500, signal: true, ended: 'aborted' }], 'the requests');
    assertEq([r.waiting, r.timersLeft], [0, 0], 'requests still waiting, timers still pending');
    assertEq(captured, ['calendar-read-google warning Google read passed its 1500 ms deadline in the token step'], 'what was reported');
  });

  await check('lists still waiting at the deadline are cancelled too: error timeout, both requests aborted, nothing left', async () => {
    tokenBehaviour = 'answer';
    listBehaviour = 'hang';
    const r = await read(900);
    assertEq(r.status, { status: 'error', reason: 'timeout' }, 'the read');
    assert(r.ms >= 850 && r.ms < 1400, `answered after ${r.ms.toFixed(0)} ms`);
    assertEq(requests.map(q => `${q.what} ${q.ended}`), [
      'token answered',
      'list gali@example.com aborted',
      'list family@group.calendar.google.com aborted',
    ], 'the requests');
    assertEq([r.waiting, r.timersLeft], [0, 0], 'requests still waiting, timers still pending');
  });

  await check('the request timeouts: the token request gets the deadline, each list min(10 s, deadline - 0.5 s), never under 1 s', async () => {
    tokenBehaviour = 'answer';
    listBehaviour = 'answer';
    const got: string[] = [];
    for (const deadlineMs of [30000, 15000, 10000, 8000, 6000, 1200, 900]) {
      const r = await read(deadlineMs);
      assert(r.status.status === 'ok', `${deadlineMs}: ${show(r.status)}`);
      got.push(`${deadlineMs}: ${requests.map(q => `${q.what.split(' ')[0]} ${q.timeout}`).join(', ')}`);
    }
    assertEq(got, [
      '30000: token 30000, list 10000, list 10000',
      '15000: token 15000, list 10000, list 10000',
      '10000: token 10000, list 9500, list 9500',
      '8000: token 8000, list 7500, list 7500',
      '6000: token 6000, list 5500, list 5500',
      '1200: token 1200, list 1000, list 1000',
      '900: token 900, list 1000, list 1000',
    ], 'timeouts by deadline');
  });

  await check('a read that answers in time leaves nothing running either, and every request carried the cancel signal', async () => {
    tokenBehaviour = 'answer';
    listBehaviour = 'answer';
    const r = await read(10000);
    assert(r.status.status === 'ok', show(r.status));
    assertEq(requests.map(q => `${q.what} ${q.ended}${q.signal ? '' : ' (no signal)'}`), [
      'token answered',
      'list gali@example.com answered',
      'list family@group.calendar.google.com answered',
    ], 'the requests');
    assertEq([r.waiting, r.timersLeft], [0, 0], 'requests still waiting, timers still pending');
  });

  await check('nothing reached the network', async () => {
    assertEq(networkAttempts, [], 'network attempts');
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  // A request the read left waiting (the failure this smoke catches) would hold the process open.
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 6: Run it and see it fail; record the baseline of Plan B's smokes over the files Steps 7-8 change**

```bash
cd /Users/razielgershoni/development/famcalbot
for tz in UTC Asia/Jerusalem Pacific/Kiritimati; do TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-calendar-read-google-cancel.ts 2>&1 | grep -E '^(OK|FAIL)|passed \('; echo "smoke-calendar-read-google-cancel $tz exit=${pipestatus[1]}"; done
for f in smoke-calendar-read-google smoke-calendar-read-google-cache smoke-google-map smoke-calendar-range smoke-week-lookahead smoke-voice-dates smoke-google-connect smoke-calendar-read-famcal; do for tz in UTC Asia/Jerusalem; do TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/$f.ts 2>&1 | grep -aE '^(OK|FAIL|SKIP)|passed' > /tmp/c1-$f-${tz//\//_}.before; echo "$f $tz exit=${pipestatus[1]} | $(tail -1 /tmp/c1-$f-${tz//\//_}.before)"; done; done
```

Expected for the new smoke, under each clock, after about 3 s:
```
FAIL  a token server that never answers: error timeout at the deadline; the token request is cancelled then, with no retry, no request and no timer left — the requests
FAIL  lists still waiting at the deadline are cancelled too: error timeout, both requests aborted, nothing left — the read
FAIL  the request timeouts: the token request gets the deadline, each list min(10 s, deadline - 0.5 s), never under 1 s — timeouts by deadline
FAIL  a read that answers in time leaves nothing running either, and every request carried the cancel signal — the requests
OK  nothing reached the network
1/5 passed (process TZ=UTC)
smoke-calendar-read-google-cancel UTC exit=1
```
(then the same with `Asia/Jerusalem` and `Pacific/Kiritimati`).

Why each fails:
- The token request: `got [{"what":"token","timeout":null,"signal":false,"ended":"waiting"}]`. It has no timeout and no signal, so it is still waiting after the read answered `timeout` (the process exits only because the smoke calls `process.exit`).
- The lists: `got {"status":"error","reason":"transient"}`. At a 900 ms deadline each list's timeout is `900 - 500 = 400` ms, so both time out on their own before the deadline.
- The timeouts: every token request has `null`, and the lists at 1,200 and 900 ms have `700` and `400`.
- The read in time: every request is marked `(no signal)`.

Expected for the regression smokes: every run `exit=0`, with last lines `34/34`, `42/42`, `44/44`, `24/24`, `35/35`, `77/77`, `30/30` and `21/21 passed`. The `/tmp/c1-*.before` files are the baseline for Step 9.

- [ ] **Step 7: `getGoogleAuth` takes a transport, in `src/services/calendar.ts` (lines 14-24)**

Edit 7a. Before:

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
```

After:

```ts
/**
 * The OAuth2 client for a user's refresh token, as getCalendarClient has always built it.
 * A fresh client holds no access token, so its first request refreshes one. The calendar
 * home's reader (calendar-read/google.ts) runs that refresh itself first, inside its
 * deadline, so a dead token or a stuck token server is one outcome for the whole read.
 *
 * The reader also passes `transport`: every request of this client, the token refresh
 * included, gets that timeout unless it sets its own, and is cancelled when the signal is
 * aborted. Without it (getCalendarClient), the client is built exactly as before.
 */
export function getGoogleAuth(
  refreshToken: string,
  transport?: { timeout: number; signal: AbortSignal }
): InstanceType<typeof auth.OAuth2> {
  const oauth2Client = transport
    ? new auth.OAuth2({
        clientId: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        transporterOptions: { timeout: transport.timeout, signal: transport.signal },
      })
    : new auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET
      );
```

The rest of `calendar.ts` is unchanged: `setCredentials`, `getCalendarClient` (which still calls `getGoogleAuth(refreshToken)`), and every provider read.

- [ ] **Step 8: The reader cancels what it leaves, in `src/services/calendar-read/google.ts`**

Five edits, in file order. Each Before block appears once in the file at 716a4f8.

Edit 8a, the header comment (lines 14-15). Before:

```ts
 * - One deadline covers all of it. What settled keeps its outcome; a calendar that got a
 *   page by then is truncated, one that got none failed.
```

After:

```ts
 * - One deadline covers all of it. What settled keeps its outcome; a calendar that got a
 *   page by then is truncated, one that got none failed. When the read answers, whatever
 *   is still running is cancelled (a stuck token server's request, lists past the
 *   deadline), so nothing outlives the answer.
```

Edit 8b, the floor (lines 57-58). Before:

```ts
const MAX_REQUEST_TIMEOUT_MS = 10_000;
const DEADLINE_MARGIN_MS = 500;
```

After:

```ts
const MAX_REQUEST_TIMEOUT_MS = 10_000;
/** No request is given less than this, however short the deadline; the deadline still cuts it off. */
const MIN_REQUEST_TIMEOUT_MS = 1_000;
const DEADLINE_MARGIN_MS = 500;
```

Edit 8c, the signal and the token request's timeout (lines 335-337). Before:

```ts
  const deadline = startDeadline(opts.deadlineMs);
  try {
    const auth = getGoogleAuth(token);
```

After:

```ts
  const deadline = startDeadline(opts.deadlineMs);
  // Aborted when the read answers (the finally below). Every request of this read carries
  // it: a token request a stuck token server never answers, or a list still waiting at the
  // deadline, is cancelled then and not retried, so nothing keeps running after the read
  // has answered. The token request's own timeout is the deadline (the lists set theirs).
  const cancel = new AbortController();
  try {
    const auth = getGoogleAuth(token, { timeout: opts.deadlineMs, signal: cancel.signal });
```

Edit 8d, the floor in use (line 355). Before:

```ts
    const timeoutMs = Math.min(MAX_REQUEST_TIMEOUT_MS, opts.deadlineMs - DEADLINE_MARGIN_MS);
```

After:

```ts
    const timeoutMs = Math.max(MIN_REQUEST_TIMEOUT_MS, Math.min(MAX_REQUEST_TIMEOUT_MS, opts.deadlineMs - DEADLINE_MARGIN_MS));
```

Edit 8e, the abort (lines 386-388, the end of `readGoogleUncached`; the cache's own `finally` blocks further down read differently). Before:

```ts
  } finally {
    deadline.clear();
  }
}
```

After:

```ts
  } finally {
    deadline.clear();
    cancel.abort();
  }
}
```

- [ ] **Step 9: Run the cancel smoke and the regression smokes again**

```bash
cd /Users/razielgershoni/development/famcalbot
for tz in UTC Asia/Jerusalem Pacific/Kiritimati; do TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-calendar-read-google-cancel.ts 2>&1 | grep -E '^(OK|FAIL)|passed \('; echo "smoke-calendar-read-google-cancel $tz exit=${pipestatus[1]}"; done
for f in smoke-calendar-read-google smoke-calendar-read-google-cache smoke-google-map smoke-calendar-range smoke-week-lookahead smoke-voice-dates smoke-google-connect smoke-calendar-read-famcal; do for tz in UTC Asia/Jerusalem; do TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/$f.ts 2>&1 | grep -aE '^(OK|FAIL|SKIP)|passed' > /tmp/c1-$f-${tz//\//_}.after; echo "$f $tz exit=${pipestatus[1]}"; cmp -s /tmp/c1-$f-${tz//\//_}.before /tmp/c1-$f-${tz//\//_}.after && echo "  same output as Step 6" || echo "  OUTPUT CHANGED"; done; done
```

Expected for the new smoke, under each clock:
```
OK  a token server that never answers: error timeout at the deadline; the token request is cancelled then, with no retry, no request and no timer left
OK  lists still waiting at the deadline are cancelled too: error timeout, both requests aborted, nothing left
OK  the request timeouts: the token request gets the deadline, each list min(10 s, deadline - 0.5 s), never under 1 s
OK  a read that answers in time leaves nothing running either, and every request carried the cancel signal
OK  nothing reached the network
5/5 passed (process TZ=UTC)
smoke-calendar-read-google-cancel UTC exit=0
```
(then the same with `Asia/Jerusalem` and `Pacific/Kiritimati`).

Every regression run prints `exit=0` and `same output as Step 6`.

If the first check fails only on its timing ("answered after … ms"), the machine was too busy for a 1.5 s real-time deadline; run it again before changing anything.

- [ ] **Step 10: Type-check and lint**

```bash
cd /Users/razielgershoni/development/famcalbot
npx tsc --noEmit -p . && npm run -s lint; echo "exit $?"
```
Expected: no output from either, then `exit 0`. `next build` type-checks `scripts/**`, so both smokes are covered too.

- [ ] **Step 11: Commit**

```bash
cd /Users/razielgershoni/development/famcalbot
git add src/services/calendar-read/digest.ts src/services/calendar-read/google.ts src/services/calendar.ts scripts/smoke-digest-adapters.ts scripts/smoke-calendar-read-google-cancel.ts
git commit -m "$(cat <<'EOF'
feat(calendar-read): the summaries' read adapters

readDigestDay and readLookaheadEvents read a summary's day, and the range
of the week block, /week and /nextweek, through the shared reader, never
through the Google cache. A dead token or missing scopes keep today's
codes; any other Google failure is GOOGLE_FETCH_FAILED with the read's
first day; every chosen calendar gone is an empty Google day with a
warning; a FamCal error rethrows its own cause. An on-demand read that
fails within 5 s is read once more about 1 s later with an 8 s deadline.
Nothing calls them yet, and the switch stays OFF.

The reader's Google half now leaves nothing running once it answers:
every request of a read carries an abort signal, aborted when the read
ends, so a token request that a stuck token server never answers is
cancelled at the deadline instead of being left open and retried. The
token request's timeout is the deadline, and no list request gets less
than 1 s. getGoogleAuth takes the timeout and signal as an optional
second argument; without it the client is built as before.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
EOF
)"
```
Stage only these five paths.

---

### Task 2 (C2): Prompt plumbing and bot texts (spec §3.1 step 6, §9, edit 8)

**Interface changes versus the split: none.** Everything the split names for C2 is here with its exact name and place. Three additions the split implies:
- `SummaryPromptData.googleUnavailable?: boolean` in `src/prompts/calendar-summary/types.ts`, the field the builders read;
- the snapshot file is `scripts/fixtures/summary-prompts.json`;
- the smoke has a `--write-prompt-fixture` mode, which takes the snapshot (Step 2) and refuses to overwrite it.

**What and why:** The scheduled outage run (C4) sends a summary even when Google Calendar can't be reached. The model must then know the lists are incomplete, so it neither invents events nor says nothing is planned. This task adds:
- **The flag:** `SummaryUserContext.googleUnavailable` in `claude.ts`, passed through `buildPromptData` into `SummaryPromptData`.
- **The guideline:** one line in the daily and tomorrow prompts' `## Guidelines`, in en, he and ru, emitted only when the flag is `true`.
- **The bot texts:** `bot.errors.googleUnreachable` is R13's on-demand answer ("Couldn't reach Google Calendar. Please try again in a minute.", C3 and C5). `bot.errors.googleOutageNote` is the line C3 appends under the outage run's summary and its voice text.

Without the flag, every prompt must stay byte-identical to `main@858886c` (A-19, A-33). The new smoke proves that against a snapshot taken from an export of that commit. Nothing sets the flag or sends the texts yet (C3 and C4 do), so no user sees a change.

**Files:**
- Modify: `src/prompts/calendar-summary/types.ts:30-31` (the field, after `openRemindersMore`)
- Modify: `src/services/claude.ts:61-63` (`SummaryUserContext`) and `:172-173` (the end of `buildPromptData`'s return)
- Modify: `src/prompts/calendar-summary/en.ts:77-78` (a new `buildGoogleUnavailableGuideline` before `buildCalendarSummaryPrompt`) and `:201` (its call after `buildRemindersGuideline`)
- Modify: `src/prompts/calendar-summary/he.ts:78-79` and `:203`, the same two edits
- Modify: `src/prompts/calendar-summary/ru.ts:79-80` and `:206`, the same two edits
- Modify: `messages/en.json:510-511`, `messages/he.json:510-511`, `messages/ru.json:510-511` (two keys at the end of `bot.errors`)
- Create (test): `scripts/smoke-summary-prompt-parity.ts`
- Create (test data): `scripts/fixtures/summary-prompts.json`, generated in Step 2, never typed by hand
- Test: `scripts/smoke-summary-prompt-parity.ts`, under `TZ=UTC`, `TZ=Asia/Jerusalem` and `TZ=Pacific/Kiritimati`
- Regression (unchanged): `scripts/smoke-native-reminder-digest.ts`, `scripts/smoke-weather-prompt.ts`, `scripts/smoke-week-lookahead.ts`, `scripts/smoke-partner-labels.ts`, `scripts/smoke-native-reminder-creation.ts`, `scripts/check-i18n-parity.ts`

**Interfaces:**
- Consumes: nothing from other C tasks. From the code base: `generateSummary`, `generateWeekLookahead` and `generateNextWeekSummary` (`claude.ts`, unchanged signatures), `getBotMessages(locale)` (`src/lib/bot-messages.ts:19`, returns the `bot` subtree).
- Produces:
  - `SummaryUserContext.googleUnavailable?: boolean` (`src/services/claude.ts`). C3 sets it in the outage run only: `prepareSummaryForUser`'s `opts.googleUnavailable` → `userContext.googleUnavailable = true`.
  - `SummaryPromptData.googleUnavailable?: boolean` (`src/prompts/calendar-summary/types.ts`).
  - In each of `en.ts`, `he.ts` and `ru.ts`, a private `buildGoogleUnavailableGuideline(data: SummaryPromptData): string`. It returns `''` unless `data.googleUnavailable` is truthy, else one line ending in `\n`.
  - Bot texts, read as `(await getBotMessages(user.language || 'en')).errors.googleUnreachable` and `.errors.googleOutageNote`. Each is one plain line: no HTML, no newline, no `{placeholders}`.
    - C3's `sendSummaryToUser` `onError` and C5's `/week` and `/nextweek` send `googleUnreachable` for `GOOGLE_FETCH_FAILED`.
    - C3 appends `googleOutageNote` to the delivered text and the voice text of the outage run. The guideline tells the model that this note follows the summary, so C3 must append it whenever it sets the flag, and only then.
  - `scripts/fixtures/summary-prompts.json`: 24 prompts captured from `main@858886c`. C6 (§10 item 2, "with `googleUnavailable` unset, prompts are byte-identical to today's") may read it rather than take a second snapshot.

**Findings that shaped the code:**
- **The prompt code hasn't changed since `858886c`.** At 716a4f8, `cmp` finds these identical to `main@858886c`:
  - `src/services/claude.ts` and every file under `src/prompts/`;
  - `src/utils/event-formatter.ts`, `day-events.ts` and `greeting.ts`;
  - `src/services/hebrew-holidays.ts` and `src/services/telegram/summary.ts`.

  So the snapshot taken at `858886c` is also what HEAD builds today. Step 3 shows it: the four byte-identity checks pass before any edit.
- **Why a snapshot from an export, not from HEAD:** the split asks for a fixture "captured from main@858886c". The export needs only `src/`, `package.json`, `tsconfig.json` and a `node_modules` symlink, because capture mode never reads `messages/`. Captures in a full export and in that minimal one gave the same file (one md5), and the smoke at 716a4f8, before the edits, matches it byte for byte (Step 3).
- **Where the line goes:** right after `${buildRemindersGuideline(data)}`, before the kids' pickup rules, inside `## Guidelines`.
  - It follows the reminders guideline's pattern: a function that returns `''` or one line ending in `\n`.
  - Unset or `false`, the template gets `''` at a spot where nothing else moves, so the bytes are unchanged.
  - With the flag, the prompt has exactly one more line, and the rest is unchanged. The smoke checks that line by line.
- **The wording:** the split's two points (Google couldn't be reached, so the lists hold only what loaded; don't invent events), plus two more:
  - "don't say nothing is planned just because a list is empty": in the outage run a Google user's day is `[]`, so every list reads "None". The `daily-*-empty` cases are exactly that prompt;
  - "a note is added after your summary, so don't mention it yourself": otherwise the model and `googleOutageNote` would both say it.

  Each language follows its own prompt's voice. Russian uses вы, like the rest of `ru.ts`. Hebrew uses the masculine imperative of its other guidelines ("אל תמציא", "אל תזכיר") and an impersonal "לא ניתן היה להתחבר". The user-facing Hebrew texts are gender-neutral instead ("לא הצלחנו", "אפשר לנסות").
- **The bot texts** go under `bot.errors`, because `getBotMessages` returns only the `bot` subtree (`bot-messages.ts:26`). Google's own product names are used: "יומן Google" and "Google Календарь". The outage note says "your Google events", so it stays true once Google becomes one connection among several. Both texts are one plain line, safe to append to an HTML summary and to a WhatsApp message (no newlines inside, no template parameters).
- **The weekly prompts never take the flag.** The outage run makes no week-block Google read (§3.1 step 6), and `/week` and `/nextweek` answer an outage with R13's text (C5). They are in the snapshot anyway, so the shared builders stay pinned (A-33).
- **The smoke's fakes:**
  - `ai-provider.ts` captures the prompt;
  - `hebrew-holidays.ts` is stubbed, because the real one calls CalBrew over the network;
  - `error-capture.ts` is stubbed;
  - the clock is frozen per case, because the prompt reads today's date and the greeting hour;
  - weather is off, because it would call Open-Meteo.

  The capture was byte-identical under `TZ=UTC`, `Asia/Jerusalem` and `Pacific/Kiritimati`. `@hebcal/core` is pointed at its ESM build, as in `smoke-native-reminder-digest.ts`.
- **The cases**, 8 per language (24 prompts, 140 KB):
  - daily: the Google family, the FamCal couple with reminders and "N more", and an empty solo day;
  - tomorrow: the family with the week block, and the couple with reminders;
  - `/week`, with and without reminders;
  - `/nextweek` with reminders.

  Both cultures, both kids branches, birthdays, holidays (Rosh Chodesh Cheshvan on 12 Oct 2026), the three span marks and the New York and Israel zones all appear.
- **Intl:** the weekly prompts hold Node's `he-IL` and `ru-RU` date strings. A Node upgrade whose ICU writes them differently fails the byte-identity checks although the code didn't change. If that happens, retake the snapshot at `858886c` with the new Node (delete the file, repeat Step 2). Never edit the fixture by hand.
- **Line numbers** are as of 716a4f8. C1 touches none of these files. Plan D's copy task edits `messages/*.json` and may shift their lines; match on the quoted text, which is unique in each file (checked).
- **`tsc` passes before the change too:** the smoke sets the flag through a spread, which gets no excess-property check. The failing checks are the runtime ones.
- **Verified on a copy of `feat/calendar-home`** (716a4f8 = Plans A and B as on `main` at c1558c6 plus Plan B's `htmlToText` follow-up, plus C1, which touches none of these files; the first pass ran on the scratch base, header, Planning Ruling 2):
  - before the edits: 6/9 under each clock, with the three FAIL lines in Step 3;
  - after: 9/9 under each clock, and `tsc` and lint are clean;
  - the regression smokes print the same lines before and after, and `check-i18n-parity` goes from 885 to 887 keys.
  - Mutations caught (first pass, on the scratch base, where every file they change is as at 716a4f8):
    - the `claude.ts` pass-through removed;
    - the ru guideline always on;
    - the he line placed before the reminders guideline;
    - `false` treated as set (`=== undefined`);
    - the en line moved to the end of the prompt;
    - ru `googleOutageNote` removed.
- **Verified against stand-ins:** none needed. C2 consumes no other C task.

- [ ] **Step 1: Write the failing smoke `scripts/smoke-summary-prompt-parity.ts`**

Create the file with exactly this content:

```ts
// Smoke test for the summary prompts' Google outage guideline (spec §3.1 step 6, §9,
// edit 8): SummaryUserContext.googleUnavailable in src/services/claude.ts, the line it
// adds to src/prompts/calendar-summary/{en,he,ru}.ts, and the two bot texts the
// summaries send when Google Calendar can't be reached (bot.errors.googleUnreachable
// and bot.errors.googleOutageNote in messages/{en,he,ru}.json).
//
// Without the flag, every prompt must be exactly the prompt main@858886c builds (A-19,
// A-33): daily, tomorrow, /week and /nextweek, in en/he/ru, with and without reminders.
// scripts/fixtures/summary-prompts.json holds those prompts. It was taken inside an
// export of main@858886c with:
//   npx tsx scripts/smoke-summary-prompt-parity.ts --write-prompt-fixture
// (Plan C, Task C2, Step 2). That mode refuses to overwrite the file. Take a new
// snapshot only when the prompts for users without the flag are meant to change:
// delete the file, then run it again.
//
// With the flag, a daily or tomorrow prompt gains exactly one line, in its guidelines.
// The AI, the holiday lookup and Sentry are faked, and the clock is frozen per case.
// No network, no DB.
//
// Run under three clocks; the output must not depend on the server's timezone:
//   TZ=UTC npx tsx scripts/smoke-summary-prompt-parity.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-summary-prompt-parity.ts
//   TZ=Pacific/Kiritimati npx tsx scripts/smoke-summary-prompt-parity.ts

import Module from 'node:module';
import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import type { CalendarAssignment, CalendarEvent, CalendarLabel, ReminderInfo, UserConfig } from '../src/types';
import type { SummaryUserContext } from '../src/services/claude';
import type { LookaheadEvent, RecurrenceType, WeekLookahead } from '../src/services/week-lookahead';

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

process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.DATABASE_URL = 'postgresql://test@db.invalid/test';
process.env.UPSTASH_REDIS_REST_URL = 'https://redis.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.GEMINI_API_KEY = 'test-key';
globalThis.fetch = (async (input: unknown) => {
  throw new Error(`network is blocked in this smoke test: ${String(input)}`);
}) as typeof fetch;

// ---- Frozen clock: the prompts read "today" and the greeting hour from it ----

const RealDate = Date;
let frozen = RealDate.now();
class FrozenDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(frozen);
    else super(...(args as [number, number, number, number, number, number, number]));
  }
  static now() {
    return frozen;
  }
}
globalThis.Date = FrozenDate as unknown as DateConstructor;

// generateSummary logs its timings on every call; keep the output to the checks.
const consoleLog = console.log;
console.log = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0].startsWith('[AI Summary Timing]')) return;
  consoleLog(...args);
};

// ---- Fakes for the AI, the holiday lookup and Sentry ----

const prompts: string[] = [];
const captured: string[] = [];
/** What the holiday lookup answers for the case being built. */
let holidays: string[] = [];

const ModuleInternals = Module as unknown as {
  new (id: string): { filename: string; loaded: boolean; exports: unknown };
  _resolveFilename: (request: string, ...rest: unknown[]) => string;
  _cache: Record<string, unknown>;
};
// @hebcal/core is ESM-only and tsx loads src/ as CommonJS (see smoke-week-lookahead.ts);
// claude.ts imports it, so point it at its ESM build.
const resolveFilename = ModuleInternals._resolveFilename;
ModuleInternals._resolveFilename = function (request: string, ...rest: unknown[]) {
  if (request === '@hebcal/core') return path.resolve(__dirname, '../node_modules/@hebcal/core/dist/esm/index.js');
  return resolveFilename.call(this, request, ...rest);
};
function stub(file: string, exports: Record<string, unknown>) {
  const filename = path.resolve(__dirname, '../src', file);
  const mod = new ModuleInternals(filename);
  Object.assign(mod, { filename, loaded: true, exports });
  ModuleInternals._cache[filename] = mod;
}
stub('services/ai-provider.ts', {
  generateAICompletion: async (prompt: string) => {
    prompts.push(prompt);
    return { text: 'ok' };
  },
  streamAICompletion: async () => {
    throw new Error('not streamed in this test');
  },
});
stub('services/hebrew-holidays.ts', { getHolidaysForDate: async () => holidays });
stub('lib/error-capture.ts', {
  captureError: (_error: unknown, context: string) => { captured.push(context); },
  captureWarning: () => {},
  captureInfo: () => {},
});

// ---- Fixture data ----

type Lang = 'en' | 'he' | 'ru';
const LANGS: Lang[] = ['en', 'he', 'ru'];
const IL = 'Asia/Jerusalem';
const NY = 'America/New_York';
const TZ_OF: Record<Lang, string> = { en: NY, he: IL, ru: IL };

/** An instant from a wall-clock time in a zone. */
const at = (local: string, tz: string) => fromZonedTime(local, tz);
/** A timed Google value: RFC 3339 with the zone's offset, as Google sends it. */
const gtime = (local: string, tz: string) => formatInTimeZone(at(local, tz), tz, "yyyy-MM-dd'T'HH:mm:ssXXX");
/** A timed FamCal value: UTC ISO, as the native provider sends it. */
const ntime = (local: string, tz: string) => at(local, tz).toISOString();
const addDays = (day: string, n: number) => {
  const d = new RealDate(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Every word the fixtures use, per language: names, calendars, titles and places. */
const WORDS = {
  en: {
    me: 'Raziel', meEn: 'Raziel', partner: 'Dana', partnerEn: 'Dana', kid1: 'Noa', kid2: 'Itai', family: 'Family', birthdays: 'Birthdays',
    rule: 'Mention parking for anything downtown', globalRule: 'Keep it short on weekdays',
    standup: 'Team standup', zoom: 'Zoom', dentist: 'Dentist', dentistAt: '12 Main St', dentistNote: 'Bring the insurance card\nand the x-rays',
    release: 'Release window', conference: 'Design conference', yoga: 'Yoga', sleepover: "Sleepover at Ben's", school: 'School', schoolAt: 'Oak School',
    soccer: 'Soccer - Noa and Itai', park: 'City Park', birthday: "Grandma Ruth's Birthday",
    pills: 'Take pills', haircut: 'Haircut', cake: 'Pick up the cake', plumber: 'Call the plumber', milk: 'Buy milk', pilates: 'Pilates', dinner: 'Family dinner',
    morningCall: 'Morning call', vet: 'Book the vet',
    teacher: 'Parent-teacher meeting', hair: 'Hair appointment', trip: 'Field trip', piano: 'Piano lesson', gas: 'Pay the gas bill', gift: 'Buy a gift', grandma: 'Call grandma',
    swim: 'Swimming', plants: 'Water the plants', checkup: 'Annual checkup',
  },
  he: {
    me: 'רזיאל', meEn: 'Raziel', partner: 'דנה', partnerEn: 'Dana', kid1: 'נועה', kid2: 'איתי', family: 'משפחה', birthdays: 'ימי הולדת',
    rule: 'לציין חניה לכל דבר במרכז העיר', globalRule: 'בימי חול לקצר',
    standup: 'ישיבת צוות', zoom: 'זום', dentist: 'רופא שיניים', dentistAt: 'רחוב הרצל 12', dentistNote: 'להביא את כרטיס הביטוח\nואת צילומי הרנטגן',
    release: 'חלון שחרור גרסה', conference: 'כנס עיצוב', yoga: 'יוגה', sleepover: 'לינה אצל בן', school: 'בית ספר', schoolAt: 'בית ספר אלון',
    soccer: 'כדורגל - נועה ואיתי', park: 'פארק העיר', birthday: 'יום ההולדת של סבתא רות',
    pills: 'לקחת כדורים', haircut: 'תספורת', cake: 'לאסוף את העוגה', plumber: 'להתקשר לאינסטלטור', milk: 'לקנות חלב', pilates: 'פילאטיס', dinner: 'ארוחת ערב משפחתית',
    morningCall: 'שיחת בוקר', vet: 'לקבוע תור לווטרינר',
    teacher: 'אסיפת הורים', hair: 'תור למספרה', trip: 'טיול שנתי', piano: 'שיעור פסנתר', gas: 'לשלם חשבון גז', gift: 'לקנות מתנה', grandma: 'להתקשר לסבתא',
    swim: 'שחייה', plants: 'להשקות את העציצים', checkup: 'בדיקה שנתית',
  },
  ru: {
    me: 'Алексей', meEn: 'Alexey', partner: 'Марина', partnerEn: 'Marina', kid1: 'Лиза', kid2: 'Миша', family: 'Семья', birthdays: 'Дни рождения',
    rule: 'Упоминай парковку для всего в центре', globalRule: 'В будни покороче',
    standup: 'Планёрка', zoom: 'Zoom', dentist: 'Стоматолог', dentistAt: 'ул. Герцля, 12', dentistNote: 'Взять страховой полис\nи снимки',
    release: 'Выкатка релиза', conference: 'Конференция по дизайну', yoga: 'Йога', sleepover: 'Ночёвка у Бена', school: 'Школа', schoolAt: 'Школа «Алон»',
    soccer: 'Футбол - Лиза и Миша', park: 'Городской парк', birthday: 'День рождения бабушки Раи',
    pills: 'Выпить таблетки', haircut: 'Стрижка', cake: 'Забрать торт', plumber: 'Позвонить сантехнику', milk: 'Купить молоко', pilates: 'Пилатес', dinner: 'Семейный ужин',
    morningCall: 'Утренний звонок', vet: 'Записаться к ветеринару',
    teacher: 'Родительское собрание', hair: 'Парикмахер', trip: 'Экскурсия', piano: 'Урок фортепиано', gas: 'Оплатить газ', gift: 'Купить подарок', grandma: 'Позвонить бабушке',
    swim: 'Плавание', plants: 'Полить цветы', checkup: 'Ежегодный осмотр',
  },
} as const;

/** The Google family: own, spouse, two kids, a shared family calendar and birthdays. */
function googleCalendars(l: Lang): CalendarAssignment[] {
  const w = WORDS[l];
  return [
    { calendarId: 'me@example.com', labels: ['primary', 'yours'], name: w.me, color: '#039BE5', rules: [w.rule] },
    { calendarId: 'partner@example.com', labels: ['spouse'], name: w.partner, color: '#039BE5', personName: w.partner, personEnglishName: w.partnerEn, personGender: 'female' },
    { calendarId: 'kid1@group.calendar.google.com', labels: ['kids'], name: w.kid1, color: '#33B679', personName: w.kid1 },
    { calendarId: 'kid2@group.calendar.google.com', labels: ['kids'], name: w.kid2, color: '#F4511E', personName: w.kid2 },
    { calendarId: 'family@group.calendar.google.com', labels: [], name: w.family, color: '#8E24AA' },
    { calendarId: 'addressbook#contacts@group.v.calendar.google.com', labels: ['birthdays'], name: w.birthdays, color: '#0B8043' },
  ];
}

/** A FamCal couple: own calendar, the partner's shared one and a family calendar. */
function famcalCalendars(l: Lang): CalendarAssignment[] {
  const w = WORDS[l];
  return [
    { calendarId: 'native:cmecalendar0000000000001', labels: ['primary', 'yours'], name: w.me, color: '#039BE5' },
    { calendarId: 'native:cpartnercalendar00000002', labels: ['spouse'], name: w.partner, color: '#039BE5', personName: w.partner, personEnglishName: w.partnerEn, personGender: 'female' },
    { calendarId: 'native:cfamilycalendar000000003', labels: [], name: w.family, color: '#8E24AA' },
  ];
}

const soloCalendars = (l: Lang): CalendarAssignment[] =>
  [{ calendarId: 'me@example.com', labels: ['primary', 'yours'], name: WORDS[l].me, color: '#039BE5' }];

const OWN: ReminderInfo = { ownerIsViewer: true, creatorIsViewer: true };
const fromPartner = (l: Lang): ReminderInfo => ({ ownerIsViewer: true, creatorIsViewer: false, creatorName: WORDS[l].partner });
const forPartner = (l: Lang): ReminderInfo => ({ ownerIsViewer: false, creatorIsViewer: true, ownerName: WORDS[l].partner });

type Lists = { user: CalendarEvent[]; spouse: CalendarEvent[]; other: CalendarEvent[] };

/** The Google family's day, already shaped and categorized as prepareSummaryForUser hands it on. */
function googleFamilyDay(l: Lang, day: string): Lists {
  const w = WORDS[l];
  const tz = TZ_OF[l];
  const [me, partner, kid1, kid2, family, birthdays] = googleCalendars(l);
  const ev = (cal: CalendarAssignment, summary: string, start: string, end: string, more: Partial<CalendarEvent> = {}): CalendarEvent =>
    ({ summary, start, end, calendarName: cal.name, calendarId: cal.calendarId, eventType: 'default', eventId: `${cal.calendarId}:${summary}`, ...more });
  return {
    user: [
      ev(me, w.standup, gtime(`${day} 09:30:00`, tz), gtime(`${day} 09:45:00`, tz), { location: w.zoom }),
      ev(me, w.dentist, gtime(`${day} 14:00:00`, tz), gtime(`${day} 15:00:00`, tz), { location: w.dentistAt, description: w.dentistNote }),
      ev(me, w.release, gtime(`${day} 22:00:00`, tz), gtime(`${addDays(day, 1)} 02:00:00`, tz), { daySpan: 'endsLater' }),
    ],
    spouse: [
      ev(partner, w.conference, addDays(day, -1), addDays(day, 2), { daySpan: 'spansDay' }),
      ev(partner, w.yoga, gtime(`${day} 18:00:00`, tz), gtime(`${day} 19:00:00`, tz)),
    ],
    other: [
      ev(kid2, w.sleepover, gtime(`${addDays(day, -1)} 18:00:00`, tz), gtime(`${day} 10:00:00`, tz), { daySpan: 'continues' }),
      ev(kid1, w.school, gtime(`${day} 08:00:00`, tz), gtime(`${day} 13:50:00`, tz), { location: w.schoolAt }),
      ev(family, w.soccer, gtime(`${day} 16:00:00`, tz), gtime(`${day} 17:30:00`, tz), { location: w.park }),
      ev(birthdays, w.birthday, day, addDays(day, 1), { eventType: 'birthday' }),
    ],
  };
}

/** The FamCal couple's day with reminders: open, from and for the partner, carried over. */
function famcalReminderDay(l: Lang, day: string, tomorrow: boolean): Lists {
  const w = WORDS[l];
  const tz = TZ_OF[l];
  const [me, partner, family] = famcalCalendars(l);
  const ev = (cal: CalendarAssignment, summary: string, start: string, end: string, more: Partial<CalendarEvent> = {}): CalendarEvent =>
    ({ summary, start, end, calendarName: cal.name, calendarId: cal.calendarId, eventId: `${cal.calendarId}:${summary}`, ...more });
  const reminder = (cal: CalendarAssignment, summary: string, start: string, info: ReminderInfo): CalendarEvent =>
    ev(cal, summary, start, start, { eventType: 'reminder', reminder: info });
  if (tomorrow) {
    return {
      user: [
        reminder(me, w.pills, ntime(`${day} 07:00:00`, tz), OWN),
        ev(me, w.haircut, ntime(`${day} 11:00:00`, tz), ntime(`${day} 11:30:00`, tz)),
        reminder(me, w.morningCall, ntime(`${addDays(day, -1)} 10:00:00`, tz), { ...OWN, open: true, openSince: addDays(day, -1) }),
      ],
      spouse: [reminder(me, w.vet, day, forPartner(l))],
      other: [ev(family, w.dinner, ntime(`${day} 20:00:00`, tz), ntime(`${day} 22:00:00`, tz))],
    };
  }
  return {
    user: [
      reminder(me, w.pills, ntime(`${day} 07:00:00`, tz), { ...OWN, open: true }),
      ev(me, w.haircut, ntime(`${day} 11:00:00`, tz), ntime(`${day} 11:30:00`, tz)),
      reminder(partner, w.cake, ntime(`${day} 17:00:00`, tz), fromPartner(l)),
      reminder(me, w.plumber, ntime(`${addDays(day, -2)} 10:00:00`, tz), { ...OWN, open: true, openSince: addDays(day, -2) }),
    ],
    spouse: [
      reminder(me, w.milk, ntime(`${day} 17:00:00`, tz), forPartner(l)),
      ev(partner, w.pilates, ntime(`${day} 19:00:00`, tz), ntime(`${day} 20:00:00`, tz)),
    ],
    other: [ev(family, w.dinner, ntime(`${day} 20:00:00`, tz), ntime(`${day} 22:00:00`, tz))],
  };
}

/** The tomorrow summary's week block, in formatTomorrowLookahead's English lines. */
function tomorrowLookaheadText(l: Lang): string {
  const w = WORDS[l];
  return [
    `Friday: ${w.teacher} at 17:00 (${w.me})`,
    `Saturday: ${w.birthday} (Birthday)`,
    `Sunday: ${w.plants} (Reminder 18:00)`,
  ].join('\n');
}

const userRow = (l: Lang, culture: string) => ({
  id: 1, telegramId: 1001, name: WORDS[l].me, englishName: WORDS[l].meEn, gender: 'male', language: l, culture,
  globalRules: [WORDS[l].globalRule], isAdmin: false,
}) as unknown as UserConfig;

/** A lookahead event, listed on `day` in the user's zone. */
function la(
  l: Lang, today: string, cal: CalendarAssignment, label: CalendarLabel, summary: string, day: string, time: string | null,
  more: Partial<LookaheadEvent> & { recurrenceType?: RecurrenceType } = {}
): LookaheadEvent {
  const tz = TZ_OF[l];
  const start = time ? at(`${day} ${time}:00`, tz) : at(`${day} 00:00:00`, tz);
  const end = time ? new RealDate(start.getTime() + 60 * 60_000) : at(`${addDays(day, 1)} 00:00:00`, tz);
  const daysFromNow = Math.round((new RealDate(`${day}T12:00:00Z`).getTime() - new RealDate(`${today}T12:00:00Z`).getTime()) / 86_400_000);
  return {
    summary, start, end, day, calendarName: cal.name, calendarId: cal.calendarId, calendarLabel: label,
    recurrenceType: 'single', daysFromNow, isAllDay: !time, isBirthday: false, ...more,
  };
}

/** The label the lookahead gives an item on `cal` (getCalendarLabel). */
const labelOf = (cal: CalendarAssignment): CalendarLabel =>
  cal.labels.includes('primary') ? 'yours' : cal.labels.includes('spouse') ? 'spouse' : cal.labels.includes('kids') ? 'kids' : cal.labels.includes('birthdays') ? 'birthdays' : 'yours';

/** The end of the lookahead's last day, as week-lookahead.ts's endOfLocalDay gives it. */
const endOfDay = (day: string, tz: string) => new RealDate(at(`${addDays(day, 1)} 00:00:00`, tz).getTime() - 1);

/**
 * /week from Wednesday 09:00: the rest of the week. Without reminders it is the Google
 * family (kids and birthdays included); with reminders, the FamCal couple.
 */
function weekLookahead(l: Lang, culture: string, withReminders: boolean): { lookahead: WeekLookahead; calendars: CalendarAssignment[] } {
  const w = WORDS[l];
  const tz = TZ_OF[l];
  const today = '2026-10-14';
  const last = culture === 'jewish' ? '2026-10-17' : '2026-10-18';
  const item = (cal: CalendarAssignment, summary: string, day: string, time: string | null, more: Partial<LookaheadEvent> = {}) =>
    la(l, today, cal, labelOf(cal), summary, day, time, more);
  let calendars: CalendarAssignment[];
  let events: LookaheadEvent[];
  if (withReminders) {
    calendars = famcalCalendars(l);
    const [me, partner, family] = calendars;
    events = [
      item(partner, w.conference, today, null, { runningLabel: 'All day (began Tue, through Thu)' }),
      item(me, w.gas, '2026-10-15', '09:00', { reminder: OWN }),
      item(me, w.teacher, '2026-10-15', '17:00'),
      item(me, w.gift, '2026-10-16', null, { reminder: forPartner(l) }),
      item(partner, w.hair, '2026-10-16', '10:00'),
      item(partner, w.grandma, '2026-10-17', '11:00', { reminder: fromPartner(l) }),
      item(family, w.dinner, '2026-10-17', '20:00', { recurrenceType: 'weekly' }),
    ];
  } else {
    calendars = googleCalendars(l);
    const [me, partner, kid1, kid2, , birthdays] = calendars;
    events = [
      item(partner, w.conference, today, null, { runningLabel: 'All day (began Tue, through Thu)' }),
      item(kid2, w.piano, '2026-10-15', '16:00', { recurrenceType: 'weekly' }),
      item(me, w.teacher, '2026-10-15', '17:00'),
      item(kid1, w.trip, '2026-10-16', null),
      item(partner, w.hair, '2026-10-16', '10:00'),
      item(birthdays, w.birthday, '2026-10-17', null, { isBirthday: true, recurrenceType: 'yearly' }),
    ];
  }
  return { lookahead: { events, dateRange: { start: at(`${today} 09:00:00`, tz), end: endOfDay(last, tz) }, timezone: tz }, calendars };
}

/** /nextweek from Wednesday 09:00: next week's whole days, for the FamCal couple, with reminders. */
function nextWeekLookahead(l: Lang, culture: string): { lookahead: WeekLookahead; calendars: CalendarAssignment[] } {
  const w = WORDS[l];
  const tz = TZ_OF[l];
  const calendars = famcalCalendars(l);
  const [me, partner, family] = calendars;
  const today = '2026-10-14';
  const first = culture === 'jewish' ? '2026-10-18' : '2026-10-19';
  const last = addDays(first, 6);
  const item = (cal: CalendarAssignment, summary: string, day: string, time: string | null, more: Partial<LookaheadEvent> = {}) =>
    la(l, today, cal, labelOf(cal), summary, day, time, more);
  const events: LookaheadEvent[] = [
    item(family, w.swim, first, '16:30', { recurrenceType: 'weekly' }),
    item(me, w.checkup, addDays(first, 2), '08:15'),
    item(me, w.plants, addDays(first, 2), '18:00', { reminder: OWN }),
    item(partner, w.conference, addDays(first, 3), null),
    item(me, w.gift, addDays(first, 4), null, { reminder: forPartner(l) }),
  ];
  return { lookahead: { events, dateRange: { start: at(`${first} 00:00:00`, tz), end: endOfDay(last, tz) }, timezone: tz }, calendars };
}

// ---- The cases: every prompt kind, by name ----

type DailyCase = {
  kind: 'daily' | 'tomorrow'; language: Lang; culture: string; now: string; day: string; holidays?: string[];
  calendars: CalendarAssignment[]; lists: Lists; spouse: boolean; openRemindersMore: number; weekLookahead?: string;
};
type WeeklyCase = { kind: 'week' | 'nextweek'; language: Lang; culture: string; now: string; build: () => { lookahead: WeekLookahead; calendars: CalendarAssignment[] } };
type Case = DailyCase | WeeklyCase;
const isDaily = (c: Case): c is DailyCase => c.kind === 'daily' || c.kind === 'tomorrow';

const CASES: Record<string, Case> = {};
const CULTURE: Record<Lang, { family: string; reminders: string; empty: string; weekly: string }> = {
  en: { family: 'default', reminders: 'jewish', empty: 'default', weekly: 'default' },
  he: { family: 'jewish', reminders: 'default', empty: 'jewish', weekly: 'jewish' },
  ru: { family: 'jewish', reminders: 'default', empty: 'default', weekly: 'jewish' },
};
const HOLIDAY: Record<Lang, string> = { en: 'Rosh Chodesh Cheshvan', he: 'ראש חודש חשון', ru: 'Рош Ходеш Хешван' };
for (const l of LANGS) {
  const c = CULTURE[l];
  // Monday 12 Oct 2026 is Rosh Chodesh Cheshvan: a Jewish-culture family day names it.
  const familyDay = c.family === 'jewish' ? '2026-10-12' : '2026-10-14';
  CASES[`daily-${l}-family`] = {
    kind: 'daily', language: l, culture: c.family, now: `${familyDay} 07:00:00`, day: familyDay,
    holidays: c.family === 'jewish' ? [HOLIDAY[l]] : [], calendars: googleCalendars(l), lists: googleFamilyDay(l, familyDay), spouse: true, openRemindersMore: 0,
  };
  CASES[`daily-${l}-reminders`] = {
    kind: 'daily', language: l, culture: c.reminders, now: '2026-10-14 08:00:00', day: '2026-10-14',
    calendars: famcalCalendars(l), lists: famcalReminderDay(l, '2026-10-14', false), spouse: true, openRemindersMore: 2,
  };
  CASES[`daily-${l}-empty`] = {
    kind: 'daily', language: l, culture: c.empty, now: '2026-10-14 07:00:00', day: '2026-10-14',
    calendars: soloCalendars(l), lists: { user: [], spouse: [], other: [] }, spouse: false, openRemindersMore: 0,
  };
  CASES[`tomorrow-${l}-family`] = {
    kind: 'tomorrow', language: l, culture: c.family, now: '2026-10-14 19:00:00', day: '2026-10-15',
    calendars: googleCalendars(l), lists: googleFamilyDay(l, '2026-10-15'), spouse: true, openRemindersMore: 0, weekLookahead: tomorrowLookaheadText(l),
  };
  CASES[`tomorrow-${l}-reminders`] = {
    kind: 'tomorrow', language: l, culture: c.reminders, now: '2026-10-14 20:00:00', day: '2026-10-15',
    calendars: famcalCalendars(l), lists: famcalReminderDay(l, '2026-10-15', true), spouse: true, openRemindersMore: 1,
  };
  CASES[`week-${l}`] = { kind: 'week', language: l, culture: c.weekly, now: '2026-10-14 09:00:00', build: () => weekLookahead(l, c.weekly, false) };
  CASES[`week-${l}-reminders`] = { kind: 'week', language: l, culture: c.weekly, now: '2026-10-14 09:00:00', build: () => weekLookahead(l, c.weekly, true) };
  CASES[`nextweek-${l}-reminders`] = { kind: 'nextweek', language: l, culture: c.weekly, now: '2026-10-14 09:00:00', build: () => nextWeekLookahead(l, c.weekly) };
}
const DAILY_NAMES = Object.keys(CASES).filter(n => isDaily(CASES[n]));
const WEEKLY_NAMES = Object.keys(CASES).filter(n => !isDaily(CASES[n]));

const FIXTURE = path.resolve(__dirname, 'fixtures/summary-prompts.json');

/** Where two prompts first differ, for a failure message. */
function firstDifference(got: string, want: string): string {
  const a = got.split('\n');
  const b = want.split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) return `line ${i + 1}:\n     got  ${JSON.stringify(a[i])}\n     want ${JSON.stringify(b[i])}`;
  }
  return 'nowhere';
}

/**
 * The one line `got` adds to `base`, and where. Fails unless `got` is `base` with
 * exactly one line inserted and nothing else changed.
 */
function insertedLine(base: string, got: string): { line: string; index: number } {
  const a = base.split('\n');
  const b = got.split('\n');
  assert(b.length === a.length + 1, `${b.length - a.length} lines added, not 1${b.length === a.length ? ` (${got === base ? 'no change' : firstDifference(got, base)})` : ''}`);
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  assert(b.slice(i + 1).join('\n') === a.slice(i).join('\n'), `more than one line changed, from line ${i + 1}`);
  return { line: b[i], index: i };
}

async function main() {
  const { generateSummary, generateWeekLookahead, generateNextWeekSummary } = await import('../src/services/claude');
  const { getBotMessages } = await import('../src/lib/bot-messages');

  /** The prompt the AI gets for one case. `flag` is SummaryUserContext.googleUnavailable; undefined leaves it out. */
  async function promptFor(name: string, flag?: boolean): Promise<string> {
    const c = CASES[name];
    const tz = TZ_OF[c.language];
    frozen = at(c.now, tz).getTime();
    prompts.length = 0;
    if (isDaily(c)) {
      holidays = c.holidays ?? [];
      const w = WORDS[c.language];
      const userContext: SummaryUserContext = {
        culture: c.culture,
        globalRules: [w.globalRule],
        calendarAssignments: c.calendars,
        openRemindersMore: c.openRemindersMore,
        ...(flag === undefined ? {} : { googleUnavailable: flag }),
      };
      await generateSummary(
        c.lists.user, c.lists.spouse, c.lists.other,
        w.me, w.meEn, 'male',
        c.spouse ? w.partner : undefined, c.spouse ? w.partnerEn : undefined, c.spouse ? 'female' : undefined,
        c.calendars[0].calendarId, at(`${c.day} 12:00:00`, tz), false, undefined, undefined, c.language,
        userContext, false, c.weekLookahead, tz
      );
    } else {
      const { lookahead, calendars } = c.build();
      const user = userRow(c.language, c.culture);
      if (c.kind === 'week') await generateWeekLookahead(lookahead, user, c.language, undefined, false, undefined, calendars);
      else await generateNextWeekSummary(lookahead, user, c.language, undefined, false, undefined, calendars);
    }
    assert(prompts.length === 1, `${name}: ${prompts.length} prompts`);
    return prompts[0];
  }

  if (process.argv.includes('--write-prompt-fixture')) {
    if (existsSync(FIXTURE)) {
      console.error(`${path.relative(process.cwd(), FIXTURE)} exists. Delete it first to take a new snapshot.`);
      process.exit(1);
    }
    const snapshot: Record<string, string> = {};
    for (const name of Object.keys(CASES)) snapshot[name] = await promptFor(name);
    mkdirSync(path.dirname(FIXTURE), { recursive: true });
    writeFileSync(FIXTURE, JSON.stringify(snapshot, null, 2) + '\n');
    console.log(`Wrote ${Object.keys(snapshot).length} prompts to ${path.relative(process.cwd(), FIXTURE)}`);
    process.exit(0);
  }

  assert(existsSync(FIXTURE), `${FIXTURE} is missing: take the snapshot first (see the header)`);
  const snapshot: Record<string, string> = JSON.parse(readFileSync(FIXTURE, 'utf8'));

  // ---- Without the flag: main@858886c's prompts, byte for byte ----

  await check('the snapshot holds every case and nothing else (8 per language)', () => {
    const want = Object.keys(CASES);
    assert(JSON.stringify(Object.keys(snapshot)) === JSON.stringify(want), `snapshot cases: ${Object.keys(snapshot).join(', ')}`);
  });

  await check('without googleUnavailable, the daily and tomorrow prompts are byte-identical to main@858886c (en/he/ru, with and without reminders)', async () => {
    for (const name of DAILY_NAMES) {
      const prompt = await promptFor(name);
      assert(prompt === snapshot[name], `${name} differs at ${firstDifference(prompt, snapshot[name])}`);
    }
  });

  await check('googleUnavailable: false is the same as leaving it out', async () => {
    for (const name of DAILY_NAMES) {
      const prompt = await promptFor(name, false);
      assert(prompt === snapshot[name], `${name} differs at ${firstDifference(prompt, snapshot[name])}`);
    }
  });

  await check('the /week and /nextweek prompts are byte-identical to main@858886c (en/he/ru, with and without reminders)', async () => {
    for (const name of WEEKLY_NAMES) {
      const prompt = await promptFor(name);
      assert(prompt === snapshot[name], `${name} differs at ${firstDifference(prompt, snapshot[name])}`);
    }
  });

  await check('the snapshot covers both cultures, reminders, the "N more" line, holidays, kids and the tomorrow week block', () => {
    const all = Object.values(snapshot).join('\n');
    const needles = [
      '## Hebrew Calendar', '- **Reminders**', 'and 2 more open reminders', 'and 1 more open reminder"', 'היום: ראש חודש חשון', 'СЕГОДНЯ: Рош Ходеш Хешван',
      'WEEK LOOKAHEAD (events after tomorrow)', 'Pickup Order', '[Calendar: Birthdays]', '## הנחיות', '## Рекомендации', 'Next Week', 'Child: Noa',
    ];
    for (const needle of needles) {
      assert(all.includes(needle), `no case has ${JSON.stringify(needle)}`);
    }
    assert(!snapshot['daily-en-empty'].includes('- **Reminders**'), 'the empty day has the reminders guideline');
  });

  // ---- With the flag: exactly one guideline line ----

  /** The outage guideline, word for word, per language. */
  const GUIDELINE: Record<Lang, string> = {
    en: "- **Google Calendar**: Google Calendar couldn't be reached for this summary, so the lists hold only what loaded. Don't invent events or guess what's missing, and don't say nothing is planned just because a list is empty. A note about this is added after your summary, so don't mention it yourself.",
    he: '- **יומן Google**: לא ניתן היה להתחבר ליומן Google בזמן הכנת הסיכום, ולכן ברשימות יש רק את מה שנטען. אל תמציא אירועים ואל תנחש מה חסר, ואל תכתוב שאין אירועים רק כי רשימה ריקה. הערה על כך תתווסף אחרי הסיכום, אז אל תזכיר את זה בעצמך.',
    ru: '- **Google Календарь**: К Google Календарю не удалось подключиться, поэтому в списках только то, что успело загрузиться. Не придумывайте события и не гадайте, чего не хватает, и не пишите, что ничего не запланировано, только потому, что список пуст. Заметка об этом будет добавлена после сводки, так что сами о сбое не пишите.',
  };
  const GUIDELINES_HEADER: Record<Lang, string> = { en: '## Guidelines', he: '## הנחיות', ru: '## Рекомендации' };

  await check('with googleUnavailable, every daily and tomorrow prompt gains exactly one line, the outage guideline in its language', async () => {
    for (const name of DAILY_NAMES) {
      const { line } = insertedLine(snapshot[name], await promptFor(name, true));
      const want = GUIDELINE[CASES[name].language];
      assert(line === want, `${name}: the added line is\n     ${JSON.stringify(line)}\n     want ${JSON.stringify(want)}`);
    }
  });

  await check('the line sits in the guidelines, right after the reminders guideline when there is one', async () => {
    for (const name of DAILY_NAMES) {
      const base = snapshot[name].split('\n');
      const { index } = insertedLine(snapshot[name], await promptFor(name, true));
      const header = base.indexOf(GUIDELINES_HEADER[CASES[name].language]);
      const rule = base.indexOf('---');
      assert(header >= 0 && header < index && index <= rule, `${name}: line ${index + 1}, guidelines from ${header + 1} to ${rule + 1}`);
      const remindersAt = base.findIndex(l => /^- \*\*(Reminders|תזכורות|Напоминания)\*\*/.test(l));
      if (remindersAt >= 0) assert(index === remindersAt + 1, `${name}: line ${index + 1}, the reminders guideline is line ${remindersAt + 1}`);
    }
  });

  // ---- The bot texts ----

  const SCRIPT: Record<Lang, RegExp> = { en: /^[\x20-\x7E\u2019\u26A0\uFE0F]+$/, he: /[\u05D0-\u05EA]/, ru: /[\u0400-\u04FF]/ };

  await check('bot.errors.googleUnreachable and googleOutageNote exist in en/he/ru, each in its own language', async () => {
    const seen = new Map<string, string>();
    for (const l of LANGS) {
      const t = await getBotMessages(l);
      for (const key of ['googleUnreachable', 'googleOutageNote']) {
        const text: unknown = t.errors?.[key];
        assert(typeof text === 'string' && text.trim().length > 0, `${l}: bot.errors.${key} is missing`);
        assert(SCRIPT[l].test(text), `${l}: bot.errors.${key} is not in ${l}: ${text}`);
        assert(text.includes('Google'), `${l}: bot.errors.${key} doesn't name Google: ${text}`);
        // One plain line: it is appended to an HTML summary and needs nothing filled in.
        assert(!/[\n<>&{}]/.test(text), `${l}: bot.errors.${key} is not one plain line: ${JSON.stringify(text)}`);
        assert(!seen.has(text), `${l}: bot.errors.${key} repeats ${seen.get(text)}`);
        seen.set(text, `${l}.${key}`);
      }
    }
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

main().catch(err => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Take the snapshot inside an export of `main@858886c`**

```bash
cd /Users/razielgershoni/development/famcalbot
rm -rf /tmp/c2-main858 && mkdir -p /tmp/c2-main858/scripts
git archive 858886c src package.json tsconfig.json | tar -x -C /tmp/c2-main858
ln -s "$PWD/node_modules" /tmp/c2-main858/node_modules
cp scripts/smoke-summary-prompt-parity.ts /tmp/c2-main858/scripts/
(cd /tmp/c2-main858 && TZ=UTC DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-summary-prompt-parity.ts --write-prompt-fixture; echo "exit $?")
cp /tmp/c2-main858/scripts/fixtures/summary-prompts.json scripts/fixtures/summary-prompts.json
md5 -q scripts/fixtures/summary-prompts.json
rm /tmp/c2-main858/node_modules && rm -rf /tmp/c2-main858
```

Expected:
```
Wrote 24 prompts to scripts/fixtures/summary-prompts.json
exit 0
754b58c05f1d9128cf08217e167884ea
```
The md5 is the drafting run's, on Node v26.11.1. Another Node may write ICU dates differently and give another md5; Step 3's byte-identity checks then decide. The cleanup unlinks `node_modules` before removing the export, so it can only ever delete the export. Don't take the snapshot in the working tree: HEAD's prompts are what is under test.

- [ ] **Step 3: Run the smoke before the change; record the regression baseline**

```bash
cd /Users/razielgershoni/development/famcalbot
for tz in UTC Asia/Jerusalem Pacific/Kiritimati; do TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-summary-prompt-parity.ts; echo "smoke-summary-prompt-parity $tz exit=$?"; done
for f in smoke-native-reminder-digest smoke-weather-prompt smoke-week-lookahead smoke-partner-labels smoke-native-reminder-creation check-i18n-parity; do for tz in UTC Asia/Jerusalem; do TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/$f.ts 2>&1 | grep -E '^(OK|FAIL)|passed|parity' > /tmp/c2-$f-${tz//\//_}.before; echo "$f $tz exit=${pipestatus[1]} | $(tail -1 /tmp/c2-$f-${tz//\//_}.before)"; done; done
```
(Run it in zsh: `pipestatus` is zsh's, and in bash it is `${PIPESTATUS[0]}`.)

Expected for the new smoke under `TZ=UTC`:
```
OK  the snapshot holds every case and nothing else (8 per language)
OK  without googleUnavailable, the daily and tomorrow prompts are byte-identical to main@858886c (en/he/ru, with and without reminders)
OK  googleUnavailable: false is the same as leaving it out
OK  the /week and /nextweek prompts are byte-identical to main@858886c (en/he/ru, with and without reminders)
OK  the snapshot covers both cultures, reminders, the "N more" line, holidays, kids and the tomorrow week block
FAIL  with googleUnavailable, every daily and tomorrow prompt gains exactly one line, the outage guideline in its language — 0 lines added, not 1 (no change)
FAIL  the line sits in the guidelines, right after the reminders guideline when there is one — 0 lines added, not 1 (no change)
FAIL  bot.errors.googleUnreachable and googleOutageNote exist in en/he/ru, each in its own language — en: bot.errors.googleUnreachable is missing
OK  nothing above reported an error

6/9 passed (process TZ=UTC)
smoke-summary-prompt-parity UTC exit=1
```
Then the same under `(process TZ=Asia/Jerusalem)` and `(process TZ=Pacific/Kiritimati)`.

Why it fails:
- The four byte-identity checks already pass: HEAD's prompts are `858886c`'s, and the unknown field is ignored.
- The flag adds no line yet, and the two bot texts don't exist.

If a byte-identity check fails here, the snapshot or the prompt code differs from what this task assumes. Stop and compare (`git diff 858886c HEAD -- src/prompts src/services/claude.ts src/utils/event-formatter.ts`) before going on.

Expected for the regression runs: every one `exit=0`. The last lines at 716a4f8 are `33/33`, `14/14`, `35/35`, `19/19`, `30/30` and `i18n parity OK (885 keys)`. Plan D's copy, if it has landed, raises the key count. The `/tmp/c2-*.before` files are the baseline for Step 10.

- [ ] **Step 4: Add the field to `src/prompts/calendar-summary/types.ts`**

Lines 30-31. Replace:

```ts
  openRemindersMore?: number;  // Open reminders past the digest's cap, not in the lists
}
```

with:

```ts
  openRemindersMore?: number;  // Open reminders past the digest's cap, not in the lists
  googleUnavailable?: boolean; // Google Calendar couldn't be reached at send time (the scheduled outage run): adds the outage guideline
}
```

- [ ] **Step 5: Add the flag to `SummaryUserContext` and pass it through, in `src/services/claude.ts`**

Lines 61-63. Replace:

```ts
  /** Open reminders past the digest's cap, left out of the event lists. */
  openRemindersMore?: number;
}
```

with:

```ts
  /** Open reminders past the digest's cap, left out of the event lists. */
  openRemindersMore?: number;
  /**
   * Google Calendar couldn't be reached when the summary was sent, so the lists hold
   * only what loaded (the scheduled outage run, spec §3.1 step 6). Adds one guideline
   * line; unset or false, the prompt is unchanged.
   */
  googleUnavailable?: boolean;
}
```

Lines 172-173 (the end of `buildPromptData`'s return). Replace:

```ts
    openRemindersMore: userContext?.openRemindersMore,
  };
```

with:

```ts
    openRemindersMore: userContext?.openRemindersMore,
    googleUnavailable: userContext?.googleUnavailable,
  };
```

- [ ] **Step 6: Add the English guideline to `src/prompts/calendar-summary/en.ts`**

Lines 77-78. Replace:

```ts
export function buildCalendarSummaryPrompt(data: SummaryPromptData): string {
  const spouseContext = buildSpouseContext(data);
```

with:

```ts
// Only the outage run gets this (Google Calendar couldn't be reached at send time), so
// every other prompt stays as it was.
function buildGoogleUnavailableGuideline(data: SummaryPromptData): string {
  if (!data.googleUnavailable) return '';
  return `- **Google Calendar**: Google Calendar couldn't be reached for this summary, so the lists hold only what loaded. Don't invent events or guess what's missing, and don't say nothing is planned just because a list is empty. A note about this is added after your summary, so don't mention it yourself.
`;
}

export function buildCalendarSummaryPrompt(data: SummaryPromptData): string {
  const spouseContext = buildSpouseContext(data);
```

Line 201. Replace:

```ts
${buildRemindersGuideline(data)}${data.hasKidsCalendars ? `- **CRITICAL: Pickup Order MUST be sorted chronologically by time (earliest first)**
```

with:

```ts
${buildRemindersGuideline(data)}${buildGoogleUnavailableGuideline(data)}${data.hasKidsCalendars ? `- **CRITICAL: Pickup Order MUST be sorted chronologically by time (earliest first)**
```

- [ ] **Step 7: Add the Hebrew guideline to `src/prompts/calendar-summary/he.ts`**

Lines 78-79. Replace:

```ts
export function buildCalendarSummaryPrompt(data: SummaryPromptData): string {
  const spouseContext = buildSpouseContext(data);
```

with:

```ts
// Only the outage run gets this (Google Calendar couldn't be reached at send time), so
// every other prompt stays as it was.
function buildGoogleUnavailableGuideline(data: SummaryPromptData): string {
  if (!data.googleUnavailable) return '';
  return `- **יומן Google**: לא ניתן היה להתחבר ליומן Google בזמן הכנת הסיכום, ולכן ברשימות יש רק את מה שנטען. אל תמציא אירועים ואל תנחש מה חסר, ואל תכתוב שאין אירועים רק כי רשימה ריקה. הערה על כך תתווסף אחרי הסיכום, אז אל תזכיר את זה בעצמך.
`;
}

export function buildCalendarSummaryPrompt(data: SummaryPromptData): string {
  const spouseContext = buildSpouseContext(data);
```

Line 203. Replace:

```ts
${buildRemindersGuideline(data)}${data.hasKidsCalendars ? `- **קריטי: סדר האיסוף חייב להיות ממוין כרונולוגית לפי שעה (הכי מוקדם קודם)**
```

with:

```ts
${buildRemindersGuideline(data)}${buildGoogleUnavailableGuideline(data)}${data.hasKidsCalendars ? `- **קריטי: סדר האיסוף חייב להיות ממוין כרונולוגית לפי שעה (הכי מוקדם קודם)**
```

- [ ] **Step 8: Add the Russian guideline to `src/prompts/calendar-summary/ru.ts`**

Lines 79-80. Replace:

```ts
export function buildCalendarSummaryPrompt(data: SummaryPromptData): string {
  const spouseContext = buildSpouseContext(data);
```

with:

```ts
// Only the outage run gets this (Google Calendar couldn't be reached at send time), so
// every other prompt stays as it was.
function buildGoogleUnavailableGuideline(data: SummaryPromptData): string {
  if (!data.googleUnavailable) return '';
  return `- **Google Календарь**: К Google Календарю не удалось подключиться, поэтому в списках только то, что успело загрузиться. Не придумывайте события и не гадайте, чего не хватает, и не пишите, что ничего не запланировано, только потому, что список пуст. Заметка об этом будет добавлена после сводки, так что сами о сбое не пишите.
`;
}

export function buildCalendarSummaryPrompt(data: SummaryPromptData): string {
  const spouseContext = buildSpouseContext(data);
```

Line 206. Replace:

```ts
${buildRemindersGuideline(data)}${data.hasKidsCalendars ? `- **КРИТИЧНО: Порядок забора ДОЛЖЕН быть отсортирован хронологически (сначала самое раннее время)**
```

with:

```ts
${buildRemindersGuideline(data)}${buildGoogleUnavailableGuideline(data)}${data.hasKidsCalendars ? `- **КРИТИЧНО: Порядок забора ДОЛЖЕН быть отсортирован хронологически (сначала самое раннее время)**
```

- [ ] **Step 9: Add the two bot texts to `messages/{en,he,ru}.json`**

`messages/en.json`, lines 510-511. Replace:

```json
      "voiceGenerationFailed": "Voice message unavailable — your text summary is above."
    },
```

with:

```json
      "voiceGenerationFailed": "Voice message unavailable — your text summary is above.",
      "googleUnreachable": "Couldn't reach Google Calendar. Please try again in a minute.",
      "googleOutageNote": "⚠️ Couldn't reach Google Calendar, so your Google events aren't in this summary. You can ask for a new one in a few minutes."
    },
```

`messages/he.json`, lines 510-511. Replace:

```json
      "voiceGenerationFailed": "הודעה קולית אינה זמינה — סיכום הטקסט למעלה."
    },
```

with:

```json
      "voiceGenerationFailed": "הודעה קולית אינה זמינה — סיכום הטקסט למעלה.",
      "googleUnreachable": "לא הצלחנו להתחבר ליומן Google. אפשר לנסות שוב בעוד דקה.",
      "googleOutageNote": "⚠️ לא הצלחנו להתחבר ליומן Google, ולכן האירועים ממנו לא מופיעים בסיכום הזה. אפשר לבקש סיכום חדש בעוד כמה דקות."
    },
```

`messages/ru.json`, lines 510-511. Replace:

```json
      "voiceGenerationFailed": "Голосовое сообщение недоступно — текстовая сводка выше."
    },
```

with:

```json
      "voiceGenerationFailed": "Голосовое сообщение недоступно — текстовая сводка выше.",
      "googleUnreachable": "Не удалось связаться с Google Календарём. Попробуйте ещё раз через минуту.",
      "googleOutageNote": "⚠️ Не удалось связаться с Google Календарём, поэтому событий из него в этой сводке нет. Через несколько минут можно запросить её заново."
    },
```

- [ ] **Step 10: Run the smoke and the regression smokes again**

```bash
cd /Users/razielgershoni/development/famcalbot
for tz in UTC Asia/Jerusalem Pacific/Kiritimati; do TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-summary-prompt-parity.ts; echo "smoke-summary-prompt-parity $tz exit=$?"; done
for f in smoke-native-reminder-digest smoke-weather-prompt smoke-week-lookahead smoke-partner-labels smoke-native-reminder-creation check-i18n-parity; do for tz in UTC Asia/Jerusalem; do TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/$f.ts 2>&1 | grep -E '^(OK|FAIL)|passed|parity' > /tmp/c2-$f-${tz//\//_}.after; echo "$f $tz exit=${pipestatus[1]}"; cmp -s /tmp/c2-$f-${tz//\//_}.before /tmp/c2-$f-${tz//\//_}.after && echo "  same output as Step 3" || diff /tmp/c2-$f-${tz//\//_}.before /tmp/c2-$f-${tz//\//_}.after; done; done
```
(zsh, as in Step 3.)

Expected for the new smoke under `TZ=UTC`:
```
OK  the snapshot holds every case and nothing else (8 per language)
OK  without googleUnavailable, the daily and tomorrow prompts are byte-identical to main@858886c (en/he/ru, with and without reminders)
OK  googleUnavailable: false is the same as leaving it out
OK  the /week and /nextweek prompts are byte-identical to main@858886c (en/he/ru, with and without reminders)
OK  the snapshot covers both cultures, reminders, the "N more" line, holidays, kids and the tomorrow week block
OK  with googleUnavailable, every daily and tomorrow prompt gains exactly one line, the outage guideline in its language
OK  the line sits in the guidelines, right after the reminders guideline when there is one
OK  bot.errors.googleUnreachable and googleOutageNote exist in en/he/ru, each in its own language
OK  nothing above reported an error

9/9 passed (process TZ=UTC)
smoke-summary-prompt-parity UTC exit=0
```
Then the same under `(process TZ=Asia/Jerusalem)` and `(process TZ=Pacific/Kiritimati)`.

Expected for the regression runs:
- Every one prints `exit=0`.
- Every smoke prints `same output as Step 3`.
- `check-i18n-parity` prints its diff and nothing else: two more keys than in Step 3 (`885` → `887` at 716a4f8).

If a byte-identity check fails, an edit touched the prompt outside the new line. Fix the edit; never retake the snapshot to make it pass.

- [ ] **Step 11: Type-check and lint**

```bash
cd /Users/razielgershoni/development/famcalbot
npx tsc --noEmit -p . && npm run -s lint; echo "exit $?"
```
Expected: no output from either, then `exit 0`. `next build` type-checks `scripts/**`, so the smoke is covered too.

- [ ] **Step 12: Commit**

```bash
cd /Users/razielgershoni/development/famcalbot
git add src/prompts/calendar-summary/types.ts src/prompts/calendar-summary/en.ts src/prompts/calendar-summary/he.ts src/prompts/calendar-summary/ru.ts src/services/claude.ts messages/en.json messages/he.json messages/ru.json scripts/smoke-summary-prompt-parity.ts scripts/fixtures/summary-prompts.json
git commit -m "$(cat <<'EOF'
feat(summary): the Google outage guideline and its bot texts, unused for now

SummaryUserContext.googleUnavailable adds one line to the guidelines of the
daily and tomorrow prompts, in en/he/ru: Google Calendar couldn't be
reached, so the lists hold only what loaded; don't invent events or say
nothing is planned, and leave the outage note to the bot. Two bot texts
come with it: bot.errors.googleUnreachable (on demand, "try again in a
minute") and bot.errors.googleOutageNote (the line under a scheduled
summary). Nothing sets the flag or sends the texts yet.

Without the flag every prompt is byte-identical to main@858886c:
smoke-summary-prompt-parity compares 24 prompts (daily, tomorrow, /week and
/nextweek; en/he/ru; with and without reminders) with a snapshot taken
there, in scripts/fixtures/summary-prompts.json.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
EOF
)"
```
Stage only these ten paths.

---

### Task 3 (C3): The summary seam (spec §3.1 items 1 and 4, the first three parts of edit 5)

> **Interface note (read first).** No name or signature in the split changes. This task **adds four exports** to `src/services/telegram/summary.ts`, where the split leaves them module-private: `prepareSummaryForUser`, the two fetch wrappers `fetchTodayEvents` and `fetchTomorrowEvents`, and a type `SummaryFetch` for the wrappers' shape. They are exported so this task's smoke, C4's retry smoke and C6's parity smoke can call them directly instead of running a whole batch. The signatures are the split's, unchanged. `src/services/telegram/index.ts` does not re-export them, so nothing outside `summary.ts` and the smokes uses them.
>
> **One addition from the review:** this is the first task that asks the switch inside the per-user loop, so it also gives the switch a short memory for its fallback. When neither Redis nor the DB answers, `getCalendarHomeRollout` (`src/services/calendar-read/rollout.ts`, Plan B) now keeps its `OFF` for 5 s with one warning, instead of trying both stores again, and warning twice, for every caller. No signature changes. Plan B's `scripts/smoke-calendar-home-rollout.ts` gets the matching checks (33 → 35).

**What and why:** The daily and tomorrow summaries still read their day through the calendar provider. This task moves the users the rollout switch covers onto the shared reader. Everyone else keeps today's read, with the same three arguments, so their summaries don't change (A-33). The task has three parts:
- **The fetch wrappers** (`summary.ts:11-14`) ask `await isCalendarHomeOn(user)`. A covered user reads the summary day through C1's `readDigestDay(user, day, tz, ids, read)`, with the run's mode and deadline (on demand by default). Every other user gets `getProviderForUser(user).fetch…(user, ids, tz)`, which ignores `day` and `read`.
- **`prepareSummaryForUser`** gets a trailing `opts?: { day?, read?, googleUnavailable? }`, and `modelId` stays 4th. `day` replaces today's day rule when it is set. One `day` drives the fetch, `shapeEventsForDay`, the open reminders, `dayNoon` (the prompt's date and the header) and the week block's reference. `read` is passed to the fetch. With `googleUnavailable`, a Google user's day is `[]` with no read, the week block is skipped, the prompt context gets `googleUnavailable: true` (C2's guideline line), and C2's outage line goes under the summary text. `deliverSummary` sends that text and voices it, so the line reaches both.
- **`sendSummaryToUser`** passes `{ read: DEFAULT_ON_DEMAND_READ }`. Its `onError` gets a `GOOGLE_FETCH_FAILED` branch. That branch sends Ruling R13's text (`bot.errors.googleUnreachable`): it replaces the open draft with `streamHandle.cancel(text)` when there is one, and otherwise sends a message. It returns `true` and pages no admin. The adapter (C1) has already made its quick retry by then.

- **The switch's fallback** (`rollout.ts`): a read that neither store answered is `OFF` for the next 5 s, with one warning for both stores. Before, nothing was remembered, so during a Redis and DB outage every summary paid one more Redis and DB attempt and two Sentry warnings, and a tomorrow summary with a week block paid twice. That hit everyone, the users the switch doesn't cover included, because they ask the switch too.

Nothing calls `opts.day` or `googleUnavailable` yet: C4's scheduled retry will. The switch ships `OFF`, so no user sees a change.

**Findings that shaped the code (read before you start):**
- **Depends on:** C1 (`digest.ts`), C2 (`SummaryUserContext.googleUnavailable`, `bot.errors.googleUnreachable`, `bot.errors.googleOutageNote` in all three message files) and B1 (`isCalendarHomeOn`). Land C1 and C2 first. Without C2's texts, the smoke fails with "bot.errors.… is missing in messages/<lang>.json (Task C2 adds it)". Without C1's file, it can't load.
- **Where the switch is asked:** in the wrappers, once per day read.
  - `isCalendarHomeOn` never rejects: `getCalendarHomeRollout` catches a failure of either store and answers `OFF` (`rollout.ts:46-85`).
  - It is memoized on `globalThis` for 30 s. For users it doesn't cover, the only new work is that lookup, and the provider call is unchanged.
  - Its fallback was not memoized: with Redis and the DB both failing (or Redis empty and the DB failing), every call tried Redis (with the Upstash client's own retries) and the DB again, and sent two warnings. This task keeps that `OFF` for 5 s (`FALLBACK_MEMO_MS`), in the same `globalThis` memo with a `fallback` mark, and sends one warning per attempt, with `stage: 'db'` or `'redis and db'`. A Redis failure with the DB answering still sends its one warning and keeps the DB's value for 30 s, as before; that warning now goes out after the DB has answered.
  - `setCalendarHomeRollout` still clears the memo, the fallback included, so an admin's change is read at once in the process that made it.
  - What the 5 s cost: a switch moved during a store outage reaches this process up to 5 s later. During an outage the switch reads `OFF` either way.
- **The week block's own outage** (a review question): when the day read succeeds and the tomorrow summary's week block throws `GOOGLE_FETCH_FAILED` (C5 makes the week read throw for covered users), `prepareSummaryForUser`'s catch (`summary.ts:158-161` at 716a4f8) drops the block with a `summary-week-lookahead` warning, and the summary goes out and is marked sent. That stays, deliberately:
  - A-28 says a week-block failure degrades the summary and never fails it.
  - The outage line (`bot.errors.googleOutageNote`) says the user's Google events aren't in the summary, which would be wrong: the day's are.
  - Owner decision 9's "never skip silently" is about the summary itself, which goes out complete for its day; the failure is in Sentry.
  - A line of its own ("the days after tomorrow couldn't be read") would be new copy beyond §9's two bot texts. It is listed for the owner as a possible follow-up.

  A `[guard]` check pins this, end to end it is C6's.
  - The user is always a fresh DB row: `getUserByIdentifier` on demand (`user-service.ts:102-108`), `getAllUsers` in the batch (`:114-117`). It is never the reminder cache's rebuilt user (spec §2.2).
- **One source per user (step 1):** the outage condition is `opts.googleUnavailable === true && user.calendarSource === 'GOOGLE'`.
  - For a FamCal user the flag changes nothing: they never get `GOOGLE_FETCH_FAILED`.
  - "A Google user's day is `[]`" and "no week block" are exact because a Google user reads Google only (Owner decision 2).
  - The later "Google becomes a connection" step has to turn this into "leave Google out of the read".
- **The outage line:**
  - It is added in `prepareSummaryForUser`, so the `summary` that `deliverSummary` gives to `routeTextMessage` and to `sendVoiceMessage` (`:877-922` at 716a4f8) already carries it (A-32).
  - It is formatted `\n\n<i>…</i>`, like the near-limit line (`:867`), which `deliverSummary` still adds after it.
  - It is never added to an empty AI answer, so `deliverSummary`'s "could not generate" reply (`:831-846`) still fires.
  - Bot texts are HTML (`messages/*.json` uses `<b>`). C2's `googleOutageNote` should be plain text without its own `<i>`.
  - C4 must not add the line again.
- **WhatsApp:**
  - A scheduled WhatsApp send is a template (`routeTextMessage` with `isProactive`), so the outage line reaches Telegram's text and voice only. A WhatsApp user who taps the template gets a fresh on-demand summary.
  - On demand, R13's text goes out through the service of the platform that asked. A free-form WhatsApp message is allowed there, because the user just wrote (24-hour rule).
- **The R13 branch:**
  - It comes after the token branch.
  - It uses `streamHandle.cancel(text, { format: HTML })` when a draft is open, as `deliverSummary` does (`:840-841`), so no stale "Composing…" placeholder is left above it.
  - The token and scopes branches keep their `sendMessage`, unchanged, as the spec says.
  - Returning `true` makes `executeCommand` send nothing more and page no one (`command-pipeline.ts:115-122`).
  - No quota is used: `incrementUsage` runs only on delivery.
- **Between C3 and C4:**
  - `sendSummaryToAll` still calls `prepareSummaryForUser(user, fetchFunction, summaryDate)` (`:442` at 716a4f8, `:510` after this task). A covered user's scheduled read therefore uses the wrappers' default (on demand, 10 s).
  - A `GOOGLE_FETCH_FAILED` there falls into the loop's catch: it is logged, sends nothing and sets no dedup mark.
  - The switch is `OFF` until Plan C lands. C4 passes `SCHEDULED_READ` and adds the retry.
- **Between C3 and C5:** the tomorrow summary's week block still calls `getWeekLookahead(user, assignments, dayNoon)` with no `read`. C5 adds `opts?.read` there.
- **Line numbers after this task**, for the Before blocks of C4 and C5:
  - `prepareSummaryForUser` is at `:114-122`;
  - the week block's guard is at `:190` and reads `if (summaryDate && user.includeLookaheadInTomorrow && !googleOut) {`;
  - the `getWeekLookahead` call is at `:196`;
  - `sendSummaryToAll` starts at `:417`, and only `:418` (its `fetchFunction: SummaryFetch,` line) changed in it;
  - its loop is at `:457-574` (it was `:389-506`), with its body unchanged.
- **The smoke:**
  - It fakes only `readDigestDay`. The rest of `digest.ts` is real, so it checks against C1's own `DEFAULT_ON_DEMAND_READ`, `SCHEDULED_READ` and `SCHEDULED_RETRY_READ`, by identity.
  - The seam is tested apart from C1's retry and mapping. C6's parity smoke runs them end to end.
  - A bot text it sends is reported by its key (`he:errors.googleUnreachable`), so the expected output doesn't depend on C2's wording.
  - The checks named `[guard]` pass before and after: today's behaviour for users the switch doesn't cover, the token, scopes and other-error branches, the week block's own outage, and the scheduled batch.
  - Its error capture is a recorder, so the week-block check can see the `summary-week-lookahead` warning.
- **Verified against stand-ins** (first pass, in a copy of the scratch base, header, Planning Ruling 2; never in the repo):
  - C1: `src/services/calendar-read/digest.ts` with the split's exports and signatures (`DigestRead`, `DEFAULT_ON_DEMAND_READ = { mode: 'onDemand', deadlineMs: 10000 }`, `SCHEDULED_READ` (30,000), `SCHEDULED_RETRY_READ` (15,000), `readDigestDay(user, day, tz, ids: readonly string[], read)`, `readLookaheadEvents(…)`), and a minimal body: `readRange` plus the spec's error table, with no quick retry.
  - C2: `googleUnavailable?: boolean` on `SummaryUserContext`, and `bot.errors.googleUnreachable` and `bot.errors.googleOutageNote` in `messages/{en,he,ru}.json` with placeholder copy (`check-i18n-parity` OK).
  - Before this task: the new smoke prints 9/23 under `TZ=UTC`, `Asia/Jerusalem` and `Pacific/Kiritimati` (the 9 are the `[guard]` checks and the last check). `tsc` reports 15 `TS2339` errors, all in the new smoke. The rollout smoke prints 32/35, with the three fallback checks failing.
  - After: 23/23 under each clock, and the rollout smoke 35/35. `tsc`, `npm run lint` and `check-i18n-parity` are clean.
  - Re-verified on the real C1 and C2 (the review patch): the same counts before and after, and the regression smokes, `smoke-admin-panel-ssr` (10) and `smoke-calendar-range` (24) included, printed the same lines under all three clocks.
  - The regression smokes printed the same OK/FAIL lines and counts before and after under all three clocks. The whole smoke suite (51 scripts, `UTC` and `Asia/Jerusalem`) did too.
  - Replayed on 716a4f8 with C1 and C2 as committed, every step as written: before, 9/23 under each clock, the 15 `TS2339` errors and the rollout smoke 32/35; after, 23/23 and 35/35 under each clock, the regression smokes the same lines as before, `tsc` and lint clean, and the tree this task's commit makes.
  - Mutations caught, one at a time:
    - the wrappers ignore the caller's `read`;
    - the tomorrow wrapper moves the day itself;
    - the provider gets the extra arguments;
    - `opts.day` ignored;
    - `opts.read` not passed;
    - the outage run still reads;
    - the outage run keeps the week block;
    - `googleUnavailable: false` always set;
    - the outage condition without the source check;
    - the line added to an empty answer;
    - the line left out;
    - R13 ignores the open draft;
    - R13 returns `false`;
    - R13 pages an admin;
    - R13 sends the wrong text;
    - in `rollout.ts`: no fallback memo; the fallback kept 30 s; two warnings when both stores fail.

**Files:**
- Modify: `src/services/telegram/summary.ts` (line numbers as of 716a4f8):
  - `:5-14`: the imports, `SummaryFetch` and the two wrappers (Step 4);
  - `:77-86`: `prepareSummaryForUser`'s docblock, export and `opts` (Step 5, Edit 5a);
  - `:115-118`: the day, the outage condition and the fetch (Edit 5b);
  - `:140-147`: the prompt flag and the week block's guard (Edit 5c);
  - `:174-175` and `:198-200`: the outage line (Edits 5d and 5e);
  - `:218-220`: `sendSummaryToUser`'s `fetchFunction` type (Step 6, Edit 6a);
  - `:283`: the on-demand read (Edit 6b);
  - `:328-333`: the R13 branch (Edit 6c);
  - `:349-350`: `sendSummaryToAll`'s `fetchFunction` type (Edit 6d).
- Modify: `src/services/calendar-read/rollout.ts` (Step 7): the header comment (`:12-14`), the fallback's memo time (`:25`), the memo's type (`:29`), `warn` (`:41-43`), the Redis failure (`:45-67`) and the fallback (`:80-85`).
- Create (test): `scripts/smoke-summary-seam.ts` (23 checks)
- Modify (test): `scripts/smoke-calendar-home-rollout.ts` (Step 2): its header and the both-stores-down check (`:7-8`, `:254-263`), plus two new checks (33 → 35)
- Test: `scripts/smoke-summary-seam.ts`, `scripts/smoke-calendar-home-rollout.ts`
- Regression (unchanged): `scripts/smoke-google-connect.ts`, `scripts/smoke-native-reminder-digest.ts`, `scripts/smoke-partner-labels.ts`, `scripts/smoke-voice-dates.ts` and `scripts/smoke-weather-prompt.ts` load the real `summary.ts`; `scripts/smoke-weather-command.ts` fakes it by path; `scripts/smoke-admin-panel-ssr.ts` and `scripts/smoke-calendar-range.ts` run the real `rollout.ts`.

**Interfaces:**
- Consumes:
  - C1, `src/services/calendar-read/digest.ts`:
    - `export type DigestRead = { mode: 'scheduled' | 'onDemand'; deadlineMs: number }`;
    - `readDigestDay(user: UserConfig, day: DayKey, tz: string, ids: readonly string[], read: DigestRead): Promise<CalendarEvent[]>`, called with `string[]` ids, so `string[]` in C1 works too;
    - `DEFAULT_ON_DEMAND_READ`, plus, in the smoke only, `SCHEDULED_READ` and `SCHEDULED_RETRY_READ`.
  - C2:
    - `SummaryUserContext.googleUnavailable?: boolean` (`src/services/claude.ts`);
    - `bot.errors.googleUnreachable` and `bot.errors.googleOutageNote` (`messages/{en,he,ru}.json`), read through `getBotMessages(lang).errors`.
  - B1: `isCalendarHomeOn(user: { isAdmin?: boolean | null }): Promise<boolean>` (`src/services/calendar-read/rollout.ts`), and `getCalendarHomeRollout()`, whose fallback this task memoizes (no signature change).
  - B3: `DayKey` (`src/services/calendar-read/types.ts`).
  - Unchanged:
    - `CalendarProvider.fetchTodayEvents` / `fetchTomorrowEvents(user, calendarIds, timezone?)` (`calendar-provider/types.ts:107-108`);
    - `executeCommand`'s `onError` contract (`command-pipeline.ts:115-122`);
    - `StreamMessageHandle.cancel(errorText, options?)` (`messaging/types.ts:140`).
- Produces (`src/services/telegram/summary.ts`):
  ```ts
  export type SummaryFetch = (user: UserConfig, calendarIds: string[], timezone: string, day: DayKey, read?: DigestRead) => Promise<CalendarEvent[]>;
  export const fetchTodayEvents: SummaryFetch;      // read defaults to DEFAULT_ON_DEMAND_READ
  export const fetchTomorrowEvents: SummaryFetch;   // the same; `day` is the caller's, never moved
  export async function prepareSummaryForUser(
    user: UserConfig,
    fetchFunction: SummaryFetch,
    summaryDate: Date | undefined,
    modelId?: string,
    onTextDelta?: (delta: string, accumulated: string) => void | Promise<void>,
    onStageChange?: (stage: StreamStage) => void,
    opts?: { day?: DayKey; read?: DigestRead; googleUnavailable?: boolean }
  ): Promise<PreparedSummary>;                      // { summary, dateHeader, otherEvents }
  ```
  - `sendSummaryToUser` and `sendSummaryToAll` take `fetchFunction: SummaryFetch` and are otherwise unchanged.
  - `sendSummaryToUser`'s `onError`: `GOOGLE_FETCH_FAILED` → R13's text; returns `true`; no admin notice.
  - C4 uses them like this:
    - first attempts: `prepareSummaryForUser(user, fetchFunction, summaryDate, undefined, undefined, undefined, { read: SCHEDULED_READ })`;
    - a thrown `GOOGLE_FETCH_FAILED` carries C1's `.day`;
    - the retry passes `{ day: err.day, read: SCHEDULED_RETRY_READ }`;
    - the outage run passes `{ day, read: SCHEDULED_RETRY_READ, googleUnavailable: true }`. Its `summary` already ends with the outage line, so C4 only delivers it and sets the dedup mark.
  - C5 changes the call at `:196` (after this task) to `getWeekLookahead(user, assignments, dayNoon, opts?.read)`.

All smoke commands below use the fake environment and never read `.env`. Run them in zsh: `pipestatus` is zsh's (in bash it is `${PIPESTATUS[0]}`).

- [ ] **Step 1: Write the failing smoke `scripts/smoke-summary-seam.ts`**

Create the file with exactly this content:

```ts
// Smoke test for the summary seam (calendar home spec §3.1, Plan C Task C3):
// src/services/telegram/summary.ts.
//
// For a user the rollout switch covers, the daily and tomorrow summaries read their day
// through the shared reader's readDigestDay: the summary day, the user's timezone, the
// resolved calendar ids, and the run's mode and deadline (on demand: 10 s). Everyone
// else keeps the provider's read with today's three arguments (A-33).
// prepareSummaryForUser takes the summary day, the read and the outage flag from its
// caller (the scheduled retry, Task C4). The day drives the read, the shaping, the
// reminders, the prompt's date, the header and the week block. The outage run reads
// nothing for a Google user, skips the week block, flags the prompt and puts the outage
// line under the text. On demand, a Google outage (GOOGLE_FETCH_FAILED) gets Ruling
// R13's text, in place of an open draft, and no admin page.
//
// The real summary.ts, command pipeline and bot texts run. Faked: the user lookup, the
// calendar provider, the rollout switch, readDigestDay (the rest of digest.ts is real),
// the timezone, open reminders, the week lookahead, the AI, the voice note, quota,
// analytics, Redis, the setup nudge, both messaging services and the admin notifier. The
// clock is frozen. No network, no DB.
//
// Checks named [guard] pass before this task too and must keep passing. They pin today's
// behaviour for the users the switch doesn't cover, and the error branches that don't
// change.
//
// Run under each clock; the output must not depend on the server's timezone:
//   TZ=UTC npx tsx scripts/smoke-summary-seam.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-summary-seam.ts
//   TZ=Pacific/Kiritimati npx tsx scripts/smoke-summary-seam.ts

import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { MessageFormat, MessagingPlatform } from '../src/services/messaging/types';
import type { MessageOptions, StreamMessageHandle } from '../src/services/messaging/types';
import type { CalendarAssignment, CalendarEvent, UserConfig } from '../src/types';
import type { SummaryUserContext } from '../src/services/claude';
import type { DigestRead } from '../src/services/calendar-read/digest';

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

async function check(name: string, fn: () => Promise<void>) {
  reset();
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

const show = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x));

function assertEqual(got: unknown, want: unknown, what: string) {
  assert(isDeepStrictEqual(got, want), `${what}\n     got  ${show(got)}\n     want ${show(want)}`);
}

// ---- Environment: fakes only ----

process.env.NEXT_PUBLIC_APP_URL = 'https://famcal.test';

const networkAttempts: string[] = [];
globalThis.fetch = (async (input: unknown) => {
  networkAttempts.push(String(input));
  throw new Error('network is blocked in this smoke test');
}) as typeof fetch;

const unhandled: unknown[] = [];
process.on('unhandledRejection', reason => {
  unhandled.push(reason);
});

// ---- Clock: every argument-less new Date() and Date.now() reads `clock` ----

/** 06:30 on Saturday 17 October 2026 in Israel, 23:30 on Friday the 16th in New York. */
const MORNING = Date.parse('2026-10-17T03:30:00Z');
/** Ten seconds past midnight in Israel, Sunday the 18th: a retry that crossed midnight. */
const PAST_MIDNIGHT = Date.parse('2026-10-17T21:00:10Z');
let clock = MORNING;
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

// ---- Fixtures ----

const IL = 'Asia/Jerusalem';
const NY = 'America/New_York';
const MINE: CalendarAssignment = { calendarId: 'noa@gmail.com', labels: ['yours'], name: 'Noa', color: '#039BE5' };
const KIDS: CalendarAssignment = { calendarId: 'family.kids@group.calendar.google.com', labels: ['kids'], name: 'Kids', color: '#33b679' };
const HOME: CalendarAssignment = { calendarId: 'native:home1', labels: ['yours'], name: 'Home', color: '#039BE5' };
const GOOGLE_IDS = [MINE.calendarId, KIDS.calendarId];

function fixtureUser(o: Partial<UserConfig> & { id: number }): UserConfig {
  return {
    name: 'Noa', englishName: 'Noa', gender: 'female', language: 'en', culture: 'default',
    calendarSource: 'GOOGLE', googleRefreshToken: 'refresh-token', calendarAssignments: [MINE, KIDS],
    messagingPlatform: 'telegram', whatsappPhone: null, isAdmin: true, weatherEnabled: false, location: 'Tel Aviv',
    textSummaryEnabled: true, voiceSummaryEnabled: true, includeLookaheadInTomorrow: true, globalRules: [],
    suspendedAt: null, unreachableSince: null,
    ...o,
  } as unknown as UserConfig;
}

// The switch doesn't cover these two.
const LEGACY_GOOGLE = fixtureUser({ id: 1, telegramId: 1001 });
const LEGACY_NATIVE = fixtureUser({ id: 2, telegramId: 1002, language: 'he', calendarSource: 'NATIVE', googleRefreshToken: '', calendarAssignments: undefined });
// It covers these.
const HOME_GOOGLE = fixtureUser({ id: 3, telegramId: 1003, language: 'he' });
const HOME_NATIVE = fixtureUser({ id: 4, telegramId: 1004, language: 'ru', calendarSource: 'NATIVE', googleRefreshToken: '', calendarAssignments: undefined });
const HOME_NEW_YORK = fixtureUser({ id: 5, telegramId: 1005, location: 'Brooklyn' });
const HOME_WHATSAPP = fixtureUser({ id: 6, telegramId: null, language: 'ru', messagingPlatform: 'whatsapp', whatsappPhone: '972500000006' });
const USERS = [LEGACY_GOOGLE, LEGACY_NATIVE, HOME_GOOGLE, HOME_NATIVE, HOME_NEW_YORK, HOME_WHATSAPP];
const SWITCH_ON = new Set([3, 4, 5, 6]);
const TZ_OF: Record<number, string> = { 5: NY };

const ev = (id: string, start: string, end: string, cal: CalendarAssignment = MINE): CalendarEvent => ({
  summary: `Event ${id}`, start, end, calendarId: cal.calendarId, calendarName: cal.name, eventId: id,
});
/** What either read returns: Friday the 16th to Monday the 19th, in Israel. */
const READ: CalendarEvent[] = [
  ev('fri', '2026-10-16T09:00:00+03:00', '2026-10-16T10:00:00+03:00'),
  ev('sat', '2026-10-17T09:00:00+03:00', '2026-10-17T10:00:00+03:00'),
  ev('sat-kids', '2026-10-17T15:00:00+03:00', '2026-10-17T16:00:00+03:00', KIDS),
  ev('sun', '2026-10-18T09:00:00+03:00', '2026-10-18T10:00:00+03:00'),
  ev('mon', '2026-10-19T09:00:00+03:00', '2026-10-19T10:00:00+03:00'),
];
const NOON_18TH = '2026-10-18T09:00:00.000Z';

// ---- What the fakes saw ----

type DigestCall = { user: UserConfig; day: string; tz: string; ids: string[]; read: DigestRead };
const digestCalls: DigestCall[] = [];
const providerCalls: { method: string; args: unknown[] }[] = [];
const rolloutAsked: UserConfig[] = [];
const lookedUp: UserConfig[] = [];
const reminderDays: string[] = [];
const lookaheadRefs: string[] = [];
type AiCall = { events: string[][]; dayNoon: string; context: SummaryUserContext; weekLookahead: unknown };
const aiCalls: AiCall[] = [];
const headers: { date: string; tz: unknown }[] = [];
type Sent = { via: string; method: string; chatId?: number | string; text: string; format?: MessageFormat };
const sent: Sent[] = [];
const voice: string[] = [];
const admin: string[] = [];
const cleared: unknown[] = [];
const logs: string[] = [];
/** Sentry, as "<context> <level> <message>". */
const captured: string[] = [];

/** What the next day read does, the provider's or the reader's: return events, or throw. */
let readOutcome: () => Promise<CalendarEvent[]>;
/** What the next week block does: its events, or a throw. */
let lookaheadOutcome: () => Promise<CalendarEvent[]>;
let aiText: string;
let scheduledUsers: UserConfig[] = [];

const failWith = (message: string) => async (): Promise<CalendarEvent[]> => {
  throw Object.assign(new Error(message), { day: '2026-10-17' });
};

function reset() {
  clock = MORNING;
  for (const list of [digestCalls, providerCalls, rolloutAsked, lookedUp, reminderDays, lookaheadRefs, aiCalls, headers, sent, voice, admin, cleared, captured]) {
    list.length = 0;
  }
  readOutcome = async () => READ.map(e => ({ ...e }));
  lookaheadOutcome = async () => [READ[4]];
  aiText = 'AI summary';
  scheduledUsers = [];
}

// ---- Fakes ----

function service(via: 'telegram' | 'whatsapp') {
  return {
    sendMessage: async (chatId: number | string, text: string, options?: MessageOptions) => {
      sent.push({ via, method: 'sendMessage', chatId, text, format: options?.format });
      return 500 + sent.length;
    },
    updateMessage: async (chatId: number | string, _messageId: number | string, text: string, options?: MessageOptions) => {
      sent.push({ via, method: 'updateMessage', chatId, text, format: options?.format });
    },
    sendTypingIndicator: async () => {},
  };
}
const telegram = service('telegram');
const whatsapp = service('whatsapp');

/** An open streaming draft, as the Mini App's on-demand path hands one in. */
function draft(): StreamMessageHandle {
  return {
    pushStage: () => {},
    pushDelta: () => {},
    finalize: async (text: string, options?: MessageOptions) => {
      sent.push({ via: 'draft', method: 'finalize', text, format: options?.format });
      return 777;
    },
    cancel: async (text: string, options?: MessageOptions) => {
      sent.push({ via: 'draft', method: 'cancel', text, format: options?.format });
    },
  };
}

const provider = {
  fetchTodayEvents: async (...args: unknown[]) => {
    providerCalls.push({ method: 'fetchTodayEvents', args });
    return readOutcome();
  },
  fetchTomorrowEvents: async (...args: unknown[]) => {
    providerCalls.push({ method: 'fetchTomorrowEvents', args });
    return readOutcome();
  },
};

const SRC = path.resolve(__dirname, '../src');

/** Modules replaced by fakes, by file path; a function fakes part of the real module. */
const stubs: Record<string, object | ((real: Record<string, unknown>) => object)> = {
  [`${SRC}/services/user-service.ts`]: {
    getUserByIdentifier: async (id: number | string) => {
      const found = USERS.find(u => (typeof id === 'number' ? u.telegramId === id : u.whatsappPhone === id));
      if (!found) return null;
      const row = { ...found }; // a fresh row on every lookup, as the database gives
      lookedUp.push(row);
      return row;
    },
    getAllUsers: async () => scheduledUsers.map(u => ({ ...u })),
    getWhatsAppChatId: (u: UserConfig) => u.whatsappPhone ?? null,
    clearGoogleRefreshToken: async (telegramId: bigint) => {
      cleared.push(telegramId);
    },
  },
  [`${SRC}/services/calendar-provider/index.ts`]: {
    getProviderForUser: () => provider,
    getCalendarAssignmentsForUser: async (u: UserConfig) => (u.calendarSource === 'NATIVE' ? [HOME] : (u.calendarAssignments ?? [])),
  },
  [`${SRC}/services/calendar-read/rollout.ts`]: {
    isCalendarHomeOn: async (u: UserConfig) => {
      rolloutAsked.push(u);
      return SWITCH_ON.has(u.id);
    },
  },
  [`${SRC}/services/calendar-read/digest.ts`]: real => ({
    ...real,
    readDigestDay: async (u: UserConfig, day: string, tz: string, ids: readonly string[], read: DigestRead) => {
      digestCalls.push({ user: u, day, tz, ids: [...ids], read });
      return readOutcome();
    },
  }),
  [`${SRC}/lib/timezone.ts`]: { resolveUserTimezone: async (u: UserConfig) => TZ_OF[u.id] ?? IL },
  [`${SRC}/services/native-reminders/open-reminders.ts`]: {
    addDigestReminders: async (_u: UserConfig, events: CalendarEvent[], day: string) => {
      reminderDays.push(day);
      return { events, moreCount: 0 };
    },
  },
  [`${SRC}/services/week-lookahead.ts`]: {
    getWeekLookahead: async (_u: UserConfig, _calendars: unknown, referenceDate: Date) => {
      lookaheadRefs.push(referenceDate.toISOString());
      return { events: await lookaheadOutcome() };
    },
    formatTomorrowLookahead: () => 'Looking ahead: Monday',
  },
  [`${SRC}/services/claude.ts`]: {
    generateSummary: async (...args: unknown[]) => {
      const lists = args.slice(0, 3) as CalendarEvent[][];
      aiCalls.push({
        events: lists.map(list => list.map(e => e.eventId ?? e.summary)),
        dayNoon: (args[10] as Date).toISOString(),
        context: args[15] as SummaryUserContext,
        weekLookahead: args[17],
      });
      return aiText;
    },
    formatDateHeader: (date: Date, _language: unknown, _culture: unknown, tz: string) => {
      headers.push({ date: date.toISOString(), tz });
      return `Header ${date.toISOString()}`;
    },
  },
  [`${SRC}/services/messaging/index.ts`]: {
    MessagingPlatform, MessageFormat,
    getMessagingService: (platform: MessagingPlatform) => (platform === MessagingPlatform.WHATSAPP ? whatsapp : telegram),
  },
  [`${SRC}/services/telegram/bot.ts`]: { getMessagingService: () => telegram },
  [`${SRC}/services/telegram/voice.ts`]: {
    sendVoiceMessage: async (_chatId: number | string, text: string) => {
      voice.push(text);
    },
    sendWeeklyVoiceMessage: async () => {},
  },
  [`${SRC}/services/telegram/commands.ts`]: { sendSetupNudgeIfNeeded: async () => false },
  [`${SRC}/services/analytics-service.ts`]: { trackActivityAsync: () => {}, addBreadcrumb: () => {} },
  [`${SRC}/services/subscription-service.ts`]: {
    checkFeatureAccess: async () => ({ allowed: true }),
    incrementUsage: async () => {},
  },
  [`${SRC}/services/kid-name-detection.ts`]: { sendKidNameFollowUp: async () => {} },
  [`${SRC}/lib/error-capture.ts`]: {
    captureError: (error: unknown, context: string, _extra?: unknown, severity = 'error') => {
      captured.push(`${context} ${severity} ${error instanceof Error ? error.message : String(error)}`);
    },
    captureWarning: (message: string, context: string) => {
      captured.push(`${context} warning ${message}`);
    },
    captureInfo: () => {},
  },
  [`${SRC}/utils/prisma.ts`]: { prisma: {}, withRetry: (fn: () => unknown) => fn() },
  [`${SRC}/utils/redis.ts`]: { redis: { set: async () => 'OK', get: async () => null, del: async () => 0, mget: async () => [] } },
  [`${SRC}/utils/error-notifier.ts`]: {
    notifyAdminError: async (context: string) => {
      admin.push(`error: ${context}`);
    },
    notifyAdminWarning: async (title: string) => {
      admin.push(`warning: ${title}`);
    },
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

// summary.ts loads the timezone, the week lookahead, Redis and the admin notifier with
// import(), which goes through the ES module loader; it gets the same fake, as an ES module.
(globalThis as { seamSmokeFake?: (file: string) => object }).seamSmokeFake = file =>
  fakeFor(file, () => realLoad.call(Module, file, null, false));
if (typeof Module.registerHooks !== 'function') throw new Error('This smoke needs Node 22.15+ (module.registerHooks)');
Module.registerHooks({
  load(url, context, nextLoad) {
    const file = url.startsWith('file:') ? fileURLToPath(url.split('?')[0]) : '';
    if (!(file in stubs) || loadingReal.has(file)) return nextLoad(url, context);
    const fake = (globalThis as unknown as { seamSmokeFake: (file: string) => object }).seamSmokeFake(file);
    const names = Object.keys(fake).map(name => `export const ${name} = fake.${name};`).join('\n');
    return { format: 'module', shortCircuit: true, source: `const fake = globalThis.seamSmokeFake(${JSON.stringify(file)});\n${names}\n` };
  },
});

type BotTexts = {
  errors: Record<string, string>;
  tokenExpired: { title: string; message: string };
  insufficientScopes: { title: string; message: string };
};

const original = { log: console.log, error: console.error, warn: console.warn, info: console.info };

async function main() {
  // The code under test logs timings and the pipeline's errors; keep them out of the report.
  const keep = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };
  Object.assign(console, { log: keep, error: keep, warn: keep, info: keep });

  const summary = await import('../src/services/telegram/summary');
  const digest = await import('../src/services/calendar-read/digest');
  const bot = Object.fromEntries(
    ['en', 'he', 'ru'].map(lang => [lang, JSON.parse(fs.readFileSync(path.resolve(__dirname, `../messages/${lang}.json`), 'utf8')).bot as BotTexts])
  );
  const text = (lang: string, key: 'googleUnreachable' | 'googleOutageNote') => {
    const value = bot[lang].errors[key];
    assert(typeof value === 'string' && value.trim() !== '', `bot.errors.${key} is missing in messages/${lang}.json (Task C2 adds it)`);
    return value;
  };
  // A bot text is reported by its name ("he:errors.calendarFetch"), whatever its copy.
  const names = new Map<string, string>();
  for (const lang of ['en', 'he', 'ru']) {
    const t = bot[lang];
    for (const [key, value] of Object.entries(t.errors)) names.set(value, `${lang}:errors.${key}`);
    names.set(`${t.tokenExpired.title}\n\n${t.tokenExpired.message}`, `${lang}:tokenExpired`);
    names.set(`${t.insufficientScopes.title}\n\n${t.insufficientScopes.message}`, `${lang}:insufficientScopes`);
  }
  const nameOf = (sentText: string) => names.get(sentText) ?? sentText;
  const tomorrowFlag = () => new Date(clock + 24 * 3600 * 1000);
  const readsOf = () => digestCalls.map(c => [c.day, c.tz, c.ids, c.read]);
  const aiEvents = () => aiCalls.map(a => a.events.flat());
  const messages = () => sent.filter(s => s.method !== 'updateMessage').map(s => [s.via, s.method, s.chatId ?? null, nameOf(s.text)]);

  await check("[guard] switch off, Google user: the provider reads today with its three arguments, and the AI's text goes out as written", async () => {
    await summary.sendDailySummaryToUser(1001);
    assertEqual(providerCalls.map(c => [c.method, c.args.length]), [['fetchTodayEvents', 3]], 'the provider reads (method, argument count)');
    assert(providerCalls[0].args[0] === lookedUp[0], 'the provider got another user object than the lookup returned');
    assertEqual(providerCalls[0].args.slice(1), [GOOGLE_IDS, IL], 'the calendar ids and timezone of the read');
    assertEqual(digestCalls.length, 0, 'reader reads');
    assertEqual(aiCalls.map(a => a.events), [[['sat'], [], ['sat-kids']]], 'the events the AI got (mine, spouse, other)');
    assertEqual(messages(), [['telegram', 'sendMessage', 1001, 'AI summary']], 'messages');
    assertEqual(voice, ['AI summary'], 'the voice text');
  });

  await check("[guard] switch off, FamCal user, tomorrow: the provider's tomorrow read, three arguments, and the week block from tomorrow's noon", async () => {
    await summary.sendTomorrowSummaryToUser(1002);
    assertEqual(providerCalls.map(c => [c.method, c.args.length]), [['fetchTomorrowEvents', 3]], 'the provider reads (method, argument count)');
    assertEqual(providerCalls[0].args.slice(1), [[HOME.calendarId], IL], 'the calendar ids and timezone of the read');
    assertEqual(digestCalls.length, 0, 'reader reads');
    assertEqual(aiEvents(), [['sun']], 'the events the AI got');
    assertEqual(lookaheadRefs, [NOON_18TH], 'the week block reference');
    assertEqual(aiCalls[0].weekLookahead, 'Looking ahead: Monday', 'the week block text');
  });

  await check('switch on, Google user: today is read through readDigestDay, on demand, with the fresh user row', async () => {
    await summary.sendDailySummaryToUser(1003);
    assertEqual(providerCalls.map(c => c.method), [], 'provider reads (the switch was ignored)');
    assertEqual(readsOf(), [['2026-10-17', IL, GOOGLE_IDS, { mode: 'onDemand', deadlineMs: 10000 }]], 'reader reads (day, tz, ids, read)');
    assert(digestCalls[0].read === digest.DEFAULT_ON_DEMAND_READ, "the read is not digest.ts's DEFAULT_ON_DEMAND_READ");
    assert(digestCalls[0].user === lookedUp[0], 'the reader got another user object than the lookup returned');
    assert(rolloutAsked.length > 0 && rolloutAsked.every(u => u === lookedUp[0]), 'the switch was not asked with the looked-up user');
    assertEqual(aiCalls.map(a => a.events), [[['sat'], [], ['sat-kids']]], 'the events the AI got (mine, spouse, other)');
    assertEqual(messages(), [['telegram', 'sendMessage', 1003, 'AI summary']], 'messages');
  });

  await check("switch on, tomorrow: the reader reads tomorrow's local date, and the week block starts from its noon", async () => {
    await summary.sendTomorrowSummaryToUser(1003);
    assertEqual(providerCalls.map(c => c.method), [], 'provider reads (the switch was ignored)');
    assertEqual(readsOf(), [['2026-10-18', IL, GOOGLE_IDS, { mode: 'onDemand', deadlineMs: 10000 }]], 'reader reads (day, tz, ids, read)');
    assertEqual(aiEvents(), [['sun']], 'the events the AI got');
    assertEqual(aiCalls[0].dayNoon, NOON_18TH, "the prompt's date");
    assertEqual(lookaheadRefs, [NOON_18TH], 'the week block reference');
  });

  await check('switch on, FamCal user: the reader too, with the built-in calendar ids', async () => {
    await summary.sendDailySummaryToUser(1004);
    assertEqual(providerCalls.map(c => c.method), [], 'provider reads (the switch was ignored)');
    assertEqual(readsOf(), [['2026-10-17', IL, [HOME.calendarId], { mode: 'onDemand', deadlineMs: 10000 }]], 'reader reads (day, tz, ids, read)');
  });

  await check("switch on, New York at 23:30 on Friday: today and tomorrow are New York's dates", async () => {
    await summary.sendDailySummaryToUser(1005);
    await summary.sendTomorrowSummaryToUser(1005);
    assertEqual(providerCalls.map(c => c.method), [], 'provider reads (the switch was ignored)');
    assertEqual(readsOf().map(r => r.slice(0, 2)), [['2026-10-16', NY], ['2026-10-17', NY]], 'reader reads (day, tz)');
  });

  await check("the wrappers hand on the caller's day and read; off the switch, the provider still gets three arguments", async () => {
    await summary.fetchTodayEvents(HOME_GOOGLE, GOOGLE_IDS, IL, '2026-10-17', digest.SCHEDULED_READ);
    await summary.fetchTomorrowEvents(HOME_GOOGLE, GOOGLE_IDS, IL, '2026-10-20', digest.SCHEDULED_RETRY_READ);
    await summary.fetchTomorrowEvents(LEGACY_GOOGLE, GOOGLE_IDS, IL, '2026-10-18', digest.SCHEDULED_READ);
    assertEqual(readsOf().map(r => r[0]), ['2026-10-17', '2026-10-20'], 'reader days');
    assert(digestCalls[0].read === digest.SCHEDULED_READ && digestCalls[1].read === digest.SCHEDULED_RETRY_READ, `reads ${show(digestCalls.map(c => c.read))}`);
    assertEqual(providerCalls.map(c => [c.method, c.args.length]), [['fetchTomorrowEvents', 3]], 'the provider reads (method, argument count)');
  });

  await check("opts.day keeps the first attempt's day past midnight: the read, the shaping, the reminders, the prompt's date, the header and the week block", async () => {
    clock = PAST_MIDNIGHT;
    const result = await summary.prepareSummaryForUser(HOME_GOOGLE, summary.fetchTomorrowEvents, tomorrowFlag(), undefined, undefined, undefined, {
      day: '2026-10-18',
      read: digest.SCHEDULED_RETRY_READ,
    });
    assertEqual(readsOf(), [['2026-10-18', IL, GOOGLE_IDS, { mode: 'scheduled', deadlineMs: 15000 }]], 'reader reads (day, tz, ids, read)');
    assert(digestCalls[0].read === digest.SCHEDULED_RETRY_READ, "the read is not the caller's");
    assertEqual(aiEvents(), [['sun']], 'the events the AI got (shaped to the 18th)');
    assertEqual(reminderDays, ['2026-10-18'], 'the open-reminders day');
    assertEqual(aiCalls[0].dayNoon, NOON_18TH, "the prompt's date");
    assertEqual(headers, [{ date: NOON_18TH, tz: IL }], 'the date header');
    assertEqual(lookaheadRefs, [NOON_18TH], 'the week block reference');
    assertEqual(result.summary, 'AI summary', 'the summary text');
  });

  await check("without opts.day the day is today's rule and the read is on demand: past midnight, tomorrow is the 19th", async () => {
    clock = PAST_MIDNIGHT;
    await summary.prepareSummaryForUser(HOME_GOOGLE, summary.fetchTomorrowEvents, tomorrowFlag());
    assertEqual(readsOf(), [['2026-10-19', IL, GOOGLE_IDS, { mode: 'onDemand', deadlineMs: 10000 }]], 'reader reads (day, tz, ids, read)');
    assertEqual(aiEvents(), [['mon']], 'the events the AI got');
  });

  await check('googleUnavailable, Google user: no read, an empty day, the prompt flagged, no week block, and the outage line under the text', async () => {
    clock = PAST_MIDNIGHT;
    const result = await summary.prepareSummaryForUser(HOME_GOOGLE, summary.fetchTomorrowEvents, tomorrowFlag(), undefined, undefined, undefined, {
      day: '2026-10-18',
      read: digest.SCHEDULED_RETRY_READ,
      googleUnavailable: true,
    });
    assertEqual([digestCalls.length, providerCalls.length], [0, 0], 'reads (reader, provider)');
    assertEqual(aiCalls.map(a => a.events), [[[], [], []]], 'the events the AI got');
    assert(aiCalls[0].context.googleUnavailable === true, `the prompt context has no googleUnavailable: true: ${show(aiCalls[0].context)}`);
    assertEqual([lookaheadRefs, aiCalls[0].weekLookahead], [[], undefined], 'the week block (reads, text)');
    assertEqual(aiCalls[0].dayNoon, NOON_18TH, "the prompt's date");
    assertEqual(result.summary, `AI summary\n\n<i>${text('he', 'googleOutageNote')}</i>`, 'the summary text');
  });

  await check("googleUnavailable: the outage line is in the user's language", async () => {
    for (const [u, lang] of [[HOME_NEW_YORK, 'en'], [HOME_WHATSAPP, 'ru']] as const) {
      const result = await summary.prepareSummaryForUser(u, summary.fetchTodayEvents, undefined, undefined, undefined, undefined, {
        read: digest.SCHEDULED_RETRY_READ,
        googleUnavailable: true,
      });
      assertEqual(result.summary, `AI summary\n\n<i>${text(lang, 'googleOutageNote')}</i>`, `the ${lang} summary text`);
    }
    assertEqual(digestCalls.length, 0, 'reader reads');
  });

  await check('googleUnavailable with an empty AI answer: nothing is added, so delivery still answers "could not generate"', async () => {
    aiText = '';
    const result = await summary.prepareSummaryForUser(HOME_GOOGLE, summary.fetchTodayEvents, undefined, undefined, undefined, undefined, {
      read: digest.SCHEDULED_RETRY_READ,
      googleUnavailable: true,
    });
    assertEqual(result.summary, '', 'the summary text');
  });

  await check("googleUnavailable leaves a FamCal user's read, prompt and text alone", async () => {
    const result = await summary.prepareSummaryForUser(HOME_NATIVE, summary.fetchTodayEvents, undefined, undefined, undefined, undefined, {
      read: digest.SCHEDULED_RETRY_READ,
      googleUnavailable: true,
    });
    assertEqual(readsOf(), [['2026-10-17', IL, [HOME.calendarId], { mode: 'scheduled', deadlineMs: 15000 }]], 'reader reads (day, tz, ids, read)');
    assert(!('googleUnavailable' in aiCalls[0].context), `the prompt context: ${show(aiCalls[0].context)}`);
    assertEqual(result.summary, 'AI summary', 'the summary text');
  });

  await check("[guard] the week block's own Google outage degrades the tomorrow summary: it goes out without the block and with no outage line, and Sentry gets a warning (A-28)", async () => {
    // The day read answered; only the week block (the reader's lookahead, C5) failed.
    lookaheadOutcome = failWith('GOOGLE_FETCH_FAILED');
    await summary.sendTomorrowSummaryToUser(1003);
    assertEqual(lookaheadRefs, [NOON_18TH], 'the week block was asked');
    assertEqual(aiCalls.map(a => [a.events.flat(), a.weekLookahead ?? null]), [[['sun'], null]], "the AI's events and week block");
    assert(!('googleUnavailable' in aiCalls[0].context), `the prompt context: ${show(aiCalls[0].context)}`);
    assertEqual(messages(), [['telegram', 'sendMessage', 1003, 'AI summary']], 'what the user got');
    assertEqual(voice, ['AI summary'], 'the voice text');
    assertEqual(captured, ['summary-week-lookahead warning GOOGLE_FETCH_FAILED'], 'Sentry');
    assertEqual(admin, [], 'admin pages');
  });

  await check("[guard] without the outage flag the prompt context has today's four keys, and nothing goes under the text (A-19)", async () => {
    await summary.sendDailySummaryToUser(1001);
    await summary.sendTomorrowSummaryToUser(1003);
    const keys = ['culture', 'globalRules', 'calendarAssignments', 'openRemindersMore'];
    assertEqual(aiCalls.map(a => Object.keys(a.context)), [keys, keys], 'the prompt context keys');
    assertEqual(messages().map(m => m[3]), ['AI summary', 'AI summary'], 'the texts sent');
    assertEqual(voice, ['AI summary', 'AI summary'], 'the voice texts');
  });

  await check("on demand, Google outage with a draft open: R13's text replaces the draft, and no admin is paged", async () => {
    readOutcome = failWith('GOOGLE_FETCH_FAILED');
    await summary.sendDailySummaryToUser(1003, MessagingPlatform.TELEGRAM, draft());
    text('he', 'googleUnreachable');
    assertEqual(messages(), [['draft', 'cancel', null, 'he:errors.googleUnreachable']], 'what the user got');
    assertEqual(admin, [], 'admin pages');
    assertEqual(aiCalls.length, 0, 'AI calls');
  });

  await check("on demand, Google outage, no draft: R13's text as a message, daily and tomorrow, in the user's language", async () => {
    readOutcome = failWith('GOOGLE_FETCH_FAILED');
    await summary.sendTomorrowSummaryToUser(1005);
    await summary.sendDailySummaryToUser(1003);
    text('en', 'googleUnreachable');
    assertEqual(
      sent.map(s => [s.via, s.method, s.chatId, nameOf(s.text), s.format ?? null]),
      [
        ['telegram', 'sendMessage', 1005, 'en:errors.googleUnreachable', MessageFormat.HTML],
        ['telegram', 'sendMessage', 1003, 'he:errors.googleUnreachable', MessageFormat.HTML],
      ],
      'what the users got (via, method, chat, text, format)'
    );
    assertEqual(admin, [], 'admin pages');
  });

  await check("on demand on WhatsApp, Google outage: R13's text through the WhatsApp service", async () => {
    readOutcome = failWith('GOOGLE_FETCH_FAILED');
    await summary.sendDailySummaryToUser('972500000006', MessagingPlatform.WHATSAPP);
    text('ru', 'googleUnreachable');
    assertEqual(messages(), [['whatsapp', 'sendMessage', '972500000006', 'ru:errors.googleUnreachable']], 'what the user got');
    assertEqual(admin, [], 'admin pages');
  });

  await check('[guard] on demand, dead token: the token text and an admin warning', async () => {
    readOutcome = failWith('GOOGLE_TOKEN_EXPIRED');
    await summary.sendDailySummaryToUser(1003);
    assertEqual(messages(), [['telegram', 'sendMessage', 1003, 'he:tokenExpired']], 'what the user got');
    assertEqual(admin, ['warning: Token Expired'], 'admin pages');
  });

  await check('[guard] on demand, missing scopes: the scopes text, the token cleared, and an admin warning', async () => {
    readOutcome = failWith('GOOGLE_INSUFFICIENT_SCOPES');
    await summary.sendDailySummaryToUser(1003);
    assertEqual(messages(), [['telegram', 'sendMessage', 1003, 'he:insufficientScopes']], 'what the user got');
    assertEqual(cleared, [BigInt(1003)], 'tokens cleared');
    assertEqual(admin, ['warning: Insufficient Scopes'], 'admin pages');
  });

  await check("[guard] on demand, any other read error: the pipeline's fetch texts and the admin notice (A-28)", async () => {
    readOutcome = async () => {
      throw new Error('connection reset');
    };
    await summary.sendDailySummaryToUser(1004);
    await summary.sendTomorrowSummaryToUser(1004);
    assertEqual(
      messages(),
      [
        ['telegram', 'sendMessage', 1004, 'ru:errors.calendarFetch'],
        ['telegram', 'sendMessage', 1004, 'ru:errors.tomorrowFetch'],
      ],
      'what the user got'
    );
    assertEqual(admin, ['error: Summary Generation', 'error: Summary Generation'], 'admin pages');
  });

  await check("[guard] scheduled, switch off: the provider's read, the text and the voice note as before", async () => {
    scheduledUsers = [LEGACY_GOOGLE];
    const result = await summary.sendDailySummaryToAll();
    assertEqual(result.processed, 1, 'users processed');
    assertEqual(providerCalls.map(c => [c.method, c.args.length]), [['fetchTodayEvents', 3]], 'the provider reads (method, argument count)');
    assertEqual(digestCalls.length, 0, 'reader reads');
    assertEqual(messages(), [['telegram', 'sendMessage', 1001, 'AI summary']], 'messages');
    assertEqual(voice, ['AI summary'], 'the voice text');
  });

  await check('nothing left over: no unhandled rejection, no network', async () => {
    await new Promise(resolve => setImmediate(resolve));
    assertEqual(unhandled.map(String), [], 'unhandled rejections');
    assertEqual(networkAttempts, [], 'network attempts');
  });

  Object.assign(console, original);
  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  // The pipeline's 50 s operation timer is never cleared; don't wait for it.
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => {
  Object.assign(console, original);
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Add the fallback checks to `scripts/smoke-calendar-home-rollout.ts`**

Two edits. Line numbers are those of the file at 716a4f8.

Edit 2a, the header (line 7). Before:

```ts
// whether Redis took the value. The admin settings route accepts only the three values,
```

After:

```ts
// whether Redis took the value. When neither store answers, the OFF is kept 5 s with one
// warning, so a summary batch asking per user doesn't hit both stores for each of them.
// The admin settings route accepts only the three values,
```

Edit 2b, the both-stores-down check becomes three (lines 254-263). Before:

```ts
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
```

After:

```ts
  await check('Redis and the DB both down: OFF with one warning, kept for 5 s, then the next read after recovery sees the DB', async () => {
    reset();
    redisState.getDown = true;
    db.down = true;
    assert((await getCalendarHomeRollout()) === 'OFF', 'not OFF');
    assert(captured.join(' | ') === 'calendar-home-rollout:warning', `captured ${captured.join(' | ')}`);
    redisState.getDown = false;
    db.down = false;
    db.row = { ...COLUMN_DEFAULTS, calendarHomeRollout: 'ADMINS' };
    clock += 4_999;
    assert((await getCalendarHomeRollout()) === 'OFF', 'the fallback was not kept for 5 s');
    clock += 1;
    assert((await getCalendarHomeRollout()) === 'ADMINS', 'the fallback outlived 5 s');
    assert(reads('redis get') === 2 && reads('db find') === 2, `log ${log.join(' | ')}`);
  });

  await check('Redis has nothing and the DB is down: OFF kept for 5 s too, with one warning', async () => {
    reset();
    db.down = true;
    assert((await getCalendarHomeRollout()) === 'OFF', 'not OFF');
    clock += 4_999;
    assert((await getCalendarHomeRollout()) === 'OFF', 'second read');
    assert(log.join(' | ') === `redis get ${KEY} | db find`, `log ${log.join(' | ')}`);
    assert(captured.length === 1, `captured ${captured.join(' | ')}`);
  });

  await check('a 20-user batch with both stores down, each user asking twice a second apart: one Redis and one DB attempt and one warning per 5 s', async () => {
    reset();
    redisState.getDown = true;
    db.down = true;
    const answers: boolean[] = [];
    for (let i = 0; i < 20; i++) {
      const user = { isAdmin: i % 2 === 0 };
      answers.push(await isCalendarHomeOn(user)); // the day read
      answers.push(await isCalendarHomeOn(user)); // the tomorrow summary's week block
      clock += 1_000;
    }
    assert(answers.length === 40 && answers.every(a => a === false), `answers ${JSON.stringify(answers)}`);
    // The users read at 0 to 19 s, so the stores are asked at 0, 5, 10 and 15 s.
    assert(reads('redis get') === 4 && reads('db find') === 4, `redis ${reads('redis get')}, db ${reads('db find')}`);
    assert(captured.length === 4, `${captured.length} warnings`);
  });
```

- [ ] **Step 3: Run both and see them fail; record the regression smokes' baseline**

```bash
cd /Users/razielgershoni/development/famcalbot
for tz in UTC Asia/Jerusalem Pacific/Kiritimati; do TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-summary-seam.ts; echo "smoke-summary-seam $tz exit=$?"; done
TZ=UTC DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-calendar-home-rollout.ts 2>&1 | grep -E '^FAIL|passed'; echo "smoke-calendar-home-rollout exit=${pipestatus[1]}"
for f in smoke-google-connect smoke-native-reminder-digest smoke-partner-labels smoke-voice-dates smoke-weather-prompt smoke-weather-command smoke-admin-panel-ssr smoke-calendar-range; do for tz in UTC Asia/Jerusalem Pacific/Kiritimati; do TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/$f.ts 2>&1 | grep -E '^(OK|FAIL)|passed' > /tmp/c3-$f-${tz//\//_}.before; echo "$f $tz exit=${pipestatus[1]} | $(tail -1 /tmp/c3-$f-${tz//\//_}.before)"; done; done
```

Expected for the new smoke, under `TZ=UTC`:
```
OK  [guard] switch off, Google user: the provider reads today with its three arguments, and the AI's text goes out as written
OK  [guard] switch off, FamCal user, tomorrow: the provider's tomorrow read, three arguments, and the week block from tomorrow's noon
OK  switch on, Google user: today is read through readDigestDay, on demand, with the fresh user row
OK  switch on, tomorrow: the reader reads tomorrow's local date, and the week block starts from its noon
OK  switch on, FamCal user: the reader too, with the built-in calendar ids
OK  switch on, New York at 23:30 on Friday: today and tomorrow are New York's dates
OK  the wrappers hand on the caller's day and read; off the switch, the provider still gets three arguments
OK  opts.day keeps the first attempt's day past midnight: the read, the shaping, the reminders, the prompt's date, the header and the week block
OK  without opts.day the day is today's rule and the read is on demand: past midnight, tomorrow is the 19th
OK  googleUnavailable, Google user: no read, an empty day, the prompt flagged, no week block, and the outage line under the text
OK  googleUnavailable: the outage line is in the user's language
OK  googleUnavailable with an empty AI answer: nothing is added, so delivery still answers "could not generate"
OK  googleUnavailable leaves a FamCal user's read, prompt and text alone
OK  [guard] the week block's own Google outage degrades the tomorrow summary: it goes out without the block and with no outage line, and Sentry gets a warning (A-28)
OK  [guard] without the outage flag the prompt context has today's four keys, and nothing goes under the text (A-19)
OK  on demand, Google outage with a draft open: R13's text replaces the draft, and no admin is paged
OK  on demand, Google outage, no draft: R13's text as a message, daily and tomorrow, in the user's language
OK  on demand on WhatsApp, Google outage: R13's text through the WhatsApp service
OK  [guard] on demand, dead token: the token text and an admin warning
OK  [guard] on demand, missing scopes: the scopes text, the token cleared, and an admin warning
OK  [guard] on demand, any other read error: the pipeline's fetch texts and the admin notice (A-28)
OK  [guard] scheduled, switch off: the provider's read, the text and the voice note as before
OK  nothing left over: no unhandled rejection, no network

23/23 passed (process TZ=UTC)
smoke-summary-seam UTC exit=0
```
Then the same lines under `Asia/Jerusalem` and `Pacific/Kiritimati`, with that zone in the count line.

Why it fails:
- The four "switch on" checks: the wrappers never ask the switch, so the provider reads the day.
- The wrapper check and the `opts` checks: `summary.ts` doesn't export `fetchTodayEvents`, `fetchTomorrowEvents` or `prepareSummaryForUser` yet.
- The three outage checks: `GOOGLE_FETCH_FAILED` falls through to the pipeline's `calendarFetch` / `tomorrowFetch` text, and an admin is paged.
- The 8 `[guard]` checks and the last check pass already. They must keep passing.

Expected for the rollout smoke:
```
FAIL  Redis and the DB both down: OFF with one warning, kept for 5 s, then the next read after recovery sees the DB — captured calendar-home-rollout:warning | calendar-home-rollout:warning
FAIL  Redis has nothing and the DB is down: OFF kept for 5 s too, with one warning — log redis get chome:rollout | db find | redis get chome:rollout | db find
FAIL  a 20-user batch with both stores down, each user asking twice a second apart: one Redis and one DB attempt and one warning per 5 s — redis 40, db 40
32/35 passed
smoke-calendar-home-rollout exit=1
```
Today the fallback is not remembered: each read tries both stores again and warns twice.

`npx tsc --noEmit -p .` reports 15 `TS2339` errors in `scripts/smoke-summary-seam.ts` (`fetchTodayEvents`, `fetchTomorrowEvents` and `prepareSummaryForUser` don't exist on the module) until Steps 4 and 5 add the exports. Nothing else fails.

Expected for the regression smokes: every run `exit=0`. The counts are `30/30`, `33/33`, `19/19`, `77/77`, `14/14`, `10/10`, `10/10` and `24/24`. The `/tmp/c3-*.before` files are the baseline for Step 8.

- [ ] **Step 4: Switch-aware fetch wrappers in `src/services/telegram/summary.ts` (`:5-14`)**

Before:

```ts
import { getUserByIdentifier, getAllUsers, getWhatsAppChatId } from '../user-service';
import { getProviderForUser, getCalendarAssignmentsForUser } from '../calendar-provider';

// Provider-aware fetchers that match the fetchFunction signature in summary callers.
// These are stable wrappers around getProviderForUser(user) so PR 4 can change
// provider dispatch without re-touching summary call sites.
const fetchTodayEvents = (user: UserConfig, calendarIds: string[], tz?: string): Promise<CalendarEvent[]> =>
  getProviderForUser(user).fetchTodayEvents(user, calendarIds, tz);
const fetchTomorrowEvents = (user: UserConfig, calendarIds: string[], tz?: string): Promise<CalendarEvent[]> =>
  getProviderForUser(user).fetchTomorrowEvents(user, calendarIds, tz);
```

After:

```ts
import { getUserByIdentifier, getAllUsers, getWhatsAppChatId } from '../user-service';
import { getProviderForUser, getCalendarAssignmentsForUser } from '../calendar-provider';
import { isCalendarHomeOn } from '../calendar-read/rollout';
import { DEFAULT_ON_DEMAND_READ, readDigestDay, type DigestRead } from '../calendar-read/digest';
import type { DayKey } from '../calendar-read/types';

/**
 * How a summary reads its day: the user, their resolved calendar ids, their timezone,
 * the summary day (prepareSummaryForUser decides it) and the run's mode and deadline.
 */
export type SummaryFetch = (
  user: UserConfig,
  calendarIds: string[],
  timezone: string,
  day: DayKey,
  read?: DigestRead
) => Promise<CalendarEvent[]>;

// The summaries' day reads (calendar home spec §3.1). A user the rollout switch covers
// reads the summary day through the shared reader, with the run's mode and deadline (on
// demand unless the caller says otherwise). Its Google failures come back as
// GOOGLE_TOKEN_EXPIRED, GOOGLE_INSUFFICIENT_SCOPES or GOOGLE_FETCH_FAILED. Everyone else
// keeps the provider's read, which ignores `day` and `read` and picks the same day
// itself, so their summaries stay as they are today (A-33). One wrapper serves on-demand
// and scheduled runs alike: the mode comes with `read`.
export const fetchTodayEvents: SummaryFetch = async (user, calendarIds, tz, day, read = DEFAULT_ON_DEMAND_READ) =>
  (await isCalendarHomeOn(user))
    ? readDigestDay(user, day, tz, calendarIds, read)
    : getProviderForUser(user).fetchTodayEvents(user, calendarIds, tz);
export const fetchTomorrowEvents: SummaryFetch = async (user, calendarIds, tz, day, read = DEFAULT_ON_DEMAND_READ) =>
  (await isCalendarHomeOn(user))
    ? readDigestDay(user, day, tz, calendarIds, read)
    : getProviderForUser(user).fetchTomorrowEvents(user, calendarIds, tz);
```

The `import` lines after the wrappers (`:15` on) stay where they are: imports are hoisted, and the file already declared the wrappers between imports.

- [ ] **Step 5: `prepareSummaryForUser` takes the day, the read and the outage flag**

Make five edits in `src/services/telegram/summary.ts`. Each Before block appears exactly once. Line numbers are as of 716a4f8; Step 4 moves them down by 23, so match on the text.

Edit 5a (`:77-86`). Before:

```ts
type StreamStage = 'fetchingCalendar' | 'lookingAhead' | 'fetchingWeather' | 'composing';

async function prepareSummaryForUser(
  user: UserConfig,
  fetchFunction: (user: UserConfig, calendarIds: string[], timezone?: string) => Promise<CalendarEvent[]>,
  summaryDate: Date | undefined,
  modelId?: string,
  onTextDelta?: (delta: string, accumulated: string) => void | Promise<void>,
  onStageChange?: (stage: StreamStage) => void
): Promise<PreparedSummary> {
```

After:

```ts
type StreamStage = 'fetchingCalendar' | 'lookingAhead' | 'fetchingWeather' | 'composing';

/**
 * Builds one user's summary. `summaryDate` is the tomorrow flag (set: tomorrow). `opts`
 * comes from the callers (calendar home spec §3.1):
 * - `day`: the summary day. Unset, it is today's rule: the user's local date, plus one
 *   calendar day for tomorrow. The scheduled retry passes the first attempt's day, so a
 *   retry that crosses midnight still reads, shapes and dates that day (A-7).
 * - `read`: the run's mode and deadline, handed to the fetch. Only the shared reader
 *   (switch-covered users) uses it.
 * - `googleUnavailable`: the outage run, after Google failed the first attempt and the
 *   retry. A Google user's day is then empty, with no read and no week block; the prompt
 *   is told why, and the outage line goes under the summary.
 */
export async function prepareSummaryForUser(
  user: UserConfig,
  fetchFunction: SummaryFetch,
  summaryDate: Date | undefined,
  modelId?: string,
  onTextDelta?: (delta: string, accumulated: string) => void | Promise<void>,
  onStageChange?: (stage: StreamStage) => void,
  opts?: { day?: DayKey; read?: DigestRead; googleUnavailable?: boolean }
): Promise<PreparedSummary> {
```

Edit 5b (`:115-118`). Before:

```ts
  const today = localDate(new Date(), userTimezone);
  const day = summaryDate ? nextDate(today) : today;
  const dayNoon = fromZonedTime(`${day} 12:00:00`, userTimezone);
  const dayEvents = shapeEventsForDay(await fetchFunction(user, allCalendarIds, userTimezone), day, userTimezone);
```

After:

```ts
  const today = localDate(new Date(), userTimezone);
  const day = opts?.day ?? (summaryDate ? nextDate(today) : today);
  const dayNoon = fromZonedTime(`${day} 12:00:00`, userTimezone);
  // The outage run: Google failed this summary twice. A user reads one source in this
  // first step, so a Google user's day is empty, with no read.
  const googleOut = opts?.googleUnavailable === true && user.calendarSource === 'GOOGLE';
  const fetched = googleOut ? [] : await fetchFunction(user, allCalendarIds, userTimezone, day, opts?.read);
  const dayEvents = shapeEventsForDay(fetched, day, userTimezone);
```

Edit 5c (`:140-147`). Before:

```ts
    calendarAssignments: assignments,
    openRemindersMore,
  };

  // Fetch week lookahead if enabled for tomorrow summary
  let weekLookaheadText: string | undefined;
  let lookaheadMs = 0;
  if (summaryDate && user.includeLookaheadInTomorrow) {
```

After:

```ts
    calendarAssignments: assignments,
    openRemindersMore,
    // Only on the outage run, so every other prompt stays as it is (A-19).
    ...(googleOut ? { googleUnavailable: true } : {}),
  };

  // Fetch week lookahead if enabled for tomorrow summary. The outage run has none: a
  // Google user's week block is all Google, and Google couldn't be reached.
  let weekLookaheadText: string | undefined;
  let lookaheadMs = 0;
  if (summaryDate && user.includeLookaheadInTomorrow && !googleOut) {
```

Edit 5d (`:174-175`). Before:

```ts
  const tAI = Date.now();
  const summary = await generateSummary(
```

After:

```ts
  const tAI = Date.now();
  const generated = await generateSummary(
```

Edit 5e (`:198-200`). Before:

```ts
  const aiMs = Date.now() - tAI;

  // Generate date header for voice-only delivery
```

After:

```ts
  const aiMs = Date.now() - tAI;

  // The outage run says so under the summary. deliverSummary sends this text and voices
  // it, so the line reaches both (A-32). An empty answer stays empty, so deliverSummary
  // still answers it with "could not generate".
  let summary = generated;
  if (googleOut && generated.trim() !== '') {
    const t = await getBotMessages(user.language || 'en');
    summary = `${generated}\n\n<i>${t.errors.googleOutageNote}</i>`;
  }

  // Generate date header for voice-only delivery
```

`return { summary, dateHeader, otherEvents: categorized.otherEvents };` (`:211`) is unchanged: it now returns the text with the outage line when there is one.

- [ ] **Step 6: `sendSummaryToUser` reads on demand and answers R13; both senders take `SummaryFetch`**

Make four edits in `src/services/telegram/summary.ts`. Each Before block appears exactly once.

Edit 6a (`:218-220`). Before:

```ts
export async function sendSummaryToUser(
  chatId: number | string,
  fetchFunction: (user: UserConfig, calendarIds: string[], timezone?: string) => Promise<CalendarEvent[]>,
```

After:

```ts
export async function sendSummaryToUser(
  chatId: number | string,
  fetchFunction: SummaryFetch,
```

Edit 6b (`:283`). Before:

```ts
      return prepareSummaryForUser(user, fetchFunction, summaryDate, modelId, onTextDelta, onStageChange);
```

After:

```ts
      return prepareSummaryForUser(user, fetchFunction, summaryDate, modelId, onTextDelta, onStageChange, {
        read: DEFAULT_ON_DEMAND_READ,
      });
```

Edit 6c (`:328-333`, the end of the token branch in `sendSummaryToUser`'s `onError`; the batch's token branch says `(${user.name})` and doesn't match). Before:

```ts
          `User ${user.id} needs to refresh their Google Calendar token`
        );
        return true;
      }

      return false;
```

After:

```ts
          `User ${user.id} needs to refresh their Google Calendar token`
        );
        return true;
      }

      // Ruling R13: Google couldn't be reached, even after the reader's quick retry. It
      // isn't the user's token, so they're told to try again in a minute, and no admin
      // is paged.
      if (error.message === 'GOOGLE_FETCH_FAILED') {
        const t = await getBotMessages(userLanguage);
        const unreachable = t.errors.googleUnreachable;
        if (streamHandle) {
          await streamHandle.cancel(unreachable, { format: MessageFormat.HTML });
        } else {
          await messagingService.sendMessage(chatId, unreachable, { format: MessageFormat.HTML });
        }
        return true;
      }

      return false;
```

Edit 6d (`:349-350`). Before:

```ts
async function sendSummaryToAll(
  fetchFunction: (user: UserConfig, calendarIds: string[], timezone?: string) => Promise<CalendarEvent[]>,
```

After:

```ts
async function sendSummaryToAll(
  fetchFunction: SummaryFetch,
```

Nothing else in the file changes. In particular, `sendSummaryToAll`'s loop (`:389-506`), `deliverSummary`, `routeTextMessage` and the four public senders (`sendDailySummaryToUser`, `sendDailySummaryToAll`, `sendTomorrowSummaryToUser`, `sendTomorrowSummaryToAll`) are unchanged. The senders still pass the wrappers.

- [ ] **Step 7: The switch remembers its fallback for 5 s, in `src/services/calendar-read/rollout.ts`**

Six edits, in file order. Line numbers are those of the file at 716a4f8.

Edit 7a, the header (lines 12-14). Before:

```ts
 * minute. Anything that is not one of the three values, both stores failing, or no row
 * reads as OFF: the old home and today's summary path.
 */
```

After:

```ts
 * minute. Anything that is not one of the three values, both stores failing, or no row
 * reads as OFF: the old home and today's summary path.
 *
 * When neither store answers, that OFF is kept for 5 s, with one warning. The summaries
 * ask the switch once or twice per user, so during a Redis and DB outage a batch would
 * otherwise retry both stores, and warn twice, for every user it reaches.
 */
```

Edit 7b, the fallback's memo time (line 25). Before:

```ts
const MEMO_MS = 30_000;
```

After:

```ts
const MEMO_MS = 30_000;
/** How long the OFF of a read that neither store answered is kept. */
const FALLBACK_MEMO_MS = 5_000;
```

Edit 7c, the memo's type (line 29). Before:

```ts
type Memo = { value: CalendarHomeRolloutValue; at: number };
```

After:

```ts
type Memo = { value: CalendarHomeRolloutValue; at: number; fallback?: true };
```

Edit 7d, `warn` takes a context (lines 41-43). Before:

```ts
function warn(error: unknown): void {
  captureError(error, CONTEXT, {}, 'warning');
}
```

After:

```ts
function warn(error: unknown, extra: Record<string, unknown> = {}): void {
  captureError(error, CONTEXT, extra, 'warning');
}
```

Edit 7e, the memo check and the Redis failure (lines 45-67). Before:

```ts
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
```

After:

```ts
/** The switch as this process sees it: the memo, then Redis, then the DB; OFF when nothing answers. */
export async function getCalendarHomeRollout(): Promise<CalendarHomeRolloutValue> {
  const memo = shared.__calendarHomeRolloutMemo;
  if (memo) {
    const age = Date.now() - memo.at;
    if (age >= 0 && age < (memo.fallback ? FALLBACK_MEMO_MS : MEMO_MS)) return memo.value;
  }

  let redisUp = true;
  let redisError: unknown;
  let cached: unknown = null;
  try {
    cached = await redis.get<string>(KEY);
    if (isCalendarHomeRolloutValue(cached)) return remember(cached);
  } catch (error) {
    redisUp = false;
    redisError = error;
  }

  try {
    const settings = await prisma.adminSettings.findUnique({
      where: { id: 'global' },
      select: { calendarHomeRollout: true },
    });
    // Redis failed but the DB answered: one warning, and the value is kept 30 s.
    if (!redisUp) warn(redisError);
```

Edit 7f, the fallback (lines 80-85). Before:

```ts
    return remember(value);
  } catch (error) {
    warn(error);
    return 'OFF';
  }
}
```

After:

```ts
    return remember(value);
  } catch (error) {
    // Neither store answered: OFF for the next 5 s, with this one warning for both.
    warn(error, { stage: redisUp ? 'db' : 'redis and db' });
    shared.__calendarHomeRolloutMemo = { value: 'OFF', at: Date.now(), fallback: true };
    return 'OFF';
  }
}
```

`isCalendarHomeOn` and `setCalendarHomeRollout` are unchanged; the setter's `shared.__calendarHomeRolloutMemo = null` clears the fallback too.

- [ ] **Step 8: Run the smokes and the regression smokes again**

```bash
cd /Users/razielgershoni/development/famcalbot
for tz in UTC Asia/Jerusalem Pacific/Kiritimati; do TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-summary-seam.ts; echo "smoke-summary-seam $tz exit=$?"; done
for tz in UTC Asia/Jerusalem Pacific/Kiritimati; do TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-calendar-home-rollout.ts 2>&1 | grep -E '^FAIL|passed'; echo "smoke-calendar-home-rollout $tz exit=${pipestatus[1]}"; done
for f in smoke-google-connect smoke-native-reminder-digest smoke-partner-labels smoke-voice-dates smoke-weather-prompt smoke-weather-command smoke-admin-panel-ssr smoke-calendar-range; do for tz in UTC Asia/Jerusalem Pacific/Kiritimati; do TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/$f.ts 2>&1 | grep -E '^(OK|FAIL)|passed' > /tmp/c3-$f-${tz//\//_}.after; echo "$f $tz exit=${pipestatus[1]}"; cmp -s /tmp/c3-$f-${tz//\//_}.before /tmp/c3-$f-${tz//\//_}.after && echo "  same output as Step 3" || echo "  OUTPUT CHANGED"; done; done
```

Expected for the new smoke, under `TZ=UTC`:
```
OK  [guard] switch off, Google user: the provider reads today with its three arguments, and the AI's text goes out as written
OK  [guard] switch off, FamCal user, tomorrow: the provider's tomorrow read, three arguments, and the week block from tomorrow's noon
OK  switch on, Google user: today is read through readDigestDay, on demand, with the fresh user row
OK  switch on, tomorrow: the reader reads tomorrow's local date, and the week block starts from its noon
OK  switch on, FamCal user: the reader too, with the built-in calendar ids
OK  switch on, New York at 23:30 on Friday: today and tomorrow are New York's dates
OK  the wrappers hand on the caller's day and read; off the switch, the provider still gets three arguments
OK  opts.day keeps the first attempt's day past midnight: the read, the shaping, the reminders, the prompt's date, the header and the week block
OK  without opts.day the day is today's rule and the read is on demand: past midnight, tomorrow is the 19th
OK  googleUnavailable, Google user: no read, an empty day, the prompt flagged, no week block, and the outage line under the text
OK  googleUnavailable: the outage line is in the user's language
OK  googleUnavailable with an empty AI answer: nothing is added, so delivery still answers "could not generate"
OK  googleUnavailable leaves a FamCal user's read, prompt and text alone
OK  [guard] without the outage flag the prompt context has today's four keys, and nothing goes under the text (A-19)
OK  on demand, Google outage with a draft open: R13's text replaces the draft, and no admin is paged
OK  on demand, Google outage, no draft: R13's text as a message, daily and tomorrow, in the user's language
OK  on demand on WhatsApp, Google outage: R13's text through the WhatsApp service
OK  [guard] on demand, dead token: the token text and an admin warning
OK  [guard] on demand, missing scopes: the scopes text, the token cleared, and an admin warning
OK  [guard] on demand, any other read error: the pipeline's fetch texts and the admin notice (A-28)
OK  [guard] scheduled, switch off: the provider's read, the text and the voice note as before
OK  nothing left over: no unhandled rejection, no network

22/22 passed (process TZ=UTC)
smoke-summary-seam UTC exit=0
```
Then the same under `Asia/Jerusalem` and `Pacific/Kiritimati`, with that zone in the count line.

The rollout smoke prints `35/35 passed` and `exit=0` under each clock.

Every regression run prints `exit=0` and `same output as Step 3`. (`smoke-partner-labels` stubs Redis without `get` and Prisma without `adminSettings`, so it reads the switch's fallback; its OK lines are the same.)

If only the `text(...)` assertions fail ("bot.errors.googleUnreachable is missing in messages/he.json (Task C2 adds it)"), C2 hasn't landed. Land it first, and don't change the check.

- [ ] **Step 9: Type-check and lint**

```bash
cd /Users/razielgershoni/development/famcalbot
npx tsc --noEmit -p . && npm run -s lint; echo "exit $?"
```
Expected: no output from either, then `exit 0`. The 15 `TS2339` errors from Step 3 are gone. `next build` type-checks `scripts/**`, so the smoke is covered too. No message file changed, so `check-i18n-parity` is unaffected.

- [ ] **Step 10: Commit**

```bash
cd /Users/razielgershoni/development/famcalbot
git add src/services/telegram/summary.ts src/services/calendar-read/rollout.ts scripts/smoke-summary-seam.ts scripts/smoke-calendar-home-rollout.ts
git commit -m "$(cat <<'EOF'
feat(summary): switch-covered summaries read their day through the reader

The daily and tomorrow summaries now ask the calendar home switch before
they read the day. A user it covers reads the summary day through
readDigestDay, with the run's mode and deadline (on demand: 10 s); every
other user keeps the provider's read with today's arguments.
prepareSummaryForUser takes the summary day, the read and the outage flag
from its caller, ready for the scheduled retry: the outage run reads
nothing for a Google user, skips the week block, flags the prompt and puts
the outage line under the text. An on-demand summary that can't reach
Google answers "try again in a minute" (R13), in place of an open draft,
and pages no admin. The switch stays OFF.

The switch now keeps its OFF fallback for 5 s, with one warning, when
neither Redis nor the database answers, so a batch asking per user no
longer retries both stores and warns twice for every user it reaches.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
EOF
)"
```
Stage only these four paths.

---

### Task 4 (C4): Scheduled summaries retry Google once, then go out with an outage line (spec §3.1 step 6, deliberate change C5)

**Interface change versus the split: none.** One addition the split leaves open ("injectable sleep for the smoke"): `summary.ts` exports the test-only hook `__setScheduledRetrySleepForTests`. One behaviour addition: the outage run records a Sentry warning, context `summary-google-outage`.

**Additions from the review** (no signature of the split changes):
- `markSummarySent(userId, summaryType, timezone, sentFor?)` (`src/lib/summary-scheduling.ts`) takes an optional moment whose local date the mark is for, default now. The retry, the outage run and a rolled-back retry pass the batch's start.
- The batch puts the users the switch doesn't cover first, in their own order, and the covered users after them.
- A retry whose user the switch no longer covers (a rollback during the wait) gets today's path.
- One Sentry warning per batch that sets users aside, context `summary-google-retry`, with the count, before the wait.
- One closing log line per batch: `[Batch Summary] <daily|tomorrow> done: processed=… set aside=… total=…ms`.
- `handleDailySummary` (`src/cron/handlers.ts`) runs the reminder-cache sync and the 04:00 UTC OAuth clean-up beside the batch, not after it.

**What and why:** Owner decision 9: when Google can't be reached at send time, retry once about 30 s later, then send the summary with one line saying Google couldn't be reached; never skip silently. This task does it in `sendSummaryToAll`, the scheduled daily and tomorrow batch. For a user the rollout switch covers, a first attempt that throws `GOOGLE_FETCH_FAILED` (C1's digest adapter, for a Google `error` other than `calendars_gone`) is set aside with the error's `day`, and the loop moves on, so nobody else waits on Google. After the loop the run waits until 30 s have passed since the first such failure, then retries each set-aside user once, in order, with `{ day, read: SCHEDULED_RETRY_READ }`. Only a second `GOOGLE_FETCH_FAILED` takes the outage run `{ day, read: SCHEDULED_RETRY_READ, googleUnavailable: true }`, which C3 turns into a summary with no Google read, C2's guideline line and the outage line; it is delivered, counted and marked sent. Any other error on the retry goes the way it always went: a dead token gets the token text with the refresh button, an admin warning and no dedup mark (A-24); missing scopes are Sentry only (A-25). First attempts now pass `{ read: SCHEDULED_READ }` (the 30 s scheduled deadline, spec §2.2).

Five more pieces come from the review of this plan:
- **The batch's date on the retry's marks.** `markSummarySent` dated the mark when it was written. A 23:00 tomorrow summary retried after midnight was marked for the next day; with the 23 h TTL, that mark skipped the user's next evening's summary. Now the retry and the outage run mark for the batch's own start. With the switch at `ALL` during a real outage the retry phase runs one user after another, about 15 s of read and an AI call each, so a 23:00 batch with about 100 Google users does cross midnight.
- **Users the switch doesn't cover go first.** The loop is sequential. A covered user's first attempt can take up to 30 s for the day read during a Google stall, and 30 s more for a slow week block, before it is set aside. Everyone later in `getAllUsers`' order waited that much longer. Now the batch puts the users the switch doesn't cover first, in their own order. With the switch `OFF` (or `ALL`) the order is the batch's own.
- **A rollback during the wait.** If an admin turns the switch back between the first attempt and the retry, the retry used to go through the provider with the first attempt's `opts.day`, which the provider ignores, and the shaping didn't. Past midnight that read one day and shaped another. Now the retry asks the switch first; a user it no longer covers gets today's path, as everyone the switch doesn't cover does.
- **The set-aside users in Sentry.** A deploy (Railway's SIGTERM) during the 30 s wait or the retries dropped every set-aside user, with no summary and no dedup mark, and the next hourly run skips them. That is still so, but no longer silent: the batch sends one `summary-google-retry` warning with the count before it waits. It also logs one closing line with its total time.
- **The daily run's housekeeping.** `handleDailySummary` synced the reminder cache, set the reminders switch and (at 04:00 UTC) cleaned up OAuth states only after `sendDailySummaryToAll` returned, which now includes the wait and the retries. So whenever a covered user hit a Google failure, everyone's event-reminder settings reached the alert pass later. Now the housekeeping runs beside the batch.

**Visible to users:** only users the switch covers (admins, once it is `ADMINS`), and only during a Google outage at send time: their summary arrives about 30 s later, or, if Google is still down, without their Google events and with the outage line. Users the switch doesn't cover get today's output byte for byte (A-33): their wrappers ignore `read`, and their providers never throw `GOOGLE_FETCH_FAILED`. Under `ADMINS` they are also delivered before the admins in the batch, so never later than today, and the daily run's reminder-cache sync no longer waits for the batch.

**Findings (read before you start):**
- **Depends on** (all three land before this task):
  - C1, `src/services/calendar-read/digest.ts`: `SCHEDULED_READ` (`{ mode: 'scheduled', deadlineMs: 30000 }`) and `SCHEDULED_RETRY_READ` (`{ mode: 'scheduled', deadlineMs: 15000 }`); `readDigestDay` throws `Object.assign(new Error('GOOGLE_FETCH_FAILED'), { day })` with the read's first day, and a `scheduled` read never retries inside the adapter.
  - C2: `SummaryUserContext.googleUnavailable` adds one guideline line to the summary prompt; `bot.errors.googleOutageNote` in `messages/{en,he,ru}.json`.
  - C3: `prepareSummaryForUser(user, fetchFunction, summaryDate, modelId?, onTextDelta?, onStageChange?, opts?: { day?: DayKey; read?: DigestRead; googleUnavailable?: boolean })`; the switch-aware fetch wrappers; with `googleUnavailable` a Google user's day is `[]` with no read, the week block makes no Google read, and the outage line is appended to the summary text (the text that is delivered and voiced).
- **Where `GOOGLE_FETCH_FAILED` comes from:** only C1's adapters, called by C3's wrappers for switch-covered users. The tomorrow summary's week block can't raise it here: `prepareSummaryForUser` catches every week-block error and goes on without the block (`summary.ts:158-161` at 716a4f8, A-28). Nothing on the legacy path throws that message (`grep -rn GOOGLE_FETCH_FAILED src` is empty at 716a4f8), so the catch needs no switch check of its own.
- **Anchors that survive C3.** The five edits in `summary.ts` quote text C3 doesn't touch: the `subscription-service` import line, the `SummaryBatchResult` doc line, the first two lines of `sendSummaryToAll`'s body, the loop's first two lines and the loop's `try`/`catch`. Each was checked to match exactly once at 716a4f8, in the file with the C3 stand-in applied (below), and after C3 as committed. No edit touches the `fetchFunction` parameter type of `sendSummaryToAll` (`:350`), which C3 may change.
  - The new code names no `DayKey` or `DigestRead`. It derives the run options' type from `prepareSummaryForUser` itself: `type SummaryRunOptions = NonNullable<Parameters<typeof prepareSummaryForUser>[6]>`. C3 already imports those two names into `summary.ts`, and a second import of the same name is a duplicate-identifier error. Its import from `'../calendar-read/digest'` stays separate from C3's: different names from one module are fine, and lint accepts it.
- **The moves.** The loop's `try` body (prepare, deliver, log, count, mark) becomes the closure `deliverToUser`, which takes the run options. The loop's `catch` body becomes the closure `reportFailure`, word for word, indented two spaces less. The first attempt, the retry and the outage run all go through `deliverToUser`, so the order (deliver, log, `processed++`, dedup mark) and the dedup rule are the same for all three. Every failure that isn't set aside goes through `reportFailure`.
- **The wait.** One wait for the whole batch, not one per user. `firstGoogleFailureAt` is taken when the first failure is caught, after its read returned. The wait is `firstGoogleFailureAt + 30 000 − now`, skipped when it is not positive (a slow batch retries at once). The sleep is a module-level function that `__setScheduledRetrySleepForTests` replaces, after the precedent of `__resetDueGateForTests` (`src/services/native-reminders/due-gate.ts:52`). The batch never waits when nothing failed.
- **Sentry.** A set-aside first attempt only logs a `console.warn`. The reader already records each failing calendar, and a timeout, as a `calendar-read-google` warning (`src/services/calendar-read/google.ts:290-315`). The batch sends one `summary-google-retry` warning before it waits, with `{ set_aside, summary_type }` (counts and a stage, no names), so users a stopped process drops are counted. The outage run adds one `summary-google-outage` warning for the user, so an outage summary is never silent in Sentry either. `reportFailure` is unchanged: `summary-batch-user` at level error.
- **The day.** The retry and the outage run pass the first attempt's `day`, so a retry that crosses local midnight still reads and shapes that day (A-7).
- **The dedup mark's date.** `filterUsersForSummary` checks the key for the local date when the batch runs (`summary-scheduling.ts:60-61`); `markSummarySent` wrote it for the local date when the mark was written (`:89`). The two differ only past midnight, and only the retry phase gets there in practice. So `markSummarySent` takes an optional `sentFor` (default now), and the retry phase passes `batchStartedAt`, taken before the batch filters its users. First attempts, the weather-only path and every user the switch doesn't cover pass nothing, so their marks are as today. A batch-date mark can't send twice: the next hourly run is past the user's hour.
- **The order.** The batch asks `isCalendarHomeOn` once per eligible user, one after another (the first call fills the 30 s memo, the rest read it; C3's 5 s fallback covers a store outage), then runs the uncovered users, then the covered ones, each group in `getAllUsers`' order.
- **A rollback during the wait.** `retryOnce` asks the switch again. A user it no longer covers gets `deliverToUser(user, platform, { read: SCHEDULED_READ }, batchStartedAt)`: no `day`, so today's rule and the provider's own day agree. The legacy read never throws `GOOGLE_FETCH_FAILED`, so there is no outage run for that user.
- **Timing.** `handleDailySummary` synced the reminder cache after `sendDailySummaryToAll` returned (`src/cron/handlers.ts:21-24`); during an outage that was 30 s later, plus up to 15 s per retry. It now starts the housekeeping (`syncRemindersAndCleanUp`, the old two blocks, moved as they are) before the batch and awaits both. Each block catches its own failure, so the housekeeping never rejects; the handler's answer is unchanged. `POST /api/daily-summary` and `/api/tomorrow-summary` still answer after the retries. The daily and tomorrow jobs are separate `cron.schedule` callbacks (`src/cron/scheduler.ts:41-65`), so one batch's wait never delays the other.
- **WhatsApp** (secondary): a scheduled WhatsApp delivery is a template with a button, unchanged. The outage line rides on the summary text that Telegram gets. A WhatsApp tap runs the on-demand path (C3's R13 handling).
- **The smoke** stubs B's `readRange` (`src/services/calendar-read/index.ts`), so the real C1 adapter, C3 wrappers, B1 switch (a fake Redis answers `chome:rollout` with `ADMINS`), `claude.ts` prompt builder, bot messages and `summary-scheduling` run.
  - It checks C2's guideline as a one-line difference between two prompts for the same user at the same clock: the outage run's, and the empty day's after a retry that succeeds with nothing. So the check doesn't depend on C2's wording.
  - It reads the outage line from `messages/{en,he}.json`, and finds it in the delivered text and in the voice text.
  - The clock is a fake `Date`. Each fake read takes 2 s, and the fake sleep moves the clock by what it was asked.
  - The 23:00 check runs the real `filterUsersForSummary` at 23:00 the next evening against the marks the batch wrote. The rollback check turns the fake Redis's `chome:rollout` to `OFF` inside the fake sleep; the 30 s wait outlasts the switch's memo, so the retry reads it.
  - The housekeeping check runs the real `handleDailySummary` (`src/cron/handlers.ts`), with `services/telegram/index.ts` stubbed to hand it the real `sendDailySummaryToAll`, the reminder cache and `prisma.user` / `prisma.oAuthState` faked. Its fake sleep waits, in real time and for at most 2 s, until the housekeeping is done, so a handler that ran it after the batch fails the check instead of hanging.
- **Verified** first on the scratch base (header, Planning Ruling 2) plus the stand-ins below, then with the real C1–C3, and again on 716a4f8:
  - Before this task: the new smoke exits 1 with `TypeError: summary.__setScheduledRetrySleepForTests is not a function`, under each clock. With the retry removed but users still set aside (the "no retry" mutation below), 4/16 checks pass.
  - After: 16/16 under `TZ=UTC`, `TZ=Asia/Jerusalem` and `TZ=Pacific/Kiritimati`. `tsc` and lint are clean.
  - **Review patch, on the real C1-C3:** the new smoke has 20 checks. Against the pre-review C4 code it prints 11/20: the batch and wait checks (order, count warning), the reports, the closing line, the midnight and scopes runs (the count warning), the 23:00 mark (`mark Lior tomorrow 2026-10-17`, and the next evening is skipped), the rollback (the provider got the first attempt's day as an ignored argument) and the housekeeping (synced after the retries) fail. After: 20/20 under all three clocks. `smoke-auth-identity` (26), `smoke-native-reminders` (45), `smoke-reminders` (23), `smoke-summary-seam` (23) and `smoke-calendar-home-rollout` (35) printed the same lines before and after, as did the three smokes above.
  - The three smokes that load the real `summary.ts` (`smoke-google-connect` 30/30, `smoke-native-reminder-digest` 33/33, `smoke-partner-labels` 19/19) printed the same lines before and after. So did the 19 other smokes that touch the Telegram modules (44 runs over two clocks, among them `smoke-native-provider-reminders` 11/11, `smoke-reminders` 23/23 and `smoke-week-lookahead` 35/35).
  - Replayed on 716a4f8 with C1–C3 as committed, every step as written: before, Step 2's `TypeError` under each of its clocks; after, 20/20 under all three; the regression smokes of Step 2 printed the same lines before and after; `tsc` and lint clean; the tree this task's commit makes.
  - Mutations caught (first pass, on the scratch base): no retry; the retry without the day; the retry on the 30 s deadline; a 30 s wait counted from the end of the loop; the wait counted from the last failure; no outage run; an outage run for any error; the outage run without the flag; first attempts without `SCHEDULED_READ`; set-aside attempts reported as errors; retrying inside the loop; waiting when 30 s have already passed; no outage warning; the retry's mark without the batch's date; no ordering; no switch check on the retry; no count warning; the housekeeping after the batch.

**Verified against stand-ins** (in the scratch copy only, not part of this task): C1, C2 and C3 did not exist on the scratch base (nor at 716a4f8). Minimal stand-ins with the split's names and signatures were added in one commit before this task:
- C1: `src/services/calendar-read/digest.ts` with `DigestRead`, `DEFAULT_ON_DEMAND_READ`, `SCHEDULED_READ`, `SCHEDULED_RETRY_READ`, `readDigestDay` and `readLookaheadEvents` (`readRange`, then `throwForDigest` per the spec table: `GOOGLE_FETCH_FAILED` with `day`; an empty token → `[]`). It had no on-demand quick retry, which a scheduled read never uses.
- C2: `googleUnavailable` on `SummaryUserContext` and `SummaryPromptData`, one guideline line in `src/prompts/calendar-summary/{en,he,ru}.ts` after the reminders guideline, and `bot.errors.googleUnreachable` / `bot.errors.googleOutageNote` with placeholder text in `messages/{en,he,ru}.json`.
- C3: wrappers `(user, ids, tz, day, read)` that call `readDigestDay` when `isCalendarHomeOn(user)`, else the provider. `prepareSummaryForUser` with the 7th `opts` parameter: `day = opts.day ?? today's rule`; no fetch and no week block for a Google user under `googleUnavailable`; `userContext.googleUnavailable`; the outage line appended as `\n\n<i>…</i>` after the AI text. `sendSummaryToUser` passes `{ read: DEFAULT_ON_DEMAND_READ }`.

The smoke relies only on what the split fixes: the names, the `day` on the error, no Google read on the outage run, and the outage line appended to the summary text (it checks `startsWith` and `includes`, not the markup). When the real C1–C3 land, re-run Step 4. A mismatch there means one of those three tasks differs from the split.

**Files:**
- Modify: `src/services/telegram/summary.ts`, five spots (line numbers at 716a4f8; C3 shifts them, so match on the quoted text):
  - `:28-29`: the import of `SCHEDULED_READ` and `SCHEDULED_RETRY_READ`, and `captureWarning`;
  - `:338-339`: the run options type, `isGoogleFetchFailed`, the 30 s constant, the sleep and its test hook, before `SummaryBatchResult`;
  - `:354-355`: `batchStartedAt`, at the top of `sendSummaryToAll`;
  - `:389-390`: the order, the retry queue and the `deliverToUser`, `reportFailure` and `retryOnce` closures, before the loop, which now runs over `ordered`;
  - `:440-507`: the loop's `try`/`catch` (set aside or report), the count warning, the retry after the loop and the closing line.
- Modify: `src/lib/summary-scheduling.ts:80-89`: `markSummarySent`'s optional `sentFor`.
- Modify: `src/cron/handlers.ts:19-106`: `handleDailySummary` runs `syncRemindersAndCleanUp` beside the batch.
- Create (test): `scripts/smoke-summary-retry.ts`
- Test: `scripts/smoke-summary-retry.ts`
- Regression (unchanged): `scripts/smoke-google-connect.ts`, `scripts/smoke-native-reminder-digest.ts`, `scripts/smoke-partner-labels.ts` (the smokes that load the real `summary.ts`), `scripts/smoke-auth-identity.ts`, `scripts/smoke-native-reminders.ts`, `scripts/smoke-reminders.ts` (the cron handlers), `scripts/smoke-summary-seam.ts`, `scripts/smoke-calendar-home-rollout.ts`

**Interfaces:**
- Consumes:
  - C1 (`src/services/calendar-read/digest.ts`): `export const SCHEDULED_READ: DigestRead`, `export const SCHEDULED_RETRY_READ: DigestRead`; the thrown `Error & { day: DayKey }` with message `'GOOGLE_FETCH_FAILED'`.
  - C3 (`src/services/telegram/summary.ts`): `prepareSummaryForUser(user: UserConfig, fetchFunction, summaryDate: Date | undefined, modelId?: string, onTextDelta?, onStageChange?, opts?: { day?: DayKey; read?: DigestRead; googleUnavailable?: boolean }): Promise<PreparedSummary>`.
  - C2 (smoke only): `bot.errors.googleOutageNote` in `messages/en.json` and `messages/he.json`.
  - B (smoke only): `readRange(user: UserConfig, fromKey: DayKey, toKey: DayKey, opts: ReadRangeOptions): Promise<RangeRead>` and the types `RangeRead`, `ReadItem`, `ReadRangeOptions` (`src/services/calendar-read/{index,types}.ts`); `isCalendarHomeOn` runs for real over the faked Redis key `chome:rollout`.
  - Unchanged: `deliverSummary`, `filterUsersForSummary`, `handleTomorrowSummary`.
  - B1: `isCalendarHomeOn` (already imported into `summary.ts` by C3), asked for the order and before each retry.
- Produces:
  - `export function __setScheduledRetrySleepForTests(sleep: ((ms: number) => Promise<void>) | null): void` (`summary.ts`), for smoke scripts only; `null` puts the real `setTimeout` sleep back.
  - Nothing else is exported, and no signature changes. `sendDailySummaryToAll(options?: { filterByHour?: boolean }): Promise<SummaryBatchResult>` and `sendTomorrowSummaryToAll` keep theirs. `processed` also counts summaries delivered on the retry or the outage run.
  - The Sentry context `summary-google-outage` (warning), once per outage summary, and `summary-google-retry` (warning), once per batch that sets users aside, with `{ set_aside, summary_type }`.
  - `export async function markSummarySent(userId: number, summaryType: SummaryType, timezone: string, sentFor: Date = new Date()): Promise<void>` (`src/lib/summary-scheduling.ts`); every existing caller passes three arguments, unchanged.
  - `handleDailySummary(): Promise<CronResult>` keeps its signature and answer; the private `syncRemindersAndCleanUp(): Promise<void>` holds its housekeeping.

- [ ] **Step 1: Write the failing smoke `scripts/smoke-summary-retry.ts`**

Create the file with exactly this content:

```ts
// Smoke test for the scheduled summaries' Google retry (calendar home spec §3.1 step 6,
// deliberate change C5): sendSummaryToAll in src/services/telegram/summary.ts, run through
// sendDailySummaryToAll and sendTomorrowSummaryToAll.
//
// For a user the rollout switch covers, a summary whose Google read fails
// (GOOGLE_FETCH_FAILED from the digest adapter) is set aside and the batch moves on. After
// the loop the run waits until 30 s have passed since the first such failure, then retries
// each set-aside user once, in order, on the first attempt's day with a 15 s deadline. Only
// a second outage sends the summary without Google: the prompt gets the outage guideline,
// the text and the voice note get the outage line, and the dedup mark is set. Any other
// error on the retry goes the way it always went: a dead token gets the token text with
// the refresh button and no dedup mark (A-24), missing scopes are Sentry only (A-25).
// Users the switch doesn't cover read through their provider and are never retried (A-33);
// they go first, so none of them waits on a covered user's Google read.
//
// Also: Sentry hears once per batch how many users were set aside (a deploy during the
// wait would drop them); the retry's dedup marks carry the batch's date, so a 23:00
// tomorrow summary retried past midnight doesn't skip the next evening's; a switch turned
// back during the wait sends today's summary; the daily run's reminder-cache sync runs
// beside the batch, not after its retries; the batch logs its total time.
//
// The real summary.ts, digest adapter, rollout switch, claude.ts prompt builder, bot
// messages, summary scheduling and the cron's daily handler run. Faked: the reader's
// readRange, the clock and the retry's sleep, Redis (in memory), the database, the users,
// the AI, Telegram, the voice note, the quota, the reminder cache, error capture and the
// admin notifier. No network, no DB.
//
// Run under both clocks; the output must not depend on the server's timezone:
//   TZ=UTC npx tsx scripts/smoke-summary-retry.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-summary-retry.ts

import Module from 'node:module';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { fromZonedTime } from 'date-fns-tz';
import type { CalendarAssignment, CalendarEvent, UserConfig } from '../src/types';
import type { RangeRead, ReadItem, ReadRangeOptions } from '../src/services/calendar-read/types';
import type { AICompletionResult } from '../src/services/ai-provider';
import enMessages from '../messages/en.json';
import heMessages from '../messages/he.json';

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

function assertList(got: readonly string[], want: readonly string[], what: string) {
  assert(JSON.stringify(got) === JSON.stringify(want), `${what}\n     got  ${JSON.stringify(got, null, 1)}\n     want ${JSON.stringify(want, null, 1)}`);
}

process.env.NEXT_PUBLIC_APP_URL = 'https://famcal.test';
/** Any request that slips past the fakes is refused and counted. */
const networkAttempts: string[] = [];
globalThis.fetch = (async (input: unknown) => {
  networkAttempts.push(String(input));
  throw new Error(`network is blocked in this smoke test: ${String(input)}`);
}) as typeof fetch;

// ---- Clock: every argument-less new Date() and Date.now() reads `clock` ----

const IL = 'Asia/Jerusalem';
/** Wall-clock time in Israel, as epoch ms. */
const il = (local: string) => fromZonedTime(local, IL).getTime();

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

/** How long each calendar read and each provider fetch takes on the smoke's clock. */
let readMs = 2_000;

// ---- What happened, in order: reads, sends, waits, dedup marks, admin notices ----

let log: string[] = [];
let sleeps: number[] = [];
type Sent = { name: string; text: string; button?: string };
let sent: Sent[] = [];
let voices: { name: string; text: string }[] = [];
let prompts: { name: string; prompt: string }[] = [];
let captured: { context: string; severity: string; message: string }[] = [];
let tokensCleared: number[] = [];
/** The batch's own "[Batch Summary] … done:" log lines. */
let batchLines: string[] = [];
/** What the next retry wait does besides moving the clock: turn the switch, wait for the housekeeping. */
let onSleep: () => void | Promise<void> = () => {};

// ---- Users: every switch-covered one is an admin, as under ADMINS ----

const cal = (calendarId: string, name: string): CalendarAssignment => ({ calendarId, labels: ['yours'], name, color: '#039BE5' });

function person(id: number, name: string, over: Record<string, unknown>): UserConfig {
  return {
    id, telegramId: 1000 + id, name, englishName: name, gender: 'female', language: 'en', culture: 'default',
    location: '', weatherEnabled: false, textSummaryEnabled: true, voiceSummaryEnabled: true, messagingPlatform: 'telegram',
    isAdmin: true, suspendedAt: null, unreachableSince: null, globalRules: [], includeLookaheadInTomorrow: false,
    preferredMorningHour: 7, preferredEveningHour: 19, dailySummaryDays: [0, 1, 2, 3, 4, 5, 6], tomorrowSummaryDays: [0, 1, 2, 3, 4, 5, 6],
    ...over,
  } as unknown as UserConfig;
}
const google = (id: number, name: string, over: Record<string, unknown> = {}) =>
  person(id, name, { calendarSource: 'GOOGLE', googleRefreshToken: 'refresh-token', calendarAssignments: [cal(`${name.toLowerCase()}@gmail.com`, name)], ...over });

const NOA = google(11, 'Noa');
const YAEL = google(12, 'Yael', { language: 'he' });
const DANA = person(13, 'Dana', { calendarSource: 'NATIVE', googleRefreshToken: '' });
const OMER = google(14, 'Omer');
/** Not an admin: the switch (ADMINS) doesn't cover him, so he reads through the provider. */
const ITAI = google(15, 'Itai', { isAdmin: false });
/** Her tomorrow summary comes at 23:00. */
const LIOR = google(16, 'Lior', { preferredEveningHour: 23 });
const EVERYONE = [NOA, YAEL, DANA, OMER, ITAI, LIOR];
const nameOf = (chatId: unknown) => EVERYONE.find(u => u.telegramId === Number(chatId))?.name ?? `chat ${String(chatId)}`;

let batch: UserConfig[] = [];

// ---- The reader: each user's planned outcomes, one per readRange call ----

type Outcome = 'ok' | 'empty' | 'fail' | 'token' | 'scopes';
let plans = new Map<number, Outcome[]>();

function item(user: UserConfig, event: CalendarEvent): ReadItem {
  const source = user.calendarSource === 'NATIVE' ? 'famcal' : 'google';
  return {
    source, key: `${source}|${event.summary}`, event: { ...event, provider: source === 'famcal' ? 'native' : 'google' },
    calendar: { id: event.calendarId, source, name: event.calendarName, color: null, mine: true, inLegend: true },
    title: event.summary, kind: 'event', seriesId: null, originalStart: null, recurring: false, rrule: null,
  };
}

/** One event at 10:00-11:00 on `day`, on the user's own calendar. */
function dentist(user: UserConfig, day: string): CalendarEvent {
  const calendarId = user.calendarSource === 'NATIVE' ? 'native:cal-dana' : user.calendarAssignments![0].calendarId;
  return {
    summary: `Dentist (${user.name})`, start: new RealDate(il(`${day} 10:00:00`)).toISOString(), end: new RealDate(il(`${day} 11:00:00`)).toISOString(),
    calendarId, calendarName: user.name,
  };
}

async function readRange(user: UserConfig, fromKey: string, toKey: string, opts: ReadRangeOptions): Promise<RangeRead> {
  log.push(`read ${user.name} ${fromKey}..${toKey} ${opts.deadlineMs}`);
  clock += readMs;
  const outcome = plans.get(user.id)?.shift();
  if (!outcome) throw new Error(`unplanned read for ${user.name}`);
  const window = { from: new RealDate(il(`${fromKey} 00:00:00`)), to: new RealDate(il(`${toKey} 00:00:00`)) };
  const items = outcome === 'ok' ? [item(user, dentist(user, fromKey))] : [];
  if (user.calendarSource === 'NATIVE') {
    return { window, items, famcal: { status: 'ok', ctx: { viewerId: user.id, partner: null }, calendars: [], partner: null } };
  }
  const read: RangeRead['google'] =
    outcome === 'fail' ? { status: 'error', reason: 'transient', cause: new Error('rateLimitExceeded') }
    : outcome === 'token' ? { status: 'reconnect', reason: 'token' }
    : outcome === 'scopes' ? { status: 'reconnect', reason: 'scopes' }
    : { status: 'ok', calendars: [], goneIds: [], partial: null, stale: false };
  return { window, items, google: read };
}

/** The switch as the fake Redis holds it: ADMINS unless a check turns it. */
const rolloutNow = () => store.get('chome:rollout') ?? 'ADMINS';

/** The provider that users the switch doesn't cover read through. */
let providerFailure: Error | null = null;
const legacyFetch = (kind: string) => async (user: UserConfig, _ids: string[], tz?: string) => {
  log.push(`provider ${user.name} ${kind}`);
  clock += readMs;
  if (user.isAdmin && rolloutNow() !== 'OFF') throw new Error(`a switch-covered user (${user.name}) read through the provider`);
  if (providerFailure) throw providerFailure;
  return [dentist(user, new RealDate(clock).toLocaleDateString('en-CA', { timeZone: tz ?? IL }))];
};

// ---- Redis, in memory: the dedup marks and the rollout switch ----

const store = new Map<string, string>();
const fakeRedis = {
  get: async (key: string) => store.get(key) ?? (key === 'chome:rollout' ? 'ADMINS' : null),
  set: async (key: string, value: unknown) => {
    if (key.startsWith('summary:dedup:')) {
      const [, , type, userId, date] = key.split(':');
      log.push(`mark ${nameOf(1000 + Number(userId))} ${type} ${date}`);
    }
    store.set(key, String(value));
    return 'OK';
  },
  del: async (key: string) => (store.delete(key) ? 1 : 0),
};

// ---- Telegram and the voice note ----

let nextMessageId = 1;
const telegram = {
  sendMessage: async (chatId: number | string, text: string, options?: { replyMarkup?: { inline_keyboard?: { web_app?: { url: string } }[][] } }) => {
    const button = options?.replyMarkup?.inline_keyboard?.[0]?.[0]?.web_app?.url;
    const kind = button?.includes('/refresh-token') ? 'token' : 'summary';
    log.push(`send ${nameOf(chatId)} ${kind}`);
    sent.push({ name: nameOf(chatId), text, ...(button ? { button } : {}) });
    return nextMessageId++;
  },
  updateMessage: async () => {},
  deleteMessage: async () => {},
};

/** The AI: records each prompt under the user it names, and answers with that name. */
async function generateAICompletion(prompt: string): Promise<AICompletionResult> {
  const named = EVERYONE.filter(u => prompt.includes(u.name));
  const name = named.length === 1 ? named[0].name : `?${named.map(u => u.name).join('/')}`;
  prompts.push({ name, prompt });
  return { text: `Summary for ${name}`, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end_turn', model: 'fake-model', durationMs: 0 };
}

// ---- Stubs: static imports go through Module._load, import() through the ES module hooks ----

type SummaryModule = typeof import('../src/services/telegram/summary');
let loadedSummary: SummaryModule | undefined;
const summaryModule = (): SummaryModule => {
  if (!loadedSummary) throw new Error('summary.ts is not loaded yet');
  return loadedSummary;
};

const SRC = path.resolve(__dirname, '../src');
const stubs: Record<string, object> = {
  [`${SRC}/services/calendar-read/index.ts`]: {
    readRange,
    sourcesFor: (u: UserConfig) => (u.calendarSource === 'NATIVE' ? ['famcal'] : ['google']),
  },
  [`${SRC}/services/calendar-provider/index.ts`]: {
    getProviderForUser: () => ({ fetchTodayEvents: legacyFetch('today'), fetchTomorrowEvents: legacyFetch('tomorrow') }),
    getCalendarAssignmentsForUser: async (u: UserConfig) =>
      u.calendarSource === 'NATIVE' ? [cal('native:cal-dana', 'Dana')] : (u.calendarAssignments ?? []),
  },
  [`${SRC}/services/user-service.ts`]: {
    getAllUsers: async () => batch,
    getUserByIdentifier: async () => null,
    getWhatsAppChatId: (u: UserConfig) => u.whatsappPhone || u.whatsappBsuid || null,
    clearGoogleRefreshToken: async (telegramId: bigint) => {
      tokensCleared.push(Number(telegramId));
    },
  },
  [`${SRC}/services/native-reminders/open-reminders.ts`]: {
    addDigestReminders: async (_user: UserConfig, events: CalendarEvent[]) => ({ events, moreCount: 0 }),
  },
  [`${SRC}/services/ai-provider.ts`]: {
    generateAICompletion,
    streamAICompletion: async () => {
      throw new Error('a scheduled summary never streams');
    },
  },
  [`${SRC}/services/telegram/bot.ts`]: { getMessagingService: () => telegram },
  [`${SRC}/services/messaging/index.ts`]: {
    MessagingPlatform: { TELEGRAM: 'telegram', WHATSAPP: 'whatsapp' },
    MessageFormat: { HTML: 'html', MARKDOWN: 'markdown', PLAIN: 'plain' },
    getMessagingService: () => {
      throw new Error('no WhatsApp user in this smoke');
    },
  },
  [`${SRC}/services/telegram/voice.ts`]: {
    sendVoiceMessage: async (chatId: number | string, text: string) => {
      voices.push({ name: nameOf(chatId), text });
    },
    sendWeeklyVoiceMessage: async () => {},
  },
  [`${SRC}/services/telegram/commands.ts`]: { sendSetupNudgeIfNeeded: async () => false },
  [`${SRC}/services/analytics-service.ts`]: { trackActivityAsync: () => {}, addBreadcrumb: () => {} },
  [`${SRC}/services/subscription-service.ts`]: {
    checkFeatureAccess: async () => ({ allowed: true }),
    incrementUsage: async () => {},
  },
  [`${SRC}/lib/timezone.ts`]: { resolveUserTimezone: async () => IL },
  [`${SRC}/utils/redis.ts`]: { redis: fakeRedis },
  [`${SRC}/utils/prisma.ts`]: {
    prisma: {
      adminSettings: { findUnique: async () => ({ calendarHomeRollout: 'ADMINS' }) },
      // The daily handler's housekeeping: the reminder users, and the OAuth clean-up at 04:00 UTC.
      user: {
        findMany: async () => {
          log.push('housekeeping: reminder users');
          return [NOA, DANA].map(u => ({
            id: u.id, telegramId: BigInt(u.telegramId!), googleRefreshToken: u.googleRefreshToken, calendarAssignments: [],
            calendarSource: u.calendarSource, pairingId: null, defaultReminderMinutes: 15, pickupRemindersEnabled: true,
            language: u.language, name: u.name, location: '',
          }));
        },
      },
      oAuthState: {
        deleteMany: async () => {
          log.push('housekeeping: OAuth clean-up');
          return { count: 0 };
        },
      },
    },
  },
  [`${SRC}/services/reminder-cache.ts`]: {
    syncReminderCache: async (users: unknown[]) => {
      log.push(`housekeeping: ${users.length} reminder users synced`);
    },
    setGlobalRemindersEnabled: async () => {
      log.push('housekeeping: reminders switch set');
    },
  },
  [`${SRC}/utils/encryption.ts`]: { safeDecrypt: (value: string) => value },
  // The daily handler imports the senders through the package index; it gets summary.ts's own.
  [`${SRC}/services/telegram/index.ts`]: {
    sendDailySummaryToAll: (options?: { filterByHour?: boolean }) => summaryModule().sendDailySummaryToAll(options),
  },
  [`${SRC}/lib/error-capture.ts`]: {
    captureError: (error: unknown, context: string, _extra?: unknown, severity = 'error') => {
      captured.push({ context, severity, message: error instanceof Error ? error.message : String(error) });
    },
    captureWarning: (message: string, context: string) => {
      captured.push({ context, severity: 'warning', message });
      if (context.startsWith('summary-')) log.push(`warn ${context} ${message}`);
    },
    captureInfo: () => {},
  },
  [`${SRC}/utils/error-notifier.ts`]: {
    notifyAdminWarning: async (title: string) => {
      log.push(`admin ${title}`);
    },
    notifyAdminError: async (title: string) => {
      log.push(`admin error ${title}`);
    },
  },
};

const ModuleInternals = Module as unknown as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  _resolveFilename: (request: string, parent: unknown, isMain: boolean) => string;
};
// @hebcal/core is ESM-only and tsx loads src/ as CommonJS (see smoke-week-lookahead.ts).
const resolveFilename = ModuleInternals._resolveFilename;
ModuleInternals._resolveFilename = function (request, parent, isMain) {
  if (request === '@hebcal/core') return path.resolve(__dirname, '../node_modules/@hebcal/core/dist/esm/index.js');
  return resolveFilename.call(this, request, parent, isMain);
};
const realLoad = ModuleInternals._load;
ModuleInternals._load = function (request, parent, isMain) {
  let resolved = request;
  try {
    resolved = ModuleInternals._resolveFilename(request, parent, isMain);
  } catch {}
  return stubs[resolved] ?? realLoad.call(this, request, parent, isMain);
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

// ---- One scheduled run ----

/** Friday 16 October 2026, 07:00 in Israel: every user's morning hour. */
const MORNING = il('2026-10-16 07:00:00');

function reset(users: UserConfig[], userPlans: [UserConfig, Outcome[]][], startAt = MORNING) {
  batch = users;
  plans = new Map(userPlans.map(([u, p]) => [u.id, [...p]]));
  clock = startAt;
  readMs = 2_000;
  providerFailure = null;
  log = [];
  sleeps = [];
  sent = [];
  voices = [];
  prompts = [];
  captured = [];
  tokensCleared = [];
  batchLines = [];
  onSleep = () => {};
  store.clear();
  // The switch's 30 s memo lives on globalThis; each run starts without it.
  delete (globalThis as Record<string, unknown>).__calendarHomeRolloutMemo;
}

const OUTAGE_EN = enMessages.bot.errors.googleOutageNote;
const OUTAGE_HE = heMessages.bot.errors.googleOutageNote;
const TOKEN_TEXT = `${enMessages.bot.tokenExpired.title}\n\n${enMessages.bot.tokenExpired.message}`;

const textOf = (name: string) => sent.filter(s => s.name === name).map(s => s.text);
const voiceOf = (name: string) => voices.filter(v => v.name === name).map(v => v.text);
const promptsOf = (name: string) => prompts.filter(p => p.name === name).map(p => p.prompt);
const readsOf = (name: string) => log.filter(l => l.startsWith(`read ${name} `));
/** What summary.ts itself reported to Sentry; the reader's own warnings are not checked here. */
const reported = () => captured.filter(c => c.context.startsWith('summary-')).map(c => `${c.context} ${c.severity} ${c.message}`);

/** Waits, in real time, until `done()` or 2 s have passed. */
async function until(done: () => boolean): Promise<void> {
  const started = performance.now();
  while (!done() && performance.now() - started < 2_000) await new Promise(resolve => setTimeout(resolve, 5));
}

async function main() {
  const summary = await import('../src/services/telegram/summary');
  loadedSummary = summary;
  const { filterUsersForSummary } = await import('../src/lib/summary-scheduling');
  const { handleDailySummary } = await import('../src/cron/handlers');
  summary.__setScheduledRetrySleepForTests(async (ms: number) => {
    await onSleep();
    log.push(`sleep ${ms}`);
    sleeps.push(ms);
    clock += ms;
  });
  // The batch's own closing line; everything else the code logs is left alone.
  const realLog = console.log;
  console.log = (...args: unknown[]) => {
    const line = args.map(String).join(' ');
    if (line.startsWith('[Batch Summary]') && line.includes(' done: ')) batchLines.push(line);
    else realLog(...args);
  };

  // ---- The batch: three Google users fail, a FamCal user and a legacy user don't ----

  reset([NOA, YAEL, DANA, OMER, ITAI], [[NOA, ['fail', 'ok']], [YAEL, ['fail', 'fail']], [DANA, ['ok']], [OMER, ['fail', 'token']]]);
  const batchResult = await summary.sendDailySummaryToAll({ filterByHour: true });
  const batchLog = batchLines;

  await check('the batch: the user the switch doesn\'t cover goes first, the FamCal user before the retries; one count to Sentry and one wait, then each set-aside user is retried once, in order', () => {
    assertList(log, [
      'provider Itai today',
      'send Itai summary',
      'mark Itai daily 2026-10-16',
      'read Noa 2026-10-16..2026-10-17 30000',
      'read Yael 2026-10-16..2026-10-17 30000',
      'read Dana 2026-10-16..2026-10-17 30000',
      'send Dana summary',
      'mark Dana daily 2026-10-16',
      'read Omer 2026-10-16..2026-10-17 30000',
      'warn summary-google-retry 3 scheduled summaries set aside for a Google retry',
      'sleep 24000',
      'read Noa 2026-10-16..2026-10-17 15000',
      'send Noa summary',
      'mark Noa daily 2026-10-16',
      'read Yael 2026-10-16..2026-10-17 15000',
      'send Yael summary',
      'mark Yael daily 2026-10-16',
      'read Omer 2026-10-16..2026-10-17 15000',
      'send Omer token',
      'admin Token Expired',
    ], 'the run');
  });

  await check('the wait ends 30 s after the first failure (Noa at 07:00:04), not 30 s after the loop', () => {
    assertList(sleeps.map(String), ['24000'], 'sleeps');
  });

  await check('retry ok: the normal summary, with the retry\'s events, and no outage line', () => {
    assertList(textOf('Noa').map(t => t.split('\n')[0]), ['Summary for Noa'], 'Noa\'s messages');
    assert(!textOf('Noa')[0].includes(OUTAGE_EN), 'the outage line is in a normal summary');
    assert(promptsOf('Noa').length === 1 && promptsOf('Noa')[0].includes('Dentist (Noa)'), 'the retry\'s event is not in the prompt');
    assert(voiceOf('Noa').length === 1 && !voiceOf('Noa')[0].includes(OUTAGE_EN), `voice ${JSON.stringify(voiceOf('Noa'))}`);
  });

  await check('retry fails again: the summary goes out without Google, with the outage line in the text and the voice note (Hebrew)', () => {
    assert(readsOf('Yael').length === 2, `Yael was read ${readsOf('Yael').length} times; the outage run must not read Google`);
    assert(textOf('Yael').length === 1 && textOf('Yael')[0].startsWith('Summary for Yael'), `Yael's messages ${JSON.stringify(textOf('Yael'))}`);
    assert(textOf('Yael')[0].includes(OUTAGE_HE), `no Hebrew outage line in ${JSON.stringify(textOf('Yael')[0])}`);
    assert(voiceOf('Yael').length === 1 && voiceOf('Yael')[0].includes(OUTAGE_HE), `voice ${JSON.stringify(voiceOf('Yael'))}`);
    assert(promptsOf('Yael').length === 1 && !promptsOf('Yael')[0].includes('Dentist'), 'the outage prompt lists Google events');
  });

  await check('retry finds a dead token: the token text with the refresh button and an admin notice, no outage run, no dedup mark (A-24)', () => {
    assertList(sent.filter(s => s.name === 'Omer').map(s => s.text), [TOKEN_TEXT], 'Omer\'s messages');
    assert(sent.find(s => s.name === 'Omer')?.button === 'https://famcal.test/refresh-token?user_id=1014', `button ${sent.find(s => s.name === 'Omer')?.button}`);
    assert(promptsOf('Omer').length === 0, 'Omer got a summary');
    assert(!log.some(l => l.startsWith('mark Omer')), 'Omer has a dedup mark');
  });

  await check('a set-aside first attempt reports no error; the batch counts them once; the outage run leaves one warning; the dead token is reported as before', () => {
    assertList(reported(), [
      'summary-google-retry warning 3 scheduled summaries set aside for a Google retry',
      'summary-google-outage warning GOOGLE_FETCH_FAILED',
      'summary-batch-user error GOOGLE_TOKEN_EXPIRED',
    ], 'captured');
  });

  await check('the batch logs one closing line: what it delivered, how many it set aside, and its total time', () => {
    assertList(batchLog, ['[Batch Summary] daily done: processed=4 set aside=3 total=40000ms'], 'the closing line');
  });

  await check('the result counts the four summaries delivered', () => {
    assert(batchResult.processed === 4, `processed ${batchResult.processed}`);
  });

  await check('the legacy user (switch off) reads through his provider, never the reader, and is never retried (A-33)', () => {
    assertList(log.filter(l => l.includes('Itai')), ['provider Itai today', 'send Itai summary', 'mark Itai daily 2026-10-16'], 'Itai');
  });

  // ---- The outage guideline: the same user and clock, retry ok with nothing vs a second outage ----

  reset([NOA], [[NOA, ['fail', 'empty']]]);
  await summary.sendDailySummaryToAll({ filterByHour: true });
  const emptyDay = promptsOf('Noa');
  const emptyText = textOf('Noa');
  reset([NOA], [[NOA, ['fail', 'fail']]]);
  await summary.sendDailySummaryToAll({ filterByHour: true });
  const outage = promptsOf('Noa');
  const outageText = textOf('Noa');
  const outageMarks = log.filter(l => l.startsWith('mark '));

  await check('the outage prompt is the empty-day prompt plus exactly one guideline line', () => {
    assert(emptyDay.length === 1 && outage.length === 1, `prompts ${emptyDay.length}, ${outage.length}`);
    const a = emptyDay[0].split('\n');
    const b = outage[0].split('\n');
    assert(b.length === a.length + 1, `lines ${a.length} -> ${b.length}`);
    const at = b.findIndex((line, i) => line !== a[i]);
    assert(at >= 0 && JSON.stringify([...b.slice(0, at), ...b.slice(at + 1)]) === JSON.stringify(a), 'more than one line differs');
    assert(b[at].startsWith('- '), `the added line is not a guideline: ${b[at]}`);
  });

  await check('the outage summary is the empty-day summary plus the outage line, and it is marked sent', () => {
    assert(emptyText.length === 1 && !emptyText[0].includes(OUTAGE_EN), `empty-day text ${JSON.stringify(emptyText)}`);
    assert(outageText.length === 1 && outageText[0].startsWith(emptyText[0]) && outageText[0].includes(OUTAGE_EN), `outage text ${JSON.stringify(outageText)}`);
    assertList(outageMarks, ['mark Noa daily 2026-10-16'], 'marks');
  });

  // ---- No failure, no wait ----

  reset([NOA, DANA], [[NOA, ['ok']], [DANA, ['ok']]]);
  await summary.sendDailySummaryToAll({ filterByHour: true });

  await check('a batch with no Google failure never waits and reads each user once, with the scheduled 30 s deadline', () => {
    assertList(log.filter(l => l.startsWith('read ') || l.startsWith('sleep')), [
      'read Noa 2026-10-16..2026-10-17 30000',
      'read Dana 2026-10-16..2026-10-17 30000',
    ], 'reads');
  });

  // ---- A slow batch: 30 s have already passed when the loop ends ----

  reset([NOA, DANA], [[NOA, ['fail', 'ok']], [DANA, ['ok']]]);
  readMs = 40_000;
  await summary.sendDailySummaryToAll({ filterByHour: true });

  await check('when 30 s have passed by the end of the loop, the retry runs at once', () => {
    assertList(log.filter(l => l.startsWith('read ') || l.startsWith('sleep') || l.startsWith('send ')), [
      'read Noa 2026-10-16..2026-10-17 30000',
      'read Dana 2026-10-16..2026-10-17 30000',
      'send Dana summary',
      'read Noa 2026-10-16..2026-10-17 15000',
      'send Noa summary',
    ], 'run');
  });

  // ---- The retry keeps the first attempt's day across local midnight (A-7) ----

  reset([NOA], [[NOA, ['fail', 'ok']]], il('2026-10-16 23:59:50'));
  await summary.sendTomorrowSummaryToAll();

  await check('a tomorrow summary retried after local midnight reads and shapes the first attempt\'s day', () => {
    assertList(log, [
      'read Noa 2026-10-17..2026-10-18 30000',
      'warn summary-google-retry 1 scheduled summaries set aside for a Google retry',
      'sleep 30000',
      'read Noa 2026-10-17..2026-10-18 15000',
      'send Noa summary',
    ], 'run');
    assert(promptsOf('Noa').length === 1 && promptsOf('Noa')[0].includes('Saturday, October 17, 2026'), 'the prompt is not for Saturday 17 October');
    assert(promptsOf('Noa')[0].includes('Dentist (Noa)'), 'the day\'s event is not in the prompt');
  });

  // ---- Missing scopes on the retry: Sentry only, as on any scheduled run (A-25) ----

  reset([NOA], [[NOA, ['fail', 'scopes']]]);
  await summary.sendDailySummaryToAll({ filterByHour: true });

  await check('retry finds missing scopes: no message, no token cleared, no dedup mark, no outage run, Sentry only (A-25)', () => {
    assertList(log, [
      'read Noa 2026-10-16..2026-10-17 30000',
      'warn summary-google-retry 1 scheduled summaries set aside for a Google retry',
      'sleep 30000',
      'read Noa 2026-10-16..2026-10-17 15000',
    ], 'run');
    assert(sent.length === 0 && prompts.length === 0 && tokensCleared.length === 0, `sent ${sent.length}, prompts ${prompts.length}, cleared ${tokensCleared.length}`);
    assertList(reported(), [
      'summary-google-retry warning 1 scheduled summaries set aside for a Google retry',
      'summary-batch-user error GOOGLE_INSUFFICIENT_SCOPES',
    ], 'captured');
  });

  // ---- A 23:00 tomorrow summary whose retry lands after midnight: marked for the batch's date ----

  reset([LIOR], [[LIOR, ['fail', 'ok']]], il('2026-10-16 23:59:20'));
  readMs = 15_000;
  await summary.sendTomorrowSummaryToAll({ filterByHour: true });
  const lateRun = [...log];
  clock = il('2026-10-17 23:00:00');
  const nextEvening = await filterUsersForSummary([LIOR], 'tomorrow');

  await check('a 23:00 tomorrow summary retried after midnight is marked for the batch\'s date, so the next evening\'s still goes out', () => {
    // The batch at 23:59:20, the first failure at 23:59:35, the retry at 00:00:05.
    assertList(lateRun, [
      'read Lior 2026-10-17..2026-10-18 30000',
      'warn summary-google-retry 1 scheduled summaries set aside for a Google retry',
      'sleep 30000',
      'read Lior 2026-10-17..2026-10-18 15000',
      'send Lior summary',
      'mark Lior tomorrow 2026-10-16',
    ], 'run');
    assert(store.has('summary:dedup:tomorrow:16:2026-10-16'), `marks ${JSON.stringify([...store.keys()])}`);
    assert(nextEvening.eligible.length === 1 && nextEvening.skippedDedup === 0, `at 23:00 on 17 October: ${JSON.stringify({ eligible: nextEvening.eligible.length, dedup: nextEvening.skippedDedup })}`);
  });

  // ---- The switch turned back during the wait: today's path ----

  reset([NOA], [[NOA, ['fail']]]);
  onSleep = () => {
    store.set('chome:rollout', 'OFF');
  };
  await summary.sendDailySummaryToAll({ filterByHour: true });

  await check('a switch turned back to OFF during the wait: the retry is today\'s summary through the provider, with no outage line, marked for the batch\'s date', () => {
    assertList(log, [
      'read Noa 2026-10-16..2026-10-17 30000',
      'warn summary-google-retry 1 scheduled summaries set aside for a Google retry',
      'sleep 30000',
      'provider Noa today',
      'send Noa summary',
      'mark Noa daily 2026-10-16',
    ], 'run');
    assert(textOf('Noa').length === 1 && !textOf('Noa')[0].includes(OUTAGE_EN), `Noa's messages ${JSON.stringify(textOf('Noa'))}`);
    assertList(reported(), ['summary-google-retry warning 1 scheduled summaries set aside for a Google retry'], 'captured');
  });

  // ---- The daily run's housekeeping runs beside the batch, not after its retries ----

  reset([NOA, DANA], [[NOA, ['fail', 'ok']], [DANA, ['ok']]]);
  onSleep = () => until(() => log.includes('housekeeping: OAuth clean-up'));
  const handled = await handleDailySummary();

  await check('the daily cron run syncs the reminder cache and cleans up OAuth states beside the batch: done before the retry wait ends', () => {
    const housekeeping = log.filter(l => l.startsWith('housekeeping: '));
    assertList(housekeeping, [
      'housekeeping: reminder users',
      'housekeeping: 2 reminder users synced',
      'housekeeping: reminders switch set',
      'housekeeping: OAuth clean-up',
    ], 'housekeeping');
    const sleptAt = log.indexOf('sleep 28000');
    assert(sleptAt > 0 && log.lastIndexOf('housekeeping: OAuth clean-up') < sleptAt, `the run ${JSON.stringify(log)}`);
    assertList(log.filter(l => !l.startsWith('housekeeping: ')), [
      'read Noa 2026-10-16..2026-10-17 30000',
      'read Dana 2026-10-16..2026-10-17 30000',
      'send Dana summary',
      'mark Dana daily 2026-10-16',
      'warn summary-google-retry 1 scheduled summaries set aside for a Google retry',
      'sleep 28000',
      'read Noa 2026-10-16..2026-10-17 15000',
      'send Noa summary',
      'mark Noa daily 2026-10-16',
    ], 'the summaries');
    assert(handled.success === true && handled.processed === 2, JSON.stringify(handled));
  });

  // ---- Users the switch doesn't cover: today's handling, never the retry (A-33) ----

  reset([ITAI, DANA], [[DANA, ['ok']]]);
  providerFailure = new Error('GOOGLE_TOKEN_EXPIRED');
  await summary.sendDailySummaryToAll({ filterByHour: true });

  await check('a legacy user\'s dead token gets today\'s token text and admin notice, with no wait and no retry', () => {
    assertList(log, [
      'provider Itai today',
      'send Itai token',
      'admin Token Expired',
      'read Dana 2026-10-16..2026-10-17 30000',
      'send Dana summary',
      'mark Dana daily 2026-10-16',
    ], 'run');
  });

  await check('nothing above reached the network or sent an admin error notice', () => {
    assert(networkAttempts.length === 0, `network: ${networkAttempts.join(', ')}`);
    assert(!log.some(l => l.startsWith('admin error')), 'an admin error notice was sent');
  });

  summary.__setScheduledRetrySleepForTests(null);
  console.log = realLog;

  let passed = 0;
  for (const r of results) {
    if (r.ok) passed++;
    console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.name}${r.ok ? '' : `\n     ${r.reason}`}`);
  }
  console.log(`\n${passed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Run it and see it fail; record the regression smokes' baseline**

```bash
cd /Users/razielgershoni/development/famcalbot
for tz in UTC Asia/Jerusalem; do TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-summary-retry.ts 2>&1 | grep -E 'TypeError|passed'; echo "smoke-summary-retry $tz exit=${pipestatus[1]}"; done
for f in smoke-google-connect smoke-native-reminder-digest smoke-partner-labels smoke-auth-identity smoke-native-reminders smoke-reminders smoke-summary-seam smoke-calendar-home-rollout; do for tz in UTC Asia/Jerusalem; do TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/$f.ts 2>&1 | grep -E '^(OK|FAIL)|passed' > /tmp/c4-$f-${tz//\//_}.before; echo "$f $tz exit=${pipestatus[1]} | $(tail -1 /tmp/c4-$f-${tz//\//_}.before)"; done; done
```
(Run it in zsh: `pipestatus` is zsh's; in bash it is `${PIPESTATUS[0]}`. Only the OK/FAIL lines and the count are kept: `smoke-native-reminder-digest` also prints a timing line that changes from run to run.)

Expected for the new smoke, under each clock:
```
TypeError: summary.__setScheduledRetrySleepForTests is not a function
smoke-summary-retry UTC exit=1
```
Why it fails: the smoke loads the real `summary.ts` and installs its fake sleep through the hook this task adds. Without it the smoke stops before any check runs. (If it stops earlier, with a module or export missing from `calendar-read/digest`, C1 hasn't landed; land C1–C3 first.)

Expected for the regression smokes: every run `exit=0`, with last lines `30/30 passed`, `33/33 passed (process TZ=…)`, `19/19 passed (process TZ=…)`, `26/26 passed`, `45/45 passed (…)`, `23/23 passed (…)`, `23/23 passed (…)` and `35/35 passed`. The `/tmp/c4-*.before` files are the baseline for Step 6.

- [ ] **Step 3: Add the retry to `sendSummaryToAll` in `src/services/telegram/summary.ts`**

Five edits, in file order. Each quoted Before appears exactly once, both at 716a4f8 and after C3. Line numbers are 716a4f8's; C3 shifts them, so match on the text.

Edit 3a, the imports (lines 28-29). Before:
```ts
import { checkFeatureAccess, incrementUsage } from '../subscription-service';
import { captureError } from '../../lib/error-capture';
```
After:
```ts
import { checkFeatureAccess, incrementUsage } from '../subscription-service';
import { SCHEDULED_READ, SCHEDULED_RETRY_READ } from '../calendar-read/digest';
import { captureError, captureWarning } from '../../lib/error-capture';
```

Edit 3b, the module-level pieces, before `SummaryBatchResult` (lines 338-339). Before:
```ts
/** Result counts from batch summary delivery */
export interface SummaryBatchResult {
```
After:
```ts
/** prepareSummaryForUser's last argument (spec §3.1): the summary day, the read, the outage flag. */
type SummaryRunOptions = NonNullable<Parameters<typeof prepareSummaryForUser>[6]>;

/** The digest adapters' outage error (spec §3.1): Google couldn't be read for `day`, the read's first day. */
function isGoogleFetchFailed(error: unknown): error is Error & { day?: SummaryRunOptions['day'] } {
  return error instanceof Error && error.message === 'GOOGLE_FETCH_FAILED';
}

/** C5: the scheduled retry runs this long after the batch's first Google failure. */
const SCHEDULED_RETRY_AFTER_MS = 30_000;

const realSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
let scheduledRetrySleep: (ms: number) => Promise<void> = realSleep;

/** Smoke scripts only: replaces the wait before the scheduled retry; null puts the real one back. */
export function __setScheduledRetrySleepForTests(sleep: ((ms: number) => Promise<void>) | null): void {
  scheduledRetrySleep = sleep ?? realSleep;
}

/** Result counts from batch summary delivery */
export interface SummaryBatchResult {
```

Edit 3c, the batch's start, at the top of `sendSummaryToAll` (lines 354-355). Before:
```ts
  const messagingService = getMessagingService();
  const result: SummaryBatchResult = { processed: 0, skippedHour: 0, skippedDay: 0, skippedDedup: 0 };
```
After:
```ts
  const messagingService = getMessagingService();
  const result: SummaryBatchResult = { processed: 0, skippedHour: 0, skippedDay: 0, skippedDedup: 0 };
  // When the batch chose its users. The scheduled retry's summaries are marked sent under
  // this local date, the date the batch chose them for, also when they go out past midnight.
  const batchStartedAt = new Date();
```

Edit 3d, the order, the retry queue and the three closures, before the loop (lines 389-390). `deliverToUser` is the loop's old `try` body and `reportFailure` its old `catch` body, word for word, indented two spaces less; `deliverToUser` also hands `markedFor` to `markSummarySent`. The loop now runs over `ordered`. Before:
```ts
    for (const user of users) {
      const platform = user.messagingPlatform || 'telegram';
```
After:
```ts
    // Users the calendar home doesn't cover go first, in their own order, then the users it
    // covers. A covered user's Google read can take up to 30 s for the day and 30 s more for
    // the week block before it is set aside (spec §2.2), and nobody the switch doesn't cover
    // should wait on that. With the switch OFF (or ALL) the order is the batch's own.
    const covered = new Set<UserConfig>();
    for (const user of users) {
      if (await isCalendarHomeOn(user)) covered.add(user);
    }
    const ordered = [...users.filter(u => !covered.has(u)), ...users.filter(u => covered.has(u))];

    // C5 (spec §3.1 step 6): a user whose Google read fails is set aside here and retried
    // after the loop, so the rest of the batch never waits on Google.
    const googleRetries: { user: UserConfig; platform: DeliveryPlatform; day: SummaryRunOptions['day'] }[] = [];
    let firstGoogleFailureAt = 0;

    // One user's summary, prepared and delivered, then counted and marked sent: the same
    // on the first attempt, the retry and the outage run. `markedFor` dates the dedup mark
    // (the retry passes the batch's start); unset, it is the time of the mark, as before.
    const deliverToUser = async (user: UserConfig, platform: DeliveryPlatform, runOptions: SummaryRunOptions, markedFor?: Date) => {
      const tUser = Date.now();
      const { summary, dateHeader, otherEvents } = await prepareSummaryForUser(
        user, fetchFunction, summaryDate, undefined, undefined, undefined, runOptions
      );

      // Use telegramId for TG delivery, whatsappPhone for WA, or user.id as fallback
      const deliveryUserId = user.telegramId ?? getWhatsAppChatId(user) ?? user.id;
      await deliverSummary({
        userId: deliveryUserId,
        summary,
        user,
        platform,
        dateHeader,
        waButtonPayload: summaryDate ? 'summary tmrw' : 'summary',
        otherEvents,
        summaryDate,
      });

      console.log(`[Batch Summary] user=${user.id} platform=${platform} total=${Date.now() - tUser}ms`);
      result.processed++;

      // Mark as sent for dedup
      if (options?.filterByHour) {
        const { markSummarySent } = await import('../../lib/summary-scheduling');
        const { resolveUserTimezone } = await import('../../lib/timezone');
        const tz = await resolveUserTimezone(user);
        await markSummarySent(user.id, summaryDate ? 'tomorrow' : 'daily', tz, markedFor);
      }
    };

    // A failed summary: logged, and a dead token gets the token text with the refresh
    // button. No dedup mark.
    const reportFailure = async (user: UserConfig, platform: DeliveryPlatform, error: unknown) => {
      console.error(`Failed to send summary to user ${user.id}:`, error);
      captureError(error, 'summary-batch-user', { user_id: user.id });

      if (error instanceof Error && error.message === 'GOOGLE_TOKEN_EXPIRED') {
        const t = await getBotMessages(user.language || 'en');
        const refreshUrl = buildUrl(`/refresh-token?user_id=${user.telegramId ?? user.id}`);
        const expiredMessage = `${t.tokenExpired.title}\n\n${t.tokenExpired.message}`;

        try {
          if ((platform === 'telegram' || platform === 'all') && user.telegramId) {
            await messagingService.sendMessage(user.telegramId, expiredMessage, {
              format: MessageFormat.HTML,
              replyMarkup: {
                inline_keyboard: [[
                  { text: t.buttons.refreshGoogle, web_app: { url: refreshUrl } }
                ]]
              }
            });
          }
          if ((platform === 'whatsapp' || platform === 'all') && getWhatsAppChatId(user)) {
            const waChatId = getWhatsAppChatId(user)!;
            const whatsappService = getMessagingServiceByPlatform(MessagingPlatform.WHATSAPP);
            const { buildWhatsAppTemplate } = await import('../messaging/whatsapp-template');
            const template = buildWhatsAppTemplate(user.language || 'en');
            await whatsappService.sendMessage(waChatId, '', { whatsappTemplate: template });
          }
        } catch (msgError) {
          console.error(`Failed to send token expired message to user ${user.id}:`, msgError);
          captureError(msgError, 'summary-token-expired-notify', { user_id: user.id }, 'warning');
        }

        const { notifyAdminWarning } = await import('../../utils/error-notifier');
        await notifyAdminWarning(
          'Token Expired',
          `User ${user.id} (${user.name}) needs to refresh their Google Calendar token`
        );
      }
    };

    // The one retry: on the first attempt's day, with the retry's deadline for the day
    // read and the week block. Only a second outage sends the summary without Google,
    // with the outage guideline and line; it counts as sent. Anything else it throws is
    // the caller's to report. Every summary it sends is marked for the batch's date.
    const retryOnce = async (user: UserConfig, platform: DeliveryPlatform, day: SummaryRunOptions['day']) => {
      // The switch turned back meanwhile (a rollback during the outage): today's path, as
      // for everyone the switch doesn't cover, so the read and the shaping agree on the day.
      if (!(await isCalendarHomeOn(user))) {
        await deliverToUser(user, platform, { read: SCHEDULED_READ }, batchStartedAt);
        return;
      }
      const retry: SummaryRunOptions = { day, read: SCHEDULED_RETRY_READ };
      try {
        await deliverToUser(user, platform, retry, batchStartedAt);
      } catch (error) {
        if (!isGoogleFetchFailed(error)) throw error;
        captureError(error, 'summary-google-outage', { user_id: user.id }, 'warning');
        await deliverToUser(user, platform, { ...retry, googleUnavailable: true }, batchStartedAt);
      }
    };

    for (const user of ordered) {
      const platform = user.messagingPlatform || 'telegram';
```

Edit 3e, the loop's `try`/`catch`, the count warning, the retry after the loop and the closing line (lines 440-507). Before:
```ts
      try {
        const tUser = Date.now();
        const { summary, dateHeader, otherEvents } = await prepareSummaryForUser(user, fetchFunction, summaryDate);

        // Use telegramId for TG delivery, whatsappPhone for WA, or user.id as fallback
        const deliveryUserId = user.telegramId ?? getWhatsAppChatId(user) ?? user.id;
        await deliverSummary({
          userId: deliveryUserId,
          summary,
          user,
          platform,
          dateHeader,
          waButtonPayload: summaryDate ? 'summary tmrw' : 'summary',
          otherEvents,
          summaryDate,
        });

        console.log(`[Batch Summary] user=${user.id} platform=${platform} total=${Date.now() - tUser}ms`);
        result.processed++;

        // Mark as sent for dedup
        if (options?.filterByHour) {
          const { markSummarySent } = await import('../../lib/summary-scheduling');
          const { resolveUserTimezone } = await import('../../lib/timezone');
          const tz = await resolveUserTimezone(user);
          await markSummarySent(user.id, summaryDate ? 'tomorrow' : 'daily', tz);
        }
      } catch (error) {
        console.error(`Failed to send summary to user ${user.id}:`, error);
        captureError(error, 'summary-batch-user', { user_id: user.id });

        if (error instanceof Error && error.message === 'GOOGLE_TOKEN_EXPIRED') {
          const t = await getBotMessages(user.language || 'en');
          const refreshUrl = buildUrl(`/refresh-token?user_id=${user.telegramId ?? user.id}`);
          const expiredMessage = `${t.tokenExpired.title}\n\n${t.tokenExpired.message}`;

          try {
            if ((platform === 'telegram' || platform === 'all') && user.telegramId) {
              await messagingService.sendMessage(user.telegramId, expiredMessage, {
                format: MessageFormat.HTML,
                replyMarkup: {
                  inline_keyboard: [[
                    { text: t.buttons.refreshGoogle, web_app: { url: refreshUrl } }
                  ]]
                }
              });
            }
            if ((platform === 'whatsapp' || platform === 'all') && getWhatsAppChatId(user)) {
              const waChatId = getWhatsAppChatId(user)!;
              const whatsappService = getMessagingServiceByPlatform(MessagingPlatform.WHATSAPP);
              const { buildWhatsAppTemplate } = await import('../messaging/whatsapp-template');
              const template = buildWhatsAppTemplate(user.language || 'en');
              await whatsappService.sendMessage(waChatId, '', { whatsappTemplate: template });
            }
          } catch (msgError) {
            console.error(`Failed to send token expired message to user ${user.id}:`, msgError);
            captureError(msgError, 'summary-token-expired-notify', { user_id: user.id }, 'warning');
          }

          const { notifyAdminWarning } = await import('../../utils/error-notifier');
          await notifyAdminWarning(
            'Token Expired',
            `User ${user.id} (${user.name}) needs to refresh their Google Calendar token`
          );
        }
      }
    }
  } catch (error) {
```
After:
```ts
      try {
        await deliverToUser(user, platform, { read: SCHEDULED_READ });
      } catch (error) {
        if (isGoogleFetchFailed(error)) {
          console.warn(`[Summary] Google unreachable for user ${user.id}; retrying after the batch`);
          if (googleRetries.length === 0) firstGoogleFailureAt = Date.now();
          googleRetries.push({ user, platform, day: error.day });
        } else {
          await reportFailure(user, platform, error);
        }
      }
    }

    // C5: 30 s after the first failure, each set-aside user gets one retry, in order.
    if (googleRetries.length > 0) {
      // Said once per batch, before the wait: if the process stops during it (a deploy),
      // these users get no summary and no dedup mark this hour, and Sentry has the count.
      captureWarning(`${googleRetries.length} scheduled summaries set aside for a Google retry`, 'summary-google-retry', {
        set_aside: googleRetries.length,
        summary_type: summaryDate ? 'tomorrow' : 'daily',
      });
      const waitMs = firstGoogleFailureAt + SCHEDULED_RETRY_AFTER_MS - Date.now();
      if (waitMs > 0) await scheduledRetrySleep(waitMs);
      for (const { user, platform, day } of googleRetries) {
        try {
          await retryOnce(user, platform, day);
        } catch (error) {
          await reportFailure(user, platform, error);
        }
      }
    }

    console.log(`[Batch Summary] ${summaryDate ? 'tomorrow' : 'daily'} done: processed=${result.processed} set aside=${googleRetries.length} total=${Date.now() - batchStartedAt.getTime()}ms`);
  } catch (error) {
```

Nothing else in the file changes. `DeliveryPlatform` (declared further down, `:691` at 716a4f8), `UserConfig` and C3's `isCalendarHomeOn` import are already in scope. `user.messagingPlatform || 'telegram'` is a `DeliveryPlatform`. The weather-only path in the loop keeps its own `markSummarySent` call with three arguments.

- [ ] **Step 4: `markSummarySent` takes the moment the mark is for, in `src/lib/summary-scheduling.ts` (lines 80-89)**

Edit 4a. Before:
```ts
/**
 * Mark a summary as sent for a user (sets Redis dedup key with 23h TTL).
 * 23h TTL ensures key expires before the next day's scheduled run.
 */
export async function markSummarySent(
  userId: number,
  summaryType: SummaryType,
  timezone: string
): Promise<void> {
  const localDate = formatInTimeZone(new Date(), timezone, 'yyyy-MM-dd');
```
After:
```ts
/**
 * Mark a summary as sent for a user (sets Redis dedup key with 23h TTL).
 * 23h TTL ensures key expires before the next day's scheduled run.
 * @param sentFor - The moment whose local date the mark is for; defaults to now. The
 *   scheduled retry passes its batch's start, so a summary that goes out past midnight
 *   is still marked for the day the batch chose it, and the next day's run isn't skipped.
 */
export async function markSummarySent(
  userId: number,
  summaryType: SummaryType,
  timezone: string,
  sentFor: Date = new Date()
): Promise<void> {
  const localDate = formatInTimeZone(sentFor, timezone, 'yyyy-MM-dd');
```

- [ ] **Step 5: The daily run's housekeeping runs beside the batch, in `src/cron/handlers.ts` (lines 19-106)**

The two housekeeping blocks move, word for word, into `syncRemindersAndCleanUp`; the handler starts it before the batch and awaits both. Two edits.

Edit 5a, the handler's start (lines 19-24). Before:
```ts
export async function handleDailySummary(): Promise<CronResult> {
  const { sendDailySummaryToAll } = await import('../services/telegram');
  const summaryResult = await sendDailySummaryToAll({ filterByHour: true });

  // Sync reminder cache from DB (piggyback on existing run)
  try {
```
After:
```ts
export async function handleDailySummary(): Promise<CronResult> {
  const { sendDailySummaryToAll } = await import('../services/telegram');
  // The reminder-cache sync and the OAuth clean-up run beside the summaries, not after
  // them: a scheduled batch can wait about 30 s and then retry the users whose Google read
  // failed (calendar home spec §3.1 step 6), and the alert pass must not wait for that.
  const housekeeping = syncRemindersAndCleanUp();
  const summaryResult = await sendDailySummaryToAll({ filterByHour: true });
  await housekeeping;

  return {
    success: true,
    message: 'Daily summaries sent successfully',
    processed: summaryResult.processed,
    skippedHour: summaryResult.skippedHour,
    skippedDay: summaryResult.skippedDay,
    skippedDedup: summaryResult.skippedDedup,
  };
}

/**
 * The daily run's housekeeping: the reminder-cache sync and, at 04:00 UTC, the clean-up of
 * expired OAuth state tokens. Each step catches its own failure, so this never rejects.
 */
async function syncRemindersAndCleanUp(): Promise<void> {
  // Sync reminder cache from DB (piggyback on existing run)
  try {
```

Edit 5b, the handler's old end (lines 94-106). Before:
```ts
      captureError(cleanupError, 'cron-daily-summary-oauth-cleanup', undefined, 'warning');
    }
  }

  return {
    success: true,
    message: 'Daily summaries sent successfully',
    processed: summaryResult.processed,
    skippedHour: summaryResult.skippedHour,
    skippedDay: summaryResult.skippedDay,
    skippedDedup: summaryResult.skippedDedup,
  };
}
```
After:
```ts
      captureError(cleanupError, 'cron-daily-summary-oauth-cleanup', undefined, 'warning');
    }
  }
}
```

Everything between the two edits (the sync's `try`/`catch` and the clean-up at UTC hour 4) is unchanged.

- [ ] **Step 6: Run the smoke under three clocks and the regression smokes again**

```bash
cd /Users/razielgershoni/development/famcalbot
for tz in UTC Asia/Jerusalem Pacific/Kiritimati; do TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-summary-retry.ts 2>&1 | grep -E '^(OK|FAIL|     )|passed \('; echo "smoke-summary-retry $tz exit=${pipestatus[1]}"; done
for f in smoke-google-connect smoke-native-reminder-digest smoke-partner-labels smoke-auth-identity smoke-native-reminders smoke-reminders smoke-summary-seam smoke-calendar-home-rollout; do for tz in UTC Asia/Jerusalem; do TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/$f.ts 2>&1 | grep -E '^(OK|FAIL)|passed' > /tmp/c4-$f-${tz//\//_}.after; echo "$f $tz exit=${pipestatus[1]}"; cmp -s /tmp/c4-$f-${tz//\//_}.before /tmp/c4-$f-${tz//\//_}.after && echo "  same output as Step 2" || echo "  OUTPUT CHANGED"; done; done
```
(zsh, as in Step 2.)

Expected for the new smoke, under each clock:
```
OK   the batch: the user the switch doesn't cover goes first, the FamCal user before the retries; one count to Sentry and one wait, then each set-aside user is retried once, in order
OK   the wait ends 30 s after the first failure (Noa at 07:00:04), not 30 s after the loop
OK   retry ok: the normal summary, with the retry's events, and no outage line
OK   retry fails again: the summary goes out without Google, with the outage line in the text and the voice note (Hebrew)
OK   retry finds a dead token: the token text with the refresh button and an admin notice, no outage run, no dedup mark (A-24)
OK   a set-aside first attempt reports no error; the batch counts them once; the outage run leaves one warning; the dead token is reported as before
OK   the batch logs one closing line: what it delivered, how many it set aside, and its total time
OK   the result counts the four summaries delivered
OK   the legacy user (switch off) reads through his provider, never the reader, and is never retried (A-33)
OK   the outage prompt is the empty-day prompt plus exactly one guideline line
OK   the outage summary is the empty-day summary plus the outage line, and it is marked sent
OK   a batch with no Google failure never waits and reads each user once, with the scheduled 30 s deadline
OK   when 30 s have passed by the end of the loop, the retry runs at once
OK   a tomorrow summary retried after local midnight reads and shapes the first attempt's day
OK   retry finds missing scopes: no message, no token cleared, no dedup mark, no outage run, Sentry only (A-25)
OK   a 23:00 tomorrow summary retried after midnight is marked for the batch's date, so the next evening's still goes out
OK   a switch turned back to OFF during the wait: the retry is today's summary through the provider, with no outage line, marked for the batch's date
OK   the daily cron run syncs the reminder cache and cleans up OAuth states beside the batch: done before the retry wait ends
OK   a legacy user's dead token gets today's token text and admin notice, with no wait and no retry
OK   nothing above reached the network or sent an admin error notice
20/20 passed (process TZ=UTC)
smoke-summary-retry UTC exit=0
```
Then the same with `(process TZ=Asia/Jerusalem)` and `(process TZ=Pacific/Kiritimati)`.

Every regression run prints `exit=0` and `same output as Step 2`.

The housekeeping check waits in real time only when it is failing (at most 2 s); green, the smoke takes about a second.

If the outage checks fail with the line or the guideline missing, look at C2 and C3 first: the smoke expects C3 to append `bot.errors.googleOutageNote` to the summary text, and C2 to add exactly one guideline line. If a `read …` line in the batch check differs, the C1 adapter is reading a different window or deadline than the split gives. Don't change the expected lines to make them pass.

- [ ] **Step 7: Type-check and lint**

```bash
cd /Users/razielgershoni/development/famcalbot
npx tsc --noEmit -p . && npm run -s lint; echo "exit $?"
```
Expected: no output from either, then `exit 0`. `next build` type-checks `scripts/**`, so the smoke is covered too. It imports `messages/en.json` and `messages/he.json` typed, so it type-checks only with C2's `googleOutageNote` in place.

- [ ] **Step 8: Commit**

```bash
cd /Users/razielgershoni/development/famcalbot
git add src/services/telegram/summary.ts src/lib/summary-scheduling.ts src/cron/handlers.ts scripts/smoke-summary-retry.ts
git commit -m "$(cat <<'EOF'
feat(summary): scheduled summaries retry Google once, then go out with an outage line

For users the calendar home switch covers, a scheduled daily or tomorrow
summary whose Google read fails (GOOGLE_FETCH_FAILED) is set aside and the
batch moves on. After the loop the run waits until 30 s have passed since
the first such failure, then retries each set-aside user once, in order, on
the first attempt's day with the 15 s retry deadline. Only a second outage
sends the summary without Google, with the outage guideline and line; it
counts as sent and sets the dedup mark. Anything else on the retry is handled
as before: a dead token gets the token text with the refresh button and no
dedup mark. First attempts now read with the scheduled 30 s deadline. Users
the switch doesn't cover are unchanged.

The retry's summaries are marked sent for the batch's own date, so a 23:00
tomorrow summary retried past midnight no longer skips the next evening's.
A retry whose user the switch no longer covers gets today's path. The batch
puts the users the switch doesn't cover first, tells Sentry once how many
it set aside before it waits, and logs its total time. The daily run's
reminder-cache sync and OAuth clean-up run beside the batch, not after its
retries.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
EOF
)"
```
Stage only these four paths.

---

### Task 5 (C5): Week lookahead on the reader

**Interface change versus the split: none to any signature.** `getWeekLookahead` and `getNextWeekLookahead` gain the trailing `read?: DigestRead` (default `DEFAULT_ON_DEMAND_READ`) exactly as written. Three additions the split didn't name, for review:
- **A new smoke, `scripts/smoke-week-commands.ts`** (7 checks), for the `/week` and `/nextweek` `onError`. The split names only `scripts/smoke-week-lookahead.ts`, which can't load `commands.ts`. The reader's throws are checked end to end in `smoke-week-lookahead.ts` (h); the new smoke checks what each command answers to them.
- **One private helper, `answerWeekError(error, ctx)`** in `commands.ts`, shared by both commands. Nothing new is exported.
- **`commands.ts` imports `clearGoogleRefreshToken` statically** from `../user-service`, which it already imports. `summary.ts` imports it with `import()`. Same function, same `BigInt(user.telegramId)` argument.

Two changes from the review of this plan:
- **R13's text goes out as HTML on `/week` and `/nextweek` too** (`format: MessageFormat.HTML`, into the draft or as a message), as C3's daily sends it and as the token and permission answers beside it are sent. Before, the two paths sent the same text with and without a format, so a future translation with a `&` or `<` could render differently on them. `smoke-week-commands` also checks that the text is HTML-safe in all three languages.
- **A week-start check for users with no location and no Google token** in `smoke-week-lookahead` (h): `tzKnownFor` is false for them, so the language decides (R15). 41 → 42 checks.

**What and why.** With the switch on, `/week`, `/nextweek` and the tomorrow summary's week block read through the shared reader, as the daily summaries do after C3 (spec §3.1 items 2, 3 and 5). Today's week read talks to Google directly. It asks `calendars.get` for every calendar, takes Google's first 250 items, has no timeout, lets working-location blocks and declined invites through, and swallows every failure, so a dead token, missing permissions and an outage all come out as "No notable events" (Ruling R14). This task changes three things:
- **The read:** `fetchEventsInRange`'s first line hands switch-covered users to C1's `readLookaheadEvents`. They then get the reader's clean-up and deadlines (spec §3.3 C1, C2, C6 and C8), and its failures are thrown.
- **The week start:** This week's last day and Next week's days come from B2's `nextWeekBoundary` / `nextWeekBoundaries`, with `weekStartFor` for switch-covered users and `legacyWeekStart` for everyone else. New York and Israeli default-culture weeks become Sunday–Saturday, Cairo's Saturday–Friday, and London stays Monday–Sunday (C7).
- **The answers:** `/week` and `/nextweek` answer a dead token and missing permissions as the on-demand daily does (missing permissions also clear the token). An outage gets R13's "couldn't reach Google Calendar", after the reader's quick retry, with no admin notice. Anything else still gets the pipeline's text and admin notice (A-28).

`homeOn` is asked once per lookahead. The tomorrow summary passes its `opts.read` to the week block, so a scheduled run's week read gets the scheduled deadline and no quick retry.

**Users the switch doesn't cover get today's output byte for byte (A-33).** Their weeks come from `legacyWeekStart`, which gives today's days on every weekday with and without `lookaheadAlways7Days` (`smoke-locale-rules` holds B2's functions to verbatim copies of the two removed ones). Their reads are today's code, unchanged below the new first line. They never reach the new `onError` branches, because today's read never throws `GOOGLE_*`. The one new step is an `await isCalendarHomeOn(user)` per lookahead: a 30 s memo, then Redis, then the DB, and `OFF` if neither answers (B1). It never throws. Sections (a)–(g) of `smoke-week-lookahead.ts` run with the switch off and pass unchanged.

**Say in the PR (switch-covered users, spec §3.3):**
- C1, C2 and C8 reach the weekly reads too: working-location, out-of-office and focus-time blocks and the owner's declined invites leave `/week`, `/nextweek` and the tomorrow week block, and items past Google's first 250 per calendar are no longer cut.
- C6: the weekly Google reads run in parallel per calendar, report failures to Sentry, and follow Ruling R14 (this task's `onError`).
- C7: weeks start by country.
- Users the switch doesn't cover see no change. The `/week` and `/nextweek` `onError` branches can't fire for them, and the only new work per lookahead is one `isCalendarHomeOn` read.

**Findings that shaped the code:**
- **Line numbers.** The split cites `main@858886c` (`:202`, `:80-99`, `:435-451`). At 716a4f8, after Plan A, they are:
  - `fetchEventsInRange` at `:247`, with its doc comment from `:244`;
  - `getNextWeekBoundary` at `:91-110`, plus `weekdayOf` at `:72-75`;
  - `getNextWeekBoundaries` at `:483-499`.

  Every Before block below quotes 716a4f8 and matches its file exactly once (checked).
- **Depends on:**
  - **C1:** `src/services/calendar-read/digest.ts`, with `DigestRead`, `DEFAULT_ON_DEMAND_READ`, `SCHEDULED_READ` and `readLookaheadEvents(user, start, end, tz, ids, read)`. The smoke relies on the split's C1 rules:
    - an empty-token Google user → `[]`;
    - `reconnect('token')` → `GOOGLE_TOKEN_EXPIRED`, and `reconnect('scopes')` → `GOOGLE_INSUFFICIENT_SCOPES`;
    - any other Google `error` → `GOOGLE_FETCH_FAILED` carrying `day`, the read's first day;
    - one quick retry on demand at 8,000 ms, none when scheduled;
    - a FamCal error rethrows its cause.
  - **C2:** `bot.errors.googleUnreachable` in `messages/{en,he,ru}.json`. The new smoke reads the expected text from those files, so it doesn't depend on C2's wording.
  - **C3:** `prepareSummaryForUser`'s trailing `opts?: { day?; read?; googleUnavailable? }`. Step 5 reads `opts?.read`. C3 leaves the line it edits (`summary.ts:153` at 716a4f8) as it is. The week block's skip under `googleUnavailable` is C3's.
  - **B1, B2, B8:** `isCalendarHomeOn`; `weekStartFor`, `legacyWeekStart`, `tzKnownFor`, `nextWeekBoundary`, `nextWeekBoundaries` and `WeekStart`; `readRange`, through C1.
- **Why the order matters:**
  - `homeOn` is asked before the week boundary, because it picks the week start;
  - it is also asked before the existing early return (no calendars, or a Google user with an empty token), because `dateRange` uses that boundary;
  - the early return stays as it is: those users get `[]` with no read either way, which is C1's empty-token rule too.
- **`tzKnownFor(user)`** is a location or a Google token.
  - Every Google user who reaches the read has a token, so Google users get their timezone's country.
  - A built-in calendar user without a location gets the language rule (R15).
- **The reader reads the user's own choices** (A-3).
  - Google: `user.calendarAssignments`, narrowed to the ids `week-lookahead` passes (`calendars.map(c => c.calendarId)`).
  - FamCal: the legend from `listVisibleCalendars`, narrowed to the `native:<cuid>` ids `getCalendarAssignmentsForUser` gives.

  So the switch-on fixtures carry `calendarAssignments` (Google) or `native:` ids (built-in), as the spec's smoke note says.
- **The window** is `[max(local midnight of start's day, start), local midnight after end's day)` (C1, via `readRange`).
  - The instants are today's, except that the end is the exclusive midnight. Today it is `…:59.999`.
  - Google is asked with that `timeMax`.
  - `dateRange` still comes from `endOfLocalDay`, so the prompt's "From … to …" line doesn't change.
- **The request shows which read ran.** The reader's per-request timeout is `min(10000, deadlineMs - 500)`: 9,500 on demand, 7,500 on the quick retry, and 10,000 for a scheduled read. The smoke reads it off the fake list to check that `read` reaches the reader.
- **Static imports, no cycle.**
  - Nothing under `calendar-read/` imports `week-lookahead`, and `recurrence-cache` is a leaf.
  - `week-lookahead` already loads `calendar-provider/index`, which loads `native-provider` and `google-provider` (and through it `calendar-read/google`). The graph grows only by `calendar-read/{index,famcal,digest,rollout}`.
  - Static imports also let the smokes' require-cache stubs reach the reader. Under Node 22 an `import()` from CommonJS goes past `Module._load`, and needs a load hook, as `smoke-week-commands.ts` has for `commands.ts`'s own `import()` calls.
- **`weekdayOf` and `addDaysToDate`** were used only by the two removed functions. Both go; lint flags the leftovers otherwise.
- **The tomorrow block keeps its `catch`** (`summary.ts:158-161`): a week-block failure degrades the summary and never fails it (A-28).
- **Token and permission answers mirror `sendSummaryToUser`'s `onError`** (`summary.ts:297-331`):
  - the same texts with `format: HTML`;
  - the same `notifyAdminWarning` titles and bodies;
  - missing permissions clear the token by `BigInt(user.telegramId)`, never `user.id`, and a WhatsApp-only user keeps theirs, as on the daily.

  The daily sends these with `sendMessage` even when a draft is open. `execute-command` opens one for `/week` and `/nextweek` on Telegram, so the draft's "Looking ahead…" placeholder stays above the token text. That's today's daily behaviour, kept so the two answer alike (R14). Moving both to `streamHandle.cancel` is a one-line follow-up for C3 and this task together. **Flag it in review.**
- **R13's text** goes through `streamHandle.cancel(text, { format: HTML })` when a draft is open, else `sendMessage(chatId, text, { format: HTML })`. That is how C3 sends the daily's (`summary.ts`, the R13 branch), and how `deliverSummary` sends its own "could not generate" text. The pipeline's own error texts go without a format; `bot.errors.*` texts are written HTML-safe (no `&`, `<` or `>`), so they read the same either way, and the smoke now checks that for R13's.
- **A user with no location and no Google token** (a built-in calendar user who never set one): `resolveUserTimezone` falls back to Asia/Jerusalem and `tzKnownFor` is false, so `weekStartFor` goes to the language: `en` and `he` Sunday, `ru` and anything else Monday (spec §6 step 3, R15, §11). The smoke pins it on Thursday 22 October for `en`, `he`, `ru` and `fr`, and today's Monday weeks for all four with the switch off.
- **Running the smoke:** the on-demand rate-limit case waits through C1's 1 s quick-retry pause, in real time. `smoke-week-lookahead` takes about 3 s.

**Files:**
- Modify: `src/services/week-lookahead.ts`, eight spots:
  - `:8-9` and `:19-20`: the imports;
  - `:72-110`: `weekdayOf` and `getNextWeekBoundary` become `weekStartOf`;
  - `:244-253`: `fetchEventsInRange`;
  - `:404-415` and `:426-432`: `getWeekLookahead`;
  - `:476-515` and `:527-533`: `getNextWeekBoundaries` goes, and `getNextWeekLookahead` changes.
- Modify: `src/services/telegram/summary.ts:153`, one line (the week block's call).
- Modify: `src/services/telegram/commands.ts`, four spots:
  - `:7-10`: imports;
  - before `:495`: `answerWeekError`;
  - `:589-595`: `/week`'s `onError`;
  - `:690-696`: `/nextweek`'s `onError`.
- Modify (test): `scripts/smoke-week-lookahead.ts`, fourteen spots (Step 1). It goes from 35 to 42 checks.
- Create (test): `scripts/smoke-week-commands.ts` (7 checks)
- Test: both, under `TZ=UTC`, `TZ=Asia/Jerusalem` and (week-lookahead) `TZ=Pacific/Kiritimati`
- Regression (unchanged): `scripts/smoke-partner-labels.ts` (loads `week-lookahead` and `summary.ts`), `scripts/smoke-native-reminder-digest.ts` (`summary.ts`), `scripts/smoke-weather-command.ts` and `scripts/smoke-google-connect.ts` (`commands.ts`), `scripts/smoke-locale-rules.ts` (holds B2's boundaries to today's), and `scripts/smoke-reminders.ts` and `scripts/smoke-native-provider-reminders.ts` (spec §10: unchanged through Plan C)

**Interfaces:**
- Consumes:
  - C1 (`src/services/calendar-read/digest.ts`):
    - `export type DigestRead = { mode: 'scheduled' | 'onDemand'; deadlineMs: number }`
    - `export const DEFAULT_ON_DEMAND_READ: DigestRead` (`{ mode: 'onDemand', deadlineMs: 10000 }`)
    - `export const SCHEDULED_READ: DigestRead` (`{ mode: 'scheduled', deadlineMs: 30000 }`; smoke only)
    - `export function readLookaheadEvents(user: UserConfig, start: Date, end: Date, tz: string, ids: readonly string[], read: DigestRead): Promise<CalendarEvent[]>`
  - B1: `isCalendarHomeOn(user: { isAdmin?: boolean | null }): Promise<boolean>` (`src/services/calendar-read/rollout.ts:88`)
  - B2 (`src/utils/locale-rules.ts`):
    - `weekStartFor(f: LocaleFacts): WeekStart`
    - `legacyWeekStart(culture?: string): 0 | 1`
    - `tzKnownFor(u: { location?: string | null; googleRefreshToken?: string | null }): boolean`
    - `nextWeekBoundary(ws: WeekStart, always7: boolean | undefined, today: string): string`
    - `nextWeekBoundaries(ws: WeekStart, today: string): { first: string; last: string }`
    - `type WeekStart`
  - C2: `bot.errors.googleUnreachable` (via `getBotMessages`)
  - C3: `prepareSummaryForUser(…, opts?: { day?: DayKey; read?: DigestRead; googleUnavailable?: boolean })`
  - Unchanged: `clearGoogleRefreshToken(telegramId: number | bigint)` (`user-service.ts:176`), `notifyAdminWarning(title, message)`, `executeCommand`'s `onError?: (error: Error) => Promise<boolean>` (`command-pipeline.ts:24`)
- Produces:
  - `export async function getWeekLookahead(user: UserConfig, calendars: CalendarAssignment[], referenceDate?: Date, read: DigestRead = DEFAULT_ON_DEMAND_READ): Promise<WeekLookahead>`
  - `export async function getNextWeekLookahead(user: UserConfig, calendars: CalendarAssignment[], referenceDate?: Date, read: DigestRead = DEFAULT_ON_DEMAND_READ): Promise<WeekLookahead>`
  - private `fetchEventsInRange(user, calendarIds, start, end, timezone, homeOn: boolean, read: DigestRead)`, whose first line is `if (homeOn) return readLookaheadEvents(user, start, end, timezone, calendarIds, read);`
  - private `weekStartOf(user: UserConfig, timezone: string, homeOn: boolean): WeekStart`
  - private `answerWeekError(error: Error, ctx: { chatId: number | string; user: UserConfig; userLanguage: string; messagingService: IMessagingService; streamHandle?: StreamMessageHandle }): Promise<boolean>` (`commands.ts`)
  - Unchanged: `formatTomorrowLookahead`, `WeekLookahead`, `LookaheadEvent`, and the re-exported cache clears.
  - C4 and C6 use them like this:
    - C4's retry and outage runs pass their `read` through `prepareSummaryForUser`'s `opts`, and the week block forwards it.
    - C6's `/week` and `/nextweek` parity runs call `getWeekLookahead(user, calendars, ref)` with `weekStartFor` stubbed to `legacyWeekStart`. C6 replaces `src/utils/locale-rules.ts` in require's cache before `week-lookahead` loads. Patching the loaded module does nothing: tsx's CommonJS exports are getters with no setter, so an assignment is silently dropped (checked).

**Verified against stand-ins** (in the scratch copy only, not part of this task): C1, C2 and C3 weren't in the base, the scratch base of header, Planning Ruling 2 (nor are they at 716a4f8).
- **C1:** `digest.ts` with the split's exports, following spec §3.1 Adapters:
  - `readRange` with `googleCache: 'bypass'`, `calendarIds` and `notBefore`;
  - the empty-token rule;
  - `throwForDigest` as tabled;
  - the on-demand quick retry: a Google `error` other than `calendars_gone` or `timeout`, within 5,000 ms, 1 s pause, 8,000 ms.
- **C2:** the two `bot.errors` keys in en/he/ru, with stand-in wording.
- **C3:** only the trailing `opts` parameter on `prepareSummaryForUser`, with no use.

**Replayed on 716a4f8 with C1–C4 as committed**, every step as written: Step 3 prints 35/42 under each clock and 3/7 under each of its clocks; Step 7 prints 42/42 and 7/7; the regression loop prints the same lines; `tsc` and lint are clean; and the tree is the one this task's commit makes.

**Not verified here:**
- the tomorrow summary's week block with a `read` (the one line in Step 5) runs only in C3/C4/C6's smokes. `tsc` checks it here;
- `next build` (the copy's `node_modules` are symlinks).

- [ ] **Step 1: Add the switch-on checks to `scripts/smoke-week-lookahead.ts`**

Fourteen edits, in file order. Line numbers are those of the file at 716a4f8 (725 lines). The new section (h) runs after (g), with real timers:
- the switch off for (a)–(g): it was asked, and the reader never ran;
- the same Israel prompts with the switch on, and the reader's own request;
- a built-in calendar's lists through the reader's FamCal half;
- the week start by country, and by language for users with no location and no Google token;
- New York's Sunday–Saturday next week as the prompt shows it;
- the errors, with the switch on and off.

The fixtures for (h) are new users (ids 7 and 9–19) or copies of existing ones with `isAdmin` and their choices. So no (a)–(g) fixture changes.

Edit 1a, the header comment (lines 15-19). Before:
```ts
// Google, the native calendar, the timezone lookup and the AI are stubbed. No network.
//
// Run under both clocks; the output must not depend on the server's timezone:
//   TZ=UTC npx tsx scripts/smoke-week-lookahead.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-week-lookahead.ts
```
After:
```ts
// With the calendar home's switch on (section (h)), the same lookaheads read through the
// shared reader (src/services/calendar-read): a token step first, one events.list per
// chosen calendar named by the list itself, the read's deadline, an exclusive midnight at
// the end, and Google's failures thrown for /week and /nextweek to answer. The weeks
// start by country (spec §6): New York and Israel on Sunday, London on Monday, Cairo on
// Saturday. Sections (a)-(g) run with the switch off and hold as they were.
//
// Google (today's client, and the reader's OAuth client and list), the native calendar,
// the rollout switch, the timezone lookup and the AI are stubbed. No network.
//
// Run under these clocks; the output must not depend on the server's timezone:
//   TZ=UTC npx tsx scripts/smoke-week-lookahead.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-week-lookahead.ts
//   TZ=Pacific/Kiritimati npx tsx scripts/smoke-week-lookahead.ts
```

Edit 1b, the reader's read type (line 27). Before:
```ts
import type { WeekLookahead } from '../src/services/week-lookahead';
```
After:
```ts
import type { WeekLookahead } from '../src/services/week-lookahead';
import type { DigestRead } from '../src/services/calendar-read/digest';
```

Edit 1c, two more timezones (lines 49-50). Before:
```ts
const IL = 'Asia/Jerusalem';
const NY = 'America/New_York';
```
After:
```ts
const IL = 'Asia/Jerusalem';
const NY = 'America/New_York';
const LONDON = 'Europe/London';
const CAIRO = 'Africa/Cairo';
```

Edit 1d, the built-in calendar's events for user 7, the new users' timezones (ids 7 and 9-19) and the list recorder (lines 129-134). Before:
```ts
const NATIVE_BY_USER: Record<number, CalendarEvent[]> = { 5: NATIVE_REMINDERS };

const TIMEZONES: Record<number, string> = { 1: IL, 2: NY, 3: NY, 4: NY, 5: IL, 6: IL, 66: IL };

/** Every events.list request, to see which timezone it asked for. */
const googleCalls: Array<{ token: string; timeMin: string; timeMax: string; timeZone?: string }> = [];
```
After:
```ts
const NATIVE_BY_USER: Record<number, CalendarEvent[]> = { 5: NATIVE_REMINDERS, 7: NATIVE_REMINDERS };

const TIMEZONES: Record<number, string> = {
  1: IL, 2: NY, 3: NY, 4: NY, 5: IL, 6: IL, 66: IL,
  7: IL, 9: LONDON, 10: CAIRO, 11: IL, 12: IL, 13: IL, 14: IL, 15: IL,
  16: IL, 17: IL, 18: IL, 19: IL,
};

/** Every events.list request, to see which timezone, window, fields and timeout it asked for. */
const googleCalls: Array<{ token: string; timeMin: string; timeMax: string; timeZone?: string; fields?: string; timeout?: number }> = [];
```

Edit 1e, the switch and the reader's recorders, after the cache's clock (lines 147-148). Before:
```ts
/** The cache's clock: Date.now returns it during the (g) checks. */
let clock = 0;
```
After:
```ts
/** The cache's clock: Date.now returns it during the (g) checks. */
let clock = 0;
/** The rollout switch as isCalendarHomeOn reads it: OFF for (a)-(g). */
let rollout: 'OFF' | 'ADMINS' | 'ALL' = 'OFF';
/** Every isCalendarHomeOn question, by user id. */
const homeOnCalls: number[] = [];
/** Every token step of the reader (getAccessToken), by refresh token. */
const tokenSteps: string[] = [];
/** What the token step throws for a refresh token, while set. */
const tokenErrors: Record<string, Error> = {};
/** What events.list throws for a refresh token, while set: today's read and the reader alike. */
const listErrors: Record<string, Error> = {};
/** Every calendars.get request (today's read asks it for the calendar's name), by token. */
const calendarGets: string[] = [];
/** Every fetchViewerItems call (the reader's FamCal half): user, calendars, window. */
const viewerCalls: string[] = [];
```

Edit 1f, Google's failures as its clients throw them, after `googleError` (line 151). Before:
```ts
const googleError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status, response: { status } });
```
After:
```ts
const googleError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status, response: { status } });
/** The token endpoint's answer to a revoked refresh token. */
const invalidGrant = () => Object.assign(new Error('invalid_grant'), {
  status: 400, response: { status: 400, data: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } },
});
/** A list refused for a permission the user unticked. */
const insufficientScopes = () => Object.assign(new Error('Request had insufficient authentication scopes.'), {
  code: 403, status: 403, response: { status: 403, data: { error: { code: 403, errors: [{ reason: 'insufficientPermissions' }] } } },
});
/** A list refused by Google's rate limit. */
const rateLimited = () => Object.assign(new Error('Rate Limit Exceeded'), {
  code: 403, status: 403, response: { status: 403, data: { error: { code: 403, errors: [{ reason: 'rateLimitExceeded' }] } } },
});
```

Edit 1g, the fake client records calendars.get (lines 158-160). Before:
```ts
function fakeGoogleClient(token: string) {
  return {
    calendars: { get: async () => ({ data: { summary: 'Family' } }) },
```
After:
```ts
function fakeGoogleClient(token: string) {
  return {
    calendars: {
      get: async () => {
        calendarGets.push(token);
        return { data: { summary: 'Family' } };
      },
    },
```

Edit 1h, the list records its fields and timeout and can fail (lines 168-169). Before:
```ts
      list: async (params: { timeMin: string; timeMax: string; timeZone?: string }) => {
        googleCalls.push({ token, ...params });
```
After:
```ts
      list: async (params: { timeMin: string; timeMax: string; timeZone?: string; fields?: string }, options?: { timeout?: number }) => {
        googleCalls.push({ token, ...params, timeout: options?.timeout });
        if (listErrors[token]) throw listErrors[token];
```

Edit 1i, the list names its calendar, and the fake OAuth client and the native rows follow the fake client (lines 180-185). Before:
```ts
          .map(f => ({ summary: f.summary, start: stamp(f.start), end: stamp(f.end), recurringEventId: f.recurringEventId }));
        return { data: { items } };
      },
    },
  };
}
```
After:
```ts
          .map(f => ({ summary: f.summary, start: stamp(f.start), end: stamp(f.end), recurringEventId: f.recurringEventId }));
        // The calendar's title comes on the list too; the reader reads it there.
        return { data: { summary: 'Family', items } };
      },
    },
  };
}

/** The reader's OAuth client (calendar.ts getGoogleAuth): its token step, then the list client above. */
function fakeGoogleAuth(token: string) {
  return {
    token,
    getAccessToken: async () => {
      tokenSteps.push(token);
      if (tokenErrors[token]) throw tokenErrors[token];
      return { token: `access-${token}` };
    },
  };
}

/**
 * The native provider's rows for the reader's FamCal half (fetchViewerItems): the events
 * the provider stub hands over, each on calendar fam1, with its series and instance.
 */
function viewerItemsFor(u: { id: number }) {
  return (NATIVE_BY_USER[u.id] ?? NATIVE_EVENTS).map((event, i) => ({
    row: {
      series: {
        id: event.recurringEventId ?? `single-${i}`,
        kind: event.eventType === 'reminder' ? 'REMINDER' : 'EVENT',
        rrule: event.recurringEventId ? RRULES[event.recurringEventId] ?? null : null,
      },
      instance: { title: event.summary, instanceStartsAt: new Date(event.start.includes('T') ? event.start : `${event.start}T00:00:00Z`) },
      calendar: { id: 'fam1' },
    },
    event: { ...event, provider: 'native' },
  }));
}
```

Edit 1j, the switch-on fixtures, after the calendar list (line 207), the four placeless users (ids 16-19) among them. Before:
```ts
const calendars: CalendarAssignment[] = [{ calendarId: 'family', labels: ['primary'], name: 'Family', color: '#000' }];
```
After:
```ts
const calendars: CalendarAssignment[] = [{ calendarId: 'family', labels: ['primary'], name: 'Family', color: '#000' }];

// For (h): admins, so the ADMINS switch covers them, carrying their choices, which the
// reader reads (A-3). Jewish culture keeps Sunday weeks either way, so the switch changes
// only how they are read.
const homeUser = (u: UserConfig, extra: Record<string, unknown> = {}) =>
  ({ ...u, isAdmin: true, calendarAssignments: calendars, ...extra }) as UserConfig;
const onIsraeli = homeUser(israeli);
const onNewYorker = homeUser(newYorker);
const nativeJewish = homeUser(user(7, { culture: 'jewish', googleRefreshToken: '', calendarSource: 'NATIVE' }), { calendarAssignments: undefined });
const londoner = homeUser(user(9, { culture: 'default', googleRefreshToken: 'token-london' }));
const cairene = homeUser(user(10, { culture: 'default', googleRefreshToken: 'token-cairo' }));
const defaultIsraeli = homeUser(user(11, { culture: 'default', googleRefreshToken: 'token-il-default' }));
const deadToken = homeUser(user(12, { culture: 'jewish', googleRefreshToken: 'token-dead' }));
const noScopes = homeUser(user(13, { culture: 'jewish', googleRefreshToken: 'token-scopes' }));
const rateLimitedUser = homeUser(user(14, { culture: 'jewish', googleRefreshToken: 'token-busy' }));
const brokenNative = homeUser(user(15, { culture: 'jewish', googleRefreshToken: '', calendarSource: 'NATIVE' }), { calendarAssignments: undefined });
/**
 * Built-in calendar users with no location and no Google token: resolveUserTimezone falls
 * back to Asia/Jerusalem for them, with tzKnown false, so the week start comes from the
 * language (R15).
 */
const placeless = (id: number, language: string) =>
  homeUser(user(id, { culture: 'default', language, location: null, googleRefreshToken: '', calendarSource: 'NATIVE' }), { calendarAssignments: undefined });
const placelessByLanguage = [placeless(16, 'en'), placeless(17, 'he'), placeless(18, 'ru'), placeless(19, 'fr')];
/** A built-in calendar user's calendars, as getCalendarAssignmentsForUser gives them; the reader keeps the legend's. */
const nativeCalendars: CalendarAssignment[] = [{ calendarId: 'native:fam1', labels: ['primary'], name: 'Family', color: '#000' }];
```

Edit 1k, the stubs (lines 234-240): a stub by file name, and the reader's imports. Before:
```ts
  const stub = (file: string, exports: Record<string, unknown>) => {
    const filename = path.resolve(__dirname, '../src', file);
    const mod = new Module(filename);
    Object.assign(mod, { filename, loaded: true, exports });
    Module._cache[filename] = mod;
  };
  stub('services/calendar.ts', { TIMEZONE: IL, getCalendarClient: fakeGoogleClient });
```
After:
```ts
  const stubFile = (filename: string, exports: Record<string, unknown>) => {
    const mod = new Module(filename);
    Object.assign(mod, { filename, loaded: true, exports });
    Module._cache[filename] = mod;
  };
  const stub = (file: string, exports: Record<string, unknown>) => stubFile(path.resolve(__dirname, '../src', file), exports);
  stub('services/calendar.ts', { TIMEZONE: IL, getCalendarClient: fakeGoogleClient, getGoogleAuth: fakeGoogleAuth });
  // The reader builds its list client from the OAuth client (google.ts), here keyed by its token.
  stubFile(require.resolve('@googleapis/calendar'), {
    __esModule: true,
    calendar: ({ auth }: { auth: { token: string } }) => fakeGoogleClient(auth.token),
  });
  stub('services/calendar-read/rollout.ts', {
    isCalendarHomeOn: async (u: { id: number; isAdmin?: boolean | null }) => {
      homeOnCalls.push(u.id);
      return rollout === 'ALL' || (rollout === 'ADMINS' && u.isAdmin === true);
    },
  });
  // The reader's FamCal half (famcal.ts): the legend, the rows and the viewer.
  stub('services/calendar-provider/native-provider.ts', {
    fetchViewerItems: async (u: { id: number }, cuids: string[], range: { from: Date; to: Date }) => {
      viewerCalls.push(`${u.id} ${cuids.join(',')} ${range.from.toISOString()} ${range.to.toISOString()}`);
      if (u.id === brokenNative.id) throw new Error("Can't reach database server");
      return { ctx: { viewerId: u.id, partner: null }, items: viewerItemsFor(u) };
    },
  });
  stub('services/native-reminders/ownership.ts', { loadViewerContext: async (u: { id: number }) => ({ viewerId: u.id, partner: null }) });
```

Edit 1l, the native store stub also gives the reader its legend (lines 245-251). Before:
```ts
  stub('services/native-calendar/event-store.ts', {
    getNativeSeriesRrule: async (id: string) => {
      nativeCalls.push(id);
      if (nativeError) throw nativeError;
      return RRULES[id] ?? null;
    },
  });
```
After:
```ts
  stub('services/native-calendar/event-store.ts', {
    getNativeSeriesRrule: async (id: string) => {
      nativeCalls.push(id);
      if (nativeError) throw nativeError;
      return RRULES[id] ?? null;
    },
    listVisibleCalendars: async (userId: number) => [{ id: 'fam1', ownerUserId: userId, name: 'Family', color: '#000' }],
    encodeCalendarId: (cuid: string) => `native:${cuid}`,
  });
```

Edit 1m, the scheduled read, imported after the cache module (lines 265-266). Before:
```ts
  const { RECURRENCE_CACHE_MAX_ENTRIES, RECURRENCE_ANSWER_TTL_MS, RECURRENCE_FAILURE_TTL_MS, writeRecurrenceCache } =
    await import('../src/services/recurrence-cache');
```
After:
```ts
  const { RECURRENCE_CACHE_MAX_ENTRIES, RECURRENCE_ANSWER_TTL_MS, RECURRENCE_FAILURE_TTL_MS, writeRecurrenceCache } =
    await import('../src/services/recurrence-cache');
  const { SCHEDULED_READ } = await import('../src/services/calendar-read/digest');
```

Edit 1n, section (h), before the results (line 713). Before:
```ts
  let failed = 0;
```
After:
```ts
  // (h) the calendar home's switch on
  const FIELDS =
    'summary,nextPageToken,items(id,status,summary,description,location,start,end,recurringEventId,originalStartTime,eventType,attendees(self,responseStatus),htmlLink)';

  await check('(h) with the switch off, (a)-(g) asked the switch and read as before: no token step, no reader read', () => {
    assert(homeOnCalls.length > 0, 'no lookahead asked the switch');
    assert(tokenSteps.length === 0, `token steps: ${tokenSteps.join(', ')}`);
    assert(viewerCalls.length === 0, `reader reads: ${viewerCalls.join('; ')}`);
  });

  await check('(h) switch on, Israel: the same /week and /nextweek prompts, read through the reader with its own request', async () => {
    const saturdayNight = new Date('2026-10-17T23:30:00+03:00');
    rollout = 'OFF';
    const offWeek = await promptFor(await getWeekLookahead(onIsraeli, calendars, ilTuesdayNight), onIsraeli);
    const offNext = await promptFor(await getNextWeekLookahead(onIsraeli, calendars, saturdayNight), onIsraeli, true);
    rollout = 'ADMINS';
    googleCalls.length = 0;
    calendarGets.length = 0;
    tokenSteps.length = 0;
    homeOnCalls.length = 0;
    const onWeek = await promptFor(await getWeekLookahead(onIsraeli, calendars, ilTuesdayNight), onIsraeli);
    const onNext = await promptFor(await getNextWeekLookahead(onIsraeli, calendars, saturdayNight), onIsraeli, true);
    rollout = 'OFF';
    assert(onWeek === offWeek, `/week prompt changed:\n${onWeek}\n--- with the switch off ---\n${offWeek}`);
    assert(onNext === offNext, `/nextweek prompt changed:\n${onNext}\n--- with the switch off ---\n${offNext}`);
    assertList([
      `switch asked for ${homeOnCalls.join(', ')}`,
      `token steps ${tokenSteps.join(', ')}`,
      `calendars.get ${calendarGets.length}`,
      ...googleCalls.map(c => `list ${c.timeMin} to ${c.timeMax} in ${c.timeZone}, timeout ${c.timeout}, ${c.fields === FIELDS ? "the reader's fields" : `fields ${c.fields}`}`),
    ], [
      'switch asked for 1, 1',
      'token steps token-il, token-il',
      'calendars.get 0',
      `list ${ilTuesdayNight.toISOString()} to ${startOfLocalDay('2026-10-18', IL).toISOString()} in ${IL}, timeout 9500, the reader's fields`,
      `list ${startOfLocalDay('2026-10-18', IL).toISOString()} to ${startOfLocalDay('2026-10-25', IL).toISOString()} in ${IL}, timeout 9500, the reader's fields`,
    ]);
  });

  await check('(h) switch on, built-in calendar: /week and /nextweek list the same, through the reader\'s FamCal half', async () => {
    const tuesday = new Date('2026-10-13T09:00:00+03:00');
    const listing = (l: WeekLookahead) => [
      `${l.dateRange.start.toISOString()} to ${l.dateRange.end.toISOString()}`,
      ...l.events.map(e => `${e.day} ${e.summary} ${e.recurrenceType}${e.reminder ? ' reminder' : ''}`),
    ];
    const both = async () => [
      ...listing(await getWeekLookahead(nativeJewish, nativeCalendars, tuesday)),
      ...listing(await getNextWeekLookahead(nativeJewish, nativeCalendars, tuesday)),
    ];
    rollout = 'OFF';
    const off = await both();
    rollout = 'ALL';
    viewerCalls.length = 0;
    const on = await both();
    rollout = 'OFF';
    assertList(on, off);
    assert(on.some(line => line.endsWith('Call the plumber single reminder')), `nothing listed: ${on.join(' | ')}`);
    assertList(viewerCalls, [
      `7 fam1 ${tuesday.toISOString()} ${startOfLocalDay('2026-10-18', IL).toISOString()}`,
      `7 fam1 ${startOfLocalDay('2026-10-18', IL).toISOString()} ${startOfLocalDay('2026-10-25', IL).toISOString()}`,
    ]);
  });

  await check('(h) switch on, the week starts by country: New York and Israel on Sunday, London on Monday, Cairo on Saturday', async () => {
    const day = (d: Date, tz: string) => formatInTimeZone(d, tz, 'EEE d');
    /** /week's last day and /nextweek's days, from Tuesday noon on the user's clock. */
    const weeks = async (u: UserConfig, tz: string) => {
      const tuesdayNoon = fromZonedTime('2026-10-13 12:00:00', tz);
      const week = await getWeekLookahead(u, calendars, tuesdayNoon);
      const next = await getNextWeekLookahead(u, calendars, tuesdayNoon);
      return `/week to ${day(week.dateRange.end, tz)}, /nextweek ${day(next.dateRange.start, tz)} to ${day(next.dateRange.end, tz)}`;
    };
    const got: string[] = [];
    for (const [name, u, tz] of [['New York', onNewYorker, NY], ['Israel', defaultIsraeli, IL], ['London', londoner, LONDON], ['Cairo', cairene, CAIRO]] as const) {
      rollout = 'OFF';
      const off = await weeks(u, tz);
      rollout = 'ALL';
      got.push(`${name}: on ${await weeks(u, tz)} | off ${off}`);
    }
    rollout = 'OFF';
    assertList(got, [
      'New York: on /week to Sat 17, /nextweek Sun 18 to Sat 24 | off /week to Sun 18, /nextweek Mon 19 to Sun 25',
      'Israel: on /week to Sat 17, /nextweek Sun 18 to Sat 24 | off /week to Sun 18, /nextweek Mon 19 to Sun 25',
      'London: on /week to Sun 18, /nextweek Mon 19 to Sun 25 | off /week to Sun 18, /nextweek Mon 19 to Sun 25',
      'Cairo: on /week to Fri 16, /nextweek Sat 17 to Fri 23 | off /week to Sun 18, /nextweek Mon 19 to Sun 25',
    ]);
  });

  await check('(h) switch on, no location and no Google token (tzKnown false): the week starts by language, en and he on Sunday, ru and anything else on Monday; off, Monday', async () => {
    const day = (d: Date) => formatInTimeZone(d, IL, 'EEE d');
    const thursdayNoon = fromZonedTime('2026-10-22 12:00:00', IL);
    const weeks = async (u: UserConfig) => {
      const week = await getWeekLookahead(u, nativeCalendars, thursdayNoon);
      const next = await getNextWeekLookahead(u, nativeCalendars, thursdayNoon);
      return `/week to ${day(week.dateRange.end)}, /nextweek ${day(next.dateRange.start)} to ${day(next.dateRange.end)}`;
    };
    const got: string[] = [];
    for (const u of placelessByLanguage) {
      rollout = 'OFF';
      const off = await weeks(u);
      rollout = 'ALL';
      got.push(`${u.language}: on ${await weeks(u)} | off ${off}`);
    }
    rollout = 'OFF';
    assertList(got, [
      'en: on /week to Sat 24, /nextweek Sun 25 to Sat 31 | off /week to Sun 25, /nextweek Mon 26 to Sun 1',
      'he: on /week to Sat 24, /nextweek Sun 25 to Sat 31 | off /week to Sun 25, /nextweek Mon 26 to Sun 1',
      'ru: on /week to Sun 25, /nextweek Mon 26 to Sun 1 | off /week to Sun 25, /nextweek Mon 26 to Sun 1',
      'fr: on /week to Sun 25, /nextweek Mon 26 to Sun 1 | off /week to Sun 25, /nextweek Mon 26 to Sun 1',
    ]);
  });

  await check('(h) switch on, New York /nextweek on Saturday evening is Sunday to Saturday, the coming Sunday included', async () => {
    const saturdayEvening = new Date('2026-10-17T19:00:00-04:00');
    rollout = 'ALL';
    googleCalls.length = 0;
    const lookahead = await getNextWeekLookahead(onNewYorker, calendars, saturdayEvening);
    rollout = 'OFF';
    const prompt = await promptFor(lookahead, onNewYorker, true);
    assert(rangeOf(prompt) === 'Sunday, Oct 18 to Saturday, Oct 24', `range ${rangeOf(prompt)}`);
    assert(googleCalls[0]?.timeMax === startOfLocalDay('2026-10-25', NY).toISOString(), `timeMax ${googleCalls[0]?.timeMax}`);
    // Saturday night's sleepover ends by 02:00, so it stays Saturday's; Gym is daily.
    assertList(daysOf(prompt), [
      'Sunday, Oct 18 - Tomorrow | 20:00 - Movie night (Family) | 22:00 - Late sleepover (Family)',
      'Monday, Oct 19 - In 2 days | 10:00 - Brunch (Family)',
      'Friday, Oct 23 - In 6 days | All day - Book fair (Family)',
    ]);
  });

  await check('(h) switch on: a dead token, missing permissions, an outage and a database error reach /week; off, Google\'s give an empty week as before', async () => {
    tokenErrors['token-dead'] = invalidGrant();
    listErrors['token-dead'] = invalidGrant();
    listErrors['token-scopes'] = insufficientScopes();
    listErrors['token-busy'] = rateLimited();
    /** What /week's lookahead does: its events, or its error (with the day it carries), then the lists it asked for by timeout. */
    const outcome = async (u: UserConfig, read?: DigestRead) => {
      googleCalls.length = 0;
      let result: string;
      try {
        const chosen = u.calendarSource === 'NATIVE' ? nativeCalendars : calendars;
        result = `${(await getWeekLookahead(u, chosen, ilTuesdayNight, read)).events.length} events`;
      } catch (err) {
        const carried = (err as { day?: string }).day;
        result = `${err instanceof Error ? err.message : String(err)}${carried ? ` (day ${carried})` : ''}`;
      }
      return `${result} | lists ${googleCalls.map(c => c.timeout ?? 'untimed').join(', ') || 'none'}`;
    };
    const quietWarn = console.warn;
    console.warn = () => undefined;
    const got: string[] = [];
    try {
      for (const setting of ['OFF', 'ALL'] as const) {
        rollout = setting;
        got.push(`${setting} dead token: ${await outcome(deadToken)}`);
        got.push(`${setting} missing permissions: ${await outcome(noScopes)}`);
        got.push(`${setting} rate limit: ${await outcome(rateLimitedUser)}`);
      }
      got.push(`ALL rate limit, scheduled: ${await outcome(rateLimitedUser, SCHEDULED_READ)}`);
      got.push(`ALL built-in calendar, database down: ${await outcome(brokenNative)}`);
    } finally {
      rollout = 'OFF';
      console.warn = quietWarn;
      for (const errors of [tokenErrors, listErrors]) for (const token of Object.keys(errors)) delete errors[token];
    }
    // Off, today's read asks each calendar and lets a failing one go. On, the token step
    // comes first; an outage gets one quick retry on demand (8,000 ms), none when scheduled.
    assertList(got, [
      'OFF dead token: 0 events | lists untimed',
      'OFF missing permissions: 0 events | lists untimed',
      'OFF rate limit: 0 events | lists untimed',
      'ALL dead token: GOOGLE_TOKEN_EXPIRED | lists none',
      'ALL missing permissions: GOOGLE_INSUFFICIENT_SCOPES | lists 9500',
      'ALL rate limit: GOOGLE_FETCH_FAILED (day 2026-10-13) | lists 9500, 7500',
      'ALL rate limit, scheduled: GOOGLE_FETCH_FAILED (day 2026-10-13) | lists 10000',
      "ALL built-in calendar, database down: Can't reach database server | lists none",
    ]);
  });

  let failed = 0;
```


- [ ] **Step 2: Write the failing smoke `scripts/smoke-week-commands.ts`**

Create the file with exactly this content:

```ts
// Smoke test for /week and /nextweek's answers to Google's failures (calendar home spec
// §3.1 step 5, Ruling R14): src/services/telegram/commands.ts. With the calendar home's
// switch on, the week reads through the shared reader, which throws GOOGLE_TOKEN_EXPIRED,
// GOOGLE_INSUFFICIENT_SCOPES or GOOGLE_FETCH_FAILED. Before, both commands sent those to
// the pipeline's "error fetching upcoming events" text and paged the admin per user.
// Now a dead token and missing permissions get the on-demand daily summary's answers
// (missing permissions also clear the token), and an outage gets "couldn't reach Google
// Calendar", as HTML like the daily's, into the open draft when there is one, with no
// admin notice. Anything else
// still gets the pipeline's text and the admin notice (A-28).
//
// Drives the real handleLookaheadCommand and handleNextWeekCommand through the real
// executeCommand and the real bot texts. The lookahead itself (what the reader throws is
// scripts/smoke-week-lookahead.ts's), the user lookup, the AI, delivery, voice, quota,
// analytics, the admin notifier and both messaging services are faked. No network.
//
// Run under both clocks:
//   TZ=UTC npx tsx scripts/smoke-week-commands.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-week-commands.ts

import Module from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MessageFormat, MessagingPlatform } from '../src/services/messaging/types';
import type { IMessagingService, MessageOptions, StreamMessageHandle } from '../src/services/messaging/types';
import type { UserConfig } from '../src/types';

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

function assertList(got: string[], want: string[]) {
  assert(JSON.stringify(got) === JSON.stringify(want), `\n     got  ${JSON.stringify(got, null, 1)}\n     want ${JSON.stringify(want, null, 1)}`);
}

/** Any request that slips past the fakes is refused and counted. */
const networkAttempts: string[] = [];
globalThis.fetch = (async (input: unknown) => {
  networkAttempts.push(String(input));
  throw new Error('network is blocked in this smoke test');
}) as typeof fetch;

const unhandled: unknown[] = [];
process.on('unhandledRejection', reason => { unhandled.push(reason); });

// ---- The bot's own texts, read from the message files the bot reads ----

type BotTexts = {
  errors: Record<string, string>;
  tokenExpired: { title: string; message: string };
  insufficientScopes: { title: string; message: string };
};
const ROOT = path.resolve(__dirname, '..');
const botTexts = (lang: string): BotTexts =>
  (JSON.parse(readFileSync(path.join(ROOT, 'messages', `${lang}.json`), 'utf8')) as { bot: BotTexts }).bot;
const EN = botTexts('en');
const HE = botTexts('he');
const TOKEN_TEXT = `${EN.tokenExpired.title}\n\n${EN.tokenExpired.message}`;
const SCOPES_TEXT = `${EN.insufficientScopes.title}\n\n${EN.insufficientScopes.message}`;

// ---- Fixtures ----

const TG_CHAT = 7021;
const WA_CHAT = '972500000021';

function makeUser(extra: Partial<UserConfig> = {}): UserConfig {
  return {
    id: 21, telegramId: TG_CHAT, name: 'Dana', englishName: 'Dana', gender: 'female', language: 'en', culture: 'jewish',
    location: 'Tel Aviv', isAdmin: true, suspendedAt: null, voiceSummaryEnabled: false,
    calendarSource: 'GOOGLE', googleRefreshToken: 'refresh-21',
    calendarAssignments: [{ calendarId: 'dana@example.com', labels: ['primary'], name: 'Dana', color: '#000' }],
    ...extra,
  } as unknown as UserConfig;
}
let user: UserConfig = makeUser();

// ---- Fakes ----

/** Everything the user is sent, in order, by service. */
let sent: string[] = [];
function makeService(platform: string): IMessagingService {
  return {
    sendMessage: async (chatId: number | string, text: string, options?: MessageOptions) => {
      sent.push(`${platform}.sendMessage ${chatId}${options?.format === MessageFormat.HTML ? ' html' : ''}: ${text}`);
      return 1;
    },
    sendTypingIndicator: async () => undefined,
  } as unknown as IMessagingService;
}
const telegram = makeService('telegram');
const whatsapp = makeService('whatsapp');

/** A streaming draft as execute-command opens one for /week on Telegram. */
function makeDraft(): StreamMessageHandle {
  return {
    pushStage: () => undefined,
    pushDelta: () => undefined,
    finalize: async (text: string) => {
      sent.push(`draft.finalize: ${text}`);
      return 1;
    },
    cancel: async (text: string, options?: MessageOptions) => {
      sent.push(`draft.cancel${options?.format === MessageFormat.HTML ? ' html' : ''}: ${text}`);
    },
  };
}

/** What the next lookahead throws; unset, it answers with one event. */
let lookaheadError: Error | undefined;
const lookaheadCalls: string[] = [];
const lookahead = (kind: string) => async () => {
  lookaheadCalls.push(kind);
  if (lookaheadError) throw lookaheadError;
  return { events: [{ summary: 'Book fair' }], dateRange: { start: new Date(), end: new Date() }, timezone: 'Asia/Jerusalem' };
};
const codeError = (code: string) => new Error(code);
const outage = () => Object.assign(new Error('GOOGLE_FETCH_FAILED'), { day: '2026-10-13' });

let adminWarnings: string[] = [];
let adminErrors: string[] = [];
let tokensCleared: string[] = [];
let deliveries: string[] = [];

const SRC = path.join(ROOT, 'src');
const stubs: Record<string, Record<string, unknown>> = {
  [`${SRC}/services/user-service.ts`]: {
    getUserByIdentifier: async () => user,
    getUserByTelegramId: async () => user,
    getOrCreateUser: async () => user,
    clearGoogleRefreshToken: async (telegramId: number | bigint) => { tokensCleared.push(String(telegramId)); },
  },
  [`${SRC}/services/messaging/index.ts`]: {
    MessagingPlatform, MessageFormat,
    getMessagingService: (platform: MessagingPlatform) => (platform === MessagingPlatform.WHATSAPP ? whatsapp : telegram),
  },
  [`${SRC}/services/telegram/bot.ts`]: { getMessagingService: () => telegram },
  [`${SRC}/services/telegram/voice.ts`]: { sendVoiceMessage: async () => undefined, sendWeeklyVoiceMessage: async () => undefined },
  [`${SRC}/services/telegram/summary.ts`]: {
    sendDailySummaryToUser: async () => undefined,
    sendTomorrowSummaryToUser: async () => undefined,
    routeTextMessage: async (_chatId: unknown, text: string) => { deliveries.push(text); },
  },
  [`${SRC}/services/analytics-service.ts`]: { trackActivityAsync: () => undefined, addBreadcrumb: () => undefined },
  [`${SRC}/services/subscription-service.ts`]: { checkFeatureAccess: async () => ({ allowed: true }), incrementUsage: async () => undefined },
  [`${SRC}/lib/error-capture.ts`]: { captureError: () => undefined, captureWarning: () => undefined, captureInfo: () => undefined },
  [`${SRC}/utils/prisma.ts`]: { prisma: {} },
  [`${SRC}/utils/redis.ts`]: { redis: { get: async () => null, set: async () => 'OK', del: async () => 0 } },
  [`${SRC}/services/magic-link.ts`]: { generateMagicLink: async () => 'https://famcal.test/magic' },
  [`${SRC}/utils/error-notifier.ts`]: {
    notifyAdminWarning: async (title: string, message: string) => { adminWarnings.push(`${title}: ${message}`); },
    notifyAdminError: async (commandName: string) => { adminErrors.push(commandName); },
  },
  [`${SRC}/services/week-lookahead.ts`]: {
    getWeekLookahead: lookahead('week'),
    getNextWeekLookahead: lookahead('nextweek'),
  },
  [`${SRC}/services/calendar-provider/index.ts`]: { getCalendarAssignmentsForUser: async (u: UserConfig) => u.calendarAssignments ?? [] },
  [`${SRC}/services/claude.ts`]: {
    generateWeekLookahead: async () => 'This week: the book fair on Friday.',
    generateNextWeekSummary: async () => 'Next week: the book fair on Friday.',
  },
};

// Static imports compile to require() and pass through Module._load.
const ModuleInternals = Module as unknown as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  _resolveFilename: (request: string, parent: unknown, isMain: boolean) => string;
};
const resolveFilename = ModuleInternals._resolveFilename;
ModuleInternals._resolveFilename = function (request, parent, isMain) {
  // @hebcal/core is ESM-only and tsx loads src/ as CommonJS (see smoke-week-lookahead.ts).
  if (request === '@hebcal/core') return path.join(ROOT, 'node_modules/@hebcal/core/dist/esm/index.js');
  return resolveFilename.call(this, request, parent, isMain);
};
const realLoad = ModuleInternals._load;
ModuleInternals._load = function (request, parent, isMain) {
  let resolved = request;
  try {
    resolved = ModuleInternals._resolveFilename(request, parent, isMain);
  } catch {}
  return stubs[resolved] ?? realLoad.call(this, request, parent, isMain);
};
// commands.ts loads the lookahead, the AI, the calendars, the magic link and the notifier
// with import(), which goes through the ES module loader instead; it gets the same stub.
(globalThis as { weekSmokeStubs?: typeof stubs }).weekSmokeStubs = stubs;
Module.registerHooks({
  load(url, context, nextLoad) {
    const file = url.startsWith('file:') ? fileURLToPath(url.split('?')[0]) : '';
    const stub = stubs[file];
    if (!stub) return nextLoad(url, context);
    const names = Object.keys(stub).map(name => `export const ${name} = fake[${JSON.stringify(name)}];`).join('\n');
    return { format: 'module', shortCircuit: true, source: `const fake = globalThis.weekSmokeStubs[${JSON.stringify(file)}];\n${names}\n` };
  },
});

// ---- Running one command ----

type Command = 'week' | 'nextweek';

async function run(command: Command, opts: { error?: Error; platform?: MessagingPlatform; draft?: boolean; user?: UserConfig } = {}) {
  const { handleLookaheadCommand, handleNextWeekCommand } = await import('../src/services/telegram/commands');
  sent = [];
  adminWarnings = [];
  adminErrors = [];
  tokensCleared = [];
  deliveries = [];
  lookaheadCalls.length = 0;
  lookaheadError = opts.error;
  user = opts.user ?? makeUser();
  const platform = opts.platform ?? MessagingPlatform.TELEGRAM;
  const chatId = platform === MessagingPlatform.WHATSAPP ? WA_CHAT : TG_CHAT;
  const handler = command === 'week' ? handleLookaheadCommand : handleNextWeekCommand;
  await handler(chatId, chatId, platform, opts.draft ? makeDraft() : undefined);
  assertList(lookaheadCalls, [command]);
}

/** What one run left behind, one line per kind. */
const outcome = () => [
  ...sent,
  `admin warnings: ${adminWarnings.join(' | ') || 'none'}`,
  `admin errors: ${adminErrors.join(' | ') || 'none'}`,
  `tokens cleared: ${tokensCleared.join(', ') || 'none'}`,
];

async function main() {
  // The pipeline logs each error it handles; those lines are expected.
  const realError = console.error;
  console.error = () => undefined;

  await check('a week that loads is delivered as before, /week and /nextweek', async () => {
    await run('week', { draft: true });
    const week = [...deliveries, ...outcome()];
    await run('nextweek');
    assertList([...week, ...deliveries, ...outcome()], [
      'This week: the book fair on Friday.', 'admin warnings: none', 'admin errors: none', 'tokens cleared: none',
      'Next week: the book fair on Friday.', 'admin warnings: none', 'admin errors: none', 'tokens cleared: none',
    ]);
  });

  await check('/week, a dead token: the daily summary\'s token text and admin warning, no admin error', async () => {
    await run('week', { error: codeError('GOOGLE_TOKEN_EXPIRED') });
    assertList(outcome(), [
      `telegram.sendMessage ${TG_CHAT} html: ${TOKEN_TEXT}`,
      'admin warnings: Token Expired: User 21 needs to refresh their Google Calendar token',
      'admin errors: none',
      'tokens cleared: none',
    ]);
  });

  await check('/week, missing permissions: the permissions text, the token cleared by Telegram id, an admin warning', async () => {
    await run('week', { error: codeError('GOOGLE_INSUFFICIENT_SCOPES') });
    const telegramUser = outcome();
    // A WhatsApp-only user has no Telegram id to clear by, as in the daily summary.
    await run('week', { error: codeError('GOOGLE_INSUFFICIENT_SCOPES'), platform: MessagingPlatform.WHATSAPP, user: makeUser({ telegramId: null }) });
    const warning = 'admin warnings: Insufficient Scopes: User 21 has a token with insufficient scopes. Token cleared, awaiting re-authorization.';
    assertList([...telegramUser, ...outcome()], [
      `telegram.sendMessage ${TG_CHAT} html: ${SCOPES_TEXT}`, warning, 'admin errors: none', `tokens cleared: ${TG_CHAT}`,
      `whatsapp.sendMessage ${WA_CHAT} html: ${SCOPES_TEXT}`, warning, 'admin errors: none', 'tokens cleared: none',
    ]);
  });

  await check('/week, Google unreachable: "couldn\'t reach Google Calendar" in the user\'s language, as HTML, into the draft or as a message, no admin notice', async () => {
    assert(typeof EN.errors.googleUnreachable === 'string' && EN.errors.googleUnreachable.length > 0, 'bot.errors.googleUnreachable is missing in en.json');
    assert(typeof HE.errors.googleUnreachable === 'string' && HE.errors.googleUnreachable !== EN.errors.googleUnreachable, 'bot.errors.googleUnreachable is not translated in he.json');
    // It goes out as HTML here and from the daily summary alike, so no language may hold a raw & or <.
    const unsafe = ['en', 'he', 'ru'].filter(lang => /[&<>]/.test(botTexts(lang).errors.googleUnreachable));
    assert(unsafe.length === 0, `bot.errors.googleUnreachable is not HTML-safe in ${unsafe.join(', ')}`);
    await run('week', { error: outage(), draft: true });
    const draft = outcome();
    await run('week', { error: outage(), platform: MessagingPlatform.WHATSAPP, user: makeUser({ language: 'he' }) });
    assertList([...draft, ...outcome()], [
      `draft.cancel html: ${EN.errors.googleUnreachable}`, 'admin warnings: none', 'admin errors: none', 'tokens cleared: none',
      `whatsapp.sendMessage ${WA_CHAT} html: ${HE.errors.googleUnreachable}`, 'admin warnings: none', 'admin errors: none', 'tokens cleared: none',
    ]);
  });

  await check('/nextweek: the same three answers', async () => {
    const got: string[] = [];
    for (const error of [codeError('GOOGLE_TOKEN_EXPIRED'), codeError('GOOGLE_INSUFFICIENT_SCOPES'), outage()]) {
      await run('nextweek', { error });
      got.push(...outcome());
    }
    assertList(got, [
      `telegram.sendMessage ${TG_CHAT} html: ${TOKEN_TEXT}`,
      'admin warnings: Token Expired: User 21 needs to refresh their Google Calendar token', 'admin errors: none', 'tokens cleared: none',
      `telegram.sendMessage ${TG_CHAT} html: ${SCOPES_TEXT}`,
      'admin warnings: Insufficient Scopes: User 21 has a token with insufficient scopes. Token cleared, awaiting re-authorization.',
      'admin errors: none', `tokens cleared: ${TG_CHAT}`,
      `telegram.sendMessage ${TG_CHAT} html: ${EN.errors.googleUnreachable}`, 'admin warnings: none', 'admin errors: none', 'tokens cleared: none',
    ]);
  });

  await check('any other failure still gets the pipeline\'s text and the admin notice (A-28)', async () => {
    const dbDown = () => new Error("Can't reach database server");
    await run('week', { error: dbDown() });
    const week = outcome();
    await run('nextweek', { error: dbDown(), draft: true });
    assertList([...week, ...outcome()], [
      `telegram.sendMessage ${TG_CHAT}: ${EN.errors.lookaheadFetch}`, 'admin warnings: none', 'admin errors: Lookahead Command', 'tokens cleared: none',
      `draft.cancel: ${EN.errors.nextWeekFetch}`, 'admin warnings: none', 'admin errors: Next Week Command', 'tokens cleared: none',
    ]);
  });

  console.error = realError;

  await check('no network, no unhandled rejection', () => {
    assert(networkAttempts.length === 0, `network: ${networkAttempts.join(', ')}`);
    assert(unhandled.length === 0, `unhandled: ${unhandled.map(String).join(' | ')}`);
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

- [ ] **Step 3: Run both smokes and see them fail; record the regression baseline**

```bash
cd /Users/razielgershoni/development/famcalbot
for tz in UTC Asia/Jerusalem Pacific/Kiritimati; do TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-week-lookahead.ts; echo "exit $?"; done
for tz in UTC Asia/Jerusalem; do TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-week-commands.ts; echo "exit $?"; done
```

Expected for `smoke-week-lookahead`, under each clock: `35/42 passed (process TZ=…)`, then `exit 1`. The 35 checks of (a)–(g) pass. The two `[Upstash Redis]` lines at the top come from the fake env, as before. The seven (h) checks fail:
- `FAIL  (h) with the switch off, (a)-(g) asked the switch and read as before: no token step, no reader read — no lookahead asked the switch`
- `FAIL  (h) switch on, Israel: …`: the prompts are equal, because it is still today's read, but it got `"switch asked for "`, `"token steps "`, `"calendars.get 2"`. It also got two lists ending `…T20:59:59.999Z` with `timeout undefined, fields undefined`, where it wants `switch asked for 1, 1`, `token steps token-il, token-il`, `calendars.get 0` and two lists ending at the exclusive midnight with `timeout 9500, the reader's fields`.
- `FAIL  (h) switch on, built-in calendar: …`: the lists are equal, but `got  []` for the reader's reads, where it wants `7 fam1 2026-10-13T06:00:00.000Z 2026-10-17T21:00:00.000Z` and `7 fam1 2026-10-17T21:00:00.000Z 2026-10-24T21:00:00.000Z`.
- `FAIL  (h) switch on, the week starts by country: …`: every `on` line reads `/week to Sun 18, /nextweek Mon 19 to Sun 25`.
- `FAIL  (h) switch on, no location and no Google token (tzKnown false): …`: every `on` line reads `/week to Sun 25, /nextweek Mon 26 to Sun 1`.
- `FAIL  (h) switch on, New York /nextweek on Saturday evening is Sunday to Saturday, the coming Sunday included — range Monday, Oct 19 to Sunday, Oct 25`
- `FAIL  (h) switch on: a dead token, …`: every `ALL` line reads `0 events | lists untimed`, and the database line reads `1 events | lists none`.

Expected for `smoke-week-commands`, under each clock: `3/7 passed`, then `exit 1`. These pass:
- `a week that loads is delivered as before, /week and /nextweek`;
- `any other failure still gets the pipeline's text and the admin notice (A-28)`;
- `no network, no unhandled rejection`.

These four fail. Each got the pipeline's answer, the `lookaheadFetch` (or `nextWeekFetch`) text and `admin errors: Lookahead Command` (or `Next Week Command`):
- `/week, a dead token: …`;
- `/week, missing permissions: …`;
- `/week, Google unreachable: …` (for the Hebrew run, in Hebrew; R13's text is HTML-safe in all three files already);
- `/nextweek: the same three answers`.

Don't run `tsc` yet: `getWeekLookahead` takes no fourth argument until Step 4. `tsx` doesn't type-check, so the smokes run.

Record the regression baseline: every line's count, to compare in Step 7.

```bash
cd /Users/razielgershoni/development/famcalbot
for tz in UTC Asia/Jerusalem; do for s in smoke-partner-labels smoke-native-reminder-digest smoke-weather-command smoke-google-connect smoke-locale-rules smoke-reminders smoke-native-provider-reminders; do out=$(TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/$s.ts 2>&1); code=$?; echo "$tz $s exit $code :: $(echo "$out" | grep -aE '[0-9]+/[0-9]+ passed' | tail -1)"; done; done
```

Expected: 14 lines, each `exit 0`: `smoke-partner-labels` 19/19, `smoke-native-reminder-digest` 33/33, `smoke-weather-command` 10/10, `smoke-google-connect` 30/30, `smoke-locale-rules` 19/19 (on Node 22 its Intl check prints SKIP), `smoke-reminders` 23/23, `smoke-native-provider-reminders` 11/11.

- [ ] **Step 4: Move `src/services/week-lookahead.ts` onto the reader and B2's week boundaries**

Eight edits, in file order. Line numbers are those of the file at 716a4f8 (547 lines).

Edit 4a, the imports (lines 8-9). Before:
```ts
import { getProviderForUser } from './calendar-provider';
import { getNativeSeriesRrule } from './native-calendar/event-store';
```
After:
```ts
import { getProviderForUser } from './calendar-provider';
import { DEFAULT_ON_DEMAND_READ, readLookaheadEvents, type DigestRead } from './calendar-read/digest';
import { isCalendarHomeOn } from './calendar-read/rollout';
import { getNativeSeriesRrule } from './native-calendar/event-store';
```

Edit 4b, the day helpers and the week-start rule (lines 19-20); `addDaysToDate` is no longer used here. Before:
```ts
import { addDaysToDate, daySpanOf, localDate, nextDate, startOfLocalDay } from '../utils/day-events';
import { resolveUserTimezone } from '../lib/timezone';
```
After:
```ts
import { daySpanOf, localDate, nextDate, startOfLocalDay } from '../utils/day-events';
import { legacyWeekStart, nextWeekBoundaries, nextWeekBoundary, tzKnownFor, weekStartFor, type WeekStart } from '../utils/locale-rules';
import { resolveUserTimezone } from '../lib/timezone';
```

Edit 4c, `weekdayOf` and `getNextWeekBoundary` (lines 72-110) give way to `weekStartOf`; `endOfLocalDay` stays. Before:
```ts
/** Day of the week of yyyy-MM-dd, 0 = Sunday. */
function weekdayOf(day: string): number {
  return new Date(`${day}T00:00:00Z`).getUTCDay();
}

/** The last instant of yyyy-MM-dd in `timezone`. */
function endOfLocalDay(day: string, timezone: string): Date {
  return new Date(startOfLocalDay(nextDate(day), timezone).getTime() - 1);
}

/**
 * Get the last day of the week based on user settings, as yyyy-MM-dd
 * - If lookaheadAlways7Days: always 7 days from reference date
 * - Jewish culture: through Saturday (week ends Saturday, Sunday is next week)
 * - Default culture: through Sunday (week ends Sunday, Monday is next week)
 * @param culture - User's culture setting
 * @param always7Days - Whether to always show 7 days
 * @param today - The reference day in the user's timezone
 */
function getNextWeekBoundary(culture: string | undefined, always7Days: boolean | undefined, today: string): string {
  let daysUntilBoundary: number;

  if (always7Days) {
    // Always 7 days
    daysUntilBoundary = 7;
  } else {
    const dayOfWeek = weekdayOf(today); // 0=Sun, 1=Mon, ...

    if (culture === 'jewish') {
      // Through Saturday (dayOfWeek 6) - Sunday is already next week
      daysUntilBoundary = (6 - dayOfWeek + 7) % 7;
    } else {
      // Through Sunday (dayOfWeek 0) - Monday is next week
      daysUntilBoundary = (7 - dayOfWeek) % 7;
    }
  }

  return addDaysToDate(today, daysUntilBoundary);
}
```
After:
```ts
/** The last instant of yyyy-MM-dd in `timezone`. */
function endOfLocalDay(day: string, timezone: string): Date {
  return new Date(startOfLocalDay(nextDate(day), timezone).getTime() - 1);
}

/**
 * The first day of the user's week (0 = Sunday), which sets This week's last day and Next
 * week's days. With the calendar home on (spec §6): Sunday for Jewish culture, else the
 * country of the user's own timezone (from their location or Google), else the language.
 * Otherwise today's rule: Sunday for Jewish culture, Monday for everyone else.
 */
function weekStartOf(user: UserConfig, timezone: string, homeOn: boolean): WeekStart {
  return homeOn
    ? weekStartFor({ culture: user.culture, language: user.language, tz: timezone, tzKnown: tzKnownFor(user) })
    : legacyWeekStart(user.culture);
}
```

Edit 4d, `fetchEventsInRange` (lines 244-253) reads through the reader when the switch is on. Before:
```ts
/**
 * Fetch events for date range from all assigned calendars
 */
async function fetchEventsInRange(
  user: UserConfig,
  calendarIds: string[],
  start: Date,
  end: Date,
  timezone: string
): Promise<CalendarEvent[]> {
```
After:
```ts
/**
 * Fetch events for date range from all assigned calendars. With the calendar home on,
 * the shared reader (spec §3.1): the user's own source over [start, the end of the last
 * day), Google's clean-up, and Google's failures thrown for the command to answer.
 */
async function fetchEventsInRange(
  user: UserConfig,
  calendarIds: string[],
  start: Date,
  end: Date,
  timezone: string,
  homeOn: boolean,
  read: DigestRead
): Promise<CalendarEvent[]> {
  if (homeOn) return readLookaheadEvents(user, start, end, timezone, calendarIds, read);

```

Edit 4e, `getWeekLookahead`'s signature and week boundary (lines 404-415). Before:
```ts
 * @param referenceDate - The date to calculate lookahead from (defaults to now, use tomorrow for tomorrow's summary)
 */
export async function getWeekLookahead(
  user: UserConfig,
  calendars: CalendarAssignment[],
  referenceDate?: Date
): Promise<WeekLookahead> {
  const startDate = referenceDate || new Date();
  // The week is made of the user's days, from the reference day to the end of the last.
  const timezone = await resolveUserTimezone(user);
  const today = localDate(startDate, timezone);
  const lastDay = getNextWeekBoundary(user.culture, user.lookaheadAlways7Days, today);
```
After:
```ts
 * @param referenceDate - The date to calculate lookahead from (defaults to now, use tomorrow for tomorrow's summary)
 * @param read - With the calendar home on, the read's mode and deadline (defaults to on demand)
 */
export async function getWeekLookahead(
  user: UserConfig,
  calendars: CalendarAssignment[],
  referenceDate?: Date,
  read: DigestRead = DEFAULT_ON_DEMAND_READ
): Promise<WeekLookahead> {
  const startDate = referenceDate || new Date();
  // The week is made of the user's days, from the reference day to the end of the last.
  const timezone = await resolveUserTimezone(user);
  // Asked once: the switch decides both the week's days and the read.
  const homeOn = await isCalendarHomeOn(user);
  const today = localDate(startDate, timezone);
  const lastDay = nextWeekBoundary(weekStartOf(user, timezone, homeOn), user.lookaheadAlways7Days, today);
```

Edit 4f, `getWeekLookahead`'s fetch (lines 426-432). Before:
```ts
  const events = await fetchEventsInRange(
    user,
    calendarIds,
    startDate,
    endDate,
    timezone
  );
```
After:
```ts
  const events = await fetchEventsInRange(
    user,
    calendarIds,
    startDate,
    endDate,
    timezone,
    homeOn,
    read
  );
```

Edit 4g, `getNextWeekBoundaries` (lines 476-499) goes, and `getNextWeekLookahead`'s signature and boundaries (lines 501-515). Before:
```ts
/**
 * Get next week's first and last days (yyyy-MM-dd) based on culture
 * - Jewish: Sunday to Saturday
 * - Default: Monday to Sunday
 * @param culture - User's culture setting
 * @param today - The reference day in the user's timezone
 */
function getNextWeekBoundaries(culture: string | undefined, today: string): { first: string; last: string } {
  const dayOfWeek = weekdayOf(today); // 0=Sun, 1=Mon, ...

  let daysUntilNextWeekStart: number;
  const weekLength: number = 7;

  if (culture === 'jewish') {
    // Next Sunday (start of next week for Jewish)
    daysUntilNextWeekStart = (7 - dayOfWeek) % 7 || 7;
  } else {
    // Next Monday (start of next week for default)
    daysUntilNextWeekStart = ((8 - dayOfWeek) % 7) || 7;
  }

  const first = addDaysToDate(today, daysUntilNextWeekStart);
  return { first, last: addDaysToDate(first, weekLength - 1) };
}

/**
 * Get next week lookahead with notable events
 * @param user - User configuration
 * @param calendars - Calendar assignments
 * @param referenceDate - The date to calculate from (defaults to now)
 */
export async function getNextWeekLookahead(
  user: UserConfig,
  calendars: CalendarAssignment[],
  referenceDate?: Date
): Promise<WeekLookahead> {
  // Next week's days run from the user's midnight to the end of their last day.
  const timezone = await resolveUserTimezone(user);
  const today = localDate(referenceDate || new Date(), timezone);
  const { first, last } = getNextWeekBoundaries(user.culture, today);
```
After:
```ts
/**
 * Get next week lookahead with notable events
 * @param user - User configuration
 * @param calendars - Calendar assignments
 * @param referenceDate - The date to calculate from (defaults to now)
 * @param read - With the calendar home on, the read's mode and deadline (defaults to on demand)
 */
export async function getNextWeekLookahead(
  user: UserConfig,
  calendars: CalendarAssignment[],
  referenceDate?: Date,
  read: DigestRead = DEFAULT_ON_DEMAND_READ
): Promise<WeekLookahead> {
  // Next week's days run from the user's midnight to the end of their last day.
  const timezone = await resolveUserTimezone(user);
  // Asked once: the switch decides both the week's days and the read.
  const homeOn = await isCalendarHomeOn(user);
  const today = localDate(referenceDate || new Date(), timezone);
  const { first, last } = nextWeekBoundaries(weekStartOf(user, timezone, homeOn), today);
```

Edit 4h, `getNextWeekLookahead`'s fetch (lines 527-533). Before:
```ts
  const events = await fetchEventsInRange(
    user,
    calendarIds,
    start,
    end,
    timezone
  );
```
After:
```ts
  const events = await fetchEventsInRange(
    user,
    calendarIds,
    start,
    end,
    timezone,
    homeOn,
    read
  );
```


- [ ] **Step 5: Pass the summary's read to the week block in `src/services/telegram/summary.ts`**

One line, in the tomorrow summary's week block (line 153 at 716a4f8). C3 adds `opts` to `prepareSummaryForUser` and leaves this line as it is. If C3 moved it, match on the quoted text, which is unique in the file.

Edit 5a, the week block's call (line 153). Before:
```ts
      const lookahead = await getWeekLookahead(user, assignments, dayNoon);
```
After:
```ts
      const lookahead = await getWeekLookahead(user, assignments, dayNoon, opts?.read);
```


- [ ] **Step 6: Answer Google's failures on `/week` and `/nextweek` in `src/services/telegram/commands.ts`**

Four edits, in file order. Line numbers are those of the file at 716a4f8.

Edit 6a, the imports (lines 7-10). Before:
```ts
import { getUserByTelegramId, getUserByIdentifier, getOrCreateUser, TelegramUserInfo } from '../user-service';
import { MessagingPlatform, MessageFormat, IMessagingService } from '../messaging';
import { getMessagingService as getMessagingServiceByPlatform } from '../messaging';
import type { StreamMessageHandle } from '../messaging/types';
```
After:
```ts
import { getUserByTelegramId, getUserByIdentifier, getOrCreateUser, clearGoogleRefreshToken, TelegramUserInfo } from '../user-service';
import { MessagingPlatform, MessageFormat, IMessagingService } from '../messaging';
import { getMessagingService as getMessagingServiceByPlatform } from '../messaging';
import type { StreamMessageHandle } from '../messaging/types';
import type { UserConfig } from '../../types';
```

Edit 6b, `answerWeekError`, before the `/lookahead` handler (lines 495-498). Before:
```ts
/**
 * Handle /lookahead command
 * Displays notable upcoming events for the week
 */
```
After:
```ts
/**
 * /week's and /nextweek's answers to Google's failures (spec §3.1 step 5, Ruling R14).
 * With the calendar home on, the week reads through the shared reader, which throws them:
 * - a dead token or missing permissions get the on-demand daily summary's answers, and
 *   missing permissions clear the token, as there;
 * - an outage, after the reader's quick retry, gets "couldn't reach Google Calendar",
 *   with no admin notice.
 * Anything else falls through to the pipeline's error text and admin notice. Today's read
 * (switch off) never throws these: it skips a calendar that fails.
 */
async function answerWeekError(
  error: Error,
  ctx: {
    chatId: number | string;
    user: UserConfig;
    userLanguage: string;
    messagingService: IMessagingService;
    streamHandle?: StreamMessageHandle;
  }
): Promise<boolean> {
  const { chatId, user, userLanguage, messagingService, streamHandle } = ctx;

  if (error.message === 'GOOGLE_INSUFFICIENT_SCOPES') {
    const t = await getBotMessages(userLanguage);
    const scopesMessage = `${t.insufficientScopes.title}\n\n${t.insufficientScopes.message}`;
    await messagingService.sendMessage(chatId, scopesMessage, {
      format: MessageFormat.HTML
    });

    if (user.telegramId) {
      await clearGoogleRefreshToken(BigInt(user.telegramId));
    }

    const { notifyAdminWarning } = await import('../../utils/error-notifier');
    await notifyAdminWarning(
      'Insufficient Scopes',
      `User ${user.id} has a token with insufficient scopes. Token cleared, awaiting re-authorization.`
    );
    return true;
  }

  if (error.message === 'GOOGLE_TOKEN_EXPIRED') {
    const t = await getBotMessages(userLanguage);
    const expiredMessage = `${t.tokenExpired.title}\n\n${t.tokenExpired.message}`;
    await messagingService.sendMessage(chatId, expiredMessage, {
      format: MessageFormat.HTML
    });

    const { notifyAdminWarning } = await import('../../utils/error-notifier');
    await notifyAdminWarning(
      'Token Expired',
      `User ${user.id} needs to refresh their Google Calendar token`
    );
    return true;
  }

  if (error.message === 'GOOGLE_FETCH_FAILED') {
    const t = await getBotMessages(userLanguage);
    const unreachable: string = t.errors.googleUnreachable;
    // An open draft collapses into the answer, as the pipeline's own error texts do. HTML,
    // as the daily summary sends this text and as the answers above are sent.
    if (streamHandle) {
      await streamHandle.cancel(unreachable, { format: MessageFormat.HTML });
    } else {
      await messagingService.sendMessage(chatId, unreachable, { format: MessageFormat.HTML });
    }
    return true;
  }

  return false;
}

/**
 * Handle /lookahead command
 * Displays notable upcoming events for the week
 */
```

Edit 6c, `/week`'s pipeline gets the `onError` (lines 589-595). Before:
```ts
        sendWeeklyVoiceMessage(chatId, formattedLookahead, user, false, undefined, platform).catch(err =>
          console.error(`[Lookahead] Voice generation failed for user ${userId}:`, err)
        );
      }
    },
  });
}
```
After:
```ts
        sendWeeklyVoiceMessage(chatId, formattedLookahead, user, false, undefined, platform).catch(err =>
          console.error(`[Lookahead] Voice generation failed for user ${userId}:`, err)
        );
      }
    },
    onError: (error) => answerWeekError(error, { chatId, user, userLanguage, messagingService, streamHandle }),
  });
}
```

Edit 6d, `/nextweek`'s pipeline gets the same `onError` (lines 690-696). Before:
```ts
        sendWeeklyVoiceMessage(chatId, formattedSummary, user, true, undefined, platform).catch(err =>
          console.error(`[NextWeek] Voice generation failed for user ${userId}:`, err)
        );
      }
    },
  });
}
```
After:
```ts
        sendWeeklyVoiceMessage(chatId, formattedSummary, user, true, undefined, platform).catch(err =>
          console.error(`[NextWeek] Voice generation failed for user ${userId}:`, err)
        );
      }
    },
    onError: (error) => answerWeekError(error, { chatId, user, userLanguage, messagingService, streamHandle }),
  });
}
```


- [ ] **Step 7: Run both smokes under each clock, and the regression smokes**

```bash
cd /Users/razielgershoni/development/famcalbot
for tz in UTC Asia/Jerusalem Pacific/Kiritimati; do TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-week-lookahead.ts; echo "exit $?"; done
for tz in UTC Asia/Jerusalem; do TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-week-commands.ts; echo "exit $?"; done
```

Expected:
- `smoke-week-lookahead`: 42 `OK` lines, `42/42 passed (process TZ=UTC)` (likewise `Asia/Jerusalem` and `Pacific/Kiritimati`), then `exit 0`, in about 3 s.
- `smoke-week-commands`: 7 `OK` lines, `7/7 passed`, then `exit 0`, under each clock.

Then run Step 3's regression loop again. Expected: the same lines as in Step 3, every one `exit 0`. Their OK lines are identical. `smoke-partner-labels` now also prints two `[calendar-home-rollout]` warnings at the top: its Redis stub has no `get` and its Prisma stub no `adminSettings`, so the switch reads `OFF`, as B1 intends when both stores fail. In the scratch copy the whole suite was also run under `TZ=UTC` and `TZ=Asia/Jerusalem`: 51 smokes before this task, 52 after, every run `exit 0`. Only `smoke-week-lookahead` changed count (35 → 42), and `smoke-week-commands` is new (7/7). Re-run for the review patch on the real C1-C4: the same, and `smoke-digest-adapters`, `smoke-summary-prompt-parity`, `smoke-summary-seam`, `smoke-summary-retry` and `smoke-calendar-read-google-cancel` printed the same lines before and after this task. Both smokes also pass on Node 22.23.3, the production engine.

Mutations the checks catch, on this code (try one, then revert):
- `/nextweek` without its `onError`: `smoke-week-commands` 6/7, only `/nextweek: the same three answers`;
- R13's text always sent with `sendMessage`, ignoring an open draft: 6/7, only `/week, Google unreachable: …`;
- R13's text sent with no format (the pre-review draft): 5/7, `/week, Google unreachable: …` and `/nextweek: …`;
- missing permissions clearing the token by `BigInt(user.id)`, also for a WhatsApp-only user: 5/7, `/week, missing permissions: …` and `/nextweek: …`;
- `fetchEventsInRange` handing the reader `DEFAULT_ON_DEMAND_READ` in place of `read`: `smoke-week-lookahead` 41/42, only the errors check (the scheduled line gets `9500, 7500`);
- `fetchEventsInRange` asking `await isCalendarHomeOn(user)` again in place of `homeOn`: 41/42, only `(h) switch on, Israel: …` (`switch asked for 1, 1, 1, 1`);
- `weekStartOf` always on `legacyWeekStart`: 39/42, the country check, the language check and New York's `/nextweek`;
- `tzKnown: false` in `weekStartOf`: 41/42, only the country check (London and Cairo fall to the language rule, Sunday);
- `tzKnown: true` in `weekStartOf`: 41/42, only the language check (`ru` and `fr` get Israel's Sunday).

- [ ] **Step 8: Type-check and lint**

```bash
cd /Users/razielgershoni/development/famcalbot
npx tsc --noEmit -p .; echo "tsc=$?"
npm run -s lint; echo "lint=$?"
```

Expected: `tsc=0` and `lint=0`, with no output from either. `tsc` also checks `scripts/**`, so both smokes are type-checked here. That includes the `getWeekLookahead(u, chosen, ilTuesdayNight, read)` call and the `DigestRead` type import.

- [ ] **Step 9: Commit**

```bash
cd /Users/razielgershoni/development/famcalbot
git add src/services/week-lookahead.ts src/services/telegram/summary.ts src/services/telegram/commands.ts scripts/smoke-week-lookahead.ts scripts/smoke-week-commands.ts
git commit -m "$(cat <<'MSG'
feat(week): /week, /nextweek and the week block read through the calendar reader

For users the calendar home switch covers, the week lookahead reads
through the shared reader: the user's own calendars only, Google's
working-location blocks and declined invites dropped, no 250-item cut,
a deadline per read (on demand or scheduled, from the caller), and
Google's failures thrown instead of swallowed. Their weeks start by
country: Sunday in the US and Israel, Saturday in Egypt, Monday in the
UK; Jewish culture stays on Sunday.

/week and /nextweek now answer a dead token or missing permissions the
way the daily summary does, and a Google outage with "couldn't reach
Google Calendar", with no admin page. Before, all three said there was
nothing notable.

Users the switch doesn't cover keep today's reads, weeks and answers.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
MSG
)"
```

---

### Task 6 (C6): The parity smoke (spec §10, `smoke-digest-reader-parity.ts`), htmlToText's blocks, the PR section and the live check

> **Interface change versus the split: none.** C6 adds `scripts/smoke-digest-reader-parity.ts`. It calls only exports that exist once C1–C5 have landed: C3's new `prepareSummaryForUser`, `fetchTodayEvents` and `fetchTomorrowEvents` exports, C4's `__setScheduledRetrySleepForTests`, and the existing `sendDailySummaryToAll`, `sendDailySummaryToUser`, `sendTomorrowSummaryToAll`, `sendTomorrowSummaryToUser` and `getCalendarAssignmentsForUser`, plus `getWeekLookahead`, `getNextWeekLookahead` and `handleLookaheadCommand`, which C5 gives a `read` parameter. It does not read C2's prompt snapshot: C2's own smoke holds every prompt to `main@858886c`, and here the switch-off run is today's path.
>
> **Additions from the review of this plan:**
> - **One production change, the decision Plan B handed to C:** `htmlToText` (`src/utils/html.ts`, Plan B) makes headings, tables and their rows, lists, quotes, `pre`, `hr`, and `p` and `div` where they open, start and end a line, and sets table cells apart with a space. Before, `<h1>Agenda</h1><p>Budget</p>` became "AgendaBudget" in a covered user's prompt. Plan B's `smoke-google-map.ts` changes its "NotesAgenda" assertion to "Notes" and "Agenda" on two lines and gets one check of these blocks (44 → 45 on `feat/calendar-home`), and its 32,768-character timing check gets three block shapes (`<h1 `, `<td ` and `<p ` repeated). The spec's §2.5 item 8 says so (`docs/superpowers/specs/2026-10-16-calendar-home-design.md`).
> - **Five more checks in the parity smoke** (23 → 28): an Outlook/Teams HTML description, a week block that fails alone, an on-demand tomorrow summary near the 50 s limit and a quick retry answered too late for its request timeout, and a scheduled batch during a Google stall. The last three run on virtual time.
> - **Two closing steps:** the PR's section on what changes for whom (Step 9) and the live check after the switch goes to `ADMINS` (Step 10).

**What and why:** C1–C5 move the summaries onto the shared reader, each with its own smoke over fakes of its neighbours. Apart from C5's Israel `/week` prompt check, none of them runs the old read and the new read against the same data. This smoke does. It runs every flow twice, once with the rollout switch `OFF` (the providers, today's code) and once with it at `ADMINS` (the reader). Both runs go over one fake Google and one in-memory database, and the smoke holds them to spec §10's before/after list:
- **(a) Same events:** for every fixture user, timezone and clock, `shapeEventsForDay(provider read)` equals `shapeEventsForDay(readDigestDay)`.
  - FamCal users must match strictly.
  - For Google users the old side is normalized for the deliberate changes only: C1/C2 items removed, C3 descriptions through `htmlToText`, `reminders` deleted.
- **(b) Same prompts:** byte-identical prompts (AI stubbed) for a paired FamCal user with reminders and for a Google user with yours/spouse/kids/birthday calendars.
- **(c) `/week` and `/nextweek`:**
  - with `weekStartFor` stubbed to `legacyWeekStart`, the events are equal with the switch on;
  - with the real rule, New York and an Israeli default-culture user get Sunday–Saturday weeks, London Monday–Sunday and Cairo Saturday–Friday.
- **(d) Outcomes**, with recording fakes: a dead token, missing scopes, a rate limit (scheduled, on demand, `/week`), a fast 500 the quick retry gets past, a hanging token server, a scheduled retry that hits `invalid_grant`, a retry past local midnight, one calendar gone, every calendar gone.
- **(e) The batch doesn't wait:** three failing Google users and a FamCal user; and the same batch during a Google stall, where each first read runs to its 30 s deadline.
- **And from the review:** an Outlook/Teams HTML description keeps its words apart in the switch-on prompt (b); a week block that fails on its own degrades the tomorrow summary (d); an on-demand tomorrow summary whose two reads both need their quick retry, with a slow timezone lookup and a 20 s AI stream, still lands inside the 50 s limit (d).

Real code is used wherever the two paths could differ: `summary.ts`, `commands.ts`, the command pipeline, `week-lookahead.ts`, the digest adapters, `readRange` with both halves, `calendar.ts`, both providers, the event store, ownership, open reminders, `user-calendars`, the prompt builders, the bot texts and the summary scheduling. The rest is faked: Google's client library, the database, Redis, the switch, the timezone lookup, the users, the AI, the holiday lookup, Telegram, the voice note, quota, analytics, Sentry and the admin notifier.

Its red run is on the tree as C1–C5 left it: the Outlook check fails there ("AgendaBudgetJoinRoom 4"), which forces the `htmlToText` decision (Steps 4-5). The first pass's deliberately broken tree (C1's quick retry removed) is now a listed mutation: it fails five checks.

**Visible to users:** only users the switch covers, and only in a Google description with HTML blocks, which now reads with its line breaks (the home and the summaries). Nothing else is visible: the rest is a smoke, a spec line and the PR text.

**Findings that shaped the code:**
- **One fake Google for both paths.** The smoke replaces the `@googleapis/calendar` package itself: its `auth.OAuth2` class and its `calendar()` factory. So both Google paths run unchanged:
  - the old path: `calendar.ts`'s `fetchEvents` (`new auth.OAuth2`, `calendars.get` plus `events.list`), `week-lookahead.ts`'s old per-calendar loop, and `getMasterEventRecurrence` (`events.get`);
  - the new path: `calendar-read/google.ts`, which goes through `getGoogleAuth`, `getAccessToken` and `events.list`.

  The fake works like this:
  - It keys every call by the refresh token.
  - It filters by Google's documented rule (an event ends after `timeMin` and starts before `timeMax`).
  - It writes times in the zone the request asked for.
  - It returns a calendar's title both from `calendars.get` and as the list's top-level `summary`.
  - It ignores `fields` and `maxAttendees`, so the old read sees every attendee and the `reminders` field. That is why the declined invite and the normalization of `reminders` are exercised at all.
  - It records each call in order: `token`, `list` (window and request timeout), `get` and `master`.
- **One database for both paths.** An in-memory Prisma (B5's, from `smoke-calendar-read-famcal.ts`) runs the real event store, recurrence expansion, ownership, `user-calendars` and open reminders. It knows `AND`, `OR`, `in`, `not`, the comparisons, the `calendar` and `instances: { some }` relation filters, `select`, `include` and `orderBy`. So the provider's `[00:00, 23:59:59.999]` window and the reader's `[00:00, next 00:00)` window run the real overlap rule.
- **The `htmlToText` decision** (Plan B's carry-over, and the review's first Review Focus line). At 716a4f8 only `<br>` and the closing `</p>`, `</div>` and `</li>` break a line, and every other tag runs words together, the opening `<p>`, `<div>` and `<li>` included: `Hi<p>There` is "HiThere", `A<li>B` is "A• B", `<h1>Agenda</h1><p>Budget</p>` is "AgendaBudget", and so is an Outlook or Teams invite's table row ("<tr><td>Agenda</td><td>Budget</td></tr>"). The fix, in `htmlToPlain`:
  - Opening and closing `h1`–`h6`, `table`, `tr`, `ul`, `ol`, `blockquote` and `pre`, and opening `p`, `div` and `hr`, leave a block mark (`\u0001`). `</p>`, `</div>`, `</li>` and `<br>` stay the hard newlines they were.
  - Each run of spaces, tabs, newlines and block marks that holds a mark becomes as many newlines as it held, and at least one (`breakBlocks`). So the words on either side of a mark never run together, and a block adds a line break only where the run has none: `<p>Agenda:</p><ul><li>` is still "Agenda:" then "• …" on the next line, and every assertion of Plan B's smoke but "NotesAgenda" holds.
  - Two limits, which the reference below shares. Blocks inside a link still run together: `replaceLinks` runs first and keeps only the link's text, its tags stripped, so `<a href="https://x.y/j/1"><h1>Join</h1><p>Meeting</p></a>` is "JoinMeeting (https://x.y/j/1)", as at 716a4f8. And entities are decoded after this pass, so an encoded line break is text to it: `Agenda:&#10;<ul><li>Budget</li></ul>` gets a blank line, `'Agenda:\n\n• Budget'`, where 716a4f8 gives `'Agenda:\n• Budget'`.
  - `<li>` leaves a mark and a bullet placeholder (`\u0002`), which swallows the spaces and marks right after it, so `<li><p>First</p></li>` stays "• First" on one line. The placeholder becomes "• " last.
  - An opening `td` or `th` is a space. `thead` and `tbody`, opening or closing, and the closing `</td>` and `</th>` are stripped as before.
  - Any `\u0001` or `\u0002` in the input is dropped first. The new passes are linear. The `<li>`, block and cell passes go through `replaceTag`, as the `<br>` and tag passes do: each runs only on the text through the last `>`, and every match ends at a `>`, so an open with no `>` after it never reads to the end of the text again (the O(k·n) shape that 716a4f8 removed). The run pattern is one character class.
  - Both edits are written against `feat/calendar-home` at 716a4f8, where `htmlToPlain` is the linear version (`replaceTag`, and the `dropComments`, `dropBlocks` and `replaceLinks` loops). Edit 4a replaces the whole function; its `return` (entities, c1558c6's `trimLines`, blank lines, the ends) stays as it was. Checked against a reference, C6's rule written as one regex chain with c1558c6's `trimLines`: 2,000,000 fuzzed inputs (the block tokens, `\u0001` and `\u0002` in the grammar), every string in this smoke and the map smoke, every value the two smokes pass to `htmlToText`, and the review's counterexamples to the rule as first worded (the two limits above, the block closers) give the same output, with and without the cut: zero differences. On each 32,768-character shape of the map smoke, the three new ones included, `htmlToText` takes at most 1.5 ms (best of 3), where the regex chain took up to 325 ms.
  - The prompt still turns a description's line breaks into spaces (`sanitizeEventField`, `event-formatter.ts:7-9`, A-13, unchanged). So "on separate lines" is checked on the reader's event, and "separate words" in the prompt: `Description: Agenda Budget Join Room 4`.
  - (a) normalizes the old side with `htmlToText` too, so it holds either way; the new check is (b)'s.
- **Virtual time** (`runVirtual`) for three checks whose timers would take from 13 s to over two minutes: the near-limit tomorrow summary, the quick retry answered too late and the stall. While it runs, `setTimeout` puts each timer on a list instead of Node's timers; whenever the work makes no progress for 50 turns of the event loop, the earliest timer fires and the fake clock jumps to its time. The reader's deadlines, C1's 1 s pause, the pipeline's 50 s race, the fake delays and the C4 wait all run on it, so the race between the summary and the 50 s limit is real, on the fake clock. Timers nobody clears (the pipeline's 50 s) are dropped at the end. The other checks keep real timers.
- **The near-limit check.** The review asked for a first attempt failing at 4,900 ms and a quick retry answering at 7,900 ms. The quick retry's request timeout is 7,500 ms (`deadlineMs - 500`), so an answer at 7.9 s never arrives: the fake honours each request's timeout, as gaxios does, and a check pins that a 7.9 s answer ends in R13's text. The near-limit check answers at 7.4 s instead: 2 s of timezone lookup (once; later lookups are cached), 4.9 + 1 + 7.4 s for the day and again for the week block, and 20 s of AI. It lands at 48.6 s, 1.4 s inside the race; 22 s of AI times it out (a mutation below). That is the measured margin; nothing changes for it here.
- **The stall check.** Three Google users whose token server never answers, then a FamCal user. Each first read ends at its 30 s deadline, so the FamCal user goes out at 90 s. The loop ends 60 s after the first failure, so the retries start at once, with no sleep (the review expected one; a wait counted from the end of the loop would add 30 s). Each retry ends at its 15 s deadline and takes the outage run: 135 s in all, which the batch's closing line logs (C4). No admin notice.
- **The week block alone** (C3's decision): the day read answers, the week block's lists are rate-limited. The tomorrow summary goes out without the block and without the outage line, is marked sent, and Sentry gets `summary-week-lookahead`; the scheduled read makes no quick retry.
- **Window ends.** Today's Google day read ends at `23:59:59` and the FamCal one at `23:59:59.999`. The reader ends at the exclusive midnight. That is one of spec §2.3's small differences. No fixture starts in the last second of a day, so the comparison is exact.
- **The switch and the week start are stubbed, nothing else in the path is.**
  - `isCalendarHomeOn` reads a variable (`OFF` or `ADMINS`). Every fixture user is an admin.
  - `weekStartFor` is a partial fake of the real `locale-rules` module, built once through `Module._load`. In `legacy` mode it returns `legacyWeekStart(culture)`; in `real` mode it calls the real rule. C5's note applies: the module must be replaced where it is loaded, because assigning to a loaded tsx module's export is silently dropped.
  - The parity checks (a)–(b) and the first (c) check use `legacy`, so the switch changes only how a week is read. The week start by country is deliberate change C7, and the second (c) check covers it.
- **(a) compares at the summary seam:** `summary.fetchTodayEvents` / `fetchTomorrowEvents(user, ids, tz, day)` with the ids from `getCalendarAssignmentsForUser`, then `shapeEventsForDay`. That is exactly what `prepareSummaryForUser` does before `addDigestReminders`.
  - The day is the summary's: the user's local date, plus one for tomorrow.
  - The matrix is 160 comparisons: 8 users × 2 zones (Israel, New York) × 5 clocks × today and tomorrow.
  - A dead token and missing scopes are compared by the code each path throws. Both say `GOOGLE_TOKEN_EXPIRED` and `GOOGLE_INSUFFICIENT_SCOPES`.
  - Two coverage checks keep the fixtures honest. The normalization must have changed something (C1/C2 items, an HTML description, `reminders`). The shaped lines must include every case spec §10 lists: overnight, sleepover, multi-day all-day, zero-length at 00:00 and 23:59, the 25-hour 25 October, a partner's reminder-for-me from a PRIVATE calendar. Last night's tails must be gone after 06:00.
- **(b) leaves the deliberate-change items out of Google** (`hideChanged`) for both runs. Otherwise the Google prompt would differ by design (C1–C3).
  - The four runs are a daily, two tomorrow summaries with their week block (the block reads through the reader too), and the 25 October daily. They cover both cultures and languages (Dana `he`/jewish, Gali `en`/default).
  - A coverage check looks for the reminders guideline, carry-overs, the partner, kids, a birthday and the week block in the prompts.
- **(d) observes the reader's deadline through `setTimeout`.** The reader's per-request timeout is `min(10000, deadlineMs − 500)`, which is 10,000 for both 30,000 and 15,000. So the scheduled read kinds show only in the reader's deadline timer. The smoke wraps the global `setTimeout` (pass-through) and records each duration. From the recorded list:
  - 50,000 is the pipeline's limit;
  - 30,000 / 15,000 / 10,000 / 8,000 are the reader's deadlines;
  - 1,000 is C1's pause.

  The on-demand request timeouts (9,500, then 7,500 on the quick retry) show in the list log as well. The tomorrow summary's week block is checked the same way, on a first attempt that reads (30,000 twice) and on a retry that reads (30,000, 15,000, 15,000).
- **Real timers.** The reader's 1 s pause runs three times (rate limit on demand, `/week`, the fast 500). The 10 s deadline runs once (the hanging token server). So one run takes about 15 s.
  - "Within 50 s" is measured with `performance.now()`, in real time.
  - The scheduled 30 s wait goes through C4's sleep hook, which logs the wait and moves the fake clock.
  - The pipeline's 50 s timer is never cleared (`command-pipeline.ts:97-102`), so the smoke ends with `process.exit`.
- **The clock** is a fake `Date`. Only (e) sets the token step to take 1 s. So the batch's first failure is at 07:00:01, the loop ends at 07:00:03, and the wait is 28,000 ms: it counts from the first failure, not from the end of the loop.
- **Reporting.**
  - `reportedBySummary()` keeps only `summary-*` Sentry contexts. The reader's own `calendar-read-google` warnings are checked where they matter (the 404 cases).
  - The reader sends its gone warning in the background (`inBackground`), so it and the digest's warning arrive in either order, and the check sorts them.
  - Redis is in memory. The last check asserts that no run read or wrote a `gcal:range`, `gcal:stamp` or `gcal:fresh` key (B7's stamp scope, A-30). `gcal:gone_warned` is allowed: it is the reader's warning gate (C1's finding).
- **Module loading** follows C3's pattern. Static imports pass through `Module._load`. The `import()` calls in `summary.ts` and `commands.ts` (timezone, user service, Redis, the notifier, the magic link, the kid-name follow-up) go through a `Module.registerHooks` load hook that serves the same fake. `@hebcal/core` is pointed at its ESM build.
- **Fixtures** (spec §10 item 6):
  - users:
    - Dana, FamCal paired: own and kids' calendars, Raziel's shared calendar, Raziel's PRIVATE calendar with reminders for her (one-off, daily, carry-over);
    - Noam, FamCal solo;
    - Gali, Google with yours/spouse/kids/family/birthdays calendars, the C1/C2/C3 items, repeating instances and masters;
    - Tom, Google still paired with Lior, a FamCal user who set him a reminder;
    - Ori, Google with a dead token; Shira, Google missing scopes; Yoni, Google with one 404; Avi, Google with every calendar gone;
    - Maya and Ella, for the retries;
    - Sam (New York), Olivia (London) and Karim (Cairo), for the week start;
  - clocks: Thursday 07:00, Thursday 19:00, Friday 00:30, Saturday 19:00, and Sunday 25 October 07:00, which is Israel's 25-hour day and a Sunday.
- **Line numbers** are of the files after C5. They don't hold at 716a4f8, where two of these are new and the rest sit on other lines:
  - `summary.ts`: `fetchTodayEvents` `:30` (`:11` at 716a4f8, not exported), `prepareSummaryForUser` `:115` (`:79`, not exported), `__setScheduledRetrySleepForTests` `:422` (new in C4);
  - `week-lookahead.ts`: `getWeekLookahead` `:393` (`:406` at 716a4f8), `getNextWeekLookahead` `:475` (`:507`);
  - `commands.ts`: `handleLookaheadCommand` `:572` (`:499` at 716a4f8);
  - `digest.ts` (new in C1): the quick-retry line `:99`.
  - `src/utils/html.ts` and `scripts/smoke-google-map.ts` are as of 716a4f8 (C1–C5 don't touch them): `htmlToPlain` at `:177-184`, `htmlToText`'s comment at `:190` and `htmlToText` at `:198`; the map smoke's "NotesAgenda" assertion at `:379-380`, and its 32,768-character timing check at `:472-502`, whose last shape and closing brace are `:491-492`.
- **What C1–C5 look like from here.** The drafts apply cleanly, in order, to a copy of `feat/calendar-home` at 716a4f8, every step as written: every Before block matches once, each step prints the counts it expects, and each task leaves the tree its commit makes. C2's snapshot, which its Step 2 takes from an export of `858886c`, has md5 `754b58c0…`. Their own smokes then pass together:
  - `smoke-digest-adapters` 23/23 and `smoke-calendar-read-google-cancel` 5/5;
  - `smoke-summary-prompt-parity` 9/9;
  - `smoke-summary-seam` 23/23 and `smoke-calendar-home-rollout` 35/35;
  - `smoke-summary-retry` 20/20;
  - `smoke-week-lookahead` 42/42;
  - `smoke-week-commands` 7/7.

  Each passes under `UTC`, `Asia/Jerusalem` and `Pacific/Kiritimati`, with `tsc` and lint clean. The two observations of the first pass are fixed there: C4 marks the retry's summaries for the batch's date, and C5 sends R13's text as HTML, as C3 does.
- **Verified** on `feat/calendar-home` (716a4f8 plus C1–C5, then this task). The first pass ran on the scratch base (header, Planning Ruling 2: it differs from 716a4f8 only in docs, `smoke-voice-dates.ts`, `html.ts` and `smoke-google-map.ts`):
  - First pass, on the scratch base: 20/23 with C1's quick retry removed, 23/23 green, about 15 s each, on Node 26.11.1 and Node 22.23.3.
  - On 716a4f8: Step 3 prints 27/28 under each clock, with only the Outlook check failing, and the map smoke 43/45. Step 6: 28/28 under `TZ=UTC`, `Asia/Jerusalem` and `Pacific/Kiritimati`, about 15 s each (the virtual-time checks take well under a second), and the map smoke 45/45. The regression smokes over `htmlToText`'s readers printed the same lines. `tsc` and lint are clean.
  - Mutations caught, each by at least one check, run one at a time under `TZ=UTC` on 716a4f8 plus C1–C5 and this task (the first pass ran them on the scratch base too; Plan B's `htmlToText` is 716a4f8's `src/utils/html.ts` put back, which is Step 3's red run):
    - C1: the summaries read through the cache (`'use'`); no quick retry; a quick retry after a timeout; the quick retry's deadline at 10,000 ms; a day read two days long; every calendar gone answered as an outage;
    - the reader (B): `focusTime` kept; the raw HTML description; the FamCal legend without the partner's calendars; Google asked in UTC;
    - C2: no English guideline line;
    - C3: the daily wrapper ignoring the switch; no R13 branch; no outage line; missing scopes clearing the token by `user.id`;
    - C4: first attempts on the default read; no set-aside; the retry without the day; the outage run without the flag; the wait counted from the end of the loop;
    - C5: the week block without the summary's read; the lookahead on the default read; the week start always legacy; `/week` without its `onError`;
    - from the review: Plan B's `htmlToText` (the Outlook check, 27/28); C1's quick retry removed (23/28: the three on-demand rate-limit and 500 checks, the near-limit check and the late-retry check); a 22 s AI stream (the near-limit check and the last check, an OperationTimeoutError with its admin notice).

    One mutation survives, and it changes nothing: dropping `readRange`'s sort of the Google items (`index.ts:83`), which `readGoogleUncached` has already sorted (`google.ts:389`).

**Files:**
- Create (test): `scripts/smoke-digest-reader-parity.ts` (28 checks)
- Modify: `src/utils/html.ts:177-184, :190` (Step 4): `htmlToPlain`'s blocks, and `htmlToText`'s comment
- Modify (test): `scripts/smoke-google-map.ts:379-380, :491-492` (Step 2): the "NotesAgenda" assertion, one check of the blocks (44 → 45), and three block shapes in the 32,768-character timing check
- Modify (doc): `docs/superpowers/specs/2026-10-16-calendar-home-design.md` §2.5 item 8 (Step 5)
- Test: `scripts/smoke-digest-reader-parity.ts` and `scripts/smoke-google-map.ts`, under `TZ=UTC`, `TZ=Asia/Jerusalem` and `TZ=Pacific/Kiritimati`
- Regression (unchanged): `smoke-calendar-read-google`, `smoke-calendar-read-google-cache`, `smoke-calendar-dto`, `smoke-calendar-range`, `smoke-week-lookahead`, `smoke-voice-dates`

**Interfaces:**
- Consumes (all after C5):
  - C3, `src/services/telegram/summary.ts`:
    - `export type SummaryFetch = (user: UserConfig, calendarIds: string[], timezone: string, day: DayKey, read?: DigestRead) => Promise<CalendarEvent[]>`;
    - `export const fetchTodayEvents: SummaryFetch` and `fetchTomorrowEvents: SummaryFetch`;
    - `export async function prepareSummaryForUser(user, fetchFunction: SummaryFetch, summaryDate: Date | undefined, modelId?, onTextDelta?, onStageChange?, opts?: { day?: DayKey; read?: DigestRead; googleUnavailable?: boolean }): Promise<PreparedSummary>`;
    - unchanged: `sendDailySummaryToUser(chatId, platform?, streamHandle?)`, `sendDailySummaryToAll(options?: { filterByHour?: boolean }): Promise<SummaryBatchResult>`, `sendTomorrowSummaryToAll(options?)`.
  - C4: `export function __setScheduledRetrySleepForTests(sleep: ((ms: number) => Promise<void>) | null): void` (`summary.ts`).
  - C5:
    - `getWeekLookahead(user: UserConfig, calendars: CalendarAssignment[], referenceDate?: Date, read?: DigestRead): Promise<WeekLookahead>` and `getNextWeekLookahead(…)` (`src/services/week-lookahead.ts`);
    - `handleLookaheadCommand(chatId: number | string, userId: number | string, platform?: MessagingPlatform, streamHandle?: StreamMessageHandle): Promise<void>` (`src/services/telegram/commands.ts`).
  - C2: `bot.errors.googleUnreachable` and `bot.errors.googleOutageNote` in `messages/{en,he,ru}.json`, read from the files. The outage guideline is checked as one added line, not by its wording.
  - C1, through its effects: `DEFAULT_ON_DEMAND_READ` (10,000), `SCHEDULED_READ` (30,000), `SCHEDULED_RETRY_READ` (15,000), the quick retry (1 s, then 8,000), and `GOOGLE_FETCH_FAILED` with `day`.
  - B and earlier:
    - `getCalendarAssignmentsForUser(user: UserConfig): Promise<CalendarAssignment[]>` (`src/services/calendar-provider/user-calendars.ts:29`);
    - `isCalendarHomeOn(user: { isAdmin?: boolean | null }): Promise<boolean>` (stubbed);
    - `weekStartFor(f)` and `legacyWeekStart(culture?)` (`src/utils/locale-rules.ts`, partially faked);
    - `localDate`, `nextDate`, `startOfLocalDay`, `shapeEventsForDay` (`src/utils/day-events.ts`);
    - `htmlToText(s, max?)` (`src/utils/html.ts:198`).
- Produces: nothing exported. `htmlToText(s, max?)` keeps its signature; its output changes only for descriptions with the block tags above.

All commands below use the fake environment and never read `.env`. Run them in zsh: `pipestatus` is zsh's (in bash it is `${PIPESTATUS[0]}`).

- [ ] **Step 1: Write the smoke `scripts/smoke-digest-reader-parity.ts`**

Create the file with exactly this content:

```ts
// Parity smoke for the summaries on the shared reader (calendar home spec §10,
// "smoke-digest-reader-parity.ts"; Plan C, Task C6).
//
// For the users the rollout switch covers, the daily and tomorrow summaries, the
// tomorrow summary's week block, /week and /nextweek read through the shared reader
// (readDigestDay, readLookaheadEvents) instead of the calendar providers. This smoke runs
// the old path (switch OFF) and the new one (ADMINS) over the same fake Google and the
// same in-memory database, and holds them to the spec's before/after contract:
// (a) Same events: for every user, timezone and clock, the reader's day, shaped by
//     shapeEventsForDay, is the provider's. FamCal users match strictly. For Google only
//     the deliberate changes are normalized on the old side: C1/C2 items removed, C3
//     descriptions through htmlToText, `reminders` deleted.
// (b) Same prompts, byte for byte, for a paired FamCal user with reminders and a Google
//     user with yours/spouse/kids/birthday calendars. An Outlook/Teams HTML description
//     (a table row, a heading) keeps its words apart in the switch-on prompt.
// (c) /week and /nextweek list the same events with weekStartFor on legacyWeekStart; with
//     the real rule the weeks start by country.
// (d) How each Google failure ends, scheduled and on demand, with recording fakes; also
//     a week block that fails on its own, and an on-demand tomorrow summary whose reads
//     and AI call come close to the command's 50 s limit.
// (e) A scheduled batch doesn't wait for its Google retries, also when Google stalls.
//
// Real: summary.ts, commands.ts (/week), the command pipeline, week-lookahead.ts, the
// digest adapters, readRange and both halves, calendar.ts, both providers, the event
// store, ownership, open reminders, the claude.ts prompt builders, the bot texts and the
// summary scheduling. Faked: Google (@googleapis/calendar's OAuth client and calendar
// client), the database (in memory), Redis (in memory), the rollout switch, weekStartFor
// (legacy or the real rule), the timezone lookup, the users, the AI, the holiday lookup,
// Telegram, the voice note, quota, analytics, Sentry and the admin notifier. The clock is
// a fake Date; timers are real. No network, no DB.
//
// Real timers run the reader's 1 s pause before a quick retry (three times) and its 10 s
// deadline (the hanging token server), so a run takes about 15 s. Three checks run on
// virtual time instead (runVirtual): their timers wait on the fake clock, which jumps to
// the next timer whenever nothing else can run, so a 135 s stall takes a moment.
//
// Run under each clock; the output must not depend on the server's timezone:
//   TZ=UTC npx tsx scripts/smoke-digest-reader-parity.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-digest-reader-parity.ts
//   TZ=Pacific/Kiritimati npx tsx scripts/smoke-digest-reader-parity.ts

import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import type { NativeCalendar, NativeEvent, NativeReminderState } from '@prisma/client';
import { MessageFormat, MessagingPlatform } from '../src/services/messaging/types';
import type { MessageOptions, StreamMessageHandle } from '../src/services/messaging/types';
import type { CalendarAssignment, CalendarEvent, CalendarLabel, UserConfig } from '../src/types';
import type { AICompletionResult } from '../src/services/ai-provider';
import type { WeekLookahead } from '../src/services/week-lookahead';
import { localDate, nextDate, shapeEventsForDay, startOfLocalDay } from '../src/utils/day-events';
import { htmlToText } from '../src/utils/html';

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

const show = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x));

function assertList(got: readonly string[], want: readonly string[], what: string) {
  assert(show(got) === show(want), `${what}\n     got  ${JSON.stringify(got, null, 1)}\n     want ${JSON.stringify(want, null, 1)}`);
}

async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
}

// ---- Environment: fakes only ----

process.env.NEXT_PUBLIC_APP_URL = 'https://famcal.test';

/** Any request that slips past the fakes is refused and counted. */
const networkAttempts: string[] = [];
globalThis.fetch = (async (input: unknown) => {
  networkAttempts.push(String(input));
  throw new Error(`network is blocked in this smoke test: ${String(input)}`);
}) as typeof fetch;

const unhandled: unknown[] = [];
process.on('unhandledRejection', reason => {
  unhandled.push(reason);
});

// ---- Clock: every argument-less new Date() and Date.now() reads `clock` ----

const IL = 'Asia/Jerusalem';
const NY = 'America/New_York';
const LONDON = 'Europe/London';
const CAIRO = 'Africa/Cairo';
/** An instant from a wall-clock time, in Israel unless said otherwise. */
const at = (local: string, tz = IL) => fromZonedTime(local, tz);

const RealDate = Date;
let clock = at('2026-10-22 07:00:00').getTime();
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

// ---- Timers stay real; the durations asked for are recorded ----

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
/** Every setTimeout duration since the last reset: the reader's deadlines, the retry pause, the pipeline's 50 s. */
let timersAsked: number[] = [];
/** While set (runVirtual), timers wait on the fake clock instead of real time. */
let virtualTime = false;
type VirtualTimer = { due: number; seq: number; run: () => void; cleared: boolean };
const virtualTimers: VirtualTimer[] = [];
let timerSeq = 0;
globalThis.setTimeout = ((handler: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
  timersAsked.push(ms ?? 0);
  if (!virtualTime) return realSetTimeout(handler, ms, ...args);
  const timer: VirtualTimer = { due: clock + Math.max(0, ms ?? 0), seq: timerSeq++, run: () => handler(...args), cleared: false };
  virtualTimers.push(timer);
  // What a Node timer offers the code that holds it.
  return Object.assign(timer, { ref: () => timer, unref: () => timer, hasRef: () => true, refresh: () => timer });
}) as unknown as typeof setTimeout;
globalThis.clearTimeout = ((handle?: unknown) => {
  const timer = virtualTimers.find(t => t === handle);
  if (timer) timer.cleared = true;
  else realClearTimeout(handle as ReturnType<typeof setTimeout>);
}) as typeof clearTimeout;

/**
 * Runs `work` on virtual time: whenever nothing else can run (50 turns of the event loop
 * with no progress), the earliest timer fires and the fake clock jumps to it. Timers left
 * when the work ends (the pipeline's 50 s, which nobody clears) are dropped.
 */
async function runVirtual<T>(work: () => Promise<T>): Promise<T> {
  virtualTime = true;
  let settled = false;
  const result = work().finally(() => {
    settled = true;
  });
  result.catch(() => {});
  try {
    for (;;) {
      for (let i = 0; i < 50 && !settled; i++) await new Promise(resolve => setImmediate(resolve));
      if (settled) return await result;
      const next = virtualTimers.filter(t => !t.cleared).sort((a, b) => a.due - b.due || a.seq - b.seq)[0];
      if (!next) throw new Error('virtual time: the work is waiting on something that is not a timer');
      next.cleared = true;
      clock = Math.max(clock, next.due);
      next.run();
    }
  } finally {
    virtualTime = false;
    virtualTimers.length = 0;
  }
}
/** The long timers only: 1 s and up. */
const longTimers = () => timersAsked.filter(ms => ms >= 1000);

// ---- What happened, in order ----

/** Google calls, sends, drafts, voice notes, dedup marks, admin notices, cleared tokens and waits. */
let log: string[] = [];
/** Every prompt the AI got, in order. */
let prompts: string[] = [];
/** Sentry, as "<context> <level> <message>". */
let captured: string[] = [];
/** Every admin error notice of the whole run. */
const adminErrors: string[] = [];
/** Every Redis key the run read or wrote. */
const redisKeys = new Set<string>();
/** When each message, draft and voice note went out, on the fake clock: "<what> @<ms>". */
let sentAt: string[] = [];
/** The code under test logs timings and errors; they are kept out of the report. */
const logs: string[] = [];

// ---- In-memory Prisma: the operators, relation filters, include, select and orderBy the code under test uses ----

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;
type Relations = Record<string, (row: Row) => Row | Row[] | undefined>;
type FindArgs = {
  where?: Where;
  select?: Record<string, boolean>;
  include?: Record<string, boolean>;
  orderBy?: Record<string, 'asc' | 'desc'> | Array<Record<string, 'asc' | 'desc'>>;
};

const same = (a: unknown, b: unknown) => (a instanceof RealDate && b instanceof RealDate ? a.getTime() === b.getTime() : a === b);

function matches(row: Row, where: Where, relations: Relations = {}): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as Where[]).some(w => matches(row, w, relations));
    if (key === 'AND') return (Array.isArray(cond) ? (cond as Where[]) : [cond as Where]).every(w => matches(row, w, relations));
    if (Object.hasOwn(relations, key)) {
      const target = relations[key](row);
      if (Array.isArray(target)) {
        const { some, ...rest } = cond as { some?: Where };
        if (!some || Object.keys(rest).length > 0) throw new Error(`stand-in Prisma only knows '${key}: { some }'`);
        return target.some(r => matches(r, some));
      }
      return target !== undefined && matches(target, cond as Where);
    }
    const value = row[key];
    if (cond === null || typeof cond !== 'object' || cond instanceof Date) return same(value, cond);
    return Object.entries(cond as Where).every(([op, arg]) => {
      switch (op) {
        case 'in': return (arg as unknown[]).some(a => same(a, value));
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
  return v instanceof RealDate ? v.getTime() : Number(v);
};

/** Every query since the last reset, as "<model>.<method>". */
let queries: string[] = [];

function table(name: string, rows: () => Row[], relations: Relations = {}) {
  const shape = (row: Row, args: FindArgs) => {
    if (args.select) return Object.fromEntries(Object.keys(args.select).filter(k => args.select![k]).map(k => [k, row[k]]));
    const out: Row = { ...row };
    for (const [k, on] of Object.entries(args.include ?? {})) if (on) out[k] = relations[k](row);
    return out;
  };
  return {
    findMany: async (args: FindArgs = {}) => {
      queries.push(`${name}.findMany`);
      const found = rows().filter(r => matches(r, args.where ?? {}, relations));
      const orderBy = args.orderBy ? (Array.isArray(args.orderBy) ? args.orderBy : [args.orderBy]) : [];
      found.sort((a, b) => {
        for (const o of orderBy) {
          const [key, dir] = Object.entries(o)[0];
          const d = sortKey(a, key) - sortKey(b, key);
          if (d !== 0) return dir === 'asc' ? d : -d;
        }
        return 0;
      });
      return found.map(r => shape(r, args));
    },
    findUnique: async (args: FindArgs & { where: Where }) => {
      queries.push(`${name}.findUnique`);
      const row = rows().find(r => matches(r, args.where, relations));
      return row ? shape(row, args) : null;
    },
  };
}

const db = { users: [] as Row[], pairings: [] as Row[], calendars: [] as Row[], events: [] as Row[], instances: [] as Row[], states: [] as Row[] };

const fakePrisma = {
  user: table('user', () => db.users),
  pairing: table('pairing', () => db.pairings),
  nativeCalendar: table('nativeCalendar', () => db.calendars),
  nativeEvent: table('nativeEvent', () => db.events, {
    calendar: r => db.calendars.find(c => c.id === r.calendarId),
    instances: r => db.instances.filter(i => i.seriesEventId === r.id),
    states: r => db.states.filter(s => s.seriesEventId === r.id),
  }),
  nativeEventInstance: table('nativeEventInstance', () => db.instances),
  nativeReminderState: table('nativeReminderState', () => db.states),
};

// ---- The built-in calendar: Dana and Raziel paired, Noam solo, Lior paired with Tom (a Google user) ----

const CREATED = at('2026-09-01 09:00:00');

function nativeCalendar(fields: Partial<NativeCalendar> & Pick<NativeCalendar, 'id' | 'ownerUserId' | 'name' | 'createdAt'>): NativeCalendar {
  return {
    color: '#039BE5', labels: ['yours'], personName: null, personEnglishName: null, personGender: null, rules: [],
    privacy: 'PRIVATE', isDeleted: false, updatedAt: CREATED,
    ...fields,
  };
}

function nativeEvent(fields: Partial<NativeEvent> & Pick<NativeEvent, 'id' | 'calendarId' | 'creatorUserId' | 'title' | 'startsAt'>): NativeEvent {
  return {
    description: null, location: null, endsAt: fields.startsAt, allDay: false, timeZone: IL, rrule: null, exdates: [],
    reminderMinutes: null, isDeleted: false, createdAt: CREATED, updatedAt: CREATED,
    kind: 'EVENT', forUserId: null, armedAt: null,
    ...fields,
  };
}

/** A reminder has no length: it ends where it starts. */
const reminderRow = (fields: Parameters<typeof nativeEvent>[0]) => nativeEvent({ kind: 'REMINDER', armedAt: CREATED, ...fields, endsAt: fields.startsAt });

function reminderState(fields: Partial<NativeReminderState> & Pick<NativeReminderState, 'seriesEventId' | 'originalStartsAt'>): NativeReminderState {
  return {
    id: `state-${fields.seriesEventId}-${fields.originalStartsAt.getTime()}`, doneAt: null, doneByUserId: null, snoozedUntil: null,
    lastPingedAt: null, pingAttempts: 0, pingChatId: null, pingMessageId: null, createdAt: CREATED, updatedAt: CREATED,
    ...fields,
  };
}

const userRow = (id: number, name: string, extra: Row = {}): Row => ({
  id, name, englishName: name, gender: 'female', calendarSource: 'NATIVE', telegramId: BigInt(1000 + id), language: 'en',
  pairingId: null, suspendedAt: null, googleRefreshToken: '', ...extra,
});

db.users = [
  userRow(1, 'Dana', { pairingId: 'pair-1', language: 'he' }),
  userRow(2, 'Raziel', { gender: 'male', pairingId: 'pair-1', language: 'he' }),
  userRow(3, 'Noam', { gender: 'male', language: 'ru' }),
  userRow(5, 'Tom', { gender: 'male', calendarSource: 'GOOGLE', pairingId: 'pair-2', googleRefreshToken: 'tok-tom' }),
  userRow(6, 'Lior', { pairingId: 'pair-2' }),
];
db.pairings = [
  { id: 'pair-1', status: 'ACTIVE', inviterUserId: 2, inviteeUserId: 1 },
  { id: 'pair-2', status: 'ACTIVE', inviterUserId: 6, inviteeUserId: 5 },
];
db.calendars = [
  nativeCalendar({ id: 'cal-dana', ownerUserId: 1, name: 'Dana', labels: ['primary', 'yours'], createdAt: at('2026-09-01 09:00:00') }),
  nativeCalendar({ id: 'cal-raz', ownerUserId: 2, name: 'Raziel', labels: ['primary', 'yours'], privacy: 'SHARED_EDITOR', createdAt: at('2026-09-02 09:00:00') }),
  nativeCalendar({ id: 'cal-raz-private', ownerUserId: 2, name: 'Surprise party plans', createdAt: at('2026-09-03 09:00:00') }),
  nativeCalendar({ id: 'cal-dana-kids', ownerUserId: 1, name: 'Kids', labels: ['kids'], personName: 'Noa', createdAt: at('2026-09-04 09:00:00') }),
  nativeCalendar({ id: 'cal-noam', ownerUserId: 3, name: 'Noam', labels: ['primary', 'yours'], createdAt: at('2026-09-05 09:00:00') }),
  nativeCalendar({ id: 'cal-lior', ownerUserId: 6, name: 'Lior', labels: ['primary', 'yours'], createdAt: at('2026-09-06 09:00:00') }),
] as unknown as Row[];
db.events = [
  // Dana's own and her kids' calendar
  nativeEvent({ id: 'n-dentist', calendarId: 'cal-dana', creatorUserId: 1, title: 'Dentist', startsAt: at('2026-10-22 10:00:00'), endsAt: at('2026-10-22 11:00:00'), description: 'Bring the forms', location: '12 Herzl St' }),
  nativeEvent({ id: 'n-swim', calendarId: 'cal-dana-kids', creatorUserId: 1, title: 'Swimming', startsAt: at('2026-10-08 16:00:00'), endsAt: at('2026-10-08 17:00:00'), rrule: 'FREQ=WEEKLY;BYDAY=TH' }),
  nativeEvent({ id: 'n-sleepover', calendarId: 'cal-dana-kids', creatorUserId: 1, title: "Sleepover at Ben's", startsAt: at('2026-10-22 19:00:00'), endsAt: at('2026-10-23 10:00:00') }),
  nativeEvent({ id: 'n-hike', calendarId: 'cal-dana', creatorUserId: 1, title: 'Hiking trip', startsAt: at('2026-10-24 00:00:00'), endsAt: at('2026-10-25 23:59:00'), allDay: true }),
  // Israel's clocks go back at 02:00 on 25 October: a 25-hour day.
  nativeEvent({ id: 'n-shift', calendarId: 'cal-dana', creatorUserId: 1, title: 'Night shift', startsAt: at('2026-10-25 00:30:00'), endsAt: at('2026-10-25 03:00:00') }),
  reminderRow({ id: 'r-plants', calendarId: 'cal-dana', creatorUserId: 1, title: 'Water the plants', startsAt: at('2026-10-22 08:00:00') }),
  reminderRow({ id: 'r-bank', calendarId: 'cal-dana', creatorUserId: 1, forUserId: 2, title: 'Call the bank', startsAt: at('2026-10-22 15:00:00') }),
  reminderRow({ id: 'r-passport', calendarId: 'cal-dana', creatorUserId: 1, title: 'Renew the passport', startsAt: at('2026-10-22 12:00:00') }),
  reminderRow({ id: 'r-recycling', calendarId: 'cal-dana', creatorUserId: 1, title: 'Take out the recycling', startsAt: at('2026-10-24 00:00:00') }),
  reminderRow({ id: 'r-car', calendarId: 'cal-dana', creatorUserId: 1, title: 'Lock the car', startsAt: at('2026-10-23 23:59:00') }),
  reminderRow({ id: 'r-plumber', calendarId: 'cal-dana', creatorUserId: 1, title: 'Call the plumber', startsAt: at('2026-10-20 10:00:00') }),
  // Raziel's shared calendar, and his PRIVATE one: Dana sees only the reminders he set for her
  nativeEvent({ id: 'n-movies', calendarId: 'cal-raz', creatorUserId: 2, title: 'Movie marathon', startsAt: at('2026-10-23 22:00:00'), endsAt: at('2026-10-24 02:00:00') }),
  nativeEvent({ id: 'n-pilates', calendarId: 'cal-raz', creatorUserId: 2, title: 'Pilates', startsAt: at('2026-10-22 19:00:00'), endsAt: at('2026-10-22 20:00:00') }),
  reminderRow({ id: 'r-cake', calendarId: 'cal-raz', creatorUserId: 2, forUserId: 1, title: 'Pick up the cake', startsAt: at('2026-10-24 18:00:00') }),
  reminderRow({ id: 'r-milk', calendarId: 'cal-raz-private', creatorUserId: 2, forUserId: 1, title: 'Buy milk', startsAt: at('2026-10-22 17:00:00') }),
  reminderRow({ id: 'r-vitamins', calendarId: 'cal-raz-private', creatorUserId: 2, forUserId: 1, title: 'Vitamins', startsAt: at('2026-10-20 08:00:00'), rrule: 'FREQ=DAILY' }),
  reminderRow({ id: 'r-vet', calendarId: 'cal-raz-private', creatorUserId: 2, forUserId: 1, title: 'Book the vet', startsAt: at('2026-10-19 09:00:00') }),
  reminderRow({ id: 'r-surprise', calendarId: 'cal-raz-private', creatorUserId: 2, title: 'Plan the surprise', startsAt: at('2026-10-22 12:00:00') }),
  // Noam, on his own
  nativeEvent({ id: 'n-gym', calendarId: 'cal-noam', creatorUserId: 3, title: 'Gym', startsAt: at('2026-10-01 07:00:00'), endsAt: at('2026-10-01 08:00:00'), rrule: 'FREQ=DAILY' }),
  nativeEvent({ id: 'n-galilee', calendarId: 'cal-noam', creatorUserId: 3, title: 'Galilee trip', startsAt: at('2026-10-23 00:00:00'), endsAt: at('2026-10-25 23:59:00'), allDay: true }),
  nativeEvent({ id: 'n-late', calendarId: 'cal-noam', creatorUserId: 3, title: 'Late call', startsAt: at('2026-10-22 23:00:00'), endsAt: at('2026-10-23 01:00:00') }),
  reminderRow({ id: 'r-garden', calendarId: 'cal-noam', creatorUserId: 3, title: 'Water the garden', startsAt: at('2026-10-24 00:00:00') }),
  nativeEvent({ id: 'n-dinner', calendarId: 'cal-noam', creatorUserId: 3, title: 'Dinner with Lena', startsAt: at('2026-10-28 20:00:00'), endsAt: at('2026-10-28 22:00:00') }),
  // Lior's reminder for Tom, a Google user: never in Tom's summary (R3)
  reminderRow({ id: 'r-lior', calendarId: 'cal-lior', creatorUserId: 6, forUserId: 5, title: 'Pick up the dry cleaning', startsAt: at('2026-10-22 09:00:00') }),
] as unknown as Row[];
db.states = [
  reminderState({ seriesEventId: 'r-plants', originalStartsAt: at('2026-10-22 08:00:00'), doneAt: at('2026-10-22 08:10:00'), doneByUserId: 1 }),
  reminderState({ seriesEventId: 'r-passport', originalStartsAt: at('2026-10-22 12:00:00'), snoozedUntil: at('2099-01-01 09:00:00') }),
  reminderState({ seriesEventId: 'r-vitamins', originalStartsAt: at('2026-10-21 08:00:00'), doneAt: at('2026-10-21 08:05:00') }),
] as unknown as Row[];

// ---- Google: each calendar's events, as events.list returns them ----

type GoogleFixture = {
  id: string;
  summary: string;
  /** A Date for a timed event; yyyy-MM-dd for an all-day one (the end exclusive). */
  start: Date | string;
  end: Date | string;
  description?: string;
  location?: string;
  eventType?: string;
  recurringEventId?: string;
  attendees?: { email?: string; self?: boolean; responseStatus: string }[];
  reminders?: { useDefault: boolean };
  /** A deliberate change of the reader (spec §3.3): C1/C2 drop the item, C3 makes its description plain text. */
  changed?: 'C1' | 'C2' | 'C3';
};

const GALI_CAL = 'gali@example.com';
const TOM_CAL = 'tom@example.com';
const KIDS_CAL = 'kids@group.calendar.google.com';
const FAMILY_CAL = 'family@group.calendar.google.com';
const BIRTHDAYS_CAL = 'addressbook#contacts@group.v.calendar.google.com';

/** The instances of a repeating Google event: one per day listed, at `time` for `minutes`. */
function instances(seriesId: string, summary: string, days: string[], time: string, minutes: number): GoogleFixture[] {
  return days.map(day => {
    const start = at(`${day} ${time}:00`);
    return { id: `${seriesId}_${day.replaceAll('-', '')}`, summary, start, end: new RealDate(start.getTime() + minutes * 60_000), recurringEventId: seriesId };
  });
}
const daysFrom = (first: string, count: number) => Array.from({ length: count }, (_, i) => {
  const d = new RealDate(`${first}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + i);
  return d.toISOString().slice(0, 10);
});

const GOOGLE: Record<string, { summary: string; events: GoogleFixture[] }> = {
  [GALI_CAL]: {
    summary: 'Gali',
    events: [
      { id: 'g-standup', summary: 'Team standup', start: at('2026-10-22 09:30:00'), end: at('2026-10-22 09:45:00'), location: 'Zoom', reminders: { useDefault: true } },
      { id: 'g-pitch', summary: 'Vendor pitch', start: at('2026-10-22 11:00:00'), end: at('2026-10-22 12:00:00'), attendees: [{ self: true, responseStatus: 'declined' }], changed: 'C2' },
      { id: 'g-budget', summary: 'Budget review', start: at('2026-10-22 12:30:00'), end: at('2026-10-22 13:00:00'), attendees: [{ email: 'boss@example.com', responseStatus: 'declined' }, { self: true, responseStatus: 'accepted' }] },
      { id: 'g-dentist', summary: 'Dentist', start: at('2026-10-22 14:00:00'), end: at('2026-10-22 15:00:00'), location: '12 Herzl St', description: 'Bring the insurance card\nand the x-rays' },
      {
        // An Outlook or Teams invite's HTML: a table row, a heading, a paragraph.
        id: 'g-review', summary: 'Quarterly review', start: at('2026-10-22 15:00:00'), end: at('2026-10-22 15:45:00'), changed: 'C3',
        description: '<table><tr><td>Agenda</td><td>Budget</td></tr></table><h2>Join</h2><p>Room 4</p>',
      },
      { id: 'g-focus', summary: 'Focus time', start: at('2026-10-22 16:00:00'), end: at('2026-10-22 17:00:00'), eventType: 'focusTime', changed: 'C1' },
      { id: 'g-release', summary: 'Release window', start: at('2026-10-22 22:00:00'), end: at('2026-10-23 02:00:00') },
      { id: 'g-office', summary: 'Office', start: '2026-10-23', end: '2026-10-24', eventType: 'workingLocation', changed: 'C1' },
      {
        id: 'g-planning', summary: 'Planning', start: at('2026-10-23 10:00:00'), end: at('2026-10-23 11:00:00'), changed: 'C3',
        description: '<p>Agenda:</p><ul><li>Budget</li><li>Hiring</li></ul><a href="https://meet.example.com/abc">Join the call</a>',
      },
      { id: 'g-alarm', summary: 'Set the alarm', start: at('2026-10-24 23:59:00'), end: at('2026-10-24 23:59:00') },
      { id: 'g-away', summary: 'Out of office', start: at('2026-10-26 09:00:00'), end: at('2026-10-26 18:00:00'), eventType: 'outOfOffice', changed: 'C1' },
      { id: 'g-book_20261027', summary: 'Book club', start: at('2026-10-27 20:00:00'), end: at('2026-10-27 21:30:00'), recurringEventId: 'g-book' },
      ...instances('g-choir', 'Choir', ['2026-10-18', '2026-10-25', '2026-11-01', '2026-11-08'], '18:00', 90),
      ...instances('g-run', 'Morning run', daysFrom('2026-10-15', 27), '07:30', 30),
    ],
  },
  [TOM_CAL]: {
    summary: 'Tom',
    events: [
      { id: 'g-conference', summary: 'Design conference', start: '2026-10-21', end: '2026-10-24' },
      { id: 'g-home-office', summary: 'Home office', start: at('2026-10-22 08:00:00'), end: at('2026-10-22 17:00:00'), eventType: 'workingLocation', changed: 'C1' },
      { id: 'g-yoga', summary: 'Yoga', start: at('2026-10-22 18:00:00'), end: at('2026-10-22 19:00:00') },
      { id: 'g-gym', summary: 'Gym', start: at('2026-10-24 10:00:00'), end: at('2026-10-24 11:00:00') },
      { id: 'g-business-trip', summary: 'Business trip', start: '2026-10-27', end: '2026-10-30' },
    ],
  },
  [KIDS_CAL]: {
    summary: 'Noa',
    events: [
      { id: 'g-school', summary: 'School', start: at('2026-10-22 08:00:00'), end: at('2026-10-22 13:50:00'), location: 'Oak School' },
      { id: 'g-sleepover', summary: "Sleepover at Ben's", start: at('2026-10-23 18:00:00'), end: at('2026-10-24 10:00:00') },
      { id: 'g-party', summary: 'Class party', start: at('2026-10-23 22:00:00'), end: at('2026-10-24 02:00:00') },
      { id: 'g-trip', summary: 'Field trip', start: '2026-10-26', end: '2026-10-27' },
    ],
  },
  [FAMILY_CAL]: {
    summary: 'Family',
    events: [
      { id: 'g-soccer', summary: 'Soccer - Noa and Itai', start: at('2026-10-22 16:00:00'), end: at('2026-10-22 17:30:00'), location: 'City Park' },
      { id: 'g-flight', summary: 'Night flight', start: at('2026-10-25 00:30:00'), end: at('2026-10-25 03:00:00') },
      { id: 'g-brunch', summary: 'Brunch', start: at('2026-10-26 10:00:00'), end: at('2026-10-26 11:00:00') },
    ],
  },
  [BIRTHDAYS_CAL]: {
    summary: 'Birthdays',
    events: [{ id: 'g-bday', summary: "Grandma Ruth's birthday", start: '2026-10-24', end: '2026-10-25', eventType: 'birthday' }],
  },
  'ori@example.com': { summary: 'Ori', events: [{ id: 'g-ori', summary: 'Standup (Ori)', start: at('2026-10-22 09:00:00'), end: at('2026-10-22 09:30:00') }] },
  'shira@example.com': { summary: 'Shira', events: [{ id: 'g-shira', summary: 'Standup (Shira)', start: at('2026-10-22 09:00:00'), end: at('2026-10-22 09:30:00') }] },
  'maya@example.com': { summary: 'Maya', events: [{ id: 'g-maya', summary: 'Dentist (Maya)', start: at('2026-10-22 10:00:00'), end: at('2026-10-22 11:00:00') }] },
  'ella@example.com': {
    summary: 'Ella',
    events: [
      { id: 'g-ella-thu', summary: 'Dentist (Ella)', start: at('2026-10-22 10:00:00'), end: at('2026-10-22 11:00:00') },
      { id: 'g-ella-sun', summary: 'Pottery (Ella)', start: at('2026-10-25 10:00:00'), end: at('2026-10-25 11:00:00') },
      { id: 'g-ella-mon', summary: 'Haircut (Ella)', start: at('2026-10-26 10:00:00'), end: at('2026-10-26 11:00:00') },
    ],
  },
  // Not listed: yoni-old@…, avi-old1@… and avi-old2@… are gone (404).
};

/** The repeating events' masters, which the week lookahead asks for (events.get). */
const MASTERS: Record<string, string[]> = {
  'g-choir': ['RRULE:FREQ=WEEKLY;BYDAY=SU'],
  'g-run': ['RRULE:FREQ=DAILY'],
  'g-book': ['RRULE:FREQ=MONTHLY;BYDAY=4TU'],
};

/** The items C1/C2 take out of a Google read: what the old read lists and the reader doesn't. */
const DROPPED = new Set(Object.values(GOOGLE).flatMap(c => c.events.filter(e => e.changed === 'C1' || e.changed === 'C2')));
const DROPPED_IDS = new Set([...DROPPED].map(e => e.id));
const DROPPED_SUMMARIES = new Set([...DROPPED].map(e => e.summary));

// ---- Google's failures, as its clients throw them ----

const invalidGrant = () => Object.assign(new Error('invalid_grant'), {
  status: 400, response: { status: 400, data: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } },
});
const insufficientScopes = () => Object.assign(new Error('Request had insufficient authentication scopes.'), {
  code: 403, status: 403, response: { status: 403, data: { error: { code: 403, errors: [{ reason: 'insufficientPermissions' }] } } },
});
const rateLimited = () => Object.assign(new Error('Rate Limit Exceeded'), {
  code: 403, status: 403, response: { status: 403, data: { error: { code: 403, errors: [{ reason: 'rateLimitExceeded' }] } } },
});
const backendError = () => Object.assign(new Error('Backend Error'), { code: 500, status: 500, response: { status: 500 } });
const notFound = () => Object.assign(new Error('Not Found'), { code: 404, status: 404, response: { status: 404 } });

// ---- Users: every one an admin, so the ADMINS switch covers them ----

const cal = (calendarId: string, name: string, labels: CalendarLabel[], more: Partial<CalendarAssignment> = {}): CalendarAssignment =>
  ({ calendarId, labels, name, color: '#039BE5', ...more });

function person(id: number, name: string, extra: Record<string, unknown>): UserConfig {
  return {
    id, telegramId: 1000 + id, name, englishName: name, gender: 'female', language: 'en', culture: 'default',
    calendarSource: 'GOOGLE', googleRefreshToken: '', calendarAssignments: undefined, pairingId: null,
    isAdmin: true, messagingPlatform: 'telegram', whatsappPhone: null, whatsappBsuid: null,
    location: 'Tel Aviv', weatherEnabled: false, textSummaryEnabled: true, voiceSummaryEnabled: true,
    includeLookaheadInTomorrow: false, includeWeeklyInLookahead: true, lookaheadAlways7Days: false, globalRules: [],
    suspendedAt: null, unreachableSince: null, preferredMorningHour: 7, preferredEveningHour: 19,
    dailySummaryDays: [0, 1, 2, 3, 4, 5, 6], tomorrowSummaryDays: [0, 1, 2, 3, 4, 5, 6],
    ...extra,
  } as unknown as UserConfig;
}
const own = (calendarId: string, name: string) => [cal(calendarId, name, ['primary', 'yours'])];

/** FamCal, paired: own and kids' calendars, Raziel's shared one, and his private reminders for her. */
const DANA = person(1, 'Dana', { calendarSource: 'NATIVE', pairingId: 'pair-1', language: 'he', culture: 'jewish', includeLookaheadInTomorrow: true });
/** FamCal, solo. */
const NOAM = person(3, 'Noam', { calendarSource: 'NATIVE', gender: 'male', language: 'ru' });
/** Google, with yours, spouse, kids, family and birthdays calendars. */
const GALI = person(4, 'Gali', {
  googleRefreshToken: 'tok-gali', includeLookaheadInTomorrow: true,
  calendarAssignments: [
    cal(GALI_CAL, 'Gali', ['primary', 'yours']),
    cal(TOM_CAL, 'Tom', ['spouse'], { personName: 'Tom', personEnglishName: 'Tom', personGender: 'male' }),
    cal(KIDS_CAL, 'Noa', ['kids'], { personName: 'Noa' }),
    cal(FAMILY_CAL, 'Family', []),
    cal(BIRTHDAYS_CAL, 'Birthdays', ['birthdays']),
  ],
});
/** Google, still paired with Lior, a FamCal user who set him a reminder. */
const TOM = person(5, 'Tom', { gender: 'male', googleRefreshToken: 'tok-tom', pairingId: 'pair-2', calendarAssignments: own(TOM_CAL, 'Tom') });
/** Google, dead token. */
const ORI = person(7, 'Ori', { gender: 'male', googleRefreshToken: 'tok-ori', calendarAssignments: own('ori@example.com', 'Ori') });
/** Google, missing scopes. */
const SHIRA = person(8, 'Shira', { googleRefreshToken: 'tok-shira', calendarAssignments: own('shira@example.com', 'Shira') });
/** Google, one calendar gone. */
const YONI = person(9, 'Yoni', {
  gender: 'male', googleRefreshToken: 'tok-yoni',
  calendarAssignments: [cal('yoni-old@group.calendar.google.com', 'Old', []), cal(FAMILY_CAL, 'Family', [])],
});
const MAYA = person(10, 'Maya', { googleRefreshToken: 'tok-maya', calendarAssignments: own('maya@example.com', 'Maya') });
const ELLA = person(11, 'Ella', { googleRefreshToken: 'tok-ella', calendarAssignments: own('ella@example.com', 'Ella') });
/** Google, every chosen calendar gone. */
const AVI = person(12, 'Avi', {
  gender: 'male', googleRefreshToken: 'tok-avi',
  calendarAssignments: [cal('avi-old1@group.calendar.google.com', 'Old 1', []), cal('avi-old2@group.calendar.google.com', 'Old 2', [])],
});
// The week start by country: nothing to read, only their weeks' days.
const SAM = person(13, 'Sam', { gender: 'male', googleRefreshToken: 'tok-sam', calendarAssignments: [], location: 'Brooklyn' });
const OLIVIA = person(14, 'Olivia', { googleRefreshToken: 'tok-olivia', calendarAssignments: [], location: 'London' });
const KARIM = person(15, 'Karim', { gender: 'male', googleRefreshToken: 'tok-karim', calendarAssignments: [], location: 'Cairo' });

const USERS = [DANA, NOAM, GALI, TOM, ORI, SHIRA, YONI, MAYA, ELLA, AVI, SAM, OLIVIA, KARIM];
const nameOfChat = (chatId: unknown) => USERS.find(u => u.telegramId === Number(chatId))?.name ?? `chat ${String(chatId)}`;
const userOfChat = (chatId: unknown) => USERS.find(u => u.telegramId === Number(chatId));
const ownerOfToken = (token: string) => USERS.find(u => u.googleRefreshToken === token)?.name ?? `token ${token}`;
const TIMEZONES: Record<number, string> = { [SAM.id]: NY, [OLIVIA.id]: LONDON, [KARIM.id]: CAIRO };

// ---- The knobs a check turns ----

/** The rollout switch, as isCalendarHomeOn reads it. */
let rollout: 'OFF' | 'ADMINS' = 'OFF';
/** weekStartFor: today's rule (legacyWeekStart) for the parity checks, or the real one. */
let weekRule: 'legacy' | 'real' = 'legacy';
/** Every user's timezone, when set; otherwise their own. */
let zoneOverride: string | undefined;
/** The scheduled batch's users. */
let batch: UserConfig[] = [];
/** Leave the deliberate-change items out of Google, so both paths list the same. */
let hideChanged = false;
/** How long each token step takes on the fake clock. */
let tokenStepMs = 0;
/** How long a user's first timezone lookup takes (a Nominatim miss); later ones are cached. */
let timezoneLookupMs = 0;
const timezoneLooked = new Set<number>();
/** How long the AI takes to stream a summary. */
let aiStreamMs = 0;

/** An answer that comes after a while (on whichever timers run): a failure, or the calendar. */
type DelayedStep = { after: number; then: Error | 'ok' };
type GoogleStep = 'ok' | 'empty' | 'hang' | Error | DelayedStep;
const isDelayed = (step: GoogleStep): step is DelayedStep => typeof step === 'object' && !(step instanceof Error);
/**
 * What a refresh token's calls do, by their number (from 1): the token step, and each
 * calendar's lists. Unset: 'ok'.
 */
type GoogleBehaviour = { token?: (n: number) => GoogleStep; list?: (calendarId: string, n: number) => GoogleStep };
let behaviours: Record<string, GoogleBehaviour> = {};
/** Accounts that fail every call: a dead token, or permissions the user unticked. */
const ACCOUNT_STATE: Record<string, 'dead' | 'noScopes'> = { 'tok-ori': 'dead', 'tok-shira': 'noScopes' };
const callCounts = new Map<string, number>();
const nthCall = (key: string) => {
  const n = (callCounts.get(key) ?? 0) + 1;
  callCounts.set(key, n);
  return n;
};

const zoneOf = (u: { id: number }) => zoneOverride ?? TIMEZONES[u.id] ?? IL;

function reset(over: { now?: string; zone?: string } = {}) {
  log = [];
  prompts = [];
  captured = [];
  queries = [];
  timersAsked = [];
  behaviours = {};
  callCounts.clear();
  store.clear();
  rollout = 'ADMINS';
  weekRule = 'legacy';
  zoneOverride = undefined;
  batch = [];
  hideChanged = false;
  tokenStepMs = 0;
  timezoneLookupMs = 0;
  timezoneLooked.clear();
  aiStreamMs = 0;
  sentAt = [];
  clock = at(over.now ?? '2026-10-22 07:00:00', over.zone ?? IL).getTime();
}

// ---- The fake Google client ----

const local = (iso: string) => formatInTimeZone(new Date(iso), IL, 'MM-dd HH:mm');
const instantOf = (v: Date | string, tz: string) => (typeof v === 'string' ? startOfLocalDay(v, tz).getTime() : v.getTime());
const when = (v: Date | string, tz: string) => (typeof v === 'string' ? { date: v } : { dateTime: formatInTimeZone(v, tz, "yyyy-MM-dd'T'HH:mm:ssXXX") });

/** An event as events.list returns it, with times in the zone the request asked for. */
function rawEvent(e: GoogleFixture, tz: string) {
  return {
    id: e.id, status: 'confirmed', summary: e.summary, description: e.description, location: e.location,
    start: when(e.start, tz), end: when(e.end, tz),
    recurringEventId: e.recurringEventId, originalStartTime: e.recurringEventId ? when(e.start, tz) : undefined,
    eventType: e.eventType ?? 'default', attendees: e.attendees, reminders: e.reminders,
    htmlLink: `https://www.google.com/calendar/event?eid=${e.id}`,
  };
}

/** The OAuth client calendar.ts builds (new auth.OAuth2, setCredentials); the reader runs its token step first. */
class FakeOAuth2 {
  refreshToken = '';
  setCredentials(credentials: { refresh_token?: string | null }) {
    this.refreshToken = credentials.refresh_token ?? '';
  }
  async getAccessToken(): Promise<{ token: string }> {
    const token = this.refreshToken;
    log.push(`token ${ownerOfToken(token)}`);
    clock += tokenStepMs;
    if (ACCOUNT_STATE[token] === 'dead') throw invalidGrant();
    const step = behaviours[token]?.token?.(nthCall(`token|${token}`)) ?? 'ok';
    if (step === 'hang') return new Promise<never>(() => {});
    if (step instanceof Error) throw step;
    return { token: `access-${token}` };
  }
}

/** The calendar client both paths build from that OAuth client. */
function fakeCalendarClient({ auth }: { auth: FakeOAuth2 }) {
  const token = auth.refreshToken;
  const who = ownerOfToken(token);
  const gate = () => {
    if (ACCOUNT_STATE[token] === 'dead') throw invalidGrant();
    if (ACCOUNT_STATE[token] === 'noScopes') throw insufficientScopes();
  };
  return {
    calendars: {
      get: async ({ calendarId }: { calendarId: string }) => {
        log.push(`get ${who} ${calendarId}`);
        gate();
        const found = GOOGLE[calendarId];
        if (!found) throw notFound();
        return { data: { summary: found.summary } };
      },
    },
    events: {
      list: async (params: { calendarId: string; timeMin: string; timeMax: string; timeZone?: string }, options?: { timeout?: number }) => {
        log.push(`list ${who} ${params.calendarId} ${local(params.timeMin)}..${local(params.timeMax)} ${options?.timeout ?? 'untimed'}`);
        gate();
        let step = behaviours[token]?.list?.(params.calendarId, nthCall(`list|${token}|${params.calendarId}`)) ?? 'ok';
        if (isDelayed(step)) {
          // A request's own timeout cuts a slow answer off, as gaxios does.
          const { after, then } = step;
          const timeout = options?.timeout ?? Infinity;
          await new Promise(resolve => setTimeout(resolve, Math.min(after, timeout)));
          if (after > timeout) throw Object.assign(new Error(`network timeout at: ${params.calendarId}`), { type: 'request-timeout' });
          step = then;
        }
        if (step === 'hang') return new Promise<never>(() => {});
        if (step instanceof Error) throw step;
        const found = GOOGLE[params.calendarId];
        if (!found) throw notFound();
        const tz = params.timeZone ?? IL;
        const from = Date.parse(params.timeMin);
        const to = Date.parse(params.timeMax);
        // Google's rule: the event ends after timeMin and starts before timeMax.
        const items = step === 'empty' ? [] : found.events
          .filter(e => !(hideChanged && e.changed))
          .filter(e => instantOf(e.end, tz) > from && instantOf(e.start, tz) < to)
          .sort((a, b) => instantOf(a.start, tz) - instantOf(b.start, tz))
          .map(e => rawEvent(e, tz));
        return { data: { summary: found.summary, items } };
      },
      get: async ({ calendarId, eventId }: { calendarId: string; eventId: string }) => {
        log.push(`master ${who} ${eventId}`);
        gate();
        const recurrence = MASTERS[eventId];
        if (!recurrence || !GOOGLE[calendarId]) throw notFound();
        return { data: { recurrence } };
      },
    },
  };
}

// ---- Redis, in memory: dedup marks, the gone-warning gate, story texts ----

const store = new Map<string, string>();
const fakeRedis = {
  get: async (key: string) => {
    redisKeys.add(key);
    return store.get(key) ?? null;
  },
  set: async (key: string, value: unknown, opts?: { nx?: boolean; ex?: number }) => {
    redisKeys.add(key);
    if (opts?.nx && store.has(key)) return null;
    if (key.startsWith('summary:dedup:')) {
      const [, , type, userId, date] = key.split(':');
      log.push(`mark ${USERS.find(u => u.id === Number(userId))?.name} ${type} ${date}`);
    }
    store.set(key, String(value));
    return 'OK';
  },
  del: async (...keys: string[]) => keys.filter(k => store.delete(k)).length,
  mget: async (...keys: string[]) => keys.map(k => {
    redisKeys.add(k);
    return store.get(k) ?? null;
  }),
};

// ---- The bot's texts, read from the files the bot reads ----

type BotTexts = {
  errors: Record<string, string>;
  tokenExpired: { title: string; message: string };
  insufficientScopes: { title: string; message: string };
};
const BOT = Object.fromEntries(['en', 'he', 'ru'].map(lang => {
  const t = (JSON.parse(fs.readFileSync(path.resolve(__dirname, `../messages/${lang}.json`), 'utf8')) as { bot: BotTexts }).bot;
  return [lang, {
    token: `${t.tokenExpired.title}\n\n${t.tokenExpired.message}`,
    scopes: `${t.insufficientScopes.title}\n\n${t.insufficientScopes.message}`,
    unreachable: t.errors.googleUnreachable,
    outage: t.errors.googleOutageNote,
  }];
})) as Record<string, { token: string; scopes: string; unreachable: string; outage: string }>;

/** What the AI answers every prompt with. */
const AI_TEXT = 'Here is your day.';

/** A sent text by what it is, in its recipient's language. */
function kindOf(text: string, lang: string): string {
  const t = BOT[lang] ?? BOT.en;
  if (text === t.unreachable) return 'unreachable';
  if (text === t.token) return 'token';
  if (text === t.scopes) return 'scopes';
  if (text.startsWith(AI_TEXT)) return text.includes(t.outage) ? 'summary with outage line' : 'summary';
  return `other ${JSON.stringify(text.slice(0, 60))}`;
}
const langOfChat = (chatId: unknown) => userOfChat(chatId)?.language ?? 'en';

// ---- Telegram, the draft and the voice note ----

let nextMessageId = 1;
type ReplyMarkup = { inline_keyboard?: { web_app?: { url: string } }[][] };
function messagingService(via: 'telegram' | 'whatsapp') {
  return {
    sendMessage: async (chatId: number | string, text: string, options?: MessageOptions) => {
      const button = (options?.replyMarkup as ReplyMarkup | undefined)?.inline_keyboard?.[0]?.[0]?.web_app?.url ?? '';
      log.push(`send ${nameOfChat(chatId)} ${kindOf(text, langOfChat(chatId))}${button.includes('/refresh-token') ? ' + refresh button' : ''}${via === 'whatsapp' ? ' (WhatsApp)' : ''}`);
      sentAt.push(`send ${nameOfChat(chatId)} @${clock}`);
      return nextMessageId++;
    },
    updateMessage: async () => {},
    deleteMessage: async () => {},
    sendTypingIndicator: async () => {},
  };
}
const telegram = messagingService('telegram');
const whatsapp = messagingService('whatsapp');

/** An open streaming draft, as the Mini App's on-demand path hands one in. */
function draftFor(user: UserConfig): StreamMessageHandle {
  const lang = user.language ?? 'en';
  return {
    pushStage: () => {},
    pushDelta: () => {},
    finalize: async (text: string) => {
      log.push(`draft ${user.name} finalized: ${kindOf(text, lang)}`);
      sentAt.push(`draft ${user.name} @${clock}`);
      return nextMessageId++;
    },
    cancel: async (text: string) => {
      log.push(`draft ${user.name} replaced: ${kindOf(text, lang)}`);
    },
  };
}

// ---- The AI ----

const aiResult = (): AICompletionResult => ({
  text: AI_TEXT, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end_turn', model: 'fake-model', durationMs: 0,
});

// ---- Stubs: static imports go through Module._load, import() through a load hook ----

const SRC = path.resolve(__dirname, '../src');
type RealModule = Record<string, unknown>;
const stubs: Record<string, object | ((real: RealModule) => object)> = {
  '@googleapis/calendar': { __esModule: true, calendar: fakeCalendarClient, auth: { OAuth2: FakeOAuth2 } },
  [`${SRC}/utils/prisma.ts`]: { prisma: fakePrisma, withRetry: <T>(fn: () => Promise<T>) => fn() },
  [`${SRC}/utils/redis.ts`]: { redis: fakeRedis },
  [`${SRC}/services/calendar-read/rollout.ts`]: {
    isCalendarHomeOn: async (u: { isAdmin?: boolean | null }) => rollout === 'ADMINS' && u.isAdmin === true,
  },
  // The week start: the parity checks put weekStartFor on today's rule, so the switch
  // changes only how the week is read; the country check uses the real one.
  [`${SRC}/utils/locale-rules.ts`]: (real: RealModule) => {
    const rules = real as unknown as typeof import('../src/utils/locale-rules');
    return {
      ...real,
      weekStartFor: (f: Parameters<typeof rules.weekStartFor>[0]) => (weekRule === 'legacy' ? rules.legacyWeekStart(f.culture) : rules.weekStartFor(f)),
    };
  },
  [`${SRC}/lib/timezone.ts`]: {
    resolveUserTimezone: async (u: { id: number }) => {
      if (timezoneLookupMs > 0 && !timezoneLooked.has(u.id)) {
        timezoneLooked.add(u.id);
        await new Promise(resolve => setTimeout(resolve, timezoneLookupMs));
      }
      return zoneOf(u);
    },
  },
  [`${SRC}/services/user-service.ts`]: {
    getUserByIdentifier: async (id: number | string) => {
      const found = userOfChat(id);
      return found ? { ...found } : null;
    },
    getUserByTelegramId: async (id: number) => {
      const found = userOfChat(id);
      return found ? { ...found } : null;
    },
    getAllUsers: async () => batch.map(u => ({ ...u })),
    getWhatsAppChatId: (u: UserConfig) => u.whatsappPhone || u.whatsappBsuid || null,
    clearGoogleRefreshToken: async (telegramId: bigint) => {
      log.push(`cleared the token of ${String(telegramId)}`);
    },
  },
  [`${SRC}/services/ai-provider.ts`]: {
    generateAICompletion: async (prompt: string) => {
      prompts.push(prompt);
      return aiResult();
    },
    streamAICompletion: async (opts: { prompt: string; onTextDelta?: (delta: string, accumulated: string) => void | Promise<void> }) => {
      prompts.push(opts.prompt);
      if (aiStreamMs > 0) await new Promise(resolve => setTimeout(resolve, aiStreamMs));
      await opts.onTextDelta?.(AI_TEXT, AI_TEXT);
      return aiResult();
    },
  },
  [`${SRC}/services/hebrew-holidays.ts`]: { getHolidaysForDate: async () => [] },
  [`${SRC}/services/messaging/index.ts`]: {
    MessagingPlatform, MessageFormat,
    getMessagingService: (platform: MessagingPlatform) => (platform === MessagingPlatform.WHATSAPP ? whatsapp : telegram),
  },
  [`${SRC}/services/telegram/bot.ts`]: { getMessagingService: () => telegram },
  [`${SRC}/services/telegram/voice.ts`]: {
    sendVoiceMessage: async (chatId: number | string, text: string) => {
      log.push(`voice ${nameOfChat(chatId)}${text.includes(BOT[langOfChat(chatId)].outage) ? ' with outage line' : ''}`);
    },
    sendWeeklyVoiceMessage: async () => {},
  },
  [`${SRC}/services/analytics-service.ts`]: { trackActivityAsync: () => {}, addBreadcrumb: () => {} },
  [`${SRC}/services/subscription-service.ts`]: { checkFeatureAccess: async () => ({ allowed: true }), incrementUsage: async () => {} },
  [`${SRC}/services/kid-name-detection.ts`]: { sendKidNameFollowUp: async () => {} },
  [`${SRC}/services/magic-link.ts`]: { generateMagicLink: async () => 'https://famcal.test/magic' },
  [`${SRC}/lib/error-capture.ts`]: {
    captureError: (error: unknown, context: string, _extra?: unknown, severity = 'error') => {
      captured.push(`${context} ${severity} ${error instanceof Error ? error.message : String(error)}`);
    },
    captureWarning: (message: string, context: string) => {
      captured.push(`${context} warning ${message}`);
    },
    captureInfo: () => {},
  },
  [`${SRC}/utils/error-notifier.ts`]: {
    notifyAdminWarning: async (title: string) => {
      log.push(`admin warning ${title}`);
    },
    notifyAdminError: async (title: string) => {
      log.push(`admin error ${title}`);
      adminErrors.push(title);
    },
  },
};

const ModuleInternals = Module as unknown as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  _resolveFilename: (request: string, parent: unknown, isMain: boolean) => string;
};
// @hebcal/core is ESM-only and tsx loads src/ as CommonJS (see smoke-week-lookahead.ts).
const resolveFilename = ModuleInternals._resolveFilename;
ModuleInternals._resolveFilename = function (request, parent, isMain) {
  if (request === '@hebcal/core') return path.resolve(__dirname, '../node_modules/@hebcal/core/dist/esm/index.js');
  return resolveFilename.call(this, request, parent, isMain);
};

/** A partial fake is built once from the real module, then served to require() and import() alike. */
const built = new Map<string, object>();
const loadingReal = new Set<string>();
function fakeFor(key: string, loadReal: () => unknown): object {
  const stub = stubs[key];
  if (typeof stub !== 'function') return stub;
  if (!built.has(key)) {
    loadingReal.add(key);
    try {
      built.set(key, stub(loadReal() as RealModule));
    } finally {
      loadingReal.delete(key);
    }
  }
  return built.get(key)!;
}

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

// summary.ts and commands.ts load the timezone, the user service, Redis, the notifier,
// the magic link and the kid-name follow-up with import(), which goes through the ES
// module loader; each gets the same fake, as an ES module.
(globalThis as { paritySmokeFake?: (file: string) => object }).paritySmokeFake = file =>
  fakeFor(file, () => realLoad.call(Module, file, null, false));
if (typeof Module.registerHooks !== 'function') throw new Error('This smoke needs Node 22.15+ (module.registerHooks)');
Module.registerHooks({
  load(url, context, nextLoad) {
    const file = url.startsWith('file:') ? fileURLToPath(url.split('?')[0]) : '';
    if (!(file in stubs) || loadingReal.has(file)) return nextLoad(url, context);
    const fake = (globalThis as unknown as { paritySmokeFake: (file: string) => object }).paritySmokeFake(file);
    const names = Object.keys(fake).map(name => `export const ${name} = fake[${JSON.stringify(name)}];`).join('\n');
    return { format: 'module', shortCircuit: true, source: `const fake = globalThis.paritySmokeFake(${JSON.stringify(file)});\n${names}\n` };
  },
});

// ---- Helpers over the log ----

/** The log with each read's run of list calls folded into one line: "list <who> ×<n> <window> <timeout>". */
function folded(lines: readonly string[] = log): string[] {
  const out: string[] = [];
  let runKey = '';
  let runCount = 0;
  // A last empty line flushes the final run.
  for (const line of [...lines, '']) {
    const m = /^list (\S+) \S+ (.+)$/.exec(line);
    const key = m ? `${m[1]} ${m[2]}` : '';
    if (key && key === runKey) {
      runCount++;
      continue;
    }
    if (runKey) out.push(`list ${runKey.replace(' ', ` ×${runCount} `)}`);
    runKey = key;
    runCount = key ? 1 : 0;
    if (!key && line !== '') out.push(line);
  }
  return out;
}
/** What summary.ts itself reported to Sentry; the reader's own warnings are checked where they matter. */
const reportedBySummary = () => captured.filter(c => c.startsWith('summary-'));
/** Let fire-and-forget work (the reader's gone warning, voice notes) finish. */
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
};

async function main() {
  const original = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  const keep = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };
  Object.assign(console, { log: keep, error: keep, warn: keep, info: keep });

  const summary = await import('../src/services/telegram/summary');
  const commands = await import('../src/services/telegram/commands');
  const { getWeekLookahead, getNextWeekLookahead } = await import('../src/services/week-lookahead');
  const { getCalendarAssignmentsForUser } = await import('../src/services/calendar-provider/user-calendars');
  summary.__setScheduledRetrySleepForTests(async (ms: number) => {
    log.push(`sleep ${ms}`);
    clock += ms;
  });

  const CLOCKS = [
    { name: 'Thursday 07:00', local: '2026-10-22 07:00:00' },
    { name: 'Thursday 19:00', local: '2026-10-22 19:00:00' },
    { name: 'Friday 00:30', local: '2026-10-23 00:30:00' },
    { name: 'Saturday 19:00', local: '2026-10-24 19:00:00' },
    { name: "Sunday 25 October 07:00, Israel's 25-hour day", local: '2026-10-25 07:00:00' },
  ];

  // ---- (a) Same events: the provider's day and the reader's, shaped ----

  type DayRead = { events: CalendarEvent[] } | { error: string };
  /** One day read as the summary makes it: the resolved ids, the wrapper, then shapeEventsForDay. */
  async function dayRead(user: UserConfig, kind: 'today' | 'tomorrow', zone: string): Promise<{ day: string; read: DayRead }> {
    const ids = (await getCalendarAssignmentsForUser(user)).map(a => a.calendarId);
    const today = localDate(new Date(), zone);
    const day = kind === 'today' ? today : nextDate(today);
    const fetchDay = kind === 'today' ? summary.fetchTodayEvents : summary.fetchTomorrowEvents;
    try {
      return { day, read: { events: shapeEventsForDay(await fetchDay(user, ids, zone, day), day, zone) } };
    } catch (err) {
      return { day, read: { error: err instanceof Error ? err.message : String(err) } };
    }
  }

  const normalized = { dropped: 0, descriptions: 0, reminders: 0 };
  /** The old Google read with only the deliberate changes applied: C1/C2 items out, C3 descriptions as plain text, no `reminders`. */
  function normalizeGoogle(events: CalendarEvent[]): CalendarEvent[] {
    return events.flatMap(e => {
      if (DROPPED_IDS.has(e.eventId ?? '')) {
        normalized.dropped++;
        return [];
      }
      const copy: CalendarEvent = { ...e };
      if ('reminders' in copy) {
        if (copy.reminders) normalized.reminders++;
        delete copy.reminders;
      }
      if (copy.description !== undefined) {
        const plain = htmlToText(copy.description) || undefined;
        if (plain !== copy.description) normalized.descriptions++;
        copy.description = plain;
      }
      return [copy];
    });
  }

  /** The new side's shaped lines in Israel, for the coverage check: "<user> <day> <title> [<span>]". */
  const shapedLines = new Set<string>();
  const mismatches: string[] = [];
  let comparisons = 0;
  let tomQueries = 0;
  const tomEvents: CalendarEvent[] = [];

  for (const zone of [IL, NY]) {
    for (const c of CLOCKS) {
      for (const user of [DANA, NOAM, GALI, TOM, YONI, AVI, ORI, SHIRA]) {
        for (const kind of ['today', 'tomorrow'] as const) {
          reset({ now: c.local, zone });
          zoneOverride = zone;
          rollout = 'OFF';
          const before = await dayRead(user, kind, zone);
          rollout = 'ADMINS';
          queries = [];
          const after = await dayRead(user, kind, zone);
          if (user === TOM) tomQueries += queries.length;
          comparisons++;
          const where = `${user.name}, ${kind} (${after.day}) at ${c.name} in ${zone}`;
          if ('error' in before.read || 'error' in after.read) {
            if (show(before.read) !== show(after.read)) mismatches.push(`${where}: ${show(before.read)} became ${show(after.read)}`);
            continue;
          }
          const want = user.calendarSource === 'NATIVE' ? before.read.events : normalizeGoogle(before.read.events);
          if (!isDeepStrictEqual(want, after.read.events)) {
            mismatches.push(`${where}:\n       provider ${show(want)}\n       reader   ${show(after.read.events)}`);
          }
          if (user === TOM) tomEvents.push(...after.read.events);
          if (zone === IL) {
            for (const e of after.read.events) shapedLines.add(`${user.name} ${after.day} ${e.summary}${e.daySpan ? ` [${e.daySpan}]` : ''}`);
          }
        }
      }
    }
  }

  await check('(a) same events: the reader\'s day, shaped, is the provider\'s for every user, zone (Israel, New York), clock and today/tomorrow (FamCal strictly)', async () => {
    assert(comparisons === 160, `${comparisons} comparisons`);
    assert(mismatches.length === 0, `${mismatches.length} of ${comparisons} differ; the first:\n     ${mismatches[0]}`);
  });

  await check('(a) the normalization had work to do: the old Google read listed C1/C2 items, an HTML description and reminders the reader leaves out', async () => {
    assert(normalized.dropped > 0 && normalized.descriptions > 0 && normalized.reminders > 0, `normalized ${show(normalized)}`);
  });

  await check('(a) the fixtures reach the shaping: overnight, sleepover, multi-day all-day, zero-length at 00:00 and 23:59, the 25-hour day, partner reminders', async () => {
    const want = [
      "Dana 2026-10-22 Sleepover at Ben's [endsLater]",
      "Dana 2026-10-23 Sleepover at Ben's [continues]",
      'Dana 2026-10-23 Movie marathon [endsLater]',
      'Dana 2026-10-23 Lock the car',
      'Dana 2026-10-24 Take out the recycling',
      'Dana 2026-10-24 Hiking trip [endsLater]',
      'Dana 2026-10-25 Hiking trip [continues]',
      'Dana 2026-10-25 Night shift',
      'Dana 2026-10-22 Buy milk',
      'Dana 2026-10-24 Pick up the cake',
      'Noam 2026-10-24 Galilee trip [spansDay]',
      'Noam 2026-10-24 Water the garden',
      'Gali 2026-10-22 Design conference [spansDay]',
      'Gali 2026-10-22 Release window [endsLater]',
      'Gali 2026-10-23 Class party [endsLater]',
      "Gali 2026-10-24 Sleepover at Ben's [continues]",
      "Gali 2026-10-24 Grandma Ruth's birthday",
      'Gali 2026-10-24 Set the alarm',
      'Gali 2026-10-25 Night flight',
      'Yoni 2026-10-22 Soccer - Noa and Itai',
    ];
    const missing = want.filter(line => !shapedLines.has(line));
    assert(missing.length === 0, `not seen: ${show(missing)}`);
    // Last night's short tail is dropped on its second day (the 06:00 rule).
    const dropped = ['Dana 2026-10-24 Movie marathon [continues]', 'Gali 2026-10-24 Class party [continues]', 'Noam 2026-10-23 Late call [continues]'];
    const seen = dropped.filter(line => shapedLines.has(line));
    assert(seen.length === 0, `kept past 06:00: ${show(seen)}`);
  });

  await check('(a) a Google user still paired with a FamCal partner gets no FamCal item, and his reads make no database query (A-2, R3)', async () => {
    assert(tomEvents.length > 0, 'Tom read nothing');
    const famcal = tomEvents.filter(e => e.calendarId.startsWith('native:') || e.summary === 'Pick up the dry cleaning');
    assert(famcal.length === 0, `FamCal items: ${show(famcal)}`);
    assert(tomQueries === 0, `${tomQueries} database queries`);
  });

  // ---- (b) Same prompts, byte for byte ----

  /** The prompt one summary builds, with the switch as set. */
  async function promptOf(user: UserConfig, kind: 'today' | 'tomorrow', setting: 'OFF' | 'ADMINS'): Promise<string> {
    rollout = setting;
    prompts = [];
    const tomorrowFlag = kind === 'tomorrow' ? new Date(clock + 86_400_000) : undefined;
    await summary.prepareSummaryForUser(user, kind === 'today' ? summary.fetchTodayEvents : summary.fetchTomorrowEvents, tomorrowFlag);
    assert(prompts.length === 1, `${prompts.length} prompts`);
    return prompts[0];
  }
  const PROMPT_RUNS = [
    { name: 'the daily on Thursday 07:00', local: '2026-10-22 07:00:00', kind: 'today' as const },
    { name: 'the tomorrow summary on Thursday 19:00', local: '2026-10-22 19:00:00', kind: 'tomorrow' as const },
    { name: 'the tomorrow summary on Friday 19:00', local: '2026-10-23 19:00:00', kind: 'tomorrow' as const },
    { name: 'the daily on Sunday 25 October 07:00', local: '2026-10-25 07:00:00', kind: 'today' as const },
  ];
  const promptsSeen: Record<string, string[]> = { Dana: [], Gali: [] };
  for (const user of [DANA, GALI]) {
    await check(`(b) same prompts: ${user === DANA ? 'the paired FamCal user with reminders' : 'the Google user with yours/spouse/kids/birthday calendars'}, daily and tomorrow (with its week block), byte-identical with the switch on`, async () => {
      for (const run of PROMPT_RUNS) {
        reset({ now: run.local });
        hideChanged = true;
        const off = await promptOf(user, run.kind, 'OFF');
        const on = await promptOf(user, run.kind, 'ADMINS');
        const a = off.split('\n');
        const b = on.split('\n');
        const at = a.findIndex((line, i) => line !== b[i]);
        assert(off === on, `${run.name}: line ${at + 1}\n     off ${JSON.stringify(a[at])}\n     on  ${JSON.stringify(b[at])}`);
        promptsSeen[user.name].push(on);
      }
    });
  }

  await check('(b) the prompts show what they compare: reminders and their guideline, carry-overs, the spouse, kids, a birthday, the week block', async () => {
    const dana = promptsSeen.Dana.join('\n');
    const gali = promptsSeen.Gali.join('\n');
    const needles: [string, string][] = [
      [dana, 'Buy milk'], [dana, 'Call the plumber'], [dana, 'Pilates'], [dana, 'Swimming'], [dana, '- **תזכורות**'],
      [gali, 'Team standup'], [gali, '[Calendar: Tom]'], [gali, 'School'], [gali, "Grandma Ruth's birthday"],
      [gali, 'WEEK LOOKAHEAD (events after tomorrow)'], [gali, 'Night flight'],
    ];
    const missing = needles.filter(([text, needle]) => !text.includes(needle)).map(([, needle]) => needle);
    assert(missing.length === 0, `not in the prompts: ${show(missing)}`);
  });

  await check('(b) an Outlook/Teams HTML description (a table row, a heading, a paragraph) keeps its words apart: on separate lines in the reader\'s event, as separate words in the switch-on prompt', async () => {
    reset();
    rollout = 'ADMINS';
    const ids = (await getCalendarAssignmentsForUser(GALI)).map(a => a.calendarId);
    const review = (await summary.fetchTodayEvents(GALI, ids, IL, '2026-10-22')).find(e => e.eventId === 'g-review');
    assert(review?.description === 'Agenda Budget\nJoin\nRoom 4', `the reader's description ${show(review?.description)}`);
    prompts = [];
    await summary.prepareSummaryForUser(GALI, summary.fetchTodayEvents, undefined);
    // The prompt's own sanitizing turns a description's line breaks into spaces (A-13, unchanged).
    const line = prompts[0]?.split('\n').find(l => l.includes('Description: Agenda'))?.trim();
    assert(line === 'Description: Agenda Budget Join Room 4', `the prompt's line ${show(line)}`);
    assert(!/AgendaBudget|BudgetJoin|JoinRoom/.test(prompts[0] ?? ''), 'words run together in the prompt');
  });

  // ---- (c) /week and /nextweek ----

  await check('(c) /week and /nextweek with weekStartFor on legacyWeekStart: the same events with the switch on (FamCal paired, FamCal solo, Google, Google still paired; Thursday, Saturday, Sunday)', async () => {
    const got: string[] = [];
    for (const local of ['2026-10-22 07:00:00', '2026-10-24 19:00:00', '2026-10-25 07:00:00']) {
      for (const user of [DANA, NOAM, GALI, TOM]) {
        const calendars = await getCalendarAssignmentsForUser(user);
        for (const [command, read] of [['/week', getWeekLookahead], ['/nextweek', getNextWeekLookahead]] as const) {
          reset({ now: local });
          rollout = 'OFF';
          const off = await read(user, calendars);
          rollout = 'ADMINS';
          log = [];
          const on = await read(user, calendars);
          const listing = (l: WeekLookahead, drop: boolean) =>
            show({ ...l, events: l.events.filter(e => !(drop && DROPPED_SUMMARIES.has(e.summary))) });
          const where = `${user.name} ${command} at ${local}`;
          if (listing(off, user.calendarSource === 'GOOGLE') !== listing(on, false)) {
            got.push(`${where}:\n       off ${listing(off, true)}\n       on  ${listing(on, false)}`);
          }
          if (user.calendarSource === 'GOOGLE' && (!log.some(l => l.startsWith('token ')) || log.some(l => l.startsWith('get ')))) {
            got.push(`${where}: the switch-on read did not go through the reader: ${show(log)}`);
          }
          if (local === '2026-10-22 07:00:00' && on.events.length === 0) got.push(`${where}: nothing listed`);
        }
      }
    }
    assert(got.length === 0, `${got.length} differ:\n     ${got.join('\n     ')}`);
  });

  await check('(c) with the real rule, from Saturday and Sunday: New York and Israel (default culture) Sun-Sat, London Mon-Sun, Cairo Sat-Fri; with the switch off, all Mon-Sun', async () => {
    const day = (d: Date, tz: string) => formatInTimeZone(d, tz, 'EEE d');
    /** /week's last day and /nextweek's days, from `local` on the user's clock. */
    const weeks = async (user: UserConfig, local: string, setting: 'OFF' | 'ADMINS') => {
      const tz = zoneOf(user);
      reset({ now: local, zone: tz });
      weekRule = 'real';
      rollout = setting;
      const week = await getWeekLookahead(user, []);
      const next = await getNextWeekLookahead(user, []);
      return `/week to ${day(week.dateRange.end, tz)}, /nextweek ${day(next.dateRange.start, tz)} to ${day(next.dateRange.end, tz)}`;
    };
    const israeli = { ...GALI, calendarAssignments: [] } as UserConfig;
    const got: string[] = [];
    for (const [when, local] of [['Saturday', '2026-10-24 19:00:00'], ['Sunday', '2026-10-25 07:00:00']]) {
      for (const [place, user] of [['New York', SAM], ['Israel', israeli], ['London', OLIVIA], ['Cairo', KARIM]] as const) {
        got.push(`${place} ${when}: on ${await weeks(user, local, 'ADMINS')} | off ${await weeks(user, local, 'OFF')}`);
      }
    }
    assertList(got, [
      'New York Saturday: on /week to Sat 24, /nextweek Sun 25 to Sat 31 | off /week to Sun 25, /nextweek Mon 26 to Sun 1',
      'Israel Saturday: on /week to Sat 24, /nextweek Sun 25 to Sat 31 | off /week to Sun 25, /nextweek Mon 26 to Sun 1',
      'London Saturday: on /week to Sun 25, /nextweek Mon 26 to Sun 1 | off /week to Sun 25, /nextweek Mon 26 to Sun 1',
      'Cairo Saturday: on /week to Fri 30, /nextweek Sat 31 to Fri 6 | off /week to Sun 25, /nextweek Mon 26 to Sun 1',
      'New York Sunday: on /week to Sat 31, /nextweek Sun 1 to Sat 7 | off /week to Sun 25, /nextweek Mon 26 to Sun 1',
      'Israel Sunday: on /week to Sat 31, /nextweek Sun 1 to Sat 7 | off /week to Sun 25, /nextweek Mon 26 to Sun 1',
      'London Sunday: on /week to Sun 25, /nextweek Mon 26 to Sun 1 | off /week to Sun 25, /nextweek Mon 26 to Sun 1',
      'Cairo Sunday: on /week to Fri 30, /nextweek Sat 31 to Fri 6 | off /week to Sun 25, /nextweek Mon 26 to Sun 1',
    ], 'the weeks');
  });

  // ---- (d) Outcomes ----

  const tg = (u: UserConfig) => u.telegramId as number;
  /** The user-facing part of the log: sends, drafts, voice notes, marks, admin notices, cleared tokens. */
  const facing = () => log.filter(l => !/^(token|list|get|master|sleep) /.test(l));

  await check('(d) a dead token (invalid_grant): on demand the token text, scheduled the token text with the refresh button, an admin warning, no dedup mark; as with the switch off', async () => {
    const outcomes: Record<string, string[]> = {};
    for (const setting of ['OFF', 'ADMINS'] as const) {
      reset();
      rollout = setting;
      await summary.sendDailySummaryToUser(tg(ORI));
      const onDemand = facing();
      const onDemandGoogle = log.filter(l => /^(token|list|get) /.test(l));
      reset();
      rollout = setting;
      batch = [ORI];
      await summary.sendDailySummaryToAll({ filterByHour: true });
      outcomes[setting] = [...onDemand, '|', ...facing()];
      if (setting === 'ADMINS') {
        assertList([...onDemandGoogle, '|', ...log.filter(l => /^(token|list|get) /.test(l))], ['token Ori', '|', 'token Ori'], 'the reader\'s Google calls');
      }
    }
    assertList(outcomes.ADMINS, ['send Ori token', 'admin warning Token Expired', '|', 'send Ori token + refresh button', 'admin warning Token Expired'], 'switch on');
    assertList(outcomes.OFF, outcomes.ADMINS, 'switch off vs on');
  });

  await check('(d) missing scopes: on demand the scopes text, the token cleared by Telegram id and an admin warning; scheduled Sentry only; as with the switch off', async () => {
    const outcomes: Record<string, string[]> = {};
    for (const setting of ['OFF', 'ADMINS'] as const) {
      reset();
      rollout = setting;
      await summary.sendDailySummaryToUser(tg(SHIRA));
      const onDemand = facing();
      reset();
      rollout = setting;
      batch = [SHIRA];
      await summary.sendDailySummaryToAll({ filterByHour: true });
      outcomes[setting] = [...onDemand, '|', ...facing(), ...reportedBySummary()];
    }
    assertList(outcomes.ADMINS, [
      'send Shira scopes', 'cleared the token of 1008', 'admin warning Insufficient Scopes', '|', 'summary-batch-user error GOOGLE_INSUFFICIENT_SCOPES',
    ], 'switch on');
    assertList(outcomes.OFF, outcomes.ADMINS, 'switch off vs on');
  });

  /** The empty-retry run of the next check, which the check after it reads too. */
  let emptyRetry: { log: string[]; timers: number[] } = { log: [], timers: [] };

  await check('(d) rate limit on every calendar, scheduled: set aside, one retry on the first attempt\'s day with 15,000 ms, then the summary with the outage line, its guideline and the dedup mark, and no week-block Google read', async () => {
    // The tomorrow summary on Thursday 19:00 (Friday's, with the week block).
    reset({ now: '2026-10-22 19:00:00' });
    behaviours[GALI.googleRefreshToken] = { list: () => rateLimited() };
    batch = [GALI];
    await summary.sendTomorrowSummaryToAll({ filterByHour: true });
    await settle();
    const outageLog = folded();
    const outageTimers = longTimers();
    const outagePrompt = prompts;
    const outageReports = reportedBySummary();
    // The same run, but the retry gets an empty Google: the empty-day prompt.
    reset({ now: '2026-10-22 19:00:00' });
    behaviours[GALI.googleRefreshToken] = { list: (_id, n) => (n === 1 ? rateLimited() : 'empty') };
    batch = [GALI];
    await summary.sendTomorrowSummaryToAll({ filterByHour: true });
    const emptyPrompt = prompts;
    emptyRetry = { log: folded().filter(l => !l.startsWith('master ')), timers: longTimers() };
    assertList(outageLog, [
      'token Gali',
      'list Gali ×5 10-23 00:00..10-24 00:00 10000',
      'sleep 30000',
      'token Gali',
      'list Gali ×5 10-23 00:00..10-24 00:00 10000',
      'send Gali summary with outage line',
      'voice Gali with outage line',
      'mark Gali tomorrow 2026-10-22',
    ], 'the run');
    assertList(outageTimers.map(String), ['30000', '15000'], "the reader's deadlines");
    assertList(outageReports, [
      'summary-google-retry warning 1 scheduled summaries set aside for a Google retry',
      'summary-google-outage warning GOOGLE_FETCH_FAILED',
    ], 'what summary.ts reported');
    assert(outagePrompt.length === 1 && emptyPrompt.length === 1, `prompts ${outagePrompt.length}, ${emptyPrompt.length}`);
    const a = emptyPrompt[0].split('\n');
    const b = outagePrompt[0].split('\n');
    const added = b.findIndex((line, i) => line !== a[i]);
    assert(b.length === a.length + 1 && added >= 0 && show([...b.slice(0, added), ...b.slice(added + 1)]) === show(a), `the outage prompt is not the empty-day prompt plus one line (${a.length} -> ${b.length} lines)`);
    assert(b[added].startsWith('- **'), `the added line is not a guideline: ${b[added]}`);
  });

  await check('(d) scheduled reads carry their deadline to the week block: 30,000 ms on the first attempt, 15,000 ms on the retry, with no quick retry', async () => {
    reset({ now: '2026-10-22 19:00:00' });
    batch = [GALI];
    await summary.sendTomorrowSummaryToAll({ filterByHour: true });
    await settle();
    // The week block runs from Friday noon to the end of Sunday (Monday weeks, as today).
    assertList([...folded().filter(l => !l.startsWith('master ')), '|', ...longTimers().map(String)], [
      'token Gali',
      'list Gali ×5 10-23 00:00..10-24 00:00 10000',
      'token Gali',
      'list Gali ×5 10-23 12:00..10-26 00:00 10000',
      'send Gali summary',
      'voice Gali',
      'mark Gali tomorrow 2026-10-22',
      '|', '30000', '30000',
    ], 'a first attempt that reads');
    assertList([...emptyRetry.log, '|', ...emptyRetry.timers.map(String)], [
      'token Gali',
      'list Gali ×5 10-23 00:00..10-24 00:00 10000',
      'sleep 30000',
      'token Gali',
      'list Gali ×5 10-23 00:00..10-24 00:00 10000',
      'token Gali',
      'list Gali ×5 10-23 12:00..10-26 00:00 10000',
      'send Gali summary',
      'voice Gali',
      'mark Gali tomorrow 2026-10-22',
      '|', '30000', '15000', '15000',
    ], 'a retry that reads');
  });

  await check('(d) rate limit on every calendar, on demand: one quick retry at 8,000 ms inside the operation, then R13\'s text, no admin notice', async () => {
    reset();
    behaviours[GALI.googleRefreshToken] = { list: () => rateLimited() };
    await summary.sendDailySummaryToUser(tg(GALI));
    assertList(folded(), [
      'token Gali',
      'list Gali ×5 10-22 00:00..10-23 00:00 9500',
      'token Gali',
      'list Gali ×5 10-22 00:00..10-23 00:00 7500',
      'send Gali unreachable',
    ], 'the run');
    assertList(longTimers().map(String), ['50000', '10000', '1000', '8000'], 'the pipeline\'s limit, the deadline, the pause, the retry\'s deadline');
    assert(prompts.length === 0, 'the AI was asked');
  });

  await check('(d) rate limit on every calendar, /week: the same quick retry, then R13\'s text, no admin notice', async () => {
    reset();
    behaviours[GALI.googleRefreshToken] = { list: () => rateLimited() };
    await commands.handleLookaheadCommand(tg(GALI), tg(GALI), MessagingPlatform.TELEGRAM);
    assertList(folded(), [
      'token Gali',
      'list Gali ×5 10-22 07:00..10-26 00:00 9500',
      'token Gali',
      'list Gali ×5 10-22 07:00..10-26 00:00 7500',
      'send Gali unreachable',
    ], 'the run');
    assertList(longTimers().map(String), ['50000', '10000', '1000', '8000'], 'the pipeline\'s limit, the deadline, the pause, the retry\'s deadline');
  });

  await check('(d) a fast 500 on demand that the quick retry gets past: the summary, delivered by onSuccess', async () => {
    reset();
    behaviours[GALI.googleRefreshToken] = { list: (_id, n) => (n === 1 ? backendError() : 'ok') };
    await summary.sendDailySummaryToUser(tg(GALI));
    await settle();
    assertList(folded(), [
      'token Gali',
      'list Gali ×5 10-22 00:00..10-23 00:00 9500',
      'token Gali',
      'list Gali ×5 10-22 00:00..10-23 00:00 7500',
      'send Gali summary',
      'voice Gali',
    ], 'the run');
    assert(prompts.length === 1 && prompts[0].includes('Team standup'), 'the retry\'s events are not in the prompt');
  });

  await check('(d) a hanging token server on demand: a timeout gets no quick retry, and R13\'s text replaces the draft within 50 s, with no admin notice', async () => {
    reset();
    behaviours[GALI.googleRefreshToken] = { token: () => 'hang' };
    const started = performance.now();
    await summary.sendDailySummaryToUser(tg(GALI), MessagingPlatform.TELEGRAM, draftFor(GALI));
    const seconds = (performance.now() - started) / 1000;
    assertList(folded(), ['token Gali', 'draft Gali replaced: unreachable'], 'the run');
    assertList(longTimers().map(String), ['50000', '10000'], "the pipeline's limit and the reader's deadline");
    assert(seconds >= 9.5 && seconds < 50, `R13's text after ${seconds.toFixed(1)} s`);
  });

  await check('(d) scheduled, a retry that gets invalid_grant: the token text with the refresh button and an admin warning, no outage line, no dedup mark', async () => {
    reset();
    behaviours[MAYA.googleRefreshToken] = { token: n => (n === 1 ? 'ok' : invalidGrant()), list: () => rateLimited() };
    batch = [MAYA];
    await summary.sendDailySummaryToAll({ filterByHour: true });
    assertList(folded(), [
      'token Maya',
      'list Maya ×1 10-22 00:00..10-23 00:00 10000',
      'sleep 30000',
      'token Maya',
      'send Maya token + refresh button',
      'admin warning Token Expired',
    ], 'the run');
    assertList(reportedBySummary(), [
      'summary-google-retry warning 1 scheduled summaries set aside for a Google retry',
      'summary-batch-user error GOOGLE_TOKEN_EXPIRED',
    ], 'what summary.ts reported');
  });

  await check('(d) scheduled, a retry that crosses local midnight reads and shapes the first attempt\'s day', async () => {
    // The tomorrow summary at 23:59:50 on Saturday is Sunday's; the retry runs on Sunday.
    reset({ now: '2026-10-24 23:59:50' });
    behaviours[ELLA.googleRefreshToken] = { list: (_id, n) => (n === 1 ? rateLimited() : 'ok') };
    batch = [ELLA];
    await summary.sendTomorrowSummaryToAll();
    await settle();
    assertList(folded(), [
      'token Ella',
      'list Ella ×1 10-25 00:00..10-26 00:00 10000',
      'sleep 30000',
      'token Ella',
      'list Ella ×1 10-25 00:00..10-26 00:00 10000',
      'send Ella summary',
      'voice Ella',
    ], 'the run');
    assert(prompts.length === 1 && prompts[0].includes('Pottery (Ella)') && !prompts[0].includes('Haircut (Ella)'), 'the prompt is not Sunday\'s');
  });

  await check('(d) the week block alone fails (a rate limit after a good day read), scheduled: the tomorrow summary goes out without the block and without the outage line, marked sent, with no retry; Sentry has the block\'s warning (A-28)', async () => {
    reset({ now: '2026-10-22 19:00:00' });
    behaviours[GALI.googleRefreshToken] = { list: (_id, n) => (n === 1 ? 'ok' : rateLimited()) };
    batch = [GALI];
    await summary.sendTomorrowSummaryToAll({ filterByHour: true });
    await settle();
    assertList([...folded().filter(l => !l.startsWith('master ')), '|', ...longTimers().map(String)], [
      'token Gali',
      'list Gali ×5 10-23 00:00..10-24 00:00 10000',
      'token Gali',
      'list Gali ×5 10-23 12:00..10-26 00:00 10000',
      'send Gali summary',
      'voice Gali',
      'mark Gali tomorrow 2026-10-22',
      '|', '30000', '30000',
    ], 'the run');
    assert(prompts.length === 1 && !prompts[0].includes('WEEK LOOKAHEAD'), 'the prompt has a week block');
    assertList(reportedBySummary(), ['summary-week-lookahead warning GOOGLE_FETCH_FAILED'], 'what summary.ts reported');
  });

  await check('(d) on demand, the tomorrow summary with its week block, each read rate-limited after 4.9 s and answered on the quick retry after 7.4 s, a 2 s timezone lookup and a 20 s AI stream: onSuccess delivers it at 48.6 s, inside the 50 s limit, with no admin notice', async () => {
    reset({ now: '2026-10-22 19:00:00' });
    timezoneLookupMs = 2_000;
    aiStreamMs = 20_000;
    // Each calendar's odd lists (each read's first attempt) fail, its even ones (the quick retries) answer.
    behaviours[GALI.googleRefreshToken] = { list: (_id, n) => (n % 2 === 1 ? { after: 4_900, then: rateLimited() } : { after: 7_400, then: 'ok' }) };
    const tapped = clock;
    await runVirtual(() => summary.sendTomorrowSummaryToUser(tg(GALI), MessagingPlatform.TELEGRAM, draftFor(GALI)));
    await settle();
    assertList(folded().filter(l => !l.startsWith('master ')), [
      'token Gali',
      'list Gali ×5 10-23 00:00..10-24 00:00 9500',
      'token Gali',
      'list Gali ×5 10-23 00:00..10-24 00:00 7500',
      'token Gali',
      'list Gali ×5 10-23 12:00..10-26 00:00 9500',
      'token Gali',
      'list Gali ×5 10-23 12:00..10-26 00:00 7500',
      'draft Gali finalized: summary',
      'voice Gali',
    ], 'the run');
    // 2 s of timezone, 4.9 + 1 + 7.4 s for the day and again for the week block, 20 s of AI.
    assertList(sentAt.map(l => l.replace(/@(\d+)$/, (_m, t) => `+${(Number(t) - tapped) / 1000} s`)), ['draft Gali +48.6 s'], 'when it went out');
    assert(prompts.length === 1 && prompts[0].includes('WEEK LOOKAHEAD (events after tomorrow)'), 'the prompt has no week block');
    assert(!log.some(l => l.startsWith('admin ')) && reportedBySummary().length === 0, `admin ${show(log.filter(l => l.startsWith('admin ')))}, reported ${show(reportedBySummary())}`);
  });

  await check("(d) on demand, a quick retry answered after 7.9 s, past its 7.5 s request timeout: too late, so R13's text, with no admin notice", async () => {
    reset();
    behaviours[GALI.googleRefreshToken] = { list: (_id, n) => (n % 2 === 1 ? { after: 4_900, then: rateLimited() } : { after: 7_900, then: 'ok' }) };
    await runVirtual(() => summary.sendDailySummaryToUser(tg(GALI)));
    assertList(folded(), [
      'token Gali',
      'list Gali ×5 10-22 00:00..10-23 00:00 9500',
      'token Gali',
      'list Gali ×5 10-22 00:00..10-23 00:00 7500',
      'send Gali unreachable',
    ], 'the run');
    assert(!log.some(l => l.startsWith('admin ')) && prompts.length === 0, `admin ${show(log.filter(l => l.startsWith('admin ')))}, prompts ${prompts.length}`);
  });

  await check('(d) one calendar gone (404): a summary from the rest, and the reader\'s gone warning', async () => {
    reset();
    await summary.sendDailySummaryToUser(tg(YONI));
    await settle();
    assertList(folded(), ['token Yoni', 'list Yoni ×2 10-22 00:00..10-23 00:00 9500', 'send Yoni summary', 'voice Yoni'], 'the run');
    assert(prompts.length === 1 && prompts[0].includes('Soccer - Noa and Itai'), 'the other calendar\'s event is not in the prompt');
    assertList(captured.filter(c => c.includes('gone')), [
      'calendar-read-google warning 1 of 2 chosen Google calendars are gone (deleted, unshared or on another account)',
    ], 'warnings');
  });

  await check('(d) every chosen calendar gone: an empty summary, and a warning', async () => {
    reset();
    await summary.sendDailySummaryToUser(tg(AVI));
    await settle();
    assertList(folded(), ['token Avi', 'list Avi ×2 10-22 00:00..10-23 00:00 9500', 'send Avi summary', 'voice Avi'], 'the run');
    assert(prompts.length === 1 && prompts[0].includes('None'), 'the prompt has no empty list');
    // The reader warns in the background, so the two arrive in either order.
    assertList(captured.filter(c => c.includes('gone')).sort(), [
      'calendar-read-digest warning Every chosen Google calendar is gone (deleted, unshared or on another account); the summary has no Google events',
      'calendar-read-google warning 2 of 2 chosen Google calendars are gone (deleted, unshared or on another account)',
    ], 'warnings');
  });

  // ---- (e) The batch doesn't wait ----

  await check('(e) the batch: 3 Google users fail and a FamCal user doesn\'t; the FamCal summary goes out first, one wait counted from the first failure, then each retry in order', async () => {
    reset();
    tokenStepMs = 1000;
    for (const u of [GALI, MAYA, ELLA]) behaviours[u.googleRefreshToken] = { list: (_id, n) => (n === 1 ? rateLimited() : 'ok') };
    batch = [GALI, DANA, MAYA, ELLA];
    const result = await summary.sendDailySummaryToAll({ filterByHour: true });
    assertList(log.filter(l => /^(token|send|mark|sleep) /.test(l)), [
      'token Gali',
      'send Dana summary',
      'mark Dana daily 2026-10-22',
      'token Maya',
      'token Ella',
      'sleep 28000',
      'token Gali',
      'send Gali summary',
      'mark Gali daily 2026-10-22',
      'token Maya',
      'send Maya summary',
      'mark Maya daily 2026-10-22',
      'token Ella',
      'send Ella summary',
      'mark Ella daily 2026-10-22',
    ], 'the run');
    assert(result.processed === 4, `processed ${result.processed}`);
  });

  await check('(e) a Google stall (the token server never answers), scheduled: each first read ends at its 30 s deadline and is set aside, the FamCal user behind them is delivered at 90 s, each retry ends at its 15 s deadline, then the outage summaries; 135 s in all, logged, and no admin notice', async () => {
    reset();
    for (const u of [GALI, MAYA, ELLA]) behaviours[u.googleRefreshToken] = { token: () => 'hang' };
    batch = [GALI, MAYA, ELLA, DANA];
    const started = clock;
    const result = await runVirtual(() => summary.sendDailySummaryToAll({ filterByHour: true }));
    await settle();
    // The loop ends 60 s after the first failure, so the retries start at once: no sleep.
    assertList(log.filter(l => /^(token|list|send|mark|sleep|admin) /.test(l)), [
      'token Gali',
      'token Maya',
      'token Ella',
      'send Dana summary',
      'mark Dana daily 2026-10-22',
      'token Gali',
      'send Gali summary with outage line',
      'mark Gali daily 2026-10-22',
      'token Maya',
      'send Maya summary with outage line',
      'mark Maya daily 2026-10-22',
      'token Ella',
      'send Ella summary with outage line',
      'mark Ella daily 2026-10-22',
    ], 'the run');
    assertList(sentAt.map(l => l.replace(/@(\d+)$/, (_m, t) => `+${(Number(t) - started) / 1000} s`)), [
      'send Dana +90 s', 'send Gali +105 s', 'send Maya +120 s', 'send Ella +135 s',
    ], 'when each went out');
    const deadlines = captured.filter(c => c.includes('deadline'));
    assertList(deadlines, [
      ...Array(3).fill('calendar-read-google warning Google read passed its 30000 ms deadline in the token step'),
      ...Array(3).fill('calendar-read-google warning Google read passed its 15000 ms deadline in the token step'),
    ], "the reader's timeouts");
    assertList(reportedBySummary(), [
      'summary-google-retry warning 3 scheduled summaries set aside for a Google retry',
      ...Array(3).fill('summary-google-outage warning GOOGLE_FETCH_FAILED'),
    ], 'what summary.ts reported');
    assert(logs.includes('[Batch Summary] daily done: processed=4 set aside=3 total=135000ms'), `the batch's closing line: ${show(logs.filter(l => l.includes(' done: ')))}`);
    assert(result.processed === 4, `processed ${result.processed}`);
  });

  // ---- (f) Nothing left over ----

  await check('nothing left over: no network, no unhandled rejection, no admin error notice, and no summary read touched the Google cache', async () => {
    await settle();
    assert(networkAttempts.length === 0, `network: ${networkAttempts.join(', ')}`);
    assert(unhandled.length === 0, `unhandled: ${unhandled.map(String).join(' | ')}`);
    assert(adminErrors.length === 0, `admin errors: ${adminErrors.join(', ')}`);
    const cacheKeys = [...redisKeys].filter(k => /^gcal:(range|stamp|fresh)/.test(k));
    assert(cacheKeys.length === 0, `Google cache keys: ${cacheKeys.join(', ')}`);
  });

  Object.assign(console, original);
  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  // The pipeline's 50 s operation timer is never cleared; don't wait for it.
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Hold Plan B's map smoke to the new blocks, in `scripts/smoke-google-map.ts` (lines 379-380 and 491-492)**

Two edits. Line numbers are those of the file at 716a4f8.

Edit 2a, the "NotesAgenda" assertion and a new check after its own (lines 379-380). Before:

```ts
    assertEq(htmlToText('<html-blob><u>Notes</u><o:p></o:p></html-blob><H1>Agenda</H1>'), 'NotesAgenda', 'Google\'s and Outlook\'s own tags still go');
  });
```

After:

```ts
    assertEq(htmlToText('<html-blob><u>Notes</u><o:p></o:p></html-blob><H1>Agenda</H1>'), 'Notes\nAgenda', 'Google\'s and Outlook\'s own tags still go, and a heading starts its line');
  });

  await check('htmlToText: blocks (headings, paragraphs, tables, lists, quotes, pre, hr) start and end a line, a table cell is set apart, and a block next to a line break adds no second one', () => {
    assertEq(htmlToText('<h1>Agenda</h1><p>Budget</p>'), 'Agenda\nBudget', 'a heading');
    assertEq(htmlToText('<table><tr><td>Agenda</td><td>Budget</td></tr><tr><th>Q1</th><th>Q2</th></tr></table><h2>Join</h2><p>Room 4</p>'), 'Agenda Budget\nQ1 Q2\nJoin\nRoom 4', 'an Outlook table, a heading, a paragraph');
    assertEq(htmlToText('Agenda:<ul><li>Budget<li>Hiring</ul>Bring laptops'), 'Agenda:\n• Budget\n• Hiring\nBring laptops', 'a list whose items are not closed');
    assertEq(htmlToText('<ul><li><p>First</p></li><li><p>Second</p></li></ul>'), '• First\n\n• Second', 'a bullet keeps its paragraph');
    assertEq(htmlToText('One<hr>Two<blockquote>Quoted</blockquote>Three<pre>line 1\nline 2</pre>after'), 'One\nTwo\nQuoted\nThree\nline 1\nline 2\nafter', 'a rule, a quote, pre');
    assertEq(htmlToText('Hi<p>There</p>Intro<div>Body</div>'), 'Hi\nThere\nIntro\nBody', 'paragraphs and divs where they open');
    assertEq(htmlToText('<p>Agenda:</p><ul><li>Budget</li></ul><p>Next</p>'), 'Agenda:\n• Budget\nNext', 'a block next to </p> adds no second line break');
  });
```

Edit 2b, in the same file, `scripts/smoke-google-map.ts`: three block shapes at the end of the check "mapGoogleEvent: each crafted 32,768-character description (opens with no end after them) maps in well under 50 ms" (lines 491-492; 501-502 after Edit 2a), so the block, cell and paragraph passes are held to the same 50 ms. Before:

```ts
      '<b>, then spaces': '<b>' + ' '.repeat(size - 4) + '.',
    };
```

After:

```ts
      '<b>, then spaces': '<b>' + ' '.repeat(size - 4) + '.',
      '"<h1 " repeated': fill('<h1 '),
      '"<td " repeated': fill('<td '),
      '"<p " repeated': fill('<p '),
    };
```

Each Before block appears once in the file at 716a4f8.

- [ ] **Step 3: Run both and see them fail; record the regression smokes' baseline**

```bash
cd /Users/razielgershoni/development/famcalbot
for tz in UTC Asia/Jerusalem Pacific/Kiritimati; do TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-digest-reader-parity.ts 2>&1 | grep -E '^FAIL|passed \('; echo "smoke-digest-reader-parity $tz exit=${pipestatus[1]}"; done
TZ=UTC DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-google-map.ts 2>&1 | grep -E '^FAIL|passed \('; echo "smoke-google-map exit=${pipestatus[1]}"
for f in smoke-calendar-read-google smoke-calendar-read-google-cache smoke-calendar-dto smoke-calendar-range smoke-week-lookahead smoke-voice-dates; do for tz in UTC Asia/Jerusalem; do TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/$f.ts 2>&1 | grep -aE '^(OK|FAIL|SKIP)|passed' > /tmp/c6-$f-${tz//\//_}.before; echo "$f $tz exit=${pipestatus[1]} | $(tail -1 /tmp/c6-$f-${tz//\//_}.before)"; done; done
```

Expected for the parity smoke under `TZ=UTC`, after about 15 s:
```
FAIL  (b) an Outlook/Teams HTML description (a table row, a heading, a paragraph) keeps its words apart: on separate lines in the reader's event, as separate words in the switch-on prompt — the reader's description "AgendaBudgetJoinRoom 4"
27/28 passed (process TZ=UTC)
smoke-digest-reader-parity UTC exit=1
```
Then the same with `(process TZ=Asia/Jerusalem)` and `(process TZ=Pacific/Kiritimati)`.

Expected for the map smoke:
```
FAIL  htmlToText: <…> around a link, an address or a word is text, not a tag (Teams, Outlook and Zoom invites) — Google's and Outlook's own tags still go, and a heading starts its line
FAIL  htmlToText: blocks (headings, paragraphs, tables, lists, quotes, pre, hr) start and end a line, a table cell is set apart, and a block next to a line break adds no second one — a heading
43/45 passed (process TZ=UTC)
smoke-google-map exit=1
```

Why: today's `htmlToText` strips the table, the cells and the heading without a break, so the Outlook description reads "AgendaBudgetJoinRoom 4", and "Notes" and "Agenda" run together. Everything else passes: the other 27 parity checks hold C1–C5 as they are, and the timing check passes with Edit 2b's shapes already, because 716a4f8's passes are linear.

Expected for the regression smokes: every run `exit=0`, with last lines `34/34`, `42/42`, `23/23`, `24/24`, `42/42` and `77/77 passed`. The `/tmp/c6-*.before` files are the baseline for Step 6.

- [ ] **Step 4: Blocks start and end a line, in `src/utils/html.ts`**

Two edits. Both Before blocks appear once in the file at 716a4f8.

Edit 4a, the whole of `htmlToPlain` (lines 177-184); the After adds `breakBlocks` and `BLOCK_TAG` above it. Before:

```ts
function htmlToPlain(html: string): string {
  const linked = replaceLinks(dropBlocks(dropComments(html.replace(/\r\n?/g, '\n'))));
  const lined = replaceTag(linked, /<br(?=[\s/>])[^>]*>/gi, '\n').replace(/<\/(?:p|div|li)\s*>/gi, '\n');
  const text = replaceTag(replaceTag(lined, /<li(?=[\s/>])[^>]*>/gi, '• '), ANY_TAG, '');
  return trimLines(decodeEntities(text).replace(/\u00a0/g, ' '))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
```

After:

```ts
/**
 * A run of spaces, tabs, line breaks and block marks (\u0001) as htmlToPlain leaves it: a
 * run with a block mark becomes as many line breaks as it held, and at least one, so the
 * words on either side of a mark never run together and a block adds a line break only
 * where the run has none. A run without a mark stays. Entities are decoded later, so an
 * encoded break (&#10;) is text here.
 */
function breakBlocks(run: string): string {
  return run.includes('\u0001') ? '\n'.repeat(Math.max(1, run.split('\n').length - 1)) : run;
}

/**
 * Outlook's, Teams' and pasted web text's blocks, which start and end a line: headings,
 * paragraphs and divs where they open, tables and their rows, lists, quotes, <pre>, <hr>.
 */
const BLOCK_TAG = /<\/?(?:h[1-6]|table|tr|ul|ol|blockquote|pre)(?=[\s/>])[^>]*>|<(?:p|div|hr)(?=[\s/>])[^>]*>/gi;

function htmlToPlain(html: string): string {
  const linked = replaceLinks(dropBlocks(dropComments(html.replace(/[\u0001\u0002]/g, '').replace(/\r\n?/g, '\n'))));
  const lined = replaceTag(linked, /<br(?=[\s/>])[^>]*>/gi, '\n').replace(/<\/(?:p|div|li)\s*>/gi, '\n');
  // A list item starts a line (\u0001, a block mark) with its bullet (\u0002, written below).
  const listed = replaceTag(lined, /<li(?=[\s/>])[^>]*>/gi, '\u0001\u0002');
  // A block starts and ends a line; a table cell is set apart by a space.
  const celled = replaceTag(replaceTag(listed, BLOCK_TAG, '\u0001'), /<t[dh](?=[\s/>])[^>]*>/gi, ' ');
  const text = replaceTag(celled, ANY_TAG, '')
    // A bullet keeps its item on its line, past the item's own <p> or spaces.
    .replace(/\u0002[ \t\u0001]*/g, '\u0002')
    .replace(/[ \t\n\u0001]+/g, breakBlocks)
    .replace(/\u0002/g, '• ');
  return trimLines(decodeEntities(text).replace(/\u00a0/g, ' '))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
```

The `return` (entities, `trimLines`, blank lines, the ends) is the one 716a4f8 has.

Edit 4b, `htmlToText`'s comment (line 190). Before:

```ts
 * - <br>, </p>, </li> and </div> become a newline, <li> becomes "• ";
```

After:

```ts
 * - <br>, </p>, </li> and </div> become a newline, <li> starts a line with "• ";
 * - headings, paragraphs, divs, tables and their rows, lists, quotes, <pre> and <hr>
 *   start and end a line, adding a line break only where the text has none yet (a
 *   newline, or a tag above), and a table cell is set apart by a space, so an Outlook or
 *   Teams invite's blocks don't run two words together. Not inside a link, whose text is
 *   flattened first; and an encoded break (&#10;) is decoded after, so a block next to
 *   one adds a blank line;
```

- [ ] **Step 5: Say so in the spec, `docs/superpowers/specs/2026-10-16-calendar-home-design.md` (§2.5 item 8)**

Edit 5a. Before:

```md
   - `<br>`, `</p>`, `</li>` and `</div>` become a newline; `<li>` becomes "• ";
```

After:

```md
   - `<br>`, `</p>`, `</li>` and `</div>` become a newline; `<li>` starts a line with "• ";
   - headings (`h1`–`h6`), tables and their rows (`table`, `tr`), lists (`ul`, `ol`), `blockquote` and `pre` start and end a line, and so do `p`, `div` and `hr` where they open, with a line break added only where the text has none yet (a newline, or a tag above); a table cell (`td`, `th`) is set apart by a space. So an Outlook or Teams invite's blocks don't run words together: `<h1>Agenda</h1><p>Budget</p>` is "Agenda" and "Budget" on two lines, and a row of cells reads "Agenda Budget". Two limits: blocks inside a link still run together, because the link's text is flattened first (`<a href=u><h1>Join</h1><p>Room 4</p></a>` is "JoinRoom 4 (u)"), and an encoded line break (`&#10;`) is decoded afterwards, so a block next to one adds a blank line;
```

- [ ] **Step 6: Run the smokes under each clock, and the regression smokes again**

```bash
cd /Users/razielgershoni/development/famcalbot
for tz in UTC Asia/Jerusalem Pacific/Kiritimati; do TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-digest-reader-parity.ts 2>&1 | grep -E '^(OK|FAIL)|passed \('; echo "smoke-digest-reader-parity $tz exit=${pipestatus[1]}"; done
for tz in UTC Asia/Jerusalem Pacific/Kiritimati; do TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/smoke-google-map.ts 2>&1 | grep -E '^FAIL|passed \('; echo "smoke-google-map $tz exit=${pipestatus[1]}"; done
for f in smoke-calendar-read-google smoke-calendar-read-google-cache smoke-calendar-dto smoke-calendar-range smoke-week-lookahead smoke-voice-dates; do for tz in UTC Asia/Jerusalem; do TZ=$tz DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake npx tsx scripts/$f.ts 2>&1 | grep -aE '^(OK|FAIL|SKIP)|passed' > /tmp/c6-$f-${tz//\//_}.after; echo "$f $tz exit=${pipestatus[1]}"; cmp -s /tmp/c6-$f-${tz//\//_}.before /tmp/c6-$f-${tz//\//_}.after && echo "  same output as Step 3" || echo "  OUTPUT CHANGED"; done; done
```

Expected under `TZ=UTC`, after about 15 s:
```
OK  (a) same events: the reader's day, shaped, is the provider's for every user, zone (Israel, New York), clock and today/tomorrow (FamCal strictly)
OK  (a) the normalization had work to do: the old Google read listed C1/C2 items, an HTML description and reminders the reader leaves out
OK  (a) the fixtures reach the shaping: overnight, sleepover, multi-day all-day, zero-length at 00:00 and 23:59, the 25-hour day, partner reminders
OK  (a) a Google user still paired with a FamCal partner gets no FamCal item, and his reads make no database query (A-2, R3)
OK  (b) same prompts: the paired FamCal user with reminders, daily and tomorrow (with its week block), byte-identical with the switch on
OK  (b) same prompts: the Google user with yours/spouse/kids/birthday calendars, daily and tomorrow (with its week block), byte-identical with the switch on
OK  (b) the prompts show what they compare: reminders and their guideline, carry-overs, the spouse, kids, a birthday, the week block
OK  (b) an Outlook/Teams HTML description (a table row, a heading, a paragraph) keeps its words apart: on separate lines in the reader's event, as separate words in the switch-on prompt
OK  (c) /week and /nextweek with weekStartFor on legacyWeekStart: the same events with the switch on (FamCal paired, FamCal solo, Google, Google still paired; Thursday, Saturday, Sunday)
OK  (c) with the real rule, from Saturday and Sunday: New York and Israel (default culture) Sun-Sat, London Mon-Sun, Cairo Sat-Fri; with the switch off, all Mon-Sun
OK  (d) a dead token (invalid_grant): on demand the token text, scheduled the token text with the refresh button, an admin warning, no dedup mark; as with the switch off
OK  (d) missing scopes: on demand the scopes text, the token cleared by Telegram id and an admin warning; scheduled Sentry only; as with the switch off
OK  (d) rate limit on every calendar, scheduled: set aside, one retry on the first attempt's day with 15,000 ms, then the summary with the outage line, its guideline and the dedup mark, and no week-block Google read
OK  (d) scheduled reads carry their deadline to the week block: 30,000 ms on the first attempt, 15,000 ms on the retry, with no quick retry
OK  (d) rate limit on every calendar, on demand: one quick retry at 8,000 ms inside the operation, then R13's text, no admin notice
OK  (d) rate limit on every calendar, /week: the same quick retry, then R13's text, no admin notice
OK  (d) a fast 500 on demand that the quick retry gets past: the summary, delivered by onSuccess
OK  (d) a hanging token server on demand: a timeout gets no quick retry, and R13's text replaces the draft within 50 s, with no admin notice
OK  (d) scheduled, a retry that gets invalid_grant: the token text with the refresh button and an admin warning, no outage line, no dedup mark
OK  (d) scheduled, a retry that crosses local midnight reads and shapes the first attempt's day
OK  (d) the week block alone fails (a rate limit after a good day read), scheduled: the tomorrow summary goes out without the block and without the outage line, marked sent, with no retry; Sentry has the block's warning (A-28)
OK  (d) on demand, the tomorrow summary with its week block, each read rate-limited after 4.9 s and answered on the quick retry after 7.4 s, a 2 s timezone lookup and a 20 s AI stream: onSuccess delivers it at 48.6 s, inside the 50 s limit, with no admin notice
OK  (d) on demand, a quick retry answered after 7.9 s, past its 7.5 s request timeout: too late, so R13's text, with no admin notice
OK  (d) one calendar gone (404): a summary from the rest, and the reader's gone warning
OK  (d) every chosen calendar gone: an empty summary, and a warning
OK  (e) the batch: 3 Google users fail and a FamCal user doesn't; the FamCal summary goes out first, one wait counted from the first failure, then each retry in order
OK  (e) a Google stall (the token server never answers), scheduled: each first read ends at its 30 s deadline and is set aside, the FamCal user behind them is delivered at 90 s, each retry ends at its 15 s deadline, then the outage summaries; 135 s in all, logged, and no admin notice
OK  nothing left over: no network, no unhandled rejection, no admin error notice, and no summary read touched the Google cache
28/28 passed (process TZ=UTC)
smoke-digest-reader-parity UTC exit=0
```
Then the same 28 lines with `(process TZ=Asia/Jerusalem)` and `(process TZ=Pacific/Kiritimati)`, each `exit=0`. Every fixture's time zone is explicit, so the server's clock changes nothing. On Node 26 a tsx `DEP0205` deprecation line may come first; it is tsx's own, and the `grep` drops it.

The map smoke prints `45/45 passed` and `exit=0` under each clock. Every regression run prints `exit=0` and `same output as Step 3`.

If only the hanging-token check fails with "R13's text after … s", the machine was too slow or too fast for the reader's real 10 s deadline. Run it again before changing anything. If a `(a)` check fails, its message names the user, day, clock and zone and prints both reads. Don't add a normalization to make it pass: spec §10 allows only the three it lists. The virtual-time checks don't depend on the machine's speed.

- [ ] **Step 7: Type-check and lint**

```bash
cd /Users/razielgershoni/development/famcalbot
npx tsc --noEmit -p . && npm run -s lint; echo "exit $?"
```

Expected: no output from either, then `exit 0`. `next build` type-checks `scripts/**`, so the smoke is covered.

- [ ] **Step 8: Commit**

```bash
cd /Users/razielgershoni/development/famcalbot
git add scripts/smoke-digest-reader-parity.ts src/utils/html.ts scripts/smoke-google-map.ts docs/superpowers/specs/2026-10-16-calendar-home-design.md
git commit -m "$(cat <<'EOF'
test(summary): the parity smoke for summaries on the calendar reader

smoke-digest-reader-parity runs every summary flow twice, with the rollout
switch off (the providers) and on (the shared reader), over one fake Google
and one in-memory database. The reader's day, shaped, equals the
provider's for every user, timezone and clock (FamCal strictly; Google
only after the deliberate C1-C3 changes); the daily and tomorrow prompts
are byte-identical; /week and /nextweek list the same events on today's
week start, and start by country on the real rule. It also checks how each
Google failure ends: a dead token, missing scopes, a rate limit (scheduled,
on demand, /week), a fast 500 the quick retry gets past, a hanging token
server (R13's text within 50 s), a retry that hits invalid_grant or crosses
midnight, a week block that fails alone, one or every calendar gone. A
scheduled batch delivers its FamCal user before it waits for the Google
retries, also during a stall; an on-demand tomorrow summary whose reads
both need their quick retry still lands inside the 50 s limit. Those two,
and a quick retry answered too late, run on virtual time.

htmlToText now ends a line at headings, tables and their rows, lists,
quotes, pre, hr, and where a paragraph or div opens, and sets table cells
apart, adding a line break only where the text has none, so an Outlook or
Teams invite's blocks no longer run words together ("AgendaBudget"),
outside links. The new <li>, block and cell passes read only the text
through the last ">", as the other tag passes do, and the rest are single
passes, so it stays linear:
smoke-google-map times three more 32,768-character shapes (<h1, <td, <p
opens with no end). The spec says so.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
EOF
)"
```
Stage only these four paths.

- [ ] **Step 9: The PR's section on what changes, for whom**

Plan C's PR (or the calendar home PR, if C ships with D) carries this section, as spec §3.3 asks ("each listed in the PR"). Paste it into the PR description:

```
## Summaries on the shared reader (Plan C)

Everything here sits behind the calendar home switch (AdminSettings.calendarHomeRollout), which
ships OFF. It covers admins under ADMINS and everyone under ALL.

### What changes for users the switch covers (spec §3.3)

Their daily and tomorrow summaries, the tomorrow summary's week block, /week and /nextweek read
through the shared reader:

| | Daily | Tomorrow (and its week block) | /week, /nextweek |
|---|---|---|---|
| C1 Working-location, out-of-office and focus-time blocks are left out | yes | yes | yes |
| C2 Invites the calendar's owner declined are left out | yes | yes | yes |
| C3 Descriptions reach the prompt as plain text; Outlook and Teams blocks keep their words apart, outside links | yes | yes | no descriptions in weekly prompts |
| C4 A rate limit, quota error, token-server network failure or unauthorized_client no longer says "token expired" or pages the admin per user; a rejected OAuth client pages the admin once an hour | yes | yes | yes |
| C5 Scheduled: one retry about 30 s later, then the summary with an outage line. On demand: one quick retry, then "Couldn't reach Google Calendar. Please try again in a minute.", with no admin page (R13) | yes | yes; a week block that fails alone is left out, as before (A-28) | on demand, R13 |
| C6 Weekly Google reads run in parallel, report failures to Sentry, and answer a dead token, missing permissions and an outage like the daily (R14) | | the week block | yes |
| C7 Weeks start by country: Sunday in the US and Israel, Saturday in Egypt, Monday in the UK; Jewish culture stays on Sunday; with no location and no Google token, by language | | the week block | yes |
| C8 Items past Google's first 250 per calendar are no longer cut off | yes | yes | yes |

Two new bot texts, natural in en, he and ru:
- bot.errors.googleUnreachable (R13): the on-demand answer when Google can't be reached, for the
  daily, tomorrow, /week and /nextweek, in place of the open draft when there is one.
- bot.errors.googleOutageNote: the line under a scheduled summary that went out without Google, in
  the text and the voice note. That run's prompt also gets one guideline line (C5).

### What doesn't change for users the switch doesn't cover (A-33)

Their summaries are today's, byte for byte: the same reads through the providers, the same prompts
(held to main@858886c by smoke-summary-prompt-parity), texts, voice notes, admin notices and dedup
marks. What they may notice is timing only: in a scheduled batch they now go out before the users
the switch covers, and the daily run's reminder-cache sync no longer waits for the batch. The §8
fixes (Plan A) and the write-path stamp (Plan B) are as before.

### Operations

- Sentry: one summary-google-retry warning per batch that sets users aside (a count), one
  summary-google-outage warning per outage summary; the reader's own calendar-read-google warnings.
  A batch logs one "[Batch Summary] … done:" line with its total time.
- A deploy during a batch's 30 s wait still drops the set-aside users for that hour; the warning
  counts them.
- The reader cancels what it leaves when it answers (a stuck token server's request, lists past
  the deadline); no request timeout is under 1 s.
- When neither Redis nor the DB answers, the switch reads OFF for 5 s with one warning, instead
  of retrying both for every user.
- The retry's dedup marks carry the batch's date, so a 23:00 summary retried past midnight
  doesn't skip the next evening's.

### Known and left for later

- An on-demand tomorrow summary whose day read and week block both need their quick retry, with a
  slow timezone lookup and a 20 s AI stream, lands at about 48.6 s of executeCommand's 50 s.
- A week block that fails alone (the day read answered) is left out without a line saying why.
- /week and /nextweek send the token and permission texts with sendMessage even when a draft is
  open, as the daily does; the "Looking ahead…" placeholder stays above them.
- A description's blocks inside a link still run together (<a href=…><h1>Join</h1><p>Room 4</p></a>
  reads "JoinRoom 4 (…)"), and a block next to an encoded line break (&#10;) adds a blank line.
```

- [ ] **Step 10: After merge, when the switch goes to `ADMINS`: the live check (spec §10)**

Not part of this task's commit. Run it the day an admin moves the switch from `OFF` to `ADMINS` (after Plans C and D land), with the owner's own account:

1. **Before the move**, with the switch `OFF`: ask the bot for today's summary and tomorrow's (`summary`, `summary tmrw`) and `/week`. Keep the texts. These are the old path's.
2. **Move the switch to `ADMINS`** in the admin panel. It reaches every process within about a minute.
3. **Ask for the same three again**, the same day, and compare with step 1. The wording comes from the AI and differs; compare what it says:
   - every event and reminder of the day is there, with the same times, "next day", "until … (started …)" and all-day marks;
   - the sections are the same: the owner's own, the spouse's, the kids' and the other calendars, decided by the `[Calendar: …]` names. A name that moved section means `calendarName` changed (A-6);
   - birthdays are labelled; open reminders and carry-overs ("and N more") are the same;
   - only the deliberate changes differ: working-location, out-of-office and focus-time blocks and declined invites are gone (C1, C2), descriptions read as text (C3), and `/week`'s days follow the owner's week start (C7: Sunday for Jewish culture or an Israeli zone).
4. **The next scheduled daily and tomorrow summaries** arrive at the owner's hours, once each (the dedup mark), with nothing new in Sentry under `calendar-read-*`, `summary-*` or `calendar-home-rollout`.
5. **Anything else differs:** move the switch back to `OFF` (it takes effect within a minute) and write down the event, its calendar and both texts.

---

### Task 7: Verification and landing (run by the controller, not a subagent)

**Files:** none changed, unless a check fails.

- [ ] **Step 1: Run every smoke under both clocks, and the day-bucketing smokes under Kiritimati**

```bash
cd /Users/razielgershoni/development/famcalbot
E="DATABASE_URL='postgresql://fake:fake@127.0.0.1:1/fake' DIRECT_URL='postgresql://fake:fake@127.0.0.1:1/fake' TELEGRAM_BOT_TOKEN='000000:fake' WHATSAPP_ACCESS_TOKEN=fake WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake GOOGLE_REFRESH_TOKEN=fake ANTHROPIC_API_KEY=fake CRON_SECRET=fake ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 NODE_ENV=development GOOGLE_TTS_CREDENTIALS='{}' TELEGRAM_WEBHOOK_SECRET=fake GEMINI_API_KEY=fake"
OUT=/private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/landing-C; mkdir -p $OUT
run() { eval "env TZ=$2 $E perl -e 'alarm shift; exec @ARGV' 300 npx tsx $1" > "$OUT/$(basename $1 .ts).$(echo $2 | tr / _).out" 2>&1; echo "$(basename $1) $2 exit=$? $(tail -1 "$OUT/$(basename $1 .ts).$(echo $2 | tr / _).out")"; }
for s in scripts/smoke-*.ts; do for tz in UTC Asia/Jerusalem; do run $s $tz; done; done
for s in locale-rules calendar-dto calendar-read-google calendar-range digest-adapters calendar-read-google-cancel summary-prompt-parity summary-seam calendar-home-rollout summary-retry week-lookahead week-commands digest-reader-parity google-map; do run scripts/smoke-$s.ts Pacific/Kiritimati; done
eval "env $E npx tsx scripts/check-i18n-parity.ts"; echo "parity exit $?"
```

Expected: every line `exit=0` (58 smokes under each clock, 14 under Kiritimati) and parity OK at 887 keys. The new and changed counts are digest-adapters 23, calendar-read-google-cancel 5, summary-prompt-parity 9, summary-seam 23, calendar-home-rollout 35, summary-retry 20, week-lookahead 42, week-commands 7, digest-reader-parity 28 and google-map 45; native-provider-reminders 11 and reminders 23 are unchanged. A non-zero exit is a failure to fix before landing. macOS has no `timeout`; the `perl` alarm stands in for it.

- [ ] **Step 2: Type-check and lint the branch**

Run: `npx tsc --noEmit -p . && npm run -s lint; echo "exit $?"`
Expected: `exit 0`, no output before it.

- [ ] **Step 3: Build a fresh clone on Node 22, and run the summary smokes there**

```bash
F=/private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/fresh-C
rm -rf $F && git clone -q --branch feat/calendar-home /Users/razielgershoni/development/famcalbot $F && cd $F
# E is the env prefix from Step 1.
npx -y node@22 "$(command -v npm)" ci --no-audit --no-fund > ../fresh-C-ci.log 2>&1; echo "ci exit $?"
npx -y node@22 node_modules/.bin/prisma generate > ../fresh-C-gen.log 2>&1; echo "generate exit $?"
npx -y node@22 node_modules/.bin/next build > ../fresh-C-build.log 2>&1; echo "build exit $?"; tail -5 ../fresh-C-build.log; grep -c "api/calendar/range" ../fresh-C-build.log
for s in digest-adapters calendar-read-google-cancel summary-prompt-parity summary-seam summary-retry week-lookahead week-commands digest-reader-parity google-map calendar-home-rollout native-provider-reminders reminders; do eval "env TZ=Asia/Jerusalem $E npx -y node@22 node_modules/.bin/tsx scripts/smoke-$s.ts" > ../fresh-C-$s.out 2>&1; echo "$s node22 exit=$? $(tail -1 ../fresh-C-$s.out)"; done
```

Expected: three `exit 0` lines, a finished build, a non-zero count of `api/calendar/range` in the route table, and every Node 22 smoke `exit=0`. `smoke-summary-prompt-parity` compares prompts byte for byte with a fixture captured on Node 26; if it fails on Node 22 only, compare the differing lines: a date-format difference in ICU is a fixture problem to report, any other difference is a failure. `next build` here runs no migration: the clone has no `.env`, and `next build` is called directly rather than `npm run build`.

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

- [ ] **Step 5: Confirm the deploy**

Poll `gh api repos/raziel-gershoni/famcalbot/commits/<sha>/status --jq '.statuses[] | "\(.context) \(.state)"'` every few minutes, not in a tight loop. Wait until the context `famcalbot - famcalbot` (Railway) and the Vercel context both read `success`. Plan C has no migration. On `failure`, read the build log, fix on the branch and land again.

- [ ] **Step 6: Report to the owner**

Send a short ping that says what is live and what isn't:
- the switch is still `OFF`, so no summary changes for anyone yet. For users it covers once it is on, the summaries, the week block, `/week` and `/nextweek` read through the shared reader, with R13's text and the scheduled retry and outage line;
- the points of Task 6 Step 9's PR section that matter to the owner (what changes for covered users, what doesn't for others, operations, open items such as Ruling 3, 5 and 10);
- that `htmlToText` now breaks lines at blocks (Ruling 1) and runs in linear time (716a4f8, Plan B's follow-up), dormant while the switch is `OFF`;
- with Plan D also on `main`, the owner can set the switch to `ADMINS`. Task 6 Step 10's live check runs on the owner's next summaries after that.

Production stays read-only.
